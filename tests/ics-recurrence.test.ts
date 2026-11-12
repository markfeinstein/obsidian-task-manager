import test from 'node:test';
import assert from 'node:assert/strict';
import ICAL from 'ical.js';
import TaskManagerPlugin from '../src/main';
import type { ParsedTask } from '../src/task-scanner';
import { fromICSRecurrenceRule, toICSRecurrenceRule } from '../src/ics-recurrence';
import { calendarEventToTaskLine, formatCalendarICS, generateVTODO } from '../src/caldav-sync';
import { parseMarkdownTaskLine } from '../src/task-model';

function occurrences(rule: string, start = '2026-11-09', count = 3): string[] {
  const parsed = ICAL.Recur.fromString(rule);
  const iterator = parsed.iterator(ICAL.Time.fromDateString(start));
  const values: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const next = iterator.next();
    if (!next) break;
    values.push(next.toString());
  }
  return values;
}

test('calendar export command exercises the shared serializer with valid VTODO status and DTSTAMP', async () => {
  let written = '';
  const tasks = ['- [ ] Open 📅 2026-11-10', '- [x] Complete ✅ 2026-11-09', '- [-] Cancelled', '- [ ] Private [exclude_from_sync:: true]'].map((line, index) => parseMarkdownTaskLine(line, 'Tasks.md', index + 1)).filter((task): task is ParsedTask => task !== null);
  const plugin = Object.create(TaskManagerPlugin.prototype) as unknown as { app: unknown; scanVaultTasks(): Promise<ParsedTask[]>; exportTasksIcal(): Promise<void> };
  plugin.scanVaultTasks = async () => tasks;
  plugin.app = { vault: { adapter: { write: async (path: string, content: string) => { assert.equal(path, 'Tasks Export.ics'); written = content; } } } };
  await plugin.exportTasksIcal();
  const calendar = new ICAL.Component(ICAL.parse(written));
  const todos = calendar.getAllSubcomponents('vtodo');
  assert.equal(todos.length, 2);
  assert.ok(todos.every((component) => component.getFirstProperty('dtstamp')));
  assert.deepEqual(todos.map((component) => component.getFirstPropertyValue('status')), ['NEEDS-ACTION', 'COMPLETED']);
  assert.equal(calendar.getAllSubcomponents('vevent').length, 0);
});

test('ICS recurrence is parsed and independently expanded by ical.js, not the plugin parser', () => {
  assert.deepEqual(occurrences(toICSRecurrenceRule('every day')), ['2026-11-09', '2026-11-10', '2026-11-11']);
  assert.deepEqual(occurrences(toICSRecurrenceRule('every 2 weeks on Monday')), ['2026-11-09', '2026-11-23', '2026-12-07']);
  assert.deepEqual(occurrences(toICSRecurrenceRule('every Monday and Friday')), ['2026-11-09', '2026-11-13', '2026-11-16']);
  assert.deepEqual(occurrences(toICSRecurrenceRule('every weekday'), '2026-11-13'), ['2026-11-13', '2026-11-16', '2026-11-17']);
  assert.deepEqual(occurrences(toICSRecurrenceRule('daily for 2 times')), ['2026-11-09', '2026-11-10']);
  assert.deepEqual(occurrences(toICSRecurrenceRule('every day until 2026-11-10')), ['2026-11-09', '2026-11-10']);
  assert.deepEqual(occurrences(toICSRecurrenceRule('every month on day 15'), '2026-11-15'), ['2026-11-15', '2026-12-15', '2027-01-15']);
  assert.match(toICSRecurrenceRule('every other year'), /^FREQ=YEARLY;INTERVAL=2$/u);
  assert.match(toICSRecurrenceRule('every day', { until: '2026-11-10', timed: true }), /UNTIL=20261110T235959$/u);
});

test('generated VTODO exports contain a real RFC recurrence, honor remaining counts, and keep collection METHOD absent', () => {
  const task = parseMarkdownTaskLine('- [ ] Repeat 🔁 every day for 5 times ⏳ 2026-11-09 [recurrenceCount:: 3]', 'Tasks.md', 1);
  assert.ok(task);
  const calendar = new ICAL.Component(ICAL.parse(formatCalendarICS([generateVTODO(task)])));
  const component = calendar.getFirstSubcomponent('vtodo');
  assert.ok(component);
  const rule = component.getFirstPropertyValue('rrule') as ICAL.Recur;
  assert.equal(rule.freq, 'DAILY');
  assert.equal(rule.count, 2);
  assert.equal(calendar.getFirstProperty('method'), null);
});

test('ICS exports fail closed for unsupported, ambiguous, malformed, or completion-relative rules', () => {
  for (const rule of ['every day when done', 'every -1 days', 'every 0 days', 'every 2 weekdays', 'every moon', 'every month on day 31', 'every week on someday', 'every day on Monday', 'every day until 2026-02-30', 'every day for 0 times', 'every day until 2026-11-10 for 3 times', 'FREQ=HOURLY', 'FREQ=DAILY;FREQ=WEEKLY', 'FREQ=DAILY;COUNT=0', 'FREQ=DAILY;UNTIL=20260230', 'FREQ=DAILY;UNTIL=20261110T250000Z', 'FREQ=WEEKLY;BYMONTHDAY=4', 'FREQ=WEEKLY;BYDAY=1MO', 'FREQ=DAILY;BYMONTH=13', 'FREQ=DAILY;COUNT=2;UNTIL=20261110', 'FREQ=DAILY;INTERVAL=abc', 'FREQ=DAILY;BYHOUR=9', 'FREQ=DAILY\r\nSUMMARY:Injected', '']) {
    assert.throws(() => toICSRecurrenceRule(rule), Error, rule);
  }
  assert.throws(() => toICSRecurrenceRule('every month', { anchor: '2026-01-31' }), /Clamped/u);
  assert.throws(() => toICSRecurrenceRule('every year', { anchor: '2024-02-29' }), /Clamped/u);
});

test('supported RFC fields are preserved and supported imports become executable local recurrence', () => {
  for (const rule of ['FREQ=MONTHLY;BYDAY=-1FR;WKST=MO', 'FREQ=YEARLY;BYMONTH=2,6;BYMONTHDAY=-1', 'FREQ=DAILY;COUNT=3', 'FREQ=DAILY;UNTIL=20261110T235959Z']) assert.equal(toICSRecurrenceRule(rule), rule);
  assert.equal(fromICSRecurrenceRule('FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,FR;COUNT=3'), 'every 2 weeks on monday and friday for 3 times');
  assert.equal(fromICSRecurrenceRule('FREQ=MONTHLY;BYMONTHDAY=15;UNTIL=20261130'), 'every month on day 15 until 2026-11-30');
  for (const rule of ['FREQ=MONTHLY;BYDAY=-1FR', 'FREQ=YEARLY;BYMONTH=2', 'FREQ=DAILY;WKST=SU', 'FREQ=MONTHLY;BYMONTHDAY=31', 'FREQ=DAILY;UNTIL=20261110T120000Z', 'invalid']) assert.equal(fromICSRecurrenceRule(rule), undefined);
  assert.match(calendarEventToTaskLine({ uid: 'remote', summary: 'Repeat', rrule: 'FREQ=WEEKLY' }), /🔁 every week/u);
  const unsupported = calendarEventToTaskLine({ uid: 'remote', summary: 'Repeat', rrule: 'FREQ=MONTHLY;BYDAY=-1FR' });
  assert.doesNotMatch(unsupported, /🔁/u);
  assert.match(unsupported, /\[caldav_rrule:: FREQ%3DMONTHLY%3BBYDAY%3D-1FR\]/u);
});
