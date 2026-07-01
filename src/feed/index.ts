import type { FeedSource } from './source.js';
import { McpRegistrySource } from './sources/mcp-registry.js';
import { PulseMcpSource } from './sources/pulsemcp.js';

/**
 * The default live feed sources. The MCP Registry (novelty/version/identifier)
 * is always on; PulseMCP (popularity) is opt-in — it requires an API key, so it
 * only joins when PULSEMCP_API_KEY is set (otherwise every request 401s).
 */
export function defaultSources(): FeedSource[] {
  const sources: FeedSource[] = [new McpRegistrySource()];
  const pulseKey = process.env.PULSEMCP_API_KEY;
  if (pulseKey) sources.push(new PulseMcpSource({ apiKey: pulseKey }));
  return sources;
}
