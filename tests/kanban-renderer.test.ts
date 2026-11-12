/**
 * Kanban Renderer Tests
 * Tests for renderKanban: column creation, task placement, WIP limits, and card content
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { allocateKanbanVisibleCounts, renderKanban } from '../src/kanban-renderer.js';
import { TaskScanner } from '../src/task-scanner.js';
import { FakeDOMElement } from './test-utils.js';
import { DEFAULT_TASK_STATES } from '../src/types.js';
import type { TaskManagerSettings } from '../src/types';
import type { TaskQuery } from '../src/task-query';

function scanner(): TaskScanner {
  return new TaskScanner({} as never);
}

function parsedTask(line: string, path: string, lineNumber: number): NonNullable<ReturnType<TaskScanner['parseTaskLine']>> {
  const parsed = scanner().parseTaskLine(line, path, lineNumber);
  assert.ok(parsed);
  return parsed;
}

/** Minimal TaskQuery suitable for renderKanban — merges any overrides. */
function emptyQuery(extra: Partial<TaskQuery> = {}): TaskQuery {
  return {
    filters: [],
    sort: [],
    groups: [],
    layout: { hidden: new Set(), shown: new Set() },
    explain: false,
    errors: [],
    instructions: [],
    ...extra,
  };
}

const testSettings = { supportedStates: DEFAULT_TASK_STATES } as TaskManagerSettings;
const noop = async () => {};
const noopSync = () => {};

// ── Container ────────────────────────────────────────────────────

test('kanban: adds kanban class to container element', () => {
  const el = new FakeDOMElement('div');
  renderKanban(el as any, [], emptyQuery(), testSettings, noop, noopSync);
  assert.ok(el.classes.includes('task-manager-kanban'), 'container should have task-manager-kanban class');
});

// ── Column creation ──────────────────────────────────────────────

test('kanban: renders core columns even with empty task list', () => {
  const el = new FakeDOMElement('div');
  renderKanban(el as any, [], emptyQuery(), testSettings, noop, noopSync);
  // Only todo-type and done-type states are retained when there are no tasks
  const cols = el.querySelectorAll('.task-manager-kanban-column');
  assert.ok(cols.length >= 2, `expected at least 2 core columns, got ${cols.length}`);
});

test('kanban: column headers contain Todo and Done labels', () => {
  const el = new FakeDOMElement('div');
  renderKanban(el as any, [], emptyQuery(), testSettings, noop, noopSync);
  const text = el.getInnerText();
  assert.ok(text.includes('Todo'), 'Todo column header should be present');
  assert.ok(text.includes('Done'), 'Done column header should be present');
});

// ── Task assignment ──────────────────────────────────────────────

test('kanban: places todo tasks in Todo column', () => {
  const el = new FakeDOMElement('div');
  const tasks = [scanner().parseTaskLine('- [ ] My todo task', 'Test.md', 1)!];
  renderKanban(el as any, tasks, emptyQuery(), testSettings, noop, noopSync);

  const cols = el.querySelectorAll('.task-manager-kanban-column');
  const todoCol = cols.find((c) => c.getInnerText().includes('Todo'));
  assert.ok(todoCol, 'Todo column should exist');
  assert.ok(todoCol.getInnerText().includes('My todo task'), 'task text should appear in Todo column');
});

test('kanban: places in-progress tasks in In Progress column', () => {
  const el = new FakeDOMElement('div');
  const tasks = [scanner().parseTaskLine('- [/] Work in progress', 'Test.md', 1)!];
  renderKanban(el as any, tasks, emptyQuery(), testSettings, noop, noopSync);

  const text = el.getInnerText();
  assert.ok(text.includes('Work in progress'), 'in-progress task text should be rendered');
  assert.ok(text.includes('Doing'), 'short In Progress column header should be present');
});

test('kanban: places done tasks in Done column', () => {
  const el = new FakeDOMElement('div');
  const tasks = [scanner().parseTaskLine('- [x] Finished task', 'Test.md', 1)!];
  renderKanban(el as any, tasks, emptyQuery(), testSettings, noop, noopSync);

  const cols = el.querySelectorAll('.task-manager-kanban-column');
  const doneCol = cols.find((c) => c.getInnerText().includes('Done'));
  assert.ok(doneCol, 'Done column should exist');
  assert.ok(doneCol.getInnerText().includes('Finished task'), 'task text should appear in Done column');
});

