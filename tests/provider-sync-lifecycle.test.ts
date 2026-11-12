import test from 'node:test';
import assert from 'node:assert/strict';
import { type App, TFile } from 'obsidian';
import TaskManagerPlugin from '../src/main';
import { fetchGoogleTasks } from '../src/google-tasks-sync';
import { upsertGoogleCalendarEvent } from '../src/google-calendar-sync';
import { fetchMicrosoftTodoTasks } from '../src/microsoft-todo-sync';
import { TodoistAdapter } from '../src/todoist-sync';
import { commitProviderImports, isProviderRunCancellation, ProviderRunCancelledError, type ProviderRunContext } from '../src/provider-sync-safety';
import { SyncOperationQueue } from '../src/sync-operations';
import { StateStore } from '../src/state-store';
import { TaskIndex } from '../src/task-index';
import { normalizeTaskManagerSettings } from '../src/types';
import { createMockTask } from './test-utils';
import { parseMarkdownTaskLine } from '../src/task-model';

function contextState(): { context: ProviderRunContext; invalidate(): void } {
  const controller = new AbortController();
  let current = true;
  return {
    context: { generation: 1, signal: controller.signal, isCurrent: () => current && !controller.signal.aborted },
    invalidate: () => { current = false; controller.abort(); },
  };
}

async function withFetch(handler: typeof fetch, run: () => Promise<void>): Promise<void> {
  const previous = globalThis.fetch;
  globalThis.fetch = handler;
  try { await run(); } finally { globalThis.fetch = previous; }
}

test('provider request chains start no follow-up request after lifecycle invalidation', async (t) => {
  await t.test('Todoist update does not start close/reopen', async () => {
    const state = contextState();
    const calls: string[] = [];
    await withFetch((async (input) => {
      calls.push(String(input));
      state.invalidate();
      return new Response('', { status: 200 });
    }) as typeof fetch, async () => {
      const adapter = new TodoistAdapter({ apiKey: 'token', assertCurrent: () => {
        if (!state.context.isCurrent()) throw new ProviderRunCancelledError();
      } });
      await assert.rejects(
        adapter.update('task-1', { content: 'Changed', is_completed: true }),
        (error: unknown) => isProviderRunCancellation(error),
      );
    });
    assert.equal(calls.length, 1);
    assert.doesNotMatch(calls.join('\n'), /\/close|\/reopen/u);
  });

  await t.test('Google Tasks pagination stops after invalidation', async () => {
    const state = contextState();
    let calls = 0;
    await withFetch((async () => {
      calls += 1;
      state.invalidate();
      return Response.json({ items: [], nextPageToken: 'next' });
    }) as typeof fetch, async () => {
      await assert.rejects(fetchGoogleTasks({ accessToken: 'token', listId: 'list', signal: state.context.signal, assertCurrent: () => {
        if (!state.context.isCurrent()) throw new ProviderRunCancelledError();
      } }), (error: unknown) => isProviderRunCancellation(error));
    });
    assert.equal(calls, 1);
  });

  await t.test('Google Calendar preflight does not start create recovery', async () => {
    const state = contextState();
    const calls: string[] = [];
    await withFetch((async (input) => {
      calls.push(String(input));
      state.invalidate();
      return new Response('', { status: 404 });
    }) as typeof fetch, async () => {
      await assert.rejects(upsertGoogleCalendarEvent({ accessToken: 'token', calendarId: 'primary', signal: state.context.signal, assertCurrent: () => {
        if (!state.context.isCurrent()) throw new ProviderRunCancelledError();
      } }, { id: 'event-1', summary: 'Task', start: { date: '2026-07-14' }, end: { date: '2026-07-15' } }, { preflightCreate: true }), (error: unknown) => isProviderRunCancellation(error));
    });
    assert.equal(calls.length, 1);
  });

  await t.test('Microsoft list lookup does not start task page request', async () => {
    const state = contextState();
    const calls: string[] = [];
    await withFetch((async (input) => {
      calls.push(String(input));
      state.invalidate();
      return Response.json({ value: [{ id: 'list', wellknownListName: 'defaultList' }] });
    }) as typeof fetch, async () => {
      await assert.rejects(fetchMicrosoftTodoTasks({ accessToken: 'token', bidirectionalSync: false, syncIntervalMinutes: 0, vaultImportPath: 'Inbox.md', signal: state.context.signal, assertCurrent: () => {
        if (!state.context.isCurrent()) throw new ProviderRunCancelledError();
      } }), (error: unknown) => isProviderRunCancellation(error));
    });
    assert.equal(calls.length, 1);
    assert.match(calls[0], /\/me\/todo\/lists$/u);
  });
});

