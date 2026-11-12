import test from 'node:test';
import assert from 'node:assert/strict';
import { fetchGoogleTasks, GoogleTasksAdapter } from '../src/google-tasks-sync';
import { ProviderHttpError } from '../src/network-request';
import { SyncOperationQueue } from '../src/sync-operations';
import { createBaselineEvidence, reconcileSupportedProjections } from '../src/sync-reconciliation';
import { parseMarkdownTaskLine } from '../src/task-model';

test('Google Tasks includes hidden completed tasks in every page of its complete snapshot', async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (input) => {
    const url = new URL(String(input));
    assert.equal(url.searchParams.get('showCompleted'), 'true');
    assert.equal(url.searchParams.get('showHidden'), 'true');
    calls += 1;
    return new Response(JSON.stringify(calls === 1
      ? { items: [{ id: 'g1', title: 'Completed in Google', status: 'completed', hidden: true }], nextPageToken: 'next' }
      : { items: [] }), { headers: { 'Content-Type': 'application/json' } });
  }) as typeof fetch;
  try {
    const tasks = await fetchGoogleTasks({ accessToken: 'synthetic' });
    assert.equal(tasks[0]?.status, 'completed');
    assert.equal(calls, 2);
  } finally { globalThis.fetch = previous; }
});

test('Google Tasks refuses missing, wildcard, weak, or unsafe validators before network access', async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => { calls += 1; throw new Error('Unexpected request'); }) as typeof fetch;
  const adapter = new GoogleTasksAdapter({ accessToken: 'synthetic' });
  try {
    for (const version of [undefined, '', '*', 'W/"e1"', 'timestamp', '"e1"\r\nInjected: value']) {
      await assert.rejects(adapter.update('g1', { title: 'Local' }, false, version), /strong ETag/u);
    }
    await assert.rejects(adapter.delete('g1'), /strong ETag/u);
    await assert.rejects(adapter.reopen('g1'), /strong ETag/u);
    assert.equal(calls, 0);
    await adapter.update('g1', { title: 'Local' }, true);
  } finally { globalThis.fetch = previous; }
});

test('Google Tasks protects an intervening remote edit and does not retry HTTP 412', async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  const remote = { title: 'Changed by another client', version: '"current"' };
  globalThis.fetch = (async (_input, init) => {
    calls += 1;
    assert.equal(init?.method, 'PATCH');
    const version = new Headers(init?.headers).get('If-Match');
    assert.equal(version, '"old"');
    if (version !== remote.version) return new Response('', { status: 412 });
    remote.title = String((JSON.parse(String(init?.body)) as { title: unknown }).title);
    return new Response(JSON.stringify({ id: 'g1', title: remote.title, etag: '"new"' }));
  }) as typeof fetch;
  try {
    const adapter = new GoogleTasksAdapter({ accessToken: 'synthetic' });
    await assert.rejects(adapter.update('g1', { title: 'Stale local value' }, false, '"old"'),
      (error: unknown) => error instanceof ProviderHttpError && error.statusCode === 412 && /reconcile again/u.test(error.message));
    assert.equal(remote.title, 'Changed by another client');
    assert.equal(calls, 1);
  } finally { globalThis.fetch = previous; }
});

test('the sync queue forwards reconciled versions through reopen and delete to the real Google adapter', async () => {
  const previous = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    methods.push(init?.method ?? 'GET');
    assert.equal(new Headers(init?.headers).get('If-Match'), '"reconciled"');
    return init?.method === 'DELETE' ? new Response(null, { status: 204 }) : Response.json({ id: 'g2', title: 'Task', status: 'needsAction', etag: '"new"' });
  }) as typeof fetch;
  try {
    const task = parseMarkdownTaskLine('- [ ] Task [id:: local]', 'Tasks.md', 1);
    assert.ok(task);
    const queue = new SyncOperationQueue();
    queue.registerAdapter('google-tasks', new GoogleTasksAdapter({ accessToken: 'synthetic' }));
    const evidence = reconcileSupportedProjections({ service: 'google-tasks', local: { status: 'needsAction' }, remote: { status: 'completed' }, baseline: createBaselineEvidence({ status: 'completed' }), remoteVersion: '"reconciled"' }).evidence;
    queue.enqueueDelete(task, 'google-tasks', 'g1').reconciliation = evidence;
    queue.enqueueReopen(task, 'google-tasks', 'g2').reconciliation = evidence;
    const result = await queue.executeAll(1);
    assert.equal(result.successful.length, 2);
    assert.equal(result.failed.length, 0);
    assert.deepEqual(methods, ['DELETE', 'PATCH']);
  } finally { globalThis.fetch = previous; }
});

test('Google Tasks uses the supplied validator for successful PATCH, reopen, and delete', async () => {
  const previous = globalThis.fetch;
  const methods: string[] = [];
  globalThis.fetch = (async (_input, init) => {
    methods.push(init?.method ?? 'GET');
    assert.equal(new Headers(init?.headers).get('If-Match'), '"e1"');
    const payload = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
    return new Response(JSON.stringify({ id: 'g1', title: 'Local', status: 'needsAction', ...payload, etag: '"e2"' }));
  }) as typeof fetch;
  try {
    const adapter = new GoogleTasksAdapter({ accessToken: 'synthetic' });
    assert.equal((await adapter.update('g1', { title: 'Local' }, false, '"e1"')).remoteVersion, '"e2"');
    await adapter.reopen('g1', false, '"e1"');
    await adapter.delete('g1', false, '"e1"');
    assert.deepEqual(methods, ['PATCH', 'PATCH', 'DELETE']);
  } finally { globalThis.fetch = previous; }
});
