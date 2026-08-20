import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { readFile, realpath } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { parse as parseToml } from 'smol-toml';
import type {
  AgentAdapter,
  AgentWriter,
  CapabilityRef,
  RenderResult,
  RuleWriter,
  SkillSource,
  SkillWriter,
} from '../core/adapter.js';
import type { DetectedAgent, InstalledCapability, McpServerSpec } from '../core/types.js';
import { asStringArray, asStringRecord, isPlainObject } from '../core/coerce.js';
import { sha256 } from '../core/hash.js';
import { listSkillDirs, readSkillsInventory, renderSkillInstall, renderSkillRemove } from '../core/skills.js';
import { readRulesInventory, renderRuleInstall, renderRuleRemove } from '../core/rules.js';
import { readCodexPermissionsStrict } from '../core/permissions.js';
import { readCodexSubagents } from '../core/subagents.js';
import { probeConfigurationPaths, probeExecutable } from '../core/detection.js';
import { assertWritableScope } from '../core/scope.js';

const DEFAULT_CODEX_TOML = join(homedir(), '.codex', 'config.toml');
const DEFAULT_CODEX_SKILLS = join(homedir(), '.codex', 'skills');
const DEFAULT_CODEX_RULES = join(homedir(), '.codex', 'AGENTS.md');

function isStringRecord(value: unknown): boolean {
  return isPlainObject(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function assertCodexMcpEntry(value: unknown): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error('codex: MCP server entry is not an object');
  const nested = value.transport;
  if (nested !== undefined && !isPlainObject(nested)) {
    throw new Error('codex: MCP transport is invalid');
  }
  if (isPlainObject(nested)) {
    if (nested.type !== 'streamable_http') {
      throw new Error('codex: MCP transport type is invalid');
    }
    if (typeof nested.url !== 'string' || nested.url.length === 0) {
      throw new Error('codex: MCP transport URL is invalid');
    }
    if (value.url !== undefined) throw new Error('codex: MCP URL is ambiguous');
  }
  const url = value.url ?? (isPlainObject(nested) ? nested.url : undefined);
  if (url !== undefined) {
    if (typeof url !== 'string' || url.length === 0) throw new Error('codex: MCP URL is invalid');
    if (value.command !== undefined || value.args !== undefined || value.env !== undefined) {
      throw new Error('codex: MCP transport is ambiguous');
    }
  } else if (typeof value.command !== 'string' || value.command.length === 0) {
    throw new Error('codex: stdio MCP server entry has no command');
  } else if (value.http_headers !== undefined || value.bearer_token_env_var !== undefined) {
    throw new Error('codex: stdio MCP server entry contains remote fields');
  }
  if (
    value.args !== undefined &&
    (!Array.isArray(value.args) || !value.args.every((arg) => typeof arg === 'string'))
  ) {
    throw new Error('codex: MCP args are invalid');
  }
  if (value.env !== undefined && !isStringRecord(value.env)) {
    throw new Error('codex: MCP environment is invalid');
  }
  if (value.http_headers !== undefined && !isStringRecord(value.http_headers)) {
    throw new Error('codex: MCP headers are invalid');
  }
  if (value.bearer_token_env_var !== undefined && typeof value.bearer_token_env_var !== 'string') {
    throw new Error('codex: bearer token environment variable is invalid');
  }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    throw new Error('codex: MCP enabled state is invalid');
  }
}

function parseCodexServers(text: string, path: string): Record<string, unknown> {
  let parsed: Record<string, unknown>;
  try {
    parsed = parseToml(text) as Record<string, unknown>;
  } catch {
    throw new Error(`codex: ${path} is not valid TOML`);
  }
  if (parsed.mcp_servers !== undefined && !isPlainObject(parsed.mcp_servers)) {
    throw new Error('codex: mcp_servers is not an object');
  }
  for (const key of ['approval_policy', 'sandbox_mode']) {
    const value = parsed[key];
    if (value !== undefined && (typeof value !== 'string' || value.length === 0)) {
      throw new Error(`codex: ${key} is invalid`);
    }
  }
  const servers = parsed.mcp_servers ?? {};
  for (const entry of Object.values(servers)) assertCodexMcpEntry(entry);
  return servers;
}

/**
 * Codex declares MCP servers under `[mcp_servers.<name>]` in config.toml.
 * Remote servers use streamable HTTP only (no SSE), keyed by `url` (flat) or a
 * nested `transport = { type = "streamable_http", url = ... }` table. Auth lives
 * in `bearer_token_env_var` / `http_headers`.
 */
