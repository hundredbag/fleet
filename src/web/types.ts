export type Availability =
  'installed' | 'missing' | 'disabled' | 'unavailable' | 'unsupported' | 'unverifiable';
export type Management = 'writable' | 'read-only' | 'delegated' | 'none';
export type Coverage = 'all-present' | 'gap' | 'agent-only' | 'unverifiable';
export type Operation = 'install' | 'sync' | 'remove' | 'update';

export interface PublicCapabilityInstance {
  agent: string;
  scope?: string;
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
  coverage: Coverage;
  instances: PublicCapabilityInstance[];
}

export interface InventoryResponse {
  agents: Array<{ id: string; displayName: string; present: boolean; inventoryAvailable: boolean }>;
  capabilities: PublicCapability[];
  capabilityInstances: number;
  uniqueCapabilityKeys: number;
}

export interface FeedResponse {
  updates: Array<{
    kind: string;
    name: string;
    agent: string;
    from?: string;
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
}

export interface ConflictsResponse {
  conflicts: Array<{ kind: string; name: string; agents: string[]; reasonCode: string }>;
}

export interface PublicPlanResponse {
  planId: string;
  expiresAt: number;
  changes: Array<{ agent: string; kind: string; name: string; scope?: string; op: string }>;
  warningCodes: string[];
  operationSummary: string;
}

export interface PublicApplyResponse {
  auditId?: string;
  applied: number;
  skipped: number;
  warningCodes: string[];
}

export interface PublicRollbackResponse {
  action: 'restored' | 'removed' | 'skipped';
  reasonCode?: string;
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
    inventoryAvailable: boolean;
    capabilityInstances: number;
  }>;
  drift: {
    checked: number;
    findings: Array<{
      kind: string;
      name: string;
      agent: string;
      state: 'modified' | 'missing' | 'unverifiable';
      reasonCode?: string;
    }>;
    unmanagedCount: number;
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
  agent: string;
  name: string;
  scope?: string;
  outcome: 'applied' | 'failed' | 'rolled-back' | 'unknown';
  rollbackEligible: boolean;
  rolledBack: boolean;
}

export interface ActivityResponse {
  items: ActivityItem[];
  delegatedActions: { status: 'available' | 'not-present' | 'unavailable' | 'malformed' };
}
