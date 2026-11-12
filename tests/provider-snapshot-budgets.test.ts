import test from 'node:test';
import assert from 'node:assert/strict';
import TaskManagerPlugin from '../src/main';
import { accumulateGoogleTasksSnapshotBudget, fetchGoogleTasks } from '../src/google-tasks-sync';
import { accumulateMicrosoftTodoSnapshotBudget, fetchMicrosoftTodoTasks } from '../src/microsoft-todo-sync';
import { utf8ByteLength } from '../src/input-budgets';
import { TaskIndex } from '../src/task-index';
import { normalizeTaskManagerSettings } from '../src/types';

async function withFetch(handler: typeof fetch, run: () => Promise<void>): Promise<void> {
  const previous = globalThis.fetch;
  globalThis.fetch = handler;
  try { await run(); } finally { globalThis.fetch = previous; }
}

const googleTask = (id: string) => ({ id, title: `Task ${id}`, status: 'needsAction' });
const microsoftTask = (id: string) => ({ id, title: `Task ${id}`, status: 'notStarted', isReminderOn: false });

test('provider snapshot accumulators enforce task, UTF-8 byte, and exact-boundary budgets', () => {
  for (const accumulate of [accumulateGoogleTasksSnapshotBudget, accumulateMicrosoftTodoSnapshotBudget]) {
    const item = { title: '😀' };
    const bytes = utf8ByteLength(JSON.stringify(item));
    assert.equal(accumulate(0, 0, item, { maxTasks: 1, maxBytes: bytes }), bytes);
    assert.throws(() => accumulate(1, 0, item, { maxTasks: 1, maxBytes: bytes }), /exceeded 1 tasks/u);
    assert.throws(() => accumulate(0, 1, item, { maxTasks: 1, maxBytes: bytes }), /aggregate bytes/u);
  }
});

test('Google Tasks rejects oversized pages, fields, tokens, duplicates, and page overflow', async (t) => {
  await t.test('page and field bounds', async () => {
    await withFetch((async () => Response.json({ items: Array.from({ length: 101 }, (_value, index) => googleTask(`g${index}`)) })) as typeof fetch, async () => {
      await assert.rejects(fetchGoogleTasks({ accessToken: 'token', listId: 'list' }), /page exceeded 100 tasks/u);
    });
    await withFetch((async () => Response.json({ items: [{ ...googleTask('g1'), title: 'x'.repeat(4097) }] })) as typeof fetch, async () => {
      await assert.rejects(fetchGoogleTasks({ accessToken: 'token', listId: 'list' }), /title exceeded 4096 bytes/u);
    });
  });

  await t.test('token and duplicate bounds', async () => {
    await withFetch((async () => Response.json({ items: [], nextPageToken: 'x'.repeat(4097) })) as typeof fetch, async () => {
      await assert.rejects(fetchGoogleTasks({ accessToken: 'token', listId: 'list' }), /nextPageToken exceeded 4096 bytes/u);
    });
    let page = 0;
    await withFetch((async () => {
      page += 1;
      return Response.json(page === 1
        ? { items: [googleTask('same')], nextPageToken: 'page-2' }
        : { items: [googleTask('same')] });
    }) as typeof fetch, async () => {
      await assert.rejects(fetchGoogleTasks({ accessToken: 'token', listId: 'list' }), /duplicate task id same/u);
    });
  });

  await t.test('exactly 200 pages are allowed and page 201 is never requested', async () => {
    let calls = 0;
    await withFetch((async () => {
      calls += 1;
      return Response.json({ items: [], ...(calls < 200 ? { nextPageToken: `page-${calls + 1}` } : {}) });
    }) as typeof fetch, async () => {
      assert.deepEqual(await fetchGoogleTasks({ accessToken: 'token', listId: 'list' }), []);
    });
    assert.equal(calls, 200);

    calls = 0;
    await withFetch((async () => {
      calls += 1;
      return Response.json({ items: [], nextPageToken: `page-${calls + 1}` });
    }) as typeof fetch, async () => {
      await assert.rejects(fetchGoogleTasks({ accessToken: 'token', listId: 'list' }), /exceeded 200 pages/u);
    });
    assert.equal(calls, 200);
  });
});

