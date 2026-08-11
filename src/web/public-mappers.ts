import type { AgentAdapter } from '../core/adapter.js';
import { extractCoordinate } from '../core/coords.js';
import type { DriftReport } from '../core/drift.js';
import type { Inventory, InstalledCapability, PrimitiveKind } from '../core/types.js';
import type { ExecuteResult, Plan } from '../core/orchestrator.js';
import type {
  ActivityItem,
  ConflictsResponse,
  Coverage,
  FeedResponse,
  InventoryResponse,
  OverviewResponse,
  PublicApplyResponse,
  PublicCapability,
  PublicErrorResponse,
  PublicPlanResponse,
  PublicRollbackResponse,
} from './types.js';
import { capabilityCell, supportsDelegatedPlugin } from './operations.js';

const UUID_ID = '[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}';
const OPAQUE_AUDIT_ID = new RegExp(`^${UUID_ID}$`, 'i');
const LEGACY_AUDIT_ID = new RegExp(`^\\d{10,16}-\\d{1,10}-(${UUID_ID})$`, 'i');

/** New audit IDs are opaque UUIDs; legacy timestamp/PID IDs expose only their UUID suffix. */
export function publicAuditId(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (OPAQUE_AUDIT_ID.test(value)) return value;
  return LEGACY_AUDIT_ID.exec(value)?.[1];
}

