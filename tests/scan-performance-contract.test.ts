import test from 'node:test';
import assert from 'node:assert/strict';
import { TFile } from 'obsidian';
import TaskManagerPlugin from '../src/main';
import { StateStore, type PersistedState } from '../src/state-store';
import { TaskIndex } from '../src/task-index';
import { TaskScanner, type ParsedTask } from '../src/task-scanner';
import { legacyTaskKeyForBody } from '../src/task-model';
import { DEFAULT_SETTINGS, type TaskManagerSettings } from '../src/types';

interface SnapshotEntry {
  key: string;
  status: string;
  filePath: string;
  lineNumber: number;
}

class CountingSnapshotMap extends Map<string, SnapshotEntry> {
  iterations = 0;
  gets = 0;
  valueIterations = 0;

  override *[Symbol.iterator](): MapIterator<[string, SnapshotEntry]> {
    for (const entry of super[Symbol.iterator]()) {
      this.iterations += 1;
      yield entry;
    }
  }

  override *values(): MapIterator<SnapshotEntry> {
    for (const value of super.values()) {
      this.valueIterations += 1;
      yield value;
    }
  }

  override get(key: string): SnapshotEntry | undefined {
    this.gets += 1;
    return super.get(key);
  }
}

interface SnapshotHarness {
  snapshot: CountingSnapshotMap;
  snapshotKeysByFile?: Map<string, Set<string>>;
  completions: Array<{ taskKey: string; sourcePath: string; dailyNotePath: string; completedAtIso: string; logLineHash: string }>;
  recurrenceCounts: Record<string, number>;
  pendingCompletionKeyMigrations: Map<string, string>;
  pendingRecurrenceCountMigrations: Map<string, string>;
  snapshotForFile(path: string): Map<string, SnapshotEntry>;
  migrateDurableIdentityKeys(tasks: ParsedTask[], snapshot?: ReadonlyMap<string, SnapshotEntry>, completions?: readonly SnapshotHarness['completions'][number][]): void;
}

function vaultFile(path: string, mtime = 1, size = 10): TFile {
  return Object.assign(Object.create(TFile.prototype) as TFile, {
    path,
    name: path.split('/').pop() ?? path,
    basename: path.split('/').pop()?.replace(/\.md$/u, '') ?? path,
    extension: 'md',
    stat: { mtime, ctime: 1, size },
  });
}

interface PerformanceScanHarness {
  settings: TaskManagerSettings;
  app: unknown;
  scanner: TaskScanner;
  stateStore: StateStore;
  taskIndex: TaskIndex;
  queryRenderer: { invalidateCache(): void; refreshAllVisible(): void };
  snapshot: Map<string, SnapshotEntry>;
  completions: [];
  recurrenceCounts: Record<string, number>;
  pendingCompletionKeyMigrations: Map<string, string>;
  pendingRecurrenceCountMigrations: Map<string, string>;
  pendingRemovedIndexPaths: Set<string>;
  firedReminders: Set<string>;
  cacheUpdateHandlers: [];
  migrateHydratedExplicitIdentityState(): Promise<void>;
  applyScannedTasks(): Promise<void>;
  persistSyncState(): Promise<void>;
  persistState(): Promise<void>;
  scanVault(showNotice?: boolean, force?: boolean): Promise<void>;
}

test('snapshot file index partitions once and performs file-local baseline reads', () => {
  const snapshot = new CountingSnapshotMap();
  const fileCount = 100;
  const tasksPerFile = 10;
  for (let fileIndex = 0; fileIndex < fileCount; fileIndex += 1) {
    const filePath = `Folder/${fileIndex}.md`;
    for (let taskIndex = 0; taskIndex < tasksPerFile; taskIndex += 1) {
      const key = `${filePath}:${taskIndex}`;
      snapshot.set(key, { key, status: 'todo', filePath, lineNumber: taskIndex + 1 });
    }
  }
  const plugin = Object.create(TaskManagerPlugin.prototype) as SnapshotHarness;
  plugin.snapshot = snapshot;

  for (let fileIndex = 0; fileIndex < fileCount; fileIndex += 1) {
    const baseline = plugin.snapshotForFile(`Folder/${fileIndex}.md`);
    assert.equal(baseline.size, tasksPerFile);
  }

  assert.equal(snapshot.iterations, fileCount * tasksPerFile, 'the global snapshot is partitioned exactly once');
  assert.equal(snapshot.gets, fileCount * tasksPerFile, 'subsequent baselines visit only keys owned by their file');
});

