import test from 'node:test';
import assert from 'node:assert/strict';
import TaskManagerPlugin, { type TaskManagerApiV1 } from '../src/main';
import { normalizeTaskManagerSettings, type TaskManagerSettings } from '../src/types';
import { CliHandler } from '../src/cli-handler';
import { TaskScanner, type ParsedTask } from '../src/task-scanner';
import { TaskEditModal } from '../src/modals/task-edit-modal';
import { installDomHarness } from './dom-harness';
import { MockApp } from './test-utils';

interface ApiPluginHarness {
  settings: TaskManagerSettings;
  app: unknown;
  tasksByFile: Map<string, ParsedTask[]>;
  statusChangeHandlers: Array<(task: ParsedTask, oldStatus: string) => void>;
  cacheUpdateHandlers: Array<(tasks: ParsedTask[]) => void>;
  apiV1: TaskManagerApiV1;
  registerApi(): void;
}

function makePlugin(overrides: Record<string, unknown> = {}, app: unknown = new MockApp()): ApiPluginHarness {
  const plugin = Object.create(TaskManagerPlugin.prototype) as ApiPluginHarness;
  plugin.settings = normalizeTaskManagerSettings(overrides);
  plugin.app = app;
  plugin.tasksByFile = new Map();
  plugin.statusChangeHandlers = [];
  plugin.cacheUpdateHandlers = [];
  plugin.registerApi();
  return plugin;
}

test('main api executeQuery rejects function queries when scripting is disabled', async () => {
  const plugin = makePlugin({
    enableQueryDsl: true,
    enableDslExpressions: false,
  });

  const result = await plugin.apiV1.executeQuery('filter by function true');

  assert.equal(result.success, false);
  assert.match(result.error ?? '', /Function expressions are disabled/u);
  assert.equal('data' in result, false, 'failed API results cannot also expose success data');
});

test('main api executeQuery still allows function queries when scripting is enabled', async () => {
  const plugin = makePlugin({
    enableQueryDsl: true,
    enableDslExpressions: true,
  });

  const result = await plugin.apiV1.executeQuery('filter by function true');

  assert.equal(result.success, true);
  assert.equal(result.data?.count, 0);
});

test('main API and CLI return identical metadata-aware query results', async () => {
  const app = new MockApp();
  app.vault.files.set('Project.md', { content: '- [ ] Shared', mtime: Date.now() });
  app.metadataCache.setFileCache('Project.md', {
    frontmatter: { area: 'work', TQ_show_tags: false },
    links: [{ link: 'Target' }],
  } as never);
  const scanner = new TaskScanner(app as never);
  const task = scanner.parseTaskLine('- [ ] Shared', 'Project.md', 1);
  assert.ok(task);
  const settings = {
    enableQueryDsl: true,
    enableDslExpressions: true,
  };
  const plugin = makePlugin(settings, app);
  plugin.tasksByFile.set('Project.md', [task]);
  const cli = new CliHandler(app as never, scanner, () => plugin.settings, () => [task]);
  const query = 'filter by function task.file.property("area") === "work" && task.file.outlinks.includes("[[Target]]")';

  const [apiResult, cliResult] = await Promise.all([
    plugin.apiV1.executeQuery(query, 'json', { sourcePath: 'Project.md' }),
    cli.executeQuery(query, 'json', 'Project.md'),
  ]);

  assert.equal(apiResult.success, true);
  assert.equal(cliResult.success, true);
  const apiTasks = apiResult.data?.tasks;
  assert.ok(Array.isArray(apiTasks));
  assert.deepEqual(apiTasks.map((item) => item.key), cliResult.data?.tasks.map((item) => item.key));
});

