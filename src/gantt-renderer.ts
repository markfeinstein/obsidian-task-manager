import type { TaskManagerSettings } from './types';
import type { ParsedTask } from './task-scanner';
import type { TaskQuery } from './task-query';
import { todayString } from './date-utils';
import { addIsoDays as addDays, diffIsoDays } from './iso-date';
import { getPriorityColorClass } from './color-utils';
import { ExplicitIdIndex, taskLocationKey } from './task-identity';
import { t } from './i18n';

const DAY_WIDTH_PX = 32;
const LABEL_WIDTH_PX = 200;
const ROW_HEIGHT_PX = 28;
let ganttControlSequence = 0;

/** Unique-only dependency lookup used by Gantt arrows and accessibility text. */
export function resolveGanttDependency(tasks: readonly ParsedTask[], id: string): ParsedTask | undefined {
  return new ExplicitIdIndex(tasks).unique(id);
}

export function getGanttKeyboardReschedule(task: ParsedTask): { field: 'scheduled' | 'due'; current: string } | null {
  if (task.metadata.dates.start) return null;
  if (task.metadata.dates.scheduled) return { field: 'scheduled', current: task.metadata.dates.scheduled };
  if (task.metadata.dates.due) return { field: 'due', current: task.metadata.dates.due };
  return null;
}

