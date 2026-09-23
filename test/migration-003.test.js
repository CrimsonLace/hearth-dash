import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  applyPendingMigrations, classifyResourceRevisionSchema, freshMigrationBaselineSql,
  pendingMigrationFiles, RESOURCE_REVISION_TABLES, executeSchema, execWrangler, runMigrations,
} from '../cli/lib/wrangler.js';

const migration = readFileSync(new URL('../migrations/003_resource_revisions.sql', import.meta.url), 'utf8');
const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const migrationFiles = ['001_life_dashboard.sql', '002_mood_overall_scale.sql', '003_resource_revisions.sql'];
const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

function legacyDatabase() {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  for (const table of RESOURCE_REVISION_TABLES) db.exec(`ALTER TABLE ${table} DROP COLUMN revision;`);
  return db;
}

function inspectionRows(db) {
  return RESOURCE_REVISION_TABLES.map(table => {
    const column = db.prepare(`PRAGMA table_info(${table})`).all().find(row => row.name === 'revision');
    return {
      table_name: table,
      column_name: column?.name ?? null,
      column_type: column?.type ?? null,
      column_notnull: column?.notnull ?? null,
      column_default: column?.dflt_value ?? null,
      column_pk: column?.pk ?? null,
    };
  });
}

function output(rows) { return JSON.stringify([{ results: rows }]); }

test('migration 003 is additive, ordered and targets exactly the editable tables', () => {
  assert.deepEqual(pendingMigrationFiles(migrationFiles, new Set(['001_life_dashboard', '002_mood_overall_scale'])), ['003_resource_revisions.sql']);
  assert.doesNotMatch(migration, /\b(?:DROP|DELETE|UPDATE|INSERT|CREATE)\b/i);
  assert.equal((migration.match(/ALTER TABLE/g) || []).length, RESOURCE_REVISION_TABLES.length);
  for (const table of RESOURCE_REVISION_TABLES) assert.match(migration, new RegExp(`ALTER TABLE ${table} ADD COLUMN revision INTEGER NOT NULL DEFAULT 1`));
  assert.doesNotMatch(migration, /ALTER TABLE medication_doses/i);
});

test('fresh schema includes exact revision defaults and baselines migration 003', () => {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  for (const table of RESOURCE_REVISION_TABLES) {
    const column = db.prepare(`PRAGMA table_info(${table})`).all().find(row => row.name === 'revision');
    assert.deepEqual({ type: column.type, notnull: column.notnull, dflt: String(column.dflt_value), pk: column.pk }, { type: 'INTEGER', notnull: 1, dflt: '1', pk: 0 });
  }
  assert.equal(db.prepare('PRAGMA table_info(medication_doses)').all().some(row => row.name === 'revision'), false);
  db.exec(freshMigrationBaselineSql(migrationFiles));
  assert.deepEqual(db.prepare('SELECT version FROM hearth_migrations ORDER BY version').all().map(row => row.version), [
    '001_life_dashboard', '002_mood_overall_scale', '003_resource_revisions',
  ]);
});

