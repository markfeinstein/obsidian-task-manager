import test from 'node:test';
import assert from 'node:assert/strict';
import { TFile, type App } from 'obsidian';
import { TaskScanner, type ParsedTask } from '../src/task-scanner';
import {
  DashboardDailyDeleteSession,
  dashboardDeleteConfirmationSummary,
  planDashboardDailyDelete,
} from '../src/dashboard-daily-delete';

interface TestVault {
  app: App;
  files: Map<string, string>;
  processCalls: string[];
  failProcessCalls: Set<number>;
}

function createVault(initial: Record<string, string>): TestVault {
  const files = new Map(Object.entries(initial));
  const tFiles = new Map([...files].map(([path]) => [path, Object.assign(Object.create(TFile.prototype) as TFile, { path, name: path.split('/').pop() ?? path })]));
  const processCalls: string[] = [];
  const failProcessCalls = new Set<number>();
  const vault = {
    getAbstractFileByPath: (path: string) => tFiles.get(path) ?? null,
    getMarkdownFiles: () => [...tFiles.values()],
    read: async (file: TFile) => files.get(file.path) ?? '',
    process: async (file: TFile, callback: (content: string) => string) => {
      processCalls.push(file.path);
      if (failProcessCalls.has(processCalls.length)) throw new Error(`forced failure ${processCalls.length}`);
      const current = files.get(file.path) ?? '';
      files.set(file.path, callback(current));
    },
  };
  const app = { vault, metadataCache: { getFileCache: () => null } } as unknown as App;
  return { app, files, processCalls, failProcessCalls };
}

function parsed(scanner: TaskScanner, line: string, path: string, lineNumber: number): ParsedTask {
  const task = scanner.parseTaskLine(line, path, lineNumber, '');
  assert.ok(task, `expected a task at ${path}:${lineNumber}`);
  return task;
}

test('dashboard delete plans descendants, merges selected children, and reports explicit metrics', async () => {
  const source = '- [ ] Parent\n  - [ ] Child\n    child note\n- [ ] Keep\n';
  const vault = createVault({ 'Daily.md': source });
  const scanner = new TaskScanner(vault.app);
  const parent = parsed(scanner, '- [ ] Parent', 'Daily.md', 1);
  const child = parsed(scanner, '  - [ ] Child', 'Daily.md', 2);
  const plan = await planDashboardDailyDelete(vault.app, scanner, [parent, child]);
  assert.equal(plan.selectedCount, 2);
  assert.equal(plan.descendantLineCount, 1);
  assert.equal(plan.descendantTaskCount, 0);
  assert.equal(plan.files[0]?.hunks[0]?.removedText, '- [ ] Parent\n  - [ ] Child\n    child note\n');
  assert.equal(plan.files[0]?.afterContent, '- [ ] Keep\n');
  assert.match(dashboardDeleteConfirmationSummary(plan), /2 selected tasks and 1 additional indented line/u);
  assert.match(dashboardDeleteConfirmationSummary(plan), /None of the additional lines are tasks/u);
});

test('dashboard delete preserves unrelated bytes and CRLF for unrelated selections', async () => {
  const source = 'intro\r\n- [ ] One\r\n  note\r\nmiddle\r\n- [ ] Two\r\nend\r\n';
  const vault = createVault({ 'Daily.md': source });
  const scanner = new TaskScanner(vault.app);
  const one = parsed(scanner, '- [ ] One', 'Daily.md', 2);
  const two = parsed(scanner, '- [ ] Two', 'Daily.md', 5);
  const plan = await planDashboardDailyDelete(vault.app, scanner, [one, two]);
  assert.equal(plan.files[0]?.afterContent, 'intro\r\nmiddle\r\nend\r\n');
  assert.ok(plan.files[0]?.hunks.every((hunk) => hunk.removedText.includes('\r\n')));
});

