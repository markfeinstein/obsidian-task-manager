import test from 'node:test';
import assert from 'node:assert/strict';
import TaskManagerPlugin from '../src/main';
import { StateStore, type PersistedState } from '../src/state-store';
import { DEFAULT_SETTINGS } from '../src/types';
import { IdentityMapper } from '../src/sync-identity-mapper';
import { SyncOperationQueue } from '../src/sync-operations';
import type { SyncOperation } from '../src/sync-contract';
import { ReminderManager } from '../src/reminder-manager';

type CommandHarness = {
  settings: typeof DEFAULT_SETTINGS;
  snapshot: Map<string, { key: string; status: string; filePath: string; lineNumber: number }>;
  completions: PersistedState['completions'];
  stateStore: StateStore;
  addCommand: (command: { id: string; callback?: () => Promise<void> }) => void;
  registerCommands: () => void;
};

type SyncRaceHarness = {
  stateStore: StateStore;
  snapshot: Map<string, unknown>;
  completions: PersistedState['completions'];
  recurrenceCounts: Record<string, number>;
  firedReminders: Set<string>;
  pendingCompletionKeyMigrations: Map<string, string>;
  pendingRecurrenceCountMigrations: Map<string, string>;
  syncOperationQueue: SyncOperationQueue;
  identityMapper: IdentityMapper;
  applySyncQueueReviewAction: (action: { now: number; discardOperationIds: string[] }) => Promise<unknown>;
  persistState: () => Promise<void>;
};

type ReminderHarness = {
  settings: typeof DEFAULT_SETTINGS;
  stateStore: StateStore;
  reminderManager: ReminderManager;
  firedReminders: Set<string>;
  taskIndex: { getSnapshot: () => { readiness: 'ready'; revision: number } };
  reminderIndex: {
    claimDue: () => Array<{ key: string; fireTime: string; version: number; task: Record<string, unknown> }>;
    ackDue: (claims: readonly unknown[]) => void;
    retryDue: (claims: readonly unknown[]) => void;
    keyForStoredRecord: (record: { reminderKey: string }) => string | undefined;
    resolve: (key: string) => { key: string; fireTime: string; task: Record<string, unknown> } | undefined;
  };
  fireReminderNotification: (text: string, key: string) => void;
  checkDueReminders: () => Promise<void>;
};

