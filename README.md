# fleet

Unified, **cross-agent** capability manager + discovery feed for AI agents.

One place to see what's installed across **all** your agents (Claude Code,
Codex, Gemini, and custom agents like Hermes), manage it with one action
("apply to all"), and get told what's new — operable **by the AI itself**
(MCP server) and **by a human** (web dashboard), over a shared core.

> Durable design record: `llm-wiki/wiki/projects/agent-fleet-manager/agent-fleet-manager-concept.md`
> Landscape / white-space: `llm-wiki/wiki/research/market-business/`

## Status — v0 (read-only inventory, MCP primitive)

The first slice proves the foundation: an **adapter per agent** reads each
agent's config and produces a **unified inventory**. Read-only, zero-risk.

```
        ┌──────────── core engine ────────────┐
        │ inventory · adapters · (later) sync, │
        │ feed, trust                          │
        └──────────────────────────────────────┘
           │            │              │
      [MCP server]    [CLI]      [web dashboard]
       (later)       (now: v0)    (later)
```

Locked decisions: TypeScript/Node · MCP servers first · read-only inventory
first → then write · imperative one-click before declarative manifest ·
guardrails first-class (dry-run, self-protection, trust gate, audit log).

## Layout

```
src/
  core/
    types.ts       domain model (primitive- & agent-agnostic)
    adapter.ts     AgentAdapter interface (read-only in v0)
    registry.ts    built-in adapters
    inventory.ts   cross-agent inventory builder
  adapters/
    claude-code.ts ~/.claude.json (+ project .mcp.json)
    codex.ts       ~/.codex/config.toml  [mcp_servers.*]
    gemini.ts      ~/.gemini/settings.json  mcpServers
  cli/
    index.ts       `fleet inventory [--json]`
    render.ts      capability × agent matrix
tests/             node:test unit tests
```

## Develop

```bash
npm install
npm run typecheck
npm test
npm run inventory        # read your real agents (read-only)
npm run inventory -- --json
```

Requires Node >= 22.

> **Secrets:** the human matrix never prints config values, but `--json` emits
> the raw inventory verbatim — including MCP `env` / `headers` / `raw`, which may
> contain tokens. It's a local-only tool over your own config; don't pipe
> `--json` somewhere public.

> **Scope coverage (v0):** project-scoped `.mcp.json` servers are discovered
> only for projects your agent already tracks; there's no filesystem scan yet.

## Adding an agent (Bring Your Own Agent)

Implement `AgentAdapter` (`detect()` + `readInventory()`) and register it in
`src/core/registry.ts`. That's the extensibility path that lets custom agents
(e.g. Hermes) join the same control plane.
