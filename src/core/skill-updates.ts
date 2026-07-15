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
  /** where the skill was installed from */
  originPath: string;
  /** 'update': origin changed, local copy untouched → clean reinstall.
   *  'update+local-edits': origin changed AND the installed copy was edited —
   *  reinstalling would overwrite local changes; the user must choose. */
  state: 'update' | 'update+local-edits';
  /** exact command to apply it */
  applyHint: string;
}

export async function skillUpdatesFromLock(inv: Inventory, fleetHome?: string): Promise<SkillUpdate[]> {
  const lock = await readLock(fleetHome);
  const out: SkillUpdate[] = [];
  for (const e of Object.values(lock.entries)) {
    if (e.kind !== 'skill' || e.origin.type !== 'dir' || !e.contentHash) continue;
    if (!existsSync(e.origin.path)) continue; // origin gone — nothing to compare
    const originNow = await hashDir(e.origin.path);
    if (originNow === '' || originNow === e.contentHash) continue; // unchanged (or unreadable)
    const live = inv.items.find(
      (i): i is SkillCapability => i.kind === 'skill' && i.name === e.name && i.agent === e.agent,
    );
    const liveHash = live ? await hashDir(live.path) : undefined;
    const locallyEdited = liveHash !== undefined && liveHash !== e.contentHash;
    out.push({
      name: e.name,
      agent: e.agent,
      originPath: e.origin.path,
      state: locallyEdited ? 'update+local-edits' : 'update',
      applyHint: `fleet skill install ${e.name} --from-dir ${e.origin.path} --to ${e.agent} --commit`,
    });
  }
  return out;
}
