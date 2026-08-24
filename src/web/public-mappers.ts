import type { AgentAdapter } from '../core/adapter.js';
import type { DriftReport } from '../core/drift.js';
import type { Inventory, InstalledCapability, PrimitiveKind } from '../core/types.js';
import {
  isPublicAgentId,
  isPublicCapabilityName,
  isPublicPrimitiveKind,
  isPublicScope,
  publicConflictFindings,
  publicRollbackReasonCode,
} from '../core/redact.js';
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
  PublicConfigurationStatus,
  PublicErrorResponse,
  PublicPlanResponse,
  PublicRollbackResponse,
  PublicRuntimeStatus,
  PublicSetupStatus,
} from './types.js';
import { isTrustReasonCode, type TrustSnapshot } from '../core/trustgate.js';
import { capabilityCell, supportsDelegatedPlugin } from './operations.js';
import { cleanPublicSource, sanitizeFeedItem } from '../feed/sanitize.js';
import { MARKETPLACE_RE, pluginCoordinate } from '../core/plugin-coordinate.js';
import { parseGitHubSkillIdentifier } from './github-skill.js';
import { isValidWebPackageCoordinate } from './package-coordinate.js';

const UUID_ID = '[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}';
const OPAQUE_AUDIT_ID = new RegExp(`^${UUID_ID}$`, 'i');
const LEGACY_AUDIT_ID = new RegExp(`^\\d{10,16}-\\d{1,10}-(${UUID_ID})$`, 'i');

function publicRuntimeStatus(value: unknown): PublicRuntimeStatus {
  return value === 'available' || value === 'not-found' || value === 'unverifiable' ? value : 'unverifiable';
}

function publicConfigurationStatus(value: unknown, present: boolean): PublicConfigurationStatus {
  return value === 'configured' || value === 'not-configured' || value === 'unavailable'
    ? value
    : present
      ? 'configured'
      : 'not-configured';
}

function publicSetupStatus(value: unknown, inventoryStatus: string): PublicSetupStatus {
  const allowed: PublicSetupStatus[] = [
    'ready',
    'installed-unconfigured',
    'configured-runtime-missing',
    'configured-runtime-unverifiable',
    'not-detected',
    'detection-unavailable',
    'configuration-unavailable',
    'inventory-unavailable',
  ];
  if (allowed.includes(value as PublicSetupStatus)) return value as PublicSetupStatus;
  if (inventoryStatus === 'ok') return 'configured-runtime-unverifiable';
  if (inventoryStatus === 'not-present') return 'not-detected';
  return 'inventory-unavailable';
}

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
): Pick<PublicCapability, 'tokensEst' | 'sourceLabel' | 'sourceUrl'> {
  if (item.kind === 'mcp-server') {
    return { sourceLabel: 'agent-config' };
  }
  if (item.kind === 'skill') {
    return {
      ...(typeof item.tokensEst === 'number' && Number.isSafeInteger(item.tokensEst) && item.tokensEst >= 0
        ? { tokensEst: item.tokensEst }
        : {}),
      sourceLabel: 'local-skill',
    };
  }
  if (item.kind === 'rule') {
    return {
      ...(typeof item.tokensEst === 'number' && Number.isSafeInteger(item.tokensEst) && item.tokensEst >= 0
        ? { tokensEst: item.tokensEst }
        : {}),
      sourceLabel: 'managed-rule',
    };
  }
  if (item.kind === 'plugin') return { sourceLabel: 'vendor-plugin' };
  if (item.kind === 'subagent') {
    return typeof item.tokensEst === 'number' && Number.isSafeInteger(item.tokensEst) && item.tokensEst >= 0
      ? { tokensEst: item.tokensEst }
      : {};
  }
  return {};
}

