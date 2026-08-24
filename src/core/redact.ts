import type {
  Inventory,
  McpServerCapability,
  PermissionCapability,
  PluginCapability,
  PrimitiveKind,
  RuleCapability,
  Scope,
  SkillCapability,
  SubagentCapability,
} from './types.js';
import type { ExecuteResult } from './orchestrator.js';
import { MARKETPLACE_RE } from './plugin-coordinate.js';
import { FleetOperationError } from './errors.js';

/**
 * Secret-redaction + summary helpers shared by every AI/human-facing surface
 * (MCP tools, web dashboard). These define the security boundary: raw inventory
 * (env/headers/raw/url-creds) must never cross to an AI or a browser.
 */

const SECRET_QUERY_KEY = /(token|key|secret|auth|sig|password|pwd|access|credential|session|bearer)/i;
export const PUBLIC_SCHEMA_VERSION = 2 as const;

/**
 * Strip credentials embedded in a URL (userinfo + sensitive query params +
 * fragment). FAIL CLOSED: a string that doesn't parse as a URL may still carry
 * a secret we can't locate, so it is replaced wholesale rather than passed on.
 */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    if (u.username || u.password) {
      u.username = '';
      u.password = '';
    }
    for (const k of [...u.searchParams.keys()]) {
      if (SECRET_QUERY_KEY.test(k)) u.searchParams.set(k, 'REDACTED');
    }
    u.hash = ''; // fragments can carry tokens and are never needed for display
    return u.toString();
  } catch {
    return '[unparseable-url REDACTED]';
  }
}

/**
 * Scrub common secret shapes out of free-form text (vendor-CLI output, error
 * messages) before it reaches a ledger, an AI face or a browser. Boring,
 * high-precision patterns only — no entropy guessing.
 */
// key names match ANYWHERE in a compound identifier (AWS_SECRET_ACCESS_KEY,
// OPENAI_API_KEY, GITHUB_TOKEN…) — a plain \b(secret)\b can't see past the `_`.
// [ \t] only — \s would cross a newline and swallow the NEXT line's key name,
// leaving that line's value unprotected
const KEY_VALUE_RE =
  /([\w-]*(?:api[_-]?key|token|secret|password|passwd|credential|authorization)[\w-]*[ \t]*[=:][ \t]*)\S+([ \t]+\S+)?/gi;
const BEARER_RE = /\b(bearer)[ \t]+[A-Za-z0-9._~+/=-]{6,}/gi;
const TOKEN_SHAPES: RegExp[] = [
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, // JWT
  /\bsk-[A-Za-z0-9_-]{20,}\b/g, // OpenAI-style keys
  /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key ids
];

export function scrubSecrets(text: string): string {
  let out = text.replace(/:\/\/[^/\s@]+@/g, '://REDACTED@'); // URL userinfo
  // "Authorization: Bearer <tok>" — redact the VALUE (up to two tokens, so the
  // scheme word can't shield the credential that follows it)
  out = out.replace(KEY_VALUE_RE, '$1REDACTED');
  out = out.replace(BEARER_RE, '$1 REDACTED');
  for (const re of TOKEN_SHAPES) out = out.replace(re, 'REDACTED');
  return out;
}

/**
 * Defense-in-depth for JSON values that cross an AI or browser boundary.
 *
 * Boundary-specific mappers must still use allowlists so sensitive fields such
 * as env/raw/file never enter the DTO. This recursive pass protects free-form
 * strings added by adapters, registries, writers, and future fields. It also
 * strips URL fragments and credentials when the complete string is a URL.
 */
