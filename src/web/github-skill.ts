import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, posix } from 'node:path';
import { createHash } from 'node:crypto';
import type { SkillSource } from '../core/adapter.js';
import { FleetOperationError } from '../core/errors.js';
import type { CapabilityOrigin } from '../core/lock.js';
import { safeJoin } from '../core/fsutil.js';
import { parseSkillFrontmatter } from '../core/skills.js';
import { containsNonPublicControl } from '../core/redact.js';
import { parseFrontmatterScalar } from '../core/frontmatter.js';

const SEGMENT = /^[A-Za-z0-9](?:[A-Za-z0-9_.-]{0,118}[A-Za-z0-9])?$/;
const COMMIT = /^[0-9a-f]{40}$/i;
const MAX_TREE_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 10 * 1024 * 1024;
const MAX_FILES = 128;
const MAX_SKILL_CANDIDATES = 128;
const MAX_DEPTH = 16;
const DEFAULT_SKILL_CONTAINER_DEPTH = 3;

// Kept in upstream order so tree discovery mirrors the skills CLI before
// Fleet applies its stricter single-candidate identity checks.
const SKILL_PRIORITY_PREFIXES = [
  '',
  'skills/',
  'skills/.curated/',
  'skills/.experimental/',
  'skills/.system/',
  '.agents/skills/',
  '.claude/skills/',
  '.cline/skills/',
  '.codebuddy/skills/',
  '.codex/skills/',
  '.commandcode/skills/',
  '.continue/skills/',
  '.github/skills/',
  '.goose/skills/',
  '.grok/skills/',
  '.iflow/skills/',
  '.junie/skills/',
  '.kilocode/skills/',
  '.kimchi/skills/',
  '.kiro/skills/',
  '.minimax/skills/',
  '.mux/skills/',
  '.neovate/skills/',
  '.opencode/skills/',
  '.openhands/skills/',
  '.pi/skills/',
  '.posit/assistant/skills/',
  '.qoder/skills/',
  '.roo/skills/',
  '.trae/skills/',
  '.windsurf/skills/',
  '.zcode/skills/',
  '.zencoder/skills/',
] as const;
const SKILL_DISCOVERY_SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__']);
const ROOT_SKILL_AUXILIARY_DIRS = new Set(['scripts', 'references', 'assets']);
const ROOT_SKILL_METADATA_FILE =
  /^(?:(?:README|LICENSE)(?:\.[A-Za-z0-9_-]+)?|(?:CHANGELOG|CONTRIBUTING|SECURITY)\.md|\.gitignore)$/i;

export interface GitHubSkillCoordinate {
  provider: 'github';
  repository: string;
  skill: string;
}

export interface GitHubSkillLease {
  source: SkillSource;
  sourceRoot: string;
  origin: Extract<CapabilityOrigin, { type: 'github' }>;
  dispose(): Promise<void>;
}

export type SkillMaterializer = (coordinate: GitHubSkillCoordinate) => Promise<GitHubSkillLease>;

/** A materialization failed after creating private staging, and that staging
 * could not be removed. Callers must stop admitting further materializations. */
export class GitHubSkillCleanupError extends Error {
  override name = 'GitHubSkillCleanupError';

  constructor() {
    super('remote skill staging cleanup failed; recovery is pending');
  }
}

interface GitHubTreeEntry {
  path?: unknown;
  mode?: unknown;
  type?: unknown;
  size?: unknown;
  sha?: unknown;
}

interface ParsedGitHubTreeEntry {
  path: string;
  mode: unknown;
  type: unknown;
  size: unknown;
  sha: unknown;
}

type DownloadableTreeEntry = ParsedGitHubTreeEntry & {
  mode: '100644' | '100755';
  type: 'blob';
  size: number;
  sha: string;
};

interface MaterializeOptions {
  fetchImpl?: typeof fetch;
  apiBaseUrl?: string;
  rawBaseUrl?: string;
  timeoutMs?: number;
  tempBaseDir?: string;
  removeImpl?: (path: string, options: { recursive: true; force: true }) => Promise<void>;
}

function invalid(message: string): never {
  throw new FleetOperationError('INVALID_ARGUMENT', message);
}

function sourceUnavailable(message: string): never {
  throw new FleetOperationError('SOURCE_UNAVAILABLE', message);
}

function sourceRejected(message: string): never {
  throw new FleetOperationError('REQUEST_REJECTED', message);
}

