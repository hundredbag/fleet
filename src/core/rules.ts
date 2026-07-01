import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import type { RuleCapability } from './types.js';
import type { CapabilityRef, RenderResult } from './adapter.js';
import { sha256 } from './hash.js';

/**
 * Rules = behavioral instructions, managed as DELIMITED BLOCKS inside an
 * always-on instruction file (Claude CLAUDE.md, Codex/Hermes AGENTS.md). fleet
 * only ever touches its own blocks; human-authored content is preserved verbatim.
 *
 * Two safety layers (review #7):
 *  - delimiters are LINE-ANCHORED, so a marker mentioned inside human prose is
 *    not treated as a boundary;
 *  - every render asserts the "human remainder" (the file with all fleet blocks
 *    stripped) is UNCHANGED — any write that would alter non-fleet content is
 *    refused. This is the real net (the engine's parse-validation is skipped for
 *    markdown).
 */

const NAME_RE = /^[A-Za-z0-9._-]+$/;
const CAP_BYTES = 32 * 1024; // Codex's combined instruction cap

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Global, multiline, line-anchored matcher for every fleet block (name=\1). */
function allBlocksRe(): RegExp {
  return /^<!-- fleet:rule:([A-Za-z0-9._-]+) -->[ \t]*\r?\n([\s\S]*?)\r?\n<!-- \/fleet:rule:\1 -->[ \t]*$/gm;
}

/** Line-anchored matcher for one named block (no trailing newline consumed). */
function oneBlockRe(name: string): RegExp {
  return new RegExp(
    `^<!-- fleet:rule:${esc(name)} -->[ \\t]*\\r?\\n[\\s\\S]*?\\r?\\n<!-- /fleet:rule:${esc(name)} -->[ \\t]*$`,
    'm',
  );
}

export function parseRuleBlocks(text: string): { name: string; body: string }[] {
  const out: { name: string; body: string }[] = [];
  const re = allBlocksRe();
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) out.push({ name: m[1]!, body: m[2] ?? '' });
  return out;
}

export function upsertRuleBlock(text: string, name: string, body: string): string {
  const block = `<!-- fleet:rule:${name} -->\n${body}\n<!-- /fleet:rule:${name} -->`;
  const re = oneBlockRe(name);
  if (re.test(text)) return text.replace(re, block);
  const sep = text.length === 0 ? '' : text.endsWith('\n') ? '\n' : '\n\n';
  return `${text}${sep}${block}\n`;
}

export function removeRuleBlock(text: string, name: string): string {
  const re = new RegExp(
    `^<!-- fleet:rule:${esc(name)} -->[ \\t]*\\r?\\n[\\s\\S]*?\\r?\\n<!-- /fleet:rule:${esc(name)} -->[ \\t]*\\r?\\n?`,
    'm',
  );
  return text.replace(re, '').replace(/\n{3,}/g, '\n\n');
}

/** The file with every fleet block stripped, reduced to its non-blank content
 * lines — the part fleet must never change. */
function humanRemainder(text: string): string {
  return text
    .replace(allBlocksRe(), '')
    .split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l !== '')
    .join('\n');
}

/** Refuse any change that would alter human-authored (non-fleet) content. */
function assertOnlyFleetChanged(oldText: string, newText: string): void {
  if (humanRemainder(oldText) !== humanRemainder(newText)) {
    throw new Error(
      'fleet: refusing — this change would alter human-authored content in the instruction file',
    );
  }
}

/** Full instruction-file text (for Part C conflict analysis), or undefined. */
export async function readInstructionText(instrPath: string): Promise<string | undefined> {
  return existsSync(instrPath) ? readFile(instrPath, 'utf8') : undefined;
}

export async function readRulesInventory(agent: string, instrPath: string): Promise<RuleCapability[]> {
  if (!existsSync(instrPath)) return [];
  const text = await readFile(instrPath, 'utf8');
  return parseRuleBlocks(text).map((b) => ({
    kind: 'rule',
    name: b.name,
    agent,
    scope: 'user',
    enabled: true,
    body: b.body,
    source: { file: instrPath },
  }));
}

export async function renderRuleInstall(
  instrPath: string,
  body: string,
  ref: CapabilityRef,
): Promise<RenderResult> {
  if (!NAME_RE.test(ref.name)) {
    throw new Error(`fleet: invalid rule name "${ref.name}" (use letters, digits, . _ -)`);
  }
  if (body.trim() === '') throw new Error(`fleet: rule "${ref.name}" has an empty body`);
  if (/<!-- \/?fleet:rule:/.test(body)) {
    throw new Error(`fleet: rule body must not contain fleet delimiter markers`);
  }
  const exists = existsSync(instrPath);
  const text = exists ? await readFile(instrPath, 'utf8') : '';
  const before = parseRuleBlocks(text).find((b) => b.name === ref.name)?.body;
  const newContent = upsertRuleBlock(text, ref.name, body);
  assertOnlyFleetChanged(text, newContent);
  const warnings: string[] = [];
  if (!exists) warnings.push(`will create a new instruction file at ${instrPath}`);
  if (Buffer.byteLength(newContent, 'utf8') > CAP_BYTES) {
    warnings.push(`${instrPath} exceeds ~32 KiB after this change (Codex may truncate)`);
  }
  return {
    file: instrPath,
    kind: 'rule',
    newContent,
    before,
    after: body,
    baseHash: exists ? sha256(text) : undefined,
    warnings: warnings.length ? warnings : undefined,
  };
}

export async function renderRuleRemove(instrPath: string, ref: CapabilityRef): Promise<RenderResult> {
  if (!NAME_RE.test(ref.name)) {
    throw new Error(`fleet: invalid rule name "${ref.name}"`);
  }
  const exists = existsSync(instrPath);
  const text = exists ? await readFile(instrPath, 'utf8') : '';
  const before = parseRuleBlocks(text).find((b) => b.name === ref.name)?.body;
  const newContent = removeRuleBlock(text, ref.name);
  assertOnlyFleetChanged(text, newContent);
  return {
    file: instrPath,
    kind: 'rule',
    newContent,
    before,
    after: undefined,
    baseHash: exists ? sha256(text) : undefined,
    warnings: before === undefined ? [`rule "${ref.name}" is not installed`] : undefined,
  };
}
