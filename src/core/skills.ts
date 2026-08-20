import { existsSync } from 'node:fs';
import { readdir, readFile, realpath, stat, lstat } from 'node:fs/promises';
import { join, relative, sep, resolve } from 'node:path';
import type { SkillCapability } from './types.js';
import type { CapabilityRef, RenderResult, SkillSource } from './adapter.js';
import { hashDir, hashMaterializedDir, safeJoin } from './fsutil.js';

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
export async function listSkillDirs(
  root: string,
  opts: { allowedRoots?: string[]; strict?: boolean } = {},
): Promise<{ name: string; path: string }[]> {
  try {
    const rootInfo = await lstat(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      if (opts.strict) throw new Error(`skills root is not a regular directory: ${root}`);
      return [];
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    if (opts.strict) throw error;
    return [];
  }
  const out: { name: string; path: string }[] = [];
  const visited = new Set<string>(); // realpath cycle guard for symlinked dirs
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch (error) {
    if (opts.strict) throw error;
    return [];
  }
  const allowed = [realRoot];
  for (const r of opts.allowedRoots ?? []) {
    try {
      allowed.push(await realpath(r));
    } catch (error) {
      if (opts.strict && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      /* absent allowed root */
    }
  }
  // ponytail: depth cap bounds hostile link-chains; real skill trees are shallow
  const MAX_DEPTH = 8;
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) return;
    let real;
    try {
      real = await realpath(dir);
    } catch (error) {
      if (opts.strict && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return; // dangling symlink
    }
    if (visited.has(real)) return;
    visited.add(real);
    // CONTAINMENT: only walk trees under the skills root or an explicitly
    // allowed shared root (~/.agents/skills) — a planted link to $HOME or an
    // ancestor must not turn inventory into a filesystem crawl
    if (!allowed.some((a) => real === a || real.startsWith(a + sep))) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (opts.strict) throw error;
      return;
    }
    // SKILL.md must be a REGULAR file (a FIFO here would block inventory forever)
    let hasSkillMd = false;
    try {
      // lstat: a TERMINAL SKILL.md symlink could point outside containment —
      // require a real regular file (dir-level links are the interop path)
      hasSkillMd = (await lstat(join(dir, 'SKILL.md'))).isFile();
    } catch (error) {
      if (opts.strict && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      hasSkillMd = false;
    }
    if (hasSkillMd) {
      out.push({ name: relative(root, dir).split(sep).join('/'), path: dir });
      return; // a skill dir — don't descend into it
    }
    for (const e of entries) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) {
        await walk(join(dir, e.name), depth + 1);
      } else if (e.isSymbolicLink()) {
        // npx skills add installs into ~/.agents/skills and SYMLINKS into the
        // agent's skills dir — follow dir-links or those skills are invisible
        try {
          if ((await stat(join(dir, e.name))).isDirectory()) await walk(join(dir, e.name), depth + 1);
        } catch (error) {
          if (opts.strict && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          /* dangling — skip */
        }
      }
    }
  }
  await walk(root, 0);
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

export async function readSkillMeta(
  skillDir: string,
  opts: { strict?: boolean } = {},
): Promise<SkillMeta & { tokensEst?: number }> {
  try {
    const text = await readFile(join(skillDir, 'SKILL.md'), 'utf8');
    // bytes/4 ≈ tokens — a deliberately rough, comparable number
    return { ...parseSkillFrontmatter(text), tokensEst: Math.ceil(Buffer.byteLength(text, 'utf8') / 4) };
  } catch (error) {
    if (opts.strict) throw error;
    return {};
  }
}

/** Read all skills installed for an agent under `skillsRoot`. */
export async function readSkillsInventory(
  agent: string,
  skillsRoot: string,
  opts: { allowedRoots?: string[]; strict?: boolean } = {},
): Promise<SkillCapability[]> {
  const dirs = await listSkillDirs(skillsRoot, opts);
  const out: SkillCapability[] = [];
  for (const d of dirs) {
    const { tokensEst, ...meta } = await readSkillMeta(d.path, { strict: opts.strict });
    out.push({
      kind: 'skill',
      name: d.name,
      agent,
      scope: 'user',
      enabled: true,
      path: d.path,
      meta,
      tokensEst,
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
    kind: 'skill',
    fsKind: 'dir',
    dirOp: 'install',
    sourceDir: source.dir,
    sourceHash: await hashMaterializedDir(source.dir), // pin the tree copyDir will materialize
    newContent: '', // unused for dir kind
    before: exists ? ref.name : undefined,
    after: ref.name,
    baseHash: exists ? await hashDir(target) : undefined,
  };
}

export async function renderSkillRemove(skillsRoot: string, ref: CapabilityRef): Promise<RenderResult> {
  // a symlinked skill was planted by an external tool (npx skills add) — say
  // so instead of the hostile-shaped safeJoin rejection. Lexical containment
  // FIRST: a traversal name must never reach the probe (or the friendly error
  // would name an arbitrary out-of-root path).
  try {
    const base = resolve(skillsRoot);
    const direct = resolve(base, ref.name);
    if (direct !== base && !direct.startsWith(base + sep)) {
      throw new Error(`fleet: invalid name "${ref.name}"`);
    }
    const st = await lstat(direct);
    if (st.isSymbolicLink()) {
      throw new Error(
        `fleet: skill "${ref.name}" is a symlink installed by an external tool (npx skills add?) — remove the link itself: rm ${direct}`,
      );
    }
  } catch (e) {
    if (e instanceof Error && e.message.startsWith('fleet:')) throw e;
    /* ENOENT etc — fall through to the normal path */
  }
  const target = safeJoin(skillsRoot, ref.name);
  if (!existsSync(target)) throw new Error(`skill "${ref.name}" is not installed`);
  return {
    file: target,
    kind: 'skill',
    fsKind: 'dir',
    dirOp: 'remove',
    newContent: '', // unused for dir kind
    before: ref.name,
    baseHash: await hashDir(target),
  };
}
