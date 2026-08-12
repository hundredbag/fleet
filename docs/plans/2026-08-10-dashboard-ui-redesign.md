# Fleet Dashboard UI Redesign Implementation Plan

> **Status: Implemented (2026-08-12).** Tasks 0–11 were completed and shipped to
> `main` through `c516f38`. Final verification observed 316/316 tests passing,
> with lint, format, typecheck, build, specification review, and final
> quality/accessibility/security review all passing. This file is retained as
> the implementation and acceptance record; it is no longer an active plan.

> **For Hermes:** Use subagent-driven-development skill to implement this plan task-by-task.

**Goal:** Replace the current long, single-page dashboard with one coherent Fleet control surface: Capability Map as the overview, a dense Operations inventory, and a Discovery workbench, using the approved Operations Console dark theme and Capability Map light theme.

**Architecture:** Keep the current dependency-free, CSP-compatible, self-contained HTML response and the existing server-enforced `plan → apply` mutation boundary. Split the 57 kB `src/web/ui.ts` source into compile-time TypeScript string modules, add a redacted overview read model for drift/activity, and render three client-side views from the existing APIs. Dark and light modes share identical information architecture and components; only design tokens change.

**Tech Stack:** Node.js 22, TypeScript ESM, built-in `node:http`, vanilla browser JavaScript, inline CSS/JS, `node:test`, existing Fleet core APIs. No React/Vue, CDN, external font, database, or second frontend build pipeline.

---

## 0. Review resolution (Codex `gpt-5.6-sol`, reasoning `xhigh`)

The first draft received **REQUEST CHANGES**. This revision resolves all four blocking findings before implementation:

1. Capability state is decomposed into availability, management, coverage, and allowed operations; “aligned” is forbidden unless server-side equality is actually established.
2. Every browser endpoint returns an explicit public DTO built by an allowlist mapper; raw exceptions, audit paths, hashes, env, headers, and core records never cross the API boundary.
3. UI source splitting and v1/v2 removal happen atomically in one task, avoiding an intermediate dual-UI maintenance state.
4. A new Task 0 makes mutation/browser verification hermetic before feature work: explicit temporary `fleetHome`, temporary adapter paths, ephemeral port, and repository-external screenshots.

Additional review changes incorporated below include hash-preserving token stripping tests, partial-endpoint-failure states, truthful “No known findings / Attention / Unavailable” labels, delegated plugin activity, explicit API return types, and browser verification at 360/768/1265 px.

After the blocking feedback was incorporated, a final Codex `gpt-5.6-sol` / `xhigh` gate review returned **APPROVE** with no remaining blockers.

---

## 1. Product decisions and non-negotiable contracts

### Accepted design decisions

- **Dark mode:** visual tone from `sketches/001-operations-console/`.
- **Light mode:** visual tone from `sketches/002-fleet-map/`.
- **Discovery:** interaction/layout ideas from `sketches/003-discovery-workbench/`, recolored into the same teal/neutral system. Its beige/orange visual identity is explicitly rejected.
- **Default landing view:** Overview / Capability Map.
- **Secondary views:** Inventory, Discover, Drift, Activity.
- **Desktop navigation:** persistent left rail.
- **Narrow navigation:** compact top/bottom navigation; no permanently occupying 224 px rail.
- **Theme parity:** dark and light modes expose the same content, actions, labels, focus order, and states.

### Safety and privacy contracts

1. No fake health, drift, update, or activity values in production UI.
2. All browser data comes from redacted API view models; never send raw inventory, env/header values, audit backup paths, or full file contents.
3. Preserve header-only bearer token, Host/Origin checks, request body limit, CSP, and token removal from URL.
4. All install/sync/remove/update operations remain `POST /api/plan` followed by single-use `POST /api/apply`.
5. Rollback must show a selected redacted audit item and require explicit confirmation; never retain the current unlabeled one-click rollback button.
6. External URLs become links only through the existing HTTPS allowlist rule.
7. No inline user-derived HTML: continue creating dynamic content with `textContent`.
8. Empty, loading, partial failure, and unavailable states must be visually distinct; `0` must not be used for “not loaded.”
9. “Healthy” is not inferred from absence of evidence. Summary labels are limited to `No known findings`, `Attention`, and `Unavailable`.
10. Public API DTOs are constructed field-by-field. Object spread from `Inventory`, `AuditRecord`, drift findings, delegated records, or caught errors into HTTP responses is forbidden.

### Capability state contract

The UI must not collapse unrelated states into a green/red dot. Each capability/agent cell uses four independent dimensions:

```text
availability: installed | missing | disabled | unavailable | unsupported | unverifiable
management:   writable | read-only | delegated | none
coverage:     all-present | gap | agent-only | unverifiable
operations:   explicit server-computed allowlist per kind/agent
```

- `unavailable` means the agent inventory could not be read; it is never rendered as `missing`.
- `unsupported` means the adapter does not implement that capability surface; it is never offered an install action.
- `read-only` covers permission/subagent inventory.
- `delegated` covers plugin actions performed by vendor CLIs.
- `aligned` may appear only if the server returns a secret-safe equality class proving canonical content equality. Mere presence on all agents is labeled `all present`, not `aligned`.

### Scope exclusions

- No rewrite of core adapter/orchestrator/feed algorithms; one additive, optional adapter capability-support metadata contract is allowed so BYO adapters can report support truthfully.
- No new capability kinds.
- No mobile-native app.
- No hosted authentication or multi-user RBAC.
- No package installation from Discovery where the backend does not support it; skill/plugin cards must honestly show repository or CLI guidance.
- No production use of mock data from the sketches.

### Definition of done

