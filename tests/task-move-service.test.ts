import test from 'node:test';
import assert from 'node:assert/strict';
import { TFile, TFolder } from 'obsidian';
import { StateStore, type PersistedState, type TaskMoveJournal } from '../src/state-store';
import {
  extractTaskBlock,
  TaskMoveConflictError,
  TaskMoveRecoveryError,
  TaskMoveService,
} from '../src/task-move-service';
import { parseMarkdownTaskLine } from '../src/task-model';
import { TaskIndex } from '../src/task-index';

type ProcessHook = (file: TFile, current: string, call: number) => void;

function fileForPath(path: string): TFile {
  const name = path.split('/').pop() ?? path;
  return Object.assign(Object.create(TFile.prototype) as TFile, {
    path,
    name,
    extension: path.endsWith('.md') ? 'md' : '',
    basename: name.replace(/\.md$/u, ''),
  });
}

function folderForPath(path: string): TFolder {
  return Object.assign(Object.create(TFolder.prototype) as TFolder, { path, name: path.split('/').pop() ?? path, children: [] });
}

class MemoryPlugin {
  data: { state?: Partial<PersistedState> } = {};
  saveError: Error | null = null;
  failSaveFromCall: number | null = null;
  saveCalls = 0;
  async loadData(): Promise<unknown> { return this.data; }
  async saveData(value: unknown): Promise<void> {
    this.saveCalls += 1;
    if (this.saveError || (this.failSaveFromCall !== null && this.saveCalls >= this.failSaveFromCall)) throw this.saveError ?? new Error('state unavailable');
    this.data = value as { state?: Partial<PersistedState> };
  }
}

class MemoryVault {
  readonly files = new Map<string, { file: TFile; content: string }>();
  readonly folders = new Map<string, TFolder>();
  processCalls = 0;
  createError: Error | null = null;
  readonly readErrors = new Map<string, Error>();
  readonly readOverrides = new Map<string, string>();
  processHook: ProcessHook | null = null;

  add(path: string, content: string): TFile {
    const file = fileForPath(path);
    this.files.set(path, { file, content });
    return file;
  }

  get(path: string): string | undefined { return this.files.get(path)?.content; }

  set(path: string, content: string): void {
    const entry = this.files.get(path);
    if (!entry) throw new Error(`missing ${path}`);
    entry.content = content;
  }

  getAbstractFileByPath(path: string): TFile | TFolder | null {
    return this.files.get(path)?.file ?? this.folders.get(path) ?? null;
  }

  async read(file: TFile): Promise<string> {
    const readError = this.readErrors.get(file.path);
    if (readError) throw readError;
    if (this.readOverrides.has(file.path)) return this.readOverrides.get(file.path) ?? '';
    const entry = this.files.get(file.path);
    if (!entry) throw new Error(`missing ${file.path}`);
    return entry.content;
  }

  async process(file: TFile, updater: (current: string) => string): Promise<void> {
    const entry = this.files.get(file.path);
    if (!entry) throw new Error(`missing ${file.path}`);
    this.processCalls += 1;
    this.processHook?.(file, entry.content, this.processCalls);
    entry.content = updater(entry.content);
  }

  async create(path: string, content: string): Promise<TFile> {
    if (this.createError) throw this.createError;
    if (this.getAbstractFileByPath(path)) throw new Error('collision');
    return this.add(path, content);
  }

  async createFolder(path: string): Promise<TFolder> {
    if (this.files.has(path)) throw new Error('file collision');
    const folder = folderForPath(path);
    this.folders.set(path, folder);
    return folder;
  }
}

class MemoryEditor {
  setCalls = 0;
  replaceCalls = 0;
  constructor(public content: string) {}
  getValue(): string { return this.content; }
  setValue(value: string): void { this.setCalls += 1; this.content = value; }
  getLine(line: number): string { return this.content.split(/\r\n|\n|\r/u)[line] ?? ''; }
  replaceRange(replacement: string, from: { line: number; ch: number }, to?: { line: number; ch: number }): void {
    this.replaceCalls += 1;
    const start = offsetAt(this.content, from);
    const end = to ? offsetAt(this.content, to) : start;
    this.content = this.content.slice(0, start) + replacement + this.content.slice(end);
  }
}