test('provider import transform commits no content after invalidation', async () => {
  const state = contextState();
  const file = Object.assign(Object.create(TFile.prototype), { path: 'Inbox.md', name: 'Inbox.md', extension: 'md', basename: 'Inbox' }) as TFile;
  let content = 'Existing\n';
  const app = { vault: {
    getAbstractFileByPath: () => file,
    process: async (_file: TFile, transform: (value: string) => string) => {
      state.invalidate();
      content = transform(content);
    },
  } } as unknown as App;
  await assert.rejects(commitProviderImports(app, file.path, 'google-tasks', [{ externalId: 'g1', markdown: '- [ ] Remote [id:: google-tasks:g1]', value: 'g1' }], state.context));
  assert.equal(content, 'Existing\n');
});

test('provider import folder creation starts no later parent after invalidation', async () => {
  const state = contextState();
  const folders: string[] = [];
  let fileCreates = 0;
  const app = { vault: {
    getAbstractFileByPath: () => null,
    createFolder: async (path: string) => { folders.push(path); state.invalidate(); },
    create: async () => { fileCreates += 1; },
  } } as unknown as App;

  await assert.rejects(
    commitProviderImports(app, 'A/B/Inbox.md', 'google-tasks', [{ externalId: 'g1', markdown: '- [ ] Remote [id:: google-tasks:g1]', value: 'g1' }], state.context),
    (error: unknown) => isProviderRunCancellation(error),
  );
  assert.deepEqual(folders, ['A']);
  assert.equal(fileCreates, 0);
});

test('persisted executing read-first operations become non-executable conflicts', async (t) => {
  for (const service of ['todoist', 'google-tasks', 'microsoft-todo'] as const) {
    await t.test(service, async () => {
      const queue = new SyncOperationQueue();
      queue.enqueueUpdate(createMockTask(), service, 'remote-1', { content: 'Changed' });
      const persisted = queue.getState();
      persisted.operations[0].status = 'executing';
      const restarted = new SyncOperationQueue(persisted);
      assert.equal(restarted.getOperation(persisted.operations[0].id)?.status, 'conflict');
      assert.deepEqual(restarted.getOperation(persisted.operations[0].id)?.payload, {});
      assert.equal((await restarted.generateDryRunOutput()).totalOperations, 0);
    });
  }
});

test('queue preserves executing evidence when an adapter reports lifecycle cancellation', async () => {
  const queue = new SyncOperationQueue();
  const operation = queue.enqueueCreate(createMockTask(), 'todoist', { content: 'Changed' });
  queue.registerAdapter('todoist', {
    getCapabilities: () => ({ service: 'todoist', status: 'stable', supports: { create: true, update: true, delete: true, reopen: true }, fields: {} }),
    isConfigured: async () => true,
    toServicePayload: () => ({}),
    fromServicePayload: () => createMockTask(),
    create: async () => { throw new ProviderRunCancelledError(); },
    update: async () => ({ hash: '' }),
    delete: async () => undefined,
    reopen: async () => undefined,
    fetchAll: async () => [],
    testConnection: async () => ({ ok: true }),
  });

  await assert.rejects(queue.executeAll(1, 'todoist'), (error: unknown) => isProviderRunCancellation(error));
  assert.equal(operation.status, 'executing');
  assert.equal(new SyncOperationQueue(queue.getState()).getOperation(operation.id)?.status, 'conflict');
});

