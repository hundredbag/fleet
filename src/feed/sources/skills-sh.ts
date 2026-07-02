import type { FeedItem, FeedSource } from '../source.js';
import type { HttpSourceOpts } from './mcp-registry.js';
import { defaultClassifier, type Classifier } from '../classify.js';

/**
 * skills.sh (the Vercel skills registry) as a FeedSource for SKILLS.
 * Its public API is search-only (`GET /api/search?q=…`, min 2 chars), so we
 * sweep a set of category-seed queries in parallel and merge — a de-facto
 * listing. Response shape (verified live 2026-07-02):
 *   { skills: [{ id: "owner/repo/skill-id", skillId, name, installs, source: "owner/repo" }] }
 * `installs` is a real install count → popularity. No description/updatedAt, so
 * skills rank on popularity+relevance (novelty never fires) and trust is
 * honestly 'unknown' recency.
 */
const DEFAULT_SEEDS = [
  'git',
  'test',
  'docs',
  'database',
  'browser',
  'deploy',
  'security',
  'design',
  'data',
  'agent',
  'api',
  'review',
];

export interface SkillsShOpts extends HttpSourceOpts {
  seeds?: string[];
  classifier?: Classifier;
}

function mapSkill(s: any, classify: Classifier): FeedItem | null {
  const id = typeof s?.id === 'string' ? s.id : undefined;
  const name = typeof s?.name === 'string' ? s.name : (s?.skillId ?? id);
  if (!id || !name) return null;
  const repo = typeof s?.source === 'string' ? s.source : undefined;
  const item: FeedItem = {
    name: String(name),
    source: 'skills.sh',
    kind: 'skill',
    identifier: id, // "owner/repo/skill-id"
    popularity: typeof s?.installs === 'number' ? s.installs : undefined,
    url: repo ? `https://github.com/${repo}` : undefined,
  };
  item.category = classify(item);
  return item;
}

export class SkillsShSource implements FeedSource {
  readonly id = 'skills.sh';
  constructor(private readonly opts: SkillsShOpts = {}) {}

  /** One search query against skills.sh (also used by `fleet skill find`). */
  async search(query: string): Promise<FeedItem[]> {
    const base = this.opts.baseUrl ?? 'https://skills.sh';
    const doFetch = this.opts.fetchImpl ?? fetch;
    const classify = this.opts.classifier ?? defaultClassifier;
    const url = new URL('/api/search', base);
    url.searchParams.set('q', query);
    const res = await doFetch(url.toString(), { signal: AbortSignal.timeout(this.opts.timeoutMs ?? 8000) });
    if (!res.ok) throw new Error(`skills.sh: HTTP ${res.status}`);
    const data: any = await res.json();
    const skills = Array.isArray(data?.skills) ? data.skills : [];
    return skills.map((s: any) => mapSkill(s, classify)).filter((x: FeedItem | null): x is FeedItem => !!x);
  }

  /** Seed-sweep listing: parallel category searches, merged + deduped by id. */
  async list(): Promise<FeedItem[]> {
    const seeds = this.opts.seeds ?? DEFAULT_SEEDS;
    const settled = await Promise.allSettled(seeds.map((s) => this.search(s)));
    const ok = settled.filter((r): r is PromiseFulfilledResult<FeedItem[]> => r.status === 'fulfilled');
    if (ok.length === 0) {
      const first = settled[0];
      throw new Error(
        `skills.sh: all seed queries failed (${first?.status === 'rejected' ? String(first.reason) : 'unknown'})`,
      );
    }
    const byId = new Map<string, FeedItem>();
    for (const r of ok) for (const item of r.value) if (item.identifier) byId.set(item.identifier, item);
    return [...byId.values()];
  }
}