export function renderGantt(
  el: HTMLElement,
  tasks: ParsedTask[],
  _query: TaskQuery,
  _settings: TaskManagerSettings,
  _onToggle: (task: ParsedTask) => Promise<void>,
  onEdit: (task: ParsedTask) => void,
  onReschedule?: (task: ParsedTask, field: 'scheduled' | 'due', newDate: string) => Promise<void>,
  futureTasks: ParsedTask[] = [],
): void {
  el.addClass('task-manager-gantt');
  el.setAttr('role', 'region');
  el.setAttr('aria-label', 'Task Gantt timeline');
  let liveRegion: HTMLElement | null = null;
  const announce = (message: string): void => { liveRegion?.setText(message); };

  const today = todayString();
  let viewportDays = 28;
  let windowStart = addDays(today, -Math.floor(viewportDays / 2));

  const render = (): void => {
    el.empty();
    el.addClass('task-manager-gantt');
    liveRegion = el.createDiv('task-manager-sr-only');
    liveRegion.setAttr('role', 'status');
    liveRegion.setAttr('aria-live', 'polite');

    const windowEnd = addDays(windowStart, viewportDays - 1);
    const totalDays = viewportDays;

    // ── Toolbar ───────────────────────────────────────────────────
    const toolbar = el.createDiv({ cls: 'task-manager-gantt-toolbar' });

    // Zoom selector
    const zoomId = `task-manager-gantt-zoom-${ganttControlSequence++}`;
    const zoomLabel = toolbar.createEl('label', { text: 'Timeline range', cls: 'task-manager-gantt-zoom-label' });
    zoomLabel.htmlFor = zoomId;
    const zoomSelect = toolbar.createEl('select', { cls: 'task-manager-gantt-zoom' });
    zoomSelect.id = zoomId;
    for (const [label, days] of [['7d', 7], ['14d', 14], ['28d', 28], ['60d', 60], ['90d', 90]] as [string, number][]) {
      const opt = zoomSelect.createEl('option', { text: label, value: String(days) });
      if (days === viewportDays) opt.selected = true;
    }
    zoomSelect.addEventListener('change', () => {
      viewportDays = Number(zoomSelect.value);
      render();
    });

    const prevBtn = toolbar.createEl('button', { text: '‹ Previous', cls: 'task-manager-gantt-nav-btn' });
    prevBtn.setAttr('aria-label', 'Show previous timeline range');
    const rangeLabel = toolbar.createEl('span', {
      text: `${formatShort(windowStart)} – ${formatShort(windowEnd)}`,
      cls: 'task-manager-gantt-range-label',
    });
    void rangeLabel;
    const nextBtn = toolbar.createEl('button', { text: 'Next ›', cls: 'task-manager-gantt-nav-btn' });
    nextBtn.setAttr('aria-label', 'Show next timeline range');
    const todayBtn = toolbar.createEl('button', { text: 'Today', cls: 'task-manager-gantt-today-btn' });
    const fitBtn = toolbar.createEl('button', { text: 'Fit', cls: 'task-manager-gantt-fit-btn' });

    prevBtn.addEventListener('click', () => { windowStart = addDays(windowStart, -Math.floor(viewportDays / 2)); render(); });
    nextBtn.addEventListener('click', () => { windowStart = addDays(windowStart, Math.floor(viewportDays / 2)); render(); });
    todayBtn.addEventListener('click', () => { windowStart = addDays(today, -Math.floor(viewportDays / 2)); render(); });
    fitBtn.addEventListener('click', () => {
      const taskDates = tasks
        .flatMap((t) => [t.metadata.dates.due, t.metadata.dates.scheduled, t.metadata.dates.start].filter(Boolean) as string[]);
      if (taskDates.length === 0) return;
      const minDate = taskDates.reduce((a, b) => (a < b ? a : b));
      const maxDate = taskDates.reduce((a, b) => (a > b ? a : b));
      viewportDays = Math.max(7, Math.ceil((new Date(maxDate).getTime() - new Date(minDate).getTime()) / 86_400_000) + 4);
      windowStart = addDays(minDate, -2);
      render();
    });

    // ── Timeline header ───────────────────────────────────────────
    const headerRow = el.createDiv({ cls: 'task-manager-gantt-header-row' });
    headerRow.createDiv({ cls: 'task-manager-gantt-label-col' }); // spacer for label column
    const timelineHeader = headerRow.createDiv({ cls: 'task-manager-gantt-timeline-header' });
    timelineHeader.style.width = `${totalDays * DAY_WIDTH_PX}px`;
    timelineHeader.style.position = 'relative';

    // Week / day markers
    for (let i = 0; i < totalDays; i++) {
      const dayStr = addDays(windowStart, i);
      const [, , dd] = dayStr.split('-').map(Number) as [number, number, number];
      const isMonday = new Date(Date.UTC(+dayStr.slice(0, 4), +dayStr.slice(5, 7) - 1, dd)).getUTCDay() === 1;
      if (i === 0 || isMonday) {
        const lbl = timelineHeader.createEl('span', {
          text: dayStr.slice(5), // MM-DD
          cls: 'task-manager-gantt-day-label',
        });
        lbl.style.position = 'absolute';
        lbl.style.left = `${i * DAY_WIDTH_PX}px`;
      }
    }

    // Today line
    const todayOffset = daysBetween(windowStart, today);
    if (todayOffset >= 0 && todayOffset < totalDays) {
      const marker = timelineHeader.createDiv({ cls: 'task-manager-gantt-today-marker' });
      marker.style.left = `${todayOffset * DAY_WIDTH_PX + DAY_WIDTH_PX / 2}px`;
    }

    // ── Task rows ─────────────────────────────────────────────────
    const tasksWithDates = tasks.filter((t) =>
      t.metadata.dates.due || t.metadata.dates.scheduled || t.metadata.dates.start,
    );
    const undated = tasks.filter((t) =>
      !t.metadata.dates.due && !t.metadata.dates.scheduled && !t.metadata.dates.start,
    );

    // Wrap dated rows in a relative container so the SVG overlay can be positioned within it
    const rowsContainer = el.createDiv({ cls: 'task-manager-gantt-rows' });
    rowsContainer.style.position = 'relative';

    const taskRowMap = new Map<string, number>();
    const explicitIds = new ExplicitIdIndex(tasks);
    tasksWithDates.forEach((task, rowIndex) => {
      taskRowMap.set(taskLocationKey(task), rowIndex);
      renderGanttRow(rowsContainer, task, windowStart, windowEnd, totalDays, today, onEdit, onReschedule, false, announce);
    });

    // ── Future occurrence rows (projected recurring instances) ──────
    const futureWithDates = futureTasks.filter((t) =>
      t.metadata.dates.due || t.metadata.dates.scheduled || t.metadata.dates.start,
    );
    for (const futureTask of futureWithDates) {
      renderGanttRow(rowsContainer, futureTask, windowStart, windowEnd, totalDays, today, onEdit, undefined, true, announce);
    }

    // ── Dependency arrows (SVG overlay) ───────────────────────────
    const hasDeps = tasksWithDates.some((t) => t.metadata.dependsOn && t.metadata.dependsOn.length > 0);
    if (hasDeps && tasksWithDates.length > 0) {
      const dependencyList = rowsContainer.createEl('ul', { cls: 'task-manager-sr-only' });
      dependencyList.setAttr('aria-label', 'Task dependencies');
      for (const task of tasksWithDates) {
        for (const depId of task.metadata.dependsOn ?? []) {
          const resolution = explicitIds.resolve(depId);
          if (resolution.kind === 'unique') dependencyList.createEl('li', { text: `${task.normalizedText} depends on ${resolution.task.normalizedText}` });
          else if (resolution.kind === 'ambiguous') dependencyList.createEl('li', { text: `${task.normalizedText} has ambiguous dependency ${depId}` });
        }
      }
      const svgNS = 'http://www.w3.org/2000/svg';
      const svg = document.createElementNS(svgNS, 'svg');
      svg.setAttribute('class', 'task-manager-gantt-deps');
      svg.style.position = 'absolute';
      svg.style.top = '0';
      svg.style.left = `${LABEL_WIDTH_PX}px`;
      svg.style.width = `${totalDays * DAY_WIDTH_PX}px`;
      svg.style.height = `${tasksWithDates.length * ROW_HEIGHT_PX}px`;
      svg.style.pointerEvents = 'none';
      svg.style.overflow = 'visible';

      for (const task of tasksWithDates) {
        if (!task.metadata.dependsOn?.length) continue;
        const taskRow = taskRowMap.get(taskLocationKey(task));
        if (taskRow === undefined) continue;
        const taskStart = task.metadata.dates.scheduled ?? task.metadata.dates.due ?? task.metadata.dates.start;
        if (!taskStart) continue;

        for (const depId of task.metadata.dependsOn) {
          const depTask = explicitIds.unique(depId);
          if (!depTask) continue;
          const depRow = taskRowMap.get(taskLocationKey(depTask));
          if (depRow === undefined) continue;
          const depEnd = depTask.metadata.dates.due ?? depTask.metadata.dates.scheduled;
          if (!depEnd) continue;

          const x1 = Math.max(0, daysBetween(windowStart, depEnd) + 1) * DAY_WIDTH_PX;
          const y1 = depRow * ROW_HEIGHT_PX + ROW_HEIGHT_PX / 2;
          const x2 = Math.max(0, daysBetween(windowStart, taskStart)) * DAY_WIDTH_PX;
          const y2 = taskRow * ROW_HEIGHT_PX + ROW_HEIGHT_PX / 2;
          const midX = (x1 + x2) / 2;

          const path = document.createElementNS(svgNS, 'path');
          path.setAttribute('d', `M${x1},${y1} C${midX},${y1} ${midX},${y2} ${x2},${y2}`);
          path.setAttribute('stroke', 'var(--color-accent)');
          path.setAttribute('stroke-width', '1.5');
          path.setAttribute('fill', 'none');
          path.setAttribute('stroke-dasharray', '4,3');
          svg.appendChild(path);
        }
      }

      rowsContainer.appendChild(svg);
    }

    if (undated.length > 0) {
      el.createEl('div', { text: `Undated (${undated.length}):`, cls: 'task-manager-gantt-undated-heading' });
      for (const task of undated) {
        const row = el.createDiv({ cls: 'task-manager-gantt-row task-manager-gantt-row-undated' });
        const labelCol = row.createDiv({ cls: 'task-manager-gantt-label-col' });
        const lbl = labelCol.createEl('span', { cls: 'task-manager-gantt-label' });
        lbl.setText(task.normalizedText.slice(0, 30) + (task.normalizedText.length > 30 ? '…' : ''));
        row.setAttr('role', 'button');
        row.setAttr('tabindex', '0');
        row.setAttr('aria-label', `Edit undated task ${task.normalizedText}`);
        row.addEventListener('click', () => onEdit(task));
        row.addEventListener('keydown', (event: KeyboardEvent) => {
          if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onEdit(task); }
        });
      }
    }
  };

  render();
}

