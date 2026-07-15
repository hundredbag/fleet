import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { FeedItem, FeedSource } from './source.js';

type SourceFailure = { source: string; error: string };
import { discover } from './feed.js';

/**
 * File-backed TTL cache for feed discovery. Every whats-new used to hit five
 * registries live (~seconds, network-dependent). One-shot CLI processes can't
 * hold a memory cache, so it lives at ~/.fleet/cache/feed.json. `refresh`
 * bypasses; failures are cached WITH the items so the honesty badge survives.
 */

const DEFAULT_TTL_MS = 15 * 60 * 1000;

interface CachedFeed {
  time: number;
  /** which source set produced this (a default-sources cache must not satisfy
   * injected/custom sources, or vice versa) */
  sourceKey: string;
  items: FeedItem[];
  failures: SourceFailure[];
}

function cachePath(fleetHome?: string): string {
  return join(fleetHome ?? join(homedir(), '.fleet'), 'cache', 'feed.json');
}

export async function cachedDiscover(
  sources: FeedSource[],
  opts: { fleetHome?: string; ttlMs?: number; refresh?: boolean } = {},
): Promise<{ items: FeedItem[]; failures: SourceFailure[]; fromCache: boolean }> {
  const p = cachePath(opts.fleetHome);
  const ttl = opts.ttlMs ?? DEFAULT_TTL_MS;
  const sourceKey = sources
    .map((s) => s.id)
    .sort()
    .join(',');

  if (!opts.refresh && existsSync(p)) {
    try {
      const doc = JSON.parse(await readFile(p, 'utf8')) as CachedFeed;
      if (
        doc &&
        typeof doc.time === 'number' &&
        doc.sourceKey === sourceKey &&
        Array.isArray(doc.items) &&
        Array.isArray(doc.failures) &&
        Date.now() - doc.time < ttl
      ) {
        return { items: doc.items, failures: doc.failures, fromCache: true };
      }
    } catch {
      /* corrupt cache → refetch */
    }
  }

  const live = await discover(sources);
  const doc: CachedFeed = { time: Date.now(), sourceKey, items: live.items, failures: live.failures };
  const tmp = `${p}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await mkdir(dirname(p), { recursive: true });
    await writeFile(tmp, JSON.stringify(doc), 'utf8');
    await rename(tmp, p);
  } catch {
    await rm(tmp, { force: true }).catch(() => {}); // exact path — no glob in rm()
    /* cache write failure is not a feed failure */
  }
  return { items: live.items, failures: live.failures, fromCache: false };
}
