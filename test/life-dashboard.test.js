import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getRedesignedDashboardHTML } from '../dashboard.js';
import {
  addUtcDays, handleAPI, medicationProgressForToday, nextChoreDueDate, parseScheduledTimes, splitIngredients,
} from '../worker.js';

class RecordingD1 {
  constructor({ first = () => null, all = () => [] } = {}) {
    this.statements = [];
    this.firstValue = first;
    this.allValue = all;
  }

  prepare(sql) {
    const db = this;
    return {
      args: [],
      bind(...args) { this.args = args; return this; },
      async run() { db.statements.push({ kind: 'run', sql, args: this.args }); return { success: true }; },
      async first() { db.statements.push({ kind: 'first', sql, args: this.args }); return db.firstValue(sql, this.args); },
      async all() { db.statements.push({ kind: 'all', sql, args: this.args }); return { results: db.allValue(sql, this.args) }; },
    };
  }
}

const config = { PARTNER_1: 'One', PARTNER_2: 'Two' };

function request(body, method = 'POST', path = '/api/test') {
  return new Request(`https://hearth.example${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

test('renders the warm responsive dashboard without visible weather or pressure navigation', () => {
  const html = getRedesignedDashboardHTML({ PARTNER_1: '</script><b>Crimson</b>', PARTNER_2: "O'Malley" });
  assert.match(html, /#F7F2EA/);
  assert.match(html, /Medical/);
  assert.match(html, /Household/);
  assert.match(html, /Home Admin/);
  assert.match(html, /@media\(max-width:650px\)/);
  assert.doesNotMatch(html, /data-page="weather"/);
  assert.doesNotMatch(html, /data-page="pressure"/);
  assert.doesNotMatch(html, /<\/script><b>Crimson/);
  assert.match(html, /O&#39;Malley/);
});

test('validates scheduled medication times and calculates daily progress', () => {
  assert.deepEqual(parseScheduledTimes('20:00, 08:00, 08:00'), ['08:00', '20:00']);
  assert.throws(() => parseScheduledTimes(['25:00']), /HH:MM/);
  assert.deepEqual(medicationProgressForToday([
    { person: 'Crimson', scheduled_times: '["08:00","20:00"]' },
    { person: 'Conrad', scheduled_times: ['09:00'] },
  ], [
    { person: 'Crimson', status: 'Taken' }, { person: 'Crimson', status: 'Skipped' },
  ]), { Crimson: { taken: 1, due: 2 }, Conrad: { taken: 0, due: 1 } });
});

test('creates and edits a medical appointment while keeping medical people independent', async () => {
  const db = new RecordingD1();
  const body = {
    person: 'Crimson', appointment_date: '2026-10-01', appointment_time: '09:30', location: 'Clinic',
    clinic: 'GP', clinician: 'Dr A', reason: 'Review', notes: 'Bring list', status: 'Upcoming',
    transport_needed: true, preparation_needed: 'Fast',
  };
  assert.equal((await handleAPI(request(body), { DB: db }, '/medical/appointments', config)).status, 200);
  assert.match(db.statements[0].sql, /INSERT INTO medical_appointments/);
  assert.equal(db.statements[0].args[0], 'Crimson');

  assert.equal((await handleAPI(request({ ...body, status: 'Completed' }, 'PUT'), { DB: db }, '/medical/appointments/7', config)).status, 200);
  assert.match(db.statements[1].sql, /UPDATE medical_appointments/);
  assert.equal(db.statements[1].args.at(-1), 7);

  const rejected = await handleAPI(request({ ...body, person: 'Elijah' }), { DB: db }, '/medical/appointments', config);
  assert.equal(rejected.status, 400);
});

test('medication edits do not rewrite historical dose snapshots', async () => {
  const medication = {
    id: 4, person: 'Conrad', name: 'Medicine A', strength: '10mg', dose: 'one tablet', frequency: 'Daily',
  };
  const db = new RecordingD1({ first: sql => sql.includes('SELECT * FROM medications') ? medication : null });
  const edit = {
    person: 'Conrad', name: 'Medicine B', strength: '20mg', dose: 'two tablets', frequency: 'Daily',
    scheduled_times: ['08:00'], start_date: '2026-09-01', active: true,
  };
  assert.equal((await handleAPI(request(edit, 'PUT'), { DB: db }, '/medical/medications/4', config)).status, 200);
  assert.equal((await handleAPI(request({ medication_id: 4, scheduled_at: '2026-09-20T08:00', status: 'Taken' }), { DB: db }, '/medical/doses', config)).status, 200);
  const doseInsert = db.statements.find(entry => entry.sql.includes('INSERT OR REPLACE INTO medication_doses'));
  assert.ok(doseInsert);
  assert.deepEqual(doseInsert.args.slice(0, 5), [4, 'Conrad', 'Medicine A', '10mg', 'one tablet']);
  assert.ok(!db.statements.some(entry => /UPDATE medication_doses/.test(entry.sql)));
});

test('creates prescription renewal state independently from dose history', async () => {
  const db = new RecordingD1();
  const response = await handleAPI(request({
    medication_id: 2, person: 'Crimson', medication_name: 'Medicine', last_ordered_date: '2026-09-01',
    next_order_date: '2026-09-25', quantity_remaining: 5, status: 'Order soon', notes: 'Call pharmacy',
  }), { DB: db }, '/medical/prescriptions', config);
  assert.equal(response.status, 200);
  assert.match(db.statements[0].sql, /INSERT INTO prescription_renewals/);
  assert.equal(db.statements[0].args[6], 'Order soon');
});

test('calculates recurring chores from the later of due date and completion day', async () => {
  assert.equal(nextChoreDueDate('2026-09-01', 'Weekly', null, '2026-09-20'), '2026-09-27');
  assert.equal(nextChoreDueDate('2026-09-25', 'Daily', null, '2026-09-20'), '2026-09-26');
  assert.equal(nextChoreDueDate('2026-01-31', 'Monthly', null, '2026-01-31'), '2026-02-28');
  assert.equal(nextChoreDueDate('2026-09-20', 'Custom', 10, '2026-09-20'), '2026-09-30');
  assert.equal(nextChoreDueDate('2026-09-20', 'One-off', null, '2026-09-20'), null);

  const db = new RecordingD1({ first: () => ({ id: 3, task: 'Bins', frequency: 'Weekly', recurrence_days: null, next_due_date: '2026-09-01' }) });
  const response = await handleAPI(request({}, 'POST'), { DB: db }, '/household/3/complete', config);
  assert.equal(response.status, 200);
  assert.match(db.statements.at(-1).sql, /UPDATE household_chores SET next_due_date/);
});

test('stores home-admin status and meal planning without duplicating shopping storage', async () => {
  const db = new RecordingD1();
  const admin = await handleAPI(request({
    title: 'Insurance', category: 'Renewal', due_date: '2026-10-01', recurrence: 'Yearly', status: 'Due soon', notes: '',
  }), { DB: db }, '/home-admin', config);
  assert.equal(admin.status, 200);
  const meal = await handleAPI(request({
    plan_date: '2026-09-20', meal: 'Sausage pasta', notes: '', ingredients_needed: 'cheese, tomatoes',
  }), { DB: db }, '/meal-plan', config);
  assert.equal(meal.status, 200);
  assert.match(db.statements[0].sql, /INSERT INTO home_admin/);
  assert.match(db.statements[1].sql, /INSERT INTO meal_plan/);
  assert.deepEqual(splitIngredients('cheese, tomatoes\ncheese'), ['cheese', 'tomatoes']);
  assert.equal(addUtcDays('2026-09-20', 6), '2026-09-26');
});

test('dashboard aggregation is safe when every new section is empty', async () => {
  const db = new RecordingD1();
  const response = await handleAPI(new Request('https://hearth.example/api/dashboard'), { DB: db }, '/dashboard', config);
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(body.medicationProgress, { Crimson: { taken: 0, due: 0 }, Conrad: { taken: 0, due: 0 } });
  assert.deepEqual(body.household, { dueToday: 0, overdue: 0, items: [] });
  assert.equal(body.tonightMeal, null);
});

test('fresh schema and upgrade migration preserve existing pressure storage', () => {
  const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
  const migration = readFileSync(new URL('../migrations/001_life_dashboard.sql', import.meta.url), 'utf8');
  for (const table of ['medical_appointments', 'medications', 'medication_doses', 'prescription_renewals', 'household_chores', 'home_admin', 'meal_plan', 'saved_meals']) {
    assert.match(schema, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
    assert.match(migration, new RegExp(`CREATE TABLE IF NOT EXISTS ${table}`));
  }
  assert.match(schema, /CREATE TABLE IF NOT EXISTS pressure_log/);
  assert.doesNotMatch(migration, /(?:DROP|DELETE FROM|UPDATE)\s+pressure_log/i);
  assert.doesNotMatch(migration, /\bDROP TABLE\b/i);
});
