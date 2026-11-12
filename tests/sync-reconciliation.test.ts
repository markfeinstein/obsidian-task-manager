import test from 'node:test';
import assert from 'node:assert/strict';
import { IdentityMapper } from '../src/sync-identity-mapper';
import { SyncOperationQueue } from '../src/sync-operations';
import { createBaselineEvidence, deterministicProjectionJson, projectionsEqual, reconcileSupportedProjections } from '../src/sync-reconciliation';
import { GoogleTasksAdapter, googleTasksProjectionFromRemoteTask, googleTasksProjectionFromVaultTask, reconcileGoogleTask } from '../src/google-tasks-sync';
import { MicrosoftTodoAdapter, microsoftTodoProjectionFromRemoteTask, reconcileMicrosoftTodoTask } from '../src/microsoft-todo-sync';
import { enqueueTodoistVaultOperations, planTodoistImports, TodoistAdapter, todoistProjectionFromVaultTask } from '../src/todoist-sync';
import type { MarkdownTask } from '../src/task-model';

function task(overrides: Partial<MarkdownTask> = {}): MarkdownTask {
  return {
    key: 'id:google-tasks:g1', filePath: 'Tasks.md', lineNumber: 1,
    rawLine: '- [ ] Review spec #keep [owner:: Pat] [id:: google-tasks:g1]',
    linePrefix: '', indentation: '', listMarker: '-', checkbox: ' ', body: 'Review spec #keep [owner:: Pat] [id:: google-tasks:g1]',
    normalizedText: 'Review spec #keep', status: 'todo', tags: ['keep'], contexts: [],
    metadata: { id: 'google-tasks:g1', dates: {}, invalidDates: {}, priority: 'normal', dependsOn: [], customFields: { owner: 'Pat' } },
    ...overrides,
  } as MarkdownTask;
}

const base = { title: 'A', due: null, status: 'open' };

test('three-way decision matrix is deterministic and fail-closed', () => {
  const equalFirst = reconcileSupportedProjections({ service: 'test', local: base, remote: { status: 'open', due: null, title: 'A' }, detectedAt: 1 });
  assert.equal(equalFirst.mode, 'establish-baseline');
  assert.equal(deterministicProjectionJson(equalFirst.nextBaseline ?? {}), '{"due":null,"status":"open","title":"A"}');

  const unequalFirst = reconcileSupportedProjections({ service: 'test', local: base, remote: { ...base, title: 'B' }, detectedAt: 2 });
  assert.equal(unequalFirst.mode, 'conflict');
  assert.deepEqual(unequalFirst.outbound, {});

  const baseline = createBaselineEvidence(base, 'v1', 3);
  assert.deepEqual(reconcileSupportedProjections({ service: 'test', local: { ...base, title: 'L' }, remote: base, baseline }).outbound, { title: 'L' });
  assert.deepEqual(reconcileSupportedProjections({ service: 'test', local: base, remote: { ...base, due: '2026-07-12' }, baseline }).inbound, { due: '2026-07-12' });
  assert.equal(reconcileSupportedProjections({ service: 'test', local: { ...base, title: 'same' }, remote: { ...base, title: 'same' }, baseline }).mode, 'advance-baseline');
  assert.equal(reconcileSupportedProjections({ service: 'test', local: { ...base, title: 'local' }, remote: { ...base, title: 'remote' }, baseline }).mode, 'conflict');
  assert.equal(reconcileSupportedProjections({ service: 'test', local: base, baseline }).fields.every((field) => field.reason === 'remote-absent'), true);
});

test('an actual sentinel-looking JSON array is not equal to a missing field', () => {
  const baseline = createBaselineEvidence({ tags: ['__missing__'] });
  const result = reconcileSupportedProjections({ service: 'test', baseline, local: { tags: ['__missing__'] }, remote: {} });
  assert.equal(result.mode, 'inbound');
  assert.deepEqual(result.inbound, { tags: null });
});

test('one conflicting field holds otherwise valid inbound/outbound candidates', () => {
  const baseline = createBaselineEvidence({ title: 'A', due: null, status: 'open' });
  const result = reconcileSupportedProjections({
    service: 'test', baseline,
    local: { title: 'local', due: null, status: 'done' },
    remote: { title: 'remote', due: '2026-07-12', status: 'open' },
  });
  assert.equal(result.mode, 'conflict');
  assert.deepEqual(result.outbound, {});
  assert.deepEqual(result.inbound, {});
  assert.deepEqual(result.conflicts.map((conflict) => conflict.field), ['title']);
});

