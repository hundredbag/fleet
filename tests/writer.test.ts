import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  rmSync,
  statSync,
  symlinkSync,
  lstatSync,
  readlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.js';
import {
  applyChanges,
  rollback,
  readAudit,
  readAuditLedger,
  acquireOperationLock,
  publishDirectoryNoClobber,
  toPlannedChange,
  type ChangeValidator,
  type PlannedChange,
} from '../src/core/writer.js';
import { sha256 } from '../src/core/hash.js';

function withTempDir(fn: (dir: string) => void | Promise<void>) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), 'fleet-w-'));
    try {
      await fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}

const seedClaude = (path: string) =>
  writeFileSync(
    path,
    JSON.stringify({ hasCompletedOnboarding: true, mcpServers: { existing: { command: 'keep' } } }, null, 2),
  );

test(
  'operation lock release never unlinks a newer owner lock',
  withTempDir(async (dir) => {
    const home = join(dir, 'fleet-home');
    const releaseFirst = await acquireOperationLock(home);
    rmSync(join(home, '.lock'));
    const releaseSecond = await acquireOperationLock(home);

    await releaseFirst();
    await assert.rejects(acquireOperationLock(home), /another operation holds the lock/);
    await releaseSecond();
    const releaseThird = await acquireOperationLock(home);
    await releaseThird();
  }),
);

test(
  'operation lock cleanup failure never reverses a completed caller outcome',
  withTempDir(async (dir) => {
    const home = join(dir, 'fleet-home');
    const release = await acquireOperationLock(home);
    chmodSync(home, 0o000);
    try {
      await assert.doesNotReject(release());
    } finally {
      chmodSync(home, 0o700);
    }
  }),
);

test(
  'apply returns its recorded mutation when only post-commit lock cleanup is unavailable',
  withTempDir(async (dir) => {
    const home = join(dir, 'fleet-home');
    const file = join(dir, 'applied.json');
    let applied: Awaited<ReturnType<typeof applyChanges>> = [];
    try {
      applied = await applyChanges(
        [
          {
            agent: 'codex',
            op: 'install',
            name: 'applied',
            kind: 'mcp-server',
            scope: 'user',
            file,
            newContent: '{}',
          },
        ],
        jsonValidate,
        {
          fleetHome: home,
          whileLocked: async () => {
            chmodSync(home, 0o000);
          },
        },
      );
    } finally {
      chmodSync(home, 0o700);
    }
    assert.equal(applied.length, 1);
    assert.equal(applied[0]?.auditRecorded, true);
    assert.equal(readFileSync(file, 'utf8'), '{}');
  }),
);

/** validator that parses JSON (stands in for an adapter's validate) */
const jsonValidate: ChangeValidator = (_c, content) => {
  JSON.parse(content);
};

test(
  'claude writer: install adds entry, preserves the rest, backs up + audits',
  withTempDir(async (dir) => {
    const claudeJson = join(dir, '.claude.json');
    seedClaude(claudeJson);
    const home = join(dir, 'fleet-home');
    const a = new ClaudeCodeAdapter(claudeJson, join(dir, '_sk'));

    const r = await a.renderInstall(
      { transport: 'stdio', command: 'npx', args: ['-y', 'new'] },
      { kind: 'mcp-server', name: 'newsrv', scope: 'user' },
    );
    assert.ok(r.baseHash, 'render captures a base hash of the existing file');
    const change = toPlannedChange('claude-code', 'install', 'newsrv', 'user', r);
    const res = await applyChanges([change], (_c, content) => a.validate(content), {
      fleetHome: home,
    });

    const doc = JSON.parse(readFileSync(claudeJson, 'utf8'));
    assert.equal(doc.mcpServers.newsrv.command, 'npx');
    assert.equal(doc.mcpServers.existing.command, 'keep'); // unrelated entry preserved
    assert.equal(doc.hasCompletedOnboarding, true); // unrelated key preserved
    assert.ok(res[0]!.backup && existsSync(res[0]!.backup));

    const audit = await readAudit(home);
    assert.equal(audit.length, 1);
    assert.equal(audit[0]!.op, 'install');
    assert.equal(audit[0]!.existedBefore, true);
    assert.ok(audit[0]!.wroteHash);
  }),
);

