import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { TFile } from 'obsidian';
import { CalDAVClient, generateVTODO, formatCalendarICS, syncTasksWithCalDAV, syncTasksFromCalDAV, testCalDAVConnection } from '../src/caldav-sync';
import { TaskScanner } from '../src/task-scanner';
import { parseDAVCalendarListing } from '../src/dav-calendar-listing';

const dom = new JSDOM('');
const parser = Object.getOwnPropertyDescriptor(globalThis, 'DOMParser');
before(() => Object.defineProperty(globalThis, 'DOMParser', { configurable: true, value: dom.window.DOMParser }));
after(() => { if (parser) Object.defineProperty(globalThis, 'DOMParser', parser); else Reflect.deleteProperty(globalThis, 'DOMParser'); dom.window.close(); });
const scanner = new TaskScanner({} as never);
function task(title: string, id = 'local') {
  const parsed = scanner.parseTaskLine(`- [ ] ${title} [id:: ${id}]`, 'Tasks.md', 1);
  assert.ok(parsed);
  return parsed;
}
function listing(paths: string[]): string {
  const root = '<D:response><D:href>/calendar/</D:href><D:propstat><D:prop><D:resourcetype><D:collection/><C:calendar/></D:resourcetype><C:supported-calendar-component-set><C:comp name="VTODO"/></C:supported-calendar-component-set></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>';
  return `<D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">${root}${paths.map((path) => `<D:response><D:href>${path}</D:href><D:propstat><D:prop><D:resourcetype/><D:getcontenttype>text/calendar</D:getcontenttype><D:getetag>"e1"</D:getetag></D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`).join('')}</D:multistatus>`;
}

async function withServer(run: (server: { objects: Map<string, string>; writes: string[]; failWrite: (ordinal: number, status: number) => void }) => Promise<void>) {
  const previous = globalThis.fetch;
  const objects = new Map<string, string>();
  const writes: string[] = [];
  let failOrdinal = -1;
  let failStatus = 503;
  globalThis.fetch = (async (input, init) => {
    const path = new URL(String(input)).pathname;
    const headers = new Headers(init?.headers);
    if (init?.method === 'PROPFIND') {
      assert.equal(path, '/calendar/');
      assert.equal(headers.get('Depth'), '1');
      return new Response(listing([...objects.keys()]), { status: 207 });
    }
    if (init?.method === 'PUT') {
      assert.notEqual(path, '/calendar/', 'collections must never receive a shared-calendar PUT');
      writes.push(path);
      if (writes.length === failOrdinal) return new Response('', { status: failStatus });
      if (objects.has(path)) assert.equal(headers.get('If-Match'), '"e1"');
      else assert.equal(headers.get('If-None-Match'), '*');
      const content = String(init.body);
      assert.equal(content.match(/^UID:/gmu)?.length, 1);
      assert.doesNotMatch(content, /^METHOD:/mu);
      objects.set(path, content);
      return new Response(null, { status: 204, headers: { etag: '"e1"' } });
    }
    return objects.has(path) ? new Response(objects.get(path), { headers: { etag: '"e1"' } }) : new Response('', { status: 404 });
  }) as typeof fetch;
  try { await run({ objects, writes, failWrite: (ordinal, status) => { failOrdinal = ordinal; failStatus = status; } }); }
  finally { globalThis.fetch = previous; }
}

function vault() {
  let content = '';
  const file = Object.assign(Object.create(TFile.prototype) as TFile, { path: 'Projection.md', extension: 'md' });
  return {
    app: { vault: { getAbstractFileByPath: () => content ? file : null, create: async (_path: string, next: string) => { content = next; return file; }, process: async (_file: TFile, update: (current: string) => string) => { content = update(content); return content; } } },
    content: () => content,
  };
}
function client() { return new CalDAVClient('https://calendar.example.com', 'synthetic', 'synthetic', undefined, true); }

