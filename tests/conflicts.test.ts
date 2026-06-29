import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectOpposition, analyzeConflicts, opposingRules } from '../src/core/conflicts.js';
import type { Inventory, RuleCapability } from '../src/core/types.js';

function rule(name: string, agent: string, body: string): RuleCapability {
  return { kind: 'rule', name, agent, scope: 'user', enabled: true, body, source: { file: 'f' } };
}

test('detectOpposition: opposite poles on an axis are flagged; same pole is not', () => {
  assert.equal(detectOpposition('Always answer in a terse, concise way', 'Be verbose and thorough'), 'verbosity');
  assert.equal(detectOpposition('Ask first before running commands', 'Proceed without asking'), 'autonomy');
  assert.equal(detectOpposition('be terse', 'be concise'), null); // same pole
  assert.equal(detectOpposition('be terse', 'use a formal tone'), null); // different axes, not opposite
});

test('analyzeConflicts: flags opposing always-on rules on the SAME agent only', () => {
  const inv: Inventory = {
    agents: [],
    items: [
      rule('terse', 'claude-code', 'keep it short and concise'),
      rule('verbose', 'claude-code', 'answer in detail, be thorough'),
      rule('verbose-other', 'codex', 'be verbose and detailed'),
    ],
  };
  const findings = analyzeConflicts(inv);
  assert.equal(findings.length, 1); // only the same-agent (claude) pair
  assert.equal(findings[0]?.agent, 'claude-code');
  assert.equal(findings[0]?.axis, 'verbosity');
});

test('analyzeConflicts: no findings when rules do not oppose', () => {
  const inv: Inventory = {
    agents: [],
    items: [
      rule('a', 'claude-code', 'write tests for new code'),
      rule('b', 'claude-code', 'use TypeScript strict mode'),
    ],
  };
  assert.equal(analyzeConflicts(inv).length, 0);
});

test('detectOpposition: negation and word-boundary guards reduce false positives', () => {
  // negated → not an opposition (both effectively want verbose)
  assert.equal(detectOpposition('do not be terse', 'be verbose'), null);
  // "formal" must not match inside "informal"
  assert.equal(detectOpposition('use an informal tone', 'keep an informal tone'), null);
  // genuine opposite still caught
  assert.equal(detectOpposition('use a formal tone', 'be casual and playful'), 'tone');
});

test('opposingRules: finds existing rules that oppose a candidate body', () => {
  const existing = [rule('terse', 'x', 'be terse'), rule('tests', 'x', 'write tests')];
  const opp = opposingRules(existing, 'be very verbose and detailed', 'newrule');
  assert.equal(opp.length, 1);
  assert.equal(opp[0]?.name, 'terse');
  assert.equal(opp[0]?.axis, 'verbosity');
});
