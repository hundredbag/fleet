import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, readdir, rename, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { scrubSecrets } from './redact.js';
import { readLockState, updateLockForPlugin } from './lock.js';
import { acquireOperationLock } from './writer.js';
import type { AgentAdapter } from './adapter.js';
import { assertMutationConfigReadable, fleetHomeDir } from './config.js';
import { pluginCoordinate } from './plugin-coordinate.js';
import { FleetOperationError } from './errors.js';
import { inspectAdapter, inspectionAllowsMutation, normalizeInventoryItems } from './inventory.js';
export { pluginCoordinate, SELECTOR_RE } from './plugin-coordinate.js';

/**
 * Delegated plugin install/remove: fleet never writes vendor plugin dirs — it
 * runs the vendor's own CLI (docs/design-plugins.md Part B, commands verified
 * 2026-07-03). spawn with an argv ARRAY (no shell → no injection surface),
 * selector validated at this trust boundary (AI/feed data can reach it).
 * HONEST LIMITS: no hash-guard/backup; undo = the vendor's uninstall command;
 * the confirm shows the exact command but no marketplace provenance/trust score
 * yet (plugins Part C).
 */

export type PluginOp = 'install' | 'remove';
export type DelegatedEffect = 'changed' | 'unchanged' | 'unverifiable';
type PluginState = 'present' | 'absent';

export interface DelegatedPlan {
  agent: string;
  op: PluginOp;
  selector: string;
  argv: string[];
  undoArgv?: string[];
  /** Inventory state proved while planning. Recovery guidance depends on this
   * proof, and execution re-checks it immediately before invoking the vendor. */
  preState?: PluginState;
  /** Runtime-only verifier. It is deliberately excluded from ledger records. */
  readPluginState?: () => Promise<PluginState>;
  /** Re-check detection and the full authoritative inventory under the shared
   * mutation lock immediately before a vendor process can start. */
  revalidateAgentState?: () => Promise<void>;
}

const VENDOR: Record<string, Record<PluginOp, string[]>> = {
  // ponytail: argv table beats an adapter interface for 2 agents; move into
  // adapters if BYO-agent plugins ever need this.
  'claude-code': { install: ['claude', 'plugin', 'install'], remove: ['claude', 'plugin', 'uninstall'] },
  codex: { install: ['codex', 'plugin', 'add'], remove: ['codex', 'plugin', 'remove'] },
};

/** Delegation is authority, not an inference from the MCP writer contract.
 * Keep this check beside the validated argv table so every face uses exactly
 * the same set of plugin-capable targets. */
export function supportsPluginDelegation(adapter: AgentAdapter): boolean {
  const support = adapter.capabilitySupport?.plugin;
  return (
    Object.hasOwn(VENDOR, adapter.id) &&
    support?.inventory === 'supported' &&
    support.management === 'delegated'
  );
}

function assertSafeSelector(selector: string): void {
  pluginCoordinate(selector);
}

export function planPluginAction(agent: string, op: PluginOp, selector: string): DelegatedPlan {
  assertSafeSelector(selector);
  const cmds = VENDOR[agent];
  if (!cmds) throw new Error(`agent '${agent}' has no plugin CLI support (built-ins: claude-code, codex)`);
  return {
    agent,
    op,
    selector,
    argv: [...cmds[op], selector],
    undoArgv: op === 'install' ? [...cmds.remove, selector] : undefined,
  };
}

/** Resolve and validate the complete delegated target set before any vendor
 * command can run. This prevents a late unsupported target from turning a
 * multi-agent request into a hidden partial apply. */
