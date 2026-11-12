import type { TaskManagerSettings } from './types';
import type { ParsedTask } from './task-scanner';
import type { TaskQuery } from './task-query';
import { renderProgressBar } from './progress-bar-decorator';
import { getPriorityColorClass } from './color-utils';
import { todayString } from './date-utils';
import { addIsoDays as addDays, addIsoMonths } from './iso-date';
import { getLocale, t } from './i18n';

/**
 * Tracks the AbortController for the active popover-outside-click listener associated with
 * each calendar container element. The listener is registered only while an overflow
 * popover is open, then aborted when the popover closes or the calendar re-renders.
 */
const calendarPopoverControllers = new WeakMap<HTMLElement, AbortController>();
let calendarPopoverSequence = 0;
let calendarViewSequence = 0;

interface CalendarRenderState {
  viewPanelId: string;
  viewYear: number;
  viewMonth: number;
  viewWeekStart: string;
  viewMode: CalendarViewMode;
  selectedDate: string;
  openPopover: (HTMLElement & { taskManagerTrigger?: HTMLElement }) | null;
}

const calendarRenderStates = new WeakMap<HTMLElement, CalendarRenderState>();

type CalendarViewMode = 'month' | 'week' | '3day' | 'day' | 'agenda' | 'list';

function getCalendarRenderState(el: HTMLElement, today: string): CalendarRenderState {
  const existing = calendarRenderStates.get(el);
  if (existing) return existing;

  const created: CalendarRenderState = {
    viewPanelId: `task-manager-calendar-view-${calendarViewSequence++}`,
    viewYear: Number(today.slice(0, 4)),
    viewMonth: Number(today.slice(5, 7)),
    viewWeekStart: getWeekStart(today),
    viewMode: 'month',
    selectedDate: today,
    openPopover: null,
  };
  calendarRenderStates.set(el, created);
  return created;
}

export interface CalendarIcsEvent {
  summary: string;
  date: string | null;
  startTime?: string;
  endTime?: string;
  uid: string | null;
}

function createCalendarEditButton(
  parent: HTMLElement,
  task: ParsedTask,
  className: string,
  onEdit: (task: ParsedTask) => void,
  label = task.normalizedText,
): HTMLButtonElement {
  const button = parent.createEl('button', { text: label, cls: className });
  button.setAttr('type', 'button');
  button.setAttr('aria-label', `Edit ${task.normalizedText}`);
  button.addEventListener('click', () => onEdit(task));
  return button;
}

