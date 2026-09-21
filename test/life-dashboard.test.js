import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { getRedesignedDashboardHTML } from '../dashboard.js';
import { localDateKey } from '../date-utils.js';
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
  assert.match(html, /1\.1\.4-crimson\.4/);
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
  assert.match(html, /<option value="horny">Horny<\/option>/);
  assert.match(html, /name="overall_scale"/);
  assert.match(html, /Overall '\+item\.overall_scale\+'\/5/);
  assert.match(html, /id="dashboard-date"/);
  assert.match(html, /Europe\/London/);
  assert.match(html, /Active medications/);
  assert.match(html, /Stopped medications/);
  assert.match(html, /Stop medication/);
  assert.match(html, /Reactivate/);
  assert.match(html, /All medications/);
  assert.match(html, /Custom \/ other/);
  assert.doesNotMatch(html, /86400000|24\s*\*\s*60\s*\*\s*60\s*\*\s*1000/);
});

test('fork documentation never presents the upstream package as an executable command', () => {
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
  const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
  const publishedCommand = ['npx', 'hearth-dash'].join(' ');
  const operationalLines = readme.split(/\r?\n/).filter(line => line.trim().startsWith(publishedCommand));
  assert.deepEqual(operationalLines, []);
  assert.match(readme, /Do not use[^\n]*hearth-dash@latest deploy/);
  assert.match(readme, /CrimsonLace\/hearth-dash/);
  assert.equal(packageJson.version, '1.1.4-crimson.4');
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
  assert.match(db.statements[1].sql, /revision = revision \+ 1/);
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
    active: 1, start_date: '2026-09-01', stopped_date: null, stopped_reason: null,
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

  const forbiddenReactivation = await handleAPI(request({
    ...db.medications[0], active: true, scheduled_times: ['08:00'],
  }, 'PUT'), { DB: db }, '/medical/medications/1', config);
  assert.equal(forbiddenReactivation.status, 400);
  assert.equal(db.medications[0].active, 0);

  const reactivated = await handleAPI(request({}, 'POST'), { DB: db }, '/medical/medications/1/reactivate', config);
  assert.equal(reactivated.status, 200);
  assert.equal(db.medications[0].active, 1);
  assert.equal(db.medications[0].stopped_date, null);
  assert.equal(db.medications[0].stopped_reason, null);
});

test('creates prescription renewal state independently from dose history', async () => {
  const db = new RecordingD1({ first: sql => sql.includes('FROM medications WHERE id')
    ? { id: 2, person: 'Crimson', name: 'Medicine from database', active: 1 }
    : null });
  const response = await handleAPI(request({
    medication_id: 2, person: 'Crimson', medication_name: 'Medicine', last_ordered_date: '2026-09-01',
    next_order_date: '2026-09-25', quantity_remaining: 5, status: 'Order soon', notes: 'Call pharmacy',
  }), { DB: db }, '/medical/prescriptions', config);
  assert.equal(response.status, 200);
  const insert = db.statements.find(statement => statement.sql.includes('INSERT INTO prescription_renewals'));
  assert.ok(insert);
  assert.equal(insert.args[2], 'Medicine from database');
  assert.equal(insert.args[6], 'Order soon');
});

