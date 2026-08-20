import { constants, existsSync } from 'node:fs';
import { writeFile, mkdir, rm, realpath, rename, lstat, open } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import type {
  Inventory,
  McpServerCapability,
  McpServerSpec,
  RuleCapability,
  SkillCapability,
} from './types.js';
import { copyDir, hashDir, hashMaterializedDir, safeJoin } from './fsutil.js';
import { sha256 } from './hash.js';
import { specHash } from './lock.js';
import { isPublicCapabilityName } from './redact.js';

/**
 * Portable profile export/import — the "sync ~/.claude across machines" the
 * community keeps filing issues for, done fleet's way:
 *  - GIT-BACKED, not cloud: export writes a deterministic directory the user
 *    commits to their own dotfiles repo; import PLANS through the normal
 *    dry-run→commit pipeline (trust gate included) — never last-writer-wins.
 *  - STRUCTURED SECRET REFS: MCP env/header VALUES are never written. Each
 *    becomes a ${secret:NAME} reference; import resolves from the target
 *    machine's environment. This is not a general credential scanner: URLs,
 *    command args, rule bodies, and skill files must still be reviewed.
 */

export interface ProfileServer {
  name: string;
  spec: McpServerSpec; // env/header values replaced by ${secret:...} refs
  /** env var names the target machine must provide */
  requiredSecrets: string[];
}

export interface Profile {
  version: 1;
  servers: ProfileServer[];
  rules: { name: string; body: string }[];
  /** safe flat or grouped relative names copied under <profile>/skills/ */
  skills: string[];
}

const SECRET_REF = /^\$\{secret:([A-Za-z_][A-Za-z0-9_]*)\}$/;

/** Deterministic, collision-resistant ref id over the raw
 * (server, channel, key) tuple. The readable portion is only a hint; the full
 * SHA-256 digest supplies the identity across sanitize aliases ('foo-bar' vs
 * 'foo_bar'). A short digest can silently bind one service's credential to a
 * different service, so it must never be truncated. */
