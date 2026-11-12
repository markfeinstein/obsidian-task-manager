import { addIsoDays, addIsoMonths, addIsoWeeks, addIsoYears, formatLocalDate, formatUtcDate, isValidIsoDate, isoDateToUtcDate } from './iso-date';
import { parseNaturalDate } from './natural-date-parser';
export { addIsoDays, addIsoMonths, addIsoWeeks, addIsoYears, daysInIsoMonth, diffIsoDays, formatLocalDate, formatUtcDate, isValidIsoDate, isoDateToUtcDate, parseIsoDate } from './iso-date';

export type DateUnit = 'day' | 'week' | 'month' | 'year';

export const WORD_NUMBERS: Readonly<Record<string, number>> = {
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
  thirteen: 13,
  fourteen: 14,
  fifteen: 15,
  sixteen: 16,
  seventeen: 17,
  eighteen: 18,
  nineteen: 19,
  twenty: 20,
  thirty: 30,
  forty: 40,
  fifty: 50,
  sixty: 60,
};

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];

export function todayString(): string { return formatLocalDate(new Date()); }

export function parseDateString(value: string): Date { return isoDateToUtcDate(value); }

export function addDate(value: string, unit: DateUnit | 'weekday', count: number): string {
  let formatted = unit === 'day' || unit === 'weekday' ? addIsoDays(value, count)
    : unit === 'week' ? addIsoWeeks(value, count)
      : unit === 'month' ? addIsoMonths(value, count)
        : addIsoYears(value, count);
  if (unit === 'weekday') {
    while ([0, 6].includes(parseDateString(formatted).getUTCDay())) formatted = addIsoDays(formatted, count >= 0 ? 1 : -1);
  }
  return formatted;
}

export function addDateObject(date: Date, unit: DateUnit, count: number): Date {
  const value = formatUtcDate(date);
  const result = unit === 'day' ? addIsoDays(value, count)
    : unit === 'week' ? addIsoWeeks(value, count)
      : unit === 'month' ? addIsoMonths(value, count)
        : addIsoYears(value, count);
  return isoDateToUtcDate(result);
}

export function containsUnexpandedTemplateText(value: string): boolean {
  return /<%|%>|\{\{[^}]+\}\}/u.test(value);
}

export interface FlexibleDateOptions {
  onlyFuture?: boolean;
}

export function resolveFlexibleDate(rawValue: string, today: string, options: FlexibleDateOptions = {}): string | null {
  const value = rawValue.toLowerCase().trim().replace(/\s+/gu, ' ');
  if (!value) return null;
  if (isValidIsoDate(value)) return value.slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}/u.test(value)) return null;
  if (value === 'today') return today;
  if (value === 'tomorrow') return addDate(today, 'day', 1);
  if (value === 'yesterday') return addDate(today, 'day', -1);

  const relative = value.match(/^(?:in\s+)?([a-z\d -]+)\s+(day|week|month|year)s?(?:\s+from\s+now)?$/u);
  if (relative) {
    const count = parseNumberWords(relative[1]);
    if (count !== null) return addDate(today, relative[2] as DateUnit, count);
    if (/[\d-]/u.test(relative[1])) return null;
  }
  const ago = value.match(/^([a-z\d -]+)\s+(day|week|month|year)s?\s+ago$/u);
  if (ago) {
    const count = parseNumberWords(ago[1]);
    if (count !== null) return addDate(today, ago[2] as DateUnit, -count);
    if (/[\d-]/u.test(ago[1])) return null;
  }

  const weekday = value.match(/^(next|last)?\s*(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)$/u);
  if (weekday) return relativeWeekday(parseDateString(today), weekday[2], weekday[1] ?? (options.onlyFuture ? 'next-or-today' : 'closest'));

  const monthDay = value.match(/^(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(\d{4}))?$/u)
    ?? value.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)(?:,?\s+(\d{4}))?$/u);
  if (monthDay) {
    const firstIsMonth = Number.isNaN(Number.parseInt(monthDay[1], 10));
    const month = monthNumber(firstIsMonth ? monthDay[1] : monthDay[2]);
    const day = Number.parseInt(firstIsMonth ? monthDay[2] : monthDay[1], 10);
    let year = Number.parseInt(monthDay[3] ?? String(parseDateString(today).getUTCFullYear()), 10);
    let candidateDate = new Date(Date.UTC(year, month, day));
    if (candidateDate.getUTCFullYear() !== year || candidateDate.getUTCMonth() !== month || candidateDate.getUTCDate() !== day) return null;
    let candidate = formatUtcDate(candidateDate);
    if (options.onlyFuture && candidate < today && !monthDay[3]) {
      year += 1;
      candidateDate = new Date(Date.UTC(year, month, day));
      if (candidateDate.getUTCFullYear() !== year || candidateDate.getUTCMonth() !== month || candidateDate.getUTCDate() !== day) return null;
      candidate = formatUtcDate(candidateDate);
    }
    return candidate;
  }

  const monthOnly = value.match(/^(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)$/u);
  if (monthOnly) {
    const todayDate = parseDateString(today);
    const year = todayDate.getUTCFullYear();
    let candidate = formatUtcDate(new Date(Date.UTC(year, monthNumber(monthOnly[1]), 1)));
    if (options.onlyFuture && candidate < today) candidate = formatUtcDate(new Date(Date.UTC(year + 1, monthNumber(monthOnly[1]), 1)));
    return candidate;
  }

  return parseNaturalDate(value, today, 'en', options.onlyFuture ?? false);
}