test('main API and CLI reject empty queries and serialize CSV/Markdown identically', async () => {
  const app = new MockApp();
  const scanner = new TaskScanner(app as never);
  const task = scanner.parseTaskLine('- [ ] Shared #work', 'Project.md', 1);
  assert.ok(task);
  const plugin = makePlugin({}, app);
  plugin.tasksByFile.set('Project.md', [task]);
  const cli = new CliHandler(app as never, scanner, () => plugin.settings, () => [task]);
  const [apiEmpty, cliEmpty] = await Promise.all([plugin.apiV1.executeQuery(''), cli.executeQuery('')]);
  assert.equal(apiEmpty.success, false);
  assert.equal(apiEmpty.error, cliEmpty.error);
  for (const format of ['csv', 'markdown'] as const) {
    const [apiResult, cliResult] = await Promise.all([plugin.apiV1.executeQuery('not done', format), cli.executeQuery('not done', format)]);
    assert.equal(apiResult.success, true);
    assert.equal(cliResult.success, true);
    assert.equal(apiResult.data?.tasks, cli.formatOutput(cliResult, format));
  }
});

test('main API task modal promises settle as cancelled on generic dismissal', async (context) => {
  const dom = installDomHarness();
  context.after(dom.cleanup);
  const plugin = makePlugin({}, {
    vault: { getMarkdownFiles: () => [], getAbstractFileByPath: () => null },
    metadataCache: { getFileCache: () => undefined },
  });
  const originalOpen = TaskEditModal.prototype.open;
  let opened: TaskEditModal | undefined;
  const captureOpened = (modal: TaskEditModal): void => { opened = modal; };
  TaskEditModal.prototype.open = function openAndCapture(): void {
    captureOpened(this);
    originalOpen.call(this);
  };
  context.after(() => { TaskEditModal.prototype.open = originalOpen; });

  for (const launch of [
    () => plugin.apiV1.createTaskLineModal(),
    () => plugin.apiV1.editTaskLineModal('- [ ] Existing'),
  ]) {
    opened = undefined;
    const pending = launch();
    const current = opened as TaskEditModal | undefined;
    assert.ok(current);
    current.close();
    assert.equal(await pending, '');
  }
});

test('post-write task-modal refresh failures do not reopen the committed transaction', () => {
  const plugin = makePlugin();
  let invalidated = '';
  const internals = plugin as unknown as {
    queryRenderer: { invalidateCache(path: string): void };
    finishTaskModalWrite(path: string, onUpdated: () => void): void;
  };
  internals.queryRenderer = { invalidateCache: (path) => { invalidated = path; } };

  assert.doesNotThrow(() => internals.finishTaskModalWrite('Task.md', () => { throw new Error('render failed'); }));
  assert.equal(invalidated, 'Task.md');
});

test('main api getTasksForFile returns a defensive array copy', () => {
  const plugin = makePlugin();
  const task = { key: 'real', status: 'todo', filePath: 'A.md', lineNumber: 1, metadata: { dates: {} } } as ParsedTask;
  plugin.tasksByFile.set('A.md', [task]);

  const returned = plugin.apiV1.getTasksForFile('A.md');
  returned.push({ key: 'injected', status: 'todo', filePath: 'A.md', lineNumber: 2, metadata: { dates: {} } } as ParsedTask);

  assert.equal(plugin.apiV1.getTasksForFile('A.md').length, 1);
  assert.equal(plugin.apiV1.getAllTasks().length, 1);
});

test('main api refuses cold snapshot reads', () => {
  const plugin = Object.create(TaskManagerPlugin.prototype) as ApiPluginHarness;
  plugin.settings = normalizeTaskManagerSettings({});
  plugin.app = new MockApp();
  plugin.statusChangeHandlers = [];
  plugin.cacheUpdateHandlers = [];
  plugin.registerApi();
  assert.throws(() => plugin.apiV1.getAllTasks(), /whenTaskIndexReady/u);
  assert.throws(() => plugin.apiV1.getTasksForFile('A.md'), /whenTaskIndexReady/u);
});

test('Datacore registration waits for index readiness', async () => {
  let release!: () => void;
  const ready = new Promise<void>((resolve) => { release = resolve; });
  let registered = 0;
  const plugin = Object.create(TaskManagerPlugin.prototype) as unknown as {
    getTaskIndex(): { whenReady(): Promise<void> };
    registerWithDatacore(): void;
    registerWithDatacoreWhenReady(): Promise<void>;
  };
  plugin.getTaskIndex = () => ({ whenReady: () => ready });
  plugin.registerWithDatacore = () => { registered += 1; };
  const pending = plugin.registerWithDatacoreWhenReady();
  assert.equal(registered, 0);
  release(); await pending;
  assert.equal(registered, 1);
});
