import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, chmodSync } from 'node:fs';
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

// ── dual-review round fixes ─────────────────────────────────────────────────

test('doctor: exact corrupt-line denominator (1 valid + 1 corrupt = 1/2)', async () => {
  const dir = tmp();
  try {
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'audit.jsonl'),
      '{"id":"a","op":"install","backup":"","existedBefore":false}\n{corrupt\n',
    );
    const r = await runDoctor({ fleetHome: home, adapters: [], config: DEFAULT_CONFIG });
    const f = r.findings.find((x) => x.message.includes('corrupt lines'));
    assert.match(f?.message ?? '', /1\/2 corrupt lines/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor: unreadable audit file → error FINDING, not a crash', async () => {
  const dir = tmp();
  try {
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'audit.jsonl'), '{}');
    chmodSync(join(home, 'audit.jsonl'), 0o000);
    const r = await runDoctor({ fleetHome: home, adapters: [], config: DEFAULT_CONFIG });
    assert.equal(r.exitCode, 2);
    assert.ok(r.findings.some((f) => f.level === 'error' && /audit log: check failed/.test(f.message)));
  } finally {
    chmodSync(join(dir, 'home', 'audit.jsonl'), 0o644);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor: broken config.json is reported (not silently healthy on defaults)', async () => {
  const dir = tmp();
  try {
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.json'), '{not json');
    const r = await runDoctor({ fleetHome: home, adapters: [] }); // no injected config → real path
    assert.ok(r.findings.some((f) => f.level === 'warn' && /invalid JSON/.test(f.message)));
    assert.ok(r.exitCode >= 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor: fresh lock is informational (exit stays 0)', async () => {
  const dir = tmp();
  try {
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, '.lock'), '1 1'); // fresh (mtime = now)
    const r = await runDoctor({ fleetHome: home, adapters: [], config: DEFAULT_CONFIG });
    assert.equal(r.exitCode, 0);
    assert.ok(r.findings.some((f) => /operation appears to be in progress/.test(f.message)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