function offsetAt(content: string, position: { line: number; ch: number }): number {
  const matches = [...content.matchAll(/\r\n|\n|\r/gu)];
  const start = position.line === 0 ? 0 : (matches[position.line - 1]?.index ?? content.length) + (matches[position.line - 1]?.[0].length ?? 0);
  return start + position.ch;
}

function harness(source = '- [ ] Move me\n', target = ''): {
  vault: MemoryVault;
  plugin: MemoryPlugin;
  store: StateStore;
  editor: MemoryEditor;
  service: TaskMoveService;
} {
  const vault = new MemoryVault();
  vault.add('Source.md', source);
  vault.add('Target.md', target);
  const plugin = new MemoryPlugin();
  const store = new StateStore(plugin as never);
  const editor = new MemoryEditor(source);
  const service = new TaskMoveService({ vault } as never, store);
  return { vault, plugin, store, editor, service };
}

async function journals(store: StateStore): Promise<TaskMoveJournal[]> {
  return (await store.loadState()).taskMoveJournals ?? [];
}

test('new moves wait for startup lifecycle recovery before reading or writing files', async () => {
  const { store, editor, service } = harness();
  let release!: () => void;
  store.setLifecycleRecoveryGate(new Promise<void>((resolve) => { release = resolve; }));
  let settled = false;
  const moving = service.move({ editor: editor as never, sourcePath: 'Source.md', targetPath: 'Target.md', sourceLine: 0 })
    .finally(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  release();
  await moving;
  assert.equal(settled, true);
});

test('extractTaskBlock includes blank-separated nested tasks, comments, continuations, and blockquotes', () => {
  const content = '- [ ] Parent\n\n  - [ ] Child\n    child continuation\n  > child quote\n  comment\n- [ ] Sibling\n';
  const block = extractTaskBlock(content, 0);
  assert.equal(block.block, '- [ ] Parent\n\n  - [ ] Child\n    child continuation\n  > child quote\n  comment\n');
});

test('extractTaskBlock does not consume same-level blockquote siblings or unrelated top-level quotes', () => {
  const quoted = '> - [ ] First\n> - [ ] Second\n';
  assert.equal(extractTaskBlock(quoted, 0).block, '> - [ ] First\n');
  const unquoted = '- [ ] Root\n> unrelated quote\n- [ ] Next\n';
  assert.equal(extractTaskBlock(unquoted, 0).block, '- [ ] Root\n');
});

test('cross-file move preserves the exact CRLF block and clears marker and journal', async () => {
  const source = '- [ ] Parent [id:: stable]\r\n\r\n  - [ ] Child\r\n- [ ] Sibling\r\n';
  const { vault, store, editor, service } = harness(source, '## Inbox\r\n- [ ] Existing\r\n');
  const beforeKey = parseMarkdownTaskLine('- [ ] Parent [id:: stable]', 'Source.md', 1)?.key;

  const result = await service.move({ editor: editor as never, sourcePath: 'Source', targetPath: 'Target.md', sourceLine: 0, targetHeading: '## Inbox' });

  assert.ok(result.operationId);
  assert.equal(editor.content, '- [ ] Sibling\r\n');
  assert.equal(vault.get('Source.md'), '- [ ] Sibling\r\n', 'source removal must be durably committed before cleanup');
  assert.equal(vault.get('Target.md'), '## Inbox\r\n- [ ] Parent [id:: stable]\r\n\r\n  - [ ] Child\r\n- [ ] Existing\r\n');
  assert.equal(vault.get('Target.md')?.includes('task-manager-move:'), false);
  assert.deepEqual(await journals(store), []);
  const afterKey = parseMarkdownTaskLine('- [ ] Parent [id:: stable]', 'Target.md', 2)?.key;
  assert.equal(afterKey, beforeKey, 'explicit ID identity must not be rekeyed by location');
  assert.notEqual(parseMarkdownTaskLine('- [ ] No id', 'Source.md', 1)?.key, parseMarkdownTaskLine('- [ ] No id', 'Target.md', 1)?.key, 'no-ID identity remains location-coupled');
});

test('same-file move updates the editor once with the full block under the heading', async () => {
  const source = '# Note\n## Inbox\n- [ ] Existing\n## Work\n- [ ] Parent\n\n  - [ ] Child\n- [ ] Keep\n';
  const { editor, service } = harness(source);

  await service.move({ editor: editor as never, sourcePath: 'Source.md', targetPath: 'Source.md', sourceLine: 4, targetHeading: '## Inbox' });

  assert.equal(editor.setCalls, 1);
  assert.equal(editor.replaceCalls, 0);
  assert.equal(editor.content, '# Note\n## Inbox\n- [ ] Parent\n\n  - [ ] Child\n- [ ] Existing\n## Work\n- [ ] Keep\n');
});

test('target failure leaves source intact and removes the prepared journal', async () => {
  const { vault, store, editor, service } = harness();
  vault.files.delete('Target.md');
  vault.createError = new Error('target write failed');

  await assert.rejects(service.move({ editor: editor as never, sourcePath: 'Source.md', targetPath: 'Target.md', sourceLine: 0 }), /target write failed/u);

  assert.equal(editor.content, '- [ ] Move me\n');
  assert.equal(editor.replaceCalls, 0);
  assert.deepEqual(await journals(store), []);
});

test('uncertain target evidence retains the journal when phase persistence and target reads fail', async () => {
  const { vault, plugin, store, editor, service } = harness('- [ ] Move me\n', '# Target\n');
  plugin.failSaveFromCall = 2;
  vault.processHook = (file, _content, call) => {
    if (file.path === 'Target.md' && call === 1) vault.readErrors.set('Target.md', new Error('target temporarily unreadable'));
  };

  await assert.rejects(
    service.move({ editor: editor as never, sourcePath: 'Source.md', targetPath: 'Target.md', sourceLine: 0 }),
    (error: unknown) => error instanceof TaskMoveRecoveryError && /reconciliation/u.test(error.message),
  );

  assert.equal(vault.get('Target.md')?.includes('task-manager-move:'), true);
  assert.equal((await journals(store)).length, 1);
  assert.equal(editor.content, '- [ ] Move me\n');
});

test('a committed target with its marker stripped remains recoverable when phase persistence fails', async () => {
  const { vault, plugin, store, editor, service } = harness('- [ ] Move me\n', '# Target\n');
  plugin.failSaveFromCall = 2;
  vault.processHook = (file, _content, call) => {
    if (file.path === 'Target.md' && call === 1) vault.readOverrides.set('Target.md', '# Target\n- [ ] Move me\n');
  };

  await assert.rejects(
    service.move({ editor: editor as never, sourcePath: 'Source.md', targetPath: 'Target.md', sourceLine: 0 }),
    TaskMoveRecoveryError,
  );

  assert.equal((await journals(store)).length, 1);
  assert.equal(editor.content, '- [ ] Move me\n');
  assert.equal(vault.get('Target.md')?.includes('task-manager-move:'), true);
});

test('source full-block conflict rolls back only the marker-associated target insertion', async () => {
  const source = '- [ ] Same text\n  continuation\n';
  const { vault, store, editor, service } = harness(source, '- [ ] Same text\n  continuation\n');
  const originalTarget = vault.get('Target.md');
  vault.processHook = (_file, _content, call) => {
    if (call === 1) editor.content = '- [ ] Same text\n  changed continuation\n';
  };

  await assert.rejects(
    service.move({ editor: editor as never, sourcePath: 'Source.md', targetPath: 'Target.md', sourceLine: 0 }),
    (error: unknown) => error instanceof TaskMoveConflictError,
  );

  assert.equal(vault.get('Target.md'), originalTarget, 'identical preexisting target text must remain');
  assert.equal(editor.replaceCalls, 0);
  assert.deepEqual(await journals(store), []);
});

test('whole-source CAS rejects unrelated source edits during the destination write', async () => {
  const source = '- [ ] Move me\n- [ ] Keep\n';
  const { vault, store, editor, service } = harness(source, '# Target\n');
  vault.processHook = (_file, _content, call) => {
    if (call === 1) editor.content = '- [ ] Move me\n- [ ] Keep edited\n';
  };

  await assert.rejects(
    service.move({ editor: editor as never, sourcePath: 'Source.md', targetPath: 'Target.md', sourceLine: 0 }),
    TaskMoveConflictError,
  );

  assert.equal(vault.get('Source.md'), source);
  assert.equal(vault.get('Target.md'), '# Target\n');
  assert.equal(editor.content, '- [ ] Move me\n- [ ] Keep edited\n');
  assert.deepEqual(await journals(store), []);
});

test('rollback failure retains a reconciliation-required journal and throws recovery details', async () => {
  const { vault, store, editor, service } = harness('- [ ] Move me\n', '# Target\n');
  vault.processHook = (_file, _content, call) => {
    if (call === 1) editor.content = '- [ ] Changed\n';
    if (call === 2) throw new Error('rollback unavailable');
  };

  await assert.rejects(
    service.move({ editor: editor as never, sourcePath: 'Source.md', targetPath: 'Target.md', sourceLine: 0 }),
    (error: unknown) => error instanceof TaskMoveRecoveryError
      && error.sourcePath === 'Source.md'
      && error.targetPath === 'Target.md'
      && Boolean(error.operationId),
  );

  const pending = await journals(store);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].phase, 'reconciliation-required');
  assert.match(pending[0].diagnostic ?? '', /rollback unavailable/u);
  assert.equal(vault.get('Target.md')?.includes(pending[0].marker), true);
});