test('kanban: supports persistent boards grouped by project', () => {
  const el = new FakeDOMElement('div');
  const base = scanner().parseTaskLine('- [ ] Ship feature [project:: Alpha]', 'Test.md', 1)!;
  const settings = {
    ...testSettings,
    kanbanBoards: [{ id: 'projects', name: 'Projects', groupBy: 'project', query: 'not done', columns: ['Alpha', 'Beta'], background: '#123456' }],
    activeKanbanBoardId: 'projects',
    recurringHeatmapEnabled: false,
  } as TaskManagerSettings;
  renderKanban(el as any, [base], emptyQuery(), settings, noop, noopSync);

  assert.ok(el.getInnerText().includes('Projects'), 'board selector should include board name');
  assert.ok(el.getInnerText().includes('Alpha'), 'project column should render');
  assert.ok(el.getInnerText().includes('Ship feature'), 'task should render in project board');
});

test('kanban: non-status boards do not expose broken drag/drop affordances', () => {
  const el = new FakeDOMElement('div');
  const task = scanner().parseTaskLine('- [ ] Ship feature [project:: Alpha]', 'Test.md', 1)!;
  const settings = {
    ...testSettings,
    kanbanBoards: [{ id: 'projects', name: 'Projects', groupBy: 'project', query: 'not done', columns: ['Alpha', 'Beta'], background: '' }],
    activeKanbanBoardId: 'projects',
    recurringHeatmapEnabled: false,
  } as TaskManagerSettings;

  renderKanban(el as any, [task], emptyQuery(), settings, noop, noopSync);

  const card = el.querySelectorAll('.task-manager-kanban-card')[0];
  assert.equal(card.getAttr('draggable'), 'false', 'non-status grouped cards should not advertise drag');
  assert.equal(card.listeners.has('dragstart'), false, 'non-status grouped cards should not start native drags');
  assert.equal(card.listeners.has('pointerdown'), false, 'non-status grouped cards should not start pointer drags');
  for (const column of el.querySelectorAll('.task-manager-kanban-column')) {
    assert.equal(column.listeners.has('dragover'), false, 'non-status columns should not highlight as drop targets');
    assert.equal(column.listeners.has('drop'), false, 'non-status columns should not silently ignore drops');
  }
});

test('kanban: every non-status grouping exposes a non-drag Move to action', async () => {
  const el = new FakeDOMElement('div');
  const task = scanner().parseTaskLine('- [ ] Ship feature [project:: Alpha]', 'Test.md', 1);
  assert.ok(task);
  const settings = {
    ...testSettings,
    kanbanBoards: [{ id: 'projects', name: 'Projects', groupBy: 'project', query: 'not done', columns: ['Alpha', 'Beta'], background: '' }],
    activeKanbanBoardId: 'projects',
    recurringHeatmapEnabled: false,
  } as TaskManagerSettings;
  let moved = '';
  renderKanban(el as unknown as HTMLElement, [task], emptyQuery(), settings, noop, noopSync, undefined, undefined, {
    onMoveToGroup: async (_task, groupBy, value) => { moved = `${groupBy}:${value}`; },
  });
  const more = el.querySelectorAll('.task-manager-kanban-card-action').find((button) => button.text === '⋯');
  more?.listeners.get('click')?.({ stopPropagation: () => undefined });
  const menu = el.querySelectorAll('.task-manager-kanban-card-menu')[0];
  const target = menu?.children.find((child): child is FakeDOMElement => child instanceof FakeDOMElement && child.text === '→ Beta');
  target?.listeners.get('click')?.();
  await Promise.resolve();
  assert.equal(moved, 'project:Beta');
  assert.match(el.querySelector('.task-manager-kanban-mode-note')?.text ?? '', /without dragging/u);
});