export function resolveDateRange(rawValue: string, today: string): { start: string; end: string } {
  const value = rawValue.toLowerCase().trim().replace(/\s+/gu, ' ');
  // Check the relative-range phrases ("next month", "last week", ...) before
  // falling back to resolveFlexibleDate(): that helper's natural-date fallback
  // resolves these phrases to a single anchor date,
  // which silently shadowed the range branch below and collapsed ranges to a
  // single day.
  const relative = value.match(/^(last|this|next)\s+(week|month|quarter|year)$/u);
  if (relative) return relativeRange(relative[1], relative[2], today);
  const flexible = resolveFlexibleDate(value, today);
  if (flexible) return singleDate(flexible);
  if (/^\d{4}-\d{2}-\d{2}\s+\d{4}-\d{2}-\d{2}$/u.test(value)) {
    const [start, end] = value.split(/\s+/u);
    if (!isValidIsoDate(start) || !isValidIsoDate(end) || start > end) return singleDate(value);
    return { start, end };
  }
  const week = value.match(/^(\d{4})-w(\d{2})$/iu);
  if (week) {
    const yearNumber = Number.parseInt(week[1], 10);
    const weekNumber = Number.parseInt(week[2], 10);
    if (!hasIsoWeek(yearNumber, weekNumber)) return singleDate(value);
    return isoWeekRange(yearNumber, weekNumber);
  }
  const month = value.match(/^(\d{4})-(\d{2})$/u);
  if (month) {
    const monthNumberValue = Number.parseInt(month[2], 10);
    if (monthNumberValue < 1 || monthNumberValue > 12) return singleDate(value);
    return monthRange(Number.parseInt(month[1], 10), monthNumberValue);
  }
  const quarter = value.match(/^(\d{4})-q([1-4])$/iu);
  if (quarter) return quarterRange(Number.parseInt(quarter[1], 10), Number.parseInt(quarter[2], 10));
  const year = value.match(/^(\d{4})$/u);
  if (year) return { start: `${year[1]}-01-01`, end: `${year[1]}-12-31` };
  return singleDate(value);
}

export function diffDays(start: string, end: string): number {
  return Math.round((parseDateString(end).getTime() - parseDateString(start).getTime()) / 86_400_000);
}

export function maxDate(left: string, right: string): string {
  return left > right ? left : right;
}

export function startOfIsoWeek(value: string): string {
  const date = parseDateString(value);
  const day = date.getUTCDay();
  return formatUtcDate(addDateObject(date, 'day', -((day + 6) % 7)));
}

function singleDate(value: string): { start: string; end: string } { return { start: value, end: value }; }

function relativeRange(which: string, unit: string, today: string): { start: string; end: string } {
  const date = parseDateString(today);
  const offset = which === 'last' ? -1 : which === 'next' ? 1 : 0;
  if (unit === 'week') {
    const start = addDate(startOfIsoWeek(today), 'day', offset * 7);
    return { start, end: addDate(start, 'day', 6) };
  }
  if (unit === 'month') return monthRange(date.getUTCFullYear(), date.getUTCMonth() + 1 + offset);
  if (unit === 'quarter') return quarterRange(date.getUTCFullYear(), Math.floor(date.getUTCMonth() / 3) + 1 + offset);
  return { start: `${date.getUTCFullYear() + offset}-01-01`, end: `${date.getUTCFullYear() + offset}-12-31` };
}

