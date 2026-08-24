import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SkillsShSource } from '../src/feed/sources/skills-sh.js';
import { defaultClassifier } from '../src/feed/classify.js';
import { recommend } from '../src/feed/recommend.js';
import type { FeedItem } from '../src/feed/source.js';
import type { Inventory, SkillCapability } from '../src/core/types.js';

// shape recorded live from https://skills.sh/api/search?q=git (2026-07-02)
const REAL_PAYLOAD = {
  query: 'git',
  searchType: 'fuzzy',
  skills: [
    {
      id: 'github/awesome-copilot/git-commit',
      skillId: 'git-commit',
      name: 'git-commit',
      installs: 37501,
      source: 'github/awesome-copilot',
    },
    {
      id: 'mattpocock/skills/git-guardrails-claude-code',
      skillId: 'git-guardrails-claude-code',
      name: 'git-guardrails-claude-code',
      installs: 89770,
      source: 'mattpocock/skills',
    },
  ],
};

function mkFetch(payloadFor: (url: string) => unknown, ok = true, status = 200): typeof fetch {
  return (async (url: string) => ({
    ok,
    status,
    json: async () => payloadFor(String(url)),
  })) as unknown as typeof fetch;
}

test('SkillsShSource.search: maps the real shape (installs→popularity, repo URL, category)', async () => {
  const s = new SkillsShSource({ baseUrl: 'http://t', fetchImpl: mkFetch(() => REAL_PAYLOAD) });
  const items = await s.search('git');
  assert.equal(items.length, 2);
  const gc = items.find((i) => i.name === 'git-commit');
  assert.equal(gc?.kind, 'skill');
  assert.equal(gc?.identifier, 'github/awesome-copilot/git-commit');
  assert.equal(gc?.popularity, 37501);
  assert.equal(gc?.url, 'https://github.com/github/awesome-copilot');
  assert.equal(gc?.category, 'git/vcs');
});

test('SkillsShSource.list: seed sweep merges + dedupes; tolerates partial seed failure', async () => {
  let calls = 0;
  const fetchImpl = (async (url: string) => {
    calls++;
    if (String(url).includes('q=fail')) return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => REAL_PAYLOAD }; // same 2 skills each seed
  }) as unknown as typeof fetch;
  const s = new SkillsShSource({ baseUrl: 'http://t', fetchImpl, seeds: ['git', 'fail', 'test'] });
  const items = await s.list();
  assert.equal(items.length, 2); // deduped by id across seeds; failed seed skipped
  assert.equal(calls, 3);
});

test('SkillsShSource.list: throws only when ALL seeds fail (discover catches it)', async () => {
  const s = new SkillsShSource({
    baseUrl: 'http://t',
    fetchImpl: mkFetch(() => ({}), false, 503),
    seeds: ['aa', 'bb'],
  });
  await assert.rejects(s.list(), /all seed queries failed/);
});

test('defaultClassifier: keyword buckets + other fallback', () => {
  const item = (name: string): FeedItem => ({ name, source: 't', kind: 'skill' });
  assert.equal(defaultClassifier(item('git-commit-helper')), 'git/vcs');
  assert.equal(defaultClassifier(item('postgres-query-tuner')), 'data/db');
  assert.equal(defaultClassifier(item('deploy-to-kubernetes')), 'devops/cloud');
  assert.equal(defaultClassifier(item('mysterious-thing')), 'other');
  // stems must match suffixed forms (regression: trailing \b broke these)
  assert.equal(defaultClassifier(item('security-scanner')), 'security');
  assert.equal(defaultClassifier(item('vulnerability-check')), 'security');
  assert.equal(defaultClassifier(item('unit-testing-helper')), 'testing');
  // 'author' must NOT read as security
  assert.notEqual(defaultClassifier(item('author-bio-writer')), 'security');
});

test('mapSkill hardening: malformed entries skipped; hostile source gets no URL', async () => {
  const payload = {
    skills: [
      null,
      {},
      { id: 1, name: 'bad-id' },
      { id: 'a/b/ok', name: 'ok', installs: 5, source: 'anthropics/skills/../../evil' }, // path traversal
      { id: 'a/b/ok2', name: 'ok2', installs: 5, source: 'https://evil.com/x' }, // full URL
      { id: 'a/b/ok3', skillId: {}, source: 'good/repo' }, // non-string skillId → falls back to id
      { id: 'a/b/ok4', name: 'ok4', source: 'other/repo' }, // valid-looking but mismatched repo
    ],
  };
  const s = new SkillsShSource({
    baseUrl: 'http://t',
    fetchImpl: (async () => ({
      ok: true,
      status: 200,
      json: async () => payload,
    })) as unknown as typeof fetch,
  });
  const items = await s.search('xx');
  assert.equal(items.length, 4); // null/{}/bad-id skipped
  assert.equal(items.find((i) => i.name === 'ok')?.url, undefined); // traversal source → no URL
  assert.equal(items.find((i) => i.name === 'ok2')?.url, undefined); // full-URL source → no URL
  assert.equal(items.find((i) => i.identifier === 'a/b/ok3')?.name, 'a/b/ok3'); // safe fallback
  assert.equal(items.find((i) => i.name === 'ok4')?.url, undefined); // review URL cannot diverge from id
});

test('diversifyByCategory: round-robin, preserves order, terminates when limit > total', async () => {
  const { diversifyByCategory } = await import('../src/feed/recommend.js');
  const rec = (name: string, category: string, score: number) => ({
    item: { name, source: 't', kind: 'skill' as const, category },
    score,
    reasons: [],
    trust: { level: 'unknown' as const, reasons: [] },
  });
  const recs = [
    rec('a1', 'git/vcs', 9),
    rec('a2', 'git/vcs', 8),
    rec('b1', 'data/db', 7),
    rec('c1', 'other', 6),
  ];
  const out = diversifyByCategory(recs, 3);
  assert.deepEqual(
    out.map((r) => r.item.name),
    ['a1', 'b1', 'c1'],
  ); // one per category first
  assert.equal(diversifyByCategory(recs, 99).length, 4); // limit > total terminates
  assert.equal(diversifyByCategory([], 5).length, 0);
});

test('recommend: an installed skill (by name) is not recommended again', async () => {
  const installed: SkillCapability = {
    kind: 'skill',
    name: 'git-commit',
    agent: 'claude-code',
    scope: 'user',
    enabled: true,
    path: '/x',
    source: { file: 'f' },
  };
  const inv: Inventory = { agents: [], items: [installed] };
  const items: FeedItem[] = [
    { name: 'git-commit', source: 'skills.sh', kind: 'skill', identifier: 'a/b/git-commit', popularity: 999 },
    { name: 'new-skill', source: 'skills.sh', kind: 'skill', identifier: 'a/b/new-skill', popularity: 999 },
  ];
  const recs = await recommend(inv, items, { limit: 10 });
  const names = recs.map((r) => r.item.name);
  assert.ok(!names.includes('git-commit')); // already installed → filtered
  assert.ok(names.includes('new-skill'));
});