test('kanban: board selector uses the dropdown as the primary switcher', () => {
  const el = new FakeDOMElement('div');
  const settings = {
    ...testSettings,
    kanbanBoards: [
      { id: 'a', name: 'Board A', groupBy: 'status', query: 'not done', columns: [], background: '' },
      { id: 'b', name: 'Board B', groupBy: 'project', query: 'not done', columns: [], background: '' },
    ],
    activeKanbanBoardId: 'a',
    recurringHeatmapEnabled: false,
  } as TaskManagerSettings;
  let rerenders = 0;
  renderKanban(el as any, [], emptyQuery(), settings, noop, noopSync, undefined, undefined, {
    onRerender: () => { rerenders += 1; },
  });

  const cycleButtons = el.querySelectorAll('.task-manager-kanban-board-cycle');
  assert.equal(cycleButtons.length, 0, 'prev/next cycle buttons should be removed');

  const select = el.querySelectorAll('.task-manager-kanban-board-select')[0];
  assert.ok(select, 'board dropdown should render');
  select.value = 'b';
  select.listeners.get('change')?.();
  assert.equal(settings.activeKanbanBoardId, 'b', 'dropdown should activate the selected board');
  assert.ok(rerenders >= 1, 'switching boards should request a rerender');
});

test('kanban: card menu exposes direct move shortcuts on status boards', async () => {
  const el = new FakeDOMElement('div');
  const task = scanner().parseTaskLine('- [ ] Move me', 'Test.md', 1)!;
  const settings = {
    ...testSettings,
    kanbanBoards: [{ id: 'status', name: 'Status Board', groupBy: 'status', query: 'not done', columns: [], background: '' }],
    activeKanbanBoardId: 'status',
    recurringHeatmapEnabled: false,
  } as TaskManagerSettings;
  const originalDocument = globalThis.document;
  const originalSetTimeout = globalThis.setTimeout;
  const docListeners = new Map<string, Function>();
  globalThis.document = {
    addEventListener: (name: string, listener: Function) => { docListeners.set(name, listener); },
    removeEventListener: (name: string) => { docListeners.delete(name); },
  } as never;
  globalThis.setTimeout = ((callback: TimerHandler) => {
    if (typeof callback === 'function') callback();
    else eval(callback);
    return 0 as never;
  }) as unknown as typeof setTimeout;
  let changedSymbol: string | null = null;
  try {
    renderKanban(el as any, [task], emptyQuery(), settings, noop, noopSync, async (_task, symbol) => { changedSymbol = symbol; });

    const moreButton = el.querySelectorAll('.task-manager-kanban-card-action').find((button) => button.text === '⋯');
    assert.ok(moreButton, 'card more button should render');
    moreButton.listeners.get('click')?.({ stopPropagation: () => undefined });

    const menu = el.querySelectorAll('.task-manager-kanban-card-menu')[0];
    assert.ok(menu, 'card menu should open');
    const moveButton = menu.children.find((child): child is FakeDOMElement => child instanceof FakeDOMElement && child.text === '→ Done') as FakeDOMElement | undefined;
    assert.ok(moveButton, 'move shortcut should be added for other status columns');
    moveButton.listeners.get('click')?.();
    assert.equal(changedSymbol, 'x', 'move shortcut should invoke the direct status update');

    const escapeListener = menu.listeners.get('keydown');
    assert.equal(typeof escapeListener, 'function', 'menu should handle Escape to close');
    let prevented = false;
    escapeListener?.({ key: 'Escape', preventDefault: () => { prevented = true; } });
    assert.equal(prevented, true, 'Escape should be prevented while closing the menu');
    assert.equal(el.querySelectorAll('.task-manager-kanban-card-menu').length, 0, 'Escape should close the menu');
  } finally {
    globalThis.document = originalDocument;
    globalThis.setTimeout = originalSetTimeout;
  }
});

