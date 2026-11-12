import test from 'node:test';
import assert from 'node:assert/strict';
import { TFile } from 'obsidian';
import TaskManagerPlugin, { formatIcsEventTaskLine } from '../src/main';
import { ReminderManager } from '../src/reminder-manager';
import { StateStore, type PersistedState } from '../src/state-store';
import { DEFAULT_SETTINGS, normalizeTaskManagerSettings } from '../src/types';
import type { ParsedTask } from '../src/task-scanner';
import { parseMarkdownTaskLine } from '../src/task-model';
import { TaskIndex } from '../src/task-index';

function emptyState(overrides: Partial<PersistedState> = {}): PersistedState {
  return {
    version: 1,
    snapshot: [],
    completions: [],
    recurrenceCounts: {},
    fileHashes: {},
    ...overrides,
  };
}

interface ReminderCheckHarness {
  settings: typeof DEFAULT_SETTINGS;
  stateStore: StateStore;
  reminderManager: ReminderManager;
  firedReminders: Set<string>;
  taskIndex: { getSnapshot: () => { readiness: 'cold' | 'hydrating' | 'ready' | 'degraded'; revision: number } };
  reminderIndex: {
    claimDue: (now?: string) => ReadonlyArray<{
      key: string;
      fireTime: string;
      version: number;
      task: { filePath: string; lineNumber: number; rawLine: string; normalizedText: string; status: string; metadata: { reminder?: string } };
    }>;
    ackDue: (claims: readonly unknown[]) => void;
    retryDue: (claims: readonly unknown[]) => void;
    keyForStoredRecord: (record: { reminderKey: string }) => string | undefined;
    resolve: (key: string) => { key: string; fireTime: string; task: { filePath: string; lineNumber: number; rawLine: string; normalizedText: string; status: string; metadata: { reminder?: string } } } | undefined;
  };
  fireReminderNotification: (text: string, key: string) => unknown;
  logMissedReminderToDaily: (text: string, reminderTime: string) => Promise<void>;
  checkDueReminders: () => Promise<void>;
}

function sampleTask(overrides: Partial<ParsedTask> = {}): ParsedTask {
  return {
    key: 'Focus.md:1:Write report',
    filePath: 'Focus.md',
    lineNumber: 1,
    rawLine: '- [ ] Write report',
    linePrefix: '',
    indentation: '',
    listMarker: '-',
    checkbox: ' ',
    body: 'Write report',
    normalizedText: 'Write report',
    status: 'todo',
    tags: [],
    contexts: [],
    metadata: { dates: {}, invalidDates: {}, dependsOn: [] },
    ...overrides,
  } as ParsedTask;
}

test('p0 review: recordFocusTime ignores sub-5-second sessions defensively', async () => {
  const plugin = Object.create(TaskManagerPlugin.prototype) as any;
  let loadCalled = false;
  let saved = false;
  let processed = false;
  plugin.stateStore = {
    loadState: async () => { loadCalled = true; return emptyState(); },
    saveState: async () => { saved = true; },
  };
  plugin.app = {
    vault: {
      getAbstractFileByPath: () => ({ path: 'Focus.md', extension: 'md' }),
      process: async () => { processed = true; },
    },
  };

  await plugin.recordFocusTime(sampleTask(), 4_999);

  assert.equal(loadCalled, false);
  assert.equal(saved, false);
  assert.equal(processed, false);
});

test('p0 review: recordFocusTime persists a session and writes actual time', async () => {
  const plugin = Object.create(TaskManagerPlugin.prototype) as any;
  let content = '- [ ] Write report';
  let savedState: PersistedState | undefined;
  const store = new StateStore({ loadData: async () => ({}), saveData: async () => {} } as never);
  plugin.stateStore = {
    appendTimeSession: store.appendTimeSession.bind(store),
    updateState: async (transform: (state: PersistedState) => PersistedState) => {
      savedState = transform(emptyState());
      return savedState;
    },
  };
  const sourceFile = Object.assign(Object.create(TFile.prototype), { path: 'Focus.md', extension: 'md' }) as TFile;
  plugin.app = {
    vault: {
      getAbstractFileByPath: () => sourceFile,
      process: async (_file: unknown, updater: (current: string) => string) => { content = updater(content); },
    },
  };
  plugin.taskMutations = {
    updateTaskActualTime: async (_file: TFile, task: ParsedTask, minutes: number) => {
      content = `${content} 🕐 ${minutes}m`;
      return task;
    },
  };

  await plugin.recordFocusTime(sampleTask(), 61_000);

  assert.equal(savedState?.timeSessionLog?.length, 1);
  assert.equal(savedState?.timeSessionLog?.[0].elapsedMinutes, 1);
  assert.equal(savedState?.timeSessionLog?.[0].source, 'focus-timer');
  assert.match(content, /🕐 1m$/u);
});