export function secretRefName(serverName: string, channel: string, key: string): string {
  const readable = `${serverName}_${channel}_${key}`
    .replace(/[^A-Za-z0-9_]/g, '_')
    .toUpperCase()
    .slice(0, 40);
  const digest = sha256(`${serverName}\u0000${channel}\u0000${key}`).toUpperCase();
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
      const name = m[1]!;
      const v = Object.prototype.hasOwnProperty.call(env, name) ? env[name] : undefined;
      if (typeof v !== 'string') missing.push(name);
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

export interface ExportProfileResult {
  profile: Profile;
  conflicts: ExportConflict[];
  /** The new generation is installed, but non-authoritative cleanup needs
   * local attention. Never use warnings to conceal a failed publication. */
  warnings: string[];
}

function pathWithin(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..');
}

/** Export materializes a symlink-root skill directory while preserving links
 * inside it. Hash the same physical root mode that copyDir will materialize. */
async function profileSkillHash(path: string): Promise<string> {
  return hashMaterializedDir(path);
}

async function writeProfileAtomic(path: string, content: string): Promise<void> {
  const tmp = `${path}.tmp-${process.pid}-${randomUUID()}`;
  try {
    await writeFile(tmp, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
    await rename(tmp, path);
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
}

/** Export fleet-manageable capabilities into `dir`. Cross-agent dedupe keeps
 * only IDENTICAL definitions; divergent same-name definitions are EXCLUDED
 * and reported — silent first-wins would lose the other agent's config. */
export async function exportProfile(inv: Inventory, dir: string): Promise<ExportProfileResult> {
  const conflicts: ExportConflict[] = [];
  const warnings: string[] = [];

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
    const list = skillByName.get(sk.name) ?? [];
    list.push(sk);
    skillByName.set(sk.name, list);
  }
  const skills: string[] = [];
  const skillSources = new Map<string, string>();
  for (const [name, sks] of skillByName) {
    const hashes = new Set(await Promise.all(sks.map((sk) => profileSkillHash(sk.path))));
    if (hashes.size > 1) {
      conflicts.push({ kind: 'skill', name, agents: sks.map((sk) => sk.agent) });
      continue;
    }
    skills.push(name);
    skillSources.set(name, sks[0]!.path);
  }
  // deterministic output → clean git diffs
  servers.sort((a, b) => a.name.localeCompare(b.name));
  rules.sort((a, b) => a.name.localeCompare(b.name));
  skills.sort();
  // no timestamp field: an unchanged re-export must be a zero-diff for git
  const profile: Profile = { version: 1, servers, rules, skills };
  const targetRoot = resolve(dir);
  const parent = dirname(targetRoot);
  const targetName = basename(targetRoot);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const targetInitiallyExists = existsSync(targetRoot);
  const initialRootInfo = targetInitiallyExists ? await lstat(targetRoot) : undefined;
  if (initialRootInfo) {
    const rootInfo = initialRootInfo;
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
      throw new Error('fleet: profile export target must be a regular directory');
    }
    if (existsSync(join(targetRoot, '.git'))) {
      throw new Error(
        'fleet: profile export target must be a dedicated directory inside the dotfiles repository, not the repository root',
      );
    }
  }

  // Resolve every destination and source before the first delete/copy. No
  // managed component below the chosen export root may be a symlink, and the
  // export root may not be nested inside a skill source.
  safeJoin(targetRoot, 'profile.json');
  safeJoin(targetRoot, 'skills');
  const physicalRoot = existsSync(targetRoot)
    ? await realpath(targetRoot)
    : join(await realpath(parent), targetName);
  const copies: Array<{ source: string; name: string; hash: string }> = [];
  for (const name of skills) {
    const source = skillSources.get(name)!;
    const physicalSource = await realpath(source);
    // A source already below an existing profile root is safe: the complete
    // staged generation is copied before the root is detached, which supports
    // zero-diff re-export from a profile-backed installed skill. The inverse
    // (placing the target inside a source) can recursively copy the stage into
    // itself and is always refused.
    if (pathWithin(physicalRoot, physicalSource)) {
      throw new Error(`fleet: refusing profile destination inside skill source for "${name}"`);
    }
    copies.push({ source, name, hash: await hashDir(physicalSource) });
  }

  // Build and validate one complete generation beside the target, then swap
  // it into place. A later copy/read failure cannot mix new skills with an old
  // manifest. The lock also makes concurrent exports fail closed.
  const lockPath = join(parent, `.${targetName}.fleet-export.lock`);
  const stage = join(parent, `.${targetName}.fleet-stage-${randomUUID()}`);
  const backup = join(parent, `.${targetName}.fleet-old-${randomUUID()}`);
  let lock;
  let detached = false;
  try {
    lock = await open(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error('fleet: another profile export is already in progress');
    }
    throw error;
  }
  try {
    const initialTargetHash = targetInitiallyExists ? await hashDir(targetRoot) : undefined;
    if (targetInitiallyExists) {
      await copyDir(targetRoot, stage);
      if ((await hashDir(stage)) !== initialTargetHash) {
        throw new Error('fleet: profile export target changed while staging; re-run export');
      }
    } else await mkdir(stage, { mode: 0o700 });
    await rm(safeJoin(stage, 'profile.json'), { force: true });
    await rm(safeJoin(stage, 'skills'), { recursive: true, force: true });
    await mkdir(safeJoin(stage, 'skills'), { mode: 0o700 });
    for (const { source, name, hash } of copies) {
      const destination = safeJoin(stage, join('skills', name));
      await copyDir(source, destination);
      if ((await hashDir(destination)) !== hash) {
        throw new Error(`fleet: skill source "${name}" changed during profile export`);
      }
    }
    await writeProfileAtomic(safeJoin(stage, 'profile.json'), JSON.stringify(profile, null, 2) + '\n');
    await readProfile(stage);

    const targetStillExists = existsSync(targetRoot);
    if (targetStillExists !== targetInitiallyExists) {
      throw new Error('fleet: profile export target topology changed while staging; re-run export');
    }
    if (targetInitiallyExists) {
      const finalRootInfo = await lstat(targetRoot);
      if (
        finalRootInfo.dev !== initialRootInfo!.dev ||
        finalRootInfo.ino !== initialRootInfo!.ino ||
        (await hashDir(targetRoot)) !== initialTargetHash
      ) {
        throw new Error('fleet: profile export target changed while staging; re-run export');
      }
      await rename(targetRoot, backup);
      detached = true;
    }
    try {
      await rename(stage, targetRoot);
    } catch (error) {
      if (detached) {
        await rename(backup, targetRoot);
        detached = false;
      }
      throw error;
    }
    if (detached) {
      try {
        await rm(backup, { recursive: true, force: true });
      } catch {
        warnings.push(`old profile generation cleanup failed at ${backup}`);
      }
      detached = false;
    }
  } finally {
    await rm(stage, { recursive: true, force: true }).catch(() => {});
    if (detached && !existsSync(targetRoot)) {
      await rename(backup, targetRoot).catch(() => {});
    }
    await lock.close().catch(() => {});
    await rm(lockPath, { force: true }).catch(() => {});
  }
  return { profile, conflicts, warnings };
}

const MAX_PROFILE_BYTES = 1024 * 1024;
const MAX_ITEMS = 200;
const PROFILE_SKILL_SEGMENT = /^[A-Za-z0-9][\w.-]*$/;
const PROFILE_RULE_NAME = /^[A-Za-z0-9][\w.-]*$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  const keys = new Set(allowed);
  return Object.keys(value).every((key) => keys.has(key));
}

function stringMap(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');
}

function validProfileSkillName(value: unknown): value is string {
  return (
    isPublicCapabilityName(value) && value.split('/').every((segment) => PROFILE_SKILL_SEGMENT.test(segment))
  );
}