test('kanban: board selector supports duplicate, edit, and delete shortcuts', () => {
  const el = new FakeDOMElement('div');
  const settings = {
    ...testSettings,
    kanbanBoards: [
      { id: 'a', name: 'Board A', groupBy: 'status', query: 'not done', columns: [], background: '' },
      { id: 'b', name: 'Board B', groupBy: 'project', query: 'not done', columns: [], background: '' },
    ],
    activeKanbanBoardId: 'a',
    recurringHeatmapEnabled: false,
  } as TaskManagerSettings;
  const originalPrompt = globalThis.prompt;
  const saveCalls: string[] = [];
  let rerenders = 0;
  globalThis.prompt = ((message: string, defaultValue?: string) => {
    saveCalls.push(`${message} :: ${defaultValue ?? ''}`);
    if (message.startsWith('Duplicate')) return 'Board A copy';
    if (message.startsWith('Board name')) return 'Board A renamed';
    if (message.startsWith('Board query')) return 'tag #work';
    if (message.startsWith('Group by')) return 'custom';
    if (message.startsWith('Custom field key')) return 'project';
    if (message.startsWith('Columns')) return 'Todo, Doing, Done';
    if (message.startsWith('Background')) return '#123456';
    if (message.startsWith('Type DELETE')) return 'DELETE';
    return defaultValue ?? '';
  }) as typeof prompt;
  try {
    renderKanban(el as any, [], emptyQuery(), settings, noop, noopSync, undefined, undefined, {
      onSaveSettings: async () => undefined,
      onRerender: () => { rerenders += 1; },
    });

    const actions = el.querySelectorAll('.task-manager-kanban-board-action');
    assert.equal(actions.length, 4, 'new, duplicate, edit, and delete actions should render');
    actions[1].listeners.get('click')?.();
    assert.equal(settings.kanbanBoards?.length, 3, 'duplicate should insert a board');
    assert.ok(settings.kanbanBoards?.some((board) => board.name === 'Board A copy'), 'duplicate should use prompted name');

    actions[2].listeners.get('click')?.();
    const editedBoard = settings.kanbanBoards?.find((board) => board.id === settings.activeKanbanBoardId);
    assert.ok(editedBoard, 'edited board should remain active');
    assert.equal(editedBoard?.name, 'Board A renamed', 'edit should update the board name');
    assert.equal(editedBoard?.query, 'tag #work', 'edit should update the board query');
    assert.equal(editedBoard?.groupBy, 'custom', 'edit should update the grouping mode');
    assert.equal(editedBoard?.customFieldKey, 'project', 'edit should update the custom field key');
    assert.deepEqual(editedBoard?.columns, ['Todo', 'Doing', 'Done'], 'edit should update the board columns');
    assert.equal(editedBoard?.background, '#123456', 'edit should update the board background');

    actions[3].listeners.get('click')?.();
    assert.ok(!settings.kanbanBoards?.some((board) => board.name === 'Board A renamed'), 'delete should remove the edited board');
    assert.ok(rerenders >= 3, 'board management shortcuts should rerender after each mutation');
    assert.ok(saveCalls.length >= 3, 'board management shortcuts should save after each mutation');
  } finally {
    globalThis.prompt = originalPrompt;
  }
});

test('kanban: bounded render caps 10k cards and exposes accessible load controls', () => {
  assert.deepEqual(allocateKanbanVisibleCounts([500, 300, 200], 10), [4, 3, 3]);
  const el = new FakeDOMElement('div');
  const tasks = Array.from({ length: 10_000 }, (_value, index) => parsedTask(`- [ ] Task ${index}`, `Folder/${Math.floor(index / 100)}.md`, index % 100 + 1));
  renderKanban(el as unknown as HTMLElement, tasks, emptyQuery(), testSettings, noop, noopSync, undefined, undefined, {
    renderLimit: { initialTotal: 200, increment: 100 },
  });
  assert.equal(el.querySelectorAll('.task-manager-kanban-card').length, 200);
  const columnButton = el.querySelectorAll('.task-manager-kanban-load-more')[0];
  const globalButton = el.querySelectorAll('.task-manager-kanban-global-load-more')[0];
  assert.ok(columnButton);
  assert.ok(globalButton);
  assert.match(columnButton.getAttr('aria-label') ?? '', /Show 100 more tasks/u);
  assert.match(globalButton.getAttr('aria-label') ?? '', /200 of 10000 shown/u);
});

