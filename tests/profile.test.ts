import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  symlinkSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.js';
import { buildInventory } from '../src/core/inventory.js';
import { exportProfile, readProfile, resolveSecretRefs, secretRefName } from '../src/core/profile.js';
import { planInstall, execute } from '../src/core/orchestrator.js';
import { prepareProfileDesiredState, refreshProfileDesiredEntry } from '../src/core/profile-desired.js';
import type { Profile } from '../src/core/profile.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'fleet-prof-'));
}

function hermeticClaude(dir: string): ClaudeCodeAdapter {
  writeFileSync(
    join(dir, '.claude.json'),
    JSON.stringify({
      mcpServers: {
        secretive: { command: 'npx', args: ['-y', 's@1.0.0'], env: { API_TOKEN: 'hunter2-SECRET' } },
      },
    }),
  );
  return new ClaudeCodeAdapter(
    join(dir, '.claude.json'),
    join(dir, 'skills'),
    join(dir, 'CLAUDE.md'),
    join(dir, 'settings.json'),
    join(dir, 'plugins'),
  );
}

test('export: secret VALUES never land in the profile; refs + required names do', async () => {
  const dir = tmp();
  try {
    const a = hermeticClaude(dir);
    const out = join(dir, 'dotfiles');
    const { profile } = await exportProfile(await buildInventory([a]), out);
    const raw = readFileSync(join(out, 'profile.json'), 'utf8');
    assert.ok(!raw.includes('hunter2'), 'secret value leaked into profile');
    const REF = secretRefName('secretive', 'ENV', 'API_TOKEN');
    assert.ok(raw.includes('${secret:' + REF + '}'));
    assert.deepEqual(profile.servers[0]!.requiredSecrets, [REF]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('import: missing secret refuses THAT server; present secret resolves', async () => {
  const dir = tmp();
  try {
    const a = hermeticClaude(dir);
    const out = join(dir, 'dotfiles');
    await exportProfile(await buildInventory([a]), out);
    const profile = await readProfile(out);
    const spec = profile.servers[0]!.spec;

    const missing = resolveSecretRefs(spec, {}, profile.servers[0]!.requiredSecrets);
    assert.deepEqual(missing.missing, [secretRefName('secretive', 'ENV', 'API_TOKEN')]);

    const ok = resolveSecretRefs(
      spec,
      { [secretRefName('secretive', 'ENV', 'API_TOKEN')]: 'new-machine-value' },
      profile.servers[0]!.requiredSecrets,
    );
    assert.deepEqual(ok.missing, []);
    assert.equal(ok.spec.transport === 'stdio' ? ok.spec.env?.API_TOKEN : undefined, 'new-machine-value');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('secret resolution never treats inherited prototype properties as machine credentials', () => {
  const resolved = resolveSecretRefs(
    {
      transport: 'stdio',
      command: 'server',
      env: { TOKEN: '${secret:__proto__}' },
    },
    {},
    ['__proto__'],
  );
  assert.deepEqual(resolved.missing, ['__proto__']);
  assert.equal(typeof (resolved.spec.transport === 'stdio' ? resolved.spec.env?.TOKEN : undefined), 'string');
});

test('profile-resolved loader environment remains subject to the block trust policy', async () => {
  const dir = tmp();
  try {
    const adapter = hermeticClaude(dir);
    const resolved = resolveSecretRefs(
      {
        transport: 'stdio',
        command: 'npx',
        args: ['safe@1.0.0'],
        env: { NODE_OPTIONS: '${secret:PROFILE_NODE_OPTIONS}' },
      },
      { PROFILE_NODE_OPTIONS: '--require=/tmp/attacker.js' },
      ['PROFILE_NODE_OPTIONS'],
    );
    assert.deepEqual(resolved.missing, []);
    const plan = await planInstall([adapter], resolved.spec, 'profile-loader-env', 'user', ['claude-code'], {
      trustPolicy: 'block',
    });
    assert.equal(plan.changes.length, 0);
    assert.equal(plan.trust?.level, 'caution');
    assert.ok(plan.skips.some((skip) => skip.kind === 'protected'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('round-trip: export machine A → import to fresh machine B (skills + servers land)', async () => {
  const dirA = tmp();
  const dirB = tmp();
  try {
    // machine A: server + one skill
    const a = hermeticClaude(dirA);
    mkdirSync(join(dirA, 'skills', 'tdd'), { recursive: true });
    writeFileSync(join(dirA, 'skills', 'tdd', 'SKILL.md'), '# tdd');
    const out = join(dirA, 'dotfiles');
    await exportProfile(await buildInventory([a]), out);
    assert.ok(existsSync(join(out, 'skills', 'tdd', 'SKILL.md'))); // skill tree copied

    // machine B: fresh agent, import the profile
    writeFileSync(join(dirB, '.claude.json'), '{"mcpServers":{}}');
    const b = new ClaudeCodeAdapter(
      join(dirB, '.claude.json'),
      join(dirB, 'skills'),
      join(dirB, 'CLAUDE.md'),
      join(dirB, 'settings.json'),
      join(dirB, 'plugins'),
    );
    const profile = await readProfile(out);
    const { spec } = resolveSecretRefs(
      profile.servers[0]!.spec,
      { [secretRefName('secretive', 'ENV', 'API_TOKEN')]: 'b-token' },
      profile.servers[0]!.requiredSecrets,
    );
    const plan = await planInstall([b], spec, profile.servers[0]!.name, 'user', ['claude-code'], {
      trustPolicy: 'warn',
    });
    const res = await execute([b], plan, { commit: true, fleetHome: join(dirB, 'home') });
    assert.equal(res.applied.length, 1);
    const doc = JSON.parse(readFileSync(join(dirB, '.claude.json'), 'utf8'));
    assert.equal(doc.mcpServers.secretive.env.API_TOKEN, 'b-token'); // machine-local secret
  } finally {
    rmSync(dirA, { recursive: true, force: true });
    rmSync(dirB, { recursive: true, force: true });
  }
});

test('secretRefName: injective across sanitize aliases and deterministic', () => {
  assert.notEqual(secretRefName('foo-bar', 'ENV', 'KEY'), secretRefName('foo_bar', 'ENV', 'KEY'));
  assert.notEqual(secretRefName('s', 'ENV', 'A-B'), secretRefName('s', 'ENV', 'A_B'));
  // Regression: these valid public names collided under the former 24-bit
  // digest and could make two services consume the same machine credential.
  assert.notEqual(
    secretRefName('s-----_--_-_--_-', 'ENV', 'TOKEN'),
    secretRefName('s---_--_-_--__--', 'ENV', 'TOKEN'),
  );
  assert.equal(secretRefName('s', 'ENV', 'K'), secretRefName('s', 'ENV', 'K')); // stable
});

test('export: divergent same-name definitions are EXCLUDED and reported (no silent loss)', async () => {
  const dir = tmp();
  try {
    const a = hermeticClaude(dir); // has 'secretive' with API_TOKEN env
    const inv = await buildInventory([a]);
    // fabricate a second agent carrying a DIVERGENT spec under the same name
    inv.items.push({
      kind: 'mcp-server',
      name: 'secretive',
      agent: 'codex',
      scope: 'user',
      enabled: true,
      spec: { transport: 'stdio', command: 'uvx', args: ['other-pkg'] },
      source: { file: 'x' },
    } as (typeof inv.items)[number]);
    const { profile, conflicts } = await exportProfile(inv, join(dir, 'out'));
    assert.equal(profile.servers.length, 0); // excluded, not first-wins
    assert.equal(conflicts.length, 1);
    assert.deepEqual(conflicts[0]!.agents.sort(), ['claude-code', 'codex']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('export refuses symlinked destinations before deleting or overwriting outside files', async () => {
  const dir = tmp();
  try {
    const source = join(dir, 'source');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), '# safe source');
    const inventory = {
      agents: [],
      items: [
        {
          kind: 'skill' as const,
          name: 'safe-skill',
          agent: 'claude-code',
          scope: 'user' as const,
          enabled: true,
          path: source,
          source: { file: source },
        },
      ],
    };

    const outside = join(dir, 'outside');
    const out = join(dir, 'out');
    mkdirSync(outside);
    mkdirSync(out);
    writeFileSync(join(outside, 'keep.txt'), 'KEEP');
    symlinkSync(outside, join(out, 'skills'));
    await assert.rejects(exportProfile(inventory, out), /symlink|outside the target root/);
    assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'KEEP');

    rmSync(join(out, 'skills'));
    const outsideProfile = join(outside, 'profile.json');
    writeFileSync(outsideProfile, 'KEEP PROFILE');
    symlinkSync(outsideProfile, join(out, 'profile.json'));
    await assert.rejects(exportProfile({ agents: [], items: [] }, out), /symlink|outside the target root/);
    assert.equal(readFileSync(outsideProfile, 'utf8'), 'KEEP PROFILE');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('export safely supports a skill source already inside the existing profile generation', async () => {
  const dir = tmp();
  try {
    const source = join(dir, 'profile', 'skills', 'self-skill');
    mkdirSync(source, { recursive: true });
    writeFileSync(join(source, 'SKILL.md'), '# must survive');
    const inventory = {
      agents: [],
      items: [
        {
          kind: 'skill' as const,
          name: 'self-skill',
          agent: 'claude-code',
          scope: 'user' as const,
          enabled: true,
          path: source,
          source: { file: source },
        },
      ],
    };
    writeFileSync(
      join(dir, 'profile', 'profile.json'),
      JSON.stringify({ version: 1, servers: [], rules: [], skills: ['self-skill'] }),
    );
    await exportProfile(inventory, join(dir, 'profile'));
    assert.equal(readFileSync(join(source, 'SKILL.md'), 'utf8'), '# must survive');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('export materializes a symlink-root skill source with a stable matching hash', async () => {
  const dir = tmp();
  try {
    const physical = join(dir, 'physical-skill');
    const linked = join(dir, 'linked-skill');
    mkdirSync(physical);
    writeFileSync(join(physical, 'SKILL.md'), '# linked source');
    symlinkSync(physical, linked);
    const inventory = {
      agents: [],
      items: [
        {
          kind: 'skill' as const,
          name: 'linked-skill',
          agent: 'codex',
          scope: 'user' as const,
          enabled: true,
          path: linked,
          source: { file: linked },
        },
      ],
    };
    await exportProfile(inventory, join(dir, 'profile'));
    assert.equal(
      readFileSync(join(dir, 'profile', 'skills', 'linked-skill', 'SKILL.md'), 'utf8'),
      '# linked source',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('profile export and validation preserve grouped skill identities', async () => {
  const dir = tmp();
  try {
    const source = join(dir, 'source');
    const out = join(dir, 'profile');
    mkdirSync(source);
    writeFileSync(join(source, 'SKILL.md'), '# grouped');
    await exportProfile(
      {
        agents: [],
        items: [
          {
            kind: 'skill' as const,
            name: 'group/grouped-skill',
            agent: 'codex',
            scope: 'user' as const,
            enabled: true,
            path: source,
            source: { file: source },
          },
        ],
      },
      out,
    );
    const profile = await readProfile(out);
    assert.deepEqual(profile.skills, ['group/grouped-skill']);
    assert.equal(
      readFileSync(join(out, 'skills', 'group', 'grouped-skill', 'SKILL.md'), 'utf8'),
      '# grouped',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('export refuses to replace a repository root containing .git metadata', async () => {
  const dir = tmp();
  try {
    const out = join(dir, 'dotfiles-repository');
    mkdirSync(join(out, '.git'), { recursive: true });
    writeFileSync(join(out, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    await assert.rejects(exportProfile({ agents: [], items: [] }, out), /dedicated directory/);
    assert.equal(readFileSync(join(out, '.git', 'HEAD'), 'utf8'), 'ref: refs/heads/main\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readProfile rejects malformed unions, undeclared refs, duplicate identities, and unknown fields', async () => {
  const dir = tmp();
  try {
    mkdirSync(join(dir, 'skills', 'demo'), { recursive: true });
    writeFileSync(join(dir, 'skills', 'demo', 'SKILL.md'), '# demo');
    const valid: Profile = {
      version: 1,
      servers: [
        {
          name: 'demo-server',
          spec: {
            transport: 'stdio',
            command: 'demo',
            env: { TOKEN: '${secret:DEMO_TOKEN}' },
          },
          requiredSecrets: ['DEMO_TOKEN'],
        },
      ],
      rules: [{ name: 'review', body: 'Review changes.' }],
      skills: ['demo'],
    };
    const cases: unknown[] = [
      { ...valid, extra: true },
      {
        ...valid,
        servers: [
          {
            name: 'demo-server',
            spec: { transport: 'stdio', command: 'demo', url: 'https://invalid.example' },
            requiredSecrets: [],
          },
        ],
      },
      {
        ...valid,
        servers: [{ ...valid.servers[0], requiredSecrets: [] }],
      },
      {
        ...valid,
        servers: [
          {
            name: 'demo-server',
            spec: { transport: 'stdio', command: 'demo', env: { TOKEN: 'literal-secret' } },
            requiredSecrets: [],
          },
        ],
      },
      {
        ...valid,
        servers: [valid.servers[0], valid.servers[0]],
      },
      {
        ...valid,
        rules: [valid.rules[0], valid.rules[0]],
      },
      { ...valid, skills: ['demo', 'demo'] },
    ];
    for (const doc of cases) {
      writeFileSync(join(dir, 'profile.json'), JSON.stringify(doc));
      await assert.rejects(readProfile(dir), /fleet:/);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('readProfile refuses a symlinked manifest instead of following it outside the profile root', async () => {
  const dir = tmp();
  try {
    const outside = join(dir, 'outside.json');
    const profileDir = join(dir, 'profile');
    mkdirSync(profileDir);
    writeFileSync(outside, JSON.stringify({ version: 1, servers: [], rules: [], skills: [] }));
    symlinkSync(outside, join(profileDir, 'profile.json'));
    await assert.rejects(readProfile(profileDir), /symlink|regular file|target root/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('desired state is additive and missing secrets withhold every plan', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, '.claude.json'), '{ malformed');
    const adapter = new ClaudeCodeAdapter(
      join(dir, '.claude.json'),
      join(dir, 'installed-skills'),
      join(dir, 'CLAUDE.md'),
      join(dir, 'settings.json'),
      join(dir, 'plugins'),
    );
    const profile: Profile = {
      version: 1,
      servers: [
        {
          name: 'needs-secret',
          spec: {
            transport: 'stdio',
            command: 'server',
            env: { TOKEN: '${secret:PROFILE_TOKEN}' },
          },
          requiredSecrets: ['PROFILE_TOKEN'],
        },
      ],
      rules: [{ name: 'would-plan-later', body: 'Keep this rule.' }],
      skills: [],
    };
    const desired = await prepareProfileDesiredState(
      [adapter],
      profile,
      dir,
      { servers: ['claude-code'], skills: [], rules: ['claude-code'] },
      { env: {} },
    );
    assert.equal(desired.mode, 'additive');
    assert.deepEqual(desired.entries, []);
    assert.deepEqual(desired.missingSecrets, [{ server: 'needs-secret', names: ['PROFILE_TOKEN'] }]);
    assert.equal(desired.summary.desiredInstances, 2);
    assert.equal(desired.summary.blocked, 2);
    assert.equal(readFileSync(join(dir, '.claude.json'), 'utf8'), '{ malformed');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('desired state pre-plans all entries and refreshes shared config bases before commit', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, '.claude.json'), '{"mcpServers":{}}');
    const adapter = new ClaudeCodeAdapter(
      join(dir, '.claude.json'),
      join(dir, 'installed-skills'),
      join(dir, 'CLAUDE.md'),
      join(dir, 'settings.json'),
      join(dir, 'plugins'),
    );
    const profile: Profile = {
      version: 1,
      servers: [
        {
          name: 'alpha',
          spec: { transport: 'stdio', command: 'alpha-server' },
          requiredSecrets: [],
        },
        {
          name: 'beta',
          spec: { transport: 'stdio', command: 'beta-server' },
          requiredSecrets: [],
        },
      ],
      rules: [],
      skills: [],
    };
    const desired = await prepareProfileDesiredState(
      [adapter],
      profile,
      dir,
      { servers: ['claude-code'], skills: [], rules: [] },
      { env: {}, trustPolicy: 'warn' },
    );
    assert.equal(desired.entries.length, 2);
    assert.equal(desired.summary.changes, 2);
    for (const entry of desired.entries) {
      const plan = await refreshProfileDesiredEntry([adapter], entry, { trustPolicy: 'warn' });
      const result = await execute([adapter], plan, { commit: true, fleetHome: join(dir, 'fleet-home') });
      assert.equal(result.error, undefined);
      assert.equal(result.applied.length, 1);
    }
    const installed = JSON.parse(readFileSync(join(dir, '.claude.json'), 'utf8')) as {
      mcpServers: Record<string, unknown>;
    };
    assert.deepEqual(Object.keys(installed.mcpServers).sort(), ['alpha', 'beta']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('desired state counts a self-protected profile item as blocked, not satisfied', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, '.claude.json'), '{"mcpServers":{}}');
    const adapter = new ClaudeCodeAdapter(
      join(dir, '.claude.json'),
      join(dir, 'installed-skills'),
      join(dir, 'CLAUDE.md'),
      join(dir, 'settings.json'),
      join(dir, 'plugins'),
    );
    const desired = await prepareProfileDesiredState(
      [adapter],
      {
        version: 1,
        servers: [
          {
            name: 'fleet',
            spec: { transport: 'stdio', command: 'replacement' },
            requiredSecrets: [],
          },
        ],
        rules: [],
        skills: [],
      },
      dir,
      { servers: ['claude-code'], skills: [], rules: [] },
      { trustPolicy: 'warn' },
    );
    assert.equal(desired.summary.changes, 0);
    assert.equal(desired.summary.blocked, 1);
    assert.equal(desired.entries[0]!.plan.skips[0]!.kind, 'protected');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('export builds a complete generation before swapping and preserves unrelated files', async () => {
  const dir = tmp();
  try {
    const out = join(dir, 'profile-out');
    const oldSource = join(dir, 'old-source');
    const newSource = join(dir, 'new-source');
    mkdirSync(oldSource);
    mkdirSync(newSource);
    writeFileSync(join(oldSource, 'SKILL.md'), '# old');
    writeFileSync(join(newSource, 'SKILL.md'), '# new');
    const skillInventory = (name: string, path: string) => ({
      agents: [],
      items: [
        {
          kind: 'skill' as const,
          name,
          agent: 'claude-code',
          scope: 'user' as const,
          enabled: true,
          path,
          source: { file: path },
        },
      ],
    });
    await exportProfile(skillInventory('old-skill', oldSource), out);
    writeFileSync(join(out, 'notes.txt'), 'preserve me');
    await exportProfile(skillInventory('new-skill', newSource), out);
    assert.equal(readFileSync(join(out, 'notes.txt'), 'utf8'), 'preserve me');
    assert.equal(readFileSync(join(out, 'skills', 'new-skill', 'SKILL.md'), 'utf8'), '# new');
    assert.equal(existsSync(join(out, 'skills', 'old-skill')), false);

    const before = readFileSync(join(out, 'profile.json'), 'utf8');
    const fifo = join(out, 'unrelated-fifo');
    const madeFifo = spawnSync('mkfifo', [fifo]);
    assert.equal(madeFifo.status, 0, madeFifo.stderr.toString());
    await assert.rejects(exportProfile({ agents: [], items: [] }, out), /unsupported directory entry/);
    assert.equal(readFileSync(join(out, 'profile.json'), 'utf8'), before);
    assert.equal(readFileSync(join(out, 'skills', 'new-skill', 'SKILL.md'), 'utf8'), '# new');
    assert.equal(existsSync(fifo), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
