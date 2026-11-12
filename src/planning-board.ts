/**
 * Interactive Planning Board with Time-Scoped Tabs and Drag-to-Schedule
 *
 * Provides a visual planning interface with:
 * - Time-scoped tabs (Today, Week, Month, Completed, Unscheduled)
 * - Drag-to-schedule between time slots
 * - Parent-child task nesting with expand/collapse
 * - Estimate totals per column
 * - Undo stack for last 10 drag operations
 * - Mobile-responsive layout
 */

import { parseEffortMinutesForFilter } from './duration-utils';
import type { ParsedTask } from './task-scanner';
import type { TaskManagerSettings } from './types';
import { addIsoDays as addDays } from './iso-date';
import { t } from './i18n';

export type PlanningBoardTab = 'today' | 'week' | 'month' | 'completed' | 'unscheduled';
export type PlanningBoardDateField = 'scheduled' | 'due';

export interface PlanningBoardScheduleTarget {
  tab: Exclude<PlanningBoardTab, 'completed'>;
  /** ISO date to write. Null clears the active planning field for the unscheduled target. */
  date: string | null;
  field: PlanningBoardDateField;
}

export interface PlanningBoardSchedulePlan {
  operation: DragOperation;
  updates: Array<{ field: PlanningBoardDateField; value: string | null }>;
  label: string;
}

/**
 * Represents a drag operation for undo/redo
 */
export interface DragOperation {
  taskKey: string;
  fromScheduled: string | null;
  fromDue: string | null;
  toScheduled: string | null;
  toDue: string | null;
  timestamp: number;
}

/**
 * Planning board configuration and state
 */
let planningBoardSequence = 0;

export interface PlanningBoardConfig {
  settings: TaskManagerSettings;
  todayDate: string; // ISO date string
  timeSlots?: string[]; // HH:MM formatted time slots
  enableDragDrop?: boolean;
  maxUndoStack?: number;
  /** Accessible description of what activating a task card does in this host. */
  primaryActionDescription?: string;
}

export type PlanningBoardTaskUpdate = (
  task: ParsedTask,
  field: PlanningBoardDateField,
  value: string | null,
) => ParsedTask | boolean | void | Promise<ParsedTask | boolean | void>;

/**
 * A card representation in the planning board
 */
export interface PlanningCard {
  task: ParsedTask;
  isExpanded: boolean;
  children: PlanningCard[];
  parentKey?: string;
}

export function planningBoardTargetForTab(tab: PlanningBoardTab, todayDate: string): PlanningBoardScheduleTarget | null {
  switch (tab) {
    case 'today':
      return { tab, date: todayDate, field: 'scheduled' };
    case 'week':
      return { tab, date: addDays(todayDate, 1), field: 'scheduled' };
    case 'month':
      return { tab, date: addDays(todayDate, 8), field: 'scheduled' };
    case 'unscheduled':
      return { tab, date: null, field: 'scheduled' };
    case 'completed':
      return null;
    default:
      return null;
  }
}

export function planPlanningBoardSchedule(
  task: ParsedTask,
  target: PlanningBoardScheduleTarget,
  nowMs = Date.now(),
): PlanningBoardSchedulePlan {
  const fromScheduled = task.metadata?.dates?.scheduled ?? null;
  const fromDue = task.metadata?.dates?.due ?? null;
  const updates = target.date === null
    ? [{ field: fromScheduled ? 'scheduled' as const : 'due' as const, value: null }]
    : [{ field: target.field, value: target.date }];

  return {
    operation: {
      taskKey: task.key,
      fromScheduled,
      fromDue,
      toScheduled: target.date === null && fromScheduled ? null : target.field === 'scheduled' ? target.date : fromScheduled,
      toDue: target.date === null && !fromScheduled ? null : target.field === 'due' ? target.date : fromDue,
      timestamp: nowMs,
    },
    updates,
    label: target.date === null ? 'Unscheduled' : `${target.field} ${target.date}`,
  };
}

/**
 * Main Planning Board class
 */
