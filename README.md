# fleet

**One place to see and manage the capabilities of all your AI coding agents.**

You run Claude Code, Codex (and soon others). Each has its own MCP servers, skills,
and behavioral rules, scattered across different config files and formats. `fleet`
gives you one inventory, exact cross-agent operations where the adapters support
them, and a discovery feed of new or updated capabilities. Use it from the CLI, as
an MCP server (so an AI can drive it), or through the local web dashboard. All three
use the same core.

> Built-in adapters: **Claude Code and Codex**. Both support user-scope MCP,
> skill, and Fleet-managed rule changes. Permissions and subagent definitions
> are inventory-only. Claude plugin changes are delegated to its vendor CLI;
> Codex plugin inventory is currently unverifiable, so Fleet exposes no Codex
> plugin mutation. GeminiAdapter
> source and tests remain in the repository but it is not loaded by default.

## Why

- **See supported capability kinds**: MCP servers, skills, Fleet-managed rules,
  permissions, vendor plugins, and subagent definitions in one matrix. Commands
  and hooks are currently unsupported.
- **Manage where supported**: MCP install/update and exact sync/remove operations are available when the target adapters advertise them. Skills, rules, and plugins have narrower adapter- and vendor-specific limits.
- **Discover**: review a bounded feed of public registry metadata, source trust flags, and explicit reasons such as new, popular, marketplace, or related to installed items.
- **Safely**: capability install/sync/remove, profile import, and pack install are
  dry-run by default. Export and rollback are explicit immediate-write commands.
  Core-managed writes use staged no-clobber commits, divergence guards, and audit-backed
  rollback where a recoverable prior state was recorded; delegated vendor-plugin
  actions follow the vendor CLI's recovery model.
- **Declare additive desired state**: a profile says which MCP servers, skills,
  and Fleet-managed rules should exist on selected agents. Import validates and
  pre-plans the complete profile before the first mutation. It never removes a
  capability merely because the profile omitted it.

## Install

Requires Node ≥ 22.

```bash
git clone <repo> fleet && cd fleet
npm install
npm run build
npm link          # optional: puts `fleet` and `fleet-mcp` on your PATH
```

## Use it — three faces, one core

### CLI

```bash
fleet inventory                              # capability × agent matrix
fleet whats-new                              # updates + new MCP servers + recommended skills (categorized)
fleet skill find <query>                     # search the skills.sh registry
fleet install github --to all \
      --command npx --arg -y --arg @modelcontextprotocol/server-github     # dry-run
fleet install github --to all --command npx --arg -y --arg @modelcontextprotocol/server-github --commit
fleet sync github --from claude-code --to codex --commit
fleet conflicts                              # opposing always-on rules (heuristic)
fleet rollback                               # undo latest eligible core change; never a newer delegated plugin action
```

Full command reference: [docs/USAGE.md](docs/USAGE.md).

### MCP (let an AI drive it)

```bash
claude mcp add fleet -- fleet-mcp      # or: -- node /abs/path/dist/mcp/server.js
```

Then ask your agent: _"fleet inventory"_, _"install playwright on claude and codex"_,
_"anything new worth adding?"_. Install/sync/remove tools preview unless
`commit:true`. `rollback` is the exception: it executes immediately and should
use an explicit audit ID whenever possible. Without one, a newer delegated
plugin record makes it refuse rather than undo an unrelated older core change.
Both implicit and explicit rollback fail closed when the core audit history is
damaged, incomplete, or contains duplicate IDs.

### Unified web dashboard (GUI)

```bash
fleet serve                            # → http://127.0.0.1:7777/?token=…  (open in a browser)
```

The dashboard has five views:

- **Overview**: fleet counts, capability-by-agent map, updates, and signals.
- **Inventory**: searchable and filterable capability details with only the exact
  operations supported for each agent cell.
- **Discover**: bounded MCP, skill, and plugin results with feed source, trust, and
  recommendation reasons. These are metadata signals, not quality grades.
