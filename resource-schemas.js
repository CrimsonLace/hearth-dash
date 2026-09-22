import { MOOD_OPTIONS } from './moods.js';
import { addCalendarDays, isValidLocalDateTime } from './date-utils.js';

export const RESOURCE_ACTORS = Object.freeze(['Jace', 'Elijah']);
export const MEDICAL_PEOPLE = Object.freeze(['Crimson', 'Conrad']);
export const APPOINTMENT_STATUSES = Object.freeze(['Upcoming', 'Completed', 'Cancelled', 'Rescheduled']);
export const DOSE_STATUSES = Object.freeze(['Due', 'Taken', 'Skipped']);
export const PRESCRIPTION_STATUSES = Object.freeze(['Enough', 'Order soon', 'Ordered', 'Ready', 'Collected']);
export const CHORE_FREQUENCIES = Object.freeze(['One-off', 'Daily', 'Weekly', 'Monthly', 'Custom']);
export const ADMIN_RECURRENCES = Object.freeze(['None', 'Monthly', 'Yearly', 'Custom']);
export const ADMIN_STATUSES = Object.freeze(['Upcoming', 'Due soon', 'Done']);
export const MEAL_TYPES = Object.freeze(['breakfast', 'lunch', 'dinner', 'snack']);

export const READ_RESOURCES = Object.freeze([
  'dashboard', 'moods', 'notes', 'moments', 'dates', 'shopping',
  'medical_appointments', 'medications', 'medication_doses', 'prescription_renewals',
  'household_chores', 'home_admin', 'food_diary', 'meal_plan', 'saved_meals',
  'water', 'food_reviews', 'atmospheric_pressure',
]);

export const CREATE_RESOURCES = Object.freeze([
  'mood', 'note', 'moment', 'date', 'shopping_item', 'medical_appointment',
  'medication', 'medication_dose', 'prescription_renewal', 'household_chore',
  'home_admin_item', 'food_diary_entry', 'meal_plan_entry', 'saved_meal',
  'water_entry', 'food_review',
]);

export const UPDATE_RESOURCES = Object.freeze([
  'mood', 'note', 'moment', 'date', 'shopping_item', 'medical_appointment',
  'medication', 'medication_state', 'prescription_renewal', 'household_chore',
  'household_completion', 'home_admin_item', 'food_diary_entry', 'meal_plan_entry',
  'saved_meal', 'water_entry', 'food_review',
]);

export class ResourceInputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'ResourceInputError';
    this.status = status;
  }
}

const positiveInteger = boundedInteger(1, Number.MAX_SAFE_INTEGER);
const booleanValue = { kind: 'boolean' };
const isoDate = { kind: 'date' };
const clockTime = { kind: 'time' };
const dateTime = { kind: 'datetime' };
const partnerName = { kind: 'partner' };
const timeArray = { kind: 'times' };

const READ_FIELDS = {
  dashboard: {},
  moods: { partner: partnerName, limit: boundedInteger(1, 50) },
  notes: { limit: boundedInteger(1, 50) },
  moments: { from: isoDate, to: isoDate, limit: boundedInteger(1, 100) },
  dates: { from: isoDate, to: isoDate, include_past: booleanValue, limit: boundedInteger(1, 100) },
  shopping: { state: enumValue(['unchecked', 'checked', 'all']), limit: boundedInteger(1, 200) },
  medical_appointments: { person: enumValue(MEDICAL_PEOPLE), status: enumValue(APPOINTMENT_STATUSES), from: isoDate, to: isoDate },
  medications: { person: enumValue(MEDICAL_PEOPLE), active: booleanValue },
  medication_doses: { person: enumValue(MEDICAL_PEOPLE), date: isoDate, from: isoDate, to: isoDate, limit: boundedInteger(1, 200) },
  prescription_renewals: { person: enumValue(MEDICAL_PEOPLE), status: enumValue(PRESCRIPTION_STATUSES) },
  household_chores: { state: enumValue(['due', 'upcoming', 'done', 'all']), to: isoDate },
  home_admin: { status: enumValue(ADMIN_STATUSES), to: isoDate },
  food_diary: { date: isoDate, from: isoDate, to: isoDate },
  meal_plan: { from: isoDate, to: isoDate },
  saved_meals: { favourite: booleanValue },
  water: { date: isoDate, from: isoDate, to: isoDate },
  food_reviews: { date: isoDate, from: isoDate, to: isoDate, limit: boundedInteger(1, 30) },
  atmospheric_pressure: { view: enumValue(['status', 'history', 'forecast']), hours: boundedInteger(1, 720) },
};

