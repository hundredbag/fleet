#!/usr/bin/env node
import { loadAdapters } from '../core/registry.js';
import type { AdapterLoadDiagnostic } from '../core/plugins.js';
import { buildInventory } from '../core/inventory.js';
import { renderInventory, renderProvenanceWarning } from './render.js';
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
import { rollback } from '../core/writer.js';
import { assessImplicitRollback } from '../core/rollback-guard.js';
import { analyzeConflicts } from '../core/conflicts.js';
import { defaultSources, feedSourceEnabled } from '../feed/index.js';
import { updatesForInventory } from '../feed/feed.js';
import { cachedDiscover } from '../feed/cache.js';
import { recommend, diversifyByCategory } from '../feed/recommend.js';
import { SkillsShSource } from '../feed/sources/skills-sh.js';
import { startFleetServer } from '../web/server.js';
import {
  loadConfig,
  configPath,
  parseTrustPolicyOverride,
  readEffectiveConfigState,
  teamPolicyPath,
} from '../core/config.js';
import { planPluginActions, runDelegated } from '../core/delegate.js';
import { publicErrorMessage, redactUrl, scrubSecrets, summarizeInventory } from '../core/redact.js';
import { runDoctor } from '../core/doctor.js';
import { readLockState } from '../core/lock.js';
import { detectDrift } from '../core/drift.js';
import { skillUpdatesFromLock } from '../core/skill-updates.js';
import { exportProfile, readProfile } from '../core/profile.js';
import { prepareProfileDesiredState, refreshProfileDesiredEntry } from '../core/profile-desired.js';
import { readPack, readPackRuleBody, type RuleVariant } from '../core/pack.js';
import { safeJoin } from '../core/fsutil.js';
import { parseScope } from '../core/scope.js';
import { FleetOperationError } from '../core/errors.js';

