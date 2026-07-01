# Central hub — design (the "C" upgrade)

The hub is the server that does the heavy discovery/analysis the client can't:
crawl registries, run security/quality scanners, LLM-summarize + score
capabilities, and serve a **curated, metadata-only** feed. The client already
has the drop-in seam for it — this doc records the protocol + what's built vs
deferred, and the boundary that keeps it safe.

## Boundary (unchanged from feed design)

- **Metadata only, pull-only.** The hub serves public capability metadata. The
  client fetches it; the hub never reaches into a client, and the client NEVER
  sends its inventory to the hub. "Updates to mine" + relevance ranking stay
  **local** (`feed.ts`, `recommend.ts`), computed against the on-device inventory.
- The hub is just another `FeedSource` (`FleetHubSource`). Enrichment flows
  through the normal `FeedItem` fields (`popularity`, `status`, `security`, …);
  `discover()` merges it with the registry, `recommend()` ranks locally, and
  `assessTrust()` defers to a hub-provided `security` verdict when present.

## Protocol (v0)

`GET {hubUrl}/v0/feed[?since=<RFC3339>]` → `{ "items": FeedItem[] }`
(a bare `FeedItem[]` array is also accepted). Each item SHOULD carry the enriched
fields the client can't compute cheaply: `popularity`, `status`, and a
`security` verdict `{ level: 'caution'|'no-flags'|'unknown', reasons: string[] }`.

Enable on the client by setting `hubUrl` in `~/.fleet/config.json`. The hub then
joins the default sources automatically (see `defaultSources`).

## Built vs deferred

**Built now (client seam):** `FleetHubSource` (fetch + defensive map, injectable
for tests), `config.hubUrl` wiring, `assessTrust` honoring `item.security`, and
the `Scorer` seam in `recommend()` for an LLM-scored ranking. So the moment a hub
exists at `hubUrl`, its enriched + scored feed flows through with **no client
changes**.

**Deferred (needs a hosting decision — the user's call):** the hosted hub service
itself — crawler, security/quality scanners, LLM scoring, signing, and serving.
This is real infrastructure (where to host, auth, cost) and is intentionally NOT
built until that decision is made. Signing/verification of the feed (so the
client can trust the hub's metadata) is part of that milestone.

## Why this ordering

The client proves the whole loop (discover → recommend → install → update) against
the public registry today; the hub is a quality/intelligence upgrade layered on
top, not a prerequisite. Building the seam first means the hub can be developed
and swapped in independently, and a user who never runs a hub still gets a fully
working local tool.