function state(overrides: Partial<PersistedState> = {}): PersistedState {
  return {
    version: 1,
    snapshot: [],
    completions: [],
    ...overrides,
  };
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test('reset-state-cache command atomically clears snapshot and completion dedupe records', async () => {
  let pluginData: { state?: Partial<PersistedState>; extensionKey?: string } = {
    extensionKey: 'preserved',
    state: state({
      snapshot: [{ key: 'Tasks.md:1', status: 'done', filePath: 'Tasks.md', lineNumber: 1 }],
      completions: [{
        taskKey: 'Tasks.md:1', sourcePath: 'Tasks.md', dailyNotePath: 'Daily.md',
        completedAtIso: '2026-07-11T09:00:00.000Z', logLineHash: 'hash',
      }],
      habitCompletions: { habit: ['2026-07-11'] },
    }),
  };
  const store = new StateStore({
    loadData: async () => pluginData,
    saveData: async (data: typeof pluginData) => { pluginData = data; },
  } as never);
  const plugin = Object.create(TaskManagerPlugin.prototype) as unknown as CommandHarness;
  const commands = new Map<string, { callback?: () => Promise<void> }>();
  plugin.settings = { ...DEFAULT_SETTINGS };
  plugin.snapshot = new Map([['Tasks.md:1', { key: 'Tasks.md:1', status: 'done', filePath: 'Tasks.md', lineNumber: 1 }]]);
  plugin.completions = [...(pluginData.state?.completions ?? [])];
  plugin.stateStore = store;
  plugin.addCommand = (command: { id: string; callback?: () => Promise<void> }) => { commands.set(command.id, command); };

  plugin.registerCommands();
  const reset = commands.get('reset-state-cache');
  assert.ok(reset?.callback);
  await reset.callback();

  const committed = await store.loadState();
  assert.deepEqual(committed.snapshot, []);
  assert.deepEqual(committed.completions, []);
  assert.deepEqual(committed.habitCompletions, { habit: ['2026-07-11'] });
  assert.equal(pluginData.extensionKey, 'preserved');
});

test('delayed conflict-review save cannot be overwritten by stale persistState sync projections', async () => {
  const operation = {
    id: 'discard-me', type: 'create', service: 'todoist', vaultTask: { key: 'Tasks.md:1' },
    payload: { content: 'Task' }, queuedAt: 1, status: 'failed', error: 'timeout',
  } as unknown as SyncOperation;
  const newerIdentity = {
    version: 1,
    identities: [{ vaultKey: 'newer', externalIds: { todoist: 'remote-new' }, createdAt: 1, updatedAt: 2 }],
  };
  let pluginData: { state?: Partial<PersistedState> } = {
    state: state({
      identityState: newerIdentity,
      syncQueueState: { version: 1, operations: [operation], completed: [] },
    }),
  };
  const firstSaveStarted = deferred();
  const releaseFirstSave = deferred();
  let saveCount = 0;
  const store = new StateStore({
    loadData: async () => structuredClone(pluginData),
    saveData: async (data: typeof pluginData) => {
      saveCount += 1;
      if (saveCount === 1) {
        firstSaveStarted.resolve();
        await releaseFirstSave.promise;
      }
      pluginData = structuredClone(data);
    },
  } as never);
  const plugin = Object.create(TaskManagerPlugin.prototype) as unknown as SyncRaceHarness;
  plugin.stateStore = store;
  plugin.snapshot = new Map();
  plugin.completions = [];
  plugin.recurrenceCounts = {};
  plugin.firedReminders = new Set();
  plugin.pendingCompletionKeyMigrations = new Map();
  plugin.pendingRecurrenceCountMigrations = new Map();
  plugin.syncOperationQueue = new SyncOperationQueue({ version: 1, operations: [], completed: [] });
  plugin.identityMapper = new IdentityMapper({
    version: 1,
    identities: [{ vaultKey: 'stale', externalIds: { todoist: 'remote-old' }, createdAt: 1, updatedAt: 1 }],
  });

  const reviewWrite = plugin.applySyncQueueReviewAction({ now: 10, discardOperationIds: ['discard-me'] });
  await firstSaveStarted.promise;
  const ordinaryPersistence = plugin.persistState();
  releaseFirstSave.resolve();
  await Promise.all([reviewWrite, ordinaryPersistence]);

  const committed = await store.loadState();
  assert.deepEqual(committed.syncQueueState?.operations, []);
  assert.equal(committed.syncQueueState?.completed[0]?.id, 'discard-me');
  assert.deepEqual(committed.identityState, { ...newerIdentity, version: 2 });
  assert.deepEqual(plugin.syncOperationQueue.getState(), committed.syncQueueState);
});

test('overlapping reminder checks coalesce snoozed, regular, and queued notification delivery', async () => {
  const snoozedKey = 'Tasks.md:1:2000-01-01 08:00';
  const queuedKey = 'Tasks.md:2:2000-01-01 08:00';
  const regularKey = 'Tasks.md:3:2000-01-01 08:00';
  let pluginData: { state?: Partial<PersistedState> } = {
    state: state({
      snoozedReminders: [{
        reminderKey: snoozedKey, taskFilePath: 'Tasks.md', taskLineNumber: 1, taskText: 'Snoozed',
        originalReminderTime: '2000-01-01 08:00', nextFireTime: '2000-01-01 08:05', snoozedAtIso: '2000-01-01T08:00:00.000Z',
      }],
      queuedNotifications: [{
        reminderKey: queuedKey, taskFilePath: 'Tasks.md', taskLineNumber: 2, taskText: 'Queued',
        reminderTime: '2000-01-01 08:00', enqueuedAtIso: '2000-01-01T08:00:00.000Z',
      }],
    }),
  };
  const store = new StateStore({
    loadData: async () => structuredClone(pluginData),
    saveData: async (data: typeof pluginData) => { pluginData = structuredClone(data); },
  } as never);
  const plugin = Object.create(TaskManagerPlugin.prototype) as unknown as ReminderHarness;
  plugin.settings = { ...DEFAULT_SETTINGS, enableReminderNotifications: true, quietHoursEnabled: false, missedReminderLogEnabled: false };
  plugin.stateStore = store;
  plugin.reminderManager = new ReminderManager({ stateStore: store, settings: plugin.settings });
  plugin.firedReminders = new Set();
  plugin.taskIndex = { getSnapshot: () => ({ readiness: 'ready', revision: 1 }) };
  const entries = new Map([
    [snoozedKey, { key: snoozedKey, fireTime: '2000-01-01 08:00', task: { status: 'todo', filePath: 'Tasks.md', lineNumber: 1, rawLine: 'Snoozed', normalizedText: 'Snoozed', metadata: { reminder: '2000-01-01 08:00' } } }],
    [queuedKey, { key: queuedKey, fireTime: '2000-01-01 08:00', task: { status: 'todo', filePath: 'Tasks.md', lineNumber: 2, rawLine: 'Queued', normalizedText: 'Queued', metadata: { reminder: '2000-01-01 08:00' } } }],
    [regularKey, { key: regularKey, fireTime: '2000-01-01 08:00', task: { status: 'todo', filePath: 'Tasks.md', lineNumber: 3, rawLine: 'Regular', normalizedText: 'Regular', metadata: { reminder: '2000-01-01 08:00' } } }],
  ]);
  let dueCalls = 0;
  plugin.reminderIndex = {
    claimDue: () => { const entry = entries.get(regularKey); dueCalls += 1; return entry ? [{ ...entry, version: 1 }] : []; },
    ackDue: () => { entries.delete(regularKey); },
    retryDue: () => {},
    keyForStoredRecord: (record) => entries.has(record.reminderKey) ? record.reminderKey : undefined,
    resolve: (key) => entries.get(key),
  };
  const fired: string[] = [];
  plugin.fireReminderNotification = (_text: string, key: string) => { fired.push(key); };

  const first = plugin.checkDueReminders();
  const second = plugin.checkDueReminders();
  await Promise.all([first, second]);

  assert.equal(dueCalls, 1);
  assert.deepEqual(fired.sort(), [queuedKey, regularKey, snoozedKey].sort());
  assert.equal(new Set(fired).size, 3);
  const committed = await store.loadState();
  assert.deepEqual(committed.snoozedReminders, []);
  assert.deepEqual(committed.queuedNotifications, []);
});
