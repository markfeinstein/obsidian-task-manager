import test from 'node:test';
import assert from 'node:assert/strict';
import type { PersistedState } from '../src/state-store';
import { StateStore } from '../src/state-store';

function createMockState(): PersistedState {
  return {
    version: 1,
    snapshot: [],
    completions: [],
    recurrenceCounts: {},
    fileHashes: {},
    scanMetrics: {
      totalTasksScanned: 0,
      scanDurationMs: 0,
      lastScanTimeIso: new Date(0).toISOString(),
    },
  };
}

function createStateStore(): StateStore {
  return new StateStore({
    loadData: async () => ({ state: createMockState() }),
    saveData: async () => undefined,
  } as never);
}

test('Day Planner: should calculate elapsed minutes correctly', () => {
  const stateStore = createStateStore();
  const state = stateStore.setClockIn(createMockState(), 'task-key', 'file.md', 5);
  const clockInState = state.clockInState;
  assert.ok(clockInState);
  const clockedInState: PersistedState = {
    ...state,
    clockInState: {
      ...clockInState,
      clockInTimeIso: '2024-01-01T10:00:00Z',
    },
  };

  const mockNow = Date.now;
  Date.now = () => new Date('2024-01-01T10:30:00Z').getTime();

  try {
    const result = stateStore.clearClockIn(clockedInState);
    assert.equal(result.elapsedMinutes, 30);
    assert.equal(stateStore.getClockInState(result.state), undefined);
  } finally {
    Date.now = mockNow;
  }
});

test('Day Planner: should handle zero elapsed time', () => {
  const stateStore = createStateStore();
  const state = stateStore.setClockIn(createMockState(), 'task-key', 'file.md', 5);
  const result = stateStore.clearClockIn(state);

  assert.ok(result.elapsedMinutes >= 0);
  assert.equal(stateStore.getClockInState(result.state), undefined);
});

test('Day Planner: should ignore malformed clock-in timestamps', () => {
  const stateStore = createStateStore();
  const result = stateStore.clearClockIn({
    ...createMockState(),
    clockInState: {
      taskKey: 'task-key',
      taskFilePath: 'file.md',
      taskLineNumber: 5,
      clockInTimeIso: 'not-a-date',
    },
  });

  assert.equal(result.elapsedMinutes, 0);
  assert.equal(stateStore.getClockInState(result.state), undefined);
});

test('Day Planner: should clear clock-in state after clock-out', () => {
  const stateStore = createStateStore();
  const state = stateStore.setClockIn(createMockState(), 'task-key', 'file.md', 5);

  assert.deepEqual(stateStore.getClockInState(state), state.clockInState);

  const result = stateStore.clearClockIn(state);
  assert.equal(stateStore.getClockInState(result.state), undefined);
});

test('Day Planner: should track only one task clocked in at a time', () => {
  const stateStore = createStateStore();
  let state = stateStore.setClockIn(createMockState(), 'task-1', 'file.md', 5);

  assert.equal(stateStore.getClockInState(state)?.taskKey, 'task-1');

  state = stateStore.setClockIn(state, 'task-2', 'other.md', 10);
  assert.deepEqual(stateStore.getClockInState(state), {
    taskKey: 'task-2',
    taskFilePath: 'other.md',
    taskLineNumber: 10,
    clockInTimeIso: state.clockInState?.clockInTimeIso,
  });
});

test('Day Planner: should return undefined and require refresh for non-cached URLs', () => {
  const stateStore = createStateStore();
  const state = createMockState();

  assert.equal(stateStore.getIcsCache(state, 'https://nonexistent.com/calendar.ics'), undefined);
  assert.equal(stateStore.needsIcsCacheRefresh(state, 'https://nonexistent.com/calendar.ics', 30), true);
});

test('Day Planner: ICS cache stores, isolates, and refreshes events by URL', () => {
  const stateStore = createStateStore();
  const url = 'https://example.com/calendar.ics';
  const otherUrl = 'https://example.com/other.ics';
  const events = [
    { summary: 'Planning', date: '2026-06-19', startTime: '09:00', endTime: '09:30', uid: 'event-1' },
    { summary: 'Undated reminder', date: null, uid: null },
  ];

  const state = stateStore.setIcsCache(createMockState(), url, events);

  assert.deepEqual(stateStore.getIcsCache(state, url)?.events, events);
  assert.equal(stateStore.getIcsCache(state, otherUrl), undefined);
  assert.equal(stateStore.needsIcsCacheRefresh(state, url, 60), false);

  const cached = stateStore.getIcsCache(state, url);
  assert.ok(cached);
  const staleState: PersistedState = {
    ...state,
    icsCache: {
      ...state.icsCache,
      [url]: {
        ...cached,
        lastFetchIso: '2026-06-19T10:00:00Z',
      },
    },
  };
  const mockNow = Date.now;
  Date.now = () => new Date('2026-06-19T11:01:00Z').getTime();

  try {
    assert.equal(stateStore.needsIcsCacheRefresh(staleState, url, 60), true);
  } finally {
    Date.now = mockNow;
  }
});