test('validates prescription medication selections and preserves historical inactive or free-text choices', async () => {
  const base = {
    person: 'Crimson', last_ordered_date: '2026-09-01', next_order_date: '2026-09-25',
    quantity_remaining: 5, status: 'Order soon', notes: 'Call pharmacy',
  };
  const medications = new Map([
    [1, { id: 1, person: 'Crimson', name: 'Active Crimson medicine', active: 1 }],
    [2, { id: 2, person: 'Conrad', name: 'Conrad medicine', active: 1 }],
    [3, { id: 3, person: 'Crimson', name: 'Stopped Crimson medicine', active: 0 }],
  ]);
  const makeDb = (renewal = null) => new RecordingD1({ first: (sql, args) => {
    if (sql.includes('FROM prescription_renewals WHERE id')) return renewal;
    if (sql.includes('FROM medications WHERE id')) return medications.get(args[0]) || null;
    return null;
  } });

  for (const [medication_id, expectedMessage] of [[99, /existing medication/], [2, /selected person/], [3, /active medication/]]) {
    const rejected = await handleAPI(request({ ...base, medication_id, medication_name: 'Forged client name' }),
      { DB: makeDb() }, '/medical/prescriptions', config);
    assert.equal(rejected.status, 400);
    assert.match((await rejected.json()).error, expectedMessage);
  }

  const specialDb = makeDb();
  assert.equal((await handleAPI(request({ ...base, medication_id: null, medication_name: 'All medications' }),
    { DB: specialDb }, '/medical/prescriptions', config)).status, 200);
  assert.equal((await handleAPI(request({ ...base, medication_id: null, medication_name: 'Custom / other' }),
    { DB: specialDb }, '/medical/prescriptions', config)).status, 200);
  assert.equal((await handleAPI(request({ ...base, medication_id: null, medication_name: 'Untrusted free text' }),
    { DB: makeDb() }, '/medical/prescriptions', config)).status, 400);

  const inactiveRenewal = { id: 7, medication_id: 3, person: 'Crimson', medication_name: 'Historical stopped name' };
  const inactiveDb = makeDb(inactiveRenewal);
  const inactiveEdit = await handleAPI(request({
    ...base, medication_id: 3, medication_name: 'Client rewrite attempt',
  }, 'PUT'), { DB: inactiveDb }, '/medical/prescriptions/7', config);
  assert.equal(inactiveEdit.status, 200);
  const inactiveUpdate = inactiveDb.statements.find(statement => statement.sql.startsWith('UPDATE prescription_renewals'));
  assert.equal(inactiveUpdate.args[2], 'Historical stopped name');

  const legacyRenewal = { id: 8, medication_id: null, person: 'Crimson', medication_name: 'Legacy free text' };
  const legacyDb = makeDb(legacyRenewal);
  assert.equal((await handleAPI(request({ ...base, medication_id: null, medication_name: 'Legacy free text' }, 'PUT'),
    { DB: legacyDb }, '/medical/prescriptions/8', config)).status, 200);
  assert.equal((await handleAPI(request({ ...base, medication_id: null, medication_name: 'Silently rewritten' }, 'PUT'),
    { DB: makeDb(legacyRenewal) }, '/medical/prescriptions/8', config)).status, 400);
});

