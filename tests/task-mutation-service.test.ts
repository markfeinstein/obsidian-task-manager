import test from 'node:test';
import assert from 'node:assert/strict';
import type { App, TFile } from 'obsidian';
import { rewriteSyncInlineField, rewriteSyncTaskTitle, TaskMutationService } from '../src/task-mutation-service';
import { TaskScanner, type ParsedTask } from '../src/task-scanner';
import { executeScopeEdit } from '../src/recurrence-series';

const file = { path: 'notes/task.md' } as TFile;

function createScannerMock() {
  return {
    updateTaskCheckbox: async (_file: TFile, task: ParsedTask, checkbox: string) => ({ ...task, checkbox }),
    updateTaskDate: async (_file: TFile, task: ParsedTask, field: string, date: string | null) => ({ ...task, [field]: date }),
    updateTaskPriority: async (_file: TFile, task: ParsedTask, priority: string) => ({ ...task, priority }),
  } as const;
}

function createHarness(initialContent: string, identityGuard?: (task: ParsedTask) => void) {
  let content = initialContent;
  const app = {
    vault: {
      read: async () => content,
      cachedRead: async () => content,
      process: async (_file: TFile, callback: (current: string) => string) => { content = callback(content); },
      getAbstractFileByPath: () => file,
      getMarkdownFiles: () => [file],
    },
    metadataCache: { getFileCache: () => null },
  } as unknown as App;
  const scanner = new TaskScanner(app);
  const invalidated: string[] = [];
  const service = new TaskMutationService(app, scanner, () => [], (path: string) => invalidated.push(path), undefined, identityGuard);
  const parse = (line: string, lineNumber: number): ParsedTask => {
    const task = scanner.parseTaskLine(line, file.path, lineNumber);
    assert.ok(task);
    return task;
  };
  return {
    app,
    scanner,
    service,
    parse,
    invalidated,
    get content() { return content; },
    set content(value: string) { content = value; },
  };
}

test('updateTaskComments preserves untouched line endings when inserting inbound comments', async () => {
  // Mixed CRLF/LF file: the comment write must not normalize endings on lines it does not touch.
  const harness = createHarness('- [ ] Task\r\nline two\nline three\n');
  const task = harness.parse('- [ ] Task', 1);
  await harness.service.updateTaskComments(file, task, ['hello world']);
  const content = harness.content;
  assert.match(content, /- \[ \] Task\r\n/u, 'parent CRLF ending preserved');
  assert.ok(content.includes('💬 hello world'), 'comment bullet inserted');
  assert.ok(content.includes('line two\nline three\n'), 'untouched LF lines are not rewritten to CRLF');
});

test('updateTaskComments appends to a final unterminated task line without adding a trailing newline', async () => {
  const harness = createHarness('intro\n- [ ] Task');
  const task = harness.parse('- [ ] Task', 2);
  await harness.service.updateTaskComments(file, task, ['note']);
  const content = harness.content;
  assert.ok(content.includes('- [ ] Task\n'), 'parent gains a newline before the inserted comment');
  assert.match(content, /💬 note$/u, 'comment is the final line and the file stays unterminated');
});

test('updateTaskComments makes no change when the existing comments already match', async () => {
  const harness = createHarness('- [ ] Task\n  - 💬 keep\nafter\n');
  const task = harness.parse('- [ ] Task', 1);
  const before = harness.content;
  await harness.service.updateTaskComments(file, task, ['keep']);
  assert.equal(harness.content, before, 'identical comments produce no rewrite');
});

