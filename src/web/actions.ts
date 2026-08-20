import { randomBytes } from 'node:crypto';
import type { AgentAdapter } from '../core/adapter.js';
import type { McpServerSpec, Scope } from '../core/types.js';
import { buildInventory } from '../core/inventory.js';
import {
  planInstall,
  planSync,
  planRemove,
  planSyncSkill,
  planRemoveSkill,
  planSyncRule,
  planRemoveRule,
  execute,
  resolveTargets,
  type Plan,
} from '../core/orchestrator.js';
import { rollback } from '../core/writer.js';
import { replaceRunnerPackageVersion } from '../core/coords.js';
import { isPublicAgentId, isPublicCapabilityName } from '../core/redact.js';
import {
  DelegatedOutcomeUnknownError,
  planPluginActions,
  runDelegated,
  type DelegatedPlan,
} from '../core/delegate.js';
import { pluginCoordinate } from '../core/plugin-coordinate.js';
import { invalidateInventoryCache } from './api.js';
import { operationAllowed, supportsDelegatedPlugin } from './operations.js';
import {
  isPublicMutationIdentity,
  mapApply,
  mapDelegatedApply,
  mapDelegatedPlan,
  mapPlan,
  mapRollback,
} from './public-mappers.js';
import type { Operation, PublicApplyResponse, PublicPlanResponse, PublicRollbackResponse } from './types.js';
import { assertWritableScope, parseScope, selectScopedCapability } from '../core/scope.js';
import { assertValidWebPackageCoordinate, type WebPackageCoordinate } from './package-coordinate.js';

/**
 * The dashboard's mutation service: a server-enforced preview→confirm two-step.
 * `plan()` validates logical inputs, stores a dry-run plan, and returns only a
 * redacted preview plus a single-use planId. Package coordinates from the
 * (remote) feed are VALIDATED before they can become a spec — a crafted
 * identifier must not smuggle flags or git/url/file targets into what the agent
 * later executes.
 */

function validateVersion(v: string | undefined): void {
  if (v !== undefined && v !== '' && !/^[a-z0-9][a-z0-9.+-]*$/i.test(v)) {
    throw new Error(`refusing unsafe version '${v}'`);
  }
}

function specFromCoordinate(c: WebPackageCoordinate | undefined): McpServerSpec {
  assertValidWebPackageCoordinate(c);
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
  const updated = replaceRunnerPackageVersion(spec, version);
  if (!updated) throw new Error('could not locate a valid package argument to update');
  return updated;
}

export interface ActionBody {
  action?: string;
  /** capability kind — routes sync/remove to the right engine (default mcp-server) */
  kind?: string;
  name?: string;
  to?: unknown;
  from?: unknown;
  /** Exact target/source scope for scoped MCP inventory operations. */
  scope?: unknown;
  fromScope?: unknown;
  coordinate?: WebPackageCoordinate;
  /** for plugin sync: the source marketplace (selector = name@marketplace) */
  marketplace?: string;
  planId?: string;
  auditId?: string;
}

const MAX_PENDING = 100;
const PLAN_TTL_MS = 5 * 60_000;

/** A pending mutation: either a core Plan (execute pipeline) or a delegated
 * vendor-CLI action (plugins). Both flow through the same preview→confirm. */
type Pending =
  | { type: 'core'; plan: Plan; expiresAt: number }
  | { type: 'delegated'; dplan: DelegatedPlan; expiresAt: number };
type PendingInput = { type: 'core'; plan: Plan } | { type: 'delegated'; dplan: DelegatedPlan };

export class ActionService {
  private readonly plans = new Map<string, Pending>();

  constructor(
    private readonly adapters: AgentAdapter[],
    private readonly fleetHome?: string,
    /** injectable vendor-CLI runner — tests avoid spawning the real binary */
    private readonly runner?: import('../core/delegate.js').Runner,
  ) {}

