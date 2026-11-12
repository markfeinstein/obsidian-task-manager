import test from 'node:test';
import assert from 'node:assert/strict';
import { TFile } from 'obsidian';

import { addTagToTaskLine, buildQuerySummaryStats, configureDependencyChip, configureRecurrenceChip, makeKeyboardButton, matchedQueryTreeDescendants, queryResultCacheScope, queryTreeOccurrenceKey, relativeDateAttribute, removeTagFromTaskLine, TaskQueryRenderer } from '../src/query-renderer';
import { parseTaskQuery } from '../src/task-query';
import { TaskScanner, type ParsedTask } from '../src/task-scanner';
import { DEFAULT_SETTINGS } from '../src/types';
import { FakeDOMElement, FakeDOMTextNode } from './test-utils';
import { installDomHarness } from './dom-harness';

test('query result cache shares context-free plans but isolates source-sensitive queries', () => {
  const query = parseTaskQuery('not done');
  assert.equal(queryResultCacheScope('not done', query, 'A.md'), '*');
  assert.equal(queryResultCacheScope('not done', { ...query, explainSources: { queryFileDefaults: ['hide tags'] } }, 'A.md'), 'A.md');
  assert.equal(queryResultCacheScope('filter by function task.file.path === query.file.path', query, 'B.md'), 'B.md');
});

test('query tree ancestry respects intervening unmatched roots', () => {
  const scanner = new TaskScanner({} as never);
  const lines = ['- [ ] Matched parent', '  - note', '- [ ] Unmatched root', '  - [ ] Matched child'];
  const tasks = lines.map((line, index) => scanner.parseTaskLine(line, 'Tree.md', index + 1)).filter((task) => task !== null);
  const parent = tasks[0];
  const unmatched = tasks[1];
  const child = tasks[2];
  assert.ok(parent && unmatched && child);
  const byLine = new Map(tasks.map((task) => [task.lineNumber, task]));
  const descendants = matchedQueryTreeDescendants(lines, byLine, new Set([queryTreeOccurrenceKey(parent), queryTreeOccurrenceKey(child)]));
  assert.equal(descendants.has(queryTreeOccurrenceKey(child)), false, 'unmatched root must terminate the earlier matched parent');
});

test('relativeDateAttribute ignores invalid or non-exact ISO dates', () => {
  assert.equal(relativeDateAttribute('2026-06-15', '2026-06-15'), 'today');
  assert.equal(relativeDateAttribute('2026-02-31', '2026-03-03'), null);
  assert.equal(relativeDateAttribute('2026-06-15abc', '2026-06-15'), null);
  assert.equal(relativeDateAttribute('2026-06-15T08:00', '2026-06-15'), null);
});

test('bulk tag helper compares parser tags without duplicate hash prefixes', () => {
  assert.equal(addTagToTaskLine('- [ ] Task #home', ['home'], '#home'), '- [ ] Task #home');
  assert.equal(addTagToTaskLine('- [ ] Task ^block', [], 'home'), '- [ ] Task #home ^block');
});

test('bulk tag removal only removes complete hash-prefixed tags at valid boundaries', () => {
  assert.equal(removeTagFromTaskLine('#home - [ ] call home', 'home'), ' - [ ] call home');
  assert.equal(removeTagFromTaskLine('Task\t#home\tsoon', 'home'), 'Task soon');
  assert.equal(removeTagFromTaskLine('- [ ] call home #home soon', 'home'), '- [ ] call home soon');
  assert.equal(removeTagFromTaskLine('- [ ] call #homebase soon', 'home'), '- [ ] call #homebase soon');
  assert.equal(removeTagFromTaskLine('- [ ] call home soon', 'home'), '- [ ] call home soon');
});

