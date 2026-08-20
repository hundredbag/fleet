import type { AgentAdapter } from './adapter.js';
import { ClaudeCodeAdapter } from '../adapters/claude-code.js';
import { CodexAdapter } from '../adapters/codex.js';
import { loadConfig, type FleetConfig } from './config.js';
import { loadPluginAdapters, type AdapterLoadDiagnostic, type Importer } from './plugins.js';

/**
 * The built-in active adapters.
 *
 * Gemini CLI is excluded for now: Google ended free individual hosted access on
 * 2026-06-18 and steers individuals to Antigravity CLI. The GeminiAdapter code
 * is kept in adapters/gemini.ts (still valid for API-key/enterprise users); an
 * Antigravity adapter (~/.gemini/config/mcp_config.json) and custom agents
 * (e.g. Hermes) will register here later — the "bring your own agent" path.
 */
export function defaultAdapters(): AgentAdapter[] {
  return [new ClaudeCodeAdapter(), new CodexAdapter()];
}

/**
 * Built-in adapters + any "bring your own agent" plugins declared in config.
 * Built-ins are authoritative: a plugin whose id shadows a built-in is ignored.
 */
export async function loadAdapters(
  config: FleetConfig = loadConfig(),
  importer?: Importer,
  onDiagnostic?: (diagnostic: AdapterLoadDiagnostic) => void,
  deadlineMs?: number,
): Promise<AgentAdapter[]> {
  const builtins = defaultAdapters();
  const builtinIds = new Set(builtins.map((a) => a.id));
  const seen = new Set(builtinIds);
  const indexes = new Map<AgentAdapter, number>();
  const plugins = await loadPluginAdapters(
    config.adapterModules ?? [],
    importer,
    onDiagnostic,
    (adapter, index) => indexes.set(adapter, index),
    deadlineMs,
  );
  const extra: AgentAdapter[] = [];
  for (const a of plugins) {
    if (seen.has(a.id)) {
      onDiagnostic?.({
        index: indexes.get(a) ?? -1,
        reason: builtinIds.has(a.id) ? 'shadowed' : 'duplicate-id',
      });
      process.stderr.write(
        builtinIds.has(a.id)
          ? 'fleet: ADAPTER_SHADOWED; ignoring plugin adapter\n'
          : 'fleet: ADAPTER_DUPLICATE; ignoring plugin adapter\n',
      );
      continue;
    }
    seen.add(a.id);
    extra.push(a);
  }
  const registered = [...builtins, ...extra];
  if (config.agents === null) return registered;
  const enabled = new Set(config.agents);
  return registered.filter((adapter) => enabled.has(adapter.id));
}