test('restart reconciliation rolls back a marked target when source is still present', async () => {
  const { vault, store, editor, service } = harness('- [ ] Move me\n', '# Target\n');
  vault.processHook = (_file, _content, call) => {
    if (call === 1) editor.content = '- [ ] Changed in editor only\n';
    if (call === 2) throw new Error('temporary rollback failure');
  };
  await assert.rejects(service.move({ editor: editor as never, sourcePath: 'Source.md', targetPath: 'Target.md', sourceLine: 0 }), TaskMoveRecoveryError);
  vault.processHook = null;

  const results = await new TaskMoveService({ vault } as never, store).reconcilePendingMoves();

  assert.deepEqual(results.map((result) => result.outcome), ['rolled-back']);
  assert.equal(vault.get('Target.md'), '# Target\n');
  assert.deepEqual(await journals(store), []);
});

test('restart reconciliation completes marker cleanup when source is absent', async () => {
  const { vault, store, editor, service } = harness('- [ ] Move me\n', '# Target\n');
  vault.processHook = (_file, _content, call) => {
    if (call === 3) throw new Error('marker cleanup unavailable');
  };
  await assert.rejects(service.move({ editor: editor as never, sourcePath: 'Source.md', targetPath: 'Target.md', sourceLine: 0 }), TaskMoveRecoveryError);
  assert.equal(editor.content, '');
  vault.set('Source.md', '');
  vault.processHook = null;

  const results = await new TaskMoveService({ vault } as never, store).reconcilePendingMoves();

  assert.deepEqual(results.map((result) => result.outcome), ['completed']);
  assert.equal(vault.get('Target.md'), '# Target\n- [ ] Move me\n');
  assert.deepEqual(await journals(store), []);
});

