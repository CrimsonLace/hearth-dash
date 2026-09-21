export const MOOD_OPTIONS = Object.freeze(['great', 'good', 'okay', 'tired', 'stressed', 'low', 'horny']);

export function moodLabel(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : '';
}
