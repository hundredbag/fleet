import { homedir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { existsSync } from 'node:fs';
import {
  readFile,
  rename,
  copyFile,
  mkdir,
  appendFile,
  rm,
  open,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { AgentId, Scope } from './types.js';
import type { RenderResult } from './adapter.js';
import { sha256 } from './hash.js';

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
  file: string;
  scope?: string;
  backup: string;
  existedBefore: boolean;
  /** sha256 of what fleet wrote (lets rollback confirm the file is unchanged) */
  wroteHash?: string;
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

/** Write content to `file` durably and atomically (tmp + fsync + rename). */
async function writeFileAtomic(file: string, content: string): Promise<void> {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true }); // create a new agent's config dir if needed
  const tmp = join(dir, `.fleet-tmp-${process.pid}-${randomUUID()}`);
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(content, 'utf8');
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, file);
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
      throw new Error(
        `fleet: another operation holds the lock (${lockPath}); remove it if stale`,
      );
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
    {
      const existedBefore = existsSync(change.file);
      let backup = '';

      if (existedBefore) {
        const current = await readFile(change.file, 'utf8');
        try {
          validate(change, current);
        } catch (err) {
          throw new Error(
            `fleet: refusing to write ${change.file}: existing file does not parse (${msg(err)})`,
          );
        }
        if (!force && change.baseHash !== undefined && sha256(current) !== change.baseHash) {
          throw new Error(
            `fleet: ${change.file} changed since the plan was made; re-plan (or pass force)`,
          );
        }
        backup = join(
          backupsDir,
          `${Date.now()}-${process.pid}-${randomUUID()}-${basename(change.file)}.bak`,
        );
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
      await appendAudit(home, {
        id,
        ts: Date.now(),
        op: change.op,
        agent: change.agent,
        name: change.name,
        file: change.file,
        scope: change.scope,
        backup,
        existedBefore,
        wroteHash: sha256(change.newContent),
      });
      results.push({ change, auditId: id, backup });
    }
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
 * if it still matches what fleet wrote; otherwise it skips to avoid destroying
 * a diverged file. Records the rollback. Runs under the lock.
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

    let action: RollbackAction;
    let reason: string | undefined;

    if (target.existedBefore) {
      if (!target.backup || !existsSync(target.backup)) {
        throw new Error(`fleet: backup missing for ${target.id}`);
      }
      await writeFileAtomic(target.file, await readFile(target.backup, 'utf8'));
      action = 'restored';
    } else if (!existsSync(target.file)) {
      action = 'skipped';
      reason = 'file already absent';
    } else {
      const current = await readFile(target.file, 'utf8');
      if (target.wroteHash && sha256(current) !== target.wroteHash) {
        action = 'skipped';
        reason = 'file diverged since fleet created it; not removing';
      } else {
        await rm(target.file, { force: true });
        action = 'removed';
      }
    }

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

    return { file: target.file, action, reason };
  } finally {
    await release();
  }
}
