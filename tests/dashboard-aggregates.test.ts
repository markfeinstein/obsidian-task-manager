import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDashboardAggregates } from '../src/dashboard-aggregates';
import { TaskScanner } from '../src/task-scanner';

const scanner = new TaskScanner({} as never);

function task(line: string, index: number) {
  const parsed = scanner.parseTaskLine(line, 'Dashboard.md', index);
  assert.ok(parsed);
  return parsed;
}

test('Dashboard aggregates build reusable status, priority, active, and identity facets in one model', () => {
  const tasks = [
    task('- [ ] Todo 🔺 🆔 todo', 1),
    task('- [/] Active ⏫ 🆔 active', 2),
    task('- [x] Done 🆔 done', 3),
    task('- [-] Cancelled 🆔 cancelled', 4),
  ];
  const model = buildDashboardAggregates(tasks);
  assert.equal(model.tasks.length, 4);
  assert.deepEqual(model.activeTasks.map((entry) => entry.metadata.id), ['todo', 'active']);
  assert.equal(model.trackedTasks.length, 4);
  assert.equal(model.byStatus.get('done')?.length, 1);
  assert.equal(model.byPriority.get('highest')?.length, 1);
  assert.equal(model.byTaskKey.get(tasks[1].key), tasks[1]);
  assert.ok(Object.isFrozen(model));
  assert.ok(Object.isFrozen(model.activeTasks));
});
