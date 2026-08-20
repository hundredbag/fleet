import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCoordinate } from '../src/feed/coords.js';
import { discover, updatesForInventory, newRelevant } from '../src/feed/feed.js';
import { assessTrust } from '../src/feed/trust.js';
import type { FeedItem, FeedSource } from '../src/feed/source.js';
import type { Inventory, McpServerCapability, McpServerSpec } from '../src/core/types.js';

function mcp(name: string, agent: string, spec: McpServerSpec): McpServerCapability {
  return { kind: 'mcp-server', name, agent, scope: 'user', enabled: true, spec, source: { file: 'f' } };
}
const inv = (items: McpServerCapability[]): Inventory => ({ agents: [], items });
const fakeSource = (id: string, items: FeedItem[]): FeedSource => ({ id, list: async () => items });
const npm = (id: string, version?: string): FeedItem => ({
  name: id,
  source: 'r',
  identifier: id,
  ecosystem: 'npm',
  version,
});

test('extractCoordinate: npx / uvx / value-flags / local-script / remote', () => {
  assert.deepEqual(extractCoordinate({ transport: 'stdio', command: 'npx', args: ['-y', '@x/y'] }), {
    ecosystem: 'npm',
    id: '@x/y',
    confidence: 'high',
  });
  const v = extractCoordinate({ transport: 'stdio', command: 'npx', args: ['@x/y@1.2.3'] });
  assert.equal(v?.id, '@x/y');
  assert.equal(v?.version, '1.2.3');
  // value-taking flag's value must not be mistaken for the package
  assert.equal(
    extractCoordinate({ transport: 'stdio', command: 'npx', args: ['--loglevel', 'warn', '@x/y'] })?.id,
    '@x/y',
  );
  // explicit -p
  assert.equal(
    extractCoordinate({ transport: 'stdio', command: 'npx', args: ['-p', '@x/y', 'cmd'] })?.id,
    '@x/y',
  );
  assert.equal(extractCoordinate({ transport: 'stdio', command: 'uvx', args: ['mypkg'] })?.ecosystem, 'pypi');
  assert.equal(extractCoordinate({ transport: 'stdio', command: 'node', args: ['server.js'] }), null);
  assert.equal(
    extractCoordinate({ transport: 'stdio', command: 'npx', args: ['pkg@file:/home/alice/private'] }),
    null,
  );
  assert.equal(
    extractCoordinate({ transport: 'stdio', command: 'npx', args: ['pkg@^1.2.3'] })?.version,
    '^1.2.3',
  );
  assert.equal(extractCoordinate({ transport: 'stdio', command: 'uvx', args: ['../private'] }), null);
  assert.equal(extractCoordinate({ transport: 'http', url: 'https://h.test/mcp' })?.confidence, 'low');
});

test('discover merges, dedupes, and reports source failures separately', async () => {
  const a = fakeSource('a', [npm('@x/y')]);
  const b = fakeSource('b', [npm('@x/y'), npm('@z/z')]);
  const broken: FeedSource = {
    id: 'bad',
    list: async () => {
      throw new Error('offline');
    },
  };
  const { items, failures } = await discover([a, b, broken]);
  assert.equal(items.length, 2); // @x/y deduped
  assert.equal(failures.length, 1);
  assert.equal(failures[0]?.source, 'bad');
});

test('updatesForInventory: only concrete newer versions are updates', () => {
  const i = inv([
    mcp('gh', 'claude-code', { transport: 'stdio', command: 'npx', args: ['-y', '@x/gh@1.0.0'] }),
    mcp('cur', 'claude-code', { transport: 'stdio', command: 'npx', args: ['-y', '@x/cur@2.0.0'] }),
    mcp('down', 'claude-code', { transport: 'stdio', command: 'npx', args: ['-y', '@x/down@3.0.0'] }),
    mcp('unpinned', 'codex', { transport: 'stdio', command: 'npx', args: ['-y', '@x/up'] }),
    mcp('local', 'codex', { transport: 'stdio', command: 'node', args: ['s.js'] }),
  ]);
  const items: FeedItem[] = [
    npm('@x/gh', '2.0.0'),
    npm('@x/cur', '2.0.0'),
    npm('@x/down', '1.0.0'),
    npm('@x/up', '5.0.0'),
  ];
  const { updates, unmatched } = updatesForInventory(i, items);
  assert.deepEqual(
    updates.map((u) => u.name),
    ['gh'], // only gh: 1.0.0 → 2.0.0. cur=same, down=older, unpinned=unknown
  );
  const reasons = Object.fromEntries(unmatched.map((u) => [u.name, u.reason]));
  assert.match(reasons.unpinned ?? '', /unpinned|unknown/);
  assert.match(reasons.local ?? '', /coordinate/);
});

test('updatesForInventory: ecosystem-aware matching avoids npm/pypi name collisions', () => {
  const i = inv([mcp('redis', 'claude-code', { transport: 'stdio', command: 'uvx', args: ['redis@1.0.0'] })]); // pypi
  const items: FeedItem[] = [npm('redis', '2.0.0')]; // npm redis — different ecosystem
  const { updates, unmatched } = updatesForInventory(i, items);
  assert.equal(updates.length, 0); // must NOT match across ecosystems
  assert.equal(unmatched[0]?.name, 'redis');
});

test('newRelevant filters out already-installed items', () => {
  const i = inv([mcp('gh', 'claude-code', { transport: 'stdio', command: 'npx', args: ['-y', '@x/gh'] })]);
  const items: FeedItem[] = [npm('@x/gh'), npm('@x/new')];
  const rel = newRelevant(i, items);
  assert.equal(rel.length, 1);
  assert.equal(rel[0]?.identifier, '@x/new');
});

