import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderInventory, renderProvenanceWarning } from '../src/cli/render.js';
import type { Inventory } from '../src/core/types.js';

test('render: empty state shows agents and the no-servers hint', () => {
  const inv: Inventory = {
    agents: [
      {
        id: 'claude-code',
        displayName: 'Claude Code',
        present: true,
        configPaths: [],
        inventoryStatus: 'ok',
      },
      {
        id: 'gemini',
        displayName: 'Gemini CLI',
        present: false,
        configPaths: [],
        note: 'not configured on this machine',
        inventoryStatus: 'not-present',
      },
    ],
    items: [],
  };
  const s = renderInventory(inv);
  assert.match(s, /Claude Code/);
  assert.match(s, /not configured on this machine/);
  assert.match(s, /MCP servers: none/);
  assert.match(s, /Skills: none/);
});

test('render: matrix marks scope, multi-agent, and disabled', () => {
  const inv: Inventory = {
    agents: [
      { id: 'a', displayName: 'A', present: true, configPaths: [], inventoryStatus: 'ok' },
      { id: 'b', displayName: 'B', present: true, configPaths: [], inventoryStatus: 'ok' },
    ],
    items: [
      {
        kind: 'mcp-server',
        name: 'srv',
        agent: 'a',
        scope: 'user',
        enabled: true,
        spec: { transport: 'stdio', command: 'x' },
        source: { file: 'f' },
      },
      {
        kind: 'mcp-server',
        name: 'srv',
        agent: 'b',
        scope: 'project',
        enabled: false,
        spec: { transport: 'stdio', command: 'x' },
        source: { file: 'f' },
      },
    ],
  };
  const s = renderInventory(inv);
  assert.match(s, /srv/);
  assert.match(s, /✓U/); // enabled on agent A, user scope
  assert.match(s, /✗P/); // disabled on agent B, project scope
});

test('render: repeated private contexts are counted instead of hidden by one scope tag', () => {
  const base = {
    kind: 'mcp-server' as const,
    name: 'shared',
    agent: 'a',
    scope: 'local' as const,
    enabled: true,
    spec: { transport: 'stdio' as const, command: 'x' },
  };
  const rendered = renderInventory({
    agents: [{ id: 'a', displayName: 'A', present: true, configPaths: [], inventoryStatus: 'ok' }],
    items: [
      { ...base, source: { file: 'project-one' } },
      { ...base, source: { file: 'project-two' } },
    ],
  });
  assert.match(rendered, /✓L×2/);
});

test('render: plugin rows retain marketplace identity', () => {
  const inv: Inventory = {
    agents: [{ id: 'codex', displayName: 'Codex', present: true, configPaths: [], inventoryStatus: 'ok' }],
    items: [
      {
        kind: 'plugin',
        name: 'shared',
        marketplace: 'first',
        agent: 'codex',
        scope: 'user',
        enabled: true,
        source: { file: 'fixture' },
      },
      {
        kind: 'plugin',
        name: 'shared',
        marketplace: 'second',
        agent: 'codex',
        scope: 'user',
        enabled: true,
        source: { file: 'fixture' },
      },
    ],
  };
  const rendered = renderInventory(inv);
  assert.match(rendered, /shared@first/);
  assert.match(rendered, /shared@second/);
});

test('render: delegated lock-fold failure is a fixed provenance warning', () => {
  assert.equal(renderProvenanceWarning(false), '');
  const warning = renderProvenanceWarning(true);
  assert.match(warning, /PROVENANCE_WARNING/);
  assert.match(warning, /plugin state changed/);
});