test(
  'claude writer: install round-trips back to the reader',
  withTempDir(async (dir) => {
    const claudeJson = join(dir, '.claude.json');
    seedClaude(claudeJson);
    const home = join(dir, 'fleet-home');
    const a = new ClaudeCodeAdapter(claudeJson, join(dir, '_sk'));
    const r = await a.renderInstall(
      { transport: 'http', url: 'https://x.test/mcp' },
      { kind: 'mcp-server', name: 'remote', scope: 'user' },
    );
    await applyChanges([toPlannedChange('claude-code', 'install', 'remote', 'user', r)], jsonValidate, {
      fleetHome: home,
    });
    const items = await a.readInventory();
    const remote = items.find((i) => i.name === 'remote') as any;
    assert.equal(remote?.spec.transport, 'http');
  }),
);

test(
  'engine: a new secret-bearing config and its new parent use private modes',
  withTempDir(async (dir) => {
    const configDir = join(dir, 'new-agent');
    const claudeJson = join(configDir, '.claude.json');
    const home = join(dir, 'fleet-home');
    const adapter = new ClaudeCodeAdapter(claudeJson, join(dir, '_sk'));
    const rendered = await adapter.renderInstall(
      {
        transport: 'stdio',
        command: 'npx',
        args: ['safe@1.0.0'],
        env: { API_TOKEN: 'local-secret-value' },
      },
      { kind: 'mcp-server', name: 'secretive', scope: 'user' },
    );
    const priorUmask = process.umask(0o022);
    try {
      await applyChanges(
        [toPlannedChange('claude-code', 'install', 'secretive', 'user', rendered)],
        (_change, content) => adapter.validate(content),
        { fleetHome: home },
      );
    } finally {
      process.umask(priorUmask);
    }
    assert.equal(statSync(claudeJson).mode & 0o777, 0o600);
    assert.equal(statSync(configDir).mode & 0o777, 0o700);
    assert.match(readFileSync(claudeJson, 'utf8'), /local-secret-value/);
  }),
);

test(
  'claude writer: remove deletes the entry, leaves others',
  withTempDir(async (dir) => {
    const claudeJson = join(dir, '.claude.json');
    writeFileSync(
      claudeJson,
      JSON.stringify({ mcpServers: { existing: { command: 'keep' }, gone: { command: 'x' } } }, null, 2),
    );
    const home = join(dir, 'fleet-home');
    const a = new ClaudeCodeAdapter(claudeJson, join(dir, '_sk'));
    const r = await a.renderRemove({ kind: 'mcp-server', name: 'gone', scope: 'user' });
    await applyChanges([toPlannedChange('claude-code', 'remove', 'gone', 'user', r)], jsonValidate, {
      fleetHome: home,
    });
    const doc = JSON.parse(readFileSync(claudeJson, 'utf8'));
    assert.equal(doc.mcpServers.gone, undefined);
    assert.equal(doc.mcpServers.existing.command, 'keep');
  }),
);

test(
  'engine: refuses to clobber an existing file that does not parse',
  withTempDir(async (dir) => {
    const target = join(dir, 'broken.json');
    writeFileSync(target, '{ this is : not json');
    const home = join(dir, 'fleet-home');
    const change: PlannedChange = {
      agent: 'x',
      op: 'install',
      name: 'n',
      scope: 'user',
      file: target,
      newContent: JSON.stringify({ mcpServers: {} }, null, 2) + '\n',
      baseHash: sha256('{ this is : not json'), // plan saw the (broken) file
    };
    await assert.rejects(applyChanges([change], jsonValidate, { fleetHome: home }), /does not parse/);
    assert.equal(readFileSync(target, 'utf8'), '{ this is : not json'); // untouched
  }),
);

test(
  'engine: refuses to apply if the file changed since the plan (hash guard)',
  withTempDir(async (dir) => {
    const claudeJson = join(dir, '.claude.json');
    seedClaude(claudeJson);
    const home = join(dir, 'fleet-home');
    const a = new ClaudeCodeAdapter(claudeJson, join(dir, '_sk'));
    const r = await a.renderInstall(
      { transport: 'stdio', command: 'npx' },
      { kind: 'mcp-server', name: 'late', scope: 'user' },
    );
    // a concurrent writer changes the file after the plan was rendered
    writeFileSync(claudeJson, JSON.stringify({ mcpServers: { other: { command: 'z' } } }, null, 2));
    await assert.rejects(
      applyChanges([toPlannedChange('claude-code', 'install', 'late', 'user', r)], (_c, c) => a.validate(c), {
        fleetHome: home,
      }),
      /changed since the plan/,
    );
    // the concurrent write is intact; nothing clobbered
    const doc = JSON.parse(readFileSync(claudeJson, 'utf8'));
    assert.equal(doc.mcpServers.other.command, 'z');
    assert.equal(doc.mcpServers.late, undefined);
  }),
);

