import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
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
  planSyncRule,
  planSyncSkill,
  applyPlan,
  execute,
  resolveTargets,
} from '../src/core/orchestrator.js';
import type { McpServerSpec } from '../src/core/types.js';
import type { AgentAdapter, AgentWriter } from '../src/core/adapter.js';

function setup(dir: string) {
  const claudeJson = join(dir, '.claude.json');
  const codexToml = join(dir, 'config.toml');
  const geminiJson = join(dir, 'gemini.json');
  const runtimeExecutable = join(dir, 'agent-runtime');
  writeFileSync(claudeJson, JSON.stringify({ mcpServers: {} }, null, 2));
  writeFileSync(codexToml, '# codex\nmodel = "gpt-5.5"\n');
  writeFileSync(runtimeExecutable, '#!/bin/sh\nexit 0\n');
  chmodSync(runtimeExecutable, 0o755);
  // gemini intentionally absent
  const adapters = [
    new ClaudeCodeAdapter(
      claudeJson,
      join(dir, '_sk-claude'),
      join(dir, '_r-claude.md'),
      join(dir, '_settings-claude.json'),
      join(dir, '_plugins-claude'),
      runtimeExecutable,
    ),
    new CodexAdapter(
      codexToml,
      join(dir, '_sk-codex'),
      join(dir, '_r.md'),
      join(dir, '_shared'),
      runtimeExecutable,
    ),
    new GeminiAdapter(geminiJson, runtimeExecutable),
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
  'Codex planning rejects malformed TOML instead of deferring the failure until apply',
  withTempDir(async (dir) => {
    const { adapters, codexToml } = setup(dir);
    writeFileSync(codexToml, '[mcp_servers.broken\n');
    await assert.rejects(planInstall(adapters, STDIO, 'srv', 'user', ['codex']), /agent state unavailable/);
  }),
);

test(
  'committed execution fails closed when Fleet config is malformed',
  withTempDir(async (dir) => {
    const { adapters, claudeJson } = setup(dir);
    const home = join(dir, 'fleet-home');
    const plan = await planInstall(adapters, STDIO, 'srv', 'user', ['claude-code'], {
      trustPolicy: 'warn',
    });
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, 'config.json'), '{ truncated', { flag: 'wx' });
    const before = readFileSync(claudeJson, 'utf8');
    const result = await execute(adapters, plan, { commit: true, fleetHome: home });
    assert.equal(result.applied.length, 0);
    assert.match(result.error ?? '', /CONFIG_INVALID/);
    assert.equal(readFileSync(claudeJson, 'utf8'), before);
  }),
);

test(
  'execute revalidates target inventory under the commit lock',
  withTempDir(async (dir) => {
    const target = join(dir, 'target.json');
    let healthy = true;
    const adapter = {
      id: 'custom-writer',
      displayName: 'Custom writer',
      supportsWrite: true,
      capabilitySupport: { 'mcp-server': { inventory: 'supported', management: 'writable' } },
      async detect() {
        return {
          id: this.id,
          displayName: this.displayName,
          present: true,
          configPaths: [target],
          runtimeStatus: 'available' as const,
          configurationStatus: 'configured' as const,
        };
      },
      async readInventory() {
        if (!healthy) throw new Error('settings became malformed');
        return [];
      },
      async renderInstall() {
        return { file: target, newContent: '{"mcpServers":{"demo":{"command":"safe"}}}' };
      },
      async renderRemove() {
        throw new Error('not reached');
      },
      validate(content: string) {
        JSON.parse(content);
      },
    } as AgentAdapter;
    const plan = await planInstall([adapter], STDIO, 'demo', 'user', ['custom-writer']);
    healthy = false;
    const result = await execute([adapter], plan, { commit: true, fleetHome: join(dir, 'home') });
    assert.equal(result.applied.length, 0);
    assert.equal(result.failedAfter, 0);
    assert.match(result.error ?? '', /agent state unavailable/);
    assert.equal(existsSync(target), false);
  }),
);

