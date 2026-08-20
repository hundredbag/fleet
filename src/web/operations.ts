import type { AgentAdapter } from '../core/adapter.js';
import { supportsPluginDelegation } from '../core/delegate.js';
import type { InventoryAgent, PrimitiveKind, Scope } from '../core/types.js';
import type { Availability, Management, Operation } from './types.js';

export interface CapabilityCellInput {
  adapter: AgentAdapter;
  agent: InventoryAgent;
  kind: PrimitiveKind;
  hasInstance: boolean;
  scope?: Scope;
  hasSourceInstance: boolean;
  delegatedSupported?: boolean;
}

const CORE_WRITABLE_KINDS = new Set<PrimitiveKind>(['mcp-server', 'skill', 'rule']);

function hasFunction(adapter: AgentAdapter, name: string): boolean {
  return typeof (adapter as unknown as Record<string, unknown>)[name] === 'function';
}

/** Metadata is descriptive, never authority: the concrete write contract must exist. */
function hasWriter(adapter: AgentAdapter, kind: PrimitiveKind): boolean {
  if (adapter.supportsWrite !== true || !CORE_WRITABLE_KINDS.has(kind)) return false;
  if (kind === 'mcp-server') {
    return ['renderInstall', 'renderRemove', 'validate'].every((name) => hasFunction(adapter, name));
  }
  if (kind === 'skill') {
    return ['renderInstallSkill', 'renderRemoveSkill'].every((name) => hasFunction(adapter, name));
  }
  return ['renderInstallRule', 'renderRemoveRule'].every((name) => hasFunction(adapter, name));
}

/** Delegation is limited to vendor CLIs for which fleet has a validated argv implementation. */
export function supportsDelegatedPlugin(adapter: AgentAdapter): boolean {
  return supportsPluginDelegation(adapter);
}

export function capabilityCell(input: CapabilityCellInput): {
  availability: Availability;
  management: Management;
  operations: Operation[];
} {
  const { adapter, agent, kind, hasInstance, hasSourceInstance } = input;
  if (agent.inventoryStatus === 'detect-failed' || agent.inventoryStatus === 'read-failed') {
    return { availability: 'unavailable', management: 'none', operations: [] };
  }
  const support = adapter.capabilitySupport?.[kind];
  if (!support) return { availability: 'unverifiable', management: 'none', operations: [] };
  const inventory =
    support.inventory === 'supported' ||
    support.inventory === 'unsupported' ||
    support.inventory === 'unverifiable'
      ? support.inventory
      : 'unverifiable';
  const management: Management = ['writable', 'read-only', 'delegated', 'none'].includes(support.management)
    ? support.management
    : 'none';
  if (inventory === 'unverifiable') {
    return { availability: 'unverifiable', management, operations: [] };
  }
  if (inventory === 'unsupported') {
    return { availability: 'unsupported', management: 'none', operations: [] };
  }
  const canInitialize =
    !agent.present &&
    agent.configurationStatus === 'not-configured' &&
    agent.runtimeStatus === 'available' &&
    ((management === 'writable' && hasWriter(adapter, kind)) ||
      (management === 'delegated' && input.delegatedSupported === true));
  if (!agent.present && !canInitialize) {
    return { availability: 'unavailable', management, operations: [] };
  }
  if (management === 'read-only') {
    return { availability: hasInstance ? 'installed' : 'missing', management: 'read-only', operations: [] };
  }
  // Fleet's delegated vendor argv has no project/local selector. A plugin
  // reported in either scope is inventory-only; treating it as the default
  // vendor scope could remove or replace a different installation.
  if (kind === 'plugin' && hasInstance && input.scope !== 'user') {
    return { availability: 'installed', management: 'read-only', operations: [] };
  }
  if (management === 'delegated') {
    const operations: Operation[] = input.delegatedSupported ? (hasInstance ? ['remove'] : ['install']) : [];
    return { availability: hasInstance ? 'installed' : 'missing', management: 'delegated', operations };
  }
  if (management !== 'writable' || !hasWriter(adapter, kind)) {
    return { availability: hasInstance ? 'installed' : 'missing', management: 'none', operations: [] };
  }
  // Current MCP writers render only the user-level config. Project/local
  // entries are inventory-only: treating the adapter's global writable bit as
  // authority for those scopes would create a different user entry instead of
  // updating/removing the selected capability.
  if (CORE_WRITABLE_KINDS.has(kind) && hasInstance && input.scope && input.scope !== 'user') {
    return { availability: 'installed', management: 'read-only', operations: [] };
  }
  let operations: Operation[] = [];
  if (kind === 'mcp-server') {
    operations = hasInstance
      ? ['remove', ...(hasSourceInstance ? (['sync'] as const) : [])]
      : hasSourceInstance
        ? ['sync']
        : [];
  } else if (kind === 'skill' || kind === 'rule') {
    operations = hasInstance
      ? ['remove', ...(hasSourceInstance ? (['sync'] as const) : [])]
      : hasSourceInstance
        ? ['sync']
        : [];
  }
  return {
    availability: hasInstance ? 'installed' : 'missing',
    management: 'writable',
    operations,
  };
}

/** The shared policy boundary for both advertised and accepted operations. */
export function operationAllowed(input: CapabilityCellInput, operation: Operation): boolean {
  const cell = capabilityCell(input);
  if (
    cell.availability === 'unavailable' ||
    cell.availability === 'unsupported' ||
    cell.availability === 'unverifiable'
  ) {
    return false;
  }
  if (input.kind === 'plugin') {
    if (cell.management !== 'delegated' || !input.delegatedSupported) return false;
    return operation === 'install' ? !input.hasInstance : operation === 'remove' && input.hasInstance;
  }
  if (cell.management !== 'writable' || !hasWriter(input.adapter, input.kind)) return false;
  if (operation === 'install') return input.kind === 'mcp-server' && !input.hasInstance;
  if (operation === 'update') return input.kind === 'mcp-server' && input.hasInstance;
  if (operation === 'remove') return input.hasInstance;
  return operation === 'sync' && input.hasSourceInstance;
}
