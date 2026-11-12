import test from 'node:test';
import assert from 'node:assert/strict';
import { Notice, TFile } from 'obsidian';
import type { App } from 'obsidian';
import TaskManagerPlugin from '../src/main';
import {
  APPLE_REMINDERS_WEBHOOK_PROTOCOL,
  appleReminderToTaskLine,
  bidirectionalSyncAppleReminders,
  collectAppleReminderIds,
  createAppleRemindersWebhookPayload,
  handleAppleRemindersWebhook,
  normalizeAppleRemindersWebhookPayload,
  planAppleRemindersWebhookImport,
  syncVaultToAppleReminders,
  updateAppleReminder,
} from '../src/apple-reminders-sync';
import { fetchGoogleTasks, GoogleTasksAdapter, googleTaskToMarkdownLine, googleTasksPkceOAuthStart } from '../src/google-tasks-sync';
import { IdentityMapper } from '../src/sync-identity-mapper';
import { TaskIndex } from '../src/task-index';
import { bidirectionalSyncMicrosoftTodo, fetchMicrosoftTodoTasks, MicrosoftTodoAdapter, microsoftTodoOAuthUrl, microsoftTodoPkceOAuthStart, microsoftTodoToTaskLine, resolveMicrosoftTodoConflict, taskLineToMicrosoftTodo } from '../src/microsoft-todo-sync';
import type { MicrosoftTodoTask } from '../src/microsoft-todo-sync';
import { ProviderHttpError } from '../src/network-request';
import { GoogleTasksOAuthModal } from '../src/modals/google-tasks-oauth-modal';
import { MicrosoftTodoOAuthModal } from '../src/modals/microsoft-todo-oauth-modal';
import { normalizeTaskManagerSettings, type TaskManagerSettings } from '../src/types';
import { parseMarkdownTaskLine, type MarkdownTask } from '../src/task-model';