test('kanban: bounded load more preserves order, uniqueness, and focus', () => {
  const el = new FakeDOMElement('div');
  const tasks = Array.from({ length: 450 }, (_value, index) => parsedTask(`- [ ] Ordered ${index}`, 'Ordered.md', index + 1));
  renderKanban(el as unknown as HTMLElement, tasks, emptyQuery(), testSettings, noop, noopSync, undefined, undefined, {
    renderLimit: { initialTotal: 200, increment: 100 },
  });
  const button = el.querySelectorAll('.task-manager-kanban-load-more')[0];
  assert.ok(button);
  let focusCalls = 0;
  button.focus = () => { focusCalls += 1; };
  button.dispatchEvent({ type: 'click' });
  assert.equal(el.querySelectorAll('.task-manager-kanban-card').length, 300);
  button.dispatchEvent({ type: 'click' });
  button.dispatchEvent({ type: 'click' });
  const labels = el.querySelectorAll('.task-manager-kanban-card-desc').map((element) => element.text);
  assert.equal(labels.length, 450);
  assert.equal(new Set(labels).size, 450);
  assert.deepEqual(labels, tasks.map((task) => task.normalizedText));
  assert.ok(focusCalls >= 2, 'non-final activations retain focus on the load-more control');
  assert.equal(button.disabled, true);
  assert.match(el.querySelectorAll('.task-manager-kanban-mount-status')[0]?.text ?? '', /450 of 450/u);
});

// ── WIP limits ──────────────────────────────────────────────────

test('kanban: shows WIP limit indicator in In Progress column header', () => {
  const el = new FakeDOMElement('div');
  const tasks = [
    scanner().parseTaskLine('- [/] Task 1', 'Test.md', 1)!,
    scanner().parseTaskLine('- [/] Task 2', 'Test.md', 2)!,
  ];
  renderKanban(el as any, tasks, emptyQuery({ wipLimit: 3 }), testSettings, noop, noopSync);

  const wipEls = el.querySelectorAll('.task-manager-kanban-wip');
  assert.ok(wipEls.length > 0, 'WIP limit element should be rendered when wipLimit is set');
  // Text should be e.g. "WIP 2/3"
  assert.ok(wipEls[0].text.includes('2') && wipEls[0].text.includes('3'), `WIP text "${wipEls[0].text}" should show current/limit counts`);
});

test('kanban: marks WIP indicator as over-limit when task count exceeds wipLimit', () => {
  const el = new FakeDOMElement('div');
  const tasks = [
    scanner().parseTaskLine('- [/] Task 1', 'Test.md', 1)!,
    scanner().parseTaskLine('- [/] Task 2', 'Test.md', 2)!,
    scanner().parseTaskLine('- [/] Task 3', 'Test.md', 3)!,
  ];
  renderKanban(el as any, tasks, emptyQuery({ wipLimit: 2 }), testSettings, noop, noopSync);

  const wipEls = el.querySelectorAll('.task-manager-kanban-wip');
  assert.ok(wipEls.length > 0, 'WIP limit element should be rendered');
  assert.ok(wipEls[0].classes.includes('is-over-limit'), 'WIP element should have is-over-limit class when count > limit');
});

test('kanban: WIP indicator does not show is-over-limit when at or below limit', () => {
  const el = new FakeDOMElement('div');
  const tasks = [scanner().parseTaskLine('- [/] Task 1', 'Test.md', 1)!];
  renderKanban(el as any, tasks, emptyQuery({ wipLimit: 3 }), testSettings, noop, noopSync);

  const wipEls = el.querySelectorAll('.task-manager-kanban-wip');
  assert.ok(wipEls.length > 0, 'WIP limit element should be rendered');
  assert.ok(!wipEls[0].classes.includes('is-over-limit'), 'WIP element should NOT have is-over-limit class when 1 of 3');
});

test('kanban: does not render WIP indicator when wipLimit is not set', () => {
  const el = new FakeDOMElement('div');
  const tasks = [scanner().parseTaskLine('- [/] Task 1', 'Test.md', 1)!];
  renderKanban(el as any, tasks, emptyQuery(), testSettings, noop, noopSync);

  const wipEls = el.querySelectorAll('.task-manager-kanban-wip');
  assert.equal(wipEls.length, 0, 'WIP element should NOT be present when no wipLimit in query');
});

