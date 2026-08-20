# M6 — local trust evidence gate

## Goal

Check a capability's security/quality **before install** — important precisely
because the AI can auto-install (Snyk: ~37% of agent skills had ≥1 flaw).

## Scope

- v1 uses deterministic local facts for mutation gating and separately labels
  registry metadata assessments. It is not a malware scanner or quality score.
- Gate consulted before the M2 engine applies an install; warn or block per
  policy.

## Implemented model

- `GateVerdict { level, reasons, reasonCodes }` is produced during planning.
- Stable codes cover package pinning/source ambiguity, runner-source environment
  redirection, and observable skill-tree facts such as scripts, executable bits,
  symlinks, oversized files, and hidden Unicode.
- `warn` annotates the preview; `block` converts changes to protected skips.
  Commit rechecks the current policy under the shared mutation lock.
- The full local explanation remains local. A stable-code snapshot is appended
  to the audit record, while `fleet.lock` stores the install-time verdict for
  current provenance/drift consumers.
- MCP lock status and Web Activity expose only allowlisted level/reason codes.
  Historical audit evidence is independent of a later lock update/removal.
- Feed trust uses the separate `caution | unknown | no-flags` vocabulary and
  stable metadata reason codes. “No flags” never means safe.

## Key risks / open questions

- Avoid a false sense of security (a "pass" isn't a guarantee) — message carefully.
- External advisory/signature sources remain future work; their unavailable
  state must never be presented as a local pass.
- Enforce in orchestrator (not the low-level engine) so dry-run shows the verdict.
- warn-vs-block default (lean warn + explicit override for block).

Malformed trust evidence in lock/audit state is treated as malformed provenance;
mutation or rollback paths that require that state fail closed.

## Depends on

M2 (install path). Tie-in: M4 (registry data), M3/M5 (surface the verdict).
