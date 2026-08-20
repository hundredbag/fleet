import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPluginAdapters } from '../src/core/plugins.js';
import { loadAdapters } from '../src/core/registry.js';
import { DEFAULT_CONFIG, loadConfig } from '../src/core/config.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentAdapter } from '../src/core/adapter.js';

const fakeAdapter = (id: string): AgentAdapter => ({
  contractVersion: 1,
  id,
  displayName: id,
  capabilitySupport: {},
  async detect() {
    return { id, displayName: id, present: false, configPaths: [] };
  },
  async readInventory() {
    return [];
  },
});

test('loadPluginAdapters: loads instance + factory (sync/async) exports; skips invalid & failed imports', async () => {
  const importer = async (spec: string): Promise<unknown> => {
    if (spec === 'inst') return { default: fakeAdapter('a') };
    if (spec === 'factory') return { default: () => fakeAdapter('b') };
    if (spec === 'async-factory') return { default: async () => fakeAdapter('c') };
    if (spec === 'bad') return { default: { nope: true } };
    throw new Error('module not found');
  };
  const got = await loadPluginAdapters(['inst', 'factory', 'async-factory', 'bad', 'missing'], importer);
  assert.deepEqual(
    got.map((a) => a.id),
    ['a', 'b', 'c'], // bad export + failed import skipped, no throw
  );
});

test('loadPluginAdapters: a throwing/rejecting factory is skipped (never crashes)', async () => {
  const importer = async (spec: string): Promise<unknown> => {
    if (spec === 'boom')
      return {
        default: () => {
          throw new Error('sync throw');
        },
      };
    if (spec === 'reject')
      return {
        default: async () => {
          throw new Error('async reject');
        },
      };
    if (spec === 'ok') return { default: fakeAdapter('ok') };
    throw new Error('x');
  };
  const got = await loadPluginAdapters(['boom', 'reject', 'ok'], importer);
  assert.deepEqual(
    got.map((a) => a.id),
    ['ok'],
  );
});

test('loadPluginAdapters: accepts a namespace-shaped module (adapter fields on the module)', async () => {
  const importer = async (): Promise<unknown> => fakeAdapter('ns'); // no `default`
  const got = await loadPluginAdapters(['ns'], importer);
  assert.deepEqual(
    got.map((a) => a.id),
    ['ns'],
  );
});

test('loadPluginAdapters: skips a module missing displayName (contract violation)', async () => {
  const importer = async (): Promise<unknown> => ({
    default: {
      id: 'x',
      async detect() {},
      async readInventory() {
        return [];
      },
    },
  });
  const got = await loadPluginAdapters(['x'], importer);
  assert.equal(got.length, 0);
});

test('loadPluginAdapters: requires adapter contract v1 and rejects contradictory support metadata', async () => {
  const diagnostics: Array<{ index: number; reason: string }> = [];
  const importer = async (spec: string): Promise<unknown> => {
    if (spec === 'legacy') {
      const { contractVersion: _version, ...legacy } = fakeAdapter('legacy');
      return { default: legacy };
    }
    if (spec === 'bad-support')
      return {
        default: {
          ...fakeAdapter('bad-support'),
          capabilitySupport: {
            skill: { inventory: 'unsupported', management: 'writable' },
          },
        },
      };
    if (spec === 'inherited-support') {
      const inherited = Object.create({
        'mcp-server': { inventory: 'supported', management: 'writable' },
      });
      return { default: { ...fakeAdapter('inherited-support'), capabilitySupport: inherited } };
    }
    if (spec === 'weird-enum') {
      return {
        default: {
          ...fakeAdapter('weird-enum'),
          capabilitySupport: {
            skill: {
              inventory: { toString: () => 'supported' },
              management: { toString: () => 'read-only' },
            },
          },
        },
      };
    }
    if (spec === 'malformed-v1') {
      const { readInventory: _readInventory, ...malformed } = fakeAdapter('malformed-v1');
      return { default: malformed };
    }
    return {
      default: {
        ...fakeAdapter('future-shape'),
        capabilitySupport: {
          command: { inventory: 'supported', management: 'read-only' },
        },
      },
    };
  };
  const got = await loadPluginAdapters(
    ['legacy', 'bad-support', 'future-shape', 'inherited-support', 'weird-enum', 'malformed-v1'],
    importer,
    (diagnostic) => diagnostics.push(diagnostic),
  );
  assert.deepEqual(got, []);
  assert.deepEqual(diagnostics, [
    { index: 0, reason: 'unsupported-contract' },
    { index: 1, reason: 'invalid-contract' },
    { index: 2, reason: 'invalid-contract' },
    { index: 3, reason: 'invalid-contract' },
    { index: 4, reason: 'invalid-contract' },
    { index: 5, reason: 'invalid-contract' },
  ]);
});

