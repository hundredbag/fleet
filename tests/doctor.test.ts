import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor } from '../src/core/doctor.js';
import type { AgentAdapter } from '../src/core/adapter.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'fleet-doc-'));
}

const okAdapter = (id: string, present = true): AgentAdapter => ({
  id,
  displayName: id,
  detect: async () => ({ id, displayName: id, present, configPaths: ['/x'] }),
  readInventory: async () => [],
});

const brokenAdapter = (id: string): AgentAdapter => ({
  id,
  displayName: id,
  detect: async () => ({ id, displayName: id, present: true, configPaths: ['/x'] }),
  readInventory: async () => {
    throw new Error('config does not parse');
  },
});

test('doctor: healthy empty state → exit 0', async () => {
  const dir = tmp();
  try {
    const r = await runDoctor({
      fleetHome: join(dir, 'home'),
      adapters: [okAdapter('claude-code'), okAdapter('codex', false)],
      config: DEFAULT_CONFIG,
    });
    assert.equal(r.exitCode, 0);
    assert.ok(r.findings.every((f) => f.level === 'ok'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor: broken adapter inventory → exit 2 with pointer', async () => {
  const dir = tmp();
  try {
    const r = await runDoctor({
      fleetHome: join(dir, 'home'),
      adapters: [brokenAdapter('codex')],
      config: DEFAULT_CONFIG,
    });
    assert.equal(r.exitCode, 2);
    const f = r.findings.find((x) => x.level === 'error');
    assert.match(f?.message ?? '', /inventory read FAILED/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor: corrupt audit lines + missing backup + stale lock → warnings (exit 1)', async () => {
  const dir = tmp();
  try {
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    const rec = {
      id: 'a1',
      ts: 1,
      op: 'update',
      agent: 'x',
      name: 'n',
      file: '/f',
      backup: join(home, 'backups', 'gone.bak'), // referenced but missing
      existedBefore: true,
      wroteHash: 'h',
    };
    writeFileSync(join(home, 'audit.jsonl'), JSON.stringify(rec) + '\n{corrupt\n');
    const lock = join(home, '.lock');
    writeFileSync(lock, '1 1');
    utimesSync(lock, new Date(Date.now() - 3600_000), new Date(Date.now() - 3600_000)); // 1h old
    const r = await runDoctor({ fleetHome: home, adapters: [], config: DEFAULT_CONFIG });
    assert.equal(r.exitCode, 1);
    const msgs = r.findings.map((f) => f.message).join('\n');
    assert.match(msgs, /corrupt lines/);
    assert.match(msgs, /MISSING backup/);
    assert.match(msgs, /likely stale/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor: unknown config.agents id + missing adapter module → findings', async () => {
  const dir = tmp();
  try {
    const r = await runDoctor({
      fleetHome: join(dir, 'home'),
      adapters: [okAdapter('claude-code')],
      config: { ...DEFAULT_CONFIG, agents: ['claude-code', 'ghost'], adapterModules: ['/no/such.js'] },
    });
    assert.equal(r.exitCode, 2); // missing module = error
    const msgs = r.findings.map((f) => f.message).join('\n');
    assert.match(msgs, /"ghost" is not a known adapter/);
    assert.match(msgs, /does not exist/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
