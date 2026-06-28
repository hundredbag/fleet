import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isPlainObject } from './coerce.js';
import { sha256 } from './hash.js';
import type { RenderResult } from './adapter.js';

/**
 * Shared helpers for JSON-config agents (Claude Code, Gemini). Both store MCP
 * servers under `mcpServers` in a JSON file; this centralizes load/validate/
 * render so the writers don't drift.
 */

/** Transport-determining + fleet-managed keys, replaced wholesale on write. */
export const MANAGED_JSON_KEYS = ['command', 'args', 'env', 'type', 'url', 'httpUrl', 'headers'];

/** Infer the file's existing JSON indentation so writes don't churn it. */
export function detectIndent(text: string): string | number {
  const m = text.match(/\n([ \t]+)"/);
  if (!m) return 2;
  const ws = m[1] ?? '';
  return ws.includes('\t') ? '\t' : ws.length;
}

export async function loadJsonDoc(
  path: string,
  label: string,
): Promise<{ doc: Record<string, unknown>; text?: string }> {
  if (!existsSync(path)) return { doc: {} };
  const text = await readFile(path, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // don't echo the parser's content snippet (may contain secrets) to callers
    throw new Error(`${label}: ${path} is not valid JSON`);
  }
  if (!isPlainObject(parsed)) throw new Error(`${label}: ${path} is not a JSON object`);
  return { doc: parsed, text };
}

export function getServers(
  doc: Record<string, unknown>,
  path: string,
  label: string,
): Record<string, unknown> {
  const servers = doc.mcpServers;
  if (servers !== undefined && !isPlainObject(servers)) {
    throw new Error(`${label}: "mcpServers" in ${path} is not an object`);
  }
  return (servers ?? {}) as Record<string, unknown>;
}

/**
 * Build the new entry, preserving any keys on the existing entry that fleet
 * does not manage (e.g. cwd, trust, timeout, enabled) so an update never
 * silently drops user config or re-enables a disabled server.
 */
export function mergePreservingUnmanaged(
  before: unknown,
  next: Record<string, unknown>,
  managedKeys: string[],
): Record<string, unknown> {
  if (!isPlainObject(before)) return next;
  const preserved: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(before)) {
    if (!managedKeys.includes(k)) preserved[k] = v;
  }
  return { ...preserved, ...next };
}

export function renderJson(
  file: string,
  doc: Record<string, unknown>,
  text: string | undefined,
  before: unknown,
  after: unknown,
  warnings: string[],
): RenderResult {
  const indent = text ? detectIndent(text) : 2;
  return {
    file,
    newContent: JSON.stringify(doc, null, indent) + '\n',
    before,
    after,
    baseHash: text ? sha256(text) : undefined,
    warnings: warnings.length ? warnings : undefined,
  };
}

export function validateJsonObject(content: string, label: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    throw new Error(`${label}: config is not valid JSON`);
  }
  if (!isPlainObject(parsed)) throw new Error(`${label}: config is not a JSON object`);
}
