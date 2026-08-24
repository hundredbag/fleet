import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { GeminiAdapter } from '../src/adapters/gemini.js';
import { buildTools, type FleetTool } from '../src/mcp/tools.js';
import type { AgentAdapter } from '../src/core/adapter.js';
import { readAudit } from '../src/core/writer.js';

function setup(dir: string, opts: Parameters<typeof buildTools>[1] = {}) {
  const claudeJson = join(dir, '.claude.json');
  const claudeSettings = join(dir, 'claude-settings.json');
  const codexToml = join(dir, 'config.toml');
  const geminiJson = join(dir, 'gemini.json');
  writeFileSync(claudeJson, JSON.stringify({ mcpServers: {} }, null, 2));
  writeFileSync(claudeSettings, JSON.stringify({ enabledPlugins: {} }, null, 2));
  writeFileSync(codexToml, '# codex\n');
  const claudeExecutable = join(dir, 'claude-bin');
  writeFileSync(claudeExecutable, '#!/bin/sh\nexit 0\n');
  chmodSync(claudeExecutable, 0o755);
  const adapters = [
    new ClaudeCodeAdapter(
      claudeJson,
      join(dir, '_sk-claude'),
      join(dir, '_r-claude.md'),
      claudeSettings,
      join(dir, '_plugins-claude'),
      claudeExecutable,
    ),
    new CodexAdapter(codexToml, join(dir, '_sk-codex'), join(dir, '_r-codex.md'), join(dir, '_shared')),
    new GeminiAdapter(geminiJson),
  ];
  const fleetHome = opts.fleetHome ?? join(dir, 'fleet-home');
  const tools = buildTools(adapters, { ...opts, fleetHome });
  const tool = (n: string): FleetTool => {
    const t = tools.find((x) => x.name === n);
    if (!t) throw new Error(`no tool ${n}`);
    return t;
  };
  return { adapters, claudeJson, claudeSettings, codexToml, geminiJson, fleetHome, tool };
}

function applyClaudePluginFixture(settingsPath: string, argv: string[]): void {
  const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as {
    enabledPlugins: Record<string, boolean>;
  };
  const selector = argv.at(-1)!;
  if (argv[2] === 'install') settings.enabledPlugins[selector] = true;
  if (argv[2] === 'uninstall') delete settings.enabledPlugins[selector];
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
}

function withTempDir(fn: (dir: string) => void | Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-mcp-'));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test(
  'inventory tool lists detected agents',
  withTempDir(async (dir) => {
    const { tool } = setup(dir);
    const res = (await tool('inventory').handler({})) as any;
    assert.ok(res.agents.length >= 3);
    assert.ok(res.agents.some((a: any) => a.id === 'claude-code' && a.present));
  }),
);

test(
  'inventory and doctor replace opaque adapter diagnostics with structured status and codes',
  withTempDir(async (dir) => {
    const adapter: AgentAdapter = {
      id: 'third-party',
      displayName: 'Third Party',
      async detect() {
        throw new Error('credential is OPAQUE_ADAPTER_DIAGNOSTIC');
      },
      async readInventory() {
        return [];
      },
    };
    const tools = buildTools([adapter], { fleetHome: join(dir, 'fleet-home') });
    const byName = (name: string) => tools.find((candidate) => candidate.name === name)!;
    const inventory = await byName('inventory').handler({});
    const doctor = await byName('doctor').handler({});
    const serialized = JSON.stringify({ inventory, doctor });
    assert.equal(serialized.includes('OPAQUE_ADAPTER_DIAGNOSTIC'), false);
    assert.equal((inventory as any).agents[0].inventoryStatus, 'detect-failed');
    assert.equal((inventory as any).agents[0].runtimeStatus, 'unverifiable');
    assert.equal((inventory as any).agents[0].configurationStatus, 'unavailable');
    assert.equal((inventory as any).agents[0].setupStatus, 'detection-unavailable');
    const detectFinding = (doctor as any).findings.find(
      (finding: any) => finding.code === 'AGENT_DETECT_FAILED',
    );
    assert.equal(detectFinding.recovery, 'CHECK_ADAPTER');
    assert.equal(Object.hasOwn(detectFinding, 'message'), false);
  }),
);

test(
  'inventory rejects malformed BYO item arrays without exposing invalid fields',
  withTempDir(async (dir) => {
    const marker = 'OPAQUE_RUNTIME_FIELD_PATH';
    const adapter: AgentAdapter = {
      id: 'third-party',
      displayName: `/home/alice/${marker}_DISPLAY`,
      async detect() {
        return {
          id: `/home/alice/${marker}_DETECT_ID`,
          displayName: `/home/alice/${marker}_DETECT_DISPLAY`,
          present: true,
          configPaths: [],
        };
      },
      async readInventory() {
        const base = { agent: 'spoofed', scope: 'user', enabled: true, source: { file: '/private' } };
        return [
          { ...base, kind: 'skill', name: 'group/child', path: '/private/group', tokensEst: 12 },
          { ...base, kind: 'skill', name: 'mcp:foo', path: '/private/colon' },
          { ...base, kind: 'skill', name: 'bad-scope', scope: `/home/alice/${marker}_SCOPE`, path: 'x' },
          { ...base, kind: 'plugin', name: 'bad-enabled', enabled: `/home/alice/${marker}_ENABLED` },
          {
            ...base,
            kind: 'subagent',
            name: 'runtime-fields',
            path: 'x',
            tokensEst: `/home/alice/${marker}_TOKENS`,
            tools: `/home/alice/${marker}_TOOLS`,
            model: { value: `/home/alice/${marker}_MODEL` },
          },
          {
            ...base,
            kind: 'mcp-server',
            name: 'bad-transport',
            spec: { transport: `/home/alice/${marker}_TRANSPORT` },
          },
          { ...base, kind: `/home/alice/${marker}_KIND`, name: 'bad-kind' },
        ] as any;
      },
    };
    const invalidPresent: AgentAdapter = {
      id: 'invalid-present',
      displayName: 'Invalid present',
      async detect() {
        return {
          id: 'invalid-present',
          displayName: 'Invalid present',
          present: `/home/alice/${marker}_PRESENT` as any,
          configPaths: [],
        };
      },
      async readInventory() {
        throw new Error('must not read an agent that is not strictly present');
      },
    };
    const invalidStatus: AgentAdapter = {
      id: 'invalid-status',
      displayName: 'Invalid status',
      async detect() {
        return {
          id: 'invalid-status',
          displayName: 'Invalid status',
          present: true,
          configPaths: [],
          runtimeStatus: `/home/alice/${marker}_RUNTIME` as any,
          configurationStatus: `/home/alice/${marker}_CONFIGURATION` as any,
        };
      },
      async readInventory() {
        throw new Error('invalid configuration status must fail closed before inventory read');
      },
    };
    const tools = buildTools([adapter, invalidPresent, invalidStatus], { fleetHome: join(dir, 'home') });
    const inventory = (await tools.find((tool) => tool.name === 'inventory')!.handler({})) as any;
    const serialized = JSON.stringify(inventory);
    assert.equal(serialized.includes(marker), false);
    assert.deepEqual(inventory.skills, []);
    const malformedItems = inventory.agents.find((agent: any) => agent.id === 'third-party');
    assert.equal(malformedItems?.setupStatus, 'inventory-unavailable');
    assert.equal(malformedItems?.inventoryStatus, 'read-failed');
    assert.equal(inventory.agents.find((agent: any) => agent.id === 'invalid-present')?.present, false);
    const normalized = inventory.agents.find((agent: any) => agent.id === 'invalid-status');
    assert.equal(normalized?.runtimeStatus, 'unverifiable');
    assert.equal(normalized?.configurationStatus, 'unavailable');
    assert.equal(normalized?.setupStatus, 'configuration-unavailable');
    assert.equal(normalized?.inventoryStatus, 'read-failed');
    assert.deepEqual(inventory.servers, []);
    assert.deepEqual(inventory.subagents, []);
  }),
);

