import test from 'node:test';
import assert from 'node:assert/strict';
import { legacyTaskKeyForBody, parseMarkdownTaskLine } from '../src/task-model';
import { scanFileAsTask } from '../src/task-scanner';
import { DEFAULT_SETTINGS, DEFAULT_TASK_STATES } from '../src/types';
import TaskManagerPlugin from '../src/main';

function fakeFile(path: string): any {
  const parts = path.split('/');
  return {
    path,
    name: parts[parts.length - 1],
    basename: parts[parts.length - 1].replace(/\.md$/u, ''),
    extension: 'md',
    parent: parts.length > 1 ? { path: parts.slice(0, -1).join('/') } : null,
  };
}

function fakeApp(frontmatter?: Record<string, unknown>): any {
  return {
    metadataCache: {
      getFileCache: () => ({ frontmatter: frontmatter ?? {} }),
    },
  };
}

test('inline tasks with IDs use a vault-wide ID-anchored key', () => {
  const task = parseMarkdownTaskLine('- [ ] Rename me 🆔 abc123 📅 2026-05-29', 'Projects/A.md', 1);
  assert.ok(task);
  assert.equal(task.key, 'id:abc123');
  assert.equal(task.stableKey, 'id:abc123');
});

test('ID-anchored key survives description edits and cross-file moves', () => {
  const before = parseMarkdownTaskLine('- [ ] Old description 🆔 abc123', 'Projects/A.md', 1);
  const edited = parseMarkdownTaskLine('- [ ] New description with #tag 🆔 abc123 📅 2026-06-01', 'Projects/A.md', 1);
  const moved = parseMarkdownTaskLine('- [ ] New description with #tag 🆔 abc123 📅 2026-06-01', 'Archive/B.md', 9);
  assert.ok(before);
  assert.ok(edited);
  assert.ok(moved);
  assert.equal(before.key, edited.key);
  assert.equal(edited.key, moved.key);
  assert.equal(moved.key, 'id:abc123');
});

test('tasks without IDs keep legacy normalized-text keys', () => {
  const task = parseMarkdownTaskLine('- [ ] Fix bug #work 📅 2026-05-29', 'Projects/A.md', 1);
  assert.ok(task);
  assert.equal(task.key, legacyTaskKeyForBody('Projects/A.md', 'Fix bug #work 📅 2026-05-29'));
  assert.equal(task.stableKey, undefined);
});

test('file-backed task notes with IDs use vault-wide ID-anchored keys', () => {
  const task = scanFileAsTask(fakeFile('Tasks/File Task.md'), fakeApp({ task: true, id: 'file-123', description: 'File task' }), DEFAULT_TASK_STATES);
  const moved = scanFileAsTask(fakeFile('Archive/File Task.md'), fakeApp({ task: true, id: 'file-123', description: 'File task' }), DEFAULT_TASK_STATES);
  assert.ok(task);
  assert.ok(moved);
  assert.equal(task.key, 'id:file-123');
  assert.equal(task.stableKey, 'id:file-123');
  assert.equal(moved.key, task.key);
});

test('file-backed task notes without IDs keep basename keys for compatibility', () => {
  const task = scanFileAsTask(fakeFile('Tasks/File Task.md'), fakeApp({ task: true, description: 'File task' }), DEFAULT_TASK_STATES);
  assert.ok(task);
  assert.equal(task.key, 'Tasks/File Task.md:File Task');
});

test('durable identity migration handles legacy duplicate occurrence keys by line number', () => {
  const task = parseMarkdownTaskLine('- [ ] Same 🆔 task-2', 'Project.md', 2);
  assert.ok(task);
  const legacyBase = legacyTaskKeyForBody('Project.md', 'Same');
  const firstLegacy = `${legacyBase}\u00001`;
  const secondLegacy = `${legacyBase}\u00002`;
  const plugin = Object.create(TaskManagerPlugin.prototype) as any;
  plugin.settings = DEFAULT_SETTINGS;
  plugin.snapshot = new Map([
    [firstLegacy, { key: firstLegacy, status: 'todo', filePath: 'Project.md', lineNumber: 1 }],
    [secondLegacy, { key: secondLegacy, status: 'todo', filePath: 'Project.md', lineNumber: 2 }],
  ]);
  plugin.completions = [{
    taskKey: secondLegacy,
    sourcePath: 'Project.md',
    dailyNotePath: 'Daily.md',
    completedAtIso: '2026-05-28T12:00:00.000Z',
    logLineHash: 'hash',
  }];
  plugin.recurrenceCounts = { [firstLegacy]: 1, [secondLegacy]: 2 };

  plugin.migrateDurableIdentityKeys([task]);

  assert.equal(plugin.snapshot.has(firstLegacy), true);
  assert.equal(plugin.snapshot.has(secondLegacy), false);
  assert.equal(plugin.snapshot.get(task.key)?.lineNumber, 2);
  assert.equal(plugin.completions[0].taskKey, task.key);
  assert.equal(plugin.recurrenceCounts[firstLegacy], 1);
  assert.equal(plugin.recurrenceCounts[secondLegacy], undefined);
  assert.equal(plugin.recurrenceCounts[task.key], 2);
});

test('durable identity migration ignores completion-only duplicate keys for other lines', () => {
  const task = parseMarkdownTaskLine('- [ ] Same 🆔 task-2', 'Project.md', 2);
  assert.ok(task);
  const legacyBase = legacyTaskKeyForBody('Project.md', 'Same');
  const firstLegacy = `${legacyBase}\u00001`;
  const secondLegacy = `${legacyBase}\u00002`;
  const plugin = Object.create(TaskManagerPlugin.prototype) as any;
  plugin.settings = DEFAULT_SETTINGS;
  plugin.snapshot = new Map([
    [firstLegacy, { key: firstLegacy, status: 'done', filePath: 'Project.md', lineNumber: 1 }],
    [secondLegacy, { key: secondLegacy, status: 'todo', filePath: 'Project.md', lineNumber: 2 }],
  ]);
  plugin.completions = [{
    taskKey: firstLegacy,
    sourcePath: 'Project.md',
    dailyNotePath: 'Daily.md',
    completedAtIso: '2026-05-28T12:00:00.000Z',
    logLineHash: 'hash-first',
  }];
  plugin.recurrenceCounts = { [firstLegacy]: 7, [secondLegacy]: 2 };

  plugin.migrateDurableIdentityKeys([task]);

  assert.equal(plugin.snapshot.has(firstLegacy), true);
  assert.equal(plugin.snapshot.get(firstLegacy)?.lineNumber, 1);
  assert.equal(plugin.snapshot.has(secondLegacy), false);
  assert.equal(plugin.snapshot.get(task.key)?.lineNumber, 2);
  assert.equal(plugin.completions[0].taskKey, firstLegacy);
  assert.equal(plugin.recurrenceCounts[firstLegacy], 7);
  assert.equal(plugin.recurrenceCounts[secondLegacy], undefined);
  assert.equal(plugin.recurrenceCounts[task.key], 2);
});