export function scrubPublicValue<T>(value: T): T {
  const seen = new WeakSet<object>();
  const dangerousKeys = new Set(['__proto__', 'prototype', 'constructor', 'toJSON']);

  const sensitiveKey = (key: string): boolean => {
    if (dangerousKeys.has(key)) return true;
    if (scrubSecrets(key) !== key) return true;
    const segmented = key.replace(/([a-z0-9])([A-Z])/g, '$1_$2');
    return /(?:^|[_-])(?:api[_-]?key|token|secret|password|passwd|credential|authorization|bearer)(?:$|[_-])/i.test(
      segmented,
    );
  };

  const visit = (item: unknown): unknown => {
    if (typeof item === 'string') {
      const scrubbed = scrubSecrets(item);
      const scheme = /^([a-z][a-z0-9+.-]*):(.*)$/i.exec(scrubbed);
      if (!scheme) return scrubbed;
      if (!/^https?:\/\//i.test(scrubbed)) {
        return NON_PUBLIC_SCHEMES.has(scheme[1]!.toLowerCase()) || /^[/\\]/.test(scheme[2]!)
          ? '[non-public-url REDACTED]'
          : scrubbed;
      }
      try {
        const protocol = new URL(scrubbed).protocol;
        return protocol === 'http:' || protocol === 'https:'
          ? redactUrl(scrubbed)
          : '[non-public-url REDACTED]';
      } catch {
        return '[unparseable-url REDACTED]';
      }
    }
    if (typeof item === 'number') return Number.isFinite(item) ? item : null;
    if (typeof item === 'boolean' || item === null) return item;
    if (typeof item === 'undefined' || typeof item === 'function' || typeof item === 'symbol') {
      return undefined;
    }
    if (typeof item === 'bigint') return undefined;
    if (typeof item !== 'object') return undefined;
    if (seen.has(item)) return '[cyclic-value REDACTED]';
    seen.add(item);
    if (Array.isArray(item)) {
      const descriptors = Object.getOwnPropertyDescriptors(item) as Record<string, PropertyDescriptor>;
      const rawLength = descriptors.length?.value;
      const length =
        typeof rawLength === 'number' && Number.isSafeInteger(rawLength)
          ? Math.min(Math.max(rawLength, 0), 10_000)
          : 0;
      const result = new Array<unknown>(length);
      Object.defineProperty(result, 'toJSON', { value: undefined, enumerable: false });
      for (let index = 0; index < length; index++) {
        const descriptor = descriptors[String(index)];
        if (descriptor && 'value' in descriptor) result[index] = visit(descriptor.value);
      }
      return result;
    }
    // Own toJSON shadow plus data-descriptor reads prevent serialization hooks
    // and accessors from running after this scrub but before final stringify.
    // Keep ordinary Object/Array prototypes so mapped DTOs retain normal JS
    // collection behavior for in-process callers.
    const result: Record<string, unknown> = {};
    Object.defineProperty(result, 'toJSON', { value: undefined, enumerable: false });
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(item))) {
      if (sensitiveKey(key) || !('value' in descriptor)) continue;
      Object.defineProperty(result, key, {
        value: visit(descriptor.value),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return result;
  };

  return visit(value) as T;
}

/** Versioned top-level envelope for machine-facing MCP/Web JSON payloads. */
export function publicPayload(value: unknown): Record<string, unknown> {
  const safe = scrubPublicValue(value);
  if (safe && typeof safe === 'object' && !Array.isArray(safe)) {
    return { ...(safe as Record<string, unknown>), schemaVersion: PUBLIC_SCHEMA_VERSION };
  }
  return { data: safe, schemaVersion: PUBLIC_SCHEMA_VERSION };
}

/** Best-effort scrubbing for local diagnostic output. Do not use it as an
 * allowlist substitute at a remote/AI error boundary. */
export function publicErrorMessage(error: unknown): string {
  return scrubSecrets(error instanceof Error ? error.message : String(error));
}

/** Fixed error classification for an AI/public boundary. No caught text is returned. */
export function publicErrorCode(error: unknown): string {
  if (error instanceof FleetOperationError) return error.publicCode;
  const message = error instanceof Error ? error.message : String(error);
  if (
    message === 'REQUEST_REJECTED' ||
    message === 'TARGET_UNAVAILABLE' ||
    message === 'SOURCE_UNAVAILABLE' ||
    message === 'UNSUPPORTED_OPERATION' ||
    message === 'INVALID_ARGUMENT' ||
    message === 'OPERATION_TIMEOUT' ||
    message === 'RECOVERY_PENDING' ||
    message === 'OPERATION_FAILED'
  ) {
    return message;
  }
  if (/unsafe|refus(?:e|ing)|protected/i.test(message)) return 'REQUEST_REJECTED';
  if (/unknown|non-writable|not present|no .*writer/i.test(message)) return 'TARGET_UNAVAILABLE';
  if (/not supported|unsupported/i.test(message)) return 'UNSUPPORTED_OPERATION';
  if (/provide|exactly one|invalid|usage|malformed/i.test(message)) return 'INVALID_ARGUMENT';
  if (/timed?\s*out|timeout/i.test(message)) return 'OPERATION_TIMEOUT';
  if (/recovery (?:is )?pending/i.test(message)) return 'RECOVERY_PENDING';
  return 'OPERATION_FAILED';
}

/** Stable reason classification shared by every public rollback face. */
export function publicRollbackReasonCode(
  reason: unknown,
):
  | 'TARGET_DIVERGED'
  | 'ALREADY_ABSENT'
  | 'UNVERIFIABLE_TARGET'
  | 'AUDIT_WRITE_FAILED'
  | 'OPERATION_WARNING'
  | undefined {
  if (typeof reason !== 'string' || reason.length === 0) return undefined;
  if (/audit log write failed/i.test(reason)) return 'AUDIT_WRITE_FAILED';
  if (/diverged/i.test(reason)) return 'TARGET_DIVERGED';
  if (/already absent/i.test(reason)) return 'ALREADY_ABSENT';
  if (/write-hash/i.test(reason)) return 'UNVERIFIABLE_TARGET';
  return 'OPERATION_WARNING';
}

function warningCode(value: string): string {
  if (/trust/i.test(value)) return 'TRUST_WARNING';
  if (/already|nothing|not installed/i.test(value)) return 'NO_CHANGE';
  if (/fleet\.lock|provenance/i.test(value)) return 'PROVENANCE_WARNING';
  if (/unsupported|not supported|only .* scope/i.test(value)) return 'TRANSLATION_WARNING';
  return 'OPERATION_WARNING';
}

function skipCode(kind: string, reason: string): string {
  if (kind === 'noop') return 'NO_CHANGE';
  if (kind === 'protected') return /trust/i.test(reason) ? 'TRUST_POLICY_BLOCKED' : 'PROTECTED_TARGET';
  return publicErrorCode(new Error(reason));
}

const PUBLIC_AGENT_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
const NON_PUBLIC_NAME_CHARACTERS = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;
const NON_PUBLIC_SCHEMES = new Set([
  'about',
  'blob',
  'data',
  'file',
  'ftp',
  'git',
  'javascript',
  'mailto',
  'nfs',
  'smb',
  'ssh',
  'urn',
  'vbscript',
  'vscode',
]);
const PUBLIC_CAPABILITY_KINDS = new Set<unknown>([
  'mcp-server',
  'skill',
  'rule',
  'permission',
  'plugin',
  'command',
  'hook',
  'subagent',
]);

export function isPublicAgentId(value: unknown): value is string {
  return typeof value === 'string' && PUBLIC_AGENT_ID.test(value);
}

/** Terminal controls and directional formatting characters are never safe in
 * public identities or remotely supplied filesystem paths. */
export function containsNonPublicControl(value: unknown): boolean {
  return typeof value === 'string' && NON_PUBLIC_NAME_CHARACTERS.test(value);
}

/** Detect local-coordinate shapes without trying to guess whether arbitrary
 * opaque text is secret. Covers absolute, drive-relative, dot-relative,
 * tilde-user, and common environment-variable path aliases. */
export function containsNonPublicLocalReference(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  return (
    /(?:^|[^\p{L}\p{N}])[/\\]/u.test(value) ||
    /(?:^|[^\p{L}\p{N}])[a-z]:(?:[/\\]|[^\s])/iu.test(value) ||
    /(?:^|[^\p{L}\p{N}])~[^/\\\s]*[/\\]/u.test(value) ||
    /(?:^|[^\p{L}\p{N}])\.[^/\\\s]*[/\\]/u.test(value) ||
    /(?:^|[^\p{L}\p{N}_])(?:\$(?:\{[a-z_][a-z0-9_]*\}|[a-z_][a-z0-9_]*)|%[a-z_][a-z0-9_]*%)[/\\]/iu.test(
      value,
    )
  );
}

export function isPublicCapabilityName(value: unknown): value is string {
  const scheme = typeof value === 'string' ? /^([a-z][a-z0-9+.-]*):(.*)$/i.exec(value) : null;
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 128 &&
    value.trim() === value &&
    !NON_PUBLIC_NAME_CHARACTERS.test(value) &&
    !containsNonPublicLocalReference(value) &&
    !/^[/\\]|^[a-z]:[/\\]/i.test(value) &&
    !/^~(?:[/\\]|$)|^\.[^/\\]*[/\\]|^[a-z]:/i.test(value) &&
    !/(?:^|[/\\])\.\.(?:[/\\]|$)/.test(value) &&
    !/(?:^|\s)(?:~[/\\]|[/\\]|[a-z]:[/\\])/i.test(value) &&
    !/^[a-z][a-z0-9+.-]*:[/\\]/i.test(value) &&
    !value.includes('://') &&
    !(scheme && NON_PUBLIC_SCHEMES.has(scheme[1]!.toLowerCase())) &&
    scrubSecrets(value) === value
  );
}

