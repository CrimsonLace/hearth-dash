import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getRedesignedDashboardHTML } from '../dashboard.js';
import { configuredPartners, formatPartnerList, validatePartnerNames } from '../partners.js';
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

class StatefulMedicalD1 {
  constructor() {
    this.medications = [];
    this.doses = [];
    this.nextMedicationId = 1;
    this.nextDoseId = 1;
  }

  prepare(sql) {
    const db = this;
    return {
      args: [],
      bind(...args) { this.args = args; return this; },
      async first() {
        if (/SELECT \* FROM medications WHERE id/.test(sql)) {
          return db.medications.find(item => item.id === this.args[0]) || null;
        }
        if (/SELECT id FROM medications WHERE id/.test(sql)) {
          const item = db.medications.find(value => value.id === this.args[0]);
          return item ? { id: item.id } : null;
        }
        if (/SELECT id FROM medication_doses/.test(sql)) {
          const item = db.doses.find(value => value.medication_id === this.args[0] && value.scheduled_at === this.args[1]);
          return item ? { id: item.id } : null;
        }
        return null;
      },
      async run() {
        if (/INSERT INTO medications/.test(sql)) {
          const [person, name, strength, dose, frequency, scheduledTimes, prescribingSource, notes, startDate] = this.args;
          db.medications.push({
            id: db.nextMedicationId++, person, name, strength, dose, frequency,
            scheduled_times: scheduledTimes, prescribing_source: prescribingSource, notes,
            active: 1, start_date: startDate, stopped_date: null, stopped_reason: null,
          });
        } else if (/UPDATE medications SET person/.test(sql)) {
          const [person, name, strength, dose, frequency, scheduledTimes, prescribingSource, notes,
            active, startDate, stoppedDate, stoppedReason, id] = this.args;
          const item = db.medications.find(value => value.id === id);
          Object.assign(item, {
            person, name, strength, dose, frequency, scheduled_times: scheduledTimes,
            prescribing_source: prescribingSource, notes, active, start_date: startDate,
            stopped_date: stoppedDate, stopped_reason: stoppedReason,
          });
        } else if (/UPDATE medications SET active = 1/.test(sql)) {
          const item = db.medications.find(value => value.id === this.args[0]);
          Object.assign(item, { active: 1, stopped_date: null, stopped_reason: null });
        } else if (/INSERT INTO medication_doses/.test(sql)) {
          const [medicationId, person, medicationName, medicationStrength, medicationDose,
            scheduledAt, actualTakenAt, status] = this.args;
          if (db.doses.some(value => value.medication_id === medicationId && value.scheduled_at === scheduledAt)) {
            throw new Error('UNIQUE constraint failed: medication_doses.medication_id, medication_doses.scheduled_at');
          }
          db.doses.push({
            id: db.nextDoseId++, medication_id: medicationId, person,
            medication_name: medicationName, medication_strength: medicationStrength,
            medication_dose: medicationDose, scheduled_at: scheduledAt,
            actual_taken_at: actualTakenAt, status, created_at: 'unchanged-created-at',
          });
        }
        return { success: true };
      },
      async all() { return { results: [] }; },
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
  const html = getRedesignedDashboardHTML({ PARTNER_1: '</script><b>Crimson</b>', PARTNER_2: "O'Malley", PARTNER_3: '<svg onload=alert(1)>' });
  assert.match(html, /#F7F2EA/);
  assert.match(html, /Medical/);
  assert.match(html, /Household/);
  assert.match(html, /Home Admin/);
  assert.match(html, /@media\(max-width:650px\)/);
  assert.doesNotMatch(html, /data-page="weather"/);
  assert.doesNotMatch(html, /data-page="pressure"/);
  assert.doesNotMatch(html, /<\/script><b>Crimson/);
  assert.match(html, /O&#39;Malley/);
  assert.doesNotMatch(html, /<svg onload=alert\(1\)>/);
  assert.match(html, /&lt;svg onload=alert\(1\)&gt;/);
  assert.match(html, /1\.1\.4-crimson\.2/);
});

test('normalizes optional partner configuration and preserves two-person fallback', () => {
  assert.deepEqual(configuredPartners({ PARTNER_1: ' Crimson ', PARTNER_2: 'Jace' }), ['Crimson', 'Jace']);
  assert.deepEqual(configuredPartners({ PARTNER_1: 'Crimson', PARTNER_2: 'Jace', PARTNER_3: '  ' }), ['Crimson', 'Jace']);
  assert.deepEqual(configuredPartners({ PARTNER_1: 'Crimson', PARTNER_2: 'Jace', PARTNER_3: 'Jace' }), ['Crimson', 'Jace']);
  assert.throws(() => configuredPartners({ PARTNER_1: 'x'.repeat(81), PARTNER_2: 'Jace' }), /80 characters/);
  assert.deepEqual(validatePartnerNames([' Crimson ', 'Jace', ' Elijah ']), ['Crimson', 'Jace', 'Elijah']);
  assert.deepEqual(validatePartnerNames(['Crimson', 'Jace', '']), ['Crimson', 'Jace']);
  assert.throws(() => validatePartnerNames(['Crimson', 'Crimson', '']), /distinct/);
  assert.throws(() => validatePartnerNames(['Crimson', 'Jace', 'x'.repeat(81)]), /80 characters/);
  assert.equal(formatPartnerList(['Crimson', 'Jace', 'Elijah']), 'Crimson, Jace and Elijah');
});

test('renders all configured partners in relevant controls and the Hearth subtitle', () => {
  const html = getRedesignedDashboardHTML({ PARTNER_1: 'Crimson', PARTNER_2: 'Jace', PARTNER_3: 'Elijah' });
  assert.match(html, /A shared Hearth for Crimson, Jace and Elijah/);
  assert.equal((html.match(/<option value="Elijah">Elijah<\/option>/g) || []).length, 3);
  assert.match(html, /\.topbar\{[^}]*flex-wrap:wrap/);
  assert.match(html, /const PARTNERS=\["Crimson","Jace","Elijah"\]/);
});

test('fork documentation never presents the upstream package as an executable command', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const publishedCommand = ['npx', 'hearth-dash'].join(' ');
  const operationalLines = readme.split(/\r?\n/).filter(line => line.trim().startsWith(publishedCommand));
  assert.deepEqual(operationalLines, []);
  assert.match(readme, /Do not use[^\n]*hearth-dash@latest deploy/);
  assert.match(readme, /CrimsonLace\/hearth-dash/);
  assert.equal(packageJson.version, '1.1.4-crimson.2');
  assert.equal(packageJson.private, true);
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

  for (const appointment_time of ['24:00', '9:30', '12:60']) {
    const invalidTime = await handleAPI(request({ ...body, appointment_time }), { DB: db }, '/medical/appointments', config);
    assert.equal(invalidTime.status, 400, appointment_time);
  }
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
  const doseInsert = db.statements.find(entry => entry.sql.includes('INSERT INTO medication_doses'));
  assert.ok(doseInsert);
  assert.deepEqual(doseInsert.args.slice(0, 5), [4, 'Conrad', 'Medicine A', '10mg', 'one tablet']);
  assert.ok(!db.statements.some(entry => /UPDATE medication_doses/.test(entry.sql)));
});

test('duplicate dose submissions cannot replace immutable history', async () => {
  const db = new StatefulMedicalD1();
  db.medications.push({
    id: 4, person: 'Conrad', name: 'Medicine A', strength: '10mg', dose: 'one tablet',
    frequency: 'Daily', scheduled_times: '["08:00"]', active: 1, start_date: '2026-09-01',
    stopped_date: null, stopped_reason: null,
  });
  const first = await handleAPI(request({
    medication_id: 4, scheduled_at: '2026-09-20T08:00', status: 'Taken',
  }), { DB: db }, '/medical/doses', config);
  assert.equal(first.status, 200);
  const original = structuredClone(db.doses[0]);

  db.medications[0].name = 'Medicine B';
  db.medications[0].strength = '20mg';
  db.medications[0].dose = 'two tablets';
  const duplicate = await handleAPI(request({
    medication_id: 4, scheduled_at: '2026-09-20T08:00', status: 'Skipped',
  }), { DB: db }, '/medical/doses', config);
  assert.equal(duplicate.status, 409);
  assert.deepEqual(await duplicate.json(), { error: 'Dose already recorded' });
  assert.equal(db.doses.length, 1);
  assert.deepEqual(db.doses[0], original);
});

test('editing a stopped medication preserves stop state until explicit reactivation', async () => {
  const db = new StatefulMedicalD1();
  const created = await handleAPI(request({
    person: 'Crimson', name: 'Medicine A', strength: '10mg', dose: 'one tablet', frequency: 'Daily',
    scheduled_times: ['08:00'], start_date: '2026-09-01', notes: 'Original',
  }), { DB: db }, '/medical/medications', config);
  assert.equal(created.status, 200);
  assert.equal(db.medications[0].active, 1);

  const stopped = await handleAPI(request({
    ...db.medications[0], active: false, stopped_date: '2026-09-18', stopped_reason: 'Clinician advice',
  }, 'PUT'), { DB: db }, '/medical/medications/1', config);
  assert.equal(stopped.status, 200);
  assert.equal(db.medications[0].active, 0);

  const edited = await handleAPI(request({
    person: 'Crimson', name: 'Medicine A revised', strength: '10mg', dose: 'half tablet', frequency: 'Daily',
    scheduled_times: ['08:00'], start_date: '2026-09-01', notes: 'Edited while stopped',
  }, 'PUT'), { DB: db }, '/medical/medications/1', config);
  assert.equal(edited.status, 200);
  assert.equal(db.medications[0].active, 0);
  assert.equal(db.medications[0].stopped_date, '2026-09-18');
  assert.equal(db.medications[0].stopped_reason, 'Clinician advice');

  const reactivated = await handleAPI(request({}, 'POST'), { DB: db }, '/medical/medications/1/reactivate', config);
  assert.equal(reactivated.status, 200);
  assert.equal(db.medications[0].active, 1);
  assert.equal(db.medications[0].stopped_date, null);
  assert.equal(db.medications[0].stopped_reason, null);
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

test('dashboard aggregation and REST mood validation use all configured partners', async () => {
  const threePartnerConfig = { PARTNER_1: 'Crimson', PARTNER_2: 'Jace', PARTNER_3: 'Elijah' };
  const db = new RecordingD1();
  const response = await handleAPI(new Request('https://hearth.example/api/dashboard'), { DB: db }, '/dashboard', threePartnerConfig);
  assert.deepEqual((await response.json()).moods, { Crimson: null, Jace: null, Elijah: null });
  const moodQueries = db.statements.filter(statement => statement.kind === 'first' && statement.sql.startsWith('SELECT * FROM moods'));
  assert.deepEqual(moodQueries.map(statement => statement.args[0]), ['Crimson', 'Jace', 'Elijah']);

  const accepted = await handleAPI(request({ partner: 'Elijah', mood: 'good', note: '' }), { DB: db }, '/moods', threePartnerConfig);
  assert.equal(accepted.status, 200);
  const rejected = await handleAPI(request({ partner: 'Conrad', mood: 'good', note: '' }), { DB: db }, '/moods', threePartnerConfig);
  assert.equal(rejected.status, 400);
});

test('notes retain free-text API compatibility and shopping accepts Elijah attribution', async () => {
  const db = new RecordingD1();
  const note = await handleAPI(request({ from: 'Guest carer', content: 'Left a note' }), { DB: db }, '/notes', config);
  assert.equal(note.status, 200);
  const shopping = await handleAPI(request({ item: 'Tea', category: 'Food', added_by: 'Elijah' }), { DB: db }, '/shopping', config);
  assert.equal(shopping.status, 200);
  assert.deepEqual(db.statements.find(statement => statement.sql.startsWith('INSERT INTO notes')).args.slice(0, 2), ['Guest carer', 'Left a note']);
  assert.deepEqual(db.statements.find(statement => statement.sql.startsWith('INSERT INTO shopping')).args, ['Tea', 'Food', 'Elijah']);
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
