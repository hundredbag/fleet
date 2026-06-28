#!/usr/bin/env node
import { defaultAdapters } from '../core/registry.js';
import { buildInventory } from '../core/inventory.js';
import { renderInventory } from './render.js';

const HELP = `fleet — unified cross-agent capability manager (v0)

Usage:
  fleet inventory [--json]   Show installed capabilities across all agents
  fleet help                 Show this help

v0 is read-only and covers the MCP-server primitive.`;

async function main(argv: string[]): Promise<number> {
  // Allow flags without a subcommand: `fleet --json` ⇒ default `inventory`.
  const first = argv[0];
  const cmd = first && !first.startsWith('-') ? first : 'inventory';
  const flags = first && !first.startsWith('-') ? argv.slice(1) : argv;
  switch (cmd) {
    case 'inventory': {
      const inv = await buildInventory(defaultAdapters());
      if (flags.includes('--json')) {
        process.stdout.write(JSON.stringify(inv, null, 2) + '\n');
      } else {
        process.stdout.write(renderInventory(inv) + '\n');
      }
      return 0;
    }
    case 'help':
    case '-h':
    case '--help':
      process.stdout.write(HELP + '\n');
      return 0;
    default:
      process.stderr.write(`fleet: unknown command '${cmd}'\n\n${HELP}\n`);
      return 1;
  }
}

main(process.argv.slice(2))
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err) => {
    console.error('fleet: fatal:', err);
    process.exitCode = 1;
  });
