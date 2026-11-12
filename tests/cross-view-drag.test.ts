import assert from 'node:assert/strict';
import test from 'node:test';

import { setupCalendarDropZone, setupKanbanDropZone } from '../src/cross-view-drag';
import { FakeDOMElement } from './test-utils';

function makeElement(): FakeDOMElement {
  const element = new FakeDOMElement('div');
  (element as unknown as { removeEventListener: (eventName: string, listener: Function) => void }).removeEventListener = (eventName: string, listener: Function): void => {
    const current = element.listeners.get(eventName);
    if (current === listener) element.listeners.delete(eventName);
  };
  return element;
}

function dragOver(element: FakeDOMElement): void {
  const listener = element.listeners.get('dragover') as ((event: DragEvent) => void) | undefined;
  assert.ok(listener, 'dragover listener should be registered');
  const dataTransfer = { dropEffect: 'none' } as DataTransfer;
  listener({ preventDefault() {}, dataTransfer } as DragEvent);
}

function dragLeave(element: FakeDOMElement, relatedTarget: FakeDOMElement | null): void {
  const listener = element.listeners.get('dragleave') as ((event: DragEvent) => void) | undefined;
  assert.ok(listener, 'dragleave listener should be registered');
  listener({ relatedTarget } as DragEvent);
}

function dropWithData(element: FakeDOMElement, jsonData: string): void {
  const listener = element.listeners.get('drop') as ((event: DragEvent) => void) | undefined;
  assert.ok(listener, 'drop listener should be registered');
  const dataTransfer = {
    getData(type: string): string {
      if (type === 'application/task-id') return 'Tasks.md:1';
      if (type === 'text/plain') return 'Tasks.md:1';
      if (type === 'application/json') return jsonData;
      return '';
    },
  } as DataTransfer;
  listener({ preventDefault() {}, dataTransfer } as DragEvent);
}

test('cross-view-drag: calendar drop zone keeps dragover class when moving into a child element', () => {
  const element = makeElement();
  const child = element.createDiv();

  const cleanup = setupCalendarDropZone(element as unknown as HTMLElement, '2026-06-10');
  try {
    dragOver(element);
    assert.equal(element.classList.contains('task-manager-calendar-cell-dragover'), true);

    dragLeave(element, child);
    assert.equal(element.classList.contains('task-manager-calendar-cell-dragover'), true);

    dragLeave(element, null);
    assert.equal(element.classList.contains('task-manager-calendar-cell-dragover'), false);
  } finally {
    cleanup();
  }
});

test('cross-view-drag: kanban drop zone keeps dragover class when moving into a child element', () => {
  const element = makeElement();
  const child = element.createDiv();

  const cleanup = setupKanbanDropZone(element as unknown as HTMLElement, 'Doing');
  try {
    dragOver(element);
    assert.equal(element.classList.contains('task-manager-kanban-column-dragover-external'), true);

    dragLeave(element, child);
    assert.equal(element.classList.contains('task-manager-kanban-column-dragover-external'), true);

    dragLeave(element, null);
    assert.equal(element.classList.contains('task-manager-kanban-column-dragover-external'), false);
  } finally {
    cleanup();
  }
});

test('cross-view-drag: invalid JSON payload falls back to the minimal task data', () => {
  const element = makeElement();
  let received: unknown = null;

  const cleanup = setupCalendarDropZone(element as unknown as HTMLElement, '2026-06-10', async (task) => {
    received = task;
  });

  try {
    dropWithData(element, JSON.stringify({ taskKey: 123, taskText: '' }));
    assert.deepEqual(received, { taskKey: 'Tasks.md:1', taskText: 'Tasks.md:1' });
  } finally {
    cleanup();
  }
});
