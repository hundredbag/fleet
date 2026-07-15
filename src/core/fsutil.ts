import { existsSync, realpathSync } from 'node:fs';
import { readdir, readFile, mkdir, copyFile, rm, stat, lstat, readlink, symlink } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute, sep, dirname } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Filesystem helpers for directory-shaped capabilities (skills). Kept small and
 * dependency-free; the engine (writer.ts) adds the safety (backup/atomic/rollback).
 */

/** Deepest existing ancestor of `p` (including `p` itself), resolved physically. */
function realExistingAncestor(p: string): string {
  let cur = p;
  while (!existsSync(cur)) {
    const parent = dirname(cur);
    if (parent === cur) break; // filesystem root
    cur = parent;
  }
  return realpathSync(cur);
}

/**
 * Join `name` under `root`, refusing names that escape it. Two layers:
 * lexical (no absolute names, no `..` resolution outside root) and PHYSICAL —
 * the deepest existing ancestor of the target must resolve (through symlinks)
 * to somewhere under the real root, so a symlinked subdirectory can't redirect
 * writes outside the tree.
 */
export function safeJoin(root: string, name: string): string {
  if (!name || isAbsolute(name)) throw new Error(`fleet: invalid name "${name}"`);
  const base = resolve(root);
  const target = resolve(base, name);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`fleet: name "${name}" escapes the target root`);
  }
  if (existsSync(base)) {
    const realBase = realpathSync(base);
    const realAnc = realExistingAncestor(target);
    if (realAnc !== realBase && !realAnc.startsWith(realBase + sep)) {
      throw new Error(`fleet: name "${name}" resolves outside the target root (symlink)`);
    }
  }
  return target;
}

/** List every file under `dir` (recursively) as paths relative to `dir`, sorted. */
export async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(d: string): Promise<void> {
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const full = join(d, e.name);
      if (e.isDirectory()) await walk(full);
      else if (e.isFile()) out.push(relative(dir, full));
      // symlinks are not followed here (avoids escaping the tree / cycles)
    }
  }
  await walk(dir);
  return out.sort();
}

/**
 * Recursively copy a directory tree from `src` to `dst`, preserving files
 * (incl. their mode), symlinks (recreated verbatim), and empty directories.
 */
export async function copyDir(src: string, dst: string): Promise<void> {
  await mkdir(dst, { recursive: true });
  const entries = await readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = join(src, e.name);
    const d = join(dst, e.name);
    if (e.isSymbolicLink()) await symlink(await readlink(s), d);
    else if (e.isDirectory()) await copyDir(s, d);
    else if (e.isFile()) await copyFile(s, d);
  }
}

/**
 * Content hash of a directory: a sorted manifest over EVERY entry —
 * `F relpath mode sha256(bytes)` for files, `L relpath -> linktarget` for
 * symlinks, `D relpath` for directories (so empty dirs count) — hashed.
 * Mode-only, symlink-target and structure changes all alter the hash, which is
 * what the concurrency, no-op and rollback-divergence guards need.
 */
export async function hashDir(dir: string): Promise<string> {
  if (!existsSync(dir)) return '';
  const lines: string[] = [];
  async function walk(d: string): Promise<void> {
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const full = join(d, e.name);
      const rel = relative(dir, full);
      if (e.isSymbolicLink()) {
        lines.push(`L ${rel} -> ${await readlink(full)}`);
      } else if (e.isDirectory()) {
        lines.push(`D ${rel}`);
        await walk(full);
      } else if (e.isFile()) {
        const mode = ((await lstat(full)).mode & 0o7777).toString(8);
        const digest = createHash('sha256')
          .update(await readFile(full))
          .digest('hex');
        lines.push(`F ${rel} ${mode} ${digest}`);
      }
    }
  }
  await walk(dir);
  lines.sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

export async function removeDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

export async function isDir(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}
