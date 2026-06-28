import type {
  DetectedAgent,
  InstalledCapability,
  McpServerSpec,
  Scope,
} from './types.js';

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
  kind: 'mcp-server';
  name: string;
  scope: Scope;
}

/**
 * The result of rendering a mutation — a full proposed file, produced WITHOUT
 * touching disk. The engine turns this into a safe write.
 */
export interface RenderResult {
  /** path the engine should write */
  file: string;
  /** full proposed file content (preserving everything unrelated verbatim) */
  newContent: string;
  /** the entry as it was, for the diff view */
  before?: unknown;
  /** the entry as it will be (undefined for removals) */
  after?: unknown;
  /**
   * sha256 of the file content at render time (undefined if the file did not
   * exist). The engine refuses to apply if the file changed since — guarding
   * the hot `~/.claude.json` against concurrent writers clobbering each other.
   */
  baseHash?: string;
  /** non-fatal translation/loss warnings */
  warnings?: string[];
}

/**
 * Implemented by write-capable adapters. `renderInstall`/`renderRemove` are
 * pure (read current file, return new content); `validate` throws if a rendered
 * file would not parse, so the engine can verify after writing.
 */
export interface AgentWriter {
  renderInstall(spec: McpServerSpec, ref: CapabilityRef): Promise<RenderResult>;
  renderRemove(ref: CapabilityRef): Promise<RenderResult>;
  validate(content: string): void;
}
