import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { chmod, lstat, readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { FeedItem, FeedSource } from './source.js';
import { cleanPublicSource, sanitizeFeedItems } from './sanitize.js';
import { fleetHomeDir } from '../core/config.js';

type SourceFailure = { source: string; code: 'SOURCE_UNAVAILABLE' };
import { discover } from './feed.js';

/**
 * File-backed TTL cache for feed discovery. Every whats-new used to hit five
 * registries live (~seconds, network-dependent). One-shot CLI processes can't
 * hold a memory cache, so it lives at ~/.fleet/cache/feed.json. `refresh`
 * bypasses; failures are cached WITH the items so the honesty badge survives.
 */

const DEFAULT_TTL_MS = 15 * 60 * 1000;

interface CachedFeed {
  version: 2;
  time: number;
  /** which source set produced this (a default-sources cache must not satisfy
   * injected/custom sources, or vice versa) */
  sourceKey: string;
  items: FeedItem[];
  failures: SourceFailure[];
  withheld: number;
}

function cachePath(fleetHome?: string): string {
  return join(fleetHomeDir(fleetHome), 'cache', 'feed.json');
}

function safeFailures(values: unknown): SourceFailure[] {
  return Array.isArray(values)
    ? values.flatMap((failure) => {
        const source = cleanPublicSource((failure as { source?: unknown } | null)?.source);
        return source ? [{ source, code: 'SOURCE_UNAVAILABLE' as const }] : [];
      })
    : [];
}

async function writeCacheFile(path: string, doc: CachedFeed): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const dir = dirname(path);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const dirInfo = await lstat(dir);
    if (dirInfo.isSymbolicLink() || !dirInfo.isDirectory()) throw new Error('unsafe cache directory');
    await chmod(dir, 0o700);
    await writeFile(tmp, JSON.stringify(doc), { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, path);
    await chmod(path, 0o600);
  } catch {
    await rm(tmp, { force: true }).catch(() => {});
    // Cache persistence is best-effort and never becomes a feed failure.
  }
}

export async function cachedDiscover(
  sources: FeedSource[],
  opts: { fleetHome?: string; ttlMs?: number; refresh?: boolean } = {},
): Promise<{ items: FeedItem[]; failures: SourceFailure[]; withheld: number; fromCache: boolean }> {
  const p = cachePath(opts.fleetHome);
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const sourceKey = sources
    .map((s) => s.id)
    .sort()
    .join(',');

  if (!opts.refresh && existsSync(p)) {
    try {
      const info = await lstat(p);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error('unsafe cache file');
      const doc = JSON.parse(await readFile(p, 'utf8')) as CachedFeed;
      if (
        doc &&
        doc.version === 2 &&
        typeof doc.time === 'number' &&
        doc.sourceKey === sourceKey &&
        Array.isArray(doc.items) &&
        Array.isArray(doc.failures) &&
        Date.now() - doc.time < ttl
      ) {
        const safeItems = sanitizeFeedItems(doc.items);
        const priorWithheld = Number.isSafeInteger(doc.withheld) && doc.withheld >= 0 ? doc.withheld : 0;
        const safe: CachedFeed = {
          version: 2,
          time: doc.time,
          sourceKey,
          items: safeItems,
          failures: safeFailures(doc.failures),
          withheld: priorWithheld + (doc.items.length - safeItems.length),
        };
        // Migrate legacy 0644 caches and raw failures in place on the first
        // valid hit, not only after a refresh/expiry.
        await writeCacheFile(p, safe);
        return { items: safe.items, failures: safe.failures, withheld: safe.withheld, fromCache: true };
      }
    } catch {
      /* corrupt cache → refetch */
    }
  }

  const live = await discover(sources);
  const doc: CachedFeed = {
    version: 2,
    time: Date.now(),
    sourceKey,
    items: live.items,
    failures: live.failures,
    withheld: live.withheld,
  };
  await writeCacheFile(p, doc);
  return { items: live.items, failures: live.failures, withheld: live.withheld, fromCache: false };
}
