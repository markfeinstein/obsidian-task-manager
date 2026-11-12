import test from 'node:test';
import assert from 'node:assert/strict';
import { TFile } from 'obsidian';
import TaskManagerPlugin from '../src/main';
import type { ParsedTask } from '../src/task-scanner';
import { TaskIndex } from '../src/task-index';

if (typeof globalThis.window === 'undefined') {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      clearTimeout,
      setTimeout,
      clearInterval,
      setInterval,
    },
  });
}

function file(path: string): TFile {
  return Object.assign(Object.create(TFile.prototype) as TFile, {
    path,
    name: path.split('/').pop() ?? path,
    extension: 'md',
    basename: path.replace(/\.md$/u, ''),
    stat: { mtime: 1, ctime: 1, size: 10 },
  });
}

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

interface ScanHarness {
  settings: { enableFileEvents: boolean; completionLoggingEnabled: boolean; excludedFolders?: string[] };
  app: { vault: { read(target: TFile): Promise<string>; getAbstractFileByPath(path: string): TFile | null } };
  scanner: { scanFile(target: TFile): Promise<unknown[]> };
  queryRenderer: { invalidateCache(path?: string): void; stopAllFocusTimers(): void };
  stateStore: {
    loadState(): Promise<Record<string, never>>;
    fileStatMatches(): boolean;
    hasFileChanged(): boolean;
    hash(content: string): string;
    updateState(
      transform: (state: Record<string, never>) => unknown,
      options?: { shouldCommit?: () => boolean },
    ): Promise<void>;
    setFileHashes(
      state: Record<string, never>,
      updates: ReadonlyArray<{ path: string; hash?: string; stat?: { mtime?: number; size?: number } }>,
    ): Record<string, never>;
  };
  taskIndex: Record<string, unknown>;
  pendingFileScans: Set<string>;
  fileScanTimer: number | null;
  fileScanRunning: boolean;
  startupScanTimer: number | null;
  lifecycleGeneration: number;
  lifecycleActive: boolean;
  scanAbortController: AbortController | null;
  persistState(): Promise<void>;
  notifyTaskIndexConsumers(): void;
  getIndexableFiles(): TFile[];
  parseTasksForFile(target: TFile, content?: string): Promise<unknown[]>;
  applyScannedTaskWave(replacements: ReadonlyMap<string, unknown[]>, generation?: number): Promise<boolean>;
  scanVault(showNotice?: boolean, force?: boolean): Promise<void>;
  scanFile(target: TFile, persist?: boolean, publish?: boolean): Promise<unknown[]>;
  drainQueuedFileScans(): Promise<void>;
  dailyNoteResolver: { isTodayDailyNote(path: string): boolean; resolveToday(active?: () => boolean): Promise<{ path: string; file: TFile }> };
  logWriter: { appendToDailyLog(): Promise<string> };
  suppressedCompletionKeys: Set<string>;
  inFlightCompletions: Set<string>;
  snapshot: Map<string, { key: string; filePath: string; lineNumber: number; status: string; sourceKind: 'line' | 'file' }>;
  handleCompletion(task: ParsedTask, generation?: number, isCurrent?: () => boolean): Promise<void>;
  onunload(): void;
}

