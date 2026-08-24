import { randomBytes } from 'node:crypto';
import type { AgentAdapter } from '../core/adapter.js';
import type { McpServerSpec, Scope } from '../core/types.js';
import { buildInventory } from '../core/inventory.js';
import {
  planInstall,
  planSync,
  planRemove,
  planInstallSkill,
  planSyncSkill,
  planRemoveSkill,
  planSyncRule,
  planRemoveRule,
  execute,
  resolveTargets,
  type Plan,
} from '../core/orchestrator.js';
import { rollback } from '../core/writer.js';
import { replaceRunnerPackageVersion } from '../core/coords.js';
import { isPublicAgentId, isPublicCapabilityName } from '../core/redact.js';
import {
  DelegatedOutcomeUnknownError,
  planPluginActions,
  runDelegated,
  type DelegatedPlan,
} from '../core/delegate.js';
import { pluginCoordinate } from '../core/plugin-coordinate.js';
import { invalidateInventoryCache } from './api.js';
import { capabilityCell, operationAllowed, supportsDelegatedPlugin } from './operations.js';
import {
  isPublicMutationIdentity,
  mapApply,
  mapDelegatedApply,
  mapDelegatedPlan,
  mapPlan,
  mapRollback,
} from './public-mappers.js';
import type { Operation, PublicApplyResponse, PublicPlanResponse, PublicRollbackResponse } from './types.js';
import { assertWritableScope, parseScope, selectScopedCapability } from '../core/scope.js';
import { assertValidWebPackageCoordinate, type WebPackageCoordinate } from './package-coordinate.js';
import { assertMutationConfigReadable } from '../core/config.js';
import { FleetOperationError } from '../core/errors.js';
import {
  assertGitHubSkillCoordinate,
  GitHubSkillCleanupError,
  materializeGitHubSkill,
  type GitHubSkillCoordinate,
  type GitHubSkillLease,
  type SkillMaterializer,
} from './github-skill.js';

/**
 * The dashboard's mutation service: a server-enforced preview→confirm two-step.
 * `plan()` validates logical inputs, stores a dry-run plan, and returns only a
 * redacted preview plus a single-use planId. Package coordinates from the
 * (remote) feed are VALIDATED before they can become a spec — a crafted
 * identifier must not smuggle flags or git/url/file targets into what the agent
 * later executes.
 */

function validateVersion(v: string | undefined): void {
  if (v !== undefined && v !== '' && !/^[a-z0-9][a-z0-9.+-]*$/i.test(v)) {
    throw new FleetOperationError('REQUEST_REJECTED', `refusing unsafe version '${v}'`);
  }
}

function specFromCoordinate(c: WebPackageCoordinate | undefined): McpServerSpec {
  assertValidWebPackageCoordinate(c);
  const pkg = c.version ? `${c.identifier}@${c.version}` : c.identifier;
  if (c.ecosystem === 'npm') return { transport: 'stdio', command: 'npx', args: ['-y', pkg] };
  return { transport: 'stdio', command: 'uvx', args: [pkg] };
}

/** Bump the version of an installed stdio server WITHOUT dropping its env/args/command. */
function bumpVersion(spec: McpServerSpec, version: string): McpServerSpec {
  if (spec.transport !== 'stdio') {
    throw new FleetOperationError(
      'UNSUPPORTED_OPERATION',
      'only stdio (npx/uvx) servers can be version-updated from the dashboard',
    );
  }
  validateVersion(version);
  const updated = replaceRunnerPackageVersion(spec, version);
  if (!updated) {
    throw new FleetOperationError(
      'UNSUPPORTED_OPERATION',
      'could not locate a valid package argument to update',
    );
  }
  return updated;
}

export interface ActionBody {
  action?: string;
  /** capability kind — routes sync/remove to the right engine (default mcp-server) */
  kind?: string;
  name?: string;
  to?: unknown;
  from?: unknown;
  /** Exact target/source scope for scoped MCP inventory operations. */
  scope?: unknown;
  fromScope?: unknown;
  coordinate?: WebPackageCoordinate;
  /** Exact public repository + selector for a registry-backed skill install. */
  skillCoordinate?: GitHubSkillCoordinate;
  /** for plugin sync: the source marketplace (selector = name@marketplace) */
  marketplace?: string;
  planId?: string;
  auditId?: string;
}