export class PlanningBoard {
  private config: PlanningBoardConfig;
  private dragStack: DragOperation[] = [];
  private expandedTasks = new Set<string>();
  private maxUndoStack: number;
  private parentChildMap = new Map<string, string[]>(); // Maps parent key to child keys

  constructor(config: PlanningBoardConfig) {
    this.config = config;
    this.maxUndoStack = config.maxUndoStack ?? 10;
  }

  updateConfig(config: PlanningBoardConfig): void {
    this.config = config;
    this.maxUndoStack = config.maxUndoStack ?? 10;
    if (this.dragStack.length > this.maxUndoStack) this.dragStack = this.dragStack.slice(-this.maxUndoStack);
  }

  getTasksByTab(tab: PlanningBoardTab, allTasks: ParsedTask[]): ParsedTask[] {
    const today = this.config.todayDate;
    const weekEnd = addDays(today, 7);
    const monthEnd = addDays(today, 30);

    // A task is assigned to the EARLIEST time bucket it qualifies for
    // (today > week > month) so it appears in exactly one tab while still
    // staying visible. We test each date independently: e.g. a task that is
    // due today but was scheduled in the past must still show under Today.
    const isActive = (task: ParsedTask): boolean => task.status !== 'done' && task.status !== 'cancelled';
    const inToday = (s?: string, d?: string): boolean => s === today || d === today;
    const inWeek = (s?: string, d?: string): boolean =>
      (s !== undefined && s > today && s <= weekEnd) || (d !== undefined && d > today && d <= weekEnd);
    const inMonth = (s?: string, d?: string): boolean =>
      (s !== undefined && s > weekEnd && s <= monthEnd) || (d !== undefined && d > weekEnd && d <= monthEnd);

    switch (tab) {
      case 'today': {
        return allTasks.filter(task => {
          if (!isActive(task)) return false;
          const s = task.metadata?.dates?.scheduled;
          const d = task.metadata?.dates?.due;
          return inToday(s, d);
        });
      }
      case 'week': {
        return allTasks.filter(task => {
          if (!isActive(task)) return false;
          const s = task.metadata?.dates?.scheduled;
          const d = task.metadata?.dates?.due;
          // Exclude tasks already claimed by the Today tab to avoid duplicates.
          return !inToday(s, d) && inWeek(s, d);
        });
      }
      case 'month': {
        return allTasks.filter(task => {
          if (!isActive(task)) return false;
          const s = task.metadata?.dates?.scheduled;
          const d = task.metadata?.dates?.due;
          // Exclude tasks already claimed by the Today or Week tabs.
          return !inToday(s, d) && !inWeek(s, d) && inMonth(s, d);
        });
      }
      case 'completed': {
        return allTasks.filter(task => task.status === 'done' || task.status === 'cancelled');
      }
      case 'unscheduled': {
        return allTasks.filter(task => {
          // Done and cancelled tasks belong only to the 'completed' tab.
          // Without this guard, a completed/cancelled task with no upcoming
          // dates would pass the date predicates below and show up in
          // 'unscheduled', which is intended exclusively for active tasks
          // that need to be scheduled or rescheduled.
          if (task.status === 'done' || task.status === 'cancelled') return false;
          const scheduled = task.metadata?.dates?.scheduled;
          const due = task.metadata?.dates?.due;
          // Include if every date that IS set is already in the past (task has no
          // upcoming schedule and needs to be rescheduled), or if no date is set at all.
          // A task with only a past scheduled date (and no due date) was previously
          // invisible because the old "both in past" check required BOTH to be truthy.
          const now = today;
          const scheduledPast = !scheduled || scheduled < now;
          const duePast = !due || due < now;
          return scheduledPast && duePast;
        });
      }
      default:
        return [];
    }
  }

  /**
   * Get estimate total for a set of tasks
   */
  getEstimateTotal(tasks: ParsedTask[]): number {
    return tasks.reduce((total, task) => {
      const estimate = task.metadata?.effort;
      if (typeof estimate === 'string') {
        return total + this.parseEffort(estimate);
      }
      return total;
    }, 0);
  }

