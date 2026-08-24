import type { AgentAdapter } from '../core/adapter.js';
import { analyzeConflicts } from '../core/conflicts.js';
import { detectDrift } from '../core/drift.js';
import { readDelegatedLedger } from '../core/delegate.js';
import { buildInventory } from '../core/inventory.js';
import { skillUpdatesFromLock } from '../core/skill-updates.js';
import { isPublicAgentId, isPublicCapabilityName } from '../core/redact.js';
import type { Inventory, PrimitiveKind } from '../core/types.js';
import { readAuditLedger, rollbackEligibleAuditIds } from '../core/writer.js';
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
import { pluginCoordinate } from '../core/plugin-coordinate.js';
import { loadConfig } from '../core/config.js';
import { inspectionAllowsMutation } from '../core/inventory.js';
import { skillWriterAdapters, writerAdapters } from '../core/orchestrator.js';
import { isValidWebPackageCoordinate } from './package-coordinate.js';
import { parseGitHubSkillIdentifier } from './github-skill.js';

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

function supportsFeedUpdate(
  adapters: AgentAdapter[],
  inv: Inventory,
  kind: PrimitiveKind,
  name: string,
  agent?: string,
): 'update' | null {
  return adapters.some((adapter) => {
    if (agent && adapter.id !== agent) return false;
    const state = inv.agents.find((candidate) => candidate.id === adapter.id);
    if (!state || !state.present || state.inventoryStatus !== 'ok') return false;
    const instances = inv.items.filter(
      (item) => item.kind === kind && item.name === name && item.agent === adapter.id,
    );
    // Feed update coordinates do not carry a scope/context selector. Never
    // advertise an action that a later preview would have to resolve by array order.
    if (instances.length !== 1) return false;
    const instance = instances[0];
    return operationAllowed(
      {
        adapter,
        agent: state,
        kind,
        hasInstance: Boolean(instance),
        ...(instance ? { scope: instance.scope } : {}),
        hasSourceInstance: true,
        delegatedSupported: kind === 'plugin' && supportsDelegatedPlugin(adapter),
      },
      'update',
    );
  })
    ? 'update'
    : null;
}

function installTargets(
  adapters: AgentAdapter[],
  inv: Inventory,
  kind: 'mcp-server' | 'skill' | 'plugin',
  name: string,
  marketplace?: string,
): string[] {
  const candidates =
    kind === 'mcp-server'
      ? writerAdapters(adapters)
      : kind === 'skill'
        ? skillWriterAdapters(adapters)
        : adapters.filter(supportsDelegatedPlugin);
  return candidates.flatMap((adapter) => {
    const state = inv.agents.find((candidate) => candidate.id === adapter.id);
    if (!state?.present || !inspectionAllowsMutation(state)) return [];
    const instances = inv.items.filter(
      (item) =>
        item.kind === kind &&
        item.name === name &&
        item.agent === adapter.id &&
        (kind !== 'plugin' || !marketplace || (item.kind === 'plugin' && item.marketplace === marketplace)),
    );
    const allowed = operationAllowed(
      {
        adapter,
        agent: state,
        kind,
        hasInstance: instances.length > 0,
        ...(instances.length === 1 ? { scope: instances[0]!.scope } : {}),
        hasSourceInstance: true,
        delegatedSupported: kind === 'plugin' && supportsDelegatedPlugin(adapter),
      },
      'install',
    );
    return allowed ? [adapter.id] : [];
  });
}

