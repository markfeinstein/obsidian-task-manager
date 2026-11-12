import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyFieldResolutionsToPayload,
  applySyncQueueReviewActions,
  buildSyncConflictReviewModel,
  defaultFieldResolutions,
  SyncConflictReportModal,
} from '../src/sync-conflict-review';
import { installDomHarness } from './dom-harness';
import type { App } from 'obsidian';
import type { FieldConflict, OperationQueueState, SyncOperation } from '../src/sync-contract';
import type { MarkdownTask } from '../src/task-model';

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
    body: 'Review spec',
    normalizedText: 'Review spec',
    status: 'todo',
    tags: [],
    contexts: [],
    metadata: { dates: { due: '2026-06-01' }, invalidDates: {}, priority: 'normal', dependsOn: [] },
    ...overrides,
  } as MarkdownTask;
}

function conflict(field: string, vaultValue: unknown, serviceValue: unknown, service = 'todoist'): FieldConflict {
  return { field, vaultValue, serviceValue, service, detectedAt: 1000 };
}

function operation(overrides: Partial<SyncOperation> = {}): SyncOperation {
  return {
    id: 'op-1',
    type: 'update',
    service: 'todoist',
    vaultTask: task(),
    externalId: 'remote-1',
    fields: ['content', 'due'],
    payload: { content: 'Review spec', due: '2026-06-01' },
    queuedAt: 100,
    status: 'conflict',
    conflicts: [conflict('content', 'Review spec', 'Remote spec')],
    ...overrides,
  } as SyncOperation;
}

function state(operations: SyncOperation[]): OperationQueueState {
  return { operations, completed: [], version: 1 };
}

