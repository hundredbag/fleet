# fleet design docs

One design doc per milestone. Convention: `design-<id>-<slug>.md`.

## Lifecycle (why some are short)

The linked files are historical planning snapshots. Some retain `STUB` headings
or planned behavior that differs from the shipped implementation. The table
below reports implementation status; [README.md](../README.md) and
[USAGE.md](USAGE.md) define current product behavior.

We deliberately do NOT write deep detail for far-off milestones in advance:
M2 proved that designs shift materially under build+review, so speculative
detail goes stale and misleads. Stubs give the shape; JIT finalize gives truth.

## Roadmap

| Milestone                | Doc                                                                    | Current implementation status                                                                                                           |
| ------------------------ | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| v0 — read-only inventory | [design-v0-inventory.md](design-v0-inventory.md)                       | Built; extended with permission, plugin, and subagent inventory                                                                         |
| M2 — write surface       | [design-m2-write-surface.md](design-m2-write-surface.md)               | Built for user-scope MCP/skill/Fleet-rule changes on active built-ins; general project/local writes are not supported                   |
| M3 — MCP server face     | [design-m3-mcp-face.md](design-m3-mcp-face.md)                         | Built                                                                                                                                   |
| M4 — discovery feed      | [design-m4-discovery-feed.md](design-m4-discovery-feed.md)             | Built with registry, skill, local-marketplace, and optional Hub/Pulse sources                                                           |
| M5 — web dashboard       | [design-m5-web-dashboard.md](design-m5-web-dashboard.md)               | Built; capability actions use preview → explicit confirm → single-use apply, and Activity exposes only targeted eligible core rollback  |
| M6 — trust/quality gate  | [design-m6-trust-gate.md](design-m6-trust-gate.md)                     | Built for deterministic local package/source and skill-tree evidence with audit/lock snapshots; no signature, SBOM, or advisory scanner |
| M7 — standards/policy    | [design-m7-adapters-team-policy.md](design-m7-adapters-team-policy.md) | Built with adapter contract v1 and a strict local team-policy v1 ceiling; no remote policy service, account, or RBAC                    |
| Vendor plugins           | [design-plugins.md](design-plugins.md)                                 | Inventory and delegated install/remove built; equivalence and post-apply verification remain incomplete                                 |