  /** Build and store a plan, returning only its redacted logical preview. */
  async plan(body: ActionBody): Promise<PublicPlanResponse> {
    const name = String(body.name ?? '').trim();
    if (!name) throw new Error('name is required');
    const kind = String(body.kind ?? 'mcp-server');
    // allowlist kinds — an unknown kind must never fall through to a default engine
    if (!['mcp-server', 'skill', 'rule', 'plugin'].includes(kind)) {
      throw new Error(`unknown kind '${kind}'`);
    }

    // plugins live outside the core write engine — a delegated vendor-CLI action
    if (kind === 'plugin') return this.planPlugin(body, name);
    if (!isPublicCapabilityName(name)) throw new Error('refusing non-public capability identity');
    const coreKind = kind as 'mcp-server' | 'skill' | 'rule';

    let plan: Plan;
    switch (body.action) {
      case 'install': {
        if (kind !== 'mcp-server') {
          throw new Error(`${kind} install requires its dedicated local source input`);
        }
        const spec = specFromCoordinate(body.coordinate);
        const targets = await resolveTargets(this.adapters, toTargets(body.to), coreKind);
        await this.assertAllowed(kind, name, 'install', targets, { targetScope: 'user' });
        plan = await planInstall(this.adapters, spec, name, 'user', targets, { fleetHome: this.fleetHome });
        break;
      }
      case 'update': {
        if (kind !== 'mcp-server') throw new Error(`${kind} update is not supported by this endpoint`);
        const agent = toTargets(body.to);
        const requestedScope = parseScope(body.scope);
        const existing = selectScopedCapability((await buildInventory(this.adapters)).items, {
          agent,
          kind: 'mcp-server',
          name,
          ...(requestedScope ? { scope: requestedScope } : {}),
        });
        if (!existing || existing.kind !== 'mcp-server')
          throw new Error(`'${name}' is not an installed MCP server on ${agent}`);
        const spec = bumpVersion(existing.spec, String(body.coordinate?.version ?? ''));
        const targets = await resolveTargets(this.adapters, agent, coreKind);
        await this.assertAllowed(kind, name, 'update', targets, { targetScope: existing.scope });
        plan = await planInstall(this.adapters, spec, name, existing.scope, targets, {
          fleetHome: this.fleetHome,
        });
        break;
      }
      case 'sync': {
        // "install what claude has onto codex too" — kind-routed cross-agent copy
        const targets = await resolveTargets(this.adapters, toTargets(body.to), coreKind);
        const from = String(body.from ?? '');
        if (!isPublicAgentId(from)) throw new Error('refusing non-public source agent identity');
        const sourceScope = parseScope(body.fromScope, 'fromScope');
        await this.assertAllowed(kind, name, 'sync', targets, {
          targetScope: kind === 'mcp-server' ? 'user' : undefined,
          sourceAgent: from,
          sourceScope,
        });
        plan =
          kind === 'skill'
            ? await planSyncSkill(this.adapters, name, from, targets, {
                fleetHome: this.fleetHome,
                sourceScope,
              })
            : kind === 'rule'
              ? await planSyncRule(this.adapters, name, from, targets, { sourceScope })
              : await planSync(this.adapters, name, from, targets, {
                  fleetHome: this.fleetHome,
                  sourceScope,
                });
        break;
      }
      case 'remove': {
        const targetScope = parseScope(body.scope) ?? 'user';
        assertWritableScope(targetScope);
        const targets = await resolveTargets(this.adapters, toTargets(body.from), coreKind);
        await this.assertAllowed(kind, name, 'remove', targets, { targetScope });
        plan =
          kind === 'skill'
            ? await planRemoveSkill(this.adapters, name, targets)
            : kind === 'rule'
              ? await planRemoveRule(this.adapters, name, targets)
              : await planRemove(this.adapters, name, targets, targetScope);
        break;
      }
      default:
        throw new Error(`unknown action '${body.action ?? ''}'`);
    }
    if (!plan.changes.every((change) => isPublicMutationIdentity(change))) {
      throw new Error('refusing a plan with a non-public mutation target');
    }
    const stored = this.store({ type: 'core', plan });
    return mapPlan(
      stored.planId,
      stored.expiresAt,
      plan,
      this.summary(body.action!, kind, plan.changes.length),
    );
  }