function harness(target: TFile, read: Promise<string>) {
  const counts = { read: 0, commit: 0, markReady: 0, stateWrite: 0, persist: 0, notify: 0, dispose: 0 };
  const fingerprintUpdates: Array<{ path: string; hash?: string; stat?: { mtime?: number; size?: number } }> = [];
  const filesByPath = new Map<string, TFile>([[target.path, target]]);
  const plugin = Object.create(TaskManagerPlugin.prototype) as ScanHarness;
  plugin.settings = { enableFileEvents: true, completionLoggingEnabled: true };
  plugin.app = { vault: { read: async () => { counts.read += 1; return read; }, getAbstractFileByPath: (path) => filesByPath.get(path) ?? null } };
  plugin.scanner = { scanFile: async () => [] };
  plugin.queryRenderer = { invalidateCache: () => undefined, stopAllFocusTimers: () => undefined };
  plugin.stateStore = {
    loadState: async () => ({}),
    fileStatMatches: () => false,
    hasFileChanged: () => true,
    hash: (content) => `hash:${content}`,
    updateState: async (transform) => { counts.stateWrite += 1; transform({}); },
    setFileHashes: (state, updates) => { fingerprintUpdates.push(...updates); return state; },
  };
  plugin.taskIndex = {
    isReady: () => false,
    beginHydration: () => undefined,
    getPaths: () => [],
    hasFile: () => false,
    getAllTasks: () => [],
    getTasksForFile: () => [],
    commit: () => { counts.commit += 1; return true; },
    removePath: () => null,
    getSnapshot: () => ({ explicitIds: { resolve: () => ({ kind: 'missing', matches: [] }) } }),
    getExplicitIds: () => ({ resolve: () => ({ kind: 'missing', matches: [] }), conflicts: () => new Map() }),
    markReady: () => { counts.markReady += 1; },
    dispose: () => { counts.dispose += 1; },
  };
  plugin.pendingFileScans = new Set();
  plugin.fileScanTimer = null;
  plugin.fileScanRunning = false;
  plugin.startupScanTimer = null;
  plugin.persistState = async () => { counts.persist += 1; };
  plugin.notifyTaskIndexConsumers = () => { counts.notify += 1; };
  plugin.getIndexableFiles = () => [target];
  plugin.applyScannedTaskWave = async () => true;
  return { plugin, counts, filesByPath, fingerprintUpdates };
}

function parsedTask(marker: string, target: TFile): ParsedTask {
  return {
    key: `${target.path}:${marker}`,
    filePath: target.path,
    lineNumber: 1,
    rawLine: `- [ ] ${marker}`,
    linePrefix: '',
    indentation: '',
    listMarker: '-',
    checkbox: ' ',
    body: marker,
    normalizedText: marker,
    status: 'todo',
    tags: [],
    contexts: [],
    metadata: { dates: {}, invalidDates: {}, priority: 'normal', dependsOn: [] },
  };
}

test('excluded paths are rejected by event and direct scan entry points', async () => {
  const target = file('Private/Task.md');
  const { plugin, counts } = harness(target, Promise.resolve('- [ ] Private'));
  plugin.settings.excludedFolders = ['private'];
  let parses = 0;
  plugin.parseTasksForFile = async () => { parses += 1; return []; };

  (plugin as unknown as { queueRescan(file: TFile): void }).queueRescan(target);
  assert.equal(plugin.pendingFileScans.size, 0);
  assert.deepEqual(await plugin.scanFile(target), []);
  assert.equal(parses, 0);
  assert.equal(counts.commit, 0);
});

test('direct and queued scans parse and fingerprint the same captured body', async (context) => {
  const body = '- [ ] Current body';

  await context.test('direct scan', async () => {
    const target = file('Direct.md');
    const { plugin, counts, fingerprintUpdates } = harness(target, Promise.resolve(body));
    let parsedContent: string | undefined;
    plugin.parseTasksForFile = async (_file, content) => { parsedContent = content; return []; };

    await plugin.scanFile(target, true, true);

    assert.equal(counts.read, 1);
    assert.equal(parsedContent, body);
    assert.deepEqual(fingerprintUpdates, [{
      path: target.path,
      hash: `hash:${body}`,
      stat: { mtime: target.stat.mtime, size: target.stat.size },
    }]);
    plugin.onunload();
  });

  await context.test('queued scan', async () => {
    const target = file('Queued.md');
    const { plugin, counts, fingerprintUpdates } = harness(target, Promise.resolve(body));
    let parsedContent: string | undefined;
    plugin.parseTasksForFile = async (_file, content) => { parsedContent = content; return []; };
    plugin.pendingFileScans.add(target.path);

    await plugin.drainQueuedFileScans();

    assert.equal(counts.read, 1);
    assert.equal(parsedContent, body);
    assert.deepEqual(fingerprintUpdates, [{
      path: target.path,
      hash: `hash:${body}`,
      stat: { mtime: target.stat.mtime, size: target.stat.size },
    }]);
    plugin.onunload();
  });
});

