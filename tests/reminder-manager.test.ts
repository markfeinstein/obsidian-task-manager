/**
 * Reminder Manager Tests
 * Tests real ReminderManager API: snooze, quiet hours, queued notifications,
 * missed reminders, and reminder lifecycle state helpers.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ReminderManager } from '../src/reminder-manager';
import { StateStore, type PersistedState } from '../src/state-store';
import { DEFAULT_SETTINGS, normalizeTaskManagerSettings } from '../src/types';

function stateStore(): StateStore {
  return new StateStore({
    loadData: async () => ({}),
    saveData: async () => undefined,
  } as never);
}

function emptyState(overrides: Partial<PersistedState> = {}): PersistedState {
  return {
    version: 1,
    snapshot: [],
    completions: [],
    recurrenceCounts: {},
    fileHashes: {},
    ...overrides,
  };
}

function manager(settings: Partial<typeof DEFAULT_SETTINGS> = {}): { manager: ReminderManager; store: StateStore } {
  const store = stateStore();
  return {
    store,
    manager: new ReminderManager({
      stateStore: store,
      settings: { ...DEFAULT_SETTINGS, ...settings },
    }),
  };
}

const sampleReminder = {
  reminderKey: 'Test.md:1:2026-05-28 09:00',
  taskFilePath: 'Test.md',
  taskLineNumber: 1,
  taskText: 'Call client',
  originalReminderTime: '2026-05-28 09:00',
};

// ── Snooze Functionality ──────────────────────────────────

test('reminder-manager: snoozes reminder for duration', () => {
  const { manager: mgr } = manager();
  const state = mgr.snoozeReminder(emptyState(), sampleReminder, 15);

  assert.equal(state.snoozedReminders?.length, 1);
  assert.equal(state.snoozedReminders?.[0].reminderKey, sampleReminder.reminderKey);
  assert.match(state.snoozedReminders?.[0].nextFireTime ?? '', /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
});

test('reminder-manager: replaces existing snooze for the same reminder', () => {
  const { manager: mgr } = manager();
  let state = mgr.snoozeReminder(emptyState(), sampleReminder, 15);
  state = mgr.snoozeReminder(state, { ...sampleReminder, taskText: 'Updated text' }, 30);

  assert.equal(state.snoozedReminders?.length, 1);
  assert.equal(state.snoozedReminders?.[0].taskText, 'Updated text');
});

test('reminder-manager: snoozed reminders retain the task source identity text', () => {
  const { manager: mgr } = manager();
  const rawTaskLine = '- [ ] Call client 🆔 client-call ⏰ 2026-05-28 09:00';
  const state = mgr.snoozeReminder(emptyState(), { ...sampleReminder, taskText: rawTaskLine }, 15);
  assert.equal(state.snoozedReminders?.[0].taskText, rawTaskLine);
});

test('reminder-manager: returns due snoozed reminders and clears them', () => {
  const { manager: mgr, store } = manager();
  let state = emptyState({
    snoozedReminders: [{
      ...sampleReminder,
      nextFireTime: '2000-01-01 00:00',
      snoozedAtIso: '1999-12-31T23:55:00.000Z',
    }],
  });

  const due = mgr.getDueSnoozedReminders(state);
  assert.equal(due.length, 1);
  assert.equal(due[0].reminderKey, sampleReminder.reminderKey);

  state = mgr.clearSnoozedReminder(state, sampleReminder.reminderKey);
  assert.equal(store.getDueSnoozedReminders(state, new Date()).length, 0);
});

test('reminder-manager: formats snooze preset labels', () => {
  const { manager: mgr } = manager({ reminderSnoozePresets: [5, 15, 60, 90, 1440] });
  assert.deepEqual(mgr.getSnoozePresets(), [
    { minutes: 5, label: '5 minutes' },
    { minutes: 15, label: '15 minutes' },
    { minutes: 60, label: '1 hour' },
    { minutes: 90, label: '1h 30m' },
    { minutes: 1440, label: 'Tomorrow morning' },
  ]);
});

test('reminder-manager: rejects invalid snooze durations', () => {
  const { manager: mgr } = manager();

  assert.throws(() => mgr.snoozeReminder(emptyState(), sampleReminder, 0), /positive finite number/u);
  assert.throws(() => mgr.snoozeReminder(emptyState(), sampleReminder, -15), /positive finite number/u);
  assert.throws(() => mgr.snoozeReminder(emptyState(), sampleReminder, Number.NaN), /positive finite number/u);
});

// ── Quiet Hours ──────────────────────────────────

test('reminder-manager: checks midnight-spanning quiet hours', () => {
  const { manager: mgr } = manager({ quietHoursEnabled: true, quietHoursStart: '22:00', quietHoursEnd: '08:00' });

  assert.equal(mgr.isInQuietHours(new Date(2026, 4, 28, 23, 0)), true);
  assert.equal(mgr.isInQuietHours(new Date(2026, 4, 28, 3, 0)), true);
  assert.equal(mgr.isInQuietHours(new Date(2026, 4, 28, 10, 0)), false);
});

test('reminder-manager: checks same-day quiet hours', () => {
  const { manager: mgr } = manager({ quietHoursEnabled: true, quietHoursStart: '12:00', quietHoursEnd: '14:00' });

  assert.equal(mgr.isInQuietHours(new Date(2026, 4, 28, 13, 0)), true);
  assert.equal(mgr.isInQuietHours(new Date(2026, 4, 28, 15, 0)), false);
});

test('reminder-manager: quiet hours disabled returns false', () => {
  const { manager: mgr } = manager({ quietHoursEnabled: false, quietHoursStart: '22:00', quietHoursEnd: '08:00' });
  assert.equal(mgr.isInQuietHours(new Date(2026, 4, 28, 23, 0)), false);
});

test('reminder-manager: equal quiet-hours start and end means no quiet window', () => {
  const { manager: mgr } = manager({ quietHoursEnabled: true, quietHoursStart: '08:00', quietHoursEnd: '08:00' });

  assert.equal(mgr.isInQuietHours(new Date(2026, 4, 28, 7, 59)), false);
  assert.equal(mgr.isInQuietHours(new Date(2026, 4, 28, 8, 0)), false);
  assert.equal(mgr.isInQuietHours(new Date(2026, 4, 28, 23, 30)), false);
});

test('settings: quiet hours normalization rejects impossible clock times', () => {
  const settings = normalizeTaskManagerSettings({
    quietHoursStart: '24:00',
    quietHoursEnd: '08:60',
  });

  assert.equal(settings.quietHoursStart, DEFAULT_SETTINGS.quietHoursStart);
  assert.equal(settings.quietHoursEnd, DEFAULT_SETTINGS.quietHoursEnd);

  const valid = normalizeTaskManagerSettings({
    quietHoursStart: '00:00',
    quietHoursEnd: '23:59',
  });

  assert.equal(valid.quietHoursStart, '00:00');
  assert.equal(valid.quietHoursEnd, '23:59');
});

test('reminder-manager: calculates quiet-hours end time', () => {
  const { manager: mgr } = manager({ quietHoursEnabled: true, quietHoursStart: '22:00', quietHoursEnd: '08:00' });
  const end = mgr.getQuietHoursEndTime(new Date(2026, 4, 28, 23, 30));
  assert.equal(end.getFullYear(), 2026);
  assert.equal(end.getMonth(), 4);
  assert.equal(end.getDate(), 29);
  assert.equal(end.getHours(), 8);
  assert.equal(end.getMinutes(), 0);
});

// ── Queued Notifications ──────────────────────────────────

test('reminder-manager: queued notifications retain task source identity text', () => {
  const { manager: mgr } = manager();
  const rawTaskLine = '- [ ] Queued task 🆔 queued-task ⏰ 2026-05-28 09:00';
  const state = mgr.queueNotification(emptyState(), {
    taskFilePath: 'Test.md',
    taskLineNumber: 4,
    taskText: rawTaskLine,
    reminderKey: 'Test.md:4:2026-05-28 09:00',
    reminderTime: '2026-05-28 09:00',
  });
  assert.equal(mgr.deliverQueuedNotifications(state).notifications[0].taskText, rawTaskLine);
});

test('reminder-manager: queues and delivers notifications', () => {
  const { manager: mgr } = manager();
  let state = mgr.queueNotification(emptyState(), {
    taskFilePath: 'Test.md',
    taskLineNumber: 1,
    taskText: 'Queued task',
    reminderKey: 'queued-1',
    reminderTime: '2026-05-28 09:00',
  });

  assert.equal(state.queuedNotifications?.length, 1);
  const delivered = mgr.deliverQueuedNotifications(state);
  state = delivered.state;

  assert.deepEqual(delivered.notifications, [{ taskText: 'Queued task', reminderKey: 'queued-1' }]);
  assert.equal(state.queuedNotifications?.length, 0);
});

// ── Missed Reminders ──────────────────────────────────

test('reminder-manager: records and retrieves unacknowledged missed reminders', () => {
  const { manager: mgr } = manager();
  const state = mgr.recordMissedReminder(emptyState(), {
    reminderKey: 'missed-1',
    taskFilePath: 'Test.md',
    taskLineNumber: 1,
    taskText: 'Missed task',
    reminderTime: '2026-05-28 09:00',
  });

  const missed = mgr.getUnacknowledgedMissedReminders(state);
  assert.equal(missed.length, 1);
  assert.equal(missed[0].taskText, 'Missed task');
});

test('reminder-manager: acknowledges single missed reminder', () => {
  const { manager: mgr } = manager();
  let state = mgr.recordMissedReminder(emptyState(), {
    reminderKey: 'missed-1',
    taskFilePath: 'Test.md',
    taskLineNumber: 1,
    taskText: 'Missed task',
    reminderTime: '2026-05-28 09:00',
  });

  state = mgr.acknowledgeMissedReminder(state, 'missed-1');
  assert.equal(mgr.getUnacknowledgedMissedReminders(state).length, 0);
});

test('reminder-manager: acknowledges all missed reminders', () => {
  const { manager: mgr } = manager();
  let state = emptyState();
  state = mgr.recordMissedReminder(state, { reminderKey: 'missed-1', taskFilePath: 'A.md', taskLineNumber: 1, taskText: 'One', reminderTime: '2026-05-28 09:00' });
  state = mgr.recordMissedReminder(state, { reminderKey: 'missed-2', taskFilePath: 'B.md', taskLineNumber: 1, taskText: 'Two', reminderTime: '2026-05-28 10:00' });

  state = mgr.acknowledgeAllMissedReminders(state);
  assert.equal(mgr.getUnacknowledgedMissedReminders(state).length, 0);
});

test('reminder-manager: prunes old missed reminders', () => {
  const { manager: mgr } = manager();
  const oldIso = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
  const recentIso = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  const state = emptyState({
    missedReminders: [
      { reminderKey: 'old', taskFilePath: 'Old.md', taskLineNumber: 1, taskText: 'Old', reminderTime: '2026-01-01 09:00', firedAtIso: oldIso, acknowledged: false },
      { reminderKey: 'recent', taskFilePath: 'Recent.md', taskLineNumber: 1, taskText: 'Recent', reminderTime: '2026-05-28 09:00', firedAtIso: recentIso, acknowledged: false },
    ],
  });

  const pruned = mgr.pruneMissedReminders(state, 30);
  assert.deepEqual(pruned.missedReminders?.map((r) => r.reminderKey), ['recent']);
});