test(
  'built-in inventory withholds tilde, environment, and relative path aliases on MCP and Web faces',
  withTempDir(async (dir) => {
    const { tool, adapters, claudeJson } = setup(dir);
    const unsafeNames = [
      '~alice/private-OPAQUE_TILDE_USER',
      '$HOME/private-OPAQUE_HOME_ENV',
      '%USERPROFILE%\\private-OPAQUE_WINDOWS_ENV',
      'label ./private-OPAQUE_RELATIVE',
      'label(/home/alice/private-OPAQUE_PUNCTUATION)',
    ];
    writeFileSync(
      claudeJson,
      JSON.stringify({
        mcpServers: Object.fromEntries(
          [...unsafeNames, 'group/child'].map((name) => [name, { command: 'safe-command' }]),
        ),
      }),
    );
    const mcp = (await tool('inventory').handler({})) as any;
    const { apiInventory } = await import('../src/web/api.js');
    const web = await apiInventory(adapters);
    const serialized = JSON.stringify({ mcp, web });
    for (const marker of ['OPAQUE_TILDE_USER', 'OPAQUE_HOME_ENV', 'OPAQUE_WINDOWS_ENV', 'OPAQUE_RELATIVE']) {
      assert.equal(serialized.includes(marker), false, marker);
    }
    assert.ok(mcp.servers.some((server: any) => server.name === 'group/child'));
    assert.ok(web.capabilities.some((capability) => capability.name === 'group/child'));
    assert.ok(mcp.withheldCount >= unsafeNames.length);
    assert.ok(web.withheldCount >= unsafeNames.length);
  }),
);

test(
  'public mutation tools refuse capability identities withheld from inventory',
  withTempDir(async (dir) => {
    const { tool, claudeJson } = setup(dir);
    const unsafe = '/home/alice/OPAQUE_WITHHELD_ACTION';
    writeFileSync(
      claudeJson,
      JSON.stringify({ mcpServers: { [unsafe]: { command: 'safe-command' } } }, null, 2),
    );
    const inventory = (await tool('inventory').handler({})) as any;
    assert.equal(
      inventory.servers.some((item: any) => item.name === unsafe),
      false,
    );
    assert.ok(inventory.withheldCount > 0);
    for (const args of [
      { name: unsafe, from: 'claude-code' },
      { name: unsafe, from: 'claude-code', commit: true },
    ]) {
      await assert.rejects(tool('remove').handler(args), /REQUEST_REJECTED/);
    }
    assert.equal(JSON.parse(readFileSync(claudeJson, 'utf8')).mcpServers[unsafe].command, 'safe-command');
  }),
);

test(
  'public mutation tools refuse BYO agent identities withheld from inventory',
  withTempDir(async (dir) => {
    const hiddenId = '/home/alice/PRIVATE_ADAPTER';
    const target = join(dir, 'hidden-target.json');
    const adapter = {
      id: hiddenId,
      displayName: 'Private adapter',
      supportsWrite: true,
      capabilitySupport: { 'mcp-server': { inventory: 'supported', management: 'writable' } },
      detect: async () => ({ id: hiddenId, displayName: 'Private adapter', present: true, configPaths: [] }),
      readInventory: async () => [],
      renderInstall: async () => ({ file: target, newContent: '{"mcpServers":{}}' }),
      renderRemove: async () => ({ file: target, newContent: '{"mcpServers":{}}' }),
      validate: (content: string) => {
        JSON.parse(content);
      },
    } as AgentAdapter;
    const install = buildTools([adapter], { fleetHome: join(dir, 'fleet-home') }).find(
      (candidate) => candidate.name === 'install',
    )!;
    await assert.rejects(
      install.handler({
        name: 'safe-name',
        to: hiddenId,
        command: 'safe-command',
        commit: true,
      }),
      /REQUEST_REJECTED/,
    );
    assert.equal(existsSync(target), false);
  }),
);

test(
  'install tool is dry-run by default, writes only on commit',
  withTempDir(async (dir) => {
    const { tool, claudeJson } = setup(dir);
    const dry = (await tool('install').handler({
      name: 'gh',
      to: 'claude-code',
      command: 'npx',
      args: ['-y', 'gh'],
    })) as any;
    assert.equal(dry.committed, false);
    assert.equal(dry.applied, 0);
    assert.equal(JSON.parse(readFileSync(claudeJson, 'utf8')).mcpServers.gh, undefined);

    const wet = (await tool('install').handler({
      name: 'gh',
      to: 'claude-code',
      command: 'npx',
      args: ['-y', 'gh'],
      commit: true,
    })) as any;
    assert.equal(wet.committed, true);
    assert.equal(wet.applied, 1);
    assert.equal(JSON.parse(readFileSync(claudeJson, 'utf8')).mcpServers.gh.command, 'npx');
  }),
);

