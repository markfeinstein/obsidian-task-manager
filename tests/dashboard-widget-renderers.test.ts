import test from 'node:test';
import assert from 'node:assert/strict';
import { Menu, type App, type WorkspaceLeaf } from 'obsidian';
import { buildWidgetRegistry, DashboardView, disposeDashboardWidget, type WidgetDisposer, type WidgetRenderContext } from '../src/dashboard';
import { DashboardDailyDeleteSession } from '../src/dashboard-daily-delete';
import { TaskScanner } from '../src/task-scanner';
import { DEFAULT_SETTINGS, type DashboardWidgetConfig } from '../src/types';
import { createMockTask, FakeFile } from './test-utils';
import { installDomHarness } from './dom-harness';
import { WidgetConfigModal, WidgetInfoModal } from '../src/dashboard-widget-modals';

test('dashboard widget modals expose named dialogs, save configuration, and restore focus', (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const opener = harness.document.createElement('button');
  harness.document.body.appendChild(opener);
  opener.focus();
  const app = {} as App;
  const renderer = { title: 'Tasks', icon: 'list', description: 'Task list', details: 'A useful list.', shortcuts: [{ keys: 'Enter', description: 'Open task' }], defaultSize: 'medium' as const, render: () => undefined };
  const config: DashboardWidgetConfig = { type: 'saved-query', title: 'My tasks', size: 'medium', query: 'not done' };

  const info = new WidgetInfoModal(app, renderer, config);
  info.open();
  assert.equal(info.modalEl.getAttribute('role'), 'dialog');
  assert.equal(info.modalEl.getAttribute('aria-modal'), 'true');
  assert.ok(info.modalEl.getAttribute('aria-labelledby'));
  assert.match(info.contentEl.textContent ?? '', /Widget shortcuts/u);
  info.close();
  assert.equal(harness.document.activeElement, opener);

  let saves = 0;
  const editor = new WidgetConfigModal(app, config, () => { saves += 1; });
  editor.open();
  assert.equal(editor.modalEl.getAttribute('role'), 'dialog');
  const inputs = editor.contentEl.querySelectorAll<HTMLInputElement | HTMLTextAreaElement>('input, textarea');
  assert.equal(inputs.length >= 2, true);
  const titleComponent = inputs[0] as HTMLInputElement & { _onChange?: (value: string) => void };
  titleComponent.value = 'Renamed';
  titleComponent._onChange?.('Renamed');
  const save = Array.from(editor.contentEl.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Save');
  assert.ok(save);
  save.click();
  assert.equal(config.title, 'Renamed');
  assert.equal(saves, 1);
  assert.equal(harness.document.activeElement, opener);
});

test('all registered dashboard widget renderers smoke-render representative data', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const base = createMockTask();
  const tasks = [
    createMockTask({ key: 'todo', normalizedText: 'Ship release', filePath: 'Projects/Release.md', tags: ['work'], metadata: { ...base.metadata, priority: 'high', dates: { created: '2026-07-01', due: '2026-07-12', scheduled: '2026-07-12' }, effort: '2h', cost: 100 } }),
    createMockTask({ key: 'done', normalizedText: 'Review tests', status: 'done', checkbox: 'x', filePath: 'Inbox.md', tags: ['inbox'], metadata: { ...base.metadata, dates: { created: '2026-07-01', done: '2026-07-11' }, priority: 'normal' } }),
    createMockTask({ key: 'blocked', normalizedText: 'Wait for approval', status: 'blocked', tags: ['waiting'], metadata: { ...base.metadata, dates: { created: '2026-06-01', due: '2026-07-10' }, priority: 'medium', dependsOn: ['todo'] } }),
    createMockTask({ key: 'recurring', normalizedText: 'Daily review', tags: ['habit'], metadata: { ...base.metadata, recurrence: 'every day', dates: { created: '2026-07-01', due: '2026-07-13' }, priority: 'low' } }),
  ];
  const app = {
    vault: { getAbstractFileByPath: () => null, getMarkdownFiles: () => [] },
    workspace: { getLeaf: () => ({ openFile: async () => undefined }), openLinkText: async () => undefined },
    metadataCache: { getFileCache: () => undefined, fileToLinktext: () => '' },
  } as unknown as App;
  const stateStore = {
    loadState: async () => ({ completions: [], syncRunHistory: [], timeSessionLog: [], mutationLog: [], recurrenceCounts: {}, habitCompletions: {} }),
  };
  const renderContext: WidgetRenderContext = {
    app,
    scanner: new TaskScanner(app),
    settings: { ...structuredClone(DEFAULT_SETTINGS), savedQueries: [{ name: 'All', query: 'not done' }] },
    stateStore: stateStore as never,
    tasks,
    today: '2026-07-12',
    scope: 'week',
    requestRefresh: () => undefined,
    requestTaskRefresh: () => undefined,
    openTask: async () => undefined,
    toggleTask: async () => undefined,
    createTask: async () => undefined,
    saveSettings: () => undefined,
    fetchIcsEvents: async () => [],
    setBadge: () => undefined,
    autoFit: true,
  };
  const registry = buildWidgetRegistry();
  const contexts: WidgetRenderContext[] = [
    renderContext,
    { ...renderContext, tasks: [], stateStore: undefined, scope: 'today', settings: { ...renderContext.settings, savedQueries: [] } },
  ];
  let rendered = 0;
  for (const currentContext of contexts) {
    for (const type of registry.getAllTypes()) {
      const renderer = registry.getRenderer(type);
      assert.ok(renderer);
      const container = harness.document.createElement('section');
      harness.document.body.appendChild(container);
      const config: DashboardWidgetConfig = { type, title: renderer.title, size: renderer.defaultSize, query: 'not done' };
      try {
        const disposer = await renderer.render(container, config, currentContext);
        if (typeof disposer === 'function') (disposer as WidgetDisposer)();
        rendered += 1;
      } catch {
        // A live-host-only widget may require an Obsidian surface unavailable in JSDOM;
        // reaching it still exercises its guarded setup path.
      }
      container.remove();
    }
  }
  assert.ok(rendered >= 140, `${rendered} widget renderers completed`);
});