const MAX_PENDING = 100;
const PLAN_TTL_MS = 5 * 60_000;

/** A pending mutation: either a core Plan (execute pipeline) or a delegated
 * vendor-CLI action (plugins). Both flow through the same preview→confirm. */
type Pending =
  | {
      type: 'core';
      plan: Plan;
      expiresAt: number;
      dispose?: () => Promise<void>;
      detachedLeaseSlot?: boolean;
    }
  | { type: 'delegated'; dplan: DelegatedPlan; expiresAt: number };
type PendingInput =
  { type: 'core'; plan: Plan; dispose?: () => Promise<void> } | { type: 'delegated'; dplan: DelegatedPlan };
interface PlanSlotReservation {
  consume(): void;
  release(): void;
}

export class ActionService {
  private readonly plans = new Map<string, Pending>();
  private readonly expiryTimers = new Map<string, NodeJS.Timeout>();
  private reservedPlanSlots = 0;
  private detachedLeaseSlots = 0;
  private activeTasks = 0;
  private closing = false;
  private cleanupFailed = false;
  private disposal: Promise<void> | undefined;
  private readonly reservationDrainWaiters: Array<() => void> = [];
  private readonly taskDrainWaiters: Array<() => void> = [];

  constructor(
    private readonly adapters: AgentAdapter[],
    private readonly fleetHome?: string,
    /** injectable vendor-CLI runner — tests avoid spawning the real binary */
    private readonly runner?: import('../core/delegate.js').Runner,
    /** injectable execution-free repository materializer for Web skill previews. */
    private readonly skillMaterializer: SkillMaterializer = materializeGitHubSkill,
  ) {}

  /** Build and store a plan, returning only its redacted logical preview. */
  async plan(body: ActionBody): Promise<PublicPlanResponse> {
    return this.runTracked(() => this.buildPlan(body));
  }

