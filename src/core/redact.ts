import type {
  Inventory,
  McpServerCapability,
  PermissionCapability,
  PluginCapability,
  RuleCapability,
  SkillCapability,
} from './types.js';
import type { ExecuteResult } from './orchestrator.js';

/**
 * Secret-redaction + summary helpers shared by every AI/human-facing surface
 * (MCP tools, web dashboard). These define the security boundary: raw inventory
 * (env/headers/raw/url-creds) must never cross to an AI or a browser.
 */

const SECRET_QUERY_KEY = /(token|key|secret|auth|sig|password|pwd|access|credential|session|bearer)/i;

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
const SECRET_TEXT_PATTERNS: RegExp[] = [
  /:\/\/[^/\s@]+@/g, // URL userinfo
  /\b(api[_-]?key|token|secret|password|passwd|authorization|bearer)\b(\s*[=:]\s*)\S+/gi, // key=value
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\b/g, // JWT
  /\bsk-[A-Za-z0-9_-]{20,}\b/g, // OpenAI-style keys
  /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, // GitHub tokens
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key ids
];

export function scrubSecrets(text: string): string {
  let out = text;
  out = out.replace(SECRET_TEXT_PATTERNS[0]!, '://REDACTED@');
  out = out.replace(SECRET_TEXT_PATTERNS[1]!, '$1$2REDACTED');
  for (const re of SECRET_TEXT_PATTERNS.slice(2)) out = out.replace(re, 'REDACTED');
  return out;
}

/** Inventory summary with NO secrets (env/headers/raw dropped; URL creds redacted). */
export function summarizeInventory(inv: Inventory) {
  const servers = inv.items
    .filter((i): i is McpServerCapability => i.kind === 'mcp-server')
    .map((i) => ({
      name: i.name,
      agent: i.agent,
      scope: i.scope,
      enabled: i.enabled,
      transport: i.spec.transport,
      target: i.spec.transport === 'stdio' ? i.spec.command : redactUrl(i.spec.url),
    }));
  const skills = inv.items
    .filter((i): i is SkillCapability => i.kind === 'skill')
    .map((i) => ({
      name: i.name,
      agent: i.agent,
      scope: i.scope,
      description: i.meta?.description,
      version: i.meta?.version,
    }));
  const rules = inv.items
    .filter((i): i is RuleCapability => i.kind === 'rule')
    .map((i) => ({ name: i.name, agent: i.agent, scope: i.scope }));
  const permissions = inv.items
    .filter((i): i is PermissionCapability => i.kind === 'permission')
    .map((i) => ({ name: i.name, agent: i.agent, effect: i.effect }));
  const plugins = inv.items
    .filter((i): i is PluginCapability => i.kind === 'plugin')
    .map((i) => ({ name: i.name, agent: i.agent, marketplace: i.marketplace, description: i.description }));
  return {
    agents: inv.agents.map((a) => ({ id: a.id, present: a.present, note: a.note })),
    servers,
    skills,
    rules,
    permissions,
    plugins,
  };
}

export type ExecuteStatus = 'preview' | 'applied' | 'nothing-to-do' | 'refused' | 'failed';

function computeStatus(r: ExecuteResult): ExecuteStatus {
  if (r.error) return 'failed';
  if (!r.committed) return r.changes.length > 0 ? 'preview' : 'nothing-to-do';
  if (r.applied.length > 0) return 'applied';
  if (r.skips.some((s) => s.kind === 'error')) return 'failed';
  if (r.skips.some((s) => s.kind === 'protected')) return 'refused';
  return 'nothing-to-do';
}

/** Execute-result summary with safe metadata only (diffs/secrets dropped). */
export function summarizeResult(r: ExecuteResult) {
  return {
    status: computeStatus(r),
    committed: r.committed,
    applied: r.applied.length,
    changes: r.changes.map((c) => ({
      agent: c.agent,
      op: c.op,
      name: c.name,
      scope: c.scope,
      file: c.file,
      warnings: c.warnings,
    })),
    skips: r.skips,
    ...(r.error ? { error: r.error, failedAfter: r.failedAfter } : {}),
  };
}
