import type { FeedSource } from './source.js';
import { McpRegistrySource } from './sources/mcp-registry.js';
import { PulseMcpSource } from './sources/pulsemcp.js';

/** The default live feed sources (novelty from the registry + popularity from PulseMCP). */
export function defaultSources(): FeedSource[] {
  return [new McpRegistrySource(), new PulseMcpSource()];
}
