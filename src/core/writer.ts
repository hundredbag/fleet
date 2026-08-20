import { join, dirname, basename, resolve } from 'node:path';
import { constants, existsSync } from 'node:fs';
import { chmod, link, lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { AgentId, Scope } from './types.js';
import type { RenderResult } from './adapter.js';
import { sha256 } from './hash.js';
import { copyDir, copyDirExclusive, ExclusiveDirectoryCopyError, hashDir, removeDir } from './fsutil.js';
import { removeLockEntry } from './lock.js';
import { assertMutationConfigReadable, fleetHomeDir } from './config.js';
import { isTrustReasonCode, type TrustSnapshot } from './trustgate.js';

export type WriteOp = 'install' | 'remove' | 'update';

/** A rendered mutation bound to an agent/op/name — the dry-run unit. */
export interface PlannedChange extends RenderResult {
  agent: AgentId;
  op: WriteOp;
  name: string;
  scope: Scope;
  /** agent-independent canonical form (the SPEC/body, not the native rendering)
   * — what fleet.lock hashes, so drift can compare against live inventory */
  canonical?: unknown;
  /** Decision-time, stable-code trust evidence persisted in audit history. */
  trust?: TrustSnapshot;
}

export interface ApplyResult {
  change: PlannedChange;
  auditId: string;
  /** False only when the filesystem mutation completed but its audit append
   * failed. Such a result is real applied state, but is not automatically
   * rollback-eligible and must never be presented as normal provenance. */
  auditRecorded: boolean;
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
  /** Validate shared state after acquiring the operation lock but before any
   * target mutation. Public orchestration uses this to fail closed when
   * provenance is already damaged. */
  beforeApplyLocked?: () => Promise<void>;
  /** Fold mutation metadata before releasing the shared operation lock. Called
   * for both complete and partial applies so read-modify-write state cannot race
   * a subsequent mutation. */
  whileLocked?: (applied: ApplyResult[]) => Promise<void>;
}

export type RollbackAction = 'restored' | 'removed' | 'skipped';

export interface RollbackGuardRefusal {
  reasonCode:
    | 'CORE_HISTORY_UNVERIFIABLE'
    | 'DELEGATED_HISTORY_UNVERIFIABLE'
    | 'DELEGATED_OUTCOME_PENDING'
    | 'LATEST_CHANGE_DELEGATED';
  suggestedTool?: 'plugin_install' | 'plugin_remove';
  recoveryClass?: 'vendor-state-inspection' | 'audit-history-repair';
}

export interface AuditRecord {
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
  /** Hash of the durable backup captured before mutation. */
  backupHash?: string;
  /** Exact prior file mode; directory modes are included in backupHash. */
  backupMode?: number;
  /** Exact mode Fleet left on a file; directory modes are included in wroteHash. */
  wroteMode?: number;
  rolledBackFrom?: string;
  trust?: TrustSnapshot;
}

const AUDIT_PENDING_DIR = 'audit-pending';

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Pathname existence without following a leaf symlink. Unknown/unreadable is
 * treated as present so mutation code takes the fail-closed branch. */
async function pathEntryExistsNoFollow(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== 'ENOENT';
  }
}

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
  await mkdir(home, { recursive: true, mode: 0o700 });
  const file = join(home, 'audit.jsonl');
  const handle = await open(
    file,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    if (!(await handle.stat()).isFile()) throw new Error('fleet: audit history is not a regular file');
    await handle.chmod(0o600);
    await handle.writeFile(JSON.stringify(rec) + '\n', 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  // The record is the authoritative completion boundary. Persist both the
  // audit filename and a possibly-new Fleet home before its pending marker is
  // removed; otherwise a power loss can erase both sources of outcome truth.
  await fsyncDirectoryChainDurable(home);
}

interface PendingAuditRecord {
  id: string;
  ts: number;
  op: WriteOp | 'rollback';
  agent: string;
  name: string;
  kind: string;
  file: string;
  scope: Scope;
  backup: string;
  existedBefore: boolean;
  isDir?: true;
  backupHash?: string;
  backupMode?: number;
  rolledBackFrom?: string;
}

function isPendingAuditRecord(value: unknown): value is PendingAuditRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.id === 'string' &&
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(record.id) &&
    typeof record.ts === 'number' &&
    Number.isFinite(record.ts) &&
    (record.op === 'install' ||
      record.op === 'remove' ||
      record.op === 'update' ||
      record.op === 'rollback') &&
    typeof record.agent === 'string' &&
    typeof record.name === 'string' &&
    typeof record.kind === 'string' &&
    typeof record.file === 'string' &&
    (record.scope === 'user' || record.scope === 'project' || record.scope === 'local') &&
    typeof record.backup === 'string' &&
    typeof record.existedBefore === 'boolean' &&
    (record.isDir === undefined || record.isDir === true) &&
    (record.backupHash === undefined ||
      (typeof record.backupHash === 'string' && /^[a-f0-9]{64}$/i.test(record.backupHash))) &&
    (record.backupMode === undefined ||
      (Number.isInteger(record.backupMode) &&
        (record.backupMode as number) >= 0 &&
        (record.backupMode as number) <= 0o7777)) &&
    (record.op === 'rollback'
      ? typeof record.rolledBackFrom === 'string'
      : record.rolledBackFrom === undefined)
  );
}

async function writePendingAudit(home: string, record: PendingAuditRecord): Promise<void> {
  const dir = join(home, AUDIT_PENDING_DIR);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error('fleet: audit recovery history is unavailable');
  }
  await chmod(dir, 0o700);
  const file = join(dir, `${record.id}.json`);
  const handle = await open(file, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(record)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(file, 0o600);
  // Bottom-up: marker bytes -> marker filename -> pending-dir filename ->
  // Fleet-home filename. The target is not touched until this completes.
  await fsyncDirectoryChainDurable(dir);
}

async function clearPendingAudit(home: string, id: string): Promise<void> {
  const dir = join(home, AUDIT_PENDING_DIR);
  await rm(join(dir, `${id}.json`), { force: true });
  await fsyncPathBestEffort(dir);
}

