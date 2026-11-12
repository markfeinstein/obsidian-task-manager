import test from 'node:test';
import assert from 'node:assert/strict';
import {
  baseCompletionTaskKey,
  detectCompletionTasks,
  detectHabitCompletionTasks,
  type TaskSnapshotEntry,
} from '../src/completion-detector';
import type { ParsedTask } from '../src/task-scanner';

function task(key: string, lineNumber: number, status: ParsedTask['status']): ParsedTask {
  return {
    key,
    stableKey: key,
    filePath: 'Tasks.md',
    lineNumber,
    status,
    metadata: { dates: {}, priority: 'normal', dependsOn: [], invalidDates: {} },
  } as unknown as ParsedTask;
}

function snapshot(...entries: Array<[string, number, ParsedTask['status']]>): ReadonlyMap<string, TaskSnapshotEntry> {
  return new Map(entries.map(([key, lineNumber, status]) => [key, {
    key,
    lineNumber,
    status,
    filePath: 'Tasks.md',
    sourceKind: 'line',
  }]));
}

test('completion detector keeps explicit-ID and occurrence grouping stable', () => {
  assert.equal(baseCompletionTaskKey('Tasks.md:id:CaseSensitive\u00002'), 'Tasks.md:id:CaseSensitive');
  assert.equal(baseCompletionTaskKey('Tasks.md:body\u00004'), 'Tasks.md:body');

  const tasks = [
    task('Tasks.md:id:CaseSensitive\u00000', 1, 'done'),
    task('Tasks.md:id:CaseSensitive\u00001', 2, 'todo'),
  ];
  const previous = snapshot(
    ['Tasks.md:id:CaseSensitive\u00000', 1, 'todo'],
    ['Tasks.md:id:CaseSensitive\u00001', 2, 'todo'],
  );

  assert.deepEqual(detectCompletionTasks(tasks, previous).map((item) => item.lineNumber), [1]);
});

test('completion detector does not invent a completion when expansion preserves pending count', () => {
  const tasks = [
    task('recurring\u00000', 1, 'done'),
    task('recurring\u00001', 2, 'todo'),
  ];
  const previous = snapshot(['recurring', 1, 'todo']);

  assert.deepEqual(detectCompletionTasks(tasks, previous), []);
});

test('completion detector uses line identity only when file cardinality is stable', () => {
  const renamed = task('new-key', 4, 'done');
  const previous = snapshot(['old-key', 4, 'todo']);

  assert.deepEqual(detectCompletionTasks([renamed], previous), [renamed]);
  assert.deepEqual(detectCompletionTasks([renamed, task('extra', 5, 'todo')], previous), []);
});

test('habit completion detection is pure and delegates habit classification', () => {
  const completedHabit = task('habit', 3, 'done');
  const completedOrdinary = task('ordinary', 4, 'done');
  const previous = snapshot(['habit', 3, 'todo'], ['ordinary', 4, 'todo']);

  assert.deepEqual(
    detectHabitCompletionTasks([completedHabit, completedOrdinary], previous, (item) => item.key === 'habit'),
    [completedHabit],
  );
});
