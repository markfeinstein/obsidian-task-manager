import test from 'node:test';
import assert from 'node:assert/strict';
import { canonicalExplicitTasksForAffectedOwners, planScanLifecycleReconciliation } from '../src/scan-lifecycle-reconciler';
import { TaskIndex } from '../src/task-index';
import { StateStore } from '../src/state-store';
import { ExplicitIdIndex } from '../src/task-identity';
import type { TaskSnapshotEntry } from '../src/completion-detector';
import type { ParsedTask } from '../src/task-scanner';

function task(id: string, filePath: string, status: ParsedTask['status'], lineNumber = 1, habit = false): ParsedTask {
  return {
    key: `id:${id}`,
    stableKey: `id:${id}`,
    filePath,
    lineNumber,
    status,
    checkbox: status === 'done' ? 'x' : ' ',
    rawLine: `- [${status === 'done' ? 'x' : ' '}] ${habit ? 'Habit ' : ''}${id} 🆔 ${id}`,
    body: id,
    normalizedText: id,
    tags: habit ? ['#habit'] : [],
    metadata: { id, dates: {}, priority: 'normal', dependsOn: [], comments: [] },
  } as unknown as ParsedTask;
}

function prior(id: string, filePath: string, status: ParsedTask['status']): Map<string, TaskSnapshotEntry> {
  return new Map([[`id:${id}`, { key: `id:${id}`, filePath, lineNumber: 1, status, sourceKind: 'line' }]]);
}

function applyPlan(previous: ReadonlyMap<string, TaskSnapshotEntry>, plan: ReturnType<typeof planScanLifecycleReconciliation>): Map<string, TaskSnapshotEntry> {
  const next = new Map(previous);
  for (const removal of plan.removals) {
    if (next.get(removal.key)?.filePath === removal.expectedFilePath) next.delete(removal.key);
  }
  for (const entry of plan.currentEntries) next.set(entry.key, entry);
  return next;
}

test('scan lifecycle reconciler moves a unique explicit ID and detects completion globally', () => {
  for (const [source, target] of [['Z-source.md', 'A-target.md'], ['A-source.md', 'Z-target.md']]) {
    const current = task('moved', target, 'done', 3, true);
    const plan = planScanLifecycleReconciliation({
      currentTasks: [current],
      affectedPaths: new Set([source, target]),
      previousSnapshot: prior('moved', source, 'todo'),
      explicitIds: new ExplicitIdIndex([current]),
      isHabit: () => true,
    });
    assert.deepEqual(plan.completions, [current]);
    assert.deepEqual(plan.habitCompletions, [current]);
    assert.deepEqual(plan.removals, [], 'the canonical overlay safely changes ownership without a redundant delete');
    assert.deepEqual(plan.currentEntries, [{ key: 'id:moved', filePath: target, lineNumber: 3, status: 'done', sourceKind: 'line' }]);
    assert.deepEqual(plan.statusChanges, [{ task: current, previousStatus: 'todo' }]);
    const applied = applyPlan(prior('moved', source, 'todo'), plan);
    assert.deepEqual([...applied.values()], [{ key: 'id:moved', filePath: target, lineNumber: 3, status: 'done', sourceKind: 'line' }]);
  }
});

test('file-backed line-zero snapshots detect completion exactly once after persisted reload', async () => {
  const current = task('file-task', 'Task.md', 'done', 0);
  const store = new StateStore({
    loadData: async () => ({ state: { version: 2, sliceVersions: { scan: 1 }, snapshot: [{ key: current.key, filePath: current.filePath, lineNumber: 0, status: 'todo' }], completions: [] } }),
    saveData: async () => undefined,
  } as never);
  const loaded = await store.loadState();
  let previous = new Map<string, TaskSnapshotEntry>(loaded.snapshot.map((entry) => [entry.key, {
    ...entry, status: entry.status as ParsedTask['status'], sourceKind: entry.sourceKind ?? 'file',
  }]));
  const plan = planScanLifecycleReconciliation({
    currentTasks: [current], affectedPaths: new Set(['Task.md']), previousSnapshot: previous,
    explicitIds: new ExplicitIdIndex([current]), isHabit: () => false,
  });
  assert.deepEqual(plan.completions, [current]);
  assert.equal(plan.currentEntries[0]?.sourceKind, 'file');
  previous = applyPlan(previous, plan);
  const repeated = planScanLifecycleReconciliation({
    currentTasks: [current], affectedPaths: new Set(['Task.md']), previousSnapshot: previous,
    explicitIds: new ExplicitIdIndex([current]), isHabit: () => false,
  });
  assert.deepEqual(repeated.completions, []);
});

