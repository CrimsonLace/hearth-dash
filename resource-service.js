import { addCalendarDays, addCalendarMonths, localDateKey, localDateTimeKey, localTimeKey } from './date-utils.js';
import { configuredPartners } from './partners.js';
import {
  ADMIN_RECURRENCES, CHORE_FREQUENCIES, ResourceInputError, validateResourceArguments,
} from './resource-schemas.js';

export class ResourceServiceError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ResourceServiceError';
    this.status = status;
  }
}

const EDITABLE_TABLES = Object.freeze({
  mood: 'moods', note: 'notes', moment: 'moments', date: 'dates', shopping_item: 'shopping',
  medical_appointment: 'medical_appointments', medication: 'medications', medication_state: 'medications',
  prescription_renewal: 'prescription_renewals', household_chore: 'household_chores',
  household_completion: 'household_chores', home_admin_item: 'home_admin', food_diary_entry: 'food_diary',
  meal_plan_entry: 'meal_plan', saved_meal: 'saved_meals', water_entry: 'water_log', food_review: 'food_reviews',
});

export async function executeResourceOperation(toolName, rawArgs, env, config) {
  let args;
  try {
    args = validateResourceArguments(toolName, rawArgs, configuredPartners(config));
  } catch (error) {
    if (error instanceof ResourceInputError) throw new ResourceServiceError(error.message, error.status);
    throw error;
  }
  if (toolName === 'hearth_resource_read') return readResource(env, config, args);
  if (toolName === 'hearth_resource_create') return createResource(env, config, args);
  if (toolName === 'hearth_resource_update') return updateResource(env, config, args);
  throw new ResourceServiceError('Unknown resource operation', 400);
}

async function readResource(env, config, { resource, filters }) {
  const today = localDateKey();
  let result;
  switch (resource) {
    case 'dashboard': result = await readDashboard(env, config, today); break;
    case 'moods': result = await readList(env, 'moods', filters, {
      partner: ['partner = ?', filters.partner],
    }, 'created_at DESC', filters.limit || 20); break;
    case 'notes': result = await readList(env, 'notes', filters, {}, 'created_at DESC', filters.limit || 20); break;
    case 'moments': result = await readDateRange(env, 'moments', 'date', filters, 'date DESC', filters.limit || 50); break;
    case 'dates': {
      const normalized = { ...filters };
      if (!normalized.include_past && !normalized.from) normalized.from = today;
      delete normalized.include_past;
      result = await readDateRange(env, 'dates', 'date', normalized, 'date ASC, id ASC', filters.limit || 50);
      break;
    }
    case 'shopping': {
      const where = filters.state && filters.state !== 'all' ? ' WHERE checked = ?' : '';
      const args = where ? [filters.state === 'checked' ? 1 : 0] : [];
      result = await all(env, `SELECT * FROM shopping${where} ORDER BY checked ASC, created_at DESC`, args);
      break;
    }
    case 'medical_appointments': result = await readDateRange(env, 'medical_appointments', 'appointment_date', filters, 'appointment_date DESC, appointment_time DESC', 200, {
      person: ['person = ?', filters.person], status: ['status = ?', filters.status],
    }); break;
    case 'medications': result = await readList(env, 'medications', filters, {
      person: ['person = ?', filters.person], active: ['active = ?', filters.active === undefined ? undefined : (filters.active ? 1 : 0)],
    }, 'active DESC, person, name', 200); result = result.map(parseMedication); break;
    case 'medication_doses': {
      const ranges = filters.date ? { from: filters.date, to: filters.date } : filters;
      result = await readDateRange(env, 'medication_doses', 'substr(scheduled_at, 1, 10)', ranges, 'scheduled_at DESC', filters.limit || 200, {
        person: ['person = ?', filters.person],
      });
      break;
    }
    case 'prescription_renewals': result = await readList(env, 'prescription_renewals', filters, {
      person: ['person = ?', filters.person], status: ['status = ?', filters.status],
    }, 'next_order_date DESC, created_at DESC', 200); break;
    case 'household_chores': {
      const conditions = {};
      if (filters.state === 'done') conditions.done = ['done = 1', true];
      if (filters.state === 'due') { conditions.done = ['done = 0', true]; conditions.due = ['next_due_date <= ?', filters.to || today]; }
      if (filters.state === 'upcoming') { conditions.done = ['done = 0', true]; conditions.after = ['next_due_date > ?', today]; conditions.to = ['next_due_date <= ?', filters.to]; }
      result = await readList(env, 'household_chores', filters, conditions, 'done ASC, next_due_date ASC, created_at DESC', 200);
      break;
    }
    case 'home_admin': result = await readList(env, 'home_admin', filters, {
      status: ['status = ?', filters.status], to: ['due_date <= ?', filters.to],
    }, "status = 'Done', due_date ASC", 200); break;
    case 'food_diary': {
      const ranges = filters.date ? { from: filters.date, to: filters.date } : filters;
      result = (await readDateRange(env, 'food_diary', 'date', ranges, 'date DESC, time ASC', 500)).map(safeFoodDiaryRecord);
      break;
    }
    case 'meal_plan': result = await readDateRange(env, 'meal_plan', 'plan_date', {
      from: filters.from || today, to: filters.to || addCalendarDays(filters.from || today, 6),
    }, 'plan_date ASC', 100); break;
    case 'saved_meals': result = await readList(env, 'saved_meals', filters, {
      favourite: ['favourite = ?', filters.favourite === undefined ? undefined : (filters.favourite ? 1 : 0)],
    }, 'favourite DESC, name', 200); break;
    case 'water': {
      const ranges = filters.date ? { from: filters.date, to: filters.date } : filters;
      result = await readDateRange(env, 'water_log', 'date', ranges, 'date DESC, created_at ASC', 500);
      break;
    }
    case 'food_reviews': {
      const ranges = filters.date ? { from: filters.date, to: filters.date } : filters;
      result = await readDateRange(env, 'food_reviews', 'date', ranges, 'date DESC', filters.limit || 7);
      break;
    }
    case 'atmospheric_pressure': result = await readAtmosphericPressure(env, filters); break;
    default: throw new ResourceServiceError('Unknown read resource', 400);
  }
  return { resource, action: 'read', count: Array.isArray(result) ? result.length : undefined, records: Array.isArray(result) ? result : undefined, record: Array.isArray(result) ? undefined : result, as_of: new Date().toISOString() };
}

