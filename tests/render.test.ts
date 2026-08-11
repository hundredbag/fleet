import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderInventory } from '../src/cli/render.js';
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