function coverageOf(instances: PublicCapability['instances']): Coverage {
  if (instances.some((cell) => cell.availability === 'unavailable' || cell.availability === 'unverifiable')) {
    return 'unverifiable';
  }
  const relevant = instances.filter((cell) => cell.availability !== 'unsupported');
  const relevantAgents = new Set(relevant.map((cell) => cell.agent));
  const installedAgents = new Set(
    relevant
      .filter((cell) => cell.availability === 'installed' || cell.availability === 'disabled')
      .map((cell) => cell.agent),
  );
  if (
    relevantAgents.size > 0 &&
    installedAgents.size === relevantAgents.size &&
    relevant.length === instances.length
  ) {
    return 'all-present';
  }
  if (installedAgents.size === 1) return 'agent-only';
  return 'gap';
}

function publicPermissionEffect(item: InstalledCapability): string | undefined {
  if (item.kind !== 'permission') return undefined;
  return item.effect === 'allow' ||
    item.effect === 'deny' ||
    item.effect === 'ask' ||
    item.effect === 'policy'
    ? item.effect
    : 'other';
}

function isPublicMarketplace(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length <= 64 && MARKETPLACE_RE.test(value) && !value.includes('..')
  );
}

function publicMarketplace(item: InstalledCapability | undefined): string | undefined {
  return item?.kind === 'plugin' && isPublicMarketplace(item.marketplace) ? item.marketplace : undefined;
}

function supportsPublicPluginMutation(item: InstalledCapability, marketplace: string | undefined): boolean {
  if (item.kind !== 'plugin') return false;
  if (item.marketplace !== undefined && marketplace === undefined) return false;
  try {
    const coordinate = pluginCoordinate(item.name, marketplace);
    return coordinate.name === item.name && coordinate.marketplace === marketplace;
  } catch {
    return false;
  }
}

function publicIdentityKey(...parts: string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join('|');
}

function publicCapabilityIdentity(item: InstalledCapability): { key: string; name: string } {
  const effect = publicPermissionEffect(item);
  if (effect) {
    return {
      key: publicIdentityKey('permission', effect),
      name: `${effect[0]!.toUpperCase()}${effect.slice(1)} permission rules`,
    };
  }
  const marketplace = publicMarketplace(item);
  return {
    key: publicIdentityKey(item.kind, item.name, marketplace ?? ''),
    name: item.name,
  };
}

