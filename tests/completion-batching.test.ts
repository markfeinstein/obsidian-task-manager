import test from 'node:test';
import assert from 'node:assert/strict';
import type { App, TFile } from 'obsidian';
import { CompletionCoordinator } from '../src/completion-coordinator';
import TaskManagerPlugin from '../src/main';
import { LogWriter } from '../src/log-writer';
import { StateStore } from '../src/state-store';
import { DEFAULT_SETTINGS } from '../src/types';
import { createMockTask, FakeFile } from './test-utils';
import type { ParsedTask } from '../src/task-scanner';

function harness() {
  const daily = new FakeFile('Daily/2026-07-12.md', '2026-07-12.md');
  let content = '';
  let resolverCalls = 0;
  let cachedReads = 0;
  let processCalls = 0;
  let saveCalls = 0;
  let failProcess = false;
  let cancelBeforeProcess = false;
  let active = true;
  const app = {
    vault: {
      cachedRead: async () => { cachedReads += 1; return content; },
      process: async (_file: TFile, update: (current: string) => string) => {
        processCalls += 1;
        if (failProcess) throw new Error('daily note write failed');
        if (cancelBeforeProcess) active = false;
        content = update(content);
      },
      getAbstractFileByPath: () => null,
    },
    metadataCache: { fileToLinktext: () => '' },
  } as unknown as App;
  const store = new StateStore({ loadData: async () => undefined, saveData: async () => { saveCalls += 1; } } as never);
  const writer = new LogWriter(app, () => ({
    ...DEFAULT_SETTINGS,
    completionLoggingEnabled: true,
    includeCompletionTime: false,
    includeSourceLinkWhenNotDailyNote: false,
  }));
  const resolver = {
    resolveToday: async () => { resolverCalls += 1; return { path: daily.path, file: daily as unknown as TFile }; },
    isTodayDailyNote: (path: string) => path === daily.path,
  };
  const coordinator = new CompletionCoordinator(store, resolver, writer);
  return {
    coordinator,
    store,
    content: () => content,
    counters: () => ({ resolverCalls, cachedReads, processCalls, saveCalls }),
    setFailProcess: (value: boolean) => { failProcess = value; },
    setCancelBeforeProcess: (value: boolean) => { cancelBeforeProcess = value; },
    isActive: () => active,
    resetActive: () => { active = true; },
  };
}

function tasks(count: number) {
  return Array.from({ length: count }, (_value, index) => createMockTask({
    key: `id:batch-${index}`,
    filePath: `Tasks/${index}.md`,
    lineNumber: 1,
    normalizedText: `Completed ${index}`,
    status: 'done',
  }));
}

test('completion coordinator materializes 1000 completions with one resolution and one note write', async () => {
  const h = harness();
  const inFlight = new Set<string>();
  const records = await h.coordinator.materialize({
    tasks: tasks(1000), existingRecords: [], inFlightKeys: inFlight,
    shouldInclude: () => true, isActive: h.isActive,
  });
  assert.equal(records.length, 1000);
  assert.deepEqual(h.counters(), { resolverCalls: 1, cachedReads: 1, processCalls: 1, saveCalls: 0 });
  assert.equal(inFlight.size, 0);
  assert.equal((h.content().match(/task-manager-completion:/gu) ?? []).length, 1000);

  // Simulate append success followed by state-write failure/restart: no records
  // are supplied, but stable markers reconcile in one retry write without dupes.
  const retried = await h.coordinator.materialize({
    tasks: tasks(1000), existingRecords: [], inFlightKeys: inFlight,
    shouldInclude: () => true, isActive: h.isActive,
  });
  assert.equal(retried.length, 1000);
  assert.equal(h.counters().processCalls, 2);
  assert.equal((h.content().match(/task-manager-completion:/gu) ?? []).length, 1000);
});

test('scan-wave integration merges 1000 records before one caller-owned persistence', async () => {
  const h = harness();
  let persistCalls = 0;
  const plugin = Object.create(TaskManagerPlugin.prototype) as unknown as {
    settings: typeof DEFAULT_SETTINGS;
    completionCoordinator: CompletionCoordinator;
    stateStore: StateStore;
    completions: Array<{ taskKey: string; sourcePath: string; dailyNotePath: string; completedAtIso: string; logLineHash: string }>;
    inFlightCompletions: Set<string>;
    suppressedCompletionKeys: Set<string>;
    materializeCompletionTasks(tasks: readonly ParsedTask[]): Promise<number>;
    persistState(): Promise<void>;
  };
  plugin.settings = { ...DEFAULT_SETTINGS, completionLoggingEnabled: true };
  plugin.completionCoordinator = h.coordinator;
  plugin.stateStore = h.store;
  plugin.completions = [];
  plugin.inFlightCompletions = new Set();
  plugin.suppressedCompletionKeys = new Set();
  plugin.persistState = async () => { persistCalls += 1; };

  assert.equal(await plugin.materializeCompletionTasks(tasks(1000)), 1000);
  assert.equal(plugin.completions.length, 1000);
  assert.equal(persistCalls, 0, 'materialization must not persist per task');
  await plugin.persistState();
  assert.equal(persistCalls, 1, 'the scan commit owns one persistence for the batch');
});

test('completion coordinator returns no records after failure or lifecycle cancellation', async () => {
  const failed = harness();
  failed.setFailProcess(true);
  const failedFlight = new Set<string>();
  await assert.rejects(failed.coordinator.materialize({
    tasks: tasks(3), existingRecords: [], inFlightKeys: failedFlight,
    shouldInclude: () => true, isActive: failed.isActive,
  }), /daily note write failed/u);
  assert.equal(failedFlight.size, 0);
  assert.equal(failed.content(), '');

  const cancelled = harness();
  cancelled.setCancelBeforeProcess(true);
  const cancelledRecords = await cancelled.coordinator.materialize({
    tasks: tasks(3), existingRecords: [], inFlightKeys: new Set(),
    shouldInclude: () => true, isActive: cancelled.isActive,
  }).catch((error: unknown) => {
    assert.match(error instanceof Error ? error.message : String(error), /cancelled/u);
    return [];
  });
  assert.deepEqual(cancelledRecords, []);
  assert.equal(cancelled.content(), '');
});
