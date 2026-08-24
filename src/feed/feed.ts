import type { Inventory, Scope } from '../core/types.js';
import type { FeedItem, FeedSource } from './source.js';
import { extractCoordinate, coordKey } from './coords.js';
import { cleanPublicSource, sanitizeFeedItems } from './sanitize.js';

/**
 * Client-side discovery. `discover` merges public feed items from sources; the
 * matching functions then cross-reference them LOCALLY against the inventory
 * (passed in — never fetched by a source), keeping the privacy boundary.
 */

export interface DiscoverResult {
  items: FeedItem[];
  /** sources that failed (offline/flaky) — lets the UI distinguish "nothing new"
   * from "couldn't reach the registry" */
  failures: { source: string; code: 'SOURCE_UNAVAILABLE' }[];
  /** Runtime-invalid or private-coordinate entries withheld at the source boundary. */
  withheld: number;
}

/** Merge + de-dupe (ecosystem-aware) feed items across sources. */
export async function discover(sources: FeedSource[], opts?: { since?: string }): Promise<DiscoverResult> {
  const all: FeedItem[] = [];
  const failures: DiscoverResult['failures'] = [];
  let withheld = 0;
  // Fetch sources in parallel; a slow/flaky one shouldn't add its timeout to the total.
  const settled = await Promise.allSettled(sources.map((s) => s.list(opts)));
  settled.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      const raw = Array.isArray(r.value) ? r.value : [];
      // Source identity is transport provenance, not remote payload data. A
      // registry item must not claim to be the local marketplace or skills.sh
      // and thereby acquire a mutation path that its actual source lacks.
      const source = cleanPublicSource(sources[i]!.id);
      if (!source) {
        withheld += raw.length;
        return;
      }
      const safe = sanitizeFeedItems(raw.map((item) => ({ ...item, source })));
      withheld += raw.length - safe.length;
      all.push(...safe);
    } else
      failures.push({
        source: cleanPublicSource(sources[i]!.id) ?? 'registry',
        // Registry exceptions can include response bodies, credentials, and
        // local proxy details. The failure class is all callers need.
        code: 'SOURCE_UNAVAILABLE',
      });
  });
  // de-dupe by coordinate, MERGING fields across sources (registry version +
  // PulseMCP popularity combine on one item; first source wins on conflict, later
  // sources fill only the fields the first left undefined). Items with no
  // identifier and no url are NOT de-duped on name — each keeps a unique key so
  // distinct-but-same-named entries aren't collapsed.
  const byKey = new Map<string, FeedItem>();
  let uniq = 0;
  for (const it of all) {
    const base = it.identifier ?? it.url;
    const key = base ? `${it.ecosystem ?? ''}:${base.toLowerCase()}` : `__uniq__:${uniq++}`;
    const prior = byKey.get(key);
    byKey.set(key, prior ? coalesce(it, prior) : it);
  }
  return { items: [...byKey.values()], failures, withheld };
}

/** Merge `over` onto `base`, but only for fields `over` actually defines
 * (so an explicit `undefined` from a mapper can't erase a real value). */
function coalesce(base: FeedItem, over: FeedItem): FeedItem {
  const out: FeedItem = { ...base };
  for (const k of Object.keys(over) as (keyof FeedItem)[]) {
    if (over[k] !== undefined) (out as unknown as Record<string, unknown>)[k] = over[k];
  }
  // A missing skills.sh review URL is an authority decision: its mapper could
  // not prove that the registry's declared repository matches the install
  // identifier. Metadata from another registry may enrich description and
  // recency, but must never fill the fields that make that winning source
  // actionable as a GitHub install.
  if (over.source === 'skills.sh' && over.kind === 'skill') {
    if (over.identifier === undefined) delete out.identifier;
    else out.identifier = over.identifier;
    if (over.url === undefined) delete out.url;
    else out.url = over.url;
  }
  return out;
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
  scope: Scope;
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
        scope: i.scope,
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
