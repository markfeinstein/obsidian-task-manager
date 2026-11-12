import assert from 'node:assert/strict';
import test from 'node:test';
import { renderPlanningBoard } from '../src/planning-board';
import { renderTable } from '../src/table-renderer';
import { renderCalendar } from '../src/calendar-renderer';
import { renderGantt } from '../src/gantt-renderer';
import { renderEisenhower } from '../src/eisenhower-renderer';
import { renderKanban } from '../src/kanban-renderer';
import { DEFAULT_SETTINGS } from '../src/types';
import { installDomHarness } from './dom-harness';
import { createMockTask } from './test-utils';
import type { App, WorkspaceLeaf } from 'obsidian';
import type { TaskQuery } from '../src/task-query';
import { AdvancedFindModal } from '../src/advanced-find-modal';
import { renderTimeline } from '../src/timeline-renderer';
import { WeeklyReviewModal } from '../src/modals/weekly-review-modal';
import { QueryBuilderModal } from '../src/query-builder';
import { TaskPanelView } from '../src/sidebar-view';
import { TaskScanner } from '../src/task-scanner';
import { TaskEditModal } from '../src/modals/task-edit-modal';
import { OnboardingModal } from '../src/modals/onboarding-modal';
import { VoiceCapturePreviewModal } from '../src/voice-capture';
import { QuickAddTaskModal } from '../src/modals/quick-capture-modal';

function emptyQuery(): TaskQuery {
  return {
    filters: [], sort: [], groups: [], layout: { hidden: new Set(), shown: new Set() },
    explain: false, errors: [], instructions: [],
  };
}

