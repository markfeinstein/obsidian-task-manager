import type { Component } from 'obsidian';
import type { TaskManagerSettings } from './types';
import type { ParsedTask } from './task-scanner';
import type { TaskQuery } from './task-query';
import type { StateStore } from './state-store';
import type { PersistedState } from './state-store';
import { t } from './i18n';

/**
 * TASK-17: Time-blocking timeline view (hourly day planner)
 *
 * Renders a 24-hour timeline with tasks positioned by HH:MM - HH:MM time ranges.
 * Features:
 * - Hourly grid from 6:00 to 24:00
 * - Tasks with time metadata rendered as blocks
 * - Drag-to-reschedule time blocks
 * - Color-coding by priority
 * - Unscheduled tasks list below
 */

const HOUR_HEIGHT_PX = 40;
const GRID_WIDTH_PX = 600;

interface TimelineTimeRange {
  startHour: number;
  startMin: number;
  endHour?: number;
  endMin?: number;
}

/**
 * Parse a timeline time/range and reject values outside the visible grid.
 * Invalid or non-forward end times are ignored so a bad suffix cannot produce
 * NaN/negative CSS heights while the valid start time still renders normally.
 */
export function parseTimelineTimeRange(value: string | undefined): TimelineTimeRange | null {
  const timeMatch = value?.match(/(\d{1,2}):(\d{2})(?:\s*-\s*(\d{1,2}):(\d{2}))?/u);
  if (!timeMatch) return null;

  const startHour = Number.parseInt(timeMatch[1], 10);
  const startMin = Number.parseInt(timeMatch[2], 10);
  if (startHour < 6 || startHour >= 24 || startMin < 0 || startMin >= 60) return null;

  const range: TimelineTimeRange = { startHour, startMin };
  if (timeMatch[3] !== undefined && timeMatch[4] !== undefined) {
    const endHour = Number.parseInt(timeMatch[3], 10);
    const endMin = Number.parseInt(timeMatch[4], 10);
    const startTotal = startHour * 60 + startMin;
    const endTotal = endHour * 60 + endMin;
    if (endHour >= 0 && endHour < 24 && endMin >= 0 && endMin < 60 && endTotal > startTotal) {
      range.endHour = endHour;
      range.endMin = endMin;
    }
  }

  return range;
}