- The default dashboard visually follows Capability Map in light mode and Operations Console in dark mode.
- Overview, Inventory, Discover, Drift, and Activity are keyboard reachable and URL-restorable via hash navigation.
- Capability Map truthfully reflects every detected agent and installed capability.
- Capability Map distinguishes instances from unique capability keys and never conflates unavailable/unsupported/missing.
- Inventory supports search and kind/status filters without refetching.
- Discovery no longer creates one unbounded page: categorized sections have initial limits and explicit “show more.”
- Every mutation previews exact logical targets (`agent`, `kind`, `name`, `scope`) and a sanitized operation summary before apply; raw filesystem paths, secret-bearing specs, headers/env, and arbitrary vendor command output are not browser data.
- Dark/light mode, Korean/English, empty/error/loading states, 360 px/768 px/1265 px layouts are verified.
- Existing security and mutation tests remain green; new endpoint/view-model tests pass.
- `npm run ci` passes and the built dashboard is exercised in a real browser.

---

## 2. Planned file structure

```text
src/web/
├── api.ts                    # add apiOverview/apiActivity; preserve existing APIs
├── actions.ts                # accept explicit auditId for confirmed rollback
├── server.ts                 # new read routes; serve one dashboard (no v1/v2 switch)
├── types.ts                  # authoritative public API DTOs + enums
├── ui.ts                     # small renderPage() composition entry
└── ui/
    ├── styles.ts             # shared tokens + shell/components + responsive CSS
    ├── template.ts           # static semantic HTML shell
    └── client.ts             # embedded browser application string

tests/
├── web.test.ts               # HTTP/security/mutation API integration
├── web-ui.test.ts            # render contract and browser-data shaping tests
├── helpers/
│   └── web-fixture-server.ts # isolated browser fixture launcher
└── fixtures/
    └── web-dashboard.ts      # deterministic multi-agent inventory/feed fixture

docs/
├── USAGE.md                  # current navigation/actions/screens
└── plans/2026-08-10-dashboard-ui-redesign.md
```

The three `sketches/` directories remain disposable design references and must not be imported by production code or included in the npm package.

---

## Task 0: Make web and mutation verification hermetic

**Objective:** Remove accidental dependencies on the developer’s home directory and provide an isolated server for real-browser acceptance before any UI implementation begins.

**Files:**

- Create: `tests/helpers/web-fixture-server.ts`
- Modify: `tests/web.test.ts`
- Modify: `package.json`

**Step 1: Fix existing tests that fall back to real Fleet state**

Every `ActionService` and `createFleetServer` used by tests must receive an explicit temporary `fleetHome`. In particular, the delegated plugin test currently constructs `ActionService([], undefined, runner)` and can write `~/.fleet/delegated.jsonl`; change it to a `mkdtempSync()` home and remove it in `finally`.

Audit all web tests for these forbidden defaults:

```text
fleetHome: undefined
real ~/.fleet
real ~/.claude*
real ~/.codex*
fixed TCP port
```

Use temporary adapter config paths and `listen(0, '127.0.0.1')` for HTTP integration tests.

**Step 2: Add an isolated browser fixture launcher**

`tests/helpers/web-fixture-server.ts` must:

- create one temporary root containing `fleetHome`, Claude, Codex, skill, rule, and plugin fixture paths;
- instantiate real adapters against those paths;
- inject deterministic feed sources;
- bind to loopback port `0`;
- print one tokenized URL to stdout for browser tooling;
- handle SIGINT/SIGTERM by closing the server and deleting the temporary root;
- never import or read the user’s default adapters/config.

Add a non-CI convenience script:

```json
"dev:web-fixture": "tsx tests/helpers/web-fixture-server.ts"
```

Do not add a browser dependency or second build pipeline in this task.

**Step 3: Add security regression coverage before refactoring**

Pin the existing behavior with tests for:

- CSP and `cache-control: no-store` on HTML/JSON;
- Host and Origin checks;
- header-only token for POST;
- request body >64 KiB returns `413`;
- query token is stripped while an allowlisted view hash such as `#inventory` is preserved;
- malformed/unknown paths fail closed.

Because token stripping executes in the browser, the hash-preservation assertion belongs in the fixture-browser acceptance checklist until a DOM runner exists; the server-side HTML contract must at least contain the allowlisted-hash preservation function and no raw token interpolation.

**Step 4: Run the baseline**

```bash
node --import tsx --test tests/web.test.ts
npm run ci
```

Expected: all tests pass in a normal writable environment; no writes occur under the real home directory. Read-only sandboxes that prohibit `/tmp` or loopback may still be unable to execute integration tests, but that limitation must not be confused with a product failure.

**Step 5: Commit**

```bash
git add tests/helpers/web-fixture-server.ts tests/web.test.ts package.json
git commit -m "test(web): isolate dashboard and mutation verification"
```

---

## Task 1: Lock the dashboard contract with deterministic fixtures

**Objective:** Add a representative two-agent fixture and failing tests that describe the new HTML shell and truthful browser data requirements before changing production UI.

**Files:**

- Create: `tests/fixtures/web-dashboard.ts`
- Create: `tests/web-ui.test.ts`
- Modify: `tests/web.test.ts`

**Step 1: Create a multi-agent fixture**

Export deterministic fake adapters and feed sources containing:

- Claude Code and Codex, both present.
- `playwright` MCP installed on both agents.
- `github` MCP installed only on Claude Code.
- one equal-content skill on both agents (labeled `all present` unless server equality is implemented), one missing skill, one rule, and one plugin.
- one concrete MCP update, one trusted recommendation, one caution recommendation.
- no secret-bearing values in fixture descriptions.

Use the real `AgentAdapter` and `FeedSource` types. Do not create a UI-only payload that bypasses `apiInventory()` or `apiFeed()`.