test('stopping a medication defaults to the London calendar date and actual dose instants stay UTC', async () => {
  const existing = {
    id: 4, person: 'Crimson', name: 'Medicine', strength: '10mg', dose: 'one tablet', frequency: 'Daily',
    scheduled_times: '[]', prescribing_source: null, notes: null, active: 1, start_date: '2026-09-01',
    stopped_date: null, stopped_reason: null,
  };
  const db = new RecordingD1({ first: sql => sql.includes('SELECT * FROM medications') ? existing : null });
  const stopped = await handleAPI(request({
    person: 'Crimson', name: 'Medicine', strength: '10mg', dose: 'one tablet', frequency: 'Daily',
    scheduled_times: [], start_date: '2026-09-01', active: false,
  }, 'PUT'), { DB: db }, '/medical/medications/4', config);
  assert.equal(stopped.status, 200);
  const stopUpdate = db.statements.find(statement => statement.sql.startsWith('UPDATE medications SET person'));
  assert.equal(stopUpdate.args[10], localDateKey());

  const dose = await handleAPI(request({ medication_id: 4, scheduled_at: `${localDateKey()}T08:00`, status: 'Taken' }),
    { DB: db }, '/medical/doses', config);
  assert.equal(dose.status, 200);
  const doseInsert = db.statements.find(statement => statement.sql.includes('INSERT INTO medication_doses'));
  assert.match(doseInsert.args[6], /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
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
  assert.match(db.statements.at(-1).sql, /revision = revision \+ 1/);
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

  for (const partner of ['Crimson', 'Jace', 'Elijah']) {
    const accepted = await handleAPI(request({ partner, mood: 'horny', note: '' }), { DB: db }, '/moods', threePartnerConfig);
    assert.equal(accepted.status, 200);
  }
  for (const overall_scale of [1, 2, 3, 4, 5]) {
    const accepted = await handleAPI(request({ partner: 'Crimson', mood: 'good', overall_scale }), { DB: db }, '/moods', threePartnerConfig);
    assert.equal(accepted.status, 200);
  }
  const omitted = await handleAPI(request({ partner: 'Jace', mood: 'tired' }), { DB: db }, '/moods', threePartnerConfig);
  assert.equal(omitted.status, 200);
  assert.equal(db.statements.filter(statement => statement.sql.startsWith('INSERT INTO moods')).at(-1).args[3], null);
  for (const overall_scale of [0, 6, 2.5, '3', true, false]) {
    const invalid = await handleAPI(request({ partner: 'Crimson', mood: 'good', overall_scale }), { DB: db }, '/moods', threePartnerConfig);
    assert.equal(invalid.status, 400, JSON.stringify(overall_scale));
  }
  const rejected = await handleAPI(request({ partner: 'Conrad', mood: 'good', note: '' }), { DB: db }, '/moods', threePartnerConfig);
  assert.equal(rejected.status, 400);
});

test('dashboard and calendar-day REST paths bind one Europe/London date context', async () => {
  const dates = [
    { id: 2, date: '2026-10-01', title: 'Second' },
    { id: 3, date: '2026-10-01', title: 'Third' },
    { id: 4, date: '2026-10-02', title: 'Fourth' },
  ];
  const db = new RecordingD1({
    all: sql => sql.startsWith('SELECT * FROM dates WHERE date >=') ? dates : [],
  });
  const before = localDateKey();
  const response = await handleAPI(new Request('https://hearth.example/api/dashboard'), { DB: db }, '/dashboard', config);
  const after = localDateKey();
  const body = await response.json();
  assert.ok([before, after].includes(body.today));
  assert.equal(typeof body.todayLabel, 'string');
  assert.deepEqual(body.upcomingDates, dates);
  assert.deepEqual(body.nextDate, dates[0]);
  const dateQuery = db.statements.find(statement => statement.sql.startsWith('SELECT * FROM dates WHERE date >='));
  assert.match(dateQuery.sql, /ORDER BY date ASC, id ASC LIMIT 3/);
  assert.ok([before, after].includes(dateQuery.args[0]));
  assert.ok(db.statements.every(statement => !/date\(["']now["']/.test(statement.sql)));

  const pathDb = new RecordingD1({ first: () => ({ total: 0 }) });
  await handleAPI(request(undefined, 'GET', '/api/food'), { DB: pathDb }, '/food', config);
  await handleAPI(request({ meal_type: 'dinner' }, 'POST', '/api/food'), { DB: pathDb }, '/food', config);
  await handleAPI(request(undefined, 'GET', '/api/water'), { DB: pathDb }, '/water', config);
  await handleAPI(request({ amount_ml: 250 }, 'POST', '/api/water'), { DB: pathDb }, '/water', config);
  const mealPlan = await handleAPI(request(undefined, 'GET', '/api/meal-plan'), { DB: pathDb }, '/meal-plan', config);
  const mealPlanBody = await mealPlan.json();
  assert.equal(mealPlanBody.to, addUtcDays(mealPlanBody.from, 6));
  for (const statement of pathDb.statements.filter(statement => statement.args.length && /food_diary|water_log|meal_plan/.test(statement.sql))) {
    if (/INSERT INTO food_diary|INSERT INTO water_log/.test(statement.sql)) assert.ok([before, after].includes(statement.args[0]));
  }
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
