import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  chmodSync,
  symlinkSync,
  lstatSync,
  readlinkSync,
  statSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  applyChanges,
  isRecoveryPendingError,
  readAuditLedger,
  rollback,
  type PlannedChange,
} from '../src/core/writer.js';
import { copyDir, safeJoin, hashDir, hashDirLegacy } from '../src/core/fsutil.js';
import {
  publicErrorCode,
  publicErrorMessage,
  publicRollbackReasonCode,
  isPublicCapabilityName,
  redactUrl,
  scrubPublicValue,
  scrubSecrets,
  summarizeInventory,
  summarizeResult,
} from '../src/core/redact.js';
import type { Inventory } from '../src/core/types.js';
import { removeRuleBlock, upsertRuleBlock, renderRuleInstall } from '../src/core/rules.js';
import { sha256 } from '../src/core/hash.js';

const noValidate = () => {};

test('public rollback reasons use one fixed classification across faces', () => {
  assert.equal(publicRollbackReasonCode('file diverged since fleet wrote it'), 'TARGET_DIVERGED');
  assert.equal(publicRollbackReasonCode('file already absent'), 'ALREADY_ABSENT');
  assert.equal(publicRollbackReasonCode('no recorded write-hash to verify against'), 'UNVERIFIABLE_TARGET');
  assert.equal(
    publicRollbackReasonCode('rollback succeeded but audit log write failed'),
    'AUDIT_WRITE_FAILED',
  );
  assert.equal(publicRollbackReasonCode('/home/alice/OPAQUE_REASON'), 'OPERATION_WARNING');
  assert.equal(publicRollbackReasonCode(undefined), undefined);
});

