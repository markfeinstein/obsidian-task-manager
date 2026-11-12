import test from 'node:test';
import assert from 'node:assert/strict';
import { TFile } from 'obsidian';
import { TaskScanner, type ParsedTask } from '../src/task-scanner';
import { buildSidebarHierarchyStats, sidebarHierarchyKey, SIDEBAR_AGENDA_INITIAL_ROWS, SIDEBAR_AGENDA_LOAD_MORE_ROWS, SIDEBAR_LIST_PAGE_SIZE, TaskPanelView } from '../src/sidebar-view';
import { todayString } from '../src/date-utils';
import { DEFAULT_SETTINGS } from '../src/types';
import { FakeDOMElement } from './test-utils';
import { installDomHarness } from './dom-harness';
import { HabitTracker } from '../src/habit-tracker';

const scanner = new TaskScanner({} as never);

function task(line: string, path: string, lineNumber: number): ParsedTask {
  const parsed = scanner.parseTaskLine(line, path, lineNumber);
  assert.ok(parsed);
  return parsed;
}

test('Sidebar lifecycle applies locale scope and releases it on close', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const root = harness.document.createElement('div');
  const app = {
    workspace: { on: () => ({}), getActiveFile: () => null },
    vault: { getMarkdownFiles: () => [] },
  };
  const view = new TaskPanelView({ app } as never, () => DEFAULT_SETTINGS, new TaskScanner(app as never), () => undefined as never, undefined, async () => []);
  (view as unknown as { contentEl: HTMLElement }).contentEl = root;
  await view.onOpen();
  assert.equal(root.getAttribute('dir'), 'ltr');
  root.querySelector<HTMLButtonElement>('[data-mode="kanban"]')?.click();
  root.querySelector<HTMLButtonElement>('[data-mode="list"]')?.click();
  const search = root.querySelector<HTMLInputElement>('.task-manager-panel-search');
  assert.ok(search);
  search.value = 'smoke';
  search.dispatchEvent(new harness.window.Event('input', { bubbles: true }));
  root.querySelector<HTMLButtonElement>('.task-manager-panel-search-clear')?.click();
  const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  tabs.at(-1)?.click();
  tabs.at(-1)?.dispatchEvent(new harness.window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }));
  root.querySelector<HTMLButtonElement>('.task-manager-panel-refresh')?.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await view.onClose();
});

test('Sidebar renders loading, preserves failures, and retries in place', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const root = harness.document.createElement('div');
  harness.document.body.appendChild(root);
  const app = { workspace: { on: () => ({}), getActiveFile: () => null }, vault: { getMarkdownFiles: () => [] } };
  let calls = 0;
  const view = new TaskPanelView({ app } as never, () => DEFAULT_SETTINGS, new TaskScanner(app as never), () => undefined as never, undefined, async () => {
    calls += 1;
    if (calls === 1) throw new Error('index unavailable');
    return [task(`- [ ] Recovered 📅 ${todayString()}`, 'Tasks.md', 1)];
  });
  (view as unknown as { contentEl: HTMLElement }).contentEl = root;
  const opening = view.onOpen();
  assert.equal(root.querySelector('[role="status"]')?.textContent, 'Loading…');
  assert.equal(root.querySelector<HTMLButtonElement>('.task-manager-panel-refresh')?.disabled, true);
  await opening;
  assert.match(root.querySelector('[role="alert"]')?.textContent ?? '', /index unavailable/u);
  const retry = root.querySelector<HTMLButtonElement>('[role="alert"] button');
  assert.ok(retry);
  retry.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(calls, 2);
  assert.match(root.textContent ?? '', /Recovered/u);
  await view.onClose();
});

test('Sidebar Habits announces loading failures and offers an in-place retry', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const root = harness.document.createElement('div');
  harness.document.body.appendChild(root);
  const original = HabitTracker.prototype.buildCompletionHistory;
  let calls = 0;
  HabitTracker.prototype.buildCompletionHistory = async () => {
    calls += 1;
    if (calls === 1) throw new Error('habit history unavailable');
    return new Map();
  };
  context.after(() => { HabitTracker.prototype.buildCompletionHistory = original; });
  const app = { vault: { getAbstractFileByPath: () => null } };
  const view = new TaskPanelView({ app } as never, () => DEFAULT_SETTINGS, new TaskScanner(app as never), () => undefined as never);
  const privateView = view as unknown as { tasks: ParsedTask[]; activeTab: string; renderTaskList(container: HTMLElement): void };
  privateView.tasks = [task('- [ ] Walk #habit 🔁 every day', 'Habits.md', 1)];
  privateView.activeTab = 'habits';
  privateView.renderTaskList(root);
  assert.equal(root.getAttribute('aria-busy'), 'true');
  await Promise.resolve();
  await Promise.resolve();
  assert.match(root.querySelector<HTMLElement>('[role="alert"]')?.textContent ?? '', /habit history unavailable/u);
  root.querySelector<HTMLButtonElement>('button')?.click();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(calls, 2);
  assert.equal(root.hasAttribute('aria-busy'), false);
});

