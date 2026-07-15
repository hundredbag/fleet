import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { extractCoordinate } from './coords.js';
import { updateLockFromApplied, type CapabilityOrigin } from './lock.js';
import { gateOrigin, gateSkillSource, type GateVerdict } from './trustgate.js';
import { loadConfig } from './config.js';
import { readFile } from 'node:fs/promises';
import type { AgentAdapter, AgentWriter, RuleWriter, SkillSource, SkillWriter } from './adapter.js';
import type { AgentId, McpServerSpec, RuleCapability, Scope } from './types.js';
import { hashDir } from './fsutil.js';
import { opposingRules, RESOLUTION_HINT } from './conflicts.js';
import {
  applyChanges,
  toPlannedChange,
  type PlannedChange,
  type ApplyResult,
  type ApplyOptions,
  type ChangeValidator,
} from './writer.js';

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export type SkipKind = 'noop' | 'error' | 'protected';

export interface PlanSkip {
  agent: AgentId;
  reason: string;
  kind: SkipKind;
}

/** The result of planning a multi-agent operation (dry-run unit). */
export interface Plan {
  changes: PlannedChange[];
  skips: PlanSkip[];
  /** provenance for the lock file — set by planners that know where the bytes came from */
  origin?: CapabilityOrigin;
  /** install-time trust verdict (recorded in the lock; enforced per trustPolicy) */
  trust?: GateVerdict;
}

type WriterAdapter = AgentAdapter & AgentWriter;

export function isWriter(a: AgentAdapter): a is WriterAdapter {
  const w = a as Partial<AgentWriter>;
  return (
    a.supportsWrite === true &&
    typeof w.renderInstall === 'function' &&
    typeof w.renderRemove === 'function' &&
    typeof w.validate === 'function'
  );
}

export function writerAdapters(adapters: AgentAdapter[]): WriterAdapter[] {
  return adapters.filter(isWriter);
}

/** Names fleet refuses to mutate (its own entry once self-installed in M3). */
export const SELF_PROTECTED = new Set<string>(['fleet', 'fleet-mcp']);

/** Resolve a `--to`/`--from` target string to concrete writer agent ids. */
export async function resolveTargets(adapters: AgentAdapter[], target: string): Promise<AgentId[]> {
  const writers = writerAdapters(adapters);
  if (target === 'all') {
    // 'all' = present writer agents only (don't surprise-create absent ones)
    const present: AgentId[] = [];
    for (const w of writers) {
      if ((await w.detect()).present) present.push(w.id);
    }
    return present;
  }
  const ids = target
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const known = new Set(writers.map((w) => w.id));
  for (const id of ids) {
    if (!known.has(id)) throw new Error(`unknown or non-writable agent: '${id}'`);
  }
  return [...new Set(ids)];
}

/** Apply the trust policy to a finished plan: warn → annotate every change;
 * block → convert changes into 'protected' skips. Never touches ok verdicts. */
function applyTrustPolicy(plan: Plan, verdict: GateVerdict, policy: 'warn' | 'block'): Plan {
  if (verdict.level === 'ok') return { ...plan, trust: verdict };
  if (policy === 'block') {
    const skips = [
      ...plan.skips,
      ...plan.changes.map((c) => ({
        agent: c.agent,
        kind: 'protected' as const,
        reason: `trust policy is 'block': ${verdict.reasons.join('; ')}`,
      })),
    ];
    return { ...plan, changes: [], skips, trust: verdict };
  }
  const changes = plan.changes.map((c) => ({
    ...c,
    warnings: [...(c.warnings ?? []), ...verdict.reasons.map((r) => `trust: ${r}`)],
  }));
  return { ...plan, changes, trust: verdict };
}

async function isNoop(file: string, newContent: string): Promise<boolean> {
  if (!existsSync(file)) return false;
  try {
    return (await readFile(file, 'utf8')) === newContent;
  } catch {
    return false;
  }
}