test('TaskMutationService invalidates cache and refreshes visible queries after checkbox/date/priority mutations', async () => {
  const invalidated: string[] = [];
  let refreshed = 0;
  const scanner = createScannerMock();
  const service = new TaskMutationService(
    {} as App,
    scanner as never,
    () => [{ rawText: 'x', name: 'done', type: 'done', icon: 'check' } as never],
    (path: string) => invalidated.push(path),
    (path: string) => { assert.equal(path, 'notes/task.md'); refreshed += 1; },
  );
  const task = { id: 'task-1', due: '', priority: '' } as unknown as ParsedTask;

  const checkboxResult = await service.updateTaskCheckbox(file, task, '[x]');
  const dateResult = await service.updateTaskDate(file, task, 'due', '2026-06-13');
  const priorityResult = await service.updateTaskPriority(file, task, '1');

  assert.equal(checkboxResult.checkbox, '[x]');
  assert.equal((dateResult as unknown as { due: string }).due, '2026-06-13');
  assert.equal((priorityResult as unknown as { priority: string }).priority, '1');
  assert.deepEqual(invalidated, ['notes/task.md', 'notes/task.md', 'notes/task.md']);
  assert.equal(refreshed, 3);
});

test('actual-time mutation relocates uniquely and preserves CRLF and metadata', async () => {
  const harness = createHarness('Intro\r\n- [ ] Write 🕐 20m 📅 2026-07-12 ^write\r\n');
  const rendered = harness.parse('- [ ] Write 🕐 20m 📅 2026-07-12 ^write', 2);
  harness.content = `Inserted\r\n${harness.content}`;
  const updated = await harness.service.updateTaskActualTime(file, rendered, 45);
  assert.equal(harness.content, 'Inserted\r\nIntro\r\n- [ ] Write 🕐 1h 5m 📅 2026-07-12 ^write\r\n');
  assert.equal(updated.lineNumber, 3);
});

test('actual-time mutation fails closed when rendered identity is ambiguous', async () => {
  const harness = createHarness('- [ ] Write\n- [ ] Write\n');
  const rendered = harness.parse('- [ ] Write', 1);
  harness.content = `Intro\n${harness.content}`;
  await assert.rejects(harness.service.updateTaskActualTime(file, rendered, 10), /matches multiple lines/u);
  assert.equal(harness.content, 'Intro\n- [ ] Write\n- [ ] Write\n');
});

test('sync inbound title/comments preserve IDs, tags, custom metadata, and unrelated children', async () => {
  const harness = createHarness('- [ ] Old title #keep [owner:: Pat] [id:: google-tasks:g1]\n  - 💬 Old note\n  - [ ] Child task\n');
  const current = harness.parse('- [ ] Old title #keep [owner:: Pat] [id:: google-tasks:g1]', 1);
  const updated = await harness.service.updateTaskBlockFromSync(
    file,
    current,
    (line) => rewriteSyncTaskTitle(line, 'Old title', 'Remote title'),
    ['Remote note'],
  );

  assert.equal(harness.content, '- [ ] Remote title #keep [owner:: Pat] [id:: google-tasks:g1]\n  - 💬 Remote note\n  - [ ] Child task\n');
  assert.equal(updated.metadata.id, 'google-tasks:g1');
});

test('sync inbound verification refuses an ambiguous explicit ID fallback', async () => {
  const harness = createHarness('- [ ] Old [id:: google-tasks:g1]\n- [ ] Duplicate [id:: google-tasks:g1]\n');
  const current = harness.parse('- [ ] Old [id:: google-tasks:g1]', 1);
  current.key = 'stale-key';

  await assert.rejects(
    harness.service.updateTaskBlockFromSync(file, current, (line) => line),
    /ambiguous persisted task/u,
  );
});

test('sync inbound block mutation is atomic when a later field rewrite fails', async () => {
  const harness = createHarness('- [ ] Old title [id:: google-tasks:g1]\n  - 💬 Old note\n');
  const current = harness.parse('- [ ] Old title [id:: google-tasks:g1]', 1);
  const before = harness.content;
  await assert.rejects(harness.service.updateTaskBlockFromSync(file, current, (line) => {
    rewriteSyncTaskTitle(line, 'Old title', 'Remote title');
    throw new Error('later field invalid');
  }, ['Remote note']), /later field invalid/u);
  assert.equal(harness.content, before);
});