function monthRange(year: number, month: number): { start: string; end: string } {
  const normalized = new Date(Date.UTC(year, month - 1, 1));
  const start = formatUtcDate(normalized);
  const end = formatUtcDate(new Date(Date.UTC(normalized.getUTCFullYear(), normalized.getUTCMonth() + 1, 0)));
  return { start, end };
}

function quarterRange(year: number, quarter: number): { start: string; end: string } {
  const base = new Date(Date.UTC(year, (quarter - 1) * 3, 1));
  return { start: formatUtcDate(base), end: formatUtcDate(new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 3, 0))) };
}

function isoWeekRange(year: number, week: number): { start: string; end: string } {
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const monday = addDateObject(jan4, 'day', -((jan4.getUTCDay() + 6) % 7) + (week - 1) * 7);
  return { start: formatUtcDate(monday), end: formatUtcDate(addDateObject(monday, 'day', 6)) };
}

function hasIsoWeek(year: number, week: number): boolean {
  if (week < 1 || week > 53) return false;
  if (week < 53) return true;
  const start = parseDateString(isoWeekRange(year, week).start);
  return addDateObject(start, 'day', 3).getUTCFullYear() === year;
}

function relativeWeekday(today: Date, weekdayName: string, direction: string): string {
  const target = WEEKDAYS.findIndex((day) => day.startsWith(weekdayName.toLowerCase()));
  const current = today.getUTCDay();
  let delta = target - current;
  if (direction === 'next') delta = delta <= 0 ? delta + 7 : delta;
  else if (direction === 'last') delta = delta >= 0 ? delta - 7 : delta;
  else if (direction === 'next-or-today') delta = delta < 0 ? delta + 7 : delta;
  else if (delta > 3) delta -= 7;
  else if (delta < -3) delta += 7;
  return formatUtcDate(addDateObject(today, 'day', delta));
}

function monthNumber(name: string): number {
  const index = MONTHS.findIndex((month) => month.startsWith(name.toLowerCase()));
  return index < 0 ? 0 : index;
}

function parseNumberWords(value: string): number | null {
  const normalized = value.trim().toLowerCase();
  if (/^\d+$/u.test(normalized)) return Number.parseInt(normalized, 10);
  const parts = normalized.split(/[\s-]+/u).filter(Boolean);
  if (parts.length === 0) return null;
  let total = 0;
  for (const part of parts) {
    const number = WORD_NUMBERS[part];
    if (number === undefined) return null;
    total += number;
  }
  return total || null;
}

/**
 * Validate a recurrence rule string and detect common edge-case patterns
 *
 * Returns object with:
 * - valid: whether the rule is valid
 * - warnings: array of detected issues
 * - suggestion: optional suggested fix
 */
export interface RecurrenceValidation {
  valid: boolean;
  warnings: string[];
  suggestion?: string;
}