- **Drift**: modified, missing, unverifiable, and unmanaged findings plus conflicts.
- **Activity**: recent core-audit and delegated-plugin records. Select an eligible
  core-audit record by audit ID to roll back that change; delegated plugin activity
  is not rollback-eligible here. An older record is eligible only when no newer
  active change targets the same native state; rollbacks therefore unwind in order.

Capability-action buttons use a **preview → explicit confirm → apply** flow. Install,
update, sync, and remove first request a dry-run plan; only the separate confirmation
submits its short-lived single-use plan ID to `POST /api/apply`. The result dialog
shows per-target provenance recording, partial/failed/outcome-unknown states, and
fixed recovery guidance before refreshing Inventory and Activity. Exact actions
appear only where authoritative adapter operations allow them. Skill and rule
controls can be read-only or absent; plugin actions may be delegated to a vendor
CLI. There is no universal action that applies to every agent and capability.

Activity rollback is a separate targeted flow: it shows the capability kind,
recorded time, and exact eligible audit ID before explicit confirmation. If the target changed after Fleet recorded
it, or a newer active audit change targets the same native state, Fleet refuses to
cross that boundary. If the response cannot be verified, the dashboard reports an
unknown outcome and refreshes Inventory and Activity before permitting another
selection. It is not a global or "latest change" rollback button.

The dashboard starts in the OS light/dark preference unless you have explicitly
chosen a theme; explicit theme and English/Korean language choices persist locally.
State labels are literal: `unavailable`, `unsupported`, `missing`, `all present`,
`gap`, `read-only`, and `delegated`. Fleet does not infer "Healthy" or "aligned."

The server is loopback-only by default and bearer-token gated. The launch URL's `?token=` is
copied into browser session storage and removed from the visible URL and history;
every request must pass the exact Host allowlist/anti-DNS-rebinding check. JSON POST
requests—including plan, apply, and rollback—also require a matching Origin,
`application/json`, and the bearer token in the Authorization header; a query token
does not authenticate POSTs. After a separate dry-run confirmation, the browser UI
uses the mutation-capable `POST /api/apply` with a short-lived single-use plan ID.
Treat the bearer token and tokenized launch URL as mutation credentials and
keep them private. Responses carry a strict `no-store` policy, while the dashboard
HTML also carries a strict Content Security Policy. To reach the dashboard from
another device over
**Tailscale**, keep the loopback bind and put `tailscale serve` in front:

```bash
fleet serve --allow-host <machine>.<tailnet>.ts.net
tailscale serve --bg 7777
```

(Never bind `0.0.0.0`, use `tailscale funnel`, or otherwise expose this write-capable
daemon to the public internet. Limit remote access to a trusted, preferably
single-user tailnet.)

## Safety model

- **Preview-first capability changes**: MCP/skill/rule/plugin install, sync, and
  remove plus profile import and pack install need `--commit` (CLI) or
  `commit:true` (MCP). `fleet export` writes its target immediately. CLI/MCP
  rollback also executes immediately; targeted Web Activity rollback requires
  its own explicit confirmation.
- **Profile boundaries**: `fleet export` builds and validates a complete sibling
  generation before replacing the managed `profile.json` and `skills/` snapshot;
  unrelated files in the export directory are retained. Import accepts only the
  strict v1 manifest shape, resolves every declared secret, and initially plans
  every item before applying any. Commit refreshes each item immediately before
  applying it because several entries can share one native agent config file.
  Import is additive and does not prune omitted capabilities. Its individual
  audited writes are not one cross-agent transaction, so a later runtime or
  concurrency failure can still leave an explicitly reported partial result.
  Export targets a dedicated profile subdirectory inside a dotfiles repository;
  Fleet refuses to generation-swap a directory that directly contains `.git`.
