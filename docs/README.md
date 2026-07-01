# fleet design docs

One design doc per milestone. Convention: `design-<id>-<slug>.md`.

## Lifecycle (why some are short)

Each doc moves through: **stub** (goal/scope/approach/risks/acceptance, written
up front so the whole plan is visible) → **finalized** (deep detail authored
_just before_ that milestone is built, with the real codebase + prior review
findings in context — this is where accuracy comes from) → **build log**
(outcome + review fixes, recorded in the doc and the wiki concept note).

We deliberately do NOT write deep detail for far-off milestones in advance:
M2 proved that designs shift materially under build+review, so speculative
detail goes stale and misleads. Stubs give the shape; JIT finalize gives truth.

## Roadmap

| Milestone                | Doc                                                        | Status                                        |
| ------------------------ | ---------------------------------------------------------- | --------------------------------------------- |
| v0 — read-only inventory | [design-v0-inventory.md](design-v0-inventory.md)           | ✅ built                                      |
| M2 — write surface       | [design-m2-write-surface.md](design-m2-write-surface.md)   | 🔵 Part 1 built; Part 2–3 pending (finalized) |
| M3 — MCP server face     | [design-m3-mcp-face.md](design-m3-mcp-face.md)             | ⬜ stub                                       |
| M4 — discovery feed      | [design-m4-discovery-feed.md](design-m4-discovery-feed.md) | ⬜ stub                                       |
| M5 — web dashboard       | [design-m5-web-dashboard.md](design-m5-web-dashboard.md)   | ⬜ stub                                       |
| M6 — trust/quality gate  | [design-m6-trust-gate.md](design-m6-trust-gate.md)         | ⬜ stub                                       |

Higher-level concept, decisions, and cross-milestone build log live in the wiki:
`llm-wiki/wiki/projects/agent-fleet-manager/agent-fleet-manager-concept.md`.
