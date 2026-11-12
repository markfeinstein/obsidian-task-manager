import test from 'node:test';
import assert from 'node:assert/strict';
import { PlanningBoard, planPlanningBoardSchedule, planningBoardTargetForTab, renderPlanningBoard } from '../src/planning-board';
import type { DragOperation } from '../src/planning-board';
import type { ParsedTask } from '../src/task-scanner';
import { DEFAULT_SETTINGS, DEFAULT_TASK_STATES } from '../src/types';
import { FakeDOMElement } from './test-utils';

function makeTask(key: string, indentation: string): ParsedTask {
  return {
    key,
    filePath: 'test.md',
    lineNumber: 0,
    rawLine: `${indentation}- [ ] ${key}`,
    linePrefix: `${indentation}- `,
    indentation,
    listMarker: '-',
    checkbox: ' ',
    body: key,
    normalizedText: key,
    status: 'todo',
    tags: [],
    contexts: [],
    metadata: {
      priority: 'normal',
      dates: {},
    } as any,
  } as ParsedTask;
}

const settings = { ...DEFAULT_SETTINGS, supportedStates: DEFAULT_TASK_STATES };
const config = { settings, todayDate: '2026-05-30' };

test('p2c fix: buildHierarchy preserves grandchildren (3-level nesting)', () => {
  // A (root) → B (child) → C (grandchild)
  const tasks = [
    makeTask('A', ''),
    makeTask('B', '  '),
    makeTask('C', '    '),
  ];

  const board = new PlanningBoard(config);
  const cards = board.buildHierarchy(tasks);

  assert.equal(cards.length, 1, 'Should have 1 root card');
  assert.equal(cards[0].task.key, 'A', 'Root card should be A');
  assert.equal(cards[0].children.length, 1, 'A should have 1 child');
  assert.equal(cards[0].children[0].task.key, 'B', "A's child should be B");
  assert.equal(cards[0].children[0].children.length, 1, 'B should have 1 child (grandchild)');
  assert.equal(cards[0].children[0].children[0].task.key, 'C', "B's child should be C");
  assert.equal(cards[0].children[0].children[0].parentKey, 'B', "C's parentKey should be B");
});

test('p2c fix: buildHierarchy preserves deeply nested tasks (4 levels)', () => {
  const tasks = [
    makeTask('A', ''),
    makeTask('B', '  '),
    makeTask('C', '    '),
    makeTask('D', '      '),
  ];

  const board = new PlanningBoard(config);
  const cards = board.buildHierarchy(tasks);

  assert.equal(cards.length, 1, 'Should have 1 root card');
  const b = cards[0].children[0];
  const c = b.children[0];
  const d = c.children[0];
  assert.equal(b.task.key, 'B');
  assert.equal(c.task.key, 'C');
  assert.equal(d?.task.key, 'D', 'D (depth 3) should be present');
  assert.equal(d?.parentKey, 'C', "D's parentKey should be C");
});

test('p2c fix: buildHierarchy handles multiple siblings at each level', () => {
  // A → B1, B2; B1 → C1; B2 → C2
  const tasks = [
    makeTask('A', ''),
    makeTask('B1', '  '),
    makeTask('C1', '    '),
    makeTask('B2', '  '),
    makeTask('C2', '    '),
  ];

  const board = new PlanningBoard(config);
  const cards = board.buildHierarchy(tasks);

  assert.equal(cards.length, 1, 'Should have 1 root card');
  assert.equal(cards[0].children.length, 2, 'A should have 2 children (B1, B2)');
  const b1 = cards[0].children[0];
  const b2 = cards[0].children[1];
  assert.equal(b1.task.key, 'B1');
  assert.equal(b2.task.key, 'B2');
  assert.equal(b1.children.length, 1, 'B1 should have 1 child (C1)');
  assert.equal(b1.children[0].task.key, 'C1');
  assert.equal(b2.children.length, 1, 'B2 should have 1 child (C2)');
  assert.equal(b2.children[0].task.key, 'C2');
});

test('pass143: today tab excludes done/cancelled tasks', () => {
  const today = '2026-05-31';
  const board = new PlanningBoard({ settings, todayDate: today });

  const tasks: ParsedTask[] = [
    { ...makeTask('active', ''), status: 'todo', metadata: { priority: 'normal', dates: { scheduled: today } } as any },
    { ...makeTask('done-task', ''), status: 'done', metadata: { priority: 'normal', dates: { scheduled: today } } as any },
    { ...makeTask('cancelled-task', ''), status: 'cancelled', metadata: { priority: 'normal', dates: { due: today } } as any },
  ];

  const result = board.getTasksByTab('today', tasks);
  assert.equal(result.length, 1, 'only active tasks should appear in today tab');
  assert.equal(result[0].key, 'active');
});

