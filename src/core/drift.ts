import type { Inventory, McpServerCapability, RuleCapability, SkillCapability } from './types.js';
import { readLock, specHash, lockKey, type LockEntry } from './lock.js';
import { hashDir } from './fsutil.js';
import { lstat, readlink } from 'node:fs/promises';
import { sha256 } from './hash.js';

/**
 * Drift/tamper detection: diff LIVE agent state against fleet.lock's recorded
 * contentHash. This is the SANDWORM_MODE countermeasure from the 2026-07
 * research — that attack injected rogue MCP entries into exactly the config
 * files fleet snapshots. Three verdicts per lock entry:
 *  - intact:    live content matches what fleet installed
 *  - modified:  present but different bytes/spec (edited outside fleet — or
 *               tampered)
 *  - missing:   fleet installed it, nothing is there now
 * Plus the reverse view: 'unmanaged' capabilities present on an agent with no
 * lock entry (informational — fleet didn't put them there; a rogue injection
 * ALSO looks like this, so surfacing them matters).
 */

export type DriftState = 'intact' | 'modified' | 'missing' | 'unverifiable';

export interface DriftFinding {
  kind: string;
  name: string;
  agent: string;
  state: DriftState;
  detail?: string;
}

export interface DriftReport {
  checked: number;
  findings: DriftFinding[]; // non-intact only
  /** capabilities live on agents but absent from the lock (fleet didn't install them) */
  unmanaged: { kind: string; name: string; agent: string; scope?: string }[];
}

function liveItemFor(inv: Inventory, e: LockEntry) {
  // scope is identity (legacy scope-less entries match any scope — better a
  // loose match than a false 'missing')
  return inv.items.find(
    (i) =>
      i.kind === e.kind &&
      i.name === e.name &&
      i.agent === e.agent &&
      (e.scope === undefined || i.scope === e.scope),
  );
}

async function currentHash(item: Inventory['items'][number]): Promise<string | undefined> {
  switch (item.kind) {
    case 'skill': {
      // a skill DIR silently replaced by a symlink must not read intact —
      // hashDir follows the link and would match the target's bytes
      const p = (item as SkillCapability).path;
      try {
        if ((await lstat(p)).isSymbolicLink()) {
          return sha256('symlink:' + (await readlink(p)));
        }
      } catch {
        /* fall through to hashDir (absent handled by caller) */
      }
      return hashDir(p);
    }
    case 'mcp-server':
      return specHash((item as McpServerCapability).spec);
    case 'rule':
      return specHash((item as RuleCapability).body);
    default:
      return undefined; // plugins: vendor-owned bytes — presence check only
  }
}

/**
 * Compare fleet.lock against a live inventory snapshot. Read-only; callers
 * bring their own inventory (one buildInventory serves doctor + drift + faces).
 */
export async function detectDrift(inv: Inventory, fleetHome?: string): Promise<DriftReport> {
  const lock = await readLock(fleetHome);
  const entries = Object.values(lock.entries);
  const findings: DriftFinding[] = [];

  const brokenAgents = new Map(inv.agents.filter((a) => a.note).map((a) => [a.id, a.note as string]));

  for (const e of entries) {
    if (brokenAgents.has(e.agent)) {
      // the agent's config didn't read — EVERYTHING would look missing; say why
      findings.push({
        kind: e.kind,
        name: e.name,
        agent: e.agent,
        state: 'unverifiable',
        detail: `agent inventory unavailable: ${brokenAgents.get(e.agent)}`,
      });
      continue;
    }
    const live = liveItemFor(inv, e);
    if (!live) {
      findings.push({
        kind: e.kind,
        name: e.name,
        agent: e.agent,
        state: 'missing',
        detail: 'fleet installed this; it is no longer on the agent',
      });
      continue;
    }
    if (!e.contentHash) {
      // plugins: presence is all we can verify
      continue;
    }
    if (e.hashScheme !== 'canonical-v1') {
      // pre-canonical entries hashed the native rendering — comparing against
      // the normalized live spec would be a GUARANTEED false 'modified'
      findings.push({
        kind: e.kind,
        name: e.name,
        agent: e.agent,
        state: 'unverifiable',
        detail: 'entry predates canonical hashing — reinstall via fleet to re-baseline',
      });
      continue;
    }
    const now = await currentHash(live);
    if (now === undefined) {
      findings.push({ kind: e.kind, name: e.name, agent: e.agent, state: 'unverifiable' });
    } else if (now !== e.contentHash) {
      findings.push({
        kind: e.kind,
        name: e.name,
        agent: e.agent,
        state: 'modified',
        detail: 'content differs from what fleet installed (edited outside fleet — or tampered)',
      });
    }
  }

  // reverse view: live capabilities fleet never installed. Rules/permissions
  // are usually hand-authored — restrict to the kinds attackers inject.
  // Scope is identity: a user-scope lock entry must NOT mask a same-name
  // project-scope rogue (the SANDWORM shape). Legacy scope-less entries claim
  // all scopes of that name so old installs aren't re-flagged.
  const keyed = new Set(entries.map((e) => lockKey(e.kind, e.name, e.agent, e.scope ?? '*')));
  const claimsAny = (i: { kind: string; name: string; agent: string }) =>
    keyed.has(lockKey(i.kind, i.name, i.agent, '*'));
  const unmanaged = inv.items
    .filter(
      (i) => i.kind === 'mcp-server' || i.kind === 'plugin' || i.kind === 'skill' || i.kind === 'subagent',
    ) // skills: injection surface too (noise accepted)
    .filter((i) => !keyed.has(lockKey(i.kind, i.name, i.agent, i.scope)) && !claimsAny(i))
    .map((i) => ({ kind: i.kind, name: i.name, agent: i.agent, scope: i.scope }));

  return { checked: entries.length, findings, unmanaged };
}
