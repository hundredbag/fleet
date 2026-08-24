import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { FleetOperationError, type PublicOperationErrorCode } from '../src/core/errors.js';
import {
  assertGitHubSkillCoordinate,
  GitHubSkillCleanupError,
  materializeGitHubSkill,
  parseGitHubSkillIdentifier,
  type GitHubSkillCoordinate,
} from '../src/web/github-skill.js';

const API_BASE = 'https://api.github.test';
const RAW_BASE = 'https://raw.github.test';
const COMMIT = '0123456789abcdef0123456789abcdef01234567';
const COORDINATE: GitHubSkillCoordinate = {
  provider: 'github',
  repository: 'mattpocock/skills',
  skill: 'writing-plans',
};
const CONVEX_COORDINATE: GitHubSkillCoordinate = {
  provider: 'github',
  repository: 'mattpocock/skills',
  skill: 'convex-best-practices',
};
const SKILL_ROOT = 'skills/writing-plans';

interface TreeEntry {
  path: string;
  mode: string;
  type: string;
  size?: number;
  sha?: unknown;
}

interface FakeGitHubOptions {
  tree: TreeEntry[];
  truncated?: unknown;
  omitTruncated?: boolean;
  files?: Record<string, Uint8Array>;
  treeHeaders?: Record<string, string>;
  rawHeaders?: Record<string, Record<string, string>>;
  commit?: unknown;
}

function responseAt(url: string, body: string | Uint8Array, init: ResponseInit = {}): Response {
  const response = new Response(body, init);
  Object.defineProperty(response, 'url', { value: url });
  return response;
}

function jsonAt(url: string, value: unknown, headers?: Record<string, string>): Response {
  return responseAt(url, JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json', ...headers },
  });
}

function gitBlobSha(bytes: Uint8Array): string {
  return createHash('sha1').update(`blob ${bytes.byteLength}\0`).update(bytes).digest('hex');
}

function fakeGitHub(options: FakeGitHubOptions): { fetchImpl: typeof fetch; requests: string[] } {
  const requests: string[] = [];
  const fetchImpl = (async (input: string) => {
    const url = String(input);
    requests.push(url);
    const parsed = new URL(url);

    if (parsed.origin === API_BASE && parsed.pathname === '/repos/mattpocock/skills') {
      return jsonAt(url, { default_branch: 'main' });
    }
    if (parsed.origin === API_BASE && parsed.pathname === '/repos/mattpocock/skills/commits/main') {
      return jsonAt(url, { sha: options.commit ?? COMMIT });
    }
    if (
      parsed.origin === API_BASE &&
      parsed.pathname === `/repos/mattpocock/skills/git/trees/${COMMIT}` &&
      parsed.search === '?recursive=1'
    ) {
      const tree = options.tree.map((entry) => {
        if (entry.sha !== undefined) return entry;
        const bytes = options.files?.[entry.path];
        return { ...entry, sha: bytes === undefined ? 'a'.repeat(40) : gitBlobSha(bytes) };
      });
      return jsonAt(
        url,
        {
          ...(options.omitTruncated
            ? {}
            : {
                truncated: Object.hasOwn(options, 'truncated') ? options.truncated : false,
              }),
          tree,
        },
        options.treeHeaders,
      );
    }

    const rawPrefix = `/mattpocock/skills/${COMMIT}/`;
    if (parsed.origin === RAW_BASE && parsed.pathname.startsWith(rawPrefix)) {
      const path = decodeURIComponent(parsed.pathname.slice(rawPrefix.length));
      const bytes = options.files?.[path];
      if (bytes) {
        return responseAt(url, new Uint8Array(bytes), {
          status: 200,
          headers: options.rawHeaders?.[path],
        });
      }
    }
    return responseAt(url, 'not found', { status: 404 });
  }) as unknown as typeof fetch;

  return { fetchImpl, requests };
}

function validSkillEntry(root = SKILL_ROOT, size = 1): TreeEntry {
  return { path: `${root}/SKILL.md`, mode: '100644', type: 'blob', size };
}

async function expectFleetError(
  promise: Promise<unknown>,
  code: PublicOperationErrorCode,
  message: RegExp,
): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof FleetOperationError);
    assert.equal(error.publicCode, code);
    assert.match(error.message, message);
    return true;
  });
}

async function listFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) files.push(relative(root, path).split(sep).join('/'));
    }
  }
  await walk(root);
  return files.sort();
}

