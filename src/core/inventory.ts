import type { AgentAdapter } from './adapter.js';
import type { AgentSetupStatus, Inventory, InventoryAgent, InstalledCapability } from './types.js';
import { detectionAllowsMutation } from './detection.js';

export interface InventoryBuildOptions {
  deadlineMs?: number;
}

function withDeadline<T>(promise: Promise<T>, deadlineMs: number | undefined, label: string): Promise<T> {
  if (deadlineMs === undefined) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out`)), deadlineMs);
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

function setupStatus(agent: InventoryAgent): AgentSetupStatus {
  if (agent.inventoryStatus === 'detect-failed') return 'detection-unavailable';
  if (agent.configurationStatus === 'unavailable') return 'configuration-unavailable';
  if (agent.inventoryStatus === 'read-failed') return 'inventory-unavailable';
  if (agent.present) {
    if (agent.runtimeStatus === 'not-found') return 'configured-runtime-missing';
    if (agent.runtimeStatus === 'unverifiable') return 'configured-runtime-unverifiable';
    return 'ready';
  }
  return agent.runtimeStatus === 'available' ? 'installed-unconfigured' : 'not-detected';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isStringRecord(value: unknown): boolean {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function validTokens(value: unknown): boolean {
  return value === undefined || (typeof value === 'number' && Number.isFinite(value) && value >= 0);
}

function assertCapability(value: unknown): asserts value is InstalledCapability {
  if (!isRecord(value)) throw new Error('inventory item is not an object');
  if (typeof value.name !== 'string' || value.name.length === 0) {
    throw new Error('inventory item name is invalid');
  }
  if (!['user', 'project', 'local'].includes(String(value.scope))) {
    throw new Error('inventory item scope is invalid');
  }
  if (typeof value.enabled !== 'boolean') throw new Error('inventory item enabled state is invalid');
  if (
    !isRecord(value.source) ||
    typeof value.source.file !== 'string' ||
    value.source.file.length === 0 ||
    (value.source.pointer !== undefined && typeof value.source.pointer !== 'string')
  ) {
    throw new Error('inventory item source is invalid');
  }
  switch (value.kind) {
    case 'mcp-server': {
      if (!isRecord(value.spec)) throw new Error('MCP inventory spec is invalid');
      if (value.spec.transport === 'stdio') {
        if (typeof value.spec.command !== 'string' || value.spec.command.length === 0) {
          throw new Error('MCP inventory command is invalid');
        }
        if (
          value.spec.args !== undefined &&
          (!Array.isArray(value.spec.args) || !value.spec.args.every((entry) => typeof entry === 'string'))
        ) {
          throw new Error('MCP inventory args are invalid');
        }
        if (value.spec.env !== undefined && !isStringRecord(value.spec.env)) {
          throw new Error('MCP inventory environment is invalid');
        }
        if (
          value.spec.url !== undefined ||
          value.spec.headers !== undefined ||
          value.spec.bearerTokenEnvVar !== undefined
        ) {
          throw new Error('stdio MCP inventory contains remote transport fields');
        }
      } else if (['http', 'sse', 'ws'].includes(String(value.spec.transport))) {
        if (typeof value.spec.url !== 'string' || value.spec.url.length === 0) {
          throw new Error('MCP inventory URL is invalid');
        }
        if (value.spec.headers !== undefined && !isStringRecord(value.spec.headers)) {
          throw new Error('MCP inventory headers are invalid');
        }
        if (
          value.spec.bearerTokenEnvVar !== undefined &&
          (typeof value.spec.bearerTokenEnvVar !== 'string' || value.spec.bearerTokenEnvVar.length === 0)
        ) {
          throw new Error('MCP inventory bearer environment is invalid');
        }
        if (
          value.spec.command !== undefined ||
          value.spec.args !== undefined ||
          value.spec.env !== undefined
        ) {
          throw new Error('remote MCP inventory contains stdio transport fields');
        }
      } else {
        throw new Error('MCP inventory transport is invalid');
      }
      return;
    }
    case 'skill':
      if (typeof value.path !== 'string' || value.path.length === 0 || !validTokens(value.tokensEst)) {
        throw new Error('skill inventory item is invalid');
      }
      if (
        value.meta !== undefined &&
        (!isRecord(value.meta) ||
          (value.meta.description !== undefined && typeof value.meta.description !== 'string') ||
          (value.meta.version !== undefined && typeof value.meta.version !== 'string'))
      ) {
        throw new Error('skill inventory metadata is invalid');
      }
      return;
    case 'rule':
      if (typeof value.body !== 'string' || !validTokens(value.tokensEst)) {
        throw new Error('rule inventory item is invalid');
      }
      return;
    case 'permission':
      if (typeof value.effect !== 'string' || value.effect.length === 0) {
        throw new Error('permission inventory item is invalid');
      }
      return;
    case 'plugin':
      if (
        (value.marketplace !== undefined && typeof value.marketplace !== 'string') ||
        (value.description !== undefined && typeof value.description !== 'string')
      ) {
        throw new Error('plugin inventory item is invalid');
      }
      return;
    case 'subagent':
      if (
        typeof value.path !== 'string' ||
        value.path.length === 0 ||
        (value.description !== undefined && typeof value.description !== 'string') ||
        (value.tools !== undefined &&
          (!Array.isArray(value.tools) || !value.tools.every((entry) => typeof entry === 'string'))) ||
        (value.model !== undefined && typeof value.model !== 'string') ||
        !validTokens(value.tokensEst)
      ) {
        throw new Error('subagent inventory item is invalid');
      }
      return;
    default:
      throw new Error('inventory item kind is invalid');
  }
}

export function normalizeInventoryItems(agent: string, value: unknown): InstalledCapability[] {
  if (!Array.isArray(value)) throw new Error('adapter inventory is not an array');
  return value.map((item) => {
    assertCapability(item);
    return { ...item, agent };
  });
}

export async function inspectAdapter(
  adapter: AgentAdapter,
  options: InventoryBuildOptions = {},
): Promise<{ detected: InventoryAgent; items: InstalledCapability[] }> {
  let detected: InventoryAgent;
  try {
    const result = await withDeadline(adapter.detect(), options.deadlineMs, `${adapter.id} detect()`);
    const runtimeStatusIsValid =
      result.runtimeStatus === 'available' ||
      result.runtimeStatus === 'not-found' ||
      result.runtimeStatus === 'unverifiable';
    const present = result.present === true;
    const runtimeStatus = runtimeStatusIsValid ? result.runtimeStatus! : 'unverifiable';
    const declaredConfigurationStatus =
      result.configurationStatus === 'configured' ||
      result.configurationStatus === 'not-configured' ||
      result.configurationStatus === 'unavailable'
        ? result.configurationStatus
        : result.configurationStatus === undefined
          ? present
            ? 'configured'
            : 'not-configured'
          : 'unavailable';
    const contradictoryConfigurationStatus =
      (present && declaredConfigurationStatus === 'not-configured') ||
      (!present && declaredConfigurationStatus === 'configured');
    const configurationStatus = contradictoryConfigurationStatus
      ? 'unavailable'
      : declaredConfigurationStatus;
    detected = {
      ...result,
      id: adapter.id,
      displayName: adapter.displayName,
      present,
      configPaths:
        Array.isArray(result.configPaths) && result.configPaths.every((path) => typeof path === 'string')
          ? result.configPaths
          : [],
      runtimeStatus,
      configurationStatus,
      setupStatus: 'not-detected',
      note:
        typeof result.note === 'string'
          ? result.note
          : configurationStatus === 'unavailable'
            ? contradictoryConfigurationStatus
              ? 'adapter returned contradictory presence and configuration status'
              : 'adapter returned an invalid configuration status'
            : undefined,
      inventoryStatus: present ? 'ok' : 'not-present',
    };
  } catch (err) {
    detected = {
      id: adapter.id,
      displayName: adapter.displayName,
      present: false,
      configPaths: [],
      runtimeStatus: 'unverifiable',
      configurationStatus: 'unavailable',
      setupStatus: 'detection-unavailable',
      note: `detect error: ${err instanceof Error ? err.message : String(err)}`,
      inventoryStatus: 'detect-failed',
    };
    return { detected, items: [] };
  }

  if (detected.configurationStatus === 'unavailable') {
    detected.inventoryStatus = 'read-failed';
    detected.setupStatus = setupStatus(detected);
    return { detected, items: [] };
  }
  if (!detected.present) {
    detected.setupStatus = setupStatus(detected);
    return { detected, items: [] };
  }
  try {
    const items = normalizeInventoryItems(
      adapter.id,
      await withDeadline(adapter.readInventory(), options.deadlineMs, `${adapter.id} inventory read`),
    );
    detected.setupStatus = setupStatus(detected);
    return { detected, items };
  } catch (err) {
    detected.note = `read error: ${err instanceof Error ? err.message : String(err)}`;
    detected.inventoryStatus = 'read-failed';
    detected.setupStatus = setupStatus(detected);
    return { detected, items: [] };
  }
}

/** Mutation may initialize a genuinely absent configuration, but it must not
 * touch a present adapter whose authoritative inventory could not be read. */
export function inspectionAllowsMutation(agent: InventoryAgent): boolean {
  return (
    detectionAllowsMutation(agent) &&
    (agent.inventoryStatus === 'ok' ||
      (!agent.present &&
        agent.inventoryStatus === 'not-present' &&
        agent.configurationStatus === 'not-configured' &&
        agent.runtimeStatus === 'available'))
  );
}

/**
 * Build the unified cross-agent inventory by asking every adapter to detect
 * itself and (if present) read its installed capabilities. A failing adapter
 * degrades to a note instead of breaking the whole snapshot.
 */
export async function buildInventory(
  adapters: AgentAdapter[],
  options: InventoryBuildOptions = {},
): Promise<Inventory> {
  // adapters are independent — read them in PARALLEL, and isolate detect()
  // failures too (a throwing detect used to abort the whole snapshot)
  const per = await Promise.all(adapters.map((adapter) => inspectAdapter(adapter, options)));
  return { agents: per.map((p) => p.detected), items: per.flatMap((p) => p.items) };
}
