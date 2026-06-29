# Skills & Rules primitive + semantic conflict analysis — design

> Reordered ahead of the discovery feed (user: skills/rules are high-usage).
> Active agents this milestone: **Claude Code + Codex** (Gemini excluded;
> Antigravity / Hermes adapters land later via the same interfaces).

## Reality found on the machine (2026-06-29)

| | Skills | Behavioral instructions ("rules") | Permission policy (separate) |
|---|---|---|---|
| **Claude** | `~/.claude/skills/<name>/SKILL.md` (empty now) | `~/.claude/CLAUDE.md` (markdown) | settings.json allow/deny lists |
| **Codex** | `~/.codex/skills/<name>/` (path in flux — newer docs: `.agents/skills`; `.system/`=builtin) | **`~/.codex/AGENTS.md`** (global) + `<repo>/AGENTS.md` — markdown, ~32 KiB cap | `~/.codex/rules/*.rules` (`prefix_rule(...)`, "Smart Approvals", **Codex-managed**) |
| **Hermes** | `skills/` + `optional-skills/`, flat or **grouped** (`apple/apple-notes/…` + `DESCRIPTION.md`) | `AGENTS.md` (markdown) | — |

SKILL.md carries YAML frontmatter: `name`, `description`, `version`, `platforms`, `metadata`.

**Key finding (corrected after research) — "rules" splits into TWO concepts; Codex has BOTH:**
1. **Behavioral instructions** (always-on prose): Claude=`CLAUDE.md`, Codex=`AGENTS.md`, Hermes=`AGENTS.md`. **AGENTS.md is the de-facto standard (Linux Foundation, donated 2025-12), GA in Codex.** → **fleet's "rules"/instructions primitive.** Since they're all markdown (Codex/Hermes literally share AGENTS.md; Claude differs only by filename), cross-agent sync is a *filename/location + content-portability* problem, **not** a format-translation one. (Still: no auto semantic translation — content can be agent-specific.)
2. **Permission policy** (Codex `~/.codex/rules/*.rules`, `prefix_rule(...)`): command-execution allowlist, written/rewritten by Codex's own "Smart Approvals". A different concern → **out of scope** (future "permissions" primitive); read-only inventory at most, never synced/treated as behavioral.
   - Avoid Codex `model_instructions_file` (system-prompt override, discouraged) and `instructions` (reserved/no-op).

## Scope

- **Skills** (gated): inventory + cross-agent install/sync/remove (copy SKILL.md dirs).
- **Instructions / "rules"** (always-on): unified inventory + management + portable-only sync + **semantic conflict analysis**. No format translation (decided earlier).
- **Permissions** (Codex `.rules`): excluded; noted for later.

## Capability model extension

The `kind`-discriminated union (built in v0 for exactly this) gains:
- `SkillCapability` — `{ kind:'skill', name, path(dir), meta(frontmatter), agent, scope, source }`.
- `InstructionCapability` — `{ kind:'instruction', name, agent, scope, alwaysOn:true, text|section, source }`.
Each capability is tagged **gated vs always-on** (drives conflict analysis): mcp+skill = gated, instruction = always-on.

## Engine extension (capabilities are now files/dirs, not just config entries)

Current engine writes ONE text file atomically (tmp→fsync→rename, backup, validate, rollback). Add:
- **Directory install**: stage the skill dir to a temp dir, back up any existing dir, atomically swap (rename), rollback = restore/remove. Same audit/lock/hash-guard discipline.
- Instruction files are single text files → the existing file path mostly applies (append/merge a marked block rather than overwrite — see Part B).

## Part A — Skills

- **Inventory**: list skills per agent; parse SKILL.md frontmatter (name/description); handle flat AND grouped layouts (a skill = a dir containing SKILL.md; a group = a dir of skills, optional DESCRIPTION.md). Codex's user-skills dir is in flux (`~/.codex/skills` vs newer `.agents/skills`) → the adapter should detect which exists rather than hardcode.
- **Install / sync / remove**: copy the skill dir into each agent's skills location. Cross-agent sync = the same SKILL.md dir → each agent (SKILL.md is portable; no translation).
- **Conflict**: skills are gated → low risk; note name/intent overlap softly.

## Part B — Instructions ("rules")

Targets (behavioral, markdown): Claude `~/.claude/CLAUDE.md`; Codex `~/.codex/AGENTS.md` (global) + `<repo>/AGENTS.md`; Hermes `AGENTS.md`. (Codex `.rules` permissions are NOT touched.)
- **Inventory**: read each agent's instruction file; present as named blocks (split by top-level heading; whole-file when unstructured).
- **Management**: view/edit from one place; each kept in its native file/location.
- **Sync**: never overwrite the whole file (humans edit these too) — append/merge inside a **delimited fleet-managed block** (e.g. `<!-- fleet:start -->…<!-- fleet:end -->`). A block the user marks **portable** → write that managed block into each target's native instruction file (same markdown; only filename/location differ). Agent-specific blocks stay put + flagged. **No semantic translation.** Mind Codex's ~32 KiB combined instruction cap.
- This is where semantic conflict lives → feeds Part C.

## Part C — Semantic conflict / impact analysis

- Classify each capability **always-on (instructions)** vs **gated (skills/mcp)**.
- Flag **always-on instruction pairs with opposing intent** (best-with-available-metadata: heuristic/keyword now; LLM-judged + hub-distributed later).
- Gated overlap = soft note + suggested resolution (scope / sub-agent / precedence / convert-to-gated).
- Surface in the install dry-run plan and a `fleet conflicts` view.

## Honest scoping / risks

- Rules sync = append/merge a **marked block**, not whole-file overwrite (don't clobber agent-specific content).
- Grouped skill structures handled; very deep nesting may be limited (note if so).
- Semantic-opposition detection is shallow without LLM/hub — v1 flags *candidates*, doesn't claim certainty.
- Directory atomic-swap + rollback is the riskiest new engine bit → heaviest test focus + dedicated review.

## Parts & review cadence

- **Part A**: model + engine (dir install) + Skills adapter (Claude+Codex) + tests → review.
- **Part B**: Instructions adapter + portable block sync + tests → review.
- **Part C**: conflict/impact analysis + tests → review.
