import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readClaudePermissions, readCodexPermissions } from '../src/core/permissions.js';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.js';

async function withDir(body: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-perm-'));
  try {
    await body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('readClaudePermissions: maps allow/deny/ask with correct effect', async () => {
  await withDir(async (dir) => {
    const p = join(dir, 'settings.json');
    writeFileSync(
      p,
      JSON.stringify({
        permissions: { allow: ['Bash(git*)', 'Read(*)'], deny: ['Bash(rm*)'], ask: ['WebFetch'] },
      }),
    );
    const perms = await readClaudePermissions('claude-code', p);
    assert.equal(perms.length, 4);
    assert.equal(perms.find((x) => x.name === 'Bash(rm*)')?.effect, 'deny');
    assert.equal(perms.find((x) => x.name === 'WebFetch')?.effect, 'ask');
    assert.equal(perms.find((x) => x.name === 'Read(*)')?.effect, 'allow');
    assert.ok(perms.every((x) => x.kind === 'permission' && x.agent === 'claude-code'));
  });
});

test('readClaudePermissions: missing / malformed / no-permissions → [] (never throws)', async () => {
  await withDir(async (dir) => {
    assert.deepEqual(await readClaudePermissions('claude-code', join(dir, 'nope.json')), []);
    writeFileSync(join(dir, 'bad.json'), '{ not json');
    assert.deepEqual(await readClaudePermissions('claude-code', join(dir, 'bad.json')), []);
    writeFileSync(join(dir, 'empty.json'), JSON.stringify({ other: 1 }));
    assert.deepEqual(await readClaudePermissions('claude-code', join(dir, 'empty.json')), []);
  });
});

test('readCodexPermissions: approval_policy + sandbox_mode → policy entries', async () => {
  await withDir(async (dir) => {
    const p = join(dir, 'config.toml');
    writeFileSync(p, 'approval_policy = "on-request"\nsandbox_mode = "workspace-write"\n');
    const perms = await readCodexPermissions('codex', p);
    assert.equal(perms.length, 2);
    assert.ok(perms.every((x) => x.effect === 'policy' && x.kind === 'permission'));
    assert.ok(perms.some((x) => x.name === 'approval_policy=on-request'));
    assert.ok(perms.some((x) => x.name === 'sandbox_mode=workspace-write'));
  });
});

test('readCodexPermissions: missing file → [] (never throws)', async () => {
  await withDir(async (dir) => {
    assert.deepEqual(await readCodexPermissions('codex', join(dir, 'nope.toml')), []);
  });
});

test('adapter: a malformed settings.json does not drop the rest of the inventory', async () => {
  await withDir(async (dir) => {
    const claudeJson = join(dir, '.claude.json');
    writeFileSync(
      claudeJson,
      JSON.stringify({ mcpServers: { gh: { command: 'npx', args: ['-y', '@x/gh'] } } }),
    );
    writeFileSync(join(dir, 'settings.json'), '{ not json'); // malformed permissions file
    const ad = new ClaudeCodeAdapter(
      claudeJson,
      join(dir, 'sk'),
      join(dir, 'CLAUDE.md'),
      join(dir, 'settings.json'),
    );
    const items = await ad.readInventory();
    assert.ok(items.some((i) => i.kind === 'mcp-server' && i.name === 'gh')); // MCP survived
    assert.equal(items.filter((i) => i.kind === 'permission').length, 0); // bad perms → none, no throw
  });
});