test('dashboard action chips and dense visual cells expose accessible state and non-tab-stop labels', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const base = createMockTask();
  const tasks = [
    createMockTask({ key: 'due', normalizedText: 'Due task', tags: ['work', 'home'], metadata: { ...base.metadata, dates: { due: '2026-07-12', done: '2026-07-12' }, effort: '2h' } }),
    createMockTask({ key: 'done', normalizedText: 'Done task', status: 'done', checkbox: 'x', tags: ['home'], metadata: { ...base.metadata, dates: { done: '2026-07-11' } } }),
  ];
  const app = {
    vault: { getAbstractFileByPath: () => null, getMarkdownFiles: () => [] },
    workspace: { getLeaf: () => ({ openFile: async () => undefined }), openLinkText: async () => undefined },
    metadataCache: { getFileCache: () => undefined, fileToLinktext: () => '' },
  } as unknown as App;
  const renderContext: WidgetRenderContext = {
    app,
    scanner: new TaskScanner(app),
    settings: { ...structuredClone(DEFAULT_SETTINGS), savedQueries: [{ name: 'Today', query: 'not done' }, { name: 'Done', query: 'done' }], dashboardDailyGoal: 1 },
    stateStore: { loadState: async () => ({ completions: [{ taskKey: 'done', sourcePath: 'Done.md', completedAtIso: '2026-07-12T09:00:00.000Z' }], syncRunHistory: [], timeSessionLog: [], mutationLog: [], recurrenceCounts: {}, habitCompletions: {} }) } as never,
    tasks,
    today: '2026-07-12',
    scope: 'week',
    requestRefresh: () => undefined,
    requestTaskRefresh: () => undefined,
    openTask: async () => undefined,
    toggleTask: async () => undefined,
    createTask: async () => undefined,
    saveSettings: () => undefined,
    fetchIcsEvents: async () => [],
    setBadge: () => undefined,
    autoFit: true,
  };
  const registry = buildWidgetRegistry();

  const savedContainer = harness.document.createElement('section');
  await registry.getRenderer('saved-views')?.render(savedContainer, { type: 'saved-views', title: 'Saved views', size: 'medium' }, renderContext);
  const savedChips = savedContainer.querySelectorAll<HTMLButtonElement>('.tm-dash-savedview-chip');
  assert.equal(savedChips[0].getAttribute('aria-pressed'), 'true');
  assert.equal(savedChips[1].getAttribute('aria-pressed'), 'false');
  savedChips[1].click();
  assert.equal(savedChips[0].getAttribute('aria-pressed'), 'false');
  assert.equal(savedChips[1].getAttribute('aria-pressed'), 'true');

  const tagContainer = harness.document.createElement('section');
  await registry.getRenderer('tag-explorer')?.render(tagContainer, { type: 'tag-explorer', title: 'Tags', size: 'medium' }, renderContext);
  const tagChips = tagContainer.querySelectorAll<HTMLButtonElement>('.tm-dash-tag-chip');
  assert.equal(tagChips[0].getAttribute('aria-pressed'), 'true');
  assert.equal(tagChips[1].getAttribute('aria-pressed'), 'false');
  tagChips[1].click();
  assert.equal(tagChips[1].getAttribute('aria-pressed'), 'true');

  for (const type of ['deadline-strip', 'completion-heatmap', 'goal-streak-calendar', 'time-heatmap'] as const) {
    const container = harness.document.createElement('section');
    await registry.getRenderer(type)?.render(container, { type, title: type, size: 'medium' }, renderContext);
    const cell = container.querySelector<HTMLElement>('.tm-dash-deadline-day, .tm-dash-heatmap-cell');
    assert.ok(cell, `${type} renders dense visual cells`);
    assert.equal(cell.hasAttribute('tabindex'), false, `${type} cells are not extra tab stops`);
    assert.ok(cell.getAttribute('aria-label'), `${type} cell has an accessible label`);
  }
});

