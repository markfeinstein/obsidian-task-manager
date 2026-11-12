import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskQueryService } from '../src/task-query-service';
import { TaskScanner } from '../src/task-scanner';
import { DEFAULT_SETTINGS } from '../src/types';

const scanner = new TaskScanner({} as never);
function parsed(line: string, path: string, lineNumber: number) {
  const task = scanner.parseTaskLine(line, path, lineNumber);
  assert.ok(task);
  return task;
}
const tasks = [
  parsed('- [ ] Parent 📅 2026-06-20 #work', 'Project.md', 1),
  parsed('  - [ ] Child', 'Project.md', 2),
  parsed('- [ ] Linked task', 'Linked.md', 1),
];

function service(overrides: Partial<typeof DEFAULT_SETTINGS> = {}): TaskQueryService {
  const settings = { ...DEFAULT_SETTINGS, enableQueryDsl: true, enableDslExpressions: true, ...overrides };
  return new TaskQueryService(
    () => settings,
    (path) => path === 'Project.md'
      ? { properties: { area: 'work', task_tags: 'project', TQ_show_tags: false }, outlinks: ['Target', '[[Target]]'] }
      : { properties: {}, outlinks: [] },
  );
}

test('TaskQueryService supplies one complete metadata context for parse and filter', () => {
  const queryService = service({ fileDefaultsEnabled: true, subtaskDateInheritance: true });
  const byProperty = queryService.execute(tasks, 'filter by function task.file.property("area") === "work"');
  const byOutlink = queryService.execute(tasks, 'filter by function task.file.outlinks.includes("[[Target]]")');
  const inherited = queryService.execute(tasks, 'due on 2026-06-20');
  const defaults = queryService.execute([tasks[0]], '');

  assert.deepEqual(byProperty.tasks.map((task) => task.filePath), ['Project.md', 'Project.md']);
  assert.deepEqual(byOutlink.tasks.map((task) => task.filePath), ['Project.md', 'Project.md']);
  assert.deepEqual(inherited.tasks.map((task) => task.normalizedText), ['Parent #work', 'Child']);
  assert.deepEqual(defaults.tasks[0]?.tags, ['work', 'project']);
});

test('TaskQueryService applies global query, Query File Defaults, future occurrences, and default sort consistently', () => {
  const recurring = parsed('- [ ] Repeat 🔁 every day 📅 2026-07-20', 'Project.md', 3);
  const queryService = service({
    globalQuery: 'not done',
    futureOccurrenceCount: 2,
    defaultSort: 'description',
  });
  const result = queryService.execute([...tasks, recurring], 'show future occurrences', { sourcePath: 'Project.md', today: '2026-11-09' });

  assert.equal(result.query.layout.hidden.has('tags'), true);
  assert.deepEqual(result.query.sort, [{ field: 'description' }]);
  assert.ok(result.tasks.some((task) => task.key.startsWith('_proj_')), 'future occurrence projection uses the shared count setting');
  assert.equal(result.query.explainSources?.globalQuery, 'not done');
  assert.ok(result.query.explainSources?.queryFileDefaults.includes('hide tags'));
});
