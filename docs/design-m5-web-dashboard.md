# M5 — local web dashboard

> Implemented local management surface. [README.md](../README.md) and
> [USAGE.md](USAGE.md) define the operator-facing contract.

## Goal

The human-facing view: a token-gated local dashboard over the same core — the
capability × agent matrix, discovery, drift, activity, and explicit
preview/confirm/apply management.

## Scope

- Five views: Overview, Inventory, Discover, Drift, and Activity.
- Inventory/Discover actions use the shared M2 engine through
  **dry-run preview → explicit confirmation → single-use apply**.
- Activity performs only targeted eligible core rollback; delegated vendor
  history is never presented as core rollback.
- Public DTOs contain allowlisted logical identity/status fields and stable
  codes, not target paths, raw config, env/header values, vendor output, or
  caught error text.

## Approach (sketch)

- `fleet serve` hosts a dependency-free HTML/CSS/vanilla-JS UI and thin REST
  API over the shared core.
- Loopback is the default. Every request requires the random session token;
  Host/Origin/content-type/body-size checks protect the write endpoints.
- The browser obtains a short-lived plan from `/api/plan`; `/api/apply`
  consumes it once. Replayed/expired/stale plans are refused by the server.
- Apply results distinguish `applied`, `partial`, `nothing-to-do`, `failed`,
  and `outcome-unknown`, including per-target provenance recording and fixed
  recovery classes. An unverified response tells the operator to refresh
  Inventory and Activity before retrying.
- Search/filter/sort are local over public metadata. English/Korean and
  light/dark preferences persist without changing the server state.

## Key risks / open questions

- Non-loopback binding expands exposure; the token remains the only
  authentication gate and must not be placed behind a public tunnel.
- A lost apply response is outcome-unknown from the browser's perspective;
  the UI must not invite an immediate duplicate request.
- Vendor CLI delegation and local file writes have different recovery models;
  result DTOs and Activity preserve that distinction.
- “No local flags” is local static evidence, never a safety or quality grade.

## Acceptance

- Browser shows the live cross-agent matrix and bounded discovery feed.
- Every advertised mutation shows the exact logical targets and fixed warning
  codes before the confirm control is available.
- Confirm consumes one plan and renders the actual result/provenance state.
- Empty plans cannot be applied; concurrent dialog mutations are disabled.
- Activity offers rollback only for an exact eligible audit ID, and the
  confirmation preserves kind, timestamp, scope, and ID. A lost response is an
  unknown outcome followed by Inventory/Activity refresh, never a claimed failure.
- Keyboard focus, dialog trapping, responsive tables, and bilingual labels
  remain usable without exposing private fields.

## Depends on

M2 (actions), M3 (daemon/core API shape), M4 (feed panel).
