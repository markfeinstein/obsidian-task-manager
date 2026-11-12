import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

import { getGanttKeyboardReschedule, renderGantt } from '../src/gantt-renderer';
import { getAvailableLocales, getCoreTranslationCoverage, getLocale, isLocaleCoreComplete, setLocale } from '../src/i18n';
import { DEFAULT_SETTINGS, normalizeTaskManagerSettings } from '../src/types';
import { installDomHarness } from './dom-harness';
import type { TaskQuery } from '../src/task-query';
import { compareTableSortValues, normalizeTableDateInput, tableSortValue, tableTaskSortValue } from '../src/table-renderer';
import { createMockTask } from './test-utils';

test('language picker only exposes 100% core-complete catalogues', () => {
  const locales = getAvailableLocales();
  assert.deepEqual(locales, ['en']);
  for (const locale of locales) {
    assert.equal(isLocaleCoreComplete(locale), true);
    assert.equal(getCoreTranslationCoverage(locale), 100);
  }
  for (const partial of ['de', 'es', 'pt-BR', 'zh'] as const) assert.equal(isLocaleCoreComplete(partial), false);
});

test('persisted empty locales migrate to the English fallback', () => {
  setLocale('ko');
  assert.equal(getLocale(), 'en');
  assert.equal(normalizeTaskManagerSettings({ preferredLocale: 'ko' }).preferredLocale, 'en');
});

test('sortable table comparison keeps missing values last in both directions', () => {
  assert.equal(compareTableSortValues(null, '2026-01-01', 'asc') > 0, true);
  assert.equal(compareTableSortValues(null, '2026-01-01', 'desc') > 0, true);
  assert.equal(compareTableSortValues('Alpha', 'beta', 'asc') < 0, true);
  assert.equal(compareTableSortValues('Alpha', 'beta', 'desc') > 0, true);
  assert.equal(tableSortValue(undefined), null);
  assert.equal(tableSortValue(''), null);
  assert.equal(tableSortValue(0), '0');
  const task = createMockTask({ tags: [], metadata: { ...createMockTask().metadata, effort: undefined, actual: undefined, cost: undefined } });
  for (const key of ['tags', 'effort', 'actual', 'cost']) assert.equal(tableTaskSortValue(task, key), null);
});

test('Gantt keyboard movement only updates a date that controls the rendered bar', () => {
  const base = createMockTask();
  const withStart = createMockTask({ metadata: { ...base.metadata, dates: { ...base.metadata.dates, start: '2026-07-01', scheduled: '2026-07-02', due: '2026-07-03' } } });
  assert.equal(getGanttKeyboardReschedule(withStart), null);
  const scheduled = createMockTask({ metadata: { ...base.metadata, dates: { ...base.metadata.dates, scheduled: '2026-07-02', due: '2026-07-03' } } });
  assert.deepEqual(getGanttKeyboardReschedule(scheduled), { field: 'scheduled', current: '2026-07-02' });
  const due = createMockTask({ metadata: { ...base.metadata, dates: { ...base.metadata.dates, due: '2026-07-03' } } });
  assert.deepEqual(getGanttKeyboardReschedule(due), { field: 'due', current: '2026-07-03' });
});

test('Gantt exposes a tap/click date control equivalent to drag rescheduling', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const root = harness.document.createElement('div');
  harness.document.body.appendChild(root);
  const base = createMockTask();
  const task = createMockTask({ normalizedText: 'Move by date', metadata: { ...base.metadata, dates: { due: '2026-07-13' } } });
  const query: TaskQuery = { filters: [], sort: [], groups: [], layout: { hidden: new Set(), shown: new Set() }, explain: false, errors: [], instructions: [] };
  let moved = '';
  renderGantt(root, [task], query, DEFAULT_SETTINGS, async () => undefined, () => undefined, async (_task, field, value) => { moved = `${field}:${value}`; });
  const input = root.querySelector<HTMLInputElement>('.task-manager-gantt-reschedule-input');
  assert.ok(input);
  assert.match(input.getAttribute('aria-label') ?? '', /Move by date/u);
  input.value = '2026-07-14';
  input.dispatchEvent(new harness.window.Event('change', { bubbles: true }));
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.equal(moved, 'due:2026-07-14');
});