test('sync inbound rejects unsafe provider metadata before committing vault content', async () => {
  const harness = createHarness('- [ ] Review [id:: google-tasks:g1]\n  - 💬 Existing\n');
  const current = harness.parse('- [ ] Review [id:: google-tasks:g1]', 1);
  const before = harness.content;

  await assert.rejects(
    harness.service.updateTaskBlockFromSync(
      file,
      current,
      (line) => rewriteSyncTaskTitle(line, 'Review', 'Review [id:: injected]'),
      ['Existing'],
    ),
    /cannot be represented safely/u,
  );
  assert.equal(harness.content, before);

  await assert.rejects(
    harness.service.updateTaskBlockFromSync(file, current, (line) => line, ['Note [owner:: injected]']),
    /cannot be represented safely/u,
  );
  assert.equal(harness.content, before);

  await assert.rejects(
    harness.service.updateTaskBlockFromSync(
      file,
      current,
      (line) => rewriteSyncInlineField(line, 'ms-todo-timezone', 'UTC] [id:: injected'),
    ),
    /cannot be represented safely/u,
  );
  assert.equal(harness.content, before);
});

test('identity-sensitive mutations fail closed when the shared index reports a duplicate explicit ID', async () => {
  const task = { metadata: { id: 'duplicate' } } as ParsedTask;
  const service = new TaskMutationService(
    {} as App,
    createScannerMock() as never,
    () => [],
    () => {},
    undefined,
    (candidate) => {
      if (candidate.metadata.id === 'duplicate') throw new Error('duplicated at A.md:1, B.md:2');
    },
  );

  await assert.rejects(service.updateTaskCheckbox(file, task, 'x'), /duplicated at A\.md:1, B\.md:2/u);
});

test('duplicate identity guard rejects a batch before any line is modified', async () => {
  const harness = createHarness('- [ ] One 🆔 duplicate\n- [ ] Two\n', (task) => {
    if (task.metadata.id === 'duplicate') throw new Error('duplicate identity');
  });
  const first = harness.parse('- [ ] One 🆔 duplicate', 1);
  const second = harness.parse('- [ ] Two', 2);
  const before = harness.content;
  await assert.rejects(harness.service.updateTaskCustomFields(file, [second, first], 'owner', 'Ada'), /duplicate identity/u);
  assert.equal(harness.content, before);
  assert.deepEqual(harness.invalidated, []);
});

test('custom-field batch relocates same-file/out-of-range tasks, preserves CRLF, and counts only changes', async () => {
  const harness = createHarness('- [ ] Target\r\n- [ ] Already set [owner:: Ada]\r\nparagraph\r\n');
  const target = { ...harness.parse('- [ ] Target', 1), lineNumber: 99 };
  const alreadySet = harness.parse('- [ ] Already set [owner:: Ada]', 2);
  harness.content = 'inserted\r\n- [ ] Target\r\nunrelated\r\n- [ ] Already set [owner:: Ada]\r\nparagraph\r\n';

  const result = await harness.service.updateTaskCustomFields(file, [target, alreadySet], 'owner', 'Ada');

  assert.equal(result.changed, 1);
  assert.equal(harness.content, 'inserted\r\n- [ ] Target [owner:: Ada]\r\nunrelated\r\n- [ ] Already set [owner:: Ada]\r\nparagraph\r\n');
  const noOp = await harness.service.updateTaskCustomFields(file, result.updatedTasks, 'owner', 'Ada');
  assert.equal(noOp.changed, 0);
  assert.deepEqual(harness.invalidated, [file.path]);
});

test('custom-field same-file batch validates all tasks before writing and refuses shifted duplicate ambiguity', async () => {
  const harness = createHarness('- [ ] One\n- [ ] Duplicate\n');
  const one = harness.parse('- [ ] One', 1);
  const duplicate = harness.parse('- [ ] Duplicate', 2);
  harness.content = 'shift\n- [ ] One\n- [ ] Duplicate\n- [ ] Duplicate\n';
  const before = harness.content;

  await assert.rejects(
    harness.service.updateTaskCustomFields(file, [one, duplicate], 'owner', 'Ada'),
    /matches multiple lines/u,
  );
  assert.equal(harness.content, before);
  assert.deepEqual(harness.invalidated, []);
});

