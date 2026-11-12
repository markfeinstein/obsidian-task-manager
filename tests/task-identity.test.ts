import assert from 'node:assert/strict';
import test from 'node:test';
import { ExplicitIdIndex, explicitTaskKey, legacyExplicitTaskKey, taskLocationKey } from '../src/task-identity';
import { parseMarkdownTaskLine } from '../src/task-model';
import { TaskIndex } from '../src/task-index';
import { resolveGanttDependency } from '../src/gantt-renderer';
import { calculateUrgency, filterTasks } from '../src/task-query';

test('explicit task identity is vault-wide while the legacy alias remains path-coupled', () => {
  assert.equal(explicitTaskKey(' exact-ID '), 'id:exact-ID');
  assert.equal(legacyExplicitTaskKey('Projects/A.md', ' exact-ID '), 'Projects/A.md:id:exact-ID');
});

test('explicit ID index resolves missing, unique, and duplicate IDs without input-order dependence', () => {
  const first = parseMarkdownTaskLine('- [ ] First 🆔 shared', 'B.md', 4);
  const second = parseMarkdownTaskLine('- [ ] Second 🆔 shared', 'A.md', 2);
  const unique = parseMarkdownTaskLine('- [ ] Unique 🆔 only', 'C.md', 1);
  assert.ok(first);
  assert.ok(second);
  assert.ok(unique);
  if (!first || !second || !unique) return;

  for (const tasks of [[first, second, unique], [unique, second, first]]) {
    const index = new ExplicitIdIndex(tasks);
    assert.equal(index.resolve('missing').kind, 'missing');
    assert.equal(index.resolve('only').kind, 'unique');
    const duplicate = index.resolve('shared');
    assert.equal(duplicate.kind, 'ambiguous');
    assert.deepEqual(duplicate.matches.map((task) => task.filePath), ['A.md', 'B.md']);
    assert.equal(index.unique('shared'), undefined);
  }
});

test('explicit ID matching remains case-sensitive', () => {
  const upper = parseMarkdownTaskLine('- [ ] Upper 🆔 Foo', 'A.md', 1);
  const lower = parseMarkdownTaskLine('- [ ] Lower 🆔 foo', 'B.md', 1);
  assert.ok(upper);
  assert.ok(lower);
  if (!upper || !lower) return;
  const index = new ExplicitIdIndex([upper, lower]);
  assert.equal(index.resolve('Foo').kind, 'unique');
  assert.equal(index.resolve('foo').kind, 'unique');
  assert.notEqual(upper.key, lower.key);
});

test('task location keys distinguish duplicate IDs without changing their durable identity', () => {
  const first = parseMarkdownTaskLine('- [ ] First 🆔 shared', 'A.md', 1);
  const second = parseMarkdownTaskLine('- [ ] Second 🆔 shared', 'B.md', 1);
  assert.ok(first);
  assert.ok(second);
  if (!first || !second) return;
  assert.equal(first.key, second.key);
  assert.notEqual(taskLocationKey(first), taskLocationKey(second));
});

test('TaskIndex publishes unique and ambiguous explicit-ID resolution', () => {
  const first = parseMarkdownTaskLine('- [ ] First 🆔 shared', 'A.md', 1);
  const second = parseMarkdownTaskLine('- [ ] Second 🆔 shared', 'B.md', 1);
  const unique = parseMarkdownTaskLine('- [ ] Unique 🆔 only', 'C.md', 1);
  assert.ok(first && second && unique);
  if (!first || !second || !unique) return;
  const index = new TaskIndex();
  index.commit(new Map([['A.md', [first]], ['B.md', [second]], ['C.md', [unique]]]));
  assert.equal(index.getSnapshot().explicitIds.unique('shared'), undefined);
  const published = index.getSnapshot().explicitIds.unique('only');
  assert.deepEqual(published, unique);
  assert.notEqual(published, unique);
  assert.ok(Object.isFrozen(published));
  assert.ok(Object.isFrozen(published?.metadata));
});

test('blocked and blocking query projections fail closed for duplicate IDs', () => {
  const first = parseMarkdownTaskLine('- [ ] First 🆔 shared', 'A.md', 1);
  const second = parseMarkdownTaskLine('- [ ] Second 🆔 shared', 'B.md', 1);
  const dependent = parseMarkdownTaskLine('- [ ] Dependent ⛔ shared', 'C.md', 1);
  assert.ok(first && second && dependent);
  if (!first || !second || !dependent) return;
  for (const tasks of [[first, second, dependent], [dependent, second, first]]) {
    assert.deepEqual(filterTasks(tasks, 'is blocked').map((task) => task.filePath), []);
    assert.deepEqual(filterTasks(tasks, 'is blocking').map((task) => task.filePath), []);
    assert.equal(calculateUrgency(dependent, '2026-01-01', { allTasks: tasks }), calculateUrgency(dependent, '2026-01-01', { allTasks: [...tasks].reverse() }));
  }
});

test('Gantt dependency lookup omits ambiguous edges independent of task order', () => {
  const first = parseMarkdownTaskLine('- [ ] First 🆔 shared', 'A.md', 1);
  const second = parseMarkdownTaskLine('- [ ] Second 🆔 shared', 'B.md', 1);
  const unique = parseMarkdownTaskLine('- [ ] Unique 🆔 only', 'C.md', 1);
  assert.ok(first && second && unique);
  if (!first || !second || !unique) return;
  assert.equal(resolveGanttDependency([first, unique, second], 'shared'), undefined);
  assert.equal(resolveGanttDependency([second, unique, first], 'shared'), undefined);
  assert.equal(resolveGanttDependency([first, unique, second], 'only'), unique);
});
