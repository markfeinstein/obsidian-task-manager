import test from 'node:test';
import assert from 'node:assert/strict';
import { isInteractiveTimelineDragTarget, parseTimelineTimeRange, renderTimeline, restoreTimelineBlockPosition, shiftTimelineTime, timelinePointerCrossedThreshold, timelinePointerDropValue } from '../src/timeline-renderer';
import { TaskScanner } from '../src/task-scanner';
import { FakeDOMElement } from './test-utils';
import { installDomHarness } from './dom-harness';
import { DEFAULT_SETTINGS, DEFAULT_TASK_STATES } from '../src/types';
import type { TaskManagerSettings } from '../src/types';
import type { TaskQuery } from '../src/task-query';
import type { Component } from 'obsidian';

test('timeline renderer: parses valid visible-grid time ranges', () => {
  assert.deepEqual(parseTimelineTimeRange('Plan sprint 09:15 - 10:45'), {
    startHour: 9,
    startMin: 15,
    endHour: 10,
    endMin: 45,
  });
});

test('timeline renderer: keyboard time shifts stay inside the visible grid', () => {
  assert.equal(shiftTimelineTime(9, 0, 15), '09:15');
  assert.equal(shiftTimelineTime(6, 0, -15), null);
  assert.equal(shiftTimelineTime(23, 50, 15), null);
});

test('timeline renderer: rejects starts outside the visible grid', () => {
  assert.equal(parseTimelineTimeRange('Early task 05:30 - 06:30'), null);
  assert.equal(parseTimelineTimeRange('Invalid minute 09:99'), null);
});

test('timeline renderer: ignores invalid end times instead of returning unsafe ranges', () => {
  assert.deepEqual(parseTimelineTimeRange('Meet 09:30 - 99:99'), {
    startHour: 9,
    startMin: 30,
  });
  assert.deepEqual(parseTimelineTimeRange('Meet 09:30 - 08:30'), {
    startHour: 9,
    startMin: 30,
  });
});

test('timeline renderer: pointer drag policy excludes child controls and no-op movement', () => {
  const block = {} as HTMLElement;
  const interactive = { closest: () => ({}) } as unknown as EventTarget;
  const plain = { closest: () => null } as unknown as EventTarget;
  assert.equal(isInteractiveTimelineDragTarget(block, block), false);
  assert.equal(isInteractiveTimelineDragTarget(interactive, block), true);
  assert.equal(isInteractiveTimelineDragTarget(plain, block), false);
  assert.equal(timelinePointerCrossedThreshold(100, 103), false);
  assert.equal(timelinePointerCrossedThreshold(100, 104), true);

  const original = 9 * 60;
  assert.equal(timelinePointerDropValue(120, 0, original), null, 'dropping at 09:00 must not write');
  const changed = timelinePointerDropValue(130, 0, original);
  assert.equal(changed, '09:15');
  let calls = 0;
  for (const value of [timelinePointerDropValue(120, 0, original), changed]) {
    if (value) calls += 1;
  }
  assert.equal(calls, 1, 'only the changed-time drop produces a write candidate');

  let restored = '';
  restoreTimelineBlockPosition({ style: { setProperty: (_name: string, value: string) => { restored = value; } } as CSSStyleDeclaration }, '180px');
  assert.equal(restored, '180px', 'cancelled or rejected drags restore their original visual position');
});

test('timeline renderer: unscheduled checkboxes include their task in the accessible name', () => {
  const scanner = new TaskScanner({} as never);
  const task = scanner.parseTaskLine('- [ ] Review launch checklist', 'Test.md', 1);
  assert.ok(task);
  const root = new FakeDOMElement('div');
  const query: TaskQuery = { filters: [], sort: [], groups: [], layout: { hidden: new Set(), shown: new Set() }, explain: false, errors: [], instructions: [] };
  renderTimeline(root as unknown as HTMLElement, [task], query, { supportedStates: DEFAULT_TASK_STATES } as TaskManagerSettings, async () => undefined, () => undefined);
  const findInput = (node: FakeDOMElement): FakeDOMElement | undefined => {
    if (node.tagName === 'input') return node;
    for (const child of node.children) if (child instanceof FakeDOMElement) {
      const found = findInput(child);
      if (found) return found;
    }
    return undefined;
  };
  assert.equal(findInput(root)?.getAttr('aria-label'), 'Mark Review launch checklist complete');
});