  private async buildPlan(body: ActionBody): Promise<PublicPlanResponse> {
    this.assertOpen();
    if (typeof body.name !== 'string') {
      throw new FleetOperationError('INVALID_ARGUMENT', 'name must be a string');
    }
    if (typeof body.action !== 'string') {
      throw new FleetOperationError('INVALID_ARGUMENT', 'action must be a string');
    }
    if (body.kind !== undefined && typeof body.kind !== 'string') {
      throw new FleetOperationError('INVALID_ARGUMENT', 'kind must be a string');
    }
    const name = body.name.trim();
    if (!name) throw new FleetOperationError('INVALID_ARGUMENT', 'name is required');
    const kind = body.kind ?? 'mcp-server';
    // allowlist kinds — an unknown kind must never fall through to a default engine
    if (!['mcp-server', 'skill', 'rule', 'plugin'].includes(kind)) {
      throw new FleetOperationError('INVALID_ARGUMENT', `unknown kind '${kind}'`);
    }

    // plugins live outside the core write engine — a delegated vendor-CLI action
    if (kind === 'plugin') return this.planPlugin(body, name);
    if (!isPublicCapabilityName(name)) {
      throw new FleetOperationError('REQUEST_REJECTED', 'refusing non-public capability identity');
    }
    const coreKind = kind as 'mcp-server' | 'skill' | 'rule';

    let plan: Plan;
    let skillLease: GitHubSkillLease | undefined;
    let slotReservation: PlanSlotReservation | undefined;
    let leaseTransferred = false;
    try {
      switch (body.action) {
        case 'install': {
          if (kind === 'rule') {
            throw new FleetOperationError(
              'UNSUPPORTED_OPERATION',
              'rule install is not supported by this endpoint',
            );
          }
          const spec = kind === 'mcp-server' ? specFromCoordinate(body.coordinate) : undefined;
          const skillCoordinate = kind === 'skill' ? body.skillCoordinate : undefined;
          if (kind === 'skill') {
            assertGitHubSkillCoordinate(skillCoordinate);
            if (skillCoordinate.skill !== name) {
              throw new FleetOperationError(
                'INVALID_ARGUMENT',
                'skill name must match the repository selector',
              );
            }
          }
          const targets = await resolveTargets(this.adapters, toTargets(body.to), coreKind);
          await this.assertAllowed(kind, name, 'install', targets, { targetScope: 'user' });
          if (kind === 'mcp-server') {
            plan = await planInstall(this.adapters, spec!, name, 'user', targets, {
              fleetHome: this.fleetHome,
            });
            break;
          }
          // Do not perform a public network read when local mutation policy is
          // already damaged and every possible apply would have to fail closed.
          assertMutationConfigReadable(this.fleetHome);
          slotReservation = this.reservePlanSlot();
          try {
            skillLease = await this.skillMaterializer(skillCoordinate!);
          } catch (error) {
            if (error instanceof GitHubSkillCleanupError) this.recordStagedCleanupFailure();
            throw error;
          }
          plan = await planInstallSkill(this.adapters, skillLease.source, name, targets, {
            fleetHome: this.fleetHome,
            sourceRoot: skillLease.sourceRoot,
            origin: skillLease.origin,
          });
          break;
        }
        case 'update': {
          if (kind !== 'mcp-server') {
            throw new FleetOperationError(
              'UNSUPPORTED_OPERATION',
              `${kind} update is not supported by this endpoint`,
            );
          }
          const agent = toTargets(body.to);
          const requestedScope = parseScope(body.scope);
          const existing = selectScopedCapability((await buildInventory(this.adapters)).items, {
            agent,
            kind: 'mcp-server',
            name,
            ...(requestedScope ? { scope: requestedScope } : {}),
          });
          if (!existing || existing.kind !== 'mcp-server') {
            throw new FleetOperationError(
              'TARGET_UNAVAILABLE',
              `'${name}' is not an installed MCP server on ${agent}`,
            );
          }
          const spec = bumpVersion(existing.spec, String(body.coordinate?.version ?? ''));
          const targets = await resolveTargets(this.adapters, agent, coreKind);
          await this.assertAllowed(kind, name, 'update', targets, { targetScope: existing.scope });
          plan = await planInstall(this.adapters, spec, name, existing.scope, targets, {
            fleetHome: this.fleetHome,
          });
          break;
        }
        case 'sync': {
          // "install what claude has onto codex too" — kind-routed cross-agent copy
          const targets = await resolveTargets(this.adapters, toTargets(body.to), coreKind);
          const from = body.from;
          if (typeof from !== 'string') {
            throw new FleetOperationError('INVALID_ARGUMENT', 'source agent must be a string');
          }
          if (!isPublicAgentId(from)) {
            throw new FleetOperationError('REQUEST_REJECTED', 'refusing non-public source agent identity');
          }
          const sourceScope = parseScope(body.fromScope, 'fromScope');
          await this.assertAllowed(kind, name, 'sync', targets, {
            targetScope: kind === 'mcp-server' ? 'user' : undefined,
            sourceAgent: from,
            sourceScope,
          });
          plan =
            kind === 'skill'
              ? await planSyncSkill(this.adapters, name, from, targets, {
                  fleetHome: this.fleetHome,
                  sourceScope,
                })
              : kind === 'rule'
                ? await planSyncRule(this.adapters, name, from, targets, { sourceScope })
                : await planSync(this.adapters, name, from, targets, {
                    fleetHome: this.fleetHome,
                    sourceScope,
                  });
          break;
        }
        case 'remove': {
          const targetScope = parseScope(body.scope) ?? 'user';
          assertWritableScope(targetScope);
          const targets = await resolveTargets(this.adapters, toTargets(body.from), coreKind);
          await this.assertAllowed(kind, name, 'remove', targets, { targetScope });
          plan =
            kind === 'skill'
              ? await planRemoveSkill(this.adapters, name, targets)
              : kind === 'rule'
                ? await planRemoveRule(this.adapters, name, targets)
                : await planRemove(this.adapters, name, targets, targetScope);
          break;
        }
        default:
          throw new FleetOperationError('INVALID_ARGUMENT', `unknown action '${body.action ?? ''}'`);
      }
      if (!plan.changes.every((change) => isPublicMutationIdentity(change))) {
        throw new FleetOperationError(
          'REQUEST_REJECTED',
          'refusing a plan with a non-public mutation target',
        );
      }
      if (skillLease && plan.changes.length === 0) {
        const emptyLease = skillLease;
        await this.disposeStagedLease(() => emptyLease.dispose());
        skillLease = undefined;
      }
      const retainedLease = skillLease;
      const stored = this.store(
        {
          type: 'core',
          plan,
          ...(retainedLease ? { dispose: () => retainedLease.dispose() } : {}),
        },
        slotReservation,
      );
      slotReservation = undefined;
      leaseTransferred = Boolean(retainedLease);
      return mapPlan(
        stored.planId,
        stored.expiresAt,
        plan,
        this.summary(body.action!, kind, plan.changes.length),
      );
    } finally {
      if (skillLease && !leaseTransferred) {
        const untransferredLease = skillLease;
        await this.disposeStagedLease(() => untransferredLease.dispose());
      }
      slotReservation?.release();
    }
  }

