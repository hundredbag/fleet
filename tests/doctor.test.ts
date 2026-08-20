import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runDoctor } from '../src/core/doctor.js';
import type { AgentAdapter } from '../src/core/adapter.js';
import { DEFAULT_CONFIG } from '../src/core/config.js';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'fleet-doc-'));
}

const okAdapter = (id: string, present = true): AgentAdapter => ({
  id,
  displayName: id,
  detect: async () => ({
    id,
    displayName: id,
    present,
    configPaths: ['/x'],
    runtimeStatus: present ? 'available' : 'not-found',
    configurationStatus: present ? 'configured' : 'not-configured',
  }),
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
      id: '00000000-0000-4000-8000-000000000001',
      ts: 1,
      op: 'update',
      agent: 'x',
      name: 'n',
      kind: 'mcp-server',
      scope: 'user',
      file: '/f',
      backup: join(home, 'backups', 'gone.bak'), // referenced but missing
      existedBefore: true,
      wroteHash: 'a'.repeat(64),
      backupHash: 'b'.repeat(64),
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

test('doctor: unknown and unavailable selected feed sources are explicit findings', async () => {
  const dir = tmp();
  const pulseKey = process.env.PULSEMCP_API_KEY;
  try {
    delete process.env.PULSEMCP_API_KEY;
    const r = await runDoctor({
      fleetHome: join(dir, 'home'),
      adapters: [],
      config: { ...DEFAULT_CONFIG, feedSources: ['ghost-feed', 'hub', 'pulsemcp'] },
    });
    assert.equal(r.exitCode, 1);
    assert.ok(r.findings.some((finding) => finding.code === 'CONFIG_FEED_SOURCE_UNKNOWN'));
    assert.ok(
      r.findings.some(
        (finding) => finding.code === 'CONFIG_FEED_SOURCE_UNAVAILABLE' && finding.message.includes('hubUrl'),
      ),
    );
    assert.ok(
      r.findings.some(
        (finding) =>
          finding.code === 'CONFIG_FEED_SOURCE_UNAVAILABLE' && finding.message.includes('PULSEMCP_API_KEY'),
      ),
    );
  } finally {
    if (pulseKey === undefined) delete process.env.PULSEMCP_API_KEY;
    else process.env.PULSEMCP_API_KEY = pulseKey;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor: existing BYO adapter with invalid export is an adapter load error', async () => {
  const dir = tmp();
  try {
    const invalidModule = join(dir, 'invalid-adapter.mjs');
    writeFileSync(invalidModule, 'export default {};\n');
    const r = await runDoctor({
      fleetHome: join(dir, 'home'),
      config: { ...DEFAULT_CONFIG, adapterModules: [invalidModule] },
    });
    assert.equal(r.exitCode, 2);
    assert.ok(
      r.findings.some(
        (finding) =>
          finding.code === 'ADAPTER_LOAD_FAILED' &&
          finding.level === 'error' &&
          finding.message.includes('invalid export'),
      ),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor: adapter contract version and semantic violations have stable findings', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-doctor-contract-'));
  try {
    const result = await runDoctor({
      fleetHome: dir,
      adapters: [],
      config: DEFAULT_CONFIG,
      adapterLoadDiagnostics: [
        { index: 0, reason: 'unsupported-contract' },
        { index: 1, reason: 'invalid-contract' },
      ],
    });
    assert.ok(result.findings.some((finding) => finding.code === 'ADAPTER_CONTRACT_UNSUPPORTED'));
    assert.ok(result.findings.some((finding) => finding.code === 'ADAPTER_CONTRACT_INVALID'));
    assert.equal(result.exitCode, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor: damaged team policy is an error because effective activation is fail-closed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-doctor-team-policy-'));
  try {
    writeFileSync(join(dir, 'team-policy.json'), '{"version":2}');
    const result = await runDoctor({ fleetHome: dir, adapters: [] });
    assert.ok(result.findings.some((finding) => finding.code === 'TEAM_POLICY_INVALID'));
    assert.equal(result.exitCode, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor: a bare BYO module specifier is not mistaken for a missing filesystem path', async () => {
  const dir = tmp();
  try {
    const r = await runDoctor({
      fleetHome: join(dir, 'home'),
      adapters: [okAdapter('package-adapter')],
      config: { ...DEFAULT_CONFIG, adapterModules: ['package-adapter'] },
    });
    assert.equal(
      r.findings.some((finding) => finding.code === 'CONFIG_REFERENCE_MISSING'),
      false,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── dual-review round fixes ─────────────────────────────────────────────────

test('doctor: semantic audit validation counts parseable invalid rows as corrupt', async () => {
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
    assert.match(f?.message ?? '', /2\/2 corrupt lines/);
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

test('doctor: dangling state symlinks are unavailable rather than healthy absence', async () => {
  const dir = tmp();
  try {
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    symlinkSync(join(dir, 'missing-audit'), join(home, 'audit.jsonl'));
    symlinkSync(join(dir, 'missing-lock'), join(home, 'fleet.lock'));
    symlinkSync(join(dir, 'missing-delegated'), join(home, 'delegated.jsonl'));
    const r = await runDoctor({ fleetHome: home, adapters: [], config: DEFAULT_CONFIG });
    assert.equal(r.exitCode, 2);
    const messages = r.findings.map((finding) => finding.message).join('\n');
    assert.match(messages, /audit history unavailable/);
    assert.match(messages, /fleet\.lock: unavailable/);
    assert.match(messages, /delegated history unavailable/);
  } finally {
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

test('doctor: semantically invalid config reports mutations blocked', async () => {
  const dir = tmp();
  try {
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.json'), JSON.stringify({ trustPolicy: 'blok' }));
    const result = await runDoctor({ fleetHome: home, adapters: [] });
    assert.equal(result.exitCode, 1);
    assert.ok(result.findings.some((finding) => /invalid.*mutations are blocked/.test(finding.message)));
    assert.equal(
      result.findings.some((finding) => /config parsed/.test(finding.message)),
      false,
    );
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

test('doctor: uses one structured adapter snapshot and stable recovery codes', async () => {
  const dir = tmp();
  let detects = 0;
  let reads = 0;
  try {
    const adapter: AgentAdapter = {
      id: 'configured-agent',
      displayName: 'Configured agent',
      async detect() {
        detects++;
        return {
          id: this.id,
          displayName: this.displayName,
          present: true,
          configPaths: ['/local/config'],
          runtimeStatus: 'not-found',
          configurationStatus: 'configured',
        };
      },
      async readInventory() {
        reads++;
        return [];
      },
    };
    const result = await runDoctor({
      fleetHome: join(dir, 'home'),
      adapters: [adapter],
      config: DEFAULT_CONFIG,
    });
    assert.equal(detects, 1);
    assert.equal(reads, 1);
    const finding = result.findings.find((entry) => entry.agent === adapter.id);
    assert.equal(finding?.code, 'AGENT_RUNTIME_MISSING');
    assert.equal(finding?.recovery, 'CHECK_AGENT_INSTALLATION');
    assert.equal(result.exitCode, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor: adapter deadline becomes a structured detection failure', async () => {
  const dir = tmp();
  try {
    const adapter: AgentAdapter = {
      id: 'stalled-agent',
      displayName: 'Stalled agent',
      detect: () => new Promise(() => undefined),
      readInventory: async () => [],
    };
    const result = await runDoctor({
      fleetHome: join(dir, 'home'),
      adapters: [adapter],
      config: DEFAULT_CONFIG,
      adapterDeadlineMs: 5,
    });
    const finding = result.findings.find((entry) => entry.agent === adapter.id);
    assert.equal(finding?.code, 'AGENT_DETECT_FAILED');
    assert.equal(finding?.recovery, 'CHECK_ADAPTER');
    assert.equal(result.exitCode, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('doctor: semantic agent config damage is not reported as a healthy empty inventory', async () => {
  const dir = tmp();
  try {
    const executable = join(dir, 'claude');
    const config = join(dir, 'claude.json');
    writeFileSync(executable, '#!/bin/sh\n');
    chmodSync(executable, 0o755);
    writeFileSync(config, JSON.stringify({ mcpServers: [] }));
    const adapter = new ClaudeCodeAdapter(
      config,
      join(dir, 'skills'),
      join(dir, 'CLAUDE.md'),
      join(dir, 'settings.json'),
      join(dir, 'plugins'),
      executable,
    );
    const damaged = await runDoctor({
      fleetHome: join(dir, 'home'),
      adapters: [adapter],
      config: DEFAULT_CONFIG,
    });
    assert.equal(damaged.exitCode, 2);
    assert.equal(
      damaged.findings.find((finding) => finding.agent === 'claude-code')?.code,
      'AGENT_INVENTORY_FAILED',
    );

    writeFileSync(config, JSON.stringify({ mcpServers: {} }));
    const healthyEmpty = await runDoctor({
      fleetHome: join(dir, 'home'),
      adapters: [adapter],
      config: DEFAULT_CONFIG,
    });
    assert.equal(
      healthyEmpty.findings.find((finding) => finding.agent === 'claude-code')?.code,
      'AGENT_READY',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
