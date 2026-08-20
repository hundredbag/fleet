# Bring Your Own Agent — writing a fleet adapter

fleet manages capabilities across agents through **adapters**. Claude Code and
Codex are built in; you can add any other agent (Hermes, Antigravity, an
in-house tool) by implementing the `AgentAdapter` contract and pointing fleet at
your module — **no fork required**.

## The contract

Read-only support needs explicit capability metadata plus two methods (`src/core/adapter.ts`):

```ts
interface AgentAdapterV1 extends AgentAdapter {
  readonly contractVersion: 1; // required for dynamically loaded adapters
  readonly id: string; // stable, unique (e.g. "hermes")
  readonly displayName: string; // human label
  readonly supportsWrite?: boolean; // set true once you implement the writer methods
  readonly capabilitySupport: Partial<
    Record<
      PrimitiveKind,
      {
        inventory: 'supported' | 'unsupported' | 'unverifiable';
        management: 'writable' | 'read-only' | 'delegated' | 'none';
      }
    >
  >;
  detect(): Promise<DetectedAgent>; // what local runtime/config evidence exists?
  readInventory(): Promise<InstalledCapability[]>; // MCP servers / skills / rules it has
}
```

`contractVersion: 1` is the machine compatibility boundary for a dynamically
loaded adapter. Fleet rejects a missing or unknown version before calling
`detect()`. It also validates `capabilitySupport`: unknown kinds/values and
extra surface fields are invalid; `unsupported` must pair with `none`,
`delegated` is plugin-only, and `writable` requires `supported`,
`supportsWrite: true`, and the concrete writer methods for that kind. Doctor
reports unsupported versions and malformed v1 contracts with distinct stable
codes. This structural validation does not sandbox the module—the import and
factory still execute trusted local code in-process.

`command` and `hook` remain unsupported inventory surfaces in v1 because the
core installed-capability union does not yet define authoritative shapes for
them. Declaring either as `supported` is a contract error rather than a promise
Fleet cannot validate.

Adapter ids must match `[A-Za-z0-9][A-Za-z0-9._-]{0,63}`. Display names must be
1–128 JavaScript string code units, already trimmed, and contain no ASCII
control character or DEL. `capabilitySupport` and each of its surface values
must be own-property records whose prototype is either `Object.prototype` or
`null`; arrays and class instances are not contract records. Surface records
may contain only `inventory` and `management`. Enum fields must be literal
strings; coercible objects are not part of the contract.

- `detect()` returns `{ id, displayName, present, configPaths, note?, runtimeStatus?,
configurationStatus? }`. `present` keeps its compatibility meaning: at least one
  known agent configuration/capability path exists. It does **not** by itself prove
  that the vendor executable is installed. Built-ins additionally report
  `runtimeStatus` (`available | not-found | unverifiable`) without executing the
  vendor CLI, and `configurationStatus` (`configured | not-configured | unavailable`).
  BYO adapters may omit the new fields; Fleet then uses `unverifiable` rather than
  inventing installation evidence.
  An explicit `configurationStatus: 'unavailable'` (or an invalid status value)
  excludes the adapter from `all` and rejects explicit mutation targeting until
  the local configuration is repaired. A present adapter whose authoritative
  inventory cannot be read is blocked the same way for every core and delegated
  mutation. Only an installed runtime (`runtimeStatus: 'available'`) with a
  genuinely absent, `not-configured` target may be initialized explicitly
  without a prior inventory.
- `readInventory()` returns the agent's capabilities as `McpServerCapability` /
  `SkillCapability` / `RuleCapability` (see `src/core/types.ts`). Read only — do
  not touch disk to mutate.
- `capabilitySupport` is the authority contract for every capability kind the
  adapter understands. Omitted metadata is treated as unverifiable and grants
  no write operation. Prefer declaring every current kind explicitly, using
  `{ inventory: 'unsupported', management: 'none' }` for unsupported surfaces.
  Use `inventory: 'unverifiable'` when the vendor surface exists but the adapter
  cannot currently prove its state. An unverifiable surface grants no operation,
  even if its declared management mode is `delegated`.

To enable install/update/remove, also implement the writer methods
(`AgentWriter` / `SkillWriter` / `RuleWriter` in `src/core/adapter.ts`) and set
`supportsWrite = true`, then declare that kind as
`{ inventory: 'supported', management: 'writable' }`. All three conditions are
required; retained writer methods never override `read-only`, `delegated`, or
`none` metadata. Writers only **render** a change (produce the proposed
file content / directory op) — the engine in `core/writer.ts` owns all the
safety mechanics (backup, prevalidated staging, no-clobber commit, audit, rollback, hash-guard),
so you never write to disk yourself.

The current writable contract is user scope only. Return project/local entries
from inventory with their real scope, but reject render requests for those
scopes until the adapter owns an exact scope-specific destination. Fleet does
not have an active project context and will not infer precedence between
same-name scoped entries; callers must select an unambiguous source scope.

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
without crashing fleet and `fleet doctor` reports their configured slot as a
load error; a plugin whose `id` shadows a built-in is ignored and reported
(built-ins win). Note: a plugin runs **in-process** — it's arbitrary
code from your own config, same trust level as anything else you install.

If a local `team-policy.json` is present, `allowAdapterModules` must be
explicitly `true` before any configured module is imported. With `false` or an
omitted field, configured BYO code is not loaded. A damaged policy also prevents
module loading rather than falling back to the user's `adapterModules` list.

The optional `agents` config field is the final active-adapter allowlist after
built-ins, valid plugin adapters, shadowing, and duplicate handling are resolved.
`null`/omission enables every registered adapter and `[]` enables none. Command
selectors operate only inside that active registry; they do not override it.

**Option B — built-in.** Add it to `defaultAdapters()` in
`src/core/registry.ts` and open a PR.

## Testing your adapter

- `fleet inventory` should show your agent's column.
- `fleet install <x> --to <your-id>` (dry-run) should render a valid change;
  add `--commit` to apply and `fleet rollback` to undo.
- `detect()` must classify missing paths separately from paths it cannot safely
  inspect. A symlink leaf, wrong path type, or unreadable known path is unavailable,
  not absent. Do not execute the agent runtime during detection.
- `readInventory()` must throw on malformed or unreadable authoritative state.
  Fleet isolates that failure and reports structured `inventoryStatus` /
  `setupStatus`; returning an empty list would incorrectly claim a healthy empty
  inventory. A successful empty list is reserved for readable state with zero
  capabilities.
