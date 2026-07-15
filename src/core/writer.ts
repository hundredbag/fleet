import { homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, rename, copyFile, mkdir, appendFile, rm, open, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { AgentId, Scope } from './types.js';
import type { RenderResult } from './adapter.js';
import { sha256 } from './hash.js';
import { copyDir, hashDir, removeDir } from './fsutil.js';
import { removeLockEntry } from './lock.js';

export type WriteOp = 'install' | 'remove' | 'update';

/** A rendered mutation bound to an agent/op/name — the dry-run unit. */
export interface PlannedChange extends RenderResult {
  agent: AgentId;
  op: WriteOp;
  name: string;
  scope: Scope;
}

export interface ApplyResult {
  change: PlannedChange;
  auditId: string;
  /** backup path, or '' if the file did not exist before */
  backup: string;
  /** what fleet left behind (file: sha256 of content; dir: manifest hash; '' for dir removes) */
  wroteHash: string;
}

/** Validate written content for a change; throw to refuse/trigger restore. */
export type ChangeValidator = (change: PlannedChange, content: string) => void;

export interface ApplyOptions {
  /** state dir for backups + audit log + lock; defaults to ~/.fleet */
  fleetHome?: string;
  /** bypass the "file changed since plan" guard (use with care) */
  force?: boolean;
}

export type RollbackAction = 'restored' | 'removed' | 'skipped';

interface AuditRecord {
  id: string;
  ts: number;
  op: WriteOp | 'rollback';
  agent: string;
  name: string;
  /** capability kind — lets rollback clean the fleet.lock entry */
  kind?: string;
  file: string;
  scope?: string;
  backup: string;
  existedBefore: boolean;
  /** sha256 of what fleet wrote (lets rollback confirm the target is unchanged) */
  wroteHash?: string;
  /** true when the target is a directory (skill) rather than a file */
  isDir?: boolean;
  rolledBackFrom?: string;
}

const DEFAULT_FLEET_HOME = join(homedir(), '.fleet');

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Build a PlannedChange from an adapter's RenderResult. */
export function toPlannedChange(
  agent: AgentId,
  op: WriteOp,
  name: string,
  scope: Scope,
  r: RenderResult,
): PlannedChange {
  return { ...r, agent, op, name, scope };
}

async function appendAudit(home: string, rec: AuditRecord): Promise<void> {
  await mkdir(home, { recursive: true });
  await appendFile(join(home, 'audit.jsonl'), JSON.stringify(rec) + '\n', 'utf8');
}

/** Best-effort fsync of a path (file or directory); ignored if unsupported. */
async function fsyncPath(path: string): Promise<void> {
  let fh;
  try {
    fh = await open(path, 'r');
    await fh.sync();
  } catch {
    /* best effort */
  } finally {
    await fh?.close();
  }
}

/**
 * Write content to `file` durably and atomically (tmp + fsync + rename),
 * preserving the existing file's mode (a 0600 secret-bearing config must not
 * come back 0644 from the default umask). Cleans up the tmp file on failure.
 */
async function writeFileAtomic(file: string, content: string): Promise<void> {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true }); // create a new agent's config dir if needed
  let mode: number | undefined;
  try {
    mode = (await stat(file)).mode & 0o7777;
  } catch {
    /* new file: default mode */
  }
  const tmp = join(dir, `.fleet-tmp-${process.pid}-${randomUUID()}`);
  try {
    const fh = await open(tmp, 'w');
    try {
      // chmod to the EXACT recorded mode — passing mode to open() gets masked
      // by the process umask (0664 would silently lose group-write under 022)
      if (mode !== undefined) await fh.chmod(mode);
      await fh.writeFile(content, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, file);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  await fsyncPath(dir);
}

/** Acquire an exclusive advisory lock under fleetHome; returns a release fn. */
async function acquireLock(home: string): Promise<() => Promise<void>> {
  await mkdir(home, { recursive: true });
  const lockPath = join(home, '.lock');
  let fh;
  try {
    fh = await open(lockPath, 'wx');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`fleet: another operation holds the lock (${lockPath}); remove it if stale`);
    }
    throw err;
  }
  try {
    await fh.writeFile(`${process.pid} ${Date.now()}`);
  } finally {
    await fh.close();
  }
  return async () => {
    await rm(lockPath, { force: true });
  };
}

