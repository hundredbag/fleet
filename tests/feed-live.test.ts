import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discover, updatesForInventory } from '../src/feed/feed.js';
import { recommend, defaultScorer } from '../src/feed/recommend.js';
import { McpRegistrySource } from '../src/feed/sources/mcp-registry.js';
import { PulseMcpSource } from '../src/feed/sources/pulsemcp.js';
import { FleetHubSource } from '../src/feed/sources/hub.js';
import { defaultSources, feedSourceEnabled } from '../src/feed/index.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
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
      url: 'https://pulse.example/item',
    },
  ]);
  const { items } = await discover([registry, pulse]);
  assert.equal(items.length, 1);
  assert.equal(items[0]?.version, '2.0.0'); // registry wins on conflict
  assert.equal(items[0]?.popularity, 50); // filled from pulse
  assert.equal(items[0]?.description, 'from pulse'); // registry's undefined must NOT clobber
  assert.equal(items[0]?.url, 'https://pulse.example/item');
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

test('recommendation context excludes permission command and path tokens', async () => {
  const inventory: Inventory = {
    agents: [],
    items: [
      {
        kind: 'permission',
        name: 'Bash(cat /home/alice/velvetquasar)',
        agent: 'claude-code',
        scope: 'user',
        enabled: true,
        effect: 'allow',
        source: { file: '/private/settings.json' },
      },
    ],
  };
  const recs = await recommend(inventory, [{ name: 'velvetquasar helper', source: 'registry' }]);
  assert.deepEqual(recs, []);
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

test('McpRegistrySource: maps the real {server,_meta} shape + nextCursor + skips non-latest', async () => {
  const META = 'io.modelcontextprotocol.registry/official';
  const p1 = {
    servers: [
      {
        server: {
          name: 'ai.adeu/adeu',
          title: 'adeu',
          description: 'a tool',
          version: '1.5.2',
          packages: [{ registryType: 'pypi', identifier: 'adeu', version: '1.5.2' }],
          repository: { url: 'https://github.com/x/adeu' },
        },
        _meta: { [META]: { updatedAt: '2026-05-01T00:00:00Z', isLatest: true } },
      },
    ],
    metadata: { nextCursor: 'c1' },
  };
  const p2 = {
    servers: [
      // remote-only server (no package → no coordinate) + a superseded version that must be skipped
      {
        server: {
          name: 'ac/mcp',
          title: 'inf',
          remotes: [{ type: 'streamable-http', url: 'https://x/mcp' }],
        },
        _meta: { [META]: { updatedAt: '2026-04-01T00:00:00Z', isLatest: true } },
      },
      {
        server: {
          name: 'old/thing',
          version: '0.9.0',
          packages: [{ registryType: 'npm', identifier: '@old/thing', version: '0.9.0' }],
        },
        _meta: { [META]: { isLatest: false } },
      },
    ],
    metadata: {},
  };
  const source = new McpRegistrySource({ baseUrl: 'http://test', fetchImpl: mkFetch([p1, p2]) });
  const items = await source.list();
  assert.equal(items.length, 2); // adeu + inf; old/thing skipped (isLatest:false)
  const adeu = items.find((i) => i.name === 'adeu');
  assert.equal(adeu?.identifier, 'adeu');
  assert.equal(adeu?.ecosystem, 'pypi');
  assert.equal(adeu?.version, '1.5.2');
  assert.equal(adeu?.updatedAt, '2026-05-01T00:00:00Z');
  assert.equal(adeu?.url, 'https://github.com/x/adeu');
  const inf = items.find((i) => i.name === 'inf');
  assert.equal(inf?.identifier, undefined); // remote-only → no install coordinate
  assert.equal(inf?.url, 'https://x/mcp');
  assert.ok(!items.some((i) => i.name === 'old/thing'));
});

test('McpRegistrySource: emits one FeedItem per package (multi-package server)', async () => {
  const META = 'io.modelcontextprotocol.registry/official';
  const p = {
    servers: [
      {
        server: {
          name: 'x/y',
          title: 'y',
          version: '2.0.0',
          packages: [
            { registryType: 'npm', identifier: '@x/y', version: '2.0.0' },
            { registryType: 'pypi', identifier: 'x-y', version: '2.0.1' },
          ],
        },
        _meta: { [META]: { isLatest: true } },
      },
    ],
    metadata: {},
  };
  const source = new McpRegistrySource({ baseUrl: 'http://t', fetchImpl: mkFetch([p]) });
  const items = await source.list();
  assert.equal(items.length, 2);
  assert.equal(items.find((i) => i.ecosystem === 'npm')?.version, '2.0.0');
  assert.equal(items.find((i) => i.ecosystem === 'pypi')?.identifier, 'x-y');
  assert.equal(items.find((i) => i.ecosystem === 'pypi')?.version, '2.0.1'); // package's own version
});

test('updatesForInventory: PyPI names normalize (_ ↔ -)', () => {
  const i = inv([mcp('sp', 'codex', { transport: 'stdio', command: 'uvx', args: ['some_package@1.0.0'] })]);
  const items: FeedItem[] = [
    { name: 'sp', source: 'r', identifier: 'some-package', ecosystem: 'pypi', version: '2.0.0' },
  ];
  const { updates } = updatesForInventory(i, items);
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.available, '2.0.0');
});

test('McpRegistrySource: non-OK response throws (discover would catch it)', async () => {
  const source = new McpRegistrySource({ baseUrl: 'http://test', fetchImpl: mkFetch([{}], false, 503) });
  await assert.rejects(source.list(), /503/);
});

test('FleetHubSource: maps enriched hub items (accepts {items} or a bare array)', async () => {
  const payload = {
    items: [
      {
        name: 'H',
        identifier: '@h/x',
        ecosystem: 'npm',
        version: '1.0.0',
        popularity: 5,
        security: { level: 'no-flags' },
      },
    ],
  };
  const s = new FleetHubSource('http://hub', { fetchImpl: mkFetch([payload]) });
  const items = await s.list();
  assert.equal(items.length, 1);
  assert.equal(items[0]?.source, 'hub');
  assert.equal(items[0]?.identifier, '@h/x');
  assert.equal(items[0]?.popularity, 5);
});

test('FleetHubSource: accepts a bare array and tolerates a malformed response', async () => {
  const bare = [{ name: 'A', identifier: '@a/a', ecosystem: 'npm' }, 1, null, 'x'];
  const s1 = new FleetHubSource('http://hub', { fetchImpl: mkFetch([bare]) });
  const items = await s1.list();
  assert.equal(items.length, 4); // non-object elements degrade to defaults, no throw
  assert.equal(items[0]?.identifier, '@a/a');
  // non-array body → []
  const s2 = new FleetHubSource('http://hub', { fetchImpl: mkFetch([{ nope: true }]) });
  assert.deepEqual(await s2.list(), []);
});

test('FleetHubSource: non-OK response throws (discover catches it into failures)', async () => {
  const s = new FleetHubSource('http://hub', { fetchImpl: mkFetch([{}], false, 500) });
  await assert.rejects(s.list(), /hub: HTTP 500/);
  const { items, failures } = await discover([s]);
  assert.equal(items.length, 0);
  assert.equal(failures[0]?.source, 'hub');
});

test('defaultSources: the hub joins only when hubUrl is configured', () => {
  assert.ok(!defaultSources({ ...DEFAULT_CONFIG }).some((s) => s.id === 'hub'));
  assert.ok(defaultSources({ ...DEFAULT_CONFIG, hubUrl: 'https://hub' }).some((s) => s.id === 'hub'));
});

test('defaultSources: config feedSources is an available-source allowlist with null/all and empty/none', () => {
  assert.deepEqual(
    defaultSources({ ...DEFAULT_CONFIG, feedSources: ['skills.sh', 'plugin-markets'] }).map(
      (source) => source.id,
    ),
    ['skills.sh', 'plugin-markets'],
  );
  assert.deepEqual(defaultSources({ ...DEFAULT_CONFIG, feedSources: [] }), []);
  assert.ok(defaultSources({ ...DEFAULT_CONFIG, feedSources: null }).length >= 5);
  assert.equal(feedSourceEnabled({ ...DEFAULT_CONFIG, feedSources: ['skills.sh'] }, 'skills.sh'), true);
  assert.equal(feedSourceEnabled({ ...DEFAULT_CONFIG, feedSources: [] }, 'skills.sh'), false);
});

test('PulseMcpSource: requires an API key, then maps popularity', async () => {
  await assert.rejects(new PulseMcpSource({ baseUrl: 'http://test' }).list(), /API key/);
  const source = new PulseMcpSource({
    apiKey: 'k',
    baseUrl: 'http://test',
    fetchImpl: mkFetch([
      { servers: [{ name: 'gh', package_name: '@x/gh', package_registry: 'npm', stars: 120 }] },
    ]),
  });
  const items = await source.list();
  assert.equal(items[0]?.popularity, 120);
  assert.equal(items[0]?.ecosystem, 'npm');
});