test('p0 review: due snoozed reminders fire even when original key is already in firedReminderKeys', async () => {
  const reminderKey = 'Focus.md:1:2000-01-01 00:00';
  let pluginData: { state?: Partial<PersistedState> } = {
    state: emptyState({
      firedReminderKeys: [`2999-01-01T00:00:00.000Z\u0000${reminderKey}`],
      snoozedReminders: [{
        reminderKey,
        taskFilePath: 'Focus.md',
        taskLineNumber: 1,
        taskText: 'Write report',
        originalReminderTime: '2000-01-01 00:00',
        nextFireTime: '2000-01-01 00:01',
        snoozedAtIso: '2000-01-01T00:00:00.000Z',
      }],
    }),
  };
  const stateStore = new StateStore({
    loadData: async () => pluginData,
    saveData: async (data: typeof pluginData) => { pluginData = data; },
  } as never);
  const plugin = Object.create(TaskManagerPlugin.prototype) as any;
  plugin.settings = { ...DEFAULT_SETTINGS, enableReminderNotifications: true, quietHoursEnabled: false, missedReminderLogEnabled: false };
  plugin.stateStore = stateStore;
  plugin.reminderManager = new ReminderManager({ stateStore, settings: plugin.settings });
  plugin.firedReminders = new Set([reminderKey]);
  plugin.taskIndex = { getSnapshot: () => ({ readiness: 'ready', revision: 1 }) };
  const indexed = {
    key: reminderKey,
    fireTime: '2000-01-01 00:00',
    task: { filePath: 'Focus.md', lineNumber: 1, rawLine: 'Write report', normalizedText: 'Write report', status: 'todo', metadata: { reminder: '2000-01-01 00:00' } },
  };
  plugin.reminderIndex = {
    claimDue: () => [],
    ackDue: () => {},
    retryDue: () => {},
    keyForStoredRecord: () => reminderKey,
    resolve: (key: string) => key === reminderKey ? indexed : undefined,
  };
  const fired: Array<{ taskText: string; key: string }> = [];
  plugin.fireReminderNotification = (taskText: string, key: string) => { fired.push({ taskText, key }); };

  await plugin.checkDueReminders();

  assert.deepEqual(fired, [{ taskText: 'Write report', key: reminderKey }]);
  assert.equal(pluginData.state?.snoozedReminders?.length, 0);
  assert.ok(pluginData.state?.firedReminderKeys?.some((entry) => entry.endsWith(`\u0000${reminderKey}`)));
});

