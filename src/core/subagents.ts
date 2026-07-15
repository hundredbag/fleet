import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, basename, extname } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import type { SubagentCapability } from './types.js';

/**
 * Subagent DEFINITIONS — the reusable "job postings" both vendors support:
 *   Claude Code: ~/.claude/agents/*.md   (frontmatter + system prompt body)
 *   Codex:       ~/.codex/agents/*.toml  (name/description/model/… keys)
 * Same concept, different formats — the skills/rules pattern again. Read-only
 * this round; tools/model are SECURITY-relevant fields worth surfacing.
 */

function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(line);
    if (kv) meta[kv[1]!.toLowerCase()] = kv[2]!.trim();
  }
  return { meta, body: m[2] ?? '' };
}

/** Claude Code: one .md per subagent, YAML-ish frontmatter. */
export async function readClaudeSubagents(agent: string, dir: string): Promise<SubagentCapability[]> {
  if (!existsSync(dir)) return [];
  const out: SubagentCapability[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const e of entries) {
    if (!e.isFile() || extname(e.name) !== '.md') continue;
    const path = join(dir, e.name);
    try {
      const { meta, body } = parseFrontmatter(await readFile(path, 'utf8'));
      out.push({
        kind: 'subagent',
        name: meta.name || basename(e.name, '.md'),
        agent,
        scope: 'user',
        enabled: true,
        path,
        description: meta.description,
        tools: meta.tools
          ? meta.tools
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean)
          : undefined,
        model: meta.model,
        tokensEst: Math.ceil(Buffer.byteLength(body, 'utf8') / 4),
        source: { file: path },
      });
    } catch {
      /* unreadable definition — skip; doctor surfaces adapter-level problems */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** Codex: one .toml per subagent role. */
export async function readCodexSubagents(agent: string, dir: string): Promise<SubagentCapability[]> {
  if (!existsSync(dir)) return [];
  const out: SubagentCapability[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  for (const e of entries) {
    if (!e.isFile() || extname(e.name) !== '.toml') continue;
    const path = join(dir, e.name);
    try {
      const doc = parseToml(await readFile(path, 'utf8')) as Record<string, unknown>;
      const instructions = typeof doc.developer_instructions === 'string' ? doc.developer_instructions : '';
      out.push({
        kind: 'subagent',
        name: typeof doc.name === 'string' && doc.name ? doc.name : basename(e.name, '.toml'),
        agent,
        scope: 'user',
        enabled: true,
        path,
        description: typeof doc.description === 'string' ? doc.description : undefined,
        model: typeof doc.model === 'string' ? doc.model : undefined,
        tokensEst: instructions ? Math.ceil(Buffer.byteLength(instructions, 'utf8') / 4) : undefined,
        source: { file: path },
        raw: doc,
      });
    } catch {
      /* invalid TOML — skip this definition */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