test('external sync id predicate suppresses a queued post-invalidation commit', async () => {
  let release!: (value: { googleCalendarSyncedIds: string[] }) => void;
  const loaded = new Promise<{ googleCalendarSyncedIds: string[] }>((resolve) => { release = resolve; });
  let saves = 0;
  const store = new StateStore({ loadData: async () => loaded, saveData: async () => { saves += 1; } } as never);
  let current = true;
  const pending = store.updateExternalSyncIds('googleCalendarSyncedIds', (ids) => [...ids, 'new'], () => current);
  current = false;
  release({ googleCalendarSyncedIds: ['old'] });
  assert.deepEqual(await pending, ['old']);
  assert.equal(saves, 0);
});

test('plugin settings save reports a late lifecycle invalidation as an uncommitted result', async () => {
  const plugin = Object.create(TaskManagerPlugin.prototype) as TaskManagerPlugin & Record<string, unknown>;
  let current = true;
  let appearanceRefreshes = 0;
  Object.assign(plugin, {
    settings: normalizeTaskManagerSettings({}),
    appliedExcludedFoldersSignature: '',
    stateStore: {
      saveSettings: async () => { current = false; return true; },
    },
    refreshAppearanceStyles: () => { appearanceRefreshes += 1; },
    reminderManager: { refreshCache: () => undefined },
  });

  const committed = await plugin.saveSettings(() => current);

  assert.equal(committed, false);
  assert.equal(appearanceRefreshes, 0);
});

test('provider token refresh helpers fence settings publication and restore rejected candidates', async () => {
  await withFetch((async () => Response.json({ access_token: 'new-token', refresh_token: 'new-refresh', expires_in: 3600 })) as typeof fetch, async () => {
    const cases = [
      { method: 'refreshGoogleTasksTokenIfNeeded', settings: { googleTasksOAuthClientId: 'client', googleTasksRefreshToken: 'refresh' }, access: 'googleTasksAccessToken' },
      { method: 'refreshGoogleCalendarTokenIfNeeded', settings: { googleCalendarOAuthClientId: 'client', googleCalendarRefreshToken: 'refresh' }, access: 'googleCalendarAccessToken' },
      { method: 'refreshMicrosoftTodoTokenIfNeeded', settings: { msToDoClientId: 'client', msToDoRefreshToken: 'refresh' }, access: 'msToDoToken' },
    ] as const;
    for (const entry of cases) {
      const state = contextState();
      const plugin = Object.create(TaskManagerPlugin.prototype) as TaskManagerPlugin & Record<string, unknown>;
      Object.assign(plugin, {
        settings: normalizeTaskManagerSettings(entry.settings),
        networkAbortController: new AbortController(),
        saveSettings: async (predicate: () => boolean) => predicate(),
      });
      await (plugin as unknown as Record<string, (context: ProviderRunContext) => Promise<void>>)[entry.method](state.context);
      assert.equal((plugin.settings as unknown as Record<string, string>)[entry.access], 'new-token');
    }

    const state = contextState();
    const plugin = Object.create(TaskManagerPlugin.prototype) as TaskManagerPlugin & Record<string, unknown>;
    Object.assign(plugin, {
      settings: normalizeTaskManagerSettings({ googleTasksOAuthClientId: 'client', googleTasksRefreshToken: 'refresh' }),
      networkAbortController: new AbortController(),
      saveSettings: async () => false,
    });
    await assert.rejects(
      (plugin as unknown as { refreshGoogleTasksTokenIfNeeded(context: ProviderRunContext): Promise<void> }).refreshGoogleTasksTokenIfNeeded(state.context),
      (error: unknown) => isProviderRunCancellation(error),
    );
    assert.equal(plugin.settings.googleTasksAccessToken, '');
    assert.equal(plugin.settings.googleTasksRefreshToken, 'refresh');
  });
});