test('p1 reminders: cold, hydrating, and degraded checks preserve durable queues', async () => {
  const staleKey = 'v2\u0000id\u0000stale\u00002000-01-01 00:00';
  let pluginData: { state?: Partial<PersistedState> } = {
    state: emptyState({
      snoozedReminders: [{
        reminderKey: staleKey, taskFilePath: 'Focus.md', taskLineNumber: 1, taskText: 'Stale',
        originalReminderTime: '2000-01-01 00:00', nextFireTime: '2000-01-01 00:01', snoozedAtIso: '2000-01-01T00:00:00.000Z',
      }],
      queuedNotifications: [{
        reminderKey: staleKey, taskFilePath: 'Focus.md', taskLineNumber: 1, taskText: 'Stale',
        reminderTime: '2000-01-01 00:00', enqueuedAtIso: '2000-01-01T00:00:00.000Z',
      }],
    }),
  };
  let saves = 0;
  const stateStore = new StateStore({
    loadData: async () => structuredClone(pluginData),
    saveData: async (data: typeof pluginData) => { saves += 1; pluginData = structuredClone(data); },
  } as never);
  const plugin = Object.create(TaskManagerPlugin.prototype) as ReminderCheckHarness;
  plugin.settings = { ...DEFAULT_SETTINGS, enableReminderNotifications: true, quietHoursEnabled: false, missedReminderLogEnabled: false };
  plugin.stateStore = stateStore;
  plugin.reminderManager = new ReminderManager({ stateStore, settings: plugin.settings });
  plugin.firedReminders = new Set();
  let readiness: 'cold' | 'hydrating' | 'ready' | 'degraded' = 'cold';
  plugin.taskIndex = { getSnapshot: () => ({ readiness, revision: 1 }) };
  let claims = 0;
  plugin.reminderIndex = {
    claimDue: () => { claims += 1; return []; }, ackDue: () => {}, retryDue: () => {},
    keyForStoredRecord: () => undefined, resolve: () => undefined,
  };
  plugin.fireReminderNotification = () => assert.fail('unhealthy checks must not notify');

  for (const value of ['cold', 'hydrating', 'degraded'] as const) {
    readiness = value;
    await plugin.checkDueReminders();
  }
  assert.equal(claims, 0);
  assert.equal(saves, 0);
  assert.equal(pluginData.state?.snoozedReminders?.length, 1);
  assert.equal(pluginData.state?.queuedNotifications?.length, 1);

  readiness = 'ready';
  await plugin.checkDueReminders();
  assert.equal(claims, 1);
  assert.equal(saves, 1);
  assert.deepEqual(pluginData.state?.snoozedReminders, []);
  assert.deepEqual(pluginData.state?.queuedNotifications, []);
});

test('p1 reminders: save failure retries a claim without fired state or effects', async () => {
  const key = 'v2\u0000id\u0000durable\u00002000-01-01 00:00';
  let pluginData: { state?: Partial<PersistedState> } = { state: emptyState() };
  let saveAttempts = 0;
  const stateStore = new StateStore({
    loadData: async () => structuredClone(pluginData),
    saveData: async (data: typeof pluginData) => {
      saveAttempts += 1;
      if (saveAttempts === 1) throw new Error('injected save failure');
      pluginData = structuredClone(data);
    },
  } as never);
  const plugin = Object.create(TaskManagerPlugin.prototype) as ReminderCheckHarness;
  plugin.settings = { ...DEFAULT_SETTINGS, enableReminderNotifications: true, quietHoursEnabled: false, missedReminderLogEnabled: true };
  plugin.stateStore = stateStore;
  plugin.reminderManager = new ReminderManager({ stateStore, settings: plugin.settings });
  plugin.firedReminders = new Set<string>();
  plugin.taskIndex = { getSnapshot: () => ({ readiness: 'ready', revision: 1 }) };
  const claim = {
    key, fireTime: '2000-01-01 00:00', version: 1,
    task: { filePath: 'Focus.md', lineNumber: 1, rawLine: 'Durable', normalizedText: 'Durable', status: 'todo', metadata: { reminder: '2000-01-01 00:00' } },
  };
  let available = true;
  let acknowledgements = 0;
  let retries = 0;
  plugin.reminderIndex = {
    claimDue: () => { if (!available) return []; available = false; return [claim]; },
    ackDue: () => { acknowledgements += 1; },
    retryDue: () => { retries += 1; available = true; },
    keyForStoredRecord: () => undefined,
    resolve: () => undefined,
  };
  const notifications: string[] = [];
  const logs: string[] = [];
  plugin.fireReminderNotification = (_text: string, reminderKey: string) => notifications.push(reminderKey);
  plugin.logMissedReminderToDaily = async (text: string) => { logs.push(text); };

  await assert.rejects(plugin.checkDueReminders(), /injected save failure/u);
  assert.equal(retries, 1);
  assert.equal(acknowledgements, 0);
  assert.deepEqual([...plugin.firedReminders], []);
  assert.deepEqual(notifications, []);
  assert.deepEqual(logs, []);
  assert.deepEqual(pluginData.state?.firedReminderKeys ?? [], []);

  await plugin.checkDueReminders();
  assert.equal(acknowledgements, 1);
  assert.deepEqual(notifications, [key]);
  assert.deepEqual(logs, ['Durable']);
  assert.ok(pluginData.state?.firedReminderKeys?.some((entry) => entry.endsWith(`\u0000${key}`)));
});