export function isPublicPrimitiveKind(value: unknown): value is PrimitiveKind {
  return PUBLIC_CAPABILITY_KINDS.has(value);
}

export function isPublicScope(value: unknown): value is Scope {
  return value === 'user' || value === 'project' || value === 'local';
}

export function publicConflictFindings(
  findings: Array<{ agent: unknown; a: unknown; b: unknown; axis: unknown }>,
): {
  findings: Array<{ agent: string; a: string; b: string; axis: 'verbosity' | 'autonomy' | 'tone' }>;
  withheldCount: number;
} {
  const allowedAxes = new Set(['verbosity', 'autonomy', 'tone']);
  const safe = findings.flatMap((finding) => {
    if (
      !isPublicAgentId(finding.agent) ||
      !isPublicCapabilityName(finding.a) ||
      !isPublicCapabilityName(finding.b) ||
      finding.a.includes('/') ||
      finding.a.includes('\\') ||
      finding.b.includes('/') ||
      finding.b.includes('\\') ||
      typeof finding.axis !== 'string' ||
      !allowedAxes.has(finding.axis)
    ) {
      return [];
    }
    return [
      {
        agent: finding.agent,
        a: finding.a,
        b: finding.b,
        axis: finding.axis as 'verbosity' | 'autonomy' | 'tone',
      },
    ];
  });
  return { findings: safe, withheldCount: findings.length - safe.length };
}