  /** Plugin install/remove goes through the delegated vendor CLI. The selector
   * is name@marketplace for a sync-install (default action install). */
  private async planPlugin(body: ActionBody, name: string): Promise<PublicPlanResponse> {
    if (body.action !== 'install' && body.action !== 'remove') {
      throw new FleetOperationError(
        'UNSUPPORTED_OPERATION',
        `plugin action must be install or remove (got '${body.action ?? ''}')`,
      );
    }
    const op = body.action;
    const agent = op === 'remove' ? toTargets(body.from) : toTargets(body.to);
    if (!agent || agent.includes(',') || agent === 'all') {
      throw new FleetOperationError('INVALID_ARGUMENT', 'plugin actions target exactly one agent');
    }
    if (body.marketplace !== undefined && typeof body.marketplace !== 'string') {
      throw new FleetOperationError('INVALID_ARGUMENT', 'marketplace must be a string');
    }
    if (typeof body.marketplace === 'string' && body.marketplace.length > 64) {
      throw new FleetOperationError('INVALID_ARGUMENT', 'marketplace exceeds the public identity limit');
    }
    const marketplace = body.marketplace;
    const coordinate = pluginCoordinate(name, marketplace);
    await this.assertAllowed('plugin', coordinate.name, op, [agent], {
      marketplace: coordinate.marketplace,
      targetScope: 'user',
    });
    const [dplan] = await planPluginActions(this.adapters, agent, op, coordinate.selector);
    if (!dplan) throw new FleetOperationError('TARGET_UNAVAILABLE', 'plugin target is unavailable');
    const resolvedCoordinate = pluginCoordinate(dplan.selector);
    if (
      !isPublicMutationIdentity({
        agent,
        kind: 'plugin',
        name: resolvedCoordinate.name,
        marketplace: resolvedCoordinate.marketplace,
        scope: 'user',
        op,
      })
    ) {
      throw new FleetOperationError(
        'REQUEST_REJECTED',
        'refusing a delegated plan with a non-public mutation target',
      );
    }
    const stored = this.store({ type: 'delegated', dplan });
    return mapDelegatedPlan(
      stored.planId,
      stored.expiresAt,
      {
        agent,
        name: resolvedCoordinate.name,
        marketplace: resolvedCoordinate.marketplace,
        op,
      },
      this.summary(op, 'plugin', 1),
    );
  }

