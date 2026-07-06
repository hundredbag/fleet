import type { Inventory } from '../core/types.js';
import type { FeedItem } from './source.js';
import { extractCoordinate, coordKey } from './coords.js';
import { assessTrust, type TrustAssessment } from './trust.js';

/**
 * Recommendation ranking (the "B" plan): not-installed × (novelty + popularity +
 * relevance-to-what-you-use). Transparent, local, private (relevance is computed
 * against the inventory on-device). Scoring is an INJECTABLE `Scorer` — the "C"
 * upgrade (central hub / LLM-judged) swaps it without touching callers. The seam
 * is **batch + async** on purpose: an LLM/hub judge scores the whole set in one
 * round-trip, not N synchronous per-item calls.
 */

export interface ScoreContext {
  /** keyword tokens from the user's installed capabilities (names + coordinates) */
  installedTokens: Set<string>;
  /** ecosystem:id coordinates of installed capabilities */
  installedCoords: Set<string>;
  /** agent ids present in the inventory */
  agents: string[];
  /** current time (ms); injected for deterministic tests */
  now: number;
}

export interface Scored {
  score: number;
  reasons: string[];
}

/** Batch + async so a hub/LLM judge can drop in unchanged. */
export type Scorer = (items: FeedItem[], ctx: ScoreContext) => Promise<Scored[]> | Scored[];

export interface Recommendation {
  item: FeedItem;
  score: number;
  reasons: string[];
  /** pre-install trust signal, computed once here (threads `now`) */
  trust: TrustAssessment;
}

const STOP = new Set([
  'server',
  'mcp',
  'model',
  'context',
  'protocol',
  'tool',
  'tools',
  'skill',
  'the',
  'for',
  'and',
  'with',
  'your',
  // generic tech tokens that would otherwise cause spurious "related" hits
  'api',
  'http',
  'client',
  'data',
  'file',
  'code',
  'core',
  'plugin',
  'integration',
  'support',
  'service',
  'cli',
]);

/** Tokens of length ≥4 (drops generic 3-char noise like "api"/"git"), minus stopwords. */
function tokensOf(...texts: (string | undefined)[]): Set<string> {
  const out = new Set<string>();
  for (const t of texts) {
    if (!t) continue;
    for (const w of t.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []) {
      if (!STOP.has(w)) out.add(w);
    }
  }
  return out;
}

/** Per-item heuristic: novelty + popularity + relevance. */
function scoreOne(item: FeedItem, ctx: ScoreContext): Scored {
  let score = 0;
  const reasons: string[] = [];

  // marketplace plugins have no novelty/popularity metadata — being one click
  // away in an already-registered marketplace IS the signal (base +1).
  if (item.kind === 'plugin') {
    score += 1;
    reasons.push('marketplace');
  }

  if (item.updatedAt) {
    const ageDays = (ctx.now - Date.parse(item.updatedAt)) / 86_400_000;
    if (ageDays >= 0 && ageDays <= 30) {
      score += 3;
      reasons.push('new');
    }
  }
  // require a non-trivial popularity before claiming "popular"
  if (typeof item.popularity === 'number' && item.popularity >= 10) {
    score += Math.min(3, Math.log10(item.popularity));
    reasons.push('popular');
  }
  // plugins: the identifier's @marketplace suffix would pollute relevance
  // ("claude-plugins-official" → 'claude' matches everything) — name+desc only.
  const idForTokens = item.kind === 'plugin' ? undefined : item.identifier;
  const overlap = [...tokensOf(item.name, item.description, idForTokens)].filter((t) =>
    ctx.installedTokens.has(t),
  );
  if (overlap.length > 0) {
    score += Math.min(3, overlap.length);
    reasons.push(`related to your setup (${overlap.slice(0, 3).join(', ')})`);
  }
  return { score, reasons };
}

/** The default local heuristic scorer (batch, synchronous — assignable to the async `Scorer`). */
export function defaultScorer(items: FeedItem[], ctx: ScoreContext): Scored[] {
  return items.map((it) => scoreOne(it, ctx));
}

/** Rank not-yet-installed feed items for THIS inventory. */
export async function recommend(
  inv: Inventory,
  items: FeedItem[],
  opts: { scorer?: Scorer; now?: number; limit?: number } = {},
): Promise<Recommendation[]> {
  const scorer = opts.scorer ?? defaultScorer;
  const now = opts.now ?? Date.now();

  const installedTokens = new Set<string>();
  const installedCoords = new Set<string>();
  const installedSkillNames = new Set<string>();
  const installedPluginNames = new Set<string>();
  const agents = new Set<string>();
  for (const i of inv.items) {
    agents.add(i.agent);
    for (const t of tokensOf(i.name)) installedTokens.add(t);
    if (i.kind === 'skill') installedSkillNames.add(i.name.toLowerCase());
    if (i.kind === 'plugin') installedPluginNames.add(i.name.toLowerCase());
    if (i.kind !== 'mcp-server') continue;
    const c = extractCoordinate(i.spec);
    if (c?.confidence === 'high') {
      installedCoords.add(coordKey(c.ecosystem, c.id));
      for (const t of tokensOf(c.id)) installedTokens.add(t);
    }
  }

  const candidates = items.filter((it) => {
    // Installed skills are filtered by NAME (local skills carry no registry id —
    // name is the only join key). A different skill sharing an installed name is
    // also dropped; a missed recommendation is the safe direction.
    if (it.kind === 'skill') return !installedSkillNames.has(it.name.toLowerCase());
    if (it.kind === 'plugin') return !installedPluginNames.has(it.name.toLowerCase());
    return !(it.identifier && it.ecosystem) || !installedCoords.has(coordKey(it.ecosystem, it.identifier));
  });
  const ctx: ScoreContext = { installedTokens, installedCoords, agents: [...agents], now };
  const scored = await scorer(candidates, ctx);

  const ranked = candidates
    .map((item, i) => {
      const s = scored[i] ?? { score: 0, reasons: [] };
      return { item, score: s.score, reasons: s.reasons, trust: assessTrust(item, now) };
    })
    .filter((r) => r.score >= 1) // signal floor: below this is noise
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.item.popularity ?? 0) - (a.item.popularity ?? 0) ||
        // deterministic final tiebreak (marketplace plugins share a base score —
        // without this, order would be manifest order, i.e. arbitrary)
        a.item.name.localeCompare(b.item.name),
    );

  return opts.limit ? ranked.slice(0, opts.limit) : ranked;
}

/**
 * Round-robin across categories so one dominant category (e.g. everything the
 * 'git' seed returned) doesn't fill the whole list. Preserves in-category order.
 */
export function diversifyByCategory(recs: Recommendation[], limit: number): Recommendation[] {
  const buckets = new Map<string, Recommendation[]>();
  for (const r of recs) {
    const key = r.item.category ?? 'other';
    const b = buckets.get(key) ?? [];
    b.push(r);
    buckets.set(key, b);
  }
  const out: Recommendation[] = [];
  const lists = [...buckets.values()];
  for (let round = 0; out.length < limit; round++) {
    let added = false;
    for (const list of lists) {
      const next = list[round];
      if (next) {
        out.push(next);
        added = true;
        if (out.length >= limit) break;
      }
    }
    if (!added) break;
  }
  return out;
}
