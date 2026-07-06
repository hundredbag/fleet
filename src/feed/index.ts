import type { FeedSource } from './source.js';
import { loadConfig, type FleetConfig } from '../core/config.js';
import { McpRegistrySource } from './sources/mcp-registry.js';
import { PulseMcpSource } from './sources/pulsemcp.js';
import { SkillsShSource } from './sources/skills-sh.js';
import { SkillsMpSource, ClaudeSkillsInfoSource } from './sources/skill-registries.js';
import { LocalMarketplacesSource } from './sources/local-marketplaces.js';
import { FleetHubSource } from './sources/hub.js';

/**
 * The default live feed sources. Always on: the MCP Registry (novelty/version/
 * identifier), the skill registries (skills.sh installs + SkillsMP description/
 * updatedAt + ClaudeSkills.info curation — same skill across registries merges
 * by its canonical owner/repo/skill id), and locally-registered plugin
 * marketplace catalogs. The central hub joins when `hubUrl` is configured;
 * PulseMCP (popularity) is opt-in (PULSEMCP_API_KEY).
 */
export function defaultSources(config: FleetConfig = loadConfig()): FeedSource[] {
  // ORDER MATTERS for merged items: discover() is first-source-wins on field
  // conflicts, so skills.sh comes first among skill registries — its install
  // counts are the truest popularity signal (stars/downloads fill gaps only).
  // ClawHub is EXCLUDED: clawhub-skills.com blocks Node's TLS fingerprint
  // (403 for any node client; curl passes) — nothing sane fixes that client-
  // side. Revisit via the central hub (server-side collection) later.
  const sources: FeedSource[] = [
    new McpRegistrySource(),
    new SkillsShSource(),
    new SkillsMpSource(),
    new ClaudeSkillsInfoSource(),
    new LocalMarketplacesSource(),
  ];
  if (config.hubUrl) sources.push(new FleetHubSource(config.hubUrl));
  const pulseKey = process.env.PULSEMCP_API_KEY;
  if (pulseKey) sources.push(new PulseMcpSource({ apiKey: pulseKey }));
  return sources;
}
