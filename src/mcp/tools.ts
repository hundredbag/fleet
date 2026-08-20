import { z } from 'zod';
import type { AgentAdapter } from '../core/adapter.js';
import type { McpServerSpec } from '../core/types.js';
import { buildInventory } from '../core/inventory.js';
import {
  planInstall,
  planRemove,
  planSync,
  planInstallSkill,
  planRemoveSkill,
  planSyncSkill,
  planInstallRule,
  planRemoveRule,
  planSyncRule,
  execute,
  resolveTargets,
  type Plan,
} from '../core/orchestrator.js';
import { rollback } from '../core/writer.js';
import { assessImplicitRollback } from '../core/rollback-guard.js';
import {
  isPublicAgentId,
  isPublicCapabilityName,
  publicErrorCode,
  publicConflictFindings,
  publicRollbackReasonCode,
  scrubPublicValue,
  summarizeInventory,
  summarizeResult,
} from '../core/redact.js';
import { runDoctor } from '../core/doctor.js';
import { readLockState, type LockReadResult } from '../core/lock.js';
import { detectDrift } from '../core/drift.js';
import { skillUpdatesFromLock } from '../core/skill-updates.js';
import { analyzeConflicts } from '../core/conflicts.js';
import { defaultSources, feedSourceEnabled } from '../feed/index.js';
import { updatesForInventory } from '../feed/feed.js';
import { cachedDiscover } from '../feed/cache.js';
import { recommend, diversifyByCategory } from '../feed/recommend.js';
import { SkillsShSource } from '../feed/sources/skills-sh.js';
import {
  DelegatedOutcomeUnknownError,
  planPluginActions,
  runDelegated,
  type Runner,
} from '../core/delegate.js';
import { MARKETPLACE_RE, pluginCoordinate } from '../core/plugin-coordinate.js';
import type { FeedSource } from '../feed/source.js';
import type { AdapterLoadDiagnostic } from '../core/plugins.js';
import { parseScope } from '../core/scope.js';
import { loadConfig } from '../core/config.js';
import { FleetOperationError } from '../core/errors.js';
import { isTrustReasonCode } from '../core/trustgate.js';

const targetArg = (v: unknown): string => (Array.isArray(v) ? v.join(',') : String(v));

function publicAgentArg(value: unknown): string {
  const agent = String(value).trim();
  if (!isPublicAgentId(agent)) throw new Error('refusing non-public agent identity');
  return agent;
}

function publicTargetSelector(value: unknown): string {
  const selector = targetArg(value);
  if (selector === 'all') return selector;
  const agents = selector
    .split(',')
    .map((agent) => agent.trim())
    .filter(Boolean);
  if (agents.length === 0 || !agents.every(isPublicAgentId)) {
    throw new Error('refusing non-public agent identity');
  }
  return agents.join(',');
}

function publicCapabilityNameArg(value: unknown): string {
  const name = String(value).trim();
  if (!name || !isPublicCapabilityName(name)) {
    throw new Error('refusing non-public capability identity');
  }
  return name;
}

/**
 * A fleet capability exposed as an MCP tool. Handlers are pure over the
 * injected adapters (so they're testable without the SDK transport); the SDK
 * wiring in server.ts is a thin shell.
 */
