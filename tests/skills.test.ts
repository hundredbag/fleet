import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  symlinkSync,
  lstatSync,
  readlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import {
  applyChanges,
  rollback,
  readAudit,
  type ChangeValidator,
  type PlannedChange,
} from '../src/core/writer.js';
import { listSkillDirs, parseSkillFrontmatter } from '../src/core/skills.js';
import { hashDir, copyDir } from '../src/core/fsutil.js';
import { planInstallSkill, planSyncSkill, planRemoveSkill, applyPlan } from '../src/core/orchestrator.js';

const noValidate: ChangeValidator = () => {};

function mkSkill(root: string, name: string, body = 'hello'): string {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: "${name} desc"\nversion: 1.0.0\n---\n${body}\n`,
  );
  return dir;
}

function dirChange(file: string, sourceDir: string, baseHash?: string): PlannedChange {
  return {
    agent: 'x',
    op: 'install',
    name: 'mine',
    scope: 'user',
    file,
    fsKind: 'dir',
    dirOp: 'install',
    sourceDir,
    newContent: '',
    baseHash,
  };
}

function withTempDir(fn: (dir: string) => void | Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-sk-'));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

test('parseSkillFrontmatter reads description/version', () => {
  const m = parseSkillFrontmatter('---\nname: x\ndescription: "hi there"\nversion: 2.1\n---\nbody');
  assert.equal(m.description, 'hi there');
  assert.equal(m.version, '2.1');
});

test(
  'listSkillDirs handles flat + grouped layouts and skips dotted dirs',
  withTempDir(async (dir) => {
    const root = join(dir, 'skills');
    mkdirSync(root);
    mkSkill(root, 'flat');
    mkdirSync(join(root, 'grp'));
    writeFileSync(join(root, 'grp', 'DESCRIPTION.md'), 'group');
    mkSkill(join(root, 'grp'), 'child');
    mkdirSync(join(root, '.system'));
    mkSkill(join(root, '.system'), 'builtin');
    const names = (await listSkillDirs(root)).map((d) => d.name);
    assert.deepEqual(names, ['flat', 'grp/child']); // .system skipped
  }),
);

test(
  'engine: dir install creates the skill + records an isDir audit',
  withTempDir(async (dir) => {
    const src = mkSkill(dir, 'src', 'v1');
    const home = join(dir, 'home');
    const target = join(dir, 'agentskills', 'mine');
    await applyChanges([dirChange(target, src)], noValidate, { fleetHome: home });
    assert.ok(existsSync(join(target, 'SKILL.md')));
    assert.match(readFileSync(join(target, 'SKILL.md'), 'utf8'), /v1/);
    assert.equal((await readAudit(home))[0]?.isDir, true);
  }),
);

test(
  'engine: dir replace backs up; rollback restores the prior dir',
  withTempDir(async (dir) => {
    const home = join(dir, 'home');
    const target = join(dir, 't', 'mine');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'SKILL.md'), 'OLD');
    const src = mkSkill(dir, 'src', 'NEW');
    await applyChanges([dirChange(target, src, await hashDir(target))], noValidate, { fleetHome: home });
    assert.match(readFileSync(join(target, 'SKILL.md'), 'utf8'), /NEW/);
    const r = await rollback({ fleetHome: home });
    assert.equal(r.action, 'restored');
    assert.equal(readFileSync(join(target, 'SKILL.md'), 'utf8'), 'OLD');
  }),
);

test(
  'engine: rollback removes a fleet-created skill dir',
  withTempDir(async (dir) => {
    const home = join(dir, 'home');
    const src = mkSkill(dir, 'src');
    const target = join(dir, 't', 'mine');
    await applyChanges([dirChange(target, src)], noValidate, { fleetHome: home });
    assert.ok(existsSync(target));
    const r = await rollback({ fleetHome: home });
    assert.equal(r.action, 'removed');
    assert.equal(existsSync(target), false);
  }),
);

test(
  'engine: dir install refuses a source without SKILL.md (no clobber)',
  withTempDir(async (dir) => {
    const home = join(dir, 'home');
    const badSrc = join(dir, 'bad');
    mkdirSync(badSrc);
    writeFileSync(join(badSrc, 'README'), 'x');
    const target = join(dir, 't', 'mine');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'SKILL.md'), 'KEEP');
    await assert.rejects(
      applyChanges([dirChange(target, badSrc, await hashDir(target))], noValidate, { fleetHome: home }),
      /SKILL\.md/,
    );
    assert.equal(readFileSync(join(target, 'SKILL.md'), 'utf8'), 'KEEP'); // untouched
  }),
);

test(
  'engine: dir hash-guard refuses if the target changed since the plan',
  withTempDir(async (dir) => {
    const home = join(dir, 'home');
    const target = join(dir, 't', 'mine');
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, 'SKILL.md'), 'A');
    const stale = await hashDir(target);
    writeFileSync(join(target, 'SKILL.md'), 'B'); // concurrent change after plan
    const src = mkSkill(dir, 'src');
    await assert.rejects(
      applyChanges([dirChange(target, src, stale)], noValidate, { fleetHome: home }),
      /changed since the plan/,
    );
    assert.equal(readFileSync(join(target, 'SKILL.md'), 'utf8'), 'B'); // untouched
  }),
);

test(
  'engine: dir install preserves binary resource files',
  withTempDir(async (dir) => {
    const home = join(dir, 'home');
    const src = mkSkill(dir, 'binsk');
    writeFileSync(join(src, 'img.bin'), Buffer.from([0, 1, 2, 255, 254]));
    const target = join(dir, 't', 'binsk');
    await applyChanges([dirChange(target, src)], noValidate, { fleetHome: home });
    assert.deepEqual([...readFileSync(join(target, 'img.bin'))], [0, 1, 2, 255, 254]);
  }),
);

test(
  'skill render rejects path-traversal names (containment)',
  withTempDir(async (dir) => {
    const a = new ClaudeCodeAdapter(join(dir, '.claude.json'), join(dir, 'skills'));
    const src = mkSkill(dir, 'ok');
    await assert.rejects(
      a.renderInstallSkill(
        { name: '../escape', dir: src },
        { kind: 'skill', name: '../escape', scope: 'user' },
      ),
      /escapes|invalid/,
    );
    await assert.rejects(
      a.renderRemoveSkill({ kind: 'skill', name: '../../etc', scope: 'user' }),
      /escapes|invalid/,
    );
  }),
);

test(
  'copyDir preserves symlinks and empty directories',
  withTempDir(async (dir) => {
    const src = join(dir, 'src');
    mkdirSync(src);
    writeFileSync(join(src, 'file.txt'), 'hi');
    symlinkSync('file.txt', join(src, 'link'));
    mkdirSync(join(src, 'emptyd'));
    const dst = join(dir, 'dst');
    await copyDir(src, dst);
    assert.equal(readFileSync(join(dst, 'file.txt'), 'utf8'), 'hi');
    assert.ok(lstatSync(join(dst, 'link')).isSymbolicLink());
    assert.equal(readlinkSync(join(dst, 'link')), 'file.txt');
    assert.ok(lstatSync(join(dst, 'emptyd')).isDirectory());
  }),
);

test(
  'adapter: readInventory includes skills with parsed frontmatter',
  withTempDir(async (dir) => {
    const skills = join(dir, 'skills');
    mkdirSync(skills);
    mkSkill(skills, 'alpha');
    const a = new ClaudeCodeAdapter(join(dir, '.claude.json'), skills);
    const sk = (await a.readInventory()).find((i) => i.kind === 'skill' && i.name === 'alpha');
    assert.ok(sk);
    if (sk && sk.kind === 'skill') assert.equal(sk.meta?.description, 'alpha desc');
  }),
);

test(
  'orchestrator: skill install fan-out, idempotent re-install, sync, remove',
  withTempDir(async (dir) => {
    const home = join(dir, 'home');
    const claudeSkills = join(dir, 'claude-skills');
    const codexSkills = join(dir, 'codex-skills');
    const src = mkSkill(dir, 'mysk', 'payload');
    const adapters = [
      new ClaudeCodeAdapter(join(dir, '.claude.json'), claudeSkills),
      new CodexAdapter(join(dir, 'config.toml'), codexSkills, join(dir, '_r.md'), join(dir, '_shared')),
    ];

    const plan = await planInstallSkill(adapters, { name: 'mysk', dir: src }, 'mysk', [
      'claude-code',
      'codex',
    ]);
    assert.equal(plan.changes.length, 2);
    await applyPlan(adapters, plan, { fleetHome: home });
    assert.ok(existsSync(join(claudeSkills, 'mysk', 'SKILL.md')));
    assert.ok(existsSync(join(codexSkills, 'mysk', 'SKILL.md')));

    // identical re-install is a no-op
    const again = await planInstallSkill(adapters, { name: 'mysk', dir: src }, 'mysk', [
      'claude-code',
      'codex',
    ]);
    assert.equal(again.changes.length, 0);
    assert.equal(again.skips[0]?.kind, 'noop');

    // remove from codex, then sync claude → codex
    await applyPlan(adapters, await planRemoveSkill(adapters, 'mysk', ['codex']), { fleetHome: home });
    assert.equal(existsSync(join(codexSkills, 'mysk')), false);
    const sync = await planSyncSkill(adapters, 'mysk', 'claude-code', ['codex']);
    assert.equal(sync.changes.length, 1);
    await applyPlan(adapters, sync, { fleetHome: home });
    assert.match(readFileSync(join(codexSkills, 'mysk', 'SKILL.md'), 'utf8'), /payload/);
  }),
);

// ── ~/.agents/skills interop (P2-3) ─────────────────────────────────────────
import { CodexAdapter as CodexA } from '../src/adapters/codex.js';
import { readSkillsInventory } from '../src/core/skills.js';

test('interop: SYMLINKED skill dir (npx skills add pattern) is inventoried', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-interop-'));
  try {
    const sharedRoot = join(dir, 'agents-skills', 'tdd');
    mkdirSync(sharedRoot, { recursive: true });
    writeFileSync(join(sharedRoot, 'SKILL.md'), '---\ndescription: t\n---\n# tdd');
    const claudeSkills = join(dir, 'claude-skills');
    mkdirSync(claudeSkills, { recursive: true });
    symlinkSync(join(dir, 'agents-skills', 'tdd'), join(claudeSkills, 'tdd')); // the Vercel CLI pattern
    const items = await readSkillsInventory('claude-code', claudeSkills);
    assert.equal(items.length, 1);
    assert.equal(items[0]!.name, 'tdd');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('interop: self-referential symlink does not hang (cycle guard)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-interop-'));
  try {
    const root = join(dir, 'skills');
    mkdirSync(root, { recursive: true });
    symlinkSync(root, join(root, 'loop'));
    const items = await readSkillsInventory('x', root);
    assert.deepEqual(items, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('interop: codex reads the shared ~/.agents/skills root; own dir wins on collision', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-interop-'));
  try {
    const own = join(dir, 'own-skills', 'dup');
    const shared = join(dir, 'shared-skills');
    mkdirSync(own, { recursive: true });
    mkdirSync(join(shared, 'dup'), { recursive: true });
    mkdirSync(join(shared, 'only-shared'), { recursive: true });
    writeFileSync(join(own, 'SKILL.md'), '---\ndescription: own\n---');
    writeFileSync(join(shared, 'dup', 'SKILL.md'), '---\ndescription: shared\n---');
    writeFileSync(join(shared, 'only-shared', 'SKILL.md'), '# s');
    const a = new CodexA(join(dir, 'config.toml'), join(dir, 'own-skills'), join(dir, '_r.md'), shared);
    const items = (await a.readInventory()).filter((i) => i.kind === 'skill');
    const names = items.map((i) => i.name).sort();
    assert.deepEqual(names, ['dup', 'only-shared']);
    const dup = items.find((i) => i.name === 'dup')!;
    assert.equal((dup as { meta?: { description?: string } }).meta?.description, 'own'); // own dir wins
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('context-cost lens: skills and rules carry tokensEst (~bytes/4)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-lens-'));
  try {
    const root = join(dir, 'skills', 'big');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'SKILL.md'), 'x'.repeat(4000)); // ≈1000 tokens
    const items = await readSkillsInventory('claude-code', join(dir, 'skills'));
    assert.ok(items[0]!.tokensEst! >= 990 && items[0]!.tokensEst! <= 1010);

    const { readRulesInventory } = await import('../src/core/rules.js');
    const f = join(dir, 'CLAUDE.md');
    writeFileSync(f, '<!-- fleet:rule:r1 -->\n' + 'y'.repeat(400) + '\n<!-- /fleet:rule:r1 -->\n');
    const rules = await readRulesInventory('claude-code', f);
    assert.equal(rules[0]!.tokensEst, 100);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
