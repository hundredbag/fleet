import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  statSync,
  symlinkSync,
  lstatSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.js';
import { planInstall, planRemove, planInstallSkill, execute } from '../src/core/orchestrator.js';
import { readLock, readLockState, lockKey, updateLockForPlugin } from '../src/core/lock.js';

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
    assert.equal(entry.hashScheme, 'canonical-v2');
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
    const key = lockKey('plugin', 'ponytail', 'claude-code', 'user', 'ponytail');
    const e = lock.entries[key];
    assert.deepEqual(e?.origin, { type: 'marketplace', selector: 'ponytail@ponytail' });
    assert.equal(e?.marketplace, 'ponytail');
    await updateLockForPlugin('remove', 'claude-code', 'ponytail@ponytail', dir);
    lock = await readLock(dir);
    assert.equal(lock.entries[key], undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lock: corrupt lock reads as empty but mutation refuses to erase provenance', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'fleet.lock'), '{corrupt!!');
    const lock = await readLock(dir);
    assert.deepEqual(lock.entries, {});
    await assert.rejects(
      updateLockForPlugin('install', 'codex', 'omo@sisyphuslabs', dir),
      /refusing provenance overwrite/,
    );
    assert.equal(readFileSync(join(dir, 'fleet.lock'), 'utf8'), '{corrupt!!');
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
    assert.ok(lock.entries[lockKey('plugin', '@acme/one', 'claude-code', 'user', 'market')]);
    assert.ok(lock.entries[lockKey('plugin', '@acme/two', 'claude-code', 'user', 'market')]);
    await updateLockForPlugin('remove', 'claude-code', '@acme/one@market', dir);
    const after = await readLock(dir);
    assert.equal(after.entries[lockKey('plugin', '@acme/one', 'claude-code', 'user', 'market')], undefined);
    assert.ok(after.entries[lockKey('plugin', '@acme/two', 'claude-code', 'user', 'market')]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lock: same logical plugin from different marketplaces has distinct provenance', async () => {
  const dir = tmp();
  try {
    await updateLockForPlugin('install', 'claude-code', 'shared@first', dir);
    await updateLockForPlugin('install', 'claude-code', 'shared@second', dir);
    await updateLockForPlugin('remove', 'claude-code', 'shared@first', dir);
    const entries = (await readLock(dir)).entries;
    assert.equal(entries[lockKey('plugin', 'shared', 'claude-code', 'user', 'first')], undefined);
    assert.ok(entries[lockKey('plugin', 'shared', 'claude-code', 'user', 'second')]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lock: new state is private and a symlink target is never followed', async () => {
  const dir = tmp();
  try {
    const home = join(dir, 'new-home');
    await updateLockForPlugin('install', 'claude-code', 'safe@market', home);
    assert.equal(statSync(home).mode & 0o777, 0o700);
    assert.equal(statSync(join(home, 'fleet.lock')).mode & 0o777, 0o600);

    const external = join(dir, 'external.json');
    const linkedHome = join(dir, 'linked-home');
    mkdirSync(linkedHome);
    writeFileSync(external, '{"sentinel":true}\n');
    symlinkSync(external, join(linkedHome, 'fleet.lock'));
    await assert.rejects(
      updateLockForPlugin('install', 'claude-code', 'unsafe@market', linkedHome),
      /fleet\.lock is unavailable|non-regular fleet\.lock target/,
    );
    assert.equal(lstatSync(join(linkedHome, 'fleet.lock')).isSymbolicLink(), true);
    assert.equal(readFileSync(external, 'utf8'), '{"sentinel":true}\n');

    const danglingHome = join(dir, 'dangling-home');
    mkdirSync(danglingHome);
    symlinkSync(join(dir, 'missing-lock'), join(danglingHome, 'fleet.lock'));
    assert.equal((await readLockState(danglingHome)).status, 'unavailable');
    await assert.rejects(
      updateLockForPlugin('install', 'claude-code', 'unsafe@market', danglingHome),
      /fleet\.lock is unavailable/,
    );
    assert.equal(lstatSync(join(danglingHome, 'fleet.lock')).isSymbolicLink(), true);
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

test('lock: pre-existing damaged provenance blocks mutation', async () => {
  const dir = tmp();
  try {
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'fleet.lock'), '{broken');
    const a = hermeticClaude(dir);
    const plan = await planInstall(
      [a],
      { transport: 'stdio', command: 'npx', args: ['-y', 'x'] },
      'x',
      'user',
      ['claude-code'],
    );
    const res = await execute([a], plan, { commit: true, fleetHome: home });
    assert.equal(res.applied.length, 0);
    assert.match(res.error ?? '', /fleet\.lock provenance is unavailable or malformed/);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8')), { mcpServers: {} });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lock: write failure after preflight degrades to lockWarning, apply still succeeds', async () => {
  const dir = tmp();
  try {
    const home = join(dir, 'home');
    const a = hermeticClaude(dir);
    const originalValidate = a.validate.bind(a);
    let plantedFailure = false;
    a.validate = (content: string): void => {
      originalValidate(content);
      if (!plantedFailure) {
        plantedFailure = true;
        mkdirSync(join(home, 'fleet.lock'), { recursive: true });
      }
    };
    const plan = await planInstall(
      [a],
      { transport: 'stdio', command: 'npx', args: ['-y', 'x'] },
      'x',
      'user',
      ['claude-code'],
    );
    const res = await execute([a], plan, { commit: true, fleetHome: home });
    assert.equal(res.applied.length, 1);
    assert.match(res.lockWarning ?? '', /fleet.lock update failed/);
    assert.equal(res.error, undefined);
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

test('lock: unknown trust evidence codes make provenance malformed', async () => {
  const dir = tmp();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'fleet.lock'),
      JSON.stringify({
        version: 1,
        entries: {
          bad: {
            kind: 'mcp-server',
            name: 'demo',
            agent: 'codex',
            scope: 'user',
            origin: { type: 'manual' },
            installedAt: '2026-08-20T00:00:00.000Z',
            op: 'install',
            trust: { level: 'caution', reasons: ['opaque'], reasonCodes: ['NOT_A_TRUST_CODE'] },
          },
        },
      }),
    );
    assert.equal((await readLockState(dir)).status, 'malformed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lock: trust level and evidence cardinality agree while legacy caution remains readable', async () => {
  const dir = tmp();
  try {
    mkdirSync(dir, { recursive: true });
    const entry = {
      kind: 'mcp-server',
      name: 'demo',
      agent: 'codex',
      scope: 'user',
      origin: { type: 'manual' },
      installedAt: '2026-08-20T00:00:00.000Z',
      op: 'install',
    };
    for (const trust of [
      { level: 'ok', reasons: [], reasonCodes: ['PACKAGE_UNPINNED'] },
      { level: 'caution', reasons: ['unpinned'], reasonCodes: [] },
      { level: 'ok', reasons: ['contradiction'], reasonCodes: [] },
    ]) {
      writeFileSync(
        join(dir, 'fleet.lock'),
        JSON.stringify({ version: 1, entries: { demo: { ...entry, trust } } }),
      );
      assert.equal((await readLockState(dir)).status, 'malformed');
    }
    writeFileSync(
      join(dir, 'fleet.lock'),
      JSON.stringify({
        version: 1,
        entries: { demo: { ...entry, trust: { level: 'caution', reasons: ['legacy evidence'] } } },
      }),
    );
    assert.equal((await readLockState(dir)).status, 'available');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lock: legacy plugin provenance is canonicalized by marketplace and removed exactly', async () => {
  const dir = tmp();
  try {
    const legacyKey = lockKey('plugin', 'shared', 'claude-code');
    writeFileSync(
      join(dir, 'fleet.lock'),
      JSON.stringify({
        version: 1,
        entries: {
          [legacyKey]: {
            kind: 'plugin',
            name: 'shared',
            agent: 'claude-code',
            origin: { type: 'marketplace', selector: 'shared@official' },
            installedAt: new Date().toISOString(),
            op: 'install',
          },
        },
      }),
    );
    const canonical = lockKey('plugin', 'shared', 'claude-code', 'user', 'official');
    assert.equal((await readLock(dir)).entries[canonical]?.marketplace, 'official');
    await updateLockForPlugin('remove', 'claude-code', 'shared@official', dir);
    assert.equal((await readLock(dir)).entries[canonical], undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lock: explicit plugin marketplace must agree with its provenance selector', async () => {
  const dir = tmp();
  try {
    mkdirSync(dir, { recursive: true });
    const base = {
      kind: 'plugin',
      name: 'shared',
      agent: 'claude-code',
      scope: 'user',
      marketplace: 'official',
      installedAt: new Date().toISOString(),
      op: 'install',
    };
    for (const origin of [
      { type: 'marketplace', selector: 'shared@evil' },
      { type: 'marketplace', selector: 'other@official' },
      { type: 'manual' },
    ]) {
      writeFileSync(
        join(dir, 'fleet.lock'),
        JSON.stringify({ version: 1, entries: { plugin: { ...base, origin } } }),
      );
      assert.equal((await readLockState(dir)).status, 'malformed');
    }
    writeFileSync(
      join(dir, 'fleet.lock'),
      JSON.stringify({
        version: 1,
        entries: {
          plugin: { ...base, origin: { type: 'marketplace', selector: 'shared@official' } },
        },
      }),
    );
    assert.equal((await readLockState(dir)).status, 'available');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('lock: canonicalizes every stored key and rejects conflicting provenance collisions', async () => {
  const dir = tmp();
  try {
    const base = {
      kind: 'skill',
      name: 'safe',
      agent: 'codex',
      scope: 'user',
      origin: { type: 'dir', path: '/source' },
      installedAt: new Date().toISOString(),
      op: 'install',
    };
    writeFileSync(join(dir, 'fleet.lock'), JSON.stringify({ version: 1, entries: { bogus: base } }));
    const canonical = lockKey('skill', 'safe', 'codex', 'user');
    assert.deepEqual(Object.keys((await readLockState(dir)).lock.entries), [canonical]);

    writeFileSync(
      join(dir, 'fleet.lock'),
      JSON.stringify({
        version: 1,
        entries: {
          first: base,
          second: { ...base, auditId: 'different-provenance' },
        },
      }),
    );
    assert.equal((await readLockState(dir)).status, 'malformed');
    await assert.rejects(
      updateLockForPlugin('install', 'claude-code', 'safe@market', dir),
      /refusing provenance overwrite/,
    );
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

test('skill updates use the materialized origin hash for a symlink-root install', async () => {
  const dir = tmp();
  try {
    const home = join(dir, 'home');
    const adapter = hermeticClaude(dir);
    const physical = join(dir, 'physical-skill');
    const linked = join(dir, 'linked-skill');
    const matchingOldBytes = join(dir, 'skills', '.matching-old-bytes');
    mkdirSync(physical);
    writeFileSync(join(physical, 'SKILL.md'), 'v1');
    symlinkSync(physical, linked);
    const plan = await planInstallSkill(
      [adapter],
      { name: 'linked', dir: linked },
      'linked',
      ['claude-code'],
      { trustPolicy: 'warn' },
    );
    await execute([adapter], plan, { commit: true, fleetHome: home });
    const { skillUpdatesFromLock } = await import('../src/core/skill-updates.js');
    const { buildInventory } = await import('../src/core/inventory.js');

    assert.deepEqual(await skillUpdatesFromLock(await buildInventory([adapter]), home), []);
    mkdirSync(matchingOldBytes);
    writeFileSync(join(matchingOldBytes, 'SKILL.md'), 'v1');
    writeFileSync(join(physical, 'SKILL.md'), 'v2');
    assert.equal((await skillUpdatesFromLock(await buildInventory([adapter]), home))[0]?.state, 'update');

    const installed = join(dir, 'skills', 'linked');
    rmSync(installed, { recursive: true });
    symlinkSync(matchingOldBytes, installed);
    assert.equal(
      (await skillUpdatesFromLock(await buildInventory([adapter]), home))[0]?.state,
      'update+local-edits',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('skill updates compare canonical-v1 provenance with the legacy hash scheme', async () => {
  const dir = tmp();
  try {
    const home = join(dir, 'home');
    const adapter = hermeticClaude(dir);
    const source = join(dir, 'legacy-source');
    mkdirSync(source);
    writeFileSync(join(source, 'SKILL.md'), 'v1');
    const plan = await planInstallSkill(
      [adapter],
      { name: 'legacy', dir: source },
      'legacy',
      ['claude-code'],
      { trustPolicy: 'warn' },
    );
    await execute([adapter], plan, { commit: true, fleetHome: home });
    const lock = await readLock(home);
    const entry = lock.entries[lockKey('skill', 'legacy', 'claude-code')]!;
    const { hashDirLegacy } = await import('../src/core/fsutil.js');
    entry.hashScheme = 'canonical-v1';
    entry.contentHash = await hashDirLegacy(source);
    writeFileSync(join(home, 'fleet.lock'), JSON.stringify(lock));
    const { skillUpdatesFromLock } = await import('../src/core/skill-updates.js');
    const { buildInventory } = await import('../src/core/inventory.js');

    assert.deepEqual(await skillUpdatesFromLock(await buildInventory([adapter]), home), []);
    writeFileSync(join(source, 'SKILL.md'), 'v2');
    assert.equal((await skillUpdatesFromLock(await buildInventory([adapter]), home))[0]?.state, 'update');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
