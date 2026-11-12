import assert from 'node:assert/strict';
import test from 'node:test';
import { migrateExplicitIdentityState, type PersistedStateWithIdentityMigration } from '../src/task-identity-state';
import { parseMarkdownTaskLine } from '../src/task-model';
import { IdentityMapper } from '../src/sync-identity-mapper';
import { StateStore } from '../src/state-store';
import { TaskIndex } from '../src/task-index';
import TaskManagerPlugin from '../src/main';

function explicitTask(id: string, path = 'Now.md', line = 1) {
  const task = parseMarkdownTaskLine(`- [ ] Task 🆔 ${id}`, path, line);
  assert.ok(task);
  return task;
}

function baseState(overrides: Partial<PersistedStateWithIdentityMigration> = {}): PersistedStateWithIdentityMigration {
  return { version: 1, snapshot: [], completions: [], ...overrides };
}

test('v1 explicit-ID migration covers safely identifiable key-bearing slices and reverse lookup', () => {
  const task = explicitTask('Case-Sensitive');
  const old = 'Old/Task.md:id:Case-Sensitive';
  const state = baseState({
    snapshot: [{ key: old, status: 'todo', filePath: 'Old/Task.md', lineNumber: 8 }],
    completions: [{ taskKey: old, sourcePath: 'Old/Task.md', dailyNotePath: 'Daily.md', completedAtIso: '2026-01-01T00:00:00.000Z', logLineHash: 'hash' }],
    recurrenceCounts: { [old]: 3 },
    habitCompletions: { [old]: ['2026-01-02'], 'id:Case-Sensitive': ['2026-01-03'] },
    recurrenceOccurrences: { series: [{ seriesId: 'series', date: '2026-01-02', taskKey: old }] },
    timeSessionLog: [{ taskKey: old, taskFilePath: 'Old/Task.md', taskLineNumber: 8, taskText: 'Task', startedAtIso: '2026-01-02T10:00:00.000Z', endedAtIso: '2026-01-02T10:30:00.000Z', elapsedMinutes: 30, source: 'clock' }],
    clockInState: { taskKey: old, taskFilePath: 'Old/Task.md', taskLineNumber: 8, clockInTimeIso: '2026-01-02T10:00:00.000Z' },
    snoozedReminders: [{ reminderKey: `${old}\0reminder`, taskFilePath: 'Old/Task.md', taskLineNumber: 8, taskText: 'Task', originalReminderTime: '2026-01-02 10:00', nextFireTime: '2026-01-02 10:05', snoozedAtIso: '2026-01-02T10:00:00.000Z' }],
    missedReminders: [],
    queuedNotifications: [],
    firedReminderKeys: [`2026-01-02T10:00:00.000Z\0${old}\0reminder`],
    identityState: { version: 1, identities: [{ vaultKey: old, externalIds: { todoist: 'external-1' }, createdAt: 1, updatedAt: 2 }] },
    syncQueueState: {
      version: 1,
      operations: [{ id: 'op', type: 'update', service: 'todoist', vaultTask: { ...task, key: old, stableKey: old }, payload: {}, queuedAt: 1, status: 'queued' }],
      completed: [],
    },
  });

  const migrated = migrateExplicitIdentityState(state, [task]);
  assert.equal(migrated.version, 2);
  assert.equal(migrated.identityMigration?.version, 2);
  assert.equal(migrated.identityMigration?.completed, true);
  assert.equal(migrated.snapshot[0].key, 'id:Case-Sensitive');
  assert.equal(migrated.snapshot[0].filePath, 'Old/Task.md', 'historical paths are retained');
  assert.equal(migrated.snapshot[0].lineNumber, 8, 'historical lines are retained');
  assert.equal(migrated.completions[0].taskKey, 'id:Case-Sensitive');
  assert.deepEqual(migrated.recurrenceCounts, { 'id:Case-Sensitive': 3 });
  assert.deepEqual(migrated.habitCompletions, { 'id:Case-Sensitive': ['2026-01-02', '2026-01-03'] });
  assert.equal(migrated.recurrenceOccurrences?.series[0].taskKey, 'id:Case-Sensitive');
  assert.equal(migrated.recurrenceOccurrences?.series[0].seriesId, 'series', 'authored recurrence series IDs are not rewritten');
  assert.equal(migrated.timeSessionLog?.[0].taskKey, 'id:Case-Sensitive');
  assert.equal(migrated.clockInState?.taskKey, 'id:Case-Sensitive');
  assert.equal(migrated.snoozedReminders?.[0].reminderKey, 'id:Case-Sensitive\0reminder');
  assert.equal(migrated.firedReminderKeys?.[0], '2026-01-02T10:00:00.000Z\0id:Case-Sensitive\0reminder');
  assert.equal(migrated.syncQueueState?.operations[0].vaultTask.key, 'id:Case-Sensitive');
  assert.equal(migrated.syncQueueState?.operations[0].vaultTask.stableKey, 'id:Case-Sensitive');

  const mapper = new IdentityMapper(migrated.identityState);
  assert.equal(mapper.lookupByExternalId('todoist', 'external-1'), 'id:Case-Sensitive');
  assert.equal(migrateExplicitIdentityState(migrated, [task]), migrated, 'completed migration is restart-idempotent');
});

