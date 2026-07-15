import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import type { AgentAdapter } from './adapter.js';
import { loadAdapters } from './registry.js';
import { loadConfig, configPath, type FleetConfig } from './config.js';
import { readAudit } from './writer.js';

/**
 * `fleet doctor` — categorized health checks over everything fleet depends on:
 * agent adapters (do their configs still parse?), fleet's own state dir
 * (audit/backups/ledgers/lock), and ~/.fleet/config.json. Read-only.
 * Exit codes: 0 healthy · 1 warnings · 2 errors — usable as a scripting gate.
 */

export type DoctorLevel = 'ok' | 'warn' | 'error';

export interface DoctorFinding {
  category: 'adapters' | 'state' | 'config';
  level: DoctorLevel;
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

function withDeadline<T>(p: Promise<T>, what: string): Promise<T> {
  return Promise.race([
    p,
    new Promise<never>((_, rej) =>
      setTimeout(
        () => rej(new Error(`${what} timed out after ${ADAPTER_DEADLINE_MS / 1000}s`)),
        ADAPTER_DEADLINE_MS,
      ).unref?.(),
    ),
  ]);
}

async function checkAdapters(adapters: AgentAdapter[], out: DoctorFinding[]): Promise<void> {
  for (const a of adapters) {
    try {
      const d = await withDeadline(a.detect(), `${a.id} detect()`);
      if (!d.present) {
        out.push({ category: 'adapters', level: 'ok', message: `${a.id}: not installed (skipped)` });
        continue;
      }
      try {
        const items = await withDeadline(a.readInventory(), `${a.id} inventory read`);
        out.push({
          category: 'adapters',
          level: 'ok',
          message: `${a.id}: present, ${items.length} capabilities read`,
        });
      } catch (e) {
        out.push({
          category: 'adapters',
          level: 'error',
          message: `${a.id}: present but inventory read FAILED — ${msg(e)} (check ${d.configPaths.join(', ')})`,
        });
      }
    } catch (e) {
      out.push({ category: 'adapters', level: 'error', message: `${a.id}: detect() failed — ${msg(e)}` });
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
    out.push({ category, level: 'error', message: `${what}: check failed — ${msg(e)}` });
  }
}

async function checkState(home: string, out: DoctorFinding[]): Promise<void> {
  // audit log: parseable? backups referenced by restorable records still exist?
  const auditFile = join(home, 'audit.jsonl');
  await guarded(out, 'state', 'audit log', async () => {
    if (!existsSync(auditFile)) {
      out.push({ category: 'state', level: 'ok', message: 'audit log: none yet (no changes applied)' });
    } else {
      const { total, corrupt } = await countCorruptJsonl(auditFile);
      out.push({
        category: 'state',
        level: corrupt > 0 ? 'warn' : 'ok',
        message:
          corrupt > 0
            ? `audit log: ${corrupt}/${total} corrupt lines (those changes can't be rolled back)`
            : `audit log: ${total} records, all parseable`,
      });
      const records = await readAudit(home);
      const undone = new Set(records.map((r) => r.rolledBackFrom).filter(Boolean));
      const restorable = records
        .filter((r) => r.op !== 'rollback' && !undone.has(r.id) && r.existedBefore && r.backup)
        .slice(-BACKUP_CHECK_LIMIT);
      const missing = restorable.filter((r) => !existsSync(r.backup));
      if (missing.length > 0) {
        out.push({
          category: 'state',
          level: 'warn',
          message: `backups: ${missing.length}/${restorable.length} recent restorable records point at MISSING backup files (rollback for those will fail)`,
        });
      } else if (restorable.length > 0) {
        out.push({
          category: 'state',
          level: 'ok',
          message: `backups: all ${restorable.length} recent restorable records have their backup files`,
        });
      }
    }
  });

  // stale lock = a crashed operation blocks every future write
  const lockPath = join(home, '.lock');
  await guarded(out, 'state', 'lock', async () => {
    if (!existsSync(lockPath)) return;
    const age = Date.now() - (await stat(lockPath)).mtimeMs;
    if (age > STALE_LOCK_MS) {
      out.push({
        category: 'state',
        level: 'warn',
        message: `lock: ${lockPath} is ${Math.round(age / 60000)} min old — likely stale; remove it if no fleet operation is running`,
      });
    } else {
      // a FRESH lock is normal operation, not a health problem (a warn here
      // would flunk the scripted gate whenever an install is mid-flight)
      out.push({
        category: 'state',
        level: 'ok',
        message: `lock: an operation appears to be in progress (${lockPath})`,
      });
    }
  });

  const delegated = join(home, 'delegated.jsonl');
  await guarded(out, 'state', 'delegated ledger', async () => {
    if (!existsSync(delegated)) return;
    const { total, corrupt } = await countCorruptJsonl(delegated);
    out.push({
      category: 'state',
      level: corrupt > 0 ? 'warn' : 'ok',
      message:
        corrupt > 0
          ? `delegated ledger: ${corrupt}/${total} corrupt lines`
          : `delegated ledger: ${total} records, all parseable`,
    });
  });
}

function checkConfig(config: FleetConfig, knownAgents: string[], out: DoctorFinding[]): void {
  for (const mod of config.adapterModules) {
    if (!existsSync(mod)) {
      out.push({
        category: 'config',
        level: 'error',
        message: `adapterModules: ${mod} does not exist (BYO adapter will fail to load)`,
      });
    }
  }
  for (const id of config.agents ?? []) {
    if (!knownAgents.includes(id)) {
      out.push({
        category: 'config',
        level: 'warn',
        message: `agents: "${id}" is not a known adapter id (known: ${knownAgents.join(', ')})`,
      });
    }
  }
  out.push({
    category: 'config',
    level: 'ok',
    message: `config parsed (hub: ${config.hubUrl ? 'configured' : 'none'}, BYO adapters: ${config.adapterModules.length})`,
  });
}

const msg = (e: unknown): string => (e instanceof Error ? e.message : String(e));

export async function runDoctor(
  opts: { fleetHome?: string; adapters?: AgentAdapter[]; config?: FleetConfig } = {},
): Promise<DoctorReport> {
  const home = opts.fleetHome ?? join(homedir(), '.fleet');
  const findings: DoctorFinding[] = [];

  let config: FleetConfig | undefined = opts.config;
  if (!config) {
    // loadConfig() deliberately never throws (degrades to defaults) — so parse
    // the file EXPLICITLY here, or a broken config.json would report healthy
    const cfgFile = configPath(opts.fleetHome);
    if (existsSync(cfgFile)) {
      try {
        JSON.parse(await readFile(cfgFile, 'utf8'));
      } catch (e) {
        findings.push({
          category: 'config',
          level: 'warn',
          message: `config.json is invalid JSON — fleet is running on DEFAULTS (${msg(e)})`,
        });
      }
    }
    config = loadConfig(opts.fleetHome);
  }

  let adapters: AgentAdapter[] = [];
  try {
    adapters = opts.adapters ?? (await loadAdapters(config));
  } catch (e) {
    findings.push({ category: 'adapters', level: 'error', message: `adapter loading failed: ${msg(e)}` });
  }

  await checkAdapters(adapters, findings);
  await checkState(home, findings);
  if (config) {
    checkConfig(
      config,
      adapters.map((a) => a.id),
      findings,
    );
  }

  const exitCode = findings.some((f) => f.level === 'error')
    ? 2
    : findings.some((f) => f.level === 'warn')
      ? 1
      : 0;
  return { findings, exitCode };
}
