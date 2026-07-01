# M2 — write surface design

v0 was read-only. M2 makes fleet **mutate real agent configs** (install / remove
/ update / sync). Because a bug here corrupts the user's `~/.claude.json`,
`config.toml`, or `settings.json`, **safety is the primary design driver**.

## Principles

1. **Plan before write.** Every mutation is first produced as a `PlannedChange`
   (full proposed file content + a human diff) _without touching disk_. The CLI
   is **dry-run by default**; writing requires explicit `--commit`.
2. **Format knowledge in adapters; safety mechanics in the engine.** An adapter
   renders the _new file content_ from the current file + the op (it owns
   JSON/TOML quirks). The engine owns backup, atomic write, validation, audit,
   rollback (identical for every adapter).
3. **Never destroy.** Engine backs up the file before writing, writes
   atomically (tmp + `rename`), re-parses the result to confirm validity, and
   restores the backup if validation fails. Config files are edited, never
   deleted; only the `mcpServers` / `mcp_servers` section changes.
4. **Honest translation.** Cross-agent sync renders a normalized spec into each
   target's native form. When a target can't express something (e.g. Codex has
   no SSE; Claude has no env-var bearer token), the writer **emits a warning and
   degrades**, never silently corrupts.
5. **Auditable + reversible.** Each applied change appends to an audit log with
   its backup path; `rollback` restores from it.

## Normalized spec (extended for auth)

`McpServerSpec` (in `core/types.ts`) gains optional remote auth so translation
is lossless where targets allow it:

```ts
type McpServerSpec =
  | { transport: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
  | {
      transport: 'http' | 'sse' | 'ws';
      url: string;
      headers?: Record<string, string>;
      bearerTokenEnvVar?: string;
    }; // NEW: name of an env var holding a bearer token
```

Adapters READ into this shape; writers RENDER from it. `bearerTokenEnvVar`
comes from Codex's `bearer_token_env_var`; other agents express it via headers
where they support env expansion.

## Engine types (`core/writer.ts`)

```ts
interface RenderResult {
  // produced by an adapter, no I/O side effects
  file: string; // path to edit
  newContent: string; // full proposed file text
  before?: unknown;
  after?: unknown; // entry-level, for the diff view
  warnings?: string[];
}
interface PlannedChange extends RenderResult {
  agent: AgentId;
  op: 'install' | 'remove' | 'update';
  name: string;
  scope: Scope;
}
interface ApplyResult {
  change: PlannedChange;
  auditId: string;
  backup: string;
}
```

- `applyChanges(changes, { fleetHome }): Promise<ApplyResult[]>` — for each:
  backup → write tmp in same dir → `rename` over original → re-read+parse to
  validate → on failure restore backup & throw → append audit record.
- `rollback(auditId?, { fleetHome })` — restore the backup for an audit id (or
  the most recent) and append a rollback record.
- State dir `fleetHome` defaults to `~/.fleet/` (`backups/`, `audit.jsonl`);
  **injectable** for tests.

## AgentWriter interface (`core/adapter.ts`)

```ts
interface CapabilityRef {
  kind: 'mcp-server';
  name: string;
  scope: Scope;
}
interface AgentWriter {
  renderInstall(spec: McpServerSpec, ref: CapabilityRef): Promise<RenderResult>;
  renderRemove(ref: CapabilityRef): Promise<RenderResult>;
}
```

An adapter implements `AgentAdapter` (read) and, when `supportsWrite`, also
`AgentWriter`. `renderInstall` reads the current file, sets/updates the entry,
returns the full new content (preserving everything else verbatim).

## Translation capability matrix (writers warn on loss)

|            | stdio | http           | sse           | ws            | env-var bearer token                            |
| ---------- | ----- | -------------- | ------------- | ------------- | ----------------------------------------------- |
| **Claude** | ✓     | ✓              | ✓             | ✓             | ✗ → warn, omit auth                             |
| **Codex**  | ✓     | ✓ (streamable) | ✗ → warn/skip | ✗ → warn/skip | ✓ `bearer_token_env_var`                        |
| **Gemini** | ✓     | ✓ `httpUrl`    | ✓ `url`       | ✗ → warn/skip | ✓ via `headers: {Authorization: "Bearer $VAR"}` |

stdio is the clean common case (most MCP servers). Remote translation is
best-effort with explicit warnings.

## Scope (M2 staging)

- **Part 1:** engine + Claude writer, **user scope** only.
- **Part 2:** Codex + Gemini writers + translation/warnings.
- **Part 3:** core orchestration (`install`/`remove`/`sync "apply to all"` across
  adapters, self-protection checks) + CLI (`install`/`remove`/`sync`/`rollback`,
  dry-run default) + audit.

`local`/`project` scope writes come after user scope is proven.

## Self-protection

- Engine validates parse-ability after every write; corrupt → auto-restore.
- Refuse to write if the target file exists but doesn't parse (don't clobber a
  file we can't safely round-trip) — warn and skip.
- (M3) fleet will refuse to remove its own MCP entry once self-installed.