  private reservePlanSlot(): PlanSlotReservation {
    this.assertOpen();
    if (this.occupiedPlanSlots() >= MAX_PENDING) {
      throw new FleetOperationError('TARGET_UNAVAILABLE', 'too many pending previews');
    }
    this.reservedPlanSlots++;
    let active = true;
    const finish = () => {
      if (!active) return;
      active = false;
      this.reservedPlanSlots--;
      if (this.reservedPlanSlots === 0) {
        for (const resolve of this.reservationDrainWaiters.splice(0)) resolve();
      }
    };
    return { consume: finish, release: finish };
  }

  private store(p: PendingInput, reservation?: PlanSlotReservation): { planId: string; expiresAt: number } {
    this.assertOpen();
    const occupied = this.occupiedPlanSlots();
    if ((!reservation && occupied >= MAX_PENDING) || (reservation && occupied > MAX_PENDING)) {
      throw new FleetOperationError('TARGET_UNAVAILABLE', 'too many pending previews');
    }
    const planId = randomBytes(12).toString('hex');
    const expiresAt = Date.now() + PLAN_TTL_MS;
    reservation?.consume();
    this.plans.set(planId, { ...p, expiresAt } as Pending);
    const timer = setTimeout(() => {
      const expired = this.take(planId);
      if (expired) this.releaseInBackground(expired);
    }, PLAN_TTL_MS + 1);
    timer.unref();
    this.expiryTimers.set(planId, timer);
    return { planId, expiresAt };
  }

  private occupiedPlanSlots(): number {
    return this.plans.size + this.reservedPlanSlots + this.detachedLeaseSlots;
  }

  private take(planId: string): Pending | undefined {
    const pending = this.plans.get(planId);
    if (pending?.type === 'core' && pending.dispose && !pending.detachedLeaseSlot) {
      pending.detachedLeaseSlot = true;
      this.detachedLeaseSlots++;
    }
    this.plans.delete(planId);
    const timer = this.expiryTimers.get(planId);
    if (timer) clearTimeout(timer);
    this.expiryTimers.delete(planId);
    return pending;
  }

  private async release(pending: Pending): Promise<void> {
    if (pending.type !== 'core' || !pending.dispose) return;
    try {
      await this.disposeStagedLease(pending.dispose);
    } finally {
      if (pending.detachedLeaseSlot) {
        pending.detachedLeaseSlot = false;
        this.detachedLeaseSlots--;
      }
    }
  }

  private async disposeStagedLease(dispose: () => Promise<void>): Promise<void> {
    try {
      await dispose();
    } catch {
      // Cleanup failure must not overwrite a mutation/planning result, but it
      // makes further staging unsafe and must be observable on service drain.
      this.recordStagedCleanupFailure();
    }
  }

  private recordStagedCleanupFailure(): void {
    this.cleanupFailed = true;
    this.closing = true;
  }

  private assertOpen(): void {
    if (!this.closing) return;
    if (this.cleanupFailed) {
      throw new FleetOperationError('RECOVERY_PENDING', 'staged skill cleanup recovery is pending');
    }
    throw new FleetOperationError('TARGET_UNAVAILABLE', 'action service is closing');
  }

