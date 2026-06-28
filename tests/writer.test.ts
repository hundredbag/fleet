import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ClaudeCodeAdapter } from '../src/adapters/claude-code.js';
import {
  applyChanges,
  rollback,
  readAudit,
  toPlannedChange,
  type ChangeValidator,
  type PlannedChange,
} from '../src/core/writer.js';

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
    JSON.stringify(
      { hasCompletedOnboarding: true, mcpServers: { existing: { command: 'keep' } } },
      null,
      2,
    ),
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
    const a = new ClaudeCodeAdapter(claudeJson);

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
    const a = new ClaudeCodeAdapter(claudeJson);
    const r = await a.renderInstall(
      { transport: 'http', url: 'https://x.test/mcp' },
      { kind: 'mcp-server', name: 'remote', scope: 'user' },
    );
    await applyChanges([toPlannedChange('claude-code', 'install', 'remote', 'user', r)], jsonValidate, {
      fleetHome: home,
    });
    const items = await a.readInventory();
    const remote = items.find((i) => i.name === 'remote');
    assert.equal(remote?.spec.transport, 'http');
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
    const a = new ClaudeCodeAdapter(claudeJson);
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
    const a = new ClaudeCodeAdapter(claudeJson);
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
  'engine: validation failure restores the backup (file existed)',
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
    };
    await assert.rejects(applyChanges([bad], jsonValidate, { fleetHome: home }), /validation failed/);
    const doc = JSON.parse(readFileSync(claudeJson, 'utf8'));
    assert.equal(doc.mcpServers.existing.command, 'keep');
  }),
);

test(
  'engine: validation failure removes a newly-created file',
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
    await assert.rejects(applyChanges([bad], jsonValidate, { fleetHome: home }), /removed created file/);
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
    const a = new ClaudeCodeAdapter(claudeJson);
    const r = await a.renderInstall(
      { transport: 'stdio', command: 'npx' },
      { kind: 'mcp-server', name: 'tmp', scope: 'user' },
    );
    await applyChanges([toPlannedChange('claude-code', 'install', 'tmp', 'user', r)], (_c, c) => a.validate(c), {
      fleetHome: home,
    });
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
    // the user/agent later populates the file fleet created
    writeFileSync(created, JSON.stringify({ mcpServers: { x: { command: 'c' }, more: { command: 'd' } } }, null, 2));
    const res = await rollback({ fleetHome: home });
    assert.equal(res.action, 'skipped');
    assert.ok(existsSync(created)); // not destroyed
  }),
);

test(
  'readAudit: tolerates a corrupt line',
  withTempDir(async (dir) => {
    const home = join(dir, 'fleet-home');
    const claudeJson = join(dir, '.claude.json');
    seedClaude(claudeJson);
    const a = new ClaudeCodeAdapter(claudeJson);
    const r = await a.renderInstall(
      { transport: 'stdio', command: 'npx' },
      { kind: 'mcp-server', name: 'ok', scope: 'user' },
    );
    await applyChanges([toPlannedChange('claude-code', 'install', 'ok', 'user', r)], (_c, c) => a.validate(c), {
      fleetHome: home,
    });
    // corrupt the audit log with a partial line
    writeFileSync(join(home, 'audit.jsonl'), readFileSync(join(home, 'audit.jsonl'), 'utf8') + '{ broken\n');
    const audit = await readAudit(home);
    assert.equal(audit.length, 1); // the good record survives
  }),
);

test(
  'claude writer: warns on unexpressible auth and unsupported scope',
  withTempDir(async (dir) => {
    const claudeJson = join(dir, '.claude.json');
    seedClaude(claudeJson);
    const a = new ClaudeCodeAdapter(claudeJson);

    const remote = await a.renderInstall(
      { transport: 'http', url: 'https://x.test', bearerTokenEnvVar: 'TOK' },
      { kind: 'mcp-server', name: 'r', scope: 'user' },
    );
    assert.ok(remote.warnings?.some((w) => /bearer/.test(w)));

    const scoped = await a.renderInstall(
      { transport: 'stdio', command: 'c' },
      { kind: 'mcp-server', name: 's', scope: 'project' },
    );
    assert.ok(scoped.warnings?.some((w) => /scope/.test(w)));
  }),
);
