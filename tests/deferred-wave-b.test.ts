import test from 'node:test';
import assert from 'node:assert/strict';
import { TFile, TFolder } from 'obsidian';
import TaskManagerPlugin from '../src/main';
import { generateBasesExportFiles, generateBasesTaskNote, generateBasesViewFiles, isGeneratedBasesFileContent, isOwnedGeneratedBasesFile } from '../src/bases-integration';
import { moveKanbanCardLine, parseKanbanMarkdown, generateKanbanMarkdown } from '../src/kanban-board';
import { buildRollups } from '../src/table-renderer';
import { filterTasks, parseTaskQuery } from '../src/task-query';
import { DEFAULT_SETTINGS, normalizeTaskManagerSettings } from '../src/types';
import type { ParsedTask } from '../src/task-scanner';

function task(overrides: Partial<ParsedTask> = {}): ParsedTask {
  return {
    key: 'Tasks.md:Do thing',
    filePath: 'Tasks.md',
    lineNumber: 1,
    rawLine: '- [ ] Do thing #project/demo 📅 2026-05-28',
    linePrefix: '',
    indentation: '',
    listMarker: '-',
    checkbox: ' ',
    body: 'Do thing #project/demo 📅 2026-05-28',
    normalizedText: 'Do thing #project/demo',
    status: 'todo',
    tags: ['#project/demo'],
    contexts: [],
    metadata: { dates: { due: '2026-05-28' }, invalidDates: {}, priority: 'high', dependsOn: [], id: 'demo-1' },
    ...overrides,
  } as ParsedTask;
}

test('deferred wave B: new safe-subset settings are gated off by default', () => {
  const settings = normalizeTaskManagerSettings({});
  assert.equal(settings.enableBasesIntegration, false);
  assert.equal(settings.basesAutoRefreshEnabled, false);
  assert.equal(settings.nlpQueryEnabled, false);
  assert.equal(settings.kanbanFileWritebackEnabled, false);
});

test('deferred wave B: Bases export creates frontmatter task index aligned with .base views', () => {
  const t = task();
  const note = generateBasesTaskNote(t, '2026-05-28T00:00:00.000Z');
  assert.match(note, /^task-manager-bases-task: true$/mu);
  assert.match(note, /^task_status: "todo"$/mu);
  assert.match(note, /^task_priority: "high"$/mu);
  assert.match(note, /^task_due: "2026-05-28"$/mu);
  assert.match(note, /^task_project: "demo"$/mu);

  const views = generateBasesViewFiles();
  assert.equal(views.length, 4);
  assert.ok(views.every((view) => view.content.includes('Task Manager Bases/Task Index')));
  assert.ok(views.every((view) => view.content.includes('task-manager-bases-task')));
  assert.ok(views.every((view) => isGeneratedBasesFileContent(view.content)));

  const files = generateBasesExportFiles([t], '2026-05-28T00:00:00.000Z');
  assert.ok(files.some((file) => file.path === 'Task Manager Bases/Task Index.md'));
  assert.ok(files.some((file) => file.path.startsWith('Task Manager Bases/Task Index/') && file.path.endsWith('.md')));
  assert.ok(files.every((file) => isGeneratedBasesFileContent(file.content)));
});

test('deferred wave B: Bases ownership requires anchored, unambiguous generated markers', () => {
  const markedNote = '---\ntask-manager-bases-generated: true\ntask-manager-bases-index: true\n---\n';
  const markedView = generateBasesViewFiles()[0]?.content ?? '';
  assert.equal(isGeneratedBasesFileContent('# Personal Bases file\n'), false);
  assert.equal(isGeneratedBasesFileContent('Prose quotes task-manager-bases-generated: true here.\n'), false);
  assert.equal(isGeneratedBasesFileContent('---\ntask-manager-bases-generated: true\ntask-manager-bases-generated: true\n---\n'), false);
  assert.equal(isGeneratedBasesFileContent('---\ntask-manager-bases-task: true\ntask-manager-bases-index: true\n---\n'), false);
  assert.equal(isGeneratedBasesFileContent('---\ntask-manager-bases-generated: true\ntask-manager-bases-generated: false\ntask-manager-bases-index: true\n---\n'), false);
  assert.equal(isGeneratedBasesFileContent(`${markedView}\n# task-manager-bases-generated: true\n`), false);
  assert.equal(isGeneratedBasesFileContent(markedNote), true);
  assert.equal(isGeneratedBasesFileContent('---\ntask-manager-bases-index: true\n---\n'), true);
  assert.equal(isGeneratedBasesFileContent(markedView), true);
  assert.equal(isOwnedGeneratedBasesFile('Task Manager Bases/Task Index.md', markedNote), true);
  assert.equal(isOwnedGeneratedBasesFile('Task Manager Bases/Today.base', markedView), true);
  assert.equal(isOwnedGeneratedBasesFile('Task Manager Bases/Today.base', markedNote), false);
  assert.equal(isOwnedGeneratedBasesFile('Task Manager Bases/Task Index.md', markedView), false);
  assert.equal(isOwnedGeneratedBasesFile('Task Manager Bases copy/Task Index.md', markedNote), false);
  assert.equal(isOwnedGeneratedBasesFile('Task Manager Bases/Task Index.txt', markedNote), false);
});