test(
  'engine: no-clobber commit preserves a file created after the initial absent check',
  withTempDir(async (dir) => {
    const target = join(dir, 'new.json');
    const home = join(dir, 'fleet-home');
    const external = '{"external":true}';
    const change: PlannedChange = {
      agent: 'codex',
      op: 'install',
      name: 'new',
      kind: 'mcp-server',
      scope: 'user',
      file: target,
      newContent: '{"fleet":true}',
    };
    await assert.rejects(
      applyChanges(
        [change],
        (_change, content) => {
          JSON.parse(content);
          writeFileSync(target, external);
        },
        { fleetHome: home },
      ),
      /created during commit|refusing to overwrite/,
    );
    assert.equal(readFileSync(target, 'utf8'), external);
    assert.equal((await readAuditLedger(home)).status, 'not-present');
  }),
);

test(
  'engine: detach verification preserves an existing file edited during commit preparation',
  withTempDir(async (dir) => {
    const target = join(dir, 'existing.json');
    const home = join(dir, 'fleet-home');
    const original = '{"version":0}';
    const external = '{"external":true}';
    const desired = '{"version":1}';
    writeFileSync(target, original);
    let validations = 0;
    await assert.rejects(
      applyChanges(
        [
          {
            agent: 'codex',
            op: 'update',
            name: 'existing',
            kind: 'mcp-server',
            scope: 'user',
            file: target,
            newContent: desired,
            baseHash: sha256(original),
          },
        ],
        (_change, content) => {
          JSON.parse(content);
          validations += 1;
          if (validations === 2) writeFileSync(target, external);
        },
        { fleetHome: home },
      ),
      /changed before commit/,
    );
    assert.equal(readFileSync(target, 'utf8'), external);
    assert.equal((await readAuditLedger(home)).status, 'not-present');
  }),
);

test(
  'engine: detach recovery recognizes and restores a dangling symlink pathname',
  withTempDir(async (dir) => {
    const target = join(dir, 'existing.json');
    const home = join(dir, 'fleet-home');
    const original = '{"version":0}';
    writeFileSync(target, original);
    let validations = 0;
    await assert.rejects(
      applyChanges(
        [
          {
            agent: 'codex',
            op: 'update',
            name: 'existing',
            kind: 'mcp-server',
            scope: 'user',
            file: target,
            newContent: '{"version":1}',
            baseHash: sha256(original),
          },
        ],
        (_change, content) => {
          JSON.parse(content);
          validations += 1;
          if (validations === 2) {
            rmSync(target);
            symlinkSync('missing-config.json', target);
          }
        },
        { fleetHome: home },
      ),
      /symbolic link|ELOOP|changed before commit/,
    );
    assert.equal(lstatSync(target).isSymbolicLink(), true);
    assert.equal(readlinkSync(target), 'missing-config.json');
    assert.equal((await readAuditLedger(home)).status, 'not-present');
  }),
);

test(
  'directory publication refuses an already-created empty target without replacing it',
  withTempDir(async (dir) => {
    const stage = join(dir, 'stage');
    const target = join(dir, 'target');
    mkdirSync(stage);
    writeFileSync(join(stage, 'SKILL.md'), '# staged');
    mkdirSync(target, { mode: 0o701 });
    await assert.rejects(publishDirectoryNoClobber(stage, target), /EEXIST/);
    assert.equal(existsSync(join(stage, 'SKILL.md')), true);
    assert.equal(statSync(target).mode & 0o7777, 0o701);
    assert.deepEqual(readFileSync(join(stage, 'SKILL.md'), 'utf8'), '# staged');
  }),
);

test(
  'engine: rendered-content validation refuses an existing target before mutation',
  withTempDir(async (dir) => {
    const claudeJson = join(dir, '.claude.json');
    seedClaude(claudeJson);
    const home = join(dir, 'fleet-home');
    const bad: PlannedChange = {
      agent: 'claude-code',
      op: 'install',
      name: 'bad',
      scope: 'user',
      file: claudeJson,
      newContent: 'NOT JSON',
      baseHash: sha256(readFileSync(claudeJson, 'utf8')), // plan saw the seeded file
    };
    await assert.rejects(
      applyChanges([bad], jsonValidate, { fleetHome: home }),
      /rendered content does not parse/,
    );
    const doc = JSON.parse(readFileSync(claudeJson, 'utf8'));
    assert.equal(doc.mcpServers.existing.command, 'keep');
  }),
);

