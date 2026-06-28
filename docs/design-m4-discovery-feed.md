# M4 — discovery feed (STUB)

> Stub. Finalize just before building.

## Goal
Tell the user **what's new** in the agent-tooling ecosystem, and which of their
**installed** capabilities have updates — filtered to what's installable into
*their* agents.

## Scope
- Sources (reuse, don't rebuild): official MCP Registry API, PulseMCP API,
  agents-radar RSS. (Skills/rules sources later.)
- Two views: "new & relevant" and "updates to what I have".

## Approach (sketch)
- `FeedSource` interface → normalized `FeedItem`.
- Merge + dedupe across sources; diff against `Inventory` (from v0) for updates.
- Cache + seen-state in `~/.fleet/`; periodic/on-demand refresh.

## Key risks / open questions
- Registry rate limits / availability / offline behavior.
- Dedup across overlapping registries; noise/curation quality.
- Refresh cadence; where seen-state lives.
- Trust scoring tie-in (M6) — feed should surface trust signal once it exists.

## Acceptance
- `fleet whats-new` lists new relevant servers + updatable installed ones, with
  source attribution.

## Depends on
v0 inventory (for "updates to mine"). Optional tie-in: M6 trust.
