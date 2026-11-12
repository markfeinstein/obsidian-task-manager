import test from 'node:test';
import assert from 'node:assert/strict';
import { identifyGoogleCalendarEvent, markdownTaskToGoogleCalendarEvent, upsertGoogleCalendarEvent, type GoogleCalendarEvent } from '../src/google-calendar-sync';
import { parseMarkdownTaskLine } from '../src/task-model';
import { ProviderHttpError } from '../src/network-request';

test('google calendar: maps tagged dated task to all-day event', () => {
  const task = parseMarkdownTaskLine('- [ ] Meet client #google-calendar 📅 2026-06-18 [id:: google-calendar:abc]', 'Tasks.md', 7)!;
  const event = markdownTaskToGoogleCalendarEvent(task);

  assert.equal(event?.id, 'abc');
  assert.equal(event?.summary, 'Meet client');
  assert.deepEqual(event?.start, { date: '2026-06-18' });
  assert.deepEqual(event?.end, { date: '2026-06-19' });
  assert.deepEqual(event?.reminders, { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] });
  assert.equal(event?.description, undefined, 'vault path and line must not be exported');
});

test('google calendar: ignores foreign service ids when creating event payloads', () => {
  const task = parseMarkdownTaskLine('- [ ] Meet client #google-calendar 📅 2026-06-18 [id:: todoist:123]', 'Tasks.md', 7)!;
  const event = markdownTaskToGoogleCalendarEvent(task);

  assert.equal(event?.id, undefined);
  assert.equal(event?.summary, 'Meet client');
});

test('google calendar: keeps date-only reminder tasks all-day', () => {
  const task = parseMarkdownTaskLine('- [ ] Due date only #google-calendar 📅 2026-06-18 ⏰ 2026-06-17 [id:: google-calendar:abc]', 'Tasks.md', 7)!;
  const event = markdownTaskToGoogleCalendarEvent(task);

  assert.deepEqual(event?.start, { date: '2026-06-18' });
  assert.deepEqual(event?.end, { date: '2026-06-19' });
  assert.equal((event?.start as { date?: string; dateTime?: string } | undefined)?.dateTime, undefined);
  assert.equal((event?.end as { date?: string; dateTime?: string } | undefined)?.dateTime, undefined);
});

test('google calendar: honors custom reminder minutes and default reminder toggle', () => {
  const task = parseMarkdownTaskLine('- [ ] Meet client #google-calendar 📅 2026-06-18 [id:: google-calendar:abc]', 'Tasks.md', 7)!;
  const custom = markdownTaskToGoogleCalendarEvent(task, { reminderMinutes: 25 });
  const defaults = markdownTaskToGoogleCalendarEvent(task, { useDefaultReminders: true });

  assert.deepEqual(custom?.reminders, { useDefault: false, overrides: [{ method: 'popup', minutes: 25 }] });
  assert.deepEqual(defaults?.reminders, { useDefault: true });
});

test('google calendar: maps timed reminder tasks to timed events', () => {
  const task = parseMarkdownTaskLine('- [ ] Standup #google-calendar 📅 2026-06-18 ⏰ 2026-06-18 09:30 [id:: google-calendar:abc]', 'Tasks.md', 7)!;
  const event = markdownTaskToGoogleCalendarEvent(task);

  const start = event?.start as { date?: string; dateTime?: string } | undefined;
  const end = event?.end as { date?: string; dateTime?: string } | undefined;
  assert.equal(start?.dateTime, '2026-06-18T09:30:00');
  assert.equal(end?.dateTime, '2026-06-18T10:30:00');
  assert.deepEqual(event?.reminders, { useDefault: false, overrides: [{ method: 'popup', minutes: 10 }] });
});

test('google calendar: prefers structured time metadata over all-day export', () => {
  const task = parseMarkdownTaskLine('- [ ] Workshop #google-calendar 📅 2026-06-18 ⏳ 2026-06-18 08:15 ⏰ 2026-06-18 [id:: google-calendar:abc]', 'Tasks.md', 7)!;
  const event = markdownTaskToGoogleCalendarEvent(task);

  const start = event?.start as { date?: string; dateTime?: string } | undefined;
  const end = event?.end as { date?: string; dateTime?: string } | undefined;
  assert.equal(start?.dateTime, '2026-06-18T08:15:00');
  assert.equal(end?.dateTime, '2026-06-18T09:15:00');
  assert.equal(start?.date, undefined);
  assert.equal(end?.date, undefined);
});