function renderGanttRow(
  container: HTMLElement,
  task: ParsedTask,
  windowStart: string,
  windowEnd: string,
  totalDays: number,
  today: string,
  onEdit: (task: ParsedTask) => void,
  onReschedule?: (task: ParsedTask, field: 'scheduled' | 'due', newDate: string) => Promise<void>,
  isFuture = false,
  announce: (message: string) => void = () => undefined,
): void {
  const futureClass = isFuture ? ' task-manager-gantt-future' : '';
  const row = container.createDiv({ cls: `task-manager-gantt-row${task.status === 'done' ? ' is-done' : ''}${futureClass}` });
  row.style.display = 'flex';
  row.style.alignItems = 'center';

  // Label column
  const labelCol = row.createDiv({ cls: 'task-manager-gantt-label-col' });
  labelCol.style.width = `${LABEL_WIDTH_PX}px`;
  labelCol.style.flexShrink = '0';
  const lbl = labelCol.createEl('span', { cls: 'task-manager-gantt-label' });
  lbl.setText(task.normalizedText.slice(0, 26) + (task.normalizedText.length > 26 ? '…' : ''));
  lbl.setAttr('title', task.normalizedText);
  labelCol.setAttr('role', 'button');
  labelCol.setAttr('tabindex', '0');
  labelCol.addEventListener('click', () => onEdit(task));
  labelCol.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onEdit(task); }
  });

  // Timeline column
  const timeline = row.createDiv({ cls: 'task-manager-gantt-timeline-col' });
  timeline.style.position = 'relative';
  timeline.style.width = `${totalDays * DAY_WIDTH_PX}px`;
  timeline.style.height = `${ROW_HEIGHT_PX}px`;
  timeline.style.flexShrink = '0';

  // Compute bar: from start/scheduled to due, or just a point at due/scheduled
  const barStart = task.metadata.dates.start ?? task.metadata.dates.scheduled;
  const barEnd = task.metadata.dates.due ?? task.metadata.dates.scheduled ?? task.metadata.dates.start;
  if (!barEnd) return;
  const directReschedule = onReschedule && !isFuture ? getGanttKeyboardReschedule(task) : null;
  if (directReschedule) {
    const dateInput = row.createEl('input', { type: 'date', cls: 'task-manager-gantt-reschedule-input' });
    dateInput.value = directReschedule.current;
    row.insertBefore(dateInput, timeline);
    dateInput.setAttr('aria-label', t('gantt.reschedule', { task: task.normalizedText }));
    dateInput.addEventListener('change', () => {
      const previousDate = directReschedule.current;
      const nextDate = dateInput.value;
      if (!nextDate || nextDate === previousDate) return;
      dateInput.disabled = true;
      void onReschedule?.(task, directReschedule.field, nextDate)
        .then(() => { directReschedule.current = nextDate; announce(`${task.normalizedText} moved to ${nextDate}`); })
        .catch((error: unknown) => {
          dateInput.value = previousDate;
          announce(`Could not move ${task.normalizedText}: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => { dateInput.disabled = false; });
    });
  }
  labelCol.setAttr('aria-label', `${task.normalizedText}, ${barStart ? `starts ${barStart}, ` : ''}ends ${barEnd}, status ${task.status}, priority ${task.metadata.priority ?? 'normal'}`);

  const startOffset = Math.max(0, daysBetween(windowStart, barStart ?? barEnd));
  const endOffset = Math.min(totalDays - 1, daysBetween(windowStart, barEnd));

  if (endOffset < 0 || startOffset >= totalDays) {
    // Task is entirely outside the visible window — show an arrow indicator
    const arrow = timeline.createDiv({ cls: 'task-manager-gantt-arrow' });
    arrow.setText(daysBetween(windowStart, barEnd) < 0 ? '◀' : '▶');
    arrow.setAttr('title', `Due: ${barEnd}`);
    return;
  }

  const leftPx = startOffset * DAY_WIDTH_PX;
  const widthPx = Math.max(DAY_WIDTH_PX, (endOffset - startOffset + 1) * DAY_WIDTH_PX);

  const barIsDuration = barStart && barEnd && barStart !== barEnd;
  const isOverdue = barEnd < today && task.status !== 'done' && task.status !== 'cancelled';

  const bar = timeline.createDiv({
    cls: `task-manager-gantt-bar${barIsDuration ? ' task-manager-gantt-bar-duration' : ''}${isOverdue ? ' is-overdue' : ''}${task.status === 'done' ? ' is-done' : ''}${futureClass}`,
  });
  // Apply priority color to gantt bar
  const priority = task.metadata.priority || 'normal';
  bar.addClass(getPriorityColorClass(priority));
  bar.style.position = 'absolute';
  bar.style.left = `${leftPx}px`;
  bar.style.width = `${widthPx}px`;
  bar.style.top = '4px';
  bar.style.height = '20px';
  bar.setAttr('title', `${barIsDuration ? `${barStart} → ` : ''}${barEnd}  ${task.normalizedText}`);
  bar.setAttr('role', 'button');
  bar.setAttr('tabindex', '0');
  const keyboardReschedule = directReschedule;
  let keyboardReschedulePending = false;
  bar.setAttr('aria-label', `${task.normalizedText}, ${barStart ? `from ${barStart} ` : ''}to ${barEnd}${keyboardReschedule ? '. Use Left and Right Arrow to move by one day' : ''}`);
  bar.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onEdit(task); return; }
    if (onReschedule && keyboardReschedule && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault();
      if (keyboardReschedulePending) return;
      keyboardReschedulePending = true;
      const previousDate = keyboardReschedule.current;
      const nextDate = addDays(previousDate, event.key === 'ArrowRight' ? 1 : -1);
      keyboardReschedule.current = nextDate;
      void onReschedule(task, keyboardReschedule.field, nextDate)
        .then(() => announce(`${task.normalizedText} moved to ${nextDate}`))
        .catch((error: unknown) => {
          keyboardReschedule.current = previousDate;
          announce(`Could not move ${task.normalizedText}: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => { keyboardReschedulePending = false; });
    }
  });

  // ── Drag-to-reschedule (move bar = change scheduled date) ─────────
  // Only enable dragging if 'start' is not set, since start takes precedence
  // in bar positioning but cannot be updated via onReschedule (which only
  // supports 'scheduled' | 'due'). This prevents confusing behavior where
  // dragging doesn't visually move the bar.
  if (onReschedule && !isFuture && !task.metadata.dates.start) {
    const barStartDate = barStart ?? barEnd;
    const fieldToUpdate = task.metadata.dates.scheduled ? 'scheduled' : 'due';
    bar.style.cursor = 'grab';
    attachDragHandler(
      bar,
      leftPx,
      barStartDate,
      fieldToUpdate,
      task,
      windowStart,
      onReschedule,
    );
  } else {
    bar.addEventListener('click', () => onEdit(task));
  }

  // ── Resize handle (drag right edge = change due date) ────────────
  const resizeHandle = bar.createDiv({ cls: 'task-manager-gantt-resize-handle' });
  resizeHandle.style.position = 'absolute';
  resizeHandle.style.right = '0';
  resizeHandle.style.top = '0';
  resizeHandle.style.width = '8px';
  resizeHandle.style.height = '100%';
  resizeHandle.style.cursor = 'ew-resize';
  resizeHandle.setAttr('title', 'Drag to change due date');
  if (onReschedule && !isFuture) {
    attachResizeHandler(
      resizeHandle,
      bar,
      widthPx,
      task.metadata.dates.due ?? task.metadata.dates.scheduled ?? today,
      task,
      windowStart,
      onReschedule,
    );
  }

  // Priority dot
  if (task.metadata.priority && task.metadata.priority !== 'normal') {
    const pIcon = ({ highest: '🔺', high: '⏫', medium: '🔼', low: '🔽', lowest: '⏬' } as Record<string, string>)[task.metadata.priority] ?? '';
    bar.createEl('span', { text: pIcon, cls: 'task-manager-gantt-bar-priority' });
  }
}

// ── Drag helpers ───────────────────────────────────────────────────────────────

function attachDragHandler(
  bar: HTMLElement,
  initialLeftPx: number,
  startDate: string,
  field: 'scheduled' | 'due',
  task: ParsedTask,
  windowStart: string,
  onReschedule: (task: ParsedTask, field: 'scheduled' | 'due', newDate: string) => Promise<void>,
): void {
  void initialLeftPx; // unused but kept for potential future use
  void windowStart;
  bar.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    let currentDelta = 0;

    const onMouseMove = (mv: MouseEvent): void => {
      currentDelta = Math.round((mv.clientX - startX) / DAY_WIDTH_PX);
      bar.style.transform = `translateX(${currentDelta * DAY_WIDTH_PX}px)`;
      bar.style.cursor = 'grabbing';
    };

    const onMouseUp = (): void => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      bar.style.cursor = 'grab';
      bar.style.transform = '';
      if (currentDelta !== 0) {
        const newDate = addDays(startDate, currentDelta);
        void onReschedule(task, field, newDate);
      }
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp, { once: true });
  });
}

function attachResizeHandler(
  handle: HTMLElement,
  bar: HTMLElement,
  initialWidthPx: number,
  dueDate: string,
  task: ParsedTask,
  windowStart: string,
  onReschedule: (task: ParsedTask, field: 'scheduled' | 'due', newDate: string) => Promise<void>,
): void {
  void windowStart;
  handle.addEventListener('mousedown', (e: MouseEvent) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();

    const startX = e.clientX;
    let currentDelta = 0;

    const onMouseMove = (mv: MouseEvent): void => {
      currentDelta = Math.round((mv.clientX - startX) / DAY_WIDTH_PX);
      const newWidth = Math.max(DAY_WIDTH_PX, initialWidthPx + currentDelta * DAY_WIDTH_PX);
      bar.style.width = `${newWidth}px`;
    };

    const onMouseUp = (): void => {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      bar.style.width = `${initialWidthPx}px`;
      if (currentDelta !== 0) {
        const newDate = addDays(dueDate, currentDelta);
        void onReschedule(task, 'due', newDate);
      }
    };

    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp, { once: true });
  });
}

function daysBetween(startStr: string, endStr: string): number { return diffIsoDays(startStr, endStr); }

function formatShort(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });
}