test('dashboard delete relocates unique tasks and rejects missing or ambiguous identities before writes', async () => {
  const vault = createVault({ 'Daily.md': 'preface\n- [ ] Move me\n' });
  const scanner = new TaskScanner(vault.app);
  const stale = parsed(scanner, '- [ ] Move me', 'Daily.md', 1);
  const plan = await planDashboardDailyDelete(vault.app, scanner, [stale]);
  assert.equal(plan.files[0]?.afterContent, 'preface\n');
  await assert.rejects(() => planDashboardDailyDelete(vault.app, scanner, [parsed(scanner, '- [ ] Missing', 'Daily.md', 2)]), /no longer exists/u);
  vault.files.set('Daily.md', '- [ ] Same\n- [ ] Same\n');
  await assert.rejects(() => planDashboardDailyDelete(vault.app, scanner, [parsed(scanner, '- [ ] Same', 'Daily.md', 1)]), /ambiguous/u);
  assert.equal(vault.processCalls.length, 0);
});

test('multi-file commit writes each file once and exact undo is LIFO and single activation', async () => {
  const vault = createVault({ 'A.md': '- [ ] A\n', 'B.md': '- [ ] B\r\n  child\r\n' });
  const scanner = new TaskScanner(vault.app);
  const plan = await planDashboardDailyDelete(vault.app, scanner, [
    parsed(scanner, '- [ ] A', 'A.md', 1),
    parsed(scanner, '- [ ] B', 'B.md', 1),
  ]);
  const session = new DashboardDailyDeleteSession(vault.app);
  await session.commit(plan);
  assert.deepEqual(vault.processCalls, ['A.md', 'B.md']);
  assert.equal(vault.files.get('A.md'), '');
  assert.equal(vault.files.get('B.md'), '');
  const firstUndo = session.undo();
  await assert.rejects(() => session.undo(), /already running/u);
  await firstUndo;
  assert.equal(vault.files.get('A.md'), '- [ ] A\n');
  assert.equal(vault.files.get('B.md'), '- [ ] B\r\n  child\r\n');
  assert.equal(session.undoable, null);
});

test('commit conflicts do not overwrite and second-file failure compensates the first', async () => {
  const vault = createVault({ 'A.md': '- [ ] A\n', 'B.md': '- [ ] B\n' });
  const scanner = new TaskScanner(vault.app);
  const plan = await planDashboardDailyDelete(vault.app, scanner, [parsed(scanner, '- [ ] A', 'A.md', 1), parsed(scanner, '- [ ] B', 'B.md', 1)]);
  vault.files.set('B.md', '- [ ] B\nconcurrent\n');
  const session = new DashboardDailyDeleteSession(vault.app);
  await assert.rejects(() => session.commit(plan), /conflict/u);
  assert.equal(vault.processCalls.length, 0);
  assert.equal(vault.files.get('A.md'), '- [ ] A\n');

  vault.files.set('B.md', '- [ ] B\n');
  vault.failProcessCalls.add(2);
  await assert.rejects(() => session.commit(plan), /forced failure/u);
  assert.equal(vault.files.get('A.md'), '- [ ] A\n');
  assert.equal(vault.files.get('B.md'), '- [ ] B\n');
  assert.equal(session.undoable, null);
});

test('failed delete compensation survives owner teardown/reopen and can be retried safely', async () => {
  const vault = createVault({ 'A.md': '- [ ] A\n', 'B.md': '- [ ] B\n' });
  const scanner = new TaskScanner(vault.app);
  const plan = await planDashboardDailyDelete(vault.app, scanner, [parsed(scanner, '- [ ] A', 'A.md', 1), parsed(scanner, '- [ ] B', 'B.md', 1)]);
  vault.failProcessCalls.add(2);
  vault.failProcessCalls.add(3);
  const session = new DashboardDailyDeleteSession(vault.app);
  await assert.rejects(() => session.commit(plan), /recovery is required/u);
  assert.deepEqual(session.recovery?.paths, ['A.md']);
  assert.equal(vault.files.get('A.md'), '');
  session.clearUndoHistory(); // Dashboard owner closes; ordinary undo history may be released.
  const reopenedSession = new DashboardDailyDeleteSession(vault.app);
  assert.deepEqual(reopenedSession.recovery?.paths, ['A.md'], 'App-scoped recovery survives owner replacement');
  vault.failProcessCalls.clear();
  await reopenedSession.retryRecovery();
  assert.equal(vault.files.get('A.md'), '- [ ] A\n');
  assert.equal(reopenedSession.recovery, null);
  assert.equal(session.recovery, null);
});

