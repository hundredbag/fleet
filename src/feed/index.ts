import type { FeedSource } from './source.js';
import { loadConfig, type FleetConfig } from '../core/config.js';
import { McpRegistrySource } from './sources/mcp-registry.js';
import { PulseMcpSource } from './sources/pulsemcp.js';
import { SkillsShSource } from './sources/skills-sh.js';
import { SkillsMpSource, ClawHubSource, ClaudeSkillsInfoSource } from './sources/skill-registries.js';
import { FleetHubSource } from './sources/hub.js';

/**
 * The default live feed sources. The MCP Registry (novelty/version/identifier)
 * and the skill registries (skills.sh installs + SkillsMP description/updatedAt +
 * ClawHub native categories/quality + ClaudeSkills.info curation) are always on —
 * the same skill found on several registries is merged by its canonical
 * owner/repo/skill identifier. The central hub joins when `hubUrl` is
 * configured. PulseMCP (popularity) is opt-in (PULSEMCP_API_KEY).
 */
export function defaultSources(config: FleetConfig = loadConfig()): FeedSource[] {
  const sources: FeedSource[] = [
    new McpRegistrySource(),
    new SkillsShSource(),
    new SkillsMpSource(),
    new ClawHubSource(),
    new ClaudeSkillsInfoSource(),
  ];
  if (config.hubUrl) sources.push(new FleetHubSource(config.hubUrl));
  const pulseKey = process.env.PULSEMCP_API_KEY;
  if (pulseKey) sources.push(new PulseMcpSource({ apiKey: pulseKey }));
  return sources;
}