test('p1 reminders: delivery failure retains a durable outbox entry and retries on the next check', async () => {
  const key = 'v2\u0000id\u0000outbox\u00002000-01-01 00:00';
  let pluginData: { state?: Partial<PersistedState> } = { state: emptyState() };
  const stateStore = new StateStore({ loadData: async () => structuredClone(pluginData), saveData: async (data: typeof pluginData) => { pluginData = structuredClone(data); } } as never);
  const plugin = Object.create(TaskManagerPlugin.prototype) as ReminderCheckHarness;
  plugin.settings = { ...DEFAULT_SETTINGS, enableReminderNotifications: true, quietHoursEnabled: false, missedReminderLogEnabled: false };
  plugin.stateStore = stateStore;
  plugin.reminderManager = new ReminderManager({ stateStore, settings: plugin.settings });
  plugin.firedReminders = new Set();
  plugin.taskIndex = { getSnapshot: () => ({ readiness: 'ready', revision: 1 }) };
  const claim = { key, fireTime: '2000-01-01 00:00', version: 1, task: { filePath: 'Focus.md', lineNumber: 1, rawLine: 'Retry me', normalizedText: 'Retry me', status: 'todo', metadata: { reminder: '2000-01-01 00:00' } } };
  let firstClaim = true;
  let attempts = 0;
  plugin.reminderIndex = {
    claimDue: () => firstClaim ? (firstClaim = false, [claim]) : [],
    ackDue: () => undefined,
    retryDue: () => undefined,
    keyForStoredRecord: () => key,
    resolve: (candidate: string) => candidate === key ? claim : undefined,
  };
  plugin.fireReminderNotification = async () => { attempts += 1; return attempts > 1; };

  await plugin.checkDueReminders();
  assert.equal(attempts, 1);
  assert.deepEqual(pluginData.state?.queuedNotifications?.map((record) => record.reminderKey), [key]);
  assert.deepEqual(pluginData.state?.firedReminderKeys ?? [], []);

  await plugin.checkDueReminders();
  assert.equal(attempts, 2);
  assert.deepEqual(pluginData.state?.queuedNotifications, []);
  assert.ok(pluginData.state?.firedReminderKeys?.some((entry) => entry.endsWith(`\u0000${key}`)));
});

test('p1 reminders: immediate hydration failure keeps the scan ready and retries on the next production check', async () => {
  const source = Object.assign(Object.create(TFile.prototype), {
    path: 'Focus.md', name: 'Focus.md', basename: 'Focus', extension: 'md',
    stat: { mtime: 1, ctime: 1, size: 32 },
  }) as TFile;
  const reminderTime = '2000-01-01 00:00';
  const task = sampleTask({
    metadata: { dates: {}, invalidDates: {}, priority: 'normal', dependsOn: [], reminder: reminderTime },
  });
  let pluginData: { state?: Partial<PersistedState> } = { state: emptyState() };
  let saveAttempts = 0;
  const stateStore = new StateStore({
    loadData: async () => structuredClone(pluginData),
    saveData: async (data: typeof pluginData) => {
      saveAttempts += 1;
      if (saveAttempts === 1) throw new Error('injected immediate hydration save failure');
      pluginData = structuredClone(data);
    },
  } as never);
  const plugin = Object.create(TaskManagerPlugin.prototype) as unknown as ReminderCheckHarness & {
    scanVault(showNotice?: boolean, force?: boolean): Promise<void>;
    [key: string]: unknown;
  };
  plugin.settings = { ...DEFAULT_SETTINGS, enableReminderNotifications: true, quietHoursEnabled: false, missedReminderLogEnabled: false };
  plugin.app = {
    vault: {
      getFiles: () => [source],
      read: async () => task.rawLine,
      getAbstractFileByPath: () => source,
    },
    workspace: { getLeavesOfType: () => [] },
  };
  plugin.stateStore = stateStore;
  plugin.reminderManager = new ReminderManager({ stateStore, settings: plugin.settings });
  plugin.taskIndex = new TaskIndex();
  plugin.queryRenderer = { invalidateCache: () => undefined, refreshAllVisible: () => undefined };
  plugin.snapshot = new Map();
  plugin.completions = [];
  plugin.recurrenceCounts = {};
  plugin.pendingCompletionKeyMigrations = new Map();
  plugin.pendingRecurrenceCountMigrations = new Map();
  plugin.pendingRemovedIndexPaths = new Set();
  plugin.pendingFileScans = new Set();
  plugin.fileScanTimer = null;
  plugin.fileScanRunning = false;
  plugin.firedReminders = new Set();
  plugin.cacheUpdateHandlers = [];
  plugin.reminderIdentityMigrationAttempted = true;
  plugin.parseTasksForFile = async () => [task];
  plugin.applyScannedTaskWave = async () => true;
  plugin.migrateHydratedExplicitIdentityState = async () => undefined;
  plugin.persistState = async () => undefined;
  plugin.notifyTaskIndexConsumers = () => undefined;
  const notifications: string[] = [];
  plugin.fireReminderNotification = (_text: string, key: string) => notifications.push(key);

  const warnings: unknown[][] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args); };
  try {
    await plugin.scanVault(false, false);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(plugin.taskIndex.getSnapshot().readiness, 'ready');
  assert.deepEqual(notifications, []);
  assert.ok(warnings.some(([message, error]) => String(message).includes('delivery will retry') && String(error).includes('injected immediate hydration save failure')));

  await plugin.checkDueReminders();
  assert.equal(plugin.taskIndex.getSnapshot().readiness, 'ready');
  assert.equal(notifications.length, 1);
  assert.ok(pluginData.state?.firedReminderKeys?.some((entry) => entry.endsWith(`\u0000${notifications[0]}`)));
});

