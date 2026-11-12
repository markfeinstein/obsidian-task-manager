/**
 * Sync Contract Foundation Tests
 *
 * Tests for:
 * - Stable identity mapping
 * - Operation queue with dry-run
 * - Per-field conflict tracking
 * - Adapter capabilities
 * - Todoist adapter
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { IdentityMapper } from '../src/sync-identity-mapper';
import { SyncOperationQueue } from '../src/sync-operations';
import { TodoistAdapter } from '../src/todoist-sync';
import type { SyncAdapter } from '../src/sync-contract';
import type { MarkdownTask } from '../src/task-model';

// Mock MarkdownTask for testing
function createMockTask(body: string, key: string): MarkdownTask {
  return {
    key,
    filePath: 'test.md',
    lineNumber: 1,
    rawLine: `- [ ] ${body}`,
    linePrefix: '',
    indentation: '',
    listMarker: '-',
    checkbox: ' ',
    body,
    normalizedText: body,
    status: 'todo',
    tags: [],
    contexts: [],
    metadata: {
      id: key,
      dates: { due: undefined },
      invalidDates: {},
      priority: 'normal' as const,
      dependsOn: [],
    },
  };
}

// ── Identity Mapper Tests ──────────────────────────────────────────────

test('sync-contract: identity mapper creates new identity', () => {
  const mapper = new IdentityMapper();
  const identity = mapper.getOrCreateIdentity('vault-task-1');

  assert.equal(identity.vaultKey, 'vault-task-1');
  assert.deepEqual(identity.externalIds, {});
  assert.ok(identity.createdAt > 0);
});

test('sync-contract: identity mapper maps external IDs', () => {
  const mapper = new IdentityMapper();
  mapper.getOrCreateIdentity('vault-task-1');

  mapper.mapExternalId('vault-task-1', 'todoist', 'todoist-123');
  mapper.mapExternalId('vault-task-1', 'google', 'google-456');

  assert.equal(mapper.getExternalId('vault-task-1', 'todoist'), 'todoist-123');
  assert.equal(mapper.getExternalId('vault-task-1', 'google'), 'google-456');
});

test('sync-contract: identity mapper looks up by external ID', () => {
  const mapper = new IdentityMapper();

  mapper.mapExternalId('vault-task-1', 'todoist', 'todoist-123');
  mapper.mapExternalId('vault-task-2', 'todoist', 'todoist-456');

  assert.equal(mapper.lookupByExternalId('todoist', 'todoist-123'), 'vault-task-1');
  assert.equal(mapper.lookupByExternalId('todoist', 'todoist-456'), 'vault-task-2');
});

test('sync-contract: identity mapper remapping external ID removes previous owner', () => {
  const mapper = new IdentityMapper();

  mapper.mapExternalId('vault-task-1', 'todoist', 'todoist-123');
  mapper.mapExternalId('vault-task-2', 'todoist', 'todoist-123');

  assert.equal(mapper.lookupByExternalId('todoist', 'todoist-123'), 'vault-task-2');
  assert.equal(mapper.getExternalId('vault-task-1', 'todoist'), undefined);
  assert.equal(mapper.getExternalId('vault-task-2', 'todoist'), 'todoist-123');
  assert.deepEqual(mapper.getIdentitiesByService('todoist').map((identity) => identity.vaultKey), ['vault-task-2']);
  assert.deepEqual(mapper.getState().identities.map((identity) => identity.externalIds), [
    {},
    { todoist: 'todoist-123' },
  ]);
});

test('sync-contract: identity mapper detects content changes', () => {
  const mapper = new IdentityMapper();

  mapper.recordContentHash('vault-task-1', 'Buy milk');
  assert.ok(!mapper.hasContentChanged('vault-task-1', 'Buy milk'));
  assert.ok(mapper.hasContentChanged('vault-task-1', 'Buy eggs'));
});

test('sync-contract: identity mapper records per-field hashes', () => {
  const mapper = new IdentityMapper();

  mapper.recordFieldHash('vault-task-1', 'title', 'Buy milk');
  mapper.recordFieldHash('vault-task-1', 'due', '2026-06-01');
  mapper.recordFieldHash('vault-task-1', 'labels', ['work']);
  mapper.recordFieldHash('vault-task-1', 'dueObject', { date: '2026-06-01' });

  assert.ok(!mapper.hasFieldChanged('vault-task-1', 'title', 'Buy milk'));
  assert.ok(mapper.hasFieldChanged('vault-task-1', 'title', 'Buy eggs'));
  assert.ok(!mapper.hasFieldChanged('vault-task-1', 'due', '2026-06-01'));
  assert.ok(mapper.hasFieldChanged('vault-task-1', 'due', '2026-06-02'));
  assert.ok(!mapper.hasFieldChanged('vault-task-1', 'labels', ['work']));
  assert.ok(mapper.hasFieldChanged('vault-task-1', 'labels', ['personal']));
  assert.ok(!mapper.hasFieldChanged('vault-task-1', 'dueObject', { date: '2026-06-01' }));
  assert.ok(mapper.hasFieldChanged('vault-task-1', 'dueObject', { date: '2026-06-02' }));
});

test('sync-contract: identity mapper migrates on move', () => {
  const mapper = new IdentityMapper();

  mapper.mapExternalId('vault-task-1', 'todoist', 'todoist-123');
  mapper.migrateIdentity('vault-task-1', 'vault-task-1-moved');

  assert.equal(mapper.getExternalId('vault-task-1-moved', 'todoist'), 'todoist-123');
  assert.equal(mapper.getExternalId('vault-task-1', 'todoist'), undefined);
  assert.deepEqual(mapper.getIdentitiesByService('todoist').map((identity) => identity.vaultKey), ['vault-task-1-moved']);
});

test('sync-contract: identity mapper removes identity', () => {
  const mapper = new IdentityMapper();

  mapper.mapExternalId('vault-task-1', 'todoist', 'todoist-123');
  mapper.removeIdentity('vault-task-1');

  assert.equal(mapper.getExternalId('vault-task-1', 'todoist'), undefined);
  assert.equal(mapper.lookupByExternalId('todoist', 'todoist-123'), undefined);
  assert.deepEqual(mapper.getIdentitiesByService('todoist'), []);
});

test('sync-contract: identity mapper removes external ID indexes', () => {
  const mapper = new IdentityMapper();

  mapper.mapExternalId('vault-task-1', 'todoist', 'todoist-123');
  mapper.removeExternalId('todoist', 'todoist-123');

  assert.equal(mapper.getExternalId('vault-task-1', 'todoist'), undefined);
  assert.equal(mapper.lookupByExternalId('todoist', 'todoist-123'), undefined);
  assert.deepEqual(mapper.getIdentitiesByService('todoist'), []);
  assert.deepEqual(mapper.getState().identities[0].externalIds, {});
});

test('sync-contract: identity mapper persists state', () => {
  const mapper1 = new IdentityMapper();
  mapper1.mapExternalId('vault-task-1', 'todoist', 'todoist-123');

  const state = mapper1.getState();
  const mapper2 = new IdentityMapper(state);

  assert.equal(mapper2.getExternalId('vault-task-1', 'todoist'), 'todoist-123');
});

test('sync-contract: identity mapper clear removes persisted identities', () => {
  const mapper = new IdentityMapper({
    identities: [
      {
        vaultKey: 'vault-task-1',
        externalIds: { todoist: 'todoist-123' },
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    version: 1,
  });

  mapper.clear();

  assert.deepEqual(mapper.getState().identities, []);
  assert.equal(mapper.lookupByExternalId('todoist', 'todoist-123'), undefined);
});

// ── Operation Queue Tests ──────────────────────────────────────────────

test('sync-contract: operation queue enqueues create operation', () => {
  const queue = new SyncOperationQueue();
  const task = createMockTask('Test task', 'task-1');

  const op = queue.enqueueCreate(task, 'todoist', { content: 'Test task' });

  assert.equal(op.type, 'create');
  assert.equal(op.service, 'todoist');
  assert.equal(op.status, 'queued');
});

test('sync-contract: operation queue enqueues update operation', () => {
  const queue = new SyncOperationQueue();
  const task = createMockTask('Test task', 'task-1');

  const op = queue.enqueueUpdate(task, 'todoist', 'todoist-123', { content: 'Updated' });

  assert.equal(op.type, 'update');
  assert.equal(op.externalId, 'todoist-123');
  assert.equal(op.status, 'queued');
});

test('sync-contract: operation queue enqueues delete operation', () => {
  const queue = new SyncOperationQueue();
  const task = createMockTask('Test task', 'task-1');

  const op = queue.enqueueDelete(task, 'todoist', 'todoist-123');

  assert.equal(op.type, 'delete');
  assert.equal(op.externalId, 'todoist-123');
});

test('sync-contract: operation queue enqueues reopen operation', () => {
  const queue = new SyncOperationQueue();
  const task = createMockTask('Test task', 'task-1');

  const op = queue.enqueueReopen(task, 'todoist', 'todoist-123');

  assert.equal(op.type, 'reopen');
  assert.equal(op.externalId, 'todoist-123');
});

test('sync-contract: operation queue generates dry-run output', async () => {
  const queue = new SyncOperationQueue();
  const adapter = new TodoistAdapter({ apiKey: 'test-key' });
  queue.registerAdapter('todoist', adapter);

  const task = createMockTask('Test task', 'task-1');
  queue.enqueueCreate(task, 'todoist', { content: 'Test task' }, 'normal', true);

  const dryRun = await queue.generateDryRunOutput();

  assert.equal(dryRun.totalOperations, 1);
  assert.equal(dryRun.byType.create, 1);
  assert.equal(dryRun.byService.todoist, 1);
});

test('sync-contract: dry-run reports omitted capability fields as unsupported', async () => {
  const queue = new SyncOperationQueue();
  const task = createMockTask('Test task', 'task-1');
  const adapter: SyncAdapter = {
    getCapabilities: () => ({
      service: 'mock',
      status: 'stable',
      supports: { create: true, update: true, delete: true, reopen: true },
      fields: { title: 'native' },
    }),
    isConfigured: async () => true,
    toServicePayload: () => ({}),
    fromServicePayload: () => task,
    create: async () => ({ externalId: 'mock-1', hash: 'hash-1' }),
    update: async () => ({ hash: 'hash-1' }),
    delete: async () => {},
    reopen: async () => {},
    fetchAll: async () => [],
    testConnection: async () => ({ ok: true }),
  };

  queue.registerAdapter('mock', adapter);
  queue.enqueueUpdate(task, 'mock', 'mock-1', { unknown_field: 'value' }, ['unknown_field'], 'normal', true);

  const dryRun = await queue.generateDryRunOutput();

  assert.deepEqual(dryRun.fieldWarnings, [{
    field: 'unknown_field',
    service: 'mock',
    level: 'error',
    message: 'Field "unknown_field" is not supported on mock',
  }]);
});

test('sync-contract: operation queue retrieves pending operations', () => {
  const queue = new SyncOperationQueue();
  const task = createMockTask('Test task', 'task-1');

  queue.enqueueCreate(task, 'todoist', { content: 'Test task' });
  queue.enqueueCreate(task, 'google', { content: 'Test task' });

  const pending = queue.getPending();
  assert.equal(pending.length, 2);
});

test('sync-contract: scoped execution leaves other provider operations untouched', async () => {
  const queue = new SyncOperationQueue();
  const adapter = new TodoistAdapter({ apiKey: 'test-key', dryRun: true });
  queue.registerAdapter('todoist', adapter);
  queue.registerAdapter('google-tasks', adapter);
  const task = createMockTask('Test task', 'task-1');
  queue.enqueueCreate(task, 'todoist', { content: 'Todoist' }, 'normal', true);
  queue.enqueueCreate(task, 'google-tasks', { content: 'Google' }, 'normal', true);

  const result = await queue.executeAll(2, 'todoist');

  assert.equal(result.successful.length, 1);
  assert.equal(result.successful[0]?.service, 'todoist');
  assert.deepEqual(queue.getPending().map((operation) => operation.service), ['google-tasks']);
});

test('sync-contract: operation queue persists state', () => {
  const queue1 = new SyncOperationQueue();
  const task = createMockTask('Test task', 'task-1');

  queue1.enqueueCreate(task, 'todoist', { content: 'Test task' });

  const state = queue1.getState();
  const queue2 = new SyncOperationQueue(state);

  const pending = queue2.getPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.type, 'create');
});

test('sync-contract: operation queue caps completed operation history', () => {
  const queue = new SyncOperationQueue();
  const task = createMockTask('Test task', 'task-1');

  for (let i = 0; i < 105; i += 1) {
    const op = queue.enqueueCreate(task, 'todoist', { content: `Task ${i}` });
    queue.removeOperations([op.id]);
  }

  const state = queue.getState();
  assert.equal(state.completed.length, 100);
  assert.equal(state.completed[0]!.id, 'sync-op-6');
  assert.equal(state.completed[99]!.id, 'sync-op-105');
});

test('sync-contract: operation queue restores operationId counter from persisted state (no ID collisions)', () => {
  // Bug: loadState() previously parsed split('-')[1] = "op" (NaN) instead of split('-')[2] = the number.
  // After reload, operationId stayed at 0 and new operations got duplicate IDs.
  const queue1 = new SyncOperationQueue();
  const task = createMockTask('Task A', 'task-a');

  // Enqueue 3 operations so the highest persisted ID is "sync-op-3"
  const op1 = queue1.enqueueCreate(task, 'todoist', { content: 'A' });
  const op2 = queue1.enqueueCreate(task, 'todoist', { content: 'B' });
  const op3 = queue1.enqueueCreate(task, 'todoist', { content: 'C' });
  assert.equal(op1.id, 'sync-op-1');
  assert.equal(op2.id, 'sync-op-2');
  assert.equal(op3.id, 'sync-op-3');

  // Simulate plugin reload by constructing a new queue from persisted state
  const state = queue1.getState();
  const queue2 = new SyncOperationQueue(state);

  // The first new operation must NOT collide with any existing operation
  const op4 = queue2.enqueueCreate(createMockTask('Task B', 'task-b'), 'todoist', { content: 'D' });
  assert.notEqual(op4.id, 'sync-op-1');
  assert.notEqual(op4.id, 'sync-op-2');
  assert.notEqual(op4.id, 'sync-op-3');
  assert.equal(op4.id, 'sync-op-4', 'counter must continue from the highest persisted ID');
});

test('sync-contract: operation queue clear removes completed history', () => {
  const queue = new SyncOperationQueue();
  const task = createMockTask('Task A', 'task-a');
  const op = queue.enqueueCreate(task, 'todoist', { content: 'A' });

  queue.removeOperations([op.id]);
  assert.equal(queue.getState().operations.length, 0);
  assert.equal(queue.getState().completed.length, 1);

  queue.clear();

  assert.equal(queue.getState().operations.length, 0);
  assert.equal(queue.getState().completed.length, 0);
  assert.equal(queue.getOperation(op.id), undefined);
});

test('sync-contract: operation queue restores operationId counter from completed history', () => {
  const queue1 = new SyncOperationQueue();
  const task = createMockTask('Task A', 'task-a');

  const op1 = queue1.enqueueCreate(task, 'todoist', { content: 'A' });
  const op2 = queue1.enqueueCreate(task, 'todoist', { content: 'B' });
  queue1.removeOperations([op1.id, op2.id]);

  const state = queue1.getState();
  assert.equal(state.operations.length, 0);
  assert.equal(state.completed.length, 2);

  const queue2 = new SyncOperationQueue(state);
  const op3 = queue2.enqueueCreate(createMockTask('Task C', 'task-c'), 'todoist', { content: 'C' });

  assert.equal(op3.id, 'sync-op-3');
});

test('sync-contract: operation queue ignores malformed persisted operation IDs', () => {
  const task = createMockTask('Task A', 'task-a');
  const queue = new SyncOperationQueue({
    version: 1,
    operations: [
      {
        id: 9,
        type: 'create',
        service: 'todoist',
        vaultTask: task,
        payload: { content: 'A' },
        queuedAt: 1,
        status: 'queued',
      },
      {
        id: 'sync-op-4',
        type: 'create',
        service: 'todoist',
        vaultTask: task,
        payload: { content: 'B' },
        queuedAt: 2,
        status: 'queued',
      },
    ],
    completed: [],
  } as never);

  const op = queue.enqueueCreate(createMockTask('Task B', 'task-b'), 'todoist', { content: 'C' });

  assert.equal(op.id, 'sync-op-5');
});

test('sync-contract: operation queue quarantines interrupted read-first operations and trims completed history', () => {
  const task = createMockTask('Task A', 'task-a');
  const state = {
    version: 1,
    operations: [
      {
        id: 'sync-op-101',
        type: 'create',
        service: 'todoist',
        vaultTask: task,
        payload: { content: 'A' },
        queuedAt: 1,
        status: 'executing',
      },
    ],
    completed: Array.from({ length: 101 }, (_, index) => ({
      id: `sync-op-${index + 1}`,
      type: 'create',
      service: 'todoist',
      vaultTask: task,
      payload: { content: `Completed ${index + 1}` },
      queuedAt: index + 1,
      status: 'success',
      completedAt: index + 1000,
    })),
  };

  const queue = new SyncOperationQueue(state as never);

  assert.deepEqual(queue.getPending().map((op) => op.id), []);
  assert.equal(queue.getOperation('sync-op-101')?.status, 'conflict');
  assert.deepEqual(queue.getOperation('sync-op-101')?.payload, {});
  assert.equal(queue.getState().completed.length, 100);
  assert.equal(queue.enqueueCreate(createMockTask('Task B', 'task-b'), 'todoist', { content: 'C' }).id, 'sync-op-102');
});

test('sync-contract: interrupted non-read-first operations resume queued', () => {
  const task = createMockTask('Task A', 'task-a');
  const queue = new SyncOperationQueue({
    version: 2,
    operations: [{
      id: 'sync-op-1', type: 'update', service: 'mock', vaultTask: task, externalId: 'remote-1',
      payload: { title: 'Changed' }, queuedAt: 1, status: 'executing',
    }],
    completed: [],
  } as never);

  assert.deepEqual(queue.getPending().map((operation) => operation.id), ['sync-op-1']);
  assert.equal(queue.getOperation('sync-op-1')?.status, 'queued');
});

test('sync-contract: operation queue clamps non-positive concurrency while executing', async () => {
  const queue = new SyncOperationQueue();
  const task = createMockTask('Task A', 'task-a');
  let createCalls = 0;

  const adapter: SyncAdapter = {
    getCapabilities: () => ({
      service: 'mock',
      status: 'stable',
      supports: { create: true, update: true, delete: true, reopen: true },
      fields: {},
    }),
    isConfigured: async () => true,
    toServicePayload: () => ({}),
    fromServicePayload: () => task,
    create: async () => {
      createCalls++;
      return { externalId: 'mock-1', hash: 'hash-1' };
    },
    update: async () => ({ hash: 'hash-1' }),
    delete: async () => {},
    reopen: async () => {},
    fetchAll: async () => [],
    testConnection: async () => ({ ok: true }),
  };

  queue.registerAdapter('mock', adapter);
  queue.enqueueCreate(task, 'mock', { content: 'Task A' });

  const result = await queue.executeAll(0);

  assert.equal(createCalls, 1);
  assert.equal(result.successful.length, 1);
  assert.equal(result.failed.length, 0);
  assert.equal(result.conflicts.length, 0);
});

// ── Todoist Adapter Tests ──────────────────────────────────────────────

test('sync-contract: todoist adapter reports capabilities', () => {
  const adapter = new TodoistAdapter({ apiKey: 'test-key' });
  const cap = adapter.getCapabilities();

  assert.equal(cap.service, 'todoist');
  assert.equal(cap.status, 'experimental');
  assert.ok(cap.supports.create);
  assert.ok(cap.supports.update);
  assert.ok(cap.supports.delete);
  assert.ok(cap.supports.reopen);
});

test('sync-contract: todoist adapter converts vault task to payload', () => {
  const adapter = new TodoistAdapter({ apiKey: 'test-key' });
  const task = createMockTask('Buy milk 🔺 📅 2026-06-01', 'task-1');
  task.tags = ['grocery'];

  const payload = adapter.toServicePayload(task);

  assert.equal(payload.content, 'Buy milk 🔺 📅 2026-06-01');
  assert.equal(payload.priority, 4); // 🔺 maps to priority 4
});

test('sync-contract: todoist adapter converts service payload to vault task', () => {
  const adapter = new TodoistAdapter({ apiKey: 'test-key' });
  const payload = {
    id: 'todoist-123',
    content: 'Buy milk',
    priority: 4,
    completed_at: null,
    added_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const task = adapter.fromServicePayload(payload, 'test.md');

  assert.equal(task.body, 'Buy milk');
  assert.ok(task.rawLine.includes('🔺')); // Priority 4 maps to 🔺
});

test('sync-contract: todoist adapter marks completed tasks', () => {
  const adapter = new TodoistAdapter({ apiKey: 'test-key' });
  const payload = {
    id: 'todoist-123',
    content: 'Buy milk',
    priority: 1,
    completed_at: '2026-05-27T10:00:00Z',
    added_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };

  const task = adapter.fromServicePayload(payload, 'test.md');

  assert.equal(task.checkbox, 'x');
  assert.equal(task.status, 'done');
});

// ── Integration Tests ──────────────────────────────────────────────────

test('sync-contract: end-to-end identity + operation flow', () => {
  const mapper = new IdentityMapper();
  const queue = new SyncOperationQueue();
  const task = createMockTask('Buy milk', 'vault-task-1');

  // Create task
  const createOp = queue.enqueueCreate(task, 'todoist', { content: 'Buy milk' });

  // Map identity after creation (simulating successful creation)
  mapper.mapExternalId('vault-task-1', 'todoist', 'todoist-123');

  // Update task
  const updateOp = queue.enqueueUpdate(
    task,
    'todoist',
    mapper.getExternalId('vault-task-1', 'todoist')!,
    { content: 'Buy milk and eggs' },
  );

  assert.ok(createOp.id);
  assert.ok(updateOp.externalId);
  assert.equal(mapper.getExternalId('vault-task-1', 'todoist'), 'todoist-123');
});
