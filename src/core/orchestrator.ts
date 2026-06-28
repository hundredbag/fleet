import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { AgentAdapter, AgentWriter } from './adapter.js';
import type { AgentId, McpServerSpec, Scope } from './types.js';
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
export const SELF_PROTECTED = new Set<string>(['fleet']);

/** Resolve a `--to`/`--from` target string to concrete writer agent ids. */
export async function resolveTargets(
  adapters: AgentAdapter[],
  target: string,
): Promise<AgentId[]> {
  const writers = writerAdapters(adapters);
  if (target === 'all') {
    // 'all' = present writer agents only (don't surprise-create absent ones)
    const present: AgentId[] = [];
    for (const w of writers) {
      if ((await w.detect()).present) present.push(w.id);
    }
    return present;
  }
  const ids = target.split(',').map((s) => s.trim()).filter(Boolean);
  const known = new Set(writers.map((w) => w.id));
  for (const id of ids) {
    if (!known.has(id)) throw new Error(`unknown or non-writable agent: '${id}'`);
  }
  return [...new Set(ids)];
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
): Promise<Plan> {
  const changes: PlannedChange[] = [];
  const skips: PlanSkip[] = [];
  for (const a of writerAdapters(adapters)) {
    if (!targetIds.includes(a.id)) continue;
    if (SELF_PROTECTED.has(name)) {
      skips.push({ agent: a.id, kind: 'protected', reason: `refusing to modify fleet's own entry "${name}"` });
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
  return { changes, skips };
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
      skips.push({ agent: a.id, kind: 'protected', reason: `refusing to modify fleet's own entry "${name}"` });
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
  const item = (await source.readInventory()).find((i) => i.name === name);
  if (!item) throw new Error(`"${name}" is not installed on '${fromId}'`);
  return planInstall(
    adapters,
    item.spec,
    name,
    'user',
    targetIds.filter((t) => t !== fromId),
  );
}

/** A validator that dispatches to each change's agent writer. */
export function makeValidator(adapters: AgentAdapter[]): ChangeValidator {
  const writers = new Map(writerAdapters(adapters).map((a) => [a.id, a]));
  return (change, content) => {
    const w = writers.get(change.agent);
    if (w) w.validate(content);
    else JSON.parse(content); // safe fallback
  };
}

export async function applyPlan(
  adapters: AgentAdapter[],
  plan: Plan,
  opts?: ApplyOptions,
): Promise<ApplyResult[]> {
  return applyChanges(plan.changes, makeValidator(adapters), opts);
}