test('p1 reminders: a revision fence race retries claims and emits no effects', async () => {
  const key = 'v2\u0000id\u0000race\u00002000-01-01 00:00';
  let revision = 1;
  let saves = 0;
  const stateStore = new StateStore({
    loadData: async () => ({ state: emptyState() }),
    saveData: async () => { saves += 1; },
  } as never);
  const updateState = stateStore.updateState.bind(stateStore);
  let commitChecks = 0;
  stateStore.updateState = ((transform, options = {}) => updateState(transform, {
    ...options,
    shouldCommit: () => {
      commitChecks += 1;
      if (commitChecks === 2) revision = 2;
      return options.shouldCommit?.() ?? true;
    },
  })) as StateStore['updateState'];
  const plugin = Object.create(TaskManagerPlugin.prototype) as ReminderCheckHarness;
  plugin.settings = { ...DEFAULT_SETTINGS, enableReminderNotifications: true, quietHoursEnabled: false, missedReminderLogEnabled: false };
  plugin.stateStore = stateStore;
  plugin.reminderManager = new ReminderManager({ stateStore, settings: plugin.settings });
  plugin.firedReminders = new Set<string>();
  plugin.taskIndex = { getSnapshot: () => ({ readiness: 'ready', revision }) };
  let retried = 0;
  plugin.reminderIndex = {
    claimDue: () => [{
      key, fireTime: '2000-01-01 00:00', version: 1,
      task: { filePath: 'Focus.md', lineNumber: 1, rawLine: 'Race', normalizedText: 'Race', status: 'todo', metadata: { reminder: '2000-01-01 00:00' } },
    }],
    ackDue: () => assert.fail('fenced claim must not be acknowledged'),
    retryDue: () => { retried += 1; },
    keyForStoredRecord: () => undefined,
    resolve: () => undefined,
  };
  plugin.fireReminderNotification = () => assert.fail('fenced claim must not notify');

  await assert.rejects(plugin.checkDueReminders(), /commit fence/u);
  assert.equal(retried, 1);
  assert.equal(saves, 0);
  assert.deepEqual([...plugin.firedReminders], []);
});

test('p0 review: ICS summaries are sanitized before becoming task text', () => {
  const line = formatIcsEventTaskLine({
    summary: 'Bad [id:: ms-todo:evil] #todoist 📅 2099-01-01',
    date: '2026-06-01',
    uid: 'evil-event',
  });
  assert.equal(line, '- [ ] Bad 📅 2026-06-01 🆔 ical:evil-event');
  const task = parseMarkdownTaskLine(line, 'Calendar Import.md', 1);
  assert.ok(task);
  assert.equal(task.metadata.id, 'ical:evil-event');
  assert.equal(task.metadata.dates.due, '2026-06-01');
  assert.deepEqual(task.tags, []);
});

