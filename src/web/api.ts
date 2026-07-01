import type { AgentAdapter } from '../core/adapter.js';
import type { FeedSource } from '../feed/source.js';
import { buildInventory } from '../core/inventory.js';
import { summarizeInventory } from '../core/redact.js';
import { analyzeConflicts } from '../core/conflicts.js';
import { defaultSources } from '../feed/index.js';
import { discover, updatesForInventory } from '../feed/feed.js';
import { recommend } from '../feed/recommend.js';
import { assessTrust } from '../feed/trust.js';

/**
 * Read-only JSON API over core — the same logic the CLI/MCP faces use, so the
 * dashboard stays a thin, co-equal face. Everything is redacted (no secrets to
 * the browser). `sources` is injectable for deterministic tests.
 */

export async function apiInventory(adapters: AgentAdapter[]) {
  return summarizeInventory(await buildInventory(adapters));
}

export async function apiConflicts(adapters: AgentAdapter[]) {
  return {
    findings: analyzeConflicts(await buildInventory(adapters)),
    note: 'Heuristic; fleet-managed always-on rules only — verify before acting.',
  };
}

export async function apiFeed(adapters: AgentAdapter[], sources: FeedSource[] = defaultSources()) {
  const inv = await buildInventory(adapters);
  const { items, failures } = await discover(sources);
  const { updates } = updatesForInventory(inv, items);
  const recommendations = (await recommend(inv, items, { limit: 20 })).map((r) => ({
    name: r.item.name,
    identifier: r.item.identifier,
    ecosystem: r.item.ecosystem,
    source: r.item.source,
    description: r.item.description,
    url: r.item.url,
    score: Number(r.score.toFixed(2)),
    reasons: r.reasons,
    trust: assessTrust(r.item),
  }));
  return { updates, recommendations, failures };
}