export async function planPluginActions(
  adapters: AgentAdapter[],
  target: string,
  op: PluginOp,
  selector: string,
): Promise<DelegatedPlan[]> {
  assertSafeSelector(selector);
  const capable = adapters.filter(supportsPluginDelegation);
  let ids: string[];
  if (target === 'all') {
    ids = [];
    for (const adapter of capable) {
      const { detected } = await inspectAdapter(adapter);
      const runtimeAvailable = detected.runtimeStatus === 'available';
      if (detected.present && inspectionAllowsMutation(detected) && runtimeAvailable) ids.push(adapter.id);
    }
  } else {
    ids = target
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    const known = new Set(capable.map((adapter) => adapter.id));
    for (const id of ids) {
      if (!known.has(id)) throw new Error(`unknown or plugin-unsupported agent: '${id}'`);
      const { detected } = await inspectAdapter(capable.find((adapter) => adapter.id === id)!);
      if (!inspectionAllowsMutation(detected)) {
        throw new FleetOperationError('TARGET_UNAVAILABLE', `agent state unavailable: '${id}'`);
      }
      if (detected.runtimeStatus !== undefined && detected.runtimeStatus !== 'available') {
        throw new FleetOperationError('TARGET_UNAVAILABLE', `agent runtime unavailable: '${id}'`);
      }
    }
  }
  const selected = [...new Set(ids)];
  const plans: DelegatedPlan[] = [];
  for (const agent of selected) {
    const adapter = capable.find((candidate) => candidate.id === agent)!;
    let coordinate = pluginCoordinate(selector);
    const readPlugins = async () => {
      const inventory = normalizeInventoryItems(
        adapter.id,
        adapter.readPluginInventory ? await adapter.readPluginInventory() : await adapter.readInventory(),
      );
      const plugins = inventory.filter((item) => item.kind === 'plugin');
      const sameCoordinate = plugins.filter(
        (item) =>
          item.name === coordinate.selector ||
          (item.name === coordinate.name &&
            (!coordinate.marketplace || item.marketplace === coordinate.marketplace)),
      );
      if (sameCoordinate.some((item) => item.scope !== 'user')) {
        throw new FleetOperationError(
          'UNSUPPORTED_OPERATION',
          `plugin '${coordinate.name}' is not in the supported user scope on '${agent}'`,
        );
      }
      return plugins;
    };
    let initialPlugins;
    try {
      initialPlugins = await readPlugins();
    } catch (error) {
      if (error instanceof FleetOperationError) throw error;
      throw new Error(`plugin inventory unavailable for '${agent}'; refusing delegated ${op}`);
    }
    if (op === 'remove' && !coordinate.marketplace) {
      const matches = initialPlugins.filter(
        (item) => item.name === coordinate.name || item.name === coordinate.selector,
      );
      const marketplaces = [...new Set(matches.map((item) => item.marketplace).filter(Boolean))];
      if (matches.length > 1 || marketplaces.length > 1) {
        throw new Error(
          `plugin '${coordinate.name}' exists in multiple marketplaces on '${agent}'; marketplace is required`,
        );
      }
      if (matches.length === 1 && matches[0]!.marketplace) {
        coordinate = pluginCoordinate(coordinate.name, matches[0]!.marketplace);
      }
    }
    const plan = planPluginAction(agent, op, coordinate.selector);
    const logicalName = coordinate.name;
    const readPluginState = async (): Promise<PluginState> => {
      const inventory = await readPlugins();
      return inventory.some(
        (item) =>
          item.name === coordinate.selector ||
          (item.name === logicalName &&
            (!coordinate.marketplace || item.marketplace === coordinate.marketplace)),
      )
        ? 'present'
        : 'absent';
    };
    const preState: PluginState = initialPlugins.some(
      (item) =>
        item.name === coordinate.selector ||
        (item.name === logicalName &&
          (!coordinate.marketplace || item.marketplace === coordinate.marketplace)),
    )
      ? 'present'
      : 'absent';
    if (op === 'install' && preState === 'present') {
      throw new Error(`plugin '${logicalName}' is already installed on '${agent}'`);
    }
    if (op === 'remove' && preState === 'absent') {
      throw new Error(`plugin '${logicalName}' is not installed on '${agent}'`);
    }
    plan.preState = preState;
    plan.readPluginState = readPluginState;
    plan.revalidateAgentState = async () => {
      const { detected } = await inspectAdapter(adapter);
      if (!inspectionAllowsMutation(detected)) {
        throw new FleetOperationError('TARGET_UNAVAILABLE', `agent state unavailable: '${agent}'`);
      }
      if (detected.runtimeStatus !== 'available') {
        throw new FleetOperationError('TARGET_UNAVAILABLE', `agent runtime unavailable: '${agent}'`);
      }
    };
    plans.push(plan);
  }
  return plans;
}

