import { constants, existsSync, lstatSync } from 'node:fs';
import { chmod, readdir, mkdir, rm, stat, lstat, readlink, symlink, open, realpath } from 'node:fs/promises';
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

async function readRegularSnapshot(path: string): Promise<{ bytes: Buffer; mode: number }> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`fleet: unsupported directory entry type at ${path}`);
    return { bytes: await handle.readFile(), mode: info.mode & 0o7777 };
  } finally {
    await handle.close();
  }
}

async function writeRegularSnapshot(path: string, snapshot: { bytes: Buffer; mode: number }): Promise<void> {
  const handle = await open(path, 'wx', 0o600);
  try {
    await handle.writeFile(snapshot.bytes);
    await handle.sync();
    await handle.chmod(snapshot.mode);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Recursively copy a directory tree from `src` to `dst`, preserving files
 * (incl. their mode), symlinks (recreated verbatim), and empty directories.
 */
export async function copyDir(src: string, dst: string): Promise<void> {
  const srcMode = (await stat(src)).mode & 0o7777;
  await mkdir(dst, { recursive: true, mode: srcMode });
  const entries = await readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = join(src, e.name);
    const d = join(dst, e.name);
    // Re-check the pathname without following it. Dirent d_type can be absent
    // or synthesized by a filesystem/sandbox and must not classify a device,
    // FIFO, or socket as a regular file that copyFile/readFile could block on.
    const info = await lstat(s);
    if (info.isSymbolicLink()) await symlink(await readlink(s), d);
    else if (info.isDirectory()) await copyDir(s, d);
    else if (info.isFile()) {
      await writeRegularSnapshot(d, await readRegularSnapshot(s));
    } else {
      throw new Error(`fleet: unsupported directory entry type at ${s}`);
    }
  }
  // mkdir modes are filtered by umask; set the exact source mode after the
  // children exist so backups/staging preserve directory permissions too.
  await chmod(dst, srcMode);
  const handle = await open(dst, 'r');
  try {
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EBADF') throw error;
  } finally {
    await handle.close();
  }
}

export class ExclusiveDirectoryCopyError extends Error {
  constructor(
    message: string,
    /** True once this operation atomically created the destination root. */
    readonly targetCreated: boolean,
  ) {
    super(message);
  }
}

/** Copy a directory into a destination that must not already exist. Every
 * child is also created exclusively, so a concurrent entry is never replaced.
 * The destination can be partially populated on failure; targetCreated tells
 * the caller to retain its write-ahead recovery marker instead of deleting a
 * tree that may now contain concurrent state. */
export async function copyDirExclusive(src: string, dst: string): Promise<void> {
  let targetCreated = false;
  try {
    const rootInfo = await lstat(src);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      throw new Error(`fleet: refusing to publish non-directory source ${src}`);
    }
    const rootMode = rootInfo.mode & 0o7777;
    await mkdir(dst, { mode: 0o700 });
    targetCreated = true;

    const copyContents = async (source: string, destination: string): Promise<void> => {
      const entries = await readdir(source, { withFileTypes: true });
      for (const entry of entries) {
        const from = join(source, entry.name);
        const to = join(destination, entry.name);
        const info = await lstat(from);
        if (info.isSymbolicLink()) {
          await symlink(await readlink(from), to);
        } else if (info.isDirectory()) {
          const mode = info.mode & 0o7777;
          await mkdir(to, { mode: 0o700 });
          await copyContents(from, to);
          await chmod(to, mode);
          const handle = await open(to, 'r');
          try {
            await handle.sync();
          } finally {
            await handle.close();
          }
        } else if (info.isFile()) {
          await writeRegularSnapshot(to, await readRegularSnapshot(from));
        } else {
          throw new Error(`fleet: unsupported directory entry type at ${from}`);
        }
      }
    };

    await copyContents(src, dst);
    await chmod(dst, rootMode);
    const handle = await open(dst, 'r');
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    throw new ExclusiveDirectoryCopyError(
      error instanceof Error ? error.message : String(error),
      targetCreated,
    );
  }
}

/**
 * Content hash of a directory: a sorted manifest over EVERY entry —
 * `F relpath mode sha256(bytes)` for files, `L relpath -> linktarget` for
 * symlinks, `D relpath` for directories (so empty dirs count) — hashed.
 * Mode-only, symlink-target and structure changes all alter the hash, which is
 * what the concurrency, no-op and rollback-divergence guards need.
 */
async function hashDirectory(dir: string, includeRootMode: boolean): Promise<string> {
  if (!existsSync(dir)) return '';
  const lines: string[] = [];
  if (includeRootMode) {
    const rootMode = ((await lstat(dir)).mode & 0o7777).toString(8);
    lines.push(JSON.stringify(['D', '.', rootMode]));
  }
  async function walk(d: string): Promise<void> {
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const full = join(d, e.name);
      const rel = relative(dir, full);
      const info = await lstat(full);
      // JSON-encoded fields — a filename containing \n or a crafted "L x -> y"
      // suffix cannot collide with another tree's manifest
      if (info.isSymbolicLink()) {
        lines.push(JSON.stringify(['L', rel, await readlink(full)]));
      } else if (info.isDirectory()) {
        const mode = (info.mode & 0o7777).toString(8);
        lines.push(JSON.stringify(['D', rel, mode]));
        await walk(full);
      } else if (info.isFile()) {
        const snapshot = await readRegularSnapshot(full);
        const mode = snapshot.mode.toString(8);
        const digest = createHash('sha256').update(snapshot.bytes).digest('hex');
        lines.push(JSON.stringify(['F', rel, mode, digest]));
      } else {
        throw new Error(`fleet: unsupported directory entry type at ${full}`);
      }
    }
  }
  await walk(dir);
  lines.sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

/** Current directory hash includes the root directory mode as well as every child. */
export async function hashDir(dir: string): Promise<string> {
  return hashDirectory(dir, true);
}

/** Hash the directory generation that copyDir() would materialize. A
 * symlinked source root is followed by copyDir(), so its referent directory
 * mode—not the symlink inode mode—must be part of the pinned source hash.
 * Symlinks below the root remain entries and are never followed. */
export async function hashMaterializedDir(dir: string): Promise<string> {
  return hashDirectory(await realpath(dir), true);
}

/** Read compatibility for canonical-v1 skill lock entries created before root
 * mode became part of the manifest. New writes must always use hashDir(). */
export async function hashDirLegacy(dir: string): Promise<string> {
  return hashDirectory(dir, false);
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
