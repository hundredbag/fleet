import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  lstatSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  lastDelegated,
  planPluginAction,
  planPluginActions,
  pluginCoordinate,
  readDelegatedLedger,
  repairDelegatedLedger,
  runDelegated,
} from '../src/core/delegate.js';
import type { AgentAdapter } from '../src/core/adapter.js';
import { FleetOperationError } from '../src/core/errors.js';

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

test('plugin coordinates keep the logical capability name separate from marketplace identity', () => {
  assert.deepEqual(pluginCoordinate('figma@official'), {
    name: 'figma',
    marketplace: 'official',
    selector: 'figma@official',
  });
  assert.deepEqual(pluginCoordinate('@scope/figma@team-market'), {
    name: '@scope/figma',
    marketplace: 'team-market',
    selector: '@scope/figma@team-market',
  });
  assert.deepEqual(pluginCoordinate('@scope/figma'), {
    name: '@scope/figma',
    selector: '@scope/figma',
  });
  assert.deepEqual(pluginCoordinate('figma', 'official'), {
    name: 'figma',
    marketplace: 'official',
    selector: 'figma@official',
  });
  assert.throws(
    () => pluginCoordinate('figma@wrong', 'official'),
    (error: unknown) => {
      assert.ok(error instanceof FleetOperationError);
      assert.equal(error.publicCode, 'INVALID_ARGUMENT');
      assert.match(error.message, /marketplace.*separate/i);
      return true;
    },
  );
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

test('planPluginActions: resolves only validated delegated targets before execution', async () => {
  const adapter = (
    id: string,
    delegated: boolean,
    installed = false,
    unsafe = false,
    runtimeStatus: 'available' | 'not-found' | 'unverifiable' = 'available',
  ): AgentAdapter => ({
    id,
    displayName: id,
    capabilitySupport: delegated
      ? { plugin: { inventory: 'supported', management: 'delegated' } }
      : { 'mcp-server': { inventory: 'supported', management: 'writable' } },
    async detect() {
      return {
        id,
        displayName: id,
        present: true,
        configPaths: [],
        ...(unsafe ? { configurationStatus: 'unavailable' as const } : {}),
        ...(runtimeStatus ? { runtimeStatus } : {}),
      };
    },
    async readInventory() {
      return installed
        ? [
            {
              kind: 'plugin' as const,
              name: 'demo',
              marketplace: 'official',
              agent: id,
              scope: 'user' as const,
              enabled: true,
              source: { file: 'fixture' },
            },
          ]
        : [];
    },
  });
  const adapters = [adapter('claude-code', true), adapter('custom-writer', false)];
  assert.deepEqual(
    (await planPluginActions(adapters, 'all', 'install', 'demo')).map((plan) => plan.agent),
    ['claude-code'],
  );
  await assert.rejects(
    planPluginActions(adapters, 'claude-code,custom-writer', 'install', 'demo'),
    /plugin-unsupported/,
  );
  const unsafe = [adapter('claude-code', true, false, true)];
  assert.deepEqual(await planPluginActions(unsafe, 'all', 'install', 'demo'), []);
  await assert.rejects(
    planPluginActions(unsafe, 'claude-code', 'install', 'demo'),
    /agent state unavailable/,
  );
  const brokenInventory = adapter('claude-code', true) as AgentAdapter & {
    readPluginInventory?: AgentAdapter['readPluginInventory'];
  };
  brokenInventory.readInventory = async () => {
    throw new Error('semantic config damage');
  };
  brokenInventory.readPluginInventory = async () => [];
  await assert.rejects(
    planPluginActions([brokenInventory], 'claude-code', 'install', 'demo'),
    /agent state unavailable/,
  );
  const runtimeMissing = [adapter('claude-code', true, false, false, 'not-found')];
  assert.deepEqual(await planPluginActions(runtimeMissing, 'all', 'install', 'demo'), []);
  await assert.rejects(
    planPluginActions(runtimeMissing, 'claude-code', 'install', 'demo'),
    /runtime unavailable/,
  );
  await assert.rejects(planPluginActions([], 'all', 'install', '../unsafe'), /unsafe plugin selector/);
  await assert.rejects(
    planPluginActions([adapter('claude-code', true, true)], 'claude-code', 'install', 'demo@official'),
    /already installed/,
  );
  assert.equal(
    (await planPluginActions([adapter('claude-code', true, true)], 'claude-code', 'install', 'demo@other'))
      .length,
    1,
  );
  await assert.rejects(
    planPluginActions([adapter('claude-code', true)], 'claude-code', 'remove', 'demo'),
    /not installed/,
  );
  assert.equal(
    (await planPluginActions([adapter('claude-code', true, true)], 'claude-code', 'remove', 'demo'))[0]
      ?.selector,
    'demo@official',
  );
  const nonUser = adapter('claude-code', true, true);
  nonUser.readInventory = async () => [
    {
      kind: 'plugin',
      name: 'demo',
      marketplace: 'official',
      agent: 'claude-code',
      scope: 'local',
      enabled: true,
      source: { file: 'fixture' },
    },
  ];
  await assert.rejects(
    planPluginActions([nonUser], 'claude-code', 'remove', 'demo@official'),
    /supported user scope/,
  );

  const shiftingScope = adapter('claude-code', true);
  let shifted = false;
  shiftingScope.readInventory = async () =>
    shifted
      ? [
          {
            kind: 'plugin',
            name: 'demo',
            marketplace: 'official',
            agent: 'claude-code',
            scope: 'local',
            enabled: true,
            source: { file: 'fixture' },
          },
        ]
      : [];
  const [scopePlan] = await planPluginActions([shiftingScope], 'claude-code', 'install', 'demo@official');
  shifted = true;
  const scopeHome = mkdtempSync(join(tmpdir(), 'fleet-delegate-scope-'));
  let vendorCalls = 0;
  try {
    await assert.rejects(
      runDelegated(scopePlan!, {
        commit: true,
        fleetHome: scopeHome,
        runner: async () => {
          vendorCalls++;
          return { exitCode: 0, output: 'not reached' };
        },
      }),
      /supported user scope|revalidated/,
    );
    assert.equal(vendorCalls, 0);
  } finally {
    rmSync(scopeHome, { recursive: true, force: true });
  }
});

test('runDelegated clears its pending marker when the vendor process never starts', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-delegate-enoent-'));
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = dir;
    const plan = planPluginAction('claude-code', 'install', 'demo@official');
    plan.preState = 'absent';
    plan.readPluginState = async () => 'absent';
    const home = join(dir, 'fleet-home');
    await assert.rejects(
      runDelegated(plan, { commit: true, fleetHome: home }),
      /vendor executable could not be started/,
    );
    const ledger = await readDelegatedLedger(home);
    assert.equal(
      ledger.records.some((record) => record.pending),
      false,
    );
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runDelegated clears pending when an injected runner reports ENOENT before spawn', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-delegate-runner-enoent-'));
  try {
    const plan = planPluginAction('claude-code', 'install', 'demo@official');
    plan.preState = 'absent';
    plan.readPluginState = async () => 'absent';
    const notFound = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    await assert.rejects(
      runDelegated(plan, {
        commit: true,
        fleetHome: dir,
        runner: async () => {
          throw notFound;
        },
      }),
      /vendor executable could not be started/,
    );
    const ledger = await readDelegatedLedger(dir);
    assert.equal(
      ledger.records.some((record) => record.pending),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('planPluginActions: unqualified remove refuses ambiguous marketplace identity', async () => {
  const pluginAdapter: AgentAdapter = {
    id: 'claude-code',
    displayName: 'Claude Code',
    capabilitySupport: { plugin: { inventory: 'supported', management: 'delegated' } },
    async detect() {
      return {
        id: this.id,
        displayName: this.displayName,
        present: true,
        configPaths: [],
        runtimeStatus: 'available',
      };
    },
    async readInventory() {
      return [];
    },
    async readPluginInventory() {
      return ['first', 'second'].map((marketplace) => ({
        kind: 'plugin' as const,
        name: 'shared',
        marketplace,
        agent: this.id,
        scope: 'user' as const,
        enabled: true,
        source: { file: 'fixture' },
      }));
    },
  };
  await assert.rejects(
    planPluginActions([pluginAdapter], 'claude-code', 'remove', 'shared'),
    (error: unknown) => {
      assert.ok(error instanceof FleetOperationError);
      assert.equal(error.publicCode, 'INVALID_ARGUMENT');
      assert.match(error.message, /multiple marketplaces.*marketplace is required/);
      return true;
    },
  );
});

test(
  'runDelegated stops before the vendor when its state-home parent is not durable',
  { skip: process.platform === 'win32' },
  async () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-del-durable-'));
    const stateParent = join(root, 'state');
    const home = join(stateParent, 'fleet');
    mkdirSync(home, { recursive: true });
    const adapter: AgentAdapter = {
      id: 'claude-code',
      displayName: 'Claude Code',
      capabilitySupport: { plugin: { inventory: 'supported', management: 'delegated' } },
      async detect() {
        return {
          id: this.id,
          displayName: this.displayName,
          present: true,
          configPaths: [],
          runtimeStatus: 'available',
        };
      },
      async readInventory() {
        return [];
      },
    };
    const [plan] = await planPluginActions([adapter], 'claude-code', 'install', 'demo@official');
    let calls = 0;
    chmodSync(stateParent, 0o300);
    try {
      await assert.rejects(
        runDelegated(plan!, {
          commit: true,
          fleetHome: home,
          runner: async () => {
            calls++;
            return { exitCode: 0, output: 'must not run' };
          },
        }),
        /EACCES|permission denied/i,
      );
      assert.equal(calls, 0);
    } finally {
      chmodSync(stateParent, 0o700);
      rmSync(root, { recursive: true, force: true });
    }
  },
);

test('runDelegated: preview never spawns; commit runs runner + appends ledger', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fleet-del-'));
  try {
    let calls = 0;
    let installed = false;
    const runner = async (argv: string[]) => {
      calls++;
      assert.equal(argv[0], 'claude');
      installed = true;
      return { exitCode: 0, output: 'ok\n' };
    };
    const pluginAdapter: AgentAdapter = {
      id: 'claude-code',
      displayName: 'Claude Code',
      capabilitySupport: { plugin: { inventory: 'supported', management: 'delegated' } },
      async detect() {
        return {
          id: this.id,
          displayName: this.displayName,
          present: true,
          configPaths: [],
          runtimeStatus: 'available',
        };
      },
      async readInventory() {
        return installed
          ? [
              {
                kind: 'plugin' as const,
                name: 'figma',
                marketplace: 'official',
                agent: this.id,
                scope: 'user' as const,
                enabled: true,
                source: { file: 'fixture' },
              },
            ]
          : [];
      },
    };
    const [plan] = await planPluginActions([pluginAdapter], 'claude-code', 'install', 'figma@official');

    const preview = await runDelegated(plan!, { commit: false, fleetHome: home, runner });
    assert.equal(preview.status, 'preview');
    assert.equal(calls, 0); // never spawned
    assert.equal(preview.command, 'claude plugin install figma@official');

    const applied = await runDelegated(plan!, { commit: true, fleetHome: home, runner });
    assert.equal(applied.status, 'applied');
    assert.equal(applied.effect, 'changed');
    assert.equal(calls, 1);
    const ledger = readFileSync(join(home, 'delegated.jsonl'), 'utf8').trim().split('\n');
    assert.equal(ledger.length, 1);
    assert.match(ledger[0]!, /figma@official/);
    assert.equal(statSync(join(home, 'delegated.jsonl')).mode & 0o777, 0o600);

    installed = false;
    const failed = await runDelegated(plan!, {
      commit: true,
      fleetHome: home,
      runner: async () => ({ exitCode: 1, output: 'credential is OPAQUE_LEDGER_SECRET' }),
    });
    assert.equal(failed.status, 'failed');
    assert.equal(Object.hasOwn(failed, 'undoCommand'), false);
    assert.equal(failed.outputTail, 'credential is OPAQUE_LEDGER_SECRET');
    assert.equal(readFileSync(join(home, 'delegated.jsonl'), 'utf8').includes('OPAQUE_LEDGER_SECRET'), false);

    installed = false;
    const unchanged = await runDelegated(plan!, {
      commit: true,
      fleetHome: home,
      runner: async () => ({ exitCode: 0, output: 'vendor no-op' }),
    });
    assert.equal(unchanged.status, 'nothing-to-do');
    assert.equal(unchanged.effect, 'unchanged');
    assert.equal(Object.hasOwn(unchanged, 'undoCommand'), false);
    const records = await readDelegatedLedger(home);
    assert.equal(records.records.at(-1)?.effect, 'unchanged');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('runDelegated revalidates full agent state under the commit lock', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fleet-del-revalidate-'));
  let healthy = true;
  let calls = 0;
  const adapter: AgentAdapter = {
    id: 'claude-code',
    displayName: 'Claude Code',
    capabilitySupport: { plugin: { inventory: 'supported', management: 'delegated' } },
    async detect() {
      return {
        id: this.id,
        displayName: this.displayName,
        present: true,
        configPaths: [],
        runtimeStatus: 'available',
        configurationStatus: 'configured',
      };
    },
    async readInventory() {
      if (!healthy) throw new Error('settings became malformed');
      return [];
    },
  };
  try {
    const [plan] = await planPluginActions([adapter], 'claude-code', 'install', 'demo@official');
    healthy = false;
    await assert.rejects(
      runDelegated(plan!, {
        commit: true,
        fleetHome: home,
        runner: async () => {
          calls++;
          return { exitCode: 0, output: '' };
        },
      }),
      /agent state unavailable/,
    );
    assert.equal(calls, 0);
    assert.equal(existsSync(join(home, 'delegated-pending')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('runDelegated: a symlinked ledger is refused before the vendor process', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-del-link-'));
  try {
    const home = join(root, 'home');
    const external = join(root, 'external-ledger');
    mkdirSync(home);
    writeFileSync(external, 'sentinel\n');
    symlinkSync(external, join(home, 'delegated.jsonl'));
    let calls = 0;
    const plan = planPluginAction('claude-code', 'install', 'figma@official');
    plan.preState = 'absent';
    plan.readPluginState = async () => 'absent';
    await assert.rejects(
      runDelegated(plan, {
        commit: true,
        fleetHome: home,
        runner: async () => {
          calls++;
          return { exitCode: 0, output: '' };
        },
      }),
      /delegated history is unavailable or malformed/,
    );
    assert.equal(calls, 0);
    assert.equal(readFileSync(external, 'utf8'), 'sentinel\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runDelegated: a dangling ledger symlink is unavailable rather than absent', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-del-dangling-'));
  try {
    const home = join(root, 'home');
    mkdirSync(home);
    symlinkSync(join(root, 'missing-ledger'), join(home, 'delegated.jsonl'));
    let calls = 0;
    const plan = planPluginAction('claude-code', 'install', 'figma@official');
    plan.preState = 'absent';
    plan.readPluginState = async () => 'absent';
    await assert.rejects(
      runDelegated(plan, {
        commit: true,
        fleetHome: home,
        runner: async () => {
          calls++;
          return { exitCode: 0, output: '' };
        },
      }),
      /delegated history is unavailable or malformed/,
    );
    assert.equal(calls, 0);
    assert.equal(lstatSync(join(home, 'delegated.jsonl')).isSymbolicLink(), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('runDelegated: refuses unavailable or malformed history before spawning vendor', async () => {
  for (const obstruction of ['directory', 'malformed'] as const) {
    const home = mkdtempSync(join(tmpdir(), `fleet-del-${obstruction}-`));
    try {
      const ledger = join(home, 'delegated.jsonl');
      if (obstruction === 'directory') mkdirSync(ledger);
      else writeFileSync(ledger, '{truncated\n');
      const plan = planPluginAction('claude-code', 'install', 'safe-plugin');
      plan.preState = 'absent';
      plan.readPluginState = async () => 'absent';
      let calls = 0;
      await assert.rejects(
        runDelegated(plan, {
          commit: true,
          fleetHome: home,
          runner: async () => {
            calls++;
            return { exitCode: 0, output: '' };
          },
        }),
        /delegated history is unavailable or malformed/,
      );
      assert.equal(calls, 0);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  }
});

test('runDelegated: durable pending boundary survives an outcome-unknown vendor run', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fleet-del-pending-'));
  try {
    const plan = planPluginAction('claude-code', 'install', 'safe-plugin');
    plan.preState = 'absent';
    plan.readPluginState = async () => 'absent';
    let calls = 0;
    await assert.rejects(
      runDelegated(plan, {
        commit: true,
        fleetHome: home,
        runner: async () => {
          calls++;
          throw new Error('spawn outcome unknown');
        },
      }),
      /spawn outcome unknown/,
    );
    assert.equal(calls, 1);
    const pending = await readDelegatedLedger(home);
    assert.equal(pending.status, 'available');
    assert.equal(pending.records.length, 1);
    assert.equal(pending.records[0]?.pending, true);
    assert.equal(pending.records[0]?.effect, 'unverifiable');
    assert.equal(existsSync(join(home, 'delegated-pending', `${pending.records[0]!.id}.json`)), true);
    const { apiActivity } = await import('../src/web/api.js');
    assert.equal((await apiActivity(home)).items[0]?.outcome, 'unknown');

    // An unresolved outcome is a rollback boundary and also prevents another
    // vendor mutation from obscuring it.
    await assert.rejects(
      runDelegated(plan, {
        commit: true,
        fleetHome: home,
        runner: async () => {
          calls++;
          return { exitCode: 0, output: '' };
        },
      }),
      /pending verification/,
    );
    assert.equal(calls, 1);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('runDelegated: shared operation lock blocks duplicate delegated and concurrent core writes', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fleet-del-lock-'));
  try {
    let installed = false;
    const plan = planPluginAction('claude-code', 'install', 'safe-plugin');
    plan.preState = 'absent';
    plan.readPluginState = async () => (installed ? 'present' : 'absent');
    let enter!: () => void;
    const entered = new Promise<void>((resolve) => (enter = resolve));
    let finish!: () => void;
    const blocked = new Promise<void>((resolve) => (finish = resolve));
    let calls = 0;
    const first = runDelegated(plan, {
      commit: true,
      fleetHome: home,
      runner: async () => {
        calls++;
        enter();
        await blocked;
        installed = true;
        return { exitCode: 0, output: '' };
      },
    });
    await entered;

    await assert.rejects(
      runDelegated(plan, {
        commit: true,
        fleetHome: home,
        runner: async () => {
          calls++;
          return { exitCode: 0, output: '' };
        },
      }),
      /another operation holds the lock/,
    );
    const { applyChanges } = await import('../src/core/writer.js');
    const coreFile = join(home, 'core.json');
    await assert.rejects(
      applyChanges(
        [
          {
            agent: 'codex',
            op: 'install',
            name: 'core',
            scope: 'user',
            file: coreFile,
            newContent: '{}',
          },
        ],
        () => {},
        { fleetHome: home },
      ),
      /another operation holds the lock/,
    );
    assert.equal(existsSync(coreFile), false);
    assert.equal(calls, 1);
    finish();
    assert.equal((await first).status, 'applied');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('runDelegated: pre-existing damaged fleet.lock blocks the vendor', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fleet-del-lock-damaged-'));
  try {
    writeFileSync(join(home, 'fleet.lock'), '{broken');
    const plan = planPluginAction('claude-code', 'install', 'safe-plugin@official');
    plan.preState = 'absent';
    plan.readPluginState = async () => 'absent';
    let calls = 0;
    await assert.rejects(
      runDelegated(plan, {
        commit: true,
        fleetHome: home,
        runner: async () => {
          calls++;
          return { exitCode: 0, output: '' };
        },
      }),
      /fleet\.lock provenance is unavailable or malformed/,
    );
    assert.equal(calls, 0);
    assert.equal(existsSync(join(home, 'delegated.jsonl')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('delegated ledger reads are side-effect free; explicit repair migrates legacy fields and permissions', async () => {
  const home = mkdtempSync(join(tmpdir(), 'fleet-del-legacy-'));
  try {
    const file = join(home, 'delegated.jsonl');
    writeFileSync(
      file,
      JSON.stringify({
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        time: '2026-08-19T00:00:00.000Z',
        agent: 'claude-code',
        op: 'install',
        selector: 'legacy@official',
        argv: ['claude', 'plugin', 'install', 'legacy@official'],
        undoArgv: ['claude', 'plugin', 'uninstall', 'legacy@official'],
        exitCode: 0,
        effect: 'unchanged',
        outputTail: 'OPAQUE_LEGACY_VENDOR_OUTPUT',
      }) + '\n',
    );
    chmodSync(file, 0o644);
    const latest = await lastDelegated(home);
    assert.equal(readFileSync(file, 'utf8').includes('OPAQUE_LEGACY_VENDOR_OUTPUT'), true);
    assert.equal(statSync(file).mode & 0o777, 0o644);

    await repairDelegatedLedger(home);
    const migrated = readFileSync(file, 'utf8');
    assert.equal(latest?.selector, 'legacy@official');
    assert.equal(latest?.effect, 'unverifiable');
    assert.equal(Object.hasOwn(latest ?? {}, 'undoArgv'), false);
    assert.equal(migrated.includes('OPAQUE_LEGACY_VENDOR_OUTPUT'), false);
    assert.equal(migrated.includes('outputTail'), false);
    assert.equal(statSync(file).mode & 0o777, 0o600);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
