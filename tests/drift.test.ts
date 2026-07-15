import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.js';
import { planInstall, planInstallSkill, execute } from '../src/core/orchestrator.js';
import { buildInventory } from '../src/core/inventory.js';
import { detectDrift } from '../src/core/drift.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'fleet-drift-'));
}

function hermeticClaude(dir: string): ClaudeCodeAdapter {
  const claudeJson = join(dir, '.claude.json');
  writeFileSync(claudeJson, JSON.stringify({ mcpServers: {} }));
  return new ClaudeCodeAdapter(
    claudeJson,
    join(dir, 'skills'),
    join(dir, 'CLAUDE.md'),
    join(dir, 'settings.json'),
    join(dir, 'plugins'),
  );
}

async function installServer(a: ClaudeCodeAdapter, home: string, name = 'srv') {
  const plan = await planInstall(
    [a],
    { transport: 'stdio', command: 'npx', args: ['-y', `${name}-pkg@1.0.0`] },
    name,
    'user',
    ['claude-code'],
    { trustPolicy: 'warn' },
  );
  const res = await execute([a], plan, { commit: true, fleetHome: home });
  assert.equal(res.applied.length, 1);
}

test('drift: freshly installed MCP server and skill read INTACT (canonical hashing)', async () => {
  const dir = tmp();
  try {
    const home = join(dir, 'home');
    const a = hermeticClaude(dir);
    await installServer(a, home);
    const src = join(dir, 'sk');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'SKILL.md'), '# sk');
    const sp = await planInstallSkill([a], { name: 'sk', dir: src }, 'sk', ['claude-code'], {
      trustPolicy: 'warn',
    });
    await execute([a], sp, { commit: true, fleetHome: home });

    const report = await detectDrift(await buildInventory([a]), home);
    assert.equal(report.checked, 2);
    assert.deepEqual(report.findings, []); // no false drift right after install
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('drift: hand-edited MCP entry reads MODIFIED (SANDWORM-class detection)', async () => {
  const dir = tmp();
  try {
    const home = join(dir, 'home');
    const a = hermeticClaude(dir);
    await installServer(a, home);
    // tamper: swap the command outside fleet
    const cj = join(dir, '.claude.json');
    const doc = JSON.parse(readFileSync(cj, 'utf8'));
    doc.mcpServers.srv.command = 'curl-evil';
    writeFileSync(cj, JSON.stringify(doc, null, 2));

    const report = await detectDrift(await buildInventory([a]), home);
    const f = report.findings.find((x) => x.name === 'srv');
    assert.equal(f?.state, 'modified');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('drift: skill dir touched outside fleet reads MODIFIED; deleted entry reads MISSING', async () => {
  const dir = tmp();
  try {
    const home = join(dir, 'home');
    const a = hermeticClaude(dir);
    const src = join(dir, 'sk');
    mkdirSync(src, { recursive: true });
    writeFileSync(join(src, 'SKILL.md'), '# sk');
    const sp = await planInstallSkill([a], { name: 'sk', dir: src }, 'sk', ['claude-code'], {
      trustPolicy: 'warn',
    });
    await execute([a], sp, { commit: true, fleetHome: home });
    writeFileSync(join(dir, 'skills', 'sk', 'SKILL.md'), '# TAMPERED');
    let report = await detectDrift(await buildInventory([a]), home);
    assert.equal(report.findings.find((x) => x.name === 'sk')?.state, 'modified');

    rmSync(join(dir, 'skills', 'sk'), { recursive: true, force: true });
    report = await detectDrift(await buildInventory([a]), home);
    assert.equal(report.findings.find((x) => x.name === 'sk')?.state, 'missing');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('drift: hand-added MCP server (never installed by fleet) is listed as unmanaged', async () => {
  const dir = tmp();
  try {
    const home = join(dir, 'home');
    const a = hermeticClaude(dir);
    const cj = join(dir, '.claude.json');
    writeFileSync(cj, JSON.stringify({ mcpServers: { rogue: { command: 'evil' } } }));
    const report = await detectDrift(await buildInventory([a]), home);
    assert.ok(report.unmanaged.some((u) => u.name === 'rogue' && u.kind === 'mcp-server'));
    assert.equal(report.findings.length, 0); // not drift — fleet never claimed it
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── dual-review round (scope identity + unmanaged) ──────────────────────────

test('drift: same-name PROJECT-scope rogue is NOT masked by the user-scope lock entry', async () => {
  const dir = tmp();
  try {
    const home = join(dir, 'home');
    const a = hermeticClaude(dir);
    await installServer(a, home); // user-scope 'srv' in the lock
    // craft an inventory carrying an extra project-scope rogue with the SAME name
    const inv = await buildInventory([a]);
    inv.items.push({
      kind: 'mcp-server',
      name: 'srv',
      agent: 'claude-code',
      scope: 'project',
      enabled: true,
      spec: { transport: 'stdio', command: 'curl-evil' },
      source: { file: '/proj/.mcp.json' },
    } as (typeof inv.items)[number]);
    const report = await detectDrift(inv, home);
    assert.ok(
      report.unmanaged.some((u) => u.name === 'srv' && u.scope === 'project'),
      'project-scope rogue must surface as unmanaged',
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('drift: broken agent inventory reads UNVERIFIABLE (not mass missing)', async () => {
  const dir = tmp();
  try {
    const home = join(dir, 'home');
    const a = hermeticClaude(dir);
    await installServer(a, home);
    const inv = await buildInventory([a]);
    inv.items = []; // simulate a read failure: no items…
    inv.agents = inv.agents.map((g) => ({ ...g, note: 'config.toml does not parse' })); // …with a note
    const report = await detectDrift(inv, home);
    assert.equal(report.findings[0]?.state, 'unverifiable');
    assert.match(report.findings[0]?.detail ?? '', /inventory unavailable/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('drift: pre-canonical lock entries read UNVERIFIABLE with re-baseline hint', async () => {
  const dir = tmp();
  try {
    const home = join(dir, 'home');
    const a = hermeticClaude(dir);
    await installServer(a, home);
    // strip the scheme marker to simulate an entry from before canonical hashing
    const lockPath = join(home, 'fleet.lock');
    const doc = JSON.parse(readFileSync(lockPath, 'utf8'));
    for (const k of Object.keys(doc.entries)) delete doc.entries[k].hashScheme;
    writeFileSync(lockPath, JSON.stringify(doc));
    const report = await detectDrift(await buildInventory([a]), home);
    assert.equal(report.findings[0]?.state, 'unverifiable');
    assert.match(report.findings[0]?.detail ?? '', /re-baseline/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
