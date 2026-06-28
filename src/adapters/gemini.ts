import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { AgentAdapter } from '../core/adapter.js';
import type {
  DetectedAgent,
  InstalledCapability,
  McpServerSpec,
} from '../core/types.js';
import { asStringArray, asStringRecord } from '../core/coerce.js';

const DEFAULT_GEMINI_JSON = join(homedir(), '.gemini', 'settings.json');

/**
 * Gemini CLI declares MCP servers under `mcpServers` in settings.json and
 * selects transport by which property is present:
 *   `httpUrl` → StreamableHTTP, `url` → SSE, `command` → stdio.
 */
export function parseGeminiEntry(raw: unknown): McpServerSpec {
  const r = (raw ?? {}) as Record<string, unknown>;
  if (r.httpUrl) {
    return { transport: 'http', url: String(r.httpUrl), headers: asStringRecord(r.headers) };
  }
  if (r.url) {
    return { transport: 'sse', url: String(r.url), headers: asStringRecord(r.headers) };
  }
  return {
    transport: 'stdio',
    command: String(r.command ?? ''),
    args: asStringArray(r.args),
    env: asStringRecord(r.env),
  };
}

export class GeminiAdapter implements AgentAdapter {
  readonly id = 'gemini';
  readonly displayName = 'Gemini CLI';
  readonly supportsWrite = false;

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
    const data = JSON.parse(await readFile(this.settingsPath, 'utf8')) as {
      mcpServers?: Record<string, unknown>;
    };
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
}
