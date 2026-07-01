# v0 — read-only cross-agent inventory (built)

> Backfilled doc. Status: ✅ shipped (commit a5c1210).

## Goal

Prove the foundation: read what's installed across all the user's agents into
one unified, primitive- and agent-agnostic model. Zero risk (read-only).

## Scope

- Primitive: MCP servers only.
- Agents: Claude Code, Codex, Gemini (Hermes/custom via the same adapter path).
- Surface: CLI `fleet inventory [--json]` → capability × agent matrix.

## Structure

- `core/types.ts` — `InstalledCapability` (kind-discriminated union), `Inventory`.
- `core/adapter.ts` — `AgentAdapter` read contract.
- `core/registry.ts`, `core/inventory.ts` — adapter set + cross-agent builder.
- `core/coerce.ts` — defensive parsing helpers.
- `adapters/{claude-code,codex,gemini}.ts` — per-agent readers (injectable paths).
- `cli/{index,render}.ts` — CLI + matrix renderer.

## Acceptance (met)

- Detects present/absent agents; reads MCP servers with transport/scope.
- Matrix renders (✓/✗/– with scope tags); empty state messaged.
- Adapters fixture-tested; 16 tests at v0 close.

## Review outcome

Review #1 → SHIP-WITH-FIXES: fixed Gemini `url`→sse, Claude `streamable-http`/`ws`,
Codex `http_headers`/`enabled`; added fixture e2e + render tests; made
`InstalledCapability` a discriminated union; injectable adapter paths.
