import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  SkillsMpSource,
  ClawHubSource,
  ClaudeSkillsInfoSource,
} from '../src/feed/sources/skill-registries.js';
import { discover } from '../src/feed/feed.js';
import type { FeedSource } from '../src/feed/source.js';

// --- shapes recorded live 2026-07-03 ---
const SKILLSMP_PAGE = {
  skills: [
    {
      id: 'zavelinski-prompt-compression-skills-prompt-compression-skill-md',
      name: 'prompt-compression',
      author: 'Zavelinski',
      description: 'Compress a large blob into the salient parts first.',
      githubUrl: 'https://github.com/Zavelinski/prompt-compression/tree/master/skills/prompt-compression',
      stars: 7,
      updatedAt: '1782789486', // unix seconds as string
    },
  ],
  pagination: {},
};

const CLAWHUB_PAGE = {
  skills: [
    {
      id: 'cml',
      slug: 'skill-vetter',
      displayName: 'Skill Vetter',
      author: 'spclaudehome',
      summary: 'Security-first skill vetting for AI agents.',
      category: 'agent-security',
      parentCategory: 'other',
      downloads: 260138,
      stars: 1242,
      installsAllTime: 11936,
      updatedAt: '2026-02-26T00:30:36.042Z',
      qualityScore: 80,
    },
  ],
  total: 1,
};

const CLAUDESKILLS_PAGE = {
  skills: [
    {
      id: 205,
      slug: 'wordpress-skills',
      name: 'WordPress Skills',
      summary: '26 official WordPress and Automattic skills',
      repo_url: 'https://github.com/WordPress/agent-skills',
      categories: ['dev'],
      stars: 905,
      updated_at: '2026-03-17 06:59:56',
      repo_owner: 'WordPress',
      repo_name: 'agent-skills',
      download_count: 0,
      likes_count: 3,
    },
  ],
  total: 1,
};

function onePageFetch(payload: unknown): typeof fetch {
  let calls = 0;
  return (async () => {
    calls++;
    // page 1 returns the payload; page 2 returns the SAME items → pagedList stops (no new ids)
    return { ok: true, status: 200, json: async () => (calls <= 2 ? payload : { skills: [] }) };
  }) as unknown as typeof fetch;
}

test('SkillsMpSource: maps name/description/github canonical id/unix updatedAt', async () => {
  const items = await new SkillsMpSource({ fetchImpl: onePageFetch(SKILLSMP_PAGE) }).list();
  assert.equal(items.length, 1);
  const it = items[0]!;
  assert.equal(it.kind, 'skill');
  assert.equal(it.identifier, 'Zavelinski/prompt-compression/prompt-compression'); // canonical gh id
  assert.equal(it.url, 'https://github.com/Zavelinski/prompt-compression');
  assert.equal(it.popularity, 7);
  assert.match(it.updatedAt ?? '', /^2026-06-30T/); // 1782789486s → ISO
  assert.ok(it.description?.includes('Compress'));
});

test('ClawHubSource: native category wins; installs → popularity; no URL fabricated', async () => {
  const items = await new ClawHubSource({ fetchImpl: onePageFetch(CLAWHUB_PAGE) }).list();
  const it = items[0]!;
  assert.equal(it.identifier, 'clawhub/spclaudehome/skill-vetter');
  assert.equal(it.category, 'agent-security'); // native, not the keyword classifier
  assert.equal(it.popularity, 11936); // installsAllTime preferred
  assert.equal(it.url, undefined); // no GitHub link in the API → no link
  assert.equal(it.updatedAt, '2026-02-26T00:30:36.042Z');
});

test('ClaudeSkillsInfoSource: repo coords → canonical id; space-date parsed; category from array', async () => {
  const items = await new ClaudeSkillsInfoSource({ fetchImpl: onePageFetch(CLAUDESKILLS_PAGE) }).list();
  const it = items[0]!;
  assert.equal(it.identifier, 'WordPress/agent-skills/wordpress-skills');
  assert.equal(it.category, 'dev');
  assert.equal(it.url, 'https://github.com/WordPress/agent-skills');
  assert.match(it.updatedAt ?? '', /^2026-03-17T06:59:56/);
  assert.equal(it.popularity, 905); // download_count=0 skipped → stars
});