test('google calendar: treats midnight-crossing time ranges as overnight events', () => {
  const task = parseMarkdownTaskLine('- [ ] Overnight deploy #google-calendar 📅 2026-06-18 ⌚ 23:30-00:30 [id:: google-calendar:abc]', 'Tasks.md', 7)!;
  const event = markdownTaskToGoogleCalendarEvent(task);

  const start = event?.start as { dateTime?: string } | undefined;
  const end = event?.end as { dateTime?: string } | undefined;
  assert.equal(start?.dateTime, '2026-06-18T23:30:00');
  assert.equal(end?.dateTime, '2026-06-19T00:30:00');
});

test('google calendar: skips excluded or undated tasks', () => {
  const excluded = parseMarkdownTaskLine('- [ ] Private #google-calendar 📅 2026-06-18 [sync:: false]', 'Tasks.md', 1)!;
  const undated = parseMarkdownTaskLine('- [ ] Backlog #google-calendar', 'Tasks.md', 2)!;

  assert.equal(markdownTaskToGoogleCalendarEvent(excluded), null);
  assert.equal(markdownTaskToGoogleCalendarEvent(undated), null);
});

test('google calendar: derives stable provider-valid identity without exposing task text or path', async () => {
  const event: GoogleCalendarEvent = {
    summary: 'Ship feature',
    start: { date: '2026-06-18' },
    end: { date: '2026-06-19' },
  };
  const first = await identifyGoogleCalendarEvent(event, 'id:durable-task', true);
  const second = await identifyGoogleCalendarEvent(event, 'id:durable-task', true);
  assert.equal(first.id, second.id);
  assert.match(first.id ?? '', /^otm[0-9a-f]{64}$/u);
  assert.match(first.extendedProperties?.private?.obsidianTaskManagerKey ?? '', /^[0-9a-f]{64}$/u);
  assert.doesNotMatch(JSON.stringify(first.extendedProperties), /durable-task|Tasks\.md|Ship feature/iu);
  await assert.rejects(identifyGoogleCalendarEvent(event, '   ', true), /stable non-empty task identity/u);
});

function sampleEvent(overrides: Partial<GoogleCalendarEvent> = {}): GoogleCalendarEvent {
  return {
    summary: 'Ship feature',
    start: { date: '2026-06-18' },
    end: { date: '2026-06-19' },
    ...overrides,
  };
}

