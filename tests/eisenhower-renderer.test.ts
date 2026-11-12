/**
 * Eisenhower Renderer Tests
 * Focuses on DOM structure and ordering (regression for grid-after-legend bug).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { renderEisenhower } from '../src/eisenhower-renderer';
import { TaskScanner } from '../src/task-scanner';
import { FakeDOMElement } from './test-utils';
import { DEFAULT_TASK_STATES } from '../src/types';
import type { TaskManagerSettings } from '../src/types';
import type { TaskQuery } from '../src/task-query';

function scanner(): TaskScanner {
  return new TaskScanner({} as never);
}

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

const testSettings: TaskManagerSettings = {
  supportedStates: DEFAULT_TASK_STATES,
  eisenhowerQuadrants: undefined,
} as unknown as TaskManagerSettings;

const noop = async () => {};
const noopEdit = () => {};

// ── DOM ordering ─────────────────────────────────────────────────

test('eisenhower: legend stays below matrix grid after filter re-render', () => {
  const el = new FakeDOMElement('div');

  // One high-priority overdue task so Q1 is non-empty
  const task = scanner().parseTaskLine(
    `- [ ] Overdue important task 🔺 📅 2020-01-01`,
    'Test.md',
    1,
  )!;
  assert.ok(task);

  renderEisenhower(el as any, [task], emptyQuery(), testSettings, noop, noopEdit);

  // After initial render: toolbar, matrixContainer, legend — in that order.
  // FakeDOMElement.addClass may add a class string with spaces as one entry;
  // use a flat-join approach to check class membership.
  const topChildren = el.children.filter((c): c is FakeDOMElement => c instanceof FakeDOMElement);
  assert.ok(topChildren.length >= 3, `expected ≥3 top-level children, got ${topChildren.length}`);

  const lastChildClasses = topChildren[topChildren.length - 1].classes.join(' ');
  assert.ok(
    lastChildClasses.includes('task-manager-eisenhower-legend'),
    `last top-level child should be legend after initial render, got classes: ${lastChildClasses}`,
  );

  // Simulate clicking the "Clear Filter" button to trigger a re-render.
  // The clear-filter button is the first <button> child of the toolbar.
  const toolbar = topChildren[0];
  const clearBtn = toolbar.children.find(
    (c): c is FakeDOMElement =>
      c instanceof FakeDOMElement && c.tagName === 'button',
  );
  assert.ok(clearBtn, 'clear filter button should exist in toolbar');

  const clickHandler = clearBtn.listeners.get('click');
  assert.ok(typeof clickHandler === 'function', 'clear filter button should have a click handler');
  clickHandler();

  // After re-render the legend must still be the last top-level child —
  // not displaced by the newly-created grid element.
  const topChildrenAfter = el.children.filter(
    (c): c is FakeDOMElement => c instanceof FakeDOMElement,
  );
  const lastAfterClasses = topChildrenAfter[topChildrenAfter.length - 1].classes.join(' ');
  assert.ok(
    lastAfterClasses.includes('task-manager-eisenhower-legend'),
    `last top-level child should still be legend after re-render, got classes: ${lastAfterClasses}`,
  );

  // The matrix container must be the second child (index 1), still above legend.
  const matrixContainer = topChildrenAfter[1];
  const matrixContainerClasses = matrixContainer.classes.join(' ');
  assert.ok(
    matrixContainerClasses.includes('task-manager-eisenhower-matrix-container'),
    `index-1 child should be matrix container, got classes: ${matrixContainerClasses}`,
  );
});

test('eisenhower: renders all four quadrant cells', () => {
  const el = new FakeDOMElement('div');
  renderEisenhower(el as any, [], emptyQuery(), testSettings, noop, noopEdit);

  // querySelectorAll requires a CSS-selector dot prefix for class selectors
  const q1 = el.querySelectorAll('.task-manager-eisenhower-q1');
  const q4 = el.querySelectorAll('.task-manager-eisenhower-q4');
  assert.equal(q1.length, 1, 'Q1 cell should be rendered');
  assert.equal(q4.length, 1, 'Q4 cell should be rendered');
});

test('eisenhower: quadrant header filters to the selected quadrant and clear restores all quadrants', () => {
  const el = new FakeDOMElement('div');
  renderEisenhower(el as any, [], emptyQuery(), testSettings, noop, noopEdit);

  const q1Header = el.querySelectorAll('.task-manager-eisenhower-q1')[0]
    .querySelectorAll('.task-manager-eisenhower-header')[0];
  const clickHandler = q1Header.listeners.get('click');
  assert.ok(clickHandler, 'Q1 header should have a click handler');

  clickHandler();

  assert.equal(el.querySelectorAll('.task-manager-eisenhower-q1').length, 1, 'selected Q1 should remain visible');
  assert.equal(el.querySelectorAll('.task-manager-eisenhower-q2').length, 0, 'unselected Q2 should be hidden');
  assert.equal(el.querySelectorAll('.task-manager-eisenhower-q3').length, 0, 'unselected Q3 should be hidden');
  assert.equal(el.querySelectorAll('.task-manager-eisenhower-q4').length, 0, 'unselected Q4 should be hidden');

  const clearBtn = el.querySelectorAll('.task-manager-eisenhower-clear-btn')[0];
  const clearHandler = clearBtn.listeners.get('click');
  assert.ok(clearHandler, 'clear button should have a click handler');

  clearHandler();

  assert.equal(el.querySelectorAll('.task-manager-eisenhower-q1').length, 1, 'Q1 should be visible after clear');
  assert.equal(el.querySelectorAll('.task-manager-eisenhower-q2').length, 1, 'Q2 should be visible after clear');
  assert.equal(el.querySelectorAll('.task-manager-eisenhower-q3').length, 1, 'Q3 should be visible after clear');
  assert.equal(el.querySelectorAll('.task-manager-eisenhower-q4').length, 1, 'Q4 should be visible after clear');
});
