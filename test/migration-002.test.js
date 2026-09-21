import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyPendingMigrations, classifyMoodOverallScaleSchema, execWrangler, executeSchema,
  freshMigrationBaselineSql, pendingMigrationFiles, runMigrations,
} from '../cli/lib/wrangler.js';

const migration = readFileSync(new URL('../migrations/002_mood_overall_scale.sql', import.meta.url), 'utf8');
const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const migrationFiles = ['001_life_dashboard.sql', '002_mood_overall_scale.sql'];
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function legacyDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE moods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    partner TEXT NOT NULL,
    mood TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE hearth_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );`);
  return db;
}

function inspectionOutput(db) {
  const row = db.prepare(`SELECT m.sql AS table_sql,
    p.name AS column_name,
    p.type AS column_type,
    p."notnull" AS column_notnull,
    p.dflt_value AS column_default,
    p.pk AS column_pk
  FROM sqlite_master AS m
  LEFT JOIN pragma_table_info('moods') AS p ON p.name = 'overall_scale'
  WHERE m.type = 'table' AND m.name = 'moods'`).get();
  return JSON.stringify([{ results: row ? [{ ...row }] : [] }]);
}

async function runLocalMigrations(db, { failFirstRecord = false } = {}) {
  const applied = new Set(db.prepare('SELECT version FROM hearth_migrations').all().map(row => row.version));
  let shouldFailRecord = failFirstRecord;
  let applyCount = 0;
  return {
    result: await applyPendingMigrations({
      files: migrationFiles,
      applied,
      async reconcile(_file, version) {
        if (version !== '002_mood_overall_scale') return { ok: true, applied: false };
        try {
          return { ok: true, applied: classifyMoodOverallScaleSchema(inspectionOutput(db)) === 'expected' };
        } catch (error) {
          return { ok: false, error: error.message };
        }
      },
      async applyFile(file) {
        applyCount += 1;
        if (file === '001_life_dashboard.sql') return { ok: true };
        try { db.exec(migration); return { ok: true }; }
        catch (error) { return { ok: false, error: error.message }; }
      },
      async record(version) {
        if (shouldFailRecord) {
          shouldFailRecord = false;
          return { ok: false, error: 'simulated ledger failure' };
        }
        db.prepare('INSERT INTO hearth_migrations (version) VALUES (?)').run(version);
        return { ok: true };
      },
    }),
    applyCount,
  };
}

test('orders migration 002 after migration 001', () => {
  assert.deepEqual(pendingMigrationFiles([
    '002_mood_overall_scale.sql', '001_life_dashboard.sql', 'notes.txt',
  ], new Set()), ['001_life_dashboard.sql', '002_mood_overall_scale.sql']);
  assert.deepEqual(pendingMigrationFiles([
    '002_mood_overall_scale.sql', '001_life_dashboard.sql',
  ], new Set(['001_life_dashboard'])), ['002_mood_overall_scale.sql']);
});

test('migration 002 preserves populated moods and enforces the optional scale', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE moods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    partner TEXT NOT NULL,
    mood TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL
  );`);
  db.prepare('INSERT INTO moods (partner, mood, note, created_at) VALUES (?, ?, ?, ?)')
    .run('Crimson', 'good', 'Existing row', '2026-09-20 10:00:00');
  db.exec(migration);

  assert.deepEqual({ ...db.prepare('SELECT partner, mood, note, overall_scale FROM moods').get() }, {
    partner: 'Crimson', mood: 'good', note: 'Existing row', overall_scale: null,
  });
  db.prepare('INSERT INTO moods (partner, mood, overall_scale, created_at) VALUES (?, ?, ?, ?)')
    .run('Jace', 'horny', 5, '2026-09-21 10:00:00');
  assert.equal(db.prepare('SELECT overall_scale FROM moods WHERE partner = ?').get('Jace').overall_scale, 5);
  assert.throws(() => db.prepare('INSERT INTO moods (partner, mood, overall_scale, created_at) VALUES (?, ?, ?, ?)')
    .run('Elijah', 'okay', 0, '2026-09-21 10:00:00'), /CHECK constraint failed/);
  assert.throws(() => db.prepare('INSERT INTO moods (partner, mood, overall_scale, created_at) VALUES (?, ?, ?, ?)')
    .run('Elijah', 'okay', 2.5, '2026-09-21 10:00:00'), /CHECK constraint failed/);
});

