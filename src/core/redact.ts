import type { Inventory, McpServerCapability, RuleCapability, SkillCapability } from './types.js';
import type { ExecuteResult } from './orchestrator.js';

/**
 * Secret-redaction + summary helpers shared by every AI/human-facing surface
 * (MCP tools, web dashboard). These define the security boundary: raw inventory
 * (env/headers/raw/url-creds) must never cross to an AI or a browser.
 */

const SECRET_QUERY_KEY = /(token|key|secret|auth|sig|password|pwd|access)/i;

/** Strip credentials embedded in a URL (userinfo + sensitive query params). */
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
    return u.toString();
  } catch {
    return url;
  }
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
  return {
    agents: inv.agents.map((a) => ({ id: a.id, present: a.present, note: a.note })),
    servers,
    skills,
    rules,
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