export interface DelegatedResult {
  lockWarning?: string;
  status: 'preview' | 'applied' | 'nothing-to-do' | 'failed' | 'outcome-unknown';
  effect?: DelegatedEffect;
  agent: string;
  command: string;
  undoCommand?: string;
  exitCode?: number;
  outputTail?: string;
  /** Opaque id of the durable delegated ledger row. */
  ledgerId?: string;
}

export type Runner = (argv: string[]) => Promise<{ exitCode: number; output: string }>;

/** The write-ahead marker exists and vendor execution may have started, so a
 * caller must inspect vendor state before retrying. Errors thrown before that
 * boundary are ordinary refused/failed operations, not unknown outcomes. */
export class DelegatedOutcomeUnknownError extends Error {
  override name = 'DelegatedOutcomeUnknownError';

  constructor(
    message: string,
    readonly ledgerId?: string,
  ) {
    super(message);
  }
}

export interface SafeDelegatedLedgerRecord {
  id: string;
  time: string;
  agent: string;
  op: PluginOp;
  selector: string;
  argv: string[];
  undoArgv?: string[];
  exitCode: number;
  preState?: PluginState;
  effect: DelegatedEffect;
  /** A durable write-ahead boundary whose vendor outcome was never finalized.
   * It is synthesized from delegated-pending/, never written as a completed
   * ledger row, and must always be treated as unverifiable. */
  pending?: true;
}

const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i;
const PENDING_DIR = 'delegated-pending';

async function fsyncDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch {
    // Some supported filesystems cannot fsync directories. The marker/file
    // itself is still fsynced; directory durability is best-effort there.
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function fsyncDirectoryDurable(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, 'r');
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const unsupported = code === 'EINVAL' || code === 'ENOTSUP' || code === 'EBADF';
    const windowsDirectoryOpen =
      process.platform === 'win32' && (code === 'EISDIR' || code === 'EPERM' || code === 'EACCES');
    if (!unsupported && !windowsDirectoryOpen) throw error;
  } finally {
    await handle?.close();
  }
}