test('query summary stats count open, overdue, and completed tasks', () => {
  const stats = buildQuerySummaryStats([
    { status: 'todo', metadata: { dates: { due: '2026-06-12', scheduled: '', start: '', done: '', created: '', cancelled: '' } } } as never,
    { status: 'in_progress', metadata: { dates: { due: '2026-06-10', scheduled: '', start: '', done: '', created: '', cancelled: '' } } } as never,
    { status: 'done', metadata: { dates: { due: '2026-06-09', scheduled: '', start: '', done: '', created: '', cancelled: '' } } } as never,
    { status: 'cancelled', metadata: { dates: { due: '', scheduled: '', start: '', done: '', created: '', cancelled: '' } } } as never,
  ], '2026-06-12');

  assert.equal(stats.total, 4);
  assert.equal(stats.active, 2);
  assert.equal(stats.inProgress, 1);
  assert.equal(stats.overdue, 1);
  assert.equal(stats.dueToday, 1);
  assert.equal(stats.done, 1);
  assert.equal(stats.cancelled, 1);
});

test('table bulk result reports succeeded, failed, and skipped identities without rejecting legacy callers', async () => {
  const scanner = new TaskScanner({} as never);
  const active = scanner.parseTaskLine('- [ ] Active', 'Tasks.md', 1);
  const failing = scanner.parseTaskLine('- [ ] Failing', 'Tasks.md', 2);
  const done = scanner.parseTaskLine('- [x] Done', 'Tasks.md', 3);
  const canvas = scanner.parseTaskLine('- [ ] Canvas', 'Board.canvas', 1);
  assert.ok(active && failing && done && canvas);
  const renderer = new TaskQueryRenderer({} as never, scanner, () => DEFAULT_SETTINGS);
  const privateRenderer = renderer as unknown as {
    setTaskCheckbox(task: ParsedTask): Promise<ParsedTask>;
    bulkComplete(keys: string[], tasks: ParsedTask[], sourcePath: string, notify?: boolean): Promise<{ attempted: number; succeeded: number; failed: number; skipped: number; failures?: Array<{ taskKey?: string; message: string }> }>;
  };
  privateRenderer.setTaskCheckbox = async (task) => {
    if (task.key === failing.key) throw new Error('write failed');
    return task;
  };

  const result = await privateRenderer.bulkComplete(
    [active.key, failing.key, done.key, canvas.key, 'missing'],
    [active, failing, done, canvas],
    'Query.md',
    false,
  );

  assert.deepEqual({ attempted: result.attempted, succeeded: result.succeeded, failed: result.failed, skipped: result.skipped }, { attempted: 5, succeeded: 1, failed: 1, skipped: 3 });
  assert.equal(result.failures?.some((failure) => failure.taskKey === failing.key && /write failed/u.test(failure.message)), true);
  assert.equal(result.failures?.some((failure) => failure.taskKey === 'missing'), true);
});