test(
  'engine: rendered-content validation refuses a new target before creation',
  withTempDir(async (dir) => {
    const newPath = join(dir, 'brand-new.json');
    const home = join(dir, 'fleet-home');
    const bad: PlannedChange = {
      agent: 'x',
      op: 'install',
      name: 'bad',
      scope: 'user',
      file: newPath,
      newContent: 'NOT JSON',
    };
    await assert.rejects(
      applyChanges([bad], jsonValidate, { fleetHome: home }),
      /rendered content does not parse/,
    );
    assert.equal(existsSync(newPath), false);
  }),
);

test(
  'rollback: restores prior content for an edited file',
  withTempDir(async (dir) => {
    const claudeJson = join(dir, '.claude.json');
    seedClaude(claudeJson);
    const original = readFileSync(claudeJson, 'utf8');
    const home = join(dir, 'fleet-home');
    const a = new ClaudeCodeAdapter(claudeJson, join(dir, '_sk'));
    const r = await a.renderInstall(
      { transport: 'stdio', command: 'npx' },
      { kind: 'mcp-server', name: 'tmp', scope: 'user' },
    );
    await applyChanges(
      [toPlannedChange('claude-code', 'install', 'tmp', 'user', r)],
      (_c, c) => a.validate(c),
      {
        fleetHome: home,
      },
    );
    assert.notEqual(readFileSync(claudeJson, 'utf8'), original);

    const res = await rollback({ fleetHome: home });
    assert.equal(res.action, 'restored');
    assert.equal(readFileSync(claudeJson, 'utf8'), original);
    assert.equal((await readAudit(home)).at(-1)!.op, 'rollback');
  }),
);

test(
  'rollback: removes a file the change had created',
  withTempDir(async (dir) => {
    const created = join(dir, 'created.json');
    const home = join(dir, 'fleet-home');
    const change: PlannedChange = {
      agent: 'claude-code',
      op: 'install',
      name: 'x',
      scope: 'user',
      file: created,
      newContent: JSON.stringify({ mcpServers: { x: { command: 'c' } } }, null, 2) + '\n',
    };
    await applyChanges([change], jsonValidate, { fleetHome: home });
    assert.ok(existsSync(created));
    const res = await rollback({ fleetHome: home });
    assert.equal(res.action, 'removed');
    assert.equal(existsSync(created), false);
  }),
);

test(
  'rollback: refuses an older audit id when a newer active change recreated its hash',
  withTempDir(async (dir) => {
    const file = join(dir, 'shared.json');
    const home = join(dir, 'fleet-home');
    const v0 = '{"version":0}';
    const v1 = '{"version":1}';
    const v2 = '{"version":2}';
    writeFileSync(file, v0);

    const applyVersion = async (name: string, before: string, after: string) => {
      const [result] = await applyChanges(
        [
          {
            agent: 'codex',
            op: 'update',
            name,
            kind: 'mcp-server',
            scope: 'user',
            file,
            newContent: after,
            baseHash: sha256(before),
          },
        ],
        jsonValidate,
        { fleetHome: home },
      );
      return result!;
    };

    const first = await applyVersion('first', v0, v1);
    const second = await applyVersion('second', v1, v2);
    const third = await applyVersion('third', v2, v1);

    await assert.rejects(
      rollback({ fleetHome: home, auditId: first.auditId }),
      /newer active change for the same state/,
    );
    assert.equal(readFileSync(file, 'utf8'), v1, 'the recreated hash must not bypass ordering');

    assert.equal((await rollback({ fleetHome: home, auditId: third.auditId })).action, 'restored');
    assert.equal(readFileSync(file, 'utf8'), v2);
    assert.equal((await rollback({ fleetHome: home, auditId: second.auditId })).action, 'restored');
    assert.equal(readFileSync(file, 'utf8'), v1);
    assert.equal((await rollback({ fleetHome: home, auditId: first.auditId })).action, 'restored');
    assert.equal(readFileSync(file, 'utf8'), v0);
  }),
);

