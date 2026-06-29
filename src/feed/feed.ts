import type { Inventory } from '../core/types.js';
import type { FeedItem, FeedSource } from './source.js';
import { extractCoordinate } from './coords.js';

/**
 * Client-side discovery. `discover` merges public feed items from sources; the
 * matching functions then cross-reference them LOCALLY against the inventory
 * (passed in — never fetched by a source), keeping the privacy boundary.
 */

export interface DiscoverResult {
  items: FeedItem[];
  /** sources that failed (offline/flaky) — lets the UI distinguish "nothing new"
   * from "couldn't reach the registry" */
  failures: { source: string; error: string }[];
}

const coordKey = (ecosystem: string, id: string): string => `${ecosystem}:${id.toLowerCase()}`;

/** Merge + de-dupe (ecosystem-aware) feed items across sources. */
export async function discover(
  sources: FeedSource[],
  opts?: { since?: string },
): Promise<DiscoverResult> {
  const all: FeedItem[] = [];
  const failures: { source: string; error: string }[] = [];
  for (const s of sources) {
    try {
      all.push(...(await s.list(opts)));
    } catch (e) {
      failures.push({ source: s.id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  const seen = new Set<string>();
  const items: FeedItem[] = [];
  for (const it of all) {
    const key = `${it.ecosystem ?? ''}:${(it.identifier ?? it.url ?? it.name).toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(it);
  }
  return { items, failures };
}

// --- minimal version comparison (v1) ---
const SEMVER = /^\d+(\.\d+){0,2}([-+].*)?$/;
const isConcrete = (v?: string): v is string => !!v && SEMVER.test(v);
function cmpSemver(a: string, b: string): number {
  const pa = a.split(/[-+]/)[0]!.split('.').map(Number);
  const pb = b.split(/[-+]/)[0]!.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x !== y) return x < y ? -1 : 1;
  }
  return 0; // prerelease ordering ignored in v1
}

export interface UpdateFinding {
  name: string;
  agent: string;
  identifier: string;
  ecosystem: string;
  installed: string;
  available: string;
}

export interface Unmatched {
  name: string;
  agent: string;
  reason: string;
}

export interface UpdatesResult {
  updates: UpdateFinding[];
  unmatched: Unmatched[];
}

/**
 * Cross-reference installed MCP servers against feed items (LOCAL). Only claims
 * an update when BOTH installed and available are concrete semver and available
 * is strictly newer — everything else (unpinned, dist-tag, range, downgrade,
 * not-found) is honestly reported as unmatched with a reason.
 */
export function updatesForInventory(inv: Inventory, items: FeedItem[]): UpdatesResult {
  const byCoord = new Map<string, FeedItem>();
  for (const it of items) {
    if (it.identifier && it.ecosystem) byCoord.set(coordKey(it.ecosystem, it.identifier), it);
  }
  const updates: UpdateFinding[] = [];
  const unmatched: Unmatched[] = [];
  for (const i of inv.items) {
    if (i.kind !== 'mcp-server') continue;
    const coord = extractCoordinate(i.spec);
    if (!coord || coord.confidence !== 'high') {
      unmatched.push({ name: i.name, agent: i.agent, reason: 'no registry coordinate' });
      continue;
    }
    const it = byCoord.get(coordKey(coord.ecosystem, coord.id));
    if (!it || !it.version) {
      unmatched.push({ name: i.name, agent: i.agent, reason: 'not found in feed' });
      continue;
    }
    if (!isConcrete(coord.version)) {
      unmatched.push({ name: i.name, agent: i.agent, reason: 'installed version unknown/unpinned' });
      continue;
    }
    if (!isConcrete(it.version)) {
      unmatched.push({ name: i.name, agent: i.agent, reason: 'feed version not comparable' });
      continue;
    }
    if (cmpSemver(it.version, coord.version) > 0) {
      updates.push({
        name: i.name,
        agent: i.agent,
        identifier: coord.id,
        ecosystem: coord.ecosystem,
        installed: coord.version,
        available: it.version,
      });
    }
  }
  return { updates, unmatched };
}

/** Feed items the user does NOT already have installed (relevance = not-installed). */
export function newRelevant(inv: Inventory, items: FeedItem[]): FeedItem[] {
  const installed = new Set<string>();
  for (const i of inv.items) {
    if (i.kind !== 'mcp-server') continue;
    const c = extractCoordinate(i.spec);
    if (c?.confidence === 'high') installed.add(coordKey(c.ecosystem, c.id));
  }
  return items.filter(
    (it) => !(it.identifier && it.ecosystem) || !installed.has(coordKey(it.ecosystem, it.identifier)),
  );
}
