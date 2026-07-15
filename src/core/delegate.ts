import { spawn } from 'node:child_process';
import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { scrubSecrets } from './redact.js';
import { updateLockForPlugin } from './lock.js';

/**
 * Delegated plugin install/remove: fleet never writes vendor plugin dirs — it
 * runs the vendor's own CLI (docs/design-plugins.md Part B, commands verified
 * 2026-07-03). spawn with an argv ARRAY (no shell → no injection surface),
 * selector validated at this trust boundary (AI/feed data can reach it).
 * HONEST LIMITS: no hash-guard/backup; undo = the vendor's uninstall command;
 * the confirm shows the exact command but no marketplace provenance/trust score
 * yet (plugins Part C).
 */

// PLUGIN[@MARKETPLACE]; also allows @scope/name. Leading '-' rejected (no flag smuggling).
const SELECTOR_RE = /^[A-Za-z0-9@][\w./-]*(@[\w.-]+)?$/;

export type PluginOp = 'install' | 'remove';

export interface DelegatedPlan {
  agent: string;
  op: PluginOp;
  selector: string;
  argv: string[];
  undoArgv?: string[];
}

const VENDOR: Record<string, Record<PluginOp, string[]>> = {
  // ponytail: argv table beats an adapter interface for 2 agents; move into
  // adapters if BYO-agent plugins ever need this.
  'claude-code': { install: ['claude', 'plugin', 'install'], remove: ['claude', 'plugin', 'uninstall'] },
  codex: { install: ['codex', 'plugin', 'add'], remove: ['codex', 'plugin', 'remove'] },
};

export function planPluginAction(agent: string, op: PluginOp, selector: string): DelegatedPlan {
  if (!SELECTOR_RE.test(selector) || selector.includes('..')) {
    throw new Error(`refusing unsafe plugin selector '${selector}'`);
  }
  const cmds = VENDOR[agent];
  if (!cmds) throw new Error(`agent '${agent}' has no plugin CLI support (built-ins: claude-code, codex)`);
  return {
    agent,
    op,
    selector,
    argv: [...cmds[op], selector],
    undoArgv: op === 'install' ? [...cmds.remove, selector] : undefined,
  };
}

export interface DelegatedResult {
  status: 'preview' | 'applied' | 'failed';
  agent: string;
  command: string;
  undoCommand?: string;
  exitCode?: number;
  outputTail?: string;
}

export type Runner = (argv: string[]) => Promise<{ exitCode: number; output: string }>;

const defaultRunner: Runner = (argv) =>
  new Promise((resolve, reject) => {
    // cwd-neutral: vendor scope defaults must not depend on where fleet was launched
    const child = spawn(argv[0]!, argv.slice(1), { stdio: ['ignore', 'pipe', 'pipe'], cwd: homedir() });
    let out = '';
    const grab = (c: Buffer) => {
      out = (out + c.toString()).slice(-8192); // rolling tail — the error is at the END
    };
    child.stdout.on('data', grab);
    child.stderr.on('data', grab);
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      // grandchildren can hold the pipes open past the kill — don't wait on them
      child.stdout.destroy();
      child.stderr.destroy();
    }, 120_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, output: out });
    });
  });

/** Newest delegated-ledger entry, or null (for `fleet rollback`'s "that was a
 * plugin action" hint — file-rollback cannot undo vendor state). */
export async function lastDelegated(
  fleetHome?: string,
): Promise<{ time: string; argv: string[]; undoArgv?: string[] } | null> {
  try {
    const { readFile } = await import('node:fs/promises');
    const lines = (await readFile(join(fleetHome ?? join(homedir(), '.fleet'), 'delegated.jsonl'), 'utf8'))
      .trim()
      .split('\n');
    return JSON.parse(lines[lines.length - 1]!);
  } catch {
    return null;
  }
}

/** Execute (or preview) a delegated plan; applied/failed runs are appended to
 * ~/.fleet/delegated.jsonl (separate ledger — file-rollback machinery can't undo these). */
export async function runDelegated(
  plan: DelegatedPlan,
  opts: { commit: boolean; fleetHome?: string; runner?: Runner } = { commit: false },
): Promise<DelegatedResult> {
  const command = plan.argv.join(' ');
  const undoCommand = plan.undoArgv?.join(' ');
  if (!opts.commit) return { status: 'preview', agent: plan.agent, command, undoCommand };

  const { exitCode, output } = await (opts.runner ?? defaultRunner)(plan.argv);
  // structured secret scrub (URL userinfo, key=value, JWT/vendor token shapes)
  // before the tail reaches the ledger / an AI face
  // scrub the WHOLE output first — slicing first could cut a token's prefix
  // and leave an unrecognizable (unredactable) suffix in the tail
  const outputTail = scrubSecrets(output).slice(-2000);
  const home = opts.fleetHome ?? join(homedir(), '.fleet');
  await mkdir(home, { recursive: true });
  await appendFile(
    join(home, 'delegated.jsonl'),
    JSON.stringify({ id: randomUUID(), time: new Date().toISOString(), ...plan, exitCode, outputTail }) +
      '\n',
    'utf8',
  );
  if (exitCode === 0) {
    try {
      await updateLockForPlugin(plan.op, plan.agent, plan.selector, opts.fleetHome);
    } catch {
      /* lock is metadata — the vendor CLI already succeeded */
    }
  }
  return {
    status: exitCode === 0 ? 'applied' : 'failed',
    agent: plan.agent,
    command,
    undoCommand,
    exitCode,
    outputTail,
  };
}
