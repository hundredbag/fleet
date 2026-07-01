# M5 — local web dashboard (STUB)

> Stub. Finalize just before building.

## Goal

The human-pretty view: a local web dashboard served by the same daemon —
the capability × agent matrix + one-click actions + the discovery feed.

## Scope

- Read first (render the matrix in a browser), then wire actions to the M2
  engine via a dry-run **preview → commit** flow.
- Feed panel (M4) once available.

## Approach (sketch)

- One local daemon hosts: MCP server (M3) + a small REST API over the core +
  static UI. localhost-only.
- UI framework TBD (lean minimal — vanilla/lit or small React); decide at build.

## Key risks / open questions

- Keep a single shared core across CLI / MCP / web (no logic drift).
- Auth/exposure (bind localhost; never remote without auth).
- Secrets in the UI (mask env/headers; mirror CLI's no-print stance).
- Daemon lifecycle (start/stop, port selection), bundling/distribution.

## Acceptance

- Browser shows the live cross-agent matrix; one-click install shows a dry-run
  diff then commits; feed visible.

## Depends on

M2 (actions), M3 (daemon/core API shape), M4 (feed panel).
