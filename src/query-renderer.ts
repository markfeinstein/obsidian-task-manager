import { FuzzySuggestModal, MarkdownRenderChild, MarkdownRenderer, Menu, Modal, Notice, type App, type Component, type MarkdownPostProcessorContext, type TFile } from 'obsidian';
import type { TaskManagerSettings } from './types';
import { TaskScanner, calculateNextRecurrences, scanFileWithTaskNotes, type EditableTaskDateField, type ParsedTask } from './task-scanner';
import { TaskMutationService } from './task-mutation-service';
import { mutateRenderedTaskLinesInContent } from './task-mutation-resolver';
import { checkboxForStatus, cycleTaskCheckbox, sourceLineIdentity, splitContentLines, statusFromCheckbox, taskStateIcon, taskStateLabel } from './task-model';
import { calculateUrgency, groupTasks, type DateField, type GroupedTaskNode, type TaskFileInfo, type TaskQuery } from './task-query';
import { TaskQueryService } from './task-query-service';
import { renderKanban } from './kanban-renderer';
import { moveKanbanCardLine } from './kanban-board';
import { renderCalendar } from './calendar-renderer';
import { renderTimeline } from './timeline-renderer';
import { renderGantt } from './gantt-renderer';
import { renderEisenhower } from './eisenhower-renderer';
import { captureTableGridFocus, renderTable, type TableBulkActionFailure, type TableBulkActionResult } from './table-renderer';
import { renderRecurrenceHeatmap } from './recurrence-heatmap';
import { getPriorityColorClass, getStatusColorClass } from './color-utils';
import { setupListTaskDrag } from './cross-view-drag';
import { applyManualOrderWrites, applyRowMove, attachManualDrag, isManualOrderWritableTask, planManualReorder, sortTasksWithManualOrder } from './manual-order';
import { QueryLinter } from './query-polish';
import { updateCanvasTaskCheckbox } from './canvas-exporter';
import { handleQueryRowHotkey, setupSwipeHandler, type ScreenReaderAnnouncer } from './keyboard-nav';
import { taskDensityClass } from './appearance';
import { isValidIsoDate, todayString } from './date-utils';
import { addIsoDays as addDays, addIsoMonths, formatLocalDate } from './iso-date';
import { emptyEditableTaskLine, formatEditableTaskLine } from './modals/task-edit-helpers';
import type { StateStore, PersistedState } from './state-store';
import type { CalendarIcsEvent } from './calendar-renderer';
import { ensureExportPathExtension } from './exporters';
import { encodeCsvCell } from './csv-utils';
import { confirmSettingsRemoval } from './settings/confirm-removal';
import { getLevelFromXP, renderAchievements } from './gamification';
import { t } from './i18n';
import { formatIsoMonthDay, formatIsoWeekday } from './display-date';
import { QUERY_RESULT_PAGE_SIZE, queryPagingSessionFor, type QueryResultPagingSession } from './query-result-paging';

// ── Focus timer state (module-level, shared across all renderer instances) ────────────────
const focusTimers = new Map<string, { startMs: number; intervalId: ReturnType<typeof setInterval>; btnEl: HTMLButtonElement; task?: ParsedTask }>();
const queryFilterPopoverControllers = new WeakMap<HTMLElement, AbortController>();
const queryCalendarDisposers = new WeakMap<HTMLElement, () => void>();
const queryFilterLifecycleRegistered = new WeakSet<HTMLElement>();
const queryRenderDisposedElements = new WeakSet<HTMLElement>();

export function makeKeyboardButton(element: HTMLElement, label: string, activate: () => void): void {
  element.setAttr('role', 'button'); element.setAttr('tabindex', '0'); element.setAttr('aria-label', label);
  element.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activate(); } });
}

export function configureDependencyChip(element: HTMLElement, id: string, navigate: () => void): void {
  makeKeyboardButton(element, `Open dependency task ${id}`, navigate); element.setAttr('title', `Click to jump to task ${id}`);
  element.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); navigate(); });
}

export function configureRecurrenceChip(element: HTMLElement, value: string, openMenu: (event: MouseEvent) => void): void {
  makeKeyboardButton(element, `${value}. Recurrence actions`, () => openMenu(new MouseEvent('contextmenu'))); element.setAttr('title', `${value} — right-click to skip or edit`);
  element.addEventListener('contextmenu', (event) => { event.preventDefault(); event.stopPropagation(); openMenu(event); });
}

interface QueryTreeFileContext {
  lines: readonly string[];
  taskByLine: ReadonlyMap<number, ParsedTask>;
  matchedDescendantKeys: ReadonlySet<string>;
}

export function queryTreeOccurrenceKey(task: Pick<ParsedTask, 'filePath' | 'lineNumber' | 'key'>): string {
  return `${task.filePath}\0${task.lineNumber}\0${task.key}`;
}

export function matchedQueryTreeDescendants(
  lines: readonly string[],
  taskByLine: ReadonlyMap<number, ParsedTask>,
  matchedKeys: ReadonlySet<string>,
): ReadonlySet<string> {
  const descendants = new Set<string>();
  const stacks = new Map<string, ParsedTask[]>();
  for (let index = 0; index < lines.length; index += 1) {
    const match = (lines[index] ?? '').match(/^((?:\s*>\s*)*)(\s*)((?:[-*+])|(?:\d+[.)]))\s+/u);
    if (!match) continue;
    const linePrefix = match[1] ?? '';
    const indentation = match[2]?.length ?? 0;
    const stack = stacks.get(linePrefix) ?? [];
    while (stack.length > 0 && (stack.at(-1)?.indentation.length ?? 0) >= indentation) stack.pop();
    const task = taskByLine.get(index + 1);
    if (!task) {
      stacks.set(linePrefix, stack);
      continue;
    }
    if (stack.some((ancestor) => matchedKeys.has(queryTreeOccurrenceKey(ancestor)))) descendants.add(queryTreeOccurrenceKey(task));
    stack.push(task);
    stacks.set(linePrefix, stack);
  }
  return descendants;
}

function disposeQueryFilterPopover(el: HTMLElement): void {
  queryFilterPopoverControllers.get(el)?.abort();
  queryFilterPopoverControllers.delete(el);
}

function disposeQueryCalendar(el: HTMLElement): void {
  const dispose = queryCalendarDisposers.get(el);
  queryCalendarDisposers.delete(el);
  if (dispose) dispose();
}

function disposeQueryRenderResources(el: HTMLElement): void {
  disposeQueryFilterPopover(el);
  disposeQueryCalendar(el);
}

function registerQueryFilterPopoverLifecycle(el: HTMLElement, ctx: MarkdownPostProcessorContext, onUnload: () => void): void {
  if (queryFilterLifecycleRegistered.has(el)) return;
  const contextWithLifecycle = ctx as MarkdownPostProcessorContext & { addChild?: (child: Component) => void };
  if (typeof contextWithLifecycle.addChild !== 'function' || typeof MarkdownRenderChild !== 'function') return;

  queryFilterLifecycleRegistered.add(el);
  const child = new MarkdownRenderChild(el) as Component & { onunload?: () => void };
  const originalUnload = typeof child.onunload === 'function' ? child.onunload.bind(child) : undefined;
  child.onunload = () => {
    queryRenderDisposedElements.add(el);
    disposeQueryRenderResources(el);
    queryFilterLifecycleRegistered.delete(el);
    onUnload();
    originalUnload?.();
  };
  contextWithLifecycle.addChild(child);
}

interface RenderTaskOptions {
  /** Native checklist mode suppresses list-view affordances such as row drag. */
  checklist?: boolean;
  /** Enable cross-view row dragging for richer list views. */
  enableCrossViewDrag?: boolean;
}

export function addTagToTaskLine(line: string, parserTags: readonly string[], tag: string): string {
  const normalizedTag = tag.startsWith('#') ? tag : `#${tag}`;
  const rawTag = normalizedTag.slice(1).toLowerCase();
  if (parserTags.some((t) => (t.startsWith('#') ? t.slice(1) : t).toLowerCase() === rawTag)) return line;
  const blockLinkMatch = line.match(/(\s\^[\w-]+)\s*$/u);
  if (blockLinkMatch) {
    return line.slice(0, line.length - blockLinkMatch[0].length) + ` ${normalizedTag}` + blockLinkMatch[0];
  }
  return line.replace(/\s*$/u, '') + ` ${normalizedTag}`;
}

export function removeTagFromTaskLine(line: string, tag: string): string {
  const rawTag = tag.startsWith('#') ? tag.slice(1) : tag;
  const tagRegex = new RegExp(`(^|\\s)#${rawTag.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}(?=\\s|$)`, 'giu');
  return line.replace(tagRegex, (_match, prefix: string) => prefix).replace(/\s{2,}/gu, ' ').trimEnd();
}

function stopFocusTimer(key: string, onFocusTime?: (task: ParsedTask, elapsedMs: number) => Promise<void>, task?: ParsedTask): void {
  const timer = focusTimers.get(key);
  if (!timer) return;
  clearInterval(timer.intervalId);
  const elapsedMs = Date.now() - timer.startMs;
  timer.btnEl.setText('🎯');
  timer.btnEl.removeClass('task-manager-timer-active');
  timer.btnEl.setAttr('aria-pressed', 'false');
  focusTimers.delete(key);
  const timerTask = task ?? timer.task;
  if (onFocusTime && timerTask) {
    void onFocusTime(timerTask, elapsedMs);
  }
}