async function readPendingAudits(
  home: string,
  completedIds: ReadonlySet<string>,
): Promise<{ count: number; status: 'available' | 'unavailable' | 'malformed' }> {
  const dir = join(home, AUDIT_PENDING_DIR);
  try {
    const info = await lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) return { count: 0, status: 'unavailable' };
    const entries = await readdir(dir, { withFileTypes: true });
    let count = 0;
    let malformed = false;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        malformed = true;
        continue;
      }
      const file = join(dir, entry.name);
      const { content: text } = await readRegularFileNoFollow(file);
      if (text.length > 64 * 1024) {
        malformed = true;
        continue;
      }
      let record: PendingAuditRecord | undefined;
      try {
        const value: unknown = JSON.parse(text);
        if (isPendingAuditRecord(value)) record = value;
      } catch {
        // malformed below
      }
      if (!record || entry.name !== `${record.id}.json`) {
        malformed = true;
        continue;
      }
      if (completedIds.has(record.id)) {
        continue;
      }
      count++;
    }
    return { count, status: malformed ? 'malformed' : 'available' };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { count: 0, status: 'available' }
      : { count: 0, status: 'unavailable' };
  }
}

/** Best-effort namespace cleanup only. Mutation durability must use the strict
 * directory-chain helper and surface real I/O failures. */
async function fsyncPathBestEffort(path: string): Promise<void> {
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

/** Strict durability boundary for write-ahead/completion metadata. Directory
 * fsync being unsupported is tolerated, but ordinary access/I/O failures are
 * surfaced so mutation stops (or is reported as applied-but-unrecorded). */
async function fsyncDirectoryDurable(path: string): Promise<void> {
  let fh;
  try {
    fh = await open(path, 'r');
    await fh.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const unsupported = code === 'EINVAL' || code === 'ENOTSUP' || code === 'EBADF';
    const windowsDirectoryOpen =
      process.platform === 'win32' && (code === 'EISDIR' || code === 'EPERM' || code === 'EACCES');
    if (!unsupported && !windowsDirectoryOpen) throw error;
  } finally {
    await fh?.close();
  }
}

/** Persist `path` and every ancestor namespace. This covers a recursive mkdir
 * that created more than one previously-missing parent: syncing only the leaf
 * directory would not make the leaf's own name (or its new ancestors) durable. */
async function fsyncDirectoryChainDurable(path: string): Promise<void> {
  let current = resolve(path);
  for (;;) {
    await fsyncDirectoryDurable(current);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function readRegularFileNoFollow(path: string): Promise<{ content: string; mode: number }> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`fleet: refusing non-regular file ${path}`);
    return { content: await handle.readFile('utf8'), mode: info.mode & 0o7777 };
  } finally {
    await handle.close();
  }
}

async function writeBackupFile(path: string, content: string, mode: number): Promise<void> {
  const handle = await open(path, 'wx', mode);
  try {
    await handle.chmod(mode);
    await handle.writeFile(content, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/** Build and fsync a regular file beside its eventual target. The caller must
 * publish it with commitStagedFile(), which never overwrites an unverified
 * pathname. */
async function stageFile(file: string, content: string, exactMode: number): Promise<string> {
  const dir = dirname(file);
  await mkdir(dir, { recursive: true, mode: 0o700 }); // secret-bearing agent config root
  const tmp = join(dir, `.fleet-tmp-${process.pid}-${randomUUID()}`);
  try {
    const fh = await open(tmp, 'wx', exactMode);
    try {
      // chmod to the EXACT recorded mode — passing mode to open() gets masked
      // by the process umask (0664 would silently lose group-write under 022)
      await fh.chmod(exactMode);
      await fh.writeFile(content, 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  return tmp;
}

class FileCommitError extends Error {
  constructor(
    message: string,
    readonly recoveryPending: boolean,
  ) {
    super(message);
  }
}

/** True only when Fleet has preserved recoverable state but could not put the
 * original pathname back. Callers must report an unknown outcome and require
 * inspection instead of presenting this as an ordinary no-change failure. */
export function isRecoveryPendingError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { recoveryPending?: unknown }).recoveryPending === true
  );
}

function recoveryPendingError(message: string): Error & { recoveryPending: true } {
  return Object.assign(new Error(message), { recoveryPending: true as const });
}

async function restoreDetachedFile(detached: string, target: string): Promise<void> {
  // hard-link publication is an atomic no-clobber operation for regular files.
  // If another actor recreated target, preserving both paths is safer than
  // overwriting either one.
  await link(detached, target);
  // Make the restored target durable before removing the recovery name.
  await fsyncDirectoryChainDurable(dirname(target));
  await rm(detached).catch(() => {});
  await fsyncPathBestEffort(dirname(target));
}

async function detachVerifiedFile(target: string, expected: { hash: string; mode: number }): Promise<string> {
  const detached = `${target}.fleet-old-${process.pid}-${randomUUID()}`;
  try {
    await rename(target, detached);
    await fsyncDirectoryChainDurable(dirname(target));
    const captured = await readRegularFileNoFollow(detached);
    if (sha256(captured.content) !== expected.hash || captured.mode !== expected.mode) {
      throw new Error(`fleet: ${target} changed before commit; re-plan`);
    }
    return detached;
  } catch (error) {
    if (!(await pathEntryExistsNoFollow(detached))) throw new FileCommitError(msg(error), false);
    try {
      await restoreDetachedFile(detached, target);
      throw new FileCommitError(msg(error), false);
    } catch (restoreError) {
      if (restoreError instanceof FileCommitError) throw restoreError;
      throw new FileCommitError(
        `${msg(error)}; original preserved at ${detached}; recovery is pending because target could not be restored: ${msg(restoreError)}`,
        true,
      );
    }
  }
}

/** Publish a staged regular file without ever renaming over an unchecked
 * pathname. Existing state is detached first and verified after the rename;
 * link() then provides atomic create-if-absent semantics for the new target. */
async function commitStagedFile(
  stage: string,
  target: string,
  expected?: { hash: string; mode: number },
): Promise<string> {
  let detached = '';
  let published = false;
  try {
    if (expected) {
      detached = await detachVerifiedFile(target, expected);
    }
    try {
      await link(stage, target);
      published = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error(`fleet: ${target} was created during commit; refusing to overwrite it`);
      }
      throw error;
    }
    // Persist the no-clobber publication before removing either recovery link.
    await fsyncDirectoryChainDurable(dirname(target));
    // target now names the fully fsynced staged inode. Removing the staging
    // link cannot invalidate the committed file and is therefore best-effort.
    await rm(stage, { force: true }).catch(() => {});
    await fsyncPathBestEffort(dirname(target));
    return detached;
  } catch (error) {
    await rm(stage, { force: true }).catch(() => {});
    if (error instanceof FileCommitError) throw error;
    if (!detached) throw new FileCommitError(msg(error), published);
    try {
      await restoreDetachedFile(detached, target);
      throw new FileCommitError(msg(error), false);
    } catch (restoreError) {
      if (restoreError instanceof FileCommitError) throw restoreError;
      throw new FileCommitError(
        `${msg(error)}; original preserved at ${detached}; recovery is pending because target could not be restored: ${msg(restoreError)}`,
        true,
      );
    }
  }
}

/** Shared exclusive mutation lock. Core writes, core rollback, and delegated
 * vendor actions all use this same boundary so their provenance order cannot
 * race or cross an outcome-unknown operation. Returns a best-effort release
 * function whose cleanup cannot reverse an already-completed caller result. */
export async function acquireOperationLock(home: string): Promise<() => Promise<void>> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const lockPath = join(home, '.lock');
  let fh;
  try {
    fh = await open(lockPath, 'wx', 0o600);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`fleet: another operation holds the lock (${lockPath}); remove it if stale`);
    }
    throw err;
  }
  try {
    await fh.chmod(0o600);
    await fh.writeFile(`${process.pid} ${Date.now()} ${randomUUID()}`);
    await fh.sync();
  } catch (error) {
    await fh.close();
    await rm(lockPath, { force: true });
    throw error;
  }
  return async () => {
    try {
      const [owned, current] = await Promise.all([fh.stat(), lstat(lockPath)]);
      // A stale-lock cleanup may have removed our pathname and a newer owner
      // may already have recreated it. Only unlink the inode we acquired.
      if (owned.dev === current.dev && owned.ino === current.ino) {
        await rm(lockPath, { force: true });
      }
    } catch {
      // Cleanup occurs after the caller may already have committed and recorded
      // a mutation. A stale lock is recoverable evidence; throwing here would
      // erase the known outcome and invite a destructive retry.
    } finally {
      await fh.close().catch(() => {});
    }
  };
}

