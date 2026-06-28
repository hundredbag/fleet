# M3 — MCP server face (STUB)

> Stub. Finalize just before building (after M2 ships), with the real core API
> in context.

## Goal
Expose the core as an **MCP server** so any agent (Claude/Codex/Gemini) can
drive the whole fleet *in-loop* by calling tools — "the AI is the UI."

## Scope
- Tools: `inventory`, `install`, `remove`, `update`, `sync`, `whats_new`,
  `trust_check`. Thin shell over the same core as the CLI (no logic duplication).
- Read tools return structured inventory; write tools reuse the M2 engine.

## Approach (sketch)
- `@modelcontextprotocol/sdk` (TS), stdio transport.
- Each tool = a wrapper mapping args → core functions → structured result.
- Self-installable: `fleet` registers itself as an MCP server in each agent.

## Key risks / open questions
- **Confirmation when the caller is an AI**: no interactive prompt. Need a
  propose→apply (dry-run returns a plan id; `apply` commits) or an explicit
  `commit: true` param. Decide the safe default (dry-run unless committed).
- **Self-protection**: fleet must refuse to remove/disable its own MCP entry.
- **Secrets**: tool outputs must not leak `env`/`headers`/tokens.
- SDK version + tool schema shapes (verify against current docs at build time).

## Acceptance
- From inside Claude (and Codex/Gemini), calling fleet tools lists inventory and
  installs/syncs an MCP server; destructive ops are gated (dry-run/commit).

## Depends on
M2 write surface (install/remove/sync + engine).
