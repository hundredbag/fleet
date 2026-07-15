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
import { copyDir, hashDir } from './fsutil.js';
import { sha256 } from './hash.js';
import { specHash } from './lock.js';

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

/** Injective + DETERMINISTIC ref id: a readable sanitized prefix plus a hash
 * of the raw (server, channel, key) tuple. The hash makes the mapping stable
 * under key reordering and collision-free across sanitize aliases ('foo-bar'
 * vs 'foo_bar', 'A-B' vs 'A_B') — an order-dependent counter could silently
 * bind an existing env value to the WRONG key. */
export function secretRefName(serverName: string, channel: string, key: string): string {
  const readable = `${serverName}_${channel}_${key}`.replace(/[^A-Za-z0-9_]/g, '_').toUpperCase();
  const digest = sha256(`${serverName}\u0000${channel}\u0000${key}`).slice(0, 6).toUpperCase();
  return `S_${readable}_${digest}`;
}

function toSecretRefs(spec: McpServerSpec, serverName: string): { spec: McpServerSpec; required: string[] } {
  const required: string[] = [];
  const clone: McpServerSpec = JSON.parse(JSON.stringify(spec));
  const mkRef = (channel: string, key: string): string => secretRefName(serverName, channel, key);
  const scrub = (obj: Record<string, string> | undefined, channel: string): void => {
    if (!obj) return;
    for (const k of Object.keys(obj)) {
      const refName = mkRef(channel, k);
      obj[k] = `\${secret:${refName}}`;
      required.push(refName);
    }
  };
  if (clone.transport === 'stdio') scrub(clone.env, 'ENV');
  else scrub(clone.headers, 'HDR');
  return { spec: clone, required };
}

/** Resolve ${secret:NAME} refs from the environment; returns missing names. */
export function resolveSecretRefs(
  spec: McpServerSpec,
  env: Record<string, string | undefined> = process.env,
  requiredSecrets?: string[],
): { spec: McpServerSpec; missing: string[] } {
  const missing: string[] = [];
  const declared = requiredSecrets ? new Set(requiredSecrets) : undefined;
  const clone: McpServerSpec = JSON.parse(JSON.stringify(spec));
  const fill = (obj: Record<string, string> | undefined): void => {
    if (!obj) return;
    for (const k of Object.keys(obj)) {
      const m = SECRET_REF.exec(obj[k] ?? '');
      if (!m) continue;
      // only refs DECLARED by this server resolve — a literal value that merely
      // looks like a ref (hand-edited profile) passes through untouched
      if (declared && !declared.has(m[1]!)) continue;
      const v = env[m[1]!];
      if (v === undefined) missing.push(m[1]!);
      else obj[k] = v;
    }
  };
  if (clone.transport === 'stdio') fill(clone.env);
  else fill(clone.headers);
  return { spec: clone, missing };
}

export interface ExportConflict {
  kind: string;
  name: string;
  agents: string[];
}

/** Export fleet-manageable capabilities into `dir`. Cross-agent dedupe keeps
 * only IDENTICAL definitions; divergent same-name definitions are EXCLUDED
 * and reported — silent first-wins would lose the other agent's config. */
export async function exportProfile(
  inv: Inventory,
  dir: string,
): Promise<{ profile: Profile; conflicts: ExportConflict[] }> {
  const conflicts: ExportConflict[] = [];

  const serverByName = new Map<string, McpServerCapability[]>();
  for (const i of inv.items) {
    if (i.kind !== 'mcp-server') continue;
    const cap = i as McpServerCapability;
    const list = serverByName.get(cap.name) ?? [];
    list.push(cap);
    serverByName.set(cap.name, list);
  }
  const servers: ProfileServer[] = [];
  for (const [name, caps] of serverByName) {
    // compare secret-SCRUBBED canonical shapes (values differ per machine)
    const shapes = new Set(caps.map((c) => specHash(toSecretRefs(c.spec, name).spec)));
    if (shapes.size > 1) {
      conflicts.push({ kind: 'mcp-server', name, agents: caps.map((c) => c.agent) });
      continue;
    }
    const { spec, required } = toSecretRefs(caps[0]!.spec, name);
    servers.push({ name, spec, requiredSecrets: required.sort() });
  }

  const ruleByName = new Map<string, RuleCapability[]>();
  for (const i of inv.items) {
    if (i.kind !== 'rule') continue;
    const r = i as RuleCapability;
    const list = ruleByName.get(r.name) ?? [];
    list.push(r);
    ruleByName.set(r.name, list);
  }
  const rules: { name: string; body: string }[] = [];
  for (const [name, rs] of ruleByName) {
    if (new Set(rs.map((r) => r.body)).size > 1) {
      conflicts.push({ kind: 'rule', name, agents: rs.map((r) => r.agent) });
      continue;
    }
    rules.push({ name, body: rs[0]!.body });
  }
  const skillByName = new Map<string, SkillCapability[]>();
  for (const i of inv.items) {
    if (i.kind !== 'skill') continue;
    const sk = i as SkillCapability;
    if (sk.name.includes('/')) continue; // flat names only in v1
    const list = skillByName.get(sk.name) ?? [];
    list.push(sk);
    skillByName.set(sk.name, list);
  }
  const skills: string[] = [];
  for (const [name, sks] of skillByName) {
    const hashes = new Set(await Promise.all(sks.map((sk) => hashDir(sk.path))));
    if (hashes.size > 1) {
      conflicts.push({ kind: 'skill', name, agents: sks.map((sk) => sk.agent) });
      continue;
    }
    await copyDir(sks[0]!.path, join(dir, 'skills', name));
    skills.push(name);
  }
  // deterministic output → clean git diffs
  servers.sort((a, b) => a.name.localeCompare(b.name));
  rules.sort((a, b) => a.name.localeCompare(b.name));
  skills.sort();
  const profile: Profile = { version: 1, exportedAt: new Date().toISOString(), servers, rules, skills };
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'profile.json'), JSON.stringify(profile, null, 2) + '\n', 'utf8');
  return { profile, conflicts };
}

const MAX_PROFILE_BYTES = 1024 * 1024;
const MAX_ITEMS = 200;

export async function readProfile(dir: string): Promise<Profile> {
  const p = join(dir, 'profile.json');
  if (!existsSync(p)) throw new Error(`fleet: no profile.json in ${dir}`);
  const raw = await readFile(p, 'utf8');
  if (Buffer.byteLength(raw, 'utf8') > MAX_PROFILE_BYTES) {
    throw new Error(`fleet: ${p} exceeds 1 MiB — refusing to parse`);
  }
  const doc = JSON.parse(raw);
  if (
    !doc ||
    doc.version !== 1 ||
    !Array.isArray(doc.servers) ||
    !Array.isArray(doc.rules) ||
    !Array.isArray(doc.skills)
  ) {
    throw new Error(`fleet: ${p} is not a valid fleet profile`);
  }
  if (doc.servers.length > MAX_ITEMS || doc.rules.length > MAX_ITEMS || doc.skills.length > MAX_ITEMS) {
    throw new Error(`fleet: ${p} lists more than ${MAX_ITEMS} items of one kind — refusing`);
  }
  return doc as Profile;
}
