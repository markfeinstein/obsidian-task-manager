import test from 'node:test';
import assert from 'node:assert/strict';
import { ReminderIndex, reminderIdentityKey } from '../src/reminder-index';
import { TaskIndex } from '../src/task-index';
import { TaskScanner } from '../src/task-scanner';
import type { ParsedTask } from '../src/task-scanner';

function task(path: string, line: number, id?: string): ParsedTask {
  const key = id ? `id:${id}` : `${path}:remind`;
  return {
    key, stableKey: id ? key : undefined, filePath: path, lineNumber: line, rawLine: `- [ ] Remind me ⏰ 2026-07-12 09:00${id ? ` 🆔 ${id}` : ''}`,
    linePrefix: '', indentation: '', listMarker: '-', checkbox: ' ', body: 'Remind me', normalizedText: 'Remind me', status: 'todo', tags: [], contexts: [],
    metadata: { ...(id ? { id } : {}), reminder: '2026-07-12 09:00', dates: {}, invalidDates: {}, priority: 'normal', dependsOn: [] },
  };
}

test('single-digit reminder hours are canonical, due on time, and retain stored reminder identities', () => {
  const scanner = new TaskScanner({} as never);
  for (const metadata of ['⏰ 2026-11-09 9:00', '[reminder:: 2026-11-09 9:00]', '⏰ [[2026-11-09 9:00]]']) {
    const parsed = scanner.parseTaskLine(`- [ ] Remind ${metadata} 🆔 stable`, 'A.md', 1);
    assert.ok(parsed);
    assert.equal(parsed.metadata.reminder, '2026-11-09 09:00');
    const index = new TaskIndex(); index.beginHydration();
    index.commit(new Map([['A.md', [parsed]]])); index.markReady();
    const reminders = new ReminderIndex(index);
    assert.equal(reminders.migrateLegacyKey('v2\0id\0stable\0' + '2026-11-09 9:00'), reminderIdentityKey(parsed));
    assert.equal(reminders.keyForStoredRecord({ reminderKey: 'A.md:1:2026-11-09 9:00', taskFilePath: 'A.md', taskLineNumber: 1, taskText: parsed.rawLine }), reminderIdentityKey(parsed));
    assert.equal(reminders.claimDue('2026-11-09 09:30').length, 1);
    reminders.dispose();
  }
});

test('stale heap nodes are bounded without rescheduling acknowledged reminders', () => {
  const index = new TaskIndex(); index.beginHydration();
  const initial = task('A.md', 1, 'stable');
  index.commit(new Map([['A.md', [initial]]])); index.markReady();
  const reminders = new ReminderIndex(index);
  for (let revision = 0; revision < 1_000; revision++) {
    index.commit(new Map([['A.md', [{ ...initial, normalizedText: `Revision ${revision}` }]]]));
  }
  assert.ok((reminders as unknown as { heap: unknown[] }).heap.length <= 66);
  const claims = reminders.claimDue('2026-07-12 09:00');
  assert.equal(claims.length, 1);
  reminders.ackDue(claims);
  assert.equal(reminders.claimDue('2026-07-12 09:00').length, 0);
  reminders.dispose();
});

function reminderKey(taskValue: ParsedTask): string {
  const key = reminderIdentityKey(taskValue);
  assert.ok(key);
  return key;
}

test('ReminderIndex refuses partial hydration', () => {
  const index = new TaskIndex(); index.beginHydration();
  index.commit(new Map([['A.md', [task('A.md', 1, 'partial')]]]));
  assert.throws(() => new ReminderIndex(index), /fully ready/u);
});

test('ReminderIndex follows explicit IDs across files and fallback identity across line shifts', () => {
  const index = new TaskIndex(); index.beginHydration();
  const explicit = task('A.md', 1, 'stable'); const fallback = task('A.md', 2);
  index.commit(new Map([['A.md', [explicit, fallback]]])); index.markReady();
  const reminders = new ReminderIndex(index);
  const explicitKey = reminderKey(explicit); const fallbackKey = reminderKey(fallback);
  assert.equal(reminders.resolve(explicitKey)?.task.filePath, 'A.md');
  const moved = { ...explicit, filePath: 'B.md', lineNumber: 7 };
  const shifted = { ...fallback, lineNumber: 9 };
  index.commit(new Map([['A.md', [shifted]], ['B.md', [moved]]]));
  assert.equal(reminders.resolve(explicitKey)?.task.filePath, 'B.md');
  assert.equal(reminders.resolve(fallbackKey)?.task.lineNumber, 9);
  assert.equal(reminders.migrateLegacyKey('A.md:2:2026-07-12 09:00'), fallbackKey, 'legacy same-file keys migrate after a line shift');
  assert.equal(reminders.keyForStoredRecord({
    reminderKey: 'A.md:2:2026-07-12 09:00', taskFilePath: 'A.md', taskLineNumber: 2,
    taskText: fallback.rawLine, originalReminderTime: '2026-07-12 09:00',
  }), fallbackKey);
  const claims = reminders.claimDue('2026-07-12 09:00');
  assert.equal(claims.length, 2);
  reminders.ackDue(claims);
  reminders.dispose();
});