test('Gantt renders navigation, hierarchy evidence, undated/future rows, keyboard, drag, resize, and failure feedback', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const root = harness.document.createElement('div');
  harness.document.body.appendChild(root);
  const base = createMockTask();
  const tasks = [
    createMockTask({ key: 'base', normalizedText: 'Foundation', filePath: 'Plan.md', lineNumber: 1, metadata: { ...base.metadata, id: 'base', dates: { due: '2026-07-12' }, priority: 'high' } }),
    createMockTask({ key: 'target', normalizedText: 'Dependent', filePath: 'Plan.md', lineNumber: 2, metadata: { ...base.metadata, id: 'target', dependsOn: ['base', 'duplicate'], dates: { scheduled: '2026-07-13', due: '2026-07-15' } } }),
    createMockTask({ key: 'duplicate-a', normalizedText: 'Duplicate A', filePath: 'Plan.md', lineNumber: 3, metadata: { ...base.metadata, id: 'duplicate', dates: { due: '2026-07-14' } } }),
    createMockTask({ key: 'duplicate-b', normalizedText: 'Duplicate B', filePath: 'Plan.md', lineNumber: 4, metadata: { ...base.metadata, id: 'duplicate', dates: { due: '2026-07-14' } } }),
    createMockTask({ key: 'duration', normalizedText: 'Started duration', filePath: 'Plan.md', lineNumber: 5, metadata: { ...base.metadata, dates: { start: '2026-07-10', due: '2026-07-16' }, priority: 'medium' } }),
    createMockTask({ key: 'past', normalizedText: 'Outside past', filePath: 'Plan.md', lineNumber: 6, metadata: { ...base.metadata, dates: { due: '2026-06-01' } } }),
    createMockTask({ key: 'future', normalizedText: 'Outside future', filePath: 'Plan.md', lineNumber: 7, metadata: { ...base.metadata, dates: { due: '2026-08-01' } } }),
    createMockTask({ key: 'undated', normalizedText: 'An undated task with a deliberately long label', filePath: 'Plan.md', lineNumber: 8, metadata: { ...base.metadata, dates: {} } }),
  ];
  const projected = createMockTask({ key: 'projected', normalizedText: 'Projected', metadata: { ...base.metadata, dates: { due: '2026-07-14' } } });
  const query: TaskQuery = { filters: [], sort: [], groups: [], layout: { hidden: new Set(), shown: new Set() }, explain: false, errors: [], instructions: [] };
  const writes: string[] = [];
  let edits = 0;
  renderGantt(root, tasks, query, DEFAULT_SETTINGS, async () => undefined, () => { edits += 1; }, async (_task, field, value) => {
    writes.push(`${field}:${value}`);
    if (value === '2026-07-16' && field === 'scheduled') throw new Error('date refused');
  }, [projected]);
  assert.match(root.querySelector('.task-manager-sr-only[aria-label="Task dependencies"]')?.textContent ?? '', /depends on|ambiguous/u);
  assert.match(root.textContent ?? '', /Undated \(1\)/u);
  const zoom = root.querySelector<HTMLSelectElement>('.task-manager-gantt-zoom');
  assert.ok(zoom);
  zoom.value = '7';
  zoom.dispatchEvent(new harness.window.Event('change', { bubbles: true }));
  for (const selector of ['.task-manager-gantt-nav-btn', '.task-manager-gantt-today-btn', '.task-manager-gantt-fit-btn']) root.querySelector<HTMLButtonElement>(selector)?.click();

  const undated = root.querySelector<HTMLElement>('.task-manager-gantt-row-undated');
  undated?.dispatchEvent(new harness.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  const bar = root.querySelector<HTMLElement>('.task-manager-gantt-bar');
  assert.ok(bar);
  bar.dispatchEvent(new harness.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  bar.dispatchEvent(new harness.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  await new Promise<void>((resolve) => { setImmediate(resolve); });
  assert.ok(edits >= 2);

  const dateInputs = Array.from(root.querySelectorAll<HTMLInputElement>('.task-manager-gantt-reschedule-input'));
  assert.ok(dateInputs.length >= 4);
  dateInputs[0].value = '';
  dateInputs[0].dispatchEvent(new harness.window.Event('change', { bubbles: true }));
  dateInputs[1].value = '2026-07-16';
  dateInputs[1].dispatchEvent(new harness.window.Event('change', { bubbles: true }));
  await new Promise<void>((resolve) => { setImmediate(resolve); });

  const dragBar = root.querySelector<HTMLElement>('.task-manager-gantt-bar');
  assert.ok(dragBar);
  dragBar.dispatchEvent(new harness.window.MouseEvent('mousedown', { bubbles: true, button: 1, clientX: 0 }));
  dragBar.dispatchEvent(new harness.window.MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 0 }));
  harness.document.dispatchEvent(new harness.window.MouseEvent('mousemove', { bubbles: true, clientX: 40 }));
  harness.document.dispatchEvent(new harness.window.MouseEvent('mouseup', { bubbles: true, clientX: 40 }));
  const resize = dragBar.querySelector<HTMLElement>('.task-manager-gantt-resize-handle');
  resize?.dispatchEvent(new harness.window.MouseEvent('mousedown', { bubbles: true, button: 0, clientX: 0 }));
  harness.document.dispatchEvent(new harness.window.MouseEvent('mousemove', { bubbles: true, clientX: -80 }));
  harness.document.dispatchEvent(new harness.window.MouseEvent('mouseup', { bubbles: true, clientX: -80 }));
  await Promise.resolve();
  assert.ok(writes.length >= 2);
});

test('accessibility CSS uses Task Manager-owned class names', () => {
  const css = readdirSync('styles').filter((name) => name.endsWith('.css')).sort()
    .map((name) => readFileSync(`styles/${name}`, 'utf8')).join('');
  assert.equal(/(^|\n)\.sr-(?:only|skip-to-content)\b/u.test(css), false);
  assert.equal(/(^|\n)\.(?:graph-filter-bar|graph-search|heatmap-day|heatmap-container)\b/u.test(css), false);
  assert.equal(/(?:^|\})\s*:focus-visible\s*\{/u.test(css), false);
  assert.equal(/(?:^|\})\s*(?:button|input|textarea|select|a)\s*(?:,|\{)/u.test(css), false);
  assert.equal(/:root\s*\{[^}]*--interactive-accent\s*:/su.test(css), false);
  assert.match(css, /\.task-manager-sr-only\s*\{/u);
  assert.match(css, /\.task-manager-settings__section-header:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--interactive-accent\)/su);
  assert.doesNotMatch(css, /\.task-manager-kanban-add-btn\s*\{[^}]*min-(?:width|height):[^;]*!important/su);
  assert.match(css, /@media\s*\(pointer:\s*coarse\)[^]*\.task-manager-kanban-add-btn\s*\{[^}]*min-height:\s*44px;[^}]*min-width:\s*44px;/u);
});

test('table date input requires a real calendar date', () => {
  assert.equal(normalizeTableDateInput('2024-02-29'), '2024-02-29');
  assert.equal(normalizeTableDateInput('2023-02-29'), null);
  assert.equal(normalizeTableDateInput('2026-02-03 trailing'), null);
  assert.equal(normalizeTableDateInput(''), null);
});
