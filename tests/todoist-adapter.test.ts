import test from 'node:test';
import assert from 'node:assert/strict';
import { IdentityMapper } from '../src/sync-identity-mapper';
import { SyncOperationQueue } from '../src/sync-operations';
import {
  accumulateTodoistSnapshotBudget,
  applyTodoistImportMappings,
  bootstrapTodoistIdentityMappings,
  enqueueTodoistVaultOperations,
  planTodoistImports,
  TodoistAdapter,
  TodoistApiError,
  todoistExternalIdFromTask,
  todoistProjectionFromVaultTask,
  todoistVaultKeyForExternalId,
} from '../src/todoist-sync';
import { parseMarkdownTaskLine, type MarkdownTask } from '../src/task-model';

function task(overrides: Partial<MarkdownTask> = {}): MarkdownTask {
  return {
    key: 'Tasks.md:Review spec',
    filePath: 'Tasks.md',
    lineNumber: 1,
    rawLine: '- [ ] Review spec #todoist 📅 2026-06-01',
    linePrefix: '',
    indentation: '',
    listMarker: '-',
    checkbox: ' ',
    body: 'Review spec',
    normalizedText: 'Review spec #todoist',
    status: 'todo',
    tags: ['todoist'],
    contexts: [],
    metadata: {
      dates: { due: '2026-06-01' },
      invalidDates: {},
      priority: 'normal',
      dependsOn: [],
    },
    ...overrides,
  } as MarkdownTask;
}

test('todoist: extracts external IDs from both supported ID conventions', () => {
  assert.equal(todoistExternalIdFromTask(task({ metadata: { dates: {}, invalidDates: {}, priority: 'normal', dependsOn: [], id: 'todoist-123' } })), '123');
  assert.equal(todoistExternalIdFromTask(task({ metadata: { dates: {}, invalidDates: {}, priority: 'normal', dependsOn: [], id: 'todoist:abc' } })), 'abc');
  assert.equal(todoistExternalIdFromTask(task({ metadata: { dates: {}, invalidDates: {}, priority: 'normal', dependsOn: [], id: 'todoist:123/close' } })), undefined);
  assert.equal(todoistVaultKeyForExternalId('Todoist Inbox.md', 'abc'), 'id:todoist:abc');
});

test('todoist adapter: treats blank API keys as unconfigured without network calls', async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return { ok: true } as Response;
  }) as typeof fetch;

  try {
    const adapter = new TodoistAdapter({ apiKey: '   ' });
    assert.equal(await adapter.isConfigured(), false);
    await assert.rejects(() => adapter.fetchAll(), /Not authenticated with Todoist/u);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(called, false);
});

test('todoist adapter: trims API keys before sending authorization headers', async () => {
  const originalFetch = globalThis.fetch;
  const headers: Array<HeadersInit | undefined> = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    headers.push(init?.headers);
    return { ok: true, json: async () => ({ results: [], next_cursor: null }) } as Response;
  }) as typeof fetch;

  try {
    const adapter = new TodoistAdapter({ apiKey: ' token ' });
    await adapter.fetchAll();
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(headers, [{ Authorization: 'Bearer token' }]);
});