test('migration 003 preserves populated data and gives every existing editable row revision 1', () => {
  const db = legacyDatabase();
  db.exec(`INSERT INTO moods (partner, mood, note, overall_scale, created_at) VALUES ('Jace', 'good', 'unchanged', 4, '2026-09-21');
    INSERT INTO notes (from_partner, content, created_at) VALUES ('Elijah', 'unchanged', '2026-09-21');
    INSERT INTO medication_doses (medication_id, person, medication_name, medication_dose, scheduled_at, status) VALUES (1, 'Crimson', 'Med', '1', '2026-09-21T08:00', 'Taken');`);
  db.exec(migration);
  assert.equal(db.prepare('SELECT note FROM moods').get().note, 'unchanged');
  assert.equal(db.prepare('SELECT content FROM notes').get().content, 'unchanged');
  for (const table of RESOURCE_REVISION_TABLES) {
    const count = db.prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE revision != 1 OR revision IS NULL`).get().count;
    assert.equal(count, 0, table);
  }
  assert.equal(db.prepare('PRAGMA table_info(medication_doses)').all().some(row => row.name === 'revision'), false);
  assert.equal(db.prepare('SELECT medication_name FROM medication_doses').get().medication_name, 'Med');
});

test('migration 003 reconciliation accepts only all-absent or all-exact state', () => {
  const db = legacyDatabase();
  assert.equal(classifyResourceRevisionSchema(output(inspectionRows(db))), 'absent');
  db.exec(migration);
  assert.equal(classifyResourceRevisionSchema(output(inspectionRows(db))), 'expected');
  const partial = inspectionRows(db).map((row, index) => index === 0 ? { ...row, column_name: null } : row);
  assert.throws(() => classifyResourceRevisionSchema(output(partial)), /partial or do not match/);
  const malformed = inspectionRows(db).map((row, index) => index === 0 ? { ...row, column_default: '2' } : row);
  assert.throws(() => classifyResourceRevisionSchema(output(malformed)), /partial or do not match/);
  assert.throws(() => classifyResourceRevisionSchema('not-json'), /Could not parse/);
  assert.throws(() => classifyResourceRevisionSchema(output(inspectionRows(db).slice(1))), /every editable table/);
});

test('ledger-write failure after migration 003 can reconcile without replaying ALTER TABLE', async () => {
  const db = legacyDatabase();
  let recordAttempts = 0;
  const run = () => applyPendingMigrations({
    files: migrationFiles,
    applied: new Set(['001_life_dashboard', '002_mood_overall_scale']),
    async reconcile(_file, version) {
      if (version !== '003_resource_revisions') return { ok: true, applied: false };
      return { ok: true, applied: classifyResourceRevisionSchema(output(inspectionRows(db))) === 'expected' };
    },
    async applyFile() { db.exec(migration); return { ok: true }; },
    async record() { recordAttempts += 1; return recordAttempts === 1 ? { ok: false, error: 'simulated ledger failure' } : { ok: true }; },
  });
  assert.equal((await run()).ok, false);
  assert.equal(classifyResourceRevisionSchema(output(inspectionRows(db))), 'expected');
  assert.deepEqual(await run(), { ok: true, applied: ['003_resource_revisions'] });
});

test('real Windows Wrangler file runner applies and reconciles migration 003 intact', { timeout: 60_000 }, async () => {
  const tempRoot = mkdtempSync(join(tmpdir(), 'hearth-migration-003-'));
  const persistTo = join(tempRoot, 'd1-state');
  const migrationsDir = join(tempRoot, 'migrations');
  mkdirSync(migrationsDir, { recursive: true });
  writeFileSync(join(migrationsDir, '003_resource_revisions.sql'), migration, 'utf8');
  const seedPath = join(tempRoot, 'pre-003.sql');
  const legacySchema = schema.replace(/^\s*revision INTEGER NOT NULL DEFAULT 1,?\r?\n/gm, '');
  writeFileSync(seedPath, `${legacySchema}\nINSERT INTO hearth_migrations (version) VALUES ('001_life_dashboard'), ('002_mood_overall_scale');\nINSERT INTO notes (from_partner, content, created_at) VALUES ('Jace', 'preserve', '2026-09-21');`, 'utf8');
  try {
    assert.deepEqual(await executeSchema('hearth-dash-db', seedPath, repoRoot, { local: true, persistTo }), { ok: true });
    assert.deepEqual(await runMigrations('hearth-dash-db', migrationsDir, repoRoot, { local: true, persistTo }), { ok: true, applied: ['003_resource_revisions'] });
    const verified = await execWrangler(['d1', 'execute', 'hearth-dash-db', '--local', `--persist-to=${persistTo}`, '--json', '--command',
      "SELECT content, revision FROM notes; DELETE FROM hearth_migrations WHERE version = '003_resource_revisions';"], repoRoot);
    assert.equal(verified.code, 0, verified.stderr);
    assert.deepEqual(JSON.parse(verified.stdout)[0].results, [{ content: 'preserve', revision: 1 }]);
    assert.deepEqual(await runMigrations('hearth-dash-db', migrationsDir, repoRoot, { local: true, persistTo }), { ok: true, applied: ['003_resource_revisions'] });
    const ledger = await execWrangler(['d1', 'execute', 'hearth-dash-db', '--local', `--persist-to=${persistTo}`, '--json', '--command',
      "SELECT COUNT(*) AS count FROM hearth_migrations WHERE version = '003_resource_revisions';"], repoRoot);
    assert.equal(ledger.code, 0, ledger.stderr);
    assert.equal(JSON.parse(ledger.stdout)[0].results[0].count, 1);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
