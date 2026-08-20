import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import type { AgentAdapter } from './adapter.js';
import { loadAdapters } from './registry.js';
import {
  CONFIGURABLE_FEED_SOURCE_IDS,
  fleetHomeDir,
  readEffectiveConfigState,
  type FleetConfig,
} from './config.js';
import { readAuditLedger } from './writer.js';
import { readDelegatedLedger } from './delegate.js';
import { readLockState } from './lock.js';
import { hashDir } from './fsutil.js';
import { sha256 } from './hash.js';
import { buildInventory } from './inventory.js';
import type { AdapterLoadDiagnostic } from './plugins.js';

/**
 * `fleet doctor` — categorized health checks over everything fleet depends on:
 * agent adapters (do their configs still parse?), fleet's own state dir
 * (audit/backups/ledgers/lock), and ~/.fleet/config.json. Read-only.
 * Exit codes: 0 healthy · 1 warnings · 2 errors — usable as a scripting gate.
 */

export type DoctorLevel = 'ok' | 'warn' | 'error';
export type DoctorCode =
  | 'ADAPTER_LOAD_FAILED'
  | 'ADAPTER_CONTRACT_UNSUPPORTED'
  | 'ADAPTER_CONTRACT_INVALID'
  | 'ADAPTER_SHADOWED'
  | 'ADAPTER_DUPLICATE'
  | 'AGENT_READY'
  | 'AGENT_INSTALLED_UNCONFIGURED'
  | 'AGENT_RUNTIME_MISSING'
  | 'AGENT_RUNTIME_UNVERIFIABLE'
  | 'AGENT_NOT_DETECTED'
  | 'AGENT_DETECT_FAILED'
  | 'AGENT_CONFIGURATION_UNAVAILABLE'
  | 'AGENT_INVENTORY_FAILED'
  | 'STATE_CHECK_FAILED'
  | 'AUDIT_NOT_PRESENT'
  | 'AUDIT_RECOVERY_PENDING'
  | 'AUDIT_CORRUPT'
  | 'AUDIT_OK'
  | 'BACKUP_MISSING'
  | 'BACKUP_UNVERIFIABLE'
  | 'BACKUP_OK'
  | 'LOCK_STATE_UNAVAILABLE'
  | 'LOCK_STATE_NOT_PRESENT'
  | 'LOCK_STATE_OK'
  | 'OPERATION_LOCK_STALE'
  | 'OPERATION_IN_PROGRESS'
  | 'DELEGATED_RECOVERY_PENDING'
  | 'DELEGATED_CORRUPT'
  | 'DELEGATED_OK'
  | 'CONFIG_REFERENCE_MISSING'
  | 'CONFIG_AGENT_UNKNOWN'
  | 'CONFIG_FEED_SOURCE_UNKNOWN'
  | 'CONFIG_FEED_SOURCE_UNAVAILABLE'
  | 'CONFIG_OK'
  | 'CONFIG_UNREADABLE'
  | 'CONFIG_INVALID'
  | 'TEAM_POLICY_UNREADABLE'
  | 'TEAM_POLICY_INVALID'
  | 'TEAM_POLICY_OK';
export type DoctorRecovery =
  | 'INSTALL_OR_CONFIGURE_AGENT'
  | 'INITIALIZE_AGENT_CONFIGURATION'
  | 'CHECK_AGENT_INSTALLATION'
  | 'CHECK_ADAPTER'
  | 'REPAIR_AGENT_CONFIGURATION'
  | 'RECOVER_PENDING_CHANGE'
  | 'REPAIR_FLEET_STATE'
  | 'RESTORE_BACKUP'
  | 'WAIT_OR_CLEAR_STALE_LOCK'
  | 'REPAIR_FLEET_CONFIG'
  | 'REPAIR_TEAM_POLICY';

export interface DoctorFinding {
  category: 'adapters' | 'state' | 'config';
  level: DoctorLevel;
  /** Stable machine-readable classification; never derived from message text. */
  code: DoctorCode;
  agent?: string;
  recovery?: DoctorRecovery;
  message: string;
}

export interface DoctorReport {
  findings: DoctorFinding[];
  /** 0 = all ok, 1 = warnings only, 2 = at least one error */
  exitCode: 0 | 1 | 2;
}

const STALE_LOCK_MS = 10 * 60 * 1000;
// ponytail: full-scan of recent records only; audit files stay small in practice
const BACKUP_CHECK_LIMIT = 100;

const ADAPTER_DEADLINE_MS = 10_000;