export function parseGitHubSkillIdentifier(identifier: unknown): GitHubSkillCoordinate | null {
  if (typeof identifier !== 'string' || identifier.length === 0 || identifier.length > 360) return null;
  const parts = identifier.split('/');
  if (parts.length !== 3 || parts.some((part) => !SEGMENT.test(part) || part.includes('..'))) {
    return null;
  }
  const [owner, repo, skill] = parts as [string, string, string];
  return { provider: 'github', repository: `${owner}/${repo}`, skill };
}

export function assertGitHubSkillCoordinate(value: unknown): asserts value is GitHubSkillCoordinate {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('invalid GitHub skill coordinate');
  const coordinate = value as Record<string, unknown>;
  if (
    Object.keys(coordinate).some((key) => !['provider', 'repository', 'skill'].includes(key)) ||
    coordinate.provider !== 'github' ||
    typeof coordinate.repository !== 'string' ||
    typeof coordinate.skill !== 'string' ||
    !parseGitHubSkillIdentifier(`${coordinate.repository}/${coordinate.skill}`)
  ) {
    invalid('invalid GitHub skill coordinate');
  }
}

async function boundedBytes(response: Response, limit: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  const contentEncoding = response.headers.get('content-encoding');
  // Node fetch exposes a decompressed body while retaining the transfer
  // representation's Content-Length. A small gzip stream can be larger than a
  // tiny source file, so only compare identity lengths; the stream counter
  // below always enforces the decoded-byte limit.
  if (
    (!contentEncoding || contentEncoding.toLowerCase() === 'identity') &&
    Number.isFinite(declared) &&
    declared > limit
  ) {
    sourceRejected('remote skill response exceeds limit');
  }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      const chunk = Buffer.from(next.value);
      total += chunk.length;
      if (total > limit) {
        await reader.cancel();
        sourceRejected('remote skill response exceeds limit');
      }
      chunks.push(chunk);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, total);
}

