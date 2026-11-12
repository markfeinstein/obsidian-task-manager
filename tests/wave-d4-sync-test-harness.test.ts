import test from 'node:test';
import assert from 'node:assert/strict';
import { createAppleRemindersWebhookPayload, handleAppleRemindersWebhook } from '../src/apple-reminders-sync';
import { fetchGoogleTasks, GoogleTasksAdapter } from '../src/google-tasks-sync';
import { fetchMicrosoftTodoTasks } from '../src/microsoft-todo-sync';
import { SyncOperationQueue } from '../src/sync-operations';
import {
  createExternalSyncEndpointMock,
  createFlakySyncAdapter,
  makeHarnessTask,
  MockFetchRouter,
} from './external-sync-test-harness';

test('wave D4 sync harness: mocks Google and Microsoft external endpoints', async () => {
  const router = createExternalSyncEndpointMock({
    googleTasks: [{ id: 'g-ext', title: 'From Google', status: 'needsAction' }],
    microsoftTasks: [{ id: 'm-ext', title: 'From Microsoft', status: 'notStarted', isReminderOn: false }],
  });
  const restore = router.install();
  try {
    const googleTasks = await fetchGoogleTasks({ accessToken: 'google-token', listId: '@default' });
    const microsoftTasks = await fetchMicrosoftTodoTasks({ accessToken: 'ms-token', bidirectionalSync: false, syncIntervalMinutes: 0, vaultImportPath: 'MS Inbox.md' });

    assert.equal(googleTasks[0].id, 'g-ext');
    assert.equal(microsoftTasks[0].id, 'm-ext');
    assert.equal(router.count((call) => call.url.includes('tasks.googleapis.com')), 1);
    assert.equal(router.count((call) => call.url.includes('graph.microsoft.com')), 2);
  } finally {
    restore();
  }
});

test('wave D4 sync harness: captures external auth errors and no-credential safety without stray fetches', async () => {
  const router = createExternalSyncEndpointMock({ googleStatus: 401, microsoftStatus: 401 });
  const restore = router.install();
  try {
    await assert.rejects(fetchGoogleTasks({}), /Not authenticated with Google Tasks/u);
    await assert.rejects(fetchMicrosoftTodoTasks({ bidirectionalSync: false, syncIntervalMinutes: 0, vaultImportPath: 'MS Inbox.md' }), /Not authenticated with Microsoft To Do/u);
    assert.equal(router.count(), 0, 'credential guards should fail before network access');

    await assert.rejects(fetchGoogleTasks({ accessToken: 'expired' }), /Google Tasks API error: 401/u);
    await assert.rejects(fetchMicrosoftTodoTasks({ accessToken: 'expired', bidirectionalSync: false, syncIntervalMinutes: 0, vaultImportPath: 'MS Inbox.md' }), /authentication expired/u);
    assert.equal(router.count((call) => call.url.includes('tasks.googleapis.com')), 1);
    assert.equal(router.count((call) => call.url.includes('graph.microsoft.com')), 2);

    const invalidAppleSecret = handleAppleRemindersWebhook(createAppleRemindersWebhookPayload([{ id: 'a1', title: 'Milk', isCompleted: false }], { secret: 'wrong' }), { enabled: true, secret: 'right' });
    assert.equal(invalidAppleSecret.accepted, false);
    assert.equal(invalidAppleSecret.reason, 'invalid-secret');
  } finally {
    restore();
  }
});

test('wave D4 sync harness: Google API errors include service-provided detail when available', async () => {
  const router = new MockFetchRouter()
    .route('GET', /https:\/\/tasks\.googleapis\.com\/tasks\/v1\/lists\/[^/]+\/tasks/u, () => ({
      status: 401,
      body: { error: { message: 'Request had invalid authentication credentials.' } },
    }));
  const restore = router.install();
  try {
    await assert.rejects(
      fetchGoogleTasks({ accessToken: 'expired', listId: '@default' }),
      /Google Tasks API error: 401 - Request had invalid authentication credentials\./u,
    );
  } finally {
    restore();
  }
});