  /**
   * Parse effort string (e.g., "2h 30m") to minutes
   */
  private parseEffort(effort: string): number {
    const minutes = parseEffortMinutesForFilter(effort);
    return Number.isFinite(minutes) ? minutes : 0;
  }

  /**
   * Build parent-child hierarchy
   */
  buildHierarchy(tasks: ParsedTask[]): PlanningCard[] {
    this.parentChildMap.clear();
    const tasksByKey = new Map(tasks.map(t => [t.key, t]));
    const processed = new Set<string>();

    // First pass: identify parent-child relationships by indentation
    for (const task of tasks) {
      const taskIndent = task.indentation.length;
      let parentKey: string | undefined;

      // Find parent by looking backward for a task with less indentation
      const taskIndex = tasks.indexOf(task);
      for (let i = taskIndex - 1; i >= 0; i--) {
        const candidate = tasks[i];
        if (candidate.indentation.length < taskIndent) {
          parentKey = candidate.key;
          break;
        }
      }

      if (parentKey) {
        const childKeys = this.parentChildMap.get(parentKey);
        if (childKeys) {
          childKeys.push(task.key);
        } else {
          this.parentChildMap.set(parentKey, [task.key]);
        }
      }
    }

    // Build child cards recursively so grandchildren are not dropped.
    const buildChildCards = (keys: string[], parentTaskKey: string): PlanningCard[] => {
      const result: PlanningCard[] = [];
      for (const childKey of keys) {
        const childTask = tasksByKey.get(childKey);
        if (!childTask) continue;
        processed.add(childKey);
        const grandchildKeys = this.parentChildMap.get(childKey) ?? [];
        result.push({
          task: childTask,
          isExpanded: this.expandedTasks.has(childKey),
          children: buildChildCards(grandchildKeys, childKey),
          parentKey: parentTaskKey,
        });
      }
      return result;
    };

    // Build the set of all tasks that are children of some other task so we
    // can identify true root tasks in the second pass.
    const allChildKeys = new Set<string>();
    for (const childKeys of this.parentChildMap.values()) {
      for (const k of childKeys) allChildKeys.add(k);
    }

    // Second pass: build top-level cards (root tasks only).
    const cards: PlanningCard[] = [];
    for (const task of tasks) {
      if (processed.has(task.key)) continue;
      if (allChildKeys.has(task.key)) continue; // skip – will be built recursively

      const childKeys = this.parentChildMap.get(task.key) ?? [];
      cards.push({
        task,
        isExpanded: this.expandedTasks.has(task.key),
        children: buildChildCards(childKeys, task.key),
      });
    }

    return cards;
  }

  /**
   * Toggle expand/collapse for a task
   */
  toggleExpand(taskKey: string): void {
    if (this.expandedTasks.has(taskKey)) {
      this.expandedTasks.delete(taskKey);
    } else {
      this.expandedTasks.add(taskKey);
    }
  }

  /**
   * Record a drag operation for undo support
   */
  recordDragOperation(operation: DragOperation): void {
    this.dragStack.push(operation);
    if (this.dragStack.length > this.maxUndoStack) {
      this.dragStack.shift();
    }
  }

  /**
   * Undo the last drag operation
   */
  undoLastDrag(): DragOperation | null {
    if (this.dragStack.length === 0) return null;
    return this.dragStack.pop() ?? null;
  }

  peekLastDrag(): DragOperation | null {
    return this.dragStack.at(-1) ?? null;
  }

  pruneDragHistory(taskKeys: ReadonlySet<string>): void {
    this.dragStack = this.dragStack.filter((operation) => taskKeys.has(operation.taskKey));
  }

  /**
   * Get all recorded drag operations
   */
  getDragHistory(): DragOperation[] {
    return [...this.dragStack];
  }

  /**
   * Clear drag history
   */
  clearDragHistory(): void {
    this.dragStack = [];
  }
}

/**
 * Render the planning board component into a container element
 */
