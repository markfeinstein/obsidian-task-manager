import test from 'node:test';
import assert from 'node:assert/strict';
import { SuggestModal } from 'obsidian';
import { ProjectWorkspaceCreateModal, QuickFindTaskModal } from '../src/modals/simple-modals';
import { DEFAULT_SETTINGS } from '../src/types';
import { FakeDOMElement } from './test-utils';

test('QuickFindTaskModal clears stale tasks before rescanning the vault', async () => {
  const file = { path: 'Projects/todo.md', basename: 'todo', extension: 'md' } as any;
  const scanner = {
    async scanFile() {
      return [{ normalizedText: 'Open task', filePath: file.path, lineNumber: 1, tags: [], checkbox: ' ' } as any];
    },
  } as any;
  const app = {
    vault: {
      getMarkdownFiles: () => [file],
    },
  } as any;
  const settings = {
    ...DEFAULT_SETTINGS,
    excludedFolders: [],
  };

  const originalOnOpen = (SuggestModal.prototype as any).onOpen;
  (SuggestModal.prototype as any).onOpen = () => {};
  try {
    const modal = new QuickFindTaskModal(app, scanner, settings);
    (modal as any).app = app;
    await modal.onOpen();
    assert.equal(modal.getSuggestions('').length, 1);

    await modal.onOpen();
    assert.equal(modal.getSuggestions('').length, 1, 'reopening should not duplicate previously scanned tasks');
  } finally {
    (SuggestModal.prototype as any).onOpen = originalOnOpen;
  }
});

test('ProjectWorkspaceCreateModal uses the shared modal surface class', () => {
  const modal = new ProjectWorkspaceCreateModal({} as never, async () => undefined);
  const contentEl = new FakeDOMElement('div');
  (modal as unknown as { contentEl: HTMLElement }).contentEl = contentEl as unknown as HTMLElement;
  modal.onOpen();
  assert.equal(contentEl.classes.includes('task-manager-modal'), true);
  assert.ok(contentEl.querySelector('.project-workspace-name-input'));
  assert.ok(contentEl.querySelector('.project-workspace-folder-input'));
});

test('QuickFindTaskModal respects excluded folders even when settings are not normalized', async () => {
  const includedFile = { path: 'Notes/other.md', basename: 'other', extension: 'md' } as any;
  const excludedFile = { path: 'Projects/todo.md', basename: 'todo', extension: 'md' } as any;
  const scanner = {
    async scanFile(file: any) {
      return [{ normalizedText: `Task from ${file.path}`, filePath: file.path, lineNumber: 1, tags: [], checkbox: ' ' } as any];
    },
  } as any;
  const app = {
    vault: {
      getMarkdownFiles: () => [excludedFile, includedFile],
    },
  } as any;
  const settings = {
    ...DEFAULT_SETTINGS,
    excludedFolders: [' /Projects/ '],
  };

  const originalOnOpen = (SuggestModal.prototype as any).onOpen;
  (SuggestModal.prototype as any).onOpen = () => {};
  try {
    const modal = new QuickFindTaskModal(app, scanner, settings);
    (modal as any).app = app;
    await modal.onOpen();
    assert.deepEqual(modal.getSuggestions('').map((task) => task.filePath), ['Notes/other.md']);
  } finally {
    (SuggestModal.prototype as any).onOpen = originalOnOpen;
  }
});
