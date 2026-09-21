import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { pendingMigrationFiles } from '../cli/lib/wrangler.js';

const migration = readFileSync(new URL('../migrations/002_mood_overall_scale.sql', import.meta.url), 'utf8');

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
