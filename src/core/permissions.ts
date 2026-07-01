import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { parse as parseToml } from 'smol-toml';
import type { PermissionCapability } from './types.js';

/**
 * READ-ONLY permission readers. fleet surfaces each agent's permission/approval
 * config in the unified inventory so you can see it in one place — but never
 * writes or translates it (see PermissionCapability). Every reader degrades to
 * [] on a missing/malformed file (never throws).
 */

/** Claude Code: `settings.json` → `permissions: { allow, deny, ask: string[] }`. */
export async function readClaudePermissions(
  agentId: string,
  settingsPath: string,
): Promise<PermissionCapability[]> {
  if (!existsSync(settingsPath)) return [];
  let data: unknown;
  try {
    data = JSON.parse(await readFile(settingsPath, 'utf8'));
  } catch {
    return [];
  }
  const perms = (data as { permissions?: Record<string, unknown> })?.permissions;
  if (!perms || typeof perms !== 'object') return [];
  const out: PermissionCapability[] = [];
  for (const effect of ['allow', 'deny', 'ask'] as const) {
    const list = perms[effect];
    if (!Array.isArray(list)) continue;
    for (const rule of list) {
      if (typeof rule === 'string' && rule) {
        out.push({
          kind: 'permission',
          name: rule,
          agent: agentId,
          scope: 'user',
          enabled: true,
          effect,
          source: { file: settingsPath },
        });
      }
    }
  }
  return out;
}

/** Codex: `config.toml` top-level approval/sandbox policy (surfaced as policy entries). */
export async function readCodexPermissions(
  agentId: string,
  configPath: string,
): Promise<PermissionCapability[]> {
  if (!existsSync(configPath)) return [];
  let data: Record<string, unknown>;
  try {
    data = parseToml(await readFile(configPath, 'utf8')) as Record<string, unknown>;
  } catch {
    return [];
  }
  const out: PermissionCapability[] = [];
  for (const key of ['approval_policy', 'sandbox_mode']) {
    const v = data[key];
    if (typeof v === 'string' && v) {
      out.push({
        kind: 'permission',
        name: `${key}=${v}`,
        agent: agentId,
        scope: 'user',
        enabled: true,
        effect: 'policy',
        source: { file: configPath },
      });
    }
  }
  return out;
}
