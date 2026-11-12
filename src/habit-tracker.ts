import type { App } from 'obsidian';
import type { TaskManagerSettings } from './types';
import type { ParsedTask } from './task-scanner';
import { addIsoDays as addDays, diffIsoDays, formatLocalDate, isValidIsoDate } from './iso-date';

export interface SerializedStreakState {
  completions?: string[];
  streak?: number;
  maxStreak?: number;
  longestStreak?: number;
  totalCompletions?: number;
  longestBreakDays?: number;
}

export interface HabitStreakState {
  completions: string[];
  currentStreak: number;
  longestStreak: number;
  maxStreak: number;
  totalCompletions: number;
  weeklyCompletions: number;
  longestBreakDays?: number;
}

export type HabitCompletionProvider = () => Record<string, string[]> | Promise<Record<string, string[]>>;

export function taskIsHabit(task: ParsedTask): boolean {
  const hasHabitTag = task.tags.some((t) => t.toLowerCase() === 'habit');
  const hasRecurrence = Boolean(task.metadata.recurrence);
  const inHabitFile = task.filePath.toLowerCase().includes('habit');
  return (hasHabitTag && hasRecurrence) || inHabitFile;
}

function toIsoDate(value: Date | string): string {
  if (value instanceof Date) return formatLocalDate(value);
  const match = value.match(/\d{4}-\d{2}-\d{2}/u);
  if (match) return isValidIsoDate(match[0]) ? match[0] : '';
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString().slice(0, 10);
}

function uniqueSortedDates(values: unknown[] = []): string[] {
  return [...new Set(values.map((value) => {
    if (value instanceof Date) return toIsoDate(value);
    return typeof value === 'string' ? toIsoDate(value) : '';
  }).filter((date) => /^\d{4}-\d{2}-\d{2}$/u.test(date)))].sort();
}

function nonNegativeNumber(value: unknown, fallback = 0): number {
  const numberValue = typeof value === 'number' || typeof value === 'string' ? Number(value) : fallback;
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : fallback;
}

function optionalNonNegativeNumber(value: unknown): number | undefined {
  const numberValue = typeof value === 'number' || typeof value === 'string' ? Number(value) : Number.NaN;
  return Number.isFinite(numberValue) && numberValue >= 0 ? numberValue : undefined;
}

function diffDays(left: string, right: string): number { return diffIsoDays(right, left); }

function calculateMetrics(completions: string[]): HabitStreakState {
  const sorted = uniqueSortedDates(completions);
  let longestStreak = 0;
  let currentRun = 0;
  let previous: string | null = null;
  let longestBreakDays: number | undefined;

  for (const date of sorted) {
    if (!previous || diffDays(date, previous) === 1) {
      currentRun += 1;
    } else {
      const breakDays = Math.max(0, diffDays(date, previous) - 1);
      longestBreakDays = Math.max(longestBreakDays ?? 0, breakDays);
      currentRun = 1;
    }
    longestStreak = Math.max(longestStreak, currentRun);
    previous = date;
  }

  const _td = new Date(); const today = `${_td.getFullYear()}-${String(_td.getMonth() + 1).padStart(2, '0')}-${String(_td.getDate()).padStart(2, '0')}`;  const yesterday = addDays(today, -1);

  const completedThroughToday = sorted.filter((date) => date <= today);
  const latest = completedThroughToday[completedThroughToday.length - 1];
  let currentStreak = 0;
  // A streak is "current" only if the most recent completion is today or yesterday.
  // Without this guard, a streak that ended days ago would still show a positive
  // currentStreak — the function would return the run length ending at 'latest'
  // regardless of how long ago 'latest' was.
  if (latest && latest >= yesterday) {
    let expected = latest;
    for (let i = completedThroughToday.length - 1; i >= 0; i -= 1) {
      if (completedThroughToday[i] !== expected) break;
      currentStreak += 1;
      expected = addDays(expected, -1);
    }
  }
  const weekStart = addDays(today, -6);
  const weeklyCompletions = completedThroughToday.filter((date) => date >= weekStart).length;

  return {
    completions: sorted,
    currentStreak,
    longestStreak,
    maxStreak: longestStreak,
    totalCompletions: sorted.length,
    weeklyCompletions,
    ...(longestBreakDays !== undefined ? { longestBreakDays } : {}),
  };
}

export class HabitTracker {
  constructor(
    private app?: App,
    private getSettings?: () => TaskManagerSettings,
    private getHabitCompletions?: HabitCompletionProvider,
  ) {}

