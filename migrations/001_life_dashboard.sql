-- Hearth custom fork: light personal-life dashboard entities.
-- This migration is additive and intentionally preserves every existing table.

CREATE TABLE IF NOT EXISTS medical_appointments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person TEXT NOT NULL CHECK (person IN ('Crimson', 'Conrad')),
  appointment_date TEXT NOT NULL,
  appointment_time TEXT,
  location TEXT,
  clinic TEXT,
  clinician TEXT,
  reason TEXT NOT NULL,
  notes TEXT,
  status TEXT NOT NULL DEFAULT 'Upcoming' CHECK (status IN ('Upcoming', 'Completed', 'Cancelled', 'Rescheduled')),
  transport_needed INTEGER NOT NULL DEFAULT 0,
  preparation_needed TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_medical_appointments_date ON medical_appointments(appointment_date, appointment_time);
CREATE INDEX IF NOT EXISTS idx_medical_appointments_person ON medical_appointments(person, status);

CREATE TABLE IF NOT EXISTS medications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  person TEXT NOT NULL CHECK (person IN ('Crimson', 'Conrad')),
  name TEXT NOT NULL,
  strength TEXT,
  dose TEXT NOT NULL,
  frequency TEXT NOT NULL,
  scheduled_times TEXT NOT NULL DEFAULT '[]',
  prescribing_source TEXT,
  notes TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  start_date TEXT NOT NULL,
  stopped_date TEXT,
  stopped_reason TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_medications_person_active ON medications(person, active);

CREATE TABLE IF NOT EXISTS medication_doses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  medication_id INTEGER NOT NULL,
  person TEXT NOT NULL CHECK (person IN ('Crimson', 'Conrad')),
  medication_name TEXT NOT NULL,
  medication_strength TEXT,
  medication_dose TEXT NOT NULL,
  scheduled_at TEXT NOT NULL,
  actual_taken_at TEXT,
  status TEXT NOT NULL DEFAULT 'Due' CHECK (status IN ('Due', 'Taken', 'Skipped')),
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_medication_doses_schedule ON medication_doses(medication_id, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_medication_doses_person_date ON medication_doses(person, scheduled_at);

CREATE TABLE IF NOT EXISTS prescription_renewals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  medication_id INTEGER,
  person TEXT NOT NULL CHECK (person IN ('Crimson', 'Conrad')),
  medication_name TEXT NOT NULL,
  last_ordered_date TEXT,
  next_order_date TEXT,
  quantity_remaining INTEGER,
  status TEXT NOT NULL DEFAULT 'Enough' CHECK (status IN ('Enough', 'Order soon', 'Ordered', 'Ready', 'Collected')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_prescription_renewals_due ON prescription_renewals(next_order_date, status);

CREATE TABLE IF NOT EXISTS household_chores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT NOT NULL,
  frequency TEXT NOT NULL DEFAULT 'One-off' CHECK (frequency IN ('One-off', 'Daily', 'Weekly', 'Monthly', 'Custom')),
  recurrence_days INTEGER,
  next_due_date TEXT NOT NULL,
  done INTEGER NOT NULL DEFAULT 0,
  notes TEXT,
  last_completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_household_chores_due ON household_chores(done, next_due_date);

CREATE TABLE IF NOT EXISTS home_admin (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT 'General',
  due_date TEXT NOT NULL,
  recurrence TEXT NOT NULL DEFAULT 'None' CHECK (recurrence IN ('None', 'Monthly', 'Yearly', 'Custom')),
  recurrence_days INTEGER,
  status TEXT NOT NULL DEFAULT 'Upcoming' CHECK (status IN ('Upcoming', 'Due soon', 'Done')),
  notes TEXT,
  completed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_home_admin_due ON home_admin(status, due_date);

CREATE TABLE IF NOT EXISTS saved_meals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  notes TEXT,
  ingredients TEXT,
  favourite INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS meal_plan (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plan_date TEXT UNIQUE NOT NULL,
  meal TEXT NOT NULL,
  notes TEXT,
  ingredients_needed TEXT,
  saved_meal_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_meal_plan_date ON meal_plan(plan_date);