export function renderCalendar(
  el: HTMLElement,
  tasks: ParsedTask[],
  _query: TaskQuery,
  _settings: TaskManagerSettings,
  onToggle: (task: ParsedTask) => Promise<void>,
  onEdit: (task: ParsedTask) => void,
  onCreate?: (date?: string) => void,
  onReschedule?: (task: ParsedTask, field: 'scheduled' | 'due', newDate: string) => Promise<void>,
  futureTasks: ParsedTask[] = [],
  icsEvents: CalendarIcsEvent[] = [],
): () => void {
  el.addClass('task-manager-calendar');

  const today = todayString();
  const state = getCalendarRenderState(el, today);

  const closePopover = (): void => {
    const popover = state.openPopover;
    const trigger = popover?.taskManagerTrigger;
    const restoreTrigger = Boolean(popover && typeof document !== 'undefined' && popover.contains(document.activeElement));
    trigger?.setAttr('aria-expanded', 'false');
    trigger?.removeAttribute('aria-controls');
    popover?.remove();
    if (restoreTrigger) trigger?.focus();
    state.openPopover = null;
    calendarPopoverControllers.get(el)?.abort();
    calendarPopoverControllers.delete(el);
  };

  const openPopover = (popover: HTMLElement): void => {
    closePopover();
    state.openPopover = popover;

    const documentWithEvents = typeof document !== 'undefined'
      ? (document as Document & { addEventListener?: Document['addEventListener'] })
      : undefined;
    if (typeof documentWithEvents?.addEventListener !== 'function') return;

    const popoverCtrl = new AbortController();
    calendarPopoverControllers.set(el, popoverCtrl);
    documentWithEvents.addEventListener('click', (e: MouseEvent) => {
      const disconnected = typeof (el as HTMLElement & { isConnected?: boolean }).isConnected === 'boolean'
        && !(el as HTMLElement & { isConnected: boolean }).isConnected;
      if (disconnected) { closePopover(); return; }
      if (state.openPopover && !state.openPopover.contains(e.target as Node)) closePopover();
    }, { signal: popoverCtrl.signal });
  };

  const syncSelectedDate = (dateStr: string): void => {
    const [year, month] = dateStr.split('-').map(Number) as [number, number, number];
    state.selectedDate = dateStr;
    state.viewWeekStart = getWeekStart(dateStr);
    state.viewYear = year;
    state.viewMonth = month;
  };

  const render = (): void => {
    closePopover();
    el.empty();
    el.addClass('task-manager-calendar');
    const viewPanelId = state.viewPanelId;

    // ── Toolbar ───────────────────────────────────────────────────
    const toolbar = el.createDiv({ cls: 'task-manager-calendar-toolbar' });

    // View mode toggle
    const viewToggle = toolbar.createDiv({ cls: 'task-manager-calendar-view-toggle' });
    viewToggle.setAttr('role', 'tablist');
    viewToggle.setAttr('aria-label', 'Calendar view');
    const modeButtons: HTMLButtonElement[] = [];
    for (const mode of ['month', 'week', 'day', 'list'] as CalendarViewMode[]) {
      const btn = viewToggle.createEl('button', {
        text: mode === 'month' ? 'Month' : mode === 'week' ? 'Week' : mode === 'day' ? 'Day' : 'List',
        cls: `task-manager-calendar-mode-btn${state.viewMode === mode ? ' is-active' : ''}`,
      });
      btn.id = `${viewPanelId}-tab-${mode}`;
      btn.setAttr('role', 'tab');
      btn.setAttr('aria-controls', viewPanelId);
      btn.setAttr('aria-selected', String(state.viewMode === mode));
      btn.tabIndex = state.viewMode === mode ? 0 : -1;
      btn.addEventListener('click', () => {
        state.viewMode = mode;
        render();
        el.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
      });
      modeButtons.push(btn);
    }
    for (const mode of ['3day', 'agenda'] as CalendarViewMode[]) {
      const btn = viewToggle.createEl('button', {
        text: mode === '3day' ? '3 Day' : 'Agenda',
        cls: `task-manager-calendar-extra-mode-btn${state.viewMode === mode ? ' is-active' : ''}`,
      });
      btn.id = `${viewPanelId}-tab-${mode}`;
      btn.setAttr('role', 'tab');
      btn.setAttr('aria-controls', viewPanelId);
      btn.setAttr('aria-selected', String(state.viewMode === mode));
      btn.tabIndex = state.viewMode === mode ? 0 : -1;
      btn.addEventListener('click', () => {
        state.viewMode = mode;
        render();
        el.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')?.focus();
      });
      modeButtons.push(btn);
    }

    viewToggle.addEventListener('keydown', (event: KeyboardEvent) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const current = modeButtons.indexOf(document.activeElement as HTMLButtonElement);
      if (current < 0) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0
        : event.key === 'End' ? modeButtons.length - 1
        : (current + (event.key === 'ArrowRight' ? 1 : -1) + modeButtons.length) % modeButtons.length;
      modeButtons[next]?.click();
    });

    // Navigation
    const nav = toolbar.createDiv({ cls: 'task-manager-calendar-nav' });
    const prevBtn = nav.createEl('button', { text: '‹', cls: 'task-manager-calendar-nav-btn' });
    prevBtn.setAttr('aria-label', 'Previous calendar period');
    const label = nav.createEl('span', { cls: 'task-manager-calendar-month-label' });

    if (state.viewMode === 'month') {
      label.setText(new Date(Date.UTC(state.viewYear, state.viewMonth - 1, 1)).toLocaleDateString(getLocale(), { year: 'numeric', month: 'long', timeZone: 'UTC' }));
      prevBtn.addEventListener('click', () => {
        state.viewMonth -= 1;
        if (state.viewMonth < 1) { state.viewMonth = 12; state.viewYear -= 1; }
        render();
      });
    } else if (state.viewMode === 'week' || state.viewMode === '3day' || state.viewMode === 'agenda' || state.viewMode === 'list') {
      const span = state.viewMode === '3day' ? 2 : 6;
      const weekEnd = addDays(state.viewWeekStart, span);
      label.setText(`${formatShort(state.viewWeekStart)} – ${formatShort(weekEnd)} · W${isoWeekNumber(state.viewWeekStart)}`);
      prevBtn.addEventListener('click', () => {
        state.viewWeekStart = addDays(state.viewWeekStart, state.viewMode === '3day' ? -3 : -7);
        render();
      });
    } else {
      label.setText(formatShort(state.selectedDate));
      prevBtn.addEventListener('click', () => {
        syncSelectedDate(addDays(state.selectedDate, -1));
        render();
      });
    }

    const nextBtn = nav.createEl('button', { text: '›', cls: 'task-manager-calendar-nav-btn' });
    nextBtn.setAttr('aria-label', 'Next calendar period');
    nextBtn.addEventListener('click', () => {
      if (state.viewMode === 'month') {
        state.viewMonth += 1;
        if (state.viewMonth > 12) { state.viewMonth = 1; state.viewYear += 1; }
      } else if (state.viewMode === 'week' || state.viewMode === '3day' || state.viewMode === 'agenda' || state.viewMode === 'list') {
        state.viewWeekStart = addDays(state.viewWeekStart, state.viewMode === '3day' ? 3 : 7);
      } else {
        syncSelectedDate(addDays(state.selectedDate, 1));
      }
      render();
    });

    // Today button
    const todayBtn = toolbar.createEl('button', { text: 'Today', cls: 'task-manager-calendar-today-btn' });
    todayBtn.addEventListener('click', () => {
      syncSelectedDate(today);
      render();
    });

    // Build day-to-tasks map
    const dayMap = new Map<string, ParsedTask[]>();
    for (const task of tasks) {
      const date = task.metadata.dates.due ?? task.metadata.dates.scheduled ?? task.metadata.dates.start;
      if (!date) continue;
      const key = date.slice(0, 10);
      const list = dayMap.get(key);
      if (list) list.push(task);
      else dayMap.set(key, [task]);
    }

    // Build future-occurrences day map
    const futureDayMap = new Map<string, ParsedTask[]>();
    for (const task of futureTasks) {
      const date = task.metadata.dates.due ?? task.metadata.dates.scheduled ?? task.metadata.dates.start;
      if (!date) continue;
      const key = date.slice(0, 10);
      const list = futureDayMap.get(key);
      if (list) list.push(task);
      else futureDayMap.set(key, [task]);
    }

    const icsDayMap = buildIcsDayMap(icsEvents);

    const viewPanel = el.createDiv({ cls: 'task-manager-calendar-view-panel' });
    viewPanel.id = viewPanelId;
    viewPanel.setAttr('role', 'tabpanel');
    viewPanel.setAttr('aria-labelledby', `${viewPanelId}-tab-${state.viewMode}`);

    if (state.viewMode === 'month') {
      renderMonthGrid(viewPanel, state.viewYear, state.viewMonth, today, state.selectedDate, dayMap, futureDayMap, icsDayMap, tasks, onEdit, onCreate, onReschedule, closePopover, openPopover, syncSelectedDate, () => { state.viewMode = 'day'; render(); }, () => { syncSelectedDate(today); state.viewMode = 'day'; render(); }, onToggle, (date) => { syncSelectedDate(date); render(); el.querySelector<HTMLElement>(`[data-calendar-date="${date}"]`)?.focus(); });
    } else if (state.viewMode === 'week') {
      renderWeekGrid(viewPanel, state.viewWeekStart, today, dayMap, futureDayMap, icsDayMap, tasks, onEdit, onCreate, onReschedule, closePopover, openPopover);
    } else if (state.viewMode === '3day') {
      renderMultiDayGrid(viewPanel, state.viewWeekStart, 3, today, dayMap, futureDayMap, icsDayMap, tasks, onEdit, onCreate, onReschedule, closePopover, openPopover);
    } else if (state.viewMode === 'day') {
      renderDayView(viewPanel, state.selectedDate, today, dayMap, futureDayMap, icsDayMap, tasks, onEdit, onCreate, onReschedule, closePopover, openPopover);
    } else if (state.viewMode === 'agenda') {
      renderAgendaView(viewPanel, state.viewWeekStart, dayMap, futureDayMap, icsDayMap, onEdit);
    } else {
      renderListView(viewPanel, state.viewWeekStart, dayMap, futureDayMap, icsDayMap, onEdit);
    }

    // Undated tasks section
    const undated = tasks.filter((t) => !t.metadata.dates.due && !t.metadata.dates.scheduled && !t.metadata.dates.start);
    if (undated.length > 0) {
      const section = el.createDiv({ cls: 'task-manager-calendar-undated' });
      section.createEl('h4', { text: `Undated (${undated.length})`, cls: 'task-manager-calendar-undated-heading' });
      const chips = section.createDiv('task-manager-calendar-undated-list');
      let visibleCount = 8;
      const renderUndated = (): void => {
        chips.empty();
        for (const task of undated.slice(0, visibleCount)) {
          createCalendarEditButton(chips, task, 'task-manager-calendar-chip', onEdit, task.normalizedText.slice(0, 40) + (task.normalizedText.length > 40 ? '…' : ''));
        }
        if (undated.length > visibleCount) {
          const batchSize = Math.min(50, undated.length - visibleCount);
          const showMore = chips.createEl('button', { text: `Show ${batchSize} more`, cls: 'task-manager-calendar-chip task-manager-calendar-chip-more' });
          showMore.setAttr('type', 'button');
          showMore.setAttr('aria-label', `Show ${batchSize} more of ${undated.length} undated tasks`);
          showMore.addEventListener('click', () => { visibleCount += batchSize; renderUndated(); });
        }
      };
      renderUndated();
    }
    renderUnscheduledPanel(el, tasks, onEdit, onCreate);
  };

  render();
  return closePopover;
}