**Step 2: Write the failing render contract test**

In `tests/web-ui.test.ts`, call `renderPage()` and assert:

```ts
assert.match(html, /data-view="overview"/);
assert.match(html, /data-view="inventory"/);
assert.match(html, /data-view="discover"/);
assert.match(html, /data-view="drift"/);
assert.match(html, /data-view="activity"/);
assert.match(html, /id="theme"/);
assert.match(html, /id="global-search"/);
assert.doesNotMatch(html, /\?v=1|\?v=2|class="vsw"/);
assert.doesNotMatch(html, /https:\/\/fonts\.|cdn\.|<script src=/);
```

Also assert semantic landmarks (`nav`, `main`, named buttons) and that no mock labels such as `12 sec ago`, `18 managed items`, or `8.8 / 10` are embedded in production HTML.

**Step 3: Write failing HTTP tests**

Add tests for authenticated `GET /api/overview` and `GET /api/activity`; verify unauthenticated requests remain `401`. Assert every public response omits `file`, `backup`, `wroteHash`, `contentHash`, `raw`, `env`, `headers`, stack traces, and arbitrary caught-error text.

**Step 4: Run tests and verify RED**

Run:

```bash
node --import tsx --test tests/web-ui.test.ts tests/web.test.ts
```

Expected: failures for missing new views/routes and still-present v1/v2 switch.

**Step 5: Commit**

```bash
git add tests/fixtures/web-dashboard.ts tests/web-ui.test.ts tests/web.test.ts
git commit -m "test(web): define redesigned dashboard contract"
```

---

## Task 2: Split the UI source and remove v1/v2 atomically

**Objective:** Reduce `src/web/ui.ts` from a 57 kB monolith into reviewable compile-time modules and remove dual-variant maintenance in the same change while still returning one CSP-compatible HTML document.

**Files:**

- Create: `src/web/ui/styles.ts`
- Create: `src/web/ui/template.ts`
- Create: `src/web/ui/client.ts`
- Modify: `src/web/ui.ts`
- Modify: `src/web/server.ts`

**Step 1: Add composition modules**

Use exported strings/functions, not runtime file reads:

```ts
// src/web/ui.ts
import { DASHBOARD_CSS } from './ui/styles.js';
import { renderShell } from './ui/template.js';
import { DASHBOARD_CLIENT } from './ui/client.js';

export function renderPage(): string {
  return renderShell({ css: DASHBOARD_CSS, client: DASHBOARD_CLIENT });
}
```

`renderShell()` must retain:

```html
<meta name="referrer" content="no-referrer" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
```

Do not add external stylesheets, scripts, images, or fonts.

**Step 2: Remove variant routing in the same change**

- `renderPage()` takes no variant.
- `server.ts` no longer selects `v1`/`v2` from a query parameter.
- `?v=1` and `?v=2` are ignored and serve the one current dashboard.
- Remove `.vsw` links and token-carrying version-switch code.
- Preserve query-token removal and the current allowlisted navigation hash.

**Step 3: Preserve current security helpers**

Move, without semantic changes:

- safe storage wrappers.
- token capture and URL stripping, explicitly preserving `#overview|#inventory|#discover|#drift|#activity`.
- `get()` and `postJson()` authorization behavior.
- `safeHttpUrl()` HTTPS-only rule.
- text-node creation through `textContent`.

**Step 4: Run focused tests**

```bash
node --import tsx --test tests/web-ui.test.ts tests/web.test.ts
npm run typecheck
```

Expected: pre-existing dashboard serving/security tests pass; variant-switch assertions turn green; remaining visual contract stays red until subsequent tasks.

**Step 5: Commit**

```bash
git add src/web/ui.ts src/web/ui/ src/web/server.ts
git commit -m "refactor(web): unify and split dashboard source"
```

---

## Task 3: Add truthful public API contracts and read models

**Objective:** Supply real agent availability, capability coverage, drift, attention, and recent activity required by the new dashboard without exposing raw core records.

**Files:**

- Modify: `src/core/adapter.ts`
- Modify: `src/core/types.ts`
- Modify: `src/core/inventory.ts`
- Modify: `src/core/skill-updates.ts`
- Modify: `src/adapters/claude-code.ts`
- Modify: `src/adapters/codex.ts`
- Modify: `src/adapters/gemini.ts`
- Create: `src/web/types.ts`
- Create: `src/web/public-mappers.ts`
- Create: `src/web/operations.ts`
- Modify: `src/web/api.ts`
- Modify: `src/web/actions.ts`
- Modify: `src/web/server.ts`
- Modify: `tests/web.test.ts`
- Modify: `tests/adapters.test.ts`
- Modify: `tests/lock.test.ts`
- Create: `tests/adapter-contract.test.ts`
- Test: `tests/web-ui.test.ts`

**Step 1: Add optional adapter support metadata with safe unknown fallback**

Extend `AgentAdapter` additively; do not infer support from an absent inventory item:

```ts
export interface CapabilitySurface {
  inventory: 'supported' | 'unsupported';
  management: 'writable' | 'read-only' | 'delegated' | 'none';
}

export interface AgentAdapter {
  // existing fields...
  capabilitySupport?: Partial<Record<PrimitiveKind, CapabilitySurface>>;
}
```

- Built-in Claude Code, Codex, and Gemini adapters declare every current `PrimitiveKind`, including explicit unsupported placeholders for `command`/`hook`.
- BYO adapters that omit metadata produce `unverifiable` support/coverage, not `unsupported` or `missing`.
- Add adapter-contract tests proving built-ins are complete and unknown BYO metadata fails closed.
- This metadata states the adapter contract only; it does not itself grant an operation.

