import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesWeeklyReviewInboxPath, WeeklyReviewModal } from '../src/modals/weekly-review-modal';
import type { App } from 'obsidian';
import { DEFAULT_SETTINGS } from '../src/types';
import { createMockTask } from './test-utils';
import { installDomHarness } from './dom-harness';

test('weekly review inbox matching requires the configured note path, not a substring', () => {
  assert.equal(matchesWeeklyReviewInboxPath('Inbox.md', 'Inbox.md'), true);
  assert.equal(matchesWeeklyReviewInboxPath('Inbox.md', 'Inbox'), true);
  assert.equal(matchesWeeklyReviewInboxPath('Projects/Inbox-old.md', 'Inbox.md'), false);
  assert.equal(matchesWeeklyReviewInboxPath('Projects/Inbox-old.md', 'Inbox'), false);
});

test('weekly review preserves its shell and focuses the step heading across navigation', (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const content = harness.document.createElement('div');
  harness.document.body.appendChild(content);
  const tasks = [
    createMockTask({ key: 'overdue', normalizedText: 'Overdue report', filePath: 'Projects/Report.md', metadata: { ...createMockTask().metadata, dates: { due: '2000-01-01' } } }),
    createMockTask({ key: 'inbox', normalizedText: 'Inbox item', filePath: 'Inbox.md' }),
    createMockTask({ key: 'undated', normalizedText: 'Undated item', filePath: 'Notes/Undated.md' }),
  ];
  const app = { vault: { getAbstractFileByPath: () => null }, workspace: { getLeaf: () => ({ openFile: async () => undefined }) } } as unknown as App;
  const modal = new WeeklyReviewModal(app, { ...DEFAULT_SETTINGS, weeklyReviewInboxPath: 'Inbox.md' }, tasks);
  (modal as unknown as { contentEl: HTMLElement }).contentEl = content;
  modal.onOpen();

  const status = content.querySelector<HTMLElement>('.weekly-review-progress');
  const heading = content.querySelector<HTMLElement>('.weekly-review-step-heading');
  const panel = content.querySelector<HTMLElement>('.weekly-review-panel');
  const navigation = content.querySelector<HTMLElement>('.weekly-review-btns');
  const buttons = Array.from(navigation?.querySelectorAll<HTMLButtonElement>('button') ?? []);
  assert.ok(status && heading && panel && navigation);
  assert.equal(status.getAttribute('role'), 'status');
  assert.equal(status.getAttribute('aria-live'), 'polite');
  assert.equal(status.textContent, 'Step 1 of 3');
  assert.equal(heading.tabIndex, -1);

  buttons[1].click();
  assert.equal(content.querySelector('.weekly-review-progress'), status);
  assert.equal(content.querySelector('.weekly-review-step-heading'), heading);
  assert.equal(content.querySelector('.weekly-review-panel'), panel);
  assert.equal(content.querySelector('.weekly-review-btns'), navigation);
  assert.equal(status.textContent, 'Step 2 of 3');
  assert.equal(harness.document.activeElement, heading);

  buttons[0].click();
  assert.equal(status.textContent, 'Step 1 of 3');
  assert.equal(harness.document.activeElement, heading);
});

test('weekly review requires every page to be visited before advancing', (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const content = harness.document.createElement('div');
  harness.document.body.appendChild(content);
  const base = createMockTask();
  const tasks = Array.from({ length: 21 }, (_value, index) => createMockTask({
    key: `overdue-${index}`,
    normalizedText: `Overdue ${index}`,
    filePath: `Projects/${index}.md`,
    metadata: { ...base.metadata, dates: { due: '2000-01-01' } },
  }));
  const modal = new WeeklyReviewModal({ vault: { getAbstractFileByPath: () => null }, workspace: {} } as unknown as App, DEFAULT_SETTINGS, tasks);
  (modal as unknown as { contentEl: HTMLElement }).contentEl = content;
  modal.onOpen();
  const reviewNext = content.querySelector<HTMLButtonElement>('.weekly-review-btns .mod-cta');
  const pageNext = Array.from(content.querySelectorAll<HTMLButtonElement>('.weekly-review-pager button')).at(-1);
  assert.equal(content.querySelectorAll('.weekly-review-open-btn').length, 20);
  assert.equal(reviewNext?.disabled, true);
  pageNext?.click();
  assert.equal(content.querySelectorAll('.weekly-review-open-btn').length, 1);
  assert.equal(reviewNext?.disabled, false);
});

test('weekly review open buttons have distinct task-specific accessible names', (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const content = harness.document.createElement('div');
  harness.document.body.appendChild(content);
  const base = createMockTask();
  const tasks = [
    createMockTask({ key: 'one', normalizedText: 'First task', filePath: 'Inbox.md', metadata: { ...base.metadata, dates: { due: '2000-01-01' } } }),
    createMockTask({ key: 'two', normalizedText: 'Second task', filePath: 'Projects/Second.md', metadata: { ...base.metadata, dates: { due: '2000-01-02' } } }),
  ];
  const modal = new WeeklyReviewModal({ vault: { getAbstractFileByPath: () => null }, workspace: {} } as unknown as App, DEFAULT_SETTINGS, tasks);
  (modal as unknown as { contentEl: HTMLElement }).contentEl = content;
  modal.onOpen();
  const labels = Array.from(content.querySelectorAll<HTMLButtonElement>('.weekly-review-open-btn')).map((button) => button.getAttribute('aria-label'));
  assert.deepEqual(labels, ['Open First task in Inbox', 'Open Second task in Second']);
  assert.equal(new Set(labels).size, labels.length);
});