test('Sidebar swipe previews actions, cancels cleanly, and offers undo only for safe completion', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const file = Object.assign(Object.create(TFile.prototype), { path: 'Tasks.md', name: 'Tasks.md', basename: 'Tasks', extension: 'md' }) as TFile;
  const root = harness.document.createElement('div');
  const app = { vault: { getAbstractFileByPath: () => file } };
  const view = new TaskPanelView({ app } as never, () => ({ ...DEFAULT_SETTINGS, enableMobileGestures: true }), scanner, () => undefined as never);
  let statusChanges = 0;
  let undoOffers = 0;
  const privateView = view as unknown as {
    taskMutations: { updateTaskCheckboxWithOutcome(): Promise<{ outcome: 'completed' }> };
    refresh(): Promise<void>;
    showSwipeUndo(task: ParsedTask): void;
    renderTaskRow(container: HTMLElement, task: ParsedTask): void;
  };
  privateView.taskMutations = { updateTaskCheckboxWithOutcome: async () => { statusChanges += 1; return { outcome: 'completed' }; } };
  privateView.refresh = async () => undefined;
  privateView.showSwipeUndo = () => { undoOffers += 1; };
  privateView.renderTaskRow(root, task('- [ ] Swipe me', 'Tasks.md', 1));
  const row = root.querySelector<HTMLElement>('.task-manager-panel-row');
  assert.ok(row);
  const dispatchTouch = (type: string, x: number, y: number): void => {
    const event = new harness.window.Event(type, { bubbles: true });
    Object.defineProperty(event, type === 'touchend' ? 'changedTouches' : 'touches', { value: [{ clientX: x, clientY: y }] });
    row.dispatchEvent(event);
  };
  dispatchTouch('touchstart', 0, 0);
  dispatchTouch('touchmove', 70, 4);
  assert.equal(row.getAttribute('data-swipe-action'), 'complete');
  assert.match(row.querySelector('.task-manager-panel-swipe-indicator')?.textContent ?? '', /Release to complete/u);
  dispatchTouch('touchend', 70, 4);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(statusChanges, 1);
  assert.equal(undoOffers, 1);
  assert.equal(row.hasAttribute('data-swipe-action'), false);

  dispatchTouch('touchstart', 0, 0);
  dispatchTouch('touchmove', 10, 80);
  assert.equal(row.hasAttribute('data-swipe-action'), false, 'vertical movement cancels swipe preview');
});

test('Sidebar hierarchy stats are built once with file/prefix boundaries', () => {
  const tasks = [
    task('- [ ] Parent', 'A.md', 1),
    task('  - [x] Child', 'A.md', 2),
    task('    - [-] Grandchild', 'A.md', 3),
    task('  - [ ] Sibling', 'A.md', 4),
    task('- [ ] Other root', 'A.md', 5),
    task('- [x] Other file', 'B.md', 1),
  ];
  const stats = buildSidebarHierarchyStats(tasks);
  assert.deepEqual(stats.get(sidebarHierarchyKey(tasks[0])), { total: 3, done: 2 });
  assert.deepEqual(stats.get(sidebarHierarchyKey(tasks[1])), { total: 1, done: 1 });
  assert.equal(stats.has(sidebarHierarchyKey(tasks[4])), false);
  assert.equal(stats.has(sidebarHierarchyKey(tasks[5])), false);
});

test('Sidebar search input and glyph button expose distinct localized accessible names', () => {
  const view = new TaskPanelView({ app: {} } as never, () => ({ ...DEFAULT_SETTINGS, enableMobileGestures: false }), scanner, () => undefined as never);
  const root = new FakeDOMElement('div');
  const harness = view as unknown as { contentEl: HTMLElement; tasks: ParsedTask[]; renderView(): void };
  harness.contentEl = root as unknown as HTMLElement;
  harness.tasks = [];
  harness.renderView();
  const searchRow = root.querySelector('.task-manager-panel-search-row');
  const search = searchRow?.children.find((child) => child instanceof FakeDOMElement && child.tagName === 'input') as FakeDOMElement | undefined;
  const clear = root.querySelector('.task-manager-panel-search-clear');
  assert.equal(search?.getAttr('aria-label'), 'Search tasks');
  assert.equal(search?.getAttr('placeholder'), null, 'placeholder remains a hint property rather than the accessible name');
  assert.equal(clear?.text, '✕');
  assert.equal(clear?.getAttr('aria-label'), 'Clear task search');
  assert.notEqual(clear?.getAttr('aria-label'), clear?.text);
});

