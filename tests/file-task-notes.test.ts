import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_TASK_STATES } from '../src/types';
import { buildTaskNoteFrontmatter, scanFileAsTask, isTaskNoteFile, serializeTaskNoteFrontmatter } from '../src/task-scanner';

// Mock file and app for testing
function fakeFile(path: string): any {
  const parts = path.split('/');
  return {
    path,
    name: parts[parts.length - 1],
    basename: parts[parts.length - 1].replace(/\.md$/, ''),
    extension: 'md',
    parent: parts.length > 1 ? { path: parts.slice(0, -1).join('/') } : null,
  };
}

function fakeApp(frontmatter?: Record<string, unknown>): any {
  return {
    metadataCache: {
      getFileCache: () => ({
        frontmatter: frontmatter || {},
      }),
    },
  };
}

function parseSerializedFrontmatter(yaml: string): Record<string, unknown> {
  const lines = yaml.split('\n');
  const result: Record<string, unknown> = {};
  for (const line of lines.slice(1)) {
    if (line === '---') break;
    const match = /^([^:]+):\s*(.*)$/u.exec(line);
    if (!match) continue;
    const [, key, rawValue] = match;
    if (rawValue === 'true') result[key] = true;
    else if (rawValue === 'false') result[key] = false;
    else if (/^-?\d+(?:\.\d+)?$/u.test(rawValue)) result[key] = Number(rawValue);
    else if (/^"/u.test(rawValue)) result[key] = JSON.parse(rawValue);
    else result[key] = rawValue;
  }
  return result;
}

// Test suite for file-backed task notes
test('isTaskNoteFile detects task files by folder', () => {
  const app = fakeApp({ task: true });
  const file = fakeFile('Tasks/MyTask.md');
  assert.equal(isTaskNoteFile(file, app, 'Tasks', 'task: true'), true);
});

test('isTaskNoteFile matches folders case-insensitive', () => {
  const app = fakeApp({ task: true });
  const file = fakeFile('Tasks/MyTask.md');
  assert.equal(isTaskNoteFile(file, app, 'tasks', 'task: true'), true);
});

test('isTaskNoteFile normalizes safe folder separators and ignores unsafe configured folders', () => {
  const app = fakeApp({});
  const file = fakeFile('Tasks/Sub/Task.md');
  assert.equal(isTaskNoteFile(file, app, 'Tasks\\Sub', 'task: true'), true);
  assert.equal(isTaskNoteFile(file, app, '../Tasks/Sub', 'task: true'), false);
});

test('isTaskNoteFile rejects non-matching folders', () => {
  const app = fakeApp({}); // No task marker in frontmatter
  const file = fakeFile('Notes/Task.md');
  assert.equal(isTaskNoteFile(file, app, 'Tasks', 'task: true'), false);
});

test('isTaskNoteFile detects by frontmatter marker', () => {
  const app = fakeApp({ task: true });
  const file = fakeFile('Notes/Task.md');
  assert.equal(isTaskNoteFile(file, app, '', 'task: true'), true);
});

test('isTaskNoteFile matches marker values containing colons', () => {
  const app = fakeApp({ taskType: 'task: next' });
  const file = fakeFile('Notes/Task.md');
  assert.equal(isTaskNoteFile(file, app, '', 'taskType: task: next'), true);
});

test('isTaskNoteFile rejects false marker values', () => {
  const app = fakeApp({ task: false });
  const file = fakeFile('Notes/Task.md');
  assert.equal(isTaskNoteFile(file, app, '', 'task: true'), false);
});

test('scanFileAsTask parses basic task', () => {
  const app = fakeApp({
    status: 'todo',
    description: 'Buy groceries',
  });
  const file = fakeFile('Tasks/Test.md');
  const task = scanFileAsTask(file, app, DEFAULT_TASK_STATES);

  assert(task !== null);
  assert.equal(task.status, 'todo');
  assert.equal(task.body, 'Buy groceries');
  assert.equal(task.filePath, 'Tasks/Test.md');
  assert.equal(task.lineNumber, 0);
});

test('scanFileAsTask converts status to checkbox', () => {
  const testCases: Array<[string, string]> = [
    ['todo', ' '],
    ['in_progress', '/'],
    ['done', 'x'],
    ['cancelled', '-'],
  ];

  for (const [status, expectedCheckbox] of testCases) {
    const app = fakeApp({ status, description: 'Test' });
    const file = fakeFile('Tasks/Test.md');
    const task = scanFileAsTask(file, app, DEFAULT_TASK_STATES);

    assert(task !== null, `status: ${status}`);
    assert.equal(task.checkbox, expectedCheckbox);
  }
});

test('scanFileAsTask parses priority', () => {
  const app = fakeApp({ priority: 'high', description: 'Test' });
  const file = fakeFile('Tasks/Test.md');
  const task = scanFileAsTask(file, app, DEFAULT_TASK_STATES);

  assert(task !== null);
  assert.equal(task.metadata.priority, 'high');
});

test('scanFileAsTask parses date fields', () => {
  const app = fakeApp({
    description: 'Test',
    due: '2026-06-15',
    scheduled: '2026-06-10',
  });
  const file = fakeFile('Tasks/Test.md');
  const task = scanFileAsTask(file, app, DEFAULT_TASK_STATES);

  assert(task !== null);
  assert.equal(task.metadata.dates.due, '2026-06-15');
  assert.equal(task.metadata.dates.scheduled, '2026-06-10');
});

test('scanFileAsTask ignores impossible frontmatter dates', () => {
  const app = fakeApp({
    description: 'Test',
    due: '2026-02-31',
    scheduled: '2026-06-10',
  });
  const file = fakeFile('Tasks/Test.md');
  const task = scanFileAsTask(file, app, DEFAULT_TASK_STATES);

  assert(task !== null);
  assert.equal(task.metadata.dates.due, undefined);
  assert.equal(task.metadata.dates.scheduled, '2026-06-10');
});

test('scanFileAsTask parses effort and actual', () => {
  const app = fakeApp({
    description: 'Test',
    effort: '2h 30m',
    actual: '1h 45m',
  });
  const file = fakeFile('Tasks/Test.md');
  const task = scanFileAsTask(file, app, DEFAULT_TASK_STATES);

  assert(task !== null);
  assert.equal(task.metadata.effort, '2h 30m');
  assert.equal(task.metadata.actual, '1h 45m');
});

test('scanFileAsTask parses cost as numeric', () => {
  const app = fakeApp({ cost: '125.50', description: 'Test' });
  const file = fakeFile('Tasks/Test.md');
  const task = scanFileAsTask(file, app, DEFAULT_TASK_STATES);

  assert(task !== null);
  assert.equal(task.metadata.cost, 125.50);
});

test('scanFileAsTask ignores invalid cost', () => {
  const app = fakeApp({ cost: 'not-a-number', description: 'Test' });
  const file = fakeFile('Tasks/Test.md');
  const task = scanFileAsTask(file, app, DEFAULT_TASK_STATES);

  assert(task !== null);
  assert.equal(task.metadata.cost, undefined);
});

test('scanFileAsTask preserves zero cost frontmatter', () => {
  const app = fakeApp({ cost: 0, description: 'Free task' });
  const file = fakeFile('Tasks/Test.md');
  const task = scanFileAsTask(file, app, DEFAULT_TASK_STATES);

  assert(task !== null);
  assert.equal(task.metadata.cost, 0);
});

test('scanFileAsTask parses collaboration fields', () => {
  const app = fakeApp({
    description: 'Test',
    assignee: 'alice',
    reviewer: 'bob',
    project: 'ProjectX',
    team: 'TeamA',
  });
  const file = fakeFile('Tasks/Test.md');
  const task = scanFileAsTask(file, app, DEFAULT_TASK_STATES);

  assert(task !== null);
  assert.equal(task.metadata.assignee, 'alice');
  assert.equal(task.metadata.reviewer, 'bob');
  assert.equal(task.metadata.project, 'ProjectX');
  assert.equal(task.metadata.team, 'TeamA');
});

test('scanFileAsTask parses recurrence', () => {
  const app = fakeApp({
    description: 'Test',
    recurrence: 'every week on Monday',
  });
  const file = fakeFile('Tasks/Test.md');
  const task = scanFileAsTask(file, app, DEFAULT_TASK_STATES);

  assert(task !== null);
  assert.equal(task.metadata.recurrenceRaw, 'every week on Monday');
});

test('scanFileAsTask parses pinned field', () => {
  const app = fakeApp({
    description: 'Test',
    pinned: true,
  });
  const file = fakeFile('Tasks/Test.md');
  const task = scanFileAsTask(file, app, DEFAULT_TASK_STATES);

  assert(task !== null);
  assert.equal(task.metadata.pinned, true);
});

test('scanFileAsTask does not treat quoted false pinned frontmatter as pinned', () => {
  const app = fakeApp({
    description: 'Test',
    pinned: 'false',
  });
  const file = fakeFile('Tasks/Test.md');
  const task = scanFileAsTask(file, app, DEFAULT_TASK_STATES);

  assert(task !== null);
  assert.equal(task.metadata.pinned, false);
});

test('scanFileAsTask extracts tags from description', () => {
  const app = fakeApp({
    description: 'Test task with #urgent #bug tags',
  });
  const file = fakeFile('Tasks/Test.md');
  const task = scanFileAsTask(file, app, DEFAULT_TASK_STATES);

  assert(task !== null);
  assert(task.tags.includes('urgent'));
  assert(task.tags.includes('bug'));
});

test('scanFileAsTask extracts contexts', () => {
  const app = fakeApp({
    description: 'Task for @alice and @bob',
  });
  const file = fakeFile('Tasks/Test.md');
  const task = scanFileAsTask(file, app, DEFAULT_TASK_STATES);

  assert(task !== null);
  assert(task.contexts.includes('alice'));
  assert(task.contexts.includes('bob'));
});

test('scanFileAsTask generates task key', () => {
  const app = fakeApp({ description: 'Test' });
  const file = fakeFile('Tasks/MyTask.md');
  const task = scanFileAsTask(file, app, DEFAULT_TASK_STATES);

  assert(task !== null);
  assert.equal(task.key, 'Tasks/MyTask.md:MyTask');
});

test('buildTaskNoteFrontmatter writes recognizable marker and metadata', () => {
  const app = fakeApp({
    task: true,
    id: 'task-123',
    status: 'todo',
    priority: 'high',
    due: '2026-06-15',
    scheduled: '2026-06-10',
    effort: '2h',
    recurrence: 'every week',
    description: 'Promoted task #work',
  });
  const file = fakeFile('Tasks/Promoted.md');
  const task = scanFileAsTask(file, app, DEFAULT_TASK_STATES);
  assert(task !== null);

  const frontmatter = buildTaskNoteFrontmatter(task, 'task: true', 'Projects/Source.md');

  assert.equal(frontmatter.task, true);
  assert.equal(frontmatter.id, 'task-123');
  assert.equal(frontmatter.status, 'todo');
  assert.equal(frontmatter.priority, 'high');
  assert.equal(frontmatter.due, '2026-06-15');
  assert.equal(frontmatter.scheduled, '2026-06-10');
  assert.equal(frontmatter.effort, '2h');
  assert.equal(frontmatter.recurrence, 'every week');
  assert.equal(frontmatter.sourceFile, 'Projects/Source.md');
});

test('scanFileAsTask and frontmatter preserve parent id interop', () => {
  const app = fakeApp({
    task: true,
    description: 'Child task',
    parent_id: 'parent-123',
  });
  const file = fakeFile('Tasks/Child.md');
  const task = scanFileAsTask(file, app, DEFAULT_TASK_STATES);

  assert(task !== null);
  assert.equal(task.metadata.parentId, 'parent-123');

  const frontmatter = buildTaskNoteFrontmatter(task, 'task: true', 'Projects/Source.md');
  assert.equal(frontmatter.parent_id, 'parent-123');
});

test('serializeTaskNoteFrontmatter creates YAML that marks a task note', () => {
  const yaml = serializeTaskNoteFrontmatter({ task: true, description: 'Promoted task', id: 'task-123' });

  assert.match(yaml, /^---\ntask: true\ndescription: Promoted task\nid: task-123\n---\n/u);
});

test('scanFileAsTask round-trips promoted task-note frontmatter', () => {
  const original = scanFileAsTask(fakeFile('Tasks/Promoted.md'), fakeApp({
    task: true,
    id: 'task-123',
    description: 'Promoted task',
    due: '2026-06-15',
    effort: '2h',
  }), DEFAULT_TASK_STATES);
  assert(original !== null);
  const fm = buildTaskNoteFrontmatter(original, 'task: true', 'Projects/Source.md');
  const roundTrip = scanFileAsTask(fakeFile('Tasks/Promoted.md'), fakeApp(fm), DEFAULT_TASK_STATES);

  assert(roundTrip !== null);
  assert.equal(roundTrip.metadata.id, 'task-123');
  assert.equal(roundTrip.metadata.dates.due, '2026-06-15');
  assert.equal(roundTrip.metadata.effort, '2h');
  assert.equal(roundTrip.body, 'Promoted task');
  assert.equal(roundTrip.key, 'id:task-123');
});

test('serialized task-note frontmatter quotes YAML-sensitive descriptions and round-trips', () => {
  for (const description of ['Promoted task #work', 'Call: Bob #work', 'Review [draft] "v2"\nNext line']) {
    const yaml = serializeTaskNoteFrontmatter({ task: true, id: 'task-123', description });
    assert.match(yaml, new RegExp(`description: ${JSON.stringify(description).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'u'));
    const parsed = parseSerializedFrontmatter(yaml);
    const roundTrip = scanFileAsTask(fakeFile('Tasks/Promoted.md'), fakeApp(parsed), DEFAULT_TASK_STATES);

    assert(roundTrip !== null);
    assert.equal(roundTrip.body, description);
    assert.equal(roundTrip.metadata.id, 'task-123');
  }
});

test('scanFileAsTask returns null without frontmatter', () => {
  const app = fakeApp(undefined);
  (app.metadataCache.getFileCache as any) = () => undefined;
  const file = fakeFile('Tasks/Test.md');
  const task = scanFileAsTask(file, app, DEFAULT_TASK_STATES);

  assert.equal(task, null);
});

test('scanFileAsTask handles 10+ field combinations', () => {
  const combinations = [
    { status: 'todo', priority: 'high', description: 'Test 1' },
    { due: '2026-06-15', scheduled: '2026-06-10', description: 'Test 2' },
    { effort: '2h', actual: '1h', cost: '100', description: 'Test 3' },
    { assignee: 'alice', reviewer: 'bob', team: 'DevTeam', description: 'Test 4' },
    { pinned: true, project: 'ProjectX', recurrence: 'weekly', description: 'Test 5' },
    { id: 'task-123', reminder: '2026-06-10', time: '14:00', description: 'Test 6' },
    {
      status: 'done',
      priority: 'medium',
      due: '2026-06-15',
      scheduled: '2026-06-10',
      effort: '3h',
      cost: '150',
      assignee: 'alice',
      project: 'ProjectX',
      pinned: true,
      description: 'Complex task with many fields',
    },
  ];

  const file = fakeFile('Tasks/Test.md');

  for (let i = 0; i < combinations.length; i++) {
    const fm = combinations[i];
    const app = fakeApp(fm);
    const task = scanFileAsTask(file, app, DEFAULT_TASK_STATES);

    assert(task !== null, `Failed for combination ${i}`);
    assert(task.body !== undefined && task.body.length > 0);
    assert(task.metadata !== undefined);
  }
});
