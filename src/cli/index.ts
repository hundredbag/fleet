#!/usr/bin/env node
import { loadAdapters } from '../core/registry.js';
import { buildInventory } from '../core/inventory.js';
import { renderInventory } from './render.js';
import type { AgentAdapter } from '../core/adapter.js';
import type { McpServerSpec } from '../core/types.js';
import {
  planInstall,
  planRemove,
  planSync,
  planInstallSkill,
  planRemoveSkill,
  planSyncSkill,
  planInstallRule,
  planRemoveRule,
  planSyncRule,
  execute,
  resolveTargets,
  type Plan,
} from '../core/orchestrator.js';
import { rollback, readAudit } from '../core/writer.js';
import { analyzeConflicts } from '../core/conflicts.js';
import { defaultSources } from '../feed/index.js';
import { discover, updatesForInventory } from '../feed/feed.js';
import { recommend, diversifyByCategory } from '../feed/recommend.js';
import { SkillsShSource } from '../feed/sources/skills-sh.js';
import { startFleetServer } from '../web/server.js';
import { loadConfig, configPath } from '../core/config.js';
import { planPluginAction, runDelegated, lastDelegated } from '../core/delegate.js';
import { redactUrl, summarizeInventory } from '../core/redact.js';
import { runDoctor } from '../core/doctor.js';
import { readLock } from '../core/lock.js';
import { detectDrift } from '../core/drift.js';
import { skillUpdatesFromLock } from '../core/skill-updates.js';

const HELP = `fleet — unified cross-agent capability manager (v0)

Usage:
  fleet inventory [--json]                 Show installed capabilities (all agents)
  fleet doctor                             Health checks (adapters/state/config); exit 0/1/2
  fleet lock [--json]                      Provenance of fleet-installed capabilities
  fleet drift [--json]                     Diff live agent state against fleet.lock (tamper check)

  fleet install <name> --to <ids|all> \\
        (--command <cmd> [--arg <a>]... | --url <url> [--sse] [--bearer-env <VAR>]) \\
        [--scope user] [--commit]          Install an MCP server (dry-run unless --commit)

  fleet sync <name> --from <id> --to <ids|all> [--commit]
                                           Copy a server from one agent to others
  fleet remove <name> --from <ids|all> [--commit]
                                           Remove a server from agents

  fleet skill install <name> --from-dir <path> --to <ids|all> [--commit]
  fleet skill sync <name> --from <id> --to <ids|all> [--commit]
  fleet skill remove <name> --from <ids|all> [--commit]
  fleet skill find <query>                 Search the skills.sh registry

  fleet plugin install <p[@market]> --to <ids|all> [--commit]
  fleet plugin remove <p[@market]> --from <ids|all> [--commit]
                                           Vendor plugins via the vendor's own CLI
                                           (claude plugin / codex plugin; dry-run shows
                                           the exact command; undo = vendor uninstall)

  fleet rule install <name> --text <instruction> --to <ids|all> [--commit]
  fleet rule sync <name> --from <id> --to <ids|all> [--commit]
  fleet rule remove <name> --from <ids|all> [--commit]
                                           Manage rules (instruction blocks in CLAUDE.md/AGENTS.md)

  fleet serve [--port <n>] [--host <addr>] [--allow-host <h>[,<h>]]
                                           Web dashboard (default 127.0.0.1, token-gated).
                                           Tailscale (safest): keep loopback + 'tailscale serve', and
                                             --allow-host <machine>.<tailnet>.ts.net
                                           Direct bind: --host <tailscale-ip> (auto-allows <ip>:<port>).
                                           Never bind 0.0.0.0; never expose via 'tailscale funnel'.
  fleet config                             Show effective config (~/.fleet/config.json) + its path
  fleet whats-new                          New/updatable capabilities for your agents (heuristic)
  fleet conflicts                          Flag opposing always-on rules (heuristic)
  fleet rollback [<auditId>]               Undo the last (or a specific) change
  fleet help

Agents: claude-code, codex, gemini. Writes are dry-run by default; pass --commit
to apply. File changes are backed up and reversible via 'fleet rollback';
delegated plugin actions are undone via the vendor CLI (fleet prints the command).`;

interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
  args: string[]; // repeated --arg values
}

function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  const args: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) {
        flags[key] = true;
      } else if (key === 'arg') {
        args.push(next);
        i++;
      } else {
        flags[key] = next;
        i++;
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags, args };
}

function str(v: string | boolean | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function specFromFlags(p: ParsedArgs): McpServerSpec {
  const command = str(p.flags.command);
  const url = str(p.flags.url);
  if (command) {
    return { transport: 'stdio', command, args: p.args.length ? p.args : undefined };
  }
  if (url) {
    return {
      transport: p.flags.sse ? 'sse' : 'http',
      url,
      bearerTokenEnvVar: str(p.flags['bearer-env']),
    };
  }
  throw new Error(
    'install: provide --command <cmd> (stdio) or --url <url> (remote), ' +
      "or use 'fleet sync' to copy from another agent",
  );
}

function renderPlan(plan: Plan): string {
  const out: string[] = [];
  if (plan.changes.length === 0 && plan.skips.length === 0) return 'No changes.';
  for (const c of plan.changes) {
    out.push(`  ${c.op === 'remove' ? '−' : '+'} [${c.agent}] ${c.op} "${c.name}" (${c.scope}) → ${c.file}`);
    for (const w of c.warnings ?? []) out.push(`      ⚠ ${w}`);
  }
  for (const s of plan.skips) out.push(`  · [${s.agent}] skipped: ${s.reason}`);
  return out.join('\n');
}

async function runPlan(adapters: AgentAdapter[], plan: Plan, commit: boolean): Promise<number> {
  process.stdout.write(renderPlan(plan) + '\n');
  const hasError = plan.skips.some((s) => s.kind === 'error');
  const noopExit = plan.changes.length === 0 && hasError ? 1 : 0;
  if (!commit) {
    if (plan.changes.length > 0) {
      process.stdout.write('\n(dry-run; re-run with --commit to apply)\n');
    }
    return noopExit;
  }
  const result = await execute(adapters, plan, { commit: true });
  if (result.error) {
    if (result.applied.length > 0) {
      process.stdout.write(
        `\n⚠ applied ${result.applied.length} change(s) before failing; later agents were NOT changed.\n` +
          `  undo the applied ones with: fleet rollback (run ${result.applied.length}×)\n`,
      );
    }
    throw new Error(result.error);
  }
  if (result.lockWarning) {
    process.stdout.write(`\n⚠ ${result.lockWarning}\n`);
  }
  if (result.applied.length > 0) {
    process.stdout.write(`\n✓ applied ${result.applied.length} change(s). Undo with: fleet rollback\n`);
  }
  return noopExit;
}

async function main(argv: string[]): Promise<number> {
  const first = argv[0];
  const cmd = first && !first.startsWith('-') ? first : 'inventory';
  const rest = first && !first.startsWith('-') ? argv.slice(1) : argv;
  const p = parseArgs(rest);
  // Don't load (and thus execute) plugin adapters for commands that don't need them.
  const needsAdapters = !['config', 'help', '-h', '--help', 'rollback'].includes(cmd);
  const adapters = needsAdapters ? await loadAdapters() : [];
  const commit = p.flags.commit === true || p.flags.commit === 'true';

  switch (cmd) {
    case 'inventory': {
      const inv = await buildInventory(adapters);
      // --json emits the SUMMARY: raw specs carry env/headers (secrets) and
      // subagent prompts — json output gets piped into other tools far too
      // easily to ship those. (Shape change is deliberate and documented.)
      process.stdout.write(
        (p.flags.json ? JSON.stringify(summarizeInventory(inv), null, 2) : renderInventory(inv)) + '\n',
      );
      return 0;
    }
    case 'install': {
      const name = p.positionals[0];
      const to = str(p.flags.to);
      if (!name || !to) throw new Error('usage: fleet install <name> --to <ids|all> (--command … | --url …)');
      const spec = specFromFlags(p);
      const scope = str(p.flags.scope) ?? 'user';
      if (scope !== 'user') throw new Error(`scope '${scope}' is not supported in M2 (only 'user')`);
      const targets = await resolveTargets(adapters, to);
      return runPlan(adapters, await planInstall(adapters, spec, name, scope, targets), commit);
    }
    case 'sync': {
      const name = p.positionals[0];
      const from = str(p.flags.from);
      const to = str(p.flags.to);
      if (!name || !from || !to) throw new Error('usage: fleet sync <name> --from <id> --to <ids|all>');
      const targets = await resolveTargets(adapters, to);
      return runPlan(adapters, await planSync(adapters, name, from, targets), commit);
    }
    case 'remove': {
      const name = p.positionals[0];
      const from = str(p.flags.from);
      if (!name || !from) throw new Error('usage: fleet remove <name> --from <ids|all>');
      const targets = await resolveTargets(adapters, from);
      return runPlan(adapters, await planRemove(adapters, name, targets), commit);
    }
    case 'skill': {
      const sub = p.positionals[0];
      const name = p.positionals[1];
      if (sub === 'install') {
        const fromDir = str(p.flags['from-dir']);
        const to = str(p.flags.to);
        if (!name || !fromDir || !to) {
          throw new Error('usage: fleet skill install <name> --from-dir <path> --to <ids|all>');
        }
        const targets = await resolveTargets(adapters, to);
        return runPlan(
          adapters,
          await planInstallSkill(adapters, { name, dir: fromDir }, name, targets, {
            trustPolicy:
              str(p.flags.trust) === 'block' ? 'block' : str(p.flags.trust) === 'warn' ? 'warn' : undefined,
          }),
          commit,
        );
      }
      if (sub === 'sync') {
        const from = str(p.flags.from);
        const to = str(p.flags.to);
        if (!name || !from || !to) {
          throw new Error('usage: fleet skill sync <name> --from <agent> --to <ids|all>');
        }
        const targets = await resolveTargets(adapters, to);
        return runPlan(adapters, await planSyncSkill(adapters, name, from, targets), commit);
      }
      if (sub === 'remove') {
        const from = str(p.flags.from);
        if (!name || !from) throw new Error('usage: fleet skill remove <name> --from <ids|all>');
        const targets = await resolveTargets(adapters, from);
        return runPlan(adapters, await planRemoveSkill(adapters, name, targets), commit);
      }
      if (sub === 'find') {
        const query = p.positionals.slice(1).join(' ').trim();
        if (query.length < 2) throw new Error('usage: fleet skill find <query>  (2+ chars)');
        const found = await new SkillsShSource().search(query);
        if (found.length === 0) {
          process.stdout.write('No skills found (skills.sh).\n');
          return 0;
        }
        const top = found.sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0)).slice(0, 15);
        if (found.length > top.length) {
          process.stdout.write(`(top ${top.length} of ${found.length} matches)\n`);
        }
        for (const s of top) {
          const installs = s.popularity ? ` — ${s.popularity.toLocaleString()} installs` : '';
          process.stdout.write(`  ◆ [${s.category ?? 'other'}] ${s.name}${installs}\n      ${s.url ?? ''}\n`);
        }
        process.stdout.write(
          '\n(install: clone the repo, then `fleet skill install <name> --from-dir <path> --to all`)\n',
        );
        return 0;
      }
      throw new Error('usage: fleet skill <install|sync|remove|find> …');
    }
    case 'rule': {
      const sub = p.positionals[0];
      const name = p.positionals[1];
      if (sub === 'install') {
        const text = str(p.flags.text);
        const to = str(p.flags.to);
        if (!name || text === undefined || !to) {
          throw new Error('usage: fleet rule install <name> --text <instruction> --to <ids|all>');
        }
        const targets = await resolveTargets(adapters, to);
        return runPlan(adapters, await planInstallRule(adapters, name, text, targets), commit);
      }
      if (sub === 'sync') {
        const from = str(p.flags.from);
        const to = str(p.flags.to);
        if (!name || !from || !to) {
          throw new Error('usage: fleet rule sync <name> --from <agent> --to <ids|all>');
        }
        const targets = await resolveTargets(adapters, to);
        return runPlan(adapters, await planSyncRule(adapters, name, from, targets), commit);
      }
      if (sub === 'remove') {
        const from = str(p.flags.from);
        if (!name || !from) throw new Error('usage: fleet rule remove <name> --from <ids|all>');
        const targets = await resolveTargets(adapters, from);
        return runPlan(adapters, await planRemoveRule(adapters, name, targets), commit);
      }
      throw new Error('usage: fleet rule <install|sync|remove> …');
    }
    case 'plugin': {
      const sub = p.positionals[0];
      const selector = p.positionals[1];
      if ((sub !== 'install' && sub !== 'remove') || !selector) {
        throw new Error(
          'usage: fleet plugin <install|remove> <plugin[@marketplace]> --to <ids|all> [--commit]',
        );
      }
      const to = str(p.flags.to) ?? str(p.flags.from); // remove reads --from like its siblings
      if (!to) throw new Error('usage: fleet plugin … --to <ids|all>');
      const targets = await resolveTargets(adapters, to);
      let failed = false;
      for (const agent of targets) {
        // per-agent isolation: one agent failing (e.g. codex not installed) must
        // not hide what already ran on the others
        try {
          const res = await runDelegated(planPluginAction(agent, sub, selector), { commit });
          if (res.status === 'preview') {
            process.stdout.write(`  → [${agent}] would run: ${res.command}\n`);
            if (res.undoCommand) process.stdout.write(`      undo: ${res.undoCommand}\n`);
          } else {
            process.stdout.write(
              `  ${res.status === 'applied' ? '✓' : '✗'} [${agent}] ${res.command} (exit ${res.exitCode})\n`,
            );
            if (res.status === 'failed') {
              failed = true;
              process.stdout.write(`${res.outputTail ?? ''}\n`);
            }
          }
        } catch (e) {
          failed = true;
          process.stdout.write(`  ✗ [${agent}] ${e instanceof Error ? e.message : String(e)}\n`);
        }
      }
      if (!commit) {
        process.stdout.write(
          '\n⚠ plugins run code (hooks/commands) — verify the marketplace before installing.\n(dry-run; re-run with --commit to execute the vendor CLI)\n',
        );
      }
      return failed ? 1 : 0;
    }
    case 'whats-new': {
      const inv = await buildInventory(adapters);
      const { items, failures } = await discover(defaultSources());
      const { updates } = updatesForInventory(inv, items);
      const recs = await recommend(inv, items); // uncapped; sliced per section below
      process.stdout.write('Updates available (installed):\n');
      if (updates.length === 0) process.stdout.write('  (none)\n');
      for (const u of updates) {
        process.stdout.write(`  ↑ [${u.agent}] ${u.name}: ${u.installed} → ${u.available}\n`);
      }
      const trustNote = (r: (typeof recs)[number]): string =>
        r.trust.level === 'caution'
          ? `  ⚠ ${r.trust.reasons.join(', ')}`
          : r.trust.level === 'unknown'
            ? `  · ${r.trust.reasons.join(', ')}`
            : '';
      const servers = recs.filter((r) => !r.item.kind || r.item.kind === 'mcp-server').slice(0, 10);
      const skills = diversifyByCategory(
        recs.filter((r) => r.item.kind === 'skill'),
        10,
      );
      const plugins = diversifyByCategory(
        recs.filter((r) => r.item.kind === 'plugin'),
        8,
      );
      process.stdout.write('\nNew / recommended MCP servers (not installed):\n');
      if (servers.length === 0) process.stdout.write('  (none)\n');
      for (const r of servers) {
        const id = r.item.identifier ? ` (${r.item.identifier})` : '';
        process.stdout.write(`  ★ ${r.item.name}${id} — ${r.reasons.join('; ')}${trustNote(r)}\n`);
      }
      process.stdout.write('\nRecommended skills (sampled from skill registries — not exhaustive):\n');
      if (skills.length === 0) process.stdout.write('  (none)\n');
      for (const r of skills) {
        process.stdout.write(
          `  ◆ [${r.item.category ?? 'other'}] ${r.item.name} — ${r.reasons.join('; ')}  ${r.item.url ?? ''}\n`,
        );
      }
      const skillUps = await skillUpdatesFromLock(inv);
      if (skillUps.length > 0) {
        process.stdout.write('\nSkill updates (source dir changed since install):\n');
        for (const u of skillUps) {
          const mark =
            u.state === 'update+local-edits' ? '\u26a0 LOCAL EDITS — reinstall overwrites them' : 'clean';
          process.stdout.write(`  \u25b3 ${u.name} @${u.agent} (${mark})\n      ${u.applyHint}\n`);
        }
      }
      if (plugins.length > 0) {
        process.stdout.write('\nRecommended plugins (from your registered marketplaces):\n');
        for (const r of plugins) {
          process.stdout.write(
            `  ▣ [${r.item.category ?? 'other'}] ${r.item.name} — fleet plugin install ${r.item.identifier ?? r.item.name} --to claude-code (preview first, then --commit)\n`,
          );
        }
      }
      if (failures.length > 0) {
        process.stdout.write(
          `\n⚠ couldn't reach: ${failures.map((f) => f.source).join(', ')} (showing what's available)\n`,
        );
      }
      process.stdout.write('\n(heuristic; verify before installing)\n');
      return 0;
    }
    case 'serve': {
      const cfg = loadConfig();
      const port = p.flags.port !== undefined ? Number(str(p.flags.port)) : cfg.port;
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`serve: invalid port '${str(p.flags.port)}'`);
      }
      const host = str(p.flags.host) ?? '127.0.0.1';
      if ((host === '0.0.0.0' || host === '::' || host === '') && p.flags['insecure-bind-all'] !== true) {
        throw new Error(
          `serve: refusing to bind '${host}' (all interfaces) — this exposes a write-capable daemon to your LAN/network.\n` +
            "  Keep the default loopback bind and use 'tailscale serve', or bind a specific IP (--host <tailscale-ip>).\n" +
            '  Pass --insecure-bind-all only if you truly mean to expose every interface.',
        );
      }
      const flagHosts = (str(p.flags['allow-host']) ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const allowHosts = flagHosts.length ? flagHosts : cfg.allowHosts;
      startFleetServer(adapters, { port, host, allowHosts });
      return 0; // the listening server keeps the process alive
    }
    case 'lock': {
      const lock = await readLock();
      const entries = Object.values(lock.entries);
      if (p.flags.json === true) {
        process.stdout.write(JSON.stringify(lock, null, 2) + '\n');
        return 0;
      }
      if (entries.length === 0) {
        process.stdout.write('fleet.lock: no fleet-installed capabilities recorded yet\n');
        return 0;
      }
      for (const e of entries) {
        const org =
          e.origin.type === 'npm' || e.origin.type === 'pypi'
            ? `${e.origin.type}:${e.origin.id}${e.origin.version ? '@' + e.origin.version : ''}`
            : e.origin.type === 'dir'
              ? `dir:${e.origin.path}`
              : e.origin.type === 'marketplace'
                ? `marketplace:${e.origin.selector}`
                : 'manual';
        process.stdout.write(
          `  ${e.kind.padEnd(10)} ${e.name.padEnd(24)} ${e.agent.padEnd(12)} ${org}  (${e.installedAt.slice(0, 10)})\n`,
        );
      }
      return 0;
    }
    case 'drift': {
      const inv = await buildInventory(adapters);
      const report = await detectDrift(inv);
      if (p.flags.json === true) {
        process.stdout.write(JSON.stringify(report, null, 2) + '\n');
        return report.findings.length > 0 ? 1 : 0;
      }
      process.stdout.write(`checked ${report.checked} fleet-installed capabilities\n`);
      if (report.findings.length === 0) {
        process.stdout.write('  \u2713 everything matches what fleet installed\n');
      }
      for (const f of report.findings) {
        process.stdout.write(
          `  \u26a0 ${f.kind} ${f.name} @${f.agent}: ${f.state}${f.detail ? ' — ' + f.detail : ''}\n`,
        );
      }
      if (report.unmanaged.length > 0) {
        process.stdout.write(`\n  not installed by fleet (${report.unmanaged.length}):\n`);
        for (const u of report.unmanaged) process.stdout.write(`    · ${u.kind} ${u.name} @${u.agent}\n`);
      }
      return report.findings.length > 0 ? 1 : 0;
    }
    case 'doctor': {
      const report = await runDoctor({ adapters }); // reuse — don't load BYO factories twice
      const icon = { ok: '\u2713', warn: '\u26a0', error: '\u2717' } as const;
      let cat = '';
      for (const f of report.findings) {
        if (f.category !== cat) {
          cat = f.category;
          process.stdout.write(`\n[${cat}]\n`);
        }
        process.stdout.write(`  ${icon[f.level]} ${f.message}\n`);
      }
      process.stdout.write(
        `\n${report.exitCode === 0 ? 'healthy' : report.exitCode === 1 ? 'warnings — see above' : 'ERRORS — see above'}\n`,
      );
      return report.exitCode;
    }
    case 'config': {
      const cfg = loadConfig();
      const shown = { ...cfg, hubUrl: cfg.hubUrl ? redactUrl(cfg.hubUrl) : null };
      process.stdout.write(`config: ${configPath()}\n`);
      process.stdout.write(JSON.stringify(shown, null, 2) + '\n');
      return 0;
    }
    case 'conflicts': {
      const findings = analyzeConflicts(await buildInventory(adapters));
      const caveat =
        '  (heuristic; checks only fleet-managed always-on rules, not hand-written\n' +
        '   instructions — absence of findings is not a guarantee.)';
      if (findings.length === 0) {
        process.stdout.write(`No likely conflicts found.\n${caveat}\n`);
        return 0;
      }
      process.stdout.write('Possible conflicts (verify yourself):\n');
      for (const f of findings) {
        process.stdout.write(`  ⚠ [${f.agent}] "${f.a}" vs "${f.b}" — possible ${f.axis} conflict\n`);
      }
      process.stdout.write(`  → ${findings[0]!.suggestion}\n${caveat}\n`);
      return 0;
    }
    case 'rollback': {
      // a delegated plugin action can't be file-rolled-back — point at the vendor undo
      if (!p.positionals[0]) {
        const [del, audit] = await Promise.all([lastDelegated(), readAudit()]);
        const lastTs = audit[audit.length - 1]?.ts ?? 0;
        if (del && Date.parse(del.time) > lastTs) {
          process.stdout.write(
            `last change was a delegated plugin action (${del.argv.join(' ')});\n` +
              (del.undoArgv ? `undo it with: ${del.undoArgv.join(' ')}\n` : 'undo it via the vendor CLI.\n'),
          );
          return 0;
        }
      }
      const res = await rollback({ auditId: p.positionals[0] });
      process.stdout.write(`rollback: ${res.action} ${res.file}${res.reason ? ` (${res.reason})` : ''}\n`);
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
    process.stderr.write(`fleet: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
