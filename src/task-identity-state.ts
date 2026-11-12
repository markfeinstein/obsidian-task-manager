import type { MarkdownTask } from './task-model';
import type { PersistedState } from './state-store';
import type { IdentityMapperState, OperationQueueState, StableTaskIdentity, SyncOperation } from './sync-contract';
import { ExplicitIdIndex, explicitTaskKey } from './task-identity';

export const EXPLICIT_IDENTITY_STATE_VERSION = 2;

export interface IdentityMigrationConflict {
  id: string;
  slice: string;
  aliases: string[];
  reason: 'duplicate-current-id' | 'multiple-legacy-aliases' | 'canonical-value-conflict';
}

export interface IdentityMigrationState {
  version: number;
  /** True only when every legacy alias was migrated without an unresolved conflict. */
  completed: boolean;
  conflicts: IdentityMigrationConflict[];
}

export type PersistedStateWithIdentityMigration = PersistedState & {
  identityMigration?: IdentityMigrationState;
};

/**
 * Conservative v1 -> v2 migration for explicit task keys. The transform is
 * synchronous so callers can serialize it through StateStore.updateState().
 */
export function migrateExplicitIdentityState(
  input: PersistedStateWithIdentityMigration,
  tasks: readonly MarkdownTask[],
): PersistedStateWithIdentityMigration {
  if ((input.identityMigration?.version ?? 0) >= EXPLICIT_IDENTITY_STATE_VERSION && input.identityMigration?.completed) return input;

  const index = new ExplicitIdIndex(tasks);
  // Recompute conflicts from current tasks/state so resolving a duplicate ID can
  // complete the migration on a later full hydration.
  const conflicts: IdentityMigrationConflict[] = [];
  const uniqueIds = new Set<string>();
  for (const id of index.ids()) {
    const resolution = index.resolve(id);
    if (resolution.kind === 'unique') uniqueIds.add(id);
    else if (resolution.kind === 'ambiguous') addConflict(conflicts, {
      id,
      slice: 'task-index',
      aliases: resolution.matches.map((task) => `${task.filePath}:${task.lineNumber}`),
      reason: 'duplicate-current-id',
    });
  }

  const resolver = new LegacyAliasResolver(uniqueIds);
  const snapshot = migrateSingleRecordArray(input.snapshot, 'snapshot', (entry) => entry.key, (entry, key) => ({ ...entry, key }), resolver, conflicts);
  const completions = dedupeSorted(input.completions.map((record) => ({
    ...record,
    taskKey: resolver.migrateKey(record.taskKey) ?? record.taskKey,
  })));
  const recurrenceCounts = migrateSingleValueRecord(input.recurrenceCounts ?? {}, 'recurrenceCounts', resolver, conflicts);
  const habitCompletions = migrateDateRecord(input.habitCompletions ?? {}, resolver);
  const recurrenceOccurrences = Object.fromEntries(Object.entries(input.recurrenceOccurrences ?? {}).map(([seriesId, entries]) => [
    seriesId,
    dedupeSorted(entries.map((entry) => ({
      ...entry,
      taskKey: entry.taskKey ? (resolver.migrateKey(entry.taskKey) ?? entry.taskKey) : entry.taskKey,
    }))),
  ]));
  const timeSessionLog = dedupeSorted((input.timeSessionLog ?? []).map((record) => ({
    ...record,
    taskKey: resolver.migrateKey(record.taskKey) ?? record.taskKey,
  })));
  const clockInState = input.clockInState ? {
    ...input.clockInState,
    taskKey: resolver.migrateKey(input.clockInState.taskKey) ?? input.clockInState.taskKey,
  } : undefined;
  const snoozedReminders = migrateReminderRecords(input.snoozedReminders ?? [], resolver);
  const missedReminders = migrateReminderRecords(input.missedReminders ?? [], resolver);
  const queuedNotifications = migrateReminderRecords(input.queuedNotifications ?? [], resolver);
  const firedReminderKeys = dedupeStrings((input.firedReminderKeys ?? []).map((encoded) => migrateEncodedReminderKey(encoded, resolver)));
  const identityState = migrateIdentityState(input.identityState, resolver, conflicts);
  const syncQueueState = migrateQueueState(input.syncQueueState, resolver);
  for (const ambiguity of resolver.ambiguities()) {
    addConflict(conflicts, {
      id: ambiguity.ids.join(' | '),
      slice: 'legacy-key',
      aliases: [ambiguity.key],
      reason: 'multiple-legacy-aliases',
    });
  }

  const migrated: PersistedStateWithIdentityMigration = {
    ...input,
    version: Math.max(input.version, EXPLICIT_IDENTITY_STATE_VERSION),
    snapshot,
    completions,
    recurrenceCounts,
    habitCompletions,
    recurrenceOccurrences,
    timeSessionLog,
    clockInState,
    snoozedReminders,
    missedReminders,
    queuedNotifications,
    firedReminderKeys,
    identityState,
    syncQueueState,
    identityMigration: {
      version: EXPLICIT_IDENTITY_STATE_VERSION,
      completed: conflicts.length === 0,
      conflicts: [...conflicts].sort(compareConflicts),
    },
  };
  return stableJson(migrated) === stableJson(input) ? input : migrated;
}

