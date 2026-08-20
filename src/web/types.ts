export type Availability =
  'installed' | 'missing' | 'disabled' | 'unavailable' | 'unsupported' | 'unverifiable';
export type Management = 'writable' | 'read-only' | 'delegated' | 'none';
export type Coverage = 'all-present' | 'gap' | 'agent-only' | 'unverifiable';
export type Operation = 'install' | 'sync' | 'remove' | 'update';
export type PublicRuntimeStatus = 'available' | 'not-found' | 'unverifiable';
export type PublicConfigurationStatus = 'configured' | 'not-configured' | 'unavailable';
export type PublicSetupStatus =
  | 'ready'
  | 'installed-unconfigured'
  | 'configured-runtime-missing'
  | 'configured-runtime-unverifiable'
  | 'not-detected'
  | 'detection-unavailable'
  | 'configuration-unavailable'
  | 'inventory-unavailable';

export interface PublicCapabilityInstance {
  agent: string;
  scope?: string;
  /** More than one private project context may share this public agent/scope identity. */
  entryCount?: number;
  /** Vendor catalog identity, distinct from the logical plugin name. */
  marketplace?: string;
  availability: Availability;
  management: Management;
  operations: Operation[];
  enabled?: boolean;
}

export interface PublicCapability {
  key: string;
  kind: string;
  name: string;
  description?: string;
  tokensEst?: number;
  sourceLabel?: 'agent-config' | 'local-skill' | 'managed-rule' | 'vendor-plugin';
  sourceUrl?: string;
  coordinate?: { ecosystem: string; identifier: string; version?: string };
  /** Number of raw entries collapsed into this safe public class. */
  entryCount?: number;
  coverage: Coverage;
  instances: PublicCapabilityInstance[];
}

export interface InventoryResponse {
  agents: Array<{
    id: string;
    displayName: string;
    present: boolean;
    runtimeStatus: PublicRuntimeStatus;
    configurationStatus: PublicConfigurationStatus;
    setupStatus: PublicSetupStatus;
    inventoryAvailable: boolean;
  }>;
  capabilities: PublicCapability[];
  capabilityInstances: number;
  uniqueCapabilityKeys: number;
  withheldCount: number;
}

export interface FeedResponse {
  updates: Array<{
    kind: string;
    name: string;
    agent: string;
    scope?: string;
    to?: string;
    operation: Operation | null;
  }>;
  skillUpdates: Array<{ name: string; agent: string; state: string; operation: Operation | null }>;
  recommendations: Array<{
    kind: string;
    name: string;
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
  }>;
  failures: Array<{ source: string }>;
  fromCache: boolean;
  withheldCount: number;
}

export interface ConflictsResponse {
  conflicts: Array<{ kind: string; name: string; agents: string[]; reasonCode: string }>;
  withheldCount: number;
}

export interface PublicPlanResponse {
  planId: string;
  expiresAt: number;
  changes: Array<{
    agent: string;
    kind: string;
    name: string;
    marketplace?: string;
    scope?: string;
    op: string;
  }>;
  warningCodes: string[];
  operationSummary: string;
}

export interface PublicApplyResponse {
  auditId?: string;
  applied: number;
  auditRecorded?: number;
  unrecordedApplied?: number;
  withheldApplied?: number;
  skipped: number;
  warningCodes: string[];
  outcome: 'applied' | 'partial' | 'nothing-to-do' | 'failed' | 'outcome-unknown';
  records: Array<{
    agent: string;
    kind: string;
    name: string;
    marketplace?: string;
    scope: string;
    op: string;
    auditRecorded?: boolean;
    auditId?: string;
    delegatedRecorded?: boolean;
    delegatedId?: string;
  }>;
  recoveryClass?: 'vendor-state-inspection' | 'manual-config-recovery';
}

export interface PublicRollbackResponse {
  action: 'restored' | 'removed' | 'skipped';
  reasonCode?: string;
  lockWarningCode?: 'PROVENANCE_WARNING';
  provenanceRecorded?: boolean;
  recoveryClass?: 'audit-history-repair';
}

export interface PublicErrorResponse {
  code: string;
  messageKey: string;
}

export interface OverviewResponse {
  presentAgents: number;
  unavailableAgents: number;
  capabilityInstances: number;
  uniqueCapabilityKeys: number;
  agents: Array<{
    id: string;
    displayName: string;
    present: boolean;
    runtimeStatus: PublicRuntimeStatus;
    configurationStatus: PublicConfigurationStatus;
    setupStatus: PublicSetupStatus;
    inventoryAvailable: boolean;
    capabilityInstances: number;
  }>;
  drift: {
    lockStatus: 'available' | 'not-present' | 'unavailable' | 'malformed';
    checked: number;
    findings: Array<{
      kind: string;
      name: string;
      agent: string;
      state: 'modified' | 'missing' | 'unverifiable';
      reasonCode?: string;
    }>;
    unmanagedCount: number;
    withheldCount: number;
    unmanaged: Array<{
      kind: string;
      name: string;
      agent: string;
      state: 'unmanaged';
      reasonCode: string;
    }>;
  };
  generatedAt: number;
}

export interface ActivityItem {
  id: string;
  ts: number;
  source: 'core-audit' | 'delegated-plugin';
  op: string;
  kind: 'mcp-server' | 'skill' | 'rule' | 'plugin';
  agent: string;
  name: string;
  marketplace?: string;
  scope?: string;
  outcome: 'applied' | 'nothing-to-do' | 'failed' | 'rolled-back' | 'unknown';
  rollbackEligible: boolean;
  rolledBack: boolean;
  trustLevel?: 'ok' | 'caution';
  trustReasonCodes?: string[];
}

export interface ActivityResponse {
  items: ActivityItem[];
  coreActions: {
    status: 'available' | 'not-present' | 'unavailable' | 'malformed' | 'incomplete';
    withheldCount: number;
  };
  delegatedActions: { status: 'available' | 'not-present' | 'unavailable' | 'malformed' };
}