test('timeline renderer: pointer drag crosses threshold and reschedules through document listeners', async (context) => {
  const harness = installDomHarness();
  const originalAbortController = globalThis.AbortController;
  globalThis.AbortController = harness.window.AbortController;
  context.after(() => { globalThis.AbortController = originalAbortController; harness.cleanup(); });
  const scanner = new TaskScanner({} as never);
  const task = scanner.parseTaskLine('- [ ] Planning session 09:00 - 10:00', 'Test.md', 1);
  assert.ok(task);
  task.metadata.timeStart = '09:00';
  task.metadata.timeEnd = '10:00';
  const root = harness.document.createElement('div');
  harness.document.body.appendChild(root);
  const query: TaskQuery = { filters: [], sort: [], groups: [], layout: { hidden: new Set(), shown: new Set() }, explain: false, errors: [], instructions: [] };
  let nextTime = '';
  renderTimeline(root, [task], query, { ...DEFAULT_SETTINGS, supportedStates: DEFAULT_TASK_STATES }, async () => undefined, () => undefined, async (_task, _field, value) => { nextTime = value; });
  const grid = root.querySelector<HTMLElement>('.task-manager-timeline-grid');
  const block = root.querySelector<HTMLElement>('.task-manager-timeline-block');
  const timeInput = root.querySelector<HTMLInputElement>('.task-manager-timeline-reschedule-input');
  assert.ok(grid && block && timeInput);
  assert.match(timeInput.getAttribute('aria-label') ?? '', /Planning session/u);
  timeInput.value = '10:15';
  timeInput.dispatchEvent(new harness.window.Event('change', { bubbles: true }));
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(nextTime, '10:15');
  nextTime = '';
  grid.getBoundingClientRect = () => ({ top: 0, left: 0, right: 600, bottom: 1000, width: 600, height: 1000, x: 0, y: 0, toJSON: () => ({}) });
  const pointer = (type: string, clientY: number): Event => {
    const event = new harness.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, { button: { value: 0 }, pointerId: { value: 7 }, clientY: { value: clientY } });
    return event;
  };
  block.dispatchEvent(pointer('pointerdown', 180));
  harness.document.dispatchEvent(pointer('pointermove', 210));
  harness.document.dispatchEvent(pointer('pointerup', 240));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.notEqual(nextTime, '');
});

test('timeline renderer: registers cleanup with component to prevent listener leaks', () => {
  const scanner = new TaskScanner({} as never);
  const el = new FakeDOMElement('div');
  const settings: TaskManagerSettings = {
    supportedStates: DEFAULT_TASK_STATES,
  } as unknown as TaskManagerSettings;

  const task = scanner.parseTaskLine(
    `- [ ] Meeting 09:00 - 10:00`,
    'Test.md',
    1,
  )!;
  task.metadata.timeStart = '09:00';
  task.metadata.timeEnd = '10:00';

  const query: TaskQuery = {
    filters: [],
    sort: [],
    groups: [],
    layout: { hidden: new Set(), shown: new Set() },
    explain: false,
    errors: [],
    instructions: [],
  };

  let cleanupRegistered = false;
  const fakeComponent = {
    register: (cb: () => void) => {
      cleanupRegistered = true;
      // Verify cleanup callback is a function
      assert.equal(typeof cb, 'function', 'cleanup callback should be a function');
    },
  } as unknown as Component;

  const noop = async () => {};
  const noopEdit = () => {};
  const onReschedule = async () => {};

  renderTimeline(
    el as any,
    [task],
    query,
    settings,
    noop,
    noopEdit,
    onReschedule,
    undefined,
    undefined,
    undefined,
    undefined,
    fakeComponent,
  );

  assert.equal(
    cleanupRegistered,
    true,
    'component.register() should be called to register drag listener cleanup',
  );
});

test('timeline renderer: clears previous markup before rerendering into the same container', () => {
  const scanner = new TaskScanner({} as never);
  const el = new FakeDOMElement('div');
  const settings: TaskManagerSettings = {
    supportedStates: DEFAULT_TASK_STATES,
  } as unknown as TaskManagerSettings;

  const task = scanner.parseTaskLine(
    `- [ ] Meeting 09:00 - 10:00`,
    'Test.md',
    1,
  )!;
  task.metadata.timeStart = '09:00';
  task.metadata.timeEnd = '10:00';

  const query: TaskQuery = {
    filters: [],
    sort: [],
    groups: [],
    layout: { hidden: new Set(), shown: new Set() },
    explain: false,
    errors: [],
    instructions: [],
  };

  const noop = async () => {};
  const noopEdit = () => {};

  renderTimeline(el as any, [task], query, settings, noop, noopEdit);
  renderTimeline(el as any, [task], query, settings, noop, noopEdit);

  assert.equal(el.querySelectorAll('.task-manager-timeline-toolbar').length, 1);
  assert.equal(el.querySelectorAll('.task-manager-timeline-grid').length, 1);
});
