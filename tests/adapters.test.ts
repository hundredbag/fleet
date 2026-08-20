import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeAdapter, parseMcpEntry } from '../src/adapters/claude-code.js';
import { CodexAdapter, parseCodexEntry } from '../src/adapters/codex.js';
import { GeminiAdapter, parseGeminiEntry } from '../src/adapters/gemini.js';
import { buildInventory } from '../src/core/inventory.js';
import type { AgentAdapter } from '../src/core/adapter.js';

test('claude: stdio entry', () => {
  const s = parseMcpEntry({ command: 'npx', args: ['-y', 'pkg'], env: { A: '1' } });
  assert.equal(s.transport, 'stdio');
  if (s.transport === 'stdio') {
    assert.equal(s.command, 'npx');
    assert.deepEqual(s.args, ['-y', 'pkg']);
  }
});

test('claude: http entry', () => {
  const s = parseMcpEntry({ type: 'http', url: 'https://x.test/mcp' });
  assert.equal(s.transport, 'http');
  if (s.transport === 'http') assert.equal(s.url, 'https://x.test/mcp');
});

test('claude: streamable-http aliases to http (regression)', () => {
  const s = parseMcpEntry({ type: 'streamable-http', url: 'https://x.test/mcp' });
  assert.equal(s.transport, 'http');
  if (s.transport === 'http') assert.equal(s.url, 'https://x.test/mcp');
});

test('claude: ws entry preserved as ws', () => {
  const s = parseMcpEntry({ type: 'ws', url: 'wss://x.test' });
  assert.equal(s.transport, 'ws');
});

test('claude: malformed args coerced away', () => {
  const s = parseMcpEntry({ command: 'x', args: 'not-an-array' });
  if (s.transport === 'stdio') assert.equal(s.args, undefined);
});

test('codex: stdio and flat-url remote (http, never sse)', () => {
  assert.equal(parseCodexEntry({ command: 'foo' }).transport, 'stdio');
  assert.equal(parseCodexEntry({ url: 'https://r.test' }).transport, 'http');
});

test('codex: nested transport table url is handled', () => {
  const s = parseCodexEntry({ transport: { type: 'streamable_http', url: 'https://r.test' } });
  assert.equal(s.transport, 'http');
  if (s.transport === 'http') assert.equal(s.url, 'https://r.test');
});

test('codex: http_headers maps to headers', () => {
  const s = parseCodexEntry({ url: 'https://r.test', http_headers: { Authorization: 'Bearer x' } });
  if (s.transport === 'http') assert.deepEqual(s.headers, { Authorization: 'Bearer x' });
});

test('gemini: httpUrl → http, url → sse, command → stdio (regression)', () => {
  assert.equal(parseGeminiEntry({ httpUrl: 'https://h.test' }).transport, 'http');
  assert.equal(parseGeminiEntry({ url: 'https://s.test' }).transport, 'sse');
  assert.equal(parseGeminiEntry({ command: 'c' }).transport, 'stdio');
});

test('inventory: tolerates absent agents and read errors', async () => {
  const present: AgentAdapter = {
    id: 'present',
    displayName: 'Present',
    detect: async () => ({ id: 'present', displayName: 'Present', present: true, configPaths: [] }),
    readInventory: async () => [
      {
        kind: 'mcp-server',
        name: 'x',
        agent: 'present',
        scope: 'user',
        enabled: true,
        spec: { transport: 'stdio', command: 'x' },
        source: { file: 'f' },
      },
    ],
  };
  const absent: AgentAdapter = {
    id: 'absent',
    displayName: 'Absent',
    detect: async () => ({ id: 'absent', displayName: 'Absent', present: false, configPaths: [] }),
    readInventory: async () => {
      throw new Error('should not be called when absent');
    },
  };
  const broken: AgentAdapter = {
    id: 'broken',
    displayName: 'Broken',
    detect: async () => ({ id: 'broken', displayName: 'Broken', present: true, configPaths: [] }),
    readInventory: async () => {
      throw new Error('boom');
    },
  };
  const inv = await buildInventory([present, absent, broken]);
  assert.equal(inv.agents.length, 3);
  assert.equal(inv.items.length, 1);
  assert.equal(inv.agents.find((a) => a.id === 'present')?.inventoryStatus, 'ok');
  assert.equal(inv.agents.find((a) => a.id === 'absent')?.inventoryStatus, 'not-present');
  assert.equal(inv.agents.find((a) => a.id === 'broken')?.inventoryStatus, 'read-failed');
});

