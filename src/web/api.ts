import type { AgentAdapter } from '../core/adapter.js';
import type { FeedSource } from '../feed/source.js';
import { buildInventory } from '../core/inventory.js';
import type { Inventory } from '../core/types.js';

// one dashboard refresh fires three endpoints; each rebuilt the inventory.
// A 3s micro-cache turns that into one scan without ever serving stale data
// beyond a single refresh cycle.
// keyed by the adapters ARRAY IDENTITY — each server passes its own array, so
// two embedded servers can't cross-serve snapshots inside the TTL window
const invCaches = new WeakMap<object, { time: number; epoch: number; promise: Promise<Inventory> }>();
let invalidateEpoch = 0; // bumping forces every cache entry stale
function snapshotInventory(adapters: Parameters<typeof buildInventory>[0]): Promise<Inventory> {
  // cache the IN-FLIGHT promise: the dashboard fires three endpoints
  // concurrently, and a completed-only cache would still triple-scan cold
  const hit = invCaches.get(adapters);
  if (hit && hit.epoch === invalidateEpoch && Date.now() - hit.time < 3000) return hit.promise;
  const promise = buildInventory(adapters);
  invCaches.set(adapters, { time: Date.now(), epoch: invalidateEpoch, promise });
  promise.catch(() => {
    invCaches.delete(adapters); // a failed scan must not be served for 3s
  });
  return promise;
}

/** Call after every successful mutation — a refresh right after APPLY must
 * never show pre-action inventory. */
export function invalidateInventoryCache(): void {
  invalidateEpoch++;
}
import { summarizeInventory } from '../core/redact.js';
import { analyzeConflicts } from '../core/conflicts.js';
import { defaultSources } from '../feed/index.js';
import { updatesForInventory, discover } from '../feed/feed.js';
import { cachedDiscover } from '../feed/cache.js';
import { skillUpdatesFromLock } from '../core/skill-updates.js';
import { recommend, diversifyByCategory } from '../feed/recommend.js';

/**
 * Read-only JSON API over core — the same logic the CLI/MCP faces use, so the
 * dashboard stays a thin, co-equal face. Everything is redacted (no secrets to
 * the browser). `sources` is injectable for deterministic tests.
 */

export async function apiInventory(adapters: AgentAdapter[]) {
  return summarizeInventory(await snapshotInventory(adapters));
}

export async function apiConflicts(adapters: AgentAdapter[]) {
  return {
    findings: analyzeConflicts(await snapshotInventory(adapters)),
    note: 'Heuristic; fleet-managed always-on rules only — verify before acting.',
  };
}

export async function apiFeed(
  adapters: AgentAdapter[],
  sources?: FeedSource[],
  opts?: { refresh?: boolean; fleetHome?: string },
) {
  const inv = await snapshotInventory(adapters);
  // INJECTED sources bypass the shared file cache entirely — a cache written
  // for the default set must never satisfy custom sources (and vice versa)
  const { items, failures, fromCache } = sources
    ? { ...(await discover(sources)), fromCache: false }
    : await cachedDiscover(defaultSources(), { refresh: opts?.refresh, fleetHome: opts?.fleetHome });
  const { updates } = updatesForInventory(inv, items);
  const ranked = await recommend(inv, items); // uncapped; sliced per kind below
  const mixed = [
    ...ranked.filter((r) => !r.item.kind || r.item.kind === 'mcp-server').slice(0, 30),
    ...diversifyByCategory(
      ranked.filter((r) => r.item.kind === 'skill'),
      30,
    ),
    ...diversifyByCategory(
      ranked.filter((r) => r.item.kind === 'plugin'),
      15,
    ),
  ];
  const recommendations = mixed.map((r) => ({
    name: r.item.name,
    kind: r.item.kind ?? 'mcp-server',
    category: r.item.category,
    identifier: r.item.identifier,
    ecosystem: r.item.ecosystem,
    source: r.item.source,
    description: r.item.description,
    url: r.item.url,
    updatedAt: r.item.updatedAt,
    popularity: r.item.popularity,
    score: Number(r.score.toFixed(2)),
    reasons: r.reasons,
    trust: r.trust,
  }));
  return {
    updates,
    skillUpdates: await skillUpdatesFromLock(inv, opts?.fleetHome),
    recommendations,
    failures,
    fromCache,
  };
}