function formatElapsed(ms: number): string {
  const totalSec = Math.floor(ms / 1_000);
  const mins = Math.floor(totalSec / 60);
  const secs = totalSec % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

// Track in-progress inline description edits
const activeDescEdits = new Set<string>();

/** Replace just the human-readable description in a raw task line, preserving all metadata. */
function replaceDescriptionInLine(rawLine: string, newDesc: string): string {
  // Split: prefix (up to and including `] `), description, then metadata tail
  const prefixMatch = rawLine.match(/^((?:\s*>\s*)*\s*(?:[-*+]|\d+[.)])\s+\[[^\]]+\]\s+)/u);
  if (!prefixMatch) return rawLine;
  const prefix = prefixMatch[1];
  const rest = rawLine.slice(prefix.length);
  // Find where metadata starts: first occurrence of a known metadata emoji, dataview field, or block-link
  const metaStart = rest.search(/[\uD83D\uDCC5\uD83D\uDCC6\uD83D\uDDD3\u23F3\u231B\uD83D\uDEEB\u2705\u2795\u274C\uD83D\uDD01\uD83C\uDFC1\uD83C\uDD94\u26D4\uD83D\uDD3A\u23EB\uD83D\uDD3C\uD83D\uDD3D\u23EC\u23F0\u231A\u23F1\uD83D\uDD50]|\[|\s#|\s\^/u);
  const tail = metaStart >= 0 ? rest.slice(metaStart) : '';
  return `${prefix}${newDesc.trim()}${tail ? ' ' + tail.trimStart() : ''}`;
}

export interface QuerySummaryStats {
  total: number;
  active: number;
  inProgress: number;
  overdue: number;
  dueToday: number;
  done: number;
  cancelled: number;
}

export function buildQuerySummaryStats(tasks: readonly ParsedTask[], today = todayString()): QuerySummaryStats {
  let active = 0;
  let inProgress = 0;
  let overdue = 0;
  let dueToday = 0;
  let done = 0;
  let cancelled = 0;
  for (const task of tasks) {
    if (task.status === 'done') done += 1;
    else if (task.status === 'cancelled') cancelled += 1;
    else active += 1;
    if (task.status === 'in_progress') inProgress += 1;
    const due = task.metadata?.dates?.due ?? '';
    const scheduled = task.metadata?.dates?.scheduled ?? '';
    const earliest = due && scheduled ? (due < scheduled ? due : scheduled) : (due || scheduled);
    if (earliest === today) dueToday += 1;
    if (earliest && earliest < today && task.status !== 'done' && task.status !== 'cancelled') overdue += 1;
  }
  return { total: tasks.length, active, inProgress, overdue, dueToday, done, cancelled };
}

export function queryResultCacheScope(source: string, query: TaskQuery, sourcePath: string): string {
  const sourceSensitive = Boolean(query.explainSources?.queryFileDefaults.length)
    || /(?:\b(?:filter|sort|group)\s+by\s+function\b|\bquery\.file\b|\bthis\s+file\b)/iu.test(source);
  return sourceSensitive ? sourcePath : '*';
}

export class TaskQueryRenderer {
  private taskCache: Promise<ParsedTask[]> | null = null;
  /** Shares identical query evaluation within one task-cache revision. */
  private queryResultCache = new Map<string, Promise<ParsedTask[]>>();
  private fileTaskCache = new Map<string, { fingerprint: string; revision: number; tasks: ParsedTask[] }>();
  private cacheRevision = 0;
  private globalInvalidationRevision = 0;
  private fileInvalidationRevisions = new Map<string, number>();
  // Track currently-mounted query blocks so we can re-run them when underlying
  // files change (mirrors upstream Cache.notifySubscribers → QueryRenderer re-render).
  private activeRenders = new Map<HTMLElement, { source: string; ctx: MarkdownPostProcessorContext }>();
  private renderGenerations = new WeakMap<HTMLElement, number>();
  private refreshPending = false;

  private taskMutations?: TaskMutationService;

  constructor(
    private readonly app: App,
    private readonly scanner: TaskScanner,
    private readonly getSettings: () => TaskManagerSettings,
    private readonly owner?: Component,
    private readonly onBeforeTaskToggle?: (task: ParsedTask, sourcePath: string, nextCheckbox: string) => void,
    private readonly onEditTask?: (task: ParsedTask, onUpdated: () => void) => void,
    private readonly onFocusTime?: (task: ParsedTask, elapsedMs: number) => Promise<void>,
    private readonly plugin?: { stateStore?: StateStore; persistedState?: PersistedState; fetchAndCacheIcsEvents?: () => Promise<CalendarIcsEvent[]>; onClockInOut?: (task: ParsedTask, isClockingIn: boolean) => Promise<void>; saveSettings?: () => Promise<void> },
    private readonly announcer?: ScreenReaderAnnouncer,
    private readonly onCreateTask?: (statusSymbol: string | undefined, sourcePath: string, onUpdated: () => void, dates?: { due?: string }) => void,
    private readonly getIndexedTasks?: () => Promise<ParsedTask[]>,
  ) {}

  setTaskMutations(taskMutations: TaskMutationService): void {
    this.taskMutations = taskMutations;
  }

  invalidateCache(path?: string): void {
    if (path) { this.invalidateChangedFiles([path]); return; }
    this.taskCache = null; this.queryResultCache?.clear(); this.cacheRevision = (this.cacheRevision ?? 0) + 1;
    this.globalInvalidationRevision ??= 0; this.fileInvalidationRevisions ??= new Map<string, number>();
    this.fileTaskCache.clear(); this.fileInvalidationRevisions.clear(); this.globalInvalidationRevision = this.cacheRevision;
  }

  invalidateChangedFiles(paths: readonly string[]): void {
    if (paths.length === 0) return;
    this.taskCache = null; this.queryResultCache?.clear(); this.cacheRevision = (this.cacheRevision ?? 0) + 1;
    this.globalInvalidationRevision ??= 0; this.fileInvalidationRevisions ??= new Map<string, number>();
    for (const path of new Set(paths)) { this.fileTaskCache.delete(path); this.fileInvalidationRevisions.set(path, this.cacheRevision); }
  }

  stopAllFocusTimers(): void {
    for (const [key] of focusTimers) {
      stopFocusTimer(key, this.onFocusTime);
    }
  }

  /**
   * Re-render every mounted query block whose host element is still attached
   * to the DOM. Stale entries (detached or replaced) are pruned. Mirrors
   * upstream Cache.notifySubscribers behaviour where every visible query block
   * is refreshed after the task cache changes.
   */
  refreshAllVisible(): void {
    if (this.refreshPending) return;
    this.refreshPending = true;
    // Defer to the next microtask so multiple cache invalidations coalesce.
    void Promise.resolve().then(() => {
      this.refreshPending = false;
      for (const [el, entry] of [...this.activeRenders]) {
        const stillMounted = typeof (el as { isConnected?: boolean }).isConnected === 'boolean'
          ? (el as { isConnected: boolean }).isConnected
          : true;
        if (!stillMounted || queryRenderDisposedElements.has(el)) {
          disposeQueryRenderResources(el);
          this.activeRenders.delete(el);
          continue;
        }
        // Re-run the post-processor entry-point; render() itself re-registers
        // the entry so the map stays accurate.
        void this.render(entry.source, el, entry.ctx);
      }
    });
  }

  async render(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
    queryRenderDisposedElements.delete(el);
    registerQueryFilterPopoverLifecycle(el, ctx, () => {
      this.activeRenders.delete(el);
      this.renderGenerations.set(el, (this.renderGenerations.get(el) ?? 0) + 1);
    });
    const renderGeneration = (this.renderGenerations.get(el) ?? 0) + 1;
    this.renderGenerations.set(el, renderGeneration);
    // Prune detached elements before registering to prevent unbounded map growth.
    for (const [staleEl] of this.activeRenders) {
      const stillMounted = typeof (staleEl as HTMLElement & { isConnected?: boolean }).isConnected === 'boolean'
        ? (staleEl as HTMLElement & { isConnected: boolean }).isConnected
        : true;
      if (!stillMounted || queryRenderDisposedElements.has(staleEl)) {
        disposeQueryRenderResources(staleEl);
        this.activeRenders.delete(staleEl);
      }
    }
    this.activeRenders.set(el, { source, ctx });
    // On the FIRST render, show a lightweight loading placeholder. On subsequent
    // re-renders (e.g. after checking off a task) keep the already-rendered
    // content on screen during the async task collection below, then swap it in
    // synchronously. This avoids the blank/"Loading…" flash (flicker) that
    // otherwise occurs on every refresh.
    const isInitialRender = el.childElementCount === 0;
    if (isInitialRender) {
      disposeQueryRenderResources(el);
      el.empty();
      el.addClass('task-manager-query');
      el.removeClass('task-manager-query-checklist');
      this.applyAppearanceClasses(el);
      this.renderMessage(el, 'Loading tasks…', 'task-manager-query-loading');
    }

    try {
      const startTime = performance.now();
      const query = this.parseQuery(source, ctx.sourcePath);
      const tasks = await this.collectTasks(source, query, ctx.sourcePath);
      if (!this.isCurrentRender(el, renderGeneration)) return;
      const endTime = performance.now();
      const executionTime = endTime - startTime;
      // Store execution time in query for explain output
      query.executionTimeMs = executionTime;

      captureTableGridFocus(el);
      disposeQueryRenderResources(el);
      el.empty();
      el.addClass('task-manager-query');
      this.applyQueryModeClasses(el, query);
      this.applyAppearanceClasses(el);
      // Apply user-specified CSS class(es) from `css-class: my-class` query directive (#11)
      if (query.cssClass) {
        for (const cls of query.cssClass.split(/\s+/u)) {
          if (cls) el.addClass(cls);
        }
      }
      if (query.errors.length > 0) {
        this.renderMessage(el, query.errors.join('\n'), 'task-manager-query-error');
        this.renderQueryLint(el, source);
      }
      if (query.explain) {
        this.renderExplain(el, query, tasks);
      }
      if (!query.layout.hidden.has('toolbar')) {
        this.renderToolbar(el, query, tasks, ctx);
        this.renderSummaryBar(el, tasks);
        if (query.sort.length > 0 && query.viewMode !== 'kanban') {
          this.renderSortIndicator(el, query);
        }
      }
      const showCount = !query.layout.hidden.has('task count');
      if (showCount && this.getSettings().taskCountLocation === 'top') {
        this.renderTaskCount(el, tasks.length);
      }
      const calendarIcsEvents = (query.viewMode === 'calendar' && this.plugin?.fetchAndCacheIcsEvents
        ? await this.plugin.fetchAndCacheIcsEvents()
        : []);
      if (!this.isCurrentRender(el, renderGeneration)) return;
      if (tasks.length === 0 && !(query.viewMode === 'calendar' && calendarIcsEvents.length > 0)) {
        this.renderMessage(el, 'No matching tasks found.', 'task-manager-query-empty');
        if (showCount && this.getSettings().taskCountLocation === 'bottom') {
          this.renderTaskCount(el, 0);
        }
        return;
      }

      const pagedMode = query.viewMode === undefined || query.viewMode === 'list' || query.viewMode === 'checklist' || query.viewMode === 'table';
      const pagingSession = queryPagingSessionFor(el);
      pagingSession.update(tasks.map(queryTreeOccurrenceKey));
      const renderedTasks = pagedMode ? pagingSession.visible(tasks) : tasks;
      if (pagedMode && tasks.length > QUERY_RESULT_PAGE_SIZE) {
        this.renderResultPager(el, pagingSession, () => this.render(source, el, ctx));
      }

      // Alternative view modes
      if (query.viewMode === 'table') {
        renderTable(el, renderedTasks, query, this.getSettings(),
          async (task) => { await this.toggleTaskStatus(task, ctx.sourcePath); await this.render(source, el, ctx); },
          (task) => this.onEditTask?.(task, () => { void this.render(source, el, ctx); }),
          {
            onSaveSettings: async () => { await this.pluginSaveSettings(); },
            onAddTag: async (task, tag) => { await this.addTagToSingleTask(task, tag); await this.render(source, el, ctx); },
            onRemoveTag: async (task, tag) => { await this.removeTagFromSingleTask(task, tag); await this.render(source, el, ctx); },
            onBulkComplete: async (selected) => this.bulkComplete(selected.map((task) => task.key), tasks, ctx.sourcePath, false),
            onBulkCancel: async (selected) => this.bulkCancel(selected.map((task) => task.key), tasks, ctx.sourcePath, false),
            onBulkPostpone: async (selected) => this.bulkPostpone(selected.map((task) => task.key), tasks, false),
            onBulkReschedule: async (selected, date) => this.bulkReschedule(selected.map((task) => task.key), tasks, date, false),
            onBulkPriority: async (selected, priority) => this.bulkPrioritize(selected.map((task) => task.key), tasks, priority, false),
            onBulkSetCustomField: async (selected, key, value) => this.bulkSetCustomField(selected.map((task) => task.key), tasks, key, value, false),
            onBulkAddTag: async (selected, tag) => this.bulkAddTag(selected.map((task) => task.key), tasks, tag, false),
            onBulkRemoveTag: async (selected, tag) => this.bulkRemoveTag(selected.map((task) => task.key), tasks, tag, false),
            onOpenSource: (task) => { void this.app.workspace.openLinkText(task.filePath, ctx.sourcePath, false); },
            onSetCustomField: async (task, key, value) => { await this.setDataviewField(task, key, value); await this.render(source, el, ctx); },
            getRecurrenceHistoryDates: (task) => this.recurrenceHistoryDates(task),
            onConfirmRemoval: (label, onConfirm) => confirmSettingsRemoval(this.app, label, onConfirm, {
              title: `Delete ${label}?`,
              description: `This removes ${label}. This action cannot be undone.`,
              confirmLabel: 'Delete',
            }),
            onRerender: () => { void this.render(source, el, ctx); },
          },
        );
        if (showCount && this.getSettings().taskCountLocation === 'bottom') this.renderTaskCount(el, tasks.length);
        return;
      }
      if (query.viewMode === 'kanban') {
        renderKanban(el, tasks, query, this.getSettings(),
          async (task) => { await this.toggleTaskStatus(task, ctx.sourcePath); await this.renderPreservingScroll(source, el, ctx); },
          (task) => this.onEditTask?.(task, () => { void this.render(source, el, ctx); }),
          async (task, symbol) => { await this.changeTaskStatus(task, symbol, ctx.sourcePath); await this.renderPreservingScroll(source, el, ctx); },
          (statusSymbol) => this.createTaskFromQuery(statusSymbol, ctx.sourcePath, () => { void this.render(source, el, ctx); }),
          {
            renderLimit: { initialTotal: 200, increment: 100 },
            onOpenSource: (task) => { void this.app.workspace.openLinkText(task.filePath, ctx.sourcePath, false); },
            onRemoveFromBoard: async (task) => { await this.addTagToSingleTask(task, 'kanban-hidden'); await this.render(source, el, ctx); },
            onMoveToGroup: async (task, groupBy, value, customFieldKey) => {
              await this.moveTaskToKanbanGroup(task, groupBy, value, customFieldKey);
              await this.render(source, el, ctx);
            },
            onQuickAdd: async (text, statusSymbol) => { await this.quickAddTaskLine(text, statusSymbol, ctx.sourcePath); await this.render(source, el, ctx); },
            getRecurrenceHistoryDates: (task) => this.recurrenceHistoryDates(task),
            onSaveSettings: async () => { await this.pluginSaveSettings(); },
            onRerender: () => { void this.render(source, el, ctx); },
          },
        );
        if (showCount && this.getSettings().taskCountLocation === 'bottom') this.renderTaskCount(el, tasks.length);
        return;
      }

      if (query.viewMode === 'calendar') {
        const futureTasks = buildFutureTasks(tasks, this.getSettings().recurrenceFutureOccurrences);
        const disposeCalendar = renderCalendar(el, tasks, query, this.getSettings(),
          async (task) => { await this.toggleTaskStatus(task, ctx.sourcePath); await this.render(source, el, ctx); },
          (task) => this.onEditTask?.(task, () => { void this.render(source, el, ctx); }),
          (date) => this.createTaskFromQuery(undefined, ctx.sourcePath, () => { void this.render(source, el, ctx); }, { due: date }),
          async (task, field, newDate) => { await this.rescheduleTask(task, field, newDate); await this.render(source, el, ctx); },
          futureTasks,
          calendarIcsEvents,
        );
        queryCalendarDisposers.set(el, disposeCalendar);
        return;
      }

      if (query.viewMode === 'gantt') {
        const futureTasks = buildFutureTasks(tasks, this.getSettings().recurrenceFutureOccurrences);
        renderGantt(el, tasks, query, this.getSettings(),
          async (task) => { await this.toggleTaskStatus(task, ctx.sourcePath); await this.render(source, el, ctx); },
          (task) => this.onEditTask?.(task, () => { void this.render(source, el, ctx); }),
          async (task, field, newDate) => { await this.rescheduleTask(task, field, newDate); await this.render(source, el, ctx); },
          futureTasks,
        );
        return;
      }

      if (query.viewMode === 'timeline') {
        // TASK-17: Time-blocking timeline view
        const pluginStateStore = this.plugin?.stateStore;
        const persistedState = await pluginStateStore?.loadState();
        if (!this.isCurrentRender(el, renderGeneration)) return;
        const allIcsEvents = (query.viewMode === 'timeline' && this.plugin?.fetchAndCacheIcsEvents
          ? await this.plugin.fetchAndCacheIcsEvents()
          : []);
        if (!this.isCurrentRender(el, renderGeneration)) return;
        const today = taskManagerTodayString();
        const icsEvents = allIcsEvents.filter((event) => event.date?.slice(0, 10) === today);
        renderTimeline(el, tasks, query, this.getSettings(),
          async (task) => { await this.toggleTaskStatus(task, ctx.sourcePath); await this.render(source, el, ctx); },
          (task) => this.onEditTask?.(task, () => { void this.render(source, el, ctx); }),
          async (task, field, newDate) => { await this.rescheduleTask(task, field, newDate); await this.render(source, el, ctx); },
          pluginStateStore,
          persistedState,
          this.plugin?.onClockInOut,
          icsEvents,
          this.owner,
        );
        return;
      }

      if (query.viewMode === 'stats') {
        this.renderStats(el, tasks);
        return;
      }

      if (query.viewMode === 'graph') {
        this.renderDependencyGraph(el, tasks);
        return;
      }

      if (query.viewMode === 'eisenhower') {
        renderEisenhower(el, tasks, query, this.getSettings(),
          async (task) => { await this.toggleTaskStatus(task, ctx.sourcePath); await this.render(source, el, ctx); },
          (task) => this.onEditTask?.(task, () => { void this.render(source, el, ctx); }),
        );
        if (showCount && this.getSettings().taskCountLocation === 'bottom') this.renderTaskCount(el, tasks.length);
        return;
      }

      if (query.groups.length > 0) {
        this.renderGroupedTasks(el, groupTasks(renderedTasks, this.effectiveGroups(query), undefined, this.getSettings().supportedStates, { allTasks: tasks, sourcePath: ctx.sourcePath, globalFilter: this.getSettings().globalFilter, fileInfoProvider: (path) => this.fileInfo(path) }), ctx, source, 4, tasks, query);
      } else if (query.layout.shown.has('tree') && !query.layout.hidden.has('tree')) {
        const tree = await this.renderTaskTree(renderedTasks, ctx, query, () => this.render(source, el, ctx));
        if (!this.isCurrentRender(el, renderGeneration)) return;
        el.appendChild(tree);
      } else if (query.viewMode === 'checklist') {
        this.renderChecklistTasks(el, renderedTasks, ctx, query, () => this.render(source, el, ctx));
      } else {
        const selectedTasks = pagingSession.selectedKeys;
        const rerender = () => this.render(source, el, ctx);
        const bulkBar = el.createDiv({ cls: 'task-manager-bulk-bar' });
        bulkBar.style.display = 'none';

        // Select-all checkbox in toolbar area (already rendered above — wire to bulk bar)
        const selectAllCb = el.createEl('input', { type: 'checkbox', cls: 'task-manager-select-all-cb' });
        selectAllCb.setAttr('title', 'Select all');
        selectAllCb.setAttr('aria-label', t('ui.selectAllQueryResults'));
        const showSelectAllInToolbar = !query.layout.hidden.has('toolbar');
        if (showSelectAllInToolbar) {
          const toolbar = el.querySelector<HTMLElement>('.task-manager-query-toolbar');
          if (toolbar) toolbar.prepend(selectAllCb);
        } else {
          el.appendChild(selectAllCb);
        }

        const selectedTaskKeys = (): string[] => [...selectedTasks]
          .map((selectionKey) => tasks.find((task) => queryTreeOccurrenceKey(task) === selectionKey)?.key)
          .filter((key): key is string => Boolean(key));
        const updateBulkBar = (): void => {
          bulkBar.style.display = selectedTasks.size > 0 ? '' : 'none';
          bulkBar.empty();
          bulkBar.createEl('span', { text: `${selectedTasks.size} selected`, cls: 'task-manager-bulk-count' });
          const btnDone = bulkBar.createEl('button', { text: '✓ Complete', cls: 'task-manager-bulk-btn' });
          btnDone.addEventListener('click', () => {
            void this.bulkComplete(selectedTaskKeys(), tasks, ctx.sourcePath).then(rerender);
          });
          const btnCancel = bulkBar.createEl('button', { text: '✕ Cancel', cls: 'task-manager-bulk-btn' });
          btnCancel.addEventListener('click', () => {
            void this.bulkCancel(selectedTaskKeys(), tasks, ctx.sourcePath).then(rerender);
          });
          const btnPostpone = bulkBar.createEl('button', { text: '⏩ +1 day', cls: 'task-manager-bulk-btn' });
          btnPostpone.addEventListener('click', () => {
            void this.bulkPostpone(selectedTaskKeys(), tasks).then(rerender);
          });
          const btnReschedule = bulkBar.createEl('button', { text: '📅 Reschedule…', cls: 'task-manager-bulk-btn' });
          btnReschedule.addEventListener('click', () => {
            new BulkRescheduleDateModal(this.app, (newDate) => {
              void this.bulkReschedule(selectedTaskKeys(), tasks, newDate).then(rerender);
            }).open();
          });
          // Bulk prioritize
          const btnPriority = bulkBar.createEl('button', { text: '🔼 Priority…', cls: 'task-manager-bulk-btn' });
          btnPriority.addEventListener('click', (e) => {
            const menu = new Menu();
            for (const [label, priority] of [
              ['🔺 Highest', 'highest'], ['⏫ High', 'high'], ['🔼 Medium', 'medium'],
              ['🔽 Normal', 'normal'], ['⏬ Low', 'low'], ['⏬ Lowest', 'lowest'],
            ] as Array<[string, string]>) {
              menu.addItem((item) => item.setTitle(label).onClick(() => {
                void this.bulkPrioritize(selectedTaskKeys(), tasks, priority).then(rerender);
              }));
            }
            menu.showAtMouseEvent(e);
          });

          // Bulk add tag
          const btnTag = bulkBar.createEl('button', { text: '🏷 Tag…', cls: 'task-manager-bulk-btn' });
          btnTag.addEventListener('click', () => {
            const tag = prompt('Tag to add (without #):');
            if (tag?.trim()) {
              void this.bulkAddTag(selectedTaskKeys(), tasks, tag.trim()).then(rerender);
            }
          });

          // Bulk remove tag (#19)
          const btnUntag = bulkBar.createEl('button', { text: '🏷− Untag…', cls: 'task-manager-bulk-btn' });
          btnUntag.addEventListener('click', (e) => {
            const selectedObjs = [...selectedTasks]
              .map((selectionKey) => tasks.find((task) => queryTreeOccurrenceKey(task) === selectionKey))
              .filter((t): t is ParsedTask => Boolean(t));
            const allTagSet = new Set(selectedObjs.flatMap((t) => t.tags));
            if (allTagSet.size === 0) { new Notice('No tags on selected tasks.'); return; }
            const tagMenu = new Menu();
            for (const tag of Array.from(allTagSet).sort()) {
              tagMenu.addItem((menuItem) => menuItem.setTitle(`#${tag}`).onClick(() => {
                void this.bulkRemoveTag(selectedTaskKeys(), tasks, tag).then(rerender);
              }));
            }
            tagMenu.showAtMouseEvent(e);
          });

          const btnClear = bulkBar.createEl('button', { text: 'Clear', cls: 'task-manager-bulk-btn task-manager-bulk-btn-clear' });
          btnClear.addEventListener('click', () => { selectedTasks.clear(); updateBulkBar(); });
        };

        selectAllCb.addEventListener('change', () => {
          if (selectAllCb.checked) {
            for (const task of tasks) selectedTasks.add(queryTreeOccurrenceKey(task));
          } else {
            selectedTasks.clear();
          }
          updateBulkBar();
          // update per-row checkboxes
          for (const cb of Array.from(list.querySelectorAll<HTMLInputElement>('.task-manager-select-checkbox'))) {
            cb.checked = selectAllCb.checked;
          }
        });

        const list = document.createElement('ul');
        list.addClass('task-manager-query-list');
        // Upstream theme contract: `contains-task-list` + `plugin-tasks-query-result` on the
        // outer `<ul>`, plus per-component `tasks-layout-hide-<component>` classes for any
        // hidden layout element. See upstream HtmlQueryResultsRenderer.beginTaskList.
        list.addClass('contains-task-list', 'plugin-tasks-query-result');
        for (const cls of upstreamLayoutHideClasses(query)) list.addClass(cls);
        // Add ARIA attributes for accessibility
        list.setAttr('role', 'list');
        list.setAttr('aria-label', `Task list with ${tasks.length} tasks; showing ${renderedTasks.length}`);
        // Drag-to-reorder state (#18)
        let dragSrcIdx: number | null = null;
        const renderedTaskKeys = renderedTasks.map((t) => t.key);
        for (let taskRowIdx = 0; taskRowIdx < renderedTasks.length; taskRowIdx++) {
          const task = renderedTasks[taskRowIdx];
          const li = this.renderTask(task, ctx, query, () => this.render(source, el, ctx), tasks);

          // Per-row selection checkbox
          const selCb = document.createElement('input');
          selCb.type = 'checkbox';
          selCb.className = 'task-manager-select-checkbox';
          const selectionKey = queryTreeOccurrenceKey(task);
          selCb.checked = selectedTasks.has(selectionKey);
          selCb.setAttr('title', 'Select task');
          selCb.setAttr('aria-label', `Select task: ${task.body || task.normalizedText}`);
          selCb.addEventListener('change', () => {
            if (selCb.checked) { selectedTasks.add(selectionKey); } else { selectedTasks.delete(selectionKey); }
            selectAllCb.checked = selectedTasks.size === tasks.length;
            selectAllCb.indeterminate = selectedTasks.size > 0 && selectedTasks.size < tasks.length;
            updateBulkBar();
          });
          li.prepend(selCb);

          // Drag handle and reorder events (#18)
          const dragHandle = document.createElement('span');
          dragHandle.addClass('task-manager-drag-handle');
          dragHandle.setAttr('aria-hidden', 'true');
          dragHandle.setText('⠇');
          li.insertBefore(dragHandle, selCb);
          li.setAttr('draggable', 'true');
          li.setAttr('aria-keyshortcuts', 'Alt+ArrowUp Alt+ArrowDown');
          li.setAttr('data-task-index', String(taskRowIdx));
          const capturedIdx = taskRowIdx;
          li.addEventListener('dragstart', (e: DragEvent) => {
            dragSrcIdx = capturedIdx;
            if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(capturedIdx)); }
            li.addClass('task-manager-drag-source');
          });
          li.addEventListener('dragend', () => {
            li.removeClass('task-manager-drag-source');
            for (const rowEl of Array.from(list.querySelectorAll('.task-manager-drag-over'))) {
              rowEl.classList.remove('task-manager-drag-over');
            }
            dragSrcIdx = null;
          });
          li.addEventListener('dragover', (e: DragEvent) => {
            e.preventDefault();
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
            if (dragSrcIdx !== null && dragSrcIdx !== capturedIdx) li.addClass('task-manager-drag-over');
          });
          li.addEventListener('dragleave', (e: DragEvent) => {
            const relatedTarget = e.relatedTarget;
            if (relatedTarget && li.contains(relatedTarget as Node)) return;
            li.removeClass('task-manager-drag-over');
          });
          li.addEventListener('drop', (e: DragEvent) => {
            e.preventDefault();
            li.removeClass('task-manager-drag-over');
            if (dragSrcIdx === null || dragSrcIdx === capturedIdx) return;
            list.dispatchEvent(new CustomEvent('task-manager-reorder', {
              detail: { from: dragSrcIdx, to: capturedIdx, tasks: renderedTaskKeys },
              bubbles: true,
            }));
            dragSrcIdx = null;
          });

          // Mobile swipe gesture
          if (this.getSettings().enableMobileGestures) {
            this.attachSwipeGesture(li, task, ctx.sourcePath, () => { void this.render(source, el, ctx); });
          }

          list.appendChild(li);
        }
        el.appendChild(list);
        el.insertBefore(bulkBar, list);

        // ── Drag-to-reorder event handler (#18) ───────────────────────────
        list.addEventListener('task-manager-reorder', ((e: CustomEvent) => {
          const detail = e.detail as { from: number; to: number; tasks: string[] };
          const srcTask = tasks.find((t) => t.key === detail.tasks[detail.from]);
          const destTask = tasks.find((t) => t.key === detail.tasks[detail.to]);
          if (!srcTask || !destTask) return;
          if (srcTask.filePath !== destTask.filePath) {
            new Notice('Cannot reorder tasks across different files');
            return;
          }
          void this.reorderTasksInFile(srcTask, destTask).then(() => { void this.render(source, el, ctx); });
        }) as EventListener);

        // ── Keyboard navigation ────────────────────────────────────────────
        list.setAttr('tabindex', '0');
        let focusedTaskKey: string | null = null;
        list.addEventListener('keydown', (e: KeyboardEvent) => {
          const active = typeof document !== 'undefined' ? document.activeElement : null;
          // Skip if focus is inside an input / textarea
          if (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement) return;
          if (e.ctrlKey || e.metaKey || e.repeat || e.isComposing) return;

          const rows = Array.from(list.querySelectorAll<HTMLElement>('.task-manager-query-item'));
          if (rows.length === 0) return;
          for (const row of rows) {
            row.setAttr('tabindex', row.classList.contains('task-manager-row-focused') ? '0' : '-1');
          }

          // Prefer key-based focus lookup over CSS-class for resilience after re-renders
          const focusedIndex = focusedTaskKey
            ? rows.findIndex((r) => r.getAttribute('data-task-key') === focusedTaskKey)
            : rows.findIndex((r) => r.classList.contains('task-manager-row-focused'));

          const moveFocus = (nextIndex: number): void => {
            rows.forEach((r) => { r.classList.remove('task-manager-row-focused'); r.setAttr('tabindex', '-1'); });
            const target = rows[nextIndex];
            if (target) {
              target.classList.add('task-manager-row-focused');
              target.setAttr('tabindex', '0');
              target.focus();
              target.scrollIntoView({ block: 'nearest' });
              focusedTaskKey = target.getAttribute('data-task-key');
              this.announcer?.announce(`Selected task: ${target.textContent?.trim() ?? ''}`);
            }
          };

          if (e.altKey && focusedIndex >= 0 && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
            e.preventDefault();
            const targetIndex = focusedIndex + (e.key === 'ArrowDown' ? 1 : -1);
            if (targetIndex < 0 || targetIndex >= rows.length) return;
            list.dispatchEvent(new CustomEvent('task-manager-reorder', {
              detail: { from: focusedIndex, to: targetIndex, tasks: renderedTaskKeys },
              bubbles: true,
            }));
            this.announcer?.announce(`Moving task ${rows[focusedIndex].textContent?.trim() ?? ''} ${e.key === 'ArrowDown' ? 'down' : 'up'}`);
            return;
          }

          if (e.altKey) return;
          const handled = handleQueryRowHotkey(e.key, {
            onDown: () => moveFocus(focusedIndex < 0 ? 0 : Math.min(focusedIndex + 1, rows.length - 1)),
            onUp: () => moveFocus(focusedIndex <= 0 ? 0 : focusedIndex - 1),
            onToggle: focusedIndex >= 0 ? () => rows[focusedIndex].querySelector<HTMLElement>('.task-manager-query-marker')?.click() : undefined,
            onEdit: focusedIndex >= 0 ? () => rows[focusedIndex].querySelector<HTMLElement>('.task-manager-query-edit')?.click() : undefined,
            onEditDate: focusedIndex >= 0 ? () => rows[focusedIndex].querySelector<HTMLElement>('.task-manager-query-metadata-date')?.click?.() : undefined,
            onEscape: () => {
              rows.forEach((r) => { r.classList.remove('task-manager-row-focused'); r.setAttr('tabindex', '-1'); });
              focusedTaskKey = null;
              list.focus();
            },
          });
          if (handled) {
            e.preventDefault();
            return;
          }
          if (focusedIndex >= 0 && e.key === 'o') {
            e.preventDefault();
            rows[focusedIndex].querySelector<HTMLElement>('.tasks-backlink')?.click();
          }
        });
      }
      // ── Compact stats bar (show stats layout instruction) ─────────────────
      if (query.layout.shown.has('stats') && !query.layout.hidden.has('stats')) {
        this.renderStatsBar(el, tasks);
      }
      if (showCount && this.getSettings().taskCountLocation === 'bottom') {
        this.renderTaskCount(el, tasks.length);
      }
    } catch (error) {
      if (!this.isCurrentRender(el, renderGeneration)) return;
      disposeQueryRenderResources(el);
      el.empty();
      el.addClass('task-manager-query');
      this.applyAppearanceClasses(el);
      this.renderMessage(
        el,
        `Task Manager query failed: ${error instanceof Error ? error.message : String(error)}`,
        'task-manager-query-error',
      );
      this.renderQueryLint(el, source);
    }
  }

  private isCurrentRender(el: HTMLElement, generation: number): boolean {
    const stillMounted = typeof (el as HTMLElement & { isConnected?: boolean }).isConnected === 'boolean'
      ? (el as HTMLElement & { isConnected: boolean }).isConnected
      : true;
    return stillMounted && !queryRenderDisposedElements.has(el) && this.renderGenerations.get(el) === generation;
  }

  private applyAppearanceClasses(el: HTMLElement): void {
    el.removeClass('task-manager-density-compact');
    el.removeClass('task-manager-density-comfortable');
    el.removeClass('task-manager-density-spacious');
    el.addClass(taskDensityClass(this.getSettings().taskDensity));
  }

  private applyQueryModeClasses(el: HTMLElement, query: TaskQuery): void {
    el.removeClass('task-manager-query-checklist');
    if (query.viewMode === 'checklist') {
      el.addClass('task-manager-query-checklist');
    }
  }

  private renderQueryLint(el: HTMLElement, source: string): void {
    const result = new QueryLinter().lint(source);
    if (result.errors.length === 0 && result.warnings.length === 0 && result.suggestions.length === 0) return;
    const container = el.createDiv({ cls: 'task-manager-query-lint' });
    const renderItems = (items: Array<{ line?: number; message: string; code?: string; suggestion?: string; fix?: string }>, cls: string): void => {
      for (const item of items) {
        const row = container.createDiv({ cls });
        row.setText(`${item.line ? `Line ${item.line}: ` : ''}${item.message}${item.suggestion ? ` (${item.suggestion})` : ''}${item.fix ? ` Suggested: ${item.fix}` : ''}`);
        if (item.code) row.setAttr('data-code', item.code);
      }
    };
    renderItems(result.errors, 'task-manager-query-lint-error');
    renderItems(result.warnings, 'task-manager-query-lint-warning');
    renderItems(result.suggestions, 'task-manager-query-lint-suggestion');
  }

  private parseQuery(source: string, sourcePath: string): TaskQuery {
    return new TaskQueryService(this.getSettings, (path) => this.fileInfo(path)).parse(source, { sourcePath });
  }

  private fileInfo(path: string): TaskFileInfo {
    const abstractFile = this.app.vault.getAbstractFileByPath(path);
    const file = this.isTFile(abstractFile) ? abstractFile : null;
    const cache = file ? (this.app.metadataCache as unknown as { getFileCache?: (file: TFile) => { frontmatter?: Record<string, unknown>; links?: Array<{ link: string }>; embeds?: Array<{ link: string }> } | null }).getFileCache?.(file) : null;
    const rawLinks = [...(cache?.links ?? []), ...(cache?.embeds ?? [])].map((link) => link.link).filter(Boolean);
    const outlinks = Array.from(new Set(rawLinks.flatMap((link) => [link, `[[${link}]]`])));
    return { properties: cache?.frontmatter ?? {}, outlinks };
  }

  private async collectTasks(source: string, query: TaskQuery, sourcePath: string): Promise<ParsedTask[]> {
    this.taskCache ??= this.getIndexedTasks ? this.getIndexedTasks() : this.scanVaultTasks();
    const cacheKey = `${this.cacheRevision}\0${queryResultCacheScope(source, query, sourcePath)}\0${source}`;
    let result = this.queryResultCache.get(cacheKey);
    if (!result) {
      result = this.taskCache.then((tasks) =>
        new TaskQueryService(this.getSettings, (path) => this.fileInfo(path)).filter(tasks, query, { sourcePath }));
      this.queryResultCache.set(cacheKey, result);
    }
    return [...await result];
  }

  private async scanVaultTasks(): Promise<ParsedTask[]> {
    const tasks: ParsedTask[] = [];
    for (const file of this.scannableMarkdownFiles()) {
      tasks.push(...await this.scanCachedFile(file));
    }
    tasks.push(...await this.scanCanvasTasks());
    return tasks;
  }

  private scannableMarkdownFiles(): TFile[] {
    const excluded = this.getSettings().excludedFolders ?? [];
    const files = this.app.vault.getMarkdownFiles();
    if (excluded.length === 0) return files;
    return files.filter((file) => {
      const lowerPath = file.path.toLowerCase();
      return !excluded.some((prefix) => lowerPath.startsWith(`${prefix}/`) || lowerPath === prefix);
    });
  }

  private async scanCanvasTasks(): Promise<ParsedTask[]> {
    const files = (this.app.vault as unknown as { getFiles?: () => TFile[] }).getFiles?.() ?? [];
    const excluded = this.getSettings().excludedFolders ?? [];
    const canvasFiles = files.filter((file) => {
      if (file.extension !== 'canvas') return false;
      if (excluded.length === 0) return true;
      const lowerPath = file.path.toLowerCase();
      return !excluded.some((prefix) => lowerPath.startsWith(`${prefix}/`) || lowerPath === prefix);
    });
    const tasks: ParsedTask[] = [];
    for (const file of canvasFiles) {
      try {
        const raw = await this.app.vault.read(file);
        const parsed = JSON.parse(raw) as { nodes?: Array<{ id?: string; type?: string; text?: string; content?: string }> };
        let virtualLine = 1;
        for (const node of parsed.nodes ?? []) {
          const nodeText = typeof node.text === 'string' ? node.text : typeof node.content === 'string' ? node.content : null;
          if (node.type !== 'text' || nodeText === null) continue;
          for (const line of nodeText.split(/\r?\n/u)) {
            const task = this.scanner.parseTaskLine(line, file.path, virtualLine, node.id ? `Canvas card ${node.id}` : 'Canvas card');
            if (task) tasks.push({ ...task, key: `${file.path}:canvas:${node.id ?? 'node'}:${virtualLine}:${task.key}` });
            virtualLine += 1;
          }
        }
      } catch (err) {
        console.warn('[task-manager] Failed to scan canvas tasks:', file.path, err);
      }
    }
    return tasks;
  }

  private async scanCachedFile(file: TFile): Promise<ParsedTask[]> {
    const fingerprint = this.fileFingerprint(file);
    const revision = this.fileCacheRevision(file.path);
    const cached = this.fileTaskCache.get(file.path);
    if (cached && cached.fingerprint === fingerprint && cached.revision === revision) {
      return cached.tasks;
    }
    const settings = this.getSettings();
    const tasks = await scanFileWithTaskNotes(file, this.app, this.scanner, settings);
    if (this.fileCacheRevision(file.path) === revision) {
      this.fileTaskCache.set(file.path, { fingerprint, revision, tasks });
    }
    return tasks;
  }

  private fileCacheRevision(path: string): number {
    this.globalInvalidationRevision ??= 0;
    this.fileInvalidationRevisions ??= new Map<string, number>();
    return Math.max(this.globalInvalidationRevision, this.fileInvalidationRevisions.get(path) ?? 0);
  }

  private fileFingerprint(file: TFile): string {
    const stat = (file as TFile & { stat?: { mtime?: number; size?: number } }).stat;
    return `${stat?.mtime ?? 0}:${stat?.size ?? 0}`;
  }

  private renderChecklistTasks(el: HTMLElement, tasks: ParsedTask[], ctx: MarkdownPostProcessorContext, query: TaskQuery, rerenderQuery: () => Promise<void>): void {
    // Honour a hand-arranged order when present (stable fallback keeps the query's own order for
    // tasks without an [order:: N] marker), so drag-to-reorder survives a re-scan.
    const ordered = sortTasksWithManualOrder(tasks, () => 0);
    const list = document.createElement('ul');
    list.addClass('task-manager-query-list', 'task-manager-checklist-list');
    list.addClass('contains-task-list', 'plugin-tasks-query-result');
    for (const cls of upstreamLayoutHideClasses(query)) list.addClass(cls);
    list.setAttr('role', 'list');
    list.setAttr('aria-label', `Task checklist with ${ordered.length} tasks`);
    list.setAttr('aria-live', 'polite');
    list.setAttr('aria-atomic', 'false');

    const rows: HTMLElement[] = [];
    const reorderableTasks = ordered.filter((task) => isManualOrderWritableTask(task));
    const reorderIndex = new Map(reorderableTasks.map((task, index) => [task, index] as const));
    for (const task of ordered) {
      const li = this.renderTask(task, ctx, query, rerenderQuery, ordered, { checklist: true, enableCrossViewDrag: false });
      if (isManualOrderWritableTask(task)) {
        const handle = document.createElement('span');
        handle.addClass('task-manager-drag-handle');
        handle.setAttr('aria-hidden', 'true');
        handle.setAttr('title', 'Drag to reorder');
        handle.setText('⠿');
        li.prepend(handle);
        rows.push(li);
        const position = reorderIndex.get(task) ?? 0;
        const controls = document.createElement('span');
        controls.addClass('task-manager-reorder-controls');
        controls.setAttr('role', 'group');
        controls.setAttr('aria-label', `Reorder ${task.normalizedText}, position ${position + 1} of ${reorderableTasks.length}`);
        const move = (label: string, target: number): HTMLButtonElement => {
          const button = document.createElement('button');
          button.addClass('task-manager-reorder-button');
          button.setAttr('type', 'button');
          button.setAttr('aria-label', `${label} ${task.normalizedText}`);
          button.setText(label === 'Move up' ? '↑' : '↓');
          button.disabled = target < 0 || target >= reorderableTasks.length;
          button.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            void this.persistChecklistReorder(reorderableTasks, position, target, rerenderQuery)
              .catch((error) => new Notice(`Task Manager: ${error instanceof Error ? error.message : String(error)}`));
          });
          return button;
        };
        controls.appendChild(move('Move up', position - 1));
        controls.appendChild(move('Move down', position + 1));
        li.appendChild(controls);
      }
      list.appendChild(li);
    }

    attachManualDrag(rows, (from, to) => {
      void this.persistChecklistReorder(reorderableTasks, from, to, rerenderQuery)
        .catch((error) => new Notice(`Task Manager: ${error instanceof Error ? error.message : String(error)}`));
    });

    el.appendChild(list);
  }

  /** Persist a checklist drag-reorder as `[order:: N]` markers, then invalidate caches and re-render. */
  private async persistChecklistReorder(tasks: readonly ParsedTask[], from: number, to: number, rerenderQuery: () => Promise<void>): Promise<void> {
    if (from === to || from < 0 || to < 0 || from >= tasks.length || to >= tasks.length) return;
    const movedKey = tasks[from].key;
    const keysAfter = applyRowMove(tasks.map((t) => t.key), from, to);
    const orderByKey = new Map(tasks.map((t) => [t.key, t.metadata.manualOrder] as const));
    const taskByKey = new Map(tasks.map((t) => [t.key, t] as const));
    const writes = planManualReorder(keysAfter, movedKey, (key) => orderByKey.get(key));
    await applyManualOrderWrites(this.app, writes, taskByKey, this.taskMutations, this.scanner);
    if (!this.taskMutations) {
      for (const write of writes) {
        const task = taskByKey.get(write.key);
        if (task) this.invalidateCache(task.filePath);
      }
    }
    await rerenderQuery();
  }

  private renderGroupedTasks(el: HTMLElement, groups: GroupedTaskNode<ParsedTask>[], ctx: MarkdownPostProcessorContext, source: string, headingLevel: number, allTasks?: ParsedTask[], parsedQuery?: TaskQuery): void {
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      const group = groups[groupIndex];
      if (group.name) {
        const heading = document.createElement(`h${Math.min(6, headingLevel)}`);
        heading.addClass('task-manager-query-group-heading');
        // Mirror upstream HtmlQueryResultsRenderer.addGroupHeading: themes target
        // `.tasks-group-heading` for group-heading styling.
        heading.addClass('tasks-group-heading');
        // Render the group name as markdown so wikilinks like `[[note]]` (emitted
        // by the filename / backlink groupers) render as clickable internal links.
        this.renderTaskText(heading, group.name, ctx.sourcePath);
        el.appendChild(heading);
      }
      if (group.children) {
        this.renderGroupedTasks(el, group.children, ctx, source, headingLevel + 1, allTasks, parsedQuery);
      }
      if (group.tasks) {
        const list = document.createElement('ul');
        list.addClass('task-manager-query-list');
        if (parsedQuery?.viewMode === 'checklist') list.addClass('task-manager-checklist-list');
        list.addClass('contains-task-list', 'plugin-tasks-query-result');
        const query = parsedQuery ?? this.parseQuery(source, ctx.sourcePath);
        for (const cls of upstreamLayoutHideClasses(query)) list.addClass(cls);
        for (const task of group.tasks) {
          list.appendChild(this.renderTask(task, ctx, query, () => this.render(source, el, ctx), allTasks, { checklist: query.viewMode === 'checklist', enableCrossViewDrag: query.viewMode !== 'checklist' }));
        }
        el.appendChild(list);
        
        // Render aggregation footer if available
        if (group.aggregations && (group.aggregations.effortSum || group.aggregations.overdueCount)) {
          const aggFooter = document.createElement('div');
          aggFooter.addClass('task-manager-aggregation-footer');
          aggFooter.style.cssText = 'padding: 0.5em 1em; font-size: 0.9em; color: var(--text-muted); border-top: 1px solid var(--background-modifier-border);';
          
          const parts: string[] = [];
          if (group.aggregations.effortSum) {
            parts.push(`📊 Effort: ${group.aggregations.effortSum}`);
          }
          if (group.aggregations.overdueCount) {
            parts.push(`⚠️ Overdue: ${group.aggregations.overdueCount}`);
          }
          
          aggFooter.setText(parts.join(' | '));
          el.appendChild(aggFooter);
        }
      }
      // Add a thin visual separator between sibling groups (not after the last one).
      if (groupIndex < groups.length - 1) {
        const separator = document.createElement('hr');
        separator.addClass('task-manager-group-separator');
        el.appendChild(separator);
      }
    }
  }

  private renderTask(task: ParsedTask, ctx: MarkdownPostProcessorContext, query: TaskQuery, rerenderQuery: () => Promise<void>, allTasks?: ParsedTask[], options: RenderTaskOptions = { enableCrossViewDrag: true }): HTMLLIElement {
    let currentTask = task;
    const item = document.createElement('li');
    item.addClass('task-manager-query-item');
    if (options.checklist) item.addClass('task-manager-checklist-item');
    // Stock-Obsidian + upstream Tasks compatibility classes/attributes so themes
    // that style `[data-task]`, `.task-list-item`, `.task-due`, etc. work here.
    item.addClass('task-list-item');
    item.addClass('plugin-tasks-list-item');
    // Apply priority and status colors
    const priority = currentTask.metadata.priority || 'normal';
    item.addClass(getPriorityColorClass(priority));
    item.addClass(getStatusColorClass(currentTask.checkbox));
    // Style projected tasks with reduced opacity and recurring indicator
    if (task.isProjected) {
      item.addClass('task-manager-query-item--projected');
    }
    item.setAttr('data-line', String(task.lineNumber));
    item.setAttr('data-task-key', task.key);
    // Expose tag list as a data attribute so the tag filter can query it without
    // parsing the rendered text (comma-separated, no # prefix).
    item.setAttr('data-task-tags', task.tags.join(','));

    const marker = document.createElement('button');
    marker.addClass('task-manager-query-marker');
    marker.addClass('task-list-item-checkbox');
    marker.setAttr('type', 'button');
    marker.setAttr('data-line', String(task.lineNumber));
    // Add ARIA label for accessibility
    const isComplete = currentTask.checkbox === 'x' || currentTask.checkbox === 'X';
    const shortText = currentTask.normalizedText.substring(0, 50) + (currentTask.normalizedText.length > 50 ? '...' : '');
    marker.setAttr('aria-label', `${isComplete ? 'Completed' : 'Pending'}: ${shortText}. Press Space or X to toggle, E to edit, D for date, J/K to navigate`);
    marker.setAttr('aria-pressed', String(isComplete));
    // Add recurring icon for projected tasks
    if (task.isProjected) {
      marker.setAttr('data-projected', 'true');
    }
    if (options.checklist) {
      const markerHit = document.createElement('span');
      markerHit.addClass('task-manager-query-marker-hit');
      markerHit.appendChild(marker);
      markerHit.addEventListener('click', (event) => {
        if (event.target === markerHit) marker.click();
      });
      item.appendChild(markerHit);
    } else {
      item.appendChild(marker);
    }

    // Card body holds a headline row (description + inline badges) stacked above a
    // compact metadata row. Action buttons live in a separate hover-reveal cluster.
    const body = document.createElement('div');
    body.addClass('task-manager-query-body');
    const headline = document.createElement('div');
    headline.addClass('task-manager-query-headline');
    body.appendChild(headline);
    const actions = document.createElement('div');
    actions.addClass('task-manager-query-actions');

    const text = document.createElement('span');
    text.addClass('task-manager-query-text');
    text.addClass('task-description');
    text.addClass('tasks-list-text');
    headline.appendChild(text);

    if (!this.isCanvasBackedTask(currentTask)) {
      text.addClass('task-manager-desc-editable');
      text.setAttr('title', 'Double-click to edit description');
      // Inline description editing on double-click
      text.addEventListener('dblclick', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const editKey = `${currentTask.filePath}:${currentTask.lineNumber}`;
        if (activeDescEdits.has(editKey)) return;
        activeDescEdits.add(editKey);
        const originalText = currentTask.normalizedText;
        const input = document.createElement('input');
        input.type = 'text';
        input.value = originalText;
        input.className = 'task-manager-desc-input';
        text.empty();
        text.appendChild(input);
        input.focus();
        input.select();
        const commit = async (): Promise<void> => {
          activeDescEdits.delete(editKey);
          const newDesc = input.value.trim();
          let renderedText = originalText;
          if (newDesc && newDesc !== originalText) {
            try {
              await this.updateTaskDescription(currentTask, newDesc);
              renderedText = newDesc;
            } catch {
              new Notice('Task Manager: could not save description — file was modified by another process');
            }
          }
          this.renderTaskText(text, renderedText, currentTask.filePath);
          void rerenderQuery();
        };
        const cancel = (): void => {
          activeDescEdits.delete(editKey);
          this.renderTaskText(text, originalText, currentTask.filePath);
        };
        input.addEventListener('keydown', (e: KeyboardEvent) => {
          if (e.key === 'Enter') { e.preventDefault(); void commit(); }
          else if (e.key === 'Escape') { e.preventDefault(); cancel(); }
        });
        input.addEventListener('blur', () => { if (activeDescEdits.has(editKey)) void commit(); });
      });
    }

    if (query.layout.shortMode) {
      this.attachShortModeTooltip(text, () => currentTask, ctx);
    }

    // ── Subtask progress badge (flat / group view) ────────────────────────────
    // Tree view manages its own badge; only show here when allTasks is provided.
    if (allTasks && allTasks.length > 0 && !query.layout.hidden.has('progress')) {
      const parentIndent = task.rawLine.match(/^(\s*)/u)?.[1]?.length ?? 0;
      const sameFileLater = allTasks
        .filter((t) => t.filePath === task.filePath && t.lineNumber > task.lineNumber)
        .sort((a, b) => a.lineNumber - b.lineNumber);
      const children: ParsedTask[] = [];
      for (const t of sameFileLater) {
        const childIndent = t.rawLine.match(/^(\s*)/u)?.[1]?.length ?? 0;
        if (childIndent <= parentIndent) break;
        children.push(t);
      }
      if (children.length > 0) {
        const doneCnt = children.filter(
          (t) => t.status === 'done' || t.status === 'cancelled',
        ).length;
        const progressEl = document.createElement('span');
        progressEl.addClass('task-manager-subtask-progress');
        progressEl.setText(` [${doneCnt}/${children.length}]`);
        if (doneCnt === children.length) progressEl.addClass('task-manager-subtask-progress--complete');
        progressEl.setAttr('title', `${doneCnt} of ${children.length} subtasks done`);
        headline.appendChild(progressEl);
      }
    }

    // ── Comment count badge ──────────────────────────────────────────────────
    if (task.metadata.comments && task.metadata.comments.length > 0) {
      const commentBadge = document.createElement('span');
      commentBadge.addClass('task-manager-comment-badge');
      commentBadge.setText(` 💬${task.metadata.comments.length}`);
      commentBadge.setAttr('title', task.metadata.comments.map((c, i) => `${i + 1}. ${c}`).join('\n'));
      headline.appendChild(commentBadge);
    }

    const meta = document.createElement('span');
    meta.addClass('task-manager-query-meta');
    if (!query.layout.hidden.has('backlink')) {
      this.appendSourceLink(meta, currentTask, ctx, Boolean(query.layout.shortMode));
    }
    this.appendMetadata(meta, currentTask, query, async () => rerenderQuery(), allTasks);
    body.appendChild(meta);

    if (this.getSettings().recurringHeatmapEnabled && !query.layout.hidden.has('heatmap')) {
      const heatmap = renderRecurrenceHeatmap(currentTask, allTasks ?? [], this.recurrenceHistoryDates(currentTask));
      if (heatmap) body.appendChild(heatmap);
    }

    if (!query.layout.hidden.has('urgency') && query.layout.shown.has('urgency')) {
      const urgency = document.createElement('span');
      urgency.addClass('task-manager-query-urgency');
      // Upstream theme class — see Renderer.scss `.tasks-urgency`.
      urgency.addClass('tasks-urgency');
      urgency.setText(`urgency ${calculateUrgency(currentTask).toFixed(2)}`);
      meta.appendChild(urgency);
    }

    if (!options.checklist && !query.layout.hidden.has('defer button') && this.canPostpone(currentTask)) {
      const defer = document.createElement('button');
      defer.addClass('task-manager-query-defer');
      defer.addClass('tasks-postpone');
      if (query.layout.shortMode) defer.addClass('tasks-postpone-short-mode');
      defer.setAttr('type', 'button');
      defer.setText('⏩');
      defer.setAttr('title', 'Postpone task');
      defer.setAttr('aria-label', `Postpone task: ${currentTask.body || currentTask.normalizedText}`);
      defer.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this.deferTask(currentTask, 1).then(async (updated) => { currentTask = updated; await rerenderQuery(); });
      });
      defer.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        this.openDeferMenu(event, currentTask, async () => rerenderQuery());
      });
      actions.appendChild(defer);
    }

    if (!options.checklist && !query.layout.hidden.has('edit button') && this.onEditTask) {
      const edit = document.createElement('button');
      edit.addClass('task-manager-query-edit');
      edit.addClass('tasks-edit');
      edit.setAttr('type', 'button');
      edit.setText('✎');
      edit.setAttr('title', 'Edit task');
      edit.setAttr('aria-label', `Edit task: ${currentTask.body || currentTask.normalizedText}`);
      edit.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.onEditTask?.(currentTask, () => { void rerenderQuery(); });
      });
      actions.appendChild(edit);
    }

    // 🎯 Focus timer button
    if (!options.checklist && !query.layout.hidden.has('focus timer') && !query.layout.hidden.has('timer')) {
      const timerBtn = document.createElement('button');
      timerBtn.addClass('task-manager-query-timer');
      timerBtn.setAttr('type', 'button');
      timerBtn.setText('🎯');
      timerBtn.setAttr('title', 'Start / stop focus timer for this task');
      timerBtn.setAttr('aria-label', `Start or stop focus timer for task: ${currentTask.body || currentTask.normalizedText}`);
      const taskKey = currentTask.key;
      const existingTimer = focusTimers.get(taskKey);
      if (existingTimer) {
        timerBtn.addClass('task-manager-timer-active');
        timerBtn.setAttr('aria-pressed', 'true');
        existingTimer.btnEl = timerBtn;
      }
      if (!existingTimer) timerBtn.setAttr('aria-pressed', 'false');
      timerBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        if (focusTimers.has(taskKey)) {
          stopFocusTimer(taskKey, this.onFocusTime, currentTask);
        } else {
          // Stop any other running timer
          for (const [k] of focusTimers) { stopFocusTimer(k, this.onFocusTime); }
          const startMs = Date.now();
          const intervalId = setInterval(() => {
            const activeTimer = focusTimers.get(taskKey);
            if (!activeTimer) return;
            activeTimer.btnEl.setText(formatElapsed(Date.now() - activeTimer.startMs));
          }, 1_000);
          focusTimers.set(taskKey, { startMs, intervalId, btnEl: timerBtn, task: currentTask });
          timerBtn.addClass('task-manager-timer-active');
          timerBtn.setAttr('aria-pressed', 'true');
        }
      });
      actions.appendChild(timerBtn);
    }

    const refreshTaskDisplay = (updatedTask: ParsedTask): void => {
      currentTask = updatedTask;
      const states = this.getSettings().supportedStates;
      const state = states.find((s) => s.rawText === currentTask.checkbox);
      marker.setText(taskStateIcon(currentTask.checkbox, states));
      marker.setAttr('aria-label', `${taskStateLabel(currentTask.checkbox, states)}: ${currentTask.normalizedText}`);
      marker.setAttr('aria-pressed', currentTask.status === 'done' ? 'true' : 'false');
      marker.setAttr('title', options.checklist
        ? 'Click to complete · right-click for status'
        : (currentTask.filePath.endsWith('.canvas') ? 'Advance Canvas task state' : 'Advance source task state'));
      // data-task carries the raw status symbol so themes can style per-state
      item.setAttr('data-task', currentTask.checkbox.trim());
      if (state) {
        item.setAttr('data-task-status-name', state.name);
        // Emit upstream's uppercase StatusType for theme compatibility while
        // preserving the original lowercase value on a secondary attribute.
        const upstreamType = UPSTREAM_STATUS_TYPE[state.type] ?? state.type.toUpperCase();
        item.setAttr('data-task-status-type', upstreamType);
        item.setAttr('data-task-status-type-local', state.type);
      }
      // Mirror upstream: always set a task-priority data attribute (default 'normal')
      const priority = currentTask.metadata.priority || 'normal';
      item.setAttr('data-task-priority', priority);
      for (const className of this.classNames(item)) {
        if (/^task-priority-/u.test(className) || /^task-status-/u.test(className)) item.removeClass(className);
      }
      // Apply color-coded priority class
      item.addClass(`task-priority-${priority}`);
      // Apply color-coded status class based on state type
      if (state?.type) {
        item.addClass(`task-status-${state.type}`);
      } else {
        // Fallback for custom states without a type
        const statusMap: Record<string, string> = {
          ' ': 'task-status-todo',
          'x': 'task-status-done',
          '/': 'task-status-in-progress',
          '-': 'task-status-cancelled',
          '!': 'task-status-blocked',
        };
        const fallbackClass = statusMap[currentTask.checkbox.trim()] || 'task-status-todo';
        item.addClass(fallbackClass);
      }
      // Upstream toggles `is-checked` on the `<li>` for done/cancelled-style states
      // (TaskLineRenderer line 162 / 479). Themes use it to strike through completed tasks.
      if (currentTask.status === 'done' || currentTask.status === 'cancelled') {
        item.addClass('is-checked');
      } else {
        item.removeClass('is-checked');
      }
      this.renderTaskText(text, currentTask.normalizedText, currentTask.filePath);
    };

    marker.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      marker.disabled = true;
      void (options.checklist
        ? this.toggleTaskDone(currentTask, ctx.sourcePath)
        : this.toggleTaskStatus(currentTask, ctx.sourcePath))
        .then(async (updatedTask) => {
          refreshTaskDisplay(updatedTask);
          await rerenderQuery();
        })
        .catch((error) => {
          new Notice(`Task Manager: ${error instanceof Error ? error.message : String(error)}`);
        })
        .finally(() => { marker.disabled = false; });
    });

    marker.addEventListener('contextmenu', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.openStatusMenu(event, currentTask, ctx.sourcePath, async (updatedTask) => {
        refreshTaskDisplay(updatedTask);
        await rerenderQuery();
      });
    });

    // Item-level context menu: right-click (desktop) or left swipe (mobile)
    // anywhere on the row (not the marker/buttons) to move, set the status, or
    // delete the task.
    const buildItemMenu = (): Menu => {
      const ctxMenu = new Menu();
      ctxMenu.addItem((menuItem) => {
        menuItem
          .setTitle('Move to file\u2026')
          .setIcon('file-input')
          .onClick(() => {
            new TaskMoveToFilePicker(this.app, async (targetFile) => {
              try {
                await this.moveTaskToFile(currentTask, targetFile);
                this.invalidateCache(currentTask.filePath);
                this.invalidateCache(targetFile.path);
                await rerenderQuery();
              } catch (err) {
                new Notice(`Task Manager: ${err instanceof Error ? err.message : String(err)}`);
              }
            }).open();
          });
      });
      ctxMenu.addSeparator();
      for (const state of this.getSettings().supportedStates) {
        ctxMenu.addItem((menuItem) => menuItem
          .setTitle(`Set: ${state.name} [${state.rawText}]`)
          .onClick(() => {
            void this.setTaskCheckbox(currentTask, ctx.sourcePath, state.rawText)
              .then(async (updated) => { refreshTaskDisplay(updated); await rerenderQuery(); })
              .catch((error) => new Notice(`Task Manager: ${error instanceof Error ? error.message : String(error)}`));
          }));
      }
      // Deleting Canvas-backed tasks by line splicing would corrupt the Canvas
      // JSON, so the delete affordance is markdown-only.
      if (!this.isCanvasBackedTask(currentTask)) {
        ctxMenu.addSeparator();
        ctxMenu.addItem((menuItem) => menuItem
          .setTitle('Delete task')
          .setIcon('trash')
          .setWarning(true)
          .onClick(() => {
            new TaskDeleteConfirmModal(this.app, currentTask.normalizedText, async () => {
              try {
                await this.deleteTask(currentTask);
                await rerenderQuery();
              } catch (err) {
                new Notice(`Task Manager: ${err instanceof Error ? err.message : String(err)}`);
              }
            }).open();
          }));
      }
      return ctxMenu;
    };

    // Skip the row menu when the gesture targets a control that owns its own
    // menu/action (status marker, defer/edit/timer buttons).
    const shouldSkipItemMenu = (target: HTMLElement | null): boolean =>
      Boolean(target?.closest(
        '.task-manager-query-marker, .task-manager-query-defer, .task-manager-query-edit, .task-manager-query-timer',
      ));

    item.addEventListener('contextmenu', (event) => {
      if (shouldSkipItemMenu(event.target as HTMLElement)) return;
      event.preventDefault();
      event.stopPropagation();
      buildItemMenu().showAtMouseEvent(event);
    });

    this.attachSwipeMenu(item, (target) => {
      if (shouldSkipItemMenu(target)) return;
      const rect = item.getBoundingClientRect();
      buildItemMenu().showAtPosition({ x: rect.right - 8, y: rect.top + 8 });
    });

    // Assemble the card: marker · body (headline + meta) · actions cluster.
    item.appendChild(body);
    if (actions.children.length > 0) item.appendChild(actions);

    // Setup cross-view drag support for richer list views. Checklist mode stays native-looking.
    if (options.enableCrossViewDrag !== false) {
      setupListTaskDrag(item, currentTask);
    }

    refreshTaskDisplay(currentTask);
    return item;
  }

  private async updateTaskDescription(currentTask: ParsedTask, newDesc: string): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(currentTask.filePath) as TFile | null;
    if (!file) return;
    await this.app.vault.process(file, (content) => {
      const lines = splitContentLines(content);
      const lineIdx = currentTask.lineNumber - 1;
      const line = lines[lineIdx];
      if (!line) throw new Error(`Cannot update task: line ${currentTask.lineNumber} no longer exists`);
      const parsedCurrent = this.scanner.parseTaskLine(line.text, currentTask.filePath, currentTask.lineNumber, currentTask.heading);
      if (!parsedCurrent) throw new Error(`Cannot update task: line ${currentTask.lineNumber} is no longer a task`);
      if (parsedCurrent.status !== currentTask.status) throw new Error(`Cannot update task: line ${currentTask.lineNumber} status changed since it was rendered`);
      if (sourceLineIdentity(line.text) !== sourceLineIdentity(currentTask.rawLine)) throw new Error(`Cannot update task: line ${currentTask.lineNumber} no longer matches the rendered task`);
      line.text = replaceDescriptionInLine(line.text, newDesc);
      return lines.map((l) => `${l.text}${l.lineEnding}`).join('');
    });
  }

  private attachShortModeTooltip(textSpan: HTMLElement, getTask: () => ParsedTask, ctx: MarkdownPostProcessorContext): void {
    if (typeof document === 'undefined' || typeof textSpan.addEventListener !== 'function') return;
    textSpan.addEventListener('mouseenter', (enterEvent: MouseEvent) => {
      const task = getTask();
      // Remove any stray tooltip left over from a re-render that replaced the
      // hovered row before its mouseleave could fire.
      document.querySelectorAll('.task-manager-tooltip').forEach((node) => node.remove());
      const tooltip = document.createElement('div');
      tooltip.addClass('task-manager-tooltip', 'task-manager-tooltip-popup');
      // NB: intentionally NOT adding Obsidian's native `tooltip`/`pop-up`
      // classes — their app-level opacity/animation rules render this custom
      // popup translucent. We supply our own solid styling + fade animation.

      const appendLine = (line: string): void => {
        const div = document.createElement('div');
        div.setText(line);
        tooltip.appendChild(div);
      };

      if (task.metadata.recurrence) appendLine(`🔁 ${task.metadata.recurrenceRaw ?? task.metadata.recurrence}`);

      const dateRows: Array<[string, string | undefined]> = [
        ['➕', task.metadata.dates.created],
        ['🛫', task.metadata.dates.start],
        ['⏳', task.metadata.dates.scheduled],
        ['📅', task.metadata.dates.due],
        ['❌', task.metadata.dates.cancelled],
        ['✅', task.metadata.dates.done],
      ];
      for (const [symbol, value] of dateRows) {
        if (value) appendLine(`${symbol} ${formatDateWithDay(value)}`);
      }
      if (task.metadata.reminder) appendLine(`⏰ ${formatDateWithDay(task.metadata.reminder)}`);

      const abstractFile = this.app.vault.getAbstractFileByPath(task.filePath);
      const file = this.isTFile(abstractFile) ? abstractFile : null;
      const linkText = file ? this.app.metadataCache.fileToLinktext(file, ctx.sourcePath, true) : task.filePath.replace(/\.md$/iu, '');
      const displayName = file?.basename ?? linkText;
      const backlinkText = task.heading && task.heading !== displayName
        ? `${displayName} > ${task.heading}:${task.lineNumber}`
        : `${displayName}:${task.lineNumber}`;
      appendLine(`🔗 ${backlinkText}`);

      // Anchor the tooltip to the cursor (fixed positioning) and keep it inside
      // the viewport, so it never dumps a large box over the task list.
      const place = (event: MouseEvent): void => {
        const margin = 12;
        let x = event.clientX + margin;
        let y = event.clientY + margin;
        const rect = tooltip.getBoundingClientRect();
        if (x + rect.width > window.innerWidth - 8) x = event.clientX - rect.width - margin;
        if (y + rect.height > window.innerHeight - 8) y = event.clientY - rect.height - margin;
        tooltip.style.left = `${Math.max(8, x)}px`;
        tooltip.style.top = `${Math.max(8, y)}px`;
      };
      // Append to <body> (not the row) so the fixed-position coordinates map
      // directly to the viewport and aren't affected by any transformed /
      // overflow-clipped ancestor of the task list.
      document.body.appendChild(tooltip);
      place(enterEvent);
      const onMove = (event: MouseEvent): void => place(event);
      textSpan.addEventListener('mousemove', onMove);
      textSpan.addEventListener('mouseleave', () => {
        tooltip.remove();
        textSpan.removeEventListener('mousemove', onMove);
      }, { once: true });
    });
  }

  private renderTaskText(container: HTMLElement, markdown: string, sourcePath: string): void {
    container.empty();
    const decorateTags = (): void => {
      // Mirror upstream: annotate rendered tag anchors with a sanitised data-tag-name
      // attribute so themes can style individual tags.
      const elements = (container as unknown as { getElementsByClassName?: (cls: string) => ArrayLike<HTMLElement> }).getElementsByClassName?.('tag');
      if (!elements) return;
      for (let index = 0; index < elements.length; index += 1) {
        const el = elements[index] as HTMLElement | undefined;
        if (!el) continue;
        const tagText = el.textContent ?? '';
        if (!tagText) continue;
        const sanitised = tagText.replace(/["&\x00\r\n]/gu, '-').replace(/^[-_]+/u, '');
        if (sanitised) {
          if (el.dataset) (el).dataset.tagName = sanitised;
          else el.setAttribute?.('data-tag-name', sanitised);
        }
      }
    };
    try {
      const renderer = MarkdownRenderer as unknown as { renderMarkdown?: (markdown: string, el: HTMLElement, sourcePath: string, owner?: Component) => Promise<void> | void };
      if (typeof renderer.renderMarkdown === 'function') {
        const result = renderer.renderMarkdown(markdown, container, sourcePath, this.owner);
        if (result && typeof (result).then === 'function') {
          void (result).then(decorateTags).catch(() => undefined);
        } else {
          decorateTags();
        }
        return;
      }
    } catch {
      // Fall back to plain text below in tests or old Obsidian versions.
    }
    container.setText(markdown);
  }

  private appendSourceLink(container: HTMLElement, task: ParsedTask, ctx: MarkdownPostProcessorContext, shortMode = false): void {
    const abstractFile = this.app.vault.getAbstractFileByPath(task.filePath);
    const file = this.isTFile(abstractFile) ? abstractFile : null;
    const linkText = file ? this.app.metadataCache.fileToLinktext(file, ctx.sourcePath, true) : task.filePath.replace(/\.md$/iu, '');
    const displayName = file?.basename ?? linkText;

    const link = document.createElement('a');
    link.addClass('internal-link');
    link.addClass('tasks-backlink');
    link.setAttr('href', linkText);
    link.setAttr('data-href', linkText);
    const visibleText = formatBacklinkVisibleText(displayName, task.heading);
    const titleText = task.heading && task.heading !== displayName ? `${displayName} > ${task.heading}:${task.lineNumber}` : `${displayName}:${task.lineNumber}`;
    link.setText(shortMode ? '🔗' : visibleText);
    link.setAttr('title', file ? `Open ${titleText}` : 'Open source note; line targeting unavailable');
    link.addEventListener('click', (event) => {
      event.preventDefault();
      void this.openSource(file, linkText, ctx.sourcePath, task.lineNumber, event);
    });
    container.appendChild(link);
  }

  private appendMetadata(container: HTMLElement, task: ParsedTask, query: TaskQuery, rerender: () => Promise<void>, allTasksForNav?: readonly ParsedTask[]): void {
    const metadata: Array<{ key: string; value: string; field?: DateField }> = [];
    const fmt = this.getSettings().dateDisplayFormat;
    // In the compact checklist view, dates read as short relative labels
    // (Today / Tomorrow / Fri / Jun 5) so a planning list stays scannable.
    const compact = query.viewMode === 'checklist';
    const fmtDate = (date: string, time?: string): string =>
      compact ? compactDateLabel(date, time) : `${formatDateWithDay(date, fmt)}${time ? ` ${time}` : ''}`;
    metadata.push({ key: 'id', value: task.metadata.id ? `id ${task.metadata.id}` : '' });
    metadata.push({ key: 'depends on', value: task.metadata.dependsOn.length ? `depends ${task.metadata.dependsOn.join(',')}` : '' });
    metadata.push({ key: 'due date', value: task.metadata.dates.due ? `due ${fmtDate(task.metadata.dates.due, task.metadata.dates.dueTime)}` : '', field: 'due' });
    metadata.push({ key: 'scheduled date', value: task.metadata.dates.scheduled ? `scheduled ${fmtDate(task.metadata.dates.scheduled, task.metadata.dates.scheduledTime)}` : '', field: 'scheduled' });
    metadata.push({ key: 'start date', value: task.metadata.dates.start ? `start ${fmtDate(task.metadata.dates.start, task.metadata.dates.startTime)}` : '', field: 'start' });
    metadata.push({ key: 'created date', value: task.metadata.dates.created ? `created ${fmtDate(task.metadata.dates.created)}` : '', field: 'created' });
    metadata.push({ key: 'done date', value: task.metadata.dates.done ? `done ${fmtDate(task.metadata.dates.done)}` : '', field: 'done' });
    metadata.push({ key: 'cancelled date', value: task.metadata.dates.cancelled ? `cancelled ${fmtDate(task.metadata.dates.cancelled)}` : '', field: 'cancelled' });
    metadata.push({ key: 'reminder date', value: task.metadata.reminder ? `reminder ${fmtDate(task.metadata.reminder)}` : '', field: 'reminder' });
    metadata.push({ key: 'priority', value: task.metadata.priority !== 'normal' ? `priority ${task.metadata.priority}` : '' });
    metadata.push({ key: 'pinned', value: task.metadata.pinned ? '📌 pinned' : '' });
    metadata.push({ key: 'cost', value: task.metadata.cost !== undefined ? `cost ${task.metadata.cost}` : '' });
    metadata.push({ key: 'recurrence rule', value: task.metadata.recurrence ? `recurs ${task.metadata.recurrenceRaw ?? task.metadata.recurrence}` : '' });
    metadata.push({ key: 'on completion', value: task.metadata.onCompletion ? `on completion ${task.metadata.onCompletion}` : '' });
    metadata.push({ key: 'block link', value: task.metadata.blockLink ? task.metadata.blockLink : '' });
    // NOTE: tags are intentionally NOT duplicated here — they already render inline
    // within the description text as pill anchors, so repeating them as metadata is noise.
    // Effort and actual time (new fields)
    if (task.metadata.effort && !query.layout.hidden.has('effort')) {
      metadata.push({ key: 'effort', value: `⏱️ ${task.metadata.effort}` });
    }
    if (task.metadata.actual && !query.layout.hidden.has('actual')) {
      metadata.push({ key: 'actual', value: `🕐 ${task.metadata.actual}` });
    }

    for (const { key, value, field } of metadata) {
      if (!value || query.layout.hidden.has(key)) continue;
      const metadataEl = document.createElement('span');
      metadataEl.addClass('task-manager-query-metadata');
      // Add upstream-compatible semantic class so themes can target each field type.
      const semanticClass = SEMANTIC_FIELD_CLASS[key];
      if (semanticClass) metadataEl.addClass(semanticClass);
      metadataEl.setAttr('title', value);
      metadataEl.setText(query.layout.shortMode ? shortMetadataText(key, value) : metadataChipLabel(key, value));
      if (field) {
        metadataEl.addClass('task-manager-query-metadata-date');
        metadataEl.setAttr('data-task-manager-date-field', field);
        // Upstream-compatible relative-date data attribute (e.g. data-task-due="today", "past-1d", "future-3d", "far").
        const dateValue = field === 'reminder' ? task.metadata.reminder?.slice(0, 10) : (task.metadata.dates as Record<string, string | undefined>)[field];
        const datasetKey = DATE_DATASET_KEY[field];
        if (dateValue && datasetKey) {
          const relative = relativeDateAttribute(dateValue, todayString());
          if (relative) metadataEl.setAttr(datasetKey, relative);
        }
        if (isEditableDateField(field)) {
          makeKeyboardButton(metadataEl, `${value}. Choose a date`, () => this.openDatePicker(task, field, rerender)); metadataEl.setAttr('title', `${value} — click to choose a date, right-click for quick adjustments`);
          metadataEl.addEventListener('click', (event) => { event.preventDefault(); event.stopPropagation(); this.openDatePicker(task, field, rerender); });
          metadataEl.addEventListener('contextmenu', (event) => { event.preventDefault(); event.stopPropagation(); this.openDateFieldMenu(event, task, field, rerender); });
        }
      }
      if (key === 'priority') {
        const priority = task.metadata.priority || 'normal';
        metadataEl.addClass('task-manager-priority-pill');
        metadataEl.addClass(`task-priority-${priority}`);
        metadataEl.setAttr('data-task-priority', priority);
        metadataEl.setAttr('title', `${value} — right-click to change`);
        makeKeyboardButton(metadataEl, `${value}. Change priority`, () => this.openPriorityMenu(new MouseEvent('contextmenu'), task, rerender));
        metadataEl.addEventListener('contextmenu', (event) => { event.preventDefault(); event.stopPropagation(); this.openPriorityMenu(event, task, rerender); });
      }
      // Dependency navigation (#18): render each dependency ID as a clickable link
      if (key === 'depends on' && task.metadata.dependsOn.length > 0) {
        metadataEl.empty();
        metadataEl.createSpan({ text: '⛔ ' });
        task.metadata.dependsOn.forEach((depId, idx) => {
          if (idx > 0) metadataEl.createSpan({ text: ',' });
          const depSpan = metadataEl.createSpan({ cls: 'task-manager-dep-link', text: depId });
          configureDependencyChip(depSpan, depId, () => this.navigateToDependency(depId, allTasksForNav ?? []));
        });
      }
      // Recurrence context menu (#11): right-click the recurrence rule to skip or edit
      if (key === 'recurrence rule' && task.metadata.recurrence) {
        configureRecurrenceChip(metadataEl, value, (event) => this.openRecurrenceMenu(event, task, rerender));
      }
      // On-completion keep visual (#24): add a subtle badge when value is 'keep'
      if (key === 'on completion' && task.metadata.onCompletion?.toLowerCase() === 'keep') {
        metadataEl.addClass('task-manager-oc-keep');
        metadataEl.setAttr('title', `${value} — task will be kept when completed`);
      }
      container.appendChild(metadataEl);
      // Inline recurrence warning badge (#15)
      if (key === 'recurrence rule' && task.metadata.invalidRecurrence) {
        const warnBadge = document.createElement('span');
        warnBadge.addClass('task-manager-recurrence-warning');
        warnBadge.setText('⚠️');
        warnBadge.setAttr('title', 'Invalid recurrence rule — this task will not auto-recur');
        container.appendChild(warnBadge);
      }
    }
  }

  private renderExplain(el: HTMLElement, query: TaskQuery, tasks: readonly ParsedTask[]): void {
    const container = document.createElement('div');
    container.addClass('task-manager-query-explain');
    // Upstream theme class: see Renderer.scss `.plugin-tasks-query-explanation`.
    container.addClass('plugin-tasks-query-explanation');
    const invalidRecurrences = tasks.filter((task) => task.metadata.invalidRecurrence);
    const executionTime = query.executionTimeMs;
    const warningsSection = invalidRecurrences.length > 0
      ? `\n\n> [!warning] Unrecognised recurrence rules\n> ${invalidRecurrences.length} task(s) have unrecognised recurrence rules and will not recur.\n${invalidRecurrences.slice(0, 10).map((task) => `> - \`${task.filePath}:${task.lineNumber}\``).join('\n')}`
      : '';
    const parts: string[] = [];
    const body = buildExplainBody(query);
    if (body) parts.push(`\`\`\`\n${body}\n\`\`\``);
    // Add execution time if available
    if (typeof executionTime === 'number') {
      parts.push(`**Execution time:** ${executionTime.toFixed(2)}ms`);
    }
    if (query.explainSources?.globalQuery) {
      parts.push(`**Global query:**\n\`\`\`\n${query.explainSources.globalQuery}\n\`\`\``);
    }
    if (query.explainSources?.queryFileDefaults.length) {
      parts.push(`**Query File Defaults:**\n${query.explainSources.queryFileDefaults.map((l) => `- \`${l}\``).join('\n')}`);
    }
    if (query.explainSources?.expandedQuery) {
      parts.push(`**Expanded query:**\n\`\`\`\n${query.explainSources.expandedQuery}\n\`\`\``);
    }
    const mdText = `#### Query Explanation\n\n${parts.join('\n\n')}${warningsSection}`;
    try {
      const renderer = MarkdownRenderer as unknown as {
        render?: (app: unknown, md: string, el: HTMLElement, path: string, component: unknown) => Promise<void>;
        renderMarkdown?: (md: string, el: HTMLElement, path: string, component: unknown) => Promise<void> | void;
      };
      if (typeof renderer.render === 'function') {
        void renderer.render(this.app, mdText, container, '', this.owner);
      } else if (typeof renderer.renderMarkdown === 'function') {
        void renderer.renderMarkdown(mdText, container, '', this.owner);
      } else {
        throw new Error('no renderer');
      }
    } catch {
      // Plain-text fallback for environments without Markdown renderer.
      const pre = document.createElement('pre');
      pre.setText([
        buildExplainBody(query),
        typeof executionTime === 'number' ? `Execution time: ${executionTime.toFixed(2)}ms` : '',
        query.explainSources?.globalQuery ? `Global query:\n${query.explainSources.globalQuery}` : '',
        query.explainSources?.queryFileDefaults.length ? `Query File Defaults:\n${query.explainSources.queryFileDefaults.join('\n')}` : '',
        query.explainSources?.expandedQuery ? `Expanded query:\n${query.explainSources.expandedQuery}` : '',
        invalidRecurrences.length > 0 ? `Warnings: ${invalidRecurrences.length} task(s) with unrecognised recurrence rule.` : '',
      ].filter(Boolean).join('\n\n'));
      container.appendChild(pre);
    }
    el.appendChild(container);
  }

  private renderToolbar(el: HTMLElement, query: TaskQuery, tasks: readonly ParsedTask[], ctx?: MarkdownPostProcessorContext): void {
    const currentMode = query.viewMode ?? 'list';
    const toolbar = document.createElement('div');
    toolbar.addClass('task-manager-query-toolbar');
    toolbar.addClass(`task-manager-query-toolbar-${currentMode}`);
    // Upstream theme class: see Renderer.scss `.plugin-tasks-toolbar`.
    toolbar.addClass('plugin-tasks-toolbar');
    const actions = document.createElement('div');
    actions.addClass('task-manager-query-toolbar-actions');
    queryFilterPopoverControllers.get(el)?.abort();
    const AbortControllerCtor = el.ownerDocument?.defaultView?.AbortController ?? AbortController;
    const filterPopoverController = new AbortControllerCtor();
    queryFilterPopoverControllers.set(el, filterPopoverController);
    let activeTagFilter: string | null = null;
    let filterPanelOpen = false;
    const filterTargets = (): HTMLElement[] => Array.from(el.querySelectorAll<HTMLElement>('.task-manager-filterable-item, .task-manager-query-item'));
    const updateFilterButton = (): void => {
      const activeCount = (input.value.trim().length > 0 ? 1 : 0) + (activeTagFilter ? 1 : 0);
      filterBtn.toggleClass('is-active', activeCount > 0);
      filterBtn.setText(activeCount > 0 ? `Filter (${activeCount})` : 'Filter');
      filterBtn.setAttr('aria-expanded', String(filterPanelOpen));
    };
    const applyFilters = (): void => {
      const value = input.value.trim().toLowerCase();
      for (const item of filterTargets()) {
        const text = item.getAttribute('data-task-filter-text') ?? item.textContent?.toLowerCase() ?? '';
        const tags = item.getAttribute('data-task-tags') ?? '';
        const matchesText = value.length === 0 || text.includes(value);
        const matchesTag = activeTagFilter === null || tags.split(',').some((t) => t.trim() === activeTagFilter);
        item.toggleClass('task-manager-query-item-hidden', !matchesText);
        item.toggleClass('task-manager-query-item-tag-hidden', !matchesTag);
      }
      updateFilterButton();
    };
    const filterWrap = document.createElement('div');
    filterWrap.addClass('task-manager-query-filter-wrap');
    const filterBtn = document.createElement('button');
    filterBtn.addClass('task-manager-query-filter-toggle');
    filterBtn.setAttr('type', 'button');
    filterBtn.setAttr('aria-haspopup', 'dialog');
    const filterPanel = document.createElement('div');
    filterPanel.addClass('task-manager-query-filter-panel');
    filterPanel.addClass('is-collapsed');
    filterPanel.setAttr('role', 'dialog');
    filterPanel.setAttr('aria-label', currentMode === 'kanban' ? 'Filter Kanban cards' : 'Filter results');
    const toggleFilterPanel = (open = !filterPanelOpen): void => {
      filterPanelOpen = open;
      filterPanel.toggleClass('is-collapsed', !open);
      updateFilterButton();
      if (open) window.setTimeout(() => input.focus(), 0);
    };
    filterBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      toggleFilterPanel();
    });
    const documentWithEvents = document as Document & { addEventListener?: Document['addEventListener'] };
    if (typeof documentWithEvents.addEventListener === 'function') {
      documentWithEvents.addEventListener('click', (event) => {
        if (!filterPanelOpen) return;
        if (filterWrap.contains(event.target as Node)) return;
        toggleFilterPanel(false);
      }, { signal: filterPopoverController.signal });
    }
    filterPanel.addEventListener('click', (event) => event.stopPropagation());
    filterPanel.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        toggleFilterPanel(false);
        filterBtn.focus();
      }
    });
    filterWrap.appendChild(filterBtn);
    const input = document.createElement('input');
    input.addClass('task-manager-query-toolbar-filter');
    input.setAttr('type', 'search');
    input.setAttr('placeholder', currentMode === 'kanban' ? 'Filter cards...' : 'Filter results...');
    input.setAttr('aria-label', currentMode === 'kanban' ? 'Filter Kanban cards' : 'Filter rendered results');
    input.addEventListener('input', applyFilters);
    filterPanel.appendChild(input);

    // Tag filter — narrows visible results to tasks containing a chosen tag.
    const allTags = Array.from(new Set(tasks.flatMap((t) => t.tags))).sort();
    if (allTags.length > 0) {
      const tagStrip = document.createElement('div');
      tagStrip.addClass('task-manager-tag-filter-strip');
      tagStrip.setAttr('aria-label', 'Filter by tag');
      const clearBtn = document.createElement('button');
      clearBtn.addClass('task-manager-tag-filter-chip');
      clearBtn.addClass('is-active');
      clearBtn.setText('All');
      const tagButtons: HTMLButtonElement[] = [clearBtn];
      const setActiveTag = (tag: string | null): void => {
        activeTagFilter = tag;
        for (const btn of tagButtons) btn.toggleClass('is-active', btn.getAttribute('data-tag-filter') === (tag ?? ''));
        applyFilters();
      };
      clearBtn.setAttr('data-tag-filter', '');
      clearBtn.addEventListener('click', () => setActiveTag(null));
      tagStrip.appendChild(clearBtn);
      for (const tag of allTags.slice(0, 8)) {
        const tagBtn = document.createElement('button');
        tagBtn.addClass('task-manager-tag-filter-chip');
        tagBtn.setAttr('data-tag-filter', tag);
        tagBtn.setText(`#${tag}`);
        tagBtn.addEventListener('click', () => setActiveTag(tag));
        tagButtons.push(tagBtn);
        tagStrip.appendChild(tagBtn);
      }
      if (allTags.length > 8) {
        const moreTagsBtn = document.createElement('button');
        moreTagsBtn.addClass('task-manager-tag-filter-chip');
        moreTagsBtn.setText(`+${allTags.length - 8}`);
        moreTagsBtn.setAttr('aria-label', 'More tag filters');
        moreTagsBtn.addEventListener('click', (event) => {
          const menu = new Menu();
          for (const tag of allTags.slice(8)) {
            menu.addItem((item) => item.setTitle(`#${tag}`).onClick(() => setActiveTag(tag)));
          }
          menu.showAtMouseEvent(event);
        });
        tagStrip.appendChild(moreTagsBtn);
      }
      filterPanel.appendChild(tagStrip);
    }
    const clearFiltersBtn = document.createElement('button');
    clearFiltersBtn.addClass('task-manager-query-filter-clear');
    clearFiltersBtn.setAttr('type', 'button');
    clearFiltersBtn.setText('Clear filters');
    clearFiltersBtn.addEventListener('click', () => {
      input.value = '';
      activeTagFilter = null;
      for (const btn of Array.from(filterPanel.querySelectorAll<HTMLButtonElement>('.task-manager-tag-filter-chip'))) {
        btn.toggleClass('is-active', btn.getAttribute('data-tag-filter') === '');
      }
      applyFilters();
    });
    filterPanel.appendChild(clearFiltersBtn);
    filterWrap.appendChild(filterPanel);
    actions.appendChild(filterWrap);
    updateFilterButton();
    const copy = document.createElement('button');
    copy.setText('Copy results');
    copy.addClass('task-manager-query-copy');
    copy.addEventListener('click', () => {
      const markdown = this.queryResultsToMarkdown(query, tasks);
      void copyToClipboard(markdown, 'Task Manager results copied');
    });
    actions.appendChild(copy);

    // Export dropdown: CSV / JSON
    const exportBtn = document.createElement('button');
    exportBtn.setText('Export…');
    exportBtn.addClass('task-manager-query-export-btn');
    exportBtn.addEventListener('click', (e) => {
      const menu = new Menu();
      menu.addItem((item) => item.setTitle('Copy as CSV').onClick(() => {
        const csv = this.queryResultsToCsv(tasks);
        void copyToClipboard(csv, 'Copied as CSV');
      }));
      menu.addItem((item) => item.setTitle('Copy as JSON').onClick(() => {
        const json = this.queryResultsToJson(tasks);
        void copyToClipboard(json, 'Copied as JSON');
      }));
      // #10: Markdown table export
      menu.addItem((item) => item.setTitle('Copy as Markdown table').onClick(() => {
        const table = this.queryResultsToMarkdownTable(tasks);
        void copyToClipboard(table, 'Copied as Markdown table');
      }));
      menu.addSeparator();
      menu.addItem((item) => item.setTitle('Save CSV to vault…').onClick(() => {
        const csv = this.queryResultsToCsv(tasks);
        const exportPath = ensureExportPathExtension(this.getSettings().csvExportPath, 'Tasks Export.csv', 'csv');
        void this.app.vault.adapter.write(exportPath, csv).then(() => {
          new Notice(`Task Manager: Exported ${tasks.length} task${tasks.length === 1 ? '' : 's'} to ${exportPath}`);
        }).catch((err: unknown) => {
          new Notice(`Task Manager: Export failed — ${err instanceof Error ? err.message : String(err)}`);
        });
      }));
      menu.addItem((item) => item.setTitle('Save JSON to vault…').onClick(() => {
        const json = this.queryResultsToJson(tasks);
        const exportPath = ensureExportPathExtension(this.getSettings().jsonExportPath, 'Tasks Export.json', 'json');
        void this.app.vault.adapter.write(exportPath, json).then(() => {
          new Notice(`Task Manager: Exported ${tasks.length} task${tasks.length === 1 ? '' : 's'} to ${exportPath}`);
        }).catch((err: unknown) => {
          new Notice(`Task Manager: Export failed — ${err instanceof Error ? err.message : String(err)}`);
        });
      }));
      menu.addItem((item) => item.setTitle('Save YAML to vault…').onClick(() => {
        const yaml = this.queryResultsToYaml(tasks);
        const exportPath = ensureExportPathExtension(this.getSettings().yamlExportPath, 'Tasks Export.yaml', 'yaml');
        void this.app.vault.adapter.write(exportPath, yaml).then(() => {
          new Notice(`Task Manager: Exported ${tasks.length} task${tasks.length === 1 ? '' : 's'} to ${exportPath}`);
        }).catch((err: unknown) => {
          new Notice(`Task Manager: Export failed — ${err instanceof Error ? err.message : String(err)}`);
        });
      }));
      menu.addSeparator();
      menu.addItem((item) => item.setTitle('📋 Download CSV file').onClick(() => {
        const content = this.queryResultsToCsv(tasks);
        const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `tasks-${taskManagerTodayString()}.csv`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }));
      menu.addItem((item) => item.setTitle('{} Download JSON file').onClick(() => {
        const content = this.queryResultsToJson(tasks);
        const blob = new Blob([content], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `tasks-${taskManagerTodayString()}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }));
      menu.addItem((item) => item.setTitle('≡≡ Download YAML file').onClick(() => {
        const content = this.queryResultsToYaml(tasks);
        const blob = new Blob([content], { type: 'text/yaml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `tasks-${taskManagerTodayString()}.yaml`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
      }));
      menu.showAtMouseEvent(e);
    });
    actions.appendChild(exportBtn);

    // View mode is intentionally controlled by the query source (`view: kanban`,
    // `view: calendar`, etc.) instead of by embedded toolbar buttons. This keeps
    // embedded dashboards/showcases stable and avoids mutating notes as a side
    // effect of presentation controls.

    // "Edit this query" button — opens the source note at the query block's line.
    let editBtn: HTMLButtonElement | null = null;
    if (ctx?.sourcePath) {
      editBtn = document.createElement('button');
      editBtn.addClass('task-manager-edit-query-btn');
      editBtn.setText('</>');
      editBtn.setAttr('aria-label', 'Edit query');
      editBtn.setAttr('title', 'Edit query source');
      editBtn.addEventListener('click', () => {
        const abstractFile = this.app.vault.getAbstractFileByPath(ctx.sourcePath);
        if (!this.isTFile(abstractFile)) return;
        const sectionInfo = ctx.getSectionInfo?.(el);
        const line = sectionInfo?.lineStart ?? 0;
        void this.app.workspace.getLeaf().openFile(abstractFile, {
          active: true,
          eState: { line },
        });
      });
      actions.appendChild(editBtn);
    }

    if (currentMode === 'kanban') {
      const optionsBtn = document.createElement('button');
      optionsBtn.addClass('task-manager-query-options-btn');
      optionsBtn.setAttr('type', 'button');
      optionsBtn.setAttr('aria-label', 'Task query options');
      optionsBtn.setAttr('title', 'Task query options');
      optionsBtn.setText('⋯');
      optionsBtn.addEventListener('click', (event: MouseEvent) => {
        const menu = new Menu();
        menu.addItem((item) => item.setTitle('Copy results').onClick(() => copy.click()));
        menu.addItem((item) => item.setTitle('Export…').onClick(() => {
          exportBtn.dispatchEvent(new MouseEvent('click', {
            bubbles: true,
            cancelable: true,
            clientX: event.clientX,
            clientY: event.clientY,
          }));
        }));
        if (editBtn) {
          menu.addSeparator();
          menu.addItem((item) => item.setTitle('Edit query source').onClick(() => editBtn?.click()));
        }
        menu.showAtMouseEvent(event);
      });
      actions.appendChild(optionsBtn);
    }
    toolbar.appendChild(actions);

    el.appendChild(toolbar);
  }

  private renderSortIndicator(el: HTMLElement, query: TaskQuery): void {
    const indicator = document.createElement('div');
    indicator.addClass('task-manager-sort-indicator');
    const sortText = query.sort
      .map((c) => `${c.field}${c.reverse ? ' ↓' : ' ↑'}`)
      .join(' · ');
    indicator.setText(`Sort: ${sortText}`);
    el.appendChild(indicator);
  }

  /** Export tasks as a CSV string (headers: status, description, due, scheduled, start, priority, tags, file, line). */
  private queryResultsToCsv(tasks: readonly ParsedTask[]): string {
    const headers = ['status', 'description', 'due', 'scheduled', 'start', 'created', 'done', 'priority', 'tags', 'file', 'line'];
    const rows = tasks.map((t) => [
      t.status,
      t.normalizedText,
      t.metadata.dates.due ?? '',
      t.metadata.dates.scheduled ?? '',
      t.metadata.dates.start ?? '',
      t.metadata.dates.created ?? '',
      t.metadata.dates.done ?? '',
      t.metadata.priority ?? 'normal',
      t.tags.join(';'),
      t.filePath,
      String(t.lineNumber),
    ].map(encodeCsvCell).join(','));
    return [headers.map(encodeCsvCell).join(','), ...rows].join('\n');
  }

  /** Export tasks as a JSON array. */
  private queryResultsToJson(tasks: readonly ParsedTask[]): string {
    return JSON.stringify(
      tasks.map((t) => ({
        status: t.status,
        description: t.normalizedText,
        due: t.metadata.dates.due ?? null,
        scheduled: t.metadata.dates.scheduled ?? null,
        start: t.metadata.dates.start ?? null,
        created: t.metadata.dates.created ?? null,
        done: t.metadata.dates.done ?? null,
        priority: t.metadata.priority ?? 'normal',
        tags: t.tags,
        recurrence: t.metadata.recurrence ?? null,
        id: t.metadata.id ?? null,
        dependsOn: t.metadata.dependsOn,
        file: t.filePath,
        line: t.lineNumber,
      })),
      null,
      2,
    );
  }

  /** Export tasks as a YAML document (#22). */
  private queryResultsToYaml(tasks: readonly ParsedTask[]): string {
    const yamlEscape = (v: string): string => {
      if (v === '') return "''";
      if (/[:#\[\]{},&*?|<>=!%@`'"\\]|^\s|\s$/u.test(v) || v.includes('\n')) {
        return `"${v.replace(/\\/gu, '\\\\').replace(/"/gu, '\\"')}"`;
      }
      return v;
    };
    const serVal = (v: unknown): string => {
      if (v === null || v === undefined) return 'null';
      if (typeof v === 'boolean') return v ? 'true' : 'false';
      if (typeof v === 'number') return String(v);
      if (Array.isArray(v)) {
        if ((v as unknown[]).length === 0) return '[]';
        return `[${(v as unknown[]).map((item) => yamlEscape(String(item))).join(', ')}]`;
      }
      return yamlEscape(typeof v === 'string' ? v : (typeof v === 'number' || typeof v === 'boolean') ? String(v) : JSON.stringify(v));
    };
    const lines: string[] = ['tasks:'];
    for (const t of tasks) {
      lines.push('  -');
      for (const [k, v] of Object.entries({
        status: t.status,
        description: t.normalizedText,
        due: t.metadata.dates.due ?? null,
        scheduled: t.metadata.dates.scheduled ?? null,
        start: t.metadata.dates.start ?? null,
        created: t.metadata.dates.created ?? null,
        done: t.metadata.dates.done ?? null,
        priority: t.metadata.priority ?? 'normal',
        tags: t.tags,
        recurrence: t.metadata.recurrence ?? null,
        id: t.metadata.id ?? null,
        file: t.filePath,
        line: t.lineNumber,
      })) {
        lines.push(`    ${k}: ${serVal(v)}`);
      }
    }
    return lines.join('\n') + '\n';
  }

  /**
   * #10: Export query results as a Markdown table.
   * Columns: Status, Description, Due, Scheduled, Priority, Tags, File.
   */
  private queryResultsToMarkdownTable(tasks: readonly ParsedTask[]): string {
    const esc = (s: string) => s.replace(/\|/gu, '\\|');
    const header = '| Status | Description | Due | Scheduled | Priority | Tags | File |';
    const sep    = '|--------|-------------|-----|-----------|----------|------|------|';
    const rows = tasks.map((t) => [
      '|',
      esc(t.metadata.priority === 'normal' ? t.status : `${t.status} (${t.metadata.priority})`),
      '|',
      esc(t.normalizedText),
      '|',
      esc(t.metadata.dates.due ?? ''),
      '|',
      esc(t.metadata.dates.scheduled ?? ''),
      '|',
      esc(t.metadata.priority),
      '|',
      esc(t.tags.join(', ')),
      '|',
      esc(`[[${t.filePath.replace(/\.md$/u, '')}]]`),
      '|',
    ].join(' '));
    return [header, sep, ...rows].join('\n');
  }

  private queryResultsToMarkdown(query: TaskQuery, tasks: readonly ParsedTask[]): string {
    const lines: string[] = [];
    if (query.errors.length > 0) lines.push(...query.errors);
    if (query.explain) {
      lines.push(buildExplainBody(query));
      const invalidRecurrences = tasks.filter((task) => task.metadata.invalidRecurrence);
      if (invalidRecurrences.length > 0) {
        lines.push(`Warnings: ${invalidRecurrences.length} task(s) with unrecognised recurrence rule (will not recur):`);
        for (const task of invalidRecurrences.slice(0, 10)) {
          lines.push(`  - ${task.filePath}:${task.lineNumber} 🔁 ${task.metadata.recurrence ?? ''}`);
        }
      }
    }
    if (query.groups.length > 0) {
      const groups = this.effectiveGroups(query);
      const grouped = groupTasks(tasks, groups, undefined, this.getSettings().supportedStates, { allTasks: tasks, globalFilter: this.getSettings().globalFilter });
      this.appendGroupedMarkdown(lines, grouped, 4);
    } else {
      lines.push(...tasks.map((task) => task.rawLine.trimEnd()));
    }
    return lines.filter(Boolean).join('\n');
  }

  private effectiveGroups(query: TaskQuery): TaskQuery['groups'] {
    return query.limitGroups
      ? query.groups.map((group, index) => index === query.groups.length - 1 && !group.limit ? { ...group, limit: query.limitGroups } : group)
      : query.groups;
  }

  private appendGroupedMarkdown(lines: string[], groups: GroupedTaskNode<ParsedTask>[], headingLevel: number): void {
    for (const group of groups) {
      if (group.name) lines.push(`${'#'.repeat(Math.min(6, headingLevel))} ${group.name}`);
      if (group.children) this.appendGroupedMarkdown(lines, group.children, headingLevel + 1);
      for (const task of group.tasks ?? []) lines.push(task.rawLine.trimEnd());
    }
  }

  private async renderTaskTree(tasks: readonly ParsedTask[], ctx: MarkdownPostProcessorContext, query: TaskQuery, rerenderQuery: () => Promise<void>): Promise<HTMLUListElement> {
    const root = document.createElement('ul');
    root.addClass('task-manager-query-list');
    root.addClass('contains-task-list', 'plugin-tasks-query-result');
    for (const cls of upstreamLayoutHideClasses(query)) root.addClass(cls);
    const allTasks = await (this.taskCache ?? Promise.resolve(tasks));
    // Build hierarchy/task-line indexes once and memoize one source read per file
    // for this render. The cache is intentionally render-local to avoid stale text.
    const matchedOccurrenceKeys = new Set(tasks.map((task) => queryTreeOccurrenceKey(task)));
    const tasksByFileLine = new Map<string, Map<number, ParsedTask>>();
    for (const task of allTasks) {
      const byLine = tasksByFileLine.get(task.filePath) ?? new Map<number, ParsedTask>();
      byLine.set(task.lineNumber, task);
      tasksByFileLine.set(task.filePath, byLine);
    }
    const sourceContexts = new Map<string, Promise<QueryTreeFileContext | null>>();
    const sourceContext = (filePath: string): Promise<QueryTreeFileContext | null> => {
      const existing = sourceContexts.get(filePath);
      if (existing) return existing;
      const loading = (async () => {
        const abstractFile = this.app.vault.getAbstractFileByPath(filePath);
        if (!this.isTFile(abstractFile)) return null;
        const content = await this.app.vault.read(abstractFile);
        const lines = content.split(/\r?\n/u);
        const taskByLine = tasksByFileLine.get(filePath) ?? new Map<number, ParsedTask>();
        return { lines, taskByLine, matchedDescendantKeys: matchedQueryTreeDescendants(lines, taskByLine, matchedOccurrenceKeys) };
      })();
      sourceContexts.set(filePath, loading);
      return loading;
    };
    const rendered = new Set<string>();
    const matchedTaskKeys = new Set(tasks.map((task) => task.key));
    for (const task of tasks) {
      if (rendered.has(task.key)) continue;
      const context = await sourceContext(task.filePath);
      if (context?.matchedDescendantKeys.has(queryTreeOccurrenceKey(task))) continue;
      const item = this.renderTask(task, ctx, query, rerenderQuery);
      root.appendChild(item);
      rendered.add(task.key);
      const descendants = context ? this.descendantListItems(task, context, rendered) : [];
      // Apply treeFiltered: if enabled, only show children that are in the matched set
      const filteredDescendants = query.treeFiltered
        ? descendants.filter((d) => !d.task || matchedTaskKeys.has(d.task.key))
        : descendants;
      if (filteredDescendants.length > 0) {
        // ── Subtask progress badge ────────────────────────────────────────────
        if (!query.layout.hidden.has('progress')) {
          const totalChildren = filteredDescendants.filter((d) => Boolean(d.task)).length;
          if (totalChildren > 0) {
            const doneChildren = filteredDescendants.filter(
              (d) => d.task && (d.task.status === 'done' || d.task.status === 'cancelled'),
            ).length;
            const textSpan = item.querySelector<HTMLElement>('.task-manager-query-text');
            if (textSpan) {
              const badge = document.createElement('span');
              badge.addClass('task-manager-progress-badge');
              badge.setText(`[${doneChildren}/${totalChildren}]`);
              badge.setAttr('title', `${doneChildren} of ${totalChildren} subtasks done`);
              textSpan.appendChild(badge);
            }
          }
        }
        // Collapse/expand toggle on the parent item
        const toggleBtn = document.createElement('button');
        toggleBtn.addClass('task-manager-tree-toggle');
        toggleBtn.setText('▾'); // ▾ (expanded)
        toggleBtn.setAttr('aria-label', 'Collapse subtasks');
        item.insertBefore(toggleBtn, item.firstChild);

        const childList = document.createElement('ul');
        item.appendChild(childList);
        let isCollapsed = false;
        toggleBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          isCollapsed = !isCollapsed;
          childList.style.display = isCollapsed ? 'none' : '';
          toggleBtn.setText(isCollapsed ? '▸' : '▾'); // ▸ / ▾
          toggleBtn.setAttr('aria-label', isCollapsed ? 'Expand subtasks' : 'Collapse subtasks');
        });

        for (const child of filteredDescendants) {
          if (child.task) {
            childList.appendChild(this.renderTask(child.task, ctx, query, rerenderQuery));
            rendered.add(child.task.key);
          } else {
            const listItem = document.createElement('li');
            listItem.addClass('task-manager-query-tree-list-item');
            listItem.setText(child.text);
            childList.appendChild(listItem);
          }
        }
      }
    }
    return root;
  }

  private descendantListItems(parent: ParsedTask, context: QueryTreeFileContext, rendered: ReadonlySet<string>): Array<{ task?: ParsedTask; text: string }> {
    const descendants: Array<{ task?: ParsedTask; text: string }> = [];
    for (let index = parent.lineNumber; index < context.lines.length; index += 1) {
      const rawLine = context.lines[index] ?? '';
      const match = rawLine.match(/^((?:\s*>\s*)*)(\s*)((?:[-*+])|(?:\d+[.)]))\s+(.*)$/u);
      if (!match) continue;
      const [, linePrefix, indentation, , body] = match;
      if (linePrefix !== parent.linePrefix) continue;
      if (indentation.length <= parent.indentation.length) break;
      const lineNumber = index + 1;
      const task = context.taskByLine.get(lineNumber);
      if (task) {
        if (!rendered.has(task.key)) descendants.push({ task, text: task.normalizedText });
      } else {
        descendants.push({ text: body.trim() });
      }
    }
    return descendants;
  }

  private renderStats(el: HTMLElement, tasks: ParsedTask[]): void {
    el.addClass('task-manager-stats');
    const today = todayString();

    // Status breakdown
    const bySt: Record<string, number> = {};
    for (const t of tasks) { bySt[t.status] = (bySt[t.status] ?? 0) + 1; }

    // Priority breakdown (non-done only)
    const byPri: Record<string, number> = {};
    for (const t of tasks) {
      if (t.status !== 'done' && t.status !== 'cancelled') {
        const p = t.metadata.priority ?? 'normal';
        byPri[p] = (byPri[p] ?? 0) + 1;
      }
    }

    const notDone = tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled');
    const overdue = notDone.filter((t) => t.metadata.dates.due && t.metadata.dates.due < today).length;
    const dueToday = notDone.filter((t) => t.metadata.dates.due === today).length;
    const in7 = addDays7(today);
    const dueWeek = notDone.filter((t) => t.metadata.dates.due && t.metadata.dates.due > today && t.metadata.dates.due <= in7).length;
    const done = tasks.filter((t) => t.status === 'done' || t.status === 'cancelled').length;
    const compRate = tasks.length > 0 ? Math.round((done / tasks.length) * 100) : 0;

    const card = (label: string, value: string | number, cls = ''): void => {
      const c = el.createDiv({ cls: `task-manager-stats-card${cls ? ` ${cls}` : ''}` });
      c.createEl('div', { text: String(value), cls: 'task-manager-stats-value' });
      c.createEl('div', { text: label, cls: 'task-manager-stats-label' });
    };

    // Summary cards
    const summaryEl = el.createDiv({ cls: 'task-manager-stats-summary' });
    const cardIn = (label: string, value: string | number, cls = ''): void => {
      const c = summaryEl.createDiv({ cls: `task-manager-stats-card${cls ? ` ${cls}` : ''}` });
      c.createEl('div', { text: String(value), cls: 'task-manager-stats-value' });
      c.createEl('div', { text: label, cls: 'task-manager-stats-label' });
    };
    cardIn('Total tasks', tasks.length);
    cardIn('Open', notDone.length);
    cardIn('Done / Cancelled', done);
    cardIn('Completion rate', `${compRate}%`);
    cardIn('Overdue', overdue, overdue > 0 ? 'is-overdue' : '');
    cardIn('Due today', dueToday);
    cardIn('Due this week', dueWeek);
    void card;

    // ── Completion over time chart (last 30 days from done dates) ──
    const doneTasks = tasks.filter((t) => t.metadata.dates.done);
    if (doneTasks.length > 0) {
      const chartSection = el.createDiv({ cls: 'task-manager-stats-section' });
      chartSection.createEl('h4', { text: 'Completions (last 30 days)', cls: 'task-manager-stats-section-title' });

      // Build per-day count for last 30 days
      const dayCounts: Record<string, number> = {};
      for (let i = 29; i >= 0; i--) {
        dayCounts[addDays(today, -i)] = 0;
      }
      for (const t of doneTasks) {
        const doneDate = t.metadata.dates.done;
        if (!doneDate) continue;
        const d = doneDate.slice(0, 10);
        if (d in dayCounts) dayCounts[d] = (dayCounts[d] ?? 0) + 1;
      }
      const days = Object.keys(dayCounts).sort();
      const counts = days.map((d) => dayCounts[d]);
      const maxCount = Math.max(1, ...counts);

      const svgNS = 'http://www.w3.org/2000/svg';
      const W = 300;
      const H = 60;
      const barW = Math.floor(W / days.length) - 1;
      const svg = document.createElementNS(svgNS, 'svg');
      svg.setAttr('viewBox', `0 0 ${W} ${H}`);
      svg.setAttr('width', '100%');
      svg.setAttr('height', String(H));
      svg.addClass('task-manager-stats-chart');

      days.forEach((day, i) => {
        const barH = Math.max(1, Math.round((counts[i] / maxCount) * (H - 4)));
        const x = i * (barW + 1);
        const y = H - barH;
        const rect = document.createElementNS(svgNS, 'rect');
        rect.setAttr('x', String(x));
        rect.setAttr('y', String(y));
        rect.setAttr('width', String(barW));
        rect.setAttr('height', String(barH));
        rect.addClass('task-manager-stats-chart-bar');
        if (day === today) rect.addClass('is-today');
        rect.setAttr('title', `${day}: ${counts[i]} completed`);
        svg.appendChild(rect);
      });
      chartSection.appendChild(svg);

      // Streak calculation
      let streak = 0;
      for (let i = days.length - 1; i >= 0; i--) {
        if (counts[i] > 0) streak++;
        else break;
      }
      chartSection.createEl('p', { text: `🔥 Current streak: ${streak} day${streak !== 1 ? 's' : ''}`, cls: 'task-manager-stats-streak' });
    }

    // Status breakdown bar chart
    const secSt = el.createDiv({ cls: 'task-manager-stats-section' });
    secSt.createEl('h4', { text: 'By status', cls: 'task-manager-stats-section-title' });
    const maxSt = Math.max(1, ...Object.values(bySt));
    for (const [st, n] of Object.entries(bySt).sort((a, b) => b[1] - a[1])) {
      const row = secSt.createDiv({ cls: 'task-manager-stats-bar-row' });
      row.createEl('span', { text: st, cls: 'task-manager-stats-bar-label' });
      const barWrap = row.createDiv({ cls: 'task-manager-stats-bar-wrap' });
      const bar = barWrap.createDiv({ cls: 'task-manager-stats-bar-fill' });
      bar.style.width = `${Math.round((n / maxSt) * 100)}%`;
      row.createEl('span', { text: String(n), cls: 'task-manager-stats-bar-count' });
    }

    // Priority breakdown
    const secPri = el.createDiv({ cls: 'task-manager-stats-section' });
    secPri.createEl('h4', { text: 'By priority (open)', cls: 'task-manager-stats-section-title' });
    const priOrder = ['highest', 'high', 'medium', 'normal', 'low', 'lowest'];
    const maxPri = Math.max(1, ...priOrder.map((p) => byPri[p] ?? 0));
    for (const pri of priOrder) {
      if (!byPri[pri]) continue;
      const row = secPri.createDiv({ cls: 'task-manager-stats-bar-row' });
      row.createEl('span', { text: pri, cls: 'task-manager-stats-bar-label' });
      const barWrap = row.createDiv({ cls: 'task-manager-stats-bar-wrap' });
      const bar = barWrap.createDiv({ cls: 'task-manager-stats-bar-fill' });
      bar.style.width = `${Math.round((byPri[pri] / maxPri) * 100)}%`;
      row.createEl('span', { text: String(byPri[pri]), cls: 'task-manager-stats-bar-count' });
    }
    void secSt; void secPri;

    // ── Burndown/Burnup charts (when enabled) ────────────────────────────────
    const burndownSection = el.createDiv({ cls: 'task-manager-stats-section' });
    burndownSection.createEl('h4', { text: 'Burndown & Burnup Charts', cls: 'task-manager-stats-section-title' });
    
    // Generate burndown/burnup data
    void (async () => {
      const { generateBurndownData, generateBurnupData, generateVelocitySparkline } = await import('./metrics-aggregator');
      
      // Calculate date range: last 30 days
      const today = new Date();
      const thirtyDaysAgo = new Date(today);
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
      
      const startDate = isoDate(thirtyDaysAgo);
      const endDate = isoDate(today);
      
      // For demo purposes, generate synthetic burndown data
      // In real implementation, this would come from state-store completion history
      const burndownData = generateBurndownData([], startDate, endDate);
      const burnupData = generateBurnupData([], startDate, endDate);
      const velocityData = generateVelocitySparkline([], 4);
      
      // Render burndown chart
      this.renderBurndownChart(burndownSection, burndownData);
      
      // Render burnup chart
      this.renderBurnupChart(burndownSection, burnupData);
      
      // Render velocity sparkline
      this.renderVelocitySparkline(burndownSection, velocityData);
    })();

    // ── Variance report (tasks with both effort and actual) ──────────────────
    void (async () => {
      const tasksWithBoth = tasks.filter((t) => t.metadata.effort && t.metadata.actual);
      if (tasksWithBoth.length === 0) return;

      const { calculateVarianceReport } = await import('./metrics-aggregator');
      const report = calculateVarianceReport(tasksWithBoth);
      if (report.summary.totalTasks === 0) return;

      const varSection = el.createDiv({ cls: 'task-manager-stats-section task-manager-stats-variance-section' });
      varSection.createEl('h4', { text: 'Estimation Variance Report', cls: 'task-manager-stats-section-title' });

      const summaryEl = varSection.createDiv({ cls: 'task-manager-stats-variance-summary' });
      const fmt = (mins: number): string => {
        const h = Math.floor(mins / 60); const m = Math.round(mins % 60);
        return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
      };
      summaryEl.createEl('p', { text: `Tasks analyzed: ${report.summary.totalTasks} • Avg variance: ${report.summary.averageVariance.toFixed(1)}% • Overestimates: ${report.summary.overestimatedCount} • Underestimates: ${report.summary.underestimatedCount} • Aggregate deviation: ${report.summary.aggregateDeviation.toFixed(1)}%` });

      const renderTop5 = (title: string, items: import('./metrics-aggregator').TaskVariance[]): void => {
        if (items.length === 0) return;
        const sec = varSection.createDiv({ cls: 'task-manager-stats-variance-top' });
        sec.createEl('h5', { text: title });
        const table = sec.createEl('table', { cls: 'task-manager-stats-variance-table' });
        const head = table.createEl('thead').createEl('tr');
        for (const h of ['Task', 'Estimated', 'Actual', 'Variance']) head.createEl('th', { text: h });
        const body = table.createEl('tbody');
        for (const item of items) {
          const row = body.createEl('tr');
          row.createEl('td', { text: item.taskTitle.length > 40 ? `${item.taskTitle.slice(0, 40)}…` : item.taskTitle });
          row.createEl('td', { text: fmt(item.effort) });
          row.createEl('td', { text: fmt(item.actual) });
          const varianceTd = row.createEl('td', { text: `${item.variance.toFixed(1)}% (${item.isOverestimate ? 'over-est' : 'under-est'})` });
          varianceTd.addClass(item.isOverestimate ? 'task-manager-variance-over' : 'task-manager-variance-under');
        }
      };

      renderTop5('Top 5 Over-Estimates (actual ≪ effort)', report.topOverestimates);
      renderTop5('Top 5 Under-Estimates (actual ≫ effort)', report.topUnderestimates);
    })();

    // ── Gamification achievements (when enabled) ────────────────────────────
    if (this.getSettings().gamificationEnabled) {
        const highPriorityDone = tasks.filter(
          (t) => t.status === 'done' && (t.metadata.priority === 'high' || t.metadata.priority === 'highest'),
        ).length;
        const completedToday = tasks.filter(
          (t) => t.status === 'done' && t.metadata.dates.done === today,
        ).length;
        const completedLast7 = tasks.filter((t) => {
          if (t.status !== 'done' || !t.metadata.dates.done) return false;
          return t.metadata.dates.done >= addDays(today, -7) && t.metadata.dates.done <= today;
        }).length;
        // Streak: already computed via doneTasks above — recalculate simply
        let gameStreak = 0;
        for (let i = 0; i < 365; i++) {
          const day = addDays(today, -i);
          const hasCompletion = tasks.some((t) => t.status === 'done' && t.metadata.dates.done?.slice(0, 10) === day);
          if (hasCompletion) gameStreak++; else break;
        }
        const achievementsSection = el.createDiv({ cls: 'task-manager-stats-section task-manager-stats-achievements-section' });
        achievementsSection.createEl('h4', { text: 'Achievements', cls: 'task-manager-stats-section-title' });
        const totalXp = done * 10 + highPriorityDone * 5;
        renderAchievements(achievementsSection, {
          totalCompleted: done,
          streakDays: gameStreak,
          streakDays7: gameStreak >= 7 ? 1 : 0,
          streakDays30: gameStreak >= 30 ? 1 : 0,
          streakDays100: gameStreak >= 100 ? 1 : 0,
          highPriorityCompleted: highPriorityDone,
          completedToday,
          weeklyCompleted: completedLast7,
          currentXP: totalXp,
          currentLevel: getLevelFromXP(totalXp),
          totalXPEarned: totalXp,
        });
    }
  }

  /**
   * Render burndown chart (remaining effort over time)
   */
  private renderBurndownChart(
    el: HTMLElement,
    data: Array<{ date: string; remaining: number; ideal: number }>,
  ): void {
    // Need at least 2 points to draw a line; a single point would divide by
    // (data.length - 1) = 0 when computing x-coordinates, producing NaN.
    if (data.length < 2) return;

    const chartContainer = el.createDiv({ cls: 'task-manager-burndown-chart-container' });
    chartContainer.createEl('h5', { text: 'Burndown (Remaining Effort)', cls: 'task-manager-chart-subtitle' });

    const svgNS = 'http://www.w3.org/2000/svg';
    const padding = 40;
    const W = 400;
    const H = 200;
    const chartW = W - 2 * padding;
    const chartH = H - 2 * padding;

    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttr('viewBox', `0 0 ${W} ${H}`);
    svg.setAttr('width', '100%');
    svg.setAttr('height', String(H));
    svg.addClass('task-manager-stats-chart-burndown');

    // Find max value for scaling. Guard maxValue === 0 to avoid division by
    // zero (all-zero effort data) producing NaN y-coordinates.
    const maxValue = Math.max(...data.map((d) => Math.max(d.remaining, d.ideal)));
    const scale = (value: number) => maxValue === 0 ? chartH : chartH * (1 - value / maxValue);

    // Draw axes
    const axisX = document.createElementNS(svgNS, 'line');
    axisX.setAttr('x1', String(padding));
    axisX.setAttr('y1', String(H - padding));
    axisX.setAttr('x2', String(W - padding));
    axisX.setAttr('y2', String(H - padding));
    axisX.setAttr('stroke', 'var(--text-muted)');
    axisX.setAttr('stroke-width', '1');
    svg.appendChild(axisX);

    const axisY = document.createElementNS(svgNS, 'line');
    axisY.setAttr('x1', String(padding));
    axisY.setAttr('y1', String(padding));
    axisY.setAttr('x2', String(padding));
    axisY.setAttr('y2', String(H - padding));
    axisY.setAttr('stroke', 'var(--text-muted)');
    axisY.setAttr('stroke-width', '1');
    svg.appendChild(axisY);

    // Draw ideal line (light gray)
    const idealPath = document.createElementNS(svgNS, 'polyline');
    const idealPoints = data
      .map(
        (d, i) =>
          `${padding + (i / (data.length - 1)) * chartW},${padding + scale(d.ideal)}`,
      )
      .join(' ');
    idealPath.setAttr('points', idealPoints);
    idealPath.setAttr('stroke', '#ccc');
    idealPath.setAttr('stroke-width', '1');
    idealPath.setAttr('fill', 'none');
    idealPath.setAttr('stroke-dasharray', '4,4');
    svg.appendChild(idealPath);

    // Draw actual line (blue)
    const actualPath = document.createElementNS(svgNS, 'polyline');
    const actualPoints = data
      .map(
        (d, i) =>
          `${padding + (i / (data.length - 1)) * chartW},${padding + scale(d.remaining)}`,
      )
      .join(' ');
    actualPath.setAttr('points', actualPoints);
    actualPath.setAttr('stroke', 'var(--text-accent)');
    actualPath.setAttr('stroke-width', '2');
    actualPath.setAttr('fill', 'none');
    svg.appendChild(actualPath);

    chartContainer.appendChild(svg);
  }

  /**
   * Render burnup chart (cumulative completed effort)
   */
  private renderBurnupChart(
    el: HTMLElement,
    data: Array<{ date: string; completed: number; total: number; scope: number }>,
  ): void {
    // Need at least 2 points to draw a line; a single point would divide by
    // (data.length - 1) = 0 when computing x-coordinates, producing NaN.
    if (data.length < 2) return;

    const chartContainer = el.createDiv({ cls: 'task-manager-burnup-chart-container' });
    chartContainer.createEl('h5', { text: 'Burnup (Cumulative Completed)', cls: 'task-manager-chart-subtitle' });

    const svgNS = 'http://www.w3.org/2000/svg';
    const padding = 40;
    const W = 400;
    const H = 200;
    const chartW = W - 2 * padding;
    const chartH = H - 2 * padding;

    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttr('viewBox', `0 0 ${W} ${H}`);
    svg.setAttr('width', '100%');
    svg.setAttr('height', String(H));
    svg.addClass('task-manager-stats-chart-burnup');

    // Find max value for scaling. Guard maxValue === 0 to avoid division by
    // zero (all-zero effort data) producing NaN y-coordinates.
    const maxValue = Math.max(...data.map((d) => Math.max(d.completed, d.total)));
    const scale = (value: number) => maxValue === 0 ? chartH : chartH * (1 - value / maxValue);

    // Draw axes
    const axisX = document.createElementNS(svgNS, 'line');
    axisX.setAttr('x1', String(padding));
    axisX.setAttr('y1', String(H - padding));
    axisX.setAttr('x2', String(W - padding));
    axisX.setAttr('y2', String(H - padding));
    axisX.setAttr('stroke', 'var(--text-muted)');
    axisX.setAttr('stroke-width', '1');
    svg.appendChild(axisX);

    const axisY = document.createElementNS(svgNS, 'line');
    axisY.setAttr('x1', String(padding));
    axisY.setAttr('y1', String(padding));
    axisY.setAttr('x2', String(padding));
    axisY.setAttr('y2', String(H - padding));
    axisY.setAttr('stroke', 'var(--text-muted)');
    axisY.setAttr('stroke-width', '1');
    svg.appendChild(axisY);

    // Draw scope line (light gray)
    const scopePath = document.createElementNS(svgNS, 'polyline');
    const scopePoints = data
      .map(
        (d, i) =>
          `${padding + (i / (data.length - 1)) * chartW},${padding + scale(d.total)}`,
      )
      .join(' ');
    scopePath.setAttr('points', scopePoints);
    scopePath.setAttr('stroke', '#ccc');
    scopePath.setAttr('stroke-width', '1');
    scopePath.setAttr('fill', 'none');
    scopePath.setAttr('stroke-dasharray', '4,4');
    svg.appendChild(scopePath);

    // Draw completed line (green)
    const completedPath = document.createElementNS(svgNS, 'polyline');
    const completedPoints = data
      .map(
        (d, i) =>
          `${padding + (i / (data.length - 1)) * chartW},${padding + scale(d.completed)}`,
      )
      .join(' ');
    completedPath.setAttr('points', completedPoints);
    completedPath.setAttr('stroke', '#4CAF50');
    completedPath.setAttr('stroke-width', '2');
    completedPath.setAttr('fill', 'none');
    svg.appendChild(completedPath);

    chartContainer.appendChild(svg);
  }

  /**
   * Render velocity sparkline (tasks completed per week)
   */
  private renderVelocitySparkline(el: HTMLElement, data: Array<{ week: string; velocity: number }>): void {
    if (data.length === 0) return;

    const sparklineContainer = el.createDiv({ cls: 'task-manager-velocity-sparkline-container' });
    sparklineContainer.createEl('h5', { text: 'Velocity (Tasks/Week)', cls: 'task-manager-chart-subtitle' });

    const svgNS = 'http://www.w3.org/2000/svg';
    const W = 200;
    const H = 40;
    const barW = Math.floor(W / data.length) - 2;

    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttr('viewBox', `0 0 ${W} ${H}`);
    svg.setAttr('width', '100%');
    svg.setAttr('height', String(H));
    svg.addClass('task-manager-velocity-sparkline');

    const maxVelocity = Math.max(1, ...data.map((d) => d.velocity));

    for (let i = 0; i < data.length; i++) {
      const barH = Math.max(1, Math.round((data[i].velocity / maxVelocity) * (H - 4)));
      const x = i * (barW + 2);
      const y = H - barH;

      const rect = document.createElementNS(svgNS, 'rect');
      rect.setAttr('x', String(x));
      rect.setAttr('y', String(y));
      rect.setAttr('width', String(barW));
      rect.setAttr('height', String(barH));
      rect.setAttr('fill', '#FF9800');
      rect.setAttr('title', `Week of ${data[i].week}: ${data[i].velocity} tasks`);
      svg.appendChild(rect);
    }

    sparklineContainer.appendChild(svg);
  }

  private renderDependencyGraph(el: HTMLElement, tasks: ParsedTask[]): void {
    const relevant = tasks.filter((t) => t.metadata.id || t.metadata.dependsOn.length > 0);
    if (relevant.length === 0) {
      this.renderMessage(el, 'No tasks with IDs or dependencies found. Add task IDs and depends-on fields to create a dependency graph.', 'task-manager-graph-empty');
      return;
    }
    const W = 640, H = 400;
    const svg = el.createSvg('svg', { attr: { viewBox: `0 0 ${W} ${H}`, width: '100%', class: 'task-manager-dependency-graph' } });
    // Arrow marker
    const defs = svg.createSvg('defs');
    const marker = defs.createSvg('marker', { attr: { id: 'arrowhead', markerWidth: '8', markerHeight: '6', refX: '6', refY: '3', orient: 'auto' } });
    marker.createSvg('polygon', { attr: { points: '0 0, 8 3, 0 6', fill: 'var(--text-muted)' } });
    // Nodes with random initial positions
    const nodes = relevant.map((t) => ({
      task: t,
      x: W / 2 + (Math.random() - 0.5) * W * 0.6,
      y: H / 2 + (Math.random() - 0.5) * H * 0.6,
      vx: 0, vy: 0,
    }));
    // Edges (source depends on target)
    const edges: Array<{ si: number; ti: number }> = [];
    for (let i = 0; i < relevant.length; i++) {
      for (const depId of relevant[i].metadata.dependsOn) {
        const ti = relevant.findIndex((t) => t.metadata.id === depId);
        if (ti >= 0) edges.push({ si: i, ti });
      }
    }
    svg.setAttr('role', 'img');
    svg.setAttr('aria-label', `Dependency graph with ${relevant.length} tasks and ${edges.length} dependencies`);
    // Spring layout (80 iterations, no animation)
    for (let iter = 0; iter < 80; iter++) {
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const dx = nodes[i].x - nodes[j].x, dy = nodes[i].y - nodes[j].y;
          const d = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
          const f = 2500 / (d * d);
          nodes[i].vx += f * dx / d; nodes[i].vy += f * dy / d;
          nodes[j].vx -= f * dx / d; nodes[j].vy -= f * dy / d;
        }
      }
      for (const { si, ti } of edges) {
        const dx = nodes[ti].x - nodes[si].x, dy = nodes[ti].y - nodes[si].y;
        nodes[si].vx += dx * 0.02; nodes[si].vy += dy * 0.02;
        nodes[ti].vx -= dx * 0.02; nodes[ti].vy -= dy * 0.02;
      }
      for (const n of nodes) {
        n.vx += (W / 2 - n.x) * 0.004; n.vy += (H / 2 - n.y) * 0.004;
        n.vx *= 0.85; n.vy *= 0.85;
        n.x = Math.max(30, Math.min(W - 30, n.x + n.vx));
        n.y = Math.max(30, Math.min(H - 30, n.y + n.vy));
      }
    }
    // Draw edges
    for (const { si, ti } of edges) {
      svg.createSvg('line', { attr: {
        x1: String(nodes[si].x), y1: String(nodes[si].y),
        x2: String(nodes[ti].x), y2: String(nodes[ti].y),
        stroke: 'var(--text-muted)', 'stroke-width': '1.5', 'marker-end': 'url(#arrowhead)',
      } });
    }
    // Status → color
    const statusColor: Record<string, string> = {
      todo: 'var(--color-blue)', done: 'var(--color-green)', in_progress: 'var(--color-yellow)',
      cancelled: 'var(--text-faint)', blocked: 'var(--color-red)', on_hold: 'var(--color-orange)',
      deferred: 'var(--color-purple)', untracked: 'var(--text-muted)',
    };
    const openGraphTask = (task: ParsedTask): void => {
      void this.app.workspace.openLinkText(task.filePath, '', false);
    };
    for (const n of nodes) {
      const g = svg.createSvg('g', { attr: { transform: `translate(${n.x},${n.y})`, cursor: 'pointer', role: 'button', tabindex: '0', 'aria-label': `Open dependency task: ${n.task.normalizedText}; status ${n.task.status}` } });
      g.createSvg('circle', { attr: { r: '12', fill: statusColor[n.task.status] ?? 'var(--text-normal)', stroke: 'var(--background-primary)', 'stroke-width': '2' } });
      const label = n.task.normalizedText.slice(0, 20) + (n.task.normalizedText.length > 20 ? '…' : '');
      const lbl = g.createSvg('text', { attr: { dy: '26', 'text-anchor': 'middle', 'font-size': '9', fill: 'var(--text-muted)' } });
      lbl.textContent = label;
      if (n.task.metadata.id) {
        const idLbl = g.createSvg('text', { attr: { dy: '-16', 'text-anchor': 'middle', 'font-size': '8', fill: 'var(--text-faint)' } });
        idLbl.textContent = `#${n.task.metadata.id}`;
      }
      g.setAttr('title', n.task.normalizedText);
      g.addEventListener('click', () => openGraphTask(n.task));
      g.addEventListener('keydown', (event: KeyboardEvent) => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        openGraphTask(n.task);
      });
    }
    const accessibleList = el.createEl('ul', { cls: 'task-manager-sr-only' });
    for (const { si, ti } of edges) {
      const source = nodes[si]?.task;
      const target = nodes[ti]?.task;
      if (!source || !target) continue;
      accessibleList.createEl('li', { text: `${source.normalizedText} depends on ${target.normalizedText}. Source status ${source.status}; dependency status ${target.status}.` });
    }
    // Legend
    const legend = el.createDiv({ cls: 'task-manager-graph-legend' });
    legend.createEl('span', { text: `${relevant.length} nodes, ${edges.length} edges`, cls: 'task-manager-graph-legend-text' });
  }

  /** Write a rescheduled date/time (drag from visual views) back to the source file. */
  private async rescheduleTask(task: ParsedTask, field: EditableTaskDateField, newDate: string): Promise<void> {
    if (this.isCanvasBackedTask(task)) {
      new Notice('Canvas tasks are read-only for rescheduling.');
      return;
    }
    await this.setTaskDate(task, field, newDate);
  }

  private renderResultPager(el: HTMLElement, session: QueryResultPagingSession, rerender: () => Promise<void>): void {
    const nav = el.createDiv({ cls: 'task-manager-query-pager' });
    nav.setAttr('role', 'navigation');
    nav.setAttr('aria-label', t('ui.resultPages'));
    const run = (move: () => boolean, focusSelector: string): void => {
      if (!move()) return;
      void rerender().then(() => {
        const preferred = el.querySelector<HTMLButtonElement>(focusSelector);
        const fallbackSelector = focusSelector.includes('next')
          ? '.task-manager-query-page-previous'
          : '.task-manager-query-page-next';
        const fallback = el.querySelector<HTMLButtonElement>(fallbackSelector);
        (preferred && !preferred.disabled ? preferred : fallback)?.focus();
      });
    };
    const previous = nav.createEl('button', { text: t('action.previous'), cls: 'task-manager-query-page-previous' });
    previous.disabled = !session.canGoPrevious;
    previous.addEventListener('click', () => run(() => session.previous(), '.task-manager-query-page-previous'));
    const status = nav.createEl('span', {
      cls: 'task-manager-query-page-status',
      text: `${session.start + 1}–${session.end} of ${session.total}`,
    });
    status.setAttr('role', 'status');
    status.setAttr('aria-live', 'polite');
    const next = nav.createEl('button', { text: t('action.next'), cls: 'task-manager-query-page-next' });
    next.disabled = !session.canGoNext;
    next.addEventListener('click', () => run(() => session.next(), '.task-manager-query-page-next'));
  }

  private renderTaskCount(el: HTMLElement, count: number): void {
    const messageEl = document.createElement('div');
    // Internal class kept for backwards compatibility; `task-count` / `tasks-count`
    // are the upstream class names themes target (HtmlQueryResultsRenderer uses
    // `task-count`, Renderer.scss styles `.tasks-count`).
    messageEl.addClass('task-manager-query-count');
    messageEl.addClass('task-count');
    messageEl.addClass('tasks-count');
    messageEl.setText(`${count} task${count === 1 ? '' : 's'}`);
    messageEl.setAttr('role', 'status'); messageEl.setAttr('aria-live', 'polite'); messageEl.setAttr('aria-atomic', 'true');
    el.appendChild(messageEl);
  }

  /**
   * Renders a compact stats bar below query results when `show stats` is in the query.
   * Shows: total count, breakdown by status type, overdue count.
   */
  private renderSummaryBar(el: HTMLElement, tasks: ParsedTask[]): void {
    const stats = buildQuerySummaryStats(tasks);
    if (stats.total === 0) return;
    if (el.querySelector('.task-manager-query-summary-bar')) return;
    const bar = el.createDiv({ cls: 'task-manager-query-summary-bar' });
    bar.setAttr('role', 'status'); bar.setAttr('aria-live', 'polite');
    bar.setAttr('aria-label', `Task query summary: ${stats.total} total, ${stats.active} open, ${stats.overdue} overdue, ${stats.done} done, ${stats.cancelled} cancelled`);
    const chips: Array<{ label: string; cls?: string }> = [
      { label: `📋 ${stats.total} total`, cls: 'task-manager-query-summary-chip--total' },
      { label: `🟢 ${stats.active} open`, cls: 'task-manager-query-summary-chip--active' },
    ];
    if (stats.inProgress > 0) chips.push({ label: `🔄 ${stats.inProgress} in progress` });
    if (stats.dueToday > 0) chips.push({ label: `📅 ${stats.dueToday} due today` });
    if (stats.overdue > 0) chips.push({ label: `🔴 ${stats.overdue} overdue`, cls: 'task-manager-query-summary-chip--overdue' });
    if (stats.done > 0) chips.push({ label: `✅ ${stats.done} done` });
    if (stats.cancelled > 0) chips.push({ label: `❌ ${stats.cancelled} cancelled` });
    for (const { label, cls } of chips) {
      const chip = bar.createEl('span', { text: label, cls: 'task-manager-query-summary-chip' });
      if (cls) chip.addClass(cls);
    }
  }

  private renderStatsBar(el: HTMLElement, tasks: ParsedTask[]): void {
    const today = todayString();
    const bar = el.createDiv({ cls: 'task-manager-query-stats-bar' });

    const total = tasks.length;
    const byType: Record<string, number> = {};
    for (const task of tasks) {
      byType[task.status] = (byType[task.status] ?? 0) + 1;
    }
    const overdue = tasks.filter((t) => {
      const due = t.metadata?.dates?.due;
      return due && due < today && t.status !== 'done' && t.status !== 'cancelled';
    }).length;

    const chips: Array<{ label: string; cls?: string }> = [
      { label: `📋 ${total} task${total === 1 ? '' : 's'}`, cls: 'task-manager-query-stats-chip--total' },
    ];
    if (byType['todo']) chips.push({ label: `⬜ ${byType['todo']} todo` });
    if (byType['in_progress']) chips.push({ label: `🔄 ${byType['in_progress']} in progress` });
    if (byType['blocked'] ?? byType['deferred'] ?? byType['on_hold']) {
      const n = (byType['blocked'] ?? 0) + (byType['deferred'] ?? 0) + (byType['on_hold'] ?? 0);
      chips.push({ label: `🚫 ${n} blocked` });
    }
    if (byType['done']) chips.push({ label: `✅ ${byType['done']} done` });
    if (byType['cancelled']) chips.push({ label: `❌ ${byType['cancelled']} cancelled` });
    if (overdue > 0) chips.push({ label: `🔴 ${overdue} overdue`, cls: 'task-manager-query-stats-chip--overdue' });

    for (const { label, cls } of chips) {
      const chip = bar.createEl('span', { text: label, cls: 'task-manager-query-stats-chip' });
      if (cls) chip.addClass(cls);
    }
  }

  private renderMessage(el: HTMLElement, message: string, className: string): void {
    const messageEl = document.createElement('div');
    messageEl.addClass(className);
    messageEl.setText(message);
    const isError = className.includes('error'); messageEl.setAttr('role', isError ? 'alert' : 'status'); messageEl.setAttr('aria-live', isError ? 'assertive' : 'polite'); messageEl.setAttr('aria-atomic', 'true');
    el.appendChild(messageEl);
  }

  private async toggleTaskStatus(task: ParsedTask, sourcePath: string): Promise<ParsedTask> {
    const nextCheckbox = cycleTaskCheckbox(task.checkbox, this.getSettings().supportedStates);
    return this.setTaskCheckbox(task, sourcePath, nextCheckbox);
  }

  /**
   * Simple done/undone toggle used by the checklist view's checkbox, where a box
   * click should complete the task (or reopen it) rather than advance through the
   * full status cycle. Right-click still opens the complete status menu.
   */
  private async toggleTaskDone(task: ParsedTask, sourcePath: string): Promise<ParsedTask> {
    const states = this.getSettings().supportedStates;
    const nextCheckbox = checkboxForStatus(task.status === 'done' ? 'todo' : 'done', states);
    return this.setTaskCheckbox(task, sourcePath, nextCheckbox);
  }

  /** Set a task to a specific status symbol (used by kanban drag-and-drop). */
  private async changeTaskStatus(task: ParsedTask, symbol: string, sourcePath: string): Promise<ParsedTask> {
    if (this.getSettings().kanbanFileWritebackEnabled && !task.filePath.endsWith('.canvas')) {
      const targetState = this.getSettings().supportedStates.find((state) => state.rawText === symbol);
      const targetHeading = targetState?.name;
      const abstractFile = this.app.vault.getAbstractFileByPath(task.filePath);
      if (targetHeading && this.isTFile(abstractFile)) {
        let moved = false;
        await this.app.vault.process(abstractFile, (content) => {
          const result = moveKanbanCardLine(content, task.rawLine, targetHeading, symbol, task.lineNumber);
          moved = result.moved;
          return result.markdown;
        });
        if (moved) {
          this.invalidateCache(task.filePath);
          const status = statusFromCheckbox(symbol, this.getSettings().supportedStates);
          this.announcer?.announce(`Task moved to ${targetHeading}: ${task.normalizedText}`);
          return { ...task, checkbox: symbol, status, rawLine: task.rawLine.replace(/^(\s*(?:[-*+]|\d+[.)])\s+\[)[^\]]+(\])/u, `$1${symbol}$2`) };
        }
      }
    }
    return this.setTaskCheckbox(task, sourcePath, symbol);
  }

  private createTaskFromQuery(
    statusSymbol: string | undefined,
    sourcePath: string,
    onUpdated: () => void,
    dates: { due?: string } = {},
  ): void {
    if (this.onCreateTask) {
      this.onCreateTask(statusSymbol, sourcePath, onUpdated, dates);
      return;
    }

    // Backwards-compatible fallback for renderer-only test harnesses: create a
    // minimal ParsedTask-shaped object for callers that only supplied onEditTask.
    this.onEditTask?.({
      checkbox: statusSymbol ?? ' ',
      normalizedText: '',
      rawLine: '',
      filePath: sourcePath,
      lineNumber: 0,
      key: '',
      indentation: '',
      listMarker: '-',
      status: 'todo',
      tags: [],
      metadata: { priority: undefined, dates, onCompletion: undefined, recurrence: undefined, id: undefined, dependsOn: [], reminder: undefined },
    } as unknown as ParsedTask, onUpdated);
  }

  private async quickAddTaskLine(text: string, statusSymbol: string | undefined, sourcePath: string): Promise<void> {
    const targetPath = sourcePath || this.app.workspace.getActiveFile()?.path || 'Task Inbox.md';
    const normalizedPath = targetPath.endsWith('.md') ? targetPath : `${targetPath}.md`;
    const abstractFile = this.app.vault.getAbstractFileByPath(normalizedPath);
    if (!this.isTFile(abstractFile)) {
      new Notice(`Task Manager: cannot quick-add task; ${normalizedPath} was not found.`);
      return;
    }
    const line = formatEditableTaskLine({
      ...emptyEditableTaskLine(),
      checkbox: statusSymbol ?? this.getSettings().supportedStates.find((state) => state.type === 'todo')?.rawText ?? ' ',
      description: text,
      created: this.getSettings().setCreatedDate ? todayString() : '',
    }, this.getSettings().taskFormat);
    await this.app.vault.process(abstractFile, (content) => `${content}${content && !content.endsWith('\n') ? '\n' : ''}${line}\n`);
    this.invalidateCache(normalizedPath);
  }

  /**
   * Groups selected task keys by file path, sorting each group by DESCENDING line number
   * so that higher-line edits happen first and don't shift lower-line indices.
   */
  private groupKeysByFileDescending(keys: string[], tasks: ParsedTask[]): Map<string, ParsedTask[]> {
    const byFile = new Map<string, ParsedTask[]>();
    for (const key of keys) {
      const task = tasks.find((t) => t.key === key);
      if (!task) continue;
      const group = byFile.get(task.filePath) ?? [];
      group.push(task);
      byFile.set(task.filePath, group);
    }
    for (const group of byFile.values()) group.sort((a, b) => b.lineNumber - a.lineNumber);
    return byFile;
  }

  private isCanvasBackedTask(task: ParsedTask): boolean {
    return task.filePath.endsWith('.canvas') || task.key.startsWith(`${task.filePath}:canvas:`);
  }

  private async pluginSaveSettings(): Promise<void> {
    await this.plugin?.saveSettings?.();
  }

  private async addTagToSingleTask(task: ParsedTask, tag: string): Promise<void> {
    await this.bulkAddTag([task.key], [task], tag);
  }

  private async removeTagFromSingleTask(task: ParsedTask, tag: string): Promise<void> {
    await this.bulkRemoveTag([task.key], [task], tag);
  }

  private async setDataviewField(task: ParsedTask, key: string, value: string): Promise<void> {
    if (this.isCanvasBackedTask(task)) {
      new Notice('Canvas tasks are read-only for custom field edits.');
      return;
    }
    const file = this.app.vault.getAbstractFileByPath(task.filePath);
    if (!this.isTFile(file)) return;
    if (this.taskMutations) {
      await this.taskMutations.updateTaskCustomField(file, task, key, value);
      return;
    }
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const fieldPattern = new RegExp(String.raw`\s*[\[(]${escapedKey}::\s*(?:\[\[[\s\S]*?\]\]|[^\]\)\r\n])*[\])]`, 'iu');
    await this.app.vault.process(file, (content) => mutateRenderedTaskLinesInContent(
      content,
      [{
        task,
        rewrite: (line: string) => {
          const replacement = value ? ` [${key}:: ${value}]` : '';
          return fieldPattern.test(line)
            ? line.replace(fieldPattern, replacement).replace(/\s{2,}/gu, ' ').trimEnd()
            : `${line.trimEnd()}${replacement}`;
        },
      }],
      (line, filePath, lineNumber, heading) => this.scanner.parseTaskLine(line, filePath, lineNumber, heading),
    ).content);
    this.invalidateCache(task.filePath);
  }

  private recurrenceHistoryDates(task: ParsedTask): string[] {
    const seriesId = task.metadata.recurrenceSeriesId || task.metadata.id || task.key;
    return this.plugin?.persistedState?.recurrenceOccurrences?.[seriesId]?.map((entry) => entry.date) ?? [];
  }

  private classNames(el: HTMLElement): string[] {
    const classes = (el as unknown as { classes?: string[] }).classes;
    if (Array.isArray(classes)) return [...classes];
    return Array.from(el.classList ?? []);
  }

  private partitionBulkKeys(keys: string[], tasks: ParsedTask[], action: string, notify: boolean): { keys: string[]; skipped: number; failures: TableBulkActionFailure[] } {
    let skipped = 0;
    const supported: string[] = [];
    const failures: TableBulkActionFailure[] = [];
    for (const key of keys) {
      const task = tasks.find((candidate) => candidate.key === key);
      if (!task) {
        skipped += 1;
        failures.push({ taskKey: key, message: 'Task was no longer available.' });
      } else if (this.isCanvasBackedTask(task)) {
        skipped += 1;
        failures.push({ taskKey: key, message: `Canvas tasks do not support bulk ${action}.` });
      } else {
        supported.push(key);
      }
    }
    if (notify && skipped > 0) {
      new Notice(`Skipped ${skipped} unavailable or Canvas task${skipped === 1 ? '' : 's'} during bulk ${action}.`);
    }
    return { keys: supported, skipped, failures };
  }

  private excludeCanvasTasksForBulk(keys: string[], tasks: ParsedTask[], action: string): string[] {
    return this.partitionBulkKeys(keys, tasks, action, true).keys;
  }

  private finishBulkResult(
    action: string,
    attempted: number,
    succeeded: number,
    failed: number,
    skipped: number,
    failures: TableBulkActionFailure[],
    notify: boolean,
  ): TableBulkActionResult {
    const result = { attempted, succeeded, failed, skipped, ...(failures.length > 0 ? { failures } : {}) };
    if (notify && succeeded > 0) this.notifyAction(`${action} updated ${succeeded} task${succeeded === 1 ? '' : 's'}`);
    if (notify && failed > 0) new Notice(`${action} failed for ${failed} task${failed === 1 ? '' : 's'}`);
    return result;
  }

  /**
   * Show a confirmation toast for a completed user action, but only when the
   * user has opted in via the "Show task action notifications" setting. Action
   * results are already reflected in the re-rendered view, so these are off by
   * default. Errors bypass this helper and always surface.
   */
  private notifyAction(message: string): void {
    if (this.getSettings().showActionNotifications) new Notice(message);
  }

  private async bulkComplete(keys: string[], tasks: ParsedTask[], sourcePath: string, notify = true): Promise<TableBulkActionResult> {
    const attempted = keys.length;
    const partition = this.partitionBulkKeys(keys, tasks, 'complete', notify);
    const doneCheckbox = this.getSettings().supportedStates.find((state) => state.type === 'done')?.rawText ?? 'x';
    const byFile = this.groupKeysByFileDescending(partition.keys, tasks);
    let succeeded = 0;
    let failed = 0;
    let skipped = partition.skipped;
    const failures = [...partition.failures];
    for (const fileTasks of byFile.values()) {
      for (const task of fileTasks) {
        if (task.status === 'done') { skipped += 1; continue; }
        try { await this.setTaskCheckbox(task, sourcePath, doneCheckbox); succeeded += 1; }
        catch (error) { failed += 1; failures.push({ taskKey: task.key, message: error instanceof Error ? error.message : String(error) }); }
      }
    }
    return this.finishBulkResult('Complete', attempted, succeeded, failed, skipped, failures, notify);
  }

  private async bulkCancel(keys: string[], tasks: ParsedTask[], sourcePath: string, notify = true): Promise<TableBulkActionResult> {
    const attempted = keys.length;
    const partition = this.partitionBulkKeys(keys, tasks, 'cancel', notify);
    const cancelCheckbox = this.getSettings().supportedStates.find((state) => state.type === 'cancelled')?.rawText ?? '-';
    const byFile = this.groupKeysByFileDescending(partition.keys, tasks);
    let succeeded = 0;
    let failed = 0;
    let skipped = partition.skipped;
    const failures = [...partition.failures];
    for (const fileTasks of byFile.values()) {
      for (const task of fileTasks) {
        if (task.status === 'cancelled') { skipped += 1; continue; }
        try { await this.setTaskCheckbox(task, sourcePath, cancelCheckbox); succeeded += 1; }
        catch (error) { failed += 1; failures.push({ taskKey: task.key, message: error instanceof Error ? error.message : String(error) }); }
      }
    }
    return this.finishBulkResult('Cancel', attempted, succeeded, failed, skipped, failures, notify);
  }

  private async bulkPostpone(keys: string[], tasks: ParsedTask[], notify = true): Promise<TableBulkActionResult> {
    const attempted = keys.length;
    const partition = this.partitionBulkKeys(keys, tasks, 'postpone', notify);
    const byFile = this.groupKeysByFileDescending(partition.keys, tasks);
    let succeeded = 0;
    let failed = 0;
    const failures = [...partition.failures];
    for (const fileTasks of byFile.values()) {
      for (const task of fileTasks) {
        try { await this.deferTask(task, 1); succeeded += 1; }
        catch (error) { failed += 1; failures.push({ taskKey: task.key, message: error instanceof Error ? error.message : String(error) }); }
      }
    }
    return this.finishBulkResult('Postpone', attempted, succeeded, failed, partition.skipped, failures, notify);
  }

  private async bulkReschedule(keys: string[], tasks: ParsedTask[], newDate: string, notify = true): Promise<TableBulkActionResult> {
    const attempted = keys.length;
    const partition = this.partitionBulkKeys(keys, tasks, 'reschedule', notify);
    const byFile = this.groupKeysByFileDescending(partition.keys, tasks);
    let succeeded = 0;
    let failed = 0;
    let skipped = partition.skipped;
    const failures = [...partition.failures];
    for (const [filePath, fileTasks] of byFile) {
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (!this.isTFile(file)) {
        failed += fileTasks.length;
        failures.push(...fileTasks.map((task) => ({ taskKey: task.key, message: 'Source file was unavailable.' })));
        continue;
      }
      try {
        const result = this.taskMutations
          ? await this.taskMutations.updateTaskDates(file, fileTasks, 'due', newDate)
          : await this.scanner.updateTaskDates(file, fileTasks, 'due', newDate);
        if (!this.taskMutations && result.changed > 0) this.invalidateCache(filePath);
        succeeded += result.changed;
        skipped += Math.max(0, fileTasks.length - result.changed);
      } catch (error) {
        failed += fileTasks.length;
        failures.push(...fileTasks.map((task) => ({ taskKey: task.key, message: error instanceof Error ? error.message : String(error) })));
      }
    }
    return this.finishBulkResult('Reschedule', attempted, succeeded, failed, skipped, failures, notify);
  }

  private async bulkPrioritize(keys: string[], tasks: ParsedTask[], priority: string, notify = true): Promise<TableBulkActionResult> {
    const attempted = keys.length;
    const partition = this.partitionBulkKeys(keys, tasks, 'prioritize', notify);
    const byFile = this.groupKeysByFileDescending(partition.keys, tasks);
    let succeeded = 0;
    let failed = 0;
    const failures = [...partition.failures];
    for (const fileTasks of byFile.values()) {
      for (const task of fileTasks) {
        try {
          const file = this.app.vault.getAbstractFileByPath(task.filePath);
          if (!this.isTFile(file)) throw new Error('Source file was unavailable.');
          if (this.taskMutations) await this.taskMutations.updateTaskPriority(file, task, priority);
          else {
            await this.scanner.updateTaskPriority(file, task, priority);
            this.invalidateCache(task.filePath);
          }
          succeeded += 1;
        } catch (error) {
          failed += 1;
          failures.push({ taskKey: task.key, message: error instanceof Error ? error.message : String(error) });
        }
      }
    }
    return this.finishBulkResult('Priority', attempted, succeeded, failed, partition.skipped, failures, notify);
  }

  private async bulkSetCustomField(keys: string[], tasks: ParsedTask[], key: string, value: string, notify = true): Promise<TableBulkActionResult> {
    const attempted = keys.length;
    const partition = this.partitionBulkKeys(keys, tasks, 'custom field', notify);
    const byFile = this.groupKeysByFileDescending(partition.keys, tasks);
    let succeeded = 0;
    let failed = 0;
    let skipped = partition.skipped;
    const failures = [...partition.failures];
    for (const [filePath, fileTasks] of byFile) {
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (!this.isTFile(file)) {
        failed += fileTasks.length;
        failures.push(...fileTasks.map((task) => ({ taskKey: task.key, message: 'Source file was unavailable.' })));
        continue;
      }
      try {
        let changed = 0;
        if (this.taskMutations) {
          changed = (await this.taskMutations.updateTaskCustomFields(file, fileTasks, key, value)).changed;
        } else {
          const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
          const fieldPattern = new RegExp(String.raw`\s*[\[(]${escapedKey}::\s*(?:\[\[[\s\S]*?\]\]|[^\]\)\r\n])*[\])]`, 'iu');
          const replacement = value ? ` [${key}:: ${value}]` : '';
          await this.app.vault.process(file, (content) => {
            const result = mutateRenderedTaskLinesInContent(
              content,
              fileTasks.map((task) => ({
                task,
                rewrite: (line: string) => fieldPattern.test(line)
                  ? line.replace(fieldPattern, replacement).replace(/\s{2,}/gu, ' ').trimEnd()
                  : `${line.trimEnd()}${replacement}`,
              })),
              (line, path, lineNumber, heading) => this.scanner.parseTaskLine(line, path, lineNumber, heading),
            );
            changed = result.changed;
            return result.content;
          });
          if (changed > 0) this.invalidateCache(filePath);
        }
        succeeded += changed;
        skipped += Math.max(0, fileTasks.length - changed);
      } catch (error) {
        failed += fileTasks.length;
        failures.push(...fileTasks.map((task) => ({ taskKey: task.key, message: error instanceof Error ? error.message : String(error) })));
      }
    }
    return this.finishBulkResult(`Custom field ${key}`, attempted, succeeded, failed, skipped, failures, notify);
  }

  private async bulkTag(keys: string[], tasks: ParsedTask[], tag: string, action: 'add' | 'remove', notify: boolean): Promise<TableBulkActionResult> {
    const attempted = keys.length;
    const verb = action === 'add' ? 'tag' : 'remove tag';
    const partition = this.partitionBulkKeys(keys, tasks, verb, notify);
    const byFile = this.groupKeysByFileDescending(partition.keys, tasks);
    let succeeded = 0;
    let failed = 0;
    let skipped = partition.skipped;
    const failures = [...partition.failures];
    for (const [filePath, fileTasks] of byFile) {
      const file = this.app.vault.getAbstractFileByPath(filePath);
      if (!this.isTFile(file)) {
        failed += fileTasks.length;
        failures.push(...fileTasks.map((task) => ({ taskKey: task.key, message: 'Source file was unavailable.' })));
        continue;
      }
      try {
        let changed = 0;
        if (this.taskMutations) {
          changed = (await this.taskMutations.updateTaskTags(file, fileTasks, tag, action)).changed;
        } else {
          await this.app.vault.process(file, (content) => {
            const result = mutateRenderedTaskLinesInContent(
              content,
              fileTasks.map((task) => ({
                task,
                rewrite: action === 'add'
                  ? (line: string, current: ParsedTask) => addTagToTaskLine(line, current.tags, tag)
                  : (line: string) => removeTagFromTaskLine(line, tag),
              })),
              (line, path, lineNumber, heading) => this.scanner.parseTaskLine(line, path, lineNumber, heading),
            );
            changed = result.changed;
            return result.content;
          });
          if (changed > 0) this.invalidateCache(filePath);
        }
        succeeded += changed;
        skipped += Math.max(0, fileTasks.length - changed);
      } catch (error) {
        failed += fileTasks.length;
        failures.push(...fileTasks.map((task) => ({ taskKey: task.key, message: error instanceof Error ? error.message : String(error) })));
      }
    }
    return this.finishBulkResult(action === 'add' ? 'Add tag' : 'Remove tag', attempted, succeeded, failed, skipped, failures, notify);
  }

  private bulkAddTag(keys: string[], tasks: ParsedTask[], tag: string, notify = true): Promise<TableBulkActionResult> {
    return this.bulkTag(keys, tasks, tag, 'add', notify);
  }

  private bulkRemoveTag(keys: string[], tasks: ParsedTask[], tag: string, notify = true): Promise<TableBulkActionResult> {
    return this.bulkTag(keys, tasks, tag, 'remove', notify);
  }

  private attachSwipeGesture(el: HTMLElement, task: ParsedTask, sourcePath: string, rerender: () => void): void {
    let startX = 0;
    let startY = 0;
    let swiping = false;

    el.addEventListener('touchstart', (e) => {
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      swiping = true;
    }, { passive: true });

    el.addEventListener('touchmove', (e) => {
      if (!swiping) return;
      const dx = e.touches[0].clientX - startX;
      const dy = Math.abs(e.touches[0].clientY - startY);
      if (dy > 20) { swiping = false; el.style.transform = ''; return; }
      if (Math.abs(dx) > 5) {
        el.style.transform = `translateX(${Math.min(80, Math.max(-80, dx))}px)`;
        el.style.transition = 'none';
      }
    }, { passive: true });

    el.addEventListener('touchend', (e) => {
      if (!swiping) return;
      const dx = e.changedTouches[0].clientX - startX;
      el.style.transform = '';
      el.style.transition = '';
      swiping = false;
      if (dx > 60) {
        // Right swipe — complete
        void this.toggleTaskStatus(task, sourcePath).then(rerender);
      } else if (dx < -60) {
        // Left swipe — open status menu via synthetic event
        const rect = el.getBoundingClientRect();
        const event = new MouseEvent('contextmenu', { clientX: rect.right - 10, clientY: rect.top + 10 });
        this.openStatusMenu(event, task, sourcePath, (updated) => { this.invalidateCache(updated.filePath); rerender(); return Promise.resolve(); });
      }
    }, { passive: true });
  }

  private attachSwipeMenu(
    el: HTMLElement,
    onSwipe: (target: HTMLElement | null) => void,
  ): void {
    let target: HTMLElement | null = null;
    el.addEventListener('touchstart', (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      target = e.target as HTMLElement | null;
    }, { passive: true });
    setupSwipeHandler(el, (direction) => { if (direction === 'left') onSwipe(target); }, 60);
  }

  private async setTaskCheckbox(task: ParsedTask, sourcePath: string, checkbox: string): Promise<ParsedTask> {
    const abstractFile = this.app.vault.getAbstractFileByPath(task.filePath);
    if (!this.isTFile(abstractFile)) {
      throw new Error(`Cannot find source file ${task.filePath}`);
    }

    this.onBeforeTaskToggle?.(task, sourcePath, checkbox);

    if (task.filePath.endsWith('.canvas')) {
      const canvasRef = parseCanvasTaskKey(task);
      if (!canvasRef) throw new Error('Cannot update Canvas task: missing Canvas node reference');
      await updateCanvasTaskCheckbox(this.app, task.filePath, canvasRef.nodeId, canvasRef.virtualLineNumber, checkbox, task.rawLine);
      this.invalidateCache(task.filePath);
      const status = statusFromCheckbox(checkbox, this.getSettings().supportedStates);
      this.announcer?.announce(`Task status changed to ${status}: ${task.normalizedText}`);
      return {
        ...task,
        checkbox,
        status,
        rawLine: task.rawLine.replace(/^(\s*(?:[-*+]|\d+[.)])\s+\[)[^\]]+(\])/u, `$1${checkbox}$2`),
      };
    }

    const updatedTask = this.taskMutations
      ? await this.taskMutations.updateTaskCheckbox(abstractFile, task, checkbox)
      : await this.scanner.updateTaskCheckbox(abstractFile, task, checkbox);
    if (!this.taskMutations) this.invalidateCache(task.filePath);
    this.announcer?.announce(`Task status changed to ${updatedTask.status}: ${updatedTask.normalizedText}`);
    return updatedTask;
  }

  /**
   * Dependency navigation (#18): open the source file at the line containing the blocking task.
   */
  private navigateToDependency(depId: string, tasks: readonly ParsedTask[]): void {
    const blocking = tasks.find((t) => t.metadata.id === depId);
    if (blocking) {
      const file = this.app.vault.getAbstractFileByPath(blocking.filePath);
      if (file && this.isTFile(file)) {
        void this.app.workspace.getLeaf(false).openFile(file, {
          active: true,
          eState: { line: Math.max(0, blocking.lineNumber - 1) },
        });
        return;
      }
    }
    // Fallback: no matching task found in current results
    new Notice(`Task Manager: no task with id "${depId}" found in current results`);
  }

  /**
   * Recurrence context menu (#11): right-click on the 🔁 rule to skip or edit.
   */
  private openRecurrenceMenu(event: MouseEvent, task: ParsedTask, rerender: () => Promise<void>): void {
    const menu = new Menu();
    menu.addItem((item) =>
      item.setTitle('Skip this occurrence (complete without recurring)')
        .setIcon('skip-forward')
        .onClick(async () => {
          // Complete the task but suppress recurrence generation
          const file = this.app.vault.getAbstractFileByPath(task.filePath);
          if (!this.isTFile(file)) return;
          try {
            const doneCheckbox = this.getSettings().supportedStates.find((s) => s.type === 'done')?.rawText ?? 'x';
            await this.scanner.updateTaskCheckboxSkipRecurrence(file, task, doneCheckbox);
            this.invalidateCache(task.filePath);
            await rerender();
          } catch (error) {
            new Notice(`Task Manager: ${error instanceof Error ? error.message : String(error)}`);
          }
        }),
    );
    menu.addSeparator();
    menu.addItem((item) =>
      item.setTitle('Postpone next occurrence by 1 day')
        .setIcon('calendar-plus')
        .onClick(async () => {
          const field = this.firstDeferrableField(task);
          if (!field) { new Notice('Task Manager: no date field to postpone'); return; }
          await this.updateTaskDate(task, field, 1);
          await rerender();
        }),
    );
    menu.addItem((item) =>
      item.setTitle('Edit recurrence rule…')
        .setIcon('pencil')
        .onClick(() => {
          if (this.onEditTask) this.onEditTask(task, () => { this.invalidateCache(task.filePath); void rerender(); });
        }),
    );
    menu.showAtMouseEvent(event);
  }

  private async moveTaskToKanbanGroup(task: ParsedTask, groupBy: 'status' | 'priority' | 'tag' | 'project' | 'assignee' | 'custom', value: string, customFieldKey?: string): Promise<void> {
    if (groupBy === 'priority') {
      await this.setTaskPriority(task, value, () => Promise.resolve());
      return;
    }
    if (groupBy === 'project' || groupBy === 'assignee') {
      const emptyLabel = groupBy === 'project' ? 'No project' : 'Unassigned';
      await this.setDataviewField(task, groupBy, value === emptyLabel ? '' : value);
      return;
    }
    if (groupBy === 'custom' && customFieldKey) {
      await this.setDataviewField(task, customFieldKey, value === 'None' ? '' : value);
      return;
    }
    if (groupBy === 'tag') {
      await this.replaceTaskTag(task, task.tags[0], value === 'No tag' ? undefined : value);
    }
  }

  private async replaceTaskTag(task: ParsedTask, previousTag: string | undefined, nextTag: string | undefined): Promise<void> {
    if (this.isCanvasBackedTask(task)) throw new Error('Canvas tasks are read-only for tag edits.');
    const file = this.app.vault.getAbstractFileByPath(task.filePath);
    if (!this.isTFile(file)) throw new Error(`Cannot find source file ${task.filePath}`);
    if (this.taskMutations) {
      await this.taskMutations.replaceTaskTag(file, task, previousTag, nextTag);
      return;
    }
    await this.app.vault.process(file, (content) => mutateRenderedTaskLinesInContent(
      content,
      [{
        task,
        rewrite: (line: string, currentTask: ParsedTask) => {
          const removed = previousTag ? removeTagFromTaskLine(line, previousTag) : line;
          const retained = currentTask.tags.filter((tag) => tag.replace(/^#/u, '').toLowerCase() !== previousTag?.replace(/^#/u, '').toLowerCase());
          return nextTag ? addTagToTaskLine(removed, retained, nextTag) : removed;
        },
      }],
      (line, filePath, lineNumber, heading) => this.scanner.parseTaskLine(line, filePath, lineNumber, heading),
    ).content);
    this.invalidateCache(task.filePath);
  }

  private openPriorityMenu(event: MouseEvent, task: ParsedTask, rerender: () => Promise<void>): void {
    const menu = new Menu();
    for (const priority of ['highest', 'high', 'medium', 'normal', 'low', 'lowest']) {
      const isCurrent = task.metadata.priority === priority;
      menu.addItem((item) => {
        item.setTitle(`${priority}${isCurrent ? ' ✓' : ''}`);
        item.onClick(() => {
          void this.setTaskPriority(task, priority, rerender);
        });
      });
    }
    menu.showAtMouseEvent(event);
  }

  private async setTaskPriority(task: ParsedTask, priority: string, rerender: () => Promise<void>): Promise<void> {
    const abstractFile = this.app.vault.getAbstractFileByPath(task.filePath);
    if (!this.isTFile(abstractFile)) throw new Error(`Cannot find source file ${task.filePath}`);
    if (this.taskMutations) await this.taskMutations.updateTaskPriority(abstractFile, task, priority);
    else {
      await this.scanner.updateTaskPriority(abstractFile, task, priority);
      this.invalidateCache(task.filePath);
    }
    await rerender();
  }

  private openStatusMenu(event: MouseEvent, task: ParsedTask, sourcePath: string, onUpdated: (task: ParsedTask) => Promise<void>): void {
    const menu = new Menu();
    for (const state of this.getSettings().supportedStates) {
      menu.addItem((item) => item
        .setTitle(`${state.name} [- [${state.rawText}] ]`)
        .onClick(() => {
          void this.setTaskCheckbox(task, sourcePath, state.rawText)
            .then(onUpdated)
            .catch((error) => new Notice(`Task Manager: ${error instanceof Error ? error.message : String(error)}`));
        }));
    }
    menu.showAtMouseEvent(event);
  }

  private async deferTask(task: ParsedTask, days: number | null): Promise<ParsedTask> {
    const field = this.firstDeferrableField(task);
    if (!field) throw new Error('Task has no due, scheduled, or start date to defer');
    return this.updateTaskDate(task, field, days);
  }

  private async updateTaskDate(task: ParsedTask, field: EditableTaskDateField, days: number | null): Promise<ParsedTask> {
    const currentDate = field === 'reminder'
      ? task.metadata.reminder?.slice(0, 10)
      : field === 'timeStart'
      ? task.metadata.timeStart
      : task.metadata.dates[field];
    const nextDate = days === null ? null : addDays(maxDate(currentDate ?? todayString(), todayString()), days);
    return this.setTaskDate(task, field, nextDate);
  }

  private async setTaskDate(task: ParsedTask, field: EditableTaskDateField, date: string | null): Promise<ParsedTask> {
    const abstractFile = this.app.vault.getAbstractFileByPath(task.filePath);
    if (!this.isTFile(abstractFile)) throw new Error(`Cannot find source file ${task.filePath}`);
    if (this.taskMutations) return this.taskMutations.updateTaskDate(abstractFile, task, field, date);
    const updated = await this.scanner.updateTaskDate(abstractFile, task, field, date);
    this.invalidateCache(task.filePath);
    return updated;
  }

  private openDatePicker(task: ParsedTask, field: EditableTaskDateField, rerender: () => Promise<void>): void {
    const currentDate = field === 'reminder'
      ? task.metadata.reminder?.slice(0, 10)
      : field === 'timeStart'
      ? task.metadata.timeStart
      : task.metadata.dates[field];
    new TaskDatePickerModal(this.app, field, currentDate ?? todayString(), async (date) => {
      await this.setTaskDate(task, field, date);
      await rerender();
    }).open();
  }

  private openDeferMenu(event: MouseEvent, task: ParsedTask, rerender: () => Promise<void>): void {
    const menu = new Menu();
    const today = todayString();
    const field = this.firstDeferrableField(task);
    if (!field) {
      new Notice('Task Manager: no date field to postpone');
      return;
    }
    const currentDate = task.metadata.dates[field] ?? today;
    const base = maxDate(currentDate, today);
    // Match upstream's checkmark indicator: a menu entry whose target date
    // equals the current value of the field being postponed is shown checked.
    const mark = (item: { setChecked?: (v: boolean) => void }, target: string): void => {
      if (field && task.metadata.dates[field] && target === task.metadata.dates[field]) {
        if (typeof item.setChecked === 'function') item.setChecked(true);
      }
    };

    // Fixed-date section: set to today / tomorrow regardless of current value
    menu.addItem((item) => { item.setTitle(`Set to today (${today})`).onClick(() => {
      void this.setTaskDate(task, field, today).then(async () => rerender());
    }); mark(item, today); });
    const tomorrow = addDays(today, 1);
    menu.addItem((item) => { item.setTitle(`Set to tomorrow (${tomorrow})`).onClick(() => {
      void this.setTaskDate(task, field, tomorrow).then(async () => rerender());
    }); mark(item, tomorrow); });
    menu.addSeparator();

    // Relative postpone (forward from base)
    for (const days of [1, 2, 3, 4, 5, 6]) {
      const target = addDays(base, days);
      menu.addItem((item) => { item.setTitle(`Postpone to ${target}`).onClick(() => {
        void this.deferTask(task, days).then(async () => rerender());
      }); mark(item, target); });
    }
    menu.addSeparator();
    for (const [label, unit, amount] of [
      ['Postpone 1 week', 'week', 1], ['Postpone 2 weeks', 'week', 2], ['Postpone 3 weeks', 'week', 3],
      ['Postpone 1 month', 'month', 1],
    ] as Array<[string, 'week' | 'month', number]>) {
      const target = addCalendarUnit(base, unit, amount);
      menu.addItem((item) => { item.setTitle(`${label} (${target})`).onClick(() => {
        void this.setTaskDate(task, field, target).then(async () => rerender());
      }); mark(item, target); });
    }
    menu.addSeparator();
    // Backdate options
    for (const days of [-7, -3, -1]) {
      const label = `Move ${Math.abs(days)} ${Math.abs(days) === 1 ? 'day' : 'days'} earlier`;
      const target = addDays(base, days);
      menu.addItem((item) => { item.setTitle(`${label} (${target})`).onClick(() => {
        void this.deferTask(task, days).then(async () => rerender());
      }); mark(item, target); });
    }
    menu.addSeparator();
    menu.addItem((item) => item.setTitle('Remove date').onClick(() => {
      void this.deferTask(task, null).then(async () => rerender());
    }));
    menu.showAtMouseEvent(event);
  }

  private openDateFieldMenu(event: MouseEvent, task: ParsedTask, field: EditableTaskDateField, rerender: () => Promise<void>): void {
    const menu = new Menu();
    for (const days of [-7, -3, -1, 1, 2, 3, 7, 14, 30]) {
      const label = days < 0 ? `Move ${Math.abs(days)} ${Math.abs(days) === 1 ? 'day' : 'days'} earlier` : `Postpone ${days === 1 ? '1 day' : `${days} days`}`;
      menu.addItem((item) => item.setTitle(label).onClick(() => {
        void this.updateTaskDate(task, field, days).then(async () => rerender());
      }));
    }
    menu.addSeparator();
    menu.addItem((item) => item.setTitle('Remove date').onClick(() => {
      void this.updateTaskDate(task, field, null).then(async () => rerender());
    }));
    menu.showAtMouseEvent(event);
  }

  private canPostpone(task: ParsedTask): boolean {
    if (task.status === 'done' || task.status === 'cancelled' || task.status === 'untracked') return false;
    if (!this.firstDeferrableField(task)) return false;
    return Object.keys(task.metadata.invalidDates).length === 0;
  }

  private firstDeferrableField(task: ParsedTask): 'due' | 'scheduled' | 'start' | null {
    // Postpone preferred field (#10): respect the configured priority order.
    const preferred = this.getSettings().postponePreferredField ?? 'auto';
    if (preferred === 'due' && task.metadata.dates.due) return 'due';
    if (preferred === 'scheduled' && task.metadata.dates.scheduled) return 'scheduled';
    if (preferred === 'start' && task.metadata.dates.start) return 'start';
    // 'auto' fallback: due → scheduled → start (first populated field)
    if (task.metadata.dates.due) return 'due';
    if (task.metadata.dates.scheduled) return 'scheduled';
    if (task.metadata.dates.start) return 'start';
    return null;
  }

  private async openSource(file: TFile | null, linkText: string, sourcePath: string, lineNumber: number, event?: MouseEvent): Promise<void> {
    const newLeaf = Boolean(event && (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey));
    if (file) {
      await this.app.workspace.getLeaf(newLeaf).openFile(file, {
        active: true,
        eState: { line: Math.max(0, lineNumber - 1) },
      });
      return;
    }

    await this.app.workspace.openLinkText(linkText, sourcePath, newLeaf);
  }

  private isTFile(value: unknown): value is TFile {
    return Boolean(value && typeof value === 'object' && 'extension' in value && value.extension === 'md');
  }

  private taskBlockEnd(
    lines: Array<{ text: string; lineEnding: string }>,
    lineIdx: number,
    parentIndentLen: number,
  ): number {
    let nextIdx = lineIdx + 1;
    while (nextIdx < lines.length) {
      const nextLine = lines[nextIdx];
      if (!nextLine) break;
      if (nextLine.text.trim() === '') {
        nextIdx++;
        continue;
      }
      const childMatch = nextLine.text.match(/^((?:\s*>\s*)*)?(\s*)/u);
      const childIndentLen = ((childMatch?.[1] ?? '') + (childMatch?.[2] ?? '')).length;
      if (childIndentLen > parentIndentLen) {
        nextIdx++;
      } else {
        break;
      }
    }
    return nextIdx;
  }

  /**
   * Remove a task line (and immediately-following indented children) from its
   * source file and append them at the end of `targetFile`.
   *
   * Write order: target first, then source.  If the target write fails the
   * source is untouched (no data loss).  If the source removal fails after a
   * successful target write the task exists in both files (a recoverable
   * duplicate) rather than in neither (an unrecoverable deletion).
   */
  private async moveTaskToFile(task: ParsedTask, targetFile: TFile): Promise<void> {
    const sourceAbstract = this.app.vault.getAbstractFileByPath(task.filePath);
    if (!this.isTFile(sourceAbstract)) throw new Error(`Cannot find source file: ${task.filePath}`);

    // Phase 1: read source to identify the lines to move (also used as the
    // stale-line guard in phase 3).
    const sourceSnapshot = await this.app.vault.read(sourceAbstract);
    const snapshotLines = splitContentLines(sourceSnapshot);
    const lineIdx = task.lineNumber - 1;
    if (!snapshotLines[lineIdx]) throw new Error(`Line ${task.lineNumber} not found in ${task.filePath}`);
    if (sourceLineIdentity(snapshotLines[lineIdx].text) !== sourceLineIdentity(task.rawLine)) {
      throw new Error(`Cannot move task: source line ${task.lineNumber} no longer matches the rendered task`);
    }

    // Collect the task line and any immediately-following indented children.
    const parentIndentLen = (task.linePrefix + task.indentation).length;
    const blockEnd = this.taskBlockEnd(snapshotLines, lineIdx, parentIndentLen);
    const linesToMove = snapshotLines.slice(lineIdx, blockEnd);

    // Phase 2: append to target (safe first — failure here leaves source intact).
    await this.app.vault.process(targetFile, (targetContent) => {
      const prefix = targetContent.endsWith('\n') || targetContent === '' ? '' : '\n';
      return targetContent + prefix + linesToMove.map((l) => `${l.text}${l.lineEnding}`).join('');
    });

    // Phase 3: atomically remove from source, re-verifying the snapshot is
    // still current so we don't delete lines modified since phase 1.
    await this.app.vault.process(sourceAbstract, (content) => {
      const lines = splitContentLines(content);
      if (lines[lineIdx]?.text !== snapshotLines[lineIdx]?.text) {
        throw new Error(`Cannot remove task: source line ${task.lineNumber} was modified since the move was initiated`);
      }
      const currentBlock = lines.slice(lineIdx, lineIdx + linesToMove.length);
      if (currentBlock.length !== linesToMove.length || currentBlock.some((line, index) => line.text !== linesToMove[index].text || line.lineEnding !== linesToMove[index].lineEnding)) {
        throw new Error(`Cannot remove task: source block at line ${task.lineNumber} was modified since the move was initiated`);
      }
      lines.splice(lineIdx, linesToMove.length);
      return lines.map((l) => `${l.text}${l.lineEnding}`).join('');
    });
  }

  /**
   * Remove a task line (and its immediately-following indented children) from
   * its source file. Re-verifies the rendered line still matches before
   * splicing so a stale render can't delete an unrelated line.
   */
  private async deleteTask(task: ParsedTask): Promise<void> {
    if (task.filePath.endsWith('.canvas')) throw new Error('Deleting Canvas tasks is not supported');
    const abstractFile = this.app.vault.getAbstractFileByPath(task.filePath);
    if (!this.isTFile(abstractFile)) throw new Error(`Cannot find source file: ${task.filePath}`);
    await this.app.vault.process(abstractFile, (content) => {
      const lines = splitContentLines(content);
      const lineIdx = task.lineNumber - 1;
      if (!lines[lineIdx]) throw new Error(`Line ${task.lineNumber} not found in ${task.filePath}`);
      if (sourceLineIdentity(lines[lineIdx].text) !== sourceLineIdentity(task.rawLine)) {
        throw new Error(`Cannot delete task: source line ${task.lineNumber} no longer matches the rendered task`);
      }
      const parentIndentLen = (task.linePrefix + task.indentation).length;
      const blockEnd = this.taskBlockEnd(lines, lineIdx, parentIndentLen);
      lines.splice(lineIdx, blockEnd - lineIdx);
      return lines.map((l) => `${l.text}${l.lineEnding}`).join('');
    });
    this.invalidateCache(task.filePath);
  }

  private async reorderTasksInFile(srcTask: ParsedTask, destTask: ParsedTask): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(srcTask.filePath);
    if (!this.isTFile(file)) throw new Error(`Cannot find file: ${srcTask.filePath}`);

    await this.app.vault.process(file, (content) => {
      const lines = splitContentLines(content);
      const srcIdx = srcTask.lineNumber - 1;
      const destIdx = destTask.lineNumber - 1;

      if (srcIdx < 0 || srcIdx >= lines.length || destIdx < 0 || destIdx >= lines.length) {
        throw new Error('Task line numbers out of range');
      }

      if (sourceLineIdentity(lines[srcIdx].text) !== sourceLineIdentity(srcTask.rawLine)) {
        throw new Error(`Cannot reorder task: source line ${srcTask.lineNumber} no longer matches the rendered task`);
      }
      if (sourceLineIdentity(lines[destIdx].text) !== sourceLineIdentity(destTask.rawLine)) {
        throw new Error(`Cannot reorder task: destination line ${destTask.lineNumber} no longer matches the rendered task`);
      }

      // Collect source task line and any immediately-following indented children
      const srcParentIndentLen = (srcTask.linePrefix + srcTask.indentation).length;
      const srcBlockEnd = this.taskBlockEnd(lines, srcIdx, srcParentIndentLen);
      if (destIdx >= srcIdx && destIdx < srcBlockEnd) {
        return content;
      }
      const destMatch = lines[destIdx].text.match(/^((?:\s*>\s*)*)?(\s*)/u);
      const destIndentLen = ((destMatch?.[1] ?? '') + (destMatch?.[2] ?? '')).length;
      if (destIndentLen > srcParentIndentLen) {
        return content;
      }
      const linesToMove = lines.slice(srcIdx, srcBlockEnd);

      // Remove the source lines from their original position
      lines.splice(srcIdx, linesToMove.length);

      // Adjust destination index if needed (if we removed lines before the destination)
      let adjustedDestIdx = destIdx;
      if (srcIdx < destIdx) {
        adjustedDestIdx = destIdx - linesToMove.length;
      }

      // Insert the moved lines at the new position
      lines.splice(adjustedDestIdx, 0, ...linesToMove);

      // Reconstruct the file content
      return lines.map((l) => `${l.text}${l.lineEnding}`).join('');
    });

    this.invalidateCache(srcTask.filePath);
  }

  private async renderPreservingScroll(source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext): Promise<void> {
    const scrollContainer = nearestScrollContainer(el);
    const scrollTop = scrollContainer.scrollTop;
    await this.render(source, el, ctx);
    window.requestAnimationFrame(() => {
      scrollContainer.scrollTop = scrollTop;
    });
  }
}