test('hydrated migration refreshes snapshot, completion, recurrence, identity, and queue projections', async () => {
  const task = explicitTask('projection');
  const old = 'Old.md:id:projection';
  let data: unknown = { state: baseState({
    snapshot: [{ key: old, status: 'todo', filePath: 'Old.md', lineNumber: 3 }],
    completions: [{ taskKey: old, sourcePath: 'Old.md', dailyNotePath: 'Daily.md', completedAtIso: '2026-01-01T00:00:00.000Z', logLineHash: 'hash' }],
    recurrenceCounts: { [old]: 2 },
    identityState: { version: 1, identities: [{ vaultKey: old, externalIds: { todoist: 'remote' }, createdAt: 1, updatedAt: 1 }] },
    syncQueueState: { version: 1, operations: [{ id: 'op', type: 'update', service: 'todoist', vaultTask: { ...task, key: old, stableKey: old }, payload: {}, queuedAt: 1, status: 'queued' }], completed: [] },
  }) };
  // Focused harness intentionally exercises private hydration projections.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const plugin = Object.create(TaskManagerPlugin.prototype) as any;
  plugin.stateStore = new StateStore({
    loadData: async () => structuredClone(data),
    saveData: async (next: unknown) => { data = structuredClone(next); },
  } as never);
  plugin.taskIndex = new TaskIndex();
  plugin.taskIndex.commit(new Map([[task.filePath, [task]]]));
  plugin.snapshot = new Map();
  plugin.completions = [];
  plugin.recurrenceCounts = {};
  plugin.pendingCompletionKeyMigrations = new Map();
  plugin.pendingRecurrenceCountMigrations = new Map();
  plugin.firedReminders = new Set();

  await plugin.migrateHydratedExplicitIdentityState();
  assert.equal(plugin.snapshot.get('id:projection')?.status, task.status);
  assert.equal(plugin.completions[0].taskKey, 'id:projection');
  assert.deepEqual(plugin.recurrenceCounts, { 'id:projection': 2 });
  assert.equal(plugin.identityMapper.lookupByExternalId('todoist', 'remote'), 'id:projection');
  assert.equal(plugin.syncOperationQueue.getState().operations[0].vaultTask.key, 'id:projection');
});