test('undo reinserts through unique anchors after unrelated edits and fails closed on ambiguity', async () => {
  const original = 'before\n- [ ] Delete\n  detail\nafter\n';
  const vault = createVault({ 'A.md': original });
  const scanner = new TaskScanner(vault.app);
  const plan = await planDashboardDailyDelete(vault.app, scanner, [parsed(scanner, '- [ ] Delete', 'A.md', 2)]);
  const session = new DashboardDailyDeleteSession(vault.app);
  await session.commit(plan);
  vault.files.set('A.md', `unrelated\n${vault.files.get('A.md')}`);
  await session.undo();
  assert.equal(vault.files.get('A.md'), `unrelated\n${original}`);

  await session.commit(await planDashboardDailyDelete(vault.app, scanner, [parsed(scanner, '- [ ] Delete', 'A.md', 3)]));
  vault.files.set('A.md', 'before\nafter\nbefore\nafter\n');
  const calls = vault.processCalls.length;
  await assert.rejects(() => session.undo(), /anchors are missing or ambiguous/u);
  assert.equal(vault.processCalls.length, calls);
  assert.ok(session.undoable);
});

test('undo failure compensates prior restores and compensation failure reports recovery-required', async () => {
  const vault = createVault({ 'A.md': '- [ ] A\n', 'B.md': '- [ ] B\n' });
  const scanner = new TaskScanner(vault.app);
  const plan = await planDashboardDailyDelete(vault.app, scanner, [parsed(scanner, '- [ ] A', 'A.md', 1), parsed(scanner, '- [ ] B', 'B.md', 1)]);
  const session = new DashboardDailyDeleteSession(vault.app);
  await session.commit(plan);
  vault.failProcessCalls.add(4); // B restore fails; A restore is compensated on call 5.
  await assert.rejects(() => session.undo(), /forced failure/u);
  assert.equal(vault.files.get('A.md'), '');
  assert.equal(session.recovery, null);
  assert.ok(session.undoable);

  vault.failProcessCalls.clear();
  vault.failProcessCalls.add(7); // B restore failure on second attempt.
  vault.failProcessCalls.add(8); // A compensation failure.
  await assert.rejects(() => session.undo(), /recovery is required/u);
  const recovery = session.recovery as { paths: readonly string[] } | null;
  assert.deepEqual(recovery?.paths, ['A.md']);
});

test('zero-descendant confirmation explicitly states that no descendant lines are removed', async () => {
  const vault = createVault({ 'A.md': '- [ ] A\nkeep\n' });
  const scanner = new TaskScanner(vault.app);
  const plan = await planDashboardDailyDelete(vault.app, scanner, [parsed(scanner, '- [ ] A', 'A.md', 1)]);
  assert.match(dashboardDeleteConfirmationSummary(plan), /No indented descendant lines will be removed/u);
});

test('undo failure compensation preserves unrelated edits instead of restoring stale full snapshots', async () => {
  const vault = createVault({ 'A.md': 'head\n- [ ] A\ntail\n', 'B.md': 'head\n- [ ] B\ntail\n' });
  const scanner = new TaskScanner(vault.app);
  const plan = await planDashboardDailyDelete(vault.app, scanner, [parsed(scanner, '- [ ] A', 'A.md', 2), parsed(scanner, '- [ ] B', 'B.md', 2)]);
  const session = new DashboardDailyDeleteSession(vault.app);
  await session.commit(plan);
  vault.files.set('A.md', `unrelated\n${vault.files.get('A.md')}`);
  vault.files.set('B.md', `unrelated\n${vault.files.get('B.md')}`);
  vault.failProcessCalls.add(4); // A restores on 3, B fails on 4, A compensates on 5.
  await assert.rejects(() => session.undo(), /forced failure/u);
  assert.equal(vault.files.get('A.md'), 'unrelated\nhead\ntail\n');
  assert.equal(vault.files.get('B.md'), 'unrelated\nhead\ntail\n');
  assert.ok(session.undoable);
});
