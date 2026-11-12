import { todayString } from './date-utils';
import { addIsoDays as addDays } from './iso-date';
import { ItemView, TFile, Menu, Notice, type WorkspaceLeaf } from 'obsidian';
import type { TaskManagerSettings } from './types';
import { scanFileWithTaskNotes, type TaskScanner, type ParsedTask } from './task-scanner';
import type { TaskMutationService } from './task-mutation-service';
import type { TaskQueryRenderer } from './query-renderer';
import { filterTasks, parseTaskQuery } from './task-query';
import { cycleTaskCheckbox } from './task-model';
import { renderProgressBar } from './progress-bar-decorator';
import { renderHabitTracker, HabitTracker } from './habit-tracker';
import { renderKanban } from './kanban-renderer';
import { renderCalendar } from './calendar-renderer';
import { PlanningBoard, renderPlanningBoard } from './planning-board';
import { t, type TranslationKey } from './i18n';
import { applyLocaleScope } from './locale-scope';

export const VIEW_TYPE_TASK_PANEL = 'task-manager-panel';

const SIDEBAR_SEARCH_DEBOUNCE_MS = 120;
export const SIDEBAR_LIST_PAGE_SIZE = 150;
export const SIDEBAR_AGENDA_INITIAL_ROWS = 150;
export const SIDEBAR_AGENDA_LOAD_MORE_ROWS = 100;
export const SIDEBAR_KANBAN_INITIAL_CARDS = 200;
export const SIDEBAR_KANBAN_LOAD_MORE_CARDS = 100;
let sidebarPanelSequence = 0;

export interface SidebarHierarchyStat {
  total: number;
  done: number;
}

export function sidebarHierarchyKey(task: Pick<ParsedTask, 'filePath' | 'lineNumber' | 'key'>): string {
  return `${task.filePath}\0${task.lineNumber}\0${task.key}`;
}

export function buildSidebarHierarchyStats(tasks: readonly ParsedTask[]): ReadonlyMap<string, SidebarHierarchyStat> {
  const groups = new Map<string, ParsedTask[]>();
  for (const task of tasks) {
    const groupKey = `${task.filePath}\0${task.linePrefix}`;
    const group = groups.get(groupKey) ?? [];
    group.push(task);
    groups.set(groupKey, group);
  }
  const result = new Map<string, SidebarHierarchyStat>();
  for (const group of groups.values()) {
    const ordered = [...group].sort((left, right) => left.lineNumber - right.lineNumber);
    const donePrefix = [0];
    for (const task of ordered) donePrefix.push((donePrefix.at(-1) ?? 0) + (task.status === 'done' || task.status === 'cancelled' ? 1 : 0));
    const stack: number[] = [];
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      const indentation = ordered[index]?.indentation.length ?? 0;
      while (stack.length > 0 && (ordered[stack.at(-1) ?? 0]?.indentation.length ?? 0) > indentation) stack.pop();
      const boundary = stack.at(-1) ?? ordered.length;
      const total = Math.max(0, boundary - index - 1);
      const done = total > 0 ? (donePrefix[boundary] ?? 0) - (donePrefix[index + 1] ?? 0) : 0;
      if (total > 0 && ordered[index]) result.set(sidebarHierarchyKey(ordered[index]), { total, done });
      stack.push(index);
    }
  }
  return result;
}

type PanelTab = 'today' | 'upcoming' | 'all' | 'agenda' | 'current-file' | 'planning' | (string & {});
type PanelViewMode = 'list' | 'kanban' | 'calendar';

export class TaskPanelView extends ItemView {
  private readonly panelContentId = `task-manager-panel-tab-content-${sidebarPanelSequence++}`;
  private activeTab: PanelTab = 'today';
  private viewMode: PanelViewMode = 'list';
  private searchQuery = '';
  private tasks: ParsedTask[] = [];
  private isLoading = false;
  private loadError: string | null = null;
  /** Set to true if a refresh was requested while one was already in progress. */
  private pendingRefresh = false;
  private activeFilePath = '';
  private searchRenderTimer: number | null = null;
  private calendarDispose?: () => void;
  private closed = false;
  private disposeLocaleScope?: () => void;
  private refreshToken = 0;
  private listPage = 0;
  private agendaVisibleCount = SIDEBAR_AGENDA_INITIAL_ROWS;
  private planningBoardSession?: PlanningBoard;
  private habitsRequestGeneration = 0;