test('v1 mapper migration is idempotent and never trusts legacy hashes', () => {
  const legacy = {
    version: 1,
    identities: [{ vaultKey: 'id:google-tasks:g1', externalIds: { 'google-tasks': 'g1' }, lastSyncedHash: 'legacy', fieldHashes: { title: 'hash' }, createdAt: 1, updatedAt: 1 }],
  };
  const first = new IdentityMapper(legacy).getState();
  const second = new IdentityMapper(first).getState();
  assert.equal(first.version, 2);
  assert.deepEqual(second, first);
  assert.equal(new IdentityMapper(first).getBaseline('id:google-tasks:g1', 'google-tasks'), undefined);
});

test('malformed provider baseline remains an explicit fail-closed marker across restart', () => {
  const malformed = {
    version: 2,
    identities: [{ vaultKey: 'id:google-tasks:g1', externalIds: { 'google-tasks': 'g1' }, baselines: { 'google-tasks': { schemaVersion: 1, projection: { title: undefined }, recordedAt: 1 } }, createdAt: 1, updatedAt: 1 }],
  } as never;
  const restarted = new IdentityMapper(new IdentityMapper(malformed).getState());
  assert.deepEqual(restarted.getBaseline('id:google-tasks:g1', 'google-tasks'), { malformed: true });
  const result = reconcileSupportedProjections({ service: 'google-tasks', local: { title: 'A' }, remote: { title: 'A' }, baseline: restarted.getBaseline('id:google-tasks:g1', 'google-tasks') });
  assert.equal(result.mode, 'conflict');
  assert.equal(result.fields[0]?.reason, 'malformed-baseline');
});

test('Google projection reconciliation covers cleared fields, status, local-only, remote-only, and dual divergence', () => {
  const local = task({ metadata: { id: 'google-tasks:g1', dates: {}, invalidDates: {}, priority: 'normal', dependsOn: [], comments: [] } });
  const remote = { id: 'g1', title: 'Review spec', notes: '', status: 'needsAction' as const, etag: 'e1' };
  const projection = googleTasksProjectionFromVaultTask(local);
  assert.deepEqual(projection, { description: '', due: null, status: 'needsAction', title: 'Review spec' });
  const baseline = createBaselineEvidence(projection, 'e0');
  assert.equal(reconcileGoogleTask({ ...local, normalizedText: 'Changed', body: 'Changed' }, remote, baseline).mode, 'outbound');
  assert.equal(reconcileGoogleTask(local, { ...remote, notes: 'Remote note' }, baseline).mode, 'inbound');
  assert.equal(reconcileGoogleTask({ ...local, normalizedText: 'Local', body: 'Local' }, { ...remote, title: 'Remote' }, baseline).mode, 'conflict');
  assert.equal(reconcileGoogleTask({ ...local, status: 'done', checkbox: 'x' }, { ...remote, status: 'needsAction' }, baseline).outbound.status, 'completed');
  assert.equal(reconcileGoogleTask({ ...local, status: 'cancelled', checkbox: '-' }, remote, baseline).mode, 'conflict');
});

test('Microsoft projection reconciliation preserves version fields and rejects unsupported statuses', () => {
  const local = task({ key: 'id:ms-todo:m1', metadata: { id: 'ms-todo:m1', dates: {}, invalidDates: {}, priority: 'normal', dependsOn: [] } });
  const remote = { id: 'm1', title: 'Review spec', status: 'notStarted' as const, importance: 'normal' as const, isReminderOn: false, '@odata.etag': 'W/"1"' };
  const projection = microsoftTodoProjectionFromRemoteTask(remote);
  const baseline = createBaselineEvidence(projection, 'W/"1"');
  assert.equal(reconcileMicrosoftTodoTask(local, { ...remote, title: 'Remote' }, baseline).mode, 'inbound');
  assert.equal(reconcileMicrosoftTodoTask({ ...local, normalizedText: 'Local', body: 'Local' }, { ...remote, title: 'Remote' }, baseline).mode, 'conflict');
  assert.equal(reconcileMicrosoftTodoTask(local, { ...remote, status: 'waitingOnOthers' }, baseline).mode, 'conflict');
  assert.equal(reconcileMicrosoftTodoTask(local, undefined, baseline).mode, 'conflict');
});

test('lossy vault sanitization never establishes a false common baseline', () => {
  const googleRemote = { id: 'g1', title: 'Review [id:: injected]', notes: '', status: 'needsAction' as const };
  const googleAdapter = new GoogleTasksAdapter({ accessToken: 'token' });
  const googleImported = googleAdapter.fromServicePayload(googleRemote as unknown as Record<string, unknown>, 'Inbox.md');
  assert.equal(projectionsEqual(googleTasksProjectionFromVaultTask(googleImported), googleTasksProjectionFromRemoteTask(googleRemote)), false);

  const todoistAdapter = new TodoistAdapter({ apiKey: 'token', dryRun: true });
  const plan = planTodoistImports([{ externalId: 't1', payload: { id: 't1', content: 'Review [id:: injected]', description: '', priority: 1, labels: [], completed_at: null, added_at: '2026-01-01', updated_at: '2026-07-11' } }], new IdentityMapper(), todoistAdapter, 'Inbox.md');
  assert.equal(plan.mappings[0]?.baseline, undefined);
});

