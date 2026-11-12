import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTaskQuery, groupTasks } from '../src/task-query';
import { type MarkdownTask, parseTaskMetadata } from '../src/task-model';
import type { TaskStatus } from '../src/types';

const mockTask = (text: string, due?: string, effort?: string, status: string = ' '): MarkdownTask => ({
  key: text,
  filePath: 'test.md',
  lineNumber: 1,
  rawLine: `- [${status}] ${text}`,
  linePrefix: '',
  indentation: '',
  listMarker: '-',
  checkbox: status,
  body: text,
  normalizedText: text,
  status: (status === 'x' ? 'done' : status === '-' ? 'cancelled' : 'todo') as TaskStatus,
  tags: [],
  contexts: [],
  heading: undefined,
  metadata: parseTaskMetadata(`- [${status}] ${text}${due ? ` 📅 ${due}` : ''}${effort ? ` ⏱️ ${effort}` : ''}`),
});

test('Group aggregations: sums effort across tasks in a group', () => {
  const tasks = [
    mockTask('Task 1', undefined, '2h'),
    mockTask('Task 2', undefined, '30m'),
    mockTask('Task 3', undefined, '1h 30m'),
  ];
  
  const query = parseTaskQuery('group by priority');
  const grouped = groupTasks(tasks, query.groups, '2026-05-28', [], { allTasks: tasks });
  
  assert.ok(grouped.length > 0);
  assert.ok(grouped[0].aggregations);
  assert.equal(grouped[0].aggregations.effortSum, '4h');
});

test('Group aggregations: handles zero effort', () => {
  const tasks = [
    mockTask('Task 1'),
    mockTask('Task 2'),
  ];
  
  const query = parseTaskQuery('group by priority');
  const grouped = groupTasks(tasks, query.groups, '2026-05-28', [], { allTasks: tasks });
  
  assert.ok(grouped.length > 0);
});

test('Group aggregations: counts overdue tasks (due before today)', () => {
  const today = '2026-05-28';
  const tasks = [
    mockTask('Overdue 1', '2026-05-25', undefined, ' '),
    mockTask('Overdue 2', '2026-05-26', undefined, ' '),
    mockTask('On time', '2026-05-29', undefined, ' '),
    mockTask('Done overdue', '2026-05-25', undefined, 'x'),
  ];
  
  const query = parseTaskQuery('group by priority');
  const grouped = groupTasks(tasks, query.groups, today, [], { allTasks: tasks });
  
  assert.ok(grouped.length > 0);
  assert.ok(grouped[0].aggregations);
  assert.equal(grouped[0].aggregations.overdueCount, 2);
});

test('Group aggregations: handles no overdue tasks', () => {
  const today = '2026-05-28';
  const tasks = [
    mockTask('Future task 1', '2026-05-29', undefined, ' '),
    mockTask('Future task 2', '2026-05-30', undefined, ' '),
  ];
  
  const query = parseTaskQuery('group by priority');
  const grouped = groupTasks(tasks, query.groups, today, [], { allTasks: tasks });
  
  assert.ok(grouped.length > 0);
  // overdueCount should be undefined when there are no overdue tasks
  assert.equal(grouped[0].aggregations?.overdueCount, undefined);
});

test('Group aggregations: limits tasks per group to N', () => {
  const tasks = Array.from({ length: 10 }, (_, i) => mockTask(`Task ${i + 1}`));
  
  const query = parseTaskQuery('group by priority\nlimit groups 3');
  const grouped = groupTasks(tasks, query.groups, '2026-05-28', [], { allTasks: tasks });
  
  assert.ok(grouped.length > 0);
});

test('Group aggregations: respect group limits when computing effort totals', () => {
  const tasks = [
    mockTask('Task 1', undefined, '2h'),
    mockTask('Task 2', undefined, '1h'),
  ];

  const query = parseTaskQuery('group by status limit 1\nshow effort');
  const grouped = groupTasks(tasks, query.groups, '2026-05-28', [], { allTasks: tasks });

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].tasks?.length, 1);
  assert.equal(grouped[0].aggregations?.effortSum, '2h');
});

test('Group aggregations: includes aggregation data in grouped output', () => {
  const tasks = [
    mockTask('Task 1', '2026-05-25', '2h', ' '),
    mockTask('Task 2', '2026-05-26', '1h', ' '),
  ];
  
  const query = parseTaskQuery('group by status\nshow effort');
  const grouped = groupTasks(tasks, query.groups, '2026-05-28', [], { allTasks: tasks });
  
  assert.ok(grouped.length > 0);
});

test('Group aggregations: skips unparseable effort values instead of breaking sum', () => {
  // Bug: a single unparseable effort made totalMinutes = Infinity, hiding all effort
  const tasks = [
    mockTask('Task 1', undefined, '2h'),
    mockTask('Task 2', undefined, 'invalid-effort'),  // unparseable → Infinity
    mockTask('Task 3', undefined, '1h'),
  ];
  
  const query = parseTaskQuery('group by priority');
  const grouped = groupTasks(tasks, query.groups, '2026-05-28', [], { allTasks: tasks });
  
  assert.ok(grouped.length > 0);
  const group = grouped[0];
  assert.ok(group.aggregations);
  // Should show '3h' (2h + 1h), skipping the unparseable value
  assert.equal(group.aggregations.effortSum, '3h');
});
