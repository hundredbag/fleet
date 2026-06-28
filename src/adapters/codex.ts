import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { parse as parseToml } from 'smol-toml';
import type { AgentAdapter } from '../core/adapter.js';
import type {
  DetectedAgent,
  InstalledCapability,
  McpServerSpec,
} from '../core/types.js';
import { asStringArray, asStringRecord } from '../core/coerce.js';

const DEFAULT_CODEX_TOML = join(homedir(), '.codex', 'config.toml');

/**
 * Codex declares MCP servers under `[mcp_servers.<name>]` in config.toml.
 * Remote servers use streamable HTTP only (no SSE), keyed by `url` (flat) or
 * a nested `transport = { type = "streamable_http", url = ... }` table. Auth
 * lives in `bearer_token_env_var` / `http_headers` (preserved in `raw`; the
 * generic `headers` field maps from `http_headers`).
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
    };
  }
  return {
    transport: 'stdio',
    command: String(r.command ?? ''),
    args: asStringArray(r.args),
    env: asStringRecord(r.env),
  };
}

export class CodexAdapter implements AgentAdapter {
  readonly id = 'codex';
  readonly displayName = 'OpenAI Codex';
  readonly supportsWrite = false;

  constructor(private readonly configPath: string = DEFAULT_CODEX_TOML) {}

  async detect(): Promise<DetectedAgent> {
    return {
      id: this.id,
      displayName: this.displayName,
      present: existsSync(this.configPath),
      configPaths: [this.configPath],
    };
  }

  async readInventory(): Promise<InstalledCapability[]> {
    if (!existsSync(this.configPath)) return [];
    const data = parseToml(await readFile(this.configPath, 'utf8')) as {
      mcp_servers?: Record<string, unknown>;
    };
    return Object.entries(data.mcp_servers ?? {}).map(([name, raw]) => {
      const r = (raw ?? {}) as Record<string, unknown>;
      return {
        kind: 'mcp-server' as const,
        name,
        agent: this.id,
        scope: 'user' as const,
        enabled: r.enabled !== false,
        spec: parseCodexEntry(raw),
        source: { file: this.configPath },
        raw,
      };
    });
  }
}