test('inventory: distinguishes detect failure from successful empty inventory', async () => {
  const detectFailed: AgentAdapter = {
    id: 'detect-failed',
    displayName: 'Detect failed',
    detect: async () => {
      throw new Error('private detect detail');
    },
    readInventory: async () => [],
  };
  const empty: AgentAdapter = {
    id: 'empty',
    displayName: 'Empty',
    detect: async () => ({ id: 'empty', displayName: 'Empty', present: true, configPaths: [] }),
    readInventory: async () => [],
  };
  const inv = await buildInventory([detectFailed, empty]);
  assert.equal(inv.agents.find((a) => a.id === 'detect-failed')?.inventoryStatus, 'detect-failed');
  assert.equal(inv.agents.find((a) => a.id === 'empty')?.inventoryStatus, 'ok');
});

test('inventory: an invalid declared runtime enum is unverifiable, never ready', async () => {
  const adapter: AgentAdapter = {
    id: 'invalid-runtime',
    displayName: 'Invalid runtime',
    detect: async () => ({
      id: 'invalid-runtime',
      displayName: 'Invalid runtime',
      present: true,
      configPaths: [],
      runtimeStatus: 'invented-status' as any,
      configurationStatus: 'configured',
    }),
    readInventory: async () => [],
  };
  const inventory = await buildInventory([adapter]);
  assert.equal(inventory.agents[0]?.runtimeStatus, 'unverifiable');
  assert.equal(inventory.agents[0]?.setupStatus, 'configured-runtime-unverifiable');
});

test('inventory: contradictory BYO presence and configuration states are unavailable', async () => {
  const inconsistent = (id: string, present: boolean, configurationStatus: 'configured' | 'not-configured') =>
    ({
      id,
      displayName: id,
      async detect() {
        return { id, displayName: id, present, configPaths: [], configurationStatus };
      },
      async readInventory() {
        return [];
      },
    }) satisfies AgentAdapter;
  const inventory = await buildInventory([
    inconsistent('present-unconfigured', true, 'not-configured'),
    inconsistent('absent-configured', false, 'configured'),
  ]);
  assert.ok(inventory.agents.every((agent) => agent.configurationStatus === 'unavailable'));
  assert.ok(inventory.agents.every((agent) => agent.setupStatus === 'configuration-unavailable'));
  assert.ok(inventory.agents.every((agent) => agent.inventoryStatus === 'read-failed'));
});

test('inventory: BYO MCP specs must obey the discriminated transport union', async () => {
  const base = {
    kind: 'mcp-server' as const,
    name: 'ambiguous',
    agent: 'spoofed',
    scope: 'user' as const,
    enabled: true,
    source: { file: 'fixture' },
  };
  for (const spec of [
    { transport: 'stdio', command: 'run', url: 'https://other.test' },
    { transport: 'http', url: 'https://example.test', command: 'run', args: ['x'], env: {} },
  ]) {
    const adapter: AgentAdapter = {
      id: 'ambiguous-byo',
      displayName: 'Ambiguous BYO',
      async detect() {
        return { id: this.id, displayName: this.displayName, present: true, configPaths: [] };
      },
      async readInventory() {
        return [{ ...base, spec }] as any;
      },
    };
    const inventory = await buildInventory([adapter]);
    assert.equal(inventory.agents[0]?.inventoryStatus, 'read-failed');
    assert.equal(inventory.agents[0]?.setupStatus, 'inventory-unavailable');
    assert.deepEqual(inventory.items, []);
  }
});

