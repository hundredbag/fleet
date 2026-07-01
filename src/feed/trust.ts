import type { FeedItem } from './source.js';

/**
 * A pre-install trust/quality signal for a feed item. HEURISTIC, from public
 * registry metadata only (lifecycle status, maintenance recency, whether a
 * source repo is listed) — NOT a security audit.
 *
 * A hub-provided `item.security` verdict is treated as ADVISORY and may only
 * make the result MORE cautious — never downgrade a local red flag. (The hub is
 * remote and, until feed signing lands, unauthenticated; a compromised/MITM'd
 * hub must not be able to clear a genuine local caution.)
 *
 * Levels: 'caution' = a red flag (deprecated / unmaintained / hub-flagged);
 * 'unknown' = can't vet (no repo, or unknown freshness); 'no-flags' = nothing
 * bad found — deliberately NOT "ok"/"safe", only the absence of flags.
 */
export interface TrustAssessment {
  level: 'caution' | 'no-flags' | 'unknown';
  reasons: string[];
}

const SEVERITY: Record<TrustAssessment['level'], number> = { 'no-flags': 0, unknown: 1, caution: 2 };
const STALE_DAYS = 365;

/** The local, metadata-only assessment. */
function localAssess(item: FeedItem, now: number): TrustAssessment {
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

/** A validated hub verdict, or null. */
function hubVerdict(security: unknown): TrustAssessment | null {
  const s = security as { level?: unknown; reasons?: unknown } | undefined;
  if (!s || typeof s !== 'object' || typeof s.level !== 'string') return null;
  if (s.level !== 'caution' && s.level !== 'no-flags' && s.level !== 'unknown') return null;
  const reasons = Array.isArray(s.reasons) ? s.reasons.filter((r): r is string => typeof r === 'string') : [];
  return { level: s.level, reasons };
}

export function assessTrust(item: FeedItem, now: number = Date.now()): TrustAssessment {
  const local = localAssess(item, now);
  const hub = hubVerdict(item.security);
  if (!hub) return local;
  // Hub is advisory: it may only ESCALATE severity, never downgrade.
  if (SEVERITY[hub.level] > SEVERITY[local.level]) {
    return { level: hub.level, reasons: [...hub.reasons.map((r) => `hub: ${r}`), ...local.reasons] };
  }
  return { level: local.level, reasons: [...local.reasons, ...hub.reasons.map((r) => `hub: ${r}`)] };
}