test('restart reconciliation does not mistake an edited source task for a completed move', async () => {
  const { vault, store, editor, service } = harness('- [ ] Move me\n', '# Target\n');
  vault.processHook = (_file, _content, call) => {
    if (call === 1) editor.content = '- [ ] Edited task\n';
    if (call === 2) throw new Error('rollback unavailable');
  };
  await assert.rejects(service.move({ editor: editor as never, sourcePath: 'Source.md', targetPath: 'Target.md', sourceLine: 0 }), TaskMoveRecoveryError);
  vault.set('Source.md', '- [ ] Edited task\n');
  vault.processHook = null;

  const results = await new TaskMoveService({ vault } as never, store).reconcilePendingMoves();

  assert.equal(results[0].outcome, 'pending');
  assert.match(results[0].diagnostic ?? '', /source=ambiguous/u);
  assert.equal((await journals(store)).length, 1);
});

test('restart reconciliation retains proof when the source task was edited and relocated', async () => {
  const { vault, store, editor, service } = harness('- [ ] Move me\nKeep\n', '# Target\n');
  vault.processHook = (_file, _content, call) => {
    if (call === 1) editor.content = 'Original line replaced\n- [ ] Move me edited\nKeep\n';
    if (call === 2) throw new Error('rollback unavailable');
  };
  await assert.rejects(service.move({ editor: editor as never, sourcePath: 'Source.md', targetPath: 'Target.md', sourceLine: 0 }), TaskMoveRecoveryError);
  vault.set('Source.md', 'Original line replaced\n- [ ] Move me edited\nKeep\n');
  vault.processHook = null;

  const results = await new TaskMoveService({ vault } as never, store).reconcilePendingMoves();

  assert.equal(results[0].outcome, 'pending');
  assert.match(results[0].diagnostic ?? '', /source=ambiguous/u);
  assert.equal((await journals(store)).length, 1);
  assert.equal(vault.get('Target.md')?.includes('task-manager-move:'), true);
});