const CREATE_FIELDS = {
  mood: { mood: required(enumValue(MOOD_OPTIONS)), overall_scale: nullable(boundedInteger(1, 5)), note: nullableText(2000) },
  note: { content: required(text(4000)) },
  moment: { date: required(isoDate), title: required(text(200)), description: nullableText(4000) },
  date: { date: required(isoDate), title: required(text(200)), recurring: booleanValue },
  shopping_item: { item: required(text(300)), category: text(100) },
  medical_appointment: appointmentFields(true),
  medication: medicationFields(true),
  medication_dose: { medication_id: required(positiveInteger), scheduled_at: dateTime, status: enumValue(DOSE_STATUSES) },
  prescription_renewal: prescriptionFields(true),
  household_chore: choreFields(true),
  home_admin_item: adminFields(true),
  food_diary_entry: { date: isoDate, time: clockTime, meal_type: required(enumValue(MEAL_TYPES)), note: nullableText(4000) },
  meal_plan_entry: mealPlanFields(true),
  saved_meal: savedMealFields(true),
  water_entry: { date: isoDate, amount_ml: boundedInteger(1, 5000) },
  food_review: { date: required(isoDate), review: required(text(6000)) },
};

const UPDATE_FIELDS = {
  mood: { mood: enumValue(MOOD_OPTIONS), overall_scale: nullable(boundedInteger(1, 5)), note: nullableText(2000) },
  note: { content: text(4000) },
  moment: { date: isoDate, title: text(200), description: nullableText(4000) },
  date: { date: isoDate, title: text(200), recurring: booleanValue },
  shopping_item: { item: text(300), category: text(100), checked: booleanValue },
  medical_appointment: appointmentFields(false),
  medication: medicationFields(false),
  medication_state: { action: required(enumValue(['stop', 'reactivate'])), stopped_date: isoDate, stopped_reason: nullableText(1000) },
  prescription_renewal: prescriptionFields(false),
  household_chore: choreFields(false),
  household_completion: { action: required(enumValue(['complete'])) },
  home_admin_item: adminFields(false),
  food_diary_entry: { date: isoDate, time: clockTime, meal_type: enumValue(MEAL_TYPES), note: nullableText(4000) },
  meal_plan_entry: mealPlanFields(false),
  saved_meal: savedMealFields(false),
  water_entry: { date: isoDate, amount_ml: boundedInteger(1, 5000) },
  food_review: { date: isoDate, review: text(6000) },
};

function appointmentFields(requiredFields) {
  const fields = {
    person: enumValue(MEDICAL_PEOPLE), appointment_date: isoDate, appointment_time: nullable(clockTime),
    location: nullableText(300), clinic: nullableText(300), clinician: nullableText(300),
    reason: text(500), notes: nullableText(4000), status: enumValue(APPOINTMENT_STATUSES),
    transport_needed: booleanValue, preparation_needed: nullableText(1000),
  };
  if (requiredFields) for (const key of ['person', 'appointment_date', 'reason']) fields[key] = required(fields[key]);
  return fields;
}

function medicationFields(requiredFields) {
  const fields = {
    person: enumValue(MEDICAL_PEOPLE), name: text(300), strength: nullableText(100), dose: text(200),
    frequency: text(200), scheduled_times: timeArray, prescribing_source: nullableText(300),
    notes: nullableText(4000), start_date: isoDate,
  };
  if (requiredFields) for (const key of ['person', 'name', 'dose', 'frequency', 'start_date']) fields[key] = required(fields[key]);
  return fields;
}

