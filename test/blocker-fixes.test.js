import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { handleAPI, mcpFoodReview } from '../worker.js';
import { executeResourceOperation } from '../resource-service.js';
import { validateResourceArguments } from '../resource-schemas.js';

class D1Adapter {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
    this.statements = [];
  }
  prepare(sql) {
    const statement = this.db.prepare(sql.replaceAll('datetime("now")', "datetime('now')"));
    const adapter = this;
    return {
      args: [],
      bind(...args) { this.args = args; return this; },
      run() {
        adapter.statements.push({ kind: 'run', sql, args: this.args });
        const result = statement.run(...this.args);
        return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
      },
      first() {
        adapter.statements.push({ kind: 'first', sql, args: this.args });
        return statement.get(...this.args) || null;
      },
      all() {
        adapter.statements.push({ kind: 'all', sql, args: this.args });
        return { results: statement.all(...this.args) };
      },
    };
  }
}

const config = { PARTNER_1: 'Crimson', PARTNER_2: 'Jace', PARTNER_3: 'Elijah' };
const create = (env, resource, data, actor = 'Jace') => executeResourceOperation('hearth_resource_create', { resource, actor, data }, env, config);
const update = (env, resource, id, revision, patch, actor = 'Jace') => executeResourceOperation('hearth_resource_update', { resource, actor, id, revision, patch }, env, config);