class LegacyAliasResolver {
  private readonly encounteredAmbiguities = new Map<string, string[]>();

  constructor(private readonly uniqueIds: ReadonlySet<string>) {}

  resolve(key: string): { id: string; canonical: string } | undefined {
    const matches = this.candidateIds(key);
    if (matches.length > 1) this.encounteredAmbiguities.set(key, matches);
    if (matches.length !== 1) return undefined;
    const id = matches[0];
    return { id, canonical: explicitTaskKey(id) };
  }

  migrateKey(key: string): string | undefined {
    return this.resolve(key)?.canonical;
  }

  ambiguities(): Array<{ key: string; ids: string[] }> {
    return [...this.encounteredAmbiguities.entries()]
      .map(([key, ids]) => ({ key, ids: [...ids] }))
      .sort((left, right) => left.key.localeCompare(right.key));
  }

  private candidateIds(key: string): string[] {
    if (key.startsWith('id:')) return [];
    const candidates = new Set<string>();
    let index = key.indexOf(':id:');
    while (index >= 0) {
      const id = key.slice(index + 4);
      if (this.uniqueIds.has(id)) candidates.add(id);
      index = key.indexOf(':id:', index + 1);
    }
    return [...candidates].sort();
  }
}

function migrateSingleRecordArray<T>(
  records: readonly T[],
  slice: string,
  keyOf: (value: T) => string,
  withKey: (value: T, key: string) => T,
  resolver: LegacyAliasResolver,
  conflicts: IdentityMigrationConflict[],
): T[] {
  const aliasesById = new Map<string, T[]>();
  const canonicalById = new Map<string, T[]>();
  for (const record of records) {
    const key = keyOf(record);
    const legacy = resolver.resolve(key);
    if (legacy) {
      const bucket = aliasesById.get(legacy.id) ?? [];
      bucket.push(record);
      aliasesById.set(legacy.id, bucket);
      continue;
    }
    if (key.startsWith('id:')) {
      const id = key.slice(3);
      const bucket = canonicalById.get(id) ?? [];
      bucket.push(record);
      canonicalById.set(id, bucket);
    }
  }

  const migrations = new Map<T, string>();
  for (const [id, aliases] of aliasesById) {
    const canonical = canonicalById.get(id) ?? [];
    if (aliases.length > 1) {
      addConflict(conflicts, { id, slice, aliases: aliases.map(keyOf).sort(), reason: 'multiple-legacy-aliases' });
    } else if (canonical.length > 0) {
      addConflict(conflicts, { id, slice, aliases: [keyOf(aliases[0]), ...canonical.map(keyOf)].sort(), reason: 'canonical-value-conflict' });
    } else {
      migrations.set(aliases[0], explicitTaskKey(id));
    }
  }
  return records.map((record) => migrations.has(record) ? withKey(record, migrations.get(record) as string) : record);
}

