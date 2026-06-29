# Discovery feed + central hub — design

> Supersedes the `design-m4-discovery-feed.md` stub (the feed was reordered
> after Skills & Rules). The headline here is the **local ↔ hub boundary** —
> made explicit in code before any network/server code lands.

## The local ↔ hub boundary (enforced, not just convention)

```
LOCAL (client)  inventory read · planning · writing · conflict analysis ·
                "updates to mine" MATCHING            ← user data NEVER leaves
   ▲ pull (metadata only, outbound only)
HUB (server, LATER)  crawl registries · tool lists · security/quality ·
                     conflict flags → curated, SIGNED, metadata-only feed
```

- **Seam = `FeedSource`.** The client consumes one or more sources: direct
  registry sources, or a `FleetHubSource` (the future hub). Matching/diff is
  done by the client **regardless of source**.
- **Privacy invariant (structural):** a `FeedSource` only ever *produces* public
  metadata; it is NEVER handed the inventory. The "updates to mine" matching
  takes `(inventory, feedItems)` as inputs in a LOCAL function — inventory is
  passed in, never fetched by a source.
- **Module enforcement:** new code lives in `src/feed/`, which imports the
  capability *types* and `core` read helpers but **NOT** the writer/engine or
  adapter mutation paths. Network code is confined to source adapters. This keeps
  server-only concerns out of the privacy-sensitive write path, and (when the hub
  is built) lets the hub be a separate entrypoint/package reusing only `core` +
  `feed` types.

## Scope (this milestone = client-side only; hub stays a drop-in)

- `FeedSource` interface: `list(opts): Promise<FeedItem[]>` (+ `id`, `describe`).
- `FeedItem` (normalized, public): `name`, `source`, `identifier` (package
  coordinates, e.g. `@modelcontextprotocol/server-github`), `version?`,
  `url?`, `description?`, `updatedAt?`, `popularity?`, `security?` (placeholder
  for M6).
- `discover(sources, {since})` → merged + de-duped items.
- `updatesForInventory(inv, items)` → for each installed MCP server, extract its
  **package coordinate** from the install spec (`npx -y @x/y` → `@x/y`; remote →
  host) and match against `FeedItem.identifier`; compare versions → "update
  available". The killer feature, and it stays LOCAL.
- Faces: `fleet whats-new` CLI + `whats_new` MCP tool — two views: "new &
  relevant" and "updates to mine". Cache + seen-watermark in `~/.fleet/`.
- **Defer:** the hosted hub server; PulseMCP/agents-radar sources; trust scoring
  (M6); a skills/rules feed.

## Honest constraints

- Network: sources are thin fetch adapters; offline → use cache; the feed must
  never block other commands. Tests use a **fake `FeedSource`** (deterministic);
  the live registry source is a thin adapter verified at build time.
- Matching is fuzzy (package coordinates). Unmatched installed servers are
  reported honestly as "couldn't match to a registry entry", not hidden.
- Registry API shape (official MCP Registry `GET /v0/servers`, `updated_since`,
  cursor pagination) verified live just before building Part 2.

## Parts (each: build → dedicated review → fix → verify)

- **Part 1** — `feed/` core: `FeedSource` + `FeedItem` + `discover` +
  `updatesForInventory` (package-coordinate extraction/matching) + cache/seen +
  a fake source + tests. Client-only, fully deterministic.
- **Part 2** — live official MCP Registry source + `fleet whats-new` / `whats_new`
  MCP tool wiring + caching/offline behavior.
- **Later** — central hub server (separate entrypoint): crawl + analyze +
  sign + serve; `FleetHubSource` on the client. Built only once the client side
  proves out; keeps inventory/matching local.

## Package-coordinate extraction (the matching crux)

From an `McpServerSpec`:
- stdio `npx -y <pkg>` / `npx <pkg>` → npm package `<pkg>` (strip flags).
- stdio `uvx <pkg>` / `pipx run <pkg>` → PyPI package.
- stdio other `command` → best-effort: the command basename (low confidence).
- remote http/sse → the URL host (low confidence).
Confidence is recorded; only high-confidence coordinate matches drive an
"update available" claim. Everything else is "present, unmatched".