test('Sidebar planning cards describe the host-specific primary action', () => {
  const today = todayString();
  const view = new TaskPanelView({ app: {} } as never, () => ({ ...DEFAULT_SETTINGS, planningBoardSidebarEnabled: true }), scanner, () => undefined as never);
  const root = new FakeDOMElement('div');
  const harness = view as unknown as {
    tasks: ParsedTask[];
    activeTab: string;
    renderTaskList(container: HTMLElement | null): void;
  };
  harness.tasks = [task(`- [ ] Plan release 📅 ${today}`, 'Plan.md', 1)];
  harness.activeTab = 'planning';
  harness.renderTaskList(root as unknown as HTMLElement);
  assert.match(root.querySelector('.planning-board-card-info')?.getAttr('aria-label') ?? '', /^Advance task status: Plan release/u);
});

test('Sidebar planning-date persistence validates, updates local state, and propagates failures', async () => {
  const source = task('- [ ] Plan release 📅 2026-07-13', 'Plan.md', 1);
  const file = Object.assign(Object.create(TFile.prototype) as TFile, { path: source.filePath, extension: 'md', name: 'Plan.md' });
  const app = { vault: { getAbstractFileByPath: (path: string) => path === source.filePath ? file : null } };
  const view = new TaskPanelView({ app } as never, () => DEFAULT_SETTINGS, scanner, () => undefined as never);
  const harness = view as unknown as {
    tasks: ParsedTask[];
    taskMutations?: { updateTaskDate(file: TFile, task: ParsedTask, field: 'scheduled' | 'due', value: string | null): Promise<ParsedTask> };
    updateTaskPlanningDate(task: ParsedTask, field: string, value: unknown): Promise<ParsedTask>;
  };
  harness.tasks = [source];
  harness.taskMutations = {
    updateTaskDate: async (_file, current, field, value) => ({ ...current, metadata: { ...current.metadata, dates: { ...current.metadata.dates, [field]: value ?? undefined } } }),
  };
  const updated = await harness.updateTaskPlanningDate(source, 'scheduled', '2026-07-14');
  assert.equal(updated.metadata.dates.scheduled, '2026-07-14');
  assert.strictEqual(harness.tasks[0], updated);
  await assert.rejects(() => harness.updateTaskPlanningDate(source, 'status', 'done'), /unsupported/u);
  await assert.rejects(() => harness.updateTaskPlanningDate(source, 'due', 42), /invalid/u);

  harness.taskMutations = { updateTaskDate: async () => { throw new Error('write refused'); } };
  await assert.rejects(() => harness.updateTaskPlanningDate(source, 'due', null), /write refused/u);

  const missing = new TaskPanelView({ app: { vault: { getAbstractFileByPath: () => null } } } as never, () => DEFAULT_SETTINGS, scanner, () => undefined as never);
  await assert.rejects(
    () => (missing as unknown as { updateTaskPlanningDate(task: ParsedTask, field: string, value: unknown): Promise<ParsedTask> }).updateTaskPlanningDate(source, 'due', null),
    /source file not found/u,
  );

  let invalidated = '';
  const fallbackScanner = { updateTaskDate: async (_file: TFile, current: ParsedTask) => current } as unknown as TaskScanner;
  const fallback = new TaskPanelView({ app } as never, () => DEFAULT_SETTINGS, fallbackScanner, () => ({ invalidateCache: (path: string) => { invalidated = path; } }) as never);
  const fallbackHarness = fallback as unknown as { tasks: ParsedTask[]; updateTaskPlanningDate(task: ParsedTask, field: string, value: unknown): Promise<ParsedTask> };
  fallbackHarness.tasks = [source];
  await fallbackHarness.updateTaskPlanningDate(source, 'due', null);
  assert.equal(invalidated, source.filePath);
});