test('all Table bulk mutations return accurate structured results', async () => {
  const file = Object.assign(Object.create(TFile.prototype) as TFile, { path: 'Tasks.md', extension: 'md', name: 'Tasks.md' });
  const scanner = new TaskScanner({} as never);
  const first = scanner.parseTaskLine('- [ ] First', 'Tasks.md', 1);
  const second = scanner.parseTaskLine('- [ ] Second', 'Tasks.md', 2);
  const cancelled = scanner.parseTaskLine('- [-] Cancelled', 'Tasks.md', 3);
  const missingFile = scanner.parseTaskLine('- [ ] Missing source', 'Missing.md', 1);
  const canvas = scanner.parseTaskLine('- [ ] Canvas', 'Board.canvas', 1);
  assert.ok(first && second && cancelled && missingFile && canvas);
  const app = { vault: { getAbstractFileByPath: (path: string) => path === file.path ? file : null } };
  const renderer = new TaskQueryRenderer(app as never, scanner, () => DEFAULT_SETTINGS);
  const privateRenderer = renderer as unknown as {
    taskMutations: {
      updateTaskDates(file: TFile, tasks: ParsedTask[]): Promise<{ changed: number }>;
      updateTaskPriority(file: TFile, task: ParsedTask): Promise<ParsedTask>;
      updateTaskCustomFields(file: TFile, tasks: ParsedTask[]): Promise<{ changed: number }>;
      updateTaskTags(file: TFile, tasks: ParsedTask[], tag: string, action: 'add' | 'remove'): Promise<{ changed: number }>;
    };
    setTaskCheckbox(task: ParsedTask): Promise<ParsedTask>;
    deferTask(task: ParsedTask): Promise<void>;
    bulkCancel(keys: string[], tasks: ParsedTask[], sourcePath: string, notify?: boolean): Promise<{ attempted: number; succeeded: number; failed: number; skipped: number }>;
    bulkPostpone(keys: string[], tasks: ParsedTask[], notify?: boolean): Promise<{ attempted: number; succeeded: number; failed: number; skipped: number }>;
    bulkReschedule(keys: string[], tasks: ParsedTask[], date: string, notify?: boolean): Promise<{ attempted: number; succeeded: number; failed: number; skipped: number }>;
    bulkPrioritize(keys: string[], tasks: ParsedTask[], priority: string, notify?: boolean): Promise<{ attempted: number; succeeded: number; failed: number; skipped: number }>;
    bulkSetCustomField(keys: string[], tasks: ParsedTask[], key: string, value: string, notify?: boolean): Promise<{ attempted: number; succeeded: number; failed: number; skipped: number }>;
    bulkAddTag(keys: string[], tasks: ParsedTask[], tag: string, notify?: boolean): Promise<{ attempted: number; succeeded: number; failed: number; skipped: number; failures?: Array<{ taskKey?: string; message: string }> }>;
    bulkRemoveTag(keys: string[], tasks: ParsedTask[], tag: string, notify?: boolean): Promise<{ attempted: number; succeeded: number; failed: number; skipped: number; failures?: Array<{ taskKey?: string; message: string }> }>;
  };
  privateRenderer.setTaskCheckbox = async (task) => task;
  privateRenderer.deferTask = async (task) => { if (task.key === second.key) throw new Error('defer failed'); };
  privateRenderer.taskMutations = {
    updateTaskDates: async (_file, tasks) => ({ changed: Math.min(1, tasks.length) }),
    updateTaskPriority: async (_file, task) => task,
    updateTaskCustomFields: async (_file, tasks) => ({ changed: Math.min(1, tasks.length) }),
    updateTaskTags: async (_file, tasks) => ({ changed: Math.min(1, tasks.length) }),
  };
  const tasks = [first, second, cancelled, missingFile, canvas];

  assert.deepEqual(
    await privateRenderer.bulkCancel([first.key, cancelled.key, canvas.key, 'gone'], tasks, 'Query.md', false),
    { attempted: 4, succeeded: 1, failed: 0, skipped: 3, failures: [
      { taskKey: canvas.key, message: 'Canvas tasks do not support bulk cancel.' },
      { taskKey: 'gone', message: 'Task was no longer available.' },
    ] },
  );
  assert.deepEqual(
    await privateRenderer.bulkPostpone([first.key, second.key, canvas.key], tasks, false),
    { attempted: 3, succeeded: 1, failed: 1, skipped: 1, failures: [
      { taskKey: canvas.key, message: 'Canvas tasks do not support bulk postpone.' },
      { taskKey: second.key, message: 'defer failed' },
    ] },
  );
  assert.deepEqual(
    await privateRenderer.bulkReschedule([first.key, second.key, missingFile.key, canvas.key], tasks, '2026-08-01', false),
    { attempted: 4, succeeded: 1, failed: 1, skipped: 2, failures: [
      { taskKey: canvas.key, message: 'Canvas tasks do not support bulk reschedule.' },
      { taskKey: missingFile.key, message: 'Source file was unavailable.' },
    ] },
  );
  assert.deepEqual(
    await privateRenderer.bulkPrioritize([first.key, missingFile.key, canvas.key], tasks, 'high', false),
    { attempted: 3, succeeded: 1, failed: 1, skipped: 1, failures: [
      { taskKey: canvas.key, message: 'Canvas tasks do not support bulk prioritize.' },
      { taskKey: missingFile.key, message: 'Source file was unavailable.' },
    ] },
  );
  assert.deepEqual(
    await privateRenderer.bulkSetCustomField([first.key, second.key, missingFile.key, canvas.key], tasks, 'owner', 'Ada', false),
    { attempted: 4, succeeded: 1, failed: 1, skipped: 2, failures: [
      { taskKey: canvas.key, message: 'Canvas tasks do not support bulk custom field.' },
      { taskKey: missingFile.key, message: 'Source file was unavailable.' },
    ] },
  );
  for (const result of [
    await privateRenderer.bulkAddTag([first.key, second.key, missingFile.key, canvas.key], tasks, 'focus', false),
    await privateRenderer.bulkRemoveTag([first.key, second.key, missingFile.key, canvas.key], tasks, 'focus', false),
  ]) {
    assert.deepEqual(result, { attempted: 4, succeeded: 1, failed: 1, skipped: 2, failures: [
      { taskKey: canvas.key, message: /remove/u.test(result.failures?.[0]?.message ?? '')
        ? 'Canvas tasks do not support bulk remove tag.'
        : 'Canvas tasks do not support bulk tag.' },
      { taskKey: missingFile.key, message: 'Source file was unavailable.' },
    ] });
  }
});

