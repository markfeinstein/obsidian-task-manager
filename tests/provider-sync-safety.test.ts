import test from 'node:test';
import assert from 'node:assert/strict';
import { type App, TFile } from 'obsidian';
import TaskManagerPlugin from '../src/main';
import { appendMissingProviderImports, commitProviderImports, ProviderSyncCoordinator, type ImportProvider, type ProviderImportCandidate } from '../src/provider-sync-safety';
import { IdentityMapper } from '../src/sync-identity-mapper';
import { TaskIndex } from '../src/task-index';
import { normalizeTaskManagerSettings, type TaskManagerSettings } from '../src/types';

function deferred<T = void>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function fileForPath(path: string): TFile {
  return Object.assign(Object.create(TFile.prototype) as TFile, { path, name: path.split('/').pop() ?? path, extension: 'md', basename: path.replace(/\.md$/u, '') });
}

test('provider sync coordinator joins same keys, permits different keys, and releases success/failure', async () => {
  const coordinator = new ProviderSyncCoordinator();
  const todoistGate = deferred();
  const googleGate = deferred();
  let todoistStarts = 0;
  let googleStarts = 0;
  const first = coordinator.run('todoist', async () => { todoistStarts += 1; await todoistGate.promise; });
  const joined = coordinator.run('todoist', async () => { todoistStarts += 1; });
  const google = coordinator.run('google-tasks', async () => { googleStarts += 1; await googleGate.promise; });
  assert.strictEqual(joined, first);
  await Promise.resolve();
  assert.equal(todoistStarts, 1);
  assert.equal(googleStarts, 1, 'different providers must start concurrently');
  todoistGate.resolve();
  googleGate.resolve();
  await Promise.all([first, joined, google]);

  await coordinator.run('todoist', async () => { todoistStarts += 1; });
  assert.equal(todoistStarts, 2, 'success must release the provider key');
  await assert.rejects(coordinator.run('caldav', async () => { throw new Error('expected'); }), /expected/u);
  await coordinator.run('caldav', async () => undefined);
});

test('provider import append is duplicate-safe and preserves bytes/newline style', () => {
  const candidates = <T>(...values: Array<[string, string, T]>): ProviderImportCandidate<T>[] => values.map(([externalId, markdown, value]) => ({ externalId, markdown, value }));
  const current = 'Heading\r\n- [ ] Existing [id:: todoist:one]\r\n';
  const result = appendMissingProviderImports(current, 'todoist', candidates(
    ['one', '- [ ] Duplicate [id:: todoist:one]', 1],
    ['two', '- [ ] New\n  - 💬 Note [id:: todoist:two]', 2],
    ['two', '- [ ] Candidate duplicate [id:: todoist:two]', 3],
  ));
  assert.deepEqual(result.committed.map((candidate) => candidate.value), [2]);
  assert.equal(result.content.slice(0, current.length), current);
  assert.match(result.content, /New\r\n  - 💬 Note/u);
  assert.doesNotMatch(result.content, /Candidate duplicate/u);

  const aliases: Array<[ImportProvider, string]> = [
    ['todoist', '- [ ] Existing [id:: todoist-old]'],
    ['google-tasks', '- [ ] Existing [id:: gtasks-old]'],
    ['microsoft-todo', '- [ ] Existing [id:: microsoft-todo:old]'],
  ];
  for (const [provider, content] of aliases) {
    const noOp = appendMissingProviderImports(content, provider, [{ externalId: 'old', markdown: '- [ ] Duplicate', value: provider }]);
    assert.equal(noOp.content, content, `${provider} no-op must preserve byte identity`);
    assert.deepEqual(noOp.committed, []);
  }
});

test('provider import create-race fallback rechecks current content', async () => {
  const path = 'Inbox.md';
  const file = fileForPath(path);
  let racedFile: TFile | null = null;
  let content = '';
  let processCalls = 0;
  const app = { vault: {
    getAbstractFileByPath: () => racedFile,
    create: async () => {
      racedFile = file;
      content = '- [ ] Concurrent [id:: google-tasks:g1]\n';
      throw new Error('already exists');
    },
    process: async (_file: TFile, transform: (current: string) => string) => { processCalls += 1; content = transform(content); return content; },
  } } as unknown as App;
  const committed = await commitProviderImports(app, path, 'google-tasks', [{ externalId: 'g1', markdown: '- [ ] Imported [id:: google-tasks:g1]', value: 'g1' }]);
  assert.deepEqual(committed, []);
  assert.equal(processCalls, 1);
  assert.equal(content, '- [ ] Concurrent [id:: google-tasks:g1]\n');
});

