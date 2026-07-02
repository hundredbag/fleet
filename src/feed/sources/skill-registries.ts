import type { FeedItem, FeedSource } from '../source.js';
import type { HttpSourceOpts } from './mcp-registry.js';
import { defaultClassifier, type Classifier } from '../classify.js';

/**
 * Three additional skill registries as FeedSources (shapes verified live
 * 2026-07-03). All support unauthenticated browse + pagination:
 *  - SkillsMP        GET skillsmp.com/api/skills?page=N       (12/page; GitHub-crawled, low curation;
 *                    description + updatedAt(unix-seconds string) + stars + githubUrl)
 *  - ClawHub-skills  GET clawhub-skills.com/api/skills?page=N (24/page; OpenClaw registry mirror;
 *                    NATIVE category + downloads/installs + qualityScore + ISO updatedAt)
 *  - ClaudeSkills    GET claudeskills.info/api/skills?limit&offset (community-curated ~658;
 *                    license + requires_code_execution + repo_url + categories[])
 *
 * Cross-registry dedupe: when a GitHub coordinate is known, `identifier` is the
 * canonical `owner/repo/skill` (same convention as skills.sh), so discover()'s
 * merge combines the SAME skill listed on several registries (e.g. skills.sh
 * installs + SkillsMP description). ClawHub has no GitHub link → `clawhub/…`
 * namespace (not cross-deduped). Native categories win; the keyword classifier
 * is the fallback. Each source is a SAMPLE (first N pages), and faces say so.
 */

const PAGE_CAPS = { skillsmp: 5, clawhub: 3, claudeskills: 2 };

function iso(v: unknown): string | undefined {
  if (typeof v !== 'string' || !v) return undefined;
  if (/^\d{9,}$/.test(v)) return new Date(Number(v) * 1000).toISOString(); // unix seconds
  const t = Date.parse(v.includes(' ') ? v.replace(' ', 'T') + 'Z' : v);
  return Number.isNaN(t) ? undefined : new Date(t).toISOString();
}

function num(...vals: unknown[]): number | undefined {
  for (const v of vals) if (typeof v === 'number' && v > 0) return v;
  return undefined;
}

const GH_RE = /^https:\/\/github\.com\/([\w.-]+)\/([\w.-]+)/;

async function fetchJson(
  url: string,
  opts: HttpSourceOpts,
  sourceId: string,
): Promise<Record<string, unknown>> {
  const doFetch = opts.fetchImpl ?? fetch;
  const res = await doFetch(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 8000) });
  if (!res.ok) throw new Error(`${sourceId}: HTTP ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

/** Fetch pages until a page yields nothing new or the cap is hit; page 1 failing throws. */
async function pagedList(
  pageUrl: (page: number) => string,
  maxPages: number,
  opts: HttpSourceOpts,
  sourceId: string,
  mapPage: (data: any) => FeedItem[],
): Promise<FeedItem[]> {
  const byId = new Map<string, FeedItem>();
  for (let page = 1; page <= maxPages; page++) {
    let items: FeedItem[];
    try {
      items = mapPage(await fetchJson(pageUrl(page), opts, sourceId));
    } catch (e) {
      if (page === 1) throw e; // completely unreachable → one discover() failure
      break; // later page failed → keep what we have
    }
    let added = 0;
    for (const it of items) {
      if (it.identifier && !byId.has(it.identifier)) {
        byId.set(it.identifier, it);
        added++;
      }
    }
    if (added === 0) break;
  }
  return [...byId.values()];
}

// --- SkillsMP -------------------------------------------------------------

export class SkillsMpSource implements FeedSource {
  readonly id = 'skillsmp';
  constructor(private readonly opts: HttpSourceOpts & { classifier?: Classifier } = {}) {}

  async list(): Promise<FeedItem[]> {
    const base = this.opts.baseUrl ?? 'https://skillsmp.com';
    const classify = this.opts.classifier ?? defaultClassifier;
    return pagedList(
      (p) => `${base}/api/skills?page=${p}`,
      this.opts.maxPages ?? PAGE_CAPS.skillsmp,
      this.opts,
      this.id,
      (data) =>
        (Array.isArray(data?.skills) ? data.skills : [])
          .map((s: any): FeedItem | null => {
            const name = typeof s?.name === 'string' ? s.name : undefined;
            if (!name) return null;
            const gh = typeof s?.githubUrl === 'string' ? GH_RE.exec(s.githubUrl) : null;
            const item: FeedItem = {
              name: name.slice(0, 200),
              source: 'skillsmp',
              kind: 'skill',
              identifier: gh ? `${gh[1]}/${gh[2]}/${name}` : `skillsmp/${String(s?.id ?? name)}`,
              description: typeof s?.description === 'string' ? s.description.slice(0, 500) : undefined,
              popularity: num(s?.stars),
              updatedAt: iso(s?.updatedAt),
              url: gh ? `https://github.com/${gh[1]}/${gh[2]}` : undefined,
            };
            item.category = classify(item);
            return item;
          })
          .filter((x: FeedItem | null): x is FeedItem => !!x),
    );
  }
}

