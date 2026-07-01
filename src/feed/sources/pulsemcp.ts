import type { FeedItem, FeedSource } from '../source.js';
import { mapEcosystem, type HttpSourceOpts } from './mcp-registry.js';

/**
 * PulseMCP as a FeedSource — enriches items with POPULARITY (stars/downloads).
 * PulseMCP requires an API key (X-API-Key); without one it's not used (see
 * defaultSources). Defensive mapping; injectable fetch/baseUrl for tests.
 */
export interface PulseMcpOpts extends HttpSourceOpts {
  apiKey?: string;
}

function num(...vals: unknown[]): number | undefined {
  for (const v of vals) if (typeof v === 'number') return v;
  return undefined;
}

// NOTE: PulseMCP's response field names are provisional (verified: 401 without a
// key; body shape not yet confirmed against a live key). We accept several likely
// spellings so popularity survives naming differences; refine once verified.
function mapServer(s: any): FeedItem {
  const stars = num(s?.github_stars, s?.stars, s?.star_count);
  const downloads = num(s?.package_download_count, s?.download_count, s?.downloads);
  return {
    name: String(s?.name ?? 'unknown'),
    source: 'pulsemcp',
    identifier: s?.package_name ?? s?.npm_package ?? s?.identifier,
    ecosystem: mapEcosystem(s?.package_registry ?? s?.registry),
    popularity: stars ?? downloads,
    description: s?.short_description ?? s?.description,
    url: s?.url ?? s?.source_code_url,
  };
}

export class PulseMcpSource implements FeedSource {
  readonly id = 'pulsemcp';
  constructor(private readonly opts: PulseMcpOpts = {}) {}

  async list(): Promise<FeedItem[]> {
    if (!this.opts.apiKey) throw new Error('pulsemcp: API key required (set PULSEMCP_API_KEY)');
    const base = this.opts.baseUrl ?? 'https://api.pulsemcp.com';
    const doFetch = this.opts.fetchImpl ?? fetch;
    const res = await doFetch(new URL('/v0.1/servers', base).toString(), {
      headers: { 'X-API-Key': this.opts.apiKey },
      signal: AbortSignal.timeout(this.opts.timeoutMs ?? 8000),
    });
    if (!res.ok) throw new Error(`pulsemcp: HTTP ${res.status}`);
    const data: any = await res.json();
    return (data?.servers ?? []).map(mapServer);
  }
}
