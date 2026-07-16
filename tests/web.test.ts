import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { request, type Server } from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFleetServer } from '../src/web/server.js';
import { checkHost, checkOrigin, tokenMatches } from '../src/web/security.js';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.js';
import type { AgentAdapter } from '../src/core/adapter.js';
import type { FeedSource } from '../src/feed/source.js';

// POST helper with full header control (node fetch may strip forbidden headers like Origin).
function post(
  port: number,
  path: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; json: any }> {
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
        resolve({ status: res.statusCode ?? 0, json });
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

async function startTest(token: string): Promise<{ server: Server; port: number }> {
  const { server } = createFleetServer([fakeAdapter], { token, sources: fakeSources });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  return { server, port };
}
const close = (s: Server) => new Promise<void>((r) => s.close(() => r()));

function httpGet(
  port: number,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; json: any }> {
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
        resolve({ status: res.statusCode ?? 0, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

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

test('web: allow-host lets a Tailscale host through, still token-gated + anti-rebinding', async () => {
  const { server } = createFleetServer([fakeAdapter], {
    token: 't',
    sources: fakeSources,
    allowHosts: ['fleet.tail.ts.net'],
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

test('web: plan → apply installs to a real agent config; planId is single-use', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-web-'));
  const claudeJson = join(dir, '.claude.json');
  writeFileSync(claudeJson, '{}');
  const adapter = new ClaudeCodeAdapter(claudeJson, join(dir, 'sk'), join(dir, 'CLAUDE.md'));
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
    assert.ok(planned.json.planId);
    assert.equal(planned.json.preview.changes.length, 1);
    // not yet written (dry-run preview only)
    assert.doesNotMatch(readFileSync(claudeJson, 'utf8'), /@x\/demo/);

    const applied = await post(port, '/api/apply', h, JSON.stringify({ planId: planned.json.planId }));
    assert.equal(applied.json.status, 'applied');
    assert.match(readFileSync(claudeJson, 'utf8'), /@x\/demo/);

    // same planId can't be replayed
    const replay = await post(port, '/api/apply', h, JSON.stringify({ planId: planned.json.planId }));
    assert.equal(replay.status, 400);

    // preview reveals the actual command that will run
    assert.equal(planned.json.runs, 'npx -y @x/demo');
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
      assert.match(String(r.json.error), /unsafe/);
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
  const adapter = new ClaudeCodeAdapter(claudeJson, join(dir, 'sk'), join(dir, 'CLAUDE.md'));
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
    assert.equal(planned.json.runs, 'npx -y @x/demo@2.0.0');
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
    ).json()) as { status: string };
    assert.equal(applied.status, 'applied');
    // immediate refresh must show the new server (no 3s stale window)
    const inv = (await (
      await fetch(`http://127.0.0.1:${port}/api/inventory`, { headers: { authorization: 'Bearer t' } })
    ).json()) as { servers: { name: string }[] };
    assert.ok(
      inv.servers.some((s) => s.name === 'fresh-one'),
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
    const svc = new ActionService([claude, codex], join(dir, 'home'));
    const { planId, preview } = await svc.plan({
      action: 'sync',
      kind: 'skill',
      name: 'demo',
      from: 'claude-code',
      to: ['codex'],
    });
    assert.equal(preview.changes.length, 1);
    assert.equal(preview.changes[0]!.agent, 'codex');
    await svc.apply({ planId });
    const { existsSync } = await import('node:fs');
    assert.ok(existsSync(join(dir, 'xskills', 'demo', 'SKILL.md'))); // landed on codex
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('web actions: plugin selector is validated (no shell injection via marketplace)', async () => {
  const { ActionService } = await import('../src/web/actions.js');
  const svc = new ActionService([], undefined);
  await assert.rejects(
    svc.plan({ action: 'install', kind: 'plugin', name: 'x', to: ['codex'], marketplace: 'm; rm -rf /' }),
    /unsafe plugin selector/,
  );
});
