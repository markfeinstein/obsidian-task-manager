import test from 'node:test';
import assert from 'node:assert/strict';
import { filterTasks, groupTasks, parseTaskQuery } from '../src/task-query';
import { TaskScanner } from '../src/task-scanner';

const scanner = new TaskScanner({} as never);
function task(line: string, index = 0) {
  const parsed = scanner.parseTaskLine(line, `File-${index % 10}.md`, index + 1);
  assert.ok(parsed);
  return parsed;
}

test('function queries build allTasks lazily and share file metadata across filtering and sorting', () => {
  const tasks = Array.from({ length: 1_000 }, (_, index) => task(`- [ ] Task ${index}`, index));
  let reads = 0;
  const options = { today: '2026-11-09', fileInfoProvider: () => { reads += 1; return { properties: { area: 'work' }, outlinks: [] }; } };
  assert.equal(filterTasks(tasks, 'filter by function task.isDone === false', options).length, 100);
  assert.equal(reads, 0, 'a task-only predicate must not eagerly load file or allTasks facades');
  const query = 'filter by function task.file.property("area") === "work"\nsort by function task.file.completionPercent';
  assert.equal(filterTasks(tasks, query, options).length, 100);
  assert.equal(reads, 10, 'each file is read once, not per task or comparator');
  reads = 0;
  const grouped = groupTasks(tasks, parseTaskQuery('group by function task.file.property("area")').groups, options.today, undefined, options);
  assert.equal(grouped.length, 1);
  assert.equal(reads, 10);
});

test('allTasks facade collection is constructed only once per query execution', () => {
  let maps = 0;
  const tasks = new Proxy(Array.from({ length: 200 }, (_, index) => task('- [ ] Test', index)), {
    get(target, property, receiver) {
      if (property === 'map') maps += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  assert.equal(filterTasks(tasks, 'filter by function query.allTasks.length === 200').length, 100);
  assert.equal(maps, 1);
});

test('expression caches do not retain stale metadata between query executions', () => {
  let area = 'work';
  const tasks = [task('- [ ] Test')];
  const options = { fileInfoProvider: () => ({ properties: { area }, outlinks: [] }) };
  const query = parseTaskQuery('filter by function task.file.property("area") === "work"');
  assert.equal(filterTasks(tasks, query, options).length, 1);
  area = 'home';
  assert.equal(filterTasks(tasks, query, options).length, 0);
});

test('compiled expressions preserve literal punctuation, precedence, and prototype restrictions', () => {
  const tasks = [task('- [ ] )')];
  assert.equal(filterTasks(tasks, 'filter by function contains(task.description, ")") && !(false || true === false)').length, 1);
  assert.equal(filterTasks(tasks, 'filter by function task.constructor === undefined').length, 1);
  assert.throws(() => filterTasks(tasks, 'filter by function task.constructor()'), /Unsupported query DSL method/u);
});

test('overdue recurrence projections fast-forward while preserving interval phase and end conditions', () => {
  const recurring = task('- [ ] Repeat 🔁 every 3 days 📅 2026-07-20');
  const projected = filterTasks([recurring], 'show future occurrences', { today: '2026-11-09', futureOccurrenceCount: 2 }).filter((entry) => entry.isProjected);
  assert.deepEqual(projected.map((entry) => entry.metadata.dates.due), ['2026-11-11', '2026-11-14']);
  const ended = task('- [ ] Repeat 🔁 every day until 2026-08-01 📅 2026-07-20');
  assert.equal(filterTasks([ended], 'show future occurrences', { today: '2026-11-09' }).filter((entry) => entry.isProjected).length, 0);
  const exhausted = task('- [ ] Repeat 🔁 every day for 5 times 📅 2026-07-20 [recurrenceCount:: 99]');
  assert.equal(filterTasks([exhausted], 'show future occurrences', { today: '2026-11-09' }).filter((entry) => entry.isProjected).length, 0);
  const remaining = task('- [ ] Repeat 🔁 every day for 5 times 📅 2026-07-20 [recurrenceCount:: 3]');
  assert.equal(filterTasks([remaining], 'show future occurrences', { today: '2026-11-09', futureOccurrenceCount: 3 }).filter((entry) => entry.isProjected).length, 1);
  const whenDone = task('- [ ] Repeat 🔁 every 3 days when done 📅 2026-07-20');
  assert.deepEqual(filterTasks([whenDone], 'show future occurrences', { today: '2026-11-09', futureOccurrenceCount: 2 }).filter((entry) => entry.isProjected).map((entry) => entry.metadata.dates.due), ['2026-11-12', '2026-11-15']);
  const invalid = task('- [ ] Repeat 🔁 every 0 days 📅 2026-07-20');
  assert.equal(filterTasks([invalid], 'show future occurrences', { today: '2026-11-09' }).filter((entry) => entry.isProjected).length, 0);
});
