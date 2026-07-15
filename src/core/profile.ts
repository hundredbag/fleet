import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  Inventory,
  McpServerCapability,
  McpServerSpec,
  RuleCapability,
  SkillCapability,
} from './types.js';
import { copyDir } from './fsutil.js';

/**
 * Portable profile export/import — the "sync ~/.claude across machines" the
 * community keeps filing issues for, done fleet's way:
 *  - GIT-BACKED, not cloud: export writes a deterministic directory the user
 *    commits to their own dotfiles repo; import PLANS through the normal
 *    dry-run→commit pipeline (trust gate included) — never last-writer-wins.
 *  - SECRET-SAFE: MCP env/header VALUES are never written. Each becomes a
 *    ${secret:NAME} reference; import resolves from the target machine's
 *    environment and refuses (per server, with the exact missing names)
 *    rather than installing half-configured secrets.
 */

export interface ProfileServer {
  name: string;
  spec: McpServerSpec; // env/header values replaced by ${secret:...} refs
  /** env var names the target machine must provide */
  requiredSecrets: string[];
}

export interface Profile {
  version: 1;
  exportedAt: string;
  servers: ProfileServer[];
  rules: { name: string; body: string }[];
  /** skill dir names copied under <profile>/skills/ */
  skills: string[];
}

const SECRET_REF = /^\$\{secret:([A-Za-z_][A-Za-z0-9_]*)\}$/;

function toSecretRefs(spec: McpServerSpec): { spec: McpServerSpec; required: string[] } {
  const required: string[] = [];
  const clone: McpServerSpec = JSON.parse(JSON.stringify(spec));
  const scrub = (obj: Record<string, string> | undefined, prefix: string): void => {
    if (!obj) return;
    for (const k of Object.keys(obj)) {
      const refName = `${prefix}${k}`.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
      obj[k] = `\${secret:${refName}}`;
      required.push(refName);
    }
  };
  if (clone.transport === 'stdio') scrub(clone.env, '');
  else scrub(clone.headers, 'HDR_');
  return { spec: clone, required };
}

/** Resolve ${secret:NAME} refs from the environment; returns missing names. */
export function resolveSecretRefs(
  spec: McpServerSpec,
  env: Record<string, string | undefined> = process.env,
): { spec: McpServerSpec; missing: string[] } {
  const missing: string[] = [];
  const clone: McpServerSpec = JSON.parse(JSON.stringify(spec));
  const fill = (obj: Record<string, string> | undefined): void => {
    if (!obj) return;
    for (const k of Object.keys(obj)) {
      const m = SECRET_REF.exec(obj[k] ?? '');
      if (!m) continue;
      const v = env[m[1]!];
      if (v === undefined) missing.push(m[1]!);
      else obj[k] = v;
    }
  };
  if (clone.transport === 'stdio') fill(clone.env);
  else fill(clone.headers);
  return { spec: clone, missing };
}

/** Export fleet-manageable capabilities of ONE agent's view into `dir`. */
export async function exportProfile(inv: Inventory, dir: string): Promise<Profile> {
  const seenServer = new Set<string>();
  const servers: ProfileServer[] = [];
  for (const i of inv.items) {
    if (i.kind !== 'mcp-server') continue;
    const cap = i as McpServerCapability;
    if (seenServer.has(cap.name)) continue; // one entry per name (cross-agent dedupe)
    seenServer.add(cap.name);
    const { spec, required } = toSecretRefs(cap.spec);
    servers.push({ name: cap.name, spec, requiredSecrets: required.sort() });
  }
  const seenRule = new Set<string>();
  const rules: { name: string; body: string }[] = [];
  for (const i of inv.items) {
    if (i.kind !== 'rule') continue;
    const r = i as RuleCapability;
    if (seenRule.has(r.name)) continue;
    seenRule.add(r.name);
    rules.push({ name: r.name, body: r.body });
  }
  const seenSkill = new Set<string>();
  const skills: string[] = [];
  for (const i of inv.items) {
    if (i.kind !== 'skill') continue;
    const sk = i as SkillCapability;
    if (seenSkill.has(sk.name) || sk.name.includes('/')) continue; // flat names only in v1
    seenSkill.add(sk.name);
    await copyDir(sk.path, join(dir, 'skills', sk.name));
    skills.push(sk.name);
  }
  // deterministic output → clean git diffs
  servers.sort((a, b) => a.name.localeCompare(b.name));
  rules.sort((a, b) => a.name.localeCompare(b.name));
  skills.sort();
  const profile: Profile = { version: 1, exportedAt: new Date().toISOString(), servers, rules, skills };
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'profile.json'), JSON.stringify(profile, null, 2) + '\n', 'utf8');
  return profile;
}

export async function readProfile(dir: string): Promise<Profile> {
  const p = join(dir, 'profile.json');
  if (!existsSync(p)) throw new Error(`fleet: no profile.json in ${dir}`);
  const doc = JSON.parse(await readFile(p, 'utf8'));
  if (
    !doc ||
    doc.version !== 1 ||
    !Array.isArray(doc.servers) ||
    !Array.isArray(doc.rules) ||
    !Array.isArray(doc.skills)
  ) {
    throw new Error(`fleet: ${p} is not a valid fleet profile`);
  }
  return doc as Profile;
}
