import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { executeResourceOperation, ResourceServiceError } from '../resource-service.js';
import { CREATE_RESOURCES, READ_RESOURCES, UPDATE_RESOURCES, validateResourceArguments } from '../resource-schemas.js';

class D1Adapter {
  constructor() {
    this.db = new DatabaseSync(':memory:');
    this.db.exec(readFileSync(new URL('../schema.sql', import.meta.url), 'utf8'));
  }
  prepare(sql) {
    const statement = this.db.prepare(sql);
    return {
      args: [],
      bind(...args) { this.args = args; return this; },
      run() {
        const result = statement.run(...this.args);
        return { success: true, meta: { changes: Number(result.changes), last_row_id: Number(result.lastInsertRowid) } };
      },
      first() { return statement.get(...this.args) || null; },
      all() { return { results: statement.all(...this.args) }; },
    };
  }
}

const config = { PARTNER_1: 'Crimson', PARTNER_2: 'Jace', PARTNER_3: 'Elijah' };
const create = (env, resource, data, actor = 'Jace') => executeResourceOperation('hearth_resource_create', { resource, actor, data }, env, config);
const update = (env, resource, id, revision, patch, actor = 'Jace') => executeResourceOperation('hearth_resource_update', { resource, actor, id, revision, patch }, env, config);

test('resource schemas reject unknown resources, fields, actor spoofing and invalid people', () => {
  assert.throws(() => validateResourceArguments('hearth_resource_read', { resource: 'database' }, ['Crimson', 'Jace', 'Elijah']), /resource must be one of/);
  assert.throws(() => validateResourceArguments('hearth_resource_create', { resource: 'note', actor: 'Crimson', data: { content: 'x' } }, ['Crimson', 'Jace', 'Elijah']), /actor must be Jace or Elijah/);
  assert.throws(() => validateResourceArguments('hearth_resource_create', { resource: 'note', actor: 'Jace', data: { content: 'x', sql: 'SELECT 1' } }, ['Crimson', 'Jace', 'Elijah']), /unknown field: sql/);
  assert.throws(() => validateResourceArguments('hearth_resource_create', { resource: 'note', actor: 'Elijah', data: { content: 'x' } }, ['Crimson', 'Jace']), /not a configured Hearth partner/);
  assert.throws(() => validateResourceArguments('hearth_resource_create', { resource: 'medical_appointment', actor: 'Jace', data: { person: 'Jace', appointment_date: '2026-09-22', reason: 'x' } }, ['Jace', 'Elijah']), /person must be one of: Crimson, Conrad/);
  assert.throws(() => validateResourceArguments('hearth_resource_read', { resource: 'food_diary', filters: { from: '2026-01-01', to: '2026-05-01' } }, ['Jace', 'Elijah']), /90 days/);
});

