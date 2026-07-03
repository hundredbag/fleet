import type { DetectedAgent, InstalledCapability, McpServerSpec, PrimitiveKind, Scope } from './types.js';

/**
 * One adapter per agent runtime. It knows how to read (and, when
 * `supportsWrite`, write) that agent's capability configuration.
 *
 * Read contract: detect() + readInventory().
 * Write contract: the optional AgentWriter methods (see below). Adapters keep
 * all format knowledge (JSON/TOML quirks); the engine in `core/writer.ts` owns
 * the safety mechanics (backup, atomic write, validate, audit, rollback).
 */
export interface AgentAdapter {
  readonly id: string;
  readonly displayName: string;

  /** Whether this adapter implements the AgentWriter methods. */
  readonly supportsWrite?: boolean;

  /** Detect whether the agent is present and where its config lives. */
  detect(): Promise<DetectedAgent>;

  /** Read all installed capabilities (v1: MCP servers). Pure read. */
  readInventory(): Promise<InstalledCapability[]>;
}

/** Identifies a single capability slot to install/remove on one agent. */
export interface CapabilityRef {
  kind: PrimitiveKind;
  name: string;
  scope: Scope;
}

/**
 * The result of rendering a mutation — produced WITHOUT touching disk. The
 * engine turns this into a safe write. A change targets either a single FILE
 * (config entry — write `newContent`) or a DIRECTORY (a skill — copy/remove).
 */
export interface RenderResult {
  /** path the engine should write (a file, or a directory when fsKind==='dir') */
  file: string;
  /** the capability kind this change is for (drives kind-aware validation) */
  kind?: PrimitiveKind;
  /** 'file' (default): write newContent. 'dir': install/remove a directory. */
  fsKind?: 'file' | 'dir';
  /** full proposed file content (file kind; preserves everything unrelated; '' for dir kind) */
  newContent: string;
  /** dir-install: copy the skill tree from here into `file` */
  sourceDir?: string;
  /** dir kind: which directory operation */
  dirOp?: 'install' | 'remove';
  /** the entry as it was, for the diff view */
  before?: unknown;
  /** the entry as it will be (undefined for removals) */
  after?: unknown;
  /**
   * sha256 of the target's content at render time (file content, or a dir
   * manifest hash; undefined if absent). The engine refuses to apply if the
   * target changed since — guarding against concurrent writers.
   */
  baseHash?: string;
  /** non-fatal translation/loss warnings */
  warnings?: string[];
}

/**
 * Implemented by write-capable adapters (config entries). `renderInstall`/
 * `renderRemove` are pure (read current file, return new content); `validate`
 * throws if a rendered file would not parse, so the engine verifies after write.
 */
export interface AgentWriter {
  renderInstall(spec: McpServerSpec, ref: CapabilityRef): Promise<RenderResult>;
  renderRemove(ref: CapabilityRef): Promise<RenderResult>;
  validate(content: string): void;
}

/** A skill to install: a source directory + the logical name to install it as. */
export interface SkillSource {
  name: string;
  /** directory to copy from (e.g. another agent's installed skill dir) */
  dir: string;
  meta?: { description?: string; version?: string };
}

/**
 * Implemented by adapters that can manage skills (directory-shaped). Renders a
 * dir-kind RenderResult; the engine performs the safe directory swap.
 */
export interface SkillWriter {
  renderInstallSkill(source: SkillSource, ref: CapabilityRef): Promise<RenderResult>;
  renderRemoveSkill(ref: CapabilityRef): Promise<RenderResult>;
}

/**
 * Implemented by adapters that can manage behavioral rules/instructions —
 * fleet-managed delimited blocks inside an always-on instruction file
 * (CLAUDE.md / AGENTS.md). Never overwrites human-authored content.
 */
export interface RuleWriter {
  renderInstallRule(body: string, ref: CapabilityRef): Promise<RenderResult>;
  renderRemoveRule(ref: CapabilityRef): Promise<RenderResult>;
}

/**
 * NOTE: there is intentionally NO PermissionWriter. Permissions are read-only in
 * fleet (surfaced in the inventory, never written or translated across agents) —
 * see PermissionCapability in types.ts. Do not add one without revisiting that
 * decision; mis-syncing permissions is the highest-blast-radius change possible.
 *
 * NOTE: there is also intentionally NO PluginWriter. Vendor plugin dirs are the
 * vendor CLI's own state — install/remove is DELEGATED to the vendor CLI
 * (docs/design-plugins.md Part B); never write those dirs directly.
 */
