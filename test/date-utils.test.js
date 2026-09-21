import test from 'node:test';
import assert from 'node:assert/strict';
import {
  HEARTH_TIME_ZONE, addCalendarDays, addCalendarMonths, formatLocalLongDate,
  localDateKey, localDateTimeKey, localTimeKey,
} from '../date-utils.js';

test('uses Europe/London for the reported BST midnight boundary', () => {
  assert.equal(HEARTH_TIME_ZONE, 'Europe/London');
  assert.equal(localDateKey('2026-09-20T23:40:00Z'), '2026-09-21');
  assert.equal(localDateKey('2026-09-20T22:59:59.999Z'), '2026-09-20');
  assert.equal(localDateKey('2026-09-20T23:00:00Z'), '2026-09-21');
  assert.equal(localTimeKey('2026-09-20T23:40:00Z'), '00:40');
  assert.equal(localDateTimeKey('2026-09-20T23:40:00Z'), '2026-09-21T00:40');
  assert.equal(formatLocalLongDate('2026-09-20T23:40:00Z'), 'Monday, 21 September 2026');
});

test('handles both GMT/BST transitions and the repeated autumn hour', () => {
  assert.equal(localDateKey('2026-03-29T00:30:00Z'), '2026-03-29');
  assert.equal(localTimeKey('2026-03-29T00:30:00Z'), '00:30');
  assert.equal(localDateKey('2026-03-29T01:30:00Z'), '2026-03-29');
  assert.equal(localTimeKey('2026-03-29T01:30:00Z'), '02:30');
  assert.equal(localDateKey('2026-10-25T00:30:00Z'), '2026-10-25');
  assert.equal(localTimeKey('2026-10-25T00:30:00Z'), '01:30');
  assert.equal(localDateKey('2026-10-25T01:30:00Z'), '2026-10-25');
  assert.equal(localTimeKey('2026-10-25T01:30:00Z'), '01:30');
});

test('uses calendar arithmetic across 23-hour and 25-hour days', () => {
  assert.deepEqual(Array.from({ length: 7 }, (_, index) => addCalendarDays('2026-03-27', index)), [
    '2026-03-27', '2026-03-28', '2026-03-29', '2026-03-30', '2026-03-31', '2026-04-01', '2026-04-02',
  ]);
  assert.deepEqual(Array.from({ length: 7 }, (_, index) => addCalendarDays('2026-10-23', index)), [
    '2026-10-23', '2026-10-24', '2026-10-25', '2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29',
  ]);
  assert.equal(addCalendarMonths('2026-01-31', 1), '2026-02-28');
});