  /** Plugin install/remove goes through the delegated vendor CLI. The selector
   * is name@marketplace for a sync-install (default action install). */
  private async planPlugin(body: ActionBody, name: string): Promise<PublicPlanResponse> {
    if (body.action !== 'install' && body.action !== 'remove') {
      throw new Error(`plugin action must be install or remove (got '${body.action ?? ''}')`);
    }
    const op = body.action;
    const agent = op === 'remove' ? toTargets(body.from) : toTargets(body.to);
    if (!agent || agent.includes(',') || agent === 'all') {
      throw new Error('plugin actions target exactly one agent');
    }
    const marketplace = typeof body.marketplace === 'string' ? body.marketplace : undefined;
    const coordinate = pluginCoordinate(name, marketplace);
    await this.assertAllowed('plugin', coordinate.name, op, [agent], {
      marketplace: coordinate.marketplace,
      targetScope: 'user',
    });
    const [dplan] = await planPluginActions(this.adapters, agent, op, coordinate.selector);
    if (!dplan) throw new Error('plugin target is unavailable');
    const resolvedCoordinate = pluginCoordinate(dplan.selector);
    if (
      !isPublicMutationIdentity({
        agent,
        kind: 'plugin',
        name: resolvedCoordinate.name,
        scope: 'user',
        op,
      })
    ) {
      throw new Error('refusing a delegated plan with a non-public mutation target');
    }
    const stored = this.store({ type: 'delegated', dplan });
    return mapDelegatedPlan(
      stored.planId,
      stored.expiresAt,
      {
        agent,
        name: resolvedCoordinate.name,
        marketplace: resolvedCoordinate.marketplace,
        op,
      },
      this.summary(op, 'plugin', 1),
    );
  }

  private store(p: PendingInput): { planId: string; expiresAt: number } {
    if (this.plans.size >= MAX_PENDING) {
      const oldest = this.plans.keys().next().value;
      if (oldest) this.plans.delete(oldest);
    }
    const planId = randomBytes(12).toString('hex');
    const expiresAt = Date.now() + PLAN_TTL_MS;
    this.plans.set(planId, { ...p, expiresAt } as Pending);
    return { planId, expiresAt };
  }

  /** Apply a previously-planned change (by planId). Consumes the plan. */
  async apply(body: ActionBody): Promise<PublicApplyResponse> {
    const planId = String(body.planId ?? '');
    const pending = this.plans.get(planId);
    if (!pending) throw new Error('unknown planId — preview again before applying');
    this.plans.delete(planId);
    if (pending.expiresAt < Date.now()) throw new Error('plan expired — preview again before applying');
    if (pending.type === 'delegated') {
      try {
        const r = await runDelegated(pending.dplan, {
          commit: true,
          fleetHome: this.fleetHome,
          runner: this.runner,
        });
        invalidateInventoryCache();
        const coordinate = pluginCoordinate(pending.dplan.selector);
        return mapDelegatedApply(
          r.status === 'preview' ? 'outcome-unknown' : r.status,
          Boolean(r.lockWarning),
          undefined,
          {
            agent: pending.dplan.agent,
            name: coordinate.name,
            ...(coordinate.marketplace ? { marketplace: coordinate.marketplace } : {}),
            op: pending.dplan.op,
            ...(r.ledgerId ? { delegatedId: r.ledgerId } : {}),
            delegatedRecorded: Boolean(r.ledgerId),
          },
        );
      } catch (error) {
        invalidateInventoryCache();
        const coordinate = pluginCoordinate(pending.dplan.selector);
        return mapDelegatedApply(
          error instanceof DelegatedOutcomeUnknownError ? 'outcome-unknown' : 'failed',
          false,
          error instanceof DelegatedOutcomeUnknownError,
          {
            agent: pending.dplan.agent,
            name: coordinate.name,
            ...(coordinate.marketplace ? { marketplace: coordinate.marketplace } : {}),
            op: pending.dplan.op,
            ...(error instanceof DelegatedOutcomeUnknownError && error.ledgerId
              ? { delegatedId: error.ledgerId }
              : {}),
            delegatedRecorded: false,
          },
        );
      }
    }
    const result = await execute(this.adapters, pending.plan, { commit: true, fleetHome: this.fleetHome });
    invalidateInventoryCache(); // a refresh right after apply must see the new state
    return mapApply(result);
  }