/** Plan installing one spec into each target agent (per-agent failures skip). */
export async function planInstall(
  adapters: AgentAdapter[],
  spec: McpServerSpec,
  name: string,
  scope: Scope,
  targetIds: AgentId[],
  opts?: { trustPolicy?: 'warn' | 'block'; fleetHome?: string },
): Promise<Plan> {
  const coord = extractCoordinate(spec);
  // registry-grammar check before PERSISTING as provenance — extractCoordinate
  // is match-oriented and would happily classify a credentialed URL as an id
  const NPM_ID = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
  const PYPI_ID = /^[A-Za-z0-9]([A-Za-z0-9._-]*[A-Za-z0-9])?$/;
  const idOk =
    coord &&
    (coord.ecosystem === 'npm'
      ? NPM_ID.test(coord.id)
      : coord.ecosystem === 'pypi'
        ? PYPI_ID.test(coord.id)
        : false);
  const origin: CapabilityOrigin =
    coord?.confidence === 'high' && idOk && (coord.ecosystem === 'npm' || coord.ecosystem === 'pypi')
      ? { type: coord.ecosystem, id: coord.id, ...(coord.version ? { version: coord.version } : {}) }
      : { type: 'manual' };
  const changes: PlannedChange[] = [];
  const skips: PlanSkip[] = [];
  for (const a of writerAdapters(adapters)) {
    if (!targetIds.includes(a.id)) continue;
    if (SELF_PROTECTED.has(name)) {
      skips.push({
        agent: a.id,
        kind: 'protected',
        reason: `refusing to modify fleet's own entry "${name}"`,
      });
      continue;
    }
    try {
      const r = await a.renderInstall(spec, { kind: 'mcp-server', name, scope });
      if (await isNoop(r.file, r.newContent)) {
        skips.push({ agent: a.id, kind: 'noop', reason: 'already up to date' });
        continue;
      }
      if (r.baseHash === undefined) {
        r.warnings = [...(r.warnings ?? []), `will create a new config for '${a.id}' at ${r.file}`];
      }
      changes.push(toPlannedChange(a.id, 'install', name, scope, r));
    } catch (e) {
      skips.push({ agent: a.id, kind: 'error', reason: msg(e) });
    }
  }
  const policy = opts?.trustPolicy ?? loadConfig(opts?.fleetHome).trustPolicy;
  const withCanonical = changes.map((c) => ({ ...c, canonical: c.canonical ?? spec }));
  return applyTrustPolicy({ changes: withCanonical, skips, origin }, gateOrigin(origin), policy);
}

/** Plan removing a server from each target agent. */
export async function planRemove(
  adapters: AgentAdapter[],
  name: string,
  targetIds: AgentId[],
): Promise<Plan> {
  const changes: PlannedChange[] = [];
  const skips: PlanSkip[] = [];
  for (const a of writerAdapters(adapters)) {
    if (!targetIds.includes(a.id)) continue;
    if (SELF_PROTECTED.has(name)) {
      skips.push({
        agent: a.id,
        kind: 'protected',
        reason: `refusing to modify fleet's own entry "${name}"`,
      });
      continue;
    }
    try {
      const r = await a.renderRemove({ kind: 'mcp-server', name, scope: 'user' });
      if (await isNoop(r.file, r.newContent)) {
        skips.push({ agent: a.id, kind: 'noop', reason: 'not installed' });
        continue;
      }
      changes.push(toPlannedChange(a.id, 'remove', name, 'user', r));
    } catch (e) {
      skips.push({ agent: a.id, kind: 'error', reason: msg(e) });
    }
  }
  return { changes, skips };
}

/** Plan copying a server's spec from one agent to the others ("apply to all"). */
export async function planSync(
  adapters: AgentAdapter[],
  name: string,
  fromId: AgentId,
  targetIds: AgentId[],
): Promise<Plan> {
  const source = adapters.find((a) => a.id === fromId);
  if (!source) throw new Error(`unknown source agent: '${fromId}'`);
  const item = (await source.readInventory()).find((i) => i.kind === 'mcp-server' && i.name === name);
  if (!item || item.kind !== 'mcp-server') {
    throw new Error(`MCP server "${name}" is not installed on '${fromId}'`);
  }
  return planInstall(
    adapters,
    item.spec,
    name,
    'user',
    targetIds.filter((t) => t !== fromId),
  );
}

