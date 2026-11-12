import test from 'node:test';
import assert from 'node:assert/strict';
import { findJournalPathConflict, StateStore, type PersistedState, type TaskMoveJournal, type TimeSessionRecord } from '../src/state-store';

function baseState(overrides: Partial<PersistedState> = {}): PersistedState {
  return {
    version: 1,
    snapshot: [],
    completions: [],
    ...overrides,
  };
}

function timeSession(overrides: Partial<TimeSessionRecord> = {}): TimeSessionRecord {
  return {
    taskKey: 'Tasks.md:Focus',
    taskFilePath: 'Tasks.md',
    taskLineNumber: 1,
    taskText: 'Focus',
    startedAtIso: '2026-05-28T09:00:00.000Z',
    endedAtIso: '2026-05-28T09:30:00.000Z',
    elapsedMinutes: 30,
    source: 'clock',
    ...overrides,
  };
}

test('journal path fencing detects overlap across move and lifecycle operation types', () => {
  const move = { operationId: 'move-1', sourcePath: 'Source.md', targetPath: 'Target.md' } as TaskMoveJournal;
  const state = baseState({ taskMoveJournals: [move], taskLifecycleTransferJournals: [] });
  assert.equal(findJournalPathConflict(state, 'Other.md', 'Source.md')?.operationId, 'move-1');
  assert.equal(findJournalPathConflict(state, 'Other.md', 'Elsewhere.md'), undefined);
  assert.equal(findJournalPathConflict(state, 'Target.md', 'Elsewhere.md', 'move-1'), undefined);
});

test('state-store: migrates legacy file-task snapshots and enforces v2 source kinds', async () => {
  const load = async (sliceVersions: Record<string, number> | undefined, snapshot: unknown[]) => new StateStore({
    loadData: async () => ({ state: { version: 2, ...(sliceVersions ? { sliceVersions } : {}), snapshot, completions: [] } }),
    saveData: async () => undefined,
  } as never).loadState();

  const legacy = await load(undefined, [
    { key: 'id:file', status: 'todo', filePath: 'Task.md', lineNumber: 0 },
    { key: 'line', status: 'todo', filePath: 'Tasks.md', lineNumber: 2 },
  ]);
  assert.deepEqual(legacy.snapshot.map(({ sourceKind, lineNumber }) => ({ sourceKind, lineNumber })), [
    { sourceKind: 'file', lineNumber: 0 },
    { sourceKind: 'line', lineNumber: 2 },
  ]);

  const v2 = await load({ scan: 2 }, [
    { key: 'file', status: 'todo', filePath: 'Task.md', lineNumber: 0, sourceKind: 'file' },
    { key: 'line', status: 'todo', filePath: 'Tasks.md', lineNumber: 1, sourceKind: 'line' },
    { key: 'missing-kind', status: 'todo', filePath: 'Task.md', lineNumber: 0 },
    { key: 'bad-file', status: 'todo', filePath: 'Task.md', lineNumber: 1, sourceKind: 'file' },
    { key: 'bad-line', status: 'todo', filePath: 'Tasks.md', lineNumber: 0, sourceKind: 'line' },
    { key: 'bad-kind', status: 'todo', filePath: 'Task.md', lineNumber: 0, sourceKind: 'unknown' },
    { key: 'bad-extension', status: 'todo', filePath: 'Task.canvas', lineNumber: 0, sourceKind: 'file' },
    { key: 'bad-traversal', status: 'todo', filePath: '../Task.md', lineNumber: 0, sourceKind: 'file' },
    { key: 'bad-absolute', status: 'todo', filePath: '/Task.md', lineNumber: 0, sourceKind: 'file' },
  ]);
  assert.deepEqual(v2.snapshot.map((entry) => entry.key), ['file', 'line']);
});

test('state-store: cached snapshots are recursively frozen against out-of-transaction mutation', async () => {
  const store = new StateStore({
    loadData: async () => ({ state: baseState({ recurrenceCounts: { task: 2 }, habitCompletions: { task: ['2026-07-13'] } }) }),
    saveData: async () => undefined,
  } as never);
  const state = await store.loadState();
  assert.ok(Object.isFrozen(state));
  assert.ok(Object.isFrozen(state.recurrenceCounts));
  assert.ok(Object.isFrozen(state.habitCompletions?.task));
  assert.throws(() => { state.completions.push({} as never); }, /read only|extensible|frozen|object/u);
});

