import test from 'node:test';
import assert from 'node:assert/strict';
import { TaskScanner } from '../src/task-scanner';
import { TaskHistoryTracker } from '../src/task-history';
import { DEFAULT_TASK_STATES, DEFAULT_SETTINGS } from '../src/types';

type FakeFile = { path: string; extension: string; basename: string };

function fakeFile(path: string): FakeFile {
  const name = path.split('/').pop() ?? path;
  return { path, extension: path.endsWith('.md') ? 'md' : '', basename: name.replace(/\.md$/u, '') };
}

test('task scanner editable metadata updates also log history changes when historyTracker is provided', async () => {
  let content = '- [ ] Audit ➕ 2026-05-18 🔺\n';
  const app = {
    vault: {
      read: async () => content,
      process: async (_file: FakeFile, updater: (value: string) => string) => {
        content = updater(content);
        return content;
      },
    },
  };
  const historyTracker = new TaskHistoryTracker();
  const scanner = new TaskScanner(
    app as never,
    () => DEFAULT_TASK_STATES,
    () => '',
    () => DEFAULT_SETTINGS,
    () => undefined,
    historyTracker,
  );
  const file = fakeFile('Project.md');
  let [task] = await scanner.scanFile(file as never);

  // Editing a date should record a date_change history entry.
  task = await scanner.updateTaskDate(file as never, task, 'due', '2026-05-20');
  let history = historyTracker.getTaskHistory(task.key);
  assert.ok(history);
  assert.equal(history!.entries.length, 1);
  assert.equal(history!.entries[0].action, 'date_change');
  assert.deepEqual(history!.entries[0].changedFields.due, { oldValue: undefined, newValue: '2026-05-20' });

  // Editing priority should record a priority_change history entry.
  task = await scanner.updateTaskPriority(file as never, task, 'low');
  history = historyTracker.getTaskHistory(task.key);
  assert.equal(history!.entries.length, 2);
  assert.equal(history!.entries[1].action, 'priority_change');
  assert.deepEqual(history!.entries[1].changedFields.priority, { oldValue: 'highest', newValue: 'low' });
});

test('task scanner does not record history when value is unchanged', async () => {
  let content = '- [ ] Audit 📅 2026-05-20\n';
  const app = {
    vault: {
      read: async () => content,
      process: async (_file: FakeFile, updater: (value: string) => string) => {
        content = updater(content);
        return content;
      },
    },
  };
  const historyTracker = new TaskHistoryTracker();
  const scanner = new TaskScanner(
    app as never,
    () => DEFAULT_TASK_STATES,
    () => '',
    () => DEFAULT_SETTINGS,
    () => undefined,
    historyTracker,
  );
  const file = fakeFile('Project.md');
  const [task] = await scanner.scanFile(file as never);

  // Re-applying the same due date must not create a spurious history entry.
  await scanner.updateTaskDate(file as never, task, 'due', '2026-05-20');
  const history = historyTracker.getTaskHistory(task.key);
  assert.ok(!history || history.entries.length === 0);
});