test('Todoist mapped divergence and missing baseline retain evidence without executable writes', async () => {
  const linked = task({ key: 'id:todoist:t1', tags: ['todoist'], normalizedText: 'Review spec #todoist', body: 'Review spec #todoist', metadata: { id: 'todoist:t1', dates: {}, invalidDates: {}, priority: 'normal', dependsOn: [] } });
  const adapter = new TodoistAdapter({ apiKey: 'token', dryRun: true });
  const remote = { externalId: 't1', payload: { id: 't1', content: 'Remote', description: '', priority: 1, labels: [], completed_at: null, added_at: '2026-01-01', updated_at: '2026-07-11' } };
  const mapper = new IdentityMapper();
  mapper.mapExternalId(linked.key, 'todoist', 't1');
  const queue = new SyncOperationQueue();
  const first = enqueueTodoistVaultOperations([linked], mapper, queue, adapter, true, [remote]);
  assert.equal(first.updates, 0);
  assert.equal(first.conflicts, 1);
  assert.equal(queue.getState().operations[0]?.status, 'conflict');
  assert.deepEqual(queue.getState().operations[0]?.payload, {});

  const queue2 = new SyncOperationQueue();
  mapper.recordBaseline(linked.key, 'todoist', todoistProjectionFromVaultTask(linked));
  const divergent = enqueueTodoistVaultOperations([linked], mapper, queue2, adapter, true, [remote]);
  assert.equal(divergent.updates, 0);
  assert.equal(divergent.conflicts, 1);
});

test('duplicate Todoist remote IDs fail closed before planning writes', () => {
  const linked = task({ key: 'id:todoist:t1', tags: ['todoist'], metadata: { id: 'todoist:t1', dates: {}, invalidDates: {}, priority: 'normal', dependsOn: [] } });
  const remote = { externalId: 't1', payload: { id: 't1', content: 'Remote', description: '', priority: 1, labels: [], completed_at: null, added_at: '2026-01-01', updated_at: '2026-07-11' } };
  assert.throws(() => enqueueTodoistVaultOperations([linked], new IdentityMapper(), new SyncOperationQueue(), new TodoistAdapter({ apiKey: 'token', dryRun: true }), true, [remote, remote]), /duplicate remote ID t1/u);
});

test('Todoist local-only change queues only the supported changed field after a fetched baseline match', () => {
  const linked = task({ key: 'id:todoist:t1', tags: ['todoist'], normalizedText: 'Changed #todoist', body: 'Changed #todoist', metadata: { id: 'todoist:t1', dates: {}, invalidDates: {}, priority: 'normal', dependsOn: [] } });
  const remote = { externalId: 't1', payload: { id: 't1', content: 'Before', description: '', priority: 1, labels: [], completed_at: null, added_at: '2026-01-01', updated_at: '2026-07-11' } };
  const mapper = new IdentityMapper();
  mapper.mapExternalId(linked.key, 'todoist', 't1');
  mapper.recordBaseline(linked.key, 'todoist', { title: 'Before', description: '', due: '', priority: 1, status: 'active', tags: [] });
  const queue = new SyncOperationQueue();
  const plan = enqueueTodoistVaultOperations([linked], mapper, queue, new TodoistAdapter({ apiKey: 'token', dryRun: true }), true, [remote]);
  assert.equal(plan.updates, 1);
  assert.deepEqual(queue.getState().operations[0]?.payload, { content: 'Changed' });
  assert.deepEqual(queue.getState().operations[0]?.fields, ['title']);
});

test('Todoist completion is held instead of invoking an unverifiable close', () => {
  const completed = task({ key: 'id:todoist:t1', status: 'done', checkbox: 'x', tags: ['todoist'], normalizedText: 'Review spec #todoist', body: 'Review spec #todoist', metadata: { id: 'todoist:t1', dates: {}, invalidDates: {}, priority: 'normal', dependsOn: [] } });
  const remote = { externalId: 't1', payload: { id: 't1', content: 'Review spec', description: '', priority: 1, labels: [], completed_at: null, added_at: '2026-01-01', updated_at: '2026-07-11' } };
  const mapper = new IdentityMapper();
  mapper.mapExternalId(completed.key, 'todoist', 't1');
  mapper.recordBaseline(completed.key, 'todoist', { title: 'Review spec', description: '', due: '', priority: 1, status: 'active', tags: [] });
  const queue = new SyncOperationQueue();
  const plan = enqueueTodoistVaultOperations([completed], mapper, queue, new TodoistAdapter({ apiKey: 'token', dryRun: true }), true, [remote]);
  assert.equal(plan.updates, 0);
  assert.equal(plan.conflicts, 1);
  assert.equal(queue.getState().operations[0]?.status, 'conflict');
});

