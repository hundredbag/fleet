# M6 — trust / quality gate (STUB)

> Stub. Finalize just before building.

## Goal

Check a capability's security/quality **before install** — important precisely
because the AI can auto-install (Snyk: ~37% of agent skills had ≥1 flaw).

## Scope

- v1 = **wrap an existing signal** (registry metadata, Snyk-style advisories,
  signing/provenance). Do NOT build our own scanner.
- Gate consulted before the M2 engine applies an install; warn or block per
  policy.

## Approach (sketch)

- `TrustSource` interface → `TrustVerdict { level, reasons, sourceUrl }`.
- Orchestrator consults sources before `applyChanges`; policy decides warn/block.

## Key risks / open questions

- Avoid a false sense of security (a "pass" isn't a guarantee) — message carefully.
- Signal source availability / offline → fail-open or fail-closed?
- Enforce in orchestrator (not the low-level engine) so dry-run shows the verdict.
- warn-vs-block default (lean warn + explicit override for block).

## Acceptance

- Installing a flagged server surfaces the verdict and warns/blocks per policy;
  verdict shown in dry-run plans and the feed.

## Depends on

M2 (install path). Tie-in: M4 (registry data), M3/M5 (surface the verdict).
