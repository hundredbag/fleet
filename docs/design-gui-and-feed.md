# GUI + live feed — design (the product's discover→install→update loop)

> Historical planning snapshot. The implementation shipped with differences.
> [README.md](../README.md) and [USAGE.md](USAGE.md) define current behavior.

> Realignment (2026-07-01) after re-grounding the vision. The product is an app
> that manages many local agents' capabilities — **see everything, discover new,
> one-click install to some/all agents, see & one-click updates.** Three
> **co-equal faces** (CLI · MCP · GUI) over one shared `core`; no face is primary.

## What's already built (the engine) vs what this adds

Engine done: cross-agent inventory (mcp/skill/rule), safe install/sync/remove
(dry-run→commit, backup, staged no-clobber commit, audit, rollback, hash-guard), update DETECTION
(feed core: coords + semver), conflict analysis. **This milestone adds the two
missing pieces of the user's vision: the LIVE feed (real discover/update data)
and the GUI face** — plus wires the feed into all three faces equally.

## Principle: co-equal faces over one core

CLI, MCP, and GUI are peers. All capability/feed/plan/apply/redact logic lives
in `core` + `feed`; each face is a thin shell. A feature added to `core` is
available to all three at once. The GUI does not get privileged logic.

## Part 1 — Live feed (finish feed Part 2)

- Official **MCP Registry** `FeedSource` (verify `GET /v0/servers`, `updated_since`,
  cursor pagination at build time) behind the existing `FeedSource` seam.
- Cache + seen-watermark in `~/.fleet/`; offline → cached; never blocks.
- Wire into **all faces**: `fleet whats-new` (CLI), `whats_new` (MCP), and the
  feed data the GUI will render. Two views: **new & relevant** and **updates to mine**.
- Boundary held: sources produce public metadata only; matching stays local.

## Part 2 — Web daemon + read-only dashboard

- `fleet serve` — a local HTTP daemon on **127.0.0.1 only**, serving a browser UI.
- REST over core (thin): `GET /inventory`, `GET /feed` (new & updates),
  `GET /conflicts`. All responses go through `core/redact` (no secrets to browser).
- Frontend: single static HTML + vanilla JS (no framework/build step) to start —
  the capability×agent **matrix** (MCP/Skills/Rules), a **"new"** panel, an
  **"updates available"** panel, a **conflicts** panel.
- **Security (write comes in Part 3, but lock it now):** loopback bind, a random
  **session token** minted at start (required on every request), Origin/Host
  checks, CORS locked. Read-only in Part 2, so lowest risk first.

## Part 3 — GUI actions (the one-click loop)

- `POST /plan` (dry-run → returns diff/warnings), `POST /apply` (commit),
  `POST /rollback` — all via the same `core` `execute()` (dry-run→confirm inherited).
- UI: install a "new" item to **specific agent(s) or all** (one click → preview →
  confirm), **update** an outdated one (one click → preview → confirm), sync,
  remove, rollback. Conflict/impact warnings shown inline before confirm.
- Every mutating request requires the session token; every apply shows a preview
  first. Secrets never rendered.

## Deferred (candidate): permission management

On the user's list (mcp/skill/rule/**permission**) but **not in this milestone**.
Rationale: permissions are the highest-blast-radius config, formats are the most
divergent (Codex `prefix_rule` DSL / Claude allow-deny arrays / Gemini trust),
auto-translation is riskier than rules, and Codex self-manages its `.rules`
(Smart Approvals). **Plan: after GUI+feed, add READ-ONLY permission inventory
(see what each agent allows, in one place); NO cross-agent write/translate.**

## Roadmap after this

Central hub (metadata-only, signed, pull — a `FleetHubSource`) once the client
loop proves out; trust/quality gate (M6); read-only permission inventory.