test(
  'install tool marks an applied-but-unrecorded mutation for manual recovery',
  withTempDir(async (dir) => {
    const { tool, fleetHome, claudeJson } = setup(dir);
    mkdirSync(fleetHome, { recursive: true });
    const audit = join(fleetHome, 'audit.jsonl');
    writeFileSync(audit, '');
    chmodSync(audit, 0o400);
    const result = (await tool('install').handler({
      name: 'unrecorded',
      to: 'claude-code',
      command: 'c',
      commit: true,
    })) as any;
    chmodSync(audit, 0o600);
    assert.equal(result.status, 'partial');
    assert.equal(result.applied, 1);
    assert.equal(result.auditRecorded, 0);
    assert.equal(result.unrecordedApplied, 1);
    assert.equal(result.errorCode, 'AUDIT_WRITE_FAILED');
    assert.equal(result.recoveryClass, 'manual-config-recovery');
    assert.equal(existsSync(join(fleetHome, 'fleet.lock')), false);
    assert.ok(JSON.parse(readFileSync(claudeJson, 'utf8')).mcpServers.unrecorded);
  }),
);

test(
  'inventory tool redacts secrets (env values not leaked to the AI)',
  withTempDir(async (dir) => {
    const { tool, claudeJson } = setup(dir);
    writeFileSync(
      claudeJson,
      JSON.stringify({ mcpServers: { s: { command: 'x', env: { TOKEN: 'supersecret' } } } }, null, 2),
    );
    const res = await tool('inventory').handler({});
    assert.equal(JSON.stringify(res).includes('supersecret'), false);
  }),
);

test(
  'sync tool copies a server between agents on commit',
  withTempDir(async (dir) => {
    const { tool, geminiJson } = setup(dir);
    await tool('install').handler({ name: 'srv', to: 'claude-code', command: 'npx', commit: true });
    const res = (await tool('sync').handler({
      name: 'srv',
      from: 'claude-code',
      to: 'gemini',
      commit: true,
    })) as any;
    assert.equal(res.applied, 1);
    assert.equal(JSON.parse(readFileSync(geminiJson, 'utf8')).mcpServers.srv.command, 'npx');
  }),
);

test(
  'MCP sync requires an exact source scope and non-user removal is unsupported',
  withTempDir(async (dir) => {
    const { tool, claudeJson } = setup(dir);
    const project = join(dir, 'project');
    mkdirSync(project);
    writeFileSync(
      claudeJson,
      JSON.stringify({
        mcpServers: { shared: { command: 'user-command' } },
        projects: { [project]: { mcpServers: { shared: { command: 'local-command' } } } },
      }),
    );

    await assert.rejects(
      tool('sync').handler({ name: 'shared', from: 'claude-code', to: 'codex' }),
      /INVALID_ARGUMENT/,
    );
    const selected = (await tool('sync').handler({
      name: 'shared',
      from: 'claude-code',
      fromScope: 'user',
      to: 'codex',
    })) as any;
    assert.equal(selected.committed, false);
    assert.equal(selected.changes[0].scope, 'user');
    await assert.rejects(
      tool('remove').handler({ name: 'shared', from: 'claude-code', scope: 'local' }),
      /UNSUPPORTED_OPERATION/,
    );
  }),
);

test(
  'sync tools honor block trust policy from the injected fleet home',
  withTempDir(async (dir) => {
    const { tool, claudeJson, fleetHome } = setup(dir);
    mkdirSync(fleetHome, { recursive: true });
    writeFileSync(join(fleetHome, 'config.json'), JSON.stringify({ trustPolicy: 'block' }));
    writeFileSync(
      claudeJson,
      JSON.stringify({
        mcpServers: {
          unsafe: { command: 'npx', args: ['unsafe@file:/tmp/opaque'] },
          unsafeEnv: {
            command: 'npx',
            args: ['safe@1.0.0'],
            env: { NODE_OPTIONS: '--require=/tmp/attacker.js' },
          },
        },
      }),
    );
    const serverSync = (await tool('sync').handler({
      name: 'unsafe',
      from: 'claude-code',
      to: 'codex',
      commit: true,
    })) as any;
    assert.equal(serverSync.status, 'refused');
    assert.equal(serverSync.applied, 0);
    const envSync = (await tool('sync').handler({
      name: 'unsafeEnv',
      from: 'claude-code',
      to: 'codex',
      commit: true,
    })) as any;
    assert.equal(envSync.status, 'refused');
    assert.equal(envSync.applied, 0);

    const skillDir = join(dir, '_sk-claude', 'unsafe-skill');
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(join(skillDir, 'SKILL.md'), '# unsafe');
    writeFileSync(join(skillDir, 'payload.sh'), '#!/bin/sh\necho unsafe');
    chmodSync(join(skillDir, 'payload.sh'), 0o755);
    const skillSync = (await tool('skill_sync').handler({
      name: 'unsafe-skill',
      from: 'claude-code',
      to: 'codex',
      commit: true,
    })) as any;
    assert.equal(skillSync.status, 'refused');
    assert.equal(skillSync.applied, 0);
  }),
);

test(
  'install tool surfaces per-agent skips (unsupported transport)',
  withTempDir(async (dir) => {
    const { tool } = setup(dir);
    const res = (await tool('install').handler({
      name: 'r',
      to: 'codex',
      url: 'https://r.test',
      sse: true,
    })) as any;
    assert.equal(res.changes.length, 0);
    assert.equal(res.skips[0].kind, 'error');
    assert.equal(res.skips[0].reasonCode, 'UNSUPPORTED_OPERATION');
  }),
);

test(
  'inventory tool redacts credentials embedded in a remote URL',
  withTempDir(async (dir) => {
    const { tool, claudeJson } = setup(dir);
    writeFileSync(
      claudeJson,
      JSON.stringify(
        { mcpServers: { r: { type: 'http', url: 'https://user:s3cr3t@h.test/mcp?api_key=TOPSECRET' } } },
        null,
        2,
      ),
    );
    const res = await tool('inventory').handler({});
    const s = JSON.stringify(res);
    assert.equal(s.includes('s3cr3t'), false);
    assert.equal(s.includes('TOPSECRET'), false);
  }),
);