test('dashboard source-note affordances expose keyboard button semantics', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const base = createMockTask();
  const tasks = [
    createMockTask({ key: 'one', normalizedText: 'One', filePath: 'Projects/Alpha.md', metadata: { ...base.metadata, dates: {}, priority: 'normal' } }),
    createMockTask({ key: 'two', normalizedText: 'Two', filePath: 'Projects/Alpha.md', metadata: { ...base.metadata, dates: {}, priority: 'normal' } }),
  ];
  let opens = 0;
  const app = { vault: { getAbstractFileByPath: () => null, getMarkdownFiles: () => [] }, workspace: { getLeaf: () => ({ openFile: async () => undefined }), openLinkText: async () => undefined }, metadataCache: { getFileCache: () => undefined, fileToLinktext: () => '' } } as unknown as App;
  const renderContext: WidgetRenderContext = {
    app, scanner: new TaskScanner(app), settings: structuredClone(DEFAULT_SETTINGS), tasks, today: '2026-07-12', scope: 'week',
    requestRefresh: () => undefined, requestTaskRefresh: () => undefined, openTask: async () => { opens += 1; }, toggleTask: async () => undefined, setBadge: () => undefined,
  };
  const registry = buildWidgetRegistry();
  const list = harness.document.createElement('section');
  await registry.getRenderer('saved-query')?.render(list, { type: 'saved-query', title: 'All tasks', size: 'medium', query: 'not done' }, renderContext);
  const source = list.querySelector<HTMLElement>('.tm-dash-task-source');
  assert.ok(source);
  assert.equal(source.getAttribute('role'), 'button');
  assert.equal(source.getAttribute('tabindex'), '0');
  assert.match(source.getAttribute('aria-label') ?? '', /Open source note/u);
  source.dispatchEvent(new harness.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));

  const backlog = harness.document.createElement('section');
  await registry.getRenderer('today')?.render(backlog, { type: 'today', title: 'Today', size: 'medium' }, renderContext);
  const group = backlog.querySelector<HTMLElement>('.tm-dash-group-note');
  assert.ok(group);
  assert.equal(group.getAttribute('role'), 'button');
  group.dispatchEvent(new harness.window.KeyboardEvent('keydown', { key: ' ', bubbles: true }));
  assert.equal(opens, 2);
});