test('GitHub skill coordinates use the strict owner/repository/skill form', () => {
  assert.deepEqual(parseGitHubSkillIdentifier('mattpocock/skills/writing-plans'), COORDINATE);
  assert.deepEqual(parseGitHubSkillIdentifier('Owner_1/repo.js/skill-v2'), {
    provider: 'github',
    repository: 'Owner_1/repo.js',
    skill: 'skill-v2',
  });

  const invalidIdentifiers: unknown[] = [
    undefined,
    null,
    42,
    '',
    'owner/repo',
    'owner/repo/skill/extra',
    '/repo/skill',
    'owner//skill',
    'owner/repo/-skill',
    'owner/.repo/skill',
    'owner/re..po/skill',
    'owner/repo/skill.',
    'owner/repo/skill name',
    'ownér/repo/skill',
    `${'a'.repeat(121)}/repo/skill`,
    'a'.repeat(361),
  ];
  for (const identifier of invalidIdentifiers) {
    assert.equal(parseGitHubSkillIdentifier(identifier), null, String(identifier));
  }

  assert.doesNotThrow(() => assertGitHubSkillCoordinate(COORDINATE));
  const invalidCoordinates: unknown[] = [
    null,
    [],
    { ...COORDINATE, provider: 'gitlab' },
    { ...COORDINATE, repository: 'mattpocock/skills/extra' },
    { ...COORDINATE, skill: '../writing-plans' },
    { ...COORDINATE, commit: COMMIT },
  ];
  for (const coordinate of invalidCoordinates) {
    assert.throws(
      () => assertGitHubSkillCoordinate(coordinate),
      (error: unknown) => error instanceof FleetOperationError && error.publicCode === 'INVALID_ARGUMENT',
    );
  }
});