test('restart reconciliation does not treat an identical block at another source line as the moved source', async () => {
  const { vault, store, editor, service } = harness('- [ ] Move me\n', '# Target\n');
  vault.processHook = (_file, _content, call) => {
    if (call === 1) editor.content = '- [ ] Changed\n';
    if (call === 2) throw new Error('rollback unavailable');
  };
  await assert.rejects(service.move({ editor: editor as never, sourcePath: 'Source.md', targetPath: 'Target.md', sourceLine: 0 }), TaskMoveRecoveryError);
  vault.set('Source.md', 'Different first line\n- [ ] Move me\n');
  vault.processHook = null;

  const results = await new TaskMoveService({ vault } as never, store).reconcilePendingMoves();

  assert.equal(results[0].outcome, 'pending');
  assert.match(results[0].diagnostic ?? '', /source=ambiguous/u);
  assert.equal(vault.get('Target.md')?.includes('task-manager-move:'), true);
});

test('restart reconciliation clears prepared and post-cleanup journal crash boundaries', async () => {
  const prepared = harness('- [ ] Move me\n', '# Target\n');
  prepared.vault.processHook = (_file, _content, call) => {
    if (call === 1) prepared.editor.content = '- [ ] Changed\n';
    if (call === 2) throw new Error('rollback unavailable');
  };
  await assert.rejects(prepared.service.move({ editor: prepared.editor as never, sourcePath: 'Source.md', targetPath: 'Target.md', sourceLine: 0 }), TaskMoveRecoveryError);
  const preparedJournal = (await journals(prepared.store))[0];
  prepared.plugin.data.state = { ...(prepared.plugin.data.state ?? {}), taskMoveJournals: [{ ...preparedJournal, phase: 'prepared' }] };
  prepared.vault.set('Target.md', '# Target\n');
  prepared.vault.processHook = null;
  const preparedResults = await new TaskMoveService({ vault: prepared.vault } as never, prepared.store).reconcilePendingMoves();
  assert.equal(preparedResults[0].outcome, 'rolled-back');
  assert.deepEqual(await journals(prepared.store), []);

  const completed = harness('- [ ] Move me\n', '# Target\n');
  completed.vault.processHook = (_file, _content, call) => {
    if (call === 3) throw new Error('marker cleanup unavailable');
  };
  await assert.rejects(completed.service.move({ editor: completed.editor as never, sourcePath: 'Source.md', targetPath: 'Target.md', sourceLine: 0 }), TaskMoveRecoveryError);
  const completedJournal = (await journals(completed.store))[0];
  completed.vault.set('Source.md', '');
  completed.vault.set('Target.md', '# Target\n- [ ] Move me\n');
  completed.plugin.data.state = { ...(completed.plugin.data.state ?? {}), taskMoveJournals: [{ ...completedJournal, phase: 'source-removed' }] };
  completed.vault.processHook = null;
  const completedResults = await new TaskMoveService({ vault: completed.vault } as never, completed.store).reconcilePendingMoves();
  assert.equal(completedResults[0].outcome, 'completed');
  assert.deepEqual(await journals(completed.store), []);
});

