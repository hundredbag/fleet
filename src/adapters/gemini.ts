import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { AgentAdapter, AgentWriter, CapabilityRef, RenderResult } from '../core/adapter.js';
import type { DetectedAgent, InstalledCapability, McpServerSpec } from '../core/types.js';
import { probeConfigurationPaths, probeExecutable } from '../core/detection.js';
import { asStringArray, asStringRecord, isPlainObject } from '../core/coerce.js';
import {
  loadJsonDoc,
  getServers,
  renderJson,
  validateJsonObject,
  mergePreservingUnmanaged,
  MANAGED_JSON_KEYS,
} from '../core/json-config.js';
import { assertWritableScope } from '../core/scope.js';

const GEMINI_LABEL = 'gemini';
const DEFAULT_GEMINI_JSON = join(homedir(), '.gemini', 'settings.json');

function isStringRecord(value: unknown): boolean {
  return isPlainObject(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function assertGeminiMcpEntry(value: unknown): asserts value is Record<string, unknown> {
  if (!isPlainObject(value)) throw new Error('gemini: MCP server entry is not an object');
  const transportFields = [value.httpUrl, value.url, value.command].filter(
    (entry) => entry !== undefined,
  ).length;
  if (transportFields !== 1) throw new Error('gemini: MCP transport is ambiguous or missing');
  if (value.httpUrl !== undefined) {
    if (typeof value.httpUrl !== 'string' || value.httpUrl.length === 0) {
      throw new Error('gemini: MCP httpUrl is invalid');
    }
  } else if (value.url !== undefined) {
    if (typeof value.url !== 'string' || value.url.length === 0) {
      throw new Error('gemini: MCP url is invalid');
    }
  } else if (typeof value.command !== 'string' || value.command.length === 0) {
    throw new Error('gemini: stdio MCP server entry has no command');
  }
  if (
    value.args !== undefined &&
    (!Array.isArray(value.args) || !value.args.every((arg) => typeof arg === 'string'))
  ) {
    throw new Error('gemini: MCP args are invalid');
  }
  if (value.env !== undefined && !isStringRecord(value.env)) {
    throw new Error('gemini: MCP environment is invalid');
  }
  if (value.headers !== undefined && !isStringRecord(value.headers)) {
    throw new Error('gemini: MCP headers are invalid');
  }
  if (value.httpUrl !== undefined || value.url !== undefined) {
    if (value.args !== undefined || value.env !== undefined) {
      throw new Error('gemini: remote MCP server entry contains stdio fields');
    }
  } else if (value.headers !== undefined) {
    throw new Error('gemini: stdio MCP server entry contains remote fields');
  }
}

function assertGeminiMcpServers(servers: Record<string, unknown>): void {
  for (const entry of Object.values(servers)) assertGeminiMcpEntry(entry);
}

/** Recover a normalized `bearerTokenEnvVar` from a `Bearer $VAR` header. */
function recoverBearer(headers: Record<string, string> | undefined): {
  headers?: Record<string, string>;
  bearerTokenEnvVar?: string;
} {
  if (!headers) return {};
  const auth = headers.Authorization;
  const m = auth?.match(/^Bearer \$\{?(\w+)\}?$/);
  if (!m) return { headers };
  const rest = { ...headers };
  delete rest.Authorization;
  return {
    headers: Object.keys(rest).length ? rest : undefined,
    bearerTokenEnvVar: m[1],
  };
}

/**
 * Gemini CLI declares MCP servers under `mcpServers` in settings.json and
 * selects transport by which property is present:
 *   `httpUrl` → StreamableHTTP, `url` → SSE, `command` → stdio.
 */
export function parseGeminiEntry(raw: unknown): McpServerSpec {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (r.httpUrl || r.url) {
    const { headers, bearerTokenEnvVar } = recoverBearer(asStringRecord(r.headers));
    return {
      transport: r.httpUrl ? 'http' : 'sse',
      url: String(r.httpUrl ?? r.url),
      headers,
      bearerTokenEnvVar,
    };
  }
  return {
    transport: 'stdio',
    command: String(r.command ?? ''),
    args: asStringArray(r.args),
    env: asStringRecord(r.env),
  };
}

/** Render a normalized MCP spec into a Gemini config entry (+ warnings). */
function toGeminiEntry(spec: McpServerSpec, warnings: string[]): Record<string, unknown> {
  if (spec.transport === 'stdio') {
    const entry: Record<string, unknown> = { command: spec.command };
    if (spec.args) entry.args = spec.args;
    if (spec.env) entry.env = spec.env;
    return entry;
  }
  if (spec.transport === 'ws') {
    throw new Error(`gemini: transport 'ws' is not supported (stdio, http, or sse only)`);
  }
  const entry: Record<string, unknown> = {};
  if (spec.transport === 'http') entry.httpUrl = spec.url;
  else entry.url = spec.url; // sse
  const headers: Record<string, string> = { ...(spec.headers ?? {}) };
  if (spec.bearerTokenEnvVar && !('Authorization' in headers)) {
    headers.Authorization = `Bearer $${spec.bearerTokenEnvVar}`;
    warnings.push(
      `gemini: rendered bearer token as a header with env expansion ($${spec.bearerTokenEnvVar})`,
    );
  }
  if (Object.keys(headers).length) entry.headers = headers;
  return entry;
}

export class GeminiAdapter implements AgentAdapter, AgentWriter {
  readonly contractVersion = 1;
  readonly id = 'gemini';
  readonly displayName = 'Gemini CLI';
  readonly supportsWrite = true;
  readonly capabilitySupport = {
    'mcp-server': { inventory: 'supported', management: 'writable' },
    skill: { inventory: 'unsupported', management: 'none' },
    rule: { inventory: 'unsupported', management: 'none' },
    permission: { inventory: 'unsupported', management: 'none' },
    plugin: { inventory: 'unsupported', management: 'none' },
    command: { inventory: 'unsupported', management: 'none' },
    hook: { inventory: 'unsupported', management: 'none' },
    subagent: { inventory: 'unsupported', management: 'none' },
  } as const;

  constructor(
    private readonly settingsPath: string = DEFAULT_GEMINI_JSON,
    private readonly executable: string = 'gemini',
  ) {}

  async detect(): Promise<DetectedAgent> {
    const configuration = await probeConfigurationPaths([{ path: this.settingsPath, kind: 'file' }]);
    return {
      id: this.id,
      displayName: this.displayName,
      present: configuration.present,
      configPaths: [this.settingsPath],
      runtimeStatus: await probeExecutable(this.executable),
      configurationStatus: configuration.status,
      note: configuration.note ?? (configuration.present ? undefined : 'not configured on this machine'),
    };
  }

  async readInventory(): Promise<InstalledCapability[]> {
    if (!existsSync(this.settingsPath)) return [];
    let data: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(await readFile(this.settingsPath, 'utf8'));
      if (!isPlainObject(parsed)) throw new Error('root is not an object');
      data = parsed;
    } catch {
      throw new Error(`gemini: ${this.settingsPath} is not valid JSON`);
    }
    if (data.mcpServers !== undefined && !isPlainObject(data.mcpServers)) {
      throw new Error('gemini: mcpServers is not an object');
    }
    // Gemini has no per-server disable flag → enabled is always true.
    return Object.entries(data.mcpServers ?? {}).map(([name, raw]) => {
      assertGeminiMcpEntry(raw);
      return {
        kind: 'mcp-server' as const,
        name,
        agent: this.id,
        scope: 'user' as const,
        enabled: true,
        spec: parseGeminiEntry(raw),
        source: { file: this.settingsPath },
        raw,
      };
    });
  }

  // --- AgentWriter (JSON) ---

  async renderInstall(spec: McpServerSpec, ref: CapabilityRef): Promise<RenderResult> {
    assertWritableScope(ref.scope);
    const warnings: string[] = [];
    const entry = toGeminiEntry(spec, warnings); // may throw for unsupported transport
    const { doc, text } = await loadJsonDoc(this.settingsPath, GEMINI_LABEL);
    const servers = getServers(doc, this.settingsPath, GEMINI_LABEL);
    assertGeminiMcpServers(servers);
    const before = servers[ref.name];
    const after = mergePreservingUnmanaged(before, entry, MANAGED_JSON_KEYS);
    doc.mcpServers = { ...servers, [ref.name]: after };
    return renderJson(this.settingsPath, doc, text, before, after, warnings);
  }

  async renderRemove(ref: CapabilityRef): Promise<RenderResult> {
    assertWritableScope(ref.scope);
    if (!existsSync(this.settingsPath)) {
      throw new Error(`gemini: nothing to remove — config not found at ${this.settingsPath}`);
    }
    const { doc, text } = await loadJsonDoc(this.settingsPath, GEMINI_LABEL);
    const servers = getServers(doc, this.settingsPath, GEMINI_LABEL);
    assertGeminiMcpServers(servers);
    const before = servers[ref.name];
    const warnings: string[] = [];
    if (before === undefined) warnings.push(`gemini: "${ref.name}" is not installed`);
    const next = { ...servers };
    delete next[ref.name];
    doc.mcpServers = next;
    return renderJson(this.settingsPath, doc, text, before, undefined, warnings);
  }

  validate(content: string): void {
    validateJsonObject(content, GEMINI_LABEL);
    const doc = JSON.parse(content) as Record<string, unknown>;
    const servers = getServers(doc, this.settingsPath, GEMINI_LABEL);
    assertGeminiMcpServers(servers);
  }
}
