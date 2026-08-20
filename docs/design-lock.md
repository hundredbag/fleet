# fleet.lock — provenance + pinning (P1-6)

Market context (2026-07 research): no manager ships a correct lockfile — the
Vercel skills CLI's lock has an open update-ignores-lock bug, `gh skill --pin`
pins but only for Copilot, Microsoft APM has `apm.lock.yaml` but no rollback
and only knows what APM installed. Both review tracks (Claude research + codex
code analysis) independently ranked provenance pinning #2 for fleet.

## What it is

`~/.fleet/fleet.lock` — a JSON record of every capability FLEET installed:
where it came from (origin), what bytes landed (contentHash), when, and the
audit id that made it. One entry per `kind:name@agent`.

```json
{
  "version": 1,
  "entries": {
    "skill:tdd@claude-code": {
      "kind": "skill",
      "name": "tdd",
      "agent": "claude-code",
      "scope": "user",
      "origin": { "type": "dir", "path": "/home/u/src/tdd" },
      "contentHash": "<hashDir manifest v2>",
      "installedAt": "2026-07-15T…",
      "auditId": "…",
      "op": "install"
    },
    "mcp-server:everything@codex": {
      "origin": { "type": "npm", "id": "@modelcontextprotocol/server-everything", "version": "0.6.2" },
      "contentHash": "<sha256 of the canonical installed spec>",
      "…": "…"
    },
    "plugin:ponytail@claude-code": {
      "origin": { "type": "marketplace", "selector": "ponytail@ponytail" },
      "…": "(no contentHash — vendor-owned bytes)"
    }
  }
}
```

## Origins

| type           | set by                                                                                         | fields       |
| -------------- | ---------------------------------------------------------------------------------------------- | ------------ |
| `npm` / `pypi` | web install (explicit coordinate) or CLI (extractCoordinate on the spec, high confidence only) | id, version? |
| `dir`          | skill install (source dir)                                                                     | path         |
| `marketplace`  | delegated plugin install                                                                       | selector     |
| `manual`       | anything else (hand-authored spec, rule text)                                                  | —            |

Origin derivation stays in the FACES (web knows its coordinate; CLI derives
via feed/coords) — core never imports feed.

## Write path

- `execute()` (the single commit entrypoint): after a successful apply, upsert
  an entry per applied change; `remove` ops delete the entry. A lock that is
  already malformed or unavailable blocks the mutation before any target is
  changed, so existing provenance cannot be silently discarded. A lock write
  failure discovered only after the target changed degrades to a warning on
  the result (`lockWarning`) — the install already happened and must not be
  reported as absent or reverted implicitly. Public MCP/Web DTOs project this
  as the fixed `PROVENANCE_WARNING` code; CLI prints a fixed provenance warning.
- `runDelegated()` (vendor CLI path): applied installs upsert a plugin entry;
  removes delete it. The same preflight blocks the vendor when existing lock
  provenance is damaged.
- The lock file itself is written atomically (tmp+rename) under fleet's home.
- Rollback remains available as a target-recovery operation when lock
  provenance is damaged. If target recovery completes but lock-entry cleanup
  fails, the result remains restored/removed and carries the same fixed
  `PROVENANCE_WARNING` instead of hiding incomplete metadata cleanup.

## Read path (v1)

- `fleet lock [--json]` — list entries.
- MCP `lock_status` tool.
- Consumers land in the NEXT parts: trust gate (7) records verdicts here,
  drift detection (8) diffs live state against `contentHash`, update diffing
  compares upstream against `origin`.

## Deliberately not in v1

Git origins with commit pinning (needs clone flow), lock-driven reinstall
("fleet sync --from-lock"), signature verification, per-project lock files.
