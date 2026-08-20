import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  assertMutationConfigReadable,
  loadConfig,
  normalizeConfig,
  DEFAULT_CONFIG,
  fleetHomeDir,
  configPath,
  teamPolicyPath,
  readTeamPolicyState,
  readEffectiveConfigState,
  parseTrustPolicyOverride,
} from '../src/core/config.js';

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
    let diagnostic = '';
    const original = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      diagnostic += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      assert.deepEqual(loadConfig(dir), DEFAULT_CONFIG);
    } finally {
      process.stderr.write = original;
    }
    assert.equal(diagnostic, 'fleet: CONFIG_INVALID; using defaults\n');
    assert.equal(diagnostic.includes(dir), false);
  });
});

test('normalizeConfig: rejects bad field types', () => {
  const c = normalizeConfig({ port: '8080', allowHosts: 'nope', agents: [1, 'codex'], feedSources: {} });
  assert.equal(c.port, DEFAULT_CONFIG.port); // string port ignored
  assert.deepEqual(c.allowHosts, []); // non-array ignored
  assert.deepEqual(c.agents, ['codex']); // non-strings filtered out
  assert.equal(c.feedSources, null); // non-array ignored
});

test('parseTrustPolicyOverride: rejects misspelled or valueless explicit flags', () => {
  assert.equal(parseTrustPolicyOverride(undefined), undefined);
  assert.equal(parseTrustPolicyOverride('warn'), 'warn');
  assert.equal(parseTrustPolicyOverride('block'), 'block');
  assert.throws(() => parseTrustPolicyOverride('blok'), /must be 'warn' or 'block'/);
  assert.throws(() => parseTrustPolicyOverride(true), /must be 'warn' or 'block'/);
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

test('normalizeConfig: explicit empty lists preserve none semantics', () => {
  const config = normalizeConfig({ agents: [], feedSources: [] });
  assert.deepEqual(config.agents, []);
  assert.deepEqual(config.feedSources, []);
});

test('normalizeConfig: hubUrl must look like a URL', () => {
  assert.equal(normalizeConfig({ hubUrl: 'not a url' }).hubUrl, null);
  assert.equal(normalizeConfig({ hubUrl: 'https://hub.example' }).hubUrl, 'https://hub.example');
});

test('loadConfig: unreadable path (a directory) → defaults (no throw)', () => {
  withDir((dir) => {
    mkdirSync(join(dir, 'config.json')); // EISDIR on read
    let diagnostic = '';
    const original = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      diagnostic += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      assert.deepEqual(loadConfig(dir), DEFAULT_CONFIG);
    } finally {
      process.stderr.write = original;
    }
    assert.equal(diagnostic, 'fleet: CONFIG_READ_FAILED; using defaults\n');
    assert.equal(diagnostic.includes(dir), false);
  });
});

test('mutation config guard allows absence but rejects malformed and unreadable config', () => {
  withDir((dir) => {
    assert.deepEqual(assertMutationConfigReadable(dir), DEFAULT_CONFIG);
    writeFileSync(join(dir, 'config.json'), '{ truncated');
    assert.throws(() => assertMutationConfigReadable(dir), /CONFIG_INVALID/);
    rmSync(join(dir, 'config.json'));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ trustPolicy: 'blok', port: '7777' }));
    assert.throws(() => assertMutationConfigReadable(dir), /CONFIG_INVALID/);
    rmSync(join(dir, 'config.json'));
    mkdirSync(join(dir, 'config.json'));
    assert.throws(() => assertMutationConfigReadable(dir), /CONFIG_READ_FAILED/);
  });
});

test('mutation config guard never treats a dangling policy symlink as missing', () => {
  withDir((dir) => {
    symlinkSync(join(dir, 'missing-policy.json'), join(dir, 'config.json'));
    assert.throws(() => assertMutationConfigReadable(dir), /CONFIG_READ_FAILED/);
  });
});

