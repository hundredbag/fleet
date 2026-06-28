import { z } from 'zod';
import type { AgentAdapter } from '../core/adapter.js';
import type { McpServerSpec } from '../core/types.js';
import { buildInventory } from '../core/inventory.js';
import {
  planInstall,
  planRemove,
  planSync,
  execute,
  resolveTargets,
  type Plan,
} from '../core/orchestrator.js';
import { rollback } from '../core/writer.js';
import { summarizeInventory, summarizeResult } from '../core/redact.js';

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
    const args = Array.isArray(a.args)
      ? a.args.filter((x): x is string => typeof x === 'string')
      : undefined;
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
  opts: { fleetHome?: string } = {},
): FleetTool[] {
  const run = (plan: Plan, commit: unknown) =>
    execute(adapters, plan, { commit: commit === true, fleetHome: opts.fleetHome });

  return [
    {
      name: 'inventory',
      description:
        'List MCP servers installed across all detected agents (read-only). Secrets are redacted.',
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
        to: z.union([z.string(), z.array(z.string())]).describe("agent ids (array or comma-separated), or 'all'"),
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
        to: z.union([z.string(), z.array(z.string())]).describe("agent ids (array or comma-separated), or 'all'"),
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
        from: z.union([z.string(), z.array(z.string())]).describe("agent ids (array or comma-separated), or 'all'"),
        commit: z.boolean().optional().describe('apply the change (default false = dry-run)'),
      },
      handler: async (a) => {
        const targets = await resolveTargets(adapters, targetArg(a.from));
        const plan = await planRemove(adapters, String(a.name), targets);
        return summarizeResult(await run(plan, a.commit));
      },
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