test('sync retry is single-flight and retains an announced inline failure', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const content = harness.document.createElement('div');
  harness.document.body.appendChild(content);
  const queueState = state([operation({ id: 'failed', status: 'failed', conflicts: undefined, error: 'timeout' })]);
  let calls = 0;
  let reject!: (error: Error) => void;
  const pending = new Promise<never>((_resolve, rejectPromise) => { reject = rejectPromise; });
  const modal = new SyncConflictReportModal({} as App, {
    getQueueState: () => queueState,
    onApplyQueueAction: async () => { calls += 1; return pending; },
  });
  (modal as unknown as { contentEl: HTMLElement }).contentEl = content;
  modal.onOpen();
  const retry = Array.from(content.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Retry all');
  retry?.click();
  Array.from(content.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent.includes('Requeuing'))?.click();
  assert.equal(calls, 1);
  assert.equal(Array.from(content.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent.includes('Requeuing'))?.disabled, true);
  reject(new Error('network unavailable'));
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  const alert = content.querySelector<HTMLElement>('[role="alert"]');
  assert.match(alert?.textContent ?? '', /network unavailable/u);
  assert.equal(Array.from(content.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Retry all')?.disabled, false);
});

test('wave d2: conflict review model summarizes queue conflicts and failures by service', () => {
  const queueState = state([
    operation({ id: 'conflict-1', service: 'todoist', status: 'conflict' }),
    operation({ id: 'failed-1', service: 'google-tasks', status: 'failed', conflicts: undefined, error: 'network' }),
    operation({ id: 'queued-1', service: 'ms-todo', status: 'queued', conflicts: undefined }),
  ]);

  const model = buildSyncConflictReviewModel(queueState, { now: 1234 });

  assert.equal(model.generatedAt, 1234);
  assert.equal(model.totalReports, 1);
  assert.equal(model.totalConflictedOperations, 1);
  assert.equal(model.totalFailedOperations, 1);
  assert.equal(model.retryableOperations.length, 1);
  assert.equal(model.byService.todoist.conflicted, 1);
  assert.equal(model.byService.todoist.retryable, 0, 'conflicts are evidence, not replayable payloads');
  assert.equal(model.byService['google-tasks'].failed, 1);
  assert.equal(model.reports[0].operationId, 'conflict-1');
});

test('wave d2: field resolutions can keep vault values, accept service values, or use custom values', () => {
  const conflicts = [
    conflict('content', 'Vault title', 'Service title'),
    conflict('due', '2026-06-01', '2026-06-02'),
    conflict('priority', 4, 1),
  ];

  const applied = applyFieldResolutionsToPayload(
    { content: 'Old', due: '2026-06-01', priority: 1, labels: ['work'] },
    conflicts,
    [
      { field: 'content', choice: 'vault' },
      { field: 'due', choice: 'service' },
      { field: 'priority', choice: 'custom', customValue: 3 },
    ],
  );

  assert.deepEqual(applied.payload, { content: 'Vault title', priority: 3, labels: ['work'] });
  assert.deepEqual(applied.resolvedFields, ['content', 'due', 'priority']);
  assert.deepEqual(applied.unresolvedConflicts, []);
});

test('wave d2: applying all-vault conflict resolutions requeues operation and updates payload', () => {
  const queueState = state([
    operation({
      id: 'op-conflict',
      status: 'conflict',
      conflicts: [conflict('content', 'Vault title', 'Service title'), conflict('due', '2026-06-01', '2026-06-02')],
      payload: { content: 'Old title', due: '2026-06-02' },
    }),
  ]);

  const result = applySyncQueueReviewActions(queueState, {
    now: 2000,
    conflictResolutions: [{
      operationId: 'op-conflict',
      resolutions: defaultFieldResolutions(queueState.operations[0]!.conflicts!, 'vault'),
    }],
  });

  assert.equal(result.resolved, 1);
  assert.equal(result.retried, 1);
  assert.equal(result.remainingConflicts, 0);
  assert.equal(result.state.operations[0]!.status, 'queued');
  assert.deepEqual(result.state.operations[0]!.payload, { content: 'Vault title', due: '2026-06-01' });
  assert.equal(result.state.operations[0]!.conflicts, undefined);
});

test('wave d2: retry and discard actions update only selected retained operations', () => {
  const queueState = state([
    operation({ id: 'failed', status: 'failed', conflicts: undefined, error: 'timeout' }),
    operation({ id: 'discard-me', status: 'conflict', conflicts: [conflict('content', 'A', 'B')] }),
    operation({ id: 'queued', status: 'queued', conflicts: undefined }),
  ]);

  const result = applySyncQueueReviewActions(queueState, {
    now: 3000,
    retryOperationIds: ['failed'],
    discardOperationIds: ['discard-me'],
  });

  assert.equal(result.retried, 1);
  assert.equal(result.discarded, 1);
  assert.deepEqual(result.state.operations.map((op) => `${op.id}:${op.status}`), ['failed:queued', 'queued:queued']);
  assert.equal(result.state.operations[0]!.error, undefined);
  assert.equal(result.state.completed.length, 1);
  assert.equal(result.state.completed[0]!.id, 'discard-me');
  assert.equal(result.state.completed[0]!.completedAt, 3000);
});

test('reconciliation conflict choices remain read-only and preserve durable evidence', () => {
  const op = operation({
    id: 'reconcile-conflict',
    reconciliation: {
      schemaVersion: 1,
      baseline: { content: 'Base' },
      local: { content: 'Vault title' },
      remote: { content: 'Service title' },
      mode: 'conflict',
      capturedAt: 1000,
    },
  });
  const result = applySyncQueueReviewActions(state([op]), {
    retryOperationIds: [op.id],
    conflictResolutions: [{ operationId: op.id, resolutions: [{ field: 'content', choice: 'vault' }] }],
  });
  assert.equal(result.retried, 0);
  assert.equal(result.state.operations[0]?.status, 'conflict');
  assert.equal(result.state.operations[0]?.reconciliation?.remote?.content, 'Service title');
  assert.deepEqual(result.state.operations[0]?.conflicts?.map((item) => item.field), ['content']);
});

test('wave d2: partial field resolution leaves unresolved conflicts retained for review', () => {
  const queueState = state([
    operation({
      id: 'partial',
      status: 'conflict',
      conflicts: [conflict('content', 'Vault title', 'Service title'), conflict('due', '2026-06-01', '2026-06-02')],
      payload: { content: 'Old title', due: '2026-06-02' },
    }),
  ]);

  const result = applySyncQueueReviewActions(queueState, {
    conflictResolutions: [{ operationId: 'partial', resolutions: [{ field: 'content', choice: 'vault' }] }],
  });

  assert.equal(result.retried, 0);
  assert.equal(result.remainingConflicts, 1);
  assert.equal(result.state.operations[0]!.status, 'conflict');
  assert.deepEqual(result.state.operations[0]!.payload, { content: 'Vault title', due: '2026-06-02' });
  assert.deepEqual(result.state.operations[0]!.conflicts?.map((c) => c.field), ['due']);
});