function migrateSingleValueRecord(
  values: Readonly<Record<string, number>>,
  slice: string,
  resolver: LegacyAliasResolver,
  conflicts: IdentityMigrationConflict[],
): Record<string, number> {
  const result = { ...values };
  const aliasesById = new Map<string, string[]>();
  for (const key of Object.keys(values)) {
    const match = resolver.resolve(key);
    if (!match) continue;
    const bucket = aliasesById.get(match.id) ?? [];
    bucket.push(key);
    aliasesById.set(match.id, bucket);
  }
  for (const [id, aliases] of aliasesById) {
    const canonical = explicitTaskKey(id);
    if (aliases.length > 1) {
      addConflict(conflicts, { id, slice, aliases: aliases.sort(), reason: 'multiple-legacy-aliases' });
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(values, canonical)) {
      addConflict(conflicts, { id, slice, aliases: [canonical, aliases[0]].sort(), reason: 'canonical-value-conflict' });
      continue;
    }
    result[canonical] = values[aliases[0]];
    delete result[aliases[0]];
  }
  return result;
}

function migrateDateRecord(values: Readonly<Record<string, string[]>>, resolver: LegacyAliasResolver): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const [key, dates] of Object.entries(values)) {
    const migrated = resolver.migrateKey(key) ?? key;
    result[migrated] = dedupeStrings([...(result[migrated] ?? []), ...dates]);
  }
  return Object.fromEntries(Object.entries(result).sort(([left], [right]) => left.localeCompare(right)));
}

function migrateIdentityState(
  state: IdentityMapperState | undefined,
  resolver: LegacyAliasResolver,
  conflicts: IdentityMigrationConflict[],
): IdentityMapperState | undefined {
  if (!state) return state;
  const migrated = migrateSingleRecordArray<StableTaskIdentity>(
    state.identities,
    'identityState',
    (identity) => identity.vaultKey,
    (identity, vaultKey) => ({ ...identity, vaultKey }),
    resolver,
    conflicts,
  );
  return { ...state, identities: migrated };
}

function migrateQueueState(state: OperationQueueState | undefined, resolver: LegacyAliasResolver): OperationQueueState | undefined {
  if (!state) return state;
  const migrateOperation = <T extends SyncOperation>(operation: T): T => {
    const key = resolver.migrateKey(operation.vaultTask.key);
    const stableKey = operation.vaultTask.stableKey ? resolver.migrateKey(operation.vaultTask.stableKey) : undefined;
    if (!key && !stableKey) return operation;
    return {
      ...operation,
      vaultTask: {
        ...operation.vaultTask,
        ...(key ? { key } : {}),
        ...(stableKey ? { stableKey } : {}),
      },
    };
  };
  return {
    ...state,
    operations: state.operations.map(migrateOperation),
    completed: state.completed.map(migrateOperation),
  };
}

function migrateReminderRecords<T extends { reminderKey: string }>(records: readonly T[], resolver: LegacyAliasResolver): T[] {
  return dedupeSorted(records.map((record) => ({ ...record, reminderKey: migrateReminderKey(record.reminderKey, resolver) })));
}

function migrateReminderKey(key: string, resolver: LegacyAliasResolver): string {
  const exact = resolver.migrateKey(key);
  if (exact) return exact;
  // Only the NUL-delimited representation is unambiguous. Current path:line
  // reminder keys intentionally remain location-coupled and are not task keys.
  const separator = key.indexOf('\0');
  if (separator < 0) return key;
  const prefix = key.slice(0, separator);
  const migrated = resolver.migrateKey(prefix);
  return migrated ? `${migrated}${key.slice(separator)}` : key;
}

function migrateEncodedReminderKey(encoded: string, resolver: LegacyAliasResolver): string {
  const separator = encoded.indexOf('\0');
  if (separator < 0) return migrateReminderKey(encoded, resolver);
  return `${encoded.slice(0, separator + 1)}${migrateReminderKey(encoded.slice(separator + 1), resolver)}`;
}

function dedupeStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

function dedupeSorted<T>(values: readonly T[]): T[] {
  const unique = new Map<string, T>();
  for (const value of values) unique.set(stableJson(value), value);
  return [...unique.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, value]) => value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function addConflict(conflicts: IdentityMigrationConflict[], conflict: IdentityMigrationConflict): void {
  const normalized = { ...conflict, aliases: [...new Set(conflict.aliases)].sort() };
  if (!conflicts.some((existing) => stableJson(existing) === stableJson(normalized))) conflicts.push(normalized);
}

function compareConflicts(left: IdentityMigrationConflict, right: IdentityMigrationConflict): number {
  return left.id.localeCompare(right.id) || left.slice.localeCompare(right.slice) || left.reason.localeCompare(right.reason) || left.aliases.join('\0').localeCompare(right.aliases.join('\0'));
}