test('deferred wave B: Bases export avoids colliding sanitized task note paths', () => {
  const first = task({ normalizedText: 'First', metadata: { dates: {}, invalidDates: {}, priority: 'normal', dependsOn: [], id: 'a/b' } });
  const second = task({ normalizedText: 'Second', metadata: { dates: {}, invalidDates: {}, priority: 'normal', dependsOn: [], id: 'a:b' } });

  const notePaths = generateBasesExportFiles([first, second], '2026-05-28T00:00:00.000Z')
    .map((file) => file.path)
    .filter((path) => path.startsWith('Task Manager Bases/Task Index/') && path.endsWith('.md'));

  assert.deepEqual(notePaths, [
    'Task Manager Bases/Task Index/a-b.md',
    'Task Manager Bases/Task Index/a-b-2.md',
  ]);
});

test('deferred wave B: guarded Bases write refuses to modify existing unmarked generated target', async () => {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  const targetPath = 'Task Manager Bases/Today.base';
  const original = 'name: My personal Today base\nfilters:\n  and: []\n';
  files.set(targetPath, original);

  const fileForPath = (path: string): TFile => Object.assign(Object.create(TFile.prototype) as TFile, {
    path,
    name: path.split('/').pop() ?? path,
    extension: path.split('.').pop() ?? '',
    basename: (path.split('/').pop() ?? path).replace(/\.[^.]+$/u, ''),
  });
  const folderForPath = (path: string): TFolder => Object.assign(Object.create(TFolder.prototype) as TFolder, {
    path,
    name: path.split('/').pop() ?? path,
    children: [],
  });
  const vault = {
    getAbstractFileByPath(path: string) {
      if (files.has(path)) return fileForPath(path);
      if (folders.has(path)) return folderForPath(path);
      return null;
    },
    async createFolder(path: string) {
      folders.add(path);
      return folderForPath(path);
    },
    async read(file: TFile) {
      return files.get(file.path) ?? '';
    },
    async modify(file: TFile, content: string) {
      files.set(file.path, content);
    },
    async create(path: string, content: string) {
      files.set(path, content);
      return fileForPath(path);
    },
  };
  const plugin = Object.create(TaskManagerPlugin.prototype) as unknown as {
    app: unknown;
    writeGeneratedBasesFile(path: string, content: string): Promise<boolean>;
  };
  plugin.app = { vault };

  const generated = generateBasesViewFiles().find((view) => view.path === targetPath);
  assert.ok(generated);
  const written = await plugin.writeGeneratedBasesFile(generated.path, generated.content);

  assert.equal(written, false);
  assert.equal(files.get(targetPath), original);
});

test('deferred wave B: stale Bases cleanup trashes only marker-owned in-directory files', async () => {
  const fileForPath = (path: string): TFile => Object.assign(Object.create(TFile.prototype) as TFile, {
    path,
    name: path.split('/').pop() ?? path,
    extension: path.split('.').pop() ?? '',
    basename: (path.split('/').pop() ?? path).replace(/\.[^.]+$/u, ''),
  });
  const staleOwned = fileForPath('Task Manager Bases/Task Index/stale.md');
  const staleUnmarked = fileForPath('Task Manager Bases/Task Index/personal.md');
  const outsideOwned = fileForPath('Elsewhere/stale.md');
  const wrongExtension = fileForPath('Task Manager Bases/stale.txt');
  const expected = fileForPath('Task Manager Bases/Today.base');
  const markedNote = generateBasesTaskNote(task(), '2026-05-28T00:00:00.000Z');
  const markedView = generateBasesViewFiles().find((file) => file.path === expected.path)?.content ?? '';
  const contents = new Map<string, string>([
    [staleOwned.path, markedNote],
    [staleUnmarked.path, '# Personal note\n'],
    [outsideOwned.path, markedNote],
    [wrongExtension.path, markedNote],
    [expected.path, markedView],
  ]);
  const trashed: string[] = [];
  const plugin = Object.create(TaskManagerPlugin.prototype) as unknown as {
    app: unknown;
    writeGeneratedBasesFile(path: string, content: string): Promise<boolean>;
    writeBasesExport(tasks: ParsedTask[], showNotice: boolean): Promise<void>;
  };
  Object.assign(plugin, {
    app: {
      vault: {
        getFiles: () => [staleOwned, staleUnmarked, outsideOwned, wrongExtension, expected],
        read: async (file: TFile) => contents.get(file.path) ?? '',
      },
      fileManager: { trashFile: async (file: TFile) => { trashed.push(file.path); } },
    },
    writeGeneratedBasesFile: async () => true,
  });

  await plugin.writeBasesExport([], true);

  assert.deepEqual(trashed, [staleOwned.path]);
});