/**
 * Apply planned changes safely under a lock. For each change:
 *  - refuse to clobber an existing file that doesn't `validate` (parse);
 *  - refuse if the file changed since the plan was made (hash guard);
 *  - back up the current file durably;
 *  - validate and fsync staged content before touching the target;
 *  - publish without overwriting a pathname that appeared or changed after
 *    planning (regular files use create-if-absent hard links; directories use
 *    exclusive root and child creation);
 *  - append an audit record.
 * `validate` is required — the engine owns validation. Changes apply in order;
 * if change N throws, changes 1..N-1 stand (each independently rollback-able).
 */
export async function applyChanges(
  changes: PlannedChange[],
  validate: ChangeValidator,
  opts: ApplyOptions = {},
): Promise<ApplyResult[]> {
  const home = fleetHomeDir(opts.fleetHome);
  assertMutationConfigReadable(home);
  const backupsDir = join(home, 'backups');
  await mkdir(backupsDir, { recursive: true, mode: 0o700 });
  const backupInfo = await lstat(backupsDir);
  if (backupInfo.isSymbolicLink() || !backupInfo.isDirectory()) {
    throw new Error('fleet: backup state directory is unavailable');
  }
  await chmod(backupsDir, 0o700);

  const release = await acquireOperationLock(home);
  const results: ApplyResult[] = [];
  try {
    assertMutationConfigReadable(home);
    const history = await readAuditLedger(home);
    if (history.status !== 'available' && history.status !== 'not-present') {
      throw new Error('fleet: audit history is unavailable, malformed, or incomplete; refusing mutation');
    }
    await opts.beforeApplyLocked?.();
    let failure: unknown;
    try {
      await applyEach(changes, validate, home, backupsDir, results, opts.force ?? false);
    } catch (err) {
      failure = err;
    }
    try {
      await opts.whileLocked?.(results);
    } catch (err) {
      failure ??= err;
    }
    if (failure) {
      // surface what was applied before the failure (partial fan-out)
      (failure as { applied?: ApplyResult[] }).applied = results;
      throw failure;
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
  let targetMetadata;
  try {
    targetMetadata = await lstat(change.file);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (targetMetadata?.isSymbolicLink()) {
    throw new Error(`fleet: refusing to replace symbolic-link config ${change.file}`);
  }
  if (targetMetadata && !targetMetadata.isFile()) {
    throw new Error(`fleet: refusing file operation on non-file ${change.file}`);
  }
  const existedBefore = targetMetadata !== undefined;
  let backup = '';
  let backupHash: string | undefined;
  let backupMode: number | undefined;

  if (existedBefore) {
    // every renderer sets baseHash iff the target existed at plan time, so
    // "no baseHash but the file exists now" means it appeared AFTER planning —
    // overwriting it would clobber someone else's file without a backup guard.
    if (!force && change.baseHash === undefined) {
      throw new Error(`fleet: ${change.file} was created after the plan was made; re-plan (or pass force)`);
    }
    const { content: current, mode } = await readRegularFileNoFollow(change.file);
    backupMode = mode;
    try {
      validate(change, current);
    } catch (err) {
      throw new Error(`fleet: refusing to write ${change.file}: existing file does not parse (${msg(err)})`);
    }
    if (!force && change.baseHash !== undefined && sha256(current) !== change.baseHash) {
      throw new Error(`fleet: ${change.file} changed since the plan was made; re-plan (or pass force)`);
    }
    backup = join(backupsDir, `${Date.now()}-${process.pid}-${randomUUID()}-${basename(change.file)}.bak`);
    await writeBackupFile(backup, current, mode);
    await fsyncDirectoryChainDurable(backupsDir);
    backupHash = sha256(current);
  }

  // Validate the exact bytes that will be staged before touching the target.
  // Post-commit validation would make a completed mutation look like a failure
  // and would reopen an overwrite race during attempted restoration.
  try {
    validate(change, change.newContent);
  } catch (err) {
    throw new Error(`fleet: refusing to write ${change.file}: rendered content does not parse (${msg(err)})`);
  }
  const wroteMode = backupMode ?? 0o600;
  const stage = await stageFile(change.file, change.newContent, wroteMode);

  const id = randomUUID();
  try {
    await writePendingAudit(home, {
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
      ...(backupHash ? { backupHash } : {}),
      ...(backupMode !== undefined ? { backupMode } : {}),
    });
  } catch (error) {
    await rm(stage, { force: true }).catch(() => {});
    throw error;
  }

  let detached = '';
  try {
    detached = await commitStagedFile(
      stage,
      change.file,
      existedBefore ? { hash: backupHash!, mode: backupMode! } : undefined,
    );
  } catch (error) {
    if (!(error instanceof FileCommitError) || !error.recoveryPending) {
      await clearPendingAudit(home, id).catch(() => {});
    }
    throw error;
  }

  const wroteHash = sha256(change.newContent);
  // push BEFORE the audit append: if the append fails the mutation still
  // happened, and err.applied (set by applyChanges) must reflect reality
  const result: ApplyResult = { change, auditId: id, auditRecorded: false, backup, wroteHash };
  results.push(result);
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
      wroteMode,
      ...(backupHash ? { backupHash } : {}),
      ...(change.trust ? { trust: change.trust } : {}),
      ...(backupMode !== undefined ? { backupMode } : {}),
    });
    result.auditRecorded = true;
    await clearPendingAudit(home, id).catch(() => {});
  } catch (err) {
    // the mutation already happened — say so explicitly and point at the backup
    throw new Error(
      `fleet: ${change.file} WAS updated but the audit log write failed ` +
        `(automatic rollback unavailable; backup at ${backup || '(none — file was new)'}): ${msg(err)}`,
    );
  } finally {
    if (detached) await rm(detached, { force: true }).catch(() => {});
  }
}