function fileForPath(path: string): TFile {
  return Object.assign(Object.create(TFile.prototype) as TFile, { path, name: path.split('/').pop() ?? path, extension: 'md', basename: path.replace(/\.md$/u, '') });
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function task(overrides: Partial<MarkdownTask> = {}): MarkdownTask {
  return {
    key: 'Tasks.md:Review spec',
    filePath: 'Tasks.md',
    lineNumber: 1,
    rawLine: '- [ ] Review spec 📅 2026-06-01',
    linePrefix: '',
    indentation: '',
    listMarker: '-',
    checkbox: ' ',
    body: 'Review spec 📅 2026-06-01',
    normalizedText: 'Review spec',
    status: 'todo',
    tags: [],
    contexts: [],
    metadata: { dates: { due: '2026-06-01' }, invalidDates: {}, priority: 'normal', dependsOn: [] },
    ...overrides,
  } as MarkdownTask;
}

interface GoogleTasksSyncHarness {
  settings: TaskManagerSettings;
  syncGoogleTasks(): Promise<void>;
}

interface CredentialDryRunHarness extends GoogleTasksSyncHarness {
  stateStore: { loadState(): Promise<Record<string, never>> };
  saveSettings(): Promise<void>;
  syncMsToDo(): Promise<void>;
}

interface TodoistSyncHarness {
  settings: TaskManagerSettings;
  app: App;
  stateStore: { loadState(): Promise<Record<string, never>> };
  identityMapper: IdentityMapper;
  scanVaultTasks(): Promise<MarkdownTask[]>;
  persistState(): Promise<void>;
  syncTodoist(): Promise<void>;
}

interface CalDAVSyncHarness {
  settings: TaskManagerSettings;
  app: App;
  apiV1: { getAllTasks(): MarkdownTask[] };
  saveSettings(): Promise<void>;
  syncCalDAV(): Promise<void>;
  onunload(): void;
}

interface CalDAVSettingsFenceHarness extends CalDAVSyncHarness {
  taskIndex: TaskIndex;
  stateStore: { saveSettings(settings: TaskManagerSettings, shouldCommit?: () => boolean): Promise<boolean> };
  reminderManager: { refreshCache(): void };
  appliedExcludedFoldersSignature: string | null;
  refreshAppearanceStyles(): void;
  scanVault(force: boolean, rebaseline: boolean): Promise<void>;
}

test('deferred wave C: external service settings remain gated off by default', () => {
  const settings = normalizeTaskManagerSettings({});
  assert.equal(settings.googleTasksEnabled, false);
  assert.equal(settings.googleTasksAccessToken, '');
  assert.equal(settings.msToDoEnabled, false);
  assert.equal(settings.msToDoToken, '');
  assert.equal(settings.appleRemindersEnabled, false);
  assert.equal(settings.appleRemindersWebhookEnabled, false);
});

test('write-producing sync refuses a degraded task index before provider or state access', async () => {
  const plugin = Object.create(TaskManagerPlugin.prototype) as unknown as {
    settings: TaskManagerSettings;
    taskIndex: TaskIndex;
    stateStore: { loadState(): Promise<Record<string, never>> };
    syncGoogleTasks(): Promise<void>;
    recordSyncRun(summary?: unknown): void;
  };
  plugin.settings = normalizeTaskManagerSettings({ googleTasksEnabled: true, googleTasksAccessToken: 'token' });
  plugin.taskIndex = new TaskIndex();
  plugin.taskIndex.beginHydration();
  plugin.taskIndex.markReady(true);
  let stateReads = 0;
  plugin.stateStore = { loadState: async () => { stateReads += 1; return {}; } };
  plugin.recordSyncRun = () => undefined;
  const originalFetch = globalThis.fetch;
  let fetches = 0;
  globalThis.fetch = (async () => { fetches += 1; throw new Error('unexpected provider access'); }) as typeof fetch;
  try {
    await plugin.syncGoogleTasks();
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(stateReads, 0);
  assert.equal(fetches, 0);
});

test('deferred wave C: Google Tasks PKCE OAuth URL and adapter conversion are network-free', async () => {
  const oauth = await googleTasksPkceOAuthStart('client-123', { codeVerifier: 'a'.repeat(64), state: 'state-1' });
  const url = oauth.authorizationUrl;
  assert.match(url, /^https:\/\/accounts\.google\.com\/o\/oauth2\/v2\/auth\?/u);
  assert.match(url, /scope=https%3A%2F%2Fwww.googleapis.com%2Fauth%2Ftasks/u);
  assert.equal(new URL(url).searchParams.get('response_type'), 'code');
  assert.equal(new URL(url).searchParams.get('code_challenge_method'), 'S256');
  assert.ok(new URL(url).searchParams.get('code_challenge'));
  assert.equal(new URL(url).searchParams.get('access_type'), 'offline');

  const adapter = new GoogleTasksAdapter({ accessToken: 'token', listId: '@default', dryRun: true });
  const payload = adapter.toServicePayload(task());
  assert.deepEqual(payload, { title: 'Review spec', notes: '', due: '2026-06-01T00:00:00.000Z', status: 'needsAction' });
  assert.deepEqual(adapter.toServicePayload(task({ metadata: { dates: {}, invalidDates: {}, priority: 'normal', dependsOn: [] } }), ['due']), { due: null });
  assert.equal(googleTaskToMarkdownLine({ id: 'g1', title: 'Call Pat', due: '2026-06-02T00:00:00.000Z', notes: 'Bring notes', status: 'needsAction' }), '- [ ] Call Pat 📅 2026-06-02 [id:: google-tasks:g1]\n  - 💬 Bring notes');
});

test('deferred wave C: Google Tasks import ignores invalid due dates', () => {
  const line = googleTaskToMarkdownLine({ id: 'g-bad-date', title: 'Bad date', due: '2026-02-30T00:00:00.000Z', status: 'needsAction' });

  assert.equal(line, '- [ ] Bad date [id:: google-tasks:g-bad-date]');
  assert.equal(parseMarkdownTaskLine(line, 'Google Tasks Inbox.md', 1)?.metadata.dates.due, undefined);
});

test('deferred wave C: Google Tasks import keeps title newlines inline', () => {
  const line = googleTaskToMarkdownLine({
    id: 'g-title',
    title: 'First line\n- [ ] Injected title task',
    status: 'needsAction',
  });

  assert.equal(line, '- [ ] First line - \\[ \\] Injected title task [id:: google-tasks:g-title]');
  assert.equal(line.split('\n').filter((part) => /^\s*- \[[ x]\]/iu.test(part)).length, 1);
  assert.equal(parseMarkdownTaskLine(line, 'Google Tasks Inbox.md', 1)?.metadata.id, 'google-tasks:g-title');
});

test('deferred wave C: Google Tasks notes round-trip as comment metadata', () => {
  const adapter = new GoogleTasksAdapter({ accessToken: 'token', listId: '@default', dryRun: true });
  const imported = adapter.fromServicePayload({
    id: 'g-note',
    title: 'Call Pat',
    due: '2026-06-02T00:00:00.000Z',
    notes: 'Bring notes\nConfirm time',
    status: 'needsAction',
  }, 'Google Tasks Inbox.md');

  assert.deepEqual(imported.metadata.comments, ['Bring notes', 'Confirm time']);
  assert.match(imported.rawLine, /\[id:: google-tasks:g-note\]\n  - 💬 Bring notes\n  - 💬 Confirm time$/u);
  assert.equal(adapter.toServicePayload(imported).notes, 'Bring notes\nConfirm time');
  assert.deepEqual(adapter.toServicePayload(task({ metadata: { dates: {}, invalidDates: {}, priority: 'normal', dependsOn: [] } }), ['description']), { notes: '' });
  assert.equal(adapter.toServicePayload(task({ metadata: { dates: {}, invalidDates: {}, priority: 'normal', dependsOn: [] } })).notes, '');
});

test('deferred wave C: Google Tasks no-credential paths fail locally without fetch', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    throw new Error('unexpected fetch');
  }) as typeof fetch;
  try {
    await assert.rejects(fetchGoogleTasks({}), /Not authenticated with Google Tasks/u);
    const adapter = new GoogleTasksAdapter({});
    await assert.rejects(adapter.create({ title: 'No auth' }), /Google Tasks write operations require an OAuth access token/u);
    await assert.rejects(adapter.update('g1', { title: 'No auth' }), /Google Tasks write operations require an OAuth access token/u);
    await assert.rejects(adapter.delete('g1'), /Google Tasks write operations require an OAuth access token/u);
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('deferred wave C: Google Tasks API-key-only mutations fail locally without fetch', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => {
    fetchCalled = true;
    throw new Error('unexpected fetch');
  }) as typeof fetch;
  try {
    const adapter = new GoogleTasksAdapter({ apiKey: 'AIza-legacy' });
    assert.equal(await adapter.isConfigured(), false);
    await assert.rejects(adapter.create({ title: 'Needs OAuth' }), /Google Tasks write operations require an OAuth access token/u);
    await assert.rejects(adapter.update('g1', { title: 'Needs OAuth' }), /Google Tasks write operations require an OAuth access token/u);
    await assert.rejects(adapter.delete('g1'), /Google Tasks write operations require an OAuth access token/u);
    assert.equal(fetchCalled, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('deferred wave C: Google Tasks fetch uses bearer token without real network', async () => {
  const originalFetch = globalThis.fetch;
  let capturedAuth = '';
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    capturedAuth = String((init?.headers as Record<string, string>)?.Authorization ?? '');
    return { ok: true, status: 200, json: async () => ({ items: [{ id: 'g1', title: 'Task', status: 'needsAction' }] }) } as Response;
  }) as typeof fetch;
  try {
    const tasks = await fetchGoogleTasks({ accessToken: 'ya29.token', listId: '@default' });
    assert.equal(capturedAuth, 'Bearer ya29.token');
    assert.equal(tasks[0].id, 'g1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('deferred wave C: Google Tasks rejects malformed remote payloads', async () => {
  const adapter = new GoogleTasksAdapter({ accessToken: 'token', listId: '@default' });
  assert.throws(
    () => adapter.fromServicePayload({ id: 'g-missing-title' }, 'Google Tasks Inbox.md'),
    /Invalid Google Tasks payload: missing task title/u,
  );
  assert.throws(
    () => adapter.fromServicePayload({ id: 'g1] [exclude_from_sync:: true', title: 'Injected', status: 'needsAction' }, 'Google Tasks Inbox.md'),
    /Invalid Google Tasks payload: invalid task id/u,
  );
  assert.throws(
    () => googleTaskToMarkdownLine({ id: 'g1] [exclude_from_sync:: true', title: 'Injected', status: 'needsAction' }),
    /Invalid Google Tasks payload: invalid task id/u,
  );
  assert.throws(
    () => adapter.fromServicePayload({ id: 'g1 📅 2099-01-01 x', title: 'Injected', status: 'needsAction' }, 'Google Tasks Inbox.md'),
    /Invalid Google Tasks payload: invalid task id/u,
  );
  assert.throws(
    () => googleTaskToMarkdownLine({ id: 'g1 📅 2099-01-01 x', title: 'Injected', status: 'needsAction' }),
    /Invalid Google Tasks payload: invalid task id/u,
  );

  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ title: 'Missing ID', status: 'needsAction' }) } as Response;
    }
    return { ok: true, status: 200, json: async () => ({ items: [{ id: 'g1', status: 'needsAction' }] }) } as Response;
  }) as typeof fetch;

  try {
    await assert.rejects(
      () => fetchGoogleTasks({ accessToken: 'token', listId: '@default' }),
      /Google Tasks fetch request failed: Invalid Google Tasks payload: missing task title/u,
    );
    await assert.rejects(
      () => adapter.create({ title: 'Create me' }),
      /Google Tasks create request failed: Invalid Google Tasks payload: missing task id/u,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('deferred wave C: Microsoft To Do OAuth URL and adapter conversion are network-free', () => {
  const url = microsoftTodoOAuthUrl('client-123');
  assert.match(url, /^https:\/\/login\.microsoftonline\.com\/common\/oauth2\/v2\.0\/authorize\?/u);
  assert.match(url, /Tasks.Read\+Tasks.ReadWrite/u);
  assert.equal(new URL(url).searchParams.get('response_type'), 'code');

  const adapter = new MicrosoftTodoAdapter({ accessToken: 'token', listId: 'list', bidirectionalSync: false, syncIntervalMinutes: 0, vaultImportPath: 'Inbox.md' });
  assert.deepEqual(adapter.toServicePayload(task()), { title: 'Review spec', body: { content: '', contentType: 'text' }, dueDateTime: { dateTime: '2026-06-01T00:00:00', timeZone: 'UTC' }, importance: 'normal', status: 'notStarted' });
  assert.deepEqual(
    adapter.toServicePayload(task({ metadata: { dates: { due: '2026-06-01', dueTime: '09:30' }, invalidDates: {}, priority: 'normal', dependsOn: [] } })),
    { title: 'Review spec', body: { content: '', contentType: 'text' }, dueDateTime: { dateTime: '2026-06-01T09:30:00', timeZone: 'UTC' }, importance: 'normal', status: 'notStarted' },
  );
  assert.deepEqual(adapter.toServicePayload(task(), ['description']), { body: { content: '', contentType: 'text' } });
  assert.deepEqual(adapter.toServicePayload(task({ metadata: { dates: {}, invalidDates: {}, priority: 'normal', dependsOn: [], comments: ['First line', 'Second line'] } }), ['description']), { body: { content: 'First line\nSecond line', contentType: 'text' } });
  assert.deepEqual(adapter.toServicePayload(task({ metadata: { dates: {}, invalidDates: {}, priority: 'normal', dependsOn: [] } }), ['due']), { dueDateTime: null });
  assert.equal(microsoftTodoToTaskLine({ id: 'm1', title: 'Ship', body: { content: 'Graph body', contentType: 'text' }, status: 'completed', isReminderOn: false, importance: 'high', dueDateTime: { dateTime: '2026-06-03T12:00:00.0000000Z', timeZone: 'UTC' } }), '- [x] Ship 📅 2026-06-03 12:00 🎯 high [id:: ms-todo:m1]\n  - 💬 Graph body');
  assert.equal(microsoftTodoToTaskLine({ id: 'm2', title: 'Offset due', status: 'notStarted', isReminderOn: false, dueDateTime: { dateTime: '2026-06-03T12:00:00+00:00', timeZone: 'UTC' } }), '- [ ] Offset due 📅 2026-06-03 12:00 [id:: ms-todo:m2]');
  assert.equal(microsoftTodoToTaskLine({ id: 'm3', title: 'Midnight due', status: 'notStarted', isReminderOn: false, dueDateTime: { dateTime: '2026-06-03T00:00:00Z', timeZone: 'UTC' } }), '- [ ] Midnight due 📅 2026-06-03 00:00 [id:: ms-todo:m3]');
  assert.equal(microsoftTodoToTaskLine({ id: 'm4', title: 'Invalid due time', status: 'notStarted', isReminderOn: false, dueDateTime: { dateTime: '2026-06-03T25:99:00', timeZone: 'UTC' } }), '- [ ] Invalid due time 📅 2026-06-03 [id:: ms-todo:m4]');
  assert.equal(taskLineToMicrosoftTodo('- [ ] Ship 📅 2026-06-03 12:00 [id:: ms-todo:m1]').dueDateTime?.dateTime, '2026-06-03T12:00:00');
  assert.equal(taskLineToMicrosoftTodo('- [ ] Midnight due 📅 2026-06-03 00:00 [id:: ms-todo:m3]').dueDateTime?.dateTime, '2026-06-03T00:00:00');
  assert.equal(taskLineToMicrosoftTodo('- [ ] Invalid due time 📅 2026-06-03 25:99 [id:: ms-todo:m4]').dueDateTime?.dateTime, '2026-06-03T00:00:00');
  assert.equal(taskLineToMicrosoftTodo('- [ ] Zoned due 📅 2026-06-03 12:00 [ms-todo-timezone:: Europe/Berlin] [id:: ms-todo:m6]').dueDateTime?.timeZone, 'Europe/Berlin');
  assert.equal(microsoftTodoToTaskLine({ id: 'm6', title: 'Zoned due', status: 'notStarted', isReminderOn: false, dueDateTime: { dateTime: '2026-06-03T12:00:00', timeZone: 'Europe/Berlin' } }), '- [ ] Zoned due 📅 2026-06-03 12:00 [ms-todo-timezone:: Europe/Berlin] [id:: ms-todo:m6]');
  assert.deepEqual(
    adapter.toServicePayload(task({ rawLine: '- [ ] Zoned due 📅 2026-06-03 12:00 [ms-todo-timezone:: Europe/Berlin] [id:: ms-todo:m6]', body: 'Zoned due 📅 2026-06-03 12:00 [ms-todo-timezone:: Europe/Berlin] [id:: ms-todo:m6]', normalizedText: 'Zoned due', metadata: { dates: { due: '2026-06-03', dueTime: '12:00' }, invalidDates: {}, priority: 'normal', dependsOn: [], id: 'ms-todo:m6' } })),
    { title: 'Zoned due', body: { content: '', contentType: 'text' }, dueDateTime: { dateTime: '2026-06-03T12:00:00', timeZone: 'Europe/Berlin' }, importance: 'normal', status: 'notStarted' },
  );
  const imported = adapter.fromServicePayload({ id: 'm1', title: 'Ship', body: { content: 'Graph body', contentType: 'text' }, status: 'completed', isReminderOn: false, dueDateTime: { dateTime: '2026-06-03T12:00:00.0000000Z', timeZone: 'UTC' } }, 'Inbox.md');
  assert.equal(imported.key, 'id:ms-todo:m1');
  assert.equal(imported.metadata.id, 'ms-todo:m1');
  assert.equal(imported.metadata.dates.due, '2026-06-03');
  assert.equal(imported.metadata.dates.dueTime, '12:00');
  const importedOffset = adapter.fromServicePayload({ id: 'm2', title: 'Offset due', status: 'notStarted', isReminderOn: false, dueDateTime: { dateTime: '2026-06-03T12:00:00+00:00', timeZone: 'UTC' } }, 'Inbox.md');
  assert.equal(importedOffset.metadata.dates.due, '2026-06-03');
  assert.equal(importedOffset.metadata.dates.dueTime, '12:00');
  const importedZoned = adapter.fromServicePayload({ id: 'm6', title: 'Zoned due', status: 'notStarted', isReminderOn: false, dueDateTime: { dateTime: '2026-06-03T12:00:00', timeZone: 'Europe/Berlin' } }, 'Inbox.md');
  assert.equal(importedZoned.rawLine, '- [ ] Zoned due 📅 2026-06-03 12:00 [ms-todo-timezone:: Europe/Berlin] [id:: ms-todo:m6]');
  const importedMidnight = adapter.fromServicePayload({ id: 'm3', title: 'Midnight due', status: 'notStarted', isReminderOn: false, dueDateTime: { dateTime: '2026-06-03T00:00:00Z', timeZone: 'UTC' } }, 'Inbox.md');
  assert.equal(importedMidnight.metadata.dates.due, '2026-06-03');
  assert.equal(importedMidnight.metadata.dates.dueTime, '00:00');
  const importedInvalidTime = adapter.fromServicePayload({ id: 'm4', title: 'Invalid due time', status: 'notStarted', isReminderOn: false, dueDateTime: { dateTime: '2026-06-03T25:99:00', timeZone: 'UTC' } }, 'Inbox.md');
  assert.equal(importedInvalidTime.metadata.dates.due, '2026-06-03');
  assert.equal(importedInvalidTime.metadata.dates.dueTime, undefined);
  const importedMissingTitle = adapter.fromServicePayload({ id: 'm5', body: { content: 'Only notes', contentType: 'text' }, isReminderOn: 'yes' }, 'Inbox.md');
  assert.equal(importedMissingTitle.rawLine, '- [ ] Untitled Microsoft To Do task [id:: ms-todo:m5]\n  - 💬 Only notes');
  assert.equal(importedMissingTitle.metadata.id, 'ms-todo:m5');
  assert.deepEqual(importedMissingTitle.metadata.comments, ['Only notes']);
  assert.throws(() => adapter.fromServicePayload({ title: 'Missing id' }, 'Inbox.md'), /missing task id/u);
  assert.throws(() => adapter.fromServicePayload({ id: 'x] [exclude_from_sync:: true', title: 'Injected', status: 'notStarted', isReminderOn: false }, 'Inbox.md'), /missing task id/u);
  assert.throws(() => microsoftTodoToTaskLine({ id: 'x] [exclude_from_sync:: true', title: 'Injected', status: 'notStarted', isReminderOn: false }), /invalid task id/u);
  assert.deepEqual(imported.metadata.comments, ['Graph body']);
  assert.equal(imported.rawLine, '- [x] Ship 📅 2026-06-03 12:00 [id:: ms-todo:m1]\n  - 💬 Graph body');
});

test('deferred wave C: Microsoft To Do adapter fetchAll includes IDs in payloads', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ value: [
      { id: 'm-fetch', title: 'Fetched', status: 'notStarted', isReminderOn: false, dueDateTime: { dateTime: '2026-06-04T00:00:00', timeZone: 'UTC' } },
    ] }),
  } as Response)) as typeof fetch;

  try {
    const adapter = new MicrosoftTodoAdapter({ accessToken: 'token', listId: 'list', bidirectionalSync: false, syncIntervalMinutes: 0, vaultImportPath: 'Inbox.md' });
    const items = await adapter.fetchAll();
    assert.equal(items.length, 1);
    const [item] = items;
    assert.equal(item.externalId, 'm-fetch');
    assert.equal(item.payload.id, 'm-fetch');
    const imported = adapter.fromServicePayload(item.payload, 'Inbox.md');
    assert.equal(imported.metadata.id, 'ms-todo:m-fetch');
    assert.equal(imported.metadata.dates.due, '2026-06-04');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('deferred wave C: Microsoft To Do rejects malformed pages and items without certifying absence', async (t) => {
  for (const [name, body, expected] of [
    ['non-array page', { value: {} }, /invalid task page/u],
    ['missing id', { value: [{ title: 'Missing id', status: 'notStarted', isReminderOn: false }] }, /invalid task at page item 1/u],
    ['missing title', { value: [{ id: 'm1', status: 'notStarted', isReminderOn: false }] }, /invalid task at page item 1/u],
    ['unknown status', { value: [{ id: 'm1', title: 'Unknown', status: 'newProviderState', isReminderOn: false }] }, /invalid task at page item 1/u],
    ['malformed reminder flag', { value: [{ id: 'm1', title: 'Reminder', status: 'notStarted', isReminderOn: 'false' }] }, /invalid task at page item 1/u],
    ['malformed due date', { value: [{ id: 'm1', title: 'Due', status: 'notStarted', isReminderOn: false, dueDateTime: { dateTime: 123, timeZone: 'UTC' } }] }, /invalid task at page item 1/u],
    ['malformed next link', { value: [], '@odata.nextLink': 42 }, /invalid next page URL/u],
  ] as const) {
    await t.test(name, async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => body } as Response)) as typeof fetch;
      try {
        await assert.rejects(() => fetchMicrosoftTodoTasks({ accessToken: 'token', listId: 'list', bidirectionalSync: false, syncIntervalMinutes: 0, vaultImportPath: 'Inbox.md' }), expected);
      } finally { globalThis.fetch = originalFetch; }
    });
  }
});