test('deferred wave B: Bases trash failure is surfaced without permanent-delete fallback', async () => {
  const stale = Object.assign(Object.create(TFile.prototype) as TFile, {
    path: 'Task Manager Bases/Task Index/stale.md', name: 'stale.md', extension: 'md', basename: 'stale',
  });
  let permanentDeletes = 0;
  const plugin = Object.create(TaskManagerPlugin.prototype) as unknown as {
    app: unknown;
    writeGeneratedBasesFile(path: string, content: string): Promise<boolean>;
    writeBasesExport(tasks: ParsedTask[], showNotice: boolean): Promise<void>;
  };
  Object.assign(plugin, {
    app: {
      vault: {
        getFiles: () => [stale],
        read: async () => generateBasesTaskNote(task(), '2026-05-28T00:00:00.000Z'),
        delete: async () => { permanentDeletes += 1; },
      },
      fileManager: { trashFile: async () => { throw new Error('trash unavailable'); } },
    },
    writeGeneratedBasesFile: async () => true,
  });

  await assert.rejects(plugin.writeBasesExport([], false), /trash unavailable/u);
  assert.equal(permanentDeletes, 0);
});

test('deferred wave B: NLP query fallback is conservative and gated', () => {
  assert.throws(() => parseTaskQuery('overdue high priority tasks', { today: '2026-05-28' }));

  const query = parseTaskQuery('overdue high priority tasks', { today: '2026-05-28', nlpQueryEnabled: true });
  assert.deepEqual(query.instructions, ['not done', 'due before 2026-05-28', 'priority is high']);

  const matching = task({ metadata: { dates: { due: '2026-05-27' }, invalidDates: {}, priority: 'high', dependsOn: [] } });
  const future = task({ key: 'future', metadata: { dates: { due: '2026-05-29' }, invalidDates: {}, priority: 'high', dependsOn: [] } });
  const low = task({ key: 'low', metadata: { dates: { due: '2026-05-27' }, invalidDates: {}, priority: 'low', dependsOn: [] } });
  assert.deepEqual(filterTasks([matching, future, low], query, { today: '2026-05-28', states: DEFAULT_SETTINGS.supportedStates }).map((item) => item.key), [matching.key]);
});