test('state-store: loadState normalizes recurrence counts to safe integers', async () => {
  const store = new StateStore({
    loadData: async () => ({
      state: {
        version: 1,
        snapshot: [],
        completions: [],
        recurrenceCounts: {
          validNumber: 2,
          numericString: '3',
          negative: -1,
          decimal: 1.5,
          invalidString: '3x',
          nanValue: Number.NaN,
        },
      },
    }),
    saveData: async () => {},
  } as never);

  const state = await store.loadState();

  assert.deepStrictEqual(state.recurrenceCounts, {
    validNumber: 2,
    numericString: 3,
  });
  assert.equal(store.incrementRecurrenceCount(state, 'numericString').recurrenceCounts?.numericString, 4);
});

test('state-store: rejects impossible ISO dates in habit completions and recurrence exceptions', async () => {
  const store = new StateStore({
    loadData: async () => ({
      state: {
        version: 1,
        snapshot: [],
        completions: [],
        habitCompletions: {
          habit: ['2026-02-28', '2026-02-31', 'not-a-date'],
        },
        recurrenceExceptions: {
          series: [
            { seriesId: 'series', date: '2026-02-28', reason: 'skipped' },
            { seriesId: 'series', date: '2026-02-31', reason: 'deleted' },
          ],
        },
      },
    }),
    saveData: async () => {},
  } as never);

  const state = await store.loadState();

  assert.deepStrictEqual(state.habitCompletions, { habit: ['2026-02-28'] });
  assert.deepStrictEqual(state.recurrenceExceptions?.series.map((entry) => entry.date), ['2026-02-28']);

  const rejectedHabit = store.addHabitCompletion(state, 'habit', '2026-02-31');
  assert.deepStrictEqual(rejectedHabit.habitCompletions, state.habitCompletions);

  const rejectedException = store.addRecurrenceException(state, { seriesId: 'series', date: '2026-02-31', reason: 'skipped' });
  assert.deepStrictEqual(rejectedException.recurrenceExceptions, state.recurrenceExceptions);
});

test('state-store: stores recurrence occurrences without duplicates', async () => {
  const store = new StateStore({ loadData: async () => ({}), saveData: async () => {} } as never);
  const state = baseState();
  const first = store.addRecurrenceOccurrence(state, { seriesId: 'series-a', date: '2026-06-01', taskKey: 'task-1' });
  const duplicate = store.addRecurrenceOccurrence(first, { seriesId: 'series-a', date: '2026-06-01', taskKey: 'task-1' });
  const second = store.addRecurrenceOccurrence(duplicate, { seriesId: 'series-a', date: '2026-06-02', taskKey: 'task-2' });

  assert.deepEqual(store.getRecurrenceOccurrences(second, 'series-a').map((entry) => entry.date), ['2026-06-01', '2026-06-02']);
  assert.deepEqual(store.addRecurrenceOccurrence(second, { seriesId: 'series-a', date: '2026-02-31' }).recurrenceOccurrences, second.recurrenceOccurrences);
});

test('state-store: filters corrupt persisted sync queue operations', async () => {
  const validOperation = {
    id: 'sync-op-7',
    type: 'create',
    service: 'todoist',
    vaultTask: { key: 'task-1' },
    payload: { content: 'Task' },
    queuedAt: 1,
    status: 'queued',
  };
  const validCompleted = {
    ...validOperation,
    id: 'sync-op-8',
    status: 'success',
    completedAt: 2,
  };
  const store = new StateStore({
    loadData: async () => ({
      state: {
        version: 1,
        snapshot: [],
        completions: [],
        syncQueueState: {
          version: 1,
          operations: [validOperation, { ...validOperation, id: 9 }, null],
          completed: [validCompleted, { ...validCompleted, completedAt: 'bad' }, { ...validCompleted, id: undefined }],
        },
      },
    }),
    saveData: async () => {},
  } as never);

  const state = await store.loadState();

  assert.deepEqual(state.syncQueueState?.operations.map((operation) => operation.id), ['sync-op-7']);
  assert.deepEqual(state.syncQueueState?.completed.map((operation) => operation.id), ['sync-op-8']);
});

test('state-store: normalizes corrupt file hashes on load', async () => {
  const store = new StateStore({
    loadData: async () => ({
      state: {
        version: 1,
        snapshot: [],
        completions: [],
        fileHashes: {
          'Tasks.md': { path: '', hash: 'abc123', timestamp: 10 },
          'Old.md': { path: 'Old.md', hash: '', timestamp: 20 },
          'Bad.md': { path: 'Bad.md', hash: 'def456', timestamp: 'bad' },
          'Missing.md': null,
        },
      },
    }),
    saveData: async () => {},
  } as never);

  const state = await store.loadState();

  assert.deepEqual(state.fileHashes, {
    'Tasks.md': { path: 'Tasks.md', hash: 'abc123', timestamp: 10 },
  });
});

