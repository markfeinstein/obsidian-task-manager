import test from 'node:test';
import assert from 'node:assert/strict';
import { TFile } from 'obsidian';
import TaskManagerPlugin from '../src/main';
import { StateStore, type PersistedState, type TimeSessionRecord } from '../src/state-store';
import type { ParsedTask } from '../src/task-scanner';
import { detectCompletionTasks, detectHabitCompletionTasks, type TaskSnapshotEntry } from '../src/completion-detector';
import { taskIsHabit } from '../src/habit-tracker';
import { rewriteActualTimeField } from '../src/task-mutation-service';

function emptyState(overrides: Partial<PersistedState> = {}): PersistedState {
  return {
    version: 1,
    snapshot: [],
    completions: [],
    recurrenceCounts: {},
    fileHashes: {},
    timeSessionLog: [],
    ...overrides,
  };
}

function session(overrides: Partial<TimeSessionRecord> = {}): TimeSessionRecord {
  return {
    taskKey: 'Tasks.md:Write',
    taskFilePath: 'Tasks.md',
    taskLineNumber: 1,
    taskText: 'Write',
    startedAtIso: '2026-05-28T09:00:00.000Z',
    endedAtIso: '2026-05-28T09:25:00.000Z',
    elapsedMinutes: 25,
    source: 'clock',
    ...overrides,
  };
}

function task(): ParsedTask {
  return {
    key: 'Tasks.md:Write',
    filePath: 'Tasks.md',
    lineNumber: 1,
    rawLine: '- [ ] Write',
    linePrefix: '',
    indentation: '',
    listMarker: '-',
    checkbox: ' ',
    body: 'Write',
    normalizedText: 'Write',
    status: 'todo',
    tags: [],
    contexts: [],
    metadata: { dates: {}, invalidDates: {}, dependsOn: [], priority: 'normal' },
  } as ParsedTask;
}

test('time sessions: StateStore appends, prunes, and filters sessions', () => {
  const store = new StateStore({ loadData: async () => ({}), saveData: async () => {} } as never);
  const old = session({ endedAtIso: '2026-01-01T00:00:00.000Z', startedAtIso: '2026-01-01T00:00:00.000Z' });
  const recent = session({ endedAtIso: '2026-05-28T09:25:00.000Z' });
  const state = store.appendTimeSession(emptyState({ timeSessionLog: [old] }), recent, 90, Date.parse('2026-05-28T10:00:00.000Z'));

  const pruned = store.pruneTimeSessions(state.timeSessionLog ?? [], 90, Date.parse('2026-05-28T10:00:00.000Z'));
  assert.deepEqual(pruned.map((entry) => entry.endedAtIso), ['2026-05-28T09:25:00.000Z']);

  const filtered = store.getTimeSessions({ ...state, timeSessionLog: pruned }, { from: '2026-05-28T00:00:00.000Z', to: '2026-05-28T23:59:59.000Z' });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].elapsedMinutes, 25);
});

test('time session retention has an explicit inclusive cutoff independent of the host clock', () => {
  const store = new StateStore({ loadData: async () => ({}), saveData: async () => {} } as never);
  const now = Date.parse('2099-11-09T12:00:00Z');
  const cutoff = now - 90 * 86_400_000;
  const boundary = session({ endedAtIso: new Date(cutoff).toISOString() });
  const expired = session({ endedAtIso: new Date(cutoff - 1).toISOString() });
  const recent = session({ endedAtIso: new Date(now).toISOString() });
  const result = store.appendTimeSession(emptyState({ timeSessionLog: [expired, boundary] }), recent, 90, now);
  assert.deepEqual(result.timeSessionLog, [boundary, recent]);
  assert.equal(store.appendTimeSession(emptyState({ timeSessionLog: [expired] }), recent, 0, now).timeSessionLog?.length, 2);
});