// ── Card content ─────────────────────────────────────────────────

test('kanban: shows due date in task card', () => {
  const el = new FakeDOMElement('div');
  const tasks = [scanner().parseTaskLine('- [ ] Task with due 📅 2026-07-01', 'Test.md', 1)!];
  renderKanban(el as any, tasks, emptyQuery(), testSettings, noop, noopSync);

  const text = el.getInnerText();
  assert.ok(text.includes('2026-07-01'), 'due date should appear in rendered card metadata');
});

test('kanban: cards expose shared toolbar filter metadata', () => {
  const el = new FakeDOMElement('div');
  const tasks = [scanner().parseTaskLine('- [ ] Follow up #launch 📅 2026-07-01 [id:: launch-1]', 'Launch.md', 1)!];
  renderKanban(el as any, tasks, emptyQuery(), testSettings, noop, noopSync);

  const [card] = el.querySelectorAll('.task-manager-kanban-card');
  assert.ok(card.classes.includes('task-manager-filterable-item'), 'kanban card should participate in shared toolbar filtering');
  assert.equal(card.getAttr('data-task-tags'), 'launch', 'card should expose normalized tags for tag chips');
  assert.match(card.getAttr('data-task-filter-text') ?? '', /follow up/u, 'card should expose searchable task text');
  assert.match(card.getAttr('data-task-filter-text') ?? '', /launch\.md/u, 'card should expose source file text');
});

test('kanban: shows task count in column header when tasks are present', () => {
  const el = new FakeDOMElement('div');
  const tasks = [
    scanner().parseTaskLine('- [ ] Task 1', 'Test.md', 1)!,
    scanner().parseTaskLine('- [ ] Task 2', 'Test.md', 2)!,
  ];
  renderKanban(el as any, tasks, emptyQuery(), testSettings, noop, noopSync);

  const countEls = el.querySelectorAll('.task-manager-kanban-col-count');
  assert.ok(countEls.length > 0, 'column count element should be present');
  assert.equal(countEls[0].text, '2', 'column count should show 2');
});

test('kanban: preserves task order within a column', () => {
  const el = new FakeDOMElement('div');
  const tasks = [
    scanner().parseTaskLine('- [ ] Alpha task', 'Test.md', 1)!,
    scanner().parseTaskLine('- [ ] Beta task', 'Test.md', 2)!,
    scanner().parseTaskLine('- [ ] Gamma task', 'Test.md', 3)!,
  ];
  renderKanban(el as any, tasks, emptyQuery(), testSettings, noop, noopSync);

  const text = el.getInnerText();
  const alphaIdx = text.indexOf('Alpha task');
  const betaIdx = text.indexOf('Beta task');
  const gammaIdx = text.indexOf('Gamma task');
  assert.ok(alphaIdx !== -1 && betaIdx !== -1 && gammaIdx !== -1, 'all task texts should be present');
  assert.ok(alphaIdx < betaIdx && betaIdx < gammaIdx, 'tasks should appear in original order');
});

// ── Empty-state placeholder ──────────────────────────────────────

test('kanban: shows drop placeholder in empty core columns', () => {
  const el = new FakeDOMElement('div');
  renderKanban(el as any, [], emptyQuery(), testSettings, noop, noopSync);

  const text = el.getInnerText();
  assert.ok(text.includes('Drop here'), 'empty core columns should show a "Drop here" placeholder');
});

// ── Non-core columns ─────────────────────────────────────────────

test('kanban: hides non-core empty columns', () => {
  const el = new FakeDOMElement('div');
  renderKanban(el as any, [], emptyQuery(), testSettings, noop, noopSync);

  const text = el.getInnerText();
  // 'In Progress', 'Blocked', 'Waiting', 'Deferred', 'Cancelled' are non-core and should be absent when empty
  assert.ok(!text.includes('In Progress'), 'empty non-core In Progress column should not be rendered');
  assert.ok(!text.includes('Blocked'), 'empty non-core Blocked column should not be rendered');
});

