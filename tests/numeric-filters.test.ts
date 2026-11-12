/**
 * Numeric Query Filters Tests
 * Tests for effort/actual/cost numeric comparisons and cross-field filters
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { filterTasks } from '../src/task-query';
import { TaskScanner } from '../src/task-scanner';

function scanner(): TaskScanner {
  return new TaskScanner({} as never);
}

// ── Effort Filters ────────────────────────────────────────────────────────

test('numeric filters: effort greater than', () => {
  const s = scanner();
  const tasks = [
    s.parseTaskLine('- [ ] Long task ⏱️ 2h', 'A.md', 1)!,
    s.parseTaskLine('- [ ] Short task ⏱️ 30m', 'A.md', 2)!,
  ];
  
  const result = filterTasks(tasks, 'effort > 1h');
  assert.deepEqual(result.map((t) => t.normalizedText), ['Long task']);
});

test('numeric filters: effort less than', () => {
  const s = scanner();
  const tasks = [
    s.parseTaskLine('- [ ] Long task ⏱️ 2h', 'A.md', 1)!,
    s.parseTaskLine('- [ ] Short task ⏱️ 30m', 'A.md', 2)!,
  ];
  
  const result = filterTasks(tasks, 'effort < 1h');
  assert.deepEqual(result.map((t) => t.normalizedText), ['Short task']);
});

test('numeric filters: effort greater or equal', () => {
  const s = scanner();
  const tasks = [
    s.parseTaskLine('- [ ] Task A ⏱️ 2h', 'A.md', 1)!,
    s.parseTaskLine('- [ ] Task B ⏱️ 1h', 'A.md', 2)!,
    s.parseTaskLine('- [ ] Task C ⏱️ 30m', 'A.md', 3)!,
  ];
  
  const result = filterTasks(tasks, 'effort >= 1h');
  assert.deepEqual(result.map((t) => t.normalizedText), ['Task A', 'Task B']);
});

test('numeric filters: effort less or equal', () => {
  const s = scanner();
  const tasks = [
    s.parseTaskLine('- [ ] Task A ⏱️ 2h', 'A.md', 1)!,
    s.parseTaskLine('- [ ] Task B ⏱️ 1h', 'A.md', 2)!,
    s.parseTaskLine('- [ ] Task C ⏱️ 30m', 'A.md', 3)!,
  ];
  
  const result = filterTasks(tasks, 'effort <= 1h');
  assert.deepEqual(result.map((t) => t.normalizedText), ['Task B', 'Task C']);
});

test('numeric filters: effort equals', () => {
  const s = scanner();
  const tasks = [
    s.parseTaskLine('- [ ] Task A ⏱️ 2h', 'A.md', 1)!,
    s.parseTaskLine('- [ ] Task B ⏱️ 1h', 'A.md', 2)!,
  ];
  
  const result = filterTasks(tasks, 'effort = 2h');
  assert.deepEqual(result.map((t) => t.normalizedText), ['Task A']);
});

// ── Actual Time Filters ───────────────────────────────────────────────────

test('numeric filters: actual less than', () => {
  const s = scanner();
  const tasks = [
    s.parseTaskLine('- [x] Long task ⏱️ 2h 🕐 90m', 'A.md', 1)!,
    s.parseTaskLine('- [x] Short task ⏱️ 20m 🕐 25m', 'A.md', 2)!,
  ];
  
  const result = filterTasks(tasks, 'actual less than 30m');
  assert.deepEqual(result.map((t) => t.normalizedText), ['Short task']);
});

test('numeric filters: actual greater than', () => {
  const s = scanner();
  const tasks = [
    s.parseTaskLine('- [x] Task A ⏱️ 1h 🕐 2h', 'A.md', 1)!,
    s.parseTaskLine('- [x] Task B ⏱️ 2h 🕐 90m', 'A.md', 2)!,
  ];
  
  const result = filterTasks(tasks, 'actual above 100m');
  assert.deepEqual(result.map((t) => t.normalizedText), ['Task A']);
});

// ── Cost Filters ─────────────────────────────────────────────────────────

test('numeric filters: cost greater than', () => {
  const s = scanner();
  const tasks = [
    s.parseTaskLine('- [ ] Expensive 💰 150', 'A.md', 1)!,
    s.parseTaskLine('- [ ] Cheap 💰 50', 'A.md', 2)!,
  ];
  
  const result = filterTasks(tasks, 'cost > 100');
  assert.deepEqual(result.map((t) => t.normalizedText), ['Expensive']);
});

test('numeric filters: cost less than', () => {
  const s = scanner();
  const tasks = [
    s.parseTaskLine('- [ ] Expensive 💰 150', 'A.md', 1)!,
    s.parseTaskLine('- [ ] Cheap 💰 50', 'A.md', 2)!,
  ];
  
  const result = filterTasks(tasks, 'cost < 100');
  assert.deepEqual(result.map((t) => t.normalizedText), ['Cheap']);
});

// ── Cross-Field Comparisons ──────────────────────────────────────────────

test('numeric filters: actual greater than effort (underestimated)', () => {
  const s = scanner();
  const tasks = [
    s.parseTaskLine('- [x] Underestimated ⏱️ 1h 🕐 3h', 'A.md', 1)!,
    s.parseTaskLine('- [x] Accurate ⏱️ 2h 🕐 2h', 'A.md', 2)!,
    s.parseTaskLine('- [x] Overestimated ⏱️ 3h 🕐 1h', 'A.md', 3)!,
  ];
  
  const result = filterTasks(tasks, 'actual > effort');
  assert.deepEqual(result.map((t) => t.normalizedText), ['Underestimated']);
});

test('numeric filters: actual less than effort (overestimated)', () => {
  const s = scanner();
  const tasks = [
    s.parseTaskLine('- [x] Underestimated ⏱️ 1h 🕐 3h', 'A.md', 1)!,
    s.parseTaskLine('- [x] Accurate ⏱️ 2h 🕐 2h', 'A.md', 2)!,
    s.parseTaskLine('- [x] Overestimated ⏱️ 3h 🕐 1h', 'A.md', 3)!,
  ];
  
  const result = filterTasks(tasks, 'actual < effort');
  assert.deepEqual(result.map((t) => t.normalizedText), ['Overestimated']);
});

test('numeric filters: effort equals effort (reflexive)', () => {
  const s = scanner();
  const tasks = [
    s.parseTaskLine('- [ ] Task A ⏱️ 2h', 'A.md', 1)!,
  ];
  
  const result = filterTasks(tasks, 'effort = effort');
  assert.deepEqual(result.map((t) => t.normalizedText), ['Task A']);
});

// ── Variance Filters ─────────────────────────────────────────────────────

test('numeric filters: variance percentage', () => {
  const s = scanner();
  const tasks = [
    s.parseTaskLine('- [x] High variance ⏱️ 10h 🕐 2h', 'A.md', 1)!,  // 80% variance
    s.parseTaskLine('- [x] Low variance ⏱️ 10h 🕐 9h', 'A.md', 2)!,   // 10% variance
  ];
  
  const result = filterTasks(tasks, 'variance > 50%');
  assert.deepEqual(result.map((t) => t.normalizedText), ['High variance']);
});

test('numeric filters: variance less than', () => {
  const s = scanner();
  const tasks = [
    s.parseTaskLine('- [x] High variance ⏱️ 10h 🕐 2h', 'A.md', 1)!,  // 80% variance
    s.parseTaskLine('- [x] Low variance ⏱️ 10h 🕐 9h', 'A.md', 2)!,   // 10% variance
  ];
  
  const result = filterTasks(tasks, 'variance < 50%');
  assert.deepEqual(result.map((t) => t.normalizedText), ['Low variance']);
});

// ── Presence Filters ─────────────────────────────────────────────────────

test('numeric filters: has effort', () => {
  const s = scanner();
  const tasks = [
    s.parseTaskLine('- [ ] With effort ⏱️ 2h', 'A.md', 1)!,
    s.parseTaskLine('- [ ] Without effort', 'A.md', 2)!,
  ];
  
  const result = filterTasks(tasks, 'has effort');
  assert.deepEqual(result.map((t) => t.normalizedText), ['With effort']);
});

test('numeric filters: has no effort', () => {
  const s = scanner();
  const tasks = [
    s.parseTaskLine('- [ ] With effort ⏱️ 2h', 'A.md', 1)!,
    s.parseTaskLine('- [ ] Without effort', 'A.md', 2)!,
  ];
  
  const result = filterTasks(tasks, 'has no effort');
  assert.deepEqual(result.map((t) => t.normalizedText), ['Without effort']);
});

test('numeric filters: has actual', () => {
  const s = scanner();
  const tasks = [
    s.parseTaskLine('- [x] With actual ⏱️ 2h 🕐 1.5h', 'A.md', 1)!,
    s.parseTaskLine('- [x] Without actual ⏱️ 2h', 'A.md', 2)!,
  ];
  
  const result = filterTasks(tasks, 'has actual');
  assert.deepEqual(result.map((t) => t.normalizedText), ['With actual']);
});

test('numeric filters: has cost', () => {
  const s = scanner();
  const tasks = [
    s.parseTaskLine('- [ ] With cost 💰 100', 'A.md', 1)!,
    s.parseTaskLine('- [ ] Without cost', 'A.md', 2)!,
  ];
  
  const result = filterTasks(tasks, 'has cost');
  assert.deepEqual(result.map((t) => t.normalizedText), ['With cost']);
});

test('numeric filters: has no cost', () => {
  const s = scanner();
  const tasks = [
    s.parseTaskLine('- [ ] With cost 💰 100', 'A.md', 1)!,
    s.parseTaskLine('- [ ] Without cost', 'A.md', 2)!,
  ];
  
  const result = filterTasks(tasks, 'has no cost');
  assert.deepEqual(result.map((t) => t.normalizedText), ['Without cost']);
});

// ── Edge Cases ───────────────────────────────────────────────────────────

test('numeric filters: handles decimal effort', () => {
  const s = scanner();
  const tasks = [
    s.parseTaskLine('- [ ] Task ⏱️ 1.5h', 'A.md', 1)!,
  ];
  
  const result = filterTasks(tasks, 'effort > 1h');
  assert.deepEqual(result.map((t) => t.normalizedText), ['Task']);
});

test('numeric filters: handles mixed hours and minutes', () => {
  const s = scanner();
  const tasks = [
    s.parseTaskLine('- [ ] Task ⏱️ 1h 30m', 'A.md', 1)!,
  ];
  
  const result = filterTasks(tasks, 'effort >= 1h 30m');
  assert.deepEqual(result.map((t) => t.normalizedText), ['Task']);
});

test('numeric filters: handles day effort durations', () => {
  const s = scanner();
  const tasks = [
    s.parseTaskLine('- [ ] Full day task ⏱️ 1d', 'A.md', 1)!,
    s.parseTaskLine('- [ ] Half day task ⏱️ 4h', 'A.md', 2)!,
  ];

  assert.equal(tasks[0].metadata.effort, '1d');
  assert.deepEqual(filterTasks(tasks, 'effort >= 1d').map((t) => t.normalizedText), ['Full day task']);
  assert.deepEqual(filterTasks(tasks, 'effort < 1 day').map((t) => t.normalizedText), ['Half day task']);
});

test('numeric filters: handles text aliases (above, below, over, under)', () => {
  const s = scanner();
  const tasks = [
    s.parseTaskLine('- [ ] Long task ⏱️ 2h', 'A.md', 1)!,
    s.parseTaskLine('- [ ] Short task ⏱️ 30m', 'A.md', 2)!,
  ];
  
  const result1 = filterTasks(tasks, 'effort above 1h');
  const result2 = filterTasks(tasks, 'effort over 1h');
  const result3 = filterTasks(tasks, 'effort under 1h');
  const result4 = filterTasks(tasks, 'effort below 1h');
  
  assert.deepEqual(result1.map((t) => t.normalizedText), ['Long task']);
  assert.deepEqual(result2.map((t) => t.normalizedText), ['Long task']);
  assert.deepEqual(result3.map((t) => t.normalizedText), ['Short task']);
  assert.deepEqual(result4.map((t) => t.normalizedText), ['Short task']);
});
