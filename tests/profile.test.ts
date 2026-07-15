import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.js';
import { buildInventory } from '../src/core/inventory.js';
import { exportProfile, readProfile, resolveSecretRefs } from '../src/core/profile.js';
import { planInstall, execute } from '../src/core/orchestrator.js';

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
    assert.ok(raw.includes('${secret:S_SECRETIVE_ENV_API_TOKEN}'));
    assert.deepEqual(profile.servers[0]!.requiredSecrets, ['S_SECRETIVE_ENV_API_TOKEN']);
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
    assert.deepEqual(missing.missing, ['S_SECRETIVE_ENV_API_TOKEN']);

    const ok = resolveSecretRefs(
      spec,
      { S_SECRETIVE_ENV_API_TOKEN: 'new-machine-value' },
      profile.servers[0]!.requiredSecrets,
    );
    assert.deepEqual(ok.missing, []);
    assert.equal(ok.spec.transport === 'stdio' ? ok.spec.env?.API_TOKEN : undefined, 'new-machine-value');
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
      { S_SECRETIVE_ENV_API_TOKEN: 'b-token' },
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