export function validateRecurrenceRule(rule: string | undefined): RecurrenceValidation {
  const warnings: string[] = [];
  if (!rule) return { valid: true, warnings };

  const normalized = rule.toLowerCase().trim();

  // Check for invalid day-of-month patterns
  const dayOfMonthMatch = normalized.match(/every\s+(?:(?:\d+|other)\s+)?months?\s+on\s+(?:the\s+)?(?:day\s+)?(\d{1,2})(?:st|nd|rd|th)?/i);
  if (dayOfMonthMatch) {
    const day = Number.parseInt(dayOfMonthMatch[1], 10);
    if (day > 28) {
      warnings.push(`Day ${day} may not exist in all months (e.g., Feb has max 29 days)`);
      return {
        valid: false,
        warnings,
        suggestion: `Consider: "every month on the 15th" or "every 4 weeks" instead`,
      };
    }
  }

  // Check for impossible month patterns
  if (normalized.includes('every month') && normalized.includes('on') && normalized.includes('31')) {
    warnings.push('Day 31 does not exist in all months (Feb, Apr, Jun, Sep, Nov)');
    return {
      valid: false,
      warnings,
      suggestion: 'Use day 28 or earlier for monthly recurring tasks',
    };
  }

  // Check for conflicting frequency
  const frequencyMatches = normalized.match(/(every\s+(?:day|week|month|year)|weekly|daily|monthly|yearly)/gi);
  if (frequencyMatches && frequencyMatches.length > 1) {
    warnings.push('Multiple frequency keywords detected (conflicting frequencies)');
    return {
      valid: false,
      warnings,
      suggestion: `Use only one frequency keyword, e.g., "${frequencyMatches[0].toLowerCase()}"`,
    };
  }

  // Check for invalid or past until date
  const untilMatch = normalized.match(/until\s+(\d{4}-\d{2}-\d{2})/i);
  if (untilMatch) {
    const untilDate = untilMatch[1];
    if (!isValidIsoDate(untilDate)) {
      warnings.push(`Until date ${untilDate} is not a valid calendar date`);
      return {
        valid: false,
        warnings,
        suggestion: 'Use a real ISO date, e.g., "until 2026-02-28"',
      };
    }
    const today = formatLocalDate(new Date());
    if (untilDate < today) {
      warnings.push(`Until date ${untilDate} is in the past (today is ${today})`);
      return {
        valid: false,
        warnings,
        suggestion: `Update until date to a future date, e.g., "until ${addDate(today, 'day', 90)}"`,
      };
    }
  }

  // Check for invalid 'for N times' syntax
  // Use (\d+|[a-z]+) so numeric counts like "for 9999 times" are also captured;
  // [a-z]+ alone never matches digits, making the count > 1000 check unreachable.
  const forMatch = normalized.match(/for\s+(\d+|[a-z]+)\s+times?/i);
  if (forMatch) {
    const countStr = forMatch[1];
    const count = Number.parseInt(countStr, 10);
    let actualCount = count;
    if (Number.isNaN(count)) {
      const wordCount = WORD_NUMBERS[countStr];
      if (wordCount === undefined) {
        warnings.push(`Invalid count in "for ${countStr} times" (not a number or word number)`);
        return {
          valid: false,
          warnings,
          suggestion: `Use: "for 10 times" or "for ${countStr.charAt(0).toUpperCase()}${countStr.slice(1)} times"`,
        };
      }
      actualCount = wordCount;
    }
    if (actualCount > 1000) {
      warnings.push(`Count ${actualCount} in "for N times" is unusually high`);
    }
  }

  // Check for negative intervals
  if (normalized.includes('every -') || normalized.includes('every-')) {
    warnings.push('Negative interval detected (every -N)');
    return {
      valid: false,
      warnings,
      suggestion: 'Remove the minus sign, e.g., "every 3 days" instead of "every -3 days"',
    };
  }

  // Check for unsupported weekday patterns.
  // Anchor the weekday matcher so longer rules like "every month on last friday"
  // do not get mistaken for a plain "on friday" rule.
  const weekdayMatch = normalized.match(/^(?:every|on)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i);
  if (!weekdayMatch && normalized.includes('last')) {
    const anyWeekday = WEEKDAYS.some((day) => normalized.includes(day));
    if (anyWeekday) {
      const detectedDay = WEEKDAYS.find((day) => normalized.includes(day)) || 'weekday';
      warnings.push(`"Last ${detectedDay} of month" pattern is not standard RRule syntax`);
      return {
        valid: false,
        warnings,
        suggestion: `Obsidian Tasks uses RFC 5545 RRule syntax. Consider "every 4 weeks on ${detectedDay}"`,
      };
    }
  }

  return { valid: warnings.length === 0, warnings };
}

/**
 * Generate fallback recurrence rules for common natural-language patterns
 *
 * Converts user-friendly patterns to RFC 5545 RRule format:
 *   "every monday" → "every week on monday"
 *   "last day of month" → suggests "every month on day 28"
 *   "every other week" → "every 2 weeks"
 */
export function generateFallbackRecurrence(pattern: string): string | undefined {
  const normalized = pattern.toLowerCase().trim();

  // Every weekday
  const weekdayMatch = normalized.match(/^(?:every|on)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)/i);
  if (weekdayMatch && !normalized.includes('week')) {
    return `every week on ${weekdayMatch[1].toLowerCase()}`;
  }

  // Every other week
  if (normalized.match(/every\s+other\s+week/i)) {
    return 'every 2 weeks';
  }

  // Every other month
  if (normalized.match(/every\s+other\s+month/i)) {
    return 'every 2 months';
  }

  // Every business day / weekday
  if (normalized.match(/every\s+business\s+day|every\s+weekday/i)) {
    return 'every weekday';
  }

  // Every 2 weeks (alternative syntax)
  if (normalized.match(/bi-?weekly|every\s+2\s+weeks/i)) {
    return 'every 2 weeks';
  }

  // Last day of month (suggest best approximation)
  if (normalized.match(/(?:last|end|final)\s+(?:day|date)\s+of\s+(?:the\s+)?month/i)) {
    return 'every month on day 28'; // 28th exists in all months
  }

  // First day of month
  if (normalized.match(/(?:first|start|beginning)\s+(?:day|date)\s+of\s+(?:the\s+)?month/i)) {
    return 'every month on day 1';
  }

  return undefined;
}