test('Microsoft To Do rejects oversized pages, fields, links, duplicates, and page overflow', async (t) => {
  const config = { accessToken: 'token', listId: 'list', bidirectionalSync: false, syncIntervalMinutes: 0, vaultImportPath: 'Inbox.md' };
  await t.test('partial list discovery fails closed', async () => {
    await withFetch((async () => Response.json({
      value: [{ id: 'first-list', displayName: 'First' }],
      '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/todo/lists?$skiptoken=page2',
    })) as typeof fetch, async () => {
      await assert.rejects(
        fetchMicrosoftTodoTasks({ ...config, listId: '' }),
        /partial paginated collection/u,
      );
    });
  });
  await t.test('page and field bounds', async () => {
    await withFetch((async () => Response.json({ value: Array.from({ length: 101 }, (_value, index) => microsoftTask(`m${index}`)) })) as typeof fetch, async () => {
      await assert.rejects(fetchMicrosoftTodoTasks(config), /page exceeding 100 tasks/u);
    });
    await withFetch((async () => Response.json({ value: [{ ...microsoftTask('m1'), title: 'x'.repeat(1025) }] })) as typeof fetch, async () => {
      await assert.rejects(fetchMicrosoftTodoTasks(config), /invalid task at page item 1/u);
    });
  });

  await t.test('next-link and duplicate bounds', async () => {
    const oversized = `https://graph.microsoft.com/v1.0/me/todo/lists/list/tasks?$skiptoken=${'x'.repeat(17000)}`;
    await withFetch((async () => Response.json({ value: [], '@odata.nextLink': oversized })) as typeof fetch, async () => {
      await assert.rejects(fetchMicrosoftTodoTasks(config), /next page URL exceeded 16384 bytes/u);
    });
    let page = 0;
    await withFetch((async () => {
      page += 1;
      return Response.json(page === 1
        ? { value: [microsoftTask('same')], '@odata.nextLink': 'https://graph.microsoft.com/v1.0/me/todo/lists/list/tasks?$skiptoken=page2' }
        : { value: [microsoftTask('same')] });
    }) as typeof fetch, async () => {
      await assert.rejects(fetchMicrosoftTodoTasks(config), /duplicate task id same/u);
    });
  });

  await t.test('exactly 200 pages are allowed and page 201 is never requested', async () => {
    let calls = 0;
    await withFetch((async () => {
      calls += 1;
      return Response.json({ value: [], ...(calls < 200 ? { '@odata.nextLink': `https://graph.microsoft.com/v1.0/me/todo/lists/list/tasks?$skiptoken=page${calls + 1}` } : {}) });
    }) as typeof fetch, async () => {
      assert.deepEqual(await fetchMicrosoftTodoTasks(config), []);
    });
    assert.equal(calls, 200);

    calls = 0;
    await withFetch((async () => {
      calls += 1;
      return Response.json({ value: [], '@odata.nextLink': `https://graph.microsoft.com/v1.0/me/todo/lists/list/tasks?$skiptoken=page${calls + 1}` });
    }) as typeof fetch, async () => {
      await assert.rejects(fetchMicrosoftTodoTasks(config), /terminate safely/u);
    });
    assert.equal(calls, 200);
  });
});

function pluginHarness(provider: 'google' | 'microsoft'): { plugin: TaskManagerPlugin & Record<string, unknown>; persisted(): number } {
  const taskIndex = new TaskIndex();
  taskIndex.commit(new Map());
  taskIndex.markReady();
  let persistenceCalls = 0;
  const plugin = Object.create(TaskManagerPlugin.prototype) as TaskManagerPlugin & Record<string, unknown>;
  Object.assign(plugin, {
    lifecycleActive: true,
    lifecycleGeneration: 1,
    scanAbortController: new AbortController(),
    networkAbortController: new AbortController(),
    taskIndex,
    providerSyncCoordinator: undefined,
    settings: normalizeTaskManagerSettings(provider === 'google'
      ? { googleTasksEnabled: true, googleTasksAccessToken: 'token', googleTasksListId: 'list' }
      : { msToDoEnabled: true, msToDoToken: 'token', msToDoListId: 'list' }),
    stateStore: { loadState: async () => ({ identityState: { identities: [], version: 2 }, syncQueueState: { operations: [], completed: [], version: 2 } }) },
    app: { vault: { getAbstractFileByPath: () => null } },
    persistState: async () => { persistenceCalls += 1; },
    saveSettings: async () => true,
  });
  return { plugin, persisted: () => persistenceCalls };
}

