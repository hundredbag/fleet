import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter } from '../core/adapter.js';
import { analyzeConflicts } from '../core/conflicts.js';
import { detectDrift } from '../core/drift.js';
import { SELECTOR_RE } from '../core/delegate.js';
import { buildInventory } from '../core/inventory.js';
import { skillUpdatesFromLock } from '../core/skill-updates.js';
import type { Inventory, PrimitiveKind } from '../core/types.js';
import { readAudit } from '../core/writer.js';
import { cachedDiscover } from '../feed/cache.js';
import { discover, updatesForInventory } from '../feed/feed.js';
import { defaultSources } from '../feed/index.js';
import { diversifyByCategory, recommend } from '../feed/recommend.js';
import type { FeedSource } from '../feed/source.js';
import {
  mapConflicts,
  mapCoreActivity,
  mapDelegatedActivity,
  mapFeed,
  mapInventory,
  mapOverview,
  publicAuditId,
} from './public-mappers.js';
import type {
  ActivityResponse,
  ConflictsResponse,
  FeedResponse,
  InventoryResponse,
  OverviewResponse,
} from './types.js';
import { operationAllowed, supportsDelegatedPlugin } from './operations.js';

const invCaches = new WeakMap<object, { time: number; epoch: number; promise: Promise<Inventory> }>();
let invalidateEpoch = 0;

function snapshotInventory(adapters: Parameters<typeof buildInventory>[0]): Promise<Inventory> {
  const hit = invCaches.get(adapters);
  if (hit && hit.epoch === invalidateEpoch && Date.now() - hit.time < 3000) return hit.promise;
  const promise = buildInventory(adapters);
  invCaches.set(adapters, { time: Date.now(), epoch: invalidateEpoch, promise });
  promise.catch(() => invCaches.delete(adapters));
  return promise;
}

export function invalidateInventoryCache(): void {
  invalidateEpoch++;
}

export async function apiInventory(adapters: AgentAdapter[]): Promise<InventoryResponse> {
  return mapInventory(await snapshotInventory(adapters), adapters);
}

export async function apiConflicts(adapters: AgentAdapter[]): Promise<ConflictsResponse> {
  return mapConflicts(analyzeConflicts(await snapshotInventory(adapters)));
}

function supportsFeedOperation<O extends 'install' | 'update'>(
  adapters: AgentAdapter[],
  inv: Inventory,
  kind: PrimitiveKind,
  name: string,
  operation: O,
  agent?: string,
): O | null {
  return adapters.some((adapter) => {
    if (agent && adapter.id !== agent) return false;
    const state = inv.agents.find((candidate) => candidate.id === adapter.id);
    if (!state || !state.present || state.inventoryStatus !== 'ok') return false;
    return operationAllowed(
      {
        adapter,
        agent: state,
        kind,
        hasInstance: inv.items.some(
          (item) => item.kind === kind && item.name === name && item.agent === adapter.id,
        ),
        hasSourceInstance: true,
        delegatedSupported: kind === 'plugin' && supportsDelegatedPlugin(adapter),
      },
      operation,
    );
  })
    ? operation
    : null;
}

export async function apiFeed(
  adapters: AgentAdapter[],
  sources?: FeedSource[],
  opts?: { refresh?: boolean; fleetHome?: string },
): Promise<FeedResponse> {
  const inv = await snapshotInventory(adapters);
  const discovery = sources
    ? { ...(await discover(sources)), fromCache: false }
    : await cachedDiscover(defaultSources(), { refresh: opts?.refresh, fleetHome: opts?.fleetHome });
  const updates = updatesForInventory(inv, discovery.items).updates.filter(
    (update) =>
      supportsFeedOperation(adapters, inv, 'mcp-server', update.name, 'update', update.agent) === 'update',
  );
  const ranked = await recommend(inv, discovery.items);
  const mixed = [
    ...ranked.filter((item) => !item.item.kind || item.item.kind === 'mcp-server').slice(0, 30),
    ...diversifyByCategory(
      ranked.filter((item) => item.item.kind === 'skill'),
      30,
    ),
    ...diversifyByCategory(
      ranked.filter((item) => item.item.kind === 'plugin'),
      15,
    ),
  ];
  const recommendations = mixed.map((rankedItem) => {
    const item = rankedItem.item;
    const kind = (item.kind ?? 'mcp-server') as PrimitiveKind;
    return {
      name: item.name,
      kind,
      category: item.category,
      identifier: item.identifier,
      ecosystem: item.ecosystem,
      version: item.version,
      description: item.description,
      source: item.source,
      reasons: rankedItem.reasons.map((reason) => reason),
      trust: rankedItem.trust.level,
      url: item.url,
      operation: supportsFeedOperation(adapters, inv, kind, item.name, 'install'),
    };
  });
  const skillUpdates = await skillUpdatesFromLock(inv, opts?.fleetHome);
  return mapFeed({
    updates,
    skillUpdates,
    recommendations,
    failures: discovery.failures,
    fromCache: discovery.fromCache,
  });
}

