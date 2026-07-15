import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { planPluginAction, runDelegated } from '../src/core/delegate.js';

test('planPluginAction: vendor argv table + undo', () => {
  assert.deepEqual(planPluginAction('claude-code', 'install', 'figma@official'), {
    agent: 'claude-code',
    op: 'install',
    selector: 'figma@official',
    argv: ['claude', 'plugin', 'install', 'figma@official'],
    undoArgv: ['claude', 'plugin', 'uninstall', 'figma@official'],
  });
  assert.deepEqual(planPluginAction('codex', 'remove', 'linear').argv, [
    'codex',
    'plugin',
    'remove',
    'linear',
  ]);
});

test('planPluginAction: rejects unsafe selectors + unknown agents (trust boundary)', () => {
  for (const bad of [
    '-y',
    '--force',
    'a b',
    'x;rm -rf',
    'x`y`',
    '$(x)',
    '',
    'x\ny',
    'x\ty',
    '한글',
    'a/../b',
  ]) {
    assert.throws(() => planPluginAction('codex', 'install', bad), /unsafe|selector/);
  }
  assert.throws(() => planPluginAction('hermes', 'install', 'x'), /no plugin CLI/);
});

test('runDelegated: preview never spawns; commit runs runner + appends ledger', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fleet-del-'));
  try {
    let calls = 0;
    const runner = async (argv: string[]) => {
      calls++;
      assert.equal(argv[0], 'claude');
      return { exitCode: 0, output: 'ok\n' };
    };
    const plan = planPluginAction('claude-code', 'install', 'figma@official');

    const preview = await runDelegated(plan, { commit: false, fleetHome: home, runner });
    assert.equal(preview.status, 'preview');
    assert.equal(calls, 0); // never spawned
    assert.equal(preview.command, 'claude plugin install figma@official');

    const applied = await runDelegated(plan, { commit: true, fleetHome: home, runner });
    assert.equal(applied.status, 'applied');
    assert.equal(calls, 1);
    const ledger = readFileSync(join(home, 'delegated.jsonl'), 'utf8').trim().split('\n');
    assert.equal(ledger.length, 1);
    assert.match(ledger[0]!, /figma@official/);

    const failed = await runDelegated(plan, {
      commit: true,
      fleetHome: home,
      runner: async () => ({ exitCode: 1, output: 'boom' }),
    });
    assert.equal(failed.status, 'failed');
    assert.equal(failed.outputTail, 'boom');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
