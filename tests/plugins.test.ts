import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadPluginAdapters } from '../src/core/plugins.js';
import { loadAdapters } from '../src/core/registry.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import type { AgentAdapter } from '../src/core/adapter.js';

const fakeAdapter = (id: string): AgentAdapter => ({
  id,
  displayName: id,
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

test('loadPluginAdapters: empty list short-circuits', async () => {
  let called = false;
  await loadPluginAdapters([], async () => {
    called = true;
    return {};
  });
  assert.equal(called, false);
});

test('loadAdapters: built-ins + non-colliding plugins; a shadowing plugin is ignored', async () => {
  const importer = async (spec: string): Promise<unknown> => {
    if (spec === 'shadow') return { default: fakeAdapter('claude-code') }; // collides with a built-in
    if (spec === 'extra') return { default: fakeAdapter('hermes') };
    throw new Error('x');
  };
  const adapters = await loadAdapters({ ...DEFAULT_CONFIG, adapterModules: ['shadow', 'extra'] }, importer);
  const ids = adapters.map((a) => a.id);
  assert.ok(ids.includes('claude-code') && ids.includes('codex')); // built-ins present
  assert.ok(ids.includes('hermes')); // non-colliding plugin added
  assert.equal(ids.filter((x) => x === 'claude-code').length, 1); // shadow did not duplicate/override
});

test('loadAdapters: duplicate plugin ids are deduped (first wins)', async () => {
  const importer = async (spec: string): Promise<unknown> =>
    spec === 'a' ? { default: fakeAdapter('dup') } : { default: fakeAdapter('dup') };
  const adapters = await loadAdapters({ ...DEFAULT_CONFIG, adapterModules: ['a', 'b'] }, importer);
  assert.equal(adapters.filter((x) => x.id === 'dup').length, 1);
});