function validMcpSpec(value: unknown): value is McpServerSpec {
  if (!isRecord(value)) return false;
  if (value.transport === 'stdio') {
    return (
      onlyKeys(value, ['transport', 'command', 'args', 'env']) &&
      typeof value.command === 'string' &&
      value.command.length > 0 &&
      (value.args === undefined ||
        (Array.isArray(value.args) && value.args.every((arg) => typeof arg === 'string'))) &&
      (value.env === undefined || stringMap(value.env))
    );
  }
  if (value.transport === 'http' || value.transport === 'sse' || value.transport === 'ws') {
    return (
      onlyKeys(value, ['transport', 'url', 'headers', 'bearerTokenEnvVar']) &&
      typeof value.url === 'string' &&
      value.url.length > 0 &&
      (value.headers === undefined || stringMap(value.headers)) &&
      (value.bearerTokenEnvVar === undefined ||
        (typeof value.bearerTokenEnvVar === 'string' && ENV_NAME.test(value.bearerTokenEnvVar)))
    );
  }
  return false;
}

function validateSecretDeclaration(server: ProfileServer, path: string): void {
  const declared = new Set(server.requiredSecrets);
  if (
    declared.size !== server.requiredSecrets.length ||
    !server.requiredSecrets.every((name) => ENV_NAME.test(name))
  ) {
    throw new Error(`fleet: ${path} has invalid or duplicate requiredSecrets for "${server.name}"`);
  }
  const values =
    server.spec.transport === 'stdio'
      ? Object.values(server.spec.env ?? {})
      : Object.values(server.spec.headers ?? {});
  const referenced = new Set<string>();
  for (const value of values) {
    const match = SECRET_REF.exec(value);
    // Profile env/header values are deliberately reference-only. Allowing a
    // hand-written literal here would defeat the export contract and make a
    // credential look safe to commit merely because the JSON shape validates.
    if (!match) {
      throw new Error(`fleet: ${path} has a literal or malformed secret value for "${server.name}"`);
    }
    referenced.add(match[1]!);
  }
  if (
    referenced.size !== declared.size ||
    [...referenced].some((name) => !declared.has(name)) ||
    [...declared].some((name) => !referenced.has(name))
  ) {
    throw new Error(`fleet: ${path} secret declarations do not match references for "${server.name}"`);
  }
}

export async function readProfile(dir: string): Promise<Profile> {
  const p = safeJoin(dir, 'profile.json');
  let handle;
  try {
    handle = await open(p, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error(`fleet: no profile.json in ${dir}`);
    }
    throw new Error(`fleet: profile.json must be a readable regular file`, { cause: error });
  }
  let bytes: Buffer;
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error('not a regular file');
    bytes = await handle.readFile();
  } catch (error) {
    throw new Error(`fleet: profile.json must be a readable regular file`, { cause: error });
  } finally {
    await handle.close();
  }
  if (bytes.byteLength > MAX_PROFILE_BYTES) {
    throw new Error(`fleet: ${p} exceeds 1 MiB — refusing to parse`);
  }
  const raw = bytes.toString('utf8');
  const doc: unknown = JSON.parse(raw);
  if (
    !isRecord(doc) ||
    !onlyKeys(doc, ['version', 'servers', 'rules', 'skills']) ||
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
  const serverNames = new Set<string>();
  for (const srv of doc.servers) {
    if (
      !isRecord(srv) ||
      !onlyKeys(srv, ['name', 'spec', 'requiredSecrets']) ||
      typeof srv.name !== 'string' ||
      !isPublicCapabilityName(srv.name) ||
      !validMcpSpec(srv.spec) ||
      !Array.isArray(srv.requiredSecrets) ||
      !srv.requiredSecrets.every((name) => typeof name === 'string') ||
      serverNames.has(srv.name)
    ) {
      throw new Error(
        `fleet: ${p} has a malformed or duplicate server entry${typeof srv?.name === 'string' ? ` ("${srv.name}")` : ''}`,
      );
    }
    serverNames.add(srv.name);
    validateSecretDeclaration(srv as unknown as ProfileServer, p);
  }
  const ruleNames = new Set<string>();
  for (const rule of doc.rules) {
    if (
      !isRecord(rule) ||
      !onlyKeys(rule, ['name', 'body']) ||
      typeof rule.name !== 'string' ||
      !PROFILE_RULE_NAME.test(rule.name) ||
      typeof rule.body !== 'string' ||
      rule.body.trim().length === 0 ||
      ruleNames.has(rule.name)
    ) {
      throw new Error(`fleet: ${p} has a malformed or duplicate rule entry`);
    }
    ruleNames.add(rule.name);
  }
  const skillNames = new Set<string>();
  for (const name of doc.skills) {
    if (
      !validProfileSkillName(name) ||
      skillNames.has(name) ||
      [...skillNames].some((existing) => name.startsWith(`${existing}/`) || existing.startsWith(`${name}/`))
    ) {
      throw new Error(`fleet: ${p} has an unsafe or duplicate skill name`);
    }
    skillNames.add(name);
    const source = safeJoin(dir, join('skills', name));
    if (!(await lstat(source)).isDirectory()) {
      throw new Error(`fleet: profile skill "${name}" is not a contained directory`);
    }
  }
  return {
    version: 1,
    servers: doc.servers as ProfileServer[],
    rules: doc.rules as Profile['rules'],
    skills: doc.skills as string[],
  };
}
