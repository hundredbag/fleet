import type { FeedItem } from './source.js';

/**
 * A pre-install trust/quality signal for a feed item. HEURISTIC, from public
 * registry metadata only (lifecycle status, maintenance recency, whether a
 * source repo is listed) — NOT a security audit. When the central hub supplies a
 * real verdict on `item.security`, THAT is authoritative and this defers to it.
 *
 * Levels: 'caution' = a red flag (deprecated / unmaintained); 'unknown' = can't
 * vet (no repo, or unknown freshness); 'no-flags' = nothing bad found (has a
 * repo, updated within a year) — deliberately NOT called "ok"/"safe", because it
 * is only the absence of flags, never an endorsement.
 */
export interface TrustAssessment {
  level: 'caution' | 'no-flags' | 'unknown';
  reasons: string[];
}

interface HubSecurity {
  level?: unknown;
  reasons?: unknown;
}

const STALE_DAYS = 365;

export function assessTrust(item: FeedItem, now: number = Date.now()): TrustAssessment {
  // Hub-provided verdict is authoritative when present (the "C" seam).
  const sec = item.security as HubSecurity | undefined;
  if (sec && typeof sec === 'object' && typeof sec.level === 'string') {
    const level =
      sec.level === 'caution' || sec.level === 'no-flags' || sec.level === 'unknown' ? sec.level : 'unknown';
    const reasons = Array.isArray(sec.reasons)
      ? sec.reasons.filter((r): r is string => typeof r === 'string')
      : ['from hub'];
    return { level, reasons };
  }

  const reasons: string[] = [];
  let caution = false;
  if (item.status && /deprecat|delet|inactive|archiv/i.test(item.status)) {
    caution = true;
    reasons.push(`registry status: ${item.status}`);
  }
  const parsed = item.updatedAt ? Date.parse(item.updatedAt) : NaN;
  const freshKnown = !Number.isNaN(parsed);
  if (freshKnown && (now - parsed) / 86_400_000 > STALE_DAYS) {
    caution = true;
    reasons.push('not updated in over a year');
  }
  if (caution) return { level: 'caution', reasons };

  if (!item.url) return { level: 'unknown', reasons: ['no source repository listed'] };
  if (!freshKnown) return { level: 'unknown', reasons: ['update recency unknown'] };
  return {
    level: 'no-flags',
    reasons: ['no red flags: has a source repo, updated within a year (heuristic — not a security audit)'],
  };
}
