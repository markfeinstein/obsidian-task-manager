import test from 'node:test';
import assert from 'node:assert/strict';
import { StateStore, type PersistedState } from '../src/state-store';
import { DEFAULT_SETTINGS, normalizeTaskManagerSettings } from '../src/types';

function initialState(): PersistedState {
  return { version: 1, snapshot: [], completions: [] };
}

function makePlugin(initialData: Record<string, unknown> = {}) {
  let stored: Record<string, unknown> = structuredClone(initialData);
  let saves = 0;
  return {
    loadData: async () => structuredClone(stored),
    saveData: async (data: unknown) => {
      // Yield on every save so concurrently-started transactions deterministically
      // overlap at the caller while StateStore must still serialize the commits.
      await Promise.resolve();
      stored = structuredClone(data as Record<string, unknown>);
      saves += 1;
    },
    getStored: () => structuredClone(stored),
    getSaveCount: () => saves,
  };
}

test('state-store cancellation predicate skips a queued commit after lifecycle end', async () => {
  let resolveLoad: (value: unknown) => void = () => undefined;
  const load = new Promise<unknown>((resolve) => { resolveLoad = resolve; });
  let saves = 0;
  let active = true;
  const store = new StateStore({
    loadData: async () => load,
    saveData: async () => { saves += 1; },
  } as never);

  const update = store.updateState(
    (current) => ({ ...current, recurrenceCounts: { blocked: 1 } }),
    { shouldCommit: () => active },
  );
  active = false;
  resolveLoad({ state: initialState() });
  const result = await update;

  assert.equal(saves, 0);
  assert.deepEqual(result.recurrenceCounts, {});
});

test('state-store settings predicate skips a stale queued commit', async () => {
  let resolveLoad: (value: unknown) => void = () => undefined;
  const load = new Promise<unknown>((resolve) => { resolveLoad = resolve; });
  let saves = 0;
  let active = true;
  const store = new StateStore({
    loadData: async () => load,
    saveData: async () => { saves += 1; },
  } as never);

  const save = store.saveSettings({ ...DEFAULT_SETTINGS, syncLastSuccessCalDAV: 'stale' }, () => active);
  active = false;
  resolveLoad({ state: initialState() });

  assert.equal(await save, false);
  assert.equal(saves, 0);
});

test('state-store rejected queued settings save leaves SecretStorage unchanged', async () => {
  let releaseLoad!: (value: unknown) => void;
  const load = new Promise<unknown>((resolve) => { releaseLoad = resolve; });
  const secrets = new Map<string, string>([
    ['obsidian-task-manager-google-tasks-access-token', 'old-access'],
    ['obsidian-task-manager-google-tasks-refresh-token', 'old-refresh'],
  ]);
  let active = true;
  const store = new StateStore({
    app: { secretStorage: {
      getSecret: (id: string) => secrets.get(id) ?? null,
      setSecret: (id: string, value: string) => { secrets.set(id, value); },
    } },
    loadData: async () => load,
    saveData: async () => assert.fail('stale settings must not save plugin data'),
  } as never);
  const settings = normalizeTaskManagerSettings({ googleTasksAccessToken: 'new-access', googleTasksRefreshToken: 'new-refresh' });
  const pending = store.saveSettings(settings, () => active);
  active = false;
  releaseLoad({});

  assert.equal(await pending, false);
  assert.equal(secrets.get('obsidian-task-manager-google-tasks-access-token'), 'old-access');
  assert.equal(secrets.get('obsidian-task-manager-google-tasks-refresh-token'), 'old-refresh');
});

test('state-store restores SecretStorage when lifecycle ends during plugin-data save', async () => {
  const secrets = new Map<string, string>([
    ['obsidian-task-manager-google-tasks-access-token', 'old-access'],
    ['obsidian-task-manager-google-tasks-refresh-token', 'old-refresh'],
  ]);
  let active = true;
  const store = new StateStore({
    app: { secretStorage: {
      getSecret: (id: string) => secrets.get(id) ?? null,
      setSecret: (id: string, value: string) => { secrets.set(id, value); },
    } },
    loadData: async () => ({}),
    saveData: async () => { active = false; },
  } as never);
  const committed = await store.saveSettings(normalizeTaskManagerSettings({
    googleTasksAccessToken: 'new-access',
    googleTasksRefreshToken: 'new-refresh',
  }), () => active);

  assert.equal(committed, false);
  assert.equal(secrets.get('obsidian-task-manager-google-tasks-access-token'), 'old-access');
  assert.equal(secrets.get('obsidian-task-manager-google-tasks-refresh-token'), 'old-refresh');
});

