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
    assert.ok(
      JSON.parse(readFileSync(join(dir, 'fleet.lock'), 'utf8')).entries[lockKey('plugin', 'omo', 'codex')],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── dual-review round fixes ─────────────────────────────────────────────────

test('lock: @scope/name selectors do not collide (last-@ parsing)', async () => {
  const dir = tmp();
  try {
    await updateLockForPlugin('install', 'claude-code', '@acme/one@market', dir);
    await updateLockForPlugin('install', 'claude-code', '@acme/two@market', dir);
    const lock = await readLock(dir);
    assert.ok(lock.entries[lockKey('plugin', '@acme/one', 'claude-code')]);
    assert.ok(lock.entries[lockKey('plugin', '@acme/two', 'claude-code')]);
    await updateLockForPlugin('remove', 'claude-code', '@acme/one@market', dir);
    const after = await readLock(dir);
    assert.equal(after.entries[lockKey('plugin', '@acme/one', 'claude-code')], undefined);
    assert.ok(after.entries[lockKey('plugin', '@acme/two', 'claude-code')]); // survivor intact
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lock: rollback removes the stale entry (install → rollback)', async () => {
  const dir = tmp();
  try {
    const home = join(dir, 'home');
    const a = hermeticClaude(dir);
    const plan = await planInstall(
      [a],
      { transport: 'stdio', command: 'npx', args: ['-y', 'thing'] },
      'thing',
      'user',
      ['claude-code'],
    );
    await execute([a], plan, { commit: true, fleetHome: home });
    assert.ok((await readLock(home)).entries[lockKey('mcp-server', 'thing', 'claude-code')]);
    const { rollback } = await import('../src/core/writer.js');
    const r = await rollback({ fleetHome: home });
    assert.equal(r.action, 'restored'); // config file existed before → restored
    assert.equal(
      (await readLock(home)).entries[lockKey('mcp-server', 'thing', 'claude-code')],
      undefined, // no stale provenance claim
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lock: write failure degrades to lockWarning, apply still succeeds', async () => {
  const dir = tmp();
  try {
    const home = join(dir, 'home');
    mkdirSync(join(home, 'fleet.lock'), { recursive: true }); // rename onto a DIR fails
    const a = hermeticClaude(dir);
    const plan = await planInstall(
      [a],
      { transport: 'stdio', command: 'npx', args: ['-y', 'x'] },
      'x',
      'user',
      ['claude-code'],
    );
    const res = await execute([a], plan, { commit: true, fleetHome: home });
    assert.equal(res.applied.length, 1); // the install happened
    assert.match(res.lockWarning ?? '', /fleet.lock update failed/);
    assert.equal(res.error, undefined); // and is NOT reported as a failure
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lock: entries:null degrades to empty instead of crashing consumers', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'fleet.lock'), '{"version":1,"entries":null}');
    const lock = await readLock(dir);
    assert.deepEqual(lock.entries, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lock: specHash is key-order independent', async () => {
  const { specHash } = await import('../src/core/lock.js');
  assert.equal(specHash({ a: 1, b: { c: 2, d: 3 } }), specHash({ b: { d: 3, c: 2 }, a: 1 }));
  assert.notEqual(specHash({ a: 1 }), specHash({ a: 2 }));
});

// ── P2-5: skill update diff from provenance ─────────────────────────────────

test('skill updates: origin dir changed → update; local edit → update+local-edits', async () => {
  const dir = tmp();
  try {
    const home = join(dir, 'home');
    const a = hermeticClaude(dir);
    const src = join(dir, 'src-skill');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'SKILL.md'), 'v1');
    const plan = await planInstallSkill([a], { name: 'up', dir: src }, 'up', ['claude-code'], {
      trustPolicy: 'warn',
    });
    await execute([a], plan, { commit: true, fleetHome: home });

    const { skillUpdatesFromLock } = await import('../src/core/skill-updates.js');
    const { buildInventory } = await import('../src/core/inventory.js');

    // unchanged origin → no updates
    let ups = await skillUpdatesFromLock(await buildInventory([a]), home);
    assert.deepEqual(ups, []);

    // upstream (origin dir) changes → clean update
    writeFileSync(join(src, 'SKILL.md'), 'v2 improved');
    ups = await skillUpdatesFromLock(await buildInventory([a]), home);
    assert.equal(ups.length, 1);
    assert.equal(ups[0]!.state, 'update');
    assert.match(ups[0]!.applyHint, /fleet skill install up/);

    // Policy branches only on structured inventoryStatus, never arbitrary notes.
    const base = await buildInventory([a]);
    for (const [inventoryStatus, expected] of [
      ['ok', 'update'],
      ['not-present', 'update+missing'],
      ['detect-failed', 'update+unverifiable'],
      ['read-failed', 'update+unverifiable'],
    ] as const) {
      const inv = structuredClone(base);
      inv.agents[0] = {
        ...inv.agents[0]!,
        present: inventoryStatus !== 'not-present',
        inventoryStatus,
        note: inventoryStatus === 'ok' ? 'read failed words are diagnostic only' : 'everything is healthy',
      };
      if (inventoryStatus !== 'ok') inv.items = [];
      assert.equal((await skillUpdatesFromLock(inv, home))[0]!.state, expected, inventoryStatus);
    }

    // AND the installed copy was edited locally → flagged so reinstall doesn't silently clobber
    writeFileSync(join(dir, 'skills', 'up', 'SKILL.md'), 'my local tweak');
    ups = await skillUpdatesFromLock(await buildInventory([a]), home);
    assert.equal(ups[0]!.state, 'update+local-edits');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
