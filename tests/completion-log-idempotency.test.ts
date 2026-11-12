import assert from 'node:assert/strict';
import test from 'node:test';
import type { App } from 'obsidian';
import TaskManagerPlugin from '../src/main';
import { LogWriter } from '../src/log-writer';
import { StateStore } from '../src/state-store';
import { DEFAULT_SETTINGS } from '../src/types';
import { createMockTask, FakeFile } from './test-utils';

interface CompletionHarness {
  settings: typeof DEFAULT_SETTINGS;
  stateStore: StateStore;
  logWriter: LogWriter;
  dailyNoteResolver: { resolveToday: () => Promise<{ path: string; file: FakeFile }>; isTodayDailyNote: (path: string) => boolean };
  snapshot: Map<string, unknown>;
  completions: unknown[];
  recurrenceCounts: Record<string, number>;
  inFlightCompletions: Set<string>;
  suppressedCompletionKeys: Set<string>;
  handleCompletion: (task: ReturnType<typeof createMockTask>) => Promise<void>;
}

void test('completion retry after persistence failure reconciles the stable daily-log marker', async () => {
  const daily = new FakeFile('Daily/2026-07-11.md', '2026-07-11.md');
  let dailyContent = '';
  const app = {
    vault: {
      cachedRead: async () => dailyContent,
      process: async (_file: FakeFile, updater: (content: string) => string) => { dailyContent = updater(dailyContent); },
      getAbstractFileByPath: () => null,
    },
    metadataCache: { fileToLinktext: () => '' },
  } as unknown as App;
  const makePlugin = (persistState: () => Promise<void>): CompletionHarness => {
    const plugin = Object.create(TaskManagerPlugin.prototype) as CompletionHarness;
    plugin.settings = { ...DEFAULT_SETTINGS, completionLoggingEnabled: true, includeCompletionTime: false, includeSourceLinkWhenNotDailyNote: false };
    plugin.stateStore = new StateStore({ loadData: async () => undefined, saveData: persistState } as never);
    plugin.logWriter = new LogWriter(app, () => plugin.settings);
    plugin.dailyNoteResolver = {
      resolveToday: async () => ({ path: daily.path, file: daily }),
      isTodayDailyNote: (path) => path === daily.path,
    };
    plugin.snapshot = new Map();
    plugin.completions = [];
    plugin.recurrenceCounts = {};
    plugin.inFlightCompletions = new Set();
    plugin.suppressedCompletionKeys = new Set();
    return plugin;
  };
  const task = createMockTask({ key: 'durable-id', filePath: 'Projects/Work.md', normalizedText: 'Persist safely', status: 'done' });
  const disabled = makePlugin(async () => undefined);
  disabled.settings.completionLoggingEnabled = false;
  disabled.dailyNoteResolver.resolveToday = async () => { throw new Error('daily note must not be resolved while logging is disabled'); };
  await disabled.handleCompletion(task);
  assert.equal(dailyContent, '', 'default-off logging must not touch the daily note');
  assert.equal(disabled.completions.length, 0);

  const first = makePlugin(async () => { throw new Error('simulated state write failure'); });
  await assert.rejects(first.handleCompletion(task), /simulated state write failure/u);
  assert.equal((dailyContent.match(/task-manager-completion:/gu) ?? []).length, 1);

  const restarted = makePlugin(async () => undefined);
  await restarted.handleCompletion(task);
  assert.equal((dailyContent.match(/task-manager-completion:/gu) ?? []).length, 1, 'restart retry must not append a second visible entry');
  assert.equal(restarted.completions.length, 1, 'retry must persist the recovered dedupe record');
});
