import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.js';
import { planInstall, planRemove, planInstallSkill, execute } from '../src/core/orchestrator.js';
import { readLock, lockKey, updateLockForPlugin } from '../src/core/lock.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'fleet-lock-'));
}

function hermeticClaude(dir: string): ClaudeCodeAdapter {
  const claudeJson = join(dir, '.claude.json');
  writeFileSync(claudeJson, JSON.stringify({ mcpServers: {} }));
  return new ClaudeCodeAdapter(
    claudeJson,
    join(dir, 'skills'),
    join(dir, 'CLAUDE.md'),
    join(dir, 'settings.json'),
    join(dir, 'plugins'),
  );
}

test('lock: npm install records origin + spec hash; remove deletes the entry', async () => {
  const dir = tmp();
  try {
    const home = join(dir, 'home');
    const a = hermeticClaude(dir);
    const plan = await planInstall(
      [a],
      { transport: 'stdio', command: 'npx', args: ['-y', '@scope/server-thing@1.2.3'] },
      'thing',
      'user',
      ['claude-code'],
    );
    assert.equal(plan.origin?.type, 'npm');
    const res = await execute([a], plan, { commit: true, fleetHome: home });
    assert.equal(res.applied.length, 1);
    assert.equal(res.lockWarning, undefined);

    const lock = await readLock(home);
    const entry = lock.entries[lockKey('mcp-server', 'thing', 'claude-code')];
    assert.ok(entry);
    assert.deepEqual(entry.origin, { type: 'npm', id: '@scope/server-thing', version: '1.2.3' });
    assert.ok(entry.contentHash);
    assert.ok(entry.auditId);

    const rm = await planRemove([a], 'thing', ['claude-code']);
    await execute([a], rm, { commit: true, fleetHome: home });
    const after = await readLock(home);
    assert.equal(after.entries[lockKey('mcp-server', 'thing', 'claude-code')], undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lock: skill install records dir origin + manifest hash', async () => {
  const dir = tmp();
  try {
    const home = join(dir, 'home');
    const a = hermeticClaude(dir);
    const src = join(dir, 'my-skill');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'SKILL.md'), '# my skill');
    const plan = await planInstallSkill([a], { name: 'my-skill', dir: src }, 'my-skill', ['claude-code']);
    assert.deepEqual(plan.origin, { type: 'dir', path: src });
    const res = await execute([a], plan, { commit: true, fleetHome: home });
    assert.equal(res.applied.length, 1);
    const entry = (await readLock(home)).entries[lockKey('skill', 'my-skill', 'claude-code')];
    assert.ok(entry);
    assert.equal(entry.origin.type, 'dir');
    assert.equal(entry.contentHash, res.applied[0]!.wroteHash); // dir manifest hash
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lock: dry-run writes nothing', async () => {
  const dir = tmp();
  try {
    const home = join(dir, 'home');
    const a = hermeticClaude(dir);
    const plan = await planInstall(
      [a],
      { transport: 'stdio', command: 'npx', args: ['-y', 'x'] },
      'x',
      'user',
      ['claude-code'],
    );
    await execute([a], plan, { commit: false, fleetHome: home });
    assert.equal(existsSync(join(home, 'fleet.lock')), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lock: delegated plugin install/remove upserts and deletes', async () => {
  const dir = tmp();
  try {
    await updateLockForPlugin('install', 'claude-code', 'ponytail@ponytail', dir);
    let lock = await readLock(dir);
    const e = lock.entries[lockKey('plugin', 'ponytail', 'claude-code')];
    assert.deepEqual(e?.origin, { type: 'marketplace', selector: 'ponytail@ponytail' });
    await updateLockForPlugin('remove', 'claude-code', 'ponytail@ponytail', dir);
    lock = await readLock(dir);
    assert.equal(lock.entries[lockKey('plugin', 'ponytail', 'claude-code')], undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lock: corrupt lock file degrades to empty (metadata, not a gate)', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'fleet.lock'), '{corrupt!!');
    const lock = await readLock(dir);
    assert.deepEqual(lock.entries, {});
    // and a subsequent write replaces it cleanly
    await updateLockForPlugin('install', 'codex', 'omo@sisyphuslabs', dir);
    assert.ok(JSON.parse(readFileSync(join(dir, 'fleet.lock'), 'utf8')).entries['plugin:omo@codex']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