Also replace free-form-note inference with a structured internal read status without breaking the `detect(): DetectedAgent` adapter contract. Add in `src/core/types.ts`:

```ts
export interface InventoryAgent extends DetectedAgent {
  inventoryStatus: 'ok' | 'not-present' | 'detect-failed' | 'read-failed';
}

export interface Inventory {
  agents: InventoryAgent[];
  items: InstalledCapability[];
}
```

`buildInventory()` enriches every detected result with this field. Existing human-facing `note` may remain for CLI diagnostics, but web policy and `skillUpdatesFromLock()` branch only on `inventoryStatus`; they never parse `note`. Update inventory and skill-update tests for detect failure, read failure, absent agent, and successful empty inventory.

**Step 2: Define authoritative public DTOs**

Create `src/web/types.ts`; every exported API function in `src/web/api.ts` must declare one of these explicit return types. UI code may describe the same JSON shape in comments/JSDoc, but there is no second authoritative `ui/types.ts` contract.

```ts
export type Availability =
  'installed' | 'missing' | 'disabled' | 'unavailable' | 'unsupported' | 'unverifiable';
export type Management = 'writable' | 'read-only' | 'delegated' | 'none';
export type Coverage = 'all-present' | 'gap' | 'agent-only' | 'unverifiable';
export type Operation = 'install' | 'sync' | 'remove' | 'update';

export interface PublicCapabilityInstance {
  agent: string;
  scope?: string;
  availability: Availability;
  management: Management;
  operations: Operation[];
  enabled?: boolean;
}

export interface PublicCapability {
  key: string;
  kind: string;
  name: string;
  description?: string;
  tokensEst?: number;
  sourceLabel?: 'agent-config' | 'local-skill' | 'managed-rule' | 'vendor-plugin';
  sourceUrl?: string; // HTTPS-only after safeHttpUrl validation
  coordinate?: { ecosystem: string; identifier: string; version?: string };
  coverage: Coverage;
  instances: PublicCapabilityInstance[];
}

export interface InventoryResponse {
  agents: Array<{
    id: string;
    displayName: string;
    present: boolean;
    inventoryAvailable: boolean;
  }>;
  capabilities: PublicCapability[];
  capabilityInstances: number;
  uniqueCapabilityKeys: number;
}

export interface FeedResponse {
  updates: Array<{
    kind: string;
    name: string;
    agent: string;
    from?: string;
    to?: string;
    operation: Operation | null;
  }>;
  skillUpdates: Array<{ name: string; agent: string; state: string; operation: Operation | null }>;
  recommendations: Array<{
    kind: string;
    name: string;
    category?: string;
    identifier?: string;
    ecosystem?: string;
    version?: string;
    description?: string;
    source: string;
    reasons: string[];
    trust: string;
    url?: string;
    operation: Operation | null;
  }>;
  failures: Array<{ source: string }>;
  fromCache: boolean;
}

export interface ConflictsResponse {
  conflicts: Array<{ kind: string; name: string; agents: string[]; reasonCode: string }>;
}

export interface PublicPlanResponse {
  planId: string;
  expiresAt: number;
  changes: Array<{ agent: string; kind: string; name: string; scope?: string; op: string }>;
  warningCodes: string[];
  operationSummary: string;
}

export interface PublicApplyResponse {
  auditId?: string;
  applied: number;
  skipped: number;
  warningCodes: string[];
}

export interface PublicRollbackResponse {
  action: 'restored' | 'removed' | 'skipped';
  reasonCode?: string;
}

export interface PublicErrorResponse {
  code: string;
  messageKey: string;
}

export interface OverviewResponse {
  presentAgents: number;
  unavailableAgents: number;
  capabilityInstances: number;
  uniqueCapabilityKeys: number;
  agents: Array<{
    id: string;
    displayName: string;
    present: boolean;
    inventoryAvailable: boolean;
    capabilityInstances: number;
  }>;
  drift: {
    checked: number;
    findings: Array<{
      kind: string;
      name: string;
      agent: string;
      state: 'modified' | 'missing' | 'unverifiable';
      reasonCode?: string;
    }>;
    unmanagedCount: number;
    unmanaged: Array<{
      kind: string;
      name: string;
      agent: string;
      state: 'unmanaged';
      reasonCode: string;
    }>;
  };
  generatedAt: number;
}

export interface ActivityItem {
  id: string;
  ts: number;
  source: 'core-audit' | 'delegated-plugin';
  op: string;
  agent: string;
  name: string;
  scope?: string;
  outcome: 'applied' | 'failed' | 'rolled-back' | 'unknown';
  rollbackEligible: boolean;
  rolledBack: boolean;
}
```

No file paths, backup paths, hashes, raw specs, arbitrary exception messages, command output, or free-form process output are allowed.

**Step 3: Add field-by-field mappers for every public response**

Implement `src/web/public-mappers.ts` and route every GET, POST, and error response through it. Cover `InventoryResponse`, `FeedResponse`, `ConflictsResponse`, `OverviewResponse`, Activity, plan, apply, rollback, and error DTOs—not only the two new endpoints.

Requirements:

- Feed failure becomes `{ source }`; do not return its original error.
- Feed recommendation mapper preserves only the allowlisted fields required by Discovery: category, identifier, ecosystem, version, description, source label, reasons, trust, and validated HTTPS URL; it drops raw score and feed internals.
- Installed MCP source metadata is reduced to an extracted package coordinate when confidence is high; raw command/args/spec are never returned. Skills/rules/plugins expose only `sourceLabel`, safe description/token estimate, and validated HTTPS URL when one genuinely exists.
- Adapter failure becomes a fixed availability enum/reason code; do not forward `agent.note`.
- Drift `detail` becomes an allowlisted `reasonCode`; unmanaged entries retain logical agent/kind/name but no path.
- `ActionService.plan/apply/rollback` return the public mutation DTOs instead of raw `summarizeResult()` output.
- Plan/apply changes contain logical `agent/kind/name/scope/op`, never `file` or backup path.
- Known warning/reason strings map to stable codes; an unknown string becomes `OPERATION_WARNING`/`OPERATION_FAILED`, never the original text.
- Delegated command/args/stdout/stderr are not returned. UI preview uses a sanitized `operationSummary` generated from validated logical inputs.
- All server catch blocks return `PublicErrorResponse`; raw `e.message`, stack, env, headers, URL, command, and args never cross the HTTP boundary.
- Never use `{ ...record }`, `{ ...finding }`, `{ ...result }`, or `{ ...error }` in a public mapper.
- Add recursive negative tests over successful and failed GET/POST responses with seeded secret/error/path markers.

**Step 4: Build authoritative inventory cells and operation policy**

Implement `src/web/operations.ts` as a pure server policy used both by `apiInventory()` and action validation. It receives adapter support metadata, agent presence/read status, the row’s real instances, capability kind, and any relevant feed/delegated support. It returns the cell `availability`, `management`, and explicit operations allowlist.

Rules:

- failed agent read → `unavailable`, no operations;
- support metadata absent → `unverifiable`, no inferred install/remove;
- support says unsupported → `unsupported`, no operations;
- present read-only kind → `installed/read-only`, no operations;
- absent writable kind with a valid source instance → `missing/writable` with `sync` only;
- present writable instance → `remove` and source-side `sync` only when `ActionService` accepts that kind;
- delegated plugin operations appear only for validated vendor-CLI support;
- update appears only on the corresponding `FeedResponse` item when the feed identifies a supported update path; `apiInventory()` does not perform a feed fetch to add update operations;
- discovery install remains a feed-item operation, not an invented inventory-cell operation.

`apiInventory()` now returns `InventoryResponse` with one row per `kind + name`, all detected agent cells, server-computed coverage, instance/unique counts, and no raw core item spread. `actions.ts` still revalidates every request at plan time; browser operations are advisory, never authorization.

**Step 5: Implement `apiOverview()`**

- Reuse the same inventory snapshot/public matrix; do not trigger a second scan.
- Call `detectDrift(inv, fleetHome)` with that inventory.
- Count `capabilityInstances` separately from unique `kind + name` keys.
- Count present and unavailable agents separately.
- Return redacted `findings` and redacted `unmanaged` logical entries; never return origin/file paths.
- Keep updates and conflicts out of Overview DTO to avoid duplicate feed/network work; the client composes those counts from `/api/feed` and `/api/conflicts`, each with its own loading/error state.
- Do not emit a synthetic `healthy` boolean. The client derives only `No known findings`, `Attention`, or `Unavailable` from endpoint state.

**Step 6: Implement `apiActivity()`**

- Read `readAudit(fleetHome)` and the delegated plugin ledger through a redacted reader/mapping boundary.
- Compute rolled-back core audit IDs from `rolledBackFrom`.
- Merge and sort the newest 20 core/delegated items by timestamp.
- Mark only non-rollback, not-yet-undone core audit records as `rollbackEligible`; delegated entries are never presented as core rollback candidates.
- Label the UI source so users understand whether an item is a Fleet file change or vendor CLI action.
- Never spread an `AuditRecord` or delegated record into the response.

If reading the delegated ledger would require broad core refactoring, return separate `coreChanges` and `delegatedActions` arrays rather than hiding delegated operations. “Activity” must not silently claim to be complete while excluding plugins.

**Step 7: Wire authenticated public routes**

In `src/web/server.ts`, add:

```text
GET /api/overview
GET /api/activity
```

Also replace the response mapping for existing inventory/feed/conflicts and plan/apply/rollback routes. All remain behind the existing token/Host/Origin gates and `no-store` headers.

**Step 8: Run tests and verify GREEN**

```bash
node --import tsx --test tests/adapters.test.ts tests/adapter-contract.test.ts tests/lock.test.ts tests/web.test.ts tests/web-ui.test.ts
```

Expected: support metadata, server operation policy, routes, mutation DTOs, error DTOs, and recursive redaction assertions pass.

**Step 9: Commit**

```bash
git add src/core/adapter.ts src/core/types.ts src/core/inventory.ts src/core/skill-updates.ts src/adapters/claude-code.ts src/adapters/codex.ts src/adapters/gemini.ts src/web/types.ts src/web/public-mappers.ts src/web/operations.ts src/web/api.ts src/web/actions.ts src/web/server.ts tests/adapters.test.ts tests/adapter-contract.test.ts tests/lock.test.ts tests/web.test.ts tests/web-ui.test.ts
git commit -m "feat(web): add truthful redacted dashboard API contracts"
```

---

## Task 4: Build the unified shell and theme system

**Objective:** Implement one responsive information architecture whose dark and light appearances match the two accepted design directions.

**Files:**

- Modify: `src/web/ui/styles.ts`
- Modify: `src/web/ui/template.ts`
- Modify: `src/web/ui/client.ts`
- Test: `tests/web-ui.test.ts`

**Step 1: Define shared semantic tokens**

Use semantic names instead of duplicating component CSS:

