import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, normalizeConfig, DEFAULT_CONFIG, fleetHomeDir, configPath } from '../src/core/config.js';

function withDir(body: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-cfg-'));
  try {
    body(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('loadConfig: missing file → defaults (no throw)', () => {
  withDir((dir) => {
    assert.deepEqual(loadConfig(dir), DEFAULT_CONFIG);
  });
});

test('loadConfig: valid file is normalized + merged onto defaults', () => {
  withDir((dir) => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ port: 8080, allowHosts: ['m.ts.net'], hubUrl: 'https://hub' }),
    );
    const c = loadConfig(dir);
    assert.equal(c.port, 8080);
    assert.deepEqual(c.allowHosts, ['m.ts.net']);
    assert.equal(c.hubUrl, 'https://hub');
    assert.equal(c.agents, null); // untouched default
  });
});

test('loadConfig: invalid JSON → defaults (no throw)', () => {
  withDir((dir) => {
    writeFileSync(join(dir, 'config.json'), '{ not valid');
    assert.deepEqual(loadConfig(dir), DEFAULT_CONFIG);
  });
});

test('normalizeConfig: rejects bad field types', () => {
  const c = normalizeConfig({ port: '8080', allowHosts: 'nope', agents: [1, 'codex'], feedSources: {} });
  assert.equal(c.port, DEFAULT_CONFIG.port); // string port ignored
  assert.deepEqual(c.allowHosts, []); // non-array ignored
  assert.deepEqual(c.agents, ['codex']); // non-strings filtered out
  assert.equal(c.feedSources, null); // non-array ignored
});

test('normalizeConfig: rejects out-of-range port', () => {
  assert.equal(normalizeConfig({ port: 0 }).port, DEFAULT_CONFIG.port);
  assert.equal(normalizeConfig({ port: 70000 }).port, DEFAULT_CONFIG.port);
});

test('normalizeConfig: non-object input → defaults (no throw)', () => {
  assert.deepEqual(normalizeConfig(42), DEFAULT_CONFIG);
  assert.deepEqual(normalizeConfig(null), DEFAULT_CONFIG);
  assert.deepEqual(normalizeConfig([1, 2]), DEFAULT_CONFIG);
});

test('normalizeConfig: all-invalid list keeps null default (not [])', () => {
  assert.equal(normalizeConfig({ agents: [1, 2] }).agents, null);
});

test('normalizeConfig: hubUrl must look like a URL', () => {
  assert.equal(normalizeConfig({ hubUrl: 'not a url' }).hubUrl, null);
  assert.equal(normalizeConfig({ hubUrl: 'https://hub.example' }).hubUrl, 'https://hub.example');
});

test('loadConfig: unreadable path (a directory) → defaults (no throw)', () => {
  withDir((dir) => {
    mkdirSync(join(dir, 'config.json')); // EISDIR on read
    assert.deepEqual(loadConfig(dir), DEFAULT_CONFIG);
  });
});

test('fleetHomeDir: empty string does not resolve cwd-relative', () => {
  assert.ok(fleetHomeDir('').endsWith('.fleet') || !!process.env.FLEET_HOME);
  assert.equal(configPath('/tmp/x'), '/tmp/x/config.json');
});
