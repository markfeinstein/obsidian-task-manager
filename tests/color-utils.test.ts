import test from 'node:test';
import assert from 'node:assert/strict';
import { applyPriorityColor, applyStatusColor, getPriorityBackgroundClass, getPriorityColorClass, getStatusBackgroundClass, getStatusColorClass } from '../src/color-utils';

function elementWithClasses(...classes: string[]): HTMLElement {
  const values = new Set(classes);
  return {
    classList: {
      add: (...newClasses: string[]) => { for (const cls of newClasses) values.add(cls); },
      remove: (...oldClasses: string[]) => { for (const cls of oldClasses) values.delete(cls); },
      [Symbol.iterator]: function* () { yield* values; },
    },
  } as unknown as HTMLElement;
}

function classesOf(element: HTMLElement): string[] {
  return Array.from(element.classList).sort();
}

test('status color classes handle legacy checkbox marker aliases', () => {
  assert.equal(getStatusColorClass('X'), 'task-status-done');
  assert.equal(getStatusBackgroundClass('X'), 'task-status-bg-done');

  assert.equal(getStatusColorClass('w'), 'task-status-blocked');
  assert.equal(getStatusBackgroundClass('w'), 'task-status-bg-blocked');
  assert.equal(getStatusColorClass('W'), 'task-status-blocked');
  assert.equal(getStatusBackgroundClass('W'), 'task-status-bg-blocked');
});

test('status background classes cover waiting and deferred states', () => {
  assert.equal(getStatusColorClass('?'), 'task-status-waiting');
  assert.equal(getStatusBackgroundClass('?'), 'task-status-bg-waiting');

  assert.equal(getStatusColorClass('>'), 'task-status-deferred');
  assert.equal(getStatusBackgroundClass('>'), 'task-status-bg-deferred');
});

test('apply color helpers preserve background color classes', () => {
  const priorityElement = elementWithClasses('task-priority-low', 'task-priority-bg-high');
  applyPriorityColor(priorityElement, 'highest');
  assert.deepEqual(classesOf(priorityElement), ['task-priority-bg-high', 'task-priority-highest']);

  const statusElement = elementWithClasses('task-status-todo', 'task-status-bg-done');
  applyStatusColor(statusElement, '/');
  assert.deepEqual(classesOf(statusElement), ['task-status-bg-done', 'task-status-in-progress']);
});

test('priority and status classes fall back safely for missing values', () => {
  assert.equal(getPriorityColorClass(undefined), 'task-priority-normal');
  assert.equal(getPriorityBackgroundClass(undefined), 'task-priority-bg-normal');
  assert.equal(getStatusColorClass(undefined), 'task-status-todo');
  assert.equal(getStatusBackgroundClass(undefined), 'task-status-bg-todo');
});