test('queued and full scans reject fingerprints when path evidence expires during state loading', async (context) => {
  const invalidateBeforeCommit = (plugin: ScanHarness, target: TFile): void => {
    target.stat.mtime += 1;
    (plugin as unknown as { bumpPathScanEpoch(path: string): number }).bumpPathScanEpoch(target.path);
  };

  await context.test('queued scan', async () => {
    const target = file('Queued-race.md');
    const { plugin, counts, fingerprintUpdates } = harness(target, Promise.resolve('- [ ] Queued race'));
    plugin.pendingFileScans.add(target.path);
    plugin.parseTasksForFile = async () => [];
    let invalidated = false;
    plugin.stateStore.updateState = async (transform, options) => {
      if (!invalidated) {
        invalidated = true;
        invalidateBeforeCommit(plugin, target);
      }
      if (!options?.shouldCommit || options.shouldCommit()) transform({});
      counts.stateWrite += 1;
    };

    await plugin.drainQueuedFileScans();

    assert.deepEqual(fingerprintUpdates, [{
      path: target.path,
      hash: 'hash:- [ ] Queued race',
      stat: { mtime: target.stat.mtime, size: target.stat.size },
    }], 'only the retry with current path evidence may publish a fingerprint');
    assert.equal(plugin.pendingFileScans.has(target.path), false);
    assert.equal(counts.persist, 1);
    assert.equal(counts.notify, 1);
    plugin.onunload();
  });

  await context.test('full scan', async () => {
    const target = file('Full-race.md');
    const { plugin, counts, fingerprintUpdates } = harness(target, Promise.resolve('- [ ] Full race'));
    plugin.parseTasksForFile = async () => [];
    plugin.fileScanRunning = true;
    (plugin as unknown as { ensureReminderIndexReady(): Promise<void> }).ensureReminderIndexReady = async () => undefined;
    (plugin as unknown as { checkDueReminders(): Promise<void> }).checkDueReminders = async () => undefined;
    plugin.stateStore.updateState = async (transform, options) => {
      invalidateBeforeCommit(plugin, target);
      if (!options?.shouldCommit || options.shouldCommit()) transform({});
      counts.stateWrite += 1;
    };

    await plugin.scanVault(false, true);

    assert.deepEqual(fingerprintUpdates, []);
    assert.equal(plugin.pendingFileScans.has(target.path), true);
    assert.equal(counts.persist, 0);
    assert.equal(counts.notify, 0);
    plugin.onunload();
  });
});

test('multi-path fingerprint transactions reject when one included path expires after transform', async (context) => {
  const run = async (mode: 'queued' | 'full'): Promise<void> => {
    const first = file(`${mode}-A.md`);
    const second = file(`${mode}-B.md`);
    const { plugin, filesByPath } = harness(first, Promise.resolve('- [ ] Multi-path race'));
    filesByPath.set(second.path, second);
    plugin.parseTasksForFile = async () => [];
    plugin.getIndexableFiles = () => [first, second];
    if (mode === 'queued') plugin.pendingFileScans = new Set([first.path, second.path]);
    plugin.stateStore.updateState = async (transform, options) => {
      assert.equal(options?.shouldCommit?.(), true, 'at least one current candidate starts the transaction');
      transform({});
      first.stat.mtime += 1;
      (plugin as unknown as { bumpPathScanEpoch(path: string): number }).bumpPathScanEpoch(first.path);
      assert.equal(options?.shouldCommit?.(), false, 'every path included by the transform must remain current');
      throw new Error('stop after multi-path fence assertion');
    };
    if (mode === 'full') {
      (plugin as unknown as { migrateHydratedExplicitIdentityState(): Promise<void> }).migrateHydratedExplicitIdentityState = async () => undefined;
      (plugin as unknown as { ensureReminderIndexReady(): Promise<void> }).ensureReminderIndexReady = async () => undefined;
      (plugin as unknown as { checkDueReminders(): Promise<void> }).checkDueReminders = async () => undefined;
    }

    await assert.rejects(
      mode === 'queued' ? plugin.drainQueuedFileScans() : plugin.scanVault(false, true),
      /stop after multi-path fence assertion/u,
    );
    plugin.onunload();
  };

  await context.test('queued scan', () => run('queued'));
  await context.test('full scan', () => run('full'));
});