test('time sessions: clock-out records a durable session and updates actual time', async () => {
  const plugin = Object.create(TaskManagerPlugin.prototype) as any;
  const clockInTimeIso = new Date(Date.now() - 26 * 60_000).toISOString();
  let content = '- [ ] Write';
  let savedState: PersistedState | undefined;
  const store = new StateStore({ loadData: async () => ({}), saveData: async () => {} } as never);
  plugin.stateStore = {
    clearClockIn: store.clearClockIn.bind(store),
    appendTimeSession: store.appendTimeSession.bind(store),
    updateState: async (transform: (state: PersistedState) => PersistedState) => {
      savedState = transform(emptyState({ clockInState: { taskKey: 'Tasks.md:Write', taskFilePath: 'Tasks.md', taskLineNumber: 1, clockInTimeIso } }));
      return savedState;
    },
  };
  const sourceFile = Object.assign(Object.create(TFile.prototype) as TFile, { path: 'Tasks.md', extension: 'md' });
  plugin.app = { vault: { getAbstractFileByPath: () => sourceFile } };
  plugin.taskMutations = {
    updateTaskActualTime: async (_file: TFile, currentTask: ParsedTask, elapsed: number) => {
      content = rewriteActualTimeField(content, elapsed);
      return { ...currentTask, rawLine: content };
    },
  };

  await plugin.handleClockInOut(task(), false);

  assert.equal(savedState?.clockInState, undefined);
  assert.equal(savedState?.timeSessionLog?.length, 1);
  assert.equal(savedState?.timeSessionLog?.[0].source, 'clock');
  assert.match(content, /🕐 \d+m$/u);
});

test('time session remains durable when identity-safe writeback fails', async () => {
  const plugin = Object.create(TaskManagerPlugin.prototype) as unknown as {
    stateStore: {
      appendTimeSession: StateStore['appendTimeSession'];
      updateState(transform: (state: PersistedState) => PersistedState): Promise<PersistedState>;
    };
    app: { vault: { getAbstractFileByPath(): TFile } };
    taskMutations: { updateTaskActualTime(): Promise<ParsedTask> };
    recordFocusTime(task: ParsedTask, elapsedMs: number): Promise<void>;
  };
  const store = new StateStore({ loadData: async () => ({}), saveData: async () => undefined } as never);
  let saved = emptyState();
  plugin.stateStore = {
    appendTimeSession: store.appendTimeSession.bind(store),
    updateState: async (transform: (state: PersistedState) => PersistedState) => { saved = transform(saved); return saved; },
  };
  const sourceFile = Object.assign(Object.create(TFile.prototype) as TFile, { path: 'Tasks.md', extension: 'md' });
  plugin.app = { vault: { getAbstractFileByPath: () => sourceFile } };
  plugin.taskMutations = { updateTaskActualTime: async () => { throw new Error('ambiguous'); } };

  await plugin.recordFocusTime(task(), 60_000);
  assert.equal(saved.timeSessionLog?.length, 1);
  assert.equal(saved.timeSessionLog?.[0].source, 'focus-timer');
});

test('actual-time rewrite is narrow and preserves block links', () => {
  assert.equal(rewriteActualTimeField('- [ ] Task 🕐 1h 20m 📅 2026-07-12 ^task', 45), '- [ ] Task 🕐 2h 5m 📅 2026-07-12 ^task');
  assert.equal(rewriteActualTimeField('- [ ] Task ^task', 25), '- [ ] Task 🕐 25m ^task');
  assert.throws(() => rewriteActualTimeField('- [ ] Task 🕐 1h 🕐 20m', 5), /multiple actual-time fields/u);
});

test('habit completions: duplicate key shifts still record completion via line/group matching', async () => {
  const plugin = Object.create(TaskManagerPlugin.prototype) as any;
  const previous = new Map<string, TaskSnapshotEntry>([
    ['Habits.md:Drink water\u00001', { key: 'Habits.md:Drink water\u00001', status: 'todo', filePath: 'Habits.md', lineNumber: 2, sourceKind: 'line' }],
  ]);
  const completedHabit = {
    ...task(),
    key: 'Habits.md:Drink water\u00002',
    filePath: 'Habits.md',
    lineNumber: 2,
    body: 'Drink water',
    normalizedText: 'Drink water #habit',
    status: 'done',
    // Real parser (extractTags) stores tags WITHOUT the '#' prefix. Previously '#habit' was used
    // here which caused taskIsHabit() to fail the tag check and silently pass only via the
    // inHabitFile fallback ('Habits.md' contains 'habit'). Correct format is 'habit'.
    tags: ['habit'],
    metadata: { dates: { done: '2026-05-28' }, invalidDates: {}, dependsOn: [], priority: 'normal', recurrence: 'every day' },
  } as ParsedTask;
  const store = new StateStore({ loadData: async () => ({}), saveData: async () => {} } as never);
  let savedState: PersistedState | undefined;
  plugin.stateStore = {
    addHabitCompletion: store.addHabitCompletion.bind(store),
    updateState: async (transform: (state: PersistedState) => PersistedState) => {
      savedState = transform(emptyState({ habitCompletions: {} }));
      return savedState;
    },
  };

  const detected = detectCompletionTasks([completedHabit], previous);
  assert.equal(detected.length, 1);
  await plugin.recordHabitCompletionIfNeeded(detected[0]);

  assert.deepEqual(savedState?.habitCompletions?.['Habits.md:Drink water\u00002'], ['2026-05-28']);
});

