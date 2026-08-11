import { makeToken } from '../../src/web/security.js';
import { createFleetServer } from '../../src/web/server.js';
import { ClaudeCodeAdapter } from '../../src/adapters/claude-code.js';
import { CodexAdapter } from '../../src/adapters/codex.js';
import type { FeedSource } from '../../src/feed/source.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export interface WebFixtureServer {
  server: Server;
  root: string;
  paths: string[];
  url: string;
  close(): Promise<void>;
}

export interface WebFixtureServerOptions {
  /** Test seam for proving cleanup when initialization fails before listen(). */
  afterRootCreated?(root: string): void;
}

const fixtureSources: FeedSource[] = [
  {
    id: 'fixture-feed',
    async list() {
      return [
        {
          name: 'fixture-recommendation',
          source: 'fixture-feed',
          identifier: '@fleet/fixture',
          ecosystem: 'npm',
          popularity: 42,
        },
      ];
    },
  },
];

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

/** Start a browser-ready dashboard without consulting any real user config. */
export async function startWebFixtureServer(
  token = makeToken(),
  options: WebFixtureServerOptions = {},
): Promise<WebFixtureServer> {
  const root = mkdtempSync(join(tmpdir(), 'fleet-web-fixture-'));
  let server: Server | undefined;

  try {
    options.afterRootCreated?.(root);

    const fleetHome = join(root, 'fleet-home');
    const claudeRoot = join(root, 'claude');
    const codexRoot = join(root, 'codex');
    const claudeConfig = join(claudeRoot, '.claude.json');
    const claudeSkills = join(claudeRoot, 'skills');
    const claudeRules = join(claudeRoot, 'CLAUDE.md');
    const claudeSettings = join(claudeRoot, 'settings.json');
    const claudePlugins = join(claudeRoot, 'plugins');
    const codexConfig = join(codexRoot, 'config.toml');
    const codexSkills = join(codexRoot, 'skills');
    const codexRules = join(codexRoot, 'AGENTS.md');
    const codexPlugins = join(codexRoot, 'plugins');
    const sharedSkills = join(root, 'shared-skills');

    const paths = [
      fleetHome,
      claudeConfig,
      claudeSkills,
      claudeRules,
      claudeSettings,
      claudePlugins,
      codexConfig,
      codexSkills,
      codexRules,
      codexPlugins,
      sharedSkills,
    ];

    mkdirSync(fleetHome, { recursive: true });
    mkdirSync(join(claudeSkills, 'fixture-claude-skill'), { recursive: true });
    mkdirSync(claudePlugins, { recursive: true });
    mkdirSync(join(codexSkills, 'fixture-codex-skill'), { recursive: true });
    mkdirSync(join(codexPlugins, 'fixture-codex-plugin'), { recursive: true });
    mkdirSync(sharedSkills, { recursive: true });
    writeFileSync(
      claudeConfig,
      JSON.stringify({
        mcpServers: {
          'fixture-claude': { command: 'fixture-claude-command', args: ['--fixture'] },
        },
      }),
    );
    writeFileSync(
      claudeSettings,
      JSON.stringify({ enabledPlugins: { 'fixture-claude-plugin@fixture-market': true } }),
    );
    writeFileSync(
      claudeRules,
      '<!-- fleet:rule:fixture-claude-rule -->\nUse fixture data only.\n<!-- /fleet:rule:fixture-claude-rule -->\n',
    );
    writeFileSync(join(claudeSkills, 'fixture-claude-skill', 'SKILL.md'), '# Fixture Claude skill\n');
    writeFileSync(
      codexConfig,
      '[mcp_servers.fixture-codex]\ncommand = "fixture-codex-command"\nargs = ["--fixture"]\n',
    );
    writeFileSync(
      codexRules,
      '<!-- fleet:rule:fixture-codex-rule -->\nUse fixture data only.\n<!-- /fleet:rule:fixture-codex-rule -->\n',
    );
    writeFileSync(join(codexSkills, 'fixture-codex-skill', 'SKILL.md'), '# Fixture Codex skill\n');

    const adapters = [
      new ClaudeCodeAdapter(claudeConfig, claudeSkills, claudeRules, claudeSettings, claudePlugins),
      new CodexAdapter(codexConfig, codexSkills, codexRules, sharedSkills),
    ];
    ({ server } = createFleetServer(adapters, { token, fleetHome, sources: fixtureSources }));

    await new Promise<void>((resolve, reject) => {
      server!.once('error', reject);
      server!.listen(0, '127.0.0.1', () => {
        server!.off('error', reject);
        resolve();
      });
    });

    const port = (server.address() as AddressInfo).port;
    const url = new URL(`http://127.0.0.1:${port}/`);
    url.searchParams.set('token', token);
    let closed = false;
    const close = async (): Promise<void> => {
      if (closed) return;
      closed = true;
      await closeServer(server!);
      rmSync(root, { recursive: true, force: true });
    };

    return { server, root, paths, url: url.toString(), close };
  } catch (error) {
    if (server) await closeServer(server);
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}

async function main(): Promise<void> {
  const fixture = await startWebFixtureServer();
  const shutdown = () => {
    void fixture.close().catch((error) => {
      process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
  process.stdout.write(`${fixture.url}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