/** Inventory summary with NO secrets (env/headers/raw dropped; URL creds redacted). */
export function summarizeInventory(inv: Inventory) {
  const agents = inv.agents.filter((agent) => isPublicAgentId(agent.id));
  const agentIds = new Set(agents.map((agent) => agent.id));
  const publicItems = inv.items.filter(
    (item) =>
      agentIds.has(item.agent) &&
      isPublicPrimitiveKind(item.kind) &&
      isPublicScope(item.scope) &&
      typeof item.enabled === 'boolean' &&
      (item.kind === 'permission' || isPublicCapabilityName(item.name)),
  );
  const servers = publicItems
    .filter((i): i is McpServerCapability => i.kind === 'mcp-server')
    .map((i) => ({
      name: i.name,
      agent: i.agent,
      scope: i.scope,
      enabled: i.enabled,
      transport: ['stdio', 'http', 'sse', 'ws'].includes(i.spec.transport) ? i.spec.transport : 'unknown',
    }));
  const skills = publicItems
    .filter((i): i is SkillCapability => i.kind === 'skill')
    .map((i) => ({
      name: i.name,
      agent: i.agent,
      scope: i.scope,
      tokensEst:
        typeof i.tokensEst === 'number' && Number.isSafeInteger(i.tokensEst) && i.tokensEst >= 0
          ? i.tokensEst
          : undefined,
    }));
  const rules = publicItems
    .filter((i): i is RuleCapability => i.kind === 'rule')
    .map((i) => ({
      name: i.name,
      agent: i.agent,
      scope: i.scope,
      tokensEst:
        typeof i.tokensEst === 'number' && Number.isSafeInteger(i.tokensEst) && i.tokensEst >= 0
          ? i.tokensEst
          : undefined,
    }));
  const permissionCounts = new Map<string, { agent: string; effect: string; count: number }>();
  for (const item of publicItems.filter((i): i is PermissionCapability => i.kind === 'permission')) {
    // Claude permission "names" are full rule expressions (commands, paths,
    // arguments), not public logical identifiers. Only a fixed rule class and
    // count cross an AI boundary.
    const effect =
      item.effect === 'allow' || item.effect === 'deny' || item.effect === 'ask' || item.effect === 'policy'
        ? item.effect
        : 'other';
    const key = `${item.agent}\0${effect}`;
    const prior = permissionCounts.get(key);
    if (prior) prior.count++;
    else permissionCounts.set(key, { agent: item.agent, effect, count: 1 });
  }
  const permissions = [...permissionCounts.values()];
  const plugins = publicItems
    .filter((i): i is PluginCapability => i.kind === 'plugin')
    .map((i) => ({
      name: i.name,
      agent: i.agent,
      ...(typeof i.marketplace === 'string' && MARKETPLACE_RE.test(i.marketplace)
        ? { marketplace: i.marketplace }
        : {}),
      enabled: i.enabled === true,
    }));
  const subagents = publicItems
    .filter((i): i is SubagentCapability => i.kind === 'subagent')
    .map((i) => ({
      name: i.name,
      agent: i.agent,
      scope: i.scope,
      declaredToolCount: Array.isArray(i.tools) ? i.tools.length : undefined,
      modelDeclared: typeof i.model === 'string' && i.model.length > 0,
      tokensEst:
        typeof i.tokensEst === 'number' && Number.isSafeInteger(i.tokensEst) && i.tokensEst >= 0
          ? i.tokensEst
          : undefined,
    }));
  return scrubPublicValue({
    schemaVersion: PUBLIC_SCHEMA_VERSION,
    agents: agents.map((a) => ({
      id: a.id,
      present: a.present === true,
      runtimeStatus: ['available', 'not-found', 'unverifiable'].includes(String(a.runtimeStatus))
        ? a.runtimeStatus
        : 'unverifiable',
      configurationStatus: ['configured', 'not-configured', 'unavailable'].includes(
        String(a.configurationStatus),
      )
        ? a.configurationStatus
        : a.present
          ? 'configured'
          : 'not-configured',
      setupStatus: [
        'ready',
        'installed-unconfigured',
        'configured-runtime-missing',
        'configured-runtime-unverifiable',
        'not-detected',
        'detection-unavailable',
        'configuration-unavailable',
        'inventory-unavailable',
      ].includes(String(a.setupStatus))
        ? a.setupStatus
        : a.inventoryStatus === 'ok'
          ? 'configured-runtime-unverifiable'
          : a.inventoryStatus === 'not-present'
            ? 'not-detected'
            : 'inventory-unavailable',
      inventoryStatus: ['ok', 'not-present', 'detect-failed', 'read-failed'].includes(
        String(a.inventoryStatus),
      )
        ? a.inventoryStatus
        : 'read-failed',
    })),
    servers,
    skills,
    rules,
    permissions,
    plugins,
    subagents,
    withheldCount: inv.agents.length - agents.length + (inv.items.length - publicItems.length),
  });
}

