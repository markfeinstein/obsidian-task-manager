import test from 'node:test';
import assert from 'node:assert/strict';
import { calendarMonthLabel, calendarWeekdayLabels, DatePickerModal, DateTabsModal, isTaskLineToolbarEligible, parseNaturalDateInstruction, parseTimeInput, taskLineToolbarCheckbox } from '../src/task-line-toolbar';
import { installDomHarness } from './dom-harness';
import type { App } from 'obsidian';

test('task line toolbar: detects only real task checkboxes, not markdown links', () => {
  assert.equal(taskLineToolbarCheckbox('- [ ] Real task'), ' ');
  assert.equal(taskLineToolbarCheckbox('- [/] In progress task'), '/');
  assert.equal(taskLineToolbarCheckbox('- [[01 Demo Tasks]] has sample tasks'), null);
  assert.equal(taskLineToolbarCheckbox('- [01 Demo Tasks](01 Demo Tasks.md) has sample tasks'), null);
  assert.equal(taskLineToolbarCheckbox('- [plain bracket link] has text'), null);
  assert.equal(isTaskLineToolbarEligible('- [ ] Real task'), true);
  assert.equal(isTaskLineToolbarEligible('- [x] Done task'), false);
});

test('task line toolbar calendar labels use centralized locale-aware formatters', () => {
  assert.equal(calendarMonthLabel(2026, 6), new Intl.DateTimeFormat('en', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date('2026-07-01T00:00:00.000Z')));
  assert.deepEqual(calendarWeekdayLabels(), Array.from({ length: 7 }, (_value, index) => new Intl.DateTimeFormat('en', { weekday: 'short', timeZone: 'UTC' }).format(new Date(`2023-01-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`))));
});

