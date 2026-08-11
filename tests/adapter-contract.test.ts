import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { GeminiAdapter } from '../src/adapters/gemini.js';
import type { AgentAdapter } from '../src/core/adapter.js';
import type { PrimitiveKind } from '../src/core/types.js';
import { capabilityCell, operationAllowed } from '../src/web/operations.js';
import { resolveTargets } from '../src/core/orchestrator.js';

const KINDS: PrimitiveKind[] = [
  'mcp-server',
  'skill',
  'rule',
  'permission',
  'plugin',
  'command',
  'hook',
  'subagent',
];

test('built-in adapters explicitly declare support for every primitive kind', () => {
  for (const adapter of [new ClaudeCodeAdapter(), new CodexAdapter(), new GeminiAdapter()]) {
    assert.deepEqual(Object.keys(adapter.capabilitySupport).sort(), [...KINDS].sort(), adapter.id);
    assert.deepEqual(adapter.capabilitySupport.command, { inventory: 'unsupported', management: 'none' });
    assert.deepEqual(adapter.capabilitySupport.hook, { inventory: 'unsupported', management: 'none' });
  }
});

test('BYO adapters without capability metadata remain unverifiable and grant no operations', () => {
  const adapter: AgentAdapter = {
    id: 'custom',
    displayName: 'Custom',
    detect: async () => ({ id: 'custom', displayName: 'Custom', present: true, configPaths: [] }),
    readInventory: async () => [],
  };
  assert.deepEqual(
    capabilityCell({
      adapter,
      agent: { id: 'custom', displayName: 'Custom', present: true, configPaths: [], inventoryStatus: 'ok' },
      kind: 'mcp-server',
      hasInstance: false,
      hasSourceInstance: true,
    }),
    { availability: 'unverifiable', management: 'none', operations: [] },
  );
});

const agent = {
  id: 'custom',
  displayName: 'Custom',
  present: true,
  configPaths: [],
  inventoryStatus: 'ok' as const,
};

test('writable metadata never grants operations when supportsWrite is false', () => {
  const adapter = {
    id: 'custom',
    displayName: 'Custom',
    supportsWrite: false,
    capabilitySupport: { 'mcp-server': { inventory: 'supported', management: 'writable' } },
    detect: async () => agent,
    readInventory: async () => [],
    renderInstall: async () => {
      throw new Error('must not run');
    },
    renderRemove: async () => {
      throw new Error('must not run');
    },
    validate: () => {},
  } as AgentAdapter;
  const input = { adapter, agent, kind: 'mcp-server' as const, hasInstance: true, hasSourceInstance: true };
  assert.deepEqual(capabilityCell(input).operations, []);
  assert.equal(operationAllowed(input, 'remove'), false);
});

test('missing relevant writer method fails closed despite writable metadata', () => {
  const adapter = {
    id: 'custom',
    displayName: 'Custom',
    supportsWrite: true,
    capabilitySupport: { skill: { inventory: 'supported', management: 'writable' } },
    detect: async () => agent,
    readInventory: async () => [],
    renderInstallSkill: async () => {
      throw new Error('must not run');
    },
  } as AgentAdapter;
  assert.deepEqual(
    capabilityCell({ adapter, agent, kind: 'skill', hasInstance: true, hasSourceInstance: true }).operations,
    [],
  );
});

test('target resolution uses the writer contract for the requested capability kind', async () => {
  const adapter = {
    id: 'custom',
    displayName: 'Custom',
    supportsWrite: true,
    capabilitySupport: { skill: { inventory: 'supported', management: 'writable' } },
    detect: async () => agent,
    readInventory: async () => [],
    renderInstallSkill: async () => ({ file: '/tmp/skill', fsKind: 'dir', newContent: '', dirOp: 'install' }),
    renderRemoveSkill: async () => ({ file: '/tmp/skill', fsKind: 'dir', newContent: '', dirOp: 'remove' }),
  } as AgentAdapter;
  assert.deepEqual(await resolveTargets([adapter], 'custom', 'skill'), ['custom']);
  await assert.rejects(resolveTargets([adapter], 'custom'), /non-writable/);
});

test('unsupported kinds never gain operations from BYO writable metadata', () => {
  const adapter: AgentAdapter = {
    id: 'custom',
    displayName: 'Custom',
    supportsWrite: true,
    capabilitySupport: { permission: { inventory: 'supported', management: 'writable' } },
    detect: async () => agent,
    readInventory: async () => [],
  };
  const input = { adapter, agent, kind: 'permission' as const, hasInstance: true, hasSourceInstance: true };
  assert.deepEqual(capabilityCell(input).operations, []);
  assert.equal(operationAllowed(input, 'remove'), false);
});

test('inventory cells never advertise update without a matching feed item', () => {
  const adapter = {
    id: 'custom',
    displayName: 'Custom',
    supportsWrite: true,
    capabilitySupport: { 'mcp-server': { inventory: 'supported', management: 'writable' } },
    detect: async () => agent,
    readInventory: async () => [],
    renderInstall: async () => {
      throw new Error('must not run');
    },
    renderRemove: async () => {
      throw new Error('must not run');
    },
    validate: () => {},
  } as AgentAdapter;
  const input = { adapter, agent, kind: 'mcp-server' as const, hasInstance: true, hasSourceInstance: true };
  assert.deepEqual(capabilityCell(input).operations, ['remove', 'sync']);
  assert.equal(
    operationAllowed(input, 'update'),
    true,
    'plan-time validation still accepts a feed-backed update',
  );
});

test('metadata-absent disabled instances remain unverifiable', async () => {
  const { mapInventory } = await import('../src/web/public-mappers.js');
  const adapter: AgentAdapter = {
    id: 'custom',
    displayName: 'Custom',
    detect: async () => agent,
    readInventory: async () => [],
  };
  const mapped = mapInventory(
    {
      agents: [agent],
      items: [
        {
          kind: 'permission',
          name: 'deny-x',
          agent: 'custom',
          scope: 'user',
          enabled: false,
          effect: 'deny',
          source: { file: '/private' },
        },
      ],
    },
    [adapter],
  );
  assert.equal(mapped.capabilities[0]!.instances[0]!.availability, 'unverifiable');
});