function renderDayCell(
  parent: HTMLElement,
  dateStr: string,
  today: string,
  dayTasks: ParsedTask[],
  allTasks: ParsedTask[],
  isBlank: boolean,
  onEdit: (task: ParsedTask) => void,
  onCreate?: (date?: string) => void,
  onReschedule?: (task: ParsedTask, field: 'scheduled' | 'due', newDate: string) => Promise<void>,
  closePopover?: () => void,
  setPopover?: (el: HTMLElement) => void,
  futureDayTasks: ParsedTask[] = [],
  icsEvents: CalendarIcsEvent[] = [],
): void {
  const d = Number(dateStr.slice(8, 10));
  const isToday = dateStr === today;
  const cell = parent.createDiv({ cls: `task-manager-calendar-day${isBlank ? ' task-manager-calendar-day-blank' : ''}${isToday ? ' is-today' : ''}` });
  if (!isBlank) {
    // A11y: mark each day cell as a gridcell
    cell.setAttr('role', 'gridcell');
    cell.setAttr('aria-label', `${dateStr}${isToday ? ' (today)' : ''}, ${dayTasks.length} task${dayTasks.length !== 1 ? 's' : ''}`);
  }
  if (isBlank) return;

  // Drop zone handlers for drag-to-reschedule
  if (onReschedule) {
    cell.addEventListener('dragover', (e: DragEvent) => {
      e.preventDefault();
      cell.addClass('task-manager-calendar-drop-target');
    });
    cell.addEventListener('dragleave', (e: DragEvent) => {
      const relatedTarget = e.relatedTarget as Node | null;
      if (relatedTarget && cell.contains(relatedTarget)) return;
      cell.removeClass('task-manager-calendar-drop-target');
    });
    cell.addEventListener('drop', (e: DragEvent) => {
      e.preventDefault();
      cell.removeClass('task-manager-calendar-drop-target');
      const taskKey = e.dataTransfer?.getData('text/task-key')
        || e.dataTransfer?.getData('application/task-id')
        || e.dataTransfer?.getData('text/plain');
      if (!taskKey) return;
      const droppedTask = allTasks.find((t) => t.key === taskKey);
      if (!droppedTask) return;
      // Prefer rescheduling the due date; fall back to scheduled
      const field: 'due' | 'scheduled' = droppedTask.metadata.dates.due ? 'due' : 'scheduled';
      void onReschedule(droppedTask, field, dateStr);
    });
  }

  cell.createEl('span', { text: String(d), cls: 'task-manager-calendar-day-num' });

  const MAX_VISIBLE = 3;
  for (const task of dayTasks.slice(0, MAX_VISIBLE)) {
    // Compute subtask progress for chip
    const afterSorted = allTasks
      .filter((t) => t.filePath === task.filePath && t.lineNumber > task.lineNumber)
      .sort((a, b) => a.lineNumber - b.lineNumber);
    const chipChildren: ParsedTask[] = [];
    for (const t of afterSorted) {
      if (t.indentation.length <= task.indentation.length) break;
      chipChildren.push(t);
    }
    const completedCount = chipChildren.filter((t) => t.status === 'done' || t.status === 'cancelled').length;

    const chip = cell.createDiv({ cls: `task-manager-calendar-chip${task.status === 'done' ? ' is-done' : ''}` });
    // Apply priority color to calendar chip
    const priority = task.metadata.priority || 'normal';
    chip.addClass(getPriorityColorClass(priority));
    const chipLabel = task.normalizedText.slice(0, 22) + (task.normalizedText.length > 22 ? '…' : '');
    chip.setText(chipLabel);
    
    // TASK-15: Add progress bar if task has children
    if (chipChildren.length > 0) {
      const progressEl = renderProgressBar(completedCount, chipChildren.length);
      chip.appendChild(progressEl);
    }
    
    chip.setAttr('title', task.normalizedText);
    chip.setAttr('role', 'button');
    chip.setAttr('tabindex', '0');
    chip.setAttr('aria-label', `${task.normalizedText}${task.metadata.dates.due ? ', due ' + task.metadata.dates.due : ''}`);
    chip.addEventListener('click', (e) => { e.stopPropagation(); onEdit(task); });
    chip.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onEdit(task); }
    });

    if (onReschedule) {
      chip.setAttr('aria-description', t('calendar.rescheduleHint'));
    }

    // Drag-to-reschedule on chip
    if (onReschedule) {
      chip.setAttr('draggable', 'true');
      chip.addEventListener('dragstart', (e: DragEvent) => {
        e.dataTransfer?.setData('text/task-key', task.key);
        e.dataTransfer?.setData('application/task-id', task.key);
        e.dataTransfer?.setData('text/plain', task.key);
        chip.addClass('task-manager-calendar-dragging');
      });
      chip.addEventListener('dragend', () => {
        chip.removeClass('task-manager-calendar-dragging');
      });
    }
  }

  // ICS overlay event chips
  for (const event of icsEvents) {
    const eventChip = cell.createDiv({ cls: 'task-manager-calendar-chip task-manager-calendar-ics-event' });
    const label = `${event.startTime ? `${event.startTime} ` : ''}${event.summary}`;
    eventChip.setText(label.slice(0, 24) + (label.length > 24 ? '…' : ''));
    eventChip.setAttr('title', label);
    eventChip.setAttr('data-ics-uid', event.uid ?? '');
  }

  // Future occurrence chips (projected recurring instances)
  for (const ft of futureDayTasks) {
    const futureChip = cell.createDiv({ cls: 'task-manager-calendar-chip task-manager-cal-future' });
    futureChip.setText('↻ ' + ft.normalizedText.slice(0, 19) + (ft.normalizedText.length > 19 ? '…' : ''));
    futureChip.setAttr('title', `Projected recurrence: ${ft.normalizedText}`);
  }

  if (dayTasks.length > MAX_VISIBLE) {
    const moreEl = cell.createEl('button', { text: `+${dayTasks.length - MAX_VISIBLE} more`, cls: 'task-manager-calendar-chip task-manager-calendar-chip-more' });
    moreEl.setAttr('type', 'button');
    moreEl.setAttr('aria-haspopup', 'dialog');
    moreEl.setAttr('aria-expanded', 'false');
    moreEl.setAttr('aria-label', `Show all ${dayTasks.length} tasks for ${dateStr}`);
    moreEl.addEventListener('click', (e) => {
      e.stopPropagation();
      closePopover?.();
      const popover: HTMLDivElement & { taskManagerTrigger?: HTMLElement } = document.createElement('div');
      const titleId = `task-manager-calendar-popover-${calendarPopoverSequence++}`;
      popover.id = `${titleId}-dialog`;
      popover.addClass('task-manager-calendar-popover');
      popover.setAttr('role', 'dialog');
      popover.setAttr('aria-modal', 'false');
      popover.setAttr('aria-labelledby', titleId);
      popover.createEl('div', { text: dateStr, cls: 'task-manager-calendar-popover-title', attr: { id: titleId } });
      for (const task of dayTasks) {
        const row = popover.createEl('button', { cls: 'task-manager-calendar-popover-row', text: task.normalizedText });
        row.setAttr('type', 'button');
        row.setAttr('aria-label', `Edit ${task.normalizedText}`);
        row.addEventListener('click', () => { moreEl.setAttr('aria-expanded', 'false'); closePopover?.(); onEdit(task); });
      }
      if (onCreate) {
        const createBtn = popover.createEl('button', { text: '+ Add task', cls: 'task-manager-calendar-popover-add' });
        createBtn.addEventListener('click', () => { moreEl.setAttr('aria-expanded', 'false'); closePopover?.(); onCreate(dateStr); });
      }
      // Position popover relative to the cell
      const rect = moreEl.getBoundingClientRect();
      popover.style.position = 'fixed';
      popover.style.top = `${rect.bottom + 4}px`;
      popover.style.left = `${rect.left}px`;
      popover.taskManagerTrigger = moreEl;
      document.body.appendChild(popover);
      moreEl.setAttr('aria-controls', popover.id);
      moreEl.setAttr('aria-expanded', 'true');
      popover.addEventListener('keydown', (event: KeyboardEvent) => {
        if (event.key === 'Escape') {
          event.preventDefault();
          moreEl.setAttr('aria-expanded', 'false');
          closePopover?.();
          moreEl.focus();
        }
      });
      setPopover?.(popover);
      popover.querySelector<HTMLElement>('button')?.focus();
    });
  }
}

