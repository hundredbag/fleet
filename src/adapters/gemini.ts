import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { AgentAdapter, AgentWriter, CapabilityRef, RenderResult } from '../core/adapter.js';
import type { DetectedAgent, InstalledCapability, McpServerSpec } from '../core/types.js';
import { asStringArray, asStringRecord } from '../core/coerce.js';
import {
  loadJsonDoc,
  getServers,
  renderJson,
  validateJsonObject,
  mergePreservingUnmanaged,
  MANAGED_JSON_KEYS,
} from '../core/json-config.js';

const GEMINI_LABEL = 'gemini';
const DEFAULT_GEMINI_JSON = join(homedir(), '.gemini', 'settings.json');

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
  readonly id = 'gemini';
  readonly displayName = 'Gemini CLI';
  readonly supportsWrite = true;

  constructor(private readonly settingsPath: string = DEFAULT_GEMINI_JSON) {}

  async detect(): Promise<DetectedAgent> {
    const present = existsSync(this.settingsPath);
    return {
      id: this.id,
      displayName: this.displayName,
      present,
      configPaths: [this.settingsPath],
      note: present ? undefined : 'not configured on this machine',
    };
  }

  async readInventory(): Promise<InstalledCapability[]> {
    if (!existsSync(this.settingsPath)) return [];
    let data: { mcpServers?: Record<string, unknown> };
    try {
      data = JSON.parse(await readFile(this.settingsPath, 'utf8'));
    } catch {
      throw new Error(`gemini: ${this.settingsPath} is not valid JSON`);
    }
    // Gemini has no per-server disable flag → enabled is always true.
    return Object.entries(data.mcpServers ?? {}).map(([name, raw]) => ({
      kind: 'mcp-server' as const,
      name,
      agent: this.id,
      scope: 'user' as const,
      enabled: true,
      spec: parseGeminiEntry(raw),
      source: { file: this.settingsPath },
      raw,
    }));
  }

  // --- AgentWriter (JSON) ---

  async renderInstall(spec: McpServerSpec, ref: CapabilityRef): Promise<RenderResult> {
    const warnings: string[] = [];
    if (ref.scope !== 'user') {
      warnings.push(`gemini: only 'user' scope is supported in M2 (got '${ref.scope}')`);
    }
    const entry = toGeminiEntry(spec, warnings); // may throw for unsupported transport
    const { doc, text } = await loadJsonDoc(this.settingsPath, GEMINI_LABEL);
    const servers = getServers(doc, this.settingsPath, GEMINI_LABEL);
    const before = servers[ref.name];
    const after = mergePreservingUnmanaged(before, entry, MANAGED_JSON_KEYS);
    doc.mcpServers = { ...servers, [ref.name]: after };
    return renderJson(this.settingsPath, doc, text, before, after, warnings);
  }

  async renderRemove(ref: CapabilityRef): Promise<RenderResult> {
    if (!existsSync(this.settingsPath)) {
      throw new Error(`gemini: nothing to remove — config not found at ${this.settingsPath}`);
    }
    const { doc, text } = await loadJsonDoc(this.settingsPath, GEMINI_LABEL);
    const servers = getServers(doc, this.settingsPath, GEMINI_LABEL);
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
  }
}
