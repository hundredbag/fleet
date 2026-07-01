import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { GeminiAdapter } from '../src/adapters/gemini.js';
import { buildTools, type FleetTool } from '../src/mcp/tools.js';

function setup(dir: string) {
  const claudeJson = join(dir, '.claude.json');
  const codexToml = join(dir, 'config.toml');
  const geminiJson = join(dir, 'gemini.json');
  writeFileSync(claudeJson, JSON.stringify({ mcpServers: {} }, null, 2));
  writeFileSync(codexToml, '# codex\n');
  const adapters = [
    new ClaudeCodeAdapter(claudeJson, join(dir, '_sk-claude')),
    new CodexAdapter(codexToml, join(dir, '_sk-codex')),
    new GeminiAdapter(geminiJson),
  ];
  const tools = buildTools(adapters, { fleetHome: join(dir, 'fleet-home') });
  const tool = (n: string): FleetTool => {
    const t = tools.find((x) => x.name === n);
    if (!t) throw new Error(`no tool ${n}`);
    return t;
  };
  return { claudeJson, codexToml, geminiJson, tool };
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
    assert.match(res.skips[0].reason, /not supported/);
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
  'inventory tool does not leak config snippets from a parse error',
  withTempDir(async (dir) => {
    const { tool, claudeJson } = setup(dir);
    writeFileSync(claudeJson, '{ "mcpServers": broken "supersecret_token" ');
    const res = (await tool('inventory').handler({})) as any;
    const note = res.agents.find((a: any) => a.id === 'claude-code')?.note ?? '';
    assert.match(note, /not valid JSON/);
    assert.equal(JSON.stringify(res).includes('supersecret_token'), false);
  }),
);

test(
  'install tool rejects supplying both command and url',
  withTempDir(async (dir) => {
    const { tool } = setup(dir);
    await assert.rejects(
      tool('install').handler({ name: 'x', to: 'claude-code', command: 'c', url: 'https://u' }),
      /exactly one/,
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