test('team policy v1 only narrows user preferences and strengthens trust enforcement', () => {
  withDir((dir) => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({
        agents: ['claude-code', 'codex', 'custom'],
        feedSources: ['mcp-registry', 'skills.sh'],
        adapterModules: ['./custom.js'],
        trustPolicy: 'warn',
      }),
    );
    writeFileSync(
      join(dir, 'team-policy.json'),
      JSON.stringify({
        version: 1,
        agents: ['codex', 'custom'],
        feedSources: ['mcp-registry'],
        trustPolicy: 'block',
        allowAdapterModules: false,
      }),
    );
    const effective = readEffectiveConfigState(dir);
    assert.equal(effective.policyState.status, 'ok');
    assert.deepEqual(effective.config.agents, ['codex', 'custom']);
    assert.deepEqual(effective.config.feedSources, ['mcp-registry']);
    assert.deepEqual(effective.config.adapterModules, []);
    assert.equal(effective.config.trustPolicy, 'block');
    assert.deepEqual(assertMutationConfigReadable(dir), effective.config);
  });
});

test('team policy cannot weaken a user block policy and null leaves list preferences intact', () => {
  withDir((dir) => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({
        agents: ['codex'],
        feedSources: [],
        trustPolicy: 'block',
        adapterModules: ['./not-opted-in.js'],
      }),
    );
    writeFileSync(join(dir, 'team-policy.json'), JSON.stringify({ version: 1, trustPolicy: 'warn' }));
    const config = loadConfig(dir);
    assert.deepEqual(config.agents, ['codex']);
    assert.deepEqual(config.feedSources, []);
    assert.deepEqual(config.adapterModules, []);
    assert.equal(config.trustPolicy, 'block');
  });
});

test('damaged team policy blocks mutation and makes read-only activation fail closed', () => {
  withDir((dir) => {
    writeFileSync(
      join(dir, 'config.json'),
      JSON.stringify({ agents: null, feedSources: null, adapterModules: ['./custom.js'] }),
    );
    writeFileSync(join(dir, 'team-policy.json'), JSON.stringify({ version: 2, unknown: true }));
    assert.equal(readTeamPolicyState(dir).status, 'invalid');
    let diagnostic = '';
    const original = process.stderr.write;
    process.stderr.write = ((chunk: string | Uint8Array) => {
      diagnostic += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    let config;
    try {
      config = loadConfig(dir);
    } finally {
      process.stderr.write = original;
    }
    assert.deepEqual(config.agents, []);
    assert.deepEqual(config.feedSources, []);
    assert.deepEqual(config.adapterModules, []);
    assert.equal(config.trustPolicy, 'block');
    assert.equal(diagnostic, 'fleet: TEAM_POLICY_INVALID; using fail-closed limits\n');
    assert.throws(() => assertMutationConfigReadable(dir), /TEAM_POLICY_INVALID/);
  });
});

test('team policy leaf is regular and no-follow, including dangling symlinks', () => {
  withDir((dir) => {
    symlinkSync(join(dir, 'missing-team-policy.json'), join(dir, 'team-policy.json'));
    assert.equal(readTeamPolicyState(dir).status, 'read-failed');
    assert.throws(() => assertMutationConfigReadable(dir), /TEAM_POLICY_READ_FAILED/);
  });
});

test(
  'config and team policy reject FIFO leaves without blocking on open',
  { skip: process.platform === 'win32' },
  (t) => {
    withDir((dir) => {
      for (const name of ['config.json', 'team-policy.json']) {
        try {
          execFileSync('mkfifo', [join(dir, name)]);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'EPERM') {
            t.skip('sandbox forbids creating FIFO fixtures');
            return;
          }
          throw error;
        }
      }
      assert.equal(readEffectiveConfigState(dir).configState.status, 'read-failed');
      assert.equal(readEffectiveConfigState(dir).policyState.status, 'read-failed');
      assert.throws(() => assertMutationConfigReadable(dir), /CONFIG_READ_FAILED/);
    });
  },
);

test('fleetHomeDir: empty string does not resolve cwd-relative', () => {
  assert.ok(fleetHomeDir('').endsWith('.fleet') || !!process.env.FLEET_HOME);
  assert.equal(configPath('/tmp/x'), '/tmp/x/config.json');
  assert.equal(teamPolicyPath('/tmp/x'), '/tmp/x/team-policy.json');
});
