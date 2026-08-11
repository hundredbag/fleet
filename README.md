# fleet

**One place to see and manage the capabilities of all your AI coding agents.**

You run Claude Code, Codex (and soon others). Each has its own MCP servers, skills,
and behavioral rules, scattered across different config files and formats. `fleet`
gives you one inventory, exact cross-agent operations where the adapters support
them, and a discovery feed of new or updated capabilities. Use it from the CLI, as
an MCP server (so an AI can drive it), or through the local web dashboard. All three
use the same core.

> Status: works end-to-end for **Claude Code + Codex** (MCP servers, skills, rules).
> Gemini is excluded for now (moved to Antigravity). "Bring your own agent" via adapters.
> Durable design record: `llm-wiki/wiki/projects/agent-fleet-manager/`.

## Why

- **See everything**: which MCP servers / skills / rules are on which agent, in one matrix.
- **Manage where supported**: MCP install/update and exact sync/remove operations are available when the target adapters advertise them. Skills, rules, and plugins have narrower adapter- and vendor-specific limits.
- **Discover**: review a bounded feed of public registry metadata, source trust flags, and explicit reasons such as new, popular, marketplace, or related to installed items.
- **Safely**: writes are **dry-run by default**. Core-managed writes are backed up, validated, audit-logged, and reversible with `fleet rollback`; delegated vendor-plugin actions follow the vendor CLI's own recovery model. Secrets are never shown to an AI or the browser.

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
fleet rollback                               # undo the last change
```

Full command reference: [docs/USAGE.md](docs/USAGE.md).

### MCP (let an AI drive it)

```bash
claude mcp add fleet -- fleet-mcp      # or: -- node /abs/path/dist/mcp/server.js
```

Then ask your agent: _"fleet inventory"_, _"install playwright on claude and codex"_,
_"anything new worth adding?"_, _"undo that"_. Mutations are dry-run unless `commit:true`.

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
  is not rollback-eligible here.

Capability actions in the current dashboard are **preview-only**: install, update,
sync, and remove buttons request a dry-run plan but do not apply it. MCP install and
update plus exact cross-agent sync/remove appear only where authoritative adapter
operations allow them. Skill and rule controls can be read-only or absent; plugin
actions may be delegated to a vendor CLI. There is no universal one-click action.

Activity rollback is the exception: it targets the selected eligible audit ID and
requires a second explicit confirmation. If the target changed after Fleet recorded
it, rollback is skipped rather than overwriting the divergence. It is not a global
or "latest change" rollback button.

The dashboard starts in the OS light/dark preference unless you have explicitly
chosen a theme; explicit theme and English/Korean language choices persist locally.
State labels are literal: `unavailable`, `unsupported`, `missing`, `all present`,
`gap`, `read-only`, and `delegated`. Fleet does not infer "Healthy" or "aligned."

The server is loopback-only by default and bearer-token gated. The launch URL's `?token=` is
copied into browser session storage and removed from the visible URL and history;
every request must pass the exact Host allowlist/anti-DNS-rebinding check. JSON POST
requests—including plan, apply, and rollback—also require a matching Origin,
`application/json`, and the bearer token in the Authorization header; a query token
does not authenticate POSTs. The browser UI does not apply capability plans, but the
daemon still exposes the mutation-capable `POST /api/apply` for authenticated
clients. Treat the bearer token and tokenized launch URL as mutation credentials and
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

- **Dry-run by default**: writes need `--commit` (CLI) or `commit:true` (MCP). Dashboard capability actions stop at a preview; targeted Activity rollback has its own explicit confirmation.
- **Core-managed writes use backup + atomic write + validation + audit + rollback**; a change is refused if the target file changed since the plan (hash guard). Delegated plugin mutations use the vendor CLI and are not Fleet-backup or Fleet-rollback eligible.
- **Self-protection**: fleet won't let you remove fleet itself.
- **Secret redaction** at every AI/human boundary — the MCP tools and web dashboard only ever emit redacted metadata.
- **`~/.fleet/`** holds the audit log + backups.

> Caveat: `fleet inventory --json` prints the **raw** inventory (including MCP
> `env`/`headers`, which may hold tokens). It's a local tool over your own config —
> don't pipe `--json` anywhere public. (The MCP/web faces are always redacted.)

## Architecture

One `core` (inventory, safe write engine, orchestrator, redaction, conflict analysis)

- per-agent **adapters** + a client-side **feed** + three thin **faces** (CLI / MCP / web).
  The feed is decoupled from the write path (enforced by an ESLint boundary rule): a
  feed source only emits public metadata; your inventory never leaves the machine, and
  "updates to mine" matching is done locally. A future central hub plugs in as one more
  feed source. See `docs/`.

## Adding an agent (Bring Your Own Agent)

Implement `AgentAdapter` (`detect()` + `readInventory()`, plus the writer methods to
enable mutation) and register it in `src/core/registry.ts`. That's the extensibility
path that lets custom agents (e.g. Hermes, Antigravity) join the same control plane.

## Development

```bash
npm run ci        # lint + format:check + typecheck + test + build
npm test
npm run lint
npm run format
```

## License

MIT