// ---- Skills (directory-shaped capabilities) ----

type SkillWriterAdapter = AgentAdapter & SkillWriter;

export function isSkillWriter(a: AgentAdapter): a is SkillWriterAdapter {
  const w = a as Partial<SkillWriter>;
  return (
    a.supportsWrite === true &&
    typeof w.renderInstallSkill === 'function' &&
    typeof w.renderRemoveSkill === 'function'
  );
}

export function skillWriterAdapters(adapters: AgentAdapter[]): SkillWriterAdapter[] {
  return adapters.filter(isSkillWriter);
}

/** Plan installing a skill (copy its dir) into each target agent. */
export async function planInstallSkill(
  adapters: AgentAdapter[],
  source: SkillSource,
  name: string,
  targetIds: AgentId[],
  opts?: { trustPolicy?: 'warn' | 'block'; fleetHome?: string },
): Promise<Plan> {
  const changes: PlannedChange[] = [];
  const skips: PlanSkip[] = [];
  const sourceHash = await hashDir(source.dir);
  for (const a of skillWriterAdapters(adapters)) {
    if (!targetIds.includes(a.id)) continue;
    if (SELF_PROTECTED.has(name)) {
      skips.push({
        agent: a.id,
        kind: 'protected',
        reason: `refusing to modify fleet's own entry "${name}"`,
      });
      continue;
    }
    try {
      const r = await a.renderInstallSkill(source, { kind: 'skill', name, scope: 'user' });
      if (r.baseHash !== undefined && r.baseHash === sourceHash) {
        skips.push({ agent: a.id, kind: 'noop', reason: 'already up to date' });
        continue;
      }
      changes.push(toPlannedChange(a.id, 'install', name, 'user', r));
    } catch (e) {
      skips.push({ agent: a.id, kind: 'error', reason: msg(e) });
    }
  }
  const policy = opts?.trustPolicy ?? loadConfig(opts?.fleetHome).trustPolicy;
  const verdict = await gateSkillSource(source.dir);
  // bind the verdict to the bytes: the tree we INSPECTED must be the tree the
  // plan will install (renderers pinned sourceHash before the scan)
  const postScan = await hashDir(source.dir);
  for (const c of changes) {
    if (c.sourceHash !== undefined && c.sourceHash !== postScan) {
      throw new Error(`fleet: skill source ${source.dir} changed during trust inspection; re-plan`);
    }
  }
  return applyTrustPolicy(
    { changes, skips, origin: { type: 'dir', path: resolve(source.dir) } },
    verdict,
    policy,
  );
}

/** Plan removing a skill from each target agent. */
export async function planRemoveSkill(
  adapters: AgentAdapter[],
  name: string,
  targetIds: AgentId[],
): Promise<Plan> {
  const changes: PlannedChange[] = [];
  const skips: PlanSkip[] = [];
  for (const a of skillWriterAdapters(adapters)) {
    if (!targetIds.includes(a.id)) continue;
    if (SELF_PROTECTED.has(name)) {
      skips.push({
        agent: a.id,
        kind: 'protected',
        reason: `refusing to modify fleet's own entry "${name}"`,
      });
      continue;
    }
    try {
      const r = await a.renderRemoveSkill({ kind: 'skill', name, scope: 'user' });
      changes.push(toPlannedChange(a.id, 'remove', name, 'user', r));
    } catch (e) {
      const reason = msg(e);
      skips.push({ agent: a.id, kind: /not installed/.test(reason) ? 'noop' : 'error', reason });
    }
  }
  return { changes, skips };
}

