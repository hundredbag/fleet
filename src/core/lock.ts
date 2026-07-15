import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, rename, mkdir, open, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { sha256 } from './hash.js';
import type { ApplyResult } from './writer.js';

/**
 * fleet.lock — provenance + pinning for everything fleet installed: origin
 * (where it came from), contentHash (what bytes landed), when, and the audit
 * id. See docs/design-lock.md. The lock is METADATA, not a gate: a failed lock
 * write degrades to a warning, never blocks or reverts an applied change.
 */

export type CapabilityOrigin =
  | { type: 'npm' | 'pypi'; id: string; version?: string }
  | { type: 'dir'; path: string }
  | { type: 'marketplace'; selector: string }
  | { type: 'manual' };

export interface LockEntry {
  kind: string;
  name: string;
  agent: string;
  scope?: string;
  origin: CapabilityOrigin;
  /** skills: dir manifest hash; file kinds: sha256 of the canonical spec/body */
  contentHash?: string;
  installedAt: string;
  auditId?: string;
  op: 'install' | 'update';
}

export interface LockFile {
  version: 1;
  entries: Record<string, LockEntry>;
}

const EMPTY: LockFile = { version: 1, entries: {} };

export function lockKey(kind: string, name: string, agent: string): string {
  return `${kind}:${name}@${agent}`;
}

function lockPath(fleetHome?: string): string {
  return join(fleetHome ?? join(homedir(), '.fleet'), 'fleet.lock');
}

/** Read the lock file; corrupt/absent → empty (the lock is best-effort metadata). */
export async function readLock(fleetHome?: string): Promise<LockFile> {
  const p = lockPath(fleetHome);
  if (!existsSync(p)) return structuredClone(EMPTY);
  try {
    const doc = JSON.parse(await readFile(p, 'utf8'));
    if (doc && typeof doc === 'object' && doc.version === 1 && typeof doc.entries === 'object') {
      return doc as LockFile;
    }
    return structuredClone(EMPTY);
  } catch {
    return structuredClone(EMPTY);
  }
}

async function writeLock(lock: LockFile, fleetHome?: string): Promise<void> {
  const p = lockPath(fleetHome);
  await mkdir(dirname(p), { recursive: true });
  const tmp = `${p}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const fh = await open(tmp, 'w');
    try {
      await fh.writeFile(JSON.stringify(lock, null, 2) + '\n', 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, p);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
}

/** Canonical hash for a file-kind capability: the entry itself, not the whole
 * file (unrelated edits to a shared config must not read as capability drift). */
export function specHash(after: unknown): string | undefined {
  if (after === undefined) return undefined;
  return sha256(JSON.stringify(after));
}

/**
 * Fold a batch of applied changes into the lock. Installs/updates upsert;
 * removes delete. `origins` maps agent id → origin for this operation (one
 * logical install can fan out to several agents with the same origin).
 */
export async function updateLockFromApplied(
  applied: ApplyResult[],
  origin: CapabilityOrigin,
  fleetHome?: string,
): Promise<void> {
  if (applied.length === 0) return;
  const lock = await readLock(fleetHome);
  for (const r of applied) {
    const c = r.change;
    const key = lockKey(c.kind ?? 'mcp-server', c.name, c.agent);
    if (c.op === 'remove') {
      delete lock.entries[key];
      continue;
    }
    lock.entries[key] = {
      kind: c.kind ?? 'mcp-server',
      name: c.name,
      agent: c.agent,
      scope: c.scope,
      origin,
      contentHash: c.fsKind === 'dir' ? r.wroteHash : specHash(c.after),
      installedAt: new Date().toISOString(),
      auditId: r.auditId,
      op: c.op,
    };
  }
  await writeLock(lock, fleetHome);
}

/** Upsert/remove a delegated (vendor-CLI) plugin entry. */
export async function updateLockForPlugin(
  action: 'install' | 'remove',
  agent: string,
  selector: string,
  fleetHome?: string,
): Promise<void> {
  const name = selector.split('@')[0] ?? selector;
  const lock = await readLock(fleetHome);
  const key = lockKey('plugin', name, agent);
  if (action === 'remove') {
    delete lock.entries[key];
  } else {
    lock.entries[key] = {
      kind: 'plugin',
      name,
      agent,
      origin: { type: 'marketplace', selector },
      installedAt: new Date().toISOString(),
      op: 'install',
    };
  }
  await writeLock(lock, fleetHome);
}
