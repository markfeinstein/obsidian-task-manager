import { STATE_SLICE_CONTRACT, type PersistedState, type RecurrenceOccurrenceRecord, type StateSliceName, type StateStore } from './state-store';

export const SCAN_STATE_FIELDS = STATE_SLICE_CONTRACT.scan.fields;
export const COMPLETION_STATE_FIELDS = STATE_SLICE_CONTRACT.completion.fields;
export const RECURRENCE_STATE_FIELDS = STATE_SLICE_CONTRACT.recurrence.fields;
export const REMINDER_STATE_FIELDS = STATE_SLICE_CONTRACT.reminders.fields;
export const TIME_STATE_FIELDS = STATE_SLICE_CONTRACT.time.fields;
export const HABIT_STATE_FIELDS = STATE_SLICE_CONTRACT.habits.fields;
export const IDENTITY_STATE_FIELDS = STATE_SLICE_CONTRACT.identity.fields;
export const SYNC_STATE_FIELDS = STATE_SLICE_CONTRACT.sync.fields;
export const MOVE_STATE_FIELDS = STATE_SLICE_CONTRACT.moves.fields;
export const LIFECYCLE_TRANSFER_STATE_FIELDS = STATE_SLICE_CONTRACT.lifecycleTransfers.fields;

export const STATE_REPOSITORY_FIELDS = Object.freeze({
  scan: SCAN_STATE_FIELDS,
  completion: COMPLETION_STATE_FIELDS,
  recurrence: RECURRENCE_STATE_FIELDS,
  reminders: REMINDER_STATE_FIELDS,
  time: TIME_STATE_FIELDS,
  habits: HABIT_STATE_FIELDS,
  identity: IDENTITY_STATE_FIELDS,
  sync: SYNC_STATE_FIELDS,
  moves: MOVE_STATE_FIELDS,
  lifecycleTransfers: LIFECYCLE_TRANSFER_STATE_FIELDS,
} satisfies Record<StateSliceName, readonly (keyof PersistedState)[]>);

export type ReminderStateSlice = Pick<PersistedState, typeof REMINDER_STATE_FIELDS[number]>;
export type CompletionStateSlice = Pick<PersistedState, typeof COMPLETION_STATE_FIELDS[number]>;
export type SyncStateSlice = Pick<PersistedState, typeof SYNC_STATE_FIELDS[number]>;
export type RecurrenceStateSlice = Pick<PersistedState, typeof RECURRENCE_STATE_FIELDS[number]>;

export function commitRecurrenceOccurrence(
  current: Readonly<RecurrenceStateSlice>,
  occurrence: RecurrenceOccurrenceRecord,
  incrementTaskKey?: string,
): RecurrenceStateSlice {
  const recurrenceCounts = incrementTaskKey
    ? { ...(current.recurrenceCounts ?? {}), [incrementTaskKey]: (current.recurrenceCounts?.[incrementTaskKey] ?? 0) + 1 }
    : current.recurrenceCounts;
  const existing = current.recurrenceOccurrences?.[occurrence.seriesId] ?? [];
  const normalized = { ...occurrence, completedAtIso: occurrence.completedAtIso ?? new Date().toISOString() };
  const retained = existing.filter((entry) => !(entry.date === normalized.date && (entry.taskKey ?? '') === (normalized.taskKey ?? '')));
  return {
    recurrenceCounts,
    recurrenceExceptions: current.recurrenceExceptions,
    recurrenceOccurrences: {
      ...(current.recurrenceOccurrences ?? {}),
      [occurrence.seriesId]: [...retained, normalized].sort((left, right) => left.date.localeCompare(right.date)),
    },
  };
}

type NoForeignFields<Result, K extends keyof PersistedState> = Result & Record<Exclude<keyof Result, K>, never>;

/** A type-scoped, runtime-frozen view over the single serialized StateStore queue. */
export class StateSliceRepository<K extends keyof PersistedState> {
  constructor(private readonly store: StateStore, private readonly fields: readonly K[]) {}

  async read(): Promise<Readonly<Pick<PersistedState, K>>> {
    return this.pick(await this.store.loadState());
  }

  async update<Result extends Pick<PersistedState, K>>(
    transform: (current: Readonly<Pick<PersistedState, K>>) => NoForeignFields<Result, K>,
    options: { shouldCommit?: () => boolean } = {},
  ): Promise<Readonly<Pick<PersistedState, K>>> {
    const committed = await this.store.updateState((state) => ({ ...state, ...transform(this.pick(state)) }), options);
    return this.pick(committed);
  }

  private pick(state: PersistedState): Readonly<Pick<PersistedState, K>> {
    const slice = {} as Pick<PersistedState, K>;
    for (const field of this.fields) slice[field] = state[field];
    return Object.freeze(slice);
  }
}

function repository<K extends keyof PersistedState>(store: StateStore, fields: readonly K[]): StateSliceRepository<K> {
  return new StateSliceRepository(store, fields);
}

export const scanStateRepository = (store: StateStore) => repository(store, SCAN_STATE_FIELDS);
export const completionStateRepository = (store: StateStore) => repository(store, COMPLETION_STATE_FIELDS);
export const recurrenceStateRepository = (store: StateStore) => repository(store, RECURRENCE_STATE_FIELDS);
export const reminderStateRepository = (store: StateStore) => repository(store, REMINDER_STATE_FIELDS);
export const timeStateRepository = (store: StateStore) => repository(store, TIME_STATE_FIELDS);
export const habitStateRepository = (store: StateStore) => repository(store, HABIT_STATE_FIELDS);
export const identityStateRepository = (store: StateStore) => repository(store, IDENTITY_STATE_FIELDS);
export const syncStateRepository = (store: StateStore) => repository(store, SYNC_STATE_FIELDS);
export const moveStateRepository = (store: StateStore) => repository(store, MOVE_STATE_FIELDS);
export const lifecycleTransferStateRepository = (store: StateStore) => repository(store, LIFECYCLE_TRANSFER_STATE_FIELDS);
