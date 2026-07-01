# fleet

**One place to see and manage the capabilities of all your AI coding agents.**

You run Claude Code, Codex (and soon others). Each has its own MCP servers, skills,
and behavioral rules — scattered across different config files and formats. `fleet`
gives you **one inventory, one-click install/update/remove across agents, and a
discovery feed** of new/updated capabilities — from a CLI, an MCP server (so an AI
can drive it), or a local web dashboard. Same core behind all three.

> Status: works end-to-end for **Claude Code + Codex** (MCP servers, skills, rules).
> Gemini is excluded for now (moved to Antigravity). "Bring your own agent" via adapters.
> Durable design record: `llm-wiki/wiki/projects/agent-fleet-manager/`.

## Why

- **See everything**: which MCP servers / skills / rules are on which agent, in one matrix.
- **Manage across agents**: install / update / remove / "apply to all" — instead of editing each agent's config by hand.
- **Discover**: get told what's new and what has updates, with heuristic recommendations relevant to your setup.
- **Safely**: every write is **dry-run by default**, backed up, validated, audit-logged, and reversible with `fleet rollback`. Secrets are never shown to an AI or the browser.

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
fleet whats-new                              # updates to yours + new/recommended
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

### Web dashboard (GUI)

```bash
fleet serve                            # → http://127.0.0.1:7777/?token=…  (open in a browser)
```

Capability matrix + updates + recommendations + conflicts, with one-click
install/update/remove/rollback (each shows a preview → you confirm). Loopback-only
and token-gated. To reach it from another device over **Tailscale**, keep the
loopback bind and put `tailscale serve` in front:

```bash
fleet serve --allow-host <machine>.<tailnet>.ts.net
tailscale serve --bg 7777
```

(Never bind `0.0.0.0`; never expose a write-capable daemon via `tailscale funnel`.)

## Safety model

- **Dry-run by default** — writes need `--commit` (CLI) / `commit:true` (MCP) / an explicit Confirm (GUI).
- **Backup + atomic write + validate + audit + rollback**; a change is refused if the target file changed since the plan (hash guard).
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