test('legacy move journals never infer completion from source-block absence', async () => {
  const h = harness('- [ ] Move me\n', '# Target\n');
  h.vault.processHook = (_file, _content, call) => {
    if (call === 3) throw new Error('marker cleanup unavailable');
  };
  await assert.rejects(h.service.move({ editor: h.editor as never, sourcePath: 'Source.md', targetPath: 'Target.md', sourceLine: 0 }), TaskMoveRecoveryError);
  const hashed = (await journals(h.store))[0];
  const { sourceOriginalHash: _original, sourceFinalizedHash: _finalized, ...legacy } = hashed;
  await h.store.updateState((state) => ({ ...state, taskMoveJournals: [legacy] }));
  h.vault.processHook = null;

  const results = await new TaskMoveService({ vault: h.vault } as never, h.store).reconcilePendingMoves();

  assert.equal(results[0].outcome, 'pending');
  assert.match(results[0].diagnostic ?? '', /source=ambiguous/u);
  assert.equal((await journals(h.store)).length, 1);
  assert.equal(h.vault.get('Target.md')?.includes('task-manager-move:'), true);
});

test('source-removed reconciliation stays pending when destination proof is missing or source also remains', async () => {
  const missingTarget = harness('- [ ] Move me\n', '# Target\n');
  missingTarget.vault.processHook = (_file, _content, call) => {
    if (call === 3) throw new Error('marker cleanup unavailable');
  };
  await assert.rejects(missingTarget.service.move({ editor: missingTarget.editor as never, sourcePath: 'Source.md', targetPath: 'Target.md', sourceLine: 0 }), TaskMoveRecoveryError);
  missingTarget.vault.set('Source.md', '');
  missingTarget.vault.files.delete('Target.md');
  missingTarget.vault.processHook = null;
  const missingResults = await new TaskMoveService({ vault: missingTarget.vault } as never, missingTarget.store).reconcilePendingMoves();
  assert.equal(missingResults[0].outcome, 'pending');
  assert.equal((await journals(missingTarget.store)).length, 1);

  const duplicateEvidence = harness('- [ ] Move me\n', '# Target\n');
  duplicateEvidence.vault.processHook = (_file, _content, call) => {
    if (call === 3) throw new Error('marker cleanup unavailable');
  };
  await assert.rejects(duplicateEvidence.service.move({ editor: duplicateEvidence.editor as never, sourcePath: 'Source.md', targetPath: 'Target.md', sourceLine: 0 }), TaskMoveRecoveryError);
  const pending = (await journals(duplicateEvidence.store))[0];
  duplicateEvidence.vault.set('Source.md', '- [ ] Move me\n');
  duplicateEvidence.vault.set('Target.md', '# Target\n- [ ] Move me\n');
  duplicateEvidence.plugin.data.state = { ...(duplicateEvidence.plugin.data.state ?? {}), taskMoveJournals: [{ ...pending, phase: 'source-removed' }] };
  duplicateEvidence.vault.processHook = null;
  const duplicateResults = await new TaskMoveService({ vault: duplicateEvidence.vault } as never, duplicateEvidence.store).reconcilePendingMoves();
  assert.equal(duplicateResults[0].outcome, 'pending');
  assert.match(duplicateResults[0].diagnostic ?? '', /target=unmarked/u);
});