async function fsyncDirectoryChainDurable(path: string): Promise<void> {
  let current = resolve(path);
  for (;;) {
    await fsyncDirectoryDurable(current);
    const parent = dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function durableAppend(path: string, line: string): Promise<void> {
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | (constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    if (!(await handle.stat()).isFile()) throw new Error('fleet: delegated history is not a regular file');
    await handle.chmod(0o600);
    await handle.writeFile(line, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readDelegatedFileNoFollow(
  path: string,
): Promise<{ text: string; mode: number; dev: number; ino: number }> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('fleet: delegated state is not a regular file');
    return {
      text: await handle.readFile('utf8'),
      mode: info.mode & 0o777,
      dev: info.dev,
      ino: info.ino,
    };
  } finally {
    await handle.close();
  }
}

async function ensureDelegatedLedger(home: string, create: boolean): Promise<string> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  const file = join(home, 'delegated.jsonl');
  const flags =
    constants.O_WRONLY |
    constants.O_APPEND |
    constants.O_CREAT |
    (create ? constants.O_EXCL : 0) |
    (constants.O_NOFOLLOW ?? 0);
  const handle = await open(file, flags, 0o600);
  try {
    if (!(await handle.stat()).isFile()) throw new Error('fleet: delegated history is not a regular file');
    await handle.chmod(0o600);
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (create) {
    await fsyncDirectoryChainDurable(home);
  }
  return file;
}

interface PendingDelegatedRecord {
  id: string;
  time: string;
  agent: string;
  op: PluginOp;
  selector: string;
  preState: PluginState;
}

function parsePendingRecord(value: unknown): SafeDelegatedLedgerRecord | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== 'string' ||
    !UUID.test(record.id) ||
    typeof record.time !== 'string' ||
    !Number.isFinite(Date.parse(record.time)) ||
    (record.agent !== 'claude-code' && record.agent !== 'codex') ||
    (record.op !== 'install' && record.op !== 'remove') ||
    typeof record.selector !== 'string' ||
    (record.preState !== 'present' && record.preState !== 'absent') ||
    (record.op === 'install' && record.preState !== 'absent') ||
    (record.op === 'remove' && record.preState !== 'present')
  ) {
    return null;
  }
  try {
    const plan = planPluginAction(record.agent, record.op, record.selector);
    return {
      id: record.id,
      time: new Date(Date.parse(record.time)).toISOString(),
      agent: plan.agent,
      op: plan.op,
      selector: plan.selector,
      argv: plan.argv,
      exitCode: 255,
      preState: record.preState,
      effect: 'unverifiable',
      pending: true,
    };
  } catch {
    return null;
  }
}

async function readPendingRecords(
  home: string,
  completedIds: ReadonlySet<string>,
  repair = false,
): Promise<{
  records: SafeDelegatedLedgerRecord[];
  status: 'available' | 'unavailable' | 'malformed';
}> {
  const dir = join(home, PENDING_DIR);
  try {
    const info = await lstat(dir);
    if (info.isSymbolicLink() || !info.isDirectory()) return { records: [], status: 'unavailable' };
    const entries = await readdir(dir, { withFileTypes: true });
    const records: SafeDelegatedLedgerRecord[] = [];
    let malformed = false;
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) {
        malformed = true;
        continue;
      }
      const marker = join(dir, entry.name);
      const { text } = await readDelegatedFileNoFollow(marker);
      if (text.length > 64 * 1024) {
        malformed = true;
        continue;
      }
      let parsed: SafeDelegatedLedgerRecord | null = null;
      try {
        parsed = parsePendingRecord(JSON.parse(text));
      } catch {
        // handled as malformed below
      }
      if (!parsed || entry.name !== `${parsed.id}.json`) {
        malformed = true;
        continue;
      }
      if (completedIds.has(parsed.id)) {
        // Completion was fsynced before marker removal. A crash between those
        // steps may leave a harmless stale marker; clean it during migration.
        if (repair) await rm(marker, { force: true });
        continue;
      }
      if (repair) await chmod(marker, 0o600);
      records.push(parsed);
    }
    if (repair) await chmod(dir, 0o700);
    return { records, status: malformed ? 'malformed' : 'available' };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { records: [], status: 'available' }
      : { records: [], status: 'unavailable' };
  }
}

async function writePendingRecord(home: string, record: PendingDelegatedRecord): Promise<string> {
  const dir = join(home, PENDING_DIR);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error('fleet: delegated pending history is unavailable');
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
  await fsyncDirectoryChainDurable(dir);
  return file;
}

/** Read and migrate the delegated ledger through a strict allowlist. Legacy
 * outputTail/unknown fields are removed and the file is rewritten 0600 on the
 * first read, so upgrades do not leave historical vendor output at rest. */