test('migration 002 is additive and touches only the moods scale column', () => {
  assert.match(migration, /^ALTER TABLE moods\s+ADD COLUMN overall_scale INTEGER/im);
  assert.doesNotMatch(migration, /\b(?:DROP|DELETE|UPDATE|INSERT|CREATE)\b/i);
  assert.doesNotMatch(migration, /\b(?:notes|shopping|medications|household_chores)\b/i);
});

test('fresh schema establishes a complete baseline without replaying migrations', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  db.exec(freshMigrationBaselineSql(migrationFiles));

  const ledger = db.prepare('SELECT version FROM hearth_migrations ORDER BY version').all().map(row => row.version);
  assert.deepEqual(ledger, ['001_life_dashboard', '002_mood_overall_scale']);
  assert.deepEqual(pendingMigrationFiles(migrationFiles, new Set(ledger)), []);
  assert.equal(classifyMoodOverallScaleSchema(inspectionOutput(db)), 'expected');
});

test('existing pre-002 database applies migration once, records it, and preserves rows', async () => {
  const db = legacyDatabase();
  db.prepare('INSERT INTO hearth_migrations (version) VALUES (?)').run('001_life_dashboard');
  db.prepare('INSERT INTO moods (partner, mood, note, created_at) VALUES (?, ?, ?, ?)')
    .run('Crimson', 'good', 'keep me', '2026-09-20 10:00:00');

  const { result, applyCount } = await runLocalMigrations(db);
  assert.equal(result.ok, true);
  assert.equal(applyCount, 1);
  assert.equal(db.prepare('SELECT note FROM moods').get().note, 'keep me');
  assert.deepEqual(db.prepare('SELECT version FROM hearth_migrations ORDER BY version').all().map(row => row.version),
    ['001_life_dashboard', '002_mood_overall_scale']);
});