test('recovery does not declare rollback when an edited unmarked destination may remain', async () => {
  const { vault, store, editor, service } = harness('- [ ] Move me\n', '# Target\n');
  vault.processHook = (_file, _content, call) => {
    if (call === 1) editor.content = '- [ ] Changed\n';
    if (call === 2) throw new Error('rollback unavailable');
  };
  await assert.rejects(service.move({ editor: editor as never, sourcePath: 'Source.md', targetPath: 'Target.md', sourceLine: 0 }), TaskMoveRecoveryError);
  vault.set('Target.md', '# Target\n- [ ] Move me edited\n');
  vault.processHook = null;

  const results = await new TaskMoveService({ vault } as never, store).reconcilePendingMoves();

  assert.equal(results[0].outcome, 'pending');
  assert.match(results[0].diagnostic ?? '', /target=ambiguous/u);
  assert.equal((await journals(store)).length, 1);
});

test('restart reconciliation clears a recovery journal when the marker is missing and source remains', async () => {
  const { vault, store, editor, service } = harness('- [ ] Move me\n', '# Target\n');
  vault.processHook = (_file, _content, call) => {
    if (call === 1) editor.content = '- [ ] Changed\n';
    if (call === 2) throw new Error('rollback unavailable');
  };
  await assert.rejects(service.move({ editor: editor as never, sourcePath: 'Source.md', targetPath: 'Target.md', sourceLine: 0 }), TaskMoveRecoveryError);
  vault.set('Target.md', '# Target\n');
  vault.processHook = null;

  const results = await new TaskMoveService({ vault } as never, store).reconcilePendingMoves();

  assert.equal(results[0].outcome, 'rolled-back');
  assert.deepEqual(await journals(store), []);
});

test('reconciliation persistence failures remain pending and do not escape to abort startup', async () => {
  const { vault, plugin, store, editor, service } = harness('- [ ] Move me\n', '# Target\n');
  vault.processHook = (_file, _content, call) => {
    if (call === 1) editor.content = '- [ ] Changed\n';
    if (call === 2) throw new Error('rollback unavailable');
  };
  await assert.rejects(service.move({ editor: editor as never, sourcePath: 'Source.md', targetPath: 'Target.md', sourceLine: 0 }), TaskMoveRecoveryError);
  vault.set('Target.md', '# Target\n');
  vault.processHook = null;
  plugin.saveError = new Error('state unavailable');

  const originalError = console.error;
  console.error = () => undefined;
  try {
    const results = await new TaskMoveService({ vault } as never, store).reconcilePendingMoves();
    assert.equal(results[0].outcome, 'pending');
    assert.match(results[0].diagnostic ?? '', /recovery state could not be saved: state unavailable/u);
  } finally {
    console.error = originalError;
  }
});

test('move validates paths and file-folder collisions before writing', async () => {
  const { vault, editor, service } = harness();
  vault.folders.set('Folder.md', folderForPath('Folder.md'));
  const invalid = ['/absolute.md', '../escape.md', 'Folder.md'];
  for (const targetPath of invalid) {
    await assert.rejects(service.move({ editor: editor as never, sourcePath: 'Source.md', targetPath, sourceLine: 0 }));
  }
  assert.equal(vault.processCalls, 0);
});

