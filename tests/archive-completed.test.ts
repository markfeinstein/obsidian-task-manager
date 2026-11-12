import test from 'node:test';
import assert from 'node:assert/strict';
import { Notice, TFile } from 'obsidian';
import TaskManagerPlugin from '../src/main';
import { TaskScanner } from '../src/task-scanner';
import { normalizeTaskManagerSettings } from '../src/types';
import { StateStore } from '../src/state-store';

function fakeFile(path: string): TFile {
  return Object.assign(Object.create(TFile.prototype) as TFile, {
    path,
    name: path.split('/').pop() ?? path,
    extension: 'md',
    basename: path.replace(/\.md$/u, ''),
  });
}

interface StubVaultOptions {
  failPath?: string;
}

function makeVault(initial: Record<string, string>, opts: StubVaultOptions = {}) {
  const files = new Map<string, string>(Object.entries(initial));
  const vault = {
    files,
    read(file: { path: string }): Promise<string> {
      return Promise.resolve(files.get(file.path) ?? '');
    },
    getAbstractFileByPath(path: string): TFile | null {
      return files.has(path) ? fakeFile(path) : null;
    },
    create(path: string, content: string): Promise<TFile> {
      if (opts.failPath === path) return Promise.reject(new Error(`create failed for ${path}`));
      files.set(path, content);
      return Promise.resolve(fakeFile(path));
    },
    process(file: { path: string }, fn: (content: string) => string): Promise<string> {
      if (opts.failPath === file.path) return Promise.reject(new Error(`process failed for ${file.path}`));
      const updated = fn(files.get(file.path) ?? '');
      files.set(file.path, updated);
      return Promise.resolve(updated);
    },
    createFolder(): Promise<void> {
      return Promise.resolve();
    },
  };
  return vault;
}

interface ArchiveTestPlugin {
  settings: unknown;
  app: unknown;
  scanner: unknown;
  stateStore: StateStore;
  archiveCompletedTasksInFile(file: TFile): Promise<void>;
}

function makePlugin(vault: ReturnType<typeof makeVault>, archiveFilePath: string): ArchiveTestPlugin {
  const plugin = Object.create(TaskManagerPlugin.prototype) as unknown as ArchiveTestPlugin;
  plugin.settings = normalizeTaskManagerSettings({ archiveFilePath });
  plugin.app = { vault };
  plugin.scanner = new TaskScanner({} as never);
  let data: unknown;
  plugin.stateStore = new StateStore({ loadData: async () => data, saveData: async (next: unknown) => { data = next; } } as never);
  return plugin;
}

const SOURCE = '# Notes\n- [ ] Open task\n- [x] Done task\n';

test('archiveCompletedTasksInFile keeps the source intact when the archive write fails', async () => {
  const vault = makeVault({ 'Notes.md': SOURCE }, { failPath: 'Archive.md' });
  const plugin = makePlugin(vault, 'Archive.md');

  await assert.rejects(() => plugin.archiveCompletedTasksInFile(fakeFile('Notes.md')));

  // The completed task must NOT be lost: the source file is unchanged because the
  // archive write failed before any source mutation.
  assert.equal(vault.files.get('Notes.md'), SOURCE);
  assert.equal(vault.files.has('Archive.md'), false);
});

test('archiveCompletedTasksInFile moves completed tasks to the archive on success', async () => {
  const vault = makeVault({ 'Notes.md': SOURCE });
  const plugin = makePlugin(vault, 'Archive.md');

  await plugin.archiveCompletedTasksInFile(fakeFile('Notes.md'));

  const remaining = vault.files.get('Notes.md') ?? '';
  assert.ok(remaining.includes('- [ ] Open task'), 'open task is retained in the source');
  assert.ok(!remaining.includes('Done task'), 'completed task is removed from the source');

  const archive = vault.files.get('Archive.md') ?? '';
  assert.ok(archive.includes('- [x] Done task'), 'completed task is written to the archive');
});

test('archiveCompletedTasksInFile counts completed roots rather than serialized child lines', async () => {
  const source = '- [x] Parent\n  - child note\n  - [ ] Child task\n';
  const vault = makeVault({ 'Notes.md': source });
  const plugin = makePlugin(vault, 'Archive.md');
  const messages = (Notice as unknown as { messages: string[] }).messages;
  messages.length = 0;

  await plugin.archiveCompletedTasksInFile(fakeFile('Notes.md'));

  assert.match(vault.files.get('Archive.md') ?? '', /child note/u);
  assert.match(messages.at(-1) ?? '', /archived 1 completed task/u);
});

test('archiveCompletedTasksInFile normalizes separators and rejects traversal before writes', async () => {
  const normalizedVault = makeVault({ 'Notes.md': SOURCE });
  const normalizedPlugin = makePlugin(normalizedVault, 'History\\Archive.md');
  await normalizedPlugin.archiveCompletedTasksInFile(fakeFile('Notes.md'));
  assert.equal(normalizedVault.files.has('History/Archive.md'), true);
  assert.equal(normalizedVault.files.has('History\\Archive.md'), false);

  const sameFileVault = makeVault({ 'Notes.md': SOURCE });
  const sameFilePlugin = makePlugin(sameFileVault, 'Notes.md');
  await assert.rejects(() => sameFilePlugin.archiveCompletedTasksInFile(fakeFile('Notes.md')), /different from the source/u);
  assert.equal(sameFileVault.files.get('Notes.md'), SOURCE);

  const unsafeVault = makeVault({ 'Notes.md': SOURCE });
  const unsafePlugin = makePlugin(unsafeVault, '../Archive.md');
  await assert.rejects(() => unsafePlugin.archiveCompletedTasksInFile(fakeFile('Notes.md')), /must not contain/u);
  assert.equal(unsafeVault.files.get('Notes.md'), SOURCE);
  assert.equal(unsafeVault.files.size, 1);
});

test('archiveCompletedTasksInFile leaves the source unchanged when there are no completed tasks', async () => {
  const openOnly = '# Notes\n- [ ] Open task\n';
  const vault = makeVault({ 'Notes.md': openOnly });
  const plugin = makePlugin(vault, 'Archive.md');

  await plugin.archiveCompletedTasksInFile(fakeFile('Notes.md'));

  assert.equal(vault.files.get('Notes.md'), openOnly);
  assert.equal(vault.files.has('Archive.md'), false);
});
