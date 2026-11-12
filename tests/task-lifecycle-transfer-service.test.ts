import test from 'node:test';
import assert from 'node:assert/strict';
import { TFile } from 'obsidian';
import { StateStore, type PersistedState } from '../src/state-store';
import { LifecycleTransferRecoveryError, TaskLifecycleTransferService } from '../src/task-lifecycle-transfer-service';

function file(path: string): TFile {
  return Object.assign(Object.create(TFile.prototype) as TFile, { path, name: path.split('/').pop(), basename: path.replace(/\.md$/u, ''), extension: 'md', stat: { mtime: 1, ctime: 1, size: 1 } });
}

function harness(sourceContent = '- [x] Done\n', targetContent = '') {
  const source = file('Source.md'); const target = file('Archive.md');
  const files = new Map<string, TFile>([[source.path, source], [target.path, target]]);
  const contents = new Map<string, string>([[source.path, sourceContent], [target.path, targetContent]]);
  let pluginData: { state?: PersistedState } = { state: { version: 2, snapshot: [], completions: [] } };
  let processHook: ((path: string, count: number) => void) | undefined; let processCount = 0;
  let saveHook: ((count: number) => void) | undefined; let saveCount = 0;
  const app = { vault: {
    getAbstractFileByPath: (path: string) => files.get(path) ?? null,
    read: async (f: TFile) => contents.get(f.path) ?? '',
    process: async (f: TFile, update: (content: string) => string) => { processCount += 1; processHook?.(f.path, processCount); contents.set(f.path, update(contents.get(f.path) ?? '')); },
    create: async (path: string, content: string) => { const f = file(path); files.set(path, f); contents.set(path, content); return f; },
    createFolder: async () => undefined,
  } };
  const store = new StateStore({ loadData: async () => structuredClone(pluginData), saveData: async (data: typeof pluginData) => { saveCount += 1; saveHook?.(saveCount); pluginData = structuredClone(data); } } as never);
  return {
    app, store, files, contents,
    setProcessHook: (hook?: typeof processHook) => { processHook = hook; },
    setSaveHook: (hook?: typeof saveHook) => { saveHook = hook; },
    state: () => store.loadState(),
  };
}

const request = {
  action: 'archive' as const, sourcePath: 'Source.md', sourceLine: 1, sourceIdentity: 'id:done',
  sourceBlock: '- [x] Done', sourceReplacement: '', targetPath: 'Archive.md', targetHeading: 'Archived Tasks',
};

test('StateStore strictly rejects malformed lifecycle transfer journals', async () => {
  const store = new StateStore({
    loadData: async () => ({ state: { version: 2, snapshot: [], completions: [], taskLifecycleTransferJournals: [{ operationId: 'bad', action: 'archive', phase: 'prepared' }] } }),
    saveData: async () => undefined,
  } as never);
  assert.deepEqual((await store.loadState()).taskLifecycleTransferJournals, []);
});

test('invalid multiline headings fail before journal or vault mutation', async () => {
  const h = harness();
  await assert.rejects(
    new TaskLifecycleTransferService(h.app as never, h.store).transfer({ ...request, targetHeading: 'Archive\nInjected' }),
    /single-line heading/u,
  );
  assert.equal(h.contents.get('Source.md'), '- [x] Done\n');
  assert.equal(h.contents.get('Archive.md'), '');
  assert.deepEqual((await h.state()).taskLifecycleTransferJournals, []);
});

