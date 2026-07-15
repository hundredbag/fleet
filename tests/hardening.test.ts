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
  statSync,
  existsSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyChanges, rollback, type PlannedChange } from '../src/core/writer.js';
import { safeJoin, hashDir } from '../src/core/fsutil.js';
import { redactUrl, scrubSecrets } from '../src/core/redact.js';
import { removeRuleBlock, upsertRuleBlock, renderRuleInstall } from '../src/core/rules.js';
import { sha256 } from '../src/core/hash.js';

const noValidate = () => {};

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

test('apply: 0600 file keeps its mode through the atomic rewrite', async () => {
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
