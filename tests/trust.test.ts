import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assessTrust } from '../src/feed/trust.js';
import type { FeedItem } from '../src/feed/source.js';

const NOW = Date.parse('2026-07-02T00:00:00Z');
const item = (o: Partial<FeedItem>): FeedItem => ({ name: 'x', source: 'r', ...o });

test('assessTrust: deprecated status → caution', () => {
  const t = assessTrust(
    item({ status: 'deprecated', url: 'https://x', updatedAt: '2026-06-01T00:00:00Z' }),
    NOW,
  );
  assert.equal(t.level, 'caution');
  assert.ok(t.reasons.some((r) => /status/.test(r)));
});

test('assessTrust: no repo URL → unknown (can not vet)', () => {
  const t = assessTrust(item({ updatedAt: '2026-06-01T00:00:00Z' }), NOW);
  assert.equal(t.level, 'unknown');
  assert.ok(t.reasons.some((r) => /repository/.test(r)));
});

test('assessTrust: stale (>1yr) → caution', () => {
  const t = assessTrust(item({ url: 'https://x', updatedAt: '2024-01-01T00:00:00Z' }), NOW);
  assert.equal(t.level, 'caution');
  assert.ok(t.reasons.some((r) => /year/.test(r)));
});

test('assessTrust: maintained + has repo → ok', () => {
  const t = assessTrust(item({ status: 'active', url: 'https://x', updatedAt: '2026-06-20T00:00:00Z' }), NOW);
  assert.equal(t.level, 'ok');
});

test('assessTrust: no signals at all → unknown', () => {
  assert.equal(assessTrust(item({}), NOW).level, 'unknown');
});
