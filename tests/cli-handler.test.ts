/**
 * CLI Handler Tests
 * Tests for CliHandler.executeQuery() and CliHandler.formatOutput() against the real API.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { CliHandler } from '../src/cli-handler';
import { TaskScanner } from '../src/task-scanner';
import { DEFAULT_SETTINGS, type TaskManagerSettings } from '../src/types';
import { MockApp } from './test-utils';
import type { ParsedTask } from '../src/task-scanner';
import { setGlobalMutationLog } from '../src/mutation-log';

function scanner(): TaskScanner {
  return new TaskScanner({} as never);
}

function settings(patch: Partial<TaskManagerSettings> = {}): TaskManagerSettings {
  return { ...DEFAULT_SETTINGS, ...patch } as TaskManagerSettings;
}

function makeHandler(taskList: ParsedTask[], patch: Partial<TaskManagerSettings> = {}): CliHandler {
  return new CliHandler(
    new MockApp() as never,
    scanner(),
    () => settings(patch),
    () => taskList,
  );
}

test('cli-handler registers the Obsidian Plugin CLI contract and consumes CliData flags', async () => {
  const tasks = [scanner().parseTaskLine('- [ ] Open task', 'Tasks.md', 1)!];
  let command = '';
  let description = '';
  let flags: Record<string, unknown> | null = null;
  let callback: ((params: Record<string, string | 'true'>) => string | Promise<string>) | undefined;
  let ready = false;
  const handler = new CliHandler(
    new MockApp() as never,
    scanner(),
    () => settings(),
    () => tasks,
    (nextCommand, nextDescription, nextFlags, nextCallback) => {
      command = nextCommand;
      description = nextDescription;
      flags = nextFlags;
      callback = nextCallback;
    },
    async () => { ready = true; },
  );

  handler.register();
  assert.equal(command, 'task-manager:query');
  assert.match(description, /Query Task Manager/u);
  assert.ok(flags && 'query' in flags);
  assert.ok(callback);
  const output = await callback({ query: 'not done', format: 'json' });
  const parsed = JSON.parse(output) as { success: boolean; data: { count: number } };
  assert.equal(ready, true);
  assert.equal(parsed.success, true);
  assert.equal(parsed.data.count, 1);

  const encoded = Buffer.from('not done', 'utf8').toString('base64url');
  const encodedOutput = await callback({ query64: encoded, format: 'json' });
  assert.equal((JSON.parse(encodedOutput) as { data: { count: number } }).data.count, 1);
});

// ── Query Execution ──────────────────────────────────

test('cli-handler: executeQuery returns success and task array for valid query', async () => {
  const tasks = [
    scanner().parseTaskLine('- [ ] Task 1', 'Test.md', 1)!,
    scanner().parseTaskLine('- [x] Task 2', 'Test.md', 2)!,
  ];
  const handler = makeHandler(tasks);

  const result = await handler.executeQuery('not done');

  assert.equal(result.apiVersion, 1);
  assert.equal(result.success, true);
  assert.ok(result.data);
  assert.equal(result.data.count, 1);
  assert.equal(result.data.tasks[0].normalizedText, 'Task 1');
});

test('cli-handler: executeQuery returns success:false for empty query string', async () => {
  const handler = makeHandler([]);

  const result = await handler.executeQuery('');

  assert.equal(result.success, false);
  assert.ok(result.error);
  assert.ok(result.error.length > 0);
});

test('cli-handler: executeQuery returns success:false for whitespace-only query', async () => {
  const handler = makeHandler([]);

  const result = await handler.executeQuery('   ');

  assert.equal(result.success, false);
  assert.ok(result.error);
});

test('cli-handler: executeQuery includes executionTime in result', async () => {
  const handler = makeHandler([]);

  const result = await handler.executeQuery('not done');

  assert.ok(typeof result.executionTime === 'number');
  assert.ok(result.executionTime >= 0);
});

test('cli-handler: executeQuery filters to done tasks', async () => {
  const tasks = [
    scanner().parseTaskLine('- [ ] Open task', 'Test.md', 1)!,
    scanner().parseTaskLine('- [x] Done task', 'Test.md', 2)!,
    scanner().parseTaskLine('- [ ] Another open', 'Test.md', 3)!,
  ];
  const handler = makeHandler(tasks);

  const result = await handler.executeQuery('done');

  assert.equal(result.success, true);
  assert.equal(result.data?.count, 1);
  assert.equal(result.data?.tasks[0].normalizedText, 'Done task');
});

test('cli-handler: executeQuery with empty task list returns success with zero count', async () => {
  const handler = makeHandler([]);

  const result = await handler.executeQuery('not done');

  assert.equal(result.success, true);
  assert.equal(result.data?.count, 0);
  assert.deepEqual(result.data?.tasks, []);
});

test('cli-handler: executeQuery handles parse error gracefully', async () => {
  const handler = makeHandler([]);

  // An expression that triggers a runtime error inside executeQuery
  // (executeQuery wraps any thrown error and returns success:false)
  const result = await handler.executeQuery('filter by function throw new Error("boom")');

  // Should not throw — result must be a valid CliQueryResult
  assert.ok(result);
  assert.equal(typeof result.success, 'boolean');
});

test('cli-handler: read-only queries never write mutation-log entries', async () => {
  let writes = 0;
  setGlobalMutationLog({ logMutation: async () => { writes += 1; return null; } } as never);
  try {
    const sensitiveTask = scanner().parseTaskLine('- [ ] Sensitive client task', 'Private.md', 1);
    assert.ok(sensitiveTask);
    const handler = makeHandler([sensitiveTask]);
    await handler.executeQuery('description includes Sensitive');
    await handler.executeQuery('filter by function throw new Error("secret query")');
    assert.equal(writes, 0);
  } finally {
    setGlobalMutationLog(null as never);
  }
});

// ── Format Output ──────────────────────────────────

test('cli-handler: formatOutput json returns parseable JSON with tasks array', async () => {
  const tasks = [
    scanner().parseTaskLine('- [ ] Task 1', 'Test.md', 1)!,
  ];
  const handler = makeHandler(tasks);
  const queryResult = await handler.executeQuery('not done');

  const output = handler.formatOutput(queryResult, 'json');

  assert.ok(output);
  const parsed = JSON.parse(output);
  assert.equal(parsed.success, true);
  assert.ok(Array.isArray(parsed.data.tasks));
});

test('cli-handler: formatOutput csv has column headers', async () => {
  const tasks = [
    scanner().parseTaskLine('- [ ] Task 1', 'Test.md', 1)!,
  ];
  const handler = makeHandler(tasks);
  const queryResult = await handler.executeQuery('not done');

  const output = handler.formatOutput(queryResult, 'csv');

  assert.ok(output);
  const firstLine = output.split('\n')[0];
  assert.ok(firstLine.includes('Status') || firstLine.includes('status'));
  assert.ok(firstLine.includes(','));
});

test('cli-handler: formatOutput csv includes data row for each task', async () => {
  const tasks = [
    scanner().parseTaskLine('- [ ] Task A', 'Notes.md', 3)!,
    scanner().parseTaskLine('- [ ] Task B', 'Notes.md', 4)!,
  ];
  const handler = makeHandler(tasks);
  const queryResult = await handler.executeQuery('not done');

  const output = handler.formatOutput(queryResult, 'csv');
  const lines = output.trim().split('\n');

  // header + 2 data rows
  assert.equal(lines.length, 3);
});

test('cli-handler: formatOutput csv preserves exact checkbox marker', async () => {
  const tasks = [
    scanner().parseTaskLine('- [?] Waiting task', 'Notes.md', 3)!,
  ];
  const handler = makeHandler(tasks);
  const queryResult = await handler.executeQuery('not done');

  const output = handler.formatOutput(queryResult, 'csv');
  const dataRow = output.split('\n')[1];

  assert.equal(dataRow.split(',')[2], '?');
  assert.doesNotMatch(dataRow, /blocked/u);
});

test('cli-handler: formatOutput csv quotes checkbox markers containing commas', async () => {
  const tasks = [
    scanner().parseTaskLine('- [a,b] Custom comma status', 'Notes.md', 3)!,
  ];
  const handler = makeHandler(tasks);
  const queryResult = await handler.executeQuery('not done');

  const output = handler.formatOutput(queryResult, 'csv');
  const dataRow = output.split('\n')[1];

  assert.equal(dataRow, 'Notes.md,3,"a,b",Custom comma status,normal,,');
});

test('cli-handler: formatOutput markdown has table header row', async () => {
  const tasks = [
    scanner().parseTaskLine('- [ ] Task 1', 'Test.md', 1)!,
  ];
  const handler = makeHandler(tasks);
  const queryResult = await handler.executeQuery('not done');

  const output = handler.formatOutput(queryResult, 'markdown');

  assert.ok(output);
  assert.ok(output.includes('|'));
  // Separator row
  assert.ok(output.includes('---'));
});

test('cli-handler: formatOutput markdown includes task total line', async () => {
  const tasks = [
    scanner().parseTaskLine('- [ ] Task 1', 'Test.md', 1)!,
  ];
  const handler = makeHandler(tasks);
  const queryResult = await handler.executeQuery('not done');

  const output = handler.formatOutput(queryResult, 'markdown');

  assert.ok(output.includes('1 task'));
});

test('cli-handler: formatOutput markdown preserves exact checkbox marker', async () => {
  const tasks = [
    scanner().parseTaskLine('- [!] Blocked task', 'Notes.md', 3)!,
  ];
  const handler = makeHandler(tasks);
  const queryResult = await handler.executeQuery('not done');

  const output = handler.formatOutput(queryResult, 'markdown');

  assert.match(output, /\| Notes\.md \| 3 \| ! \| Blocked task \|/u);
  assert.doesNotMatch(output, /\| blocked \|/u);
});

test('cli-handler: formatOutput markdown neutralizes link/wikilink syntax in task text', async () => {
  const tasks = [
    scanner().parseTaskLine('- [ ] [Click here](https://evil.example) [[Secret Note]]', 'Notes.md', 1)!,
  ];
  const handler = makeHandler(tasks);
  const queryResult = await handler.executeQuery('not done');

  const output = handler.formatOutput(queryResult, 'markdown');

  assert.ok(output.includes('\\[Click here\\]\\(https://evil.example\\)'), 'markdown link syntax must be escaped, not rendered live');
  assert.ok(output.includes('\\[\\[Secret Note\\]\\]'), 'wikilink syntax must be escaped, not rendered live');
  assert.ok(output.includes('Click here'), 'the visible task text should still be present');
});

test('cli-handler: formatOutput returns JSON error for failed result', async () => {
  const handler = makeHandler([]);
  const failedResult = await handler.executeQuery('');  // returns success:false

  const output = handler.formatOutput(failedResult, 'json');

  assert.ok(output);
  const parsed = JSON.parse(output);
  assert.equal(parsed.success, false);
  assert.ok(parsed.error);
});

// ── Helper Methods ──────────────────────────────────

test('cli-handler: getTasksByStatus returns matching tasks', async () => {
  const tasks = [
    scanner().parseTaskLine('- [ ] Open task', 'Test.md', 1)!,
    scanner().parseTaskLine('- [x] Done task', 'Test.md', 2)!,
  ];
  const handler = makeHandler(tasks);

  const result = await handler.getTasksByStatus('done');

  assert.deepEqual(result.map((task) => task.normalizedText), ['Done task']);
});

test('cli-handler: getTasksByStatus trims status input and rejects empty values', async () => {
  const tasks = [
    scanner().parseTaskLine('- [ ] Open task', 'Test.md', 1)!,
    scanner().parseTaskLine('- [x] Done task', 'Test.md', 2)!,
  ];
  const handler = makeHandler(tasks);

  const doneResult = await handler.getTasksByStatus(' done ');
  const emptyResult = await handler.getTasksByStatus('   ');

  assert.deepEqual(doneResult.map((task) => task.normalizedText), ['Done task']);
  assert.deepEqual(emptyResult, []);
});

test('cli-handler: getOverdueTasks returns array', async () => {
  const tasks = [
    scanner().parseTaskLine('- [ ] Overdue task 📅 2020-01-01', 'Test.md', 1)!,
    scanner().parseTaskLine('- [ ] Future task 📅 2099-12-31', 'Test.md', 2)!,
  ];
  const handler = makeHandler(tasks);

  const result = await handler.getOverdueTasks();

  assert.ok(Array.isArray(result));
  // Overdue task has due date in past — should match 'not done due before today'
  assert.ok(result.length >= 1);
});

test('cli-handler: getDueToday returns array', async () => {
  const handler = makeHandler([]);

  const result = await handler.getDueToday();

  assert.ok(Array.isArray(result));
});