test('sync persistence fallback and conflict report writes honor current contexts', async () => {
  const state = contextState();
  const existing = Object.assign(Object.create(TFile.prototype), { path: 'Sync Conflicts.md', name: 'Sync Conflicts.md', extension: 'md', basename: 'Sync Conflicts' }) as TFile;
  let persisted = 0;
  let content = '# Sync Conflicts\n';
  const plugin = Object.create(TaskManagerPlugin.prototype) as TaskManagerPlugin & Record<string, unknown>;
  Object.assign(plugin, {
    settings: normalizeTaskManagerSettings({ syncConflictLogPath: existing.path }),
    syncStatePersistenceQueue: Promise.resolve(),
    identityStateRevision: 1,
    persistedIdentityStateRevision: 0,
    syncQueueRevision: 1,
    persistedSyncQueueRevision: 0,
    identityMapper: { getState: () => ({ identities: [], version: 2 }) },
    syncOperationQueue: new SyncOperationQueue(),
    stateStore: {},
    persistState: async () => { persisted += 1; },
    app: { vault: {
      getAbstractFileByPath: () => existing,
      process: async (_file: TFile, transform: (value: string) => string) => { content = transform(content); },
    } },
  });
  await (plugin as unknown as { persistSyncState(predicate: () => boolean): Promise<void> }).persistSyncState(state.context.isCurrent);
  assert.equal(persisted, 1);
  const report = (plugin as unknown as { appendSyncConflictReport(service: string, lines: string[], context: ProviderRunContext): Promise<void> }).appendSyncConflictReport.bind(plugin);
  await report('Todoist', ['- conflict'], state.context);
  assert.match(content, /Todoist conflicts/u);
  assert.match(content, /- conflict/u);

  let created = '';
  Object.assign((plugin.app as unknown as { vault: Record<string, unknown> }).vault, {
    getAbstractFileByPath: () => null,
    create: async (_path: string, value: string) => { created = value; },
  });
  await report('Google Tasks', ['- new conflict'], state.context);
  assert.match(created, /Google Tasks conflicts/u);
});

