import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type {
  AgentAdapter,
  AgentWriter,
  CapabilityRef,
  RenderResult,
} from '../core/adapter.js';
import type {
  DetectedAgent,
  InstalledCapability,
  McpServerSpec,
  Scope,
} from '../core/types.js';
import { asStringArray, asStringRecord, isPlainObject } from '../core/coerce.js';
import { sha256 } from '../core/hash.js';

/** Infer the file's existing JSON indentation so writes don't churn it. */
function detectIndent(text: string): string | number {
  const m = text.match(/\n([ \t]+)"/);
  if (!m) return 2;
  const ws = m[1] ?? '';
  return ws.includes('\t') ? '\t' : ws.length;
}

/** Render a normalized MCP spec into a Claude Code config entry. */
function toClaudeEntry(spec: McpServerSpec): Record<string, unknown> {
  if (spec.transport === 'stdio') {
    const entry: Record<string, unknown> = { command: spec.command };
    if (spec.args) entry.args = spec.args;
    if (spec.env) entry.env = spec.env;
    return entry;
  }
  const entry: Record<string, unknown> = { type: spec.transport, url: spec.url };
  if (spec.headers) entry.headers = spec.headers;
  return entry;
}

const DEFAULT_CLAUDE_JSON = join(homedir(), '.claude.json');

/**
 * Normalize a raw Claude Code MCP server entry into a structured spec.
 * stdio entries have no `type` (or `type: "stdio"`); remote entries carry
 * `type: "http" | "sse" | "ws"` (with `streamable-http` as an alias for http)
 * plus a `url`.
 */
export function parseMcpEntry(raw: unknown): McpServerSpec {
  const r = (raw ?? {}) as Record<string, unknown>;
  let type = typeof r.type === 'string' ? r.type : 'stdio';
  if (type === 'streamable-http') type = 'http';
  if (type === 'http' || type === 'sse' || type === 'ws') {
    return {
      transport: type,
      url: String(r.url ?? ''),
      headers: asStringRecord(r.headers),
    };
  }
  return {
    transport: 'stdio',
    command: String(r.command ?? ''),
    args: asStringArray(r.args),
    env: asStringRecord(r.env),
  };
}

export class ClaudeCodeAdapter implements AgentAdapter, AgentWriter {
  readonly id = 'claude-code';
  readonly displayName = 'Claude Code';
  readonly supportsWrite = true;

  constructor(private readonly claudeJsonPath: string = DEFAULT_CLAUDE_JSON) {}

  async detect(): Promise<DetectedAgent> {
    return {
      id: this.id,
      displayName: this.displayName,
      present: existsSync(this.claudeJsonPath),
      configPaths: [this.claudeJsonPath, '<project>/.mcp.json'],
    };
  }

  async readInventory(): Promise<InstalledCapability[]> {
    if (!existsSync(this.claudeJsonPath)) return [];
    const data = JSON.parse(await readFile(this.claudeJsonPath, 'utf8')) as {
      mcpServers?: Record<string, unknown>;
      projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
    };
    const items: InstalledCapability[] = [];

    const collect = (
      servers: Record<string, unknown> | undefined,
      scope: Scope,
      file: string,
    ) => {
      for (const [name, raw] of Object.entries(servers ?? {})) {
        items.push({
          kind: 'mcp-server',
          name,
          agent: this.id,
          scope,
          // NOTE: Claude's enable/approval state lives in settings.json arrays
          // (enabled/disabledMcpjsonServers); not read yet — deriving it is M2.
          enabled: true,
          spec: parseMcpEntry(raw),
          source: { file },
          raw,
        });
      }
    };

    // user scope (global)
    collect(data.mcpServers, 'user', this.claudeJsonPath);

    // per-project entries recorded inside ~/.claude.json + on-disk .mcp.json.
    // NOTE: only projects Claude already tracks are discoverable here — a
    // .mcp.json in a never-opened project won't be found (no FS scan in v0).
    for (const [path, proj] of Object.entries(data.projects ?? {})) {
      collect(proj?.mcpServers, 'local', `${this.claudeJsonPath} (projects[${path}])`);
      const mcpFile = join(path, '.mcp.json');
      if (existsSync(mcpFile)) {
        try {
          const pj = JSON.parse(await readFile(mcpFile, 'utf8')) as {
            mcpServers?: Record<string, unknown>;
          };
          collect(pj.mcpServers, 'project', mcpFile);
        } catch {
          /* ignore malformed project .mcp.json */
        }
      }
    }
    return items;
  }

  // --- AgentWriter (M2 Part 1: user scope only) ---

  /** Read + validate the config doc, returning its raw text for hashing/indent. */
  private async loadDoc(): Promise<{ doc: Record<string, unknown>; text?: string }> {
    if (!existsSync(this.claudeJsonPath)) return { doc: {} };
    const text = await readFile(this.claudeJsonPath, 'utf8');
    const parsed: unknown = JSON.parse(text);
    if (!isPlainObject(parsed)) {
      throw new Error(`claude-code: ${this.claudeJsonPath} is not a JSON object`);
    }
    return { doc: parsed, text };
  }

  private serversOf(doc: Record<string, unknown>): Record<string, unknown> {
    const servers = doc.mcpServers;
    if (servers !== undefined && !isPlainObject(servers)) {
      throw new Error(`claude-code: "mcpServers" in ${this.claudeJsonPath} is not an object`);
    }
    return (servers ?? {}) as Record<string, unknown>;
  }

  private render(
    doc: Record<string, unknown>,
    text: string | undefined,
    before: unknown,
    after: unknown,
    warnings: string[],
  ): RenderResult {
    const indent = text ? detectIndent(text) : 2;
    return {
      file: this.claudeJsonPath,
      newContent: JSON.stringify(doc, null, indent) + '\n',
      before,
      after,
      baseHash: text ? sha256(text) : undefined,
      warnings: warnings.length ? warnings : undefined,
    };
  }

  async renderInstall(spec: McpServerSpec, ref: CapabilityRef): Promise<RenderResult> {
    const warnings: string[] = [];
    if (ref.scope !== 'user') {
      warnings.push(`claude-code: only 'user' scope is supported in M2 (got '${ref.scope}')`);
    }
    if (spec.transport !== 'stdio' && spec.bearerTokenEnvVar) {
      warnings.push(
        `claude-code: no native env-var bearer token; set headers manually for "${ref.name}"`,
      );
    }
    const { doc, text } = await this.loadDoc();
    const servers = this.serversOf(doc);
    const before = servers[ref.name];
    const after = toClaudeEntry(spec);
    doc.mcpServers = { ...servers, [ref.name]: after };
    return this.render(doc, text, before, after, warnings);
  }

  async renderRemove(ref: CapabilityRef): Promise<RenderResult> {
    const { doc, text } = await this.loadDoc();
    const servers = this.serversOf(doc);
    const before = servers[ref.name];
    const warnings: string[] = [];
    if (before === undefined) warnings.push(`claude-code: "${ref.name}" is not installed`);
    const next = { ...servers };
    delete next[ref.name];
    doc.mcpServers = next;
    return this.render(doc, text, before, undefined, warnings);
  }

  validate(content: string): void {
    const parsed: unknown = JSON.parse(content);
    if (!isPlainObject(parsed)) {
      throw new Error('claude-code: config is not a JSON object');
    }
  }
}