test('state-store: normalizes file hash entries to the record path key', async () => {
  const store = new StateStore({
    loadData: async () => ({
      state: {
        version: 1,
        snapshot: [],
        completions: [],
        fileHashes: {
          'Old-name.md': { path: 'Renamed.md', hash: 'abc123', timestamp: 10 },
        },
      },
    }),
    saveData: async () => {},
  } as never);

  const state = await store.loadState();

  assert.deepEqual(state.fileHashes, {
    'Renamed.md': { path: 'Renamed.md', hash: 'abc123', timestamp: 10 },
  });
  assert.equal(store.getFileHash(state, 'Renamed.md')?.hash, 'abc123');
  assert.equal(store.getFileHash(state, 'Old-name.md'), undefined);
});

test('state-store: filters malformed snapshot and completion entries during load', async () => {
  const store = new StateStore({
    loadData: async () => ({
      state: {
        version: 1,
        snapshot: [
          { key: 'Tasks.md:1', status: 'todo', filePath: 'Tasks.md', lineNumber: 1 },
          { key: '', status: 'todo', filePath: 'Tasks.md', lineNumber: 2 },
          null,
        ],
        completions: [
          {
            taskKey: 'Tasks.md:1',
            sourcePath: 'Tasks.md',
            dailyNotePath: 'Daily/2026-05-28.md',
            completedAtIso: '2026-05-28T09:00:00.000Z',
            logLineHash: 'abc123',
          },
          { taskKey: 'Tasks.md:2', sourcePath: '', dailyNotePath: 'Daily/2026-05-28.md', completedAtIso: '2026-05-28T09:00:00.000Z', logLineHash: 'def456' },
          'broken',
        ],
      },
    }),
    saveData: async () => {},
  } as never);

  const state = await store.loadState();

  assert.deepEqual(state.snapshot, [
    { key: 'Tasks.md:1', status: 'todo', filePath: 'Tasks.md', lineNumber: 1, sourceKind: 'line' },
  ]);
  assert.deepEqual(state.completions, [
    {
      taskKey: 'Tasks.md:1',
      sourcePath: 'Tasks.md',
      dailyNotePath: 'Daily/2026-05-28.md',
      completedAtIso: '2026-05-28T09:00:00.000Z',
      logLineHash: 'abc123',
    },
  ]);
});

test('state-store: normalizes malformed scan metrics during load', async () => {
  const store = new StateStore({
    loadData: async () => ({
      state: {
        version: 1,
        snapshot: [],
        completions: [],
        scanMetrics: {
          totalTasksScanned: -1,
          scanDurationMs: 'bad',
          lastScanTimeIso: 'not-a-date',
        },
      },
    }),
    saveData: async () => {},
  } as never);

  const state = await store.loadState();

  assert.deepStrictEqual(state.scanMetrics, {
    totalTasksScanned: 0,
    scanDurationMs: 0,
    lastScanTimeIso: new Date(0).toISOString(),
  });
});

test('state-store: refreshes ICS cache with invalid fetch timestamp', () => {
  const store = new StateStore({} as never);
  const state = store.setIcsCache({ version: 1, snapshot: [], completions: [] }, 'calendar', []);
  const corrupted = {
    ...state,
    icsCache: {
      calendar: {
        ...state.icsCache?.calendar,
        lastFetchIso: 'not-a-date',
        events: [],
      },
    },
  };

  assert.equal(store.needsIcsCacheRefresh(corrupted, 'calendar', 60), true);
});

test('state-store: normalizes malformed persisted ICS cache records and events', async () => {
  const store = new StateStore({ loadData: async () => ({ state: baseState({
    icsCache: {
      valid: { lastFetchIso: '2026-05-28T10:00:00.000Z', events: [
        { summary: 'Meeting', date: '2026-05-29', startTime: '09:00', endTime: '10:00', uid: 'event-1' },
        { summary: 'Bad date', date: '2026-02-31', uid: null },
        { summary: 'Bad time', date: null, startTime: '99:00', uid: null },
      ] },
      stale: { lastFetchIso: 'not-a-date', events: [] },
      broken: { lastFetchIso: '2026-05-28T10:00:00.000Z', events: {} as never },
    },
  }) }), saveData: async () => undefined } as never);
  const state = await store.loadState();
  assert.deepEqual(state.icsCache, {
    valid: { lastFetchIso: '2026-05-28T10:00:00.000Z', events: [
      { summary: 'Meeting', date: '2026-05-29', startTime: '09:00', endTime: '10:00', uid: 'event-1' },
    ] },
  });
});

test('state-store: prunes completions with invalid timestamps', () => {
  const store = new StateStore({} as never);
  const valid = {
    taskKey: 'valid',
    sourcePath: 'Tasks.md',
    dailyNotePath: 'Daily.md',
    completedAtIso: new Date().toISOString(),
    logLineHash: 'valid-hash',
  };

  assert.deepEqual(store.pruneCompletions([
    valid,
    { ...valid, taskKey: 'invalid', completedAtIso: 'not-a-date' },
  ], 30).map((record) => record.taskKey), ['valid']);
});