interface TodoistPluginHarness {
  settings: TaskManagerSettings;
  app: App;
  taskIndex: TaskIndex;
  stateStore: { loadState(): Promise<{ identityState: { identities: never[]; version: 2 }; syncQueueState: { operations: never[]; completed: never[]; version: 2 } }> };
  identityMapper?: IdentityMapper;
  syncTodoist(): Promise<void>;
  persistState(): Promise<void>;
  saveSettings(): Promise<void>;
  markSyncStateDirty(): void;
}

function todoistHarness(initialContent = ''): { plugin: TodoistPluginHarness; content(): string; processCalls(): number } {
  const path = 'Todoist Inbox.md';
  const file = fileForPath(path);
  let content = initialContent;
  let processCalls = 0;
  const plugin = Object.create(TaskManagerPlugin.prototype) as TodoistPluginHarness;
  plugin.settings = normalizeTaskManagerSettings({ todoistSyncEnabled: true, todoistApiKey: 'token', todoistInboxPath: path });
  plugin.taskIndex = new TaskIndex();
  plugin.taskIndex.commit(new Map());
  plugin.taskIndex.markReady();
  plugin.app = { vault: {
    getAbstractFileByPath: (candidate: string) => candidate === path ? file : null,
    process: async (_file: TFile, transform: (current: string) => string) => { processCalls += 1; content = transform(content); return content; },
  } } as unknown as App;
  plugin.stateStore = { loadState: async () => ({ identityState: { identities: [], version: 2 }, syncQueueState: { operations: [], completed: [], version: 2 } }) };
  plugin.persistState = async () => undefined;
  plugin.saveSettings = async () => undefined;
  plugin.markSyncStateDirty = () => undefined;
  return { plugin, content: () => content, processCalls: () => processCalls };
}

const remoteTodoistTask = { id: 'remote1', content: 'Remote', description: '', priority: 1, labels: [], added_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', completed_at: null };

test('real Todoist command joins concurrent calls and commits one import/run', async () => {
  const originalFetch = globalThis.fetch;
  const entered = deferred();
  const release = deferred();
  let fetches = 0;
  globalThis.fetch = (async () => {
    fetches += 1;
    entered.resolve();
    await release.promise;
    return Response.json({ results: [remoteTodoistTask], next_cursor: null });
  }) as typeof fetch;
  const harness = todoistHarness();
  try {
    const first = harness.plugin.syncTodoist();
    const joined = harness.plugin.syncTodoist();
    assert.strictEqual(joined, first);
    await entered.promise;
    assert.equal(fetches, 1);
    release.resolve();
    await Promise.all([first, joined]);
    assert.equal(harness.processCalls(), 1);
    assert.equal(harness.content().match(/\[id:: todoist:remote1\]/gu)?.length, 1);
    assert.equal(harness.plugin.settings.syncRunHistory.length, 1);
  } finally {
    release.resolve();
    globalThis.fetch = originalFetch;
  }
});

test('Todoist stale-plan fence commits no duplicate and advances no speculative mapping', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => Response.json({ results: [remoteTodoistTask], next_cursor: null })) as typeof fetch;
  const harness = todoistHarness('- [ ] Concurrent [id:: todoist:remote1]\n');
  try {
    await harness.plugin.syncTodoist();
    assert.equal(harness.content().match(/\[id:: todoist:remote1\]/gu)?.length, 1);
    assert.equal(harness.plugin.settings.syncRunHistory[0]?.imported, 0);
    assert.equal(harness.plugin.identityMapper?.lookupByExternalId('todoist', 'remote1'), undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('all five provider command wrappers behaviorally join exact promises without recursion', async (t) => {
  const contracts = [
    ['syncTodoist', 'performTodoistSync'],
    ['syncGoogleTasks', 'performGoogleTasksSync'],
    ['syncGoogleCalendar', 'performGoogleCalendarSync'],
    ['syncMsToDo', 'performMsToDoSync'],
    ['syncCalDAV', 'performCalDAVSync'],
  ] as const;
  for (const [wrapperName, implementationName] of contracts) {
    await t.test(wrapperName, async () => {
      const gate = deferred();
      let starts = 0;
      const plugin = Object.create(TaskManagerPlugin.prototype) as unknown as Record<string, unknown>;
      plugin[implementationName] = async () => { starts += 1; await gate.promise; };
      const wrapper = plugin[wrapperName] as (this: Record<string, unknown>) => Promise<void>;
      const first = wrapper.call(plugin);
      const joined = wrapper.call(plugin);
      assert.strictEqual(joined, first);
      await Promise.resolve();
      assert.equal(starts, 1);
      gate.resolve();
      await Promise.all([first, joined]);
    });
  }
});
