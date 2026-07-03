# Vendor plugins — design (read → delegated install → equivalence)

Every major agent now has a plugin/extension concept — a vendor-specific BUNDLE
of the primitives fleet manages (commands + skills + MCP servers + hooks):

| Agent                    | Concept                | Install                                            |
| ------------------------ | ---------------------- | -------------------------------------------------- |
| Claude Code              | Plugins (marketplaces) | `/plugin`, `claude plugin install <name>@<market>` |
| Codex                    | Plugins                | `/plugins` in the CLI                              |
| Gemini CLI → Antigravity | Extensions → plugins   | `gemini extensions install <repo>`                 |

The formats are mutually incompatible — the per-agent-silo problem fleet exists
to solve, reproduced at the bundle level.

## Part A — read-only inventory (BUILT)

Plugins installed on an agent must show up in the fleet matrix, or "see
everything in one place" is false. New `plugin` kind (read-only):

- **Claude** (shape verified on a real machine): enabled plugins come from
  `settings.json` `enabledPlugins` (`"<plugin>@<marketplace>": true`);
  marketplace registration in `~/.claude/plugins/known_marketplaces.json`;
  descriptions enriched from each marketplace's
  `.claude-plugin/marketplace.json`. fleet reads, never writes, these.
- **Codex**: guarded scan of `~/.codex/plugins` subdirectory names (shape not
  yet verified on a real install — names only, nothing parsed).
- Surfaces: CLI matrix "Plugins (read-only)" section, `summarizeInventory`
  plugins list, dashboard matrix rows.

## Part B — delegated install/remove (pre-work DONE 2026-07-03)

fleet must never write vendor-managed plugin dirs (they are the vendor CLI's
state). Instead, installs are DELEGATED: fleet runs the vendor's own command.

### Verified vendor commands (real machine)

Both CLIs expose non-interactive plugin management, and both use the SAME
`PLUGIN[@MARKETPLACE]` selector convention (a gift for Part C equivalence):

|                | Claude Code 2.1.196                                         | Codex 0.142.5                                      |
| -------------- | ----------------------------------------------------------- | -------------------------------------------------- |
| install        | `claude plugin install <p>[@m]` `[-s user\|project\|local]` | `codex plugin add <p>[@m]`                         |
| remove         | `claude plugin uninstall <p>` `[-s scope]`                  | `codex plugin remove <p>`                          |
| enable/disable | `claude plugin enable/disable <p>`                          | —                                                  |
| update         | `claude plugin update <p>`                                  | (marketplace upgrade)                              |
| list (verify)  | `claude plugin list --json` (+`--available`)                | `codex plugin list` (table)                        |
| marketplaces   | `claude plugin marketplace add/list/remove/update`          | `codex plugin marketplace add/list/upgrade/remove` |

Codex ships an `openai-curated` marketplace snapshot out of the box (linear,
gmail, google-calendar, atlassian-rovo, … visible in `codex plugin list`).

### Execution architecture

- New adapter capability `PluginManager` (optional, like the writers):
  `planPluginInstall/Remove(selector) → DelegatedAction` — PURE (builds argv,
  executes nothing). `DelegatedAction = { agent, argv, undoArgv?, describe }`.
- Core `delegate.ts` executes a DelegatedAction: `spawn` with an **argv array,
  never a shell** (no shell-injection surface), cwd-neutral, ~120s timeout,
  stdout/stderr tail captured. Selector validated first:
  `/^[\w@][\w.\/-]*(@[\w.-]+)?$/`, reject leading `-` (no flag smuggling).
- Preview→confirm shows the EXACT argv + marketplace provenance + trust signal
  (plugins bundle hooks/commands = executing code — the highest-trust confirm).
- Audit record kind `delegated`: argv, undoArgv, exit code, output tail.
  Rollback = run `undoArgv` (vendor uninstall) — best-effort by nature.
- HONEST LIMITS: no byte-level hash-guard/backup for delegated changes; undo
  relies on the vendor's uninstall being correct; vendor CLI may still prompt in
  edge cases (treat non-zero exit/timeout as failure, surface output tail).
- Post-apply verification: re-read the inventory (Claude: settings.json
  enabledPlugins; cross-check available via `claude plugin list --json`).

### Open items for the implementation

1. Codex INSTALLED-plugin state location (config.toml? cache dir?) — verify by
   performing a real `codex plugin add` + `remove` during implementation, then
   fix `readCodexPlugins` if the Part-A guess (`~/.codex/plugins`) is wrong.
2. Claude `plugin install` prompting behavior on an unregistered marketplace —
   test; fleet should require the marketplace to be registered first (or run
   `marketplace add` as a separate previewed step).
3. `codex plugin list` has no `--json` — parse the table or rely on file reads.

## Part C — cross-agent equivalence (LATER)

"Install X everywhere" for plugins means installing _equivalents_, not one
artifact: the same logical tool (e.g. Figma) exists as different plugins in each
ecosystem. Mirrors the MCP per-ecosystem package coordinates:

- Feed items gain per-agent plugin coordinates
  `{ claude: "figma@market", codex: "figma", antigravity: "figma-ext" }`
  (equivalence mapping — curated and/or matched by name/publisher; a natural
  central-hub enrichment).
- `fleet plugin install figma --to all` → each agent gets its native equivalent
  via Part B delegation; agents with no equivalent are honestly skipped.
- Plugin marketplaces join the discovery feed as sources.