test('habit completions: recurring expansion records same-line completed occurrence', async () => {
  const plugin = Object.create(TaskManagerPlugin.prototype) as any;
  // Use a non-habit file path ('Tasks.md') so that taskIsHabit() is forced to rely on
  // tag+recurrence detection, not the inHabitFile fallback. Tags must be stored WITHOUT '#'
  // (real extractTags output); previously '#habit' masked regression in tag detection.
  const previous = new Map<string, TaskSnapshotEntry>([
    ['Tasks.md:Meditate #habit', { key: 'Tasks.md:Meditate #habit', status: 'todo', filePath: 'Tasks.md', lineNumber: 1, sourceKind: 'line' }],
  ]);
  const completedOccurrence = {
    ...task(),
    key: 'Tasks.md:Meditate #habit',
    filePath: 'Tasks.md',
    lineNumber: 1,
    body: 'Meditate #habit',
    normalizedText: 'Meditate #habit',
    status: 'done',
    tags: ['habit'],
    metadata: { dates: { done: '2026-05-28' }, invalidDates: {}, dependsOn: [], priority: 'normal', recurrence: 'every day' },
  } as ParsedTask;
  const nextOccurrence = {
    ...completedOccurrence,
    key: 'Tasks.md:Meditate #habit\u00001',
    lineNumber: 2,
    rawLine: '- [ ] Meditate #habit 🔁 every day',
    status: 'todo',
    checkbox: ' ',
    metadata: { dates: {}, invalidDates: {}, dependsOn: [], priority: 'normal', recurrence: 'every day' },
  } as ParsedTask;
  const currentTasks = [completedOccurrence, nextOccurrence];

  assert.equal(detectCompletionTasks(currentTasks, previous).length, 0);
  const habitDetected = detectHabitCompletionTasks(currentTasks, previous, taskIsHabit);
  assert.deepEqual(habitDetected.map((detected) => detected.key), ['Tasks.md:Meditate #habit']);

  const store = new StateStore({ loadData: async () => ({}), saveData: async () => {} } as never);
  let savedState: PersistedState | undefined;
  plugin.stateStore = {
    addHabitCompletion: store.addHabitCompletion.bind(store),
    updateState: async (transform: (state: PersistedState) => PersistedState) => {
      savedState = transform(emptyState({ habitCompletions: {} }));
      return savedState;
    },
  };

  await plugin.recordHabitCompletionIfNeeded(habitDetected[0]);
  assert.deepEqual(savedState?.habitCompletions?.['Tasks.md:Meditate #habit'], ['2026-05-28']);
});

test('scanVault merges file hash updates into latest persisted state', async () => {
  const plugin = Object.create(TaskManagerPlugin.prototype) as any;
  const file = Object.assign(Object.create(TFile.prototype) as TFile, {
    path: 'Tasks.md', name: 'Tasks.md', basename: 'Tasks', extension: 'md', stat: { mtime: 1, ctime: 1, size: 10 },
  });
  const store = new StateStore({ loadData: async () => ({}), saveData: async () => {} } as never);
  let savedState = emptyState({ identityMigration: { version: 2, completed: true, conflicts: [] } });
  plugin.queryRenderer = { invalidateCache: () => {} };
  plugin.stateStore = {
    loadState: async () => savedState,
    hash: store.hash.bind(store),
    fileStatMatches: store.fileStatMatches.bind(store),
    hasFileChanged: () => true,
    setFileHash: store.setFileHash.bind(store),
    setFileHashes: store.setFileHashes.bind(store),
    retainFileHashesForPaths: store.retainFileHashesForPaths.bind(store),
    updateState: async (transform: (state: PersistedState) => PersistedState) => {
      savedState = transform({ ...savedState, habitCompletions: { habit: ['2026-05-28'] }, timeSessionLog: [session()] });
      return savedState;
    },
  };
  plugin.app = {
    vault: {
      read: async () => '- [ ] Task',
      getAbstractFileByPath: (path: string) => path === file.path ? file : null,
    },
  };
  plugin.getIndexableFiles = () => [file];
  plugin.parseTasksForFile = async () => [];
  plugin.applyScannedTaskWave = async () => true;
  plugin.persistState = async () => {};
  plugin.cacheUpdateHandlers = [];

  await plugin.scanVault(false);

  assert.deepEqual(savedState.habitCompletions?.habit, ['2026-05-28']);
  assert.equal(savedState.timeSessionLog?.length, 1);
  assert.ok(savedState.fileHashes?.['Tasks.md']);
});
