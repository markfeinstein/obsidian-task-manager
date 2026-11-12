import test from 'node:test';
import assert from 'node:assert/strict';
import { TFile } from 'obsidian';
import TaskManagerPlugin from '../src/main';
import { StateStore, type PersistedState } from '../src/state-store';
import { TaskIndex } from '../src/task-index';
import { TaskScanner, type ParsedTask } from '../src/task-scanner';
import { TaskQueryRenderer } from '../src/query-renderer';
import { TaskPanelView } from '../src/sidebar-view';
import { DashboardMarkdownRenderer } from '../src/dashboard';
import { parseTaskQuery } from '../src/task-query';
import { DEFAULT_SETTINGS } from '../src/types';

function parsedTask(line = '- [ ] Indexed task', path = 'Tasks.md', lineNumber = 1): ParsedTask {
  const task = new TaskScanner({} as never).parseTaskLine(line, path, lineNumber);
  assert.ok(task);
  return task;
}

function file(path: string, mtime = 1, size = 10): TFile {
  const value = Object.assign(Object.create(TFile.prototype), {
    path,
    extension: path.split('.').pop() ?? '',
    stat: { mtime, size },
  });
  return value as TFile;
}

test('TaskIndex publishes immutable defensive snapshots and prefix removals', async () => {
  const index = new TaskIndex();
  const changes: number[] = [];
  index.subscribe((change) => changes.push(change.revision));
  index.beginHydration();
  index.markReady();

  const first = parsedTask('- [ ] One', 'Folder/One.md');
  const second = parsedTask('- [ ] Two', 'Folder/Sub/Two.md');
  index.commit(new Map([['Folder/One.md', [first]], ['Folder/Sub/Two.md', [second]]]));
  assert.equal(index.isReady(), true);
  assert.equal(index.getSnapshot().revision, 1);
  const external = index.getAllTasks();
  external.length = 0;
  assert.equal(index.getAllTasks().length, 2);

  assert.equal(index.commit(new Map([['Folder/One.md', [first]], ['Folder/Sub/Two.md', [second]]])), null);
  index.removePath('Folder');
  assert.deepEqual(index.getPaths(), []);
  assert.deepEqual(changes, [1, 2]);
  await index.whenReady();
});

test('TaskIndex snapshots stay revision-stable and lazily share immutable task materializations', () => {
  const index = new TaskIndex();
  const original = parsedTask('- [ ] Context task', 'Context.md');
  original.contexts = ['home'];
  index.commit(new Map([['Context.md', [original]]]));
  const first = index.getSnapshot();
  const firstTasks = first.tasks;
  assert.strictEqual(first.tasks, firstTasks);
  assert.equal(typeof (first.byFile as unknown as { set?: unknown }).set, 'undefined');
  assert.equal(first.byFile.size, 1);
  assert.equal(first.byFile.has('Context.md'), true);
  assert.equal(first.byFile.get('Context.md')?.length, 1);
  assert.deepEqual([...first.byFile.keys()], ['Context.md']);
  assert.equal([...first.byFile.values()][0]?.length, 1);
  assert.deepEqual([...first.byFile.entries()].map(([path]) => path), ['Context.md']);
  const visited: string[] = [];
  first.byFile.forEach((_tasks, path, map) => { visited.push(path); assert.strictEqual(map, first.byFile); });
  assert.deepEqual(visited, ['Context.md']);
  assert.deepEqual([...first.byFile].map(([path]) => path), ['Context.md']);
  assert.strictEqual(index.getInternalTasks(), firstTasks);

  const changed = parsedTask('- [ ] Context task', 'Context.md');
  changed.contexts = ['work'];
  const publication = index.commit(new Map([['Context.md', [changed]]]));
  assert.equal(publication?.revision, 2);
  assert.deepEqual(first.tasks[0]?.contexts, ['home']);
  assert.deepEqual(index.getSnapshot().tasks[0]?.contexts, ['work']);
  original.contexts.push('mutated-after-commit');
  assert.deepEqual(first.tasks[0]?.contexts, ['home']);
});