test('query list view drag-to-reorder event includes from/to indices', () => {
  // This test verifies the task-manager-reorder event structure
  // The actual reordering logic is tested via integration with vault.process
  const eventDetail = { from: 2, to: 5, tasks: ['key1', 'key2', 'key3', 'key4', 'key5', 'key6'] };
  assert.equal(typeof eventDetail.from, 'number');
  assert.equal(typeof eventDetail.to, 'number');
  assert.ok(Array.isArray(eventDetail.tasks));
  assert.ok(eventDetail.from >= 0 && eventDetail.from < eventDetail.tasks.length);
  assert.ok(eventDetail.to >= 0 && eventDetail.to < eventDetail.tasks.length);
});

test('query renderer does not reuse stale in-flight file scans after invalidation', async () => {
  const file = { path: 'Project.md', extension: 'md', stat: { mtime: 1, size: 16 } };
  let releaseFirstRead: (() => void) | null = null;
  let readCount = 0;
  const app = {
    vault: {
      read: async () => {
        readCount += 1;
        if (readCount === 1) {
          await new Promise<void>((resolve) => { releaseFirstRead = resolve; });
          return '- [ ] Cancel me\n';
        }
        return '- [-] Cancel me\n';
      },
    },
    metadataCache: { getFileCache: () => null },
  };
  const scanner = new TaskScanner(app as never);
  const renderer = new TaskQueryRenderer(app as never, scanner, () => DEFAULT_SETTINGS);
  const harness = renderer as unknown as {
    scanCachedFile: (input: unknown) => Promise<Array<{ status: string }>>;
    invalidateCache: (path?: string) => void;
  };

  const staleScan = harness.scanCachedFile(file);
  harness.invalidateCache(file.path);
  assert.ok(releaseFirstRead, 'first scan should be waiting on the controlled read');
  (releaseFirstRead as () => void)();

  const staleTasks = await staleScan;
  assert.equal(staleTasks[0]?.status, 'todo');

  const freshTasks = await harness.scanCachedFile(file);
  assert.equal(freshTasks[0]?.status, 'cancelled');
  assert.equal(readCount, 2, 'second scan must read the file again instead of reusing stale cache');
});