export async function apiOverview(adapters: AgentAdapter[], fleetHome?: string): Promise<OverviewResponse> {
  const inv = await snapshotInventory(adapters);
  const publicInventory = mapInventory(inv, adapters);
  const drift = await detectDrift(inv, fleetHome);
  return mapOverview(publicInventory, drift, Date.now());
}

interface DelegatedLedgerRecord {
  id: string;
  ts: number;
  op: string;
  agent: string;
  name: string;
  succeeded: boolean;
}

const OPAQUE_ID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const SAFE_AGENT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

async function readDelegatedActivity(fleetHome?: string): Promise<{
  records: DelegatedLedgerRecord[];
  status: ActivityResponse['delegatedActions']['status'];
}> {
  const file = join(fleetHome ?? join(homedir(), '.fleet'), 'delegated.jsonl');
  if (!existsSync(file)) return { records: [], status: 'not-present' };
  const output: DelegatedLedgerRecord[] = [];
  let malformed = false;
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    return { records: [], status: 'unavailable' };
  }
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (
        typeof value.id !== 'string' ||
        !OPAQUE_ID.test(value.id) ||
        typeof value.time !== 'string' ||
        typeof value.agent !== 'string' ||
        (value.agent !== 'claude-code' && value.agent !== 'codex') ||
        (value.op !== 'install' && value.op !== 'remove') ||
        typeof value.selector !== 'string' ||
        !SELECTOR_RE.test(value.selector) ||
        value.selector.includes('..') ||
        !Number.isSafeInteger(value.exitCode) ||
        (value.exitCode as number) < 0 ||
        (value.exitCode as number) > 255
      ) {
        malformed = true;
        continue;
      }
      const ts = Date.parse(value.time);
      if (!Number.isFinite(ts)) {
        malformed = true;
        continue;
      }
      const lastMarketplace = value.selector.lastIndexOf('@');
      const name = lastMarketplace > 0 ? value.selector.slice(0, lastMarketplace) : value.selector;
      if (!/^(@[\w][\w.-]*\/)?[\w][\w.-]*$/.test(name) || name.includes('..')) {
        malformed = true;
        continue;
      }
      output.push({
        id: value.id,
        ts,
        op: value.op,
        agent: value.agent,
        name,
        succeeded: value.exitCode === 0,
      });
    } catch {
      malformed = true; // retain valid rows, but never imply the ledger was complete.
    }
  }
  return { records: output, status: malformed ? 'malformed' : 'available' };
}

export async function apiActivity(fleetHome?: string): Promise<ActivityResponse> {
  const [rawCore, delegatedResult] = await Promise.all([
    readAudit(fleetHome),
    readDelegatedActivity(fleetHome),
  ]);
  const delegated = delegatedResult.records;
  const logicalName = /^(@[\w][\w.-]*\/)?[\w][\w. @/-]*$/;
  const core = rawCore.filter(
    (record) =>
      typeof record.id === 'string' &&
      publicAuditId(record.id) !== undefined &&
      Number.isFinite(record.ts) &&
      (record.op === 'install' ||
        record.op === 'update' ||
        record.op === 'remove' ||
        record.op === 'rollback') &&
      typeof record.agent === 'string' &&
      SAFE_AGENT_ID.test(record.agent) &&
      logicalName.test(record.agent) &&
      typeof record.name === 'string' &&
      logicalName.test(record.name) &&
      !record.agent.includes('..') &&
      !record.name.includes('..') &&
      (record.rolledBackFrom === undefined || publicAuditId(record.rolledBackFrom) !== undefined) &&
      (record.scope === undefined ||
        record.scope === 'user' ||
        record.scope === 'project' ||
        record.scope === 'local'),
  );
  const rolledBackIds = new Set(
    core.map((record) => record.rolledBackFrom).filter((id): id is string => typeof id === 'string'),
  );
  const newestEligible = [...core]
    .reverse()
    .find((record) => record.op !== 'rollback' && !rolledBackIds.has(record.id))?.id;
  const items = [
    ...core.map((record) =>
      mapCoreActivity(
        {
          id: publicAuditId(record.id)!,
          ts: record.ts,
          op: record.op,
          agent: record.agent,
          name: record.name,
          scope: record.scope,
        },
        rolledBackIds.has(record.id),
        record.id === newestEligible,
      ),
    ),
    ...delegated.map((record) => mapDelegatedActivity(record)),
  ]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 20);
  return { items, delegatedActions: { status: delegatedResult.status } };
}