async function readDelegatedLedgerInternal(
  fleetHome?: string,
  repair = false,
): Promise<{
  records: SafeDelegatedLedgerRecord[];
  status: 'available' | 'not-present' | 'unavailable' | 'malformed';
}> {
  const home = fleetHomeDir(fleetHome);
  const file = join(home, 'delegated.jsonl');
  let text: string;
  let originalIdentity: { dev: number; ino: number };
  let mode: number;
  try {
    const snapshot = await readDelegatedFileNoFollow(file);
    text = snapshot.text;
    mode = snapshot.mode;
    originalIdentity = { dev: snapshot.dev, ino: snapshot.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const pending = await readPendingRecords(home, new Set(), repair);
      if (pending.status !== 'available') return pending;
      // The write-ahead protocol creates and fsyncs delegated.jsonl before any
      // pending marker. A marker without that ledger means history was removed
      // or partially lost; retain the boundary and fail closed.
      return pending.records.length > 0
        ? { records: pending.records, status: 'malformed' }
        : { records: [], status: 'not-present' };
    }
    return { records: [], status: 'unavailable' };
  }
  const records: SafeDelegatedLedgerRecord[] = [];
  let malformed = false;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      if (
        typeof value.id !== 'string' ||
        !UUID.test(value.id) ||
        typeof value.time !== 'string' ||
        !Number.isFinite(Date.parse(value.time)) ||
        (value.agent !== 'claude-code' && value.agent !== 'codex') ||
        (value.op !== 'install' && value.op !== 'remove') ||
        typeof value.selector !== 'string' ||
        !Number.isSafeInteger(value.exitCode) ||
        (value.exitCode as number) < 0 ||
        (value.exitCode as number) > 255
      ) {
        malformed = true;
        continue;
      }
      const plan = planPluginAction(value.agent, value.op, value.selector);
      const preState =
        value.preState === 'present' || value.preState === 'absent' ? value.preState : undefined;
      const claimedEffect =
        value.effect === 'changed' || value.effect === 'unchanged' || value.effect === 'unverifiable'
          ? value.effect
          : 'unverifiable';
      const hasVerifiedPreState =
        (plan.op === 'install' && preState === 'absent') || (plan.op === 'remove' && preState === 'present');
      // Changed/no-op claims are usable only with the exact pre-state and a
      // successful vendor exit. Legacy, hand-edited, and inconsistent rows
      // fail closed rather than masking an older rollback boundary.
      const effect =
        claimedEffect !== 'unverifiable' && (!hasVerifiedPreState || (value.exitCode as number) !== 0)
          ? 'unverifiable'
          : claimedEffect;
      records.push({
        id: value.id,
        time: new Date(Date.parse(value.time)).toISOString(),
        agent: plan.agent,
        op: plan.op,
        selector: plan.selector,
        argv: plan.argv,
        ...(effect === 'changed' && plan.undoArgv ? { undoArgv: plan.undoArgv } : {}),
        exitCode: value.exitCode as number,
        ...(preState ? { preState } : {}),
        effect,
      });
    } catch {
      malformed = true;
    }
  }
  const canonicalRecords = records.map((record) => JSON.stringify(record)).join('\n');
  const canonical =
    canonicalRecords +
    (canonicalRecords ? '\n' : '') +
    (malformed ? `${JSON.stringify({ malformed: true })}\n` : '');
  if (repair && (canonical !== text || mode !== 0o600)) {
    const tmp = `${file}.tmp-${process.pid}-${randomUUID()}`;
    try {
      const handle = await open(tmp, 'wx', 0o600);
      try {
        await handle.chmod(0o600);
        await handle.writeFile(canonical, 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      // Do not overwrite a ledger changed or replaced after the snapshot that
      // was canonicalized. This is the closest pathname CAS available in the
      // portable Node filesystem API; the Fleet mutation lock serializes all
      // cooperating writers around it.
      const current = await readDelegatedFileNoFollow(file);
      if (
        current.text !== text ||
        current.dev !== originalIdentity.dev ||
        current.ino !== originalIdentity.ino
      ) {
        throw new Error('fleet: delegated history changed during canonical repair');
      }
      await rename(tmp, file);
      await fsyncDirectoryChainDurable(home);
    } catch {
      await rm(tmp, { force: true }).catch(() => {});
      return { records, status: 'unavailable' };
    }
  }
  const pending = await readPendingRecords(home, new Set(records.map((record) => record.id)), repair);
  const all = [...records, ...pending.records.sort((a, b) => Date.parse(a.time) - Date.parse(b.time))];
  const status =
    pending.status === 'unavailable'
      ? 'unavailable'
      : malformed || pending.status === 'malformed'
        ? 'malformed'
        : 'available';
  return { records: all, status };
}

/** Public/read-face ledger access is deliberately side-effect free. Repairing
 * legacy rows is a separate operation so a dashboard read cannot race an append. */
export async function readDelegatedLedger(fleetHome?: string): Promise<{
  records: SafeDelegatedLedgerRecord[];
  status: 'available' | 'not-present' | 'unavailable' | 'malformed';
}> {
  return readDelegatedLedgerInternal(fleetHome, false);
}

export async function repairDelegatedLedger(fleetHome?: string): Promise<void> {
  const home = fleetHomeDir(fleetHome);
  const release = await acquireOperationLock(home);
  try {
    await readDelegatedLedgerInternal(home, true);
  } finally {
    await release();
  }
}

class VendorProcessNotStartedError extends Error {
  override name = 'VendorProcessNotStartedError';
}

const defaultRunner: Runner = (argv) =>
  new Promise((resolve, reject) => {
    // cwd-neutral: vendor scope defaults must not depend on where fleet was launched
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(argv[0]!, argv.slice(1), {
        stdio: ['ignore', 'pipe', 'pipe'],
        cwd: homedir(),
      });
    } catch (error) {
      reject(new VendorProcessNotStartedError(error instanceof Error ? error.message : String(error)));
      return;
    }
    let started = false;
    let out = '';
    const grab = (c: Buffer) => {
      out = (out + c.toString()).slice(-8192); // rolling tail — the error is at the END
    };
    child.stdout!.on('data', grab);
    child.stderr!.on('data', grab);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      // grandchildren can hold the pipes open past the kill — don't wait on them
      child.stdout!.destroy();
      child.stderr!.destroy();
    }, 120_000);
    child.once('spawn', () => {
      started = true;
    });
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(started ? e : new VendorProcessNotStartedError(e.message));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, output: out });
    });
  });