test('state-store: prunes missed reminders with invalid timestamps', () => {
  const store = new StateStore({} as never);
  const state = baseState({
    missedReminders: [
      { reminderKey: 'valid', taskFilePath: 'Tasks.md', taskLineNumber: 1, taskText: 'Valid', reminderTime: '2026-05-28 09:00', firedAtIso: new Date().toISOString(), acknowledged: false },
      { reminderKey: 'invalid', taskFilePath: 'Tasks.md', taskLineNumber: 2, taskText: 'Invalid', reminderTime: '2026-05-28 10:00', firedAtIso: 'not-a-date', acknowledged: false },
    ],
  });

  assert.deepEqual(store.pruneMissedReminders(state, 30).missedReminders?.map((reminder) => reminder.reminderKey), ['valid']);
});

test('state-store: filters malformed persisted reminder and clock-in entries during load', async () => {
  const store = new StateStore({
    loadData: async () => ({
      state: {
        version: 1,
        snapshot: [],
        completions: [],
        clockInState: {
          taskKey: 'Tasks.md:clocked',
          taskFilePath: 'Tasks.md',
          taskLineNumber: 2,
          clockInTimeIso: 'not-a-date',
        },
        snoozedReminders: [
          { reminderKey: 'snoozed-valid', taskFilePath: 'Tasks.md', taskLineNumber: 1, taskText: 'Valid snooze', originalReminderTime: '2026-05-28 09:00', nextFireTime: '2026-05-28 09:15', snoozedAtIso: '2026-05-28T09:00:00.000Z' },
          null,
          { reminderKey: 'snoozed-invalid', taskFilePath: 'Tasks.md', taskLineNumber: '2', taskText: 'Bad snooze', originalReminderTime: '2026-05-28 09:00', nextFireTime: '2026-05-28 09:15', snoozedAtIso: '2026-05-28T09:00:00.000Z' },
        ],
        missedReminders: [
          { reminderKey: 'missed-read', taskFilePath: 'Tasks.md', taskLineNumber: 2, taskText: 'Already read', reminderTime: '2026-05-28 10:00', firedAtIso: '2026-05-28T10:00:00.000Z', acknowledged: true },
          { reminderKey: 'missed-unread', taskFilePath: 'Tasks.md', taskLineNumber: 3, taskText: 'Legacy unread', reminderTime: '2026-05-28 11:00', firedAtIso: '2026-05-28T11:00:00.000Z' },
          'broken',
        ],
        queuedNotifications: [
          { taskFilePath: 'Tasks.md', taskLineNumber: 4, taskText: 'Queued', reminderKey: 'queued-valid', reminderTime: '2026-05-28 12:00', enqueuedAtIso: '2026-05-28T11:55:00.000Z' },
          { taskFilePath: 'Tasks.md', taskLineNumber: 0, taskText: 'Invalid queued', reminderKey: 'queued-invalid', reminderTime: '2026-05-28 12:05', enqueuedAtIso: '2026-05-28T12:00:00.000Z' },
        ],
      },
    }),
    saveData: async () => {},
  } as never);

  const state = await store.loadState();

  assert.equal(state.clockInState, undefined);
  assert.deepEqual(state.snoozedReminders?.map((reminder) => reminder.reminderKey), ['snoozed-valid']);
  assert.deepEqual(state.missedReminders?.map(({ reminderKey, acknowledged }) => ({ reminderKey, acknowledged })), [
    { reminderKey: 'missed-read', acknowledged: true },
    { reminderKey: 'missed-unread', acknowledged: false },
  ]);
  assert.deepEqual(state.queuedNotifications?.map((notification) => notification.reminderKey), ['queued-valid']);
  assert.deepEqual(store.getUnacknowledgedMissedReminders(state).map((reminder) => reminder.reminderKey), ['missed-unread']);
});

test('state-store: filters time sessions with invalid timestamps', () => {
  const store = new StateStore({} as never);
  const valid = timeSession();
  const invalid = timeSession({ taskKey: 'invalid', startedAtIso: 'also-bad', endedAtIso: 'not-a-date' });
  const state = baseState({ timeSessionLog: [valid, invalid] });

  assert.deepEqual(
    store.pruneTimeSessions([valid, invalid], 90, Date.parse('2026-05-28T10:00:00.000Z')).map((session) => session.taskKey),
    ['Tasks.md:Focus'],
  );
  assert.deepEqual(
    store.getTimeSessions(state, { from: '2026-05-28T00:00:00.000Z', to: '2026-05-28T23:59:59.000Z' }).map((session) => session.taskKey),
    ['Tasks.md:Focus'],
  );
});