test('ReminderIndex fails closed as explicit ID uniqueness changes across revisions', () => {
  const index = new TaskIndex(); index.beginHydration();
  const first = task('A.md', 1, 'duplicate'); const second = task('B.md', 1, 'duplicate');
  index.commit(new Map([['A.md', [first]]]));
  index.markReady();
  const reminders = new ReminderIndex(index);
  assert.equal(reminders.resolve(reminderKey(first))?.task.filePath, 'A.md');

  index.commit(new Map([['B.md', [second]]]));
  assert.equal(reminders.resolve(reminderKey(first)), undefined, 'introducing a duplicate suppresses the old owner');

  index.commit(new Map([['B.md', []]]));
  assert.equal(reminders.resolve(reminderKey(first))?.task.filePath, 'A.md', 'removing the duplicate restores the unique owner');
  reminders.dispose();
});

test('ReminderIndex rejects colliding fallback identities and malformed dates', () => {
  const index = new TaskIndex(); index.beginHydration();
  const first = task('A.md', 1); const second = task('A.md', 2);
  const malformed = { ...task('A.md', 3), key: 'A.md:bad', rawLine: '- [ ] Bad ⏰ 2026-99-99', metadata: { ...task('A.md', 3).metadata, reminder: '2026-99-99' } };
  index.commit(new Map([['A.md', [first, second, malformed]]]));
  index.markReady();
  const reminders = new ReminderIndex(index);
  assert.equal(reminders.claimDue('9999-12-31 23:59').length, 0);
  reminders.dispose();
});

test('ReminderIndex claims are exclusive, retryable, and acknowledged explicitly', () => {
  const index = new TaskIndex(); index.beginHydration();
  const first = task('A.md', 1, 'first');
  const second = { ...task('B.md', 1, 'second'), rawLine: '- [ ] Second ⏰ 2026-07-12 08:00 🆔 second', metadata: { ...task('B.md', 1, 'second').metadata, reminder: '2026-07-12 08:00' } };
  index.commit(new Map([['A.md', [first]], ['B.md', [second]]])); index.markReady();
  const reminders = new ReminderIndex(index);

  const claims = reminders.claimDue('2026-07-12 09:00');
  assert.deepEqual(claims.map((claim) => claim.key), [reminderKey(second), reminderKey(first)]);
  assert.equal(reminders.claimDue('2026-07-12 09:00').length, 0, 'in-flight claims cannot be leased twice');

  reminders.ackDue([claims[0]]);
  reminders.retryDue([claims[1]]);
  const retried = reminders.claimDue('2026-07-12 09:00');
  assert.deepEqual(retried.map((claim) => claim.key), [reminderKey(first)]);
  reminders.ackDue(retried);
  assert.equal(reminders.claimDue('2026-07-12 09:00').length, 0);
  assert.equal(reminders.resolve(reminderKey(first))?.task.filePath, 'A.md', 'ack retains action resolution');
  reminders.dispose();
});

test('ReminderIndex stale claims cannot acknowledge or resurrect revised reminders', () => {
  const index = new TaskIndex(); index.beginHydration();
  const current = task('A.md', 1, 'stable');
  index.commit(new Map([['A.md', [current]]])); index.markReady();
  const reminders = new ReminderIndex(index);
  const [claim] = reminders.claimDue('2026-07-12 09:00');
  assert.ok(claim);

  const rescheduled = {
    ...current,
    rawLine: '- [ ] Remind me ⏰ 2026-07-12 10:00 🆔 stable',
    metadata: { ...current.metadata, reminder: '2026-07-12 10:00' },
  };
  index.commit(new Map([['A.md', [rescheduled]]]));
  reminders.retryDue([claim]);
  reminders.ackDue([claim]);
  assert.equal(reminders.claimDue('2026-07-12 09:00').length, 0, 'old fire time was not resurrected');
  const revised = reminders.claimDue('2026-07-12 10:00');
  assert.equal(revised.length, 1);
  assert.notEqual(revised[0].version, claim.version);

  const duplicate = { ...rescheduled, filePath: 'B.md', lineNumber: 2 };
  index.commit(new Map([['B.md', [duplicate]]]));
  reminders.retryDue(revised);
  assert.equal(reminders.claimDue('9999-12-31 23:59').length, 0, 'ambiguous ID invalidates the current lease');
  reminders.dispose();
  reminders.retryDue(revised);
  assert.equal(reminders.claimDue('9999-12-31 23:59').length, 0, 'disposed claims remain inert');
});
