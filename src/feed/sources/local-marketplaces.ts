import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { FeedItem, FeedSource } from '../source.js';
import { defaultClassifier, type Classifier } from '../classify.js';

/**
 * Vendor-plugin discovery from LOCALLY MIRRORED marketplace catalogs. Claude
 * Code clones each registered marketplace to disk
 * (~/.claude/plugins/marketplaces/<name>/.claude-plugin/marketplace.json) — a
 * local mirror of PUBLIC catalog metadata, so reading it keeps the feed
 * boundary intact and works offline. Codex's snapshot is not read yet (shape
 * unverified). Items carry the `plugin@marketplace` selector as identifier —
 * install goes through the delegated vendor-CLI path (fleet plugin install).
 */
export class LocalMarketplacesSource implements FeedSource {
  readonly id = 'plugin-markets';
  constructor(
    private readonly pluginsDir: string = join(homedir(), '.claude', 'plugins'),
    private readonly classifier: Classifier = defaultClassifier,
  ) {}

  async list(): Promise<FeedItem[]> {
    let markets: Record<string, { installLocation?: unknown }>;
    try {
      markets = JSON.parse(await readFile(join(this.pluginsDir, 'known_marketplaces.json'), 'utf8'));
    } catch {
      return []; // no marketplaces registered → nothing to discover (not a failure)
    }
    const out: FeedItem[] = [];
    for (const [market, info] of Object.entries(markets)) {
      if (typeof info?.installLocation !== 'string') continue;
      let manifest: { plugins?: unknown };
      try {
        manifest = JSON.parse(
          await readFile(join(info.installLocation, '.claude-plugin', 'marketplace.json'), 'utf8'),
        );
      } catch {
        continue;
      }
      if (!Array.isArray(manifest.plugins)) continue;
      for (const p of manifest.plugins) {
        const name = (p as { name?: unknown })?.name;
        if (typeof name !== 'string' || !name) continue;
        const desc = (p as { description?: unknown })?.description;
        const item: FeedItem = {
          name: name.slice(0, 200),
          source: 'plugin-markets',
          kind: 'plugin',
          identifier: `${name}@${market}`,
          description: typeof desc === 'string' ? desc.slice(0, 500) : undefined,
        };
        item.category = this.classifier(item);
        out.push(item);
      }
    }
    return out;
  }
}