test('todoist adapter: wraps fetchAll network failures with adapter context', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('network down');
  }) as typeof fetch;

  try {
    const adapter = new TodoistAdapter({ apiKey: 'token' });
    await assert.rejects(() => adapter.fetchAll(), /Todoist fetch failed: (?:Network request failed: )?network down/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('todoist adapter: rejects malformed fetchAll payloads without undefined IDs', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ results: [{ content: 'Missing id', priority: 1 }], next_cursor: null }),
  } as Response)) as typeof fetch;

  try {
    const adapter = new TodoistAdapter({ apiKey: 'token' });
    await assert.rejects(() => adapter.fetchAll(), /Todoist fetch failed: Invalid Todoist task payload: missing task id/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('todoist adapter: follows API v1 cursor pagination and preserves project filtering', async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  const remote = (id: string) => ({ id, content: `Task ${id}`, priority: 1, added_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' });
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input);
    urls.push(url);
    const cursor = new URL(url).searchParams.get('cursor');
    return {
      ok: true,
      status: 200,
      json: async () => cursor === 'page-2'
        ? { results: [remote('t2')], next_cursor: null }
        : { results: [remote('t1')], next_cursor: 'page-2' },
    } as Response;
  }) as typeof fetch;

  try {
    const result = await new TodoistAdapter({ apiKey: 'token', projectId: 'project one' }).fetchAll();
    assert.deepEqual(result.map((item) => item.externalId), ['t1', 't2']);
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(urls.length, 2);
  for (const value of urls) {
    const url = new URL(value);
    assert.equal(`${url.origin}${url.pathname}`, 'https://api.todoist.com/api/v1/tasks');
    assert.equal(url.searchParams.get('limit'), '200');
    assert.equal(url.searchParams.get('project_id'), 'project one');
  }
  assert.equal(new URL(urls[1]).searchParams.get('cursor'), 'page-2');
});

test('todoist adapter: rejects malformed and repeated API v1 cursors', async (t) => {
  for (const [name, nextCursor, expected, expectedCalls] of [
    ['missing', undefined, /expected \{ results, next_cursor \}/u, 1],
    ['empty', '', /malformed next_cursor/u, 1],
    ['wrong type', 42, /malformed next_cursor/u, 1],
    ['repeated', 'same', /repeated next_cursor/u, 2],
  ] as const) {
    await t.test(name, async () => {
      const originalFetch = globalThis.fetch;
      let calls = 0;
      globalThis.fetch = (async () => {
        calls += 1;
        const payload: Record<string, unknown> = { results: [] };
        if (nextCursor !== undefined) payload.next_cursor = nextCursor;
        return { ok: true, status: 200, json: async () => payload } as Response;
      }) as typeof fetch;
      try {
        await assert.rejects(() => new TodoistAdapter({ apiKey: 'token' }).fetchAll(), expected);
        assert.equal(calls, expectedCalls);
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }
});

test('todoist adapter: enforces the reviewed API v1 page bound', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ results: [], next_cursor: `page-${calls}` }) } as Response;
  }) as typeof fetch;
  try {
    await assert.rejects(() => new TodoistAdapter({ apiKey: 'token' }).fetchAll(), /exceeded 100 pages/u);
    assert.equal(calls, 100);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('todoist adapter: rejects duplicate task IDs across API v1 pages', async () => {
  const originalFetch = globalThis.fetch;
  let calls = 0;
  const duplicate = { id: 'same', content: 'Same', priority: 1, added_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
  globalThis.fetch = (async () => {
    calls += 1;
    return { ok: true, status: 200, json: async () => ({ results: [duplicate], next_cursor: calls === 1 ? 'next' : null }) } as Response;
  }) as typeof fetch;
  try {
    await assert.rejects(() => new TodoistAdapter({ apiKey: 'token' }).fetchAll(), /duplicate task id same/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('todoist adapter: carries bounded structured retry metadata', async (t) => {
  for (const [name, headers, body, expectedRetry] of [
    ['header', { 'retry-after': '7' }, { error_tag: 'RATE_LIMITED', error_extra: { retry_after: 9 } }, 7000],
    ['body', {}, { error_tag: 'TEMPORARY_ERROR', error_extra: { retry_after: 45 } }, 30000],
  ] as const) {
    await t.test(name, async () => {
      const originalFetch = globalThis.fetch;
      globalThis.fetch = (async () => Response.json(body, { status: 429, headers })) as typeof fetch;
      try {
        await assert.rejects(
          () => new TodoistAdapter({ apiKey: 'token' }).fetchAll(),
          (error: unknown) => error instanceof TodoistApiError
            && error.statusCode === 429
            && error.retryAfterMs === expectedRetry
            && error.message.includes(String(body.error_tag)),
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  }
});

test('todoist adapter: enforces page, field, and aggregate snapshot budgets', async () => {
  const originalFetch = globalThis.fetch;
  const base = { id: 'bounded', content: 'Task', priority: 1, added_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z' };
  globalThis.fetch = (async () => ({ ok: true, status: 200, json: async () => ({ results: Array.from({ length: 201 }, () => base), next_cursor: null }) } as Response)) as typeof fetch;
  try {
    await assert.rejects(() => new TodoistAdapter({ apiKey: 'token' }).fetchAll(), /page exceeded 200 tasks/u);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const adapter = new TodoistAdapter({ apiKey: 'token', dryRun: true });
  assert.throws(() => adapter.fromServicePayload({ ...base, content: 'x'.repeat(65_537) }, 'Inbox.md'), /content is too large/u);
  assert.throws(() => adapter.fromServicePayload({ ...base, labels: Array.from({ length: 501 }, () => 'x') }, 'Inbox.md'), /bounded string list/u);
  assert.equal(accumulateTodoistSnapshotBudget(0, 0, { id: 'a' }, { maxTasks: 1, maxBytes: 100 }), 10);
  assert.throws(() => accumulateTodoistSnapshotBudget(1, 0, { id: 'b' }, { maxTasks: 1, maxBytes: 100 }), /exceeded 1 tasks/u);
  assert.throws(() => accumulateTodoistSnapshotBudget(0, 8, { id: 'c' }, { maxTasks: 2, maxBytes: 10 }), /aggregate bytes/u);
});

test('todoist adapter: rejects malformed create responses without recording undefined IDs', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    json: async () => ({ id: '123', content: 'Missing priority' }),
  } as Response)) as typeof fetch;

  try {
    const adapter = new TodoistAdapter({ apiKey: 'token' });
    await assert.rejects(() => adapter.create({ content: 'Create me' }), /Todoist create failed: Invalid Todoist task payload: invalid task priority/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('todoist adapter: rejects malformed fromServicePayload inputs', () => {
  const adapter = new TodoistAdapter({ apiKey: 'token', dryRun: true });

  assert.throws(
    () => adapter.fromServicePayload({ id: '123', priority: 1 }, 'Todoist Inbox.md'),
    /Invalid Todoist task payload: missing task content/u,
  );
  assert.throws(
    () => adapter.fromServicePayload({ id: 'x] [exclude_from_sync:: true', content: 'Injected', priority: 1 }, 'Todoist Inbox.md'),
    /Invalid Todoist task payload: invalid task id/u,
  );
});

test('todoist adapter: sanitizes imported metadata syntax from content and descriptions', () => {
  const adapter = new TodoistAdapter({ apiKey: 'token', dryRun: true });
  const imported = adapter.fromServicePayload({
    id: 'safeid',
    content: 'Injected [exclude_from_sync:: true] 📅 2099-01-01 🆔 evil_id 🔁 every day',
    description: 'Note [exclude_from_sync:: true] 📅 2099-01-01',
    priority: 1,
    labels: ['x] [due:: 2099-01-01'],
    added_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
    completed_at: null,
  }, 'Todoist Inbox.md');

  assert.doesNotMatch(imported.rawLine, /exclude_from_sync|evil_id|every day|📅/u);
  const parsed = parseMarkdownTaskLine(imported.rawLine.split('\n')[0], 'Todoist Inbox.md', 1);
  assert.equal(parsed?.metadata.id, 'todoist:safeid');
  assert.equal(parsed?.metadata.excludeFromSync, false);
  assert.equal(parsed?.metadata.dates.due, undefined);
  assert.equal(parsed?.metadata.recurrence, undefined);
  assert.deepEqual(imported.metadata.comments, ['Note']);
});

test('todoist adapter: neutralizes routing tags and contexts from remote content while preserving labels', () => {
  const adapter = new TodoistAdapter({ apiKey: 'token', dryRun: true });
  const imported = adapter.fromServicePayload({
    id: 'route-safe',
    content: 'Bridge #google-calendar #todoist @work',
    description: 'Note #google-calendar @note',
    priority: 1,
    labels: ['review'],
    added_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
    completed_at: null,
  }, 'Todoist Inbox.md');

  assert.match(imported.rawLine, /\\#google-calendar/u);
  assert.match(imported.rawLine, /\\#todoist/u);
  assert.match(imported.rawLine, /\\@work/u);
  const parsed = parseMarkdownTaskLine(imported.rawLine.split('\n')[0], 'Todoist Inbox.md', 1);
  assert.ok(parsed);
  assert.deepEqual(parsed.tags, ['review']);
  assert.deepEqual(parsed.contexts, []);
  assert.equal(parsed.metadata.id, 'todoist:route-safe');
});

test('todoist: bootstrap mappings prevent duplicate create operations for imported tasks', async () => {
  const imported = task({
    key: 'Todoist Inbox.md:id:todoist:123',
    filePath: 'Todoist Inbox.md',
    tags: [],
    metadata: { dates: {}, invalidDates: {}, priority: 'normal', dependsOn: [], id: 'todoist:123' },
  });
  const mapper = new IdentityMapper();
  assert.equal(bootstrapTodoistIdentityMappings([imported], mapper), 1);

  const adapter = new TodoistAdapter({ apiKey: 'token', dryRun: true });
  const queue = new SyncOperationQueue();
  queue.registerAdapter('todoist', adapter);
  const remote = { externalId: '123', payload: { id: '123', content: 'Review spec', description: '', priority: 1, labels: [], added_at: '2026-05-01T00:00:00Z', updated_at: '2026-05-01T00:00:00Z', completed_at: null } };
  mapper.recordBaseline(imported.key, 'todoist', todoistProjectionFromVaultTask(imported), remote.payload.updated_at);

  const plan = enqueueTodoistVaultOperations([imported], mapper, queue, adapter, true, [remote]);
  const preview = await queue.generateDryRunOutput();

  assert.equal(mapper.lookupByExternalId('todoist', '123'), imported.key);
  assert.equal(plan.updates, 0);
  assert.equal(plan.creates, 0);
  assert.equal(preview.totalOperations, 0);
});

test('todoist v2: dry-run queues create for new #todoist tasks', async () => {
  const mapper = new IdentityMapper();
  const adapter = new TodoistAdapter({ apiKey: 'token', dryRun: true });
  const queue = new SyncOperationQueue();
  queue.registerAdapter('todoist', adapter);

  const plan = enqueueTodoistVaultOperations([task()], mapper, queue, adapter, true);
  const preview = await queue.generateDryRunOutput();

  assert.equal(plan.creates, 1);
  assert.equal(preview.totalOperations, 1);
  assert.equal(preview.byType.create, 1);
  assert.match(preview.operations[0].preview, /CREATE/);
});

test('todoist v2: excludes tasks marked local-only from outbound operations', async () => {
  const mapper = new IdentityMapper();
  const adapter = new TodoistAdapter({ apiKey: 'token', dryRun: true });
  const queue = new SyncOperationQueue();
  queue.registerAdapter('todoist', adapter);

  const localOnly = task({
    metadata: { dates: {}, invalidDates: {}, priority: 'normal', dependsOn: [], excludeFromSync: true },
  });
  const plan = enqueueTodoistVaultOperations([localOnly], mapper, queue, adapter, true);
  const preview = await queue.generateDryRunOutput();

  assert.equal(plan.skipped, 1);
  assert.equal(plan.creates, 0);
  assert.equal(plan.updates, 0);
  assert.equal(preview.totalOperations, 0);
});

test('identity mapper: migrating a vault key updates external reverse lookup', () => {
  const mapper = new IdentityMapper();
  mapper.mapExternalId('Old.md:id:todoist:123', 'todoist', '123');
  mapper.migrateIdentity('Old.md:id:todoist:123', 'New.md:id:todoist:123');

  assert.equal(mapper.getExternalId('New.md:id:todoist:123', 'todoist'), '123');
  assert.equal(mapper.lookupByExternalId('todoist', '123'), 'New.md:id:todoist:123');
});


test('todoist reconciliation: pre-existing linked task with no baseline is retained as a conflict', async () => {
  const linked = task({
    key: 'Tasks.md:id:todoist:123',
    metadata: { dates: {}, invalidDates: {}, priority: 'normal', dependsOn: [], id: 'todoist:123' },
  });
  const mapper = new IdentityMapper();
  bootstrapTodoistIdentityMappings([linked], mapper);
  const adapter = new TodoistAdapter({ apiKey: 'token', dryRun: true });
  const queue = new SyncOperationQueue();
  queue.registerAdapter('todoist', adapter);

  const remote = { externalId: '123', payload: { id: '123', content: 'Remote title', description: '', priority: 1, labels: [], added_at: '2026-05-01T00:00:00Z', updated_at: '2026-05-01T00:00:00Z', completed_at: null } };
  const plan = enqueueTodoistVaultOperations([linked], mapper, queue, adapter, true, [remote]);
  const retained = queue.getState().operations;

  assert.equal(plan.updates, 0);
  assert.equal(plan.conflicts, 1);
  assert.equal(retained[0]?.status, 'conflict');
  assert.deepEqual(retained[0]?.payload, {});
});

test('todoist v2: import planning defers identity mapping until after vault write', () => {
  const adapter = new TodoistAdapter({ apiKey: 'token', dryRun: true });
  const mapper = new IdentityMapper();
  const remote = {
    externalId: '123',
    payload: {
      id: '123',
      content: 'Review spec',
      priority: 1,
      labels: ['work'],
      due: { date: '2026-06-01' },
      added_at: '2026-05-01T00:00:00Z',
      updated_at: '2026-05-01T00:00:00Z',
      completed_at: null,
    },
  };

  const plan = planTodoistImports([remote], mapper, adapter, 'Todoist Inbox.md');

  assert.equal(plan.lines.length, 1);
  assert.match(plan.lines[0], /Review spec/u);
  assert.equal(mapper.lookupByExternalId('todoist', '123'), undefined, 'failed vault writes must not leave a persisted imported mapping');

  applyTodoistImportMappings(mapper, plan.mappings);
  assert.equal(mapper.lookupByExternalId('todoist', '123'), todoistVaultKeyForExternalId('Todoist Inbox.md', '123'));
});

test('todoist v2: imported canonical hash matches scanner-equivalent vault task on next sync', async () => {
  const adapter = new TodoistAdapter({ apiKey: 'token', dryRun: true });
  const remotePayload = {
    id: '123',
    content: 'Review spec',
    priority: 1,
    labels: ['work'],
    due: { date: '2026-06-01' },
    added_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
    completed_at: null,
  };
  const imported = adapter.fromServicePayload(remotePayload, 'Todoist Inbox.md');
  const vaultKey = todoistVaultKeyForExternalId('Todoist Inbox.md', '123');
  const scannerTask = parseMarkdownTaskLine(imported.rawLine.split('\n')[0], 'Todoist Inbox.md', 1);
  assert.ok(scannerTask);
  const scannedWithVaultKey = { ...scannerTask, key: vaultKey };
  const mapper = new IdentityMapper();
  mapper.mapExternalId(vaultKey, 'todoist', '123');
  mapper.recordBaseline(vaultKey, 'todoist', todoistProjectionFromVaultTask(scannedWithVaultKey), remotePayload.updated_at);
  const queue = new SyncOperationQueue();
  queue.registerAdapter('todoist', adapter);

  const plan = enqueueTodoistVaultOperations([scannedWithVaultKey], mapper, queue, adapter, true, [{ externalId: '123', payload: remotePayload }]);
  const preview = await queue.generateDryRunOutput();

  assert.deepEqual(adapter.toServicePayload(imported), adapter.toServicePayload(scannedWithVaultKey));
  assert.equal(plan.updates, 0);
  assert.equal(preview.totalOperations, 0);
});

test('todoist v2: imported prioritised task does not trigger a spurious update on re-scan', async () => {
  const adapter = new TodoistAdapter({ apiKey: 'token', dryRun: true });
  const remotePayload = {
    id: '456',
    content: 'Ship release',
    priority: 4,
    labels: [],
    due: { date: '2026-06-01' },
    added_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
    completed_at: null,
  };
  const imported = adapter.fromServicePayload(remotePayload, 'Todoist Inbox.md');

  // The imported metadata priority must match the emoji rendered into the line so the
  // baseline hash equals the hash computed after the line is scanned back from the vault.
  assert.equal(imported.metadata.priority, 'highest');
  assert.match(imported.rawLine, /🔺/u);

  const vaultKey = todoistVaultKeyForExternalId('Todoist Inbox.md', '456');
  const scannerTask = parseMarkdownTaskLine(imported.rawLine.split('\n')[0], 'Todoist Inbox.md', 1);
  assert.ok(scannerTask);
  const scannedWithVaultKey = { ...scannerTask, key: vaultKey };

  assert.deepEqual(adapter.toServicePayload(imported), adapter.toServicePayload(scannedWithVaultKey));

  const mapper = new IdentityMapper();
  mapper.mapExternalId(vaultKey, 'todoist', '456');
  mapper.recordBaseline(vaultKey, 'todoist', todoistProjectionFromVaultTask(imported), remotePayload.updated_at);
  const queue = new SyncOperationQueue();
  queue.registerAdapter('todoist', adapter);

  const plan = enqueueTodoistVaultOperations([scannedWithVaultKey], mapper, queue, adapter, true, [{ externalId: '456', payload: remotePayload }]);
  const preview = await queue.generateDryRunOutput();

  assert.equal(plan.updates, 0);
  assert.equal(preview.totalOperations, 0);
});

test('todoist v2: toServicePayload preserves vault due times', () => {
  const adapter = new TodoistAdapter({ apiKey: 'token', dryRun: true });
  const payload = adapter.toServicePayload(task({
    rawLine: '- [ ] Review spec #todoist 📅 2026-06-01 09:30',
    metadata: { dates: { due: '2026-06-01', dueTime: '09:30' }, invalidDates: {}, priority: 'normal', dependsOn: [] },
  }));

  assert.equal(payload.due_string, '2026-06-01 09:30');
});

test('todoist v2: imports Todoist due datetime as due date and time', () => {
  const adapter = new TodoistAdapter({ apiKey: 'token', dryRun: true });
  const imported = adapter.fromServicePayload({
    id: '123',
    content: 'Review spec',
    priority: 1,
    labels: [],
    due: { date: '2026-06-01', datetime: '2026-06-01T09:30:00Z', timezone: 'UTC' },
    added_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
    completed_at: null,
  }, 'Todoist Inbox.md');
  const scannerTask = parseMarkdownTaskLine(imported.rawLine.split('\n')[0], 'Todoist Inbox.md', 1);

  assert.equal(imported.metadata.dates.due, '2026-06-01');
  assert.equal(imported.metadata.dates.dueTime, '09:30');
  assert.match(imported.rawLine, /📅 2026-06-01 09:30/u);
  assert.ok(scannerTask);
  assert.deepEqual(adapter.toServicePayload(imported), adapter.toServicePayload(scannerTask));
  assert.equal(adapter.toServicePayload(imported).due_string, '2026-06-01 09:30 UTC');
});

test('todoist v2: ignores malformed due objects without a date field', () => {
  const adapter = new TodoistAdapter({ apiKey: 'token', dryRun: true });

  assert.doesNotThrow(() => adapter.fromServicePayload({
    id: '124',
    content: 'Review spec',
    priority: 1,
    labels: [],
    due: { datetime: '2026-06-01T09:30:00Z' },
    added_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
    completed_at: null,
  }, 'Todoist Inbox.md'));

  const imported = adapter.fromServicePayload({
    id: '125',
    content: 'Review spec',
    priority: 1,
    labels: [],
    due: {},
    added_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
    completed_at: null,
  }, 'Todoist Inbox.md');

  assert.equal(imported.metadata.dates.due, undefined);
  assert.equal(imported.metadata.dates.dueTime, undefined);
});

test('todoist v2: ignores invalid due dates and times from imports', () => {
  const adapter = new TodoistAdapter({ apiKey: 'token', dryRun: true });

  const badDate = adapter.fromServicePayload({
    id: 'bad-date',
    content: 'Bad date',
    priority: 1,
    labels: [],
    due: { date: '2026-02-31' },
    added_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
    completed_at: null,
  }, 'Todoist Inbox.md');
  assert.equal(badDate.metadata.dates.due, undefined);
  assert.doesNotMatch(badDate.rawLine, /📅/u);

  const badTime = adapter.fromServicePayload({
    id: 'bad-time',
    content: 'Bad time',
    priority: 1,
    labels: [],
    due: { date: '2026-06-01', datetime: '2026-06-01T25:99:00Z' },
    added_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
    completed_at: null,
  }, 'Todoist Inbox.md');
  assert.equal(badTime.metadata.dates.due, '2026-06-01');
  assert.equal(badTime.metadata.dates.dueTime, undefined);
  assert.match(badTime.rawLine, /📅 2026-06-01 \[id::/u);
});

test('todoist v2: imports descriptions as comment metadata for round-trip sync', () => {
  const adapter = new TodoistAdapter({ apiKey: 'token', dryRun: true });
  const imported = adapter.fromServicePayload({
    id: '123',
    content: 'Review spec',
    description: 'First note\n\nSecond note',
    priority: 1,
    labels: [],
    added_at: '2026-05-01T00:00:00Z',
    updated_at: '2026-05-01T00:00:00Z',
    completed_at: null,
  }, 'Todoist Inbox.md');

  assert.deepEqual(imported.metadata.comments, ['First note', 'Second note']);
  assert.match(imported.rawLine, /\n  - 💬 First note\n  - 💬 Second note$/u);
  assert.equal(adapter.toServicePayload(imported).description, 'First note\nSecond note');
});

test('todoist adapter: update uses close and reopen endpoints for completion state', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200, json: async () => ({ id: '123', content: 'Task', priority: 1, added_at: '', updated_at: '' }) } as Response;
  }) as typeof fetch;
  try {
    const adapter = new TodoistAdapter({ apiKey: 'token' });
    await adapter.update('123', { is_completed: true });
    await adapter.update('123', { is_completed: false });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(calls.map((c) => c.url), [
    'https://api.todoist.com/api/v1/tasks/123/close',
    'https://api.todoist.com/api/v1/tasks/123/reopen',
  ]);
});

test('todoist adapter: sanitizes imported content and labels consistently', () => {
  const adapter = new TodoistAdapter({ apiKey: 'token' });
  const task = adapter.fromServicePayload({
    id: 'remote-1',
    content: 'Line one\nLine two',
    priority: 1,
    labels: ['work item', '#urgent\nnow'],
    completed_at: null,
    added_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  }, 'Inbox.md');

  assert.equal(task.rawLine.split('\n')[0], '- [ ] Line one Line two #work-item #urgent-now [id:: todoist:remote-1]');
  assert.equal(task.body, 'Line one Line two');
  assert.deepEqual(task.tags, ['work-item', 'urgent-now']);
});

test('todoist adapter: encodes external IDs in task endpoint paths', async () => {
  const originalFetch = globalThis.fetch;
  const urls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    urls.push(String(url));
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }) as typeof fetch;
  try {
    const adapter = new TodoistAdapter({ apiKey: 'token' });
    await adapter.update('123/close', { content: 'Task' });
    await adapter.delete('123?foo=bar');
    await adapter.close('123/close');
    await adapter.reopen('123#fragment');
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(urls, [
    'https://api.todoist.com/api/v1/tasks/123%2Fclose',
    'https://api.todoist.com/api/v1/tasks/123%3Ffoo%3Dbar',
    'https://api.todoist.com/api/v1/tasks/123%2Fclose/close',
    'https://api.todoist.com/api/v1/tasks/123%23fragment/reopen',
  ]);
});

test('todoist reconciliation: active-list absence never authorizes a blind reopen', async () => {
  const reopened = task({
    key: 'Tasks.md:id:todoist:123',
    rawLine: '- [ ] Review spec [id:: todoist:123]',
    checkbox: ' ',
    status: 'todo',
    metadata: { dates: {}, invalidDates: {}, priority: 'normal', dependsOn: [], id: 'todoist:123' },
    tags: [],
  });
  const mapper = new IdentityMapper();
  mapper.mapExternalId(reopened.key, 'todoist', '123');
  mapper.recordBaseline(reopened.key, 'todoist', { title: 'Review spec', description: '', due: '', priority: 1, status: 'completed', tags: [] });
  const adapter = new TodoistAdapter({ apiKey: 'token', dryRun: true });
  const queue = new SyncOperationQueue();
  queue.registerAdapter('todoist', adapter);

  const plan = enqueueTodoistVaultOperations([reopened], mapper, queue, adapter, true);
  const preview = await queue.generateDryRunOutput();

  assert.equal(plan.updates, 0);
  assert.equal(plan.conflicts, 1);
  assert.equal(preview.totalOperations, 0);
  assert.equal(queue.getState().operations[0]?.status, 'conflict');
});

test('todoist: toServicePayload for cancelled task omits is_completed to prevent erroneous reopen', () => {
  const adapter = new TodoistAdapter({ apiKey: 'token', dryRun: true });
  const done = adapter.toServicePayload(task({ status: 'done', checkbox: 'x' }));
  assert.equal(done.is_completed, true, 'done task must set is_completed=true');

  const open = adapter.toServicePayload(task({ status: 'todo', checkbox: ' ' }));
  assert.equal(open.is_completed, false, 'open task must set is_completed=false so reopen path fires');

  const cancelled = adapter.toServicePayload(task({ status: 'cancelled', checkbox: '-' }));
  assert.equal('is_completed' in cancelled, false, 'cancelled task must NOT include is_completed (would incorrectly reopen Todoist item)');
});

test('todoist adapter: cancelled task with externalId enqueues update without triggering reopen', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }) as typeof fetch;
  try {
    const adapter = new TodoistAdapter({ apiKey: 'token' });
    const cancelledPayload = adapter.toServicePayload(
      task({ status: 'cancelled', checkbox: '-', metadata: { dates: {}, invalidDates: {}, priority: 'normal', dependsOn: [], id: 'todoist:123' } }),
    );
    // Directly drive the update path as the queue executor would
    await adapter.update('123', cancelledPayload);
  } finally {
    globalThis.fetch = originalFetch;
  }
  // /reopen must NOT have been called; only a PATCH to /tasks/123 (if any fields changed)
  const reopenCalls = calls.filter((c) => c.url.includes('/reopen'));
  assert.equal(reopenCalls.length, 0, 'cancelled task update must not call /reopen on Todoist');
  const closeCalls = calls.filter((c) => c.url.includes('/close'));
  assert.equal(closeCalls.length, 0, 'cancelled task update must not call /close on Todoist');
});

test('sync queue: quarantines stale Todoist failures and removes only successful operations', () => {
  const queue = new SyncOperationQueue();
  const t = task();
  const success = queue.enqueueCreate(t, 'todoist', { content: 'ok' });
  success.status = 'success';
  const failed = queue.enqueueUpdate(t, 'todoist', '123', { content: 'retry' });
  failed.status = 'failed';
  failed.error = 'network';

  assert.equal(queue.requeueFailed('todoist'), 0);
  assert.equal(queue.quarantineUnsafeProviderOperations('todoist'), 1);
  assert.equal(failed.status, 'conflict');
  assert.deepEqual(failed.payload, {});
  queue.removeOperations([success.id]);

  const state = queue.getState();
  assert.deepEqual(state.operations.map((op) => op.id), [failed.id]);
  assert.equal(state.completed.length, 1);
});

test('todoist v2: toServicePayload includes description="" when task has no comments (clearing behavior)', () => {
  const adapter = new TodoistAdapter({ apiKey: 'token', dryRun: true });

  // Task with no comments — description should be explicitly "" so update() clears it in Todoist
  const noComments = task();
  const payload = adapter.toServicePayload(noComments);
  assert.ok('description' in payload, 'description key must always be present in payload');
  assert.equal(payload.description, '', 'description must be "" when task has no comments');

  // Task with a comment — description should carry the comment text
  const withComment: MarkdownTask = {
    ...noComments,
    metadata: { ...noComments.metadata, comments: ['A note'] },
  };
  const payloadWithNote = adapter.toServicePayload(withComment);
  assert.equal(payloadWithNote.description, 'A note');
});

test('todoist v2: toServicePayload includes empty labels array to clear removed tags', () => {
  const adapter = new TodoistAdapter({ apiKey: 'token', dryRun: true });
  const payload = adapter.toServicePayload(task({ tags: ['todoist'] }));

  assert.ok('labels' in payload, 'labels key must be present so updates can clear stale Todoist labels');
  assert.deepEqual(payload.labels, []);
});

test('todoist v2: toServicePayload includes empty due string to clear removed due dates', () => {
  const adapter = new TodoistAdapter({ apiKey: 'token', dryRun: true });
  const payload = adapter.toServicePayload(task({ metadata: { dates: {}, invalidDates: {}, priority: 'normal', dependsOn: [] } }));

  assert.ok('due_string' in payload, 'due_string key must be present so updates can clear stale Todoist due dates');
  assert.equal(payload.due_string, '');
});

test('todoist v2: toServicePayload includes normal priority to clear stale remote priority', () => {
  const adapter = new TodoistAdapter({ apiKey: 'token', dryRun: true });
  const payload = adapter.toServicePayload(task({ body: 'Review spec', metadata: { dates: {}, invalidDates: {}, priority: 'normal', dependsOn: [] } }));

  assert.equal(payload.priority, 1);
});

test('todoist v2: toServicePayload maps parsed metadata priority', () => {
  const adapter = new TodoistAdapter({ apiKey: 'token', dryRun: true });
  const payload = adapter.toServicePayload(task({ body: 'Review spec', metadata: { dates: {}, invalidDates: {}, priority: 'high', dependsOn: [] } }));

  assert.equal(payload.priority, 3);
});

test('todoist adapter: update sends blank content as Untitled and normal priority', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body as string) : undefined });
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }) as typeof fetch;

  try {
    const adapter = new TodoistAdapter({ apiKey: 'token' });
    await adapter.update('123', { content: '', priority: 1 });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const patchCall = calls.find((c) => c.url === 'https://api.todoist.com/api/v1/tasks/123');
  assert.ok(patchCall);
  assert.equal((patchCall.body as Record<string, unknown>).content, 'Untitled');
  assert.equal((patchCall.body as Record<string, unknown>).priority, 1);
});

test('todoist adapter: update sends labels=[] to clear Todoist task labels', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body as string) : undefined });
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }) as typeof fetch;

  try {
    const adapter = new TodoistAdapter({ apiKey: 'token' });
    await adapter.update('123', { content: 'My task', labels: [] });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const patchCall = calls.find((c) => c.url === 'https://api.todoist.com/api/v1/tasks/123');
  assert.ok(patchCall, 'POST to /tasks/123 must be made when labels are cleared');
  assert.deepEqual((patchCall.body as Record<string, unknown>).labels, []);
});

