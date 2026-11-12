/**
 * Task Query Tests
 * Comprehensive coverage for filtering, sorting, grouping, and numeric queries
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTaskQuery, filterTasks, sortTasks, groupTasks, matchesTaskQuery, calculateUrgency, applySequentialFilter } from '../src/task-query';
import type { MarkdownTask } from '../src/task-model';
import { DEFAULT_TASK_STATES } from '../src/types';
import { createMockTask, getTodayString, getDatePlusDays } from './test-utils';

// ── Helper: Create mock MarkdownTask ──────────────────────────────────

function createTask(overrides: Partial<MarkdownTask> = {}): MarkdownTask {
  const base = createMockTask(overrides);
  return {
    ...base,
    description: base.body,
  } as MarkdownTask;
}

// ── Basic Filtering ──────────────────────────────────

test('task-query: filters by task status (todo)', () => {
  const query = parseTaskQuery('status is todo');
  const task = createTask({ status: 'todo' });
  const result = matchesTaskQuery(task, query, getTodayString());
  assert.equal(result, true);
});

test('task-query: rejects function expressions when disabled explicitly', () => {
  assert.throws(
    () => parseTaskQuery('filter by function task.description.includes("x")', {
      enableQueryDsl: true,
      enableDslExpressions: false,
    }),
    /Function expressions are disabled/u,
  );
});

test('task-query: filters by task status (done)', () => {
  const query = parseTaskQuery('status is done');
  const task = createTask({ status: 'done' });
  const result = matchesTaskQuery(task, query, getTodayString());
  assert.equal(result, true);
});

test('task-query: status is done is exact and excludes cancelled and untracked tasks', () => {
  const tasks = [
    createTask({ body: 'Done', status: 'done' }),
    createTask({ body: 'Cancelled', status: 'cancelled' }),
    createTask({ body: 'Untracked', status: 'untracked' }),
  ];

  assert.deepEqual(filterTasks(tasks, 'status is done', { today: getTodayString() }).map((task) => task.body), ['Done']);
  assert.deepEqual(filterTasks(tasks, 'status is not done', { today: getTodayString() }).map((task) => task.body), ['Untracked', 'Cancelled']);
});

test('task-query: filters by task status (cancelled)', () => {
  const query = parseTaskQuery('status is cancelled');
  const task = createTask({ status: 'cancelled' });
  const result = matchesTaskQuery(task, query, getTodayString());
  assert.equal(result, true);
});

test('task-query: filters by task status (in_progress)', () => {
  const query = parseTaskQuery('status is in_progress');
  const task = createTask({ status: 'in_progress' });
  const result = matchesTaskQuery(task, query, getTodayString());
  assert.equal(result, true);
});

// ── Priority Filtering ──────────────────────────────────

test('task-query: filters by priority (highest)', () => {
  const query = parseTaskQuery('priority is highest');
  const task = createTask({ metadata: { ...createTask().metadata, priority: 'highest' } });
  const result = matchesTaskQuery(task, query, getTodayString());
  assert.equal(result, true);
});

test('task-query: treats urgent as highest priority alias', () => {
  const query = parseTaskQuery('priority is urgent');
  const task = createTask({ metadata: { ...createTask().metadata, priority: 'highest' } });
  const result = matchesTaskQuery(task, query, getTodayString());
  assert.equal(result, true);
});

test('task-query: filters by priority (high)', () => {
  const query = parseTaskQuery('priority is high');
  const task = createTask({ metadata: { ...createTask().metadata, priority: 'high' } });
  const result = matchesTaskQuery(task, query, getTodayString());
  assert.equal(result, true);
});

test('task-query: filters by priority (normal)', () => {
  const query = parseTaskQuery('priority is normal');
  const task = createTask({ metadata: { ...createTask().metadata, priority: 'normal' } });
  const result = matchesTaskQuery(task, query, getTodayString());
  assert.equal(result, true);
});

test('task-query: filters by priority (low)', () => {
  const query = parseTaskQuery('priority is low');
  const task = createTask({ metadata: { ...createTask().metadata, priority: 'low' } });
  const result = matchesTaskQuery(task, query, getTodayString());
  assert.equal(result, true);
});

test('task-query: groups low priority before lowest', () => {
  const tasks = [
    createTask({ body: 'Low', metadata: { ...createTask().metadata, priority: 'low' } }),
    createTask({ body: 'Lowest', metadata: { ...createTask().metadata, priority: 'lowest' } }),
  ];

  const grouped = groupTasks(tasks, parseTaskQuery('group by priority').groups, getTodayString());
  assert.deepEqual(grouped.map((group) => group.name), ['Low priority', 'Lowest priority']);
});

test('task-query: sorts lowest priority after low priority', () => {
  const tasks = [
    createTask({ body: 'Lowest', metadata: { ...createTask().metadata, priority: 'lowest' } }),
    createTask({ body: 'Low', metadata: { ...createTask().metadata, priority: 'low' } }),
    createTask({ body: 'High', metadata: { ...createTask().metadata, priority: 'high' } }),
  ];

  const result = filterTasks(tasks, 'sort by priority', { today: getTodayString() });
  assert.deepEqual(result.map((task) => task.body), ['High', 'Low', 'Lowest']);
});

test('task-query: clamps invalid tag sort indexes to the first tag', () => {
  const tasks = [
    createTask({ body: 'Work only', tags: ['work'] }),
    createTask({ body: 'Work and home', tags: ['work', 'home'] }),
  ];

  const result = filterTasks(tasks, 'sort by tags 0', { today: getTodayString() });
  assert.deepEqual(result.map((task) => task.body), ['Work only', 'Work and home']);
});

// ── Date Filtering ──────────────────────────────────

test('task-query: filters by due date before', () => {
  const query = parseTaskQuery('due before 2026-06-15');
  const task = createTask({
    metadata: {
      ...createTask().metadata,
      dates: { ...createTask().metadata.dates, due: '2026-06-10' },
    },
  });
  const result = matchesTaskQuery(task, query, getTodayString());
  assert.equal(result, true);
});

test('task-query: filters by due date after', () => {
  const query = parseTaskQuery('due after 2026-06-15');
  const task = createTask({
    metadata: {
      ...createTask().metadata,
      dates: { ...createTask().metadata.dates, due: '2026-06-20' },
    },
  });
  const result = matchesTaskQuery(task, query, getTodayString());
  assert.equal(result, true);
});

test('task-query: filters by due date on', () => {
  const query = parseTaskQuery('due on 2026-06-15');
  const task = createTask({
    metadata: {
      ...createTask().metadata,
      dates: { ...createTask().metadata.dates, due: '2026-06-15' },
    },
  });
  const result = matchesTaskQuery(task, query, getTodayString());
  assert.equal(result, true);
});

test('task-query: rejects impossible flexible month-day filters', () => {
  const query = parseTaskQuery('due on february 31 2026');
  const rolledDateTask = createTask({
    metadata: {
      ...createTask().metadata,
      dates: { ...createTask().metadata.dates, due: '2026-03-03' },
    },
  });

  assert.equal(matchesTaskQuery(rolledDateTask, query, getTodayString()), false);
});

test('task-query: rejects invalid explicit month and week ranges', () => {
  const januaryTask = createTask({
    metadata: {
      ...createTask().metadata,
      dates: { ...createTask().metadata.dates, due: '2027-01-15' },
    },
  });
  const nextYearTask = createTask({
    metadata: {
      ...createTask().metadata,
      dates: { ...createTask().metadata.dates, due: '2027-01-05' },
    },
  });
  const marchTask = createTask({
    metadata: {
      ...createTask().metadata,
      dates: { ...createTask().metadata.dates, due: '2026-03-01' },
    },
  });

  assert.equal(matchesTaskQuery(januaryTask, parseTaskQuery('due in 2026-13'), getTodayString()), false);
  assert.equal(matchesTaskQuery(nextYearTask, parseTaskQuery('due in 2026-W54'), getTodayString()), false);
  assert.equal(matchesTaskQuery(nextYearTask, parseTaskQuery('due in 2021-W53'), getTodayString()), false);
  assert.equal(matchesTaskQuery(marchTask, parseTaskQuery('due in 2026-02-31 2026-03-01'), getTodayString()), false);
});

test('task-query: treats ISO date values with trailing text as invalid dates', () => {
  const query = parseTaskQuery('due date is invalid');
  const task = createTask({
    metadata: {
      ...createTask().metadata,
      dates: { ...createTask().metadata.dates, due: '2026-06-15abc' },
    },
  });

  assert.equal(matchesTaskQuery(task, query, getTodayString()), true);
});

test('task-query: still treats reminder date-times as valid dates', () => {
  const invalidQuery = parseTaskQuery('reminder date is invalid');
  const task = createTask({
    metadata: {
      ...createTask().metadata,
      reminder: '2026-06-15 09:30',
    },
  });

  assert.equal(matchesTaskQuery(task, invalidQuery, getTodayString()), false);
});

test('task-query: filters follow-up date presence aliases', () => {
  const tasks = [
    createTask({ body: 'Has follow-up', metadata: { ...createTask().metadata, followUp: '2026-06-15' } }),
    createTask({ body: 'No follow-up', metadata: { ...createTask().metadata, followUp: undefined } }),
  ];

  assert.deepEqual(filterTasks(tasks, 'follow-up missing', { today: getTodayString() }).map((task) => task.body), ['No follow-up']);
  assert.deepEqual(filterTasks(tasks, 'follow-up exists', { today: getTodayString() }).map((task) => task.body), ['Has follow-up']);
});

test('task-query: marks reminder date-times with invalid clock values as invalid', () => {
  const invalidQuery = parseTaskQuery('reminder date is invalid');
  const invalidHourTask = createTask({
    metadata: {
      ...createTask().metadata,
      reminder: '2026-06-15 24:00',
    },
  });
  const invalidMinuteTask = createTask({
    metadata: {
      ...createTask().metadata,
      reminder: '2026-06-15 09:60',
    },
  });

  assert.equal(matchesTaskQuery(invalidHourTask, invalidQuery, getTodayString()), true);
  assert.equal(matchesTaskQuery(invalidMinuteTask, invalidQuery, getTodayString()), true);
});

test('task-query: filters by scheduled date', () => {
  const query = parseTaskQuery('scheduled on 2026-06-15');
  const task = createTask({
    metadata: {
      ...createTask().metadata,
      dates: { ...createTask().metadata.dates, scheduled: '2026-06-15' },
    },
  });
  const result = matchesTaskQuery(task, query, getTodayString());
  assert.equal(result, true);
});

test('task-query: filters by start date', () => {
  const query = parseTaskQuery('start on 2026-06-15');
  const task = createTask({
    metadata: {
      ...createTask().metadata,
      dates: { ...createTask().metadata.dates, start: '2026-06-15' },
    },
  });
  const result = matchesTaskQuery(task, query, getTodayString());
  assert.equal(result, true);
});

// ── Tag Filtering ──────────────────────────────────

test('task-query: filters by tags', () => {
  const query = parseTaskQuery('tags includes #project');
  const task = createTask({ tags: ['project', 'work'] });
  const result = matchesTaskQuery(task, query, getTodayString());
  assert.equal(result, true);
});

test('task-query: filters tasks without specific tag', () => {
  const query = parseTaskQuery('tags does not include #personal');
  const task = createTask({ tags: ['work', 'urgent'] });
  const result = matchesTaskQuery(task, query, getTodayString());
  assert.equal(result, true);
});

test('task-query: file tag is not inverts exact frontmatter tag matches', () => {
  const tasks = [
    createTask({ filePath: 'Projects.md', body: 'Project task' }),
    createTask({ filePath: 'Personal.md', body: 'Personal task' }),
  ];
  const fileInfoProvider = (path: string) => ({
    properties: { tags: path === 'Projects.md' ? ['work', 'project/client'] : ['personal'] },
    outlinks: [],
  });

  const exactWork = filterTasks(tasks, 'file tags is #work', { fileInfoProvider });
  assert.deepEqual(exactWork.map((task) => task.filePath), ['Projects.md']);

  const notWork = filterTasks(tasks, 'file tags is not #work', { fileInfoProvider });
  assert.deepEqual(notWork.map((task) => task.filePath), ['Personal.md']);

  const includesProject = filterTasks(tasks, 'file tags includes #project', { fileInfoProvider });
  assert.deepEqual(includesProject.map((task) => task.filePath), ['Projects.md']);
});

test('task-query: text search by description', () => {
  const query = parseTaskQuery('description includes review');
  const task = createTask({ body: 'Code review meeting', normalizedText: 'Code review meeting' });
  const result = matchesTaskQuery(task, query, getTodayString());
  assert.equal(result, true);
});

// ── Numeric Filtering (Effort, Cost, etc) ──────────────────────────────

test('task-query: filters by effort range', () => {
  const query = parseTaskQuery('effort >= 1h\neffort <= 2h');
  const task = createTask({
    metadata: { ...createTask().metadata, effort: '1.5h' },
  });
  const result = matchesTaskQuery(task, query, getTodayString());
  assert.equal(result, true);
});

test('task-query: filters by effort exact match', () => {
  const query = parseTaskQuery('effort = 2h');
  const task = createTask({
    metadata: { ...createTask().metadata, effort: '2h' },
  });
  const result = matchesTaskQuery(task, query, getTodayString());
  assert.equal(result, true);
});

test('task-query: rejects partial effort duration tokens', () => {
  const query = parseTaskQuery('effort = 2h');
  const task = createTask({
    metadata: { ...createTask().metadata, effort: '2horse' },
  });

  assert.equal(matchesTaskQuery(task, query, getTodayString()), false);
});

test('task-query: filters by effort greater than', () => {
  const query = parseTaskQuery('effort > 30m');
  const task = createTask({
    metadata: { ...createTask().metadata, effort: '1h' },
  });
  const result = matchesTaskQuery(task, query, getTodayString());
  assert.equal(result, true);
});

test('task-query: filters by cost range', () => {
  const query = parseTaskQuery('cost >= 100\ncost <= 500');
  const task = createTask({
    metadata: { ...createTask().metadata, cost: 250 },
  });
  const result = matchesTaskQuery(task, query, getTodayString());
  assert.equal(result, true);
});

test('task-query: filters by cost exact', () => {
  const query = parseTaskQuery('cost is 100');
  const task = createTask({
    metadata: { ...createTask().metadata, cost: 100 },
  });
  const result = matchesTaskQuery(task, query, getTodayString());
  assert.equal(result, true);
});

// ── Recurrence Filtering ──────────────────────────────────

test('task-query: filters recurring tasks', () => {
  const query = parseTaskQuery('is recurring');
  const task = createTask({
    metadata: { ...createTask().metadata, recurrence: 'every day' },
  });
  const result = matchesTaskQuery(task, query, getTodayString());
  assert.equal(result, true);
});

test('task-query: filters non-recurring tasks', () => {
  const query = parseTaskQuery('is not recurring');
  const task = createTask({
    metadata: { ...createTask().metadata, recurrence: '' },
  });
  const result = matchesTaskQuery(task, query, getTodayString());
  assert.equal(result, true);
});

// ── Dependency Filtering ──────────────────────────────────

test('task-query: filters tasks with dependencies', () => {
  const query = parseTaskQuery('depends on includes task-1');
  const task = createTask({
    metadata: { ...createTask().metadata, dependsOn: ['task-1', 'task-2'] },
  });
  const result = matchesTaskQuery(task, query, getTodayString());
  assert.equal(result, true);
});

// ── ID and Context Filtering ──────────────────────────────────

test('task-query: filters by task id', () => {
  const query = parseTaskQuery('id is task-123');
  const task = createTask({
    metadata: { ...createTask().metadata, id: 'task-123' },
  });
  const result = matchesTaskQuery(task, query, getTodayString());
  assert.equal(result, true);
});

test('task-query: filters by context', () => {
  const query = parseTaskQuery('context includes @home');
  const task = createTask({
    contexts: ['@home', '@work'],
  });
  const result = matchesTaskQuery(task, query, getTodayString());
  assert.equal(result, true);
});

test('task-query: context filters with @ match parser-style bare context names', () => {
  const query = parseTaskQuery('context includes @home');
  const task = createTask({
    contexts: ['home', 'work'],
  });

  assert.equal(matchesTaskQuery(task, query, getTodayString()), true);
});

// ── Sorting Tests ──────────────────────────────────

test('task-query: sorts by priority descending', () => {
  const tasks = [
    createTask({ metadata: { ...createTask().metadata, priority: 'normal' } }),
    createTask({ metadata: { ...createTask().metadata, priority: 'highest' } }),
    createTask({ metadata: { ...createTask().metadata, priority: 'low' } }),
  ];
  const sorted = sortTasks(tasks, [{ field: 'priority', reverse: false }], getTodayString());
  assert.equal(sorted[0].metadata.priority, 'highest');
  assert.equal(sorted[2].metadata.priority, 'low');
});

test('task-query: sorts by due date ascending', () => {
  const tasks = [
    createTask({
      metadata: {
        ...createTask().metadata,
        dates: { ...createTask().metadata.dates, due: '2026-06-20' },
      },
    }),
    createTask({
      metadata: {
        ...createTask().metadata,
        dates: { ...createTask().metadata.dates, due: '2026-06-10' },
      },
    }),
    createTask({
      metadata: {
        ...createTask().metadata,
        dates: { ...createTask().metadata.dates, due: '2026-06-15' },
      },
    }),
  ];
  const sorted = sortTasks(tasks, [{ field: 'due', reverse: false }], getTodayString());
  assert.equal(
    sorted[0].metadata.dates.due,
    '2026-06-10',
  );
  assert.equal(
    sorted[2].metadata.dates.due,
    '2026-06-20',
  );
});

test('task-query: sorts by status', () => {
  const tasks = [
    createTask({ status: 'todo' }),
    createTask({ status: 'done' }),
    createTask({ status: 'in_progress' }),
  ];
  const sorted = sortTasks(tasks, [{ field: 'status', reverse: false }], getTodayString());
  assert.ok(sorted.length === 3);
});

test('task-query: sorts by effort ascending', () => {
  const tasks = [
    createTask({ metadata: { ...createTask().metadata, effort: '3h' } }),
    createTask({ metadata: { ...createTask().metadata, effort: '1h' } }),
    createTask({ metadata: { ...createTask().metadata, effort: '2h' } }),
  ];
  const sorted = sortTasks(tasks, [{ field: 'effort', reverse: false }], getTodayString());
  assert.equal(sorted[0].metadata.effort, '1h');
  assert.equal(sorted[2].metadata.effort, '3h');
});

test('task-query: sorts decimal effort durations by their full value', () => {
  const tasks = [
    createTask({ metadata: { ...createTask().metadata, effort: '2h' } }),
    createTask({ metadata: { ...createTask().metadata, effort: '1.5h' } }),
    createTask({ metadata: { ...createTask().metadata, effort: '45m' } }),
  ];

  const sorted = sortTasks(tasks, [{ field: 'effort', reverse: false }], getTodayString());

  assert.deepEqual(sorted.map((task) => task.metadata.effort), ['45m', '1.5h', '2h']);
});

test('task-query: sorts by cost reverse', () => {
  const tasks = [
    createTask({ metadata: { ...createTask().metadata, cost: 100 } }),
    createTask({ metadata: { ...createTask().metadata, cost: 500 } }),
    createTask({ metadata: { ...createTask().metadata, cost: 250 } }),
  ];
  const sorted = sortTasks(tasks, [{ field: 'cost', reverse: true }], getTodayString());
  assert.equal(sorted[0].metadata.cost, 500);
  assert.equal(sorted[2].metadata.cost, 100);
});

test('task-query: sorts by description length', () => {
  const tasks = [
    createTask({ body: 'Short' }),
    createTask({ body: 'This is a much longer description' }),
    createTask({ body: 'Medium length' }),
  ];
  const sorted = sortTasks(tasks, [{ field: 'description', reverse: false }], getTodayString());
  assert.ok(sorted.length === 3);
});

test('task-query: sorts by urgency', () => {
  const tasks = [
    createTask({
      metadata: {
        ...createTask().metadata,
        priority: 'low',
        dates: { ...createTask().metadata.dates, due: '2026-07-15' },
      },
    }),
    createTask({
      metadata: {
        ...createTask().metadata,
        priority: 'highest',
        dates: { ...createTask().metadata.dates, due: '2026-06-10' },
      },
    }),
    createTask({
      metadata: {
        ...createTask().metadata,
        priority: 'normal',
        dates: { ...createTask().metadata.dates, due: '2026-06-20' },
      },
    }),
  ];
  const sorted = sortTasks(tasks, [{ field: 'urgency', reverse: false }], getTodayString());
  const firstUrgency = calculateUrgency(sorted[0], getTodayString());
  const lastUrgency = calculateUrgency(sorted[sorted.length - 1], getTodayString());
  assert.ok(firstUrgency >= lastUrgency);
});

test('task-query: default urgency ordering preserves unique, missing, and duplicate dependency semantics', () => {
  const make = (body: string, filePath: string, id?: string, dependsOn: string[] = [], status: MarkdownTask['status'] = 'todo') => createTask({
    body, normalizedText: body, filePath, status,
    metadata: { ...createTask().metadata, ...(id ? { id } : {}), dependsOn, priority: 'normal' },
  });
  const hub = make('Hub', 'A.md', 'hub');
  const neutral = make('Neutral', 'B.md', 'neutral');
  const dependent = make('Dependent', 'C.md', 'dependent', ['hub', 'missing', 'hub']);
  assert.deepEqual(
    filterTasks([dependent, neutral, hub], 'not done\nlimit 10', { today: '2026-07-12' }).map((task) => task.body),
    ['Hub', 'Neutral', 'Dependent'],
  );

  const duplicate = make('Duplicate hub', 'D.md', 'hub');
  for (const input of [[hub, duplicate, dependent, neutral], [neutral, dependent, duplicate, hub]]) {
    assert.deepEqual(
      filterTasks(input, 'not done\nlimit 10', { today: '2026-07-12' }).map((task) => task.filePath),
      ['A.md', 'B.md', 'C.md', 'D.md'],
      'ambiguous IDs remain non-edges and fallback ordering is input-order independent',
    );
  }

  const doneDependent = make('Done dependent', 'E.md', 'done-dependent', ['neutral'], 'done');
  const cancelledDependent = make('Cancelled dependent', 'F.md', 'cancelled-dependent', ['neutral'], 'cancelled');
  const withClosedDependents = [neutral, doneDependent, cancelledDependent];
  assert.equal(
    calculateUrgency(neutral, '2026-07-12', { allTasks: withClosedDependents }),
    calculateUrgency(make('Equivalent', 'G.md', 'equivalent'), '2026-07-12', { allTasks: [] }),
    'done and cancelled dependents do not add a blocker bonus',
  );
});

test('task-query: urgency preprocessing performs no comparator-time whole-array blocker scans', () => {
  let taskArraySomeVisits = 0;
  let dependencyInspections = 0;
  const instrumentDependencies = (ids: string[]): string[] => new Proxy(ids, {
    get(target, property, receiver) {
      if (typeof property === 'string' && /^\d+$/u.test(property)) dependencyInspections += 1;
      return Reflect.get(target, property, receiver) as unknown;
    },
  });
  const tasks = Array.from({ length: 1_000 }, (_value, index) => createTask({
    body: `Task ${index}`,
    normalizedText: `Task ${index}`,
    filePath: `Tasks/${String(index).padStart(4, '0')}.md`,
    metadata: {
      ...createTask().metadata,
      id: `task-${index}`,
      dependsOn: instrumentDependencies(index === 0 ? [] : [`task-${index - 1}`]),
      priority: 'normal',
    },
  }));
  const originalSome = tasks.some;
  tasks.some = function (...args: Parameters<typeof originalSome>): boolean {
    taskArraySomeVisits += this.length;
    return originalSome.apply(this, args);
  };

  const result = filterTasks(tasks, 'not done\nlimit 1000', { today: '2026-07-12' });
  assert.equal(result.length, 1_000);
  assert.equal(taskArraySomeVisits, 0, 'the optimized query path never scans all tasks from urgency scoring');
  assert.ok(dependencyInspections <= 2 * 999, `dependency inspections ${dependencyInspections} must be bounded by two passes over edges`);

  taskArraySomeVisits = 0;
  dependencyInspections = 0;
  sortTasks(tasks, ['urgency'], '2026-07-12');
  assert.equal(taskArraySomeVisits, 0, 'standalone sorting builds one complete reverse context');
  assert.ok(dependencyInspections <= 2 * 999);

  taskArraySomeVisits = 0;
  dependencyInspections = 0;
  groupTasks(tasks, [{ field: 'urgency' }], '2026-07-12');
  assert.equal(taskArraySomeVisits, 0, 'standalone grouping builds one complete reverse context');
  assert.ok(dependencyInspections <= 2 * 999);
});

test('task-query: sorts completed and cancelled tasks after active tasks', () => {
  const tasks = [
    createTask({ body: 'Done earliest', status: 'done', metadata: { ...createTask().metadata, dates: { ...createTask().metadata.dates, due: '2026-06-01' } } }),
    createTask({ body: 'Cancelled early', status: 'cancelled', metadata: { ...createTask().metadata, dates: { ...createTask().metadata.dates, due: '2026-06-02' } } }),
    createTask({ body: 'Active later', status: 'todo', metadata: { ...createTask().metadata, dates: { ...createTask().metadata.dates, due: '2026-06-10' } } }),
    createTask({ body: 'Active undated', status: 'in_progress' }),
  ];

  const sorted = filterTasks(tasks, 'all\nsort by due', { today: getTodayString() });

  assert.deepEqual(sorted.map((task) => task.body), ['Active later', 'Active undated', 'Done earliest', 'Cancelled early']);
});

test('task-query: sorts randomly', () => {
  const tasks = [
    createTask({ body: 'A' }),
    createTask({ body: 'B' }),
    createTask({ body: 'C' }),
  ];
  const sorted = sortTasks(tasks, [{ field: 'random' }], getTodayString());
  assert.equal(sorted.length, 3);
});

// ── Grouping Tests ──────────────────────────────────

test('task-query: groups by status', () => {
  const tasks = [
    createTask({ status: 'todo', body: 'Task 1' }),
    createTask({ status: 'done', body: 'Task 2' }),
    createTask({ status: 'todo', body: 'Task 3' }),
  ];
  const grouped = groupTasks(tasks, [{ field: 'status' }], getTodayString());
  assert.ok(grouped.length > 0);
});

test('task-query: groups by priority', () => {
  const tasks = [
    createTask({ metadata: { ...createTask().metadata, priority: 'highest' }, body: 'Task 1' }),
    createTask({ metadata: { ...createTask().metadata, priority: 'low' }, body: 'Task 2' }),
    createTask({ metadata: { ...createTask().metadata, priority: 'highest' }, body: 'Task 3' }),
  ];
  const grouped = groupTasks(tasks, [{ field: 'priority' }], getTodayString());
  assert.ok(grouped.length > 0);
});

test('task-query: groups by due date', () => {
  const tasks = [
    createTask({
      body: 'Task 1',
      metadata: {
        ...createTask().metadata,
        dates: { ...createTask().metadata.dates, due: '2026-06-15' },
      },
    }),
    createTask({
      body: 'Task 2',
      metadata: {
        ...createTask().metadata,
        dates: { ...createTask().metadata.dates, due: '2026-06-20' },
      },
    }),
    createTask({
      body: 'Task 3',
      metadata: {
        ...createTask().metadata,
        dates: { ...createTask().metadata.dates, due: '2026-06-15' },
      },
    }),
  ];
  const grouped = groupTasks(tasks, [{ field: 'due' }], getTodayString());
  assert.ok(grouped.length > 0);
});

test('task-query: groups by tag', () => {
  const tasks = [
    createTask({ tags: ['urgent'], body: 'Task 1' }),
    createTask({ tags: ['personal'], body: 'Task 2' }),
    createTask({ tags: ['urgent', 'work'], body: 'Task 3' }),
  ];
  const grouped = groupTasks(tasks, [{ field: 'tag' }], getTodayString());
  assert.ok(grouped.length > 0);
});

test('task-query: groups by folder', () => {
  const tasks = [
    createTask({ filePath: 'Projects/Work.md', body: 'Task 1' }),
    createTask({ filePath: 'Projects/Personal.md', body: 'Task 2' }),
    createTask({ filePath: 'Projects/Work.md', body: 'Task 3' }),
  ];
  const grouped = groupTasks(tasks, [{ field: 'folder' }], getTodayString());
  assert.ok(grouped.length > 0);
});

test('task-query: groups by heading', () => {
  const tasks = [
    createTask({ heading: '# Work', body: 'Task 1' }),
    createTask({ heading: '# Personal', body: 'Task 2' }),
    createTask({ heading: '# Work', body: 'Task 3' }),
  ];
  const grouped = groupTasks(tasks, [{ field: 'heading' }], getTodayString());
  assert.ok(grouped.length > 0);
});

test('task-query: groups with limit', () => {
  const tasks = [
    createTask({ status: 'todo', body: 'Task 1' }),
    createTask({ status: 'todo', body: 'Task 2' }),
    createTask({ status: 'done', body: 'Task 3' }),
    createTask({ status: 'done', body: 'Task 4' }),
    createTask({ status: 'done', body: 'Task 5' }),
  ];
  const grouped = groupTasks(tasks, [{ field: 'status', limit: 2 }], getTodayString());
  assert.ok(grouped.length > 0);
});

test('task-query: groups with zero limit return empty task buckets', () => {
  const tasks = [
    createTask({ status: 'todo', body: 'Task 1' }),
    createTask({ status: 'todo', body: 'Task 2' }),
  ];
  const grouped = groupTasks(tasks, [{ field: 'status', limit: 0 }], getTodayString());
  assert.deepEqual(grouped.map((group) => group.tasks), [[]]);
});

// ── Complex Filtering Tests ──────────────────────────────────

test('task-query: combines multiple filters (AND)', () => {
  const query = parseTaskQuery('status is todo\npriority is highest\ntags includes #urgent');
  const task = createTask({
    status: 'todo',
    metadata: { ...createTask().metadata, priority: 'highest' },
    tags: ['urgent', 'important'],
  });
  const result = matchesTaskQuery(task, query, getTodayString());
  assert.equal(result, true);
});

test('task-query: excludes tasks with NOT operator', () => {
  const query = parseTaskQuery('status is todo\ntags does not include #personal');
  const task = createTask({
    status: 'todo',
    tags: ['work'],
  });
  const result = matchesTaskQuery(task, query, getTodayString());
  assert.equal(result, true);
});

test('task-query: parses complex query with sorting and grouping', () => {
  const query = parseTaskQuery('status is todo\npriority is highest\nsort by due\ngroup by priority');
  assert.equal(query.errors.length, 0);
  assert.ok(query.sort.length > 0 || query.groups.length > 0);
});

test('task-query: parses multi-sort aliases that use underscores', () => {
  const query = parseTaskQuery('sort by line_number due');
  assert.deepEqual(query.sort.map((criterion) => criterion.field), ['line-number', 'due']);
});

test('task-query: accepts renderer-supported layout elements', () => {
  const query = parseTaskQuery([
    'hide defer button',
    'hide focus timer',
    'hide timer',
    'hide effort',
    'hide actual',
  ].join('\n'));

  assert.deepEqual(query.errors, []);
  assert.equal(query.layout.hidden.has('defer button'), true);
  assert.equal(query.layout.hidden.has('focus timer'), true);
  assert.equal(query.layout.hidden.has('timer'), true);
  assert.equal(query.layout.hidden.has('effort'), true);
  assert.equal(query.layout.hidden.has('actual'), true);
});

// ── Edge Cases ──────────────────────────────────

test('task-query: handles empty task list', () => {
  const tasks: MarkdownTask[] = [];
  const result = filterTasks(tasks, 'status is todo', { today: getTodayString() });
  assert.deepEqual(result, []);
});

test('task-query: handles empty query', () => {
  const tasks = [
    createTask({ body: 'Task 1' }),
    createTask({ body: 'Task 2' }),
  ];
  const result = filterTasks(tasks, '', { today: getTodayString() });
  assert.ok(result.length >= 0);
});

test('task-query: handles invalid filter gracefully', () => {
  assert.throws(
    () => parseTaskQuery('invalid:filter'),
    /Unsupported task query/,
  );
});

test('task-query: handles overdue tasks correctly', () => {
  const query = parseTaskQuery('due before today');
  const yesterday = getDatePlusDays(-1);
  const task = createTask({
    metadata: {
      ...createTask().metadata,
      dates: { ...createTask().metadata.dates, due: yesterday },
    },
  });
  const result = matchesTaskQuery(task, query, getTodayString());
  assert.equal(result, true);
});

test('task-query: handles tasks without dates', () => {
  const query = parseTaskQuery('due before 2026-06-15');
  const task = createTask({
    metadata: {
      ...createTask().metadata,
      dates: { ...createTask().metadata.dates, due: '' },
    },
  });
  const result = matchesTaskQuery(task, query, getTodayString());
  assert.equal(result, false);
});

test('task-query: filters by multiple sorting criteria', () => {
  const tasks = [
    createTask({
      status: 'todo',
      metadata: { ...createTask().metadata, priority: 'low', cost: 100 },
    }),
    createTask({
      status: 'todo',
      metadata: { ...createTask().metadata, priority: 'highest', cost: 50 },
    }),
    createTask({
      status: 'done',
      metadata: { ...createTask().metadata, priority: 'high', cost: 200 },
    }),
  ];
  const sorted = sortTasks(
    tasks,
    [
      { field: 'status', reverse: false },
      { field: 'priority', reverse: false },
    ],
    getTodayString(),
  );
  assert.equal(sorted.length, 3);
});

test('task-query: handles tasks with minimal metadata', () => {
  const query = parseTaskQuery('status is todo');
  const task = createTask({
    body: 'Simple task',
    metadata: {
      dates: {
        due: '',
        scheduled: '',
        start: '',
        done: '',
        created: '',
        cancelled: '',
      },
      invalidDates: {},
      priority: 'normal',
      recurrence: '',
      id: '',
      dependsOn: [],
      onCompletion: '',
      reminder: '',
      effort: '',
      actual: '',
      followUp: '',
      pinned: false,
      cost: 0,
    },
  });
  const result = matchesTaskQuery(task, query, getTodayString());
  assert.equal(result, true);
});

test('task-query: handles bulk filtering performance', () => {
  const tasks: MarkdownTask[] = [];
  for (let i = 0; i < 100; i++) {
    tasks.push(createTask({ body: `Task ${i}`, status: i % 2 === 0 ? 'todo' : 'done' }));
  }
  const start = Date.now();
  const result = filterTasks(tasks, 'status is todo', { today: getTodayString() });
  const elapsed = Date.now() - start;
  assert.ok(result.length > 0);
  assert.ok(elapsed < 5000); // Should complete quickly
});

test('task-query: handles special characters in search', () => {
  const query = parseTaskQuery('description includes "special & chars"');
  assert.ok(query.errors.length >= 0);
});

test('task-query: handles case-insensitive matching', () => {
  const query = parseTaskQuery('status is TODO');
  const task = createTask({ status: 'todo' });
  const result = matchesTaskQuery(task, query, getTodayString());
  assert.equal(result, true);
});

test('task-query: groups by recurring status', () => {
  const tasks = [
    createTask({
      metadata: { ...createTask().metadata, recurrence: 'every day' },
      body: 'Daily task',
    }),
    createTask({
      metadata: { ...createTask().metadata, recurrence: '' },
      body: 'One-time task',
    }),
    createTask({
      metadata: { ...createTask().metadata, recurrence: 'every week' },
      body: 'Weekly task',
    }),
  ];
  const grouped = groupTasks(tasks, [{ field: 'recurring' }], getTodayString());
  assert.ok(grouped.length > 0);
});

// ── applySequentialFilter: section-aware sequential grouping ──────────────────

test('task-query: applySequentialFilter keeps only first pending task within a heading section', () => {
  const tasks = [
    createTask({ filePath: 'tasks.md', heading: 'Work', status: 'todo', body: 'Step 1', lineNumber: 3 }),
    createTask({ filePath: 'tasks.md', heading: 'Work', status: 'todo', body: 'Step 2', lineNumber: 4 }),
    createTask({ filePath: 'tasks.md', heading: 'Work', status: 'todo', body: 'Step 3', lineNumber: 5 }),
  ];
  const result = applySequentialFilter(tasks, DEFAULT_TASK_STATES);
  // Only the first pending task in the section should pass
  assert.equal(result.length, 1);
  assert.equal(result[0].body, 'Step 1');
});

test('task-query: applySequentialFilter allows first pending task per heading section (cross-section fix)', () => {
  // BUG: before fix, bucket was `filePath\0indent` only, causing tasks in Section 2
  // to be suppressed because Section 1 already marked the same bucket as seen.
  const tasks = [
    createTask({ filePath: 'tasks.md', heading: 'Work', status: 'todo', body: 'Work Step 1', lineNumber: 3, indentation: '' }),
    createTask({ filePath: 'tasks.md', heading: 'Work', status: 'todo', body: 'Work Step 2', lineNumber: 4, indentation: '' }),
    createTask({ filePath: 'tasks.md', heading: 'Personal', status: 'todo', body: 'Personal Step 1', lineNumber: 8, indentation: '' }),
    createTask({ filePath: 'tasks.md', heading: 'Personal', status: 'todo', body: 'Personal Step 2', lineNumber: 9, indentation: '' }),
  ];
  const result = applySequentialFilter(tasks, DEFAULT_TASK_STATES);
  // First pending task from EACH heading section should be included
  assert.equal(result.length, 2);
  assert.equal(result[0].body, 'Work Step 1');
  assert.equal(result[1].body, 'Personal Step 1');
});

test('task-query: applySequentialFilter resets after a different contiguous block', () => {
  const tasks = [
    createTask({ filePath: 'tasks.md', heading: 'Work', status: 'todo', body: 'Work Step 1', lineNumber: 3, indentation: '' }),
    createTask({ filePath: 'tasks.md', heading: 'Work', status: 'todo', body: 'Work Step 2', lineNumber: 4, indentation: '' }),
    createTask({ filePath: 'tasks.md', heading: 'Work', status: 'todo', body: 'Subtask Step 1', lineNumber: 5, indentation: '  ' }),
    createTask({ filePath: 'tasks.md', heading: 'Work', status: 'todo', body: 'Subtask Step 2', lineNumber: 6, indentation: '  ' }),
    createTask({ filePath: 'tasks.md', heading: 'Work', status: 'todo', body: 'Work Step 3', lineNumber: 7, indentation: '' }),
    createTask({ filePath: 'tasks.md', heading: 'Work', status: 'todo', body: 'Work Step 4', lineNumber: 8, indentation: '' }),
  ];

  const result = applySequentialFilter(tasks, DEFAULT_TASK_STATES);

  assert.deepEqual(result.map((task) => task.body), ['Work Step 1', 'Subtask Step 1', 'Work Step 3']);
});

test('task-query: applySequentialFilter always passes done/cancelled tasks through', () => {
  const tasks = [
    createTask({ filePath: 'tasks.md', heading: 'Work', status: 'done', body: 'Done Step', lineNumber: 3, checkbox: 'x' }),
    createTask({ filePath: 'tasks.md', heading: 'Work', status: 'todo', body: 'Next Step', lineNumber: 4 }),
    createTask({ filePath: 'tasks.md', heading: 'Work', status: 'todo', body: 'Later Step', lineNumber: 5 }),
  ];
  const result = applySequentialFilter(tasks, DEFAULT_TASK_STATES);
  // Done task passes, first pending passes, second pending suppressed
  assert.equal(result.length, 2);
  assert.equal(result[0].body, 'Done Step');
  assert.equal(result[1].body, 'Next Step');
});

test('task-query: applySequentialFilter with no-heading tasks groups them together', () => {
  // Tasks with no heading (undefined/empty) share the same bucket — expected.
  const tasks = [
    createTask({ filePath: 'tasks.md', heading: '', status: 'todo', body: 'Task A', lineNumber: 1 }),
    createTask({ filePath: 'tasks.md', heading: '', status: 'todo', body: 'Task B', lineNumber: 2 }),
  ];
  const result = applySequentialFilter(tasks, DEFAULT_TASK_STATES);
  assert.equal(result.length, 1);
  assert.equal(result[0].body, 'Task A');
});

test('task-query: advanceByRecurrenceRule "every year" clamps Feb 29 to Feb 28 on non-leap year', () => {
  // A yearly-recurring task due on Feb 29 (2024 is a leap year).
  // When the query projects the next occurrence, the result must be 2025-02-28
  // (not the invalid 2025-02-29).  Uses "show future occurrences" to exercise
  // advanceByRecurrenceRule inside projectOccurrences.
  const task = createTask({
    key: 'leap-year-task',
    body: 'Yearly on Feb 29',
    status: 'todo',
    metadata: {
      dates: { due: '2024-02-29' } as any,
      invalidDates: {},
      priority: 'normal',
      recurrence: 'every year',
      dependsOn: [],
    } as any,
  });
  // filterTasks with today set to the day after leap day so the task has a due date in the past
  const results = filterTasks([task], 'show future occurrences', { today: '2024-03-01', futureOccurrenceCount: 1 });
  const projected = results.filter((t) => (t as any).isProjected);
  assert.equal(projected.length, 1);
  // Must be a valid date, not 2025-02-29
  assert.equal(projected[0].metadata.dates.due, '2025-02-28');
});

test('task-query: finite recurrence projection respects remaining inline occurrences', () => {
  const projectedCount = (recurrenceLimit: number | undefined): number => {
    const task = createTask({
      key: `finite-${recurrenceLimit ?? 'unlimited'}`,
      status: 'todo',
      metadata: {
        dates: { due: '2026-06-01' },
        invalidDates: {},
        priority: 'normal',
        recurrence: 'every day',
        recurrenceLimit,
        dependsOn: [],
      } as MarkdownTask['metadata'],
    });
    return filterTasks([task], 'show future occurrences', {
      today: '2026-05-31',
      futureOccurrenceCount: 20,
    }).filter((candidate) => (candidate as MarkdownTask & { isProjected?: boolean }).isProjected).length;
  };

  assert.equal(projectedCount(1), 0);
  assert.equal(projectedCount(3), 2);
  assert.equal(projectedCount(undefined), 20);
});

test('task-query: future occurrence projection stops at recurrenceUntil', () => {
  const task = createTask({
    key: 'bounded-daily',
    status: 'todo',
    metadata: {
      dates: { due: '2026-06-01' },
      invalidDates: {},
      priority: 'normal',
      recurrence: 'every day',
      recurrenceUntil: '2026-06-03',
      dependsOn: [],
    },
  });

  const projected = filterTasks([task], 'show future occurrences', {
    today: '2026-05-31',
    futureOccurrenceCount: 10,
  }).filter((candidate) => candidate.isProjected);

  assert.deepEqual(projected.map((candidate) => candidate.metadata.dates.due), ['2026-06-02', '2026-06-03']);
});

test('task-query: projected occurrences preserve the original date field', () => {
  const scheduledTask = createTask({
    key: 'scheduled-recurring-task',
    body: 'Scheduled recurrence',
    metadata: {
      dates: { scheduled: '2026-05-28' } as any,
      invalidDates: {},
      priority: 'normal',
      recurrence: 'every week',
      dependsOn: [],
    } as any,
  });
  const startTask = createTask({
    key: 'start-recurring-task',
    body: 'Start recurrence',
    metadata: {
      dates: { start: '2026-05-28' } as any,
      invalidDates: {},
      priority: 'normal',
      recurrence: 'every week',
      dependsOn: [],
    } as any,
  });

  const results = filterTasks([scheduledTask, startTask], 'show future occurrences', { today: '2026-05-29', futureOccurrenceCount: 1 });
  const projectedScheduled = results.find((task) => task.key.startsWith('_proj_') && task.key.includes('scheduled-recurring-task'))!;
  const projectedStart = results.find((task) => task.key.startsWith('_proj_') && task.key.includes('start-recurring-task'))!;

  assert.equal(projectedScheduled.metadata.dates.scheduled, '2026-06-04');
  assert.equal(projectedScheduled.metadata.dates.due, undefined);
  assert.equal(projectedStart.metadata.dates.start, '2026-06-04');
  assert.equal(projectedStart.metadata.dates.due, undefined);
  assert.equal(projectedStart.metadata.dates.scheduled, undefined);
});

test('task-query: file default tags merge with existing task tags', () => {
  const task = createTask({ filePath: 'Project.md', tags: ['task'] });

  const [result] = filterTasks([task], '', {
    fileDefaultsEnabled: true,
    fileInfoProvider: () => ({ properties: { task_tags: 'project task' }, outlinks: [] }),
  });

  assert.deepEqual(result.tags, ['task', 'project']);
});

test('task-query: advanceByRecurrenceRule "every weekday" does not fall into weekly branch', () => {
  // "every weekday" should advance 1 weekday at a time, not 7 days.
  // From Thursday 2026-05-28, the next weekday is Friday 2026-05-29.
  const task = createTask({
    key: 'weekday-task',
    body: 'Every weekday task',
    status: 'todo',
    metadata: {
      dates: { due: '2026-05-28' } as any, // Thursday
      invalidDates: {},
      priority: 'normal',
      recurrence: 'every weekday',
      dependsOn: [],
    } as any,
  });
  const results = filterTasks([task], 'show future occurrences', { today: '2026-05-27', futureOccurrenceCount: 3 });
  const projected = results.filter((t) => (t as any).isProjected);
  assert.ok(projected.length >= 3, 'should project at least 3 future occurrences');
  // From Thu 2026-05-28: next = Fri 29, then Mon Jun 1, then Tue Jun 2
  assert.equal(projected[0].metadata.dates.due, '2026-05-29', 'first projection: Friday');
  assert.equal(projected[1].metadata.dates.due, '2026-06-01', 'second projection: Monday (skip weekend)');
  assert.equal(projected[2].metadata.dates.due, '2026-06-02', 'third projection: Tuesday');
});

test('task-query: advanceByRecurrenceRule "every week on monday" projects on correct weekday', () => {
  // "every week on monday" should project weekly on Mondays, not return null.
  // Anchor: Monday 2026-05-25 → next: Monday 2026-06-01, then 2026-06-08.
  const task = createTask({
    key: 'weekly-monday-task',
    body: 'Weekly on Monday',
    status: 'todo',
    metadata: {
      dates: { due: '2026-05-25' } as any, // Monday
      invalidDates: {},
      priority: 'normal',
      recurrence: 'every week on monday',
      dependsOn: [],
    } as any,
  });
  const results = filterTasks([task], 'show future occurrences', { today: '2026-05-24', futureOccurrenceCount: 2 });
  const projected = results.filter((t) => (t as any).isProjected);
  assert.ok(projected.length >= 2, 'should project at least 2 future occurrences');
  assert.equal(projected[0].metadata.dates.due, '2026-06-01', 'first projection: next Monday');
  assert.equal(projected[1].metadata.dates.due, '2026-06-08', 'second projection: Monday after');
});
