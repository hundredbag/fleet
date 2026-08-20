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
    assert.equal(adapter.contractVersion, 1);
    assert.deepEqual(Object.keys(adapter.capabilitySupport).sort(), [...KINDS].sort(), adapter.id);
    assert.deepEqual(adapter.capabilitySupport.command, { inventory: 'unsupported', management: 'none' });
    assert.deepEqual(adapter.capabilitySupport.hook, { inventory: 'unsupported', management: 'none' });
  }
  assert.deepEqual(new CodexAdapter().capabilitySupport.plugin, {
    inventory: 'unverifiable',
    management: 'delegated',
  });
});

test('explicitly unverifiable inventory can describe delegated management without granting operations', () => {
  const adapter = new CodexAdapter();
  const cell = capabilityCell({
    adapter,
    agent: { id: 'codex', displayName: 'Codex', present: true, configPaths: [], inventoryStatus: 'ok' },
    kind: 'plugin',
    hasInstance: false,
    hasSourceInstance: true,
  });
  assert.deepEqual(cell, { availability: 'unverifiable', management: 'delegated', operations: [] });
  assert.equal(
    operationAllowed(
      {
        adapter,
        agent: { id: 'codex', displayName: 'Codex', present: true, configPaths: [], inventoryStatus: 'ok' },
        kind: 'plugin',
        hasInstance: false,
        hasSourceInstance: true,
      },
      'install',
    ),
    false,
  );
});

test('writable metadata never turns project/local instances into user-file mutations', () => {
  const adapter = new ClaudeCodeAdapter();
  for (const kind of ['mcp-server', 'skill', 'rule'] as const) {
    const cell = capabilityCell({
      adapter,
      agent: {
        id: 'claude-code',
        displayName: 'Claude Code',
        present: true,
        configPaths: [],
        inventoryStatus: 'ok',
      },
      kind,
      hasInstance: true,
      scope: kind === 'rule' ? 'project' : 'local',
      hasSourceInstance: true,
    });
    assert.equal(cell.management, 'read-only');
    assert.deepEqual(cell.operations, []);
  }
});

test('built-in writers reject non-user scope before every render surface', async () => {
  for (const adapter of [new ClaudeCodeAdapter(), new CodexAdapter()]) {
    const local = { kind: 'skill' as const, name: 'demo', scope: 'local' as const };
    await assert.rejects(adapter.renderInstallSkill({ name: 'demo', dir: '/not/read' }, local), /read-only/);
    await assert.rejects(adapter.renderRemoveSkill(local), /read-only/);
    const project = { kind: 'rule' as const, name: 'demo', scope: 'project' as const };
    await assert.rejects(adapter.renderInstallRule('body', project), /read-only/);
    await assert.rejects(adapter.renderRemoveRule(project), /read-only/);
  }
});

test('public plugin instances expose marketplace separately from the logical capability name', async () => {
  const { mapInventory } = await import('../src/web/public-mappers.js');
  const adapter: AgentAdapter = {
    id: 'claude-code',
    displayName: 'Claude Code',
    capabilitySupport: { plugin: { inventory: 'supported', management: 'delegated' } },
    detect: async () => ({ id: 'claude-code', displayName: 'Claude Code', present: true, configPaths: [] }),
    readInventory: async () => [],
  };
  const mapped = mapInventory(
    {
      agents: [
        {
          id: 'claude-code',
          displayName: 'Claude Code',
          present: true,
          configPaths: [],
          inventoryStatus: 'ok',
        },
      ],
      items: [
        {
          kind: 'plugin',
          name: 'figma',
          marketplace: 'official',
          agent: 'claude-code',
          scope: 'user',
          enabled: true,
          source: { file: '/private/settings.json' },
        },
        {
          kind: 'plugin',
          name: 'figma',
          marketplace: 'team',
          agent: 'claude-code',
          scope: 'user',
          enabled: true,
          source: { file: '/private/settings.json' },
        },
        {
          kind: 'plugin',
          name: 'group/plugin',
          marketplace: 'official',
          agent: 'claude-code',
          scope: 'user',
          enabled: true,
          source: { file: '/private/settings.json' },
        },
      ],
    },
    [adapter],
  );
  assert.equal(mapped.capabilities[0]?.name, 'figma');
  assert.equal(mapped.capabilities[0]?.instances[0]?.marketplace, 'official');
  assert.equal(mapped.capabilities[1]?.name, 'figma');
  assert.equal(mapped.capabilities[1]?.instances[0]?.marketplace, 'team');
  const invalidVendorCoordinate = mapped.capabilities.find((item) => item.name === 'group/plugin');
  assert.equal(invalidVendorCoordinate?.instances[0]?.management, 'read-only');
  assert.deepEqual(invalidVendorCoordinate?.instances[0]?.operations, []);
});