test(
  'rollback: skips removing a created file that has since diverged',
  withTempDir(async (dir) => {
    const created = join(dir, 'created.json');
    const home = join(dir, 'fleet-home');
    const change: PlannedChange = {
      agent: 'claude-code',
      op: 'install',
      name: 'x',
      scope: 'user',
      file: created,
      newContent: JSON.stringify({ mcpServers: { x: { command: 'c' } } }, null, 2) + '\n',
    };
    await applyChanges([change], jsonValidate, { fleetHome: home });
    const fleetWritten = readFileSync(created, 'utf8');
    const originalAudit = await readAudit(home);
    // the user/agent later populates the file fleet created
    writeFileSync(
      created,
      JSON.stringify({ mcpServers: { x: { command: 'c' }, more: { command: 'd' } } }, null, 2),
    );
    const res = await rollback({ fleetHome: home });
    assert.equal(res.action, 'skipped');
    assert.ok(existsSync(created)); // not destroyed
    assert.deepEqual(await readAudit(home), originalAudit); // no false rollback edge

    // Once the exact Fleet-written state is restored, the same change remains
    // eligible and can be rolled back safely.
    writeFileSync(created, fleetWritten);
    assert.equal((await rollback({ fleetHome: home })).action, 'removed');
    assert.equal(existsSync(created), false);
  }),
);

test(
  'readAudit: tolerates a corrupt line',
  withTempDir(async (dir) => {
    const home = join(dir, 'fleet-home');
    const claudeJson = join(dir, '.claude.json');
    seedClaude(claudeJson);
    const a = new ClaudeCodeAdapter(claudeJson, join(dir, '_sk'));
    const r = await a.renderInstall(
      { transport: 'stdio', command: 'npx' },
      { kind: 'mcp-server', name: 'ok', scope: 'user' },
    );
    await applyChanges(
      [toPlannedChange('claude-code', 'install', 'ok', 'user', r)],
      (_c, c) => a.validate(c),
      {
        fleetHome: home,
      },
    );
    // corrupt the audit log with a partial line
    writeFileSync(join(home, 'audit.jsonl'), readFileSync(join(home, 'audit.jsonl'), 'utf8') + '{ broken\n');
    const audit = await readAudit(home);
    assert.equal(audit.length, 1); // the good record survives
    const refused = join(dir, 'must-not-be-created.json');
    await assert.rejects(
      applyChanges(
        [
          {
            agent: 'claude-code',
            op: 'install',
            name: 'refused',
            scope: 'user',
            file: refused,
            newContent: '{}',
          },
        ],
        jsonValidate,
        { fleetHome: home },
      ),
      /audit history is unavailable, malformed, or incomplete/,
    );
    assert.equal(existsSync(refused), false);
    await assert.rejects(rollback({ fleetHome: home }), /audit history is unavailable.*incomplete/);
    await assert.rejects(
      rollback({ fleetHome: home, auditId: audit[0]!.id }),
      /audit history is unavailable.*ambiguous/,
    );
  }),
);

test(
  'rollback: duplicate audit ids make the complete history ambiguous',
  withTempDir(async (dir) => {
    const home = join(dir, 'fleet-home');
    const file = join(dir, 'target.json');
    const [applied] = await applyChanges(
      [
        {
          agent: 'codex',
          op: 'install',
          name: 'target',
          kind: 'mcp-server',
          scope: 'user',
          file,
          newContent: '{}',
        },
      ],
      jsonValidate,
      { fleetHome: home },
    );
    const auditFile = join(home, 'audit.jsonl');
    const first = JSON.parse(readFileSync(auditFile, 'utf8'));
    writeFileSync(
      auditFile,
      `${JSON.stringify(first)}\n${JSON.stringify({ ...first, file: join(dir, 'other.json') })}\n`,
    );

    assert.equal((await readAuditLedger(home)).status, 'malformed');
    await assert.rejects(
      rollback({ fleetHome: home, auditId: applied!.auditId }),
      /audit history is unavailable.*ambiguous/,
    );
    assert.equal(readFileSync(file, 'utf8'), '{}');
  }),
);

test(
  'rollback: semantic audit corruption cannot authorize removing an arbitrary target',
  withTempDir(async (dir) => {
    const home = join(dir, 'fleet-home');
    const victim = join(dir, 'victim.json');
    const content = '{"keep":true}';
    writeFileSync(victim, content, { mode: 0o600 });
    mkdirSync(home, { recursive: true });
    writeFileSync(
      join(home, 'audit.jsonl'),
      JSON.stringify({
        id: '00000000-0000-4000-8000-000000000001',
        ts: Date.now(),
        op: 'install',
        agent: 'codex',
        name: 'victim',
        kind: 'NOT_A_KIND',
        scope: 'NOT_A_SCOPE',
        file: victim,
        backup: '',
        existedBefore: false,
        wroteHash: sha256(content),
        wroteMode: 0o600,
        rolledBackFrom: '00000000-0000-4000-8000-000000000002',
      }) + '\n',
    );
    assert.equal((await readAuditLedger(home)).status, 'malformed');
    await assert.rejects(
      rollback({ fleetHome: home, auditId: '00000000-0000-4000-8000-000000000001' }),
      /audit history is unavailable.*ambiguous/,
    );
    assert.equal(readFileSync(victim, 'utf8'), content);
  }),
);

