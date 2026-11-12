import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyTaskCompletionLifecycleToLine,
  calculateFirstRecurrenceDateForCompletedLine,
  TaskScanner,
} from '../src/task-scanner';
import { DEFAULT_SETTINGS, DEFAULT_TASK_STATES } from '../src/types';
import { StateStore, type PersistedState } from '../src/state-store';

function fakeFile(path: string): { path: string; extension: string; basename: string } {
  const name = path.split('/').pop() ?? path;
  return { path, extension: path.endsWith('.md') ? 'md' : '', basename: name.replace(/\.md$/u, '') };
}

function stateStore(initial: Partial<PersistedState> = {}): { store: StateStore; getData: () => unknown } {
  let data: unknown = { state: { version: 1, snapshot: [], completions: [], recurrenceCounts: {}, ...initial } };
  const plugin = {
    loadData: async () => data,
    saveData: async (next: unknown) => { data = next; },
  };
  return { store: new StateStore(plugin as never), getData: () => data };
}

test('p2c: recurrence exception suppresses generated next occurrence', async () => {
  const file = fakeFile('Project.md');
  let content = '- [ ] Review 🔁 every week 📅 2026-05-19 [series:: abc123]\n';
  const app = {
    vault: {
      read: async () => content,
      process: async (_file: unknown, cb: (current: string) => string) => { content = cb(content); },
    },
  };
  const { store } = stateStore({
    recurrenceExceptions: {
      abc123: [{ seriesId: 'abc123', date: '2026-05-26', reason: 'deleted', createdAtIso: '2026-05-20T00:00:00.000Z' }],
    },
  });
  const scanner = new TaskScanner(
    app as never,
    () => DEFAULT_TASK_STATES,
    () => '',
    () => ({ ...DEFAULT_SETTINGS, recurrenceFutureOccurrences: 1, setCreatedDate: false }),
    () => store,
  );
  const [task] = await scanner.scanFile(file as never);
  await scanner.updateTaskCheckbox(file as never, task, 'x');
  assert.match(content, /^- \[x\] Review 🔁 every week 📅 2026-05-19/mu);
  assert.doesNotMatch(content, /2026-05-26/u);
});

test('p2c: StateStore stores recurrence exceptions without duplicates', async () => {
  const { store } = stateStore();
  const state = await store.loadState();
  const withException = store.addRecurrenceException(state, { seriesId: 'series-a', date: '2026-05-28', reason: 'skipped' });
  const duplicate = store.addRecurrenceException(withException, { seriesId: 'series-a', date: '2026-05-28', reason: 'skipped' });
  assert.equal(store.getRecurrenceExceptions(duplicate, 'series-a').length, 1);
  assert.equal(store.hasRecurrenceException(duplicate, 'series-a', '2026-05-28'), true);
});

test('p2c fix: first when-done recurrence date uses today when suppressing next occurrence', () => {
  const next = calculateFirstRecurrenceDateForCompletedLine(
    '- [ ] Take vitamins 🔁 every day when done 📅 2026-05-20 [series:: vitamins]',
    'x',
    DEFAULT_TASK_STATES,
    { ...DEFAULT_SETTINGS, recurrenceFutureOccurrences: 1, setDoneDate: false, setCreatedDate: false },
    '2026-05-28',
  );
  assert.equal(next, '2026-05-29');
});

test('p2c fix: editor lifecycle recurrence generation can filter recurrence exceptions', () => {
  const lines = applyTaskCompletionLifecycleToLine(
    '- [ ] Review 🔁 every week 📅 2026-05-19 [series:: abc123]',
    'x',
    DEFAULT_TASK_STATES,
    { ...DEFAULT_SETTINGS, recurrenceFutureOccurrences: 1, setDoneDate: false, setCreatedDate: false },
    '2026-05-20',
    (nextLine) => !nextLine.includes('2026-05-26'),
  );
  assert.deepEqual(lines, ['- [x] Review 🔁 every week 📅 2026-05-19 [series:: abc123]']);
});

test('editor lifecycle writes a durable recurrence count for scan reconciliation', () => {
  const lines = applyTaskCompletionLifecycleToLine(
    '- [ ] Review 🔁 every week 📅 2026-05-19 [recurrenceCount:: 2]',
    'x',
    DEFAULT_TASK_STATES,
    { ...DEFAULT_SETTINGS, trackRecurrenceCount: true, recurrenceFutureOccurrences: 1, setDoneDate: false, setCreatedDate: false },
    '2026-05-20',
  );
  assert.equal(lines?.length, 2);
  assert.ok(lines?.every((line) => line.includes('[recurrenceCount:: 3]')));
});
