import { FLEET_ADAPTER_CONTRACT_VERSION, type AgentAdapter } from './adapter.js';
import type { PrimitiveKind } from './types.js';

/**
 * "Bring your own agent": load third-party AgentAdapters listed in config
 * (`adapterModules`) without forking. Each module is dynamically imported; its
 * default export must be an AgentAdapter, or a (possibly async) factory that
 * returns one. Loading is best-effort — a bad module is skipped with a warning,
 * never crashes fleet. Note: a plugin runs IN-PROCESS (arbitrary code from the
 * user's own config), same trust level as anything else the user installs.
 */
export type Importer = (spec: string) => Promise<unknown>;
export const DEFAULT_ADAPTER_LOAD_DEADLINE_MS = 10_000;
export interface AdapterLoadDiagnostic {
  index: number;
  reason:
    | 'invalid-export'
    | 'unsupported-contract'
    | 'invalid-contract'
    | 'load-failed'
    | 'shadowed'
    | 'duplicate-id';
}

const CAPABILITY_KINDS = new Set<PrimitiveKind>([
  'mcp-server',
  'skill',
  'rule',
  'permission',
  'plugin',
  'command',
  'hook',
  'subagent',
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isAdapterShape(x: unknown): x is AgentAdapter {
  const a = x as Partial<AgentAdapter> | null;
  return (
    !!a &&
    typeof a.id === 'string' &&
    /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(a.id) &&
    typeof a.displayName === 'string' &&
    a.displayName.length > 0 &&
    a.displayName.length <= 128 &&
    a.displayName.trim() === a.displayName &&
    !/[\u0000-\u001f\u007f]/.test(a.displayName) &&
    typeof a.detect === 'function' &&
    typeof a.readInventory === 'function'
  );
}

function hasMethod(adapter: AgentAdapter, name: string): boolean {
  return typeof (adapter as unknown as Record<string, unknown>)[name] === 'function';
}

function validContract(adapter: AgentAdapter): boolean {
  if (adapter.supportsWrite !== undefined && typeof adapter.supportsWrite !== 'boolean') return false;
  if (!isPlainRecord(adapter.capabilitySupport)) return false;
  for (const [rawKind, rawSurface] of Object.entries(adapter.capabilitySupport)) {
    if (!CAPABILITY_KINDS.has(rawKind as PrimitiveKind) || !isPlainRecord(rawSurface)) return false;
    if (Object.keys(rawSurface).some((key) => key !== 'inventory' && key !== 'management')) return false;
    const inventory = rawSurface.inventory;
    const management = rawSurface.management;
    if (typeof inventory !== 'string' || !['supported', 'unsupported', 'unverifiable'].includes(inventory)) {
      return false;
    }
    if (
      typeof management !== 'string' ||
      !['writable', 'read-only', 'delegated', 'none'].includes(management)
    ) {
      return false;
    }
    if (inventory === 'supported' && (rawKind === 'command' || rawKind === 'hook')) return false;
    if (inventory === 'unsupported' && management !== 'none') return false;
    if (management === 'writable') {
      if (inventory !== 'supported' || adapter.supportsWrite !== true) return false;
      const methods =
        rawKind === 'mcp-server'
          ? ['renderInstall', 'renderRemove', 'validate']
          : rawKind === 'skill'
            ? ['renderInstallSkill', 'renderRemoveSkill']
            : rawKind === 'rule'
              ? ['renderInstallRule', 'renderRemoveRule']
              : [];
      if (methods.length === 0 || !methods.every((name) => hasMethod(adapter, name))) return false;
    }
    if (management === 'delegated' && rawKind !== 'plugin') return false;
  }
  return adapter.readPluginInventory === undefined || typeof adapter.readPluginInventory === 'function';
}

type AdapterResolution =
  { adapter: AgentAdapter } | { reason: 'invalid-export' | 'unsupported-contract' | 'invalid-contract' };

function classifyAdapter(candidate: unknown): AdapterResolution {
  const declaredVersion =
    candidate !== null && (typeof candidate === 'object' || typeof candidate === 'function')
      ? (candidate as { contractVersion?: unknown }).contractVersion
      : undefined;
  if (declaredVersion === FLEET_ADAPTER_CONTRACT_VERSION) {
    if (!isAdapterShape(candidate)) return { reason: 'invalid-contract' };
    return validContract(candidate) ? { adapter: candidate } : { reason: 'invalid-contract' };
  }
  if (isAdapterShape(candidate) || declaredVersion !== undefined) {
    return { reason: 'unsupported-contract' };
  }
  return { reason: 'invalid-export' };
}

async function resolveAdapter(mod: unknown): Promise<AdapterResolution> {
  const candidate = (mod as { default?: unknown })?.default ?? mod;
  if (typeof candidate !== 'function') return classifyAdapter(candidate);
  const inst = await (candidate as () => unknown)();
  return classifyAdapter(inst);
}

function withDeadline<T>(promise: Promise<T>, deadlineMs: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('adapter load timed out')), deadlineMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

export async function loadPluginAdapters(
  modules: string[],
  importer: Importer = (s) => import(s),
  onDiagnostic?: (diagnostic: AdapterLoadDiagnostic) => void,
  onLoaded?: (adapter: AgentAdapter, index: number) => void,
  deadlineMs: number = DEFAULT_ADAPTER_LOAD_DEADLINE_MS,
): Promise<AgentAdapter[]> {
  if (!modules.length) return [];
  const out: AgentAdapter[] = [];
  for (const [index, spec] of modules.entries()) {
    try {
      // A BYO module or async factory is trusted local code, but it must not be
      // able to leave Fleet startup/Doctor pending forever.
      // Keep import and factory deadlines separate: attaching resolveAdapter
      // directly to a timed-out import would invoke its factory later, after
      // Fleet had already diagnosed and skipped that slot.
      const loaded = await withDeadline(importer(spec), deadlineMs);
      const resolved = await withDeadline(resolveAdapter(loaded), deadlineMs);
      if ('adapter' in resolved) {
        out.push(resolved.adapter);
        onLoaded?.(resolved.adapter, index);
      } else {
        onDiagnostic?.({ index, reason: resolved.reason });
        process.stderr.write(`fleet: adapter plugin[${index}] is incompatible; skipping\n`);
      }
    } catch {
      onDiagnostic?.({ index, reason: 'load-failed' });
      // stderr can be captured by an MCP client. Do not emit a module path or
      // arbitrary loader/factory exception here; local `fleet doctor` reports
      // the configured slot separately.
      process.stderr.write(`fleet: adapter plugin[${index}] failed to load; skipping\n`);
    }
  }
  return out;
}
