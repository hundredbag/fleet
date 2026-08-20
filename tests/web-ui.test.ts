import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Script, runInNewContext } from 'node:vm';
import type { AgentAdapter } from '../src/core/adapter.js';
import { isPublicCapabilityName } from '../src/core/redact.js';
import { apiFeed, apiInventory } from '../src/web/api.js';
import { mapFeed, mapOverview } from '../src/web/public-mappers.js';
import { renderPage } from '../src/web/ui.js';
import {
  APPLY_RESPONSE_VALIDATOR_BROWSER_SOURCE,
  DISCOVERY_RECOMMENDATION_VALIDATOR_BROWSER_SOURCE,
  DISCOVERY_VIEW_SECTIONS_BROWSER_SOURCE,
  INVENTORY_OPERATION_PAYLOAD_BROWSER_SOURCE,
  INVENTORY_VIEW_ITEMS_BROWSER_SOURCE,
  PUBLIC_IDENTITY_VALIDATOR_BROWSER_SOURCE,
  ROLLBACK_RESPONSE_VALIDATOR_BROWSER_SOURCE,
  discoveryViewSections,
  inventoryOperationPayload,
  inventoryViewItems,
} from '../src/web/ui/client.js';
import {
  dashboardAdapters,
  dashboardFailingFeedSource,
  dashboardFeedSources,
} from './fixtures/web-dashboard.js';

test('browser and server use the same public capability-name boundary', () => {
  const publicName = runInNewContext(`${PUBLIC_IDENTITY_VALIDATOR_BROWSER_SOURCE}; publicName`) as (
    value: unknown,
  ) => boolean;
  for (const name of [
    'demo',
    'group/child',
    '분류/도구',
    'mcp:foo',
    '~',
    'foo c:bar',
    'foo .config/name',
    '${HOME}/private',
    'urn:name',
    'token=abcdef',
    'Bearer abcdefgh',
  ]) {
    assert.equal(publicName(name), isPublicCapabilityName(name), name);
  }
});

test('generated apply validator accepts bounded result DTOs and rejects unknown states', () => {
  const validApply = runInNewContext(`(${APPLY_RESPONSE_VALIDATOR_BROWSER_SOURCE})`) as (
    value: unknown,
  ) => boolean;
  const id = '00000000-0000-4000-8000-000000000001';
  const valid = {
    schemaVersion: 2,
    auditId: id,
    applied: 1,
    auditRecorded: 1,
    unrecordedApplied: 0,
    skipped: 0,
    warningCodes: [],
    outcome: 'applied',
    records: [
      {
        agent: 'codex',
        kind: 'mcp-server',
        name: 'demo',
        scope: 'user',
        op: 'install',
        auditRecorded: true,
        auditId: id,
      },
    ],
  };
  assert.equal(validApply(valid), true);
  assert.equal(
    validApply({
      schemaVersion: 2,
      applied: 0,
      skipped: 1,
      outcome: 'outcome-unknown',
      warningCodes: ['OUTCOME_UNKNOWN'],
      recoveryClass: 'vendor-state-inspection',
      records: [
        {
          agent: 'claude-code',
          kind: 'plugin',
          name: 'demo',
          marketplace: 'official',
          scope: 'user',
          op: 'install',
          delegatedRecorded: false,
          delegatedId: id,
        },
      ],
    }),
    true,
  );
  assert.equal(validApply({ ...valid, outcome: 'success' }), false);
  assert.equal(
    validApply({
      ...valid,
      auditId: undefined,
      auditRecorded: 0,
      unrecordedApplied: 1,
      outcome: 'partial',
      warningCodes: ['AUDIT_WRITE_FAILED'],
      recoveryClass: 'manual-config-recovery',
      records: [{ ...valid.records[0], auditRecorded: false, auditId: undefined }],
    }),
    true,
  );
  assert.equal(validApply({ ...valid, warningCodes: ['RAW_ERROR'] }), false);
  assert.equal(validApply({ ...valid, records: [{ ...valid.records[0], scope: '/private' }] }), false);
  assert.equal(validApply({ ...valid, applied: -1 }), false);
  assert.equal(validApply({ ...valid, applied: 0, auditRecorded: 0, outcome: 'applied' }), false);
  assert.equal(validApply({ ...valid, auditRecorded: 2 }), false);
  assert.equal(validApply({ ...valid, auditId: undefined }), false);
  assert.equal(validApply({ ...valid, records: [] }), false);
  assert.equal(validApply({ ...valid, records: [null] }), false);
  assert.equal(
    validApply({
      ...valid,
      records: [{ ...valid.records[0], auditRecorded: false, auditId: undefined }],
    }),
    false,
  );
  for (const delegatedWithoutTarget of [
    { outcome: 'failed', warningCodes: ['OPERATION_FAILED'] },
    { outcome: 'nothing-to-do', warningCodes: ['NO_CHANGE'] },
    {
      outcome: 'outcome-unknown',
      warningCodes: ['OUTCOME_UNKNOWN'],
      recoveryClass: 'vendor-state-inspection',
    },
  ]) {
    assert.equal(
      validApply({
        schemaVersion: 2,
        applied: 0,
        skipped: 1,
        records: [],
        ...delegatedWithoutTarget,
      }),
      false,
    );
  }
  assert.equal(
    validApply({
      ...valid,
      auditId: undefined,
      auditRecorded: 0,
      unrecordedApplied: 1,
      outcome: 'partial',
      records: [{ ...valid.records[0], auditRecorded: false, auditId: undefined }],
    }),
    false,
  );
  assert.equal(validApply({ ...valid, records: [{ ...valid.records[0], agent: '/private/agent' }] }), false);
  assert.equal(
    validApply({ ...valid, records: [{ ...valid.records[0], name: '/home/private/capability' }] }),
    false,
  );
  assert.equal(validApply({ ...valid, records: [{ ...valid.records[0], name: '${HOME}/private' }] }), false);
  assert.equal(validApply({ ...valid, records: [{ ...valid.records[0], name: '그룹/스킬' }] }), true);
  assert.equal(validApply({ ...valid, records: [{ ...valid.records[0], name: 'urn:name' }] }), false);
  assert.equal(validApply({ ...valid, records: [{ ...valid.records[0], name: 'token=abcdef' }] }), false);
  assert.equal(
    validApply({
      schemaVersion: 2,
      applied: 1,
      skipped: 0,
      warningCodes: [],
      outcome: 'applied',
      records: [
        {
          agent: 'codex',
          kind: 'mcp-server',
          name: 'demo',
          scope: 'user',
          op: 'install',
          auditRecorded: false,
        },
      ],
    }),
    false,
  );
  const pluginRecord = {
    agent: 'claude-code',
    kind: 'plugin',
    name: 'demo',
    scope: 'user',
    op: 'install',
  };
  assert.equal(
    validApply({
      schemaVersion: 2,
      applied: 1,
      skipped: 0,
      warningCodes: [],
      outcome: 'applied',
      records: [{ ...pluginRecord, delegatedRecorded: false }],
    }),
    false,
  );
  assert.equal(
    validApply({
      schemaVersion: 2,
      applied: 0,
      skipped: 1,
      warningCodes: ['NO_CHANGE'],
      outcome: 'nothing-to-do',
      records: [{ ...pluginRecord, delegatedRecorded: true }],
    }),
    false,
  );
  assert.equal(
    validApply({
      schemaVersion: 2,
      applied: 0,
      skipped: 1,
      warningCodes: ['OUTCOME_UNKNOWN'],
      outcome: 'outcome-unknown',
      recoveryClass: 'manual-config-recovery',
      records: [{ ...pluginRecord, delegatedRecorded: false, delegatedId: id }],
    }),
    false,
  );
  assert.equal(
    validApply({
      schemaVersion: 2,
      applied: 1,
      skipped: 0,
      warningCodes: ['OPERATION_WARNING'],
      outcome: 'applied',
      recoveryClass: 'vendor-state-inspection',
      records: [{ ...pluginRecord, delegatedRecorded: true, delegatedId: id }],
    }),
    false,
  );
  assert.equal(
    validApply({
      schemaVersion: 2,
      applied: 0,
      skipped: 1,
      warningCodes: ['NO_CHANGE'],
      outcome: 'nothing-to-do',
      recoveryClass: 'vendor-state-inspection',
      records: [{ ...pluginRecord, delegatedRecorded: false, delegatedId: id }],
    }),
    false,
  );
  assert.equal(
    validApply({
      ...valid,
      records: [{ ...valid.records[0], delegatedRecorded: true }],
    }),
    false,
  );
});

