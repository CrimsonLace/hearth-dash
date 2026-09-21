import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyPendingMigrations, freshMigrationBaselineSql, hasRequiredOAuthCsrfColumns, hasRequiredSchemaTables, parseAppliedMigrations,
  parseD1CreateOutput, parseDeployOutput, parseKvCreateOutput, pendingMigrationFiles, provisionAfterVerifiedSchema,
} from '../cli/lib/wrangler.js';

test('parses Cloudflare storage and deployment output', () => {
  assert.equal(parseD1CreateOutput({ stdout: 'database_id = "12345678-1234-1234-1234-123456789abc"', stderr: '' }), '12345678-1234-1234-1234-123456789abc');
  assert.equal(parseKvCreateOutput({ stdout: 'id = "0123456789abcdef0123456789abcdef"', stderr: '' }), '0123456789abcdef0123456789abcdef');
  assert.equal(parseKvCreateOutput({ stdout: '{"id":"fedcba9876543210fedcba9876543210"}', stderr: '' }), 'fedcba9876543210fedcba9876543210');
  assert.equal(parseDeployOutput({ stdout: 'Published at https://hearth-dash.example.workers.dev', stderr: '' }), 'https://hearth-dash.example.workers.dev');
});

test('returns null rather than inventing missing Cloudflare identifiers', () => {
  assert.equal(parseD1CreateOutput({ stdout: 'created', stderr: '' }), null);
  assert.equal(parseKvCreateOutput({ stdout: 'created', stderr: '' }), null);
  assert.equal(parseDeployOutput({ stdout: 'deployed', stderr: '' }), null);
});

test('verifies all required remote schema tables from Wrangler JSON', () => {
  const output = JSON.stringify([{ results: [{ name: 'oauth_csrf_tokens' }, { name: 'rate_limits' }], success: true }]);
  assert.equal(hasRequiredSchemaTables(output, ['rate_limits', 'oauth_csrf_tokens']), true);
  assert.equal(hasRequiredSchemaTables(output, ['rate_limits', 'missing']), false);
  assert.equal(hasRequiredSchemaTables('not-json', ['rate_limits']), false);
});

test('verifies the security-critical OAuth CSRF table shape', () => {
  const valid = JSON.stringify([{ results: [
    { name: 'token', type: 'TEXT', notnull: 0, pk: 1 },
    { name: 'request_fingerprint', type: 'TEXT', notnull: 1, pk: 0 },
    { name: 'expires_at', type: 'INTEGER', notnull: 1, pk: 0 },
  ] }]);
  assert.equal(hasRequiredOAuthCsrfColumns(valid), true);
  assert.equal(hasRequiredOAuthCsrfColumns(valid.replace('"pk":1', '"pk":0')), false);
  assert.equal(hasRequiredOAuthCsrfColumns(valid.replace('"notnull":1', '"notnull":0')), false);
  assert.equal(hasRequiredOAuthCsrfColumns(JSON.stringify([{ results: [{ name: 'token', type: 'TEXT', pk: 1 }] }])), false);
});

test('never provisions code before schema application and verification', async () => {
  const order = [];
  const success = await provisionAfterVerifiedSchema({
    async applySchema() { order.push('schema'); return { ok: true }; },
    async verifySchema() { order.push('verify'); return true; },
    async provisionWorker() { order.push('provision'); return { code: 0 }; },
  });
  assert.equal(success.ok, true);
  assert.deepEqual(order, ['schema', 'verify', 'provision']);

  for (const failure of ['schema', 'verify']) {
    const calls = [];
    const result = await provisionAfterVerifiedSchema({
      async applySchema() { calls.push('schema'); return { ok: failure !== 'schema' }; },
      async verifySchema() { calls.push('verify'); return failure !== 'verify'; },
      async provisionWorker() { calls.push('provision'); return { code: 0 }; },
    });
    assert.equal(result.ok, false);
    assert.ok(!calls.includes('provision'), failure);
  }
});

test('selects numbered migrations once and in order', async () => {
  const applied = parseAppliedMigrations(JSON.stringify([{ results: [{ version: '001_first' }] }]));
  assert.deepEqual(pendingMigrationFiles([
    'README.md', '003_third.sql', '001_first.sql', '002_second.sql',
  ], applied), ['002_second.sql', '003_third.sql']);

  const calls = [];
  const result = await applyPendingMigrations({
    files: ['002_second.sql', '001_first.sql'],
    applied: new Set(['001_first']),
    async applyFile(file) { calls.push(`apply:${file}`); return { ok: true }; },
    async record(version) { calls.push(`record:${version}`); return { ok: true }; },
  });
  assert.deepEqual(result, { ok: true, applied: ['002_second'] });
  assert.deepEqual(calls, ['apply:002_second.sql', 'record:002_second']);
});

test('builds one ordered fresh-install baseline statement', () => {
  assert.equal(
    freshMigrationBaselineSql(['002_second.sql', 'notes.txt', '001_first.sql']),
    "INSERT INTO hearth_migrations (version) VALUES ('001_first'), ('002_second') ON CONFLICT(version) DO NOTHING;",
  );
  assert.equal(freshMigrationBaselineSql(['notes.txt']), null);
});

test('fails closed when the remote migration ledger is malformed or unexpected', () => {
  assert.throws(() => parseAppliedMigrations('not-json'), /Could not parse the remote migration ledger response/);
  assert.throws(() => parseAppliedMigrations(JSON.stringify({ success: true })), /unexpected shape/);
  assert.throws(() => parseAppliedMigrations(JSON.stringify([{ results: [{ version: null }] }])), /invalid version/);
  assert.deepEqual(parseAppliedMigrations(JSON.stringify([{ results: [] }])), new Set());
});

test('stops migration processing before recording a failed migration', async () => {
  const calls = [];
  const result = await applyPendingMigrations({
    files: ['001_first.sql', '002_second.sql'],
    applied: new Set(),
    async applyFile(file) { calls.push(file); return { ok: file !== '001_first.sql', error: 'boom' }; },
    async record(version) { calls.push(`record:${version}`); return { ok: true }; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.version, '001_first');
  assert.deepEqual(calls, ['001_first.sql']);
});

test('fails closed before applying or recording an ambiguous migration state', async () => {
  const calls = [];
  const result = await applyPendingMigrations({
    files: ['002_second.sql'],
    applied: new Set(),
    async reconcile() { return { ok: false, error: 'schema mismatch' }; },
    async applyFile() { calls.push('apply'); return { ok: true }; },
    async record() { calls.push('record'); return { ok: true }; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.error, 'schema mismatch');
  assert.deepEqual(calls, []);
});
