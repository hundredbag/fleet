import { resolve } from 'node:path';
import type { AgentAdapter } from './adapter.js';
import { safeJoin } from './fsutil.js';
import { planInstall, planInstallRule, planInstallSkill, type Plan, type PlanSkip } from './orchestrator.js';
import type { Profile, ProfileServer } from './profile.js';
import { resolveSecretRefs } from './profile.js';
import type { AgentId, McpServerSpec } from './types.js';

/** Profiles describe an additive desired state: every listed capability should
 * exist on the selected targets. Capabilities omitted from a profile are never
 * removed. Pruning requires an explicit, separately reviewed remove command. */
export const PROFILE_DESIRED_MODE = 'additive' as const;

export interface ProfileDesiredTargets {
  servers: AgentId[];
  skills: AgentId[];
  rules: AgentId[];
}

interface ServerDesiredInput {
  kind: 'mcp-server';
  name: string;
  spec: McpServerSpec;
  targets: AgentId[];
}

interface SkillDesiredInput {
  kind: 'skill';
  name: string;
  source: string;
  sourceRoot: string;
  targets: AgentId[];
}

interface RuleDesiredInput {
  kind: 'rule';
  name: string;
  body: string;
  targets: AgentId[];
}

export type ProfileDesiredInput = ServerDesiredInput | SkillDesiredInput | RuleDesiredInput;

export interface ProfileDesiredEntry {
  kind: ProfileDesiredInput['kind'];
  name: string;
  /** A complete initial plan used for preview/status. Commit callers must use
   * refreshProfileDesiredEntry immediately before execution because an earlier
   * profile item can legitimately update the same config file/base hash. */
  plan: Plan;
  input: ProfileDesiredInput;
}

export interface ProfileMissingSecrets {
  server: string;
  names: string[];
}

export interface ProfileDesiredSummary {
  desiredInstances: number;
  changes: number;
  satisfied: number;
  blocked: number;
}

export interface PreparedProfileDesiredState {
  mode: typeof PROFILE_DESIRED_MODE;
  entries: ProfileDesiredEntry[];
  missingSecrets: ProfileMissingSecrets[];
  warnings: string[];
  summary: ProfileDesiredSummary;
}

export interface ProfileDesiredOptions {
  env?: Record<string, string | undefined>;
  fleetHome?: string;
  trustPolicy?: 'warn' | 'block';
}

function uniqueTargets(targets: AgentId[]): AgentId[] {
  return [...new Set(targets)];
}

function desiredCount(profile: Profile, targets: ProfileDesiredTargets): number {
  return (
    profile.servers.length * uniqueTargets(targets.servers).length +
    profile.skills.length * uniqueTargets(targets.skills).length +
    profile.rules.length * uniqueTargets(targets.rules).length
  );
}

function countSkips(skips: PlanSkip[], kind: PlanSkip['kind']): number {
  return skips.filter((skip) => skip.kind === kind).length;
}

function summary(entries: ProfileDesiredEntry[], desiredInstances: number): ProfileDesiredSummary {
  return {
    desiredInstances,
    changes: entries.reduce((count, entry) => count + entry.plan.changes.length, 0),
    satisfied: entries.reduce((count, entry) => count + countSkips(entry.plan.skips, 'noop'), 0),
    blocked: entries.reduce(
      (count, entry) =>
        count + countSkips(entry.plan.skips, 'error') + countSkips(entry.plan.skips, 'protected'),
      0,
    ),
  };
}

function resolveServer(
  server: ProfileServer,
  env: Record<string, string | undefined>,
): { input?: ServerDesiredInput; missing: string[] } {
  const resolved = resolveSecretRefs(server.spec, env, server.requiredSecrets);
  return {
    ...(resolved.missing.length === 0
      ? { input: { kind: 'mcp-server' as const, name: server.name, spec: resolved.spec, targets: [] } }
      : {}),
    missing: [...new Set(resolved.missing)].sort(),
  };
}

/** Validate and initially plan the complete profile before the first mutation.
 * A missing secret withholds every plan so callers cannot partially reconcile
 * a profile whose desired state is not yet resolvable on this machine. */
