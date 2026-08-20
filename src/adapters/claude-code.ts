import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { lstat, readFile } from 'node:fs/promises';
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
import { asStringArray, asStringRecord, isPlainObject } from '../core/coerce.js';
import { readSkillsInventory, renderSkillInstall, renderSkillRemove } from '../core/skills.js';
import { readClaudeSubagents } from '../core/subagents.js';
import { readRulesInventory, renderRuleInstall, renderRuleRemove } from '../core/rules.js';
import { readClaudePermissionsStrict } from '../core/permissions.js';
import { readClaudePluginsStrict } from '../core/agent-plugins.js';
import {
  loadJsonDoc,
  getServers,
  renderJson,
  validateJsonObject,
  mergePreservingUnmanaged,
  MANAGED_JSON_KEYS,
} from '../core/json-config.js';
import { probeConfigurationPaths, probeExecutable } from '../core/detection.js';
import { assertWritableScope } from '../core/scope.js';

const CLAUDE_LABEL = 'claude-code';
const DEFAULT_CLAUDE_JSON = join(homedir(), '.claude.json');
const DEFAULT_CLAUDE_SKILLS = join(homedir(), '.claude', 'skills');
const DEFAULT_CLAUDE_RULES = join(homedir(), '.claude', 'CLAUDE.md');
const DEFAULT_CLAUDE_SETTINGS = join(homedir(), '.claude', 'settings.json');
const DEFAULT_CLAUDE_PLUGINS = join(homedir(), '.claude', 'plugins');

