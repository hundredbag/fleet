import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { request, type IncomingHttpHeaders, type Server } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFleetServer } from '../src/web/server.js';
import { apiActivity, apiFeed, apiOverview, invalidateInventoryCache } from '../src/web/api.js';
import { checkHost, checkOrigin, tokenMatches } from '../src/web/security.js';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import type { AgentAdapter, SkillWriter } from '../src/core/adapter.js';
import type { FeedSource } from '../src/feed/source.js';
import { applyChanges } from '../src/core/writer.js';
import { sha256 } from '../src/core/hash.js';
import { mapApply, mapPlan, mapRollback } from '../src/web/public-mappers.js';
import {
  dashboardAdapters,
  dashboardFailingFeedSource,
  dashboardFeedSources,
} from './fixtures/web-dashboard.js';

// POST helper with full header control (node fetch may strip forbidden headers like Origin).
function post(
  port: number,
  path: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; headers: IncomingHttpHeaders; json: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json: unknown;
        try {
          json = JSON.parse(data);
        } catch {
          json = data;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, json });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

const fakeAdapter: AgentAdapter = {
  id: 'claude-code',
  displayName: 'Claude Code',
  supportsWrite: false,
  async detect() {
    return { id: 'claude-code', displayName: 'Claude Code', present: true, configPaths: [] };
  },
  async readInventory() {
    return [
      {
        kind: 'mcp-server',
        name: 'gh',
        agent: 'claude-code',
        scope: 'user',
        enabled: true,
        spec: { transport: 'stdio', command: 'npx', args: ['-y', '@x/gh'] },
        source: { file: 'f' },
      },
      {
        kind: 'rule',
        name: 'style',
        agent: 'claude-code',
        scope: 'user',
        enabled: true,
        body: 'be terse',
        source: { file: 'g' },
      },
    ];
  },
};

const fakeSources: FeedSource[] = [
  {
    id: 'fake',
    list: async () => [
      { name: 'cool', source: 'fake', identifier: '@x/cool', ecosystem: 'npm', popularity: 1000 },
    ],
  },
];

async function startTest(
  token: string,
  adapters: AgentAdapter[] = [fakeAdapter],
  sources: FeedSource[] = fakeSources,
): Promise<{ server: Server; port: number }> {
  const root = mkdtempSync(join(tmpdir(), 'fleet-web-test-'));
  let server: Server | undefined;
  try {
    ({ server } = createFleetServer(adapters, {
      token,
      sources,
      fleetHome: join(root, 'fleet-home'),
    }));
    server.once('close', () => rmSync(root, { recursive: true, force: true }));
    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', () => {
        server!.off('error', reject);
        resolve();
      });
    });
    const port = (server.address() as AddressInfo).port;
    return { server, port };
  } catch (error) {
    if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
const close = (s: Server) => new Promise<void>((r) => s.close(() => r()));

function httpGet(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; headers: IncomingHttpHeaders; json: any }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, path, method: 'GET', headers }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json: unknown;
        try {
          json = JSON.parse(data);
        } catch {
          json = data;
        }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function assertPublicResponse(body: unknown, label: string): void {
  const forbidden = new Set(['file', 'backup', 'wrotehash', 'contenthash', 'raw', 'env', 'headers', 'stack']);

  function visit(value: unknown, path: string): void {
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, `${path}[${index}]`));
      return;
    }
    if (typeof value === 'string') {
      assert.doesNotMatch(value, /(?:^|\n)\s*at\s+(?:async\s+)?(?:\S+\s+\()?[^)\n]+:\d+:\d+\)?(?:\n|$)/);
      assert.doesNotMatch(
        value,
        /(?:^|\n)[^\s@]+@(?:file:\/\/|https?:\/\/|\/|[A-Za-z]:\\)[^\n]+:\d+:\d+(?:\n|$)/,
      );
      assert.doesNotMatch(value, /DASHBOARD_FIXTURE_CAUGHT_ERROR_DETAIL/);
      return;
    }
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      assert.equal(
        forbidden.has(key.toLowerCase()),
        false,
        `${label} exposed forbidden field ${path}.${key}`,
      );
      visit(child, `${path}.${key}`);
    }
  }

  visit(body, '$');
}

test('public response matcher rejects nested stack strings and stack keys', () => {
  assert.throws(() => assertPublicResponse({ detail: 'boom\n    at private-path.ts:1:1' }, 'fixture'));
  assert.throws(() => assertPublicResponse({ detail: 'fn@file:///private-path.ts:1:1' }, 'fixture'));
  assert.throws(() => assertPublicResponse({ stack: 'opaque' }, 'fixture'));
  assert.doesNotThrow(() => assertPublicResponse({ description: 'Error: handling utilities' }, 'fixture'));
});

test('feed mapper never advertises unsupported skill update actions', async () => {
  const { mapFeed } = await import('../src/web/public-mappers.js');
  const feed = mapFeed({
    updates: [
      {
        name: 'safe-update',
        agent: 'codex',
        scope: 'project',
        installed: '1.0.0-OPAQUE9Z8Y7X6W5V4',
        available: '2.0.0',
        operation: null,
      },
    ],
    skillUpdates: [{ name: 's', agent: 'a', state: 'update' }],
    recommendations: [
      {
        kind: 'skill',
        name: 'unsafe-source',
        source: '/home/alice/private-registry',
        reasons: [],
        trust: 'unknown',
        operation: null,
      },
    ],
    failures: [],
    fromCache: false,
  });
  assert.equal(feed.skillUpdates[0]!.operation, null);
  assert.equal(feed.updates[0]!.scope, 'project');
  assert.equal(feed.updates[0]!.operation, null);
  assert.equal('from' in feed.updates[0]!, false);
  assert.equal(JSON.stringify(feed).includes('OPAQUE9Z8Y7X6W5V4'), false);
  assert.equal(feed.recommendations.length, 0);
  assert.equal(feed.withheldCount, 1);
});

