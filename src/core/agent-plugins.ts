import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PluginCapability } from './types.js';

/**
 * READ-ONLY vendor-plugin readers (shapes verified on a real machine 2026-07-03).
 * Plugins are vendor-managed bundles; fleet never writes their dirs — install/
 * remove will be DELEGATED to the vendor CLI (Part B). Every reader degrades to
 * [] on missing/malformed input (a broken plugins dir must not cost the rest of
 * the inventory).
 *
 * Claude Code layout:
 *   ~/.claude/plugins/known_marketplaces.json   { <marketName>: { source:{repo}, installLocation } }
 *   <installLocation>/.claude-plugin/marketplace.json  { name, plugins:[{name, description, …}] }
 *   ~/.claude/settings.json                     { enabledPlugins: { "<plugin>@<market>": true } }
 */

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/** Description lookup from a marketplace's manifest (best-effort). */
async function marketplaceDescriptions(installLocation: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  const manifest = (await readJson(join(installLocation, '.claude-plugin', 'marketplace.json'))) as
    { plugins?: unknown } | undefined;
  if (!manifest || !Array.isArray(manifest.plugins)) return out;
  for (const p of manifest.plugins) {
    const name = (p as { name?: unknown })?.name;
    const desc = (p as { description?: unknown })?.description;
    if (typeof name === 'string' && typeof desc === 'string') out.set(name, desc.slice(0, 300));
  }
  return out;
}

/** Claude Code: enabled plugins (settings.json enabledPlugins) enriched from marketplace manifests. */
export async function readClaudePlugins(
  agentId: string,
  pluginsDir: string,
  settingsPath: string,
): Promise<PluginCapability[]> {
  const settings = (await readJson(settingsPath)) as { enabledPlugins?: Record<string, unknown> } | undefined;
  const enabled = settings?.enabledPlugins;
  if (!enabled || typeof enabled !== 'object') return [];

  const markets = ((await readJson(join(pluginsDir, 'known_marketplaces.json'))) ?? {}) as Record<
    string,
    { installLocation?: unknown }
  >;
  const descCache = new Map<string, Map<string, string>>();

  const out: PluginCapability[] = [];
  for (const [key, on] of Object.entries(enabled)) {
    if (on === false) continue;
    const at = key.lastIndexOf('@');
    const name = at > 0 ? key.slice(0, at) : key;
    const marketplace = at > 0 ? key.slice(at + 1) : undefined;
    let description: string | undefined;
    if (marketplace && typeof markets[marketplace]?.installLocation === 'string') {
      if (!descCache.has(marketplace)) {
        descCache.set(
          marketplace,
          await marketplaceDescriptions(markets[marketplace].installLocation as string),
        );
      }
      description = descCache.get(marketplace)?.get(name);
    }
    out.push({
      kind: 'plugin',
      name,
      agent: agentId,
      scope: 'user',
      enabled: true,
      marketplace,
      description,
      source: { file: settingsPath },
    });
  }
  return out;
}

/**
 * Codex: plugins directory scan (guarded — shape not yet verified on a real
 * install; we only report names of plugin-looking subdirectories, never parse).
 */
export async function readCodexPlugins(agentId: string, pluginsDir: string): Promise<PluginCapability[]> {
  if (!existsSync(pluginsDir)) return [];
  try {
    const entries = await readdir(pluginsDir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => ({
        kind: 'plugin' as const,
        name: e.name,
        agent: agentId,
        scope: 'user' as const,
        enabled: true,
        source: { file: pluginsDir },
      }));
  } catch {
    return [];
  }
}