function isStringRecord(value: unknown): boolean {
  return isPlainObject(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function assertClaudeMcpEntry(value: unknown): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error('claude-code: MCP server entry is not an object');
  const type = value.type;
  if (
    type !== undefined &&
    type !== 'stdio' &&
    type !== 'http' &&
    type !== 'sse' &&
    type !== 'ws' &&
    type !== 'streamable-http'
  ) {
    throw new Error('claude-code: MCP server entry has an invalid transport');
  }
  if (type === 'http' || type === 'sse' || type === 'ws' || type === 'streamable-http') {
    if (typeof value.url !== 'string' || value.url.length === 0) {
      throw new Error('claude-code: remote MCP server entry has no URL');
    }
    if (value.headers !== undefined && !isStringRecord(value.headers)) {
      throw new Error('claude-code: remote MCP headers are invalid');
    }
    if (value.command !== undefined || value.args !== undefined || value.env !== undefined) {
      throw new Error('claude-code: remote MCP server entry contains stdio fields');
    }
    return;
  }
  if (typeof value.command !== 'string' || value.command.length === 0) {
    throw new Error('claude-code: stdio MCP server entry has no command');
  }
  if (
    value.args !== undefined &&
    (!Array.isArray(value.args) || !value.args.every((arg) => typeof arg === 'string'))
  ) {
    throw new Error('claude-code: stdio MCP args are invalid');
  }
  if (value.env !== undefined && !isStringRecord(value.env)) {
    throw new Error('claude-code: stdio MCP environment is invalid');
  }
  if (value.url !== undefined || value.headers !== undefined) {
    throw new Error('claude-code: stdio MCP server entry contains remote fields');
  }
}

function assertClaudeMcpServers(servers: Record<string, unknown>): void {
  for (const entry of Object.values(servers)) assertClaudeMcpEntry(entry);
}

function optionalMcpMap(value: unknown, label: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) throw new Error(`claude-code: ${label} is not an object`);
  return value;
}

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
  readonly contractVersion = 1;
  readonly id = 'claude-code';
  readonly displayName = 'Claude Code';
  readonly supportsWrite = true;
  readonly capabilitySupport = {
    'mcp-server': { inventory: 'supported', management: 'writable' },
    skill: { inventory: 'supported', management: 'writable' },
    rule: { inventory: 'supported', management: 'writable' },
    permission: { inventory: 'supported', management: 'read-only' },
    plugin: { inventory: 'supported', management: 'delegated' },
    command: { inventory: 'unsupported', management: 'none' },
    hook: { inventory: 'unsupported', management: 'none' },
    subagent: { inventory: 'supported', management: 'read-only' },
  } as const;

  constructor(
    private readonly claudeJsonPath: string = DEFAULT_CLAUDE_JSON,
    private readonly skillsDir: string = DEFAULT_CLAUDE_SKILLS,
    private readonly rulesPath: string = DEFAULT_CLAUDE_RULES,
    private readonly settingsPath: string = DEFAULT_CLAUDE_SETTINGS,
    private readonly pluginsDir: string = DEFAULT_CLAUDE_PLUGINS,
    private readonly executable: string = 'claude',
  ) {}

  async detect(): Promise<DetectedAgent> {
    const agentsDir = join(dirname(this.settingsPath), 'agents');
    const configuration = await probeConfigurationPaths([
      { path: this.claudeJsonPath, kind: 'file' },
      { path: this.skillsDir, kind: 'directory' },
      { path: this.rulesPath, kind: 'file' },
      { path: this.settingsPath, kind: 'file' },
      { path: this.pluginsDir, kind: 'directory' },
      { path: agentsDir, kind: 'directory' },
    ]);
    return {
      id: this.id,
      displayName: this.displayName,
      present: configuration.present,
      configPaths: [
        this.claudeJsonPath,
        '<project>/.mcp.json',
        this.skillsDir,
        this.rulesPath,
        this.settingsPath,
        this.pluginsDir,
        agentsDir,
      ],
      runtimeStatus: await probeExecutable(this.executable),
      configurationStatus: configuration.status,
      note: configuration.note,
    };
  }

  async readInventory(): Promise<InstalledCapability[]> {
    const items: InstalledCapability[] = [];

    const collect = (servers: Record<string, unknown> | undefined, scope: Scope, file: string) => {
      for (const [name, raw] of Object.entries(servers ?? {})) {
        assertClaudeMcpEntry(raw);
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
      items.push(
        ...(await readSkillsInventory(this.id, this.skillsDir, {
          allowedRoots: [join(homedir(), '.agents', 'skills')],
          strict: true,
        })),
      );
      items.push(...(await readRulesInventory(this.id, this.rulesPath)));
      items.push(...(await readClaudePermissionsStrict(this.id, this.settingsPath)));
      items.push(
        ...(await readClaudeSubagents(this.id, join(dirname(this.settingsPath), 'agents'), {
          strict: true,
        })),
      );
      items.push(...(await readClaudePluginsStrict(this.id, this.pluginsDir, this.settingsPath)));
      return items;
    }

    let data: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.claudeJsonPath, 'utf8'));
      if (!isPlainObject(parsed)) throw new Error('root is not an object');
      data = parsed;
    } catch {
      throw new Error(`claude-code: ${this.claudeJsonPath} is not valid JSON`);
    }

    collect(optionalMcpMap(data.mcpServers, 'mcpServers'), 'user', this.claudeJsonPath);

    // NOTE: only projects Claude already tracks are discoverable here — a
    // .mcp.json in a never-opened project won't be found (no FS scan in v0).
    const projects = optionalMcpMap(data.projects, 'projects');
    for (const [path, proj] of Object.entries(projects ?? {})) {
      if (!isPlainObject(proj)) throw new Error('claude-code: project configuration is not an object');
      collect(
        optionalMcpMap(proj.mcpServers, 'project mcpServers'),
        'local',
        `${this.claudeJsonPath} (projects[${path}])`,
      );
      const mcpFile = join(path, '.mcp.json');
      try {
        const info = await lstat(mcpFile);
        if (info.isSymbolicLink() || !info.isFile()) {
          throw new Error('unsafe tracked project MCP topology');
        }
        try {
          const parsed: unknown = JSON.parse(await readFile(mcpFile, 'utf8'));
          if (!isPlainObject(parsed)) throw new Error('project root is not an object');
          collect(optionalMcpMap(parsed.mcpServers, 'project mcpServers'), 'project', mcpFile);
        } catch {
          throw new Error(`claude-code: tracked project MCP configuration is unavailable or invalid`);
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new Error(`claude-code: tracked project MCP configuration is unavailable or invalid`);
        }
      }
    }
    items.push(
      ...(await readSkillsInventory(this.id, this.skillsDir, {
        allowedRoots: [join(homedir(), '.agents', 'skills')],
        strict: true,
      })),
    );
    items.push(...(await readRulesInventory(this.id, this.rulesPath)));
    items.push(...(await readClaudePermissionsStrict(this.id, this.settingsPath)));
    items.push(
      ...(await readClaudeSubagents(this.id, join(dirname(this.settingsPath), 'agents'), {
        strict: true,
      })),
    );
    items.push(...(await readClaudePluginsStrict(this.id, this.pluginsDir, this.settingsPath)));
    return items;
  }

  readPluginInventory() {
    return readClaudePluginsStrict(this.id, this.pluginsDir, this.settingsPath);
  }

  // --- SkillWriter (directory-shaped) ---

  async renderInstallSkill(source: SkillSource, ref: CapabilityRef): Promise<RenderResult> {
    assertWritableScope(ref.scope);
    return renderSkillInstall(this.skillsDir, source, ref);
  }

  async renderRemoveSkill(ref: CapabilityRef): Promise<RenderResult> {
    assertWritableScope(ref.scope);
    return renderSkillRemove(this.skillsDir, ref);
  }

  // --- RuleWriter (managed block in CLAUDE.md) ---

  async renderInstallRule(body: string, ref: CapabilityRef): Promise<RenderResult> {
    assertWritableScope(ref.scope);
    return renderRuleInstall(this.rulesPath, body, ref);
  }

  async renderRemoveRule(ref: CapabilityRef): Promise<RenderResult> {
    assertWritableScope(ref.scope);
    return renderRuleRemove(this.rulesPath, ref);
  }

  // --- AgentWriter (M2: user scope only) ---

  async renderInstall(spec: McpServerSpec, ref: CapabilityRef): Promise<RenderResult> {
    assertWritableScope(ref.scope);
    const warnings: string[] = [];
    if (spec.transport !== 'stdio' && spec.bearerTokenEnvVar) {
      warnings.push(`claude-code: no native env-var bearer token; set headers manually for "${ref.name}"`);
    }
    const { doc, text } = await loadJsonDoc(this.claudeJsonPath, CLAUDE_LABEL);
    const servers = getServers(doc, this.claudeJsonPath, CLAUDE_LABEL);
    assertClaudeMcpServers(servers);
    const before = servers[ref.name];
    const after = mergePreservingUnmanaged(before, toClaudeEntry(spec), MANAGED_JSON_KEYS);
    doc.mcpServers = { ...servers, [ref.name]: after };
    const r = renderJson(this.claudeJsonPath, doc, text, before, after, warnings);
    // canonical = what OUR reader will parse back (bearerTokenEnvVar drops etc.)
    return { ...r, canonical: parseMcpEntry(after) };
  }

  async renderRemove(ref: CapabilityRef): Promise<RenderResult> {
    assertWritableScope(ref.scope);
    if (!existsSync(this.claudeJsonPath)) {
      throw new Error(`claude-code: nothing to remove — config not found at ${this.claudeJsonPath}`);
    }
    const { doc, text } = await loadJsonDoc(this.claudeJsonPath, CLAUDE_LABEL);
    const servers = getServers(doc, this.claudeJsonPath, CLAUDE_LABEL);
    assertClaudeMcpServers(servers);
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
    const doc = JSON.parse(content) as Record<string, unknown>;
    assertClaudeMcpServers(optionalMcpMap(doc.mcpServers, 'mcpServers') ?? {});
  }
}