void test('standards DOM: planning tabs support arrows and maintain ARIA state', (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const container = harness.document.createElement('div');
  harness.document.body.appendChild(container);
  renderPlanningBoard(container, [], { settings: DEFAULT_SETTINGS, todayDate: '2026-07-11' });

  const tabs = Array.from(container.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  assert.equal(tabs.length, 5);
  tabs[0].focus();
  tabs[0].dispatchEvent(new harness.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  assert.equal(harness.document.activeElement, tabs[1]);
  assert.equal(tabs[0].getAttribute('aria-selected'), 'false');
  assert.equal(tabs[1].getAttribute('aria-selected'), 'true');
  assert.equal(tabs[1].tabIndex, 0);
  assert.equal(tabs[0].tabIndex, -1);
});

void test('calendar tabs and month grid expose selection and roving keyboard focus', (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const calendar = harness.document.createElement('section');
  harness.document.body.appendChild(calendar);
  const close = renderCalendar(calendar, [createMockTask()], emptyQuery(), DEFAULT_SETTINGS, async () => undefined, () => undefined, () => undefined);
  context.after(close);

  const tabs = Array.from(calendar.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
  assert.equal(tabs.length, 6);
  assert.equal(tabs.filter((tab) => tab.getAttribute('aria-selected') === 'true').length, 1);
  assert.ok(tabs.every((tab) => Boolean(tab.getAttribute('aria-controls'))));
  const panelId = tabs[0].getAttribute('aria-controls');
  const cells = Array.from(calendar.querySelectorAll<HTMLElement>('[role="gridcell"]'));
  assert.equal(cells.filter((cell) => cell.tabIndex === 0).length, 1);
  const active = cells.find((cell) => cell.tabIndex === 0);
  assert.ok(active);
  const originalDate = active.getAttribute('data-calendar-date');
  active.focus();
  active.dispatchEvent(new harness.window.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  const next = calendar.querySelector<HTMLElement>('[role="gridcell"][tabindex="0"]');
  assert.ok(next);
  assert.notEqual(next.getAttribute('data-calendar-date'), originalDate);
  assert.equal(harness.document.activeElement, next);
  assert.ok(calendar.querySelector('button[aria-label="Previous calendar period"]'));
  assert.ok(calendar.querySelector('button[aria-label="Next calendar period"]'));
  assert.ok(calendar.querySelector('button[aria-label^="Add task for "]'));
  assert.equal(calendar.querySelector('[role="gridcell"] .task-manager-calendar-day-num-clickable'), null);
  tabs[1].click();
  assert.equal(calendar.querySelector('[role="tabpanel"]')?.id, panelId);
});

void test('table popovers expose menu state, Escape dismissal, and focus return', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const table = harness.document.createElement('section');
  harness.document.body.appendChild(table);
  renderTable(table, [createMockTask()], emptyQuery(), DEFAULT_SETTINGS, async () => undefined, () => undefined);

  const grid = table.querySelector<HTMLElement>('[role="grid"]');
  assert.ok(grid);
  assert.equal(grid.getAttribute('aria-rowcount'), '2');
  assert.equal(grid.getAttribute('aria-multiselectable'), 'true');
  assert.ok(Number(grid.getAttribute('aria-colcount')) >= 2);
  assert.equal(grid.querySelectorAll('[role="columnheader"]').length, Number(grid.getAttribute('aria-colcount')));
  assert.equal(grid.querySelectorAll('[role="row"]').length, 2);
  assert.equal(grid.querySelectorAll<HTMLElement>('[role="columnheader"][tabindex="0"], [role="gridcell"][tabindex="0"]').length, 1);
  assert.ok(Array.from(grid.querySelectorAll<HTMLElement>('button, input, select, textarea')).every((control) => control.tabIndex === -1));
  assert.equal(grid.querySelector('tbody tr')?.getAttribute('aria-selected'), 'false');

  const empty = harness.document.createElement('section');
  harness.document.body.appendChild(empty);
  renderTable(empty, [], emptyQuery(), DEFAULT_SETTINGS, async () => undefined, () => undefined);
  const emptyGrid = empty.querySelector<HTMLElement>('[role="grid"]');
  assert.ok(emptyGrid?.querySelector('[role="gridcell"][aria-label="No tasks match the current table filters."]'));
  assert.equal(emptyGrid?.querySelectorAll<HTMLElement>('[role="columnheader"][tabindex="0"], [role="gridcell"][tabindex="0"]').length, 1);

  const columns = Array.from(table.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Columns');
  assert.ok(columns);
  columns.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(columns.getAttribute('aria-expanded'), 'true');
  const columnsMenu = table.querySelector<HTMLElement>('.task-manager-table-columns-menu');
  assert.equal(columnsMenu?.getAttribute('role'), 'dialog');
  columnsMenu?.dispatchEvent(new harness.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(columns.getAttribute('aria-expanded'), 'false');
  assert.equal(harness.document.activeElement, columns);

  const exportButton = Array.from(table.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Export');
  assert.ok(exportButton);
  exportButton.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(exportButton.getAttribute('aria-expanded'), 'true');
  const exportMenu = table.querySelector<HTMLElement>('.task-manager-table-export-menu');
  assert.equal(exportMenu?.getAttribute('role'), 'menu');
  exportMenu?.dispatchEvent(new harness.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(exportButton.getAttribute('aria-expanded'), 'false');
  assert.equal(harness.document.activeElement, exportButton);
});

void test('axe: find, timeline, weekly review, query builder, and Sidebar expose named controls', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const app = {
    vault: { getAbstractFileByPath: () => null, getMarkdownFiles: () => [] },
    workspace: { getLeaf: () => ({ openFile: async () => undefined }) },
    metadataCache: { getFileCache: () => undefined },
  } as unknown as App;
  const task = createMockTask({ normalizedText: 'Accessible task', filePath: 'Inbox.md' });

  const advancedRoot = harness.document.createElement('section');
  const advanced = new AdvancedFindModal(app, () => [task], () => DEFAULT_SETTINGS);
  (advanced as unknown as { contentEl: HTMLElement }).contentEl = advancedRoot;
  advanced.onOpen();
  context.after(() => advanced.onClose());

  const timelineRoot = harness.document.createElement('section');
  renderTimeline(timelineRoot, [task], emptyQuery(), DEFAULT_SETTINGS, async () => undefined, () => undefined);

  const weeklyRoot = harness.document.createElement('section');
  const weekly = new WeeklyReviewModal(app, { ...DEFAULT_SETTINGS, weeklyReviewInboxPath: 'Inbox.md' }, [task]);
  (weekly as unknown as { contentEl: HTMLElement }).contentEl = weeklyRoot;
  weekly.onOpen();
  context.after(() => weekly.onClose());

  const queryRoot = harness.document.createElement('section');
  const queryBuilder = new QueryBuilderModal(app);
  (queryBuilder as unknown as { contentEl: HTMLElement }).contentEl = queryRoot;
  queryBuilder.onOpen();
  context.after(() => queryBuilder.onClose());

  const sidebarRoot = harness.document.createElement('section');
  const sidebar = new TaskPanelView({ app } as unknown as WorkspaceLeaf, () => DEFAULT_SETTINGS, new TaskScanner(app), () => undefined as never);
  Object.assign(sidebar as unknown as { contentEl: HTMLElement; tasks: unknown[] }, { contentEl: sidebarRoot, tasks: [] });
  (sidebar as unknown as { renderView(): void }).renderView();

  const onboardingRoot = harness.document.createElement('section');
  const onboarding = new OnboardingModal(app, {
    createFirstTask: () => undefined,
    openTaskPanel: () => undefined,
    insertOrCopyQuery: () => 'inserted',
    persistSeen: () => undefined,
  });
  (onboarding as unknown as { contentEl: HTMLElement }).contentEl = onboardingRoot;
  onboarding.onOpen();
  context.after(() => onboarding.onClose());

  const quickAddRoot = harness.document.createElement('section');
  const quickAdd = new QuickAddTaskModal(app, DEFAULT_SETTINGS, () => undefined);
  Object.assign(quickAdd, { modalEl: quickAddRoot, contentEl: quickAddRoot });
  quickAdd.onOpen();
  context.after(() => quickAdd.onClose());

  const voiceRoot = harness.document.createElement('section');
  const voice = new VoiceCapturePreviewModal(app, () => DEFAULT_SETTINGS, () => undefined, 'Accessible voice task');
  (voice as unknown as { contentEl: HTMLElement }).contentEl = voiceRoot;
  voice.onOpen();
  context.after(() => voice.onClose());

  harness.document.body.append(advancedRoot, timelineRoot, weeklyRoot, queryRoot, sidebarRoot, onboardingRoot, quickAddRoot, voiceRoot);
  const timelineCheckbox = timelineRoot.querySelector<HTMLInputElement>('input[type="checkbox"]');
  assert.match(timelineCheckbox?.getAttribute('aria-label') ?? '', /Accessible task/u);
  assert.equal(sidebarRoot.querySelector<HTMLInputElement>('.task-manager-panel-search')?.getAttribute('aria-label'), 'Search tasks');
  assert.equal(sidebarRoot.querySelector<HTMLButtonElement>('.task-manager-panel-search-clear')?.getAttribute('aria-label'), 'Clear task search');

  const planning = harness.document.createElement('section');
  const table = harness.document.createElement('section');
  const calendar = harness.document.createElement('section');
  const gantt = harness.document.createElement('section');
  const eisenhower = harness.document.createElement('section');
  const kanban = harness.document.createElement('section');
  harness.document.body.append(planning, table, calendar, gantt, eisenhower, kanban);
  renderPlanningBoard(planning, [task], { settings: DEFAULT_SETTINGS, todayDate: '2026-07-11' }, () => undefined, () => undefined);
  renderTable(table, [task], emptyQuery(), DEFAULT_SETTINGS, async () => undefined, () => undefined);
  const closeCalendar = renderCalendar(calendar, [task], emptyQuery(), DEFAULT_SETTINGS, async () => undefined, () => undefined, () => undefined);
  context.after(closeCalendar);
  renderGantt(gantt, [task], emptyQuery(), DEFAULT_SETTINGS, async () => undefined, () => undefined);
  gantt.querySelector<HTMLButtonElement>('.task-manager-gantt-nav-btn')?.click();
  renderEisenhower(eisenhower, [task], emptyQuery(), DEFAULT_SETTINGS, async () => undefined, () => undefined);
  renderKanban(kanban, [task], emptyQuery(), DEFAULT_SETTINGS, async () => undefined, () => undefined, async () => undefined, () => undefined, { onQuickAdd: async () => undefined });

  const { default: axe } = await import('axe-core');
  const result = await axe.run(harness.document.body, {
    runOnly: { type: 'rule', values: ['aria-allowed-attr', 'aria-required-attr', 'aria-valid-attr-value', 'aria-required-children', 'aria-required-parent', 'aria-roles', 'button-name', 'label', 'select-name'] },
  });
  assert.deepEqual(result.violations.map((violation) => ({ id: violation.id, targets: violation.nodes.map((node) => node.target) })), []);

  const taskEdit = new TaskEditModal(app, structuredClone(DEFAULT_SETTINGS), '- [ ] Axe task', () => undefined);
  const taskModalEl = harness.document.createElement('section');
  const taskContentEl = harness.document.createElement('div');
  taskModalEl.appendChild(taskContentEl);
  Object.assign(taskEdit, { modalEl: taskModalEl, contentEl: taskContentEl });
  harness.document.body.appendChild(taskModalEl);
  taskEdit.onOpen();
  context.after(() => taskEdit.onClose());
  const nestedRules = ['aria-dialog-name', 'aria-hidden-focus', 'aria-allowed-attr', 'aria-required-attr', 'button-name', 'label', 'select-name', 'duplicate-id', 'duplicate-id-aria'];
  let nestedResult = await axe.run(harness.document.body, { runOnly: { type: 'rule', values: nestedRules } });
  assert.deepEqual(nestedResult.violations.map((violation) => ({ id: violation.id, targets: violation.nodes.map((node) => node.target) })), []);
  const fieldsOpener = Array.from(taskContentEl.querySelectorAll<HTMLButtonElement>('button')).find((button) => /Fields/u.test(button.textContent ?? ''));
  fieldsOpener?.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  nestedResult = await axe.run(harness.document.body, { runOnly: { type: 'rule', values: nestedRules } });
  assert.deepEqual(nestedResult.violations.map((violation) => ({ id: violation.id, targets: violation.nodes.map((node) => node.target) })), []);
  harness.document.querySelector<HTMLElement>('.task-manager-visible-fields-modal .modal-content')?.dispatchEvent(new harness.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
});

void test('visible fields is a separate named modal with contained focus and Escape discard', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const app = { vault: { getMarkdownFiles: () => [], getAbstractFileByPath: () => null }, metadataCache: { getFileCache: () => undefined } } as unknown as App;
  const settings = structuredClone(DEFAULT_SETTINGS);
  const originalPriority = settings.modalFields.priority;
  const parent = new (await import('../src/modals/task-edit-modal')).TaskEditModal(app, settings, '- [ ] Accessible', () => undefined);
  const modalEl = harness.document.createElement('section');
  const contentEl = harness.document.createElement('div');
  modalEl.appendChild(contentEl);
  Object.assign(parent, { modalEl, contentEl });
  harness.document.body.appendChild(modalEl);
  parent.onOpen();
  const opener = Array.from(contentEl.querySelectorAll<HTMLButtonElement>('button')).find((button) => /Fields/u.test(button.textContent ?? ''));
  assert.ok(opener);
  opener.focus();
  opener.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const child = harness.document.querySelector<HTMLElement>('.task-manager-visible-fields-modal');
  assert.ok(child);
  assert.equal(child.getAttribute('role'), 'dialog');
  assert.equal(child.getAttribute('aria-modal'), 'true');
  assert.ok(child.getAttribute('aria-labelledby'));
  assert.ok(child.getAttribute('aria-describedby'));
  assert.equal(modalEl.getAttribute('aria-hidden'), 'true');
  assert.ok(modalEl.hasAttribute('inert'));
  const toggles = Array.from(child.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')) as Array<HTMLInputElement & { _onChange?: (value: boolean) => void }>;
  assert.ok(toggles.length > 0);
  assert.ok(toggles.every((toggle) => Boolean(toggle.getAttribute('aria-label'))));
  assert.equal(harness.document.activeElement, toggles[0]);
  const focusable = Array.from(child.querySelectorAll<HTMLElement>('button, input'));
  const last = focusable.at(-1);
  assert.ok(last);
  last.focus();
  last.dispatchEvent(new harness.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }));
  assert.equal(harness.document.activeElement, toggles[0]);
  toggles[0]._onChange?.(!originalPriority);
  child.querySelector<HTMLElement>('.modal-content')?.dispatchEvent(new harness.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(harness.document.querySelector('.task-manager-visible-fields-modal'), null);
  assert.equal(settings.modalFields.priority, originalPriority);
  assert.equal(modalEl.hasAttribute('inert'), false);
  assert.equal(modalEl.hasAttribute('aria-hidden'), false);
  assert.equal(harness.document.activeElement, opener);
  parent.onClose();
});

void test('visible fields awaits one atomic save and announces save failure without closing', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const app = { vault: { getMarkdownFiles: () => [], getAbstractFileByPath: () => null }, metadataCache: { getFileCache: () => undefined } } as unknown as App;
  const settings = structuredClone(DEFAULT_SETTINGS);
  let saveCalls = 0;
  let fail = true;
  const parent = new (await import('../src/modals/task-edit-modal')).TaskEditModal(app, settings, '- [ ] Save fields', () => undefined, undefined, {}, undefined, async () => {
    saveCalls += 1;
    if (fail) throw new Error('disk unavailable');
  });
  const modalEl = harness.document.createElement('section');
  const contentEl = harness.document.createElement('div');
  modalEl.appendChild(contentEl);
  Object.assign(parent, { modalEl, contentEl });
  harness.document.body.appendChild(modalEl);
  parent.onOpen();
  const opener = Array.from(contentEl.querySelectorAll<HTMLButtonElement>('button')).find((button) => /Fields/u.test(button.textContent ?? ''));
  assert.ok(opener);
  opener.click();
  let child = harness.document.querySelector<HTMLElement>('.task-manager-visible-fields-modal');
  assert.ok(child);
  const toggle = child.querySelector<HTMLInputElement>('input[type="checkbox"]') as HTMLInputElement & { _onChange?: (value: boolean) => void };
  const original = settings.modalFields.priority;
  toggle._onChange?.(!original);
  const done = Array.from(child.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Done');
  assert.ok(done);
  done.click();
  done.click();
  const childModal = (parent as unknown as { childModal?: { close(): void } }).childModal;
  assert.ok(childModal);
  childModal.close();
  assert.ok(harness.document.querySelector('.task-manager-visible-fields-modal'), 'generic close is blocked while the atomic save is pending');
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(saveCalls, 1);
  assert.equal(settings.modalFields.priority, original, 'failed save rolls back settings');
  child = harness.document.querySelector<HTMLElement>('.task-manager-visible-fields-modal');
  assert.ok(child, 'failed save leaves modal open');
  assert.match(child.querySelector('.task-manager-visible-fields-error')?.textContent ?? '', /disk unavailable/u);
  fail = false;
  Array.from(child.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Done')?.click();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(saveCalls, 2);
  assert.equal(settings.modalFields.priority, !original);
  assert.equal(harness.document.querySelector('.task-manager-visible-fields-modal'), null);
  assert.equal(harness.document.activeElement, opener);
  parent.onClose();
});

void test('closing Task Edit with Visible fields open clears parent accessibility state and draft', (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const app = { vault: { getMarkdownFiles: () => [], getAbstractFileByPath: () => null }, metadataCache: { getFileCache: () => undefined } } as unknown as App;
  const parent = new TaskEditModal(app, structuredClone(DEFAULT_SETTINGS), '- [ ] Parent close', () => undefined);
  const modalEl = harness.document.createElement('section');
  const contentEl = harness.document.createElement('div');
  modalEl.appendChild(contentEl);
  Object.assign(parent, { modalEl, contentEl });
  harness.document.body.appendChild(modalEl);
  parent.onOpen();
  const opener = Array.from(contentEl.querySelectorAll<HTMLButtonElement>('button')).find((button) => /Fields/u.test(button.textContent ?? ''));
  assert.ok(opener);
  opener.click();
  assert.ok(harness.document.querySelector('.task-manager-visible-fields-modal'));
  assert.equal(modalEl.getAttribute('aria-hidden'), 'true');
  assert.ok(modalEl.hasAttribute('inert'));

  parent.onClose();
  assert.equal(harness.document.querySelector('.task-manager-visible-fields-modal'), null);
  assert.equal(modalEl.hasAttribute('inert'), false);
  assert.equal(modalEl.hasAttribute('aria-hidden'), false);
  const internals = parent as unknown as { initialDraft: unknown; focusTrap: unknown; childModal: unknown };
  assert.equal(internals.initialDraft, null);
  assert.equal(internals.focusTrap, null);
  assert.equal(internals.childModal, null);

  parent.onOpen();
  assert.equal(modalEl.hasAttribute('inert'), false);
  assert.equal(modalEl.hasAttribute('aria-hidden'), false);
  parent.onClose();
});