function prescriptionFields(requiredFields) {
  const fields = {
    medication_id: nullable(positiveInteger), person: enumValue(MEDICAL_PEOPLE), medication_name: text(300),
    last_ordered_date: nullable(isoDate), next_order_date: nullable(isoDate),
    quantity_remaining: nullable(boundedInteger(0, Number.MAX_SAFE_INTEGER)), status: enumValue(PRESCRIPTION_STATUSES),
    notes: nullableText(4000),
  };
  if (requiredFields) fields.person = required(fields.person);
  return fields;
}

function choreFields(requiredFields) {
  const fields = {
    task: text(300), frequency: enumValue(CHORE_FREQUENCIES), recurrence_days: nullable(boundedInteger(1, 3650)),
    next_due_date: isoDate, notes: nullableText(4000),
  };
  if (requiredFields) for (const key of ['task', 'next_due_date']) fields[key] = required(fields[key]);
  return fields;
}

function adminFields(requiredFields) {
  const fields = {
    title: text(300), category: text(100), due_date: isoDate, recurrence: enumValue(ADMIN_RECURRENCES),
    recurrence_days: nullable(boundedInteger(1, 3650)), status: enumValue(ADMIN_STATUSES), notes: nullableText(4000),
  };
  if (requiredFields) for (const key of ['title', 'due_date']) fields[key] = required(fields[key]);
  return fields;
}

function mealPlanFields(requiredFields) {
  const fields = {
    plan_date: isoDate, meal: text(300), notes: nullableText(2000),
    ingredients_needed: nullableText(2000), saved_meal_id: nullable(positiveInteger),
  };
  if (requiredFields) for (const key of ['plan_date', 'meal']) fields[key] = required(fields[key]);
  return fields;
}

function savedMealFields(requiredFields) {
  const fields = { name: text(300), notes: nullableText(2000), ingredients: nullableText(2000), favourite: booleanValue };
  if (requiredFields) fields.name = required(fields.name);
  return fields;
}

function required(validator) { return { ...validator, required: true }; }
function nullable(validator) { return { ...validator, nullable: true }; }
function text(max) { return { kind: 'text', max }; }
function nullableText(max) { return nullable(text(max)); }
function enumValue(values) { return { kind: 'enum', values: [...values] }; }
function boundedInteger(min, max) { return { kind: 'integer', min, max }; }
export function validateResourceArguments(toolName, args, configuredPartners = []) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ResourceInputError('arguments must be an object');
  if (toolName === 'hearth_resource_read') return validateRead(args, configuredPartners);
  if (toolName === 'hearth_resource_create') return validateWrite(args, CREATE_FIELDS, CREATE_RESOURCES, configuredPartners, false);
  if (toolName === 'hearth_resource_update') return validateWrite(args, UPDATE_FIELDS, UPDATE_RESOURCES, configuredPartners, true);
  throw new ResourceInputError('Unknown resource tool');
}

function validateRead(args, configuredPartners) {
  rejectUnknown(args, ['resource', 'filters']);
  const resource = requireResource(args.resource, READ_RESOURCES);
  const filters = args.filters === undefined ? {} : args.filters;
  const data = validateFields(filters, READ_FIELDS[resource], false, configuredPartners);
  validateDateRange(data);
  return { resource, filters: data };
}

function validateWrite(args, schemas, resources, configuredPartners, update) {
  rejectUnknown(args, update ? ['resource', 'actor', 'id', 'revision', 'patch'] : ['resource', 'actor', 'data']);
  const resource = requireResource(args.resource, resources);
  const actor = validateActor(args.actor, configuredPartners);
  const source = update ? args.patch : args.data;
  const data = validateFields(source, schemas[resource], update, configuredPartners);
  if (!update) validateConditionalFields(data);
  if (update && data.action === 'reactivate' && (data.stopped_date !== undefined || data.stopped_reason !== undefined)) {
    throw new ResourceInputError('reactivate does not accept stopped metadata');
  }
  if (update) {
    const id = validateValue(args.id, required(positiveInteger), 'id', configuredPartners);
    const revision = validateValue(args.revision, required(positiveInteger), 'revision', configuredPartners);
    return { resource, actor, id, revision, patch: data };
  }
  return { resource, actor, data };
}

