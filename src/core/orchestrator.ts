import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { extractCoordinate, extractRunnerPackageReferences, hasRunnerSourceEnvironment } from './coords.js';
import { readLockState, updateLockFromApplied, type CapabilityOrigin } from './lock.js';
import { gateOrigin, gateSkillSource, trustSnapshot, type GateVerdict } from './trustgate.js';
import { assertMutationConfigReadable, effectiveTrustPolicy } from './config.js';
import { readFile } from 'node:fs/promises';
import type { AgentAdapter, AgentWriter, RuleWriter, SkillSource, SkillWriter } from './adapter.js';
import type { AgentId, McpServerSpec, PrimitiveKind, RuleCapability, Scope } from './types.js';
import { hashMaterializedDir, safeJoin } from './fsutil.js';
import { opposingRules, RESOLUTION_HINT } from './conflicts.js';
import { inspectAdapter, inspectionAllowsMutation } from './inventory.js';
import { FleetOperationError } from './errors.js';
import { assertWritableScope, selectScopedCapability } from './scope.js';
import {
  applyChanges,
  toPlannedChange,
  type PlannedChange,
  type ApplyResult,
  type ApplyOptions,
  type ChangeValidator,
  isRecoveryPendingError,
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
  /** Explicit per-run policy chosen by the local caller. When absent, commit
   * re-applies the current Fleet policy so a stored preview cannot bypass a
   * later warn → block policy change. */
  trustPolicyOverride?: 'warn' | 'block';
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
  return adapters.filter(
    (adapter): adapter is WriterAdapter =>
      isWriter(adapter) &&
      adapter.capabilitySupport?.['mcp-server']?.inventory === 'supported' &&
      adapter.capabilitySupport['mcp-server'].management === 'writable',
  );
}

async function sourceInventory(adapters: AgentAdapter[], fromId: AgentId) {
  const source = adapters.find((adapter) => adapter.id === fromId);
  if (!source) throw new Error(`unknown source agent: '${fromId}'`);
  const snapshot = await inspectAdapter(source);
  if (!snapshot.detected.present || snapshot.detected.inventoryStatus !== 'ok') {
    throw new FleetOperationError('TARGET_UNAVAILABLE', `source inventory unavailable: '${fromId}'`);
  }
  return snapshot.items;
}

/** Names fleet refuses to mutate (its own entry once self-installed in M3). */
export const SELF_PROTECTED = new Set<string>(['fleet', 'fleet-mcp']);