test('pass143: week tab excludes done/cancelled tasks', () => {
  const today = '2026-05-31';
  const nextWeek = '2026-06-05';
  const board = new PlanningBoard({ settings, todayDate: today });

  const tasks: ParsedTask[] = [
    { ...makeTask('active', ''), status: 'todo', metadata: { priority: 'normal', dates: { due: nextWeek } } as any },
    { ...makeTask('done-task', ''), status: 'done', metadata: { priority: 'normal', dates: { due: nextWeek } } as any },
    { ...makeTask('cancelled-task', ''), status: 'cancelled', metadata: { priority: 'normal', dates: { scheduled: nextWeek } } as any },
  ];

  const result = board.getTasksByTab('week', tasks);
  assert.equal(result.length, 1, 'only active tasks should appear in week tab');
  assert.equal(result[0].key, 'active');
});

test('pass143: month tab excludes done/cancelled tasks', () => {
  const today = '2026-05-31';
  const nextMonth = '2026-06-20';
  const board = new PlanningBoard({ settings, todayDate: today });

  const tasks: ParsedTask[] = [
    { ...makeTask('active', ''), status: 'todo', metadata: { priority: 'normal', dates: { due: nextMonth } } as any },
    { ...makeTask('done-task', ''), status: 'done', metadata: { priority: 'normal', dates: { due: nextMonth } } as any },
    { ...makeTask('cancelled-task', ''), status: 'cancelled', metadata: { priority: 'normal', dates: { scheduled: nextMonth } } as any },
  ];

  const result = board.getTasksByTab('month', tasks);
  assert.equal(result.length, 1, 'only active tasks should appear in month tab');
  assert.equal(result[0].key, 'active');
});

test('planning board completed tab includes done and cancelled tasks', () => {
  const today = '2026-05-31';
  const board = new PlanningBoard({ settings, todayDate: today });

  const tasks: ParsedTask[] = [
    { ...makeTask('active', ''), status: 'todo', metadata: { priority: 'normal', dates: {} } as any },
    { ...makeTask('done-task', ''), status: 'done', metadata: { priority: 'normal', dates: {} } as any },
    { ...makeTask('cancelled-task', ''), status: 'cancelled', metadata: { priority: 'normal', dates: {} } as any },
  ];

  assert.deepEqual(board.getTasksByTab('completed', tasks).map((task) => task.key), ['done-task', 'cancelled-task']);
});

test('planning board totals use strict shared effort parsing', () => {
  const board = new PlanningBoard(config);
  const tasks: ParsedTask[] = [
    { ...makeTask('decimal', ''), metadata: { priority: 'normal', dates: {}, effort: '1.5h' } as any },
    { ...makeTask('bare-minutes', ''), metadata: { priority: 'normal', dates: {}, effort: '30' } as any },
    { ...makeTask('invalid-partial', ''), metadata: { priority: 'normal', dates: {}, effort: '2horse' } as any },
  ];

  assert.equal(board.getEstimateTotal(tasks), 120, 'invalid partial tokens should be ignored and valid shared formats counted');
});

test('planning board unschedule plan clears one active date safely', () => {
  const task = {
    ...makeTask('both-dates', ''),
    metadata: { priority: 'normal', dates: { scheduled: '2026-06-01', due: '2026-06-02' } } as any,
  };

  const plan = planPlanningBoardSchedule(task, { tab: 'unscheduled', date: null, field: 'scheduled' }, 123);

  assert.deepEqual(plan.updates, [{ field: 'scheduled', value: null }]);
  assert.equal(plan.operation.toScheduled, null);
  assert.equal(plan.operation.toDue, '2026-06-02');
});

