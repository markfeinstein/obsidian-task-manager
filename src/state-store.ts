import type { Plugin } from 'obsidian';
import { normalizeTaskManagerSettings, type TaskManagerSettings } from './types';
import type { IdentityMapperState, OperationQueueState, SyncOperation, SyncBaselineEvidence } from './sync-contract';
import { canonicalProjectionOrThrow, validBaselineEvidence, validReconciliationEvidence } from './sync-reconciliation';
import { normalizeVaultRelativePath } from './vault-utils';
import { isValidIsoDate } from './iso-date';

export interface CompletionRecord {
  taskKey: string;
  sourcePath: string;
  dailyNotePath: string;
  completedAtIso: string;
  logLineHash: string;
}

export interface SnapshotRecord {
  key: string;
  status: string;
  filePath: string;
  lineNumber: number;
  /** File-backed tasks use line zero; ordinary Markdown tasks use positive lines. */
  sourceKind?: 'line' | 'file';
}

export interface FileHashRecord {
  path: string;
  hash: string;
  /** Time this content/stat fingerprint was written; active retention is path-based, not age-based. */
  timestamp: number;
  /** File stat captured with the hash; used to avoid steady-state body reads. */
  mtime?: number;
  size?: number;
}

export interface ScanMetrics {
  totalTasksScanned: number;
  scanDurationMs: number;
  lastScanTimeIso: string;
}

export interface TimeSessionRecord {
  taskKey: string;
  taskFilePath: string;
  taskLineNumber: number;
  taskText: string;
  startedAtIso: string;
  endedAtIso: string;
  elapsedMinutes: number;
  source: 'focus-timer' | 'clock' | 'pomodoro';
  notes?: string;
}

export interface RecurrenceException {
  seriesId: string;
  date: string;
  reason: 'skipped' | 'deleted' | 'modified';
  note?: string;
  createdAtIso?: string;
}

export interface RecurrenceOccurrenceRecord {
  seriesId: string;
  date: string;
  taskKey?: string;
  completedAtIso?: string;
}

export type TaskMoveJournalPhase = 'prepared' | 'target-written' | 'source-removed' | 'reconciliation-required';
export type TaskLifecycleTransferPhase = 'prepared' | 'target-written' | 'source-finalized' | 'effects-committed' | 'reconciliation-required';

export interface TaskLifecycleTransferJournal {
  operationId: string;
  action: 'archive' | 'collect';
  phase: TaskLifecycleTransferPhase;
  sourcePath: string;
  sourceLine: number;
  sourceIdentity: string;
  sourceBlock: string;
  sourceReplacement: string;
  targetPath: string;
  targetHeading: string;
  targetInsertionOffset: number;
  targetOriginalHash: string;
  /** Exact source contents before and after finalization for restart proof. */
  sourceOriginalHash?: string;
  sourceFinalizedHash?: string;
  targetCreated: boolean;
  marker: string;
  markerLine: string;
  insertionPrefix: string;
  insertionSuffix: string;
  recurrenceCommit?: { taskKey: string; incrementCount: boolean; seriesId: string; date: string };
  createdAtIso: string;
  diagnostic?: string;
}

/** Durable evidence for a destination-first cross-file task move. */
export interface TaskMoveJournal {
  operationId: string;
  sourcePath: string;
  targetPath: string;
  sourceLine: number;
  targetInsertionOffset: number;
  targetOriginalHash: string;
  /** Exact source contents before and after durable block removal. Both or neither are present. */
  sourceOriginalHash?: string;
  sourceFinalizedHash?: string;
  targetCreated: boolean;
  block: string;
  marker: string;
  markerLine: string;
  insertionPrefix: string;
  insertionSuffix: string;
  targetHeading: string;
  phase: TaskMoveJournalPhase;
  createdAtIso: string;
  diagnostic?: string;
}

export function findJournalPathConflict(
  state: Pick<PersistedState, 'taskMoveJournals' | 'taskLifecycleTransferJournals'>,
  sourcePath: string,
  targetPath: string,
  ignoreOperationId?: string,
): { operationId: string; sourcePath: string; targetPath: string } | undefined {
  const paths = new Set([sourcePath, targetPath]);
  const journals = [...(state.taskMoveJournals ?? []), ...(state.taskLifecycleTransferJournals ?? [])];
  return journals.find((journal) => journal.operationId !== ignoreOperationId
    && (paths.has(journal.sourcePath) || paths.has(journal.targetPath)));
}

export const STATE_SLICE_CONTRACT = {
  scan: { version: 2, owner: 'TaskIndex/scan coordinator', fields: ['snapshot', 'fileHashes', 'scanMetrics'] },
  completion: { version: 1, owner: 'completion detector/log writer', fields: ['completions'] },
  recurrence: { version: 1, owner: 'TaskScanner recurrence lifecycle', fields: ['recurrenceCounts', 'recurrenceExceptions', 'recurrenceOccurrences'] },
  reminders: { version: 2, owner: 'ReminderManager/ReminderIndex', fields: ['icsCache', 'snoozedReminders', 'missedReminders', 'queuedNotifications', 'firedReminderKeys'] },
  time: { version: 1, owner: 'clock/Pomodoro services', fields: ['clockInState', 'timeSessionLog'] },
  habits: { version: 1, owner: 'habit completion service', fields: ['habitCompletions'] },
  identity: { version: 2, owner: 'durable identity migration', fields: ['identityState', 'identityMigration'] },
  sync: { version: 2, owner: 'sync reconciliation/operation queue', fields: ['syncQueueState'] },
  moves: { version: 2, owner: 'TaskMoveService', fields: ['taskMoveJournals'] },
  lifecycleTransfers: { version: 2, owner: 'TaskLifecycleTransferService', fields: ['taskLifecycleTransferJournals'] },
} as const;

export type StateSliceName = keyof typeof STATE_SLICE_CONTRACT;
export type StateSliceVersions = { [Name in StateSliceName]: number };
export const CURRENT_STATE_SLICE_VERSIONS: StateSliceVersions = Object.freeze(
  Object.fromEntries(Object.entries(STATE_SLICE_CONTRACT).map(([name, contract]) => [name, contract.version])) as StateSliceVersions,
);

export interface PersistedState {
  version: number;
  /** Independently versioned ownership boundaries within the aggregate data.json state. */
  sliceVersions?: Partial<StateSliceVersions>;
  snapshot: SnapshotRecord[];
  completions: CompletionRecord[];
  /** Tracks how many times each recurring task key has been completed (for `for N times` limit). */
  recurrenceCounts?: Record<string, number>;
  /** File hashes for incremental scanning (path -> sha256-like hash). */
  fileHashes?: Record<string, FileHashRecord>;
  /** Metrics from the last task scan. */
  scanMetrics?: ScanMetrics;
  /** Clock-in/out state for the Day Planner timeline. */
  clockInState?: {
    taskKey: string;
    taskFilePath: string;
    taskLineNumber: number;
    clockInTimeIso: string;
  };
  /** Cache of fetched ICS events: { url -> { lastFetchIso, events } } */
  icsCache?: Record<string, {
    lastFetchIso: string;
    events: Array<{ summary: string; date: string | null; startTime?: string; endTime?: string; uid: string | null }>;
  }>;
  /** Snoozed reminders waiting to be re-fired. */
  snoozedReminders?: Array<{
    reminderKey: string;
    taskFilePath: string;
    taskLineNumber: number;
    taskText: string;
    originalReminderTime: string;
    nextFireTime: string;
    snoozedAtIso: string;
  }>;
  /** Missed reminders that fired while app was closed. */
  missedReminders?: Array<{
    reminderKey: string;
    taskFilePath: string;
    taskLineNumber: number;
    taskText: string;
    reminderTime: string;
    firedAtIso: string;
    acknowledged: boolean;
  }>;
  /** Queued notifications that should fire when quiet hours end. */
  queuedNotifications?: Array<{
    taskFilePath: string;
    taskLineNumber: number;
    taskText: string;
    reminderKey: string;
    reminderTime: string;
    enqueuedAtIso: string;
  }>;
  /** Reminder keys that have already fired recently, encoded as `ISO\0key`. */
  firedReminderKeys?: string[];
  /** Durable time sessions recorded by focus timers, clock-in/out, or Pomodoro. */
  timeSessionLog?: TimeSessionRecord[];
  /** Habit completion dates keyed by task key. */
  habitCompletions?: Record<string, string[]>;
  /** Recurrence dates intentionally skipped/deleted/modified, keyed by recurrence series id. */
  recurrenceExceptions?: Record<string, RecurrenceException[]>;
  /** Durable recurrence occurrence/completion dates keyed by recurrence series id. */
  recurrenceOccurrences?: Record<string, RecurrenceOccurrenceRecord[]>;
  /** Stable task identity mappings for external sync adapters. */
  identityState?: IdentityMapperState;
  /** Durable sync operation queue state for retry/preview flows. */
  syncQueueState?: OperationQueueState;
  /** Restart-safe audit record for the explicit-ID state migration. */
  identityMigration?: import('./task-identity-state').IdentityMigrationState;
  /** Restart-safe compensating-saga records for cross-file task moves. */
  taskMoveJournals?: TaskMoveJournal[];
  /** Restart-safe archive/collect transfer records. */
  taskLifecycleTransferJournals?: TaskLifecycleTransferJournal[];
}

