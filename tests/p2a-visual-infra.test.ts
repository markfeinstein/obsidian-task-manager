import test from 'node:test';
import assert from 'node:assert/strict';
import { TFile } from 'obsidian';
import { TaskScanner } from '../src/task-scanner';
import { updateCanvasTaskCheckbox } from '../src/canvas-exporter';
import TaskManagerPlugin, { formatStatusBarNowNextText } from '../src/main';
import { TaskPanelView } from '../src/sidebar-view';
import { renderTimeline } from '../src/timeline-renderer';
import { DEFAULT_SETTINGS } from '../src/types';
import { FakeDOMElement } from './test-utils';

function scanner(app: any = { vault: {} }): TaskScanner {
  return new TaskScanner(app as never);
}

test('p2a: parses structured timeline time from alarm-style time range', () => {
  const task = scanner().parseTaskLine('- [ ] Deep work ⏰ 09:00-10:30', 'Plan.md', 1);
  assert.ok(task);
  assert.equal(task.metadata.timeStart, '09:00');
  assert.equal(task.metadata.timeEnd, '10:30');
  assert.equal(task.metadata.time, '09:00-10:30');
  assert.equal(task.normalizedText, 'Deep work');
});

test('p2a: parses structured timeline time from dataview time field', () => {
  const task = scanner().parseTaskLine('- [ ] Deep work [time:: 9:05-10:30]', 'Plan.md', 1);
  assert.ok(task);
  assert.equal(task.metadata.timeStart, '09:05');
  assert.equal(task.metadata.timeEnd, '10:30');
});

test('p2a: updateTaskDate can rewrite timeline start time without changing dates', async () => {
  const file = new TFile() as TFile & { path: string };
  file.path = 'Plan.md';
  let content = '- [ ] Deep work ⏰ 09:00-10:30 📅 2026-06-01';
  const app = {
    vault: {
      async process(_file: TFile, fn: (content: string) => string): Promise<void> {
        content = fn(content);
      },
    },
  };
  const taskScanner = scanner(app);
  const task = taskScanner.parseTaskLine(content, file.path, 1);
  assert.ok(task);

  const updated = await taskScanner.updateTaskDate(file, task, 'timeStart', '11:15');
  assert.equal(content, '- [ ] Deep work ⏰ 11:15-12:45 📅 2026-06-01');
  assert.equal(updated.metadata.timeStart, '11:15');
  assert.equal(updated.metadata.timeEnd, '12:45');
  assert.equal(updated.metadata.dates.due, '2026-06-01');
});

// renderTimeline only renders hours 06:00–23:59. A task before 06:00 must be
// available in the Unscheduled list rather than positioned above the visible grid.
test('p2a: timeline renders a pre-06:00 task as unscheduled with no negative block', () => {
  const task = scanner().parseTaskLine('- [ ] Night shift ⏰ 03:00-04:30', 'Plan.md', 1);
  assert.ok(task);
  const root = new FakeDOMElement('div');

  renderTimeline(
    root as unknown as HTMLElement,
    [task],
    {} as never,
    DEFAULT_SETTINGS,
    async () => undefined,
    () => undefined,
  );

  assert.equal(root.querySelectorAll('.task-manager-timeline-block').length, 0);
  const unscheduled = root.querySelectorAll('.task-manager-timeline-unscheduled-item');
  assert.equal(unscheduled.length, 1);
  assert.match(unscheduled[0].getInnerText(), /Night shift/u);
});

test('p2a: status bar now/next uses structured task time metadata', () => {
  const taskScanner = scanner();
  const current = taskScanner.parseTaskLine('- [ ] Deep work ⏰ 09:00-10:00 ⏳ 2026-06-15', 'Plan.md', 1);
  const next = taskScanner.parseTaskLine('- [ ] Standup ⏰ 10:30 ⏳ 2026-06-15', 'Plan.md', 2);
  assert.ok(current);
  assert.ok(next);
  assert.equal(current.normalizedText, 'Deep work');
  assert.equal(next.normalizedText, 'Standup');

  assert.equal(
    formatStatusBarNowNextText([next, current], new Date(2026, 5, 15, 9, 30), '2026-06-15'),
    '🕐 Now: Deep work | Next: Standup (10:30)',
  );
});

test('status bar widget exposes keyboard button semantics', () => {
  const element = new FakeDOMElement('div') as FakeDOMElement & { onClickEvent(callback: () => void): void };
  element.onClickEvent = (callback) => { element.listeners.set('click', callback); };
  let opened = 0;
  const plugin = Object.create(TaskManagerPlugin.prototype) as unknown as {
    settings: typeof DEFAULT_SETTINGS; statusBarItem: FakeDOMElement | null;
    addStatusBarItem(): FakeDOMElement; openTimelinePanel(): Promise<void>; initializeStatusBarWidget(): void;
  };
  plugin.settings = DEFAULT_SETTINGS; plugin.addStatusBarItem = () => element; plugin.openTimelinePanel = async () => { opened += 1; };
  plugin.initializeStatusBarWidget();
  assert.equal(element.attributes.get('role'), 'button');
  element.listeners.get('keydown')?.({ key: 'Enter', preventDefault: () => undefined } as never);
  assert.equal(opened, 1);
  (plugin as unknown as { statusBarItem: FakeDOMElement; getTaskIndex(): { getInternalTasks(): never[] } }).statusBarItem = element;
  (plugin as unknown as { getTaskIndex(): unknown }).getTaskIndex = () => ({ getInternalTasks: () => [] });
  (plugin as unknown as { updateStatusBarWidget(): void }).updateStatusBarWidget();
  assert.match(element.attributes.get('aria-label') ?? '', /Open Task Sidebar/u);
});

