import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessTrust } from '../src/feed/trust.js';
import type { FeedItem } from '../src/feed/source.js';

const NOW = Date.parse('2026-07-02T00:00:00Z');
const item = (o: Partial<FeedItem>): FeedItem => ({ name: 'x', source: 'r', ...o });

test('caution: deprecated (case-insensitive) and other lifecycle statuses', () => {
  assert.equal(
    assessTrust(item({ status: 'Deprecated', url: 'https://x', updatedAt: '2026-06-01T00:00:00Z' }), NOW)
      .level,
    'caution',
  );
  assert.equal(
    assessTrust(item({ status: 'archived', url: 'https://x', updatedAt: '2026-06-01T00:00:00Z' }), NOW).level,
    'caution',
  );
});

test('caution: not updated in over a year', () => {
  assert.equal(
    assessTrust(item({ url: 'https://x', updatedAt: '2024-01-01T00:00:00Z' }), NOW).level,
    'caution',
  );
});

test('unknown: no source repository', () => {
  const t = assessTrust(item({ updatedAt: '2026-06-01T00:00:00Z' }), NOW);
  assert.equal(t.level, 'unknown');
  assert.ok(t.reasons.some((r) => /repository/.test(r)));
});

test('unknown: malformed or missing updatedAt is NOT treated as maintained', () => {
  assert.equal(assessTrust(item({ url: 'https://x', updatedAt: 'not-a-date' }), NOW).level, 'unknown');
  assert.equal(assessTrust(item({ url: 'https://x' }), NOW).level, 'unknown');
});

test('no-flags: has a repo and updated within a year (with reasons, not empty)', () => {
  const t = assessTrust(item({ status: 'active', url: 'https://x', updatedAt: '2026-06-20T00:00:00Z' }), NOW);
  assert.equal(t.level, 'no-flags');
  assert.ok(t.reasons.length > 0);
});

test('hub verdict may ESCALATE (clean local + hub caution → caution)', () => {
  const t = assessTrust(
    item({
      url: 'https://x',
      updatedAt: '2026-06-20T00:00:00Z',
      security: { level: 'caution', reasons: ['known CVE'] },
    }),
    NOW,
  );
  assert.equal(t.level, 'caution');
  assert.ok(t.reasons.some((r) => /known CVE/.test(r)));
});

test('hub verdict may NOT downgrade a local caution (unsigned hub cannot mask a red flag)', () => {
  const t = assessTrust(
    item({
      status: 'deprecated',
      url: 'https://x',
      updatedAt: '2026-06-20T00:00:00Z',
      security: { level: 'no-flags', reasons: ['scanned clean'] },
    }),
    NOW,
  );
  assert.equal(t.level, 'caution'); // local caution stands; hub can't clear it
});
