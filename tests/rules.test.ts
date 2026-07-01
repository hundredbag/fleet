import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.js';
import { CodexAdapter } from '../src/adapters/codex.js';
import { parseRuleBlocks, upsertRuleBlock, removeRuleBlock, renderRuleInstall } from '../src/core/rules.js';
import { planInstallRule, planSyncRule, planRemoveRule, applyPlan } from '../src/core/orchestrator.js';

function withTempDir(fn: (dir: string) => void | Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-rule-'));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

function adapters(dir: string, claudeRules: string, codexRules: string) {
  return [
    new ClaudeCodeAdapter(join(dir, '.claude.json'), join(dir, '_sk-c'), claudeRules),
    new CodexAdapter(join(dir, 'config.toml'), join(dir, '_sk-x'), codexRules),
  ];
}

test('upsert/parse/remove rule blocks preserve human content', () => {
  let t = '# My rules\n\nbe nice\n';
  t = upsertRuleBlock(t, 'tests', 'always write tests');
  assert.match(t, /# My rules/);
  assert.match(t, /be nice/);
  let blocks = parseRuleBlocks(t);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.name, 'tests');
  assert.equal(blocks[0]?.body, 'always write tests');

  t = upsertRuleBlock(t, 'tests', 'write MORE tests'); // update same name
  blocks = parseRuleBlocks(t);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0]?.body, 'write MORE tests');

  t = removeRuleBlock(t, 'tests');
  assert.equal(parseRuleBlocks(t).length, 0);
  assert.match(t, /# My rules/);
  assert.match(t, /be nice/);
});

test(
  'rule install into claude+codex preserves human content (markdown not parsed as JSON)',
  withTempDir(async (dir) => {
    const home = join(dir, 'home');
    const claudeRules = join(dir, 'CLAUDE.md');
    const codexRules = join(dir, 'AGENTS.md');
    writeFileSync(claudeRules, '# Claude rules\n\nhand-written stuff\n');
    writeFileSync(codexRules, '# Codex AGENTS\n\nhand-written codex\n');
    const ads = adapters(dir, claudeRules, codexRules);

    const plan = await planInstallRule(ads, 'style', 'be terse', ['claude-code', 'codex']);
    assert.equal(plan.changes.length, 2);
    await applyPlan(ads, plan, { fleetHome: home }); // would throw if markdown were JSON-validated
    assert.match(readFileSync(claudeRules, 'utf8'), /hand-written stuff/);
    assert.match(readFileSync(claudeRules, 'utf8'), /be terse/);
    assert.match(readFileSync(codexRules, 'utf8'), /hand-written codex/);

    const again = await planInstallRule(ads, 'style', 'be terse', ['claude-code', 'codex']);
    assert.equal(again.changes.length, 0);
    assert.equal(again.skips[0]?.kind, 'noop');
  }),
);

test(
  'rule sync copies a block body between agents',
  withTempDir(async (dir) => {
    const home = join(dir, 'home');
    const claudeRules = join(dir, 'CLAUDE.md');
    const codexRules = join(dir, 'AGENTS.md');
    writeFileSync(claudeRules, '');
    const ads = adapters(dir, claudeRules, codexRules);
    await applyPlan(ads, await planInstallRule(ads, 'r1', 'do X', ['claude-code']), { fleetHome: home });
    const sync = await planSyncRule(ads, 'r1', 'claude-code', ['codex']);
    assert.equal(sync.changes.length, 1);
    await applyPlan(ads, sync, { fleetHome: home });
    assert.equal(
      parseRuleBlocks(readFileSync(codexRules, 'utf8')).find((b) => b.name === 'r1')?.body,
      'do X',
    );
  }),
);

test(
  'rule remove strips the block but keeps human content',
  withTempDir(async (dir) => {
    const home = join(dir, 'home');
    const claudeRules = join(dir, 'CLAUDE.md');
    writeFileSync(claudeRules, '# keep me\n');
    const ads = adapters(dir, claudeRules, join(dir, 'AGENTS.md'));
    await applyPlan(ads, await planInstallRule(ads, 'r', 'x', ['claude-code']), { fleetHome: home });
    await applyPlan(ads, await planRemoveRule(ads, 'r', ['claude-code']), { fleetHome: home });
    const t = readFileSync(claudeRules, 'utf8');
    assert.equal(parseRuleBlocks(t).length, 0);
    assert.match(t, /# keep me/);
  }),
);

test('rules: a delimiter mentioned inside human prose is NOT a block (line-anchored)', () => {
  const t = '# Docs: we mark rules with <!-- fleet:rule:r --> inline\n';
  assert.equal(parseRuleBlocks(t).length, 0); // mid-line mention ignored
  const up = upsertRuleBlock(t, 'r', 'real body');
  assert.match(up, /inline/); // human line preserved
  assert.equal(parseRuleBlocks(up).find((b) => b.name === 'r')?.body, 'real body');
});

test(
  'rules: render rejects a body containing fleet delimiter markers',
  withTempDir(async (dir) => {
    const f = join(dir, 'CLAUDE.md');
    writeFileSync(f, '');
    await assert.rejects(
      renderRuleInstall(f, 'x\n<!-- /fleet:rule:r -->\ny', { kind: 'rule', name: 'r', scope: 'user' }),
      /delimiter/,
    );
  }),
);

test(
  'rules: render rejects an empty body and an invalid name',
  withTempDir(async (dir) => {
    const f = join(dir, 'CLAUDE.md');
    writeFileSync(f, '');
    await assert.rejects(renderRuleInstall(f, '   ', { kind: 'rule', name: 'r', scope: 'user' }), /empty/);
    await assert.rejects(
      renderRuleInstall(f, 'ok', { kind: 'rule', name: '../x', scope: 'user' }),
      /invalid/,
    );
  }),
);

test(
  'rule install is not blocked by a malformed MCP config (impact analysis is best-effort)',
  withTempDir(async (dir) => {
    const home = join(dir, 'home');
    const claudeJson = join(dir, '.claude.json');
    const claudeRules = join(dir, 'CLAUDE.md');
    writeFileSync(claudeJson, '{ this is : not valid json'); // malformed MCP config
    writeFileSync(claudeRules, '# rules\n');
    const ads = [new ClaudeCodeAdapter(claudeJson, join(dir, '_sk'), claudeRules)];
    const plan = await planInstallRule(ads, 'style', 'be terse', ['claude-code']);
    assert.equal(plan.changes.length, 1); // rule install still planned
    assert.equal(plan.skips.length, 0);
    await applyPlan(ads, plan, { fleetHome: home });
    assert.match(readFileSync(claudeRules, 'utf8'), /be terse/);
  }),
);

test(
  'adapter: readInventory includes rule blocks',
  withTempDir(async (dir) => {
    const claudeRules = join(dir, 'CLAUDE.md');
    writeFileSync(claudeRules, upsertRuleBlock('# hi\n', 'r', 'body text'));
    const a = new ClaudeCodeAdapter(join(dir, '.claude.json'), join(dir, '_sk'), claudeRules);
    const rule = (await a.readInventory()).find((i) => i.kind === 'rule' && i.name === 'r');
    assert.ok(rule);
    if (rule && rule.kind === 'rule') assert.equal(rule.body, 'body text');
  }),
);