test('StateStore uses one authoritative loaded snapshot across serialized write transactions', async () => {
  let loads = 0;
  let persisted: unknown = { state: { version: 1, snapshot: [], completions: [] } };
  const store = new StateStore({
    loadData: async () => { loads += 1; return structuredClone(persisted); },
    saveData: async (value: unknown) => { persisted = structuredClone(value); },
  } as never);
  await store.loadState();
  await store.loadState();
  assert.equal(loads, 1);
  await store.updateState((state) => ({ ...state, recurrenceCounts: { sample: 1 } }));
  assert.equal(loads, 1, 'queued writes transform the authoritative in-memory snapshot');
  assert.equal(store.getStateRevision(), 1);
  await store.loadState();
  assert.equal(loads, 1);
});

test('plugin mutable identity projections do not alias frozen StateStore snapshots', async () => {
  const store = new StateStore({
    loadData: async () => ({ state: {
      version: 1,
      snapshot: [],
      completions: [{ taskKey: 'legacy', sourcePath: 'A.md', dailyNotePath: 'Daily.md', completedAtIso: '2026-07-13T00:00:00.000Z', logLineHash: 'hash' }],
      recurrenceCounts: { legacy: 1 },
    } }),
    saveData: async () => undefined,
  } as never);
  const persisted = await store.loadState();
  const plugin = Object.create(TaskManagerPlugin.prototype) as unknown as { stateStore: StateStore; completions: PersistedState['completions']; recurrenceCounts: Record<string, number>; applyPersistentStateProjection(state: PersistedState): void };
  plugin.stateStore = store;
  plugin.applyPersistentStateProjection(persisted);
  const projectedCompletion = plugin.completions[0];
  assert.ok(projectedCompletion);
  projectedCompletion.taskKey = 'durable';
  plugin.recurrenceCounts.durable = plugin.recurrenceCounts.legacy ?? 0;
  delete plugin.recurrenceCounts.legacy;
  assert.equal(persisted.completions[0]?.taskKey, 'legacy');
  assert.equal(persisted.recurrenceCounts?.legacy, 1);
});

test('scan persistence self-heals recurrence count and occurrence ledgers from durable task metadata', async () => {
  let pluginData: unknown = { state: { version: 1, snapshot: [], completions: [], recurrenceCounts: {} } };
  const store = new StateStore({
    loadData: async () => structuredClone(pluginData),
    saveData: async (value: unknown) => { pluginData = structuredClone(value); },
  } as never);
  const recurring = parsedTask('- [x] Repeat 🔁 every day 📅 2026-07-13 ✅ 2026-07-13 [recurrenceCount:: 3] [recurrenceSeriesId:: series]', 'Repeat.md');
  const index = new TaskIndex();
  index.commit(new Map([['Repeat.md', [recurring]]]));
  const plugin = Object.create(TaskManagerPlugin.prototype) as unknown as {
    stateStore: StateStore; taskIndex: TaskIndex; snapshot: Map<string, never>; completions: never[];
    pendingCompletionKeyMigrations: Map<string, string>; pendingRecurrenceCountMigrations: Map<string, string>;
    pendingRemovedIndexPaths: Set<string>; firedReminders: Set<string>; persistSyncState: () => Promise<void>;
    persistState(): Promise<void>;
  };
  Object.assign(plugin, {
    stateStore: store, taskIndex: index, snapshot: new Map(), completions: [],
    pendingCompletionKeyMigrations: new Map(), pendingRecurrenceCountMigrations: new Map(),
    pendingRemovedIndexPaths: new Set(), firedReminders: new Set(), persistSyncState: async () => undefined,
  });
  await plugin.persistState();
  const state = await store.loadState();
  assert.equal(state.recurrenceCounts?.[recurring.key], 3);
  assert.equal(state.recurrenceOccurrences?.series?.[0]?.date, '2026-07-13');
});