test('planning board tab filtering prevents duplicates using earliest date', () => {
  const today = '2026-06-09';
  const board = new PlanningBoard({ settings, todayDate: today });

  // Task with scheduled=today and due=next-week should only appear in Today tab.
  // Before the fix, it appeared in both Today (matching scheduled) and Week (matching due).
  const taskA: ParsedTask = {
    ...makeTask('dual-date-task', ''),
    status: 'todo',
    metadata: {
      priority: 'normal',
      dates: {
        scheduled: '2026-06-09', // today
        due: '2026-06-12',        // next week (within weekEnd 2026-06-16)
      },
    } as any,
  };

  const todayTasks = board.getTasksByTab('today', [taskA]);
  const weekTasks = board.getTasksByTab('week', [taskA]);

  assert.equal(todayTasks.length, 1, 'task should appear in Today tab (earliest date=today)');
  assert.equal(weekTasks.length, 0, 'task should NOT appear in Week tab (would be duplicate)');
});

test('planning board keeps a due-today task in Today even when scheduled in the past', () => {
  const today = '2026-06-09';
  const board = new PlanningBoard({ settings, todayDate: today });

  // Overdue scheduled date but due today: the earliest DATE is in the past,
  // yet the task must still surface under Today because it is due today.
  const taskB: ParsedTask = {
    ...makeTask('due-today-task', ''),
    status: 'todo',
    metadata: {
      priority: 'normal',
      dates: {
        scheduled: '2026-06-05', // past
        due: '2026-06-09',        // today
      },
    } as any,
  };

  assert.equal(board.getTasksByTab('today', [taskB]).length, 1, 'due-today task must show in Today');
  assert.equal(board.getTasksByTab('week', [taskB]).length, 0, 'must not also appear in Week');
  assert.equal(board.getTasksByTab('month', [taskB]).length, 0, 'must not also appear in Month');
});

test('planning board expand button does not bubble to task click handler', () => {
  const container = new FakeDOMElement('div');
  const tasks = [
    { ...makeTask('A', ''), metadata: { priority: 'normal', dates: { scheduled: config.todayDate } } as any },
    { ...makeTask('B', '  '), metadata: { priority: 'normal', dates: { scheduled: config.todayDate } } as any },
  ];
  let clicked = 0;

  renderPlanningBoard(
    container as unknown as HTMLElement,
    tasks,
    config,
    undefined,
    () => { clicked += 1; },
  );

  const expandBtn = container.querySelector('.planning-board-expand-btn');
  const header = container.querySelector('.planning-board-card-header');
  assert.ok(expandBtn);
  assert.ok(header);

  let stopped = false;
  expandBtn.listeners.get('click')?.({ stopPropagation: () => { stopped = true; } } as MouseEvent);
  if (!stopped) header.listeners.get('click')?.({} as MouseEvent);

  assert.equal(clicked, 0, 'expanding a parent card must not open the task');
});

test('planning board exposes tab and card keyboard semantics', () => {
  const container = new FakeDOMElement('div');
  const tasks = [{ ...makeTask('A', ''), metadata: { priority: 'normal', dates: { scheduled: config.todayDate } } as ParsedTask['metadata'] }];
  renderPlanningBoard(container as unknown as HTMLElement, tasks, config, undefined, () => undefined);

  const tabs = container.querySelector('.planning-board-tabs');
  assert.equal(tabs?.getAttr('role'), 'tablist');
  const tabButtons = container.querySelectorAll('.planning-board-tab-btn');
  assert.equal(tabButtons[0]?.getAttr('aria-selected'), 'true');
  assert.equal((tabButtons[0] as unknown as { tabIndex: number }).tabIndex, 0);
  assert.ok(tabButtons.slice(1).every((button) => (button as unknown as { tabIndex: number }).tabIndex === -1));
  const panel = container.querySelector('.planning-board-content');
  assert.equal(panel?.getAttr('role'), 'tabpanel');
  assert.equal(tabButtons[0]?.getAttr('aria-controls'), (panel as unknown as { id: string }).id);
  const taskInfo = container.querySelector('.planning-board-card-info');
  assert.equal(taskInfo?.tagName, 'button');
  assert.equal(taskInfo?.getAttr('type'), 'button');
});