test('web feed loads feedSources from the requested Fleet home', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-web-feed-config-'));
  try {
    const fleetHome = join(dir, 'fleet-home');
    mkdirSync(fleetHome, { recursive: true });
    writeFileSync(join(fleetHome, 'config.json'), JSON.stringify({ feedSources: [] }));
    invalidateInventoryCache();
    const feed = await apiFeed([fakeAdapter], undefined, { fleetHome, refresh: true });
    assert.deepEqual(feed.updates, []);
    assert.deepEqual(feed.recommendations, []);
    assert.deepEqual(feed.failures, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('activity merges newest 20, marks rolled-back core IDs, and reports delegated completeness', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-activity-'));
  try {
    const opaqueId = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
    const core = Array.from({ length: 12 }, (_, i) => ({
      id: opaqueId(i),
      ts: i * 2 + 1,
      op: 'install',
      agent: 'codex',
      name: `core-${i}`,
      file: '/redacted',
      backup: '/redacted',
      existedBefore: false,
    }));
    core[0]!.id = `1700000000000-123-${opaqueId(0)}`; // legacy writer format
    core.push({
      id: opaqueId(50),
      ts: 25,
      op: 'rollback',
      agent: 'codex',
      name: 'core-5',
      file: '/redacted',
      backup: '/redacted',
      existedBefore: false,
      rolledBackFrom: opaqueId(5),
    } as (typeof core)[number]);
    writeFileSync(join(root, 'audit.jsonl'), core.map((x) => JSON.stringify(x)).join('\n') + '\n');
    const coreOnly = await apiActivity(root);
    assert.equal(coreOnly.coreActions.status, 'available');
    assert.equal(coreOnly.coreActions.withheldCount, 0);
    assert.equal(coreOnly.delegatedActions.status, 'not-present');
    assert.equal(
      coreOnly.items.filter((x) => x.rollbackEligible).length,
      1,
      'shared native state only exposes its newest active change',
    );
    assert.equal(coreOnly.items.find((x) => x.rollbackEligible)?.source, 'core-audit');
    assert.equal(coreOnly.items.find((x) => x.rollbackEligible)?.kind, 'mcp-server');
    assert.equal(coreOnly.items.find((x) => x.name === 'core-0')?.id, opaqueId(0));
    assert.equal(coreOnly.items.find((x) => x.name === 'core-0')?.rollbackEligible, false);
    assert.doesNotMatch(JSON.stringify(coreOnly), /1700000000000-123/);

    const groupedId = opaqueId(60);
    writeFileSync(
      join(root, 'audit.jsonl'),
      [
        ...core,
        {
          id: groupedId,
          ts: 27,
          op: 'install',
          agent: 'codex',
          name: 'group/server',
          kind: 'mcp-server',
          file: '/redacted-grouped',
          backup: '/redacted-grouped',
          existedBefore: false,
        },
      ]
        .map((x) => JSON.stringify(x))
        .join('\n') + '\n',
    );
    const grouped = await apiActivity(root);
    assert.equal(grouped.items.find((item) => item.id === groupedId)?.name, 'group/server');

    const delegated = Array.from({ length: 12 }, (_, i) => ({
      id: opaqueId(100 + i),
      time: new Date(i * 2 + 2).toISOString(),
      op: 'install',
      agent: 'codex',
      selector: `plugin-${i}@market`,
      exitCode: i === 11 ? 1 : 0,
    }));
    writeFileSync(join(root, 'delegated.jsonl'), delegated.map((x) => JSON.stringify(x)).join('\n') + '\n');
    const result = await apiActivity(root);
    assert.equal(result.delegatedActions.status, 'available');
    assert.equal(result.items.length, 20);
    assert.deepEqual(
      result.items.map((x) => x.ts),
      [...result.items.map((x) => x.ts)].sort((a, b) => b - a),
    );
    const rolled = result.items.find((x) => x.id === opaqueId(5));
    assert.equal(rolled?.rolledBack, true);
    assert.equal(rolled?.rollbackEligible, false);
    assert.equal(result.items.filter((x) => x.rollbackEligible).length, 2);
    assert.ok(result.items.filter((x) => x.rollbackEligible).every((item) => item.source === 'core-audit'));

    writeFileSync(join(root, 'delegated.jsonl'), '{malformed\n');
    assert.equal((await apiActivity(root)).delegatedActions.status, 'malformed');

    writeFileSync(
      join(root, 'delegated.jsonl'),
      [
        { ...delegated[0], id: '/private/DASHBOARD_FIXTURE_CAUGHT_ERROR_DETAIL' },
        { ...delegated[1], agent: 'DASHBOARD_FIXTURE_CAUGHT_ERROR_DETAIL' },
        { ...delegated[2], exitCode: 'stderr: private output' },
        { ...delegated[3], selector: 'plugin@../../DASHBOARD_FIXTURE_CAUGHT_ERROR_DETAIL' },
      ]
        .map((x) => JSON.stringify(x))
        .join('\n') + '\n',
    );
    const rejectedDelegated = await apiActivity(root);
    assert.equal(rejectedDelegated.delegatedActions.status, 'malformed');
    assert.doesNotMatch(
      JSON.stringify(rejectedDelegated),
      /DASHBOARD_FIXTURE_CAUGHT_ERROR_DETAIL|private output/,
    );

    writeFileSync(
      join(root, 'audit.jsonl'),
      JSON.stringify({
        ...core[0],
        id: '/private/DASHBOARD_FIXTURE_CAUGHT_ERROR_DETAIL',
      }) + '\n',
    );
    const rejectedCore = await apiActivity(root);
    assert.doesNotMatch(JSON.stringify(rejectedCore), /DASHBOARD_FIXTURE_CAUGHT_ERROR_DETAIL/);
    assert.equal(rejectedCore.coreActions.status, 'malformed');
    assert.equal(rejectedCore.coreActions.withheldCount, 0);

    writeFileSync(
      join(root, 'audit.jsonl'),
      core.map((entry) => JSON.stringify(entry)).join('\n') + '\n{}\n',
    );
    const malformedCore = await apiActivity(root);
    assert.equal(malformedCore.coreActions.status, 'malformed');
    assert.equal(
      malformedCore.items.some((item) => item.rollbackEligible),
      false,
    );

    rmSync(join(root, 'delegated.jsonl'));
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(root, 'delegated.jsonl'));
    assert.equal((await apiActivity(root)).delegatedActions.status, 'unavailable');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('activity accepts audit records emitted by the real core writer', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-activity-real-'));
  try {
    const file = join(root, 'agent-config.json');
    const applied = await applyChanges(
      [
        {
          agent: 'codex',
          op: 'install',
          name: 'real-writer-entry',
          kind: 'mcp-server',
          scope: 'user',
          file,
          newContent: '{}',
          trust: { level: 'caution', reasonCodes: ['PACKAGE_UNPINNED'] },
        },
      ],
      () => {},
      { fleetHome: root },
    );
    const result = await apiActivity(root);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]?.id, applied[0]?.auditId);
    assert.equal(result.items[0]?.kind, 'mcp-server');
    assert.equal(result.items[0]?.rollbackEligible, true);
    assert.equal(result.items[0]?.trustLevel, 'caution');
    assert.deepEqual(result.items[0]?.trustReasonCodes, ['PACKAGE_UNPINNED']);
    assert.match(result.items[0]?.id ?? '', /^[0-9a-f-]{36}$/i);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('activity distinguishes verified plugin changes, no-ops, failures, and unverifiable outcomes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-activity-effects-'));
  try {
    const base = {
      time: '2026-08-19T00:00:00.000Z',
      op: 'install',
      agent: 'codex',
      argv: ['codex', 'plugin', 'add', 'fixture'],
      exitCode: 0,
      preState: 'absent',
    };
    const records = [
      {
        ...base,
        id: '00000000-0000-4000-8000-000000000001',
        selector: 'changed-plugin@official',
        effect: 'changed',
      },
      {
        ...base,
        id: '00000000-0000-4000-8000-000000000002',
        selector: 'noop-plugin',
        effect: 'unchanged',
      },
      {
        ...base,
        id: '00000000-0000-4000-8000-000000000003',
        selector: 'unknown-plugin',
        effect: 'unverifiable',
      },
      {
        ...base,
        id: '00000000-0000-4000-8000-000000000004',
        selector: 'failed-plugin',
        exitCode: 1,
        effect: 'unverifiable',
      },
    ];
    writeFileSync(
      join(root, 'delegated.jsonl'),
      records.map((record) => JSON.stringify(record)).join('\n') + '\n',
    );
    const activity = await apiActivity(root);
    const outcome = (name: string) => activity.items.find((item) => item.name === name)?.outcome;
    assert.equal(outcome('changed-plugin'), 'applied');
    assert.equal(activity.items.find((item) => item.name === 'changed-plugin')?.marketplace, 'official');
    assert.equal(activity.items.find((item) => item.name === 'changed-plugin')?.kind, 'plugin');
    assert.equal(outcome('noop-plugin'), 'nothing-to-do');
    assert.equal(outcome('unknown-plugin'), 'unknown');
    assert.equal(outcome('failed-plugin'), 'failed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('security: host / origin / token checks (unit)', () => {
  assert.equal(checkHost('127.0.0.1:7777', 7777), true);
  assert.equal(checkHost('localhost:7777', 7777), true);
  assert.equal(checkHost('evil.com:7777', 7777), false); // anti DNS-rebinding
  assert.equal(checkHost('127.0.0.1:80', 7777), false);
  assert.equal(checkOrigin(undefined, 7777), true); // top-level navigation
  assert.equal(checkOrigin('http://127.0.0.1:7777', 7777), true);
  assert.equal(checkOrigin('http://evil.com', 7777), false);
  // allow-host (e.g. Tailscale MagicDNS): exact match only
  assert.equal(checkHost('fleet.tail.ts.net', 7777, ['fleet.tail.ts.net']), true);
  assert.equal(checkHost('fleet.tail.ts.net', 7777, []), false);
  assert.equal(checkHost('evil.com', 7777, ['fleet.tail.ts.net']), false);
  assert.equal(checkOrigin('https://fleet.tail.ts.net', 7777, ['fleet.tail.ts.net']), true);
  assert.equal(checkOrigin('https://evil.com', 7777, ['fleet.tail.ts.net']), false);
  // case- and trailing-dot-insensitive (fails open only to the SAME name, never a bypass)
  assert.equal(checkHost('Fleet.Tail.TS.NET', 7777, ['fleet.tail.ts.net']), true);
  assert.equal(checkHost('fleet.tail.ts.net.', 7777, ['fleet.tail.ts.net']), true);
  assert.equal(tokenMatches('a', 'a'), true);
  assert.equal(tokenMatches('a', 'b'), false);
  assert.equal(tokenMatches(undefined, 'a'), false);
});

test('web: API requires the session token', async () => {
  const { server, port } = await startTest('secret');
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/inventory`)).status, 401);
    const r = await fetch(`http://127.0.0.1:${port}/api/inventory`, {
      headers: { authorization: 'Bearer secret' },
    });
    assert.equal(r.status, 200);
    const inv = (await r.json()) as { capabilities: { name: string }[] };
    assert.ok(inv.capabilities.some((capability) => capability.name === 'gh'));
  } finally {
    await close(server);
  }
});

test('web: authenticated overview is available and unauthenticated overview remains denied', async () => {
  const { server, port } = await startTest('dashboard-token', dashboardAdapters, dashboardFeedSources);
  try {
    const unauthenticated = await fetch(`http://127.0.0.1:${port}/api/overview`);
    assert.equal(unauthenticated.status, 401);

    const authenticated = await fetch(`http://127.0.0.1:${port}/api/overview`, {
      headers: { authorization: 'Bearer dashboard-token' },
    });
    assert.equal(authenticated.status, 200);
  } finally {
    await close(server);
  }
});

test('web overview does not count a normally absent agent as unavailable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-web-absent-overview-'));
  const absent: AgentAdapter = {
    id: 'absent-agent',
    displayName: 'Absent agent',
    async detect() {
      return {
        id: this.id,
        displayName: this.displayName,
        present: false,
        configPaths: [],
        runtimeStatus: 'not-found',
        configurationStatus: 'not-configured',
      };
    },
    async readInventory() {
      return [];
    },
  };
  try {
    invalidateInventoryCache();
    const overview = await apiOverview([absent], dir);
    assert.equal(overview.presentAgents, 0);
    assert.equal(overview.unavailableAgents, 0);
    assert.equal(overview.agents[0]?.setupStatus, 'not-detected');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('web: authenticated activity is available and unauthenticated activity remains denied', async () => {
  const { server, port } = await startTest('dashboard-token', dashboardAdapters, dashboardFeedSources);
  try {
    const unauthenticated = await fetch(`http://127.0.0.1:${port}/api/activity`);
    assert.equal(unauthenticated.status, 401);

    const authenticated = await fetch(`http://127.0.0.1:${port}/api/activity`, {
      headers: { authorization: 'Bearer dashboard-token' },
    });
    assert.equal(authenticated.status, 200);
  } finally {
    await close(server);
  }
});

test('web: public API responses omit private fields, stacks, and caught-error details', async () => {
  const sources = [...dashboardFeedSources, dashboardFailingFeedSource];
  const { server, port } = await startTest('dashboard-token', dashboardAdapters, sources);
  const headers = { authorization: 'Bearer dashboard-token' };
  try {
    for (const path of ['/api/inventory', '/api/feed', '/api/conflicts', '/api/overview', '/api/activity']) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, { headers });
      assert.equal(response.status, 200, `${path} must return a successful public response`);
      assert.match(
        response.headers.get('content-type') ?? '',
        /application\/json/,
        `${path} must return JSON`,
      );
      assertPublicResponse(await response.json(), path);
    }
  } finally {
    await close(server);
  }
});

