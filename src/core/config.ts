import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
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
  /** enabled adapter ids, or null = every registered adapter */
  agents: string[] | null;
  /** central hub base URL (reserved for the hub feed source), or null */
  hubUrl: string | null;
  /** enabled feed source ids, or null = every available default */
  feedSources: string[] | null;
  /** third-party adapter module specifiers to load (bring your own agent) */
  adapterModules: string[];
  /** trust gate enforcement: 'warn' surfaces caution as warnings (default); 'block' refuses caution-level plans */
  trustPolicy: 'warn' | 'block';
}

/** Local, administrator-provisioned ceiling. It never contains credentials or
 * remote policy references; Fleet only reads this file from its own state home. */
export interface TeamPolicy {
  version: 1;
  /** Maximum adapter ids the user config may activate; null means no team ceiling. */
  agents: string[] | null;
  /** Maximum default feed ids the user config may activate; null means no team ceiling. */
  feedSources: string[] | null;
  /** A block policy cannot be weakened by user config or a stored preview. */
  trustPolicy: 'warn' | 'block';
  /** A present policy must explicitly opt into in-process BYO module imports. */
  allowAdapterModules: boolean;
}

export const DEFAULT_CONFIG: FleetConfig = {
  port: 7777,
  allowHosts: [],
  agents: null,
  hubUrl: null,
  trustPolicy: 'warn',
  feedSources: null,
  adapterModules: [],
};

export const DEFAULT_TEAM_POLICY: TeamPolicy = {
  version: 1,
  agents: null,
  feedSources: null,
  trustPolicy: 'warn',
  allowAdapterModules: true,
};

/** Feed ids that may be selected from config.json's default source registry. */
export const CONFIGURABLE_FEED_SOURCE_IDS = [
  'mcp-registry',
  'skills.sh',
  'skillsmp',
  'claudeskills',
  'plugin-markets',
  'hub',
  'pulsemcp',
] as const;

export function fleetHomeDir(fleetHome?: string): string {
  // `||` (not `??`) so an empty string falls through instead of resolving cwd-relative.
  return fleetHome || process.env.FLEET_HOME || join(homedir(), '.fleet');
}

/** hubUrl must be https (or http on loopback) — it's a trusted-metadata source. */
function isHubUrl(s: string): boolean {
  try {
    const u = new URL(s);
    if (u.protocol === 'https:') return true;
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  } catch {
    return false;
  }
}

export function configPath(fleetHome?: string): string {
  return join(fleetHomeDir(fleetHome), 'config.json');
}

export function teamPolicyPath(fleetHome?: string): string {
  return join(fleetHomeDir(fleetHome), 'team-policy.json');
}

export type ConfigReadResult =
  | { status: 'ok'; config: FleetConfig }
  | { status: 'missing'; config: FleetConfig }
  | { status: 'read-failed'; config: FleetConfig }
  | { status: 'invalid'; reason: 'syntax' | 'schema'; config: FleetConfig };

export type TeamPolicyReadResult =
  | { status: 'ok'; policy: TeamPolicy }
  | { status: 'missing'; policy: TeamPolicy }
  | { status: 'read-failed'; policy: TeamPolicy }
  | { status: 'invalid'; reason: 'syntax' | 'schema'; policy: TeamPolicy };

export interface EffectiveConfigReadResult {
  configState: ConfigReadResult;
  policyState: TeamPolicyReadResult;
  config: FleetConfig;
}

function unsafePolicyLeaf(): NodeJS.ErrnoException {
  const error = new Error('unsafe policy leaf') as NodeJS.ErrnoException;
  error.code = 'ELOOP';
  return error;
}

/** Reject non-regular leaves before open (so FIFO/device paths never block),
 * then pin and compare the opened inode. O_NOFOLLOW is the primary boundary;
 * the lstat/fstat identity check also fails closed where that flag is absent. */
function openPinnedPolicyFile(path: string): number {
  const before = lstatSync(path);
  if (before.isSymbolicLink() || !before.isFile()) throw unsafePolicyLeaf();
  let fd: number;
  try {
    fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    // The leaf existed at lstat time. A disappearance before open is a
    // concurrent topology change, not a healthy missing-policy state.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw unsafePolicyLeaf();
    throw error;
  }
  try {
    const after = fstatSync(fd);
    const afterPath = lstatSync(path);
    if (
      !after.isFile() ||
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      afterPath.dev !== after.dev ||
      afterPath.ino !== after.ino
    ) {
      throw unsafePolicyLeaf();
    }
    return fd;
  } catch (error) {
    closeSync(fd);
    // Once the leaf has been observed and opened, disappearance during the
    // pathname recheck is a concurrent topology change, never healthy absence.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw unsafePolicyLeaf();
    throw error;
  }
}

function strArray(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : undefined;
}