test('public capability grouping cannot confuse plugin names with marketplace coordinates', async () => {
  const { mapInventory } = await import('../src/web/public-mappers.js');
  const adapters: AgentAdapter[] = ['codex', 'claude-code'].map((id) => ({
    id,
    displayName: id,
    capabilitySupport: { plugin: { inventory: 'supported', management: 'delegated' } },
    detect: async () => ({ id, displayName: id, present: true, configPaths: [] }),
    readInventory: async () => [],
  }));
  const agents = adapters.map((adapter) => ({
    id: adapter.id,
    displayName: adapter.displayName,
    present: true,
    configPaths: [],
    inventoryStatus: 'ok' as const,
  }));
  const mapped = mapInventory(
    {
      agents,
      items: [
        {
          kind: 'plugin',
          name: 'a',
          marketplace: 'b',
          agent: 'codex',
          scope: 'user',
          enabled: true,
          source: { file: '/private/codex.json' },
        },
        {
          kind: 'plugin',
          name: 'a|b',
          agent: 'claude-code',
          scope: 'user',
          enabled: true,
          source: { file: '/private/claude.json' },
        },
        {
          kind: 'plugin',
          name: 'a',
          marketplace: 'bad!',
          agent: 'claude-code',
          scope: 'user',
          enabled: true,
          source: { file: '/private/claude.json' },
        },
      ],
    },
    adapters,
  );

  assert.equal(mapped.capabilities.length, 2);
  assert.equal(mapped.uniqueCapabilityKeys, 2);
  assert.equal(mapped.withheldCount, 1);
  const qualified = mapped.capabilities.find((capability) => capability.name === 'a');
  const unsafe = mapped.capabilities.find((capability) => capability.name === 'a|b');
  assert.equal(qualified?.instances.find((instance) => instance.agent === 'codex')?.marketplace, 'b');
  const withheldInstance = qualified?.instances.find((instance) => instance.agent === 'claude-code');
  assert.equal(withheldInstance?.management, 'read-only');
  assert.deepEqual(withheldInstance?.operations, []);
  const unsafeInstance = unsafe?.instances.find((instance) => instance.agent === 'claude-code');
  assert.equal(unsafeInstance?.marketplace, undefined);
  assert.equal(unsafeInstance?.management, 'read-only');
  assert.deepEqual(unsafeInstance?.operations, []);
});

test('delegated plugin inventory outside user scope is advertised as read-only', () => {
  const adapter: AgentAdapter = {
    id: 'claude-code',
    displayName: 'Claude Code',
    capabilitySupport: { plugin: { inventory: 'supported', management: 'delegated' } },
    detect: async () => ({ id: 'claude-code', displayName: 'Claude Code', present: true, configPaths: [] }),
    readInventory: async () => [],
  };
  const cell = capabilityCell({
    adapter,
    agent: {
      id: 'claude-code',
      displayName: 'Claude Code',
      present: true,
      configPaths: [],
      inventoryStatus: 'ok',
    },
    kind: 'plugin',
    hasInstance: true,
    scope: 'local',
    hasSourceInstance: false,
    delegatedSupported: true,
  });
  assert.equal(cell.management, 'read-only');
  assert.deepEqual(cell.operations, []);
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

test('Web allows explicit initialization of an installed but unconfigured writable agent', () => {
  const adapter = {
    id: 'custom',
    displayName: 'Custom',
    supportsWrite: true,
    capabilitySupport: { 'mcp-server': { inventory: 'supported', management: 'writable' } },
    async detect() {
      return {
        id: this.id,
        displayName: this.displayName,
        present: false,
        configPaths: [],
        runtimeStatus: 'available' as const,
        configurationStatus: 'not-configured' as const,
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
  const input = {
    adapter,
    agent: {
      id: 'custom',
      displayName: 'Custom',
      present: false,
      configPaths: [],
      runtimeStatus: 'available' as const,
      configurationStatus: 'not-configured' as const,
      setupStatus: 'installed-unconfigured' as const,
      inventoryStatus: 'ok' as const,
    },
    kind: 'mcp-server' as const,
    hasInstance: false,
    hasSourceInstance: false,
  };
  assert.equal(capabilityCell(input).availability, 'missing');
  assert.equal(operationAllowed(input, 'install'), true);
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

test('explicit read-only capability metadata overrides retained writer methods', async () => {
  let writes = 0;
  const adapter = {
    id: 'legacy-reader',
    displayName: 'Legacy reader',
    supportsWrite: true,
    capabilitySupport: { skill: { inventory: 'supported', management: 'read-only' } },
    detect: async () => ({ ...agent, id: 'legacy-reader', displayName: 'Legacy reader' }),
    readInventory: async () => [],
    renderInstallSkill: async () => {
      writes++;
      return { file: '/tmp/skill', fsKind: 'dir', newContent: '', dirOp: 'install' };
    },
    renderRemoveSkill: async () => {
      writes++;
      return { file: '/tmp/skill', fsKind: 'dir', newContent: '', dirOp: 'remove' };
    },
  } as AgentAdapter;
  await assert.rejects(resolveTargets([adapter], 'legacy-reader', 'skill'), /non-writable/);
  assert.deepEqual(await resolveTargets([adapter], 'all', 'skill'), []);
  assert.equal(writes, 0);
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