test('state-store atomic updates preserve two same-slice habit writes from the same initial read', async () => {
  const plugin = makePlugin({ state: initialState(), settings: { marker: 'keep' }, futurePluginKey: { keep: true } });
  const store = new StateStore(plugin as never);
  const [firstInitial, secondInitial] = await Promise.all([store.loadState(), store.loadState()]);
  assert.deepEqual(firstInitial, secondInitial);

  const [firstCommit, secondCommit] = await Promise.all([
    store.updateState((current) => store.addHabitCompletion(current, 'habit-a', '2026-07-10')),
    store.updateState((current) => store.addHabitCompletion(current, 'habit-b', '2026-07-11')),
  ]);

  assert.deepEqual(firstCommit.habitCompletions, { 'habit-a': ['2026-07-10'] });
  assert.deepEqual(secondCommit.habitCompletions, {
    'habit-a': ['2026-07-10'],
    'habit-b': ['2026-07-11'],
  });
  assert.deepEqual((plugin.getStored().state as PersistedState).habitCompletions, secondCommit.habitCompletions);
  assert.deepEqual(plugin.getStored().settings, { marker: 'keep' });
  assert.deepEqual(plugin.getStored().futurePluginKey, { keep: true });
});

test('state-store serializes atomic state and settings cross-writes without clobbering plugin data', async () => {
  const plugin = makePlugin({ state: initialState(), extensionData: { preserved: true } });
  const store = new StateStore(plugin as never);

  await Promise.all([
    store.updateState((current) => store.incrementRecurrenceCount(current, 'recurring-task')),
    store.saveSettings({ ...DEFAULT_SETTINGS, logSectionHeading: 'Atomic log' }),
  ]);

  const stored = plugin.getStored();
  assert.equal(((stored.state as PersistedState).recurrenceCounts ?? {})['recurring-task'], 1);
  assert.equal((stored.settings as { logSectionHeading?: string }).logSectionHeading, 'Atomic log');
  assert.deepEqual(stored.extensionData, { preserved: true });
});

test('state-store atomic updates preserve same-slice recurrence entries and cross-slice writes', async () => {
  const plugin = makePlugin({ state: initialState() });
  const store = new StateStore(plugin as never);

  await Promise.all([
    store.updateState((current) => store.addRecurrenceOccurrence(current, {
      seriesId: 'series-a', date: '2026-07-10', taskKey: 'task-a', completedAtIso: '2026-07-10T09:00:00.000Z',
    })),
    store.updateState((current) => store.addRecurrenceOccurrence(current, {
      seriesId: 'series-b', date: '2026-07-11', taskKey: 'task-b', completedAtIso: '2026-07-11T09:00:00.000Z',
    })),
    store.updateState((current) => store.addHabitCompletion(current, 'habit-c', '2026-07-11')),
  ]);

  const committed = await store.loadState();
  assert.deepEqual(Object.keys(committed.recurrenceOccurrences ?? {}).sort(), ['series-a', 'series-b']);
  assert.deepEqual(committed.habitCompletions, { 'habit-c': ['2026-07-11'] });
});

test('state-store transform failures do not save and leave the queue usable', async () => {
  const plugin = makePlugin({ state: initialState() });
  const store = new StateStore(plugin as never);

  await assert.rejects(
    store.updateState(() => { throw new Error('transform failed'); }),
    /transform failed/u,
  );
  await assert.rejects(
    store.updateState((() => Promise.reject(new Error('async transform failed'))) as unknown as (state: PersistedState) => PersistedState),
    /must be synchronous/u,
  );
  assert.equal(plugin.getSaveCount(), 0);
  assert.deepEqual(plugin.getStored(), { state: initialState() });

  const committed = await store.updateState((current) => store.addHabitCompletion(current, 'after-failure', '2026-07-11'));
  assert.deepEqual(committed.habitCompletions, { 'after-failure': ['2026-07-11'] });
  assert.equal(plugin.getSaveCount(), 1);
});

test('state-store recovers its write queue after saveData rejects', async () => {
  let stored: Record<string, unknown> = { state: initialState() };
  let saveAttempts = 0;
  const store = new StateStore({
    loadData: async () => structuredClone(stored),
    saveData: async (data: unknown) => {
      saveAttempts += 1;
      if (saveAttempts === 1) throw new Error('disk unavailable');
      stored = structuredClone(data as Record<string, unknown>);
    },
  } as never);

  await assert.rejects(
    store.updateState((current) => store.addHabitCompletion(current, 'lost', '2026-07-11')),
    /disk unavailable/u,
  );
  assert.deepEqual(stored, { state: initialState() });

  const committed = await store.updateState((current) => store.addHabitCompletion(current, 'saved', '2026-07-11'));
  assert.deepEqual(committed.habitCompletions, { saved: ['2026-07-11'] });
  assert.equal(saveAttempts, 2);
});

test('state-store rejects nested write transactions without deadlocking the queue', async () => {
  const plugin = makePlugin({ state: initialState() });
  const store = new StateStore(plugin as never);

  await assert.rejects(store.updateState((current) => {
    void store.updateState((nested) => nested);
    return current;
  }), /cannot be nested/u);

  const committed = await store.updateState((current) => store.incrementRecurrenceCount(current, 'task-a'));
  assert.equal(committed.recurrenceCounts?.['task-a'], 1);
});