test('single-valued alias conflicts are preserved and durably recorded', () => {
  const task = explicitTask('same');
  const first = 'A.md:id:same';
  const second = 'B.md:id:same';
  const state = baseState({
    snapshot: [
      { key: first, status: 'todo', filePath: 'A.md', lineNumber: 1 },
      { key: second, status: 'done', filePath: 'B.md', lineNumber: 2 },
    ],
    recurrenceCounts: { [first]: 2, [second]: 9 },
    identityState: {
      version: 1,
      identities: [
        { vaultKey: first, externalIds: { todoist: 'one' }, createdAt: 1, updatedAt: 1 },
        { vaultKey: second, externalIds: { todoist: 'two' }, createdAt: 2, updatedAt: 2 },
      ],
    },
  });

  const migrated = migrateExplicitIdentityState(state, [task]);
  assert.deepEqual(migrated.snapshot.map((entry) => entry.key), [first, second]);
  assert.deepEqual(migrated.recurrenceCounts, { [first]: 2, [second]: 9 });
  assert.deepEqual(migrated.identityState?.identities.map((identity) => identity.vaultKey), [first, second]);
  assert.ok(migrated.identityMigration?.conflicts.some((conflict) => conflict.slice === 'snapshot' && conflict.reason === 'multiple-legacy-aliases'));
  assert.ok(migrated.identityMigration?.conflicts.some((conflict) => conflict.slice === 'recurrenceCounts'));
  assert.ok(migrated.identityMigration?.conflicts.some((conflict) => conflict.slice === 'identityState'));
});

test('StateStore normalizes historical v1 input and preserves v2 migration conflicts', async () => {
  let data: unknown = { state: { version: 1, snapshot: [], completions: [] } };
  const store = new StateStore({
    loadData: async () => structuredClone(data),
    saveData: async (next: unknown) => { data = structuredClone(next); },
  } as never);
  const task = explicitTask('one');
  const committed = await store.updateState((current) => migrateExplicitIdentityState(current, [task]));
  assert.equal(committed.version, 2);
  assert.deepEqual(committed.identityMigration, { version: 2, completed: true, conflicts: [] });
  assert.deepEqual((await store.loadState()).identityMigration, { version: 2, completed: true, conflicts: [] });
});

test('overlapping legal ID suffixes remain pending instead of falsely completing migration', () => {
  const short = explicitTask('b', 'Short.md', 1);
  const long = explicitTask('id:b', 'Long.md', 1);
  const ambiguousLegacyKey = 'Old.md:id:id:b';
  const migrated = migrateExplicitIdentityState(baseState({
    snapshot: [{ key: ambiguousLegacyKey, status: 'todo', filePath: 'Old.md', lineNumber: 1 }],
  }), [short, long]);
  assert.equal(migrated.snapshot[0].key, ambiguousLegacyKey);
  assert.equal(migrated.identityMigration?.completed, false);
  assert.ok(migrated.identityMigration?.conflicts.some((conflict) => conflict.slice === 'legacy-key' && conflict.aliases.includes(ambiguousLegacyKey)));
});

test('duplicate current IDs produce order-independent durable conflicts and migrate nothing', () => {
  const first = explicitTask('duplicate', 'Z.md', 9);
  const second = explicitTask('duplicate', 'A.md', 1);
  const old = 'Old.md:id:duplicate';
  const state = baseState({
    snapshot: [{ key: old, status: 'todo', filePath: 'Old.md', lineNumber: 3 }],
    recurrenceCounts: { [old]: 4 },
  });

  const forward = migrateExplicitIdentityState(state, [first, second]);
  const reverse = migrateExplicitIdentityState(state, [second, first]);
  assert.deepEqual(forward, reverse);
  assert.equal(forward.snapshot[0].key, old);
  assert.deepEqual(forward.recurrenceCounts, { [old]: 4 });
  assert.equal(forward.identityMigration?.completed, false);
  assert.deepEqual(forward.identityMigration?.conflicts, [{
    id: 'duplicate',
    slice: 'task-index',
    aliases: ['A.md:1', 'Z.md:9'],
    reason: 'duplicate-current-id',
  }]);

  const resolved = migrateExplicitIdentityState(forward, [first]);
  assert.equal(resolved.identityMigration?.completed, true);
  assert.deepEqual(resolved.identityMigration?.conflicts, []);
  assert.equal(resolved.snapshot[0].key, 'id:duplicate');
  assert.deepEqual(resolved.recurrenceCounts, { 'id:duplicate': 4 });
});