/**
 * Apply a directory-shaped change (a skill): durable backup → verified stage
 * → recoverable exclusive-copy commit → audit. Existing targets are detached
 * and verified before publication; cleanup never recursively deletes the live
 * target pathname.
 */
async function directoryMatches(path: string, expectedHash: string | undefined): Promise<boolean> {
  if (expectedHash === undefined) return false;
  try {
    const info = await lstat(path);
    return !info.isSymbolicLink() && info.isDirectory() && (await hashDir(path)) === expectedHash;
  } catch {
    return false;
  }
}

class DirectoryCommitError extends Error {
  constructor(
    message: string,
    readonly recoveryPending: boolean,
  ) {
    super(message);
  }
}

/** Publish a staged tree without a pathname-replacing rename. The destination
 * root and every child are created exclusively, so even an empty directory
 * created by another actor is never overwritten. Publication is intentionally
 * recoverable rather than presented as a single-syscall transaction.
 * @internal Exported for focused filesystem-boundary regression tests. */
export async function publishDirectoryNoClobber(source: string, target: string): Promise<void> {
  const expectedHash = await hashDir(source);
  try {
    await copyDirExclusive(source, target);
  } catch (error) {
    throw new DirectoryCommitError(
      msg(error),
      error instanceof ExclusiveDirectoryCopyError && error.targetCreated,
    );
  }
  if ((await hashDir(target)) !== expectedHash) {
    throw new DirectoryCommitError(`fleet: published directory changed during commit at ${target}`, true);
  }
  try {
    await fsyncDirectoryChainDurable(dirname(target));
  } catch (error) {
    throw new DirectoryCommitError(
      `fleet: published directory namespace is not durable at ${target}: ${msg(error)}`,
      true,
    );
  }
  await removeDir(source).catch(() => {});
  await fsyncPathBestEffort(dirname(target));
}

async function restoreDetachedDirectory(detached: string, target: string): Promise<void> {
  await publishDirectoryNoClobber(detached, target);
}