```css
:root {
  color-scheme: dark;
  --bg: #080d12;
  --surface: #0d141a;
  --surface-raised: #111a22;
  --border: #1d2730;
  --text: #e7edf3;
  --muted: #82909c;
  --accent: #2bd4c0;
  --accent-ink: #05211d;
  --good: #44d28b;
  --warn: #e0a83a;
  --danger: #f2555a;
  --focus: rgba(43, 212, 192, 0.55);
}
[data-theme='light'] {
  color-scheme: light;
  --bg: #f4f7f7;
  --surface: #ffffff;
  --surface-raised: #fbfcfc;
  --border: #dfe6e5;
  --text: #172222;
  --muted: #657572;
  --accent: #0d9488;
  --accent-ink: #ffffff;
  --good: #168b69;
  --warn: #a86914;
  --danger: #c83f45;
  --focus: rgba(13, 148, 136, 0.45);
}
```

Verify text/background combinations meet WCAG AA for normal text. Do not use color alone for state; pair color with icon/text.

**Step 2: Build semantic shell**

Required landmarks and controls:

- `<aside>` desktop navigation with Fleet brand and global safety state.
- `<header>` current view title, global search, theme/language/refresh controls.
- `<main id="app-main">` containing five named view sections.
- one reusable dialog/overlay root with `role="dialog"`, `aria-modal="true"`.
- live region for success/error messages.

**Step 3: Implement hash navigation**

Allowed hashes:

```text
#overview #inventory #discover #drift #activity
```

Unknown hashes fall back to `#overview`. Update `aria-current`, focus the new view heading after navigation, and retain navigation state on reload.

**Step 4: Implement responsive behavior**

- ≥1024 px: 224 px rail + content.
- 640–1023 px: compact rail or top tabs.
- <640 px: no persistent rail; horizontally scrollable top/bottom view navigation.
- Tables use an accessible horizontal overflow wrapper; actions never disappear solely because of viewport width.

**Step 5: Run tests**

```bash
node --import tsx --test tests/web-ui.test.ts
npm run typecheck
```

Expected: shell, view, no-external-resource, and no-v1/v2 assertions pass.

**Step 6: Commit**

```bash
git add src/web/ui/ tests/web-ui.test.ts
git commit -m "feat(web): add unified responsive shell and themes"
```

---

## Task 5: Implement Overview as the Capability Fleet Map

**Objective:** Make the default view explain Fleet’s core value by showing capability availability and coverage across detected agents without claiming unproven configuration equality.

**Files:**

- Modify: `src/web/ui/client.ts`
- Modify: `src/web/ui/styles.ts`
- Test: `tests/web-ui.test.ts`

**Step 1: Build a deterministic capability matrix model**

From public inventory/overview DTOs:

- key rows by `kind + name`.
- columns are detected agents in API order.
- each cell has `availability`, `management`, and server-computed `operations`.
- each row has `coverage`: `all-present`, `gap`, `agent-only`, or `unverifiable`.
- `unavailable` and `unsupported` are explicit and never collapsed into `missing`.
- `permission`/`subagent` are `read-only`; plugin is `delegated` where supported.
- use `all present`, not `aligned`, unless a later server equality-class field proves canonical equality without exposing secret-bearing specs.

**Step 2: Render truthful summary cards**

Show:

- detected/present agents.
- capability instances and unique capabilities, clearly labeled.
- updates from `/api/feed`.
- drift findings from `/api/overview`.

Use an em dash while loading, `0` only after successful response, and an explicit “unavailable” state after failure.

**Step 3: Render map interactions**

- Kind filters: All, MCP, Skills, Rules, Plugins, Read-only.
- Clicking a row opens the existing capability detail/action dialog.
- Gap cells expose only operations included in the server-computed allowlist; the client never infers writability.
- Update state opens the existing update plan path.
- Provide text labels (`Installed`, `Missing`, `Unavailable`, `Unsupported`, `All present`, `Gap`) in addition to icons.
- Overview attention explicitly includes actionable MCP updates, non-actionable skill updates, rule conflicts, and endpoint-unavailable states; no category silently disappears.

**Step 4: Test pure ordering/state rules through fixture assertions**

At minimum verify:

- `github` is a gap because only Claude has it.
- `playwright` appears installed on both and is labeled `all present`, not `aligned`, unless server equality is proven.
- permissions/subagents are read-only and never receive install controls.
- plugin operations are delegated and only appear when the server allowlist permits them.
- a missing/failed agent inventory is `unavailable`, not “missing everywhere.”
- an unsupported kind is distinct from an unavailable agent.

**Step 5: Commit**

```bash
git add src/web/ui/client.ts src/web/ui/styles.ts tests/web-ui.test.ts
git commit -m "feat(web): add capability fleet overview"
```

---

## Task 6: Implement the dense Operations inventory

**Objective:** Provide the high-density dark-console workflow for users managing many capabilities while preserving equivalent light-mode behavior.

**Files:**

- Modify: `src/web/ui/client.ts`
- Modify: `src/web/ui/styles.ts`
- Test: `tests/web-ui.test.ts`

**Step 1: Add local inventory controls**

- global text search over name, kind, agent, source/identifier metadata already present in the redacted payload.
- kind chips with truthful counts.
- status filter: All, All present, Gap, Disabled, Unavailable, Unsupported, Read-only, Delegated.
- stable sort by kind then name; optional Name sort.
- visible result count and no-results message.

Do not refetch when filters change.

**Step 2: Render explicit status badges**

Replace unlabeled dots with icon + text badges. Keep a compact visual indicator, but the accessible name must include agent and status.

**Step 3: Upgrade detail dialog**

- Title, kind, description, and safe source identifier/HTTPS URL from the public DTO; never show filesystem paths.
- per-agent installed/missing/disabled state.
- estimated context tokens for skills/rules.
- exact available operations from the server-provided instance allowlist; the client does not derive operations from kind/state.
- all actions call the existing `doPlan()`; no direct apply.
- trap focus while open, close on Escape/backdrop, restore focus to the triggering row.