test('TaskIndex dispose resolves old readiness waiters but resets readiness for reuse', async () => {
  const index = new TaskIndex();
  index.beginHydration();
  let oldResolved = false;
  const oldReady = index.whenReady().then(() => { oldResolved = true; });

  index.dispose();
  await oldReady;
  assert.equal(oldResolved, true);

  let newResolved = false;
  const newReady = index.whenReady().then(() => { newResolved = true; });
  await Promise.resolve();
  assert.equal(newResolved, false);

  index.beginHydration();
  index.markReady();
  await newReady;
  assert.equal(newResolved, true);
});

test('TaskIndex strict snapshot accessor rejects degraded data without changing permissive read readiness', async () => {
  const healthy = new TaskIndex();
  healthy.beginHydration();
  healthy.markReady();
  assert.equal((await healthy.requireHealthySnapshot()).readiness, 'ready');

  const degraded = new TaskIndex();
  degraded.beginHydration();
  degraded.markReady(true);
  await degraded.whenReady();
  assert.equal(degraded.isReady(), true, 'read-only consumers retain the ready-or-degraded contract');
  await assert.rejects(() => degraded.requireHealthySnapshot(), /degraded/u);
});

test('StateStore bulk fingerprints preserve stats and avoid repeated map replacement semantics', async () => {
  const store = new StateStore({ loadData: async () => ({}), saveData: async () => undefined } as never);
  const state: PersistedState = { version: 1, snapshot: [], completions: [] };
  const next = store.setFileHashes(state, [
    { path: 'A.md', content: 'a', stat: { mtime: 1, size: 1 } },
    { path: 'B.md', content: 'b', stat: { mtime: 2, size: 1 } },
  ]);
  assert.equal(store.fileStatMatches(next, 'A.md', { mtime: 1, size: 1 }), true);
  assert.equal(store.fileStatMatches(next, 'A.md', { mtime: 2, size: 1 }), false);
  assert.ok(next.fileHashes?.['A.md']?.hash);
  assert.ok(next.fileHashes?.['B.md']?.hash);
  assert.equal(state.fileHashes, undefined);
});

test('StateStore retains old fingerprints by current path instead of timestamp age', () => {
  const store = new StateStore({ loadData: async () => ({}), saveData: async () => undefined } as never);
  const oldTimestamp = Date.now() - 30 * 24 * 60 * 60 * 1000;
  const state: PersistedState = {
    version: 1,
    snapshot: [],
    completions: [],
    fileHashes: {
      'Keep.md': { path: 'Keep.md', hash: 'keep', timestamp: oldTimestamp, mtime: 1, size: 1 },
      'Remove.md': { path: 'Remove.md', hash: 'remove', timestamp: oldTimestamp, mtime: 1, size: 1 },
    },
  };
  assert.equal(store.fileStatMatches(state, 'Keep.md', { mtime: 1, size: 1 }), true, 'fingerprint age must not invalidate matching stats');
  const retained = store.retainFileHashesForPaths(state, new Set(['Keep.md']));
  assert.strictEqual(retained.fileHashes?.['Keep.md'], state.fileHashes?.['Keep.md']);
  assert.equal(retained.fileHashes?.['Remove.md'], undefined);
});