test(
  'inventory tool omits remote hosts and local command coordinates',
  withTempDir(async (dir) => {
    const { tool, claudeJson } = setup(dir);
    writeFileSync(
      claudeJson,
      JSON.stringify({
        mcpServers: {
          remote: {
            type: 'http',
            url: 'https://example.test/private/OPAQUE_URL_SECRET?client=OPAQUE_QUERY_SECRET#fragment',
          },
          local: { command: '/home/alice/OPAQUE_COMMAND_PATH/bin/tool' },
        },
      }),
    );
    const response = (await tool('inventory').handler({})) as any;
    const serialized = JSON.stringify(response);
    for (const leak of ['OPAQUE_URL_SECRET', 'OPAQUE_QUERY_SECRET', 'fragment', '/home/alice']) {
      assert.equal(serialized.includes(leak), false, `inventory target leaked: ${leak}`);
    }
    assert.equal(
      Object.hasOwn(
        response.servers.find((server: any) => server.name === 'remote'),
        'target',
      ),
      false,
    );
    assert.equal(
      Object.hasOwn(
        response.servers.find((server: any) => server.name === 'local'),
        'target',
      ),
      false,
    );
  }),
);

test(
  'lock_status allowlists provenance and omits raw keys, paths, hashes, audit ids, and reasons',
  withTempDir(async (dir) => {
    const { tool, fleetHome } = setup(dir);
    mkdirSync(fleetHome, { recursive: true });
    writeFileSync(
      join(fleetHome, 'fleet.lock'),
      JSON.stringify({
        version: 1,
        entries: {
          OPAQUE_INTERNAL_KEY_SECRET: {
            kind: 'skill',
            name: 'review',
            agent: 'codex',
            scope: 'user',
            origin: { type: 'dir', path: '/home/alice/OPAQUE_ORIGIN_SECRET' },
            hashScheme: 'canonical-v1',
            contentHash: 'OPAQUE_HASH_SECRET',
            installedAt: '2026-08-19T00:00:00.000Z',
            auditId: 'OPAQUE_AUDIT_SECRET',
            op: 'install',
            trust: {
              level: 'caution',
              reasons: ['credential is OPAQUE_TRUST_SECRET'],
              reasonCodes: ['SKILL_SCRIPT_FILES'],
            },
            TOKEN: 'OPAQUE_EXTRA_SECRET',
          },
          poisoned_drift: {
            kind: 'skill',
            name: '/home/alice/OPAQUE_DRIFT_SECRET',
            agent: 'codex',
            scope: 'user',
            origin: { type: 'manual' },
            installedAt: '2026-08-19T00:00:01.000Z',
            op: 'install',
          },
          private_package: {
            kind: 'mcp-server',
            name: 'internal-server',
            agent: 'codex',
            scope: 'user',
            origin: {
              type: 'npm',
              id: '@private/opaquevelvetquasar',
              version: '1.0.0',
            },
            hashScheme: 'canonical-v1',
            contentHash: 'a'.repeat(64),
            installedAt: '2026-08-19T00:00:02.000Z',
            op: 'install',
          },
          plugin_coordinate: {
            kind: 'plugin',
            name: 'shared',
            marketplace: 'official',
            agent: 'claude-code',
            scope: 'user',
            origin: { type: 'marketplace', selector: 'shared@official' },
            installedAt: '2026-08-19T00:00:03.000Z',
            op: 'install',
          },
          github_skill: {
            kind: 'skill',
            name: 'remote-review',
            agent: 'codex',
            scope: 'user',
            origin: {
              type: 'github',
              repository: 'opaque-owner/opaque-repo',
              commit: 'b'.repeat(40),
              path: 'skills/OPAQUE_GITHUB_PATH',
            },
            installedAt: '2026-08-19T00:00:04.000Z',
            op: 'install',
          },
        },
      }),
    );
    const response = (await tool('lock_status').handler({})) as any;
    const serialized = JSON.stringify(response);
    for (const leak of [
      'OPAQUE_INTERNAL_KEY_SECRET',
      '/home/alice',
      'OPAQUE_HASH_SECRET',
      'OPAQUE_AUDIT_SECRET',
      'OPAQUE_TRUST_SECRET',
      'OPAQUE_EXTRA_SECRET',
      '@private/opaquevelvetquasar',
      'opaque-owner',
      'OPAQUE_GITHUB_PATH',
    ]) {
      assert.equal(serialized.includes(leak), false, `lock status leaked: ${leak}`);
    }
    assert.equal(response.entries[0].origin.type, 'local-directory');
    assert.equal(response.entries[0].verifiable, false);
    assert.deepEqual(response.entries[0].trustReasonCodes, ['SKILL_SCRIPT_FILES']);
    assert.deepEqual(response.entries.find((entry: any) => entry.name === 'internal-server')?.origin, {
      type: 'npm',
      pinned: true,
    });
    assert.deepEqual(response.entries.find((entry: any) => entry.name === 'remote-review')?.origin, {
      type: 'repository-snapshot',
      pinned: true,
    });
    assert.equal(response.entries.find((entry: any) => entry.name === 'shared')?.marketplace, 'official');
    const drift = (await tool('drift_check').handler({})) as any;
    assert.equal(JSON.stringify(drift).includes('OPAQUE_DRIFT_SECRET'), false);
    assert.equal(drift.withheld, 1);
  }),
);

test(
  'inventory tool does not leak config snippets from a parse error',
  withTempDir(async (dir) => {
    const { tool, claudeJson } = setup(dir);
    writeFileSync(claudeJson, '{ "mcpServers": broken "supersecret_token" ');
    const res = (await tool('inventory').handler({})) as any;
    const agent = res.agents.find((a: any) => a.id === 'claude-code');
    assert.equal(agent?.inventoryStatus, 'read-failed');
    assert.equal(Object.hasOwn(agent, 'note'), false);
    assert.equal(JSON.stringify(res).includes('supersecret_token'), false);
  }),
);

test(
  'install tool rejects supplying both command and url',
  withTempDir(async (dir) => {
    const { tool } = setup(dir);
    await assert.rejects(
      tool('install').handler({ name: 'x', to: 'claude-code', command: 'c', url: 'https://u' }),
      /INVALID_ARGUMENT/,
    );
  }),
);

test(
  'tools report a status field (preview vs applied) and accept array targets',
  withTempDir(async (dir) => {
    const { tool } = setup(dir);
    const dry = (await tool('install').handler({
      name: 'x',
      to: ['claude-code', 'codex'],
      command: 'c',
    })) as any;
    assert.equal(dry.status, 'preview');
    assert.equal(dry.changes.length, 2); // array target fanned out
    const wet = (await tool('install').handler({
      name: 'x',
      to: 'claude-code',
      command: 'c',
      commit: true,
    })) as any;
    assert.equal(wet.status, 'applied');
  }),
);