test('rename into an excluded folder removes derived snapshot ownership without rescanning', () => {
  const target = file('Private/Task.md');
  const { plugin } = harness(target, Promise.resolve(''));
  plugin.settings.excludedFolders = ['private'];
  plugin.snapshot = new Map([['id:task', { key: 'id:task', filePath: 'Public/Task.md', lineNumber: 1, status: 'todo', sourceKind: 'line' }]]);
  (plugin as unknown as { rebuildSnapshotFileIndex(): void }).rebuildSnapshotFileIndex();

  (plugin as unknown as { handleRename(file: TFile, oldPath: string): void }).handleRename(target, 'Public/Task.md');

  assert.equal(plugin.snapshot.size, 0);
  assert.equal(plugin.pendingFileScans.size, 0);
  assert.equal((plugin as unknown as { pendingRemovedIndexPaths: Set<string> }).pendingRemovedIndexPaths.has('Public/Task.md'), true);
});

test('saving a changed exclusion policy schedules a forced reconciliation scan', async () => {
  const target = file('Tasks.md');
  const { plugin } = harness(target, Promise.resolve(''));
  plugin.settings.excludedFolders = ['private'];
  (plugin as unknown as { appliedExcludedFoldersSignature: string }).appliedExcludedFoldersSignature = '';
  (plugin.stateStore as unknown as { saveSettings(settings: unknown): Promise<void> }).saveSettings = async () => undefined;
  (plugin as unknown as { refreshAppearanceStyles(): void }).refreshAppearanceStyles = () => undefined;
  (plugin as unknown as { reminderManager: { refreshCache(): void } }).reminderManager = { refreshCache: () => undefined };
  let scans = 0;
  plugin.scanVault = async (_notice?: boolean, force?: boolean) => { assert.equal(force, true); scans += 1; };

  await (plugin as unknown as { saveSettings(): Promise<void> }).saveSettings();
  assert.equal(scans, 1);
});

test('queued scan rolls back a transient commit when exclusion changes across migration await', async () => {
  const target = file('Private/Task.md');
  const { plugin } = harness(target, Promise.resolve(''));
  plugin.settings.excludedFolders = [];
  const index = new TaskIndex();
  index.beginHydration();
  index.markReady(false);
  plugin.taskIndex = index as unknown as Record<string, unknown>;
  plugin.pendingFileScans.add(target.path);
  plugin.parseTasksForFile = async () => [parsedTask('private', target)];
  (plugin as unknown as { migrateHydratedExplicitIdentityState(): Promise<void> }).migrateHydratedExplicitIdentityState = async () => {
    plugin.settings.excludedFolders = ['private'];
  };

  await plugin.drainQueuedFileScans();
  assert.equal(index.hasFile(target.path), false);
  assert.deepEqual(index.getAllTasks(), []);
});

test('full scan performs no commit or side effect after plugin unload', async () => {
  const gate = deferred<string>();
  const target = file('Deferred.md');
  const { plugin, counts } = harness(target, gate.promise);

  const scan = plugin.scanVault(false, false);
  await Promise.resolve();
  plugin.onunload();
  gate.resolve('- [ ] Deferred');
  await scan;

  assert.equal(counts.commit, 0);
  assert.equal(counts.markReady, 0);
  assert.equal(counts.stateWrite, 0);
  assert.equal(counts.persist, 0);
  assert.equal(counts.notify, 0);
  assert.equal(counts.dispose, 1);
});

