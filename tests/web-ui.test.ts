import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Script, runInNewContext } from 'node:vm';
import type { AgentAdapter } from '../src/core/adapter.js';
import { apiFeed, apiInventory } from '../src/web/api.js';
import { renderPage } from '../src/web/ui.js';
import {
  DISCOVERY_RECOMMENDATION_VALIDATOR_BROWSER_SOURCE,
  DISCOVERY_VIEW_SECTIONS_BROWSER_SOURCE,
  INVENTORY_OPERATION_PAYLOAD_BROWSER_SOURCE,
  INVENTORY_VIEW_ITEMS_BROWSER_SOURCE,
  discoveryViewSections,
  inventoryOperationPayload,
  inventoryViewItems,
} from '../src/web/ui/client.js';
import {
  dashboardAdapters,
  dashboardFailingFeedSource,
  dashboardFeedSources,
} from './fixtures/web-dashboard.js';

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
      from: '1.0.0',
      to: '2.0.0',
      operation: 'update',
    },
  ]);
  assert.equal(feed.recommendations.find((item) => item.name === 'trusted-browser-tools')?.trust, 'no-flags');
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
  const base = { query: '', kind: 'all', trust: 'all' };
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

test('generated discovery helper executes closure-free and matches typed behavior', async () => {
  assert.doesNotMatch(DISCOVERY_VIEW_SECTIONS_BROWSER_SOURCE, /__name/);
  const browserView = runInNewContext(
    '(' + DISCOVERY_VIEW_SECTIONS_BROWSER_SOURCE + ')',
  ) as typeof discoveryViewSections;
  const feed = await apiFeed(dashboardAdapters, dashboardFeedSources, { fleetHome: '/fixture/fleet-home' });
  const filters = { query: 'browser', kind: 'mcp-server', trust: 'no-flags' };
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
  assert.equal(validate({ ...relatedBase, reasons: [`related to your setup (${'a'.repeat(122)})`] }), true);
  assert.equal(validate({ ...relatedBase, reasons: ['related to your setup (a)'] }), false);
  assert.equal(validate({ ...relatedBase, reasons: ['related to your setup (abcd  efgh)'] }), false);
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
  assert.match(html, /Trust: ' \+ item\.trust/);
  assert.match(html, /failure\.source/);
  assert.doesNotMatch(html, /failure\.(?:error|message|stack)/);
  assert.match(html, /const validDiscoveryRecommendation =/);
  assert.match(html, /data-discovery-filter/);
  assert.match(html, /data-discovery-toggle/);
  assert.match(html, /replacement\.focus\(\)/);
  assert.match(html, /item\.ecosystem === 'npm' \|\| item\.ecosystem === 'pypi'/);
  assert.match(html, /doPlan\('Install'/);
  assert.match(html, /to:'all'/);
  assert.match(html, /Local CLI guidance was not provided by this source/);
  assert.match(html, /Open marketplace source/);
  assert.match(html, /Marketplace or CLI guidance was not provided by this source/);
  assert.doesNotMatch(html, /Preview delegated install/);
  assert.match(html, /Discovery source' \+ \(sourceFailures/);
  assert.match(html, /search\.setAttribute\('aria-label', searchLabel\)/);
  assert.doesNotMatch(html, /fit score|fit percentage|recommendation grade/i);
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
  assert.match(html, /matches\.length === 1/);
  assert.match(html, /instance\.operations/);
  assert.match(html, /capability\.coverage/);
  assert.doesNotMatch(html, /management\s*===\s*['"]writable['"].*operations/s);
  assert.match(html, /Promise\.allSettled/);
});

test('drift and activity render truthful grouped read models and targeted rollback controls', () => {
  const html = renderPage();
  assert.match(html, /get\('\/api\/activity'\)/);
  assert.match(html, /renderDrift/);
  assert.match(html, /Modified/);
  assert.match(html, /Missing/);
  assert.match(html, /Unverifiable/);
  assert.match(html, /Unmanaged/);
  assert.match(html, /informational/i);
  assert.match(html, /lock metadata is best-effort/i);
  assert.match(html, /renderActivity/);
  assert.match(html, /activity\.items/);
  assert.match(html, /node\('ul', 'activity-list'\)/);
  assert.match(html, /node\('li', 'activity-record'\)/);
  assert.match(html, /item\.rollbackEligible/);
  assert.match(html, /data-audit-id/);
  assert.match(html, /Confirm rollback/);
  assert.match(html, /postJson\('\/api\/rollback', \{ auditId:item\.id \}\)/);
  assert.match(html, /divergence guard/i);
  assert.match(html, /rollbackPending/);
  assert.match(html, /rollbackGeneration/);
  assert.match(html, /recorded ' \+ timestampLabel/);
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
  assert.match(html, /node\('button', 'details-button', 'Details'\)/);
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

test('renderPage exposes theme and global search controls', () => {
  const html = renderPage();
  assert.match(html, /id="theme"/);
  assert.match(html, /id="global-search"/);
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
  assert.match(html, /No inventory items match/);
  assert.match(html, /No capabilities were reported/);
  assert.match(html, /Inventory unavailable/);
  assert.match(html, /id="inventory" class="placeholder">Loading capability inventory/);
  assert.match(html, /data-inventory-kind/);
  assert.match(html, /replacement\.focus\(\)/);
  assert.match(html, /inventory-status-filter'\)\.focus\(\)/);
  assert.match(html, /inventory-sort'\)\.focus\(\)/);
});

test('inventory validation and detail rendering expose only public metadata and exact operations', () => {
  const html = renderPage();
  assert.match(html, /validCoordinate/);
  assert.match(html, /validCapabilityMetadata/);
  assert.match(html, /capability\.description/);
  assert.match(html, /capability\.tokensEst/);
  assert.match(html, /safeHttpUrl\(capability\.sourceUrl\)/);
  assert.match(html, /instance\.operations\.forEach/);
  assert.doesNotMatch(html, /capability\.(?:path|raw|spec)/);
});

test('every inventory operation and MCP update uses the shared preview-only plan path', () => {
  const html = renderPage();
  assert.match(html, /async function doPlan/);
  assert.match(html, /postJson\('\/api\/plan', body\)/);
  assert.match(html, /validPlan/);
  assert.match(html, /planPending/);
  assert.match(html, /startingDialogGeneration !== dialogGeneration/);
  assert.match(html, /button\.plan-trigger/);
  assert.match(html, /setAttribute\('role', 'alert'\)/);
  assert.match(html, /doPlan\(operation\.charAt/);
  assert.match(html, /doPlan\('Update', \{ action:'update'/);
  assert.doesNotMatch(html, /postJson\('\/api\/apply'/);
});