async function applyDirChange(
  change: PlannedChange,
  home: string,
  backupsDir: string,
  force: boolean,
  results: ApplyResult[],
): Promise<void> {
  const target = change.file;
  let targetMetadata;
  try {
    targetMetadata = await lstat(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (targetMetadata?.isSymbolicLink()) {
    throw new Error(`fleet: refusing to replace symbolic-link directory ${target}`);
  }
  if (targetMetadata && !targetMetadata.isDirectory()) {
    throw new Error(`fleet: refusing directory operation on non-directory ${target}`);
  }
  const existedBefore = targetMetadata !== undefined;
  let backup = '';
  let backupHash: string | undefined;
  let observedTargetHash: string | undefined;
  let committedHash = '';
  let postCommitCleanupDir = '';
  let id = '';

  if (existedBefore) {
    // same absent-at-plan race guard as files — remove included: deleting a
    // target the plan never saw is exactly the clobber this guard exists for
    // (renderers set baseHash iff the target existed at plan time)
    if (!force && change.baseHash === undefined) {
      throw new Error(`fleet: ${target} was created after the plan was made; re-plan (or pass force)`);
    }
    observedTargetHash = await hashDir(target);
    if (!force && change.baseHash !== undefined && observedTargetHash !== change.baseHash) {
      throw new Error(`fleet: ${target} changed since the plan was made; re-plan (or pass force)`);
    }
    backup = join(backupsDir, `${Date.now()}-${process.pid}-${randomUUID()}-${basename(target)}.dirbak`);
    await copyDir(target, backup);
    await fsyncDirectoryChainDurable(backupsDir); // persist the copied backup root and ancestors
    backupHash = await hashDir(backup);
    if (backupHash !== observedTargetHash || (await hashDir(target)) !== observedTargetHash) {
      await removeDir(backup);
      await fsyncDirectoryChainDurable(backupsDir);
      throw new Error(`fleet: ${target} changed while its backup was captured; re-plan`);
    }
  }

  if (change.dirOp === 'remove') {
    if (!existedBefore) throw new Error(`fleet: nothing to remove at ${target}`);
    if ((await hashDir(target)) !== observedTargetHash) {
      await removeDir(backup);
      await fsyncDirectoryChainDurable(backupsDir);
      throw new Error(`fleet: ${target} changed before removal; re-plan`);
    }
    id = randomUUID();
    await writePendingAudit(home, {
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
      isDir: true,
      ...(backupHash ? { backupHash } : {}),
      ...(change.trust ? { trust: change.trust } : {}),
    });
    const detached = `${target}.fleet-removed-${process.pid}-${randomUUID()}`;
    try {
      // Rename first: this atomically pins the exact directory entry Fleet is
      // about to remove. Recursive deletion happens only on the detached name
      // after the mutation and its provenance have been recorded.
      await rename(target, detached);
      await fsyncDirectoryChainDurable(dirname(target));
      if (!(await directoryMatches(detached, observedTargetHash))) {
        throw new Error(`fleet: ${target} changed before removal; re-plan`);
      }
      postCommitCleanupDir = detached;
    } catch (error) {
      let recoveryPending = false;
      if (await pathEntryExistsNoFollow(detached)) {
        if (await pathEntryExistsNoFollow(target)) recoveryPending = true;
        else {
          try {
            await restoreDetachedDirectory(detached, target);
          } catch {
            recoveryPending = true;
          }
        }
      }
      if (recoveryPending) {
        throw recoveryPendingError(
          `fleet: ${target} removal did not commit; original preserved at ${detached}; recovery pending: ${msg(error)}`,
        );
      }
      await clearPendingAudit(home, id).catch(() => {});
      await removeDir(backup).catch(() => {});
      await fsyncDirectoryChainDurable(backupsDir);
      throw error;
    }
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
    const stageHash = await hashDir(stage);
    if (change.sourceHash !== undefined && stageHash !== change.sourceHash) {
      await removeDir(stage);
      throw new Error(`fleet: skill source ${change.sourceDir} changed since the plan was made; re-plan`);
    }
    if (existedBefore && (await hashDir(target)) !== observedTargetHash) {
      await removeDir(stage);
      await removeDir(backup);
      await fsyncDirectoryChainDurable(backupsDir);
      throw new Error(`fleet: ${target} changed before replacement; re-plan`);
    }
    id = randomUUID();
    await writePendingAudit(home, {
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
      isDir: true,
      ...(backupHash ? { backupHash } : {}),
    });
    if (existedBefore && (await hashDir(target)) !== observedTargetHash) {
      await clearPendingAudit(home, id).catch(() => {});
      await removeDir(stage);
      await removeDir(backup);
      await fsyncDirectoryChainDurable(backupsDir);
      throw new Error(`fleet: ${target} changed before replacement; re-plan`);
    }
    // 2) Pin the current target by renaming it away, verify THAT captured
    //    directory, then name the already-verified stage. No recursive delete
    //    occurs on the live target pathname.
    let oldTmp = '';
    try {
      if (existedBefore) {
        oldTmp = `${target}.fleet-old-${process.pid}-${randomUUID()}`;
        await rename(target, oldTmp);
        await fsyncDirectoryChainDurable(dirname(target));
        if (!(await directoryMatches(oldTmp, observedTargetHash))) {
          await restoreDetachedDirectory(oldTmp, target);
          oldTmp = '';
          throw new Error(`fleet: ${target} changed before replacement; re-plan`);
        }
      }
      await publishDirectoryNoClobber(stage, target);
      committedHash = stageHash;
      postCommitCleanupDir = oldTmp;
    } catch (err) {
      let recoveryPending = err instanceof DirectoryCommitError && err.recoveryPending;
      try {
        await removeDir(stage);
        if (oldTmp && (await pathEntryExistsNoFollow(oldTmp))) {
          if (await pathEntryExistsNoFollow(target)) recoveryPending = true;
          else {
            await restoreDetachedDirectory(oldTmp, target);
            oldTmp = '';
          }
        }
        if (!recoveryPending) await clearPendingAudit(home, id);
      } catch (restoreErr) {
        throw recoveryPendingError(
          `fleet: dir install failed for ${target} AND restore failed; ` +
            `original preserved at ${oldTmp || backup || '(none)'}; recovery pending: ${msg(restoreErr)}`,
        );
      }
      if (recoveryPending) {
        throw recoveryPendingError(
          `fleet: dir install failed for ${target}; original preserved at ${oldTmp}; recovery pending: ${msg(err)}`,
        );
      }
      throw new Error(
        `fleet: dir install failed for ${target}; ` +
          `${existedBefore ? 'restored backup' : 'removed created dir'}: ${msg(err)}`,
      );
    }
  }

  // The committed install is the exact staged tree whose hash was established
  // before rename. Never re-read the public pathname after commit merely to
  // decide whether the already-completed mutation "counts" as applied.
  const wroteHash = change.dirOp === 'remove' ? '' : committedHash;
  const result: ApplyResult = { change, auditId: id, auditRecorded: false, backup, wroteHash };
  results.push(result); // before append — see applyFileChange
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
      ...(backupHash ? { backupHash } : {}),
      ...(change.trust ? { trust: change.trust } : {}),
    });
    result.auditRecorded = true;
    await clearPendingAudit(home, id).catch(() => {});
  } catch (err) {
    throw new Error(
      `fleet: ${target} WAS updated but the audit log write failed ` +
        `(automatic rollback unavailable; backup at ${backup || '(none — dir was new)'}): ${msg(err)}`,
    );
  } finally {
    if (postCommitCleanupDir) await removeDir(postCommitCleanupDir).catch(() => {});
  }
}

export interface AuditReadResult {
  records: AuditRecord[];
  status: 'available' | 'not-present' | 'unavailable' | 'malformed' | 'incomplete';
}

function isAuditRecord(value: unknown): value is AuditRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const uuid = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
  const legacyId = /^\d{13}-\d+-[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
  const validId = (candidate: unknown): candidate is string =>
    typeof candidate === 'string' && (uuid.test(candidate) || legacyId.test(candidate));
  const validKind =
    record.kind === undefined ||
    record.kind === 'mcp-server' ||
    record.kind === 'skill' ||
    record.kind === 'rule';
  const validScope =
    record.scope === undefined ||
    record.scope === 'user' ||
    record.scope === 'project' ||
    record.scope === 'local';
  const hash = /^[a-f0-9]{64}$/i;
  const validWroteHash =
    record.wroteHash === undefined ||
    (typeof record.wroteHash === 'string' &&
      (hash.test(record.wroteHash) ||
        (record.isDir === true &&
          (record.op === 'remove' || record.op === 'rollback') &&
          record.wroteHash === '') ||
        // Older rollback rows omitted isDir even when they referenced a
        // directory remove. The cross-row validator below only accepts this
        // empty hash when the referenced valid target has the same value.
        (record.op === 'rollback' && record.wroteHash === '')));
  const validRollbackLink =
    record.op === 'rollback' ? validId(record.rolledBackFrom) : record.rolledBackFrom === undefined;
  const validDirectoryFields =
    (record.kind === 'skill' ? record.isDir === true : record.kind === undefined || record.isDir !== true) &&
    (record.isDir !== true || (record.backupMode === undefined && record.wroteMode === undefined));
  return (
    validId(record.id) &&
    typeof record.ts === 'number' &&
    Number.isSafeInteger(record.ts) &&
    record.ts >= 0 &&
    (record.op === 'install' ||
      record.op === 'remove' ||
      record.op === 'update' ||
      record.op === 'rollback') &&
    typeof record.agent === 'string' &&
    record.agent.length > 0 &&
    typeof record.name === 'string' &&
    record.name.length > 0 &&
    typeof record.file === 'string' &&
    record.file.length > 0 &&
    typeof record.backup === 'string' &&
    typeof record.existedBefore === 'boolean' &&
    validKind &&
    validScope &&
    validWroteHash &&
    (record.isDir === undefined || typeof record.isDir === 'boolean') &&
    (record.backupHash === undefined ||
      (typeof record.backupHash === 'string' && /^[a-f0-9]{64}$/i.test(record.backupHash))) &&
    (record.backupMode === undefined ||
      (Number.isInteger(record.backupMode) &&
        (record.backupMode as number) >= 0 &&
        (record.backupMode as number) <= 0o7777)) &&
    (record.wroteMode === undefined ||
      (Number.isInteger(record.wroteMode) &&
        (record.wroteMode as number) >= 0 &&
        (record.wroteMode as number) <= 0o7777)) &&
    validRollbackLink &&
    validDirectoryFields &&
    (record.backupMode === undefined || record.backupHash !== undefined) &&
    (record.wroteMode === undefined ||
      (typeof record.wroteHash === 'string' && hash.test(record.wroteHash))) &&
    (record.trust === undefined ||
      (record.trust !== null &&
        typeof record.trust === 'object' &&
        !Array.isArray(record.trust) &&
        Object.keys(record.trust as Record<string, unknown>).every(
          (key) => key === 'level' || key === 'reasonCodes',
        ) &&
        ((record.trust as Record<string, unknown>).level === 'ok' ||
          (record.trust as Record<string, unknown>).level === 'caution') &&
        Array.isArray((record.trust as Record<string, unknown>).reasonCodes) &&
        (record.trust as { reasonCodes: unknown[] }).reasonCodes.every(isTrustReasonCode) &&
        (((record.trust as Record<string, unknown>).level === 'ok' &&
          (record.trust as { reasonCodes: unknown[] }).reasonCodes.length === 0) ||
          ((record.trust as Record<string, unknown>).level === 'caution' &&
            (record.trust as { reasonCodes: unknown[] }).reasonCodes.length > 0))))
  );
}