export function parseCodexEntry(raw: unknown): McpServerSpec {
  const r = (raw ?? {}) as Record<string, unknown>;
  const nested = (r.transport ?? {}) as Record<string, unknown>;
  const url = r.url ?? nested.url;
  if (url) {
    return {
      transport: 'http',
      url: String(url),
      headers: asStringRecord(r.http_headers),
      bearerTokenEnvVar: typeof r.bearer_token_env_var === 'string' ? r.bearer_token_env_var : undefined,
    };
  }
  return {
    transport: 'stdio',
    command: String(r.command ?? ''),
    args: asStringArray(r.args),
    env: asStringRecord(r.env),
  };
}

// --- TOML serialization (textual, comment-preserving edits) ---

const BARE_KEY = /^[A-Za-z0-9_-]+$/;
// JSON.stringify yields a valid TOML basic string for normal values; TOML also
// requires escaping U+007F (DEL), which JSON does not.
const tomlStr = (s: string): string => JSON.stringify(s).replace(/\u007f/g, '\\u007F');
const tomlKey = (k: string): string => (BARE_KEY.test(k) ? k : JSON.stringify(k));
const tomlArray = (a: string[]): string => `[${a.map(tomlStr).join(', ')}]`;
const tomlInline = (o: Record<string, string>): string =>
  `{ ${Object.entries(o)
    .map(([k, v]) => `${tomlKey(k)} = ${tomlStr(v)}`)
    .join(', ')} }`;

