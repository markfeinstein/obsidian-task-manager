import test from 'node:test';
import assert from 'node:assert/strict';
import { buildIcsDayMap, renderCalendar, type CalendarIcsEvent } from '../src/calendar-renderer';
import { DEFAULT_TASK_STATES } from '../src/types';
import type { TaskManagerSettings } from '../src/types';
import type { TaskQuery } from '../src/task-query';
import { FakeDOMElement, FakeDOMTextNode, createMockTask, getTodayString } from './test-utils';

function emptyQuery(): TaskQuery {
  return {
    filters: [],
    sort: [],
    groups: [],
    layout: { hidden: new Set(), shown: new Set() },
    explain: false,
    errors: [],
    instructions: [],
  };
}

const testSettings: TaskManagerSettings = {
  supportedStates: DEFAULT_TASK_STATES,
} as unknown as TaskManagerSettings;

const noopToggle = async () => {};
const noopEdit = () => {};

function addDays(dateStr: string, days: number): string {
  const [y, m, d] = dateStr.split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  date.setUTCDate(date.getUTCDate() + days);
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

test('calendar renderer: groups ICS overlay events by date', () => {
  const events: CalendarIcsEvent[] = [
    { summary: 'Standup', date: '2026-05-29', startTime: '09:00', uid: 'a' },
    { summary: 'Planning', date: '2026-05-29T13:00:00', uid: 'b' },
    { summary: 'Undated', date: null, uid: 'c' },
  ];

  const map = buildIcsDayMap(events);

  assert.equal(map.get('2026-05-29')?.length, 2);
  assert.equal(map.has(''), false);
});

test('calendar renderer: preserves view mode across rerenders of the same element', () => {
  const el = new FakeDOMElement('div');

  renderCalendar(el as any, [], emptyQuery(), testSettings, noopToggle, noopEdit);

  const buttons = el.querySelectorAll('.task-manager-calendar-mode-btn');
  assert.equal(buttons.length, 4, 'expected month/week/day/list toggle buttons');
  assert.ok(buttons[0].classes.includes('is-active'), 'month should be active by default');

  const weekClick = buttons[1].listeners.get('click');
  assert.ok(typeof weekClick === 'function', 'week button should have a click handler');
  weekClick();

  const afterToggle = el.querySelectorAll('.task-manager-calendar-mode-btn');
  assert.equal(afterToggle[1].classes.includes('is-active'), true, 'week should be active after click');
  assert.equal(afterToggle[0].classes.includes('is-active'), false, 'month should no longer be active');

  renderCalendar(el as any, [], emptyQuery(), testSettings, noopToggle, noopEdit);

  const afterRerender = el.querySelectorAll('.task-manager-calendar-mode-btn');
  assert.equal(afterRerender[1].classes.includes('is-active'), true, 'week should remain active after rerender');
  assert.equal(afterRerender[0].classes.includes('is-active'), false, 'month should stay inactive after rerender');
});

test('calendar renderer: renders Day view for selectedDate instead of viewWeekStart', () => {
  const el = new FakeDOMElement('div');

  // Render month view first to set a selectedDate
  renderCalendar(el as any, [], emptyQuery(), testSettings, noopToggle, noopEdit);

  // Set day view
  const buttons = el.querySelectorAll('.task-manager-calendar-mode-btn');
  const dayClick = buttons[2].listeners.get('click');
  if (typeof dayClick === 'function') dayClick();

  // Find the header inside day view
  const dayHeaders = el.querySelectorAll('.task-manager-calendar-week-daynum');

  // By default, selectedDate is today. The header should match today, not necessarily the week start.
  assert.equal(dayHeaders.length, 1, 'Day view should have exactly one day column header');
});

test('calendar renderer: day view next navigation advances the selected date', () => {
  const el = new FakeDOMElement('div');
  renderCalendar(el as any, [], emptyQuery(), testSettings, noopToggle, noopEdit);

  const buttons = el.querySelectorAll('.task-manager-calendar-mode-btn');
  const dayClick = buttons[2].listeners.get('click');
  assert.equal(typeof dayClick, 'function', 'day button should have a click handler');
  dayClick?.();

  const initialHeader = el.querySelectorAll('.task-manager-calendar-week-daynum')[0];
  assert.ok(initialHeader, 'day view should render a selected date header');
  const initialDate = initialHeader.text;

  const navButtons = el.querySelectorAll('.task-manager-calendar-nav-btn');
  const nextClick = navButtons[1]?.listeners.get('click');
  assert.equal(typeof nextClick, 'function', 'next navigation button should have a click handler');
  nextClick?.();

  const nextHeader = el.querySelectorAll('.task-manager-calendar-week-daynum')[0];
  assert.ok(nextHeader, 'day view should still render a selected date header after navigation');
  assert.equal(nextHeader.text, addDays(initialDate, 1), 'next navigation should advance the day view to the next selected date');
});

test('calendar renderer: clicking outside an open overflow popover closes it', () => {
  const el = new FakeDOMElement('div');
  const body = new FakeDOMElement('body');
  const documentListeners = new Map<string, Function>();
  const today = getTodayString();
  const base = createMockTask();
  const tasks = [
    createMockTask({ key: 'a', lineNumber: 1, filePath: 'Tasks.md', normalizedText: 'Task A', metadata: { ...base.metadata, dates: { ...base.metadata.dates, due: today } } }),
    createMockTask({ key: 'b', lineNumber: 2, filePath: 'Tasks.md', normalizedText: 'Task B', metadata: { ...base.metadata, dates: { ...base.metadata.dates, due: today } } }),
    createMockTask({ key: 'c', lineNumber: 3, filePath: 'Tasks.md', normalizedText: 'Task C', metadata: { ...base.metadata, dates: { ...base.metadata.dates, due: today } } }),
    createMockTask({ key: 'd', lineNumber: 4, filePath: 'Tasks.md', normalizedText: 'Task D', metadata: { ...base.metadata, dates: { ...base.metadata.dates, due: today } } }),
  ];

  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: (tagName: string) => new FakeDOMElement(tagName),
    createTextNode: (textContent: string) => new FakeDOMTextNode(textContent),
    body,
    addEventListener: (eventName: string, listener: Function) => {
      documentListeners.set(eventName, listener);
    },
    removeEventListener: () => undefined,
  } as never;

  try {
    renderCalendar(el as any, tasks, emptyQuery(), testSettings, noopToggle, noopEdit);

    const moreChip = el.querySelectorAll('.task-manager-calendar-chip-more')[0];
    assert.ok(moreChip, 'month view should render an overflow chip for four tasks on one day');
    moreChip.listeners.get('click')?.({ stopPropagation: () => undefined });
    assert.equal(body.children.length, 1, 'popover should be appended when the overflow chip is clicked');

    const outsideTarget = new FakeDOMElement('div');
    documentListeners.get('click')?.({ target: outsideTarget });

    assert.equal(body.children.length, 0, 'outside document click should dismiss the calendar popover');
  } finally {
    globalThis.document = originalDocument;
  }
});