/** Validate relationships that no individual JSONL row can establish. A
 * rollback edge is authoritative state: it may only undo one earlier,
 * non-rollback record, and the copied target identity must match exactly.
 * Otherwise a parseable forged/miswritten edge could hide a newer mutation
 * and make an older destructive rollback look eligible. */
function hasValidRollbackEdges(records: readonly AuditRecord[]): boolean {
  const prior = new Map<string, AuditRecord>();
  const undone = new Set<string>();
  for (const record of records) {
    if (record.op === 'rollback') {
      const target = record.rolledBackFrom ? prior.get(record.rolledBackFrom) : undefined;
      if (
        !target ||
        target.op === 'rollback' ||
        undone.has(target.id) ||
        record.agent !== target.agent ||
        record.name !== target.name ||
        (record.kind !== undefined && record.kind !== target.kind) ||
        record.file !== target.file ||
        record.scope !== target.scope ||
        (record.isDir !== undefined && record.isDir !== target.isDir) ||
        record.existedBefore !== target.existedBefore ||
        record.wroteHash !== target.wroteHash
      ) {
        return false;
      }
      undone.add(target.id);
    }
    prior.set(record.id, record);
  }
  return true;
}

/** Read audit records with integrity status. Callers may inspect valid rows for
 * diagnostics, but rollback must fail closed when any row is unknown or IDs
 * are ambiguous. */
export async function readAuditLedger(fleetHome?: string): Promise<AuditReadResult> {
  const home = fleetHomeDir(fleetHome);
  const file = join(home, 'audit.jsonl');
  let text: string;
  try {
    text = (await readRegularFileNoFollow(file)).content;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const pending = await readPendingAudits(home, new Set());
      if (pending.status !== 'available') return { records: [], status: pending.status };
      return { records: [], status: pending.count > 0 ? 'incomplete' : 'not-present' };
    }
    return { records: [], status: 'unavailable' };
  }
  const out: AuditRecord[] = [];
  let malformed = false;
  for (const line of text.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isAuditRecord(value)) out.push(value);
      else malformed = true;
    } catch {
      malformed = true;
    }
  }
  if (new Set(out.map((record) => record.id)).size !== out.length || !hasValidRollbackEdges(out)) {
    malformed = true;
  }
  const pending = await readPendingAudits(home, new Set(out.map((record) => record.id)));
  const status =
    pending.status === 'unavailable'
      ? 'unavailable'
      : malformed || pending.status === 'malformed'
        ? 'malformed'
        : pending.count > 0
          ? 'incomplete'
          : 'available';
  return { records: out, status };
}

/** Read valid audit records (oldest first). Use readAuditLedger when an
 * operation must distinguish a complete history from a partial one. */
export async function readAudit(fleetHome?: string): Promise<AuditRecord[]> {
  return (await readAuditLedger(fleetHome)).records;
}

function auditKind(record: AuditRecord): string {
  return record.kind ?? (record.isDir ? 'skill' : 'mcp-server');
}

function sameMutationTarget(left: AuditRecord, right: AuditRecord): boolean {
  // A backup captures the whole native file/tree, so any newer active write to
  // that pathname supersedes an older rollback even when it represents a
  // different logical capability inside a shared config file.
  if (resolve(left.file) === resolve(right.file)) return true;
  return (
    left.agent === right.agent &&
    left.name === right.name &&
    auditKind(left) === auditKind(right) &&
    (left.scope ?? 'user') === (right.scope ?? 'user')
  );
}

/** Audit ids that can currently be rolled back without crossing a newer active
 * mutation of the same native file/tree or logical capability. A rolled-back
 * newer change no longer masks the prior state that it restored. */
export function rollbackEligibleAuditIds(records: readonly AuditRecord[]): ReadonlySet<string> {
  const alreadyUndone = new Set(
    records.map((record) => record.rolledBackFrom).filter((value): value is string => Boolean(value)),
  );
  const active = records.filter((record) => record.op !== 'rollback' && !alreadyUndone.has(record.id));
  const eligible = new Set<string>();
  for (let position = 0; position < active.length; position += 1) {
    const candidate = active[position]!;
    const superseded = active.slice(position + 1).some((record) => sameMutationTarget(candidate, record));
    if (!superseded) eligible.add(candidate.id);
  }
  return eligible;
}

/** Newest core change that implicit rollback may still undo. */
export function latestRollbackCandidate(records: readonly AuditRecord[]): AuditRecord | undefined {
  const eligible = rollbackEligibleAuditIds(records);
  return [...records].reverse().find((record) => eligible.has(record.id));
}

/**
 * Undo a change by audit id, or the most recent change not already rolled back.
 * Restores from backup (edited file) or removes a fleet-created file — but only
 * if the target still matches what fleet wrote; otherwise it skips to avoid
 * destroying a diverged file. Records the rollback. Runs under the lock.
 */