async function copyToClipboard(text: string, successMessage: string): Promise<void> {
  try {
    if (!navigator.clipboard?.writeText) throw new Error('Clipboard API is unavailable');
    await navigator.clipboard.writeText(text);
    new Notice(successMessage);
  } catch (error) {
    new Notice(`Task Manager: Failed to copy to clipboard: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function nearestScrollContainer(el: HTMLElement): HTMLElement {
  let node: HTMLElement | null = el.parentElement;
  while (node) {
    const style = window.getComputedStyle(node);
    const overflowY = style.overflowY;
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) {
      return node;
    }
    node = node.parentElement;
  }
  return (document.scrollingElement as HTMLElement | null) ?? document.documentElement;
}

// ── BulkRescheduleDateModal ──────────────────────────────────────────────────────────────────────────

class BulkRescheduleDateModal extends Modal {
  constructor(
    app: App,
    private readonly onConfirm: (date: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'Reschedule selected tasks' });
    contentEl.createEl('p', {
      text: 'Choose a new due date for all selected tasks:',
      cls: 'task-manager-bulk-reschedule-desc',
    });
    const input = contentEl.createEl('input', {
      type: 'date',
      cls: 'task-manager-bulk-reschedule-input',
    });
    // Default to tomorrow
    const _tm = new Date();
    _tm.setDate(_tm.getDate() + 1);
    input.value = `${_tm.getFullYear()}-${String(_tm.getMonth() + 1).padStart(2, '0')}-${String(_tm.getDate()).padStart(2, '0')}`;
    const btnRow = contentEl.createDiv({ cls: 'task-manager-bulk-reschedule-btns' });
    const confirmBtn = btnRow.createEl('button', { text: 'Reschedule', cls: 'mod-cta' });
    const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });
    confirmBtn.addEventListener('click', () => {
      if (input.value) {
        this.onConfirm(input.value);
        this.close();
      }
    });
    cancelBtn.addEventListener('click', () => {
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

export function formatBacklinkVisibleText(displayName: string, heading: string | null | undefined): string {
  const headingPart = heading && heading !== displayName ? `${displayName} > ${heading}` : displayName;
  return `(${headingPart})`;
}

export function formatTaskManagerQueryBlock(query: string, codeBlockName = 'task-list'): string {
  return ['```' + codeBlockName, query.trim(), '```'].join('\n');
}

export function sampleTaskManagerQuery(codeBlockName = 'task-list'): string {
  return formatTaskManagerQueryBlock('not done\nsort by smart\nlimit 20', codeBlockName);
}

function explainFilterDescription(description: string): string {
  // Recognise the documented date-range filter shape:
  //   <field> [<operator>] <range>
  // where range can be today/tomorrow/yesterday or named ranges like 'this week', 'next month',
  // 'last quarter', a literal YYYY-MM-DD, or a YYYY-MM-DD YYYY-MM-DD pair.
  const match = description.match(
    /^(due|scheduled|start|starts|done|completed|completion|created|cancelled|canceled|reminder|happens)\s+(?:(on\s+or\s+before|on\s+or\s+after|in\s+or\s+before|in\s+or\s+after|before|after|on|in)\s+)?(.+)$/iu,
  );
  if (!match) return description;
  const rangeText = match[3].trim();
  // Try simple relative tokens first (today / tomorrow / yesterday)
  const relative = rangeText.toLowerCase();
  const today = todayString();
  if (relative === 'today') return `${description} => ${today}`;
  if (relative === 'tomorrow') return `${description} => ${addDays(today, 1)}`;
  if (relative === 'yesterday') return `${description} => ${addDays(today, -1)}`;
  // Named ranges: <this|last|next> <week|month|quarter|year>
  const namedRange = relative.match(/^(last|this|next)\s+(week|month|quarter|year)$/u);
  if (namedRange) {
    const range = explainNamedRange(namedRange[1], namedRange[2], today);
    if (range) return `${description} => ${range.start} to ${range.end}`;
  }
  // YYYY-MM-DD literal
  if (/^\d{4}-\d{2}-\d{2}$/u.test(relative)) {
    return description; // already explicit
  }
  // YYYY-MM-DD YYYY-MM-DD pair
  if (/^\d{4}-\d{2}-\d{2}\s+\d{4}-\d{2}-\d{2}$/u.test(relative)) {
    return description;
  }
  return description;
}

function explainNamedRange(
  modifier: string,
  unit: string,
  today: string,
): { start: string; end: string } | null {
  const [year, month, day] = today.split('-').map(Number);
  if (unit === 'week') {
    // ISO week: Monday start.
    const date = new Date(Date.UTC(year, month - 1, day));
    const dow = date.getUTCDay() || 7; // 1..7 (Mon..Sun)
    const monday = addDays(today, -(dow - 1));
    const offset = modifier === 'last' ? -7 : modifier === 'next' ? 7 : 0;
    const start = addDays(monday, offset);
    return { start, end: addDays(start, 6) };
  }
  if (unit === 'month') {
    const targetMonth = month - 1 + (modifier === 'last' ? -1 : modifier === 'next' ? 1 : 0);
    const targetYear = year + Math.floor(targetMonth / 12);
    const normMonth = ((targetMonth % 12) + 12) % 12;
    const last = new Date(Date.UTC(targetYear, normMonth + 1, 0)).getUTCDate();
    return {
      start: `${targetYear}-${`${normMonth + 1}`.padStart(2, '0')}-01`,
      end: `${targetYear}-${`${normMonth + 1}`.padStart(2, '0')}-${`${last}`.padStart(2, '0')}`,
    };
  }
  if (unit === 'quarter') {
    const currentQuarter = Math.floor((month - 1) / 3); // 0..3
    const targetQuarter = currentQuarter + (modifier === 'last' ? -1 : modifier === 'next' ? 1 : 0);
    const targetYear = year + Math.floor(targetQuarter / 4);
    const normQ = ((targetQuarter % 4) + 4) % 4;
    const startMonth = normQ * 3;
    const endMonth = startMonth + 2;
    const lastDay = new Date(Date.UTC(targetYear, endMonth + 1, 0)).getUTCDate();
    return {
      start: `${targetYear}-${`${startMonth + 1}`.padStart(2, '0')}-01`,
      end: `${targetYear}-${`${endMonth + 1}`.padStart(2, '0')}-${`${lastDay}`.padStart(2, '0')}`,
    };
  }
  if (unit === 'year') {
    const targetYear = year + (modifier === 'last' ? -1 : modifier === 'next' ? 1 : 0);
    return { start: `${targetYear}-01-01`, end: `${targetYear}-12-31` };
  }
  return null;
}

/**
 * Build the body of an `explain` block in upstream-compatible format:
 * each filter / group / sort / layout / limit on its own line, with optional `=> <expansion>`
 * for date-range filters. Sections are separated by blank lines, matching upstream's
 * `Explainer.explainQuery` output shape (see src/Query/Explain/Explainer.ts).
 */
export function buildExplainBody(query: TaskQuery): string {
  const sections: string[] = [];

  // Filters — use the raw instruction lines so that, e.g., 'not done' is preserved verbatim
  // (matching upstream Statement.anyContinuationLinesRemoved behaviour).
  const filterLines = query.instructions.filter((line) => !isNonFilterInstruction(line));
  if (filterLines.length === 0) {
    sections.push('No filters supplied. All tasks will match the query.');
  } else {
    sections.push(filterLines.map((line) => explainFilterDescription(line)).join('\n'));
  }

  // Groups (one per line)
  if (query.groups.length > 0) {
    sections.push(
      query.groups
        .map((criterion) => `group by ${criterion.field}${criterion.reverse ? ' reverse' : ''}`)
        .join('\n'),
    );
  }

  // Sort (one per line) — only render if the user explicitly supplied any sort.
  // (defaultSort is applied later by the renderer; upstream similarly only shows user-specified sorts.)
  if (query.sort.length > 0) {
    sections.push(
      query.sort
        .map((criterion) => `sort by ${criterion.field}${criterion.reverse ? ' reverse' : ''}`)
        .join('\n'),
    );
  }

  // Layout statements: short/full mode + hide/show entries.
  const layoutLines: string[] = [];
  if (query.layout.shortMode) layoutLines.push('short mode');
  for (const element of query.layout.hidden) layoutLines.push(`hide ${element}`);
  for (const element of query.layout.shown) layoutLines.push(`show ${element}`);
  if (layoutLines.length > 0) sections.push(layoutLines.join('\n'));

  // Limits (mirrors upstream wording exactly).
  const limitLines: string[] = [];
  if (typeof query.limit === 'number') {
    limitLines.push(`At most ${query.limit} task${query.limit === 1 ? '' : 's'}.`);
  }
  if (typeof query.limitGroups === 'number') {
    limitLines.push(
      `At most ${query.limitGroups} task${query.limitGroups === 1 ? '' : 's'} per group (if any "group by" options are supplied).`,
    );
  }
  if (limitLines.length > 0) sections.push(limitLines.join('\n'));

  return sections.join('\n\n');
}

function isNonFilterInstruction(line: string): boolean {
  return /^(group\s+by|sort\s+by|hide|show|short\s+mode|full\s+mode|limit|explain|ignore\s+global\s+query|preset\s+)/iu.test(line.trim());
}


/**
 * Generate projected future occurrences for all recurring tasks.
 * Used to populate the `futureTasks` parameter in calendar and Gantt renderers.
 */
function buildFutureTasks(tasks: ParsedTask[], count: number): ParsedTask[] {
  if (count <= 0) return [];
  const today = todayString();
  const result: ParsedTask[] = [];
  for (const task of tasks) {
    if (!task.metadata?.recurrence || task.metadata.invalidRecurrence) continue;
    if (task.status === 'done' || task.status === 'cancelled') continue;
    const baseDate = task.metadata.dates?.due ?? task.metadata.dates?.scheduled;
    if (!baseDate) continue;
    const dates = calculateNextRecurrences(
      task.metadata.recurrenceRaw ?? task.metadata.recurrence,
      baseDate,
      today,
      count,
    );
    if (!dates) continue;
    for (const d of dates) {
      result.push({
        ...task,
        key: `${task.key}-proj-${d}`,
        isProjected: true,
        metadata: { ...task.metadata, dates: { ...task.metadata.dates, due: d, scheduled: d } },
      });
    }
  }
  return result;
}

function addDays7(value: string): string { return addDays(value, 7); }

/** Add calendar weeks or months, respecting true month lengths. */
function addCalendarUnit(value: string, unit: 'week' | 'month', amount: number): string {
  return unit === 'week' ? addDays(value, amount * 7) : addIsoMonths(value, amount);
}

function maxDate(left: string, right: string): string {
  return left > right ? left : right;
}

function parseCanvasTaskKey(task: ParsedTask): { nodeId: string; virtualLineNumber: number } | null {
  const prefix = `${task.filePath}:canvas:`;
  if (!task.key.startsWith(prefix)) return null;
  const rest = task.key.slice(prefix.length);
  const firstColon = rest.indexOf(':');
  if (firstColon < 0) return null;
  const secondColon = rest.indexOf(':', firstColon + 1);
  if (secondColon < 0) return null;
  const nodeId = rest.slice(0, firstColon);
  const virtualLineNumber = Number.parseInt(rest.slice(firstColon + 1, secondColon), 10);
  if (!nodeId || !Number.isFinite(virtualLineNumber) || virtualLineNumber < 1) return null;
  return { nodeId, virtualLineNumber };
}

function isEditableDateField(field: DateField): field is Exclude<EditableTaskDateField, 'dueTime' | 'scheduledTime' | 'startTime' | 'timeStart'> {
  return field === 'due' || field === 'scheduled' || field === 'start' || field === 'created' || field === 'done' || field === 'cancelled' || field === 'reminder';
}

// Map metadata key -> upstream-compatible semantic CSS class.
const SEMANTIC_FIELD_CLASS: Record<string, string> = {
  'id': 'task-id',
  'depends on': 'task-dependsOn',
  'due date': 'task-due',
  'scheduled date': 'task-scheduled',
  'start date': 'task-start',
  'created date': 'task-created',
  'done date': 'task-done',
  'cancelled date': 'task-cancelled',
  'reminder date': 'task-reminder',
  'priority': 'task-priority',
  'recurrence rule': 'task-recurring',
  'on completion': 'task-onCompletion',
  'block link': 'task-block-link',
  'tags': 'task-tags',
  'effort': 'task-effort',
  'actual': 'task-actual',
};

/**
 * Map local TaskStateType values (lowercase, plus local-only blocked/deferred)
 * to upstream Tasks plugin's StatusType enum values (uppercase). Themes target
 * the upstream values via `[data-task-status-type="TODO"]` etc.
 */
// Map local layout `hidden` Set entries to upstream `tasks-layout-hide-<component>`
// class names emitted on the outer `<ul>` so themes can target hidden components
// (e.g. `.tasks-layout-hide-tags .task-description a.tag { display: none; }`).
const LAYOUT_HIDE_CLASS: Record<string, string> = {
  'recurrence rule': 'tasks-layout-hide-recurrenceRule',
  'depends on': 'tasks-layout-hide-dependsOn',
  'on completion': 'tasks-layout-hide-onCompletion',
  'id': 'tasks-layout-hide-id',
  'priority': 'tasks-layout-hide-priority',
  'tags': 'tasks-layout-hide-tags',
  'block link': 'tasks-layout-hide-blockLink',
  'due date': 'tasks-layout-hide-dueDate',
  'scheduled date': 'tasks-layout-hide-scheduledDate',
  'start date': 'tasks-layout-hide-startDate',
  'created date': 'tasks-layout-hide-createdDate',
  'cancelled date': 'tasks-layout-hide-cancelledDate',
  'done date': 'tasks-layout-hide-doneDate',
  'urgency': 'tasks-layout-hide-urgency',
  'backlink': 'tasks-layout-hide-backlink',
  'edit button': 'tasks-layout-hide-editButton',
  'defer button': 'tasks-layout-hide-postponeButton',
  'task count': 'tasks-layout-hide-taskCount',
};

export function upstreamLayoutHideClasses(query: TaskQuery): string[] {
  const out: string[] = [];
  for (const hidden of query.layout.hidden) {
    const cls = LAYOUT_HIDE_CLASS[hidden];
    if (cls) out.push(cls);
  }
  return out;
}

const UPSTREAM_STATUS_TYPE: Record<string, string> = {
  todo: 'TODO',
  in_progress: 'IN_PROGRESS',
  blocked: 'TODO',
  deferred: 'TODO',
  done: 'DONE',
  cancelled: 'CANCELLED',
  untracked: 'NON_TASK',
};

const DATE_DATASET_KEY: Partial<Record<DateField, string>> = {
  due: 'data-task-due',
  scheduled: 'data-task-scheduled',
  start: 'data-task-start',
  created: 'data-task-created',
  done: 'data-task-done',
  cancelled: 'data-task-cancelled',
  reminder: 'data-task-reminder',
};

/**
 * Translate an absolute YYYY-MM-DD date to a relative-date attribute value that
 * matches upstream Tasks plugin conventions: 'today', 'past-Nd', 'future-Nd',
 * or 'past-far' / 'future-far' for dates beyond +/- 7 days.
 */
export function relativeDateAttribute(value: string, todayYmd: string): string | null {
  if (!isValidIsoDate(value)) return null;
  const target = Date.UTC(
    Number.parseInt(value.slice(0, 4), 10),
    Number.parseInt(value.slice(5, 7), 10) - 1,
    Number.parseInt(value.slice(8, 10), 10),
  );
  const today = Date.UTC(
    Number.parseInt(todayYmd.slice(0, 4), 10),
    Number.parseInt(todayYmd.slice(5, 7), 10) - 1,
    Number.parseInt(todayYmd.slice(8, 10), 10),
  );
  if (Number.isNaN(target) || Number.isNaN(today)) return null;
  const diffDays = Math.round((today - target) / 86_400_000);
  if (diffDays === 0) return 'today';
  const abs = Math.abs(diffDays);
  const prefix = diffDays > 0 ? 'past-' : 'future-';
  if (abs <= 7) return `${prefix}${abs}d`;
  return `${prefix}far`;
}

function shortMetadataText(key: string, value: string): string {  const icon = ({
    id: '🆔',
    'depends on': '⛔',
    'due date': '📅',
    'scheduled date': '⏳',
    'start date': '🛫',
    'created date': '➕',
    'done date': '✅',
    'cancelled date': '❌',
    'reminder date': '⏰',
    priority: priorityIcon(value),
    'recurrence rule': '🔁',
    'on completion': '🏁',
    tags: '#',
  } as Record<string, string>)[key];
  return icon || value;
}

/**
 * Full-mode chip label: replaces the verbose English field word with a compact
 * leading icon so each metadata chip scans at a glance (e.g. "due 2026-06-05 Fri"
 * → "📅 2026-06-05 Fri"). The raw value is still used for tooltips/aria.
 */
/**
 * Compact, relative date label for the checklist planning view.
 * Examples: "Today", "Tomorrow", "Yesterday", "Fri", "Jun 5", "Jun 5 '27".
 * An optional time of day is appended (e.g. "Today 2:00 PM").
 */
function compactDateLabel(dateStr: string, time?: string): string {
  const iso = dateStr.slice(0, 10);
  const today = new Date(`${todayString()}T00:00:00`);
  const target = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(target.getTime())) return time ? `${dateStr} ${time}` : dateStr;
  const diffDays = Math.round((target.getTime() - today.getTime()) / 86_400_000);
  let label: string;
  if (diffDays === 0) label = 'Today';
  else if (diffDays === 1) label = 'Tomorrow';
  else if (diffDays === -1) label = 'Yesterday';
  else if (diffDays >= 2 && diffDays <= 6) label = formatIsoWeekday(iso);
  else {
    label = formatIsoMonthDay(iso);
    if (target.getFullYear() !== today.getFullYear()) label += ` '${String(target.getFullYear()).slice(2)}`;
  }
  return time ? `${label} ${time}` : label;
}

function metadataChipLabel(key: string, value: string): string {
  switch (key) {
    case 'priority': return `${priorityIcon(value)} ${value.replace(/^priority\s+/iu, '')}`.trim();
    case 'due date': return `📅 ${value.replace(/^due\s+/iu, '')}`;
    case 'scheduled date': return `⏳ ${value.replace(/^scheduled\s+/iu, '')}`;
    case 'start date': return `🛫 ${value.replace(/^start\s+/iu, '')}`;
    case 'created date': return `➕ ${value.replace(/^created\s+/iu, '')}`;
    case 'done date': return `✅ ${value.replace(/^done\s+/iu, '')}`;
    case 'cancelled date': return `❌ ${value.replace(/^cancelled\s+/iu, '')}`;
    case 'reminder date': return `⏰ ${value.replace(/^reminder\s+/iu, '')}`;
    case 'recurrence rule': return `🔁 ${value.replace(/^recurs\s+/iu, '')}`;
    case 'on completion': return `🏁 ${value.replace(/^on completion\s+/iu, '')}`;
    default: return value;
  }
}

export class TaskDatePickerModal extends Modal {
  constructor(
    app: App,
    private readonly field: EditableTaskDateField,
    private readonly initialDate: string,
    private readonly onSubmit: (date: string | null) => Promise<void> | void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: `Edit ${this.field} date` });
    
    if (typeof contentEl.createDiv !== 'function') return;

    // Quick date suggestion buttons (above the date input)
    const today = todayString();
    const quicksContainer = contentEl.createDiv({ cls: 'task-manager-date-quicks' });
    const quickOptions = [
      { label: 'Today', date: today },
      { label: 'Tomorrow', date: addDays(today, 1) },
      { label: 'In 2 days', date: addDays(today, 2) },
      { label: 'In 3 days', date: addDays(today, 3) },
      { label: '+1 week', date: addDays(today, 7) },
      { label: '+2 weeks', date: addDays(today, 14) },
      { label: '+1 month', date: addCalendarUnit(today, 'month', 1) },
    ];
    
    const input = contentEl.createEl('input');
    input.type = 'date';
    input.value = this.initialDate?.slice(0, 10) ?? today;
    input.addClass?.('task-manager-date-picker-input');
    input.classList?.add('task-manager-date-picker-input');
    
    for (const option of quickOptions) {
      const btn = quicksContainer.createEl('button', { text: option.label });
      btn.addClass('task-manager-date-quick');
      btn.addEventListener('click', () => {
        input.value = option.date;
      });
    }
    const controls = contentEl.createDiv({ cls: 'task-manager-date-picker-controls' });
    const save = controls.createEl('button', { text: 'Save' });
    save.addClass('mod-cta');
    save.addEventListener('click', () => {
      void Promise.resolve(this.onSubmit(input.value || null))
        .then(() => this.close())
        .catch((error) => new Notice(`Task Manager: ${error instanceof Error ? error.message : String(error)}`));
    });
    const clear = controls.createEl('button', { text: 'Clear' });
    clear.addEventListener('click', () => {
      void Promise.resolve(this.onSubmit(null))
        .then(() => this.close())
        .catch((error) => new Notice(`Task Manager: ${error instanceof Error ? error.message : String(error)}`));
    });
    const cancel = controls.createEl('button', { text: 'Cancel' });
    cancel.addEventListener('click', () => this.close());
  }
}

