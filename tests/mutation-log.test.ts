/**
 * Mutation Log Tests
 * Tests for mutation log core logic (file I/O operations require integration testing)
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { TFile } from 'obsidian';
import { MutationLog, type MutationEntry, type MutationSource, type MutationAction } from '../src/mutation-log';

// ── Type Validation ──────────────────────────────────────

test('mutation-log: MutationEntry interface is properly defined', () => {
  const entry: MutationEntry = {
    operationId: 'op-123456789',
    timestamp: new Date().toISOString(),
    source: 'ui' as MutationSource,
    action: 'create' as MutationAction,
    taskKey: 'test.md:1',
    before: null,
    after: { content: 'Test task' },
  };
  
  assert.ok(entry.operationId);
  assert.ok(entry.timestamp);
  assert.equal(entry.source, 'ui');
  assert.equal(entry.action, 'create');
});

test('mutation-log: unsafe configured path fails closed before vault access', async () => {
  let vaultCalls = 0;
  const log = new MutationLog({
    vault: {
      getAbstractFileByPath: () => { vaultCalls += 1; return null; },
      create: async () => { vaultCalls += 1; },
      createFolder: async () => { vaultCalls += 1; },
    },
  } as never, () => ({ mutationLogEnabled: true, mutationLogFile: '../outside.jsonl' }) as never);
  const originalError = console.error;
  console.error = () => undefined;
  try {
    await log.initialize();
  } finally {
    console.error = originalError;
  }
  assert.equal(vaultCalls, 0);
});

test('mutation-log: MutationEntry supports all source types', () => {
  const sources: MutationSource[] = ['ui', 'mcp', 'cli', 'workflow', 'sync'];
  
  for (const source of sources) {
    const entry: MutationEntry = {
      operationId: `op-${source}`,
      timestamp: new Date().toISOString(),
      source,
      action: 'create',
      taskKey: 'test.md:1',
      before: null,
      after: { content: 'Test' },
    };
    
    assert.equal(entry.source, source);
  }
});

test('mutation-log: MutationEntry supports all action types', () => {
  const actions: MutationAction[] = ['create', 'update', 'complete', 'delete', 'restore', 'tag', 'untag', 'reschedule', 'reprioritize', 'other'];
  
  for (const action of actions) {
    const entry: MutationEntry = {
      operationId: `op-${action}`,
      timestamp: new Date().toISOString(),
      source: 'ui',
      action,
      taskKey: 'test.md:1',
      before: null,
      after: { content: 'Test' },
    };
    
    assert.equal(entry.action, action);
  }
});

test('mutation-log: MutationEntry with optional idempotency key', () => {
  const entry: MutationEntry = {
    operationId: 'op-123',
    timestamp: new Date().toISOString(),
    source: 'mcp',
    action: 'update',
    taskKey: 'test.md:1',
    before: { status: 'todo' },
    after: { status: 'done' },
    idempotencyKey: 'unique-key-123',
  };
  
  assert.equal(entry.idempotencyKey, 'unique-key-123');
});

test('mutation-log: MutationEntry with optional fields', () => {
  const entry: MutationEntry = {
    operationId: 'op-123',
    timestamp: new Date().toISOString(),
    source: 'cli',
    action: 'create',
    taskKey: 'test.md:1',
    before: null,
    after: { content: 'Task' },
    initiator: 'user@example.com',
    description: 'Created via CLI',
    error: undefined,
  };
  
  assert.equal(entry.initiator, 'user@example.com');
  assert.equal(entry.description, 'Created via CLI');
});

// ── Timestamp Validation ─────────────────────────────────

test('mutation-log: MutationEntry timestamp is ISO 8601', () => {
  const now = new Date();
  const iso = now.toISOString();
  
  const entry: MutationEntry = {
    operationId: 'op-123',
    timestamp: iso,
    source: 'ui',
    action: 'create',
    taskKey: 'test.md:1',
    before: null,
    after: { content: 'Test' },
  };
  
  // Verify ISO 8601 format
  assert.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(entry.timestamp));
});

// ── Task Key Format ─────────────────────────────────────

test('mutation-log: Task key format is filePath:lineNumber', () => {
  const testCases = [
    'test.md:1',
    'folder/file.md:42',
    'deeply/nested/file.md:100',
  ];
  
  for (const taskKey of testCases) {
    const entry: MutationEntry = {
      operationId: 'op-123',
      timestamp: new Date().toISOString(),
      source: 'ui',
      action: 'create',
      taskKey,
      before: null,
      after: { content: 'Test' },
    };
    
    assert.ok(entry.taskKey.includes(':'));
    const [filePath, lineNum] = entry.taskKey.split(':');
    assert.ok(filePath.endsWith('.md'));
    assert.ok(!isNaN(parseInt(lineNum)));
  }
});

// ── Before/After Snapshots ───────────────────────────────

test('mutation-log: Create action has null before snapshot', () => {
  const entry: MutationEntry = {
    operationId: 'op-123',
    timestamp: new Date().toISOString(),
    source: 'ui',
    action: 'create',
    taskKey: 'test.md:1',
    before: null,
    after: { content: 'New task', status: 'todo' },
  };
  
  assert.equal(entry.before, null);
  assert.ok(entry.after);
  assert.equal(entry.after.content, 'New task');
});

test('mutation-log: Update action has before and after snapshots', () => {
  const entry: MutationEntry = {
    operationId: 'op-123',
    timestamp: new Date().toISOString(),
    source: 'ui',
    action: 'update',
    taskKey: 'test.md:1',
    before: { status: 'todo', priority: 'high' },
    after: { status: 'in_progress', priority: 'high' },
  };
  
  assert.ok(entry.before);
  assert.ok(entry.after);
  assert.equal(entry.before.status, 'todo');
  assert.equal(entry.after.status, 'in_progress');
});

// ── Error Handling ──────────────────────────────────────

test('mutation-log: Error field captures failed mutations', () => {
  const entry: MutationEntry = {
    operationId: 'op-123',
    timestamp: new Date().toISOString(),
    source: 'mcp',
    action: 'create',
    taskKey: 'test.md:1',
    before: null,
    after: { content: 'Task' },
    error: 'File not found',
  };
  
  assert.equal(entry.error, 'File not found');
});

test('mutation-log: rotation appends valid JSONL to an empty existing backup', async () => {
  class TestFile extends TFile {
    vault = {} as never;
    parent = null;
    stat = { ctime: 0, mtime: 0, size: 0 };
    basename: string;
    extension: string;

    constructor(readonly path: string) {
      super();
      this.name = path.split('/').pop() ?? path;
      this.basename = this.name.replace(/\.[^.]*$/u, '');
      this.extension = this.name.includes('.') ? this.name.split('.').pop() ?? '' : '';
    }
  }

  const files = new Map<string, string>();
  const vault = {
    getAbstractFileByPath(path: string): TFile | null {
      return files.has(path) ? new TestFile(path) : null;
    },
    async create(path: string, content: string): Promise<TFile> {
      files.set(path, content);
      return new TestFile(path);
    },
    async read(file: TFile): Promise<string> {
      return files.get(file.path) ?? '';
    },
    async process(file: TFile, updater: (content: string) => string): Promise<void> {
      files.set(file.path, updater(files.get(file.path) ?? ''));
    },
  };
  const log = new MutationLog({ vault } as never, () => ({
    mutationLogEnabled: true,
    mutationLogFile: '.mutation-log.jsonl',
    mutationLogMaxEntries: 1,
  }) as never);

  await log.initialize();
  const now = new Date();
  const backupDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const backupPath = `.mutation-log.${backupDate}.jsonl`;
  files.set(backupPath, '');

  await log.logMutation({ source: 'ui', action: 'create', taskKey: 'Tasks.md:1', before: null, after: { content: 'First' } });
  await log.logMutation({ source: 'ui', action: 'update', taskKey: 'Tasks.md:1', before: { content: 'First' }, after: { content: 'Second' } });

  const backupContent = files.get(backupPath) ?? '';
  assert.ok(!backupContent.startsWith('\n'), 'backup JSONL must not start with a blank line');
  const backupLines = backupContent.split('\n');
  assert.equal(backupLines.length, 1);
  assert.equal(JSON.parse(backupLines[0]).action, 'create');
});

test('mutation-log: creates configured parent folders and rotates backups beside the log file', async () => {
  class TestFile extends TFile {
    vault = {} as never;
    parent = null;
    stat = { ctime: 0, mtime: 0, size: 0 };
    basename: string;
    extension: string;

    constructor(readonly path: string) {
      super();
      this.name = path.split('/').pop() ?? path;
      this.basename = this.name.replace(/\.[^.]*$/u, '');
      this.extension = this.name.includes('.') ? this.name.split('.').pop() ?? '' : '';
    }
  }

  const files = new Map<string, string>();
  const folders = new Set<string>();
  const createdFolders: string[] = [];
  const vault = {
    getAbstractFileByPath(path: string): TFile | { path: string } | null {
      if (files.has(path)) return new TestFile(path);
      if (folders.has(path)) return { path };
      return null;
    },
    async createFolder(path: string): Promise<void> {
      folders.add(path);
      createdFolders.push(path);
    },
    async create(path: string, content: string): Promise<TFile> {
      files.set(path, content);
      return new TestFile(path);
    },
    async read(file: TFile): Promise<string> {
      return files.get(file.path) ?? '';
    },
    async process(file: TFile, updater: (content: string) => string): Promise<void> {
      files.set(file.path, updater(files.get(file.path) ?? ''));
    },
  };
  const log = new MutationLog({ vault } as never, () => ({
    mutationLogEnabled: true,
    mutationLogFile: 'Logs/mutation-log.jsonl',
    mutationLogMaxEntries: 1,
  }) as never);

  await log.initialize();
  const now = new Date();
  const backupDate = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  await log.logMutation({ source: 'ui', action: 'create', taskKey: 'Tasks.md:1', before: null, after: { content: 'First' } });
  await log.logMutation({ source: 'ui', action: 'update', taskKey: 'Tasks.md:1', before: { content: 'First' }, after: { content: 'Second' } });

  assert.deepEqual(createdFolders, ['Logs']);
  assert.equal(files.has('Logs/mutation-log.jsonl'), true);
  assert.equal(files.has(`Logs/mutation-log.${backupDate}.jsonl`), true);
});

test('mutation-log: rotation drops archived idempotency keys from duplicate cache', async () => {
  class TestFile extends TFile {
    vault = {} as never;
    parent = null;
    stat = { ctime: 0, mtime: 0, size: 0 };
    basename: string;
    extension: string;

    constructor(readonly path: string) {
      super();
      this.name = path.split('/').pop() ?? path;
      this.basename = this.name.replace(/\.[^.]*$/u, '');
      this.extension = this.name.includes('.') ? this.name.split('.').pop() ?? '' : '';
    }
  }

  const files = new Map<string, string>();
  const vault = {
    getAbstractFileByPath(path: string): TFile | null {
      return files.has(path) ? new TestFile(path) : null;
    },
    async create(path: string, content: string): Promise<TFile> {
      files.set(path, content);
      return new TestFile(path);
    },
    async read(file: TFile): Promise<string> {
      return files.get(file.path) ?? '';
    },
    async process(file: TFile, updater: (content: string) => string): Promise<void> {
      files.set(file.path, updater(files.get(file.path) ?? ''));
    },
  };
  const log = new MutationLog({ vault } as never, () => ({
    mutationLogEnabled: true,
    mutationLogFile: '.mutation-log.jsonl',
    mutationLogMaxEntries: 1,
  }) as never);

  await log.initialize();
  const archived = await log.logMutation({ source: 'ui', action: 'create', taskKey: 'Tasks.md:1', before: null, after: { content: 'First' }, idempotencyKey: 'archived-key' });
  assert.ok(archived);
  await log.logMutation({ source: 'ui', action: 'update', taskKey: 'Tasks.md:1', before: { content: 'First' }, after: { content: 'Second' }, idempotencyKey: 'retained-key' });

  assert.equal(log.isDuplicate('archived-key'), false);
  assert.equal(log.isDuplicate('retained-key'), true);
  const reused = await log.logMutation({ source: 'ui', action: 'update', taskKey: 'Tasks.md:1', before: { content: 'Second' }, after: { content: 'Third' }, idempotencyKey: 'archived-key' });
  assert.ok(reused);
});
test('mutation-log: initialize ignores malformed entries when restoring idempotency keys', async () => {
  class TestFile extends TFile {
    vault = {} as never;
    parent = null;
    stat = { ctime: 0, mtime: 0, size: 0 };
    basename: string;
    extension: string;

    constructor(readonly path: string) {
      super();
      this.name = path.split('/').pop() ?? path;
      this.basename = this.name.replace(/\.[^.]*$/u, '');
      this.extension = this.name.includes('.') ? this.name.split('.').pop() ?? '' : '';
    }
  }

  const logFilePath = '.mutation-log.jsonl';
  const files = new Map<string, string>([[logFilePath, [
    JSON.stringify({
      operationId: 'op-valid',
      timestamp: '2026-01-01T00:00:00.000Z',
      source: 'ui',
      action: 'create',
      taskKey: 'Tasks.md:1',
      before: null,
      after: { content: 'Valid' },
      idempotencyKey: 'valid-key',
    }),
    JSON.stringify({
      timestamp: '2026-01-02T00:00:00.000Z',
      source: 'ui',
      action: 'create',
      taskKey: 'Tasks.md:2',
      before: null,
      after: { content: 'Missing operationId' },
      idempotencyKey: 'missing-operation-id',
    }),
    JSON.stringify({
      operationId: 'op-invalid-key',
      timestamp: '2026-01-03T00:00:00.000Z',
      source: 'ui',
      action: 'update',
      taskKey: 'Tasks.md:3',
      before: null,
      after: { content: 'Invalid key' },
      idempotencyKey: 123,
    }),
  ].join('\n')]]);
  const vault = {
    getAbstractFileByPath(path: string): TFile | null {
      return files.has(path) ? new TestFile(path) : null;
    },
    async create(path: string, content: string): Promise<TFile> {
      files.set(path, content);
      return new TestFile(path);
    },
    async read(file: TFile): Promise<string> {
      return files.get(file.path) ?? '';
    },
    async process(file: TFile, updater: (content: string) => string): Promise<void> {
      files.set(file.path, updater(files.get(file.path) ?? ''));
    },
  };
  const log = new MutationLog({ vault } as never, () => ({
    mutationLogEnabled: true,
    mutationLogFile: logFilePath,
    mutationLogMaxEntries: 10000,
  }) as never);

  await log.initialize();

  assert.equal(log.isDuplicate('valid-key'), true);
  assert.equal(log.isDuplicate('missing-operation-id'), false);
  assert.equal(log.isDuplicate('invalid-key'), false);
});

test('mutation-log: initialize restores idempotency keys older than 1000 log lines', async () => {
  class TestFile extends TFile {
    vault = {} as never;
    parent = null;
    stat = { ctime: 0, mtime: 0, size: 0 };
    basename: string;
    extension: string;

    constructor(readonly path: string) {
      super();
      this.name = path.split('/').pop() ?? path;
      this.basename = this.name.replace(/\.[^.]*$/u, '');
      this.extension = this.name.includes('.') ? this.name.split('.').pop() ?? '' : '';
    }
  }

  const logFilePath = '.mutation-log.jsonl';
  const files = new Map<string, string>([[logFilePath, Array.from({ length: 1001 }, (_value, index) => JSON.stringify({
    operationId: `op-${index}`,
    timestamp: new Date(0).toISOString(),
    source: 'ui',
    action: 'update',
    taskKey: 'Tasks.md:1',
    before: null,
    after: { index },
    idempotencyKey: `key-${index}`,
  })).join('\n')]]);
  const vault = {
    getAbstractFileByPath(path: string): TFile | null {
      return files.has(path) ? new TestFile(path) : null;
    },
    async create(path: string, content: string): Promise<TFile> {
      files.set(path, content);
      return new TestFile(path);
    },
    async read(file: TFile): Promise<string> {
      return files.get(file.path) ?? '';
    },
    async process(file: TFile, updater: (content: string) => string): Promise<void> {
      files.set(file.path, updater(files.get(file.path) ?? ''));
    },
  };
  const log = new MutationLog({ vault } as never, () => ({
    mutationLogEnabled: true,
    mutationLogFile: logFilePath,
    mutationLogMaxEntries: 10000,
  }) as never);

  await log.initialize();

  assert.equal(log.isDuplicate('key-0'), true);
  assert.equal(log.isDuplicate('key-1000'), true);
});

test('mutation-log: zero limits return no entries', async () => {
  class TestFile extends TFile {
    vault = {} as never;
    parent = null;
    stat = { ctime: 0, mtime: 0, size: 0 };
    basename: string;
    extension: string;

    constructor(readonly path: string) {
      super();
      this.name = path.split('/').pop() ?? path;
      this.basename = this.name.replace(/\.[^.]*$/u, '');
      this.extension = this.name.includes('.') ? this.name.split('.').pop() ?? '' : '';
    }
  }

  const files = new Map<string, string>();
  const vault = {
    getAbstractFileByPath(path: string): TFile | null {
      return files.has(path) ? new TestFile(path) : null;
    },
    async create(path: string, content: string): Promise<TFile> {
      files.set(path, content);
      return new TestFile(path);
    },
    async read(file: TFile): Promise<string> {
      return files.get(file.path) ?? '';
    },
    async process(file: TFile, updater: (content: string) => string): Promise<void> {
      files.set(file.path, updater(files.get(file.path) ?? ''));
    },
  };
  const log = new MutationLog({ vault } as never, () => ({
    mutationLogEnabled: true,
    mutationLogFile: '.mutation-log.jsonl',
    mutationLogMaxEntries: 10000,
  }) as never);

  await log.initialize();
  await log.logMutation({ source: 'ui', action: 'create', taskKey: 'Tasks.md:1', before: null, after: { content: 'First' } });

  assert.deepEqual(await log.queryMutations({ limit: 0 }), []);
  assert.deepEqual(await log.export(0), []);
});

test('mutation-log: undoMutation reports unsupported vault-content undo without logging a fake restore', async () => {
  class TestFile extends TFile {
    vault = {} as never;
    parent = null;
    stat = { ctime: 0, mtime: 0, size: 0 };
    basename: string;
    extension: string;

    constructor(readonly path: string) {
      super();
      this.name = path.split('/').pop() ?? path;
      this.basename = this.name.replace(/\.[^.]*$/u, '');
      this.extension = this.name.includes('.') ? this.name.split('.').pop() ?? '' : '';
    }
  }

  const files = new Map<string, string>();
  const vault = {
    getAbstractFileByPath(path: string): TFile | null {
      return files.has(path) ? new TestFile(path) : null;
    },
    async create(path: string, content: string): Promise<TFile> {
      files.set(path, content);
      return new TestFile(path);
    },
    async read(file: TFile): Promise<string> {
      return files.get(file.path) ?? '';
    },
    async process(file: TFile, updater: (content: string) => string): Promise<void> {
      files.set(file.path, updater(files.get(file.path) ?? ''));
    },
  };
  const log = new MutationLog({ vault } as never, () => ({
    mutationLogEnabled: true,
    mutationLogFile: '.mutation-log.jsonl',
    mutationLogMaxEntries: 10000,
  }) as never);

  await log.initialize();
  const entry = await log.logMutation({
    source: 'ui',
    action: 'update',
    taskKey: 'Tasks.md:1',
    before: { content: 'Before' },
    after: { content: 'After' },
  });
  assert.ok(entry);

  const undone = await log.undoMutation(entry.operationId);

  assert.equal(undone, false);
  assert.deepEqual((await log.queryMutations({ limit: 10 })).map((mutation) => mutation.action), ['update']);
});

test('mutation-log: negative pagination values are clamped instead of slicing from the end', async () => {
  class TestFile extends TFile {
    vault = {} as never;
    parent = null;
    stat = { ctime: 0, mtime: 0, size: 0 };
    basename: string;
    extension: string;

    constructor(readonly path: string) {
      super();
      this.name = path.split('/').pop() ?? path;
      this.basename = this.name.replace(/\.[^.]*$/u, '');
      this.extension = this.name.includes('.') ? this.name.split('.').pop() ?? '' : '';
    }
  }

  const logFilePath = '.mutation-log.jsonl';
  const files = new Map<string, string>([[logFilePath, [
    JSON.stringify({
      operationId: 'op-1',
      timestamp: '2026-01-01T00:00:00.000Z',
      source: 'ui',
      action: 'create',
      taskKey: 'Tasks.md:1',
      before: null,
      after: { content: 'First' },
    }),
    JSON.stringify({
      operationId: 'op-2',
      timestamp: '2026-01-02T00:00:00.000Z',
      source: 'ui',
      action: 'update',
      taskKey: 'Tasks.md:1',
      before: { content: 'First' },
      after: { content: 'Second' },
    }),
  ].join('\n')]]);
  const vault = {
    getAbstractFileByPath(path: string): TFile | null {
      return files.has(path) ? new TestFile(path) : null;
    },
    async create(path: string, content: string): Promise<TFile> {
      files.set(path, content);
      return new TestFile(path);
    },
    async read(file: TFile): Promise<string> {
      return files.get(file.path) ?? '';
    },
    async process(file: TFile, updater: (content: string) => string): Promise<void> {
      files.set(file.path, updater(files.get(file.path) ?? ''));
    },
  };
  const log = new MutationLog({ vault } as never, () => ({
    mutationLogEnabled: true,
    mutationLogFile: logFilePath,
    mutationLogMaxEntries: 10000,
  }) as never);

  await log.initialize();

  const clampedOffset = await log.queryMutations({ offset: -1, limit: 1 });
  assert.deepEqual(clampedOffset.map((entry) => entry.operationId), ['op-2']);
  assert.deepEqual(await log.queryMutations({ limit: -1 }), []);
  assert.deepEqual(await log.export(-1), []);
});

test('mutation-log reserves the idempotency key, rolls back on append failure, and dedups repeats', async () => {
  class TestFile extends TFile {
    vault = {} as never;
    parent = null;
    stat = { ctime: 0, mtime: 0, size: 0 };
    constructor(readonly path: string) {
      super();
      this.name = path.split('/').pop() ?? path;
    }
  }
  const files = new Map<string, string>();
  let failNextAppend = false;
  const vault = {
    getAbstractFileByPath: (path: string): TFile | null => (files.has(path) ? new TestFile(path) : null),
    create: async (path: string, content: string): Promise<TFile> => { files.set(path, content); return new TestFile(path); },
    createFolder: async (): Promise<void> => {},
    read: async (target: TFile): Promise<string> => files.get(target.path) ?? '',
    async process(target: TFile, updater: (content: string) => string): Promise<void> {
      if (failNextAppend) { failNextAppend = false; throw new Error('disk full'); }
      files.set(target.path, updater(files.get(target.path) ?? ''));
    },
  };
  const log = new MutationLog({ vault } as never, () => ({
    mutationLogEnabled: true,
    mutationLogFile: '.mutation-log.jsonl',
    mutationLogMaxEntries: 100,
  }) as never);
  await log.initialize();

  failNextAppend = true;
  const failed = await log.logMutation({ source: 'ui', action: 'create', taskKey: 'k', before: null, after: { content: 'x' }, idempotencyKey: 'key-1' });
  assert.equal(failed, null, 'a failed append returns null');
  const retried = await log.logMutation({ source: 'ui', action: 'create', taskKey: 'k', before: null, after: { content: 'x' }, idempotencyKey: 'key-1' });
  assert.ok(retried, 'the reservation was rolled back so the retry proceeds');
  const duplicate = await log.logMutation({ source: 'ui', action: 'create', taskKey: 'k', before: null, after: { content: 'x' }, idempotencyKey: 'key-1' });
  assert.equal(duplicate, null, 'a repeat of the same key is deduplicated after success');
});

test('mutation-log serializes concurrent rotations without duplicate or missing operation IDs', async () => {
  class TestFile extends TFile {
    vault = {} as never;
    parent = null;
    stat = { ctime: 0, mtime: 0, size: 0 };
    constructor(readonly path: string) { super(); this.name = path.split('/').pop() ?? path; }
  }
  const files = new Map<string, string>();
  const vault = {
    getAbstractFileByPath: (path: string): TFile | null => (files.has(path) ? new TestFile(path) : null),
    create: async (path: string, content: string): Promise<TFile> => { files.set(path, content); return new TestFile(path); },
    createFolder: async (): Promise<void> => {},
    read: async (target: TFile): Promise<string> => files.get(target.path) ?? '',
    async process(target: TFile, updater: (content: string) => string): Promise<void> {
      await new Promise<void>((resolve) => setImmediate(resolve));
      files.set(target.path, updater(files.get(target.path) ?? ''));
    },
  };
  const log = new MutationLog({ vault } as never, () => ({ mutationLogEnabled: true, mutationLogFile: '.mutation-log.jsonl', mutationLogMaxEntries: 1 }) as never);
  await log.initialize();
  const results = await Promise.all(['one', 'two', 'three'].map((key) => log.logMutation({
    source: 'ui', action: 'update', taskKey: key, before: null, after: { key }, idempotencyKey: key,
  })));
  assert.ok(results.every(Boolean));

  const active = files.get('.mutation-log.jsonl') ?? '';
  const backupPath = [...files.keys()].find((path) => /^\.mutation-log\.\d{4}-\d{2}-\d{2}\.jsonl$/u.test(path));
  assert.ok(backupPath);
  const combined = [files.get(backupPath) ?? '', active].flatMap((content) => content.split('\n').filter(Boolean)).map((line) => JSON.parse(line) as MutationEntry);
  assert.deepEqual(new Set(combined.map((entry) => entry.operationId)).size, 3);
  assert.deepEqual(new Set(combined.map((entry) => entry.idempotencyKey)), new Set(['one', 'two', 'three']));
});

test('mutation-log keeps a committed idempotency key when post-append settings maintenance fails', async () => {
  class TestFile extends TFile {
    vault = {} as never;
    parent = null;
    stat = { ctime: 0, mtime: 0, size: 0 };
    constructor(readonly path: string) { super(); this.name = path.split('/').pop() ?? path; }
  }
  const files = new Map<string, string>();
  const vault = {
    getAbstractFileByPath: (path: string): TFile | null => (files.has(path) ? new TestFile(path) : null),
    create: async (path: string, content: string): Promise<TFile> => { files.set(path, content); return new TestFile(path); },
    createFolder: async (): Promise<void> => {},
    read: async (target: TFile): Promise<string> => files.get(target.path) ?? '',
    process: async (target: TFile, updater: (content: string) => string): Promise<void> => { files.set(target.path, updater(files.get(target.path) ?? '')); },
  };
  let failSettings = false;
  const log = new MutationLog({ vault } as never, () => {
    if (failSettings) throw new Error('settings unavailable');
    return { mutationLogEnabled: true, mutationLogFile: '.mutation-log.jsonl', mutationLogMaxEntries: 100 } as never;
  });
  await log.initialize();
  const originalError = console.error;
  console.error = () => undefined;
  try {
    failSettings = true;
    const committed = await log.logMutation({ source: 'ui', action: 'create', taskKey: 'k', before: null, after: { content: 'x' }, idempotencyKey: 'key' });
    assert.ok(committed, 'maintenance failure must not make the durable append look failed');
    assert.equal(log.isDuplicate('key'), true);
    assert.equal(await log.logMutation({ source: 'ui', action: 'create', taskKey: 'k', before: null, after: { content: 'x' }, idempotencyKey: 'key' }), null);
    assert.equal((files.get('.mutation-log.jsonl') ?? '').split('\n').filter(Boolean).length, 1);
  } finally {
    console.error = originalError;
  }
});