  async rollback(body: ActionBody): Promise<PublicRollbackResponse> {
    const auditId = body.auditId;
    if (
      typeof auditId !== 'string' ||
      auditId.length > 64 ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(auditId)
    ) {
      throw new Error('a valid auditId is required');
    }
    const r = await rollback({ auditId, fleetHome: this.fleetHome });
    invalidateInventoryCache();
    return mapRollback(r);
  }

  private summary(action: string, kind: string, changes: number): string {
    return `${action} ${kind} (${changes} ${changes === 1 ? 'change' : 'changes'})`;
  }

  private async assertAllowed(
    kind: string,
    name: string,
    operation: Operation,
    targets: string[],
    options: {
      targetScope?: Scope;
      sourceAgent?: string;
      sourceScope?: Scope;
      marketplace?: string;
    } = {},
  ): Promise<void> {
    const inventory = await buildInventory(this.adapters);
    const primitive = kind as import('../core/types.js').PrimitiveKind;
    const sourceMatches = inventory.items.filter(
      (item) =>
        item.kind === primitive &&
        item.name === name &&
        (!options.marketplace || (item.kind === 'plugin' && item.marketplace === options.marketplace)) &&
        (!options.sourceAgent || item.agent === options.sourceAgent) &&
        (!options.sourceScope || item.scope === options.sourceScope),
    );
    if (options.sourceAgent && primitive === 'mcp-server') {
      selectScopedCapability(sourceMatches, {
        agent: options.sourceAgent,
        kind: primitive,
        name,
        ...(options.sourceScope ? { scope: options.sourceScope } : {}),
      });
    }
    const hasSourceInstance = sourceMatches.length > 0;
    for (const target of targets) {
      const adapter = this.adapters.find((candidate) => candidate.id === target);
      const agent = inventory.agents.find((candidate) => candidate.id === target);
      const targetMatches = inventory.items.filter(
        (item) =>
          item.kind === primitive &&
          item.name === name &&
          item.agent === target &&
          (!options.marketplace || (item.kind === 'plugin' && item.marketplace === options.marketplace)) &&
          (!options.targetScope || item.scope === options.targetScope),
      );
      const instance =
        primitive === 'mcp-server' || primitive === 'skill' || primitive === 'rule'
          ? selectScopedCapability(targetMatches, {
              agent: target,
              kind: primitive,
              name,
              ...(options.targetScope ? { scope: options.targetScope } : {}),
            })
          : targetMatches[0];
      if (
        !adapter ||
        !agent ||
        !operationAllowed(
          {
            adapter,
            agent,
            kind: primitive,
            hasInstance: Boolean(instance),
            ...(instance ? { scope: instance.scope } : {}),
            hasSourceInstance,
            delegatedSupported: primitive === 'plugin' && supportsDelegatedPlugin(adapter),
          },
          operation,
        )
      ) {
        throw new Error('operation is not supported for the requested target');
      }
    }
  }
}

function toTargets(v: unknown): string {
  return Array.isArray(v) ? v.filter((x) => typeof x === 'string').join(',') : String(v ?? '');
}