function request(body, method = 'POST') {
  return new Request('https://hearth.example/api/test', {
    method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

async function callLegacyFoodReview(env, args, id) {
  void id;
  const response = await mcpFoodReview(env, args);
  return { status: response.status, body: await response.json() };
}

test('browser and MCP writes share revision conflicts in both directions', async () => {
  const env = { DB: new D1Adapter() };
  const appointment = await create(env, 'medical_appointment', {
    person: 'Crimson', appointment_date: '2026-10-01', reason: 'Initial', status: 'Upcoming',
  });
  const browser = await handleAPI(request({
    person: 'Crimson', appointment_date: '2026-10-01', reason: 'Browser edit', status: 'Upcoming',
    transport_needed: false, revision: appointment.revision,
  }, 'PUT'), env, `/medical/appointments/${appointment.id}`, config);
  assert.equal(browser.status, 200);
  await assert.rejects(() => update(env, 'medical_appointment', appointment.id, appointment.revision, { reason: 'Stale MCP edit' }), error => error.status === 409);
  assert.equal(env.DB.db.prepare('SELECT reason FROM medical_appointments WHERE id = ?').get(appointment.id).reason, 'Browser edit');
  const missingAppointment = await handleAPI(request({
    person: 'Crimson', appointment_date: '2026-10-01', reason: 'Missing', status: 'Upcoming',
    transport_needed: false, revision: 1,
  }, 'PUT'), env, '/medical/appointments/999', config);
  assert.equal(missingAppointment.status, 404);

  const medication = await create(env, 'medication', {
    person: 'Crimson', name: 'Medicine', dose: 'one', frequency: 'Daily', start_date: '2026-09-01',
  });
  const prescription = await create(env, 'prescription_renewal', {
    person: 'Crimson', medication_id: medication.id, status: 'Enough',
  });
  const admin = await create(env, 'home_admin_item', { title: 'Insurance', due_date: '2026-10-01' });
  await update(env, 'medication', medication.id, medication.revision, { notes: 'Newer MCP value' });
  await update(env, 'prescription_renewal', prescription.id, prescription.revision, { status: 'Ordered' });
  await update(env, 'home_admin_item', admin.id, admin.revision, { status: 'Due soon' });

  const staleMedication = await handleAPI(request({
    person: 'Crimson', name: 'Medicine', dose: 'one', frequency: 'Daily', scheduled_times: [],
    start_date: '2026-09-01', notes: 'Stale browser value', revision: medication.revision,
  }, 'PUT'), env, `/medical/medications/${medication.id}`, config);
  const stalePrescription = await handleAPI(request({
    person: 'Crimson', medication_id: medication.id, medication_name: 'Medicine', status: 'Enough', revision: prescription.revision,
  }, 'PUT'), env, `/medical/prescriptions/${prescription.id}`, config);
  const staleAdmin = await handleAPI(request({
    title: 'Insurance', category: 'General', due_date: '2026-10-01', recurrence: 'None', status: 'Done', revision: admin.revision,
  }, 'PUT'), env, `/home-admin/${admin.id}`, config);
  assert.deepEqual([staleMedication.status, stalePrescription.status, staleAdmin.status], [409, 409, 409]);
  assert.equal(env.DB.db.prepare('SELECT notes FROM medications WHERE id = ?').get(medication.id).notes, 'Newer MCP value');
  assert.equal(env.DB.db.prepare('SELECT status FROM prescription_renewals WHERE id = ?').get(prescription.id).status, 'Ordered');
  assert.equal(env.DB.db.prepare('SELECT status FROM home_admin WHERE id = ?').get(admin.id).status, 'Due soon');
});

test('shopping target state is safely idempotent while household completion is not repeated', async () => {
  const env = { DB: new D1Adapter() };
  const shop = await create(env, 'shopping_item', { item: 'Cat litter' });
  const firstCheck = await handleAPI(request({ checked: true, revision: shop.revision }), env, `/shopping/${shop.id}/check`, config);
  const repeatedCheck = await handleAPI(request({ checked: true, revision: shop.revision }), env, `/shopping/${shop.id}/check`, config);
  assert.deepEqual([firstCheck.status, repeatedCheck.status], [200, 200]);
  assert.deepEqual({ ...env.DB.db.prepare('SELECT checked, revision FROM shopping WHERE id = ?').get(shop.id) }, { checked: 1, revision: 2 });

  const chore = await create(env, 'household_chore', { task: 'Bins', frequency: 'Weekly', next_due_date: '2026-09-01' });
  const firstCompletion = await handleAPI(request({ revision: chore.revision }), env, `/household/${chore.id}/complete`, config);
  const firstRecord = env.DB.db.prepare('SELECT next_due_date, revision FROM household_chores WHERE id = ?').get(chore.id);
  const repeatedCompletion = await handleAPI(request({ revision: chore.revision }), env, `/household/${chore.id}/complete`, config);
  assert.equal(firstCompletion.status, 200);
  assert.equal(repeatedCompletion.status, 409);
  assert.deepEqual({ ...env.DB.db.prepare('SELECT next_due_date, revision FROM household_chores WHERE id = ?').get(chore.id) }, { ...firstRecord });
});

test('browser and legacy create paths never replace food reviews or meal plans', async () => {
  const env = { DB: new D1Adapter(), PARTNER_1: 'Crimson', PARTNER_2: 'Jace', PARTNER_3: 'Elijah' };
  const firstReview = await handleAPI(request({ date: '2026-09-21', review: 'Original', reviewer: 'Crimson' }), env, '/food/reviews', config);
  assert.equal(firstReview.status, 200);
  const originalReview = env.DB.db.prepare('SELECT * FROM food_reviews WHERE date = ?').get('2026-09-21');
  const duplicateReview = await handleAPI(request({ date: '2026-09-21', review: 'Replacement', reviewer: 'Jace' }), env, '/food/reviews', config);
  assert.equal(duplicateReview.status, 409);
  assert.deepEqual({ ...env.DB.db.prepare('SELECT * FROM food_reviews WHERE date = ?').get('2026-09-21') }, { ...originalReview });

  const legacyFirst = await callLegacyFoodReview(env, { date: '2026-09-22', review: 'Legacy original' }, 1);
  const storedLegacy = env.DB.db.prepare('SELECT * FROM food_reviews WHERE date = ?').get('2026-09-22');
  const legacyDuplicate = await callLegacyFoodReview(env, { date: '2026-09-22', review: 'Legacy replacement' }, 2);
  const forgedReviewer = await callLegacyFoodReview(env, { date: '2026-09-23', review: 'Forged', reviewer: 'Jace' }, 3);
  assert.equal(legacyFirst.status, 200);
  assert.equal(legacyFirst.body.reviewer, 'AI');
  assert.equal(storedLegacy.reviewer, 'AI');
  assert.equal(legacyDuplicate.status, 409);
  assert.deepEqual({ ...env.DB.db.prepare('SELECT * FROM food_reviews WHERE date = ?').get('2026-09-22') }, { ...storedLegacy });
  assert.equal(forgedReviewer.status, 400);
  assert.equal(env.DB.db.prepare('SELECT * FROM food_reviews WHERE date = ?').get('2026-09-23'), undefined);

  const firstMeal = await handleAPI(request({ plan_date: '2026-09-21', meal: 'Pasta', notes: 'Original' }), env, '/meal-plan', config);
  assert.equal(firstMeal.status, 200);
  const originalMeal = env.DB.db.prepare('SELECT * FROM meal_plan WHERE plan_date = ?').get('2026-09-21');
  const duplicateMeal = await handleAPI(request({ plan_date: '2026-09-21', meal: 'Replacement' }), env, '/meal-plan', config);
  assert.equal(duplicateMeal.status, 409);
  assert.deepEqual({ ...env.DB.db.prepare('SELECT * FROM meal_plan WHERE plan_date = ?').get('2026-09-21') }, { ...originalMeal });
});

test('medication datetimes use strict calendar and clock component validation', async () => {
  const invalid = ['2026-02-30T08:00', '2026-09-21T24:00', '2026-09-21T08:61', '2026-13-01T08:00', '2026-00-10T08:00', '2026-04-31T08:00'];
  const valid = ['2026-02-28T08:00', '2028-02-29T08:00', '2026-09-21T23:59', '2026-09-21T00:00'];
  for (const scheduled_at of invalid) assert.throws(() => validateResourceArguments('hearth_resource_create', {
    resource: 'medication_dose', actor: 'Jace', data: { medication_id: 1, scheduled_at, status: 'Taken' },
  }, ['Jace', 'Elijah']), /valid ISO date and time/, scheduled_at);
  for (const scheduled_at of valid) assert.equal(validateResourceArguments('hearth_resource_create', {
    resource: 'medication_dose', actor: 'Jace', data: { medication_id: 1, scheduled_at, status: 'Taken' },
  }, ['Jace', 'Elijah']).data.scheduled_at, scheduled_at);

  const env = { DB: new D1Adapter() };
  const medication = await create(env, 'medication', { person: 'Crimson', name: 'Medicine', dose: 'one', frequency: 'Daily', start_date: '2026-09-01' });
  await assert.rejects(() => create(env, 'medication_dose', { medication_id: medication.id, scheduled_at: invalid[0], status: 'Taken' }), error => error.status === 400);
  const dose = await create(env, 'medication_dose', { medication_id: medication.id, scheduled_at: valid[1], status: 'Taken' });
  assert.equal(dose.record.scheduled_at, valid[1]);
});

test('date reads normalize one-sided windows and shopping always uses a strict SQL limit', async () => {
  const both = validateResourceArguments('hearth_resource_read', { resource: 'food_diary', filters: { from: '2026-01-01', to: '2026-03-31' } }, []);
  assert.deepEqual(both.filters, { from: '2026-01-01', to: '2026-03-31' });
  assert.throws(() => validateResourceArguments('hearth_resource_read', { resource: 'food_diary', filters: { from: '2026-01-01', to: '2026-04-02' } }, []), /90 days/);
  assert.throws(() => validateResourceArguments('hearth_resource_read', { resource: 'food_diary', filters: { from: '2026-02-01', to: '2026-01-01' } }, []), /must not be after/);
  assert.throws(() => validateResourceArguments('hearth_resource_read', { resource: 'food_diary', filters: { from: 'not-a-date' } }, []), /YYYY-MM-DD/);
  assert.deepEqual(validateResourceArguments('hearth_resource_read', { resource: 'food_diary', filters: { from: '1900-01-01' } }, []).filters, { from: '1900-01-01', to: '1900-04-01' });
  assert.deepEqual(validateResourceArguments('hearth_resource_read', { resource: 'food_diary', filters: { to: '2200-01-01' } }, []).filters, { from: '2199-10-03', to: '2200-01-01' });

  const env = { DB: new D1Adapter() };
  const insert = env.DB.db.prepare("INSERT INTO shopping (item, category, checked, added_by, created_at) VALUES (?, 'Other', 0, 'Jace', datetime('now'))");
  for (let index = 0; index < 120; index += 1) insert.run(`Item ${index}`);
  const defaultRead = await executeResourceOperation('hearth_resource_read', { resource: 'shopping', filters: { state: 'all' } }, env, config);
  const expandedRead = await executeResourceOperation('hearth_resource_read', { resource: 'shopping', filters: { state: 'all', limit: 150 } }, env, config);
  assert.equal(defaultRead.count, 100);
  assert.equal(expandedRead.count, 120);
  const shoppingQueries = env.DB.statements.filter(entry => entry.kind === 'all' && entry.sql.includes('FROM shopping'));
  assert.ok(shoppingQueries.every(entry => /LIMIT \?$/.test(entry.sql)));
  assert.deepEqual(shoppingQueries.map(entry => entry.args.at(-1)), [100, 150]);
});