export function shiftTimelineTime(hour: number, minute: number, deltaMinutes: number): string | null {
  const total = hour * 60 + minute + deltaMinutes;
  if (total < 6 * 60 || total > 23 * 60 + 59) return null;
  return `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
}

/** Pointer drags must never begin from a nested interactive control. */
export function isInteractiveTimelineDragTarget(target: EventTarget | null, block: HTMLElement): boolean {
  if (!target || target === block) return false;
  const closest = (target as { closest?: (selector: string) => unknown }).closest;
  return typeof closest === 'function' && Boolean(closest.call(target, 'button, input, label, a, [role="button"]'));
}

export function timelinePointerCrossedThreshold(startClientY: number, clientY: number, thresholdPx = 4): boolean {
  return Math.abs(clientY - startClientY) >= thresholdPx;
}

export function timelinePointerPosition(clientY: number, gridTop: number): { minutes: number; value: string; top: number } {
  const relativeY = Math.max(0, clientY - gridTop);
  const offsetMinutes = Math.max(0, Math.min(18 * 60 - 1, Math.round(relativeY / HOUR_HEIGHT_PX * 60)));
  return {
    minutes: 6 * 60 + offsetMinutes,
    value: `${String(6 + Math.floor(offsetMinutes / 60)).padStart(2, '0')}:${String(offsetMinutes % 60).padStart(2, '0')}`,
    top: Math.max(0, Math.min(((18 * 60 - 1) / 60) * HOUR_HEIGHT_PX, relativeY)),
  };
}

export function timelinePointerDropValue(clientY: number, gridTop: number, originalMinutes: number): string | null {
  const position = timelinePointerPosition(clientY, gridTop);
  return position.minutes === originalMinutes ? null : position.value;
}

export function restoreTimelineBlockPosition(block: Pick<HTMLElement, 'style'>, originalTop: string): void {
  block.style.setProperty('--timeline-block-top', originalTop);
}

export function renderTimeline(
  el: HTMLElement,
  tasks: ParsedTask[],
  _query: TaskQuery,
  settings: TaskManagerSettings,
  onToggle: (task: ParsedTask) => Promise<void>,
  onEdit: (task: ParsedTask) => void,
  onReschedule?: (task: ParsedTask, field: 'scheduled' | 'due' | 'timeStart', newDate: string) => Promise<void>,
  stateStore?: StateStore,
  persistedState?: PersistedState,
  onClockInOut?: (task: ParsedTask, isClockingIn: boolean) => Promise<void>,
  icsEvents?: Array<{ summary: string; date: string | null; startTime?: string; endTime?: string; uid: string | null }>,
  component?: Component,
): void {
  el.empty();
  el.addClass('task-manager-timeline');
  const liveRegion = el.createDiv('task-manager-sr-only');
  liveRegion.setAttr('role', 'status');
  liveRegion.setAttr('aria-live', 'polite');

  // Parse task times and extract scheduled time metadata
  interface TimeBlockTask extends TimelineTimeRange {
    task: ParsedTask;
  }

  const timeBlockTasks: TimeBlockTask[] = [];
  const unscheduledTasks: ParsedTask[] = [];

  for (const task of tasks) {
    if (task.status === 'done' || task.status === 'cancelled') continue;

    // Prefer structured time metadata; fall back to legacy text matching.
    // Format: "HH:MM - HH:MM" or just "HH:MM".
    const structuredTime = task.metadata.timeStart
      ? `${task.metadata.timeStart}${task.metadata.timeEnd ? `-${task.metadata.timeEnd}` : ''}`
      : '';
    const timeRange = parseTimelineTimeRange(structuredTime || task.normalizedText);
    if (timeRange) {
      timeBlockTasks.push({
        task,
        ...timeRange,
      });
      continue;
    }

    unscheduledTasks.push(task);
  }

  // Sort time blocks by start time
  timeBlockTasks.sort((a, b) => {
    const aStart = (a.startHour ?? 0) * 60 + (a.startMin ?? 0);
    const bStart = (b.startHour ?? 0) * 60 + (b.startMin ?? 0);
    return aStart - bStart;
  });

  // Render toolbar
  const toolbar = el.createDiv({ cls: 'task-manager-timeline-toolbar' });
  toolbar.createEl('span', {
    text: '⏰ Daily Timeline',
    cls: 'task-manager-timeline-title',
  });

  // Render timeline grid
  const gridContainer = el.createDiv({ cls: 'task-manager-timeline-grid-container' });

  const grid = gridContainer.createDiv({ cls: 'task-manager-timeline-grid' });
  grid.style.setProperty('--timeline-width', `${GRID_WIDTH_PX}px`);
  grid.style.setProperty('--timeline-min-height', `${24 * HOUR_HEIGHT_PX}px`);

  // Render hour markers and gridlines
  for (let hour = 6; hour < 24; hour++) {
    const row = grid.createDiv({ cls: 'task-manager-timeline-hour-row' });
    row.style.setProperty('--timeline-row-top', `${(hour - 6) * HOUR_HEIGHT_PX}px`);
    row.style.setProperty('--timeline-row-height', `${HOUR_HEIGHT_PX}px`);

    row.createEl('span', {
      text: `${String(hour).padStart(2, '0')}:00`,
      cls: 'task-manager-timeline-hour-label',
    });

  }

  // Render ICS events as semi-transparent overlays
  if (icsEvents && icsEvents.length > 0) {
    for (const event of icsEvents) {
      if (!event.startTime) continue; // Skip events without time
      const eventRange = parseTimelineTimeRange(event.endTime ? `${event.startTime} - ${event.endTime}` : event.startTime);
      if (!eventRange) continue;
      const { startHour, startMin } = eventRange;
      const endHour = eventRange.endHour ?? startHour + 1;
      const endMin = eventRange.endMin ?? startMin;
      
      const startPx = (startHour - 6) * HOUR_HEIGHT_PX + (startMin / 60) * HOUR_HEIGHT_PX;
      const durationHours = (endHour + endMin / 60) - (startHour + startMin / 60);
      const heightPx = Math.max(HOUR_HEIGHT_PX / 2, durationHours * HOUR_HEIGHT_PX);
      
      const icsBlock = grid.createDiv({ cls: 'task-manager-timeline-ics-block' });
      icsBlock.style.setProperty('--timeline-block-top', `${startPx}px`);
      icsBlock.style.setProperty('--timeline-block-height', `${heightPx}px`);
      icsBlock.textContent = event.summary;
      icsBlock.title = `${event.summary} (${event.startTime}${event.endTime ? ` - ${event.endTime}` : ''})`;
    }
  }

  // Get current clock-in state
  const clockInState = persistedState && stateStore ? stateStore.getClockInState(persistedState) : null;

  // Render time blocks. Pointer state is global to this rendered timeline so
  // only one task can be dragged and every document listener has one owner.
  let draggedBlock: {
    task: TimeBlockTask;
    originalBlock: HTMLElement;
    pointerId: number;
    startClientY: number;
    active: boolean;
    originalMinutes: number;
    originalTop: string;
  } | null = null;
  let dragController: AbortController | null = null;
  const DRAG_THRESHOLD_PX = 4;

  const stopDragListeners = (): void => {
    dragController?.abort();
    dragController = null;
  };
  const releasePointer = (): void => {
    if (!draggedBlock) return;
    const block = draggedBlock.originalBlock as HTMLElement & { releasePointerCapture?: (id: number) => void };
    try { block.releasePointerCapture?.(draggedBlock.pointerId); } catch { /* capture may already be released */ }
  };
  const timelineTimeAt = (clientY: number): { minutes: number; value: string; top: number } =>
    timelinePointerPosition(clientY, grid.getBoundingClientRect().top);
  const onPointerMove = (event: PointerEvent): void => {
    if (!draggedBlock || event.pointerId !== draggedBlock.pointerId) return;
    if (!draggedBlock.active && !timelinePointerCrossedThreshold(draggedBlock.startClientY, event.clientY, DRAG_THRESHOLD_PX)) return;
    if (!draggedBlock.active) {
      draggedBlock.active = true;
      draggedBlock.originalBlock.addClass('task-manager-timeline-block-dragging');
    }
    event.preventDefault();
    draggedBlock.originalBlock.style.setProperty('--timeline-block-top', `${timelineTimeAt(event.clientY).top}px`);
  };
  const onPointerUp = (event: PointerEvent): void => {
    if (!draggedBlock || event.pointerId !== draggedBlock.pointerId) return;
    const current = draggedBlock;
    current.originalBlock.removeClass('task-manager-timeline-block-dragging');
    releasePointer();
    draggedBlock = null;
    stopDragListeners();
    if (!current.active || !onReschedule) return;
    const nextValue = timelinePointerDropValue(event.clientY, grid.getBoundingClientRect().top, current.originalMinutes);
    if (!nextValue) {
      restoreTimelineBlockPosition(current.originalBlock, current.originalTop);
      return;
    }
    void onReschedule(current.task.task, 'timeStart', nextValue).catch(() => {
      restoreTimelineBlockPosition(current.originalBlock, current.originalTop);
    });
  };
  const onDragCancel = (): void => {
    if (draggedBlock) {
      draggedBlock.originalBlock.removeClass('task-manager-timeline-block-dragging');
      restoreTimelineBlockPosition(draggedBlock.originalBlock, draggedBlock.originalTop);
    }
    releasePointer();
    draggedBlock = null;
    stopDragListeners();
  };
  const startDragListeners = (): void => {
    stopDragListeners();
    dragController = new AbortController();
    document.addEventListener('pointermove', onPointerMove, { signal: dragController.signal });
    document.addEventListener('pointerup', onPointerUp, { signal: dragController.signal });
    document.addEventListener('pointercancel', onDragCancel, { signal: dragController.signal });
    window.addEventListener('blur', onDragCancel, { signal: dragController.signal });
  };

  if (component && onReschedule) component.register(onDragCancel);

  for (const timeBlock of timeBlockTasks) {
    const startPx = ((timeBlock.startHour ?? 0) - 6) * HOUR_HEIGHT_PX + ((timeBlock.startMin ?? 0) / 60) * HOUR_HEIGHT_PX;
    const durationHours = timeBlock.endHour !== undefined ?
      ((timeBlock.endHour + (timeBlock.endMin ?? 0) / 60) - ((timeBlock.startHour ?? 0) + (timeBlock.startMin ?? 0) / 60)) :
      1;
    const heightPx = Math.max(HOUR_HEIGHT_PX / 2, durationHours * HOUR_HEIGHT_PX);

    const block = grid.createDiv({ cls: 'task-manager-timeline-block' });
    block.style.setProperty('--timeline-block-top', `${startPx}px`);
    block.style.setProperty('--timeline-block-height', `${heightPx}px`);

    // Color by priority
    const priorityColor = ({
      highest: 'var(--color-red)',
      high: 'var(--color-orange)',
      medium: 'var(--color-yellow)',
      low: 'var(--color-blue)',
      lowest: 'var(--color-cyan)',
    } as Record<string, string>)[timeBlock.task.metadata.priority ?? 'normal'] ?? 'var(--color-blue)';

    block.style.setProperty('--timeline-block-color', priorityColor);

    // Task checkbox + text
    const checkboxHit = block.createEl('label', { cls: 'task-manager-timeline-checkbox-hit' });
    const checkbox = checkboxHit.createEl('input', {
      type: 'checkbox',
      cls: 'task-manager-timeline-block-cb',
    });
    checkbox.checked = timeBlock.task.status === 'done';
    checkbox.setAttr('aria-label', `${timeBlock.task.status === 'done' ? 'Mark incomplete' : 'Complete'} ${timeBlock.task.normalizedText}`);

    checkbox.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void onToggle(timeBlock.task);
    });

    const label = block.createEl('button', {
      text: `${String(timeBlock.startHour).padStart(2, '0')}:${String(timeBlock.startMin ?? 0).padStart(2, '0')} ${timeBlock.task.normalizedText.slice(0, 30)}`,
      cls: 'task-manager-timeline-block-label',
    });

    label.setAttr('type', 'button');
    label.setAttr('aria-label', `Edit ${timeBlock.task.normalizedText}${onReschedule ? '. Use Alt plus Up or Down Arrow to move by 15 minutes' : ''}`);
    if (onReschedule) label.setAttr('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');
    label.addEventListener('click', () => onEdit(timeBlock.task));
    let keyboardTime = timeBlock.startHour * 60 + timeBlock.startMin;
    let keyboardMovePending = false;
    if (onReschedule) {
      const timeInput = block.createEl('input', { type: 'time', cls: 'task-manager-timeline-reschedule-input' });
      timeInput.step = '900';
      timeInput.value = `${String(timeBlock.startHour).padStart(2, '0')}:${String(timeBlock.startMin).padStart(2, '0')}`;
      timeInput.setAttr('aria-label', t('timeline.reschedule', { task: timeBlock.task.normalizedText }));
      timeInput.addEventListener('change', () => {
        const nextTime = timeInput.value;
        if (!/^\d{2}:\d{2}$/u.test(nextTime) || keyboardMovePending) return;
        const previousTime = keyboardTime;
        keyboardMovePending = true;
        void onReschedule(timeBlock.task, 'timeStart', nextTime)
          .then(() => {
            keyboardTime = Number(nextTime.slice(0, 2)) * 60 + Number(nextTime.slice(3, 5));
            liveRegion.setText(`${timeBlock.task.normalizedText} moved to ${nextTime}`);
          })
          .catch((error: unknown) => {
            timeInput.value = `${String(Math.floor(previousTime / 60)).padStart(2, '0')}:${String(previousTime % 60).padStart(2, '0')}`;
            liveRegion.setText(`Could not move ${timeBlock.task.normalizedText}: ${error instanceof Error ? error.message : String(error)}`);
          })
          .finally(() => { keyboardMovePending = false; });
      });
    }
    label.addEventListener('keydown', (event: KeyboardEvent) => {
      if (!onReschedule || !event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault();
      if (keyboardMovePending) return;
      const currentHour = Math.floor(keyboardTime / 60);
      const currentMinute = keyboardTime % 60;
      const nextTime = shiftTimelineTime(currentHour, currentMinute, event.key === 'ArrowDown' ? 15 : -15);
      if (!nextTime) { liveRegion.setText('The task is already at the edge of the timeline.'); return; }
      const previousTime = keyboardTime;
      keyboardTime = Number(nextTime.slice(0, 2)) * 60 + Number(nextTime.slice(3, 5));
      keyboardMovePending = true;
      void onReschedule(timeBlock.task, 'timeStart', nextTime)
        .then(() => liveRegion.setText(`${timeBlock.task.normalizedText} moved to ${nextTime}`))
        .catch((error: unknown) => {
          keyboardTime = previousTime;
          liveRegion.setText(`Could not move ${timeBlock.task.normalizedText}: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => { keyboardMovePending = false; });
    });

    // Clock-in/out button and elapsed time display
    if (onClockInOut) {
      const isClocked = clockInState && clockInState.taskKey === timeBlock.task.key;
      const clockButton = block.createEl('button', {
        text: isClocked ? '⏸' : '▶',
        cls: 'task-manager-timeline-clock-btn',
      });
      if (isClocked) clockButton.addClass('task-manager-timeline-clock-btn-active');
      clockButton.setAttr('type', 'button');
      clockButton.setAttr('aria-label', `${isClocked ? 'Clock out of' : 'Clock into'} ${timeBlock.task.normalizedText}`);
      clockButton.setAttr('aria-pressed', String(Boolean(isClocked)));
      clockButton.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        void onClockInOut(timeBlock.task, !isClocked);
      });
      
      // Display elapsed time if clocked in
      if (isClocked) {
        const elapsed = Math.floor((Date.now() - Date.parse(clockInState.clockInTimeIso)) / (1000 * 60));
        block.createEl('span', {
          text: ` (${elapsed}m)`,
          cls: 'task-manager-timeline-elapsed',
        });

      }
    }

    // Drag-to-reschedule
    if (onReschedule) {
      block.addClass('task-manager-timeline-block-draggable');
      block.addEventListener('pointerdown', (event: PointerEvent) => {
        if (event.button !== 0 || isInteractiveTimelineDragTarget(event.target, block)) return;
        const pointerBlock = block as HTMLElement & { setPointerCapture?: (id: number) => void };
        try { pointerBlock.setPointerCapture?.(event.pointerId); } catch { /* document listeners remain the fallback */ }
        draggedBlock = {
          task: timeBlock,
          originalBlock: block,
          pointerId: event.pointerId,
          startClientY: event.clientY,
          active: false,
          originalMinutes: timeBlock.startHour * 60 + timeBlock.startMin,
          originalTop: `${startPx}px`,
        };
        startDragListeners();
      });
    }
  }

  // Render unscheduled tasks section
  if (unscheduledTasks.length > 0) {
    const unscheduledSection = el.createDiv({ cls: 'task-manager-timeline-unscheduled' });
    unscheduledSection.createEl('h4', {
      text: `Unscheduled (${unscheduledTasks.length})`,
      cls: 'task-manager-timeline-unscheduled-title',
    });

    const list = unscheduledSection.createEl('ul', { cls: 'task-manager-timeline-unscheduled-list' });
    for (const task of unscheduledTasks.slice(0, 5)) {
      const li = list.createEl('li', { cls: 'task-manager-timeline-unscheduled-item' });

      const checkbox = li.createEl('input', { type: 'checkbox' });
      checkbox.checked = task.status === 'done';
      checkbox.setAttr('aria-label', t(task.status === 'done' ? 'task.action.markIncomplete' : 'task.action.markComplete', { task: task.normalizedText }));
      checkbox.addEventListener('click', (e) => {
        e.preventDefault();
        void onToggle(task);
      });

      const text = li.createEl('button', { text: task.normalizedText, cls: 'task-manager-timeline-unscheduled-edit' });
      text.setAttr('type', 'button');
      text.setAttr('aria-label', `Edit ${task.normalizedText}`);
      text.addEventListener('click', () => onEdit(task));
    }

    if (unscheduledTasks.length > 5) {
      list.createEl('li', {
        text: `+${unscheduledTasks.length - 5} more`,
        cls: 'task-manager-timeline-unscheduled-more',
      });
    }
  }
}