async function checkAdapters(
  adapters: AgentAdapter[],
  out: DoctorFinding[],
  deadlineMs: number,
): Promise<void> {
  const inventory = await buildInventory(adapters, { deadlineMs });
  const itemCounts = new Map<string, number>();
  for (const item of inventory.items) itemCounts.set(item.agent, (itemCounts.get(item.agent) ?? 0) + 1);

  for (const agent of inventory.agents) {
    const common = { category: 'adapters' as const, agent: agent.id };
    switch (agent.setupStatus) {
      case 'ready':
        out.push({
          ...common,
          level: 'ok',
          code: 'AGENT_READY',
          message: `${agent.id}: configured, runtime available, ${itemCounts.get(agent.id) ?? 0} capabilities read`,
        });
        break;
      case 'installed-unconfigured':
        out.push({
          ...common,
          level: 'warn',
          code: 'AGENT_INSTALLED_UNCONFIGURED',
          recovery: 'INITIALIZE_AGENT_CONFIGURATION',
          message: `${agent.id}: runtime installed but no known configuration/capability paths exist`,
        });
        break;
      case 'configured-runtime-missing':
        out.push({
          ...common,
          level: 'warn',
          code: 'AGENT_RUNTIME_MISSING',
          recovery: 'CHECK_AGENT_INSTALLATION',
          message: `${agent.id}: configuration exists and is readable, but the runtime executable was not found`,
        });
        break;
      case 'configured-runtime-unverifiable':
        out.push({
          ...common,
          level: 'warn',
          code: 'AGENT_RUNTIME_UNVERIFIABLE',
          recovery: 'CHECK_AGENT_INSTALLATION',
          message: `${agent.id}: configuration is readable, but runtime availability could not be verified`,
        });
        break;
      case 'not-detected':
        out.push({
          ...common,
          level: 'ok',
          code: 'AGENT_NOT_DETECTED',
          recovery: 'INSTALL_OR_CONFIGURE_AGENT',
          message: `${agent.id}: neither a runtime nor known configuration/capability paths were detected`,
        });
        break;
      case 'detection-unavailable':
        out.push({
          ...common,
          level: 'error',
          code: 'AGENT_DETECT_FAILED',
          recovery: 'CHECK_ADAPTER',
          message: `${agent.id}: detection failed — ${agent.note ?? 'unknown adapter error'}`,
        });
        break;
      case 'configuration-unavailable':
        out.push({
          ...common,
          level: 'error',
          code: 'AGENT_CONFIGURATION_UNAVAILABLE',
          recovery: 'REPAIR_AGENT_CONFIGURATION',
          message: `${agent.id}: configuration topology or readability is unsafe — ${agent.note ?? 'inspect known paths'}`,
        });
        break;
      case 'inventory-unavailable':
        out.push({
          ...common,
          level: 'error',
          code: 'AGENT_INVENTORY_FAILED',
          recovery: 'REPAIR_AGENT_CONFIGURATION',
          message: `${agent.id}: inventory read FAILED — ${agent.note ?? 'unknown read error'}`,
        });
        break;
    }
  }
}

async function countCorruptJsonl(file: string): Promise<{ total: number; corrupt: number }> {
  const text = await readFile(file, 'utf8');
  let total = 0;
  let corrupt = 0;
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    total++;
    try {
      JSON.parse(line);
    } catch {
      corrupt++;
    }
  }
  return { total, corrupt };
}

async function guarded(
  out: DoctorFinding[],
  category: DoctorFinding['category'],
  what: string,
  fn: () => Promise<void>,
): Promise<void> {
  try {
    await fn();
  } catch (e) {
    // an unreadable state dir is the SICKEST state — report it, don't crash
    out.push({
      category,
      level: 'error',
      code: 'STATE_CHECK_FAILED',
      recovery: 'REPAIR_FLEET_STATE',
      message: `${what}: check failed — ${msg(e)}`,
    });
  }
}