export async function rollback(
  opts: {
    auditId?: string;
    fleetHome?: string;
    /** Runs while the shared mutation lock is held, after the core ledger is
     * read and before a target is selected or changed. */
    implicitGuard?: (audit: AuditReadResult) => Promise<RollbackGuardRefusal | undefined>;
  } = {},
): Promise<{
  file: string;
  action: RollbackAction;
  reason?: string;
  auditRecorded: boolean;
  /** The target rollback completed, but fleet.lock cleanup did not. */
  lockWarning?: string;
  guardRefusal?: RollbackGuardRefusal;
}> {
  const home = fleetHomeDir(opts.fleetHome);
  assertMutationConfigReadable(home);
  const release = await acquireOperationLock(home);
  try {
    assertMutationConfigReadable(home);
    const audit = await readAuditLedger(home);
    if (audit.status !== 'available' && audit.status !== 'not-present') {
      if (!opts.auditId && opts.implicitGuard) {
        return {
          file: '',
          action: 'skipped',
          auditRecorded: false,
          guardRefusal: {
            reasonCode: 'CORE_HISTORY_UNVERIFIABLE',
            recoveryClass: 'audit-history-repair',
          },
        };
      }
      throw new Error(
        'fleet: audit history is unavailable, malformed, incomplete, or ambiguous; refusing rollback',
      );
    }
    if (!opts.auditId && opts.implicitGuard) {
      const guardRefusal = await opts.implicitGuard(audit);
      if (guardRefusal) {
        return { file: '', action: 'skipped', auditRecorded: false, guardRefusal };
      }
    }
    const records = audit.records;
    if (records.length === 0) throw new Error('fleet: no audit log to roll back');

    const alreadyUndone = new Set(
      records.map((r) => r.rolledBackFrom).filter((x): x is string => Boolean(x)),
    );
    const target = opts.auditId
      ? records.find((r) => r.id === opts.auditId)
      : latestRollbackCandidate(records);
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
    if (!rollbackEligibleAuditIds(records).has(target.id)) {
      throw new Error(
        `fleet: ${target.id} has a newer active change for the same state; roll that change back first`,
      );
    }

    let action: RollbackAction;
    let reason: string | undefined;
    let rollbackId = '';
    let postCommitCleanupDir = '';
    let postCommitCleanupFile = '';
    const beginRollback = async (): Promise<void> => {
      rollbackId = randomUUID();
      await writePendingAudit(home, {
        id: rollbackId,
        ts: Date.now(),
        op: 'rollback',
        agent: target.agent,
        name: target.name,
        kind: target.kind ?? (target.isDir ? 'skill' : 'mcp-server'),
        file: target.file,
        scope: (target.scope ?? 'user') as Scope,
        backup: '',
        existedBefore: target.existedBefore,
        ...(target.isDir ? { isDir: true } : {}),
        rolledBackFrom: target.id,
      });
    };

    // divergence guard for EVERY restore/remove: fleet only undoes its own
    // write, so the target must still be in the exact state fleet left it in.
    // For a dir-remove the recorded end-state is "absent"; for everything else
    // it's wroteHash. Anything different (including a user deleting the file,
    // or a file/dir type swap) is divergence — skip, don't clobber/resurrect.
    const divergence = async (): Promise<'diverged' | 'unverifiable' | null> => {
      const expectedAbsent = Boolean(target.isDir) && target.op === 'remove';
      const existsNow = await pathEntryExistsNoFollow(target.file);
      if (expectedAbsent) return existsNow ? 'diverged' : null;
      if (!existsNow) return 'diverged'; // fleet left content; user deleted it since
      if (!target.wroteHash) return 'unverifiable'; // old record → safe direction is skip
      if (!target.isDir && target.wroteMode === undefined) return 'unverifiable';
      try {
        const currentInfo = await lstat(target.file);
        if (currentInfo.isSymbolicLink()) return 'diverged';
        const currentFile = target.isDir ? undefined : await readRegularFileNoFollow(target.file);
        const currentHash = target.isDir ? await hashDir(target.file) : sha256(currentFile!.content);
        if (currentHash !== target.wroteHash) return 'diverged';
        if (!target.isDir && target.wroteMode !== undefined && currentFile!.mode !== target.wroteMode) {
          return 'diverged';
        }
        return null;
      } catch {
        return 'diverged'; // unreadable / type-swapped (file where dir was, …)
      }
    };

    if (target.existedBefore) {
      let backupProblem: string | undefined;
      let verifiedBackupContent: string | undefined;
      let verifiedBackupMode: number | undefined;
      if (!target.backup || dirname(resolve(target.backup)) !== resolve(home, 'backups')) {
        backupProblem = 'backup location is outside Fleet state';
      } else if (!target.backupHash) {
        backupProblem = 'no recorded backup hash';
      } else {
        try {
          const backupRoot = await lstat(dirname(target.backup));
          const backupInfo = await lstat(target.backup);
          if (backupRoot.isSymbolicLink() || !backupRoot.isDirectory()) {
            backupProblem = 'backup directory is not trustworthy';
          } else if (backupInfo.isSymbolicLink()) {
            backupProblem = 'backup is a symbolic link';
          } else if (target.isDir ? !backupInfo.isDirectory() : !backupInfo.isFile()) {
            backupProblem = 'backup type does not match the recorded target';
          } else if (!target.isDir) {
            const backup = await readRegularFileNoFollow(target.backup);
            if (sha256(backup.content) !== target.backupHash) backupProblem = 'backup hash mismatch';
            else if (target.backupMode !== undefined && backup.mode !== target.backupMode) {
              backupProblem = 'backup mode mismatch';
            } else {
              verifiedBackupContent = backup.content;
              verifiedBackupMode = target.backupMode ?? backup.mode;
            }
          }
        } catch {
          backupProblem = 'backup is missing or unreadable';
        }
      }
      const div = await divergence();
      if (backupProblem) {
        action = 'skipped';
        reason = `${backupProblem}; not restoring`;
      } else if (div) {
        action = 'skipped';
        reason =
          div === 'diverged'
            ? `${target.isDir ? 'dir' : 'file'} diverged since fleet wrote it; not restoring (backup kept at ${target.backup})`
            : `no recorded write-hash to verify against; not restoring (backup kept at ${target.backup})`;
      } else if (target.isDir) {
        // Restore via a recoverable detach-and-exclusive-copy commit. The
        // current pathname is first detached and verified; no destination
        // entry is overwritten while the staged backup is published.
        const stage = `${target.file}.fleet-restore-${process.pid}-${randomUUID()}`;
        let oldTmp = '';
        try {
          await copyDir(target.backup, stage);
          if ((await hashDir(stage)) !== target.backupHash) {
            await removeDir(stage);
            return {
              file: target.file,
              action: 'skipped',
              reason: 'backup hash mismatch; not restoring',
              auditRecorded: false,
            };
          }
          await beginRollback();
          oldTmp = `${target.file}.fleet-old-${process.pid}-${randomUUID()}`;
          await rename(target.file, oldTmp);
          await fsyncDirectoryChainDurable(dirname(target.file));
          if (!(await directoryMatches(oldTmp, target.wroteHash))) {
            throw new Error('dir changed before restore swap; not restoring');
          }
          await publishDirectoryNoClobber(stage, target.file);
        } catch (restoreErr) {
          await removeDir(stage).catch(() => {});
          let recoveryPending = restoreErr instanceof DirectoryCommitError && restoreErr.recoveryPending;
          if (oldTmp && (await pathEntryExistsNoFollow(oldTmp))) {
            if (await pathEntryExistsNoFollow(target.file)) recoveryPending = true;
            else {
              try {
                await restoreDetachedDirectory(oldTmp, target.file);
                oldTmp = '';
              } catch {
                recoveryPending = true;
              }
            }
          }
          if (rollbackId && !recoveryPending) {
            await clearPendingAudit(home, rollbackId).catch(() => {});
            return {
              file: target.file,
              action: 'skipped',
              reason: 'dir changed before restore commit; not restoring',
              auditRecorded: false,
            };
          }
          if (recoveryPending) {
            throw recoveryPendingError(
              `fleet: rollback restore failed for ${target.file}; original preserved at ${oldTmp}; ` +
                `recovery pending: ${msg(restoreErr)}`,
            );
          }
          throw new Error(
            `fleet: rollback restore failed for ${target.file}; ` +
              `backup at ${target.backup}: ${msg(restoreErr)}`,
          );
        }
        postCommitCleanupDir = oldTmp;
        action = 'restored';
      } else {
        const stage = await stageFile(target.file, verifiedBackupContent!, verifiedBackupMode!);
        await beginRollback().catch(async (error) => {
          await rm(stage, { force: true }).catch(() => {});
          throw error;
        });
        try {
          postCommitCleanupFile = await commitStagedFile(stage, target.file, {
            hash: target.wroteHash!,
            mode: target.wroteMode!,
          });
        } catch (error) {
          if (error instanceof FileCommitError && error.recoveryPending) throw error;
          await clearPendingAudit(home, rollbackId).catch(() => {});
          return {
            file: target.file,
            action: 'skipped',
            reason: 'file changed before restore commit; not restoring',
            auditRecorded: false,
          };
        }
        action = 'restored';
      }
    } else if (!(await pathEntryExistsNoFollow(target.file))) {
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
        await beginRollback();
        const detached = `${target.file}.fleet-rollback-removed-${process.pid}-${randomUUID()}`;
        try {
          await rename(target.file, detached);
          await fsyncDirectoryChainDurable(dirname(target.file));
          if (!(await directoryMatches(detached, target.wroteHash))) {
            throw new Error('dir changed before rollback removal; not removing');
          }
          postCommitCleanupDir = detached;
        } catch (error) {
          let recoveryPending = false;
          if (await pathEntryExistsNoFollow(detached)) {
            if (await pathEntryExistsNoFollow(target.file)) recoveryPending = true;
            else {
              try {
                await restoreDetachedDirectory(detached, target.file);
              } catch {
                recoveryPending = true;
              }
            }
          }
          if (recoveryPending) {
            throw recoveryPendingError(
              `fleet: rollback removal did not commit; original preserved at ${detached}; ` +
                `recovery pending: ${msg(error)}`,
            );
          }
          await clearPendingAudit(home, rollbackId).catch(() => {});
          return {
            file: target.file,
            action: 'skipped',
            reason: 'dir changed before rollback removal; not removing',
            auditRecorded: false,
          };
        }
        action = 'removed';
      } else {
        await beginRollback();
        try {
          postCommitCleanupFile = await detachVerifiedFile(target.file, {
            hash: target.wroteHash!,
            mode: target.wroteMode!,
          });
        } catch (error) {
          if (error instanceof FileCommitError && error.recoveryPending) throw error;
          await clearPendingAudit(home, rollbackId).catch(() => {});
          return {
            file: target.file,
            action: 'skipped',
            reason: 'file changed before rollback removal; not removing',
            auditRecorded: false,
          };
        }
        action = 'removed';
      }
    }

    // A skipped attempt made no Fleet-authored state transition. In
    // particular, divergence must not manufacture a successful
    // `rolledBackFrom` edge: that would hide the still-applied change from
    // Activity and permanently prevent a safe retry after the user restores
    // the exact bytes Fleet wrote.
    if (action === 'skipped') return { file: target.file, action, reason, auditRecorded: false };

    let auditRecorded = true;
    try {
      await appendAudit(home, {
        id: rollbackId,
        ts: Date.now(),
        op: 'rollback',
        agent: target.agent,
        name: target.name,
        kind: target.kind,
        file: target.file,
        scope: target.scope,
        backup: '',
        existedBefore: target.existedBefore,
        wroteHash: target.wroteHash,
        rolledBackFrom: target.id,
        ...(target.isDir ? { isDir: true } : {}),
      });
      await clearPendingAudit(home, rollbackId).catch(() => {});
    } catch (err) {
      // The filesystem transition already completed. Return that known
      // outcome with explicit missing provenance; throwing would make public
      // clients say “not completed” and invite a destructive retry.
      auditRecorded = false;
      reason =
        `rollback succeeded (${action}) but audit log write failed; ` +
        `do not re-run this rollback; audit error: ${msg(err)}`;
    }

    let lockWarning: string | undefined;
    if (target.kind) {
      try {
        // fleet no longer knows the provenance of what rollback left behind
        await removeLockEntry(target.kind, target.name, target.agent, home, target.scope ?? 'user');
      } catch (error) {
        // The target recovery is real and must not be reversed or hidden, but
        // callers also need to know that provenance cleanup did not complete.
        lockWarning = `rollback completed, but fleet.lock cleanup failed: ${msg(error)}`;
      }
    }

    if (postCommitCleanupDir) {
      try {
        await removeDir(postCommitCleanupDir);
      } catch {
        reason = `${reason ? `${reason}; ` : ''}stale detached directory left behind (cleanup failed)`;
      }
    }
    if (postCommitCleanupFile) {
      try {
        await rm(postCommitCleanupFile, { force: true });
      } catch {
        reason = `${reason ? `${reason}; ` : ''}stale detached file left behind (cleanup failed)`;
      }
    }

    return { file: target.file, action, reason, auditRecorded, ...(lockWarning ? { lockWarning } : {}) };
  } finally {
    await release();
  }
}
