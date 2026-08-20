import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalMarketplacesSource } from '../src/feed/sources/local-marketplaces.js';
import { recommend } from '../src/feed/recommend.js';
import { buildTools } from '../src/mcp/tools.js';
import { apiFeed, invalidateInventoryCache } from '../src/web/api.js';
import type { Inventory, PluginCapability } from '../src/core/types.js';

function scaffold(dir: string): string {
  const pluginsDir = join(dir, 'plugins');
  const marketDir = join(pluginsDir, 'marketplaces', 'official');
  mkdirSync(join(marketDir, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(pluginsDir, 'known_marketplaces.json'),
    JSON.stringify({ official: { installLocation: marketDir } }),
  );
  writeFileSync(
    join(marketDir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      plugins: [
        { name: 'figma-tools', description: 'Design handoff for agents' },
        { name: 'installed-one', description: 'already have it' },
        { name: 7 }, // malformed → skipped
      ],
    }),
  );
  return pluginsDir;
}

test('LocalMarketplacesSource: maps local marketplace catalogs to plugin FeedItems', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-plm-'));
  try {
    const items = await new LocalMarketplacesSource(scaffold(dir)).list();
    assert.equal(items.length, 2); // malformed entry skipped
    const f = items.find((i) => i.name === 'figma-tools')!;
    assert.equal(f.kind, 'plugin');
    assert.equal(f.identifier, 'figma-tools@official');
    assert.match(f.description ?? '', /Design/);
    assert.ok(f.category); // classified
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LocalMarketplacesSource: installLocation outside marketplaces/ is skipped (containment)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-plm-'));
  try {
    const pluginsDir = join(dir, 'plugins');
    const outside = join(dir, 'evil');
    mkdirSync(join(outside, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(outside, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({ plugins: [{ name: 'evil-plugin' }] }),
    );
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(
      join(pluginsDir, 'known_marketplaces.json'),
      JSON.stringify({ evil: { installLocation: outside } }),
    );
    assert.deepEqual(await new LocalMarketplacesSource(pluginsDir).list(), []); // outside root → skipped
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('LocalMarketplacesSource: root, leaf, and intermediate marketplace symlinks are skipped', async () => {
  for (const topology of ['root', 'leaf', 'intermediate'] as const) {
    const dir = mkdtempSync(join(tmpdir(), `fleet-plm-symlink-${topology}-`));
    try {
      const pluginsDir = join(dir, 'plugins');
      const marketplaces = join(pluginsDir, 'marketplaces');
      const outside = join(dir, 'private');
      const privateMarket =
        topology === 'intermediate' ? join(outside, 'group', 'official') : join(outside, 'official');
      mkdirSync(join(privateMarket, '.claude-plugin'), { recursive: true });
      writeFileSync(
        join(privateMarket, '.claude-plugin', 'marketplace.json'),
        JSON.stringify({ plugins: [{ name: `opaque-${topology}`, description: 'private catalog' }] }),
      );
      mkdirSync(pluginsDir, { recursive: true });
      let installLocation: string;
      if (topology === 'root') {
        symlinkSync(outside, marketplaces, 'dir');
        installLocation = join(marketplaces, 'official');
      } else if (topology === 'leaf') {
        mkdirSync(marketplaces);
        symlinkSync(privateMarket, join(marketplaces, 'official'), 'dir');
        installLocation = join(marketplaces, 'official');
      } else {
        mkdirSync(marketplaces);
        symlinkSync(join(outside, 'group'), join(marketplaces, 'group'), 'dir');
        installLocation = join(marketplaces, 'group', 'official');
      }
      writeFileSync(
        join(pluginsDir, 'known_marketplaces.json'),
        JSON.stringify({ official: { installLocation } }),
      );
      assert.deepEqual(await new LocalMarketplacesSource(pluginsDir).list(), [], topology);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('LocalMarketplacesSource: no marketplaces registered → [] (not a failure)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-plm-'));
  try {
    assert.deepEqual(await new LocalMarketplacesSource(join(dir, 'nope')).list(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hostile local marketplace paths are withheld from MCP and Web feed boundaries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-plm-hostile-'));
  try {
    const pluginsDir = join(dir, 'plugins');
    const marketDir = join(pluginsDir, 'marketplaces', 'official');
    mkdirSync(join(marketDir, '.claude-plugin'), { recursive: true });
    writeFileSync(
      join(pluginsDir, 'known_marketplaces.json'),
      JSON.stringify({
        official: { installLocation: marketDir },
        '/home/alice/OPAQUE_MARKET': { installLocation: marketDir },
      }),
    );
    writeFileSync(
      join(marketDir, '.claude-plugin', 'marketplace.json'),
      JSON.stringify({
        plugins: [
          { name: 'safe-plugin', description: 'Safe public marketplace metadata' },
          { name: '/home/alice/OPAQUE_PLUGIN_NAME', description: 'unsafe name' },
          { name: 'unsafe-description', description: 'config at /home/alice/OPAQUE_PLUGIN_DESCRIPTION' },
        ],
      }),
    );
    const source = new LocalMarketplacesSource(pluginsDir);
    const fleetHome = join(dir, 'fleet-home');
    const whatsNew = buildTools([], { sources: [source], fleetHome }).find(
      (tool) => tool.name === 'whats_new',
    )!;
    const mcp = (await whatsNew.handler({ refresh: true })) as any;
    invalidateInventoryCache();
    const web = await apiFeed([], [source], { fleetHome });
    const serialized = JSON.stringify({ mcp, web });
    assert.equal(serialized.includes('OPAQUE_PLUGIN_NAME'), false);
    assert.equal(serialized.includes('OPAQUE_PLUGIN_DESCRIPTION'), false);
    assert.equal(serialized.includes('OPAQUE_MARKET'), false);
    assert.ok(mcp.recommendations.some((item: any) => item.name === 'safe-plugin'));
    assert.ok(web.recommendations.some((item) => item.name === 'safe-plugin'));
    // Unsafe plugin/marketplace identities are rejected by the local source;
    // the remaining safe identity with a hostile description is withheld at
    // the public DTO boundary.
    assert.equal(mcp.withheldRecommendations, 1);
    assert.equal(web.withheldCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('recommend: withheld local capability names cannot create a public relevance oracle', async () => {
  const inv: Inventory = {
    agents: [],
    items: [
      {
        kind: 'mcp-server',
        name: '/home/alice/opaqueproject',
        agent: 'claude-code',
        scope: 'user',
        enabled: true,
        spec: { transport: 'stdio', command: 'node', args: ['server.js'] },
        source: { file: 'private' },
      },
    ],
  };
  const recs = await recommend(inv, [{ name: 'opaqueproject companion', source: 'registry' }]);
  assert.deepEqual(recs, []);

  const publicItem = {
    name: 'probe package',
    source: 'registry',
    identifier: 'probe-pkg',
    ecosystem: 'npm' as const,
    popularity: 10,
  };
  const hiddenCoordinate: Inventory = {
    agents: [],
    items: [
      {
        kind: 'mcp-server',
        name: '/home/alice/OPAQUE_COORDINATE_OWNER',
        agent: 'claude-code',
        scope: 'user',
        enabled: true,
        spec: { transport: 'stdio', command: 'npx', args: ['-y', 'probe-pkg@1.0.0'] },
        source: { file: 'private' },
      },
    ],
  };
  assert.equal((await recommend({ agents: [], items: [] }, [publicItem])).length, 1);
  assert.equal((await recommend(hiddenCoordinate, [publicItem])).length, 1);
});

test('recommend: plugins get a base marketplace score; installed plugins filtered by name', async () => {
  const installed: PluginCapability = {
    kind: 'plugin',
    name: 'installed-one',
    agent: 'claude-code',
    scope: 'user',
    enabled: true,
    source: { file: 'f' },
  };
  const inv: Inventory = { agents: [], items: [installed] };
  const items = [
    {
      name: 'figma-tools',
      source: 'plugin-markets',
      kind: 'plugin' as const,
      identifier: 'figma-tools@official',
    },
    {
      name: 'installed-one',
      source: 'plugin-markets',
      kind: 'plugin' as const,
      identifier: 'installed-one@official',
    },
  ];
  const recs = await recommend(inv, items, { limit: 10 });
  const names = recs.map((r) => r.item.name);
  assert.ok(names.includes('figma-tools')); // base +1 passes the floor
  assert.ok(!names.includes('installed-one')); // already installed → filtered
  assert.ok(recs.find((r) => r.item.name === 'figma-tools')?.reasons.includes('marketplace'));
});
