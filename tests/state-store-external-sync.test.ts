/**
 * StateStore.getExternalSyncIds / setExternalSyncIds
 *
 * Regression for the bug where Google Tasks and Microsoft Todo sync called
 * plugin.loadData() + plugin.saveData({ ...pluginData, key: value }) directly,
 * which could overwrite concurrent StateStore writes (settings saves, task
 * completions recorded during the async network calls) with stale data.
 *
 * The fix routes these writes through the StateStore writeQueue via
 * setExternalSyncIds so that only the target key is updated.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { StateStore } from '../src/state-store';

function makePlugin(initialData: Record<string, unknown> = {}) {
  let stored: Record<string, unknown> = { ...initialData };
  return {
    loadData: async () => ({ ...stored }),
    saveData: async (data: unknown) => {
      stored = data as Record<string, unknown>;
    },
    getStored: () => stored,
  };
}

test('getExternalSyncIds returns empty array when key absent', async () => {
  const plugin = makePlugin({});
  const store = new StateStore(plugin as never);
  const ids = await store.getExternalSyncIds('googleTasksSyncedIds');
  assert.deepEqual(ids, []);
});

test('getExternalSyncIds returns existing array', async () => {
  const plugin = makePlugin({ googleTasksSyncedIds: ['id1', 'id2'] });
  const store = new StateStore(plugin as never);
  const ids = await store.getExternalSyncIds('googleTasksSyncedIds');
  assert.deepEqual(ids, ['id1', 'id2']);
});

test('setExternalSyncIds stores ids under the given key', async () => {
  const plugin = makePlugin({});
  const store = new StateStore(plugin as never);
  await store.setExternalSyncIds('googleTasksSyncedIds', ['a', 'b', 'c']);
  assert.deepEqual(plugin.getStored().googleTasksSyncedIds, ['a', 'b', 'c']);
});

test('setExternalSyncIds preserves other keys (no stale-spread clobber)', async () => {
  // Simulate the state that StateStore wrote during the async sync operation:
  // settings and task state exist alongside the sync IDs.
  const plugin = makePlugin({
    settings: { someKey: 'value' },
    state: { version: 1, completions: [{ taskKey: 'task1' }] },
    googleTasksSyncedIds: ['old-id'],
  });
  const store = new StateStore(plugin as never);

  // setExternalSyncIds should merge, not overwrite
  await store.setExternalSyncIds('googleTasksSyncedIds', ['old-id', 'new-id']);

  const stored = plugin.getStored();
  // Settings and state must be preserved
  assert.deepEqual(stored.settings, { someKey: 'value' });
  assert.deepEqual(stored.state, { version: 1, completions: [{ taskKey: 'task1' }] });
  // New IDs are written
  assert.deepEqual(stored.googleTasksSyncedIds, ['old-id', 'new-id']);
});

test('setExternalSyncIds msToDoSyncedIds preserves googleTasksSyncedIds', async () => {
  const plugin = makePlugin({
    googleTasksSyncedIds: ['g1', 'g2'],
    msToDoSyncedIds: [],
  });
  const store = new StateStore(plugin as never);

  await store.setExternalSyncIds('msToDoSyncedIds', ['m1']);

  const stored = plugin.getStored();
  assert.deepEqual(stored.googleTasksSyncedIds, ['g1', 'g2'], 'Google IDs must not be clobbered');
  assert.deepEqual(stored.msToDoSyncedIds, ['m1']);
});

test('state v1 identity migration creates no trusted baseline and malformed v2 evidence stays fail-closed', async () => {
  const plugin = makePlugin({
    state: {
      version: 1,
      identityState: {
        version: 1,
        identities: [{
          vaultKey: 'id:google-tasks:g1', externalIds: { 'google-tasks': 'g1' },
          lastSyncedHash: 'legacy-only', createdAt: 1, updatedAt: 1,
        }, {
          vaultKey: 'id:ms-todo:m1', externalIds: { 'microsoft-todo': 'm1' },
          baselines: { 'microsoft-todo': { schemaVersion: 1, projection: { title: undefined }, recordedAt: 1 } },
          createdAt: 1, updatedAt: 1,
        }],
      },
    },
  });
  const store = new StateStore(plugin as never);
  const loaded = await store.loadState();
  assert.equal(loaded.identityState?.version, 2);
  assert.equal(loaded.identityState?.identities[0]?.baselines, undefined);
  assert.deepEqual(loaded.identityState?.identities[1]?.invalidBaselines, ['microsoft-todo']);
});

test('malformed persisted reconciliation evidence is normalized to a non-executable conflict', async () => {
  const plugin = makePlugin({
    state: {
      version: 1,
      syncQueueState: {
        version: 1,
        completed: [],
        operations: [{
          id: 'op-1', type: 'update', service: 'google-tasks', externalId: 'g1',
          vaultTask: { key: 'id:google-tasks:g1' }, payload: { title: 'stale' },
          queuedAt: 1, status: 'queued', reconciliation: { schemaVersion: 1, local: { title: undefined } },
        }],
      },
    },
  });
  const loaded = await new StateStore(plugin as never).loadState();
  const operation = loaded.syncQueueState?.operations[0];
  assert.equal(operation?.status, 'conflict');
  assert.deepEqual(operation?.payload, {});
  assert.match(operation?.error ?? '', /Malformed reconciliation evidence/u);
});

test('updateExternalSyncIds serializes overlapping updates to the same key', async () => {
  const plugin = makePlugin({ googleTasksSyncedIds: ['existing'] });
  const store = new StateStore(plugin as never);

  await Promise.all([
    store.updateExternalSyncIds('googleTasksSyncedIds', (current) => [...current, 'first']),
    store.updateExternalSyncIds('googleTasksSyncedIds', (current) => [...current, 'second']),
  ]);

  assert.deepEqual(plugin.getStored().googleTasksSyncedIds, ['existing', 'first', 'second']);
});