test('explicit-ID legacy migration indexes file snapshots and completions once per batch', () => {
  const path = 'Explicit.md';
  const scanner = new TaskScanner({} as never);
  const snapshot = new CountingSnapshotMap();
  const tasks: ParsedTask[] = [];
  const completions: SnapshotHarness['completions'] = [];
  for (let index = 0; index < 500; index += 1) {
    const task = scanner.parseTaskLine(`- [ ] Task ${index} [id:: explicit-${index}]`, path, index + 1);
    assert.ok(task);
    tasks.push(task);
    const legacyKey = legacyTaskKeyForBody(path, task.body);
    snapshot.set(legacyKey, { key: legacyKey, status: 'todo', filePath: path, lineNumber: index + 1 });
    completions.push({ taskKey: legacyKey, sourcePath: path, dailyNotePath: 'Daily.md', completedAtIso: '2026-01-01T00:00:00.000Z', logLineHash: 'hash' });
  }
  const plugin = Object.create(TaskManagerPlugin.prototype) as SnapshotHarness;
  plugin.snapshot = snapshot;
  plugin.completions = completions;
  plugin.recurrenceCounts = {};
  plugin.pendingCompletionKeyMigrations = new Map();
  plugin.pendingRecurrenceCountMigrations = new Map();

  plugin.migrateDurableIdentityKeys(tasks, snapshot, completions);

  assert.equal(snapshot.valueIterations, 500, 'snapshot candidates are indexed once, not walked once per explicit task');
  assert.ok(completions.every((completion, index) => completion.taskKey === `id:explicit-${index}`));
});

test('eight-day quiet multi-file vault reads and parses only the dirty body', async () => {
  const fileCount = 100;
  const files = Array.from({ length: fileCount }, (_value, index) => vaultFile(`Vault/${index}.md`, index === 42 ? 2 : 1));
  const oldContents = new Map(files.map((file, index) => [file.path, `- [ ] Task ${index}`]));
  const contents = new Map(oldContents);
  contents.set(files[42].path, '- [x] Task 42');
  let pluginData: { state?: Partial<PersistedState> } = { state: { version: 1, snapshot: [], completions: [] } };
  const store = new StateStore({
    loadData: async () => structuredClone(pluginData),
    saveData: async (data: typeof pluginData) => { pluginData = structuredClone(data); },
  } as never);
  const oldTimestamp = Date.now() - 8 * 24 * 60 * 60 * 1000;
  pluginData = { state: {
    version: 1,
    snapshot: [],
    completions: [],
    fileHashes: Object.fromEntries(files.map((file) => [file.path, {
      path: file.path,
      hash: store.hash(oldContents.get(file.path) ?? ''),
      timestamp: oldTimestamp,
      mtime: 1,
      size: file.stat.size,
    }])),
  } };
  let reads = 0;
  let parses = 0;
  const app = {
    vault: {
      getFiles: () => files,
      getAbstractFileByPath: (path: string) => files.find((file) => file.path === path) ?? null,
      read: async (file: TFile) => { reads += 1; return contents.get(file.path) ?? ''; },
    },
    metadataCache: { getFileCache: () => null },
    workspace: { getLeavesOfType: () => [] },
  };
  const scanner = new TaskScanner(app as never);
  const scanContent = scanner.scanFileContent.bind(scanner);
  scanner.scanFileContent = (file, content) => { parses += 1; return scanContent(file, content); };
  const index = new TaskIndex();
  index.beginHydration();
  index.commit(new Map(files.map((file) => {
    const parsed = scanner.parseTaskLine(oldContents.get(file.path) ?? '', file.path, 1);
    assert.ok(parsed);
    return [file.path, [parsed]];
  })));
  index.markReady(false);
  const plugin = Object.create(TaskManagerPlugin.prototype) as PerformanceScanHarness;
  plugin.settings = { ...DEFAULT_SETTINGS };
  plugin.app = app;
  plugin.scanner = scanner;
  plugin.stateStore = store;
  plugin.taskIndex = index;
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

  assert.equal(reads, 1);
  assert.equal(parses, 1);
  const persisted = await store.loadState();
  assert.equal(Object.keys(persisted.fileHashes ?? {}).length, fileCount);
  assert.equal(persisted.fileHashes?.[files[0].path]?.timestamp, oldTimestamp, 'quiet fingerprints are retained without write amplification');
  assert.notEqual(persisted.fileHashes?.[files[42].path]?.hash, store.hash(oldContents.get(files[42].path) ?? ''));
});