/**
 * Fuzzy file picker used by the 'Move to file…' item context-menu action.
 * Presents all vault Markdown files sorted by path; on selection invokes the
 * async `onSelect` callback which performs the actual move.
 */
class TaskMoveToFilePicker extends FuzzySuggestModal<TFile> {
  constructor(
    app: App,
    private readonly onSelect: (file: TFile) => Promise<void>,
  ) {
    super(app);
    this.setPlaceholder('Choose target file to move task to…');
  }

  getItems(): TFile[] {
    return this.app.vault.getMarkdownFiles().sort((a, b) => a.path.localeCompare(b.path));
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  onChooseItem(file: TFile): void {
    void this.onSelect(file);
  }
}

/** Confirmation dialog shown before permanently deleting a task line. */
class TaskDeleteConfirmModal extends Modal {
  constructor(
    app: App,
    private readonly taskText: string,
    private readonly onConfirm: () => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('task-manager-delete-confirm');
    contentEl.createEl('h3', { text: 'Delete task?' });
    const preview = this.taskText.length > 120 ? `${this.taskText.slice(0, 120)}\u2026` : this.taskText;
    contentEl.createEl('p', { text: preview || '(empty task)', cls: 'task-manager-delete-confirm-preview' });
    contentEl.createEl('p', {
      text: 'This removes the task line (and any indented sub-items) from the note. This cannot be undone from here.',
      cls: 'task-manager-delete-confirm-note',
    });

    const btnRow = contentEl.createDiv({ cls: 'task-manager-delete-confirm-buttons' });
    const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => this.close());
    const deleteBtn = btnRow.createEl('button', { text: 'Delete', cls: 'mod-warning' });
    deleteBtn.addEventListener('click', () => {
      deleteBtn.disabled = true;
      void (async () => {
        try {
          await this.onConfirm();
        } finally {
          this.close();
        }
      })();
    });
    cancelBtn.focus();
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Format a Date object as YYYY-MM-DD. */
function isoDate(d: Date): string { return formatLocalDate(d); }

function taskManagerTodayString(): string {
  return isoDate(new Date());
}

function formatDateWithDay(value: string, displayFormat?: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(value);
  if (!match) return value;
  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10) - 1;
  const day = Number.parseInt(match[3], 10);
  // Pass a *local-midnight* Date to moment so it formats to the same calendar
  // day as the YYYY-MM-DD string regardless of the user's UTC offset.
  // Using Date.UTC here produced the previous calendar day in UTC− timezones
  // because moment interprets the Date in local time.
  const localDate = new Date(year, month, day);
  if (Number.isNaN(localDate.getTime())) return value;
  // Use user-configured format if provided (via Moment.js format string)
  if (displayFormat && displayFormat.trim()) {
    try {
      // Moment.js is available in the Obsidian environment via window.moment
      const momentFn = (globalThis as unknown as { moment?: (d: Date) => { format: (f: string) => string } }).moment;
      if (momentFn) return momentFn(localDate).format(displayFormat);
    } catch { /* fall through to default */ }
  }
  const date = new Date(Date.UTC(year, month, day));
  const dayName = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getUTCDay()];
  return `${value} ${dayName}`;
}

function priorityIcon(value: string): string {
  if (value.includes('highest')) return '🔺';
  if (value.includes('high')) return '⏫';
  if (value.includes('medium')) return '🔼';
  if (value.includes('lowest')) return '⏬';
  if (value.includes('low')) return '🔽';
  return '!';
}