async function createResource(env, config, { resource, actor, data }) {
  let id;
  let table;
  try {
    switch (resource) {
      case 'mood':
        table = 'moods'; id = await insert(env, `INSERT INTO moods (partner, mood, note, overall_scale, created_at) VALUES (?, ?, ?, ?, datetime('now'))`, [actor, data.mood, data.note ?? null, data.overall_scale ?? null]); break;
      case 'note':
        table = 'notes'; id = await insert(env, `INSERT INTO notes (from_partner, content, created_at) VALUES (?, ?, datetime('now'))`, [actor, data.content]); break;
      case 'moment':
        table = 'moments'; id = await insert(env, `INSERT INTO moments (date, title, description, created_at) VALUES (?, ?, ?, datetime('now'))`, [data.date, data.title, data.description ?? null]); break;
      case 'date':
        table = 'dates'; id = await insert(env, `INSERT INTO dates (date, title, recurring, created_at) VALUES (?, ?, ?, datetime('now'))`, [data.date, data.title, data.recurring ? 1 : 0]); break;
      case 'shopping_item':
        table = 'shopping'; id = await insert(env, `INSERT INTO shopping (item, category, checked, added_by, created_at) VALUES (?, ?, 0, ?, datetime('now'))`, [data.item, data.category || 'Other', actor]); break;
      case 'medical_appointment':
        table = 'medical_appointments'; id = await insert(env, `INSERT INTO medical_appointments (person, appointment_date, appointment_time, location, clinic, clinician, reason, notes, status, transport_needed, preparation_needed) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [data.person, data.appointment_date, data.appointment_time ?? null, data.location ?? null, data.clinic ?? null, data.clinician ?? null, data.reason, data.notes ?? null, data.status || 'Upcoming', data.transport_needed ? 1 : 0, data.preparation_needed ?? null]); break;
      case 'medication':
        table = 'medications'; id = await insert(env, `INSERT INTO medications (person, name, strength, dose, frequency, scheduled_times, prescribing_source, notes, active, start_date) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`, [data.person, data.name, data.strength ?? null, data.dose, data.frequency, JSON.stringify(data.scheduled_times || []), data.prescribing_source ?? null, data.notes ?? null, data.start_date]); break;
      case 'medication_dose': return await createMedicationDose(env, actor, data);
      case 'prescription_renewal': {
        table = 'prescription_renewals';
        const selection = await resolvePrescription(env, data);
        id = await insert(env, `INSERT INTO prescription_renewals (medication_id, person, medication_name, last_ordered_date, next_order_date, quantity_remaining, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`, [selection.medication_id, selection.person, selection.medication_name, data.last_ordered_date ?? null, data.next_order_date ?? null, data.quantity_remaining ?? null, data.status || 'Enough', data.notes ?? null]);
        break;
      }
      case 'household_chore':
        table = 'household_chores'; validateRecurrence(data.frequency || 'One-off', data.recurrence_days, CHORE_FREQUENCIES, 'frequency');
        id = await insert(env, `INSERT INTO household_chores (task, frequency, recurrence_days, next_due_date, notes) VALUES (?, ?, ?, ?, ?)`, [data.task, data.frequency || 'One-off', data.recurrence_days ?? null, data.next_due_date, data.notes ?? null]); break;
      case 'home_admin_item':
        table = 'home_admin'; validateRecurrence(data.recurrence || 'None', data.recurrence_days, ADMIN_RECURRENCES, 'recurrence');
        id = await insert(env, `INSERT INTO home_admin (title, category, due_date, recurrence, recurrence_days, status, notes) VALUES (?, ?, ?, ?, ?, ?, ?)`, [data.title, data.category || 'General', data.due_date, data.recurrence || 'None', data.recurrence_days ?? null, data.status || 'Upcoming', data.notes ?? null]); break;
      case 'food_diary_entry':
        table = 'food_diary'; id = await insert(env, `INSERT INTO food_diary (date, time, meal_type, note, photo_key, created_at) VALUES (?, ?, ?, ?, NULL, datetime('now'))`, [data.date || localDateKey(), data.time || localTimeKey(), data.meal_type, data.note ?? null]); break;
      case 'meal_plan_entry':
        table = 'meal_plan'; await requireSavedMeal(env, data.saved_meal_id);
        id = await insert(env, `INSERT INTO meal_plan (plan_date, meal, notes, ingredients_needed, saved_meal_id) VALUES (?, ?, ?, ?, ?)`, [data.plan_date, data.meal, data.notes ?? null, data.ingredients_needed ?? null, data.saved_meal_id ?? null]); break;
      case 'saved_meal':
        table = 'saved_meals'; id = await insert(env, `INSERT INTO saved_meals (name, notes, ingredients, favourite) VALUES (?, ?, ?, ?)`, [data.name, data.notes ?? null, data.ingredients ?? null, data.favourite === false ? 0 : 1]); break;
      case 'water_entry':
        table = 'water_log'; id = await insert(env, `INSERT INTO water_log (date, amount_ml, created_at) VALUES (?, ?, datetime('now'))`, [data.date || localDateKey(), data.amount_ml ?? 250]); break;
      case 'food_review':
        table = 'food_reviews'; id = await insert(env, `INSERT INTO food_reviews (date, review, reviewer, created_at) VALUES (?, ?, ?, datetime('now'))`, [data.date, data.review, actor]); break;
      default: throw new ResourceServiceError('Unknown create resource', 400);
    }
  } catch (error) {
    if (isUniqueConflict(error)) throw new ResourceServiceError(resource === 'medication_dose' ? 'Dose already recorded' : `${resource} already exists for that unique date or slot`, 409);
    throw error;
  }
  const record = sanitizeRecord(resource, await findById(env, table, id));
  return { resource, action: 'created', id, revision: record.revision, actor, record };
}

async function updateResource(env, config, { resource, actor, id, revision, patch }) {
  const table = EDITABLE_TABLES[resource];
  const existing = await findById(env, table, id);
  if (!existing) throw new ResourceServiceError(`${resource} not found`, 404);
  enforceAuthoredOwnership(resource, existing, actor);
  let changes;
  switch (resource) {
    case 'mood': changes = pick(patch, ['mood', 'overall_scale', 'note']); break;
    case 'note': changes = pick(patch, ['content']); break;
    case 'moment': changes = pick(patch, ['date', 'title', 'description']); break;
    case 'date': changes = mapBooleans(pick(patch, ['date', 'title', 'recurring']), ['recurring']); break;
    case 'shopping_item': changes = mapBooleans(pick(patch, ['item', 'category', 'checked']), ['checked']); break;
    case 'medical_appointment': changes = mapBooleans(pick(patch, ['person', 'appointment_date', 'appointment_time', 'location', 'clinic', 'clinician', 'reason', 'notes', 'status', 'transport_needed', 'preparation_needed']), ['transport_needed']); break;
    case 'medication':
      changes = pick(patch, ['person', 'name', 'strength', 'dose', 'frequency', 'scheduled_times', 'prescribing_source', 'notes', 'start_date']);
      if (changes.scheduled_times) changes.scheduled_times = JSON.stringify(changes.scheduled_times);
      break;
    case 'medication_state': return updateMedicationState(env, actor, existing, revision, patch);
    case 'prescription_renewal': {
      const merged = { ...existing, ...patch };
      const selection = await resolvePrescription(env, merged, existing);
      changes = { ...pick(patch, ['last_ordered_date', 'next_order_date', 'quantity_remaining', 'status', 'notes']), ...selection };
      break;
    }
    case 'household_chore': {
      const merged = { ...existing, ...patch };
      validateRecurrence(merged.frequency, merged.recurrence_days, CHORE_FREQUENCIES, 'frequency');
      changes = pick(patch, ['task', 'frequency', 'recurrence_days', 'next_due_date', 'notes']);
      break;
    }
    case 'household_completion': return completeHouseholdChore(env, actor, existing, revision);
    case 'home_admin_item': {
      const merged = { ...existing, ...patch };
      validateRecurrence(merged.recurrence, merged.recurrence_days, ADMIN_RECURRENCES, 'recurrence');
      changes = pick(patch, ['title', 'category', 'due_date', 'recurrence', 'recurrence_days', 'status', 'notes']);
      if (patch.status !== undefined) changes.completed_at = patch.status === 'Done' ? (existing.completed_at || new Date().toISOString()) : null;
      break;
    }
    case 'food_diary_entry': changes = pick(patch, ['date', 'time', 'meal_type', 'note']); break;
    case 'meal_plan_entry': await requireSavedMeal(env, patch.saved_meal_id); changes = pick(patch, ['plan_date', 'meal', 'notes', 'ingredients_needed', 'saved_meal_id']); break;
    case 'saved_meal': changes = mapBooleans(pick(patch, ['name', 'notes', 'ingredients', 'favourite']), ['favourite']); break;
    case 'water_entry': changes = pick(patch, ['date', 'amount_ml']); break;
    case 'food_review': changes = pick(patch, ['date', 'review']); break;
    default: throw new ResourceServiceError('Unknown update resource', 400);
  }
  try {
    const record = await revisionUpdate(env, table, id, revision, changes, hasUpdatedAt(table));
    return { resource, action: 'updated', id, revision: record.revision, actor, record: sanitizeRecord(resource, record) };
  } catch (error) {
    if (isUniqueConflict(error)) throw new ResourceServiceError(`${resource} conflicts with an existing unique date`, 409);
    throw error;
  }
}

async function createMedicationDose(env, actor, data) {
  const medication = await findById(env, 'medications', data.medication_id);
  if (!medication) throw new ResourceServiceError('Medication not found', 404);
  const scheduledAt = data.scheduled_at || localDateTimeKey();
  const status = data.status || 'Taken';
  const id = await insert(env, `INSERT INTO medication_doses (medication_id, person, medication_name, medication_strength, medication_dose, scheduled_at, actual_taken_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`, [medication.id, medication.person, medication.name, medication.strength || null, medication.dose, scheduledAt, status === 'Taken' ? new Date().toISOString() : null, status]);
  return { resource: 'medication_dose', action: 'created', id, actor, record: await findById(env, 'medication_doses', id) };
}

async function updateMedicationState(env, actor, existing, revision, patch) {
  let changes;
  if (patch.action === 'stop') {
    changes = { active: 0, stopped_date: patch.stopped_date || localDateKey(), stopped_reason: patch.stopped_reason ?? existing.stopped_reason ?? null };
  } else {
    changes = { active: 1, stopped_date: null, stopped_reason: null };
  }
  const record = await revisionUpdate(env, 'medications', existing.id, revision, changes, true);
  return { resource: 'medication_state', action: patch.action === 'stop' ? 'stopped' : 'reactivated', id: existing.id, revision: record.revision, actor, record: parseMedication(record) };
}

async function completeHouseholdChore(env, actor, existing, revision) {
  const nextDue = nextChoreDueDate(existing.next_due_date, existing.frequency, existing.recurrence_days, localDateKey());
  const changes = nextDue
    ? { next_due_date: nextDue, done: 0, last_completed_at: new Date().toISOString() }
    : { done: 1, last_completed_at: new Date().toISOString() };
  const record = await revisionUpdate(env, 'household_chores', existing.id, revision, changes, true);
  return { resource: 'household_completion', action: 'completed', id: existing.id, revision: record.revision, actor, next_due_date: nextDue, record };
}

async function revisionUpdate(env, table, id, revision, changes, updateTimestamp) {
  const entries = Object.entries(changes);
  if (!entries.length) throw new ResourceServiceError('patch must contain at least one field', 400);
  const sets = entries.map(([column]) => `${column} = ?`);
  if (updateTimestamp) sets.push(`updated_at = datetime('now')`);
  sets.push('revision = revision + 1');
  const result = await env.DB.prepare(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ? AND revision = ?`)
    .bind(...entries.map(([, value]) => value), id, revision).run();
  const changesCount = result?.meta?.changes ?? result?.changes ?? 0;
  if (changesCount !== 1) {
    const exists = await env.DB.prepare(`SELECT id FROM ${table} WHERE id = ?`).bind(id).first();
    if (!exists) throw new ResourceServiceError('Record not found', 404);
    throw new ResourceServiceError('Record has changed; read it again before updating', 409);
  }
  return findById(env, table, id);
}

async function readDashboard(env, config, today) {
  const partners = configuredPartners(config);
  const partnerMoods = await Promise.all(partners.map(partner => env.DB.prepare('SELECT * FROM moods WHERE partner = ? ORDER BY created_at DESC LIMIT 1').bind(partner).first()));
  const [latestNote, dates, shopping, shoppingCount, meals, water, medical, medications, doses, prescriptions, chores, admin, moment, tonight] = await Promise.all([
    first(env, 'SELECT * FROM notes ORDER BY created_at DESC LIMIT 1'),
    all(env, 'SELECT * FROM dates WHERE date >= ? ORDER BY date ASC, id ASC LIMIT 3', [today]),
    all(env, 'SELECT * FROM shopping WHERE checked = 0 ORDER BY created_at DESC LIMIT 5'),
    first(env, 'SELECT COUNT(*) AS count FROM shopping WHERE checked = 0'),
    all(env, 'SELECT * FROM food_diary WHERE date = ? ORDER BY time ASC', [today]),
    first(env, 'SELECT SUM(amount_ml) AS total FROM water_log WHERE date = ?', [today]),
    first(env, `SELECT * FROM medical_appointments WHERE status = 'Upcoming' AND appointment_date >= ? ORDER BY appointment_date, appointment_time LIMIT 1`, [today]),
    all(env, 'SELECT * FROM medications WHERE active = 1 ORDER BY person, name'),
    all(env, 'SELECT * FROM medication_doses WHERE substr(scheduled_at, 1, 10) = ? ORDER BY scheduled_at', [today]),
    all(env, `SELECT * FROM prescription_renewals WHERE status != 'Collected' AND next_order_date IS NOT NULL AND next_order_date <= ? ORDER BY next_order_date`, [addCalendarDays(today, 14)]),
    all(env, 'SELECT * FROM household_chores WHERE done = 0 AND next_due_date <= ? ORDER BY next_due_date', [today]),
    all(env, `SELECT * FROM home_admin WHERE status != 'Done' AND due_date <= ? ORDER BY due_date`, [addCalendarDays(today, 14)]),
    first(env, 'SELECT * FROM moments ORDER BY created_at DESC LIMIT 1'),
    first(env, 'SELECT * FROM meal_plan WHERE plan_date = ? LIMIT 1', [today]),
  ]);
  return {
    today, moods: Object.fromEntries(partners.map((partner, index) => [partner, partnerMoods[index]])), latest_note: latestNote,
    upcoming_dates: dates, shopping_preview: shopping, shopping_count: shoppingCount?.count || 0,
    today_meals: meals.map(safeFoodDiaryRecord), water_total: water?.total || 0,
    next_medical: medical, medications: medications.map(parseMedication), today_doses: doses,
    prescription_renewals: prescriptions, household: chores, home_admin: admin, latest_moment: moment, tonight_meal: tonight,
  };
}

async function readList(env, table, _filters, conditionMap, order, limit) {
  const clauses = [];
  const args = [];
  for (const [sql, value] of Object.values(conditionMap)) {
    if (value === undefined || value === null) continue;
    clauses.push(sql);
    if (sql.includes('?')) args.push(value);
  }
  return all(env, `SELECT * FROM ${table}${clauses.length ? ` WHERE ${clauses.join(' AND ')}` : ''} ORDER BY ${order} LIMIT ?`, [...args, limit]);
}

async function readDateRange(env, table, column, filters, order, limit, extra = {}) {
  const conditions = { ...extra, from: [`${column} >= ?`, filters.from], to: [`${column} <= ?`, filters.to] };
  return readList(env, table, filters, conditions, order, limit);
}

async function readAtmosphericPressure(env, filters) {
  const view = filters.view || 'status';
  if (view === 'history') {
    const hours = filters.hours || 72;
    return { kind: 'barometric_pressure', unit: 'hPa', readings: await all(env, `SELECT pressure_hpa, temp, recorded_at FROM pressure_log WHERE recorded_at >= datetime('now', '-${hours} hours') ORDER BY recorded_at ASC`) };
  }
  const key = env.WEATHER_API_KEY;
  if (!key) throw new ResourceServiceError('Atmospheric pressure service is not configured', 503);
  if (view === 'forecast') {
    const response = await fetch(`https://api.openweathermap.org/data/2.5/forecast?lat=${env.WEATHER_LAT}&lon=${env.WEATHER_LON}&units=metric&appid=${key}`);
    if (!response.ok) throw new ResourceServiceError('Atmospheric pressure forecast is unavailable', 502);
    const data = await response.json();
    return { kind: 'barometric_pressure', unit: 'hPa', forecast: (data.list || []).map(item => ({ pressure_hpa: item.main.pressure, temperature_c: item.main.temp, time: item.dt_txt })) };
  }
  const response = await fetch(`https://api.openweathermap.org/data/2.5/weather?lat=${env.WEATHER_LAT}&lon=${env.WEATHER_LON}&units=metric&appid=${key}`);
  if (!response.ok) throw new ResourceServiceError('Atmospheric pressure status is unavailable', 502);
  const data = await response.json();
  return { kind: 'barometric_pressure', unit: 'hPa', pressure_hpa: data.main.pressure, temperature_c: data.main.temp, recorded_at: new Date().toISOString() };
}

async function resolvePrescription(env, data, existing = null) {
  if (data.medication_id != null) {
    const medication = await findById(env, 'medications', data.medication_id);
    if (!medication) throw new ResourceServiceError('medication_id must reference an existing medication', 400);
    if (medication.person !== data.person) throw new ResourceServiceError('medication_id must belong to the selected person', 400);
    if (!medication.active && Number(existing?.medication_id) !== medication.id) throw new ResourceServiceError('medication_id must reference an active medication', 400);
    return { medication_id: medication.id, person: data.person, medication_name: existing?.medication_id === medication.id && !medication.active ? existing.medication_name : medication.name };
  }
  const name = data.medication_name;
  const unchanged = existing?.medication_id == null && name === existing?.medication_name;
  if (!['All medications', 'Custom / other'].includes(name) && !unchanged) throw new ResourceServiceError('medication_name must be All medications or Custom / other', 400);
  return { medication_id: null, person: data.person, medication_name: name };
}

async function requireSavedMeal(env, id) {
  if (id == null) return;
  if (!(await findById(env, 'saved_meals', id))) throw new ResourceServiceError('saved_meal_id must reference an existing saved meal', 400);
}

function enforceAuthoredOwnership(resource, record, actor) {
  const field = resource === 'mood' ? 'partner' : resource === 'note' ? 'from_partner' : resource === 'food_review' ? 'reviewer' : null;
  if (field && record[field] !== actor) throw new ResourceServiceError(`Only ${record[field]} may edit this ${resource}`, 403);
}

function validateRecurrence(value, days, choices, name) {
  if (!choices.includes(value)) throw new ResourceServiceError(`${name} is invalid`, 400);
  if (value === 'Custom' && (!Number.isInteger(days) || days < 1 || days > 3650)) throw new ResourceServiceError('recurrence_days is required for Custom recurrence', 400);
  if (value !== 'Custom' && days != null) throw new ResourceServiceError('recurrence_days is only valid for Custom recurrence', 400);
}

function nextChoreDueDate(currentDue, frequency, recurrenceDays, today) {
  if (frequency === 'One-off') return null;
  const base = currentDue > today ? currentDue : today;
  if (frequency === 'Daily') return addCalendarDays(base, 1);
  if (frequency === 'Weekly') return addCalendarDays(base, 7);
  if (frequency === 'Monthly') return addCalendarMonths(base, 1);
  return addCalendarDays(base, recurrenceDays);
}

async function insert(env, sql, args) {
  const result = await env.DB.prepare(sql).bind(...args).run();
  const id = result?.meta?.last_row_id ?? result?.lastRowId;
  if (!Number.isInteger(Number(id)) || Number(id) < 1) throw new ResourceServiceError('Hearth could not confirm the created record ID', 500);
  return Number(id);
}

async function findById(env, table, id) { return env.DB.prepare(`SELECT * FROM ${table} WHERE id = ?`).bind(id).first(); }
async function first(env, sql, args = []) { return env.DB.prepare(sql).bind(...args).first(); }
async function all(env, sql, args = []) { const result = await env.DB.prepare(sql).bind(...args).all(); return result.results || []; }

function pick(value, fields) { return Object.fromEntries(fields.filter(key => value[key] !== undefined).map(key => [key, value[key]])); }
function mapBooleans(value, fields) { const result = { ...value }; for (const field of fields) if (result[field] !== undefined) result[field] = result[field] ? 1 : 0; return result; }
function parseMedication(row) { return { ...row, scheduled_times: typeof row.scheduled_times === 'string' ? safeJsonArray(row.scheduled_times) : row.scheduled_times || [] }; }
function safeJsonArray(value) { try { const parsed = JSON.parse(value); return Array.isArray(parsed) ? parsed : []; } catch { return []; } }
function safeFoodDiaryRecord(record) { const { photo_key, ...safe } = record; return { ...safe, has_photo: Boolean(photo_key) }; }
function sanitizeRecord(resource, record) { return resource === 'food_diary_entry' ? safeFoodDiaryRecord(record) : resource === 'medication' || resource === 'medication_state' ? parseMedication(record) : record; }
function hasUpdatedAt(table) { return ['medical_appointments', 'medications', 'prescription_renewals', 'household_chores', 'home_admin', 'saved_meals', 'meal_plan'].includes(table); }
function isUniqueConflict(error) { let current = error; for (let i = 0; current && i < 4; i += 1) { if (/UNIQUE constraint failed/i.test(String(current.message || current))) return true; current = current.cause; } return false; }