/**
 * Apply planned changes safely under a lock. For each change:
 *  - refuse to clobber an existing file that doesn't `validate` (parse);
 *  - refuse if the file changed since the plan was made (hash guard);
 *  - back up the current file durably;
 *  - write the new content atomically (tmp + fsync + rename);
 *  - re-read and `validate`; on failure restore the backup (or remove a
 *    newly-created file), failure-safely;
 *  - append an audit record.
 * `validate` is required — the engine owns validation. Changes apply in order;
 * if change N throws, changes 1..N-1 stand (each independently rollback-able).
 */
export async function applyChanges(
  changes: PlannedChange[],
  validate: ChangeValidator,
  opts: ApplyOptions = {},
): Promise<ApplyResult[]> {
  const home = opts.fleetHome ?? DEFAULT_FLEET_HOME;
  const backupsDir = join(home, 'backups');
  await mkdir(backupsDir, { recursive: true });

  const release = await acquireLock(home);
  const results: ApplyResult[] = [];
  try {
    try {
      await applyEach(changes, validate, home, backupsDir, results, opts.force ?? false);
    } catch (err) {
      // surface what was applied before the failure (partial fan-out)
      (err as { applied?: ApplyResult[] }).applied = results;
      throw err;
    }
  } finally {
    await release();
  }
  return results;
}

async function applyEach(
  changes: PlannedChange[],
  validate: ChangeValidator,
  home: string,
  backupsDir: string,
  results: ApplyResult[],
  force: boolean,
): Promise<void> {
  for (const change of changes) {
    if (change.fsKind === 'dir') {
      await applyDirChange(change, home, backupsDir, force, results);
    } else {
      await applyFileChange(change, validate, home, backupsDir, force, results);
    }
  }
}

async function applyFileChange(
  change: PlannedChange,
  validate: ChangeValidator,
  home: string,
  backupsDir: string,
  force: boolean,
  results: ApplyResult[],
): Promise<void> {
  const existedBefore = existsSync(change.file);
  let backup = '';

  if (existedBefore) {
    // every renderer sets baseHash iff the target existed at plan time, so
    // "no baseHash but the file exists now" means it appeared AFTER planning —
    // overwriting it would clobber someone else's file without a backup guard.
    if (!force && change.baseHash === undefined) {
      throw new Error(`fleet: ${change.file} was created after the plan was made; re-plan (or pass force)`);
    }
    const current = await readFile(change.file, 'utf8');
    try {
      validate(change, current);
    } catch (err) {
      throw new Error(`fleet: refusing to write ${change.file}: existing file does not parse (${msg(err)})`);
    }
    if (!force && change.baseHash !== undefined && sha256(current) !== change.baseHash) {
      throw new Error(`fleet: ${change.file} changed since the plan was made; re-plan (or pass force)`);
    }
    backup = join(backupsDir, `${Date.now()}-${process.pid}-${randomUUID()}-${basename(change.file)}.bak`);
    await copyFile(change.file, backup);
    await fsyncPath(backup);
  }

  await writeFileAtomic(change.file, change.newContent);

  try {
    validate(change, await readFile(change.file, 'utf8'));
  } catch (err) {
    try {
      if (existedBefore && backup) await copyFile(backup, change.file);
      else await rm(change.file, { force: true });
    } catch (restoreErr) {
      throw new Error(
        `fleet: validation failed for ${change.file} AND restore failed; ` +
          `backup at ${backup || '(none)'}: ${msg(restoreErr)}`,
      );
    }
    throw new Error(
      `fleet: validation failed for ${change.file}; ` +
        `${existedBefore ? 'restored backup' : 'removed created file'}: ${msg(err)}`,
    );
  }

  const id = `${Date.now()}-${process.pid}-${randomUUID()}`;
  const wroteHash = sha256(change.newContent);
  // push BEFORE the audit append: if the append fails the mutation still
  // happened, and err.applied (set by applyChanges) must reflect reality
  results.push({ change, auditId: id, backup, wroteHash });
  try {
    await appendAudit(home, {
      id,
      ts: Date.now(),
      op: change.op,
      agent: change.agent,
      name: change.name,
      kind: change.kind ?? 'mcp-server',
      file: change.file,
      scope: change.scope,
      backup,
      existedBefore,
      wroteHash,
    });
  } catch (err) {
    // the mutation already happened — say so explicitly and point at the backup
    throw new Error(
      `fleet: ${change.file} WAS updated but the audit log write failed ` +
        `(automatic rollback unavailable; backup at ${backup || '(none — file was new)'}): ${msg(err)}`,
    );
  }
}

