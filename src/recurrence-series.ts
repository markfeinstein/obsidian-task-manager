import type { App, TFile } from 'obsidian';
import type { ParsedTask, TaskScanner } from './task-scanner';
import { resolveRenderedTaskLine } from './task-mutation-resolver';
import { splitContentLines } from './task-model';
import { formatIsoMonthDay } from './display-date';

/**
 * 8-character hexadecimal identifier for a recurring task series.
 * Auto-assigned on first recurrence, propagated via metadata field.
 * Format: lowercase hex string, e.g., "a1b2c3d4"
 */
export type RecurrenceSeriesId = string & { readonly __brand: 'RecurrenceSeriesId' };

/**
 * Describes which occurrences are affected by an edit.
 */
export type EditScope = 'this-only' | 'this-and-future' | 'all-in-series';

/**
 * Details about splitting a recurring task when applying an edit with a specific scope.
 */
export interface ScopeApplicationResult {
  /** The scope chosen for this edit. */
  scope: EditScope;
  /** Whether we need to modify the series ID or create a new one. */
  createNewSeries: boolean;
  /** The series ID to use for the edited task (and future if scope is 'this-and-future'). */
  newSeriesId?: RecurrenceSeriesId;
  /** Instructions for how to apply the edit. */
  instructions: string[];
}

/**
 * FNV-1a 32-bit hash — pure JS, works on both Electron desktop and Obsidian
 * mobile (no Node.js `crypto` module required).
 */
function fnv1a32(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    // Math.imul gives correct 32-bit multiplication without BigInt
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

function addUtcMonthsClamped(date: Date, count: number, anchorDay: number = date.getUTCDate()): Date {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + count, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(anchorDay, lastDay));
  return target;
}

