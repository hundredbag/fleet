import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readClaudePlugins, readCodexPlugins } from '../src/core/agent-plugins.js';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.js';

async function withDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-plug-'));
  try {
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Build a realistic ~/.claude/plugins layout (as verified on a real machine). */
function scaffoldClaude(dir: string): { pluginsDir: string; settingsPath: string } {
  const pluginsDir = join(dir, 'plugins');
  const marketDir = join(pluginsDir, 'marketplaces', 'official');
  mkdirSync(join(marketDir, '.claude-plugin'), { recursive: true });
  writeFileSync(
    join(pluginsDir, 'known_marketplaces.json'),
    JSON.stringify({ official: { source: { repo: 'x/y' }, installLocation: marketDir } }),
  );
  writeFileSync(
    join(marketDir, '.claude-plugin', 'marketplace.json'),
    JSON.stringify({
      name: 'official',
      plugins: [{ name: 'plugin-dev', description: 'Plugin development toolkit' }],
    }),
  );
  const settingsPath = join(dir, 'settings.json');
  writeFileSync(
    settingsPath,
    JSON.stringify({ enabledPlugins: { 'plugin-dev@official': true, 'off-thing@official': false } }),
  );
  return { pluginsDir, settingsPath };
}

test('readClaudePlugins: enabled plugins with marketplace + manifest description', async () => {
  await withDir(async (dir) => {
    const { pluginsDir, settingsPath } = scaffoldClaude(dir);
    const plugins = await readClaudePlugins('claude-code', pluginsDir, settingsPath);
    assert.equal(plugins.length, 2); // disabled SURFACES too (matrix shows ✗)
    const p = plugins.find((x) => x.name === 'plugin-dev')!;
    assert.equal(p.kind, 'plugin');
    assert.equal(p.enabled, true);
    assert.equal(p.marketplace, 'official');
    assert.match(p.description ?? '', /toolkit/);
    assert.equal(plugins.find((x) => x.name === 'off-thing')?.enabled, false);
  });
});

test('readClaudePlugins: missing/malformed settings or manifests → [] (never throws)', async () => {
  await withDir(async (dir) => {
    assert.deepEqual(await readClaudePlugins('c', join(dir, 'nope'), join(dir, 'nope.json')), []);
    const settings = join(dir, 's.json');
    writeFileSync(settings, '{ not json');
    assert.deepEqual(await readClaudePlugins('c', dir, settings), []);
    writeFileSync(settings, JSON.stringify({ enabledPlugins: { 'a@m': true } }));
    // marketplace registry missing → plugin still reported, without description
    const plugins = await readClaudePlugins('c', join(dir, 'no-plugins-dir'), settings);
    assert.equal(plugins.length, 1);
    assert.equal(plugins[0]?.description, undefined);
  });
});

test('readClaudePlugins: disabled plugins SURFACE with enabled:false; truthy-non-boolean is not enabled', async () => {
  await withDir(async (dir) => {
    const settings = join(dir, 's.json');
    writeFileSync(
      settings,
      JSON.stringify({ enabledPlugins: { 'on@m': true, 'off@m': false, 'weird@m': 'true' } }),
    );
    const plugins = await readClaudePlugins('c', join(dir, 'nope'), settings);
    assert.equal(plugins.length, 3); // all surface
    assert.equal(plugins.find((p) => p.name === 'on')?.enabled, true);
    assert.equal(plugins.find((p) => p.name === 'off')?.enabled, false);
    assert.equal(plugins.find((p) => p.name === 'weird')?.enabled, false); // strict
  });
});

test('readClaudePlugins: scoped plugin name (@scope/x@market) splits on the LAST @', async () => {
  await withDir(async (dir) => {
    const settings = join(dir, 's.json');
    writeFileSync(settings, JSON.stringify({ enabledPlugins: { '@scope/x@market': true, noatall: true } }));
    const plugins = await readClaudePlugins('c', join(dir, 'nope'), settings);
    const scoped = plugins.find((p) => p.name === '@scope/x');
    assert.equal(scoped?.marketplace, 'market');
    const bare = plugins.find((p) => p.name === 'noatall');
    assert.equal(bare?.marketplace, undefined);
  });
});

test('readClaudePlugins: registered marketplace with missing installLocation or bad manifest → no description, no throw', async () => {
  await withDir(async (dir) => {
    const pluginsDir = join(dir, 'plugins');
    mkdirSync(pluginsDir, { recursive: true });
    writeFileSync(join(pluginsDir, 'known_marketplaces.json'), JSON.stringify({ m: { source: {} } })); // no installLocation
    const settings = join(dir, 's.json');
    writeFileSync(settings, JSON.stringify({ enabledPlugins: { 'a@m': true } }));
    const plugins = await readClaudePlugins('c', pluginsDir, settings);
    assert.equal(plugins.length, 1);
    assert.equal(plugins[0]?.description, undefined);
  });
});

test('readCodexPlugins: pointed at a FILE → [] (ENOTDIR caught)', async () => {
  await withDir(async (dir) => {
    const f = join(dir, 'notadir');
    writeFileSync(f, 'x');
    assert.deepEqual(await readCodexPlugins('codex', f), []);
  });
});

test('readCodexPlugins: guarded dir scan; missing dir → []', async () => {
  await withDir(async (dir) => {
    assert.deepEqual(await readCodexPlugins('codex', join(dir, 'nope')), []);
    mkdirSync(join(dir, 'plugins', 'figma'), { recursive: true });
    mkdirSync(join(dir, 'plugins', '.hidden'), { recursive: true });
    const plugins = await readCodexPlugins('codex', join(dir, 'plugins'));
    assert.deepEqual(
      plugins.map((p) => p.name),
      ['figma'],
    );
  });
});

test('adapter: plugins appear in the Claude inventory alongside other kinds', async () => {
  await withDir(async (dir) => {
    const { pluginsDir, settingsPath } = scaffoldClaude(dir);
    const claudeJson = join(dir, '.claude.json');
    writeFileSync(
      claudeJson,
      JSON.stringify({ mcpServers: { gh: { command: 'npx', args: ['-y', '@x/gh'] } } }),
    );
    const ad = new ClaudeCodeAdapter(
      claudeJson,
      join(dir, 'sk'),
      join(dir, 'CLAUDE.md'),
      settingsPath,
      pluginsDir,
    );
    const items = await ad.readInventory();
    assert.ok(items.some((i) => i.kind === 'mcp-server' && i.name === 'gh'));
    assert.ok(items.some((i) => i.kind === 'plugin' && i.name === 'plugin-dev'));
  });
});