test('kanban: shows non-core column when it has tasks', () => {
  const el = new FakeDOMElement('div');
  const tasks = [scanner().parseTaskLine('- [/] Active work', 'Test.md', 1)!];
  renderKanban(el as any, tasks, emptyQuery(), testSettings, noop, noopSync);

  const text = el.getInnerText();
  assert.ok(text.includes('Doing'), 'short In Progress column should appear when it has tasks');
  assert.ok(text.includes('Active work'), 'in-progress task text should be visible');
});

// ── Cross-view drag/drop ─────────────────────────────────────────

// ── dragleave child guard ─────────────────────────────────────────

test('kanban: dragleave from a child element does not remove column dragover class', () => {
  const el = new FakeDOMElement('div');
  const tasks = [scanner().parseTaskLine('- [ ] Any task', 'Test.md', 1)!];
  renderKanban(el as any, tasks, emptyQuery(), testSettings, noop, noopSync);

  const cols = el.querySelectorAll('.task-manager-kanban-column');
  const todoCol = cols.find((c) => c.getAttr('data-column') === 'Todo');
  assert.ok(todoCol, 'Todo column should exist');

  // Simulate dragover → column gets the highlight class.
  const dragoverListener = todoCol.listeners.get('dragover');
  assert.ok(dragoverListener, 'should have a dragover listener');
  dragoverListener({ preventDefault: () => {}, dataTransfer: null });
  assert.ok(todoCol.classes.includes('task-manager-kanban-column-dragover'), 'class should be added on dragover');

  // Simulate dragleave where relatedTarget is a child of the column.
  const dragleaveListener = todoCol.listeners.get('dragleave');
  assert.ok(dragleaveListener, 'should have a dragleave listener');
  const childCard = todoCol.querySelectorAll('.task-manager-kanban-card')[0];
  assert.ok(childCard, 'column should have at least one card child');
  // relatedTarget is a child → class must NOT be removed.
  dragleaveListener({ relatedTarget: childCard });
  assert.ok(
    todoCol.classes.includes('task-manager-kanban-column-dragover'),
    'class should remain when dragleave relatedTarget is a child element',
  );

  // Simulate dragleave where relatedTarget is outside the column (null = leaving the window).
  dragleaveListener({ relatedTarget: null });
  assert.ok(
    !todoCol.classes.includes('task-manager-kanban-column-dragover'),
    'class should be removed when dragleave relatedTarget is outside the column',
  );
});

test('kanban: cross-view drop via dataTransfer triggers onChangeStatus when dragKey is null', () => {
  const el = new FakeDOMElement('div');
  const task = scanner().parseTaskLine('- [ ] Dropped from list', 'Test.md', 1)!;
  const tasks = [task];

  let changedTask: typeof task | null = null;
  let changedSymbol: string | null = null;
  const onChangeStatus = async (t: typeof task, symbol: string) => {
    changedTask = t;
    changedSymbol = symbol;
  };

  renderKanban(el as any, tasks, emptyQuery(), testSettings, noop, noopSync, onChangeStatus);

  // Find the Done column (core column)
  const cols = el.querySelectorAll('.task-manager-kanban-column');
  const doneCol = cols.find((c) => c.getAttr('data-column') === 'Done');
  assert.ok(doneCol, 'Done column should exist');

  // Simulate a cross-view drop: no intra-kanban dragstart was fired (dragKey === null),
  // so the task key arrives only via dataTransfer.
  const fakeDataTransfer = {
    getData: (type: string) => {
      if (type === 'application/task-id') return task.key;
      return '';
    },
  };
  const fakeDropEvent = {
    preventDefault: () => {},
    dataTransfer: fakeDataTransfer,
  };
  const dropListener = doneCol.listeners.get('drop');
  assert.ok(dropListener, 'Done column should have a drop listener');
  dropListener(fakeDropEvent);

  assert.ok(changedTask !== null, 'onChangeStatus should have been called for cross-view drop');
  assert.equal((changedTask as unknown as typeof task).key, task.key, 'should call onChangeStatus with the correct task');
  // Done state rawText is 'x'
  assert.equal(changedSymbol, 'x', 'should call onChangeStatus with the Done checkbox symbol');
});