- **Core-managed writes use prevalidated staging, no-clobber pathname commits, and hash guards, and normally record audit-backed rollback data**. Directory snapshots reject FIFO, socket, and device entries rather than dropping them. New targets have no prior-state backup, and if an audit append fails after a successful mutation, Fleet reports that automatic rollback is unavailable. A commit that leaves preserved recovery state is reported as outcome-unknown and must be inspected before retrying. Delegated plugin mutations use the vendor CLI and are not Fleet-backup or Fleet-rollback eligible.
- **Core-entry self-protection**: Fleet refuses core MCP/skill/rule changes targeting its own reserved entry. Vendor plugin selectors follow the vendor CLI's namespace and recovery rules.
- **Secret minimization at remote-consumption boundaries** — MCP tools use
  tool-specific allowlisted DTOs; the web API also uses fixed public DTOs.
  Known secret shapes in permitted strings are scrubbed again before
  serialization. Logical names and selected public metadata remain visible.
  Local CLI diagnostics may intentionally include local paths.
- **`~/.fleet/`** holds the audit log + backups.

> `fleet inventory --json` prints the same **redacted summary model** used by the
> MCP inventory tool. It omits raw adapter entries, MCP `env`/`headers`, source
> file paths, and subagent prompts. Treat all local diagnostic output with normal
> care, especially when using third-party adapter plugins.

Inventory agent rows separately report runtime, configuration, setup, and inventory
status. A discovered executable with no configuration is not treated as a managed
`present` agent and is never added implicitly to an `all` mutation. `fleet doctor`
uses the same snapshot and returns stable finding/recovery codes rather than parsing
human diagnostic text.

Scoped MCP entries remain distinct inventory identities. Fleet has no active
project context, so it does not guess which user/project/local entry is effective;
ambiguous sync sources require an explicit scope. Mutations remain user-scope only,
and project/local entries are read-only until an exact scope writer exists.

In `~/.fleet/config.json`, `agents` constrains the active adapter registry and
`feedSources` constrains the available default discovery sources. `null` or an
omitted field means all available entries; `[]` means none. These process-level
allowlists take precedence over per-command selectors: an explicit `--to` cannot
reactivate an adapter excluded by `agents`, and direct `skill find`/`skill_search`
requests cannot use `skills.sh` when that source is excluded.

## Local team policy

An administrator can provision `$FLEET_HOME/team-policy.json` as a versioned,
local-only ceiling over user preferences:

```json
{
  "version": 1,
  "agents": ["claude-code", "codex"],
  "feedSources": ["mcp-registry", "skills.sh"],
  "trustPolicy": "block",
  "allowAdapterModules": false
}
```

Fleet does not fetch remote policy or contact an organization account. List
ceilings intersect with `config.json`, team `block` cannot be weakened, and a
present policy must explicitly opt into in-process BYO adapter modules. Invalid,
unreadable, wrong-type, or symlinked policy state disables adapter/feed/module
activation for read-only startup and blocks mutations until repaired. `fleet
config` shows both source states and the effective config; `fleet doctor` emits
stable policy findings.

## Architecture

One `core` (inventory, safe write engine, orchestrator, redaction, conflict analysis)

- per-agent **adapters** + a client-side **feed** + three thin **faces** (CLI / MCP / web).
  The feed is decoupled from the write path (enforced by an ESLint boundary rule): a
  feed source only emits public metadata; your inventory never leaves the machine, and
  "updates to mine" matching is done locally. An optional configured hub can join as
  one more feed source. See `docs/`.

## Adding an agent (Bring Your Own Agent)

Implement `AgentAdapter` (`detect()` + `readInventory()`, plus writer methods where
appropriate) with `contractVersion: 1`. A built-in adapter is registered in `src/core/registry.ts`; an external
adapter module can instead be listed in `~/.fleet/config.json` under `adapterModules`.

## Development

```bash
npm run ci        # lint + format:check + typecheck + test + build
npm test
npm run lint
npm run format
```

## License

MIT