test('completion logging stops after unload while daily-note resolution is pending', async () => {
  const target = file('Task.md');
  const daily = file('2026-07-11.md');
  const gate = deferred<{ path: string; file: TFile }>();
  const resolverStarted = deferred<void>();
  const { plugin, counts } = harness(target, Promise.resolve(''));
  let logWrites = 0;
  plugin.lifecycleGeneration = 1;
  plugin.lifecycleActive = true;
  plugin.scanAbortController = new AbortController();
  plugin.suppressedCompletionKeys = new Set();
  plugin.inFlightCompletions = new Set();
  plugin.dailyNoteResolver = {
    isTodayDailyNote: () => false,
    resolveToday: async (active = () => true) => {
      resolverStarted.resolve();
      const resolved = await gate.promise;
      if (!active()) throw new Error('Daily-note resolution cancelled because the owning lifecycle ended');
      return resolved;
    },
  };
  plugin.logWriter = { appendToDailyLog: async () => { logWrites += 1; return 'log'; } };
  const task: ParsedTask = {
    key: 'id:done',
    filePath: target.path,
    lineNumber: 1,
    rawLine: '- [x] Done',
    linePrefix: '',
    indentation: '',
    listMarker: '-',
    checkbox: 'x',
    body: 'Done',
    normalizedText: 'Done',
    status: 'done',
    tags: [],
    contexts: [],
    metadata: { dates: {}, invalidDates: {}, priority: 'normal', dependsOn: [] },
  };

  plugin.snapshot = new Map([[task.key, { key: task.key, filePath: task.filePath, lineNumber: task.lineNumber, status: 'todo', sourceKind: 'line' }]]);
  const completion = plugin.handleCompletion(task, plugin.lifecycleGeneration);
  await resolverStarted.promise;
  plugin.onunload();
  gate.resolve({ path: daily.path, file: daily });
  await completion;

  assert.equal(logWrites, 0);
  assert.equal(counts.persist, 0);
});

test('path invalidation cancels an in-flight completion effect in the same lifecycle generation', async () => {
  const target = file('Task.md');
  const daily = file('2026-07-11.md');
  const gate = deferred<{ path: string; file: TFile }>();
  const resolverStarted = deferred<void>();
  const { plugin, counts } = harness(target, Promise.resolve(''));
  let current = true;
  let logWrites = 0;
  plugin.lifecycleGeneration = 1;
  plugin.lifecycleActive = true;
  plugin.scanAbortController = new AbortController();
  plugin.suppressedCompletionKeys = new Set();
  plugin.inFlightCompletions = new Set();
  plugin.dailyNoteResolver = {
    isTodayDailyNote: () => false,
    resolveToday: async (active = () => true) => {
      resolverStarted.resolve();
      const resolved = await gate.promise;
      if (!active()) throw new Error('cancelled because the path scan epoch changed');
      return resolved;
    },
  };
  plugin.logWriter = { appendToDailyLog: async () => { logWrites += 1; return 'log'; } };
  const task = { ...parsedTask('Done', target), status: 'done', checkbox: 'x' } as ParsedTask;

  const completion = plugin.handleCompletion(task, plugin.lifecycleGeneration, () => current);
  await resolverStarted.promise;
  current = false;
  gate.resolve({ path: daily.path, file: daily });
  await completion;

  assert.equal(logWrites, 0);
  assert.equal(counts.persist, 0);
  plugin.onunload();
});

test('a stale scan cannot overwrite a later lifecycle generation', async () => {
  const gate = deferred<unknown[]>();
  const oldFile = file('Old.md');
  const newFile = file('New.md');
  const { plugin, counts, filesByPath } = harness(oldFile, Promise.resolve(''));
  filesByPath.set(newFile.path, newFile);
  plugin.parseTasksForFile = async (target) => target.path === oldFile.path ? gate.promise : [];

  const staleScan = plugin.scanFile(oldFile, false, true);
  await Promise.resolve();
  plugin.onunload();
  plugin.lifecycleActive = true;
  plugin.lifecycleGeneration += 1;
  plugin.scanAbortController = new AbortController();
  const currentScan = plugin.scanFile(newFile, false, true);
  await currentScan;
  assert.equal(counts.commit, 1);

  gate.resolve([]);
  assert.deepEqual(await staleScan, []);
  assert.equal(counts.commit, 1, 'the stale generation must not commit over the newer scan');
});

