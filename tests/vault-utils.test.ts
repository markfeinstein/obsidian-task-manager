import test from 'node:test';
import assert from 'node:assert/strict';
import { TFile } from 'obsidian';
import { ensureParentFolders, normalizeVaultRelativePath } from '../src/vault-utils';

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

function folder(path: string): { path: string } {
  return { path };
}

test('normalizeVaultRelativePath accepts nested paths and rejects traversal/absolute paths', () => {
  assert.equal(normalizeVaultRelativePath('Folder\\Sub/Task.md'), 'Folder/Sub/Task.md');
  for (const unsafe of ['/absolute.md', '../escape.md', 'A/../../escape.md', 'C:\\escape.md', '\\\\server\\share.md', 'A/./B.md', 'A\0B.md']) {
    assert.throws(() => normalizeVaultRelativePath(unsafe), /relative to the vault root|must not contain/u);
  }
});

test('ensureParentFolders creates each missing parent segment', async () => {
  const folders = new Set<string>();
  const created: string[] = [];
  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => folders.has(path) ? folder(path) : null,
      createFolder: async (path: string) => { folders.add(path); created.push(path); },
    },
  };

  await ensureParentFolders(app as never, 'A/B/C.md');

  assert.deepEqual(created, ['A', 'A/B']);
});

test('ensureParentFolders reuses existing parents and handles create races', async () => {
  const folders = new Set<string>(['A']);
  const created: string[] = [];
  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => folders.has(path) ? folder(path) : null,
      createFolder: async (path: string) => {
        created.push(path);
        folders.add(path);
        throw new Error('created concurrently after lookup');
      },
    },
  };

  await ensureParentFolders(app as never, 'A/B/C.md');

  assert.deepEqual(created, ['A/B']);
});

test('ensureParentFolders rejects parent path file collisions', async () => {
  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => path === 'A' ? new TestFile('A') : null,
      createFolder: async () => { throw new Error('should not create below a file'); },
    },
  };

  await assert.rejects(
    () => ensureParentFolders(app as never, 'A/B/C.md'),
    /a file already exists/u,
  );
});