test('planning board drop zone keeps highlight while dragging over its children', () => {
  const container = new FakeDOMElement('div');
  const tasks = [{ ...makeTask('A', ''), metadata: { priority: 'normal', dates: { scheduled: config.todayDate } } as any }];

  renderPlanningBoard(
    container as unknown as HTMLElement,
    tasks,
    config,
    () => undefined,
    undefined,
  );

  const dropZone = container.querySelector('.planning-board-drop-zone');
  assert.ok(dropZone, 'drop zone should render when drag-drop is enabled');

  const dragOver = dropZone.listeners.get('dragover') as ((event: DragEvent) => void) | undefined;
  const dragLeave = dropZone.listeners.get('dragleave') as ((event: DragEvent) => void) | undefined;
  assert.ok(dragOver);
  assert.ok(dragLeave);

  dragOver({ preventDefault: () => undefined, dataTransfer: { dropEffect: 'move' } } as DragEvent);
  assert.equal(dropZone.classes.includes('is-drag-over'), true, 'class should be added on dragover');

  const child = dropZone.children[0] as FakeDOMElement;
  assert.ok(child, 'drop zone should contain child elements');
  dragLeave({ relatedTarget: child } as unknown as DragEvent);
  assert.equal(dropZone.classes.includes('is-drag-over'), true, 'class should remain when dragleave is from a child element');

  dragLeave({ relatedTarget: null } as unknown as DragEvent);
  assert.equal(dropZone.classes.includes('is-drag-over'), false, 'class should be removed when pointer leaves the drop zone');
});

test('planning board records Undo only after persistence and retains it across rerenders', async () => {
  const container = new FakeDOMElement('div');
  const tasks = [{ ...makeTask('A', ''), metadata: metadataWithDates({ due: config.todayDate }) }];
  const updates: Array<{ field: string; value: string | null }> = [];
  const update = async (task: ParsedTask, field: 'scheduled' | 'due', value: string | null): Promise<ParsedTask> => {
    updates.push({ field, value });
    const dates = { ...task.metadata.dates };
    if (value === null) delete dates[field]; else dates[field] = value;
    return { ...task, metadata: { ...task.metadata, dates } };
  };
  const board = renderPlanningBoard(container as unknown as HTMLElement, tasks, config, update);
  const taskInfo = container.querySelector('.planning-board-card-info');
  assert.ok(taskInfo);
  taskInfo.listeners.get('keydown')?.({ key: 's', preventDefault: () => undefined } as KeyboardEvent);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(updates, [{ field: 'scheduled', value: config.todayDate }]);
  assert.equal(board.getDragHistory().length, 1);
  assert.ok(container.querySelector('.planning-board-undo'));

  const rerendered = new FakeDOMElement('div');
  renderPlanningBoard(rerendered as unknown as HTMLElement, tasks, config, update, undefined, board);
  const undo = rerendered.querySelector('.planning-board-undo');
  assert.ok(undo, 'caller-owned board session keeps Undo across a host rerender');
  undo.listeners.get('click')?.({} as MouseEvent);
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.deepEqual(updates.at(-1), { field: 'scheduled', value: null });
  assert.equal(board.getDragHistory().length, 0);
  assert.equal(rerendered.querySelector('.planning-board-undo'), null);
  assert.match(rerendered.querySelector('.task-manager-sr-only')?.getInnerText() ?? '', /Undid schedule change for A/u);
});

test('planning board expires stale Undo instead of overwriting a newer external date', async () => {
  const container = new FakeDOMElement('div');
  const tasks = [{ ...makeTask('A', ''), metadata: metadataWithDates({ due: config.todayDate }) }];
  let writes = 0;
  const board = renderPlanningBoard(container as unknown as HTMLElement, tasks, config, async (current, field, value) => {
    writes += 1;
    const dates = { ...current.metadata.dates };
    if (value === null) delete dates[field]; else dates[field] = value;
    return { ...current, metadata: { ...current.metadata, dates } };
  });
  container.querySelector('.planning-board-card-info')?.listeners.get('keydown')?.({ key: 's', preventDefault: () => undefined } as KeyboardEvent);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(writes, 1);

  tasks[0] = { ...tasks[0], metadata: { ...tasks[0].metadata, dates: { ...tasks[0].metadata.dates, scheduled: '2026-06-30' } } };
  const rerendered = new FakeDOMElement('div');
  renderPlanningBoard(rerendered as unknown as HTMLElement, tasks, config, async () => { writes += 1; return tasks[0]; }, undefined, board);
  rerendered.querySelector('.planning-board-undo')?.listeners.get('click')?.({} as MouseEvent);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(writes, 1, 'stale Undo must not write over the external edit');
  assert.equal(board.getDragHistory().length, 0);
  assert.match(rerendered.querySelector('.task-manager-sr-only')?.getInnerText() ?? '', /Undo expired/u);
});