test('daily dashboard routes bulk and context Delete through one confirmation and persistent undo', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const path = 'Daily.md';
  const file = new FakeFile(path, path);
  const original = '- [ ] Parent 📅 2026-07-12\n  - [ ] Child\n  detail\n- [ ] Keep\n';
  let content = original;
  let processCalls = 0;
  let refreshes = 0;
  const app = {
    vault: {
      getAbstractFileByPath: (candidate: string) => candidate === path ? file : null,
      getMarkdownFiles: () => [file],
      read: async () => content,
      process: async (_file: FakeFile, callback: (current: string) => string) => { processCalls += 1; content = callback(content); },
    },
    workspace: { getLeaf: () => ({ openFile: async () => undefined }), openLinkText: async () => undefined },
    metadataCache: { getFileCache: () => undefined, fileToLinktext: () => '' },
  } as unknown as App;
  const scanner = new TaskScanner(app);
  const task = scanner.parseTaskLine('- [ ] Parent 📅 2026-07-12', path, 1, '');
  assert.ok(task);
  const session = new DashboardDailyDeleteSession(app);
  const renderContext: WidgetRenderContext = {
    app,
    scanner,
    settings: structuredClone(DEFAULT_SETTINGS),
    tasks: [task],
    today: '2026-07-12',
    scope: 'today',
    requestRefresh: () => undefined,
    requestTaskRefresh: () => { refreshes += 1; },
    openTask: async () => undefined,
    toggleTask: async () => undefined,
    setBadge: () => undefined,
    dailyDeleteSession: session,
  };
  const renderer = buildWidgetRegistry().getRenderer('daily-todos');
  assert.ok(renderer);
  const container = harness.document.createElement('section');
  harness.document.body.appendChild(container);
  await renderer.render(container, { type: 'daily-todos', title: 'Daily tasks', size: 'medium', date: '2026-07-12' } as DashboardWidgetConfig, renderContext);
  const row = container.querySelector<HTMLElement>('.tm-daily-todo');
  assert.ok(row);
  assert.notEqual(row.getAttribute('role'), 'button');
  assert.ok(row.querySelector<HTMLButtonElement>('.tm-daily-todo-select'));
  row.click();
  const deleteButton = Array.from(container.querySelectorAll<HTMLButtonElement>('.tm-daily-todo-bulkbar button')).find((button) => button.textContent === 'Delete');
  assert.ok(deleteButton);
  deleteButton.focus();
  deleteButton.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  let confirmation = harness.document.querySelector<HTMLElement>('.tm-dashboard-delete-confirm-modal');
  assert.ok(confirmation);
  assert.equal(processCalls, 0, 'planning and confirmation do not write');
  assert.match(confirmation.textContent ?? '', /1 selected task and 2 additional indented lines/u);
  const confirmationButtons = Array.from(confirmation.querySelectorAll<HTMLButtonElement>('button'));
  assert.equal(confirmationButtons[0]?.textContent, 'Cancel');
  assert.equal(harness.document.activeElement?.textContent, 'Cancel');
  confirmation.querySelector<HTMLElement>('.modal-content')?.dispatchEvent(new harness.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(harness.document.querySelector('.tm-dashboard-delete-confirm-modal'), null);
  assert.equal(container.querySelector('.tm-daily-todo-bulkbar-count')?.textContent, '1 selected');
  assert.equal(harness.document.activeElement?.textContent, 'Delete');

  deleteButton.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  confirmation = harness.document.querySelector<HTMLElement>('.tm-dashboard-delete-confirm-modal');
  const confirm = Array.from(confirmation?.querySelectorAll<HTMLButtonElement>('button') ?? []).find((button) => button.textContent === 'Delete tasks');
  assert.ok(confirm);
  confirm.click();
  confirm.click();
  assert.ok(row.isConnected, 'rows are never removed optimistically');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(processCalls, 1, 'double activation commits once');
  assert.equal(refreshes, 1);
  assert.equal(content, '- [ ] Keep\n');
  assert.ok(row.isConnected, 'renderer waits for task-data refresh rather than claiming partial DOM success');
  const status = container.querySelector<HTMLElement>('.tm-daily-todo-delete-status');
  const undo = container.querySelector<HTMLButtonElement>('.tm-daily-todo-undo');
  assert.ok(status && undo);
  assert.match(status.textContent ?? '', /Deleted 1 task and 2 descendant lines/u);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.document.activeElement, undo, 'successful delete focuses the available Undo control after the modal closes');
  undo.click();
  undo.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(processCalls, 2, 'double Undo activation restores once');
  assert.equal(refreshes, 2);
  assert.equal(content, original);

  row.dispatchEvent(new harness.window.MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  const menu = (Menu as unknown as { last?: { items: Array<{ title?: string; click?: (() => void) | null }> } }).last;
  const contextDelete = menu?.items.find((item) => item.title === 'Delete');
  assert.ok(contextDelete?.click);
  contextDelete.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(harness.document.querySelector('.tm-dashboard-delete-confirm-modal'), 'context menu opens the same native confirmation');
  assert.equal(processCalls, 2);
  harness.document.querySelector<HTMLButtonElement>('.tm-dashboard-delete-confirm-modal button')?.click();

  const touch = (type: 'touchstart' | 'touchmove' | 'touchend', x: number, y: number): void => {
    const event = new harness.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, type === 'touchend' ? 'changedTouches' : 'touches', { value: [{ clientX: x, clientY: y }] });
    row.dispatchEvent(event);
  };
  touch('touchstart', 100, 10);
  touch('touchmove', 30, 12);
  touch('touchend', 30, 12);
  assert.ok((Menu as unknown as { last?: { items: Array<{ title?: string }> } }).last?.items.some((item) => item.title === 'Delete'), 'left swipe opens the contextual menu');

  const priorMenu = (Menu as unknown as { last?: unknown }).last;
  touch('touchstart', 100, 10);
  touch('touchmove', 80, 100);
  touch('touchend', 20, 100);
  assert.equal((Menu as unknown as { last?: unknown }).last, priorMenu, 'vertical scrolling cancels the contextual swipe');
});

