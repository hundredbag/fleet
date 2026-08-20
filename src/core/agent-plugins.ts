import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PluginCapability } from './types.js';
import { pluginCoordinate } from './plugin-coordinate.js';

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
  return readClaudePluginsInternal(agentId, pluginsDir, settingsPath, false);
}

/** Mutation-grade verifier: missing means empty, while unreadable or malformed
 * vendor settings are never converted into authoritative absence. */
export async function readClaudePluginsStrict(
  agentId: string,
  pluginsDir: string,
  settingsPath: string,
): Promise<PluginCapability[]> {
  return readClaudePluginsInternal(agentId, pluginsDir, settingsPath, true);
}

async function readClaudePluginsInternal(
  agentId: string,
  pluginsDir: string,
  settingsPath: string,
  strict: boolean,
): Promise<PluginCapability[]> {
  let settings: { enabledPlugins?: unknown } | undefined;
  try {
    const value: unknown = JSON.parse(await readFile(settingsPath, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid settings');
    settings = value as { enabledPlugins?: unknown };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    if (strict) throw new Error('claude-code: plugin settings are unavailable or invalid');
    return [];
  }
  const enabled = settings?.enabledPlugins;
  if (enabled === undefined) return [];
  if (!enabled || typeof enabled !== 'object' || Array.isArray(enabled)) {
    if (strict) throw new Error('claude-code: plugin settings are unavailable or invalid');
    return [];
  }

  const markets = ((await readJson(join(pluginsDir, 'known_marketplaces.json'))) ?? {}) as Record<
    string,
    { installLocation?: unknown }
  >;
  const descCache = new Map<string, Map<string, string>>();

  const out: PluginCapability[] = [];
  for (const [key, on] of Object.entries(enabled as Record<string, unknown>)) {
    if (strict && typeof on !== 'boolean') {
      throw new Error('claude-code: plugin settings are unavailable or invalid');
    }
    // disabled plugins still SURFACE (matrix shows ✗) — hiding them would break
    // "see everything in one place". Strict: only `true` counts as enabled.
    const isEnabled = on === true;
    let coordinate;
    try {
      coordinate = pluginCoordinate(key);
    } catch {
      if (strict) throw new Error('claude-code: plugin settings are unavailable or invalid');
      continue;
    }
    const { name, marketplace } = coordinate;
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
      enabled: isEnabled,
      marketplace,
      description,
      source: { file: settingsPath },
    });
  }
  return out;
}

/**
 * Legacy/non-authoritative Codex directory probe. Built-in adapters deliberately
 * do not publish this as installed state: directory presence is not equivalent
 * to the vendor CLI's installed inventory. Names only; never follows symlinks.
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