test('Sidebar list mode mounts at most one page and pages without duplicates', () => {
  const tasks = Array.from({ length: 500 }, (_value, index) => task(`- [ ] Task ${index}`, `Folder/${Math.floor(index / 50)}.md`, index % 50 + 1));
  const view = new TaskPanelView(
    {} as never,
    () => ({ ...DEFAULT_SETTINGS, enableMobileGestures: false }),
    scanner,
    () => undefined as never,
  );
  const harness = view as unknown as {
    tasks: ParsedTask[];
    activeTab: string;
    viewMode: string;
    searchQuery: string;
    listPage: number;
    renderTaskList(container: HTMLElement | null): void;
  };
  harness.tasks = tasks;
  harness.activeTab = 'all';
  harness.viewMode = 'list';
  harness.searchQuery = '';
  harness.listPage = 0;
  const root = new FakeDOMElement('div');

  harness.renderTaskList(root as unknown as HTMLElement);
  assert.equal(root.querySelectorAll('.task-manager-panel-row').length, SIDEBAR_LIST_PAGE_SIZE);
  const firstPageText = root.querySelectorAll('.task-manager-panel-desc-button').map((element) => element.text);
  assert.equal(new Set(firstPageText).size, SIDEBAR_LIST_PAGE_SIZE);

  root.querySelector('.task-manager-panel-page-next')?.dispatchEvent({ type: 'click' });
  // The page state and bounded next slice are deterministic across rerenders.
  assert.equal(harness.listPage, 1);
  const second = new FakeDOMElement('div');
  harness.renderTaskList(second as unknown as HTMLElement);
  assert.equal(second.querySelectorAll('.task-manager-panel-row').length, SIDEBAR_LIST_PAGE_SIZE);
});

test('Sidebar Agenda bounds a 10k-task day and loads deterministic increments', () => {
  const today = todayString();
  const tasks = Array.from({ length: 10_000 }, (_value, index) => task(`- [ ] Agenda ${index} 📅 ${today}`, `Agenda/${Math.floor(index / 100)}.md`, index % 100 + 1));
  const view = new TaskPanelView(
    {} as never,
    () => ({ ...DEFAULT_SETTINGS, enableMobileGestures: false }),
    scanner,
    () => undefined as never,
  );
  const harness = view as unknown as {
    tasks: ParsedTask[];
    activeTab: string;
    viewMode: string;
    searchQuery: string;
    agendaVisibleCount: number;
    renderTaskList(container: HTMLElement | null): void;
  };
  harness.tasks = tasks;
  harness.activeTab = 'agenda';
  harness.viewMode = 'list';
  harness.searchQuery = '';
  harness.agendaVisibleCount = SIDEBAR_AGENDA_INITIAL_ROWS;
  const root = new FakeDOMElement('div');
  harness.renderTaskList(root as unknown as HTMLElement);
  assert.equal(root.querySelectorAll('.task-manager-agenda-item').length, SIDEBAR_AGENDA_INITIAL_ROWS);
  const button = root.querySelector('.task-manager-agenda-load-more');
  assert.ok(button);
  assert.match(button.getAttr('aria-label') ?? '', /150 of 10000 shown/u);
  button.dispatchEvent({ type: 'click' });
  assert.equal(root.querySelectorAll('.task-manager-agenda-item').length, SIDEBAR_AGENDA_INITIAL_ROWS + SIDEBAR_AGENDA_LOAD_MORE_ROWS);
});

test('Sidebar Agenda load more preserves order, uniqueness, and focus target', () => {
  const today = todayString();
  const tasks = Array.from({ length: 350 }, (_value, index) => task(`- [ ] Agenda ordered ${index} 📅 ${today}`, 'Agenda.md', index + 1));
  const view = new TaskPanelView({} as never, () => ({ ...DEFAULT_SETTINGS, enableMobileGestures: false }), scanner, () => undefined as never);
  const harness = view as unknown as {
    tasks: ParsedTask[]; activeTab: string; viewMode: string; searchQuery: string; agendaVisibleCount: number;
    renderTaskList(container: HTMLElement | null): void;
  };
  Object.assign(harness, { tasks, activeTab: 'agenda', viewMode: 'list', searchQuery: '', agendaVisibleCount: SIDEBAR_AGENDA_INITIAL_ROWS });
  const root = new FakeDOMElement('div');
  let focusedClasses: string[] = [];
  const originalFocus = FakeDOMElement.prototype.focus;
  FakeDOMElement.prototype.focus = function focus() { focusedClasses = [...this.classes]; };
  try {
    harness.renderTaskList(root as unknown as HTMLElement);
    root.querySelector('.task-manager-agenda-load-more')?.dispatchEvent({ type: 'click' });
    assert.ok(focusedClasses.includes('task-manager-agenda-load-more'));
    root.querySelector('.task-manager-agenda-load-more')?.dispatchEvent({ type: 'click' });
    const labels = root.querySelectorAll('.task-manager-agenda-text').map((element) => element.text);
    assert.equal(labels.length, 350);
    assert.equal(new Set(labels).size, 350);
    assert.deepEqual(labels, tasks.map((task) => task.normalizedText));
    assert.ok(focusedClasses.includes('task-manager-agenda-mount-status'));
  } finally {
    FakeDOMElement.prototype.focus = originalFocus;
  }
});
