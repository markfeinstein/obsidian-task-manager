import { TFile } from 'obsidian';
import TaskManagerPlugin from '../../../src/main';
import { TaskIndex } from '../../../src/task-index';
import { TaskScanner, type ParsedTask } from '../../../src/task-scanner';
import { StateStore, type PersistedState } from '../../../src/state-store';
import { DEFAULT_SETTINGS, type TaskManagerSettings } from '../../../src/types';

export type ScanScenarioMode = 'cold' | 'all-changed' | 'one-percent-dirty' | 'eight-day-one-dirty' | 'all-stat-matched' | 'dirty-burst';

export interface ScanScenarioOptions {
  fileCount: number;
  taskCount: number;
  mode: ScanScenarioMode;
}

export interface ScanScenarioCounters {
  bodyReads: number;
  bytesRead: number;
  parseCalls: number;
  hashCalls: number;
  stateWrites: number;
  indexCommits: number;
  snapshotEntriesVisited: number;
  parsedTasks: number;
}

interface FixtureFile {
  file: TFile;
  oldContent: string;
  currentContent: string;
  oldTasks: ParsedTask[];
}

class CountingSnapshotMap extends Map<string, { key: string; status: string; filePath: string; lineNumber: number }> {
  visits = 0;
  override *[Symbol.iterator](): MapIterator<[string, { key: string; status: string; filePath: string; lineNumber: number }]> {
    for (const entry of super[Symbol.iterator]()) { this.visits += 1; yield entry; }
  }
  override *values(): MapIterator<{ key: string; status: string; filePath: string; lineNumber: number }> {
    for (const value of super.values()) { this.visits += 1; yield value; }
  }
  override get(key: string) {
    this.visits += 1;
    return super.get(key);
  }
}

interface BenchmarkPluginHarness {
  settings: TaskManagerSettings;
  app: unknown;
  scanner: TaskScanner;
  stateStore: StateStore;
  taskIndex: TaskIndex;
  queryRenderer: { invalidateCache(): void; refreshAllVisible(): void };
  dailyNoteResolver: { isTodayDailyNote(): boolean };
  snapshot: CountingSnapshotMap;
  snapshotKeysByFile?: Map<string, Set<string>>;
  completions: PersistedState['completions'];
  recurrenceCounts: Record<string, number>;
  pendingCompletionKeyMigrations: Map<string, string>;
  pendingRecurrenceCountMigrations: Map<string, string>;
  pendingRemovedIndexPaths: Set<string>;
  firedReminders: Set<string>;
  cacheUpdateHandlers: [];
  statusChangeHandlers: [];
  identityStateRevision: number;
  persistedIdentityStateRevision: number;
  syncQueueRevision: number;
  persistedSyncQueueRevision: number;
  syncStatePersistenceQueue: Promise<void>;
  scanVault(showNotice?: boolean, force?: boolean): Promise<void>;
}

function fixture(options: ScanScenarioOptions, scanner: TaskScanner): FixtureFile[] {
  const base = Math.floor(options.taskCount / options.fileCount);
  let remainder = options.taskCount % options.fileCount;
  const dirtyCount = options.mode === 'cold' || options.mode === 'all-changed' ? options.fileCount
    : options.mode === 'one-percent-dirty' ? Math.max(1, Math.ceil(options.fileCount * 0.01))
    : options.mode === 'dirty-burst' ? Math.min(100, options.fileCount)
    : options.mode === 'eight-day-one-dirty' ? 1 : 0;
  return Array.from({ length: options.fileCount }, (_value, fileIndex) => {
    const count = base + (remainder-- > 0 ? 1 : 0);
    const path = `Benchmark/${fileIndex}.md`;
    const oldContent = Array.from({ length: count }, (_task, taskIndex) => `- [ ] Task ${fileIndex}-${taskIndex}`).join('\n');
    const currentContent = fileIndex < dirtyCount ? oldContent.replace('- [ ]', '- [x]') : oldContent;
    const file = Object.assign(Object.create(TFile.prototype) as TFile, {
      path,
      name: `${fileIndex}.md`,
      basename: String(fileIndex),
      extension: 'md',
      stat: { mtime: fileIndex < dirtyCount ? 2 : 1, ctime: 1, size: Buffer.byteLength(currentContent) },
    });
    return { file, oldContent, currentContent, oldTasks: scanner.scanFileContent(file, oldContent) };
  });
}

