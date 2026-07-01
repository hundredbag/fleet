import type { FeedItem, FeedSource } from '../source.js';

/**
 * The official MCP Registry as a FeedSource (novelty + version + identifier).
 * `fetchImpl`/`baseUrl` are injectable for deterministic tests. Mapping is
 * defensive — the registry's `server.json` shape is still evolving (verify live
 * before relying on exact fields).
 */
export interface HttpSourceOpts {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  maxPages?: number;
}

export function mapEcosystem(r?: string): 'npm' | 'pypi' | 'other' {
  const x = (r ?? '').toLowerCase();
  if (x.includes('npm')) return 'npm';
  if (x.includes('pypi') || x.includes('py')) return 'pypi';
  return 'other';
}

function mapServer(s: any): FeedItem {
  const pkg = Array.isArray(s?.packages) ? s.packages[0] : undefined;
  return {
    name: String(s?.name ?? pkg?.name ?? pkg?.identifier ?? 'unknown'),
    source: 'mcp-registry',
    identifier: pkg?.name ?? pkg?.identifier,
    ecosystem: pkg ? mapEcosystem(pkg.registry_name ?? pkg.registry_type ?? pkg.registry) : undefined,
    version: s?.version ?? s?.version_detail?.version ?? pkg?.version,
    description: s?.description,
    updatedAt: s?.updated_at ?? s?._meta?.updated_at ?? s?.updatedAt,
    url: s?.repository?.url ?? s?.website_url ?? s?.homepage,
  };
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
      const res = await doFetch(url.toString());
      if (!res.ok) throw new Error(`mcp-registry: HTTP ${res.status}`);
      const data: any = await res.json();
      for (const s of data?.servers ?? []) items.push(mapServer(s));
      cursor = data?.metadata?.next_cursor;
      if (!cursor) break;
    }
    return items;
  }
}
