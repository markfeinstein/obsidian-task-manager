import type { CompletionStateSlice, ReminderStateSlice, SyncStateSlice } from '../../src/state-slice-repositories';

export function typeBoundaries(completion: CompletionStateSlice, reminders: ReminderStateSlice, sync: SyncStateSlice): void {
  void completion.completions;
  void reminders.firedReminderKeys;
  void sync.syncQueueState;
  // @ts-expect-error completion owners cannot access reminder fields
  void completion.firedReminderKeys;
  // @ts-expect-error reminder owners cannot access sync fields
  void reminders.syncQueueState;
  // @ts-expect-error sync owners cannot access completion fields
  void sync.completions;
}