test('degraded indexes cannot authorize an explicit-ID move', async () => {
  const source = '- [ ] Move [id:: unique]\n';
  const task = parseMarkdownTaskLine(source.trimEnd(), 'Source.md', 1);
  assert.ok(task);
  if (!task) return;
  const index = new TaskIndex();
  index.beginHydration();
  index.commit(new Map([['Source.md', [task]]]));
  index.markReady(true);
  const { vault, store, editor } = harness(source);
  const service = new TaskMoveService({ vault } as never, store, (id) => {
    if (index.getSnapshot().readiness !== 'ready') throw new Error(`index degraded for ${id}`);
  });

  await assert.rejects(service.move({ editor: editor as never, sourcePath: 'Source.md', targetPath: 'Target.md', sourceLine: 0 }), /index degraded for unique/u);
  assert.equal(vault.processCalls, 0);
  assert.deepEqual(await journals(store), []);
});

test('StateStore accepts only normalized exact-schema move journals', async () => {
  const operationId = '12345678-abcd';
  const marker = `<!-- task-manager-move:${operationId} -->`;
  const valid: TaskMoveJournal = {
    operationId,
    sourcePath: 'Source.md',
    targetPath: 'Target.md',
    sourceLine: 0,
    targetInsertionOffset: 0,
    targetOriginalHash: '811c9dc55fb1232a',
    sourceOriginalHash: '1111111111111111',
    sourceFinalizedHash: '2222222222222222',
    targetCreated: false,
    block: '- [ ] Move me\n',
    marker,
    markerLine: `${marker}\n`,
    insertionPrefix: '',
    insertionSuffix: '',
    targetHeading: '',
    phase: 'prepared',
    createdAtIso: '2026-07-11T00:00:00.000Z',
  };
  const plugin = new MemoryPlugin();
  plugin.data = { state: {
    version: 2,
    snapshot: [],
    completions: [],
    taskMoveJournals: [
      valid,
      {
        ...valid,
        operationId: 'legacy12-abcd',
        marker: '<!-- task-manager-move:legacy12-abcd -->',
        markerLine: '<!-- task-manager-move:legacy12-abcd -->\n',
        sourceOriginalHash: undefined,
        sourceFinalizedHash: undefined,
      },
      { ...valid, operationId: 'onesided-abcd', marker: '<!-- task-manager-move:onesided-abcd -->', markerLine: '<!-- task-manager-move:onesided-abcd -->\n', sourceFinalizedHash: undefined },
      { ...valid, operationId: 'malformed-abcd', marker: '<!-- task-manager-move:malformed-abcd -->', markerLine: '<!-- task-manager-move:malformed-abcd -->\n', sourceOriginalHash: 'not-a-hash' },
      { ...valid, operationId: 'bad', marker: '<!-- broad marker -->', markerLine: '<!-- broad marker -->\n' },
      { ...valid, operationId: '87654321-abcd', sourcePath: '../escape.md', marker: '<!-- task-manager-move:87654321-abcd -->', markerLine: '<!-- task-manager-move:87654321-abcd -->\n' },
      { ...valid, operationId: '99999999-abcd', block: '', marker: '<!-- task-manager-move:99999999-abcd -->', markerLine: '<!-- task-manager-move:99999999-abcd -->\n' },
    ],
  } };

  const legacy = { ...valid, operationId: 'legacy12-abcd', marker: '<!-- task-manager-move:legacy12-abcd -->', markerLine: '<!-- task-manager-move:legacy12-abcd -->\n' };
  delete legacy.sourceOriginalHash;
  delete legacy.sourceFinalizedHash;
  assert.deepEqual((await new StateStore(plugin as never).loadState()).taskMoveJournals, [valid, legacy]);
});

test('duplicate explicit ID guard rejects before target write or journal persistence', async () => {
  const source = '- [ ] Move [id:: duplicate]\n';
  const { vault, store, editor } = harness(source);
  const service = new TaskMoveService({ vault } as never, store, (id) => { throw new Error(`ambiguous ${id}`); });

  await assert.rejects(service.move({ editor: editor as never, sourcePath: 'Source.md', targetPath: 'Target.md', sourceLine: 0 }), /ambiguous duplicate/u);

  assert.equal(vault.processCalls, 0);
  assert.deepEqual(await journals(store), []);
});