// ── P2-6: feed cache ────────────────────────────────────────────────────────

test('cachedDiscover: second call within TTL is served from cache; refresh bypasses', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { cachedDiscover } = await import('../src/feed/cache.js');
  const dir = mkdtempSync(join(tmpdir(), 'fleet-fc-'));
  let calls = 0;
  const src = {
    id: 'fake',
    list: async () => {
      calls++;
      return [{ name: 'x', source: 'fake' }];
    },
  };
  try {
    const a = await cachedDiscover([src], { fleetHome: dir });
    assert.equal(a.fromCache, false);
    const b = await cachedDiscover([src], { fleetHome: dir });
    assert.equal(b.fromCache, true);
    assert.equal(calls, 1); // network hit once
    assert.deepEqual(
      b.items.map((i) => i.name),
      ['x'],
    );
    const c = await cachedDiscover([src], { fleetHome: dir, refresh: true });
    assert.equal(c.fromCache, false);
    assert.equal(calls, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cachedDiscover preserves normalized caution status and trust across a cache hit', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { cachedDiscover } = await import('../src/feed/cache.js');
  const dir = mkdtempSync(join(tmpdir(), 'fleet-fc-caution-'));
  const source: FeedSource = {
    id: 'caution-source',
    list: async () => [
      {
        name: 'retired-tool',
        source: 'caution-source',
        status: 'deprecated',
        url: 'https://registry.example/retired-tool',
        updatedAt: '2026-08-01T00:00:00Z',
      },
    ],
  };
  try {
    const live = await cachedDiscover([source], { fleetHome: dir });
    const cached = await cachedDiscover([source], { fleetHome: dir });
    assert.equal(live.fromCache, false);
    assert.equal(cached.fromCache, true);
    assert.equal(live.items[0]?.status, 'caution');
    assert.equal(cached.items[0]?.status, 'caution');
    assert.deepEqual(assessTrust(cached.items[0]!, Date.parse('2026-08-19T00:00:00Z')), {
      level: 'caution',
      reasons: ['REGISTRY_STATUS_CAUTION'],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cachedDiscover: corrupt cache file → live refetch, not a crash', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { cachedDiscover } = await import('../src/feed/cache.js');
  const dir = mkdtempSync(join(tmpdir(), 'fleet-fc-'));
  try {
    mkdirSync(join(dir, 'cache'), { recursive: true });
    writeFileSync(join(dir, 'cache', 'feed.json'), '{broken');
    const r = await cachedDiscover([{ id: 'f', list: async () => [] }], { fleetHome: dir });
    assert.equal(r.fromCache, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cachedDiscover: source exceptions are code-only at rest and cache mode is 0600', async () => {
  const { mkdtempSync, readFileSync, rmSync, statSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { cachedDiscover } = await import('../src/feed/cache.js');
  const dir = mkdtempSync(join(tmpdir(), 'fleet-fc-secure-'));
  try {
    const result = await cachedDiscover(
      [
        {
          id: 'broken',
          async list() {
            throw new Error('credential is OPAQUE_CACHE_FAILURE');
          },
        },
      ],
      { fleetHome: dir },
    );
    const file = join(dir, 'cache', 'feed.json');
    assert.deepEqual(result.failures, [{ source: 'broken', code: 'SOURCE_UNAVAILABLE' }]);
    assert.equal(readFileSync(file, 'utf8').includes('OPAQUE_CACHE_FAILURE'), false);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cachedDiscover migrates a valid legacy cache before returning it', async () => {
  const { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } =
    await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { cachedDiscover } = await import('../src/feed/cache.js');
  const dir = mkdtempSync(join(tmpdir(), 'fleet-fc-legacy-'));
  try {
    const cacheDir = join(dir, 'cache');
    const file = join(cacheDir, 'feed.json');
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(
      file,
      JSON.stringify({
        time: Date.now(),
        sourceKey: 'legacy',
        items: [{ name: 'safe\u001b]8;;https://evil', source: 'legacy' }],
        failures: [{ source: 'legacy', error: 'credential is OPAQUE_LEGACY_CACHE' }],
      }),
    );
    chmodSync(file, 0o644);
    const result = await cachedDiscover([{ id: 'legacy', list: async () => [] }], { fleetHome: dir });
    const migrated = readFileSync(file, 'utf8');
    assert.equal(result.fromCache, true);
    assert.equal(JSON.stringify(result).includes('OPAQUE_LEGACY_CACHE'), false);
    assert.equal(migrated.includes('OPAQUE_LEGACY_CACHE'), false);
    assert.equal(migrated.includes('\u001b'), false);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cachedDiscover honors FLEET_HOME and never follows a cache-directory symlink', async () => {
  const { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { cachedDiscover } = await import('../src/feed/cache.js');
  const root = mkdtempSync(join(tmpdir(), 'fleet-fc-home-'));
  const home = join(root, 'fleet-home');
  const outside = join(root, 'outside');
  const previous = process.env.FLEET_HOME;
  try {
    process.env.FLEET_HOME = home;
    await cachedDiscover([{ id: 'env-home', list: async () => [] }]);
    assert.equal(existsSync(join(home, 'cache', 'feed.json')), true);

    rmSync(join(home, 'cache'), { recursive: true, force: true });
    mkdirSync(outside);
    symlinkSync(outside, join(home, 'cache'));
    const result = await cachedDiscover([{ id: 'symlink', list: async () => [] }], { refresh: true });
    assert.equal(result.fromCache, false);
    assert.equal(existsSync(join(outside, 'feed.json')), false);
  } finally {
    if (previous === undefined) delete process.env.FLEET_HOME;
    else process.env.FLEET_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