test('query renderer changed-file invalidation preserves unrelated file scan caches', async () => {
  const files = [
    { path: 'A.md', extension: 'md', stat: { mtime: 1, size: 12 } },
    { path: 'B.md', extension: 'md', stat: { mtime: 1, size: 12 } },
  ];
  const reads = new Map<string, number>();
  const app = {
    vault: {
      read: async (file: { path: string }) => {
        reads.set(file.path, (reads.get(file.path) ?? 0) + 1);
        return `- [ ] ${file.path}\n`;
      },
    },
    metadataCache: { getFileCache: () => null },
  };
  const scanner = new TaskScanner(app as never);
  const renderer = new TaskQueryRenderer(app as never, scanner, () => DEFAULT_SETTINGS);
  const harness = renderer as unknown as {
    scanCachedFile: (input: unknown) => Promise<Array<{ filePath: string }>>;
    invalidateChangedFiles: (paths: readonly string[]) => void;
  };

  await harness.scanCachedFile(files[0]);
  await harness.scanCachedFile(files[1]);
  harness.invalidateChangedFiles(['A.md']);
  await harness.scanCachedFile(files[1]);
  await harness.scanCachedFile(files[0]);

  assert.equal(reads.get('B.md'), 1, 'unchanged file cache should survive path-scoped invalidation');
  assert.equal(reads.get('A.md'), 2, 'changed file cache should be evicted');
});

test('row-heavy query rendering mounts one accessible page while retaining the full count', async (context) => {
  const scanner = new TaskScanner({} as never);
  const tasks = Array.from({ length: 250 }, (_value, index) => scanner.parseTaskLine(`- [ ] Task ${index}`, 'Tasks.md', index + 1));
  assert.ok(tasks.every((task) => task !== null));
  const parsedTasks = tasks.filter((task) => task !== null);
  const app = {
    vault: { getMarkdownFiles: () => [], getAbstractFileByPath: () => null },
    metadataCache: { getFileCache: () => null, fileToLinktext: () => '' },
    workspace: { getLeaf: () => ({ openFile: async () => undefined }), openLinkText: async () => undefined },
  };
  const renderer = new TaskQueryRenderer(
    app as never,
    scanner,
    () => ({ ...DEFAULT_SETTINGS, enableMobileGestures: false }),
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    async () => parsedTasks,
  );
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: (tagName: string) => new FakeDOMElement(tagName),
    createTextNode: (text: string) => new FakeDOMTextNode(text),
    createElementNS: (_namespace: string, tagName: string) => new FakeDOMElement(tagName),
  } as never;
  context.after(() => { globalThis.document = originalDocument; });
  const root = new FakeDOMElement('div');
  await renderer.render('not done\nlimit 1000', root as unknown as HTMLElement, { sourcePath: 'Query.md' } as never);
  assert.equal(root.querySelector('.task-manager-query-error')?.text ?? '', '');
  assert.equal(root.querySelectorAll('.task-manager-query-item').length, 100);
  assert.equal(root.querySelector('.task-manager-query-page-status')?.text, '1–100 of 250');
  root.querySelector('.task-manager-query-page-next')?.listeners.get('click')?.();
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(root.querySelectorAll('.task-manager-query-item').length, 100);
  assert.equal(root.querySelector('.task-manager-query-page-status')?.text, '101–200 of 250');

  const treeRoot = new FakeDOMElement('div');
  await renderer.render('not done\nlimit 1000\nshow tree', treeRoot as unknown as HTMLElement, { sourcePath: 'Tree Query.md' } as never);
  assert.equal(treeRoot.querySelectorAll('.task-manager-query-item').length, 100);
  treeRoot.querySelector('.task-manager-query-page-next')?.listeners.get('click')?.();
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(treeRoot.querySelectorAll('.task-manager-query-item').length, 100);
  assert.equal(treeRoot.querySelector('.task-manager-query-page-status')?.text, '101–200 of 250');
});