export async function apiFeed(
  adapters: AgentAdapter[],
  sources?: FeedSource[],
  opts?: { refresh?: boolean; fleetHome?: string },
): Promise<FeedResponse> {
  const inv = await snapshotInventory(adapters);
  const discovery = sources
    ? { ...(await discover(sources)), fromCache: false }
    : await cachedDiscover(defaultSources(loadConfig(opts?.fleetHome)), {
        refresh: opts?.refresh,
        fleetHome: opts?.fleetHome,
      });
  // The on-disk cache is sanitized but not an authority boundary: another
  // local process can rewrite a user-owned cache between Fleet runs. Cached
  // metadata remains useful for read-only discovery, but only a result bound
  // to the currently invoked source objects may advertise a mutation.
  const actionableDiscovery = discovery.fromCache === false;
  const updates = updatesForInventory(inv, discovery.items).updates.map((update) => ({
    ...update,
    operation: actionableDiscovery
      ? supportsFeedUpdate(adapters, inv, 'mcp-server', update.name, update.agent)
      : null,
  }));
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
    const parsedSkillCoordinate =
      actionableDiscovery && kind === 'skill' && item.source === 'skills.sh'
        ? parseGitHubSkillIdentifier(item.identifier)
        : null;
    const skillCoordinate =
      parsedSkillCoordinate && item.url === `https://github.com/${parsedSkillCoordinate.repository}`
        ? parsedSkillCoordinate
        : null;
    let pluginIdentity: ReturnType<typeof pluginCoordinate> | null = null;
    if (
      actionableDiscovery &&
      kind === 'plugin' &&
      item.source === 'plugin-markets' &&
      typeof item.identifier === 'string'
    ) {
      try {
        const parsed = pluginCoordinate(item.identifier);
        if (parsed.marketplace && parsed.name === item.name) pluginIdentity = parsed;
      } catch {
        pluginIdentity = null;
      }
    }
    const installName =
      kind === 'skill' && skillCoordinate
        ? skillCoordinate.skill
        : kind === 'plugin' && pluginIdentity
          ? pluginIdentity.name
          : item.name;
    const packageInstall =
      actionableDiscovery &&
      kind === 'mcp-server' &&
      isValidWebPackageCoordinate({
        ecosystem: item.ecosystem,
        identifier: item.identifier,
        version: item.version,
      });
    const installKind = packageInstall
      ? 'mcp-server'
      : skillCoordinate
        ? 'skill'
        : pluginIdentity
          ? 'plugin'
          : null;
    const targets = installKind
      ? installTargets(adapters, inv, installKind, installName, pluginIdentity?.marketplace)
      : [];
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
      updatedAt: item.updatedAt,
      ...(targets.length > 0 ? { targets } : {}),
      ...(installName !== item.name ? { installName } : {}),
      ...(skillCoordinate ? { skillCoordinate } : {}),
      ...(pluginIdentity?.marketplace ? { marketplace: pluginIdentity.marketplace } : {}),
      operation: targets.length > 0 ? ('install' as const) : null,
    };
  });
  const skillUpdates = await skillUpdatesFromLock(inv, opts?.fleetHome);
  return mapFeed({
    updates,
    skillUpdates,
    recommendations,
    failures: discovery.failures,
    fromCache: discovery.fromCache,
    sourceWithheld: discovery.withheld,
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
  marketplace?: string;
  outcome: 'applied' | 'nothing-to-do' | 'failed' | 'unknown';
}

const SAFE_AGENT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;

async function readDelegatedActivity(fleetHome?: string): Promise<{
  records: DelegatedLedgerRecord[];
  status: ActivityResponse['delegatedActions']['status'];
}> {
  const ledger = await readDelegatedLedger(fleetHome);
  return {
    status: ledger.status,
    records: ledger.records.map((value) => {
      const coordinate = pluginCoordinate(value.selector);
      return {
        id: value.id,
        ts: Date.parse(value.time),
        op: value.op,
        agent: value.agent,
        name: coordinate.name,
        ...(coordinate.marketplace ? { marketplace: coordinate.marketplace } : {}),
        outcome: value.pending
          ? 'unknown'
          : value.exitCode !== 0
            ? 'failed'
            : value.effect === 'changed'
              ? 'applied'
              : value.effect === 'unchanged'
                ? 'nothing-to-do'
                : 'unknown',
      };
    }),
  };
}

export async function apiActivity(fleetHome?: string): Promise<ActivityResponse> {
  const [coreResult, delegatedResult] = await Promise.all([
    readAuditLedger(fleetHome),
    readDelegatedActivity(fleetHome),
  ]);
  const rawCore = coreResult.records;
  const delegated = delegatedResult.records;
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
      isPublicAgentId(record.agent) &&
      typeof record.name === 'string' &&
      isPublicCapabilityName(record.name) &&
      (record.rolledBackFrom === undefined || publicAuditId(record.rolledBackFrom) !== undefined) &&
      (record.scope === undefined ||
        record.scope === 'user' ||
        record.scope === 'project' ||
        record.scope === 'local'),
  );
  const rolledBackIds = new Set(
    core.map((record) => record.rolledBackFrom).filter((id): id is string => typeof id === 'string'),
  );
  // Compute eligibility from the complete verified core history, not only the
  // public subset. A withheld newer record must still prevent an older backup
  // from being advertised as safe to restore.
  const rollbackEligibleIds = rollbackEligibleAuditIds(rawCore);
  const items = [
    ...core.map((record) =>
      mapCoreActivity(
        {
          id: publicAuditId(record.id)!,
          ts: record.ts,
          op: record.op,
          kind:
            record.kind === 'skill' || record.isDir
              ? 'skill'
              : record.kind === 'rule'
                ? 'rule'
                : 'mcp-server',
          agent: record.agent,
          name: record.name,
          scope: record.scope,
          trust: record.trust,
        },
        rolledBackIds.has(record.id),
        coreResult.status === 'available' &&
          record.id === publicAuditId(record.id) &&
          record.op !== 'rollback' &&
          !rolledBackIds.has(record.id) &&
          rollbackEligibleIds.has(record.id),
      ),
    ),
    ...delegated.map((record) => mapDelegatedActivity(record)),
  ]
    .sort((a, b) => b.ts - a.ts)
    .slice(0, 20);
  return {
    items,
    coreActions: { status: coreResult.status, withheldCount: rawCore.length - core.length },
    delegatedActions: { status: delegatedResult.status },
  };
}