  private taskMutations?: TaskMutationService;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly getSettings: () => TaskManagerSettings,
    private readonly scanner: TaskScanner,
    private readonly getRenderer: () => TaskQueryRenderer,
    private readonly onCreateTask?: (opts?: { date?: string; statusSymbol?: string }) => void,
    private readonly getIndexedTasks?: () => Promise<ParsedTask[]>,
  ) {
    super(leaf);
  }

  setTaskMutations(taskMutations: TaskMutationService): void {
    this.taskMutations = taskMutations;
  }

  getViewType(): string {
    return VIEW_TYPE_TASK_PANEL;
  }

  getDisplayText(): string {
    return t('ui.panel.tasks');
  }

  getIcon(): string {
    return 'check-circle';
  }

  async onOpen(): Promise<void> {
    this.closed = false;
    this.disposeLocaleScope?.();
    this.disposeLocaleScope = applyLocaleScope(this.contentEl);
    this.refreshToken++;
    // Track active file changes
    this.registerEvent(
      this.app.workspace.on('active-leaf-change', () => {
        const activeFile = this.app.workspace.getActiveFile();
        const newPath = activeFile?.path ?? '';
        if (newPath !== this.activeFilePath) {
          this.activeFilePath = newPath;
          if (this.activeTab === 'current-file') {
            this.renderView();
          }
        }
      }),
    );
    const activeFile = this.app.workspace.getActiveFile();
    this.activeFilePath = activeFile?.path ?? '';
    await this.refresh();
  }

  onClose(): Promise<void> {
    this.closed = true;
    this.refreshToken++;
    this.pendingRefresh = false;
    this.clearPendingSearchRender();
    this.disposeCalendarView();
    this.planningBoardSession = undefined;
    this.habitsRequestGeneration += 1;
    this.disposeLocaleScope?.();
    this.disposeLocaleScope = undefined;
    return Promise.resolve();
  }

  async refresh(): Promise<void> {
    if (this.closed) return;
    if (this.isLoading) {
      // Another load is already in flight. Record that we need a follow-up
      // refresh so the view always reflects the latest vault state after the
      // current scan finishes.
      this.pendingRefresh = true;
      return;
    }
    const token = ++this.refreshToken;
    this.isLoading = true;
    this.loadError = null;
    this.pendingRefresh = false;
    this.renderView();
    try {
      const tasks = await this.loadAllTasks();
      if (this.closed || token !== this.refreshToken) return;
      this.tasks = tasks;
      this.resetResultWindows();
    } catch (error) {
      if (!this.closed && token === this.refreshToken) this.loadError = error instanceof Error ? error.message : String(error);
    } finally {
      this.isLoading = false;
    }
    if (this.closed || token !== this.refreshToken) return;
    this.renderView();
    // If a concurrent update arrived while we were scanning, run one more
    // refresh now that the vault is stable, so that update is not silently lost.
    if (this.pendingRefresh && !this.closed) {
      void this.refresh();
    }
  }

  private resetResultWindows(): void {
    this.listPage = 0;
    this.agendaVisibleCount = SIDEBAR_AGENDA_INITIAL_ROWS;
  }

  private async loadAllTasks(): Promise<ParsedTask[]> {
    if (this.getIndexedTasks) return this.getIndexedTasks();
    const tasks: ParsedTask[] = [];
    const excluded = this.getSettings().excludedFolders ?? [];
    const files = this.app.vault.getMarkdownFiles().filter((file) => {
      if (excluded.length === 0) return true;
      const lowerPath = file.path.toLowerCase();
      return !excluded.some((prefix) => lowerPath.startsWith(`${prefix}/`) || lowerPath === prefix);
    });
    const settings = this.getSettings();
    for (const file of files) {
      tasks.push(...await scanFileWithTaskNotes(file, this.app, this.scanner, settings));
    }
    return tasks;
  }

  private renderView(): void {
    if (this.closed) return;
    const activeElement = typeof document === 'undefined' ? null : document.activeElement as HTMLElement | null;
    const focusedRowKey = activeElement?.closest?.('[data-sidebar-task-key]')?.getAttribute('data-sidebar-task-key') ?? null;
    const focusedControl = focusedRowKey ? activeElement?.getAttribute('data-sidebar-focus-id') ?? null : null;
    const previousScrollTop = this.contentEl.scrollTop;
    const focusedPager = activeElement?.classList?.contains('task-manager-panel-page-next') ? 'next'
      : activeElement?.classList?.contains('task-manager-panel-page-previous') ? 'previous' : null;
    this.clearPendingSearchRender();
    this.disposeCalendarView();
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('task-manager-panel');
    if (!this.disposeLocaleScope) this.disposeLocaleScope = applyLocaleScope(contentEl);
    const skipLink = contentEl.createEl('a', { text: t('ui.skipToResults'), cls: 'task-manager-skip-to-content', href: `#${this.panelContentId}` });
    skipLink.setAttr('aria-label', t('ui.skipToResults'));

    const settings = this.getSettings();

    // ── Header ─────────────────────────────────────────────────────
    const header = contentEl.createDiv({ cls: 'task-manager-panel-header' });
    header.createEl('span', { text: t('ui.panel.tasks'), cls: 'task-manager-panel-title' });

    const headerRight = header.createDiv({ cls: 'task-manager-panel-header-right' });

    // View mode toggle
    const viewToggle = headerRight.createDiv({ cls: 'task-manager-panel-view-toggle' });
    viewToggle.setAttr('role', 'group');
    viewToggle.setAttr('aria-label', t('ui.viewMode'));
    for (const [mode, icon, labelKey] of [['list', '≡', 'ui.view.list'], ['kanban', '⬛', 'ui.view.kanban'], ['calendar', '▦', 'ui.view.calendar']] as [PanelViewMode, string, TranslationKey][]) {
      const label = t(labelKey);
      const btn = viewToggle.createEl('button', {
        cls: `task-manager-panel-view-btn${this.viewMode === mode ? ' is-active' : ''}`,
        title: label,
      });
      btn.setText(icon);
      btn.dataset.mode = mode;
      btn.setAttr('aria-label', label);
      btn.setAttr('aria-pressed', String(this.viewMode === mode));
      btn.addEventListener('click', () => {
        this.viewMode = mode;
        this.resetResultWindows();
        this.renderView();
        this.contentEl.querySelector<HTMLButtonElement>(`.task-manager-panel-view-btn[data-mode="${mode}"]`)?.focus();
      });
    }

    const refreshBtn = headerRight.createEl('button', { cls: 'task-manager-panel-refresh', title: t('ui.refreshTasks') });
    refreshBtn.setText('↻');
    refreshBtn.setAttr('aria-label', t('ui.refreshTasks'));
    refreshBtn.disabled = this.isLoading;
    refreshBtn.setAttr('aria-busy', String(this.isLoading));
    refreshBtn.addEventListener('click', () => { void this.refresh(); });

    // ── Search bar ─────────────────────────────────────────────────
    const searchRow = contentEl.createDiv({ cls: 'task-manager-panel-search-row' });
    const searchInput = searchRow.createEl('input', {
      type: 'text',
      cls: 'task-manager-panel-search',
      placeholder: t('ui.searchPlaceholder'),
    });
    searchInput.setAttr('aria-label', t('ui.searchLabel'));
    let listEl: HTMLDivElement | null = null;
    searchInput.value = this.searchQuery;
    const clearBtn = searchRow.createEl('button', { text: '✕', cls: 'task-manager-panel-search-clear' });
    clearBtn.setAttr('aria-label', t('ui.clearSearch'));
    clearBtn.setAttr('title', t('ui.clearSearch'));
    clearBtn.style.display = this.searchQuery ? '' : 'none';
    clearBtn.addEventListener('click', () => {
      this.searchQuery = '';
      this.resetResultWindows();
      searchInput.value = '';
      clearBtn.style.display = 'none';
      this.clearPendingSearchRender();
      this.renderTaskList(listEl);
    });
    searchInput.addEventListener('input', () => {
      this.searchQuery = searchInput.value;
      this.resetResultWindows();
      clearBtn.style.display = this.searchQuery ? '' : 'none';
      this.scheduleSearchRender(listEl);
    });

    // ── Tabs ───────────────────────────────────────────────────────
    const tabBar = contentEl.createDiv({ cls: 'task-manager-panel-tabs' });
    tabBar.setAttr('role', 'tablist');
    tabBar.setAttr('aria-label', t('ui.taskFilters'));
    const builtinTabs: Array<{ id: PanelTab; label: string }> = [
      { id: 'today', label: t('ui.tab.today') },
      { id: 'upcoming', label: t('ui.tab.upcoming') },
      { id: 'agenda', label: t('ui.tab.agenda') },
      { id: 'all', label: t('ui.tab.all') },
      { id: 'current-file', label: `📄 ${t('ui.tab.thisFile')}` },
      ...(settings.pinnedDockEnabled ? [{ id: 'pinned', label: '📌 Pinned' }] : []),
      ...(settings.habitTrackingEnabled ? [{ id: 'habits', label: `🔁 ${t('ui.tab.habits')}` }] : []),
      ...(settings.planningBoardSidebarEnabled ? [{ id: 'planning', label: '📋 Planning Board' }] : []),
    ];
    const savedQueryTabs = settings.savedQueries.slice(0, 5).map((q) => ({ id: `query:${q.name}`, label: q.name }));
    const allTabs = [...builtinTabs, ...savedQueryTabs];
    if (!allTabs.some((tab) => tab.id === this.activeTab)) this.activeTab = 'today';

    const tabButtons: HTMLButtonElement[] = [];
    for (const [tabIndex, tab] of allTabs.entries()) {
      const selected = this.activeTab === tab.id;
      const btn = tabBar.createEl('button', {
        text: tab.label,
        cls: `task-manager-panel-tab${selected ? ' is-active' : ''}`,
      });
      btn.id = `${this.panelContentId}-tab-${tabIndex}`;
      btn.setAttr('role', 'tab');
      btn.setAttr('aria-selected', String(selected));
      btn.setAttr('aria-controls', this.panelContentId);
      btn.tabIndex = selected ? 0 : -1;
      btn.addEventListener('click', () => {
        this.activeTab = tab.id;
        this.resetResultWindows();
        this.renderView();
        this.contentEl.querySelector<HTMLButtonElement>(`#${this.panelContentId}-tab-${tabIndex}`)?.focus();
      });
      tabButtons.push(btn);
    }
    tabBar.addEventListener('keydown', (event: KeyboardEvent) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const current = tabButtons.indexOf(document.activeElement as HTMLButtonElement);
      if (current < 0) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0
        : event.key === 'End' ? tabButtons.length - 1
        : (current + (event.key === 'ArrowRight' ? 1 : -1) + tabButtons.length) % tabButtons.length;
      tabButtons[next]?.focus();
      tabButtons[next]?.click();
    });

    // ── Content area ───────────────────────────────────────────────
    listEl = contentEl.createDiv({ cls: 'task-manager-panel-list' });
    listEl.id = this.panelContentId;
    listEl.setAttr('role', 'tabpanel');
    listEl.setAttr('aria-labelledby', `${this.panelContentId}-tab-${Math.max(0, allTabs.findIndex((tab) => tab.id === this.activeTab))}`);
    listEl.tabIndex = -1;
    this.renderTaskList(listEl);
    if (focusedRowKey) {
      const row = contentEl.querySelector<HTMLElement>(`[data-sidebar-task-key="${focusedRowKey}"]`);
      const control = focusedControl ? row?.querySelector<HTMLElement>(`[data-sidebar-focus-id="${focusedControl}"]`) : null;
      (control ?? row?.querySelector<HTMLElement>('.task-manager-panel-desc-button'))?.focus();
    } else if (focusedPager) {
      const preferred = contentEl.querySelector<HTMLButtonElement>(`.task-manager-panel-page-${focusedPager}`);
      const fallback = contentEl.querySelector<HTMLButtonElement>(focusedPager === 'next' ? '.task-manager-panel-page-previous' : '.task-manager-panel-page-next');
      (preferred && !preferred.disabled ? preferred : fallback)?.focus();
    }
    this.contentEl.scrollTop = previousScrollTop;
  }

  private clearPendingSearchRender(): void {
    if (this.searchRenderTimer === null) return;
    window.clearTimeout(this.searchRenderTimer);
    this.searchRenderTimer = null;
  }

  private disposeCalendarView(): void {
    const dispose = this.calendarDispose;
    this.calendarDispose = undefined;
    if (dispose) {
      try { dispose(); } catch { /* calendar cleanup is best-effort */ }
    }
  }

  private scheduleSearchRender(listEl: HTMLElement | null): void {
    this.clearPendingSearchRender();
    this.searchRenderTimer = window.setTimeout(() => {
      this.searchRenderTimer = null;
      this.renderTaskList(listEl);
    }, SIDEBAR_SEARCH_DEBOUNCE_MS);
  }

  private async updateTaskPlanningDate(task: ParsedTask, field: string, value: unknown): Promise<ParsedTask> {
    if (field !== 'scheduled' && field !== 'due') throw new Error('Planning board date field is unsupported');
    if (value !== null && typeof value !== 'string') throw new Error('Planning board date value is invalid');
    const file = this.app.vault.getAbstractFileByPath(task.filePath);
    if (!(file instanceof TFile)) {
      const error = new Error('Task Manager: source file not found for planning board update.');
      new Notice(error.message);
      throw error;
    }
    try {
      const updated = this.taskMutations
        ? await this.taskMutations.updateTaskDate(file, task, field, value)
        : await this.scanner.updateTaskDate(file, task, field, value);
      if (!this.taskMutations) this.getRenderer?.()?.invalidateCache(task.filePath);
      const index = this.tasks.findIndex((candidate) => candidate.key === task.key);
      if (index >= 0) this.tasks[index] = updated;
      new Notice(value === null ? `Task Manager: cleared ${field} date.` : `Task Manager: set ${field} to ${value}.`);
      return updated;
    } catch (error) {
      new Notice(`Task Manager: planning board update failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    }
  }

  private renderTaskList(listEl: HTMLElement | null): void {
    if (!listEl) return;
    this.disposeCalendarView();
    listEl.empty();

    if (this.isLoading) {
      const loading = listEl.createEl('p', { text: t('ui.loading'), cls: 'task-manager-panel-loading' });
      loading.setAttr('role', 'status');
      loading.setAttr('aria-live', 'polite');
      listEl.setAttr('aria-busy', 'true');
      return;
    }
    listEl.removeAttribute('aria-busy');
    if (this.loadError) {
      const alert = listEl.createDiv({ cls: 'task-manager-panel-empty' });
      alert.setAttr('role', 'alert');
      alert.createEl('p', { text: t('ui.sidebarLoadError', { error: this.loadError }) });
      const retry = alert.createEl('button', { text: t('ui.retry') });
      retry.addEventListener('click', () => { retry.disabled = true; void this.refresh(); });
      return;
    }

    if (this.activeTab === 'current-file' && !this.activeFilePath) {
      listEl.createEl('p', { text: t('ui.noFileActive'), cls: 'task-manager-panel-empty' });
      return;
    }

    // Habits tab
    if (this.activeTab === 'habits') {
      const tracker = new HabitTracker(this.app, this.getSettings);
      const habits = tracker.identifyHabits(this.tasks);
      const generation = ++this.habitsRequestGeneration;
      const status = listEl.createDiv({ cls: 'task-manager-panel-loading', text: t('habits.loading') });
      status.setAttr('role', 'status');
      status.setAttr('aria-live', 'polite');
      listEl.setAttr('aria-busy', 'true');
      const load = async (): Promise<void> => {
        try {
          const history = await tracker.buildCompletionHistory(habits);
          if (this.closed || generation !== this.habitsRequestGeneration || this.activeTab !== 'habits') return;
          listEl.empty();
          listEl.removeAttribute('aria-busy');
          if (habits.length === 0) {
            listEl.createDiv({ cls: 'task-manager-panel-empty', text: t('habits.none') });
            return;
          }
          renderHabitTracker(listEl, habits, history, todayString(), (habit) => { void this.toggleTask(habit); });
        } catch (error) {
          if (this.closed || generation !== this.habitsRequestGeneration || this.activeTab !== 'habits') return;
          listEl.empty();
          listEl.removeAttribute('aria-busy');
          const alert = listEl.createDiv({ cls: 'task-manager-panel-empty', text: error instanceof Error ? error.message : String(error) });
          alert.setAttr('role', 'alert');
          const retry = listEl.createEl('button', { text: t('habits.retry') });
          retry.addEventListener('click', () => { retry.disabled = true; void load(); });
          retry.focus();
        }
      };
      void load();
      return;
    }

    // Planning Board tab
    if (this.activeTab === 'planning') {
      const today = todayString();
      const settings = this.getSettings();
      this.planningBoardSession = renderPlanningBoard(
        listEl,
        this.tasks,
        {
          settings,
          todayDate: today,
          enableDragDrop: settings.planningBoardDragEnabled,
          maxUndoStack: settings.planningBoardMaxUndoStack,
          primaryActionDescription: t('planningBoard.action.advanceStatus'),
        },
        (task, field, value) => this.updateTaskPlanningDate(task, field, value),
        (task) => {
          // Handle task click
          void this.toggleTask(task);
        },
        this.planningBoardSession,
      );
      return;
    }

    // Agenda tab gets its own specialised renderer
    if (this.activeTab === 'agenda') {
      this.renderAgendaTab(listEl, this.tasks);
      return;
    }

    const settings = this.getSettings();
    let filtered = this.getFilteredTasks();

    // Apply text search
    if (this.searchQuery.trim()) {
      const q = this.searchQuery.toLowerCase();
      filtered = filtered.filter((t) =>
        t.normalizedText.toLowerCase().includes(q) ||
        t.filePath.toLowerCase().includes(q) ||
        t.tags.some((tag) => tag.toLowerCase().includes(q)),
      );
    }

    // Count
    const countEl = listEl.createDiv({ cls: 'task-manager-panel-count' });
    countEl.setText(t(filtered.length === 1 ? 'ui.taskCountSingular' : 'ui.taskCountPlural', { count: filtered.length }));

    if (filtered.length === 0) {
      listEl.createEl('p', { text: t('ui.noMatchingTasks'), cls: 'task-manager-panel-empty' });
      return;
    }

    if (this.viewMode === 'kanban') {
      const kanbanEl = listEl.createDiv();
      renderKanban(
        kanbanEl,
        filtered,
        parseTaskQuery(''),
        settings,
        async (task) => { await this.toggleTask(task); },
        (task) => { void this.openTask(task); },
        async (task, symbol) => { await this.changeTaskStatus(task, symbol); },
        (statusSymbol) => { this.onCreateTask?.({ statusSymbol }); },
        { renderLimit: { initialTotal: SIDEBAR_KANBAN_INITIAL_CARDS, increment: SIDEBAR_KANBAN_LOAD_MORE_CARDS } },
      );
    } else if (this.viewMode === 'calendar') {
      const calEl = listEl.createDiv();
      this.calendarDispose = renderCalendar(
        calEl,
        filtered,
        parseTaskQuery(''),
        settings,
        async (task) => { await this.toggleTask(task); },
        (task) => { void this.openTask(task); },
        (date) => { this.onCreateTask?.({ date }); },
        // onReschedule not wired in sidebar — drag-to-reschedule is available in query blocks
      );
    } else {
      // List view: keep mounted rows/listeners bounded even for the All tab.
      const pageCount = Math.max(1, Math.ceil(filtered.length / SIDEBAR_LIST_PAGE_SIZE));
      this.listPage = Math.min(this.listPage, pageCount - 1);
      const start = this.listPage * SIDEBAR_LIST_PAGE_SIZE;
      const visibleTasks = filtered.slice(start, start + SIDEBAR_LIST_PAGE_SIZE);
      const hierarchy = buildSidebarHierarchyStats(this.tasks);
      for (const task of visibleTasks) this.renderTaskRow(listEl, task, hierarchy.get(sidebarHierarchyKey(task)));
      if (pageCount > 1) {
        const pager = listEl.createDiv({ cls: 'task-manager-panel-pager' });
        pager.setAttr('role', 'group');
        pager.setAttr('aria-label', t('ui.resultPages'));
        const previous = pager.createEl('button', { text: t('action.previous'), cls: 'task-manager-panel-page-previous' });
        previous.disabled = this.listPage === 0;
        previous.addEventListener('click', () => {
          this.listPage = Math.max(0, this.listPage - 1);
          this.renderView();
        });
        pager.createEl('span', {
          text: `Showing ${start + 1}–${Math.min(filtered.length, start + visibleTasks.length)} of ${filtered.length}`,
          cls: 'task-manager-panel-page-status',
          attr: { 'aria-live': 'polite' },
        });
        const next = pager.createEl('button', { text: t('action.next'), cls: 'task-manager-panel-page-next' });
        next.disabled = this.listPage >= pageCount - 1;
        next.addEventListener('click', () => {
          this.listPage = Math.min(pageCount - 1, this.listPage + 1);
          this.renderView();
        });
      }
    }
  }

  /** Render time-bucketed agenda for today's tasks. */
  private renderAgendaTab(container: HTMLElement, tasks: ParsedTask[]): void {
    const today = todayString();

    let todayTasks = tasks.filter((t) => {
      const isDone = t.status === 'done' || t.status === 'cancelled';
      const isToday =
        t.metadata.dates.due === today ||
        t.metadata.dates.scheduled === today ||
        (t.metadata.reminder?.startsWith(today) ?? false);
      return !isDone && isToday;
    });
    if (this.searchQuery.trim()) {
      const query = this.searchQuery.toLowerCase();
      todayTasks = todayTasks.filter((task) => task.normalizedText.toLowerCase().includes(query)
        || task.filePath.toLowerCase().includes(query)
        || task.tags.some((tag) => tag.toLowerCase().includes(query)));
    }
    this.agendaVisibleCount = Math.max(SIDEBAR_AGENDA_INITIAL_ROWS, Math.min(this.agendaVisibleCount, Math.max(SIDEBAR_AGENDA_INITIAL_ROWS, todayTasks.length)));

    container.createEl('h4', { text: t('ui.agenda.dateHeading', { date: today }), cls: 'task-manager-agenda-date' });

    // Time buckets: Morning / Afternoon / Evening / No time
    const buckets: { label: string; start: number; end: number; tasks: ParsedTask[] }[] = [
      { label: t('ui.agenda.morning'), start: 6, end: 12, tasks: [] },
      { label: t('ui.agenda.afternoon'), start: 12, end: 17, tasks: [] },
      { label: t('ui.agenda.evening'), start: 17, end: 24, tasks: [] },
      { label: t('ui.agenda.noTime'), start: -1, end: -1, tasks: [] },
    ];

    for (const task of todayTasks) {
      // Derive a clock hour from either the reminder time (YYYY-MM-DD HH:MM → HH)
      // or the structured timeStart field (set by ⌚ HH:MM syntax). Without this
      // fallback, tasks like "⌚ 14:00 📅 today" land in the "No time" bucket
      // even though they have an explicit clock time.
      const reminderTimeMatch = task.metadata.reminder?.match(/(\d{1,2}):(\d{2})$/u);
      const timeStartMatch = !reminderTimeMatch && task.metadata.timeStart?.match(/^(\d{1,2}):(\d{2})$/u);
      const hourMatch = reminderTimeMatch ?? timeStartMatch;
      if (hourMatch) {
        const hour = parseInt(hourMatch[1], 10);
        const bucket = buckets.find((b) => b.start >= 0 && hour >= b.start && hour < b.end);
        (bucket ?? buckets[buckets.length - 1]).tasks.push(task);
      } else {
        buckets[buckets.length - 1].tasks.push(task);
      }
    }

    let anyRendered = false;
    let remainingWindow = this.agendaVisibleCount;
    let mounted = 0;
    for (const bucket of buckets) {
      if (bucket.tasks.length === 0) continue;
      const visibleTasks = bucket.tasks.slice(0, Math.max(0, remainingWindow));
      remainingWindow -= visibleTasks.length;
      if (visibleTasks.length === 0) continue;
      anyRendered = true;
      mounted += visibleTasks.length;

      const section = container.createDiv({ cls: 'task-manager-agenda-bucket' });
      section.createEl('h5', {
        text: `${bucket.label} (${visibleTasks.length} of ${bucket.tasks.length})`,
        cls: 'task-manager-agenda-bucket-label',
      });
      const list = section.createEl('ul', { cls: 'task-manager-agenda-list' });

      for (const task of visibleTasks) {
        const item = list.createEl('li', { cls: 'task-manager-agenda-item' });
        item.setAttr('data-sidebar-task-key', encodeURIComponent(sidebarHierarchyKey(task)));

        const checkboxHit = item.createEl('label', { cls: 'task-manager-panel-checkbox-hit' });
        const checkbox = checkboxHit.createEl('input', { type: 'checkbox' });
        checkbox.checked = task.status === 'done';
        checkbox.setAttr('aria-label', `${task.status === 'done' ? 'Mark incomplete' : 'Complete'} ${task.normalizedText}`);
        checkbox.addEventListener('click', (e) => {
          e.preventDefault();
          void this.toggleTask(task);
        });

        const textSpan = item.createEl('button', {
          text: task.normalizedText,
          cls: 'task-manager-agenda-text',
        });
        textSpan.setAttr('type', 'button');
        textSpan.setAttr('aria-label', `Open task: ${task.normalizedText}`);
        textSpan.addEventListener('click', () => { void this.openTask(task); });

        const timeMatch2 = task.metadata.reminder?.match(/(\d{1,2}:\d{2})$/u);
        const displayTime = timeMatch2?.[1] ?? task.metadata.timeStart ?? '';
        if (displayTime) item.createEl('span', { text: displayTime, cls: 'task-manager-agenda-time' });

        if (task.metadata.priority && task.metadata.priority !== 'normal') {
          const pIcon = ({ highest: '🔺', high: '⏫', medium: '🔼', low: '🔽', lowest: '⏬' } as Record<string, string>)[task.metadata.priority] ?? '';
          item.createEl('span', { text: pIcon, cls: 'task-manager-agenda-priority' });
        }
      }
    }

    if (!anyRendered) {
      container.createEl('p', { text: t('ui.agenda.noTasks'), cls: 'task-manager-agenda-empty' });
      return;
    }

    const status = container.createDiv({ cls: 'task-manager-agenda-mount-status' });
    status.setAttr('role', 'status');
    status.setAttr('aria-live', 'polite');
    status.tabIndex = -1;
    status.setText(`Showing ${mounted} of ${todayTasks.length} agenda tasks`);
    if (mounted < todayTasks.length) {
      const amount = Math.min(SIDEBAR_AGENDA_LOAD_MORE_ROWS, todayTasks.length - mounted);
      const button = container.createEl('button', { text: `Show ${amount} more`, cls: 'task-manager-agenda-load-more' });
      button.setAttr('type', 'button');
      button.setAttr('aria-label', `Show ${amount} more agenda tasks. ${mounted} of ${todayTasks.length} shown`);
      button.addEventListener('click', () => {
        this.agendaVisibleCount = Math.min(todayTasks.length, this.agendaVisibleCount + SIDEBAR_AGENDA_LOAD_MORE_ROWS);
        this.renderTaskList(container);
        const nextButton = container.querySelector<HTMLButtonElement>('.task-manager-agenda-load-more');
        if (nextButton) nextButton.focus();
        else container.querySelector<HTMLElement>('.task-manager-agenda-mount-status')?.focus();
      });
    }

  }

  private getFilteredTasks(): ParsedTask[] {
    const today = todayString();
    const settings = this.getSettings();

    // Saved query tab
    if (this.activeTab.startsWith('query:')) {
      const queryName = this.activeTab.slice('query:'.length);
      const savedQuery = settings.savedQueries.find((q) => q.name === queryName);
      if (savedQuery) {
        return filterTasks(this.tasks, savedQuery.query, {
          states: settings.supportedStates,
          savedQueries: settings.savedQueries,
          globalFilter: settings.globalFilter,
          subtaskDateInheritance: settings.subtaskDateInheritance,
          nlpQueryEnabled: settings.nlpQueryEnabled,
          enableQueryDsl: settings.enableQueryDsl,
          enableDslExpressions: settings.enableDslExpressions,
        });
      }
    }

    const notDone = this.tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled' && t.status !== 'untracked');

    if (this.activeTab === 'today') {
      return notDone.filter((t) => {
        const due = t.metadata.dates.due;
        const scheduled = t.metadata.dates.scheduled;
        const earliest = due && scheduled ? (due < scheduled ? due : scheduled) : (due ?? scheduled);
        return earliest ? earliest <= today : false;
      });
    }

    if (this.activeTab === 'upcoming') {
      const in7 = addDays(today, 7);
      return notDone.filter((t) => {
        const due = t.metadata.dates.due;
        const scheduled = t.metadata.dates.scheduled;
        const earliest = due && scheduled ? (due < scheduled ? due : scheduled) : (due ?? scheduled);
        return earliest ? earliest > today && earliest <= in7 : false;
      });
    }

    if (this.activeTab === 'current-file') {
      const path = this.activeFilePath;
      return this.tasks.filter((t) => t.filePath === path && t.status !== 'done' && t.status !== 'cancelled' && t.status !== 'untracked');
    }

    if (this.activeTab === 'pinned') {
      return notDone.filter((t) => Boolean(t.metadata.pinned));
    }

    return notDone;
  }

  private renderTaskRow(container: HTMLElement, task: ParsedTask, hierarchy?: SidebarHierarchyStat): void {
    const today = todayString();
    const priority = task.metadata.priority || 'normal';
    const statusType = task.status === 'done' ? 'done' : task.status === 'in_progress' ? 'in_progress' : task.status === 'cancelled' ? 'cancelled' : 'todo';
    const row = container.createDiv({ cls: `task-manager-panel-row task-priority-${priority} task-status-${statusType}` });
    row.setAttr('data-sidebar-task-key', encodeURIComponent(sidebarHierarchyKey(task)));

    // Touch/swipe gesture tracking
    let touchStartX = 0;
    let touchStartY = 0;
    const swipeIndicator = row.createDiv({ cls: 'task-manager-panel-swipe-indicator' });
    swipeIndicator.setAttr('aria-hidden', 'true');
    const resetSwipePreview = (): void => {
      row.removeClass('is-swipe-preview');
      row.removeAttribute('data-swipe-action');
      row.style.removeProperty('--task-manager-swipe-distance');
      swipeIndicator.setText('');
    };

    const checkboxHit = row.createEl('label', { cls: 'task-manager-panel-checkbox-hit' });
    const checkbox = checkboxHit.createEl('input', { type: 'checkbox' });
    checkbox.checked = task.status === 'done';
    checkbox.setAttr('data-sidebar-focus-id', 'checkbox');
    checkbox.setAttr('aria-label', `${task.status === 'done' ? 'Mark incomplete' : 'Complete'} ${task.normalizedText}`);
    checkbox.addEventListener('click', (e) => {
      e.preventDefault();
      void this.toggleTask(task);
    });

    const body = row.createDiv({ cls: 'task-manager-panel-row-body' });
    const desc = body.createDiv({ cls: 'task-manager-panel-desc' });
    const descButton = desc.createEl('button', { cls: 'task-manager-panel-desc-button', text: task.normalizedText });
    descButton.setAttr('type', 'button');
    descButton.setAttr('data-sidebar-focus-id', 'description');
    descButton.setAttr('aria-label', t('task.action.open', { task: task.normalizedText }));
    descButton.addEventListener('click', () => { void this.openTask(task); });

    // Subtask progress indicator (precomputed once per render, O(1) per row).
    if (hierarchy && hierarchy.total > 0) {
      const progressEl = renderProgressBar(hierarchy.done, hierarchy.total);
      desc.appendChild(progressEl);
    }

    const meta = body.createDiv({ cls: 'task-manager-panel-meta' });

    if (task.metadata.dates.due) {
      const isOverdue = task.metadata.dates.due < today && task.status !== 'done';
      meta.createEl('span', {
        text: `📅 ${task.metadata.dates.due}`,
        cls: `task-manager-panel-due${isOverdue ? ' is-overdue' : ''}`,
      });
    } else if (task.metadata.dates.scheduled) {
      meta.createEl('span', { text: `⏳ ${task.metadata.dates.scheduled}`, cls: 'task-manager-panel-due' });
    }

    if (task.metadata.priority && task.metadata.priority !== 'normal') {
      const pIcon = ({ highest: '🔺', high: '⏫', medium: '🔼', low: '🔽', lowest: '⏬' } as Record<string, string>)[task.metadata.priority] ?? '';
      meta.createEl('span', { text: pIcon, cls: 'task-manager-panel-priority' });
    }

    const backlink = meta.createEl('button', { cls: 'task-manager-panel-backlink' });
    backlink.setAttr('type', 'button');
    backlink.setAttr('data-sidebar-focus-id', 'backlink');
    backlink.setText(task.filePath.split('/').pop()?.replace(/\.md$/u, '') ?? task.filePath);
    backlink.setAttr('aria-label', t('task.action.openSource', { path: task.filePath }));
    backlink.addEventListener('click', () => { void this.openTask(task); });

    // ── Quick action buttons (shown on hover) ────────────────────────────────────
    const actions = row.createDiv({ cls: 'task-manager-panel-actions' });

    // Complete button
    const completeBtn = actions.createEl('button', { cls: 'task-manager-panel-action-btn', text: '✓' });
    completeBtn.setAttr('type', 'button');
    completeBtn.setAttr('data-sidebar-focus-id', 'complete');
    completeBtn.setAttr('title', t('task.action.markComplete', { task: task.normalizedText }));
    completeBtn.setAttr('aria-label', t('task.action.markComplete', { task: task.normalizedText }));
    completeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      void this.completeTask(task);
    });

    // Defer button (with preset picker on click)
    const deferBtn = actions.createEl('button', { cls: 'task-manager-panel-action-btn', text: '⏩' });
    deferBtn.setAttr('type', 'button');
    deferBtn.setAttr('data-sidebar-focus-id', 'defer');
    deferBtn.setAttr('title', t('task.action.defer', { task: task.normalizedText }));
    deferBtn.setAttr('aria-label', t('task.action.defer', { task: task.normalizedText }));
    deferBtn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.openDeferMenu(deferBtn, task);
    });

    // Edit button
    if (this.getRenderer?.()) {
      const editBtn = actions.createEl('button', { cls: 'task-manager-panel-action-btn', text: '✎' });
      editBtn.setAttr('type', 'button');
      editBtn.setAttr('data-sidebar-focus-id', 'edit');
      editBtn.setAttr('title', t('task.action.edit', { task: task.normalizedText }));
      editBtn.setAttr('aria-label', t('task.action.edit', { task: task.normalizedText }));
      editBtn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const _renderer = this.getRenderer?.();
        // Access the onEditTask callback through the renderer
        // For now, we'll open the task in the editor
        void this.openTask(task);
      });
    }

    // ── Mobile swipe gestures ────────────────────────────────────────────────────
    if (this.getSettings().enableMobileGestures) {
      row.addEventListener('touchstart', (e) => {
        const touch = e.touches[0];
        if (touch) {
          touchStartX = touch.clientX;
          touchStartY = touch.clientY;
        }
      }, { passive: true });

      row.addEventListener('touchmove', (e) => {
        const touch = e.touches[0];
        if (!touch) return;
        const deltaX = touch.clientX - touchStartX;
        const deltaY = touch.clientY - touchStartY;
        if (Math.abs(deltaY) > Math.abs(deltaX)) { resetSwipePreview(); return; }
        const action = deltaX >= 0 ? 'complete' : 'defer';
        row.addClass('is-swipe-preview');
        row.setAttr('data-swipe-action', action);
        row.style.setProperty('--task-manager-swipe-distance', `${Math.min(96, Math.abs(deltaX))}px`);
        swipeIndicator.setText(action === 'complete' ? t('ui.swipeComplete') : t('ui.swipeDefer'));
      }, { passive: true });
      row.addEventListener('touchcancel', resetSwipePreview, { passive: true });
      row.addEventListener('touchend', (e) => {
        const touch = e.changedTouches[0];
        if (!touch) { resetSwipePreview(); return; }
        const deltaX = touch.clientX - touchStartX;
        const deltaY = touch.clientY - touchStartY;
        const horizontal = Math.abs(deltaX) > 50 && Math.abs(deltaX) >= Math.abs(deltaY);
        resetSwipePreview();
        if (!horizontal) return;
        if (deltaX > 0) void this.completeTask(task, true);
        else this.openDeferMenu(row, task);
      }, { passive: true });
    }
  }

  private async completeTask(task: ParsedTask, offerUndo = false): Promise<boolean> {
    const doneState = this.getSettings().supportedStates.find((state) => state.type === 'done');
    if (!doneState) return false;
    const changed = await this.changeTaskStatus(task, doneState.rawText);
    const destructive = ['delete', 'archive', 'collect', 'move-to-end'].includes(task.metadata.onCompletion ?? '');
    if (changed && offerUndo && task.status !== 'done' && !task.metadata.recurrence && !task.metadata.recurrenceRaw && !destructive) this.showSwipeUndo(task);
    return changed;
  }

  private showSwipeUndo(task: ParsedTask): void {
    const notice = new Notice('', 10_000);
    const body = notice.noticeEl;
    body.empty();
    body.createSpan({ text: t('ui.swipeCompleted', { task: task.normalizedText }) });
    const undo = body.createEl('button', { text: t('ui.undo') });
    undo.addEventListener('click', () => { notice.hide(); void this.changeTaskStatus(task, task.checkbox); });
    undo.focus();
  }

  private openDeferMenu(target: HTMLElement, task: ParsedTask): void {
    const settings = this.getSettings();
    const menu = new Menu();

    // Add preset defer options
    for (const preset of settings.deferPresets) {
      menu.addItem((item) =>
        item
          .setTitle(preset.label)
          .onClick(async () => {
            try {
              // Calculate total days from preset (days + weeks*7 + months*30)
              const totalDays = (preset.days ?? 0) + (preset.weeks ?? 0) * 7 + (preset.months ?? 0) * 30;
              const newDate = addDays(todayString(), totalDays);
              const file = this.app.vault.getAbstractFileByPath(task.filePath);
              if (!(file instanceof TFile)) return;
              // Use the shared task mutation path rather than read+modify so
              // concurrent edits are serialized via vault.process and stale
              // rendered rows are validated before writing.
              if (this.taskMutations) await this.taskMutations.updateTaskDate(file, task, 'due', newDate);
              else {
                await this.scanner.updateTaskDate(file, task, 'due', newDate);
                this.getRenderer?.()?.invalidateCache(task.filePath);
              }
              await this.refresh();
            } catch (error) {
              new Notice(t('ui.deferFailed', { error: error instanceof Error ? error.message : String(error) }));
            }
          })
      );
    }

    menu.showAtPosition({ x: target.getBoundingClientRect().left, y: target.getBoundingClientRect().bottom });
  }

  private async openTask(task: ParsedTask): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(task.filePath);
    if (!(file instanceof TFile)) return;
    await this.app.workspace.getLeaf(false).openFile(file, {
      active: true,
      eState: { line: Math.max(0, task.lineNumber - 1) },
    });
  }

  private async toggleTask(task: ParsedTask): Promise<void> {
    const settings = this.getSettings();
    const next = cycleTaskCheckbox(task.checkbox, settings.supportedStates);
    const file = this.app.vault.getAbstractFileByPath(task.filePath);
    if (!(file instanceof TFile)) return;
    try {
      const result = this.taskMutations
        ? await this.taskMutations.updateTaskCheckboxWithOutcome(file, task, next)
        : await this.scanner.updateTaskCheckboxWithOutcome(file, task, next);
      if (!this.taskMutations && result.outcome !== 'blocked') this.getRenderer?.()?.invalidateCache(task.filePath);
      if (result.outcome !== 'completed') new Notice(`Task Manager: ${result.reason} ${result.recovery}`);
      await this.refresh();
    } catch (error) {
      new Notice(`Task Manager: ${error instanceof Error ? error.message : String(error)}`);
      await this.refresh();
    }
  }

  private async changeTaskStatus(task: ParsedTask, symbol: string): Promise<boolean> {
    const file = this.app.vault.getAbstractFileByPath(task.filePath);
    if (!(file instanceof TFile)) return false;
    try {
      const result = this.taskMutations
        ? await this.taskMutations.updateTaskCheckboxWithOutcome(file, task, symbol)
        : await this.scanner.updateTaskCheckboxWithOutcome(file, task, symbol);
      if (!this.taskMutations && result.outcome !== 'blocked') this.getRenderer?.()?.invalidateCache(task.filePath);
      if (result.outcome !== 'completed') new Notice(`Task Manager: ${result.reason} ${result.recovery}`);
      await this.refresh();
      return result.outcome === 'completed';
    } catch (error) {
      new Notice(`Task Manager: ${error instanceof Error ? error.message : String(error)}`);
      await this.refresh();
      return false;
    }
  }
}
