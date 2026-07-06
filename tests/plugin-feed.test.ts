import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalMarketplacesSource } from '../src/feed/sources/local-marketplaces.js';
import { recommend } from '../src/feed/recommend.js';
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

test('LocalMarketplacesSource: no marketplaces registered → [] (not a failure)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-plm-'));
  try {
    assert.deepEqual(await new LocalMarketplacesSource(join(dir, 'nope')).list(), []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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