test('CalDAV collection sync writes and verifies one resource per UID, preserves remote-only objects, and repeats as a no-op', async () => {
  await withServer(async ({ objects, writes }) => {
    const remote = formatCalendarICS([generateVTODO(task('Remote', 'remote'))]);
    objects.set('/calendar/remote.ics', remote);
    const target = vault();
    const first = await syncTasksWithCalDAV(target.app as never, client(), [task('First'), task('Second', 'second')], '/calendar/', 'Projection.md', 'vault-first');
    assert.equal(first.status, 'success');
    assert.equal(writes.length, 2);
    assert.equal(objects.size, 3);
    assert.equal(objects.get('/calendar/remote.ics'), remote);
    assert.match(target.content(), /Remote/u);
    const second = await syncTasksWithCalDAV(target.app as never, client(), [task('First'), task('Second', 'second')], '/calendar/', 'Projection.md', 'vault-first');
    assert.ok(second.status === 'success' && !second.remoteChanged);
    assert.equal(writes.length, 2);
  });
});

test('CalDAV collection reads the complete snapshot and checks all conflicts before the first write', async () => {
  await withServer(async ({ objects, writes }) => {
    objects.set('/calendar/existing.ics', formatCalendarICS([generateVTODO(task('Original'))]).replace('SUMMARY:Original', 'SUMMARY:Remote edit'));
    const result = await syncTasksWithCalDAV(vault().app as never, client(), [task('New task', 'new'), task('Local edit')], '/calendar/', 'Projection.md', 'vault-first');
    assert.equal(result.status, 'conflict');
    assert.equal(writes.length, 0);
  });
});

test('CalDAV collection reports a partial batch and fresh reconciliation does not duplicate an earlier successful create', async () => {
  await withServer(async ({ objects, writes, failWrite }) => {
    failWrite(2, 503);
    const target = vault();
    const tasks = [task('First'), task('Second', 'second')];
    const first = await syncTasksWithCalDAV(target.app as never, client(), tasks, '/calendar/', 'Projection.md', 'vault-first');
    assert.ok(first.status === 'partial' && first.reason === 'remote-write' && first.uploaded === 1);
    assert.equal(objects.size, 1);
    assert.equal(target.content(), '');
    const next = await syncTasksWithCalDAV(target.app as never, client(), tasks, '/calendar/', 'Projection.md', 'vault-first');
    assert.equal(next.status, 'success');
    assert.equal(objects.size, 2);
    assert.equal(writes.length, 3);
  });
});

test('CalDAV collection handles conditional conflicts, missing validators, malformed objects, and duplicate UIDs without blind writes', async () => {
  await withServer(async ({ writes, failWrite }) => {
    failWrite(1, 412);
    const result = await syncTasksWithCalDAV(vault().app as never, client(), [task('New')], '/calendar/', 'Projection.md', 'vault-first');
    assert.equal(result.status, 'conflict');
    assert.equal(writes.length, 1);
  });
  for (const kind of ['missing-etag', 'malformed', 'mixed-uids', 'duplicate-uid', 'exceptions'] as const) {
    await withServer(async ({ objects, writes }) => {
      const component = generateVTODO(task('Original'));
      objects.set('/calendar/existing.ics', kind === 'malformed' ? '<html>Login</html>' : formatCalendarICS(kind === 'mixed-uids' ? [component, generateVTODO(task('Other', 'other'))] : kind === 'exceptions' ? [component, component.replace('END:VTODO', 'RECURRENCE-ID:20261110T090000\r\nEND:VTODO')] : [component]));
      if (kind === 'duplicate-uid') objects.set('/calendar/duplicate.ics', formatCalendarICS([component]));
      const serverFetch = globalThis.fetch;
      globalThis.fetch = (async (input, init) => {
        const response = await serverFetch(input, init);
        if (kind === 'missing-etag' && (init?.method ?? 'GET') === 'GET') response.headers.delete('etag');
        return response;
      }) as typeof fetch;
      const result = await syncTasksWithCalDAV(vault().app as never, client(), [task('Local edit')], '/calendar/', 'Projection.md', 'vault-first');
      assert.ok(result.status === 'failure' || result.status === 'conflict');
      assert.equal(writes.length, 0);
    });
  }
});

