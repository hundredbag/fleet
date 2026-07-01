import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * User config at `~/.fleet/config.json` (override the dir with $FLEET_HOME).
 * Every field is validated on load — a malformed or partial file degrades to
 * defaults, never crashes. This is NOT a place for secrets (it's plain JSON on
 * disk and may be surfaced); tokens belong in the agents' own env.
 */
export interface FleetConfig {
  /** default port for `fleet serve` */
  port: number;
  /** extra Host/Origin values the dashboard accepts (e.g. a Tailscale name) */
  allowHosts: string[];
  /** preferred/enabled agent ids, or null = all detected */
  agents: string[] | null;
  /** central hub base URL (reserved for the hub feed source), or null */
  hubUrl: string | null;
  /** custom feed source ids, or null = built-in defaults */
  feedSources: string[] | null;
  /** third-party adapter module specifiers to load (bring your own agent) */
  adapterModules: string[];
}

export const DEFAULT_CONFIG: FleetConfig = {
  port: 7777,
  allowHosts: [],
  agents: null,
  hubUrl: null,
  feedSources: null,
  adapterModules: [],
};

export function fleetHomeDir(fleetHome?: string): string {
  // `||` (not `??`) so an empty string falls through instead of resolving cwd-relative.
  return fleetHome || process.env.FLEET_HOME || join(homedir(), '.fleet');
}

function isUrl(s: string): boolean {
  try {
    new URL(s);
    return true;
  } catch {
    return false;
  }
}

export function configPath(fleetHome?: string): string {
  return join(fleetHomeDir(fleetHome), 'config.json');
}

function strArray(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
}

/** Validate + merge an untrusted parsed object onto the defaults. */
export function normalizeConfig(parsed: unknown): FleetConfig {
  const c: FleetConfig = { ...DEFAULT_CONFIG };
  const p = (parsed ?? {}) as Record<string, unknown>;
  if (typeof p.port === 'number' && Number.isInteger(p.port) && p.port > 0 && p.port < 65536) {
    c.port = p.port;
  }
  const allow = strArray(p.allowHosts);
  if (allow) c.allowHosts = allow;
  // For reserved list fields, an all-invalid value keeps the null default
  // ("all detected") rather than flipping to [] ("none").
  const agents = strArray(p.agents);
  if (agents && agents.length) c.agents = agents;
  if (typeof p.hubUrl === 'string' && p.hubUrl && isUrl(p.hubUrl)) c.hubUrl = p.hubUrl;
  const sources = strArray(p.feedSources);
  if (sources && sources.length) c.feedSources = sources;
  const adapterModules = strArray(p.adapterModules);
  if (adapterModules) c.adapterModules = adapterModules;
  return c;
}

/** Load config from disk (missing → defaults; invalid → warn + defaults, never throw). */
export function loadConfig(fleetHome?: string): FleetConfig {
  const path = configPath(fleetHome);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { ...DEFAULT_CONFIG };
    process.stderr.write(`fleet: could not read config at ${path}; using defaults\n`);
    return { ...DEFAULT_CONFIG };
  }
  try {
    return normalizeConfig(JSON.parse(raw));
  } catch {
    process.stderr.write(`fleet: ignoring invalid JSON config at ${path}; using defaults\n`);
    return { ...DEFAULT_CONFIG };
  }
}