const SECRET_SETTING_IDS: ReadonlyArray<readonly [keyof TaskManagerSettings, string]> = [
  ['todoistApiKey', 'obsidian-task-manager-todoist-api-key'],
  ['googleTasksAccessToken', 'obsidian-task-manager-google-tasks-access-token'],
  ['googleTasksRefreshToken', 'obsidian-task-manager-google-tasks-refresh-token'],
  ['googleTasksApiKey', 'obsidian-task-manager-google-tasks-api-key'],
  ['googleCalendarAccessToken', 'obsidian-task-manager-google-calendar-access-token'],
  ['googleCalendarRefreshToken', 'obsidian-task-manager-google-calendar-refresh-token'],
  ['aiQueryApiKey', 'obsidian-task-manager-ai-query-api-key'],
  ['whisperApiKey', 'obsidian-task-manager-whisper-api-key'],
  ['caldavPassword', 'obsidian-task-manager-caldav-password'],
  ['appleRemindersWebhookSecret', 'obsidian-task-manager-apple-webhook-secret'],
  ['msToDoToken', 'obsidian-task-manager-ms-todo-access-token'],
  ['msToDoRefreshToken', 'obsidian-task-manager-ms-todo-refresh-token'],
  ['externalUriActionSecret', 'obsidian-task-manager-external-uri-secret'],
];

// Removed embedded-server credentials are scrubbed from legacy plugin data and
// SecretStorage instead of being carried forward as an invisible setting.
const RETIRED_SECRET_SETTING_IDS: ReadonlyArray<readonly [string, string]> = [
  ['mcpServerToken', 'obsidian-task-manager-mcp-token'],
];

interface PersistedPluginData {
  settings?: Partial<TaskManagerSettings>;
  state?: Partial<PersistedState>;
  [key: string]: unknown;
}

export const CURRENT_STATE_VERSION = 2;
/** Completion dedupe records older than one year are removed during every state merge. */
export const COMPLETION_RECORD_RETENTION_DAYS = 365;

function deepFreezeState(state: PersistedState): PersistedState {
  const freeze = (value: unknown): void => {
    if (!value || typeof value !== 'object' || Object.isFrozen(value)) return;
    for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
    Object.freeze(value);
  };
  freeze(state);
  return state;
}

const DEFAULT_SCAN_METRICS: ScanMetrics = {
  totalTasksScanned: 0,
  scanDurationMs: 0,
  lastScanTimeIso: new Date(0).toISOString(),
};

export class StateStore {
  private writeQueue: Promise<void> = Promise.resolve();
  private isRunningWriteTransform = false;
  private pluginDataPromise: Promise<PersistedPluginData> | null = null;
  private pluginData: PersistedPluginData | null = null;
  private normalizedState: PersistedState | null = null;
  private stateRevision = 0;
  private lifecycleRecoveryGate: Promise<void> = Promise.resolve();

  constructor(private readonly plugin: Plugin) {}

  setLifecycleRecoveryGate(gate: Promise<void>): void {
    this.lifecycleRecoveryGate = gate;
  }

  async whenLifecycleRecoveryReady(): Promise<void> {
    await this.lifecycleRecoveryGate;
  }

  async loadState(): Promise<PersistedState> {
    if (this.normalizedState) return this.normalizedState;
    const data = await this.loadPluginData();
    this.normalizedState ??= deepFreezeState(this.normalizeState(data.state));
    return this.normalizedState;
  }

  /**
   * Atomically update persisted state in the shared plugin-data write queue.
   *
   * The transform must be synchronous: doing asynchronous work while holding the
   * queue would block every settings/state write and permits stale decisions.
   * Nested transactions are rejected rather than being queued behind the
   * transaction that is currently waiting for them.
   */
  updateState(
    transform: (current: PersistedState) => PersistedState,
    options: { shouldCommit?: () => boolean } = {},
  ): Promise<PersistedState> {
    if (this.isRunningWriteTransform) {
      throw new Error('StateStore.updateState() cannot be nested inside a write transform');
    }

    return this.enqueueWrite(async () => {
      const data = await this.loadPluginData();
      const current = deepFreezeState(this.normalizeState(data.state));
      if (options.shouldCommit && !options.shouldCommit()) return current;
      let transformed: PersistedState;
      this.isRunningWriteTransform = true;
      try {
        transformed = transform(current);
      } finally {
        this.isRunningWriteTransform = false;
      }
      if (this.isPromiseLike(transformed)) {
        void Promise.resolve(transformed).catch(() => undefined);
        throw new Error('StateStore.updateState() transform must be synchronous');
      }
      const committed = deepFreezeState(this.normalizeState(transformed));
      if (options.shouldCommit && !options.shouldCommit()) return current;
      await this.savePluginData({ ...data, state: committed });
      this.normalizedState = committed;
      return committed;
    });
  }

  /**
   * Replace the complete state snapshot.
   *
   * This is only safe for exclusive bootstrap/migration flows. Runtime
   * read-modify-write callers must use updateState() so overlapping writes merge
   * against the latest committed plugin data.
   */
  async saveState(state: PersistedState): Promise<void> {
    await this.updatePluginData((data) => ({
      ...data,
      state: this.normalizeState(state),
    }));
  }

  /** True only after a profile has persisted at least one settings field. */
  async hasPersistedSettingsProfile(): Promise<boolean> {
    const settings = (await this.loadPluginData()).settings;
    return Boolean(settings && Object.keys(settings).length > 0);
  }

  async loadSettings(_defaults: TaskManagerSettings): Promise<TaskManagerSettings> {
    const data = await this.loadPluginData();
    const settings = normalizeTaskManagerSettings(data.settings);
    const storage = this.getSecretStorage();
    const rawSettings = data.settings;
    const hasActivePlaintextSecret = SECRET_SETTING_IDS.some(([field]) => {
      const value = rawSettings?.[field];
      return typeof value === 'string' && value.length > 0;
    });
    const hasRetiredSecret = RETIRED_SECRET_SETTING_IDS.some(([field]) => Object.prototype.hasOwnProperty.call(rawSettings ?? {}, field));
    for (const [, id] of RETIRED_SECRET_SETTING_IDS) storage?.setSecret(id, '');
    if (!storage) {
      if (hasRetiredSecret) await this.savePluginData({ ...data, settings });
      return settings;
    }

    for (const [field, id] of SECRET_SETTING_IDS) {
      const persistedValue = settings[field];
      const stored = storage.getSecret(id);
      if (stored) {
        (settings as unknown as Record<string, unknown>)[field] = stored;
      } else if (typeof persistedValue === 'string' && persistedValue) {
        storage.setSecret(id, persistedValue);
      }
    }
    if (hasActivePlaintextSecret || hasRetiredSecret) {
      const sanitized = this.withoutPlaintextSecrets(settings);
      await this.savePluginData({ ...data, settings: sanitized });
    }
    return settings;
  }

  async saveSettings(settings: TaskManagerSettings, shouldCommit: () => boolean = () => true): Promise<boolean> {
    if (!shouldCommit()) return false;
    const normalized = normalizeTaskManagerSettings(settings);
    const storage = this.getSecretStorage();
    if (!storage && this.hasActiveSecrets(normalized)) return false;
    const persisted = this.withoutPlaintextSecrets(normalized);
    const previousSecrets = storage
      ? new Map(SECRET_SETTING_IDS.map(([, id]) => [id, storage.getSecret(id)] as const))
      : null;
    let secretsWritten = false;
    const restoreSecrets = (): void => {
      if (!storage || !secretsWritten || !previousSecrets) return;
      for (const [, id] of SECRET_SETTING_IDS) storage.setSecret(id, previousSecrets.get(id) ?? '');
    };
    try {
      const committed = await this.updatePluginData((data) => {
        if (storage) {
          for (const [field, id] of SECRET_SETTING_IDS) {
            const value = normalized[field];
            if (typeof value === 'string') storage.setSecret(id, value);
          }
          secretsWritten = true;
        }
        return { ...data, settings: persisted };
      }, shouldCommit);
      if (!committed || !shouldCommit()) {
        restoreSecrets();
        return false;
      }
      return true;
    } catch (error) {
      restoreSecrets();
      throw error;
    }
  }

