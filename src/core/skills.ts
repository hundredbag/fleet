import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { SkillCapability } from './types.js';
import type { CapabilityRef, RenderResult, SkillSource } from './adapter.js';
import { hashDir, safeJoin } from './fsutil.js';

/**
 * Skills are directory-shaped capabilities (a dir containing SKILL.md). Reading
 * + render helpers shared by every agent adapter; the engine (writer.ts) does
 * the safe directory swap.
 */

export interface SkillMeta {
  description?: string;
  version?: string;
}

/** Minimal SKILL.md YAML-frontmatter parse (description/version only). */
export function parseSkillFrontmatter(text: string): SkillMeta {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const meta: SkillMeta = {};
  for (const line of (m[1] ?? '').split(/\r?\n/)) {
    const kv = line.match(/^(description|version)\s*:\s*(.*)$/);
    if (kv) {
      const value = (kv[2] ?? '').trim().replace(/^["']|["']$/g, '');
      if (kv[1] === 'description') meta.description = value;
      else meta.version = value;
    }
  }
  return meta;
}

/**
 * Find skill directories under `root` (a dir is a skill if it contains
 * SKILL.md). Handles flat (`x/SKILL.md`) and grouped (`apple/apple-notes/…`)
 * layouts; the skill name is the posix relpath from root. Dotted dirs (e.g.
 * Codex `.system`) are skipped (builtins, not user skills).
 */
export async function listSkillDirs(root: string): Promise<{ name: string; path: string }[]> {
  if (!existsSync(root)) return [];
  const out: { name: string; path: string }[] = [];
  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === 'SKILL.md')) {
      out.push({ name: relative(root, dir).split(sep).join('/'), path: dir });
      return; // a skill dir — don't descend into it
    }
    for (const e of entries) {
      if (e.isDirectory() && !e.name.startsWith('.')) await walk(join(dir, e.name));
    }
  }
  await walk(root);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readSkillMeta(skillDir: string): Promise<SkillMeta> {
  try {
    return parseSkillFrontmatter(await readFile(join(skillDir, 'SKILL.md'), 'utf8'));
  } catch {
    return {};
  }
}

/** Read all skills installed for an agent under `skillsRoot`. */
export async function readSkillsInventory(
  agent: string,
  skillsRoot: string,
): Promise<SkillCapability[]> {
  const dirs = await listSkillDirs(skillsRoot);
  const out: SkillCapability[] = [];
  for (const d of dirs) {
    out.push({
      kind: 'skill',
      name: d.name,
      agent,
      scope: 'user',
      enabled: true,
      path: d.path,
      meta: await readSkillMeta(d.path),
      source: { file: d.path },
    });
  }
  return out;
}

export async function renderSkillInstall(
  skillsRoot: string,
  source: SkillSource,
  ref: CapabilityRef,
): Promise<RenderResult> {
  if (!existsSync(join(source.dir, 'SKILL.md'))) {
    throw new Error(`skill source ${source.dir} has no SKILL.md`);
  }
  const target = safeJoin(skillsRoot, ref.name);
  const exists = existsSync(target);
  return {
    file: target,
    fsKind: 'dir',
    dirOp: 'install',
    sourceDir: source.dir,
    newContent: '', // unused for dir kind
    before: exists ? ref.name : undefined,
    after: ref.name,
    baseHash: exists ? await hashDir(target) : undefined,
  };
}

export async function renderSkillRemove(
  skillsRoot: string,
  ref: CapabilityRef,
): Promise<RenderResult> {
  const target = safeJoin(skillsRoot, ref.name);
  if (!existsSync(target)) throw new Error(`skill "${ref.name}" is not installed`);
  return {
    file: target,
    fsKind: 'dir',
    dirOp: 'remove',
    newContent: '', // unused for dir kind
    before: ref.name,
    baseHash: await hashDir(target),
  };
}
