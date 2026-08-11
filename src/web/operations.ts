import type { AgentAdapter } from '../core/adapter.js';
import type { InventoryAgent, PrimitiveKind } from '../core/types.js';
import type { Availability, Management, Operation } from './types.js';

export interface CapabilityCellInput {
  adapter: AgentAdapter;
  agent: InventoryAgent;
  kind: PrimitiveKind;
  hasInstance: boolean;
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
  const support = adapter.capabilitySupport?.plugin;
  return (
    (adapter.id === 'claude-code' || adapter.id === 'codex') &&
    support?.inventory === 'supported' &&
    support.management === 'delegated'
  );
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
  if (support.inventory === 'unsupported') {
    return { availability: 'unsupported', management: 'none', operations: [] };
  }
  if (!agent.present) return { availability: 'unavailable', management: support.management, operations: [] };
  if (support.management === 'read-only') {
    return { availability: hasInstance ? 'installed' : 'missing', management: 'read-only', operations: [] };
  }
  if (support.management === 'delegated') {
    const operations: Operation[] = input.delegatedSupported ? (hasInstance ? ['remove'] : ['install']) : [];
    return { availability: hasInstance ? 'installed' : 'missing', management: 'delegated', operations };
  }
  if (support.management !== 'writable' || !hasWriter(adapter, kind)) {
    return { availability: hasInstance ? 'installed' : 'missing', management: 'none', operations: [] };
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