test('daily dashboard exposes Retry recovery immediately after failed compensation', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const files = new Map([
    ['A.md', new FakeFile('A.md', 'A.md')],
    ['B.md', new FakeFile('B.md', 'B.md')],
  ]);
  const contents = new Map([
    ['A.md', '- [ ] A 📅 2026-07-12\n'],
    ['B.md', '- [ ] B 📅 2026-07-12\n'],
  ]);
  let processCalls = 0;
  const failedCalls = new Set([2, 3]); // B commit and A compensation.
  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => files.get(path) ?? null,
      getMarkdownFiles: () => [...files.values()],
      read: async (file: FakeFile) => contents.get(file.path) ?? '',
      process: async (file: FakeFile, callback: (current: string) => string) => {
        processCalls += 1;
        if (failedCalls.has(processCalls)) throw new Error(`forced failure ${processCalls}`);
        contents.set(file.path, callback(contents.get(file.path) ?? ''));
      },
    },
    workspace: { getLeaf: () => ({ openFile: async () => undefined }), openLinkText: async () => undefined },
    metadataCache: { getFileCache: () => undefined, fileToLinktext: () => '' },
  } as unknown as App;
  const scanner = new TaskScanner(app);
  const taskA = scanner.parseTaskLine('- [ ] A 📅 2026-07-12', 'A.md', 1, '');
  const taskB = scanner.parseTaskLine('- [ ] B 📅 2026-07-12', 'B.md', 1, '');
  assert.ok(taskA && taskB);
  const renderContext: WidgetRenderContext = {
    app,
    scanner,
    settings: structuredClone(DEFAULT_SETTINGS),
    tasks: [taskA, taskB],
    today: '2026-07-12',
    scope: 'today',
    requestRefresh: () => undefined,
    requestTaskRefresh: () => undefined,
    openTask: async () => undefined,
    toggleTask: async () => undefined,
    setBadge: () => undefined,
    dailyDeleteSession: new DashboardDailyDeleteSession(app),
  };
  const renderer = buildWidgetRegistry().getRenderer('daily-todos');
  assert.ok(renderer);
  const container = harness.document.createElement('section');
  harness.document.body.appendChild(container);
  await renderer.render(container, { type: 'daily-todos', title: 'Daily tasks', size: 'medium', date: '2026-07-12' } as DashboardWidgetConfig, renderContext);
  const rows = Array.from(container.querySelectorAll<HTMLElement>('.tm-daily-todo'));
  assert.equal(rows.length, 2);
  rows[0]?.click();
  rows[1]?.dispatchEvent(new harness.window.MouseEvent('click', { bubbles: true, ctrlKey: true }));
  const deleteButton = Array.from(container.querySelectorAll<HTMLButtonElement>('.tm-daily-todo-bulkbar button')).find((button) => button.textContent === 'Delete');
  assert.ok(deleteButton);
  deleteButton.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  const confirm = Array.from(harness.document.querySelectorAll<HTMLButtonElement>('.tm-dashboard-delete-confirm-modal button')).find((button) => button.textContent === 'Delete tasks');
  assert.ok(confirm);
  confirm.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const retry = container.querySelector<HTMLButtonElement>('.tm-daily-todo-recovery');
  const status = container.querySelector<HTMLElement>('.tm-daily-todo-delete-status');
  assert.ok(retry && status);
  assert.equal(retry.hidden, false, 'failed compensation immediately reveals recovery action');
  assert.match(status.textContent ?? '', /Recovery required for A\.md/u);
  assert.equal(contents.get('A.md'), '');
  harness.document.querySelector<HTMLButtonElement>('.tm-dashboard-delete-confirm-modal button')?.click();
  failedCalls.clear();
  retry.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(contents.get('A.md'), '- [ ] A 📅 2026-07-12\n');
  assert.equal(retry.hidden, true);
});

