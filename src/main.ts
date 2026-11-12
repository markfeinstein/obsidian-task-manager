import {
  App,
  Menu,
  Modal,
  Notice,
  Plugin,
  Setting,
  Platform,
  TAbstractFile,
  TFile,
  TFolder,
  MarkdownView,
} from 'obsidian';
import { DEFAULT_SETTINGS, resolvedTaskStateIcon, shouldOverrideTaskStateIcon, type DashboardLayout, type DeferPreset, type SyncRunSummary, type TaskManagerSettings, type TaskStatus } from './types';
import { TaskManagerSettingTab } from './settings';
import { buildTaskNoteFrontmatter, calculateFirstRecurrenceDateForCompletedLine, durableCompletionDestinationAction, rewriteEditableDateField, rewritePriorityField, serializeTaskNoteFrontmatter, TaskScanner, taskMatchesGlobalFilter, type EditableTaskDateField, type ParsedTask, isTaskNoteFile, scanFileAsTask, scanFileWithTaskNotes } from './task-scanner';
import { rewriteSyncInlineField, rewriteSyncTaskTitle, TaskMutationService } from './task-mutation-service';
import { TaskMoveService } from './task-move-service';
import { TaskLifecycleTransferService } from './task-lifecycle-transfer-service';
import { TaskIndex, type TaskIndexChange } from './task-index';
import { MobileNotifier } from './mobile-notifier';
import { ReminderManager } from './reminder-manager';
import { ReminderIndex } from './reminder-index';
import { resolveReminderTaskForCompletion } from './reminder-task-resolution';
import { DailyNoteResolver } from './daily-note';
import { LogWriter } from './log-writer';
import { COMPLETION_RECORD_RETENTION_DAYS, CURRENT_STATE_VERSION, StateStore, type CompletionRecord, type PersistedState, type TimeSessionRecord } from './state-store';
import { completionStateRepository, reminderStateRepository, syncStateRepository, type ReminderStateSlice } from './state-slice-repositories';
import type { TaskSnapshotEntry } from './completion-detector';
import { CompletionCoordinator } from './completion-coordinator';
import { canonicalExplicitTasksForAffectedOwners, planScanLifecycleReconciliation } from './scan-lifecycle-reconciler';
import { collectVaultScanWork, currentScanReplacementsForEvidence, isScanPathEvidenceCurrent, planStaleIndexRollback, statNumber, type ScanPathEvidence } from './scan-coordinator';
import { formatTaskManagerQueryBlock, sampleTaskManagerQuery, TaskDatePickerModal, TaskQueryRenderer } from './query-renderer';
import { checkboxForStatus, cycleTaskCheckbox, legacyTaskKeyForBody, parseMarkdownTaskLine, sourceLineIdentity, splitContentLines, stripInlineTags } from './task-model';
import { ExplicitIdIndex, explicitTaskKey, legacyExplicitTaskKey } from './task-identity';
import { EXPLICIT_IDENTITY_STATE_VERSION, migrateExplicitIdentityState } from './task-identity-state';
import { addDate, formatLocalDate, maxDate } from './date-utils';
import { VoiceCapture } from './voice-capture';
import { createTaskLineToolbarExtension } from './task-line-toolbar';
import { createNlTaskInputExtension } from './nl-task-input';
import { ViewPlugin, type EditorView, type PluginValue } from '@codemirror/view';
import { autocompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import { VIEW_TYPE_TASK_PANEL, TaskPanelView } from './sidebar-view';
import {
  DASHBOARD_NOTE_CODE_BLOCK,
  DASHBOARD_WIDGET_CODE_BLOCK,
  DashboardMarkdownRenderer,
  VIEW_TYPE_DASHBOARD,
  DashboardView,
  dashboardIdFromName,
  exportDashboardLayout,
} from './dashboard';
import { VIEW_TYPE_TASK_CALENDAR, VIEW_TYPE_TASK_KANBAN, VIEW_TYPE_TASK_TABLE, VisualTaskView, type VisualTaskViewMode } from './visual-views';
import { MutationLog, setGlobalMutationLog } from './mutation-log';
import { detectLocale, setLocale, t } from './i18n';
import { QueryEditorModal } from './query-polish';
import { generateRecurrenceSeriesId } from './recurrence-series';
import { MobileURIHandler } from './mobile-uri-capture';
import { ensureExportPathExtension, exportToICS } from './exporters';
import { ensureParentFolders, normalizeVaultRelativePath } from './vault-utils';
import { VaultEventCoordinator } from './vault-event-coordinator';
import { initializeAccessibility, ScreenReaderAnnouncer } from './keyboard-nav';
import { taskIsHabit } from './habit-tracker';
import { applyAppearanceSettingsToDocument } from './appearance';
import { CliHandler } from './cli-handler';
import { IdentityMapper } from './sync-identity-mapper';
import { assertProviderRunCurrent, commitProviderImports, isProviderRunCancellation, ProviderSyncCoordinator, refreshGoogleCalendarTokenSettings, refreshGoogleTasksTokenSettings, refreshMicrosoftTodoTokenSettings, SyncOperationQueue, type ProviderImportCandidate, type ProviderRunContext, type ProviderSyncKey } from './sync-operations';
import { applySyncQueueReviewActions, emptyOperationQueueState, SyncConflictReportModal, type SyncQueueReviewAction, type SyncQueueReviewActionResult } from './sync-conflict-review';
import { applyTodoistImportMappings, bootstrapTodoistIdentityMappings, enqueueTodoistVaultOperations, planTodoistImports, TodoistAdapter, todoistExternalIdFromTask, todoistProjectionFromRemotePayload, todoistProjectionFromVaultTask } from './todoist-sync';
import { fetchGoogleTasks, GoogleTasksAdapter, googleTasksPayloadFromProjection, googleTasksPkceOAuthStart, googleTasksProjectionFromRemoteTask, googleTasksProjectionFromVaultTask, googleTasksRemoteVersion, googleTaskToMarkdownLine, reconcileGoogleTask } from './google-tasks-sync';
import { googleCalendarEventIdFromTaskId, identifyGoogleCalendarEvent, markdownTaskToGoogleCalendarEvent, upsertGoogleCalendarEvent } from './google-calendar-sync';
import { fetchMicrosoftTodoTasks, MicrosoftTodoAdapter, microsoftTodoPayloadFromProjection, microsoftTodoPkceOAuthStart, microsoftTodoProjectionFromRemoteTask, microsoftTodoProjectionFromVaultTask, microsoftTodoRemoteVersion, microsoftTodoToTaskLine, reconcileMicrosoftTodoTask } from './microsoft-todo-sync';
import { testGoogleCalendarProviderConnection, testGoogleTasksProviderConnection, testMicrosoftTodoProviderConnection, testTodoistProviderConnection } from './provider-connection-checks';
import { projectionsEqual, type SupportedFieldProjection } from './sync-reconciliation';
import { generatePkceVerifier, tokenExpiresSoon } from './oauth-pkce';
import { planAppleRemindersWebhookImport } from './apple-reminders-sync';
import { APPLE_REMINDERS_CLIPBOARD_MAX_BYTES, utf8ByteLength } from './input-budgets';
import { buildAppleRemindersShortcutUrl } from './apple-reminders-shortcut';
import { CalDAVClient, syncTasksWithCalDAV, testCalDAVConnection as testCalDAVProviderConnection } from './caldav-sync';
import { equivalentBasesContent, generateBasesExportFiles, generateBasesViewFiles, isOwnedGeneratedBasesFile, BASES_EXPORT_DIR } from './bases-integration';
import { LatestWorkQueue } from './latest-work-queue';
import { filterTasks, parseTaskQuery } from './task-query';
import { obsidianTaskFileInfoProvider, TaskQueryService } from './task-query-service';
import { serializeTaskQueryCsv, serializeTaskQueryMarkdown } from './task-query-output';
import {
  type EditableTaskLine,
  parseEditableTaskLine,
  formatEditableTaskLine,
  rewriteTaskLineForStatus,
  rewriteTaskLineForStatusWithLifecycle,
  rewriteSubmittedTaskLineForModal,
  emptyEditableTaskLine,
  csvEscape,
  escapeRegExp,
} from './modals/task-edit-helpers';
import { TaskNoteTargetFileSuggestModal, TaskTemplateSuggestModal, ProjectWorkspaceCreateModal, ExperimentalSyncConfirmationModal, SyncTestConnectionModal } from './modals/simple-modals';
import { VoiceCaptureRecordingModal } from './modals/voice-capture-modal';
import { TaskManagerAutoSuggest } from './modals/autosuggest';
import { GoogleCalendarQuickCaptureModal, QuickCaptureModal, QuickAddTaskModal } from './modals/quick-capture-modal';
import { GoogleCalendarSetupWizardModal } from './modals/google-calendar-setup-wizard';
import { GoogleTasksOAuthModal } from './modals/google-tasks-oauth-modal';
import { MicrosoftTodoOAuthModal } from './modals/microsoft-todo-oauth-modal';
import { WeeklyReviewModal } from './modals/weekly-review-modal';
import { ONBOARDING_QUERY_SNIPPET, ONBOARDING_VERSION, OnboardingModal, shouldAutoOpenOnboarding, type OnboardingActionResult } from './modals/onboarding-modal';
import { TaskEditModal } from './modals/task-edit-modal';
import { fetchSafeCalendarText } from './calendar-url-safety';
import { sanitizeUntrustedTaskText } from './untrusted-task-text';
import { commandHost } from './commands/command-host';
import { registerCoreTaskCommands as registerCoreTaskCommandSet } from './commands/register-core-task-commands';
import { registerExportCommands as registerExportCommandSet } from './commands/register-export-commands';
import { registerSyncCommands as registerSyncCommandSet } from './commands/register-sync-commands';
import { registerWorkspaceCommands as registerWorkspaceCommandSet } from './commands/register-workspace-commands';
import { registerAdvancedCommands as registerAdvancedCommandSet } from './commands/register-advanced-commands';
import { replaceEditorLineWithLines, showDurableLifecycleEditorNotice } from './commands/command-helpers';
import { isIndexableTaskFile, isIndexableTaskPath } from './task-path-policy';

// Re-exports: public API used by tests and external consumers
export {
  parseEditableTaskLine,
  type EditableTaskLine,
  buildModalStatusOptions,
  resolveModalDateInput,
  expandDateAbbreviation,
  computeModalLifecycleDates,
  suggestionDuplicatesExistingField,
  autoSuggestDynamicSuggestions,
  buildNlDateTokens,
  buildSlashSuggestions,
  resolveSlashSuggestion,
  buildAtAssigneeSuggestions,
  parseQuickAddInput,
} from './modals/task-edit-helpers';


const GOOGLE_CALENDAR_TASK_SYNC_PREFIX = 'task-map:';

function duplicateNonEmptyIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (!id) continue;
    if (seen.has(id)) duplicates.add(id);
    else seen.add(id);
  }
  return Array.from(duplicates).sort((left, right) => left.localeCompare(right));
}

function googleCalendarTaskSyncKey(task: Pick<ParsedTask, 'key' | 'stableKey'>): string {
  return task.stableKey || task.key;
}

function googleCalendarTaskMapEntry(taskKey: string, eventId: string): string {
  return `${GOOGLE_CALENDAR_TASK_SYNC_PREFIX}${encodeURIComponent(taskKey)}=${encodeURIComponent(eventId)}`;
}

function parseGoogleCalendarTaskMap(entries: Iterable<string>): Map<string, string> {
  const map = new Map<string, string>();
  for (const entry of entries) {
    if (!entry.startsWith(GOOGLE_CALENDAR_TASK_SYNC_PREFIX)) continue;
    const separator = entry.indexOf('=', GOOGLE_CALENDAR_TASK_SYNC_PREFIX.length);
    if (separator < 0) continue;
    try {
      const taskKey = decodeURIComponent(entry.slice(GOOGLE_CALENDAR_TASK_SYNC_PREFIX.length, separator));
      const eventId = decodeURIComponent(entry.slice(separator + 1));
      if (taskKey && eventId) map.set(taskKey, eventId);
    } catch {
      // Ignore malformed legacy/corrupt entries; plain synced event ids remain usable.
    }
  }
  return map;
}

function googleCalendarSyncedEventIds(entries: Iterable<string>, taskMap: ReadonlyMap<string, string>): Set<string> {
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!entry.startsWith(GOOGLE_CALENDAR_TASK_SYNC_PREFIX)) ids.add(entry);
  }
  for (const eventId of taskMap.values()) ids.add(eventId);
  return ids;
}

function serializeGoogleCalendarSyncEntries(syncedIds: Iterable<string>, taskMap: ReadonlyMap<string, string>): string[] {
  return [
    ...Array.from(syncedIds).filter((id) => id && !id.startsWith(GOOGLE_CALENDAR_TASK_SYNC_PREFIX)).sort(),
    ...Array.from(taskMap.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([taskKey, eventId]) => googleCalendarTaskMapEntry(taskKey, eventId)),
  ];
}

export interface TaskManagerQueryData {
  tasks: ParsedTask[] | string;
  count: number;
}

interface TaskManagerQueryResultBase {
  apiVersion: 1;
  executionTime: number;
}

export interface TaskManagerQuerySuccess extends TaskManagerQueryResultBase {
  success: true;
  data: TaskManagerQueryData;
  error?: never;
}

export interface TaskManagerQueryFailure extends TaskManagerQueryResultBase {
  success: false;
  error: string;
  data?: never;
}

export type TaskManagerQueryResult = TaskManagerQuerySuccess | TaskManagerQueryFailure;

export interface TaskManagerApiV1 {
  createTaskLineModal: (initialFields?: Partial<EditableTaskLine>) => Promise<string>;
  editTaskLineModal: (taskLine: string, initialFields?: Partial<EditableTaskLine>) => Promise<string>;
  executeToggleTaskDoneCommand: (line: string) => string;
  parseTaskLine: (line: string) => EditableTaskLine;
  formatTaskLine: (fields: Partial<EditableTaskLine>) => string;
  updateTaskLine: (line: string, patch: Partial<EditableTaskLine>) => string;
  getAllTasks: () => ParsedTask[];
  getTasksForFile: (filePath: string) => ParsedTask[];
  onTaskStatusChanged: (handler: (task: ParsedTask, oldStatus: TaskStatus) => void) => () => void;
  executeQuery: (queryString: string, format?: 'json' | 'csv' | 'markdown', context?: { sourcePath?: string }) => Promise<TaskManagerQueryResult>;
  onTaskCacheUpdated: (handler: (tasks: ParsedTask[]) => void) => () => void;
  isTaskIndexReady: () => boolean;
  whenTaskIndexReady: () => Promise<void>;
  getTaskIndexRevision: () => number;
  onTaskIndexChanged: (handler: (tasks: ParsedTask[], revision: number) => void) => () => void;
}

export default class TaskManagerPlugin extends Plugin {
  settings: TaskManagerSettings = DEFAULT_SETTINGS;
  apiV1!: TaskManagerApiV1;
  private scanner!: TaskScanner;
  private taskMutations!: TaskMutationService;
  private taskMoves!: TaskMoveService;
  private lifecycleTransfers!: TaskLifecycleTransferService;
  private dailyNoteResolver!: DailyNoteResolver;
  private logWriter!: LogWriter;
  private completionCoordinator: CompletionCoordinator | null = null;
  private stateStore!: StateStore;
  private queryRenderer!: TaskQueryRenderer;
  private scanTimer: number | null = null;
  private startupScanTimer: number | null = null;
  private fileEventsRegistered = false;
  private vaultEventCoordinator: VaultEventCoordinator | null = null;
  private lifecycleRecoveryRelease: (() => void) | null = null;
  private reminderTimer: number | null = null;
  private reminderManager!: ReminderManager;
  private reminderIndex: ReminderIndex | null = null;
  private reminderIdentityMigrationAttempted = false;
  private startupMissedReminderNoticeShown = false;
  private mutationLog!: MutationLog;
  private pendingFileScans = new Set<string>();
  private fileScanTimer: number | null = null;
  private fileScanRunning = false;
  private fullScanPromise: Promise<void> | null = null;
  private lifecycleGeneration = 0;
  private lifecycleActive = true;
  private scanAbortController: AbortController | null = new AbortController();
  private networkAbortController: AbortController | null = new AbortController();
  private fileScanRunGeneration: number | null = null;
  /** Monotonic per-path publication fences shared by full, queued, and direct scans. */
  private scanRequestCounter = 0;
  private pathScanEpochs = new Map<string, number>();
  /** Serializes index, lifecycle, fingerprint, persistence, and notification publication. */
  private scanPublicationQueue: Promise<void> = Promise.resolve();
  private taskStateStyleEl: HTMLStyleElement | null = null;
  private appearanceStyleEl: HTMLStyleElement | null = null;
  private screenReaderAnnouncer: ScreenReaderAnnouncer | null = null;
  private activeVoiceCapture: VoiceCapture | null = null;
  private snapshot = new Map<string, TaskSnapshotEntry>();
  private snapshotKeysByFile = new Map<string, Set<string>>();
  private completions: PersistedState['completions'] = [];
  private recurrenceCounts: PersistedState['recurrenceCounts'] = {};
  private pendingCompletionKeyMigrations = new Map<string, string>();
  private pendingRecurrenceCountMigrations = new Map<string, string>();
  private pendingRemovedIndexPaths = new Set<string>();
  /**
   * Guards against double-logging a completion to the daily note.
   * A key is added when an async log operation starts and removed when it finishes.
   * Without this, a concurrent vault scan could fire a second log for the same task.
   */
  private inFlightCompletions = new Set<string>();
  /**
   * When the query renderer toggles a task inside the today daily-note, the resulting
   * vault-modify event would normally trigger a completion log entry (since the task
   * moved from not-done → done). This set holds keys for those query-block completions
   * so the scanner skips logging them — avoiding duplicate entries when the task is
   * already visible on the same page as the log section.
   */
  private suppressedCompletionKeys = new Set<string>();
  /** ISO timestamp of the most recent full vault scan start. */
  private lastScanStartedAt: string | null = null;
  /** Duration (ms) of the most recent full vault scan. */
  private lastScanDurationMs: number | null = null;
  /** Number of files processed in the most recent scan. */
  private lastScanFileCount: number | null = null;
  /** Errors recorded during the most recent scan (up to 50). */
  private scanErrors: Array<{ file: string; message: string }> = [];
  private firedReminders = new Set<string>();
  /** Lifecycle-owned task index shared by the API and every rendered surface. */
  private taskIndex = new TaskIndex();
  /** Registered status-change event handlers. */
  private statusChangeHandlers: Array<(task: ParsedTask, oldStatus: TaskStatus) => void> = [];
  /** Registered cache update event handlers. */
  private cacheUpdateHandlers: Array<(tasks: ParsedTask[]) => void> = [];
  /** Status bar item for showing current and next task. */
  private statusBarItem: HTMLElement | null = null;
  /** Timer for updating the status bar every minute. */
  private statusBarUpdateTimer: number | null = null;
  private accessibilityCleanup: (() => void) | null = null;
  /** Durable identity mapper used by v2 external sync adapters. */
  private identityMapper: IdentityMapper | null = null;
  /** Durable operation queue used by v2 external sync adapters. */
  private syncOperationQueue: SyncOperationQueue | null = null;
  private providerSyncCoordinator?: ProviderSyncCoordinator;
  /** Serializes all identity/operation-queue projections into one authoritative path. */
  private syncStatePersistenceQueue: Promise<void> = Promise.resolve();
  private identityStateRevision = 0;
  private persistedIdentityStateRevision = 0;
  private syncQueueRevision = 0;
  private persistedSyncQueueRevision = 0;
  /** Coalesces interval and visibility reminder checks so notification delivery runs once. */
  private reminderCheckPromise: Promise<void> | null = null;
  /** Debounce timer for gated Bases auto-export. */
  private basesRefreshTimer: number | null = null;
  private basesExportQueue?: LatestWorkQueue;
  private onboardingProfileWasUnseen = false;
  private onboardingAutoOpenAttempted = false;
  private activeOnboarding: OnboardingModal | null = null;
  /** Last exclusion policy reconciled into the shared index. */
  private appliedExcludedFoldersSignature: string | null = null;

  private ensureSnapshotFileIndex(): Map<string, Set<string>> {
    if (!this.snapshotKeysByFile) this.rebuildSnapshotFileIndex();
    return this.snapshotKeysByFile;
  }

  private rebuildSnapshotFileIndex(): void {
    this.snapshotKeysByFile = new Map();
    for (const [key, entry] of this.snapshot ?? []) {
      const keys = this.snapshotKeysByFile.get(entry.filePath) ?? new Set<string>();
      keys.add(key);
      this.snapshotKeysByFile.set(entry.filePath, keys);
    }
  }

  private completionsBySourceFile(): Map<string, Array<(typeof this.completions)[number]>> {
    const result = new Map<string, Array<(typeof this.completions)[number]>>();
    for (const completion of this.completions ?? []) {
      const records = result.get(completion.sourcePath) ?? [];
      records.push(completion);
      result.set(completion.sourcePath, records);
    }
    return result;
  }

  private snapshotForFile(filePath: string): Map<string, TaskSnapshotEntry> {
    const result = new Map<string, TaskSnapshotEntry>();
    for (const key of this.ensureSnapshotFileIndex().get(filePath) ?? []) {
      const entry = this.snapshot.get(key);
      if (entry) result.set(key, entry);
    }
    return result;
  }

  private setSnapshotEntry(entry: TaskSnapshotEntry): void {
    const previous = this.snapshot.get(entry.key);
    if (previous && previous.filePath !== entry.filePath) {
      const previousKeys = this.ensureSnapshotFileIndex().get(previous.filePath);
      previousKeys?.delete(entry.key);
      if (previousKeys?.size === 0) this.snapshotKeysByFile.delete(previous.filePath);
    }
    this.snapshot.set(entry.key, entry);
    const keys = this.ensureSnapshotFileIndex().get(entry.filePath) ?? new Set<string>();
    keys.add(entry.key);
    this.snapshotKeysByFile.set(entry.filePath, keys);
  }

  private deleteSnapshotEntry(key: string, expectedFilePath?: string): void {
    const previous = this.snapshot.get(key);
    if (!previous || (expectedFilePath !== undefined && previous.filePath !== expectedFilePath)) return;
    this.snapshot.delete(key);
    const keys = this.ensureSnapshotFileIndex().get(previous.filePath);
    keys?.delete(key);
    if (keys?.size === 0) this.snapshotKeysByFile.delete(previous.filePath);
  }

  private clearSnapshotEntries(): void {
    this.snapshot.clear();
    this.ensureSnapshotFileIndex().clear();
  }

  private ensureLifecycleGeneration(): number {
    if (!Number.isInteger(this.lifecycleGeneration) || this.lifecycleGeneration <= 0) this.lifecycleGeneration = 1;
    if (this.lifecycleActive === undefined) this.lifecycleActive = true;
    if (!this.scanAbortController) this.scanAbortController = new AbortController();
    return this.lifecycleGeneration;
  }

  private isLifecycleGenerationActive(generation: number): boolean {
    return this.lifecycleActive !== false
      && this.lifecycleGeneration === generation
      && !this.scanAbortController?.signal.aborted;
  }

  private bumpPathScanEpoch(path: string): number {
    this.scanRequestCounter = (this.scanRequestCounter ?? 0) + 1;
    this.pathScanEpochs ??= new Map<string, number>();
    this.pathScanEpochs.set(path, this.scanRequestCounter);
    return this.scanRequestCounter;
  }

  private currentPathScanEpoch(path: string): number {
    return this.pathScanEpochs?.get(path) ?? 0;
  }

  private scanEvidenceFor(file: TFile, bump = true): ScanPathEvidence {
    const epoch = bump || this.currentPathScanEpoch(file.path) === 0
      ? this.bumpPathScanEpoch(file.path)
      : this.currentPathScanEpoch(file.path);
    const stat = (file as TFile & { stat?: { mtime?: number; size?: number } }).stat;
    return {
      epoch,
      mtime: statNumber(stat?.mtime),
      size: statNumber(stat?.size),
    };
  }

  private isPathScanEvidenceCurrent(path: string, evidence: ScanPathEvidence): boolean {
    const lookup = (this.app?.vault as { getAbstractFileByPath?: (target: string) => unknown } | undefined)?.getAbstractFileByPath;
    return isScanPathEvidenceCurrent(path, evidence, {
      excludedFolders: this.settings?.excludedFolders ?? [],
      currentEpoch: (target) => this.currentPathScanEpoch(target),
      lookup: typeof lookup === 'function' ? (target) => lookup.call(this.app.vault, target) as never : undefined,
    });
  }

  private enqueuePathForRescan(path: string): void {
    if (!isIndexableTaskPath(path, undefined, this.settings?.excludedFolders ?? [])) return;
    this.pendingFileScans ??= new Set<string>();
    this.pendingFileScans.add(path);
  }

  private scheduleQueuedScanDrain(): void {
    if (this.fileScanTimer !== null || this.fileScanRunning || this.pendingFileScans.size === 0) return;
    this.fileScanTimer = window.setTimeout(() => {
      this.fileScanTimer = null;
      void this.drainQueuedFileScans();
    }, 0);
  }

  private currentScanReplacements(
    replacements: ReadonlyMap<string, ParsedTask[]>,
    evidence: ReadonlyMap<string, ScanPathEvidence>,
  ): Map<string, ParsedTask[]> {
    const { current, stalePaths } = currentScanReplacementsForEvidence(
      replacements,
      evidence,
      (path, captured) => this.isPathScanEvidenceCurrent(path, captured),
    );
    for (const path of stalePaths) this.enqueuePathForRescan(path);
    return current;
  }

  private captureIndexPaths(paths: Iterable<string>): Map<string, { existed: boolean; tasks: ParsedTask[] }> {
    return new Map([...paths].map((path) => [path, {
      existed: this.getTaskIndex().hasFile(path),
      tasks: this.getTaskIndex().getTasksForFile(path),
    }]));
  }

  /** Undo transient commits whose immutable scan evidence became stale across an await. */
  private rollbackStaleIndexPaths(
    accepted: ReadonlyMap<string, ParsedTask[]>,
    current: ReadonlyMap<string, ParsedTask[]>,
    before: ReadonlyMap<string, { existed: boolean; tasks: ParsedTask[] }>,
  ): void {
    const { restore, remove } = planStaleIndexRollback(accepted.keys(), current, before, this.settings?.excludedFolders ?? []);
    if (restore.size > 0 || remove.length > 0) this.getTaskIndex().commit(restore, remove);
  }

  /** Immutable prior entries needed by one wave without cloning the whole vault snapshot. */
  private priorSnapshotForScanWave(replacements: ReadonlyMap<string, ParsedTask[]>): Map<string, TaskSnapshotEntry> {
    const prior = new Map<string, TaskSnapshotEntry>();
    for (const path of replacements.keys()) {
      for (const [key, entry] of this.snapshotForFile(path)) prior.set(key, entry);
    }
    for (const tasks of replacements.values()) {
      for (const task of tasks) {
        if (!task.metadata.id?.trim()) continue;
        const entry = this.snapshot.get(task.key);
        if (entry) prior.set(entry.key, entry);
      }
    }
    return prior;
  }

  private withScanPublicationLock<T>(operation: () => Promise<T>): Promise<T> {
    this.scanPublicationQueue ??= Promise.resolve();
    const result = this.scanPublicationQueue.then(operation, operation);
    this.scanPublicationQueue = result.then(() => undefined, () => undefined);
    return result;
  }

  private invalidateScanPathPrefix(prefix: string): void {
    this.bumpPathScanEpoch(prefix);
    for (const path of [...(this.pathScanEpochs?.keys() ?? [])]) {
      if (path.startsWith(`${prefix}/`)) this.bumpPathScanEpoch(path);
    }
  }

  private getTaskIndex(): TaskIndex {
    if (this.taskIndex) return this.taskIndex;
    const index = new TaskIndex();
    const legacy = (this as unknown as { tasksByFile?: Map<string, ParsedTask[]> }).tasksByFile;
    if (legacy instanceof Map) {
      index.beginHydration();
      index.markReady(false);
      index.commit(legacy);
    }
    this.taskIndex = index;
    return index;
  }

  private async ensureReminderIndexReady(): Promise<void> {
    if (this.getTaskIndex().getSnapshot().readiness !== 'ready') return;
    this.reminderIndex ??= new ReminderIndex(this.getTaskIndex());
    if (this.reminderIdentityMigrationAttempted) return;
    const index = this.reminderIndex;
    const repository = reminderStateRepository(this.stateStore);
    const migrate = (state: Readonly<ReminderStateSlice>): ReminderStateSlice => {
      let changed = false;
      const migrateRecord = <T extends { reminderKey: string; taskFilePath: string; taskLineNumber: number; taskText: string; originalReminderTime?: string; reminderTime?: string }>(record: T): T => {
        const reminderKey = index.keyForStoredRecord(record);
        const current = reminderKey ? index.resolve(reminderKey) : undefined;
        if (!reminderKey || !current) return record;
        if (record.reminderKey === reminderKey && record.taskFilePath === current.task.filePath
          && record.taskLineNumber === current.task.lineNumber && record.taskText === current.task.rawLine) return record;
        changed = true;
        return {
          ...record,
          reminderKey,
          taskFilePath: current.task.filePath,
          taskLineNumber: current.task.lineNumber,
          taskText: current.task.rawLine,
        };
      };
      const firedReminderKeys = Array.from(new Set((state.firedReminderKeys ?? []).map((encoded) => {
        const decoded = this.decodeFiredReminderKey(encoded);
        const key = index.migrateLegacyKey(decoded.key) ?? decoded.key;
        const migrated = decoded.firedAtIso ? this.encodeFiredReminderKey(key, decoded.firedAtIso) : key;
        if (migrated !== encoded) changed = true;
        return migrated;
      })));
      const snoozedReminders = (state.snoozedReminders ?? []).map(migrateRecord);
      const missedReminders = (state.missedReminders ?? []).map(migrateRecord);
      const queuedNotifications = (state.queuedNotifications ?? []).map(migrateRecord);
      return changed ? { ...state, snoozedReminders, missedReminders, queuedNotifications, firedReminderKeys } : state;
    };
    const existing = await repository.read();
    const projected = migrate(existing);
    const committed = projected === existing ? existing : await repository.update(migrate);
    this.firedReminders = new Set((committed.firedReminderKeys ?? []).map((entry) => this.decodeFiredReminderKey(entry).key));
    this.reminderIdentityMigrationAttempted = true;
    if (!this.startupMissedReminderNoticeShown && this.reminderManager) { this.startupMissedReminderNoticeShown = true; await this.showMissedRemindersNotice(); }
  }

  /** Returns scan/error telemetry consumed by DiagnosticsModal without unsafe casts. */
  getScanDiagnostics(): { lastScanStartedAt: string | null; lastScanDurationMs: number | null; lastScanFileCount: number | null; scanErrors: Array<{ file: string; message: string }> } {
    return {
      lastScanStartedAt: this.lastScanStartedAt,
      lastScanDurationMs: this.lastScanDurationMs,
      lastScanFileCount: this.lastScanFileCount,
      scanErrors: this.scanErrors,
    };
  }

  /** Public entry-point used by DiagnosticsModal to trigger a full vault scan. */
  async runFullScan(): Promise<void> {
    await this.scanVault();
  }

  /** Public entry-point used by DiagnosticsModal to generate the task health report. */
  async runHealthReport(): Promise<void> {
    await this.generateTaskHealthReport();
  }

  private async reconcilePendingLifecycleWork(): Promise<void> {
    if (!this.lifecycleActive) return;
    try {
      const moveReconciliation = await this.taskMoves.reconcilePendingMoves();
      const pendingMoveReconciliation = moveReconciliation.filter((result) => result.outcome === 'pending');
      if (pendingMoveReconciliation.length > 0) {
        console.warn('Task Manager: pending task move reconciliation', pendingMoveReconciliation);
        new Notice(`Task Manager: ${pendingMoveReconciliation.length} task move${pendingMoveReconciliation.length === 1 ? '' : 's'} require reconciliation. Run the task health report for details.`);
      }
    } catch (error) {
      console.error('Task Manager: task move reconciliation could not start', error);
      new Notice('Task Manager: pending task moves could not be reconciled. No move data was discarded; review the task health report and plugin logs.');
    }
    if (!this.lifecycleActive) return;
    try {
      const transferResults = await this.lifecycleTransfers.reconcilePendingTransfers();
      const pending = transferResults.filter((result) => result.outcome === 'pending');
      if (pending.length > 0) {
        console.warn('Task Manager: pending archive/collect reconciliation', pending);
        new Notice(`Task Manager: ${pending.length} archive/collect transfer${pending.length === 1 ? '' : 's'} require manual reconciliation. No journal was discarded.`);
      }
    } catch (error) {
      console.error('Task Manager: archive/collect reconciliation could not start', error);
      new Notice(t('error.lifecycleTransferReconcile'));
    }
  }

  async onload(): Promise<void> {
    this.lifecycleGeneration = (this.lifecycleGeneration ?? 0) + 1;
    this.lifecycleActive = true;
    this.scanAbortController?.abort();
    this.scanAbortController = new AbortController();
    this.networkAbortController?.abort();
    this.networkAbortController = new AbortController();
    this.reminderIdentityMigrationAttempted = false;
    this.startupMissedReminderNoticeShown = false;
    this.onboardingAutoOpenAttempted = false;
    this.activeOnboarding = null;
    this.fileEventsRegistered = false;
    this.vaultEventCoordinator = null;
    this.lifecycleRecoveryRelease?.();
    this.stateStore = new StateStore(this);
    let releaseLifecycleRecovery!: () => void;
    const lifecycleRecoveryGate = new Promise<void>((resolve) => { releaseLifecycleRecovery = resolve; });
    this.lifecycleRecoveryRelease = releaseLifecycleRecovery;
    this.stateStore.setLifecycleRecoveryGate(lifecycleRecoveryGate);
    this.onboardingProfileWasUnseen = !(await this.stateStore.hasPersistedSettingsProfile());
    await this.loadSettings();
    await this.loadPersistentState();
    if (this.stateStore.usesPlaintextSecretFallback(this.settings)) {
      this.app.workspace.onLayoutReady(() => { new Notice(t('warning.plaintextSecrets'), 15000); });
    }
    this.taskMoves = new TaskMoveService(this.app, this.stateStore, (id) => {
      if (this.getTaskIndex().getSnapshot().readiness !== 'ready') throw new Error('Task index is not fully healthy; retry the move after a successful full scan');
      const resolution = this.getTaskIndex().resolveExplicitId(id);
      if (resolution.kind !== 'ambiguous') return;
      const locations = resolution.matches.map((match) => `${match.filePath}:${match.lineNumber}`).join(', ');
      throw new Error(`Cannot move task ID ${id}: the ID is duplicated at ${locations}`);
    });
    this.lifecycleTransfers = new TaskLifecycleTransferService(this.app, this.stateStore);
    // Register commands/views without blocking on disk-backed reconciliation,
    // while fencing every new move/archive/collect until recovery completes.
    const recoveryGeneration = this.lifecycleGeneration;
    this.app.workspace.onLayoutReady(() => {
      if (!this.lifecycleActive || this.lifecycleGeneration !== recoveryGeneration) {
        releaseLifecycleRecovery();
        return;
      }
      void this.reconcilePendingLifecycleWork().finally(() => {
        releaseLifecycleRecovery();
        if (this.lifecycleRecoveryRelease === releaseLifecycleRecovery) this.lifecycleRecoveryRelease = null;
      });
    });
    // Initialize locale from settings, with fallback to browser language
    if (this.settings.preferredLocale) {
      setLocale(this.settings.preferredLocale);
    } else {
      detectLocale();
    }

    this.scanner = new TaskScanner(this.app, () => this.settings.supportedStates, () => this.settings.globalFilter, () => this.settings, () => this.stateStore);
    this.taskMutations = new TaskMutationService(
      this.app,
      this.scanner,
      () => this.settings.supportedStates,
      (path) => this.queryRenderer.invalidateCache(path),
      (path) => this.refreshAfterTaskMutation(path),
      (task) => {
        const id = task.metadata.id?.trim();
        if (!id) return;
        if (this.getTaskIndex().getSnapshot().readiness !== 'ready') throw new Error('Task index is not fully healthy; retry after a successful full scan');
        const resolution = this.getTaskIndex().resolveExplicitId(id);
        if (resolution.kind !== 'ambiguous') return;
        const locations = resolution.matches.map((match) => `${match.filePath}:${match.lineNumber}`).join(', ');
        throw new Error(`Cannot update task ID ${id}: the ID is duplicated at ${locations}`);
      },
    );
    this.reminderManager = new ReminderManager({ stateStore: this.stateStore, settings: this.settings });
    this.mutationLog = new MutationLog(this.app, () => this.settings);
    await this.mutationLog.initialize();
    setGlobalMutationLog(this.mutationLog);
    this.dailyNoteResolver = new DailyNoteResolver(this.app);
    this.logWriter = new LogWriter(this.app, () => this.settings);
    this.completionCoordinator = new CompletionCoordinator(this.stateStore, this.dailyNoteResolver, this.logWriter);
    this.screenReaderAnnouncer = new ScreenReaderAnnouncer('polite');
    this.queryRenderer = new TaskQueryRenderer(
      this.app,
      this.scanner,
      () => this.settings,
      this,
      (task: ParsedTask, sourcePath: string, nextCheckbox: string) => this.suppressDailyNoteQueryCompletion(task, sourcePath, nextCheckbox),
      (task: ParsedTask, onUpdated: () => void) => this.openTaskModalForSourceTask(task, onUpdated),
      async (task: ParsedTask, elapsedMs: number) => { await this.recordFocusTime(task, elapsedMs); },
      {
        stateStore: this.stateStore,
        fetchAndCacheIcsEvents: () => this.fetchAndCacheIcsEvents(),
        onClockInOut: (task: ParsedTask, isClockingIn: boolean) => this.handleClockInOut(task, isClockingIn),
        saveSettings: () => this.saveSettings(),
      },
      this.screenReaderAnnouncer,
      (statusSymbol: string | undefined, sourcePath: string, onUpdated: () => void, dates?: { due?: string }) => this.openCreateTaskModalForQuery(statusSymbol, sourcePath, onUpdated, dates),
      async () => {
        await this.getTaskIndex().whenReady();
        return this.getTaskIndex().getAllTasks();
      },
    );
    this.queryRenderer.setTaskMutations(this.taskMutations);
    this.refreshTaskStateStyles();
    this.refreshAppearanceStyles();

    this.addSettingTab(new TaskManagerSettingTab(this.app, this));
    this.registerView(VIEW_TYPE_TASK_PANEL, (leaf) => {
      const view = new TaskPanelView(
        leaf,
        () => this.settings,
        this.scanner,
        () => this.queryRenderer,
        (opts: { date?: string; statusSymbol?: string } | undefined) => {
          // onCreateTask: open the create/edit modal pre-filled with date/status from the panel
          const prefill = opts?.date
            ? `- [ ] 📅 ${opts.date}`
            : opts?.statusSymbol
            ? `- [${opts.statusSymbol}] `
            : '';
          new TaskEditModal(this.app, this.settings, prefill.trim(), async (line) => {
            // Keep the editor open until the vault write succeeds.
            await this.appendQuickCaptureTask(line);
          }, undefined, {}, undefined, () => this.saveSettings()).open();
        },
        async () => {
          await this.getTaskIndex().whenReady();
          return this.getTaskIndex().getAllTasks();
        },
      );
      view.setTaskMutations(this.taskMutations);
      return view;
    });
    this.registerView(VIEW_TYPE_DASHBOARD, (leaf) => new DashboardView(
      leaf,
      () => this.settings,
      this.scanner,
      () => this.queryRenderer,
      () => this.saveSettings(),
      this.stateStore,
      (text: string) => this.appendQuickCaptureTask(this.normalizeMobileCaptureTaskLine(text)),
      () => this.fetchAndCacheIcsEvents(),
      this.taskMutations,
      async () => {
        await this.getTaskIndex().whenReady();
        return this.getTaskIndex().getAllTasks();
      },
      async () => {
        await this.getTaskIndex().whenReady();
        const snapshot = this.getTaskIndex().getSnapshot();
        return { revision: snapshot.revision, tasks: snapshot.tasks };
      },
    ));
    this.registerView(VIEW_TYPE_TASK_TABLE, (leaf) => new VisualTaskView(leaf, 'table', () => this.queryRenderer));
    this.registerView(VIEW_TYPE_TASK_KANBAN, (leaf) => new VisualTaskView(leaf, 'kanban', () => this.queryRenderer));
    this.registerView(VIEW_TYPE_TASK_CALENDAR, (leaf) => new VisualTaskView(leaf, 'calendar', () => this.queryRenderer));
    this.registerTaskQueryCodeBlocks();
    this.registerDashboardMarkdownCodeBlocks();
    this.registerInlineTaskPostProcessor();
    this.registerEditorSuggest(new TaskManagerAutoSuggest(this.app, () => this.settings));
    this.registerObsidianPropertyTypes();
    this.registerApi();
    this.accessibilityCleanup = initializeAccessibility();
    this.registerMobileUriHandlers();

    this.registerCommands();
    this.app.workspace.onLayoutReady(() => { this.maybeOpenOnboarding(); });
    this.addRibbonIcon('layout-dashboard', 'Open Task Manager dashboard', () => {
      void this.openDashboard();
    });
    const vaultEventGeneration = this.lifecycleGeneration;
    this.app.workspace.onLayoutReady(() => {
      if (!this.lifecycleActive || this.lifecycleGeneration !== vaultEventGeneration || this.fileEventsRegistered) return;
      this.vaultEventCoordinator ??= new VaultEventCoordinator(
        this.app.vault,
        (event) => { this.registerEvent(event); },
        {
          modify: (file) => this.queueRescan(file),
          create: (file) => this.queueRescan(file),
          delete: (file) => this.handleDelete(file),
          rename: (file, oldPath) => this.handleRename(file, oldPath),
        },
      );
      this.fileEventsRegistered = this.vaultEventCoordinator.install();
      this.startupScanTimer = window.setTimeout(() => {
        this.startupScanTimer = null;
        if (this.lifecycleActive && this.lifecycleGeneration === vaultEventGeneration) void this.scanVault(false);
      }, 0);
    });
    this.registerNativeTaskCheckboxHandler();
    this.registerEditorExtension(this.buildLivePreviewExtension());
    this.registerEditorExtension(this.buildQueryBlockCompletion());
    this.registerEditorExtension(createTaskLineToolbarExtension(this.app, () => this.settings));
    this.registerEditorExtension(createNlTaskInputExtension(() => this.settings));
    this.startPeriodicScan();
    this.startReminderChecker();
    this.initializeStatusBarWidget();
    this.startStatusBarUpdater();

    // #16: visibility-change fires reminder checks when app comes back to foreground
    this.registerDomEvent(document, 'visibilitychange', () => {
      if (!document.hidden && this.settings.enableReminderNotifications) {
        void this.checkDueReminders();
      }
    });

    // #2: inline progress bars in reading / live-preview mode
    if (this.settings.inlineProgressBarsEnabled) {
      this.registerMarkdownPostProcessor((el) => {
        if (!this.settings.inlineProgressBarsEnabled) return;
        for (const li of Array.from(el.querySelectorAll<HTMLElement>('li'))) {
          const childList = li.querySelector(':scope > ul, :scope > ol');
          if (!childList) continue;
          const childCheckboxes = childList.querySelectorAll<HTMLInputElement>(':scope > li > input[type="checkbox"]');
          if (childCheckboxes.length === 0) continue;
          const total = childCheckboxes.length;
          const done = Array.from(childCheckboxes).filter((cb) => cb.checked).length;
          const existing = li.querySelector('.task-manager-inline-progress');
          if (existing) { existing.textContent = `${done}/${total}`; continue; }
          const badge = document.createElement('span');
          badge.className = 'task-manager-inline-progress';
          badge.textContent = `${done}/${total}`;
          const target = li.querySelector('p') ?? li;
          target.appendChild(badge);
        }
      });
    }

    // Obsidian 1.12.2+ CLI handler; older supported app versions keep working without it.
    const cliRegistrar = typeof (this as unknown as { registerCliHandler?: unknown }).registerCliHandler === 'function'
      ? this.registerCliHandler.bind(this)
      : undefined;
    new CliHandler(
      this.app,
      this.scanner,
      () => this.settings,
      () => this.apiV1.getAllTasks(),
      cliRegistrar,
      () => this.getTaskIndex().whenReady(),
    ).register();

    // #21: Datacore registration
    if (this.settings.datacoreEnabled) {
      this.app.workspace.onLayoutReady(() => { void this.registerWithDatacoreWhenReady(); });
    }

  }
  onunload(): void {
    this.lifecycleActive = false;
    this.basesExportQueue?.invalidate();
    this.fileEventsRegistered = false;
    this.vaultEventCoordinator = null;
    this.lifecycleRecoveryRelease?.();
    this.lifecycleRecoveryRelease = null;
    this.lifecycleGeneration = (this.lifecycleGeneration ?? 0) + 1;
    this.scanAbortController?.abort();
    this.scanAbortController = null;
    this.networkAbortController?.abort();
    this.networkAbortController = null;
    this.fullScanPromise = null;
    this.fileScanRunning = false;
    this.fileScanRunGeneration = null;
    if (this.startupScanTimer !== null) {
      window.clearTimeout(this.startupScanTimer);
      this.startupScanTimer = null;
    }
    this.stopPeriodicScan();
    this.stopReminderChecker();
    this.stopStatusBarUpdater();
    this.queryRenderer?.stopAllFocusTimers();
    this.activeVoiceCapture?.abort();
    this.activeVoiceCapture = null;
    this.activeOnboarding?.close();
    this.activeOnboarding = null;
    this.completionCoordinator = null;
    this.taskStateStyleEl?.remove();
    this.taskStateStyleEl = null;
    this.appearanceStyleEl?.remove();
    this.appearanceStyleEl = null;
    this.screenReaderAnnouncer?.destroy();
    this.screenReaderAnnouncer = null;
    this.accessibilityCleanup?.();
    this.accessibilityCleanup = null;
    if (this.fileScanTimer !== null && this.fileScanTimer !== undefined) {
      window.clearTimeout(this.fileScanTimer);
      this.fileScanTimer = null;
    }
    const legacyPendingTimers = this.pendingFileScans as unknown as Map<string, number>;
    if (legacyPendingTimers instanceof Map) {
      for (const timer of legacyPendingTimers.values()) window.clearTimeout(timer);
    }
    this.pendingFileScans?.clear();
    this.reminderIndex?.dispose();
    this.reminderIndex = null;
    this.getTaskIndex().dispose();
    if (this.basesRefreshTimer !== null && this.basesRefreshTimer !== undefined) {
      window.clearTimeout(this.basesRefreshTimer);
      this.basesRefreshTimer = null;
    }
    this.statusChangeHandlers = [];
    this.cacheUpdateHandlers = [];
  }

  async loadSettings(): Promise<void> {
    this.stateStore = this.stateStore ?? new StateStore(this);
    this.settings = await this.stateStore.loadSettings(DEFAULT_SETTINGS);
    this.appliedExcludedFoldersSignature = excludedFoldersSignature(this.settings.excludedFolders);
  }

  async saveSettings(): Promise<void>; async saveSettings(shouldContinue: () => boolean): Promise<boolean>;
  async saveSettings(shouldContinue: () => boolean = () => true): Promise<boolean | void> {
    const nextExclusions = excludedFoldersSignature(this.settings.excludedFolders);
    const exclusionsChanged = this.appliedExcludedFoldersSignature !== null
      && this.appliedExcludedFoldersSignature !== nextExclusions;
    const committed = await this.stateStore.saveSettings(this.settings, shouldContinue);
    if (committed === false || !shouldContinue()) { if (committed === false && this.stateStore.usesPlaintextSecretFallback?.(this.settings)) new Notice('Task Manager: secure credential storage is unavailable. Active credentials were not saved; update Obsidian and retry.'); return false; }
    this.refreshAppearanceStyles();
    this.reminderManager.refreshCache();
    if (exclusionsChanged) {
      this.appliedExcludedFoldersSignature = nextExclusions;
      for (const path of this.getTaskIndex().getPaths()) this.bumpPathScanEpoch(path);
      await this.scanVault(false, true);
    } else if (this.appliedExcludedFoldersSignature === null) {
      this.appliedExcludedFoldersSignature = nextExclusions;
    }
    return true;
  }
  refreshWatchers(): void {
    this.stopPeriodicScan();
    this.startPeriodicScan();
    this.stopReminderChecker();
    this.startReminderChecker();
  }

  async refreshTaskConfiguration(rebaselineSnapshot = false): Promise<void> {
    this.queryRenderer?.invalidateCache();
    this.refreshTaskStateStyles();
    if (rebaselineSnapshot) {
      this.clearSnapshotEntries();
      await this.scanVault(false, true);
    }
  }

  private refreshTaskStateStyles(): void {
    this.taskStateStyleEl ??= document.head.createEl('style', { attr: { 'data-task-manager-state-styles': 'true' } });
    this.taskStateStyleEl.setText(this.buildTaskStateCss());
  }

  private refreshAppearanceStyles(): void {
    if (typeof document === 'undefined') return;
    this.appearanceStyleEl = applyAppearanceSettingsToDocument(this.settings);
  }

  private refreshAfterTaskMutation(path: string): void {
    this.queryRenderer.refreshAllVisible();
    this.refreshActiveMarkdownPreview(path);
  }

  private refreshActiveMarkdownPreview(path: string): void {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || view.file?.path !== path || view.getMode() !== 'preview') return;
    const preview = view.previewMode;
    const scroll = preview.getScroll();
    preview.rerender(true);
    requestAnimationFrame(() => preview.applyScroll(scroll));
  }

  private buildTaskStateCss(): string {
    return this.settings.supportedStates.filter(shouldOverrideTaskStateIcon).map((state) => {
      const selectors = this.taskStateSelectors(state.rawText);
      const iconUrl = this.cssString(this.taskStateIconDataUrl(resolvedTaskStateIcon(state)));
      return `${selectors.join(',\n')} {\n  --checkbox-marker-color: transparent !important;\n  --checkbox-color-hover: transparent !important;\n  appearance: none !important;\n  -webkit-appearance: none !important;\n  align-items: center !important;\n  background: transparent !important;\n  background-color: transparent !important;\n  background-image: url(${iconUrl}) !important;\n  background-position: center !important;\n  background-repeat: no-repeat !important;\n  background-size: contain !important;\n  border: 0 !important;\n  border-radius: 0 !important;\n  box-shadow: none !important;\n  color: transparent !important;\n  display: inline-flex !important;\n  justify-content: center !important;\n  mask: none !important;\n  -webkit-mask: none !important;\n  position: relative !important;\n}\n${selectors.map((selector) => `${selector}::before`).join(',\n')},\n${selectors.map((selector) => `${selector}::after`).join(',\n')} {\n  background: none !important;\n  border: 0 !important;\n  box-shadow: none !important;\n  clip-path: none !important;\n  content: none !important;\n  display: none !important;\n  mask: none !important;\n  -webkit-mask: none !important;\n}\n`;
    }).join('\n');
  }

  private taskStateSelectors(rawText: string): string[] {
    const dataTask = this.cssString(rawText);
    const selectors = [
      `.markdown-preview-view input.task-list-item-checkbox[data-task=${dataTask}]`,
      `.markdown-preview-view .task-list-item[data-task=${dataTask}] > input.task-list-item-checkbox`,
      `.markdown-preview-view .task-list-item[data-task=${dataTask}] > p > input.task-list-item-checkbox`,
      `.markdown-source-view.mod-cm6 input.task-list-item-checkbox[data-task=${dataTask}]`,
      `.markdown-source-view.mod-cm6 .HyperMD-task-line[data-task=${dataTask}] input.task-list-item-checkbox`,
      `.markdown-source-view.mod-cm6 .task-list-item[data-task=${dataTask}] input.task-list-item-checkbox`,
    ];

    if (rawText === ' ') {
      selectors.push(
        '.markdown-preview-view input.task-list-item-checkbox[data-task=""]',
        '.markdown-preview-view input.task-list-item-checkbox:not([data-task])',
        '.markdown-preview-view .task-list-item[data-task=""] > input.task-list-item-checkbox',
        '.markdown-preview-view .task-list-item[data-task=""] > p > input.task-list-item-checkbox',
        '.markdown-preview-view .task-list-item:not([data-task]) > input.task-list-item-checkbox',
        '.markdown-preview-view .task-list-item:not([data-task]) > p > input.task-list-item-checkbox',
        '.markdown-source-view.mod-cm6 input.task-list-item-checkbox[data-task=""]',
        '.markdown-source-view.mod-cm6 input.task-list-item-checkbox:not([data-task])',
        '.markdown-source-view.mod-cm6 .HyperMD-task-line[data-task=""] input.task-list-item-checkbox',
        '.markdown-source-view.mod-cm6 .HyperMD-task-line:not([data-task]) input.task-list-item-checkbox',
      );
    }

    return this.withCheckboxStateVariants(selectors);
  }

  private withCheckboxStateVariants(selectors: readonly string[]): string[] {
    return selectors.flatMap((selector) => [selector, `${selector}:checked`, `${selector}:not(:checked)`]);
  }

  private registerTaskQueryCodeBlocks(): void {
    const names = new Set([this.settings.queryCodeBlockName, 'task-list', 'task-manager']);
    if (this.settings.tasksCodeBlockMode === 'always' || (this.settings.tasksCodeBlockMode === 'when-upstream-absent' && !this.isUpstreamTasksPluginInstalled())) {
      names.add('tasks');
    }
    for (const name of names) {
      if (name.trim()) {
        this.registerMarkdownCodeBlockProcessor(name.trim(), (source, el, ctx) => this.queryRenderer.render(source, el, ctx));
      }
    }
  }

  private registerDashboardMarkdownCodeBlocks(): void {
    const renderer = new DashboardMarkdownRenderer({
      app: this.app,
      scanner: this.scanner,
      getSettings: () => this.settings,
      getRenderer: () => this.queryRenderer,
      stateStore: this.stateStore,
      taskMutations: this.taskMutations,
      onCreateTask: (text: string) => this.appendQuickCaptureTask(this.normalizeMobileCaptureTaskLine(text)),
      saveSettings: () => this.saveSettings(),
      fetchIcsEvents: () => this.fetchAndCacheIcsEvents(),
      getIndexedTasks: async () => {
        await this.getTaskIndex().whenReady();
        return this.getTaskIndex().getAllTasks();
      },
    });
    this.registerMarkdownCodeBlockProcessor(DASHBOARD_NOTE_CODE_BLOCK, (source, el, ctx) => { void renderer.renderDashboard(source, el, ctx); });
    this.registerMarkdownCodeBlockProcessor(DASHBOARD_WIDGET_CODE_BLOCK, (source, el, ctx) => { void renderer.renderWidget(source, el, ctx); });
  }

  private isUpstreamTasksPluginInstalled(): boolean {
    const plugins = (this.app as unknown as { plugins?: { plugins?: Record<string, unknown>; manifests?: Record<string, unknown> } }).plugins;
    return Boolean(plugins?.plugins?.['obsidian-tasks-plugin'] || plugins?.manifests?.['obsidian-tasks-plugin']);
  }

  private registerInlineTaskPostProcessor(): void {
    this.registerMarkdownPostProcessor((el, ctx) => {
      if (el.closest?.('.task-manager-query')) return;
      void this.enhanceInlineTasks(el, ctx.sourcePath);
    });
  }

  private async enhanceInlineTasks(el: HTMLElement, sourcePath: string): Promise<void> {
    const abstractFile = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!this.isMarkdownFile(abstractFile)) return;
    const content = await this.app.vault.cachedRead(abstractFile);
    const lines = content.split(/\r?\n/u);
    for (const item of Array.from(el.querySelectorAll<HTMLElement>('li.task-list-item'))) {
      if (item.hasClass('task-manager-inline-enhanced') || item.closest('.task-manager-query')) continue;
      const checkbox = item.querySelector<HTMLInputElement>('input.task-list-item-checkbox');
      if (!checkbox) continue;
      const lineNumber = this.lineNumberFromElement(item) ?? this.lineNumberFromTaskCheckbox(checkbox);
      if (lineNumber === null || lineNumber < 1) continue;
      const rawLine = lines[lineNumber - 1];
      if (!rawLine) continue;
      const task = this.scanner.parseTaskLine(rawLine, abstractFile.path, lineNumber);
      if (!task) continue;
      item.addClass('task-manager-inline-enhanced');
      this.stripMetadataFromRenderedTaskItem(item);
      item.appendChild(this.renderInlineTaskExtras(abstractFile, task));
    }
  }

  private renderInlineTaskExtras(file: TFile, task: ParsedTask): HTMLElement {
    const extras = document.createElement('span');
    extras.addClass('task-manager-inline-extras');
    this.appendInlineMetadata(extras, file, task);

    if (this.canPostponeTask(task)) {
      const postpone = document.createElement('button');
      postpone.addClass('task-manager-query-defer');
      postpone.setAttr('type', 'button');
      postpone.setText('⏩');
      postpone.setAttr('title', 'Postpone task');
      postpone.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        void this.deferInlineTask(file, task, 1);
      });
      postpone.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.openInlineDeferMenu(event, file, task);
      });
      extras.appendChild(document.createTextNode(' '));
      extras.appendChild(postpone);
    }

    const edit = document.createElement('button');
    edit.addClass('task-manager-query-edit');
    edit.setAttr('type', 'button');
    edit.setText('✎');
    edit.setAttr('title', 'Edit task');
    edit.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.openTaskModalForSourceTask(task, () => this.queryRenderer.invalidateCache(task.filePath));
    });
    extras.appendChild(document.createTextNode(' '));
    extras.appendChild(edit);
    return extras;
  }

  private appendInlineMetadata(container: HTMLElement, file: TFile, task: ParsedTask): void {
    const dates: Array<{ label: string; field: EditableTaskDateField; value?: string }> = [
      { label: 'due', field: 'due', value: task.metadata.dates.due },
      { label: 'scheduled', field: 'scheduled', value: task.metadata.dates.scheduled },
      { label: 'start', field: 'start', value: task.metadata.dates.start },
      { label: 'created', field: 'created', value: task.metadata.dates.created },
      { label: 'done', field: 'done', value: task.metadata.dates.done },
      { label: 'cancelled', field: 'cancelled', value: task.metadata.dates.cancelled },
      { label: 'reminder', field: 'reminder', value: task.metadata.reminder },
    ];
    for (const { label, field, value } of dates) {
      if (!value) continue;
      container.appendChild(document.createTextNode(' · '));
      const dateEl = document.createElement('span');
      dateEl.addClass('task-manager-query-metadata', 'task-manager-query-metadata-date');
      dateEl.setText(`${label} ${value}`);
      dateEl.setAttr('title', `${label} ${value} - click to choose a date, right-click for quick adjustments`);
      dateEl.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.openInlineDatePicker(file, task, field);
      });
      dateEl.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.openInlineDateFieldMenu(event, file, task, field);
      });
      container.appendChild(dateEl);
    }
    if (task.metadata.priority && task.metadata.priority !== 'normal') {
      container.appendChild(document.createTextNode(' · '));
      const priorityEl = document.createElement('span');
      priorityEl.addClass('task-manager-query-metadata', 'task-manager-query-metadata-priority');
      priorityEl.setText(`priority ${task.metadata.priority}`);
      priorityEl.setAttr('title', `priority ${task.metadata.priority} - right-click to change`);
      priorityEl.addEventListener('contextmenu', (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.openInlinePriorityMenu(event, file, task);
      });
      container.appendChild(priorityEl);
    }
  }

  private stripMetadataFromRenderedTaskItem(item: HTMLElement): void {
    const walker = document.createTreeWalker(item, NodeFilter.SHOW_TEXT);
    const nodes: Text[] = [];
    let node = walker.nextNode();
    while (node) {
      if (/[📅📆🗓⏳⌛🛫✅➕❌⛔⏰⌚🔺⏫🔼🔽⏬🏁🆔🔁]/u.test(node.textContent ?? '')) {
        nodes.push(node as Text);
      }
      node = walker.nextNode();
    }
    for (const textNode of nodes) {
      if (textNode.textContent) {
        textNode.textContent = textNode.textContent
          .replace(/\s*[📅📆🗓⏳⌛🛫✅➕❌⛔⏰]\s*\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?/gu, '')
          .replace(/\s*⌚\s*\d{1,2}:\d{2}(?:\s*-\s*\d{1,2}:\d{2})?/gu, '')
          .replace(/\s*🔁\s+.+?(?=\s*[📅📆🗓⏳⌛🛫✅➕❌⛔⏰⌚🔺⏫🔼🔽⏬🏁🆔]|$)/gu, '')
          .replace(/\s*[🔺⏫🔼🔽⏬]/gu, '')
          .replace(/\s*🏁\s+(?:move[-\s]+to[-\s]+end|delete|archive|collect|keep)(?=\s|$)/giu, '')
          .replace(/\s*🏁\s+.+?(?=\s*[📅📆🗓⏳⌛🛫✅➕❌⛔⏰⌚🔺⏫🔼🔽⏬🏁🆔]|$)/gu, '')
          .replace(/\s*🆔\s+\S+/gu, '')
          .replace(/\s*⛔\s+(?!\d{4}-\d{2}-\d{2})\S+/gu, '')
          .trimEnd();
      }
    }
  }

  private openInlinePriorityMenu(event: MouseEvent, file: TFile, task: ParsedTask): void {
    const menu = new Menu();
    for (const priority of ['highest', 'high', 'medium', 'normal', 'low', 'lowest']) {
      const isCurrent = task.metadata.priority === priority;
      menu.addItem((item) => {
        item.setTitle(`${priority}${isCurrent ? ' ✓' : ''}`);
        item.onClick(() => {
          void this.updateInlineTaskPriority(file, task, priority);
        });
      });
    }
    menu.showAtMouseEvent(event);
  }

  private async saveActiveDashboardAsNote(): Promise<void> {
    const activeId = this.settings.activeDashboardId || 'default';
    const layout = this.settings.dashboardLayouts?.[activeId] ?? this.settings.dashboardLayouts?.default;
    if (!layout) {
      new Notice('Task Manager: open the dashboard once before saving it as a note.');
      return;
    }
    const baseName = dashboardIdFromName(layout.name || layout.id || 'dashboard');
    const path = this.uniqueDashboardNotePath(`Task Dashboards/${baseName}.md`);
    await this.writeVaultFile(path, this.dashboardNoteMarkdown(layout));
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) await this.app.workspace.getLeaf(true).openFile(file, { active: true });
    new Notice(`Task Manager: saved dashboard note to ${path}`);
  }

  private uniqueDashboardNotePath(preferredPath: string): string {
    if (!this.app.vault.getAbstractFileByPath(preferredPath)) return preferredPath;
    const dot = preferredPath.lastIndexOf('.');
    const stem = dot >= 0 ? preferredPath.slice(0, dot) : preferredPath;
    const ext = dot >= 0 ? preferredPath.slice(dot) : '';
    let counter = 2;
    let candidate = `${stem}-${counter}${ext}`;
    while (this.app.vault.getAbstractFileByPath(candidate)) {
      counter += 1;
      candidate = `${stem}-${counter}${ext}`;
    }
    return candidate;
  }

  private dashboardNoteMarkdown(layout: DashboardLayout): string {
    const exported = exportDashboardLayout(layout).trim();
    return [
      '---',
      'task-manager-dashboard: true',
      `dashboard-id: ${JSON.stringify(layout.id)}`,
      `dashboard-name: ${JSON.stringify(layout.name)}`,
      '---',
      '',
      `# ${layout.name}`,
      '',
      'This note contains a live Task Manager dashboard. Move, link, pin, or duplicate it like any other note.',
      '',
      `\`\`\`${DASHBOARD_NOTE_CODE_BLOCK}`,
      exported,
      '```',
      '',
      '## Add a standalone widget',
      '',
      `Use \`${DASHBOARD_WIDGET_CODE_BLOCK}\` code blocks in any note, for example:`,
      '',
      `\`\`\`${DASHBOARD_WIDGET_CODE_BLOCK}`,
      'type: agenda',
      'title: Agenda',
      'size: large',
      '```',
      '',
    ].join('\n');
  }

  private async openDashboard(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_DASHBOARD);
    if (existing.length > 0) {
      await this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE_DASHBOARD, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  private async openVisualTaskView(mode: VisualTaskViewMode): Promise<void> {
    const type = mode === 'table' ? VIEW_TYPE_TASK_TABLE : mode === 'kanban' ? VIEW_TYPE_TASK_KANBAN : VIEW_TYPE_TASK_CALENDAR;
    const existing = this.app.workspace.getLeavesOfType(type);
    if (existing.length > 0) {
      await this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  private async updateInlineTaskPriority(file: TFile, task: ParsedTask, priority: string): Promise<void> {
    try {
      await this.taskMutations.updateTaskPriority(file, task, priority);
    } catch (error) {
      new Notice(`Task Manager: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private lineNumberFromElement(element: HTMLElement): number | null {
    const rawLine = element.getAttr?.('data-line') ?? element.getAttribute('data-line');
    return rawLine && /^\d+$/u.test(rawLine) ? Number.parseInt(rawLine, 10) + 1 : null;
  }

  private isMarkdownFile(value: TAbstractFile | null): value is TFile {
    return Boolean(value && typeof value === 'object' && 'extension' in value && value.extension === 'md');
  }

  private taskStateIconDataUrl(icon: string): string {
    const escapedIcon = icon
      .replace(/&/gu, '&amp;')
      .replace(/</gu, '&lt;')
      .replace(/>/gu, '&gt;');
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><text x="8" y="8" text-anchor="middle" dominant-baseline="central" font-size="13">${escapedIcon}</text></svg>`;
    return `data:image/svg+xml,${encodeURIComponent(svg)}`;
  }

  private cssString(value: string): string {
    return JSON.stringify(value).replace(/</gu, '\\3c ');
  }

  private registerObsidianPropertyTypes(): void {
    try {
      const metadataTypeManager = (this.app as unknown as {
        metadataTypeManager?: {
          getAssignedType?: (name: string) => string | null;
          setType?: (name: string, type: string) => void;
          types?: Record<string, unknown>;
          save?: () => void;
        };
      }).metadataTypeManager;
      if (!metadataTypeManager?.setType) return;
      const checkboxProperties = [
        'TQ_explain', 'TQ_short_mode', 'TQ_show_backlink', 'TQ_show_cancelled_date', 'TQ_show_created_date',
        'TQ_show_depends_on', 'TQ_show_done_date', 'TQ_show_due_date', 'TQ_show_edit_button', 'TQ_show_id',
        'TQ_show_on_completion', 'TQ_show_postpone_button', 'TQ_show_priority', 'TQ_show_recurrence_rule',
        'TQ_show_scheduled_date', 'TQ_show_start_date', 'TQ_show_tags', 'TQ_show_task_count', 'TQ_show_toolbar',
        'TQ_show_tree', 'TQ_show_urgency', 'TQ_show_reminder_date',
      ];
      // Obsidian canonicalises property names to lowercase for widget-type lookup (the same way it
      // lowercases frontmatter keys in metadataTypeManager). Registering under the original mixed-case
      // `TQ_…` name writes a types.json entry the lookup never matches, so the checkbox/text widgets
      // silently fall back to plain text. Always register using the lowercase key.
      const desired: Array<[string, string]> = [
        ['tq_extra_instructions', 'text'],
        ...checkboxProperties.map((property) => [property.toLowerCase(), 'checkbox'] as [string, string]),
      ];
      for (const [property, type] of desired) {
        if (metadataTypeManager.getAssignedType?.(property) !== type) metadataTypeManager.setType?.(property, type);
      }
      // Prune stale mixed-case `TQ_…` entries written by older builds so the Properties panel doesn't
      // show orphaned, never-matched duplicates alongside the working lowercase ones.
      try {
        const registry = metadataTypeManager.types;
        if (registry) {
          let pruned = false;
          for (const key of Object.keys(registry)) {
            if (key.toLowerCase().startsWith('tq_') && key !== key.toLowerCase()) {
              delete registry[key];
              pruned = true;
            }
          }
          if (pruned) metadataTypeManager.save?.();
        }
      } catch { /* best-effort cleanup; the lowercase types are already registered above */ }
    } catch (error) {
      console.warn('Task Manager: failed to register Query File Defaults property types', error);
    }
  }

  private registerApi(): void {
    this.apiV1 = {
      createTaskLineModal: (initialFields?: Partial<EditableTaskLine>) => new Promise((resolve) => {
        new TaskEditModal(this.app, this.settings, '', (line) => resolve(line), () => resolve(''), initialFields, undefined, () => this.saveSettings()).open();
      }),
      editTaskLineModal: (taskLine: string, initialFields?: Partial<EditableTaskLine>) => new Promise((resolve) => {
        new TaskEditModal(this.app, this.settings, taskLine, (line) => resolve(line), () => resolve(''), initialFields, undefined, () => this.saveSettings()).open();
      }),
      executeToggleTaskDoneCommand: (line: string) => toggleTaskLineDone(line, this.settings),
      parseTaskLine: (line: string) => parseEditableTaskLine(line),
      formatTaskLine: (fields: Partial<EditableTaskLine>) => formatEditableTaskLine({ ...emptyEditableTaskLine(), ...fields }, this.settings.taskFormat),
      updateTaskLine: (line: string, patch: Partial<EditableTaskLine>) => formatEditableTaskLine({ ...parseEditableTaskLine(line), ...patch }, this.settings.taskFormat),
      getAllTasks: () => { if (!this.getTaskIndex().isReady()) throw new Error('Task index is not ready; await whenTaskIndexReady() before reading tasks'); return this.getTaskIndex().getAllTasks(); },
      getTasksForFile: (filePath: string) => { if (!this.getTaskIndex().isReady()) throw new Error('Task index is not ready; await whenTaskIndexReady() before reading tasks'); return this.getTaskIndex().getTasksForFile(filePath); },
      onTaskStatusChanged: (handler: (task: ParsedTask, oldStatus: TaskStatus) => void) => {
        this.statusChangeHandlers.push(handler);
        return () => { this.statusChangeHandlers = this.statusChangeHandlers.filter((h) => h !== handler); };
      },
      executeQuery: async (queryString: string, format?: 'json' | 'csv' | 'markdown', context?: { sourcePath?: string }) => {
        const startTime = Date.now();
        try {
          if (typeof queryString !== 'string' || queryString.trim().length === 0) {
            return { apiVersion: 1, success: false, error: 'Query string is empty', executionTime: Date.now() - startTime };
          }
          await this.getTaskIndex().whenReady();
          const allTasks = this.apiV1.getAllTasks();
          const queryService = new TaskQueryService(() => this.settings, obsidianTaskFileInfoProvider(this.app));
          const { tasks: filtered } = queryService.execute(allTasks, queryString, { ...(context?.sourcePath ? { sourcePath: context.sourcePath } : {}) });
          const executionTime = Date.now() - startTime;

          if (format === 'csv') {
            return { apiVersion: 1, success: true, data: { tasks: serializeTaskQueryCsv(filtered), count: filtered.length }, executionTime };
          } else if (format === 'markdown') {
            return { apiVersion: 1, success: true, data: { tasks: serializeTaskQueryMarkdown(filtered), count: filtered.length }, executionTime };
          } else {
            return { apiVersion: 1, success: true, data: { tasks: filtered, count: filtered.length }, executionTime };
          }
        } catch (error) {
          return Promise.resolve({ apiVersion: 1, success: false, error: String(error), executionTime: Date.now() - startTime });
        }
      },
      onTaskCacheUpdated: (handler: (tasks: ParsedTask[]) => void) => {
        this.cacheUpdateHandlers.push(handler);
        return () => { this.cacheUpdateHandlers = this.cacheUpdateHandlers.filter((h) => h !== handler); };
      },
      isTaskIndexReady: () => this.getTaskIndex().isReady(),
      whenTaskIndexReady: () => this.getTaskIndex().whenReady(),
      getTaskIndexRevision: () => this.getTaskIndex().getSnapshot().revision,
      onTaskIndexChanged: (handler: (tasks: ParsedTask[], revision: number) => void) => this.getTaskIndex().subscribe((change) => {
        handler([...change.snapshot.tasks], change.revision);
      }),
    };
  }

  private registerMobileUriHandlers(): void {
    const handler = new MobileURIHandler(this.app, async (capturedText) => {
      await this.appendQuickCaptureTask(this.normalizeMobileCaptureTaskLine(capturedText));
    }, undefined, undefined, () => this.settings.externalUriActionsEnabled, true, () => this.settings.externalUriActionSecret);

    for (const action of ['quick-capture', 'add-task', 'schedule-task', 'focus-note'] as const) {
      this.registerObsidianProtocolHandler(action, (params) => {
        const uri = this.protocolParamsToTaskUri(action, params);
        void handler.handleCaptureURI(uri);
      });
    }
  }

  private protocolParamsToTaskUri(action: string, params: Record<string, string>): string {
    const searchParams = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (key === 'action') continue;
      searchParams.set(key, String(value));
    }
    const query = searchParams.toString();
    return query ? `obsidian://${action}?${query}` : `obsidian://${action}`;
  }

  private normalizeMobileCaptureTaskLine(capturedText: string): string {
    const text = capturedText.trim();
    if (/^(?:[-*+]|\d+[.)])\s+\[[^\]]+\]/u.test(text)) return text;
    const [title, ...notes] = text.split(/\r?\n/u);
    const noteBlock = notes.map((line) => line.trim()).filter(Boolean).map((line) => `\n  ${line}`).join('');
    return `- [ ] ${title.trim()}${noteBlock}`;
  }

  private openQueryEditorAtCursor(editor: import('obsidian').Editor): void {
    const block = this.findTaskQueryBlockAtCursor(editor);
    const initialQuery = block?.query ?? sampleTaskManagerQuery();
    const modal = new QueryEditorModal(this.app, initialQuery);
    modal.setOnSave((query) => {
      if (!block) {
        editor.replaceRange(formatTaskManagerQueryBlock(query), editor.getCursor());
        return;
      }
      const replacement = [`\`\`\`${block.fenceName}`, query.trimEnd(), '```'].join('\n');
      editor.replaceRange(
        replacement,
        { line: block.startLine, ch: 0 },
        { line: block.endLine, ch: editor.getLine(block.endLine).length },
      );
    });
    modal.open();
  }

  private findTaskQueryBlockAtCursor(editor: import('obsidian').Editor): { startLine: number; endLine: number; fenceName: string; query: string } | null {
    const cursorLine = editor.getCursor().line;
    const preferredName = this.settings.queryCodeBlockName.trim() || 'task-list';
    const acceptedNames = new Set([preferredName, 'task-list', 'tasks']);
    let startLine = -1;
    let fenceName = '';
    for (let line = cursorLine; line >= 0; line -= 1) {
      const match = editor.getLine(line).match(/^```\s*([^\s`]*)\s*$/u);
      if (!match) continue;
      if (!acceptedNames.has(match[1])) return null;
      startLine = line;
      fenceName = match[1] || preferredName;
      break;
    }
    if (startLine < 0) return null;
    const lineCount = typeof editor.lineCount === 'function' ? editor.lineCount() : cursorLine + 1;
    for (let line = startLine + 1; line < lineCount; line += 1) {
      if (/^```\s*$/u.test(editor.getLine(line))) {
        const queryLines: string[] = [];
        for (let queryLine = startLine + 1; queryLine < line; queryLine += 1) queryLines.push(editor.getLine(queryLine));
        return { startLine, endLine: line, fenceName, query: queryLines.join('\n') };
      }
    }
    return null;
  }

  /** Public accessor used by internal modal classes that need the scanner. */
  get publicScanner(): TaskScanner { return this.scanner; }

  /** Public accessor used by internal modal classes that need the daily-note resolver. */
  get publicDailyNoteResolver(): DailyNoteResolver { return this.dailyNoteResolver; }

  async openTaskPanel(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_TASK_PANEL);
    if (existing.length > 0) {
      await this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (!leaf) return;
    await leaf.setViewState({ type: VIEW_TYPE_TASK_PANEL, active: true });
    await this.app.workspace.revealLeaf(leaf);
  }

  openGettingStarted(): void {
    if (this.activeOnboarding) return;
    const modal = new OnboardingModal(this.app, {
      createFirstTask: () => { this.openQuickCaptureModal(); },
      openTaskPanel: () => this.openTaskPanel(),
      insertOrCopyQuery: () => this.insertOrCopyOnboardingQuery(),
      persistSeen: async () => {
        this.settings.onboardingVersionSeen = Math.max(this.settings.onboardingVersionSeen, ONBOARDING_VERSION);
        await this.saveSettings();
      },
    }, () => {
      if (this.activeOnboarding === modal) this.activeOnboarding = null;
    });
    this.activeOnboarding = modal;
    modal.open();
  }

  private maybeOpenOnboarding(): void {
    if (!this.lifecycleActive || !shouldAutoOpenOnboarding(
      this.onboardingProfileWasUnseen,
      this.settings.onboardingVersionSeen,
      this.onboardingAutoOpenAttempted,
    )) return;
    this.onboardingAutoOpenAttempted = true;
    this.openGettingStarted();
  }

  private async insertOrCopyOnboardingQuery(): Promise<OnboardingActionResult> {
    const editor = this.app.workspace.activeEditor?.editor;
    if (editor) {
      editor.replaceSelection(`${ONBOARDING_QUERY_SNIPPET}\n`);
      return 'inserted';
    }
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (!clipboard?.writeText) return 'copy-failed';
    try {
      await clipboard.writeText(ONBOARDING_QUERY_SNIPPET);
      return 'copied';
    } catch {
      return 'copy-failed';
    }
  }

  private registerCommands(): void {
    this.registerCoreTaskCommands();
    this.registerExportCommands();
    this.registerSyncCommands();
    this.registerWorkspaceCommands();
    this.registerAdvancedCommands();
  }

  private registerCoreTaskCommands(): void {
    registerCoreTaskCommandSet(commandHost(this));
  }

  private registerExportCommands(): void {
    registerExportCommandSet(commandHost(this));
  }

  private registerSyncCommands(): void {
    registerSyncCommandSet(commandHost(this));
  }

  private registerWorkspaceCommands(): void {
    registerWorkspaceCommandSet(commandHost(this));
  }

  private registerAdvancedCommands(): void {
    registerAdvancedCommandSet(commandHost(this));
  }



  // ── Cross-plugin/task-planning feature surfaces ───────────────────────────────────────

  private async generateTaskCommandCenter(): Promise<void> {
    const tasks = this.apiV1.getAllTasks();
    const today = todayDateString();
    const open = tasks.filter((task) => task.status !== 'done' && task.status !== 'cancelled');
    const overdue = open.filter((task) => {
      const due = task.metadata.dates.due;
      return typeof due === 'string' && due < today;
    });
    const dueToday = open.filter((task) => task.metadata.dates.due === today || task.metadata.dates.scheduled === today);
    const unscheduled = open.filter((task) => !task.metadata.dates.due && !task.metadata.dates.scheduled && !task.metadata.dates.start);
    const projects = new Map<string, ParsedTask[]>();
    for (const task of open) {
      const project = this.projectNameForTask(task);
      const bucket = projects.get(project) ?? [];
      bucket.push(task);
      projects.set(project, bucket);
    }
    const projectRows = Array.from(projects.entries())
      .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))
      .map(([project, items]) => `| ${project} | ${items.length} | ${items.filter((task) => task.metadata.dates.due && task.metadata.dates.due < today).length} |`)
      .join('\n');
    const content = [
      '# Task Manager Command Center',
      '',
      `Generated: ${new Date().toISOString()}`,
      '',
      '## Snapshot',
      '',
      `- Open: **${open.length}**`,
      `- Due today / scheduled today: **${dueToday.length}**`,
      `- Overdue: **${overdue.length}**`,
      `- Unscheduled: **${unscheduled.length}**`,
      '',
      '## Agenda',
      '',
      '```task-list',
      'not done',
      'happens before tomorrow',
      'sort by smart',
      'show toolbar',
      '```',
      '',
      '## Today / Week / Month boards',
      '',
      '### Today',
      '```task-list',
      'not done',
      'happens today',
      'sort by smart',
      '```',
      '',
      '### This week',
      '```task-list',
      'not done',
      'happens this week',
      'sort by happens',
      '```',
      '',
      '### This month',
      '```task-list',
      'not done',
      'happens this month',
      'sort by happens',
      '```',
      '',
      '### Unscheduled',
      '```task-list',
      'not done',
      'no due date',
      'no scheduled date',
      'no start date',
      'sort by priority',
      '```',
      '',
      '## Project rollups',
      '',
      '| Project | Open | Overdue |',
      '| --- | ---: | ---: |',
      projectRows || '| Inbox | 0 | 0 |',
      '',
      '## Visual surfaces',
      '',
      '### Kanban',
      '```task-list',
      'not done',
      'view: kanban',
      '```',
      '',
      '### Calendar',
      '```task-list',
      'not done',
      'happens this month',
      'view: calendar',
      'show future occurrences 3',
      '```',
      '',
      '### Gantt / timeline',
      '```task-list',
      'not done',
      'view: gantt',
      'show future occurrences 3',
      '```',
      '',
      '### Eisenhower matrix',
      '```task-list',
      'not done',
      'view: eisenhower',
      '```',
      '',
      '## Maintenance',
      '',
      '- Run **Generate task health and repair report** for duplicate IDs, missing dependencies, invalid recurrence rules, and migration suggestions.',
      '- Run **Generate Obsidian Bases task views** to materialize `.base` view files.',
      '',
    ].join('\n');
    await this.writeVaultFile('Task Command Center.md', content);
    new Notice('Task Manager: generated Task Command Center.md');
  }

  private async generateTaskHealthReport(): Promise<void> {
    const tasks = this.apiV1.getAllTasks();
    const today = todayDateString();
    const healthState = await this.stateStore.loadState();
    const identityMigrationConflicts = healthState.identityMigration?.conflicts ?? [];
    const pendingMoveJournals = healthState.taskMoveJournals ?? [];
    
    // Collect duplicate IDs
    const byId = new Map<string, ParsedTask[]>();
    for (const task of tasks) {
      if (!task.metadata.id) continue;
      const bucket = byId.get(task.metadata.id) ?? [];
      bucket.push(task);
      byId.set(task.metadata.id, bucket);
    }
    const duplicateIds = Array.from(byId.entries()).filter(([, items]) => items.length > 1);
    
    // Collect missing dependencies
    const knownIds = new Set(byId.keys());
    const missingDeps = tasks.flatMap((task) => 
      task.metadata.dependsOn.filter((id) => !knownIds.has(id)).map((id) => ({ task, id }))
    );
    
    // Find dependency cycles
    const invalidRecurrences = tasks.filter((task) => Boolean(task.metadata.invalidRecurrence));
    const cycles = findDependencyCycles(tasks);
    const reminderSyntax = await this.findReminderPluginSyntax();
    
    // E1: Overdue tasks
    const overdueTasks = tasks.filter((task) => {
      if (!task.metadata.dates.due || task.status === 'done') return false;
      const daysOverdue = Math.floor((new Date(today).getTime() - new Date(task.metadata.dates.due).getTime()) / (1000 * 60 * 60 * 24));
      return daysOverdue > this.settings.overdueTaskThresholdDays;
    });
    
    // E1: Stale tasks (in-progress >N days)
    const staleTasks = tasks.filter((task) => {
      if (task.status !== 'in_progress') return false;
      if (!task.metadata.dates.start) return false;
      const daysSinceStart = Math.floor((new Date(today).getTime() - new Date(task.metadata.dates.start).getTime()) / (1000 * 60 * 60 * 24));
      return daysSinceStart > this.settings.staleTaskThresholdDays;
    });

    // T1-5: Orphaned subtasks – indented tasks whose parent line is not a task
    const orphanedSubtasks: ParsedTask[] = [];
    const tasksByFile = new Map<string, ParsedTask[]>();
    for (const task of tasks) {
      const bucket = tasksByFile.get(task.filePath) ?? [];
      bucket.push(task);
      tasksByFile.set(task.filePath, bucket);
    }
    for (const [, fileTasks] of tasksByFile) {
      const sorted = [...fileTasks].sort((a, b) => a.lineNumber - b.lineNumber);
      for (let i = 0; i < sorted.length; i++) {
        const task = sorted[i];
        if (!task.indentation) continue;              // top-level – skip
        const myDepth = task.indentation.length;
        // Walk backwards to find a potential parent task
        let hasParentTask = false;
        for (let j = i - 1; j >= 0; j--) {
          const candidate = sorted[j];
          if (candidate.indentation.length < myDepth) {
            hasParentTask = true;                    // found a less-indented task
            break;
          }
        }
        if (!hasParentTask) orphanedSubtasks.push(task);
      }
    }
    
    // E1: Estimation accuracy stats
    const estimatedTasks = tasks.filter(t => t.metadata.effort);
    const completedEstimatedTasks = estimatedTasks.filter(t => t.status === 'done' && t.metadata.dates.done);
    const estimationStats = { total: estimatedTasks.length, completed: completedEstimatedTasks.length };
    
    // E1: Priority/Status distribution
    const priorityCounts = new Map<string, number>();
    const statusCounts = new Map<string, number>();
    const nonDoneTasks = tasks.filter(t => t.status !== 'done');
    
    for (const task of nonDoneTasks) {
      const pri = task.metadata.priority || 'normal';
      priorityCounts.set(pri, (priorityCounts.get(pri) ?? 0) + 1);
      statusCounts.set(task.status, (statusCounts.get(task.status) ?? 0) + 1);
    }
    
    // E1: Build Mermaid pie chart
    const priorityChartData = Array.from(priorityCounts.entries()).map(([pri, count]) => `${pri}:${count}`);
    const statusChartData = Array.from(statusCounts.entries()).map(([status, count]) => `${status}:${count}`);
    
    const content = [
      '# Task Health and Repair Report',
      '',
      `Generated: ${new Date().toISOString()}`,
      '',
      '## Summary',
      '',
      `- Duplicate task IDs: ${duplicateIds.length}`,
      `- Unresolved identity-migration conflicts: ${identityMigrationConflicts.length}`,
      `- Pending task move journals: ${pendingMoveJournals.length}`,
      `- Missing dependency references: ${missingDeps.length}`,
      `- Dependency cycles: ${cycles.length}`,
      `- Invalid recurrence rules: ${invalidRecurrences.length}`,
      `- Orphaned subtasks: ${orphanedSubtasks.length}`,
      `- Reminder-plugin syntax lines: ${reminderSyntax.length}`,
      `- Overdue tasks: ${overdueTasks.length}`,
      `- Stale tasks (in-progress >${this.settings.staleTaskThresholdDays} days): ${staleTasks.length}`,
      `- Tasks with effort estimate: ${estimatedTasks.length}`,
      '',
      '## Duplicate IDs',
      '',
      ...duplicateIds.flatMap(([id, items]) => [`### \`${id}\``, '', ...items.map((task) => `- [[${task.filePath.replace(/\.md$/u, '')}#L${task.lineNumber}]] ${task.normalizedText}`), '']),
      duplicateIds.length === 0 ? 'No duplicates found.' : '',
      '',
      '## Identity migration conflicts',
      '',
      ...identityMigrationConflicts.map((conflict) => `- \`${conflict.id}\` in \`${conflict.slice}\`: ${conflict.reason}; retained aliases: ${conflict.aliases.map((alias) => `\`${alias}\``).join(', ')}`),
      identityMigrationConflicts.length === 0 ? 'No unresolved identity migration conflicts.' : '',
      '',
      '## Pending task move journals',
      '',
      ...pendingMoveJournals.map((journal) => `- \`${journal.operationId}\` (${journal.phase}): \`${journal.sourcePath}\` → \`${journal.targetPath}\`${journal.diagnostic ? ` — ${journal.diagnostic}` : ''}`),
      pendingMoveJournals.length === 0 ? 'No pending task move journals.' : '',
      '',
      '## Missing dependencies',
      '',
      ...missingDeps.map(({ task, id }) => `- Missing \`${id}\` referenced by [[${task.filePath.replace(/\.md$/u, '')}#L${task.lineNumber}]] ${task.normalizedText}`),
      missingDeps.length === 0 ? 'No missing dependencies found.' : '',
      '',
      '## Dependency cycles / critical path blockers',
      '',
      ...cycles.map((cycle) => `- ${cycle.join(' → ')}`),
      cycles.length === 0 ? 'No cycles found.' : '',
      '',
      '## Invalid recurrence rules',
      '',
      ...invalidRecurrences.map((task) => `- [[${task.filePath.replace(/\.md$/u, '')}#L${task.lineNumber}]] ${task.metadata.recurrence ?? task.normalizedText}`),
      invalidRecurrences.length === 0 ? 'No invalid recurrence rules found.' : '',
      '',
      '## Reminder syntax migration candidates',
      '',
      ...reminderSyntax.map((hit) => `- [[${hit.path.replace(/\.md$/u, '')}#L${hit.line}]] ${hit.text}`),
      reminderSyntax.length === 0 ? 'No Reminder-plugin syntax candidates found.' : '',
      '',
      '## Overdue Tasks',
      '',
      ...overdueTasks.map((task) => `- [[${task.filePath.replace(/\.md$/u, '')}#L${task.lineNumber}]] ${task.normalizedText} (due: ${task.metadata.dates.due})`),
      overdueTasks.length === 0 ? 'No overdue tasks found.' : '',
      '',
      `## Stale Tasks (In Progress >${this.settings.staleTaskThresholdDays} Days)`,
      '',
      ...staleTasks.map((task) => `- [[${task.filePath.replace(/\.md$/u, '')}#L${task.lineNumber}]] ${task.normalizedText} (started: ${task.metadata.dates.start})`),
      staleTasks.length === 0 ? 'No stale tasks found.' : '',
      '',
      '## Orphaned Subtasks',
      '',
      '> Indented tasks whose parent line is not a task. These may be accidentally indented or belong to a deleted parent.',
      '',
      ...orphanedSubtasks.map((task) => `- [[${task.filePath.replace(/\.md$/u, '')}#L${task.lineNumber}]] ${task.normalizedText} (indent: \'${task.indentation}\')`),
      orphanedSubtasks.length === 0 ? 'No orphaned subtasks found.' : '',
      '',
      '## Priority Distribution (Non-Done Tasks)',
      '',
      priorityChartData.length > 0 ? [
        '```mermaid',
        'pie title Priority Distribution',
        ...priorityChartData,
        '```',
      ] : ['No priority data available.'],
      '',
      '## Status Distribution (Non-Done Tasks)',
      '',
      statusChartData.length > 0 ? [
        '```mermaid',
        'pie title Status Distribution',
        ...statusChartData,
        '```',
      ] : ['No status data available.'],
      '',
      '## Estimation Accuracy',
      '',
      `- Tasks with effort estimate: ${estimationStats.total}`,
      `- Completed with estimate: ${estimationStats.completed}`,
      estimationStats.total === 0 ? 'No estimation data available.' : '',
      '',
      '## Suggested Actions',
      '',
      duplicateIds.length > 0 ? '- **Fix duplicate task IDs**: Review and consolidate duplicate IDs to ensure uniqueness.' : '',
      identityMigrationConflicts.length > 0 ? '- **Resolve identity migration conflicts**: Rename duplicate IDs or reconcile retained legacy aliases before relying on recurrence/sync history.' : '',
      missingDeps.length > 0 ? '- **Fix missing dependencies**: Create missing task IDs or update references.' : '',
      cycles.length > 0 ? '- **Resolve dependency cycles**: Break circular dependencies to unblock tasks.' : '',
      invalidRecurrences.length > 0 ? '- **Fix invalid recurrence rules**: Review and correct invalid recurrence patterns.' : '',
      overdueTasks.length > 0 ? '- **Handle overdue tasks**: Reschedule, complete, or delete overdue tasks.' : '',
      staleTasks.length > 0 ? `- **Review stale tasks**: Tasks in progress for >${this.settings.staleTaskThresholdDays} days may need attention or status update.` : '',
      orphanedSubtasks.length > 0 ? '- **Review orphaned subtasks**: Check if these tasks were accidentally indented or belong to a parent that no longer exists.' : '',
      '',
      '## Suggested one-click commands',
      '',
      '- **Convert Reminder plugin syntax in current file** converts `(@YYYY-MM-DD HH:mm)` to Task Manager `⏰` syntax.',
      '- **Import tasks from Canvas cards** extracts checklist items from `.canvas` text nodes into the quick-capture inbox.',
      '- **Archive completed tasks in current file** moves completed rows to the configured archive note.',
      '',
    ].flat().join('\n');
    
    await this.writeVaultFile('Task Health Report.md', content);
    new Notice('Task Manager: generated Task Health Report.md');
  }

  private async generateBasesTaskViews(): Promise<void> {
    if (!this.settings.enableBasesIntegration) {
      new Notice('Task Manager: enable Obsidian Bases integration before generating Bases views.');
      return;
    }
    const views = generateBasesViewFiles();
    await this.exportBasesIndex();
    new Notice(`Task Manager: generated ${views.length} Bases view files in ${BASES_EXPORT_DIR}.`);
  }

  private async importCanvasTasks(): Promise<void> {
    const files = this.app.vault.getFiles().filter((file) => file.extension === 'canvas');
    const imported: string[] = [];
    for (const file of files) {
      try {
        const data = JSON.parse(await this.app.vault.read(file)) as { nodes?: Array<{ text?: string }> };
        for (const node of data.nodes ?? []) {
          for (const line of (node.text ?? '').split(/\r?\n/u)) {
            if (/^\s*[-*+]\s+\[[^\]]*\]\s+/u.test(line)) imported.push(`${line.trim()} [[${file.path}]]`);
          }
        }
      } catch (err) {
        console.warn('[task-manager] Failed to import canvas tasks from', file.path, err);
      }
    }
    if (imported.length === 0) { new Notice('Task Manager: no Canvas checklist tasks found.'); return; }
    const target = this.settings.quickCaptureInboxPath?.trim() || 'Task Inbox.md';
    await this.appendVaultFile(target.endsWith('.md') ? target : `${target}.md`, `\n## Canvas imports — ${new Date().toISOString()}\n${imported.join('\n')}\n`);
    new Notice(`Task Manager: imported ${imported.length} Canvas task(s).`);
  }

  private async archiveCompletedTasksInFile(file: TFile): Promise<void> {
    const snapshot = await this.app.vault.read(file);
    const lines = splitContentLines(snapshot);
    const completed: Array<{ sourceLine: number; block: string; identity: string }> = [];
    for (let index = 0; index < lines.length; index += 1) {
      const task = this.scanner.parseTaskLine(lines[index].text, file.path, index + 1);
      if (!task || (task.status !== 'done' && task.status !== 'cancelled')) continue;
      const blockEnd = completedTaskBlockEnd(lines, index, task.indentation.length + task.linePrefix.length);
      const block = lines.slice(index, blockEnd).map((part) => part.text).join('\n');
      completed.push({ sourceLine: index + 1, block, identity: task.key || `bulk:${file.path}:${index + 1}:${this.stateStore.hash(block)}` });
      index = blockEnd - 1;
    }
    if (completed.length === 0) { new Notice('Task Manager: no completed tasks to archive.'); return; }
    const rawArchivePath = this.settings.archiveFilePath || 'Archive.md';
    const archivePath = normalizeVaultRelativePath(rawArchivePath.endsWith('.md') ? rawArchivePath : `${rawArchivePath}.md`, 'Archive file path');
    if (archivePath === normalizeVaultRelativePath(file.path, 'Archive source path')) throw new Error('Archive destination must be different from the source file');
    const heading = `Archived from [[${file.path.replace(/\.md$/u, '')}]] — ${todayDateString()}`;
    const service = this.lifecycleTransfers ?? new TaskLifecycleTransferService(this.app, this.stateStore);
    // Bottom-up preserves every captured source line while each exact block is removed.
    for (const entry of [...completed].reverse()) {
      await service.transfer({
        action: 'archive', sourceFile: file, sourcePath: file.path, sourceLine: entry.sourceLine, sourceIdentity: entry.identity,
        sourceBlock: entry.block, sourceReplacement: '', targetPath: archivePath, targetHeading: heading,
      });
    }
    new Notice(`Task Manager: archived ${completed.length} completed task(s).`);
  }

  private async convertReminderSyntaxInFile(file: TFile): Promise<void> {
    let changed = 0;
    await this.app.vault.process(file, (content) => content.replace(/\(@(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}:\d{2}))?\)/gu, (_match, date: string, time: string | undefined) => {
      changed += 1;
      return `⏰ ${date}${time ? ` ${time}` : ''}`;
    }));
    new Notice(`Task Manager: converted ${changed} reminder marker(s).`);
  }

  private async writeVaultFile(path: string, content: string): Promise<TFile> {
    const normalizedPath = normalizeVaultRelativePath(path, 'Vault file path');
    await this.ensureParentFolder(normalizedPath);
    const existing = this.app.vault.getAbstractFileByPath(normalizedPath);
    if (existing instanceof TFile) { await this.app.vault.modify(existing, content); return existing; }
    return await this.app.vault.create(normalizedPath, content);
  }

  private async writeGeneratedBasesFile(path: string, content: string, isCurrent: () => boolean = () => true): Promise<boolean> {
    const normalizedPath = normalizeVaultRelativePath(path, 'Generated Bases file path');
    await this.ensureParentFolder(normalizedPath);
    if (!isCurrent()) return false;
    const existing = this.app.vault.getAbstractFileByPath(normalizedPath);
    if (existing instanceof TFile) {
      const current = await this.app.vault.read(existing);
      if (!isOwnedGeneratedBasesFile(normalizedPath, current)) {
        console.warn(`Task Manager: refusing to overwrite unmarked Bases file: ${normalizedPath}`);
        return false;
      }
      if (!isCurrent()) return false;
      if (equivalentBasesContent(current, content)) return true;
      let owned = true;
      await this.app.vault.process(existing, (latest) => {
        owned = isCurrent() && isOwnedGeneratedBasesFile(normalizedPath, latest);
        return owned && !equivalentBasesContent(latest, content) ? content : latest;
      });
      return owned;
    }
    await this.app.vault.create(normalizedPath, content);
    return true;
  }

  private async appendVaultFile(path: string, content: string): Promise<void> {
    const normalizedPath = normalizeVaultRelativePath(path, 'Vault file path');
    await this.ensureParentFolder(normalizedPath);
    const existing = this.app.vault.getAbstractFileByPath(normalizedPath);
    if (existing instanceof TFile) await this.app.vault.process(existing, (current) => `${current.trimEnd()}\n${content}`);
    else await this.app.vault.create(normalizedPath, content.trimStart());
  }

  private async ensureParentFolder(path: string): Promise<void> {
    await ensureParentFolders(this.app, normalizeVaultRelativePath(path, 'Vault file path'));
  }

  private projectNameForTask(task: ParsedTask): string {
    const projectTag = task.tags.find((tag) => tag.startsWith('project/'));
    if (projectTag) return `#${projectTag}`;
    const pathParts = task.filePath.split('/');
    return pathParts.length > 1 ? pathParts[0] : 'Inbox';
  }

  private async findReminderPluginSyntax(): Promise<Array<{ path: string; line: number; text: string }>> {
    const hits: Array<{ path: string; line: number; text: string }> = [];
    for (const file of this.getScannableFiles()) {
      const lines = (await this.app.vault.read(file)).split(/\r?\n/u);
      lines.forEach((line, index) => {
        if (/\(@\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?\)/u.test(line)) hits.push({ path: file.path, line: index + 1, text: line.trim() });
      });
    }
    return hits;
  }

  // ── Feature 1: iCal Export ─────────────────────────────────────────────────────────────

  private async exportTasksIcal(): Promise<void> {
    const tasks = (await this.scanVaultTasks()).filter((task) => task.status !== 'cancelled' && !task.metadata.excludeFromSync);
    const exportPath = ensureExportPathExtension('Tasks Export.ics', 'Tasks Export.ics', 'ics');
    await this.app.vault.adapter.write(exportPath, await exportToICS(tasks));
    new Notice(`Task Manager: exported ${tasks.length} tasks to ${exportPath}`);
  }
  // ── Feature 2: Promote Task to Note ────────────────────────────────────────────────────

  private async promoteTaskToNote(
    editor: import('obsidian').Editor,
    view: import('obsidian').MarkdownView | import('obsidian').MarkdownFileInfo,
  ): Promise<void> {
    const cursor = editor.getCursor();
    const rawLine = editor.getLine(cursor.line);
    const sourcePath = (view as { file?: { path?: string; basename?: string } }).file?.path ?? '';
    const sourceBasename = (view as { file?: { basename?: string } }).file?.basename ?? sourcePath;

    // Parse the task line
    const taskMatch = rawLine.match(/^(?:\s*>\s*)*\s*(?:[-*+]|\d+[.)])\s+\[[^\]]+\]\s+(.+)$/u);
    if (!taskMatch) {
      new Notice('Task Manager: cursor is not on a task line.');
      return;
    }
    // Strip metadata to get clean description
    const parsed = parseEditableTaskLine(rawLine);
    const parsedTask = parseMarkdownTaskLine(rawLine, sourcePath, cursor.line + 1, this.settings.supportedStates);
    const desc = parsed.description || taskMatch[1].trim();

    // Sanitize for filename
    const safeName = desc
      .replace(/[\/\\:*?"<>|]/g, '-')
      .replace(/\s+/g, ' ')
      .slice(0, 80)
      .trim() || 'Task Note';

    // Resolve target folder
    const folderPath = (this.settings.taskNoteFolder || 'Tasks/').replace(/\/+$/u, '');
    const folderExists = this.app.vault.getAbstractFileByPath(folderPath);
    if (!folderExists) {
      try { await this.app.vault.createFolder(folderPath); } catch { /* already exists race */ }
    }

    // Handle collisions
    let notePath = `${folderPath}/${safeName}.md`;
    let suffix = 2;
    while (this.app.vault.getAbstractFileByPath(notePath)) {
      notePath = `${folderPath}/${safeName} ${suffix}.md`;
      suffix += 1;
    }
    const noteBasename = notePath.replace(/\.md$/u, '').split('/').pop() ?? safeName;

    // Create the note with recognizable task-note frontmatter from the source task metadata.
    const taskForFrontmatter = parsedTask ?? this.scanner.parseTaskLine(rawLine, sourcePath, cursor.line + 1);
    const metadataTask = taskForFrontmatter
      ? {
          ...taskForFrontmatter,
          metadata: {
            ...taskForFrontmatter.metadata,
            id: taskForFrontmatter.metadata.id || `task-${Date.now().toString(36)}`,
          },
          normalizedText: desc,
        }
      : null;
    const frontmatter = metadataTask
      ? buildTaskNoteFrontmatter(metadataTask, this.settings.taskNoteMarker || 'task: true', sourcePath, undefined, this.settings.customFieldDefinitions)
      : { task: true, status: 'todo', priority: parsed.priority || 'normal', description: desc, sourceFile: sourcePath, id: parsed.id || `task-${Date.now().toString(36)}` };
    const noteContent = `${serializeTaskNoteFrontmatter(frontmatter)}# ${desc}\n\nSource: [[${sourceBasename}]]\n\n`;
    const newFile = await this.app.vault.create(notePath, noteContent);

    // Append wikilink to the task line in the source
    const updatedLine = `${rawLine.trimEnd()} [[${noteBasename}]]`;
    editor.setLine(cursor.line, updatedLine);

    // Open the new note
    await this.app.workspace.getLeaf().openFile(newFile);
    new Notice(`Task Manager: promoted to [[${noteBasename}]]`);
  }

  // Convert file-backed task to inline task
  private async convertFileTaskToInline(): Promise<void> {
    const currentFile = this.app.workspace.getActiveFile();
    if (!currentFile) {
      new Notice('Task Manager: no active file.');
      return;
    }

    // Check if this is a task-note file
    if (!isTaskNoteFile(currentFile, this.app, this.settings.taskNoteFolders, this.settings.taskNoteMarker)) {
      new Notice('Task Manager: this file is not a task-note.');
      return;
    }

    // Parse the file-backed task
    const fileTask = scanFileAsTask(currentFile, this.app, this.settings.supportedStates, this.settings.customFieldDefinitions);
    if (!fileTask) {
      new Notice('Task Manager: could not parse this file as a task.');
      return;
    }

    // Get the target file path (the file where the inline task should be inserted)
    const frontmatter = this.app.metadataCache.getFileCache(currentFile)?.frontmatter;
    const sourceFileHint = String(frontmatter?.sourceFile ?? frontmatter?.source ?? '');

    let targetFile: TFile | undefined;
    let targetHeading: string | undefined;

    if (sourceFileHint) {
      targetFile = this.app.vault.getAbstractFileByPath(sourceFileHint) as TFile | undefined;
      if (targetFile instanceof TFile) {
        // Optionally, look for a target heading in the source file
        if (frontmatter?.sourceHeading) {
          targetHeading = frontmatter.sourceHeading as string;
        }
      }
    }

    // If no source file is specified, ask the user to select one.
    if (!targetFile) {
      targetFile = await this.chooseInlineTaskTargetFile(currentFile.path) ?? undefined;
      if (!targetFile) {
        new Notice('Task Manager: no target file selected.');
        return;
      }
    }

    // Build the inline task line with metadata
    const checkbox = fileTask.checkbox;
    const body = fileTask.body;
    const metadata = fileTask.metadata;

    // Reconstruct task metadata markers (emojis and such)
    let taskLine = `- [${checkbox}] ${body}`;

    // Add metadata fields in emoji format
    if (metadata.priority && metadata.priority !== 'normal') {
      const prioritySymbol: Record<string, string> = {
        highest: ' 🔺',
        high: ' ⏫',
        medium: ' 🔼',
        low: ' 🔽',
        lowest: ' 🔽',
      };
      taskLine += prioritySymbol[metadata.priority] || '';
    }

    // Add date fields
    if (metadata.dates.due) {
      taskLine += ` 📅 ${metadata.dates.due}`;
      if (metadata.dates.dueTime) taskLine += ` ${metadata.dates.dueTime}`;
    }
    if (metadata.dates.scheduled) {
      taskLine += ` ⏳ ${metadata.dates.scheduled}`;
      if (metadata.dates.scheduledTime) taskLine += ` ${metadata.dates.scheduledTime}`;
    }
    if (metadata.dates.start) {
      taskLine += ` 🛫 ${metadata.dates.start}`;
      if (metadata.dates.startTime) taskLine += ` ${metadata.dates.startTime}`;
    }

    // Add other metadata
    if (metadata.effort) taskLine += ` ⏱️ ${metadata.effort}`;
    if (metadata.actual) taskLine += ` 🕐 ${metadata.actual}`;
    if (metadata.cost !== undefined) taskLine += ` 💵 ${metadata.cost}`;
    if (metadata.assignee) taskLine += ` 👤 @${metadata.assignee}`;
    if (metadata.reviewer) taskLine += ` 👁️ @${metadata.reviewer}`;
    if (metadata.reminder) taskLine += ` ⏰ ${metadata.reminder}`;
    if (metadata.id) taskLine += ` 🆔 ${metadata.id}`;
    if (metadata.recurrence) taskLine += ` ↩️ ${metadata.recurrence}`;

    // Add tags
    if (fileTask.tags.length > 0) {
      taskLine += ' ' + fileTask.tags.map((t) => `#${t}`).join(' ');
    }

    // Add a link back to the file (as a reference)
    taskLine += ` [[${currentFile.basename}]]`;

    // Insert the task into the target file
    if (targetFile instanceof TFile) {
      await this.app.vault.process(targetFile, (fileContent) => {
        if (targetHeading && fileContent.includes(`# ${targetHeading}`)) {
          // Insert after the heading
          const headingIndex = fileContent.indexOf(`# ${targetHeading}`);
          const nextNewline = fileContent.indexOf('\n', headingIndex);
          if (nextNewline >= 0) {
            return fileContent.slice(0, nextNewline + 1) + `${taskLine}\n` + fileContent.slice(nextNewline + 1);
          }
        }
        // Otherwise append at the end
        return fileContent.endsWith('\n') ? `${fileContent}${taskLine}\n` : `${fileContent}\n${taskLine}\n`;
      });
      new Notice(`Task Manager: converted to inline task in ${targetFile.basename}`);
    }
  }

  private chooseInlineTaskTargetFile(excludePath: string): Promise<TFile | null> {
    return new Promise((resolve) => {
      new TaskNoteTargetFileSuggestModal(this.app, excludePath, resolve).open();
    });
  }

  private createProviderRunContext(): ProviderRunContext {
    const generation = this.ensureLifecycleGeneration();
    const controller = this.networkAbortController ??= new AbortController();
    return {
      generation,
      signal: controller.signal,
      isCurrent: () => this.isLifecycleGenerationActive(generation)
        && this.networkAbortController === controller
        && !controller.signal.aborted,
    };
  }

  private runProviderSync(key: ProviderSyncKey, start: (context: ProviderRunContext) => Promise<void>): Promise<void> {
    return (this.providerSyncCoordinator ??= new ProviderSyncCoordinator()).run(key, async () => {
      const context = this.createProviderRunContext();
      assertProviderRunCurrent(context);
      await start(context);
    });
  }
  // ── Feature 5: Todoist Sync ────────────────────────────────────────────────────────────────

  private syncTodoist(): Promise<void> { return this.runProviderSync('todoist', (context) => this.performTodoistSync(context)); }
  private async performTodoistSync(context: ProviderRunContext): Promise<void> {
    assertProviderRunCurrent(context);
    const startedAt = new Date().toISOString();
    if (!this.settings.todoistSyncEnabled || !this.settings.todoistApiKey) {
      new Notice('Task Manager: Todoist sync is not configured. Enable it and add your API key in settings.');
      return;
    }

    let vaultTasks: ParsedTask[];
    try {
      vaultTasks = await this.requireHealthyIndexedTasks('Todoist sync');
      assertProviderRunCurrent(context);
    } catch (error) {
      if (isProviderRunCancellation(error) || !context.isCurrent()) return;
      const details = error instanceof Error ? error.message : String(error);
      this.recordSyncRun({ service: 'Todoist', startedAt, endedAt: new Date().toISOString(), outcome: 'failed', details }, context);
      new Notice(`Task Manager: Todoist sync refused — ${details}`);
      return;
    }

    const state = await this.stateStore.loadState();
    assertProviderRunCurrent(context);
    const mapper = this.settings.todoistDryRun
      ? new IdentityMapper(state.identityState)
      : (this.identityMapper ?? new IdentityMapper(state.identityState));
    if (!this.settings.todoistDryRun) this.identityMapper = mapper;

    const adapter = new TodoistAdapter({
      apiKey: this.settings.todoistApiKey,
      projectId: this.settings.todoistProjectId.trim() || undefined,
      dryRun: this.settings.todoistDryRun,
      signal: context.signal,
      assertCurrent: () => assertProviderRunCurrent(context),
    });
    const queue = this.settings.todoistDryRun
      ? new SyncOperationQueue({ operations: [], completed: [], version: 1 })
      : (this.syncOperationQueue ?? new SyncOperationQueue(state.syncQueueState));
    queue.registerAdapter('todoist', adapter);
    if (!this.settings.todoistDryRun) {
      queue.quarantineUnsafeProviderOperations('todoist');
      this.syncOperationQueue = queue;
    }

    const inboxPath = this.settings.todoistInboxPath.trim() || 'Todoist Inbox.md';
    const inboxFilePath = normalizeVaultRelativePath(inboxPath.endsWith('.md') ? inboxPath : `${inboxPath}.md`, 'Todoist inbox path');
    const todoistIds = new Set<string>();
    for (const task of vaultTasks) {
      const externalId = todoistExternalIdFromTask(task);
      if (!externalId) continue;
      if (todoistIds.has(externalId)) {
        this.recordSyncRun({ service: 'Todoist', startedAt, endedAt: new Date().toISOString(), outcome: 'failed', details: `duplicate vault ID ${externalId}; no sync writes attempted`, conflicts: 1 }, context);
        new Notice(`Task Manager: Todoist ID ${externalId} is duplicated in the vault; no sync writes were attempted.`);
        return;
      }
      todoistIds.add(externalId);
    }
    bootstrapTodoistIdentityMappings(vaultTasks, mapper);

    let imported = 0;
    let fetched = 0;
    let serviceTasks: Awaited<ReturnType<TodoistAdapter['fetchAll']>> = [];
    try {
      serviceTasks = await adapter.fetchAll();
      assertProviderRunCurrent(context);
      fetched = serviceTasks.length;
      const fetchedTodoistIds = new Set<string>();
      for (const remote of serviceTasks) {
        if (fetchedTodoistIds.has(remote.externalId)) throw new Error(`Todoist returned duplicate remote ID ${remote.externalId}; no sync writes or imports were attempted`);
        fetchedTodoistIds.add(remote.externalId);
      }
      if (!this.settings.todoistDryRun) {
        const importPlan = planTodoistImports(serviceTasks, mapper, adapter, inboxFilePath);
        if (importPlan.lines.length > 0) {
          const candidates = importPlan.lines.map((markdown, index): ProviderImportCandidate<(typeof importPlan.mappings)[number]> => {
            const mapping = importPlan.mappings[index];
            if (!mapping) throw new Error('Todoist import plan line/mapping mismatch');
            return { externalId: mapping.externalId, markdown, value: mapping };
          });
          const committed = await commitProviderImports(this.app, inboxFilePath, 'todoist', candidates, context);
          assertProviderRunCurrent(context);
          applyTodoistImportMappings(mapper, committed.map((candidate) => candidate.value));
          imported += committed.length;
        }
      }

      const plan = enqueueTodoistVaultOperations(vaultTasks, mapper, queue, adapter, this.settings.todoistDryRun, serviceTasks);
      if (this.settings.todoistDryRun) {
        const preview = await queue.generateDryRunOutput();
        assertProviderRunCurrent(context);
        new Notice(`Task Manager: Todoist dry run — ${preview.totalOperations} executable operation(s): ${plan.creates} create, ${plan.updates} update; ${plan.conflicts} conflict(s) held.`);
        return;
      }

      this.markSyncStateDirty(true, true);
      await this.persistSyncState(context.isCurrent);
      assertProviderRunCurrent(context);
      const result = await queue.executeAll(2, 'todoist', {
        assertCurrent: () => assertProviderRunCurrent(context),
        beforeOperation: async () => {
          this.markSyncStateDirty(false, true);
          await this.persistSyncState(context.isCurrent);
          assertProviderRunCurrent(context);
        },
      });
      assertProviderRunCurrent(context);
      const verifiedRemotes = result.successful.some((op) => op.type === 'create' || op.type === 'update') ? await adapter.fetchAll() : serviceTasks;
      assertProviderRunCurrent(context);
      const verificationDuplicateIds = duplicateNonEmptyIds(verifiedRemotes.map((remote) => remote.externalId));
      if (verificationDuplicateIds.length > 0) {
        for (const op of result.successful) {
          if (op.type !== 'create' && op.type !== 'update') continue;
          op.status = 'failed';
          op.error = `Todoist post-write verification returned duplicate remote id(s): ${verificationDuplicateIds.join(', ')}. Baselines were not advanced.`;
          if (!result.failed.includes(op)) result.failed.push(op);
        }
      }
      const verifiedById = verificationDuplicateIds.length === 0
        ? new Map(verifiedRemotes.map((remote) => [remote.externalId, remote]))
        : new Map<string, (typeof verifiedRemotes)[number]>();
      for (const op of result.successful) {
        if (op.status !== 'success') continue;
        let mappedKey = op.vaultTask.key;
        if (op.type === 'create' && op.result?.externalId) {
          mapper.mapExternalId(op.vaultTask.key, 'todoist', op.result.externalId);
          const updatedKey = await this.annotateTaskWithTodoistId(op.vaultTask, op.result.externalId, context);
          assertProviderRunCurrent(context);
          if (updatedKey) {
            mapper.mapExternalId(updatedKey, 'todoist', op.result.externalId);
            mappedKey = updatedKey;
          }
        }
        if ((op.type === 'create' || op.type === 'update') && op.status === 'success' && op.result?.externalId) {
          const remote = verifiedById.get(op.result.externalId);
          if (!remote || !projectionsEqual(todoistProjectionFromVaultTask(op.vaultTask), todoistProjectionFromRemotePayload(remote.payload))) {
            op.status = 'failed';
            op.error = 'Todoist post-write verification failed; baseline was not advanced.';
            result.failed.push(op);
            continue;
          }
          mapper.recordBaseline(mappedKey, 'todoist', todoistProjectionFromVaultTask(op.vaultTask), typeof remote.payload.updated_at === 'string' ? remote.payload.updated_at : undefined);
        }
      }
      const successful = result.successful.filter((op) => op.status === 'success');
      queue.removeOperations(successful.map((op) => op.id));
      const retainedConflicts = queue.getState().operations.filter((op) => op.service === 'todoist' && op.status === 'conflict').length;
      const retainedFailures = queue.getState().operations.filter((op) => op.service === 'todoist' && op.status === 'failed').length;
      const endedAt = new Date().toISOString();
      const outcome: SyncRunSummary['outcome'] = retainedFailures === 0 && retainedConflicts === 0 ? 'success' : 'partial';
      this.recordSyncRun({ service: 'Todoist', startedAt: startedAt, endedAt, outcome, details: `fetched=${fetched}, imported=${imported}, pushed=${successful.length}, failed=${retainedFailures}, conflicts=${retainedConflicts}`, imported, conflicts: retainedConflicts, failed: retainedFailures }, context);
      if (retainedFailures === 0 && retainedConflicts === 0) {
        const previous = this.settings.syncLastSuccessTodoist;
        this.settings.syncLastSuccessTodoist = endedAt;
        if (await this.saveSettings(context.isCurrent) === false) { this.settings.syncLastSuccessTodoist = previous; return; }
        assertProviderRunCurrent(context);
      }
      this.markSyncStateDirty(true, true);
      await this.persistSyncState(context.isCurrent);
      assertProviderRunCurrent(context);
      new Notice(`Task Manager: Todoist sync complete — ${fetched} fetched, ${imported} imported, ${successful.length} pushed, ${retainedFailures} failed, ${retainedConflicts} conflicted.`);
    } catch (error) {
      if (isProviderRunCancellation(error) || !context.isCurrent()) return;
      this.recordSyncRun({ service: 'Todoist', startedAt: startedAt, endedAt: new Date().toISOString(), outcome: 'failed', details: String(error) }, context);
      this.markSyncStateDirty(true, true);
      await this.persistSyncState(context.isCurrent);
      assertProviderRunCurrent(context);
      new Notice(`Task Manager: Todoist sync failed — ${String(error)}`);
    }
  }
  private async annotateTaskWithTodoistId(task: ParsedTask, externalId: string, context?: ProviderRunContext): Promise<string | null> {
    assertProviderRunCurrent(context);
    if (task.metadata.id) return null;
    const abstractFile = this.app.vault.getAbstractFileByPath(task.filePath);
    if (!(abstractFile instanceof TFile)) return null;

    let updatedKey: string | null = null;
    await this.app.vault.process(abstractFile, (content) => {
      if (context && !context.isCurrent()) return content;
      const lines = splitContentLines(content);
      const line = lines[task.lineNumber - 1];
      if (!line) return content;
      if (sourceLineIdentity(line.text) !== sourceLineIdentity(task.rawLine)) return content;

      const updatedLine = `${line.text} [id:: todoist:${externalId}]`;
      const updatedTask = parseMarkdownTaskLine(updatedLine, task.filePath, task.lineNumber, undefined, task.heading);
      if (!updatedTask) return content;
      updatedKey = updatedTask.key;
      line.text = updatedLine;
      return lines.map((part) => `${part.text}${part.lineEnding}`).join('');
    });
    assertProviderRunCurrent(context);

    return updatedKey;
  }

  // ── Feature: Google Tasks Sync ───────────────────────────────────────────────────────────

  private refreshGoogleTasksTokenIfNeeded(context?: ProviderRunContext, persist = true): Promise<void> {
    const save = persist ? (predicate: () => boolean) => this.saveSettings(predicate) : (predicate: () => boolean) => Promise.resolve(predicate());
    return refreshGoogleTasksTokenSettings(this.settings, context, save);
  }

  private refreshGoogleCalendarTokenIfNeeded(context?: ProviderRunContext): Promise<void> {
    return refreshGoogleCalendarTokenSettings(this.settings, context, (predicate) => this.saveSettings(predicate));
  }

  private refreshMicrosoftTodoTokenIfNeeded(context?: ProviderRunContext, persist = true): Promise<void> {
    const save = persist ? (predicate: () => boolean) => this.saveSettings(predicate) : (predicate: () => boolean) => Promise.resolve(predicate());
    return refreshMicrosoftTodoTokenSettings(this.settings, context, save);
  }

  private async applyInboundSyncProjection(
    task: ParsedTask,
    projection: SupportedFieldProjection,
    service: 'google-tasks' | 'microsoft-todo',
    context: ProviderRunContext,
  ): Promise<ParsedTask> {
    const source = this.app.vault.getAbstractFileByPath(task.filePath);
    if (!(source instanceof TFile)) throw new Error(`Cannot apply inbound ${service} update: vault file is unavailable`);
    const currentProjection = service === 'google-tasks' ? googleTasksProjectionFromVaultTask(task) : microsoftTodoProjectionFromVaultTask(task);
    if (typeof currentProjection.title !== 'string') throw new Error(`Cannot apply inbound ${service} title: local projection is malformed`);
    const comments = typeof projection.description === 'string' ? (projection.description ? projection.description.split('\n') : []) : undefined;
    return this.taskMutations.updateTaskBlockFromSync(source, task, (line, currentTask) => {
      let updated = line;
      if (typeof projection.title === 'string') updated = rewriteSyncTaskTitle(updated, currentProjection.title as string, projection.title);
      if (Object.prototype.hasOwnProperty.call(projection, 'due')) {
        const due = projection.due;
        const value = service === 'google-tasks'
          ? (typeof due === 'string' ? due : null)
          : due && typeof due === 'object' && !Array.isArray(due)
            && typeof due.date === 'string' && typeof due.time === 'string'
            ? `${due.date}${due.time === '00:00' ? '' : ` ${due.time}`}`
            : null;
        updated = rewriteEditableDateField(updated, 'due', value, currentTask, this.settings.dateFormat === 'wikilink');
        if (service === 'microsoft-todo') {
          const zone = due && typeof due === 'object' && !Array.isArray(due) && typeof due.timeZone === 'string' ? due.timeZone : '';
          updated = rewriteSyncInlineField(updated, 'ms-todo-timezone', zone === 'UTC' ? '' : zone);
        }
      }
      if (service === 'microsoft-todo' && typeof projection.priority === 'string') updated = rewritePriorityField(updated, projection.priority);
      if (typeof projection.status === 'string') {
        const status = service === 'google-tasks'
          ? (projection.status === 'completed' ? 'done' : projection.status === 'needsAction' ? 'todo' : undefined)
          : ({ completed: 'done', inProgress: 'in_progress', deferred: 'deferred', notStarted: 'todo' } as Record<string, TaskStatus>)[projection.status];
        if (!status) throw new Error(`Unsupported inbound ${service} status ${projection.status}; task was held`);
        const lifecycle = rewriteTaskLineForStatusWithLifecycle(updated, checkboxForStatus(status, this.settings.supportedStates), this.settings);
        if (!lifecycle || lifecycle.length !== 1) throw new Error(`Inbound ${service} status requires unsupported multi-line lifecycle effects; task was held`);
        updated = lifecycle[0];
      }
      return updated;
    }, comments, context.isCurrent);
  }

  private syncGoogleTasks(): Promise<void> { return this.runProviderSync('google-tasks', (context) => this.performGoogleTasksSync(context)); }
  private async performGoogleTasksSync(context: ProviderRunContext): Promise<void> {
    assertProviderRunCurrent(context);
    const startedAt = new Date().toISOString();
    const hasGoogleTasksCredentials = Boolean(this.settings.googleTasksAccessToken || this.settings.googleTasksApiKey || this.settings.googleTasksRefreshToken);
    if (!this.settings.googleTasksEnabled && hasGoogleTasksCredentials) {
      new Notice('Task Manager: Google Tasks sync is not enabled.');
      return;
    }
    if (!hasGoogleTasksCredentials) {
      if (!this.settings.googleTasksOAuthClientId.trim()) {
        new Notice('Task Manager: Google Tasks sync is not configured. Add an OAuth client ID or paste an OAuth access or refresh token in settings.');
        return;
      }
      const state = generatePkceVerifier(32);
      const oauth = await googleTasksPkceOAuthStart(this.settings.googleTasksOAuthClientId.trim(), { state });
      assertProviderRunCurrent(context);
      window.open(oauth.authorizationUrl, '_blank', 'noopener');
      new GoogleTasksOAuthModal(this.app, this, { codeVerifier: oauth.codeVerifier, state: oauth.state ?? state }).open();
      new Notice('Task Manager: Opened Google Tasks PKCE login. Complete sign-in, then paste the callback URL in the OAuth modal.');
      return;
    }
    let localTasks: ParsedTask[];
    try {
      localTasks = await this.requireHealthyIndexedTasks('Google Tasks sync');
      assertProviderRunCurrent(context);
    } catch (error) {
      if (isProviderRunCancellation(error) || !context.isCurrent()) return;
      const details = error instanceof Error ? error.message : String(error);
      this.recordSyncRun({ service: 'Google Tasks', startedAt, endedAt: new Date().toISOString(), outcome: 'failed', details }, context);
      new Notice(`Task Manager: Google Tasks sync refused — ${details}`);
      return;
    }
    const listId = this.settings.googleTasksListId.trim() || '@default';
    const inboxPath = this.settings.googleTasksInboxPath.trim() || 'Google Tasks Inbox.md';
    const inboxFilePath = normalizeVaultRelativePath(inboxPath.endsWith('.md') ? inboxPath : `${inboxPath}.md`, 'Google Tasks inbox path');
    const state = await this.stateStore.loadState();
    assertProviderRunCurrent(context);
    const mapper = this.settings.googleTasksDryRun ? new IdentityMapper(state.identityState) : (this.identityMapper ?? new IdentityMapper(state.identityState));
    const queue = this.settings.googleTasksDryRun ? new SyncOperationQueue() : (this.syncOperationQueue ?? new SyncOperationQueue(state.syncQueueState));
    let syncStateTouched = false;
    let stagedCredentials: { accessToken: string; refreshToken: string; expiresAt: string } | null = null;
    const restoreStagedCredentials = (): void => {
      if (!stagedCredentials) return;
      this.settings.googleTasksAccessToken = stagedCredentials.accessToken;
      this.settings.googleTasksRefreshToken = stagedCredentials.refreshToken;
      this.settings.googleTasksTokenExpiresAt = stagedCredentials.expiresAt;
      stagedCredentials = null;
    };
    try {
      if (this.settings.googleTasksDryRun && (!this.settings.googleTasksAccessToken.trim() || tokenExpiresSoon(this.settings.googleTasksTokenExpiresAt))) {
        new Notice('Task Manager: Google Tasks dry run requires a currently valid access token; dry run will not refresh or persist credentials.');
        return;
      }
      if (!this.settings.googleTasksDryRun) {
        const previous = { accessToken: this.settings.googleTasksAccessToken, refreshToken: this.settings.googleTasksRefreshToken, expiresAt: this.settings.googleTasksTokenExpiresAt };
        await this.refreshGoogleTasksTokenIfNeeded(context, false);
        if (previous.accessToken !== this.settings.googleTasksAccessToken || previous.refreshToken !== this.settings.googleTasksRefreshToken || previous.expiresAt !== this.settings.googleTasksTokenExpiresAt) stagedCredentials = previous;
      }
      assertProviderRunCurrent(context);
      const googleConfig = { accessToken: this.settings.googleTasksAccessToken, refreshToken: this.settings.googleTasksRefreshToken, tokenExpiresAt: this.settings.googleTasksTokenExpiresAt, apiKey: this.settings.googleTasksApiKey, listId, dryRun: this.settings.googleTasksDryRun, signal: context.signal, assertCurrent: () => assertProviderRunCurrent(context) };
      const adapter = new GoogleTasksAdapter(googleConfig);
      queue.registerAdapter('google-tasks', adapter);
      const localByGoogleId = new Map<string, ParsedTask>();
      for (const task of localTasks) {
        const id = task.metadata.id?.match(/^(?:google-tasks:|gtasks-)(.+)$/u)?.[1];
        if (!id) continue;
        if (localByGoogleId.has(id)) throw new Error(`Google Tasks ID ${id} is duplicated in the vault; no sync writes were attempted`);
        localByGoogleId.set(id, task);
      }
      const googleTasks = await fetchGoogleTasks(googleConfig);
      assertProviderRunCurrent(context);
      const remoteById = new Map<string, (typeof googleTasks)[number]>();
      for (const remote of googleTasks) {
        if (remoteById.has(remote.id)) throw new Error(`Google Tasks returned duplicate remote ID ${remote.id}; no sync writes were attempted`);
        remoteById.set(remote.id, remote);
      }
      if (stagedCredentials) {
        if (await this.saveSettings(context.isCurrent) === false) { restoreStagedCredentials(); return; }
        stagedCredentials = null;
        assertProviderRunCurrent(context);
      }
      if (!this.settings.googleTasksDryRun) {
        queue.quarantineUnsafeProviderOperations('google-tasks');
        this.identityMapper = mapper;
        this.syncOperationQueue = queue;
        for (const [id, task] of localByGoogleId) mapper.mapExternalId(task.key, 'google-tasks', id);
        syncStateTouched = true;
      }
      const newTasks = googleTasks.filter((remote) => !localByGoogleId.has(remote.id));
      let imported = this.settings.googleTasksDryRun ? newTasks.length : 0;
      let inbound = 0;
      let outbound = 0;
      let failed = 0;

      for (const [id, local] of localByGoogleId) {
        const remote = remoteById.get(id);
        const reconciliation = reconcileGoogleTask(local, remote, mapper.getBaseline(local.key, 'google-tasks'));
        queue.removeReconciliationOperations(local.key, 'google-tasks', id);
        if (reconciliation.mode === 'conflict') {
          queue.enqueueReconciliationConflict(local, 'google-tasks', id, reconciliation.conflicts, reconciliation.evidence);
          continue;
        }
        if (this.settings.googleTasksDryRun) {
          if (Object.keys(reconciliation.inbound).length > 0) inbound += 1;
          if (Object.keys(reconciliation.outbound).length > 0) outbound += 1;
          continue;
        }
        if (Object.keys(reconciliation.outbound).length > 0 && !this.settings.googleTasksAccessToken.trim()) {
          queue.enqueueReconciliationConflict(local, 'google-tasks', id, [{ field: 'credentials', vaultValue: 'OAuth write required', serviceValue: 'read-only credentials', service: 'google-tasks', detectedAt: Date.now() }], { ...reconciliation.evidence, mode: 'conflict' });
          continue;
        }
        let current = local;
        let pendingOutboundId: string | undefined;
        try {
          if (Object.keys(reconciliation.inbound).length > 0) {
            current = await this.applyInboundSyncProjection(current, reconciliation.inbound, 'google-tasks', context);
            assertProviderRunCurrent(context);
            inbound += 1;
          }
          if (reconciliation.nextBaseline && !projectionsEqual(googleTasksProjectionFromVaultTask(current), reconciliation.nextBaseline)) {
            throw new Error(`Google Tasks inbound verification failed for ${id}; baseline was not advanced`);
          }
          let verifiedVersion = reconciliation.evidence.remoteVersion;
          if (Object.keys(reconciliation.outbound).length > 0) {
            const pending = queue.enqueueReconciliationConflict(local, 'google-tasks', id, [{ field: 'interrupted-remote-update', vaultValue: reconciliation.evidence.local, serviceValue: reconciliation.evidence.remote, service: 'google-tasks', detectedAt: Date.now() }], { ...reconciliation.evidence, mode: 'conflict' });
            pending.error = 'Google Tasks update was dispatched; a fresh remote read is required until verification completes.';
            pendingOutboundId = pending.id;
            this.markSyncStateDirty(false, true);
            await this.persistSyncState(context.isCurrent);
            assertProviderRunCurrent(context);
            const payload = googleTasksPayloadFromProjection(reconciliation.outbound);
            const writeResult = await adapter.update(id, payload, false, remote?.etag);
            assertProviderRunCurrent(context);
            if (!writeResult.projection || !reconciliation.nextBaseline || !projectionsEqual(writeResult.projection, reconciliation.nextBaseline)) {
              throw new Error(`Google Tasks post-write verification failed for ${id}; baseline was not advanced`);
            }
            verifiedVersion = writeResult.remoteVersion;
            if (pendingOutboundId) queue.removeOperations([pendingOutboundId]);
            pendingOutboundId = undefined;
            this.markSyncStateDirty(false, true);
            outbound += 1;
          }
          if (reconciliation.nextBaseline) mapper.recordBaseline(current.key, 'google-tasks', reconciliation.nextBaseline, verifiedVersion);
        } catch (error) {
          if (isProviderRunCancellation(error) || !context.isCurrent()) return;
          const held = pendingOutboundId ? queue.getOperation(pendingOutboundId) : queue.enqueueReconciliationConflict(local, 'google-tasks', id, [{ field: 'apply-or-verify', vaultValue: reconciliation.evidence.local, serviceValue: reconciliation.evidence.remote, service: 'google-tasks', detectedAt: Date.now() }], { ...reconciliation.evidence, mode: 'conflict' });
          if (held) held.error = error instanceof Error ? error.message : String(error);
          failed += 1;
        }
      }

      if (newTasks.length > 0 && !this.settings.googleTasksDryRun) {
        const committed = await commitProviderImports(this.app, inboxFilePath, 'google-tasks', newTasks.map((remote) => ({ externalId: remote.id, markdown: googleTaskToMarkdownLine(remote), value: remote })), context);
        assertProviderRunCurrent(context);
        imported = committed.length;
        for (const { value: remote } of committed) {
          const importedTask = adapter.fromServicePayload(remote as unknown as Record<string, unknown>, inboxFilePath);
          const vaultKey = explicitTaskKey(`google-tasks:${remote.id}`);
          const localProjection = googleTasksProjectionFromVaultTask(importedTask);
          const remoteProjection = googleTasksProjectionFromRemoteTask(remote);
          mapper.mapExternalId(vaultKey, 'google-tasks', remote.id);
          if (projectionsEqual(localProjection, remoteProjection)) {
            mapper.recordBaseline(vaultKey, 'google-tasks', localProjection, googleTasksRemoteVersion(remote));
          }
        }
      }

      const conflictLines = queue.getState().operations
        .filter((op) => op.service === 'google-tasks' && op.status === 'conflict')
        .map((op) => `- ${op.vaultTask.filePath}:${op.vaultTask.lineNumber} ↔ Google Tasks ${op.externalId ?? ''}`);
      const retainedConflicts = conflictLines.length;
      const retainedFailures = queue.getState().operations.filter((op) => op.service === 'google-tasks' && op.status === 'failed').length;
      if (!this.settings.googleTasksDryRun) await this.appendSyncConflictReport('Google Tasks', conflictLines, context);
      assertProviderRunCurrent(context);
      const outcome: SyncRunSummary['outcome'] = this.settings.googleTasksDryRun ? 'dry-run' : retainedConflicts > 0 || retainedFailures > 0 || failed > 0 ? 'partial' : 'success';
      const endedAt = new Date().toISOString();
      this.recordSyncRun({ service: 'Google Tasks', startedAt, endedAt, outcome, details: `imported=${imported}, inbound=${inbound}, outbound=${outbound}, conflicts=${retainedConflicts}, failed=${retainedFailures}`, imported, conflicts: retainedConflicts, failed: retainedFailures }, context);
      if (!this.settings.googleTasksDryRun && outcome === 'success') {
        const previous = this.settings.syncLastSuccessGoogleTasks;
        this.settings.syncLastSuccessGoogleTasks = endedAt;
        if (await this.saveSettings(context.isCurrent) === false) { this.settings.syncLastSuccessGoogleTasks = previous; return; }
        assertProviderRunCurrent(context);
      }
      if (!this.settings.googleTasksDryRun) {
        this.markSyncStateDirty(true, true);
        await this.persistSyncState(context.isCurrent);
        assertProviderRunCurrent(context);
      }
      new Notice(`Task Manager: Google Tasks ${this.settings.googleTasksDryRun ? 'dry run' : 'sync'} complete — ${imported} new, ${inbound} inbound, ${outbound} outbound, ${retainedConflicts} conflicted, ${retainedFailures} failed.`);
    } catch (error) {
      restoreStagedCredentials();
      if (isProviderRunCancellation(error) || !context.isCurrent()) return;
      if (!this.settings.googleTasksDryRun && syncStateTouched) {
        this.markSyncStateDirty(true, true);
        await this.persistSyncState(context.isCurrent);
        assertProviderRunCurrent(context);
      }
      this.recordSyncRun({ service: 'Google Tasks', startedAt, endedAt: new Date().toISOString(), outcome: 'failed', details: String(error) }, context);
      new Notice(`Task Manager: Google Tasks sync failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  private syncGoogleCalendar(): Promise<void> { return this.runProviderSync('google-calendar', (context) => this.performGoogleCalendarSync(context)); }
  private async performGoogleCalendarSync(context: ProviderRunContext): Promise<void> {
    assertProviderRunCurrent(context);
    if (!this.settings.googleCalendarEnabled || (!this.settings.googleCalendarAccessToken && !this.settings.googleCalendarRefreshToken)) {
      new Notice('Task Manager: Google Calendar sync is not configured. Enable it and paste an OAuth access or refresh token in settings.');
      return;
    }
    const startedAt = new Date().toISOString();
    try {
      const indexedTasks = await this.requireHealthyIndexedTasks('Google Calendar sync');
      assertProviderRunCurrent(context);
      await this.refreshGoogleCalendarTokenIfNeeded(context);
      assertProviderRunCurrent(context);
      const syncEntries = await this.stateStore.getExternalSyncIds('googleCalendarSyncedIds');
      const pendingMutations = new Set(await this.stateStore.getExternalSyncIds('googleCalendarPendingMutations'));
      assertProviderRunCurrent(context);
      const taskEventIds = parseGoogleCalendarTaskMap(syncEntries);
      const updatedTaskEventIds = new Map<string, string>();
      const syncedIds = googleCalendarSyncedEventIds(syncEntries, taskEventIds);
      const tasks = indexedTasks
        .filter((task) => task.tags.some((tag) => tag.replace(/^#/u, '').toLowerCase() === 'google-calendar'))
        .filter((task) => {
          if (task.status !== 'cancelled') return true;
          return Boolean(googleCalendarEventIdFromTaskId(task.metadata.id) || taskEventIds.get(googleCalendarTaskSyncKey(task)));
        });
      let planned = 0;
      let written = 0;
      for (const task of tasks) {
        if (task.metadata.excludeFromSync) continue;
        const baseEvent = markdownTaskToGoogleCalendarEvent(task, {
          reminderMinutes: this.settings.googleCalendarReminderMinutes,
          useDefaultReminders: this.settings.googleCalendarUseDefaultReminders,
        });
        if (!baseEvent) continue;
        planned += 1;
        const taskSyncKey = googleCalendarTaskSyncKey(task);
        const explicitId = task.metadata.id?.trim();
        if (explicitId && this.getTaskIndex().resolveExplicitId(explicitId).kind !== 'unique') {
          throw new Error(`Google Calendar sync requires a unique task ID; ${explicitId} is missing or duplicated`);
        }
        const existingId = googleCalendarEventIdFromTaskId(task.metadata.id) ?? taskEventIds.get(taskSyncKey);
        if (!existingId && !task.stableKey) {
          throw new Error(`Google Calendar cannot create an event for ${task.filePath}:${task.lineNumber} without a durable unique task ID`);
        }
        if (existingId) baseEvent.id = existingId;
        if (existingId && syncedIds.has(existingId) && this.settings.googleCalendarDryRun) continue;
        const event = await identifyGoogleCalendarEvent(baseEvent, taskSyncKey, !existingId);
        assertProviderRunCurrent(context);
        const pendingEvidence = `${taskSyncKey}\u0000${event.id ?? ''}`;
        const recoveringPendingMutation = pendingMutations.has(pendingEvidence);
        if (!this.settings.googleCalendarDryRun) {
          await this.stateStore.updateExternalSyncIds('googleCalendarPendingMutations', (current) => [...current.filter((entry) => entry !== pendingEvidence), pendingEvidence], context.isCurrent);
          assertProviderRunCurrent(context);
        }
        const result = await upsertGoogleCalendarEvent({
          accessToken: this.settings.googleCalendarAccessToken,
          refreshToken: this.settings.googleCalendarRefreshToken,
          tokenExpiresAt: this.settings.googleCalendarTokenExpiresAt,
          calendarId: this.settings.googleCalendarId,
          dryRun: this.settings.googleCalendarDryRun,
          signal: context.signal,
          assertCurrent: () => assertProviderRunCurrent(context),
        }, event, { preflightCreate: !existingId || recoveringPendingMutation, verifyExisting: recoveringPendingMutation });
        assertProviderRunCurrent(context);
        if (!this.settings.googleCalendarDryRun) {
          await this.stateStore.updateExternalSyncIds('googleCalendarPendingMutations', (current) => current.filter((entry) => entry !== pendingEvidence), context.isCurrent);
          pendingMutations.delete(pendingEvidence);
          assertProviderRunCurrent(context);
        }
        const resultId = result.id ?? event.id;
        if (resultId) {
          syncedIds.add(resultId);
          taskEventIds.set(taskSyncKey, resultId);
          updatedTaskEventIds.set(taskSyncKey, resultId);
          if (!this.settings.googleCalendarDryRun) {
            // Checkpoint each successful create/update before advancing. If a
            // later event fails, retry resumes from this exact remote ID.
            await this.stateStore.updateExternalSyncIds('googleCalendarSyncedIds', (current) => {
              const currentTaskMap = parseGoogleCalendarTaskMap(current);
              currentTaskMap.set(taskSyncKey, resultId);
              const currentIds = googleCalendarSyncedEventIds(current, currentTaskMap);
              currentIds.add(resultId);
              return serializeGoogleCalendarSyncEntries(currentIds, currentTaskMap);
            }, context.isCurrent);
          }
        }
        assertProviderRunCurrent(context);
        written += 1;
      }
      if (!this.settings.googleCalendarDryRun) {
        await this.stateStore.updateExternalSyncIds('googleCalendarSyncedIds', (current) => {
          const currentTaskMap = parseGoogleCalendarTaskMap(current);
          for (const [taskKey, eventId] of updatedTaskEventIds) currentTaskMap.set(taskKey, eventId);
          const currentIds = googleCalendarSyncedEventIds(current, currentTaskMap);
          for (const id of syncedIds) currentIds.add(id);
          return serializeGoogleCalendarSyncEntries(currentIds, currentTaskMap);
        }, context.isCurrent);
        assertProviderRunCurrent(context);
        const previous = this.settings.syncLastSuccessGoogleCalendar;
        this.settings.syncLastSuccessGoogleCalendar = new Date().toISOString();
        if (await this.saveSettings(context.isCurrent) === false) { this.settings.syncLastSuccessGoogleCalendar = previous; return; }
        assertProviderRunCurrent(context);
      }
      this.recordSyncRun({ service: 'Google Calendar', startedAt, endedAt: new Date().toISOString(), outcome: this.settings.googleCalendarDryRun ? 'dry-run' : 'success', details: `planned=${planned}, written=${written}`, imported: written }, context);
      new Notice(this.settings.googleCalendarDryRun
        ? `Task Manager: Google Calendar dry run complete. ${planned} event${planned === 1 ? '' : 's'} would be synced.`
        : `Task Manager: Google Calendar sync complete. ${written} event${written === 1 ? '' : 's'} synced.`);
    } catch (error) {
      if (isProviderRunCancellation(error) || !context.isCurrent()) return;
      this.recordSyncRun({ service: 'Google Calendar', startedAt, endedAt: new Date().toISOString(), outcome: 'failed', details: String(error) }, context);
      new Notice(`Task Manager: Google Calendar sync failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  // ── Feature: Obsidian Bases Export ──────────────────────────────────────────────────────

  private async exportBasesIndex(): Promise<void> {
    if (!this.settings.enableBasesIntegration) {
      new Notice('Task Manager: enable Obsidian Bases integration before exporting Bases files.');
      return;
    }
    const tasks = await this.scanVaultTasks();
    await this.writeBasesExport(tasks, true);
  }

  private scheduleBasesAutoRefresh(tasks: ParsedTask[]): void {
    if (!this.settings?.enableBasesIntegration || !this.settings.basesAutoRefreshEnabled) return;
    this.basesExportQueue?.invalidate();
    if (this.basesRefreshTimer !== null) window.clearTimeout(this.basesRefreshTimer);
    const delay = Math.max(100, Math.min(5000, this.settings.basesRefreshDebounceMs));
    this.basesRefreshTimer = window.setTimeout(() => {
      this.basesRefreshTimer = null;
      void this.writeBasesExport(tasks, false).catch((error) => console.warn('[task-manager] Bases auto-refresh failed:', error));
    }, delay);
  }

  private writeBasesExport(tasks: ParsedTask[], showNotice: boolean): Promise<void> {
    if (this.basesRefreshTimer != null) { window.clearTimeout(this.basesRefreshTimer); this.basesRefreshTimer = null; }
    this.basesExportQueue ??= new LatestWorkQueue();
    return this.basesExportQueue.run((isCurrent) => this.performBasesExport(tasks, showNotice, () => isCurrent() && this.lifecycleActive !== false && this.settings?.enableBasesIntegration !== false));
  }

  private async performBasesExport(tasks: ParsedTask[], showNotice: boolean, isCurrent: () => boolean): Promise<void> {
    if (!isCurrent()) return;
    const files = generateBasesExportFiles(tasks);
    let skipped = 0;
    for (const file of files) {
      if (!isCurrent()) return;
      if (!await this.writeGeneratedBasesFile(file.path, file.content, isCurrent)) skipped += 1;
    }
    if (!isCurrent()) return;
    const expectedPaths = new Set(files.map((file) => file.path));
    let trashed = 0;
    const allFiles = (this.app.vault as unknown as { getFiles?: () => TFile[] }).getFiles?.() ?? [];
    for (const existing of allFiles) {
      if (!existing.path.startsWith(`${BASES_EXPORT_DIR}/`) || expectedPaths.has(existing.path)) continue;
      const content = await this.app.vault.read(existing);
      if (!isCurrent()) return;
      if (!isOwnedGeneratedBasesFile(existing.path, content)) continue;
      await this.app.fileManager.trashFile(existing);
      trashed += 1;
    }
    if (showNotice && isCurrent()) {
      const skippedSuffix = skipped > 0 ? `; skipped ${skipped} unmarked existing file(s)` : '';
      const trashedSuffix = trashed > 0 ? `; moved ${trashed} stale generated file(s) to trash` : '';
      new Notice(`Task Manager: exported ${tasks.length} tasks to ${BASES_EXPORT_DIR}${skippedSuffix}${trashedSuffix}`);
    }
  }

  // ── Feature: Weekly Review ───────────────────────────────────────────────────────────────

  private async startWeeklyReview(): Promise<void> {
    const tasks = await this.scanVaultTasks();
    new WeeklyReviewModal(this.app, this.settings, tasks).open();
  }

  /**
   * Count log entries in daily notes for the last `days` days.
   * Scans vault files named YYYY-MM-DD.md and counts lines under the log section heading.
   */
  private async computeCompletionStats(days: number): Promise<{ total: number; today: number; streak: number }> {
    const heading = this.settings.logSectionHeading;
    const headingLine = `## ${heading}`;
    const today = todayDateString();

    // Build date strings for the last `days` days (including today)
    const dates: string[] = [];
    for (let offset = 0; offset < days; offset += 1) {
      dates.push(addDate(today, 'day', -offset));
    }

    // Build a map of date → file for all markdown files
    const dateFileMap = new Map<string, TFile>();
    for (const file of this.getScannableFiles()) {
      const base = file.basename;
      if (/^\d{4}-\d{2}-\d{2}$/u.test(base)) {
        dateFileMap.set(base, file);
      }
    }

    const countsByDate = new Map<string, number>();
    for (const date of dates) {
      const file = dateFileMap.get(date);
      if (!file) {
        countsByDate.set(date, 0);
        continue;
      }
      try {
        const content = await this.app.vault.cachedRead(file);
        const lines = content.split(/\r?\n/u);
        let inLogSection = false;
        let count = 0;
        for (const line of lines) {
          if (line.trim() === headingLine) {
            inLogSection = true;
            continue;
          }
          // Stop at the next heading of same or higher level
          if (inLogSection && /^##?\s/u.test(line)) {
            break;
          }
          if (inLogSection && line.trim().startsWith('- ')) {
            count += 1;
          }
        }
        countsByDate.set(date, count);
      } catch {
        countsByDate.set(date, 0);
      }
    }

    const total = Array.from(countsByDate.values()).reduce((sum, n) => sum + n, 0);
    const todayCount = countsByDate.get(today) ?? 0;

    // Streak: consecutive days starting from today with at least 1 completion
    let streak = 0;
    for (const date of dates) {
      if ((countsByDate.get(date) ?? 0) > 0) {
        streak += 1;
      } else {
        break;
      }
    }

    return { total, today: todayCount, streak };
  }

  private async showStatusDiagnostics(): Promise<void> {
    const allTasks = await this.scanVaultTasks();

    const unknown = new Map<string, number>();
    for (const task of allTasks) {
      if (task.status === 'untracked') {
        unknown.set(task.checkbox, (unknown.get(task.checkbox) ?? 0) + 1);
      }
    }

    const missingNext = this.settings.supportedStates
      .filter((state) => state.nextStatusSymbol !== undefined && !this.settings.supportedStates.some((s) => s.rawText === state.nextStatusSymbol))
      .map((state) => `| \`[${state.rawText}]\` | \`[${state.nextStatusSymbol}]\` | Missing target status |`);

    const unknownSection = unknown.size > 0
      ? [
          '## Unknown Status Markers', '',
          '| Symbol | Count |', '|--------|-------|',
          ...Array.from(unknown.entries()).sort().map(([marker, count]) => `| \`[${marker}]\` | ${count} |`),
          '',
          '> These markers appear in vault tasks but are not in your configured statuses.',
          '> They will be treated as `todo` by default.',
        ].join('\n')
      : '## Unknown Status Markers\n\nNone - all task markers match configured statuses. ✅';

    const warningsSection = missingNext.length > 0
      ? [
          '## Configuration Warnings', '',
          '| Status | Configured Next | Issue |', '|--------|----------------|-------|',
          ...missingNext,
        ].join('\n')
      : '## Configuration Warnings\n\nNone - all configured next-status symbols resolve. ✅';

    // Invalid date diagnostics
    const invalidDateRows: string[] = [];
    for (const task of allTasks) {
      const invalid = task.metadata.invalidDates ?? {};
      const entries = Object.entries(invalid);
      if (entries.length === 0) continue;
      for (const [field, value] of entries) {
        invalidDateRows.push(`| \`${task.filePath}:${task.lineNumber}\` | ${field} | \`${value}\` |`);
      }
    }
    const invalidDatesSection = invalidDateRows.length > 0
      ? [
          '## Invalid Date Values', '',
          '| Location | Field | Value |', '|----------|-------|-------|',
          ...invalidDateRows,
          '',
          '> Tasks above contain date values that do not parse as `YYYY-MM-DD`.',
        ].join('\n')
      : '## Invalid Date Values\n\nNone - every parsed task date is a valid ISO date. ✅';

    // Invalid recurrence diagnostics
    const invalidRecurrenceRows = allTasks
      .filter((t) => t.metadata.invalidRecurrence === true)
      .map((t) => `| \`${t.filePath}:${t.lineNumber}\` | \`${t.metadata.recurrence ?? ''}\` |`);
    const invalidRecurrenceSection = invalidRecurrenceRows.length > 0
      ? [
          '## Invalid Recurrence Rules', '',
          '| Location | Rule |', '|----------|------|',
          ...invalidRecurrenceRows,
          '',
          '> These recurrence rules could not be parsed and will not generate future occurrences.',
        ].join('\n')
      : '## Invalid Recurrence Rules\n\nNone - every recurrence rule parses cleanly. ✅';

    // Duplicate IDs
    const idIndex = new Map<string, ParsedTask[]>();
    for (const task of allTasks) {
      const id = task.metadata.id;
      if (!id) continue;
      const bucket = idIndex.get(id) ?? [];
      bucket.push(task);
      idIndex.set(id, bucket);
    }
    const duplicateIdRows: string[] = [];
    for (const [id, group] of Array.from(idIndex.entries()).sort()) {
      if (group.length < 2) continue;
      const locs = group.map((t) => `\`${t.filePath}:${t.lineNumber}\``).join(', ');
      duplicateIdRows.push(`| \`${id}\` | ${group.length} | ${locs} |`);
    }
    const duplicateIdsSection = duplicateIdRows.length > 0
      ? [
          '## Duplicate Task IDs', '',
          '| ID | Count | Locations |', '|----|-------|-----------|',
          ...duplicateIdRows,
          '',
          '> Task IDs should be unique vault-wide so dependencies resolve unambiguously.',
        ].join('\n')
      : '## Duplicate Task IDs\n\nNone - every task `🆔` is unique. ✅';

    // Dangling depends-on references
    const knownIds = new Set(idIndex.keys());
    const danglingRows: string[] = [];
    for (const task of allTasks) {
      const deps = task.metadata.dependsOn ?? [];
      const missing = deps.filter((d) => !knownIds.has(d));
      if (missing.length === 0) continue;
      danglingRows.push(`| \`${task.filePath}:${task.lineNumber}\` | ${missing.map((m) => `\`${m}\``).join(', ')} |`);
    }
    const danglingSection = danglingRows.length > 0
      ? [
          '## Unresolved Dependencies', '',
          '| Location | Missing IDs |', '|----------|-------------|',
          ...danglingRows,
          '',
          '> These tasks `⛔ depend on` IDs that do not exist anywhere in the vault.',
        ].join('\n')
      : '## Unresolved Dependencies\n\nNone - every dependency ID resolves. ✅';

    // Mermaid status transition diagram (parity with upstream's "Review and check your Statuses" report).
    const mermaidSection = this.buildStatusMermaidDiagram();

    // Status preview lines so users can preview rendering of each configured status.
    const previewLines = this.settings.supportedStates.map(
      (s) => `- [${s.rawText}] #status-preview ${s.name} (type: ${s.type})`,
    );
    const previewSection = [
      '## Status Preview',
      '',
      'Paste these into a note to verify how each configured status renders. They are tagged with `#status-preview`.',
      '',
      ...previewLines,
    ].join('\n');

    const lines: string[] = [
      '# Task Status Diagnostics',
      '',
      `Generated: ${new Date().toLocaleString()}`,
      '',
      '## Configured Statuses',
      '',
      '| Symbol | Name | Type | Next |',
      '|--------|------|------|------|',
      ...this.settings.supportedStates.map((s) =>
        `| \`[${s.rawText}]\` | ${s.name} | ${s.type} | ${s.nextStatusSymbol ? `\`[${s.nextStatusSymbol}]\`` : '-'} |`
      ),
      '',
      '## Status Transitions',
      '',
      mermaidSection,
      '',
      previewSection,
      '',
      unknownSection,
      '',
      warningsSection,
      '',
      invalidDatesSection,
      '',
      invalidRecurrenceSection,
      '',
      duplicateIdsSection,
      '',
      danglingSection,
    ];

    const reportPath = 'Task Status Diagnostics.md';
    const reportContent = lines.join('\n');
    const existing = this.app.vault.getAbstractFileByPath(reportPath);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, reportContent);
    } else {
      await this.app.vault.create(reportPath, reportContent);
    }
    const report = this.app.vault.getAbstractFileByPath(reportPath);
    if (report instanceof TFile) {
      await this.app.workspace.getLeaf(false).openFile(report);
    }
    new Notice('Task Manager: diagnostics written to "Task Status Diagnostics.md"');
  }

  private buildStatusMermaidDiagram(): string {
    const states = this.settings.supportedStates;
    if (states.length === 0) {
      return '_No configured statuses to diagram._';
    }
    const escape = (s: string) => s.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const typeClass = (type: string): string => {
      switch (type) {
        case 'todo': return 'TODO';
        case 'done': return 'DONE';
        case 'in_progress': return 'IN_PROGRESS';
        case 'cancelled': return 'CANCELLED';
        case 'blocked': return 'BLOCKED';
        case 'deferred': return 'DEFERRED';
        case 'untracked':
        default: return 'NON_TASK';
      }
    };
    const nodes = states.map((s, i) => {
      const symbol = escape(s.rawText);
      const next = escape(s.nextStatusSymbol ?? '');
      const label = `"'${escape(s.name)}'<br>[${symbol}] -&gt; [${next}]<br>(${s.type})"`;
      return `${i + 1}[${label}]:::${typeClass(s.type)}`;
    });
    const edges: string[] = [];
    states.forEach((s, i) => {
      if (s.nextStatusSymbol === undefined) return;
      const targetIndex = states.findIndex((t) => t.rawText === s.nextStatusSymbol);
      if (targetIndex === -1 || targetIndex === i) return;
      edges.push(`${i + 1} --> ${targetIndex + 1}`);
    });
    return [
      '```mermaid',
      'flowchart LR',
      '',
      'classDef TODO        stroke:#f33,stroke-width:3px;',
      'classDef DONE        stroke:#0c0,stroke-width:3px;',
      'classDef IN_PROGRESS stroke:#fa0,stroke-width:3px;',
      'classDef CANCELLED   stroke:#ddd,stroke-width:3px;',
      'classDef BLOCKED     stroke:#00f,stroke-width:3px;',
      'classDef DEFERRED    stroke:#909,stroke-width:3px;',
      'classDef NON_TASK    stroke:#99e,stroke-width:3px;',
      '',
      ...nodes,
      ...edges,
      '',
      'linkStyle default stroke:gray',
      '```',
    ].join('\n');
  }

  private async addQueryFileDefaultsProperties(file: TFile): Promise<void> {
    const keys = [
      'TQ_explain', 'TQ_extra_instructions', 'TQ_short_mode', 'TQ_show_backlink', 'TQ_show_cancelled_date',
      'TQ_show_created_date', 'TQ_show_depends_on', 'TQ_show_done_date', 'TQ_show_due_date', 'TQ_show_edit_button',
      'TQ_show_id', 'TQ_show_on_completion', 'TQ_show_postpone_button', 'TQ_show_priority', 'TQ_show_recurrence_rule',
      'TQ_show_scheduled_date', 'TQ_show_start_date', 'TQ_show_tags', 'TQ_show_task_count', 'TQ_show_toolbar',
      'TQ_show_tree', 'TQ_show_urgency', 'TQ_show_reminder_date',
    ];
    const fileManager = this.app.fileManager as unknown as { processFrontMatter?: (file: TFile, fn: (frontmatter: Record<string, unknown>) => void) => Promise<void> };
    if (fileManager.processFrontMatter) {
      await fileManager.processFrontMatter(file, (frontmatter) => {
        for (const key of keys) {
          if (!(key in frontmatter)) frontmatter[key] = null;
        }
      });
    } else {
      await this.app.vault.process(file, (content) => ensureFrontmatterKeys(content, keys));
    }
    new Notice('Task Manager added Query File Defaults properties');
  }

  private finishTaskModalWrite(path: string, onUpdated: () => void): void {
    try {
      this.queryRenderer.invalidateCache(path);
      onUpdated();
    } catch (error) {
      new Notice(`Task Manager: task saved, but the view could not refresh — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private openCreateTaskModalForQuery(
    statusSymbol: string | undefined,
    sourcePath: string,
    onUpdated: () => void,
    dates: { due?: string } = {},
  ): void {
    const targetPath = sourcePath || this.app.workspace.getActiveFile()?.path || this.settings.quickCaptureInboxPath || 'Task Inbox.md';
    const normalizedPath = targetPath.endsWith('.md') ? targetPath : `${targetPath}.md`;
    const targetFile = this.app.vault.getAbstractFileByPath(normalizedPath);
    if (!(targetFile instanceof TFile)) {
      new Notice(`Task Manager: Cannot create task; source file ${normalizedPath} was not found.`);
      return;
    }

    const todoSymbol = this.settings.supportedStates.find((state) => state.type === 'todo')?.rawText ?? ' ';
    new TaskEditModal(this.app, this.settings, '', async (line) => {
      const submitted = rewriteSubmittedTaskLineForModal(line, this.settings);
      if (!submitted) {
        throw new Error('Archive/collect completion requires a saved task. Save the note, then complete it from a query, dashboard, or reading view.');
      }
      const replacement = submitted.filter((entry) => entry.trim().length > 0);
      if (replacement.length === 0) throw new Error('Task formatting produced no writable task line.');
      await this.app.vault.process(targetFile, (content) => {
        const prefix = content.length === 0 || /(?:\r?\n)$/u.test(content) ? '' : '\n';
        return `${content}${prefix}${replacement.join('\n')}\n`;
      });
      this.finishTaskModalWrite(normalizedPath, onUpdated);
    }, undefined, {
      checkbox: statusSymbol ?? todoSymbol,
      due: dates.due,
    }, normalizedPath, () => this.saveSettings()).open();
  }

  private openTaskModalForSourceTask(task: ParsedTask, onUpdated: () => void): void {
    const abstractFile = this.app.vault.getAbstractFileByPath(task.filePath);
    if (!(abstractFile instanceof TFile)) {
      new Notice(`Task Manager: Cannot find source file ${task.filePath}`);
      return;
    }
    new TaskEditModal(this.app, this.settings, task.rawLine, async (line) => {
      const replacement = rewriteSubmittedTaskLineForModal(line, this.settings);
      if (!replacement) {
        throw new Error('Archive/collect completion requires a saved task. Save the note, then complete it from a query, dashboard, or reading view.');
      }
      await this.app.vault.process(abstractFile, (content) => {
        const lines = content.split(/(\r\n|\n|\r)/u);
        const textIndex = (task.lineNumber - 1) * 2;
        if (textIndex < 0 || textIndex >= lines.length) {
          throw new Error(`Line ${task.lineNumber} no longer exists`);
        }
        const currentTask = this.scanner.parseTaskLine(lines[textIndex], task.filePath, task.lineNumber, task.heading);
        if (!currentTask) throw new Error(`Line ${task.lineNumber} is no longer a task`);
        if (currentTask.status !== task.status) throw new Error(`Line ${task.lineNumber} status changed since it was rendered`);
        if (sourceLineIdentity(lines[textIndex]) !== sourceLineIdentity(task.rawLine)) throw new Error(`Line ${task.lineNumber} no longer matches the rendered task`);
        const removeCount = replacement.length === 0 ? Math.min(2, lines.length - textIndex) : 1;
        lines.splice(textIndex, removeCount, ...interleaveLineEndings(replacement, lines[textIndex + 1] || '\n'));
        return lines.join('');
      });
      this.finishTaskModalWrite(task.filePath, onUpdated);
    }, undefined, {}, task.filePath, () => this.saveSettings()).open();
  }

  /**
   * Build a CodeMirror 6 ViewPlugin that handles checkbox clicks in Live Preview mode.
   * This intercepts clicks at the CM6 level using transactions, giving reliable in-editor
   * task toggling without file-read round-trips or race conditions.
   */
  private buildLivePreviewExtension() {
    return createLivePreviewExtension(
      () => this.settings,
      () => this.queryRenderer,
      () => this.app.workspace.getActiveFile(),
      (line, checkbox, filePath, lineNumber) => this.rewriteEditorTaskLineForStatusWithLifecycle(line, checkbox, filePath, lineNumber),
    );
  }

  // ── Feature 4: Query block IntelliSense (CodeMirror 6 autocompletion) ───────────────────────

  private buildQueryBlockCompletion() {
    // All supported query keywords / snippets
    const QUERY_COMPLETIONS = [
      'not done', 'done', 'sequential',
      'is recurring', 'is not recurring',
      'is blocked', 'is blocking', 'is not blocked', 'is not blocking',
      'exclude sub-items', 'shows future occurrences', 'hides future occurrences',
      'path includes ', 'path does not include ', 'path regex matches ',
      'folder includes ', 'folder does not include ',
      'filename includes ', 'filename does not include ',
      'heading includes ', 'heading does not include ',
      'tag includes ', 'tags include ', 'has tags', 'no tags',
      'description includes ', 'description does not include ',
      'priority is highest', 'priority is high', 'priority is medium',
      'priority is normal', 'priority is low', 'priority is lowest',
      'due before today', 'due on today', 'due after today',
      'due before ', 'due on ', 'due after ',
      'scheduled before today', 'scheduled on today', 'scheduled after today',
      'scheduled before ', 'scheduled on ', 'scheduled after ',
      'start before today', 'start on today', 'start after today',
      'happens before today', 'happens on today', 'happens after today',
      'happens this week', 'happens next week', 'happens this month',
      'created before ', 'created on ', 'created after ',
      'done before ', 'done on ', 'done after ',
      'has effort', 'has no effort', 'has actual', 'has no actual',
      'sort by status', 'sort by due', 'sort by priority', 'sort by urgency',
      'sort by smart', 'sort by description', 'sort by filename', 'sort by random',
      'sort by scheduled', 'sort by start', 'sort by created', 'sort by effort',
      'sort by status reverse', 'sort by due reverse', 'sort by priority reverse',
      'group by status', 'group by due', 'group by priority', 'group by folder',
      'group by filename', 'group by heading', 'group by tag', 'group by recurring',
      'limit 10', 'limit 25', 'limit 50', 'limit 100',
      'show tree', 'show toolbar', 'show urgency',
      'hide toolbar', 'hide edit button', 'hide postpone button', 'hide backlinks',
      'hide due date', 'hide scheduled date', 'hide start date', 'hide created date',
      'hide done date', 'hide priority', 'hide tags', 'hide urgency', 'hide task count',
      'view: list', 'view: checklist', 'style: checklist', 'view: kanban', 'view: calendar', 'view: gantt', 'view: stats', 'view: graph', 'view: eisenhower',
      'filter by function ', 'sort by function ', 'group by function ',
      'short mode', 'full mode', 'explain',
      'ignore global query',
      'has follow-up', 'no follow-up',
      'follow-up before today', 'follow-up on today', 'follow-up after today',
      'follow-up before ', 'follow-up on ', 'follow-up after ',
      'sort by follow-up', 'group by follow-up',
      'show follow-up date', 'hide follow-up date',
    ];

    const getBlockName = () => this.settings.queryCodeBlockName || 'task-list';

    const completionSource = (context: CompletionContext): CompletionResult | null => {
      const doc = context.state.doc.toString();
      const pos = context.pos;
      const blockName = getBlockName();
      // Detect all registered block names
      const blockNames = [blockName, 'task-list', 'task-manager'];

      let insideBlock = false;
      for (const name of blockNames) {
        const fence = '```' + name;
        let idx = 0;
        while ((idx = doc.indexOf(fence, idx)) !== -1) {
          const contentStart = idx + fence.length;
          const closingFence = doc.indexOf('\n```', contentStart);
          const blockEnd = closingFence === -1 ? doc.length : closingFence;
          if (pos > contentStart && pos <= blockEnd) {
            insideBlock = true;
            break;
          }
          idx += 1;
        }
        if (insideBlock) break;
      }
      if (!insideBlock) return null;

      const lineInfo = context.state.doc.lineAt(pos);
      const before = lineInfo.text.slice(0, pos - lineInfo.from).trimStart();
      const wordMatch = before.match(/(\S+(?:\s+\S+)*)$/);
      const word = (wordMatch?.[1] ?? '').toLowerCase();
      const from = wordMatch ? pos - wordMatch[1].length : pos;

      const matching = QUERY_COMPLETIONS.filter((c) =>
        !word || c.toLowerCase().startsWith(word) || c.toLowerCase().includes(word),
      );
      if (!matching.length) return null;

      return {
        from,
        options: matching.map((label) => ({ label, type: 'keyword' })),
        validFor: /^[\w\s:]*$/u,
      };
    };

    return autocompletion({ override: [completionSource] });
  }

  private registerNativeTaskCheckboxHandler(): void {
    this.registerDomEvent(document, 'click', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement) || !target.matches('input.task-list-item-checkbox') || target.closest('.task-manager-query')) {
        return;
      }
      // Live Preview/source-mode checkboxes are handled by the CodeMirror extension
      // below so status changes are applied to the editor buffer instead of racing
      // Obsidian's next editor save with a vault.process write.
      if (target.closest('.markdown-source-view')) return;
      const lineNumber = this.lineNumberFromTaskCheckbox(target);
      const view = this.markdownViewForElement(target);
      const file = view?.file ?? this.app.workspace.getActiveFile();
      if (!file || file.extension !== 'md' || lineNumber === null) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      void this.toggleNativeTaskCheckbox(file, lineNumber);
    }, true);

    this.registerDomEvent(document, 'change', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement) || !target.matches('input.task-list-item-checkbox') || target.closest('.task-manager-query')) {
        return;
      }
      if (target.closest('.markdown-source-view')) return;
      const lineNumber = this.lineNumberFromTaskCheckbox(target);
      const view = this.markdownViewForElement(target);
      const file = view?.file ?? this.app.workspace.getActiveFile();
      if (!file || file.extension !== 'md' || lineNumber === null) {
        return;
      }
      // Capture the new checked state synchronously from the DOM event — this eliminates
      // the 150 ms arbitrary delay and makes the intent explicit: only apply lifecycle
      // (dates, recurrence) when the checkbox is being *checked* (marked done/complete).
      const newChecked = target.checked;
      void this.applyLifecycleToNativeCheckboxChange(file, lineNumber, newChecked);
    }, true);

    this.registerDomEvent(document, 'contextmenu', (event) => {
      const target = event.target;
      if (!(target instanceof HTMLInputElement) || !target.matches('input.task-list-item-checkbox') || target.closest('.task-manager-query')) {
        return;
      }
      const lineNumber = this.lineNumberFromTaskCheckbox(target);
      const view = this.markdownViewForElement(target);
      const file = view?.file ?? this.app.workspace.getActiveFile();
      if (!file || file.extension !== 'md' || lineNumber === null) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      this.openNativeStatusMenu(event, file, lineNumber, view ?? undefined);
    }, true);
  }

  private openNativeStatusMenu(event: MouseEvent, file: TFile, lineNumber: number, sourceView?: MarkdownView): void {
    const menu = new Menu();
    for (const state of this.settings.supportedStates) {
      menu.addItem((item) => item
        .setTitle(`${state.name} [- [${state.rawText}] ]`)
        .onClick(() => {
          void this.changeNativeTaskStatus(file, lineNumber, state.rawText, sourceView);
        }));
    }
    menu.showAtMouseEvent(event);
  }

  private async toggleNativeTaskCheckbox(file: TFile, lineNumber: number): Promise<void> {
    try {
      const content = await this.app.vault.read(file);
      const line = content.split(/\r?\n/u)[lineNumber - 1];
      if (!line) return;
      const task = this.scanner.parseTaskLine(line, file.path, lineNumber);
      if (!task) {
        new Notice('Task Manager: line is not a task or does not match global filter');
        return;
      }
      await this.taskMutations.updateTaskCheckbox(file, task, cycleTaskCheckbox(task.checkbox, this.settings.supportedStates));
    } catch (error) {
      new Notice(`Task Manager: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async changeNativeTaskStatus(file: TFile, lineNumber: number, checkbox: string, sourceView?: MarkdownView | null): Promise<void> {
    try {
      const editorView = sourceView?.file?.path === file.path && sourceView.getMode() === 'source'
        ? sourceView
        : this.activeSourceMarkdownViewForFile(file);
      if (editorView) {
        const changed = await this.changeEditorTaskStatus(editorView, file, lineNumber, checkbox);
        if (!changed) new Notice('Task Manager: line is not a task or does not match global filter');
        return;
      }

      const content = await this.app.vault.read(file);
      const line = content.split(/\r?\n/u)[lineNumber - 1];
      if (!line) return;
      const task = this.scanner.parseTaskLine(line, file.path, lineNumber);
      if (!task) {
        new Notice('Task Manager: line is not a task or does not match global filter');
        return;
      }
      await this.taskMutations.updateTaskCheckbox(file, task, checkbox);
    } catch (error) {
      new Notice(`Task Manager: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private activeSourceMarkdownViewForFile(file: TFile): MarkdownView | null {
    const view = this.app.workspace.getActiveViewOfType(MarkdownView);
    if (!view || view.file?.path !== file.path || view.getMode() !== 'source') return null;
    return view;
  }

  private markdownViewForElement(target: HTMLElement): MarkdownView | null {
    const workspace = this.app.workspace as unknown as {
      getLeavesOfType?: (viewType: string) => Array<{ view?: unknown }>;
      getActiveViewOfType?: <T>(type: new (...args: never[]) => T) => T | null;
    };
    const leaves = workspace.getLeavesOfType?.('markdown') ?? [];
    for (const leaf of leaves) {
      const view = leaf.view as (MarkdownView & { containerEl?: HTMLElement }) | undefined;
      if (view?.containerEl?.contains(target) && typeof view.getMode === 'function') return view;
    }
    if (leaves.length > 0) return null;

    const activeView = workspace.getActiveViewOfType?.(MarkdownView) ?? this.app.workspace.getActiveViewOfType(MarkdownView);
    const activeContainer = activeView?.containerEl;
    if (!activeContainer || activeContainer.contains(target)) return activeView;
    return null;
  }

  private async changeEditorTaskStatus(view: MarkdownView, file: TFile, lineNumber: number, checkbox: string): Promise<boolean> {
    const editor = view.editor as unknown as {
      getLine?: (line: number) => string;
      setLine?: (line: number, text: string) => void;
      replaceRange?: (text: string, from: { line: number; ch: number }, to: { line: number; ch: number }) => void;
    };
    if (typeof editor.getLine !== 'function' || typeof editor.setLine !== 'function') return false;

    const lineIndex = lineNumber - 1;
    const currentLine = editor.getLine(lineIndex);
    const parsed = parseEditableTaskLine(currentLine);
    if (!parsed.checkbox) return false;

    const replacement = parsed.recurrence
      ? await this.rewriteEditorTaskLineForStatusWithLifecycle(currentLine, checkbox, file.path, lineNumber)
      : rewriteTaskLineForStatusWithLifecycle(currentLine, checkbox, this.settings);
    if (!replacement) return false;

    replaceEditorLineWithLines(editor as {
      getLine: (line: number) => string;
      setLine: (line: number, text: string) => void;
      replaceRange?: (text: string, from: { line: number; ch: number }, to: { line: number; ch: number }) => void;
    }, lineIndex, replacement);
    this.queryRenderer.invalidateCache(file.path);
    return true;
  }

  private async setInlineTaskDate(file: TFile, task: ParsedTask, field: EditableTaskDateField, date: string | null): Promise<void> {
    try {
      await this.taskMutations.updateTaskDate(file, task, field, date);
    } catch (error) {
      new Notice(`Task Manager: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private openInlineDatePicker(file: TFile, task: ParsedTask, field: EditableTaskDateField): void {
    const currentDate = field === 'reminder'
      ? task.metadata.reminder?.slice(0, 10)
      : field === 'timeStart'
      ? task.metadata.timeStart
      : task.metadata.dates[field];
    new TaskDatePickerModal(this.app, field, currentDate ?? todayDateString(), async (date) => {
      await this.setInlineTaskDate(file, task, field, date);
    }).open();
  }

  private openInlineDateFieldMenu(event: MouseEvent, file: TFile, task: ParsedTask, field: EditableTaskDateField): void {
    const menu = new Menu();
    for (const days of [-7, -3, -1, 1, 2, 3, 7, 14, 30]) {
      const label = days < 0 ? `Move ${Math.abs(days)} ${Math.abs(days) === 1 ? 'day' : 'days'} earlier` : `Postpone ${days === 1 ? '1 day' : `${days} days`}`;
      menu.addItem((item) => item.setTitle(label).onClick(() => {
        void this.adjustInlineTaskDate(file, task, field, days);
      }));
    }
    menu.addSeparator();
    menu.addItem((item) => item.setTitle('Remove date').onClick(() => {
      void this.setInlineTaskDate(file, task, field, null);
    }));
    menu.showAtMouseEvent(event);
  }

  private async adjustInlineTaskDate(file: TFile, task: ParsedTask, field: EditableTaskDateField, days: number): Promise<void> {
    const currentDate = field === 'reminder'
      ? task.metadata.reminder?.slice(0, 10)
      : field === 'timeStart'
      ? task.metadata.timeStart
      : task.metadata.dates[field];
    await this.setInlineTaskDate(file, task, field, addDate(maxDate(currentDate ?? todayDateString(), todayDateString()), 'day', days));
  }

  private async deferInlineTask(file: TFile, task: ParsedTask, days: number | null): Promise<void> {
    const field = this.firstDeferrableField(task);
    if (!field) return;
    if (days === null) {
      await this.setInlineTaskDate(file, task, field, null);
      return;
    }
    await this.adjustInlineTaskDate(file, task, field, days);
  }

  private openInlineDeferMenu(event: MouseEvent, file: TFile, task: ParsedTask): void {
    const menu = new Menu();
    const field = this.firstDeferrableField(task);
    if (!field) return;
    const currentDate = task.metadata.dates[field] ?? todayDateString();
    const today = todayDateString();

    // Fixed-date section: set to today / tomorrow regardless of current value
    menu.addItem((item) => item.setTitle(`Set to today (${today})`).onClick(() => {
      void this.setInlineTaskDate(file, task, field, today);
    }));
    const tomorrow = addDate(today, 'day', 1);
    menu.addItem((item) => item.setTitle(`Set to tomorrow (${tomorrow})`).onClick(() => {
      void this.setInlineTaskDate(file, task, field, tomorrow);
    }));
    menu.addSeparator();

    // User-configurable relative presets (base = max of current date and today)
    const base = maxDate(currentDate, today);
    const presets = this.settings.deferPresets;
    for (const preset of presets) {
      const target = applyDeferPreset(base, preset);
      menu.addItem((item) => item.setTitle(`${preset.label} (${target})`).onClick(() => {
        void this.setInlineTaskDate(file, task, field, target);
      }));
    }

    menu.addSeparator();
    menu.addItem((item) => item.setTitle('Remove date').onClick(() => {
      void this.deferInlineTask(file, task, null);
    }));
    menu.showAtMouseEvent(event);
  }

  private canPostponeTask(task: ParsedTask): boolean {
    if (task.status === 'done' || task.status === 'cancelled' || task.status === 'untracked') return false;
    if (!this.firstDeferrableField(task)) return false;
    return Object.keys(task.metadata.invalidDates).length === 0;
  }

  private firstDeferrableField(task: ParsedTask): 'due' | 'scheduled' | 'start' | null {
    // Postpone preferred field (#10): respect configured priority order for inline mode too.
    const preferred = this.settings.postponePreferredField ?? 'auto';
    if (preferred === 'due' && task.metadata.dates.due) return 'due';
    if (preferred === 'scheduled' && task.metadata.dates.scheduled) return 'scheduled';
    if (preferred === 'start' && task.metadata.dates.start) return 'start';
    if (task.metadata.dates.due) return 'due';
    if (task.metadata.dates.scheduled) return 'scheduled';
    if (task.metadata.dates.start) return 'start';
    return null;
  }

  /**
   * Returns all vault markdown files with excluded folders filtered out (#1).
   * Use this instead of `this.app.vault.getMarkdownFiles()` for user-data scanning.
   */
  private getScannableFiles(): import('obsidian').TFile[] {
    return scannableMarkdownFiles(this.app, this.settings);
  }

  private scanTaskFile(file: TFile): Promise<ParsedTask[]> {
    return scanFileWithTaskNotes(file, this.app, this.scanner, this.settings);
  }

  private async scanVaultTasks(): Promise<ParsedTask[]> {
    // Compatibility for isolated harnesses that instantiate the prototype without
    // running class field initializers. Production always owns a TaskIndex.
    if (!this.taskIndex) {
      const tasks: ParsedTask[] = [];
      for (const file of this.getScannableFiles()) tasks.push(...await this.scanTaskFile(file));
      return tasks;
    }
    await this.getTaskIndex().whenReady();
    return this.getTaskIndex().getAllTasks();
  }

  private async requireHealthyIndexedTasks(operation: string): Promise<ParsedTask[]> {
    // Preserve isolated prototype harness compatibility without weakening the
    // production contract: a loaded plugin always owns TaskIndex.
    if (!this.taskIndex) {
      const legacyApi = (this as unknown as { apiV1?: { getAllTasks?: () => ParsedTask[] } }).apiV1;
      if (typeof legacyApi?.getAllTasks === 'function') return legacyApi.getAllTasks();
      return this.scanVaultTasks();
    }
    try {
      const snapshot = await this.getTaskIndex().requireHealthySnapshot();
      return [...snapshot.tasks];
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`${operation} requires a complete task index: ${detail}`);
    }
  }

  private getIndexableFiles(): TFile[] {
    const excluded = this.settings?.excludedFolders ?? [];
    const vault = this.app.vault as unknown as { getFiles?: () => TFile[]; getMarkdownFiles?: () => TFile[] };
    const files = typeof vault.getFiles === 'function'
      ? vault.getFiles()
      : typeof vault.getMarkdownFiles === 'function'
        ? vault.getMarkdownFiles()
        : this.getScannableFiles();
    return files.filter((file) => isIndexableTaskFile(file, excluded));
  }

  private lineNumberFromTaskCheckbox(target: HTMLInputElement): number | null {
    const lineEl = target.closest('[data-line]');
    const rawLine = lineEl?.getAttr?.('data-line') ?? lineEl?.getAttribute('data-line');
    if (rawLine && /^\d+$/u.test(rawLine)) return Number.parseInt(rawLine, 10) + 1;

    const sourceLine = target.closest('.HyperMD-task-line, .cm-line');
    const sourceRawLine = sourceLine?.getAttr?.('data-line') ?? sourceLine?.getAttribute('data-line');
    if (sourceRawLine && /^\d+$/u.test(sourceRawLine)) return Number.parseInt(sourceRawLine, 10) + 1;
    return null;
  }

  private async applyLifecycleToNativeCheckboxChange(file: TFile, lineNumber: number, newChecked: boolean): Promise<void> {
    // Only apply lifecycle (done-date, recurrence etc.) when the task is being marked complete.
    // Obsidian's native toggle sets checked=true for 'x' and checked=false for ' '.
    if (!newChecked) return;
    try {
      const content = await this.app.vault.read(file);
      const line = content.split(/\r?\n/u)[lineNumber - 1];
      if (!line) return;
      const task = this.scanner.parseTaskLine(line, file.path, lineNumber);
      if (!task || (task.status !== 'done' && task.status !== 'cancelled')) return;
      const result = await this.taskMutations.updateTaskCheckboxWithOutcome(file, task, task.checkbox);
      if (result.outcome !== 'completed') {
        new Notice(`Task Manager: ${result.reason} ${result.recovery}`);
        this.queueRescan(file);
      }
    } catch (error) {
      new Notice(`Task Manager: failed to apply task lifecycle — ${error instanceof Error ? error.message : String(error)}`);
      this.queueRescan(file);
    }
  }

  private startPeriodicScan(): void {
    if (!this.settings.enablePeriodicScan) {
      return;
    }

    const intervalMs = Math.max(1, this.settings.scanIntervalMinutes) * 60_000;
    this.scanTimer = this.registerInterval(window.setInterval(() => {
      // Periodic background scans are silent — only the user-invoked rescan shows a notice.
      void this.scanVault(false);
    }, intervalMs));
  }

  private stopPeriodicScan(): void {
    if (this.scanTimer !== null) {
      window.clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }

  // ── Reminder Notifications ────────────────────────────────────────────────

  private startReminderChecker(): void {
    if (!this.settings.enableReminderNotifications) return;
    const intervalMs = Math.max(1, this.settings.reminderCheckIntervalMinutes) * 60_000;
    this.reminderTimer = this.registerInterval(window.setInterval(() => { void this.checkDueReminders(); }, intervalMs));
  }

  private stopReminderChecker(): void {
    if (this.reminderTimer !== null) {
      window.clearInterval(this.reminderTimer);
      this.reminderTimer = null;
    }
  }

  private initializeStatusBarWidget(): void {
    if (!this.settings.statusBarNowNextEnabled) return;
    this.statusBarItem = this.addStatusBarItem();
    this.statusBarItem.addClass('task-manager-status-bar');
    this.statusBarItem.style.cursor = 'pointer';
    this.statusBarItem.setAttr('role', 'button'); this.statusBarItem.setAttr('tabindex', '0');
    // Register click handler once here; updateStatusBarWidget only updates text.
    this.statusBarItem.onClickEvent(() => {
      void this.openTimelinePanel();
    });
    this.statusBarItem.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void this.openTimelinePanel(); } });
    void this.updateStatusBarWidget();
  }

  private startStatusBarUpdater(): void {
    if (!this.settings.statusBarNowNextEnabled) return;
    this.statusBarUpdateTimer = this.registerInterval(window.setInterval(() => {
      void this.updateStatusBarWidget();
    }, 60_000)); // Update every minute
  }

  private stopStatusBarUpdater(): void {
    if (this.statusBarUpdateTimer !== null) {
      window.clearInterval(this.statusBarUpdateTimer);
      this.statusBarUpdateTimer = null;
    }
    this.statusBarItem = null;
  }

  private updateStatusBarWidget(): void {
    if (!this.statusBarItem || !this.settings.statusBarNowNextEnabled) return;
    const text = formatStatusBarNowNextText(this.getTaskIndex().getInternalTasks());
    this.statusBarItem.setText(text); this.statusBarItem.setAttr('aria-label', `${text}. Open Task Sidebar.`); this.statusBarItem.setAttr('title', `${text}. Open Task Sidebar.`);
  }

  private async openTimelinePanel(): Promise<void> {
    const { workspace } = this.app;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_TASK_PANEL);
    if (leaves.length > 0) {
      void workspace.revealLeaf(leaves[0]);
    } else {
      const leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({ type: VIEW_TYPE_TASK_PANEL, active: true });
        void workspace.revealLeaf(leaf);
      }
    }
  }

  private async fetchAndCacheIcsEvents(): Promise<Array<{ summary: string; date: string | null; startTime?: string; endTime?: string; uid: string | null }>> {
    const events: Array<{ summary: string; date: string | null; startTime?: string; endTime?: string; uid: string | null }> = [];
    
    const state = await this.stateStore.loadState();
    
    for (const url of this.settings.icsOverlayUrls) {
      // Check if cache needs refresh
      if (!this.stateStore.needsIcsCacheRefresh(state, url, this.settings.icsOverlayRefreshMinutes)) {
        const cached = this.stateStore.getIcsCache(state, url);
        if (cached) {
          events.push(...cached.events);
        }
        continue;
      }
      
      // Fetch from URL
      const icsContent = await fetchIcsFromUrl(url);
      if (!icsContent) continue;
      
      const parsedEvents = parseIcsEvents(icsContent);
      await this.stateStore.updateState((current) => this.stateStore.setIcsCache(current, url, parsedEvents));
      events.push(...parsedEvents);
    }
    
    return events;
  }

  private async handleClockInOut(task: ParsedTask, isClockingIn: boolean): Promise<void> {
    if (isClockingIn) {
      await this.stateStore.updateState((state) => this.stateStore.setClockIn(state, task.key, task.filePath, task.lineNumber));
      new Notice(`⏱ Clocked in: ${task.normalizedText}`);
      return;
    }

    let elapsedMinutes = 0;
    const endedAtIso = new Date().toISOString();
    await this.stateStore.updateState((state) => {
      const clockIn = state.clockInState;
      const cleared = this.stateStore.clearClockIn(state);
      elapsedMinutes = cleared.elapsedMinutes;
      if (!clockIn || elapsedMinutes <= 0) return cleared.state;
      const session: TimeSessionRecord = {
        taskKey: task.key,
        taskFilePath: task.filePath,
        taskLineNumber: task.lineNumber,
        taskText: task.normalizedText,
        startedAtIso: clockIn.clockInTimeIso,
        endedAtIso,
        elapsedMinutes,
        source: 'clock',
      };
      return this.stateStore.appendTimeSession(cleared.state, session, 90);
    });

    if (elapsedMinutes > 0) {
      await this.addActualTimeToTask(task, elapsedMinutes, `✓ Logged ${elapsedMinutes}m to task actual time`);
    } else {
      new Notice('⏱ Clocked out (0 minutes)');
    }
  }

  private async addActualTimeToTask(task: ParsedTask, elapsedMinutes: number, noticeText?: string): Promise<void> {
    if (elapsedMinutes <= 0) return;
    const fileAbstract = this.app.vault.getAbstractFileByPath(task.filePath);
    if (!(fileAbstract instanceof TFile)) {
      new Notice(`Session logged (${elapsedMinutes}m), but task actual time was not updated because the source task is unavailable.`);
      return;
    }
    try {
      await this.taskMutations.updateTaskActualTime(fileAbstract, task, elapsedMinutes);
      if (noticeText) new Notice(noticeText);
    } catch {
      new Notice(`Session logged (${elapsedMinutes}m), but task actual time was not updated because the task could not be uniquely verified. Rescan and apply the time manually.`);
    }
  }

  private async recordFocusTime(task: ParsedTask, elapsedMs: number): Promise<void> {
    if (!Number.isFinite(elapsedMs) || elapsedMs < 5_000) return;
    const elapsedMinutes = Math.max(1, Math.floor(elapsedMs / 60_000));
    const endedAt = new Date();
    const startedAt = new Date(endedAt.getTime() - elapsedMs);
    const session: TimeSessionRecord = {
      taskKey: task.key,
      taskFilePath: task.filePath,
      taskLineNumber: task.lineNumber,
      taskText: task.normalizedText,
      startedAtIso: startedAt.toISOString(),
      endedAtIso: endedAt.toISOString(),
      elapsedMinutes,
      source: 'focus-timer',
    };
    await this.stateStore.updateState((state) => this.stateStore.appendTimeSession(state, session, 90));
    await this.addActualTimeToTask(task, elapsedMinutes, '✓ Logged focus time to task actual time');
  }

  private decodeFiredReminderKey(entry: string): { key: string; firedAtIso: string | null } {
    const separator = entry.indexOf('\u0000');
    if (separator === -1) return { key: entry, firedAtIso: null };
    return { key: entry.slice(separator + 1), firedAtIso: entry.slice(0, separator) || null };
  }

  private encodeFiredReminderKey(key: string, firedAtIso = new Date().toISOString()): string {
    return `${firedAtIso}\u0000${key}`;
  }

  private pruneFiredReminderKeys(entries: string[], now = Date.now()): string[] {
    const cutoff = now - 48 * 60 * 60 * 1000;
    return entries.filter((entry) => {
      const { firedAtIso } = this.decodeFiredReminderKey(entry);
      if (!firedAtIso) return true;
      const timestamp = Date.parse(firedAtIso);
      return Number.isNaN(timestamp) || timestamp >= cutoff;
    });
  }

  private encodeFiredReminderState(existingEntries: string[] = []): string[] {
    const existingByKey = new Map<string, string>();
    for (const entry of existingEntries) {
      existingByKey.set(this.decodeFiredReminderKey(entry).key, entry);
    }
    const nowIso = new Date().toISOString();
    return Array.from(this.firedReminders ?? []).map((key) => existingByKey.get(key) ?? this.encodeFiredReminderKey(key, nowIso));
  }

  private async checkDueReminders(): Promise<void> {
    if (!this.settings?.enableReminderNotifications) return;
    const generation = this.ensureLifecycleGeneration();
    const taskIndex = this.getTaskIndex();
    const snapshot = taskIndex.getSnapshot();
    const reminderIndex = this.reminderIndex;
    if (!this.isLifecycleGenerationActive(generation) || snapshot.readiness !== 'ready' || !reminderIndex) return;
    if (this.reminderCheckPromise) {
      await this.reminderCheckPromise;
      return;
    }
    const check = this.performDueReminderCheck(reminderIndex, taskIndex, snapshot.revision, generation);
    this.reminderCheckPromise = check;
    try {
      await check;
    } finally {
      if (this.reminderCheckPromise === check) this.reminderCheckPromise = null;
    }
  }

  private async performDueReminderCheck(reminderIndex: ReminderIndex, taskIndex: TaskIndex, revision: number, generation: number): Promise<void> {
    const now = new Date();
    const nowStr = this.stateStore.formatReminderTime(now);
    const claims = reminderIndex.claimDue(nowStr);
    const notificationEffects = new Map<string, { taskText: string; key: string }>();
    const logEffects: Array<{ taskText: string; reminderTime: string }> = [];
    let committed: PersistedState;

    try {
      let state = await this.stateStore.loadState();
      const initialState = state;
      const prunedFiredEntries = this.pruneFiredReminderKeys(state.firedReminderKeys ?? [], now.getTime());
      const firedKeys = new Set(prunedFiredEntries.map((entry) => this.decodeFiredReminderKey(entry).key));
      const queuedKeys = new Set((state.queuedNotifications ?? []).map((entry) => entry.reminderKey));
      state = { ...state, firedReminderKeys: prunedFiredEntries };

      const quietHours = this.reminderManager.isInQuietHours(now);
      // Move due snoozes into the durable delivery outbox before attempting UI/OS delivery.
      for (const reminder of this.reminderManager.getDueSnoozedReminders(state)) {
        const currentKey = reminderIndex.keyForStoredRecord(reminder);
        const current = currentKey ? reminderIndex.resolve(currentKey) : undefined;
        if (current && currentKey) {
          state = this.reminderManager.queueNotification(state, {
            taskFilePath: current.task.filePath, taskLineNumber: current.task.lineNumber, taskText: current.task.rawLine,
            reminderKey: currentKey, reminderTime: reminder.originalReminderTime,
          });
          queuedKeys.add(currentKey);
          if (!quietHours) notificationEffects.set(currentKey, { taskText: current.task.rawLine, key: currentKey });
        }
        state = this.reminderManager.clearSnoozedReminder(state, reminder.reminderKey);
      }
      for (const indexed of claims) {
        const task = indexed.task;
        const reminder = task.metadata.reminder;
        if (!reminder) continue;
        const key = indexed.key;
        const legacyKey = `${task.filePath}:${task.lineNumber}:${reminder}`;
        if (firedKeys.has(key) || firedKeys.has(legacyKey) || queuedKeys.has(key)) continue;
        state = this.reminderManager.queueNotification(state, {
          taskFilePath: task.filePath,
          taskLineNumber: task.lineNumber,
          taskText: task.rawLine,
          reminderKey: key,
          reminderTime: indexed.fireTime,
        });
        queuedKeys.add(key);
        if (!quietHours) notificationEffects.set(key, { taskText: task.rawLine, key });
        if (this.settings.missedReminderLogEnabled) logEffects.push({ taskText: task.normalizedText, reminderTime: indexed.fireTime });
      }

      // Keep valid queued records durable until delivery is acknowledged. Stale
      // identities are removed without displaying their old task text.
      state = {
        ...state,
        queuedNotifications: (state.queuedNotifications ?? []).flatMap((notification) => {
          const reminderKey = reminderIndex.keyForStoredRecord(notification);
          const current = reminderKey ? reminderIndex.resolve(reminderKey) : undefined;
          if (!reminderKey || !current) return [];
          const normalized = { ...notification, reminderKey, taskFilePath: current.task.filePath, taskLineNumber: current.task.lineNumber, taskText: current.task.rawLine };
          if (!quietHours) notificationEffects.set(reminderKey, { taskText: current.task.rawLine, key: reminderKey });
          return [normalized];
        }),
      };

      const finalSnoozedKeys = new Set((state.snoozedReminders ?? []).map((reminder) => reminder.reminderKey));
      const removedSnoozed = new Map((initialState.snoozedReminders ?? [])
        .filter((reminder) => !finalSnoozedKeys.has(reminder.reminderKey))
        .map((reminder) => [reminder.reminderKey, JSON.stringify(reminder)]));
      const initialQueued = new Map((initialState.queuedNotifications ?? []).map((notification) => [notification.reminderKey, notification]));
      const finalQueuedKeys = new Set((state.queuedNotifications ?? []).map((notification) => notification.reminderKey));
      const removedQueued = new Map(Array.from(initialQueued.entries())
        .filter(([key]) => !finalQueuedKeys.has(key))
        .map(([key, notification]) => [key, JSON.stringify(notification)]));
      const queuedUpserts = (state.queuedNotifications ?? []).filter((notification) => {
        const initial = initialQueued.get(notification.reminderKey);
        return !initial || JSON.stringify(initial) !== JSON.stringify(notification);
      });
      let fenceRejected = false;
      const shouldCommit = (): boolean => {
        const current = taskIndex.getSnapshot();
        const accepted = this.isLifecycleGenerationActive(generation)
          && this.reminderIndex === reminderIndex
          && current.readiness === 'ready'
          && current.revision === revision;
        if (!accepted) fenceRejected = true;
        return accepted;
      };

      committed = await this.stateStore.updateState((current) => {
        let next: PersistedState = {
          ...current,
          snoozedReminders: (current.snoozedReminders ?? []).filter((reminder) => {
            const expected = removedSnoozed.get(reminder.reminderKey);
            return !expected || expected !== JSON.stringify(reminder);
          }),
          queuedNotifications: (current.queuedNotifications ?? []).filter((notification) => {
            const expected = removedQueued.get(notification.reminderKey);
            return !expected || expected !== JSON.stringify(notification);
          }),
        };
        for (const notification of queuedUpserts) next = this.stateStore.addQueuedNotification(next, notification);
        return { ...next, firedReminderKeys: this.pruneFiredReminderKeys(next.firedReminderKeys ?? [], now.getTime()) };
      }, { shouldCommit });
      if (!shouldCommit() || fenceRejected) throw new Error('Reminder check commit fence rejected a stale task index revision');
    } catch (error) {
      reminderIndex.retryDue(claims);
      throw error;
    }

    reminderIndex.ackDue(claims);
    const deliveredKeys = new Set<string>();
    for (const effect of notificationEffects.values()) {
      if ((await this.fireReminderNotification(effect.taskText, effect.key)) !== false) deliveredKeys.add(effect.key);
    }
    if (deliveredKeys.size > 0) {
      const expected = new Map((committed.queuedNotifications ?? []).filter((record) => deliveredKeys.has(record.reminderKey)).map((record) => [record.reminderKey, JSON.stringify(record)]));
      const deliveryCommitCurrent = (): boolean => {
        const current = taskIndex.getSnapshot();
        return this.isLifecycleGenerationActive(generation) && this.reminderIndex === reminderIndex && current.readiness === 'ready' && current.revision === revision;
      };
      committed = await this.stateStore.updateState((current) => {
        const firedEntries = this.pruneFiredReminderKeys(current.firedReminderKeys ?? [], now.getTime());
        const firedByKey = new Map(firedEntries.map((entry) => [this.decodeFiredReminderKey(entry).key, entry]));
        for (const key of deliveredKeys) if (!firedByKey.has(key)) firedByKey.set(key, this.encodeFiredReminderKey(key, now.toISOString()));
        return {
          ...current,
          queuedNotifications: (current.queuedNotifications ?? []).filter((record) => expected.get(record.reminderKey) !== JSON.stringify(record)),
          firedReminderKeys: Array.from(firedByKey.values()),
        };
      }, { shouldCommit: deliveryCommitCurrent });
    }
    this.firedReminders = new Set((committed.firedReminderKeys ?? []).map((entry) => this.decodeFiredReminderKey(entry).key));
    for (const effect of logEffects) void this.logMissedReminderToDaily(effect.taskText, effect.reminderTime);
  }

  /** #16: Fire a reminder via system notification (if permitted) or in-app Notice.
   *  On mobile, uses MobileNotifier for background persistence.
   *  On desktop, uses web Notification API or in-app notices.
   *  Includes snooze and done actions if enabled.
   */
  private async fireReminderNotification(taskText: string, taskKey: string): Promise<boolean> {
    const displayText = reminderTaskDisplayText(taskText);
    const actions = this.settings.reminderSnoozeEnabled ? [
      { action: 'done', title: '✓ Done' },
      { action: 'snooze', title: '⏱ Snooze' },
    ] : [];
    const onAction = (action: string): void => {
      if (action === 'done') void this.markReminderTaskDone(taskKey, taskText);
      else if (action === 'snooze') this.showSnoozeOptions(taskKey, taskText);
    };
    try {
      if (Platform.isIosApp || Platform.isAndroidApp || this.settings.useSystemNotifications) {
        await MobileNotifier.notify({ title: '⏰ Task Manager Reminder', body: displayText, tag: taskKey, actions, onAction, onTap: () => window.focus() });
        return true;
      }
      if (this.settings.reminderSnoozeEnabled) {
        const notice = new Notice('');
        const div = notice.noticeEl;
        div.empty();
        div.createEl('p', { text: `⏰ Reminder: ${displayText}` });
        const buttons = div.createDiv({ cls: 'task-manager-reminder-actions' });
        buttons.style.display = 'flex';
        buttons.style.gap = '8px';
        buttons.style.marginTop = '8px';
        const done = buttons.createEl('button', { text: '✓ Done' });
        done.onclick = () => { notice.hide(); onAction('done'); };
        const snooze = buttons.createEl('button', { text: '⏱ Snooze' });
        snooze.onclick = () => { notice.hide(); onAction('snooze'); };
      } else new Notice(`⏰ Reminder: ${displayText}`, 10_000);
      return true;
    } catch (error) {
      console.error('[task-manager] Reminder delivery failed; the durable outbox entry will be retried.', error);
      return false;
    }
  }

  /** Request OS-level notification permission (called from settings when useSystemNotifications is enabled). */
  async requestSystemNotificationPermission(): Promise<void> {
    if (!('Notification' in window)) {
      new Notice('Task Manager: System notifications are not supported in this environment.');
      return;
    }
    const NotificationClass = (window as unknown as { Notification: { requestPermission(): Promise<string>; permission: string } }).Notification;
    if (NotificationClass.permission === 'granted') {
      new Notice('Task Manager: System notification permission already granted.');
      return;
    }
    const result = await NotificationClass.requestPermission();
    if (result === 'granted') {
      new Notice('Task Manager: System notifications enabled. ✅');
    } else {
      new Notice('Task Manager: System notification permission denied — falling back to in-app notices.');
      this.settings.useSystemNotifications = false;
      await this.saveSettings();
    }
  }

  // ── Quick Capture ─────────────────────────────────────────────────────────

  private openQuickAddModal(): void {
    new QuickAddTaskModal(this.app, this.settings, (taskLine) => {
      const editor = this.app.workspace.activeEditor?.editor;
      if (editor) {
        const cursor = editor.getCursor();
        editor.replaceRange(taskLine + '\n', { line: cursor.line + 1, ch: 0 });
        editor.setCursor({ line: cursor.line + 1, ch: taskLine.length });
      } else {
        void this.appendQuickCaptureTask(taskLine);
      }
    }).open();
  }

  private openQuickCaptureModal(): void {
    new QuickCaptureModal(this.app, this.settings, async (taskLine) => {
      await this.appendQuickCaptureTask(taskLine);
    }).open();
  }

  openGoogleCalendarQuickCaptureModal(): void {
    new GoogleCalendarQuickCaptureModal(this.app, this.settings, async (taskLine) => {
      await this.appendQuickCaptureTask(taskLine);
    }).open();
  }

  openGoogleCalendarSetupWizard(): void {
    new GoogleCalendarSetupWizardModal(this.app, this).open();
  }

  private openVoiceCaptureModal(): void {
    if (!VoiceCapture.isAvailable(this.settings)) {
      new Notice('Voice capture requires a browser with Web Speech API or a configured Whisper API key.');
      return;
    }
    this.activeVoiceCapture?.abort();
    const vc = new VoiceCapture(
      this.app,
      () => this.settings,
      (taskLine) => { void this.appendQuickCaptureTask(taskLine); },
    );
    this.activeVoiceCapture = vc;
    // Open a live-recording modal
    new VoiceCaptureRecordingModal(this.app, vc).open();
  }

  private async appendQuickCaptureTask(taskLine: string): Promise<void> {
    const inboxPath = this.settings.quickCaptureInboxPath.trim();
    let targetFile: TFile;
    if (inboxPath) {
      const normalizedPath = normalizeVaultRelativePath(inboxPath.endsWith('.md') ? inboxPath : `${inboxPath}.md`, 'Quick capture inbox path');
      const existing = this.app.vault.getAbstractFileByPath(normalizedPath);
      if (existing instanceof TFile) {
        targetFile = existing;
      } else {
        try {
          await this.ensureParentFolder(normalizedPath);
          targetFile = await this.app.vault.create(normalizedPath, '');
        } catch {
          // File was created by a concurrent call between the check and the create.
          const retryExisting = this.app.vault.getAbstractFileByPath(normalizedPath);
          if (retryExisting instanceof TFile) {
            targetFile = retryExisting;
          } else {
            throw new Error(`Task Manager: could not create or find inbox file: ${inboxPath}`);
          }
        }
      }
    } else {
      const daily = await this.dailyNoteResolver.resolveToday();
      targetFile = daily.file;
    }
    await this.app.vault.process(targetFile, (current) => current ? `${current}${current.endsWith('\n') ? '' : '\n'}${taskLine}` : taskLine);
    new Notice(`Task Manager: captured to ${targetFile.basename}`);
    // Immediately rescan so the task appears in query blocks and the dashboard
    // without waiting for the debounced vault-modify handler.
    try {
      await this.scanFile(targetFile, true);
      this.queryRenderer.refreshAllVisible();
    } catch {
      // Fall back to cache invalidation during early init or in test environments.
      this.queryRenderer.invalidateCache(targetFile.path);
    }
  }

  // ── Templates ─────────────────────────────────────────────────────────────

  private openTemplateModal(): void {
    const templates = this.settings.taskTemplates;
    if (templates.length === 0) {
      new Notice('Task Manager: no templates configured. Add templates in settings.');
      return;
    }
    new TaskTemplateSuggestModal(this.app, templates, (template) => {
      // Resolve dynamic date tokens in template fields at insertion time
      const resolveTplTokens = (text: string): string => {
        const today = new Date();
        const fmtDate = (d: Date) => formatLocalDate(d);
        return text
          .replace(/\{\{today\}\}/giu, fmtDate(today))
          .replace(/\{\{tomorrow\}\}/giu, () => { const d = new Date(today); d.setDate(d.getDate() + 1); return fmtDate(d); })
          .replace(/\{\{yesterday\}\}/giu, () => { const d = new Date(today); d.setDate(d.getDate() - 1); return fmtDate(d); })
          .replace(/\{\{\+(\d+)d\}\}/giu, (_: string, n: string) => { const d = new Date(today); d.setDate(d.getDate() + Number.parseInt(n, 10)); return fmtDate(d); })
          .replace(/\{\{-(\d+)d\}\}/giu, (_: string, n: string) => { const d = new Date(today); d.setDate(d.getDate() - Number.parseInt(n, 10)); return fmtDate(d); })
          .replace(/\{\{\+(\d+)w\}\}/giu, (_: string, n: string) => { const d = new Date(today); d.setDate(d.getDate() + Number.parseInt(n, 10) * 7); return fmtDate(d); })
          .replace(/\{\{next (monday|tuesday|wednesday|thursday|friday|saturday|sunday)\}\}/giu, (_: string, day: string) => {
            const dayIndex = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].indexOf(day.toLowerCase());
            if (dayIndex === -1) return _;
            const d = new Date(today);
            const diff = ((dayIndex - d.getDay() + 7) % 7) || 7;
            d.setDate(d.getDate() + diff);
            return fmtDate(d);
          })
          .replace(/\{\{YYYY\}\}/gu, () => String(today.getFullYear()))
          .replace(/\{\{MM\}\}/gu, () => String(today.getMonth() + 1).padStart(2, '0'))
          .replace(/\{\{DD\}\}/gu, () => String(today.getDate()).padStart(2, '0'));
      };
      const initial: Partial<EditableTaskLine> = {
        description: resolveTplTokens(template.description),
        priority: template.priority || 'normal',
        recurrence: resolveTplTokens(template.recurrence),
        onCompletion: template.onCompletion,
      };
      new TaskEditModal(this.app, this.settings, '', (line) => {
        const leaf = this.app.workspace.getMostRecentLeaf();
        const view = leaf?.view as { editor?: { replaceSelection?: (text: string) => void } } | undefined;
        if (!view?.editor?.replaceSelection) throw new Error('No active editor is available for template insertion.');
        view.editor.replaceSelection(line);
      }, undefined, initial, undefined, () => this.saveSettings()).open();
    }).open();
  }

  // ── Export ────────────────────────────────────────────────────────────────

  private async exportTasksCsv(): Promise<void> {
    const tasks = await this.scanVaultTasks();
    const headers = ['description', 'status', 'priority', 'due', 'scheduled', 'start', 'created', 'done', 'cancelled', 'recurrence', 'id', 'depends_on', 'file', 'line'];
    const rows = tasks.map((t) => [
      t.normalizedText,
      t.status,
      t.metadata.priority,
      t.metadata.dates.due ?? '',
      t.metadata.dates.scheduled ?? '',
      t.metadata.dates.start ?? '',
      t.metadata.dates.created ?? '',
      t.metadata.dates.done ?? '',
      t.metadata.dates.cancelled ?? '',
      t.metadata.recurrence ?? '',
      t.metadata.id ?? '',
      t.metadata.dependsOn.join(';'),
      t.filePath,
      String(t.lineNumber),
    ].map(csvEscape).join(','));
    const csv = [headers.map(csvEscape).join(','), ...rows].join('\n');
    const exportPath = `Task Export ${todayDateString()}.csv`;
    const existing = this.app.vault.getAbstractFileByPath(exportPath);
    if (existing instanceof TFile) {
      await this.app.vault.modify(existing, csv);
    } else {
      await this.app.vault.create(exportPath, csv);
    }
    new Notice(`Task Manager: exported ${tasks.length} tasks to ${exportPath}`);
  }

  private async copyTasksJson(): Promise<void> {
    const tasks = await this.scanVaultTasks();
    const data = tasks.map((t) => ({
      description: t.normalizedText,
      status: t.status,
      priority: t.metadata.priority,
      due: t.metadata.dates.due,
      scheduled: t.metadata.dates.scheduled,
      start: t.metadata.dates.start,
      created: t.metadata.dates.created,
      done: t.metadata.dates.done,
      cancelled: t.metadata.dates.cancelled,
      recurrence: t.metadata.recurrence,
      id: t.metadata.id,
      dependsOn: t.metadata.dependsOn,
      file: t.filePath,
      line: t.lineNumber,
    }));
    await navigator.clipboard.writeText(JSON.stringify(data, null, 2));
    new Notice(`Task Manager: copied ${tasks.length} tasks as JSON`);
  }

  // ── #22: JSON / YAML export to vault ──────────────────────────────────────────────
  private async exportTasksJson(): Promise<void> {
    const tasks = this.apiV1.getAllTasks();
    const data = tasks.map((t) => ({
      filePath: t.filePath,
      lineNumber: t.lineNumber,
      content: t.normalizedText,
      status: t.status,
      priority: t.metadata.priority,
      due: t.metadata.dates.due ?? null,
      scheduled: t.metadata.dates.scheduled ?? null,
      start: t.metadata.dates.start ?? null,
      done: t.metadata.dates.done ?? null,
      created: t.metadata.dates.created ?? null,
      tags: t.tags,
      recurrence: t.metadata.recurrence ?? null,
      id: t.metadata.id ?? null,
    }));
    const exportPath = ensureExportPathExtension(this.settings.jsonExportPath, 'Tasks Export.json', 'json');
    await this.app.vault.adapter.write(exportPath, JSON.stringify(data, null, 2));
    new Notice(`Task Manager: exported ${tasks.length} tasks to ${exportPath}`);
  }

  private async exportTasksYaml(): Promise<void> {
    const tasks = this.apiV1.getAllTasks();
    const yamlLines = ['tasks:'];
    for (const t of tasks) {
      yamlLines.push(`  - content: ${JSON.stringify(t.normalizedText)}`);
      yamlLines.push(`    filePath: ${JSON.stringify(t.filePath)}`);
      yamlLines.push(`    lineNumber: ${t.lineNumber}`);
      yamlLines.push(`    status: ${t.status}`);
      yamlLines.push(`    priority: ${t.metadata.priority}`);
      if (t.metadata.dates.due) yamlLines.push(`    due: '${t.metadata.dates.due}'`);
      if (t.metadata.dates.scheduled) yamlLines.push(`    scheduled: '${t.metadata.dates.scheduled}'`);
      if (t.tags.length > 0) yamlLines.push(`    tags: [${t.tags.map((tag) => JSON.stringify(tag)).join(', ')}]`);
      if (t.metadata.id) yamlLines.push(`    id: ${JSON.stringify(t.metadata.id)}`);
    }
    const exportPath = ensureExportPathExtension(this.settings.yamlExportPath, 'Tasks Export.yaml', 'yaml');
    await this.app.vault.adapter.write(exportPath, yamlLines.join('\n') + '\n');
    new Notice(`Task Manager: exported ${tasks.length} tasks to ${exportPath}`);
  }

  private async publishICSFeed(): Promise<void> {
    try {
      const { exportToICS } = await import('./exporters');
      const tasks = this.apiV1.getAllTasks();
      const icsContent = await exportToICS(tasks);
      const exportPath = ensureExportPathExtension(this.settings.icsExportPath, 'Task Feed.ics', 'ics');
      const exportParentPath = exportPath.replace(/\/[^/]+$/u, '');
      if (exportParentPath && exportParentPath !== exportPath) {
        try {
          await this.app.vault.adapter.mkdir(exportParentPath);
        } catch {
          // Parent folder may already exist.
        }
      }
      await this.app.vault.adapter.write(exportPath, icsContent);
      new Notice(`Task Manager: published ICS feed with ${tasks.length} tasks to ${exportPath}`);
    } catch (err) {
      new Notice(`Task Manager: ICS feed export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private async exportTasksAsKanban(): Promise<void> {
    try {
      const { exportTasksAsKanban } = await import('./kanban-board');
      const tasks = this.apiV1.getAllTasks();
      const kanbanMarkdown = exportTasksAsKanban(tasks, 'status');
      const exportPath = `Tasks Kanban - ${todayDateString()}.md`;
      await this.app.vault.adapter.write(exportPath, kanbanMarkdown);
      new Notice(`Task Manager: exported ${tasks.length} tasks to Kanban board`);
    } catch (err) {
      new Notice(`Task Manager: Kanban export failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private createProjectWorkspace(): void {
    new ProjectWorkspaceCreateModal(this.app, async ({ name, folder }) => {
      try {
        const { createDefaultWorkspace, generateWorkspaceMarkdown } = await import('./project-workspace');
        const projectName = name.trim() || 'New Project';
        const folderPath = (folder.trim() || 'Projects').replace(/^\/+|\/+$/gu, '');
        const workspace = createDefaultWorkspace(projectName);
        for (const query of workspace.queries) {
          const parsed = parseTaskQuery(query.query, {
            savedQueries: this.settings.savedQueries,
            enableDslExpressions: this.settings.enableDslExpressions,
            nlpQueryEnabled: this.settings.nlpQueryEnabled,
          });
          if (parsed.errors.length > 0) {
            throw new Error(`Generated query "${query.name}" is invalid: ${parsed.errors.join('; ')}`);
          }
        }
        const markdown = generateWorkspaceMarkdown(workspace);
        const safeName = projectName.replace(/[\\/:*?"<>|]/gu, '-');
        const workspacePath = `${folderPath}/${safeName} Workspace.md`;
        try {
          await this.app.vault.adapter.mkdir(folderPath);
        } catch {
          // Directory may already exist
        }
        const existing = this.app.vault.getAbstractFileByPath(workspacePath);
        if (existing) {
          new Notice(`Task Manager: workspace already exists at ${workspacePath}`);
          return;
        }
        await this.app.vault.create(workspacePath, markdown);
        new Notice(`Task Manager: created project workspace at ${workspacePath}`);
        const file = this.app.vault.getAbstractFileByPath(workspacePath);
        if (file instanceof TFile) {
          await this.app.workspace.getLeaf().openFile(file);
        }
      } catch (err) {
        new Notice(`Task Manager: Workspace creation failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }).open();
  }

  private async refreshCurrentProjectWorkspace(): Promise<void> {
    const file = this.app.workspace.getActiveFile();
    if (!(file instanceof TFile)) {
      new Notice('Task Manager: open a project workspace note to refresh it.');
      return;
    }
    try {
      const { isProjectWorkspaceMarkdown, refreshWorkspaceMarkdown } = await import('./project-workspace');
      const content = await this.app.vault.read(file);
      if (!isProjectWorkspaceMarkdown(content)) {
        new Notice('Task Manager: open a project workspace note to refresh it. This note was left unchanged.');
        return;
      }
      const allTasks = this.apiV1.getAllTasks();
      const result = await this.app.vault.process(file, (content) => {
        const refreshed = refreshWorkspaceMarkdown(content, allTasks, (queryText, tasks) => {
          const query = parseTaskQuery(queryText, {
            savedQueries: this.settings.savedQueries,
            enableDslExpressions: this.settings.enableDslExpressions,
            nlpQueryEnabled: this.settings.nlpQueryEnabled,
          });
          return filterTasks(tasks, query, {
            states: this.settings.supportedStates,
            savedQueries: this.settings.savedQueries,
            enableDslExpressions: this.settings.enableDslExpressions,
            customPriorities: this.settings.customPriorities,
            futureOccurrenceCount: this.settings.futureOccurrenceCount,
            fileDefaultsEnabled: this.settings.fileDefaultsEnabled,
            fileDefaultsPropertyPrefix: this.settings.fileDefaultsPropertyPrefix,
            nlpQueryEnabled: this.settings.nlpQueryEnabled,
          });
        });
        return refreshed.markdown;
      });
      new Notice(`Task Manager: refreshed project workspace ${file.path}.`);
      void result;
    } catch (err) {
      new Notice(`Task Manager: workspace refresh failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // ── #9: ICS import ─────────────────────────────────────────────────────────────────────
  private importIcsCalendar(): Promise<void> {
    new Notice('Task Manager: remote ICS URL import is disabled because the mobile-safe runtime cannot pin DNS and reject redirects. Download the calendar and use a reviewed local conversion workflow instead.');
    return Promise.resolve();
  }

  // ── #10: Apple Reminders / Microsoft To Do ──────────────────────────────────────────────
  private syncAppleReminders(): void {
    const listName = this.settings.appleRemindersListName?.trim() ?? '';
    const inboxPath = this.settings.appleRemindersInboxPath?.trim() || 'Reminders Inbox.md';
    const filePath = inboxPath.endsWith('.md') ? inboxPath : `${inboxPath}.md`;
    const shortcutUrl = buildAppleRemindersShortcutUrl(this.settings.appleRemindersShortcutName, listName);
    window.open(shortcutUrl, '_blank', 'noopener');
    new Notice(`Task Manager: Opened Shortcuts to export${listName ? ` “${listName}”` : ''} reminders. Copy the JSON result, then run “Import Apple Reminders JSON from clipboard” to write to ${filePath}.`);
  }

  private async importAppleRemindersFromClipboard(): Promise<void> {
    if (!this.settings.appleRemindersEnabled || !this.settings.appleRemindersWebhookEnabled) {
      new Notice('Task Manager: enable Apple Reminders and clipboard JSON import in settings first.');
      return;
    }
    if (!navigator.clipboard?.readText) {
      new Notice('Task Manager: clipboard reading is unavailable on this device.');
      return;
    }
    try {
      const raw = await navigator.clipboard.readText();
      if (utf8ByteLength(raw) > APPLE_REMINDERS_CLIPBOARD_MAX_BYTES) {
        new Notice(t('notice.applePayloadTooLarge'));
        return;
      }
      const payload = JSON.parse(raw) as unknown;
      const result = await this.importAppleRemindersWebhookPayload(payload);
      if (!result.accepted) {
        new Notice(`Task Manager: Apple Reminders payload rejected${result.reason ? ` (${result.reason})` : ''}.`);
        return;
      }
      new Notice(this.settings.appleRemindersDryRun
        ? `Task Manager: Apple Reminders dry run accepted ${result.imported} item${result.imported === 1 ? '' : 's'}.`
        : `Task Manager: imported/updated ${result.imported} Apple Reminder${result.imported === 1 ? '' : 's'}.`);
    } catch (error) {
      new Notice(`Task Manager: could not import Apple Reminders JSON — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async importAppleRemindersWebhookPayload(payload: unknown): Promise<{ imported: number; accepted: boolean; reason?: string }> {
    const inboxPath = this.settings.appleRemindersInboxPath?.trim() || 'Reminders Inbox.md';
    const filePath = normalizeVaultRelativePath(inboxPath.endsWith('.md') ? inboxPath : `${inboxPath}.md`, 'Apple Reminders inbox path');
    const existingFile = this.app.vault.getAbstractFileByPath(filePath);
    const existingContent = existingFile instanceof TFile ? await this.app.vault.read(existingFile) : '';
    const result = planAppleRemindersWebhookImport(payload, {
      enabled: this.settings.appleRemindersEnabled && this.settings.appleRemindersWebhookEnabled,
      secret: this.settings.appleRemindersWebhookSecret,
      inboxPath: this.settings.appleRemindersInboxPath,
      dryRun: this.settings.appleRemindersDryRun,
    }, existingContent, this.settings.syncConflictDirection === 'service-first');
    if (!result.accepted) return { imported: 0, accepted: false, reason: result.reason };
    let applied = result;
    if (!this.settings.appleRemindersDryRun && (result.newLines.length > 0 || result.updatedIds.length > 0)) {
      if (existingFile instanceof TFile) {
        await this.app.vault.process(existingFile, (current) => {
          applied = planAppleRemindersWebhookImport(payload, {
            enabled: this.settings.appleRemindersEnabled && this.settings.appleRemindersWebhookEnabled,
            secret: this.settings.appleRemindersWebhookSecret,
            inboxPath: this.settings.appleRemindersInboxPath,
            dryRun: false,
          }, current, this.settings.syncConflictDirection === 'service-first');
          const prefix = applied.updatedMarkdown.trim().length > 0 && !applied.updatedMarkdown.endsWith('\n') ? '\n' : '';
          return `${applied.updatedMarkdown}${prefix}${applied.newLines.join('\n')}${applied.newLines.length > 0 ? '\n' : ''}`;
        });
      } else {
        await this.ensureParentFolder(filePath);
        await this.app.vault.create(filePath, `${result.newLines.join('\n')}\n`);
      }
      this.settings.syncLastSuccessAppleReminders = new Date().toISOString();
      await this.saveSettings();
    }
    return { imported: applied.newLines.length + applied.updatedIds.length, accepted: true };
  }

  private syncMsToDo(): Promise<void> { return this.runProviderSync('microsoft-todo', (context) => this.performMsToDoSync(context)); }
  private async performMsToDoSync(context: ProviderRunContext): Promise<void> {
    assertProviderRunCurrent(context);
    const startedAt = new Date().toISOString();
    let stagedCredentials: { accessToken: string; refreshToken: string; expiresAt: string } | null = null;
    const restoreStagedCredentials = (): void => {
      if (!stagedCredentials) return;
      this.settings.msToDoToken = stagedCredentials.accessToken;
      this.settings.msToDoRefreshToken = stagedCredentials.refreshToken;
      this.settings.msToDoTokenExpiresAt = stagedCredentials.expiresAt;
      stagedCredentials = null;
    };
    const stageTokenRefresh = async (): Promise<void> => {
      const previous = { accessToken: this.settings.msToDoToken, refreshToken: this.settings.msToDoRefreshToken, expiresAt: this.settings.msToDoTokenExpiresAt };
      await this.refreshMicrosoftTodoTokenIfNeeded(context, false);
      if (previous.accessToken !== this.settings.msToDoToken || previous.refreshToken !== this.settings.msToDoRefreshToken || previous.expiresAt !== this.settings.msToDoTokenExpiresAt) stagedCredentials = previous;
    };
    const hasMicrosoftTodoCredentials = Boolean(this.settings.msToDoToken?.trim() || this.settings.msToDoRefreshToken?.trim());
    if (!this.settings.msToDoEnabled && hasMicrosoftTodoCredentials) {
      new Notice('Task Manager: Microsoft To Do sync is disabled.');
      return;
    }
    let healthyTasks: ParsedTask[] | undefined;
    if (hasMicrosoftTodoCredentials || this.settings.msToDoDryRun) {
      try {
        healthyTasks = await this.requireHealthyIndexedTasks('Microsoft To Do sync');
        assertProviderRunCurrent(context);
      } catch (error) {
        if (isProviderRunCancellation(error) || !context.isCurrent()) return;
        const details = error instanceof Error ? error.message : String(error);
        this.recordSyncRun({ service: 'Microsoft To Do', startedAt, endedAt: new Date().toISOString(), outcome: 'failed', details }, context);
        new Notice(`Task Manager: Microsoft To Do sync refused — ${details}`);
        return;
      }
    }
    if (!this.settings.msToDoToken?.trim() && !this.settings.msToDoDryRun) {
      try {
        await stageTokenRefresh();
        assertProviderRunCurrent(context);
      } catch (err) {
        restoreStagedCredentials();
        if (isProviderRunCancellation(err) || !context.isCurrent()) return;
        new Notice(`Task Manager: Microsoft To Do token refresh failed: ${err instanceof Error ? err.message : String(err)}`);
        return;
      }
    }
    if (!this.settings.msToDoToken?.trim()) {
      if (this.settings.msToDoDryRun) {
        new Notice('Task Manager: Microsoft To Do dry run requires a currently valid access token; dry run will not refresh or persist credentials.');
        return;
      }
      if (!this.settings.msToDoClientId?.trim()) {
        new Notice('Task Manager: Microsoft To Do token not configured. Add an Azure app client ID or paste an access token in settings.');
        return;
      }
      const state = generatePkceVerifier(32);
      const oauth = await microsoftTodoPkceOAuthStart(this.settings.msToDoClientId.trim(), { state });
      assertProviderRunCurrent(context);
      window.open(oauth.authorizationUrl, '_blank', 'noopener');
      new MicrosoftTodoOAuthModal(this.app, this, { codeVerifier: oauth.codeVerifier, state: oauth.state ?? state }).open();
      new Notice('Task Manager: Opened Microsoft To Do PKCE login. Complete sign-in, then paste the callback URL in the OAuth modal.');
      return;
    }
    let filePath: string;
    let state: PersistedState;
    try {
      const inboxPath = this.settings.msToDoInboxPath?.trim() || 'MS To Do Inbox.md';
      filePath = normalizeVaultRelativePath(inboxPath.endsWith('.md') ? inboxPath : `${inboxPath}.md`, 'Microsoft To Do inbox path');
      state = await this.stateStore.loadState();
      assertProviderRunCurrent(context);
    } catch (error) {
      restoreStagedCredentials();
      if (isProviderRunCancellation(error) || !context.isCurrent()) return;
      this.recordSyncRun({ service: 'Microsoft To Do', startedAt, endedAt: new Date().toISOString(), outcome: 'failed', details: String(error) }, context);
      new Notice(`Task Manager: Microsoft To Do sync failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const mapper = this.settings.msToDoDryRun ? new IdentityMapper(state.identityState) : (this.identityMapper ?? new IdentityMapper(state.identityState));
    const queue = this.settings.msToDoDryRun ? new SyncOperationQueue() : (this.syncOperationQueue ?? new SyncOperationQueue(state.syncQueueState));
    let syncStateTouched = false;
    try {
      if (this.settings.msToDoDryRun && tokenExpiresSoon(this.settings.msToDoTokenExpiresAt)) {
        new Notice('Task Manager: Microsoft To Do dry run requires a non-expired access token; dry run will not refresh or persist credentials.');
        return;
      }
      if (!this.settings.msToDoDryRun) await stageTokenRefresh();
      assertProviderRunCurrent(context);
      const config = { accessToken: this.settings.msToDoToken, refreshToken: this.settings.msToDoRefreshToken, tokenExpiresAt: this.settings.msToDoTokenExpiresAt, listId: this.settings.msToDoListId, vaultImportPath: filePath, bidirectionalSync: false, syncIntervalMinutes: 0, signal: context.signal, assertCurrent: () => assertProviderRunCurrent(context) };
      const adapter = new MicrosoftTodoAdapter(config);
      queue.registerAdapter('microsoft-todo', adapter);
      const localTasks = healthyTasks ?? await this.requireHealthyIndexedTasks('Microsoft To Do sync');
      assertProviderRunCurrent(context);
      const localByMicrosoftId = new Map<string, ParsedTask>();
      for (const task of localTasks) {
        const id = task.metadata.id?.match(/^(?:ms-todo:|microsoft-todo:)(.+)$/u)?.[1];
        if (!id) continue;
        if (localByMicrosoftId.has(id)) throw new Error(`Microsoft To Do ID ${id} is duplicated in the vault; no sync writes were attempted`);
        localByMicrosoftId.set(id, task);
      }
      const remoteTasks = await fetchMicrosoftTodoTasks(config);
      assertProviderRunCurrent(context);
      const remoteById = new Map<string, (typeof remoteTasks)[number]>();
      for (const remote of remoteTasks) {
        if (remoteById.has(remote.id)) throw new Error(`Microsoft To Do returned duplicate remote ID ${remote.id}; no sync writes were attempted`);
        remoteById.set(remote.id, remote);
      }
      if (stagedCredentials) {
        if (await this.saveSettings(context.isCurrent) === false) { restoreStagedCredentials(); return; }
        stagedCredentials = null;
        assertProviderRunCurrent(context);
      }
      if (!this.settings.msToDoDryRun) {
        queue.quarantineUnsafeProviderOperations('microsoft-todo');
        queue.quarantineUnsafeProviderOperations('ms-todo');
        this.identityMapper = mapper;
        this.syncOperationQueue = queue;
        for (const [id, task] of localByMicrosoftId) mapper.mapExternalId(task.key, 'microsoft-todo', id);
        syncStateTouched = true;
      }
      const newTasks = remoteTasks.filter((remote) => !localByMicrosoftId.has(remote.id));
      let imported = this.settings.msToDoDryRun ? newTasks.length : 0;
      let inbound = 0;
      let outbound = 0;
      let failed = 0;

      for (const [id, local] of localByMicrosoftId) {
        const remote = remoteById.get(id);
        const reconciliation = reconcileMicrosoftTodoTask(local, remote, mapper.getBaseline(local.key, 'microsoft-todo'));
        queue.removeReconciliationOperations(local.key, 'microsoft-todo', id);
        if (reconciliation.mode === 'conflict') {
          queue.enqueueReconciliationConflict(local, 'microsoft-todo', id, reconciliation.conflicts, reconciliation.evidence);
          continue;
        }
        if (this.settings.msToDoDryRun) {
          if (Object.keys(reconciliation.inbound).length > 0) inbound += 1;
          if (Object.keys(reconciliation.outbound).length > 0) outbound += 1;
          continue;
        }
        let current = local;
        let pendingOutboundId: string | undefined;
        try {
          if (Object.keys(reconciliation.inbound).length > 0) {
            current = await this.applyInboundSyncProjection(current, reconciliation.inbound, 'microsoft-todo', context);
            assertProviderRunCurrent(context);
            inbound += 1;
          }
          if (reconciliation.nextBaseline && !projectionsEqual(microsoftTodoProjectionFromVaultTask(current), reconciliation.nextBaseline)) {
            throw new Error(`Microsoft To Do inbound verification failed for ${id}; baseline was not advanced`);
          }
          let verifiedVersion = reconciliation.evidence.remoteVersion;
          if (Object.keys(reconciliation.outbound).length > 0) {
            const pending = queue.enqueueReconciliationConflict(local, 'microsoft-todo', id, [{ field: 'interrupted-remote-update', vaultValue: reconciliation.evidence.local, serviceValue: reconciliation.evidence.remote, service: 'microsoft-todo', detectedAt: Date.now() }], { ...reconciliation.evidence, mode: 'conflict' });
            pending.error = 'Microsoft To Do update was dispatched; a fresh remote read is required until verification completes.';
            pendingOutboundId = pending.id;
            this.markSyncStateDirty(false, true);
            await this.persistSyncState(context.isCurrent);
            assertProviderRunCurrent(context);
            const payload = microsoftTodoPayloadFromProjection(reconciliation.outbound);
            const writeResult = await adapter.update(id, payload);
            assertProviderRunCurrent(context);
            if (!writeResult.projection || !reconciliation.nextBaseline || !projectionsEqual(writeResult.projection, reconciliation.nextBaseline)) {
              throw new Error(`Microsoft To Do post-write verification failed for ${id}; baseline was not advanced`);
            }
            verifiedVersion = writeResult.remoteVersion;
            if (pendingOutboundId) queue.removeOperations([pendingOutboundId]);
            pendingOutboundId = undefined;
            this.markSyncStateDirty(false, true);
            outbound += 1;
          }
          if (reconciliation.nextBaseline) mapper.recordBaseline(current.key, 'microsoft-todo', reconciliation.nextBaseline, verifiedVersion);
        } catch (error) {
          if (isProviderRunCancellation(error) || !context.isCurrent()) return;
          const held = pendingOutboundId ? queue.getOperation(pendingOutboundId) : queue.enqueueReconciliationConflict(local, 'microsoft-todo', id, [{ field: 'apply-or-verify', vaultValue: reconciliation.evidence.local, serviceValue: reconciliation.evidence.remote, service: 'microsoft-todo', detectedAt: Date.now() }], { ...reconciliation.evidence, mode: 'conflict' });
          if (held) held.error = error instanceof Error ? error.message : String(error);
          failed += 1;
        }
      }

      if (newTasks.length > 0 && !this.settings.msToDoDryRun) {
        const committed = await commitProviderImports(this.app, filePath, 'microsoft-todo', newTasks.map((remote) => ({ externalId: remote.id, markdown: microsoftTodoToTaskLine(remote), value: remote })), context);
        assertProviderRunCurrent(context);
        imported = committed.length;
        for (const { value: remote } of committed) {
          const importedTask = adapter.fromServicePayload(remote as unknown as Record<string, unknown>, filePath);
          const vaultKey = explicitTaskKey(`ms-todo:${remote.id}`);
          const localProjection = microsoftTodoProjectionFromVaultTask(importedTask);
          const remoteProjection = microsoftTodoProjectionFromRemoteTask(remote);
          mapper.mapExternalId(vaultKey, 'microsoft-todo', remote.id);
          if (projectionsEqual(localProjection, remoteProjection)) {
            mapper.recordBaseline(vaultKey, 'microsoft-todo', localProjection, microsoftTodoRemoteVersion(remote));
          }
        }
      }

      const conflictLines = queue.getState().operations
        .filter((op) => op.service === 'microsoft-todo' && op.status === 'conflict')
        .map((op) => `- ${op.vaultTask.filePath}:${op.vaultTask.lineNumber} ↔ Microsoft To Do ${op.externalId ?? ''}`);
      const retainedConflicts = conflictLines.length;
      const retainedFailures = queue.getState().operations.filter((op) => op.service === 'microsoft-todo' && op.status === 'failed').length;
      if (!this.settings.msToDoDryRun) await this.appendSyncConflictReport('Microsoft To Do', conflictLines, context);
      assertProviderRunCurrent(context);
      const outcome: SyncRunSummary['outcome'] = this.settings.msToDoDryRun ? 'dry-run' : retainedConflicts > 0 || retainedFailures > 0 || failed > 0 ? 'partial' : 'success';
      const endedAt = new Date().toISOString();
      this.recordSyncRun({ service: 'Microsoft To Do', startedAt, endedAt, outcome, details: `imported=${imported}, inbound=${inbound}, outbound=${outbound}, conflicts=${retainedConflicts}, failed=${retainedFailures}`, imported, conflicts: retainedConflicts, failed: retainedFailures }, context);
      if (!this.settings.msToDoDryRun && outcome === 'success') {
        const previous = this.settings.syncLastSuccessMsToDo;
        this.settings.syncLastSuccessMsToDo = endedAt;
        if (await this.saveSettings(context.isCurrent) === false) { this.settings.syncLastSuccessMsToDo = previous; return; }
        assertProviderRunCurrent(context);
      }
      if (!this.settings.msToDoDryRun) {
        this.markSyncStateDirty(true, true);
        await this.persistSyncState(context.isCurrent);
        assertProviderRunCurrent(context);
      }
      new Notice(`Task Manager: Microsoft To Do ${this.settings.msToDoDryRun ? 'dry run' : 'sync'} complete — ${imported} new, ${inbound} inbound, ${outbound} outbound, ${retainedConflicts} conflicted, ${retainedFailures} failed.`);
    } catch (error) {
      restoreStagedCredentials();
      if (isProviderRunCancellation(error) || !context.isCurrent()) return;
      if (!this.settings.msToDoDryRun && syncStateTouched) {
        this.markSyncStateDirty(true, true);
        await this.persistSyncState(context.isCurrent);
        assertProviderRunCurrent(context);
      }
      this.recordSyncRun({ service: 'Microsoft To Do', startedAt, endedAt: new Date().toISOString(), outcome: 'failed', details: String(error) }, context);
      new Notice(`Task Manager: Microsoft To Do sync failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  private syncCalDAV(): Promise<void> { return this.runProviderSync('caldav', () => this.performCalDAVSync()); }
  private async performCalDAVSync(): Promise<void> {
    const generation = this.ensureLifecycleGeneration();
    if (!this.isLifecycleGenerationActive(generation)) return;
    const controller = this.networkAbortController ??= new AbortController();
    const isCurrent = (): boolean => this.isLifecycleGenerationActive(generation) && this.networkAbortController === controller && !controller.signal.aborted;
    const startedAt = new Date().toISOString();
    if (!this.settings.caldavSyncEnabled) {
      new Notice('Task Manager: CalDAV sync is disabled.');
      return;
    }
    const serverUrl = this.settings.caldavServerUrl.trim();
    if (!serverUrl || !this.settings.caldavUsername.trim() || !this.settings.caldavPassword.trim()) {
      new Notice('Task Manager: CalDAV sync is not configured. Add a server URL, username, and password in settings.');
      return;
    }
    const calendarPath = this.settings.caldavCalendarPath.trim() || '/calendar.ics/';
    let vaultPath: string;
    try {
      vaultPath = normalizeVaultRelativePath(this.settings.caldavVaultPath.trim() || 'CalDAV Sync.md', 'CalDAV vault path');
    } catch (error) {
      new Notice(`Task Manager: CalDAV sync failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const conflictDirection = this.settings.syncConflictDirection === 'service-first' ? 'service-first' : 'vault-first';
    let indexedTasks: ParsedTask[];
    try {
      indexedTasks = await this.requireHealthyIndexedTasks('CalDAV sync');
    } catch (error) {
      if (!isCurrent()) return;
      const details = error instanceof Error ? error.message : String(error);
      this.recordSyncRun({ service: 'CalDAV', startedAt, endedAt: new Date().toISOString(), outcome: 'failed', details });
      new Notice(`Task Manager: CalDAV sync refused — ${details}`);
      return;
    }
    if (!isCurrent()) return;
    let client: CalDAVClient;
    try {
      client = new CalDAVClient(serverUrl, this.settings.caldavUsername.trim(), this.settings.caldavPassword.trim(), undefined, this.settings.caldavAllowPrivateNetwork, controller.signal);
    } catch (error) {
      new Notice(`Task Manager: CalDAV sync failed: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    const result = await syncTasksWithCalDAV(this.app, client, indexedTasks, calendarPath, vaultPath, conflictDirection, undefined, { signal: controller.signal, isCurrent });
    if (!isCurrent() || result.status === 'cancelled') return;
    const endedAt = new Date().toISOString();
    if (result.status === 'success') {
      const previousLastSuccess = this.settings.syncLastSuccessCalDAV;
      this.settings.syncLastSuccessCalDAV = endedAt;
      const settingsCommitted = await this.saveSettings(isCurrent);
      if (settingsCommitted === false || !isCurrent()) { this.settings.syncLastSuccessCalDAV = previousLastSuccess; return; }
      this.recordSyncRun({ service: 'CalDAV', startedAt, endedAt, outcome: 'success', details: `uploaded=${result.uploaded} skipped=0 fetched=${result.fetched} remoteChanged=${result.remoteChanged}`, imported: result.fetched });
      new Notice(`Task Manager: CalDAV sync complete. ${result.uploaded} task(s) reconciled, ${result.fetched} event(s) fetched.`);
      return;
    }
    if (result.status === 'partial') {
      const details = result.reason === 'skipped'
        ? `uploaded=${result.uploaded} skipped=${result.skipped} fetched=${result.fetched}; durable task IDs are required for outbound sync`
        : `uploaded=${result.uploaded} skipped=${result.skipped} fetched=${result.fetched} stage=${result.reason} error=${result.error?.message ?? 'sync write failed'}`;
      this.recordSyncRun({ service: 'CalDAV', startedAt, endedAt, outcome: 'partial', details, imported: result.fetched, failed: result.reason !== 'skipped' ? 1 : result.skipped });
      new Notice(result.reason === 'skipped'
        ? `Task Manager: CalDAV sync partially complete. ${result.skipped} task(s) skipped because outbound sync requires an explicit task ID.`
        : `Task Manager: CalDAV sync partially completed; a write or verification failed: ${result.error?.message ?? 'unknown error'}`);
      return;
    }
    if (result.status === 'conflict') {
      this.recordSyncRun({ service: 'CalDAV', startedAt, endedAt, outcome: 'failed', details: `conflict HTTP ${result.statusCode}; skipped=${result.skipped}; no overwrite performed`, conflicts: 1 });
      new Notice(`Task Manager: CalDAV sync conflict (HTTP ${result.statusCode}). Remote changes were preserved; review and retry.`);
      return;
    }
    if (result.status === 'not-found') {
      this.recordSyncRun({ service: 'CalDAV', startedAt, endedAt, outcome: 'failed', details: `calendar not found; skipped=${result.skipped}; no durably identified local tasks available for safe creation` });
      new Notice(`Task Manager: CalDAV calendar was not found; nothing was changed. ${result.skipped} task(s) lacked explicit IDs.`);
      return;
    }
    this.recordSyncRun({ service: 'CalDAV', startedAt, endedAt, outcome: 'failed', details: `skipped=${result.skipped}; ${result.error.message}`, failed: 1 });
    new Notice(`Task Manager: CalDAV sync failed: ${result.error.message}`);
  }

  // ── #6: Sync conflict report ────────────────────────────────────────────

  private enqueueSyncStatePersistence<T>(operation: () => Promise<T>): Promise<T> {
    const pending = (this.syncStatePersistenceQueue ?? Promise.resolve()).then(operation);
    this.syncStatePersistenceQueue = pending.then(() => undefined, () => undefined);
    return pending;
  }

  private markSyncStateDirty(identity: boolean, queue: boolean): void {
    if (identity) this.identityStateRevision = (this.identityStateRevision ?? 0) + 1;
    if (queue) this.syncQueueRevision = (this.syncQueueRevision ?? 0) + 1;
  }

  /** Persist dirty identity and queue projections through their sole serialized owner. */
  private persistSyncState(shouldCommit: () => boolean = () => true): Promise<void> {
    return this.enqueueSyncStatePersistence(async () => {
      if (!shouldCommit()) return;
      const identityRevision = this.identityStateRevision ?? 0;
      const queueRevision = this.syncQueueRevision ?? 0;
      const writeIdentity = identityRevision > (this.persistedIdentityStateRevision ?? 0);
      const writeQueue = queueRevision > (this.persistedSyncQueueRevision ?? 0);
      if (!writeIdentity && !writeQueue) return;
      if (typeof this.stateStore.updateState !== 'function') {
        if (shouldCommit()) await this.persistState();
        return;
      }
      const identityState = writeIdentity ? this.identityMapper?.getState() : undefined;
      const syncQueueState = writeQueue ? this.syncOperationQueue?.getState() : undefined;
      await this.stateStore.updateState((current) => ({
        ...current,
        identityState: identityState ?? current.identityState,
        syncQueueState: syncQueueState ?? current.syncQueueState,
      }), { shouldCommit });
      if (!shouldCommit()) return;
      if (writeIdentity) this.persistedIdentityStateRevision = Math.max(this.persistedIdentityStateRevision ?? 0, identityRevision);
      if (writeQueue) this.persistedSyncQueueRevision = Math.max(this.persistedSyncQueueRevision ?? 0, queueRevision);
    });
  }

  private async applySyncQueueReviewAction(action: SyncQueueReviewAction): Promise<SyncQueueReviewActionResult> {
    await this.persistSyncState();
    return this.enqueueSyncStatePersistence(async () => {
      let result: SyncQueueReviewActionResult | undefined;
      const committed = await syncStateRepository(this.stateStore).update((current) => {
        result = applySyncQueueReviewActions(current.syncQueueState ?? emptyOperationQueueState(), action);
        return { ...current, syncQueueState: result.state };
      });
      if (!result) throw new Error('Sync queue action did not produce a result');
      this.syncOperationQueue = new SyncOperationQueue(committed.syncQueueState);
      this.syncQueueRevision = (this.syncQueueRevision ?? 0) + 1;
      this.persistedSyncQueueRevision = this.syncQueueRevision;
      return result;
    });
  }

  private async openSyncConflictReport(): Promise<void> {
    const state = await this.stateStore.loadState();
    const getCurrentQueueState = () => this.syncOperationQueue?.getState() ?? state.syncQueueState ?? emptyOperationQueueState();
    const applyQueueAction = (action: SyncQueueReviewAction): Promise<SyncQueueReviewActionResult> => this.applySyncQueueReviewAction(action);

    new SyncConflictReportModal(this.app, {
      getQueueState: getCurrentQueueState,
      onApplyQueueAction: applyQueueAction,
      strategy: this.settings.syncConflictDirection === 'service-first' ? 'service-first' : 'vault-first',
    }).open();
  }

  private recordSyncRun(summary: SyncRunSummary, context?: ProviderRunContext): void {
    assertProviderRunCurrent(context);
    this.settings.syncRunHistory = [summary, ...(this.settings.syncRunHistory ?? [])].slice(0, 20);
  }

  private async appendSyncConflictReport(serviceName: string, conflictLines: string[], context?: ProviderRunContext): Promise<void> {
    assertProviderRunCurrent(context);
    if (!conflictLines.length) return;
    const reportPath = normalizeVaultRelativePath((this.settings.syncConflictLogPath || 'Sync Conflicts.md').trim(), 'Sync conflict log path');
    const timestamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
    const section = [
      `\n## ${serviceName} conflicts — ${timestamp}`,
      '',
      ...conflictLines,
      '',
    ].join('\n');
    const existing = this.app.vault.getAbstractFileByPath(reportPath);
    if (existing instanceof TFile) {
      await this.app.vault.process(existing, (c) => context && !context.isCurrent() ? c : c + section);
      assertProviderRunCurrent(context);
    } else {
      assertProviderRunCurrent(context);
      await this.app.vault.create(reportPath, `# Sync Conflicts\n${section}`);
      assertProviderRunCurrent(context);
    }
  }

  // ── #17: Daily stats summary ────────────────────────────────────────────────────────────
  private async appendDailyStatsSummary(): Promise<void> {
    if (!this.settings.dailyStatsSummaryEnabled) {
      new Notice('Task Manager: Enable “Append daily statistics summary” in settings first.');
      return;
    }
    const today = formatLocalDate(new Date());
    const allTasks = this.apiV1.getAllTasks();
    const completedToday = allTasks
      .filter((t) => t.status === 'done' && t.metadata.dates.done === today)
      .map((t) => ({ text: t.normalizedText, priority: t.metadata.priority }));
    const { file: dailyNote } = await this.dailyNoteResolver.resolveToday();
    await this.logWriter.appendDailyStatsSummary(dailyNote, completedToday);
    new Notice(`Task Manager: Appended stats summary (${completedToday.length} tasks).`);
  }

  private ensureEditableRecurrenceSeriesId(task: EditableTaskLine, filePath: string, lineNumber: number): string {
    const existing = task.recurrenceSeriesId?.trim() || task.id?.trim();
    if (existing) return existing;
    const generated = generateRecurrenceSeriesId(filePath, lineNumber, task.description || 'recurring-task');
    task.recurrenceSeriesId = generated;
    return generated;
  }

  private currentEditableOccurrenceDate(task: EditableTaskLine): string | null {
    return task.due || task.scheduled || task.start || null;
  }

  private nextEditableOccurrenceDate(rawLine: string, doneCheckbox: string): string | null {
    return calculateFirstRecurrenceDateForCompletedLine(rawLine, doneCheckbox, this.settings.supportedStates, this.settings, todayDateString());
  }

  private recurrenceExceptionFilterForLine(state: PersistedState, rawLine: string, filePath: string, lineNumber: number): ((nextLine: string) => boolean) | undefined {
    if (!filePath) return undefined;
    const currentTask = this.scanner.parseTaskLine(rawLine, filePath, lineNumber);
    const currentSeriesId = currentTask
      ? currentTask.metadata.recurrenceSeriesId || currentTask.metadata.id || currentTask.key
      : '';
    return (nextLine: string) => {
      const nextTask = this.scanner.parseTaskLine(nextLine, filePath, lineNumber);
      if (!nextTask) return true;
      const seriesId = nextTask.metadata.recurrenceSeriesId || currentSeriesId;
      const occurrenceDate = nextTask.metadata.dates.due ?? nextTask.metadata.dates.scheduled ?? nextTask.metadata.dates.start;
      if (!seriesId || !occurrenceDate) return true;
      return !this.stateStore.hasRecurrenceException(state, seriesId, occurrenceDate, ['skipped', 'deleted']);
    };
  }

  private shouldFilterEditorRecurrenceExceptions(line: string, filePath: string): boolean {
    if (!filePath) return false;
    const parsed = parseEditableTaskLine(line);
    return Boolean(parsed.checkbox && parsed.recurrence);
  }

  private async rewriteEditorTaskLineForStatusWithLifecycle(line: string, checkbox: string, filePath: string, lineNumber: number): Promise<string[] | null> {
    const state = await this.stateStore.loadState();
    const exceptionFilter = this.recurrenceExceptionFilterForLine(state, line, filePath, lineNumber);
    const duplicateFilter = await this.existingRecurrenceLineFilter(filePath);
    return rewriteTaskLineForStatusWithLifecycle(
      line,
      checkbox,
      this.settings,
      (nextLine) => (exceptionFilter?.(nextLine) ?? true) && duplicateFilter(nextLine),
    );
  }

  private async existingRecurrenceLineFilter(filePath: string): Promise<(nextLine: string) => boolean> {
    const file = this.app.vault.getAbstractFileByPath(filePath);
    if (!(file instanceof TFile)) return () => true;
    const content = await this.app.vault.read(file);
    const existingIdentities = new Set(splitContentLines(content).map((line) => sourceLineIdentity(line.text)));
    return (nextLine: string) => {
      const identity = sourceLineIdentity(nextLine);
      if (existingIdentities.has(identity)) return false;
      existingIdentities.add(identity);
      return true;
    };
  }

  // ── #7: Missed reminder log (mobile-safe) ────────────────────────────────────

  private async logMissedReminderToDaily(taskText: string, reminderTime: string): Promise<void> {
    try {
      const { file: dailyNote } = await this.dailyNoteResolver.resolveToday();
      const heading = '## Missed Reminders';
      const entry = `- \u23F0 ${reminderTime} — ${taskText}`;
      await this.app.vault.process(dailyNote, (content) => {
        if (content.includes(entry)) return content; // idempotent
        const headingIdx = content.indexOf(`\n${heading}`);
        if (headingIdx >= 0) {
          // Insert under the existing heading
          const insertAt = headingIdx + heading.length + 1;
          return content.slice(0, insertAt) + `\n${entry}` + content.slice(insertAt);
        }
        // Append a new section
        return content.endsWith('\n') ? `${content}${heading}\n${entry}\n` : `${content}\n\n${heading}\n${entry}\n`;
      });
    } catch (err) {
      console.warn('[task-manager] Failed to log missed reminder:', err);
    }
  }

  private reminderExpectation(reminderKey: string, expectedTaskText: string): { filePath: string; lineNumber: number; taskText: string; reminder: string } {
    const indexed = this.reminderIndex?.resolve(reminderKey);
    if (indexed?.task.metadata.reminder) {
      return { filePath: indexed.task.filePath, lineNumber: indexed.task.lineNumber, taskText: indexed.task.rawLine, reminder: indexed.task.metadata.reminder };
    }
    return parseReminderExpectation(reminderKey, expectedTaskText);
  }

  /** Show a snooze options modal for a reminder. */
  private showSnoozeOptions(reminderKey: string, expectedTaskText: string): void {
    const presets = this.reminderManager.getSnoozePresets();
    const menu = new Menu();

    for (const preset of presets) {
      menu.addItem((item) => {
        item.setTitle(preset.label);
        item.onClick(async () => {
          try {
            const expected = this.reminderExpectation(reminderKey, expectedTaskText);
            await this.stateStore.updateState((state) => this.reminderManager.snoozeReminder(state, {
              reminderKey,
              taskFilePath: expected.filePath,
              taskLineNumber: expected.lineNumber,
              taskText: expected.taskText,
              originalReminderTime: expected.reminder,
            }, preset.minutes));
            new Notice(`Reminder snoozed for ${preset.label}`);
          } catch (error) {
            new Notice(`Task Manager: ${error instanceof Error ? error.message : String(error)}`);
          }
        });
      });
    }

    menu.showAtPosition({ x: Math.floor(window.innerWidth / 2), y: Math.floor(window.innerHeight / 2) });
  }

  private async markReminderTaskDone(reminderKey: string, expectedTaskText: string): Promise<void> {
    try {
      const expected = this.reminderExpectation(reminderKey, expectedTaskText);
      const file = this.app.vault.getAbstractFileByPath(expected.filePath);
      if (!(file instanceof TFile)) throw new Error(`Reminder source file ${expected.filePath} was not found`);
      const content = await this.app.vault.read(file);
      const task = resolveReminderTaskForCompletion(content, expected, this.scanner);
      const doneSymbol = this.settings.supportedStates.find((taskState) => taskState.type === 'done')?.rawText ?? 'x';
      await this.taskMutations.updateTaskCheckbox(file, task, doneSymbol);
      new Notice('Task Manager: task marked done.');
    } catch (error) {
      new Notice(`Task Manager: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** Show missed reminders notice on startup if there are any. */
  private async showMissedRemindersNotice(): Promise<void> {
    const state = await this.stateStore.loadState();
    const unacknowledged = this.reminderManager.getUnacknowledgedMissedReminders(state);

    if (unacknowledged.length === 0) return;

    // Create a persistent notice with the missed reminders list so actions remain available.
    const notice = new Notice('', 0);
    const div = notice.noticeEl;
    div.empty();
    div.addClass('task-manager-missed-reminders-notice');

    const header = div.createEl('div', { cls: 'task-manager-missed-reminders-header' });
    header.createEl('strong', { text: `${unacknowledged.length} Missed Reminder${unacknowledged.length > 1 ? 's' : ''}` });

    const list = div.createEl('ul', { cls: 'task-manager-missed-reminders-list' });
    for (const reminder of unacknowledged.slice(0, 5)) {
      const item = list.createEl('li');
      item.createEl('span', { text: `${reminder.reminderTime}: ${reminder.taskText}` });
    }

    if (unacknowledged.length > 5) {
      list.createEl('li', { text: `... and ${unacknowledged.length - 5} more` });
    }

    const buttonsDiv = div.createEl('div', { cls: 'task-manager-missed-reminders-actions' });
    buttonsDiv.style.display = 'flex';
    buttonsDiv.style.gap = '8px';
    buttonsDiv.style.marginTop = '8px';

    const openFirstBtn = buttonsDiv.createEl('button', { text: 'Open First' });
    openFirstBtn.onclick = async () => {
      try {
        const first = unacknowledged[0];
        if (!first) return;
        const file = this.app.vault.getAbstractFileByPath(first.taskFilePath);
        if (file instanceof TFile) {
          await this.app.workspace.getLeaf(false).openFile(file);
          notice.hide();
        } else {
          new Notice(`Task Manager: reminder source not found: ${first.taskFilePath}`);
        }
      } catch (error) {
        new Notice(`Task Manager: failed to open reminder source: ${error instanceof Error ? error.message : String(error)}`);
        console.error('Task Manager: failed to open reminder source file', error);
      }
    };

    const acknowledgeBtn = buttonsDiv.createEl('button', { text: 'Acknowledge All' });
    acknowledgeBtn.onclick = async () => {
      await this.stateStore.updateState((current) => this.reminderManager.acknowledgeAllMissedReminders(current));
      notice.hide();
    };

    const dismissBtn = buttonsDiv.createEl('button', { text: 'Dismiss' });
    dismissBtn.onclick = () => {
      notice.hide();
    };
  }
  // ── #21: Datacore integration ────────────────────────────────────────────────────────────
  private registerWithDatacore(): void {
    try {
      const datacore = (this.app as unknown as { plugins?: { plugins?: Record<string, unknown> } })
        .plugins?.plugins?.['datacore'] as { api?: { registerDataProvider?: (p: unknown) => void } } | undefined;
      if (!datacore?.api?.registerDataProvider) {
        return;
      }
      datacore.api.registerDataProvider({
        id: 'task-manager',
        name: 'Task Manager',
        version: '1.0.0',
        getAllTasks: () => this.apiV1.getAllTasks(),
        getTasksForFile: (path: string) => this.apiV1.getTasksForFile(path),
      });
    } catch (err) {
      console.warn('Task Manager: Failed to register with Datacore:', err);
    }
  }
  private async registerWithDatacoreWhenReady(): Promise<void> { await this.getTaskIndex().whenReady(); this.registerWithDatacore(); }

  /** Move the full task block at the given line through the journaled move service. */
  private openMoveTaskModal(
    taskLine: string,
    lineIndex: number,
    editor: import('obsidian').Editor,
    sourcePath: string,
  ): void {
    const modal = new Modal(this.app);
    modal.titleEl.setText('Move task to…');
    const { contentEl } = modal;

    let targetPath = '';
    let targetHeading = '';

    new Setting(contentEl)
      .setName('Target note')
      .setDesc('Path of the note to move this task to (e.g. Projects/Work.md).')
      .addText((t) => t.setPlaceholder('Notes/Tasks.md').onChange((v) => { targetPath = v.trim(); }));

    new Setting(contentEl)
      .setName('Under heading (optional)')
      .setDesc('Append under this heading in the target note. Leave blank to append at the end.')
      .addText((t) => t.setPlaceholder('## Inbox').onChange((v) => { targetHeading = v.trim(); }));

    new Setting(contentEl)
      .addButton((btn) => btn.setButtonText('Cancel').onClick(() => modal.close()))
      .addButton((btn) => btn.setCta().setButtonText('Move').onClick(async () => {
        if (!targetPath) { new Notice('Please specify a target note path'); return; }
        const rawPath = targetPath.endsWith('.md') ? targetPath : `${targetPath}.md`;
        try {
          await this.moveTaskLineToTarget(taskLine, lineIndex, editor, sourcePath, rawPath, targetHeading);
          modal.close();
        } catch (error) {
          new Notice(`Task move failed: ${error instanceof Error ? error.message : String(error)}`);
        }
      }));

    modal.open();
  }

  private async moveTaskLineToTarget(
    taskLine: string,
    lineIndex: number,
    editor: import('obsidian').Editor,
    sourcePath: string,
    rawPath: string,
    targetHeading: string,
  ): Promise<void> {
    let result: { targetPath: string } | undefined;
    try {
      result = await this.taskMoves.move({
        editor,
        sourcePath,
        targetPath: rawPath,
        sourceLine: lineIndex,
        targetHeading,
        expectedTaskLine: taskLine,
      });
    } finally {
      if (sourcePath) this.queryRenderer.invalidateCache(sourcePath);
      this.queryRenderer.invalidateCache(result?.targetPath ?? rawPath);
    }
    new Notice(`Task block moved to ${result.targetPath}`);
  }

  /**
   * Generate a completion rollup note summarising completed tasks from
   * daily note log entries over the past week or month.
   */
  private async generateCompletionSummary(period: 'week' | 'month'): Promise<void> {
    const days = period === 'week' ? 7 : 30;
    const today = todayDateString();
    const startDate = addDate(today, 'day', -(days - 1));
    const heading = this.settings.logSectionHeading;
    const logHeadingLine = `## ${heading}`;

    const entries: string[] = [];
    for (let offset = days - 1; offset >= 0; offset--) {
      const dateStr = addDate(today, 'day', -offset);
      const dailyPath = this.dailyNoteResolver.resolvePathForDate(dateStr);
      const file = this.app.vault.getAbstractFileByPath(dailyPath);
      if (!file || !('extension' in file)) continue;
      try {
        const content = await this.app.vault.cachedRead(file as import('obsidian').TFile);
        const lines = content.split(/\r?\n/u);
        let inLog = false;
        for (const line of lines) {
          if (line.trim() === logHeadingLine || line.trim() === logHeadingLine.replace('## ', '# ')) { inLog = true; continue; }
          if (inLog && /^#{1,6}\s/u.test(line)) { inLog = false; }
          if (inLog && line.trim().startsWith('-')) entries.push(`${dateStr}: ${line.trim().slice(2)}`);
        }
      } catch { /* skip unreadable files */ }
    }

    const periodLabel = period === 'week' ? 'Weekly' : 'Monthly';
    const summaryPath = `${periodLabel} Summary ${today}.md`;

    // ── Enhanced analytics for weekly summaries ────────────────────────────
    let analyticsSection = '';
    if (period === 'week') {
      try {
        const { generateWeeklySummaryMarkdown } = await import('./metrics-aggregator');
        await this.getTaskIndex().whenReady();
        const allTasks = this.getTaskIndex().getAllTasks();
        analyticsSection = generateWeeklySummaryMarkdown(
          allTasks,
          startDate,
          today,
          this.settings.dailyCapacityMinutes ?? 0,
        );
      } catch (err) {
        analyticsSection = `_Analytics unavailable: ${err instanceof Error ? err.message : String(err)}_`;
      }
    }

    const content = [
      `# ${periodLabel} Completion Summary`,
      `Period: ${startDate} – ${today}`,
      `Total completed: ${entries.length}`,
      '',
      ...(analyticsSection ? [analyticsSection, ''] : []),
      '## Completed Tasks (from logs)',
      ...entries.map((e) => `- ${e}`),
    ].join('\n');

    const existingFile = this.app.vault.getAbstractFileByPath(summaryPath);
    if (existingFile && 'extension' in existingFile) {
      await this.app.vault.modify(existingFile as import('obsidian').TFile, content);
    } else {
      await this.app.vault.create(summaryPath, content);
    }
    const summaryFile = this.app.vault.getAbstractFileByPath(summaryPath);
    if (summaryFile && 'extension' in summaryFile) {
      await this.app.workspace.getLeaf().openFile(summaryFile as import('obsidian').TFile);
    }
    new Notice(`${periodLabel} summary created: ${entries.length} tasks`);
  }

  private queueRescan(file: TAbstractFile): void {
    const generation = this.ensureLifecycleGeneration();
    if (!this.isLifecycleGenerationActive(generation)) return;
    if (!(file instanceof TFile) || !isIndexableTaskFile(file, this.settings?.excludedFolders ?? [])) return;
    this.queryRenderer?.invalidateCache(file.path);
    if (!this.settings.enableFileEvents) return;

    this.bumpPathScanEpoch(file.path);
    this.pendingFileScans.add(file.path);
    if (this.fileScanTimer !== null) window.clearTimeout(this.fileScanTimer);
    this.fileScanTimer = window.setTimeout(() => {
      this.fileScanTimer = null;
      void this.drainQueuedFileScans();
    }, 500);
  }

  private async drainQueuedFileScans(): Promise<void> {
    const generation = this.ensureLifecycleGeneration();
    if (!this.isLifecycleGenerationActive(generation)) return;
    if (this.fileScanRunning && this.fileScanRunGeneration === generation) return;
    this.fileScanRunning = true;
    this.fileScanRunGeneration = generation;
    try {
      while (this.pendingFileScans.size > 0) {
        const paths = [...this.pendingFileScans];
        this.pendingFileScans.clear();
        const replacements = new Map<string, ParsedTask[]>();
        const fingerprints = new Map<string, string>();
        const files: TFile[] = [];
        const evidence = new Map<string, { epoch: number; mtime: number; size: number }>();
        for (const path of paths) {
          const current = this.app.vault.getAbstractFileByPath(path);
          if (current instanceof TFile && isIndexableTaskFile(current, this.settings?.excludedFolders ?? [])) {
            files.push(current);
            evidence.set(path, this.scanEvidenceFor(current, false));
          }
        }

        const concurrency = Platform.isMobile ? 2 : 8;
        for (let index = 0; index < files.length; index += concurrency) {
          const batch = files.slice(index, index + concurrency);
          const results = await Promise.allSettled(batch.map((file) => this.captureTasksForFile(file)));
          if (!this.isLifecycleGenerationActive(generation)) return;
          for (let resultIndex = 0; resultIndex < results.length; resultIndex += 1) {
            const result = results[resultIndex];
            const file = batch[resultIndex];
            if (!file) continue;
            if (result?.status === 'fulfilled') {
              replacements.set(file.path, result.value.tasks);
              fingerprints.set(file.path, result.value.hash);
            } else {
              this.scanErrors.push({ file: file.path, message: String(result?.reason ?? 'Scan failed') });
            }
          }
        }

        if (!this.isLifecycleGenerationActive(generation)) return;
        await this.withScanPublicationLock(async () => {
          if (!this.isLifecycleGenerationActive(generation)) return;
          const accepted = this.currentScanReplacements(replacements, evidence);
          if (accepted.size === 0) return;
          const previousSnapshot = this.priorSnapshotForScanWave(accepted);
          const indexBefore = this.captureIndexPaths(accepted.keys());
          const indexChange = this.getTaskIndex().commit(accepted);
          if (this.getTaskIndex().isReady()) {
            await this.migrateHydratedExplicitIdentityState(
              generation,
              () => this.currentScanReplacements(accepted, evidence).size === accepted.size,
            );
            if (!this.isLifecycleGenerationActive(generation)) return;
          }
          const currentForEffects = this.currentScanReplacements(accepted, evidence);
          this.rollbackStaleIndexPaths(accepted, currentForEffects, indexBefore);
          if (currentForEffects.size === 0) return;
          const effectsVersion = this.scanRequestCounter;
          // Every accepted path was fully checked above. Any later vault request
          // increments the global epoch and cancels the whole effect batch in O(1).
          const effectsAreCurrent = () => this.scanRequestCounter === effectsVersion;
          const reconciled = await this.applyScannedTaskWave(currentForEffects, generation, previousSnapshot, effectsAreCurrent);
          if (!this.isLifecycleGenerationActive(generation)) return;
          if (!reconciled) {
            const currentAfterEffects = this.currentScanReplacements(accepted, evidence);
            this.rollbackStaleIndexPaths(accepted, currentAfterEffects, indexBefore);
            for (const path of currentAfterEffects.keys()) this.enqueuePathForRescan(path);
            return;
          }
          const updates = [...currentForEffects.keys()].flatMap((path) => {
            const captured = evidence.get(path);
            const hash = fingerprints.get(path);
            return captured && hash !== undefined
              ? [{ path, hash, stat: { mtime: captured.mtime, size: captured.size } }]
              : [];
          });
          if (updates.length > 0) {
            const isFingerprintCurrent = (path: string): boolean => {
              const captured = evidence.get(path);
              return Boolean(captured && this.isPathScanEvidenceCurrent(path, captured));
            };
            let committingPaths: string[] | null = null;
            await this.stateStore.updateState(
              (current) => {
                const currentUpdates = updates.filter((update) => isFingerprintCurrent(update.path));
                committingPaths = currentUpdates.map((update) => update.path);
                return this.applyFileHashUpdates(current, currentUpdates);
              },
              {
                shouldCommit: () => this.isLifecycleGenerationActive(generation)
                  && (committingPaths === null
                    ? updates.some((update) => isFingerprintCurrent(update.path))
                    : committingPaths.every(isFingerprintCurrent)),
              },
            );
            if (!this.isLifecycleGenerationActive(generation)) return;
            const currentAfterFingerprint = this.currentScanReplacements(currentForEffects, evidence);
            this.rollbackStaleIndexPaths(accepted, currentAfterFingerprint, indexBefore);
            if (currentAfterFingerprint.size === 0) return;
            await this.persistState(generation);
            if (!this.isLifecycleGenerationActive(generation)) return;
          }
          if (indexChange) this.notifyTaskIndexConsumers(indexChange);
        });
      }
    } finally {
      if (this.fileScanRunGeneration === generation) {
        this.fileScanRunning = false;
        this.fileScanRunGeneration = null;
        if (this.isLifecycleGenerationActive(generation) && this.pendingFileScans.size > 0 && this.fileScanTimer === null) {
          this.fileScanTimer = window.setTimeout(() => {
            this.fileScanTimer = null;
            void this.drainQueuedFileScans();
          }, 0);
        }
      }
    }
  }

  private notifyTaskIndexConsumers(change?: TaskIndexChange): void {
    const allTasks = this.getTaskIndex().getAllTasks();
    const changedPaths = change ? [...change.changedPaths, ...change.removedPaths] : [];
    if (changedPaths.length > 0) this.queryRenderer?.invalidateChangedFiles?.(changedPaths);
    else this.queryRenderer?.invalidateCache?.();
    this.queryRenderer?.refreshAllVisible?.();
    for (const handler of this.cacheUpdateHandlers ?? []) {
      try { handler(allTasks); } catch { /* ignore external subscriber errors */ }
    }
    this.scheduleBasesAutoRefresh(allTasks);
    this.updateStatusBarWidget();
    const workspace = this.app?.workspace;
    if (!workspace) return;
    for (const leaf of workspace.getLeavesOfType(VIEW_TYPE_TASK_PANEL)) {
      const view = leaf.view;
      if (view instanceof TaskPanelView) void view.refresh();
    }
    for (const leaf of workspace.getLeavesOfType(VIEW_TYPE_DASHBOARD)) {
      const view = leaf.view;
      if (view instanceof DashboardView) view.requestIndexRefresh(this.getTaskIndex().getSnapshot().revision);
    }
  }

  private retainFileHashesForPaths(current: PersistedState, currentPaths: ReadonlySet<string>): PersistedState {
    const store = this.stateStore as StateStore & { retainFileHashesForPaths?: StateStore['retainFileHashesForPaths'] };
    if (typeof store.retainFileHashesForPaths === 'function') return store.retainFileHashesForPaths(current, currentPaths);
    if (!current.fileHashes) return current;
    const retained = Object.fromEntries(Object.entries(current.fileHashes).filter(([path]) => currentPaths.has(path)));
    return Object.keys(retained).length === Object.keys(current.fileHashes).length ? current : { ...current, fileHashes: retained };
  }

  private applyFileHashUpdates(
    current: PersistedState,
    updates: ReadonlyArray<{ path: string; hash?: string; content?: string; stat?: { mtime?: number; size?: number } }>,
  ): PersistedState {
    const store = this.stateStore as StateStore & {
      setFileHashes?: StateStore['setFileHashes'];
      setFileHash?: StateStore['setFileHash'];
    };
    if (typeof store.setFileHashes === 'function') return store.setFileHashes(current, updates);
    let next = current;
    for (const update of updates) {
      if (update.content !== undefined && typeof store.setFileHash === 'function') {
        next = store.setFileHash(next, update.path, update.content, update.stat);
      }
    }
    return next;
  }

  private handleDelete(file: TAbstractFile): void {
    if (!(file instanceof TFile) && !(file instanceof TFolder)) {
      return;
    }

    this.queryRenderer?.invalidateCache();
    const deletedPath = file.path;
    this.invalidateScanPathPrefix(deletedPath);
    this.getTaskIndex().removePath(deletedPath);
    if (this.pendingFileScans instanceof Set) {
      for (const path of [...this.pendingFileScans]) {
        if (path === deletedPath || path.startsWith(`${deletedPath}/`)) this.pendingFileScans.delete(path);
      }
    }
    (this.pendingRemovedIndexPaths ??= new Set()).add(deletedPath);
    for (const [key, entry] of this.snapshot) {
      if (entry.filePath === deletedPath || entry.filePath.startsWith(`${deletedPath}/`)) {
        this.deleteSnapshotEntry(key);
      }
    }
    void this.persistState();
    this.notifyTaskIndexConsumers();
  }

  private handleRename(file: TAbstractFile, oldPath: string): void {
    if (!(file instanceof TFile) && !(file instanceof TFolder)) {
      return;
    }

    this.queryRenderer?.invalidateCache();
    this.invalidateScanPathPrefix(oldPath);
    this.invalidateScanPathPrefix(file.path);
    this.getTaskIndex().removePath(oldPath);
    (this.pendingRemovedIndexPaths ??= new Set()).add(oldPath);
    if (this.pendingFileScans instanceof Set) {
      for (const path of [...this.pendingFileScans]) {
        if (path === oldPath || path.startsWith(`${oldPath}/`)) this.pendingFileScans.delete(path);
      }
    }
    const renamedEntries: TaskSnapshotEntry[] = [];
    for (const [key, entry] of this.snapshot) {
      if (entry.filePath !== oldPath && !entry.filePath.startsWith(`${oldPath}/`)) {
        continue;
      }

      this.deleteSnapshotEntry(key);
      const newFilePath = entry.filePath === oldPath ? file.path : `${file.path}/${entry.filePath.slice(oldPath.length + 1)}`;
      if (!isIndexableTaskPath(newFilePath, undefined, this.settings?.excludedFolders ?? [])) continue;
      const renamedKey = key.startsWith(`${entry.filePath}:`) ? `${newFilePath}:${key.slice(entry.filePath.length + 1)}` : key;
      renamedEntries.push({ ...entry, key: renamedKey, filePath: newFilePath });
    }

    for (const entry of renamedEntries) this.setSnapshotEntry(entry);

    if (this.identityMapper && (!(file instanceof TFile) || isIndexableTaskFile(file, this.settings?.excludedFolders ?? []))) {
      this.migrateSyncIdentitiesForRename(oldPath, file.path);
      this.markSyncStateDirty(true, false);
    }
    void this.persistState();
    if (this.app?.vault) {
      if (file instanceof TFile) {
        this.queueRescan(file);
      } else {
        for (const candidate of this.getIndexableFiles()) {
          if (candidate.path.startsWith(`${file.path}/`)) this.queueRescan(candidate);
        }
      }
    }
    this.notifyTaskIndexConsumers();
  }

  private migrateSyncIdentitiesForRename(oldPath: string, newPath: string): void {
    if (!this.identityMapper) return;
    for (const identity of this.identityMapper.getState().identities) {
      const oldVaultKey = identity.vaultKey;
      if (oldVaultKey === oldPath || oldVaultKey.startsWith(`${oldPath}:`)) {
        this.identityMapper.migrateIdentity(oldVaultKey, `${newPath}${oldVaultKey.slice(oldPath.length)}`);
      } else if (oldVaultKey.startsWith(`${oldPath}/`)) {
        this.identityMapper.migrateIdentity(oldVaultKey, `${newPath}/${oldVaultKey.slice(oldPath.length + 1)}`);
      }
    }
  }

  private async scanVault(showNotice = true, force = showNotice): Promise<void> {
    const generation = this.ensureLifecycleGeneration();
    if (!this.isLifecycleGenerationActive(generation)) return;
    if (this.fullScanPromise) {
      await this.fullScanPromise;
      if (force && this.isLifecycleGenerationActive(generation)) await this.scanVault(showNotice, true);
      return;
    }
    const scan = this.performScanVault(showNotice, force, generation);
    this.fullScanPromise = scan;
    try {
      await scan;
    } catch (error) {
      if (this.isLifecycleGenerationActive(generation)) this.getTaskIndex().markReady(true);
      if (!this.isLifecycleGenerationActive(generation)) return;
      throw error;
    } finally {
      if (this.fullScanPromise === scan) this.fullScanPromise = null;
    }
  }

  private async performScanVault(showNotice: boolean, force: boolean, generation: number): Promise<void> {
    if (!this.isLifecycleGenerationActive(generation)) return;
    this.queryRenderer?.invalidateCache();
    const indexWasReady = this.getTaskIndex().isReady();
    this.getTaskIndex().beginHydration();
    const scanStart = Date.now();
    this.lastScanStartedAt = new Date().toISOString();
    const files = this.getIndexableFiles();
    const currentPaths = new Set(files.map((file) => file.path));
    const fileEvidence = new Map(files.map((file) => [file.path, this.scanEvidenceFor(file, true)]));
    const removedCandidates = this.getTaskIndex().getPaths().filter((path) => !currentPaths.has(path));
    const removedEvidence = new Map(removedCandidates.map((path) => [path, this.bumpPathScanEpoch(path)]));
    const state = await this.stateStore.loadState();
    if (!this.isLifecycleGenerationActive(generation)) return;
    const collected = await collectVaultScanWork({
      files,
      force,
      state,
      readConcurrency: Platform.isMobile ? 4 : 16,
      parseConcurrency: Platform.isMobile ? 2 : 8,
      isActive: () => this.isLifecycleGenerationActive(generation),
      needsHydration: (path) => !this.getTaskIndex().hasFile(path),
      statMatches: (current, path, stat) => this.stateStore.fileStatMatches(current, path, stat),
      read: (file) => this.app.vault.read(file),
      contentChanged: (current, path, content) => this.stateStore.hasFileChanged(current, path, content),
      hash: (content) => this.stateStore.hash(content),
      parse: (file, content) => this.parseTasksForFile(file, content),
      isCurrent: (file) => {
        const evidence = fileEvidence.get(file.path);
        return Boolean(evidence && this.isPathScanEvidenceCurrent(file.path, evidence));
      },
    });
    if (collected.cancelled || !this.isLifecycleGenerationActive(generation)) return;
    const { replacements, fingerprintUpdates, errors, stalePaths } = collected;
    for (const path of stalePaths) this.enqueuePathForRescan(path);
    await this.withScanPublicationLock(async () => {
      if (!this.isLifecycleGenerationActive(generation)) return;
      const accepted = this.currentScanReplacements(replacements, fileEvidence);
      const acceptedFingerprints = fingerprintUpdates.filter((update) => {
        const captured = fileEvidence.get(update.path);
        const current = Boolean(captured && this.isPathScanEvidenceCurrent(update.path, captured));
        if (!current) this.enqueuePathForRescan(update.path);
        return current;
      });
      const removedPaths = removedCandidates.filter((path) => {
        const epoch = removedEvidence.get(path);
        if (epoch === undefined || this.currentPathScanEpoch(path) !== epoch) return false;
        const current = this.app.vault.getAbstractFileByPath(path);
        return !current || (current instanceof TFile && !isIndexableTaskFile(current, this.settings?.excludedFolders ?? []));
      });
      const previousSnapshot = this.priorSnapshotForScanWave(accepted);
      const indexBefore = this.captureIndexPaths(accepted.keys());
      for (const removedPath of removedPaths) {
        for (const key of [...(this.ensureSnapshotFileIndex().get(removedPath) ?? [])]) this.deleteSnapshotEntry(key, removedPath);
      }
      const indexChange = this.getTaskIndex().commit(accepted, removedPaths);
      if (errors.length === 0 && accepted.size > 0) {
        await this.migrateHydratedExplicitIdentityState(
          generation,
          () => this.currentScanReplacements(accepted, fileEvidence).size === accepted.size,
        );
        if (!this.isLifecycleGenerationActive(generation)) return;
      }
      const currentForEffects = this.currentScanReplacements(accepted, fileEvidence);
      this.rollbackStaleIndexPaths(accepted, currentForEffects, indexBefore);
      const effectsVersion = this.scanRequestCounter;
      const effectsAreCurrent = () => this.scanRequestCounter === effectsVersion;
      const reconciled = await this.applyScannedTaskWave(currentForEffects, generation, previousSnapshot, effectsAreCurrent);
      if (!this.isLifecycleGenerationActive(generation)) return;
      if (!reconciled) {
        const currentAfterEffects = this.currentScanReplacements(accepted, fileEvidence);
        this.rollbackStaleIndexPaths(accepted, currentAfterEffects, indexBefore);
        for (const path of currentAfterEffects.keys()) this.enqueuePathForRescan(path);
        this.getTaskIndex().markReady(true);
        return;
      }
      this.getTaskIndex().markReady(errors.length > 0);
      if (errors.length === 0) {
        await this.ensureReminderIndexReady();
        if (this.isLifecycleGenerationActive(generation)) {
          try {
            await this.checkDueReminders();
          } catch (error) {
            console.warn('[task-manager] Immediate reminder delivery check failed after successful task index hydration; delivery will retry on a later check:', error);
          }
        }
      }
      const hasObsoleteFingerprints = Object.keys(state.fileHashes ?? {}).some((path) => !currentPaths.has(path));
      if (acceptedFingerprints.length > 0 || removedPaths.length > 0 || hasObsoleteFingerprints) {
        const isFingerprintCurrent = (path: string): boolean => {
          const captured = fileEvidence.get(path);
          return Boolean(captured && this.isPathScanEvidenceCurrent(path, captured));
        };
        let committingPaths: string[] | null = null;
        await this.stateStore.updateState((current) => {
          const currentUpdates = acceptedFingerprints.filter((update) => isFingerprintCurrent(update.path));
          committingPaths = currentUpdates.map((update) => update.path);
          const withUpdates = this.applyFileHashUpdates(current, currentUpdates);
          return this.retainFileHashesForPaths(withUpdates, currentPaths);
        }, {
          shouldCommit: () => {
            if (!this.isLifecycleGenerationActive(generation)) return false;
            if (acceptedFingerprints.length === 0) return true;
            return committingPaths === null
              ? acceptedFingerprints.some((update) => isFingerprintCurrent(update.path))
              : committingPaths.every(isFingerprintCurrent);
          },
        });
        if (!this.isLifecycleGenerationActive(generation)) return;
        const currentAfterFingerprint = this.currentScanReplacements(accepted, fileEvidence);
        this.rollbackStaleIndexPaths(accepted, currentAfterFingerprint, indexBefore);
        if (accepted.size > 0 && currentAfterFingerprint.size === 0) return;
        await this.persistState(generation);
        if (!this.isLifecycleGenerationActive(generation)) return;
      }
      this.scanErrors = errors.slice(-50);
      this.lastScanDurationMs = Date.now() - scanStart;
      this.lastScanFileCount = accepted.size;
      if (showNotice) {
        new Notice(`Task Manager scanned ${accepted.size}/${files.length} file(s) (${files.length - accepted.size} unchanged)`);
      }
      if (indexChange || !indexWasReady) this.notifyTaskIndexConsumers(indexChange ?? undefined);
    });
    this.scheduleQueuedScanDrain();
  }

  private async captureTasksForFile(file: TFile): Promise<{ tasks: ParsedTask[]; hash: string }> {
    const content = await this.app.vault.read(file);
    return {
      tasks: await this.parseTasksForFile(file, content),
      hash: this.stateStore.hash(content),
    };
  }

  private async parseTasksForFile(file: TFile, content?: string): Promise<ParsedTask[]> {
    this.queryRenderer?.invalidateCache(file.path);
    if (file.extension === 'canvas') return content === undefined ? this.scanner.scanCanvasFile(file) : this.scanner.scanCanvasContent(file, content);
    if (isTaskNoteFile(file, this.app, this.settings.taskNoteFolders, this.settings.taskNoteMarker, content)) {
      const fileTask = scanFileAsTask(
        file,
        this.app,
        this.settings.supportedStates,
        this.settings.customFieldDefinitions,
        content,
      );
      return fileTask ? [fileTask] : [];
    }
    return content === undefined ? this.scanner.scanFile(file) : this.scanner.scanFileContent(file, content);
  }

  private async applyScannedTaskWave(
    replacements: ReadonlyMap<string, ParsedTask[]>,
    generation = this.ensureLifecycleGeneration(),
    previousSnapshot: ReadonlyMap<string, TaskSnapshotEntry> = new Map(this.snapshot),
    isCurrent: () => boolean = () => true,
  ): Promise<boolean> {
    if (!this.isLifecycleGenerationActive(generation) || !isCurrent()) return false;
    if (replacements.size === 0) return true;
    const completionRecordsByFile = this.completionsBySourceFile();
    const explicitIds = this.getTaskIndex().getExplicitIds();
    const lifecyclePrior = new Map(previousSnapshot);
    for (const [path, tasks] of replacements) {
      const uniquelyIdentified = tasks.filter((task) => {
        const id = task.metadata.id?.trim();
        return Boolean(id && explicitIds.resolve(id).kind === 'unique');
      });
      if (uniquelyIdentified.length > 0) {
        this.migrateDurableIdentityKeys(uniquelyIdentified, this.snapshotForFile(path), completionRecordsByFile.get(path));
      }
      // Hydration migration may have converted a path-coupled legacy key after
      // this wave captured its prior entries. Carry that migrated prior status
      // into the immutable comparison map without overlaying current scan state.
      for (const task of uniquelyIdentified) {
        const migratedPrior = this.snapshot.get(task.key);
        if (migratedPrior) lifecyclePrior.set(task.key, migratedPrior);
      }
    }
    const affectedPaths = new Set(replacements.keys());
    const currentTasks = [...replacements.values()].flat();
    const canonicalExplicitTasks = canonicalExplicitTasksForAffectedOwners({
      currentTasks,
      affectedPaths,
      previousSnapshot: lifecyclePrior,
      explicitIds,
      globalTasks: this.getTaskIndex().getAllTasks(),
    });
    const plan = planScanLifecycleReconciliation({
      currentTasks,
      canonicalExplicitTasks,
      affectedPaths,
      previousSnapshot: lifecyclePrior,
      explicitIds,
      isHabit: taskIsHabit,
    });

    const habitKeys = new Set<string>();
    for (const task of plan.habitCompletions) {
      if (!this.isLifecycleGenerationActive(generation) || !isCurrent()) return false;
      if (habitKeys.has(task.key)) continue;
      habitKeys.add(task.key);
      await this.recordHabitCompletionIfNeeded(task, generation, isCurrent);
      if (!this.isLifecycleGenerationActive(generation) || !isCurrent()) return false;
    }
    if (!this.isLifecycleGenerationActive(generation) || !isCurrent()) return false;
    await this.materializeCompletionTasks(plan.completions, generation, isCurrent);
    if (!this.isLifecycleGenerationActive(generation) || !isCurrent()) return false;
    if (!this.isLifecycleGenerationActive(generation) || !isCurrent()) return false;
    for (const change of plan.statusChanges) {
      for (const handler of this.statusChangeHandlers ?? []) {
        try { handler(change.task, change.previousStatus); } catch { /* external subscriber errors are isolated */ }
      }
    }
    if (!this.isLifecycleGenerationActive(generation) || !isCurrent()) return false;
    // Remove old owners first, guarded by their expected path, then overlay the
    // complete accepted wave. This makes path moves independent of file order.
    for (const removal of plan.removals) this.deleteSnapshotEntry(removal.key, removal.expectedFilePath);
    if (!isCurrent()) return false;
    for (const entry of plan.currentEntries) this.setSnapshotEntry(entry);
    return true;
  }

  private async scanFile(file: TFile, persistAfterScan = true, publishIndex = true): Promise<ParsedTask[]> {
    const generation = this.ensureLifecycleGeneration();
    if (!this.isLifecycleGenerationActive(generation) || !isIndexableTaskFile(file, this.settings?.excludedFolders ?? [])) return [];
    const evidence = this.scanEvidenceFor(file, true);
    const captured = await this.captureTasksForFile(file);
    const tasks = captured.tasks;
    if (!this.isLifecycleGenerationActive(generation)) return [];
    let published = false;
    await this.withScanPublicationLock(async () => {
      if (!this.isLifecycleGenerationActive(generation) || !this.isPathScanEvidenceCurrent(file.path, evidence)) {
        this.enqueuePathForRescan(file.path);
        return;
      }
      const replacements = new Map<string, ParsedTask[]>([[file.path, tasks]]);
      const previousSnapshot = this.priorSnapshotForScanWave(replacements);
      const indexBefore = this.captureIndexPaths(replacements.keys());
      let indexChange: TaskIndexChange | null = null;
      if (publishIndex) {
        indexChange = this.getTaskIndex().commit(replacements);
        if (this.getTaskIndex().isReady()) {
          await this.migrateHydratedExplicitIdentityState(generation, () => this.isPathScanEvidenceCurrent(file.path, evidence));
          if (!this.isLifecycleGenerationActive(generation) || !this.isPathScanEvidenceCurrent(file.path, evidence)) {
            this.rollbackStaleIndexPaths(replacements, new Map(), indexBefore);
            return;
          }
        }
      }
      if (!this.isPathScanEvidenceCurrent(file.path, evidence)) {
        if (publishIndex) this.rollbackStaleIndexPaths(replacements, new Map(), indexBefore);
        return;
      }
      const reconciled = await this.applyScannedTaskWave(
        replacements,
        generation,
        previousSnapshot,
        () => this.isPathScanEvidenceCurrent(file.path, evidence),
      );
      if (!reconciled || !this.isLifecycleGenerationActive(generation) || !this.isPathScanEvidenceCurrent(file.path, evidence)) {
        if (publishIndex && !this.isPathScanEvidenceCurrent(file.path, evidence)) this.rollbackStaleIndexPaths(replacements, new Map(), indexBefore);
        this.enqueuePathForRescan(file.path);
        return;
      }
      if (persistAfterScan) {
        await this.stateStore.updateState(
          (current) => this.stateStore.setFileHashes(current, [{
            path: file.path,
            hash: captured.hash,
            stat: { mtime: evidence.mtime, size: evidence.size },
          }]),
          { shouldCommit: () => this.isLifecycleGenerationActive(generation) && this.isPathScanEvidenceCurrent(file.path, evidence) },
        );
        if (!this.isLifecycleGenerationActive(generation) || !this.isPathScanEvidenceCurrent(file.path, evidence)) return;
        await this.persistState(generation);
        if (!this.isLifecycleGenerationActive(generation)) return;
        if (indexChange) this.notifyTaskIndexConsumers(indexChange);
      }
      published = true;
    });
    this.scheduleQueuedScanDrain();
    return published ? tasks : [];
  }

  private migrateDurableIdentityKeys(
    tasks: ParsedTask[],
    fileSnapshot?: ReadonlyMap<string, TaskSnapshotEntry>,
    completionRecords: readonly (typeof this.completions)[number][] = this.completions,
  ): void {
    const snapshotByFileAndBase = new Map<string, Map<string, TaskSnapshotEntry[]>>();
    for (const entry of fileSnapshot?.values() ?? this.snapshot.values()) {
      const byBase = snapshotByFileAndBase.get(entry.filePath) ?? new Map<string, TaskSnapshotEntry[]>();
      const base = entry.key.replace(/\u0000\d+$/u, '');
      const entries = byBase.get(base) ?? [];
      entries.push(entry);
      byBase.set(base, entries);
      snapshotByFileAndBase.set(entry.filePath, byBase);
    }
    const completionKeysByFileAndBase = new Map<string, Map<string, Set<string>>>();
    const completionRecordsByFileAndKey = new Map<string, Array<(typeof this.completions)[number]>>();
    for (const completion of completionRecords) {
      const byBase = completionKeysByFileAndBase.get(completion.sourcePath) ?? new Map<string, Set<string>>();
      const base = completion.taskKey.replace(/\u0000\d+$/u, '');
      const keys = byBase.get(base) ?? new Set<string>();
      keys.add(completion.taskKey);
      byBase.set(base, keys);
      completionKeysByFileAndBase.set(completion.sourcePath, byBase);
      const recordKey = `${completion.sourcePath}\u0000${completion.taskKey}`;
      const records = completionRecordsByFileAndKey.get(recordKey) ?? [];
      records.push(completion);
      completionRecordsByFileAndKey.set(recordKey, records);
    }

    for (const task of tasks) {
      if (!task.metadata.id || !task.stableKey) continue;
      const legacyBaseKeys = new Set<string>([
        legacyTaskKeyForBody(task.filePath, task.body),
        legacyExplicitTaskKey(task.filePath, task.metadata.id),
        `${task.filePath}:${task.filePath.split('/').pop()?.replace(/\.md$/u, '') ?? ''}`,
      ]);
      legacyBaseKeys.delete(task.key);
      const legacyKeys = new Set(legacyBaseKeys);
      const snapshotsByBase = snapshotByFileAndBase.get(task.filePath);
      const completionKeysByBase = completionKeysByFileAndBase.get(task.filePath);
      for (const base of legacyBaseKeys) {
        for (const entry of snapshotsByBase?.get(base) ?? []) {
          if (entry.lineNumber === task.lineNumber) legacyKeys.add(entry.key);
        }
        for (const completionKey of completionKeysByBase?.get(base) ?? []) {
          if (completionKey.includes('\u0000') && !legacyKeys.has(completionKey)) continue;
          legacyKeys.add(completionKey);
        }
      }
      legacyKeys.delete(task.key);

      for (const legacyKey of legacyKeys) {
        const legacySnapshot = this.snapshot.get(legacyKey);
        if (legacySnapshot && !this.snapshot.has(task.key)) {
          this.setSnapshotEntry({ ...legacySnapshot, key: task.key, filePath: task.filePath, lineNumber: task.lineNumber });
        }
        this.deleteSnapshotEntry(legacyKey);

        for (const completion of completionRecordsByFileAndKey.get(`${task.filePath}\u0000${legacyKey}`) ?? []) {
          completion.taskKey = task.key;
          (this.pendingCompletionKeyMigrations ??= new Map()).set(legacyKey, task.key);
        }

        if (this.recurrenceCounts?.[legacyKey] !== undefined && this.recurrenceCounts[task.key] === undefined) {
          this.recurrenceCounts[task.key] = this.recurrenceCounts[legacyKey];
        }
        if (this.recurrenceCounts?.[legacyKey] !== undefined) {
          (this.pendingRecurrenceCountMigrations ??= new Map()).set(legacyKey, task.key);
          delete this.recurrenceCounts[legacyKey];
        }
      }
    }
  }

  private completionSourceKey(task: ParsedTask): string {
    return `${task.filePath}\u0000${task.key}`;
  }

  private suppressDailyNoteQueryCompletion(task: ParsedTask, sourcePath: string, nextCheckbox: string): void {
    const nextState = this.settings.supportedStates.find((state) => state.rawText === nextCheckbox);
    if (nextState?.type === 'done' && this.dailyNoteResolver.isTodayDailyNote(sourcePath)) {
      this.suppressedCompletionKeys.add(this.completionSourceKey(task));
    }
  }

  private async recordHabitCompletionIfNeeded(
    task: ParsedTask,
    generation?: number,
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    const active = (): boolean => (generation === undefined || this.isLifecycleGenerationActive(generation)) && isCurrent();
    if (!active() || !taskIsHabit(task)) return;
    const completionDate = task.metadata.dates.done ?? formatLocalDate(new Date());
    await this.stateStore.updateState(
      (state) => this.stateStore.addHabitCompletion(state, task.key, completionDate),
      { shouldCommit: active },
    );
  }

  private completionCoordinatorForCurrentContext(): CompletionCoordinator {
    this.completionCoordinator ??= new CompletionCoordinator(this.stateStore, this.dailyNoteResolver, this.logWriter);
    return this.completionCoordinator;
  }

  private async materializeCompletionTasks(
    tasks: readonly ParsedTask[],
    generation?: number,
    isCurrent: () => boolean = () => true,
  ): Promise<number> {
    const active = (): boolean => (generation === undefined || this.isLifecycleGenerationActive(generation)) && isCurrent();
    this.suppressedCompletionKeys ??= new Set<string>();
    if (!active()) return 0;
    if (!this.settings.completionLoggingEnabled) {
      for (const task of tasks) this.suppressedCompletionKeys.delete(this.completionSourceKey(task));
      return 0;
    }
    const records = await this.completionCoordinatorForCurrentContext().materialize({
      tasks,
      existingRecords: this.completions ?? [],
      inFlightKeys: this.inFlightCompletions ??= new Set<string>(),
      shouldInclude: (task) => !this.suppressedCompletionKeys.delete(this.completionSourceKey(task)),
      isActive: active,
    });
    if (!active() || records.length === 0) return 0;
    const byKey = new Map((this.completions ?? []).map((record) => [
      this.stateStore.completionKey(record.taskKey, record.sourcePath, record.dailyNotePath),
      record,
    ]));
    for (const record of records) {
      byKey.set(this.stateStore.completionKey(record.taskKey, record.sourcePath, record.dailyNotePath), record);
    }
    this.completions = this.mutableCompletionRecords(Array.from(byKey.values()));
    return records.length;
  }

  private async handleCompletion(
    task: ParsedTask,
    generation?: number,
    isCurrent: () => boolean = () => true,
  ): Promise<void> {
    const materialized = await this.materializeCompletionTasks([task], generation, isCurrent);
    if (materialized > 0) {
      const repository = completionStateRepository(this.stateStore);
      const committed = await repository.update((current) => {
        const records = new Map((current.completions ?? []).map((record) => [
          this.stateStore.completionKey(record.taskKey, record.sourcePath, record.dailyNotePath), record,
        ]));
        for (const record of this.completions ?? []) {
          records.set(this.stateStore.completionKey(record.taskKey, record.sourcePath, record.dailyNotePath), record);
        }
        return { completions: this.stateStore.pruneCompletions(Array.from(records.values()), COMPLETION_RECORD_RETENTION_DAYS) };
      }, { shouldCommit: () => (generation === undefined || this.isLifecycleGenerationActive(generation)) && isCurrent() });
      this.completions = this.mutableCompletionRecords(committed.completions ?? []);
    }
  }

  private mutableCompletionRecords(records: readonly CompletionRecord[]): CompletionRecord[] {
    return records.map((record) => ({ ...record }));
  }

  private applyPersistentStateProjection(state: PersistedState): void {
    this.snapshot = new Map(
      state.snapshot.map((entry) => [
        entry.key,
        {
          key: entry.key,
          status: entry.status as ParsedTask['status'],
          filePath: entry.filePath,
          lineNumber: entry.lineNumber,
          sourceKind: entry.sourceKind ?? (entry.lineNumber === 0 ? 'file' : 'line'),
        },
      ]),
    );
    this.rebuildSnapshotFileIndex();
    this.completions = this.mutableCompletionRecords(this.stateStore.pruneCompletions(state.completions, 0));
    this.recurrenceCounts = { ...(state.recurrenceCounts ?? {}) };
    this.identityMapper = new IdentityMapper(state.identityState);
    this.syncOperationQueue = new SyncOperationQueue(state.syncQueueState);
    this.identityStateRevision = 0;
    this.persistedIdentityStateRevision = 0;
    this.syncQueueRevision = 0;
    this.persistedSyncQueueRevision = 0;
    const prunedFiredReminderKeys = this.pruneFiredReminderKeys(state.firedReminderKeys ?? []);
    this.firedReminders = new Set(prunedFiredReminderKeys.map((entry) => this.decodeFiredReminderKey(entry).key));
  }

  private async migrateHydratedExplicitIdentityState(generation?: number, isCurrent: () => boolean = () => true): Promise<void> {
    const active = (): boolean => (generation === undefined || this.isLifecycleGenerationActive(generation)) && isCurrent();
    if (!active()) return;
    const existing = await this.stateStore.loadState();
    if (!active()) return;
    if ((existing.identityMigration?.version ?? 0) >= EXPLICIT_IDENTITY_STATE_VERSION && existing.identityMigration?.completed) return;
    const tasks = this.getTaskIndex().getAllTasks();
    let migrated = false;
    const committed = await this.stateStore.updateState((current) => {
      if (!active()) return current;
      const next = migrateExplicitIdentityState(current, tasks);
      migrated = next !== current;
      return next;
    }, { shouldCommit: active });
    if (!active() || !migrated) return;
    this.applyPersistentStateProjection(committed);

    // Retain the old normalized-text compatibility bridge, but only after the
    // complete vault index can prove each explicit ID is unique.
    const explicitIds = new ExplicitIdIndex(tasks);
    const uniqueTasks = explicitIds.ids().map((id) => explicitIds.unique(id)).filter((task): task is ParsedTask => Boolean(task));
    this.migrateDurableIdentityKeys(uniqueTasks);

    // Do not overlay current scan status here. Lifecycle comparison runs next
    // against this migrated prior snapshot, then applies the current tasks.
  }

  private async loadPersistentState(): Promise<void> {
    const state = await this.stateStore.loadState();
    this.applyPersistentStateProjection(state);
    const prunedFiredReminderKeys = this.pruneFiredReminderKeys(state.firedReminderKeys ?? []);
    if (prunedFiredReminderKeys.length !== (state.firedReminderKeys ?? []).length) {
      await this.stateStore.updateState((current) => ({
        ...current,
        firedReminderKeys: this.pruneFiredReminderKeys(current.firedReminderKeys ?? []),
      }));
    }
  }

  private async resetStateCache(): Promise<void> {
    this.clearSnapshotEntries();
    this.completions = [];
    const committed = await this.stateStore.updateState((current) => ({
      ...current,
      snapshot: [],
      completions: [],
    }));
    this.completions = this.mutableCompletionRecords(committed.completions);
  }

  private async persistState(generation?: number): Promise<void> {
    const active = (): boolean => generation === undefined || this.isLifecycleGenerationActive(generation);
    if (!active()) return;
    const snapshot = this.snapshotRecords();
    const indexedTasks = this.getTaskIndex().getInternalTasks();
    const completions = [...(this.completions ?? [])];
    const completionMigrations = new Map(this.pendingCompletionKeyMigrations ?? []);
    const recurrenceMigrations = new Map(this.pendingRecurrenceCountMigrations ?? []);
    const removedIndexPaths = new Set(this.pendingRemovedIndexPaths ?? []);
    const committed = await this.stateStore.updateState((current) => {
      const migratedCompletions = current.completions.map((record) => {
        const migratedKey = completionMigrations.get(record.taskKey);
        return migratedKey ? { ...record, taskKey: migratedKey } : record;
      });
      const completionsByKey = new Map(migratedCompletions.map((record) => [
        this.stateStore.completionKey(record.taskKey, record.sourcePath, record.dailyNotePath),
        record,
      ]));
      for (const record of completions) {
        completionsByKey.set(this.stateStore.completionKey(record.taskKey, record.sourcePath, record.dailyNotePath), record);
      }
      const recurrenceCounts = { ...(current.recurrenceCounts ?? {}) };
      for (const task of indexedTasks) {
        const durableCount = task.metadata.recurrenceCount;
        if (durableCount !== undefined && durableCount > (recurrenceCounts[task.key] ?? 0)) recurrenceCounts[task.key] = durableCount;
      }
      for (const [legacyKey, durableKey] of recurrenceMigrations) {
        if (recurrenceCounts[legacyKey] !== undefined && recurrenceCounts[durableKey] === undefined) {
          recurrenceCounts[durableKey] = recurrenceCounts[legacyKey];
        }
        delete recurrenceCounts[legacyKey];
      }
      const fileHashes = { ...(current.fileHashes ?? {}) };
      for (const prefix of removedIndexPaths) {
        for (const path of Object.keys(fileHashes)) {
          if (path === prefix || path.startsWith(`${prefix}/`)) delete fileHashes[path];
        }
      }
      let next: PersistedState = {
        ...current,
        version: CURRENT_STATE_VERSION,
        fileHashes,
        snapshot,
        completions: this.stateStore.pruneCompletions(Array.from(completionsByKey.values()), COMPLETION_RECORD_RETENTION_DAYS),
        recurrenceCounts,
        firedReminderKeys: this.encodeFiredReminderState(current.firedReminderKeys ?? []),
      };
      for (const task of indexedTasks) {
        if (!task.metadata.recurrence && !task.metadata.recurrenceRaw) continue;
        if (task.status !== 'done' && task.status !== 'cancelled') continue;
        const date = task.metadata.dates.done ?? task.metadata.dates.cancelled ?? task.metadata.dates.due ?? task.metadata.dates.scheduled ?? task.metadata.dates.start;
        if (!date) continue;
        next = this.stateStore.addRecurrenceOccurrence(next, {
          seriesId: task.metadata.recurrenceSeriesId ?? task.metadata.id ?? task.key,
          date: date.slice(0, 10),
          taskKey: task.key,
        });
      }
      return next;
    }, { shouldCommit: active });
    if (!active()) return;
    for (const [legacyKey, durableKey] of completionMigrations) {
      if (this.pendingCompletionKeyMigrations?.get(legacyKey) === durableKey) this.pendingCompletionKeyMigrations.delete(legacyKey);
    }
    for (const [legacyKey, durableKey] of recurrenceMigrations) {
      if (this.pendingRecurrenceCountMigrations?.get(legacyKey) === durableKey) this.pendingRecurrenceCountMigrations.delete(legacyKey);
    }
    for (const prefix of removedIndexPaths) this.pendingRemovedIndexPaths?.delete(prefix);
    this.completions = this.mutableCompletionRecords(committed.completions);
    this.recurrenceCounts = { ...(committed.recurrenceCounts ?? {}) };
    if (!active()) return;
    await this.persistSyncState(active);
  }

  private snapshotRecords(): PersistedState['snapshot'] {
    return Array.from(this.snapshot.values()).map((entry) => ({
      key: entry.key,
      status: entry.status,
      filePath: entry.filePath,
      lineNumber: entry.lineNumber,
      sourceKind: entry.sourceKind ?? (entry.lineNumber === 0 ? 'file' : 'line'),
    }));
  }

  // ── Experimental sync modal helpers ────────────────────────────────────

  async testTodoistConnection(): Promise<{ success: boolean; message: string }> {
    return testTodoistProviderConnection(this.settings, this.createProviderRunContext());
  }

  async testGoogleTasksConnection(): Promise<{ success: boolean; message: string }> {
    return testGoogleTasksProviderConnection(this.settings, this.createProviderRunContext(), (context) => this.refreshGoogleTasksTokenIfNeeded(context));
  }

  async testGoogleCalendarConnection(): Promise<{ success: boolean; message: string }> {
    return testGoogleCalendarProviderConnection(this.settings, this.createProviderRunContext(), (context) => this.refreshGoogleCalendarTokenIfNeeded(context));
  }

  async testCalDAVConnection(): Promise<{ success: boolean; message: string }> { const generation = this.ensureLifecycleGeneration(); const controller = this.networkAbortController; if (!controller || !this.isLifecycleGenerationActive(generation)) return { success: false, message: 'CalDAV connection cancelled' }; const current = (): boolean => this.isLifecycleGenerationActive(generation) && this.networkAbortController === controller && !controller.signal.aborted; const result = await testCalDAVProviderConnection({ serverUrl: this.settings.caldavServerUrl, username: this.settings.caldavUsername, password: this.settings.caldavPassword, calendarPath: this.settings.caldavCalendarPath, allowPrivateNetwork: this.settings.caldavAllowPrivateNetwork, signal: controller.signal }); return current() ? result : { success: false, message: 'CalDAV connection cancelled' }; }
  async testMicrosoftTodoConnection(): Promise<{ success: boolean; message: string }> {
    return testMicrosoftTodoProviderConnection(this.settings, this.createProviderRunContext(), (context) => this.refreshMicrosoftTodoTokenIfNeeded(context));
  }

  showExperimentalSyncConfirmation(serviceName: string, onConfirm: () => Promise<void>, onCancel?: () => void): void {
    new ExperimentalSyncConfirmationModal(this.app, serviceName, onConfirm, onCancel).open();
  }

  showSyncTestConnection(serviceName: string, testFn: () => Promise<{ success: boolean; message: string }>): void {
    new SyncTestConnectionModal(this.app, serviceName, testFn).open();
  }
}

function parseReminderExpectation(reminderKey: string, taskText: string): { filePath: string; lineNumber: number; taskText: string; reminder: string } {
  const parts = reminderKey.split(':');
  if (parts.length < 3) throw new Error('Reminder identity is invalid; no task was completed');
  const [filePath, lineNumberText, ...reminderParts] = parts;
  const lineNumber = Number.parseInt(lineNumberText, 10);
  const reminder = reminderParts.join(':');
  if (!filePath || !Number.isSafeInteger(lineNumber) || lineNumber < 1 || !reminder || !taskText.trim()) {
    throw new Error('Reminder identity is invalid; no task was completed');
  }
  return { filePath, lineNumber, taskText, reminder };
}

function reminderTaskDisplayText(taskText: string): string {
  const parsed = parseEditableTaskLine(taskText);
  return parsed.checkbox ? parsed.description : taskText;
}

function interleaveLineEndings(lines: readonly string[], lineEnding: string): string[] {
  return lines.flatMap((line, index) => index === lines.length - 1 ? [line] : [line, lineEnding]);
}

function toggleTaskLineDone(line: string, settings: TaskManagerSettings): string {
  const parsed = parseEditableTaskLine(line);
  const doneState = settings.supportedStates.find((state) => state.type === 'done')?.rawText ?? 'x';
  const todoState = settings.supportedStates.find((state) => state.type === 'todo')?.rawText ?? ' ';
  const isDone = settings.supportedStates.find((state) => state.rawText === parsed.checkbox)?.type === 'done';
  return rewriteTaskLineForStatus(line, isDone ? todoState : doneState, settings) ?? line;
}

function ensureFrontmatterKeys(content: string, keys: readonly string[]): string {
  const existing = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  const missing = keys.filter((key) => !new RegExp(`^${escapeRegExp(key)}\\s*:`, 'mu').test(existing?.[1] ?? ''));
  if (missing.length === 0) return content;
  const additions = missing.map((key) => `${key}:`).join('\n');
  if (existing) {
    const insertAt = existing[0].lastIndexOf('---');
    return `${content.slice(0, insertAt)}${additions}\n${content.slice(insertAt)}`;
  }
  return `---\n${additions}\n---\n${content}`;
}

/**
 * Create a CodeMirror 6 ViewPlugin that intercepts checkbox clicks in Live Preview mode
 * and applies the full task lifecycle (status advance, recurrence, on-completion) via
 * a CM6 transaction instead of a file-write round-trip.
 */
function createLivePreviewExtension(
  getSettings: () => TaskManagerSettings,
  getRenderer: () => TaskQueryRenderer,
  getActiveFile: () => { path: string } | null,
  rewriteWithRecurrenceExceptions?: (line: string, checkbox: string, filePath: string, lineNumber: number) => Promise<string[] | null>,
) {
  return ViewPlugin.fromClass(
    class implements PluginValue {
      private readonly boundHandleClick: (e: MouseEvent) => void;

      constructor(private readonly view: EditorView) {
        this.boundHandleClick = (e: MouseEvent) => { void this.handleClick(e); };
        this.view.dom.addEventListener('click', this.boundHandleClick, true);
      }

      destroy(): void {
        this.view.dom.removeEventListener('click', this.boundHandleClick, true);
      }

      private async handleClick(event: MouseEvent): Promise<void> {
        const target = event.target;
        if (!(target instanceof HTMLInputElement) || target.type !== 'checkbox') return;
        // Query renderer checkboxes handle themselves; skip them here
        if (target.closest('.task-manager-query')) return;

        const initialState = this.view.state;
        const position = this.view.posAtDOM(target);
        const line = initialState.doc.lineAt(position);
        const lineText = line.text;

        if (!/^(?:\s*>\s*)*\s*(?:[-*+]|\d+[.)])\s+\[[^\]]+\]/u.test(lineText)) return;

        const settings = getSettings();
        const globalFilter = settings.globalFilter;
        if (globalFilter) {
          const file = getActiveFile();
          const parsedTask = parseMarkdownTaskLine(lineText, file?.path ?? '', line.number, settings.supportedStates, undefined, settings.orgModeEnabled, settings.customFieldDefinitions);
          if (!parsedTask || !taskMatchesGlobalFilter(parsedTask, globalFilter)) return;
        }

        const markerMatch = lineText.match(/\[([^\]]+)\]/u);
        const currentMarker = markerMatch?.[1] ?? ' ';
        const nextCheckbox = cycleTaskCheckbox(currentMarker, settings.supportedStates);
        const parsed = parseEditableTaskLine(lineText);
        if (durableCompletionDestinationAction(lineText, nextCheckbox, settings.supportedStates, settings)) {
          event.preventDefault();
          event.stopImmediatePropagation();
          showDurableLifecycleEditorNotice();
          return;
        }

        event.preventDefault();
        event.stopImmediatePropagation();

        const file = getActiveFile();
        const newLines = file && parsed.recurrence && rewriteWithRecurrenceExceptions
          ? await rewriteWithRecurrenceExceptions(lineText, nextCheckbox, file.path, line.number)
          : rewriteTaskLineForStatusWithLifecycle(lineText, nextCheckbox, settings);
        if (!newLines) return;

        const state = this.view.state;
        if (line.number > state.doc.lines) return;
        const currentLine = state.doc.line(line.number);
        if (currentLine.text !== lineText) return;

        const insertText = newLines.join(state.lineBreak);
        let to = currentLine.to;
        if (insertText === '') {
          // on-completion: delete - also eat the trailing line break
          const nextLineNum = currentLine.number + 1;
          if (nextLineNum <= state.doc.lines) to = state.doc.line(nextLineNum).from;
        }

        this.view.dispatch(state.update({ changes: { from: currentLine.from, to, insert: insertText } }));

        // Workaround: force the checkbox checked state after Obsidian may have reverted it
        if (newLines.length === 1) {
          const desiredChecked = !/\[\s\]/u.test(newLines[0]);
          setTimeout(() => { target.checked = desiredChecked; }, 1);
        }

        if (file) getRenderer().invalidateCache(file.path);
      }
    },
  );
}

function findDependencyCycles(tasks: ParsedTask[]): string[][] {
  const graph = new Map<string, string[]>();
  for (const task of tasks) {
    if (task.metadata.id) graph.set(task.metadata.id, task.metadata.dependsOn.filter((id) => id));
  }
  const cycles: string[][] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];
  const visit = (id: string): void => {
    if (visiting.has(id)) {
      const index = stack.indexOf(id);
      if (index >= 0) cycles.push([...stack.slice(index), id]);
      return;
    }
    if (visited.has(id)) return;
    visiting.add(id);
    stack.push(id);
    for (const dep of graph.get(id) ?? []) visit(dep);
    stack.pop();
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of graph.keys()) visit(id);
  return cycles;
}

function todayDateString(): string { return formatLocalDate(new Date()); }

function statusBarTaskTimeMinutes(task: ParsedTask): number | null {
  const match = task.metadata.timeStart?.match(/^(\d{1,2}):(\d{2})$/u)
    ?? task.normalizedText.match(/(?:^|\D)(\d{1,2}):(\d{2})(?!\d)/u);
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour >= 24 || minute < 0 || minute >= 60) return null;
  return hour * 60 + minute;
}

function statusBarClockLabel(minutes: number): string {
  const hour = Math.floor(minutes / 60);
  const minute = minutes % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function formatStatusBarNowNextText(tasks: readonly ParsedTask[], now = new Date(), todayStr = todayDateString()): string {
  const currentTimeInMinutes = now.getHours() * 60 + now.getMinutes();
  let current: { task: ParsedTask; minutes: number } | null = null;
  let next: { task: ParsedTask; minutes: number } | null = null;
  for (const task of tasks) {
    if (task.metadata.dates.scheduled !== todayStr) continue;
    const minutes = statusBarTaskTimeMinutes(task);
    if (minutes === null) continue;
    const entry = { task, minutes };
    if (minutes <= currentTimeInMinutes && (!current || minutes > current.minutes)) current = entry;
    if (minutes > currentTimeInMinutes && (!next || minutes < next.minutes)) next = entry;
  }

  const currentText = current ? `Now: ${current.task.normalizedText.slice(0, 20)}` : 'Now: —';
  const nextText = next ? `${next.task.normalizedText.slice(0, 20)} (${statusBarClockLabel(next.minutes)})` : '—';
  return `🕐 ${currentText} | Next: ${nextText}`;
}

function excludedFoldersSignature(folders: readonly string[] | undefined): string {
  return [...new Set((folders ?? []).map((folder) => folder.trim().replace(/^\/+|\/+$/gu, '').toLowerCase()).filter(Boolean))].sort().join('\u0000');
}

function scannableMarkdownFiles(app: App, settings: Pick<TaskManagerSettings, 'excludedFolders'>): TFile[] {
  return app.vault.getMarkdownFiles().filter((file) => isIndexableTaskFile(file, settings.excludedFolders ?? []));
}

function sanitizeIcsSummaryForTask(summary: string): string {
  return sanitizeUntrustedTaskText(stripInlineTags(summary)) || 'Untitled calendar event';
}

export function formatIcsEventTaskLine(event: { summary: string; date: string | null; uid: string | null }): string {
  return `- [ ] ${sanitizeIcsSummaryForTask(event.summary)}${event.date ? ` 📅 ${event.date}` : ''}${event.uid ? ` 🆔 ical:${event.uid.replace(/[^A-Za-z0-9_-]/gu, '_')}` : ''}`;
}

/** #9: Parse VEVENT blocks from ICS text into summary+date+UID+time objects. */
function parseIcsEvents(icsText: string): Array<{ summary: string; date: string | null; startTime?: string; endTime?: string; uid: string | null }> {
  const events: Array<{ summary: string; date: string | null; startTime?: string; endTime?: string; uid: string | null }> = [];
  for (const block of icsText.matchAll(/BEGIN:VEVENT([\s\S]*?)END:VEVENT/gu)) {
    const body = block[1] ?? '';
    const summaryRaw = /^SUMMARY[^:]*:(.+)$/mu.exec(body)?.[1]?.trim() ?? '';
    const uidRaw = /^UID[^:]*:(.+)$/mu.exec(body)?.[1]?.trim() ?? null;
    const summary = summaryRaw.replace(/\\n/gu, ' ').replace(/\\,/gu, ',').replace(/\\;/gu, ';');
    
    // Extract DTSTART with date and time
    const dtStartMatch = /^DTSTART[^:]*:(\d{4})(\d{2})(\d{2})T?(\d{2})?(\d{2})?/mu.exec(body);
    const date = dtStartMatch ? `${dtStartMatch[1]}-${dtStartMatch[2]}-${dtStartMatch[3]}` : null;
    const startTime = dtStartMatch && dtStartMatch[4] ? `${dtStartMatch[4]}:${dtStartMatch[5] ?? '00'}` : undefined;
    
    // Extract DTEND with time
    const dtEndMatch = /^DTEND[^:]*:(\d{4})(\d{2})(\d{2})T?(\d{2})?(\d{2})?/mu.exec(body);
    const endTime = dtEndMatch && dtEndMatch[4] ? `${dtEndMatch[4]}:${dtEndMatch[5] ?? '00'}` : undefined;
    
    if (summary) events.push({ summary, date, startTime, endTime, uid: uidRaw });
  }
  return events;
}

/** Fetch ICS content from a URL. */
async function fetchIcsFromUrl(url: string): Promise<string | null> {
  try {
    return await fetchSafeCalendarText(url, { headers: { 'Accept': 'text/calendar' } });
  } catch (error) {
    console.error('Failed to fetch ICS URL:', error);
    return null;
  }
}

/**
 * Apply a DeferPreset offset to a base date string (YYYY-MM-DD).
 * Delegates to date-utils.addDate for day/week/month arithmetic so there is a
 * single source of truth for calendar-aware date maths.
 */
function applyDeferPreset(base: string, preset: DeferPreset): string {
  let result = base;
  if (preset.days !== undefined && preset.days > 0) result = addDate(result, 'day', preset.days);
  if (preset.weeks !== undefined && preset.weeks > 0) result = addDate(result, 'week', preset.weeks);
  if (preset.months !== undefined && preset.months > 0) result = addDate(result, 'month', preset.months);
  return result;
}


// Functions moved here from their original position in the file.
// They are used by the plugin class body and could not be moved to modal files.

function completedTaskBlockEnd(lines: Array<{ text: string; lineEnding: string }>, startIndex: number, parentIndent: number): number {
  let end = startIndex + 1;
  while (end < lines.length) {
    const text = lines[end]?.text ?? '';
    if (!text.trim()) { end++; continue; }
    const childIndent = leadingTaskIndentLength(text);
    if (childIndent <= parentIndent) break;
    end++;
  }
  return end;
}

function leadingTaskIndentLength(line: string): number {
  return line.match(/^(?:\s*>\s*)*\s*/u)?.[0].length ?? 0;
}