test('query, sidebar, and dashboard consumers use the shared indexed task source', async () => {
  const indexed = parsedTask();
  let indexedReads = 0;
  const getIndexedTasks = async (): Promise<ParsedTask[]> => { indexedReads += 1; return [indexed]; };
  const scanner = new TaskScanner({ vault: { read: async () => { throw new Error('unexpected vault scan'); } } } as never);
  const app = {
    vault: { getAbstractFileByPath: () => null, getMarkdownFiles: () => { throw new Error('unexpected vault enumeration'); } },
    metadataCache: { getFileCache: () => null },
  };

  const queryRenderer = new TaskQueryRenderer(
    app as never,
    scanner,
    () => DEFAULT_SETTINGS,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    getIndexedTasks,
  );
  const queryTasks = await (queryRenderer as unknown as { collectTasks(query: ReturnType<typeof parseTaskQuery>, sourcePath: string): Promise<ParsedTask[]> })
    .collectTasks(parseTaskQuery('not done'), '');
  assert.deepEqual(queryTasks.map((task) => task.key), [indexed.key]);

  const sidebar = new TaskPanelView({} as never, () => DEFAULT_SETTINGS, scanner, () => queryRenderer, undefined, getIndexedTasks);
  const sidebarTasks = await (sidebar as unknown as { loadAllTasks(): Promise<ParsedTask[]> }).loadAllTasks();
  assert.deepEqual(sidebarTasks.map((task) => task.key), [indexed.key]);

  const dashboard = new DashboardMarkdownRenderer({
    app: app as never,
    scanner,
    getSettings: () => DEFAULT_SETTINGS,
    getIndexedTasks,
  });
  const dashboardTasks = await (dashboard as unknown as { scanAllTasks(): Promise<ParsedTask[]> }).scanAllTasks();
  assert.deepEqual(dashboardTasks.map((task) => task.key), [indexed.key]);
  assert.equal(indexedReads, 3);
});

test('full scan hashes and parses changed Markdown and Canvas from one body read each', async () => {
  const markdown = file('Tasks.md', 1, 10);
  const canvas = file('Board.canvas', 2, 20);
  canvas.extension = 'canvas';
  const contents = new Map([
    [markdown.path, '- [ ] Markdown task'],
    [canvas.path, JSON.stringify({ nodes: [{ type: 'text', id: 'n1', text: '- [ ] Canvas task' }] })],
  ]);
  const reads = new Map<string, number>();
  const pluginData: { state?: Partial<PersistedState> } = { state: { version: 1, snapshot: [], completions: [] } };
  const store = new StateStore({
    loadData: async () => structuredClone(pluginData),
    saveData: async (data: typeof pluginData) => { pluginData.state = structuredClone(data.state); },
  } as never);
  // Focused harness intentionally exercises the private full-scan pipeline.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const plugin = Object.create(TaskManagerPlugin.prototype) as any;
  plugin.settings = { ...DEFAULT_SETTINGS };
  plugin.app = {
    vault: {
      getFiles: () => [markdown, canvas],
      read: async (target: TFile) => { reads.set(target.path, (reads.get(target.path) ?? 0) + 1); return contents.get(target.path) ?? ''; },
      getAbstractFileByPath: (path: string) => path === markdown.path ? markdown : path === canvas.path ? canvas : null,
    },
    metadataCache: { getFileCache: () => null },
    workspace: { getLeavesOfType: () => [] },
  };
  plugin.scanner = new TaskScanner(plugin.app);
  plugin.stateStore = store;
  plugin.taskIndex = new TaskIndex();
  plugin.queryRenderer = { invalidateCache: () => undefined, refreshAllVisible: () => undefined };
  plugin.snapshot = new Map();
  plugin.completions = [];
  plugin.recurrenceCounts = {};
  plugin.pendingCompletionKeyMigrations = new Map();
  plugin.pendingRecurrenceCountMigrations = new Map();
  plugin.pendingRemovedIndexPaths = new Set();
  plugin.firedReminders = new Set();
  plugin.cacheUpdateHandlers = [];
  plugin.migrateHydratedExplicitIdentityState = async () => undefined;
  plugin.applyScannedTasks = async () => undefined;
  plugin.persistSyncState = async () => undefined;
  plugin.persistState = async () => undefined;

  await plugin.scanVault(false, false);
  assert.deepEqual(Object.fromEntries(reads), { 'Tasks.md': 1, 'Board.canvas': 1 });
  assert.equal(plugin.taskIndex.getAllTasks().length, 2);
});