test('tag batch relocates multiple shifted tasks, counts only changes, and preserves unrelated CRLF lines', async () => {
  const harness = createHarness('- [ ] One\r\n- [ ] Two #focus\r\n');
  const one = harness.parse('- [ ] One', 1);
  const two = harness.parse('- [ ] Two #focus', 2);
  harness.content = 'heading\r\n- [ ] One\r\nunrelated\r\n- [ ] Two #focus\r\n';

  const added = await harness.service.updateTaskTags(file, [one, two], 'focus', 'add');
  assert.equal(added.changed, 1);
  assert.equal(harness.content, 'heading\r\n- [ ] One #focus\r\nunrelated\r\n- [ ] Two #focus\r\n');

  const missing = await harness.service.updateTaskTags(file, added.updatedTasks, 'missing', 'remove');
  assert.equal(missing.changed, 0);
  assert.equal(harness.content, 'heading\r\n- [ ] One #focus\r\nunrelated\r\n- [ ] Two #focus\r\n');

  const removed = await harness.service.updateTaskTags(file, missing.updatedTasks, 'focus', 'remove');
  assert.equal(removed.changed, 2);
  assert.equal(harness.content, 'heading\r\n- [ ] One\r\nunrelated\r\n- [ ] Two\r\n');
  assert.deepEqual(harness.invalidated, [file.path, file.path]);
});

test('tag replacement removes and adds Kanban group tags in one source transaction', async () => {
  const harness = createHarness('- [ ] Move card #alpha ^card\n');
  const task = harness.parse('- [ ] Move card #alpha ^card', 1);
  const updated = await harness.service.replaceTaskTag(file, task, 'alpha', 'beta');
  assert.equal(harness.content, '- [ ] Move card #beta ^card\n');
  assert.deepEqual(updated.tags, ['beta']);
  assert.deepEqual(harness.invalidated, [file.path]);
});

test('tag batch refuses ambiguity atomically instead of modifying an unrelated line', async () => {
  const harness = createHarness('- [ ] Duplicate\n');
  const rendered = harness.parse('- [ ] Duplicate', 1);
  harness.content = 'paragraph\n- [ ] Duplicate\n- [ ] Duplicate\n';
  const before = harness.content;

  await assert.rejects(harness.service.updateTaskTags(file, [rendered], 'focus', 'add'), /matches multiple lines/u);
  assert.equal(harness.content, before);
});

test('manual-order batch relocates multiple tasks, preserves CRLF, and reports accurate no-op counts', async () => {
  const harness = createHarness('- [ ] One\r\n- [ ] Two [order:: 200]\r\n');
  const one = harness.parse('- [ ] One', 1);
  const two = harness.parse('- [ ] Two [order:: 200]', 2);
  harness.content = 'intro\r\n- [ ] One\r\nkeep\r\n- [ ] Two [order:: 200]\r\n';

  const result = await harness.service.updateTaskManualOrders(file, [{ task: one, order: 100 }, { task: two, order: 200 }]);
  assert.equal(result.changed, 1);
  assert.equal(harness.content, 'intro\r\n- [ ] One [order:: 100]\r\nkeep\r\n- [ ] Two [order:: 200]\r\n');
});

test('manual-order service rejects Canvas tasks before attempting a vault write', async () => {
  const harness = createHarness('- [ ] Canvas task\n');
  const task = { ...harness.parse('- [ ] Canvas task', 1), filePath: 'Board.canvas', key: 'Board.canvas:canvas:node:1' };
  const before = harness.content;
  await assert.rejects(
    harness.service.updateTaskManualOrders({ path: 'Board.canvas' } as TFile, [{ task, order: 100 }]),
    /Canvas tasks are read-only/u,
  );
  assert.equal(harness.content, before);
});