test('calendar renderer: returned disposer removes an open overflow popover', () => {
  const el = new FakeDOMElement('div');
  const body = new FakeDOMElement('body');
  const today = getTodayString();
  const base = createMockTask();
  const tasks = [
    createMockTask({ key: 'a', lineNumber: 1, filePath: 'Tasks.md', normalizedText: 'Task A', metadata: { ...base.metadata, dates: { ...base.metadata.dates, due: today } } }),
    createMockTask({ key: 'b', lineNumber: 2, filePath: 'Tasks.md', normalizedText: 'Task B', metadata: { ...base.metadata, dates: { ...base.metadata.dates, due: today } } }),
    createMockTask({ key: 'c', lineNumber: 3, filePath: 'Tasks.md', normalizedText: 'Task C', metadata: { ...base.metadata, dates: { ...base.metadata.dates, due: today } } }),
    createMockTask({ key: 'd', lineNumber: 4, filePath: 'Tasks.md', normalizedText: 'Task D', metadata: { ...base.metadata, dates: { ...base.metadata.dates, due: today } } }),
  ];

  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: (tagName: string) => new FakeDOMElement(tagName),
    createTextNode: (textContent: string) => new FakeDOMTextNode(textContent),
    body,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as never;

  try {
    const dispose = renderCalendar(el as any, tasks, emptyQuery(), testSettings, noopToggle, noopEdit);
    const moreChip = el.querySelectorAll('.task-manager-calendar-chip-more')[0];
    moreChip.listeners.get('click')?.({ stopPropagation: () => undefined });
    assert.equal(body.children.length, 1, 'popover should be appended when the overflow chip is clicked');

    dispose();

    assert.equal(body.children.length, 0, 'disposer should remove the body-level popover');
  } finally {
    globalThis.document = originalDocument;
  }
});