/** Resolve a target string using the writer contract for the requested capability kind. */
export async function resolveTargets(
  adapters: AgentAdapter[],
  target: string,
  kind: 'mcp-server' | 'skill' | 'rule' = 'mcp-server',
): Promise<AgentId[]> {
  const writers: AgentAdapter[] =
    kind === 'skill'
      ? skillWriterAdapters(adapters)
      : kind === 'rule'
        ? ruleWriterAdapters(adapters)
        : writerAdapters(adapters);
  if (target === 'all') {
    // 'all' = present writer agents only (don't surprise-create absent ones)
    const present: AgentId[] = [];
    for (const w of writers) {
      const { detected } = await inspectAdapter(w);
      if (detected.present && inspectionAllowsMutation(detected)) present.push(w.id);
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
    const { detected } = await inspectAdapter(writers.find((writer) => writer.id === id)!);
    if (!inspectionAllowsMutation(detected)) {
      throw new FleetOperationError('TARGET_UNAVAILABLE', `agent state unavailable: '${id}'`);
    }
  }
  return [...new Set(ids)];
}

async function assertTargetInventoriesAvailable(
  adapters: AgentAdapter[],
  targetIds: AgentId[],
  selector?: { kind: PrimitiveKind; name: string; scope: Scope },
): Promise<void> {
  for (const adapter of adapters) {
    if (!targetIds.includes(adapter.id)) continue;
    const { detected, items } = await inspectAdapter(adapter);
    if (!inspectionAllowsMutation(detected)) {
      throw new FleetOperationError('TARGET_UNAVAILABLE', `agent state unavailable: '${adapter.id}'`);
    }
    if (selector) {
      selectScopedCapability(items, { agent: adapter.id, ...selector });
    }
  }
}

async function assertPlannedTargetsAvailable(
  adapters: AgentAdapter[],
  changes: PlannedChange[],
): Promise<void> {
  for (const agent of new Set(changes.map((change) => change.agent))) {
    const adapter = adapters.find((candidate) => candidate.id === agent);
    if (!adapter) throw new FleetOperationError('TARGET_UNAVAILABLE', `agent state unavailable: '${agent}'`);
    const { detected, items } = await inspectAdapter(adapter);
    if (!inspectionAllowsMutation(detected)) {
      throw new FleetOperationError('TARGET_UNAVAILABLE', `agent state unavailable: '${agent}'`);
    }
    const selectors = new Map<string, { kind: PrimitiveKind; name: string; scope: Scope }>();
    for (const change of changes.filter((candidate) => candidate.agent === agent)) {
      const kind = change.kind ?? 'mcp-server';
      if (kind !== 'mcp-server' && kind !== 'skill' && kind !== 'rule') {
        throw new FleetOperationError('UNSUPPORTED_OPERATION', 'planned capability kind is not writable');
      }
      selectors.set(JSON.stringify([kind, change.name, change.scope]), {
        kind,
        name: change.name,
        scope: change.scope,
      });
    }
    for (const selector of selectors.values()) {
      selectScopedCapability(items, { agent, ...selector });
    }
  }
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
  assertWritableScope(scope);
  await assertTargetInventoriesAvailable(writerAdapters(adapters), targetIds, {
    kind: 'mcp-server',
    name,
    scope,
  });
  const coord = extractCoordinate(spec);
  const runnerPackages = extractRunnerPackageReferences(spec);
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
      changes.push(
        toPlannedChange(a.id, r.before === undefined ? 'install' : 'update', name, scope, {
          ...r,
          kind: 'mcp-server',
        }),
      );
    } catch (e) {
      skips.push({ agent: a.id, kind: 'error', reason: msg(e) });
    }
  }
  const policy = effectiveTrustPolicy(opts?.fleetHome, opts?.trustPolicy);
  const withCanonical = changes.map((c) => ({ ...c, canonical: c.canonical ?? spec }));
  const packageVerdicts = runnerPackages.map((runnerPackage) =>
    runnerPackage.coordinate
      ? gateOrigin({
          type: runnerPackage.ecosystem,
          id: runnerPackage.coordinate.id,
          ...(runnerPackage.coordinate.version ? { version: runnerPackage.coordinate.version } : {}),
        })
      : {
          level: 'caution' as const,
          reasons: [
            `unverified ${runnerPackage.ecosystem} package source — file, URL, git, alias, or malformed package specs require manual review`,
          ],
          reasonCodes: ['PACKAGE_SOURCE_UNVERIFIED' as const],
        },
  );
  if (hasRunnerSourceEnvironment(spec)) {
    packageVerdicts.push({
      level: 'caution',
      reasons: [
        'runner execution or package source can be redirected by process environment; verify loader, path, registry, and config inputs',
      ],
      reasonCodes: ['RUNNER_SOURCE_ENVIRONMENT'],
    });
  }
  const trust = packageVerdicts.some((verdict) => verdict.level === 'caution')
    ? {
        level: 'caution' as const,
        reasons: [...new Set(packageVerdicts.flatMap((verdict) => verdict.reasons))],
        reasonCodes: [...new Set(packageVerdicts.flatMap((verdict) => verdict.reasonCodes))],
      }
    : gateOrigin(origin);
  return applyTrustPolicy(
    {
      changes: withCanonical,
      skips,
      origin,
      ...(opts?.trustPolicy ? { trustPolicyOverride: opts.trustPolicy } : {}),
    },
    trust,
    policy,
  );
}