/** Plan copying a skill from one agent's installed dir to the others. */
export async function planSyncSkill(
  adapters: AgentAdapter[],
  name: string,
  fromId: AgentId,
  targetIds: AgentId[],
): Promise<Plan> {
  const source = adapters.find((a) => a.id === fromId);
  if (!source) throw new Error(`unknown source agent: '${fromId}'`);
  const item = (await source.readInventory()).find((i) => i.kind === 'skill' && i.name === name);
  if (!item || item.kind !== 'skill') {
    throw new Error(`skill "${name}" is not installed on '${fromId}'`);
  }
  const src: SkillSource = { name, dir: item.path, meta: item.meta };
  return planInstallSkill(
    adapters,
    src,
    name,
    targetIds.filter((t) => t !== fromId),
  );
}

// ---- Rules / instructions (always-on, managed blocks in markdown files) ----

type RuleWriterAdapter = AgentAdapter & RuleWriter;

export function isRuleWriter(a: AgentAdapter): a is RuleWriterAdapter {
  const w = a as Partial<RuleWriter>;
  return (
    a.supportsWrite === true &&
    typeof w.renderInstallRule === 'function' &&
    typeof w.renderRemoveRule === 'function'
  );
}

export function ruleWriterAdapters(adapters: AgentAdapter[]): RuleWriterAdapter[] {
  return adapters.filter(isRuleWriter);
}

/** Plan installing a rule (managed instruction block) into each target agent. */
export async function planInstallRule(
  adapters: AgentAdapter[],
  name: string,
  body: string,
  targetIds: AgentId[],
): Promise<Plan> {
  const changes: PlannedChange[] = [];
  const skips: PlanSkip[] = [];
  for (const a of ruleWriterAdapters(adapters)) {
    if (!targetIds.includes(a.id)) continue;
    if (SELF_PROTECTED.has(name)) {
      skips.push({
        agent: a.id,
        kind: 'protected',
        reason: `refusing to modify fleet's own entry "${name}"`,
      });
      continue;
    }
    try {
      const r = await a.renderInstallRule(body, { kind: 'rule', name, scope: 'user' });
      if (await isNoop(r.file, r.newContent)) {
        skips.push({ agent: a.id, kind: 'noop', reason: 'already up to date' });
        continue;
      }
      // impact analysis (best-effort): warn if this rule opposes an always-on
      // rule already there. MUST NOT block the install — a malformed MCP config
      // would make readInventory throw, and that's unrelated to writing a rule.
      try {
        const existing = (await a.readInventory()).filter((i): i is RuleCapability => i.kind === 'rule');
        const opp = opposingRules(existing, body, name);
        if (opp.length) {
          r.warnings = [
            ...(r.warnings ?? []),
            ...opp.map(
              (o) =>
                `possible ${o.axis} conflict with existing rule "${o.name}" (heuristic) — ${RESOLUTION_HINT}`,
            ),
          ];
        }
      } catch {
        /* impact analysis is best-effort; never block the install */
      }
      changes.push(toPlannedChange(a.id, 'install', name, 'user', r));
    } catch (e) {
      skips.push({ agent: a.id, kind: 'error', reason: msg(e) });
    }
  }
  const withBody = changes.map((c) => ({ ...c, canonical: c.after }));
  return { changes: withBody, skips, origin: { type: 'manual' } };
}

/** Plan removing a rule block from each target agent. */
export async function planRemoveRule(
  adapters: AgentAdapter[],
  name: string,
  targetIds: AgentId[],
): Promise<Plan> {
  const changes: PlannedChange[] = [];
  const skips: PlanSkip[] = [];
  for (const a of ruleWriterAdapters(adapters)) {
    if (!targetIds.includes(a.id)) continue;
    if (SELF_PROTECTED.has(name)) {
      skips.push({
        agent: a.id,
        kind: 'protected',
        reason: `refusing to modify fleet's own entry "${name}"`,
      });
      continue;
    }
    try {
      const r = await a.renderRemoveRule({ kind: 'rule', name, scope: 'user' });
      if (await isNoop(r.file, r.newContent)) {
        skips.push({ agent: a.id, kind: 'noop', reason: 'not installed' });
        continue;
      }
      changes.push(toPlannedChange(a.id, 'remove', name, 'user', r));
    } catch (e) {
      skips.push({ agent: a.id, kind: 'error', reason: msg(e) });
    }
  }
  return { changes, skips };
}