test('over-budget provider snapshots do not publish mapper, queue, import, or sync-state effects', async (t) => {
  await t.test('Google Tasks', async () => {
    const harness = pluginHarness('google');
    await withFetch((async () => Response.json({ items: Array.from({ length: 101 }, (_value, index) => googleTask(`g${index}`)) })) as typeof fetch, async () => {
      await (harness.plugin as unknown as { syncGoogleTasks(): Promise<void> }).syncGoogleTasks();
    });
    const runtime = harness.plugin as unknown as { identityMapper?: unknown; syncOperationQueue?: unknown };
    assert.equal(runtime.identityMapper, undefined);
    assert.equal(runtime.syncOperationQueue, undefined);
    assert.equal(harness.persisted(), 0);
  });

  await t.test('Microsoft To Do', async () => {
    const harness = pluginHarness('microsoft');
    await withFetch((async () => Response.json({ value: Array.from({ length: 101 }, (_value, index) => microsoftTask(`m${index}`)) })) as typeof fetch, async () => {
      await (harness.plugin as unknown as { syncMsToDo(): Promise<void> }).syncMsToDo();
    });
    const runtime = harness.plugin as unknown as { identityMapper?: unknown; syncOperationQueue?: unknown };
    assert.equal(runtime.identityMapper, undefined);
    assert.equal(runtime.syncOperationQueue, undefined);
    assert.equal(harness.persisted(), 0);
  });

  await t.test('Google staged token refresh rolls back on oversized snapshot', async () => {
    const harness = pluginHarness('google');
    harness.plugin.settings = normalizeTaskManagerSettings({
      googleTasksEnabled: true,
      googleTasksOAuthClientId: 'client',
      googleTasksRefreshToken: 'old-refresh',
      googleTasksListId: 'list',
    });
    let settingsSaves = 0;
    Object.assign(harness.plugin, { saveSettings: async () => { settingsSaves += 1; return true; } });
    await withFetch((async (input) => String(input).includes('oauth2.googleapis.com/token')
      ? Response.json({ access_token: 'new-access', refresh_token: 'rotated-refresh', expires_in: 3600 })
      : Response.json({ items: Array.from({ length: 101 }, (_value, index) => googleTask(`g${index}`)) })) as typeof fetch, async () => {
      await (harness.plugin as unknown as { syncGoogleTasks(): Promise<void> }).syncGoogleTasks();
    });
    assert.equal(settingsSaves, 0);
    assert.equal(harness.plugin.settings.googleTasksAccessToken, '');
    assert.equal(harness.plugin.settings.googleTasksRefreshToken, 'old-refresh');
  });

  await t.test('Microsoft staged token refresh rolls back on pre-snapshot path failure', async () => {
    const harness = pluginHarness('microsoft');
    harness.plugin.settings = normalizeTaskManagerSettings({
      msToDoEnabled: true,
      msToDoClientId: 'client',
      msToDoRefreshToken: 'old-refresh',
      msToDoInboxPath: '../invalid',
    });
    let settingsSaves = 0;
    Object.assign(harness.plugin, { saveSettings: async () => { settingsSaves += 1; return true; } });
    await withFetch((async () => Response.json({ access_token: 'new-access', refresh_token: 'rotated-refresh', expires_in: 3600 })) as typeof fetch, async () => {
      await (harness.plugin as unknown as { syncMsToDo(): Promise<void> }).syncMsToDo();
    });
    assert.equal(settingsSaves, 0);
    assert.equal(harness.plugin.settings.msToDoToken, '');
    assert.equal(harness.plugin.settings.msToDoRefreshToken, 'old-refresh');
    assert.equal(harness.plugin.settings.syncRunHistory[0]?.outcome, 'failed');
  });

  await t.test('Microsoft staged token refresh rolls back on oversized snapshot', async () => {
    const harness = pluginHarness('microsoft');
    harness.plugin.settings = normalizeTaskManagerSettings({
      msToDoEnabled: true,
      msToDoClientId: 'client',
      msToDoRefreshToken: 'old-refresh',
      msToDoListId: 'list',
    });
    let settingsSaves = 0;
    Object.assign(harness.plugin, { saveSettings: async () => { settingsSaves += 1; return true; } });
    await withFetch((async (input) => String(input).includes('login.microsoftonline.com')
      ? Response.json({ access_token: 'new-access', refresh_token: 'rotated-refresh', expires_in: 3600 })
      : Response.json({ value: Array.from({ length: 101 }, (_value, index) => microsoftTask(`m${index}`)) })) as typeof fetch, async () => {
      await (harness.plugin as unknown as { syncMsToDo(): Promise<void> }).syncMsToDo();
    });
    assert.equal(settingsSaves, 0);
    assert.equal(harness.plugin.settings.msToDoToken, '');
    assert.equal(harness.plugin.settings.msToDoRefreshToken, 'old-refresh');
  });
});