test('Todoist current run reports unhealthy, duplicate, and dry-run preflight outcomes without writes', async (t) => {
  await t.test('unhealthy index refusal', async () => {
    const taskIndex = new TaskIndex();
    taskIndex.beginHydration();
    taskIndex.markReady(true);
    const plugin = Object.create(TaskManagerPlugin.prototype) as TaskManagerPlugin & Record<string, unknown>;
    Object.assign(plugin, {
      lifecycleActive: true, lifecycleGeneration: 1, scanAbortController: new AbortController(), networkAbortController: new AbortController(), taskIndex,
      settings: normalizeTaskManagerSettings({ todoistSyncEnabled: true, todoistApiKey: 'token' }),
    });
    await (plugin as unknown as { syncTodoist(): Promise<void> }).syncTodoist();
    assert.equal(plugin.settings.syncRunHistory[0]?.outcome, 'failed');
    assert.match(plugin.settings.syncRunHistory[0]?.details ?? '', /degraded/u);
  });

  await t.test('duplicate local provider ID refusal', async () => {
    const first = parseMarkdownTaskLine('- [ ] First [id:: todoist:same]', 'A.md', 1);
    const second = parseMarkdownTaskLine('- [ ] Second [id:: todoist:same]', 'B.md', 1);
    assert.ok(first && second);
    const plugin = Object.create(TaskManagerPlugin.prototype) as TaskManagerPlugin & Record<string, unknown>;
    Object.assign(plugin, {
      lifecycleActive: true, lifecycleGeneration: 1, scanAbortController: new AbortController(), networkAbortController: new AbortController(),
      settings: normalizeTaskManagerSettings({ todoistSyncEnabled: true, todoistApiKey: 'token' }),
      requireHealthyIndexedTasks: async () => [first, second],
      stateStore: { loadState: async () => ({ identityState: { identities: [], version: 2 }, syncQueueState: { operations: [], completed: [], version: 2 } }) },
    });
    await (plugin as unknown as { syncTodoist(): Promise<void> }).syncTodoist();
    assert.equal(plugin.settings.syncRunHistory[0]?.outcome, 'failed');
    assert.match(plugin.settings.syncRunHistory[0]?.details ?? '', /duplicate vault ID same/u);
  });

  await t.test('current network failure publication', async () => {
    const taskIndex = new TaskIndex();
    taskIndex.commit(new Map());
    taskIndex.markReady();
    let state = { identityState: { identities: [], version: 2 as const }, syncQueueState: { operations: [], completed: [], version: 2 as const } };
    let saves = 0;
    const plugin = Object.create(TaskManagerPlugin.prototype) as TaskManagerPlugin & Record<string, unknown>;
    Object.assign(plugin, {
      lifecycleActive: true, lifecycleGeneration: 1, scanAbortController: new AbortController(), networkAbortController: new AbortController(), taskIndex,
      settings: normalizeTaskManagerSettings({ todoistSyncEnabled: true, todoistApiKey: 'token' }),
      stateStore: {
        loadState: async () => state,
        updateState: async (transform: (current: typeof state) => typeof state) => { state = transform(state); saves += 1; return state; },
      },
    });
    await withFetch((async () => { throw new TypeError('network down'); }) as typeof fetch, async () => {
      await (plugin as unknown as { syncTodoist(): Promise<void> }).syncTodoist();
    });
    assert.equal(plugin.settings.syncRunHistory[0]?.outcome, 'failed');
    assert.match(plugin.settings.syncRunHistory[0]?.details ?? '', /network down/u);
    assert.ok(saves > 0);
  });

  await t.test('dry-run preview', async () => {
    const task = parseMarkdownTaskLine('- [ ] Preview #todoist', 'Tasks.md', 1);
    assert.ok(task);
    const taskIndex = new TaskIndex();
    taskIndex.commit(new Map([['Tasks.md', [task]]]));
    taskIndex.markReady();
    const plugin = Object.create(TaskManagerPlugin.prototype) as TaskManagerPlugin & Record<string, unknown>;
    Object.assign(plugin, {
      lifecycleActive: true, lifecycleGeneration: 1, scanAbortController: new AbortController(), networkAbortController: new AbortController(), taskIndex,
      settings: normalizeTaskManagerSettings({ todoistSyncEnabled: true, todoistApiKey: 'token', todoistDryRun: true }),
      stateStore: { loadState: async () => ({ identityState: { identities: [], version: 2 }, syncQueueState: { operations: [], completed: [], version: 2 } }) },
    });
    await withFetch((async () => Response.json({ results: [], next_cursor: null })) as typeof fetch, async () => {
      await (plugin as unknown as { syncTodoist(): Promise<void> }).syncTodoist();
    });
    assert.deepEqual(plugin.settings.syncRunHistory, []);
  });
});