function requireResource(value, resources) {
  if (typeof value !== 'string' || !resources.includes(value)) throw new ResourceInputError(`resource must be one of: ${resources.join(', ')}`);
  return value;
}

function validateActor(value, partners) {
  if (!RESOURCE_ACTORS.includes(value)) throw new ResourceInputError('actor must be Jace or Elijah');
  if (!partners.includes(value)) throw new ResourceInputError(`${value} is not a configured Hearth partner`);
  return value;
}

function validateFields(value, fields, requireOne, partners) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ResourceInputError('data must be an object');
  rejectUnknown(value, Object.keys(fields));
  const result = {};
  for (const [key, validator] of Object.entries(fields)) {
    if (value[key] === undefined) {
      if (validator.required) throw new ResourceInputError(`${key} is required`);
      continue;
    }
    result[key] = validateValue(value[key], validator, key, partners);
  }
  if (requireOne && !Object.keys(result).length) throw new ResourceInputError('patch must contain at least one allowed field');
  return result;
}

function rejectUnknown(value, allowed) {
  const unknown = Object.keys(value).find(key => !allowed.includes(key));
  if (unknown) throw new ResourceInputError(`unknown field: ${unknown}`);
}

function validateValue(value, validator, name, partners) {
  if (value === null) {
    if (validator.nullable) return null;
    throw new ResourceInputError(`${name} cannot be null`);
  }
  if (validator.kind === 'text') {
    if (typeof value !== 'string' || !value.trim()) throw new ResourceInputError(`${name} must be non-empty text`);
    if (value.length > validator.max) throw new ResourceInputError(`${name} is too long`);
    return value.trim();
  }
  if (validator.kind === 'enum') {
    if (typeof value !== 'string' || !validator.values.includes(value)) throw new ResourceInputError(`${name} must be one of: ${validator.values.join(', ')}`);
    return value;
  }
  if (validator.kind === 'integer') {
    if (!Number.isInteger(value) || value < validator.min || value > validator.max) throw new ResourceInputError(`${name} must be an integer between ${validator.min} and ${validator.max}`);
    return value;
  }
  if (validator.kind === 'boolean') {
    if (typeof value !== 'boolean') throw new ResourceInputError(`${name} must be true or false`);
    return value;
  }
  if (validator.kind === 'date') return validateDate(value, name);
  if (validator.kind === 'time') {
    if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new ResourceInputError(`${name} must use HH:MM in 24-hour time`);
    return value;
  }
  if (validator.kind === 'datetime') {
    if (!isValidLocalDateTime(value)) throw new ResourceInputError(`${name} must use a valid ISO date and time`);
    return value;
  }
  if (validator.kind === 'partner') {
    if (typeof value !== 'string' || !partners.includes(value)) throw new ResourceInputError(`${name} must be a configured Hearth partner`);
    return value;
  }
  if (validator.kind === 'times') {
    if (!Array.isArray(value) || value.length > 12) throw new ResourceInputError(`${name} must be a list of up to 12 HH:MM times`);
    const times = [...new Set(value.map(item => String(item).trim()))].sort();
    if (times.some(item => !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(item))) throw new ResourceInputError(`${name} must contain HH:MM times`);
    return times;
  }
  throw new ResourceInputError(`${name} has an unsupported validator`);
}

