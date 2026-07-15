import { existsSync } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
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

// ponytail: minimal YAML subset (scalars, quoted scalars, [flow] and dash
// lists) — enough for real agent frontmatter without a YAML dependency;
// folded/literal blocks stay raw strings.
function parseFrontmatter(text: string): { meta: Record<string, string>; body: string } {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) return { meta: {}, body: text };
  const meta: Record<string, string> = {};
  const lines = m[1]!.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = /^([A-Za-z_-]+):\s*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    const key = kv[1]!.toLowerCase();
    let val = kv[2]!.trim();
    if (val === '' || val === '|' || val === '>') {
      // dash-list (or block scalar we don't reflow): collect indented lines
      const items: string[] = [];
      while (i + 1 < lines.length && /^\s+(-\s+.*|\S.*)$/.test(lines[i + 1]!)) {
        const item = /^\s*-\s+(.*)$/.exec(lines[i + 1]!);
        items.push(item ? item[1]!.trim() : lines[i + 1]!.trim());
        i++;
      }
      val = items.join(', ');
    } else if (val.startsWith('[') && val.endsWith(']')) {
      val = val
        .slice(1, -1)
        .split(',')
        .map((t) => unquote(t.trim()))
        .join(', ');
    } else {
      val = unquote(val);
    }
    meta[key] = val;
  }
  return { meta, body: m[2] ?? '' };
}

function unquote(v: string): string {
  const q = /^(["'])(.*)\1$/.exec(v);
  return q ? q[2]! : v;
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
    if (extname(e.name) !== '.md') continue;
    const path = join(dir, e.name);
    // dotfiles layouts symlink definitions in — follow, but require a REGULAR
    // file (stat follows; a FIFO/dir named *.md is rejected)
    try {
      if (!(await stat(path)).isFile()) continue;
    } catch {
      continue; // dangling
    }
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
    if (extname(e.name) !== '.toml') continue;
    const path = join(dir, e.name);
    try {
      if (!(await stat(path)).isFile()) continue;
    } catch {
      continue; // dangling
    }
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
        tokensEst: Math.ceil(Buffer.byteLength(instructions, 'utf8') / 4), // '' → 0 (present-zero)
        source: { file: path },
        // NO raw: the parsed TOML carries developer_instructions (the PROMPT) —
        // metadata only may cross faces
      });
    } catch {
      /* invalid TOML — skip this definition */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