export function createScanScenarioRunner(options: ScanScenarioOptions): () => Promise<{ counters: ScanScenarioCounters }> {
  const setupScanner = new TaskScanner({} as never);
  const fixtures = fixture(options, setupScanner);
  const oldTimestamp = Date.now() - 8 * 24 * 60 * 60 * 1000;

  return async () => {
    const counters: ScanScenarioCounters = {
      bodyReads: 0,
      bytesRead: 0,
      parseCalls: 0,
      hashCalls: 0,
      stateWrites: 0,
      indexCommits: 0,
      snapshotEntriesVisited: 0,
      parsedTasks: 0,
    };
    let pluginData: { state?: Partial<PersistedState> } = {
      state: {
        version: 1,
        snapshot: options.mode === 'cold' ? [] : fixtures.flatMap(({ oldTasks }) => oldTasks.map((task) => ({ key: task.key, status: task.status, filePath: task.filePath, lineNumber: task.lineNumber }))),
        completions: [],
        identityMigration: { version: 2, completed: true, conflicts: [] },
      },
    };
    const stateAdapter = {
      loadData: async () => structuredClone(pluginData),
      saveData: async (data: typeof pluginData) => { counters.stateWrites += 1; pluginData = structuredClone(data); },
    };
    const store = new StateStore(stateAdapter as never);
    if (options.mode !== 'cold') {
      pluginData.state = {
        ...pluginData.state,
        fileHashes: Object.fromEntries(fixtures.map(({ file, oldContent }) => [file.path, {
          path: file.path,
          hash: store.hash(oldContent),
          timestamp: oldTimestamp,
          mtime: 1,
          size: Buffer.byteLength(oldContent),
        }])),
      };
    }
    const originalHash = store.hash.bind(store);
    store.hash = (value: string) => { counters.hashCalls += 1; return originalHash(value); };
    const app = {
      vault: {
        getFiles: () => fixtures.map(({ file }) => file),
        getAbstractFileByPath: (path: string) => fixtures.find(({ file }) => file.path === path)?.file ?? null,
        read: async (file: TFile) => {
          if (counters.bodyReads > 0 && counters.bodyReads % 512 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
          const content = fixtures.find((fixture) => fixture.file.path === file.path)?.currentContent ?? '';
          counters.bodyReads += 1;
          counters.bytesRead += Buffer.byteLength(content);
          return content;
        },
      },
      metadataCache: { getFileCache: () => null },
      workspace: { getLeavesOfType: () => [] },
    };
    const scanner = new TaskScanner(app as never);
    const scanContent = scanner.scanFileContent.bind(scanner);
    scanner.scanFileContent = (file, content) => {
      counters.parseCalls += 1;
      const parsed = scanContent(file, content);
      counters.parsedTasks += parsed.length;
      return parsed;
    };
    const index = new TaskIndex();
    index.beginHydration();
    if (options.mode !== 'cold') index.commit(new Map(fixtures.map(({ file, oldTasks }) => [file.path, oldTasks])));
    const originalCommit = index.commit.bind(index);
    index.commit = (...args: Parameters<TaskIndex['commit']>) => {
      const result = originalCommit(...args);
      if (result) counters.indexCommits += 1;
      return result;
    };
    const snapshot = new CountingSnapshotMap();
    if (options.mode !== 'cold') {
      for (const { oldTasks } of fixtures) {
        for (const task of oldTasks) snapshot.set(task.key, { key: task.key, status: task.status, filePath: task.filePath, lineNumber: task.lineNumber });
      }
    }
    const plugin = Object.create(TaskManagerPlugin.prototype) as BenchmarkPluginHarness;
    plugin.settings = { ...DEFAULT_SETTINGS };
    plugin.app = app;
    plugin.scanner = scanner;
    plugin.stateStore = store;
    plugin.taskIndex = index;
    plugin.queryRenderer = { invalidateCache: () => undefined, refreshAllVisible: () => undefined };
    plugin.dailyNoteResolver = { isTodayDailyNote: () => true };
    plugin.snapshot = snapshot;
    plugin.completions = [];
    plugin.recurrenceCounts = {};
    plugin.pendingCompletionKeyMigrations = new Map();
    plugin.pendingRecurrenceCountMigrations = new Map();
    plugin.pendingRemovedIndexPaths = new Set();
    plugin.firedReminders = new Set();
    plugin.cacheUpdateHandlers = [];
    plugin.statusChangeHandlers = [];
    plugin.identityStateRevision = 0;
    plugin.persistedIdentityStateRevision = 0;
    plugin.syncQueueRevision = 0;
    plugin.persistedSyncQueueRevision = 0;
    plugin.syncStatePersistenceQueue = Promise.resolve();

    counters.hashCalls = 0;
    counters.indexCommits = 0;
    await plugin.scanVault(false, false);
    counters.snapshotEntriesVisited = snapshot.visits;
    return { counters };
  };
}