test('task line date modals render localized calendars and exercise accessible non-drag controls', (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const mount = <T extends { onOpen(): void }>(modal: T): { modal: T; content: HTMLElement } => {
    const modalEl = harness.document.createElement('section');
    const content = harness.document.createElement('div');
    modalEl.appendChild(content);
    Object.assign(modal, { modalEl, contentEl: content });
    modal.onOpen();
    return { modal, content };
  };

  let selected = '';
  const picker = mount(new DatePickerModal({} as App, 'Due date', (value) => { selected = value; }));
  assert.ok(picker.content.querySelector('.task-date-picker-cal-month')?.textContent);
  assert.equal(picker.content.querySelectorAll('.task-date-picker-cal-label').length, 7);
  const pickerPrivate = picker.modal as unknown as { viewMonth: number; viewYear: number; renderCalendar(): void };
  pickerPrivate.viewMonth = 0; pickerPrivate.viewYear = 2026; pickerPrivate.renderCalendar();
  picker.content.querySelector<HTMLButtonElement>('.task-date-picker-nav')?.click();
  assert.match(picker.content.querySelector('.task-date-picker-cal-month')?.textContent ?? '', /December 2025/u);
  pickerPrivate.viewMonth = 11; pickerPrivate.viewYear = 2026; pickerPrivate.renderCalendar();
  picker.content.querySelectorAll<HTMLButtonElement>('.task-date-picker-nav')[1]?.click();
  assert.match(picker.content.querySelector('.task-date-picker-cal-month')?.textContent ?? '', /January 2027/u);
  pickerPrivate.viewMonth = 5; pickerPrivate.renderCalendar();
  picker.content.querySelector<HTMLButtonElement>('.task-date-picker-nav')?.click();
  picker.content.querySelectorAll<HTMLButtonElement>('.task-date-picker-nav')[1]?.click();
  picker.content.querySelector<HTMLButtonElement>('.task-date-picker-cal-day')?.click();
  assert.match(selected, /^2027-06-/u);

  let applied = 0;
  const tabs = mount(new DateTabsModal({} as App, '- [ ] Task 📅 2026-07-13', () => { applied += 1; }));
  assert.equal(tabs.content.querySelectorAll('.task-date-picker-cal-label').length, 7);
  const nl = tabs.content.querySelector<HTMLInputElement>('.task-dates-nl-input');
  const parse = tabs.content.querySelector<HTMLButtonElement>('.task-dates-nl-btn');
  assert.ok(nl && parse);
  const feedback = tabs.content.querySelector<HTMLElement>('.task-dates-nl-feedback');
  if (feedback) (feedback as HTMLElement & { toggle(value: boolean): void }).toggle = (value) => { feedback.hidden = !value; };
  nl.value = ''; parse.click();
  nl.value = 'nonsense'; parse.click();
  assert.match(tabs.content.querySelector('.task-dates-nl-feedback')?.textContent ?? '', /Couldn't understand/u);
  nl.value = 'scheduled tomorrow, start next week, due next month, ignored words'; parse.click();
  assert.match(tabs.content.querySelector('.task-dates-nl-feedback')?.textContent ?? '', /Set/u);
  for (const tab of Array.from(tabs.content.querySelectorAll<HTMLButtonElement>('.task-dates-tab'))) tab.click();
  tabs.content.querySelector<HTMLButtonElement>('.task-date-picker-quick-nodate')?.click();
  tabs.content.querySelector<HTMLButtonElement>('.task-date-picker-quick-btn:not(.task-date-picker-quick-nodate)')?.click();
  const tabPrivate = tabs.modal as unknown as { viewMonth: number; viewYear: number; renderTabContent(): void };
  tabPrivate.viewMonth = 0; tabPrivate.viewYear = 2026; tabPrivate.renderTabContent();
  tabs.content.querySelector<HTMLButtonElement>('.task-date-picker-nav')?.click();
  tabPrivate.viewMonth = 11; tabPrivate.viewYear = 2026; tabPrivate.renderTabContent();
  tabs.content.querySelectorAll<HTMLButtonElement>('.task-date-picker-nav')[1]?.click();
  tabPrivate.viewMonth = 5; tabPrivate.renderTabContent();
  tabs.content.querySelector<HTMLButtonElement>('.task-date-picker-nav')?.click();
  tabs.content.querySelectorAll<HTMLButtonElement>('.task-date-picker-nav')[1]?.click();
  tabs.content.querySelector<HTMLElement>('.task-date-picker-cal-month')?.click();
  for (const key of ['t', 'ArrowRight', 'ArrowLeft', 'ArrowUp', 'ArrowDown', 'PageUp', 'PageDown']) {
    tabs.content.dispatchEvent(new harness.window.KeyboardEvent('keydown', { key, bubbles: true }));
  }
  const time = tabs.content.querySelector<HTMLInputElement>('.task-dates-time-input');
  if (time) time.value = 'invalid';
  tabs.content.querySelector<HTMLButtonElement>('.task-dates-apply')?.click();
  assert.equal(applied, 0);
  if (time) time.value = '2pm';
  tabs.content.querySelector<HTMLButtonElement>('.task-dates-apply')?.click();

  const validTabs = mount(new DateTabsModal({} as App, '- [ ] Fresh task 📅 2026-07-13', () => { applied += 1; }));
  const validTime = validTabs.content.querySelector<HTMLInputElement>('.task-dates-time-input');
  if (validTime) validTime.value = '2pm';
  validTabs.content.querySelector<HTMLButtonElement>('.task-dates-apply')?.click();
  assert.equal(applied, 1);
});

test('parseNaturalDateInstruction: rejects impossible calendar dates', () => {
  for (const input of ['due 2026-02-31', 'due Feb 31', 'due 2/31/2026']) {
    const parsed = parseNaturalDateInstruction(input);
    assert.deepEqual(parsed.results, {}, `${input} should not roll over into a different date`);
    assert.deepEqual(parsed.order, []);
    assert.deepEqual(parsed.unmatched, [input]);
  }
});

test('parseNaturalDateInstruction: still accepts valid explicit dates', () => {
  assert.deepEqual(parseNaturalDateInstruction('due 2026-02-28').results.due, { iso: '2026-02-28', time: '' });
  assert.deepEqual(parseNaturalDateInstruction('due Feb 28').order, ['due']);
  assert.deepEqual(parseNaturalDateInstruction('due 2/28/2026').results.due, { iso: '2026-02-28', time: '' });
});

test('parseNaturalDateInstruction: applies unlabeled time-only segments to previous field', () => {
  const parsed = parseNaturalDateInstruction('due friday, 2pm');
  assert.equal(parsed.results.due?.time, '14:00');
  assert.deepEqual(parsed.unmatched, []);
});

test('parseNaturalDateInstruction: this week stays in the current week', () => {
  const originalDate = Date;
  const fixedNow = new originalDate(2026, 5, 3, 12, 0, 0);
  globalThis.Date = class extends originalDate {
    constructor(value?: string | number | Date) {
      super(value ?? fixedNow.getTime());
    }

    static now(): number { return fixedNow.getTime(); }
  } as DateConstructor;

  try {
    assert.equal(parseNaturalDateInstruction('due this week').results.due?.iso, '2026-06-03');
    assert.equal(parseNaturalDateInstruction('due next week').results.due?.iso, '2026-06-08');
  } finally {
    globalThis.Date = originalDate;
  }
});

test('parseNaturalDateInstruction: in N months clamps at month end', () => {
  const originalDate = Date;
  const fixedNow = new originalDate(2026, 0, 31, 12, 0, 0);
  globalThis.Date = class extends originalDate {
    constructor(value?: string | number | Date) {
      super(value ?? fixedNow.getTime());
    }

    static now(): number { return fixedNow.getTime(); }
  } as DateConstructor;

  try {
    assert.equal(parseNaturalDateInstruction('due in 1 month').results.due?.iso, '2026-02-28');
    assert.equal(parseNaturalDateInstruction('due in 2 months').results.due?.iso, '2026-03-31');
  } finally {
    globalThis.Date = originalDate;
  }
});

test('parseTimeInput: normalizes friendly times before writing task metadata', () => {
  assert.equal(parseTimeInput('3pm'), '15:00');
  assert.equal(parseTimeInput('3:30 pm'), '15:30');
  assert.equal(parseTimeInput('noon'), '12:00');
  assert.equal(parseTimeInput('24:00'), null);
});
