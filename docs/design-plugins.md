# Vendor plugins — design (read → delegated install → equivalence)

Every major agent now has a plugin/extension concept — a vendor-specific BUNDLE
of the primitives fleet manages (commands + skills + MCP servers + hooks):

| Agent                    | Concept                | Install                                            |
| ------------------------ | ---------------------- | -------------------------------------------------- |
| Claude Code              | Plugins (marketplaces) | `/plugin`, `claude plugin install <name>@<market>` |
| Codex                    | Plugins                | `codex plugin add <name>@<market>`                 |
| Gemini CLI → Antigravity | Extensions → plugins   | `gemini extensions install <repo>`                 |

The formats are mutually incompatible — the per-agent-silo problem fleet exists
to solve, reproduced at the bundle level.

## Part A — read-only inventory (Claude built; Codex intentionally unavailable)

Plugins installed on an agent must show up in the fleet matrix, or "see
everything in one place" is false. New `plugin` kind (read-only):

- **Claude** (shape verified on a real machine): enabled plugins come from
  `settings.json` `enabledPlugins` (`"<plugin>@<marketplace>": true`);
  marketplace registration in `~/.claude/plugins/known_marketplaces.json`;
  descriptions enriched from each marketplace's
  `.claude-plugin/marketplace.json`. fleet reads, never writes, these.
- **Codex**: Fleet does not publish a plugin inventory yet. Current Codex exposes
  `plugin list --json` and plugin packages contain `.codex-plugin/plugin.json`,
  but Fleet has not adopted and regression-tested that JSON schema. A directory
  scan is not authoritative installed state, so the adapter reports plugin
  inventory as `unverifiable` and exposes no install/remove operation.
- Surfaces: CLI matrix "Plugins (read-only)" section, `summarizeInventory`
  plugins list, dashboard matrix rows.

## Part B — delegated install/remove (pre-work DONE 2026-07-03)

fleet must never write vendor-managed plugin dirs (they are the vendor CLI's
state). Instead, installs are DELEGATED: fleet runs the vendor's own command.

### Verified vendor commands (real machine)

Both CLIs expose non-interactive plugin management and accept a
`PLUGIN[@MARKETPLACE]` selector at their CLI boundary. Fleet keeps the logical
plugin name and marketplace identifier as separate fields internally; the joined
selector is never used as the capability name.

|                | Claude Code 2.1.196                                         | Codex 0.142.5                                      |
| -------------- | ----------------------------------------------------------- | -------------------------------------------------- |
| install        | `claude plugin install <p>[@m]` `[-s user\|project\|local]` | `codex plugin add <p>[@m]`                         |
| remove         | `claude plugin uninstall <p>` `[-s scope]`                  | `codex plugin remove <p>`                          |
| enable/disable | `claude plugin enable/disable <p>`                          | —                                                  |
| update         | `claude plugin update <p>`                                  | (marketplace upgrade)                              |
| list (verify)  | `claude plugin list --json` (+`--available`)                | `codex plugin list --json` (+`--available`)        |
| marketplaces   | `claude plugin marketplace add/list/remove/update`          | `codex plugin marketplace add/list/upgrade/remove` |

Codex plugin packages and local marketplaces are documented in the official
[plugin concepts](https://developers.openai.com/plugins/concepts/plugins) and
[plugin build guide](https://learn.chatgpt.com/docs/build-plugins). Fleet still
requires a tested inventory adapter before treating that CLI output as state.

### Execution architecture

- Explicit adapter `capabilitySupport.plugin.management = delegated` metadata
  plus Fleet's allowlisted built-in vendor argv table selects eligible targets.
  Planning reads inventory and records the required pre-state before any vendor
  command can run.
- Core `delegate.ts` executes a delegated plan: `spawn` with an **argv array,
  never a shell** (no shell-injection surface), cwd-neutral, ~120s timeout,
  stdout/stderr tail captured. Selector validated first:
  `^(@[\w][\w.-]*\/)?[\w][\w.-]*(@[\w][\w.-]*)?$`, also rejecting `..`
  (no path traversal or flag smuggling).
- Preview→confirm shows the exact argv and a code-execution warning. The current
  implementation does not independently prove marketplace provenance or assign
  a plugin trust score, so the operator must verify the selector/vendor source.
- The private delegated ledger stores only allowlisted argv identity, exit code,
  verified pre-state, and effect (`changed | unchanged | unverifiable`); vendor
  output is scrubbed and is not persisted.
- HONEST LIMITS: no byte-level hash-guard/backup. Fleet re-reads inventory before
  and after execution, but a vendor bundle can have effects that inventory does
  not describe. Only an exit-0 plus inventory-verified `changed` result may carry
  inverse guidance; failed, no-op, legacy, or unverifiable outcomes require
  manual vendor-state inspection.

### Open items for the implementation

1. Define and fixture-test the Codex `plugin list --json` schema, including
   installed-vs-available state, marketplace identity, enabled state, and version
   compatibility. Only then change inventory from `unverifiable` to `supported`.
2. Claude `plugin install` prompting behavior on an unregistered marketplace —
   test; fleet should require the marketplace to be registered first (or run
   `marketplace add` as a separate previewed step).

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
