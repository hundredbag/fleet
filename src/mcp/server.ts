#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadAdapters } from '../core/registry.js';
import { buildTools } from './tools.js';
import { publicErrorCode, publicPayload } from '../core/redact.js';
import type { AdapterLoadDiagnostic } from '../core/plugins.js';

/**
 * The MCP server face: exposes fleet's capabilities as tools so any MCP client
 * (Claude Code, Codex, Gemini) can drive the whole fleet in-loop. A thin shell
 * over buildTools()/the core — all logic and safety live there.
 */
async function main(): Promise<void> {
  const server = new McpServer({ name: 'fleet', version: '0.1.0' });

  const adapterLoadDiagnostics: AdapterLoadDiagnostic[] = [];
  const adapters = await loadAdapters(undefined, undefined, (diagnostic) =>
    adapterLoadDiagnostics.push(diagnostic),
  );
  for (const tool of buildTools(adapters, { adapterLoadDiagnostics })) {
    server.registerTool(tool.name, { description: tool.description, inputSchema: tool.inputSchema }, (async (
      args: Record<string, unknown>,
    ) => {
      try {
        const result = publicPayload(await tool.handler(args ?? {}));
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: 'text', text: `fleet: ${publicErrorCode(err)}` }],
        };
      }
    }) as never);
  }

  await server.connect(new StdioServerTransport());
}

main().catch((e) => {
  // stderr is commonly captured by MCP hosts, so startup failures use the
  // same fixed-code boundary as tool failures instead of forwarding adapter or
  // transport exception text.
  process.stderr.write(`fleet-mcp: ${publicErrorCode(e)}\n`);
  process.exitCode = 1;
});
