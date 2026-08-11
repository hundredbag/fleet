import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMcpEntry } from '../src/adapters/claude-code.js';
import { parseCodexEntry } from '../src/adapters/codex.js';
import { parseGeminiEntry } from '../src/adapters/gemini.js';
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
