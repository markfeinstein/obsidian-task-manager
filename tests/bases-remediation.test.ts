import test from 'node:test';
import assert from 'node:assert/strict';
import Ajv from 'ajv';
import { TFile, TFolder } from 'obsidian';
import TaskManagerPlugin from '../src/main';
import { equivalentBasesContent, generateBasesTaskNote, generateBasesViewFiles, isOwnedGeneratedBasesFile } from '../src/bases-integration';
import { LatestWorkQueue } from '../src/latest-work-queue';
import { parseMarkdownTaskLine } from '../src/task-model';
import type { ParsedTask } from '../src/task-scanner';

function task(title = 'Task', id = 'stable') {
  const parsed = parseMarkdownTaskLine(`- [ ] ${title} [id:: ${id}]`, 'Tasks.md', 1);
  assert.ok(parsed);
  return parsed;
}
interface BasesConfig {
  filters: { and: string[] };
  properties: Record<string, { displayName: string }>;
  views: Array<{ type: string; name: string; filters: { and: string[] }; order: string[]; sort?: Array<{ property: string; direction: string }>; groupBy?: { property: string; direction: string } }>;
}

test('Bases files validate against the documented object/view schema and use date functions and bracket access', () => {
  const sorting = { type: 'object', required: ['property', 'direction'], additionalProperties: false, properties: { property: { type: 'string' }, direction: { enum: ['ASC', 'DESC'] } } };
  const filters = { type: 'object', required: ['and'], additionalProperties: false, properties: { and: { type: 'array', items: { type: 'string' } } } };
  const validate = new Ajv().compile<BasesConfig>({
    type: 'object', required: ['filters', 'properties', 'views'], additionalProperties: false,
    properties: {
      filters,
      properties: { type: 'object', additionalProperties: { type: 'object', required: ['displayName'], additionalProperties: false, properties: { displayName: { type: 'string' } } } },
      views: { type: 'array', minItems: 1, items: { type: 'object', required: ['type', 'name', 'filters', 'order'], additionalProperties: false, properties: { type: { const: 'table' }, name: { type: 'string' }, filters, order: { type: 'array', items: { type: 'string' } }, sort: { type: 'array', items: sorting }, groupBy: sorting } } },
    },
  });
  for (const file of generateBasesViewFiles()) {
    const value: unknown = JSON.parse(file.content.split('\n').slice(2).join('\n'));
    assert.ok(validate(value), JSON.stringify(validate.errors));
    assert.ok(isOwnedGeneratedBasesFile(file.path, file.content));
    assert.ok(value.filters.and.includes('note["task-manager-bases-task"] == true'));
    const view = value.views[0];
    if (view.name === 'Today' || view.name === 'Upcoming') {
      assert.ok(view.filters.and.some((filter) => filter.includes('today()') && filter.includes('date(note.task_happens)')));
      assert.ok(view.filters.and.includes('note.task_happens != ""'));
    }
    if (view.name === 'Projects') assert.deepEqual(view.groupBy, { property: 'note.task_project', direction: 'ASC' });
    if (view.name === 'Completed') assert.deepEqual(view.sort, [{ property: 'note.task_done', direction: 'DESC' }]);
  }
});

function harness() {
  const files = new Map<string, string>();
  const folders = new Set<string>();
  const writes: string[] = [];
  const file = (path: string): TFile => Object.assign(Object.create(TFile.prototype) as TFile, { path, extension: path.split('.').pop() });
  const folder = (path: string): TFolder => Object.assign(Object.create(TFolder.prototype) as TFolder, { path, children: [] });
  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => files.has(path) ? file(path) : folders.has(path) ? folder(path) : null,
      createFolder: async (path: string) => { folders.add(path); return folder(path); },
      getFiles: () => [...files.keys()].map(file),
      read: async (target: TFile) => files.get(target.path) ?? '',
      create: async (path: string, content: string) => { files.set(path, content); writes.push(path); return file(path); },
      process: async (target: TFile, update: (content: string) => string) => {
        const current = files.get(target.path) ?? '';
        const next = update(current);
        if (next !== current) { files.set(target.path, next); writes.push(target.path); }
        return next;
      },
    },
    fileManager: { trashFile: async (target: TFile) => { files.delete(target.path); } },
  };
  const plugin = Object.create(TaskManagerPlugin.prototype) as unknown as { app: typeof app; settings: { enableBasesIntegration: boolean }; writeBasesExport(tasks: ParsedTask[], showNotice: boolean): Promise<void>; writeGeneratedBasesFile(path: string, content: string): Promise<boolean> };
  plugin.app = app;
  plugin.settings = { enableBasesIntegration: true };
  return { plugin, files, writes };
}

