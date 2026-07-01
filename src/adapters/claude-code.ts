import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type {
  AgentAdapter,
  AgentWriter,
  CapabilityRef,
  RenderResult,
  RuleWriter,
  SkillSource,
  SkillWriter,
} from '../core/adapter.js';
import type { DetectedAgent, InstalledCapability, McpServerSpec, Scope } from '../core/types.js';
import { asStringArray, asStringRecord } from '../core/coerce.js';
import { readSkillsInventory, renderSkillInstall, renderSkillRemove } from '../core/skills.js';
import { readRulesInventory, renderRuleInstall, renderRuleRemove } from '../core/rules.js';
import { readClaudePermissions } from '../core/permissions.js';
import {
  loadJsonDoc,
  getServers,
  renderJson,
  validateJsonObject,
  mergePreservingUnmanaged,
  MANAGED_JSON_KEYS,
} from '../core/json-config.js';

const CLAUDE_LABEL = 'claude-code';
const DEFAULT_CLAUDE_JSON = join(homedir(), '.claude.json');
const DEFAULT_CLAUDE_SKILLS = join(homedir(), '.claude', 'skills');
const DEFAULT_CLAUDE_RULES = join(homedir(), '.claude', 'CLAUDE.md');
const DEFAULT_CLAUDE_SETTINGS = join(homedir(), '.claude', 'settings.json');

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

export class ClaudeCodeAdapter implements AgentAdapter, AgentWriter, SkillWriter, RuleWriter {
  readonly id = 'claude-code';
  readonly displayName = 'Claude Code';
  readonly supportsWrite = true;

  constructor(
    private readonly claudeJsonPath: string = DEFAULT_CLAUDE_JSON,
    private readonly skillsDir: string = DEFAULT_CLAUDE_SKILLS,
    private readonly rulesPath: string = DEFAULT_CLAUDE_RULES,
    private readonly settingsPath: string = DEFAULT_CLAUDE_SETTINGS,
  ) {}

  async detect(): Promise<DetectedAgent> {
    return {
      id: this.id,
      displayName: this.displayName,
      present: existsSync(this.claudeJsonPath) || existsSync(this.skillsDir),
      configPaths: [this.claudeJsonPath, '<project>/.mcp.json', this.skillsDir],
    };
  }

  async readInventory(): Promise<InstalledCapability[]> {
    const items: InstalledCapability[] = [];

    const collect = (servers: Record<string, unknown> | undefined, scope: Scope, file: string) => {
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

    if (!existsSync(this.claudeJsonPath)) {
      items.push(...(await readSkillsInventory(this.id, this.skillsDir)));
      items.push(...(await readRulesInventory(this.id, this.rulesPath)));
      items.push(...(await readClaudePermissions(this.id, this.settingsPath)));
      return items;
    }

    let data: {
      mcpServers?: Record<string, unknown>;
      projects?: Record<string, { mcpServers?: Record<string, unknown> }>;
    };
    try {
      data = JSON.parse(await readFile(this.claudeJsonPath, 'utf8'));
    } catch {
      throw new Error(`claude-code: ${this.claudeJsonPath} is not valid JSON`);
    }

    collect(data.mcpServers, 'user', this.claudeJsonPath);

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
    items.push(...(await readSkillsInventory(this.id, this.skillsDir)));
    items.push(...(await readRulesInventory(this.id, this.rulesPath)));
    items.push(...(await readClaudePermissions(this.id, this.settingsPath)));
    return items;
  }

  // --- SkillWriter (directory-shaped) ---

  renderInstallSkill(source: SkillSource, ref: CapabilityRef): Promise<RenderResult> {
    return renderSkillInstall(this.skillsDir, source, ref);
  }

  renderRemoveSkill(ref: CapabilityRef): Promise<RenderResult> {
    return renderSkillRemove(this.skillsDir, ref);
  }

  // --- RuleWriter (managed block in CLAUDE.md) ---

  renderInstallRule(body: string, ref: CapabilityRef): Promise<RenderResult> {
    return renderRuleInstall(this.rulesPath, body, ref);
  }

  renderRemoveRule(ref: CapabilityRef): Promise<RenderResult> {
    return renderRuleRemove(this.rulesPath, ref);
  }

  // --- AgentWriter (M2: user scope only) ---

  async renderInstall(spec: McpServerSpec, ref: CapabilityRef): Promise<RenderResult> {
    const warnings: string[] = [];
    if (ref.scope !== 'user') {
      warnings.push(`claude-code: only 'user' scope is supported in M2 (got '${ref.scope}')`);
    }
    if (spec.transport !== 'stdio' && spec.bearerTokenEnvVar) {
      warnings.push(`claude-code: no native env-var bearer token; set headers manually for "${ref.name}"`);
    }
    const { doc, text } = await loadJsonDoc(this.claudeJsonPath, CLAUDE_LABEL);
    const servers = getServers(doc, this.claudeJsonPath, CLAUDE_LABEL);
    const before = servers[ref.name];
    const after = mergePreservingUnmanaged(before, toClaudeEntry(spec), MANAGED_JSON_KEYS);
    doc.mcpServers = { ...servers, [ref.name]: after };
    return renderJson(this.claudeJsonPath, doc, text, before, after, warnings);
  }

  async renderRemove(ref: CapabilityRef): Promise<RenderResult> {
    if (!existsSync(this.claudeJsonPath)) {
      throw new Error(`claude-code: nothing to remove — config not found at ${this.claudeJsonPath}`);
    }
    const { doc, text } = await loadJsonDoc(this.claudeJsonPath, CLAUDE_LABEL);
    const servers = getServers(doc, this.claudeJsonPath, CLAUDE_LABEL);
    const before = servers[ref.name];
    const warnings: string[] = [];
    if (before === undefined) warnings.push(`claude-code: "${ref.name}" is not installed`);
    const next = { ...servers };
    delete next[ref.name];
    doc.mcpServers = next;
    return renderJson(this.claudeJsonPath, doc, text, before, undefined, warnings);
  }

  validate(content: string): void {
    validateJsonObject(content, CLAUDE_LABEL);
  }
}