test('cross-registry merge: same canonical id from two registries merges into one item', async () => {
  const a: FeedSource = {
    id: 'skills.sh',
    list: async () => [
      {
        name: 'prompt-compression',
        source: 'skills.sh',
        kind: 'skill',
        identifier: 'Zavelinski/prompt-compression/prompt-compression',
        popularity: 5000,
      },
    ],
  };
  const b = new SkillsMpSource({ fetchImpl: onePageFetch(SKILLSMP_PAGE) });
  const { items } = await discover([a, b]);
  const merged = items.filter((i) => i.kind === 'skill');
  assert.equal(merged.length, 1); // deduped across registries
  assert.equal(merged[0]?.popularity, 5000); // first source wins on conflict
  assert.ok(merged[0]?.description?.includes('Compress')); // filled from SkillsMP
});

test('iso(): 13-digit millisecond epoch is not multiplied again', async () => {
  const page = {
    skills: [
      {
        name: 'x',
        githubUrl: 'https://github.com/a/b/tree/main/skills/x',
        updatedAt: '1782789486000', // milliseconds
      },
    ],
  };
  const items = await new SkillsMpSource({ fetchImpl: onePageFetch(page) }).list();
  assert.match(items[0]?.updatedAt ?? '', /^2026-06-30T/); // NOT year +58000
});

test('SkillsMP: id tail comes from the skill DIRECTORY, so same-named skills in a monorepo stay distinct', async () => {
  const page = {
    skills: [
      { name: 'helper', githubUrl: 'https://github.com/o/mono/tree/main/skills/alpha-helper', stars: 1 },
      { name: 'helper', githubUrl: 'https://github.com/o/mono/tree/main/skills/beta-helper', stars: 1 },
    ],
  };
  const items = await new SkillsMpSource({ fetchImpl: onePageFetch(page) }).list();
  assert.equal(items.length, 2); // directory-based ids do not collide
  assert.deepEqual(items.map((i) => i.identifier).sort(), ['o/mono/alpha-helper', 'o/mono/beta-helper']);
});

test('mappers tolerate malformed payloads (non-array, missing fields)', async () => {
  const bad = { skills: [null, {}, { slug: 7 }, { name: 42 }] };
  assert.deepEqual(await new SkillsMpSource({ fetchImpl: onePageFetch(bad) }).list(), []);
  assert.deepEqual(await new ClawHubSource({ fetchImpl: onePageFetch(bad) }).list(), []);
  assert.deepEqual(await new ClaudeSkillsInfoSource({ fetchImpl: onePageFetch(bad) }).list(), []);
  const notArray = { skills: 'nope' };
  assert.deepEqual(await new ClawHubSource({ fetchImpl: onePageFetch(notArray) }).list(), []);
});

test('defaultSources: the three registries are on by default', async () => {
  const { defaultSources } = await import('../src/feed/index.js');
  const { DEFAULT_CONFIG } = await import('../src/core/config.js');
  const ids = defaultSources({ ...DEFAULT_CONFIG }).map((s) => s.id);
  // clawhub deliberately absent: clawhub-skills.com 403s Node's TLS fingerprint
  for (const id of ['skills.sh', 'skillsmp', 'claudeskills', 'plugin-markets'])
    assert.ok(ids.includes(id), id);
  assert.ok(!ids.includes('clawhub'));
});

test('pagedList: page-1 failure throws (one discover failure); later-page failure keeps partial', async () => {
  const failAll = (async () => ({
    ok: false,
    status: 500,
    json: async () => ({}),
  })) as unknown as typeof fetch;
  await assert.rejects(new ClawHubSource({ fetchImpl: failAll }).list(), /HTTP 500/);

  let calls = 0;
  const failLater = (async () => {
    calls++;
    if (calls === 1) return { ok: true, status: 200, json: async () => CLAWHUB_PAGE };
    return { ok: false, status: 500, json: async () => ({}) };
  }) as unknown as typeof fetch;
  const items = await new ClawHubSource({ fetchImpl: failLater }).list();
  assert.equal(items.length, 1); // page 1 kept
});