  completionKey(taskKey: string, sourcePath: string, dailyNotePath: string): string {
    return `${dailyNotePath}\u0000${sourcePath}\u0000${taskKey}`;
  }

  hasCompletion(state: PersistedState, taskKey: string, sourcePath: string, dailyNotePath: string): boolean {
    const key = this.completionKey(taskKey, sourcePath, dailyNotePath);
    return state.completions.some((record) => this.completionKey(record.taskKey, record.sourcePath, record.dailyNotePath) === key);
  }

  addCompletion(state: PersistedState, record: CompletionRecord, retentionDays: number): PersistedState {
    const withoutDuplicate = state.completions.filter(
      (existing) =>
        this.completionKey(existing.taskKey, existing.sourcePath, existing.dailyNotePath) !==
        this.completionKey(record.taskKey, record.sourcePath, record.dailyNotePath),
    );

    return {
      ...state,
      completions: this.pruneCompletions([...withoutDuplicate, record], retentionDays),
    };
  }

  pruneCompletions(records: CompletionRecord[], retentionDays: number): CompletionRecord[] {
    if (retentionDays <= 0) {
      return records;
    }

    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    return records.filter((record) => {
      const timestamp = Date.parse(record.completedAtIso);
      return !Number.isNaN(timestamp) && timestamp >= cutoff;
    });
  }