function renderMonthGrid(
  el: HTMLElement,
  year: number,
  month: number,
  today: string,
  selectedDate: string,
  dayMap: Map<string, ParsedTask[]>,
  futureDayMap: Map<string, ParsedTask[]>,
  icsDayMap: Map<string, CalendarIcsEvent[]>,
  allTasks: ParsedTask[],
  onEdit: (task: ParsedTask) => void,
  onCreate: ((date?: string) => void) | undefined,
  onReschedule: ((task: ParsedTask, field: 'scheduled' | 'due', newDate: string) => Promise<void>) | undefined,
  closePopover: () => void,
  setPopover: (el: HTMLElement) => void,
  setSelectedDate: (dateStr: string) => void,
  openSelectedAsDay: () => void,
  jumpToTodayAndOpenDay: () => void,
  onToggle: (task: ParsedTask) => Promise<void>,
  navigateToDate: (date: string) => void,
): void {
  // TASK-16: Add agenda sidebar for month view
  const containerWrapper = el.createDiv({ cls: 'task-manager-calendar-month-wrapper' });
  
  // Left: Calendar grid
  const gridContainer = containerWrapper.createDiv({ cls: 'task-manager-calendar-grid-container' });
  const grid = gridContainer.createDiv({ cls: 'task-manager-calendar-grid task-manager-calendar-grid-month' });
  grid.setAttr('role', 'grid');
  grid.setAttr('aria-label', `Task calendar — ${year}-${String(month).padStart(2, '0')}`);
  
  // Right: Agenda sidebar
  const agendaSidebar = containerWrapper.createDiv({ cls: 'task-manager-calendar-agenda-sidebar' });
  const agendaContent = agendaSidebar.createDiv({ cls: 'task-manager-calendar-agenda-content' });
  
  let _selectedDate = selectedDate;
  
  const renderAgenda = (dateStr: string): void => {
    agendaContent.empty();
    _selectedDate = dateStr;
    setSelectedDate(dateStr);

    const tasksForDay = dayMap.get(dateStr) ?? [];
    const futureForDay = futureDayMap.get(dateStr) ?? [];
    const icsForDay = icsDayMap.get(dateStr) ?? [];
    const allForDay = [...tasksForDay, ...futureForDay];

    const header = agendaContent.createDiv({ cls: 'task-manager-calendar-agenda-header' });
    const headingWrap = header.createDiv({ cls: 'task-manager-calendar-agenda-header-title' });
    headingWrap.createEl('h4', {
      text: dateStr,
      cls: 'task-manager-calendar-agenda-date',
    });
    headingWrap.createEl('p', {
      text: `${allForDay.length} task${allForDay.length === 1 ? '' : 's'} · ${icsForDay.length} event${icsForDay.length === 1 ? '' : 's'}`,
      cls: 'task-manager-calendar-agenda-summary',
    });
    const nav = header.createDiv({ cls: 'task-manager-calendar-agenda-nav' });
    const prevDayBtn = nav.createEl('button', { text: '‹', cls: 'task-manager-calendar-agenda-action task-manager-calendar-agenda-action--nav' });
    prevDayBtn.setAttr('type', 'button');
    prevDayBtn.setAttr('aria-label', 'Previous day');
    prevDayBtn.addEventListener('click', () => renderAgenda(addDays(dateStr, -1)));
    const nextDayBtn = nav.createEl('button', { text: '›', cls: 'task-manager-calendar-agenda-action task-manager-calendar-agenda-action--nav' });
    nextDayBtn.setAttr('type', 'button');
    nextDayBtn.setAttr('aria-label', 'Next day');
    nextDayBtn.addEventListener('click', () => renderAgenda(addDays(dateStr, 1)));

    const actionRow = agendaContent.createDiv({ cls: 'task-manager-calendar-agenda-actions' });
    if (onCreate) {
      const addTaskBtn = actionRow.createEl('button', { text: t('kanban.addCard'), cls: 'task-manager-calendar-agenda-action' });
      addTaskBtn.setAttr('type', 'button');
      addTaskBtn.setAttr('aria-label', `Add task for ${dateStr}`);
      addTaskBtn.addEventListener('click', () => onCreate(dateStr));
    }
    const openDayBtn = actionRow.createEl('button', { text: 'Open day', cls: 'task-manager-calendar-agenda-action' });
    openDayBtn.setAttr('type', 'button');
    openDayBtn.addEventListener('click', openSelectedAsDay);
    const todayBtn = actionRow.createEl('button', { text: 'Today', cls: 'task-manager-calendar-agenda-action' });
    todayBtn.setAttr('type', 'button');
    todayBtn.addEventListener('click', jumpToTodayAndOpenDay);

    if (allForDay.length === 0 && icsForDay.length === 0) {
      agendaContent.createEl('p', {
        text: 'No tasks or calendar events for this day',
        cls: 'task-manager-calendar-agenda-empty',
      });
    } else {
      for (const event of icsForDay) {
        const row = agendaContent.createDiv({ cls: 'task-manager-calendar-agenda-row task-manager-calendar-ics-event' });
        row.setText(`${event.startTime ? `${event.startTime} ` : ''}${event.summary}`);
        row.setAttr('title', event.summary);
      }
      for (const task of allForDay) {
        const row = agendaContent.createDiv({ cls: 'task-manager-calendar-agenda-row' });
        const isFuture = futureForDay.includes(task);
        if (isFuture) row.addClass('is-future');
        
        const checkboxHit = row.createEl('label', { cls: 'task-manager-calendar-checkbox-hit' });
        const checkbox = checkboxHit.createEl('input', { type: 'checkbox' });
        checkbox.checked = task.status === 'done';
        checkbox.setAttr('aria-label', `Mark task as ${task.status === 'done' ? 'incomplete' : 'complete'}: ${task.normalizedText}`);
        checkbox.addEventListener('click', (e) => {
          e.preventDefault();
          e.stopPropagation();
          void onToggle(task);
        });
        
        createCalendarEditButton(row, task, 'task-manager-calendar-agenda-text', onEdit);
      }
    }
  };
  
  renderAgenda(selectedDate);
  
  const headerRow = grid.createDiv({ cls: 'task-manager-calendar-grid-row' });
  headerRow.setAttr('role', 'row');
  for (const day of calendarDayNames()) {
    const hdrEl = headerRow.createDiv({ text: day, cls: 'task-manager-calendar-day-header' });
    hdrEl.setAttr('role', 'columnheader');
    hdrEl.setAttr('aria-label', day);
  }

  const firstDow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const monthPrefix = `${year}-${String(month).padStart(2, '0')}`;
  const rovingDate = selectedDate.startsWith(`${monthPrefix}-`) ? selectedDate : `${monthPrefix}-01`;

  let weekRow: HTMLElement | null = null;
  const rowForSlot = (slot: number): HTMLElement => {
    if (!weekRow || slot % 7 === 0) {
      weekRow = grid.createDiv({ cls: 'task-manager-calendar-grid-row' });
      weekRow.setAttr('role', 'row');
    }
    return weekRow;
  };
  for (let i = 0; i < firstDow; i++) {
    const blank = rowForSlot(i).createDiv({ cls: 'task-manager-calendar-day task-manager-calendar-day-blank' });
    blank.setAttr('role', 'gridcell');
    blank.setAttr('aria-disabled', 'true');
  }
  for (let d = 1; d <= daysInMonth; d++) {
    const dateStr = `${year}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dayCell = createDayCell(rowForSlot(firstDow + d - 1), dateStr, today, dayMap.get(dateStr) ?? [], allTasks, false, onEdit, onCreate, onReschedule, closePopover, setPopover, futureDayMap.get(dateStr) ?? [], icsDayMap.get(dateStr) ?? []);
    dayCell.setAttr('data-calendar-date', dateStr);
    dayCell.tabIndex = dateStr === rovingDate ? 0 : -1;
    dayCell.addEventListener('keydown', (event: KeyboardEvent) => {
      let target: string | null = null;
      if (event.key === 'ArrowLeft') target = addDays(dateStr, -1);
      else if (event.key === 'ArrowRight') target = addDays(dateStr, 1);
      else if (event.key === 'ArrowUp') target = addDays(dateStr, -7);
      else if (event.key === 'ArrowDown') target = addDays(dateStr, 7);
      else if (event.key === 'Home') target = addDays(dateStr, -new Date(`${dateStr}T00:00:00Z`).getUTCDay());
      else if (event.key === 'End') target = addDays(dateStr, 6 - new Date(`${dateStr}T00:00:00Z`).getUTCDay());
      else if (event.key === 'PageUp') target = shiftMonth(dateStr, -1);
      else if (event.key === 'PageDown') target = shiftMonth(dateStr, 1);
      if (!target) return;
      event.preventDefault();
      navigateToDate(target);
    });

    // TASK-16: Click day cell to update agenda
    dayCell.addEventListener('click', () => {
      renderAgenda(dateStr);
    });
  }
  const usedSlots = firstDow + daysInMonth;
  for (let slot = usedSlots; slot % 7 !== 0; slot += 1) {
    const blank = rowForSlot(slot).createDiv({ cls: 'task-manager-calendar-day task-manager-calendar-day-blank' });
    blank.setAttr('role', 'gridcell');
    blank.setAttr('aria-disabled', 'true');
  }
}

function createDayCell(
  parent: HTMLElement,
  dateStr: string,
  today: string,
  dayTasks: ParsedTask[],
  allTasks: ParsedTask[],
  isBlank: boolean,
  onEdit: (task: ParsedTask) => void,
  onCreate: ((date?: string) => void) | undefined,
  onReschedule: ((task: ParsedTask, field: 'scheduled' | 'due', newDate: string) => Promise<void>) | undefined,
  closePopover: (() => void) | undefined,
  setPopover: ((el: HTMLElement) => void) | undefined,
  futureDayTasks: ParsedTask[] = [],
  icsEvents: CalendarIcsEvent[] = [],
): HTMLElement {
  const container = parent as HTMLElement & { childElementCount?: number; lastElementChild?: HTMLElement | null };
  const before = container.childElementCount ?? container.children.length;
  renderDayCell(parent, dateStr, today, dayTasks, allTasks, isBlank, onEdit, onCreate, onReschedule, closePopover, setPopover, futureDayTasks, icsEvents);
  return (container.children[before] ?? container.lastElementChild) as HTMLElement;
}

function renderWeekGrid(
  el: HTMLElement,
  weekStart: string,
  today: string,
  dayMap: Map<string, ParsedTask[]>,
  futureDayMap: Map<string, ParsedTask[]>,
  icsDayMap: Map<string, CalendarIcsEvent[]>,
  allTasks: ParsedTask[],
  onEdit: (task: ParsedTask) => void,
  onCreate: ((date?: string) => void) | undefined,
  onReschedule: ((task: ParsedTask, field: 'scheduled' | 'due', newDate: string) => Promise<void>) | undefined,
  closePopover: () => void,
  setPopover: (el: HTMLElement) => void,
): void {
  const grid = el.createDiv({ cls: 'task-manager-calendar-grid task-manager-calendar-grid-week' });
  const DAY_NAMES = calendarDayNames();
  for (let i = 0; i < 7; i++) {
    const dateStr = addDays(weekStart, i);
    const dow = new Date(Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10))).getUTCDay();
    const hdr = grid.createDiv({ cls: 'task-manager-calendar-day-header' });
    hdr.createEl('span', { text: DAY_NAMES[dow] });
    hdr.createEl('span', { text: dateStr.slice(8), cls: 'task-manager-calendar-week-daynum' });
    renderDayCell(grid, dateStr, today, dayMap.get(dateStr) ?? [], allTasks, false, onEdit, onCreate, onReschedule, closePopover, setPopover, futureDayMap.get(dateStr) ?? [], icsDayMap.get(dateStr) ?? []);
  }
}

function renderMultiDayGrid(
  el: HTMLElement,
  startDate: string,
  dayCount: number,
  today: string,
  dayMap: Map<string, ParsedTask[]>,
  futureDayMap: Map<string, ParsedTask[]>,
  icsDayMap: Map<string, CalendarIcsEvent[]>,
  allTasks: ParsedTask[],
  onEdit: (task: ParsedTask) => void,
  onCreate: ((date?: string) => void) | undefined,
  onReschedule: ((task: ParsedTask, field: 'scheduled' | 'due', newDate: string) => Promise<void>) | undefined,
  closePopover: () => void,
  setPopover: (el: HTMLElement) => void,
): void {
  const grid = el.createDiv({ cls: 'task-manager-calendar-grid task-manager-calendar-grid-multiday' });
  grid.style.gridTemplateColumns = `repeat(${dayCount}, minmax(0, 1fr))`;
  const DAY_NAMES = calendarDayNames();
  for (let i = 0; i < dayCount; i += 1) {
    const dateStr = addDays(startDate, i);
    const col = grid.createDiv({ cls: 'task-manager-calendar-multiday-column' });
    const dow = new Date(Date.UTC(+dateStr.slice(0, 4), +dateStr.slice(5, 7) - 1, +dateStr.slice(8, 10))).getUTCDay();
    const hdr = col.createDiv({ cls: 'task-manager-calendar-day-header' });
    hdr.createEl('span', { text: DAY_NAMES[dow] });
    hdr.createEl('span', { text: dateStr.slice(8), cls: 'task-manager-calendar-week-daynum' });
    renderDayCell(col, dateStr, today, dayMap.get(dateStr) ?? [], allTasks, false, onEdit, onCreate, onReschedule, closePopover, setPopover, futureDayMap.get(dateStr) ?? [], icsDayMap.get(dateStr) ?? []);
  }
}

function renderAgendaView(
  el: HTMLElement,
  weekStart: string,
  dayMap: Map<string, ParsedTask[]>,
  futureDayMap: Map<string, ParsedTask[]>,
  icsDayMap: Map<string, CalendarIcsEvent[]>,
  onEdit: (task: ParsedTask) => void,
): void {
  const agenda = el.createDiv({ cls: 'task-manager-calendar-agenda-view' });
  for (let i = 0; i < 7; i += 1) {
    const dateStr = addDays(weekStart, i);
    const dayTasks = [...(dayMap.get(dateStr) ?? []), ...(futureDayMap.get(dateStr) ?? [])];
    const events = icsDayMap.get(dateStr) ?? [];
    const day = agenda.createDiv({ cls: 'task-manager-calendar-agenda-day' });
    day.createEl('h4', { text: `${formatShort(dateStr)} · ${dayTasks.length} tasks · ${events.length} events`, cls: 'task-manager-calendar-agenda-date' });
    if (dayTasks.length === 0 && events.length === 0) {
      day.createDiv({ text: 'No scheduled work', cls: 'task-manager-calendar-agenda-empty' });
      continue;
    }
    for (const event of events) {
      day.createDiv({ text: `${event.startTime ? `${event.startTime} ` : ''}${event.summary}`, cls: 'task-manager-calendar-agenda-row task-manager-calendar-ics-event' });
    }
    for (const task of dayTasks) {
      const row = day.createDiv({ cls: `task-manager-calendar-agenda-row${futureDayMap.get(dateStr)?.includes(task) ? ' is-future' : ''}` });
      row.createEl('span', { text: task.status === 'done' ? '☑' : '☐', cls: 'task-manager-calendar-list-status' });
      createCalendarEditButton(row, task, 'task-manager-calendar-agenda-text', onEdit);
      row.createEl('span', { text: task.metadata.priority !== 'normal' ? task.metadata.priority : '', cls: 'task-manager-calendar-agenda-priority' });
    }
  }
}

function renderUnscheduledPanel(
  el: HTMLElement,
  tasks: ParsedTask[],
  onEdit: (task: ParsedTask) => void,
  onCreate?: (date?: string) => void,
): void {
  const unscheduled = tasks.filter((task) => !task.metadata.dates.due && !task.metadata.dates.scheduled && !task.metadata.dates.start && task.status !== 'done' && task.status !== 'cancelled');
  if (unscheduled.length === 0) return;
  const panel = el.createDiv({ cls: 'task-manager-calendar-unscheduled-panel' });
  const header = panel.createDiv({ cls: 'task-manager-calendar-unscheduled-header' });
  header.createEl('span', { text: `Unscheduled (${unscheduled.length})` });
  if (onCreate) {
    const add = header.createEl('button', { text: '+', cls: 'task-manager-calendar-unscheduled-add' });
    add.setAttr('type', 'button');
    add.setAttr('aria-label', 'Add unscheduled task');
    add.addEventListener('click', () => onCreate());
  }
  const searchId = `task-manager-calendar-unscheduled-${calendarViewSequence++}`;
  const searchLabel = panel.createEl('label', { text: 'Filter unscheduled tasks', cls: 'task-manager-sr-only' });
  searchLabel.htmlFor = searchId;
  const search = panel.createEl('input', { type: 'search', cls: 'task-manager-calendar-unscheduled-search', placeholder: 'Filter unscheduled...' });
  search.id = searchId;
  const list = panel.createDiv({ cls: 'task-manager-calendar-unscheduled-list' });
  let visibleLimit = 25;
  const render = (): void => {
    list.empty();
    const q = search.value.trim().toLowerCase();
    const matches = unscheduled.filter((task) => !q || `${task.normalizedText} ${task.filePath} ${task.tags.join(' ')}`.toLowerCase().includes(q));
    for (const task of matches.slice(0, visibleLimit)) {
      const row = list.createDiv({ cls: 'task-manager-calendar-unscheduled-row' });
      row.createEl('span', { text: task.metadata.priority !== 'normal' ? '!' : '', cls: 'task-manager-calendar-unscheduled-priority' });
      createCalendarEditButton(row, task, 'task-manager-calendar-unscheduled-text', onEdit);
    }
    if (matches.length > visibleLimit) {
      const showAll = list.createEl('button', { text: `Show ${matches.length - visibleLimit} more`, cls: 'task-manager-calendar-unscheduled-more' });
      showAll.setAttr('type', 'button');
      showAll.addEventListener('click', () => { visibleLimit = Math.min(matches.length, visibleLimit + 25); render(); });
    }
  };
  search.addEventListener('input', () => { visibleLimit = 25; render(); });
  render();
}

function renderDayView(
  el: HTMLElement,
  dateStr: string,
  today: string,
  dayMap: Map<string, ParsedTask[]>,
  futureDayMap: Map<string, ParsedTask[]>,
  icsDayMap: Map<string, CalendarIcsEvent[]>,
  allTasks: ParsedTask[],
  onEdit: (task: ParsedTask) => void,
  onCreate: ((date?: string) => void) | undefined,
  onReschedule: ((task: ParsedTask, field: 'scheduled' | 'due', newDate: string) => Promise<void>) | undefined,
  closePopover: () => void,
  setPopover: (el: HTMLElement) => void,
): void {
  const grid = el.createDiv({ cls: 'task-manager-calendar-grid task-manager-calendar-grid-day' });
  const hdr = grid.createDiv({ cls: 'task-manager-calendar-day-header' });
  hdr.createEl('span', { text: new Date(`${dateStr}T00:00:00Z`).toLocaleDateString(getLocale(), { weekday: 'long', timeZone: 'UTC' }) });
  hdr.createEl('span', { text: dateStr, cls: 'task-manager-calendar-week-daynum' });
  renderDayCell(grid, dateStr, today, dayMap.get(dateStr) ?? [], allTasks, false, onEdit, onCreate, onReschedule, closePopover, setPopover, futureDayMap.get(dateStr) ?? [], icsDayMap.get(dateStr) ?? []);
}

function renderListView(
  el: HTMLElement,
  weekStart: string,
  dayMap: Map<string, ParsedTask[]>,
  futureDayMap: Map<string, ParsedTask[]>,
  icsDayMap: Map<string, CalendarIcsEvent[]>,
  onEdit: (task: ParsedTask) => void,
): void {
  const list = el.createDiv({ cls: 'task-manager-calendar-list-view' });
  for (let i = 0; i < 7; i++) {
    const dateStr = addDays(weekStart, i);
    const dayTasks = [...(dayMap.get(dateStr) ?? []), ...(futureDayMap.get(dateStr) ?? [])];
    const icsForDay = icsDayMap.get(dateStr) ?? [];
    if (dayTasks.length === 0 && icsForDay.length === 0) continue;
    const group = list.createDiv({ cls: 'task-manager-calendar-list-day' });
    group.createEl('h4', { text: `${formatShort(dateStr)} (${dayTasks.length} tasks, ${icsForDay.length} events)`, cls: 'task-manager-calendar-list-date' });
    for (const event of icsForDay) {
      const row = group.createDiv({ cls: 'task-manager-calendar-list-row task-manager-calendar-ics-event' });
      row.createEl('span', { text: '◦', cls: 'task-manager-calendar-list-status' });
      row.createEl('span', { text: `${event.startTime ? `${event.startTime} ` : ''}${event.summary}`, cls: 'task-manager-calendar-list-text' });
      row.createEl('span', { text: 'ICS', cls: 'task-manager-calendar-list-source' });
    }
    for (const task of dayTasks) {
      const row = group.createDiv({ cls: `task-manager-calendar-list-row${futureDayMap.get(dateStr)?.includes(task) ? ' is-future' : ''}` });
      row.createEl('span', { text: task.status === 'done' ? '☑' : '☐', cls: 'task-manager-calendar-list-status' });
      createCalendarEditButton(row, task, 'task-manager-calendar-list-text', onEdit);
      row.createEl('span', { text: task.filePath, cls: 'task-manager-calendar-list-source' });
    }
  }
  if (list.childElementCount === 0) {
    list.createDiv({ text: 'No dated tasks in this week.', cls: 'task-manager-calendar-empty' });
  }
}

export function buildIcsDayMap(events: CalendarIcsEvent[]): Map<string, CalendarIcsEvent[]> {
  const map = new Map<string, CalendarIcsEvent[]>();
  for (const event of events) {
    if (!event.date) continue;
    const key = event.date.slice(0, 10);
    const list = map.get(key);
    if (list) list.push(event);
    else map.set(key, [event]);
  }
  return map;
}

function shiftMonth(dateStr: string, months: number): string { return addIsoMonths(dateStr, months); }

function getWeekStart(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  const dow = date.getUTCDay();
  date.setUTCDate(date.getUTCDate() - dow);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function calendarDayNames(): string[] {
  return Array.from({ length: 7 }, (_, index) => new Date(Date.UTC(2023, 0, index + 1)).toLocaleDateString(getLocale(), { weekday: 'short', timeZone: 'UTC' }));
}

function formatShort(dateStr: string): string {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d)).toLocaleDateString(getLocale(), { month: 'short', day: 'numeric', timeZone: 'UTC' });
}

function isoWeekNumber(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  return Math.ceil((((date.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}
