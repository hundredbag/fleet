import { readdir, readFile, lstat, readlink } from 'node:fs/promises';
import { extname } from 'node:path';
import { join } from 'node:path';
import type { CapabilityOrigin } from './lock.js';

/**
 * Install-time trust gate (M6, finally wired): a verdict computed at PLAN time
 * so every face's preview carries it, enforced according to config.trustPolicy
 * ('warn' default — surface as warnings; 'block' — refuse caution-level plans;
 * per-run override via the planners' trustPolicy option / CLI --trust).
 * Deliberately local + static: file-tree facts, not an LLM "looks safe" (2026
 * research: semantic evasion beats LLM-only skill review 36-100% of the time).
 */

export interface GateVerdict {
  level: 'ok' | 'caution';
  reasons: string[];
}

// Unicode invisible to human review: zero-widths, bidi controls (incl. ALM
// U+061C), word-joiner U+2060, BOM-as-content. Escapes, not literal bytes —
// "fix invisible unicode" tooling would silently eat literals.
const HIDDEN_UNICODE = /[\u061C\u200B-\u200F\u202A-\u202E\u2060\u2066-\u2069\uFEFF]/;
const SCRIPT_EXT = new Set([
  '.sh',
  '.bash',
  '.zsh',
  '.fish',
  '.py',
  '.js',
  '.cjs',
  '.mjs',
  '.ts',
  '.tsx',
  '.jsx',
  '.rb',
  '.pl',
  '.ps1',
]);
// ponytail: 1 MiB per-file inspection cap; bigger files get flagged, not read
const INSPECT_CAP = 1024 * 1024;

function looksBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8192).includes(0);
}

/**
 * Static inspection of a skill source tree. Facts only, each one a reason a
 * human should look before committing:
 *  - executable files / script files / shebang files (skills inherit shell)
 *  - symlinks incl. a symlinked ROOT (content outside the reviewed tree)
 *  - hidden/bidi unicode in ANY non-binary file (invisible-to-review payloads)
 *  - files too large to inspect
 */
export async function gateSkillSource(dir: string): Promise<GateVerdict> {
  const reasons: string[] = [];
  let executables = 0;
  let scripts = 0;
  let symlinks = 0;
  let hiddenUnicodeIn: string | undefined;

  try {
    if ((await lstat(dir)).isSymbolicLink()) {
      reasons.push('the skill source directory itself is a symlink');
    }
  } catch {
    /* unreadable root surfaces via readdir below */
  }

  async function walk(d: string, rel: string): Promise<void> {
    const entries = await readdir(d, { withFileTypes: true });
    for (const e of entries) {
      const full = join(d, e.name);
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isSymbolicLink()) {
        symlinks++;
        void (await readlink(full));
        continue;
      }
      if (e.isDirectory()) {
        await walk(full, r);
        continue;
      }
      if (!e.isFile()) continue;
      const st = await lstat(full);
      if (st.mode & 0o111) executables++;
      if (st.size > INSPECT_CAP) {
        reasons.push(`${r} is >1 MiB — too large to inspect`);
        continue;
      }
      const buf = await readFile(full);
      const isScriptExt = SCRIPT_EXT.has(extname(e.name).toLowerCase());
      const hasShebang = buf.length > 1 && buf[0] === 0x23 && buf[1] === 0x21; // '#!'
      if (isScriptExt || hasShebang) scripts++;
      if (!hiddenUnicodeIn && !looksBinary(buf)) {
        // a LEADING BOM is a benign editor artifact — strip before testing
        const text = buf.toString('utf8').replace(/^\uFEFF/, '');
        if (HIDDEN_UNICODE.test(text)) hiddenUnicodeIn = r;
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

// pinned = IMMUTABLE exact version only. Tags (@latest/@next), ranges (^1, ~2),
// wildcards and aliases all float — the postmark-mcp failure mode.
const EXACT_SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Origin-level facts for package installs. */
export function gateOrigin(origin: CapabilityOrigin): GateVerdict {
  if (origin.type === 'npm' || origin.type === 'pypi') {
    if (!origin.version) {
      return {
        level: 'caution',
        reasons: [
          `unpinned ${origin.type} package — the runner fetches whatever is latest at each start (postmark-mcp turned malicious at version 16)`,
        ],
      };
    }
    if (!EXACT_SEMVER.test(origin.version)) {
      return {
        level: 'caution',
        reasons: [
          `'${origin.version}' is a tag/range, not an exact version — it floats to whatever gets published`,
        ],
      };
    }
  }
  return { level: 'ok', reasons: [] };
}