const HELP = `fleet — unified cross-agent capability manager

Usage:
  fleet inventory [--json]                 Show installed capabilities (all agents)
  fleet doctor                             Health checks (adapters/state/config); exit 0/1/2
  fleet lock [--json]                      Provenance of fleet-installed capabilities
  fleet drift [--json]                     Diff live agent state against fleet.lock (tamper check)
  fleet pack install --from-dir <dir> \\
    [--to <ids|all>] [--variant full|mini|nano] [--commit]
                                           Install a capability pack (dry-run unless --commit)
  fleet export --to <dir>                  Write a profile immediately; MCP env/header values become refs
  fleet import --from <dir> [--to ids|all] [--commit]
                                           Reconcile additive desired state; never prune omitted items
                                           (dry-run unless --commit)

  fleet install <name> --to <ids|all> \\
        (--command <cmd> [--arg <a>]... | --url <url> [--sse] [--bearer-env <VAR>]) \\
        [--scope user] [--commit]          Install an MCP server (dry-run unless --commit)

  fleet sync <name> --from <id> [--from-scope user|project|local] --to <ids|all> [--commit]
                                           Copy a server from one agent to others
  fleet remove <name> --from <ids|all> [--scope user] [--commit]
                                           Remove a server from agents

  fleet skill install <name> --from-dir <path> --to <ids|all> [--trust warn|block] [--commit]
  fleet skill sync <name> --from <id> [--from-scope user|project|local] --to <ids|all> [--commit]
  fleet skill remove <name> --from <ids|all> [--commit]
  fleet skill find <query>                 Search the skills.sh registry

  fleet plugin install <p[@market]> --to <ids|all> [--commit]
  fleet plugin remove <p[@market]> --from <ids|all> [--commit]
                                           Vendor plugins via the vendor's own CLI
                                           (currently Claude Code only; dry-run shows
                                           the exact command; inverse guidance requires
                                           an inventory-verified state change)

  fleet rule install <name> --text <instruction> --to <ids|all> [--commit]
  fleet rule sync <name> --from <id> [--from-scope user|project|local] --to <ids|all> [--commit]
  fleet rule remove <name> --from <ids|all> [--commit]
                                           Manage rules (instruction blocks in CLAUDE.md/AGENTS.md)

  fleet serve [--port <n>] [--host <addr>] [--allow-host <h>[,<h>]]
                                           Web dashboard (default 127.0.0.1, token-gated).
                                           Tailscale (safest): keep loopback + 'tailscale serve', and
                                             --allow-host <machine>.<tailnet>.ts.net
                                           Direct bind: --host <tailscale-ip> (auto-allows <ip>:<port>).
                                           Never bind 0.0.0.0; never expose via 'tailscale funnel'.
  fleet config                             Show user/team policy states and effective config
  fleet whats-new [--refresh]                          New/updatable capabilities for your agents (heuristic)
  fleet conflicts                          Flag opposing always-on rules (heuristic)
  fleet rollback [<auditId>]               Immediately undo an eligible core change;
                                           newer delegated state blocks implicit core rollback
  fleet help

Built-in agents: claude-code, codex. Additional agents can be loaded through adapter plugins.
Capability install/sync/remove, profile import, and pack install are dry-run unless --commit.
Export writes immediately. Rollback also executes immediately; target an audit id when possible.
Core-managed file changes use guarded, normally audit-backed rollback; delegated plugin actions use vendor recovery.`;

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
  if (command && url) throw new Error('install: provide exactly one of --command or --url');
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
  // A plan can legitimately apply to one target while another target is
  // blocked. Exit non-zero for every error/protected skip so CLI automation
  // never mistakes a partial desired state or policy refusal for full success.
  const planExit = plan.skips.some((skip) => skip.kind === 'error' || skip.kind === 'protected') ? 1 : 0;
  if (!commit) {
    if (plan.changes.length > 0) {
      process.stdout.write('\n(dry-run; re-run with --commit to apply)\n');
    }
    return planExit;
  }
  const result = await execute(adapters, plan, { commit: true });
  if (result.error) {
    if (result.recoveryPending) {
      process.stdout.write(
        '\n⚠ outcome unknown: Fleet preserved recovery state but could not restore the original pathname.\n' +
          '  Do not retry or run another mutation. Inspect fleet doctor, the reported recovery path, and the target first.\n',
      );
    }
    if (result.applied.length > 0) {
      const recorded = result.applied.filter((item) => item.auditRecorded);
      const unrecorded = result.applied.length - recorded.length;
      process.stdout.write(`\n⚠ applied ${result.applied.length} change(s) before failing.\n`);
      if (recorded.length > 0) {
        process.stdout.write('  audit-recorded changes can be targeted explicitly:\n');
        for (const item of recorded) process.stdout.write(`    fleet rollback ${item.auditId}\n`);
      }
      if (unrecorded > 0) {
        process.stdout.write(
          `  manual recovery required for ${unrecorded} unrecorded change(s); ` +
            'do not use implicit fleet rollback for them. Inspect the error and backup location below.\n',
        );
      }
      process.stdout.write('  later agents were NOT changed.\n');
    }
    throw new Error(result.error);
  }
  if (result.lockWarning) {
    process.stdout.write(`\n${renderProvenanceWarning(true)}`);
  }
  if (result.applied.length > 0) {
    process.stdout.write(`\n✓ applied ${result.applied.length} change(s). Undo with: fleet rollback\n`);
  }
  return planExit;
}