/** Newest delegated-ledger entry, or null (for `fleet rollback`'s "that was a
 * plugin action" hint — file-rollback cannot undo vendor state). */
export async function lastDelegated(fleetHome?: string): Promise<SafeDelegatedLedgerRecord | null> {
  const { records } = await readDelegatedLedger(fleetHome);
  return records.at(-1) ?? null;
}

/** Newest delegated record that can affect rollback safety. A verified no-op
 * must not mask an earlier real or unverifiable vendor action. */
export function latestDelegatedRollbackBoundary(
  records: SafeDelegatedLedgerRecord[],
): SafeDelegatedLedgerRecord | undefined {
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i]!.effect !== 'unchanged') return records[i];
  }
  return undefined;
}

/** Execute (or preview) a delegated plan; applied/failed runs are appended to
 * ~/.fleet/delegated.jsonl (separate ledger — file-rollback machinery can't undo these). */
export async function runDelegated(
  plan: DelegatedPlan,
  opts: { commit: boolean; fleetHome?: string; runner?: Runner } = { commit: false },
): Promise<DelegatedResult> {
  const command = plan.argv.join(' ');
  const undoCommand = plan.preState === 'absent' ? plan.undoArgv?.join(' ') : undefined;
  if (!opts.commit) return { status: 'preview', agent: plan.agent, command, undoCommand };

  const home = fleetHomeDir(opts.fleetHome);
  assertMutationConfigReadable(home);
  const release = await acquireOperationLock(home);
  try {
    assertMutationConfigReadable(home);
    if (plan.revalidateAgentState) await plan.revalidateAgentState();
    // A Web preview can sit for minutes, and even CLI/MCP callers can race an
    // external vendor process. Revalidate under the shared mutation lock so a
    // stale or duplicate action cannot reach the vendor.
    if (plan.preState && plan.readPluginState) {
      let current: PluginState;
      try {
        current = await plan.readPluginState();
      } catch (error) {
        throw new Error(
          `fleet: plugin state could not be revalidated before vendor execution: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
      if (current !== plan.preState) {
        return { status: 'nothing-to-do', effect: 'unchanged', agent: plan.agent, command };
      }
    }

    const ledger = await readDelegatedLedgerInternal(home, true);
    if (ledger.status === 'malformed' || ledger.status === 'unavailable') {
      throw new Error('fleet: delegated history is unavailable or malformed; refusing vendor action');
    }
    if (ledger.records.some((record) => record.pending)) {
      throw new Error('fleet: a delegated vendor outcome is pending verification; refusing vendor action');
    }
    const lock = await readLockState(home);
    if (lock.status !== 'available' && lock.status !== 'not-present') {
      throw new Error('fleet: fleet.lock provenance is unavailable or malformed; refusing vendor action');
    }
    const ledgerFile = await ensureDelegatedLedger(home, ledger.status === 'not-present');
    const id = randomUUID();
    const time = new Date().toISOString();
    if (!plan.preState) {
      throw new Error('fleet: delegated action lacks verified pre-state; refusing vendor action');
    }
    // Write-ahead boundary: it is fsynced before the vendor process starts and
    // remains if spawn, verification, or final ledger append fails. Implicit
    // core rollback therefore cannot cross an outcome-unknown plugin action.
    const pendingFile = await writePendingRecord(home, {
      id,
      time,
      agent: plan.agent,
      op: plan.op,
      selector: plan.selector,
      preState: plan.preState,
    });

    let vendorResult: { exitCode: number; output: string };
    try {
      vendorResult = await (opts.runner ?? defaultRunner)(plan.argv);
    } catch (error) {
      if (
        error instanceof VendorProcessNotStartedError ||
        (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      ) {
        try {
          await rm(pendingFile, { force: true });
          await fsyncDirectoryDurable(join(home, PENDING_DIR));
        } catch (cleanupError) {
          throw new DelegatedOutcomeUnknownError(
            `fleet: vendor did not start, but its pending marker could not be cleared: ${
              cleanupError instanceof Error ? cleanupError.message : String(cleanupError)
            }`,
            id,
          );
        }
        throw new Error('fleet: vendor executable could not be started');
      }
      throw new DelegatedOutcomeUnknownError(
        `fleet: vendor execution outcome is unknown: ${error instanceof Error ? error.message : String(error)}`,
        id,
      );
    }
    const { exitCode, output } = vendorResult;
    // structured secret scrub (URL userinfo, key=value, JWT/vendor token shapes)
    // before the tail reaches the ledger / an AI face
    // scrub the WHOLE output first — slicing first could cut a token's prefix
    // and leave an unrecognizable (unredactable) suffix in the tail
    const outputTail = scrubSecrets(output).slice(-2000);
    let effect: DelegatedEffect = 'unverifiable';
    if (exitCode === 0 && plan.preState && plan.readPluginState) {
      try {
        const after = await plan.readPluginState();
        effect = after === plan.preState ? 'unchanged' : 'changed';
      } catch {
        effect = 'unverifiable';
      }
    }
    const status: DelegatedResult['status'] =
      exitCode !== 0
        ? 'failed'
        : effect === 'changed'
          ? 'applied'
          : effect === 'unchanged'
            ? 'nothing-to-do'
            : 'outcome-unknown';
    try {
      await durableAppend(
        ledgerFile,
        JSON.stringify({
          id,
          time: new Date().toISOString(),
          agent: plan.agent,
          op: plan.op,
          selector: plan.selector,
          argv: plan.argv,
          ...(effect === 'changed' && plan.undoArgv ? { undoArgv: plan.undoArgv } : {}),
          exitCode,
          ...(plan.preState ? { preState: plan.preState } : {}),
          effect,
        }) + '\n',
      );
    } catch (error) {
      throw new DelegatedOutcomeUnknownError(
        `fleet: vendor ran but delegated history could not be recorded: ${
          error instanceof Error ? error.message : String(error)
        }`,
        id,
      );
    }
    // Completion is durable first. Marker cleanup can safely be retried by the
    // reader after a crash because records with the same id dominate markers.
    try {
      await rm(pendingFile, { force: true });
      await fsyncDirectory(join(home, PENDING_DIR));
    } catch {
      // The completed ledger row is authoritative; readDelegatedLedger removes
      // this stale marker without exposing a duplicate Activity entry.
    }
    let lockWarning: string | undefined;
    if (status === 'applied') {
      try {
        await updateLockForPlugin(plan.op, plan.agent, plan.selector, opts.fleetHome);
      } catch (e) {
        // lock is metadata — the vendor CLI already succeeded; still SAY so
        lockWarning = `applied, but fleet.lock update failed: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    return {
      status,
      effect,
      agent: plan.agent,
      command,
      ...(status === 'applied' && undoCommand ? { undoCommand } : {}),
      exitCode,
      outputTail,
      ...(lockWarning ? { lockWarning } : {}),
      ledgerId: id,
    };
  } finally {
    await release();
  }
}
