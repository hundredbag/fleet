import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { GeminiAdapter } from '../src/adapters/gemini.js';

/** End-to-end read tests against real-shaped config files in a temp dir. */

function withTempDir(fn: (dir: string) => void | Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-'));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test(
  'claude adapter: reads user + local + project scopes from real-shaped config',
  withTempDir(async (dir) => {
    const projDir = join(dir, 'proj');
    mkdirSync(projDir);
    writeFileSync(
      join(projDir, '.mcp.json'),
      JSON.stringify({ mcpServers: { shared: { type: 'http', url: 'https://s.test' } } }),
    );
    const claudeJson = join(dir, '.claude.json');
    writeFileSync(
      claudeJson,
      JSON.stringify({
        mcpServers: { glob: { command: 'npx', args: ['-y', 'glob'] } },
        projects: { [projDir]: { mcpServers: { loc: { command: 'loc' } } } },
      }),
    );

    const items = await new ClaudeCodeAdapter(claudeJson).readInventory();
    const byName = new Map(items.map((i) => [i.name, i]));
    assert.equal(items.length, 3);
    assert.equal(byName.get('glob')?.scope, 'user');
    assert.equal(byName.get('loc')?.scope, 'local');
    assert.equal(byName.get('shared')?.scope, 'project');
    assert.equal(byName.get('shared')?.spec.transport, 'http');
  }),
);

test(
  'codex adapter: parses [mcp_servers.*] incl. disabled + flat-url remote',
  withTempDir(async (dir) => {
    const toml = join(dir, 'config.toml');
    writeFileSync(
      toml,
      [
        '[mcp_servers.local]',
        'command = "foo"',
        'args = ["a"]',
        '',
        '[mcp_servers.remote]',
        'url = "https://r.test"',
        '',
        '[mcp_servers.off]',
        'command = "bar"',
        'enabled = false',
        '',
      ].join('\n'),
    );

    const items = await new CodexAdapter(toml).readInventory();
    const byName = new Map(items.map((i) => [i.name, i]));
    assert.equal(items.length, 3);
    assert.equal(byName.get('local')?.spec.transport, 'stdio');
    assert.equal(byName.get('remote')?.spec.transport, 'http');
    assert.equal(byName.get('local')?.enabled, true);
    assert.equal(byName.get('off')?.enabled, false);
  }),
);

test(
  'gemini adapter: discriminates httpUrl/url/command transports',
  withTempDir(async (dir) => {
    const settings = join(dir, 'settings.json');
    writeFileSync(
      settings,
      JSON.stringify({
        mcpServers: {
          h: { httpUrl: 'https://h.test' },
          s: { url: 'https://s.test' },
          c: { command: 'c' },
        },
      }),
    );

    const items = await new GeminiAdapter(settings).readInventory();
    const byName = new Map(items.map((i) => [i.name, i]));
    assert.equal(byName.get('h')?.spec.transport, 'http');
    assert.equal(byName.get('s')?.spec.transport, 'sse');
    assert.equal(byName.get('c')?.spec.transport, 'stdio');
  }),
);

test(
  'adapter detect(): absent config reports not present',
  withTempDir(async (dir) => {
    const missing = join(dir, 'nope.json');
    const det = await new ClaudeCodeAdapter(missing).detect();
    assert.equal(det.present, false);
    assert.deepEqual(await new ClaudeCodeAdapter(missing).readInventory(), []);
  }),
);