/**
 * Apply a directory-shaped change (a skill): same backup → atomic swap →
 * verify → rollback discipline as files. Install validates the STAGED copy
 * before touching the target, so a bad source never replaces a good dir.
 */
async function applyDirChange(
  change: PlannedChange,
  home: string,
  backupsDir: string,
  force: boolean,
  results: ApplyResult[],
): Promise<void> {
  const target = change.file;
  const existedBefore = existsSync(target);
  let backup = '';

  if (existedBefore) {
    // same absent-at-plan race guard as files — remove included: deleting a
    // target the plan never saw is exactly the clobber this guard exists for
    // (renderers set baseHash iff the target existed at plan time)
    if (!force && change.baseHash === undefined) {
      throw new Error(`fleet: ${target} was created after the plan was made; re-plan (or pass force)`);
    }
    if (!force && change.baseHash !== undefined && (await hashDir(target)) !== change.baseHash) {
      throw new Error(`fleet: ${target} changed since the plan was made; re-plan (or pass force)`);
    }
    backup = join(backupsDir, `${Date.now()}-${process.pid}-${randomUUID()}-${basename(target)}.dirbak`);
    await copyDir(target, backup);
    await fsyncPath(backup); // durable backup before we touch the target
  }

  if (change.dirOp === 'remove') {
    if (!existedBefore) throw new Error(`fleet: nothing to remove at ${target}`);
    await removeDir(target);
  } else {
    if (!change.sourceDir) {
      throw new Error(`fleet: dir install for ${target} is missing sourceDir`);
    }
    // 1) stage a full copy beside the target; validate it BEFORE touching target.
    const stage = `${target}.fleet-stage-${process.pid}-${randomUUID()}`;
    try {
      await copyDir(change.sourceDir, stage);
    } catch (err) {
      await removeDir(stage);
      throw new Error(`fleet: failed staging skill copy for ${target}: ${msg(err)}`);
    }
    if (!existsSync(join(stage, 'SKILL.md'))) {
      await removeDir(stage);
      throw new Error(`fleet: skill source ${change.sourceDir} has no SKILL.md`);
    }
    // the preview showed the source AS PLANNED — refuse to install bytes the
    // user never saw (source edited between plan and apply)
    if (change.sourceHash !== undefined && (await hashDir(stage)) !== change.sourceHash) {
      await removeDir(stage);
      throw new Error(`fleet: skill source ${change.sourceDir} changed since the plan was made; re-plan`);
    }
    // 2) swap via two atomic renames so the old tree stays live until the new
    //    one is named (no window where the target is simply gone).
    let oldTmp = '';
    try {
      if (existedBefore) {
        oldTmp = `${target}.fleet-old-${process.pid}-${randomUUID()}`;
        await rename(target, oldTmp);
      }
      await rename(stage, target);
      await fsyncPath(dirname(target));
      if (oldTmp) await removeDir(oldTmp);
    } catch (err) {
      try {
        await removeDir(target);
        await removeDir(stage);
        if (oldTmp && existsSync(oldTmp)) await rename(oldTmp, target);
        else if (existedBefore && backup) await copyDir(backup, target);
      } catch (restoreErr) {
        throw new Error(
          `fleet: dir install failed for ${target} AND restore failed; ` +
            `backup at ${backup || '(none)'}: ${msg(restoreErr)}`,
        );
      }
      throw new Error(
        `fleet: dir install failed for ${target}; ` +
          `${existedBefore ? 'restored backup' : 'removed created dir'}: ${msg(err)}`,
      );
    }
  }

  const id = `${Date.now()}-${process.pid}-${randomUUID()}`;
  const wroteHash = change.dirOp === 'remove' ? '' : await hashDir(target);
  results.push({ change, auditId: id, backup, wroteHash }); // before append — see applyFileChange
  try {
    await appendAudit(home, {
      id,
      ts: Date.now(),
      op: change.op,
      agent: change.agent,
      name: change.name,
      kind: change.kind ?? 'skill',
      file: target,
      scope: change.scope,
      backup,
      existedBefore,
      wroteHash,
      isDir: true,
    });
  } catch (err) {
    throw new Error(
      `fleet: ${target} WAS updated but the audit log write failed ` +
        `(automatic rollback unavailable; backup at ${backup || '(none — dir was new)'}): ${msg(err)}`,
    );
  }
}