  private beginTrackedTask(allowWhileClosing = false): () => void {
    if (!allowWhileClosing) this.assertOpen();
    this.activeTasks++;
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      this.activeTasks--;
      if (this.activeTasks === 0) {
        for (const resolve of this.taskDrainWaiters.splice(0)) resolve();
      }
    };
  }

  private async runTracked<T>(task: () => Promise<T>): Promise<T> {
    const finish = this.beginTrackedTask();
    try {
      return await task();
    } finally {
      finish();
    }
  }

  private releaseInBackground(pending: Pending): void {
    // Expiry removes the plan synchronously. Register its asynchronous lease
    // cleanup before yielding so a concurrent dispose() cannot miss it.
    const finish = this.beginTrackedTask(true);
    void this.release(pending).finally(finish);
  }

  private waitForTrackedTasks(): Promise<void> {
    return this.activeTasks === 0
      ? Promise.resolve()
      : new Promise<void>((resolve) => this.taskDrainWaiters.push(resolve));
  }

  /** Release staged preview sources when an embedding server shuts down. */
  dispose(): Promise<void> {
    this.closing = true;
    return (this.disposal ??= this.drain());
  }

  private async drain(): Promise<void> {
    const pending = [...this.plans.keys()].flatMap((planId) => {
      const value = this.take(planId);
      return value ? [value] : [];
    });
    await Promise.all(pending.map((value) => this.release(value)));
    if (this.reservedPlanSlots > 0) {
      await new Promise<void>((resolve) => this.reservationDrainWaiters.push(resolve));
    }
    await this.waitForTrackedTasks();
    if (this.cleanupFailed) throw new Error('Fleet staged skill cleanup failed');
  }

  /** Apply a previously-planned change (by planId). Consumes the plan. */
  async apply(body: ActionBody): Promise<PublicApplyResponse> {
    return this.runTracked(() => this.applyPlan(body));
  }

  private async applyPlan(body: ActionBody): Promise<PublicApplyResponse> {
    if (typeof body.planId !== 'string' || !/^[0-9a-f]{24}$/.test(body.planId)) {
      throw new FleetOperationError('INVALID_ARGUMENT', 'a valid planId is required');
    }
    const planId = body.planId;
    const pending = this.take(planId);
    if (!pending) {
      throw new FleetOperationError('TARGET_UNAVAILABLE', 'unknown planId — preview again before applying');
    }
    if (pending.expiresAt < Date.now()) {
      await this.release(pending);
      throw new FleetOperationError('TARGET_UNAVAILABLE', 'plan expired — preview again before applying');
    }
    if (pending.type === 'delegated') {
      try {
        const r = await runDelegated(pending.dplan, {
          commit: true,
          fleetHome: this.fleetHome,
          runner: this.runner,
        });
        invalidateInventoryCache();
        const coordinate = pluginCoordinate(pending.dplan.selector);
        return mapDelegatedApply(
          r.status === 'preview' ? 'outcome-unknown' : r.status,
          Boolean(r.lockWarning),
          undefined,
          {
            agent: pending.dplan.agent,
            name: coordinate.name,
            ...(coordinate.marketplace ? { marketplace: coordinate.marketplace } : {}),
            op: pending.dplan.op,
            ...(r.ledgerId ? { delegatedId: r.ledgerId } : {}),
            delegatedRecorded: Boolean(r.ledgerId),
          },
        );
      } catch (error) {
        invalidateInventoryCache();
        const coordinate = pluginCoordinate(pending.dplan.selector);
        return mapDelegatedApply(
          error instanceof DelegatedOutcomeUnknownError ? 'outcome-unknown' : 'failed',
          false,
          error instanceof DelegatedOutcomeUnknownError,
          {
            agent: pending.dplan.agent,
            name: coordinate.name,
            ...(coordinate.marketplace ? { marketplace: coordinate.marketplace } : {}),
            op: pending.dplan.op,
            ...(error instanceof DelegatedOutcomeUnknownError && error.ledgerId
              ? { delegatedId: error.ledgerId }
              : {}),
            delegatedRecorded: false,
          },
        );
      }
    }
    try {
      const result = await execute(this.adapters, pending.plan, { commit: true, fleetHome: this.fleetHome });
      invalidateInventoryCache(); // a refresh right after apply must see the new state
      return mapApply(result);
    } finally {
      await this.release(pending);
    }
  }

  async rollback(body: ActionBody): Promise<PublicRollbackResponse> {
    return this.runTracked(() => this.applyRollback(body));
  }

  private async applyRollback(body: ActionBody): Promise<PublicRollbackResponse> {
    const auditId = body.auditId;
    if (
      typeof auditId !== 'string' ||
      auditId.length > 64 ||
      !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(auditId)
    ) {
      throw new FleetOperationError('INVALID_ARGUMENT', 'a valid auditId is required');
    }
    let r: Awaited<ReturnType<typeof rollback>>;
    try {
      r = await rollback({ auditId, fleetHome: this.fleetHome });
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      if (/no change available|rollback record|already rolled back|newer active change/i.test(message)) {
        throw new FleetOperationError('TARGET_UNAVAILABLE', 'rollback target is not eligible');
      }
      throw error;
    }
    invalidateInventoryCache();
    return mapRollback(r);
  }

  private summary(action: string, kind: string, changes: number): string {
    return `${action} ${kind} (${changes} ${changes === 1 ? 'change' : 'changes'})`;
  }

  private async assertAllowed(
    kind: string,
    name: string,
    operation: Operation,
    targets: string[],
    options: {
      targetScope?: Scope;
      sourceAgent?: string;
      sourceScope?: Scope;
      marketplace?: string;
    } = {},
  ): Promise<void> {
    const inventory = await buildInventory(this.adapters);
    const primitive = kind as import('../core/types.js').PrimitiveKind;
    const sourceMatches = inventory.items.filter(
      (item) =>
        item.kind === primitive &&
        item.name === name &&
        (!options.marketplace || (item.kind === 'plugin' && item.marketplace === options.marketplace)) &&
        (!options.sourceAgent || item.agent === options.sourceAgent) &&
        (!options.sourceScope || item.scope === options.sourceScope),
    );
    if (options.sourceAgent && primitive === 'mcp-server') {
      selectScopedCapability(sourceMatches, {
        agent: options.sourceAgent,
        kind: primitive,
        name,
        ...(options.sourceScope ? { scope: options.sourceScope } : {}),
      });
    }
    const hasSourceInstance = sourceMatches.length > 0;
    for (const target of targets) {
      const adapter = this.adapters.find((candidate) => candidate.id === target);
      const agent = inventory.agents.find((candidate) => candidate.id === target);
      const allTargetMatches = inventory.items.filter(
        (item) =>
          item.kind === primitive &&
          item.name === name &&
          item.agent === target &&
          (!options.marketplace || (item.kind === 'plugin' && item.marketplace === options.marketplace)),
      );
      const targetMatches = allTargetMatches.filter(
        (item) => !options.targetScope || item.scope === options.targetScope,
      );
      if (primitive === 'plugin' && allTargetMatches.length > 0 && targetMatches.length === 0) {
        throw new FleetOperationError(
          'UNSUPPORTED_OPERATION',
          'plugin mutations require the supported user scope',
        );
      }
      const instance =
        primitive === 'mcp-server' || primitive === 'skill' || primitive === 'rule'
          ? selectScopedCapability(targetMatches, {
              agent: target,
              kind: primitive,
              name,
              ...(options.targetScope ? { scope: options.targetScope } : {}),
            })
          : targetMatches[0];
      if (!adapter || !agent) {
        throw new FleetOperationError('TARGET_UNAVAILABLE', 'requested target is unavailable');
      }
      const cellInput = {
        adapter,
        agent,
        kind: primitive,
        hasInstance: Boolean(instance),
        ...(instance ? { scope: instance.scope } : {}),
        hasSourceInstance,
        delegatedSupported: primitive === 'plugin' && supportsDelegatedPlugin(adapter),
      };
      if (operationAllowed(cellInput, operation)) continue;
      const cell = capabilityCell(cellInput);
      if (
        cell.availability === 'unsupported' ||
        cell.management === 'none' ||
        cell.management === 'read-only'
      ) {
        throw new FleetOperationError(
          'UNSUPPORTED_OPERATION',
          'operation is not supported for the requested target',
        );
      }
      throw new FleetOperationError('TARGET_UNAVAILABLE', 'requested target state changed; preview again');
    }
  }
}

function toTargets(v: unknown): string {
  if (Array.isArray(v)) {
    if (
      v.length === 0 ||
      v.length > 32 ||
      !v.every((value) => typeof value === 'string' && isPublicAgentId(value)) ||
      new Set(v).size !== v.length
    ) {
      throw new FleetOperationError('INVALID_ARGUMENT', 'targets must be a unique list of agent ids');
    }
    return v.join(',');
  }
  if (typeof v !== 'string' || (v !== 'all' && !isPublicAgentId(v))) {
    throw new FleetOperationError('INVALID_ARGUMENT', 'target must be an agent id or all');
  }
  return v;
}