test('creates every supported resource with stable IDs and safe attribution', async () => {
  const env = { DB: new D1Adapter() };
  const created = {};
  created.mood = await create(env, 'mood', { mood: 'horny', overall_scale: 5, note: 'private' }, 'Elijah');
  created.note = await create(env, 'note', { content: 'hello' });
  created.moment = await create(env, 'moment', { date: '2026-09-21', title: 'Moment', description: 'Shared' });
  created.date = await create(env, 'date', { date: '2026-10-01', title: 'Date', recurring: true });
  created.shopping_item = await create(env, 'shopping_item', { item: 'Tea', category: 'Food' }, 'Elijah');
  created.medical_appointment = await create(env, 'medical_appointment', { person: 'Crimson', appointment_date: '2026-10-02', appointment_time: '09:30', reason: 'Check' });
  created.medication = await create(env, 'medication', { person: 'Crimson', name: 'Medicine', dose: '1', frequency: 'Daily', scheduled_times: ['08:00'], start_date: '2026-09-01' });
  created.medication_dose = await create(env, 'medication_dose', { medication_id: created.medication.id, scheduled_at: '2026-09-21T08:00', status: 'Taken' });
  created.prescription_renewal = await create(env, 'prescription_renewal', { person: 'Crimson', medication_id: created.medication.id, status: 'Order soon' });
  created.household_chore = await create(env, 'household_chore', { task: 'Bins', frequency: 'Weekly', next_due_date: '2026-09-22' });
  created.home_admin_item = await create(env, 'home_admin_item', { title: 'Insurance', due_date: '2026-10-10', recurrence: 'Yearly' });
  created.food_diary_entry = await create(env, 'food_diary_entry', { date: '2026-09-21', time: '12:30', meal_type: 'lunch', note: 'Soup' });
  created.saved_meal = await create(env, 'saved_meal', { name: 'Pasta', ingredients: 'pasta, sauce', favourite: true });
  created.meal_plan_entry = await create(env, 'meal_plan_entry', { plan_date: '2026-09-22', meal: 'Pasta', saved_meal_id: created.saved_meal.id });
  created.water_entry = await create(env, 'water_entry', { date: '2026-09-21', amount_ml: 300 });
  created.food_review = await create(env, 'food_review', { date: '2026-09-21', review: 'Balanced.' }, 'Elijah');

  assert.deepEqual(Object.keys(created).sort(), [...CREATE_RESOURCES].sort());
  for (const result of Object.values(created)) assert.ok(result.id > 0);
  assert.equal(created.mood.record.partner, 'Elijah');
  assert.equal(created.note.record.from_partner, 'Jace');
  assert.equal(created.shopping_item.record.added_by, 'Elijah');
  assert.equal(created.food_review.record.reviewer, 'Elijah');
  assert.equal(created.medication_dose.record.revision, undefined);
  assert.equal(created.medication.record.person, 'Crimson');

  await assert.rejects(() => create(env, 'medication_dose', { medication_id: created.medication.id, scheduled_at: '2026-09-21T08:00', status: 'Skipped' }), error => error.status === 409);
  await assert.rejects(() => create(env, 'meal_plan_entry', { plan_date: '2026-09-22', meal: 'Other' }), error => error.status === 409);
  await assert.rejects(() => create(env, 'food_review', { date: '2026-09-21', review: 'Replace' }, 'Elijah'), error => error.status === 409);
});

test('reads every supported resource with reviewer history and bounded safe results', async () => {
  const env = { DB: new D1Adapter() };
  await create(env, 'mood', { mood: 'good' });
  await create(env, 'food_review', { date: '2026-09-21', review: 'Reviewed' }, 'Elijah');
  for (const resource of READ_RESOURCES) {
    const filters = resource === 'atmospheric_pressure' ? { view: 'history', hours: 24 } : {};
    const result = await executeResourceOperation('hearth_resource_read', { resource, filters }, env, config);
    assert.equal(result.resource, resource);
    assert.equal(result.action, 'read');
  }
  const reviews = await executeResourceOperation('hearth_resource_read', { resource: 'food_reviews', filters: {} }, env, config);
  assert.equal(reviews.records[0].reviewer, 'Elijah');
});

