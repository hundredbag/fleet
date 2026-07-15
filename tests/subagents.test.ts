import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readClaudeSubagents, readCodexSubagents } from '../src/core/subagents.js';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.js';

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'fleet-sub-'));
}

test('claude subagents: frontmatter parsed (name/description/tools/model) + prompt cost', async () => {
  const dir = tmp();
  try {
    const agents = join(dir, 'agents');
    mkdirSync(agents, { recursive: true });
    writeFileSync(
      join(agents, 'code-reviewer.md'),
      '---\nname: code-reviewer\ndescription: security reviews\ntools: Read, Grep, Bash\nmodel: opus\n---\n' +
        'x'.repeat(400),
    );
    writeFileSync(join(agents, 'no-front.md'), 'just a prompt'); // name from filename
    writeFileSync(join(agents, 'notes.txt'), 'ignored'); // wrong extension
    const items = await readClaudeSubagents('claude-code', agents);
    assert.equal(items.length, 2);
    const r = items.find((i) => i.name === 'code-reviewer')!;
    assert.deepEqual(r.tools, ['Read', 'Grep', 'Bash']);
    assert.equal(r.model, 'opus');
    assert.equal(r.tokensEst, 100);
    assert.equal(items.find((i) => i.name === 'no-front')?.description, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('codex subagents: toml parsed; invalid toml skipped, not fatal', async () => {
  const dir = tmp();
  try {
    const agents = join(dir, 'agents');
    mkdirSync(agents, { recursive: true });
    writeFileSync(
      join(agents, 'explorer.toml'),
      'name = "explorer"\ndescription = "codebase exploration"\nmodel = "gpt-5.5-mini"\ndeveloper_instructions = "look around"\n',
    );
    writeFileSync(join(agents, 'broken.toml'), 'not = = toml');
    const items = await readCodexSubagents('codex', agents);
    assert.equal(items.length, 1);
    assert.equal(items[0]!.name, 'explorer');
    assert.equal(items[0]!.model, 'gpt-5.5-mini');
    assert.ok(items[0]!.tokensEst! > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('claude adapter inventories subagents from <settings dir>/agents (hermetic by derivation)', async () => {
  const dir = tmp();
  try {
    writeFileSync(join(dir, '.claude.json'), '{"mcpServers":{}}');
    mkdirSync(join(dir, 'agents'), { recursive: true });
    writeFileSync(join(dir, 'agents', 'helper.md'), '---\ndescription: helps\n---\nhi');
    const a = new ClaudeCodeAdapter(
      join(dir, '.claude.json'),
      join(dir, 'skills'),
      join(dir, 'CLAUDE.md'),
      join(dir, 'settings.json'), // agents dir derives from THIS file's dir
      join(dir, 'plugins'),
    );
    const subs = (await a.readInventory()).filter((i) => i.kind === 'subagent');
    assert.equal(subs.length, 1);
    assert.equal(subs[0]!.name, 'helper');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
