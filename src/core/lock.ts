import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { chmod, lstat, readFile, rename, mkdir, open, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { sha256 } from './hash.js';
import type { ApplyResult } from './writer.js';
import { pluginCoordinate } from './plugin-coordinate.js';
import { fleetHomeDir } from './config.js';
import { isTrustReasonCode, type GateVerdict, type TrustReasonCode } from './trustgate.js';
import { containsNonPublicControl } from './redact.js';

/**
 * fleet.lock — provenance + pinning for everything fleet installed: origin
 * (where it came from), contentHash (what bytes landed), when, and the audit
 * id. See docs/design-lock.md. A known damaged lock blocks new mutation so
 * provenance is not silently lost. A lock write failure discovered only after
 * a target/vendor mutation degrades to a warning and never hides or reverts
 * the real applied state.
 */

export type CapabilityOrigin =
  | { type: 'npm' | 'pypi'; id: string; version?: string }
  | { type: 'dir'; path: string }
  | { type: 'github'; repository: string; commit: string; path: string }
  | { type: 'marketplace'; selector: string }
  | { type: 'manual' };

export interface StoredGateVerdict {
  level: GateVerdict['level'];
  reasons: string[];
  /** Absent only on locks written before stable reason codes were added. */
  reasonCodes?: TrustReasonCode[];
}

export interface LockEntry {
  kind: string;
  name: string;
  agent: string;
  scope?: string;
  /** Vendor registry identity for plugins; separate from the logical name. */
  marketplace?: string;
  origin: CapabilityOrigin;
  /** hashing scheme marker — entries without it predate canonical hashing and
   * cannot be verified against live state (drift reports them unverifiable) */
  hashScheme?: 'canonical-v1' | 'canonical-v2';
  /** install-time trust verdict (static facts; see core/trustgate.ts) */
  trust?: StoredGateVerdict;
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
export interface LockReadResult {
  lock: LockFile;
  status: 'available' | 'not-present' | 'unavailable' | 'malformed';
}

/** Self-delimiting key — names/agents may contain ':' or '@'. Scope is part of
 * identity: a user-scope entry must not mask a same-name project-scope rogue. */
export function lockKey(
  kind: string,
  name: string,
  agent: string,
  scope = 'user',
  marketplace?: string,
): string {
  return JSON.stringify(marketplace ? [kind, name, agent, scope, marketplace] : [kind, name, agent, scope]);
}

function lockPath(fleetHome?: string): string {
  return join(fleetHomeDir(fleetHome), 'fleet.lock');
}

export function isCapabilityOrigin(value: unknown): value is CapabilityOrigin {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const origin = value as Record<string, unknown>;
  if (origin.type === 'manual') return true;
  if (origin.type === 'dir') return typeof origin.path === 'string';
  if (origin.type === 'github') {
    return (
      Object.keys(origin).length === 4 &&
      Object.keys(origin).every((key) => ['type', 'repository', 'commit', 'path'].includes(key)) &&
      typeof origin.repository === 'string' &&
      /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(origin.repository) &&
      !origin.repository.includes('..') &&
      typeof origin.commit === 'string' &&
      /^[0-9a-f]{40}$/i.test(origin.commit) &&
      typeof origin.path === 'string' &&
      origin.path.length > 0 &&
      origin.path.length <= 500 &&
      !origin.path.startsWith('/') &&
      !origin.path.includes('\\') &&
      !containsNonPublicControl(origin.path) &&
      (origin.path === '.' || !origin.path.split('/').some((part) => !part || part === '.' || part === '..'))
    );
  }
  if (origin.type === 'marketplace') return typeof origin.selector === 'string';
  return (
    (origin.type === 'npm' || origin.type === 'pypi') &&
    typeof origin.id === 'string' &&
    (origin.version === undefined || typeof origin.version === 'string')
  );
}

function isLockEntry(value: unknown): value is LockEntry {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  const trust = entry.trust as Record<string, unknown> | undefined;
  const validTrust =
    trust === undefined ||
    (trust !== null &&
      typeof trust === 'object' &&
      !Array.isArray(trust) &&
      Object.keys(trust).every((key) => key === 'level' || key === 'reasons' || key === 'reasonCodes') &&
      (trust.level === 'ok' || trust.level === 'caution') &&
      Array.isArray(trust.reasons) &&
      trust.reasons.every((reason) => typeof reason === 'string') &&
      (trust.reasonCodes === undefined ||
        (Array.isArray(trust.reasonCodes) && trust.reasonCodes.every(isTrustReasonCode))) &&
      ((trust.level === 'ok' &&
        trust.reasons.length === 0 &&
        (trust.reasonCodes === undefined || trust.reasonCodes.length === 0)) ||
        (trust.level === 'caution' &&
          trust.reasons.length > 0 &&
          (trust.reasonCodes === undefined || trust.reasonCodes.length > 0))));
  return (
    typeof entry.kind === 'string' &&
    typeof entry.name === 'string' &&
    typeof entry.agent === 'string' &&
    (entry.scope === undefined || typeof entry.scope === 'string') &&
    (entry.marketplace === undefined || typeof entry.marketplace === 'string') &&
    isCapabilityOrigin(entry.origin) &&
    (entry.hashScheme === undefined ||
      entry.hashScheme === 'canonical-v1' ||
      entry.hashScheme === 'canonical-v2') &&
    (entry.contentHash === undefined || typeof entry.contentHash === 'string') &&
    typeof entry.installedAt === 'string' &&
    (entry.auditId === undefined || typeof entry.auditId === 'string') &&
    (entry.op === 'install' || entry.op === 'update') &&
    validTrust
  );
}

function canonicalizeEntries(entries: Record<string, unknown>): LockFile | undefined {
  const normalized: Record<string, LockEntry> = {};
  for (const value of Object.values(entries)) {
    if (!isLockEntry(value)) return undefined;
    let entry = value;
    if (entry.kind === 'plugin') {
      let marketplace = entry.marketplace;
      if (marketplace) {
        if (entry.origin.type !== 'marketplace') return undefined;
        try {
          const coordinate = pluginCoordinate(entry.origin.selector);
          if (coordinate.name !== entry.name || coordinate.marketplace !== marketplace) return undefined;
        } catch {
          return undefined;
        }
      } else if (entry.origin.type === 'marketplace') {
        try {
          const coordinate = pluginCoordinate(entry.origin.selector);
          if (coordinate.name === entry.name) marketplace = coordinate.marketplace;
        } catch {
          // Unknown legacy marketplace remains explicitly unverifiable.
        }
      }
      entry = { ...entry, ...(marketplace ? { marketplace } : {}) };
    }
    const key = lockKey(
      entry.kind,
      entry.name,
      entry.agent,
      entry.scope ?? 'user',
      entry.kind === 'plugin' ? entry.marketplace : undefined,
    );
    const existing = normalized[key];
    // Legacy releases sometimes stored an otherwise valid row under a
    // non-canonical key. Migrate those rows on read, but never choose silently
    // between conflicting provenance claims that collapse to one identity.
    if (existing && !isDeepStrictEqual(existing, entry)) return undefined;
    normalized[key] = entry;
  }
  return { version: 1, entries: normalized };
}

export async function readLockState(fleetHome?: string): Promise<LockReadResult> {
  const p = lockPath(fleetHome);
  let text: string;
  try {
    const info = await lstat(p);
    if (info.isSymbolicLink() || !info.isFile()) {
      return { lock: structuredClone(EMPTY), status: 'unavailable' };
    }
    text = await readFile(p, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { lock: structuredClone(EMPTY), status: 'not-present' };
    }
    return { lock: structuredClone(EMPTY), status: 'unavailable' };
  }
  try {
    const doc: unknown = JSON.parse(text);
    if (
      doc &&
      typeof doc === 'object' &&
      (doc as Record<string, unknown>).version === 1 &&
      (doc as Record<string, unknown>).entries &&
      typeof (doc as Record<string, unknown>).entries === 'object' &&
      !Array.isArray((doc as Record<string, unknown>).entries)
    ) {
      const lock = canonicalizeEntries((doc as { entries: Record<string, unknown> }).entries);
      if (lock) return { lock, status: 'available' };
    }
    return { lock: structuredClone(EMPTY), status: 'malformed' };
  } catch {
    return { lock: structuredClone(EMPTY), status: 'malformed' };
  }
}

/** Read-only consumers can render an empty best-effort view, while the status
 * API and every mutation retain the distinction between absent and damaged. */
export async function readLock(fleetHome?: string): Promise<LockFile> {
  return (await readLockState(fleetHome)).lock;
}

async function readLockForUpdate(fleetHome?: string): Promise<LockFile> {
  const result = await readLockState(fleetHome);
  if (result.status === 'unavailable' || result.status === 'malformed') {
    throw new Error('fleet: fleet.lock is unavailable or malformed; refusing provenance overwrite');
  }
  return result.lock;
}

async function writeLock(lock: LockFile, fleetHome?: string): Promise<void> {
  const p = lockPath(fleetHome);
  const parent = dirname(p);
  const parentExisted = existsSync(parent);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if (!parentExisted) await chmod(parent, 0o700);
  try {
    const info = await lstat(p);
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new Error('fleet: refusing non-regular fleet.lock target');
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const tmp = `${p}.tmp-${process.pid}-${randomUUID()}`;
  try {
    const fh = await open(tmp, 'wx', 0o600);
    try {
      await fh.chmod(0o600);
      await fh.writeFile(JSON.stringify(lock, null, 2) + '\n', 'utf8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tmp, p);
    const dirHandle = await open(parent, 'r');
    try {
      await dirHandle.sync();
    } finally {
      await dirHandle.close();
    }
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
  trust?: GateVerdict,
): Promise<void> {
  applied = applied.filter((result) => result.auditRecorded);
  if (applied.length === 0) return;
  const lock = await readLockForUpdate(fleetHome);
  for (const r of applied) {
    const c = r.change;
    const key = lockKey(c.kind ?? 'mcp-server', c.name, c.agent, c.scope);
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
      hashScheme: c.fsKind === 'dir' ? 'canonical-v2' : 'canonical-v1',
      contentHash: c.fsKind === 'dir' ? r.wroteHash : specHash(c.canonical ?? c.after),
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
  scope = 'user',
): Promise<void> {
  const lock = await readLockForUpdate(fleetHome);
  const key = lockKey(kind, name, agent, scope);
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
  const coordinate = pluginCoordinate(selector);
  const name = coordinate.name;
  const lock = await readLockForUpdate(fleetHome);
  const key = lockKey('plugin', name, agent, 'user', coordinate.marketplace);
  if (action === 'remove') {
    delete lock.entries[key];
    for (const [storedKey, entry] of Object.entries(lock.entries)) {
      if (
        entry.kind === 'plugin' &&
        entry.name === name &&
        entry.agent === agent &&
        entry.marketplace === coordinate.marketplace
      ) {
        delete lock.entries[storedKey];
      }
    }
  } else {
    for (const [storedKey, entry] of Object.entries(lock.entries)) {
      if (
        entry.kind === 'plugin' &&
        entry.name === name &&
        entry.agent === agent &&
        entry.marketplace === coordinate.marketplace
      ) {
        delete lock.entries[storedKey];
      }
    }
    lock.entries[key] = {
      kind: 'plugin',
      name,
      agent,
      ...(coordinate.marketplace ? { marketplace: coordinate.marketplace } : {}),
      origin: { type: 'marketplace', selector },
      installedAt: new Date().toISOString(),
      op: 'install',
    };
  }
  await writeLock(lock, fleetHome);
}