async function checkState(home: string, out: DoctorFinding[]): Promise<void> {
  // audit log: parseable? backups referenced by restorable records still exist?
  const auditFile = join(home, 'audit.jsonl');
  await guarded(out, 'state', 'audit log', async () => {
    const audit = await readAuditLedger(home);
    if (audit.status === 'not-present') {
      out.push({
        category: 'state',
        level: 'ok',
        code: 'AUDIT_NOT_PRESENT',
        message: 'audit log: none yet (no changes applied)',
      });
    } else {
      if (audit.status === 'unavailable') throw new Error('audit history unavailable');
      if (audit.status === 'incomplete') {
        out.push({
          category: 'state',
          level: 'warn',
          code: 'AUDIT_RECOVERY_PENDING',
          recovery: 'RECOVER_PENDING_CHANGE',
          message: 'audit ledger: an applied change is pending manual recovery',
        });
        return;
      }
      const total = await countCorruptJsonl(auditFile)
        .then((result) => result.total)
        .catch(() => audit.records.length + (audit.status === 'malformed' ? 1 : 0));
      const corrupt = Math.max(total - audit.records.length, audit.status === 'malformed' ? 1 : 0);
      out.push({
        category: 'state',
        level: corrupt > 0 ? 'warn' : 'ok',
        code: corrupt > 0 ? 'AUDIT_CORRUPT' : 'AUDIT_OK',
        ...(corrupt > 0 ? { recovery: 'REPAIR_FLEET_STATE' as const } : {}),
        message:
          corrupt > 0
            ? `audit log: ${corrupt}/${total} corrupt lines (those changes can't be rolled back)`
            : `audit log: ${total} records, all parseable`,
      });
      const records = audit.records;
      const undone = new Set(records.map((r) => r.rolledBackFrom).filter(Boolean));
      const restorable = records
        .filter((r) => r.op !== 'rollback' && !undone.has(r.id) && r.existedBefore && r.backup)
        .slice(-BACKUP_CHECK_LIMIT);
      const missing = restorable.filter((r) => !existsSync(r.backup));
      if (missing.length > 0) {
        out.push({
          category: 'state',
          level: 'warn',
          code: 'BACKUP_MISSING',
          recovery: 'RESTORE_BACKUP',
          message: `backups: ${missing.length}/${restorable.length} recent restorable records point at MISSING backup files (rollback for those will fail)`,
        });
      } else if (restorable.length > 0) {
        let invalid = 0;
        for (const record of restorable) {
          try {
            const root = await lstat(dirname(record.backup));
            const backup = await lstat(record.backup);
            const validLocation = dirname(resolve(record.backup)) === resolve(home, 'backups');
            const validType = record.isDir ? backup.isDirectory() : backup.isFile();
            const actualHash = record.isDir
              ? await hashDir(record.backup)
              : sha256(await readFile(record.backup, 'utf8'));
            const validMode =
              record.isDir || record.backupMode === undefined || (backup.mode & 0o7777) === record.backupMode;
            if (
              !validLocation ||
              root.isSymbolicLink() ||
              backup.isSymbolicLink() ||
              !validType ||
              !record.backupHash ||
              actualHash !== record.backupHash ||
              !validMode
            ) {
              invalid++;
            }
          } catch {
            invalid++;
          }
        }
        out.push({
          category: 'state',
          level: invalid > 0 ? 'warn' : 'ok',
          code: invalid > 0 ? 'BACKUP_UNVERIFIABLE' : 'BACKUP_OK',
          ...(invalid > 0 ? { recovery: 'RESTORE_BACKUP' as const } : {}),
          message:
            invalid > 0
              ? `backups: ${invalid}/${restorable.length} recent backups have unverifiable content or topology`
              : `backups: all ${restorable.length} recent restorable records have verified backup content`,
        });
      }
    }
  });

  await guarded(out, 'state', 'fleet.lock', async () => {
    const lock = await readLockState(home);
    if (lock.status === 'unavailable' || lock.status === 'malformed') {
      out.push({
        category: 'state',
        level: 'error',
        code: 'LOCK_STATE_UNAVAILABLE',
        recovery: 'REPAIR_FLEET_STATE',
        message: `fleet.lock: ${lock.status}; provenance updates are blocked to prevent data loss`,
      });
    } else {
      out.push({
        category: 'state',
        level: 'ok',
        code: lock.status === 'not-present' ? 'LOCK_STATE_NOT_PRESENT' : 'LOCK_STATE_OK',
        message:
          lock.status === 'not-present'
            ? 'fleet.lock: none yet'
            : `fleet.lock: ${Object.keys(lock.lock.entries).length} entries parseable`,
      });
    }
  });

  // stale lock = a crashed operation blocks every future write
  const lockPath = join(home, '.lock');
  await guarded(out, 'state', 'lock', async () => {
    let info;
    try {
      info = await lstat(lockPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isFile()) throw new Error('operation lock is not a regular file');
    const age = Date.now() - info.mtimeMs;
    if (age > STALE_LOCK_MS) {
      out.push({
        category: 'state',
        level: 'warn',
        code: 'OPERATION_LOCK_STALE',
        recovery: 'WAIT_OR_CLEAR_STALE_LOCK',
        message: `lock: ${lockPath} is ${Math.round(age / 60000)} min old — likely stale; remove it if no fleet operation is running`,
      });
    } else {
      // a FRESH lock is normal operation, not a health problem (a warn here
      // would flunk the scripted gate whenever an install is mid-flight)
      out.push({
        category: 'state',
        level: 'ok',
        code: 'OPERATION_IN_PROGRESS',
        message: `lock: an operation appears to be in progress (${lockPath})`,
      });
    }
  });

  const delegated = join(home, 'delegated.jsonl');
  await guarded(out, 'state', 'delegated ledger', async () => {
    const ledger = await readDelegatedLedger(home);
    if (ledger.status === 'not-present') return;
    if (ledger.status === 'unavailable') throw new Error('delegated history unavailable');
    const total = await countCorruptJsonl(delegated)
      .then((result) => result.total)
      .catch(() => ledger.records.length + (ledger.status === 'malformed' ? 1 : 0));
    if (ledger.records.some((record) => record.pending)) {
      out.push({
        category: 'state',
        level: 'warn',
        code: 'DELEGATED_RECOVERY_PENDING',
        recovery: 'RECOVER_PENDING_CHANGE',
        message: 'delegated ledger: a vendor outcome is pending verification',
      });
      return;
    }
    const corrupt = Math.max(total - ledger.records.length, ledger.status === 'malformed' ? 1 : 0);
    out.push({
      category: 'state',
      level: corrupt > 0 ? 'warn' : 'ok',
      code: corrupt > 0 ? 'DELEGATED_CORRUPT' : 'DELEGATED_OK',
      ...(corrupt > 0 ? { recovery: 'REPAIR_FLEET_STATE' as const } : {}),
      message:
        corrupt > 0
          ? `delegated ledger: ${corrupt}/${total} corrupt lines`
          : `delegated ledger: ${total} records, all parseable`,
    });
  });
}

function checkConfig(config: FleetConfig, knownAgents: string[], out: DoctorFinding[], parsed = true): void {
  for (const mod of config.adapterModules) {
    let localPath: string | undefined;
    if (isAbsolute(mod)) localPath = mod;
    else if (mod.startsWith('file:')) {
      try {
        localPath = fileURLToPath(mod);
      } catch {
        // The authoritative module loader diagnostic reports invalid URLs.
      }
    }
    if (localPath && !existsSync(localPath)) {
      out.push({
        category: 'config',
        level: 'error',
        code: 'CONFIG_REFERENCE_MISSING',
        recovery: 'REPAIR_FLEET_CONFIG',
        message: `adapterModules: ${mod} does not exist (BYO adapter will fail to load)`,
      });
    }
  }
  for (const id of config.agents ?? []) {
    if (!knownAgents.includes(id)) {
      out.push({
        category: 'config',
        level: 'warn',
        code: 'CONFIG_AGENT_UNKNOWN',
        recovery: 'REPAIR_FLEET_CONFIG',
        message: `agents: "${id}" is not a known adapter id (known: ${knownAgents.join(', ')})`,
      });
    }
  }
  const knownFeedSources = new Set<string>(CONFIGURABLE_FEED_SOURCE_IDS);
  for (const id of config.feedSources ?? []) {
    if (!knownFeedSources.has(id)) {
      out.push({
        category: 'config',
        level: 'warn',
        code: 'CONFIG_FEED_SOURCE_UNKNOWN',
        recovery: 'REPAIR_FLEET_CONFIG',
        message: `feedSources: "${id}" is not a known default source id`,
      });
      continue;
    }
    if (id === 'hub' && !config.hubUrl) {
      out.push({
        category: 'config',
        level: 'warn',
        code: 'CONFIG_FEED_SOURCE_UNAVAILABLE',
        recovery: 'REPAIR_FLEET_CONFIG',
        message: 'feedSources: "hub" requires hubUrl',
      });
    } else if (id === 'pulsemcp' && !process.env.PULSEMCP_API_KEY) {
      out.push({
        category: 'config',
        level: 'warn',
        code: 'CONFIG_FEED_SOURCE_UNAVAILABLE',
        recovery: 'REPAIR_FLEET_CONFIG',
        message: 'feedSources: "pulsemcp" requires PULSEMCP_API_KEY',
      });
    }
  }
  if (parsed) {
    out.push({
      category: 'config',
      level: 'ok',
      code: 'CONFIG_OK',
      message: `config parsed (hub: ${config.hubUrl ? 'configured' : 'none'}, BYO adapters: ${config.adapterModules.length})`,
    });
  }
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function runDoctor(
  opts: {
    fleetHome?: string;
    adapters?: AgentAdapter[];
    adapterLoadDiagnostics?: AdapterLoadDiagnostic[];
    config?: FleetConfig;
    adapterDeadlineMs?: number;
  } = {},
): Promise<DoctorReport> {
  const home = fleetHomeDir(opts.fleetHome);
  const findings: DoctorFinding[] = [];

  let config: FleetConfig | undefined = opts.config;
  let configParsed = true;
  if (!config) {
    const effective = readEffectiveConfigState(opts.fleetHome);
    const { configState, policyState } = effective;
    if (configState.status === 'invalid' || configState.status === 'read-failed') {
      configParsed = false;
      findings.push({
        category: 'config',
        level: configState.status === 'read-failed' ? 'error' : 'warn',
        code: configState.status === 'read-failed' ? 'CONFIG_UNREADABLE' : 'CONFIG_INVALID',
        recovery: 'REPAIR_FLEET_CONFIG',
        message:
          configState.status === 'read-failed'
            ? 'config.json is unreadable — mutations are blocked'
            : configState.reason === 'syntax'
              ? 'config.json is invalid JSON — mutations are blocked until it is repaired'
              : 'config.json has invalid field types — mutations are blocked until it is repaired',
      });
    }
    if (policyState.status === 'read-failed' || policyState.status === 'invalid') {
      findings.push({
        category: 'config',
        level: 'error',
        code: policyState.status === 'read-failed' ? 'TEAM_POLICY_UNREADABLE' : 'TEAM_POLICY_INVALID',
        recovery: 'REPAIR_TEAM_POLICY',
        message:
          policyState.status === 'read-failed'
            ? 'team-policy.json is unreadable — adapters, feeds, and mutations are blocked'
            : 'team-policy.json is invalid — adapters, feeds, and mutations are blocked',
      });
    } else if (policyState.status === 'ok') {
      findings.push({
        category: 'config',
        level: 'ok',
        code: 'TEAM_POLICY_OK',
        message: 'team policy: version 1 parsed and applied',
      });
    }
    config = effective.config;
  }

  let adapters: AgentAdapter[] = [];
  try {
    const loadDiagnostics = [...(opts.adapterLoadDiagnostics ?? [])];
    adapters =
      opts.adapters ??
      (await loadAdapters(
        config,
        undefined,
        (diagnostic) => loadDiagnostics.push(diagnostic),
        opts.adapterDeadlineMs ?? ADAPTER_DEADLINE_MS,
      ));
    for (const diagnostic of loadDiagnostics) {
      const collision = diagnostic.reason === 'shadowed' || diagnostic.reason === 'duplicate-id';
      findings.push({
        category: 'adapters',
        level: collision ? 'warn' : 'error',
        code:
          diagnostic.reason === 'shadowed'
            ? 'ADAPTER_SHADOWED'
            : diagnostic.reason === 'duplicate-id'
              ? 'ADAPTER_DUPLICATE'
              : diagnostic.reason === 'unsupported-contract'
                ? 'ADAPTER_CONTRACT_UNSUPPORTED'
                : diagnostic.reason === 'invalid-contract'
                  ? 'ADAPTER_CONTRACT_INVALID'
                  : 'ADAPTER_LOAD_FAILED',
        recovery: 'CHECK_ADAPTER',
        message: `adapter plugin[${diagnostic.index}] ${
          diagnostic.reason === 'invalid-export'
            ? 'has an invalid export'
            : diagnostic.reason === 'unsupported-contract'
              ? 'uses an unsupported adapter contract version'
              : diagnostic.reason === 'invalid-contract'
                ? 'violates the adapter contract'
                : diagnostic.reason === 'shadowed'
                  ? 'is shadowed by a built-in adapter'
                  : diagnostic.reason === 'duplicate-id'
                    ? 'duplicates an earlier adapter id'
                    : 'failed to load'
        }`,
      });
    }
  } catch (e) {
    findings.push({
      category: 'adapters',
      level: 'error',
      code: 'ADAPTER_LOAD_FAILED',
      recovery: 'CHECK_ADAPTER',
      message: `adapter loading failed: ${msg(e)}`,
    });
  }

  await checkAdapters(adapters, findings, opts.adapterDeadlineMs ?? ADAPTER_DEADLINE_MS);
  await checkState(home, findings);
  if (config) {
    checkConfig(
      config,
      adapters.map((a) => a.id),
      findings,
      configParsed,
    );
  }

  const exitCode = findings.some((f) => f.level === 'error')
    ? 2
    : findings.some((f) => f.level === 'warn')
      ? 1
      : 0;
  return { findings, exitCode };
}
