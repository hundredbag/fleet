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
import { summarizeInventory, summarizeResult } from '../core/redact.js';
import { runDoctor } from '../core/doctor.js';
import { analyzeConflicts } from '../core/conflicts.js';
import { defaultSources } from '../feed/index.js';
import { discover, updatesForInventory } from '../feed/feed.js';
import { recommend, diversifyByCategory } from '../feed/recommend.js';
import { SkillsShSource } from '../feed/sources/skills-sh.js';
import { planPluginAction, runDelegated } from '../core/delegate.js';

const targetArg = (v: unknown): string => (Array.isArray(v) ? v.join(',') : String(v));

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

export function buildTools(adapters: AgentAdapter[], opts: { fleetHome?: string } = {}): FleetTool[] {
  const run = (plan: Plan, commit: unknown) =>
    execute(adapters, plan, { commit: commit === true, fleetHome: opts.fleetHome });

  return [
    {
      name: 'inventory',
      description: 'List MCP servers installed across all detected agents (read-only). Secrets are redacted.',
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
        const targets = await resolveTargets(adapters, targetArg(a.to));
        const plan = await planInstall(adapters, spec, String(a.name), 'user', targets);
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
        to: z
          .union([z.string(), z.array(z.string())])
          .describe("agent ids (array or comma-separated), or 'all'"),
        commit: z.boolean().optional().describe('apply the change (default false = dry-run)'),
      },
      handler: async (a) => {
        const targets = await resolveTargets(adapters, targetArg(a.to));
        const plan = await planSync(adapters, String(a.name), String(a.from), targets);
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
        commit: z.boolean().optional().describe('apply the change (default false = dry-run)'),
      },
      handler: async (a) => {
        const targets = await resolveTargets(adapters, targetArg(a.from));
        const plan = await planRemove(adapters, String(a.name), targets);
        return summarizeResult(await run(plan, a.commit));
      },
    },
    {
      name: 'skill_sync',
      description: 'Copy a skill (SKILL.md directory) from one agent to others. DRY-RUN unless commit=true.',
      inputSchema: {
        name: z.string(),
        from: z.string(),
        to: z.union([z.string(), z.array(z.string())]).describe("agent ids or 'all'"),
        commit: z.boolean().optional(),
      },
      handler: async (a) => {
        const targets = await resolveTargets(adapters, targetArg(a.to));
        return summarizeResult(
          await run(await planSyncSkill(adapters, String(a.name), String(a.from), targets), a.commit),
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
        const targets = await resolveTargets(adapters, targetArg(a.to));
        const plan = await planInstallSkill(
          adapters,
          { name: String(a.name), dir: String(a.fromDir) },
          String(a.name),
          targets,
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
        const targets = await resolveTargets(adapters, targetArg(a.from));
        return summarizeResult(await run(await planRemoveSkill(adapters, String(a.name), targets), a.commit));
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
        const targets = await resolveTargets(adapters, targetArg(a.to));
        return summarizeResult(
          await run(await planInstallRule(adapters, String(a.name), String(a.text), targets), a.commit),
        );
      },
    },
    {
      name: 'rule_sync',
      description: 'Copy a rule (instruction block) from one agent to others. DRY-RUN unless commit=true.',
      inputSchema: {
        name: z.string(),
        from: z.string(),
        to: z.union([z.string(), z.array(z.string())]).describe("agent ids or 'all'"),
        commit: z.boolean().optional(),
      },
      handler: async (a) => {
        const targets = await resolveTargets(adapters, targetArg(a.to));
        return summarizeResult(
          await run(await planSyncRule(adapters, String(a.name), String(a.from), targets), a.commit),
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
        const targets = await resolveTargets(adapters, targetArg(a.from));
        return summarizeResult(await run(await planRemoveRule(adapters, String(a.name), targets), a.commit));
      },
    },
    {
      name: 'doctor',
      description:
        "Health checks over fleet's dependencies: agent adapters (configs parse?), fleet state (audit/backups/lock/ledger), and config.json. Read-only; exitCode 0 healthy / 1 warnings / 2 errors.",
      inputSchema: {},
      handler: async () => runDoctor({ adapters }),
    },
    {
      name: 'whats_new',
      description:
        "New & recommended capabilities for the user's agents, plus updates to installed ones. Heuristic ranking (novelty + popularity + relevance to what they use); public-registry data only; verify before installing.",
      inputSchema: {},
      handler: async () => {
        const inv = await buildInventory(adapters);
        const { items, failures } = await discover(defaultSources());
        const { updates } = updatesForInventory(inv, items);
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
          reasons: r.reasons,
          trust: r.trust,
        }));
        return {
          updates,
          recommendations,
          failures,
          note: 'Heuristic (novelty+popularity+relevance); verify before installing. Skills are SAMPLED from skill registries (not exhaustive); plugins come from locally-registered marketplace catalogs (install via plugin_install). Absence of results may just mean sources were unreachable (see failures).',
        };
      },
    },
    {
      name: 'plugin_install',
      description:
        "Install a vendor plugin (bundle of skills/MCP/hooks — RUNS CODE) by delegating to the agent's own CLI (claude plugin install / codex plugin add). DRY-RUN unless commit=true; the preview is the exact command. Verify the marketplace first. Undo = plugin_remove.",
      inputSchema: {
        selector: z.string().describe('plugin[@marketplace]'),
        to: z.union([z.string(), z.array(z.string())]).describe("agent ids or 'all'"),
        commit: z.boolean().optional(),
      },
      handler: async (a) => {
        const targets = await resolveTargets(adapters, targetArg(a.to));
        const results = [];
        for (const agent of targets) {
          results.push(
            await runDelegated(planPluginAction(agent, 'install', String(a.selector)), {
              commit: a.commit === true,
              fleetHome: opts.fleetHome,
            }),
          );
        }
        return {
          results,
          note: 'Delegated to the vendor CLI — no fleet hash-guard/backup; undo via plugin_remove.',
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
        const targets = await resolveTargets(adapters, targetArg(a.from));
        const results = [];
        for (const agent of targets) {
          results.push(
            await runDelegated(planPluginAction(agent, 'remove', String(a.selector)), {
              commit: a.commit === true,
              fleetHome: opts.fleetHome,
            }),
          );
        }
        return { results };
      },
    },
    {
      name: 'skill_search',
      description:
        'Search the skills.sh registry for agent skills by keyword. Returns name, category, install count, and the source repo URL. To install one: clone the repo, then use skill_install with fromDir.',
      inputSchema: { query: z.string().min(2).describe('search terms (2+ chars)') },
      handler: async (a) => {
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
      handler: async () => ({
        findings: analyzeConflicts(await buildInventory(adapters)),
        note: 'Heuristic, low-confidence candidates. Only fleet-managed always-on rules are checked (not hand-written instruction prose). Absence of findings is NOT a guarantee of no conflict — verify before acting.',
      }),
    },
    {
      name: 'rollback',
      description: 'Undo the last applied change, or a specific one by audit id.',
      inputSchema: { auditId: z.string().optional() },
      handler: async (a) =>
        rollback({
          auditId: typeof a.auditId === 'string' ? a.auditId : undefined,
          fleetHome: opts.fleetHome,
        }),
    },
  ];
}