test('cold process hydrates unchanged files once, then stat-only reconcile reads no bodies', async () => {
  const source = file('Tasks.md', 10, 16);
  let reads = 0;
  let parses = 0;
  let saves = 0;
  let pluginData: { state?: Partial<PersistedState> } = {
    state: {
      version: 1,
      snapshot: [],
      completions: [],
      fileHashes: {
        'Tasks.md': { path: 'Tasks.md', hash: 'persisted-hash', timestamp: Date.now(), mtime: 10, size: 16 },
      },
    },
  };
  const store = new StateStore({
    loadData: async () => structuredClone(pluginData),
    saveData: async (data: typeof pluginData) => { saves += 1; pluginData = structuredClone(data); },
  } as never);
  // Private lifecycle methods are intentionally exercised through a focused harness.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const plugin = Object.create(TaskManagerPlugin.prototype) as any;
  plugin.settings = { ...DEFAULT_SETTINGS };
  plugin.app = {
    vault: {
      getFiles: () => [source],
      read: async () => { reads += 1; return '- [ ] Indexed task'; },
      getAbstractFileByPath: () => source,
    },
    workspace: { getLeavesOfType: () => [] },
  };
  plugin.stateStore = store;
  plugin.taskIndex = new TaskIndex();
  plugin.queryRenderer = { invalidateCache: () => undefined, refreshAllVisible: () => undefined };
  plugin.snapshot = new Map();
  plugin.completions = [];
  plugin.recurrenceCounts = {};
  plugin.pendingCompletionKeyMigrations = new Map();
  plugin.pendingRecurrenceCountMigrations = new Map();
  plugin.pendingRemovedIndexPaths = new Set();
  plugin.firedReminders = new Set();
  plugin.cacheUpdateHandlers = [];
  plugin.persistSyncState = async () => undefined;
  plugin.persistState = async () => undefined;
  plugin.parseTasksForFile = async () => { parses += 1; return [parsedTask()]; };
  plugin.applyScannedTasks = async () => undefined;

  await plugin.scanVault(false, false);
  assert.equal(reads, 1, 'cold in-memory index must hydrate even when persisted stat matches');
  assert.equal(parses, 1);
  assert.equal(plugin.apiV1, undefined);
  assert.equal(plugin.taskIndex.getAllTasks().length, 1);
  assert.equal(plugin.taskIndex.isReady(), true);

  const savesAfterHydration = saves;
  await plugin.scanVault(false, false);
  assert.equal(reads, 1, 'unchanged reconcile must use persisted stat without reading the body');
  assert.equal(parses, 1);
  assert.equal(saves, savesAfterHydration, 'unchanged reconcile must not write state');
});

