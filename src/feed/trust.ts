import type { FeedItem } from './source.js';

/**
 * A pre-install trust/quality signal for a feed item. HEURISTIC and based only
 * on public registry metadata (lifecycle status, maintenance recency, whether a
 * source repo is listed, popularity) — NOT a security audit. Real security /
 * quality scoring is the central hub's job (it can run scanners); this is the
 * offline floor so the user/AI sees an obvious "caution" before installing.
 */
export interface TrustAssessment {
  level: 'ok' | 'caution' | 'unknown';
  reasons: string[];
}

const STALE_DAYS = 365;

export function assessTrust(item: FeedItem, now: number = Date.now()): TrustAssessment {
  // caution = a known red flag on a known item (deprecated / unmaintained);
  const reasons: string[] = [];
  let caution = false;
  if (item.status && /deprecat|delet|inactive|archiv/i.test(item.status)) {
    caution = true;
    reasons.push(`registry status: ${item.status}`);
  }
  if (item.updatedAt) {
    const days = (now - Date.parse(item.updatedAt)) / 86_400_000;
    if (days > STALE_DAYS) {
      caution = true;
      reasons.push('not updated in over a year');
    }
  }
  if (caution) return { level: 'caution', reasons };

  // unknown = we can't vet it (no source repo to inspect); ok = looks maintained.
  if (!item.url) return { level: 'unknown', reasons: ['no source repository listed'] };
  return { level: 'ok', reasons };
}
