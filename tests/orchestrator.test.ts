import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { GeminiAdapter } from '../src/adapters/gemini.js';
import {
  planInstall,
  planRemove,
  planSync,
  applyPlan,
  resolveTargets,
} from '../src/core/orchestrator.js';
import type { McpServerSpec } from '../src/core/types.js';

function setup(dir: string) {
  const claudeJson = join(dir, '.claude.json');
  const codexToml = join(dir, 'config.toml');
  const geminiJson = join(dir, 'gemini.json');
  writeFileSync(claudeJson, JSON.stringify({ mcpServers: {} }, null, 2));
  writeFileSync(codexToml, '# codex\nmodel = "gpt-5.5"\n');
  // gemini intentionally absent
  const adapters = [
    new ClaudeCodeAdapter(claudeJson, join(dir, '_sk-claude')),
    new CodexAdapter(codexToml, join(dir, '_sk-codex')),
    new GeminiAdapter(geminiJson),
  ];
  return { claudeJson, codexToml, geminiJson, adapters };
}

function withTempDir(fn: (dir: string) => void | Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-orch-'));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const STDIO: McpServerSpec = { transport: 'stdio', command: 'npx', args: ['-y', 'srv'] };

test(
  'planInstall: fans out to multiple agents',
  withTempDir(async (dir) => {
    const { adapters } = setup(dir);
    const plan = await planInstall(adapters, STDIO, 'srv', 'user', ['claude-code', 'codex']);
    assert.equal(plan.changes.length, 2);
    assert.deepEqual(plan.changes.map((c) => c.agent).sort(), ['claude-code', 'codex']);
  }),
);

test(
  'planInstall: unsupported transport on an agent becomes a skip, not a failure',
  withTempDir(async (dir) => {
    const { adapters } = setup(dir);
    const sse: McpServerSpec = { transport: 'sse', url: 'https://s.test' };
    const plan = await planInstall(adapters, sse, 'srv', 'user', ['claude-code', 'codex']);
    // claude supports sse; codex does not → 1 change + 1 skip
    assert.equal(plan.changes.length, 1);
    assert.equal(plan.changes[0]!.agent, 'claude-code');
    assert.equal(plan.skips.length, 1);
    assert.equal(plan.skips[0]!.agent, 'codex');
    assert.match(plan.skips[0]!.reason, /not supported/);
  }),
);

test(
  'planInstall: a self-protected name is skipped on every agent',
  withTempDir(async (dir) => {
    const { adapters } = setup(dir);
    const plan = await planInstall(adapters, STDIO, 'fleet', 'user', ['claude-code', 'codex']);
    assert.equal(plan.changes.length, 0);
    assert.equal(plan.skips.length, 2);
    assert.ok(plan.skips.every((s) => /refusing/.test(s.reason)));
  }),
);

test(
  'applyPlan: writes to multiple agents, rollback-able',
  withTempDir(async (dir) => {
    const { adapters, claudeJson, codexToml } = setup(dir);
    const home = join(dir, 'fleet-home');
    const plan = await planInstall(adapters, STDIO, 'srv', 'user', ['claude-code', 'codex']);
    const results = await applyPlan(adapters, plan, { fleetHome: home });
    assert.equal(results.length, 2);
    assert.equal(JSON.parse(readFileSync(claudeJson, 'utf8')).mcpServers.srv.command, 'npx');
    assert.equal((parseToml(readFileSync(codexToml, 'utf8')) as any).mcp_servers.srv.command, 'npx');
    assert.match(readFileSync(codexToml, 'utf8'), /# codex/); // comment preserved through real apply
  }),
);

test(
  'planInstall: re-installing the identical spec is a no-op skip',
  withTempDir(async (dir) => {
    const { adapters } = setup(dir);
    const home = join(dir, 'fleet-home');
    const first = await planInstall(adapters, STDIO, 'srv', 'user', ['claude-code']);
    await applyPlan(adapters, first, { fleetHome: home });
    const second = await planInstall(adapters, STDIO, 'srv', 'user', ['claude-code']);
    assert.equal(second.changes.length, 0);
    assert.equal(second.skips[0]?.reason, 'already up to date');
  }),
);

test(
  'planInstall: Codex re-install of an identical spec is idempotent (no-op)',
  withTempDir(async (dir) => {
    const { adapters, codexToml } = setup(dir);
    const home = join(dir, 'fleet-home');
    await applyPlan(adapters, await planInstall(adapters, STDIO, 'srv', 'user', ['codex']), {
      fleetHome: home,
    });
    const after1 = readFileSync(codexToml, 'utf8');
    const second = await planInstall(adapters, STDIO, 'srv', 'user', ['codex']);
    assert.equal(second.changes.length, 0);
    assert.equal(second.skips[0]?.kind, 'noop');
    assert.equal(readFileSync(codexToml, 'utf8'), after1); // bytes unchanged
  }),
);

test(
  'planSync: copies a server spec from one agent to others',
  withTempDir(async (dir) => {
    const { adapters, claudeJson, geminiJson } = setup(dir);
    const home = join(dir, 'fleet-home');
    // install on claude first
    await applyPlan(adapters, await planInstall(adapters, STDIO, 'srv', 'user', ['claude-code']), {
      fleetHome: home,
    });
    // sync claude → gemini
    const plan = await planSync(adapters, 'srv', 'claude-code', ['gemini']);
    assert.equal(plan.changes.length, 1);
    assert.equal(plan.changes[0]!.agent, 'gemini');
    await applyPlan(adapters, plan, { fleetHome: home });
    assert.equal(JSON.parse(readFileSync(geminiJson, 'utf8')).mcpServers.srv.command, 'npx');
  }),
);

test(
  'planRemove: removes from the named agents only',
  withTempDir(async (dir) => {
    const { adapters, claudeJson } = setup(dir);
    const home = join(dir, 'fleet-home');
    await applyPlan(adapters, await planInstall(adapters, STDIO, 'srv', 'user', ['claude-code']), {
      fleetHome: home,
    });
    const plan = await planRemove(adapters, 'srv', ['claude-code']);
    assert.equal(plan.changes.length, 1);
    await applyPlan(adapters, plan, { fleetHome: home });
    assert.equal(JSON.parse(readFileSync(claudeJson, 'utf8')).mcpServers.srv, undefined);
  }),
);

test(
  "resolveTargets: 'all' returns only present writer agents",
  withTempDir(async (dir) => {
    const { adapters } = setup(dir); // gemini absent
    const all = await resolveTargets(adapters, 'all');
    assert.deepEqual(all.sort(), ['claude-code', 'codex']);
    const explicit = await resolveTargets(adapters, 'claude-code,gemini');
    assert.deepEqual(explicit, ['claude-code', 'gemini']);
    await assert.rejects(resolveTargets(adapters, 'nope'), /unknown or non-writable/);
  }),
);