  /**
   * Fast hash for file content using two FNV-1a 32-bit passes (pure JS, no crypto).
   * Produces a 16-character hex string (64-bit equivalent) which reduces the
   * birthday-collision probability to ~1 in 10^19, versus ~1% at 10k files for
   * the old 32-bit djb2 implementation.
   */
  hash(value: string): string {
    let h1 = 0x811c9dc5; // FNV offset basis
    let h2 = 0x811c9dc5 ^ 0xdeadbeef; // second pass with a different seed
    for (let i = 0; i < value.length; i++) {
      const c = value.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 0x01000193);
      h2 = Math.imul(h2 ^ c, 0x01000193);
    }
    return ((h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0'));
  }

  /**
   * Get hash record for a file (used for incremental scanning).
   *
   * @param state - Current persisted state containing the file-hash cache.
   * @param filePath - Vault-relative file path whose hash record should be returned.
   */
  getFileHash(state: PersistedState, filePath: string): FileHashRecord | undefined {
    return (state.fileHashes ?? {})[filePath];
  }

  /**
   * Update hash record for a file.
   *
   * @param state - Current persisted state containing the file-hash cache.
   * @param filePath - Vault-relative file path whose hash record should be updated.
   * @param content - Current file contents used to compute the new hash.
   */
  setFileHash(
    state: PersistedState,
    filePath: string,
    content: string,
    stat?: { mtime?: number; size?: number },
  ): PersistedState {
    return this.setFileHashes(state, [{ path: filePath, content, stat }]);
  }

  /** Apply many scan fingerprints with one map clone (avoids O(files²) copying). */
  setFileHashes(
    state: PersistedState,
    updates: ReadonlyArray<{ path: string; hash?: string; content?: string; stat?: { mtime?: number; size?: number } }>,
  ): PersistedState {
    if (updates.length === 0) return state;
    const hashes = { ...(state.fileHashes ?? {}) };
    const now = Date.now();
    for (const update of updates) {
      const oldRecord = hashes[update.path];
      hashes[update.path] = {
        path: update.path,
        hash: update.hash ?? (update.content === undefined ? (oldRecord?.hash ?? '') : this.hash(update.content)),
        timestamp: now,
        ...(Number.isFinite(update.stat?.mtime) ? { mtime: update.stat?.mtime } : {}),
        ...(Number.isFinite(update.stat?.size) ? { size: update.stat?.size } : {}),
      };
    }
    return { ...state, fileHashes: hashes };
  }

  /** True when a persisted stat fingerprint can prove the file is unchanged. */
  fileStatMatches(state: PersistedState, filePath: string, stat: { mtime?: number; size?: number } | undefined): boolean {
    const record = this.getFileHash(state, filePath);
    return Boolean(record
      && Number.isFinite(stat?.mtime)
      && Number.isFinite(stat?.size)
      && record.mtime === stat?.mtime
      && record.size === stat?.size);
  }

  /** Check content when a stat fingerprint is missing or ambiguous. */
  hasFileChanged(state: PersistedState, filePath: string, content: string): boolean {
    const currentHash = this.hash(content);
    const record = this.getFileHash(state, filePath);
    return !record || record.hash !== currentHash;
  }

  /** Keep fingerprints only for paths that are currently indexable, regardless of age. */
  retainFileHashesForPaths(state: PersistedState, currentPaths: ReadonlySet<string>): PersistedState {
    if (!state.fileHashes) return state;
    const retained: Record<string, FileHashRecord> = {};
    let changed = false;
    for (const [path, record] of Object.entries(state.fileHashes)) {
      if (currentPaths.has(path)) retained[path] = record;
      else changed = true;
    }
    return changed ? { ...state, fileHashes: retained } : state;
  }

  /**
   * Clear old file hashes (compatibility utility; active scan retention is path-based).
   */
  pruneFileHashes(state: PersistedState, retentionDays: number): PersistedState {
    if (retentionDays <= 0 || !state.fileHashes) {
      return state;
    }

    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    const prunedHashes: Record<string, FileHashRecord> = {};

    for (const [path, record] of Object.entries(state.fileHashes)) {
      if (record.timestamp >= cutoff) {
        prunedHashes[path] = record;
      }
    }

    return {
      ...state,
      fileHashes: prunedHashes,
    };
  }

  /** Get scan metrics from the current state. */
  getScanMetrics(state: PersistedState): ScanMetrics {
    return state.scanMetrics ?? DEFAULT_SCAN_METRICS;
  }

  /** Update scan metrics in the state. */
  setScanMetrics(state: PersistedState, metrics: ScanMetrics): PersistedState {
    return {
      ...state,
      scanMetrics: metrics,
    };
  }

  /** Format a reminder timestamp in the plugin's comparable `YYYY-MM-DD HH:mm` form. */
  formatReminderTime(date: Date): string {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }

  addSnoozedReminder(state: PersistedState, reminder: NonNullable<PersistedState['snoozedReminders']>[number]): PersistedState {
    const existing = state.snoozedReminders ?? [];
    return {
      ...state,
      snoozedReminders: [...existing.filter((r) => r.reminderKey !== reminder.reminderKey), reminder],
    };
  }

  removeSnoozedReminder(state: PersistedState, reminderKey: string): PersistedState {
    return {
      ...state,
      snoozedReminders: (state.snoozedReminders ?? []).filter((r) => r.reminderKey !== reminderKey),
    };
  }

  getDueSnoozedReminders(state: PersistedState, now: Date): NonNullable<PersistedState['snoozedReminders']> {
    const nowValue = this.formatReminderTime(now);
    return (state.snoozedReminders ?? []).filter((r) => r.nextFireTime <= nowValue);
  }

  addQueuedNotification(state: PersistedState, notification: NonNullable<PersistedState['queuedNotifications']>[number]): PersistedState {
    const existing = state.queuedNotifications ?? [];
    return {
      ...state,
      queuedNotifications: [...existing.filter((q) => q.reminderKey !== notification.reminderKey), notification],
    };
  }

  getQueuedNotifications(state: PersistedState): NonNullable<PersistedState['queuedNotifications']> {
    return state.queuedNotifications ?? [];
  }

  clearQueuedNotifications(state: PersistedState): PersistedState {
    return { ...state, queuedNotifications: [] };
  }

  addMissedReminder(state: PersistedState, reminder: NonNullable<PersistedState['missedReminders']>[number]): PersistedState {
    const existing = state.missedReminders ?? [];
    return {
      ...state,
      missedReminders: [...existing.filter((r) => r.reminderKey !== reminder.reminderKey), reminder],
    };
  }

  getUnacknowledgedMissedReminders(state: PersistedState): NonNullable<PersistedState['missedReminders']> {
    return (state.missedReminders ?? []).filter((r) => !r.acknowledged);
  }

  acknowledgeMissedReminder(state: PersistedState, reminderKey: string): PersistedState {
    return {
      ...state,
      missedReminders: (state.missedReminders ?? []).map((r) => r.reminderKey === reminderKey ? { ...r, acknowledged: true } : r),
    };
  }

  acknowledgeAllMissedReminders(state: PersistedState): PersistedState {
    return {
      ...state,
      missedReminders: (state.missedReminders ?? []).map((r) => ({ ...r, acknowledged: true })),
    };
  }

  pruneMissedReminders(state: PersistedState, retentionDays: number): PersistedState {
    if (retentionDays <= 0) return state;
    const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
    return {
      ...state,
      missedReminders: (state.missedReminders ?? []).filter((r) => {
        const timestamp = Date.parse(r.firedAtIso);
        return !Number.isNaN(timestamp) && timestamp >= cutoff;
      }),
    };
  }

  /**
   * Read a string-array value stored under an arbitrary external key in plugin data.
   * Does not need to be queued — reads are safe to run concurrently with writes.
   */
  async getExternalSyncIds(key: string): Promise<string[]> {
    const data = await this.loadPluginData();
    const value = data[key];
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  }

  /**
   * Persist a string array under an arbitrary external key through the write queue.
   * This whole-key replacement is intended for exclusive migration/bootstrap
   * callers; runtime read-modify-write flows should use updateExternalSyncIds().
   */
  async setExternalSyncIds(key: string, ids: string[]): Promise<void> {
    await this.updatePluginData((data) => ({ ...data, [key]: ids }));
  }

  /** Atomically transform one external-sync string-array plugin-data key. */
  updateExternalSyncIds(key: string, transform: (current: string[]) => string[], shouldCommit: () => boolean = () => true): Promise<string[]> {
    if (this.isRunningWriteTransform) {
      throw new Error('StateStore external-sync updates cannot be nested inside a write transform');
    }

    return this.enqueueWrite(async () => {
      const data = await this.loadPluginData();
      const value = data[key];
      if (!shouldCommit()) return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
      const current = Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
      let transformed: string[];
      this.isRunningWriteTransform = true;
      try {
        transformed = transform([...current]);
      } finally {
        this.isRunningWriteTransform = false;
      }
      if (this.isPromiseLike(transformed)) {
        void Promise.resolve(transformed).catch(() => undefined);
        throw new Error('StateStore external-sync transform must be synchronous');
      }
      const committed = transformed.filter((id): id is string => typeof id === 'string');
      if (!shouldCommit()) return current;
      await this.savePluginData({ ...data, [key]: committed });
      return committed;
    });
  }

  /**
   * True when Obsidian's SecretStorage is unavailable (e.g. an app older than
   * 1.11.4) and at least one credential is therefore held in plaintext in
   * data.json. Callers can surface an in-app warning so users are not relying
   * on documentation alone to learn their secrets are unencrypted on disk.
   */
  usesPlaintextSecretFallback(settings: TaskManagerSettings): boolean {
    if (this.getSecretStorage()) return false;
    return SECRET_SETTING_IDS.some(([field]) => {
      const value = settings[field];
      return typeof value === 'string' && value.length > 0;
    });
  }

  private hasActiveSecrets(settings: TaskManagerSettings): boolean {
    return SECRET_SETTING_IDS.some(([field]) => {
      const value = settings[field];
      return typeof value === 'string' && value.length > 0;
    });
  }

  private getSecretStorage(): { getSecret(id: string): string | null; setSecret(id: string, secret: string): void } | null {
    const app = (this.plugin as Plugin & { app?: { secretStorage?: unknown } }).app;
    const storage = app?.secretStorage as { getSecret?: unknown; setSecret?: unknown } | undefined;
    if (!storage || typeof storage.getSecret !== 'function' || typeof storage.setSecret !== 'function') return null;
    const getSecret = storage.getSecret as (id: string) => string | null;
    const setSecret = storage.setSecret as (id: string, secret: string) => void;
    return {
      getSecret: (id) => getSecret.call(storage, id),
      setSecret: (id, secret) => setSecret.call(storage, id, secret),
    };
  }

  private withoutPlaintextSecrets(settings: TaskManagerSettings): TaskManagerSettings {
    const persisted = { ...settings };
    for (const [field] of SECRET_SETTING_IDS) (persisted as unknown as Record<string, unknown>)[field] = '';
    return persisted;
  }

  private async updatePluginData(
    update: (data: PersistedPluginData) => PersistedPluginData,
    shouldCommit: () => boolean = () => true,
  ): Promise<boolean> {
    if (this.isRunningWriteTransform) {
      throw new Error('StateStore persistence cannot be nested inside a write transform');
    }
    return this.enqueueWrite(async () => {
      const data = await this.loadPluginData();
      if (!shouldCommit()) return false;
      await this.savePluginData(update(data));
      return true;
    });
  }

  private enqueueWrite<T>(operation: () => Promise<T>): Promise<T> {
    const write = this.writeQueue.then(operation);
    this.writeQueue = write.then(() => undefined, () => undefined);
    return write;
  }

  private isPromiseLike(value: unknown): value is PromiseLike<unknown> {
    return (typeof value === 'object' && value !== null) || typeof value === 'function'
      ? typeof (value as { then?: unknown }).then === 'function'
      : false;
  }

  getStateRevision(): number { return this.stateRevision; }

  private async savePluginData(data: PersistedPluginData): Promise<void> {
    const previousState = this.pluginData?.state;
    await this.plugin.saveData(data);
    this.pluginData = data;
    if (data.state !== previousState) this.normalizedState = deepFreezeState(this.normalizeState(data.state));
    this.pluginDataPromise = Promise.resolve(data);
    this.stateRevision += 1;
  }

  private async loadPluginData(): Promise<PersistedPluginData> {
    if (this.pluginData) return this.pluginData;
    this.pluginDataPromise ??= (async () => {
      const data = (await this.plugin.loadData()) as unknown;
      const normalized = this.isRecord(data) ? data : {};
      this.pluginData = normalized;
      return normalized;
    })();
    return this.pluginDataPromise;
  }

  /** Pure helper: return the completion count for a recurring task key. */
  getRecurrenceCount(state: PersistedState, key: string): number {
    return (state.recurrenceCounts ?? {})[key] ?? 0;
  }

  /** Pure helper: return a new state with the count for `key` incremented by 1. */
  incrementRecurrenceCount(state: PersistedState, key: string): PersistedState {
    const current = state.recurrenceCounts ?? {};
    return {
      ...state,
      recurrenceCounts: {
        ...current,
        [key]: (current[key] ?? 0) + 1,
      },
    };
  }

  private normalizeState(state: Partial<PersistedState> | undefined): PersistedState {
    const raw = state;
    const rawSliceVersions = this.isRecord((state as { sliceVersions?: unknown } | undefined)?.sliceVersions)
      ? (state as { sliceVersions: Record<string, unknown> }).sliceVersions
      : {};
    const persistedScanVersion = typeof rawSliceVersions.scan === 'number' && Number.isSafeInteger(rawSliceVersions.scan)
      ? rawSliceVersions.scan
      : 1;
    return {
      version: typeof state?.version === 'number' ? state.version : CURRENT_STATE_VERSION,
      sliceVersions: this.normalizeSliceVersions(rawSliceVersions),
      snapshot: this.normalizeSnapshot(raw?.snapshot, persistedScanVersion),
      completions: this.normalizeCompletions(raw?.completions),
      recurrenceCounts: this.normalizeRecurrenceCounts(raw?.recurrenceCounts),
      fileHashes: this.normalizeFileHashes(raw?.fileHashes),
      scanMetrics: this.normalizeScanMetrics(raw?.scanMetrics),
      clockInState: this.normalizeClockInState(raw?.clockInState),
      icsCache: this.normalizeIcsCache(raw?.icsCache),
      snoozedReminders: this.normalizeSnoozedReminders(raw?.snoozedReminders),
      missedReminders: this.normalizeMissedReminders(raw?.missedReminders),
      queuedNotifications: this.normalizeQueuedNotifications(raw?.queuedNotifications),
      firedReminderKeys: Array.isArray(state?.firedReminderKeys) ? state.firedReminderKeys.filter((key): key is string => typeof key === 'string') : [],
      timeSessionLog: Array.isArray(state?.timeSessionLog) ? this.pruneTimeSessions(state.timeSessionLog.filter((entry): entry is TimeSessionRecord => this.isTimeSessionRecord(entry)), 90) : [],
      habitCompletions: this.normalizeHabitCompletions((state as { habitCompletions?: unknown } | undefined)?.habitCompletions),
      recurrenceExceptions: this.normalizeRecurrenceExceptions((state as { recurrenceExceptions?: unknown } | undefined)?.recurrenceExceptions),
      recurrenceOccurrences: this.normalizeRecurrenceOccurrences((state as { recurrenceOccurrences?: unknown } | undefined)?.recurrenceOccurrences),
      identityState: this.normalizeIdentityMapperState((state as { identityState?: unknown } | undefined)?.identityState),
      syncQueueState: this.normalizeOperationQueueState((state as { syncQueueState?: unknown } | undefined)?.syncQueueState),
      identityMigration: this.normalizeIdentityMigration((state as { identityMigration?: unknown } | undefined)?.identityMigration),
      taskMoveJournals: this.normalizeTaskMoveJournals((state as { taskMoveJournals?: unknown } | undefined)?.taskMoveJournals),
      taskLifecycleTransferJournals: this.normalizeTaskLifecycleTransferJournals((state as { taskLifecycleTransferJournals?: unknown } | undefined)?.taskLifecycleTransferJournals),
    };
  }

  private normalizeIcsCache(value: unknown): NonNullable<PersistedState['icsCache']> {
    if (!this.isRecord(value)) return {};
    const cache: NonNullable<PersistedState['icsCache']> = {};
    let retainedEvents = 0;
    for (const [url, candidate] of Object.entries(value).slice(0, 32)) {
      if (url.length === 0 || url.length > 2048 || !this.isRecord(candidate)) continue;
      const lastFetchIso = candidate.lastFetchIso;
      const events = candidate.events;
      if (typeof lastFetchIso !== 'string' || !Number.isFinite(Date.parse(lastFetchIso)) || !Array.isArray(events)) continue;
      const normalizedEvents: NonNullable<PersistedState['icsCache']>[string]['events'] = [];
      for (const event of events.slice(0, 1000)) {
        if (retainedEvents >= 5000 || !this.isRecord(event) || typeof event.summary !== 'string' || event.summary.length > 4096) continue;
        const date = event.date;
        const uid = event.uid;
        const validTime = (time: unknown): time is string | undefined => time === undefined || typeof time === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(time);
        if (date !== null && (typeof date !== 'string' || !isValidIsoDate(date))) continue;
        if (uid !== null && (typeof uid !== 'string' || uid.length > 1024)) continue;
        if (!validTime(event.startTime) || !validTime(event.endTime)) continue;
        normalizedEvents.push({ summary: event.summary, date, ...(event.startTime ? { startTime: event.startTime } : {}), ...(event.endTime ? { endTime: event.endTime } : {}), uid });
        retainedEvents += 1;
      }
      cache[url] = { lastFetchIso, events: normalizedEvents };
    }
    return cache;
  }

  private normalizeSliceVersions(value: unknown): StateSliceVersions {
    const raw = this.isRecord(value) ? value : {};
    const normalized = { ...CURRENT_STATE_SLICE_VERSIONS };
    for (const name of Object.keys(CURRENT_STATE_SLICE_VERSIONS) as StateSliceName[]) {
      const persisted = raw[name];
      if (typeof persisted === 'number' && Number.isSafeInteger(persisted) && persisted > CURRENT_STATE_SLICE_VERSIONS[name]) {
        throw new Error(`Persisted ${name} state slice version ${persisted} is newer than supported version ${CURRENT_STATE_SLICE_VERSIONS[name]}`);
      }
    }
    return normalized;
  }

  private normalizeTaskMoveJournals(value: unknown): TaskMoveJournal[] {
    if (!Array.isArray(value)) return [];
    const journals: TaskMoveJournal[] = [];
    const seen = new Set<string>();
    for (const entry of value) {
      if (!this.isRecord(entry)) continue;
      const phase = entry.phase;
      if (phase !== 'prepared' && phase !== 'target-written' && phase !== 'source-removed' && phase !== 'reconciliation-required') continue;
      const required = ['operationId', 'sourcePath', 'targetPath', 'block', 'marker', 'markerLine', 'insertionPrefix', 'insertionSuffix', 'targetHeading', 'createdAtIso'] as const;
      if (required.some((key) => typeof entry[key] !== 'string')) continue;
      const operationId = entry.operationId as string;
      const sourcePath = entry.sourcePath as string;
      const targetPath = entry.targetPath as string;
      const block = entry.block as string;
      const targetOriginalHash = entry.targetOriginalHash;
      const targetCreated = entry.targetCreated;
      const marker = entry.marker as string;
      const markerLine = entry.markerLine as string;
      const insertionPrefix = entry.insertionPrefix as string;
      const insertionSuffix = entry.insertionSuffix as string;
      const targetHeading = entry.targetHeading as string;
      const createdAtIso = entry.createdAtIso as string;
      if (!/^[A-Za-z0-9-]{8,}$/u.test(operationId)
        || seen.has(operationId)
        || !Number.isSafeInteger(entry.sourceLine)
        || (entry.sourceLine as number) < 0
        || !Number.isSafeInteger(entry.targetInsertionOffset)
        || (entry.targetInsertionOffset as number) < 0) continue;
      let normalizedSource: string;
      let normalizedTarget: string;
      try {
        normalizedSource = normalizeVaultRelativePath(sourcePath, 'Task move source path');
        normalizedTarget = normalizeVaultRelativePath(targetPath, 'Task move target path');
      } catch {
        continue;
      }
      if (normalizedSource !== sourcePath || normalizedTarget !== targetPath || !/\.md$/iu.test(sourcePath) || !/\.md$/iu.test(targetPath) || sourcePath === targetPath) continue;
      if (!block || typeof targetOriginalHash !== 'string' || !/^[0-9a-f]{16}$/u.test(targetOriginalHash) || typeof targetCreated !== 'boolean') continue;
      const sourceOriginalHash = typeof entry.sourceOriginalHash === 'string' ? entry.sourceOriginalHash : undefined;
      const sourceFinalizedHash = typeof entry.sourceFinalizedHash === 'string' ? entry.sourceFinalizedHash : undefined;
      if (Boolean(sourceOriginalHash) !== Boolean(sourceFinalizedHash)
        || (sourceOriginalHash && !/^[0-9a-f]{16}$/u.test(sourceOriginalHash))
        || (sourceFinalizedHash && !/^[0-9a-f]{16}$/u.test(sourceFinalizedHash))) continue;
      if (marker !== `<!-- task-manager-move:${operationId} -->`) continue;
      if (![`${marker}\n`, `${marker}\r\n`, `${marker}\r`].includes(markerLine)) continue;
      if (!['', '\n', '\r\n', '\r'].includes(insertionPrefix) || !['', '\n', '\r\n', '\r'].includes(insertionSuffix)) continue;
      if (/[\r\n]/u.test(targetHeading) || Number.isNaN(Date.parse(createdAtIso))) continue;
      seen.add(operationId);
      journals.push({
        operationId,
        sourcePath,
        targetPath,
        sourceLine: entry.sourceLine as number,
        targetInsertionOffset: entry.targetInsertionOffset as number,
        targetOriginalHash,
        ...(sourceOriginalHash && sourceFinalizedHash ? { sourceOriginalHash, sourceFinalizedHash } : {}),
        targetCreated,
        block,
        marker,
        markerLine,
        insertionPrefix,
        insertionSuffix,
        targetHeading,
        phase,
        createdAtIso,
        ...(typeof entry.diagnostic === 'string' ? { diagnostic: entry.diagnostic } : {}),
      });
    }
    return journals;
  }

  private normalizeTaskLifecycleTransferJournals(value: unknown): TaskLifecycleTransferJournal[] {
    if (!Array.isArray(value)) return [];
    const journals: TaskLifecycleTransferJournal[] = [];
    const seen = new Set<string>();
    for (const entry of value) {
      if (!this.isRecord(entry)) continue;
      const phase = entry.phase;
      if (!['prepared', 'target-written', 'source-finalized', 'effects-committed', 'reconciliation-required'].includes(String(phase))) continue;
      const required = ['operationId', 'action', 'sourcePath', 'sourceIdentity', 'sourceBlock', 'sourceReplacement', 'targetPath', 'targetHeading', 'targetOriginalHash', 'marker', 'markerLine', 'insertionPrefix', 'insertionSuffix', 'createdAtIso'] as const;
      if (required.some((key) => typeof entry[key] !== 'string')) continue;
      const operationId = entry.operationId as string;
      if (!/^[A-Za-z0-9-]{8,}$/u.test(operationId) || seen.has(operationId)
        || (entry.action !== 'archive' && entry.action !== 'collect')
        || !Number.isSafeInteger(entry.sourceLine) || (entry.sourceLine as number) < 1
        || !Number.isSafeInteger(entry.targetInsertionOffset) || (entry.targetInsertionOffset as number) < 0
        || typeof entry.targetCreated !== 'boolean') continue;
      let sourcePath: string; let targetPath: string;
      try {
        sourcePath = normalizeVaultRelativePath(entry.sourcePath as string, 'Lifecycle transfer source path');
        targetPath = normalizeVaultRelativePath(entry.targetPath as string, 'Lifecycle transfer target path');
      } catch { continue; }
      if (sourcePath !== entry.sourcePath || targetPath !== entry.targetPath || sourcePath === targetPath
        || !/\.md$/iu.test(sourcePath) || !/\.md$/iu.test(targetPath)) continue;
      const sourceOriginalHash = typeof entry.sourceOriginalHash === 'string' ? entry.sourceOriginalHash : undefined;
      const sourceFinalizedHash = typeof entry.sourceFinalizedHash === 'string' ? entry.sourceFinalizedHash : undefined;
      if (Boolean(sourceOriginalHash) !== Boolean(sourceFinalizedHash)
        || (sourceOriginalHash && !/^[0-9a-f]{16}$/u.test(sourceOriginalHash))
        || (sourceFinalizedHash && !/^[0-9a-f]{16}$/u.test(sourceFinalizedHash))) continue;
      const marker = entry.marker as string;
      if (marker !== `<!-- task-manager-lifecycle:${operationId} -->`
        || ![`${marker}\n`, `${marker}\r\n`, `${marker}\r`].includes(entry.markerLine as string)
        || typeof entry.insertionPrefix !== 'string' || typeof entry.insertionSuffix !== 'string'
        || !entry.sourceBlock || !entry.sourceIdentity
        || !/^[0-9a-f]{16}$/u.test(entry.targetOriginalHash as string)
        || /[\r\n]/u.test(entry.targetHeading as string)
        || Number.isNaN(Date.parse(entry.createdAtIso as string))) continue;
      const recurrence = entry.recurrenceCommit;
      const recurrenceCommit = this.isRecord(recurrence)
        && typeof recurrence.taskKey === 'string' && recurrence.taskKey
        && typeof recurrence.seriesId === 'string' && recurrence.seriesId
        && typeof recurrence.date === 'string' && isValidIsoDate(recurrence.date)
        && typeof recurrence.incrementCount === 'boolean'
        ? { taskKey: recurrence.taskKey, incrementCount: recurrence.incrementCount, seriesId: recurrence.seriesId, date: recurrence.date }
        : undefined;
      if (entry.recurrenceCommit !== undefined && !recurrenceCommit) continue;
      seen.add(operationId);
      journals.push({
        operationId, action: entry.action, phase: phase as TaskLifecycleTransferPhase,
        sourcePath, sourceLine: entry.sourceLine as number, sourceIdentity: entry.sourceIdentity as string,
        sourceBlock: entry.sourceBlock as string, sourceReplacement: entry.sourceReplacement as string,
        targetPath, targetHeading: entry.targetHeading as string,
        targetInsertionOffset: entry.targetInsertionOffset as number, targetOriginalHash: entry.targetOriginalHash as string,
        ...(sourceOriginalHash && sourceFinalizedHash ? { sourceOriginalHash, sourceFinalizedHash } : {}),
        targetCreated: entry.targetCreated, marker, markerLine: entry.markerLine as string,
        insertionPrefix: entry.insertionPrefix, insertionSuffix: entry.insertionSuffix,
        ...(recurrenceCommit ? { recurrenceCommit } : {}), createdAtIso: entry.createdAtIso as string,
        ...(typeof entry.diagnostic === 'string' ? { diagnostic: entry.diagnostic } : {}),
      });
    }
    return journals;
  }

  private normalizeSnapshot(value: unknown, persistedScanVersion: number): SnapshotRecord[] {
    if (!Array.isArray(value)) return [];
    const snapshots: SnapshotRecord[] = [];
    for (const entry of value) {
      if (!this.isRecord(entry)
        || typeof entry.key !== 'string' || !entry.key.trim()
        || typeof entry.status !== 'string' || !entry.status.trim()
        || typeof entry.filePath !== 'string' || !entry.filePath.trim()
        || !Number.isSafeInteger(entry.lineNumber)) continue;
      const sourceKind = entry.sourceKind === 'line' || entry.sourceKind === 'file'
        ? entry.sourceKind
        : persistedScanVersion < 2
          ? entry.lineNumber === 0 ? 'file' : 'line'
          : undefined;
      if (!sourceKind) continue;
      let filePath: string;
      try { filePath = normalizeVaultRelativePath(entry.filePath, 'Task snapshot path'); } catch { continue; }
      if (filePath !== entry.filePath) continue;
      if (sourceKind === 'line' && (entry.lineNumber as number) < 1) continue;
      if (sourceKind === 'file' && (entry.lineNumber !== 0 || !/\.md$/iu.test(filePath))) continue;
      snapshots.push({ key: entry.key, status: entry.status, filePath, lineNumber: entry.lineNumber as number, sourceKind });
    }
    return snapshots;
  }

  private normalizeCompletions(value: unknown): CompletionRecord[] {
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is CompletionRecord => {
      if (!this.isRecord(entry)) return false;
      return typeof entry.taskKey === 'string'
        && entry.taskKey.trim().length > 0
        && typeof entry.sourcePath === 'string'
        && entry.sourcePath.trim().length > 0
        && typeof entry.dailyNotePath === 'string'
        && entry.dailyNotePath.trim().length > 0
        && typeof entry.completedAtIso === 'string'
        && entry.completedAtIso.trim().length > 0
        && typeof entry.logLineHash === 'string'
        && entry.logLineHash.trim().length > 0;
    }).map((entry) => ({
      taskKey: entry.taskKey,
      sourcePath: entry.sourcePath,
      dailyNotePath: entry.dailyNotePath,
      completedAtIso: entry.completedAtIso,
      logLineHash: entry.logLineHash,
    }));
  }