export async function prepareProfileDesiredState(
  adapters: AgentAdapter[],
  profile: Profile,
  profileDir: string,
  targets: ProfileDesiredTargets,
  opts: ProfileDesiredOptions = {},
): Promise<PreparedProfileDesiredState> {
  const env = opts.env ?? process.env;
  const serverTargets = uniqueTargets(targets.servers);
  const skillTargets = uniqueTargets(targets.skills);
  const ruleTargets = uniqueTargets(targets.rules);
  const desiredInstances = desiredCount(profile, {
    servers: serverTargets,
    skills: skillTargets,
    rules: ruleTargets,
  });
  const missingSecrets: ProfileMissingSecrets[] = [];
  const warnings: string[] = [];
  const inputs: ProfileDesiredInput[] = [];

  // Resolve all machine-local secret references before invoking any planner.
  for (const server of profile.servers) {
    const resolved = resolveServer(server, env);
    if (!resolved.input) {
      missingSecrets.push({ server: server.name, names: resolved.missing });
      continue;
    }
    resolved.input.targets = serverTargets;
    inputs.push(resolved.input);
    if (
      resolved.input.spec.transport !== 'stdio' &&
      resolved.input.spec.bearerTokenEnvVar &&
      !env[resolved.input.spec.bearerTokenEnvVar]
    ) {
      warnings.push(
        `${server.name}: bearer token environment variable is not set; the desired server would be configured but unavailable`,
      );
    }
  }
  for (const name of profile.skills) {
    inputs.push({
      kind: 'skill',
      name,
      source: safeJoin(profileDir, `skills/${name}`),
      sourceRoot: resolve(profileDir),
      targets: skillTargets,
    });
  }
  for (const rule of profile.rules) {
    inputs.push({ kind: 'rule', name: rule.name, body: rule.body, targets: ruleTargets });
  }

  if (missingSecrets.length > 0) {
    return {
      mode: PROFILE_DESIRED_MODE,
      entries: [],
      missingSecrets,
      warnings,
      summary: { desiredInstances, changes: 0, satisfied: 0, blocked: desiredInstances },
    };
  }

  // This deliberately completes every planner before returning. Commit code
  // cannot begin until malformed sources, unavailable targets, and trust-gate
  // planner failures across the whole declaration have all been discovered.
  const entries: ProfileDesiredEntry[] = [];
  for (const input of inputs) {
    entries.push({
      kind: input.kind,
      name: input.name,
      input,
      plan: await planProfileDesiredInput(adapters, input, opts),
    });
  }
  return {
    mode: PROFILE_DESIRED_MODE,
    entries,
    missingSecrets,
    warnings,
    summary: summary(entries, desiredInstances),
  };
}

async function planProfileDesiredInput(
  adapters: AgentAdapter[],
  input: ProfileDesiredInput,
  opts: ProfileDesiredOptions,
): Promise<Plan> {
  if (input.kind === 'mcp-server') {
    return planInstall(adapters, input.spec, input.name, 'user', input.targets, {
      ...(opts.fleetHome ? { fleetHome: opts.fleetHome } : {}),
      ...(opts.trustPolicy ? { trustPolicy: opts.trustPolicy } : {}),
    });
  }
  if (input.kind === 'skill') {
    return planInstallSkill(adapters, { name: input.name, dir: input.source }, input.name, input.targets, {
      sourceRoot: input.sourceRoot,
      ...(opts.fleetHome ? { fleetHome: opts.fleetHome } : {}),
      ...(opts.trustPolicy ? { trustPolicy: opts.trustPolicy } : {}),
    });
  }
  return planInstallRule(adapters, input.name, input.body, input.targets);
}

/** Re-plan one prepared entry against current state immediately before commit.
 * This preserves writer base-hash correctness when multiple profile entries
 * share one agent configuration file. */
export function refreshProfileDesiredEntry(
  adapters: AgentAdapter[],
  entry: ProfileDesiredEntry,
  opts: ProfileDesiredOptions = {},
): Promise<Plan> {
  return planProfileDesiredInput(adapters, entry.input, opts);
}