test('loadPluginAdapters: empty list short-circuits', async () => {
  let called = false;
  await loadPluginAdapters([], async () => {
    called = true;
    return {};
  });
  assert.equal(called, false);
});

test('loadPluginAdapters: a module or factory that never settles is diagnosed and skipped', async () => {
  const diagnostics: Array<{ index: number; reason: string }> = [];
  let lateFactoryCalls = 0;
  const importer = async (spec: string): Promise<unknown> => {
    if (spec === 'late-import') {
      return new Promise((resolve) =>
        setTimeout(
          () =>
            resolve({
              default: () => {
                lateFactoryCalls++;
                return fakeAdapter('must-not-load');
              },
            }),
          30,
        ),
      );
    }
    if (spec === 'hung-factory') return { default: () => new Promise(() => {}) };
    return { default: fakeAdapter('after-timeout') };
  };
  const got = await loadPluginAdapters(
    ['late-import', 'hung-factory', 'ok'],
    importer,
    (diagnostic) => diagnostics.push(diagnostic),
    undefined,
    10,
  );
  await new Promise((resolve) => setTimeout(resolve, 35));
  assert.deepEqual(
    got.map((adapter) => adapter.id),
    ['after-timeout'],
  );
  assert.equal(lateFactoryCalls, 0);
  assert.deepEqual(diagnostics, [
    { index: 0, reason: 'load-failed' },
    { index: 1, reason: 'load-failed' },
  ]);
});

test('loadAdapters: built-ins + non-colliding plugins; a shadowing plugin is ignored', async () => {
  const importer = async (spec: string): Promise<unknown> => {
    if (spec === 'shadow') return { default: fakeAdapter('claude-code') }; // collides with a built-in
    if (spec === 'extra') return { default: fakeAdapter('hermes') };
    throw new Error('x');
  };
  const diagnostics: Array<{ index: number; reason: string }> = [];
  const adapters = await loadAdapters(
    { ...DEFAULT_CONFIG, adapterModules: ['shadow', 'extra'] },
    importer,
    (diagnostic) => diagnostics.push(diagnostic),
  );
  const ids = adapters.map((a) => a.id);
  assert.ok(ids.includes('claude-code') && ids.includes('codex')); // built-ins present
  assert.ok(ids.includes('hermes')); // non-colliding plugin added
  assert.equal(ids.filter((x) => x === 'claude-code').length, 1); // shadow did not duplicate/override
  assert.deepEqual(diagnostics, [{ index: 0, reason: 'shadowed' }]);
});

test('loadAdapters: duplicate plugin ids are deduped (first wins)', async () => {
  const opaqueId = 'OPAQUE_ADAPTER_ID_9482';
  const importer = async (spec: string): Promise<unknown> =>
    spec === 'a' ? { default: fakeAdapter(opaqueId) } : { default: fakeAdapter(opaqueId) };
  let diagnostic = '';
  const original = process.stderr.write;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    diagnostic += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  let adapters: AgentAdapter[];
  try {
    adapters = await loadAdapters({ ...DEFAULT_CONFIG, adapterModules: ['a', 'b'] }, importer);
  } finally {
    process.stderr.write = original;
  }
  assert.equal(adapters.filter((x) => x.id === opaqueId).length, 1);
  assert.match(diagnostic, /ADAPTER_DUPLICATE/);
  assert.equal(diagnostic.includes(opaqueId), false);
});

test('loadAdapters: config agents is an active-adapter allowlist with null/all and empty/none semantics', async () => {
  assert.deepEqual(
    (await loadAdapters({ ...DEFAULT_CONFIG, agents: ['codex'] })).map((adapter) => adapter.id),
    ['codex'],
  );
  assert.deepEqual(await loadAdapters({ ...DEFAULT_CONFIG, agents: [] }), []);
  assert.deepEqual(
    (await loadAdapters({ ...DEFAULT_CONFIG, agents: null })).map((adapter) => adapter.id),
    ['claude-code', 'codex'],
  );
});

test('team policy can prevent BYO module code from being imported at all', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-team-adapter-'));
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ adapterModules: ['custom'] }));
    writeFileSync(join(dir, 'team-policy.json'), JSON.stringify({ version: 1, allowAdapterModules: false }));
    let imported = false;
    const adapters = await loadAdapters(loadConfig(dir), async () => {
      imported = true;
      return { default: fakeAdapter('custom') };
    });
    assert.equal(imported, false);
    assert.deepEqual(
      adapters.map((adapter) => adapter.id),
      ['claude-code', 'codex'],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
