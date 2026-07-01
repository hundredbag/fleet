import { basename } from 'node:path';
import type { McpServerSpec } from '../core/types.js';

/**
 * A package coordinate extracted from an installed MCP server's spec, used to
 * match it against registry FeedItems. Only `high` confidence drives an
 * "update available" claim; everything else is "present, unmatched".
 */
export interface Coordinate {
  ecosystem: 'npm' | 'pypi' | 'other';
  id: string;
  version?: string;
  confidence: 'high' | 'low';
}

// flags that consume the following arg (so its value isn't mistaken for a package)
const VALUE_FLAGS = new Set([
  '-p',
  '--package',
  '--loglevel',
  '--python',
  '--from',
  '-c',
  '--call',
  '--with',
]);
// flags whose value IS the package to resolve
const EXPLICIT_PKG = new Set(['-p', '--package', '--from']);

function splitPkg(pkg: string): { id: string; version?: string } {
  const at = pkg.lastIndexOf('@');
  if (at > 0) {
    const v = pkg.slice(at + 1);
    return { id: pkg.slice(0, at), version: v || undefined };
  }
  return { id: pkg };
}

/** Pick the package token from a runner's args, honoring -p/--package/--from and
 * skipping value-taking flags. */
function pickPackage(args: string[]): string | undefined {
  for (let i = 0; i < args.length - 1; i++) {
    if (EXPLICIT_PKG.has(args[i]!)) return args[i + 1];
  }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('-')) {
      if (VALUE_FLAGS.has(a)) i++; // skip its value too
      continue;
    }
    if (a === 'run') continue;
    return a;
  }
  return undefined;
}

/** Best-effort package coordinate for an MCP server spec, or null. */
export function extractCoordinate(spec: McpServerSpec): Coordinate | null {
  if (spec.transport === 'stdio') {
    const cmd = basename(spec.command).replace(/\.(cmd|exe|ps1|bat)$/i, '');
    const pkg = pickPackage(spec.args ?? []);
    if (cmd === 'npx' && pkg) return { ecosystem: 'npm', ...splitPkg(pkg), confidence: 'high' };
    if ((cmd === 'uvx' || cmd === 'pipx') && pkg) {
      return { ecosystem: 'pypi', ...splitPkg(pkg), confidence: 'high' };
    }
    // running a local script (node/python/deno/bun/ruby ...) → no registry coordinate
    if (['node', 'python', 'python3', 'deno', 'bun', 'ruby'].includes(cmd)) return null;
    return { ecosystem: 'other', id: cmd, confidence: 'low' };
  }
  try {
    return { ecosystem: 'other', id: new URL(spec.url).host, confidence: 'low' };
  } catch {
    return null;
  }
}
