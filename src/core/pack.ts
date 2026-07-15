import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { listSkillDirs } from './skills.js';

/**
 * Packs — curated capability bundles installed through the existing engines
 * (trust gate, lock, rollback all apply per item). A pack is a DIRECTORY
 * (typically a git checkout, e.g. mattpocock/skills):
 *  - with a pack.json manifest: named skills + rules with SIZE VARIANTS
 *    (full/mini/nano — the agent-rules-books model nobody else can install), or
 *  - without one: every skill dir found is pack content (a plain skills
 *    monorepo checkout works as-is).
 * Rule names are namespaced '<pack>.<name>' so packs can't collide with the
 * user's own rules (the /sc: prefix lesson from SuperClaude).
 */

export type RuleVariant = 'full' | 'mini' | 'nano';

export interface PackRule {
  name: string;
  /** variant → file path relative to the pack dir */
  variants: Partial<Record<RuleVariant, string>>;
}

export interface Pack {
  name: string;
  description?: string;
  /** skill dir names relative to the pack dir */
  skills: string[];
  rules: PackRule[];
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Read a pack from a directory: manifest if present, else scan for skills. */
export async function readPack(dir: string): Promise<Pack> {
  const manifestPath = join(dir, 'pack.json');
  if (existsSync(manifestPath)) {
    const doc = JSON.parse(await readFile(manifestPath, 'utf8'));
    if (!isRecord(doc) || typeof doc.name !== 'string' || !doc.name) {
      throw new Error(`fleet: ${manifestPath} is not a valid pack manifest (needs "name")`);
    }
    const skills = Array.isArray(doc.skills)
      ? doc.skills.filter((s): s is string => typeof s === 'string')
      : [];
    const rules: PackRule[] = [];
    if (Array.isArray(doc.rules)) {
      for (const r of doc.rules) {
        if (!isRecord(r) || typeof r.name !== 'string' || !isRecord(r.variants)) continue;
        const variants: PackRule['variants'] = {};
        for (const v of ['full', 'mini', 'nano'] as const) {
          if (typeof r.variants[v] === 'string') variants[v] = r.variants[v] as string;
        }
        rules.push({ name: r.name, variants });
      }
    }
    return {
      name: doc.name,
      description: typeof doc.description === 'string' ? doc.description : undefined,
      skills,
      rules,
    };
  }
  // manifest-less: a skills monorepo checkout — every skill dir is content
  const dirs = await listSkillDirs(dir);
  return {
    name: dir.split('/').filter(Boolean).pop() ?? 'pack',
    skills: dirs.map((d) => d.name),
    rules: [],
  };
}

/** Resolve a rule's body for the requested variant (closest smaller fallback). */
export async function readPackRuleBody(
  dir: string,
  rule: PackRule,
  variant: RuleVariant,
): Promise<{ body: string; usedVariant: RuleVariant }> {
  const order: RuleVariant[] =
    variant === 'nano'
      ? ['nano', 'mini', 'full']
      : variant === 'mini'
        ? ['mini', 'nano', 'full']
        : ['full', 'mini', 'nano'];
  for (const v of order) {
    const rel = rule.variants[v];
    if (!rel) continue;
    const p = join(dir, rel);
    if (!existsSync(p)) continue;
    return { body: await readFile(p, 'utf8'), usedVariant: v };
  }
  throw new Error(`fleet: pack rule "${rule.name}" has no readable variant file`);
}
