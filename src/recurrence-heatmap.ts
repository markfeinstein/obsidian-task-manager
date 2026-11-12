import type { ParsedTask } from './task-scanner';
import { addIsoDays as addDays, formatLocalDate } from './iso-date';

function todayIso(): string {
  return formatLocalDate(new Date());
}

function completionDatesForTask(task: ParsedTask, relatedTasks: readonly ParsedTask[] = [], historyDates: readonly string[] = [], today = todayIso()): Set<string> {
  const dates = new Set<string>();
  for (const date of historyDates) dates.add(date.slice(0, 10));
  if (task.metadata.dates.done) dates.add(task.metadata.dates.done.slice(0, 10));

  for (const related of relatedRecurringTasks(task, relatedTasks)) {
    if (related.metadata.dates.done) dates.add(related.metadata.dates.done.slice(0, 10));
    if (related.status === 'done' || related.status === 'cancelled') {
      const occurrenceDate = related.metadata.dates.due ?? related.metadata.dates.scheduled ?? related.metadata.dates.start;
      if (occurrenceDate) dates.add(occurrenceDate.slice(0, 10));
    }
  }

  const count = task.metadata.recurrenceCount ?? 0;
  for (let i = 0; i < count; i += 1) {
    dates.add(addDays(today, -i));
  }
  return dates;
}

function relatedRecurringTasks(task: ParsedTask, tasks: readonly ParsedTask[]): ParsedTask[] {
  const seriesId = task.metadata.recurrenceSeriesId;
  if (seriesId) {
    return tasks.filter((candidate) => candidate !== task && candidate.metadata.recurrenceSeriesId === seriesId);
  }
  const title = task.normalizedText.toLowerCase();
  return tasks.filter((candidate) => candidate !== task
    && candidate.filePath === task.filePath
    && candidate.normalizedText.toLowerCase() === title
    && Boolean(candidate.metadata.recurrence || candidate.metadata.recurrenceRaw || candidate.metadata.dates.done));
}

export function renderRecurrenceHeatmap(task: ParsedTask, relatedTasks: readonly ParsedTask[] = [], historyDatesOrToday: readonly string[] | string = [], maybeToday = todayIso()): HTMLElement | null {
  if (!task.metadata.recurrence && !task.metadata.recurrenceRaw) return null;

  const historyDates = Array.isArray(historyDatesOrToday) ? historyDatesOrToday : [];
  const today = typeof historyDatesOrToday === 'string' ? historyDatesOrToday : maybeToday;
  const completions = completionDatesForTask(task, relatedTasks, historyDates, today);
  const heatmap = document.createElement('div');
  heatmap.addClass('task-manager-recurrence-heatmap');
  heatmap.setAttr('aria-label', `Recurring task activity for ${task.normalizedText}`);

  const cells = 53;
  for (let i = cells - 1; i >= 0; i -= 1) {
    const date = addDays(today, -i * 7);
    const active = Array.from({ length: 7 }, (_unused, dayOffset) => addDays(date, dayOffset)).some((day) => completions.has(day));
    const cell = heatmap.createDiv({ cls: `task-manager-recurrence-heatmap-cell${active ? ' is-active' : ''}` });
    cell.setAttr('title', `${date} week${active ? ': completed' : ''}`);
  }

  const label = heatmap.createEl('span', { text: `${completions.size} done`, cls: 'task-manager-recurrence-heatmap-label' });
  label.setAttr('aria-hidden', 'true');
  return heatmap;
}