export function renderPlanningBoard(
  container: HTMLElement,
  allTasks: ParsedTask[],
  config: PlanningBoardConfig,
  onTaskUpdate?: PlanningBoardTaskUpdate,
  onTaskClick?: (task: ParsedTask) => void,
  existingBoard?: PlanningBoard,
): PlanningBoard {
  const board = existingBoard ?? new PlanningBoard(config);
  board.updateConfig(config);
  board.pruneDragHistory(new Set(allTasks.map((task) => task.key)));
  const contentId = `planning-board-tab-content-${planningBoardSequence++}`;
  container.empty();
  container.addClass('planning-board-container');

  // Create tab navigation
  const tabNav = container.createDiv('planning-board-tabs');
  tabNav.setAttr('role', 'tablist');
  tabNav.setAttr('aria-label', 'Planning range');
  const tabs: PlanningBoardTab[] = ['today', 'week', 'month', 'completed', 'unscheduled'];
  let activeTab: PlanningBoardTab = 'today';

  const tabButtons = new Map<PlanningBoardTab, HTMLElement>();

  for (const tab of tabs) {
    const btn = tabNav.createEl('button', {
      cls: 'planning-board-tab-btn',
      text: tab.charAt(0).toUpperCase() + tab.slice(1),
    });
    btn.dataset.tab = tab;
    btn.id = `${contentId}-tab-${tab}`;
    btn.setAttr('role', 'tab');
    btn.setAttr('aria-controls', contentId);
    btn.setAttr('aria-selected', String(tab === activeTab));
    btn.tabIndex = tab === activeTab ? 0 : -1;
    if (tab === activeTab) btn.classList.add('is-active');

    btn.addEventListener('click', () => {
      activeTab = tab;
      tabButtons.forEach((b) => { b.classList.remove('is-active'); b.setAttr('aria-selected', 'false'); b.tabIndex = -1; });
      btn.classList.add('is-active');
      btn.setAttr('aria-selected', 'true');
      btn.tabIndex = 0;
      contentArea.setAttr('aria-labelledby', btn.id);
      renderTabContent(tab);
    });

    tabButtons.set(tab, btn);
  }

  tabNav.addEventListener('keydown', (event: KeyboardEvent) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const buttons = [...tabButtons.values()];
    const current = buttons.indexOf(document.activeElement as HTMLElement);
    if (current < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
    buttons[next]?.focus();
    buttons[next]?.click();
  });

  // Create content area
  const contentArea = container.createDiv('planning-board-content');
  contentArea.id = contentId;
  contentArea.setAttr('role', 'tabpanel');
  contentArea.setAttr('aria-labelledby', `${contentId}-tab-${activeTab}`);
  contentArea.tabIndex = -1;
  const statusEl = container.createDiv('task-manager-sr-only');
  statusEl.setAttr('role', 'status');
  statusEl.setAttr('aria-live', 'polite');
  let mutationPending = false;

  const setMutationPending = (pending: boolean): void => {
    mutationPending = pending;
    if (pending) container.setAttr('aria-busy', 'true');
    else container.removeAttribute('aria-busy');
    const undo = container.querySelector<HTMLButtonElement>('.planning-board-undo');
    if (undo) undo.disabled = pending;
  };

  const applyUpdate = async (task: ParsedTask, field: PlanningBoardDateField, value: string | null): Promise<ParsedTask> => {
    if (!onTaskUpdate) return task;
    const result = await onTaskUpdate(task, field, value);
    if (result === false) throw new Error('Planning board update was refused');
    if (result && typeof result === 'object') return result;
    const dates = { ...task.metadata.dates };
    if (value === null) delete dates[field];
    else dates[field] = value;
    return { ...task, metadata: { ...task.metadata, dates } };
  };

  const replaceTask = (updated: ParsedTask): void => {
    const index = allTasks.findIndex((task) => task.key === updated.key);
    if (index >= 0) allTasks[index] = updated;
  };

  function renderTabContent(tab: PlanningBoardTab): void {
    contentArea.empty();
    contentArea.addClass('planning-board-tab-content');

    const tabTasks = board.getTasksByTab(tab, allTasks);
    const hierarchy = board.buildHierarchy(tabTasks);

    // Render estimate total
    const totalEstimate = board.getEstimateTotal(tabTasks);
    const estimateBar = contentArea.createDiv('planning-board-estimate-total');
    estimateBar.createEl('span', { text: `Total: ${totalEstimate}m` });
    if (onTaskUpdate && board.getDragHistory().length > 0) {
      const undo = estimateBar.createEl('button', { cls: 'planning-board-undo', text: t('planning.undoLastScheduleChange') });
      undo.setAttr('type', 'button');
      undo.disabled = mutationPending;
      undo.addEventListener('click', () => {
        if (mutationPending) return;
        const operation = board.peekLastDrag();
        if (!operation) return;
        const task = allTasks.find((candidate) => candidate.key === operation.taskKey);
        if (!task) { board.undoLastDrag(); renderTabContent(tab); return; }
        const currentScheduled = task.metadata.dates.scheduled ?? null;
        const currentDue = task.metadata.dates.due ?? null;
        if (currentScheduled !== operation.toScheduled || currentDue !== operation.toDue) {
          board.undoLastDrag();
          renderTabContent(tab);
          statusEl.setText(new Error(`Undo expired for ${task.body} because its dates changed elsewhere.`).message);
          (container.querySelector<HTMLElement>('.planning-board-undo') ?? contentArea).focus();
          return;
        }
        void (async () => {
          setMutationPending(true);
          try {
            let updated = task;
            if (operation.fromScheduled !== operation.toScheduled) updated = await applyUpdate(updated, 'scheduled', operation.fromScheduled);
            if (operation.fromDue !== operation.toDue) updated = await applyUpdate(updated, 'due', operation.fromDue);
            replaceTask(updated);
            board.undoLastDrag();
            statusEl.setText(t('planning.undidScheduleChange', { task: task.body }));
            renderTabContent(tab);
            (container.querySelector<HTMLElement>('.planning-board-undo') ?? contentArea).focus();
          } catch (error) {
            statusEl.setText(error instanceof Error ? error.message : String(error));
            container.querySelector<HTMLElement>('.planning-board-undo')?.focus();
          } finally {
            setMutationPending(false);
          }
        })();
      });
    }

    // Safe drag-to-schedule target. Drops update scheduled dates only for
    // Today/Week/Month, and clear one active date for Unscheduled. Completed is
    // intentionally not a drop target because status changes are out-of-scope.
    const dropTarget = planningBoardTargetForTab(tab, config.todayDate);
    if ((config.enableDragDrop ?? true) && dropTarget && onTaskUpdate) {
      const dropZone = contentArea.createDiv('planning-board-drop-zone');
      dropZone.createEl('strong', { text: dropTarget.date === null ? 'Drop here to unschedule' : `Drop here to schedule for ${dropTarget.date}` });
      dropZone.createEl('span', { text: dropTarget.date === null ? ' Clears scheduled if present, otherwise due.' : ' Writes the scheduled date; due dates are left unchanged.' });
      dropZone.addEventListener('dragover', (e: DragEvent) => {
        e.preventDefault();
        dropZone.addClass('is-drag-over');
        if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
      });
      dropZone.addEventListener('dragleave', (e: DragEvent) => {
        const relatedTarget = e.relatedTarget as Node | null;
        if (relatedTarget && dropZone.contains(relatedTarget)) return;
        dropZone.removeClass('is-drag-over');
      });
      dropZone.addEventListener('drop', (e: DragEvent) => {
        e.preventDefault();
        dropZone.removeClass('is-drag-over');
        if (mutationPending) return;
        const taskKey = e.dataTransfer?.getData('text/plain');
        const task = allTasks.find((candidate) => candidate.key === taskKey);
        if (!task) return;
        void applySchedule(task, dropTarget, tab, false);
      });
    }

    // Render task cards
    const cardsContainer = contentArea.createDiv('planning-board-cards');

    function renderCard(card: PlanningCard, depth: number = 0): void {
      const cardEl = cardsContainer.createDiv('planning-board-card');
      cardEl.style.marginInlineStart = `${depth * 1.5}em`;
      cardEl.dataset.taskKey = card.task.key;
      cardEl.setAttr('role', 'group');
      cardEl.setAttr('aria-label', card.task.body);

      // Card header
      const header = cardEl.createDiv('planning-board-card-header');

      // Expand/collapse button for parent tasks
      if (card.children.length > 0) {
        const expandBtn = header.createEl('button', {
          cls: 'planning-board-expand-btn',
          text: card.isExpanded ? '▼' : '▶',
        });
        expandBtn.setAttr('aria-label', `${card.isExpanded ? 'Collapse' : 'Expand'} subtasks for ${card.task.body}`);
        expandBtn.setAttr('aria-expanded', String(card.isExpanded));
        expandBtn.addEventListener('click', (e: MouseEvent) => {
          e.stopPropagation();
          board.toggleExpand(card.task.key);
          renderTabContent(tab);
        });
      } else {
        header.createEl('span', { cls: 'planning-board-expand-placeholder' });
      }

      // Task info
      const info = header.createEl('button', { cls: 'planning-board-card-info' });
      info.setAttr('type', 'button');
      const primaryAction = config.primaryActionDescription ?? 'Activate task card';
      info.setAttr('aria-label', `${primaryAction}: ${card.task.body}${dropTarget ? `. Press S to ${dropTarget.date === null ? 'unschedule' : `schedule for ${dropTarget.date}`}` : ''}`);
      if (dropTarget) info.setAttr('aria-keyshortcuts', 'S');
      info.createEl('span', {
        cls: 'planning-board-card-title',
        text: card.task.body,
      });

      const priority = card.task.metadata?.priority;
      if (priority) {
        info.createEl('span', {
          cls: `planning-board-priority priority-${priority}`,
          text: priority,
        });
      }

      const estimate = card.task.metadata?.effort;
      if (estimate) {
        info.createEl('span', {
          cls: 'planning-board-estimate',
          text: String(estimate),
        });
      }

      const dueDate = card.task.metadata?.dates?.due;
      if (dueDate) {
        info.createEl('span', {
          cls: 'planning-board-due-date',
          text: dueDate,
        });
      }

      // Card interaction
      info.addEventListener('click', () => onTaskClick?.(card.task));
      info.addEventListener('keydown', (event: KeyboardEvent) => {
        if (event.key.toLowerCase() === 's' && dropTarget && onTaskUpdate) {
          event.preventDefault();
          if (!mutationPending) void applySchedule(card.task, dropTarget, tab, true);
        }
      });

      // Make card draggable for drag-to-schedule
      if (config.enableDragDrop ?? true) {
        cardEl.draggable = true;
        cardEl.addEventListener('dragstart', (e: DragEvent) => {
          if (e.dataTransfer) {
            e.dataTransfer.effectAllowed = 'move';
            e.dataTransfer.setData('text/plain', card.task.key);
          }
        });
      }

      // Render children if expanded
      if (card.isExpanded && card.children.length > 0) {
        for (const child of card.children) {
          renderCard(child, depth + 1);
        }
      }
    }

    for (const card of hierarchy) {
      renderCard(card);
    }

    // Empty state
    if (tabTasks.length === 0) {
      contentArea.createEl('div', {
        cls: 'planning-board-empty-state',
        text: `No tasks in ${tab}`,
      });
    }
  }

  async function applySchedule(task: ParsedTask, target: PlanningBoardScheduleTarget, tab: PlanningBoardTab, focusAfter: boolean): Promise<void> {
    if (!onTaskUpdate || mutationPending) return;
    const plan = planPlanningBoardSchedule(task, target);
    setMutationPending(true);
    try {
      let updated = task;
      for (const update of plan.updates) updated = await applyUpdate(updated, update.field, update.value);
      replaceTask(updated);
      board.recordDragOperation(plan.operation);
      renderTabContent(tab);
      if (focusAfter) (container.querySelector<HTMLElement>('.planning-board-undo') ?? contentArea).focus();
    } catch (error) {
      statusEl.setText(error instanceof Error ? error.message : String(error));
    } finally {
      setMutationPending(false);
    }
  }

  // Initial render
  renderTabContent(activeTab);

  return board;
}