test('materializes a complete nested mattpocock-style skill at a pinned commit', async (t) => {
  const tempBaseDir = await mkdtemp(join(tmpdir(), 'fleet-github-skill-test-'));
  t.after(async () => rm(tempBaseDir, { recursive: true, force: true }));

  const files: Record<string, Uint8Array> = {
    [`${SKILL_ROOT}/SKILL.md`]: Buffer.from(
      '---\nname: writing-plans\ndescription: "Plan before coding"\nversion: 2.1.0\n---\n\n# Writing plans\n',
    ),
    [`${SKILL_ROOT}/references/checklist.md`]: Buffer.from('# Checklist\n\n- Verify assumptions\n'),
    [`${SKILL_ROOT}/scripts/check.sh`]: Buffer.from('#!/bin/sh\nset -eu\nprintf ready\\n\n'),
    [`${SKILL_ROOT}/assets/template.bin`]: Buffer.from([0x00, 0xff, 0x10, 0x80, 0x41]),
  };
  const tree: TreeEntry[] = [
    { path: 'skills', mode: '040000', type: 'tree' },
    { path: SKILL_ROOT, mode: '040000', type: 'tree' },
    ...Object.entries(files).map(([path, bytes]) => ({
      path,
      mode: path.endsWith('/scripts/check.sh') ? '100755' : '100644',
      type: 'blob',
      size: bytes.byteLength,
    })),
    { path: 'skills/another-skill/SKILL.md', mode: '100644', type: 'blob', size: 7 },
  ];
  const remote = fakeGitHub({
    tree,
    files,
    rawHeaders: {
      [`${SKILL_ROOT}/SKILL.md`]: {
        'content-encoding': 'gzip',
        'content-length': String(files[`${SKILL_ROOT}/SKILL.md`]!.byteLength + 100),
      },
    },
  });
  const lease = await materializeGitHubSkill(COORDINATE, {
    fetchImpl: remote.fetchImpl,
    apiBaseUrl: API_BASE,
    rawBaseUrl: RAW_BASE,
    tempBaseDir,
  });
  t.after(async () => lease.dispose());

  assert.deepEqual(lease.origin, {
    type: 'github',
    repository: 'mattpocock/skills',
    commit: COMMIT,
    path: SKILL_ROOT,
  });
  assert.match(lease.origin.commit, /^[0-9a-f]{40}$/);
  assert.equal(lease.source.name, 'writing-plans');
  assert.deepEqual(lease.source.meta, { description: 'Plan before coding', version: '2.1.0' });
  assert.ok(lease.sourceRoot.startsWith(`${tempBaseDir}${sep}`));
  assert.equal((await stat(lease.sourceRoot)).mode & 0o777, 0o700);
  assert.equal((await stat(lease.source.dir)).mode & 0o777, 0o700);
  assert.deepEqual(await readdir(lease.sourceRoot), ['source']);
  assert.deepEqual(await listFiles(lease.source.dir), [
    'SKILL.md',
    'assets/template.bin',
    'references/checklist.md',
    'scripts/check.sh',
  ]);

  for (const [path, expected] of Object.entries(files)) {
    const rel = path.slice(`${SKILL_ROOT}/`.length);
    assert.deepEqual(await readFile(join(lease.source.dir, rel)), Buffer.from(expected), rel);
  }
  for (const dir of ['assets', 'references', 'scripts']) {
    assert.equal((await stat(join(lease.source.dir, dir))).mode & 0o777, 0o700, dir);
  }
  assert.equal((await stat(join(lease.source.dir, 'SKILL.md'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(lease.source.dir, 'references/checklist.md'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(lease.source.dir, 'assets/template.bin'))).mode & 0o777, 0o600);
  assert.equal((await stat(join(lease.source.dir, 'scripts/check.sh'))).mode & 0o777, 0o700);

  assert.deepEqual(remote.requests.slice(0, 3), [
    `${API_BASE}/repos/mattpocock/skills`,
    `${API_BASE}/repos/mattpocock/skills/commits/main`,
    `${API_BASE}/repos/mattpocock/skills/git/trees/${COMMIT}?recursive=1`,
  ]);
  const rawRequests = remote.requests.slice(3);
  assert.equal(rawRequests.length, Object.keys(files).length);
  assert.ok(rawRequests.every((url) => url.startsWith(`${RAW_BASE}/mattpocock/skills/${COMMIT}/`)));
  assert.ok(rawRequests.every((url) => new URL(url).origin === RAW_BASE));

  await lease.dispose();
  assert.equal(existsSync(lease.sourceRoot), false);
});

test('matches a frontmatter display name to its normalized catalog slug', async (t) => {
  const tempBaseDir = await mkdtemp(join(tmpdir(), 'fleet-github-skill-display-name-test-'));
  t.after(async () => rm(tempBaseDir, { recursive: true, force: true }));
  const root = 'skills/convex-best-practices';
  const markdown = Buffer.from(
    '---\nname: Convex Best Practices\ndescription: Apply Convex conventions\n---\n# Convex\n',
  );
  const remote = fakeGitHub({
    tree: [validSkillEntry(root, markdown.byteLength)],
    files: { [`${root}/SKILL.md`]: markdown },
  });

  const lease = await materializeGitHubSkill(CONVEX_COORDINATE, {
    fetchImpl: remote.fetchImpl,
    apiBaseUrl: API_BASE,
    rawBaseUrl: RAW_BASE,
    tempBaseDir,
  });
  t.after(async () => lease.dispose());

  assert.equal(lease.origin.path, root);
  assert.equal(lease.source.name, 'convex-best-practices');
  assert.deepEqual(lease.source.meta, { description: 'Apply Convex conventions' });
});

test('parses YAML comments, quoted names, and block scalar names during frontmatter fallback', async (t) => {
  const cases = [
    ['plain-comment', 'name: Convex Best Practices # display name'],
    ['quoted-comment', 'name: "Convex # Best Practices" # display name'],
    ['escaped-quote', 'name: "Convex \\"Best\\" Practices"'],
    ['folded-block', 'name: >-\n  Convex Best\n  Practices'],
    ['literal-block', 'name: |-\n  Convex Best\n  Practices'],
  ] as const;
  for (const [label, nameField] of cases) {
    await t.test(label, async (t) => {
      const tempBaseDir = await mkdtemp(join(tmpdir(), `fleet-github-yaml-name-${label}-`));
      t.after(async () => rm(tempBaseDir, { recursive: true, force: true }));
      const root = `catalog/${label}`;
      const markdown = Buffer.from(
        `---\n${nameField}\ndescription: Apply Convex conventions\n---\n# Convex\n`,
      );
      const remote = fakeGitHub({
        tree: [validSkillEntry(root, markdown.byteLength)],
        files: { [`${root}/SKILL.md`]: markdown },
      });
      const lease = await materializeGitHubSkill(CONVEX_COORDINATE, {
        fetchImpl: remote.fetchImpl,
        apiBaseUrl: API_BASE,
        rawBaseUrl: RAW_BASE,
        tempBaseDir,
      });
      t.after(async () => lease.dispose());
      assert.equal(lease.origin.path, root);
    });
  }
});

test('rejects non-string, tagged, duplicate, and malformed YAML skill identities', async (t) => {
  const cases = [
    ['numeric', 'name: 123'],
    ['boolean', 'name: true'],
    ['null', 'name: null'],
    ['sequence', 'name: [Convex Best Practices]'],
    ['mapping', 'name: { label: Convex Best Practices }'],
    ['tagged', 'name: !custom Convex Best Practices'],
    ['duplicate', 'name: convex-best-practices\nname: Convex Best Practices'],
    ['malformed', 'name: "Convex Best Practices'],
  ] as const;
  for (const [label, nameField] of cases) {
    await t.test(label, async () => {
      const root = 'skills/convex-best-practices';
      const markdown = Buffer.from(
        `---\n${nameField}\ndescription: Apply Convex conventions\n---\n# Convex\n`,
      );
      const remote = fakeGitHub({
        tree: [validSkillEntry(root, markdown.byteLength)],
        files: { [`${root}/SKILL.md`]: markdown },
      });
      await expectFleetError(
        materializeGitHubSkill(CONVEX_COORDINATE, {
          fetchImpl: remote.fetchImpl,
          apiBaseUrl: API_BASE,
          rawBaseUrl: RAW_BASE,
        }),
        'REQUEST_REJECTED',
        label === 'duplicate' ? /ambiguous identity/ : /unsafe identity/,
      );
    });
  }
});

test('preserves conventional auxiliary files for a bounded repository-root skill', async (t) => {
  const tempBaseDir = await mkdtemp(join(tmpdir(), 'fleet-github-root-skill-test-'));
  t.after(async () => rm(tempBaseDir, { recursive: true, force: true }));
  const markdown = Buffer.from(
    '---\nname: Writing Plans\ndescription: Plan before coding\n---\n# Writing plans\n',
  );
  const readme = Buffer.from('# Repository documentation\n');
  const script = Buffer.from('export const ready = true;\n');
  const reference = Buffer.from('# Guide\n');
  const asset = Buffer.from('{"template":true}\n');
  const files = {
    'SKILL.md': markdown,
    'README.md': readme,
    'scripts/check.mjs': script,
    'references/guide.md': reference,
    'assets/template.json': asset,
  };
  const remote = fakeGitHub({
    tree: Object.entries(files).map(([path, bytes]) => ({
      path,
      mode: path.startsWith('scripts/') ? '100755' : '100644',
      type: 'blob',
      size: bytes.byteLength,
    })),
    files,
  });

  const lease = await materializeGitHubSkill(COORDINATE, {
    fetchImpl: remote.fetchImpl,
    apiBaseUrl: API_BASE,
    rawBaseUrl: RAW_BASE,
    tempBaseDir,
  });
  t.after(async () => lease.dispose());

  assert.equal(lease.origin.path, '.');
  assert.deepEqual(await listFiles(lease.source.dir), [
    'README.md',
    'SKILL.md',
    'assets/template.json',
    'references/guide.md',
    'scripts/check.mjs',
  ]);
  assert.equal(remote.requests.length, 3 + Object.keys(files).length);
});

test('refuses a root skill when its complete payload cannot be bounded by the root policy', async () => {
  const markdown = Buffer.from(
    '---\nname: Writing Plans\ndescription: Plan before coding\n---\n# Writing plans\n',
  );
  const template = Buffer.from('required template\n');
  const remote = fakeGitHub({
    tree: [
      { path: 'SKILL.md', mode: '100644', type: 'blob', size: markdown.byteLength },
      { path: 'templates/required.txt', mode: '100644', type: 'blob', size: template.byteLength },
    ],
    files: { 'SKILL.md': markdown, 'templates/required.txt': template },
  });
  await expectFleetError(
    materializeGitHubSkill(COORDINATE, {
      fetchImpl: remote.fetchImpl,
      apiBaseUrl: API_BASE,
      rawBaseUrl: RAW_BASE,
    }),
    'SOURCE_UNAVAILABLE',
    /complete bounded payload cannot be determined/,
  );
  assert.equal(remote.requests.filter((url) => url.includes('/templates/')).length, 0);
});

test('does not let an undiscovered non-regular SKILL.md hide unsupported root payload', async () => {
  const markdown = Buffer.from(
    '---\nname: Writing Plans\ndescription: Plan before coding\n---\n# Writing plans\n',
  );
  const linkTarget = Buffer.from('../required');
  const required = Buffer.from('required hidden payload\n');
  const remote = fakeGitHub({
    tree: [
      { path: 'SKILL.md', mode: '100644', type: 'blob', size: markdown.byteLength },
      {
        path: 'templates/hidden/SKILL.md',
        mode: '120000',
        type: 'blob',
        size: linkTarget.byteLength,
      },
      {
        path: 'templates/hidden/required.txt',
        mode: '100644',
        type: 'blob',
        size: required.byteLength,
      },
    ],
    files: {
      'SKILL.md': markdown,
      'templates/hidden/SKILL.md': linkTarget,
      'templates/hidden/required.txt': required,
    },
  });

  await expectFleetError(
    materializeGitHubSkill(COORDINATE, {
      fetchImpl: remote.fetchImpl,
      apiBaseUrl: API_BASE,
      rawBaseUrl: RAW_BASE,
    }),
    'SOURCE_UNAVAILABLE',
    /complete bounded payload cannot be determined/,
  );
  assert.equal(
    remote.requests.some((url) => url.includes('/templates/')),
    false,
  );
});

test('falls back to a normalized frontmatter name when the directory name differs', async (t) => {
  const tempBaseDir = await mkdtemp(join(tmpdir(), 'fleet-github-skill-name-fallback-test-'));
  t.after(async () => rm(tempBaseDir, { recursive: true, force: true }));
  const root = 'catalog/published-entry';
  const markdown = Buffer.from(
    '---\nname: Convex Best Practices\ndescription: Apply Convex conventions\n---\n# Convex\n',
  );
  const remote = fakeGitHub({
    tree: [validSkillEntry(root, markdown.byteLength)],
    files: { [`${root}/SKILL.md`]: markdown },
  });

  const lease = await materializeGitHubSkill(CONVEX_COORDINATE, {
    fetchImpl: remote.fetchImpl,
    apiBaseUrl: API_BASE,
    rawBaseUrl: RAW_BASE,
    tempBaseDir,
  });
  t.after(async () => lease.dispose());

  assert.equal(lease.origin.path, root);
  assert.deepEqual(await listFiles(lease.source.dir), ['SKILL.md']);
  assert.equal(remote.requests.filter((url) => url.includes('/SKILL.md')).length, 1);
});

test('applies official skill-path priority before selector matching', async (t) => {
  await t.test(
    'repository root wins over a same-name example nested below an arbitrary directory',
    async (t) => {
      const tempBaseDir = await mkdtemp(join(tmpdir(), 'fleet-github-root-priority-test-'));
      t.after(async () => rm(tempBaseDir, { recursive: true, force: true }));
      const rootMarkdown = Buffer.from('---\nname: Writing Plans\ndescription: Root skill\n---\n# Root\n');
      const exampleMarkdown = Buffer.from(
        '---\nname: writing-plans\ndescription: Example only\n---\n# Example\n',
      );
      const remote = fakeGitHub({
        tree: [
          { path: 'SKILL.md', mode: '100644', type: 'blob', size: rootMarkdown.byteLength },
          validSkillEntry('examples/writing-plans', exampleMarkdown.byteLength),
        ],
        files: {
          'SKILL.md': rootMarkdown,
          'examples/writing-plans/SKILL.md': exampleMarkdown,
        },
      });
      await expectFleetError(
        materializeGitHubSkill(COORDINATE, {
          fetchImpl: remote.fetchImpl,
          apiBaseUrl: API_BASE,
          rawBaseUrl: RAW_BASE,
          tempBaseDir,
        }),
        'SOURCE_UNAVAILABLE',
        /complete bounded payload cannot be determined/,
      );
      assert.equal(
        remote.requests.some((url) => url.endsWith('/SKILL.md')),
        true,
        'root identity must be selected before the bounded-payload policy rejects the example subtree',
      );
      assert.equal(
        remote.requests.some((url) => url.includes('/examples/')),
        false,
      );
    },
  );

  await t.test('an ancestor skill excludes a nested SKILL.md from identity selection', async (t) => {
    const tempBaseDir = await mkdtemp(join(tmpdir(), 'fleet-github-ancestor-priority-test-'));
    t.after(async () => rm(tempBaseDir, { recursive: true, force: true }));
    const parentRoot = 'skills/catalog';
    const nestedRoot = `${parentRoot}/writing-plans`;
    const parentMarkdown = Buffer.from(
      '---\nname: Writing Plans\ndescription: Parent skill\n---\n# Parent\n',
    );
    const nestedMarkdown = Buffer.from(
      '---\nname: writing-plans\ndescription: Nested example\n---\n# Nested\n',
    );
    const remote = fakeGitHub({
      tree: [
        validSkillEntry(parentRoot, parentMarkdown.byteLength),
        validSkillEntry(nestedRoot, nestedMarkdown.byteLength),
      ],
      files: {
        [`${parentRoot}/SKILL.md`]: parentMarkdown,
        [`${nestedRoot}/SKILL.md`]: nestedMarkdown,
      },
    });
    const lease = await materializeGitHubSkill(COORDINATE, {
      fetchImpl: remote.fetchImpl,
      apiBaseUrl: API_BASE,
      rawBaseUrl: RAW_BASE,
      tempBaseDir,
    });
    t.after(async () => lease.dispose());
    assert.equal(lease.origin.path, parentRoot);
  });

  for (const preferredRoot of ['skills/writing-plans', '.agents/skills/writing-plans']) {
    await t.test(`${preferredRoot} wins over an arbitrary same-name directory`, async (t) => {
      const tempBaseDir = await mkdtemp(join(tmpdir(), 'fleet-github-container-priority-test-'));
      t.after(async () => rm(tempBaseDir, { recursive: true, force: true }));
      const preferred = Buffer.from('# Preferred\n');
      const arbitrary = Buffer.from('# Arbitrary\n');
      const remote = fakeGitHub({
        tree: [
          validSkillEntry(preferredRoot, preferred.byteLength),
          validSkillEntry('examples/writing-plans', arbitrary.byteLength),
        ],
        files: {
          [`${preferredRoot}/SKILL.md`]: preferred,
          'examples/writing-plans/SKILL.md': arbitrary,
        },
      });
      const lease = await materializeGitHubSkill(COORDINATE, {
        fetchImpl: remote.fetchImpl,
        apiBaseUrl: API_BASE,
        rawBaseUrl: RAW_BASE,
        tempBaseDir,
      });
      t.after(async () => lease.dispose());
      assert.equal(lease.origin.path, preferredRoot);
      assert.equal(
        remote.requests.some((url) => url.includes('/examples/')),
        false,
      );
    });
  }
});

test('matches supported entrypoint casing and ignores non-entrypoint tree entries', async (t) => {
  await t.test('lowercase entrypoint is materialized under the canonical filename', async (t) => {
    const tempBaseDir = await mkdtemp(join(tmpdir(), 'fleet-github-lowercase-skill-test-'));
    t.after(async () => rm(tempBaseDir, { recursive: true, force: true }));
    const root = 'skills/writing-plans';
    const markdown = Buffer.from('---\nname: Writing Plans\n---\n# Lowercase entrypoint\n');
    const remote = fakeGitHub({
      tree: [{ path: `${root}/skill.md`, mode: '100644', type: 'blob', size: markdown.byteLength }],
      files: { [`${root}/skill.md`]: markdown },
    });
    const lease = await materializeGitHubSkill(COORDINATE, {
      fetchImpl: remote.fetchImpl,
      apiBaseUrl: API_BASE,
      rawBaseUrl: RAW_BASE,
      tempBaseDir,
    });
    t.after(async () => lease.dispose());
    assert.equal(lease.origin.path, root);
    assert.deepEqual(await listFiles(lease.source.dir), ['SKILL.md']);
    assert.equal(
      remote.requests.some((url) => url.endsWith('/skill.md')),
      true,
    );
  });

  await t.test('a tree named SKILL.md cannot suppress a valid fallback blob', async (t) => {
    const tempBaseDir = await mkdtemp(join(tmpdir(), 'fleet-github-nonblob-candidate-test-'));
    t.after(async () => rm(tempBaseDir, { recursive: true, force: true }));
    const root = 'catalog/writing-plans';
    const markdown = Buffer.from('# Fallback blob\n');
    const remote = fakeGitHub({
      tree: [{ path: 'SKILL.md', mode: '040000', type: 'tree' }, validSkillEntry(root, markdown.byteLength)],
      files: { [`${root}/SKILL.md`]: markdown },
    });
    const lease = await materializeGitHubSkill(COORDINATE, {
      fetchImpl: remote.fetchImpl,
      apiBaseUrl: API_BASE,
      rawBaseUrl: RAW_BASE,
      tempBaseDir,
    });
    t.after(async () => lease.dispose());
    assert.equal(lease.origin.path, root);
  });

  await t.test('a filename that only ends in skill.md is not an entrypoint', async () => {
    const markdown = Buffer.from('---\nname: Writing Plans\n---\n# Not an entrypoint\n');
    const remote = fakeGitHub({
      tree: [
        {
          path: 'skills/writing-plans/not-a-skill.md',
          mode: '100644',
          type: 'blob',
          size: markdown.byteLength,
        },
      ],
      files: { 'skills/writing-plans/not-a-skill.md': markdown },
    });
    await expectFleetError(
      materializeGitHubSkill(COORDINATE, {
        fetchImpl: remote.fetchImpl,
        apiBaseUrl: API_BASE,
        rawBaseUrl: RAW_BASE,
      }),
      'SOURCE_UNAVAILABLE',
      /not present/,
    );
    assert.equal(remote.requests.length, 3);
  });
});

test('rejects multiple candidates that normalize to the same selector', async (t) => {
  await t.test('directory names', async () => {
    const remote = fakeGitHub({
      tree: [
        validSkillEntry('skills/Convex Best Practices'),
        validSkillEntry('.agents/skills/convex_best_practices'),
      ],
    });
    await expectFleetError(
      materializeGitHubSkill(CONVEX_COORDINATE, {
        fetchImpl: remote.fetchImpl,
        apiBaseUrl: API_BASE,
        rawBaseUrl: RAW_BASE,
      }),
      'SOURCE_UNAVAILABLE',
      /ambiguous/,
    );
    assert.equal(remote.requests.length, 3);
  });

  await t.test('frontmatter names', async () => {
    const first = Buffer.from(
      '---\nname: Convex Best Practices\ndescription: First candidate\n---\n# First\n',
    );
    const second = Buffer.from(
      '---\nname: convex_best_practices\ndescription: Second candidate\n---\n# Second\n',
    );
    const remote = fakeGitHub({
      tree: [
        validSkillEntry('catalog/first', first.byteLength),
        validSkillEntry('catalog/second', second.byteLength),
      ],
      files: {
        'catalog/first/SKILL.md': first,
        'catalog/second/SKILL.md': second,
      },
    });
    await expectFleetError(
      materializeGitHubSkill(CONVEX_COORDINATE, {
        fetchImpl: remote.fetchImpl,
        apiBaseUrl: API_BASE,
        rawBaseUrl: RAW_BASE,
      }),
      'SOURCE_UNAVAILABLE',
      /ambiguous/,
    );
    assert.equal(remote.requests.length, 5);
  });
});

test('surfaces a fixed terminal error when partial materialization cleanup fails', async (t) => {
  const tempBaseDir = await mkdtemp(join(tmpdir(), 'fleet-github-skill-cleanup-test-'));
  t.after(async () => rm(tempBaseDir, { recursive: true, force: true }));
  const markdown = Buffer.from('# Writing plans\n');
  const badBytes = Buffer.from('same length payload');
  const files = {
    [`${SKILL_ROOT}/SKILL.md`]: markdown,
    [`${SKILL_ROOT}/bad.txt`]: badBytes,
  };
  const remote = fakeGitHub({
    tree: [
      validSkillEntry(SKILL_ROOT, markdown.byteLength),
      {
        path: `${SKILL_ROOT}/bad.txt`,
        mode: '100644',
        type: 'blob',
        size: badBytes.byteLength,
        sha: 'b'.repeat(40),
      },
    ],
    files,
  });
  let cleanupTarget = '';
  await assert.rejects(
    materializeGitHubSkill(COORDINATE, {
      fetchImpl: remote.fetchImpl,
      apiBaseUrl: API_BASE,
      rawBaseUrl: RAW_BASE,
      tempBaseDir,
      removeImpl: async (path) => {
        cleanupTarget = path;
        throw new Error('private cleanup detail');
      },
    }),
    (error: unknown) => {
      assert.ok(error instanceof GitHubSkillCleanupError);
      assert.equal(error.message, 'remote skill staging cleanup failed; recovery is pending');
      return true;
    },
  );
  assert.ok(cleanupTarget.startsWith(`${tempBaseDir}${sep}`));
  assert.equal((await readdir(tempBaseDir)).length, 1, 'the failed cleanup must remain observable');
});

test('rejects ambiguous duplicate skill roots before downloading blobs', async () => {
  const remote = fakeGitHub({
    tree: [validSkillEntry('skills/writing-plans'), validSkillEntry('.agents/skills/writing-plans')],
  });
  await expectFleetError(
    materializeGitHubSkill(COORDINATE, {
      fetchImpl: remote.fetchImpl,
      apiBaseUrl: API_BASE,
      rawBaseUrl: RAW_BASE,
    }),
    'SOURCE_UNAVAILABLE',
    /ambiguous/,
  );
  assert.equal(remote.requests.length, 3);
});

test('rejects unsafe, incomplete, and oversized GitHub trees', async (t) => {
  const skillSize = 16;

  await t.test('unverifiable commit pin', async () => {
    const remote = fakeGitHub({ tree: [], commit: 'deadbeef' });
    await expectFleetError(
      materializeGitHubSkill(COORDINATE, {
        fetchImpl: remote.fetchImpl,
        apiBaseUrl: API_BASE,
        rawBaseUrl: RAW_BASE,
      }),
      'REQUEST_REJECTED',
      /commit could not be pinned/,
    );
    assert.equal(remote.requests.length, 2);
  });

  await t.test('symlink entry', async () => {
    const remote = fakeGitHub({
      tree: [
        validSkillEntry(SKILL_ROOT, skillSize),
        { path: `${SKILL_ROOT}/escape`, mode: '120000', type: 'blob', size: 9 },
      ],
    });
    await expectFleetError(
      materializeGitHubSkill(COORDINATE, {
        fetchImpl: remote.fetchImpl,
        apiBaseUrl: API_BASE,
        rawBaseUrl: RAW_BASE,
      }),
      'REQUEST_REJECTED',
      /symlink, submodule, or unsupported entry/,
    );
  });

  await t.test('submodule entry', async () => {
    const remote = fakeGitHub({
      tree: [
        validSkillEntry(SKILL_ROOT, skillSize),
        { path: `${SKILL_ROOT}/vendor`, mode: '160000', type: 'commit' },
      ],
    });
    await expectFleetError(
      materializeGitHubSkill(COORDINATE, {
        fetchImpl: remote.fetchImpl,
        apiBaseUrl: API_BASE,
        rawBaseUrl: RAW_BASE,
      }),
      'REQUEST_REJECTED',
      /symlink, submodule, or unsupported entry/,
    );
  });

  await t.test('traversal path', async () => {
    const remote = fakeGitHub({
      tree: [
        validSkillEntry(SKILL_ROOT, skillSize),
        { path: `${SKILL_ROOT}/../escape`, mode: '100644', type: 'blob', size: 1 },
      ],
    });
    await expectFleetError(
      materializeGitHubSkill(COORDINATE, {
        fetchImpl: remote.fetchImpl,
        apiBaseUrl: API_BASE,
        rawBaseUrl: RAW_BASE,
      }),
      'REQUEST_REJECTED',
      /unsafe path/,
    );
  });

  await t.test('terminal and bidirectional controls in a path', async () => {
    for (const unsafePath of [
      `skills/\u009b31m/writing-plans/SKILL.md`,
      `skills/\u202ewriting-plans/SKILL.md`,
      `${SKILL_ROOT}/notes\u2066hidden.md`,
    ]) {
      const remote = fakeGitHub({
        tree: [
          validSkillEntry(SKILL_ROOT, skillSize),
          { path: unsafePath, mode: '100644', type: 'blob', size: 1 },
        ],
      });
      await expectFleetError(
        materializeGitHubSkill(COORDINATE, {
          fetchImpl: remote.fetchImpl,
          apiBaseUrl: API_BASE,
          rawBaseUrl: RAW_BASE,
        }),
        'REQUEST_REJECTED',
        /unsafe path/,
      );
      assert.equal(remote.requests.length, 3);
    }
  });

  await t.test('truncated recursive tree', async () => {
    const remote = fakeGitHub({ tree: [validSkillEntry(SKILL_ROOT, skillSize)], truncated: true });
    await expectFleetError(
      materializeGitHubSkill(COORDINATE, {
        fetchImpl: remote.fetchImpl,
        apiBaseUrl: API_BASE,
        rawBaseUrl: RAW_BASE,
      }),
      'REQUEST_REJECTED',
      /tree is incomplete/,
    );
  });

  await t.test('missing or non-boolean tree completeness marker', async () => {
    for (const options of [{ omitTruncated: true }, { truncated: 'false' }]) {
      const remote = fakeGitHub({ tree: [validSkillEntry(SKILL_ROOT, skillSize)], ...options });
      await expectFleetError(
        materializeGitHubSkill(COORDINATE, {
          fetchImpl: remote.fetchImpl,
          apiBaseUrl: API_BASE,
          rawBaseUrl: RAW_BASE,
        }),
        'REQUEST_REJECTED',
        /tree is incomplete/,
      );
    }
  });

  await t.test('tree entry without a path is rejected rather than omitted', async () => {
    const remote = fakeGitHub({
      tree: [
        validSkillEntry(SKILL_ROOT, skillSize),
        { mode: '100644', type: 'blob', size: 1 } as unknown as TreeEntry,
      ],
    });
    await expectFleetError(
      materializeGitHubSkill(COORDINATE, {
        fetchImpl: remote.fetchImpl,
        apiBaseUrl: API_BASE,
        rawBaseUrl: RAW_BASE,
      }),
      'REQUEST_REJECTED',
      /invalid entry/,
    );
  });

  await t.test('oversized tree response', async () => {
    const remote = fakeGitHub({
      tree: [validSkillEntry(SKILL_ROOT, skillSize)],
      treeHeaders: { 'content-length': String(5 * 1024 * 1024 + 1) },
    });
    await expectFleetError(
      materializeGitHubSkill(COORDINATE, {
        fetchImpl: remote.fetchImpl,
        apiBaseUrl: API_BASE,
        rawBaseUrl: RAW_BASE,
      }),
      'REQUEST_REJECTED',
      /response exceeds limit/,
    );
  });

  await t.test('oversized declared file', async () => {
    const remote = fakeGitHub({
      tree: [
        validSkillEntry(SKILL_ROOT, skillSize),
        { path: `${SKILL_ROOT}/large.bin`, mode: '100644', type: 'blob', size: 1024 * 1024 + 1 },
      ],
    });
    await expectFleetError(
      materializeGitHubSkill(COORDINATE, {
        fetchImpl: remote.fetchImpl,
        apiBaseUrl: API_BASE,
        rawBaseUrl: RAW_BASE,
      }),
      'REQUEST_REJECTED',
      /oversized or unverifiable file/,
    );
  });

  await t.test('oversized aggregate', async () => {
    const largeEntries: TreeEntry[] = Array.from({ length: 11 }, (_, index) => ({
      path: `${SKILL_ROOT}/part-${index}.bin`,
      mode: '100644',
      type: 'blob',
      size: 1_000_000,
    }));
    const remote = fakeGitHub({ tree: [validSkillEntry(SKILL_ROOT, skillSize), ...largeEntries] });
    await expectFleetError(
      materializeGitHubSkill(COORDINATE, {
        fetchImpl: remote.fetchImpl,
        apiBaseUrl: API_BASE,
        rawBaseUrl: RAW_BASE,
      }),
      'REQUEST_REJECTED',
      /materialization limit/,
    );
  });

  await t.test('unsafe file count', async () => {
    const entries: TreeEntry[] = Array.from({ length: 128 }, (_, index) => ({
      path: `${SKILL_ROOT}/file-${index}.txt`,
      mode: '100644',
      type: 'blob',
      size: 1,
    }));
    const remote = fakeGitHub({ tree: [validSkillEntry(SKILL_ROOT, skillSize), ...entries] });
    await expectFleetError(
      materializeGitHubSkill(COORDINATE, {
        fetchImpl: remote.fetchImpl,
        apiBaseUrl: API_BASE,
        rawBaseUrl: RAW_BASE,
      }),
      'REQUEST_REJECTED',
      /unsafe file count/,
    );
  });

  await t.test('missing blob identity', async () => {
    const remote = fakeGitHub({
      tree: [{ ...validSkillEntry(SKILL_ROOT, skillSize), sha: null }],
    });
    await expectFleetError(
      materializeGitHubSkill(COORDINATE, {
        fetchImpl: remote.fetchImpl,
        apiBaseUrl: API_BASE,
        rawBaseUrl: RAW_BASE,
      }),
      'REQUEST_REJECTED',
      /unverifiable blob identity/,
    );
  });

  await t.test('same-length blob does not match the pinned tree identity', async () => {
    const markdown = Buffer.from('# Writing plans\n');
    const remote = fakeGitHub({
      tree: [{ ...validSkillEntry(SKILL_ROOT, markdown.byteLength), sha: 'b'.repeat(40) }],
      files: { [`${SKILL_ROOT}/SKILL.md`]: markdown },
    });
    await expectFleetError(
      materializeGitHubSkill(COORDINATE, {
        fetchImpl: remote.fetchImpl,
        apiBaseUrl: API_BASE,
        rawBaseUrl: RAW_BASE,
      }),
      'REQUEST_REJECTED',
      /blob identity does not match/,
    );
  });

  await t.test('ambiguous frontmatter identity', async () => {
    const markdown = Buffer.from('---\nname: writing-plans\nname: another-skill\n---\n# Plans\n');
    const remote = fakeGitHub({
      tree: [validSkillEntry(SKILL_ROOT, markdown.byteLength)],
      files: { [`${SKILL_ROOT}/SKILL.md`]: markdown },
    });
    await expectFleetError(
      materializeGitHubSkill(COORDINATE, {
        fetchImpl: remote.fetchImpl,
        apiBaseUrl: API_BASE,
        rawBaseUrl: RAW_BASE,
      }),
      'REQUEST_REJECTED',
      /ambiguous identity/,
    );
  });
});
