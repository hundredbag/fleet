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
