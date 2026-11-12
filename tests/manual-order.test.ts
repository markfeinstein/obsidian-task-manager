import test from 'node:test';
import assert from 'node:assert/strict';
import type { ParsedTask } from '../src/task-scanner.js';
import {
  MANUAL_ORDER_STEP,
  applyRowMove,
  compareManualOrder,
  hasManualOrder,
  isManualOrderWritableTask,
  planManualReorder,
  setOrderFieldOnLine,
  sortTasksWithManualOrder,
} from '../src/manual-order.js';

function task(key: string, manualOrder?: number): ParsedTask {
  return { key, metadata: { manualOrder, dates: {} } } as unknown as ParsedTask;
}

// ── setOrderFieldOnLine ──────────────────────────────────────────────────────
test('setOrderFieldOnLine appends an order field to a plain task line', () => {
  assert.equal(setOrderFieldOnLine('- [ ] Write report', 150), '- [ ] Write report [order:: 150]');
});

test('setOrderFieldOnLine replaces an existing order field', () => {
  assert.equal(setOrderFieldOnLine('- [ ] Write report [order:: 100]', 250), '- [ ] Write report [order:: 250]');
});

test('setOrderFieldOnLine removes the order field when value is null', () => {
  assert.equal(setOrderFieldOnLine('- [ ] Write report [order:: 100]', null), '- [ ] Write report');
});

test('setOrderFieldOnLine keeps a trailing block link at the very end', () => {
  assert.equal(
    setOrderFieldOnLine('- [ ] Write report ^abc123', 50),
    '- [ ] Write report [order:: 50] ^abc123',
  );
});

test('setOrderFieldOnLine formats fractional values compactly', () => {
  assert.equal(setOrderFieldOnLine('- [ ] x', 125.5), '- [ ] x [order:: 125.5]');
});

// ── applyRowMove ─────────────────────────────────────────────────────────────
test('applyRowMove moves an item downward (insert before destination)', () => {
  assert.deepEqual(applyRowMove(['a', 'b', 'c', 'd'], 0, 2), ['b', 'a', 'c', 'd']);
});

test('applyRowMove moves an item upward', () => {
  assert.deepEqual(applyRowMove(['a', 'b', 'c', 'd'], 3, 1), ['a', 'd', 'b', 'c']);
});

test('applyRowMove is a no-op for equal indices', () => {
  assert.deepEqual(applyRowMove(['a', 'b', 'c'], 1, 1), ['a', 'b', 'c']);
});

// ── planManualReorder ────────────────────────────────────────────────────────
test('planManualReorder writes a single midpoint value between ordered neighbours', () => {
  const order = new Map([['a', 100], ['b', 200], ['c', 300]]);
  // Move 'c' between 'a' and 'b' → keysAfter = [a, c, b]
  const writes = planManualReorder(['a', 'c', 'b'], 'c', (k) => order.get(k));
  assert.deepEqual(writes, [{ key: 'c', order: 150 }]);
});

test('planManualReorder assigns below-first when moved to the top', () => {
  const order = new Map([['a', 100], ['b', 200]]);
  const writes = planManualReorder(['b', 'a'], 'b', (k) => order.get(k));
  assert.deepEqual(writes, [{ key: 'b', order: 100 - MANUAL_ORDER_STEP }]);
});

test('planManualReorder assigns above-last when moved to the bottom', () => {
  const order = new Map([['a', 100], ['b', 200]]);
  const writes = planManualReorder(['b', 'a'], 'a', (k) => order.get(k));
  assert.deepEqual(writes, [{ key: 'a', order: 200 + MANUAL_ORDER_STEP }]);
});

test('planManualReorder renumbers the whole list when neighbours lack orders (first drag)', () => {
  const writes = planManualReorder(['b', 'a', 'c'], 'b', () => undefined);
  assert.deepEqual(writes, [
    { key: 'b', order: MANUAL_ORDER_STEP },
    { key: 'a', order: MANUAL_ORDER_STEP * 2 },
    { key: 'c', order: MANUAL_ORDER_STEP * 3 },
  ]);
});

// ── sort / compare helpers ───────────────────────────────────────────────────
test('hasManualOrder detects any ordered task', () => {
  assert.equal(hasManualOrder([task('a'), task('b', 10)]), true);
  assert.equal(hasManualOrder([task('a'), task('b')]), false);
});

test('sortTasksWithManualOrder floats ordered tasks up and keeps unordered below', () => {
  const a = task('a');
  const b = task('b', 200);
  const c = task('c', 100);
  const sorted = sortTasksWithManualOrder([a, b, c], () => 0);
  assert.deepEqual(sorted.map((t) => t.key), ['c', 'b', 'a']);
});

test('sortTasksWithManualOrder uses the fallback when no task has a manual order', () => {
  const a = task('a');
  const b = task('b');
  const sorted = sortTasksWithManualOrder([b, a], (x, y) => x.key.localeCompare(y.key));
  assert.deepEqual(sorted.map((t) => t.key), ['a', 'b']);
});

test('compareManualOrder ranks an ordered task before an unordered one', () => {
  assert.ok(compareManualOrder(task('a', 5), task('b'), () => 0) < 0);
  assert.ok(compareManualOrder(task('a'), task('b', 5), () => 0) > 0);
});

test('manual ordering excludes Canvas-backed tasks from writable controls', () => {
  const markdown = { ...task('Tasks.md:1'), filePath: 'Tasks.md' };
  const canvas = { ...task('Board.canvas:canvas:node:1'), filePath: 'Board.canvas' };
  assert.equal(isManualOrderWritableTask(markdown), true);
  assert.equal(isManualOrderWritableTask(canvas), false);
});
