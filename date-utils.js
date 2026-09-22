export const HEARTH_TIME_ZONE = 'Europe/London';

const localPartsFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: HEARTH_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

const longDateFormatter = new Intl.DateTimeFormat('en-GB', {
  timeZone: HEARTH_TIME_ZONE,
  weekday: 'long',
  day: 'numeric',
  month: 'long',
  year: 'numeric',
});

function instantValue(value) {
  const instant = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instant.getTime())) throw new RangeError('Invalid instant');
  return instant;
}

function localParts(value) {
  return Object.fromEntries(localPartsFormatter.formatToParts(instantValue(value))
    .filter(part => part.type !== 'literal')
    .map(part => [part.type, part.value]));
}

function dateOnlyValue(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new RangeError('Invalid calendar date');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new RangeError('Invalid calendar date');
  return parsed;
}

export function localDateKey(value = new Date()) {
  const parts = localParts(value);
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function localTimeKey(value = new Date()) {
  const parts = localParts(value);
  return `${parts.hour}:${parts.minute}`;
}

export function localDateTimeKey(value = new Date()) {
  return `${localDateKey(value)}T${localTimeKey(value)}`;
}

export function formatLocalLongDate(value = new Date()) {
  return longDateFormatter.format(instantValue(value));
}

export function addCalendarDays(value, days) {
  if (!Number.isInteger(days)) throw new RangeError('Calendar day offset must be an integer');
  const date = dateOnlyValue(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

export function addCalendarMonths(value, months) {
  if (!Number.isInteger(months)) throw new RangeError('Calendar month offset must be an integer');
  const date = dateOnlyValue(value);
  const day = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)).getUTCDate();
  date.setUTCDate(Math.min(day, lastDay));
  return date.toISOString().slice(0, 10);
}

export function isValidLocalDateTime(value) {
  if (typeof value !== 'string') return false;
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?Z?$/);
  if (!match) return false;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = secondText === undefined ? 0 : Number(secondText);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return year >= 1 && month >= 1 && month <= 12
    && day >= 1 && day <= daysInMonth[month - 1]
    && hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59
    && second >= 0 && second <= 59;
}