test('newer same-lifecycle direct scan publishes before older work and cannot be overwritten', async () => {
  const gate = deferred<unknown[]>();
  const target = file('Race.md');
  const { plugin, counts } = harness(target, Promise.resolve(''));
  const oldTasks = [parsedTask('old', target)];
  const newTasks = [parsedTask('new', target)];
  let parseCalls = 0;
  plugin.parseTasksForFile = async () => {
    parseCalls += 1;
    return parseCalls === 1 ? gate.promise : newTasks;
  };
  const committed: unknown[][] = [];
  (plugin.taskIndex as { commit: (replacements: ReadonlyMap<string, unknown[]>) => unknown }).commit = (replacements) => {
    counts.commit += 1;
    committed.push([...(replacements.get(target.path) ?? [])]);
    return true;
  };
  const effects: unknown[][] = [];
  plugin.applyScannedTaskWave = async (replacements) => {
    effects.push([...(replacements.get(target.path) ?? [])]);
    return true;
  };

  const oldScan = plugin.scanFile(target, true, true);
  await Promise.resolve();
  target.stat.mtime = 2;
  target.stat.size = 20;
  const newScan = plugin.scanFile(target, true, true);
  assert.deepEqual(await newScan, newTasks);

  plugin.fileScanRunning = true; // keep the expected stale retry from launching during this assertion
  gate.resolve(oldTasks);
  assert.deepEqual(await oldScan, []);
  plugin.fileScanRunning = false;

  assert.deepEqual(committed, [newTasks]);
  assert.deepEqual(effects, [newTasks]);
  assert.equal(counts.stateWrite, 1);
  assert.equal(counts.persist, 1);
  assert.equal(counts.notify, 1);
  plugin.onunload();
});

test('aborted lifecycle reconciliation publishes no fingerprint or notification and remains retryable', async () => {
  const target = file('Retry.md');
  const { plugin, counts } = harness(target, Promise.resolve(''));
  plugin.parseTasksForFile = async () => [parsedTask('retry', target)];
  plugin.applyScannedTaskWave = async () => false;

  assert.deepEqual(await plugin.scanFile(target, true, true), []);
  assert.equal(counts.commit, 1, 'the accepted parse may update the transient index before reconciliation');
  assert.equal(counts.stateWrite, 0);
  assert.equal(counts.persist, 0);
  assert.equal(counts.notify, 0);
  assert.equal(plugin.pendingFileScans.has(target.path), true);
  plugin.onunload();
});

test('direct and queued file scans are generation-fenced after unload', async (t) => {
  await t.test('direct', async () => {
    const gate = deferred<unknown[]>();
    const target = file('Direct.md');
    const { plugin, counts } = harness(target, Promise.resolve(''));
    plugin.parseTasksForFile = async () => gate.promise;

    const scan = plugin.scanFile(target);
    await Promise.resolve();
    plugin.onunload();
    gate.resolve([]);
    assert.deepEqual(await scan, []);
    assert.equal(counts.commit, 0);
    assert.equal(counts.stateWrite, 0);
    assert.equal(counts.persist, 0);
    assert.equal(counts.notify, 0);
  });

  await t.test('queued', async () => {
    const gate = deferred<unknown[]>();
    const target = file('Queued.md');
    const { plugin, counts } = harness(target, Promise.resolve(''));
    plugin.pendingFileScans.add(target.path);
    plugin.parseTasksForFile = async () => gate.promise;

    const scan = plugin.drainQueuedFileScans();
    await Promise.resolve();
    plugin.onunload();
    gate.resolve([]);
    await scan;
    assert.equal(counts.commit, 0);
    assert.equal(counts.stateWrite, 0);
    assert.equal(counts.persist, 0);
    assert.equal(counts.notify, 0);
  });
});