test(
  'rollback: a mismatched cross-record rollback edge cannot hide a newer mutation',
  withTempDir(async (dir) => {
    const home = join(dir, 'fleet-home');
    const victim = join(dir, 'victim.json');
    const other = join(dir, 'other.json');
    const content = '{"keep":true}';
    const wroteHash = sha256(content);
    const olderId = '00000000-0000-4000-8000-000000000001';
    const newerId = '00000000-0000-4000-8000-000000000002';
    writeFileSync(victim, content, { mode: 0o600 });
    mkdirSync(home, { recursive: true });
    const common = {
      agent: 'codex',
      name: 'victim',
      kind: 'mcp-server',
      file: victim,
      scope: 'user',
      backup: '',
      wroteHash,
      wroteMode: 0o600,
    } as const;
    const records = [
      { ...common, id: olderId, ts: 1, op: 'install', existedBefore: false },
      { ...common, id: newerId, ts: 2, op: 'update', existedBefore: true },
      {
        id: '00000000-0000-4000-8000-000000000003',
        ts: 3,
        op: 'rollback',
        agent: 'codex',
        name: 'other',
        kind: 'mcp-server',
        file: other,
        scope: 'user',
        backup: '',
        existedBefore: true,
        wroteHash,
        rolledBackFrom: newerId,
      },
    ];
    writeFileSync(
      join(home, 'audit.jsonl'),
      records.map((record) => JSON.stringify(record)).join('\n') + '\n',
    );

    assert.equal((await readAuditLedger(home)).status, 'malformed');
    await assert.rejects(
      rollback({ fleetHome: home, auditId: olderId }),
      /audit history is unavailable.*ambiguous/,
    );
    assert.equal(readFileSync(victim, 'utf8'), content);
  }),
);

test(
  'audit history accepts legacy rollback rows that omitted derived kind and directory fields',
  withTempDir(async (dir) => {
    const home = join(dir, 'fleet-home');
    mkdirSync(home, { recursive: true });
    const id = (suffix: number) => `00000000-0000-4000-8000-${String(suffix).padStart(12, '0')}`;
    const hash = 'a'.repeat(64);
    const pairs = [
      {
        target: {
          id: id(1),
          ts: 1,
          op: 'install',
          agent: 'codex',
          name: 'file-install',
          kind: 'mcp-server',
          file: join(dir, 'file.json'),
          scope: 'user',
          backup: '',
          existedBefore: false,
          wroteHash: hash,
        },
        rollbackId: id(2),
      },
      {
        target: {
          id: id(3),
          ts: 3,
          op: 'install',
          agent: 'codex',
          name: 'dir-install',
          kind: 'skill',
          file: join(dir, 'dir-install'),
          scope: 'user',
          backup: '',
          existedBefore: false,
          wroteHash: hash,
          isDir: true,
        },
        rollbackId: id(4),
      },
      {
        target: {
          id: id(5),
          ts: 5,
          op: 'remove',
          agent: 'codex',
          name: 'dir-remove',
          kind: 'skill',
          file: join(dir, 'dir-remove'),
          scope: 'user',
          backup: join(home, 'backups', 'dir-remove'),
          existedBefore: true,
          wroteHash: '',
          isDir: true,
        },
        rollbackId: id(6),
      },
    ];
    const records = pairs.flatMap(({ target, rollbackId }) => [
      target,
      {
        id: rollbackId,
        ts: target.ts + 1,
        op: 'rollback',
        agent: target.agent,
        name: target.name,
        file: target.file,
        scope: target.scope,
        backup: '',
        existedBefore: target.existedBefore,
        wroteHash: target.wroteHash,
        rolledBackFrom: target.id,
      },
    ]);
    writeFileSync(
      join(home, 'audit.jsonl'),
      records.map((record) => JSON.stringify(record)).join('\n') + '\n',
    );

    const audit = await readAuditLedger(home);
    assert.equal(audit.status, 'available');
    assert.equal(audit.records.length, 6);
  }),
);