**Step 4: Add loading/error/empty tests**

Verify search no-results, empty inventory, one failed adapter, and read-only kinds.

**Step 5: Commit**

```bash
git add src/web/ui/client.ts src/web/ui/styles.ts tests/web-ui.test.ts
git commit -m "feat(web): add searchable operations inventory"
```

---

## Task 7: Rebuild Discovery in the shared Fleet tone

**Objective:** Retain the useful Discovery workbench structure without the rejected beige/orange visual identity or overstating install support.

**Files:**

- Modify: `src/web/ui/client.ts`
- Modify: `src/web/ui/styles.ts`
- Test: `tests/web-ui.test.ts`

**Step 1: Add filters and bounded sections**

- Search name, identifier, description, and category.
- Kind filters: MCP, Skill, Plugin.
- Trust filters: No flags, Caution, Unknown.
- Default visible limits: 6 MCP, 6 skills, 4 plugins; each section has “Show all / Collapse.”
- Empty source failures remain visible and name the unavailable source without exposing arbitrary errors.

**Step 2: Render recommendation reasons honestly**

Display server-provided reasons (`new`, `popular`, `related`) and trust level. Do not invent a normalized `8.8/10` fit score unless the API explicitly defines its scale. A raw heuristic score may appear only as “recommendation order” metadata, not a percentage/grade.

**Step 3: Match actions to backend capability**

- MCP npm/PyPI coordinate: `Preview install`.
- Skill: HTTPS repository link and exact local CLI guidance; no fake one-click install.
- Plugin: marketplace/CLI guidance unless a valid installed source + supported target allows existing delegated action.
- Every warning/caution remains visible in the preview dialog.

**Step 4: Keep theme parity**

Discovery cards use the same teal accent, neutral surfaces, status badges, spacing, and typography as Overview/Inventory in both themes. No component-local orange brand palette.

**Step 5: Commit**

```bash
git add src/web/ui/client.ts src/web/ui/styles.ts tests/web-ui.test.ts
git commit -m "feat(web): add bounded discovery workbench"
```

---

## Task 8: Add Drift and Activity views, and make rollback explicit

**Objective:** Surface real operational evidence and replace the ambiguous global rollback action with a selected, confirmable workflow.

**Files:**

- Modify: `src/web/ui/client.ts`
- Modify: `src/web/ui/styles.ts`
- Modify: `src/web/actions.ts`
- Modify: `src/web/server.ts`
- Modify: `tests/web.test.ts`
- Test: `tests/web-ui.test.ts`

**Step 1: Render Drift**

- Summary: checked, findings, unmanaged.
- Groups: modified, missing, unverifiable, unmanaged.
- Explain that unmanaged is informational and lock metadata is best-effort.
- No remediation button unless an existing planner can truthfully perform it.

**Step 2: Render Activity**

Show the redacted 20-item activity list with timestamp, operation, capability, agent, scope, and rolled-back state. Never show raw backup/file paths.

**Step 3: Target rollback by explicit audit ID**

Change `ActionService.rollback()` to accept an `ActionBody` containing `auditId`, validate it as a plain bounded identifier, and call:

```ts
rollback({ auditId, fleetHome: this.fleetHome });
```

The client must:

1. select an activity with `rollbackEligible: true`;
2. show operation/capability/agent and explain the divergence guard;
3. require a second explicit `Confirm rollback` click;
4. send `{ auditId }` to `POST /api/rollback`;
5. refresh Overview, Inventory, Drift, and Activity after completion;
6. display `restored`, `removed`, or `skipped` plus the redacted reason.

This does not pretend rollback is a normal `plan/apply` mutation. It makes the selected target explicit while retaining core rollback’s own lock and divergence guard.

**Step 4: Test fail-closed behavior**

- missing/unknown/rollback-record/already-undone IDs fail.
- an eligible ID affects only that audit target.
- skipped divergence is displayed as skipped, not success.
- POST security gates remain unchanged.

**Step 5: Commit**

```bash
git add src/web/actions.ts src/web/server.ts src/web/ui/ tests/web.test.ts tests/web-ui.test.ts
git commit -m "feat(web): add drift activity and targeted rollback"
```

---

## Task 9: Accessibility, localization, and resilient states

**Objective:** Make all redesigned workflows usable without a mouse and keep Korean/English/theme toggles consistent across every view.

**Files:**

- Modify: `src/web/ui/client.ts`
- Modify: `src/web/ui/styles.ts`
- Modify: `src/web/ui/template.ts`
- Test: `tests/web-ui.test.ts`

**Step 1: Complete i18n keys**

Add Korean and English strings for navigation, filters, map alignment, loading/error states, drift states, activity, rollback confirmation, “show more,” and agent-unavailable labels. Unknown server enum values may pass through, but user-facing static copy must not.

**Step 2: Keyboard and focus behavior**

- visible `:focus-visible` at ≥3:1 contrast.
- tab order follows visual order.
- rows that open dialogs are actual buttons/links inside cells or support Enter/Space with correct role.
- dialog focus trap, Escape close, focus restoration.
- `aria-live="polite"` for refresh/apply results; errors use `role="alert"`.
- theme and icon-only controls have localized accessible names.

**Step 3: Respect preferences**

- `prefers-color-scheme` only chooses the first theme; explicit user choice persists.
- `prefers-reduced-motion: reduce` disables dialog/toast transitions.
- language/theme changes re-render cached data without network refetch.

**Step 4: Verify contrast and narrow layouts**

Manually inspect 360×800, 768×1024, and 1265×839 in both themes. Record issues in the implementation PR description; fix overlap, clipping, unreachable actions, and low-contrast secondary text before completion.