/** Plan copying a rule's body from one agent to the others. */
export async function planSyncRule(
  adapters: AgentAdapter[],
  name: string,
  fromId: AgentId,
  targetIds: AgentId[],
): Promise<Plan> {
  const source = adapters.find((a) => a.id === fromId);
  if (!source) throw new Error(`unknown source agent: '${fromId}'`);
  const item = (await source.readInventory()).find((i) => i.kind === 'rule' && i.name === name);
  if (!item || item.kind !== 'rule') {
    throw new Error(`rule "${name}" is not installed on '${fromId}'`);
  }
  return planInstallRule(
    adapters,
    name,
    item.body,
    targetIds.filter((t) => t !== fromId),
  );
}

/** A validator that dispatches to each change's agent writer (kind-aware). */
export function makeValidator(adapters: AgentAdapter[]): ChangeValidator {
  const writers = new Map(writerAdapters(adapters).map((a) => [a.id, a]));
  return (change, content) => {
    // instruction files (rules) are markdown — no parse validation applies.
    if (change.kind === 'rule') return;
    const w = writers.get(change.agent);
    if (w) w.validate(content);
    else JSON.parse(content); // safe fallback
  };
}

/** LOW-LEVEL: applies without folding fleet.lock — use execute() unless you
 * are the engine. (kept exported for tests and advanced embedding) */
export async function applyPlan(
  adapters: AgentAdapter[],
  plan: Plan,
  opts?: ApplyOptions,
): Promise<ApplyResult[]> {
  return applyChanges(plan.changes, makeValidator(adapters), opts);
}

/** The outcome of executing a plan (dry-run or committed). */
export interface ExecuteResult {
  changes: PlannedChange[];
  skips: PlanSkip[];
  committed: boolean;
  applied: ApplyResult[];
  /** set when a commit failed partway: how many changes were applied first */
  failedAfter?: number;
  error?: string;
  /** the change applied but recording provenance in fleet.lock failed */
  lockWarning?: string;
}

/**
 * Single entrypoint shared by every face (CLI/MCP/web): dry-run unless
 * `commit`, with partial-apply surfaced rather than thrown. This makes
 * "dry-run unless committed" a property of the core, not each UI.
 */
export async function execute(
  adapters: AgentAdapter[],
  plan: Plan,
  opts: { commit: boolean; fleetHome?: string },
): Promise<ExecuteResult> {
  const base = { changes: plan.changes, skips: plan.skips };
  if (!opts.commit) return { ...base, committed: false, applied: [] };
  if (plan.changes.length === 0) return { ...base, committed: true, applied: [] };
  // the lock is metadata — its failure must never mask a successful apply
  const foldLock = async (applied: ApplyResult[]): Promise<string | undefined> => {
    if (applied.length === 0) return undefined;
    try {
      await updateLockFromApplied(applied, plan.origin ?? { type: 'manual' }, opts.fleetHome, plan.trust);
      return undefined;
    } catch (e) {
      return `applied, but fleet.lock update failed: ${msg(e)}`;
    }
  };
  try {
    const applied = await applyPlan(adapters, plan, { fleetHome: opts.fleetHome });
    const lockWarning = await foldLock(applied);
    return { ...base, committed: true, applied, ...(lockWarning ? { lockWarning } : {}) };
  } catch (err) {
    const applied = (err as { applied?: ApplyResult[] }).applied ?? [];
    const lockWarning = await foldLock(applied);
    return {
      ...base,
      committed: true,
      applied,
      failedAfter: applied.length,
      error: msg(err),
      ...(lockWarning ? { lockWarning } : {}),
    };
  }
}