test('planning board restores keyboard focus after schedule and Undo rerenders', async () => {
  const container = new FakeDOMElement('div');
  const tasks = [{ ...makeTask('A', ''), metadata: metadataWithDates({ due: config.todayDate }) }];
  let focusedClass = '';
  const originalFocus = FakeDOMElement.prototype.focus;
  FakeDOMElement.prototype.focus = function focus() { focusedClass = this.classes[0] ?? this.tagName; };
  try {
    renderPlanningBoard(container as unknown as HTMLElement, tasks, config, async (current, field, value) => {
      const dates = { ...current.metadata.dates };
      if (value === null) delete dates[field]; else dates[field] = value;
      return { ...current, metadata: { ...current.metadata, dates } };
    });
    container.querySelector('.planning-board-card-info')?.listeners.get('keydown')?.({ key: 's', preventDefault: () => undefined } as KeyboardEvent);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(focusedClass, 'planning-board-undo');
    container.querySelector('.planning-board-undo')?.listeners.get('click')?.({} as MouseEvent);
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.equal(focusedClass, 'planning-board-content');
  } finally {
    FakeDOMElement.prototype.focus = originalFocus;
  }
});

test('planning board does not expose Undo when persistence refuses a schedule change', async () => {
  const container = new FakeDOMElement('div');
  const tasks = [{ ...makeTask('A', ''), metadata: metadataWithDates({ due: config.todayDate }) }];
  const board = renderPlanningBoard(container as unknown as HTMLElement, tasks, config, async () => false);
  container.querySelector('.planning-board-card-info')?.listeners.get('keydown')?.({ key: 's', preventDefault: () => undefined } as KeyboardEvent);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(board.getDragHistory().length, 0);
  assert.equal(container.querySelector('.planning-board-undo'), null);
  assert.match(container.querySelector('.task-manager-sr-only')?.getInnerText() ?? '', /refused/u);
});

// ── planningBoardTargetForTab ────────────────────────────────────────────────

function metadataWithDates(dates: ParsedTask['metadata']['dates']): ParsedTask['metadata'] {
  return { priority: 'normal', dates, invalidDates: {}, dependsOn: [] };
}

test('planningBoardTargetForTab maps each tab to its drop target (or null for completed)', () => {
  const today = '2026-06-15';
  assert.deepEqual(planningBoardTargetForTab('today', today), { tab: 'today', date: today, field: 'scheduled' });
  assert.deepEqual(planningBoardTargetForTab('week', today), { tab: 'week', date: '2026-06-16', field: 'scheduled' });
  assert.deepEqual(planningBoardTargetForTab('month', today), { tab: 'month', date: '2026-06-23', field: 'scheduled' });
  assert.deepEqual(planningBoardTargetForTab('unscheduled', today), { tab: 'unscheduled', date: null, field: 'scheduled' });
  assert.equal(planningBoardTargetForTab('completed', today), null);
});

// ── planPlanningBoardSchedule: scheduling (non-null date) path ──────────────

test('planPlanningBoardSchedule writes the scheduled date and leaves due untouched when dropped on a dated tab', () => {
  const dropped = { ...makeTask('t1', ''), metadata: metadataWithDates({ due: '2026-06-01' }) };
  const plan = planPlanningBoardSchedule(dropped, { tab: 'week', date: '2026-06-20', field: 'scheduled' }, 1000);

  assert.deepEqual(plan.updates, [{ field: 'scheduled', value: '2026-06-20' }]);
  assert.equal(plan.label, 'scheduled 2026-06-20');
  assert.deepEqual(plan.operation, {
    taskKey: 't1',
    fromScheduled: null,
    fromDue: '2026-06-01',
    toScheduled: '2026-06-20',
    toDue: '2026-06-01',
    timestamp: 1000,
  });
});

test('planPlanningBoardSchedule clears the due date when unscheduling a task with no scheduled date', () => {
  const dueOnly = { ...makeTask('t1', ''), metadata: metadataWithDates({ due: '2026-06-12' }) };
  const plan = planPlanningBoardSchedule(dueOnly, { tab: 'unscheduled', date: null, field: 'scheduled' }, 1000);

  assert.deepEqual(plan.updates, [{ field: 'due', value: null }]);
  assert.equal(plan.operation.toScheduled, null);
  assert.equal(plan.operation.toDue, null);
});

// ── getTasksByTab: week/month boundaries and the unscheduled bucket ─────────