test('wave D4 sync harness: Google API-key-only mutations fail before fetch', async () => {
  const router = createExternalSyncEndpointMock();
  const restore = router.install();
  try {
    const adapter = new GoogleTasksAdapter({ apiKey: 'legacy-read-key', listId: '@default' });
    const readTasks = await fetchGoogleTasks({ apiKey: 'legacy-read-key', listId: '@default' });
    assert.equal(readTasks.length, 1);

    await assert.rejects(adapter.create({ title: 'Create requires OAuth' }), /OAuth access token/u);
    await assert.rejects(adapter.update('g1', { title: 'Update requires OAuth' }), /OAuth access token/u);
    await assert.rejects(adapter.delete('g1'), /OAuth access token/u);
    assert.equal(router.count((call) => call.method !== 'GET'), 0, 'mutations should not reach the network with only an API key');
  } finally {
    restore();
  }
});

test('wave D4 sync harness: token refresh failures are deterministic fixtures', async () => {
  const router = createExternalSyncEndpointMock({ googleTokenRefreshStatus: 400, microsoftTokenRefreshStatus: 401 });
  const restore = router.install();
  try {
    const googleRefresh = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', body: 'grant_type=refresh_token' });
    const microsoftRefresh = await fetch('https://login.microsoftonline.com/common/oauth2/v2.0/token', { method: 'POST', body: 'grant_type=refresh_token' });

    assert.equal(googleRefresh.ok, false);
    assert.equal(googleRefresh.status, 400);
    assert.equal((await googleRefresh.json() as { error: string }).error, 'invalid_grant');
    assert.equal(microsoftRefresh.ok, false);
    assert.equal(microsoftRefresh.status, 401);
    assert.equal((await microsoftRefresh.json() as { error: string }).error, 'invalid_grant');
    assert.equal(router.count((call) => call.url.includes('/token')), 2);
  } finally {
    restore();
  }
});

test('wave D4 sync harness: queue retries transient idempotent updates with backoff', async () => {
  const queue = new SyncOperationQueue();
  const adapter = createFlakySyncAdapter({ failUpdates: 2 });
  queue.registerAdapter('external-test', adapter);
  const operation = queue.enqueueUpdate(makeHarnessTask(), 'external-test', 'remote-1', { title: 'Retry me' });

  const result = await queue.executeAll(1);

  assert.equal(adapter.attempts.update, 3);
  assert.equal(operation.status, 'success');
  assert.equal(result.successful.length, 1);
  assert.equal(result.failed.length, 0, 'transient retry attempts should not be reported as final failures');
  assert.equal(operation.attempts, 3);
});

test('wave D4 sync harness: create failures are retained without automatic replay', async () => {
  const queue = new SyncOperationQueue();
  const adapter = createFlakySyncAdapter({ failCreates: 2 });
  queue.registerAdapter('external-test', adapter);
  const operation = queue.enqueueCreate(makeHarnessTask(), 'external-test', { title: 'Do not replay' });

  const result = await queue.executeAll(1);

  assert.equal(adapter.attempts.create, 1);
  assert.equal(operation.status, 'failed');
  assert.equal(result.failed.length, 1);
  assert.match(operation.idempotencyKey ?? '', /^external-test:sync-op-/u);
});

test('wave D4 sync harness: failed queue entries are idempotently retained and recoverable', async () => {
  const queue = new SyncOperationQueue();
  const task = makeHarnessTask({ key: 'Harness.md:Recover me', body: 'Recover me' });
  const failingAdapter = createFlakySyncAdapter({ failCreates: 4 });
  queue.registerAdapter('external-test', failingAdapter);
  const operation = queue.enqueueCreate(task, 'external-test', { title: 'Recover me' });

  const firstRun = await queue.executeAll(1);
  assert.equal(operation.status, 'failed');
  assert.equal(firstRun.successful.length, 0);
  assert.deepEqual(firstRun.failed.map((op) => op.id), [operation.id], 'exhausted retries should report one final failed operation');
  assert.equal(queue.hasOperationFor(task.key, 'external-test', ['create']), true, 'failed operation remains visible for dedupe/retry checks');

  assert.equal(queue.requeueFailed('external-test'), 1);
  assert.equal(operation.status, 'queued');
  const recoveredAdapter = createFlakySyncAdapter();
  queue.registerAdapter('external-test', recoveredAdapter);
  const secondRun = await queue.executeAll(1);
  assert.deepEqual(secondRun.successful.map((op) => op.id), [operation.id]);
  assert.equal(operation.status, 'success');

  queue.removeOperations(secondRun.successful.map((op) => op.id));
  assert.equal(queue.getState().operations.length, 0);
  assert.equal(queue.getState().completed.length, 1);
  assert.equal(queue.hasOperationFor(task.key, 'external-test', ['create']), false);
});

