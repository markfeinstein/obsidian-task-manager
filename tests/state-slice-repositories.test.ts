import test from 'node:test';
import assert from 'node:assert/strict';
import { STATE_SLICE_CONTRACT, StateStore } from '../src/state-store';
import { commitRecurrenceOccurrence, completionStateRepository, identityStateRepository, reminderStateRepository, STATE_REPOSITORY_FIELDS } from '../src/state-slice-repositories';

test('slice repositories preserve concurrent same-file cross-slice updates', async () => {
  let data: unknown = { state: { version: 2, snapshot: [], completions: [] } };
  const store = new StateStore({ loadData: async () => structuredClone(data), saveData: async (next: unknown) => { data = structuredClone(next); } } as never);
  const reminders = reminderStateRepository(store);
  const completions = completionStateRepository(store);
  const identity = identityStateRepository(store);

  await Promise.all([
    reminders.update((current) => ({ ...current, firedReminderKeys: ['2026-07-12T00:00:00.000Z\0id:one'] })),
    completions.update(() => ({ completions: [{ taskKey: 'id:one', sourcePath: 'A.md', dailyNotePath: 'Daily.md', completedAtIso: '2026-07-12T00:00:00.000Z', logLineHash: 'hash' }] })),
    identity.update((current) => ({ ...current, identityState: { version: 2, identities: [] } })),
  ]);

  const committed = await store.loadState();
  assert.deepEqual(committed.firedReminderKeys, ['2026-07-12T00:00:00.000Z\0id:one']);
  assert.equal(committed.completions.length, 1);
  assert.equal(committed.identityState?.version, 2);
});

test('recurrence reducer advances count and deduplicates one occurrence atomically', () => {
  const first = commitRecurrenceOccurrence({}, { seriesId: 'series', date: '2026-07-13', taskKey: 'task', completedAtIso: '2026-07-13T10:00:00.000Z' }, 'task');
  const second = commitRecurrenceOccurrence(first, { seriesId: 'series', date: '2026-07-13', taskKey: 'task', completedAtIso: '2026-07-13T11:00:00.000Z' });
  assert.equal(second.recurrenceCounts?.task, 1);
  assert.equal(second.recurrenceOccurrences?.series?.length, 1);
  assert.equal(second.recurrenceOccurrences?.series?.[0]?.completedAtIso, '2026-07-13T11:00:00.000Z');
});

test('every declared state slice has one exact repository field set', () => {
  const seen = new Set<string>();
  for (const [name, contract] of Object.entries(STATE_SLICE_CONTRACT)) {
    const fields = STATE_REPOSITORY_FIELDS[name as keyof typeof STATE_REPOSITORY_FIELDS];
    assert.deepEqual([...fields], [...contract.fields]);
    for (const field of fields) {
      assert.equal(seen.has(field), false, `${field} has more than one repository owner`);
      seen.add(field);
    }
  }
});
