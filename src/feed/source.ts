/**
 * The discovery-feed seam. A FeedSource produces ONLY public capability
 * metadata (from a registry, or — later — the central hub). It is NEVER handed
 * the user's inventory; "updates to mine" matching is a separate LOCAL step
 * (feed.ts) that takes inventory + items as inputs. This is the structural
 * local↔hub boundary: sources are public-data-out only.
 */

export interface FeedItem {
  /** display name */
  name: string;
  /** which source produced it (e.g. 'mcp-registry', 'hub') */
  source: string;
  /** package coordinate used for matching (e.g. '@modelcontextprotocol/server-github') */
  identifier?: string;
  ecosystem?: 'npm' | 'pypi' | 'other';
  version?: string;
  url?: string;
  description?: string;
  /** RFC3339 */
  updatedAt?: string;
  popularity?: number;
  /** placeholder for the M6 trust/quality layer */
  security?: unknown;
}

export interface FeedSource {
  readonly id: string;
  list(opts?: { since?: string }): Promise<FeedItem[]>;
}