test('conflicts survive restart and Retry failed excludes conflicts and stale reconciliation updates', () => {
  const queue = new SyncOperationQueue();
  const t = task();
  const evidence = reconcileSupportedProjections({ service: 'google-tasks', local: { title: 'L' }, remote: { title: 'R' } });
  queue.enqueueReconciliationConflict(t, 'google-tasks', 'g1', evidence.conflicts, evidence.evidence);
  const stale = queue.enqueueUpdate(t, 'google-tasks', 'g1', { title: 'stale' }, ['title'], 'normal', false, evidence.evidence);
  stale.status = 'failed';
  const transport = queue.enqueueUpdate(t, 'other', 'o1', { title: 'retry' });
  transport.status = 'failed';
  const restarted = new SyncOperationQueue(queue.getState());
  assert.equal(restarted.requeueFailed(), 1);
  assert.equal(restarted.getOperation(stale.id)?.status, 'failed');
  assert.equal(restarted.getState().operations.find((op) => op.status === 'conflict')?.reconciliation?.local.title, 'L');
});

test('legacy provider writes without reconciliation evidence are quarantined and never retried', () => {
  const t = task({ key: 'id:todoist:t1', metadata: { id: 'todoist:t1', dates: {}, invalidDates: {}, priority: 'normal', dependsOn: [] } });
  const queue = new SyncOperationQueue({
    version: 1,
    operations: [{ id: 'legacy', type: 'update', service: 'todoist', vaultTask: t, externalId: 't1', payload: { content: 'stale' }, queuedAt: 1, status: 'failed' }],
    completed: [],
  });
  assert.equal(queue.quarantineUnsafeProviderOperations('todoist'), 1);
  assert.equal(queue.requeueFailed('todoist'), 0);
  assert.equal(queue.getState().operations[0]?.status, 'conflict');
  assert.deepEqual(queue.getState().operations[0]?.payload, {});
  assert.equal(queue.getState().operations[0]?.reconciliation?.mode, 'conflict');
});

test('stale reconciliation queue updates are attempted once and never auto-replayed', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return { ok: false, status: 503, statusText: 'Unavailable', text: async () => '' } as Response;
  }) as typeof fetch;
  try {
    const queue = new SyncOperationQueue();
    queue.registerAdapter('google-tasks', new GoogleTasksAdapter({ accessToken: 'token', listId: 'list' }));
    const evidence = reconcileSupportedProjections({ service: 'google-tasks', local: { title: 'Local' }, remote: { title: 'Base' }, baseline: createBaselineEvidence({ title: 'Base' }), remoteVersion: '"e1"' });
    queue.enqueueUpdate(task(), 'google-tasks', 'g1', { title: 'Local' }, ['title'], 'normal', false, evidence.evidence);
    const result = await queue.executeAll(1);
    assert.equal(result.failed.length, 1);
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('Google and Microsoft adapters post-verify returned projections with one mutation call', async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
    if (String(input).includes('googleapis')) return { ok: true, status: 200, json: async () => ({ id: 'g1', title: 'Changed', notes: '', status: 'needsAction', etag: 'e2' }) } as Response;
    return { ok: true, status: 200, json: async () => ({ id: 'm1', title: 'Changed', body: { content: '', contentType: 'text' }, status: 'notStarted', importance: 'normal', isReminderOn: false, '@odata.etag': 'm2' }) } as Response;
  }) as typeof fetch;
  try {
    const google = new GoogleTasksAdapter({ accessToken: 'token', listId: 'list' });
    const googleResult = await google.update('g1', { title: 'Changed' }, false, '"e1"');
    assert.equal(googleResult.remoteVersion, 'e2');
    const microsoft = new MicrosoftTodoAdapter({ accessToken: 'token', listId: 'list', bidirectionalSync: false, syncIntervalMinutes: 0, vaultImportPath: 'Tasks.md' });
    const microsoftResult = await microsoft.update('m1', { title: 'Changed' });
    assert.equal(microsoftResult.remoteVersion, 'm2');
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls.length, 2);
  assert.equal(calls.every((call) => call.startsWith('PATCH ')), true);
});