/** Read all audit records (oldest first), skipping any corrupt lines. */
export async function readAudit(fleetHome?: string): Promise<AuditRecord[]> {
  const home = fleetHome ?? DEFAULT_FLEET_HOME;
  const file = join(home, 'audit.jsonl');
  if (!existsSync(file)) return [];
  const text = await readFile(file, 'utf8');
  const out: AuditRecord[] = [];
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      out.push(JSON.parse(line) as AuditRecord);
    } catch {
      /* skip a corrupt/partial line rather than disabling all rollback */
    }
  }
  return out;
}

/**
 * Undo a change by audit id, or the most recent change not already rolled back.
 * Restores from backup (edited file) or removes a fleet-created file — but only
 * if the target still matches what fleet wrote; otherwise it skips to avoid
 * destroying a diverged file. Records the rollback. Runs under the lock.
 */
export async function rollback(
  opts: { auditId?: string; fleetHome?: string } = {},
): Promise<{ file: string; action: RollbackAction; reason?: string }> {
  const home = opts.fleetHome ?? DEFAULT_FLEET_HOME;
  const release = await acquireLock(home);
  try {
    const records = await readAudit(home);
    if (records.length === 0) throw new Error('fleet: no audit log to roll back');

    const alreadyUndone = new Set(
      records.map((r) => r.rolledBackFrom).filter((x): x is string => Boolean(x)),
    );
    const target = opts.auditId
      ? records.find((r) => r.id === opts.auditId)
      : [...records].reverse().find((r) => r.op !== 'rollback' && !alreadyUndone.has(r.id));
    if (!target) throw new Error('fleet: no change available to roll back');
    // explicit ids get the same protections as the implicit path: a rollback
    // record is not itself undoable, and undoing the same change twice would
    // clobber whatever happened in between.
    if (target.op === 'rollback') {
      throw new Error(`fleet: ${target.id} is a rollback record; roll back the original change id`);
    }
    if (alreadyUndone.has(target.id)) {
      throw new Error(`fleet: ${target.id} was already rolled back`);
    }

    let action: RollbackAction;
    let reason: string | undefined;

    // divergence guard for EVERY restore/remove: fleet only undoes its own
    // write, so the target must still be in the exact state fleet left it in.
    // For a dir-remove the recorded end-state is "absent"; for everything else
    // it's wroteHash. Anything different (including a user deleting the file,
    // or a file/dir type swap) is divergence — skip, don't clobber/resurrect.
    const divergence = async (): Promise<'diverged' | 'unverifiable' | null> => {
      const expectedAbsent = Boolean(target.isDir) && target.op === 'remove';
      const existsNow = existsSync(target.file);
      if (expectedAbsent) return existsNow ? 'diverged' : null;
      if (!existsNow) return 'diverged'; // fleet left content; user deleted it since
      if (!target.wroteHash) return 'unverifiable'; // old record → safe direction is skip
      try {
        const currentHash = target.isDir
          ? await hashDir(target.file)
          : sha256(await readFile(target.file, 'utf8'));
        return currentHash === target.wroteHash ? null : 'diverged';
      } catch {
        return 'diverged'; // unreadable / type-swapped (file where dir was, …)
      }
    };

    if (target.existedBefore) {
      if (!target.backup || !existsSync(target.backup)) {
        throw new Error(`fleet: backup missing for ${target.id}`);
      }
      const div = await divergence();
      if (div) {
        action = 'skipped';
        reason =
          div === 'diverged'
            ? `${target.isDir ? 'dir' : 'file'} diverged since fleet wrote it; not restoring (backup kept at ${target.backup})`
            : `no recorded write-hash to verify against; not restoring (backup kept at ${target.backup})`;
      } else if (target.isDir) {
        // restore via stage + rename swap so the target never simply vanishes.
        // Only the swap itself can fail the restore — post-swap cleanup is
        // best-effort (a leftover .fleet-old-* must not turn success into a
        // reported failure with no rollback record).
        const stage = `${target.file}.fleet-restore-${process.pid}-${randomUUID()}`;
        let oldTmp = '';
        try {
          await copyDir(target.backup, stage);
          if (existsSync(target.file)) {
            oldTmp = `${target.file}.fleet-old-${process.pid}-${randomUUID()}`;
            await rename(target.file, oldTmp);
          }
          await rename(stage, target.file);
        } catch (restoreErr) {
          await removeDir(stage);
          if (oldTmp && existsSync(oldTmp) && !existsSync(target.file)) {
            await rename(oldTmp, target.file);
          }
          throw new Error(
            `fleet: rollback restore failed for ${target.file}; ` +
              `backup at ${target.backup}: ${msg(restoreErr)}`,
          );
        }
        await fsyncPath(dirname(target.file)); // best-effort (swallows internally)
        if (oldTmp) {
          try {
            await removeDir(oldTmp);
          } catch {
            reason = `restored; stale ${oldTmp} left behind (cleanup failed)`;
          }
        }
        action = 'restored';
      } else {
        await writeFileAtomic(target.file, await readFile(target.backup, 'utf8'));
        action = 'restored';
      }
    } else if (!existsSync(target.file)) {
      action = 'skipped';
      reason = `${target.isDir ? 'dir' : 'file'} already absent`;
    } else {
      const div = await divergence();
      if (div) {
        action = 'skipped';
        reason =
          div === 'diverged'
            ? `${target.isDir ? 'dir' : 'file'} diverged since fleet created it; not removing`
            : `no recorded write-hash to verify against; not removing`;
      } else if (target.isDir) {
        await removeDir(target.file);
        action = 'removed';
      } else {
        await rm(target.file, { force: true });
        action = 'removed';
      }
    }

    try {
      await appendAudit(home, {
        id: `${Date.now()}-${process.pid}-${randomUUID()}`,
        ts: Date.now(),
        op: 'rollback',
        agent: target.agent,
        name: target.name,
        file: target.file,
        scope: target.scope,
        backup: '',
        existedBefore: target.existedBefore,
        wroteHash: target.wroteHash,
        rolledBackFrom: target.id,
      });
    } catch (err) {
      throw new Error(
        `fleet: rollback of ${target.file} SUCCEEDED (${action}) but recording it failed — ` +
          `do NOT re-run this rollback; audit error: ${msg(err)}`,
      );
    }

    if (action !== 'skipped' && target.kind) {
      try {
        // fleet no longer knows the provenance of what rollback left behind
        await removeLockEntry(target.kind, target.name, target.agent, home);
      } catch {
        /* lock is metadata — never fail a completed rollback over it */
      }
    }

    return { file: target.file, action, reason };
  } finally {
    await release();
  }
}