export function safeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password) return undefined;
    url.hash = '';
    for (const key of [...url.searchParams.keys()]) {
      if (/(token|key|secret|auth|sig|password|credential|session|bearer)/i.test(key)) return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function logicalMetadata(
  item: InstalledCapability,
): Pick<PublicCapability, 'description' | 'tokensEst' | 'sourceLabel' | 'sourceUrl' | 'coordinate'> {
  if (item.kind === 'mcp-server') {
    const coordinate = extractCoordinate(item.spec);
    return {
      sourceLabel: 'agent-config',
      coordinate:
        coordinate?.confidence === 'high'
          ? {
              ecosystem: coordinate.ecosystem,
              identifier: coordinate.id,
              ...(coordinate.version ? { version: coordinate.version } : {}),
            }
          : undefined,
    };
  }
  if (item.kind === 'skill') {
    return { description: item.meta?.description, tokensEst: item.tokensEst, sourceLabel: 'local-skill' };
  }
  if (item.kind === 'rule') return { tokensEst: item.tokensEst, sourceLabel: 'managed-rule' };
  if (item.kind === 'plugin') return { description: item.description, sourceLabel: 'vendor-plugin' };
  if (item.kind === 'subagent') return { description: item.description, tokensEst: item.tokensEst };
  return {};
}

function coverageOf(instances: PublicCapability['instances']): Coverage {
  if (instances.some((cell) => cell.availability === 'unavailable' || cell.availability === 'unverifiable')) {
    return 'unverifiable';
  }
  const relevant = instances.filter((cell) => cell.availability !== 'unsupported');
  const installed = relevant.filter(
    (cell) => cell.availability === 'installed' || cell.availability === 'disabled',
  ).length;
  if (relevant.length > 0 && installed === relevant.length && relevant.length === instances.length) {
    return 'all-present';
  }
  if (installed === 1) return 'agent-only';
  return 'gap';
}

export function mapInventory(inv: Inventory, adapters: AgentAdapter[]): InventoryResponse {
  const groups = new Map<string, InstalledCapability[]>();
  for (const item of inv.items) {
    const key = `${item.kind}:${item.name}`;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  const capabilities: PublicCapability[] = [];
  for (const [key, items] of groups) {
    const first = items[0]!;
    const kind = first.kind as PrimitiveKind;
    const instances = inv.agents.map((agent) => {
      const real = items.find((item) => item.agent === agent.id);
      const adapter = adapters.find((candidate) => candidate.id === agent.id);
      const cell = adapter
        ? capabilityCell({
            adapter,
            agent,
            kind,
            hasInstance: Boolean(real),
            hasSourceInstance: items.some((item) => item.agent !== agent.id),
            delegatedSupported: kind === 'plugin' && supportsDelegatedPlugin(adapter),
          })
        : { availability: 'unverifiable' as const, management: 'none' as const, operations: [] };
      return {
        agent: agent.id,
        ...(real ? { scope: real.scope } : {}),
        availability:
          real && !real.enabled && cell.availability === 'installed'
            ? ('disabled' as const)
            : cell.availability,
        management: cell.management,
        operations: cell.operations,
        ...(real ? { enabled: real.enabled } : {}),
      };
    });
    const metadata = logicalMetadata(first);
    capabilities.push({
      key,
      kind: first.kind,
      name: first.name,
      ...(metadata.description ? { description: metadata.description } : {}),
      ...(metadata.tokensEst !== undefined ? { tokensEst: metadata.tokensEst } : {}),
      ...(metadata.sourceLabel ? { sourceLabel: metadata.sourceLabel } : {}),
      ...(metadata.sourceUrl ? { sourceUrl: metadata.sourceUrl } : {}),
      ...(metadata.coordinate ? { coordinate: metadata.coordinate } : {}),
      coverage: coverageOf(instances),
      instances,
    });
  }
  capabilities.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  return {
    agents: inv.agents.map((agent) => ({
      id: agent.id,
      displayName: agent.displayName,
      present: agent.present,
      inventoryAvailable: agent.inventoryStatus === 'ok',
    })),
    capabilities,
    capabilityInstances: inv.items.length,
    uniqueCapabilityKeys: capabilities.length,
  };
}

interface RankedRecommendation {
  name: string;
  kind: string;
  category?: string;
  identifier?: string;
  ecosystem?: string;
  version?: string;
  description?: string;
  source: string;
  reasons: string[];
  trust: string;
  url?: string;
  updatedAt?: string;
  operation: 'install' | null;
}

function publicTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

export function mapFeed(input: {
  updates: Array<{ name: string; agent: string; installed: string; available: string }>;
  skillUpdates: Array<{ name: string; agent: string; state: string }>;
  recommendations: RankedRecommendation[];
  failures: Array<{ source: string }>;
  fromCache: boolean;
}): FeedResponse {
  return {
    updates: input.updates.map((update) => ({
      kind: 'mcp-server',
      name: update.name,
      agent: update.agent,
      from: update.installed,
      to: update.available,
      operation: 'update',
    })),
    skillUpdates: input.skillUpdates.map((update) => ({
      name: update.name,
      agent: update.agent,
      state: update.state,
      operation: null,
    })),
    recommendations: input.recommendations.map((item) => ({
      kind: item.kind,
      name: item.name,
      ...(item.category ? { category: item.category } : {}),
      ...(item.identifier ? { identifier: item.identifier } : {}),
      ...(item.ecosystem ? { ecosystem: item.ecosystem } : {}),
      ...(item.version ? { version: item.version } : {}),
      ...(item.description ? { description: item.description } : {}),
      source: item.source,
      reasons: item.reasons.map((reason) => reason),
      trust: item.trust,
      ...(safeHttpUrl(item.url) ? { url: safeHttpUrl(item.url) } : {}),
      ...(publicTimestamp(item.updatedAt) ? { updatedAt: publicTimestamp(item.updatedAt) } : {}),
      operation: item.operation,
    })),
    failures: input.failures.map((failure) => ({ source: failure.source })),
    fromCache: input.fromCache,
  };
}

export function mapConflicts(
  findings: Array<{ agent: string; a: string; b: string; axis: string }>,
): ConflictsResponse {
  const allowed = new Set(['verbosity', 'autonomy', 'tone']);
  return {
    conflicts: findings.map((finding) => ({
      kind: 'rule',
      name: `${finding.a} / ${finding.b}`,
      agents: [finding.agent],
      reasonCode: allowed.has(finding.axis) ? `RULE_${finding.axis.toUpperCase()}_CONFLICT` : 'RULE_CONFLICT',
    })),
  };
}

function warningCode(value: string): string {
  if (/trust/i.test(value)) return 'TRUST_WARNING';
  if (/already|nothing/i.test(value)) return 'NO_CHANGE';
  if (/fleet\.lock/i.test(value)) return 'PROVENANCE_WARNING';
  if (/unsupported|only .* scope/i.test(value)) return 'TRANSLATION_WARNING';
  return 'OPERATION_WARNING';
}

export function mapPlan(
  planId: string,
  expiresAt: number,
  plan: Plan,
  operationSummary: string,
  publicOperation?: string,
): PublicPlanResponse {
  const warnings = [
    ...plan.changes.flatMap((change) => change.warnings ?? []),
    ...plan.skips.map((skip) => skip.reason),
  ];
  return {
    planId,
    expiresAt,
    changes: plan.changes.map((change) => ({
      agent: change.agent,
      kind: change.kind ?? 'mcp-server',
      name: change.name,
      scope: change.scope,
      op: publicOperation ?? change.op,
    })),
    warningCodes: [...new Set(warnings.map(warningCode))],
    operationSummary,
  };
}

export function mapDelegatedPlan(
  planId: string,
  expiresAt: number,
  change: { agent: string; name: string; op: string },
  operationSummary: string,
): PublicPlanResponse {
  return {
    planId,
    expiresAt,
    changes: [{ agent: change.agent, kind: 'plugin', name: change.name, scope: 'user', op: change.op }],
    warningCodes: [],
    operationSummary,
  };
}

export function mapApply(result: ExecuteResult): PublicApplyResponse {
  const warnings = [
    ...result.changes.flatMap((change) => change.warnings ?? []),
    ...result.skips.map((skip) => skip.reason),
    ...(result.lockWarning ? [result.lockWarning] : []),
    ...(result.error ? [result.error] : []),
  ];
  const auditId = publicAuditId(result.applied[0]?.auditId);
  return {
    ...(auditId ? { auditId } : {}),
    applied: result.applied.length,
    skipped: result.skips.length + (result.error ? 1 : 0),
    warningCodes: [
      ...new Set([
        ...warnings.map((warning) =>
          result.error && warning === result.error ? 'OPERATION_FAILED' : warningCode(warning),
        ),
      ]),
    ],
  };
}

export function mapDelegatedApply(applied: boolean, warning: boolean): PublicApplyResponse {
  return {
    applied: applied ? 1 : 0,
    skipped: applied ? 0 : 1,
    warningCodes: warning ? ['PROVENANCE_WARNING'] : applied ? [] : ['OPERATION_FAILED'],
  };
}

export function mapRollback(result: {
  action: 'restored' | 'removed' | 'skipped';
  reason?: string;
}): PublicRollbackResponse {
  let reasonCode: string | undefined;
  if (result.reason) {
    if (/diverged/i.test(result.reason)) reasonCode = 'TARGET_DIVERGED';
    else if (/already absent/i.test(result.reason)) reasonCode = 'ALREADY_ABSENT';
    else if (/write-hash/i.test(result.reason)) reasonCode = 'UNVERIFIABLE_TARGET';
    else reasonCode = 'OPERATION_WARNING';
  }
  return { action: result.action, ...(reasonCode ? { reasonCode } : {}) };
}

export function mapError(code = 'OPERATION_FAILED', messageKey = 'operation.failed'): PublicErrorResponse {
  return { code, messageKey };
}

function driftReason(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  if (/inventory unavailable/i.test(detail)) return 'AGENT_INVENTORY_UNAVAILABLE';
  if (/predates canonical/i.test(detail)) return 'BASELINE_LEGACY';
  if (/no longer on the agent/i.test(detail)) return 'CAPABILITY_MISSING';
  if (/content differs/i.test(detail)) return 'CONTENT_MODIFIED';
  return 'DRIFT_UNVERIFIABLE';
}

export function mapOverview(
  inv: InventoryResponse,
  drift: DriftReport,
  generatedAt: number,
): OverviewResponse {
  return {
    presentAgents: inv.agents.filter((agent) => agent.present).length,
    unavailableAgents: inv.agents.filter((agent) => !agent.inventoryAvailable).length,
    capabilityInstances: inv.capabilityInstances,
    uniqueCapabilityKeys: inv.uniqueCapabilityKeys,
    agents: inv.agents.map((agent) => ({
      id: agent.id,
      displayName: agent.displayName,
      present: agent.present,
      inventoryAvailable: agent.inventoryAvailable,
      capabilityInstances: inv.capabilities.reduce(
        (count, capability) =>
          count +
          capability.instances.filter(
            (instance) =>
              instance.agent === agent.id &&
              (instance.availability === 'installed' || instance.availability === 'disabled'),
          ).length,
        0,
      ),
    })),
    drift: {
      checked: drift.checked,
      findings: drift.findings.map((finding) => ({
        kind: finding.kind,
        name: finding.name,
        agent: finding.agent,
        state: finding.state === 'intact' ? 'unverifiable' : finding.state,
        ...(driftReason(finding.detail) ? { reasonCode: driftReason(finding.detail) } : {}),
      })),
      unmanagedCount: drift.unmanaged.length,
      unmanaged: drift.unmanaged.map((item) => ({
        kind: item.kind,
        name: item.name,
        agent: item.agent,
        state: 'unmanaged',
        reasonCode: 'NOT_FLEET_MANAGED',
      })),
    },
    generatedAt,
  };
}

export function mapCoreActivity(
  record: {
    id: string;
    ts: number;
    op: string;
    agent: string;
    name: string;
    scope?: string;
  },
  rolledBack: boolean,
  rollbackEligible: boolean,
): ActivityItem {
  return {
    id: record.id,
    ts: record.ts,
    source: 'core-audit',
    op: record.op,
    agent: record.agent,
    name: record.name,
    ...(record.scope ? { scope: record.scope } : {}),
    outcome: rolledBack ? 'rolled-back' : 'applied',
    rollbackEligible,
    rolledBack,
  };
}

export function mapDelegatedActivity(record: {
  id: string;
  ts: number;
  op: string;
  agent: string;
  name: string;
  succeeded: boolean;
}): ActivityItem {
  return {
    id: record.id,
    ts: record.ts,
    source: 'delegated-plugin',
    op: record.op,
    agent: record.agent,
    name: record.name,
    outcome: record.succeeded ? 'applied' : 'failed',
    rollbackEligible: false,
    rolledBack: false,
  };
}