test('deferred wave C: Microsoft bidirectional sync matches embedded ids before deletion', async () => {
  const originalFetch = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    methods.push(String(init?.method ?? 'GET'));
    return { ok: true, status: 200, json: async () => ({ value: [{ id: 'm-linked', title: 'Linked', status: 'notStarted', isReminderOn: false }] }) } as Response;
  }) as typeof fetch;

  try {
    const stats = await bidirectionalSyncMicrosoftTodo([{ line: '- [ ] Linked [id:: ms-todo:m-linked]' }], { accessToken: 'token', listId: 'list', bidirectionalSync: true, deleteMissingRemote: true, syncIntervalMinutes: 0, vaultImportPath: 'Inbox.md' }, 'vault-first');
    assert.equal(stats.created, 0);
    assert.equal(stats.deleted, 0);
    assert.equal(methods.includes('DELETE'), false);
    assert.equal(methods.includes('POST'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('deferred wave C: Microsoft bidirectional sync skips deleteMissingRemote when local task input is empty or unlinked', async () => {
  const originalFetch = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    methods.push(String(init?.method ?? 'GET'));
    return { ok: true, status: 200, json: async () => ({ value: [{ id: 'm-remote', title: 'Remote', status: 'notStarted', isReminderOn: false }] }) } as Response;
  }) as typeof fetch;

  try {
    for (const vaultTasks of [[], [{ line: '- [ ] Local only' }]]) {
      const stats = await bidirectionalSyncMicrosoftTodo(vaultTasks, { accessToken: 'token', listId: 'list', bidirectionalSync: true, deleteMissingRemote: true, syncIntervalMinutes: 0, vaultImportPath: 'Inbox.md' }, 'vault-first');
      assert.equal(stats.deleted, 0);
    }
    assert.equal(methods.includes('DELETE'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('deferred wave C: Microsoft bidirectional sync deleteMissingRemote still deletes genuinely missing linked remotes', async () => {
  const originalFetch = globalThis.fetch;
  const deletedUrls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'DELETE') {
      deletedUrls.push(String(url));
      return { ok: true, status: 204, json: async () => ({}) } as Response;
    }
    return { ok: true, status: 200, json: async () => ({ value: [
      { id: 'm-linked', title: 'Linked', status: 'notStarted', isReminderOn: false },
      { id: 'm-remote', title: 'Remote', status: 'notStarted', isReminderOn: false },
    ] }) } as Response;
  }) as typeof fetch;

  try {
    const stats = await bidirectionalSyncMicrosoftTodo([{ line: '- [ ] Linked [id:: ms-todo:m-linked]' }], { accessToken: 'token', listId: 'list', bidirectionalSync: true, deleteMissingRemote: true, localSnapshotComplete: true, maxDeletePercentage: 100, syncIntervalMinutes: 0, vaultImportPath: 'Inbox.md' }, 'vault-first');
    assert.equal(stats.deleted, 1);
    assert.deepEqual(deletedUrls, ['https://graph.microsoft.com/v1.0/me/todo/lists/list/tasks/m-remote']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('deferred wave C: Microsoft bidirectional sync treats Graph body and reminder changes as conflicts', async () => {
  const originalFetch = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    methods.push(String(init?.method ?? 'GET'));
    if (init?.method === 'PATCH') {
      return { ok: true, status: 200, json: async () => ({ id: 'm-linked', title: 'Linked', status: 'notStarted', isReminderOn: false }) } as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        value: [{
          id: 'm-linked',
          title: 'Linked',
          status: 'notStarted',
          body: { content: 'Remote notes', contentType: 'text' },
          isReminderOn: true,
          lastModifiedDateTime: '2026-06-03T12:00:00.000Z',
        }],
      }),
    } as Response;
  }) as typeof fetch;

  try {
    const stats = await bidirectionalSyncMicrosoftTodo([{ line: '- [ ] Linked [id:: ms-todo:m-linked]' }], { accessToken: 'token', listId: 'list', bidirectionalSync: true, syncIntervalMinutes: 0, vaultImportPath: 'Inbox.md' }, 'vault-first');
    assert.equal(stats.conflicts, 1);
    assert.equal(stats.updated, 1);
    assert.ok(methods.includes('PATCH'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('deferred wave C: Microsoft bidirectional sync treats due times as meaningful changes', async () => {
  const originalFetch = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    methods.push(String(init?.method ?? 'GET'));
    if (init?.method === 'PATCH') {
      return { ok: true, status: 200, json: async () => ({ id: 'm-linked', title: 'Linked', status: 'notStarted', isReminderOn: false }) } as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        value: [{
          id: 'm-linked',
          title: 'Linked',
          status: 'notStarted',
          isReminderOn: false,
          dueDateTime: { dateTime: '2026-06-03T12:00:00.0000000Z', timeZone: 'UTC' },
        }],
      }),
    } as Response;
  }) as typeof fetch;

  try {
    const stats = await bidirectionalSyncMicrosoftTodo([{ line: '- [ ] Linked 📅 2026-06-03 09:00 [id:: ms-todo:m-linked]' }], { accessToken: 'token', listId: 'list', bidirectionalSync: true, syncIntervalMinutes: 0, vaultImportPath: 'Inbox.md' }, 'vault-first');
    assert.equal(stats.conflicts, 1);
    assert.equal(stats.updated, 1);
    assert.ok(methods.includes('PATCH'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('deferred wave C: Microsoft bidirectional sync treats due timezones as meaningful changes', async () => {
  const originalFetch = globalThis.fetch;
  const methods: string[] = [];
  let patchPayload: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    methods.push(String(init?.method ?? 'GET'));
    if (init?.method === 'PATCH') {
      patchPayload = JSON.parse(String(init.body)) as Record<string, unknown>;
      return { ok: true, status: 200, json: async () => ({ id: 'm-linked', title: 'Linked', status: 'notStarted', isReminderOn: false }) } as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        value: [{
          id: 'm-linked',
          title: 'Linked',
          status: 'notStarted',
          isReminderOn: false,
          dueDateTime: { dateTime: '2026-06-03T09:00:00', timeZone: 'Europe/Berlin' },
        }],
      }),
    } as Response;
  }) as typeof fetch;

  try {
    const stats = await bidirectionalSyncMicrosoftTodo(
      [{ line: '- [ ] Linked 📅 2026-06-03 09:00 [ms-todo-timezone:: America/New_York] [id:: ms-todo:m-linked]' }],
      { accessToken: 'token', listId: 'list', bidirectionalSync: true, syncIntervalMinutes: 0, vaultImportPath: 'Inbox.md' },
      'vault-first',
    );
    assert.equal(stats.conflicts, 1);
    assert.equal(stats.updated, 1);
    assert.ok(methods.includes('PATCH'));
    assert.deepEqual(patchPayload?.dueDateTime, { dateTime: '2026-06-03T09:00:00', timeZone: 'America/New_York' });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('deferred wave C: Microsoft To Do export reads only leading checkbox status', () => {
  assert.equal(taskLineToMicrosoftTodo('- [ ] Ask about [/] syntax').status, 'notStarted');
  assert.equal(taskLineToMicrosoftTodo('* [x] Completed asterisk task').status, 'completed');
  assert.equal(taskLineToMicrosoftTodo('1. [>] Deferred numbered task').status, 'deferred');
});

test('deferred wave C: Microsoft To Do import keeps title newlines inline', () => {
  const line = microsoftTodoToTaskLine({
    id: 'm-title',
    title: 'First line\n- [ ] Injected title task',
    status: 'notStarted',
    isReminderOn: false,
  });

  assert.equal(line, '- [ ] First line - \\[ \\] Injected title task [id:: ms-todo:m-title]');
  assert.equal(line.split('\n').filter((part) => /^\s*- \[[ x]\]/iu.test(part)).length, 1);
  assert.equal(parseMarkdownTaskLine(line, 'Microsoft To Do Inbox.md', 1)?.metadata.id, 'ms-todo:m-title');
});

test('external sync imports strip untrusted emoji metadata from service text', () => {
  const attackTitle = 'Remote title 🆔 evil_id 📅 2099-01-01 🔁 every day';
  const appleLine = appleReminderToTaskLine({ id: 'apple-real', title: attackTitle, notes: 'Note 🆔 note_evil 📅 2099-01-01', isCompleted: false });
  const googleLine = googleTaskToMarkdownLine({ id: 'google-real', title: attackTitle, notes: 'Note 🆔 note_evil 📅 2099-01-01', status: 'needsAction' });
  const microsoftLine = microsoftTodoToTaskLine({ id: 'ms-real', title: attackTitle, body: { content: 'Note 🆔 note_evil 📅 2099-01-01', contentType: 'text' }, status: 'notStarted', isReminderOn: false });

  for (const [line, expectedId] of [
    [appleLine, 'apple-reminder:apple-real'],
    [googleLine, 'google-tasks:google-real'],
    [microsoftLine, 'ms-todo:ms-real'],
  ] as const) {
    assert.doesNotMatch(line, /evil_id|2099-01-01|every day|note_evil|custom_evil/u);
    const parsed = parseMarkdownTaskLine(line.split('\n')[0], 'Inbox.md', 1);
    assert.equal(parsed?.metadata.id, expectedId);
    assert.equal(parsed?.metadata.dates.due, undefined);
    assert.equal(parsed?.metadata.recurrence, undefined);
  }
});

test('external sync imports neutralize routing tags and contexts from service titles', () => {
  const attackTitle = 'Remote bridge #google-calendar #todoist @work';
  const lines = [
    appleReminderToTaskLine({ id: 'apple-route', title: attackTitle, notes: 'Note #todoist @note', isCompleted: false }),
    googleTaskToMarkdownLine({ id: 'google-route', title: attackTitle, notes: 'Note #todoist @note', status: 'needsAction' }),
    microsoftTodoToTaskLine({ id: 'ms-route', title: attackTitle, body: { content: 'Note #todoist @note', contentType: 'text' }, status: 'notStarted', isReminderOn: false }),
  ];

  for (const line of lines) {
    assert.match(line, /\\#google-calendar/u);
    assert.match(line, /\\#todoist/u);
    assert.match(line, /\\@work/u);
    const parsed = parseMarkdownTaskLine(line.split('\n')[0], 'Inbox.md', 1);
    assert.ok(parsed);
    assert.deepEqual(parsed.tags, []);
    assert.deepEqual(parsed.contexts, []);
  }
});

test('external sync task lines keep imported notes after same-line metadata', () => {
  const microsoftLine = microsoftTodoToTaskLine({
    id: 'm-note',
    title: 'Follow up',
    body: { content: 'First line\nSecond line', contentType: 'text' },
    status: 'inProgress',
    isReminderOn: false,
  });
  assert.equal(
    microsoftLine,
    '- [/] Follow up [id:: ms-todo:m-note]\n  - 💬 First line\n  - 💬 Second line',
  );
  assert.equal(parseMarkdownTaskLine(microsoftLine.split('\n')[0], 'Microsoft To Do Inbox.md', 1)?.status, 'in_progress');
});

test('provider throttling errors preserve typed Retry-After metadata', async (t) => {
  for (const [name, run] of [
    ['Google Tasks', () => fetchGoogleTasks({ accessToken: 'token', listId: 'list' })],
    ['Microsoft To Do', () => fetchMicrosoftTodoTasks({ accessToken: 'token', listId: 'list', bidirectionalSync: false, syncIntervalMinutes: 0, vaultImportPath: 'Inbox.md' })],
  ] as const) {
    await t.test(name, async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => Response.json({ error: { code: 'TooManyRequests', message: 'Slow down' } }, { status: 429, headers: { 'retry-after': '7' } })) as typeof fetch;
      try {
        await assert.rejects(run, (error: unknown) => error instanceof ProviderHttpError && error.statusCode === 429 && error.retryAfterMs === 7000);
      } finally { globalThis.fetch = originalFetch; }
    });
  }
});

test('deferred wave C: Microsoft To Do fetch propagates Graph errors', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url).endsWith('/me/todo/lists')) {
      return { ok: true, status: 200, json: async () => ({ value: [{ id: 'default-list', wellknownListName: 'defaultList' }] }) } as Response;
    }
    return { ok: false, status: 401, json: async () => ({}) } as Response;
  }) as typeof fetch;
  try {
    await assert.rejects(fetchMicrosoftTodoTasks({ accessToken: 'expired', bidirectionalSync: false, syncIntervalMinutes: 0, vaultImportPath: 'Inbox.md' }), /authentication expired/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('deferred wave C: Microsoft To Do adapter create returns Graph id and status updates preserve title', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit; body?: Record<string, unknown> }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : undefined;
    calls.push({ url: String(url), init, body });
    if (String(url).endsWith('/me/todo/lists')) {
      return { ok: true, status: 200, json: async () => ({ value: [{ id: 'default-list', wellknownListName: 'defaultList' }] }) } as Response;
    }
    if (init?.method === 'POST') {
      return { ok: true, status: 201, json: async () => ({ id: 'graph-created-id', title: body?.title, status: 'notStarted', isReminderOn: false }) } as Response;
    }
    return { ok: true, status: 200, json: async () => ({ id: 'existing-id', title: 'Kept title', status: body?.status, isReminderOn: false }) } as Response;
  }) as typeof fetch;
  try {
    const adapter = new MicrosoftTodoAdapter({ accessToken: 'ms-token', bidirectionalSync: false, syncIntervalMinutes: 0, vaultImportPath: 'Inbox.md' });
    const created = await adapter.create({ title: 'Created title' });
    await adapter.update('existing-id', { status: 'completed' });
    await adapter.reopen('existing-id');

    assert.equal(created.externalId, 'graph-created-id');
    const mutationBodies = calls.filter((call) => call.init?.method === 'PATCH').map((call) => call.body);
    assert.deepEqual(mutationBodies, [{ status: 'completed' }, { status: 'notStarted' }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('deferred wave C: Microsoft To Do fetch resolves default list and uses trimmed bearer token', async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    assert.equal((init?.headers as Record<string, string>)?.Authorization, 'Bearer ms-token');
    urls.push(String(url));
    if (String(url).endsWith('/me/todo/lists')) {
      return { ok: true, status: 200, json: async () => ({ value: [{ id: 'default-list', wellknownListName: 'defaultList' }] }) } as Response;
    }
    return { ok: true, status: 200, json: async () => ({ value: [{ id: 'm1', title: 'Task', status: 'notStarted', isReminderOn: false }] }) } as Response;
  }) as typeof fetch;
  try {
    const tasks = await fetchMicrosoftTodoTasks({ accessToken: '  ms-token  ', bidirectionalSync: false, syncIntervalMinutes: 0, vaultImportPath: 'Inbox.md' });
    assert.deepEqual(urls, ['https://graph.microsoft.com/v1.0/me/todo/lists', 'https://graph.microsoft.com/v1.0/me/todo/lists/default-list/tasks?$top=100']);
    assert.equal(tasks[0].id, 'm1');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('deferred wave C: Microsoft To Do whitespace-only token fails before fetch', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = (async () => {
    fetchCount += 1;
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }) as typeof fetch;
  try {
    await assert.rejects(
      fetchMicrosoftTodoTasks({ accessToken: '   ', bidirectionalSync: false, syncIntervalMinutes: 0, vaultImportPath: 'Inbox.md' }),
      /Not authenticated with Microsoft To Do/u,
    );
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('deferred wave C: Microsoft To Do fetch follows @odata.nextLink pagination', async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  const PAGE2_URL = 'https://graph.microsoft.com/v1.0/me/todo/lists/default-list/tasks?$skiptoken=page2';
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    urls.push(String(url));
    void init;
    if (String(url).endsWith('/me/todo/lists')) {
      return { ok: true, status: 200, json: async () => ({ value: [{ id: 'default-list', wellknownListName: 'defaultList' }] }) } as Response;
    }
    if (String(url) === PAGE2_URL) {
      return { ok: true, status: 200, json: async () => ({ value: [{ id: 'm2', title: 'Page2 Task', status: 'notStarted', isReminderOn: false }] }) } as Response;
    }
    // First page response includes nextLink
    return { ok: true, status: 200, json: async () => ({ value: [{ id: 'm1', title: 'Page1 Task', status: 'notStarted', isReminderOn: false }], '@odata.nextLink': PAGE2_URL }) } as Response;
  }) as typeof fetch;
  try {
    const tasks = await fetchMicrosoftTodoTasks({ accessToken: 'ms-token', bidirectionalSync: false, syncIntervalMinutes: 0, vaultImportPath: 'Inbox.md' });
    assert.equal(tasks.length, 2);
    assert.equal(tasks[0].id, 'm1');
    assert.equal(tasks[1].id, 'm2');
    // Should have fetched list, page 1, and page 2
    assert.equal(urls.length, 3);
    assert.equal(urls[2], PAGE2_URL);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('deferred wave C: Microsoft To Do fetch rejects unsafe @odata.nextLink URLs', async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    if (String(url).endsWith('/me/todo/lists')) {
      return { ok: true, status: 200, json: async () => ({ value: [{ id: 'default-list', wellknownListName: 'defaultList' }] }) } as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        value: [{ id: 'm1', title: 'Page1 Task', status: 'notStarted', isReminderOn: false }],
        '@odata.nextLink': 'https://evil.example/v1.0/me/todo/lists/default-list/tasks?$skiptoken=page2',
      }),
    } as Response;
  }) as typeof fetch;
  try {
    await assert.rejects(
      fetchMicrosoftTodoTasks({ accessToken: 'ms-token', bidirectionalSync: false, syncIntervalMinutes: 0, vaultImportPath: 'Inbox.md' }),
      /unexpected next page URL/u,
    );
    assert.equal(urls.includes('https://evil.example/v1.0/me/todo/lists/default-list/tasks?$skiptoken=page2'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('deferred wave C: Microsoft To Do fetch rejects same-origin nextLink for the wrong list', async () => {
  const originalFetch = globalThis.fetch;
  const wrongListUrl = 'https://graph.microsoft.com/v1.0/me/todo/lists/other-list/tasks?$skiptoken=page2';
  const urls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    if (String(url).endsWith('/me/todo/lists')) {
      return { ok: true, status: 200, json: async () => ({ value: [{ id: 'default-list', wellknownListName: 'defaultList' }] }) } as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ value: [], '@odata.nextLink': wrongListUrl }),
    } as Response;
  }) as typeof fetch;
  try {
    await assert.rejects(
      fetchMicrosoftTodoTasks({ accessToken: 'ms-token', bidirectionalSync: false, syncIntervalMinutes: 0, vaultImportPath: 'Inbox.md' }),
      /unexpected next page URL/u,
    );
    assert.equal(urls.includes(wrongListUrl), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('deferred wave C: Microsoft To Do fetch rejects repeated @odata.nextLink URLs', async () => {
  const originalFetch = globalThis.fetch;
  const PAGE_URL = 'https://graph.microsoft.com/v1.0/me/todo/lists/default-list/tasks?$skiptoken=same';
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url).endsWith('/me/todo/lists')) {
      return { ok: true, status: 200, json: async () => ({ value: [{ id: 'default-list', wellknownListName: 'defaultList' }] }) } as Response;
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ value: [], '@odata.nextLink': PAGE_URL }),
    } as Response;
  }) as typeof fetch;
  try {
    await assert.rejects(
      fetchMicrosoftTodoTasks({ accessToken: 'ms-token', bidirectionalSync: false, syncIntervalMinutes: 0, vaultImportPath: 'Inbox.md' }),
      /pagination did not terminate safely/u,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('deferred wave C: Apple Reminders native writes report unsupported instead of fake success', async () => {
  await assert.rejects(updateAppleReminder({ id: 'a1', title: 'Native write', isCompleted: false }, { listName: 'Reminders', bidirectionalSync: true, syncOnChange: false, syncIntervalMinutes: 0, vaultImportPath: 'Inbox.md' }), /Native Apple Reminders bridge is not available/u);
  const count = await syncVaultToAppleReminders([{ line: '- [ ] Native write', id: 'a1' }], { listName: 'Reminders', bidirectionalSync: true, syncOnChange: false, syncIntervalMinutes: 0, vaultImportPath: 'Inbox.md' });
  assert.equal(count, 0);
  const stats = await bidirectionalSyncAppleReminders([{ line: '- [ ] Native write', id: 'a1' }], { listName: 'Reminders', bidirectionalSync: true, syncOnChange: false, syncIntervalMinutes: 0, vaultImportPath: 'Inbox.md' }, 'vault-first');
  assert.deepEqual(stats, { created: 0, updated: 0, deleted: 0, conflicts: 0 });
});

test('deferred wave C: Apple Reminders webhook rejects malformed payloads safely', () => {
  assert.deepEqual(normalizeAppleRemindersWebhookPayload(null), []);
  assert.deepEqual(normalizeAppleRemindersWebhookPayload(undefined), []);
  assert.deepEqual(normalizeAppleRemindersWebhookPayload('bad'), []);
  assert.deepEqual(normalizeAppleRemindersWebhookPayload({ reminders: [{ id: '   ', title: 'Blank id' }] }), []);
  assert.deepEqual(normalizeAppleRemindersWebhookPayload({ reminders: [{ id: 'a1]\n- [ ] Injected', title: 'Unsafe id' }] }), []);
  assert.deepEqual(normalizeAppleRemindersWebhookPayload({ reminders: [{ id: 'list:a1', title: 'Colon id' }] }), []);
  assert.equal(handleAppleRemindersWebhook({ reminders: [{ id: '   ', title: 'Blank id' }] }, { enabled: true }).reason, 'invalid-payload');
  assert.equal(handleAppleRemindersWebhook({ reminders: [{ id: 'list:a1', title: 'Colon id' }] }, { enabled: true }).reason, 'invalid-payload');
  assert.equal(handleAppleRemindersWebhook(null, { enabled: true }).reason, 'invalid-payload');
  assert.equal(handleAppleRemindersWebhook(undefined, { enabled: true }).reason, 'invalid-payload');
  assert.equal(handleAppleRemindersWebhook(42, { enabled: true }).reason, 'invalid-payload');
});

test('deferred wave C: Apple Reminders webhook bridge validates secret and converts reminders', () => {
  const disabled = handleAppleRemindersWebhook({ reminders: [] }, { enabled: false });
  assert.equal(disabled.reason, 'disabled');

  const rejected = handleAppleRemindersWebhook(createAppleRemindersWebhookPayload([{ id: 'a1', title: 'Buy milk', isCompleted: false }], { secret: 'bad' }), { enabled: true, secret: 'good' });
  assert.equal(rejected.reason, 'invalid-secret');

  const missingProtocol = handleAppleRemindersWebhook({ secret: 'good', reminders: [{ id: 'a1', title: 'Buy milk', isCompleted: false }] }, { enabled: true, secret: 'good' });
  assert.equal(missingProtocol.reason, 'invalid-payload');
  const wrongProtocol = handleAppleRemindersWebhook({ protocol: 'task-manager.apple-reminders.webhook.v0', secret: 'good', reminders: [{ id: 'a1', title: 'Buy milk', isCompleted: false }] }, { enabled: true, secret: 'good' });
  assert.equal(wrongProtocol.reason, 'invalid-payload');

  const legacyArray = handleAppleRemindersWebhook([{ id: 'legacy-a1', title: 'Legacy array', isCompleted: false }], { enabled: true });
  assert.equal(legacyArray.accepted, true);
  assert.deepEqual(legacyArray.lines, ['- [ ] Legacy array [id:: apple-reminder:legacy-a1]']);
  const legacyArrayWithSecretRequired = handleAppleRemindersWebhook([{ id: 'legacy-a1', title: 'Legacy array', isCompleted: false }], { enabled: true, secret: 'good' });
  assert.equal(legacyArrayWithSecretRequired.reason, 'invalid-secret');

  const unicodeSecretRejected = handleAppleRemindersWebhook(createAppleRemindersWebhookPayload([{ id: 'unicode-secret', title: 'Secret check', isCompleted: false }], { secret: 'Ā' }), { enabled: true, secret: 'Ȁ' });
  assert.equal(unicodeSecretRejected.reason, 'invalid-secret');

  const accepted = handleAppleRemindersWebhook(createAppleRemindersWebhookPayload([{ id: 'a1', title: 'Buy milk', dueDate: '2026-06-04T09:00:00', priority: 3, isCompleted: false }], { secret: 'good' }), { enabled: true, secret: 'good' });
  assert.equal(accepted.accepted, true);
  assert.deepEqual(accepted.lines, ['- [ ] Buy milk 📅 2026-06-04 🎯 high [id:: apple-reminder:a1]']);

  const invalidDueDate = handleAppleRemindersWebhook(createAppleRemindersWebhookPayload([{ id: 'a-invalid-date', title: 'Bad date', dueDate: '2026-02-31T09:00:00', isCompleted: false }]), { enabled: true });
  assert.equal(invalidDueDate.accepted, true);
  assert.equal(invalidDueDate.reminders[0].dueDate, undefined);
  assert.deepEqual(invalidDueDate.lines, ['- [ ] Bad date [id:: apple-reminder:a-invalid-date]']);

  const trailingTextDueDate = handleAppleRemindersWebhook(createAppleRemindersWebhookPayload([{ id: 'a-trailing-date', title: 'Trailing date', dueDate: '2026-06-04ish', isCompleted: false }]), { enabled: true });
  assert.equal(trailingTextDueDate.reminders[0].dueDate, undefined);
  assert.deepEqual(trailingTextDueDate.lines, ['- [ ] Trailing date [id:: apple-reminder:a-trailing-date]']);

  assert.equal(appleReminderToTaskLine({ id: 'a2', title: 'Done', isCompleted: true }), '- [x] Done [id:: apple-reminder:a2]');

  const notedLine = appleReminderToTaskLine({ id: 'a3', title: 'Call Pat', notes: 'Ask about launch', isCompleted: false });
  assert.equal(notedLine, '- [ ] Call Pat [id:: apple-reminder:a3]\n  - 💬 Ask about launch');
  assert.equal(parseMarkdownTaskLine(notedLine.split('\n')[0], 'Reminders Inbox.md', 1)?.metadata.id, 'apple-reminder:a3');
});

test('deferred wave C: Apple Reminders notes use scanner-compatible 💬 format for cross-service round-trip', () => {
  // Verify the second line of an imported Apple Reminder task matches the
  // TaskScanner comment pattern (/^\s*(?:[-*+]\s+)?💬\s+(.+)$/) so that
  // metadata.comments is populated when the vault is scanned, enabling notes
  // to be forwarded to Todoist / MS To Do / Google Tasks on subsequent syncs.
  const SCANNER_COMMENT_RE = /^\s*(?:[-*+]\s+)?💬\s+(.+)$/u;
  const line = appleReminderToTaskLine({ id: 'a-round-trip', title: 'Follow up', notes: 'Bring agenda', isCompleted: false });
  const commentLine = line.split('\n')[1];
  assert.ok(commentLine, 'Expected a second line containing the note');
  const match = commentLine.match(SCANNER_COMMENT_RE);
  assert.ok(match, `Comment line does not match scanner pattern: ${JSON.stringify(commentLine)}`);
  assert.equal(match[1], 'Bring agenda');
});

test('deferred wave C: Apple Reminders webhook import keeps title and note newlines inline', () => {
  const line = appleReminderToTaskLine({
    id: 'a4',
    title: 'First line\n- [ ] Injected title task',
    notes: 'Remember this\n- [ ] Injected note task',
    isCompleted: false,
  });

  assert.equal(line, '- [ ] First line - \\[ \\] Injected title task [id:: apple-reminder:a4]\n  - 💬 Remember this\n  - 💬 Injected note task');
  assert.equal(line.split('\n').filter((part) => /^\s*- \[[ x]\]/iu.test(part)).length, 1);
  assert.equal(parseMarkdownTaskLine(line.split('\n')[0], 'Reminders Inbox.md', 1)?.metadata.id, 'apple-reminder:a4');
});

test('todoist v2: plugin annotates newly created tasks with returned external IDs', async () => {
  const file = fileForPath('Tasks.md');
  let content = '- [ ] Original #todoist\n';
  const task = parseMarkdownTaskLine(content.trimEnd(), 'Tasks.md', 1);
  assert.ok(task);
  const plugin = Object.create(TaskManagerPlugin.prototype) as any;
  plugin.settings = normalizeTaskManagerSettings({});
  plugin.app = {
    vault: {
      getAbstractFileByPath: (path: string) => path === 'Tasks.md' ? file : null,
      process: async (_file: TFile, callback: (current: string) => string) => { content = callback(content); },
    },
  };

  const updatedKey = await plugin.annotateTaskWithTodoistId(task, 'todoist-created');

  assert.equal(content, '- [ ] Original #todoist [id:: todoist:todoist-created]\n');
  assert.equal(updatedKey, 'id:todoist:todoist-created');
});

test('Todoist post-write duplicate IDs retain failure without advancing identity state', async () => {
  const originalFetch = globalThis.fetch;
  let readCount = 0;
  const remote = (content: string) => ({
    id: 'duplicate-id',
    content,
    description: '',
    priority: 1,
    labels: ['todoist'],
    added_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  });
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    if ((init?.method ?? 'GET') === 'POST') {
      return { ok: true, status: 200, json: async () => remote('Original') } as Response;
    }
    readCount += 1;
    return {
      ok: true,
      status: 200,
      json: async () => ({
        results: readCount === 1 ? [] : [remote('Original'), remote('Conflicting duplicate')],
        next_cursor: null,
      }),
    } as Response;
  }) as typeof fetch;

  const local = parseMarkdownTaskLine('- [ ] Original #todoist', 'Tasks.md', 1);
  assert.ok(local);
  const mapper = new IdentityMapper();
  let persisted = false;
  const plugin = Object.create(TaskManagerPlugin.prototype) as TodoistSyncHarness;
  plugin.settings = normalizeTaskManagerSettings({ todoistSyncEnabled: true, todoistApiKey: 'token' });
  plugin.app = { vault: { getAbstractFileByPath: () => null } } as unknown as App;
  plugin.stateStore = { loadState: async () => ({}) };
  plugin.identityMapper = mapper;
  plugin.scanVaultTasks = async () => [local];
  plugin.persistState = async () => { persisted = true; };

  try {
    await plugin.syncTodoist();
    assert.equal(readCount, 2);
    assert.equal(mapper.getExternalId(local.key, 'todoist'), undefined);
    assert.equal(plugin.settings.syncLastSuccessTodoist, '');
    assert.equal(plugin.settings.syncRunHistory[0]?.outcome, 'failed');
    assert.match(plugin.settings.syncRunHistory[0]?.details ?? '', /duplicate task id duplicate-id/u);
    assert.equal(persisted, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('wave D fix: Google Calendar sync reuses persisted task-to-event mapping', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method?: string; body?: Record<string, unknown> }> = [];
  let storedSyncIds: string[] = [];
  let remoteExists = false;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
    calls.push({ url: String(url), method: init?.method, body });
    if (init?.method === 'GET') {
      return remoteExists
        ? { ok: true, status: 200, json: async () => ({ ...body, id: body.id ?? 'created-event' }) } as Response
        : { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) } as Response;
    }
    if (init?.method === 'POST') remoteExists = true;
    return { ok: true, status: 200, json: async () => ({ ...body, id: body.id ?? 'created-event' }) } as Response;
  }) as typeof fetch;

  const calendarTask = parseMarkdownTaskLine('- [ ] Meet client #google-calendar 📅 2026-06-18 🆔 calendar-meet', 'Tasks.md', 1);
  assert.ok(calendarTask);
  const plugin = Object.create(TaskManagerPlugin.prototype) as any;
  plugin.settings = normalizeTaskManagerSettings({ googleCalendarEnabled: true, googleCalendarAccessToken: 'token', googleCalendarId: 'primary' });
  plugin.apiV1 = { getAllTasks: () => [calendarTask] };
  plugin.taskIndex = new TaskIndex();
  plugin.taskIndex.commit(new Map([[calendarTask.filePath, [calendarTask]]]));
  plugin.taskIndex.markReady();
  plugin.stateStore = {
    getExternalSyncIds: async () => storedSyncIds,
    updateExternalSyncIds: async (_key: string, transform: (current: string[]) => string[]) => { storedSyncIds = transform(storedSyncIds); return storedSyncIds; },
  };
  plugin.saveSettings = async () => undefined;

  try {
    await plugin.syncGoogleCalendar();
    await plugin.syncGoogleCalendar();

    assert.equal(calls.length, 3);
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[1].method, 'POST');
    assert.equal(calls[2].method, 'PATCH');
    const createdId = String(calls[1].body?.id ?? '');
    assert.match(createdId, /^otm[0-9a-f]{64}$/u);
    assert.equal(calls[2].url.endsWith(`/events/${createdId}`), true);
    assert.equal(calls[2].body?.id, createdId);
    assert.ok(storedSyncIds.some((entry) => entry.startsWith('task-map:') && entry.includes(createdId)));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('wave D fix: Google Calendar checkpoints each successful mapping before a later failure', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  let posts = 0;
  let storedSyncIds: string[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    if (init?.method === 'GET') return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) } as Response;
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as Record<string, unknown> : {};
    if (init?.method === 'POST') {
      posts += 1;
      if (posts === 2) return { ok: false, status: 503, statusText: 'Unavailable', json: async () => ({ error: { message: 'later failure' } }) } as Response;
    }
    return { ok: true, status: 200, json: async () => ({ ...body, id: posts === 1 ? 'checkpointed-event' : body.id }) } as Response;
  }) as typeof fetch;

  const firstTask = parseMarkdownTaskLine('- [ ] First #google-calendar 📅 2026-06-18 🆔 calendar-first', 'Tasks.md', 1);
  const secondTask = parseMarkdownTaskLine('- [ ] Second #google-calendar 📅 2026-06-19 🆔 calendar-second', 'Tasks.md', 2);
  assert.ok(firstTask);
  assert.ok(secondTask);
  const tasks = [firstTask, secondTask];
  const plugin = Object.create(TaskManagerPlugin.prototype) as any;
  plugin.settings = normalizeTaskManagerSettings({ googleCalendarEnabled: true, googleCalendarAccessToken: 'token', googleCalendarId: 'primary' });
  plugin.apiV1 = { getAllTasks: () => tasks };
  plugin.taskIndex = new TaskIndex();
  plugin.taskIndex.commit(new Map([[firstTask.filePath, tasks]]));
  plugin.taskIndex.markReady();
  plugin.stateStore = {
    getExternalSyncIds: async () => storedSyncIds,
    updateExternalSyncIds: async (_key: string, transform: (current: string[]) => string[]) => { storedSyncIds = transform(storedSyncIds); return storedSyncIds; },
  };
  plugin.saveSettings = async () => undefined;

  try {
    await plugin.syncGoogleCalendar();
    assert.equal(calls, 4);
    assert.ok(storedSyncIds.some((entry) => entry.startsWith('task-map:') && entry.includes('checkpointed-event')));
    assert.equal(plugin.settings.syncLastSuccessGoogleCalendar, '');
    assert.equal(plugin.settings.syncRunHistory[0].outcome, 'failed');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('deferred wave C: Google Tasks dry-run does not import or save vault state', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ items: [{ id: 'g1', title: 'Dry run task', status: 'needsAction' }] }) } as Response)) as typeof fetch;
  let created = false;
  let appended = false;
  let savedData = false;
  let savedSettings = false;
  const plugin = Object.create(TaskManagerPlugin.prototype) as any;
  plugin.settings = normalizeTaskManagerSettings({ googleTasksEnabled: true, googleTasksAccessToken: 'token', googleTasksDryRun: true, googleTasksInboxPath: 'Google Tasks Inbox.md' });
  plugin.app = { vault: { getAbstractFileByPath: () => null, create: async () => { created = true; }, append: async () => { appended = true; } } };
  plugin.stateStore = { loadState: async () => ({}) };
  plugin.persistState = async () => { savedData = true; };
  plugin.appendSyncConflictReport = async () => undefined;
  plugin.saveSettings = async () => { savedSettings = true; };
  plugin.getScannableFiles = () => [];
  plugin.scanner = { scanFile: async () => [] };
  try {
    await plugin.syncGoogleTasks();
    assert.equal(created, false);
    assert.equal(appended, false);
    assert.equal(savedData, false);
    assert.equal(savedSettings, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Google Tasks dry-run never refreshes or persists credentials', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => { fetchCalled = true; throw new Error('unexpected fetch'); }) as typeof fetch;
  let savedSettings = false;
  const plugin = Object.create(TaskManagerPlugin.prototype) as CredentialDryRunHarness;
  plugin.settings = normalizeTaskManagerSettings({ googleTasksEnabled: true, googleTasksRefreshToken: 'refresh', googleTasksDryRun: true });
  plugin.stateStore = { loadState: async () => ({}) };
  plugin.saveSettings = async () => { savedSettings = true; };
  try {
    await plugin.syncGoogleTasks();
    assert.equal(fetchCalled, false);
    assert.equal(savedSettings, false);
    assert.equal(plugin.settings.googleTasksAccessToken, '');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('wave D fix: Google Tasks no-token command opens PKCE code flow URL', async () => {
  const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalFetch = globalThis.fetch;
  const originalModalOpen = GoogleTasksOAuthModal.prototype.open;
  let openedUrl = '';
  let fetchCalled = false;
  let modalOpened = false;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: { open: (url?: string | URL) => { openedUrl = String(url ?? ''); return null; } },
  });
  globalThis.fetch = (async () => {
    fetchCalled = true;
    throw new Error('unexpected fetch');
  }) as typeof fetch;
  GoogleTasksOAuthModal.prototype.open = function (this: GoogleTasksOAuthModal): void {
    modalOpened = true;
  };
  const plugin = Object.create(TaskManagerPlugin.prototype) as GoogleTasksSyncHarness;
  plugin.settings = normalizeTaskManagerSettings({ googleTasksEnabled: true, googleTasksOAuthClientId: 'client-123' });
  try {
    await plugin.syncGoogleTasks();
    const url = new URL(openedUrl);
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('client_id'), 'client-123');
    assert.equal(url.searchParams.get('access_type'), 'offline');
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.ok(url.searchParams.get('code_challenge'));
    assert.ok(url.searchParams.get('state'));
    assert.equal(modalOpened, true);
    assert.equal(fetchCalled, false);
  } finally {
    GoogleTasksOAuthModal.prototype.open = originalModalOpen;
    globalThis.fetch = originalFetch;
    if (originalWindowDescriptor) Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('wave D fix: Google Tasks no-token command can start setup before sync is enabled', async () => {
  const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalModalOpen = GoogleTasksOAuthModal.prototype.open;
  let openedUrl = '';
  let modalOpened = false;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: { open: (url?: string | URL) => { openedUrl = String(url ?? ''); return null; } },
  });
  GoogleTasksOAuthModal.prototype.open = function (this: GoogleTasksOAuthModal): void {
    modalOpened = true;
  };
  const plugin = Object.create(TaskManagerPlugin.prototype) as GoogleTasksSyncHarness;
  plugin.settings = normalizeTaskManagerSettings({ googleTasksEnabled: false, googleTasksOAuthClientId: 'client-123' });
  try {
    await plugin.syncGoogleTasks();
    const url = new URL(openedUrl);
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('client_id'), 'client-123');
    assert.equal(modalOpened, true);
  } finally {
    GoogleTasksOAuthModal.prototype.open = originalModalOpen;
    if (originalWindowDescriptor) Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('wave D fix: Google Tasks OAuth modal exchanges PKCE code and saves tokens', async () => {
  const originalFetch = globalThis.fetch;
  let savedSettings = false;
  let requestBody = '';
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requestBody = String(init?.body ?? '');
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'access-new', refresh_token: 'refresh-new', expires_in: 3600 }),
    } as Response;
  }) as typeof fetch;

  const plugin = {
    settings: normalizeTaskManagerSettings({ googleTasksOAuthClientId: 'client-123' }),
    saveSettings: async () => { savedSettings = true; },
  } as unknown as TaskManagerPlugin;
  const modal = new GoogleTasksOAuthModal({} as unknown as App, plugin, { codeVerifier: 'verifier-123', state: 'state-123' });
  const harness = modal as unknown as { codeInput: string; exchangePkce(): Promise<void> };
  harness.codeInput = 'http://localhost:42813/oauth/google-tasks/callback?code=code-123&state=state-123';

  try {
    await harness.exchangePkce();
    assert.match(requestBody, /grant_type=authorization_code/u);
    assert.match(requestBody, /code=code-123/u);
    assert.match(requestBody, /code_verifier=verifier-123/u);
    assert.equal(plugin.settings.googleTasksAccessToken, 'access-new');
    assert.equal(plugin.settings.googleTasksRefreshToken, 'refresh-new');
    assert.equal(plugin.settings.googleTasksEnabled, true);
    assert.equal(savedSettings, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('wave D fix: Google Tasks OAuth modal rejects raw codes when state is active', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    throw new Error(`unexpected fetch: ${String(init?.body ?? '')}`);
  }) as typeof fetch;

  const plugin = {
    settings: normalizeTaskManagerSettings({ googleTasksOAuthClientId: 'client-123' }),
    saveSettings: async () => undefined,
  } as unknown as TaskManagerPlugin;
  const modal = new GoogleTasksOAuthModal({} as unknown as App, plugin, { codeVerifier: 'verifier-123', state: 'state-123' });
  const harness = modal as unknown as { codeInput: string; exchangePkce(): Promise<void> };
  harness.codeInput = 'raw-code-123';

  try {
    await harness.exchangePkce();
    assert.equal(plugin.settings.googleTasksAccessToken, '');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('wave D fix: Google Tasks API-key-only plugin sync never issues writeback PATCH', async () => {
  const originalFetch = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    methods.push(init?.method ?? 'GET');
    return { ok: true, status: 200, json: async () => ({ items: [] }) } as Response;
  }) as typeof fetch;
  let savedData = false;
  const plugin = Object.create(TaskManagerPlugin.prototype) as any;
  plugin.settings = normalizeTaskManagerSettings({ googleTasksEnabled: true, googleTasksApiKey: 'AIza-legacy', googleTasksInboxPath: 'Google Tasks Inbox.md' });
  plugin.app = { vault: { getAbstractFileByPath: () => null, create: async () => undefined, append: async () => undefined } };
  plugin.stateStore = { loadState: async () => ({}) };
  plugin.persistState = async () => { savedData = true; };
  plugin.appendSyncConflictReport = async () => undefined;
  plugin.saveSettings = async () => undefined;
  plugin.getScannableFiles = () => [{}];
  plugin.scanner = { scanFile: async () => [task({ status: 'done', checkbox: 'x', metadata: { dates: {}, invalidDates: {}, priority: 'normal', dependsOn: [], id: 'google-tasks:g1' } })] };
  try {
    await plugin.syncGoogleTasks();
    assert.deepEqual(methods, ['GET']);
    assert.equal(savedData, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('wave D fix: Google Tasks completion writeback failure records partial sync without last-success timestamp', async () => {
  const originalFetch = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    methods.push(method);
    if (method === 'PATCH') {
      return { ok: false, status: 500, text: async () => 'server error' } as Response;
    }
    return { ok: true, status: 200, json: async () => ({ items: [{ id: 'g1', title: 'Review spec', notes: '', due: '2026-06-01T00:00:00.000Z', status: 'needsAction', etag: '"e1"' }] }) } as Response;
  }) as typeof fetch;
  let savedIds: string[] = [];
  let savedSettings = false;
  const plugin = Object.create(TaskManagerPlugin.prototype) as any;
  plugin.settings = normalizeTaskManagerSettings({ googleTasksEnabled: true, googleTasksAccessToken: 'token', googleTasksInboxPath: 'Google Tasks Inbox.md' });
  plugin.app = { vault: { getAbstractFileByPath: () => null, create: async () => undefined, append: async () => undefined } };
  const local = task({ key: 'id:google-tasks:g1', status: 'done', checkbox: 'x', metadata: { dates: {}, invalidDates: {}, priority: 'normal', dependsOn: [], id: 'google-tasks:g1' } });
  const mapper = new IdentityMapper();
  mapper.recordBaseline(local.key, 'google-tasks', { title: 'Review spec', description: '', due: '2026-06-01', status: 'needsAction' });
  plugin.identityMapper = mapper;
  plugin.stateStore = { loadState: async () => ({}) };
  plugin.persistState = async () => { savedIds = ['g1']; };
  plugin.appendSyncConflictReport = async () => undefined;
  plugin.saveSettings = async () => { savedSettings = true; };
  plugin.getScannableFiles = () => [{}];
  plugin.scanner = { scanFile: async () => [local] };
  try {
    await plugin.syncGoogleTasks();
    assert.deepEqual(methods, ['GET', 'PATCH']);
    assert.equal(savedSettings, false);
    assert.deepEqual(savedIds, ['g1']);
    assert.equal(plugin.settings.syncLastSuccessGoogleTasks, '');
    assert.equal(plugin.settings.syncRunHistory[0].outcome, 'partial');
    assert.match(plugin.settings.syncRunHistory[0].details, /conflicts=1/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('deferred wave C: Microsoft To Do plugin sync does not mark success on Graph failure', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url).endsWith('/me/todo/lists')) {
      return { ok: true, status: 200, json: async () => ({ value: [{ id: 'default-list', wellknownListName: 'defaultList' }] }) } as Response;
    }
    return { ok: false, status: 500, json: async () => ({}) } as Response;
  }) as typeof fetch;
  let savedData = false;
  let savedSettings = false;
  const plugin = Object.create(TaskManagerPlugin.prototype) as any;
  plugin.settings = normalizeTaskManagerSettings({ msToDoEnabled: true, msToDoToken: 'token', msToDoInboxPath: 'MS To Do Inbox.md' });
  plugin.stateStore = { loadState: async () => ({}) };
  plugin.persistState = async () => { savedData = true; };
  plugin.appendSyncConflictReport = async () => undefined;
  plugin.saveSettings = async () => { savedSettings = true; };
  plugin.app = { vault: { getAbstractFileByPath: () => null, create: async () => undefined, append: async () => undefined } };
  plugin.getScannableFiles = () => [];
  plugin.scanner = { scanFile: async () => [] };
  try {
    await plugin.syncMsToDo();
    assert.equal(savedData, false, 'failed complete-snapshot preflight must not persist untouched reconciliation state');
    assert.equal(savedSettings, false);
    assert.equal(plugin.settings.syncLastSuccessMsToDo, '');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('wave D fix: Microsoft To Do dry-run does not persist synced IDs or last success', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url).endsWith('/me/todo/lists')) {
      return { ok: true, status: 200, json: async () => ({ value: [{ id: 'default-list', wellknownListName: 'defaultList' }] }) } as Response;
    }
    return { ok: true, status: 200, json: async () => ({ value: [{ id: 'm1', title: 'Dry run task', status: 'notStarted', isReminderOn: false }] }) } as Response;
  }) as typeof fetch;
  let created = false;
  let appended = false;
  let savedData = false;
  let savedSettings = false;
  const plugin = Object.create(TaskManagerPlugin.prototype) as any;
  plugin.settings = normalizeTaskManagerSettings({ msToDoEnabled: true, msToDoToken: 'token', msToDoDryRun: true, msToDoInboxPath: 'MS To Do Inbox.md' });
  plugin.stateStore = { loadState: async () => ({}) };
  plugin.persistState = async () => { savedData = true; };
  plugin.appendSyncConflictReport = async () => undefined;
  plugin.saveSettings = async () => { savedSettings = true; };
  plugin.app = { vault: { getAbstractFileByPath: () => null, create: async () => { created = true; }, append: async () => { appended = true; } } };
  plugin.getScannableFiles = () => [];
  plugin.scanner = { scanFile: async () => [] };
  try {
    await plugin.syncMsToDo();
    assert.equal(created, false);
    assert.equal(appended, false);
    assert.equal(savedData, false);
    assert.equal(savedSettings, false);
    assert.equal(plugin.settings.syncLastSuccessMsToDo, '');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Microsoft To Do dry-run never refreshes or persists credentials', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = (async () => { fetchCalled = true; throw new Error('unexpected fetch'); }) as typeof fetch;
  let savedSettings = false;
  const plugin = Object.create(TaskManagerPlugin.prototype) as CredentialDryRunHarness;
  plugin.settings = normalizeTaskManagerSettings({ msToDoEnabled: true, msToDoRefreshToken: 'refresh', msToDoDryRun: true });
  plugin.saveSettings = async () => { savedSettings = true; };
  try {
    await plugin.syncMsToDo();
    assert.equal(fetchCalled, false);
    assert.equal(savedSettings, false);
    assert.equal(plugin.settings.msToDoToken, '');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('wave D fix: Microsoft To Do no-token command opens PKCE code flow URL', async () => {
  const originalWindowDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalModalOpen = MicrosoftTodoOAuthModal.prototype.open;
  let openedUrl = '';
  let modalOpened = false;
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    writable: true,
    value: { open: (url?: string | URL) => { openedUrl = String(url ?? ''); return null; } },
  });
  MicrosoftTodoOAuthModal.prototype.open = function (this: MicrosoftTodoOAuthModal): void {
    modalOpened = true;
  };
  const plugin = Object.create(TaskManagerPlugin.prototype) as any;
  plugin.settings = normalizeTaskManagerSettings({ msToDoEnabled: true, msToDoClientId: 'client-123' });
  plugin.saveSettings = async () => undefined;
  try {
    await plugin.syncMsToDo();
    const url = new URL(openedUrl);
    assert.equal(url.searchParams.get('response_type'), 'code');
    assert.equal(url.searchParams.get('client_id'), 'client-123');
    assert.ok(url.searchParams.get('code_challenge'));
    assert.ok(url.searchParams.get('state'));
    assert.equal(modalOpened, true);
    const helper = await microsoftTodoPkceOAuthStart('client-123', { codeVerifier: 'a'.repeat(64), state: 'state-1' });
    assert.equal(new URL(helper.authorizationUrl).searchParams.get('response_type'), 'code');
  } finally {
    MicrosoftTodoOAuthModal.prototype.open = originalModalOpen;
    if (originalWindowDescriptor) Object.defineProperty(globalThis, 'window', originalWindowDescriptor);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('wave D fix: Microsoft To Do OAuth modal exchanges PKCE callback and saves tokens', async () => {
  const originalFetch = globalThis.fetch;
  let savedSettings = false;
  let requestBody = '';
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requestBody = String(init?.body ?? '');
    return {
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'ms-access-new', refresh_token: 'ms-refresh-new', expires_in: 3600 }),
    } as Response;
  }) as typeof fetch;

  const plugin = {
    settings: normalizeTaskManagerSettings({ msToDoClientId: 'client-123' }),
    saveSettings: async () => { savedSettings = true; },
  } as unknown as TaskManagerPlugin;
  const modal = new MicrosoftTodoOAuthModal({} as unknown as App, plugin, { codeVerifier: 'verifier-123', state: 'state-123' });
  const harness = modal as unknown as { codeInput: string; exchangePkce(): Promise<void> };
  harness.codeInput = 'https://login.microsoftonline.com/common/oauth2/nativeclient?code=code-123&state=state-123';

  try {
    await harness.exchangePkce();
    assert.match(requestBody, /grant_type=authorization_code/u);
    assert.match(requestBody, /code=code-123/u);
    assert.match(requestBody, /code_verifier=verifier-123/u);
    assert.equal(plugin.settings.msToDoToken, 'ms-access-new');
    assert.equal(plugin.settings.msToDoRefreshToken, 'ms-refresh-new');
    assert.equal(plugin.settings.msToDoEnabled, true);
    assert.equal(savedSettings, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('wave D3: Apple webhook payload helpers expose schema and idempotency plan', () => {
  const payload = createAppleRemindersWebhookPayload([
    { id: 'a1', title: 'Buy milk', isCompleted: false },
    { id: 'a2', title: 'Call Pat', isCompleted: false, priority: 2 },
    { id: 'a2', title: 'Call Pat duplicate', isCompleted: false },
  ], { secret: 'secret', listName: 'Reminders' });

  assert.equal(payload.protocol, APPLE_REMINDERS_WEBHOOK_PROTOCOL);
  assert.equal(payload.secret, 'secret');
  assert.deepEqual([...collectAppleReminderIds('- [ ] Existing [id:: apple-reminder:a1]\n')], ['a1']);

  const plan = planAppleRemindersWebhookImport(payload, { enabled: true, secret: 'secret' }, '- [ ] Existing [id:: apple-reminder:a1]\n');
  assert.equal(plan.accepted, true);
  assert.deepEqual(plan.newLines, ['- [ ] Call Pat 🎯 medium [id:: apple-reminder:a2]']);
  assert.deepEqual(plan.skippedDuplicateIds, ['a1', 'a2']);
});

test('wave D3: Apple service-first refresh updates only newer managed reminders', () => {
  const existing = '- [ ] Old title [id:: apple-reminder:a1] [apple-modified:: 2026-07-10T10:00:00.000Z]\n  - 💬 Old note\n- [ ] Local-only [id:: local]\n';
  const payload = createAppleRemindersWebhookPayload([
    { id: 'a1', title: 'New title', notes: 'New note', isCompleted: true, modifiedDate: '2026-07-11T10:00:00Z' },
  ]);

  const serviceFirst = planAppleRemindersWebhookImport(payload, { enabled: true }, existing, true);
  assert.deepEqual(serviceFirst.updatedIds, ['a1']);
  assert.match(serviceFirst.updatedMarkdown, /- \[x\] New title \[id:: apple-reminder:a1\] \[apple-modified:: 2026-07-11T10:00:00.000Z\]/u);
  assert.match(serviceFirst.updatedMarkdown, /  - 💬 New note/u);
  assert.match(serviceFirst.updatedMarkdown, /Local-only/u);

  const vaultFirst = planAppleRemindersWebhookImport(payload, { enabled: true }, existing, false);
  assert.deepEqual(vaultFirst.updatedIds, []);
  assert.equal(vaultFirst.updatedMarkdown, existing);
});

test('deferred wave C: plugin Apple webhook import writes only when bridge is enabled', async () => {
  const files = new Map<string, string>();
  const vault = {
    getAbstractFileByPath(path: string) { return files.has(path) ? fileForPath(path) : null; },
    async read(file: TFile) { return files.get(file.path) ?? ''; },
    async append(file: TFile, content: string) { files.set(file.path, `${files.get(file.path) ?? ''}${content}`); },
    async process(file: TFile, callback: (content: string) => string) { const next = callback(files.get(file.path) ?? ''); files.set(file.path, next); return next; },
    async create(path: string, content: string) { files.set(path, content); return fileForPath(path); },
  };
  const plugin = Object.create(TaskManagerPlugin.prototype) as any;
  plugin.app = { vault };
  plugin.settings = normalizeTaskManagerSettings({ appleRemindersEnabled: true, appleRemindersWebhookEnabled: true, appleRemindersWebhookSecret: 'secret', appleRemindersInboxPath: 'Reminders Inbox.md' });
  plugin.saveSettings = async () => undefined;

  const result = await plugin.importAppleRemindersWebhookPayload(createAppleRemindersWebhookPayload([{ id: 'a1', title: 'Buy milk', isCompleted: false }], { secret: 'secret' }));
  assert.deepEqual(result, { imported: 1, accepted: true });
  assert.equal(files.get('Reminders Inbox.md'), '- [ ] Buy milk [id:: apple-reminder:a1]\n');
});

test('wave D fix: Apple webhook import requires parent Apple Reminders integration', async () => {
  const files = new Map<string, string>();
  const vault = {
    getAbstractFileByPath(path: string) { return files.has(path) ? fileForPath(path) : null; },
    async read(file: TFile) { return files.get(file.path) ?? ''; },
    async append(file: TFile, content: string) { files.set(file.path, `${files.get(file.path) ?? ''}${content}`); },
    async create(path: string, content: string) { files.set(path, content); return fileForPath(path); },
  };
  const plugin = Object.create(TaskManagerPlugin.prototype) as any;
  plugin.app = { vault };
  plugin.settings = normalizeTaskManagerSettings({ appleRemindersEnabled: false, appleRemindersWebhookEnabled: true, appleRemindersWebhookSecret: 'secret', appleRemindersInboxPath: 'Reminders Inbox.md' });
  plugin.saveSettings = async () => undefined;

  const result = await plugin.importAppleRemindersWebhookPayload({ secret: 'secret', reminders: [{ id: 'a1', title: 'Buy milk', isCompleted: false }] });
  assert.deepEqual(result, { imported: 0, accepted: false, reason: 'disabled' });
  assert.equal(files.has('Reminders Inbox.md'), false);
});

test('MicrosoftTodoAdapter.toServicePayload maps in_progress to inProgress and deferred to deferred', () => {
  const adapter = new MicrosoftTodoAdapter({ accessToken: 'token', listId: 'list', bidirectionalSync: false, syncIntervalMinutes: 0, vaultImportPath: 'Inbox.md' });

  // in_progress vault task → Graph inProgress
  const inProgressPayload = adapter.toServicePayload(task({ status: 'in_progress', checkbox: '/', rawLine: '- [/] Review spec 📅 2026-06-01' }));
  assert.equal(inProgressPayload.status, 'inProgress', 'in_progress vault task should map to inProgress Graph status');

  // deferred vault task → Graph deferred
  const deferredPayload = adapter.toServicePayload(task({ status: 'deferred', checkbox: '>', rawLine: '- [>] Review spec 📅 2026-06-01' }));
  assert.equal(deferredPayload.status, 'deferred', 'deferred vault task should map to deferred Graph status');

  // todo vault task → Graph notStarted (regression guard)
  const todoPayload = adapter.toServicePayload(task({ status: 'todo', checkbox: ' ' }));
  assert.equal(todoPayload.status, 'notStarted', 'todo vault task should remain notStarted');

  // done vault task → Graph completed (regression guard)
  const donePayload = adapter.toServicePayload(task({ status: 'done', checkbox: 'x', rawLine: '- [x] Review spec' }));
  assert.equal(donePayload.status, 'completed', 'done vault task should map to completed');

  // cancelled vault task → Graph notStarted (MS Todo has no cancelled state)
  const cancelledPayload = adapter.toServicePayload(task({ status: 'cancelled', checkbox: '-', rawLine: '- [-] Review spec' }));
  assert.equal(cancelledPayload.status, undefined, 'cancelled has no Graph equivalent and must not be guessed');
});

test('MicrosoftTodoAdapter.fromServicePayload maps inProgress and deferred back to vault statuses', () => {
  const adapter = new MicrosoftTodoAdapter({ accessToken: 'token', listId: 'list', bidirectionalSync: false, syncIntervalMinutes: 0, vaultImportPath: 'Inbox.md' });

  const inProgressTask = adapter.fromServicePayload({ id: 'm-ip', title: 'In progress task', status: 'inProgress', isReminderOn: false }, 'Tasks.md');
  assert.equal(inProgressTask.status, 'in_progress', 'Graph inProgress should map to in_progress vault status');
  assert.equal(inProgressTask.checkbox, '/', 'Graph inProgress should use the parseable in-progress checkbox');
  assert.equal(parseMarkdownTaskLine(inProgressTask.rawLine, 'Tasks.md', 1)?.status, 'in_progress');

  const deferredTask = adapter.fromServicePayload({ id: 'm-df', title: 'Deferred task', status: 'deferred', isReminderOn: false }, 'Tasks.md');
  assert.equal(deferredTask.status, 'deferred', 'Graph deferred should map to deferred vault status');
  assert.equal(deferredTask.checkbox, '>', 'Graph deferred should use the parseable deferred checkbox');
  assert.equal(parseMarkdownTaskLine(deferredTask.rawLine, 'Tasks.md', 1)?.status, 'deferred');

  const completedTask = adapter.fromServicePayload({ id: 'm-done', title: 'Done task', status: 'completed', isReminderOn: false }, 'Tasks.md');
  assert.equal(completedTask.status, 'done', 'Graph completed should map to done vault status (regression guard)');

  const notStartedTask = adapter.fromServicePayload({ id: 'm-ns', title: 'Not started', status: 'notStarted', isReminderOn: false }, 'Tasks.md');
  assert.equal(notStartedTask.status, 'todo', 'Graph notStarted should map to todo vault status (regression guard)');
});

test('fetchGoogleTasks follows nextPageToken pagination', async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = (async (url: string | URL | Request) => {
    callCount++;
    const urlStr = String(url);
    if (urlStr.includes('pageToken=page2')) {
      return { ok: true, status: 200, json: async () => ({ items: [{ id: 'g2', title: 'Task 2', status: 'needsAction' }] }) } as Response;
    }
    return { ok: true, status: 200, json: async () => ({ items: [{ id: 'g1', title: 'Task 1', status: 'needsAction' }], nextPageToken: 'page2' }) } as Response;
  }) as typeof fetch;
  try {
    const tasks = await fetchGoogleTasks({ accessToken: 'ya29.token', listId: '@default' });
    assert.equal(callCount, 2, 'should make 2 requests for 2 pages');
    assert.equal(tasks.length, 2, 'should return tasks from both pages');
    assert.equal(tasks[0].id, 'g1');
    assert.equal(tasks[1].id, 'g2');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('fetchGoogleTasks rejects repeated nextPageToken pagination loops', async () => {
  const originalFetch = globalThis.fetch;
  let callCount = 0;
  globalThis.fetch = (async () => {
    callCount++;
    return {
      ok: true,
      status: 200,
      json: async () => ({ items: [{ id: `g${callCount}`, title: `Task ${callCount}`, status: 'needsAction' }], nextPageToken: 'same-page' }),
    } as Response;
  }) as typeof fetch;
  try {
    await assert.rejects(
      () => fetchGoogleTasks({ accessToken: 'ya29.token', listId: '@default' }),
      /repeated nextPageToken/u,
    );
    assert.equal(callCount, 2, 'should stop before issuing a third request for the repeated token');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('resolveMicrosoftTodoConflict honors the conflict strategy', () => {
  const vaultVersion: MicrosoftTodoTask = { id: 'v', title: 'Vault edit', isReminderOn: false };
  const serviceVersion: MicrosoftTodoTask = { id: 's', title: 'Service edit', isReminderOn: true };

  // vault-first (also the default) must return the vault copy by reference.
  assert.strictEqual(resolveMicrosoftTodoConflict(vaultVersion, serviceVersion, 'vault-first'), vaultVersion);
  assert.strictEqual(resolveMicrosoftTodoConflict(vaultVersion, serviceVersion), vaultVersion);
  // service-first must return the service copy by reference.
  assert.strictEqual(resolveMicrosoftTodoConflict(vaultVersion, serviceVersion, 'service-first'), serviceVersion);
});

// ── CalDAV plugin sync command ──────────────────────────────────────────────

test('syncCalDAV does nothing when the service is disabled', async () => {
  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { fetchCalled = true; return { ok: true, status: 200, text: async () => '' } as Response; }) as typeof fetch;
  const plugin = Object.create(TaskManagerPlugin.prototype) as any;
  plugin.settings = normalizeTaskManagerSettings({ caldavSyncEnabled: false });
  plugin.saveSettings = async () => { throw new Error('should not save settings'); };
  try {
    await plugin.syncCalDAV();
    assert.equal(fetchCalled, false, 'a disabled sync must not make any network requests');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('syncCalDAV does nothing when server/username/password are not fully configured', async () => {
  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => { fetchCalled = true; return { ok: true, status: 200, text: async () => '' } as Response; }) as typeof fetch;
  const plugin = Object.create(TaskManagerPlugin.prototype) as any;
  plugin.settings = normalizeTaskManagerSettings({ caldavSyncEnabled: true, caldavServerUrl: 'https://caldav.example.com', caldavUsername: '', caldavPassword: '' });
  try {
    await plugin.syncCalDAV();
    assert.equal(fetchCalled, false, 'missing credentials must not make any network requests');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('syncCalDAV fails gracefully (no throw, no state change) when the server URL is not HTTPS', async () => {
  const plugin = Object.create(TaskManagerPlugin.prototype) as any;
  plugin.settings = normalizeTaskManagerSettings({ caldavSyncEnabled: true, caldavCalendarPath: '/calendar.ics', caldavServerUrl: 'http://caldav.example.com', caldavUsername: 'user', caldavPassword: 'pass' });
  let savedSettings = false;
  plugin.saveSettings = async () => { savedSettings = true; };
  await plugin.syncCalDAV();
  assert.equal(savedSettings, false);
  assert.equal(plugin.settings.syncLastSuccessCalDAV, '');
});

test('syncCalDAV reads, conditionally reconciles, fetches remote events, and records success', async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, options?: RequestInit) => {
    const method = options?.method ?? 'GET';
    calls.push(method);
    if (method === 'PUT') {
      assert.equal((options?.headers as Record<string, string>)?.['If-Match'], '"v1"');
      return { ok: true, status: 204, headers: new Headers({ etag: '"v2"' }), text: async () => '' } as Response;
    }
    return {
      ok: true,
      status: 200,
      headers: new Headers({ etag: '"v1"' }),
      text: async () => ['BEGIN:VCALENDAR', 'BEGIN:VTODO', 'UID:remote-1', 'SUMMARY:Remote task', 'END:VTODO', 'END:VCALENDAR'].join('\n'),
    } as Response;
  }) as typeof fetch;

  const targetPath = 'CalDAV Sync.md';
  const file = fileForPath(targetPath);
  let content = '';
  let savedSettings = false;
  const plugin = Object.create(TaskManagerPlugin.prototype) as any;
  plugin.settings = normalizeTaskManagerSettings({
    caldavSyncEnabled: true,
    caldavCalendarPath: '/calendar.ics',
    caldavAllowPrivateNetwork: true,
    caldavServerUrl: 'https://caldav.example.com',
    caldavUsername: 'user',
    caldavPassword: 'pass',
    caldavVaultPath: targetPath,
  });
  plugin.saveSettings = async () => { savedSettings = true; };
  plugin.apiV1 = { getAllTasks: () => [parseMarkdownTaskLine('- [ ] Local task [id:: local-task]', 'Tasks.md', 0)].filter((t): t is MarkdownTask => t !== null) };
  plugin.app = {
    vault: {
      getAbstractFileByPath: (path: string) => (path === targetPath ? file : null),
      process: async (_file: TFile, updater: (current: string) => string) => { content = updater(content); return content; },
      create: async (_path: string, next: string) => { content = next; return file; },
    },
  } as unknown as App;

  try {
    await plugin.syncCalDAV();

    assert.deepEqual(calls, ['GET', 'PUT'], 'sync must read and capture an ETag before any replacement');
    assert.match(content, /Remote task/);
    assert.equal(savedSettings, true);
    assert.notEqual(plugin.settings.syncLastSuccessCalDAV, '', 'a successful sync must record a last-success timestamp');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('syncCalDAV unload during deferred GET or PUT publishes no later effects', async (t) => {
  for (const phase of ['GET', 'PUT'] as const) {
    await t.test(phase, async (subtest) => {
      const originalFetch = globalThis.fetch;
      const originalWindow = globalThis.window;
      Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { clearTimeout: globalThis.clearTimeout, clearInterval: globalThis.clearInterval } });
      subtest.after(() => { globalThis.fetch = originalFetch; Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow }); });
      const entered = deferred<void>();
      const release = deferred<Response>();
      let transportSignal: AbortSignal | undefined;
      let vaultCalls = 0;
      let saves = 0;
      globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        if (phase === 'GET' || method === 'PUT') {
          transportSignal = init?.signal as AbortSignal | undefined;
          entered.resolve();
          return release.promise; // Deliberately ignores abort.
        }
        return new Response('BEGIN:VCALENDAR\nEND:VCALENDAR', { status: 200, headers: { etag: '"v1"' } });
      }) as typeof fetch;
      const plugin = Object.create(TaskManagerPlugin.prototype) as unknown as CalDAVSyncHarness;
      plugin.settings = normalizeTaskManagerSettings({ caldavSyncEnabled: true, caldavCalendarPath: '/calendar.ics', caldavAllowPrivateNetwork: true, caldavServerUrl: `https://${phase.toLowerCase()}.example.com`, caldavUsername: 'user', caldavPassword: 'pass', caldavVaultPath: 'Sync.md', syncRunHistory: [] });
      plugin.apiV1 = { getAllTasks: () => [parseMarkdownTaskLine('- [ ] Local [id:: local]', 'Tasks.md', 1)].filter((task): task is MarkdownTask => task !== null) };
      plugin.app = { vault: { getAbstractFileByPath: () => null, create: async () => { vaultCalls += 1; } } } as unknown as App;
      plugin.saveSettings = async () => { saves += 1; };
      const notices = (Notice as unknown as { messages: string[] }).messages;
      const run = plugin.syncCalDAV();
      await entered.promise;
      const noticesAtUnload = notices.length;
      plugin.onunload();
      assert.equal(transportSignal?.aborted, true);
      release.resolve(phase === 'GET'
        ? new Response('BEGIN:VCALENDAR\nEND:VCALENDAR', { status: 200, headers: { etag: '"v1"' } })
        : new Response(null, { status: 204 }));
      await run;
      await Promise.resolve();
      assert.equal(vaultCalls, 0);
      assert.equal(saves, 0);
      assert.equal(plugin.settings.syncLastSuccessCalDAV, '');
      assert.deepEqual(plugin.settings.syncRunHistory, []);
      assert.equal(notices.length, noticesAtUnload);
    });
  }
});

test('syncCalDAV settings-save fence suppresses runtime effects when unload occurs during persistence', async (context) => {
  const originalFetch = globalThis.fetch;
  const originalWindow = globalThis.window;
  Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: { clearTimeout: globalThis.clearTimeout, clearInterval: globalThis.clearInterval } });
  context.after(() => { globalThis.fetch = originalFetch; Object.defineProperty(globalThis, 'window', { configurable: true, writable: true, value: originalWindow }); });
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => (init?.method === 'PUT'
    ? new Response(null, { status: 204 })
    : new Response('BEGIN:VCALENDAR\nEND:VCALENDAR', { status: 200, headers: { etag: '"v1"' } }))) as typeof fetch;
  const saveEntered = deferred<void>();
  const saveRelease = deferred<void>();
  const target = fileForPath('Sync.md');
  const local = parseMarkdownTaskLine('- [ ] Local [id:: local]', 'Tasks.md', 1);
  assert.ok(local);
  let appearanceRefreshes = 0;
  let reminderRefreshes = 0;
  let scans = 0;
  let durableWrites = 0;
  const plugin = Object.create(TaskManagerPlugin.prototype) as unknown as CalDAVSettingsFenceHarness;
  plugin.settings = normalizeTaskManagerSettings({ caldavSyncEnabled: true, caldavCalendarPath: '/calendar.ics', caldavAllowPrivateNetwork: true, caldavServerUrl: 'https://save-fence.example.com', caldavUsername: 'user', caldavPassword: 'pass', caldavVaultPath: target.path, syncRunHistory: [] });
  plugin.taskIndex = new TaskIndex();
  plugin.taskIndex.commit(new Map([[local.filePath, [local]]]));
  plugin.taskIndex.markReady();
  plugin.app = { vault: { getAbstractFileByPath: () => target, process: async (_file: TFile, updater: (current: string) => string) => updater('') } } as unknown as App;
  plugin.stateStore = { saveSettings: async (_settings, shouldCommit = () => true) => { saveEntered.resolve(); await saveRelease.promise; if (!shouldCommit()) return false; durableWrites += 1; return true; } };
  plugin.reminderManager = { refreshCache: () => { reminderRefreshes += 1; } };
  plugin.appliedExcludedFoldersSignature = 'stale-exclusions';
  plugin.refreshAppearanceStyles = () => { appearanceRefreshes += 1; };
  plugin.scanVault = async () => { scans += 1; };
  const notices = (Notice as unknown as { messages: string[] }).messages;
  const run = plugin.syncCalDAV();
  await saveEntered.promise;
  const noticesAtUnload = notices.length;
  plugin.onunload();
  saveRelease.resolve();
  await run;
  assert.equal(appearanceRefreshes, 0);
  assert.equal(reminderRefreshes, 0);
  assert.equal(scans, 0);
  assert.equal(durableWrites, 0);
  assert.equal(plugin.settings.syncLastSuccessCalDAV, '');
  assert.deepEqual(plugin.settings.syncRunHistory, []);
  assert.equal(notices.length, noticesAtUnload);
});

test('syncCalDAV reports tasks skipped for missing durable IDs without advancing success', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    headers: new Headers({ etag: '"v1"' }),
    text: async () => 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR',
  }) as Response) as typeof fetch;

  const targetPath = 'CalDAV Sync.md';
  const file = fileForPath(targetPath);
  let vaultContent = '';
  let savedSettings = false;
  const plugin = Object.create(TaskManagerPlugin.prototype) as any;
  plugin.settings = normalizeTaskManagerSettings({
    caldavSyncEnabled: true,
    caldavCalendarPath: '/calendar.ics',
    caldavAllowPrivateNetwork: true,
    caldavServerUrl: 'https://caldav.example.com',
    caldavUsername: 'user',
    caldavPassword: 'pass',
    caldavVaultPath: targetPath,
    syncRunHistory: [],
  });
  plugin.saveSettings = async () => { savedSettings = true; };
  plugin.apiV1 = { getAllTasks: () => [parseMarkdownTaskLine('- [ ] No durable ID', 'Tasks.md', 0)].filter((t): t is MarkdownTask => t !== null) };
  plugin.app = { vault: {
    getAbstractFileByPath: () => file,
    process: async (_file: TFile, updater: (current: string) => string) => { vaultContent = updater(vaultContent); return vaultContent; },
  } } as unknown as App;

  try {
    await plugin.syncCalDAV();
    assert.equal(plugin.settings.syncLastSuccessCalDAV, '');
    assert.equal(savedSettings, false);
    assert.equal(plugin.settings.syncRunHistory[0]?.outcome, 'partial');
    assert.match(plugin.settings.syncRunHistory[0]?.details ?? '', /skipped=1/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('syncCalDAV does not record success or advance last-success when the read fails', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: false,
    status: 503,
    headers: new Headers(),
    text: async () => '',
  }) as Response) as typeof fetch;

  const plugin = Object.create(TaskManagerPlugin.prototype) as any;
  plugin.settings = normalizeTaskManagerSettings({
    caldavSyncEnabled: true,
    caldavCalendarPath: '/calendar.ics',
    caldavAllowPrivateNetwork: true,
    caldavServerUrl: 'https://caldav.example.com',
    caldavUsername: 'user',
    caldavPassword: 'pass',
    syncLastSuccessCalDAV: '2026-01-01T00:00:00.000Z',
    syncRunHistory: [],
  });
  let savedSettings = false;
  plugin.saveSettings = async () => { savedSettings = true; };
  plugin.apiV1 = { getAllTasks: () => [] };
  plugin.app = {} as App;

  try {
    await plugin.syncCalDAV();
    assert.equal(plugin.settings.syncLastSuccessCalDAV, '2026-01-01T00:00:00.000Z');
    assert.equal(savedSettings, false);
    assert.equal(plugin.settings.syncRunHistory.length, 1);
    assert.equal(plugin.settings.syncRunHistory[0].outcome, 'failed');
    assert.ok(!plugin.settings.syncRunHistory.some((run: { outcome: string }) => run.outcome === 'success'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});
