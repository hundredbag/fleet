import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { CodexAdapter } from '../src/adapters/codex.js';
import { GeminiAdapter, parseGeminiEntry } from '../src/adapters/gemini.js';
import { applyChanges, toPlannedChange } from '../src/core/writer.js';

function withTempDir(fn: (dir: string) => void | Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-p2-'));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

// ---------------- Codex (TOML, comment-preserving) ----------------

const SEED_TOML = `# my codex config
model = "gpt-5.5"

[mcp_servers.foo]
command = "foo-cmd"   # keep this comment
args = ["a"]

[some_other_table]
x = 1
`;

test(
  'codex writer: install a new server preserves comments + other tables',
  withTempDir(async (dir) => {
    const toml = join(dir, 'config.toml');
    writeFileSync(toml, SEED_TOML);
    const a = new CodexAdapter(toml, join(dir, '_sk'), join(dir, '_rules.md'), join(dir, '_shared'));
    const r = await a.renderInstall(
      { transport: 'stdio', command: 'npx', args: ['-y', 'bar'] },
      { kind: 'mcp-server', name: 'bar', scope: 'user' },
    );
    const out = r.newContent;
    assert.match(out, /# my codex config/); // top comment kept
    assert.match(out, /keep this comment/); // inline comment on foo kept
    assert.match(out, /\[some_other_table\]/); // unrelated table kept
    assert.match(out, /\[mcp_servers\.foo\]/); // existing server kept
    assert.match(out, /\[mcp_servers\.bar\]/); // new server added
    // and it's valid TOML that round-trips
    const parsed = parseToml(out) as any;
    assert.equal(parsed.mcp_servers.bar.command, 'npx');
    assert.equal(parsed.mcp_servers.foo.command, 'foo-cmd');
    assert.equal(parsed.some_other_table.x, 1);
  }),
);

test(
  'codex writer: replacing an existing server leaves comments/other tables intact',
  withTempDir(async (dir) => {
    const toml = join(dir, 'config.toml');
    writeFileSync(toml, SEED_TOML);
    const a = new CodexAdapter(toml, join(dir, '_sk'), join(dir, '_rules.md'), join(dir, '_shared'));
    const r = await a.renderInstall(
      { transport: 'stdio', command: 'foo-NEW' },
      { kind: 'mcp-server', name: 'foo', scope: 'user' },
    );
    const parsed = parseToml(r.newContent) as any;
    assert.equal(parsed.mcp_servers.foo.command, 'foo-NEW');
    assert.match(r.newContent, /# my codex config/);
    assert.match(r.newContent, /\[some_other_table\]/);
  }),
);

test(
  'codex writer: remove deletes only the target table',
  withTempDir(async (dir) => {
    const toml = join(dir, 'config.toml');
    writeFileSync(toml, SEED_TOML);
    const a = new CodexAdapter(toml, join(dir, '_sk'), join(dir, '_rules.md'), join(dir, '_shared'));
    const r = await a.renderRemove({ kind: 'mcp-server', name: 'foo', scope: 'user' });
    const parsed = parseToml(r.newContent) as any;
    assert.equal(parsed.mcp_servers?.foo, undefined);
    assert.match(r.newContent, /# my codex config/);
    assert.equal(parsed.some_other_table.x, 1);
  }),
);

test(
  'codex writer: remote renders url + bearer_token_env_var + http_headers',
  withTempDir(async (dir) => {
    const toml = join(dir, 'config.toml');
    writeFileSync(toml, '# c\n');
    const a = new CodexAdapter(toml, join(dir, '_sk'), join(dir, '_rules.md'), join(dir, '_shared'));
    const r = await a.renderInstall(
      {
        transport: 'http',
        url: 'https://r.test/mcp',
        bearerTokenEnvVar: 'MY_TOKEN',
        headers: { 'X-Extra': '1' },
      },
      { kind: 'mcp-server', name: 'remote', scope: 'user' },
    );
    const parsed = parseToml(r.newContent) as any;
    assert.equal(parsed.mcp_servers.remote.url, 'https://r.test/mcp');
    assert.equal(parsed.mcp_servers.remote.bearer_token_env_var, 'MY_TOKEN');
    assert.equal(parsed.mcp_servers.remote.http_headers['X-Extra'], '1');
  }),
);

test('codex writer: sse/ws transports are rejected', async () => {
  const a = new CodexAdapter(
    '/nonexistent/config.toml',
    '/nonexistent/_sk',
    '/nonexistent/_r.md',
    '/nonexistent/_shared',
  );
  await assert.rejects(
    a.renderInstall({ transport: 'sse', url: 'https://x' }, { kind: 'mcp-server', name: 's', scope: 'user' }),
    /not supported/,
  );
  await assert.rejects(
    a.renderInstall({ transport: 'ws', url: 'wss://x' }, { kind: 'mcp-server', name: 'w', scope: 'user' }),
    /not supported/,
  );
});

test(
  'codex writer: install round-trips through the engine and reader',
  withTempDir(async (dir) => {
    const toml = join(dir, 'config.toml');
    writeFileSync(toml, '# c\nmodel = "gpt-5.5"\n');
    const home = join(dir, 'fleet-home');
    const a = new CodexAdapter(toml, join(dir, '_sk'), join(dir, '_rules.md'), join(dir, '_shared'));
    const r = await a.renderInstall(
      { transport: 'stdio', command: 'npx', args: ['-y', 'srv'] },
      { kind: 'mcp-server', name: 'srv', scope: 'user' },
    );
    await applyChanges([toPlannedChange('codex', 'install', 'srv', 'user', r)], (_c, c) => a.validate(c), {
      fleetHome: home,
    });
    const items = await a.readInventory();
    assert.equal((items.find((i) => i.name === 'srv') as any)?.spec.transport, 'stdio');
    assert.match(readFileSync(toml, 'utf8'), /# c/); // comment survived a real write
  }),
);

// ---------------- Gemini (JSON) ----------------

test(
  'gemini writer: install into an absent file creates it',
  withTempDir(async (dir) => {
    const settings = join(dir, 'nested', 'settings.json'); // dir does not exist
    const home = join(dir, 'fleet-home');
    const a = new GeminiAdapter(settings);
    const r = await a.renderInstall(
      { transport: 'stdio', command: 'gcmd' },
      { kind: 'mcp-server', name: 'g', scope: 'user' },
    );
    assert.equal(r.baseHash, undefined); // no prior file
    await applyChanges([toPlannedChange('gemini', 'install', 'g', 'user', r)], (_c, c) => a.validate(c), {
      fleetHome: home,
    });
    assert.ok(existsSync(settings));
    const doc = JSON.parse(readFileSync(settings, 'utf8'));
    assert.equal(doc.mcpServers.g.command, 'gcmd');
  }),
);

test('gemini writer: transport mapping (http→httpUrl, sse→url) + bearer warning', async () => {
  const a = new GeminiAdapter('/nonexistent/settings.json');
  const http = await a.renderInstall(
    { transport: 'http', url: 'https://h.test' },
    { kind: 'mcp-server', name: 'h', scope: 'user' },
  );
  assert.equal((http.after as any).httpUrl, 'https://h.test');

  const sse = await a.renderInstall(
    { transport: 'sse', url: 'https://s.test' },
    { kind: 'mcp-server', name: 's', scope: 'user' },
  );
  assert.equal((sse.after as any).url, 'https://s.test');

  const bearer = await a.renderInstall(
    { transport: 'http', url: 'https://b.test', bearerTokenEnvVar: 'TOK' },
    { kind: 'mcp-server', name: 'b', scope: 'user' },
  );
  assert.match((bearer.after as any).headers.Authorization, /\$TOK/);
  assert.ok(bearer.warnings?.some((w) => /bearer/.test(w)));
});

test('gemini writer: ws transport is rejected', async () => {
  const a = new GeminiAdapter('/nonexistent/settings.json');
  await assert.rejects(
    a.renderInstall({ transport: 'ws', url: 'wss://x' }, { kind: 'mcp-server', name: 'w', scope: 'user' }),
    /not supported/,
  );
});

// ---------------- review #3 regressions ----------------

test(
  'codex writer: a commented adjacent table header is NOT eaten on remove (Critical)',
  withTempDir(async (dir) => {
    const toml = join(dir, 'config.toml');
    writeFileSync(
      toml,
      [
        '[mcp_servers.foo]',
        'command = "foo"',
        '',
        '[mcp_servers.bar]  # primary server',
        'command = "bar"',
        '',
        '[other]  # keep me',
        'x = 1',
        '',
      ].join('\n'),
    );
    const a = new CodexAdapter(toml, join(dir, '_sk'), join(dir, '_rules.md'), join(dir, '_shared'));
    const r = await a.renderRemove({ kind: 'mcp-server', name: 'foo', scope: 'user' });
    const parsed = parseToml(r.newContent) as any;
    assert.equal(parsed.mcp_servers?.foo, undefined);
    assert.equal(parsed.mcp_servers.bar.command, 'bar'); // adjacent commented-header table survived
    assert.equal(parsed.other.x, 1);
    assert.match(r.newContent, /# primary server/);
  }),
);

test(
  'codex writer: update preserves unmodeled keys (enabled=false not re-enabled)',
  withTempDir(async (dir) => {
    const toml = join(dir, 'config.toml');
    writeFileSync(
      toml,
      ['[mcp_servers.foo]', 'command = "old"', 'enabled = false', 'startup_timeout_sec = 30', ''].join('\n'),
    );
    const a = new CodexAdapter(toml, join(dir, '_sk'), join(dir, '_rules.md'), join(dir, '_shared'));
    const r = await a.renderInstall(
      { transport: 'stdio', command: 'new' },
      { kind: 'mcp-server', name: 'foo', scope: 'user' },
    );
    const parsed = parseToml(r.newContent) as any;
    assert.equal(parsed.mcp_servers.foo.command, 'new');
    assert.equal(parsed.mcp_servers.foo.enabled, false);
    assert.equal(Number(parsed.mcp_servers.foo.startup_timeout_sec), 30);
  }),
);

test(
  'gemini writer: update preserves unmodeled keys (trust/timeout)',
  withTempDir(async (dir) => {
    const settings = join(dir, 'settings.json');
    writeFileSync(
      settings,
      JSON.stringify({ mcpServers: { g: { command: 'old', trust: true, timeout: 5000 } } }, null, 2),
    );
    const a = new GeminiAdapter(settings);
    const r = await a.renderInstall(
      { transport: 'stdio', command: 'new' },
      { kind: 'mcp-server', name: 'g', scope: 'user' },
    );
    const after = r.after as any;
    assert.equal(after.command, 'new');
    assert.equal(after.trust, true);
    assert.equal(after.timeout, 5000);
  }),
);

test('gemini reader: bearer header round-trips to bearerTokenEnvVar', () => {
  const spec: any = parseGeminiEntry({
    httpUrl: 'https://b.test',
    headers: { Authorization: 'Bearer $TOK', 'X-Other': '1' },
  });
  assert.equal(spec.transport, 'http');
  assert.equal(spec.bearerTokenEnvVar, 'TOK');
  assert.equal(spec.headers?.Authorization, undefined);
  assert.equal(spec.headers?.['X-Other'], '1');
});

test(
  'gemini writer: remove on an absent config throws (no file creation)',
  withTempDir(async (dir) => {
    const settings = join(dir, 'nope.json');
    const a = new GeminiAdapter(settings);
    await assert.rejects(
      a.renderRemove({ kind: 'mcp-server', name: 'x', scope: 'user' }),
      /nothing to remove/,
    );
    assert.equal(existsSync(settings), false);
  }),
);