  private isTimeSessionRecord(value: unknown): value is TimeSessionRecord {
    if (!this.isRecord(value)) return false;
    return typeof value.taskKey === 'string'
      && typeof value.taskFilePath === 'string'
      && typeof value.taskLineNumber === 'number'
      && typeof value.taskText === 'string'
      && typeof value.startedAtIso === 'string'
      && typeof value.endedAtIso === 'string'
      && typeof value.elapsedMinutes === 'number'
      && (value.source === 'focus-timer' || value.source === 'clock' || value.source === 'pomodoro');
  }

  private normalizeRecurrenceCounts(value: unknown): Record<string, number> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const result: Record<string, number> = {};
    for (const [key, count] of Object.entries(value as Record<string, unknown>)) {
      if (typeof key !== 'string' || key.length === 0) continue;
      const normalizedCount = typeof count === 'number'
        ? count
        : typeof count === 'string' && /^\d+$/u.test(count)
          ? Number.parseInt(count, 10)
          : undefined;
      if (normalizedCount !== undefined && Number.isSafeInteger(normalizedCount) && normalizedCount >= 0) {
        result[key] = normalizedCount;
      }
    }
    return result;
  }

  private normalizeScanMetrics(value: unknown): ScanMetrics {
    if (!this.isRecord(value)) return DEFAULT_SCAN_METRICS;
    const totalTasksScanned = typeof value.totalTasksScanned === 'number' && Number.isFinite(value.totalTasksScanned) && value.totalTasksScanned >= 0
      ? value.totalTasksScanned
      : DEFAULT_SCAN_METRICS.totalTasksScanned;
    const scanDurationMs = typeof value.scanDurationMs === 'number' && Number.isFinite(value.scanDurationMs) && value.scanDurationMs >= 0
      ? value.scanDurationMs
      : DEFAULT_SCAN_METRICS.scanDurationMs;
    const lastScanTimeIso = typeof value.lastScanTimeIso === 'string' && !Number.isNaN(Date.parse(value.lastScanTimeIso))
      ? value.lastScanTimeIso
      : DEFAULT_SCAN_METRICS.lastScanTimeIso;
    return { totalTasksScanned, scanDurationMs, lastScanTimeIso };
  }

  private normalizeClockInState(value: unknown): PersistedState['clockInState'] {
    if (!this.isRecord(value)) return undefined;
    if (typeof value.taskKey !== 'string'
      || typeof value.taskFilePath !== 'string'
      || !this.isPositiveSafeInteger(value.taskLineNumber)
      || typeof value.clockInTimeIso !== 'string'
      || Number.isNaN(Date.parse(value.clockInTimeIso))) {
      return undefined;
    }
    return {
      taskKey: value.taskKey,
      taskFilePath: value.taskFilePath,
      taskLineNumber: value.taskLineNumber,
      clockInTimeIso: value.clockInTimeIso,
    };
  }

  private normalizeSnoozedReminders(value: unknown): NonNullable<PersistedState['snoozedReminders']> {
    if (!Array.isArray(value)) return [];
    return value.filter((reminder): reminder is NonNullable<PersistedState['snoozedReminders']>[number] => {
      if (!this.isRecord(reminder)) return false;
      return typeof reminder.reminderKey === 'string'
        && typeof reminder.taskFilePath === 'string'
        && this.isPositiveSafeInteger(reminder.taskLineNumber)
        && typeof reminder.taskText === 'string'
        && typeof reminder.originalReminderTime === 'string'
        && typeof reminder.nextFireTime === 'string'
        && typeof reminder.snoozedAtIso === 'string';
    }).map((reminder) => ({ ...reminder }));
  }

  private normalizeMissedReminders(value: unknown): NonNullable<PersistedState['missedReminders']> {
    if (!Array.isArray(value)) return [];
    return value.filter((reminder): reminder is Omit<NonNullable<PersistedState['missedReminders']>[number], 'acknowledged'> & { acknowledged?: unknown } => {
      if (!this.isRecord(reminder)) return false;
      return typeof reminder.reminderKey === 'string'
        && typeof reminder.taskFilePath === 'string'
        && this.isPositiveSafeInteger(reminder.taskLineNumber)
        && typeof reminder.taskText === 'string'
        && typeof reminder.reminderTime === 'string'
        && typeof reminder.firedAtIso === 'string';
    }).map((reminder) => ({
      reminderKey: reminder.reminderKey,
      taskFilePath: reminder.taskFilePath,
      taskLineNumber: reminder.taskLineNumber,
      taskText: reminder.taskText,
      reminderTime: reminder.reminderTime,
      firedAtIso: reminder.firedAtIso,
      acknowledged: reminder.acknowledged === true,
    }));
  }

  private normalizeQueuedNotifications(value: unknown): NonNullable<PersistedState['queuedNotifications']> {
    if (!Array.isArray(value)) return [];
    return value.filter((notification): notification is NonNullable<PersistedState['queuedNotifications']>[number] => {
      if (!this.isRecord(notification)) return false;
      return typeof notification.taskFilePath === 'string'
        && this.isPositiveSafeInteger(notification.taskLineNumber)
        && typeof notification.taskText === 'string'
        && typeof notification.reminderKey === 'string'
        && typeof notification.reminderTime === 'string'
        && typeof notification.enqueuedAtIso === 'string';
    }).map((notification) => ({ ...notification }));
  }

  private normalizeHabitCompletions(value: unknown): Record<string, string[]> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const result: Record<string, string[]> = {};
    for (const [key, dates] of Object.entries(value as Record<string, unknown>)) {
      if (typeof key !== 'string' || !Array.isArray(dates)) continue;
      const normalizedDates = [...new Set(dates.filter((date): date is string => typeof date === 'string' && isValidIsoDate(date)))].sort();
      if (normalizedDates.length > 0) result[key] = normalizedDates;
    }
    return result;
  }

  private normalizeFileHashes(value: unknown): Record<string, FileHashRecord> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const result: Record<string, FileHashRecord> = {};
    for (const [key, record] of Object.entries(value as Record<string, unknown>)) {
      if (typeof key !== 'string' || !key.trim() || !this.isRecord(record)) continue;
      if (typeof record.hash !== 'string' || typeof record.timestamp !== 'number' || !Number.isSafeInteger(record.timestamp) || record.timestamp < 0) continue;
      const mtime = typeof record.mtime === 'number' && Number.isFinite(record.mtime) ? record.mtime : undefined;
      const size = typeof record.size === 'number' && Number.isFinite(record.size) ? record.size : undefined;
      if (!record.hash && (mtime === undefined || size === undefined)) continue;
      const path = typeof record.path === 'string' && record.path.trim() ? record.path : key;
      result[path] = { path, hash: record.hash, timestamp: record.timestamp, ...(mtime !== undefined ? { mtime } : {}), ...(size !== undefined ? { size } : {}) };
    }
    return result;
  }

  private normalizeRecurrenceExceptions(value: unknown): Record<string, RecurrenceException[]> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const result: Record<string, RecurrenceException[]> = {};
    for (const [seriesId, entries] of Object.entries(value as Record<string, unknown>)) {
      if (typeof seriesId !== 'string' || !seriesId.trim() || !Array.isArray(entries)) continue;
      const normalized = entries.filter((entry): entry is RecurrenceException => {
        if (!this.isRecord(entry)) return false;
        return typeof entry.seriesId === 'string'
          && typeof entry.date === 'string'
          && isValidIsoDate(entry.date)
          && (entry.reason === 'skipped' || entry.reason === 'deleted' || entry.reason === 'modified');
      }).map((entry) => ({
        seriesId: entry.seriesId,
        date: entry.date,
        reason: entry.reason,
        ...(typeof entry.note === 'string' && entry.note ? { note: entry.note } : {}),
        ...(typeof entry.createdAtIso === 'string' && entry.createdAtIso ? { createdAtIso: entry.createdAtIso } : {}),
      }));
      if (normalized.length > 0) {
        result[seriesId] = normalized.sort((a, b) => a.date.localeCompare(b.date));
      }
    }
    return result;
  }

  private normalizeRecurrenceOccurrences(value: unknown): Record<string, RecurrenceOccurrenceRecord[]> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    const result: Record<string, RecurrenceOccurrenceRecord[]> = {};
    for (const [seriesId, entries] of Object.entries(value as Record<string, unknown>)) {
      if (typeof seriesId !== 'string' || !seriesId.trim() || !Array.isArray(entries)) continue;
      const normalized = entries.filter((entry): entry is RecurrenceOccurrenceRecord => {
        if (!this.isRecord(entry)) return false;
        return typeof entry.seriesId === 'string'
          && typeof entry.date === 'string'
          && isValidIsoDate(entry.date);
      }).map((entry) => ({
        seriesId: entry.seriesId,
        date: entry.date,
        ...(typeof entry.taskKey === 'string' && entry.taskKey ? { taskKey: entry.taskKey } : {}),
        ...(typeof entry.completedAtIso === 'string' && entry.completedAtIso ? { completedAtIso: entry.completedAtIso } : {}),
      }));
      const deduped = new Map<string, RecurrenceOccurrenceRecord>();
      for (const entry of normalized) deduped.set(`${entry.date}\0${entry.taskKey ?? ''}`, entry);
      if (deduped.size > 0) result[seriesId] = Array.from(deduped.values()).sort((a, b) => a.date.localeCompare(b.date));
    }
    return result;
  }

  private normalizeIdentityMigration(value: unknown): PersistedState['identityMigration'] {
    if (!this.isRecord(value) || typeof value.version !== 'number' || !Array.isArray(value.conflicts)) return undefined;
    const conflicts = value.conflicts.filter((conflict): conflict is NonNullable<PersistedState['identityMigration']>['conflicts'][number] => {
      if (!this.isRecord(conflict)) return false;
      return typeof conflict.id === 'string'
        && typeof conflict.slice === 'string'
        && Array.isArray(conflict.aliases)
        && conflict.aliases.every((alias) => typeof alias === 'string')
        && (conflict.reason === 'duplicate-current-id' || conflict.reason === 'multiple-legacy-aliases' || conflict.reason === 'canonical-value-conflict');
    }).map((conflict) => ({ ...conflict, aliases: [...conflict.aliases] }));
    return { version: value.version, completed: value.completed === true, conflicts };
  }

  private normalizeIdentityMapperState(value: unknown): IdentityMapperState {
    if (!this.isRecord(value)) return { identities: [], version: 2 };
    const identities = Array.isArray(value.identities)
      ? value.identities.filter((identity): identity is IdentityMapperState['identities'][number] => {
        if (!this.isRecord(identity)) return false;
        return typeof identity.vaultKey === 'string'
          && this.isRecord(identity.externalIds)
          && typeof identity.createdAt === 'number'
          && typeof identity.updatedAt === 'number';
      }).map((identity) => {
        const baselineEntries = this.isRecord(identity.baselines) ? Object.entries(identity.baselines) : [];
        const baselines = Object.fromEntries(baselineEntries.filter((entry): entry is [string, SyncBaselineEvidence] => validBaselineEvidence(entry[1])));
        const invalidBaselines = [...new Set([
          ...(Array.isArray(identity.invalidBaselines) ? identity.invalidBaselines.filter((service): service is string => typeof service === 'string') : []),
          ...baselineEntries.filter(([, evidence]) => !validBaselineEvidence(evidence)).map(([service]) => service),
        ])].sort();
        return {
          vaultKey: identity.vaultKey,
          externalIds: Object.fromEntries(Object.entries(identity.externalIds).filter((entry): entry is [string, string] => typeof entry[1] === 'string')),
          ...(Object.keys(baselines).length > 0 ? { baselines } : {}),
          ...(invalidBaselines.length > 0 ? { invalidBaselines } : {}),
          ...(typeof identity.lastSyncedHash === 'string' ? { lastSyncedHash: identity.lastSyncedHash } : {}),
          ...(this.isRecord(identity.fieldHashes) ? { fieldHashes: Object.fromEntries(Object.entries(identity.fieldHashes).filter((entry): entry is [string, string] => typeof entry[1] === 'string')) } : {}),
          createdAt: identity.createdAt,
          updatedAt: identity.updatedAt,
        };
      })
      : [];
    // v1 -> v2 is intentionally evidence-free: legacy hashes cannot establish a common projection.
    return { identities, version: 2 };
  }

  private normalizeOperationQueueState(value: unknown): OperationQueueState {
    if (!this.isRecord(value)) return { operations: [], completed: [], version: 2 };
    const normalize = <T extends SyncOperation>(operation: T): T => {
      if (!Object.prototype.hasOwnProperty.call(operation, 'reconciliation')) return operation;
      if (!validReconciliationEvidence(operation.reconciliation)) {
        return {
          ...operation,
          status: 'conflict',
          payload: {},
          fields: [],
          error: 'Malformed reconciliation evidence was retained fail-closed; a fresh provider read is required.',
          conflicts: operation.conflicts?.length ? operation.conflicts : [{ field: 'reconciliation-evidence', vaultValue: null, serviceValue: null, service: operation.service, detectedAt: Date.now() }],
          reconciliation: {
            schemaVersion: 1,
            baseline: null,
            local: {},
            remote: null,
            mode: 'conflict',
            capturedAt: Number.isFinite(operation.queuedAt) ? operation.queuedAt : 0,
          },
        };
      }
      const evidence = operation.reconciliation;
      return {
        ...operation,
        reconciliation: {
          ...evidence,
          baseline: evidence.baseline === null ? null : canonicalProjectionOrThrow(evidence.baseline),
          local: canonicalProjectionOrThrow(evidence.local),
          remote: evidence.remote === null ? null : canonicalProjectionOrThrow(evidence.remote),
        },
      };
    };
    return {
      operations: Array.isArray(value.operations) ? value.operations.filter((operation): operation is SyncOperation => this.isSyncOperation(operation)).map(normalize) : [],
      completed: Array.isArray(value.completed) ? value.completed.filter((operation): operation is SyncOperation & { completedAt: number } => this.isCompletedSyncOperation(operation)).map(normalize) : [],
      version: 2,
    };
  }

  private isSyncOperation(value: unknown): value is SyncOperation {
    if (!this.isRecord(value)) return false;
    return typeof value.id === 'string'
      && (value.type === 'create' || value.type === 'update' || value.type === 'delete' || value.type === 'reopen')
      && typeof value.service === 'string'
      && this.isRecord(value.vaultTask)
      && this.isRecord(value.payload)
      && typeof value.queuedAt === 'number'
      && (value.status === 'queued' || value.status === 'executing' || value.status === 'success' || value.status === 'conflict' || value.status === 'failed');
  }

  private isCompletedSyncOperation(value: unknown): value is SyncOperation & { completedAt: number } {
    return this.isSyncOperation(value)
      && this.isRecord(value)
      && typeof value.completedAt === 'number';
  }

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  private isPositiveSafeInteger(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
  }

  appendTimeSession(state: PersistedState, session: TimeSessionRecord, retentionDays = 90, nowMs = Date.now()): PersistedState {
    return {
      ...state,
      timeSessionLog: this.pruneTimeSessions([...(state.timeSessionLog ?? []), session], retentionDays, nowMs),
    };
  }

  pruneTimeSessions(records: TimeSessionRecord[], retentionDays = 90, nowMs = Date.now()): TimeSessionRecord[] {
    if (retentionDays <= 0) return records;
    const cutoff = nowMs - retentionDays * 24 * 60 * 60 * 1000;
    return records.filter((record) => {
      const timestamp = Date.parse(record.endedAtIso || record.startedAtIso);
      return !Number.isNaN(timestamp) && timestamp >= cutoff;
    });
  }

  getTimeSessions(state: PersistedState, options: { from?: string; to?: string; taskKey?: string } = {}): TimeSessionRecord[] {
    const fromMs = options.from ? Date.parse(options.from) : Number.NEGATIVE_INFINITY;
    const toMs = options.to ? Date.parse(options.to) : Number.POSITIVE_INFINITY;
    return (state.timeSessionLog ?? []).filter((record) => {
      if (options.taskKey && record.taskKey !== options.taskKey) return false;
      const timestamp = Date.parse(record.endedAtIso || record.startedAtIso);
      if (Number.isNaN(timestamp)) return false;
      return timestamp >= fromMs && timestamp <= toMs;
    });
  }

  addHabitCompletion(state: PersistedState, taskKey: string, date: string): PersistedState {
    if (!isValidIsoDate(date)) return state;
    const completions = { ...(state.habitCompletions ?? {}) };
    completions[taskKey] = [...new Set([...(completions[taskKey] ?? []), date])].sort();
    return { ...state, habitCompletions: completions };
  }

  addRecurrenceException(state: PersistedState, exception: RecurrenceException): PersistedState {
    if (!exception.seriesId.trim() || !isValidIsoDate(exception.date)) return state;
    const existing = state.recurrenceExceptions?.[exception.seriesId] ?? [];
    const normalized: RecurrenceException = {
      ...exception,
      createdAtIso: exception.createdAtIso ?? new Date().toISOString(),
    };
    const withoutDuplicate = existing.filter((entry) => !(entry.date === normalized.date && entry.reason === normalized.reason));
    return {
      ...state,
      recurrenceExceptions: {
        ...(state.recurrenceExceptions ?? {}),
        [exception.seriesId]: [...withoutDuplicate, normalized].sort((a, b) => a.date.localeCompare(b.date)),
      },
    };
  }

  getRecurrenceExceptions(state: PersistedState, seriesId: string): RecurrenceException[] {
    return [...(state.recurrenceExceptions?.[seriesId] ?? [])];
  }

  addRecurrenceOccurrence(state: PersistedState, occurrence: RecurrenceOccurrenceRecord): PersistedState {
    if (!occurrence.seriesId.trim() || !isValidIsoDate(occurrence.date)) return state;
    const existing = state.recurrenceOccurrences?.[occurrence.seriesId] ?? [];
    const normalized: RecurrenceOccurrenceRecord = {
      ...occurrence,
      completedAtIso: occurrence.completedAtIso ?? new Date().toISOString(),
    };
    const withoutDuplicate = existing.filter((entry) => !(entry.date === normalized.date && (entry.taskKey ?? '') === (normalized.taskKey ?? '')));
    return {
      ...state,
      recurrenceOccurrences: {
        ...(state.recurrenceOccurrences ?? {}),
        [occurrence.seriesId]: [...withoutDuplicate, normalized].sort((a, b) => a.date.localeCompare(b.date)),
      },
    };
  }

  getRecurrenceOccurrences(state: PersistedState, seriesId: string): RecurrenceOccurrenceRecord[] {
    return [...(state.recurrenceOccurrences?.[seriesId] ?? [])];
  }

  hasRecurrenceException(state: PersistedState, seriesId: string, date: string, reasons: Array<RecurrenceException['reason']> = ['skipped', 'deleted']): boolean {
    return (state.recurrenceExceptions?.[seriesId] ?? []).some((entry) => entry.date === date && reasons.includes(entry.reason));
  }

  /** Set clock-in state for a task. */
  setClockIn(state: PersistedState, taskKey: string, taskFilePath: string, taskLineNumber: number): PersistedState {
    return {
      ...state,
      clockInState: {
        taskKey,
        taskFilePath,
        taskLineNumber,
        clockInTimeIso: new Date().toISOString(),
      },
    };
  }

  /** Get current clock-in state (if any). */
  getClockInState(state: PersistedState): { taskKey: string; taskFilePath: string; taskLineNumber: number; clockInTimeIso: string } | undefined {
    return state.clockInState;
  }

  /** Clear clock-in state and return elapsed time in minutes. */
  clearClockIn(state: PersistedState): { state: PersistedState; elapsedMinutes: number } {
    const clockIn = state.clockInState;
    const clockInMs = clockIn ? Date.parse(clockIn.clockInTimeIso) : Number.NaN;
    const elapsedMinutes = clockIn && Number.isFinite(clockInMs)
      ? Math.max(0, Math.floor((Date.now() - clockInMs) / (1000 * 60)))
      : 0;
    return {
      state: { ...state, clockInState: undefined },
      elapsedMinutes,
    };
  }

  /** Update ICS cache for a URL. */
  setIcsCache(state: PersistedState, url: string, events: Array<{ summary: string; date: string | null; startTime?: string; endTime?: string; uid: string | null }>): PersistedState {
    const cache = state.icsCache ?? {};
    return {
      ...state,
      icsCache: {
        ...cache,
        [url]: {
          lastFetchIso: new Date().toISOString(),
          events,
        },
      },
    };
  }

  /** Get cached ICS events for a URL. */
  getIcsCache(state: PersistedState, url: string): { lastFetchIso: string; events: Array<{ summary: string; date: string | null; startTime?: string; endTime?: string; uid: string | null }> } | undefined {
    return (state.icsCache ?? {})[url];
  }

  /** Check if ICS cache needs refresh (older than refreshMinutes). */
  needsIcsCacheRefresh(state: PersistedState, url: string, refreshMinutes: number): boolean {
    const cached = this.getIcsCache(state, url);
    if (!cached) return true;
    const lastFetchMs = Date.parse(cached.lastFetchIso);
    if (Number.isNaN(lastFetchMs)) return true;
    const ageMinutes = Math.floor((Date.now() - lastFetchMs) / (1000 * 60));
    return ageMinutes >= refreshMinutes;
  }
}
