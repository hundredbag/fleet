import { readdir, readFile, lstat, readlink } from 'node:fs/promises';
import { join, extname } from 'node:path';
import type { CapabilityOrigin } from './lock.js';

/**
 * Install-time trust gate (M6, finally wired): a verdict computed at PLAN time
 * so every face's preview carries it, enforced according to config.trustPolicy
 * ('warn' default — surface as warnings; 'block' — refuse caution-level plans).
 * Deliberately local + static: file-tree facts, not an LLM "looks safe" (2026
 * research: semantic evasion beats LLM-only skill review 36–100% of the time).
 */

export interface GateVerdict {
  level: 'ok' | 'caution';
  reasons: string[];
}

// Unicode that hides content from human review (bidi overrides, zero-widths) —
// the check Microsoft APM ships and ClawHavoc-class payloads actually used.
const HIDDEN_UNICODE = /[​-‏‪-‮⁦-⁩﻿]/;
const TEXT_EXT = new Set(['.md', '.txt', '.sh', '.bash', '.py', '.js', '.ts', '.json', '.yaml', '.yml']);
const SCRIPT_EXT = new Set(['.sh', '.bash', '.py', '.js', '.ts', '.mjs', '.rb', '.pl']);
// ponytail: 1 MiB per-file inspection cap; bigger files get flagged, not read
const INSPECT_CAP = 1024 * 1024;

/**
 * Static inspection of a skill source tree. Facts only, each one a reason a
 * human should look before committing:
 *  - executable files / script files (skills inherit the agent's shell)
 *  - symlinks (can smuggle content from outside the reviewed tree)
 *  - hidden/bidi unicode in text files (invisible-to-review payloads)
 */
export async function gateSkillSource(dir: string): Promise<GateVerdict> {
  const reasons: string[] = [];
  let executables = 0;
  let scripts = 0;
  let symlinks = 0;
  let hiddenUnicodeIn: string | undefined;

  async function walk(d: string, rel: string): Promise<void> {
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const full = join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) {
        symlinks++;
        void (await readlink(full)); // exists check only
        continue;
      }
      if (e.isDirectory()) {
        await walk(full, r);
        continue;
      }
      if (!e.isFile()) continue;
      const st = await lstat(full);
      if (st.mode & 0o111) executables++;
      const ext = extname(e.name).toLowerCase();
      if (SCRIPT_EXT.has(ext)) scripts++;
      if (!hiddenUnicodeIn && TEXT_EXT.has(ext)) {
        if (st.size > INSPECT_CAP) {
          reasons.push(`${r} is >1 MiB — too large to inspect`);
        } else if (HIDDEN_UNICODE.test(await readFile(full, 'utf8'))) {
          hiddenUnicodeIn = r;
        }
      }
    }
  }
  await walk(dir, '');

  if (hiddenUnicodeIn) {
    reasons.push(`hidden/bidirectional unicode in ${hiddenUnicodeIn} (content invisible to review)`);
  }
  if (executables > 0) reasons.push(`${executables} executable file(s) — skills run with your shell access`);
  else if (scripts > 0) reasons.push(`${scripts} script file(s) — review before the agent can run them`);
  if (symlinks > 0) reasons.push(`${symlinks} symlink(s) — may reference content outside this tree`);

  return { level: reasons.length > 0 ? 'caution' : 'ok', reasons };
}

/** Origin-level facts for package installs. */
export function gateOrigin(origin: CapabilityOrigin): GateVerdict {
  if ((origin.type === 'npm' || origin.type === 'pypi') && !origin.version) {
    return {
      level: 'caution',
      reasons: [
        `unpinned ${origin.type} package — the runner fetches whatever is latest at each start (postmark-mcp turned malicious at version 16)`,
      ],
    };
  }
  return { level: 'ok', reasons: [] };
}