async function identityHydrationHarness(
  entries: Array<{ path: string; line: string; previous: 'todo' | 'done' }>,
  persistedState?: Partial<PersistedState>,
): Promise<{
  // Focused harness intentionally exercises private lifecycle methods.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  plugin: any;
  completionLogs: string[];
  files: TFile[];
  contentByPath: Map<string, string>;
  data(): { state?: Partial<PersistedState> };
}> {
  const files = entries.map((entry, index) => file(entry.path, index + 1, entry.line.length));
  const contentByPath = new Map(entries.map((entry) => [entry.path, entry.line]));
  let pluginData: { state?: Partial<PersistedState> } = {
    state: persistedState ?? {
      version: 1,
      snapshot: entries.map((entry) => ({
        key: `${entry.path}:id:shared`,
        status: entry.previous,
        filePath: entry.path,
        lineNumber: 1,
      })),
      completions: [],
    },
  };
  const store = new StateStore({
    loadData: async () => structuredClone(pluginData),
    saveData: async (data: typeof pluginData) => { pluginData = structuredClone(data); },
  } as never);
  // Focused harness intentionally exercises private scan lifecycle methods.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const plugin = Object.create(TaskManagerPlugin.prototype) as any;
  plugin.settings = { ...DEFAULT_SETTINGS, completionLoggingEnabled: true };
  plugin.app = {
    vault: {
      getFiles: () => files,
      read: async (target: TFile) => contentByPath.get(target.path) ?? '',
      getAbstractFileByPath: (path: string) => files.find((target) => target.path === path) ?? null,
    },
    workspace: { getLeavesOfType: () => [] },
    metadataCache: { getFileCache: () => null },
  };
  plugin.stateStore = store;
  plugin.scanner = new TaskScanner(plugin.app, () => plugin.settings.supportedStates, () => '', () => plugin.settings, () => store);
  plugin.taskIndex = new TaskIndex();
  plugin.queryRenderer = { invalidateCache: () => undefined, refreshAllVisible: () => undefined };
  plugin.snapshot = new Map((pluginData.state?.snapshot ?? []).map((entry) => [entry.key, entry]));
  plugin.completions = [];
  plugin.recurrenceCounts = {};
  plugin.pendingCompletionKeyMigrations = new Map();
  plugin.pendingRecurrenceCountMigrations = new Map();
  plugin.pendingRemovedIndexPaths = new Set();
  plugin.firedReminders = new Set();
  plugin.cacheUpdateHandlers = [];
  plugin.statusChangeHandlers = [];
  plugin.inFlightCompletions = new Set();
  plugin.suppressedCompletionKeys = new Set();
  plugin.persistState = async () => undefined;
  plugin.notifyTaskIndexConsumers = () => undefined;
  plugin.dailyNoteResolver = {
    isTodayDailyNote: () => false,
    resolveToday: async () => ({ path: 'Daily.md', file: file('Daily.md') }),
  };
  const completionLogs: string[] = [];
  plugin.logWriter = {
    appendToDailyLog: async (_daily: TFile, completion: { text: string }) => {
      completionLogs.push(completion.text);
      return completion.text;
    },
  };
  return { plugin, completionLogs, files, contentByPath, data: () => structuredClone(pluginData) };
}

test('direct scan fingerprints make an A-to-B-to-A full scan restore the current vault body', async () => {
  const bodyA = '- [ ] Alpha 🆔 shared';
  const bodyB = '- [ ] Beta 🆔 shared';
  const { plugin, files, contentByPath } = await identityHydrationHarness([
    { path: 'Task.md', line: bodyA, previous: 'todo' },
  ]);
  const source = files[0];
  assert.ok(source);

  await plugin.scanVault(false, true);
  assert.equal(plugin.taskIndex.getAllTasks()[0]?.normalizedText, 'Alpha');

  contentByPath.set(source.path, bodyB);
  source.stat.mtime += 1;
  source.stat.size = bodyB.length;
  await plugin.scanFile(source, true, true);
  assert.equal(plugin.taskIndex.getAllTasks()[0]?.normalizedText, 'Beta');
  assert.equal(
    (await plugin.stateStore.loadState()).fileHashes?.[source.path]?.hash,
    plugin.stateStore.hash(bodyB),
    'the direct scan must replace A\'s hash with the exact parsed B body hash',
  );

  contentByPath.set(source.path, bodyA);
  source.stat.mtime += 1;
  source.stat.size = bodyA.length;
  await plugin.scanVault(false, false);
  assert.equal(
    plugin.taskIndex.getAllTasks()[0]?.normalizedText,
    'Alpha',
    'the ordinary full scan must not mistake reverted A for an unchanged body',
  );
});