test('calendar renderer: month agenda buttons can open the day view', () => {
  const el = new FakeDOMElement('div');
  renderCalendar(el as any, [], emptyQuery(), testSettings, noopToggle, noopEdit);

  const agendaAction = el.querySelectorAll('.task-manager-calendar-agenda-action').find((button) => button.text === 'Open day');
  assert.ok(agendaAction, 'month agenda should expose an Open day action');
  agendaAction.listeners.get('click')?.();

  const dayHeaders = el.querySelectorAll('.task-manager-calendar-week-daynum');
  assert.equal(dayHeaders.length, 1, 'Open day should switch the calendar into day view');
});

test('calendar renderer: month agenda can step between days', () => {
  const el = new FakeDOMElement('div');
  renderCalendar(el as any, [], emptyQuery(), testSettings, noopToggle, noopEdit);

  const agendaHeader = el.querySelectorAll('.task-manager-calendar-agenda-date')[0];
  assert.ok(agendaHeader, 'month agenda should render a selected date header');
  const initialDate = agendaHeader.text;

  const nextDay = el.querySelectorAll('.task-manager-calendar-agenda-action--nav')[1];
  assert.ok(nextDay, 'month agenda should render next-day navigation');
  nextDay.listeners.get('click')?.();

  const afterHeader = el.querySelectorAll('.task-manager-calendar-agenda-date')[0];
  assert.equal(afterHeader.text, addDays(initialDate, 1), 'next-day navigation should advance the agenda date');
});

test('calendar renderer: month agenda exposes a named task creation action', () => {
  const el = new FakeDOMElement('div');
  let createdFor: string | undefined;
  renderCalendar(el as unknown as HTMLElement, [], emptyQuery(), testSettings, noopToggle, noopEdit, (date) => { createdFor = date; });

  const addTask = el.querySelectorAll('.task-manager-calendar-agenda-action').find((button) => button.text === 'Add task');
  assert.ok(addTask);
  assert.match(addTask.attributes.get('aria-label') ?? '', /^Add task for \d{4}-\d{2}-\d{2}$/u);
  addTask.listeners.get('click')?.();
  assert.match(createdFor ?? '', /^\d{4}-\d{2}-\d{2}$/u);
  assert.equal(el.querySelectorAll('.task-manager-calendar-day-num-clickable').length, 0);
});

test('calendar renderer: keeps drop highlight when drag leaves into a child element', () => {
  const el = new FakeDOMElement('div');
  const tasks = [createMockTask()];
  const noopReschedule = async () => {};

  renderCalendar(el as any, tasks, emptyQuery(), testSettings, noopToggle, noopEdit, undefined, noopReschedule);

  const dayCell = el.querySelectorAll('.task-manager-calendar-day')
    .find((cell) => !cell.classes.includes('task-manager-calendar-day-blank'));
  assert.ok(dayCell, 'expected a non-blank calendar day cell');

  dayCell.listeners.get('dragover')?.({
    preventDefault: () => undefined,
    dataTransfer: { dropEffect: 'move' },
  });
  assert.ok(dayCell.classes.includes('task-manager-calendar-drop-target'), 'dragover should add drop-target highlight');

  const childTarget = dayCell.children.find((child): child is FakeDOMElement => child instanceof FakeDOMElement);
  assert.ok(childTarget, 'expected calendar cell to have a child element');

  dayCell.listeners.get('dragleave')?.({ relatedTarget: childTarget });
  assert.ok(dayCell.classes.includes('task-manager-calendar-drop-target'), 'moving into a child should keep the highlight');

  dayCell.listeners.get('dragleave')?.({ relatedTarget: null });
  assert.equal(dayCell.classes.includes('task-manager-calendar-drop-target'), false, 'leaving the cell should clear the highlight');
});

