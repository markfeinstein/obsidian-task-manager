import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveReminderTaskForCompletion } from '../src/reminder-task-resolution';
import { TaskScanner } from '../src/task-scanner';
import { DEFAULT_SETTINGS, DEFAULT_TASK_STATES } from '../src/types';

function makeScanner(contentRef: { value: string }): TaskScanner {
  return new TaskScanner(
    {
      vault: {
        read: async () => contentRef.value,
        process: async (_file: unknown, callback: (content: string) => string) => { contentRef.value = callback(contentRef.value); },
      },
    } as never,
    () => DEFAULT_TASK_STATES,
    () => '',
    () => ({ ...DEFAULT_SETTINGS, setDoneDate: false, setCreatedDate: false }),
  );
}

test('reminder completion relocates a uniquely shifted task without completing a destructive neighbor', async () => {
  const expectedLine = '- [ ] Target task ⏰ 2026-07-11 09:30';
  const contentRef = {
    value: [
      '- [ ] Destructive neighbor 🏁 delete ⏰ 2026-07-11 09:30',
      expectedLine,
      '',
    ].join('\n'),
  };
  const scanner = makeScanner(contentRef);
  const task = resolveReminderTaskForCompletion(contentRef.value, {
    filePath: 'Tasks.md',
    lineNumber: 1,
    taskText: expectedLine,
    reminder: '2026-07-11 09:30',
  }, scanner);

  assert.equal(task.lineNumber, 2);
  await scanner.updateTaskCheckbox({ path: 'Tasks.md' } as never, task, 'x');
  assert.match(contentRef.value, /^- \[ \] Destructive neighbor 🏁 delete/mu);
  assert.match(contentRef.value, /^- \[x\] Target task/mu);
});

test('reminder completion refuses an ambiguous shifted identity', () => {
  const expectedLine = '- [ ] Duplicate ⏰ 2026-07-11 09:30';
  const contentRef = {
    value: [
      '- [ ] Occupies old line 🏁 delete',
      expectedLine,
      expectedLine,
      '',
    ].join('\n'),
  };
  const scanner = makeScanner(contentRef);

  assert.throws(() => resolveReminderTaskForCompletion(contentRef.value, {
    filePath: 'Tasks.md',
    lineNumber: 1,
    taskText: expectedLine,
    reminder: '2026-07-11 09:30',
  }, scanner), /matches multiple tasks/u);
  assert.doesNotMatch(contentRef.value, /\[x\]/u);
});

test('reminder completion refuses a text match with a different reminder identity', () => {
  const expectedLine = '- [ ] Target task ⏰ 2026-07-11 09:30';
  const contentRef = { value: '- [ ] Target task ⏰ 2026-07-12 09:30\n' };
  const scanner = makeScanner(contentRef);
  assert.throws(() => resolveReminderTaskForCompletion(contentRef.value, {
    filePath: 'Tasks.md',
    lineNumber: 1,
    taskText: expectedLine,
    reminder: '2026-07-11 09:30',
  }, scanner), /no longer matches/u);
});

test('reminder completion validates the expected line and prefers a stable task id when relocated', () => {
  const expectedLine = '- [ ] Original title 🆔 stable-reminder ⏰ 2026-07-11 09:30';
  const contentRef = {
    value: [
      '- [ ] Inserted line',
      '- [ ] Renamed title 🆔 stable-reminder ⏰ 2026-07-11 09:30',
      '',
    ].join('\n'),
  };
  const scanner = makeScanner(contentRef);
  const relocated = resolveReminderTaskForCompletion(contentRef.value, {
    filePath: 'Tasks.md',
    lineNumber: 1,
    taskText: expectedLine,
    reminder: '2026-07-11 09:30',
  }, scanner);
  assert.equal(relocated.lineNumber, 2);
  assert.equal(relocated.metadata.id, 'stable-reminder');

  const exactContent = `${expectedLine}\n${expectedLine}\n`;
  const exact = resolveReminderTaskForCompletion(exactContent, {
    filePath: 'Tasks.md',
    lineNumber: 1,
    taskText: expectedLine,
    reminder: '2026-07-11 09:30',
  }, scanner);
  assert.equal(exact.lineNumber, 1, 'a validated original line does not require global uniqueness');
});