**Step 5: Commit**

```bash
git add src/web/ui/ tests/web-ui.test.ts
git commit -m "fix(web): harden dashboard accessibility and responsive states"
```

---

## Task 10: Update documentation after the unified dashboard is complete

**Objective:** Document the truthful interface after Task 2 has already removed v1/v2 and Tasks 3–9 have established final behavior.

**Files:**

- Modify: `docs/USAGE.md`
- Modify: `README.md`

**Step 1: Update docs**

Document:

- Overview/Inventory/Discover/Drift/Activity.
- dark/light theme behavior.
- capability state vocabulary: unavailable, unsupported, missing, all present, gap, read-only, delegated.
- accurate one-click support: MCP install/update, cross-agent sync/remove where supported, skill/plugin limitations.
- dry-run/confirm model.
- targeted rollback and divergence behavior.
- Activity’s core-audit versus delegated-plugin sources.
- local/Tailscale-only security model.

Remove statements that describe the old long single-page layout, v1/v2 UI, universal one-click install, or heuristic recommendation scores as objective quality grades.

**Step 2: Run documentation checks and focused tests**

```bash
npm run format:check
node --import tsx --test tests/web-ui.test.ts tests/web.test.ts
```

Expected: all pass.

**Step 3: Commit**

```bash
git add docs/USAGE.md README.md
git commit -m "docs(web): document unified fleet dashboard"
```

---

## Task 11: Full verification and visual acceptance

**Objective:** Prove the built artifact works against the real server and no security/quality regression was introduced.

**Files:**

- Modify only files required by failures found during verification.

**Step 1: Run full CI**

```bash
npm run ci
```

Expected:

```text
lint PASS
format:check PASS
typecheck PASS
all existing and new dashboard tests PASS
build PASS
```

Do not freeze the expected final test count in documentation; report the observed count from the implementation run.

**Step 2: Start isolated and built-artifact servers**

Use the Task 0 fixture launcher for interactive mutation/browser checks:

```bash
npm run dev:web-fixture
```

Separately smoke the built CLI with a fresh temporary `HOME`/Fleet directory; do not let it discover the developer’s real adapters. Record the actual command and temporary root in the implementation report, then remove the root.

Use emitted tokenized URLs privately. Never paste a token into screenshots, filenames, test fixtures, commits, logs retained in the repository, or review text.

**Step 3: Exercise real browser flows**

For both dark and light themes:

1. load Overview and verify the query token is removed without losing the current hash;
2. switch every navigation view, reload, and verify hash restoration;
3. search/filter Inventory;
4. filter and expand Discovery;
5. open a capability detail;
6. create an install/sync dry-run and cancel it;
7. confirm one fixture-safe change only in the isolated fixture root;
8. inspect both core-audit and delegated-plugin Activity, then open a selected rollback confirmation;
9. verify Escape/backdrop/focus trap and restoration;
10. simulate one endpoint failure while others succeed and verify only that panel becomes `Unavailable`;
11. verify `No known findings` is used instead of inferred `Healthy`;
12. check console errors after every major transition;
13. repeat layout checks at 360×800, 768×1024, and 1265×839.

Never apply mutation smoke tests to the developer’s actual `~/.claude*` or `~/.codex*` files. Use adapters pointed at a temporary test directory or a purpose-built fixture launcher.

**Step 4: Capture acceptance screenshots**

Capture into a repository-external directory such as `/tmp/fleet-ui-acceptance/`; do not place generated images under the repository:

- dark Overview and Inventory at 1265×839;
- light Overview and Discover at 1265×839;
- one preview dialog;
- 360×800 and 768×1024 responsive views;
- one screenshot per theme used for contrast review.

Compare against the approved sketches by intent, not pixel identity. Required visual traits:

- dark mode reads as Operations Console;
- light mode reads as Capability Map;
- Discovery uses the same teal/neutral system;
- no orange/beige product identity;
- no unbounded all-recommendations page.

**Step 5: Final repository check**

```bash
git status --short
git diff --check
git log --oneline --max-count=12
```

Expected: no accidental generated files, tokens, screenshot binaries, or unrelated changes. Decide separately whether disposable `sketches/` should be committed under docs/design or removed before the production PR.

**Step 6: Final commit if verification required fixes**

```bash
git add <only-the-fixed-files>
git commit -m "fix(web): address dashboard acceptance findings"
```

---

## Implementation review checklist

### Product fidelity

- [x] Dark mode matches Operations Console tone.
- [x] Light mode matches Capability Map tone.
- [x] Discovery uses shared teal/neutral tokens, not orange/beige.
- [x] Capability Map is the default view.
- [x] Inventory remains efficient for power users.
- [x] Discovery tells the truth about which capability kinds can be installed directly.

### Security and mutation safety

- [x] No secrets/raw inventory/raw audit records reach the browser.
- [x] Dynamic content uses `textContent`.
- [x] External links are HTTPS-only with `noopener noreferrer`.
- [x] Existing CSP, Host, Origin, bearer token, body size, and no-store controls remain.
- [x] Install/sync/remove/update remain preview→single-use apply.
- [x] Rollback identifies a specific eligible audit record and requires confirmation.
- [x] No test or screenshot touches real agent configuration.

### Quality

- [x] UI source is split into reviewable modules but served as one document.
- [x] No frontend framework or second build pipeline.
- [x] Loading, zero, empty, partial failure, unavailable, and success states are distinct.
- [x] Theme/language toggles re-render without refetch.
- [x] Keyboard navigation, focus management, reduced motion, and contrast pass.
- [x] 360 px, 768 px, and 1265 px layouts pass visual verification.
- [x] `npm run ci` passes.
