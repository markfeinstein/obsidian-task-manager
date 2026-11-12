import test from 'node:test';
import assert from 'node:assert/strict';
import { AdvancedFindModal, filterAdvancedFindTasks, type AdvancedFindState } from '../src/advanced-find-modal';
import { TFile, type App } from 'obsidian';
import type { ParsedTask } from '../src/task-scanner';
import { DEFAULT_SETTINGS } from '../src/types';
import { installDomHarness } from './dom-harness';

function task(partial: Partial<ParsedTask>): ParsedTask {
  return {
    key: partial.key ?? `${partial.filePath ?? 'Inbox.md'}:${partial.lineNumber ?? 1}`,
    filePath: partial.filePath ?? 'Inbox.md',
    lineNumber: partial.lineNumber ?? 1,
    rawLine: partial.rawLine ?? `- [ ] ${partial.normalizedText ?? 'Task'}`,
    linePrefix: '',
    indentation: '',
    listMarker: '-',
    checkbox: partial.checkbox ?? ' ',
    body: partial.body ?? partial.normalizedText ?? 'Task',
    normalizedText: partial.normalizedText ?? 'Task',
    status: partial.status ?? 'todo',
    tags: partial.tags ?? [],
    contexts: [],
    metadata: {
      priority: partial.metadata?.priority ?? 'normal',
      dates: partial.metadata?.dates ?? {},
      invalidDates: {},
      dependsOn: [],
      ...partial.metadata,
    },
  } as ParsedTask;
}

const baseState: AdvancedFindState = {
  text: '',
  statuses: [],
  priority: '',
  dueFrom: '',
  dueTo: '',
  tag: '',
  folder: '',
};

test('advanced find filters by status and priority', () => {
  const tasks = [
    task({ normalizedText: 'Draft report', status: 'todo', metadata: { priority: 'high', dates: {}, invalidDates: {}, dependsOn: [] } as any }),
    task({ normalizedText: 'Waiting review', status: 'done', metadata: { priority: 'low', dates: {}, invalidDates: {}, dependsOn: [] } as any }),
  ];
  const result = filterAdvancedFindTasks(tasks, { ...baseState, statuses: ['todo'], priority: 'high' });
  assert.equal(result.length, 1);
  assert.equal(result[0].normalizedText, 'Draft report');
});

test('advanced find filters by folder, tag, and due range', () => {
  const tasks = [
    task({ filePath: 'Projects/A.md', normalizedText: 'Ship feature', tags: ['#work'], metadata: { priority: 'normal', dates: { due: '2026-06-10' }, invalidDates: {}, dependsOn: [] } as any }),
    task({ filePath: 'Archive/A.md', normalizedText: 'Old feature', tags: ['#work'], metadata: { priority: 'normal', dates: { due: '2026-06-10' }, invalidDates: {}, dependsOn: [] } as any }),
    task({ filePath: 'ProjectsArchive/A.md', normalizedText: 'Wrong prefix', tags: ['#work'], metadata: { priority: 'normal', dates: { due: '2026-06-10' }, invalidDates: {}, dependsOn: [] } as any }),
    task({ filePath: 'Projects/B.md', normalizedText: 'No tag', tags: [], metadata: { priority: 'normal', dates: { due: '2026-07-01' }, invalidDates: {}, dependsOn: [] } as any }),
  ];
  const result = filterAdvancedFindTasks(tasks, { ...baseState, folder: 'Projects', tag: 'work', dueFrom: '2026-06-01', dueTo: '2026-06-30' });
  assert.equal(result.length, 1);
  assert.equal(result[0].normalizedText, 'Ship feature');
});

test('advanced find controls use unique visible label associations and fieldset semantics', (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const content = harness.document.createElement('div');
  harness.document.body.appendChild(content);
  const modal = new AdvancedFindModal({ vault: {}, workspace: {} } as unknown as App, () => [], () => DEFAULT_SETTINGS);
  (modal as unknown as { contentEl: HTMLElement }).contentEl = content;
  modal.onOpen();
  const controls = Array.from(content.querySelectorAll<HTMLInputElement | HTMLSelectElement>('.task-manager-advanced-find-input'));
  assert.equal(controls.length, 6);
  assert.equal(new Set(controls.map((control) => control.id)).size, controls.length);
  for (const control of controls) {
    assert.ok(control.id);
    assert.equal(control.labels?.length, 1, `${control.id} should resolve its visible label`);
    assert.equal(control.labels?.[0].getAttribute('for'), control.id);
  }
  const fieldset = content.querySelector('fieldset.task-manager-advanced-find-statuses');
  assert.ok(fieldset);
  assert.equal(fieldset.querySelector('legend')?.textContent, 'Status');
  const statusInputs = Array.from(fieldset.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'));
  assert.ok(statusInputs.length > 0);
  assert.ok(statusInputs.every((input) => input.labels?.length === 1));
});

test('advanced find renders semantic result buttons, caps rows, and opens a source', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const content = harness.document.createElement('div');
  harness.document.body.appendChild(content);
  const tasks = Array.from({ length: 101 }, (_value, index) => task({ filePath: `Tasks/${index}.md`, lineNumber: index + 1, normalizedText: `Task ${index}` }));
  const file = Object.assign(Object.create(TFile.prototype) as TFile, { path: 'Tasks/0.md', extension: 'md', name: '0.md' });
  let opened = 0;
  const app = {
    vault: { getAbstractFileByPath: (path: string) => path === file.path ? file : null },
    workspace: { getLeaf: () => ({ openFile: async () => { opened += 1; } }) },
  } as unknown as App;
  const modal = new AdvancedFindModal(app, () => tasks, () => DEFAULT_SETTINGS);
  (modal as unknown as { contentEl: HTMLElement }).contentEl = content;
  modal.onOpen();
  assert.equal(content.querySelectorAll('.task-manager-advanced-find-result-button').length, 100);
  assert.match(content.querySelector('.task-manager-advanced-find-count')?.textContent ?? '', /first 100 of 101/u);
  content.querySelector<HTMLButtonElement>('.task-manager-advanced-find-result-button')?.click();
  await Promise.resolve();
  assert.equal(opened, 1);
});

test('advanced find text matches description or path', () => {
  const tasks = [
    task({ filePath: 'Areas/Health.md', normalizedText: 'Call dentist' }),
    task({ filePath: 'Projects/Launch.md', normalizedText: 'Write copy' }),
  ];
  assert.equal(filterAdvancedFindTasks(tasks, { ...baseState, text: 'dentist' }).length, 1);
  assert.equal(filterAdvancedFindTasks(tasks, { ...baseState, text: 'launch' }).length, 1);
});
