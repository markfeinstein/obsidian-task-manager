import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CURRENT_STATE_SLICE_VERSIONS,
  STATE_SLICE_CONTRACT,
  StateStore,
} from '../src/state-store';

function storeWith(state: unknown): StateStore {
  return new StateStore({
    loadData: async () => ({ state }),
    saveData: async () => undefined,
  } as never);
}

test('state slice contract assigns every aggregate field to one explicit owner', () => {
  const fields = Object.values(STATE_SLICE_CONTRACT).flatMap((slice) => slice.fields).sort();
  assert.deepEqual(fields, [
    'clockInState',
    'completions',
    'fileHashes',
    'firedReminderKeys',
    'habitCompletions',
    'icsCache',
    'identityMigration',
    'identityState',
    'missedReminders',
    'queuedNotifications',
    'recurrenceCounts',
    'recurrenceExceptions',
    'recurrenceOccurrences',
    'scanMetrics',
    'snapshot',
    'snoozedReminders',
    'syncQueueState',
    'taskLifecycleTransferJournals',
    'taskMoveJournals',
    'timeSessionLog',
  ]);
  assert.equal(new Set(fields).size, fields.length);
  for (const contract of Object.values(STATE_SLICE_CONTRACT)) {
    assert.equal(contract.owner.trim().length > 0, true);
    assert.equal(Number.isSafeInteger(contract.version) && contract.version >= 1, true);
  }
});

test('legacy aggregate state is normalized to current independent slice versions', async () => {
  const state = await storeWith({ version: 1, snapshot: [], completions: [], recurrenceCounts: {} }).loadState();
  assert.deepEqual(state.sliceVersions, CURRENT_STATE_SLICE_VERSIONS);
});

test('older slice versions migrate conservatively while future versions fail closed', async () => {
  const migrated = await storeWith({
    version: 2,
    sliceVersions: { ...CURRENT_STATE_SLICE_VERSIONS, identity: 1, sync: 1 },
    snapshot: [],
    completions: [],
    recurrenceCounts: {},
  }).loadState();
  assert.deepEqual(migrated.sliceVersions, CURRENT_STATE_SLICE_VERSIONS);

  await assert.rejects(
    storeWith({
      version: 2,
      sliceVersions: { ...CURRENT_STATE_SLICE_VERSIONS, moves: CURRENT_STATE_SLICE_VERSIONS.moves + 1 },
      snapshot: [],
      completions: [],
      recurrenceCounts: {},
    }).loadState(),
    /moves state slice version .* newer than supported/u,
  );
});