test(
  'apply: a symlinked audit ledger is refused before target mutation',
  withTempDir(async (dir) => {
    const home = join(dir, 'fleet-home');
    const external = join(dir, 'external-audit');
    const target = join(dir, 'target.json');
    mkdirSync(home);
    writeFileSync(external, '{"sentinel":true}\n');
    symlinkSync(external, join(home, 'audit.jsonl'));
    await assert.rejects(
      applyChanges(
        [
          {
            agent: 'claude-code',
            op: 'install',
            name: 'target',
            scope: 'user',
            file: target,
            newContent: '{}',
          },
        ],
        jsonValidate,
        { fleetHome: home },
      ),
      /audit history is unavailable/,
    );
    assert.equal(existsSync(target), false);
    assert.equal(readFileSync(external, 'utf8'), '{"sentinel":true}\n');
  }),
);

test(
  'apply: a dangling audit-ledger symlink is unavailable rather than absent',
  withTempDir(async (dir) => {
    const home = join(dir, 'fleet-home');
    const target = join(dir, 'target.json');
    mkdirSync(home);
    symlinkSync(join(dir, 'missing-audit'), join(home, 'audit.jsonl'));
    await assert.rejects(
      applyChanges(
        [
          {
            agent: 'claude-code',
            op: 'install',
            name: 'target',
            scope: 'user',
            file: target,
            newContent: '{}',
          },
        ],
        jsonValidate,
        { fleetHome: home },
      ),
      /audit history is unavailable/,
    );
    assert.equal(existsSync(target), false);
  }),
);

test(
  'apply: audit append failure marks the real mutation as unrecorded',
  withTempDir(async (dir) => {
    const home = join(dir, 'fleet-home');
    const audit = join(home, 'audit.jsonl');
    const firstFile = join(dir, 'first.json');
    await applyChanges(
      [
        {
          agent: 'claude-code',
          op: 'install',
          name: 'first',
          scope: 'user',
          file: firstFile,
          newContent: '{}',
        },
      ],
      jsonValidate,
      { fleetHome: home },
    );
    chmodSync(audit, 0o400);
    const secondFile = join(dir, 'second.json');
    let failure: (Error & { applied?: import('../src/core/writer.js').ApplyResult[] }) | undefined;
    try {
      await applyChanges(
        [
          {
            agent: 'codex',
            op: 'install',
            name: 'second',
            scope: 'user',
            file: secondFile,
            newContent: '{}',
          },
        ],
        jsonValidate,
        { fleetHome: home },
      );
    } catch (error) {
      failure = error as Error & { applied?: import('../src/core/writer.js').ApplyResult[] };
    } finally {
      chmodSync(audit, 0o600);
    }
    assert.match(failure?.message ?? '', /automatic rollback unavailable/);
    assert.equal(failure?.applied?.length, 1);
    assert.equal(failure?.applied?.[0]?.auditRecorded, false);
    assert.equal(existsSync(secondFile), true, 'the mutation really happened');
    assert.equal((await readAudit(home)).length, 1, 'no fake audit id was persisted');
    assert.equal((await readAuditLedger(home)).status, 'incomplete');
    await assert.rejects(rollback({ fleetHome: home }), /audit history is unavailable.*incomplete/);
    assert.equal(existsSync(firstFile), true, 'implicit rollback must not cross the pending mutation');
  }),
);

test(
  'rollback: reports completed filesystem action when only audit append fails',
  withTempDir(async (dir) => {
    const home = join(dir, 'fleet-home');
    const file = join(dir, 'created.json');
    const [applied] = await applyChanges(
      [
        {
          agent: 'claude-code',
          op: 'install',
          name: 'created',
          scope: 'user',
          file,
          newContent: '{}',
        },
      ],
      jsonValidate,
      { fleetHome: home },
    );
    const audit = join(home, 'audit.jsonl');
    chmodSync(audit, 0o400);
    const result = await rollback({ fleetHome: home, auditId: applied!.auditId });
    chmodSync(audit, 0o600);
    assert.equal(result.action, 'removed');
    assert.equal(result.auditRecorded, false);
    assert.match(result.reason ?? '', /audit log write failed/);
    assert.equal(existsSync(file), false, 'rollback completed despite provenance failure');
    assert.equal(
      (await readAuditLedger(home)).status,
      'incomplete',
      'write-ahead rollback marker must preserve the unknown provenance boundary',
    );
  }),
);

