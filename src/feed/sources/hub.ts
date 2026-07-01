import type { FeedItem, FeedSource } from '../source.js';
import type { HttpSourceOpts } from './mcp-registry.js';

/**
 * The central hub as a FeedSource — the "C" upgrade, drop-in. The hub does the
 * heavy lifting server-side (crawl + LLM/security scoring) and serves a curated,
 * **metadata-only** feed of FeedItems with popularity/security/status already
 * filled. The client consumes it like any other source, so the privacy boundary
 * holds (public metadata in; the inventory is never sent to the hub, and
 * "updates to mine" matching stays local). Enable by setting `hubUrl` in config.
 *
 * Protocol: `GET {hubUrl}/v0/feed[?since=RFC3339]` → `{ items: FeedItem[] }`
 * (a bare array is also accepted). See docs/design-hub.md.
 */
/** Keep only a well-formed { level, reasons } security verdict; drop anything else. */
function cleanSecurity(s: any): unknown {
  if (s && typeof s === 'object' && typeof s.level === 'string') {
    const reasons = Array.isArray(s.reasons) ? s.reasons.filter((r: unknown) => typeof r === 'string') : [];
    return { level: s.level, reasons };
  }
  return undefined;
}

function mapItem(x: any): FeedItem {
  const eco = x?.ecosystem;
  return {
    name: String(x?.name ?? x?.identifier ?? 'unknown'),
    source: 'hub',
    identifier: typeof x?.identifier === 'string' ? x.identifier : undefined,
    ecosystem: eco === 'npm' || eco === 'pypi' ? eco : eco ? 'other' : undefined,
    version: typeof x?.version === 'string' ? x.version : undefined,
    url: typeof x?.url === 'string' ? x.url : undefined,
    description: typeof x?.description === 'string' ? x.description : undefined,
    updatedAt: typeof x?.updatedAt === 'string' ? x.updatedAt : undefined,
    popularity: typeof x?.popularity === 'number' ? x.popularity : undefined,
    status: typeof x?.status === 'string' ? x.status : undefined,
    security: cleanSecurity(x?.security),
  };
}

export class FleetHubSource implements FeedSource {
  readonly id = 'hub';
  constructor(
    private readonly baseUrl: string,
    private readonly opts: HttpSourceOpts = {},
  ) {}

  async list(o?: { since?: string }): Promise<FeedItem[]> {
    const doFetch = this.opts.fetchImpl ?? fetch;
    const url = new URL('/v0/feed', this.baseUrl);
    if (o?.since) url.searchParams.set('since', o.since);
    const res = await doFetch(url.toString(), { signal: AbortSignal.timeout(this.opts.timeoutMs ?? 8000) });
    if (!res.ok) throw new Error(`hub: HTTP ${res.status}`);
    const data: any = await res.json();
    const items = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
    return items.map(mapItem);
  }
}
