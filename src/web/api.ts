import type { AgentAdapter } from '../core/adapter.js';
import type { FeedSource } from '../feed/source.js';
import { buildInventory } from '../core/inventory.js';
import type { Inventory } from '../core/types.js';

// one dashboard refresh fires three endpoints; each rebuilt the inventory.
// A 3s micro-cache turns that into one scan without ever serving stale data
// beyond a single refresh cycle.
let invCache: { time: number; inv: Inventory } | undefined;
async function snapshotInventory(adapters: Parameters<typeof buildInventory>[0]): Promise<Inventory> {
  if (invCache && Date.now() - invCache.time < 3000) return invCache.inv;
  const inv = await buildInventory(adapters);
  invCache = { time: Date.now(), inv };
  return inv;
}
import { summarizeInventory } from '../core/redact.js';
import { analyzeConflicts } from '../core/conflicts.js';
import { defaultSources } from '../feed/index.js';
import { updatesForInventory } from '../feed/feed.js';
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

export async function apiFeed(adapters: AgentAdapter[], sources: FeedSource[] = defaultSources()) {
  const inv = await snapshotInventory(adapters);
  const { items, failures } = await cachedDiscover(sources);
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
  return { updates, skillUpdates: await skillUpdatesFromLock(inv), recommendations, failures };
}