test('built-in detection distinguishes installed-unconfigured from configured runtime missing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-detect-'));
  try {
    const executable = join(dir, 'claude');
    writeFileSync(executable, '#!/bin/sh\n');
    chmodSync(executable, 0o755);
    const missing = join(dir, 'missing');
    const installed = new ClaudeCodeAdapter(
      join(dir, 'missing.json'),
      join(dir, 'missing-skills'),
      join(dir, 'missing-rules'),
      join(dir, 'missing-settings'),
      join(dir, 'missing-plugins'),
      executable,
    );
    const installedInventory = await buildInventory([installed]);
    assert.equal(installedInventory.agents[0]?.present, false);
    assert.equal(installedInventory.agents[0]?.runtimeStatus, 'available');
    assert.equal(installedInventory.agents[0]?.configurationStatus, 'not-configured');
    assert.equal(installedInventory.agents[0]?.setupStatus, 'installed-unconfigured');

    const config = join(dir, 'config.toml');
    writeFileSync(config, '# configured\n');
    const configured = new CodexAdapter(
      config,
      join(dir, 'codex-skills'),
      join(dir, 'AGENTS.md'),
      join(dir, 'shared-skills'),
      missing,
    );
    const configuredInventory = await buildInventory([configured]);
    assert.equal(configuredInventory.agents[0]?.runtimeStatus, 'not-found');
    assert.equal(configuredInventory.agents[0]?.configurationStatus, 'configured');
    assert.equal(configuredInventory.agents[0]?.setupStatus, 'configured-runtime-missing');
    assert.equal(configuredInventory.agents[0]?.inventoryStatus, 'ok');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('codex: a native shared skill is configuration evidence and appears in inventory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-codex-shared-detect-'));
  try {
    const shared = join(dir, 'shared-skills');
    mkdirSync(shared, { recursive: true });
    const adapter = new CodexAdapter(
      join(dir, 'missing-config.toml'),
      join(dir, 'missing-own-skills'),
      join(dir, 'missing-rules.md'),
      shared,
      join(dir, 'missing-runtime'),
    );
    const emptyInventory = await buildInventory([adapter]);
    assert.equal(emptyInventory.agents[0]?.present, false);
    assert.equal(emptyInventory.agents[0]?.configurationStatus, 'not-configured');
    assert.equal(emptyInventory.agents[0]?.inventoryStatus, 'not-present');
    assert.deepEqual(emptyInventory.items, []);

    mkdirSync(join(shared, 'demo'));
    writeFileSync(join(shared, 'demo', 'SKILL.md'), '# Demo\n');
    const inventory = await buildInventory([adapter]);
    assert.equal(inventory.agents[0]?.present, true);
    assert.equal(inventory.agents[0]?.configurationStatus, 'configured');
    assert.equal(inventory.agents[0]?.inventoryStatus, 'ok');
    assert.deepEqual(
      inventory.items.map((item) => [item.kind, item.name]),
      [['skill', 'demo']],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('built-in detection treats a symlinked configuration leaf as unavailable and skips inventory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-detect-link-'));
  try {
    const real = join(dir, 'real.json');
    const linked = join(dir, 'settings.json');
    writeFileSync(real, JSON.stringify({ mcpServers: { hidden: { command: 'x' } } }));
    symlinkSync(real, linked);
    const adapter = new GeminiAdapter(linked, join(dir, 'missing-gemini'));
    const inventory = await buildInventory([adapter]);
    assert.equal(inventory.agents[0]?.present, true);
    assert.equal(inventory.agents[0]?.configurationStatus, 'unavailable');
    assert.equal(inventory.agents[0]?.setupStatus, 'configuration-unavailable');
    assert.equal(inventory.agents[0]?.inventoryStatus, 'read-failed');
    assert.deepEqual(inventory.items, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('claude inventory fails closed on malformed settings and tracked project config', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-detect-malformed-'));
  try {
    const claudeJson = join(dir, 'claude.json');
    const settings = join(dir, 'settings.json');
    writeFileSync(claudeJson, JSON.stringify({ mcpServers: {} }));
    writeFileSync(settings, '{invalid');
    const malformedSettings = new ClaudeCodeAdapter(
      claudeJson,
      join(dir, 'skills'),
      join(dir, 'CLAUDE.md'),
      settings,
      join(dir, 'plugins'),
      join(dir, 'missing-claude'),
    );
    const settingsInventory = await buildInventory([malformedSettings]);
    assert.equal(settingsInventory.agents[0]?.setupStatus, 'inventory-unavailable');
    assert.equal(settingsInventory.agents[0]?.inventoryStatus, 'read-failed');

    const project = join(dir, 'project');
    const projectConfig = join(project, '.mcp.json');
    const projectClaudeJson = join(dir, 'project-claude.json');
    mkdirSync(project);
    writeFileSync(projectConfig, '{invalid');
    writeFileSync(projectClaudeJson, JSON.stringify({ mcpServers: {}, projects: { [project]: {} } }));
    writeFileSync(settings, JSON.stringify({ enabledPlugins: {} }));
    const malformedProject = new ClaudeCodeAdapter(
      projectClaudeJson,
      join(dir, 'project-skills'),
      join(dir, 'project-rules'),
      settings,
      join(dir, 'project-plugins'),
      join(dir, 'missing-claude'),
    );
    const projectInventory = await buildInventory([malformedProject]);
    assert.equal(projectInventory.agents[0]?.setupStatus, 'inventory-unavailable');
    assert.equal(projectInventory.agents[0]?.inventoryStatus, 'read-failed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('built-in inventories reject syntactically valid MCP documents with invalid semantic shapes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-detect-shape-'));
  try {
    const claudeJson = join(dir, 'claude', 'config.json');
    const geminiJson = join(dir, 'gemini', 'settings.json');
    const codexToml = join(dir, 'codex', 'config.toml');
    mkdirSync(join(dir, 'claude'), { recursive: true });
    mkdirSync(join(dir, 'gemini'), { recursive: true });
    mkdirSync(join(dir, 'codex'), { recursive: true });
    writeFileSync(claudeJson, JSON.stringify({ mcpServers: [] }));
    writeFileSync(geminiJson, JSON.stringify({ mcpServers: [] }));
    writeFileSync(codexToml, '[mcp_servers]\nbroken = "not-an-entry"\n');
    const adapters: AgentAdapter[] = [
      new ClaudeCodeAdapter(
        claudeJson,
        join(dir, 'claude-skills'),
        join(dir, 'claude-rules'),
        join(dir, 'claude-settings'),
        join(dir, 'claude-plugins'),
        join(dir, 'missing-claude'),
      ),
      new GeminiAdapter(geminiJson, join(dir, 'missing-gemini')),
      new CodexAdapter(
        codexToml,
        join(dir, 'codex-skills'),
        join(dir, 'codex-rules'),
        join(dir, 'shared-skills'),
        join(dir, 'missing-codex'),
      ),
    ];
    const inventory = await buildInventory(adapters);
    assert.ok(inventory.agents.every((agent) => agent.inventoryStatus === 'read-failed'));
    assert.ok(inventory.agents.every((agent) => agent.setupStatus === 'inventory-unavailable'));
    assert.deepEqual(inventory.items, []);

    writeFileSync(
      claudeJson,
      JSON.stringify({
        mcpServers: { ambiguous: { type: 'http', url: 'https://example.test', command: 'x' } },
      }),
    );
    writeFileSync(
      geminiJson,
      JSON.stringify({ mcpServers: { ambiguous: { httpUrl: 'https://example.test', command: 'x' } } }),
    );
    writeFileSync(codexToml, "[mcp_servers.ambiguous]\nurl = 'https://example.test'\nargs = ['x']\n");
    const ambiguousTransports = await buildInventory([
      new ClaudeCodeAdapter(
        claudeJson,
        join(dir, 'claude-skills'),
        join(dir, 'claude-rules'),
        join(dir, 'claude-settings'),
        join(dir, 'claude-plugins'),
        join(dir, 'missing-claude'),
      ),
      new GeminiAdapter(geminiJson, join(dir, 'missing-gemini')),
      new CodexAdapter(
        codexToml,
        join(dir, 'codex-skills'),
        join(dir, 'codex-rules'),
        join(dir, 'shared-skills'),
        join(dir, 'missing-codex'),
      ),
    ]);
    assert.ok(ambiguousTransports.agents.every((agent) => agent.inventoryStatus === 'read-failed'));
    assert.deepEqual(ambiguousTransports.items, []);

    writeFileSync(
      codexToml,
      "[mcp_servers.bad.transport]\ntype = 'bogus'\nurl = 'https://example.test/mcp'\n",
    );
    const nestedTransport = await buildInventory([
      new CodexAdapter(
        codexToml,
        join(dir, 'codex-skills'),
        join(dir, 'codex-rules'),
        join(dir, 'shared-skills'),
        join(dir, 'missing-codex'),
      ),
    ]);
    assert.equal(nestedTransport.agents[0]?.inventoryStatus, 'read-failed');
    assert.equal(nestedTransport.agents[0]?.setupStatus, 'inventory-unavailable');

    writeFileSync(
      codexToml,
      "approval_policy = []\nsandbox_mode = 42\n[mcp_servers.demo]\ncommand = 'x'\nenabled = 'false'\n",
    );
    const invalidKnownFields = await buildInventory([
      new CodexAdapter(
        codexToml,
        join(dir, 'codex-skills'),
        join(dir, 'codex-rules'),
        join(dir, 'shared-skills'),
        join(dir, 'missing-codex'),
      ),
    ]);
    assert.equal(invalidKnownFields.agents[0]?.inventoryStatus, 'read-failed');
    assert.equal(invalidKnownFields.agents[0]?.setupStatus, 'inventory-unavailable');
    assert.deepEqual(invalidKnownFields.items, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