test('web: failed GET, POST, and rollback are fixed JSON DTOs with recursive redaction', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-web-errors-'));
  const home = join(root, 'home');
  const { mkdirSync } = await import('node:fs');
  mkdirSync(join(home, 'audit.jsonl'), { recursive: true });
  const { server } = createFleetServer(dashboardAdapters, { token: 't', fleetHome: home });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const h = {
    origin: `http://127.0.0.1:${port}`,
    'content-type': 'application/json',
    authorization: 'Bearer t',
  };
  try {
    const incompleteGet = await httpGet(port, '/api/activity', { authorization: 'Bearer t' });
    assert.equal(incompleteGet.status, 200);
    assert.equal(incompleteGet.json.coreActions.status, 'unavailable');
    assert.match(String(incompleteGet.headers['content-type'] ?? ''), /application\/json/);
    assertPublicResponse(incompleteGet.json, 'incomplete GET');

    const failedPost = await post(
      port,
      '/api/plan',
      h,
      JSON.stringify({ name: 'x', action: 'remove', kind: 'permission', from: ['codex'] }),
    );
    assert.equal(failedPost.status, 400);
    assert.match(String(failedPost.headers['content-type'] ?? ''), /application\/json/);
    assertPublicResponse(failedPost.json, 'failed POST');

    const failedRollback = await post(port, '/api/rollback', h, '{}');
    assert.equal(failedRollback.status, 400);
    assert.match(String(failedRollback.headers['content-type'] ?? ''), /application\/json/);
    assertPublicResponse(failedRollback.json, 'failed rollback');
  } finally {
    await close(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test('web: serves the dashboard HTML at / (with token)', async () => {
  const { server, port } = await startTest('t');
  try {
    const r = await fetch(`http://127.0.0.1:${port}/?token=t`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await r.text(), /fleet/);
  } finally {
    await close(server);
  }
});

test('web: HTML and JSON responses forbid caching and carry the dashboard CSP', async () => {
  const { server, port } = await startTest('headers-token');
  try {
    const html = await fetch(`http://127.0.0.1:${port}/?token=headers-token`);
    assert.equal(html.status, 200);
    assert.equal(html.headers.get('cache-control'), 'no-store');
    assert.equal(
      html.headers.get('content-security-policy'),
      "default-src 'none'; connect-src 'self'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
    );

    const json = await fetch(`http://127.0.0.1:${port}/api/inventory`, {
      headers: { authorization: 'Bearer headers-token' },
    });
    assert.equal(json.status, 200);
    assert.equal(json.headers.get('cache-control'), 'no-store');
    assert.equal(json.headers.get('x-content-type-options'), 'nosniff');
  } finally {
    await close(server);
  }
});

test('web: final JSON boundary recursively scrubs capability free text', async () => {
  const leakingAdapter: AgentAdapter = {
    id: 'third-party',
    displayName: '/home/alice/OPAQUE_WEB_DISPLAY',
    supportsWrite: false,
    async detect() {
      return {
        id: '/home/alice/OPAQUE_WEB_DETECT_ID',
        displayName: '/home/alice/OPAQUE_WEB_DETECT_DISPLAY',
        present: true,
        configPaths: [],
      };
    },
    async readInventory() {
      return [
        {
          kind: 'skill' as const,
          name: 'review',
          agent: 'third-party',
          scope: 'user' as const,
          enabled: true,
          path: '/private/skill',
          source: { file: '/private/source' },
          meta: { description: 'OPAQUE_WEB_SKILL_DESCRIPTION' },
        },
        {
          kind: 'plugin' as const,
          name: 'review-plugin',
          agent: 'third-party',
          scope: 'user' as const,
          enabled: true,
          description: 'OPAQUE_WEB_PLUGIN_DESCRIPTION',
          source: { file: '/private/plugin' },
        },
        {
          kind: 'subagent' as const,
          name: 'review-subagent',
          agent: 'third-party',
          scope: 'user' as const,
          enabled: true,
          path: '/private/subagent',
          description: 'OPAQUE_WEB_SUBAGENT_DESCRIPTION',
          source: { file: '/private/subagent' },
        },
        {
          kind: 'mcp-server' as const,
          name: 'internal-server',
          agent: 'third-party',
          scope: 'user' as const,
          enabled: true,
          spec: {
            transport: 'stdio' as const,
            command: 'npx',
            args: ['-y', '@private/opaquevelvetquasar@1.0.0'],
          },
          source: { file: '/private/mcp' },
        },
        {
          kind: 'permission' as const,
          name: 'Bash(--credential OPAQUE_WEB_PERMISSION --path /home/alice/private)',
          agent: 'third-party',
          scope: 'user' as const,
          enabled: true,
          effect: 'allow',
          source: { file: '/private/settings.json' },
        },
      ];
    },
  };
  const { server, port } = await startTest('t', [leakingAdapter]);
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/inventory`, {
      headers: { authorization: 'Bearer t' },
    });
    const text = await response.text();
    assert.equal(response.status, 200);
    for (const marker of [
      'OPAQUE_WEB_SKILL_DESCRIPTION',
      'OPAQUE_WEB_PLUGIN_DESCRIPTION',
      'OPAQUE_WEB_SUBAGENT_DESCRIPTION',
      'OPAQUE_WEB_DISPLAY',
      'OPAQUE_WEB_DETECT_ID',
      'OPAQUE_WEB_DETECT_DISPLAY',
      '@private/opaquevelvetquasar',
    ]) {
      assert.equal(text.includes(marker), false, `web inventory leaked: ${marker}`);
    }
    assert.equal(text.includes('/private/source'), false);
    assert.equal(text.includes('/private/skill'), false);
    assert.equal(text.includes('OPAQUE_WEB_PERMISSION'), false);
    assert.equal(text.includes('/home/alice/private'), false);
    const body = JSON.parse(text);
    const permissions = body.capabilities.find((item: any) => item.kind === 'permission');
    assert.equal(permissions.name, 'Allow permission rules');
    assert.equal(permissions.entryCount, 1);
  } finally {
    await close(server);
  }
});

test('web overview withholds poisoned lock identities instead of echoing local paths', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-web-drift-public-'));
  try {
    writeFileSync(
      join(dir, 'fleet.lock'),
      JSON.stringify({
        version: 1,
        entries: {
          poisoned: {
            kind: 'skill',
            name: '/home/alice/OPAQUE_WEB_DRIFT',
            agent: 'codex',
            scope: 'user',
            origin: { type: 'manual' },
            installedAt: '2026-08-19T00:00:00.000Z',
            op: 'install',
          },
        },
      }),
    );
    const adapter: AgentAdapter = {
      id: 'codex',
      displayName: 'Codex',
      async detect() {
        return { id: 'codex', displayName: 'Codex', present: true, configPaths: [] };
      },
      async readInventory() {
        return [];
      },
    };
    const overview = await apiOverview([adapter], dir);
    assert.equal(JSON.stringify(overview).includes('OPAQUE_WEB_DRIFT'), false);
    assert.equal(overview.drift.checked, 1);
    assert.equal(overview.drift.withheldCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('web: dashboard HTML never interpolates the raw session token', async () => {
  const token = 'raw-token-must-not-appear-in-html';
  const { server, port } = await startTest(token);
  try {
    const r = await fetch(`http://127.0.0.1:${port}/?token=${token}`);
    assert.equal(r.status, 200);
    assert.doesNotMatch(await r.text(), new RegExp(token));
  } finally {
    await close(server);
  }
});

test('web: /api/feed uses injected sources and recommends not-installed', async () => {
  const { server, port } = await startTest('t');
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/feed`, { headers: { authorization: 'Bearer t' } });
    const feed = (await r.json()) as { recommendations: { identifier?: string }[]; failures: unknown[] };
    assert.ok(feed.recommendations.some((x) => x.identifier === '@x/cool'));
    assert.ok(Array.isArray(feed.failures));
  } finally {
    await close(server);
  }
});

test('web: unknown path 404s', async () => {
  const { server, port } = await startTest('t');
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/nope?token=t`)).status, 404);
  } finally {
    await close(server);
  }
});