test('direct and queued task-note scans publish metadata from the same body they fingerprint', async () => {
  for (const mode of ['direct', 'queued'] as const) {
    const description = mode === 'direct' ? 'Captured direct task' : 'Captured queued task';
    const body = [
      '---',
      'task: true',
      'status: todo',
      `description: "${description}"`,
      'id: shared',
      '---',
      '',
    ].join('\n');
    const { plugin, files, contentByPath } = await identityHydrationHarness([
      { path: 'Tasks/Task.md', line: body, previous: 'todo' },
    ]);
    const source = files[0];
    assert.ok(source);
    source.stat.size = body.length;
    plugin.settings.taskNoteFolders = 'Tasks';
    plugin.app.metadataCache.getFileCache = () => ({ frontmatter: {
      task: true,
      status: 'done',
      description: 'Stale metadata cache task',
      id: 'shared',
    } });
    contentByPath.set(source.path, body);

    if (mode === 'direct') {
      await plugin.scanFile(source, true, true);
    } else {
      plugin.pendingFileScans = new Set([source.path]);
      plugin.fileScanTimer = null;
      plugin.fileScanRunning = false;
      plugin.fileScanRunGeneration = null;
      plugin.scanErrors = [];
      await plugin.drainQueuedFileScans();
    }

    const indexed = plugin.taskIndex.getAllTasks()[0];
    assert.equal(indexed?.normalizedText, description);
    assert.equal(indexed?.status, 'todo');
    assert.equal(
      (await plugin.stateStore.loadState()).fileHashes?.[source.path]?.hash,
      plugin.stateStore.hash(body),
    );
  }
});

test('full hydration migrates a legacy explicit-ID baseline before detecting completion', async () => {
  const { plugin, completionLogs } = await identityHydrationHarness([
    { path: 'Task.md', line: '- [x] Finished 🆔 shared', previous: 'todo' },
  ]);
  await plugin.scanVault(false, false);
  assert.deepEqual(completionLogs, ['Finished']);
  assert.equal(plugin.snapshot.get('id:shared')?.status, 'done');
  assert.equal(plugin.snapshot.has('Task.md:id:shared'), false);
});

test('file-task persisted reload drives plugin completion, habit, and status effects exactly once', async () => {
  const { plugin, completionLogs, contentByPath } = await identityHydrationHarness([
    { path: 'Tasks/Habit.md', line: '', previous: 'todo' },
  ]);
  plugin.settings.taskNoteFolders = 'Tasks';
  contentByPath.set('Tasks/Habit.md', [
    '---',
    'task: true',
    'status: done',
    'description: "Meditate #habit"',
    'id: shared',
    'recurrence: every day',
    'tags: ["habit"]',
    '---',
    '',
  ].join('\n'));
  plugin.app.metadataCache.getFileCache = () => ({ frontmatter: {
    task: true, status: 'done', description: 'Meditate #habit', id: 'shared', recurrence: 'every day', tags: ['habit'],
  } });
  await plugin.stateStore.updateState((state: PersistedState) => ({ ...state, snapshot: [{
    key: 'id:shared', status: 'todo', filePath: 'Tasks/Habit.md', lineNumber: 0, sourceKind: 'file',
  }], identityMigration: { version: 2, completed: true, conflicts: [] } }));
  await plugin.loadPersistentState();
  const statuses: string[] = [];
  plugin.statusChangeHandlers = [(_task: ParsedTask, previous: string) => statuses.push(previous)];

  await plugin.scanVault(false, true);
  assert.deepEqual(completionLogs, ['Meditate #habit']);
  assert.deepEqual(statuses, ['todo']);
  assert.equal((await plugin.stateStore.loadState()).habitCompletions?.['id:shared']?.length, 1);
  assert.equal(plugin.snapshot.get('id:shared')?.sourceKind, 'file');

  await plugin.scanVault(false, true);
  assert.deepEqual(completionLogs, ['Meditate #habit']);
  assert.deepEqual(statuses, ['todo']);
});

