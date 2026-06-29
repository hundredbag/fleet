import { existsSync } from 'node:fs';
import {
  readdir,
  readFile,
  mkdir,
  copyFile,
  rm,
  stat,
  readlink,
  symlink,
} from 'node:fs/promises';
import { join, relative, resolve, isAbsolute, sep } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Filesystem helpers for directory-shaped capabilities (skills). Kept small and
 * dependency-free; the engine (writer.ts) adds the safety (backup/atomic/rollback).
 */

/** Join `name` under `root`, refusing names that escape it (path traversal). */
export function safeJoin(root: string, name: string): string {
  if (!name || isAbsolute(name)) throw new Error(`fleet: invalid name "${name}"`);
  const base = resolve(root);
  const target = resolve(base, name);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`fleet: name "${name}" escapes the target root`);
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
 * Content hash of a directory: a manifest of `relpath\0sha256(bytes)` over all
 * regular files, sorted, hashed. Detects content/structure changes for the
 * concurrency + no-op guards. (Blind to mode-only and symlink-only changes —
 * a known limitation, consistent with what the manifest covers.)
 */
export async function hashDir(dir: string): Promise<string> {
  if (!existsSync(dir)) return '';
  const files = await listFilesRecursive(dir);
  const h = createHash('sha256');
  for (const rel of files) {
    const bytes = await readFile(join(dir, rel));
    h.update(rel);
    h.update('\0');
    h.update(createHash('sha256').update(bytes).digest('hex'));
    h.update('\n');
  }
  return h.digest('hex');
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