export function mapInventory(inv: Inventory, adapters: AgentAdapter[]): InventoryResponse {
  const agents = inv.agents.filter((agent) => isPublicAgentId(agent.id));
  const agentIds = new Set(agents.map((agent) => agent.id));
  const withheldPluginCells = new Set(
    inv.items
      .filter(
        (item) =>
          item.kind === 'plugin' &&
          item.marketplace !== undefined &&
          publicMarketplace(item) === undefined &&
          agentIds.has(item.agent) &&
          isPublicCapabilityName(item.name),
      )
      .map((item) => publicIdentityKey(item.agent, item.name)),
  );
  const publicItems = inv.items.filter(
    (item) =>
      agentIds.has(item.agent) &&
      isPublicPrimitiveKind(item.kind) &&
      isPublicScope(item.scope) &&
      typeof item.enabled === 'boolean' &&
      (item.kind !== 'plugin' || item.marketplace === undefined || publicMarketplace(item) !== undefined) &&
      (item.kind === 'permission' || isPublicCapabilityName(item.name)),
  );
  const groups = new Map<string, InstalledCapability[]>();
  for (const item of publicItems) {
    const { key } = publicCapabilityIdentity(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  const capabilities: PublicCapability[] = [];
  for (const [key, items] of groups) {
    const first = items[0]!;
    const publicIdentity = publicCapabilityIdentity(first);
    const marketplace = publicMarketplace(first);
    const kind = first.kind as PrimitiveKind;
    const pluginMutationIdentity = kind !== 'plugin' || supportsPublicPluginMutation(first, marketplace);
    const instances = agents.flatMap((agent) => {
      const found = items.filter((item) => item.agent === agent.id);
      const adapter = adapters.find((candidate) => candidate.id === agent.id);
      const scoped = new Map<string, InstalledCapability[]>();
      for (const item of found) {
        const group = scoped.get(item.scope) ?? [];
        group.push(item);
        scoped.set(item.scope, group);
      }
      const groupsForAgent = scoped.size > 0 ? [...scoped.values()] : [[]];
      return groupsForAgent.map((scopeItems) => {
        const real = scopeItems[0];
        const ambiguousContext = scopeItems.length > 1;
        const withheldPluginState =
          kind === 'plugin' && withheldPluginCells.has(publicIdentityKey(agent.id, publicIdentity.name));
        const hasUnambiguousSourceInstance = items.some(
          (candidate) =>
            candidate.agent !== agent.id &&
            items.filter((other) => other.agent === candidate.agent).length === 1,
        );
        const cell = adapter
          ? capabilityCell({
              adapter,
              agent,
              kind,
              hasInstance: Boolean(real),
              ...(real ? { scope: real.scope } : {}),
              hasSourceInstance: hasUnambiguousSourceInstance,
              delegatedSupported:
                kind === 'plugin' && pluginMutationIdentity && supportsDelegatedPlugin(adapter),
            })
          : { availability: 'unverifiable' as const, management: 'none' as const, operations: [] };
        const enabled = scopeItems.some((item) => item.enabled);
        return {
          agent: agent.id,
          ...(real && isPublicScope(real.scope) ? { scope: real.scope } : {}),
          ...(scopeItems.length > 1 ? { entryCount: scopeItems.length } : {}),
          ...(marketplace ? { marketplace } : {}),
          availability:
            real && !enabled && cell.availability === 'installed' ? ('disabled' as const) : cell.availability,
          // A scope label is not a private project-context selector. When one
          // agent reports multiple entries inside the same scope, keep the
          // count visible but advertise no mutation that the request DTO
          // cannot target exactly.
          management:
            kind === 'plugin' && (!pluginMutationIdentity || withheldPluginState)
              ? ('read-only' as const)
              : ambiguousContext
                ? ('none' as const)
                : cell.management,
          operations:
            ambiguousContext || !pluginMutationIdentity || withheldPluginState ? [] : cell.operations,
          ...(real ? { enabled } : {}),
        };
      });
    });
    const metadata = logicalMetadata(first);
    capabilities.push({
      key,
      kind: first.kind,
      name: publicIdentity.name,
      ...(metadata.tokensEst !== undefined ? { tokensEst: metadata.tokensEst } : {}),
      ...(metadata.sourceLabel ? { sourceLabel: metadata.sourceLabel } : {}),
      ...(metadata.sourceUrl ? { sourceUrl: metadata.sourceUrl } : {}),
      ...(first.kind === 'permission' ? { entryCount: items.length } : {}),
      coverage: coverageOf(instances),
      instances,
    });
  }
  capabilities.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name));
  return {
    agents: agents.map((agent) => ({
      id: agent.id,
      displayName: agent.id === 'claude-code' ? 'Claude Code' : agent.id === 'codex' ? 'Codex' : agent.id,
      present: agent.present === true,
      runtimeStatus: publicRuntimeStatus(agent.runtimeStatus),
      configurationStatus: publicConfigurationStatus(agent.configurationStatus, agent.present === true),
      setupStatus: publicSetupStatus(agent.setupStatus, agent.inventoryStatus),
      inventoryAvailable: agent.inventoryStatus === 'ok',
    })),
    capabilities,
    capabilityInstances: publicItems.length,
    uniqueCapabilityKeys: capabilities.length,
    withheldCount: inv.agents.length - agents.length + (inv.items.length - publicItems.length),
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
  installName?: string;
  marketplace?: string;
  targets?: string[];
  skillCoordinate?: { provider: 'github'; repository: string; skill: string };
  operation: 'install' | null;
}

function publicTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

export function mapFeed(input: {
  updates: Array<{
    name: string;
    agent: string;
    scope?: unknown;
    installed: string;
    available: string;
    operation?: 'update' | null;
  }>;
  skillUpdates: Array<{ name: string; agent: string; state: string }>;
  recommendations: RankedRecommendation[];
  failures: Array<{ source: string }>;
  fromCache: boolean;
  sourceWithheld?: number;
}): FeedResponse {
  const updates = input.updates.filter(
    (update) =>
      isPublicCapabilityName(update.name) &&
      isPublicAgentId(update.agent) &&
      /^[0-9][0-9A-Za-z.+_-]{0,63}$/.test(update.installed) &&
      /^[0-9][0-9A-Za-z.+_-]{0,63}$/.test(update.available),
  );
  const skillUpdates = input.skillUpdates.filter(
    (update) =>
      isPublicCapabilityName(update.name) &&
      isPublicAgentId(update.agent) &&
      ['update', 'update+local-edits', 'update+missing', 'update+unverifiable'].includes(update.state),
  );
  const failures = input.failures.flatMap((failure) => {
    const source = cleanPublicSource(failure.source);
    return source ? [{ source }] : [];
  });
  const recommendations = input.recommendations.flatMap((item) => {
    const clean = sanitizeFeedItem(item);
    if (!clean) return [];
    const cleanKind = clean.kind ?? 'mcp-server';
    const trust =
      item.trust === 'no-flags' || item.trust === 'caution' || item.trust === 'unknown'
        ? item.trust
        : 'unknown';
    const targets =
      item.operation === 'install' &&
      Array.isArray(item.targets) &&
      item.targets.length > 0 &&
      item.targets.length <= 32 &&
      item.targets.every(isPublicAgentId) &&
      new Set(item.targets).size === item.targets.length
        ? [...item.targets]
        : [];
    const skillCoordinate =
      item.skillCoordinate?.provider === 'github'
        ? (parseGitHubSkillIdentifier(`${item.skillCoordinate.repository}/${item.skillCoordinate.skill}`) ??
          undefined)
        : undefined;
    const marketplace =
      cleanKind === 'plugin' && isPublicMarketplace(item.marketplace) ? item.marketplace : undefined;
    const installName =
      typeof item.installName === 'string' && isPublicCapabilityName(item.installName)
        ? item.installName
        : clean.name;
    const operation =
      item.operation === 'install' &&
      targets.length > 0 &&
      ((cleanKind === 'mcp-server' &&
        isValidWebPackageCoordinate({
          ecosystem: clean.ecosystem,
          identifier: clean.identifier,
          version: clean.version,
        })) ||
        (cleanKind === 'skill' && skillCoordinate && installName === skillCoordinate.skill) ||
        (cleanKind === 'plugin' && marketplace))
        ? ('install' as const)
        : null;
    return [
      {
        kind: cleanKind,
        name: clean.name,
        ...(clean.category ? { category: clean.category } : {}),
        ...(clean.identifier ? { identifier: clean.identifier } : {}),
        ...(clean.ecosystem ? { ecosystem: clean.ecosystem } : {}),
        ...(clean.version ? { version: clean.version } : {}),
        ...(clean.description ? { description: clean.description } : {}),
        source: clean.source,
        reasons: item.reasons.filter((reason) =>
          ['new', 'popular', 'marketplace', 'related'].includes(reason),
        ),
        trust,
        ...(safeHttpUrl(clean.url) ? { url: safeHttpUrl(clean.url) } : {}),
        ...(publicTimestamp(clean.updatedAt) ? { updatedAt: publicTimestamp(clean.updatedAt) } : {}),
        ...(operation ? { targets } : {}),
        ...(operation && installName !== clean.name ? { installName } : {}),
        ...(operation && skillCoordinate ? { skillCoordinate } : {}),
        ...(operation && marketplace ? { marketplace } : {}),
        operation,
      },
    ];
  });
  return {
    updates: updates.map((update) => ({
      kind: 'mcp-server',
      name: update.name,
      agent: update.agent,
      ...(isPublicScope(update.scope) ? { scope: update.scope } : {}),
      to: update.available,
      operation: isPublicScope(update.scope) && update.operation === 'update' ? 'update' : null,
    })),
    skillUpdates: skillUpdates.map((update) => ({
      name: update.name,
      agent: update.agent,
      state: update.state,
      operation: null,
    })),
    recommendations,
    failures,
    fromCache: input.fromCache,
    withheldCount:
      (Number.isSafeInteger(input.sourceWithheld) && (input.sourceWithheld ?? 0) >= 0
        ? (input.sourceWithheld ?? 0)
        : 0) +
      input.updates.length -
      updates.length +
      (input.skillUpdates.length - skillUpdates.length) +
      (input.failures.length - failures.length) +
      (input.recommendations.length - recommendations.length),
  };
}

export function mapConflicts(
  findings: Array<{ agent: string; a: string; b: string; axis: string }>,
): ConflictsResponse {
  const projected = publicConflictFindings(findings);
  return {
    conflicts: projected.findings.map((finding) => ({
      kind: 'rule',
      name: `${finding.a} / ${finding.b}`,
      agents: [finding.agent],
      reasonCode: `RULE_${finding.axis.toUpperCase()}_CONFLICT`,
    })),
    withheldCount: projected.withheldCount,
  };
}

function warningCode(value: string): string {
  if (/trust/i.test(value)) return 'TRUST_WARNING';
  if (/already|nothing/i.test(value)) return 'NO_CHANGE';
  if (/fleet\.lock/i.test(value)) return 'PROVENANCE_WARNING';
  if (/unsupported|only .* scope/i.test(value)) return 'TRANSLATION_WARNING';
  return 'OPERATION_WARNING';
}

export function isPublicMutationIdentity(change: {
  agent: unknown;
  kind?: unknown;
  name: unknown;
  scope?: unknown;
  op: unknown;
  marketplace?: unknown;
}): boolean {
  const kind = change.kind ?? 'mcp-server';
  return (
    isPublicAgentId(change.agent) &&
    isPublicPrimitiveKind(kind) &&
    isPublicCapabilityName(change.name) &&
    (change.scope === undefined || isPublicScope(change.scope)) &&
    (change.op === 'install' || change.op === 'update' || change.op === 'remove' || change.op === 'sync') &&
    (kind === 'plugin'
      ? change.marketplace === undefined || isPublicMarketplace(change.marketplace)
      : change.marketplace === undefined)
  );
}

export function mapPlan(
  planId: string,
  expiresAt: number,
  plan: Plan,
  operationSummary: string,
): PublicPlanResponse {
  const warnings = [
    ...plan.changes.flatMap((change) => change.warnings ?? []),
    ...plan.skips.map((skip) => skip.reason),
  ];
  return {
    planId,
    expiresAt,
    changes: plan.changes.flatMap((change) => {
      return isPublicMutationIdentity(change)
        ? [
            {
              agent: change.agent,
              kind: change.kind ?? 'mcp-server',
              name: change.name,
              scope: change.scope,
              op: change.op,
            },
          ]
        : [];
    }),
    warningCodes: [...new Set(warnings.map(warningCode))],
    operationSummary,
  };
}

export function mapDelegatedPlan(
  planId: string,
  expiresAt: number,
  change: { agent: string; name: string; marketplace?: string; op: string },
  operationSummary: string,
): PublicPlanResponse {
  const publicChange = { ...change, kind: 'plugin', scope: 'user' };
  return {
    planId,
    expiresAt,
    changes: isPublicMutationIdentity(publicChange)
      ? [
          {
            agent: change.agent,
            kind: 'plugin',
            name: change.name,
            ...(change.marketplace ? { marketplace: change.marketplace } : {}),
            scope: 'user',
            op: change.op,
          },
        ]
      : [],
    warningCodes: [],
    operationSummary,
  };
}

export function mapApply(result: ExecuteResult): PublicApplyResponse {
  const publicApplied = result.applied.filter((item) => isPublicMutationIdentity(item.change));
  const recorded = publicApplied.filter((item) => item.auditRecorded);
  const auditRecorded = result.applied.filter((item) => item.auditRecorded).length;
  const unrecordedApplied = result.applied.length - auditRecorded;
  const withheldApplied = result.applied.length - publicApplied.length;
  const warnings = [
    ...result.changes.flatMap((change) => change.warnings ?? []),
    ...result.skips.map((skip) => skip.reason),
    ...(result.lockWarning ? [result.lockWarning] : []),
    ...(result.error ? [result.error] : []),
  ];
  const auditId = publicAuditId(recorded[0]?.auditId);
  const records = publicApplied.flatMap((item) => {
    const id = item.auditRecorded ? publicAuditId(item.auditId) : undefined;
    return [
      {
        agent: item.change.agent,
        kind: item.change.kind ?? 'mcp-server',
        name: item.change.name,
        scope: item.change.scope,
        op: item.change.op,
        auditRecorded: item.auditRecorded,
        ...(id ? { auditId: id } : {}),
      },
    ];
  });
  const outcome = result.recoveryPending
    ? ('outcome-unknown' as const)
    : result.error
      ? result.applied.length > 0
        ? ('partial' as const)
        : ('failed' as const)
      : result.applied.length > 0
        ? ('applied' as const)
        : ('nothing-to-do' as const);
  return {
    ...(auditId ? { auditId } : {}),
    applied: result.applied.length,
    auditRecorded,
    unrecordedApplied,
    ...(withheldApplied > 0 ? { withheldApplied } : {}),
    records,
    skipped:
      result.skips.length + (result.error ? Math.max(0, result.changes.length - result.applied.length) : 0),
    warningCodes: [
      ...new Set([
        ...warnings.map((warning) =>
          result.error && warning === result.error
            ? result.recoveryPending
              ? 'RECOVERY_PENDING'
              : unrecordedApplied > 0
                ? 'AUDIT_WRITE_FAILED'
                : 'OPERATION_FAILED'
            : warningCode(warning),
        ),
      ]),
    ],
    outcome,
    ...(result.recoveryPending || unrecordedApplied > 0
      ? { recoveryClass: 'manual-config-recovery' as const }
      : {}),
  };
}

export function mapDelegatedApply(
  status: 'applied' | 'nothing-to-do' | 'failed' | 'outcome-unknown',
  warning: boolean,
  vendorStateInspection = status === 'failed' || status === 'outcome-unknown',
  identity?: {
    agent: string;
    name: string;
    marketplace?: string;
    op: string;
    delegatedId?: string;
    delegatedRecorded: boolean;
  },
): PublicApplyResponse {
  const delegatedId = publicAuditId(identity?.delegatedId);
  const records =
    identity && isPublicMutationIdentity({ ...identity, kind: 'plugin', scope: 'user' })
      ? [
          {
            agent: identity.agent,
            kind: 'plugin',
            name: identity.name,
            ...(identity.marketplace ? { marketplace: identity.marketplace } : {}),
            scope: 'user',
            op: identity.op,
            delegatedRecorded: identity.delegatedRecorded,
            ...(delegatedId ? { delegatedId } : {}),
          },
        ]
      : [];
  return {
    applied: status === 'applied' ? 1 : 0,
    skipped: status === 'applied' ? 0 : 1,
    records,
    warningCodes:
      status === 'outcome-unknown'
        ? ['OUTCOME_UNKNOWN']
        : status === 'nothing-to-do'
          ? ['NO_CHANGE']
          : warning
            ? ['PROVENANCE_WARNING']
            : status === 'applied'
              ? []
              : ['OPERATION_FAILED'],
    outcome: status,
    ...((status === 'failed' || status === 'outcome-unknown') && vendorStateInspection
      ? { recoveryClass: 'vendor-state-inspection' as const }
      : {}),
  };
}

export function mapRollback(result: {
  action: 'restored' | 'removed' | 'skipped';
  reason?: string;
  auditRecorded?: boolean;
  lockWarning?: string;
}): PublicRollbackResponse {
  const reasonCode = publicRollbackReasonCode(result.reason);
  return {
    action: result.action,
    ...(reasonCode ? { reasonCode } : {}),
    ...(result.auditRecorded === false && result.action !== 'skipped'
      ? { provenanceRecorded: false, recoveryClass: 'audit-history-repair' as const }
      : {}),
    ...(result.lockWarning ? { lockWarningCode: 'PROVENANCE_WARNING' as const } : {}),
  };
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

const PUBLIC_DRIFT_KINDS = new Set([
  'mcp-server',
  'skill',
  'rule',
  'permission',
  'plugin',
  'command',
  'hook',
  'subagent',
]);
function safeDriftIdentity(item: { kind: string; name: string; agent: string }): boolean {
  return (
    PUBLIC_DRIFT_KINDS.has(item.kind) && isPublicCapabilityName(item.name) && isPublicAgentId(item.agent)
  );
}

export function mapOverview(
  inv: InventoryResponse,
  drift: DriftReport,
  generatedAt: number,
): OverviewResponse {
  return {
    presentAgents: inv.agents.filter((agent) => agent.present).length,
    unavailableAgents: inv.agents.filter((agent) =>
      ['detection-unavailable', 'configuration-unavailable', 'inventory-unavailable'].includes(
        agent.setupStatus,
      ),
    ).length,
    capabilityInstances: inv.capabilityInstances,
    uniqueCapabilityKeys: inv.uniqueCapabilityKeys,
    agents: inv.agents.map((agent) => ({
      id: agent.id,
      displayName: agent.displayName,
      present: agent.present,
      runtimeStatus: agent.runtimeStatus,
      configurationStatus: agent.configurationStatus,
      setupStatus: agent.setupStatus,
      inventoryAvailable: agent.inventoryAvailable,
      capabilityInstances: inv.capabilities.reduce(
        (count, capability) =>
          count +
          capability.instances
            .filter((instance) => instance.agent === agent.id && typeof instance.enabled === 'boolean')
            .reduce((instances, instance) => instances + (instance.entryCount ?? 1), 0),
        0,
      ),
    })),
    drift: {
      lockStatus: drift.lockStatus,
      checked: drift.checked,
      findings: drift.findings.filter(safeDriftIdentity).map((finding) => ({
        kind: finding.kind,
        name: finding.name,
        agent: finding.agent,
        state: finding.state === 'intact' ? 'unverifiable' : finding.state,
        ...(driftReason(finding.detail) ? { reasonCode: driftReason(finding.detail) } : {}),
      })),
      unmanagedCount: drift.unmanaged.length,
      withheldCount:
        drift.findings.length -
        drift.findings.filter(safeDriftIdentity).length +
        (drift.unmanaged.length - drift.unmanaged.filter(safeDriftIdentity).length),
      unmanaged: drift.unmanaged.filter(safeDriftIdentity).map((item) => ({
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
    kind: 'mcp-server' | 'skill' | 'rule';
    agent: string;
    name: string;
    scope?: string;
    trust?: TrustSnapshot;
  },
  rolledBack: boolean,
  rollbackEligible: boolean,
): ActivityItem {
  return {
    id: record.id,
    ts: record.ts,
    source: 'core-audit',
    op: record.op,
    kind: record.kind,
    agent: record.agent,
    name: record.name,
    ...(record.scope ? { scope: record.scope } : {}),
    outcome: rolledBack ? 'rolled-back' : 'applied',
    rollbackEligible,
    rolledBack,
    ...(record.trust
      ? {
          trustLevel: record.trust.level,
          trustReasonCodes: record.trust.reasonCodes.filter(isTrustReasonCode),
        }
      : {}),
  };
}

export function mapDelegatedActivity(record: {
  id: string;
  ts: number;
  op: string;
  agent: string;
  name: string;
  marketplace?: string;
  outcome: 'applied' | 'nothing-to-do' | 'failed' | 'unknown';
}): ActivityItem {
  return {
    id: record.id,
    ts: record.ts,
    source: 'delegated-plugin',
    op: record.op,
    kind: 'plugin',
    agent: record.agent,
    name: record.name,
    ...(record.marketplace ? { marketplace: record.marketplace } : {}),
    outcome: record.outcome,
    rollbackEligible: false,
    rolledBack: false,
  };
}