test(
  'tool boundary scrubs secrets from thrown validation and adapter errors',
  withTempDir(async (dir) => {
    const { tool } = setup(dir);
    await assert.rejects(
      tool('install').handler({
        name: 'x',
        to: 'API_TOKEN=TARGETSECRET',
        command: 'c',
      }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.equal(message.includes('TARGETSECRET'), false);
        assert.equal(message, 'TARGET_UNAVAILABLE');
        return true;
      },
    );
  }),
);

test(
  'explicit unavailable target has the stable TARGET_UNAVAILABLE public code',
  withTempDir(async (dir) => {
    const unavailable = {
      id: 'custom-writer',
      displayName: 'Custom writer',
      supportsWrite: true,
      capabilitySupport: { 'mcp-server': { inventory: 'supported', management: 'writable' } },
      async detect() {
        return {
          id: this.id,
          displayName: this.displayName,
          present: true,
          configPaths: [],
          configurationStatus: 'unavailable' as const,
        };
      },
      async readInventory() {
        return [];
      },
      async renderInstall() {
        throw new Error('not reached');
      },
      async renderRemove() {
        throw new Error('not reached');
      },
      validate() {},
    } as AgentAdapter;
    const install = buildTools([unavailable], { fleetHome: join(dir, 'home') }).find(
      (candidate) => candidate.name === 'install',
    )!;
    await assert.rejects(
      install.handler({ name: 'demo', to: 'custom-writer', command: 'safe-command' }),
      /TARGET_UNAVAILABLE/,
    );
  }),
);

test(
  'mutation refuses a present target whose semantic inventory is unavailable',
  withTempDir(async (dir) => {
    const fixture = setup(dir);
    const damaged = JSON.stringify({ mcpServers: { broken: [] } });
    writeFileSync(fixture.claudeJson, damaged);
    await assert.rejects(
      fixture.tool('install').handler({
        name: 'good',
        to: 'claude-code',
        command: 'safe-command',
        commit: true,
      }),
      /TARGET_UNAVAILABLE/,
    );
    assert.equal(readFileSync(fixture.claudeJson, 'utf8'), damaged);
    assert.equal(existsSync(join(fixture.fleetHome, 'audit.jsonl')), false);
  }),
);

test(
  'mutation rejects a BYO writer that returns malformed inventory items',
  withTempDir(async (dir) => {
    let renders = 0;
    const malformed = {
      id: 'malformed-writer',
      displayName: 'Malformed writer',
      supportsWrite: true,
      capabilitySupport: { 'mcp-server': { inventory: 'supported', management: 'writable' } },
      async detect() {
        return {
          id: this.id,
          displayName: this.displayName,
          present: true,
          configPaths: [],
          runtimeStatus: 'available' as const,
          configurationStatus: 'configured' as const,
        };
      },
      async readInventory() {
        return [null] as any;
      },
      async renderInstall() {
        renders++;
        throw new Error('must not render');
      },
      async renderRemove() {
        throw new Error('must not render');
      },
      validate() {},
    } as AgentAdapter;
    const install = buildTools([malformed], { fleetHome: join(dir, 'home') }).find(
      (candidate) => candidate.name === 'install',
    )!;
    await assert.rejects(
      install.handler({ name: 'demo', to: 'malformed-writer', command: 'safe-command', commit: true }),
      /TARGET_UNAVAILABLE/,
    );
    assert.equal(renders, 0);
  }),
);

test(
  'doctor tool preserves adapter load diagnostics from server startup',
  withTempDir(async (dir) => {
    const doctor = buildTools([], {
      fleetHome: join(dir, 'home'),
      adapterLoadDiagnostics: [{ index: 0, reason: 'invalid-export' }],
    }).find((candidate) => candidate.name === 'doctor')!;
    const result = (await doctor.handler({})) as {
      exitCode: number;
      findings: { code: string; level: string }[];
    };
    assert.equal(result.exitCode, 2);
    assert.ok(
      result.findings.some((finding) => finding.code === 'ADAPTER_LOAD_FAILED' && finding.level === 'error'),
    );
  }),
);

test(
  'tool execute summaries do not expose local target files',
  withTempDir(async (dir) => {
    const { tool } = setup(dir);
    const result = (await tool('install').handler({
      name: 'x',
      to: 'claude-code',
      command: 'c',
    })) as any;
    assert.equal(Object.hasOwn(result.changes[0], 'file'), false);
    assert.equal(JSON.stringify(result).includes(dir), false);
  }),
);

test(
  'rollback tool returns only logical action and a fixed reason code',
  withTempDir(async (dir) => {
    const { tool } = setup(dir);
    await tool('install').handler({
      name: 'x',
      to: 'claude-code',
      command: 'c',
      commit: true,
    });
    const result = (await tool('rollback').handler({})) as any;
    assert.equal(result.action, 'restored');
    assert.equal(Object.hasOwn(result, 'file'), false);
    assert.equal(JSON.stringify(result).includes(dir), false);
  }),
);

test(
  'rollback tool reports completed action with missing audit provenance instead of failure',
  withTempDir(async (dir) => {
    const { tool, fleetHome } = setup(dir);
    await tool('install').handler({
      name: 'x',
      to: 'claude-code',
      command: 'c',
      commit: true,
    });
    const [record] = await readAudit(fleetHome);
    const audit = join(fleetHome, 'audit.jsonl');
    chmodSync(audit, 0o400);
    const result = (await tool('rollback').handler({ auditId: record!.id })) as any;
    chmodSync(audit, 0o600);
    assert.deepEqual(result, {
      action: 'restored',
      reasonCode: 'AUDIT_WRITE_FAILED',
      provenanceRecorded: false,
      recoveryClass: 'audit-history-repair',
    });
  }),
);

test(
  'rollback tool reports completed target recovery with failed lock provenance cleanup',
  withTempDir(async (dir) => {
    const { tool, fleetHome } = setup(dir);
    const applied = (await tool('install').handler({
      name: 'x',
      to: 'claude-code',
      command: 'c',
      commit: true,
    })) as any;
    writeFileSync(join(fleetHome, 'fleet.lock'), '{broken');
    const result = (await tool('rollback').handler({ auditId: applied.records[0].auditId })) as any;
    assert.deepEqual(result, {
      action: 'restored',
      lockWarningCode: 'PROVENANCE_WARNING',
    });
  }),
);