test('wave D4 sync harness: conflicts are retained for manual recovery instead of being dropped', async () => {
  const queue = new SyncOperationQueue();
  const task = makeHarnessTask({ key: 'Harness.md:Conflict', body: 'Conflict' });
  const adapter = createFlakySyncAdapter({
    conflicts: [{ field: 'title', vaultValue: 'Vault', serviceValue: 'Service', service: 'external-test', detectedAt: 1 }],
  });
  queue.registerAdapter('external-test', adapter);
  const operation = queue.enqueueUpdate(task, 'external-test', 'external-1', { title: 'Vault' }, ['title']);

  const result = await queue.executeAll(1);

  assert.equal(result.conflicts.length, 1);
  assert.equal(operation.status, 'conflict');
  assert.equal(operation.conflicts?.[0].field, 'title');
  assert.equal(queue.hasOperationFor(task.key, 'external-test', ['update'], 'external-1'), true);
  assert.equal(queue.requeueFailed('external-test'), 0);
  assert.equal(operation.status, 'conflict', 'manual conflicts must not be converted into stale executable payloads');
});

test('wave D4 sync harness: requeueFailed restores retry budget for idempotent updates', async () => {
  const queue = new SyncOperationQueue();
  const task = makeHarnessTask({ key: 'Harness.md:Budget reset', body: 'Budget reset' });

  const firstAdapter = createFlakySyncAdapter({ failUpdates: 4 });
  queue.registerAdapter('external-test', firstAdapter);
  const operation = queue.enqueueUpdate(task, 'external-test', 'remote-1', { title: 'Budget reset' });
  await queue.executeAll(1);
  assert.equal(operation.status, 'failed');

  assert.equal(queue.requeueFailed('external-test'), 1);
  const secondAdapter = createFlakySyncAdapter({ failUpdates: 2 });
  queue.registerAdapter('external-test', secondAdapter);
  const secondRun = await queue.executeAll(1);

  assert.equal(operation.status, 'success', 'operation should succeed after retry budget was restored');
  assert.equal(secondRun.successful.length, 1);
  assert.equal(secondAdapter.attempts.update, 3);
});

test('wave D4 sync harness: persisted executing operations are retried after restart', async () => {
  const task = makeHarnessTask({ key: 'Harness.md:Interrupted', body: 'Interrupted' });
  const queue = new SyncOperationQueue({
    operations: [{
      id: 'sync-op-7',
      type: 'create',
      service: 'external-test',
      vaultTask: task,
      payload: { title: 'Interrupted' },
      status: 'executing',
      queuedAt: Date.now(),
    }],
    completed: [],
    version: 1,
  });
  const adapter = createFlakySyncAdapter();
  queue.registerAdapter('external-test', adapter);

  const result = await queue.executeAll(1);

  assert.equal(adapter.attempts.create, 1);
  assert.deepEqual(result.successful.map((op) => op.id), ['sync-op-7']);
  assert.equal(queue.getOperation('sync-op-7')?.status, 'success');
});

test('wave D4 sync harness: route miss reports requested external endpoint', async () => {
  const router = new MockFetchRouter();
  const restore = router.install();
  try {
    const response = await fetch('https://example.invalid/unregistered');
    assert.equal(response.status, 404);
    assert.match(await response.text(), /No mock route for GET https:\/\/example\.invalid\/unregistered/u);
  } finally {
    restore();
  }
});