async function main(argv: string[]): Promise<number> {
  const first = argv[0];
  const cmd = first && !first.startsWith('-') ? first : 'inventory';
  const rest = first && !first.startsWith('-') ? argv.slice(1) : argv;
  const p = parseArgs(rest);
  // Don't load (and thus execute) plugin adapters for commands that don't need them.
  const needsAdapters = !['config', 'help', '-h', '--help', 'rollback'].includes(cmd);
  const adapterLoadDiagnostics: AdapterLoadDiagnostic[] = [];
  const adapters = needsAdapters
    ? await loadAdapters(undefined, undefined, (diagnostic) => adapterLoadDiagnostics.push(diagnostic))
    : [];
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
      if (scope !== 'user')
        throw new Error(`scope '${scope}' is not writable; only 'user' is currently supported`);
      const targets = await resolveTargets(adapters, to);
      return runPlan(adapters, await planInstall(adapters, spec, name, scope, targets), commit);
    }
    case 'sync': {
      const name = p.positionals[0];
      const from = str(p.flags.from);
      const to = str(p.flags.to);
      if (!name || !from || !to) throw new Error('usage: fleet sync <name> --from <id> --to <ids|all>');
      const targets = await resolveTargets(adapters, to);
      return runPlan(
        adapters,
        await planSync(adapters, name, from, targets, {
          sourceScope: parseScope(str(p.flags['from-scope']), 'from-scope'),
        }),
        commit,
      );
    }
    case 'remove': {
      const name = p.positionals[0];
      const from = str(p.flags.from);
      if (!name || !from) throw new Error('usage: fleet remove <name> --from <ids|all>');
      const targets = await resolveTargets(adapters, from);
      return runPlan(
        adapters,
        await planRemove(adapters, name, targets, parseScope(str(p.flags.scope)) ?? 'user'),
        commit,
      );
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
        const targets = await resolveTargets(adapters, to, 'skill');
        return runPlan(
          adapters,
          await planInstallSkill(adapters, { name, dir: fromDir }, name, targets, {
            trustPolicy: parseTrustPolicyOverride(p.flags.trust),
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
        const targets = await resolveTargets(adapters, to, 'skill');
        return runPlan(
          adapters,
          await planSyncSkill(adapters, name, from, targets, {
            sourceScope: parseScope(str(p.flags['from-scope']), 'from-scope'),
          }),
          commit,
        );
      }
      if (sub === 'remove') {
        const from = str(p.flags.from);
        if (!name || !from) throw new Error('usage: fleet skill remove <name> --from <ids|all>');
        const targets = await resolveTargets(adapters, from, 'skill');
        return runPlan(adapters, await planRemoveSkill(adapters, name, targets), commit);
      }
      if (sub === 'find') {
        const query = p.positionals.slice(1).join(' ').trim();
        if (query.length < 2) throw new Error('usage: fleet skill find <query>  (2+ chars)');
        if (!feedSourceEnabled(loadConfig(), 'skills.sh')) {
          throw new FleetOperationError('TARGET_UNAVAILABLE', 'feed source unavailable: skills.sh');
        }
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
        const targets = await resolveTargets(adapters, to, 'rule');
        return runPlan(adapters, await planInstallRule(adapters, name, text, targets), commit);
      }
      if (sub === 'sync') {
        const from = str(p.flags.from);
        const to = str(p.flags.to);
        if (!name || !from || !to) {
          throw new Error('usage: fleet rule sync <name> --from <agent> --to <ids|all>');
        }
        const targets = await resolveTargets(adapters, to, 'rule');
        return runPlan(
          adapters,
          await planSyncRule(adapters, name, from, targets, {
            sourceScope: parseScope(str(p.flags['from-scope']), 'from-scope'),
          }),
          commit,
        );
      }
      if (sub === 'remove') {
        const from = str(p.flags.from);
        if (!name || !from) throw new Error('usage: fleet rule remove <name> --from <ids|all>');
        const targets = await resolveTargets(adapters, from, 'rule');
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
      if (!to) {
        throw new Error(
          sub === 'install'
            ? 'usage: fleet plugin install <plugin[@marketplace]> --to <ids|all>'
            : 'usage: fleet plugin remove <plugin[@marketplace]> --from <ids|all>',
        );
      }
      // Resolve and validate every delegated target before the first vendor
      // command runs; a late unsupported target must not create a partial apply.
      const plans = await planPluginActions(adapters, to, sub, selector);
      let failed = false;
      for (const plan of plans) {
        const agent = plan.agent;
        // per-agent isolation: one agent failing (e.g. codex not installed) must
        // not hide what already ran on the others
        try {
          const res = await runDelegated(plan, { commit });
          if (res.status === 'preview') {
            process.stdout.write(`  → [${agent}] would run: ${res.command}\n`);
            if (res.undoCommand) process.stdout.write(`      undo: ${res.undoCommand}\n`);
          } else {
            const glyph =
              res.status === 'applied'
                ? '✓'
                : res.status === 'nothing-to-do'
                  ? '·'
                  : res.status === 'failed'
                    ? '✗'
                    : '?';
            process.stdout.write(
              `  ${glyph} [${agent}] ${res.command}${res.exitCode === undefined ? '' : ` (exit ${res.exitCode})`}\n`,
            );
            process.stdout.write(renderProvenanceWarning(Boolean(res.lockWarning)));
            if (res.status === 'failed' || res.status === 'outcome-unknown') {
              failed = true;
              if (res.outputTail) process.stdout.write(`${res.outputTail}\n`);
              if (res.status === 'outcome-unknown') {
                process.stdout.write('      outcome could not be verified; inspect vendor plugin state.\n');
              }
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
      const { items, failures, fromCache } = await cachedDiscover(defaultSources(), {
        refresh: p.flags.refresh === true,
      });
      if (fromCache) process.stdout.write('(cached feed — use --refresh for live registries)\n');
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
      const state = await readLockState();
      const lock = state.lock;
      const entries = Object.values(lock.entries);
      if (p.flags.json === true) {
        process.stdout.write(JSON.stringify({ status: state.status, ...lock }, null, 2) + '\n');
        return state.status === 'unavailable' || state.status === 'malformed' ? 1 : 0;
      }
      if (state.status === 'unavailable' || state.status === 'malformed') {
        process.stdout.write(`fleet.lock: ${state.status}; provenance is unavailable\n`);
        return 1;
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
        return report.lockStatus === 'unavailable' || report.lockStatus === 'malformed'
          ? 1
          : report.findings.length > 0
            ? 1
            : 0;
      }
      if (report.lockStatus === 'unavailable' || report.lockStatus === 'malformed') {
        process.stdout.write(`fleet.lock: ${report.lockStatus}; drift cannot be verified\n`);
        return 1;
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
    case 'pack': {
      const sub = p.positionals[0];
      if (sub !== 'install')
        throw new Error(
          'usage: fleet pack install --from-dir <dir> [--to <ids|all>] [--variant full|mini|nano] [--commit]',
        );
      const dir = str(p.flags['from-dir']);
      if (!dir) throw new Error('pack install: --from-dir <dir> is required (a git checkout of the pack)');
      const variantFlag = str(p.flags.variant) ?? 'full';
      if (variantFlag !== 'full' && variantFlag !== 'mini' && variantFlag !== 'nano') {
        throw new Error(`--variant must be full|mini|nano (got '${variantFlag}')`);
      }
      const pack = await readPack(dir);
      const targetArg = str(p.flags.to) ?? 'all';
      const skillTargets = pack.skills.length ? await resolveTargets(adapters, targetArg, 'skill') : [];
      const ruleTargets = pack.rules.length ? await resolveTargets(adapters, targetArg, 'rule') : [];
      process.stdout.write(
        `pack "${pack.name}": ${pack.skills.length} skills, ${pack.rules.length} rules (variant: ${variantFlag})\n`,
      );
      let rc = 0;
      for (const skillName of pack.skills) {
        const code = await runPlan(
          adapters,
          await planInstallSkill(
            adapters,
            { name: skillName, dir: safeJoin(dir, skillName) },
            skillName,
            skillTargets,
            { sourceRoot: dir },
          ),
          commit,
        );
        rc = Math.max(rc, code);
      }
      for (const rule of pack.rules) {
        const { body, usedVariant } = await readPackRuleBody(dir, rule, variantFlag as RuleVariant);
        // namespaced '<pack>.<name>' — packs must not collide with user rules
        const ruleName = `${pack.name}.${rule.name}`;
        if (usedVariant !== variantFlag) {
          process.stdout.write(`  (${rule.name}: '${variantFlag}' unavailable, using '${usedVariant}')\n`);
        }
        const code = await runPlan(
          adapters,
          await planInstallRule(adapters, ruleName, body, ruleTargets),
          commit,
        );
        rc = Math.max(rc, code);
      }
      if (!commit) process.stdout.write('\n(dry-run — add --commit to apply)\n');
      return rc;
    }
    case 'export': {
      const dir = str(p.flags.to);
      if (!dir) throw new Error('export: --to <dir> is required (a profile directory in your dotfiles repo)');
      const inv = await buildInventory(adapters);
      const { profile, conflicts, warnings } = await exportProfile(inv, dir);
      process.stdout.write(
        `exported to ${dir}: ${profile.servers.length} MCP servers (env/header values as refs), ` +
          `${profile.rules.length} rules, ${profile.skills.length} skills\n` +
          `  Review URLs, command arguments, rule bodies, and skill files for credentials before committing.\n`,
      );
      if (conflicts.length > 0) {
        process.stdout.write(
          `  profile written WITHOUT the ${conflicts.length} excluded item(s) below (exit 1):\n`,
        );
      }
      for (const c of conflicts) {
        process.stdout.write(
          `  \u26a0 EXCLUDED ${c.kind} "${c.name}": definitions diverge across ${c.agents.join(', ')} — align and re-export\n`,
        );
      }
      for (const warning of warnings) process.stdout.write(`  \u26a0 ${warning}\n`);
      return conflicts.length > 0 || warnings.length > 0 ? 1 : 0;
    }
    case 'import': {
      const dir = str(p.flags.from);
      if (!dir) throw new Error('import: --from <dir> is required');
      const profile = await readProfile(dir);
      const targetArg = str(p.flags.to) ?? 'all';
      const serverTargets = profile.servers.length ? await resolveTargets(adapters, targetArg) : [];
      const skillTargets = profile.skills.length ? await resolveTargets(adapters, targetArg, 'skill') : [];
      const ruleTargets = profile.rules.length ? await resolveTargets(adapters, targetArg, 'rule') : [];
      const desired = await prepareProfileDesiredState(
        adapters,
        profile,
        dir,
        { servers: serverTargets, skills: skillTargets, rules: ruleTargets },
        { env: process.env },
      );
      let rc = 0;
      process.stdout.write(
        `profile desired state: additive (no pruning) — ${desired.summary.desiredInstances} target instance(s), ` +
          `${desired.summary.changes} change(s), ${desired.summary.satisfied} already satisfied, ` +
          `${desired.summary.blocked} blocked\n`,
      );
      for (const warning of desired.warnings) process.stdout.write(`\u26a0 ${warning}\n`);
      for (const missing of desired.missingSecrets) {
        process.stdout.write(
          `\u2717 ${missing.server}: missing secrets on this machine: ${missing.names.join(', ')} — export them as env vars and re-run\n`,
        );
      }
      if (desired.missingSecrets.length > 0) {
        process.stdout.write(
          'no profile item was planned or applied because the desired state is unresolved\n',
        );
        return 1;
      }
      let completedEntries = 0;
      for (const entry of desired.entries) {
        try {
          // Every entry was pre-planned above. Refresh only at commit time so an
          // earlier item that shares the same config file does not stale the next
          // item's base hash.
          const plan = commit ? await refreshProfileDesiredEntry(adapters, entry) : entry.plan;
          rc = Math.max(rc, await runPlan(adapters, plan, commit));
          completedEntries++;
        } catch (error) {
          if (commit) {
            process.stdout.write(
              `profile reconciliation stopped after ${completedEntries}/${desired.entries.length} completed item(s); ` +
                'earlier successful changes remain applied and audited, and later items were not attempted\n',
            );
          }
          throw error;
        }
      }
      if (!commit)
        process.stdout.write(
          '\n(dry-run — add --commit to apply this additive desired state; omitted capabilities are untouched)\n',
        );
      return rc;
    }
    case 'doctor': {
      const report = await runDoctor({ adapters, adapterLoadDiagnostics }); // reuse — don't load BYO factories twice
      const icon = { ok: '\u2713', warn: '\u26a0', error: '\u2717' } as const;
      const recoveryText: Record<string, string> = {
        INSTALL_OR_CONFIGURE_AGENT:
          'install the agent runtime or initialize one of its known configuration paths',
        INITIALIZE_AGENT_CONFIGURATION: 'initialize the agent configuration before managing capabilities',
        CHECK_AGENT_INSTALLATION: 'verify the local agent installation and executable search path',
        CHECK_ADAPTER: 'inspect the local adapter configuration and retry detection',
        REPAIR_AGENT_CONFIGURATION: 'repair the local agent configuration before changing capabilities',
        RECOVER_PENDING_CHANGE: 'inspect the pending recovery state before another mutation',
        REPAIR_FLEET_STATE: 'repair or restore Fleet state before another mutation',
        RESTORE_BACKUP: 'restore the referenced backup before relying on rollback',
        WAIT_OR_CLEAR_STALE_LOCK:
          'wait for the active operation; clear the lock only after confirming none is running',
        REPAIR_FLEET_CONFIG: 'repair Fleet config.json and referenced local adapter paths',
        REPAIR_TEAM_POLICY: 'repair or remove the local team-policy.json ceiling',
      };
      let cat = '';
      for (const f of report.findings) {
        if (f.category !== cat) {
          cat = f.category;
          process.stdout.write(`\n[${cat}]\n`);
        }
        process.stdout.write(`  ${icon[f.level]} [${f.code}] ${scrubSecrets(f.message)}\n`);
        if (f.recovery) process.stdout.write(`      next: ${recoveryText[f.recovery]}\n`);
      }
      process.stdout.write(
        `\n${report.exitCode === 0 ? 'healthy' : report.exitCode === 1 ? 'warnings — see above' : 'ERRORS — see above'}\n`,
      );
      return report.exitCode;
    }
    case 'config': {
      const state = readEffectiveConfigState();
      const cfg = state.config;
      const shown = { ...cfg, hubUrl: cfg.hubUrl ? redactUrl(cfg.hubUrl) : null };
      process.stdout.write(`config: ${configPath()} (${state.configState.status})\n`);
      process.stdout.write(`team policy: ${teamPolicyPath()} (${state.policyState.status})\n`);
      process.stdout.write('effective config:\n');
      process.stdout.write(JSON.stringify(shown, null, 2) + '\n');
      return state.configState.status === 'read-failed' ||
        state.configState.status === 'invalid' ||
        state.policyState.status === 'read-failed' ||
        state.policyState.status === 'invalid'
        ? 1
        : 0;
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
      const auditId = p.positionals[0];
      const res = await rollback({
        auditId,
        ...(!auditId ? { implicitGuard: (audit) => assessImplicitRollback(audit) } : {}),
      });
      if (res.guardRefusal) {
        const core = res.guardRefusal.reasonCode === 'CORE_HISTORY_UNVERIFIABLE';
        process.stdout.write(
          `${core ? 'core audit history' : 'delegated plugin history or outcome'} is unverifiable or newer; ` +
            'refusing implicit core rollback.\n' +
            `${core ? 'repair the audit history' : 'inspect vendor plugin state'} before choosing a recovery action.\n`,
        );
        return 1;
      }
      process.stdout.write(`rollback: ${res.action} ${res.file}${res.reason ? ` (${res.reason})` : ''}\n`);
      process.stdout.write(renderProvenanceWarning(Boolean(res.lockWarning)));
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
    process.stderr.write(`fleet: ${publicErrorMessage(err)}\n`);
    process.exitCode = 1;
  });