test(
  'implicit rollback refuses to undo an older core change after a delegated plugin action',
  withTempDir(async (dir) => {
    const settingsPath = join(dir, 'claude-settings.json');
    const { tool, claudeJson } = setup(dir, {
      pluginRunner: async (argv) => {
        applyClaudePluginFixture(settingsPath, argv);
        return { exitCode: 0, output: '' };
      },
    });
    await tool('install').handler({
      name: 'older-core',
      to: 'claude-code',
      command: 'c',
      commit: true,
    });
    await tool('plugin_install').handler({
      selector: 'newer-plugin',
      to: 'claude-code',
      commit: true,
    });

    const result = (await tool('rollback').handler({})) as any;
    assert.deepEqual(result, {
      action: 'skipped',
      reasonCode: 'LATEST_CHANGE_DELEGATED',
      suggestedTool: 'plugin_remove',
    });
    assert.ok(JSON.parse(readFileSync(claudeJson, 'utf8')).mcpServers['older-core']);
  }),
);

test(
  'implicit and explicit rollback fail closed on malformed audit history',
  withTempDir(async (dir) => {
    mkdirSync(join(dir, 'audit'), { recursive: true });
    const first = setup(join(dir, 'audit'));
    await first.tool('install').handler({
      name: 'core-a',
      to: 'claude-code',
      command: 'a',
      commit: true,
    });
    const auditId = (await readAudit(first.fleetHome))[0]!.id;
    writeFileSync(
      join(first.fleetHome, 'audit.jsonl'),
      readFileSync(join(first.fleetHome, 'audit.jsonl'), 'utf8') + '{truncated\n',
    );
    assert.deepEqual(await first.tool('rollback').handler({}), {
      action: 'skipped',
      reasonCode: 'CORE_HISTORY_UNVERIFIABLE',
      recoveryClass: 'audit-history-repair',
    });
    assert.ok(JSON.parse(readFileSync(first.claudeJson, 'utf8')).mcpServers['core-a']);
    await assert.rejects(first.tool('rollback').handler({ auditId }), /REQUEST_REJECTED/);

    mkdirSync(join(dir, 'delegated'), { recursive: true });
    const second = setup(join(dir, 'delegated'));
    await second.tool('install').handler({
      name: 'core-b',
      to: 'claude-code',
      command: 'b',
      commit: true,
    });
    mkdirSync(second.fleetHome, { recursive: true });
    writeFileSync(join(second.fleetHome, 'delegated.jsonl'), '{truncated\n');
    assert.deepEqual(await second.tool('rollback').handler({}), {
      action: 'skipped',
      reasonCode: 'DELEGATED_HISTORY_UNVERIFIABLE',
      recoveryClass: 'vendor-state-inspection',
    });
    assert.ok(JSON.parse(readFileSync(second.claudeJson, 'utf8')).mcpServers['core-b']);
  }),
);

test(
  'implicit rollback treats a valid legacy delegated row without effect proof as vendor recovery only',
  withTempDir(async (dir) => {
    const { tool, fleetHome, claudeJson } = setup(dir);
    await tool('install').handler({
      name: 'older-core',
      to: 'claude-code',
      command: 'c',
      commit: true,
    });
    writeFileSync(
      join(fleetHome, 'delegated.jsonl'),
      JSON.stringify({
        id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        time: new Date(Date.now() + 1_000).toISOString(),
        agent: 'claude-code',
        op: 'install',
        selector: 'legacy-plugin',
        argv: ['claude', 'plugin', 'install', 'legacy-plugin'],
        undoArgv: ['claude', 'plugin', 'uninstall', 'legacy-plugin'],
        exitCode: 0,
      }) + '\n',
    );
    assert.deepEqual(await tool('rollback').handler({}), {
      action: 'skipped',
      reasonCode: 'LATEST_CHANGE_DELEGATED',
      recoveryClass: 'vendor-state-inspection',
    });
    assert.ok(JSON.parse(readFileSync(claudeJson, 'utf8')).mcpServers['older-core']);
  }),
);

test(
  'rollback rows cannot mask a newer delegated action from the next implicit rollback',
  withTempDir(async (dir) => {
    const settingsPath = join(dir, 'claude-settings.json');
    const { tool, claudeJson, fleetHome } = setup(dir, {
      pluginRunner: async (argv) => {
        applyClaudePluginFixture(settingsPath, argv);
        return { exitCode: 0, output: '' };
      },
    });
    await tool('install').handler({ name: 'core-a', to: 'claude-code', command: 'a', commit: true });
    await tool('plugin_install').handler({ selector: 'plugin-p', to: 'claude-code', commit: true });
    await tool('install').handler({ name: 'core-b', to: 'claude-code', command: 'b', commit: true });
    const coreB = (await readAudit(fleetHome)).find((record) => record.name === 'core-b')!;
    await tool('rollback').handler({ auditId: coreB.id });

    const result = (await tool('rollback').handler({})) as any;
    assert.equal(result.action, 'skipped');
    assert.equal(result.reasonCode, 'LATEST_CHANGE_DELEGATED');
    const servers = JSON.parse(readFileSync(claudeJson, 'utf8')).mcpServers;
    assert.ok(servers['core-a']);
    assert.equal(servers['core-b'], undefined);
  }),
);

test(
  'implicit rollback suggests the inverse of the newest successful delegated operation',
  withTempDir(async (dir) => {
    const settingsPath = join(dir, 'claude-settings.json');
    const { tool } = setup(dir, {
      pluginRunner: async (argv) => {
        applyClaudePluginFixture(settingsPath, argv);
        return { exitCode: 0, output: '' };
      },
    });
    await tool('install').handler({ name: 'core-a', to: 'claude-code', command: 'a', commit: true });
    writeFileSync(settingsPath, JSON.stringify({ enabledPlugins: { 'plugin-p': true } }, null, 2));
    await tool('plugin_remove').handler({ selector: 'plugin-p', from: 'claude-code', commit: true });
    const result = (await tool('rollback').handler({})) as any;
    assert.equal(result.suggestedTool, 'plugin_install');
  }),
);