test('todoist adapter: update sends due_string="" to clear Todoist task due date', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body as string) : undefined });
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }) as typeof fetch;

  try {
    const adapter = new TodoistAdapter({ apiKey: 'token' });
    await adapter.update('123', { content: 'My task', due_string: '' });
  } finally {
    globalThis.fetch = originalFetch;
  }

  const patchCall = calls.find((c) => c.url === 'https://api.todoist.com/api/v1/tasks/123');
  assert.ok(patchCall, 'POST to /tasks/123 must be made when due date is cleared');
  assert.equal((patchCall.body as Record<string, unknown>).due_string, '');
});

test('todoist adapter: update sends description="" to clear Todoist task description', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ url: string; body: unknown }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), body: init?.body ? JSON.parse(init.body as string) : undefined });
    return { ok: true, status: 200, json: async () => ({}) } as Response;
  }) as typeof fetch;

  try {
    const adapter = new TodoistAdapter({ apiKey: 'token' });
    // Payload produced when all inline comments are removed
    await adapter.update('123', { content: 'My task', description: '' });
  } finally {
    globalThis.fetch = originalFetch;
  }

  // A POST to /tasks/123 must have been made (description: "" must trigger an update)
  const patchCall = calls.find((c) => c.url === 'https://api.todoist.com/api/v1/tasks/123');
  assert.ok(patchCall, 'POST to /tasks/123 must be made when description is cleared');
  assert.equal((patchCall.body as Record<string, unknown>).description, '', 'POST body must include description: ""');
});