test('a 1,000-task Bases export writes no unchanged notes and only two files when one summarized task changes', async () => {
  const { plugin, files, writes } = harness();
  const tasks = Array.from({ length: 1000 }, (_, index) => task(`Task ${index}`, `stable-${index}`));
  await plugin.writeBasesExport(tasks, false);
  assert.equal(writes.length, 1005);
  const original = files.get('Task Manager Bases/Task Index/stable-999.md');
  writes.length = 0;
  await plugin.writeBasesExport(tasks, false);
  assert.equal(writes.length, 0);
  tasks[0] = task('Changed', 'stable-0');
  await plugin.writeBasesExport(tasks, false);
  assert.deepEqual(writes.sort(), ['Task Manager Bases/Task Index.md', 'Task Manager Bases/Task Index/stable-0.md']);
  assert.equal(files.get('Task Manager Bases/Task Index/stable-999.md'), original);
  assert.ok(equivalentBasesContent(generateBasesTaskNote(tasks[0], '2026-01-01'), generateBasesTaskNote(tasks[0], '2026-11-09')));
});

test('Bases serializes concurrent exports, skips intermediate snapshots, and retains only the latest task projection', async () => {
  const { plugin, files } = harness();
  await plugin.writeBasesExport([], false);
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  const wait = new Promise<void>((resolve) => { release = resolve; });
  const read = plugin.app.vault.read;
  let first = true;
  plugin.app.vault.read = async (file) => { if (first) { first = false; entered(); await wait; } return read(file); };
  const old = plugin.writeBasesExport([task('Old', 'old')], false);
  await started;
  const middle = plugin.writeBasesExport([task('Middle', 'middle')], false);
  const latest = plugin.writeBasesExport([task('Latest', 'latest')], false);
  release();
  await Promise.all([old, middle, latest]);
  assert.ok(files.has('Task Manager Bases/Task Index/latest.md'));
  assert.equal(files.has('Task Manager Bases/Task Index/old.md'), false);
  assert.equal(files.has('Task Manager Bases/Task Index/middle.md'), false);
});

test('Bases migrates owned legacy views but rechecks ownership inside the atomic update', async () => {
  const { plugin, files } = harness();
  const view = generateBasesViewFiles()[0];
  files.set(view.path, 'name: Today\n# task-manager-bases-generated: true\nfilters: {}\n');
  assert.equal(await plugin.writeGeneratedBasesFile(view.path, view.content), true);
  assert.equal(files.get(view.path), view.content);
  const process = plugin.app.vault.process;
  plugin.app.vault.process = async (file, update) => { files.set(file.path, 'Personal content'); return process(file, update); };
  assert.equal(await plugin.writeGeneratedBasesFile(view.path, `${view.content}\n`), false);
  assert.equal(files.get(view.path), 'Personal content');
});

test('latest-work queue survives a failed job and invalidation fences queued callbacks', async () => {
  const queue = new LatestWorkQueue();
  await assert.rejects(queue.run(async () => { throw new Error('Expected test failure'); }), /Expected test failure/u);
  let invoked = false;
  const stale = queue.run(async () => { invoked = true; });
  queue.invalidate();
  await stale;
  assert.equal(invoked, false);
  await queue.run(async () => { invoked = true; });
  assert.equal(invoked, true);
});