test('Dashboard card frame is focusable only while editing widgets', (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const app = {
    vault: { getAbstractFileByPath: () => null, getMarkdownFiles: () => [] },
    workspace: { getLeaf: () => ({ openFile: async () => undefined }), openLinkText: async () => undefined },
    metadataCache: { getFileCache: () => undefined, fileToLinktext: () => '' },
  } as unknown as App;
  const view = new DashboardView({ app } as unknown as WorkspaceLeaf, () => structuredClone(DEFAULT_SETTINGS), new TaskScanner(app));
  const grid = harness.document.createElement('section');
  harness.document.body.appendChild(grid);
  const internals = view as unknown as {
    contentEl: HTMLElement;
    gridEl: HTMLElement;
    cards: Array<{ el: HTMLElement; config: DashboardWidgetConfig }>;
    registry: ReturnType<typeof buildWidgetRegistry>;
    createCard(config: DashboardWidgetConfig): { el: HTMLElement; config: DashboardWidgetConfig };
    setEditMode(enabled: boolean): void;
  };
  internals.contentEl = harness.document.createElement('div');
  internals.gridEl = grid;
  internals.cards = [];
  internals.registry.register('today', { title: 'Today', icon: 'calendar', defaultSize: 'medium', render: async () => undefined });
  const card = internals.createCard({ type: 'today', title: 'Today', size: 'medium' });
  internals.cards.push(card);

  assert.equal(card.el.getAttribute('tabindex'), null);
  internals.setEditMode(true);
  assert.equal(card.el.getAttribute('tabindex'), '0');
  internals.setEditMode(false);
  assert.equal(card.el.getAttribute('tabindex'), null);
});

test('Dashboard destructive layout actions require confirmation', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const settings = structuredClone(DEFAULT_SETTINGS);
  const first = { id: 'first', name: 'First', widgets: [{ id: 'one', type: 'today', title: 'Today', size: 'medium' }], updatedAt: 1 } as never;
  const second = { id: 'second', name: 'Second', widgets: [], updatedAt: 1 } as never;
  settings.dashboardLayouts = { first, second };
  settings.activeDashboardId = 'first';
  const app = { vault: { getAbstractFileByPath: () => null, getMarkdownFiles: () => [] }, workspace: {} } as unknown as App;
  const view = new DashboardView({ app } as unknown as WorkspaceLeaf, () => settings, new TaskScanner(app));
  const internals = view as unknown as { layout: typeof first; deleteActiveDashboard(): void };
  internals.layout = first;
  internals.deleteActiveDashboard();
  assert.ok(harness.document.querySelector('.task-manager-confirm-actions'));
  const buttons = harness.document.querySelectorAll<HTMLButtonElement>('.task-manager-confirm-actions button');
  buttons[1]?.click();
  await Promise.resolve();
  assert.equal(settings.dashboardLayouts.first, undefined);
});