test('getTasksByTab treats weekEnd/monthEnd as inclusive boundaries and drops tasks scheduled beyond the month window', () => {
  const today = '2026-06-15';
  const board = new PlanningBoard({ settings, todayDate: today });
  const weekBoundary = { ...makeTask('week-boundary', ''), metadata: metadataWithDates({ scheduled: '2026-06-22' }) };
  const monthBoundary = { ...makeTask('month-boundary', ''), metadata: metadataWithDates({ scheduled: '2026-07-15' }) };
  const beyondMonth = { ...makeTask('beyond-month', ''), metadata: metadataWithDates({ scheduled: '2026-07-16' }) };
  const allTasks = [weekBoundary, monthBoundary, beyondMonth];

  assert.deepEqual(board.getTasksByTab('week', allTasks).map((t) => t.key), ['week-boundary']);
  assert.deepEqual(board.getTasksByTab('month', allTasks).map((t) => t.key), ['month-boundary']);
  assert.equal(board.getTasksByTab('unscheduled', allTasks).length, 0, 'a future date beyond the month window is not "unscheduled"');
});

test('getTasksByTab: unscheduled excludes done/cancelled tasks even when they are undated', () => {
  const board = new PlanningBoard({ settings, todayDate: '2026-06-15' });
  const tasks: ParsedTask[] = [
    { ...makeTask('active-undated', ''), status: 'todo', metadata: metadataWithDates({}) },
    { ...makeTask('done-undated', ''), status: 'done', metadata: metadataWithDates({}) },
    { ...makeTask('cancelled-undated', ''), status: 'cancelled', metadata: metadataWithDates({}) },
  ];

  assert.deepEqual(board.getTasksByTab('unscheduled', tasks).map((t) => t.key), ['active-undated']);
});

test('getTasksByTab: unscheduled includes undated tasks and tasks whose only date is already in the past', () => {
  const today = '2026-06-15';
  const board = new PlanningBoard({ settings, todayDate: today });
  const undated = { ...makeTask('undated', ''), metadata: metadataWithDates({}) };
  const pastScheduledOnly = { ...makeTask('past-scheduled-only', ''), metadata: metadataWithDates({ scheduled: '2026-05-01' }) };
  const pastDueOnly = { ...makeTask('past-due-only', ''), metadata: metadataWithDates({ due: '2026-05-01' }) };
  const futureScheduled = { ...makeTask('future-scheduled', ''), metadata: metadataWithDates({ scheduled: '2026-06-16' }) };

  const result = board.getTasksByTab('unscheduled', [undated, pastScheduledOnly, pastDueOnly, futureScheduled]);
  assert.deepEqual(result.map((t) => t.key), ['undated', 'past-scheduled-only', 'past-due-only']);
});

// ── toggleExpand ──────────────────────────────────────────────────────────────

test('buildHierarchy reflects toggleExpand in the isExpanded flag', () => {
  const board = new PlanningBoard(config);
  const tasks = [makeTask('parent', ''), makeTask('child', '  ')];

  assert.equal(board.buildHierarchy(tasks)[0].isExpanded, false);
  board.toggleExpand('parent');
  assert.equal(board.buildHierarchy(tasks)[0].isExpanded, true);
  board.toggleExpand('parent');
  assert.equal(board.buildHierarchy(tasks)[0].isExpanded, false);
});

// ── Undo stack (recordDragOperation / undoLastDrag / getDragHistory / clearDragHistory) ──

function dragOp(taskKey: string): DragOperation {
  return { taskKey, fromScheduled: null, fromDue: null, toScheduled: null, toDue: null, timestamp: Date.now() };
}

test('recordDragOperation trims the undo stack to maxUndoStack, dropping the oldest operation first', () => {
  const board = new PlanningBoard({ ...config, maxUndoStack: 3 });
  for (let i = 0; i < 5; i += 1) board.recordDragOperation(dragOp(`op-${i}`));

  assert.deepEqual(board.getDragHistory().map((op) => op.taskKey), ['op-2', 'op-3', 'op-4']);
});

test('undoLastDrag pops the most recent operation and clearDragHistory empties the stack', () => {
  const board = new PlanningBoard(config);
  board.recordDragOperation(dragOp('op-1'));
  board.recordDragOperation(dragOp('op-2'));

  assert.equal(board.undoLastDrag()?.taskKey, 'op-2');
  assert.deepEqual(board.getDragHistory().map((op) => op.taskKey), ['op-1']);
  assert.equal(board.undoLastDrag()?.taskKey, 'op-1');
  assert.equal(board.undoLastDrag(), null, 'undoLastDrag on an empty stack returns null');

  board.recordDragOperation(dragOp('op-3'));
  board.clearDragHistory();
  assert.deepEqual(board.getDragHistory(), []);
});