test('web: allow-host lets a Tailscale host through, still token-gated + anti-rebinding', async () => {
  const root = mkdtempSync(join(tmpdir(), 'fleet-web-host-'));
  const { server } = createFleetServer([fakeAdapter], {
    token: 't',
    sources: fakeSources,
    allowHosts: ['fleet.tail.ts.net'],
    fleetHome: join(root, 'fleet-home'),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    // allowed Host + token → 200
    let r = await httpGet(port, '/api/inventory', { host: 'fleet.tail.ts.net', authorization: 'Bearer t' });
    assert.equal(r.status, 200);
    // allowed Host but no token → 401 (token is still the gate)
    r = await httpGet(port, '/api/inventory', { host: 'fleet.tail.ts.net' });
    assert.equal(r.status, 401);
    // a non-allowed Host → 403 (anti DNS-rebinding pin holds)
    r = await httpGet(port, '/api/inventory', { host: 'evil.example.com', authorization: 'Bearer t' });
    assert.equal(r.status, 403);
  } finally {
    await close(server);
    rmSync(root, { recursive: true, force: true });
  }
});

test('web: POST is CSRF-hardened (Origin required, JSON only, header token only)', async () => {
  const { server, port } = await startTest('t');
  const origin = `http://127.0.0.1:${port}`;
  try {
    // no Origin → 403
    let r = await post(
      port,
      '/api/plan',
      { 'content-type': 'application/json', authorization: 'Bearer t' },
      '{}',
    );
    assert.equal(r.status, 403);
    // non-JSON content-type → 415
    r = await post(
      port,
      '/api/plan',
      { origin, 'content-type': 'text/plain', authorization: 'Bearer t' },
      '{}',
    );
    assert.equal(r.status, 415);
    // token not in the header (query only) → 401
    r = await post(port, '/api/plan?token=t', { origin, 'content-type': 'application/json' }, '{}');
    assert.equal(r.status, 401);
  } finally {
    await close(server);
  }
});

test('web: rejects mutation bodies larger than 64 KiB with 413', async () => {
  const { server, port } = await startTest('t');
  try {
    const r = await post(
      port,
      '/api/plan',
      {
        origin: `http://127.0.0.1:${port}`,
        'content-type': 'application/json',
        authorization: 'Bearer t',
      },
      JSON.stringify({ padding: 'x'.repeat(64 * 1024) }),
    );
    assert.equal(r.status, 413);
    assert.equal(r.json.code, 'PAYLOAD_TOO_LARGE');
    assert.equal(r.headers['cache-control'], 'no-store');
  } finally {
    await close(server);
  }
});

test('web: malformed and unknown paths fail closed', async () => {
  const { server, port } = await startTest('t');
  const headers = { authorization: 'Bearer t' };
  const postHeaders = {
    ...headers,
    origin: `http://127.0.0.1:${port}`,
    'content-type': 'application/json',
  };
  try {
    assert.equal((await httpGet(port, '/%zz', headers)).status, 404);
    assert.equal((await httpGet(port, '/api/%69nventory', headers)).status, 404);
    assert.equal((await post(port, '/api/unknown', postHeaders, '{}')).status, 404);
    assert.equal((await httpGet(port, '/api/unknown', { ...headers, host: 'evil.example' })).status, 403);
    assert.equal(
      (await post(port, '/api/plan', { ...postHeaders, origin: 'http://evil.example' }, '{}')).status,
      403,
    );
  } finally {
    await close(server);
  }
});

test('web: plan → apply installs to a real agent config; planId is single-use', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-web-'));
  const claudeJson = join(dir, '.claude.json');
  writeFileSync(claudeJson, '{}');
  const adapter = new ClaudeCodeAdapter(
    claudeJson,
    join(dir, 'sk'),
    join(dir, 'CLAUDE.md'),
    join(dir, 'settings.json'),
    join(dir, 'plugins'),
  );
  const { server } = createFleetServer([adapter], { token: 't', fleetHome: join(dir, 'home') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const h = {
    origin: `http://127.0.0.1:${port}`,
    'content-type': 'application/json',
    authorization: 'Bearer t',
  };
  try {
    const planned = await post(
      port,
      '/api/plan',
      h,
      JSON.stringify({
        action: 'install',
        name: 'demo',
        to: ['claude-code'],
        coordinate: { ecosystem: 'npm', identifier: '@x/demo' },
      }),
    );
    assert.equal(planned.status, 200);
    assert.match(String(planned.headers['content-type'] ?? ''), /application\/json/);
    assert.ok(planned.json.planId);
    assert.equal(planned.json.changes.length, 1);
    // not yet written (dry-run preview only)
    assert.doesNotMatch(readFileSync(claudeJson, 'utf8'), /@x\/demo/);

    const applied = await post(port, '/api/apply', h, JSON.stringify({ planId: planned.json.planId }));
    assert.equal(applied.status, 200);
    assert.match(String(applied.headers['content-type'] ?? ''), /application\/json/);
    assert.equal(applied.json.applied, 1);
    assert.match(readFileSync(claudeJson, 'utf8'), /@x\/demo/);

    // same planId can't be replayed
    const replay = await post(port, '/api/apply', h, JSON.stringify({ planId: planned.json.planId }));
    assert.equal(replay.status, 400);

    assert.equal(planned.json.operationSummary, 'install mcp-server (1 change)');
    assertPublicResponse(planned.json, '/api/plan');
    assertPublicResponse(applied.json, '/api/apply');
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('web: project/local MCP instances are read-only until a scope-specific writer exists', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-web-scope-'));
  const project = join(dir, 'project');
  const claudeJson = join(dir, '.claude.json');
  mkdirSync(project);
  writeFileSync(
    claudeJson,
    JSON.stringify({
      projects: {
        [project]: {
          mcpServers: {
            proj: { command: 'npx', args: ['safe-package@1.0.0'] },
          },
        },
      },
    }),
  );
  const adapter = new ClaudeCodeAdapter(
    claudeJson,
    join(dir, 'skills'),
    join(dir, 'CLAUDE.md'),
    join(dir, 'settings.json'),
    join(dir, 'plugins'),
  );
  const adapters = [adapter];
  try {
    invalidateInventoryCache();
    const inventory = await (await import('../src/web/api.js')).apiInventory(adapters);
    const capability = inventory.capabilities.find((item) => item.name === 'proj')!;
    const instance = capability.instances.find((item) => item.agent === 'claude-code')!;
    assert.equal(instance.scope, 'local');
    assert.equal(instance.management, 'read-only');
    assert.deepEqual(instance.operations, []);

    const { ActionService } = await import('../src/web/actions.js');
    const service = new ActionService(adapters, join(dir, 'fleet-home'));
    await assert.rejects(
      service.plan({
        action: 'update',
        kind: 'mcp-server',
        name: 'proj',
        to: 'claude-code',
        coordinate: { version: '2.0.0' },
      }),
      /operation is not supported/,
    );
    const feed = await apiFeed(
      adapters,
      [
        {
          id: 'registry',
          async list() {
            return [
              {
                name: 'safe-package',
                source: 'registry',
                identifier: 'safe-package',
                ecosystem: 'npm' as const,
                version: '2.0.0',
              },
            ];
          },
        },
      ],
      { fleetHome: join(dir, 'fleet-home') },
    );
    assert.deepEqual(feed.updates, [
      {
        kind: 'mcp-server',
        name: 'proj',
        agent: 'claude-code',
        scope: 'local',
        to: '2.0.0',
        operation: null,
      },
    ]);
    const stored = JSON.parse(readFileSync(claudeJson, 'utf8'));
    assert.equal(stored.mcpServers, undefined);
    assert.equal(stored.projects[project].mcpServers.proj.args[0], 'safe-package@1.0.0');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('web actions preserve scoped source identity instead of selecting by inventory order', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-web-scope-select-'));
  const project = join(dir, 'project');
  const claudeJson = join(dir, '.claude.json');
  const codexToml = join(dir, 'config.toml');
  mkdirSync(project);
  writeFileSync(
    claudeJson,
    JSON.stringify({
      mcpServers: { shared: { command: 'npx', args: ['safe-user@1.0.0'] } },
      projects: {
        [project]: { mcpServers: { shared: { command: 'npx', args: ['safe-local@1.0.0'] } } },
      },
    }),
  );
  writeFileSync(codexToml, '# codex\n');
  const adapters = [
    new ClaudeCodeAdapter(
      claudeJson,
      join(dir, 'skills'),
      join(dir, 'CLAUDE.md'),
      join(dir, 'settings.json'),
      join(dir, 'plugins'),
    ),
    new CodexAdapter(codexToml, join(dir, 'codex-skills'), join(dir, 'AGENTS.md'), join(dir, 'shared')),
  ];
  try {
    const { ActionService } = await import('../src/web/actions.js');
    const service = new ActionService(adapters, join(dir, 'fleet-home'));
    await assert.rejects(
      service.plan({
        action: 'sync',
        kind: 'mcp-server',
        name: 'shared',
        from: 'claude-code',
        to: 'codex',
      }),
      /multiple scopes/,
    );
    const selected = await service.plan({
      action: 'sync',
      kind: 'mcp-server',
      name: 'shared',
      from: 'claude-code',
      fromScope: 'user',
      to: 'codex',
    });
    assert.equal(selected.changes.length, 1);
    assert.equal(selected.changes[0]?.scope, 'user');
    assert.equal(selected.changes[0]?.op, 'install');
    await assert.rejects(
      service.plan({
        action: 'update',
        kind: 'mcp-server',
        name: 'shared',
        scope: 'local',
        to: 'claude-code',
        coordinate: { version: '2.0.0' },
      }),
      /operation is not supported/,
    );
    assert.equal(readFileSync(codexToml, 'utf8'), '# codex\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('web core remove selects the user scope for non-MCP capabilities', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-web-skill-scope-'));
  const target = join(dir, 'skill-target');
  const adapter: AgentAdapter & SkillWriter = {
    id: 'skill-writer',
    displayName: 'Skill writer',
    supportsWrite: true,
    capabilitySupport: { skill: { inventory: 'supported', management: 'writable' } },
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
      const skill = (scope: 'user' | 'local', path: string) => ({
        kind: 'skill' as const,
        name: 'shared-skill',
        agent: this.id,
        scope,
        enabled: true,
        path,
        meta: {},
        source: { file: join(path, 'SKILL.md') },
      });
      return [skill('local', join(dir, 'local')), skill('user', target)];
    },
    async renderInstallSkill() {
      throw new Error('not used');
    },
    async renderRemoveSkill(ref) {
      assert.equal(ref.scope, 'user');
      return { file: target, newContent: '', fsKind: 'dir', dirOp: 'remove' };
    },
  };
  try {
    const { ActionService } = await import('../src/web/actions.js');
    const service = new ActionService([adapter], join(dir, 'fleet-home'));
    const plan = await service.plan({
      action: 'remove',
      kind: 'skill',
      name: 'shared-skill',
      from: 'skill-writer',
      scope: 'user',
    });
    assert.deepEqual(plan.changes, [
      {
        agent: 'skill-writer',
        kind: 'skill',
        name: 'shared-skill',
        scope: 'user',
        op: 'remove',
      },
    ]);
    await assert.rejects(
      service.plan({
        action: 'remove',
        kind: 'skill',
        name: 'shared-skill',
        from: 'skill-writer',
        scope: 'local',
      }),
      /read-only/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('web action plans reject inventory-withheld capability identities', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-web-hidden-action-'));
  const claudeJson = join(dir, '.claude.json');
  const unsafe = '/home/alice/OPAQUE_WEB_WITHHELD_ACTION';
  writeFileSync(claudeJson, JSON.stringify({ mcpServers: { [unsafe]: { command: 'safe-command' } } }));
  const adapter = new ClaudeCodeAdapter(
    claudeJson,
    join(dir, 'skills'),
    join(dir, 'CLAUDE.md'),
    join(dir, 'settings.json'),
    join(dir, 'plugins'),
  );
  try {
    const { ActionService } = await import('../src/web/actions.js');
    const service = new ActionService([adapter], join(dir, 'fleet-home'));
    await assert.rejects(
      service.plan({ action: 'remove', kind: 'mcp-server', name: unsafe, from: 'claude-code' }),
      /refusing non-public capability identity/,
    );
    assert.equal(JSON.parse(readFileSync(claudeJson, 'utf8')).mcpServers[unsafe].command, 'safe-command');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('web plan and apply mappers withhold non-public BYO agent identities', () => {
  const unsafeAgent = '/home/alice/PRIVATE_ADAPTER';
  const change = {
    agent: unsafeAgent,
    op: 'install' as const,
    name: 'safe-name',
    scope: 'user' as const,
    file: '/private/config.json',
    newContent: '{}',
  };
  const plan = mapPlan('plan-id', Date.now() + 1000, { changes: [change], skips: [] }, 'install');
  assert.deepEqual(plan.changes, []);
  const apply = mapApply({
    changes: [change],
    skips: [],
    committed: true,
    applied: [
      {
        change,
        auditId: '00000000-0000-4000-8000-000000000001',
        auditRecorded: true,
        backup: '',
        wroteHash: 'a'.repeat(64),
      },
    ],
  });
  assert.deepEqual(apply.records, []);
  assert.equal(apply.auditRecorded, 1);
  assert.equal(apply.unrecordedApplied, 0);
  assert.equal(apply.withheldApplied, 1);
  assert.equal(apply.recoveryClass, undefined);
  assert.equal(JSON.stringify({ plan, apply }).includes(unsafeAgent), false);
});

test('web action service refuses a plan whose mutation target is withheld from preview', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-web-hidden-plan-'));
  try {
    const target = join(dir, 'hidden-target.json');
    const hiddenId = '/home/alice/PRIVATE_ADAPTER';
    const adapter = {
      id: hiddenId,
      displayName: 'Private adapter',
      supportsWrite: true,
      capabilitySupport: { 'mcp-server': { inventory: 'supported', management: 'writable' } },
      detect: async () => ({ id: hiddenId, displayName: 'Private adapter', present: true, configPaths: [] }),
      readInventory: async () => [],
      renderInstall: async () => ({ file: target, newContent: '{"mcpServers":{}}' }),
      renderRemove: async () => ({ file: target, newContent: '{"mcpServers":{}}' }),
      validate: (content: string) => {
        JSON.parse(content);
      },
    } as AgentAdapter;
    const { ActionService } = await import('../src/web/actions.js');
    const service = new ActionService([adapter], join(dir, 'fleet-home'));
    await assert.rejects(
      service.plan({
        action: 'install',
        kind: 'mcp-server',
        name: 'safe-name',
        to: hiddenId,
        coordinate: { ecosystem: 'npm', identifier: 'safe-package', version: '1.0.0' },
      }),
      /non-public mutation target/,
    );
    assert.equal(existsSync(target), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('web apply mapper exposes recovery-pending state without filesystem details', () => {
  const apply = mapApply({
    changes: [],
    skips: [],
    committed: true,
    applied: [],
    failedAfter: 0,
    error: 'fleet: original at /home/alice/OPAQUE; recovery pending',
    recoveryPending: true,
  });
  assert.equal(apply.outcome, 'outcome-unknown');
  assert.deepEqual(apply.warningCodes, ['RECOVERY_PENDING']);
  assert.equal(apply.recoveryClass, 'manual-config-recovery');
  assert.equal(JSON.stringify(apply).includes('OPAQUE'), false);
});

test('web rollback mapper exposes failed lock cleanup as a fixed provenance warning', () => {
  assert.deepEqual(
    mapRollback({
      action: 'restored',
      auditRecorded: true,
      lockWarning: '/private/path must not cross the public boundary',
    }),
    { action: 'restored', lockWarningCode: 'PROVENANCE_WARNING' },
  );
});

test('web: applied mutation with failed audit append requires manual recovery', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-web-unrecorded-'));
  const claudeJson = join(dir, '.claude.json');
  const home = join(dir, 'home');
  writeFileSync(claudeJson, '{}');
  mkdirSync(home);
  const audit = join(home, 'audit.jsonl');
  writeFileSync(audit, '');
  chmodSync(audit, 0o400);
  const adapter = new ClaudeCodeAdapter(
    claudeJson,
    join(dir, 'sk'),
    join(dir, 'CLAUDE.md'),
    join(dir, 'settings.json'),
    join(dir, 'plugins'),
  );
  const { server } = createFleetServer([adapter], { token: 't', fleetHome: home });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const headers = {
    origin: `http://127.0.0.1:${port}`,
    'content-type': 'application/json',
    authorization: 'Bearer t',
  };
  try {
    const plan = await post(
      port,
      '/api/plan',
      headers,
      JSON.stringify({
        action: 'install',
        name: 'unrecorded',
        to: 'claude-code',
        coordinate: { ecosystem: 'npm', identifier: 'safe-package', version: '1.0.0' },
      }),
    );
    const result = await post(port, '/api/apply', headers, JSON.stringify({ planId: plan.json.planId }));
    assert.equal(result.status, 200);
    assert.equal(result.json.applied, 1);
    assert.equal(result.json.auditRecorded, 0);
    assert.equal(result.json.unrecordedApplied, 1);
    assert.equal(result.json.outcome, 'partial');
    assert.deepEqual(result.json.records, [
      {
        agent: 'claude-code',
        kind: 'mcp-server',
        name: 'unrecorded',
        scope: 'user',
        op: 'install',
        auditRecorded: false,
      },
    ]);
    assert.equal(result.json.recoveryClass, 'manual-config-recovery');
    assert.equal(result.json.warningCodes.includes('AUDIT_WRITE_FAILED'), true);
    assert.equal(Object.hasOwn(result.json, 'auditId'), false);
    assert.ok(JSON.parse(readFileSync(claudeJson, 'utf8')).mcpServers.unrecorded);
  } finally {
    chmodSync(audit, 0o600);
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('web: rollback requires an explicit eligible audit ID and targets that older change', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-web-rollback-'));
  const olderFile = join(dir, 'older.json');
  const newerFile = join(dir, 'newer.json');
  const home = join(dir, 'home');
  const [olderAudit] = await applyChanges(
    [
      {
        agent: 'codex',
        op: 'install',
        name: 'older',
        kind: 'mcp-server',
        scope: 'user',
        file: olderFile,
        newContent: '{}',
      },
    ],
    () => {},
    { fleetHome: home },
  );
  const [newerAudit] = await applyChanges(
    [
      {
        agent: 'codex',
        op: 'install',
        name: 'newer',
        kind: 'mcp-server',
        scope: 'user',
        file: newerFile,
        newContent: '{}',
      },
    ],
    () => {},
    { fleetHome: home },
  );
  const older = { json: { auditId: olderAudit!.auditId } };
  const newer = { json: { auditId: newerAudit!.auditId } };
  const { server } = createFleetServer([], { token: 't', fleetHome: home });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  const h = {
    origin: `http://127.0.0.1:${port}`,
    'content-type': 'application/json',
    authorization: 'Bearer t',
  };
  try {
    assert.match(older.json.auditId, /^[0-9a-f-]{36}$/i);
    assert.match(newer.json.auditId, /^[0-9a-f-]{36}$/i);

    const activity = await httpGet(port, '/api/activity', { authorization: 'Bearer t' });
    assert.equal(
      activity.json.items.find((item: any) => item.id === older.json.auditId).rollbackEligible,
      true,
    );
    assert.equal(
      activity.json.items.find((item: any) => item.id === newer.json.auditId).rollbackEligible,
      true,
    );
    for (const body of [{}, { auditId: '../audit.jsonl' }, { auditId: 'x'.repeat(200) }]) {
      const rejected = await post(port, '/api/rollback', h, JSON.stringify(body));
      assert.equal(rejected.status, 400);
      assert.deepEqual(rejected.json, {
        schemaVersion: 2,
        code: 'ACTION_REJECTED',
        messageKey: 'operation.rejected',
      });
    }

    const result = await post(port, '/api/rollback', h, JSON.stringify({ auditId: older.json.auditId }));
    assert.equal(result.status, 200);
    assert.deepEqual(result.json, { schemaVersion: 2, action: 'removed' });
    assert.equal(existsSync(newerFile), true);
    assert.equal(existsSync(olderFile), false);
    assertPublicResponse(result.json, '/api/rollback');
    assert.equal(
      (await post(port, '/api/rollback', h, JSON.stringify({ auditId: older.json.auditId }))).status,
      400,
    );
    const rollbackRecord = (await apiActivity(home)).items.find((item) => item.op === 'rollback');
    assert.ok(rollbackRecord);
    assert.equal(
      (await post(port, '/api/rollback', h, JSON.stringify({ auditId: rollbackRecord.id }))).status,
      400,
    );
    assert.equal(
      (
        await post(
          port,
          '/api/rollback',
          h,
          JSON.stringify({ auditId: '00000000-0000-4000-8000-000000000099' }),
        )
      ).status,
      400,
    );
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('web: targeted rollback reports divergence as skipped with a fixed redacted reason', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-web-rollback-diverged-'));
  const file = join(dir, 'agent-config.json');
  const home = join(dir, 'home');
  const [applied] = await applyChanges(
    [
      {
        agent: 'codex',
        op: 'install',
        name: 'demo',
        kind: 'mcp-server',
        scope: 'user',
        file,
        newContent: '{}',
      },
    ],
    () => {},
    { fleetHome: home },
  );
  writeFileSync(file, '{"user":"edit"}');
  const { server } = createFleetServer([], { token: 't', fleetHome: home });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const result = await post(
      port,
      '/api/rollback',
      {
        origin: `http://127.0.0.1:${port}`,
        'content-type': 'application/json',
        authorization: 'Bearer t',
      },
      JSON.stringify({ auditId: applied!.auditId }),
    );
    assert.equal(result.status, 200);
    assert.deepEqual(result.json, {
      schemaVersion: 2,
      action: 'skipped',
      reasonCode: 'TARGET_DIVERGED',
    });
    assert.equal(readFileSync(file, 'utf8'), '{"user":"edit"}');
    assertPublicResponse(result.json, '/api/rollback divergence');

    const afterSkipped = await apiActivity(home);
    const original = afterSkipped.items.find((item) => item.id === applied!.auditId);
    assert.equal(original?.outcome, 'applied');
    assert.equal(original?.rolledBack, false);
    assert.equal(original?.rollbackEligible, true);

    // The skipped attempt did not consume eligibility. Restoring the exact
    // Fleet-written bytes allows a later targeted rollback to complete.
    writeFileSync(file, '{}');
    const retried = await post(
      port,
      '/api/rollback',
      {
        origin: `http://127.0.0.1:${port}`,
        'content-type': 'application/json',
        authorization: 'Bearer t',
      },
      JSON.stringify({ auditId: applied!.auditId }),
    );
    assert.equal(retried.status, 200);
    assert.equal(retried.json.action, 'removed');
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('web: Activity only offers the newest active change for shared native state', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-web-rollback-order-'));
  const file = join(dir, 'shared.json');
  const home = join(dir, 'home');
  const versions = ['{"version":0}', '{"version":1}', '{"version":2}', '{"version":1}'];
  writeFileSync(file, versions[0]!);
  const ids: string[] = [];
  try {
    for (let index = 1; index < versions.length; index += 1) {
      const [applied] = await applyChanges(
        [
          {
            agent: 'codex',
            op: 'update',
            name: `change-${index}`,
            kind: 'mcp-server',
            scope: 'user',
            file,
            newContent: versions[index]!,
            baseHash: sha256(versions[index - 1]!),
          },
        ],
        () => {},
        { fleetHome: home },
      );
      ids.push(applied!.auditId);
    }

    const activity = await apiActivity(home);
    assert.equal(activity.items.find((item) => item.id === ids[0])?.rollbackEligible, false);
    assert.equal(activity.items.find((item) => item.id === ids[1])?.rollbackEligible, false);
    assert.equal(activity.items.find((item) => item.id === ids[2])?.rollbackEligible, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('web: completed rollback with failed audit append is not reported as failed', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-web-rollback-audit-'));
  const file = join(dir, 'created.json');
  const home = join(dir, 'home');
  const [applied] = await applyChanges(
    [
      {
        agent: 'codex',
        op: 'install',
        name: 'demo',
        kind: 'mcp-server',
        scope: 'user',
        file,
        newContent: '{}',
      },
    ],
    () => {},
    { fleetHome: home },
  );
  const audit = join(home, 'audit.jsonl');
  chmodSync(audit, 0o400);
  const { server } = createFleetServer([], { token: 't', fleetHome: home });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    const result = await post(
      port,
      '/api/rollback',
      {
        origin: `http://127.0.0.1:${port}`,
        'content-type': 'application/json',
        authorization: 'Bearer t',
      },
      JSON.stringify({ auditId: applied!.auditId }),
    );
    assert.equal(result.status, 200);
    assert.deepEqual(result.json, {
      schemaVersion: 2,
      action: 'removed',
      reasonCode: 'AUDIT_WRITE_FAILED',
      provenanceRecorded: false,
      recoveryClass: 'audit-history-repair',
    });
    assert.equal(existsSync(file), false);
  } finally {
    chmodSync(audit, 0o600);
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('web: refuses unsafe package coordinates (no flag/git/url/file injection)', async () => {
  const { server, port } = await startTest('t');
  const h = {
    origin: `http://127.0.0.1:${port}`,
    'content-type': 'application/json',
    authorization: 'Bearer t',
  };
  const bad = [
    'github:attacker/x',
    'file:/etc/passwd',
    'https://evil/x.tgz',
    '-e',
    'pkg with space',
    '@scope/x; rm -rf',
    'a'.repeat(201),
  ];
  try {
    for (const identifier of bad) {
      const r = await post(
        port,
        '/api/plan',
        h,
        JSON.stringify({
          action: 'install',
          name: 'x',
          to: ['claude-code'],
          coordinate: { ecosystem: 'npm', identifier },
        }),
      );
      assert.equal(r.status, 400, `expected 400 for '${identifier}'`);
      assert.equal(r.json.code, 'ACTION_REJECTED');
    }
    const overlongVersion = await post(
      port,
      '/api/plan',
      h,
      JSON.stringify({
        action: 'install',
        name: 'x',
        to: ['claude-code'],
        coordinate: {
          ecosystem: 'npm',
          identifier: 'safe-package',
          version: `v${'1'.repeat(64)}`,
        },
      }),
    );
    assert.equal(overlongVersion.status, 400);
    assert.equal(overlongVersion.json.code, 'ACTION_REJECTED');
  } finally {
    await close(server);
  }
});

test('web: update bumps version WITHOUT dropping env', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-web-'));
  const claudeJson = join(dir, '.claude.json');
  writeFileSync(
    claudeJson,
    JSON.stringify({
      mcpServers: {
        demo: {
          command: 'npx',
          args: ['--loglevel', 'warn', '@x/demo@1.0.0'],
          env: { API_KEY: 'secret' },
        },
        explicit: {
          command: 'npx',
          args: ['--package=@x/explicit@1.0.0', '--call', 'run-explicit'],
        },
      },
    }),
  );
  const adapter = new ClaudeCodeAdapter(
    claudeJson,
    join(dir, 'sk'),
    join(dir, 'CLAUDE.md'),
    join(dir, 'settings.json'),
    join(dir, 'plugins'),
  );
  const { server } = createFleetServer([adapter], { token: 't', fleetHome: join(dir, 'home') });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const h = {
    origin: `http://127.0.0.1:${port}`,
    'content-type': 'application/json',
    authorization: 'Bearer t',
  };
  try {
    const planned = await post(
      port,
      '/api/plan',
      h,
      JSON.stringify({
        action: 'update',
        name: 'demo',
        to: ['claude-code'],
        coordinate: { version: '2.0.0' },
      }),
    );
    assert.equal(planned.status, 200);
    assert.equal(planned.json.operationSummary, 'update mcp-server (1 change)');
    assert.equal(planned.json.changes[0]?.op, 'update');
    const applied = await post(port, '/api/apply', h, JSON.stringify({ planId: planned.json.planId }));
    assert.equal(applied.json.records[0]?.op, 'update');
    const written = JSON.parse(readFileSync(claudeJson, 'utf8'));
    assert.deepEqual(written.mcpServers.demo.args, ['--loglevel', 'warn', '@x/demo@2.0.0']);
    assert.equal(written.mcpServers.demo.env.API_KEY, 'secret'); // env preserved

    const explicitPlan = await post(
      port,
      '/api/plan',
      h,
      JSON.stringify({
        action: 'update',
        name: 'explicit',
        to: ['claude-code'],
        coordinate: { version: '2.0.0' },
      }),
    );
    assert.equal(explicitPlan.status, 200);
    await post(port, '/api/apply', h, JSON.stringify({ planId: explicitPlan.json.planId }));
    const explicitWritten = JSON.parse(readFileSync(claudeJson, 'utf8'));
    assert.deepEqual(explicitWritten.mcpServers.explicit.args, [
      '--package=@x/explicit@2.0.0',
      '--call',
      'run-explicit',
    ]);
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('web: inventory reflects an APPLY immediately (cache invalidated)', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { ClaudeCodeAdapter } = await import('../src/adapters/claude-code.js');
  const dir = mkdtempSync(join(tmpdir(), 'fleet-webapply-'));
  writeFileSync(join(dir, '.claude.json'), '{"mcpServers":{}}');
  const real = new ClaudeCodeAdapter(
    join(dir, '.claude.json'),
    join(dir, 'skills'),
    join(dir, 'CLAUDE.md'),
    join(dir, 'settings.json'),
    join(dir, 'plugins'),
  );
  const { server } = createFleetServer([real], {
    token: 't',
    sources: fakeSources,
    fleetHome: join(dir, 'home'),
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  try {
    // prime the inventory cache
    await fetch(`http://127.0.0.1:${port}/api/inventory`, { headers: { authorization: 'Bearer t' } });
    const planRes = await fetch(`http://127.0.0.1:${port}/api/plan`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer t',
        'content-type': 'application/json',
        origin: `http://127.0.0.1:${port}`,
      },
      body: JSON.stringify({
        action: 'install',
        name: 'fresh-one',
        to: ['claude-code'],
        coordinate: { ecosystem: 'npm', identifier: 'fresh-one-pkg' },
      }),
    });
    const { planId } = (await planRes.json()) as { planId: string };
    const applied = (await (
      await fetch(`http://127.0.0.1:${port}/api/apply`, {
        method: 'POST',
        headers: {
          authorization: 'Bearer t',
          'content-type': 'application/json',
          origin: `http://127.0.0.1:${port}`,
        },
        body: JSON.stringify({ planId }),
      })
    ).json()) as { applied: number };
    assert.equal(applied.applied, 1);
    // immediate refresh must show the new server (no 3s stale window)
    const inv = (await (
      await fetch(`http://127.0.0.1:${port}/api/inventory`, { headers: { authorization: 'Bearer t' } })
    ).json()) as { capabilities: { name: string }[] };
    assert.ok(
      inv.capabilities.some((capability) => capability.name === 'fresh-one'),
      'apply not visible — cache not invalidated',
    );
  } finally {
    await close(server);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('web actions: skill sync (claude→codex) plans through the skill engine, not MCP', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { ClaudeCodeAdapter } = await import('../src/adapters/claude-code.js');
  const { CodexAdapter } = await import('../src/adapters/codex.js');
  const { ActionService } = await import('../src/web/actions.js');
  const dir = mkdtempSync(join(tmpdir(), 'fleet-wact-'));
  try {
    // claude has skill 'demo'; codex has none
    writeFileSync(join(dir, '.claude.json'), '{"mcpServers":{}}');
    mkdirSync(join(dir, 'cskills', 'demo'), { recursive: true });
    writeFileSync(join(dir, 'cskills', 'demo', 'SKILL.md'), '# demo');
    const claude = new ClaudeCodeAdapter(
      join(dir, '.claude.json'),
      join(dir, 'cskills'),
      join(dir, 'CLAUDE.md'),
      join(dir, 'settings.json'),
      join(dir, 'plugins'),
    );
    const codex = new CodexAdapter(
      join(dir, 'config.toml'),
      join(dir, 'xskills'),
      join(dir, 'AGENTS.md'),
      join(dir, '_shared'),
    );
    writeFileSync(join(dir, 'config.toml'), '');
    const svc = new ActionService([claude, codex], join(dir, 'home'));
    const { planId, changes } = await svc.plan({
      action: 'sync',
      kind: 'skill',
      name: 'demo',
      from: 'claude-code',
      to: ['codex'],
    });
    assert.equal(changes.length, 1);
    assert.equal(changes[0]!.agent, 'codex');
    await svc.apply({ planId });
    const { existsSync } = await import('node:fs');
    assert.ok(existsSync(join(dir, 'xskills', 'demo', 'SKILL.md'))); // landed on codex
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('web actions: plugin selector is validated (no shell injection via marketplace)', async () => {
  const { ActionService } = await import('../src/web/actions.js');
  const dir = mkdtempSync(join(tmpdir(), 'fleet-web-plugin-'));
  try {
    const svc = new ActionService([], join(dir, 'fleet-home'));
    await assert.rejects(
      svc.plan({ action: 'install', kind: 'plugin', name: 'x', to: ['codex'], marketplace: 'm; rm -rf /' }),
      /unsafe plugin selector/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('web plugin remove preview exposes the marketplace resolved from unique inventory', async () => {
  const { ActionService } = await import('../src/web/actions.js');
  const dir = mkdtempSync(join(tmpdir(), 'fleet-web-plugin-coordinate-'));
  const adapter: AgentAdapter = {
    id: 'claude-code',
    displayName: 'Claude Code',
    capabilitySupport: { plugin: { inventory: 'supported', management: 'delegated' } },
    async detect() {
      return {
        id: this.id,
        displayName: this.displayName,
        present: true,
        configPaths: [],
        runtimeStatus: 'available',
      };
    },
    async readInventory() {
      return [
        {
          kind: 'plugin' as const,
          name: 'shared',
          marketplace: 'official',
          agent: this.id,
          scope: 'user' as const,
          enabled: true,
          source: { file: 'fixture' },
        },
      ];
    },
  };
  try {
    const service = new ActionService([adapter], join(dir, 'fleet-home'));
    const plan = await service.plan({
      action: 'remove',
      kind: 'plugin',
      name: 'shared',
      from: 'claude-code',
    });
    assert.deepEqual(plan.changes, [
      {
        agent: 'claude-code',
        kind: 'plugin',
        name: 'shared',
        marketplace: 'official',
        scope: 'user',
        op: 'remove',
      },
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('web delegated plugin mutations refuse inventory outside the supported user scope', async () => {
  const { ActionService } = await import('../src/web/actions.js');
  const dir = mkdtempSync(join(tmpdir(), 'fleet-web-plugin-scope-'));
  let calls = 0;
  const adapter: AgentAdapter = {
    id: 'claude-code',
    displayName: 'Claude Code',
    capabilitySupport: { plugin: { inventory: 'supported', management: 'delegated' } },
    async detect() {
      return {
        id: this.id,
        displayName: this.displayName,
        present: true,
        configPaths: [],
        runtimeStatus: 'available',
      };
    },
    async readInventory() {
      return [
        {
          kind: 'plugin' as const,
          name: 'scoped-plugin',
          marketplace: 'official',
          agent: this.id,
          scope: 'local' as const,
          enabled: true,
          source: { file: 'fixture' },
        },
      ];
    },
  };
  try {
    const service = new ActionService([adapter], join(dir, 'fleet-home'), async () => {
      calls++;
      return { exitCode: 0, output: 'not reached' };
    });
    await assert.rejects(
      service.plan({
        action: 'remove',
        kind: 'plugin',
        name: 'scoped-plugin',
        marketplace: 'official',
        from: 'claude-code',
      }),
      /not supported|supported user scope/,
    );
    assert.equal(calls, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('web actions: plugin plan→apply runs the vendor argv once; replay refused; injection blocked', async () => {
  const { ActionService } = await import('../src/web/actions.js');
  const calls: string[][] = [];
  let installed = false;
  const runner = async (argv: string[]) => {
    calls.push(argv);
    installed = true;
    return { exitCode: 0, output: 'ok' };
  };
  const dir = mkdtempSync(join(tmpdir(), 'fleet-web-plugin-'));
  const pluginAdapter: AgentAdapter = {
    id: 'codex',
    displayName: 'Codex',
    capabilitySupport: { plugin: { inventory: 'supported', management: 'delegated' } },
    async detect() {
      return {
        id: 'codex',
        displayName: 'Codex',
        present: true,
        configPaths: [],
        runtimeStatus: 'available',
      };
    },
    async readInventory() {
      return installed
        ? [
            {
              kind: 'plugin' as const,
              name: 'ponytail',
              marketplace: 'sisyphuslabs',
              agent: 'codex',
              scope: 'user' as const,
              enabled: true,
              source: { file: 'fixture' },
            },
          ]
        : [];
    },
  };
  const svc = new ActionService([pluginAdapter], join(dir, 'fleet-home'), runner);

  try {
    // plan → preview carries the exact argv + undo; apply runs it exactly once
    const { planId, changes, operationSummary } = await svc.plan({
      action: 'install',
      kind: 'plugin',
      name: 'ponytail',
      to: ['codex'],
      marketplace: 'sisyphuslabs',
    });
    assert.deepEqual(changes, [
      {
        agent: 'codex',
        kind: 'plugin',
        name: 'ponytail',
        marketplace: 'sisyphuslabs',
        scope: 'user',
        op: 'install',
      },
    ]);
    assert.equal(operationSummary, 'install plugin (1 change)');
    assert.equal(calls.length, 0); // plan is exec-free
    const applied = await svc.apply({ planId });
    assert.equal(applied.applied, 1);
    assert.equal(applied.outcome, 'applied');
    assert.deepEqual(calls, [['codex', 'plugin', 'add', 'ponytail@sisyphuslabs']]);
    await assert.rejects(svc.apply({ planId }), /unknown planId/); // single-use replay guard

    // name-side + path-shaped injection all refused
    for (const bad of [
      { name: '--force', marketplace: 'm' },
      { name: 'a;b', marketplace: 'm' },
      { name: 'tmp/plugin', marketplace: undefined },
      { name: 'a/./b', marketplace: undefined },
      { name: 'x@evil', marketplace: 'm' },
    ]) {
      await assert.rejects(
        svc.plan({
          action: 'install',
          kind: 'plugin',
          name: bad.name,
          to: ['codex'],
          marketplace: bad.marketplace,
        }),
        /unsafe plugin selector|marketplace must be supplied separately/,
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('web delegated apply reports outcome-unknown when persistence fails after vendor success', async () => {
  const { ActionService } = await import('../src/web/actions.js');
  const dir = mkdtempSync(join(tmpdir(), 'fleet-web-plugin-unknown-'));
  const fleetHome = join(dir, 'fleet-home');
  let calls = 0;
  let installed = false;
  const pluginAdapter: AgentAdapter = {
    id: 'codex',
    displayName: 'Codex',
    capabilitySupport: { plugin: { inventory: 'supported', management: 'delegated' } },
    async detect() {
      return {
        id: 'codex',
        displayName: 'Codex',
        present: true,
        configPaths: [],
        runtimeStatus: 'available',
      };
    },
    async readInventory() {
      return installed
        ? [
            {
              kind: 'plugin' as const,
              name: 'ponytail',
              agent: 'codex',
              scope: 'user' as const,
              enabled: true,
              source: { file: 'fixture' },
            },
          ]
        : [];
    },
  };
  const svc = new ActionService([pluginAdapter], fleetHome, async () => {
    calls++;
    installed = true;
    chmodSync(join(fleetHome, 'delegated.jsonl'), 0o400);
    return { exitCode: 0, output: 'vendor reported success' };
  });
  try {
    const plan = await svc.plan({
      action: 'install',
      kind: 'plugin',
      name: 'ponytail',
      to: 'codex',
    });
    const result = await svc.apply({ planId: plan.planId });
    assert.equal(calls, 1);
    assert.match(result.records[0]?.delegatedId ?? '', /^[0-9a-f-]{36}$/i);
    assert.deepEqual(result, {
      applied: 0,
      skipped: 1,
      records: [
        {
          agent: 'codex',
          kind: 'plugin',
          name: 'ponytail',
          scope: 'user',
          op: 'install',
          delegatedRecorded: false,
          delegatedId: result.records[0]?.delegatedId,
        },
      ],
      warningCodes: ['OUTCOME_UNKNOWN'],
      outcome: 'outcome-unknown',
      recoveryClass: 'vendor-state-inspection',
    });
  } finally {
    if (existsSync(join(fleetHome, 'delegated.jsonl'))) {
      chmodSync(join(fleetHome, 'delegated.jsonl'), 0o600);
    }
    rmSync(dir, { recursive: true, force: true });
  }
});

test('web delegated apply rechecks stale plans and treats vendor no-ops without destructive recovery', async () => {
  const { ActionService } = await import('../src/web/actions.js');
  const dir = mkdtempSync(join(tmpdir(), 'fleet-web-plugin-effect-'));
  let installed = false;
  let calls = 0;
  const pluginAdapter: AgentAdapter = {
    id: 'codex',
    displayName: 'Codex',
    capabilitySupport: { plugin: { inventory: 'supported', management: 'delegated' } },
    async detect() {
      return {
        id: 'codex',
        displayName: 'Codex',
        present: true,
        configPaths: [],
        runtimeStatus: 'available',
      };
    },
    async readInventory() {
      return installed
        ? [
            {
              kind: 'plugin' as const,
              name: 'ponytail',
              agent: 'codex',
              scope: 'user' as const,
              enabled: true,
              source: { file: 'fixture' },
            },
          ]
        : [];
    },
  };
  const expectedPreVendorNoChange = {
    applied: 0,
    skipped: 1,
    records: [
      {
        agent: 'codex',
        kind: 'plugin',
        name: 'ponytail',
        scope: 'user',
        op: 'install',
        delegatedRecorded: false,
      },
    ],
    warningCodes: ['NO_CHANGE'],
    outcome: 'nothing-to-do',
  };
  try {
    const lockedHome = join(dir, 'locked-home');
    const lockedService = new ActionService([pluginAdapter], lockedHome, async () => {
      calls++;
      return { exitCode: 0, output: '' };
    });
    const locked = await lockedService.plan({
      action: 'install',
      kind: 'plugin',
      name: 'ponytail',
      to: 'codex',
    });
    mkdirSync(lockedHome, { recursive: true });
    writeFileSync(join(lockedHome, '.lock'), 'held elsewhere');
    assert.deepEqual(await lockedService.apply({ planId: locked.planId }), {
      applied: 0,
      skipped: 1,
      records: [
        {
          agent: 'codex',
          kind: 'plugin',
          name: 'ponytail',
          scope: 'user',
          op: 'install',
          delegatedRecorded: false,
        },
      ],
      warningCodes: ['OPERATION_FAILED'],
      outcome: 'failed',
    });
    assert.equal(calls, 0);

    const staleService = new ActionService([pluginAdapter], join(dir, 'stale-home'), async () => {
      calls++;
      return { exitCode: 0, output: '' };
    });
    const stale = await staleService.plan({
      action: 'install',
      kind: 'plugin',
      name: 'ponytail',
      to: 'codex',
    });
    installed = true;
    assert.deepEqual(await staleService.apply({ planId: stale.planId }), expectedPreVendorNoChange);
    assert.equal(calls, 0, 'stale precondition must stop before spawning the vendor CLI');

    installed = false;
    const noOpService = new ActionService([pluginAdapter], join(dir, 'noop-home'), async () => {
      calls++;
      return { exitCode: 0, output: 'vendor no-op' };
    });
    const noOp = await noOpService.plan({
      action: 'install',
      kind: 'plugin',
      name: 'ponytail',
      to: 'codex',
    });
    const noOpResult = await noOpService.apply({ planId: noOp.planId });
    assert.match(noOpResult.records[0]?.delegatedId ?? '', /^[0-9a-f-]{36}$/i);
    assert.deepEqual(noOpResult, {
      applied: 0,
      skipped: 1,
      records: [
        {
          agent: 'codex',
          kind: 'plugin',
          name: 'ponytail',
          scope: 'user',
          op: 'install',
          delegatedRecorded: true,
          delegatedId: noOpResult.records[0]?.delegatedId,
        },
      ],
      warningCodes: ['NO_CHANGE'],
      outcome: 'nothing-to-do',
    });
    assert.equal(calls, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('web actions: unknown kind/action fail closed (no default engine)', async () => {
  const { ActionService } = await import('../src/web/actions.js');
  const dir = mkdtempSync(join(tmpdir(), 'fleet-web-action-'));
  try {
    const svc = new ActionService([], join(dir, 'fleet-home'));
    await assert.rejects(
      svc.plan({ action: 'remove', kind: 'banana', name: 'x', from: ['codex'] }),
      /unknown kind/,
    );
    await assert.rejects(
      svc.plan({ action: 'sync', kind: 'plugin', name: 'x', to: ['codex'], marketplace: 'm' }),
      /plugin action must be install or remove/,
    );
    await assert.rejects(
      svc.plan({ action: 'install', kind: 'skill', name: 'x', to: ['codex'], coordinate: {} }),
      /dedicated local source input/,
    );
    await assert.rejects(
      svc.plan({ action: 'install', kind: 'rule', name: 'x', to: ['codex'], coordinate: {} }),
      /dedicated local source input/,
    );
    await assert.rejects(
      svc.plan({ action: 'update', kind: 'skill', name: 'x', to: ['codex'], coordinate: {} }),
      /not supported by this endpoint/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('web fixture server uses only one temporary root and cleans it up', async () => {
  const { startWebFixtureServer } = await import('./helpers/web-fixture-server.js');
  const fixture = await startWebFixtureServer('fixture-token');
  try {
    assert.match(fixture.url, /^http:\/\/127\.0\.0\.1:\d+\/\?token=fixture-token$/);
    assert.ok(fixture.paths.every((path: string) => path.startsWith(`${fixture.root}/`)));
    const inventory = await fetch(`${fixture.url.split('/?')[0]}/api/inventory`, {
      headers: { authorization: 'Bearer fixture-token' },
    });
    assert.equal(inventory.status, 200);
    const body = (await inventory.json()) as { capabilities: { kind: string; name: string }[] };
    assert.deepEqual(
      body.capabilities
        .filter((capability) => capability.kind === 'mcp-server')
        .map((capability) => capability.name)
        .sort(),
      ['fixture-claude', 'fixture-codex'],
    );
    assert.deepEqual(
      body.capabilities
        .filter((capability) => capability.kind === 'skill')
        .map((capability) => capability.name)
        .sort(),
      ['fixture-claude-skill', 'fixture-codex-skill'],
    );
    assert.deepEqual(
      body.capabilities
        .filter((capability) => capability.kind === 'rule')
        .map((capability) => capability.name)
        .sort(),
      ['fixture-claude-rule', 'fixture-codex-rule'],
    );
    assert.deepEqual(
      body.capabilities
        .filter((capability) => capability.kind === 'plugin')
        .map((capability) => capability.name)
        .sort(),
      ['fixture-claude-plugin'],
    );
    assertPublicResponse(body, '/api/inventory');
    assert.ok(existsSync(fixture.root));
  } finally {
    await fixture.close();
  }
  assert.equal(existsSync(fixture.root), false);
});

test('web fixture server cleans its root when initialization fails', async () => {
  const { startWebFixtureServer } = await import('./helpers/web-fixture-server.js');
  let root = '';
  await assert.rejects(
    startWebFixtureServer('fixture-token', {
      afterRootCreated(createdRoot: string) {
        root = createdRoot;
        throw new Error('fixture setup failed');
      },
    }),
    /fixture setup failed/,
  );
  assert.notEqual(root, '');
  assert.equal(existsSync(root), false);
});

test('web fixture server URL-encodes a caller-supplied token', async () => {
  const { startWebFixtureServer } = await import('./helpers/web-fixture-server.js');
  const token = 'fixture&token#+%';
  const fixture = await startWebFixtureServer(token);
  try {
    assert.equal(new URL(fixture.url).searchParams.get('token'), token);
  } finally {
    await fixture.close();
  }
});