test('deferred wave B: Kanban writeback moves one card line under an existing heading', () => {
  const markdown = '# Board\n\n## Todo\n\n- [ ] Build feature\n- [ ] Keep here\n\n## Done\n\n- [x] Already done\n';
  const result = moveKanbanCardLine(markdown, '- [ ] Build feature', 'Done', 'x', 5);
  assert.equal(result.moved, true);
  assert.match(result.markdown, /## Todo\n\n- \[ \] Keep here/u);
  assert.match(result.markdown, /## Done\n\n- \[x\] Build feature\n- \[x\] Already done/u);
});

test('deferred wave B: Kanban writeback refuses ambiguous or missing targets', () => {
  const duplicate = '# Board\n\n## Todo\n- [ ] Same\n\n## Doing\n- [ ] Same\n';
  assert.deepEqual(moveKanbanCardLine(duplicate, '- [ ] Same', 'Done', 'x'), { markdown: duplicate, moved: false, reason: 'ambiguous-source' });

  const missingHeading = '# Board\n\n## Todo\n- [ ] Build\n';
  assert.deepEqual(moveKanbanCardLine(missingHeading, '- [ ] Build', 'Done', 'x'), { markdown: missingHeading, moved: false, reason: 'target-heading-not-found' });
});

test('deferred wave B: Kanban writeback resolves duplicate target headings within the source parent section', () => {
  const markdown = '# Board\n\n## Project A\n\n### Done\n\n- [x] Existing A\n\n## Project B\n\n### Todo\n\n- [ ] Build feature\n\n### Done\n\n- [x] Existing B\n';
  const result = moveKanbanCardLine(markdown, '- [ ] Build feature', 'Done', 'x', 13);
  assert.equal(result.moved, true);
  assert.match(result.markdown, /## Project A[\s\S]*### Done\n\n- \[x\] Existing A/u);
  assert.match(result.markdown, /## Project B[\s\S]*### Todo\n\n+### Done\n\n- \[x\] Build feature\n- \[x\] Existing B/u);
});

test('deferred wave B: Kanban writeback refuses ambiguous duplicate target headings in one section', () => {
  const markdown = '# Board\n\n## Project A\n\n### Todo\n\n- [ ] Build feature\n\n### Done\n\n- [x] First done\n\n### Done\n\n- [x] Second done\n';
  assert.deepEqual(moveKanbanCardLine(markdown, '- [ ] Build feature', 'Done', 'x', 7), { markdown, moved: false, reason: 'ambiguous-target-heading' });
});

test('Pass 127: generateKanbanMarkdown does not duplicate kanban-plugin key on round-trip', () => {
  const original = '---\nkanban-plugin: basic\nauthor: alice\n---\n\n# My Board\n\n## Todo\n\n- [ ] Task one\n\n## Done\n\n- [x] Task two\n';
  const board = parseKanbanMarkdown(original, 'My Board');
  const regenerated = generateKanbanMarkdown(board);

  // Count occurrences of 'kanban-plugin' in the regenerated frontmatter
  const frontmatterMatch = regenerated.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(frontmatterMatch, 'Generated markdown should have YAML frontmatter');
  const frontmatter = frontmatterMatch[1];
  const count = (frontmatter.match(/kanban-plugin/g) ?? []).length;
  assert.equal(count, 1, 'kanban-plugin key must appear exactly once in the generated frontmatter');

  // Ensure the round-tripped board still has all columns
  const board2 = parseKanbanMarkdown(regenerated);
  const columnTitles = board2.columns.map(c => c.title);
  assert.ok(columnTitles.includes('Todo'), 'Round-tripped board should retain Todo column');
  assert.ok(columnTitles.includes('Done'), 'Round-tripped board should retain Done column');
});

test('kanban parser preserves frontmatter values containing colons', () => {
  const original = '---\nkanban-plugin: basic\nsource: https://example.com/team:board\narchived: false\n---\n\n# My Board\n\n## Todo\n\n- [ ] Task one\n';
  const board = parseKanbanMarkdown(original, 'My Board');

  assert.equal(board.metadata?.source, 'https://example.com/team:board');
  assert.equal(board.metadata?.archived, false);

  const regenerated = generateKanbanMarkdown(board);
  assert.match(regenerated, /source: "https:\/\/example\.com\/team:board"/u);
});

test('Pass 128: buildRollups does not count tasks from a sibling subtree as children', () => {
  // Four tasks in the same file: two parents (indent 0) each with one child (indent 2).
  // Task A should only count Child A; Task B should only count Child B.
  const makeTask = (key: string, lineNumber: number, indentation: string, status: 'todo' | 'done'): ParsedTask => ({
    key,
    filePath: 'Notes.md',
    lineNumber,
    rawLine: `${indentation}- [${status === 'done' ? 'x' : ' '}] ${key}`,
    linePrefix: '',
    indentation,
    listMarker: '-',
    checkbox: status === 'done' ? 'x' : ' ',
    body: key,
    normalizedText: key,
    status,
    tags: [],
    contexts: [],
    metadata: { dates: {}, invalidDates: {}, priority: 'normal', dependsOn: [] },
  } as ParsedTask);

  const taskA      = makeTask('Task A',   1, '',   'todo');
  const childA     = makeTask('Child A',  2, '  ', 'done');   // done — counts toward A
  const taskB      = makeTask('Task B',   3, '',   'todo');
  const childB     = makeTask('Child B',  4, '  ', 'todo');   // todo — does NOT count toward A

  const rollups = buildRollups([taskA, childA, taskB, childB]);

  // Task A: 1 direct child (Child A), 1 done → 1/1 (100%)
  const rollupA = rollups.get('Task A');
  assert.ok(rollupA, 'Task A should have a rollup');
  assert.equal(rollupA.progressText, '1/1 (100%)', 'Task A rollup should include only Child A');

  // Task B: 1 direct child (Child B), 0 done → 0/1 (0%)
  const rollupB = rollups.get('Task B');
  assert.ok(rollupB, 'Task B should have a rollup');
  assert.equal(rollupB.progressText, '0/1 (0%)', 'Task B rollup should include only Child B');
});
