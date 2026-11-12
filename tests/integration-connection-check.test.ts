import test from 'node:test';
import assert from 'node:assert/strict';
import { TodoistAdapter } from '../src/todoist-sync';
import { GoogleTasksAdapter } from '../src/google-tasks-sync';
import { testGoogleCalendarConnection } from '../src/google-calendar-sync';
import { MicrosoftTodoAdapter } from '../src/microsoft-todo-sync';
import TaskManagerPlugin from '../src/main';
import { DEFAULT_SETTINGS } from '../src/types';

async function withFetch(handler: typeof fetch, run: () => Promise<void>): Promise<void> {
  const previous = globalThis.fetch;
  globalThis.fetch = handler;
  try { await run(); } finally { globalThis.fetch = previous; }
}

test('provider connection checks perform bounded authenticated reads', async () => {
  const calls: Array<{ url: string; method: string; authorization: string | null }> = [];
  await withFetch((async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    calls.push({ url, method: init?.method ?? 'GET', authorization: headers.get('authorization') });
    if (url.includes('api.todoist.com/api/v1/projects?limit=1')) return Response.json({ results: [], next_cursor: null });
    if (url.includes('tasks.googleapis.com')) return Response.json({ items: [] });
    if (url.includes('calendar/v3/calendars/')) return Response.json({ items: [] });
    if (url.endsWith('/v1.0/me/todo/lists')) return Response.json({ value: [{ id: 'default-list', displayName: 'Tasks', wellknownListName: 'defaultList' }] });
    return Response.json({ error: { message: 'unexpected route' } }, { status: 404 });
  }) as typeof fetch, async () => {
    assert.deepEqual(await new TodoistAdapter({ apiKey: 'todoist-token' }).testConnection(), { ok: true });
    assert.deepEqual(await new GoogleTasksAdapter({ accessToken: 'google-token', listId: '@default' }).testConnection(), { ok: true });
    await testGoogleCalendarConnection({ accessToken: 'calendar-token', calendarId: 'primary' });
    assert.deepEqual(await new MicrosoftTodoAdapter({
      accessToken: 'microsoft-token',
      listId: '',
      bidirectionalSync: false,
      syncIntervalMinutes: 0,
      vaultImportPath: 'Inbox.md',
    }).testConnection(), { ok: true });
  });

  assert.equal(calls.length, 4);
  assert.equal(calls[0]?.url, 'https://api.todoist.com/api/v1/projects?limit=1');
  assert.equal(calls.every((call) => call.method === 'GET'), true, 'connection checks must be read-only');
  assert.equal(calls.every((call) => call.authorization?.startsWith('Bearer ')), true);
});

test('plugin connection facades perform the authenticated provider reads', async () => {
  await withFetch((async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes('api.todoist.com/api/v1/projects?limit=1')) return Response.json({ results: [], next_cursor: null });
    if (url.includes('tasks.googleapis.com')) return Response.json({ items: [] });
    if (url.includes('calendar/v3/calendars/')) return Response.json({ items: [] });
    if (url.endsWith('/v1.0/me/todo/lists')) return Response.json({ value: [{ id: 'default-list', displayName: 'Tasks', wellknownListName: 'defaultList' }] });
    if (url.includes('caldav.example.com')) return new Response('BEGIN:VCALENDAR\nEND:VCALENDAR', { status: 200 });
    return Response.json({ error: { message: 'unexpected route' } }, { status: 404 });
  }) as typeof fetch, async () => {
    const plugin = Object.create(TaskManagerPlugin.prototype) as TaskManagerPlugin;
    Object.assign(plugin, {
      settings: {
        ...structuredClone(DEFAULT_SETTINGS),
        todoistApiKey: 'todoist-token',
        googleTasksAccessToken: 'google-token',
        googleCalendarAccessToken: 'calendar-token',
        msToDoToken: 'microsoft-token',
        caldavAllowPrivateNetwork: true,
        caldavServerUrl: 'https://caldav.example.com',
        caldavCalendarPath: '/calendar.ics',
        caldavUsername: 'user',
        caldavPassword: 'pass',
      },
      networkAbortController: new AbortController(),
    });
    for (const [provider, result] of [
      ['Todoist', await plugin.testTodoistConnection()],
      ['Google Tasks', await plugin.testGoogleTasksConnection()],
      ['Google Calendar', await plugin.testGoogleCalendarConnection()],
      ['Microsoft To Do', await plugin.testMicrosoftTodoConnection()],
      ['CalDAV', await plugin.testCalDAVConnection()],
    ] as const) assert.equal(result.success, true, `${provider}: ${result.message}`);
  });
});

test('CalDAV connection facade uses and obeys the plugin lifecycle signal', async () => {
  const previous = globalThis.fetch;
  let resolveFetch!: (response: Response) => void;
  let resolveEntered!: () => void;
  const entered = new Promise<void>((resolve) => { resolveEntered = resolve; });
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const signal = init?.signal as AbortSignal;
    assert.equal(signal.aborted, false);
    resolveEntered();
    return new Promise<Response>((finish) => { resolveFetch = finish; });
  }) as typeof fetch;
  const controller = new AbortController();
  const plugin = Object.create(TaskManagerPlugin.prototype) as TaskManagerPlugin;
  Object.assign(plugin, {
    settings: { ...structuredClone(DEFAULT_SETTINGS), caldavAllowPrivateNetwork: true, caldavServerUrl: 'https://signal.example.com', caldavUsername: 'user', caldavPassword: 'pass' },
    networkAbortController: controller,
  });
  try {
    const resultPromise = plugin.testCalDAVConnection();
    await entered;
    controller.abort();
    const result = await resultPromise;
    assert.equal(result.success, false);
    assert.match(result.message, /cancelled/u);
    resolveFetch(new Response('BEGIN:VCALENDAR\nEND:VCALENDAR', { status: 200 }));
  } finally {
    globalThis.fetch = previous;
  }
});

