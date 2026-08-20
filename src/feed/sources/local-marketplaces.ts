import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { FeedItem, FeedSource } from '../source.js';
import { defaultClassifier, type Classifier } from '../classify.js';
import { pluginCoordinate } from '../../core/plugin-coordinate.js';

async function readRegularFileNoFollow(path: string): Promise<string> {
  const before = await lstat(path);
  if (before.isSymbolicLink() || !before.isFile()) throw new Error('not a regular catalog file');
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const handle = await open(path, constants.O_RDONLY | noFollow);
  try {
    const after = await handle.stat();
    if (!after.isFile()) throw new Error('not a regular catalog file');
    return await handle.readFile('utf8');
  } finally {
    await handle.close();
  }
}

async function containedManifest(root: string, installLocation: string): Promise<string | null> {
  const loc = resolve(installLocation);
  const rel = relative(root, loc);
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return null;

  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return null;
  const rootReal = await realpath(root);
  const locReal = await realpath(loc);
  if (locReal !== rootReal && !locReal.startsWith(rootReal + sep)) return null;

  const manifest = join(loc, '.claude-plugin', 'marketplace.json');
  // No component below marketplaces/ may redirect the read. This rejects
  // leaf and intermediate symlinks even when their realpath happens to land
  // back inside the root, keeping the local/private boundary unambiguous.
  let current = root;
  const components = relative(root, manifest).split(sep);
  for (let index = 0; index < components.length; index++) {
    current = join(current, components[index]!);
    const info = await lstat(current);
    if (info.isSymbolicLink()) return null;
    if (index < components.length - 1 ? !info.isDirectory() : !info.isFile()) return null;
  }
  const manifestReal = await realpath(manifest);
  if (!manifestReal.startsWith(rootReal + sep)) return null;
  return manifest;
}

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
      markets = JSON.parse(await readRegularFileNoFollow(join(this.pluginsDir, 'known_marketplaces.json')));
    } catch {
      return []; // no marketplaces registered → nothing to discover (not a failure)
    }
    if (!markets || typeof markets !== 'object' || Array.isArray(markets)) return [];
    const out: FeedItem[] = [];
    const allowedRoot = resolve(this.pluginsDir, 'marketplaces');
    for (const [market, info] of Object.entries(markets)) {
      if (typeof info?.installLocation !== 'string') continue;
      let manifest: { plugins?: unknown };
      try {
        const path = await containedManifest(allowedRoot, info.installLocation);
        if (!path) continue;
        manifest = JSON.parse(await readRegularFileNoFollow(path));
      } catch {
        continue;
      }
      if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.plugins)) continue;
      for (const p of manifest.plugins) {
        const name = (p as { name?: unknown })?.name;
        if (typeof name !== 'string' || !name) continue;
        let coordinate;
        try {
          coordinate = pluginCoordinate(name, market);
        } catch {
          continue;
        }
        const desc = (p as { description?: unknown })?.description;
        const item: FeedItem = {
          name: coordinate.name,
          source: 'plugin-markets',
          kind: 'plugin',
          identifier: coordinate.selector,
          description: typeof desc === 'string' ? desc.slice(0, 500) : undefined,
        };
        item.category = this.classifier(item);
        out.push(item);
      }
    }
    return out;
  }
}
