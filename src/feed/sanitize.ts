import type { FeedItem } from './source.js';
import { containsNonPublicLocalReference, isPublicCapabilityName } from '../core/redact.js';

// Registry metadata is rendered in terminals, browsers, and AI contexts. Strip
// control/format characters (including ANSI/OSC and bidi isolates), normalize
// whitespace, and cap every remote text field before it reaches those faces.
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/g;
const IDENTIFIER = /^[@a-z0-9][@a-z0-9._~+/-]{0,199}$/i;
const SOURCE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const VERSION = /^[a-z0-9][a-z0-9.+_-]{0,63}$/i;
const SENSITIVE_QUERY = /(token|key|secret|auth|sig|password|pwd|credential|session|bearer)/i;

export function cleanPublicText(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const clean = value.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim();
  return clean ? clean.slice(0, max) : undefined;
}

/** Identity fields are either preserved exactly or rejected, never truncated. */
function cleanPublicIdentity(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) return undefined;
  if (value.replace(CONTROL, '') !== value || value !== value.trim()) return undefined;
  return value;
}

export function cleanPublicSource(value: unknown): string | undefined {
  const clean = cleanPublicIdentity(value, 64);
  return clean && SOURCE_ID.test(clean) ? clean : undefined;
}

function cleanIdentifier(value: unknown): string | undefined {
  const clean = cleanPublicIdentity(value, 200);
  if (
    !clean ||
    !IDENTIFIER.test(clean) ||
    clean.includes('..') ||
    clean.includes('//') ||
    clean.startsWith('/') ||
    clean.startsWith('-') ||
    clean.endsWith('/') ||
    containsNonPublicLocalReference(clean)
  ) {
    return undefined;
  }
  return clean;
}

function cleanUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    if ([...url.searchParams.keys()].some((key) => SENSITIVE_QUERY.test(key))) return undefined;
    url.hash = '';
    const clean = url.toString();
    return clean.length <= 500 ? clean : undefined;
  } catch {
    return undefined;
  }
}

function cleanTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

function cleanSecurity(value: unknown): unknown {
  if (!value || typeof value !== 'object') return undefined;
  const level = (value as { level?: unknown }).level;
  return level === 'caution' || level === 'no-flags' || level === 'unknown' ? { level } : undefined;
}

export function sanitizeFeedItem(value: unknown): FeedItem | null {
  if (!value || typeof value !== 'object') return null;
  const item = value as Record<string, unknown>;
  const name = cleanPublicIdentity(item.name, 120);
  const source = cleanPublicSource(item.source);
  const category = cleanPublicText(item.category, 40);
  const description = cleanPublicText(item.description, 500);
  if (
    !name ||
    !source ||
    !isPublicCapabilityName(name) ||
    containsNonPublicLocalReference(category) ||
    containsNonPublicLocalReference(description)
  )
    return null;
  const kind =
    item.kind === 'mcp-server' || item.kind === 'skill' || item.kind === 'plugin' ? item.kind : undefined;
  const ecosystem =
    item.ecosystem === 'npm' || item.ecosystem === 'pypi' || item.ecosystem === 'other'
      ? item.ecosystem
      : undefined;
  const version = cleanPublicIdentity(item.version, 64);
  const popularity =
    typeof item.popularity === 'number' && Number.isSafeInteger(item.popularity) && item.popularity >= 0
      ? item.popularity
      : undefined;
  const cautiousStatus =
    typeof item.status === 'string' &&
    (item.status === 'caution' || /deprecat|delet|inactive|archiv/i.test(item.status))
      ? 'caution'
      : undefined;
  const identifier = cleanIdentifier(item.identifier);
  if (
    (item.identifier !== undefined && !identifier) ||
    (item.version !== undefined && (!version || !VERSION.test(version)))
  ) {
    return null;
  }
  return {
    name,
    source,
    ...(kind ? { kind } : {}),
    ...(category ? { category } : {}),
    ...(identifier ? { identifier } : {}),
    ...(ecosystem ? { ecosystem } : {}),
    ...(version && VERSION.test(version) ? { version } : {}),
    ...(cleanUrl(item.url) ? { url: cleanUrl(item.url) } : {}),
    ...(description ? { description } : {}),
    ...(cleanTimestamp(item.updatedAt) ? { updatedAt: cleanTimestamp(item.updatedAt) } : {}),
    ...(popularity !== undefined ? { popularity } : {}),
    ...(cautiousStatus ? { status: cautiousStatus } : {}),
    ...(cleanSecurity(item.security) ? { security: cleanSecurity(item.security) } : {}),
  };
}

export function sanitizeFeedItems(values: unknown): FeedItem[] {
  return Array.isArray(values)
    ? values.flatMap((value) => {
        const item = sanitizeFeedItem(value);
        return item ? [item] : [];
      })
    : [];
}