test('generated rollback validator requires the versioned bounded result contract', () => {
  const validRollback = runInNewContext(`(${ROLLBACK_RESPONSE_VALIDATOR_BROWSER_SOURCE})`) as (
    value: unknown,
  ) => boolean;
  assert.equal(validRollback({ schemaVersion: 2, action: 'restored' }), true);
  assert.equal(
    validRollback({
      schemaVersion: 2,
      action: 'removed',
      reasonCode: 'AUDIT_WRITE_FAILED',
      provenanceRecorded: false,
      recoveryClass: 'audit-history-repair',
    }),
    true,
  );
  assert.equal(validRollback({ action: 'restored' }), false);
  assert.equal(validRollback({ schemaVersion: 2, action: 'restored', reasonCode: '/private/error' }), false);
  assert.equal(validRollback({ schemaVersion: 2, action: 'skipped', provenanceRecorded: false }), false);
});

const VOID_ELEMENTS = new Set([
  'area',
  'base',
  'br',
  'col',
  'embed',
  'hr',
  'img',
  'input',
  'link',
  'meta',
  'param',
  'source',
  'track',
  'wbr',
]);

function withoutNonRenderedContent(fragment: string): string {
  const withoutScripts = fragment.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  const tokens = withoutScripts.match(/<!--[\s\S]*?-->|<(?:[^>"']|"[^"]*"|'[^']*')+>|[^<]+|</g) ?? [];
  const stack: { tag: string; hidden: boolean }[] = [];
  let output = '';

  for (const token of tokens) {
    const closing = token.match(/^<\s*\/\s*([a-z][\w:-]*)/i);
    if (closing) {
      const current = stack.pop();
      if (current && !current.hidden) output += token;
      continue;
    }

    const opening = token.match(/^<\s*([a-z][\w:-]*)/i);
    if (opening && !token.startsWith('<!--')) {
      const tag = opening[1]!.toLowerCase();
      const attributes = token.slice(opening[0].length, -1).replace(/\/$/, '');
      const parentHidden = stack.at(-1)?.hidden ?? false;
      const hiddenAttribute = /(?:^|\s)hidden(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?(?=\s|$)/i.test(
        attributes,
      );
      const ariaHidden = /(?:^|\s)aria-hidden\s*=\s*(?:"true"|'true'|true)(?=\s|$)/i.test(attributes);
      const hidden = parentHidden || hiddenAttribute || ariaHidden;
      if (!hidden) output += token;
      if (!token.endsWith('/>') && !VOID_ELEMENTS.has(tag)) stack.push({ tag, hidden });
      continue;
    }

    if (!(stack.at(-1)?.hidden ?? false)) output += token;
  }

  return output;
}

test('rendered-content helper handles hidden ancestry and exact attribute names', () => {
  assert.equal(
    withoutNonRenderedContent(
      '<button><div hidden><div>FALSE_VISIBLE_NAME</div></div><span aria-hidden="true">HIDDEN</span></button>',
    ),
    '<button></button>',
  );
  assert.match(
    withoutNonRenderedContent(
      '<main data-hidden="true"><span data-aria-hidden="true">Systems aligned</span></main>',
    ),
    /Systems aligned/,
  );
});

test('dashboard fixture flows through the real inventory and feed read models', async () => {
  const inventory = await apiInventory(dashboardAdapters);
  assert.deepEqual(
    inventory.agents.map((agent) => [agent.id, agent.present]),
    [
      ['claude-code', true],
      ['codex', true],
    ],
  );
  assert.ok(
    inventory.agents.every(
      (agent) =>
        agent.runtimeStatus === 'available' &&
        agent.configurationStatus === 'configured' &&
        agent.setupStatus === 'ready' &&
        agent.inventoryAvailable,
    ),
  );
  const playwright = inventory.capabilities.find(
    (capability) => capability.kind === 'mcp-server' && capability.name === 'playwright',
  );
  assert.ok(playwright);
  assert.equal(playwright.coverage, 'all-present');
  assert.deepEqual(
    playwright.instances.map((instance) => instance.agent),
    ['claude-code', 'codex'],
  );
  assert.deepEqual(
    inventory.capabilities
      .find((capability) => capability.kind === 'mcp-server' && capability.name === 'github')
      ?.instances.filter((instance) => instance.availability === 'installed')
      .map((instance) => instance.agent),
    ['claude-code'],
  );
  assert.deepEqual(
    inventory.capabilities
      .find((capability) => capability.kind === 'skill' && capability.name === 'shared-review')
      ?.instances.filter((instance) => instance.availability === 'installed')
      .map((instance) => instance.agent)
      .sort(),
    ['claude-code', 'codex'],
  );
  assert.deepEqual(
    inventory.capabilities
      .find((capability) => capability.kind === 'skill' && capability.name === 'claude-only-debugging')
      ?.instances.filter((instance) => instance.availability === 'installed')
      .map((instance) => instance.agent),
    ['claude-code'],
  );
  assert.deepEqual(
    inventory.capabilities
      .filter((capability) => capability.kind === 'rule')
      .map((capability) => capability.name),
    ['verify-before-apply'],
  );
  assert.deepEqual(
    inventory.capabilities
      .filter((capability) => capability.kind === 'plugin')
      .map((capability) => capability.name),
    ['review-tools'],
  );

  const feed = await apiFeed(dashboardAdapters, dashboardFeedSources, { fleetHome: '/fixture/fleet-home' });
  assert.deepEqual(feed.updates, [
    {
      kind: 'mcp-server',
      name: 'playwright',
      agent: 'claude-code',
      scope: 'user',
      to: '2.0.0',
      operation: 'update',
    },
  ]);
  assert.equal(feed.recommendations.find((item) => item.name === 'trusted-browser-tools')?.trust, 'no-flags');
  assert.equal(
    feed.recommendations.find((item) => item.name === 'trusted-browser-tools')?.operation,
    'install',
  );
  assert.equal(
    feed.recommendations.find((item) => item.name === 'trusted-browser-tools')?.updatedAt,
    '2099-01-01T00:00:00.000Z',
  );
  assert.equal(feed.recommendations.find((item) => item.name === 'caution-legacy-tools')?.trust, 'caution');
  assert.equal(inventory.capabilityInstances, 8);
  assert.equal(inventory.uniqueCapabilityKeys, 6);
  const plugin = inventory.capabilities.find((capability) => capability.kind === 'plugin');
  assert.deepEqual(
    plugin?.instances.map((instance) => [instance.agent, instance.management, instance.operations]),
    [
      ['claude-code', 'delegated', ['remove']],
      ['codex', 'delegated', ['install']],
    ],
  );
});

test('Web discovery advertises only package-backed installs accepted by the exact all-target preview', async () => {
  const writable = (id: string, installed: boolean): AgentAdapter =>
    ({
      id,
      displayName: id,
      supportsWrite: true,
      capabilitySupport: { 'mcp-server': { inventory: 'supported', management: 'writable' } },
      async detect() {
        return {
          id,
          displayName: id,
          present: true,
          configPaths: [],
          runtimeStatus: 'available',
          configurationStatus: 'configured',
        };
      },
      async readInventory() {
        return installed
          ? [
              {
                kind: 'mcp-server' as const,
                name: 'coordinate-clash',
                agent: id,
                scope: 'user' as const,
                enabled: true,
                spec: { transport: 'stdio' as const, command: 'npx', args: ['installed-other@1.0.0'] },
                source: { file: 'fixture' },
              },
            ]
          : [];
      },
      async renderInstall() {
        throw new Error('not reached');
      },
      async renderRemove() {
        throw new Error('not reached');
      },
      validate() {},
    }) as AgentAdapter;
  const feed = await apiFeed(
    [writable('writer-a', true), writable('writer-b', false)],
    [
      {
        id: 'actionability-fixture',
        async list() {
          return [
            {
              name: 'coordinate-clash',
              source: 'actionability-fixture',
              ecosystem: 'npm' as const,
              identifier: 'different-package',
              popularity: 100,
            },
            {
              name: 'remote-only',
              source: 'actionability-fixture',
              url: 'https://example.test/remote-only',
              popularity: 100,
            },
            {
              name: 'overlong-identifier',
              source: 'actionability-fixture',
              ecosystem: 'npm' as const,
              identifier: 'a'.repeat(201),
              popularity: 100,
            },
            {
              name: 'overlong-version',
              source: 'actionability-fixture',
              ecosystem: 'npm' as const,
              identifier: 'safe-package',
              version: `v${'1'.repeat(64)}`,
              popularity: 100,
            },
          ];
        },
      },
    ],
    { fleetHome: '/fixture/feed-actionability' },
  );
  assert.equal(feed.recommendations.find((item) => item.name === 'coordinate-clash')?.operation, null);
  assert.equal(feed.recommendations.find((item) => item.name === 'remote-only')?.operation, null);
  assert.equal(
    feed.recommendations.some((item) => item.name === 'overlong-identifier'),
    false,
  );
  assert.equal(
    feed.recommendations.some((item) => item.name === 'overlong-version'),
    false,
  );
});

test('inventory DTO preserves distinct scopes and counts private contexts on one agent', async () => {
  const adapter: AgentAdapter = {
    id: 'scoped',
    displayName: 'Scoped',
    capabilitySupport: { 'mcp-server': { inventory: 'supported', management: 'read-only' } },
    async detect() {
      return { id: this.id, displayName: this.displayName, present: true, configPaths: [] };
    },
    async readInventory() {
      const item = (scope: 'user' | 'project' | 'local', file: string) => ({
        kind: 'mcp-server' as const,
        name: 'same-name',
        agent: this.id,
        scope,
        enabled: true,
        spec: { transport: 'stdio' as const, command: scope },
        source: { file },
      });
      return [item('user', 'user'), item('project', 'project'), item('local', 'one'), item('local', 'two')];
    },
  };
  const emptyAdapter: AgentAdapter = {
    id: 'empty-scoped',
    displayName: 'Empty scoped',
    capabilitySupport: { 'mcp-server': { inventory: 'supported', management: 'read-only' } },
    async detect() {
      return { id: this.id, displayName: this.displayName, present: true, configPaths: [] };
    },
    async readInventory() {
      return [];
    },
  };
  const inventory = await apiInventory([adapter, emptyAdapter]);
  const instances = inventory.capabilities.find((item) => item.name === 'same-name')?.instances ?? [];
  assert.deepEqual(
    instances.map((instance) => [instance.scope, instance.entryCount ?? 1]),
    [
      ['user', 1],
      ['project', 1],
      ['local', 2],
      [undefined, 1],
    ],
  );
  assert.equal(inventory.capabilities[0]?.coverage, 'agent-only');
  assert.deepEqual(instances.find((instance) => instance.scope === 'local')?.operations, []);
  const scopedFilters = {
    kind: 'mcp-server',
    status: 'read-only',
    sort: 'name' as const,
    query: '',
  };
  const scopedNames = inventoryViewItems(inventory, scopedFilters).map((capability) => capability.name);
  assert.deepEqual(scopedNames, ['same-name']);
  const browserInventoryView = runInNewContext(
    '(' + INVENTORY_VIEW_ITEMS_BROWSER_SOURCE + ')',
  ) as typeof inventoryViewItems;
  assert.deepEqual(
    JSON.parse(JSON.stringify(browserInventoryView(inventory, scopedFilters))).map(
      (capability: { name: string }) => capability.name,
    ),
    scopedNames,
  );
  const overview = mapOverview(
    inventory,
    { lockStatus: 'not-present', checked: 0, findings: [], unmanaged: [] },
    Date.now(),
  );
  assert.equal(overview.capabilityInstances, 4);
  assert.equal(overview.agents[0]?.capabilityInstances, 4);
  assert.equal(overview.agents[1]?.capabilityInstances, 0);
});

test('inventory DTO never advertises a mutation for duplicate entries inside one writable scope', async () => {
  const adapter: AgentAdapter = {
    id: 'duplicate-scope',
    displayName: 'Duplicate scope',
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
        name: 'duplicate',
        agent: this.id,
        scope: 'user' as const,
        enabled: true,
        spec: { transport: 'stdio' as const, command: 'safe' },
        source: { file },
      });
      return [item('one'), item('two')];
    },
    async renderInstall() {
      throw new Error('not used');
    },
    async renderRemove() {
      throw new Error('not used');
    },
    validate() {},
  } as AgentAdapter;
  const inventory = await apiInventory([adapter]);
  const instance = inventory.capabilities.find((item) => item.name === 'duplicate')?.instances[0];
  assert.equal(instance?.entryCount, 2);
  assert.equal(instance?.management, 'none');
  assert.deepEqual(instance?.operations, []);
});

test('overview counts real BYO capability rows even when management metadata is absent', async () => {
  const adapter: AgentAdapter = {
    id: 'metadata-optional',
    displayName: 'Metadata optional',
    async detect() {
      return { id: this.id, displayName: this.displayName, present: true, configPaths: [] };
    },
    async readInventory() {
      return [
        {
          kind: 'mcp-server',
          name: 'reported-server',
          agent: this.id,
          scope: 'user',
          enabled: true,
          spec: { transport: 'stdio', command: 'safe' },
          source: { file: 'fixture' },
        },
      ];
    },
  };
  const inventory = await apiInventory([adapter]);
  assert.equal(inventory.capabilities[0]?.instances[0]?.availability, 'unverifiable');
  assert.equal(inventory.capabilityInstances, 1);
  const overview = mapOverview(
    inventory,
    { lockStatus: 'not-present', checked: 0, findings: [], unmanaged: [] },
    Date.now(),
  );
  assert.equal(overview.capabilityInstances, 1);
  assert.equal(overview.agents[0]?.capabilityInstances, 1);
});

test('inventory DTO truthfully models read-only and failed adapter cells for the UI', async () => {
  const adapters: AgentAdapter[] = [
    {
      id: 'reader',
      displayName: 'Reader',
      supportsWrite: false,
      capabilitySupport: { skill: { inventory: 'supported', management: 'read-only' } },
      async detect() {
        return { id: 'reader', displayName: 'Reader', present: true, configPaths: [] };
      },
      async readInventory() {
        return [
          {
            kind: 'skill' as const,
            name: 'safe-review',
            agent: 'reader',
            scope: 'user' as const,
            enabled: true,
            path: '/private/not-public',
            meta: { description: 'Review safely.' },
            source: { file: '/private/not-public/SKILL.md' },
          },
        ];
      },
    },
    {
      id: 'failed',
      displayName: 'Failed adapter',
      supportsWrite: false,
      capabilitySupport: { skill: { inventory: 'supported', management: 'read-only' } },
      async detect() {
        return { id: 'failed', displayName: 'Failed adapter', present: true, configPaths: [] };
      },
      async readInventory() {
        throw new Error('private adapter detail');
      },
    },
  ];
  const inventory = await apiInventory(adapters);
  const capability = inventory.capabilities.find((item) => item.name === 'safe-review');
  assert.ok(capability);
  assert.deepEqual(
    capability.instances.map((instance) => [
      instance.agent,
      instance.availability,
      instance.management,
      instance.operations,
    ]),
    [
      ['reader', 'installed', 'read-only', []],
      ['failed', 'unavailable', 'none', []],
    ],
  );
  assert.equal('path' in capability, false);
  assert.equal('raw' in capability, false);
  const filters = { kind: 'all', status: 'read-only', sort: 'kind' as const, query: '' };
  assert.deepEqual(
    inventoryViewItems(inventory, filters).map((item) => item.name),
    ['safe-review'],
  );
  assert.deepEqual(
    inventoryViewItems(inventory, { ...filters, status: 'unavailable' }).map((item) => item.name),
    ['safe-review'],
  );
});

test('inventory local view model distinguishes empty and search no-results without refetching', async () => {
  const inventory = await apiInventory(dashboardAdapters);
  const base = { kind: 'all', status: 'all', sort: 'kind' as const, query: '' };
  assert.deepEqual(inventoryViewItems({ agents: inventory.agents, capabilities: [] }, base), []);
  assert.deepEqual(inventoryViewItems(inventory, { ...base, query: 'no-such-capability' }), []);
  assert.deepEqual(
    inventoryViewItems(inventory, { ...base, query: 'github' }).map((item) => item.name),
    ['github'],
  );
  assert.deepEqual(
    inventoryViewItems(inventory, { ...base, status: 'all-present' }).map((item) => item.name),
    ['playwright', 'shared-review'],
  );
  const unsafeUrlCapability = {
    ...inventory.capabilities[0]!,
    name: 'safe-name',
    description: undefined,
    sourceLabel: undefined,
    sourceUrl: 'https://user:password@example.test/item?token=secret-needle',
    coordinate: undefined,
    instances: [],
  };
  assert.deepEqual(
    inventoryViewItems(
      { agents: inventory.agents, capabilities: [unsafeUrlCapability] },
      { ...base, query: 'secret-needle' },
    ),
    [],
  );
});

test('generated inventory helpers execute without transpiler globals and match typed behavior', async () => {
  assert.doesNotMatch(INVENTORY_VIEW_ITEMS_BROWSER_SOURCE, /__name/);
  assert.doesNotMatch(INVENTORY_OPERATION_PAYLOAD_BROWSER_SOURCE, /__name/);
  const browserView = runInNewContext('(' + INVENTORY_VIEW_ITEMS_BROWSER_SOURCE + ')', {
    URL,
  }) as typeof inventoryViewItems;
  const browserPayload = runInNewContext(
    '(' + INVENTORY_OPERATION_PAYLOAD_BROWSER_SOURCE + ')',
  ) as typeof inventoryOperationPayload;
  const inventory = await apiInventory(dashboardAdapters);
  const filters = { kind: 'all', status: 'gap', sort: 'kind' as const, query: 'github' };
  assert.deepEqual(
    Array.from(browserView(inventory, filters), (item) => item.name),
    inventoryViewItems(inventory, filters).map((item) => item.name),
  );
  const plugin = inventory.capabilities.find((item) => item.kind === 'plugin');
  const target = plugin?.instances.find((instance) => instance.operations.includes('install'));
  assert.ok(plugin && target);
  assert.deepEqual(
    JSON.parse(JSON.stringify(browserPayload('install', plugin, target, inventory))),
    inventoryOperationPayload('install', plugin, target, inventory),
  );
});

test('discovery model searches public metadata, applies kind and trust filters, and bounds each section', () => {
  const recommendations = [
    ...Array.from({ length: 8 }, (_, index) => ({
      kind: 'mcp-server',
      name: `mcp-${index}`,
      identifier: index === 7 ? '@scope/browser-needle' : `@scope/mcp-${index}`,
      description: index === 6 ? 'Browser needle description' : undefined,
      category: index === 5 ? 'browser-needle-category' : undefined,
      source: 'public-registry',
      reasons: index % 2 ? ['popular'] : ['new', 'related'],
      trust: index === 4 ? 'caution' : index === 3 ? 'unknown' : 'no-flags',
      operation: 'install' as const,
    })),
    ...Array.from({ length: 7 }, (_, index) => ({
      kind: 'skill',
      name: `skill-${index}`,
      source: 'skills-registry',
      reasons: ['popular'],
      trust: 'no-flags',
      operation: null,
    })),
    ...Array.from({ length: 5 }, (_, index) => ({
      kind: 'plugin',
      name: `plugin-${index}`,
      source: 'marketplace',
      reasons: ['marketplace'],
      trust: 'no-flags',
      operation: index === 0 ? ('install' as const) : null,
    })),
  ];
  const feed = { recommendations };
  const base = { query: '', kind: 'all', trust: 'all', sort: 'recommended' as const };
  const bounded = discoveryViewSections(feed, base, {});
  assert.deepEqual(
    bounded.map((section) => [section.kind, section.visible.length, section.total]),
    [
      ['mcp-server', 6, 8],
      ['skill', 6, 7],
      ['plugin', 4, 5],
    ],
  );
  assert.equal(bounded[0]?.canExpand, true);
  assert.deepEqual(
    bounded[0]?.visible.map((item) => item.name),
    ['mcp-0', 'mcp-1', 'mcp-2', 'mcp-3', 'mcp-4', 'mcp-5'],
  );
  assert.deepEqual(bounded[0]?.visible[0]?.reasons, ['new', 'related']);
  assert.equal(bounded[0]?.visible[3]?.trust, 'unknown');
  assert.equal(discoveryViewSections(feed, base, { 'mcp-server': true })[0]?.visible.length, 8);
  assert.equal(discoveryViewSections(feed, base, { 'mcp-server': true })[0]?.canCollapse, true);
  assert.deepEqual(
    discoveryViewSections(feed, { ...base, query: 'browser' }, {})[0]?.visible.map((item) => item.name),
    ['mcp-5', 'mcp-6', 'mcp-7'],
  );
  assert.deepEqual(
    discoveryViewSections(feed, { ...base, kind: 'mcp-server', trust: 'caution' }, {})[0]?.visible.map(
      (item) => item.name,
    ),
    ['mcp-4'],
  );
  assert.deepEqual(
    discoveryViewSections(feed, { ...base, kind: 'skill' }, {}).map((section) => section.kind),
    ['skill'],
  );
});

test('discovery newest sort uses only valid public timestamps and keeps deterministic ties', () => {
  const recommendations = [
    {
      kind: 'mcp-server',
      name: 'recommended-first',
      source: 'r',
      reasons: [],
      trust: 'unknown',
      operation: null,
    },
    {
      kind: 'mcp-server',
      name: 'newest-a',
      source: 'r',
      reasons: [],
      trust: 'unknown',
      operation: null,
      updatedAt: '2026-08-02T00:00:00.000Z',
    },
    {
      kind: 'mcp-server',
      name: 'newest-b',
      source: 'r',
      reasons: [],
      trust: 'unknown',
      operation: null,
      updatedAt: '2026-08-02T00:00:00.000Z',
    },
    {
      kind: 'mcp-server',
      name: 'older',
      source: 'r',
      reasons: [],
      trust: 'unknown',
      operation: null,
      updatedAt: '2026-07-01T00:00:00.000Z',
    },
  ];
  const feed = { recommendations };
  const base = { query: '', kind: 'all', trust: 'all' };
  assert.deepEqual(
    discoveryViewSections(feed, { ...base, sort: 'recommended' }, {})[0]?.visible.map((item) => item.name),
    ['recommended-first', 'newest-a', 'newest-b', 'older'],
  );
  assert.deepEqual(
    discoveryViewSections(feed, { ...base, sort: 'newest' }, {})[0]?.visible.map((item) => item.name),
    ['newest-a', 'newest-b', 'older', 'recommended-first'],
  );
});

test('feed mapper allowlists only parseable timestamps and normalizes them to ISO', () => {
  const base = {
    updates: [],
    skillUpdates: [],
    failures: [],
    fromCache: false,
    recommendations: [
      {
        kind: 'skill',
        name: 'valid',
        source: 'r',
        reasons: [],
        trust: 'unknown',
        operation: null,
        updatedAt: '2026-08-02T12:30:00Z',
      },
      {
        kind: 'plugin',
        name: 'invalid',
        source: 'r',
        reasons: [],
        trust: 'unknown',
        operation: null,
        updatedAt: 'not-a-date',
      },
      { kind: 'mcp-server', name: 'unknown', source: 'r', reasons: [], trust: 'unknown', operation: null },
    ],
  };
  const mapped = mapFeed(base);
  assert.equal(mapped.recommendations[0]?.updatedAt, '2026-08-02T12:30:00.000Z');
  assert.equal(mapped.recommendations[1]?.updatedAt, undefined);
  assert.equal(mapped.recommendations[2]?.updatedAt, undefined);
});

test('generated discovery helper executes closure-free and matches typed behavior', async () => {
  assert.doesNotMatch(DISCOVERY_VIEW_SECTIONS_BROWSER_SOURCE, /__name/);
  const browserView = runInNewContext(
    '(' + DISCOVERY_VIEW_SECTIONS_BROWSER_SOURCE + ')',
  ) as typeof discoveryViewSections;
  const feed = await apiFeed(dashboardAdapters, dashboardFeedSources, { fleetHome: '/fixture/fleet-home' });
  const filters = { query: 'browser', kind: 'mcp-server', trust: 'no-flags', sort: 'recommended' as const };
  assert.deepEqual(
    JSON.parse(JSON.stringify(browserView(feed, filters, { 'mcp-server': false }))),
    discoveryViewSections(feed, filters, { 'mcp-server': false }),
  );
});

test('discovery feed failures expose only the safe public source identifier', async () => {
  const feed = await apiFeed(dashboardAdapters, [dashboardFailingFeedSource], {
    fleetHome: '/fixture/fleet-home',
  });
  assert.deepEqual(feed.failures, [{ source: 'dashboard-failing-registry' }]);
  assert.doesNotMatch(JSON.stringify(feed), /DASHBOARD_FIXTURE_CAUGHT_ERROR_DETAIL/);
});

test('generated discovery validator accepts real producer reasons and rejects arbitrary text', async () => {
  const validate = runInNewContext('(' + DISCOVERY_RECOMMENDATION_VALIDATOR_BROWSER_SOURCE + ')') as (
    item: unknown,
  ) => boolean;
  const feed = await apiFeed(dashboardAdapters, dashboardFeedSources, {
    fleetHome: '/fixture/fleet-home',
  });
  assert.ok(feed.recommendations.length > 0);
  assert.equal(feed.recommendations.every(validate), true);
  assert.equal(
    validate({
      kind: 'plugin',
      name: 'safe-plugin',
      source: 'marketplace-source',
      reasons: ['marketplace'],
      trust: 'unknown',
      operation: null,
    }),
    true,
  );
  const relatedBase = {
    kind: 'skill',
    name: 'related-skill',
    source: 'source',
    trust: 'unknown',
    operation: null,
  };
  assert.equal(validate({ ...relatedBase, reasons: ['related'] }), true);
  assert.equal(validate({ ...relatedBase, reasons: ['related to your setup (private-token)'] }), false);
  assert.equal(validate({ ...relatedBase, reasons: [], updatedAt: '2026-08-02T12:30:00.000Z' }), true);
  assert.equal(validate({ ...relatedBase, reasons: [], updatedAt: '2026-08-02T12:30:00Z' }), false);
  assert.equal(validate({ ...relatedBase, reasons: [], updatedAt: 'not-a-date' }), false);
  assert.equal(
    validate({
      kind: 'skill',
      name: 'unsafe',
      source: 'source',
      reasons: ['raw producer error text'],
      trust: 'unknown',
      operation: null,
    }),
    false,
  );
});

test('discovery workbench renders bounded local controls, truthful metadata, and guarded actions', () => {
  const html = renderPage();
  assert.match(html, /const discoveryViewSections =/);
  assert.match(html, /renderDiscovery/);
  assert.match(html, /Discovery kind/);
  assert.match(html, /No flags/);
  assert.match(html, /Caution/);
  assert.match(html, /Unknown/);
  assert.match(html, /Show all/);
  assert.match(html, /Collapse/);
  assert.match(html, /item\.reasons\.forEach/);
  assert.match(html, /reasons\.setAttribute\('role','group'\)/);
  assert.match(html, /enumLabel\(trustLabels, item\.trust\)/);
  assert.match(html, /recommendationReasonLabel\(reason\)/);
  assert.match(html, /failure\.source/);
  assert.doesNotMatch(html, /failure\.(?:error|message|stack)/);
  assert.match(html, /const validDiscoveryRecommendation =/);
  assert.match(html, /data-discovery-filter/);
  assert.match(html, /data-discovery-toggle/);
  assert.match(html, /replacement\.focus\(\)/);
  assert.match(html, /item\.ecosystem === 'npm' \|\| item\.ecosystem === 'pypi'/);
  assert.match(html, /doPlan\(t\('action\.install'\)/);
  assert.match(html, /to:'all'/);
  assert.match(html, /Local CLI guidance was not provided by this source/);
  assert.match(html, /Open marketplace source/);
  assert.match(html, /Marketplace or CLI guidance was not provided by this source/);
  assert.doesNotMatch(html, /Preview delegated install/);
  assert.match(html, /refresh\.sources/);
  assert.match(html, /search\.setAttribute\('aria-label', searchLabel\)/);
  assert.doesNotMatch(html, /fit score|fit percentage|recommendation grade/i);
  assert.match(html, /Recommended/);
  assert.match(html, /Newest/);
  assert.match(html, /추천순/);
  assert.match(html, /최신순/);
  assert.match(
    html,
    /Recommendations consider freshness, popularity, relevance to your installed setup, and marketplace availability\./,
  );
  assert.match(html, /최신성, 인기도, 설치된 설정과의 관련성 및 마켓플레이스 제공 여부/);
  assert.match(html, /toLocaleDateString\(language === 'ko' \? 'ko-KR' : 'en-US'/);
  assert.match(html, /discoverySort = sort\.value; renderDiscovery\(feedModel\)/);
  assert.match(html, /sectionContainer\.hidden = !section/);
  assert.match(html, /heading\.append\(node\('h3'/);
  assert.doesNotMatch(html, /item\.kind === 'mcp-server' \? 'h3' : 'h4'/);
  assert.doesNotMatch(html, /discoverySort[\s\S]{0,160}(?:get\(|fetch\()/);
});

test('discovery renders three full-width kind sections with responsive card grids', () => {
  const html = renderPage();
  assert.match(html, /class="discovery-sections"/);
  assert.match(html, /class="card discovery-section"[\s\S]*id="recommended"/);
  assert.match(html, /class="card discovery-section"[\s\S]*id="recskills"/);
  assert.match(html, /class="card discovery-section"[\s\S]*id="recplugins"/);
  assert.doesNotMatch(html, /Skills and plugins|스킬 및 플러그인/);
  assert.match(html, /\.discovery-sections \{ display:grid; grid-template-columns:minmax\(0,1fr\)/);
  assert.match(
    html,
    /\.discovery-list \{ display:grid; grid-template-columns:repeat\(auto-fit,minmax\(min\(100%,260px\),1fr\)\)/,
  );
});

test('inventory status badges visibly pair the agent display name with status', () => {
  const html = renderPage();
  assert.match(
    html,
    /const visibleLabel = includeAgent === false \? label : \(agent \? agent\.displayName : instance\.agent\) \+ ' · ' \+ label/,
  );
  assert.match(html, /statusBadge\(instance, inventory, false\)/);
  assert.match(html, /node\('span', '', visibleLabel\)/);
  assert.doesNotMatch(html, /badge\.append\(icon, node\('span', '', label\)\)/);
});

test('inventory advertised plugin install and multi-source sync build deterministic plan payloads', async () => {
  const inventory = await apiInventory(dashboardAdapters);
  const plugin = inventory.capabilities.find((item) => item.kind === 'plugin');
  const pluginTarget = plugin?.instances.find((instance) => instance.operations.includes('install'));
  assert.ok(plugin && pluginTarget);
  assert.deepEqual(inventoryOperationPayload('install', plugin, pluginTarget, inventory), {
    action: 'install',
    kind: 'plugin',
    name: 'review-tools',
    to: 'codex',
    marketplace: 'fixture-marketplace',
  });

  const agents = [
    { id: 'a', displayName: 'A' },
    { id: 'b', displayName: 'B' },
    { id: 'c', displayName: 'C' },
  ];
  const capability = {
    kind: 'skill',
    name: 'shared',
    coverage: 'gap',
    instances: [
      { agent: 'a', availability: 'installed', management: 'writable' },
      { agent: 'b', availability: 'installed', management: 'writable' },
      { agent: 'c', availability: 'missing', management: 'writable' },
    ],
  };
  assert.deepEqual(
    inventoryOperationPayload('sync', capability, capability.instances[2]!, {
      agents,
      capabilities: [capability],
    }),
    { action: 'sync', kind: 'skill', name: 'shared', from: 'a', to: 'c' },
  );
  const scopedSkill = {
    ...capability,
    instances: [
      { agent: 'a', scope: 'user', availability: 'installed', management: 'writable' },
      capability.instances[2]!,
    ],
  };
  assert.deepEqual(
    inventoryOperationPayload('remove', scopedSkill, scopedSkill.instances[0]!, {
      agents: [agents[0]!, agents[2]!],
      capabilities: [scopedSkill],
    }),
    { action: 'remove', kind: 'skill', name: 'shared', from: 'a', scope: 'user' },
  );

  const disabledSource = {
    ...capability,
    instances: [
      { agent: 'a', availability: 'disabled', management: 'writable' },
      { agent: 'c', availability: 'missing', management: 'writable' },
    ],
  };
  assert.deepEqual(
    inventoryOperationPayload('sync', disabledSource, disabledSource.instances[1]!, {
      agents: [agents[0]!, agents[2]!],
      capabilities: [disabledSource],
    }),
    { action: 'sync', kind: 'skill', name: 'shared', from: 'a', to: 'c' },
  );

  const scopedMcp = {
    kind: 'mcp-server',
    name: 'scoped-server',
    coverage: 'gap',
    coordinate: { ecosystem: 'npm', identifier: 'scoped-server', version: '2.0.0' },
    instances: [
      { agent: 'a', scope: 'project', availability: 'installed', management: 'read-only' },
      { agent: 'c', availability: 'missing', management: 'writable' },
    ],
  };
  assert.deepEqual(
    inventoryOperationPayload('sync', scopedMcp, scopedMcp.instances[1]!, {
      agents: [agents[0]!, agents[2]!],
      capabilities: [scopedMcp],
    }),
    {
      action: 'sync',
      kind: 'mcp-server',
      name: 'scoped-server',
      from: 'a',
      fromScope: 'project',
      to: 'c',
    },
  );
  assert.deepEqual(
    inventoryOperationPayload('update', scopedMcp, scopedMcp.instances[0]!, {
      agents: [agents[0]!, agents[2]!],
      capabilities: [scopedMcp],
    }),
    {
      action: 'update',
      kind: 'mcp-server',
      name: 'scoped-server',
      to: 'a',
      scope: 'project',
      coordinate: { version: '2.0.0' },
    },
  );
  const ambiguousSource = {
    ...scopedMcp,
    instances: [
      ...scopedMcp.instances,
      { agent: 'a', scope: 'user', availability: 'installed', management: 'writable' },
    ],
  };
  assert.equal(
    inventoryOperationPayload('sync', ambiguousSource, ambiguousSource.instances[1]!, {
      agents: [agents[0]!, agents[2]!],
      capabilities: [ambiguousSource],
    }),
    null,
  );
});

test('overview client renders one deterministic four-DTO capability map without inferring operations', () => {
  const html = renderPage();
  assert.match(html, /get\('\/api\/inventory'\)/);
  assert.match(html, /get\('\/api\/overview'\)/);
  assert.match(html, /get\('\/api\/feed\?refresh=1'\)/);
  assert.match(html, /get\('\/api\/conflicts'\)/);
  assert.match(html, /capability\.instances/);
  assert.match(html, /inventory\.agents\.forEach/);
  assert.match(html, /instance\.agent === agent\.id/);
  assert.match(html, /matches\.length \? matches/);
  assert.match(html, /scoped-state/);
  assert.match(html, /instance\.entryCount \? ' · ×'/);
  assert.match(html, /instance\.operations/);
  assert.match(html, /capability\.coverage/);
  assert.doesNotMatch(html, /management\s*===\s*['"]writable['"].*operations/s);
  assert.match(html, /Promise\.allSettled/);
});

test('drift and activity render truthful grouped read models and targeted rollback controls', () => {
  const html = renderPage();
  assert.match(html, /id="activity-panel"/);
  assert.match(html, /getElementById\('activity-panel'\)/);
  assert.doesNotMatch(html, /\[data-view=\\?"activity\\?"\] \.placeholder/);
  assert.match(html, /get\('\/api\/activity'\)/);
  assert.match(html, /renderDrift/);
  assert.match(html, /drift\.modified/);
  assert.match(html, /drift\.missing/);
  assert.match(html, /drift\.unverifiable/);
  assert.match(html, /drift\.unmanaged/);
  assert.match(html, /drift\.note/);
  assert.match(html, /renderActivity/);
  assert.match(html, /activity\.items/);
  assert.match(html, /node\('ul', 'activity-list'\)/);
  assert.match(html, /node\('li', 'activity-record'\)/);
  assert.match(html, /item\.rollbackEligible/);
  assert.match(html, /data-audit-id/);
  assert.match(html, /item\.name \+ '@' \+ item\.marketplace/);
  assert.match(html, /enumLabel\(kindLabels, item\.kind\)/);
  assert.match(html, /rollback\.auditId/);
  assert.match(html, /rollback\.recordedAt/);
  assert.match(html, /rollback\.confirm/);
  assert.match(html, /postJson\('\/api\/rollback', \{ auditId:item\.id \}\)/);
  assert.match(html, /rollback\.guard/);
  assert.match(html, /rollbackPending/);
  assert.match(html, /rollbackGeneration/);
  assert.match(html, /rollback\.select/);
  assert.match(html, /validRollback\(result\)/);
  assert.match(html, /await refresh\(\)/);
  assert.match(html, /rollback\.responseUnavailable/);
  assert.match(html, /result\.action === 'skipped'/);
  assert.doesNotMatch(html, /postJson\('\/api\/rollback', \{\}\)/);
});

test('global rollback control only navigates to Activity', () => {
  const html = renderPage();
  assert.match(html, /location\.hash = '#activity'/);
  assert.doesNotMatch(html, /Rollback latest change/);
});

test('overview preserves table semantics, visible modal focus, and malformed-response recovery', () => {
  const html = renderPage();
  assert.match(html, /node\('button', 'details-button', t\('action\.details'\)\)/);
  assert.doesNotMatch(html, /row\.setAttribute\('role', 'button'\)/);
  assert.match(html, /button:not\(\[disabled\]\):not\(\[hidden\]\)/);
  assert.match(html, /validInventory/);
  assert.match(html, /finally \{/);
  assert.match(html, /refreshButton\.disabled = false/);
});

test('overview exposes truthful summary, kind filters, attention, and state vocabulary', () => {
  const documentHtml = withoutNonRenderedContent(renderPage());
  for (const label of ['All', 'MCP', 'Skills', 'Rules', 'Plugins', 'Read-only']) {
    assert.match(documentHtml, new RegExp(`\\b${label}\\b`));
  }
  for (const label of [
    'Installed',
    'Missing',
    'Disabled',
    'Unavailable',
    'Unsupported',
    'Unverifiable',
    'All present',
    'Gap',
    'Agent only',
  ])
    assert.match(documentHtml, new RegExp(`\\b${label}\\b`));
  assert.match(documentHtml, /Capability instances/);
  assert.match(documentHtml, /Unique capability keys/);
  assert.match(documentHtml, /id="attention"/);
  assert.match(renderPage(), /attention\.withheld/);
  assert.match(renderPage(), /public\.withheld/);
  assert.match(renderPage(), /drift\.findings\.length \+ results\.overview\.drift\.withheldCount/);
});

test('renderPage exposes every dashboard view', () => {
  const html = renderPage();
  assert.match(html, /data-view="overview"/);
  assert.match(html, /data-view="inventory"/);
  assert.match(html, /data-view="discover"/);
  assert.match(html, /data-view="drift"/);
  assert.match(html, /data-view="activity"/);
});

test('renderPage uses the truthful all-present label and never claims unproven alignment', () => {
  const html = renderPage();
  const documentHtml = withoutNonRenderedContent(html);
  assert.match(documentHtml, /<[^>]*data-coverage-label="all-present"[^>]*>[\s\S]{0,200}\bAll present\b/i);
  assert.doesNotMatch(documentHtml, /\baligned\b/i);
});

test('renderPage exposes persistent Korean and English preferences without refetching', () => {
  const html = renderPage();
  assert.match(html, /id="theme"/);
  assert.match(html, /id="global-search"/);
  assert.match(html, /id="language"[^>]*>[\s\S]*value="en"[\s\S]*value="ko"/);
  assert.doesNotMatch(html, /id="language"[^>]*disabled/);
  assert.match(html, /fleet_language/);
  assert.match(html, /document\.documentElement\.lang = language/);
  assert.match(html, /function t\(key, vars\)/);
  assert.match(html, /languageSelect\.addEventListener\('change'/);
  assert.match(html, /live\.textContent = ''/);
  assert.match(html, /live\.setAttribute\('aria-live', 'polite'\)/);
  assert.match(html, /renderResults\(cachedResults\)/);
  assert.match(html, /cachedResults = results/);
});

test('dashboard localization and accessibility contracts cover dynamic resilient states', () => {
  const html = renderPage();
  assert.match(html, /data-i18n="nav\.overview"/);
  assert.match(html, /data-i18n-placeholder="search\.fleet"/);
  assert.match(html, /role="status" aria-live="polite"/);
  assert.match(html, /live\.setAttribute\('role', isError \? 'alert' : 'status'\)/);
  assert.match(html, /live\.setAttribute\('aria-live', isError \? 'assertive' : 'polite'\)/);
  assert.match(html, /@media \(prefers-reduced-motion:reduce\)/);
  assert.match(html, /transition-duration:0\.01ms/);
  assert.match(html, /unknownEnum/);
  assert.match(html, /theme\.toLight/);
  assert.match(html, /theme\.toDark/);
  assert.match(html, /agent\.unavailable/);
  assert.match(html, /rollback\.confirm/);
  assert.match(html, /discover\.showAll/);
});

test('renderPage uses semantic navigation and buttons with aria-label or visible text', () => {
  const html = renderPage();
  assert.match(html, /<nav(?:\s|>)/);
  assert.match(html, /<main(?:\s|>)/);
  const buttons = [...html.matchAll(/<button\b([^>]*)>([\s\S]*?)<\/button>/g)];
  assert.ok(buttons.length >= 5, 'dashboard must expose named navigation and action buttons');
  for (const match of buttons) {
    const attributes = match[1] ?? '';
    const content = match[2] ?? '';
    const ariaLabel = attributes.match(/\baria-label="([^"]+)"/)?.[1]?.trim();
    const text = withoutNonRenderedContent(content)
      .replace(/<[^>]+>/g, '')
      .trim();
    assert.ok(ariaLabel || text, `button has no accessible name: ${attributes}`);
  }
});

test('renderPage is one self-contained dashboard without a v1/v2 switch', () => {
  const html = renderPage();
  assert.equal(html.match(/<script\b/g)?.length, 1);
  assert.equal(html.match(/<style\b/g)?.length, 1);
  const client = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(client);
  assert.doesNotThrow(() => new Script(client));
  assert.doesNotMatch(html, /\?v=1|\?v=2|class="vsw"/);
  assert.doesNotMatch(html, /https:\/\/fonts\.|cdn\.|<script src=/);
});

test('renderPage contains no sketch-only mock labels', () => {
  const html = renderPage();
  assert.doesNotMatch(html, /12 sec ago|18 managed items|8\.8 \/ 10/);
});

test('shell bootstraps theme before body and contains dialog focus and refresh race guards', () => {
  const html = renderPage();
  const head = html.slice(0, html.indexOf('</head>'));
  assert.match(head, /fleet_theme/);
  assert.match(head, /document\.documentElement\.setAttribute\('data-theme'/);
  assert.match(html, /setAttribute\('inert', ''\)/);
  assert.match(html, /event\.key === 'Tab'/);
  assert.match(html, /generation === refreshGeneration/);
});

test('client consumes fixed public error codes and never reads a raw error field', () => {
  const html = renderPage();
  assert.match(html, /typeof data\.code === 'string'/);
  assert.doesNotMatch(html, /data\.error/);
});

test('inventory view has local search, counted kind chips, status filtering, and stable sorting', () => {
  const html = renderPage();
  assert.match(html, /globalSearch\.addEventListener\('input'/);
  assert.match(html, /renderInventory\(inventoryModel\)/);
  assert.match(html, /kindCounts/);
  assert.match(html, /inventory-status-filter/);
  assert.match(html, /inventory-result-count/);
  assert.match(html, /kindCompare[\s\S]*a\.name\.localeCompare/);
  assert.match(html, /empty\.inventorySearch/);
  assert.match(html, /empty\.inventory/);
  assert.match(html, /attention\.inventoryUnavailable/);
  assert.match(html, /data-i18n="loading\.inventory"/);
  assert.match(html, /data-inventory-kind/);
  assert.match(html, /replacement\.focus\(\)/);
  assert.match(html, /inventory-status-filter'\)\.focus\(\)/);
  assert.match(html, /inventory-sort'\)\.focus\(\)/);
});

test('inventory validation and detail rendering expose only public metadata and exact operations', () => {
  const html = renderPage();
  assert.match(html, /value\.schemaVersion === 2/);
  assert.match(html, /validWithheldCount/);
  assert.match(html, /typeof instance\.enabled === 'boolean'/);
  assert.match(html, /inventory\.withheldCount/);
  assert.match(html, /feed\.withheldCount/);
  assert.match(html, /conflicts\.withheldCount/);
  assert.match(html, /validCoordinate/);
  assert.match(html, /function publicKind/);
  assert.match(html, /\['mcp-server','skill','rule','plugin'\]\.indexOf\(change\.kind\)/);
  assert.match(html, /validCapabilityMetadata/);
  assert.match(html, /capability\.description/);
  assert.match(html, /capability\.tokensEst/);
  assert.match(html, /safeHttpUrl\(capability\.sourceUrl\)/);
  assert.match(html, /instance\.operations\.forEach/);
  assert.doesNotMatch(html, /capability\.(?:path|raw|spec)/);
});

test('every advertised operation uses shared preview then explicit single-use apply', () => {
  const html = renderPage();
  assert.match(html, /async function doPlan/);
  assert.match(html, /postJson\('\/api\/plan', body\)/);
  assert.match(html, /validPlan/);
  assert.match(html, /validApply/);
  assert.match(html, /preview\.summary/);
  assert.doesNotMatch(html, /node\('p', 'plan-summary', plan\.operationSummary\)/);
  assert.match(html, /enumLabel\(skillUpdateLabels, update\.state\)/);
  assert.match(html, /planPending/);
  assert.match(html, /applyPending/);
  assert.match(html, /plan\.changes\.length \? function\(\)\{ void applyStoredPlan\(plan\); \} : null/);
  assert.match(html, /postJson\('\/api\/apply', \{ planId:plan\.planId \}\)/);
  assert.match(html, /apply\.unavailable/);
  assert.match(html, /Do not retry yet/);
  assert.match(html, /manual-config-recovery/);
  assert.match(html, /vendor-state-inspection/);
  assert.match(html, /focusTarget && focusTarget\.isConnected \? focusTarget : document\.activeElement/);
  assert.match(html, /startingDialogGeneration !== dialogGeneration/);
  assert.match(html, /button\.plan-trigger/);
  assert.match(html, /setAttribute\('role', 'alert'\)/);
  assert.match(html, /doPlan\(operationLabel, payload, button\)/);
  assert.match(html, /doPlan\(t\('action\.update'\), \{ action:'update'/);
  assert.match(html, /if\(!force && \(applyPending \|\| rollbackPending\)\) return/);
  assert.match(html, /dialogCancel\.disabled = true/);
  assert.match(html, /if\(result\.outcome === 'outcome-unknown'\)/);
  assert.match(html, /await refresh\(\)/);
  assert.match(html, /activity\.trust/);
  assert.doesNotMatch(html, /'Trust: ' \+ item\.trustLevel/);
});