test('applied-but-unrecorded migration 002 is verified and reconciled without replay', async () => {
  const db = legacyDatabase();
  db.prepare('INSERT INTO hearth_migrations (version) VALUES (?)').run('001_life_dashboard');
  db.exec(migration);

  const { result, applyCount } = await runLocalMigrations(db);
  assert.equal(result.ok, true);
  assert.equal(applyCount, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM hearth_migrations WHERE version = '002_mood_overall_scale'").get().count, 1);
});

test('mismatched applied-but-unrecorded state fails closed without changing the ledger', async () => {
  const db = legacyDatabase();
  db.prepare('INSERT INTO hearth_migrations (version) VALUES (?)').run('001_life_dashboard');
  db.exec('ALTER TABLE moods ADD COLUMN overall_scale INTEGER;');

  const { result, applyCount } = await runLocalMigrations(db);
  assert.equal(result.ok, false);
  assert.match(result.error, /does not match the expected schema/);
  assert.equal(applyCount, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM hearth_migrations WHERE version = '002_mood_overall_scale'").get().count, 0);
});

test('ledger failure after migration application is safely reconciled on retry', async () => {
  const db = legacyDatabase();
  db.prepare('INSERT INTO hearth_migrations (version) VALUES (?)').run('001_life_dashboard');

  const first = await runLocalMigrations(db, { failFirstRecord: true });
  assert.equal(first.result.ok, false);
  assert.equal(first.applyCount, 1);
  assert.equal(classifyMoodOverallScaleSchema(inspectionOutput(db)), 'expected');

  const retry = await runLocalMigrations(db);
  assert.equal(retry.result.ok, true);
  assert.equal(retry.applyCount, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM hearth_migrations WHERE version = '002_mood_overall_scale'").get().count, 1);
});

test('real Wrangler runner applies migration 002 intact and remains idempotent', { timeout: 60_000 }, async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'hearth-migration-002-'));
  const persistTo = join(tempRoot, 'd1-state');
  const migrationsDir = join(tempRoot, 'migrations');
  mkdirSync(migrationsDir, { recursive: true });
  writeFileSync(join(migrationsDir, '002_mood_overall_scale.sql'), migration, 'utf8');
  const seedPath = join(tempRoot, 'pre-002.sql');
  writeFileSync(seedPath, `CREATE TABLE moods (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    partner TEXT NOT NULL,
    mood TEXT NOT NULL,
    note TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE hearth_migrations (
    version TEXT PRIMARY KEY,
    applied_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  INSERT INTO hearth_migrations (version) VALUES ('001_life_dashboard');
  INSERT INTO moods (partner, mood, note, created_at)
    VALUES ('Crimson', 'good', 'keep me', '2026-09-20 10:00:00');`, 'utf8');

  try {
    assert.deepEqual(await executeSchema('hearth-dash-db', seedPath, repoRoot, { local: true, persistTo }), { ok: true });

    const first = await runMigrations('hearth-dash-db', migrationsDir, repoRoot, { local: true, persistTo });
    assert.deepEqual(first, { ok: true, applied: ['002_mood_overall_scale'] });

    const verified = await execWrangler([
      'd1', 'execute', 'hearth-dash-db', '--local', `--persist-to=${persistTo}`, '--json', '--command',
      "SELECT partner, mood, note, overall_scale FROM moods; SELECT version FROM hearth_migrations ORDER BY version;",
    ], repoRoot);
    assert.equal(verified.code, 0, verified.stderr);
    const envelopes = JSON.parse(verified.stdout);
    assert.deepEqual(envelopes[0].results, [{ partner: 'Crimson', mood: 'good', note: 'keep me', overall_scale: null }]);
    assert.deepEqual(envelopes[1].results, [{ version: '001_life_dashboard' }, { version: '002_mood_overall_scale' }]);

    for (const invalid of ['0', '2.5', '6']) {
      const rejected = await execWrangler([
        'd1', 'execute', 'hearth-dash-db', '--local', `--persist-to=${persistTo}`, '--command',
        `INSERT INTO moods (partner, mood, overall_scale, created_at) VALUES ('Elijah', 'okay', ${invalid}, '2026-09-21 10:00:00');`,
      ], repoRoot);
      assert.notEqual(rejected.code, 0, `overall_scale ${invalid} should violate the CHECK constraint`);
      assert.match(rejected.stderr, /CHECK constraint failed/);
    }

    const retry = await runMigrations('hearth-dash-db', migrationsDir, repoRoot, { local: true, persistTo });
    assert.deepEqual(retry, { ok: true, applied: [] });
    const ledger = await execWrangler([
      'd1', 'execute', 'hearth-dash-db', '--local', `--persist-to=${persistTo}`, '--json', '--command',
      "SELECT COUNT(*) AS count FROM hearth_migrations WHERE version = '002_mood_overall_scale';",
    ], repoRoot);
    assert.equal(ledger.code, 0, ledger.stderr);
    assert.equal(JSON.parse(ledger.stdout)[0].results[0].count, 1);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('file transport preserves multiline SQL and semicolons inside quoted strings', { timeout: 60_000 }, async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'hearth-migration-transport-'));
  const persistTo = join(tempRoot, 'd1-state');
  const sqlPath = join(tempRoot, 'multiline.sql');
  writeFileSync(sqlPath, `CREATE TABLE transport_test (
    id INTEGER PRIMARY KEY,
    value TEXT CHECK (value IS NULL OR instr(value, ';') > 0)
  );
  INSERT INTO transport_test (value)
  VALUES ('kept;inside');`, 'utf8');

  try {
    assert.deepEqual(await executeSchema('hearth-dash-db', sqlPath, repoRoot, { local: true, persistTo }), { ok: true });
    const queried = await execWrangler([
      'd1', 'execute', 'hearth-dash-db', '--local', `--persist-to=${persistTo}`, '--json', '--command',
      'SELECT value FROM transport_test;',
    ], repoRoot);
    assert.equal(queried.code, 0, queried.stderr);
    assert.deepEqual(JSON.parse(queried.stdout)[0].results, [{ value: 'kept;inside' }]);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
