import { existsSync } from 'node:fs';
import type { Inventory, SkillCapability } from './types.js';
import { readLock } from './lock.js';
import { hashDir } from './fsutil.js';

/**
 * Skill update detection from PROVENANCE (the mattpocock/skills #196 answer:
 * "how do installed skills get updated?"). fleet.lock pinned where each skill
 * came from (origin dir) and what bytes landed (contentHash) — so an update
 * is simply: the origin's content no longer matches what we installed.
 * Local-dir origins only for now; git origins arrive with clone support.
 */

export interface SkillUpdate {
  name: string;
  agent: string;
  originPath: string;
  /** 'update': clean reinstall. '+local-edits': reinstall overwrites edits.
   *  '+missing': installed copy is gone (reinstall restores). '+unverifiable':
   *  the agent's inventory didn't read — local state unknown, NOT clean. */
  state: 'update' | 'update+local-edits' | 'update+missing' | 'update+unverifiable';
  /** preview-first apply command (the trust gate rescans the CURRENT origin;
   * add --commit after reviewing) */
  applyHint: string;
}

export async function skillUpdatesFromLock(inv: Inventory, fleetHome?: string): Promise<SkillUpdate[]> {
  const lock = await readLock(fleetHome);
  const out: SkillUpdate[] = [];
  const brokenAgents = new Set(
    inv.agents
      .filter((a) => a.inventoryStatus === 'detect-failed' || a.inventoryStatus === 'read-failed')
      .map((a) => a.id),
  );
  const originHashMemo = new Map<string, string | undefined>(); // fan-out installs share origins
  for (const e of Object.values(lock.entries)) {
    if (e.kind !== 'skill' || e.origin.type !== 'dir' || !e.contentHash) continue;
    if (!existsSync(e.origin.path)) continue; // origin gone — nothing to compare
    let originNow = originHashMemo.get(e.origin.path);
    if (!originHashMemo.has(e.origin.path)) {
      try {
        originNow = await hashDir(e.origin.path);
      } catch {
        originNow = undefined; // unreadable/racing origin — skip THIS entry only
      }
      originHashMemo.set(e.origin.path, originNow);
    }
    if (originNow === undefined || originNow === '' || originNow === e.contentHash) continue;
    let state: SkillUpdate['state'];
    if (brokenAgents.has(e.agent)) {
      state = 'update+unverifiable'; // inventory didn't read — never call it clean
    } else {
      const live = inv.items.find(
        (i): i is SkillCapability =>
          i.kind === 'skill' &&
          i.name === e.name &&
          i.agent === e.agent &&
          (e.scope === undefined || i.scope === e.scope),
      );
      if (!live) state = 'update+missing';
      else {
        let liveHash: string | undefined;
        try {
          liveHash = await hashDir(live.path);
        } catch {
          liveHash = undefined;
        }
        state =
          liveHash === undefined
            ? 'update+unverifiable'
            : liveHash !== e.contentHash
              ? 'update+local-edits'
              : 'update';
      }
    }
    out.push({
      name: e.name,
      agent: e.agent,
      originPath: e.origin.path,
      state,
      applyHint: `fleet skill install ${e.name} --from-dir ${e.origin.path} --to ${e.agent}  (trust-rescans; add --commit to apply)`,
    });
  }
  return out;
}