test('audit history rejects unknown decision-time trust evidence codes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-audit-trust-'));
  try {
    writeFileSync(
      join(dir, 'audit.jsonl'),
      JSON.stringify({
        id: '00000000-0000-4000-8000-000000000001',
        ts: 1,
        op: 'install',
        agent: 'codex',
        name: 'demo',
        kind: 'mcp-server',
        file: join(dir, 'config.json'),
        scope: 'user',
        backup: '',
        existedBefore: false,
        wroteHash: 'a'.repeat(64),
        trust: { level: 'caution', reasonCodes: ['NOT_A_TRUST_CODE'] },
      }) + '\n',
    );
    assert.equal((await readAuditLedger(dir)).status, 'malformed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('audit history rejects trust levels that contradict their stable reason codes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-audit-trust-invariant-'));
  try {
    const base = {
      id: '00000000-0000-4000-8000-000000000001',
      ts: 1,
      op: 'install',
      agent: 'codex',
      name: 'demo',
      kind: 'mcp-server',
      file: join(dir, 'config.json'),
      scope: 'user',
      backup: '',
      existedBefore: false,
      wroteHash: 'a'.repeat(64),
    };
    for (const trust of [
      { level: 'ok', reasonCodes: ['PACKAGE_UNPINNED'] },
      { level: 'caution', reasonCodes: [] },
    ]) {
      writeFileSync(join(dir, 'audit.jsonl'), JSON.stringify({ ...base, trust }) + '\n');
      assert.equal((await readAuditLedger(dir)).status, 'malformed');
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('public capability identity permits logical grouping but rejects path-shaped names', () => {
  for (const name of ['group/child', '@scope/pkg', 'mcp:foo', '한글 도구', '분류/도구']) {
    assert.equal(isPublicCapabilityName(name), true, name);
  }
  for (const name of [
    '~/.ssh/OPAQUE',
    '.ssh/OPAQUE',
    'C:OPAQUE_DRIVE_RELATIVE',
    'label /home/alice/OPAQUE',
    'label(/home/alice/OPAQUE_PUNCTUATION)',
    'label[C:\\Users\\alice\\OPAQUE_WINDOWS_PUNCTUATION]',
    'label ~/OPAQUE',
    '~alice/private/OPAQUE',
    '$HOME/private/OPAQUE',
    '%USERPROFILE%\\private\\OPAQUE',
    'label ./private/OPAQUE',
    'label .config/private/OPAQUE',
    '/home/alice/OPAQUE',
    'urn:name',
    'token=abcdef',
    'api_key=abcdef',
    'Bearer abcdefgh',
    'github_pat_abcdefghijklmnopqrstuvwxyz',
  ]) {
    assert.equal(isPublicCapabilityName(name), false, name);
  }
});

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'fleet-hard-'));
}

function fileChange(file: string, newContent: string, baseHash?: string): PlannedChange {
  return {
    agent: 'claude-code',
    op: 'update',
    name: 'x',
    scope: 'user',
    kind: 'mcp-server',
    file,
    newContent,
    baseHash,
  };
}

test(
  'apply preserves an incomplete marker when its pending namespace cannot be made durable',
  { skip: process.platform === 'win32' },
  async () => {
    const dir = tmp();
    const stateParent = join(dir, 'state');
    const home = join(stateParent, 'fleet');
    const file = join(dir, 'config.json');
    mkdirSync(home, { recursive: true });
    chmodSync(stateParent, 0o300);
    try {
      await assert.rejects(
        applyChanges([fileChange(file, '{"after":true}')], noValidate, { fleetHome: home }),
        /EACCES|permission denied/i,
      );
      assert.equal(existsSync(file), false);
    } finally {
      chmodSync(stateParent, 0o700);
    }
    try {
      await assert.rejects(rollback({ fleetHome: home }), /incomplete/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  'a target namespace fsync failure preserves an outcome-unknown marker',
  { skip: process.platform === 'win32' },
  async () => {
    const dir = tmp();
    const targetParent = join(dir, 'target');
    const file = join(targetParent, 'new.json');
    const home = join(dir, 'state', 'fleet');
    mkdirSync(targetParent, { recursive: true });
    chmodSync(targetParent, 0o300);
    let failure: unknown;
    try {
      await applyChanges([fileChange(file, '{"created":true}')], noValidate, { fleetHome: home });
    } catch (error) {
      failure = error;
    } finally {
      chmodSync(targetParent, 0o700);
    }
    try {
      assert.equal(isRecoveryPendingError(failure), true);
      assert.equal(readFileSync(file, 'utf8'), '{"created":true}');
      await assert.rejects(rollback({ fleetHome: home }), /incomplete/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

// ── P0-1: rollback integrity ────────────────────────────────────────────────

test('rollback: pre-existing file that diverged after fleet wrote it is SKIPPED', async () => {
  const dir = tmp();
  try {
    const home = join(dir, 'home');
    const f = join(dir, 'cfg.json');
    writeFileSync(f, '{"a":1}');
    await applyChanges([fileChange(f, '{"a":2}', sha256('{"a":1}'))], noValidate, { fleetHome: home });
    writeFileSync(f, '{"a":3}'); // third party edits AFTER fleet's write
    const r = await rollback({ fleetHome: home });
    assert.equal(r.action, 'skipped');
    assert.match(r.reason ?? '', /diverged/);
    assert.equal(readFileSync(f, 'utf8'), '{"a":3}'); // untouched
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rollback: same change cannot be rolled back twice via explicit id', async () => {
  const dir = tmp();
  try {
    const home = join(dir, 'home');
    const f = join(dir, 'cfg.json');
    writeFileSync(f, '{"a":1}');
    const [res] = await applyChanges([fileChange(f, '{"a":2}', sha256('{"a":1}'))], noValidate, {
      fleetHome: home,
    });
    const first = await rollback({ fleetHome: home, auditId: res!.auditId });
    assert.equal(first.action, 'restored');
    await assert.rejects(rollback({ fleetHome: home, auditId: res!.auditId }), /already rolled back/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rollback: a rollback record id is rejected as a target', async () => {
  const dir = tmp();
  try {
    const home = join(dir, 'home');
    const f = join(dir, 'cfg.json');
    writeFileSync(f, '{"a":1}');
    await applyChanges([fileChange(f, '{"a":2}', sha256('{"a":1}'))], noValidate, { fleetHome: home });
    await rollback({ fleetHome: home });
    const audit = readFileSync(join(home, 'audit.jsonl'), 'utf8').trim().split('\n');
    const rbRec = JSON.parse(audit[audit.length - 1]!);
    assert.equal(rbRec.op, 'rollback');
    await assert.rejects(rollback({ fleetHome: home, auditId: rbRec.id }), /rollback record/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── P0-2: absent-at-plan race + mode preservation ───────────────────────────

test('apply: target created after planning (baseHash undefined) is refused', async () => {
  const dir = tmp();
  try {
    const home = join(dir, 'home');
    const f = join(dir, 'cfg.json');
    // plan said "absent" (no baseHash) — then someone creates the file
    writeFileSync(f, '{"theirs":true}');
    await assert.rejects(
      applyChanges([fileChange(f, '{"mine":true}')], noValidate, { fleetHome: home }),
      /created after the plan/,
    );
    assert.equal(readFileSync(f, 'utf8'), '{"theirs":true}'); // untouched, no backup made
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply: 0600 file keeps its mode through the staged no-clobber rewrite', async () => {
  const dir = tmp();
  try {
    const home = join(dir, 'home');
    const f = join(dir, 'secrets.json');
    writeFileSync(f, '{"k":"v"}');
    chmodSync(f, 0o600);
    await applyChanges([fileChange(f, '{"k":"w"}', sha256('{"k":"v"}'))], noValidate, {
      fleetHome: home,
    });
    assert.equal(statSync(f).mode & 0o777, 0o600);
    assert.equal(readFileSync(f, 'utf8'), '{"k":"w"}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rollback treats a post-apply file mode change as divergence', async () => {
  const dir = tmp();
  try {
    const home = join(dir, 'home');
    const file = join(dir, 'secrets.json');
    writeFileSync(file, '{"state":"old"}');
    chmodSync(file, 0o600);
    await applyChanges([fileChange(file, '{"state":"new"}', sha256('{"state":"old"}'))], noValidate, {
      fleetHome: home,
    });
    chmodSync(file, 0o644);
    const result = await rollback({ fleetHome: home });
    assert.equal(result.action, 'skipped');
    assert.match(result.reason ?? '', /diverged/);
    assert.equal(statSync(file).mode & 0o777, 0o644);
    assert.equal(readFileSync(file, 'utf8'), '{"state":"new"}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply fails closed instead of replacing a symlinked config topology', async () => {
  const dir = tmp();
  try {
    const home = join(dir, 'home');
    const real = join(dir, 'real.json');
    const link = join(dir, 'config.json');
    writeFileSync(real, '{"state":"old"}');
    symlinkSync(real, link);
    await assert.rejects(
      applyChanges([fileChange(link, '{"state":"new"}', sha256('{"state":"old"}'))], noValidate, {
        fleetHome: home,
      }),
      /symbolic-link config/,
    );
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(readlinkSync(link), real);
    assert.equal(readFileSync(real, 'utf8'), '{"state":"old"}');
    assert.equal(
      existsSync(join(home, 'audit-pending')),
      false,
      'the symlink must be rejected before backup/audit preparation',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply fails closed instead of replacing a symlinked skill directory topology', async () => {
  const dir = tmp();
  try {
    const home = join(dir, 'home');
    const real = join(dir, 'real-skill');
    const link = join(dir, 'linked-skill');
    mkdirSync(real);
    writeFileSync(join(real, 'SKILL.md'), 'external');
    symlinkSync(real, link);
    const change: PlannedChange = {
      agent: 'claude-code',
      op: 'remove',
      name: 'linked-skill',
      scope: 'user',
      kind: 'skill',
      fsKind: 'dir',
      dirOp: 'remove',
      file: link,
      newContent: '',
      baseHash: await hashDir(real),
    };
    await assert.rejects(applyChanges([change], noValidate, { fleetHome: home }), /symbolic-link directory/);
    assert.equal(lstatSync(link).isSymbolicLink(), true);
    assert.equal(readFileSync(join(real, 'SKILL.md'), 'utf8'), 'external');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rollback treats a symlink topology swap as divergence even when target bytes match', async () => {
  const dir = tmp();
  try {
    const home = join(dir, 'home');
    const target = join(dir, 'config.json');
    const decoy = join(dir, 'decoy.json');
    writeFileSync(target, '{"state":"old"}');
    await applyChanges([fileChange(target, '{"state":"new"}', sha256('{"state":"old"}'))], noValidate, {
      fleetHome: home,
    });
    writeFileSync(decoy, '{"state":"new"}');
    rmSync(target);
    symlinkSync(decoy, target);
    const result = await rollback({ fleetHome: home });
    assert.equal(result.action, 'skipped');
    assert.equal(lstatSync(target).isSymbolicLink(), true);
    assert.equal(readFileSync(decoy, 'utf8'), '{"state":"new"}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('rollback refuses a modified directory backup before swapping the staged restore', async () => {
  const dir = tmp();
  try {
    const home = join(dir, 'home');
    const source = join(dir, 'source');
    const target = join(dir, 'target');
    mkdirSync(source);
    mkdirSync(target);
    writeFileSync(join(source, 'SKILL.md'), 'new');
    writeFileSync(join(target, 'SKILL.md'), 'old');
    const [applied] = await applyChanges(
      [
        {
          agent: 'claude-code',
          op: 'update',
          name: 'skill',
          scope: 'user',
          kind: 'skill',
          fsKind: 'dir',
          dirOp: 'install',
          file: target,
          sourceDir: source,
          sourceHash: await hashDir(source),
          baseHash: await hashDir(target),
          newContent: '',
        },
      ],
      noValidate,
      { fleetHome: home },
    );
    writeFileSync(join(applied!.backup, 'SKILL.md'), 'tampered');
    const result = await rollback({ fleetHome: home, auditId: applied!.auditId });
    assert.equal(result.action, 'skipped');
    assert.match(result.reason ?? '', /backup hash mismatch/);
    assert.equal(readFileSync(join(target, 'SKILL.md'), 'utf8'), 'new');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── P0-3: symlink containment + manifest hash ───────────────────────────────

test('safeJoin: symlinked subdirectory pointing outside the root is rejected', () => {
  const dir = tmp();
  try {
    const root = join(dir, 'skills');
    const outside = join(dir, 'outside');
    mkdirSync(root, { recursive: true });
    mkdirSync(outside, { recursive: true });
    symlinkSync(outside, join(root, 'evil'));
    assert.throws(() => safeJoin(root, 'evil/payload'), /resolves outside/);
    // a normal name under the same root still works
    assert.ok(safeJoin(root, 'good').startsWith(root));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hashDir: mode changes, symlink changes and empty dirs all alter the hash', async () => {
  const dir = tmp();
  try {
    const d = join(dir, 'skill');
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, 'SKILL.md'), 'hi');
    const h1 = await hashDir(d);
    chmodSync(join(d, 'SKILL.md'), 0o755); // mode-only change
    const h2 = await hashDir(d);
    assert.notEqual(h1, h2);
    mkdirSync(join(d, 'empty')); // empty-dir-only change
    const h3 = await hashDir(d);
    assert.notEqual(h2, h3);
    symlinkSync('SKILL.md', join(d, 'link')); // symlink-only change
    const h4 = await hashDir(d);
    assert.notEqual(h3, h4);
    const legacyBeforeRootMode = await hashDirLegacy(d);
    chmodSync(d, 0o700); // root-directory-only mode change
    const h5 = await hashDir(d);
    assert.notEqual(h4, h5);
    assert.equal(await hashDirLegacy(d), legacyBeforeRootMode);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('copyDir preserves file and directory modes while recreating symlinks without following them', async () => {
  const dir = tmp();
  try {
    const source = join(dir, 'source');
    const target = join(dir, 'target');
    mkdirSync(join(source, 'private'), { recursive: true });
    writeFileSync(join(source, 'private', 'tool.sh'), '#!/bin/sh\n');
    chmodSync(source, 0o750);
    chmodSync(join(source, 'private'), 0o710);
    chmodSync(join(source, 'private', 'tool.sh'), 0o640);
    symlinkSync('../private/tool.sh', join(source, 'tool-link'));

    await copyDir(source, target);

    assert.equal(statSync(target).mode & 0o777, 0o750);
    assert.equal(statSync(join(target, 'private')).mode & 0o777, 0o710);
    assert.equal(statSync(join(target, 'private', 'tool.sh')).mode & 0o777, 0o640);
    assert.equal(lstatSync(join(target, 'tool-link')).isSymbolicLink(), true);
    assert.equal(readlinkSync(join(target, 'tool-link')), '../private/tool.sh');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── P0-4: redaction fail-closed + output scrub ──────────────────────────────

test('redactUrl: malformed URL is replaced wholesale, fragment dropped', () => {
  assert.equal(redactUrl('ht!tp://bro ken?token=abc'), '[unparseable-url REDACTED]');
  assert.ok(!redactUrl('https://h.io/p#access_token=xyz').includes('xyz'));
  assert.ok(redactUrl('https://h.io/p?key=s3cret').includes('REDACTED'));
});

test('scrubSecrets: key=value, JWT, vendor-token shapes are removed', () => {
  const dirty = [
    'api_key: abc123def456',
    'Authorization: Bearer.secret',
    'jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N',
    'openai sk-abcdefghijklmnopqrstuvwx',
    'github ghp_ABCDEFGHIJKLMNOPQRSTuvwxyz012345',
    'push https://user:pass@github.com/x.git',
  ].join('\n');
  const clean = scrubSecrets(dirty);
  for (const leak of ['abc123def456', 'eyJhbGci', 'sk-abcdefghij', 'ghp_ABCDEFGHIJ', 'user:pass@'])
    assert.ok(!clean.includes(leak), `leaked: ${leak}`);
});

test('public boundary scrub recursively sanitizes free text and complete URLs', () => {
  const dirty = {
    note: 'detect failed: API_TOKEN=SUPERSECRET123',
    nested: [
      { warning: 'Authorization: Bearer abcdefghijklmnop' },
      'https://user:password@example.test/path?api_key=QUERYSECRET#fragment-secret',
      'file:///home/alice/OPAQUE_FILE_URL_SECRET',
      'file:/home/alice/OPAQUE_ONE_SLASH_SECRET',
      'data:text/plain,OPAQUE_DATA_SECRET',
      'mailto:OPAQUE_MAIL_SECRET@example.test',
      'urn:OPAQUE_URN_SECRET',
    ],
  };
  const clean = JSON.stringify(scrubPublicValue(dirty));
  for (const leak of [
    'SUPERSECRET123',
    'abcdefghijklmnop',
    'user',
    'password',
    'QUERYSECRET',
    'fragment-secret',
    'OPAQUE_FILE_URL_SECRET',
    'OPAQUE_ONE_SLASH_SECRET',
    'OPAQUE_DATA_SECRET',
    'OPAQUE_MAIL_SECRET',
    'OPAQUE_URN_SECRET',
  ]) {
    assert.equal(clean.includes(leak), false, `public value leaked: ${leak}`);
  }
  assert.match(clean, /REDACTED/);
  assert.equal(
    publicErrorMessage(new Error('adapter failed token=ERRORSECRET')),
    'adapter failed token=REDACTED',
  );
  assert.equal(publicErrorCode(new Error('credential is OPAQUE_ERROR_SECRET')), 'OPERATION_FAILED');
  assert.equal(publicErrorCode(new Error('TARGET_UNAVAILABLE')), 'TARGET_UNAVAILABLE');
  assert.equal(publicErrorCode(new Error('fleet: recovery pending at OPAQUE_PATH')), 'RECOVERY_PENDING');
});

test('inventory summary scrubs adapter and capability free text', () => {
  const inventory: Inventory = {
    agents: [
      {
        id: 'third-party',
        displayName: 'Third Party',
        present: false,
        configPaths: [],
        inventoryStatus: 'detect-failed',
        note: 'detect error: API_TOKEN=AGENTSECRET',
      },
    ],
    items: [
      {
        kind: 'skill',
        name: 'review',
        agent: 'third-party',
        scope: 'user',
        enabled: true,
        source: { file: '/private/source' },
        path: '/private/skill',
        meta: { description: 'credential is OPAQUE_SKILL_DESCRIPTION' },
        raw: { API_TOKEN: 'RAWSECRET' },
      },
      {
        kind: 'permission',
        name: 'Bash(--credential OPAQUE_PERMISSION_7429 --path /home/alice/private)',
        agent: 'third-party',
        scope: 'user',
        enabled: true,
        effect: 'allow',
        source: { file: '/private/settings.json' },
      },
    ],
  };
  const summary = JSON.stringify(summarizeInventory(inventory));
  for (const leak of [
    'AGENTSECRET',
    'OPAQUE_SKILL_DESCRIPTION',
    '/private/source',
    '/private/skill',
    'RAWSECRET',
    'OPAQUE_PERMISSION_7429',
    '/home/alice/private',
  ]) {
    assert.equal(summary.includes(leak), false, `inventory summary leaked: ${leak}`);
  }
  assert.match(summary, /"effect":"allow","count":1/);
});

test('inventory summary keeps validated plugin marketplace coordinates distinct', () => {
  const inventory: Inventory = {
    agents: [
      {
        id: 'codex',
        displayName: 'Codex',
        present: true,
        configPaths: [],
        inventoryStatus: 'ok',
      },
    ],
    items: ['first', 'second'].map((marketplace) => ({
      kind: 'plugin' as const,
      name: 'shared',
      marketplace,
      agent: 'codex',
      scope: 'user' as const,
      enabled: true,
      source: { file: 'fixture' },
    })),
  };
  assert.deepEqual(summarizeInventory(inventory).plugins, [
    { name: 'shared', agent: 'codex', marketplace: 'first', enabled: true },
    { name: 'shared', agent: 'codex', marketplace: 'second', enabled: true },
  ]);
});

test('public boundary drops serialization hooks, accessors, functions, and secret-bearing keys', () => {
  const nested = Object.create(null) as Record<string, unknown>;
  nested.safe = 'visible';
  nested.toJSON = () => ({ leak: 'OPAQUE_TOJSON_SECRET' });
  nested['API_TOKEN=OPAQUE_KEY_SECRET'] = 'ignored';
  Object.defineProperty(nested, 'credential', {
    enumerable: true,
    get: () => 'OPAQUE_GETTER_SECRET',
  });
  const serialized = JSON.stringify(scrubPublicValue({ nested }));
  assert.equal(serialized, '{"nested":{"safe":"visible"}}');
  for (const leak of ['OPAQUE_TOJSON_SECRET', 'OPAQUE_KEY_SECRET', 'OPAQUE_GETTER_SECRET', 'toJSON']) {
    assert.equal(serialized.includes(leak), false);
  }
});

test('public boundary ignores overridden array methods and terminates cyclic arrays', () => {
  const hostile: unknown[] = ['safe'];
  (hostile as unknown as Record<string, unknown>).map = () => ({
    toJSON: () => ({ leak: 'OPAQUE_CUSTOM_MAP' }),
  });
  const cyclic: unknown[] = [];
  cyclic.push(cyclic);
  const serialized = JSON.stringify(scrubPublicValue({ hostile, cyclic }));
  assert.equal(serialized.includes('OPAQUE_CUSTOM_MAP'), false);
  assert.match(serialized, /"hostile":\["safe"\]/);
  assert.match(serialized, /cyclic-value REDACTED/);
});

test('execute summary omits file paths and scrubs warnings, skips, and errors', () => {
  const summary = summarizeResult({
    committed: true,
    applied: [],
    changes: [
      {
        agent: 'third-party',
        op: 'install',
        name: 'demo',
        scope: 'user',
        kind: 'mcp-server',
        file: '/private/config.json',
        newContent: 'raw secret body',
        warnings: ['API_TOKEN=WARNINGSECRET'],
      },
    ],
    skips: [{ agent: 'third-party', kind: 'error', reason: 'password=SKIPSECRET' }],
    error: 'Authorization: Bearer error-secret-token',
    lockWarning: 'api_key=LOCKSECRET',
  });
  const serialized = JSON.stringify(summary);
  for (const leak of [
    '/private/config.json',
    'raw secret body',
    'WARNINGSECRET',
    'SKIPSECRET',
    'error-secret-token',
    'LOCKSECRET',
  ]) {
    assert.equal(serialized.includes(leak), false, `execute summary leaked: ${leak}`);
  }
  assert.equal(Object.hasOwn(summary.changes[0]!, 'file'), false);
  assert.equal(Object.hasOwn(summary.skips[0]!, 'reason'), false);
  assert.equal(Object.hasOwn(summary, 'error'), false);
});

test('execute summary withholds path-shaped logical names adjacent to punctuation', () => {
  const marker = 'OPAQUE_RESULT_PUNCTUATION_PATH';
  const summary = summarizeResult({
    committed: false,
    applied: [],
    changes: [
      {
        agent: 'claude-code',
        op: 'install',
        name: `label(/home/alice/${marker})`,
        scope: 'user',
        kind: 'mcp-server',
        file: '/private/config.json',
        newContent: '{}',
      },
    ],
    skips: [],
  });
  assert.equal(JSON.stringify(summary).includes(marker), false);
  assert.equal(summary.changes.length, 0);
  assert.equal(summary.withheldChanges, 1);
});

test('execute summary distinguishes an applied mutation whose audit record failed', () => {
  const change: PlannedChange = {
    agent: 'claude-code',
    op: 'install',
    name: 'safe-name',
    scope: 'user',
    file: '/private/config.json',
    newContent: '{}',
  };
  const summary = summarizeResult({
    committed: true,
    changes: [change],
    skips: [],
    applied: [
      {
        change,
        auditId: '00000000-0000-4000-8000-000000000001',
        auditRecorded: false,
        backup: '',
        wroteHash: 'a'.repeat(64),
      },
    ],
    failedAfter: 1,
    error: 'audit log write failed at /home/alice/OPAQUE',
  });
  assert.equal(summary.status, 'partial');
  assert.equal(summary.applied, 1);
  assert.equal(summary.auditRecorded, 0);
  assert.equal(summary.unrecordedApplied, 1);
  assert.equal(summary.errorCode, 'AUDIT_WRITE_FAILED');
  assert.equal(summary.recoveryClass, 'manual-config-recovery');
  assert.deepEqual(summary.records, [
    {
      agent: 'claude-code',
      kind: 'mcp-server',
      name: 'safe-name',
      scope: 'user',
      op: 'install',
      auditRecorded: false,
    },
  ]);
  assert.equal(JSON.stringify(summary).includes('OPAQUE'), false);
});

test('execute summary reports recovery-pending mutations as outcome unknown', () => {
  const summary = summarizeResult({
    committed: true,
    changes: [],
    skips: [],
    applied: [],
    failedAfter: 0,
    error: 'fleet: original preserved at /home/alice/OPAQUE; recovery pending',
    recoveryPending: true,
  });
  assert.equal(summary.status, 'outcome-unknown');
  assert.equal(summary.errorCode, 'RECOVERY_PENDING');
  assert.equal(summary.recoveryClass, 'manual-config-recovery');
  assert.equal(JSON.stringify(summary).includes('OPAQUE'), false);
});

// ── P0-5: rule human-content byte preservation ──────────────────────────────

test('removeRuleBlock: human triple-newlines and spacing survive removal', () => {
  const human = '# Title\n\n\nSpaced   section\n\n\n\nEnd';
  const withBlock = upsertRuleBlock(human, 'r1', 'body');
  const after = removeRuleBlock(withBlock, 'r1');
  assert.ok(after.startsWith(human)); // human bytes untouched (incl. \n\n\n runs)
});

test('renderRuleInstall: internal blank lines and trailing spaces in human text preserved', async () => {
  const dir = tmp();
  try {
    const f = join(dir, 'CLAUDE.md');
    const human = 'line with trailing spaces   \n\n\nmore\n';
    writeFileSync(f, human);
    const r = await renderRuleInstall(f, 'be nice', { name: 'tone', kind: 'rule', scope: 'user' });
    assert.ok(r.newContent.startsWith(human)); // byte-identical prefix
    assert.ok(existsSync(f));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── dual-review round-2 regressions ─────────────────────────────────────────

test('scrubSecrets: Bearer header VALUE and compound env keys are redacted', () => {
  const dirty = [
    'Authorization: Bearer my.super.secret.token',
    'AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI1234567890',
    'OPENAI_API_KEY: sk-live-abcdef',
    'export GITHUB_TOKEN=hunter2hunter2',
  ].join('\n');
  const clean = scrubSecrets(dirty);
  for (const leak of ['my.super.secret.token', 'wJalrXUtnFEMI', 'sk-live-abcdef', 'hunter2'])
    assert.ok(!clean.includes(leak), `leaked: ${leak}`);
});

test('rollback: pre-existing file DELETED by the user is not resurrected', async () => {
  const dir = tmp();
  try {
    const home = join(dir, 'home');
    const f = join(dir, 'cfg.json');
    writeFileSync(f, '{"a":1}');
    await applyChanges([fileChange(f, '{"a":2}', sha256('{"a":1}'))], noValidate, { fleetHome: home });
    rmSync(f); // user deliberately deletes the file after fleet wrote it
    const r = await rollback({ fleetHome: home });
    assert.equal(r.action, 'skipped');
    assert.equal(existsSync(f), false); // NOT resurrected
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply: dir REMOVE without baseHash against an existing target is refused', async () => {
  const dir = tmp();
  try {
    const home = join(dir, 'home');
    const target = join(dir, 'skill');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'SKILL.md'), 'x');
    const change: PlannedChange = {
      agent: 'claude-code',
      op: 'remove',
      name: 'skill',
      scope: 'user',
      kind: 'skill',
      fsKind: 'dir',
      dirOp: 'remove',
      file: target,
      newContent: '',
    };
    await assert.rejects(applyChanges([change], noValidate, { fleetHome: home }), /created after the plan/);
    assert.ok(existsSync(join(target, 'SKILL.md'))); // untouched
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('safeJoin: DANGLING symlink below the root is rejected (no-follow)', () => {
  const dir = tmp();
  try {
    const root = join(dir, 'skills');
    mkdirSync(root, { recursive: true });
    symlinkSync(join(dir, 'does-not-exist-yet'), join(root, 'ghost'));
    assert.throws(() => safeJoin(root, 'ghost/payload'), /resolves outside/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hashDir: crafted filename cannot collide with a different tree (unambiguous manifest)', async () => {
  const dir = tmp();
  try {
    const a = join(dir, 'a');
    const b = join(dir, 'b');
    // tree A: one empty dir with a hostile name embedding a fake manifest line
    mkdirSync(join(a, 'x\nL y -> z'), { recursive: true });
    // tree B: empty dir "x" + symlink y -> z (what the hostile name spoofs)
    mkdirSync(join(b, 'x'), { recursive: true });
    symlinkSync('z', join(b, 'y'));
    assert.notEqual(await hashDir(a), await hashDir(b));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('apply: skill source edited between plan and apply is refused (sourceHash pin)', async () => {
  const dir = tmp();
  try {
    const home = join(dir, 'home');
    const src = join(dir, 'src-skill');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'SKILL.md'), 'planned content');
    const { renderSkillInstall } = await import('../src/core/skills.js');
    const r = await renderSkillInstall(
      join(dir, 'root'),
      { name: 'sk', dir: src },
      { name: 'sk', kind: 'skill', scope: 'user' },
    );
    writeFileSync(join(src, 'SKILL.md'), 'TAMPERED after preview');
    const change: PlannedChange = { ...r, agent: 'claude-code', op: 'install', name: 'sk', scope: 'user' };
    await assert.rejects(applyChanges([change], noValidate, { fleetHome: home }), /changed since the plan/);
    assert.equal(existsSync(join(dir, 'root', 'sk')), false); // nothing installed
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