function addUtcYearsClamped(
  date: Date,
  count: number,
  anchorMonth: number = date.getUTCMonth(),
  anchorDay: number = date.getUTCDate(),
): Date {
  const target = new Date(Date.UTC(date.getUTCFullYear() + count, anchorMonth, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(anchorDay, lastDay));
  return target;
}

/**
 * Generates an 8-character series ID hash from task properties.
 * Used to uniquely identify a recurring task series.
 *
 * Uses FNV-1a 32-bit (pure JS, mobile-safe — no Node.js `crypto`).
 *
 * @param filePath - The file path of the task
 * @param lineNumber - The original line number where the task was created
 * @param description - The task description/text
 * @returns An 8-character lowercase hexadecimal string branded as RecurrenceSeriesId
 */
export function generateRecurrenceSeriesId(
  filePath: string,
  lineNumber: number,
  description: string,
): RecurrenceSeriesId {
  const content = `${filePath}:${lineNumber}:${description}`;
  return fnv1a32(content).toString(16).padStart(8, '0') as RecurrenceSeriesId;
}

/**
 * Validates whether a string is a valid 8-character series ID.
 * 
 * @param id - The string to validate
 * @returns true if the string is a valid 8-char hex ID
 */
export function isValidSeriesId(id: string): id is RecurrenceSeriesId {
  return /^[a-f0-9]{8}$/.test(id);
}

/**
 * Safely brands a string as a RecurrenceSeriesId after validation.
 * 
 * @param id - The string to validate and brand
 * @returns The branded ID, or undefined if invalid
 */
export function asSeriesId(id: string): RecurrenceSeriesId | undefined {
  return isValidSeriesId(id) ? id : undefined;
}

/**
 * Applies an edit scope to determine how to split/modify a recurring task.
 * 
 * When editing a recurring task, you can choose to edit:
 * - 'this-only': Just this occurrence, don't affect future ones
 * - 'this-and-future': This occurrence and all future ones
 * - 'all-in-series': The entire series (all past and future)
 * 
 * @param scope - The chosen edit scope
 * @param currentSeriesId - The current series ID (if any)
 * @param currentOccurrenceIndex - Zero-based index of this occurrence (e.g., 0 for first)
 * @returns Detailed instructions for applying the edit
 */
export function applyScopeToEdit(
  scope: EditScope,
  currentSeriesId: RecurrenceSeriesId | undefined,
  _currentOccurrenceIndex: number,
): ScopeApplicationResult {
  const instructions: string[] = [];

  switch (scope) {
    case 'this-only':
      // Remove recurrence rule, break from series
      instructions.push('Remove the recurrence rule from this task (it becomes a one-off).');
      if (currentSeriesId) {
        instructions.push(`Remove series ID [${currentSeriesId}] since this is no longer recurring.`);
      }
      return {
        scope,
        createNewSeries: false,
        instructions,
      };

    case 'this-and-future':
      // Create a new series starting from this occurrence
      instructions.push('This occurrence and all future ones become a new recurring series.');
      if (currentSeriesId) {
        instructions.push(`A new series ID will be generated (replacing [${currentSeriesId}]).`);
        instructions.push(`Occurrences before this one remain in the original series.`);
      }
      return {
        scope,
        createNewSeries: true,
        instructions,
      };

    case 'all-in-series':
      // Modify the entire series in place
      instructions.push('All occurrences in this series will be affected by this edit.');
      if (currentSeriesId) {
        instructions.push(`Series ID remains [${currentSeriesId}].`);
      }
      return {
        scope,
        createNewSeries: false,
        instructions,
      };
  }
}

/**
 * Generates a human-readable list of common recurrence patterns.
 * Used to populate a recurrence picker UI.
 * 
 * @returns Array of common patterns (natural language or rrule)
 */
export function getCommonRecurrencePatterns(): string[] {
  return [
    'every day',
    'every weekday',
    'every week',
    'every 2 weeks',
    'every month',
    'every 3 months',
    'every year',
    'every week on Monday',
    'every week on Friday',
    'every Monday and Friday',
  ];
}

/**
 * Predicts the next 5 occurrences of a recurrence rule.
 * Used for the 5-occurrence calendar preview in the picker UI.
 * 
 * This is a simplified implementation that handles common patterns.
 * In production, you might integrate with a library like rrule.js.
 * 
 * @param recurrenceRule - The recurrence rule (natural language or rrule format)
 * @param startDate - The start date for the series (today or specified date)
 * @returns Array of up to 5 predicted occurrence dates (ISO string format)
 */
export function predictNextOccurrences(
  recurrenceRule: string,
  startDate: Date = new Date(),
): string[] {
  const occurrences: string[] = [];
  
  // Extract date as local calendar date so the occurrence preview starts on
  // today's local date (not UTC today, which can be tomorrow in UTC− zones).
  const getLocalDateStr = (date: Date): string =>
    `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const getUTCDateStr = (date: Date): string => date.toISOString().split('T')[0];
  const parseUTCDate = (dateStr: string): Date => new Date(`${dateStr}T00:00:00Z`);
  
  const currentDateStr = getLocalDateStr(startDate);
  let current = parseUTCDate(currentDateStr);
  const anchorDay = current.getUTCDate();
  const anchorMonth = current.getUTCMonth();

  // Simple pattern matching for common rules (real impl would use rrule.js)
  const normalizedRule = recurrenceRule.toLowerCase();
  const DAY_NAMES = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const parseWeekdayNames = (value: string): number[] => {
    const days: number[] = [];
    for (const match of value.matchAll(/\b\w+\b/gu)) {
      const day = DAY_NAMES.findIndex((d) => d.startsWith(match[0]));
      if (day >= 0 && !days.includes(day)) days.push(day);
    }
    return days;
  };
  // "every week on Monday" (and similar) must be detected before the generic isWeekly check
  // because /every week(?!day)/ also matches "every week on Monday", which would cause
  // predictNextOccurrences to ignore the "on Monday" qualifier and return wrong weekdays.
  const weeklyOnDayMatch = normalizedRule.match(/every week on ([a-z,\s]+)/u);
  const weeklyOnDays = weeklyOnDayMatch ? parseWeekdayNames(weeklyOnDayMatch[1]) : [];
  const isWeeklyOnDay = weeklyOnDays.length > 0;
  // "every Monday and Friday" — two named weekdays per week (no 'week' keyword).
  // Must be detected before the fallback so the pattern is not silently treated as weekly.
  const multiDayMatch = !isWeeklyOnDay
    ? normalizedRule.match(/every\s+(\w+)\s+and\s+(\w+)/u)
    : null;
  const multiDay1 = multiDayMatch ? DAY_NAMES.findIndex((d) => d.startsWith(multiDayMatch[1])) : -1;
  const multiDay2 = multiDayMatch ? DAY_NAMES.findIndex((d) => d.startsWith(multiDayMatch[2])) : -1;
  const isMultiDay = multiDay1 >= 0 && multiDay2 >= 0;
  const isDaily = /every day/u.test(normalizedRule);
  // Exclude "every week on <day>" so isWeeklyOnDay takes precedence.
  const isWeekly = /every week(?!day)/u.test(normalizedRule) && !/every 2 weeks/u.test(normalizedRule) && !isWeeklyOnDay;
  const isBiWeekly = /every 2 weeks/u.test(normalizedRule);
  const isMonthly = /every month/u.test(normalizedRule);
  const isQuarterly = /every 3 months/u.test(normalizedRule);
  const isYearly = /every year/u.test(normalizedRule);
  const isWeekday = /every weekday/u.test(normalizedRule);

  for (let i = 0; i < 5; i += 1) {
    if (isWeeklyOnDay) {
      // On first iteration, include today if it's already a target weekday.
      // On subsequent iterations, advance to the next matching weekday.
      if (i === 0 && weeklyOnDays.includes(current.getUTCDay())) {
        // Today is already a target weekday — use it as first occurrence
      } else {
        do {
          current = new Date(current.getTime() + 24 * 60 * 60 * 1000);
        } while (!weeklyOnDays.includes(current.getUTCDay()));
      }
    } else if (isMultiDay) {
      // On first iteration, include today if it's already one of the target weekdays.
      // On subsequent iterations, advance to the next matching weekday.
      if (i === 0 && (current.getUTCDay() === multiDay1 || current.getUTCDay() === multiDay2)) {
        // Today is already a target weekday — use it as first occurrence
      } else {
        do {
          current = new Date(current.getTime() + 24 * 60 * 60 * 1000);
        } while (current.getUTCDay() !== multiDay1 && current.getUTCDay() !== multiDay2);
      }
    } else if (isDaily) {
      current = new Date(current.getTime() + 24 * 60 * 60 * 1000);
    } else if (isBiWeekly) {
      current = new Date(current.getTime() + 14 * 24 * 60 * 60 * 1000);
    } else if (isWeekly) {
      current = new Date(current.getTime() + 7 * 24 * 60 * 60 * 1000);
    } else if (isWeekday) {
      // Skip to next weekday
      do {
        current = new Date(current.getTime() + 24 * 60 * 60 * 1000);
      } while (current.getUTCDay() === 0 || current.getUTCDay() === 6);
    } else if (isQuarterly) {
      // Add 3 calendar months while preserving the original anchor day where possible.
      // Example: Aug 31 → Nov 30 → Feb 28 → May 31 (not May 28).
      current = addUtcMonthsClamped(current, 3, anchorDay);
    } else if (isMonthly) {
      // Add 1 calendar month while preserving the original anchor day where possible.
      // Example: Jan 31 → Feb 28 → Mar 31 (not Mar 28).
      current = addUtcMonthsClamped(current, 1, anchorDay);
    } else if (isYearly) {
      // Add 1 calendar year while preserving the original month/day anchor where possible.
      // Example: 2024-02-29 → 2025-02-28 → 2028-02-29.
      current = addUtcYearsClamped(current, 1, anchorMonth, anchorDay);
    } else {
      // Fallback: assume weekly if pattern not recognized
      current = new Date(current.getTime() + 7 * 24 * 60 * 60 * 1000);
    }

    occurrences.push(getUTCDateStr(current));
  }

  return occurrences;
}

/**
 * Formats a date range string for the 5-occurrence preview in the UI.
 * 
 * @param occurrences - Array of occurrence dates (ISO format)
 * @returns A human-readable string like "May 28, Jun 4, Jun 11, Jun 18, Jun 25"
 */
export function formatOccurrencePreview(occurrences: string[]): string {
  if (occurrences.length === 0) return '';
  
  return occurrences.map((iso) => formatIsoMonthDay(iso)).join(', ');
}

/**
 * Determines which occurrence index a task is in a series.
 * This would typically be stored in metadata and incremented when generating next occurrence.
 * 
 * @param recurrenceCount - The current recurrence count (number of times completed/skipped)
 * @returns The zero-based index (0 for first, 1 for second, etc.)
 */
export function getOccurrenceIndex(recurrenceCount: number | undefined): number {
  return (recurrenceCount ?? 0);
}

/**
 * Advances the occurrence counter (for skip-occurrence command).
 * 
 * @param currentCount - The current recurrence count
 * @returns The next count value
 */
export function advanceOccurrenceCounter(currentCount: number | undefined): number {
  return (currentCount ?? 0) + 1;
}

/**
 * Checks if a recurring task should generate its next occurrence.
 * 
 * Returns false if the series has a limit (via 'for N times') and we've reached it.
 * 
 * @param recurrenceCount - Current recurrence count
 * @param recurrenceLimit - Maximum occurrences (from 'for N times' suffix)
 * @returns true if we should generate the next occurrence
 */
export function shouldGenerateNextOccurrence(
  recurrenceCount: number | undefined,
  recurrenceLimit: number | undefined,
): boolean {
  if (recurrenceLimit === undefined) {
    return true; // No limit
  }
  const count = recurrenceCount ?? 0;
  return count < recurrenceLimit;
}

export interface ScopeEditWriteResult extends ScopeApplicationResult {
  changed: boolean;
  lineNumber: number;
}

/**
 * Minimal vault writer for recurrence edit scopes. This intentionally applies the
 * supplied replacement text to the current occurrence only, while returning the
 * scope instructions so callers can preview/record broader series intent. Full
 * this-and-future/all-series rewrite remains a higher-level workflow concern.
 */
export async function executeScopeEdit(
  app: App,
  file: TFile,
  lineNumber: number,
  scope: EditScope,
  newContent: string,
  currentSeriesId?: RecurrenceSeriesId,
  currentOccurrenceIndex = 0,
  renderedTask?: ParsedTask,
  scanner?: TaskScanner,
): Promise<ScopeEditWriteResult> {
  const result = applyScopeToEdit(scope, currentSeriesId, currentOccurrenceIndex);
  let changed = false;
  let resolvedLineNumber = lineNumber;
  await app.vault.process(file, (content) => {
    const lines = splitContentLines(content);
    let idx = lineNumber - 1;
    if (renderedTask) {
      if (!scanner) throw new Error('Identity-aware scanner is required with a rendered recurrence task');
      idx = resolveRenderedTaskLine(
        lines,
        renderedTask,
        (line, filePath, currentLineNumber, heading) => scanner.parseTaskLine(line, filePath, currentLineNumber, heading),
      ).lineIndex;
    } else if (idx < 0 || idx >= lines.length) {
      throw new Error(`Line ${lineNumber} out of range in ${file.path}`);
    }
    resolvedLineNumber = idx + 1;
    if (lines[idx].text !== newContent) {
      lines[idx].text = newContent;
      changed = true;
    }
    return lines.map((line) => `${line.text}${line.lineEnding}`).join('');
  });
  return { ...result, changed, lineNumber: resolvedLineNumber };
}