export interface FleetTool {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

/**
 * One final AI-boundary guard for every current and future tool. Individual
 * handlers still return allowlisted DTOs; this wrapper scrubs their free-form
 * string values and sanitizes thrown adapter/vendor errors.
 */
function secureTool(tool: FleetTool): FleetTool {
  return {
    ...tool,
    handler: async (args) => {
      try {
        return scrubPublicValue(await tool.handler(args));
      } catch (error) {
        throw new Error(publicErrorCode(error));
      }
    },
  };
}

const PUBLIC_DRIFT_KINDS = new Set([
  'mcp-server',
  'skill',
  'rule',
  'permission',
  'plugin',
  'command',
  'hook',
  'subagent',
]);
function driftReasonCode(detail: string | undefined): string | undefined {
  if (!detail) return undefined;
  if (/inventory unavailable/i.test(detail)) return 'AGENT_INVENTORY_UNAVAILABLE';
  if (/predates canonical/i.test(detail)) return 'BASELINE_LEGACY';
  if (/no longer on the agent/i.test(detail)) return 'CAPABILITY_MISSING';
  if (/content differs/i.test(detail)) return 'CONTENT_MODIFIED';
  return 'DRIFT_UNVERIFIABLE';
}

function publicDriftReport(report: Awaited<ReturnType<typeof detectDrift>>) {
  const validIdentity = (item: { kind: string; name: string; agent: string }) =>
    PUBLIC_DRIFT_KINDS.has(item.kind) && isPublicCapabilityName(item.name) && isPublicAgentId(item.agent);
  const findings = report.findings
    .filter(validIdentity)
    .filter((finding) => ['modified', 'missing', 'unverifiable'].includes(finding.state))
    .map((finding) => ({
      kind: finding.kind,
      name: finding.name,
      agent: finding.agent,
      state: finding.state,
      ...(driftReasonCode(finding.detail) ? { reasonCode: driftReasonCode(finding.detail) } : {}),
    }));
  const unmanaged = report.unmanaged.filter(validIdentity).map((item) => ({
    kind: item.kind,
    name: item.name,
    agent: item.agent,
    ...(item.scope === 'user' || item.scope === 'project' || item.scope === 'local'
      ? { scope: item.scope }
      : {}),
    reasonCode: 'NOT_FLEET_MANAGED',
  }));
  return {
    lockStatus: report.lockStatus,
    checked: Number.isSafeInteger(report.checked) && report.checked >= 0 ? report.checked : 0,
    findings,
    unmanaged,
    withheld: report.findings.length - findings.length + (report.unmanaged.length - unmanaged.length),
  };
}

/** Allowlisted lock projection: local origin paths, hashes, audit ids, and
 * hand-edited unknown fields never cross the AI boundary. */
function publicLockStatus(result: LockReadResult) {
  const lock = result.lock;
  const entries = Object.values(lock.entries).flatMap((entry) => {
    if (
      !entry ||
      typeof entry !== 'object' ||
      typeof entry.kind !== 'string' ||
      typeof entry.name !== 'string' ||
      typeof entry.agent !== 'string' ||
      !PUBLIC_DRIFT_KINDS.has(entry.kind) ||
      !isPublicCapabilityName(entry.name) ||
      !isPublicAgentId(entry.agent) ||
      !entry.origin ||
      typeof entry.origin !== 'object' ||
      typeof entry.origin.type !== 'string'
    ) {
      return [];
    }
    let origin: Record<string, unknown>;
    if (entry.origin.type === 'npm' || entry.origin.type === 'pypi') {
      origin = {
        type: entry.origin.type,
        pinned:
          typeof entry.origin.version === 'string' &&
          /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(entry.origin.version),
      };
    } else if (entry.origin.type === 'marketplace') {
      origin = { type: 'marketplace' };
    } else if (entry.origin.type === 'dir') {
      origin = { type: 'local-directory', pathExposed: false };
    } else {
      origin = { type: 'manual' };
    }
    const installedAt =
      typeof entry.installedAt === 'string' && Number.isFinite(Date.parse(entry.installedAt))
        ? new Date(entry.installedAt).toISOString()
        : undefined;
    return [
      {
        kind: entry.kind,
        name: entry.name,
        agent: entry.agent,
        ...(entry.kind === 'plugin' &&
        typeof entry.marketplace === 'string' &&
        MARKETPLACE_RE.test(entry.marketplace)
          ? { marketplace: entry.marketplace }
          : {}),
        ...(entry.scope === 'user' || entry.scope === 'project' || entry.scope === 'local'
          ? { scope: entry.scope }
          : {}),
        origin,
        verifiable:
          (entry.hashScheme === 'canonical-v1' || entry.hashScheme === 'canonical-v2') &&
          typeof entry.contentHash === 'string' &&
          /^[a-f0-9]{64}$/i.test(entry.contentHash),
        ...(entry.trust?.level === 'ok' || entry.trust?.level === 'caution'
          ? { trustLevel: entry.trust.level }
          : {}),
        ...(Array.isArray(entry.trust?.reasonCodes)
          ? { trustReasonCodes: entry.trust.reasonCodes.filter(isTrustReasonCode) }
          : {}),
        ...(installedAt ? { installedAt } : {}),
        ...(entry.op === 'install' || entry.op === 'update' ? { op: entry.op } : {}),
      },
    ];
  });
  return {
    status: result.status,
    version: 1,
    entries,
    withheld: Object.values(lock.entries).length - entries.length,
  };
}

function publicDelegatedResult(
  result: {
    status: string;
    agent: string;
    command: string;
    undoCommand?: string;
    exitCode?: number;
    lockWarning?: string;
    ledgerId?: string;
  },
  selector: string,
) {
  const coordinate = pluginCoordinate(selector);
  const status =
    result.status === 'preview' ||
    result.status === 'applied' ||
    result.status === 'nothing-to-do' ||
    result.status === 'failed' ||
    result.status === 'outcome-unknown'
      ? result.status
      : 'outcome-unknown';
  const delegatedId =
    typeof result.ledgerId === 'string' &&
    /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(result.ledgerId)
      ? result.ledgerId
      : undefined;
  return {
    status,
    agent: result.agent,
    name: coordinate.name,
    ...(coordinate.marketplace ? { marketplace: coordinate.marketplace } : {}),
    command: result.command,
    ...(delegatedId ? { delegatedId } : {}),
    ...((status === 'preview' || status === 'applied') && result.undoCommand
      ? { undoCommand: result.undoCommand }
      : {}),
    ...(Number.isSafeInteger(result.exitCode) ? { exitCode: result.exitCode } : {}),
    ...(status === 'failed'
      ? { errorCode: 'OPERATION_FAILED', recoveryClass: 'vendor-state-inspection' }
      : {}),
    ...(status === 'outcome-unknown'
      ? { errorCode: 'OUTCOME_UNKNOWN', recoveryClass: 'vendor-state-inspection' }
      : {}),
    ...(status === 'nothing-to-do' ? { reasonCode: 'NO_CHANGE' } : {}),
    ...(result.lockWarning ? { lockWarningCode: 'PROVENANCE_WARNING' } : {}),
    // This flag describes the delegated activity ledger (the provenance
    // contract shared with Web), not the best-effort fleet.lock fold.
    provenanceRecorded: delegatedId !== undefined,
  };
}

async function runPublicDelegatedPlans(
  plans: Awaited<ReturnType<typeof planPluginActions>>,
  opts: { commit: boolean; fleetHome?: string; runner?: Runner },
) {
  const results: Array<Record<string, unknown>> = [];
  for (const plan of plans) {
    try {
      results.push(publicDelegatedResult(await runDelegated(plan, opts), plan.selector));
    } catch (error) {
      const unknown = error instanceof DelegatedOutcomeUnknownError;
      const coordinate = pluginCoordinate(plan.selector);
      results.push({
        status: unknown ? 'outcome-unknown' : 'failed',
        agent: plan.agent,
        name: coordinate.name,
        ...(coordinate.marketplace ? { marketplace: coordinate.marketplace } : {}),
        command: plan.argv.join(' '),
        ...(unknown && error.ledgerId ? { delegatedId: error.ledgerId } : {}),
        errorCode: unknown ? 'OUTCOME_UNKNOWN' : 'OPERATION_FAILED',
        ...(unknown ? { recoveryClass: 'vendor-state-inspection' } : {}),
        provenanceRecorded: false,
      });
    }
  }
  return results;
}

function specFromArgs(a: Record<string, unknown>): McpServerSpec {
  const command = typeof a.command === 'string' ? a.command : undefined;
  const url = typeof a.url === 'string' ? a.url : undefined;
  if (command && url) {
    throw new Error("provide exactly one of 'command' (stdio) or 'url' (remote)");
  }
  if (command) {
    const args = Array.isArray(a.args) ? a.args.filter((x): x is string => typeof x === 'string') : undefined;
    return { transport: 'stdio', command, args: args && args.length ? args : undefined };
  }
  if (url) {
    return {
      transport: a.sse ? 'sse' : 'http',
      url,
      bearerTokenEnvVar: typeof a.bearerEnv === 'string' ? a.bearerEnv : undefined,
    };
  }
  throw new Error(
    "provide 'command' (stdio) or 'url' (remote), or use the 'sync' tool to copy from another agent",
  );
}

export function buildTools(
  adapters: AgentAdapter[],
  opts: {
    fleetHome?: string;
    pluginRunner?: Runner;
    sources?: FeedSource[];
    adapterLoadDiagnostics?: AdapterLoadDiagnostic[];
  } = {},
): FleetTool[] {
  const run = (plan: Plan, commit: unknown) =>
    execute(adapters, plan, { commit: commit === true, fleetHome: opts.fleetHome });
  const publicTargets = async (
    value: unknown,
    kind: 'mcp-server' | 'skill' | 'rule' = 'mcp-server',
  ): Promise<string[]> => {
    const targets = await resolveTargets(adapters, targetArg(value), kind);
    if (!targets.every(isPublicAgentId)) throw new Error('refusing non-public agent identity');
    return targets;
  };

  const tools: FleetTool[] = [
    {
      name: 'inventory',
      description:
        'List supported capability kinds across registered agents: MCP servers, skills, Fleet-managed rules, permissions, plugins, and subagents. Raw specs, source paths, descriptions, and prompts are omitted.',
      inputSchema: {},
      handler: async () => summarizeInventory(await buildInventory(adapters)),
    },
    {
      name: 'install',
      description:
        'Install an MCP server into one or more agents. DRY-RUN unless commit=true. ' +
        "Provide 'command' (+args) for stdio, or 'url' (+sse/bearerEnv) for remote.",
      inputSchema: {
        name: z.string(),
        to: z
          .union([z.string(), z.array(z.string())])
          .describe("agent ids (array or comma-separated), or 'all'"),
        command: z.string().optional(),
        args: z.array(z.string()).optional(),
        url: z.string().optional(),
        sse: z.boolean().optional(),
        bearerEnv: z.string().optional(),
        commit: z.boolean().optional().describe('apply the change (default false = dry-run)'),
      },
      handler: async (a) => {
        const spec = specFromArgs(a);
        const targets = await publicTargets(a.to);
        const plan = await planInstall(adapters, spec, publicCapabilityNameArg(a.name), 'user', targets, {
          fleetHome: opts.fleetHome,
        });
        return summarizeResult(await run(plan, a.commit));
      },
    },
    {
      name: 'sync',
      description:
        'Copy an MCP server from one agent to others ("apply to all"). DRY-RUN unless commit=true.',
      inputSchema: {
        name: z.string(),
        from: z.string(),
        fromScope: z.enum(['user', 'project', 'local']).optional(),
        to: z
          .union([z.string(), z.array(z.string())])
          .describe("agent ids (array or comma-separated), or 'all'"),
        commit: z.boolean().optional().describe('apply the change (default false = dry-run)'),
      },
      handler: async (a) => {
        const targets = await publicTargets(a.to);
        const plan = await planSync(
          adapters,
          publicCapabilityNameArg(a.name),
          publicAgentArg(a.from),
          targets,
          {
            fleetHome: opts.fleetHome,
            sourceScope: parseScope(a.fromScope, 'fromScope'),
          },
        );
        return summarizeResult(await run(plan, a.commit));
      },
    },
    {
      name: 'remove',
      description: 'Remove an MCP server from one or more agents. DRY-RUN unless commit=true.',
      inputSchema: {
        name: z.string(),
        from: z
          .union([z.string(), z.array(z.string())])
          .describe("agent ids (array or comma-separated), or 'all'"),
        scope: z.literal('user').optional().describe('writable scope (only user; default user)'),
        commit: z.boolean().optional().describe('apply the change (default false = dry-run)'),
      },
      handler: async (a) => {
        const targets = await publicTargets(a.from);
        const plan = await planRemove(
          adapters,
          publicCapabilityNameArg(a.name),
          targets,
          parseScope(a.scope) ?? 'user',
        );
        return summarizeResult(await run(plan, a.commit));
      },
    },
    {
      name: 'skill_sync',
      description: 'Copy a skill (SKILL.md directory) from one agent to others. DRY-RUN unless commit=true.',
      inputSchema: {
        name: z.string(),
        from: z.string(),
        fromScope: z.enum(['user', 'project', 'local']).optional(),
        to: z.union([z.string(), z.array(z.string())]).describe("agent ids or 'all'"),
        commit: z.boolean().optional(),
      },
      handler: async (a) => {
        const targets = await publicTargets(a.to, 'skill');
        return summarizeResult(
          await run(
            await planSyncSkill(adapters, publicCapabilityNameArg(a.name), publicAgentArg(a.from), targets, {
              fleetHome: opts.fleetHome,
              sourceScope: parseScope(a.fromScope, 'fromScope'),
            }),
            a.commit,
          ),
        );
      },
    },
    {
      name: 'skill_install',
      description:
        'Install a skill from a local directory into one or more agents. DRY-RUN unless commit=true.',
      inputSchema: {
        name: z.string(),
        fromDir: z.string().describe('local directory containing the skill (SKILL.md)'),
        to: z.union([z.string(), z.array(z.string())]).describe("agent ids or 'all'"),
        commit: z.boolean().optional(),
      },
      handler: async (a) => {
        const targets = await publicTargets(a.to, 'skill');
        const plan = await planInstallSkill(
          adapters,
          { name: publicCapabilityNameArg(a.name), dir: String(a.fromDir) },
          publicCapabilityNameArg(a.name),
          targets,
          { fleetHome: opts.fleetHome },
        );
        return summarizeResult(await run(plan, a.commit));
      },
    },
    {
      name: 'skill_remove',
      description: 'Remove a skill from one or more agents. DRY-RUN unless commit=true.',
      inputSchema: {
        name: z.string(),
        from: z.union([z.string(), z.array(z.string())]).describe("agent ids or 'all'"),
        commit: z.boolean().optional(),
      },
      handler: async (a) => {
        const targets = await publicTargets(a.from, 'skill');
        return summarizeResult(
          await run(await planRemoveSkill(adapters, publicCapabilityNameArg(a.name), targets), a.commit),
        );
      },
    },
    {
      name: 'rule_install',
      description:
        "Install a behavioral rule (instruction block) into one or more agents' instruction files (CLAUDE.md/AGENTS.md). DRY-RUN unless commit=true.",
      inputSchema: {
        name: z.string(),
        text: z.string().describe('the instruction text'),
        to: z.union([z.string(), z.array(z.string())]).describe("agent ids or 'all'"),
        commit: z.boolean().optional(),
      },
      handler: async (a) => {
        const targets = await publicTargets(a.to, 'rule');
        return summarizeResult(
          await run(
            await planInstallRule(adapters, publicCapabilityNameArg(a.name), String(a.text), targets),
            a.commit,
          ),
        );
      },
    },
    {
      name: 'rule_sync',
      description: 'Copy a rule (instruction block) from one agent to others. DRY-RUN unless commit=true.',
      inputSchema: {
        name: z.string(),
        from: z.string(),
        fromScope: z.enum(['user', 'project', 'local']).optional(),
        to: z.union([z.string(), z.array(z.string())]).describe("agent ids or 'all'"),
        commit: z.boolean().optional(),
      },
      handler: async (a) => {
        const targets = await publicTargets(a.to, 'rule');
        return summarizeResult(
          await run(
            await planSyncRule(adapters, publicCapabilityNameArg(a.name), publicAgentArg(a.from), targets, {
              sourceScope: parseScope(a.fromScope, 'fromScope'),
            }),
            a.commit,
          ),
        );
      },
    },
    {
      name: 'rule_remove',
      description: 'Remove a rule (instruction block) from one or more agents. DRY-RUN unless commit=true.',
      inputSchema: {
        name: z.string(),
        from: z.union([z.string(), z.array(z.string())]).describe("agent ids or 'all'"),
        commit: z.boolean().optional(),
      },
      handler: async (a) => {
        const targets = await publicTargets(a.from, 'rule');
        return summarizeResult(
          await run(await planRemoveRule(adapters, publicCapabilityNameArg(a.name), targets), a.commit),
        );
      },
    },
    {
      name: 'doctor',
      description:
        "Health checks over fleet's dependencies: agent adapters (configs parse?), fleet state (audit/backups/lock/ledger), and config.json. Read-only; exitCode 0 healthy / 1 warnings / 2 errors.",
      inputSchema: {},
      handler: async () => {
        const report = await runDoctor({
          adapters,
          fleetHome: opts.fleetHome,
          adapterLoadDiagnostics: opts.adapterLoadDiagnostics,
        });
        return {
          exitCode: report.exitCode,
          findings: report.findings.map((finding) => ({
            category: finding.category,
            level: finding.level,
            code: finding.code,
            ...(finding.agent && isPublicAgentId(finding.agent) ? { agent: finding.agent } : {}),
            ...(finding.recovery ? { recovery: finding.recovery } : {}),
          })),
        };
      },
    },
    {
      name: 'drift_check',
      description:
        "Diff live agent state against fleet.lock: 'modified' = content differs from what fleet installed (edited outside fleet or tampered); 'missing' = fleet installed it, gone now; plus capabilities fleet never installed. Read-only.",
      inputSchema: {},
      handler: async () =>
        publicDriftReport(await detectDrift(await buildInventory(adapters), opts.fleetHome)),
    },
    {
      name: 'lock_status',
      description:
        'Allowlisted provenance summary for fleet-installed capabilities. Local paths, hashes, audit ids, and free-form lock fields are omitted.',
      inputSchema: {},
      handler: async () => publicLockStatus(await readLockState(opts.fleetHome)),
    },
    {
      name: 'whats_new',
      description:
        "New & recommended capabilities for the user's agents, plus updates to installed ones. Heuristic ranking over sanitized metadata from registries, local marketplace mirrors, and optional configured sources; verify before installing. Served from a 15-min cache; pass refresh=true for live sources.",
      inputSchema: { refresh: z.boolean().optional() },
      handler: async (a) => {
        const inv = await buildInventory(adapters);
        const { items, failures, withheld } = await cachedDiscover(
          opts.sources ?? defaultSources(loadConfig(opts.fleetHome)),
          {
            fleetHome: opts.fleetHome,
            refresh: a.refresh === true,
          },
        );
        const { updates } = updatesForInventory(inv, items);
        const publicUpdates = updates.filter(
          (update) => isPublicCapabilityName(update.name) && isPublicAgentId(update.agent),
        );
        const ranked = await recommend(inv, items); // uncapped; sliced per kind below
        const mixed = [
          ...ranked.filter((r) => !r.item.kind || r.item.kind === 'mcp-server').slice(0, 10),
          ...diversifyByCategory(
            ranked.filter((r) => r.item.kind === 'skill'),
            10,
          ),
          ...diversifyByCategory(
            ranked.filter((r) => r.item.kind === 'plugin'),
            8,
          ),
        ];
        const recommendations = mixed.map((r) => ({
          name: r.item.name,
          kind: r.item.kind ?? 'mcp-server',
          category: r.item.category,
          identifier: r.item.identifier,
          url: r.item.url,
          source: r.item.source,
          score: Number(r.score.toFixed(2)),
          reasons: r.reasons.filter((reason) =>
            ['new', 'popular', 'marketplace', 'related'].includes(reason),
          ),
          trust: r.trust.level,
          trustReasonCodes: r.trust.reasons.filter((reason) =>
            [
              'REGISTRY_STATUS_CAUTION',
              'METADATA_STALE',
              'SOURCE_REPOSITORY_MISSING',
              'UPDATE_RECENCY_UNKNOWN',
              'NO_METADATA_FLAGS',
              'HUB_CAUTION',
              'HUB_NO_FLAGS',
              'HUB_UNKNOWN',
            ].includes(reason),
          ),
        }));
        const rawSkillUpdates = await skillUpdatesFromLock(inv, opts.fleetHome);
        const skillUpdates = rawSkillUpdates.filter(
          (update) =>
            isPublicCapabilityName(update.name) &&
            isPublicAgentId(update.agent) &&
            ['update', 'update+local-edits', 'update+missing', 'update+unverifiable'].includes(update.state),
        );
        return {
          updates: publicUpdates.map((update) => ({
            kind: 'mcp-server',
            name: update.name,
            agent: update.agent,
            scope: update.scope,
            to: update.available,
            // There is no MCP update mutation tool that can consume this
            // registry coordinate. Do not advertise a non-actionable operation.
            operation: null,
          })),
          skillUpdates: skillUpdates.map((update) => ({
            name: update.name,
            agent: update.agent,
            state: update.state,
          })),
          withheldSkillUpdates: rawSkillUpdates.length - skillUpdates.length,
          withheldUpdates: updates.length - publicUpdates.length,
          withheldRecommendations: withheld,
          recommendations,
          failures: failures.map((failure) => ({ source: failure.source, code: 'SOURCE_UNAVAILABLE' })),
          note: 'Heuristic (novelty+popularity+relevance); verify before installing. Skills are SAMPLED from skill registries (not exhaustive); plugins come from locally-registered marketplace catalogs (install via plugin_install). Absence of results may just mean sources were unreachable (see failures).',
        };
      },
    },
    {
      name: 'plugin_install',
      description:
        'Install a vendor plugin (bundle of skills/MCP/hooks — RUNS CODE) by delegating to a supported agent CLI (currently Claude Code via claude plugin install). DRY-RUN unless commit=true; the preview is the exact command. Verify the marketplace first. Recovery is suggested only when inventory proves a real state change; failed, unchanged, legacy, or unknown outcomes never get a destructive undo command.',
      inputSchema: {
        selector: z.string().describe('plugin[@marketplace]'),
        to: z.union([z.string(), z.array(z.string())]).describe("agent ids or 'all'"),
        commit: z.boolean().optional(),
      },
      handler: async (a) => {
        const plans = await planPluginActions(
          adapters,
          publicTargetSelector(a.to),
          'install',
          String(a.selector),
        );
        if (!plans.every((plan) => isPublicAgentId(plan.agent))) {
          throw new Error('refusing non-public agent identity');
        }
        const results = await runPublicDelegatedPlans(plans, {
          commit: a.commit === true,
          fleetHome: opts.fleetHome,
          runner: opts.pluginRunner,
        });
        return {
          results,
          note: 'Delegated to the vendor CLI — no fleet hash-guard/backup. Use undoCommand only for preview or inventory-verified applied results; failed or unknown outcomes require manual vendor-state inspection.',
        };
      },
    },
    {
      name: 'plugin_remove',
      description: "Remove a vendor plugin by delegating to the agent's own CLI. DRY-RUN unless commit=true.",
      inputSchema: {
        selector: z.string().describe('plugin[@marketplace]'),
        from: z.union([z.string(), z.array(z.string())]).describe("agent ids or 'all'"),
        commit: z.boolean().optional(),
      },
      handler: async (a) => {
        const plans = await planPluginActions(
          adapters,
          publicTargetSelector(a.from),
          'remove',
          String(a.selector),
        );
        if (!plans.every((plan) => isPublicAgentId(plan.agent))) {
          throw new Error('refusing non-public agent identity');
        }
        return {
          results: await runPublicDelegatedPlans(plans, {
            commit: a.commit === true,
            fleetHome: opts.fleetHome,
            runner: opts.pluginRunner,
          }),
        };
      },
    },
    {
      name: 'skill_search',
      description:
        'Search the skills.sh registry for agent skills by keyword. Returns name, category, install count, and the source repo URL. To install one: clone the repo, then use skill_install with fromDir.',
      inputSchema: { query: z.string().min(2).describe('search terms (2+ chars)') },
      handler: async (a) => {
        if (!feedSourceEnabled(loadConfig(opts.fleetHome), 'skills.sh')) {
          throw new FleetOperationError('TARGET_UNAVAILABLE', 'feed source unavailable');
        }
        const found = await new SkillsShSource().search(String(a.query));
        return {
          total: found.length,
          skills: found
            .sort((x, y) => (y.popularity ?? 0) - (x.popularity ?? 0))
            .slice(0, 20)
            .map((s) => ({
              name: s.name,
              category: s.category,
              installs: s.popularity,
              repo: s.url,
              identifier: s.identifier,
            })),
          note: 'From skills.sh (public metadata). Install counts are registry-reported; review a skill before installing.',
        };
      },
    },
    {
      name: 'conflicts',
      description:
        'Flag opposing ALWAYS-ON rules co-present on an agent (e.g. "be terse" vs "be detailed"). Heuristic candidates — verify before acting.',
      inputSchema: {},
      handler: async () => {
        const projected = publicConflictFindings(analyzeConflicts(await buildInventory(adapters)));
        return {
          findings: projected.findings.map((finding) => ({ ...finding, confidence: 'low' })),
          withheldCount: projected.withheldCount,
          note: 'Heuristic, low-confidence candidates. Only fleet-managed always-on rules are checked (not hand-written instruction prose). Absence of findings is NOT a guarantee of no conflict — verify before acting.',
        };
      },
    },
    {
      name: 'rollback',
      description:
        'Immediately undo a specific core change by audit id, or the latest core change only when no newer delegated plugin action exists.',
      inputSchema: { auditId: z.string().optional() },
      handler: async (a) => {
        const auditId = typeof a.auditId === 'string' ? a.auditId : undefined;
        const result = await rollback({
          auditId,
          fleetHome: opts.fleetHome,
          ...(!auditId
            ? {
                implicitGuard: (audit: import('../core/writer.js').AuditReadResult) =>
                  assessImplicitRollback(audit, opts.fleetHome),
              }
            : {}),
        });
        if (result.guardRefusal) return { action: 'skipped', ...result.guardRefusal };
        return {
          action: result.action,
          ...(publicRollbackReasonCode(result.reason)
            ? { reasonCode: publicRollbackReasonCode(result.reason) }
            : {}),
          ...(result.auditRecorded === false && result.action !== 'skipped'
            ? { provenanceRecorded: false, recoveryClass: 'audit-history-repair' }
            : {}),
          ...(result.lockWarning ? { lockWarningCode: 'PROVENANCE_WARNING' } : {}),
        };
      },
    },
  ];
  return tools.map(secureTool);
}
