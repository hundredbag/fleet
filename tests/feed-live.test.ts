import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discover } from '../src/feed/feed.js';
import { recommend, defaultScorer } from '../src/feed/recommend.js';
import { McpRegistrySource } from '../src/feed/sources/mcp-registry.js';
import { PulseMcpSource } from '../src/feed/sources/pulsemcp.js';
import type { FeedItem, FeedSource } from '../src/feed/source.js';
import type { Inventory, McpServerCapability, McpServerSpec } from '../src/core/types.js';

function mcp(name: string, agent: string, spec: McpServerSpec): McpServerCapability {
  return { kind: 'mcp-server', name, agent, scope: 'user', enabled: true, spec, source: { file: 'f' } };
}
const inv = (items: McpServerCapability[]): Inventory => ({ agents: [], items });
const src = (id: string, items: FeedItem[]): FeedSource => ({ id, list: async () => items });

// sequential-payload fake fetch (typed loosely for tests)
function mkFetch(payloads: unknown[], ok = true, status = 200): typeof fetch {
  let i = 0;
  return (async () => ({
    ok,
    status,
    json: async () => payloads[Math.min(i++, payloads.length - 1)],
  })) as unknown as typeof fetch;
}

test('discover MERGES fields across sources (registry version + pulse popularity)', async () => {
  const a = src('a', [{ name: 'gh', source: 'a', identifier: '@x/gh', ecosystem: 'npm', version: '2.0.0' }]);
  const b = src('b', [{ name: 'gh', source: 'b', identifier: '@x/gh', ecosystem: 'npm', popularity: 99 }]);
  const { items } = await discover([a, b]);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.version, '2.0.0'); // from a
  assert.equal(items[0]?.popularity, 99); // merged from b
});

test('discover merge: later source fills fields the earlier left undefined (no clobber)', async () => {
  const registry = src('registry', [
    {
      name: 'gh',
      source: 'registry',
      identifier: '@x/gh',
      ecosystem: 'npm',
      version: '2.0.0',
      description: undefined,
      url: undefined,
    },
  ]);
  const pulse = src('pulse', [
    {
      name: 'gh',
      source: 'pulse',
      identifier: '@x/gh',
      ecosystem: 'npm',
      popularity: 50,
      description: 'from pulse',
      url: 'http://p',
    },
  ]);
  const { items } = await discover([registry, pulse]);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.version, '2.0.0'); // registry wins on conflict
  assert.equal(items[0]?.popularity, 50); // filled from pulse
  assert.equal(items[0]?.description, 'from pulse'); // registry's undefined must NOT clobber
  assert.equal(items[0]?.url, 'http://p');
});

test('discover: items with no identifier/url are not collapsed on shared name', async () => {
  const a = src('a', [{ name: 'Memory', source: 'a' }]);
  const b = src('b', [{ name: 'Memory', source: 'b' }]);
  const { items } = await discover([a, b]);
  assert.equal(items.length, 2); // distinct items, same name → kept separate
});

test('recommend: novelty + popularity + relevance, installed filtered, limit', async () => {
  const now = Date.parse('2026-07-01T00:00:00Z');
  const i = inv([
    mcp('github', 'claude-code', { transport: 'stdio', command: 'npx', args: ['-y', '@x/github-tools'] }),
  ]);
  const items: FeedItem[] = [
    {
      name: 'new-thing',
      source: 'r',
      identifier: '@x/new',
      ecosystem: 'npm',
      updatedAt: '2026-06-25T00:00:00Z',
    },
    { name: 'popular', source: 'r', identifier: '@x/pop', ecosystem: 'npm', popularity: 10000 },
    {
      name: 'github helper',
      source: 'r',
      identifier: '@x/gh-helper',
      ecosystem: 'npm',
      description: 'github tools',
    },
    { name: 'installed-dup', source: 'r', identifier: '@x/github-tools', ecosystem: 'npm', version: '9' },
  ];
  const recs = await recommend(i, items, { now, limit: 10 });
  const names = recs.map((r) => r.item.name);
  assert.ok(names.includes('new-thing') && names.includes('popular') && names.includes('github helper'));
  assert.ok(!names.includes('installed-dup')); // already installed → filtered
  assert.ok(recs.find((r) => r.item.name === 'new-thing')?.reasons.includes('new'));
  assert.ok(recs.find((r) => r.item.name === 'github helper')?.reasons.some((x) => /related/.test(x)));
});

test('recommend: scorer is injectable + batch + async (the C/hub seam)', async () => {
  const i = inv([]);
  const items: FeedItem[] = [
    { name: 'a', source: 'r', identifier: '@x/a', ecosystem: 'npm' },
    { name: 'b', source: 'r', identifier: '@x/b', ecosystem: 'npm' },
  ];
  const recs = await recommend(i, items, {
    scorer: (its) => its.map(() => ({ score: 1, reasons: ['injected'] })),
  });
  assert.equal(recs.length, 2);
  assert.equal(recs[0]?.reasons[0], 'injected');
});

test('defaultScorer: no signals → score 0 (below the recommend floor)', () => {
  const [s] = defaultScorer([{ name: 'obscure', source: 'r', identifier: '@x/obscure', ecosystem: 'npm' }], {
    installedTokens: new Set(),
    installedCoords: new Set(),
    agents: [],
    now: Date.parse('2026-07-01T00:00:00Z'),
  });
  assert.equal(s?.score, 0);
});

test('McpRegistrySource: maps servers + follows cursor pagination (fake fetch)', async () => {
  const p1 = {
    servers: [
      {
        name: 'gh',
        description: 'github',
        updated_at: '2026-06-25T00:00:00Z',
        packages: [{ registry_name: 'npm', name: '@x/gh', version: '2.0.0' }],
      },
    ],
    metadata: { next_cursor: 'c1' },
  };
  const p2 = {
    servers: [{ name: 'py', packages: [{ registry_name: 'pypi', name: 'pytool', version: '1.0' }] }],
    metadata: {},
  };
  const source = new McpRegistrySource({ baseUrl: 'http://test', fetchImpl: mkFetch([p1, p2]) });
  const items = await source.list();
  assert.equal(items.length, 2);
  const gh = items.find((i) => i.name === 'gh');
  assert.equal(gh?.identifier, '@x/gh');
  assert.equal(gh?.ecosystem, 'npm');
  assert.equal(gh?.version, '2.0.0');
  assert.equal(items.find((i) => i.name === 'py')?.ecosystem, 'pypi');
});

test('McpRegistrySource: non-OK response throws (discover would catch it)', async () => {
  const source = new McpRegistrySource({ baseUrl: 'http://test', fetchImpl: mkFetch([{}], false, 503) });
  await assert.rejects(source.list(), /503/);
});

test('PulseMcpSource: maps popularity (fake fetch)', async () => {
  const source = new PulseMcpSource({
    baseUrl: 'http://test',
    fetchImpl: mkFetch([
      { servers: [{ name: 'gh', package_name: '@x/gh', package_registry: 'npm', stars: 120 }] },
    ]),
  });
  const items = await source.list();
  assert.equal(items[0]?.popularity, 120);
  assert.equal(items[0]?.ecosystem, 'npm');
});