test('actual plugin publication waves recover duplicate-to-unique destination exactly once', async () => {
  const { plugin, completionLogs, files, contentByPath } = await identityHydrationHarness([
    { path: 'Source.md', line: '- [ ] Move me 🆔 shared', previous: 'todo' },
  ]);
  await plugin.scanVault(false, true);
  const target = file('Target.md', 2, 30);
  files.push(target);
  contentByPath.set(target.path, '- [x] Move me 🆔 shared');
  await plugin.scanFile(target, true, true);
  assert.deepEqual(completionLogs, [], 'ambiguous destination wave must be effect-free');

  const source = files.find((candidate) => candidate.path === 'Source.md');
  assert.ok(source);
  contentByPath.set(source.path, '');
  source.stat.mtime += 1;
  source.stat.size = 0;
  await plugin.scanFile(source, true, true);
  assert.deepEqual(completionLogs, ['Move me']);
  assert.equal(plugin.snapshot.get('id:shared')?.filePath, 'Target.md');

  target.stat.mtime += 1;
  await plugin.scanFile(target, true, true);
  assert.deepEqual(completionLogs, ['Move me']);
});

test('restart between ambiguous destination and source-removal waves preserves exactly-once completion', async () => {
  const first = await identityHydrationHarness([
    { path: 'Source.md', line: '- [ ] Move me 🆔 shared', previous: 'todo' },
  ]);
  delete first.plugin.persistState;
  await first.plugin.scanVault(false, true);
  const target = file('Target.md', 2, 30);
  first.files.push(target);
  first.contentByPath.set(target.path, '- [x] Move me 🆔 shared');
  await first.plugin.scanFile(target, true, true);
  assert.deepEqual(first.completionLogs, []);

  const persisted = first.data().state;
  assert.ok(persisted);
  const second = await identityHydrationHarness([
    { path: 'Source.md', line: '', previous: 'todo' },
    { path: 'Target.md', line: '- [x] Move me 🆔 shared', previous: 'todo' },
  ], persisted);
  delete second.plugin.persistState;
  await second.plugin.scanVault(false, true);
  assert.deepEqual(second.completionLogs, ['Move me']);
  assert.equal(second.plugin.snapshot.get('id:shared')?.filePath, 'Target.md');
  await second.plugin.scanVault(false, true);
  assert.deepEqual(second.completionLogs, ['Move me']);
});

test('settings exclusion reconciliation removes extant derived index, snapshot, and fingerprint state', async () => {
  const { plugin, completionLogs } = await identityHydrationHarness([
    { path: 'Private/Task.md', line: '- [ ] Private 🆔 shared', previous: 'todo' },
  ]);
  delete plugin.persistState;
  await plugin.scanVault(false, true);
  assert.equal(plugin.taskIndex.hasFile('Private/Task.md'), true);
  assert.equal(plugin.snapshot.get('id:shared')?.filePath, 'Private/Task.md');
  assert.ok((await plugin.stateStore.loadState()).fileHashes?.['Private/Task.md']);

  plugin.appliedExcludedFoldersSignature = '';
  plugin.settings.excludedFolders = ['private'];
  plugin.reminderManager = { refreshCache: () => undefined };
  plugin.refreshAppearanceStyles = () => undefined;
  await plugin.saveSettings();

  assert.equal(plugin.taskIndex.hasFile('Private/Task.md'), false);
  assert.equal(plugin.snapshot.size, 0);
  const state = await plugin.stateStore.loadState();
  assert.equal(state.fileHashes?.['Private/Task.md'], undefined);
  assert.deepEqual(state.snapshot, []);
  assert.deepEqual(completionLogs, [], 'exclusion cleanup must not fire lifecycle effects');
});

test('full hydration performs no lifecycle side effects for duplicate explicit IDs regardless of file order', async () => {
  const source = [
    { path: 'A.md', line: '- [ ] First 🆔 shared', previous: 'todo' as const },
    { path: 'B.md', line: '- [x] Second 🆔 shared', previous: 'todo' as const },
  ];
  for (const entries of [source, [...source].reverse()]) {
    const { plugin, completionLogs } = await identityHydrationHarness(entries);
    await plugin.scanVault(false, false);
    assert.deepEqual(completionLogs, []);
    assert.equal(plugin.snapshot.has('id:shared'), false);
    assert.equal((await plugin.stateStore.loadState()).identityMigration?.completed, false);
  }
});