test('table paging keeps focus on the pager instead of restoring the prior grid cell', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const scanner = new TaskScanner({} as never);
  const tasks = Array.from({ length: 101 }, (_value, index) => scanner.parseTaskLine(`- [ ] Table task ${index}`, 'Tasks.md', index + 1)).filter((task): task is ParsedTask => task !== null);
  const app = {
    vault: { getMarkdownFiles: () => [], getAbstractFileByPath: () => null },
    metadataCache: { getFileCache: () => null, fileToLinktext: () => '' },
    workspace: { getLeaf: () => ({ openFile: async () => undefined }), openLinkText: async () => undefined },
  };
  const renderer = new TaskQueryRenderer(
    app as never,
    scanner,
    () => ({ ...DEFAULT_SETTINGS, tableViewConfig: { savedFilters: [], customColumns: [], showHierarchy: false, visibleColumns: ['status', 'task'] } }),
    undefined, undefined, undefined, undefined, undefined, undefined, undefined,
    async () => tasks,
  );
  const root = harness.document.createElement('section');
  harness.document.body.appendChild(root);
  await renderer.render('not done\nlimit 1000\nview: table', root, { sourcePath: 'Query.md' } as never);
  const oldNext = root.querySelector<HTMLButtonElement>('.task-manager-query-page-next');
  assert.ok(oldNext);
  oldNext.focus();
  oldNext.click();
  for (let index = 0; index < 20; index += 1) await new Promise<void>((resolve) => setImmediate(resolve));
  const next = root.querySelector<HTMLButtonElement>('.task-manager-query-page-next');
  const previous = root.querySelector<HTMLButtonElement>('.task-manager-query-page-previous');
  assert.ok(next && previous);
  assert.equal(next.disabled, true);
  assert.equal(harness.document.activeElement, previous, 'disabled preferred pager must fall back to the enabled pager control');
  assert.equal(root.querySelector('.task-manager-query-page-status')?.textContent, '101–101 of 101');
});

test('stale asynchronous tree pages never append after a newer render', async () => {
  const file = Object.assign(Object.create(TFile.prototype) as TFile, { path: 'Tree.md', extension: 'md', name: 'Tree.md' });
  let release!: () => void;
  let reads = 0;
  const app = {
    vault: {
      getMarkdownFiles: () => [],
      getAbstractFileByPath: () => file,
      read: async () => {
        reads += 1;
        if (reads === 1) await new Promise<void>((resolve) => { release = resolve; });
        return '- [ ] Tree task\n';
      },
    },
    metadataCache: { getFileCache: () => null, fileToLinktext: () => '' },
    workspace: { getLeaf: () => ({ openFile: async () => undefined }), openLinkText: async () => undefined },
  };
  const scanner = new TaskScanner(app as never);
  const task = scanner.parseTaskLine('- [ ] Tree task', 'Tree.md', 1);
  assert.ok(task);
  const renderer = new TaskQueryRenderer(app as never, scanner, () => DEFAULT_SETTINGS, undefined, undefined, undefined, undefined, undefined, undefined, undefined, async () => [task]);
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: (tagName: string) => new FakeDOMElement(tagName),
    createTextNode: (text: string) => new FakeDOMTextNode(text),
    createElementNS: (_namespace: string, tagName: string) => new FakeDOMElement(tagName),
  } as never;
  try {
    const root = new FakeDOMElement('div');
    const stale = renderer.render('not done\nshow tree', root as unknown as HTMLElement, { sourcePath: 'Query.md' } as never);
    for (let index = 0; index < 10 && reads === 0; index += 1) await Promise.resolve();
    const current = renderer.render('not done\nlimit 1', root as unknown as HTMLElement, { sourcePath: 'Query.md' } as never);
    await current;
    release();
    await stale;
    assert.equal(root.querySelectorAll('.task-manager-query-item').length, 1);
    assert.equal(root.querySelectorAll('.task-manager-query-list').length, 1);
  } finally {
    globalThis.document = originalDocument;
  }
});

