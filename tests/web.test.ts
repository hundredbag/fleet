import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { request, type IncomingHttpHeaders, type Server } from 'node:http';
import { existsSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFleetServer } from '../src/web/server.js';
import { apiActivity } from '../src/web/api.js';
import { checkHost, checkOrigin, tokenMatches } from '../src/web/security.js';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.js';
import type { AgentAdapter } from '../src/core/adapter.js';
import type { FeedSource } from '../src/feed/source.js';
import { applyChanges } from '../src/core/writer.js';
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
    updates: [],
    skillUpdates: [{ name: 's', agent: 'a', state: 'update' }],
    recommendations: [],
    failures: [],
    fromCache: false,
  });
  assert.equal(feed.skillUpdates[0]!.operation, null);
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
    assert.equal(coreOnly.delegatedActions.status, 'not-present');
    assert.equal(coreOnly.items.filter((x) => x.rollbackEligible).length, 1);
    assert.equal(coreOnly.items.find((x) => x.rollbackEligible)?.source, 'core-audit');
    assert.equal(coreOnly.items.find((x) => x.name === 'core-0')?.id, opaqueId(0));
    assert.doesNotMatch(JSON.stringify(coreOnly), /1700000000000-123/);

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
    assert.equal(result.items.filter((x) => x.rollbackEligible).length, 1);
    assert.equal(result.items.find((x) => x.rollbackEligible)?.source, 'core-audit');

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
    assert.doesNotMatch(JSON.stringify(await apiActivity(root)), /DASHBOARD_FIXTURE_CAUGHT_ERROR_DETAIL/);

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
        },
      ],
      () => {},
      { fleetHome: root },
    );
    const result = await apiActivity(root);
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0]?.id, applied[0]?.auditId);
    assert.equal(result.items[0]?.rollbackEligible, true);
    assert.match(result.items[0]?.id ?? '', /^[0-9a-f-]{36}$/i);
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
    const failedGet = await httpGet(port, '/api/activity', { authorization: 'Bearer t' });
    assert.equal(failedGet.status, 500);
    assert.match(String(failedGet.headers['content-type'] ?? ''), /application\/json/);
    assertPublicResponse(failedGet.json, 'failed GET');

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
      mcpServers: { demo: { command: 'npx', args: ['-y', '@x/demo@1.0.0'], env: { API_KEY: 'secret' } } },
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
    await post(port, '/api/apply', h, JSON.stringify({ planId: planned.json.planId }));
    const written = JSON.parse(readFileSync(claudeJson, 'utf8'));
    assert.equal(written.mcpServers.demo.args[1], '@x/demo@2.0.0'); // version bumped
    assert.equal(written.mcpServers.demo.env.API_KEY, 'secret'); // env preserved
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

test('web actions: plugin plan→apply runs the vendor argv once; replay refused; injection blocked', async () => {
  const { ActionService } = await import('../src/web/actions.js');
  const calls: string[][] = [];
  const runner = async (argv: string[]) => {
    calls.push(argv);
    return { exitCode: 0, output: 'ok' };
  };
  const dir = mkdtempSync(join(tmpdir(), 'fleet-web-plugin-'));
  const pluginAdapter: AgentAdapter = {
    id: 'codex',
    displayName: 'Codex',
    capabilitySupport: { plugin: { inventory: 'supported', management: 'delegated' } },
    async detect() {
      return { id: 'codex', displayName: 'Codex', present: true, configPaths: [] };
    },
    async readInventory() {
      return [];
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
      { agent: 'codex', kind: 'plugin', name: 'ponytail', scope: 'user', op: 'install' },
    ]);
    assert.equal(operationSummary, 'install plugin (1 change)');
    assert.equal(calls.length, 0); // plan is exec-free
    const applied = await svc.apply({ planId });
    assert.equal(applied.applied, 1);
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
        /unsafe plugin selector/,
      );
    }
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
      ['fixture-claude-plugin', 'fixture-codex-plugin'],
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