test('Todoist current lifecycle run checkpoints, verifies, publishes, and clears a successful create', async () => {
  const file = Object.assign(Object.create(TFile.prototype), { path: 'Tasks.md', name: 'Tasks.md', extension: 'md', basename: 'Tasks' }) as TFile;
  let content = '- [ ] Original #todoist\n';
  const task = parseMarkdownTaskLine(content.trimEnd(), file.path, 1);
  assert.ok(task);
  const remote = {
    id: 'created-1', content: 'Original', description: '', priority: 1, labels: [],
    added_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', completed_at: null,
  };
  let reads = 0;
  let saves = 0;
  await withFetch((async (_input, init) => {
    if ((init?.method ?? 'GET') === 'POST') return Response.json(remote);
    reads += 1;
    return Response.json({ results: reads === 1 ? [] : [remote], next_cursor: null });
  }) as typeof fetch, async () => {
    const taskIndex = new TaskIndex();
    taskIndex.commit(new Map([[file.path, [task]]]));
    taskIndex.markReady();
    let persistedState = { identityState: { identities: [], version: 2 as const }, syncQueueState: { operations: [], completed: [], version: 2 as const } };
    const plugin = Object.create(TaskManagerPlugin.prototype) as TaskManagerPlugin & Record<string, unknown>;
    Object.assign(plugin, {
      lifecycleActive: true,
      lifecycleGeneration: 1,
      scanAbortController: new AbortController(),
      networkAbortController: new AbortController(),
      taskIndex,
      settings: normalizeTaskManagerSettings({ todoistSyncEnabled: true, todoistApiKey: 'token' }),
      stateStore: {
        loadState: async () => persistedState,
        updateState: async (transform: (state: typeof persistedState) => typeof persistedState, options?: { shouldCommit?: () => boolean }) => {
          assert.equal(options?.shouldCommit?.(), true);
          persistedState = transform(persistedState);
          saves += 1;
          return persistedState;
        },
      },
      app: { vault: {
        getAbstractFileByPath: (path: string) => path === file.path ? file : null,
        process: async (_file: TFile, transform: (value: string) => string) => { content = transform(content); },
      } },
      saveSettings: async (predicate: () => boolean) => predicate(),
    });

    await (plugin as unknown as { syncTodoist(): Promise<void> }).syncTodoist();

    assert.equal(reads, 2);
    assert.match(content, /\[id:: todoist:created-1\]/u);
    const queueState = (plugin as unknown as { syncOperationQueue?: SyncOperationQueue }).syncOperationQueue?.getState();
    assert.equal(plugin.settings.syncRunHistory[0]?.outcome, 'success', `${plugin.settings.syncRunHistory[0]?.details}; ${JSON.stringify(queueState?.operations)}`);
    assert.ok(plugin.settings.syncLastSuccessTodoist);
    assert.equal((persistedState.syncQueueState.operations ?? []).length, 0);
    assert.equal(persistedState.identityState.identities.length, 2, 'pre-annotation and durable-ID task keys both retain the verified mapping');
    assert.ok(saves >= 2, 'intent and verified state must both be checkpointed');
  });
});

test('Todoist command cancellation is quiet and publishes no vault/state/history effects', async () => {
  const originalFetch = globalThis.fetch;
  let release!: (response: Response) => void;
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  globalThis.fetch = (async () => {
    entered();
    return new Promise<Response>((resolve) => { release = resolve; });
  }) as typeof fetch;

  const plugin = Object.create(TaskManagerPlugin.prototype) as TaskManagerPlugin & Record<string, unknown>;
  const taskIndex = new TaskIndex();
  taskIndex.commit(new Map());
  taskIndex.markReady();
  let persisted = 0;
  let vaultWrites = 0;
  const controller = new AbortController();
  Object.assign(plugin, {
    lifecycleActive: true,
    lifecycleGeneration: 1,
    scanAbortController: new AbortController(),
    networkAbortController: controller,
    providerSyncCoordinator: undefined,
    settings: normalizeTaskManagerSettings({ todoistSyncEnabled: true, todoistApiKey: 'token' }),
    taskIndex,
    stateStore: { loadState: async () => ({ identityState: { identities: [], version: 2 }, syncQueueState: { operations: [], completed: [], version: 2 } }) },
    app: { vault: { getAbstractFileByPath: () => null, create: async () => { vaultWrites += 1; } } },
    persistState: async () => { persisted += 1; },
    saveSettings: async () => true,
  });
  try {
    const pending = (plugin as unknown as { syncTodoist(): Promise<void> }).syncTodoist();
    await started;
    Object.assign(plugin, { lifecycleActive: false, lifecycleGeneration: 2, networkAbortController: null });
    controller.abort();
    release(Response.json({ results: [], next_cursor: null }));
    await pending;
    assert.equal(vaultWrites, 0);
    assert.equal(persisted, 0);
    assert.deepEqual(plugin.settings.syncRunHistory, []);
  } finally {
    release?.(Response.json({ results: [], next_cursor: null }));
    globalThis.fetch = originalFetch;
  }
});