test('manual-order batch rejects a shifted duplicate and leaves the whole file unchanged', async () => {
  const harness = createHarness('- [ ] Duplicate\n- [ ] Other\n');
  const duplicate = harness.parse('- [ ] Duplicate', 1);
  const other = harness.parse('- [ ] Other', 2);
  harness.content = 'shift\n- [ ] Duplicate\n- [ ] Other\n- [ ] Duplicate\n';
  const before = harness.content;

  await assert.rejects(
    harness.service.updateTaskManualOrders(file, [{ task: other, order: 100 }, { task: duplicate, order: 200 }]),
    /matches multiple lines/u,
  );
  assert.equal(harness.content, before);
});

test('date/reschedule mutations relocate multiple same-file tasks, preserve CRLF, and refuse ambiguity', async () => {
  const harness = createHarness('- [ ] Target 📅 2026-06-01\r\n- [ ] Other 📅 2026-06-01\r\nkeep\r\n');
  const rendered = harness.parse('- [ ] Target 📅 2026-06-01', 1);
  const other = harness.parse('- [ ] Other 📅 2026-06-01', 2);
  harness.content = 'shift\r\n- [ ] Target 📅 2026-06-01\r\nunrelated\r\n- [ ] Other 📅 2026-06-01\r\nkeep\r\n';

  const result = await harness.service.updateTaskDates(file, [rendered, other], 'due', '2026-06-02');
  assert.equal(result.changed, 2);
  assert.deepEqual(result.updatedTasks.map((task) => task.lineNumber), [2, 4]);
  assert.equal(harness.content, 'shift\r\n- [ ] Target 📅 2026-06-02\r\nunrelated\r\n- [ ] Other 📅 2026-06-02\r\nkeep\r\n');
  const noOp = await harness.service.updateTaskDates(file, result.updatedTasks, 'due', '2026-06-02');
  assert.equal(noOp.changed, 0);

  const stale = harness.parse('- [ ] Target 📅 2026-06-02', 2);
  harness.content = 'shift again\r\nanother inserted line\r\n- [ ] Target 📅 2026-06-02\r\n- [ ] Target 📅 2026-06-02\r\nkeep\r\n';
  const before = harness.content;
  await assert.rejects(harness.service.updateTaskDates(file, [stale], 'due', '2026-06-03'), /matches multiple lines/u);
  assert.equal(harness.content, before);
});

test('recurrence scope edit uses rendered identity for shifted/out-of-range tasks and preserves CRLF', async () => {
  const harness = createHarness('- [ ] Repeat 🔁 every day\r\nkeep\r\n');
  const rendered = { ...harness.parse('- [ ] Repeat 🔁 every day', 1), lineNumber: 50 };
  harness.content = 'shift\r\n- [ ] Repeat 🔁 every day\r\nkeep\r\n';

  const result = await executeScopeEdit(
    harness.app,
    file,
    50,
    'this-only',
    '- [ ] Repeat edited 🔁 every day',
    undefined,
    0,
    rendered,
    harness.scanner,
  );

  assert.equal(result.changed, true);
  assert.equal(result.lineNumber, 2);
  assert.equal(harness.content, 'shift\r\n- [ ] Repeat edited 🔁 every day\r\nkeep\r\n');
});

test('recurrence scope edit refuses shifted duplicate ambiguity without modifying the file', async () => {
  const harness = createHarness('- [ ] Repeat 🔁 every day\n');
  const rendered = harness.parse('- [ ] Repeat 🔁 every day', 1);
  harness.content = 'shift\n- [ ] Repeat 🔁 every day\n- [ ] Repeat 🔁 every day\n';
  const before = harness.content;

  await assert.rejects(
    executeScopeEdit(harness.app, file, 1, 'all-in-series', '- [ ] Edited', undefined, 0, rendered, harness.scanner),
    /matches multiple lines/u,
  );
  assert.equal(harness.content, before);
});
