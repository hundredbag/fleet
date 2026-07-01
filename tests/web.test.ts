import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createFleetServer } from '../src/web/server.js';
import { checkHost, checkOrigin, tokenMatches } from '../src/web/security.js';
import type { AgentAdapter } from '../src/core/adapter.js';
import type { FeedSource } from '../src/feed/source.js';

const fakeAdapter: AgentAdapter = {
  id: 'claude-code',
  displayName: 'Claude Code',
  supportsWrite: false,
  async detect() {
    return { id: 'claude-code', displayName: 'Claude Code', present: true, configPaths: [] };
  },
  async readInventory() {
    return [
      { kind: 'mcp-server', name: 'gh', agent: 'claude-code', scope: 'user', enabled: true, spec: { transport: 'stdio', command: 'npx', args: ['-y', '@x/gh'] }, source: { file: 'f' } },
      { kind: 'rule', name: 'style', agent: 'claude-code', scope: 'user', enabled: true, body: 'be terse', source: { file: 'g' } },
    ];
  },
};

const fakeSources: FeedSource[] = [
  { id: 'fake', list: async () => [{ name: 'cool', source: 'fake', identifier: '@x/cool', ecosystem: 'npm', popularity: 1000 }] },
];

async function startTest(token: string): Promise<{ server: Server; port: number }> {
  const { server } = createFleetServer([fakeAdapter], { token, sources: fakeSources });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { server, port };
}
const close = (s: Server) => new Promise<void>((r) => s.close(() => r()));

test('security: host / origin / token checks (unit)', () => {
  assert.equal(checkHost('127.0.0.1:7777', 7777), true);
  assert.equal(checkHost('localhost:7777', 7777), true);
  assert.equal(checkHost('evil.com:7777', 7777), false); // anti DNS-rebinding
  assert.equal(checkHost('127.0.0.1:80', 7777), false);
  assert.equal(checkOrigin(undefined, 7777), true); // top-level navigation
  assert.equal(checkOrigin('http://127.0.0.1:7777', 7777), true);
  assert.equal(checkOrigin('http://evil.com', 7777), false);
  assert.equal(tokenMatches('a', 'a'), true);
  assert.equal(tokenMatches('a', 'b'), false);
  assert.equal(tokenMatches(undefined, 'a'), false);
});

test('web: API requires the session token', async () => {
  const { server, port } = await startTest('secret');
  try {
    assert.equal((await fetch(`http://127.0.0.1:${port}/api/inventory`)).status, 401);
    const r = await fetch(`http://127.0.0.1:${port}/api/inventory`, { headers: { authorization: 'Bearer secret' } });
    assert.equal(r.status, 200);
    const inv = (await r.json()) as { servers: { name: string }[] };
    assert.ok(inv.servers.some((s) => s.name === 'gh'));
  } finally {
    await close(server);
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