test('status bar scan handles unsorted current and next tasks', () => {
  const base = scanner().parseTaskLine('- [ ] Base ⏳ 2026-06-15 [time:: 09:00]', 'Plan.md', 1);
  assert.ok(base);
  const later = { ...base, normalizedText: 'Later', metadata: { ...base.metadata, timeStart: '11:00' } };
  const current = { ...base, normalizedText: 'Current', metadata: { ...base.metadata, timeStart: '09:00' } };
  const earlier = { ...base, normalizedText: 'Earlier', metadata: { ...base.metadata, timeStart: '08:00' } };
  assert.match(formatStatusBarNowNextText([later, current, earlier], new Date(2026, 5, 15, 10), '2026-06-15'), /Now: Current.*Next: Later/u);
});

test('p2a: updates checkbox in canvas text node by virtual line number', async () => {
  const file = new TFile() as TFile & { path: string };
  file.path = 'Board.canvas';
  let content = JSON.stringify({
    nodes: [
      { id: 'a', type: 'text', text: 'Intro\n- [ ] First' },
      { id: 'b', type: 'text', text: '- [ ] Second' },
    ],
    edges: [],
  });
  const app = {
    vault: {
      getAbstractFileByPath(path: string): TFile | null { return path === file.path ? file : null; },
      async process(_file: TFile, fn: (content: string) => string): Promise<void> { content = fn(content); },
    },
  };

  await updateCanvasTaskCheckbox(app as never, 'Board.canvas', 'b', 3, 'x', '- [ ] Second');
  const parsed = JSON.parse(content) as { nodes: Array<{ id: string; text: string }> };
  assert.equal(parsed.nodes[0].text, 'Intro\n- [ ] First');
  assert.equal(parsed.nodes[1].text, '- [x] Second');
});

test('p2a: rejects stale canvas checkbox writeback when task line identity changed', async () => {
  const file = new TFile() as TFile & { path: string };
  file.path = 'Board.canvas';
  let content = JSON.stringify({
    nodes: [
      { id: 'b', type: 'text', text: '- [ ] Different task' },
    ],
    edges: [],
  });
  const app = {
    vault: {
      getAbstractFileByPath(path: string): TFile | null { return path === file.path ? file : null; },
      async process(_file: TFile, fn: (content: string) => string): Promise<void> { content = fn(content); },
    },
  };

  await assert.rejects(
    updateCanvasTaskCheckbox(app as never, 'Board.canvas', 'b', 1, 'x', '- [ ] Original task'),
    /stale/u,
  );
  const parsed = JSON.parse(content) as { nodes: Array<{ id: string; text: string }> };
  assert.equal(parsed.nodes[0].text, '- [ ] Different task');
});

// Regression: Pass 145 fixed agenda bucketing to use timeStart but the time-badge
// display was left unchanged (only checked reminder). Tasks bucketed by timeStart
// appeared in the correct time slot but showed no clock badge in the list item.
test('p2a: sidebar refresh renders loading but not loaded content after close', async () => {
  const view = new TaskPanelView(
    {} as any,
    () => DEFAULT_SETTINGS,
    scanner(),
    () => ({} as any),
  );

  let resolveLoad: ((tasks: never[]) => void) | undefined;
  let renderCount = 0;
  const mutableView = view as unknown as {
    loadAllTasks: () => Promise<never[]>;
    renderView: () => void;
    refresh: () => Promise<void>;
  };
  mutableView.loadAllTasks = async () => new Promise<never[]>((resolve) => { resolveLoad = resolve; });
  mutableView.renderView = () => { renderCount += 1; };

  const refresh = mutableView.refresh();
  assert.ok(resolveLoad, 'refresh should start loading tasks');
  await view.onClose();
  resolveLoad?.([]);
  await refresh;

  assert.equal(renderCount, 1, 'only the immediate loading state should render');
});

test('p2a: renderAgendaTab shows timeStart as time badge when no reminder time is present', () => {
  const d = new Date();
  const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

  const s = scanner();
  // ⏰ parses into timeStart; 📅 sets the due date to today so the task is included
  const task = s.parseTaskLine(`- [ ] Standup ⏰ 14:00 📅 ${today}`, 'Tasks.md', 1);
  assert.ok(task, 'task should parse');
  assert.equal(task.metadata.timeStart, '14:00', 'timeStart should be set');
  assert.ok(!task.metadata.reminder?.match(/(\d{1,2}:\d{2})$/u), 'no reminder time suffix expected');

  const view = new TaskPanelView(
    {} as any,
    () => DEFAULT_SETTINGS,
    s,
    () => ({} as any),
  );

  const el = new FakeDOMElement('div');
  (view as any).renderAgendaTab(el as any, [task]);

  const timeBadges = el.querySelectorAll('.task-manager-agenda-time');
  assert.equal(timeBadges.length, 1, 'should render exactly one time badge');
  assert.equal(timeBadges[0].text, '14:00', 'time badge text should equal timeStart value');
});