test(
  'plugin tool omits opaque vendor output and raw lock warnings from the AI result',
  withTempDir(async (dir) => {
    let vendorExit = 0;
    const settingsPath = join(dir, 'claude-settings.json');
    const { tool, fleetHome } = setup(dir, {
      pluginRunner: async (argv) => {
        if (vendorExit === 0) applyClaudePluginFixture(settingsPath, argv);
        return { exitCode: vendorExit, output: 'credential is OPAQUE_VENDOR_OUTPUT' };
      },
    });
    const preview = (await tool('plugin_install').handler({
      selector: 'demo@official',
      to: 'claude-code',
    })) as any;
    assert.equal(preview.results[0].provenanceRecorded, false);
    assert.equal(preview.results[0].undoCommand, 'claude plugin uninstall demo@official');
    const result = (await tool('plugin_install').handler({
      selector: 'demo@official',
      to: 'claude-code',
      commit: true,
    })) as any;
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('OPAQUE_VENDOR_OUTPUT'), false);
    assert.equal(Object.hasOwn(result.results[0], 'outputTail'), false);
    assert.equal(Object.hasOwn(result.results[0], 'lockWarning'), false);
    assert.equal(result.results[0].provenanceRecorded, true);
    assert.equal(result.results[0].undoCommand, 'claude plugin uninstall demo@official');
    vendorExit = 1;
    const failed = (await tool('plugin_install').handler({
      selector: 'failed-demo@official',
      to: 'claude-code',
      commit: true,
    })) as any;
    assert.equal(failed.results[0].status, 'failed');
    assert.equal(failed.results[0].provenanceRecorded, true);
    assert.equal(Object.hasOwn(failed.results[0], 'undoCommand'), false);
    assert.equal(failed.results[0].errorCode, 'OPERATION_FAILED');
    assert.equal(failed.results[0].recoveryClass, 'vendor-state-inspection');
    assert.doesNotMatch(failed.note, /undo via plugin_remove/);
    assert.equal(
      readFileSync(join(fleetHome, 'delegated.jsonl'), 'utf8').includes('OPAQUE_VENDOR_OUTPUT'),
      false,
    );
  }),
);

test(
  'plugin tool marks post-run persistence failures outcome-unknown without destructive recovery',
  withTempDir(async (dir) => {
    let fleetHome = '';
    const fixture = setup(dir, {
      pluginRunner: async () => {
        chmodSync(join(fleetHome, 'delegated.jsonl'), 0o400);
        return { exitCode: 0, output: 'vendor reported success' };
      },
    });
    fleetHome = fixture.fleetHome;
    try {
      const result = (await fixture.tool('plugin_install').handler({
        selector: 'demo@official',
        to: 'claude-code',
        commit: true,
      })) as any;
      const { delegatedId, ...publicResult } = result.results[0];
      assert.match(delegatedId, /^[0-9a-f-]{36}$/i);
      assert.deepEqual(publicResult, {
        status: 'outcome-unknown',
        agent: 'claude-code',
        name: 'demo',
        marketplace: 'official',
        command: 'claude plugin install demo@official',
        errorCode: 'OUTCOME_UNKNOWN',
        recoveryClass: 'vendor-state-inspection',
        provenanceRecorded: false,
      });
    } finally {
      chmodSync(join(fleetHome, 'delegated.jsonl'), 0o600);
    }
  }),
);

test(
  'plugin tool reports a pre-vendor lock refusal as failed without vendor recovery',
  withTempDir(async (dir) => {
    let calls = 0;
    const { tool, fleetHome } = setup(dir, {
      pluginRunner: async () => {
        calls++;
        return { exitCode: 0, output: '' };
      },
    });
    mkdirSync(fleetHome, { recursive: true });
    writeFileSync(join(fleetHome, '.lock'), 'held elsewhere');
    const result = (await tool('plugin_install').handler({
      selector: 'demo@official',
      to: 'claude-code',
      commit: true,
    })) as any;
    assert.deepEqual(result.results[0], {
      status: 'failed',
      agent: 'claude-code',
      name: 'demo',
      marketplace: 'official',
      command: 'claude plugin install demo@official',
      errorCode: 'OPERATION_FAILED',
      provenanceRecorded: false,
    });
    assert.equal(calls, 0);
  }),
);

test(
  'plugin tool reports a vendor success with no inventory change as a safe no-op',
  withTempDir(async (dir) => {
    const { tool } = setup(dir, {
      pluginRunner: async () => ({ exitCode: 0, output: 'vendor no-op' }),
    });
    const result = (await tool('plugin_install').handler({
      selector: 'no-op-plugin',
      to: 'claude-code',
      commit: true,
    })) as any;
    const { delegatedId, ...publicResult } = result.results[0];
    assert.match(delegatedId, /^[0-9a-f-]{36}$/i);
    assert.deepEqual(publicResult, {
      status: 'nothing-to-do',
      agent: 'claude-code',
      name: 'no-op-plugin',
      command: 'claude plugin install no-op-plugin',
      exitCode: 0,
      reasonCode: 'NO_CHANGE',
      provenanceRecorded: true,
    });
  }),
);

test(
  'plugin tool prevalidates delegated targets and never hides a partial multi-target result',
  withTempDir(async (dir) => {
    const claudeJson = join(dir, '.claude.json');
    writeFileSync(claudeJson, JSON.stringify({ mcpServers: {} }));
    let installed = false;
    const claude = {
      id: 'claude-code',
      displayName: 'Claude Code',
      capabilitySupport: { plugin: { inventory: 'supported', management: 'delegated' } },
      async detect() {
        return {
          id: this.id,
          displayName: this.displayName,
          present: true,
          configPaths: [],
          runtimeStatus: 'available' as const,
        };
      },
      async readInventory() {
        return installed
          ? [
              {
                kind: 'plugin' as const,
                name: 'demo',
                agent: this.id,
                scope: 'user' as const,
                enabled: true,
                source: { file: 'fixture' },
              },
            ]
          : [];
      },
    } satisfies AgentAdapter;
    const customWriter = {
      id: 'custom-writer',
      displayName: 'Custom writer',
      supportsWrite: true,
      capabilitySupport: { 'mcp-server': { inventory: 'supported', management: 'writable' } },
      async detect() {
        return { id: this.id, displayName: this.displayName, present: true, configPaths: [] };
      },
      async readInventory() {
        return [];
      },
      async renderInstall() {
        throw new Error('not reached');
      },
      async renderRemove() {
        throw new Error('not reached');
      },
      validate() {},
    } as AgentAdapter;
    let calls = 0;
    const fleetHome = join(dir, 'fleet-home');
    const tools = buildTools([claude, customWriter], {
      fleetHome,
      pluginRunner: async () => {
        calls++;
        installed = true;
        return { exitCode: 0, output: '' };
      },
    });
    const plugin = tools.find((candidate) => candidate.name === 'plugin_install')!;

    await assert.rejects(
      plugin.handler({
        selector: 'demo',
        to: 'claude-code,custom-writer',
        commit: true,
      }),
      /TARGET_UNAVAILABLE/,
    );
    assert.equal(calls, 0);

    const result = (await plugin.handler({ selector: 'demo', to: 'all', commit: true })) as any;
    assert.equal(calls, 1);
    assert.deepEqual(
      result.results.map((entry: any) => [entry.agent, entry.status]),
      [['claude-code', 'applied']],
    );
  }),
);