test('revision-protected updates cover every supported branch and fail safely', async () => {
  const env = { DB: new D1Adapter() };
  const mood = await create(env, 'mood', { mood: 'okay' });
  const note = await create(env, 'note', { content: 'a' });
  const moment = await create(env, 'moment', { date: '2026-09-21', title: 'a' });
  const date = await create(env, 'date', { date: '2026-10-01', title: 'a' });
  const shop = await create(env, 'shopping_item', { item: 'a' });
  const appointment = await create(env, 'medical_appointment', { person: 'Crimson', appointment_date: '2026-10-01', reason: 'a' });
  const medication = await create(env, 'medication', { person: 'Crimson', name: 'Med', dose: '1', frequency: 'Daily', start_date: '2026-09-01' });
  const prescription = await create(env, 'prescription_renewal', { person: 'Crimson', medication_id: medication.id });
  const chore = await create(env, 'household_chore', { task: 'a', frequency: 'Daily', next_due_date: '2026-09-20' });
  const admin = await create(env, 'home_admin_item', { title: 'a', due_date: '2026-10-01' });
  const food = await create(env, 'food_diary_entry', { date: '2026-09-21', meal_type: 'lunch' });
  env.DB.db.prepare('UPDATE food_diary SET photo_key = ? WHERE id = ?').run('food/private.jpg', food.id);
  const saved = await create(env, 'saved_meal', { name: 'a' });
  const plan = await create(env, 'meal_plan_entry', { plan_date: '2026-10-01', meal: 'a' });
  const water = await create(env, 'water_entry', { amount_ml: 250 });
  const review = await create(env, 'food_review', { date: '2026-09-20', review: 'a' });

  const cases = [
    ['mood', mood, { mood: 'great' }], ['note', note, { content: 'b' }],
    ['moment', moment, { title: 'b' }], ['date', date, { title: 'b' }],
    ['shopping_item', shop, { item: 'b', checked: true }],
    ['medical_appointment', appointment, { reason: 'b' }], ['medication', medication, { notes: 'b' }],
    ['prescription_renewal', prescription, { status: 'Ordered' }], ['household_chore', chore, { notes: 'b' }],
    ['home_admin_item', admin, { status: 'Done' }], ['food_diary_entry', food, { note: 'b' }],
    ['meal_plan_entry', plan, { meal: 'b' }], ['saved_meal', saved, { favourite: false }],
    ['water_entry', water, { amount_ml: 500 }], ['food_review', review, { review: 'b' }],
  ];
  for (const [resource, original, patch] of cases) {
    const result = await update(env, resource, original.id, original.revision, patch);
    assert.equal(result.revision, original.revision + 1, resource);
  }
  assert.equal((await env.DB.prepare('SELECT photo_key FROM food_diary WHERE id = ?').bind(food.id).first()).photo_key, 'food/private.jpg');
  await assert.rejects(() => update(env, 'note', note.id, 1, { content: 'stale' }), error => error.status === 409);
  await assert.rejects(() => update(env, 'note', 999, 1, { content: 'missing' }), error => error.status === 404);
  await assert.rejects(() => update(env, 'food_review', review.id, 2, { review: 'impersonate' }, 'Elijah'), error => error.status === 403);
  await assert.rejects(() => executeResourceOperation('hearth_resource_update', {
    resource: 'note', actor: 'Jace', id: note.id, revision: 2, patch: { content: '', created_at: 'replace' },
  }, env, config), error => error.status === 400);
  assert.equal((await env.DB.prepare('SELECT content, revision FROM notes WHERE id = ?').bind(note.id).first()).content, 'b');
  assert.equal((await env.DB.prepare('SELECT content, revision FROM notes WHERE id = ?').bind(note.id).first()).revision, 2);

  const stopped = await update(env, 'medication_state', medication.id, 2, { action: 'stop', stopped_date: '2026-09-21', stopped_reason: 'done' });
  assert.equal(stopped.record.active, 0);
  const inactiveEdit = await update(env, 'medication', medication.id, stopped.revision, { notes: 'still inactive' });
  assert.equal(inactiveEdit.record.active, 0);
  assert.equal(inactiveEdit.record.stopped_date, '2026-09-21');
  const reactivated = await update(env, 'medication_state', medication.id, inactiveEdit.revision, { action: 'reactivate' });
  assert.equal(reactivated.record.active, 1);
  assert.equal(reactivated.record.stopped_date, null);

  const completed = await update(env, 'household_completion', chore.id, 2, { action: 'complete' });
  assert.ok(completed.next_due_date);
  assert.deepEqual([...UPDATE_RESOURCES].sort(), [...new Set([...cases.map(item => item[0]), 'medication_state', 'household_completion'])].sort());
});

test('food-review updates preserve stable ID and reviewer', async () => {
  const env = { DB: new D1Adapter() };
  const review = await create(env, 'food_review', { date: '2026-09-21', review: 'first' }, 'Elijah');
  const updated = await update(env, 'food_review', review.id, review.revision, { review: 'edited' }, 'Elijah');
  assert.equal(updated.id, review.id);
  assert.equal(updated.record.reviewer, 'Elijah');
  assert.equal(updated.record.review, 'edited');
});