test(
  'rollback: refuses a backup whose recorded bytes or topology changed',
  withTempDir(async (dir) => {
    const home = join(dir, 'fleet-home');
    const file = join(dir, 'config.json');
    writeFileSync(file, '{"before":true}');
    const [applied] = await applyChanges(
      [
        {
          agent: 'claude-code',
          op: 'update',
          name: 'config',
          scope: 'user',
          file,
          newContent: '{"after":true}',
          baseHash: sha256('{"before":true}'),
        },
      ],
      jsonValidate,
      { fleetHome: home },
    );
    writeFileSync(applied!.backup, '{"tampered":true}');
    const result = await rollback({ fleetHome: home, auditId: applied!.auditId });
    assert.equal(result.action, 'skipped');
    assert.match(result.reason ?? '', /backup hash mismatch/);
    assert.equal(readFileSync(file, 'utf8'), '{"after":true}');
  }),
);

test(
  'implicit rollback guard and filesystem undo share one mutation lock',
  withTempDir(async (dir) => {
    const home = join(dir, 'fleet-home');
    const file = join(dir, 'created.json');
    await applyChanges(
      [
        {
          agent: 'codex',
          op: 'install',
          name: 'created',
          scope: 'user',
          file,
          newContent: '{}',
        },
      ],
      jsonValidate,
      { fleetHome: home },
    );
    let entered!: () => void;
    const guardEntered = new Promise<void>((resolve) => (entered = resolve));
    let resume!: () => void;
    const guardResume = new Promise<void>((resolve) => (resume = resolve));
    const { assessImplicitRollback } = await import('../src/core/rollback-guard.js');
    const rollingBack = rollback({
      fleetHome: home,
      implicitGuard: async (audit) => {
        entered();
        await guardResume;
        return assessImplicitRollback(audit, home);
      },
    });
    await guardEntered;

    const { planPluginAction, runDelegated } = await import('../src/core/delegate.js');
    const plan = planPluginAction('codex', 'install', 'safe-plugin');
    plan.preState = 'absent';
    plan.readPluginState = async () => 'absent';
    let vendorCalls = 0;
    await assert.rejects(
      runDelegated(plan, {
        commit: true,
        fleetHome: home,
        runner: async () => {
          vendorCalls++;
          return { exitCode: 0, output: '' };
        },
      }),
      /another operation holds the lock/,
    );
    assert.equal(vendorCalls, 0);
    resume();
    assert.equal((await rollingBack).action, 'removed');
    assert.equal(existsSync(file), false);
  }),
);

test(
  'apply keeps the shared mutation lock until state metadata is durably folded',
  withTempDir(async (dir) => {
    const home = join(dir, 'fleet-home');
    let metadataStarted!: () => void;
    const started = new Promise<void>((resolve) => (metadataStarted = resolve));
    let finishMetadata!: () => void;
    const finish = new Promise<void>((resolve) => (finishMetadata = resolve));
    const first = applyChanges(
      [
        {
          agent: 'claude-code',
          op: 'install',
          name: 'first',
          scope: 'user',
          file: join(dir, 'first.json'),
          newContent: '{}',
        },
      ],
      jsonValidate,
      {
        fleetHome: home,
        whileLocked: async () => {
          metadataStarted();
          await finish;
        },
      },
    );
    await started;
    await assert.rejects(
      applyChanges(
        [
          {
            agent: 'codex',
            op: 'install',
            name: 'second',
            scope: 'user',
            file: join(dir, 'second.json'),
            newContent: '{}',
          },
        ],
        jsonValidate,
        { fleetHome: home },
      ),
      /another operation holds the lock/,
    );
    finishMetadata();
    await first;
  }),
);

test(
  'claude writer: warns on unexpressible auth and rejects unsupported scope',
  withTempDir(async (dir) => {
    const claudeJson = join(dir, '.claude.json');
    seedClaude(claudeJson);
    const a = new ClaudeCodeAdapter(claudeJson, join(dir, '_sk'));

    const remote = await a.renderInstall(
      { transport: 'http', url: 'https://x.test', bearerTokenEnvVar: 'TOK' },
      { kind: 'mcp-server', name: 'r', scope: 'user' },
    );
    assert.ok(remote.warnings?.some((w) => /bearer/.test(w)));

    await assert.rejects(
      a.renderInstall(
        { transport: 'stdio', command: 'c' },
        { kind: 'mcp-server', name: 's', scope: 'project' },
      ),
      /read-only/,
    );
  }),
);
