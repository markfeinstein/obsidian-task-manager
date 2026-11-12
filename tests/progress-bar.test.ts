/**
 * Progress Bar Tests
 * Tests for calculateProgressForFile and getProgressBarStyles — the actual
 * public API of src/progress-bar-decorator.ts.  The original test file
 * imported a non-existent ProgressBarDecorator class; this rewrite targets
 * the real function-based exports.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { calculateProgressForFile, getProgressBarStyles } from '../src/progress-bar-decorator';
import { TaskScanner } from '../src/task-scanner';

function required<T>(value: T | null | undefined): T {
  assert.ok(value !== null && value !== undefined, 'Expected a parsed task or progress entry');
  return value;
}

function scanner(): TaskScanner {
  return new TaskScanner({} as never);
}

function settings() {
  return { inlineProgressBarsEnabled: true } as never;
}

// ── calculateProgressForFile ──────────────────────────────────

test('progress-bar: empty task list returns empty map', () => {
  const result = calculateProgressForFile('Test.md', [], settings);
  assert.equal(result.size, 0);
});

test('progress-bar: leaf task (no children) not included in result', () => {
  const tasks = [
    required(scanner().parseTaskLine('- [ ] Standalone', 'Test.md', 1)),
  ];
  const result = calculateProgressForFile('Test.md', tasks, settings);
  assert.equal(result.size, 0);
});

test('progress-bar: parent with children gets an entry', () => {
  const tasks = [
    required(scanner().parseTaskLine('- [ ] Parent', 'Test.md', 1)),
    required(scanner().parseTaskLine('  - [x] Child', 'Test.md', 2)),
  ];
  const result = calculateProgressForFile('Test.md', tasks, settings);
  assert.equal(result.size, 1);
  assert.ok(result.has('Test.md:1'));
});

test('progress-bar: calculates zero completion', () => {
  const tasks = [
    required(scanner().parseTaskLine('- [ ] Parent', 'Test.md', 1)),
    required(scanner().parseTaskLine('  - [ ] Child 1', 'Test.md', 2)),
    required(scanner().parseTaskLine('  - [ ] Child 2', 'Test.md', 3)),
  ];
  const result = calculateProgressForFile('Test.md', tasks, settings);
  const entry = required(result.get('Test.md:1'));
  assert.equal(entry.completed, 0);
  assert.equal(entry.total, 2);
});

test('progress-bar: calculates full completion', () => {
  const tasks = [
    required(scanner().parseTaskLine('- [ ] Parent', 'Test.md', 1)),
    required(scanner().parseTaskLine('  - [x] Child 1', 'Test.md', 2)),
    required(scanner().parseTaskLine('  - [x] Child 2', 'Test.md', 3)),
  ];
  const result = calculateProgressForFile('Test.md', tasks, settings);
  const entry = required(result.get('Test.md:1'));
  assert.equal(entry.completed, 2);
  assert.equal(entry.total, 2);
});

test('progress-bar: calculates partial completion', () => {
  const tasks = [
    required(scanner().parseTaskLine('- [ ] Parent', 'Test.md', 1)),
    required(scanner().parseTaskLine('  - [x] Child 1', 'Test.md', 2)),
    required(scanner().parseTaskLine('  - [ ] Child 2', 'Test.md', 3)),
  ];
  const result = calculateProgressForFile('Test.md', tasks, settings);
  const entry = required(result.get('Test.md:1'));
  assert.equal(entry.completed, 1);
  assert.equal(entry.total, 2);
});

test('progress-bar: cancelled children count as completed', () => {
  const tasks = [
    required(scanner().parseTaskLine('- [ ] Parent', 'Test.md', 1)),
    required(scanner().parseTaskLine('  - [-] Cancelled', 'Test.md', 2)),
    required(scanner().parseTaskLine('  - [ ] Todo',      'Test.md', 3)),
  ];
  const result = calculateProgressForFile('Test.md', tasks, settings);
  const entry = required(result.get('Test.md:1'));
  assert.equal(entry.completed, 1);
  assert.equal(entry.total, 2);
});

test('progress-bar: entry carries filePath and lineNumber', () => {
  const tasks = [
    required(scanner().parseTaskLine('- [ ] Parent', 'Notes/Test.md', 1)),
    required(scanner().parseTaskLine('  - [x] Child',  'Notes/Test.md', 2)),
  ];
  const result = calculateProgressForFile('Notes/Test.md', tasks, settings);
  const entry = required(result.get('Notes/Test.md:1'));
  assert.equal(entry.filePath, 'Notes/Test.md');
  assert.equal(entry.lineNumber, 1);
});

test('progress-bar: only counts direct children (not grandchildren)', () => {
  const tasks = [
    required(scanner().parseTaskLine('- [ ] Level 1',    'Test.md', 1)),
    required(scanner().parseTaskLine('  - [ ] Level 2',  'Test.md', 2)),
    required(scanner().parseTaskLine('    - [x] Level 3','Test.md', 3)),
  ];
  const result = calculateProgressForFile('Test.md', tasks, settings);
  // Level 1 has 1 direct child (Level 2), which is todo → completed=0
  const l1 = required(result.get('Test.md:1'));
  assert.equal(l1.total, 1);
  assert.equal(l1.completed, 0);
  // Level 2 has 1 direct child (Level 3), which is done → completed=1
  const l2 = required(result.get('Test.md:2'));
  assert.equal(l2.total, 1);
  assert.equal(l2.completed, 1);
});

test('progress-bar: multiple parents each get their own entry', () => {
  const tasks = [
    required(scanner().parseTaskLine('- [ ] Parent A', 'Test.md', 1)),
    required(scanner().parseTaskLine('  - [x] Child A', 'Test.md', 2)),
    required(scanner().parseTaskLine('- [ ] Parent B', 'Test.md', 3)),
    required(scanner().parseTaskLine('  - [ ] Child B', 'Test.md', 4)),
  ];
  const result = calculateProgressForFile('Test.md', tasks, settings);
  assert.equal(result.size, 2);
  assert.equal(required(result.get('Test.md:1')).completed, 1);
  assert.equal(required(result.get('Test.md:3')).completed, 0);
});

test('progress-bar: parent progress is line-order based even when input is unsorted', () => {
  const parent = required(scanner().parseTaskLine('- [ ] Parent', 'Test.md', 10));
  const childDone = required(scanner().parseTaskLine('  - [x] Child done', 'Test.md', 11));
  const childTodo = required(scanner().parseTaskLine('  - [ ] Child todo', 'Test.md', 12));
  const sibling = required(scanner().parseTaskLine('- [ ] Sibling root', 'Test.md', 20));

  // Simulate a caller passing tasks in a non-document sort order.
  const result = calculateProgressForFile('Test.md', [childTodo, sibling, parent, childDone], settings);

  const entry = required(result.get('Test.md:10'));
  assert.equal(entry.total, 2);
  assert.equal(entry.completed, 1);
});

test('progress-bar: handles large task list', () => {
  const tasks = [];
  tasks.push(required(scanner().parseTaskLine('- [ ] Parent', 'Test.md', 1)));
  for (let i = 0; i < 100; i++) {
    const cb = i < 50 ? '[x]' : '[ ]';
    tasks.push(required(scanner().parseTaskLine(`  - ${cb} Child ${i}`, 'Test.md', i + 2)));
  }
  const result = calculateProgressForFile('Test.md', tasks, settings);
  const entry = required(result.get('Test.md:1'));
  assert.equal(entry.total, 100);
  assert.equal(entry.completed, 50);
});

test('progress-bar: ignores tasks from other files', () => {
  // Pass tasks from two different files; only 'A.md' tasks should be considered.
  const tasksA = [
    required(scanner().parseTaskLine('- [ ] Parent', 'A.md', 1)),
    required(scanner().parseTaskLine('  - [x] Child', 'A.md', 2)),
  ];
  const tasksB = [
    required(scanner().parseTaskLine('- [ ] Parent', 'B.md', 1)),
    required(scanner().parseTaskLine('  - [ ] Child', 'B.md', 2)),
  ];
  const resultA = calculateProgressForFile('A.md', [...tasksA, ...tasksB], settings);
  // Only the A.md parent should appear
  assert.ok(resultA.has('A.md:1'));
  assert.ok(!resultA.has('B.md:1'));
});

// Pass 129 regression — cancelled children with non-x checkbox markers
// (e.g. [-]) must count as completed in calculateProgressForFile.
// The ProgressBarPlugin.extractTasksFromLines used to map everything that
// is not 'x' to 'todo', making the 'cancelled' branch in calculateProgress
// unreachable and causing the inline bar to under-count completions.
test('progress-bar: multiple cancelled children all count as completed', () => {
  const tasks = [
    required(scanner().parseTaskLine('- [ ] Parent',       'Test.md', 1)),
    required(scanner().parseTaskLine('  - [-] Cancelled 1', 'Test.md', 2)),
    required(scanner().parseTaskLine('  - [-] Cancelled 2', 'Test.md', 3)),
  ];
  const result = calculateProgressForFile('Test.md', tasks, settings);
  const entry = required(result.get('Test.md:1'));
  assert.equal(entry.total, 2);
  assert.equal(entry.completed, 2, 'both [-] children should count as completed');
});

test('progress-bar: mixed done and cancelled children count correctly', () => {
  const tasks = [
    required(scanner().parseTaskLine('- [ ] Parent',        'Test.md', 1)),
    required(scanner().parseTaskLine('  - [x] Done',         'Test.md', 2)),
    required(scanner().parseTaskLine('  - [-] Cancelled',    'Test.md', 3)),
    required(scanner().parseTaskLine('  - [ ] Open',         'Test.md', 4)),
  ];
  const result = calculateProgressForFile('Test.md', tasks, settings);
  const entry = required(result.get('Test.md:1'));
  assert.equal(entry.total, 3);
  assert.equal(entry.completed, 2, 'done + cancelled should both count');
});

// ── getProgressBarStyles ──────────────────────────────────

test('progress-bar: getProgressBarStyles returns non-empty string', () => {
  const css = getProgressBarStyles();
  assert.ok(typeof css === 'string');
  assert.ok(css.length > 0);
});

test('progress-bar: getProgressBarStyles contains progress-bar class', () => {
  const css = getProgressBarStyles();
  assert.ok(css.includes('task-manager-progress-bar'));
});

test('progress-bar: getProgressBarStyles contains container class', () => {
  const css = getProgressBarStyles();
  assert.ok(css.includes('task-manager-progress-bar-container'));
});
