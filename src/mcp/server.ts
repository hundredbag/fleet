#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { defaultAdapters } from '../core/registry.js';
import { buildTools } from './tools.js';

/**
 * The MCP server face: exposes fleet's capabilities as tools so any MCP client
 * (Claude Code, Codex, Gemini) can drive the whole fleet in-loop. A thin shell
 * over buildTools()/the core — all logic and safety live there.
 */
async function main(): Promise<void> {
  const server = new McpServer({ name: 'fleet', version: '0.0.1' });

  for (const tool of buildTools(defaultAdapters())) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, (async (
      args: Record<string, unknown>,
    ) => {
      try {
        const result = await tool.handler(args ?? {});
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `fleet: ${err instanceof Error ? err.message : String(err)}` }],
        };
      }
    }) as never);
  }

  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  process.stderr.write(`fleet-mcp: ${e instanceof Error ? e.message : String(e)}\n`);
  process.exitCode = 1;
});
