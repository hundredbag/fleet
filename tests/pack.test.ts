import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readPack, readPackRuleBody } from '../src/core/pack.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'fleet-pack-'));
}

test('pack: manifest with skills + variant rules; variant fallback works', async () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, 'tdd'), { recursive: true });
    writeFileSync(join(dir, 'tdd', 'SKILL.md'), '# tdd');
    writeFileSync(join(dir, 'clean-code-full.md'), 'FULL BODY');
    writeFileSync(join(dir, 'clean-code-nano.md'), 'NANO BODY');
    writeFileSync(
      join(dir, 'pack.json'),
      JSON.stringify({
        name: 'books',
        skills: ['tdd'],
        rules: [{ name: 'clean-code', variants: { full: 'clean-code-full.md', nano: 'clean-code-nano.md' } }],
      }),
    );
    const pack = await readPack(dir);
    assert.equal(pack.name, 'books');
    assert.deepEqual(pack.skills, ['tdd']);
    // requested mini → falls back to nano (closest smaller)
    const r = await readPackRuleBody(dir, pack.rules[0]!, 'mini');
    assert.equal(r.usedVariant, 'nano');
    assert.equal(r.body, 'NANO BODY');
    const f = await readPackRuleBody(dir, pack.rules[0]!, 'full');
    assert.equal(f.body, 'FULL BODY');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pack: manifest-less skills monorepo checkout — every skill dir is content', async () => {
  const dir = tmp();
  try {
    for (const name of ['grill-me', 'handoff']) {
      mkdirSync(join(dir, name), { recursive: true });
      writeFileSync(join(dir, name, 'SKILL.md'), `# ${name}`);
    }
    const pack = await readPack(dir);
    assert.deepEqual(pack.skills.sort(), ['grill-me', 'handoff']);
    assert.deepEqual(pack.rules, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('pack: variant path traversal and symlinks are rejected; in-pack file works', async () => {
  const { symlinkSync } = await import('node:fs');
  const dir = tmp();
  const outside = mkdtempSync(join(tmpdir(), 'fleet-outside-'));
  try {
    writeFileSync(join(outside, 'evil.md'), 'EVIL ALWAYS-ON RULE');
    writeFileSync(join(dir, 'good.md'), 'GOOD');
    symlinkSync(join(outside, 'evil.md'), join(dir, 'link.md'));
    const rule = {
      name: 'r',
      variants: {
        full: '../' + outside.split('/').pop()! + '/evil.md', // traversal
        mini: 'link.md', // symlink
        nano: 'good.md', // legit
      },
    };
    const r = await readPackRuleBody(dir, rule, 'full');
    assert.equal(r.body, 'GOOD'); // traversal AND symlink skipped → nano fallback
    assert.equal(r.usedVariant, 'nano');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('pack: INTERMEDIATE symlinked dir cannot smuggle outside content (safeJoin reuse)', async () => {
  const { symlinkSync } = await import('node:fs');
  const dir = tmp();
  const outside = mkdtempSync(join(tmpdir(), 'fleet-out2-'));
  try {
    writeFileSync(join(outside, 'bashrc.md'), 'OUTSIDE CONTENT');
    symlinkSync(outside, join(dir, 'sub')); // dir-level symlink INSIDE the pack
    writeFileSync(join(dir, 'safe.md'), 'SAFE');
    const rule = { name: 'r', variants: { full: 'sub/bashrc.md', nano: 'safe.md' } };
    const r = await readPackRuleBody(dir, rule, 'full');
    assert.equal(r.body, 'SAFE'); // intermediate-symlink variant skipped
    assert.equal(r.usedVariant, 'nano');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test('pack: nested skill source cannot cross an intermediate symlink', async () => {
  const { symlinkSync } = await import('node:fs');
  const dir = tmp();
  const outside = mkdtempSync(join(tmpdir(), 'fleet-pack-private-'));
  try {
    mkdirSync(join(outside, 'secretproject'));
    writeFileSync(join(outside, 'secretproject', 'SKILL.md'), '# private content');
    symlinkSync(outside, join(dir, 'group'));
    writeFileSync(
      join(dir, 'pack.json'),
      JSON.stringify({ name: 'hostile', skills: ['group/secretproject'], rules: [] }),
    );
    await assert.rejects(readPack(dir), /symlink|outside the target root/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