/** Plan removing a server from each target agent. */
export async function planRemove(
  adapters: AgentAdapter[],
  name: string,
  targetIds: AgentId[],
  scope: Scope = 'user',
): Promise<Plan> {
  assertWritableScope(scope);
  await assertTargetInventoriesAvailable(writerAdapters(adapters), targetIds, {
    kind: 'mcp-server',
    name,
    scope,
  });
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
      const r = await a.renderRemove({ kind: 'mcp-server', name, scope });
      if (await isNoop(r.file, r.newContent)) {
        skips.push({ agent: a.id, kind: 'noop', reason: 'not installed' });
        continue;
      }
      changes.push(toPlannedChange(a.id, 'remove', name, scope, { ...r, kind: 'mcp-server' }));
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
  opts?: { trustPolicy?: 'warn' | 'block'; fleetHome?: string; sourceScope?: Scope },
): Promise<Plan> {
  const item = selectScopedCapability(await sourceInventory(adapters, fromId), {
    agent: fromId,
    kind: 'mcp-server',
    name,
    ...(opts?.sourceScope ? { scope: opts.sourceScope } : {}),
  });
  if (!item || item.kind !== 'mcp-server') {
    throw new Error(`MCP server "${name}" is not installed on '${fromId}'`);
  }
  return planInstall(
    adapters,
    item.spec,
    name,
    'user',
    targetIds.filter((t) => t !== fromId),
    opts,
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
  return adapters.filter(
    (adapter): adapter is SkillWriterAdapter =>
      isSkillWriter(adapter) &&
      adapter.capabilitySupport?.skill?.inventory === 'supported' &&
      adapter.capabilitySupport.skill.management === 'writable',
  );
}

/** Plan installing a skill (copy its dir) into each target agent. */
/** Emit an error skip for every requested agent that has no writer for this
 * kind — otherwise a targeted-but-unsupported agent (e.g. skill sync to an
 * MCP-only adapter) produces neither a change nor a skip and vanishes silently. */
function skipUnsupported(
  targetIds: AgentId[],
  supported: { id: string }[],
  kindLabel: string,
  skips: PlanSkip[],
): void {
  const ok = new Set(supported.map((a) => a.id));
  for (const id of targetIds) {
    if (!ok.has(id)) {
      skips.push({ agent: id, kind: 'error', reason: `agent has no ${kindLabel} writer` });
    }
  }
}

export async function planInstallSkill(
  adapters: AgentAdapter[],
  source: SkillSource,
  name: string,
  targetIds: AgentId[],
  opts?: { trustPolicy?: 'warn' | 'block'; fleetHome?: string; sourceRoot?: string },
): Promise<Plan> {
  await assertTargetInventoriesAvailable(skillWriterAdapters(adapters), targetIds, {
    kind: 'skill',
    name,
    scope: 'user',
  });
  if (opts?.sourceRoot) {
    const rel = relative(resolve(opts.sourceRoot), resolve(source.dir));
    if (!rel) throw new Error('fleet: a skill source must be below, not equal to, its source root');
    const contained = safeJoin(opts.sourceRoot, rel);
    if (resolve(contained) !== resolve(source.dir)) {
      throw new Error(`fleet: skill source ${source.dir} is outside its declared source root`);
    }
  }
  const changes: PlannedChange[] = [];
  const skips: PlanSkip[] = [];
  skipUnsupported(targetIds, skillWriterAdapters(adapters), 'skill', skips);
  const sourceHash = await hashMaterializedDir(source.dir);
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
      changes.push(
        toPlannedChange(a.id, r.before === undefined ? 'install' : 'update', name, 'user', {
          ...r,
          kind: 'skill',
        }),
      );
    } catch (e) {
      skips.push({ agent: a.id, kind: 'error', reason: msg(e) });
    }
  }
  const policy = effectiveTrustPolicy(opts?.fleetHome, opts?.trustPolicy);
  const verdict = await gateSkillSource(source.dir);
  // bind the verdict to the bytes: the tree we INSPECTED must be the tree the
  // plan will install (renderers pinned sourceHash before the scan)
  const postScan = await hashMaterializedDir(source.dir);
  for (const c of changes) {
    if (c.sourceHash !== undefined && c.sourceHash !== postScan) {
      throw new Error(`fleet: skill source ${source.dir} changed during trust inspection; re-plan`);
    }
  }
  return applyTrustPolicy(
    {
      changes,
      skips,
      origin: { type: 'dir', path: resolve(source.dir) },
      ...(opts?.trustPolicy ? { trustPolicyOverride: opts.trustPolicy } : {}),
    },
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
  await assertTargetInventoriesAvailable(skillWriterAdapters(adapters), targetIds, {
    kind: 'skill',
    name,
    scope: 'user',
  });
  const changes: PlannedChange[] = [];
  const skips: PlanSkip[] = [];
  skipUnsupported(targetIds, skillWriterAdapters(adapters), 'skill', skips);
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
      changes.push(toPlannedChange(a.id, 'remove', name, 'user', { ...r, kind: 'skill' }));
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
  opts?: {
    trustPolicy?: 'warn' | 'block';
    fleetHome?: string;
    sourceRoot?: string;
    sourceScope?: Scope;
  },
): Promise<Plan> {
  const item = selectScopedCapability(await sourceInventory(adapters, fromId), {
    agent: fromId,
    kind: 'skill',
    name,
    ...(opts?.sourceScope ? { scope: opts.sourceScope } : {}),
  });
  if (!item || item.kind !== 'skill') {
    throw new Error(`skill "${name}" is not installed on '${fromId}'`);
  }
  const src: SkillSource = { name, dir: item.path, meta: item.meta };
  return planInstallSkill(
    adapters,
    src,
    name,
    targetIds.filter((t) => t !== fromId),
    opts,
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
  return adapters.filter(
    (adapter): adapter is RuleWriterAdapter =>
      isRuleWriter(adapter) &&
      adapter.capabilitySupport?.rule?.inventory === 'supported' &&
      adapter.capabilitySupport.rule.management === 'writable',
  );
}

/** Plan installing a rule (managed instruction block) into each target agent. */
export async function planInstallRule(
  adapters: AgentAdapter[],
  name: string,
  body: string,
  targetIds: AgentId[],
): Promise<Plan> {
  await assertTargetInventoriesAvailable(ruleWriterAdapters(adapters), targetIds, {
    kind: 'rule',
    name,
    scope: 'user',
  });
  const changes: PlannedChange[] = [];
  const skips: PlanSkip[] = [];
  skipUnsupported(targetIds, ruleWriterAdapters(adapters), 'rule', skips);
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
      // The target snapshot already passed the fail-closed inventory preflight.
      // This second read is only best-effort impact analysis for a warning; a
      // transient failure here does not make the already-rendered rule unsafe.
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
      changes.push(
        toPlannedChange(a.id, r.before === undefined ? 'install' : 'update', name, 'user', {
          ...r,
          kind: 'rule',
        }),
      );
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
  await assertTargetInventoriesAvailable(ruleWriterAdapters(adapters), targetIds, {
    kind: 'rule',
    name,
    scope: 'user',
  });
  const changes: PlannedChange[] = [];
  const skips: PlanSkip[] = [];
  skipUnsupported(targetIds, ruleWriterAdapters(adapters), 'rule', skips);
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
      changes.push(toPlannedChange(a.id, 'remove', name, 'user', { ...r, kind: 'rule' }));
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
  opts?: { sourceScope?: Scope },
): Promise<Plan> {
  const item = selectScopedCapability(await sourceInventory(adapters, fromId), {
    agent: fromId,
    kind: 'rule',
    name,
    ...(opts?.sourceScope ? { scope: opts.sourceScope } : {}),
  });
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
  /** Original and/or partially published state needs manual inspection. */
  recoveryPending?: true;
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
  const executionPlan: Plan = plan.trust
    ? {
        ...plan,
        changes: plan.changes.map((change) => ({ ...change, trust: trustSnapshot(plan.trust!) })),
      }
    : plan;
  const base = { changes: executionPlan.changes, skips: plan.skips };
  if (!opts.commit) return { ...base, committed: false, applied: [] };
  if (plan.changes.length === 0) return { ...base, committed: true, applied: [] };
  try {
    assertMutationConfigReadable(opts.fleetHome);
  } catch (error) {
    return { ...base, committed: true, applied: [], failedAfter: 0, error: msg(error) };
  }
  // A lock fold failure after the target changed must never mask the real
  // apply. Pre-existing damaged provenance is handled separately, before any
  // mutation and under the same operation lock.
  const foldLock = async (applied: ApplyResult[]): Promise<string | undefined> => {
    // fleet.lock is provenance, so an applied mutation whose audit append
    // failed must not be laundered into a normal lock entry with a nonexistent
    // audit id.
    const recorded = applied.filter((result) => result.auditRecorded);
    if (recorded.length === 0) return undefined;
    try {
      await updateLockFromApplied(recorded, plan.origin ?? { type: 'manual' }, opts.fleetHome, plan.trust);
      return undefined;
    } catch (e) {
      return `applied, but fleet.lock update failed: ${msg(e)}`;
    }
  };
  let lockWarning: string | undefined;
  try {
    const applied = await applyPlan(adapters, executionPlan, {
      fleetHome: opts.fleetHome,
      beforeApplyLocked: async () => {
        const config = assertMutationConfigReadable(opts.fleetHome);
        const trustPolicy = effectiveTrustPolicy(
          opts.fleetHome,
          plan.trustPolicyOverride ?? config.trustPolicy,
        );
        if (trustPolicy === 'block' && plan.trust?.level === 'caution') {
          throw new Error('fleet: current trust policy blocks this caution-level plan; preview again');
        }
        const lock = await readLockState(opts.fleetHome);
        if (lock.status !== 'available' && lock.status !== 'not-present') {
          throw new Error('fleet: fleet.lock provenance is unavailable or malformed; refusing mutation');
        }
        await assertPlannedTargetsAvailable(adapters, executionPlan.changes);
      },
      whileLocked: async (results) => {
        lockWarning = await foldLock(results);
      },
    });
    return { ...base, committed: true, applied, ...(lockWarning ? { lockWarning } : {}) };
  } catch (err) {
    const applied = (err as { applied?: ApplyResult[] }).applied ?? [];
    return {
      ...base,
      committed: true,
      applied,
      failedAfter: applied.length,
      error: msg(err),
      ...(isRecoveryPendingError(err) ? { recoveryPending: true as const } : {}),
      ...(lockWarning ? { lockWarning } : {}),
    };
  }
}