function isValidConfigDocument(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const parsed = value as Record<string, unknown>;
  const validStringArray = (field: unknown, nullable = false) =>
    field === undefined ||
    (nullable && field === null) ||
    (Array.isArray(field) && field.every((item) => typeof item === 'string'));
  return (
    (parsed.port === undefined ||
      (typeof parsed.port === 'number' &&
        Number.isInteger(parsed.port) &&
        parsed.port > 0 &&
        parsed.port < 65536)) &&
    validStringArray(parsed.allowHosts) &&
    validStringArray(parsed.agents, true) &&
    (parsed.hubUrl === undefined ||
      parsed.hubUrl === null ||
      (typeof parsed.hubUrl === 'string' && parsed.hubUrl.length > 0 && isHubUrl(parsed.hubUrl))) &&
    validStringArray(parsed.feedSources, true) &&
    validStringArray(parsed.adapterModules) &&
    (parsed.trustPolicy === undefined || parsed.trustPolicy === 'warn' || parsed.trustPolicy === 'block')
  );
}

function validUniqueStringArray(
  value: unknown,
  nullable = false,
  itemValid: (item: string) => boolean = () => true,
): boolean {
  return (
    (nullable && value === null) ||
    (Array.isArray(value) &&
      value.length <= 256 &&
      value.every((item) => typeof item === 'string' && item.length > 0 && itemValid(item)) &&
      new Set(value).size === value.length)
  );
}

function isValidTeamPolicyDocument(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const parsed = value as Record<string, unknown>;
  const allowed = new Set(['version', 'agents', 'feedSources', 'trustPolicy', 'allowAdapterModules']);
  return (
    Object.keys(parsed).every((key) => allowed.has(key)) &&
    parsed.version === 1 &&
    (parsed.agents === undefined ||
      validUniqueStringArray(parsed.agents, true, (item) => /^[a-z0-9][a-z0-9._-]{0,63}$/i.test(item))) &&
    (parsed.feedSources === undefined ||
      validUniqueStringArray(parsed.feedSources, true, (item) =>
        (CONFIGURABLE_FEED_SOURCE_IDS as readonly string[]).includes(item),
      )) &&
    (parsed.trustPolicy === undefined || parsed.trustPolicy === 'warn' || parsed.trustPolicy === 'block') &&
    (parsed.allowAdapterModules === undefined || typeof parsed.allowAdapterModules === 'boolean')
  );
}

function normalizeTeamPolicy(parsed: Record<string, unknown>): TeamPolicy {
  return {
    version: 1,
    agents:
      parsed.agents === null ? null : Array.isArray(parsed.agents) ? [...(parsed.agents as string[])] : null,
    feedSources:
      parsed.feedSources === null
        ? null
        : Array.isArray(parsed.feedSources)
          ? [...(parsed.feedSources as string[])]
          : null,
    trustPolicy: parsed.trustPolicy === 'block' ? 'block' : 'warn',
    // A policy file is an administrative boundary. Its omission must not
    // accidentally authorize arbitrary configured code in the Fleet process.
    allowAdapterModules: parsed.allowAdapterModules === true,
  };
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
  // Preserve an explicitly empty, schema-valid list: [] means "none", while
  // null/omission means "all/default". An all-invalid non-empty list still
  // keeps the null default rather than changing its meaning.
  const agents = strArray(p.agents);
  if (agents && (agents.length > 0 || (Array.isArray(p.agents) && p.agents.length === 0))) {
    c.agents = agents;
  }
  if (typeof p.hubUrl === 'string' && p.hubUrl && isHubUrl(p.hubUrl)) c.hubUrl = p.hubUrl;
  if (p.trustPolicy === 'block' || p.trustPolicy === 'warn') c.trustPolicy = p.trustPolicy;
  const sources = strArray(p.feedSources);
  if (sources && (sources.length > 0 || (Array.isArray(p.feedSources) && p.feedSources.length === 0))) {
    c.feedSources = sources;
  }
  const adapterModules = strArray(p.adapterModules);
  if (adapterModules) c.adapterModules = adapterModules;
  return c;
}