test('google calendar upsert: dry run returns event without fetching', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = (async () => {
    fetchCount += 1;
    return { ok: true, json: async () => ({}) } as Response;
  }) as typeof fetch;
  try {
    const event = sampleEvent();
    const result = await upsertGoogleCalendarEvent({ accessToken: 'token', dryRun: true }, event);
    assert.equal(result, event);
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('google calendar upsert: requires OAuth access token before fetching', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = (async () => {
    fetchCount += 1;
    return { ok: true, json: async () => ({}) } as Response;
  }) as typeof fetch;
  try {
    await assert.rejects(
      upsertGoogleCalendarEvent({}, sampleEvent()),
      /Google Calendar write operations require an OAuth access token/u,
    );
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('google calendar upsert: posts new events and patches existing events', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; method?: string; auth?: string; body?: unknown }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) as unknown : undefined;
    calls.push({
      url: String(url),
      method: init?.method,
      auth: (init?.headers as Record<string, string> | undefined)?.Authorization,
      body,
    });
    return { ok: true, json: async () => ({ ...(body as Record<string, unknown>), id: (body as { id?: string } | undefined)?.id ?? 'created-id' }) } as Response;
  }) as typeof fetch;
  try {
    const created = await upsertGoogleCalendarEvent({ accessToken: ' token ', calendarId: 'Work Calendar' }, sampleEvent());
    const patched = await upsertGoogleCalendarEvent({ accessToken: 'token', calendarId: 'Work Calendar' }, sampleEvent({ id: 'event 1' }));

    assert.equal(created.id, 'created-id');
    assert.equal(patched.id, 'event 1');
    assert.equal(calls[0].method, 'POST');
    assert.equal(calls[0].url, 'https://www.googleapis.com/calendar/v3/calendars/Work%20Calendar/events');
    assert.equal(calls[0].auth, 'Bearer token');
    assert.equal(calls[1].method, 'PATCH');
    assert.equal(calls[1].url, 'https://www.googleapis.com/calendar/v3/calendars/Work%20Calendar/events/event%201');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('google calendar upsert: deterministic create preflights and posts once', async () => {
  const originalFetch = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    methods.push(init?.method ?? 'GET');
    if (init?.method === 'GET') return { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) } as Response;
    const body = JSON.parse(String(init?.body)) as GoogleCalendarEvent;
    return { ok: true, status: 200, json: async () => body } as Response;
  }) as typeof fetch;
  try {
    const identified = await identifyGoogleCalendarEvent(sampleEvent(), 'id:create-once', true);
    const result = await upsertGoogleCalendarEvent({ accessToken: 'token' }, identified, { preflightCreate: true });
    assert.equal(result.id, identified.id);
    assert.deepEqual(methods, ['GET', 'POST']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('google calendar upsert: persisted pending evidence verifies an already-applied event without another PATCH', async () => {
  const previousFetch = globalThis.fetch;
  const event = { id: 'event-1', summary: 'Task', start: { date: '2026-06-15' }, end: { date: '2026-06-16' }, status: 'confirmed' as const, reminders: { useDefault: false, overrides: [{ method: 'popup' as const, minutes: 10 }] } };
  const methods: string[] = [];
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    methods.push(init?.method ?? 'GET');
    return Response.json(event);
  }) as typeof fetch;
  try {
    const result = await upsertGoogleCalendarEvent(
      { accessToken: 'token', calendarId: 'primary' },
      event,
      { preflightCreate: true, verifyExisting: true },
    );
    assert.equal(result.id, event.id);
    assert.deepEqual(methods, ['GET']);
  } finally {
    globalThis.fetch = previousFetch;
  }
});

test('google calendar upsert: lost create response is recovered on retry without a second POST', async () => {
  const originalFetch = globalThis.fetch;
  let remoteExists = false;
  let posts = 0;
  const identified = await identifyGoogleCalendarEvent(sampleEvent(), 'id:lost-response', true);
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'GET') {
      return remoteExists
        ? { ok: true, status: 200, json: async () => identified } as Response
        : { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) } as Response;
    }
    if (init?.method === 'POST') {
      posts += 1;
      remoteExists = true;
      throw new Error('response lost after provider accepted create');
    }
    return { ok: true, status: 200, json: async () => identified } as Response;
  }) as typeof fetch;
  try {
    await assert.rejects(
      upsertGoogleCalendarEvent({ accessToken: 'token' }, identified, { preflightCreate: true }),
      /response lost/u,
    );
    const recovered = await upsertGoogleCalendarEvent({ accessToken: 'token' }, identified, { preflightCreate: true });
    assert.equal(recovered.id, identified.id);
    assert.equal(posts, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('google calendar upsert: 409 recovers by id and patches without another POST', async () => {
  const originalFetch = globalThis.fetch;
  const methods: string[] = [];
  let gets = 0;
  const identified = await identifyGoogleCalendarEvent(sampleEvent(), 'id:conflict-recovery', true);
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    methods.push(init?.method ?? 'GET');
    if (init?.method === 'GET') {
      gets += 1;
      return gets === 1
        ? { ok: false, status: 404, statusText: 'Not Found', json: async () => ({}) } as Response
        : { ok: true, status: 200, json: async () => identified } as Response;
    }
    if (init?.method === 'POST') return { ok: false, status: 409, statusText: 'Conflict', json: async () => ({}) } as Response;
    return { ok: true, status: 200, json: async () => identified } as Response;
  }) as typeof fetch;
  try {
    await upsertGoogleCalendarEvent({ accessToken: 'token' }, identified, { preflightCreate: true });
    assert.deepEqual(methods, ['GET', 'POST', 'GET', 'PATCH']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('google calendar upsert: surfaces API error details', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: false,
    status: 403,
    headers: new Headers({ 'retry-after': '5' }),
    json: async () => ({ error: { message: 'Calendar write denied' } }),
  }) as Response) as typeof fetch;
  try {
    await assert.rejects(
      upsertGoogleCalendarEvent({ accessToken: 'token' }, sampleEvent()),
      (error: unknown) => error instanceof ProviderHttpError
        && error.statusCode === 403
        && error.retryAfterMs === 5000
        && /Google Calendar API error: 403 - Calendar write denied/u.test(error.message),
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