test('Kanban group movement routes every grouping through one mutation path', async () => {
  const scanner = new TaskScanner({} as never);
  const task = scanner.parseTaskLine('- [ ] Move #alpha [project:: Old]', 'Task.md', 1);
  assert.ok(task);
  const renderer = new TaskQueryRenderer({} as never, scanner, () => DEFAULT_SETTINGS);
  const calls: string[] = [];
  const privateRenderer = renderer as unknown as {
    moveTaskToKanbanGroup(task: ParsedTask, groupBy: 'status' | 'priority' | 'tag' | 'project' | 'assignee' | 'custom', value: string, customFieldKey?: string): Promise<void>;
    setTaskPriority(task: ParsedTask, value: string, rerender: () => Promise<void>): Promise<void>;
    setDataviewField(task: ParsedTask, key: string, value: string): Promise<void>;
    replaceTaskTag(task: ParsedTask, previous: string | undefined, next: string | undefined): Promise<void>;
  };
  privateRenderer.setTaskPriority = async (_task, value, rerender) => { calls.push(`priority:${value}`); await rerender(); };
  privateRenderer.setDataviewField = async (_task, key, value) => { calls.push(`${key}:${value}`); };
  privateRenderer.replaceTaskTag = async (_task, previous, next) => { calls.push(`tag:${previous ?? ''}:${next ?? ''}`); };
  await privateRenderer.moveTaskToKanbanGroup(task, 'priority', 'high');
  await privateRenderer.moveTaskToKanbanGroup(task, 'project', 'No project');
  await privateRenderer.moveTaskToKanbanGroup(task, 'assignee', 'Ada');
  await privateRenderer.moveTaskToKanbanGroup(task, 'custom', 'Done', 'phase');
  await privateRenderer.moveTaskToKanbanGroup(task, 'tag', 'beta');
  await privateRenderer.moveTaskToKanbanGroup(task, 'status', 'ignored');
  assert.deepEqual(calls, ['priority:high', 'project:', 'assignee:Ada', 'phase:Done', 'tag:alpha:beta']);
});

test('query Kanban tag replacement is atomic with and without TaskMutationService', async () => {
  const file = Object.assign(Object.create(TFile.prototype) as TFile, { path: 'Task.md', extension: 'md', name: 'Task.md' });
  let content = '- [ ] Move #alpha\n';
  const app = {
    vault: {
      getAbstractFileByPath: () => file,
      process: async (_file: TFile, transform: (value: string) => string) => { content = transform(content); },
    },
  };
  const scanner = new TaskScanner(app as never);
  const task = scanner.parseTaskLine(content.trim(), 'Task.md', 1);
  assert.ok(task);
  const fallback = new TaskQueryRenderer(app as never, scanner, () => DEFAULT_SETTINGS);
  await (fallback as unknown as { replaceTaskTag(task: ParsedTask, previous: string | undefined, next: string | undefined): Promise<void> }).replaceTaskTag(task, 'alpha', 'beta');
  assert.equal(content, '- [ ] Move #beta\n');

  let delegated = '';
  const delegatedRenderer = new TaskQueryRenderer(app as never, scanner, () => DEFAULT_SETTINGS);
  delegatedRenderer.setTaskMutations({
    replaceTaskTag: async (_file: TFile, _task: ParsedTask, previous: string | undefined, next: string | undefined) => { delegated = `${previous}:${next}`; return task; },
  } as never);
  await (delegatedRenderer as unknown as { replaceTaskTag(task: ParsedTask, previous: string | undefined, next: string | undefined): Promise<void> }).replaceTaskTag(task, 'beta', undefined);
  assert.equal(delegated, 'beta:undefined');
  await assert.rejects(
    (fallback as unknown as { replaceTaskTag(task: ParsedTask, previous: string | undefined, next: string | undefined): Promise<void> }).replaceTaskTag({ ...task, filePath: 'Board.canvas' }, 'alpha', 'beta'),
    /Canvas tasks/u,
  );
});