export function readConfigState(fleetHome?: string): ConfigReadResult {
  const path = configPath(fleetHome);
  let raw: string;
  let fd: number | undefined;
  try {
    // Pin a regular inode and never follow the policy leaf. In particular, a
    // dangling symlink must not collapse to ENOENT/default policy.
    fd = openPinnedPolicyFile(path);
    raw = readFileSync(fd, 'utf8');
  } catch (e) {
    return {
      status: (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'read-failed',
      config: { ...DEFAULT_CONFIG },
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    const config = normalizeConfig(parsed);
    return isValidConfigDocument(parsed)
      ? { status: 'ok', config }
      : { status: 'invalid', reason: 'schema', config: { ...DEFAULT_CONFIG } };
  } catch {
    return { status: 'invalid', reason: 'syntax', config: { ...DEFAULT_CONFIG } };
  }
}

export function readTeamPolicyState(fleetHome?: string): TeamPolicyReadResult {
  const path = teamPolicyPath(fleetHome);
  let raw: string;
  let fd: number | undefined;
  try {
    fd = openPinnedPolicyFile(path);
    raw = readFileSync(fd, 'utf8');
  } catch (error) {
    return {
      status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'read-failed',
      policy: { ...DEFAULT_TEAM_POLICY },
    };
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isValidTeamPolicyDocument(parsed)
      ? { status: 'ok', policy: normalizeTeamPolicy(parsed) }
      : { status: 'invalid', reason: 'schema', policy: { ...DEFAULT_TEAM_POLICY } };
  } catch {
    return { status: 'invalid', reason: 'syntax', policy: { ...DEFAULT_TEAM_POLICY } };
  }
}

function constrainList(preference: string[] | null, ceiling: string[] | null): string[] | null {
  if (ceiling === null) return preference === null ? null : [...preference];
  if (preference === null) return [...ceiling];
  const allowed = new Set(ceiling);
  return preference.filter((entry) => allowed.has(entry));
}

export function applyTeamPolicy(config: FleetConfig, policy: TeamPolicy): FleetConfig {
  return {
    ...config,
    agents: constrainList(config.agents, policy.agents),
    feedSources: constrainList(config.feedSources, policy.feedSources),
    adapterModules: policy.allowAdapterModules ? [...config.adapterModules] : [],
    trustPolicy: config.trustPolicy === 'block' || policy.trustPolicy === 'block' ? 'block' : 'warn',
  };
}

function failClosedReadConfig(config: FleetConfig): FleetConfig {
  return {
    ...config,
    agents: [],
    feedSources: [],
    adapterModules: [],
    trustPolicy: 'block',
  };
}

export function readEffectiveConfigState(fleetHome?: string): EffectiveConfigReadResult {
  const configState = readConfigState(fleetHome);
  const policyState = readTeamPolicyState(fleetHome);
  const config =
    policyState.status === 'ok' || policyState.status === 'missing'
      ? applyTeamPolicy(configState.config, policyState.policy)
      : failClosedReadConfig(configState.config);
  return { configState, policyState, config };
}

/** A caller may relax its own trust preference for one preview, but never an
 * administrator-provisioned block ceiling or an unreadable policy boundary. */
export function effectiveTrustPolicy(fleetHome?: string, requested?: 'warn' | 'block'): 'warn' | 'block' {
  const state = readEffectiveConfigState(fleetHome);
  if (
    state.policyState.status === 'read-failed' ||
    state.policyState.status === 'invalid' ||
    (state.policyState.status === 'ok' && state.policyState.policy.trustPolicy === 'block')
  ) {
    return 'block';
  }
  return requested ?? state.config.trustPolicy;
}

/** Parse an explicit per-plan trust override without silently weakening a
 * misspelled or valueless CLI flag to the configured default. */
export function parseTrustPolicyOverride(value: unknown): 'warn' | 'block' | undefined {
  if (value === undefined) return undefined;
  if (value === 'warn' || value === 'block') return value;
  throw new Error("trust override must be 'warn' or 'block'");
}

/** Load effective read-only behavior. Damaged user config degrades to defaults;
 * damaged team policy degrades to empty activation and block trust. */
export function loadConfig(fleetHome?: string): FleetConfig {
  const { configState: result, policyState, config } = readEffectiveConfigState(fleetHome);
  // This loader also runs during MCP startup, whose stderr is captured by
  // hosts. Keep diagnostics fixed; the local `fleet config` command can show
  // the path explicitly when an operator asks for it.
  if (result.status === 'read-failed') {
    process.stderr.write('fleet: CONFIG_READ_FAILED; using defaults\n');
  } else if (result.status === 'invalid') {
    process.stderr.write('fleet: CONFIG_INVALID; using defaults\n');
  }
  if (policyState.status === 'read-failed') {
    process.stderr.write('fleet: TEAM_POLICY_READ_FAILED; using fail-closed limits\n');
  } else if (policyState.status === 'invalid') {
    process.stderr.write('fleet: TEAM_POLICY_INVALID; using fail-closed limits\n');
  }
  return config;
}

/** Mutation preflight. Read-only commands may degrade to defaults, but a write
 * must never silently replace an unreadable or malformed operator policy. */
export function assertMutationConfigReadable(fleetHome?: string): FleetConfig {
  const { configState: result, policyState, config } = readEffectiveConfigState(fleetHome);
  if (result.status === 'read-failed') throw new Error('fleet: CONFIG_READ_FAILED; refusing mutation');
  if (result.status === 'invalid') throw new Error('fleet: CONFIG_INVALID; refusing mutation');
  if (policyState.status === 'read-failed') {
    throw new Error('fleet: TEAM_POLICY_READ_FAILED; refusing mutation');
  }
  if (policyState.status === 'invalid') throw new Error('fleet: TEAM_POLICY_INVALID; refusing mutation');
  return config;
}