async function request(
  fetchImpl: typeof fetch,
  url: string,
  expectedOrigin: string,
  timeoutMs: number,
  limit: number,
  json: boolean,
): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
      headers: json
        ? {
            accept: 'application/vnd.github+json',
            'x-github-api-version': '2022-11-28',
            'user-agent': 'fleet-skill-materializer',
          }
        : { accept: 'application/octet-stream', 'user-agent': 'fleet-skill-materializer' },
    });
  } catch {
    sourceUnavailable('GitHub skill source could not be reached');
  }
  if (!response.ok) sourceUnavailable(`GitHub skill source returned HTTP ${response.status}`);
  if (response.url && new URL(response.url).origin !== expectedOrigin) {
    sourceRejected('GitHub skill response crossed an unexpected origin');
  }
  return boundedBytes(response, limit);
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  expectedOrigin: string,
  timeoutMs: number,
  limit = MAX_TREE_BYTES,
): Promise<Record<string, unknown>> {
  const bytes = await request(fetchImpl, url, expectedOrigin, timeoutMs, limit, true);
  try {
    const parsed = JSON.parse(bytes.toString('utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
      sourceRejected('invalid GitHub response');
    return parsed as Record<string, unknown>;
  } catch (error) {
    if (error instanceof FleetOperationError) throw error;
    sourceRejected('invalid GitHub response');
  }
}

function encodedPath(path: string): string {
  return path
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');
}

function gitBlobSha(bytes: Uint8Array): string {
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

function validateTreePath(path: string): void {
  if (
    path.length === 0 ||
    path.length > 500 ||
    path.startsWith('/') ||
    path.includes('\\') ||
    containsNonPublicControl(path) ||
    path.split('/').some((part) => !part || part === '.' || part === '..') ||
    path.split('/').length > MAX_DEPTH
  ) {
    sourceRejected('GitHub skill tree contains an unsafe path');
  }
}

function parsedDeclaredSkillName(
  markdown: string,
): { status: 'missing' | 'ambiguous' | 'invalid' } | { status: 'name'; value: string } {
  const parsed = parseFrontmatterScalar(markdown, 'name');
  if (parsed.status !== 'value') return parsed;
  const value = parsed.value;
  if (value.length === 0 || value.length > 255 || containsNonPublicControl(value.replace(/[\t\r\n]/g, ' '))) {
    return { status: 'invalid' };
  }
  return { status: 'name', value };
}

function declaredSkillName(markdown: string): string | undefined {
  const parsed = parsedDeclaredSkillName(markdown);
  if (parsed.status === 'ambiguous') sourceRejected('GitHub skill declares an ambiguous identity');
  if (parsed.status === 'invalid') sourceRejected('GitHub skill declares an unsafe identity');
  return parsed.status === 'name' ? parsed.value : undefined;
}

/** Keep catalog coordinates strict while matching the repository conventions
 * used by the skills CLI for directory and frontmatter display names. */
function toSkillSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function assertDownloadableTreeEntry(entry: ParsedGitHubTreeEntry): asserts entry is DownloadableTreeEntry {
  if (entry.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755')) {
    sourceRejected('GitHub skill contains a symlink, submodule, or unsupported entry');
  }
  if (
    !Number.isSafeInteger(entry.size) ||
    (entry.size as number) < 0 ||
    (entry.size as number) > MAX_FILE_BYTES
  ) {
    sourceRejected('GitHub skill contains an oversized or unverifiable file');
  }
  if (typeof entry.sha !== 'string' || !COMMIT.test(entry.sha)) {
    sourceRejected('GitHub skill contains an unverifiable blob identity');
  }
}

function prioritizeSkillEntries(allSkillEntries: ParsedGitHubTreeEntry[]): ParsedGitHubTreeEntry[] {
  if (allSkillEntries.length === 0) return [];
  const priorityEntries: ParsedGitHubTreeEntry[] = [];
  const seen = new Set<string>();
  const lowerSkillPaths = new Set(allSkillEntries.map((entry) => entry.path.toLowerCase()));
  for (const prefix of SKILL_PRIORITY_PREFIXES) {
    const isContainer = prefix !== '';
    for (const entry of allSkillEntries) {
      if (!entry.path.startsWith(prefix)) continue;
      const rest = entry.path.slice(prefix.length);
      if (rest.toLowerCase() === 'skill.md') {
        if (!seen.has(entry.path)) {
          priorityEntries.push(entry);
          seen.add(entry.path);
        }
        continue;
      }
      const parts = rest.split('/');
      if (parts.length === 2 && parts[1]!.toLowerCase() === 'skill.md') {
        if (!seen.has(entry.path)) {
          priorityEntries.push(entry);
          seen.add(entry.path);
        }
        continue;
      }
      const skillDirs = parts.slice(0, -1);
      const hasAncestorSkill = skillDirs.slice(0, -1).some((_, index) => {
        const ancestor = skillDirs.slice(0, index + 1).join('/');
        return lowerSkillPaths.has(`${prefix}${ancestor}/SKILL.md`.toLowerCase());
      });
      if (
        isContainer &&
        parts.length >= 3 &&
        parts.length <= DEFAULT_SKILL_CONTAINER_DEPTH + 1 &&
        parts.at(-1)!.toLowerCase() === 'skill.md' &&
        skillDirs.every((part) => !SKILL_DISCOVERY_SKIP_DIRS.has(part)) &&
        !hasAncestorSkill &&
        !seen.has(entry.path)
      ) {
        priorityEntries.push(entry);
        seen.add(entry.path);
      }
    }
  }
  return priorityEntries.length > 0
    ? priorityEntries
    : allSkillEntries.filter((entry) => entry.path.split('/').length <= 6);
}

function rootSkillPayload(
  entries: ParsedGitHubTreeEntry[],
  selectedSkill: ParsedGitHubTreeEntry,
  discoveredSkillEntries: ParsedGitHubTreeEntry[],
): ParsedGitHubTreeEntry[] {
  const otherSkillRoots = discoveredSkillEntries
    .filter((entry) => entry.path !== selectedSkill.path)
    .map((entry) => {
      // A path that merely ends in SKILL.md must not hide unsupported root
      // content. Only a discovered, regular, integrity-verifiable skill
      // entrypoint may establish a separate subtree boundary.
      assertDownloadableTreeEntry(entry);
      return posix.dirname(entry.path);
    })
    .filter((root) => root !== '.');
  const payload: ParsedGitHubTreeEntry[] = [];
  for (const entry of entries) {
    if (entry.type === 'tree') continue;
    if (entry.path === selectedSkill.path) {
      payload.push(entry);
      continue;
    }
    if (otherSkillRoots.some((root) => entry.path === root || entry.path.startsWith(`${root}/`))) {
      continue;
    }
    const segments = entry.path.split('/');
    if (
      (segments.length === 1 && ROOT_SKILL_METADATA_FILE.test(entry.path)) ||
      ROOT_SKILL_AUXILIARY_DIRS.has(segments[0]!)
    ) {
      payload.push(entry);
      continue;
    }
    sourceUnavailable(
      'root skill has unsupported repository content; a complete bounded payload cannot be determined',
    );
  }
  return payload;
}

function payloadRelativePath(
  file: ParsedGitHubTreeEntry,
  selectedSkill: ParsedGitHubTreeEntry,
  sourcePath: string,
  prefix: string,
): string {
  if (file.path === selectedSkill.path) return 'SKILL.md';
  return sourcePath === '.' ? file.path : file.path.slice(prefix.length);
}

export async function materializeGitHubSkill(
  coordinate: GitHubSkillCoordinate,
  options: MaterializeOptions = {},
): Promise<GitHubSkillLease> {
  assertGitHubSkillCoordinate(coordinate);
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiBase = new URL(options.apiBaseUrl ?? 'https://api.github.com');
  const rawBase = new URL(options.rawBaseUrl ?? 'https://raw.githubusercontent.com');
  if (apiBase.protocol !== 'https:' || rawBase.protocol !== 'https:')
    invalid('GitHub endpoints must use HTTPS');
  const timeoutMs = options.timeoutMs ?? 8000;
  const removeImpl = options.removeImpl ?? rm;
  const [owner, repo] = coordinate.repository.split('/') as [string, string];
  const repoPath = `${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  let leaseRoot = '';

  try {
    const repository = await requestJson(
      fetchImpl,
      new URL(`/repos/${repoPath}`, apiBase).toString(),
      apiBase.origin,
      timeoutMs,
    );
    const defaultBranch = repository.default_branch;
    if (typeof defaultBranch !== 'string' || defaultBranch.length === 0 || defaultBranch.length > 255) {
      sourceRejected('GitHub repository has no verifiable default branch');
    }
    const commitDoc = await requestJson(
      fetchImpl,
      new URL(`/repos/${repoPath}/commits/${encodeURIComponent(defaultBranch)}`, apiBase).toString(),
      apiBase.origin,
      timeoutMs,
    );
    const commit = commitDoc.sha;
    if (typeof commit !== 'string' || !COMMIT.test(commit))
      sourceRejected('GitHub commit could not be pinned');
    const treeDoc = await requestJson(
      fetchImpl,
      new URL(`/repos/${repoPath}/git/trees/${commit}?recursive=1`, apiBase).toString(),
      apiBase.origin,
      timeoutMs,
    );
    if (treeDoc.truncated !== false || !Array.isArray(treeDoc.tree)) {
      sourceRejected('GitHub skill tree is incomplete');
    }

    const entries: ParsedGitHubTreeEntry[] = (treeDoc.tree as GitHubTreeEntry[]).map((entry) => {
      if (!entry || typeof entry !== 'object' || typeof entry.path !== 'string') {
        sourceRejected('GitHub skill tree contains an invalid entry');
      }
      validateTreePath(entry.path);
      return {
        path: entry.path,
        mode: entry.mode,
        type: entry.type,
        size: entry.size,
        sha: entry.sha,
      };
    });
    const selectorSlug = toSkillSlug(coordinate.skill);
    const allSkillEntries = entries.filter(
      (entry) => entry.type === 'blob' && posix.basename(entry.path).toLowerCase() === 'skill.md',
    );
    const skillEntries = prioritizeSkillEntries(allSkillEntries);
    const directoryMatches = skillEntries.filter(
      (entry) => toSkillSlug(posix.basename(posix.dirname(entry.path))) === selectorSlug,
    );
    if (directoryMatches.length > 1) {
      sourceUnavailable('selected skill is ambiguous in the repository snapshot');
    }

    const verifiedBlobs = new Map<string, Buffer>();
    const downloadVerifiedBlob = async (file: DownloadableTreeEntry): Promise<Buffer> => {
      const cached = verifiedBlobs.get(file.path);
      if (cached) return cached;
      const rawUrl = new URL(
        `/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${commit}/${encodedPath(file.path)}`,
        rawBase,
      ).toString();
      const bytes = await request(
        fetchImpl,
        rawUrl,
        rawBase.origin,
        timeoutMs,
        Math.min(MAX_FILE_BYTES, file.size + 1),
        false,
      );
      if (bytes.length !== file.size) sourceRejected('GitHub skill file size changed during materialization');
      if (gitBlobSha(bytes) !== file.sha.toLowerCase()) {
        sourceRejected('GitHub skill blob identity does not match the pinned tree');
      }
      verifiedBlobs.set(file.path, bytes);
      return bytes;
    };

    let selectedSkill = directoryMatches[0];
    if (!selectedSkill) {
      if (skillEntries.length > MAX_SKILL_CANDIDATES) {
        sourceRejected('GitHub skill candidate set exceeds the discovery limit');
      }
      let candidateBytes = 0;
      const nameMatches: ParsedGitHubTreeEntry[] = [];
      for (const candidate of skillEntries) {
        assertDownloadableTreeEntry(candidate);
        candidateBytes += candidate.size;
        if (candidateBytes > MAX_TOTAL_BYTES) {
          sourceRejected('GitHub skill candidate metadata exceeds the discovery limit');
        }
        const markdown = (await downloadVerifiedBlob(candidate)).toString('utf8');
        const identity = parsedDeclaredSkillName(markdown);
        if (identity.status === 'name' && toSkillSlug(identity.value) === selectorSlug) {
          nameMatches.push(candidate);
        }
      }
      if (nameMatches.length > 1) {
        sourceUnavailable('selected skill is ambiguous in the repository snapshot');
      }
      selectedSkill = nameMatches[0];
    }
    if (!selectedSkill) {
      sourceUnavailable(
        skillEntries.length === 0
          ? 'selected skill is not present in the repository snapshot'
          : 'selected skill has no unambiguous repository identity',
      );
    }
    const sourcePath = posix.dirname(selectedSkill.path);
    const prefix = `${sourcePath}/`;
    // A root SKILL.md is an entrypoint, not permission to install arbitrary
    // repository content. Preserve conventional skill payload directories,
    // but fail closed rather than record a knowingly incomplete install.
    const files =
      sourcePath === '.'
        ? rootSkillPayload(entries, selectedSkill, skillEntries)
        : entries.filter((entry) => entry.path.startsWith(prefix) && entry.type !== 'tree');
    if (files.length === 0 || files.length > MAX_FILES)
      sourceRejected('GitHub skill has an unsafe file count');
    let declaredTotal = 0;
    const normalized = new Set<string>();
    const downloadableFiles: DownloadableTreeEntry[] = [];
    for (const file of files) {
      assertDownloadableTreeEntry(file);
      downloadableFiles.push(file);
      declaredTotal += file.size;
      if (declaredTotal > MAX_TOTAL_BYTES) sourceRejected('GitHub skill exceeds the materialization limit');
      const rel = payloadRelativePath(file, selectedSkill, sourcePath, prefix);
      validateTreePath(rel);
      const normalizedPath = rel.normalize('NFC').toLocaleLowerCase('en-US');
      if (normalized.has(normalizedPath)) sourceRejected('GitHub skill contains colliding paths');
      normalized.add(normalizedPath);
    }

    leaseRoot = await mkdtemp(join(options.tempBaseDir ?? tmpdir(), 'fleet-web-skill-'));
    await chmod(leaseRoot, 0o700);
    const sourceDir = join(leaseRoot, 'source');
    await mkdir(sourceDir, { mode: 0o700 });
    for (const file of downloadableFiles) {
      const rel = payloadRelativePath(file, selectedSkill, sourcePath, prefix);
      const destination = safeJoin(sourceDir, rel);
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      const bytes = await downloadVerifiedBlob(file);
      await writeFile(destination, bytes, { flag: 'wx', mode: file.mode === '100755' ? 0o700 : 0o600 });
    }

    const skillMarkdown = await readFile(join(sourceDir, 'SKILL.md'), 'utf8');
    const declaredName = declaredSkillName(skillMarkdown);
    if (declaredName !== undefined && toSkillSlug(declaredName) !== selectorSlug) {
      sourceRejected('GitHub skill identity does not match its catalog selector');
    }
    const meta = parseSkillFrontmatter(skillMarkdown);
    const rootToDispose = leaseRoot;
    return {
      source: { name: coordinate.skill, dir: sourceDir, ...(Object.keys(meta).length > 0 ? { meta } : {}) },
      sourceRoot: rootToDispose,
      origin: { type: 'github', repository: coordinate.repository, commit, path: sourcePath },
      async dispose() {
        await removeImpl(rootToDispose, { recursive: true, force: true });
      },
    };
  } catch (error) {
    if (leaseRoot) {
      try {
        await removeImpl(leaseRoot, { recursive: true, force: true });
      } catch {
        throw new GitHubSkillCleanupError();
      }
    }
    if (error instanceof FleetOperationError) throw error;
    sourceUnavailable('GitHub skill source could not be materialized');
  }
}