test(
  'whats_new omits source failure messages from the AI result',
  withTempDir(async (dir) => {
    const { tool } = setup(dir, {
      sources: [
        {
          id: 'broken-source',
          async list() {
            throw new Error('credential is OPAQUE_SOURCE_FAILURE');
          },
        },
      ],
    });
    const result = (await tool('whats_new').handler({ refresh: true })) as any;
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('OPAQUE_SOURCE_FAILURE'), false);
    assert.deepEqual(result.failures, [{ source: 'broken-source', code: 'SOURCE_UNAVAILABLE' }]);
  }),
);

test(
  'configured feedSources bounds MCP discovery and direct skill search for the selected Fleet home',
  withTempDir(async (dir) => {
    const fleetHome = join(dir, 'bounded-fleet-home');
    mkdirSync(fleetHome, { recursive: true });
    writeFileSync(join(fleetHome, 'config.json'), JSON.stringify({ feedSources: [] }));
    const { tool } = setup(dir, { fleetHome });

    const result = (await tool('whats_new').handler({ refresh: true })) as any;
    assert.deepEqual(result.updates, []);
    assert.deepEqual(result.recommendations, []);
    assert.deepEqual(result.failures, []);
    await assert.rejects(tool('skill_search').handler({ query: 'browser' }), /TARGET_UNAVAILABLE/);
  }),
);

test(
  'whats_new projects private update coordinates and hostile registry metadata safely',
  withTempDir(async (dir) => {
    const { tool, claudeJson } = setup(dir, {
      sources: [
        {
          id: 'hostile-source',
          async list() {
            return [
              {
                name: 'hostile\u001b]8;;https://evil.example\u0007' + 'x'.repeat(180),
                source: 'hostile-source',
                identifier: '../OPAQUE_IDENTIFIER',
                url: 'http://evil.example/?token=OPAQUE_URL_TOKEN',
                description: '\u202eOPAQUE_BIDI_DESCRIPTION',
                updatedAt: new Date().toISOString(),
                status: 'deprecated\nOPAQUE_STATUS',
                security: { level: 'caution', reasons: ['OPAQUE_HUB_REASON'] },
              },
              {
                name: 'private-update',
                source: 'hostile-source',
                identifier: '@private/opaquevelvetquasar',
                ecosystem: 'npm' as const,
                version: '2.0.0',
              },
              {
                name: 'safe-caution-recommendation',
                source: 'hostile-source',
                identifier: 'safe-caution-recommendation',
                ecosystem: 'npm' as const,
                version: '2.0.0',
                popularity: 100,
                status: 'caution',
                url: 'https://registry.example/safe-caution-recommendation',
                updatedAt: new Date().toISOString(),
              },
            ];
          },
        },
      ],
    });
    writeFileSync(
      claudeJson,
      JSON.stringify({
        mcpServers: {
          internal: {
            command: 'npx',
            args: ['-y', '@private/opaquevelvetquasar@1.0.0-OPAQUE9Z8Y7X6W5V4'],
          },
        },
      }),
    );
    const result = (await tool('whats_new').handler({ refresh: true })) as any;
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes('@private/opaquevelvetquasar'), false);
    assert.equal(serialized.includes('OPAQUE9Z8Y7X6W5V4'), false);
    assert.equal(serialized.includes('OPAQUE_IDENTIFIER'), false);
    assert.equal(serialized.includes('OPAQUE_URL_TOKEN'), false);
    assert.equal(serialized.includes('OPAQUE_HUB_REASON'), false);
    assert.equal(serialized.includes('OPAQUE_STATUS'), false);
    assert.equal(serialized.includes('\u001b'), false);
    assert.equal(serialized.includes('\u202e'), false);
    assert.deepEqual(Object.keys(result.updates[0]).sort(), [
      'agent',
      'kind',
      'name',
      'operation',
      'scope',
      'to',
    ]);
    assert.ok(result.recommendations[0].name.length <= 120);
    assert.deepEqual(result.recommendations[0].reasons, ['new', 'popular']);
    assert.equal(result.recommendations[0].trust, 'caution');
    assert.ok(result.recommendations[0].trustReasonCodes.includes('REGISTRY_STATUS_CAUTION'));
  }),
);

test(
  'self-protected name is refused by the install tool',
  withTempDir(async (dir) => {
    const { tool } = setup(dir);
    const res = (await tool('install').handler({
      name: 'fleet',
      to: 'claude-code',
      command: 'x',
      commit: true,
    })) as any;
    assert.equal(res.applied, 0);
    assert.equal(res.skips[0].kind, 'protected');
  }),
);

test(
  'plugin tool reports a fixed provenance warning when post-vendor lock folding fails',
  withTempDir(async (dir) => {
    let stateHome = '';
    const settingsPath = join(dir, 'claude-settings.json');
    const setupResult = setup(dir, {
      pluginRunner: async (argv) => {
        applyClaudePluginFixture(settingsPath, argv);
        mkdirSync(join(stateHome, 'fleet.lock'), { recursive: true });
        return { exitCode: 0, output: '' };
      },
    });
    stateHome = setupResult.fleetHome;
    const result = (await setupResult.tool('plugin_install').handler({
      selector: 'provenance-demo@official',
      to: 'claude-code',
      commit: true,
    })) as any;
    assert.equal(result.results[0].status, 'applied');
    assert.equal(result.results[0].provenanceRecorded, true);
    assert.equal(result.results[0].lockWarningCode, 'PROVENANCE_WARNING');
    assert.equal(Object.hasOwn(result.results[0], 'lockWarning'), false);
  }),
);