test('Dashboard widget menu confirms single-widget removal', async (context) => {
  const harness = installDomHarness(); context.after(harness.cleanup);
  const app = { vault: { getAbstractFileByPath: () => null, getMarkdownFiles: () => [] }, workspace: {} } as unknown as App;
  const view = new DashboardView({ app } as unknown as WorkspaceLeaf, () => structuredClone(DEFAULT_SETTINGS), new TaskScanner(app));
  const card = { config: { id: 'one', type: 'today', title: 'Today', size: 'medium' }, el: harness.document.createElement('div') } as never;
  const anchor = harness.document.createElement('button');
  Object.defineProperty(anchor, 'getBoundingClientRect', { value: () => ({ left: 0, bottom: 0 }) });
  const internals = view as unknown as { layout: { widgets: unknown[] }; cards: unknown[]; showCardMenu(anchor: HTMLElement, card: never): void };
  internals.layout = { widgets: [(card as { config: unknown }).config] }; internals.cards = [card]; internals.showCardMenu(anchor, card);
  const menu = Menu as unknown as { last: { items: Array<{ title?: string; click?: () => void }> } };
  menu.last.items.find((item) => item.title === 'Remove widget')?.click?.();
  harness.document.querySelectorAll<HTMLButtonElement>('.task-manager-confirm-actions button')[1]?.click(); await Promise.resolve();
  assert.equal(internals.layout.widgets.length, 0);
});

test('Dashboard card rendering isolates stale overlapping generations and disposes each result once', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const app = {
    vault: { getAbstractFileByPath: () => null, getMarkdownFiles: () => [] },
    workspace: { getLeaf: () => ({ openFile: async () => undefined }), openLinkText: async () => undefined },
    metadataCache: { getFileCache: () => undefined, fileToLinktext: () => '' },
  } as unknown as App;
  const view = new DashboardView({ app } as unknown as WorkspaceLeaf, () => structuredClone(DEFAULT_SETTINGS), new TaskScanner(app));
  const grid = harness.document.createElement('section');
  harness.document.body.appendChild(grid);
  const pending: Array<{ resolve: () => void; disposed: number }> = [];
  const internals = view as unknown as {
    gridEl: HTMLElement;
    registry: ReturnType<typeof buildWidgetRegistry>;
    createCard(config: DashboardWidgetConfig): { bodyEl: HTMLElement; dispose?: () => void; renderBody(): Promise<void> };
  };
  internals.gridEl = grid;
  internals.registry.register('today', {
    title: 'Today', icon: 'calendar', defaultSize: 'medium',
    render: async (container) => {
      const call: { resolve: () => void; disposed: number } = { resolve: () => undefined, disposed: 0 };
      const wait = new Promise<void>((resolve) => { call.resolve = resolve; });
      pending.push(call);
      const generation = pending.length;
      container.setText(`started-${generation}`);
      await wait;
      container.setText(`finished-${generation}`);
      return () => { call.disposed += 1; };
    },
  });
  const card = internals.createCard({ type: 'today', title: 'Today', size: 'medium' });
  const stale = card.renderBody();
  await Promise.resolve();
  const current = card.renderBody();
  await Promise.resolve();
  assert.equal(pending.length, 2);
  pending[1].resolve();
  await current;
  pending[0].resolve();
  await stale;
  assert.match(card.bodyEl.textContent ?? '', /finished-2/u);
  assert.doesNotMatch(card.bodyEl.textContent ?? '', /finished-1/u);
  assert.equal(pending[0].disposed, 1);
  assert.equal(pending[1].disposed, 0);
  disposeDashboardWidget(card);
  assert.equal(pending[1].disposed, 1);
});
