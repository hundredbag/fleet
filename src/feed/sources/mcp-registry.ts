import type { FeedItem, FeedSource } from '../source.js';

/**
 * The official MCP Registry as a FeedSource (novelty + version + identifier).
 * Shape verified live (schema 2025-12-11): the list is
 *   { servers: [{ server: {...}, _meta: { "io.modelcontextprotocol.registry/official": {...} } }],
 *     metadata: { nextCursor, count } }
 * where the package coordinate is server.packages[].{registryType, identifier, version}
 * and freshness is _meta[...].updatedAt. `fetchImpl`/`baseUrl` are injectable for tests.
 */
export interface HttpSourceOpts {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  maxPages?: number;
  /** per-request timeout (ms) so a stalled registry can't hang the caller */
  timeoutMs?: number;
}

const OFFICIAL_META = 'io.modelcontextprotocol.registry/official';

export function mapEcosystem(r?: string): 'npm' | 'pypi' | 'other' {
  const x = (r ?? '').toLowerCase();
  if (x.includes('npm')) return 'npm';
  if (x.includes('pypi') || x.includes('py')) return 'pypi';
  return 'other';
}

/** Map one registry list entry ({ server, _meta }) to a FeedItem. */
function mapEntry(entry: any): FeedItem {
  const s = entry?.server ?? entry; // tolerate flat or wrapped
  const meta = entry?._meta?.[OFFICIAL_META] ?? {};
  const pkg = Array.isArray(s?.packages) ? s.packages[0] : undefined;
  const remote = Array.isArray(s?.remotes) ? s.remotes[0] : undefined;
  return {
    name: String(s?.title ?? s?.name ?? pkg?.identifier ?? 'unknown'),
    source: 'mcp-registry',
    identifier: pkg?.identifier,
    ecosystem: pkg ? mapEcosystem(pkg.registryType ?? pkg.registry_type) : undefined,
    version: s?.version ?? pkg?.version,
    description: s?.description,
    updatedAt: meta.updatedAt ?? meta.publishedAt,
    url: s?.repository?.url ?? remote?.url ?? s?.websiteUrl,
  };
}

/** True unless the registry explicitly marks this entry as a superseded version. */
function isLatest(entry: any): boolean {
  return entry?._meta?.[OFFICIAL_META]?.isLatest !== false;
}

export class McpRegistrySource implements FeedSource {
  readonly id = 'mcp-registry';
  constructor(private readonly opts: HttpSourceOpts = {}) {}

  async list(o?: { since?: string }): Promise<FeedItem[]> {
    const base = this.opts.baseUrl ?? 'https://registry.modelcontextprotocol.io';
    const doFetch = this.opts.fetchImpl ?? fetch;
    const maxPages = this.opts.maxPages ?? 5;
    const items: FeedItem[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < maxPages; page++) {
      const url = new URL('/v0/servers', base);
      if (o?.since) url.searchParams.set('updated_since', o.since);
      if (cursor) url.searchParams.set('cursor', cursor);
      const res = await doFetch(url.toString(), { signal: AbortSignal.timeout(this.opts.timeoutMs ?? 8000) });
      if (!res.ok) throw new Error(`mcp-registry: HTTP ${res.status}`);
      const data: any = await res.json();
      for (const entry of data?.servers ?? []) {
        if (isLatest(entry)) items.push(mapEntry(entry)); // skip superseded versions
      }
      cursor = data?.metadata?.nextCursor;
      if (!cursor) break;
    }
    return items;
  }
}