export type ExecuteStatus =
  'preview' | 'applied' | 'partial' | 'nothing-to-do' | 'refused' | 'failed' | 'outcome-unknown';

function computeStatus(r: ExecuteResult): ExecuteStatus {
  if (r.recoveryPending) return 'outcome-unknown';
  if (r.error) return r.applied.length > 0 ? 'partial' : 'failed';
  if (!r.committed) {
    if (r.changes.length > 0) return 'preview';
    // a fully-blocked plan must SAY it was refused even in dry-run — otherwise
    // the user reads 'nothing-to-do' and never learns the gate fired
    if (r.skips.some((s) => s.kind === 'protected')) return 'refused';
    return 'nothing-to-do';
  }
  if (r.applied.length > 0) return 'applied';
  if (r.skips.some((s) => s.kind === 'error')) return 'failed';
  if (r.skips.some((s) => s.kind === 'protected')) return 'refused';
  return 'nothing-to-do';
}

/** Execute-result summary with safe metadata only (diffs/secrets dropped). */
export function summarizeResult(r: ExecuteResult) {
  const auditRecorded = r.applied.filter((result) => result.auditRecorded).length;
  const unrecordedApplied = r.applied.length - auditRecorded;
  const changes = r.changes.filter(
    (change) =>
      isPublicAgentId(change.agent) &&
      (change.op === 'install' || change.op === 'remove' || change.op === 'update') &&
      isPublicCapabilityName(change.name) &&
      isPublicScope(change.scope),
  );
  const skips = r.skips.filter(
    (skip) =>
      isPublicAgentId(skip.agent) &&
      (skip.kind === 'noop' || skip.kind === 'error' || skip.kind === 'protected'),
  );
  const records = r.applied.flatMap((result) => {
    const change = result.change;
    if (
      !isPublicAgentId(change.agent) ||
      !isPublicCapabilityName(change.name) ||
      !isPublicScope(change.scope) ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(result.auditId)
    ) {
      return [];
    }
    return [
      {
        agent: change.agent,
        kind: change.kind ?? 'mcp-server',
        name: change.name,
        scope: change.scope,
        op: change.op,
        auditRecorded: result.auditRecorded,
        ...(result.auditRecorded ? { auditId: result.auditId } : {}),
      },
    ];
  });
  return scrubPublicValue({
    status: computeStatus(r),
    committed: r.committed,
    applied: r.applied.length,
    auditRecorded,
    unrecordedApplied,
    records,
    changes: changes.map((c) => ({
      agent: c.agent,
      op: c.op,
      name: c.name,
      scope: c.scope,
      warningCodes: [...new Set((c.warnings ?? []).map(warningCode))],
    })),
    withheldChanges: r.changes.length - changes.length,
    skips: skips.map((skip) => ({
      agent: skip.agent,
      kind: skip.kind,
      reasonCode: skipCode(skip.kind, skip.reason),
    })),
    withheldSkips: r.skips.length - skips.length,
    ...(r.error
      ? {
          errorCode: r.recoveryPending
            ? 'RECOVERY_PENDING'
            : unrecordedApplied > 0
              ? 'AUDIT_WRITE_FAILED'
              : 'OPERATION_FAILED',
          failedAfter: r.failedAfter,
          ...(r.recoveryPending || unrecordedApplied > 0 ? { recoveryClass: 'manual-config-recovery' } : {}),
        }
      : {}),
    ...(r.lockWarning ? { lockWarningCode: 'PROVENANCE_WARNING' } : {}),
  });
}
