/**
 * Task Scanner Tests
 * 20+ scenarios covering task parsing, recurrence, lifecycle, and edge cases
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyTaskCompletionLifecycleToLine, durableCompletionDestinationAction, TaskScanner } from '../src/task-scanner';
import { DEFAULT_SETTINGS, DEFAULT_TASK_STATES } from '../src/types';
import { rewriteSubmittedTaskLineForModal, rewriteTaskLineForStatusWithLifecycle } from '../src/modals/task-edit-helpers';
import { StateStore } from '../src/state-store';

function scanner(): TaskScanner {
  return new TaskScanner({} as never);
}

// ── Basic Parsing ──────────────────────────────────

test('task-scanner: parses basic task line', () => {
  const s = scanner();
  const task = s.parseTaskLine('- [ ] Buy milk', 'Tasks.md', 1);
  assert.ok(task);
  assert.equal(task.checkbox, ' ');
  assert.equal(task.body, 'Buy milk');
  assert.equal(task.normalizedText, 'Buy milk');
});

test('task-scanner: parses completed task', () => {
  const s = scanner();
  const task = s.parseTaskLine('- [x] Completed task', 'Tasks.md', 1);
  assert.ok(task);
  assert.equal(task.checkbox, 'x');
  assert.equal(task.status, 'done');
});

test('task-scanner: does not treat markdown-link list items as tasks', () => {
  const s = scanner();
  // `- [Label](https://…)` is a bullet list item containing a link, not a checkbox task.
  // The `]` is immediately followed by `(`, which distinguishes it from a real task.
  assert.equal(s.parseTaskLine('- [TMDB API](https://www.themoviedb.org/)', 'Note.md', 1), null);
  assert.equal(s.parseTaskLine('- [Radarr](https://radarr.video/) / [Sonarr](https://sonarr.tv/)', 'Note.md', 2), null);
  assert.equal(s.parseTaskLine('- [Jellyfin](https://jellyfin.org/)', 'Note.md', 3), null);
  assert.equal(s.parseTaskLine('- [x](https://example.com)', 'Note.md', 4), null);
  // Real tasks — including multi-character status markers — are still parsed.
  assert.ok(s.parseTaskLine('- [ ] Real task', 'Note.md', 5));
  assert.ok(s.parseTaskLine('- [TODO] Multi-char marker', 'Note.md', 6));
  assert.equal(s.parseTaskLine('- [x] Read [the docs](https://example.com)', 'Note.md', 7)?.body, 'Read [the docs](https://example.com)');
});

test('task-scanner: does not treat wikilink list items as tasks', () => {
  const s = scanner();
  // `- [[Note#L5]] text` is a bullet list item whose first token is a [[wikilink]], not a checkbox.
  // The Task Health Report writes many of these; they must not be scanned as tasks (which used to
  // produce a stray `]`-prefixed subject and inflate every dashboard widget's counts).
  assert.equal(s.parseTaskLine('- [[Demo Tasks#L5]] QA checkout flow (due: 2026-06-06)', 'Report.md', 1), null);
  assert.equal(s.parseTaskLine('- [[Some Note]] just a bullet with a link', 'Report.md', 2), null);
  assert.equal(s.parseTaskLine('* [[A]] [[B]] two links', 'Report.md', 3), null);
  // Real tasks that merely *contain* a wikilink mid-text are still parsed in full.
  assert.equal(s.parseTaskLine('- [ ] Review [[Spec]] before Friday', 'Note.md', 4)?.body, 'Review [[Spec]] before Friday');
});

test('task-scanner: parses task with tags', () => {
  const s = scanner();
  const task = s.parseTaskLine('- [ ] Buy milk #shopping #groceries', 'Tasks.md', 1);
  assert.ok(task);
  assert.deepEqual(task.tags, ['shopping', 'groceries']);
});

test('task-scanner: child task comments are not attached to parent task', async () => {
  const s = new TaskScanner({
    vault: {
      read: async () => '- [ ] Parent\n  - [ ] Child\n    - 💬 Child-only note\n',
    },
  } as never);
  const tasks = await s.scanFile({ path: 'Tasks.md' } as never);
  assert.equal(tasks[0].normalizedText, 'Parent');
  assert.equal(tasks[0].metadata.comments, undefined);
  assert.equal(tasks[1].normalizedText, 'Child');
  assert.deepEqual(tasks[1].metadata.comments, ['Child-only note']);
});

test('task-scanner: parses task with due date', () => {
  const s = scanner();
  const task = s.parseTaskLine('- [ ] Task 📅 2026-06-15', 'Tasks.md', 1);
  assert.ok(task);
  assert.equal(task.metadata.dates.due, '2026-06-15');
});

test('task-scanner: parses task date-times with T separator', () => {
  const s = scanner();
  const task = s.parseTaskLine('- [ ] Task 📅 2026-06-15T09:30 ⏳ 2026-06-14T08:15 🛫 2026-06-13T07:45', 'Tasks.md', 1);
  assert.ok(task);
  assert.equal(task.metadata.dates.due, '2026-06-15');
  assert.equal(task.metadata.dates.dueTime, '09:30');
  assert.equal(task.metadata.dates.scheduled, '2026-06-14');
  assert.equal(task.metadata.dates.scheduledTime, '08:15');
  assert.equal(task.metadata.dates.start, '2026-06-13');
  assert.equal(task.metadata.dates.startTime, '07:45');
  assert.equal(task.normalizedText, 'Task');
});

test('task-scanner: parses task with scheduled date', () => {
  const s = scanner();
  const task = s.parseTaskLine('- [ ] Task ⏳ 2026-06-10', 'Tasks.md', 1);
  assert.ok(task);
  assert.equal(task.metadata.dates.scheduled, '2026-06-10');
});

test('task-scanner: parses plain reminder date-times with T separator', () => {
  const s = scanner();
  const task = s.parseTaskLine('- [ ] Call client ⏰ 2026-06-15T09:30', 'Tasks.md', 1);
  assert.ok(task);
  assert.equal(task.metadata.reminder, '2026-06-15 09:30');
  assert.equal(task.normalizedText, 'Call client');
});

test('task-scanner: parses and strips Dataview wikilink date fields', () => {
  const s = scanner();
  const task = s.parseTaskLine('- [ ] Renew cert [due:: [[2026-06-15]]] [scheduled:: [[2026-06-10|Jun 10]]]', 'Tasks.md', 1);

  assert.ok(task);
  assert.equal(task.metadata.dates.due, '2026-06-15');
  assert.equal(task.metadata.dates.scheduled, '2026-06-10');
  assert.equal(task.normalizedText, 'Renew cert');
});

test('task-scanner: ignores impossible filename scheduled dates', async () => {
  const app = { vault: { read: async () => '- [ ] Task without inline date' } };
  const s = new TaskScanner(
    app as never,
    () => DEFAULT_TASK_STATES,
    () => '',
    () => ({ ...DEFAULT_SETTINGS, useFilenameAsScheduledDate: true, filenameScheduledDateFormat: 'YYYY-[W]ww' }),
  );

  const [invalidDashed] = await s.scanFile({ path: 'Daily/2026-02-31.md' } as never);
  const [invalidCompact] = await s.scanFile({ path: 'Daily/20260231.md' } as never);
  const [invalidWeek] = await s.scanFile({ path: 'Daily/2021-W53.md' } as never);
  const [validDate] = await s.scanFile({ path: 'Daily/2026-02-28.md' } as never);
  const [validWeek] = await s.scanFile({ path: 'Daily/2020-W53.md' } as never);

  assert.equal(invalidDashed.metadata.dates.scheduled, undefined);
  assert.equal(invalidCompact.metadata.dates.scheduled, undefined);
  assert.equal(invalidWeek.metadata.dates.scheduled, undefined);
  assert.equal(validDate.metadata.dates.scheduled, '2026-02-28');
  assert.equal(validWeek.metadata.dates.scheduled, '2020-12-28');
});

test('task-scanner: applies frontmatter defaults from the captured body and ignores stale MetadataCache', async () => {
  const content = [
    '---',
    'task_due: 2026-02-31',
    'task_scheduled: 2026-02-28',
    'task_priority: high',
    '---',
    '- [ ] Task without inline date',
  ].join('\n');
  const app = {
    metadataCache: {
      getFileCache: () => ({ frontmatter: { task_due: '2099-12-31', task_scheduled: '2099-12-30', task_priority: 'lowest' } }),
    },
    vault: { read: async () => content },
  };
  const s = new TaskScanner(
    app as never,
    () => DEFAULT_TASK_STATES,
    () => '',
    () => ({ ...DEFAULT_SETTINGS, fileDefaultsEnabled: true }),
  );

  const [task] = await s.scanFile(fakeVaultFile('Tasks.md') as never);

  assert.equal(task.metadata.dates.due, undefined);
  assert.equal(task.metadata.dates.scheduled, '2026-02-28');
  assert.equal(task.metadata.priority, 'high');
});

test('task-scanner: scanCanvasFile uses virtual lines across text nodes', async () => {
  const app = {
    vault: {
      read: async () => JSON.stringify({
        nodes: [
          { id: 'a', type: 'text', text: 'Intro\n- [ ] First' },
          { id: 'b', type: 'file', file: 'Other.md' },
          { id: 'c', type: 'text', content: '- [x] Second\nNotes\n- [ ] Third' },
        ],
        edges: [],
      }),
    },
  };
  const s = new TaskScanner(app as never);

  const tasks = await s.scanCanvasFile({ path: 'Board.canvas' } as never);

  assert.deepEqual(tasks.map((task) => task.lineNumber), [2, 3, 5]);
  assert.deepEqual(tasks.map((task) => task.heading), ['Canvas card a', 'Canvas card c', 'Canvas card c']);
  assert.deepEqual(tasks.map((task) => task.normalizedText), ['First', 'Second', 'Third']);
});

test('task-scanner: malformed Canvas content fails instead of publishing an empty task list', async () => {
  const app = { vault: { read: async () => '{"nodes":[' } };
  const s = new TaskScanner(app as never);

  await assert.rejects(s.scanCanvasFile({ path: 'Board.canvas' } as never), /JSON/u);
  assert.throws(() => s.scanCanvasContent({ path: 'Board.canvas' } as never, '{"nodes":['), /JSON/u);
});

test('task-scanner: content parsers match one-read Markdown and Canvas wrappers', async () => {
  const markdownFile = fakeVaultFile('Tasks.md');
  const canvasFile = fakeVaultFile('Board.canvas');
  canvasFile.extension = 'canvas';
  const markdown = '---\nexample: true\n---\n- [ ] Parent\n  - 💬 Note\n';
  const canvas = JSON.stringify({ nodes: [{ type: 'text', id: 'n1', text: '- [ ] Canvas task' }] });
  let reads = 0;
  const scanner = new TaskScanner({ vault: { read: async (file: { path: string }) => { reads += 1; return file.path === canvasFile.path ? canvas : markdown; } } } as never);

  const markdownWrapped = await scanner.scanFile(markdownFile as never);
  const markdownContent = scanner.scanFileContent(markdownFile as never, markdown);
  const canvasWrapped = await scanner.scanCanvasFile(canvasFile as never);
  const canvasContent = scanner.scanCanvasContent(canvasFile as never, canvas);

  assert.deepEqual(markdownWrapped, markdownContent);
  assert.deepEqual(canvasWrapped, canvasContent);
  assert.equal(reads, 2, 'each compatibility wrapper performs exactly one read');
});

test('task-scanner: scanFile keeps fenced code blocks open until the matching fence closes', async () => {
  const app = {
    vault: {
      read: async () => [
        '~~~markdown',
        '```',
        '- [ ] Hidden inside tilde fence',
        '~~~',
        '- [ ] Visible after tilde fence',
      ].join('\n'),
    },
  };
  const s = new TaskScanner(app as never);

  const tasks = await s.scanFile({ path: 'Notes.md' } as never);

  assert.deepEqual(tasks.map((task) => task.normalizedText), ['Visible after tilde fence']);
});

test('task-scanner: parses task with start date', () => {
  const s = scanner();
  const task = s.parseTaskLine('- [ ] Task 🛫 2026-06-09', 'Tasks.md', 1);
  assert.ok(task);
  assert.equal(task.metadata.dates.start, '2026-06-09');
});

test('task-scanner: parses task with priority', () => {
  const s = scanner();
  const task = s.parseTaskLine('- [ ] Critical bug 🔺', 'Tasks.md', 1);
  assert.ok(task);
  assert.equal(task.metadata.priority, 'highest');
});

test('task-scanner: parses task with effort estimate', () => {
  const s = scanner();
  const task = s.parseTaskLine('- [ ] Task ⏱️ 2h 30m', 'Tasks.md', 1);
  assert.ok(task);
  assert.ok(task?.metadata?.effort?.includes('2h'));
});

// ── Recurrence ──────────────────────────────────

test('task-scanner: parses daily recurrence', () => {
  const s = scanner();
  const task = s.parseTaskLine('- [ ] Daily standup 🔁 every day', 'Tasks.md', 1);
  assert.ok(task);
  assert.ok(task?.metadata?.recurrence?.includes('every day'));
});

test('task-scanner: parses weekly recurrence', () => {
  const s = scanner();
  const task = s.parseTaskLine('- [ ] Weekly review 🔁 every week', 'Tasks.md', 1);
  assert.ok(task);
  assert.ok(task?.metadata?.recurrence?.includes('every week'));
});

test('task-scanner: parses weekday recurrence', () => {
  const s = scanner();
  const task = s.parseTaskLine('- [ ] Standup 🔁 every weekday', 'Tasks.md', 1);
  assert.ok(task);
  assert.ok(task?.metadata?.recurrence?.includes('every weekday'));
});

test('task-scanner: parses monthly recurrence', () => {
  const s = scanner();
  const task = s.parseTaskLine('- [ ] Report 🔁 every month', 'Tasks.md', 1);
  assert.ok(task);
  assert.ok(task?.metadata?.recurrence?.includes('every month'));
});

// ── Edge Cases ──────────────────────────────────

test('task-scanner: handles multiline content', () => {
  const s = scanner();
  const task = s.parseTaskLine('- [ ] Complex task with lots of metadata 📅 2026-06-15 🔺 ⏱️ 2h #urgent #important', 'Tasks.md', 1);
  assert.ok(task);
  assert.equal(task.metadata.dates.due, '2026-06-15');
  assert.equal(task.metadata.priority, 'highest');
  assert.ok(task?.metadata?.effort?.includes('2h'));
  assert.ok(task.tags.includes('urgent'));
  assert.ok(task.tags.includes('important'));
});

test('task-scanner: handles task with id', () => {
  const s = scanner();
  const task = s.parseTaskLine('- [ ] Task 🆔 task-123', 'Tasks.md', 1);
  assert.ok(task);
  assert.equal(task.metadata.id, 'task-123');
});

test('task-scanner: handles task with dependencies', () => {
  const s = scanner();
  const task = s.parseTaskLine('- [ ] Task ⛔ task-1, task-2', 'Tasks.md', 1);
  assert.ok(task);
  assert.ok(task.metadata.dependsOn.includes('task-1'));
  assert.ok(task.metadata.dependsOn.includes('task-2'));
});

test('task-scanner: handles empty task', () => {
  const s = scanner();
  const task = s.parseTaskLine('- [ ]', 'Tasks.md', 1);
  assert.ok(task);
  assert.equal(task.normalizedText, '');
});

test('task-scanner: handles task with nested bullets', () => {
  const s = scanner();
  const task = s.parseTaskLine('  - [ ] Nested task', 'Tasks.md', 1);
  assert.ok(task);
  assert.equal(task.body, 'Nested task');
  assert.equal(task.indentation.length, 2);
});

test('task-scanner: ignores non-task checkboxes', () => {
  const s = scanner();
  const result = s.parseTaskLine('Some text [ ]', 'Tasks.md', 1);
  assert.equal(result, null);
});

test('task-scanner: handles cancelled task state', () => {
  const s = scanner();
  const task = s.parseTaskLine('- [-] Cancelled task', 'Tasks.md', 1);
  assert.ok(task);
  assert.equal(task.checkbox, '-');
  assert.equal(task.status, 'cancelled');
});

test('task-scanner: reopening a legacy-cancelled task removes the legacy cancelled date', async () => {
  const file = fakeVaultFile('Tasks.md');
  let content = '- [-] Cancelled task ⛔ 2026-01-01\n';
  const app = {
    vault: {
      read: async () => content,
      process: async (_f: unknown, cb: (s: string) => string) => { content = cb(content); },
    },
  };
  const s = new TaskScanner(
    app as never,
    () => DEFAULT_TASK_STATES,
    () => '',
    () => ({ ...DEFAULT_SETTINGS, setCancelledDate: true }),
  );

  const [task] = await s.scanFile(file as never);
  await s.updateTaskCheckbox(file as never, task, ' ');

  assert.equal(content.trim(), '- [ ] Cancelled task');
});

test('task-scanner: cancelling a task with a legacy cancelled date does not duplicate the date', async () => {
  const file = fakeVaultFile('Tasks.md');
  let content = '- [ ] Cancelled task ⛔️ 2026-01-01\n';
  const app = {
    vault: {
      read: async () => content,
      process: async (_f: unknown, cb: (s: string) => string) => { content = cb(content); },
    },
  };
  const s = new TaskScanner(
    app as never,
    () => DEFAULT_TASK_STATES,
    () => '',
    () => ({ ...DEFAULT_SETTINGS, setCancelledDate: true }),
  );

  const [task] = await s.scanFile(file as never);
  await s.updateTaskCheckbox(file as never, task, '-');

  assert.equal(content.trim(), '- [-] Cancelled task ⛔️ 2026-01-01');
  assert.doesNotMatch(content, /❌/u);
});

test('task-scanner: updateTaskDate replaces emoji date fields with variation selectors', async () => {
  const file = fakeVaultFile('Tasks.md');
  let content = '- [ ] Pay bill 📅️ 2026-06-01\n';
  const app = {
    vault: {
      read: async () => content,
      process: async (_f: unknown, cb: (s: string) => string) => { content = cb(content); },
    },
  };
  const s = new TaskScanner(app as never);

  const [task] = await s.scanFile(file as never);
  await s.updateTaskDate(file as never, task, 'due', '2026-06-02');

  assert.equal(content.trim(), '- [ ] Pay bill 📅 2026-06-02');
  assert.equal((content.match(/📅/gu) ?? []).length, 1);
});

test('task-scanner: updateTaskDate replaces Dataview wikilink date fields', async () => {
  const file = fakeVaultFile('Tasks.md');
  let content = '- [ ] Pay bill [due:: [[2026-06-01]]]\n';
  const app = {
    vault: {
      read: async () => content,
      process: async (_f: unknown, cb: (s: string) => string) => { content = cb(content); },
    },
  };
  const s = new TaskScanner(app as never);

  const [task] = await s.scanFile(file as never);
  await s.updateTaskDate(file as never, task, 'due', '2026-06-02');

  assert.equal(content.trim(), '- [ ] Pay bill [due:: 2026-06-02]');
});

test('task-scanner: updateTaskDate replaces date-time fields without orphaning time', async () => {
  const file = fakeVaultFile('Tasks.md');
  let content = '- [ ] Pay bill 📅 2026-06-01 14:00\n- [ ] Call bank [due:: 2026-06-01 14:00]\n';
  const app = {
    vault: {
      read: async () => content,
      process: async (_f: unknown, cb: (s: string) => string) => { content = cb(content); },
    },
  };
  const s = new TaskScanner(app as never);

  const [emojiTask, dataviewTask] = await s.scanFile(file as never);
  await s.updateTaskDate(file as never, emojiTask, 'due', '2026-06-02');
  await s.updateTaskDate(file as never, dataviewTask, 'due', null);

  assert.equal(content.trim(), '- [ ] Pay bill 📅 2026-06-02\n- [ ] Call bank');
  assert.doesNotMatch(content, /14:00/u);
});

test('task-scanner: updateTaskDate replaces one-digit times and wikilink aliases', async () => {
  const file = fakeVaultFile('Tasks.md');
  let content = [
    '- [ ] Emoji time 📅 2026-06-18 9:00',
    '- [ ] Dataview time [due:: 2026-06-18 9:00]',
    '- [ ] Dataview alias [due:: [[2026-06-18|Thu]]]',
    '- [ ] Scheduled time ⏳ 2026-06-18 9:00',
    '- [ ] Start alias [start:: [[2026-06-18|Thu]]]',
    '- [ ] Completion alias [completion:: [[2026-06-18|Thu]]]',
    '',
  ].join('\n');
  const app = {
    vault: {
      read: async () => content,
      process: async (_f: unknown, cb: (s: string) => string) => { content = cb(content); },
    },
  };
  const s = new TaskScanner(app as never);

  const [emojiTask, dataviewTimeTask, dataviewAliasTask, scheduledTask, startTask, completionTask] = await s.scanFile(file as never);
  await s.updateTaskDate(file as never, emojiTask, 'due', '2026-06-19');
  await s.updateTaskDate(file as never, dataviewTimeTask, 'due', null);
  await s.updateTaskDate(file as never, dataviewAliasTask, 'due', '2026-06-20');
  await s.updateTaskDate(file as never, scheduledTask, 'scheduled', '2026-06-21');
  await s.updateTaskDate(file as never, startTask, 'start', null);
  await s.updateTaskDate(file as never, completionTask, 'done', '2026-06-22');

  assert.equal(content.trim(), [
    '- [ ] Emoji time 📅 2026-06-19',
    '- [ ] Dataview time',
    '- [ ] Dataview alias [due:: 2026-06-20]',
    '- [ ] Scheduled time ⏳ 2026-06-21',
    '- [ ] Start alias',
    '- [ ] Completion alias [completion:: 2026-06-22]',
  ].join('\n'));
  assert.equal((content.match(/📅/gu) ?? []).length, 1);
  assert.doesNotMatch(content, /2026-06-18|9:00|Thu/u);
});

test('task-scanner: lifecycle dates use the local calendar day', (t) => {
  const previousTz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  t.after(() => {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  });
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-06-02T01:30:00Z') });

  const lines = applyTaskCompletionLifecycleToLine(
    '- [ ] Finish report',
    'x',
    DEFAULT_TASK_STATES,
    { ...DEFAULT_SETTINGS, setDoneDate: true },
  );

  assert.deepEqual(lines, ['- [x] Finish report ✅ 2026-06-01']);
});

test('task-scanner: lifecycle date-times are stamped, parsed, and stripped from normalized text', (t) => {
  const previousTz = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  t.after(() => {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  });
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-06-02T01:30:00Z') });

  const doneLines = applyTaskCompletionLifecycleToLine(
    '- [ ] Finish report',
    'x',
    DEFAULT_TASK_STATES,
    { ...DEFAULT_SETTINGS, setDoneDate: true, dateTimeOnLifecycleDates: true },
  );
  const cancelledLines = applyTaskCompletionLifecycleToLine(
    '- [ ] Drop report',
    '-',
    DEFAULT_TASK_STATES,
    { ...DEFAULT_SETTINGS, setCancelledDate: true, dateTimeOnLifecycleDates: true },
  );

  assert.deepEqual(doneLines, ['- [x] Finish report ✅ 2026-06-01 18:30']);
  assert.deepEqual(cancelledLines, ['- [-] Drop report ❌ 2026-06-01 18:30']);

  const s = scanner();
  const done = s.parseTaskLine('- [x] Finish report ✅ 2026-06-01 18:30', 'Tasks.md', 1);
  const cancelled = s.parseTaskLine('- [-] Drop report ❌ 2026-06-01 18:30', 'Tasks.md', 2);

  assert.ok(done);
  assert.ok(cancelled);
  assert.equal(done.metadata.dates.done, '2026-06-01');
  assert.equal(done.normalizedText, 'Finish report');
  assert.equal(cancelled.metadata.dates.cancelled, '2026-06-01');
  assert.equal(cancelled.normalizedText, 'Drop report');

  const uncompleted = applyTaskCompletionLifecycleToLine(
    '- [x] Finish report ✅ [[2026-06-01 18:30]]',
    ' ',
    DEFAULT_TASK_STATES,
    { ...DEFAULT_SETTINGS, setDoneDate: true, dateFormat: 'wikilink' },
  );
  const uncancelled = applyTaskCompletionLifecycleToLine(
    '- [-] Drop report ❌ [[2026-06-01 18:30]]',
    ' ',
    DEFAULT_TASK_STATES,
    { ...DEFAULT_SETTINGS, setCancelledDate: true, dateFormat: 'wikilink' },
  );

  assert.deepEqual(uncompleted, ['- [ ] Finish report']);
  assert.deepEqual(uncancelled, ['- [ ] Drop report']);
});

test('task-scanner: handles in-progress state', () => {
  const s = scanner();
  const task = s.parseTaskLine('- [/] In progress', 'Tasks.md', 1);
  assert.ok(task);
  assert.equal(task.checkbox, '/');
  assert.equal(task.status, 'in_progress');
});

test('task-scanner: extracts heading context', () => {
  const s = scanner();
  const task = s.parseTaskLine('- [ ] Task', 'Tasks.md', 1, '# Work');
  assert.ok(task);
  assert.equal(task.heading, '# Work');
});

test('task-scanner: parses task with multiple dates', () => {
  const s = scanner();
  const task = s.parseTaskLine('- [ ] Task 📅 2026-06-15 🛫 2026-06-10 ✅ 2026-06-20', 'Tasks.md', 1);
  assert.ok(task);
  assert.equal(task.metadata.dates.due, '2026-06-15');
  assert.equal(task.metadata.dates.start, '2026-06-10');
  assert.equal(task.metadata.dates.done, '2026-06-20');
});

test('task-scanner: preserves raw line', () => {
  const s = scanner();
  const rawLine = '- [ ] Buy milk #shopping';
  const task = s.parseTaskLine(rawLine, 'Tasks.md', 1);
  assert.ok(task);
  assert.equal(task.rawLine, rawLine);
});

test('task-scanner: handles task with cost', () => {
  const s = scanner();
  const task = s.parseTaskLine('- [ ] Project 💵 500.50', 'Tasks.md', 1);
  assert.ok(task);
  assert.equal(task.metadata.cost, 500.50);
});

test('task-scanner: stops recurrence parsing before either cost marker', () => {
  const s = scanner();
  const dollar = s.parseTaskLine('- [ ] Project 🔁 every day 💵 500.50', 'Tasks.md', 1);
  const moneyBag = s.parseTaskLine('- [ ] Project 🔁 every day 💰 500.50', 'Tasks.md', 2);

  assert.ok(dollar);
  assert.ok(moneyBag);
  assert.equal(dollar.metadata.recurrence, 'every day');
  assert.equal(dollar.metadata.cost, 500.50);
  assert.equal(moneyBag.metadata.recurrence, 'every day');
  assert.equal(moneyBag.metadata.cost, 500.50);
});

test('task-scanner: ignores partial numeric metadata tokens', () => {
  const s = scanner();
  const task = s.parseTaskLine('- [ ] Bad metadata 💵 100abc ⏱️ 2horse 🕐 30minsabc', 'Tasks.md', 1);
  assert.ok(task);
  assert.equal(task.metadata.cost, undefined);
  assert.equal(task.metadata.effort, undefined);
  assert.equal(task.metadata.actual, undefined);
  assert.equal(task.normalizedText, 'Bad metadata 💵 100abc ⏱️ 2horse 🕐 30minsabc');
});

test('task-scanner: handles task with pinned marker', () => {
  const s = scanner();
  const task = s.parseTaskLine('- [ ] Important task 📌', 'Tasks.md', 1);
  assert.ok(task);
  assert.equal(task.metadata.pinned, true);
});

// \u2500\u2500 File-Backed Task Notes (Task #4) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500

import { isTaskNoteFile, scanFileAsTask, scanFileWithTaskNotes } from '../src/task-scanner';

// Mock TFile and App for testing
function createMockFile(path: string, parent?: { path?: string }): any {
  return {
    path,
    basename: path.split('/').pop() || '',
    parent: parent || { path: path.split('/').slice(0, -1).join('/') },
  };
}

function createMockApp(frontmatter?: Record<string, unknown>): any {
  return {
    metadataCache: {
      getFileCache: (_file: unknown) => ({
        frontmatter: frontmatter || {},
      }),
    },
    vault: {},
  };
}

test('file-backed-tasks: isTaskNoteFile detects folder-based task notes', () => {
  const file = createMockFile('Tasks/Important.md', { path: 'Tasks' });
  const app = createMockApp();
  const isNote = isTaskNoteFile(file, app, 'Tasks', '');
  assert.equal(isNote, true);
});

test('file-backed-tasks: isTaskNoteFile detects frontmatter marker "task: true"', () => {
  const file = createMockFile('Notes/MyTask.md');
  const app = createMockApp({ task: true });
  const isNote = isTaskNoteFile(file, app, '', 'task: true');
  assert.equal(isNote, true);
});

test('file-backed-tasks: isTaskNoteFile ignores files without marker', () => {
  const file = createMockFile('Notes/MyNote.md');
  const app = createMockApp({ someOtherField: true });
  const isNote = isTaskNoteFile(file, app, '', 'task: true');
  assert.equal(isNote, false);
});

test('file-backed-tasks: isTaskNoteFile handles multiple folders', () => {
  const file = createMockFile('Projects/Task.md', { path: 'Projects' });
  const app = createMockApp();
  const isNote = isTaskNoteFile(file, app, 'Tasks, Projects, Inbox', '');
  assert.equal(isNote, true);
});

test('file-backed-tasks: isTaskNoteFile ignores files not in configured folders', () => {
  const file = createMockFile('Archive/Old.md', { path: 'Archive' });
  const app = createMockApp();
  const isNote = isTaskNoteFile(file, app, 'Tasks, Projects', '');
  assert.equal(isNote, false);
});

test('file-backed-tasks: scanFileWithTaskNotes scans task-note frontmatter instead of inline checkboxes', async () => {
  const file = createMockFile('Tasks/Todo.md');
  const app = createMockApp({ task: true, description: 'Frontmatter task', status: 'todo' });
  let inlineScanCalled = false;

  const tasks = await scanFileWithTaskNotes(file, app, {
    scanFile: async () => {
      inlineScanCalled = true;
      return [];
    },
  }, {
    taskNoteFolders: '',
    taskNoteMarker: 'task: true',
    supportedStates: DEFAULT_TASK_STATES,
  });

  assert.equal(inlineScanCalled, false);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].body, 'Frontmatter task');
  assert.equal(tasks[0].lineNumber, 0);
});

test('file-backed-tasks: scanFileWithTaskNotes delegates regular notes to inline scanner', async () => {
  const file = createMockFile('Notes/Regular.md');
  const app = createMockApp({ description: 'Not marked as task' });

  const tasks = await scanFileWithTaskNotes(file, app, {
    scanFile: async () => [{ ...scanFileAsTask(createMockFile('Tasks/Task.md'), createMockApp({ task: true, description: 'Inline scanner task' }), DEFAULT_TASK_STATES)! }],
  }, {
    taskNoteFolders: '',
    taskNoteMarker: 'task: true',
    supportedStates: DEFAULT_TASK_STATES,
  });

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].body, 'Inline scanner task');
});

function createMutableTaskNote(frontmatter: Record<string, unknown>) {
  const values: Record<string, unknown> = {
    task: true,
    description: 'Frontmatter task',
    status: 'todo',
    priority: 'normal',
    ...frontmatter,
  };
  let content = `---\n${Object.entries(values)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}: ${String(value)}`)
    .join('\n')}\n---\nBody\n`;
  const file = createMockFile('Tasks/Todo.md');
  const app = {
    ...createMockApp(values),
    vault: {
      process: async (_file: unknown, updater: (content: string) => string) => {
        content = updater(content);
      },
    },
  };
  return { file, app, getContent: () => content, setContent: (value: string) => { content = value; } };
}

test('file-backed-tasks: TaskScanner updates task-note status in frontmatter', async () => {
  const { file, app, getContent } = createMutableTaskNote({ description: 'Frontmatter task', status: 'todo' });
  const scanner = new TaskScanner(app as never, () => DEFAULT_TASK_STATES, () => '', () => DEFAULT_SETTINGS);
  const task = scanFileAsTask(file, app, DEFAULT_TASK_STATES);
  assert.ok(task);

  const updated = await scanner.updateTaskCheckbox(file, task, 'x');

  assert.equal(updated.status, 'done');
  assert.equal(updated.lineNumber, 0);
  assert.match(getContent(), /^status: done$/mu);
});

test('file-backed-tasks: destructive and recurring task-note completion fails closed before a write', async (t) => {
  for (const onCompletion of ['delete', 'archive', 'collect', 'move-to-end'] as const) {
    await t.test(onCompletion, async () => {
      const { file, app, getContent } = createMutableTaskNote({ description: 'Protected task note', status: 'todo', onCompletion });
      const scanner = new TaskScanner(app as never, () => DEFAULT_TASK_STATES, () => '', () => DEFAULT_SETTINGS);
      const task = scanFileAsTask(file, app, DEFAULT_TASK_STATES);
      assert.ok(task);
      assert.equal(task.metadata.onCompletion, onCompletion);
      const before = getContent();
      const result = await scanner.updateTaskCheckboxWithOutcome(file, task, 'x');
      assert.equal(result.outcome, 'blocked');
      assert.equal(getContent(), before);
    });
  }

  await t.test('recurrence', async () => {
    const { file, app, getContent } = createMutableTaskNote({ description: 'Recurring task note', status: 'todo', recurrence: 'every day' });
    const scanner = new TaskScanner(app as never, () => DEFAULT_TASK_STATES, () => '', () => DEFAULT_SETTINGS);
    const task = scanFileAsTask(file, app, DEFAULT_TASK_STATES);
    assert.ok(task);
    const before = getContent();
    const result = await scanner.updateTaskCheckboxWithOutcome(file, task, 'x');
    assert.equal(result.outcome, 'blocked');
    assert.equal(getContent(), before);
  });
});

test('file-backed-tasks: atomic frontmatter preflight catches stale destructive metadata', async () => {
  const file = createMockFile('Tasks/Todo.md');
  let content = '---\ntask: true\ndescription: Stale cache\nstatus: todo\nonCompletion: delete\n---\nBody\n';
  const app = {
    ...createMockApp({ task: true, description: 'Stale cache', status: 'todo' }),
    vault: { process: async (_file: unknown, updater: (current: string) => string) => { content = updater(content); } },
  };
  const scanner = new TaskScanner(app as never, () => DEFAULT_TASK_STATES, () => '', () => DEFAULT_SETTINGS);
  const task = scanFileAsTask(file, app, DEFAULT_TASK_STATES);
  assert.ok(task);
  assert.equal(task.metadata.onCompletion, undefined, 'fixture metadata cache is intentionally stale');
  const before = content;
  const result = await scanner.updateTaskCheckboxWithOutcome(file, task, 'x');
  assert.equal(result.outcome, 'blocked');
  assert.equal(content, before);
});

test('file-backed-tasks: task-note status transitions record history without line-based automation', async () => {
  const { file, app } = createMutableTaskNote({ description: 'Tracked task note', status: 'todo' });
  const entries: Array<{ action: string; after: { status: string } }> = [];
  const scanner = new TaskScanner(
    app as never,
    () => DEFAULT_TASK_STATES,
    () => '',
    () => DEFAULT_SETTINGS,
    () => undefined,
    { recordChange: (entry: { action: string; after: { status: string } }) => { entries.push(entry); } } as never,
  );
  const task = scanFileAsTask(file, app, DEFAULT_TASK_STATES);
  assert.ok(task);
  const result = await scanner.updateTaskCheckboxWithOutcome(file, task, 'x');
  assert.equal(result.outcome, 'completed');
  assert.deepEqual(entries.map((entry) => [entry.action, entry.after.status]), [['status_change', 'done']]);
});

test('file-backed-tasks: TaskScanner updates task-note date and priority in frontmatter', async () => {
  const { file, app, getContent } = createMutableTaskNote({ description: 'Frontmatter task', status: 'todo', priority: 'normal' });
  const scanner = new TaskScanner(app as never, () => DEFAULT_TASK_STATES, () => '', () => DEFAULT_SETTINGS);
  const task = scanFileAsTask(file, app, DEFAULT_TASK_STATES);
  assert.ok(task);

  const dated = await scanner.updateTaskDate(file, task, 'due', '2026-06-20');
  const prioritized = await scanner.updateTaskPriority(file, dated, 'high');

  assert.equal(dated.metadata.dates.due, '2026-06-20');
  assert.equal(prioritized.metadata.priority, 'high');
  assert.match(getContent(), /^due: 2026-06-20$/mu);
  assert.match(getContent(), /^priority: high$/mu);
});

test('file-backed-tasks: exact-body identity CAS rejects changed, removed, and newly-added IDs', async (t) => {
  await t.test('status rejects a changed ID', async () => {
    const h = createMutableTaskNote({ id: 'task-a', description: 'Status identity', status: 'todo' });
    const scanner = new TaskScanner(h.app as never, () => DEFAULT_TASK_STATES, () => '', () => DEFAULT_SETTINGS);
    const task = scanFileAsTask(h.file, h.app, DEFAULT_TASK_STATES);
    assert.ok(task);
    h.setContent(h.getContent().replace('id: task-a', 'id: task-b'));
    const before = h.getContent();
    await assert.rejects(scanner.updateTaskCheckbox(h.file, task, 'x'), /logical identity changed/u);
    assert.equal(h.getContent(), before);
  });

  await t.test('date rejects a removed ID', async () => {
    const h = createMutableTaskNote({ id: 'task-a', description: 'Date identity', due: '2026-06-20' });
    const scanner = new TaskScanner(h.app as never, () => DEFAULT_TASK_STATES, () => '', () => DEFAULT_SETTINGS);
    const task = scanFileAsTask(h.file, h.app, DEFAULT_TASK_STATES);
    assert.ok(task);
    h.setContent(h.getContent().replace('id: task-a\n', ''));
    const before = h.getContent();
    await assert.rejects(scanner.updateTaskDate(h.file, task, 'due', '2026-06-21'), /logical identity changed/u);
    assert.equal(h.getContent(), before);
  });

  await t.test('priority rejects an ID added to an anonymous task', async () => {
    const h = createMutableTaskNote({ description: 'Anonymous identity', priority: 'normal' });
    const scanner = new TaskScanner(h.app as never, () => DEFAULT_TASK_STATES, () => '', () => DEFAULT_SETTINGS);
    const task = scanFileAsTask(h.file, h.app, DEFAULT_TASK_STATES);
    assert.ok(task);
    h.setContent(h.getContent().replace('priority: normal\n', 'priority: normal\nid: task-a\n'));
    const before = h.getContent();
    await assert.rejects(scanner.updateTaskPriority(h.file, task, 'high'), /logical identity changed/u);
    assert.equal(h.getContent(), before);
  });
});

test('file-backed-tasks: exact-body field CAS rejects stale status, date, time, and priority', async (t) => {
  await t.test('status', async () => {
    const h = createMutableTaskNote({ id: 'stable', status: 'todo' });
    const scanner = new TaskScanner(h.app as never, () => DEFAULT_TASK_STATES, () => '', () => DEFAULT_SETTINGS);
    const task = scanFileAsTask(h.file, h.app, DEFAULT_TASK_STATES);
    assert.ok(task);
    h.setContent(h.getContent().replace('status: todo', 'status: in_progress'));
    const before = h.getContent();
    await assert.rejects(scanner.updateTaskCheckbox(h.file, task, 'x'), /status changed/u);
    assert.equal(h.getContent(), before);
  });

  await t.test('date', async () => {
    const h = createMutableTaskNote({ id: 'stable', due: '2026-06-20' });
    const scanner = new TaskScanner(h.app as never, () => DEFAULT_TASK_STATES, () => '', () => DEFAULT_SETTINGS);
    const task = scanFileAsTask(h.file, h.app, DEFAULT_TASK_STATES);
    assert.ok(task);
    h.setContent(h.getContent().replace('due: 2026-06-20', 'due: 2026-06-22'));
    const before = h.getContent();
    await assert.rejects(scanner.updateTaskDate(h.file, task, 'due', '2026-06-21'), /due changed/u);
    assert.equal(h.getContent(), before);
  });

  await t.test('reminder', async () => {
    const h = createMutableTaskNote({ id: 'stable', reminder: '2026-06-20 09:00' });
    const scanner = new TaskScanner(h.app as never, () => DEFAULT_TASK_STATES, () => '', () => DEFAULT_SETTINGS);
    const task = scanFileAsTask(h.file, h.app, DEFAULT_TASK_STATES);
    assert.ok(task);
    h.setContent(h.getContent().replace('reminder: 2026-06-20 09:00', 'reminder: 2026-06-20 10:00'));
    const before = h.getContent();
    await assert.rejects(scanner.updateTaskDate(h.file, task, 'reminder', '2026-06-20 11:00'), /reminder changed/u);
    assert.equal(h.getContent(), before);
  });

  await t.test('time compares the complete overwritten value', async () => {
    const h = createMutableTaskNote({ id: 'stable', time: '09:00 - 10:00' });
    const scanner = new TaskScanner(h.app as never, () => DEFAULT_TASK_STATES, () => '', () => DEFAULT_SETTINGS);
    const task = scanFileAsTask(h.file, h.app, DEFAULT_TASK_STATES);
    assert.ok(task);
    h.setContent(h.getContent().replace('time: 09:00 - 10:00', 'time: 09:00 - 11:00'));
    const before = h.getContent();
    await assert.rejects(scanner.updateTaskDate(h.file, task, 'timeStart', '08:00'), /timeStart changed/u);
    assert.equal(h.getContent(), before);
  });

  await t.test('priority', async () => {
    const h = createMutableTaskNote({ id: 'stable', priority: 'normal' });
    const scanner = new TaskScanner(h.app as never, () => DEFAULT_TASK_STATES, () => '', () => DEFAULT_SETTINGS);
    const task = scanFileAsTask(h.file, h.app, DEFAULT_TASK_STATES);
    assert.ok(task);
    h.setContent(h.getContent().replace('priority: normal', 'priority: high'));
    const before = h.getContent();
    await assert.rejects(scanner.updateTaskPriority(h.file, task, 'highest'), /priority changed/u);
    assert.equal(h.getContent(), before);
  });
});

test('file-backed-tasks: date, reminder, time, and priority commits retain history semantics', async () => {
  const h = createMutableTaskNote({ id: 'stable', due: '2026-06-20', reminder: '2026-06-20 09:00', time: '09:00 - 10:00', priority: 'normal' });
  const actions: string[] = [];
  const scanner = new TaskScanner(
    h.app as never,
    () => DEFAULT_TASK_STATES,
    () => '',
    () => DEFAULT_SETTINGS,
    () => undefined,
    { recordChange: (entry: { action: string }) => { actions.push(entry.action); } } as never,
  );
  const task = scanFileAsTask(h.file, h.app, DEFAULT_TASK_STATES);
  assert.ok(task);

  const dated = await scanner.updateTaskDate(h.file, task, 'due', '2026-06-21');
  const reminded = await scanner.updateTaskDate(h.file, dated, 'reminder', '2026-06-20 10:00');
  const timed = await scanner.updateTaskDate(h.file, reminded, 'timeStart', '08:00');
  await scanner.updateTaskPriority(h.file, timed, 'high');

  assert.deepEqual(actions, ['date_change', 'date_change', 'date_change', 'priority_change']);
});

test('file-backed-tasks: committed return state is reparsed from exact process content, not MetadataCache', async () => {
  const h = createMutableTaskNote({ id: 'stable', description: 'Cached description', due: '2026-06-20', priority: 'normal' });
  const scanner = new TaskScanner(h.app as never, () => DEFAULT_TASK_STATES, () => '', () => DEFAULT_SETTINGS);
  const task = scanFileAsTask(h.file, h.app, DEFAULT_TASK_STATES);
  assert.ok(task);
  h.setContent(h.getContent()
    .replace('description: Cached description', 'description: Current exact-body description')
    .replace('priority: normal', 'priority: high'));

  const updated = await scanner.updateTaskDate(h.file, task, 'due', '2026-06-21');

  assert.equal(updated.body, 'Current exact-body description');
  assert.equal(updated.metadata.id, 'stable');
  assert.equal(updated.metadata.priority, 'high');
  assert.equal(updated.metadata.dates.due, '2026-06-21');
  assert.match(h.getContent(), /^description: Current exact-body description$/mu);
  assert.match(h.getContent(), /^priority: high$/mu);
  assert.match(h.getContent(), /^due: 2026-06-21$/mu);
});

test('file-backed-tasks: scanFileAsTask parses basic task-note', () => {
  const file = createMockFile('Tasks/Todo.md');
  const app = createMockApp({
    description: 'Buy groceries',
    status: 'todo',
    priority: 'high',
  });
  const task = scanFileAsTask(file, app, DEFAULT_TASK_STATES);
  assert.ok(task);
  assert.equal(task.body, 'Buy groceries');
  assert.equal(task.status, 'todo');
  assert.equal(task.metadata.priority, 'high');
  assert.equal(task.lineNumber, 0);
  assert.equal(task.filePath, 'Tasks/Todo.md');
});

test('file-backed-tasks: scanFileAsTask parses due date', () => {
  const file = createMockFile('Tasks/Project.md');
  const app = createMockApp({
    description: 'Complete project',
    due: '2026-07-15',
  });
  const task = scanFileAsTask(file, app, DEFAULT_TASK_STATES);
  assert.ok(task);
  assert.equal(task.metadata.dates.due, '2026-07-15');
});

test('file-backed-tasks: scanFileAsTask parses multiple dates', () => {
  const file = createMockFile('Tasks/Task.md');
  const app = createMockApp({
    description: 'Multi-date task',
    start: '2026-07-01',
    scheduled: '2026-07-10',
    due: '2026-07-20',
  });
  const task = scanFileAsTask(file, app, DEFAULT_TASK_STATES);
  assert.ok(task);
  assert.equal(task.metadata.dates.start, '2026-07-01');
  assert.equal(task.metadata.dates.scheduled, '2026-07-10');
  assert.equal(task.metadata.dates.due, '2026-07-20');
});

test('file-backed-tasks: scanFileAsTask parses priority', () => {
  const file = createMockFile('Tasks/Critical.md');
  const app = createMockApp({
    description: 'Urgent fix',
    priority: 'highest',
  });
  const task = scanFileAsTask(file, app, DEFAULT_TASK_STATES);
  assert.ok(task);
  assert.equal(task.metadata.priority, 'highest');
});

test('file-backed-tasks: scanFileAsTask parses task id', () => {
  const file = createMockFile('Tasks/Task.md');
  const app = createMockApp({
    description: 'Task with ID',
    id: 'task-abc-123',
  });
  const task = scanFileAsTask(file, app, DEFAULT_TASK_STATES);
  assert.ok(task);
  assert.equal(task.metadata.id, 'task-abc-123');
});

test('file-backed-tasks: scanFileAsTask parses effort', () => {
  const file = createMockFile('Tasks/Task.md');
  const app = createMockApp({
    description: 'Estimate work',
    effort: '3h 30m',
  });
  const task = scanFileAsTask(file, app, DEFAULT_TASK_STATES);
  assert.ok(task);
  assert.equal(task.metadata.effort, '3h 30m');
});

test('file-backed-tasks: scanFileAsTask parses cost', () => {
  const file = createMockFile('Tasks/Task.md');
  const app = createMockApp({
    description: 'Budget item',
    cost: '1500.75',
  });
  const task = scanFileAsTask(file, app, DEFAULT_TASK_STATES);
  assert.ok(task);
  assert.equal(task.metadata.cost, 1500.75);
});

test('file-backed-tasks: scanFileAsTask parses collaboration fields', () => {
  const file = createMockFile('Tasks/Task.md');
  const app = createMockApp({
    description: 'Team task',
    assignee: 'alice',
    reviewer: 'bob',
    project: 'Project X',
    team: 'Engineering',
  });
  const task = scanFileAsTask(file, app, DEFAULT_TASK_STATES);
  assert.ok(task);
  assert.equal(task.metadata.assignee, 'alice');
  assert.equal(task.metadata.reviewer, 'bob');
  assert.equal(task.metadata.project, 'Project X');
  assert.equal(task.metadata.team, 'Engineering');
});

test('file-backed-tasks: scanFileAsTask maps status strings correctly', () => {
  const testCases = [
    { status: 'todo', expected: ' ' },
    { status: 'in_progress', expected: '/' },
    { status: 'done', expected: 'x' },
    { status: 'cancelled', expected: '-' },
    { status: 'blocked', expected: '!' },
    { status: 'waiting', expected: '?' },
  ];

  for (const { status, expected } of testCases) {
    const file = createMockFile('Tasks/Task.md');
    const app = createMockApp({ description: 'Test', status });
    const task = scanFileAsTask(file, app, DEFAULT_TASK_STATES);
    assert.ok(task);
    assert.equal(task.checkbox, expected, `Failed for status: ${status}`);
  }
});

test('file-backed-tasks: scanFileAsTask maps frontmatter status through custom states', () => {
  const states = [
    { rawText: ' ', name: 'Todo', icon: '', type: 'todo' as const, nextStatusSymbol: 'D' },
    { rawText: 'D', name: 'Finished', icon: '', type: 'done' as const, nextStatusSymbol: ' ' },
    { rawText: 'C', name: 'Cancelled', icon: '', type: 'cancelled' as const, nextStatusSymbol: ' ' },
  ];
  const file = createMockFile('Tasks/Task.md');

  const doneTask = scanFileAsTask(file, createMockApp({ description: 'Done task', status: 'done' }), states);
  const namedTask = scanFileAsTask(file, createMockApp({ description: 'Finished task', status: 'finished' }), states);
  const cancelledTask = scanFileAsTask(file, createMockApp({ description: 'Cancelled task', status: 'cancelled' }), states);

  assert.equal(doneTask?.checkbox, 'D');
  assert.equal(doneTask?.status, 'done');
  assert.equal(namedTask?.checkbox, 'D');
  assert.equal(namedTask?.status, 'done');
  assert.equal(cancelledTask?.checkbox, 'C');
  assert.equal(cancelledTask?.status, 'cancelled');
});

test('file-backed-tasks: scanFileAsTask handles missing frontmatter', () => {
  const file = createMockFile('Tasks/Task.md');
  const app = {
    metadataCache: { getFileCache: () => ({ frontmatter: undefined }) },
  };
  const task = scanFileAsTask(file, app as any, DEFAULT_TASK_STATES);
  assert.equal(task, null);
});

test('file-backed-tasks: scanFileAsTask handles recurrence', () => {
  const file = createMockFile('Tasks/Task.md');
  const app = createMockApp({
    description: 'Recurring task',
    recurrence: 'every day',
  });
  const task = scanFileAsTask(file, app, DEFAULT_TASK_STATES);
  assert.ok(task);
  assert.ok(task.metadata.recurrence);
});

test('file-backed-tasks: scanFileAsTask sets lineNumber to 0', () => {
  const file = createMockFile('Tasks/Task.md');
  const app = createMockApp({ description: 'Test' });
  const task = scanFileAsTask(file, app, DEFAULT_TASK_STATES);
  assert.ok(task);
  assert.equal(task.lineNumber, 0);
});

test('file-backed-tasks: scanFileAsTask sets correct filePath', () => {
  const filePath = 'Tasks/Important.md';
  const file = createMockFile(filePath);
  const app = createMockApp({ description: 'Test' });
  const task = scanFileAsTask(file, app, DEFAULT_TASK_STATES);
  assert.ok(task);
  assert.equal(task.filePath, filePath);
});

test('file-backed-tasks: scanFileAsTask extracts tags from body', () => {
  const file = createMockFile('Tasks/Task.md');
  const app = createMockApp({
    description: 'Task with #urgent #important tags',
  });
  const task = scanFileAsTask(file, app, DEFAULT_TASK_STATES);
  assert.ok(task);
  assert.ok(task.tags.includes('urgent'));
  assert.ok(task.tags.includes('important'));
});

test('file-backed-tasks: scanFileAsTask extracts contexts from body', () => {
  const file = createMockFile('Tasks/Task.md');
  const app = createMockApp({
    description: 'Task with @alice @bob contexts',
  });
  const task = scanFileAsTask(file, app, DEFAULT_TASK_STATES);
  assert.ok(task);
  assert.ok(task.contexts.includes('alice'));
  assert.ok(task.contexts.includes('bob'));
});

test('file-backed-tasks: scanFileAsTask generates valid key', () => {
  const file = createMockFile('Tasks/MyTask.md');
  const app = createMockApp({ description: 'Test' });
  const task = scanFileAsTask(file, app, DEFAULT_TASK_STATES);
  assert.ok(task);
  assert.ok(task.key.includes('Tasks/MyTask.md'));
  assert.ok(task.key.includes('MyTask'));
});

test('file-backed-tasks: scanFileAsTask uses default status', () => {
  const file = createMockFile('Tasks/Task.md');
  const app = createMockApp({ description: 'No status' });
  const task = scanFileAsTask(file, app, DEFAULT_TASK_STATES);
  assert.ok(task);
  assert.equal(task.status, 'todo');
  assert.equal(task.checkbox, ' ');
});

// ── Recurrence last-occurrence child deletion (fix: Pass 92) ──────────────────

function fakeVaultFile(path: string): { path: string; extension: string; basename: string } {
  const name = path.split('/').pop() ?? path;
  return { path, extension: 'md', basename: name.replace(/\.md$/u, '') };
}

test('task-scanner: completing last recurring occurrence (for 1 time) with onCompletion:delete removes children', async () => {
  const file = fakeVaultFile('Tasks.md');
  let content = '- [ ] Weekly 🔁 every week for 1 time 📅 2026-06-01 🏁 delete\n  - child note\n';
  const app = {
    vault: {
      read: async () => content,
      process: async (_f: unknown, cb: (s: string) => string) => { content = cb(content); },
    },
  };
  const s = new TaskScanner(
    app as never,
    () => DEFAULT_TASK_STATES,
    () => '',
    () => ({ ...DEFAULT_SETTINGS, setDoneDate: false, setCreatedDate: false, recurrenceFutureOccurrences: 1 }),
  );
  const [task] = await s.scanFile(file as never);
  await s.updateTaskCheckbox(file as never, task, 'x');
  // Both the task line and the child should be gone.
  assert.equal(content.trim(), '', `Expected empty file after delete, got: ${JSON.stringify(content)}`);
});

test('task-scanner: stateful transitions reject scanner-detected identical anonymous duplicates', async () => {
  const file = fakeVaultFile('Tasks.md');
  let content = '- [ ] Same\n- [ ] Same\n';
  let processCalls = 0;
  const app = {
    vault: {
      read: async () => content,
      process: async (_file: unknown, transform: (current: string) => string) => { processCalls += 1; content = transform(content); },
    },
  };
  const taskScanner = new TaskScanner(app as never);
  const [task] = await taskScanner.scanFile(file as never);
  const outcome = await taskScanner.updateTaskCheckboxWithOutcome(file as never, task, 'x');
  assert.equal(outcome.outcome, 'blocked');
  if (outcome.outcome !== 'blocked') assert.fail('expected blocked lifecycle outcome');
  assert.match(outcome.reason, /durable state identity/u);
  assert.equal(processCalls, 0);
  assert.equal(content, '- [ ] Same\n- [ ] Same\n');
});

test('task-scanner: finite recurrence countdown is independent of tracked absolute counts across restarts', async (t) => {
  for (const initialLimit of [1, 2, 3, 4, 5, 6, 7, 8]) {
    for (const trackRecurrenceCount of [false, true]) {
      for (const restartAfterEveryCompletion of [false, true]) {
        await t.test(`N=${initialLimit} tracking=${trackRecurrenceCount} restart=${restartAfterEveryCompletion}`, async () => {
          const file = fakeVaultFile('Tasks.md');
          let content = `- [ ] Repeat 🔁 every day for ${initialLimit} times 📅 2026-06-01\n`;
          let pluginData: unknown = { state: { version: 1, snapshot: [], completions: [], recurrenceCounts: {} } };
          let runtime: { store: StateStore; scanner: TaskScanner } | undefined;
          const createRuntime = (): { store: StateStore; scanner: TaskScanner } => {
            const store = new StateStore({
              loadData: async () => structuredClone(pluginData),
              saveData: async (next: unknown) => { pluginData = structuredClone(next); },
            } as never);
            const app = {
              vault: {
                read: async () => content,
                process: async (_file: unknown, transform: (current: string) => string) => { content = transform(content); },
              },
            };
            return {
              store,
              scanner: new TaskScanner(
                app as never,
                () => DEFAULT_TASK_STATES,
                () => '',
                () => ({
                  ...DEFAULT_SETTINGS,
                  setDoneDate: false,
                  setCreatedDate: false,
                  recurrenceFutureOccurrences: 1,
                  trackRecurrenceCount,
                }),
                () => store,
              ),
            };
          };

          let previousLedgerMaximum = 0;
          for (let completion = 1; completion <= initialLimit; completion++) {
            if (!runtime || restartAfterEveryCompletion) runtime = createRuntime();
            const before = await runtime.scanner.scanFile(file as never);
            const activeBefore = before.filter((task) => task.status === 'todo');
            assert.equal(activeBefore.length, 1, `completion ${completion} should start with one active occurrence`);
            const current = activeBefore[0];
            assert.equal(current.metadata.recurrenceLimit, initialLimit - completion + 1);
            assert.equal(current.metadata.recurrenceCount, trackRecurrenceCount && completion > 1 ? completion - 1 : undefined);

            await runtime.scanner.updateTaskCheckbox(file as never, current, 'x');

            const after = await runtime.scanner.scanFile(file as never);
            const completed = after.filter((task) => task.status === 'done');
            const activeAfter = after.filter((task) => task.status === 'todo');
            assert.equal(completed.length, completion, `completion ${completion} should be retained exactly once`);
            assert.equal(activeAfter.length, completion < initialLimit ? 1 : 0);
            if (completion < initialLimit) {
              assert.equal(activeAfter[0].metadata.recurrenceLimit, initialLimit - completion);
              assert.equal(activeAfter[0].metadata.recurrenceCount, trackRecurrenceCount ? completion : undefined);
            }

            const durableCounts = after.map((candidate) => candidate.metadata.recurrenceCount).filter((value): value is number => value !== undefined);
            assert.equal(durableCounts.length > 0 ? Math.max(...durableCounts) : 0, trackRecurrenceCount ? completion : 0);
            const state = await runtime.store.loadState();
            const ledgerMaximum = Math.max(0, ...Object.values(state.recurrenceCounts ?? {}));
            assert.ok(ledgerMaximum >= previousLedgerMaximum, 'persisted recurrence counts must never decrease');
            if (!trackRecurrenceCount) assert.equal(ledgerMaximum, 0);
            previousLedgerMaximum = ledgerMaximum;
            assert.equal(Object.values(state.recurrenceOccurrences ?? {}).flat().length, completion);
          }
        });
      }
    }
  }
});

test('task-scanner: stale absolute recurrence count cannot suppress the inline countdown', async () => {
  const file = fakeVaultFile('Tasks.md');
  let content = '- [ ] Repeat 🔁 every day for 4 times 📅 2026-06-01 [recurrenceCount:: 99]\n';
  let pluginData: unknown = { state: { version: 1, snapshot: [], completions: [], recurrenceCounts: {} } };
  const store = new StateStore({
    loadData: async () => structuredClone(pluginData),
    saveData: async (next: unknown) => { pluginData = structuredClone(next); },
  } as never);
  const app = { vault: {
    read: async () => content,
    process: async (_file: unknown, transform: (current: string) => string) => { content = transform(content); },
  } };
  const taskScanner = new TaskScanner(
    app as never,
    () => DEFAULT_TASK_STATES,
    () => '',
    () => ({ ...DEFAULT_SETTINGS, setDoneDate: false, setCreatedDate: false, recurrenceFutureOccurrences: 1, trackRecurrenceCount: true }),
    () => store,
  );
  const [task] = await taskScanner.scanFile(file as never);
  await taskScanner.updateTaskCheckbox(file as never, task, 'x');
  const active = (await taskScanner.scanFile(file as never)).filter((candidate) => candidate.status === 'todo');
  assert.equal(active.length, 1);
  assert.equal(active[0].metadata.recurrenceLimit, 3);
  assert.equal(active[0].metadata.recurrenceCount, 100);
});

test('task-scanner: future pre-generation cannot exceed the finite inline countdown', async () => {
  const file = fakeVaultFile('Tasks.md');
  let content = '- [ ] Repeat 🔁 every day for 4 times 📅 2026-06-01\n';
  const app = { vault: {
    read: async () => content,
    process: async (_file: unknown, transform: (current: string) => string) => { content = transform(content); },
  } };
  const taskScanner = new TaskScanner(
    app as never,
    () => DEFAULT_TASK_STATES,
    () => '',
    () => ({ ...DEFAULT_SETTINGS, setDoneDate: false, setCreatedDate: false, recurrenceFutureOccurrences: 20 }),
  );
  const [task] = await taskScanner.scanFile(file as never);
  await taskScanner.updateTaskCheckbox(file as never, task, 'x');
  const active = (await taskScanner.scanFile(file as never)).filter((candidate) => candidate.status === 'todo');
  assert.deepEqual(active.map((candidate) => candidate.metadata.recurrenceLimit).sort((a, b) => (b ?? 0) - (a ?? 0)), [3, 2, 1]);
});

test('task-scanner: recurring count is durable in the spawned task when the ledger save fails', async () => {
  const file = fakeVaultFile('Tasks.md');
  let content = '- [ ] Weekly 🔁 every week 📅 2026-06-01 [recurrenceCount:: 2]\n';
  const store = new StateStore({
    loadData: async () => ({ state: { version: 1, snapshot: [], completions: [], recurrenceCounts: {} } }),
    saveData: async () => { throw new Error('ledger unavailable'); },
  } as never);
  const app = {
    vault: {
      read: async () => content,
      process: async (_file: unknown, transform: (current: string) => string) => { content = transform(content); },
    },
  };
  const taskScanner = new TaskScanner(
    app as never,
    () => DEFAULT_TASK_STATES,
    () => '',
    () => ({ ...DEFAULT_SETTINGS, setDoneDate: false, setCreatedDate: false, recurrenceFutureOccurrences: 1, trackRecurrenceCount: true }),
    () => store,
  );
  const [task] = await taskScanner.scanFile(file as never);
  await assert.rejects(taskScanner.updateTaskCheckbox(file as never, task, 'x'), /ledger unavailable/u);
  const spawned = (await taskScanner.scanFile(file as never)).find((candidate) => candidate.status === 'todo');
  assert.equal(spawned?.metadata.recurrenceCount, 3);
});

test('task-scanner: completing last recurring occurrence with onCompletion:archive archives children before removing source block', async () => {
  const file = fakeVaultFile('Tasks.md');
  let content = '- [ ] Weekly 🔁 every week for 1 time 📅 2026-06-01 🏁 archive\n  - child note\n';
  let archiveContent: string | null = null;
  const app = {
    vault: {
      read: async () => content,
      process: async (target: { path: string }, cb: (s: string) => string) => {
        if (target.path === 'Archive.md') archiveContent = cb(archiveContent ?? '');
        else content = cb(content);
      },
      getAbstractFileByPath: (path: string) => path === 'Archive.md' && archiveContent !== null
        ? { path: 'Archive.md', extension: 'md', basename: 'Archive' }
        : null,
      create: async (_path: string, next: string) => { archiveContent = next; return { path: 'Archive.md', extension: 'md', basename: 'Archive' }; },
      createFolder: async () => undefined,
    },
  };
  const s = new TaskScanner(
    app as never,
    () => DEFAULT_TASK_STATES,
    () => '',
    () => ({ ...DEFAULT_SETTINGS, setDoneDate: false, setCreatedDate: false, recurrenceFutureOccurrences: 1 }),
  );
  const [task] = await s.scanFile(file as never);
  await s.updateTaskCheckbox(file as never, task, 'x');

  assert.equal(content.trim(), '', `Expected source block to be removed after archive, got: ${JSON.stringify(content)}`);
  assert.match(archiveContent ?? '', /- \[x\] Weekly/u);
  assert.match(archiveContent ?? '', /  - child note/u);
});

test('task-scanner: completing one-off occurrence with onCompletion:collect collects children before removing source block', async () => {
  const file = fakeVaultFile('Tasks.md');
  let content = '- [ ] One-off 🏁 collect\n  - child note\n';
  let collectContent: string | null = null;
  const app = {
    vault: {
      read: async () => content,
      process: async (target: { path: string }, cb: (s: string) => string) => {
        if (target.path === 'Completed.md') collectContent = cb(collectContent ?? '');
        else content = cb(content);
      },
      getAbstractFileByPath: (path: string) => path === 'Completed.md' && collectContent !== null
        ? { path: 'Completed.md', extension: 'md', basename: 'Completed' }
        : null,
      create: async (_path: string, next: string) => { collectContent = next; return { path: 'Completed.md', extension: 'md', basename: 'Completed' }; },
      createFolder: async () => undefined,
    },
  };
  const s = new TaskScanner(
    app as never,
    () => DEFAULT_TASK_STATES,
    () => '',
    () => ({ ...DEFAULT_SETTINGS, setDoneDate: false, setCreatedDate: false }),
  );
  const [task] = await s.scanFile(file as never);
  await s.updateTaskCheckbox(file as never, task, 'x');

  assert.equal(content.trim(), '', `Expected source block to be removed after collect, got: ${JSON.stringify(content)}`);
  assert.match(collectContent ?? '', /## Collected Tasks/u);
  assert.match(collectContent ?? '', /- \[x\] One-off/u);
  assert.match(collectContent ?? '', /  - child note/u);
});

test('task-scanner: invalid archive/collect paths block before source mutation', async () => {
  const file = fakeVaultFile('Tasks.md');
  let content = '- [ ] Protected 🏁 collect\n';
  let processCount = 0;
  const app = {
    vault: {
      read: async () => content,
      process: async (_target: { path: string }, cb: (s: string) => string) => { processCount += 1; content = cb(content); },
      getAbstractFileByPath: () => null,
      create: async () => { throw new Error('must not write'); },
      createFolder: async () => { throw new Error('must not write'); },
    },
  };
  const scanner = new TaskScanner(
    app as never,
    () => DEFAULT_TASK_STATES,
    () => '',
    () => ({ ...DEFAULT_SETTINGS, collectFilePath: '../Completed.md', setDoneDate: false }),
  );
  const [task] = await scanner.scanFile(file as never);
  const result = await scanner.updateTaskCheckboxWithOutcome(file as never, task, 'x');
  assert.equal(result.outcome, 'blocked');
  assert.equal(processCount, 0);
  assert.equal(content, '- [ ] Protected 🏁 collect\n');
});

test('task-scanner: failed collect keeps the completed source block with children', async () => {
  const file = fakeVaultFile('Tasks.md');
  let content = '- [ ] One-off 🏁 collect\n  - child note\n';
  const app = {
    vault: {
      read: async () => content,
      process: async (_target: { path: string }, cb: (s: string) => string) => { content = cb(content); },
      getAbstractFileByPath: () => null,
      create: async () => {
        content += '- [ ] Concurrent edit\n';
        throw new Error('collect write failed');
      },
      createFolder: async () => undefined,
    },
  };
  const s = new TaskScanner(
    app as never,
    () => DEFAULT_TASK_STATES,
    () => '',
    () => ({ ...DEFAULT_SETTINGS, setDoneDate: false, setCreatedDate: false }),
  );
  const originalError = console.error;
  console.error = () => undefined;
  try {
    const [task] = await s.scanFile(file as never);
    const result = await s.updateTaskCheckboxWithOutcome(file as never, task, 'x');
    assert.equal(result.outcome, 'destination-failed');
  } finally {
    console.error = originalError;
  }

  assert.match(content, /- \[x\] One-off/u, 'failed collect should leave the completed task in the source');
  assert.match(content, /  - child note/u, 'failed collect should leave child lines in the source');
  assert.match(content, /Concurrent edit/u, 'failed collect should not roll back unrelated concurrent edits');
});

test('task-scanner: failed nested collect skips parent automation but records the retained child status', async () => {
  const file = fakeVaultFile('Tasks.md');
  let content = '- [ ] Parent 🏁 delete\n  - [ ] Child #collect-failure 🏁 collect\n';
  const history: Array<{ action: string; after: { status: string } }> = [];
  const app = {
    vault: {
      read: async () => content,
      process: async (_target: { path: string }, cb: (s: string) => string) => { content = cb(content); },
      getAbstractFileByPath: () => null,
      create: async () => { throw new Error('collect destination unavailable'); },
      createFolder: async () => undefined,
    },
  };
  const s = new TaskScanner(
    app as never,
    () => DEFAULT_TASK_STATES,
    () => '',
    () => ({
      ...DEFAULT_SETTINGS,
      setDoneDate: false,
      setCreatedDate: false,
      autoCompleteParent: true,
      workflowsEnabled: true,
      workflows: [{
        id: 'collect-failure-workflow',
        name: 'Must not run',
        triggerTag: 'collect-failure',
        steps: [{ name: 'Follow up', description: 'Unsafe follow up', status: ' ', priority: '' }],
      }],
    }),
    () => undefined,
    { recordChange: (entry: { action: string; after: { status: string } }) => { history.push(entry); } } as never,
  );
  const originalError = console.error;
  console.error = () => undefined;
  try {
    const tasks = await s.scanFile(file as never);
    const result = await s.updateTaskCheckboxWithOutcome(file as never, tasks[1], 'x');
    assert.equal(result.outcome, 'destination-failed');
  } finally {
    console.error = originalError;
  }

  assert.match(content, /^- \[ \] Parent 🏁 delete$/mu, 'delete parent must not auto-complete after collect failure');
  assert.match(content, /^  - \[x\] Child #collect-failure 🏁 collect$/mu, 'completed child must remain recoverable in the source');
  assert.doesNotMatch(content, /Unsafe follow up/u, 'workflow side effects must not run after destination failure');
  assert.deepEqual(history.map((entry) => [entry.action, entry.after.status]), [['status_change', 'done']]);
});

test('task-scanner: successful collect with unfinalized source skips parent and workflow side effects', async (t) => {
  for (const finalizationFailure of ['mismatch', 'throw'] as const) {
    await t.test(finalizationFailure, async () => {
      const file = fakeVaultFile('Tasks.md');
      let content = '- [ ] Parent 🏁 delete\n  - [ ] Child #collect-finalize 🏁 collect\n';
      let collectContent: string | null = null;
      let sourceProcessCount = 0;
      const history: Array<{ action: string; after: { status: string } }> = [];
      const app = {
        vault: {
          read: async () => content,
          process: async (target: { path: string }, cb: (s: string) => string) => {
            if (target.path === 'Completed.md') {
              collectContent = cb(collectContent ?? '');
              return;
            }
            sourceProcessCount += 1;
            if (sourceProcessCount === 2) {
              if (finalizationFailure === 'throw') throw new Error('source finalization failed');
              content = content.replace('Child #collect-finalize', 'Child changed elsewhere #collect-finalize');
            }
            content = cb(content);
          },
          getAbstractFileByPath: (path: string) => path === 'Completed.md' && collectContent !== null ? fakeVaultFile(path) : null,
          create: async (_path: string, next: string) => { collectContent = next; return fakeVaultFile('Completed.md'); },
          createFolder: async () => undefined,
        },
      };
      const s = new TaskScanner(
        app as never,
        () => DEFAULT_TASK_STATES,
        () => '',
        () => ({
          ...DEFAULT_SETTINGS,
          setDoneDate: false,
          setCreatedDate: false,
          autoCompleteParent: true,
          workflowsEnabled: true,
          workflows: [{
            id: 'collect-finalize-workflow',
            name: 'Must not run',
            triggerTag: 'collect-finalize',
            steps: [{ name: 'Follow up', description: 'Unsafe follow up', status: ' ', priority: '' }],
          }],
        }),
        () => undefined,
        { recordChange: (entry: { action: string; after: { status: string } }) => { history.push(entry); } } as never,
      );
      const originalError = console.error;
      console.error = () => undefined;
      try {
        const tasks = await s.scanFile(file as never);
        const result = await s.updateTaskCheckboxWithOutcome(file as never, tasks[1], 'x');
        assert.equal(result.outcome, 'source-conflict');
      } finally {
        console.error = originalError;
      }

      assert.match(collectContent ?? '', /- \[x\] Child #collect-finalize 🏁 collect/u, 'destination must retain the durable completed copy');
      assert.match(content, /^- \[ \] Parent 🏁 delete$/mu, 'delete parent must remain open');
      assert.match(content, /^  - \[x\] Child(?: changed elsewhere)? #collect-finalize 🏁 collect$/mu, 'unfinalized source child must remain recoverable');
      assert.doesNotMatch(content, /Unsafe follow up/u, 'workflow must not run against an unfinalized source');
      assert.deepEqual(history.map((entry) => [entry.action, entry.after.status]), [['status_change', 'done']]);
    });
  }
});

test('task-scanner: completing last recurring occurrence with onCompletion:collect collects children before removing source block', async () => {
  const file = fakeVaultFile('Tasks.md');
  let content = '- [ ] Weekly 🔁 every week for 1 time 📅 2026-06-01 🏁 collect\n  - child note\n';
  let collectContent: string | null = null;
  const app = {
    vault: {
      read: async () => content,
      process: async (target: { path: string }, cb: (s: string) => string) => {
        if (target.path === 'Completed.md') collectContent = cb(collectContent ?? '');
        else content = cb(content);
      },
      getAbstractFileByPath: (path: string) => path === 'Completed.md' && collectContent !== null
        ? { path: 'Completed.md', extension: 'md', basename: 'Completed' }
        : null,
      create: async (_path: string, next: string) => { collectContent = next; return { path: 'Completed.md', extension: 'md', basename: 'Completed' }; },
      createFolder: async () => undefined,
    },
  };
  const s = new TaskScanner(
    app as never,
    () => DEFAULT_TASK_STATES,
    () => '',
    () => ({ ...DEFAULT_SETTINGS, setDoneDate: false, setCreatedDate: false, recurrenceFutureOccurrences: 1 }),
  );
  const [task] = await s.scanFile(file as never);
  await s.updateTaskCheckbox(file as never, task, 'x');

  assert.equal(content.trim(), '', `Expected source block to be removed after collect, got: ${JSON.stringify(content)}`);
  assert.match(collectContent ?? '', /## Collected Tasks/u);
  assert.match(collectContent ?? '', /- \[x\] Weekly/u);
  assert.match(collectContent ?? '', /  - child note/u);
});

test('task-scanner: recurring archive and collect persist the complete child block before spawning the next occurrence', async (t) => {
  for (const action of ['archive', 'collect'] as const) {
    await t.test(action, async () => {
      const file = fakeVaultFile('Tasks.md');
      let content = `- [ ] Weekly 🔁 every week for 3 times 📅 2026-06-01 🏁 ${action}\n  - child note\n`;
      let destinationContent: string | null = null;
      const destinationPath = action === 'archive' ? 'Archive.md' : 'Completed.md';
      const app = {
        vault: {
          read: async () => content,
          process: async (target: { path: string }, cb: (s: string) => string) => {
            if (target.path === destinationPath) destinationContent = cb(destinationContent ?? '');
            else content = cb(content);
          },
          getAbstractFileByPath: (path: string) => path === destinationPath && destinationContent !== null ? fakeVaultFile(path) : null,
          create: async (_path: string, next: string) => { destinationContent = next; return fakeVaultFile(destinationPath); },
          createFolder: async () => undefined,
        },
      };
      const s = new TaskScanner(
        app as never,
        () => DEFAULT_TASK_STATES,
        () => '',
        () => ({ ...DEFAULT_SETTINGS, setDoneDate: false, setCreatedDate: false, recurrenceFutureOccurrences: 1 }),
      );
      const [task] = await s.scanFile(file as never);

      await s.updateTaskCheckbox(file as never, task, 'x');

      assert.match(destinationContent ?? '', /- \[x\] Weekly/u);
      assert.match(destinationContent ?? '', /  - child note/u);
      assert.match(content, /- \[ \] Weekly .*for 2 times/u);
      assert.match(content, /  - child note/u);
    });
  }
});

test('task-scanner: completing mid-series recurring occurrence with onCompletion:delete replaces task and keeps children', async () => {
  const file = fakeVaultFile('Tasks.md');
  let content = '- [ ] Weekly 🔁 every week for 3 times 📅 2026-06-01 🏁 delete\n  - child note\n';
  const app = {
    vault: {
      read: async () => content,
      process: async (_f: unknown, cb: (s: string) => string) => { content = cb(content); },
    },
  };
  const s = new TaskScanner(
    app as never,
    () => DEFAULT_TASK_STATES,
    () => '',
    () => ({ ...DEFAULT_SETTINGS, setDoneDate: false, setCreatedDate: false, recurrenceFutureOccurrences: 1 }),
  );
  const [task] = await s.scanFile(file as never);
  await s.updateTaskCheckbox(file as never, task, 'x');
  // Mid-series: next occurrence (for 2 times) should replace the old task; child remains.
  assert.match(content, /for 2 times/u);
  assert.match(content, /child note/u);
});

test('task-scanner: completing parent with spaced onCompletion move-to-end keeps children attached', async () => {
  const file = fakeVaultFile('Tasks.md');
  let content = [
    '# Today',
    '- [ ] Parent 🏁 move to end',
    '  - [ ] Child',
    '- [ ] Sibling',
    '# Next',
    '- [ ] Other',
    '',
  ].join('\n');
  const app = {
    vault: {
      read: async () => content,
      process: async (_f: unknown, cb: (s: string) => string) => { content = cb(content); },
    },
  };
  const s = new TaskScanner(
    app as never,
    () => DEFAULT_TASK_STATES,
    () => '',
    () => ({ ...DEFAULT_SETTINGS, setDoneDate: false, setCreatedDate: false }),
  );
  const [task] = await s.scanFile(file as never);

  await s.updateTaskCheckbox(file as never, task, 'x');

  assert.equal(content, [
    '# Today',
    '- [ ] Sibling',
    '- [x] Parent 🏁 move to end',
    '  - [ ] Child',
    '# Next',
    '- [ ] Other',
    '',
  ].join('\n'));
});

test('task-scanner: completing last recurring parent with onCompletion:move-to-end keeps children attached', async () => {
  const file = fakeVaultFile('Tasks.md');
  let content = [
    '# Today',
    '- [ ] Parent 🔁 every week for 1 time 📅 2026-06-01 🏁 move-to-end',
    '  - [ ] Child',
    '- [ ] Sibling',
    '',
  ].join('\n');
  const app = {
    vault: {
      read: async () => content,
      process: async (_f: unknown, cb: (s: string) => string) => { content = cb(content); },
    },
  };
  const s = new TaskScanner(
    app as never,
    () => DEFAULT_TASK_STATES,
    () => '',
    () => ({ ...DEFAULT_SETTINGS, setDoneDate: false, setCreatedDate: false, recurrenceFutureOccurrences: 1 }),
  );
  const [task] = await s.scanFile(file as never);

  await s.updateTaskCheckbox(file as never, task, 'x');

  assert.equal(content, [
    '# Today',
    '- [ ] Sibling',
    '- [x] Parent 🔁 every week for 1 time 📅 2026-06-01 🏁 move-to-end',
    '  - [ ] Child',
    '',
  ].join('\n'));
});

test('task-scanner: shifted one-off destructive lifecycle actions use the relocated task block', async (t) => {
  for (const action of ['delete', 'move-to-end', 'archive', 'collect'] as const) {
    for (const withChild of [false, true]) {
      await t.test(`${action}${withChild ? ' with children' : ''}`, async () => {
        const file = fakeVaultFile('Tasks.md');
        const child = withChild ? '  - [ ] Child\r\n' : '';
        let content = `- [ ] Target 🏁 ${action}\r\n${child}- [ ] Keep\r\n`;
        let archiveContent: string | null = null;
        let collectContent: string | null = null;
        const app = {
          vault: {
            read: async () => content,
            process: async (target: { path: string }, cb: (s: string) => string) => {
              if (target.path === 'Archive.md') archiveContent = cb(archiveContent ?? '');
              else if (target.path === 'Completed.md') collectContent = cb(collectContent ?? '');
              else content = cb(content);
            },
            getAbstractFileByPath: (path: string) => {
              if (path === 'Archive.md' && archiveContent !== null) return fakeVaultFile(path);
              if (path === 'Completed.md' && collectContent !== null) return fakeVaultFile(path);
              return null;
            },
            create: async (path: string, next: string) => {
              if (path === 'Archive.md') archiveContent = next;
              else if (path === 'Completed.md') collectContent = next;
              return fakeVaultFile(path);
            },
            createFolder: async () => undefined,
          },
        };
        const s = new TaskScanner(
          app as never,
          () => DEFAULT_TASK_STATES,
          () => '',
          () => ({ ...DEFAULT_SETTINGS, setDoneDate: false, setCreatedDate: false }),
        );
        const [renderedTask] = await s.scanFile(file as never);
        content = `intro inserted concurrently\r\n${content}`;

        await s.updateTaskCheckbox(file as never, renderedTask, 'x');

        assert.match(content, /^intro inserted concurrently\r\n/u);
        assert.match(content, /- \[ \] Keep\r\n/u);
        assert.equal(/(^|[^\r])\n/u.test(content), false, 'source CRLF endings must be preserved');
        if (action === 'delete') {
          assert.doesNotMatch(content, /Target|Child/u);
        } else if (action === 'move-to-end') {
          assert.match(content, /- \[ \] Keep\r\n- \[x\] Target/u);
          if (withChild) assert.match(content, /Target[^]*\r\n  - \[ \] Child/u);
        } else {
          assert.doesNotMatch(content, /Target|Child/u);
          const destination = action === 'archive' ? archiveContent : collectContent;
          assert.match(destination ?? '', /- \[x\] Target/u);
          if (withChild) assert.match(destination ?? '', /  - \[ \] Child/u);
        }
      });
    }
  }
});

test('task-scanner: pure editor and modal lifecycle helpers refuse archive and collect but preserve delete semantics', () => {
  const settings = { ...DEFAULT_SETTINGS, setDoneDate: false };
  for (const action of ['archive', 'collect']) {
    for (const recurrence of ['', ' 🔁 every day 📅 2026-06-01']) {
      const todoLine = `- [ ] Task${recurrence} 🏁 ${action}`;
      const doneLine = `- [x] Task${recurrence} 🏁 ${action}`;
      assert.equal(applyTaskCompletionLifecycleToLine(todoLine, 'x', DEFAULT_TASK_STATES, settings), null);
      assert.equal(rewriteTaskLineForStatusWithLifecycle(todoLine, 'x', settings), null);
      assert.equal(rewriteSubmittedTaskLineForModal(doneLine, settings), null);
    }
  }
  assert.deepEqual(
    applyTaskCompletionLifecycleToLine('- [ ] One-off 🏁 delete', 'x', DEFAULT_TASK_STATES, settings),
    [],
  );
  assert.deepEqual(rewriteSubmittedTaskLineForModal('- [x] One-off 🏁 delete', settings), []);
});

test('task-scanner: pure editor lifecycle treats recurring cancellation onCompletion as done-only', () => {
  const settings = { ...DEFAULT_SETTINGS, recurrenceOnCancelled: true, setCreatedDate: false, setCancelledDate: false, recurrenceFutureOccurrences: 1 };
  for (const action of ['archive', 'collect', 'delete', 'move-to-end'] as const) {
    const line = `- [ ] Cancel me 🔁 every day 📅 2026-06-01 🏁 ${action}`;
    assert.equal(durableCompletionDestinationAction(line, '-', DEFAULT_TASK_STATES, settings), null, action);
    const result = applyTaskCompletionLifecycleToLine(line, '-', DEFAULT_TASK_STATES, settings, '2026-06-01');
    assert.ok(result, action);
    assert.equal(result.length, 2, action);
    assert.ok(result.some((candidate) => /^- \[-\] Cancel me/u.test(candidate)), action);
    assert.ok(result.some((candidate) => /^- \[ \] Cancel me/u.test(candidate) && candidate.includes('2026-06-02')), action);
  }
});

test('task-scanner: recurring next occurrence strips colon ids and typed dependencies', () => {
  const lines = applyTaskCompletionLifecycleToLine(
    '- [ ] Follow up 🔁 every week 📅 2026-06-01 🆔 parent:child ⛔ dep1:FS, dep2:SS+2d',
    'x',
    DEFAULT_TASK_STATES,
    { ...DEFAULT_SETTINGS, setDoneDate: false, setCreatedDate: false, recurrenceFutureOccurrences: 1 },
    '2026-06-01',
  );

  assert.ok(lines);
  const next = lines[0];
  assert.equal(next, '- [ ] Follow up 🔁 every week 📅 2026-06-08');
});

test('task-scanner: skip recurrence checkbox update preserves CRLF line endings', async () => {
  let content = '- [ ] One 🔁 every day 📅 2026-06-01\r\n- [ ] Two\r\n';
  const file = { path: 'Tasks.md' };
  const app = {
    vault: {
      read: async () => content,
      process: async (_file: unknown, fn: (current: string) => string) => { content = fn(content); },
    },
  };
  const s = new TaskScanner(
    app as never,
    () => DEFAULT_TASK_STATES,
    () => '',
    () => ({ ...DEFAULT_SETTINGS, setDoneDate: false, setCreatedDate: false }),
  );
  const [task] = await s.scanFile(file as never);

  await s.updateTaskCheckboxSkipRecurrence(file as never, task, 'x');

  assert.equal(content, '- [x] One 🔁 every day 📅 2026-06-01\r\n- [ ] Two\r\n');
});