test('lifecycle transfer completes destination-first and removes marker/journal', async () => {
  const h = harness();
  await new TaskLifecycleTransferService(h.app as never, h.store).transfer(request);
  assert.equal(h.contents.get('Source.md'), '');
  assert.match(h.contents.get('Archive.md') ?? '', /## Archived Tasks\n- \[x\] Done/u);
  assert.doesNotMatch(h.contents.get('Archive.md') ?? '', /task-manager-lifecycle/u);
  assert.deepEqual((await h.state()).taskLifecycleTransferJournals, []);
});

test('lifecycle transfer reuses a semantically matching Markdown heading', async () => {
  const h = harness('- [x] Done\n', '# Archive\n\n## Archived Tasks ###\nExisting\n');
  await new TaskLifecycleTransferService(h.app as never, h.store).transfer(request);
  const target = h.contents.get('Archive.md') ?? '';
  assert.equal(target.match(/Archived Tasks/gu)?.length, 1);
  assert.match(target, /## Archived Tasks ###\n- \[x\] Done\nExisting/u);
});

test('source failure retains a journal and restart rolls back only the marked destination', async () => {
  const h = harness();
  h.setProcessHook((path) => { if (path === 'Source.md') throw new Error('source write failed'); });
  await assert.rejects(new TaskLifecycleTransferService(h.app as never, h.store).transfer(request), LifecycleTransferRecoveryError);
  assert.match(h.contents.get('Archive.md') ?? '', /task-manager-lifecycle/u);
  h.setProcessHook();
  const results = await new TaskLifecycleTransferService(h.app as never, h.store).reconcilePendingTransfers();
  assert.equal(results[0]?.outcome, 'rolled-back');
  assert.equal(h.contents.get('Source.md'), '- [x] Done\n');
  assert.equal(h.contents.get('Archive.md'), '');
  assert.deepEqual((await h.state()).taskLifecycleTransferJournals, []);
});

test('restart retains ambiguous recovery when source was renamed during finalization', async () => {
  const h = harness();
  h.setProcessHook((path) => {
    if (path === 'Source.md') h.contents.set('Source.md', '- [x] Renamed concurrently\n');
  });
  await assert.rejects(new TaskLifecycleTransferService(h.app as never, h.store).transfer(request), LifecycleTransferRecoveryError);
  h.setProcessHook();
  const results = await new TaskLifecycleTransferService(h.app as never, h.store).reconcilePendingTransfers();
  assert.equal(results[0]?.outcome, 'pending');
  assert.equal(h.contents.get('Source.md'), '- [x] Renamed concurrently\n');
  assert.match(h.contents.get('Archive.md') ?? '', /task-manager-lifecycle/u);
  assert.equal((await h.state()).taskLifecycleTransferJournals?.length, 1);
});

test('hashed journal mismatch never falls through to block heuristics', async () => {
  const h = harness();
  h.setProcessHook((path) => { if (path === 'Source.md') throw new Error('source write failed'); });
  await assert.rejects(new TaskLifecycleTransferService(h.app as never, h.store).transfer(request), LifecycleTransferRecoveryError);
  h.setProcessHook();
  h.contents.set('Source.md', `Intro\n${h.contents.get('Source.md') ?? ''}`);
  h.contents.set('Archive.md', `Unrelated\n${h.contents.get('Archive.md') ?? ''}`);
  const results = await new TaskLifecycleTransferService(h.app as never, h.store).reconcilePendingTransfers();
  assert.equal(results[0]?.outcome, 'pending');
  assert.match(h.contents.get('Archive.md') ?? '', /task-manager-lifecycle/u);
});

test('legacy no-hash journal may still use exact-line block rollback evidence', async () => {
  const h = harness();
  h.setProcessHook((path) => { if (path === 'Source.md') throw new Error('source write failed'); });
  await assert.rejects(new TaskLifecycleTransferService(h.app as never, h.store).transfer(request), LifecycleTransferRecoveryError);
  h.setProcessHook();
  await h.store.updateState((state) => ({ ...state, taskLifecycleTransferJournals: (state.taskLifecycleTransferJournals ?? []).map(({ sourceOriginalHash: _a, sourceFinalizedHash: _b, ...journal }) => journal) }));
  h.contents.set('Archive.md', `Unrelated\n${h.contents.get('Archive.md') ?? ''}`);
  const results = await new TaskLifecycleTransferService(h.app as never, h.store).reconcilePendingTransfers();
  assert.equal(results[0]?.outcome, 'rolled-back');
  assert.equal(h.contents.get('Archive.md'), 'Unrelated\n');
});

test('legacy no-hash journal does not treat a relocated matching block as source evidence', async () => {
  const h = harness();
  h.setProcessHook((path) => { if (path === 'Source.md') throw new Error('source write failed'); });
  await assert.rejects(new TaskLifecycleTransferService(h.app as never, h.store).transfer(request), LifecycleTransferRecoveryError);
  h.setProcessHook();
  await h.store.updateState((state) => ({ ...state, taskLifecycleTransferJournals: (state.taskLifecycleTransferJournals ?? []).map(({ sourceOriginalHash: _a, sourceFinalizedHash: _b, ...journal }) => journal) }));
  h.contents.set('Source.md', `Intro\n${h.contents.get('Source.md') ?? ''}`);
  const results = await new TaskLifecycleTransferService(h.app as never, h.store).reconcilePendingTransfers();
  assert.equal(results[0]?.outcome, 'pending');
  assert.match(h.contents.get('Archive.md') ?? '', /task-manager-lifecycle/u);
  assert.equal((await h.state()).taskLifecycleTransferJournals?.length, 1);
});

test('hashed journal rejects coincidental replacement and absent-source evidence', async () => {
  const h = harness();
  h.setProcessHook((path) => { if (path === 'Source.md') h.contents.set('Source.md', '- [ ] Next\nUnrelated\n'); });
  await assert.rejects(new TaskLifecycleTransferService(h.app as never, h.store).transfer({ ...request, sourceReplacement: '- [ ] Next' }), LifecycleTransferRecoveryError);
  h.setProcessHook();
  assert.equal((await new TaskLifecycleTransferService(h.app as never, h.store).reconcilePendingTransfers())[0]?.outcome, 'pending');
  h.files.delete('Source.md');
  h.contents.delete('Source.md');
  assert.equal((await new TaskLifecycleTransferService(h.app as never, h.store).reconcilePendingTransfers())[0]?.outcome, 'pending');
});

test('finalized source hash recovers a crash before finalized phase persistence', async () => {
  const h = harness();
  h.setSaveHook((count) => { if (count === 3) throw new Error('phase persistence crash'); });
  await assert.rejects(new TaskLifecycleTransferService(h.app as never, h.store).transfer(request), LifecycleTransferRecoveryError);
  h.setSaveHook();
  assert.equal(h.contents.get('Source.md'), '');
  assert.equal((await new TaskLifecycleTransferService(h.app as never, h.store).reconcilePendingTransfers())[0]?.outcome, 'completed');
});

test('source hashes preserve CRLF and missing-final-newline finalization', async () => {
  const h = harness('- [x] Done\r\n  child', '');
  await new TaskLifecycleTransferService(h.app as never, h.store).transfer({ ...request, sourceBlock: '- [x] Done\n  child' });
  assert.equal(h.contents.get('Source.md'), '');
  assert.match(h.contents.get('Archive.md') ?? '', /- \[x\] Done\r\n  child/u);
});

test('pending target journal atomically fences another transfer to the same destination', async () => {
  const h = harness();
  h.setProcessHook((path) => { if (path === 'Source.md') throw new Error('source write failed'); });
  await assert.rejects(new TaskLifecycleTransferService(h.app as never, h.store).transfer(request), LifecycleTransferRecoveryError);
  h.setProcessHook();
  await assert.rejects(
    new TaskLifecycleTransferService(h.app as never, h.store).transfer({ ...request, sourceIdentity: 'id:other' }),
    /already fences/u,
  );
  assert.equal((await h.state()).taskLifecycleTransferJournals?.length, 1);
});

test('restart completes marker cleanup and recurrence effects exactly once', async () => {
  const h = harness('- [x] Done\n', '');
  let targetProcesses = 0;
  h.setProcessHook((path) => { if (path === 'Archive.md' && ++targetProcesses === 2) throw new Error('marker cleanup crash'); });
  await assert.rejects(new TaskLifecycleTransferService(h.app as never, h.store).transfer({
    ...request,
    sourceReplacement: '- [ ] Next',
    recurrenceCommit: { taskKey: 'id:done', incrementCount: true, seriesId: 'series', date: '2026-07-12' },
  }), LifecycleTransferRecoveryError);
  h.setProcessHook();
  h.contents.set('Source.md', '- [ ] Next edited after durable finalization\n');
  const service = new TaskLifecycleTransferService(h.app as never, h.store);
  assert.equal((await service.reconcilePendingTransfers())[0]?.outcome, 'completed');
  assert.deepEqual((await service.reconcilePendingTransfers()), []);
  const state = await h.state();
  assert.equal(state.recurrenceCounts?.['id:done'], 1);
  assert.equal(state.recurrenceOccurrences?.series?.length, 1);
  assert.equal(h.contents.get('Source.md'), '- [ ] Next edited after durable finalization\n');
  assert.doesNotMatch(h.contents.get('Archive.md') ?? '', /task-manager-lifecycle/u);
});
