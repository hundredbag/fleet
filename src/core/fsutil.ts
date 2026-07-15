import { existsSync, lstatSync } from 'node:fs';
import { readdir, readFile, mkdir, copyFile, rm, stat, lstat, readlink, symlink } from 'node:fs/promises';
import { join, relative, resolve, isAbsolute, sep, dirname } from 'node:path';
import { createHash } from 'node:crypto';

/**
 * Filesystem helpers for directory-shaped capabilities (skills). Kept small and
 * dependency-free; the engine (writer.ts) adds the safety (backup/atomic/rollback).
 */

/**
 * Join `name` under `root`, refusing names that escape it. Two layers:
 * lexical (no absolute names, no `..` resolution outside root) and PHYSICAL —
 * NO component strictly below the root may be a symlink (lstat, no-follow, so
 * dangling links count too: a link to a not-yet-existing outside dir would
 * otherwise redirect the write once its referent appears). The root itself may
 * be a symlink (users legitimately symlink their skills dir).
 * ponytail: checked at plan time; a link planted between plan and apply is a
 * local-user TOCTOU that only fd-relative no-follow ops would close.
 */
export function safeJoin(root: string, name: string): string {
  if (!name || isAbsolute(name)) throw new Error(`fleet: invalid name "${name}"`);
  const base = resolve(root);
  const target = resolve(base, name);
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`fleet: name "${name}" escapes the target root`);
  }
  // collect target and every ancestor strictly below base, then check each
  const components: string[] = [];
  for (let cur = target; cur !== base; cur = dirname(cur)) components.push(cur);
  for (const p of components.reverse()) {
    try {
      if (lstatSync(p).isSymbolicLink()) {
        throw new Error(`fleet: name "${name}" resolves outside the target root (symlink)`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') break; // nothing deeper exists yet
      throw err;
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
      // JSON-encoded fields — a filename containing \n or a crafted "L x -> y"
      // suffix cannot collide with another tree's manifest
      if (e.isSymbolicLink()) {
        lines.push(JSON.stringify(['L', rel, await readlink(full)]));
      } else if (e.isDirectory()) {
        const mode = ((await lstat(full)).mode & 0o7777).toString(8);
        lines.push(JSON.stringify(['D', rel, mode]));
        await walk(full);
      } else if (e.isFile()) {
        const mode = ((await lstat(full)).mode & 0o7777).toString(8);
        const digest = createHash('sha256')
          .update(await readFile(full))
          .digest('hex');
        lines.push(JSON.stringify(['F', rel, mode, digest]));
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
