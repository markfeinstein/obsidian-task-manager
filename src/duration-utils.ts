/**
 * Duration parsing utilities for effort/actual time fields.
 * Shared between task-query.ts and metrics-aggregator.ts.
 */

/**
 * Parse effort/actual string into minutes.
 * Handles: "1d", "2h", "30m", "2h 30m", "2 hours", "30 minutes", etc.
 * Also accepts bare numbers (treated as minutes). One day is treated as 8 hours.
 * Returns Infinity if the string is empty or unparseable.
 */
export function parseEffortMinutesForFilter(s: string | undefined): number {
  if (!s) return Infinity;
  const normalized = s.trim().toLowerCase();

  const durationMatch = normalized.match(/^(?:(\d+(?:\.\d+)?)\s*d(?:ays?)?)?\s*(?:(\d+(?:\.\d+)?)\s*h(?:ours?)?)?\s*(?:(\d+(?:\.\d+)?)\s*m(?:in(?:ute)?s?)?)?$/u);
  if (durationMatch && (durationMatch[1] !== undefined || durationMatch[2] !== undefined || durationMatch[3] !== undefined)) {
    const days = durationMatch[1] ? Number(durationMatch[1]) : 0;
    const hours = durationMatch[2] ? Number(durationMatch[2]) : 0;
    const minutes = durationMatch[3] ? Number(durationMatch[3]) : 0;
    return days * 8 * 60 + hours * 60 + minutes;
  }

  // If no unit matched, try bare number.
  if (/^\d+(?:\.\d+)?$/u.test(normalized)) {
    return Number(normalized);
  }

  // Unparseable
  return Infinity;
}
