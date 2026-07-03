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

## Part B — delegated install/remove (NEXT)

fleet must never write vendor-managed plugin dirs (they are the vendor CLI's
state). Instead, installs are DELEGATED: fleet runs the vendor's own command.

- Plan = the exact command that would run (e.g.
  `claude plugin install figma@claude-plugins-official`), shown in the
  preview→confirm flow like any other change.
- Apply = execute the vendor CLI; audit-log the action; rollback = the vendor's
  uninstall command. HONEST LIMIT: no byte-level hash-guard/backup is possible
  for delegated changes — the audit records intent + outcome, and undo relies on
  the vendor's uninstall being correct.
- Trust gate matters MOST here (plugins bundle hooks/commands = executing code):
  the confirm must show marketplace provenance + trust signals.

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