test(
  'planSync: copies a server spec from one agent to others',
  withTempDir(async (dir) => {
    const { adapters, geminiJson } = setup(dir);
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
  'MCP planners refuse non-user destinations and require an exact source scope when ambiguous',
  withTempDir(async (dir) => {
    const { adapters, claudeJson } = setup(dir);
    const project = join(dir, 'project');
    mkdirSync(project);
    writeFileSync(
      claudeJson,
      JSON.stringify({
        mcpServers: { shared: { command: 'user-command' } },
        projects: {
          [project]: { mcpServers: { shared: { command: 'local-command' } } },
        },
      }),
    );

    await assert.rejects(
      planInstall(adapters, STDIO, 'wrong-scope', 'project', ['claude-code']),
      /only user scope is writable/,
    );
    await assert.rejects(
      planRemove(adapters, 'shared', ['claude-code'], 'local'),
      /only user scope is writable/,
    );
    await assert.rejects(planSync(adapters, 'shared', 'claude-code', ['codex']), /multiple scopes/);

    const selected = await planSync(adapters, 'shared', 'claude-code', ['codex'], {
      sourceScope: 'user',
    });
    assert.equal(selected.changes.length, 1);
    assert.match(String(selected.changes[0]?.after), /user-command/);
    assert.equal(JSON.parse(readFileSync(claudeJson, 'utf8')).mcpServers.wrongScope, undefined);
  }),
);

test(
  'planning and commit refuse duplicate target contexts inside the selected scope',
  withTempDir(async (dir) => {
    let renders = 0;
    let duplicate = true;
    const target = join(dir, 'target.json');
    const adapter: AgentAdapter & AgentWriter = {
      id: 'duplicate-target',
      displayName: 'Duplicate target',
      supportsWrite: true,
      capabilitySupport: { 'mcp-server': { inventory: 'supported', management: 'writable' } },
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
        const item = (file: string) => ({
          kind: 'mcp-server' as const,
          name: 'shared',
          agent: this.id,
          scope: 'user' as const,
          enabled: true,
          spec: STDIO,
          source: { file },
        });
        return duplicate ? [item('one'), item('two')] : [item('one')];
      },
      async renderInstall() {
        renders += 1;
        return { file: target, newContent: '{}' };
      },
      async renderRemove() {
        renders += 1;
        return { file: target, newContent: '{}' };
      },
      validate() {},
    };
    await assert.rejects(
      planInstall([adapter], STDIO, 'shared', 'user', ['duplicate-target']),
      /multiple configuration contexts/,
    );
    await assert.rejects(
      planRemove([adapter], 'shared', ['duplicate-target']),
      /multiple configuration contexts/,
    );
    assert.equal(renders, 0);

    duplicate = false;
    const plan = await planInstall([adapter], STDIO, 'shared', 'user', ['duplicate-target']);
    assert.equal(renders, 1);
    duplicate = true;
    const result = await execute([adapter], plan, { commit: true, fleetHome: join(dir, 'home') });
    assert.equal(result.applied.length, 0);
    assert.match(result.error ?? '', /multiple configuration contexts/);
    assert.equal(existsSync(target), false);
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

test(
  'resolveTargets rejects explicit initialization when the agent runtime is not installed',
  withTempDir(async (dir) => {
    const absent = new GeminiAdapter(join(dir, 'missing-gemini.json'), join(dir, 'missing-gemini-bin'));
    await assert.rejects(resolveTargets([absent], 'gemini'), /agent state unavailable/);
  }),
);

test(
  'resolveTargets: unsafe configuration topology is excluded from all and rejected explicitly',
  withTempDir(async (dir) => {
    const { adapters } = setup(dir);
    adapters[0]!.detect = async () => ({
      id: 'claude-code',
      displayName: 'Claude Code',
      present: true,
      configPaths: ['/unsafe-link'],
      runtimeStatus: 'available',
      configurationStatus: 'unavailable',
    });
    assert.deepEqual(await resolveTargets(adapters, 'all'), ['codex']);
    await assert.rejects(resolveTargets(adapters, 'claude-code'), /agent state unavailable/);
  }),
);

test(
  'sync planners reject an unavailable source inventory before copying any capability',
  withTempDir(async (dir) => {
    const { adapters } = setup(dir);
    const real = join(dir, 'external-claude.json');
    const linked = join(dir, 'linked-claude.json');
    writeFileSync(real, JSON.stringify({ mcpServers: { copied: { command: 'copy-me' } } }));
    symlinkSync(real, linked);
    const linkedSource = new ClaudeCodeAdapter(
      linked,
      join(dir, 'linked-skills'),
      join(dir, 'linked-rules'),
      join(dir, 'linked-settings'),
      join(dir, 'linked-plugins'),
      join(dir, 'missing-claude'),
    );
    await assert.rejects(
      planSync([linkedSource, adapters[1]!], 'copied', 'claude-code', ['codex']),
      /source inventory unavailable/,
    );

    const unavailableSource: AgentAdapter = {
      id: 'unsafe-source',
      displayName: 'Unsafe source',
      detect: async () => ({
        id: 'unsafe-source',
        displayName: 'Unsafe source',
        present: true,
        configPaths: ['/unsafe'],
        configurationStatus: 'unavailable',
      }),
      readInventory: async () => [
        {
          kind: 'skill',
          name: 'copied-skill',
          agent: 'unsafe-source',
          scope: 'user',
          enabled: true,
          path: join(dir, 'external-skill'),
          source: { file: '/unsafe' },
        },
        {
          kind: 'rule',
          name: 'copied-rule',
          agent: 'unsafe-source',
          scope: 'user',
          enabled: true,
          body: 'unsafe source body',
          source: { file: '/unsafe' },
        },
      ],
    };
    await assert.rejects(
      planSyncSkill([unavailableSource, ...adapters], 'copied-skill', 'unsafe-source', ['codex']),
      /source inventory unavailable/,
    );
    await assert.rejects(
      planSyncRule([unavailableSource, ...adapters], 'copied-rule', 'unsafe-source', ['codex']),
      /source inventory unavailable/,
    );
  }),
);