test('normalizeWorkflows: step status containing ] is replaced with space to prevent checkbox injection', () => {
  const settings = normalizeTaskManagerSettings({
    workflowsEnabled: true,
    workflows: [{
      id: 'wf-1',
      name: 'Injection Test',
      triggerTag: 'test',
      steps: [
        // ] in status would produce - [x]] description which parses with wrong body
        { name: 'Bad step', description: 'Do it', status: 'x]', priority: '' },
      ],
    }],
  });
  assert.equal(settings.workflows[0].steps[0].status, ' ', 'status "x]" must be normalized to space');
});

test('normalizeWorkflows: step status containing newline is replaced with space', () => {
  const settings = normalizeTaskManagerSettings({
    workflowsEnabled: true,
    workflows: [{
      id: 'wf-2',
      name: 'Newline Test',
      triggerTag: 'test2',
      steps: [
        { name: 'Bad step', description: 'Do it', status: 'x\n- [x] injected', priority: '' },
      ],
    }],
  });
  assert.equal(settings.workflows[0].steps[0].status, ' ', 'status with newline must be normalized to space');
});

test('normalizeWorkflows: empty step status is replaced with space', () => {
  const settings = normalizeTaskManagerSettings({
    workflowsEnabled: true,
    workflows: [{
      id: 'wf-3',
      name: 'Empty Status Test',
      triggerTag: 'test3',
      steps: [
        { name: 'Empty status', description: '{{prev}}', status: '', priority: '' },
      ],
    }],
  });
  assert.equal(settings.workflows[0].steps[0].status, ' ', 'empty status must be normalized to space');
});

test('normalizeWorkflows: valid single-char status is preserved', () => {
  const settings = normalizeTaskManagerSettings({
    workflowsEnabled: true,
    workflows: [{
      id: 'wf-4',
      name: 'Valid Status Test',
      triggerTag: 'test4',
      steps: [
        { name: 'Done step', description: '{{prev}}', status: 'x', priority: '' },
        { name: 'In-progress step', description: '{{prev}}', status: '/', priority: '' },
      ],
    }],
  } as Partial<typeof DEFAULT_SETTINGS> & Record<string, unknown>);
  assert.equal(settings.workflows[0].steps[0].status, 'x', 'valid status "x" must be preserved');
  assert.equal(settings.workflows[0].steps[1].status, '/', 'valid status "/" must be preserved');
});

test('normalizeWorkflows: whitespace-only step status is replaced with space', () => {
  const settings = normalizeTaskManagerSettings({
    workflowsEnabled: true,
    workflows: [{
      name: 'Whitespace Status Test',
      triggerTag: 'test5',
      steps: [
        { name: 'Whitespace status', description: '{{prev}}', status: '   ', priority: '' },
      ],
    }],
  } as Partial<typeof DEFAULT_SETTINGS> & Record<string, unknown>);
  assert.equal(settings.workflows[0].steps[0].status, ' ', 'whitespace-only status must be normalized to space');
});

test('normalizeWorkflows: generated workflow ids are stable across normalization', () => {
  const raw = {
    workflowsEnabled: true,
    workflows: [{
      name: 'Stable ID Test',
      triggerTag: 'stable-id',
      steps: [{ name: 'Step', description: 'Do it', status: 'x', priority: '' }],
    }],
  } as Partial<typeof DEFAULT_SETTINGS> & Record<string, unknown>;
  const first = normalizeTaskManagerSettings(raw);
  const second = normalizeTaskManagerSettings(raw);

  assert.equal(first.workflows[0].id, second.workflows[0].id, 'workflow ids must be stable');
});

test('p1 reminders: in-app notification delivery acknowledges only after rendering its actions', async () => {
  const plugin = Object.create(TaskManagerPlugin.prototype) as unknown as {
    settings: typeof DEFAULT_SETTINGS;
    markReminderTaskDone: () => void;
    showSnoozeOptions: () => void;
    fireReminderNotification: (taskText: string, taskKey: string) => Promise<boolean>;
  };
  plugin.settings = { ...DEFAULT_SETTINGS, reminderSnoozeEnabled: true, useSystemNotifications: false };
  plugin.markReminderTaskDone = () => undefined;
  plugin.showSnoozeOptions = () => undefined;

  assert.equal(await plugin.fireReminderNotification('- [ ] Write report', 'Focus.md:1:Write report'), true);
});
