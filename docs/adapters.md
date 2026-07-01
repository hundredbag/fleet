# Bring Your Own Agent — writing a fleet adapter

fleet manages capabilities across agents through **adapters**. Claude Code and
Codex are built in; you can add any other agent (Hermes, Antigravity, an
in-house tool) by implementing the `AgentAdapter` contract and pointing fleet at
your module — **no fork required**.

## The contract

Read-only support needs two methods (`src/core/adapter.ts`):

```ts
interface AgentAdapter {
  readonly id: string; // stable, unique (e.g. "hermes")
  readonly displayName: string; // human label
  readonly supportsWrite?: boolean; // set true once you implement the writer methods
  detect(): Promise<DetectedAgent>; // is it installed? where's its config?
  readInventory(): Promise<InstalledCapability[]>; // MCP servers / skills / rules it has
}
```

- `detect()` returns `{ id, displayName, present, configPaths, note? }`.
- `readInventory()` returns the agent's capabilities as `McpServerCapability` /
  `SkillCapability` / `RuleCapability` (see `src/core/types.ts`). Read only — do
  not touch disk to mutate.

To enable install/update/remove, also implement the writer methods
(`AgentWriter` / `SkillWriter` / `RuleWriter` in `src/core/adapter.ts`) and set
`supportsWrite = true`. Writers only **render** a change (produce the proposed
file content / directory op) — the engine in `core/writer.ts` owns all the
safety mechanics (backup, atomic write, validate, audit, rollback, hash-guard),
so you never write to disk yourself.

## Registering it

**Option A — config (no rebuild).** Point fleet at your compiled module in
`~/.fleet/config.json`:

```json
{ "adapterModules": ["/abs/path/to/my-agent-adapter.js"] }
```

Your module's **default export** must be an `AgentAdapter` instance _or_ a
(possibly async) factory returning one:

```js
export default new MyAgentAdapter();
// or: export default () => new MyAgentAdapter();
```

fleet loads these alongside the built-ins on every run. Bad modules are skipped
with a warning (never crash fleet); a plugin whose `id` shadows a built-in is
ignored (built-ins win). Note: a plugin runs **in-process** — it's arbitrary
code from your own config, same trust level as anything else you install.

**Option B — built-in.** Add it to `defaultAdapters()` in
`src/core/registry.ts` and open a PR.

## Testing your adapter

- `fleet inventory` should show your agent's column.
- `fleet install <x> --to <your-id>` (dry-run) should render a valid change;
  add `--commit` to apply and `fleet rollback` to undo.
- Malformed agent config must not throw — return what you can and surface a
  `note` from `detect()`.
