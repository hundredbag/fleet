import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiFeed, apiInventory } from '../src/web/api.js';
import { renderPage } from '../src/web/ui.js';
import { dashboardAdapters, dashboardFeedSources } from './fixtures/web-dashboard.js';

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
  assert.doesNotMatch(html, /\?v=1|\?v=2|class="vsw"/);
  assert.doesNotMatch(html, /https:\/\/fonts\.|cdn\.|<script src=/);
});

test('renderPage contains no sketch-only mock labels', () => {
  const html = renderPage();
  assert.doesNotMatch(html, /12 sec ago|18 managed items|8\.8 \/ 10/);
});