  getStreakState(serialized: SerializedStreakState | HabitStreakState | Record<string, unknown>): HabitStreakState {
    const completions = uniqueSortedDates(Array.isArray((serialized as { completions?: unknown }).completions)
      ? (serialized as { completions: unknown[] }).completions
      : []);
    if (completions.length === 0) {
      const longestBreakDays = optionalNonNegativeNumber((serialized as SerializedStreakState).longestBreakDays);
      return {
        completions: [],
        currentStreak: 0,
        longestStreak: nonNegativeNumber((serialized as SerializedStreakState).longestStreak ?? (serialized as SerializedStreakState).maxStreak),
        maxStreak: nonNegativeNumber((serialized as SerializedStreakState).maxStreak ?? (serialized as SerializedStreakState).longestStreak),
        totalCompletions: nonNegativeNumber((serialized as SerializedStreakState).totalCompletions),
        weeklyCompletions: 0,
        ...(longestBreakDays !== undefined ? { longestBreakDays } : {}),
      };
    }
    return calculateMetrics(completions);
  }

  recordCompletion(state: HabitStreakState | SerializedStreakState | Record<string, unknown>, date: Date | string): HabitStreakState {
    const current = this.getStreakState(state);
    const isoDate = toIsoDate(date);
    if (!isoDate) return current;
    return calculateMetrics([...current.completions, isoDate]);
  }

  exportStreakData(state: HabitStreakState | SerializedStreakState): SerializedStreakState & { streak: number } {
    const current = this.getStreakState(state);
    return {
      completions: current.completions,
      streak: current.currentStreak,
      maxStreak: current.maxStreak,
      longestStreak: current.longestStreak,
      totalCompletions: current.totalCompletions,
      longestBreakDays: current.longestBreakDays,
    };
  }

  validateStreakContinuity(state: HabitStreakState | SerializedStreakState): boolean {
    const current = this.getStreakState(state);
    return current.completions.every((date, index, dates) => index === 0 || date > dates[index - 1]);
  }

  identifyHabits(allTasks: ParsedTask[]): ParsedTask[] {
    return allTasks.filter(taskIsHabit);
  }

  calculateStreak(completionDates: string[], today: string): number {
    const dates = new Set(uniqueSortedDates(completionDates));
    const yesterday = addDays(today, -1);
    
    // Start from the most recent completion (today or yesterday)
    // This matches the grace period logic in calculateMetrics
    let expected: string;
    if (dates.has(today)) {
      expected = today;
    } else if (dates.has(yesterday)) {
      expected = yesterday;
    } else {
      return 0;
    }
    
    let streak = 0;
    while (dates.has(expected)) {
      streak += 1;
      expected = addDays(expected, -1);
    }
    return streak;
  }

  async buildCompletionHistory(habits: ParsedTask[]): Promise<Map<string, string[]>> {
    const persisted = await this.getHabitCompletions?.() ?? {};
    const history = new Map<string, string[]>();
    for (const habit of habits) {
      const dates = uniqueSortedDates([
        ...(persisted[habit.key] ?? []),
        ...(habit.metadata.dates.done ? [habit.metadata.dates.done] : []),
      ]);
      history.set(habit.key, dates);
    }
    return history;
  }
}

export function renderHabitTracker(
  el: HTMLElement,
  habits: ParsedTask[],
  completionHistory: Map<string, string[]>,
  today: string,
  onMarkDone?: (habit: ParsedTask) => void,
): void {
  el.empty();
  el.addClass('task-manager-habits');

  if (habits.length === 0) {
    el.createEl('p', {
      text: 'No habits found. Tag recurring tasks with #habit to track them here.',
      cls: 'task-manager-habits-empty',
    });
    return;
  }

  const tracker = new HabitTracker();
  for (const habit of habits) {
    const row = el.createDiv({ cls: 'task-manager-habit-row' });

    const info = row.createDiv({ cls: 'task-manager-habit-info' });
    info.createEl('span', { text: habit.normalizedText, cls: 'task-manager-habit-name' });

    const dates = completionHistory.get(habit.key) ?? [];
    const streak = tracker.calculateStreak(dates, today);

    const heatmap = row.createDiv({ cls: 'task-manager-habit-heatmap' });
    for (let i = 13; i >= 0; i--) {
      const dateStr = addDays(today, -i);
      const done = dates.includes(dateStr);
      const cell = heatmap.createDiv({
        cls: `task-manager-habit-cell ${done ? 'task-manager-habit-cell-done' : 'task-manager-habit-cell-empty'}`,
      });
      cell.setAttr('title', dateStr);
    }

    const meta = row.createDiv({ cls: 'task-manager-habit-meta' });
    if (streak > 0) {
      meta.createEl('span', { text: `🔥 ${streak}d`, cls: 'task-manager-habit-streak' });
    }

    if (onMarkDone) {
      const completedToday = dates.includes(today) || habit.status === 'done' || habit.status === 'cancelled';
      const btn = row.createEl('button', { text: completedToday ? '✓ Done' : 'Mark Today', cls: 'task-manager-habit-btn' });
      if (completedToday) {
        btn.disabled = true;
        btn.setAttr('aria-disabled', 'true');
        btn.addClass('is-disabled');
      } else {
        btn.addEventListener('click', () => { onMarkDone(habit); });
      }
    }
  }
}