/** Serialize an arbitrary parsed-TOML value back to TOML (for preserved keys). */
function tomlValue(v: unknown): string {
  if (typeof v === 'string') return tomlStr(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : tomlStr(String(v));
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(', ')}]`;
  if (v && typeof v === 'object') {
    return `{ ${Object.entries(v as Record<string, unknown>)
      .map(([k, val]) => `${tomlKey(k)} = ${tomlValue(val)}`)
      .join(', ')} }`;
  }
  return tomlStr(String(v));
}

/** Keys fleet manages on a Codex server table; everything else is preserved. */
const MANAGED_CODEX = new Set([
  'command',
  'args',
  'env',
  'url',
  'bearer_token_env_var',
  'http_headers',
  'transport',
]);

/** Render a `[mcp_servers.<name>]` table block from a spec (+ preserved keys). */
function serializeCodexTable(
  name: string,
  spec: McpServerSpec,
  extras: Record<string, unknown> = {},
): string {
  const header = BARE_KEY.test(name) ? name : JSON.stringify(name);
  const lines = [`[mcp_servers.${header}]`];
  if (spec.transport === 'stdio') {
    lines.push(`command = ${tomlStr(spec.command)}`);
    if (spec.args?.length) lines.push(`args = ${tomlArray(spec.args)}`);
    if (spec.env && Object.keys(spec.env).length) lines.push(`env = ${tomlInline(spec.env)}`);
  } else {
    lines.push(`url = ${tomlStr(spec.url)}`);
    if (spec.bearerTokenEnvVar) {
      lines.push(`bearer_token_env_var = ${tomlStr(spec.bearerTokenEnvVar)}`);
    }
    if (spec.headers && Object.keys(spec.headers).length) {
      lines.push(`http_headers = ${tomlInline(spec.headers)}`);
    }
  }
  // Preserve keys fleet doesn't model (enabled, cwd, env_vars, timeouts, …).
  for (const [k, v] of Object.entries(extras)) lines.push(`${tomlKey(k)} = ${tomlValue(v)}`);
  return lines.join('\n');
}

/** The dotted path of a TOML table header line (allowing a trailing comment),
 * or null. Quotes stripped. */
function tableHeaderPath(line: string): string | null {
  const m = line.match(/^\s*\[([^\]]+)\]\s*(?:#.*)?$/);
  return m ? m[1]!.trim().replace(/"/g, '') : null;
}

/** Pull `end` back over trailing blank/comment lines so they stay attached to
 * the following table (not the one being edited). */
function trimTrailing(lines: string[], start: number, end: number): number {
  let e = end;
  while (e - 1 > start) {
    const l = lines[e - 1]!.trim();
    if (l === '' || l.startsWith('#')) e--;
    else break;
  }
  return e;
}

/**
 * Find the line range [start, end) of the `[mcp_servers.<name>]` table,
 * including its sub-tables, stopping at the next unrelated table header.
 */
function findTableBlock(lines: string[], name: string): { start: number; end: number } | null {
  const target = `mcp_servers.${name}`;
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const path = tableHeaderPath(lines[i]!);
    if (path === null) continue;
    if (start === -1) {
      if (path === target) start = i;
    } else if (path !== target && !path.startsWith(target + '.')) {
      return { start, end: trimTrailing(lines, start, i) };
    }
  }
  return start === -1 ? null : { start, end: trimTrailing(lines, start, lines.length) };
}

export class CodexAdapter implements AgentAdapter, AgentWriter, SkillWriter, RuleWriter {
  readonly contractVersion = 1;
  readonly id = 'codex';
  readonly displayName = 'OpenAI Codex';
  readonly supportsWrite = true;
  readonly capabilitySupport = {
    'mcp-server': { inventory: 'supported', management: 'writable' },
    skill: { inventory: 'supported', management: 'writable' },
    rule: { inventory: 'supported', management: 'writable' },
    permission: { inventory: 'supported', management: 'read-only' },
    // The current CLI exposes `plugin list --json`, but Fleet has not yet
    // adopted and contract-tested that schema. A directory-name scan is not
    // authoritative installed state, so do not advertise or mutate from it.
    plugin: { inventory: 'unverifiable', management: 'delegated' },
    command: { inventory: 'unsupported', management: 'none' },
    hook: { inventory: 'unsupported', management: 'none' },
    subagent: { inventory: 'supported', management: 'read-only' },
  } as const;

  constructor(
    private readonly configPath: string = DEFAULT_CODEX_TOML,
    private readonly skillsDir: string = DEFAULT_CODEX_SKILLS,
    private readonly rulesPath: string = DEFAULT_CODEX_RULES,
    /** the cross-agent shared skills root Codex reads natively (agentskills.io
     * convention; where `npx skills add` installs) */
    private readonly sharedSkillsDir: string = join(homedir(), '.agents', 'skills'),
    private readonly executable: string = 'codex',
  ) {}

  async detect(): Promise<DetectedAgent> {
    const agentsDir = join(dirname(this.configPath), 'agents');
    const configuration = await probeConfigurationPaths([
      { path: this.configPath, kind: 'file' },
      { path: this.skillsDir, kind: 'directory' },
      { path: this.rulesPath, kind: 'file' },
      // A populated native shared root is configuration evidence, but the
      // conventional directory may exist while containing no Codex capability.
      { path: this.sharedSkillsDir, kind: 'directory', countsAsPresent: false },
      { path: agentsDir, kind: 'directory' },
    ]);
    let present = configuration.present;
    let configurationStatus = configuration.status;
    let note = configuration.note;
    if (!present && configurationStatus !== 'unavailable') {
      try {
        present = (await listSkillDirs(this.sharedSkillsDir, { strict: true })).length > 0;
        if (present) configurationStatus = 'configured';
      } catch {
        configurationStatus = 'unavailable';
        note = 'the shared skill inventory cannot be inspected';
      }
    }
    return {
      id: this.id,
      displayName: this.displayName,
      present,
      configPaths: [this.configPath, this.skillsDir, this.rulesPath, this.sharedSkillsDir, agentsDir],
      runtimeStatus: await probeExecutable(this.executable),
      configurationStatus,
      note,
    };
  }

  async readInventory(): Promise<InstalledCapability[]> {
    const items: InstalledCapability[] = [];
    if (existsSync(this.configPath)) {
      const servers = parseCodexServers(await readFile(this.configPath, 'utf8'), this.configPath);
      for (const [name, raw] of Object.entries(servers)) {
        const r = (raw ?? {}) as Record<string, unknown>;
        items.push({
          kind: 'mcp-server',
          name,
          agent: this.id,
          scope: 'user',
          enabled: r.enabled !== false,
          spec: parseCodexEntry(raw),
          source: { file: this.configPath },
          raw,
        });
      }
    }
    const ownSkills = await readSkillsInventory(this.id, this.skillsDir, {
      allowedRoots: [this.sharedSkillsDir],
      strict: true,
    });
    items.push(...ownSkills);
    // shared ~/.agents/skills root (read natively by Codex) — own dir wins on
    // a name collision so fleet-managed installs stay authoritative; also
    // dedupe by PHYSICAL identity (an own link b → shared/a/b is one skill)
    const ownNames = new Set(ownSkills.map((s) => s.name));
    const ownReal = new Set<string>();
    for (const sk of ownSkills) {
      try {
        ownReal.add(await realpath(sk.path));
      } catch {
        /* dangling */
      }
    }
    const shared = await readSkillsInventory(this.id, this.sharedSkillsDir, { strict: true });
    for (const sk of shared) {
      if (ownNames.has(sk.name)) continue;
      try {
        if (ownReal.has(await realpath(sk.path))) continue;
      } catch {
        /* keep */
      }
      items.push(sk);
    }
    items.push(...(await readRulesInventory(this.id, this.rulesPath)));
    items.push(...(await readCodexPermissionsStrict(this.id, this.configPath)));
    items.push(
      ...(await readCodexSubagents(this.id, join(dirname(this.configPath), 'agents'), { strict: true })),
    );
    return items;
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

  // --- RuleWriter (managed block in AGENTS.md) ---

  async renderInstallRule(body: string, ref: CapabilityRef): Promise<RenderResult> {
    assertWritableScope(ref.scope);
    return renderRuleInstall(this.rulesPath, body, ref);
  }

  async renderRemoveRule(ref: CapabilityRef): Promise<RenderResult> {
    assertWritableScope(ref.scope);
    return renderRuleRemove(this.rulesPath, ref);
  }

  // --- AgentWriter (TOML, comment-preserving) ---

  private async readText(): Promise<string | undefined> {
    return existsSync(this.configPath) ? readFile(this.configPath, 'utf8') : undefined;
  }

  private guardTransport(spec: McpServerSpec): void {
    if (spec.transport === 'sse' || spec.transport === 'ws') {
      throw new Error(
        `codex: transport '${spec.transport}' is not supported (stdio or streamable http only)`,
      );
    }
  }

  async renderInstall(spec: McpServerSpec, ref: CapabilityRef): Promise<RenderResult> {
    assertWritableScope(ref.scope);
    this.guardTransport(spec);
    const warnings: string[] = [];
    const text = await this.readText();

    // preserve keys fleet doesn't model on the existing server (enabled, cwd, …)
    const extras: Record<string, unknown> = {};
    if (text !== undefined) {
      const existing = parseCodexServers(text, this.configPath)[ref.name];
      if (isPlainObject(existing)) {
        for (const [k, v] of Object.entries(existing)) {
          if (!MANAGED_CODEX.has(k)) extras[k] = v;
        }
      }
    }
    const block = serializeCodexTable(ref.name, spec, extras);

    let newContent: string;
    let before: unknown;
    if (text === undefined) {
      newContent = block + '\n';
    } else {
      const lines = text.split('\n');
      const range = findTableBlock(lines, ref.name);
      if (range) {
        before = lines.slice(range.start, range.end).join('\n');
        // Replace in place WITHOUT adding a separator line — trimTrailing left
        // any existing blank lines after the block, so this stays idempotent.
        lines.splice(range.start, range.end - range.start, ...block.split('\n'));
        newContent = lines.join('\n');
      } else {
        const sep = text.endsWith('\n') ? '' : '\n';
        newContent = `${text}${sep}\n${block}\n`;
      }
    }
    // canonical = OUR reader's parse of the exact block we wrote (empty
    // args/env/headers are elided by TOML serialization — round-trip captures it)
    const parsedBack = (parseToml(block) as { mcp_servers?: Record<string, unknown> }).mcp_servers?.[
      ref.name
    ];
    return {
      file: this.configPath,
      newContent,
      before,
      after: block,
      canonical: parsedBack !== undefined ? parseCodexEntry(parsedBack) : undefined,
      baseHash: text !== undefined ? sha256(text) : undefined,
      warnings: warnings.length ? warnings : undefined,
    };
  }

  async renderRemove(ref: CapabilityRef): Promise<RenderResult> {
    assertWritableScope(ref.scope);
    const text = await this.readText();
    if (text === undefined) {
      throw new Error(`codex: nothing to remove — config not found at ${this.configPath}`);
    }
    parseCodexServers(text, this.configPath);
    const lines = text.split('\n');
    const range = findTableBlock(lines, ref.name);
    if (!range) {
      return {
        file: this.configPath,
        newContent: text,
        before: undefined,
        baseHash: sha256(text),
        warnings: [`codex: "${ref.name}" is not installed`],
      };
    }
    const before = lines.slice(range.start, range.end).join('\n');
    lines.splice(range.start, range.end - range.start);
    return {
      file: this.configPath,
      newContent: lines.join('\n'),
      before,
      after: undefined,
      baseHash: sha256(text),
    };
  }

  validate(content: string): void {
    parseCodexServers(content, this.configPath);
  }
}
