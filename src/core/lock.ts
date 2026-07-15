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
  /** install-time trust verdict (static facts; see core/trustgate.ts) */
  trust?: { level: 'ok' | 'caution'; reasons: string[] };
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

/** Self-delimiting key — names/agents may contain ':' or '@'. */
export function lockKey(kind: string, name: string, agent: string): string {
  return JSON.stringify([kind, name, agent]);
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
    if (
      doc &&
      typeof doc === 'object' &&
      doc.version === 1 &&
      doc.entries &&
      typeof doc.entries === 'object' &&
      !Array.isArray(doc.entries)
    ) {
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

function sortKeysDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeysDeep);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeysDeep((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

/** Canonical hash for a file-kind capability: the entry itself (keys sorted —
 * insertion order must not read as drift), not the whole file. */
export function specHash(after: unknown): string | undefined {
  if (after === undefined) return undefined;
  return sha256(JSON.stringify(sortKeysDeep(after)));
}

/**
 * Fold a batch of applied changes into the lock (one shared origin — a single
 * logical install fans out to several agents). Installs/updates upsert;
 * removes delete. op records what actually happened: a write over an existing
 * target (backup captured) is an update regardless of how it was planned.
 */
export async function updateLockFromApplied(
  applied: ApplyResult[],
  origin: CapabilityOrigin,
  fleetHome?: string,
  trust?: { level: 'ok' | 'caution'; reasons: string[] },
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
      op: r.backup ? 'update' : 'install',
      ...(trust ? { trust } : {}),
    };
  }
  await writeLock(lock, fleetHome);
}

/** Best-effort removal after a successful rollback: fleet no longer knows the
 * provenance of whatever bytes rollback restored — an honest lock has no entry. */
export async function removeLockEntry(
  kind: string,
  name: string,
  agent: string,
  fleetHome?: string,
): Promise<void> {
  const lock = await readLock(fleetHome);
  const key = lockKey(kind, name, agent);
  if (!(key in lock.entries)) return;
  delete lock.entries[key];
  await writeLock(lock, fleetHome);
}

/** Upsert/remove a delegated (vendor-CLI) plugin entry. */
export async function updateLockForPlugin(
  action: 'install' | 'remove',
  agent: string,
  selector: string,
  fleetHome?: string,
): Promise<void> {
  // '@scope/name@market' — the MARKETPLACE suffix is the LAST '@' (never index
  // 0, which is a scope marker)
  const at = selector.lastIndexOf('@');
  const name = at > 0 ? selector.slice(0, at) : selector;
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