test('CalDAV connection facade refuses post-unload starts and stale controller results', async (t) => {
  await t.test('after unload', async () => {
    let fetches = 0;
    await withFetch((async () => { fetches += 1; return new Response('', { status: 200 }); }) as typeof fetch, async () => {
      const plugin = Object.create(TaskManagerPlugin.prototype) as TaskManagerPlugin;
      Object.assign(plugin, {
        settings: { ...structuredClone(DEFAULT_SETTINGS), caldavAllowPrivateNetwork: true, caldavServerUrl: 'https://stale.example.com', caldavUsername: 'user', caldavPassword: 'pass' },
        lifecycleActive: false,
        lifecycleGeneration: 2,
        scanAbortController: null,
        networkAbortController: null,
      });
      const result = await plugin.testCalDAVConnection();
      assert.equal(result.success, false);
      assert.match(result.message, /cancelled/u);
      assert.equal(fetches, 0);
    });
  });

  await t.test('controller rollover', async () => {
    let resolveFetch!: (response: Response) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    await withFetch((async () => { entered(); return new Promise<Response>((resolve) => { resolveFetch = resolve; }); }) as typeof fetch, async () => {
      const plugin = Object.create(TaskManagerPlugin.prototype) as TaskManagerPlugin;
      const originalController = new AbortController();
      Object.assign(plugin, {
        settings: { ...structuredClone(DEFAULT_SETTINGS), caldavAllowPrivateNetwork: true, caldavServerUrl: 'https://rollover.example.com', caldavUsername: 'user', caldavPassword: 'pass' },
        lifecycleActive: true,
        lifecycleGeneration: 1,
        scanAbortController: new AbortController(),
        networkAbortController: originalController,
      });
      const pending = plugin.testCalDAVConnection();
      await started;
      Object.assign(plugin, { lifecycleGeneration: 2, scanAbortController: new AbortController(), networkAbortController: new AbortController() });
      resolveFetch(new Response('BEGIN:VCALENDAR\nEND:VCALENDAR', { status: 200 }));
      const result = await pending;
      assert.equal(result.success, false);
      assert.match(result.message, /cancelled/u);
    });
  });
});

test('all provider connection facades suppress stale results after lifecycle invalidation', async (t) => {
  const cases = [
    ['Todoist', 'testTodoistConnection', () => Response.json({ results: [], next_cursor: null })],
    ['Google Tasks', 'testGoogleTasksConnection', () => Response.json({ items: [] })],
    ['Google Calendar', 'testGoogleCalendarConnection', () => Response.json({ items: [] })],
    ['Microsoft To Do', 'testMicrosoftTodoConnection', () => Response.json({ value: [{ id: 'default-list', wellknownListName: 'defaultList' }] })],
  ] as const;
  for (const [name, method, response] of cases) {
    await t.test(name, async () => {
      let release!: (response: Response) => void;
      let entered!: () => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const controller = new AbortController();
      await withFetch((async () => {
        entered();
        return new Promise<Response>((resolve) => { release = resolve; });
      }) as typeof fetch, async () => {
        const plugin = Object.create(TaskManagerPlugin.prototype) as TaskManagerPlugin;
        Object.assign(plugin, {
          settings: {
            ...structuredClone(DEFAULT_SETTINGS),
            todoistApiKey: 'todoist-token',
            googleTasksAccessToken: 'google-token',
            googleTasksTokenExpiresAt: '2999-01-01T00:00:00.000Z',
            googleCalendarAccessToken: 'calendar-token',
            googleCalendarTokenExpiresAt: '2999-01-01T00:00:00.000Z',
            msToDoToken: 'microsoft-token',
            msToDoTokenExpiresAt: '2999-01-01T00:00:00.000Z',
            msToDoListId: '',
          },
          lifecycleActive: true,
          lifecycleGeneration: 1,
          scanAbortController: new AbortController(),
          networkAbortController: controller,
        });
        const pending = (plugin[method] as () => Promise<{ success: boolean; message: string }>).call(plugin);
        await started;
        Object.assign(plugin, { lifecycleActive: false, lifecycleGeneration: 2, networkAbortController: null });
        controller.abort();
        release(response());
        const result = await pending;
        assert.equal(result.success, false);
        assert.match(result.message, /cancelled/u);
      });
    });
  }
});

test('provider connection checks report authentication failures instead of configuration success', async () => {
  await withFetch((async () => Response.json({ error: { message: 'revoked' } }, { status: 401 })) as typeof fetch, async () => {
    const todoist = await new TodoistAdapter({ apiKey: 'revoked' }).testConnection();
    const google = await new GoogleTasksAdapter({ accessToken: 'revoked', listId: '@default' }).testConnection();
    const microsoft = await new MicrosoftTodoAdapter({
      accessToken: 'revoked',
      listId: '',
      bidirectionalSync: false,
      syncIntervalMinutes: 0,
      vaultImportPath: 'Inbox.md',
    }).testConnection();
    await assert.rejects(testGoogleCalendarConnection({ accessToken: 'revoked', calendarId: 'primary' }), /401/u);
    assert.equal(todoist.ok, false);
    assert.equal(google.ok, false);
    assert.equal(microsoft.ok, false);
  });
});