// --- ClawHub-skills ---------------------------------------------------------

export class ClawHubSource implements FeedSource {
  readonly id = 'clawhub';
  constructor(private readonly opts: HttpSourceOpts & { classifier?: Classifier } = {}) {}

  async list(): Promise<FeedItem[]> {
    const base = this.opts.baseUrl ?? 'https://clawhub-skills.com';
    const classify = this.opts.classifier ?? defaultClassifier;
    return pagedList(
      (p) => `${base}/api/skills?page=${p}`,
      this.opts.maxPages ?? PAGE_CAPS.clawhub,
      this.opts,
      this.id,
      (data) =>
        (Array.isArray(data?.skills) ? data.skills : [])
          .map((s: any): FeedItem | null => {
            const slug = typeof s?.slug === 'string' ? s.slug : undefined;
            const name = typeof s?.displayName === 'string' ? s.displayName : slug;
            if (!slug || !name) return null;
            const item: FeedItem = {
              name: name.slice(0, 200),
              source: 'clawhub',
              kind: 'skill',
              identifier: `clawhub/${typeof s?.author === 'string' ? s.author : '_'}/${slug}`,
              description: typeof s?.summary === 'string' ? s.summary.slice(0, 500) : undefined,
              popularity: num(s?.installsAllTime, s?.downloads, s?.stars),
              updatedAt: iso(s?.updatedAt),
              // native category wins over the keyword classifier
              category: typeof s?.category === 'string' && s.category ? s.category : undefined,
            };
            if (!item.category) item.category = classify(item);
            return item;
          })
          .filter((x: FeedItem | null): x is FeedItem => !!x),
    );
  }
}

// --- ClaudeSkills.info ------------------------------------------------------

export class ClaudeSkillsInfoSource implements FeedSource {
  readonly id = 'claudeskills';
  constructor(private readonly opts: HttpSourceOpts & { classifier?: Classifier } = {}) {}

  async list(): Promise<FeedItem[]> {
    const base = this.opts.baseUrl ?? 'https://claudeskills.info';
    const classify = this.opts.classifier ?? defaultClassifier;
    const limit = 100;
    return pagedList(
      (p) => `${base}/api/skills?limit=${limit}&offset=${(p - 1) * limit}`,
      this.opts.maxPages ?? PAGE_CAPS.claudeskills,
      this.opts,
      this.id,
      (data) =>
        (Array.isArray(data?.skills) ? data.skills : [])
          .map((s: any): FeedItem | null => {
            const name = typeof s?.name === 'string' ? s.name : s?.slug;
            if (typeof name !== 'string' || !name) return null;
            const owner = typeof s?.repo_owner === 'string' ? s.repo_owner : undefined;
            const repo = typeof s?.repo_name === 'string' ? s.repo_name : undefined;
            const slug = typeof s?.slug === 'string' ? s.slug : name;
            const ghUrl = typeof s?.repo_url === 'string' && GH_RE.test(s.repo_url) ? s.repo_url : undefined;
            const cat =
              Array.isArray(s?.categories) && typeof s.categories[0] === 'string'
                ? s.categories[0]
                : undefined;
            const item: FeedItem = {
              name: name.slice(0, 200),
              source: 'claudeskills',
              kind: 'skill',
              identifier: owner && repo ? `${owner}/${repo}/${slug}` : `claudeskills/${slug}`,
              description:
                typeof s?.summary === 'string'
                  ? s.summary.slice(0, 500)
                  : typeof s?.description === 'string'
                    ? s.description.slice(0, 500)
                    : undefined,
              popularity: num(s?.download_count, s?.stars, s?.likes_count),
              updatedAt: iso(s?.updated_at),
              url: ghUrl,
              category: cat,
            };
            if (!item.category) item.category = classify(item);
            return item;
          })
          .filter((x: FeedItem | null): x is FeedItem => !!x),
    );
  }
}
