import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCoordinate } from '../src/feed/coords.js';
import { discover, updatesForInventory, newRelevant } from '../src/feed/feed.js';
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