function validateDate(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new ResourceInputError(`${name} must use YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new ResourceInputError(`${name} is not a valid date`);
  return value;
}

function validateDateRange(value) {
  if (value.date && (value.from || value.to)) throw new ResourceInputError('date cannot be combined with from or to');
  if (value.from && value.to) {
    if (value.from > value.to) throw new ResourceInputError('from must not be after to');
    const days = (Date.parse(`${value.to}T00:00:00Z`) - Date.parse(`${value.from}T00:00:00Z`)) / 86400000;
    if (days > 90) throw new ResourceInputError('date range cannot exceed 90 days');
  } else if (value.from) value.to = addCalendarDays(value.from, 90);
  else if (value.to) value.from = addCalendarDays(value.to, -90);
}

function validateConditionalFields(data) {
  if (data.frequency === 'Custom' && !data.recurrence_days) throw new ResourceInputError('recurrence_days is required for Custom frequency');
  if (data.frequency && data.frequency !== 'Custom' && data.recurrence_days != null) throw new ResourceInputError('recurrence_days is only valid for Custom frequency');
  if (data.recurrence === 'Custom' && !data.recurrence_days) throw new ResourceInputError('recurrence_days is required for Custom recurrence');
  if (data.recurrence && data.recurrence !== 'Custom' && data.recurrence_days != null) throw new ResourceInputError('recurrence_days is only valid for Custom recurrence');
  if (data.action === 'reactivate' && (data.stopped_date !== undefined || data.stopped_reason !== undefined)) throw new ResourceInputError('reactivate does not accept stopped metadata');
}

function jsonType(validator) {
  let result;
  if (validator.kind === 'integer') result = { type: 'integer', minimum: validator.min, maximum: Number.isSafeInteger(validator.max) ? validator.max : undefined };
  else if (validator.kind === 'boolean') result = { type: 'boolean' };
  else if (validator.kind === 'enum') result = { type: 'string', enum: validator.values };
  else if (validator.kind === 'times') result = { type: 'array', maxItems: 12, uniqueItems: true, items: { type: 'string', pattern: '^(?:[01]\\d|2[0-3]):[0-5]\\d$' } };
  else result = { type: 'string' };
  if (validator.kind === 'text') { result.minLength = 1; result.maxLength = validator.max; }
  if (validator.kind === 'date') result.pattern = '^\\d{4}-\\d{2}-\\d{2}$';
  if (validator.kind === 'time') result.pattern = '^(?:[01]\\d|2[0-3]):[0-5]\\d$';
  return validator.nullable ? { anyOf: [result, { type: 'null' }] } : result;
}

function objectSchema(fields) {
  const properties = Object.fromEntries(Object.entries(fields).map(([key, validator]) => [key, jsonType(validator)]));
  const requiredFields = Object.entries(fields).filter(([, validator]) => validator.required).map(([key]) => key);
  return { type: 'object', properties, required: requiredFields, additionalProperties: false };
}

export function resourceToolDefinitions() {
  return [
    {
      name: 'hearth_resource_read', title: 'Read Hearth resource', description: 'Read one allowlisted Hearth resource using bounded typed filters.',
      inputSchema: { type: 'object', oneOf: READ_RESOURCES.map(resource => ({ type: 'object', properties: { resource: { const: resource }, filters: objectSchema(READ_FIELDS[resource]) }, required: ['resource'], additionalProperties: false })) },
      annotations: { title: 'Read Hearth resource', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    {
      name: 'hearth_resource_create', title: 'Create Hearth record', description: 'Create one allowlisted Hearth record with validated actor attribution.',
      inputSchema: { type: 'object', oneOf: CREATE_RESOURCES.map(resource => ({ type: 'object', properties: { resource: { const: resource }, actor: { type: 'string', enum: RESOURCE_ACTORS }, data: objectSchema(CREATE_FIELDS[resource]) }, required: ['resource', 'actor', 'data'], additionalProperties: false })) },
      annotations: { title: 'Create Hearth record', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
    {
      name: 'hearth_resource_update', title: 'Update Hearth record', description: 'Patch one allowlisted Hearth record using its stable ID and expected revision.',
      inputSchema: { type: 'object', oneOf: UPDATE_RESOURCES.map(resource => ({ type: 'object', properties: { resource: { const: resource }, actor: { type: 'string', enum: RESOURCE_ACTORS }, id: { type: 'integer', minimum: 1 }, revision: { type: 'integer', minimum: 1 }, patch: objectSchema(UPDATE_FIELDS[resource]) }, required: ['resource', 'actor', 'id', 'revision', 'patch'], additionalProperties: false })) },
      annotations: { title: 'Update Hearth record', readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    },
  ];
}
