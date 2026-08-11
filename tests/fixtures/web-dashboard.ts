import type { AgentAdapter } from '../../src/core/adapter.js';
import type { InstalledCapability } from '../../src/core/types.js';
import type { FeedSource } from '../../src/feed/source.js';

const SHARED_SKILL_CONTENT = '# Shared review\nReview changes before applying them.\n';

const fixtureWriters = {
  supportsWrite: true,
  async renderInstall() {
    throw new Error('fixture render is not executable');
  },
  async renderRemove() {
    throw new Error('fixture render is not executable');
  },
  validate() {},
  async renderInstallSkill() {
    throw new Error('fixture render is not executable');
  },
  async renderRemoveSkill() {
    throw new Error('fixture render is not executable');
  },
  async renderInstallRule() {
    throw new Error('fixture render is not executable');
  },
  async renderRemoveRule() {
    throw new Error('fixture render is not executable');
  },
};

const claudeInventory: InstalledCapability[] = [
  {
    kind: 'mcp-server',
    name: 'playwright',
    agent: 'claude-code',
    scope: 'user',
    enabled: true,
    spec: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@playwright/mcp@1.0.0'],
    },
    source: { file: '/fixture/claude/settings.json', pointer: '/mcpServers/playwright' },
  },
  {
    kind: 'mcp-server',
    name: 'github',
    agent: 'claude-code',
    scope: 'user',
    enabled: true,
    spec: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-github@1.0.0'],
    },
    source: { file: '/fixture/claude/settings.json', pointer: '/mcpServers/github' },
  },
  {
    kind: 'skill',
    name: 'shared-review',
    agent: 'claude-code',
    scope: 'user',
    enabled: true,
    path: '/fixture/claude/skills/shared-review',
    meta: { description: 'Review changes before applying them.', version: '1.0.0' },
    raw: { content: SHARED_SKILL_CONTENT },
    source: { file: '/fixture/claude/skills/shared-review/SKILL.md' },
  },
  {
    kind: 'skill',
    name: 'claude-only-debugging',
    agent: 'claude-code',
    scope: 'user',
    enabled: true,
    path: '/fixture/claude/skills/claude-only-debugging',
    meta: { description: 'Use a reproducible debugging checklist.', version: '1.0.0' },
    source: { file: '/fixture/claude/skills/claude-only-debugging/SKILL.md' },
  },
  {
    kind: 'rule',
    name: 'verify-before-apply',
    agent: 'claude-code',
    scope: 'user',
    enabled: true,
    body: 'Show a preview and verify the target before applying a change.',
    source: { file: '/fixture/claude/CLAUDE.md' },
  },
  {
    kind: 'plugin',
    name: 'review-tools',
    agent: 'claude-code',
    scope: 'user',
    enabled: true,
    marketplace: 'fixture-marketplace',
    description: 'Deterministic review helpers.',
    source: { file: '/fixture/claude/plugins/review-tools' },
  },
];

const codexInventory: InstalledCapability[] = [
  {
    kind: 'mcp-server',
    name: 'playwright',
    agent: 'codex',
    scope: 'user',
    enabled: true,
    spec: {
      transport: 'stdio',
      command: 'npx',
      args: ['-y', '@playwright/mcp@2.0.0'],
    },
    source: { file: '/fixture/codex/config.toml', pointer: '/mcp_servers/playwright' },
  },
  {
    kind: 'skill',
    name: 'shared-review',
    agent: 'codex',
    scope: 'user',
    enabled: true,
    path: '/fixture/codex/skills/shared-review',
    meta: { description: 'Review changes before applying them.', version: '1.0.0' },
    raw: { content: SHARED_SKILL_CONTENT },
    source: { file: '/fixture/codex/skills/shared-review/SKILL.md' },
  },
];

export const dashboardAdapters: AgentAdapter[] = [
  {
    id: 'claude-code',
    displayName: 'Claude Code',
    ...fixtureWriters,
    capabilitySupport: {
      'mcp-server': { inventory: 'supported', management: 'writable' },
      skill: { inventory: 'supported', management: 'writable' },
      rule: { inventory: 'supported', management: 'writable' },
      plugin: { inventory: 'supported', management: 'delegated' },
    },
    async detect() {
      return {
        id: 'claude-code',
        displayName: 'Claude Code',
        present: true,
        configPaths: ['/fixture/claude/settings.json'],
      };
    },
    async readInventory() {
      return structuredClone(claudeInventory);
    },
  },
  {
    id: 'codex',
    displayName: 'Codex',
    ...fixtureWriters,
    capabilitySupport: {
      'mcp-server': { inventory: 'supported', management: 'writable' },
      skill: { inventory: 'supported', management: 'writable' },
      rule: { inventory: 'supported', management: 'writable' },
      plugin: { inventory: 'supported', management: 'delegated' },
    },
    async detect() {
      return {
        id: 'codex',
        displayName: 'Codex',
        present: true,
        configPaths: ['/fixture/codex/config.toml'],
      };
    },
    async readInventory() {
      return structuredClone(codexInventory);
    },
  },
];

export const dashboardFeedSources: FeedSource[] = [
  {
    id: 'dashboard-registry',
    async list() {
      return [
        {
          name: 'playwright',
          source: 'dashboard-registry',
          identifier: '@playwright/mcp',
          ecosystem: 'npm' as const,
          version: '2.0.0',
          url: 'https://example.test/playwright',
          updatedAt: '2099-01-01T00:00:00.000Z',
          popularity: 100,
        },
        {
          name: 'trusted-browser-tools',
          source: 'dashboard-registry',
          identifier: '@fleet/trusted-browser-tools',
          ecosystem: 'npm' as const,
          version: '1.0.0',
          url: 'https://example.test/trusted-browser-tools',
          updatedAt: '2099-01-01T00:00:00.000Z',
          popularity: 100,
          description: 'Browser workflow utilities with current public metadata.',
        },
        {
          name: 'caution-legacy-tools',
          source: 'dashboard-registry',
          identifier: '@fleet/caution-legacy-tools',
          ecosystem: 'npm' as const,
          version: '1.0.0',
          url: 'https://example.test/caution-legacy-tools',
          updatedAt: '2020-01-01T00:00:00.000Z',
          popularity: 10,
          status: 'deprecated',
          description: 'Legacy workflow utilities retained for compatibility.',
        },
      ];
    },
  },
];

/** A deterministic failure used to prove caught source details never become browser data. */
export const dashboardFailingFeedSource: FeedSource = {
  id: 'dashboard-failing-registry',
  async list() {
    throw new Error('DASHBOARD_FIXTURE_CAUGHT_ERROR_DETAIL');
  },
};
