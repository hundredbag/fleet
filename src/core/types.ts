/**
 * Core domain types for fleet.
 *
 * v1 implements only the `mcp-server` primitive and read-only inventory.
 * `InstalledCapability` is a discriminated union on `kind` so that adding
 * skills/rules later gives callers correct per-kind `spec` typing for free,
 * and write-back can rely on the same shapes.
 */

/** Stable id for an agent runtime we can manage, e.g. 'claude-code'. */
export type AgentId = string;

/** Capability primitive kinds. v1 reads only 'mcp-server'. */
export type PrimitiveKind = 'mcp-server' | 'skill' | 'rule' | 'command' | 'hook' | 'subagent';

/** Where a capability is configured for an agent. */
export type Scope = 'user' | 'project' | 'local';

/** Structured spec for an MCP server (the v1 primitive). */
export type McpServerSpec =
  | {
      transport: 'stdio';
      command: string;
      args?: string[];
      /**
       * Environment variables. NOTE: values may be secrets. The human matrix
       * never prints them; `--json` emits them verbatim (see README).
       */
      env?: Record<string, string>;
    }
  | {
      transport: 'http' | 'sse' | 'ws';
      url: string;
      /** May contain secret values (e.g. Authorization). See env note above. */
      headers?: Record<string, string>;
      /**
       * Name of an env var holding a bearer token (not the token itself).
       * Read from Codex's `bearer_token_env_var`; rendered back per agent on
       * write (some agents can't express it — writers warn and degrade).
       */
      bearerTokenEnvVar?: string;
    };

/** Fields common to every installed capability, regardless of kind. */
export interface BaseCapability {
  /** logical key, e.g. the MCP server name */
  name: string;
  agent: AgentId;
  scope: Scope;
  enabled: boolean;
  /** provenance: where this was read from */
  source: { file: string; pointer?: string };
  /** original raw entry, preserved verbatim for lossless round-trip */
  raw?: unknown;
}

/** An MCP server found installed on one agent. */
export interface McpServerCapability extends BaseCapability {
  kind: 'mcp-server';
  spec: McpServerSpec;
}

/** A skill (a directory containing SKILL.md) installed on one agent. */
export interface SkillCapability extends BaseCapability {
  kind: 'skill';
  /** the skill's directory on disk */
  path: string;
  /** parsed from SKILL.md frontmatter */
  meta?: { description?: string; version?: string };
}

/**
 * A behavioral rule / instruction (a fleet-managed block inside an always-on
 * instruction file: Claude CLAUDE.md, Codex/Hermes AGENTS.md).
 */
export interface RuleCapability extends BaseCapability {
  kind: 'rule';
  /** the managed block body (the instruction text fleet manages) */
  body: string;
}

/**
 * A capability instance found installed on one agent. Discriminated on `kind`.
 */
export type InstalledCapability = McpServerCapability | SkillCapability | RuleCapability;

/**
 * Whether a capability is ALWAYS-ON (in context every turn — where opposing
 * intent genuinely conflicts) or GATED (invoked/loaded only when relevant —
 * rarely interferes). Drives the conflict analysis (Part C).
 */
export type Surface = 'gated' | 'always-on';

export function surfaceOf(kind: PrimitiveKind): Surface {
  // mcp tools + skills are gated; rules/instructions are always-on.
  return kind === 'rule' ? 'always-on' : 'gated';
}

/** An agent runtime detected (or not) on this machine. */
export interface DetectedAgent {
  id: AgentId;
  displayName: string;
  present: boolean;
  /** config files/dirs the adapter inspects (shown for transparency) */
  configPaths: string[];
  note?: string;
}

/** The unified, cross-agent inventory snapshot. */
export interface Inventory {
  agents: DetectedAgent[];
  items: InstalledCapability[];
}