test('CalDAV connection requires explicit endpoint trust before collection or legacy transport', async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls += 1; throw new Error('Untrusted endpoint must not be contacted'); }) as typeof fetch;
  try {
    for (const calendarPath of ['/calendar/', '/calendar.ics']) {
      const result = await testCalDAVConnection({ serverUrl: 'https://calendar.example.com', username: 'synthetic', password: 'synthetic', calendarPath, allowPrivateNetwork: false });
      assert.equal(result.success, false);
      assert.match(result.message, /explicitly trusted/u);
    }
    assert.equal(calls, 0);
  } finally { globalThis.fetch = previous; }
});

test('CalDAV connection discovery is read-only and collection imports do not issue PUTs', async () => {
  await withServer(async ({ objects, writes }) => {
    objects.set('/calendar/remote.ics', formatCalendarICS([generateVTODO(task('Remote'))]));
    const result = await testCalDAVConnection({ serverUrl: 'https://calendar.example.com', username: 'synthetic', password: 'synthetic', calendarPath: '/calendar/', allowPrivateNetwork: true });
    assert.equal(result.success, true);
    const target = vault();
    assert.equal(await syncTasksFromCalDAV(target.app as never, client(), '/calendar/', 'Projection.md', 'service-first'), 1);
    assert.match(target.content(), /Remote/u);
    assert.equal(writes.length, 0);
    await assert.rejects(client().calendarObjects('/calendar.ics'), /must end/u);
  });
});

test('CalDAV post-write proof and lifecycle fences stop publication after a remote mutation', async () => {
  for (const cancel of [false, true]) {
    await withServer(async ({ writes }) => {
      let active = true;
      const serverFetch = globalThis.fetch;
      globalThis.fetch = (async (input, init) => {
        const response = await serverFetch(input, init);
        if (cancel && init?.method === 'PUT') active = false;
        if (!cancel && (init?.method ?? 'GET') === 'GET' && writes.length) return new Response((await response.text()).replace('SUMMARY:New', 'SUMMARY:Changed remotely'), { headers: response.headers });
        return response;
      }) as typeof fetch;
      const target = vault();
      const result = await syncTasksWithCalDAV(target.app as never, client(), [task('New')], '/calendar/', 'Projection.md', 'vault-first', undefined, { isCurrent: () => active });
      assert.equal(result.status, cancel ? 'cancelled' : 'partial');
      assert.equal(target.content(), '');
      assert.equal(writes.length, 1);
    });
  }
});

test('CalDAV rejects non-calendar connection successes, unsafe discovery hrefs, DTDs, and namespace lookalikes', async () => {
  const previous = globalThis.fetch;
  try {
    globalThis.fetch = (async () => new Response('<html>Login</html>')) as typeof fetch;
    const config = { serverUrl: 'https://calendar.example.com', username: 'synthetic', password: 'synthetic', calendarPath: '/calendar/', allowPrivateNetwork: true };
    assert.equal((await testCalDAVConnection(config)).success, false);
    assert.equal((await testCalDAVConnection({ ...config, calendarPath: '/calendar.ics' })).success, false);
    for (const href of ['https://other.example.com/calendar/task.ics', '/outside/task.ics', '/calendar/../outside.ics', '/calendar/%2f..%2foutside.ics', '/calendar/%252e%252e/outside.ics', '/calendar/%5coutside.ics']) {
      globalThis.fetch = (async () => new Response(listing([href]), { status: 207 })) as typeof fetch;
      await assert.rejects(client().calendarObjects('/calendar/'));
    }
    assert.throws(() => parseDAVCalendarListing('<!DOCTYPE root SYSTEM "file:///private"><root/>'), /document types/u);
    assert.throws(() => parseDAVCalendarListing(listing([]).replace('xmlns:D="DAV:"', 'xmlns:D="urn:lookalike"')), /multistatus/u);
  } finally { globalThis.fetch = previous; }
});
