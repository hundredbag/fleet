import { randomBytes } from 'node:crypto';
import type { AgentAdapter } from '../core/adapter.js';
import type { McpServerSpec } from '../core/types.js';
import { buildInventory } from '../core/inventory.js';
import { planInstall, planSync, planRemove, execute, resolveTargets, type Plan } from '../core/orchestrator.js';
import { rollback } from '../core/writer.js';
import { summarizeResult, redactUrl } from '../core/redact.js';

/**
 * The dashboard's mutation service: a server-enforced preview→confirm two-step.
 * `plan()` builds + stores a dry-run plan and returns a planId + a human-readable
 * `runs` (the actual command that will be configured); `apply()` only runs a plan
 * produced by a prior `plan()` (single-use planId). All results go through
 * `summarizeResult`. Package coordinates from the (remote) feed are VALIDATED
 * before they can become a spec — a crafted identifier must not smuggle flags or
 * git/url/file targets into what the agent later executes.
 */

interface Coordinate {
  ecosystem?: string;
  identifier?: string;
  version?: string;
}

// Conservative grammars: reject whitespace, leading '-', ':' (git specs), '/'
// (paths/urls beyond an npm scope), and anything not a plain package name.
const NPM_NAME = /^(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i;
const PYPI_NAME = /^[a-z0-9][a-z0-9._-]*$/i;
const VERSION = /^[a-z0-9][a-z0-9.+-]*$/i;

function validateVersion(v: string | undefined): void {
  if (v !== undefined && v !== '' && !VERSION.test(v)) throw new Error(`refusing unsafe version '${v}'`);
}

function validateCoordinate(c: Coordinate | undefined): asserts c is Coordinate & { identifier: string } {
  if (!c || !c.identifier) throw new Error('install requires a package coordinate');
  const id = c.identifier;
  const ok = c.ecosystem === 'npm' ? NPM_NAME.test(id) : c.ecosystem === 'pypi' ? PYPI_NAME.test(id) : false;
  if (!ok) throw new Error(`refusing unsafe package identifier '${id}' (ecosystem '${c.ecosystem ?? '?'}')`);
  validateVersion(c.version);
}

function specFromCoordinate(c: Coordinate | undefined): McpServerSpec {
  validateCoordinate(c);
  const pkg = c.version ? `${c.identifier}@${c.version}` : c.identifier;
  if (c.ecosystem === 'npm') return { transport: 'stdio', command: 'npx', args: ['-y', pkg] };
  return { transport: 'stdio', command: 'uvx', args: [pkg] };
}

/** Bump the version of an installed stdio server WITHOUT dropping its env/args/command. */
function bumpVersion(spec: McpServerSpec, version: string): McpServerSpec {
  if (spec.transport !== 'stdio') {
    throw new Error('only stdio (npx/uvx) servers can be version-updated from the dashboard');
  }
  validateVersion(version);
  const args = [...(spec.args ?? [])];
  const idx = args.findIndex((a) => !a.startsWith('-') && a !== 'run');
  if (idx < 0) throw new Error('could not locate the package argument to update');
  const cur = args[idx]!;
  const at = cur.lastIndexOf('@');
  const base = at > 0 ? cur.slice(0, at) : cur;
  args[idx] = version ? `${base}@${version}` : base;
  return { ...spec, args }; // preserves command, env, other args
}

function describeSpec(spec: McpServerSpec): string {
  return spec.transport === 'stdio'
    ? [spec.command, ...(spec.args ?? [])].join(' ')
    : `${spec.transport} ${redactUrl(spec.url)}`;
}

export interface ActionBody {
  action?: string;
  name?: string;
  to?: unknown;
  from?: unknown;
  coordinate?: Coordinate;
  planId?: string;
}

const MAX_PENDING = 100;

export class ActionService {
  private readonly plans = new Map<string, Plan>();

  constructor(
    private readonly adapters: AgentAdapter[],
    private readonly fleetHome?: string,
  ) {}

  /** Build a plan, store it, and return a redacted dry-run preview + planId + the command that will run. */
  async plan(body: ActionBody) {
    const name = String(body.name ?? '').trim();
    if (!name) throw new Error('name is required');
    let plan: Plan;
    let runs: string | undefined;
    switch (body.action) {
      case 'install': {
        const spec = specFromCoordinate(body.coordinate);
        runs = describeSpec(spec);
        const targets = await resolveTargets(this.adapters, toTargets(body.to));
        plan = await planInstall(this.adapters, spec, name, 'user', targets);
        break;
      }
      case 'update': {
        const agent = toTargets(body.to);
        const existing = (await buildInventory(this.adapters)).items.find(
          (i) => i.kind === 'mcp-server' && i.name === name && i.agent === agent,
        );
        if (!existing || existing.kind !== 'mcp-server') throw new Error(`'${name}' is not an installed MCP server on ${agent}`);
        const spec = bumpVersion(existing.spec, String(body.coordinate?.version ?? ''));
        runs = describeSpec(spec);
        const targets = await resolveTargets(this.adapters, agent);
        plan = await planInstall(this.adapters, spec, name, existing.scope, targets);
        break;
      }
      case 'sync': {
        const targets = await resolveTargets(this.adapters, toTargets(body.to));
        plan = await planSync(this.adapters, name, String(body.from ?? ''), targets);
        break;
      }
      case 'remove': {
        const targets = await resolveTargets(this.adapters, toTargets(body.from));
        plan = await planRemove(this.adapters, name, targets);
        break;
      }
      default:
        throw new Error(`unknown action '${body.action ?? ''}'`);
    }
    if (this.plans.size >= MAX_PENDING) {
      const oldest = this.plans.keys().next().value;
      if (oldest) this.plans.delete(oldest);
    }
    const planId = randomBytes(12).toString('hex');
    this.plans.set(planId, plan);
    const preview = summarizeResult(await execute(this.adapters, plan, { commit: false, fleetHome: this.fleetHome }));
    return { planId, preview, runs };
  }

  /** Apply a previously-planned change (by planId). Consumes the plan. */
  async apply(body: ActionBody) {
    const planId = String(body.planId ?? '');
    const plan = this.plans.get(planId);
    if (!plan) throw new Error('unknown planId — preview again before applying');
    this.plans.delete(planId);
    return summarizeResult(await execute(this.adapters, plan, { commit: true, fleetHome: this.fleetHome }));
  }

  async rollback() {
    return rollback({ fleetHome: this.fleetHome });
  }
}

function toTargets(v: unknown): string {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string').join(',') : String(v ?? '');
}
