import type { FeedSource } from './source.js';
import { loadConfig, type FleetConfig } from '../core/config.js';
import { McpRegistrySource } from './sources/mcp-registry.js';
import { PulseMcpSource } from './sources/pulsemcp.js';
import { FleetHubSource } from './sources/hub.js';

/**
 * The default live feed sources. The MCP Registry (novelty/version/identifier)
 * is always on. The central hub (curated, enriched metadata) joins when
 * `hubUrl` is configured. PulseMCP (popularity) is opt-in — it needs an API key,
 * so it only joins when PULSEMCP_API_KEY is set (otherwise every request 401s).
 */
export function defaultSources(config: FleetConfig = loadConfig()): FeedSource[] {
  const sources: FeedSource[] = [new McpRegistrySource()];
  if (config.hubUrl) sources.push(new FleetHubSource(config.hubUrl));
  const pulseKey = process.env.PULSEMCP_API_KEY;
  if (pulseKey) sources.push(new PulseMcpSource({ apiKey: pulseKey }));
  return sources;
}