test('scan lifecycle reconciliation recovers a unique destination on a source-only split wave', () => {
  const destination = task('moved', 'Target.md', 'done', 3, true);
  const previous = prior('moved', 'Source.md', 'todo');
  const plan = planScanLifecycleReconciliation({
    currentTasks: [],
    canonicalExplicitTasks: [destination],
    affectedPaths: new Set(['Source.md']),
    previousSnapshot: previous,
    explicitIds: new ExplicitIdIndex([destination]),
    isHabit: () => true,
  });
  assert.deepEqual(plan.completions, [destination]);
  assert.deepEqual(plan.habitCompletions, [destination]);
  assert.deepEqual(plan.removals, []);
  assert.deepEqual(applyPlan(previous, plan).get('id:moved')?.filePath, 'Target.md');
});

test('two real index waves recover canonical destination exactly once', () => {
  const source = task('moved', 'Source.md', 'todo');
  const destination = task('moved', 'Target.md', 'done', 3, true);
  const index = new TaskIndex();
  index.commit(new Map([['Source.md', [source]]]));
  let snapshot = prior('moved', 'Source.md', 'todo');

  index.commit(new Map([['Target.md', [destination]]]));
  const ambiguousPlan = planScanLifecycleReconciliation({
    currentTasks: [destination], affectedPaths: new Set(['Target.md']), previousSnapshot: snapshot,
    explicitIds: index.getExplicitIds(), isHabit: () => true,
  });
  assert.deepEqual(ambiguousPlan.currentEntries, []);

  index.commit(new Map([['Source.md', []]]));
  const currentTasks: ParsedTask[] = [];
  const affectedPaths = new Set(['Source.md']);
  const canonical = canonicalExplicitTasksForAffectedOwners({
    currentTasks, affectedPaths, previousSnapshot: snapshot,
    explicitIds: index.getExplicitIds(), globalTasks: index.getAllTasks(),
  });
  const recovered = planScanLifecycleReconciliation({
    currentTasks, canonicalExplicitTasks: canonical, affectedPaths, previousSnapshot: snapshot,
    explicitIds: index.getExplicitIds(), isHabit: () => true,
  });
  assert.deepEqual(recovered.completions, [destination]);
  snapshot = applyPlan(snapshot, recovered);
  assert.equal(snapshot.get('id:moved')?.filePath, 'Target.md');

  const later = planScanLifecycleReconciliation({
    currentTasks: [destination], affectedPaths: new Set(['Target.md']), previousSnapshot: snapshot,
    explicitIds: index.getExplicitIds(), isHabit: () => true,
  });
  assert.deepEqual(later.completions, []);
});

test('scan lifecycle reconciliation is replacement-order independent and move+reopen is not a completion', () => {
  const reopened = task('moved', 'Target.md', 'todo');
  const other = task('other', 'Other.md', 'todo');
  const options = (tasks: ParsedTask[]) => planScanLifecycleReconciliation({
    currentTasks: tasks,
    affectedPaths: new Set(['Source.md', 'Target.md', 'Other.md']),
    previousSnapshot: prior('moved', 'Source.md', 'done'),
    explicitIds: new ExplicitIdIndex(tasks),
    isHabit: () => false,
  });
  const left = options([reopened, other]);
  const right = options([other, reopened]);
  assert.deepEqual(left.completions, []);
  assert.equal(left.statusChanges.find((change) => change.task.key === 'id:moved')?.previousStatus, 'done');
  assert.deepEqual(new Set(left.currentEntries.map((entry) => entry.key)), new Set(right.currentEntries.map((entry) => entry.key)));
  assert.deepEqual(left.removals, right.removals);
});

test('scan lifecycle reconciler retains prior state and emits no effects for duplicate IDs', () => {
  const duplicateA = task('duplicate', 'A.md', 'done');
  const duplicateB = task('duplicate', 'B.md', 'done');
  const plan = planScanLifecycleReconciliation({
    currentTasks: [duplicateA, duplicateB],
    affectedPaths: new Set(['Old.md', 'A.md', 'B.md']),
    previousSnapshot: prior('duplicate', 'Old.md', 'todo'),
    explicitIds: new ExplicitIdIndex([duplicateA, duplicateB]),
    isHabit: () => true,
  });
  assert.deepEqual(plan.completions, []);
  assert.deepEqual(plan.habitCompletions, []);
  assert.deepEqual(plan.currentEntries, []);
  assert.deepEqual(plan.removals, []);
  assert.deepEqual(plan.statusChanges, []);
});