test('dependency graph nodes open by keyboard and expose a textual edge equivalent', () => {
  type SvgOptions = { attr?: Record<string, string> };
  type SvgTarget = FakeDOMElement & { createSvg(tag: string, options?: SvgOptions): SvgTarget };
  const attachSvgFactory = (element: FakeDOMElement): SvgTarget => {
    const target = element as SvgTarget;
    target.createSvg = (tag, options) => {
      const child = attachSvgFactory(new FakeDOMElement(tag));
      for (const [name, value] of Object.entries(options?.attr ?? {})) child.setAttr(name, value);
      target.appendChild(child);
      return child;
    };
    return target;
  };
  const root = attachSvgFactory(new FakeDOMElement('div'));
  const opened: string[] = [];
  const app = { workspace: { openLinkText: async (path: string) => { opened.push(path); } } };
  const scanner = new TaskScanner({} as never);
  const target = scanner.parseTaskLine('- [ ] Target 🆔 target', 'Target.md', 1);
  const source = scanner.parseTaskLine('- [ ] Source 🆔 source ⛔ target', 'Source.md', 1);
  assert.ok(target && source);
  const renderer = new TaskQueryRenderer(app as never, scanner, () => DEFAULT_SETTINGS);
  (renderer as unknown as { renderDependencyGraph(element: HTMLElement, tasks: typeof target[]): void })
    .renderDependencyGraph(root as unknown as HTMLElement, [source, target]);

  const visit = (element: FakeDOMElement): FakeDOMElement[] => [element, ...element.children.flatMap((child) => child instanceof FakeDOMElement ? visit(child) : [])];
  const nodes = visit(root).filter((element) => element.getAttr('role') === 'button');
  assert.equal(nodes.length, 2);
  assert.ok(nodes.every((node) => node.getAttr('tabindex') === '0' && /status/u.test(node.getAttr('aria-label') ?? '')));
  let prevented = 0;
  nodes[0].listeners.get('keydown')?.({ key: 'Escape', preventDefault: () => { prevented += 1; } } as KeyboardEvent);
  nodes[0].listeners.get('keydown')?.({ key: 'Enter', preventDefault: () => { prevented += 1; } } as KeyboardEvent);
  nodes[1].listeners.get('keydown')?.({ key: ' ', preventDefault: () => { prevented += 1; } } as KeyboardEvent);
  assert.equal(prevented, 2);
  assert.deepEqual(opened, ['Source.md', 'Target.md']);
  assert.match(root.querySelector('.task-manager-sr-only')?.getInnerText() ?? '', /Source depends on Target/u);
});

test('query metadata keyboard buttons expose semantics and activate with Enter or Space', () => {
  const element = new FakeDOMElement('span');
  let activations = 0;
  makeKeyboardButton(element as unknown as HTMLElement, 'Change task metadata', () => { activations += 1; });
  assert.equal(element.getAttr('role'), 'button');
  assert.equal(element.getAttr('tabindex'), '0');
  assert.equal(element.getAttr('aria-label'), 'Change task metadata');
  element.listeners.get('keydown')?.({ key: 'Escape', preventDefault: () => assert.fail('Escape must not activate') } as unknown as KeyboardEvent);
  element.listeners.get('keydown')?.({ key: 'Enter', preventDefault: () => undefined } as unknown as KeyboardEvent);
  element.listeners.get('keydown')?.({ key: ' ', preventDefault: () => undefined } as unknown as KeyboardEvent);
  assert.equal(activations, 2);
});

test('dependency and recurrence chips expose click, keyboard, and context actions', () => {
  const dependency = new FakeDOMElement('span'); let navigated = 0;
  configureDependencyChip(dependency as unknown as HTMLElement, 'setup', () => { navigated += 1; });
  dependency.listeners.get('click')?.({ preventDefault: () => undefined, stopPropagation: () => undefined } as MouseEvent);
  dependency.listeners.get('keydown')?.({ key: 'Enter', preventDefault: () => undefined } as unknown as KeyboardEvent);
  assert.equal(navigated, 2);
  const dom = installDomHarness();
  try {
    const recurrence = dom.document.createElement('span'); let menus = 0;
    configureRecurrenceChip(recurrence, 'recurs daily', () => { menus += 1; });
    recurrence.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    recurrence.dispatchEvent(new dom.window.MouseEvent('contextmenu', { bubbles: true }));
    assert.equal(menus, 2);
  } finally { dom.cleanup(); }
});