function findElementsByTag(root: FakeDOMElement, tagName: string): FakeDOMElement[] {
  const results: FakeDOMElement[] = [];
  const visit = (node: FakeDOMElement): void => {
    if (node.tagName === tagName) results.push(node);
    for (const child of node.children) {
      if (child instanceof FakeDOMElement) visit(child);
    }
  };
  visit(root);
  return results;
}

test('calendar renderer: month agenda checkbox click toggles the task instead of being purely visual', () => {
  const el = new FakeDOMElement('div');
  const today = getTodayString();
  const base = createMockTask();
  const agendaTask = createMockTask({
    key: 'agenda-task',
    normalizedText: 'Agenda task',
    metadata: { ...base.metadata, dates: { ...base.metadata.dates, due: today } },
  });

  let toggled: unknown = null;
  const onToggle = async (task: unknown) => { toggled = task; };

  renderCalendar(el as any, [agendaTask], emptyQuery(), testSettings, onToggle, noopEdit);

  const checkbox = findElementsByTag(el, 'input').find((input) => input.getAttr('aria-label')?.startsWith('Mark task as'));
  assert.ok(checkbox, 'month agenda should render a checkbox for a task scheduled today');
  assert.equal(checkbox.checked, false, 'todo task checkbox should start unchecked');

  let prevented = false;
  checkbox.listeners.get('click')?.({ preventDefault: () => { prevented = true; }, stopPropagation: () => undefined });

  assert.equal(prevented, true, 'click should be prevented so the visual state follows the eventual rerender, not the native toggle');
  assert.equal((toggled as { key: string } | null)?.key, 'agenda-task', 'clicking the checkbox should call onToggle with the agenda task');
});

test('calendar renderer: task text is a native edit button and all undated tasks can be revealed', () => {
  const el = new FakeDOMElement('div');
  const today = getTodayString();
  const base = createMockTask();
  const dated = createMockTask({
    key: 'dated',
    normalizedText: 'Keyboard editable task',
    metadata: { ...base.metadata, dates: { ...base.metadata.dates, due: today } },
  });
  const undated = Array.from({ length: 10 }, (_, index) => createMockTask({
    key: `undated-${index}`,
    lineNumber: index + 2,
    normalizedText: `Undated task ${index + 1}`,
    metadata: { ...base.metadata, dates: {} },
  }));
  let edited: string | null = null;

  renderCalendar(el as unknown as HTMLElement, [dated, ...undated], emptyQuery(), testSettings, noopToggle, (task) => { edited = task.key; });

  const agendaButton = el.querySelectorAll('.task-manager-calendar-agenda-text')[0];
  assert.equal(agendaButton?.tagName, 'button');
  assert.equal(agendaButton?.getAttr('type'), 'button');
  assert.equal(agendaButton?.getAttr('aria-label'), 'Edit Keyboard editable task');
  agendaButton?.listeners.get('click')?.();
  assert.equal(edited, 'dated');

  const showAll = el.querySelectorAll('.task-manager-calendar-chip-more')
    .find((element) => element.getAttr('aria-label') === 'Show 2 more of 10 undated tasks');
  assert.ok(showAll, 'undated section should expose a Show all button');
  showAll.listeners.get('click')?.();
  assert.equal(el.querySelectorAll('.task-manager-calendar-undated')[0]?.querySelectorAll('.task-manager-calendar-chip').length, 10);
});
