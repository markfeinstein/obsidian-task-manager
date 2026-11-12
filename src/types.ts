import type { CustomFieldDefinition } from './custom-fields-sync';
import { Platform } from 'obsidian';

export type TaskStateType = 'todo' | 'in_progress' | 'on_hold' | 'blocked' | 'deferred' | 'done' | 'cancelled' | 'untracked';

/**
 * 8-character hexadecimal identifier for a recurring task series.
 * Auto-assigned on first recurrence, propagated via metadata field.
 * Format: lowercase hex string, e.g., "a1b2c3d4"
 */
export type RecurrenceSeriesId = string & { readonly __brand: 'RecurrenceSeriesId' };

// Reminder management types
export interface SnoozePreset {
  label: string;
  minutesDuration: number;
}

export interface SnoozedReminder {
  reminderKey: string;
  taskFilePath: string;
  taskLineNumber: number;
  taskText: string;
  /** The original reminder time, as an ISO 8601 string. */
  originalReminderTime: string;
  /** The new time for the snoozed reminder, as an ISO 8601 string. */
  nextFireTime: string;
  /** The time the reminder was snoozed, as an ISO 8601 string. */
  snoozedAtIso: string;
}

export interface MissedReminder {
  reminderKey: string;
  taskFilePath: string;
  taskLineNumber: number;
  taskText: string;
  /** The scheduled reminder time, as an ISO 8601 string. */
  reminderTime: string;
  /** The actual time the reminder fired, as an ISO 8601 string. */
  firedAtIso: string;
  acknowledged: boolean;
}

export type TaskStatus = TaskStateType;
export type TaskFontSize = 'small' | 'normal' | 'large';
export type TaskDensity = 'compact' | 'comfortable' | 'spacious';

/** Sync service status (stability indicator). */
export type SyncServiceStatus = 'stable' | 'experimental';

/** Sync service status map for all supported services. */
export const SYNC_SERVICE_STATUS: Record<string, SyncServiceStatus> = {
  'CalDAV': 'experimental',
  'Todoist': 'experimental',
  'Apple Reminders': 'experimental',
  'Microsoft To Do': 'experimental',
  'Google Tasks': 'experimental',
};

export interface TaskStateDefinition {
  rawText: string;
  name: string;
  icon: string;
  type: TaskStateType;
  nextStatusSymbol?: string;
  /**
   * When true (or unset), the plugin registers a `change-status-to-<symbol>` command
   * in the command palette for this state. Bundled theme collections set this to
   * `false` to mirror upstream Tasks' behaviour where imported statuses do not
   * pollute the command palette.
   */
  availableAsCommand?: boolean;
}

/** Weights for the urgency score formula (all default to upstream obsidian-tasks values). */
export interface UrgencyWeights {
  /** Multiplier for the due-date component. Default: 12.0. */
  due: number;
  /** Multiplier for the priority component. Default: 6.0. */
  priority: number;
  /** Multiplier for the scheduled-date component. Default: 5.0. */
  scheduled: number;
  /** Multiplier for the start-date component. Default: -3.0 (penalises future start dates). */
  start: number;
}

export interface DeferPreset {
  label: string;
  days?: number;
  weeks?: number;
  months?: number;
}

export interface SavedTaskQuery {
  name: string;
  query: string;
}

export type TableCustomColumnType = 'text' | 'number' | 'date' | 'checkbox' | 'list';

export interface TableSavedFilter {
  name: string;
  search: string;
  statuses: string[];
  priorities: string[];
  tags: string[];
  sortKey: string;
  sortDirection: 'asc' | 'desc';
  showHierarchy: boolean;
  visibleColumns: string[];
  /** Stable ID used by unified saved-view persistence. */
  id?: string;
}

export interface TableCustomColumn {
  key: string;
  label: string;
  type: TableCustomColumnType;
  options?: string[];
  color?: string;
  required?: boolean;
}

export interface TableViewConfig {
  savedFilters: TableSavedFilter[];
  customColumns: TableCustomColumn[];
  showHierarchy: boolean;
  visibleColumns: string[];
}

export type KanbanBoardGroupBy = 'status' | 'priority' | 'tag' | 'project' | 'assignee' | 'custom';

export interface KanbanBoardConfig {
  id: string;
  name: string;
  query: string;
  groupBy: KanbanBoardGroupBy;
  customFieldKey?: string;
  columns: string[];
  background: string;
  /** Stable preset identity for shared saved-view persistence. */
  presetId?: string;
}

export interface SavedViewPreset {
  id: string;
  kind: 'table-filter' | 'kanban-board';
  name: string;
  view: 'table' | 'kanban';
  payload?: Record<string, unknown>;
}

export interface TaskStateCollection {
  name: string;
  description: string;
  states: TaskStateDefinition[];
}

export interface ModalFieldVisibility {
  priority: boolean;
  due: boolean;
  scheduled: boolean;
  start: boolean;
  created: boolean;
  done: boolean;
  cancelled: boolean;
  reminder: boolean;
  recurrence: boolean;
  onCompletion: boolean;
  id: boolean;
  before_this: boolean;
  after_this: boolean;
  time: boolean;
  effort: boolean;
  actual: boolean;
  /** Follow-up watch date field (👀) shown in the create/edit modal. */
  followUp: boolean;
  /** Cost field (💵) shown in the create/edit modal. */
  cost: boolean;
  /** Pinned/focus marker (📌) shown in the create/edit modal. */
  pinned: boolean;
}

// ── Feature: Workflow automation (#5) ──────────────────────────────────
/** A single stage in a workflow - defines the next task to create when the current stage completes. */
export interface WorkflowStep {
  /** Label shown in the settings editor. */
  name: string;
  /** Task description template for the new task. Supports {{prev}} to inherit the previous task description. */
  description: string;
  /** Checkbox symbol for the new task (default ' ' = todo). */
  status: string;
  /** Priority for the new task ('', 'highest', 'high', 'medium', 'low', 'lowest'). Empty = inherit. */
  priority: string;
}

/** A named workflow - completing a task that carries `triggerTag` auto-creates the next step task. */
export interface WorkflowDefinition {
  /** Unique identifier used internally. */
  id: string;
  /** Human-readable name displayed in settings. */
  name: string;
  /**
   * Tag (without #) whose presence on a completed task fires the workflow.
   * Example: `wf:review` matches tasks tagged `#wf:review`.
   */
  triggerTag: string;
  /** Ordered list of stages. Stage 0 fires when the trigger tag is found, stage 1 fires after stage 0 completes, etc. */
  steps: WorkflowStep[];
}

/** Focus-timer state persisted per task key (stored in memory only, not in settings). */
export interface FocusTimerState {
  taskKey: string;
  startMs: number;
  elapsedMs: number;
  running: boolean;
}

export interface TaskTemplate {
  name: string;
  description: string;
  priority: string;
  recurrence: string;
  tags: string;
  onCompletion: string;
}

export type TaskViewMode = 'list' | 'checklist' | 'table' | 'kanban' | 'calendar' | 'gantt' | 'stats' | 'graph' | 'eisenhower' | 'timeline';

/** Custom priority entry - replaces the six built-in levels when the array is non-empty. */
export interface CustomPriority {
  label: string;
  emoji: string;
  /** Numeric weight used for sorting (higher = more urgent). Built-in: highest=6, high=5, medium=4, normal=3, low=2, lowest=1. */
  value: number;
}

export type ModalFieldVisibilityKey = keyof ModalFieldVisibility;

export type TaskQueryDefaultSort = 'smart' | 'urgency' | 'status' | 'due' | 'scheduled' | 'start' | 'done' | 'created' | 'cancelled' | 'happens' | 'priority' | 'path' | 'folder' | 'filename' | 'heading' | 'description' | 'recurring' | 'tag' | 'random';
export type TaskMetadataFormat = 'emoji' | 'dataview';
export type TaskCountLocation = 'top' | 'bottom';
export type RecurrenceInsertLocation = 'before' | 'after';
export type TasksCodeBlockMode = 'when-upstream-absent' | 'always' | 'never';

// ── Kanban Automation Rules ──────────────────────────────────────────────────────
/** Trigger conditions for kanban automation rules. */
export type KanbanRuleTrigger = 'lane-enter' | 'lane-exit' | 'card-created' | 'tag-added' | 'priority-changed';

/** Condition types for kanban rules. */
export type KanbanRuleCondition = 'tag-match' | 'priority-match' | 'status-match' | 'always';

/** Actions that can be performed by kanban rules. */
export type KanbanRuleAction = 'set-done-date' | 'move-lane' | 'set-priority' | 'add-tag' | 'remove-tag';

/** Configuration for a single kanban automation rule. */
export interface KanbanAutomationRule {
  /** Unique identifier for the rule. */
  id: string;
  /** Whether this rule is active. */
  enabled: boolean;
  /** What event triggers this rule. */
  trigger: KanbanRuleTrigger;
  /** Condition that must be met for action to execute. */
  condition: KanbanRuleCondition;
  /** Condition parameters (e.g., tag name, priority level). */
  conditionValue?: string | string[];
  /** The action to perform. */
  action: KanbanRuleAction;
  /** Action parameters (e.g., target lane, value to set). */
  actionValue?: string;
  /** Optional description for the rule. */
  description?: string;
}

/** WIP (Work In Progress) limit configuration. */
export interface WipLimitConfig {
  /** Status/lane name. */
  statusName: string;
  /** Hard limit: drop is rejected if exceeded. 0 = unlimited. */
  hardLimit?: number;
  /** Soft limit: drop is allowed but warning shown if exceeded. 0 = no soft limit. */
  softLimit?: number;
}

// ── Dashboard Widget Types ──────────────────────────────────────────────────
export type DashboardWidgetType =
  | 'today'
  | 'agenda'
  | 'upcoming'
  | 'saved-query'
  | 'stats'
  | 'calendar-mini'
  | 'kanban-mini'
  | 'overdue-risk'
  | 'sync-health'
  | 'habits'
  | 'pomodoro'
  | 'focus-queue'
  | 'blocked-waiting'
  | 'inbox-triage'
  | 'eisenhower'
  | 'workload-project'
  | 'stale-tasks'
  | 'recently-completed'
  | 'effort-forecast'
  | 'review-queue'
  | 'dependencies'
  | 'follow-up'
  | 'priority-distribution'
  | 'contexts-hotspots'
  | 'completion-heatmap'
  | 'sync-activity'
  | 'someday-maybe'
  | 'project-health'
  | 'quick-wins'
  | 'deep-work'
  | 'energy-fit'
  | 'time-block-suggestions'
  | 'date-quality'
  | 'metadata-completeness'
  | 'reminder-queue'
  | 'time-by-project'
  | 'estimate-accuracy'
  | 'task-churn'
  | 'backlog-growth'
  | 'file-hotspots'
  | 'orphaned-task-notes'
  | 'waiting-by-person'
  | 'cost-budget'
  | 'risk-radar'
  | 'smart-suggestions'
  | 'momentum'
  | 'throughput'
  | 'productivity-score'
  | 'cycle-time'
  | 'time-heatmap'
  | 'quick-capture'
  | 'daily-goal'
  | 'daily-todos'
  | 'weekly-review'
  | 'activity-timeline'
  | 'quick-actions'
  | 'status-distribution'
  | 'assignee-workload'
  | 'milestone-progress'
  | 'deadline-strip'
  | 'task-age-distribution'
  | 'scope-burnup'
  | 'custom-field-breakdown'
  | 'sync-conflicts'
  | 'time-in-status'
  | 'recurrence-health'
  // Tier 1 — analytics engines surfaced as cards
  | 'today-schedule'
  | 'capacity-planner'
  | 'burndown'
  | 'completion-forecast'
  | 'cumulative-flow'
  | 'estimate-variance'
  // Tier 2 — methodology completeness
  | 'goals-progress'
  | 'areas-of-responsibility'
  | 'next-action-project'
  | 'schedule-conflicts'
  // Tier 3 — content & navigation
  | 'pinned-tasks'
  | 'subtask-progress'
  | 'daily-note'
  | 'saved-views'
  | 'recently-edited'
  | 'comments-feed'
  | 'needs-scheduling'
  // Tier 4 — engagement & wellbeing
  | 'shutdown-ritual'
  | 'on-this-day'
  | 'goal-streak-calendar'
  | 'tag-explorer';

/** Card footprint within the responsive dashboard grid. */
export type DashboardWidgetSize = 'small' | 'medium' | 'large';

/** Visual emphasis hint for dashboard cards and template previews. */
export type DashboardWidgetPresentation = 'hero' | 'kpi' | 'standard';

/** Visual treatment for the dashboard surface. */
export type DashboardTheme = 'native' | 'command-center' | 'minimal';

/** Time window the dashboard focuses on for agenda-style widgets. */
export type DashboardScope = 'today' | 'week' | 'month';
export type AiQueryProvider = 'openai' | 'anthropic' | 'ollama' | 'lm-studio';

export const AI_PROVIDER_DEFAULTS: Record<AiQueryProvider, { model: string; localEndpoint: string }> = {
  openai: { model: 'gpt-4o-mini', localEndpoint: 'http://localhost:11434/v1/chat/completions' },
  anthropic: { model: 'claude-haiku-4-5-20251001', localEndpoint: 'http://localhost:11434/v1/chat/completions' },
  ollama: { model: 'llama3.1', localEndpoint: 'http://localhost:11434/v1/chat/completions' },
  'lm-studio': { model: 'local-model', localEndpoint: 'http://localhost:1234/v1/chat/completions' },
};

const KNOWN_AI_MODEL_DEFAULTS = new Set([...Object.values(AI_PROVIDER_DEFAULTS).map((defaults) => defaults.model), 'claude-haiku-3-5-20241022', 'claude-3-5-haiku-20241022']);
const KNOWN_AI_ENDPOINT_DEFAULTS = new Set(Object.values(AI_PROVIDER_DEFAULTS).map((defaults) => defaults.localEndpoint));

export function defaultAiModelForProvider(provider: AiQueryProvider): string {
  return AI_PROVIDER_DEFAULTS[provider]?.model ?? AI_PROVIDER_DEFAULTS.openai.model;
}

export function defaultAiEndpointForProvider(provider: AiQueryProvider): string {
  return AI_PROVIDER_DEFAULTS[provider]?.localEndpoint ?? AI_PROVIDER_DEFAULTS.ollama.localEndpoint;
}

export function shouldUseProviderAiDefault(value: string | undefined, knownDefaults: ReadonlySet<string>): boolean {
  const trimmed = value?.trim();
  return !trimmed || knownDefaults.has(trimmed);
}

export function applyAiProviderDefaults<T extends { aiQueryProvider: AiQueryProvider; aiQueryModel: string; aiQueryLocalEndpoint: string }>(settings: T, provider: AiQueryProvider): void {
  if (shouldUseProviderAiDefault(settings.aiQueryModel, KNOWN_AI_MODEL_DEFAULTS)) {
    settings.aiQueryModel = defaultAiModelForProvider(provider);
  }
  if (shouldUseProviderAiDefault(settings.aiQueryLocalEndpoint, KNOWN_AI_ENDPOINT_DEFAULTS)) {
    settings.aiQueryLocalEndpoint = defaultAiEndpointForProvider(provider);
  }
  settings.aiQueryProvider = provider;
}

/**
 * Legacy absolute-grid position. Retained only so older persisted layouts can be
 * read and migrated to the size-based model; no longer used for placement.
 * @deprecated Use {@link DashboardWidgetConfig.size}.
 */
export interface DashboardWidgetPosition {
  col: number;
  row: number;
  width: number;
  height: number;
}

/**
 * Explicit placement of a widget within the snap grid, in column/row units.
 * `x`/`y` are 0-based indices of the top-left cell; `w`/`h` are spans (>= 1).
 */
export interface DashboardGridPlacement {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DashboardWidgetConfig {
  /** Widget type. */
  type: DashboardWidgetType;
  /** Card footprint in the responsive grid. */
  size: DashboardWidgetSize;
  /** Explicit grid placement; when absent it is derived from order + size on load. */
  grid?: DashboardGridPlacement;
  /** User-facing title. */
  title: string;
  /** Whether widget is collapsed. */
  collapsed?: boolean;
  /** Query string for saved-query widget type. */
  query?: string;
  /** Whether to show only completed tasks (for certain widgets). */
  showCompleted?: boolean;
  /** Optional visual treatment for card hierarchy and template previews. */
  presentation?: DashboardWidgetPresentation;
  /** Custom configuration as JSON string. */
  customConfig?: Record<string, unknown>;
  /** @deprecated Legacy absolute-grid position, migrated to {@link size}. */
  position?: DashboardWidgetPosition;
}

export interface DashboardLayout {
  /** Unique layout identifier (e.g., workspace name). */
  id: string;
  /** Display name for the layout. */
  name: string;
  /** Ordered array of widgets; array order drives on-screen placement. */
  widgets: DashboardWidgetConfig[];
  /** @deprecated Legacy fixed column count; layout is now responsive. */
  columns?: number;
  /** @deprecated Legacy fixed gap; spacing now follows the density setting. */
  gap?: number;
  /** Created timestamp. */
  createdAt: number;
  /** Last modified timestamp. */
  updatedAt: number;
  /**
   * Grid column resolution the widget placements are stored at. Missing/older values are scaled up
   * to the current fine grid on load (see migrateDashboardLayout), then stamped here.
   */
  gridCols?: number;
  /** Built-in template this layout was generated from (enables refreshing unmodified template dashboards). */
  templateId?: string;
  /** Template layout revision this dashboard was generated at; bumped when a built-in template changes. */
  templateRevision?: number;
  /** Structural signature of the template-provided widgets; used to detect whether the user has modified the layout. */
  templateSignature?: string;
}

export interface DashboardTemplate {
  /** Stable identifier for a reusable dashboard template. */
  id: string;
  /** User-facing template name. */
  name: string;
  /** Short explanation shown in the template picker. */
  description: string;
  /** Layout copied when a dashboard is created from this template. */
  layout: DashboardLayout;
  /** Created timestamp. */
  createdAt: number;
  /** Last modified timestamp. */
  updatedAt: number;
}

export interface SyncRunSummary {
  service: string;
  startedAt: string;
  endedAt: string;
  outcome: 'success' | 'dry-run' | 'failed' | 'partial';
  details: string;
  created?: number;
  updated?: number;
  deleted?: number;
  imported?: number;
  conflicts?: number;
  failed?: number;
}

export interface TaskManagerSettings {
  // ── Localization ────────────────────────────────────────────────────────
  /** User's preferred locale for the plugin UI. Defaults to browser language. */
  preferredLocale: 'en' | 'zh' | 'de' | 'es' | 'ko' | 'vi' | 'ru' | 'uk' | 'be' | 'pt-BR';
  /** Latest completed/dismissed local onboarding version; zero means unseen. */
  onboardingVersionSeen: number;

  // Feature flags
  dateOutputAsWikiLinks: boolean;
  /** How dates are written when tasks are created or completed.
   * - `'plain'` (default): `YYYY-MM-DD`
   * - `'wikilink'`: `[[YYYY-MM-DD]]` - creates clickable daily-note links
   * Supersedes the older `dateOutputAsWikiLinks` boolean (kept for backward compat). */
  dateFormat: 'plain' | 'wikilink';
  /** When true, append HH:MM to done/created/cancelled lifecycle dates (e.g. ✅ 2026-05-26 14:32). */
  dateTimeOnLifecycleDates: boolean;
  dateDisplayFormat: string;
  subtaskDateInheritance: boolean;
  collectFilePath: string;
  collectHeading: string;
  enableFileEvents: boolean;
  enablePeriodicScan: boolean;
  scanIntervalMinutes: number;
  /** Append completed tasks to today's daily note only after explicit opt-in. */
  completionLoggingEnabled: boolean;
  logSectionHeading: string;
  includeCompletionTime: boolean;
  logTimeFormat: string;
  includeSourceLinkWhenNotDailyNote: boolean;
  globalFilter: string;
  globalQuery: string;
  removeGlobalFilterFromDescription: boolean;
  enableQueryDsl: boolean;
  taskFormat: TaskMetadataFormat;
  taskCountLocation: TaskCountLocation;
  queryCodeBlockName: string;
  tasksCodeBlockMode: TasksCodeBlockMode;
  defaultSort: TaskQueryDefaultSort;
  autoSuggestInEditor: boolean;
  autoSuggestMinMatch: number;
  autoSuggestMaxItems: number;
  slashCommandsInEditor: boolean;
  atAssigneeInEditor: boolean;
  /** Show ghost attribute-picker icons at the end of incomplete task lines on hover. */
  taskLineToolbarEnabled: boolean;
  provideAccessKeys: boolean;
  setCreatedDate: boolean;
  setDoneDate: boolean;
  setCancelledDate: boolean;
  recurrenceFutureOccurrences: number;
  // Equivalent to upstream obsidian-tasks `recurrenceOnNextLine`:
  //   'before' (default) === upstream `recurrenceOnNextLine: false` (new occurrence appears above the completed line)
  //   'after'            === upstream `recurrenceOnNextLine: true`  (new occurrence appears on the next line below the completed line)
  recurrenceInsertLocation: RecurrenceInsertLocation;
  removeScheduledDateOnRecurrence: boolean;
  recurrenceOnCancelled: boolean;
  archiveFilePath: string;
  archiveHeading: string;
  useFilenameAsScheduledDate: boolean;
  filenameScheduledDateFormat: string;
  filenameScheduledDateFolders: string;
  supportedStates: TaskStateDefinition[];
  savedQueries: SavedTaskQuery[];
  modalFields: ModalFieldVisibility;
  deferPresets: DeferPreset[];
  enableReminderNotifications: boolean;
  reminderCheckIntervalMinutes: number;
  quickCaptureInboxPath: string;
  taskTemplates: TaskTemplate[];
  enableMobileGestures: boolean;
  /**
   * When true, show brief confirmation toasts after task actions (completing,
   * cancelling, bulk-editing, etc.). Off by default because these actions'
   * results are already visible in the view.
   */
  showActionNotifications: boolean;
  /** When true, lines starting with nlTaskPrefix are auto-converted to tasks on Enter. */
  nlInlineConversionEnabled: boolean;
  /** The trigger prefix for inline NL task conversion (default '!!'). */
  nlTaskPrefix: string;
  /** Show only children that pass query filters when show tree is active (default false = show all children) */
  treeFilteredView: boolean;

  // Kanban Automation Rules
  /** Kanban automation rules for lane entry/exit, tag-based routing, etc. */
  kanbanRules: KanbanAutomationRule[];
  /** WIP limit configurations by status. */
  wipLimits: WipLimitConfig[];
  /** Show warning when soft WIP limit is exceeded. */
  showWipWarning: boolean;

  // ── Feature: Parent auto-complete from sub-tasks ──────────────────────────
  /** When true, automatically mark a parent task done when all direct children are done/cancelled. */
  autoCompleteParent: boolean;
  /** When true, auto-advance parent task to In Progress when any child becomes in-progress or done and parent is currently todo. */
  autoAdvanceParentToInProgress: boolean;
  /** When true, auto-cancel parent task when ALL direct children are cancelled. */
  autoAdvanceParentOnAllCancelled: boolean;

  // ── Feature: Custom priority scale ───────────────────────────────────────
  /** When non-empty, replaces the built-in six-level priority system. */
  customPriorities: CustomPriority[];

  // ── Feature: Recurring future projections ────────────────────────────────
  /** Number of projected future occurrences to show in queries with `show future occurrences`. 0 = disabled. */
  futureOccurrenceCount: number;

  // ── Feature: Recurrence count limit ──────────────────────────────────────
  /** Track how many times recurring tasks have fired (enables `for N times` limit). */
  trackRecurrenceCount: boolean;

  // ── Feature: System notifications ────────────────────────────────────────
  /** Use the Web Notifications API for system-level reminder popups instead of in-app Notice(). */
  useSystemNotifications: boolean;

  // ── Feature: Task-as-note linking ────────────────────────────────────────
  /** Folder where promoted task notes are created. */
  taskNoteFolder: string;

  // ── Feature: File-backed task notes (#4) ──────────────────────────────────
  /** Comma-separated folder paths where task-note files are located (e.g. 'Tasks, Projects'). */
  taskNoteFolders: string;
  /** YAML frontmatter marker to identify task-note files (default: 'task: true'). */
  taskNoteMarker: string;

  // ── Feature: Todoist sync ─────────────────────────────────────────────────
  todoistApiKey: string;
  todoistProjectId: string;
  todoistSyncEnabled: boolean;
  /** When true, Todoist sync previews v2 operations without writing to Todoist or the vault. */
  todoistDryRun: boolean;
  /** Path to file where imported Todoist tasks are written. */
  todoistInboxPath: string;

  // ── Feature: Obsidian Bases integration ──────────────────────────────────
  enableBasesIntegration: boolean;
  basesAutoRefreshEnabled: boolean;
  basesRefreshDebounceMs: number;

  // ── Feature: Conservative NLP query fallback ─────────────────────────────
  /** Enable a local conservative natural-language fallback for query text that is not already query DSL. */
  nlpQueryEnabled: boolean;

  // ── Feature: Kanban file writeback ───────────────────────────────────────
  /** Allow Kanban drag/drop to move one markdown task line under an existing heading in the source file. */
  kanbanFileWritebackEnabled: boolean;

  // ── Feature: Daily planning ───────────────────────────────────────────────
  /** Heading to write the daily plan block under in today's daily note. */
  dailyPlanHeading: string;

  // ── Feature: Interactive Planning Board ────────────────────────────────────
  /** Enable the interactive planning board view with tabs and drag-to-schedule. */
  planningBoardEnabled: boolean;
  /** Show planning board in sidebar views. */
  planningBoardSidebarEnabled: boolean;
  /** Maximum number of undo operations in planning board. */
  planningBoardMaxUndoStack: number;
  /** Enable drag-to-schedule in planning board. */
  planningBoardDragEnabled: boolean;

  // ── Feature: Pomodoro timer ──────────────────────────────────────────────
  pomodoroWorkMinutes: number;
  pomodoroBreakMinutes: number;
  pomodoroLongBreakMinutes: number;
  pomodoroLongBreakAfter: number;

  // ── Feature: Google Tasks sync ───────────────────────────────────────────
  googleTasksEnabled: boolean;
  /** Optional OAuth client ID used to open Google's manual OAuth/PKCE flow. */
  googleTasksOAuthClientId: string;
  /** OAuth access token pasted by the user for Google Tasks. Preferred over legacy API key. */
  googleTasksAccessToken: string;
  /** Optional OAuth refresh token for Google Tasks. Used to refresh expired access tokens. */
  googleTasksRefreshToken: string;
  /** ISO timestamp when the Google Tasks access token expires. */
  googleTasksTokenExpiresAt: string;
  /** Legacy API key setting retained for compatibility; Google user data normally requires OAuth. */
  googleTasksApiKey: string;
  googleTasksListId: string;
  googleTasksInboxPath: string;
  // ── Feature: Google Calendar event sync ──────────────────────────────────
  googleCalendarEnabled: boolean;
  googleCalendarOAuthClientId: string;
  googleCalendarAccessToken: string;
  googleCalendarRefreshToken: string;
  googleCalendarTokenExpiresAt: string;
  googleCalendarId: string;
  googleCalendarReminderMinutes: number;
  googleCalendarUseDefaultReminders: boolean;
  googleCalendarDryRun: boolean;

  // ── Feature: AI query expansion ─────────────────────────────────────────
  aiQueryEnabled: boolean;
  aiQueryApiKey: string;
  /** Explicit opt-in for direct client-side Anthropic requests; never enabled by migration. */
  aiQueryAnthropicBrowserAccess: boolean;
  aiQueryModel: string;
  aiQueryProvider: AiQueryProvider;
  /** Base URL for local OpenAI-compatible providers such as Ollama or LM Studio. */
  aiQueryLocalEndpoint: string;

  // ── Feature: Weekly review ───────────────────────────────────────────────
  weeklyReviewInboxPath: string;
  weeklyReviewEnabled: boolean;

  // ── Feature: Pomodoro write-back ─────────────────────────────────────────
  /** When true, completed Pomodoro work sessions accumulate into the task's 🕐 actual field. */
  pomodoroLogActualTime: boolean;

  // ── Feature: Habit tracking ──────────────────────────────────────────────
  /** Enable the Habits tab in the task panel sidebar. */
  habitTrackingEnabled: boolean;

  // ── Feature: Gamification ────────────────────────────────────────────────
  /** Show achievements and point totals in the Stats view. */
  gamificationEnabled: boolean;
  
  // ── Feature: Capacity analytics ────────────────────────────────────────────
  /** Daily capacity in minutes (for capacity warnings and weekly summary). 0 = disabled. */
  dailyCapacityMinutes: number;

  // ── Feature: DSL security (#4) ────────────────────────────────────────────
  /** When false, filter/sort/group by function expressions are disabled. Default true. */
  enableDslExpressions: boolean;
  // ── Feature: Configurable log entry template (#11) ───────────────────────
  /** Mustache-style template for log entries. Empty = use legacy format. */
  logEntryTemplate: string;
  // ── Feature: Daily stats summary (#17) ───────────────────────────────────
  dailyStatsSummaryEnabled: boolean;
  dailyStatsSummaryTemplate: string;
  // ── Feature: Mutation Log for Automation Safety ──────────────────────────
  mutationLogEnabled: boolean;
  mutationLogFile: string;
  mutationLogMaxEntries: number;
  // ── Feature: File-scoped defaults (#6) ───────────────────────────────────
  fileDefaultsEnabled: boolean;
  fileDefaultsPropertyPrefix: string;
  // ── Feature: CalDAV/ICS import (#9) ──────────────────────────────────────
  icalImportUrl: string;
  icalImportTargetPath: string;
  // ── Feature: ICS feed export (PRD P1 #13) ────────────────────────────────
  /** Path inside the vault where the published ICS feed file is written. */
  icsExportPath: string;
  // ── Feature: CalDAV Bidirectional Sync (#D1) ──────────────────────────────
  caldavSyncEnabled: boolean;
  caldavServerUrl: string;
  /** Explicit consent for localhost, link-local, and private-address CalDAV endpoints. */
  caldavAllowPrivateNetwork: boolean;
  caldavUsername: string;
  caldavPassword: string;
  caldavCalendarPath: string;
  /** Vault note where tasks pulled from the CalDAV server are written (managed section), and read from for outbound sync. */
  caldavVaultPath: string;
  // ── Feature: Apple Reminders (#10) ───────────────────────────────────────
  appleRemindersEnabled: boolean;
  appleRemindersListName: string;
  /** Exact Apple Shortcut name launched by the export command. */
  appleRemindersShortcutName: string;
  appleRemindersInboxPath: string;
  /** Enable the Apple Reminders Shortcuts/webhook import bridge. */
  appleRemindersWebhookEnabled: boolean;
  /** Optional shared secret expected in webhook/import payloads. */
  appleRemindersWebhookSecret: string;
  // ── Feature: MS To Do (#10) ───────────────────────────────────────────────
  msToDoEnabled: boolean;
  msToDoClientId: string;
  /** Optional Microsoft To Do list ID. Leave blank to resolve the default list via Graph. */
  msToDoListId: string;
  /** OAuth access token for Microsoft To Do. Stored only when users opt in to the experimental sync. */
  msToDoToken: string;
  /** Optional Microsoft OAuth refresh token. Used to refresh expired access tokens. */
  msToDoRefreshToken: string;
  /** ISO timestamp when the Microsoft To Do access token expires. */
  msToDoTokenExpiresAt: string;
  msToDoInboxPath: string;
  // ── Feature: Sync conflict direction (#20) ───────────────────────────────
  syncConflictDirection: 'vault-first' | 'service-first';
  // ── Feature: Datacore (#21) ──────────────────────────────────────────────
  datacoreEnabled: boolean;
  // ── Feature: Inline progress bars (#2) ───────────────────────────────────
  inlineProgressBarsEnabled: boolean;
  // ── Feature: JSON/YAML export paths (#22) ────────────────────────────────
  jsonExportPath: string;
  yamlExportPath: string;
  csvExportPath: string;
  // ── Feature: Follow-up watch date emoji (#23) ────────────────────────────
  followUpEmoji: string;

  // ── Feature: Workflow automation ────────────────────────────────────────
  /** When true, completing a task with a workflow trigger tag auto-creates the next step. */
  workflowsEnabled: boolean;
  /** Configured workflows. */
  workflows: WorkflowDefinition[];

  // ── Feature: Org-mode compatibility ─────────────────────────────────────
  /** When true, recognise `- TODO: task`, `- DONE: task` etc. as checkbox tasks. */
  orgModeEnabled: boolean;

  // ── Feature: Sync conflict report ───────────────────────────────────────
  /** Path for the sync conflict report note (relative to vault root). */
  syncConflictLogPath: string;

  // ── Feature: Sync health tracking ──────────────────────────────────────────
  /** Persisted summaries of recent sync runs for diagnostics/observability. */
  syncRunHistory: SyncRunSummary[];
  /** Timestamp of last successful Todoist sync (ISO 8601 format). */
  syncLastSuccessTodoist: string;
  /** Timestamp of last successful Google Tasks sync (ISO 8601 format). */
  syncLastSuccessGoogleTasks: string;
  /** Timestamp of last successful Google Calendar sync (ISO 8601 format). */
   syncLastSuccessGoogleCalendar: string;
  /** Timestamp of last successful Apple Reminders sync (ISO 8601 format). */
  syncLastSuccessAppleReminders: string;
  /** Timestamp of last successful Microsoft To Do sync (ISO 8601 format). */
  syncLastSuccessMsToDo: string;
  /** Timestamp of last successful CalDAV sync (ISO 8601 format). */
  syncLastSuccessCalDAV: string;
  
  // ── Feature: Dry-run mode for experimental services ────────────────────────
  /** Enable dry-run mode for Google Tasks sync (logs changes without committing). */
  googleTasksDryRun: boolean;
  /** Enable dry-run mode for Apple Reminders sync (logs changes without committing). */
  appleRemindersDryRun: boolean;
  /** Enable dry-run mode for Microsoft To Do sync (logs changes without committing). */
  msToDoDryRun: boolean;

  // ── Feature: Missed reminder log ─────────────────────────────────────────
  /** When true, reminders detected as missed after execution resumes are written to today's daily note. */
  missedReminderLogEnabled: boolean;
  // ── Feature: Scan scope exclusions (#1) ──────────────────────────────────
  /**
   * Folder paths excluded from vault scanning.
   * Each entry is a path prefix (e.g. "Templates" or "Archive/2023").
   * Matching is case-insensitive; leading and trailing slashes are ignored.
   */
  excludedFolders: string[];

  // ── Feature: Auto-generate task ID (#2) ───────────────────────────────────
  /** When true, the create/edit modal automatically assigns a 🆔 ID to every new task. */
  autoGenerateTaskId: boolean;

  // ── Feature: Skip-to-future recurrence (#9) ───────────────────────────────
  /**
   * When true, completing a recurring task whose next fixed-interval occurrence
   * falls in the past advances through the schedule until the next date is in
   * the future. Does not apply to `when done` rules.
   */
  recurrenceSkipToFuture: boolean;

  // ── Feature: Postpone preferred field (#10) ───────────────────────────────
  /**
   * Controls which date field the postpone button targets.
   * `'auto'` (default) = due → scheduled → start (first populated field).
   */
  postponePreferredField: 'auto' | 'due' | 'scheduled' | 'start';

  // ── Feature: Configurable urgency weights (#23) ────────────────────────────
  /** Coefficients used in the urgency score formula. */
  urgencyWeights: UrgencyWeights;

  // ── Feature: Health Report thresholds ──────────────────────────────────────
  /** Number of days a task can be in-progress before being marked as stale (default: 30). */
  staleTaskThresholdDays: number;
  /** Number of days overdue a task must be before being flagged (default: 0 = any overdue). */
  overdueTaskThresholdDays: number;
  /** Optional OpenAI Whisper API key for voice-to-text fallback when Web Speech API is unavailable. */
  whisperApiKey: string;
  /** URLs of ICS calendars to fetch and display on timeline. */
  icsOverlayUrls: string[];
  /** Refresh interval for ICS overlay in minutes. */
  icsOverlayRefreshMinutes: number;
  /** Enable the status bar widget showing current/next task. */
  statusBarNowNextEnabled: boolean;
  /** Allow external obsidian:// Task Manager actions to mutate or focus this vault. */
  externalUriActionsEnabled: boolean;
  /** Shared secret required by enabled external URI actions. */
  externalUriActionSecret: string;
  /** Show a Pinned tab in the task sidebar panel for active 📌 tasks. */
  pinnedDockEnabled: boolean;
  /** Enable snooze options when reminders fire. */
  reminderSnoozeEnabled: boolean;
  /** Snooze presets available to users (minutes). */
  reminderSnoozePresets: number[];
  /** Enable quiet hours suppression of notifications. */
  quietHoursEnabled: boolean;
  /** Quiet hours start time (HH:MM in 24h format, e.g. "22:00"). */
  quietHoursStart: string;
  /** Quiet hours end time (HH:MM in 24h format, e.g. "08:00"). */
  quietHoursEnd: string;

  // ── Feature: Appearance / theming ──────────────────────────────────────────
  taskFontSize: TaskFontSize;
  taskDensity: TaskDensity;
  dashboardDensity: TaskDensity;
  priorityColorOverrides: Record<string, string>;
  statusColorOverrides: Record<string, string>;
  showPriorityPills: boolean;
  showStatusIcons: boolean;

  // ── Feature: Dashboard widget builder ──────────────────────────────────────
  /** Dashboard layouts keyed by workspace/layout ID. */
  dashboardLayouts: Record<string, DashboardLayout>;
  /** Dashboard shown when opening the dashboard view. */
  activeDashboardId: string;
  /** User-created reusable dashboard templates keyed by template ID. */
  dashboardTemplates: Record<string, DashboardTemplate>;
  /** Visual treatment for the dashboard surface. */
  dashboardTheme: DashboardTheme;
  /** When true (default), dashboard card heights are derived from their content and columns auto-compact. */
  dashboardAutoFitHeights: boolean;
  /** Time window emphasised by agenda-style dashboard widgets. */
  dashboardScope: DashboardScope;
  /** Target number of tasks to complete per day, used by the daily-goal widget. */
  dashboardDailyGoal: number;
  /** Available focus minutes per day, used by the capacity-planner and schedule-conflicts widgets. */
  dashboardCapacityMinutes: number;
  /** Tag prefix that defines a goal for the goals widget; e.g. "goal" matches #goal/<name>. */
  dashboardGoalTagPrefix: string;
  /** Tag prefix that defines an area of responsibility; e.g. "area" matches #area/<name>. */
  dashboardAreaTagPrefix: string;
  /** User-defined task fields parsed from Dataview inline fields and file frontmatter. */
  customFieldDefinitions: CustomFieldDefinition[];
  /** Persistent Kanban boards and grouping configurations. */
  kanbanBoards: KanbanBoardConfig[];
  /** Active Kanban board ID for dedicated board surfaces. */
  activeKanbanBoardId: string;
  /** Shared saved-view preset store that backs table filters and kanban boards. */
  savedViewPresets?: SavedViewPreset[];
  /** Persistent table-view state such as saved filters, custom columns and hierarchy mode. */
  tableViewConfig: TableViewConfig;
  /** Show recurring-task heatmaps in rich task views. */
  recurringHeatmapEnabled: boolean;
  /** Render settings in a tabbed/card layout instead of one long list. */
  settingsTabsEnabled: boolean;
}

/**
 * Mobile and Accessibility Utilities
 */
export const MobileA11y = {
  /**
   * Detect if running on mobile platform (iOS or Android)
   */
  isMobile(): boolean {
    if (typeof window === 'undefined') return false;
    // Use Obsidian's Platform API for accurate iOS/Android detection.
    if (typeof Platform !== 'undefined') {
      return Platform.isIosApp || Platform.isAndroidApp;
    }
    // User agent fallback (e.g. in test environments).
    const ua = navigator.userAgent.toLowerCase();
    return /iphone|ipad|android/.test(ua);
  },

  /**
   * Get tap target minimum size in pixels (WCAG AA requires 44x44)
   */
  MIN_TAP_TARGET: 44,

  /**
   * Get swipe detection threshold in pixels (50px for mobile)
   */
  SWIPE_THRESHOLD: 50,

  /**
   * Create ARIA label for task checkbox
   */
  createCheckboxLabel(taskText: string, isComplete: boolean): string {
    const status = isComplete ? 'completed' : 'pending';
    return `Toggle task: ${taskText} (${status})`;
  },

  /**
   * Create ARIA label for button with keyboard hint
   */
  createButtonLabel(action: string, key?: string): string {
    if (key) {
      return `${action} (keyboard: ${key})`;
    }
    return action;
  },
};

/**
 * Default supported states. The four core entries (` `, `/`, `x`, `-`) mirror
 * upstream Tasks' DEFAULT_STATUSES exactly in name, nextStatusSymbol, type and
 * availableAsCommand. The remaining three (`!`, `?`, `>`) are local-only
 * extensions for blocked/deferred semantics.
 */
export const DEFAULT_TASK_STATES: TaskStateDefinition[] = [
  { rawText: ' ', name: 'Todo', icon: '', type: 'todo', nextStatusSymbol: 'x', availableAsCommand: true },
  { rawText: '/', name: 'In Progress', icon: '', type: 'in_progress', nextStatusSymbol: 'x', availableAsCommand: true },
  { rawText: 'x', name: 'Done', icon: '', type: 'done', nextStatusSymbol: ' ', availableAsCommand: true },
  { rawText: '>', name: 'Deferred', icon: '', type: 'deferred', nextStatusSymbol: 'x', availableAsCommand: true },
  { rawText: '?', name: 'Waiting', icon: '', type: 'blocked', nextStatusSymbol: 'x', availableAsCommand: true },
  { rawText: '!', name: 'Blocked', icon: '', type: 'blocked', nextStatusSymbol: 'x', availableAsCommand: true },
  { rawText: '-', name: 'Cancelled', icon: '', type: 'cancelled', nextStatusSymbol: ' ', availableAsCommand: true },
];

export const DEFAULT_SAVED_QUERIES: SavedTaskQuery[] = [
  { name: 'this_file', query: 'path includes {{query.file.path}}' },
  { name: 'this_folder', query: 'folder includes {{query.file.folder}}' },
  { name: 'this_folder_only', query: 'filter by function task.file.folder === query.file.folder' },
  { name: 'this_root', query: 'root includes {{query.file.root}}' },
  { name: 'hide_date_fields', query: '# Hide any values for all date fields\nhide due date\nhide scheduled date\nhide start date\nhide created date\nhide done date\nhide cancelled date' },
  { name: 'hide_non_date_fields', query: '# Hide all the non-date fields, but not tags\nhide id\nhide depends on\nhide recurrence rule\nhide on completion\nhide priority' },
  { name: 'hide_query_elements', query: '# Hide toolbar, postpone, edit and backlinks\nhide toolbar\nhide postpone button\nhide edit button\nhide backlinks' },
  { name: 'hide_everything', query: '# Hide everything except description and any tags\npreset hide_date_fields\npreset hide_non_date_fields\npreset hide_query_elements' },
];

export const DEFAULT_MODAL_FIELDS: ModalFieldVisibility = {
  priority: true,
  due: true,
  scheduled: true,
  start: true,
  created: true,
  done: true,
  cancelled: true,
  reminder: true,
  recurrence: true,
  onCompletion: true,
  id: true,
  before_this: true,
  after_this: true,
  time: true,
  effort: false,
  actual: false,
  followUp: false,
  cost: false,
  pinned: false,
};

export const TASK_STATE_COLLECTIONS: TaskStateCollection[] = [
  {
    name: 'AnuPpuccin Theme',
    description: 'AnuPpuccin theme alternate checkbox markers.',
    states: [
      { rawText: ' ', name: 'Unchecked', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'x', name: 'Checked', icon: '', type: 'done', nextStatusSymbol: ' ' },
      { rawText: '>', name: 'Rescheduled', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: '<', name: 'Scheduled', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: '!', name: 'Important', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: '-', name: 'Cancelled', icon: '', type: 'cancelled', nextStatusSymbol: ' ' },
      { rawText: '/', name: 'In Progress', icon: '', type: 'in_progress', nextStatusSymbol: 'x' },
      { rawText: '?', name: 'Question', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: '*', name: 'Star', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'n', name: 'Note', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'l', name: 'Location', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'i', name: 'Information', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'I', name: 'Idea', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'S', name: 'Amount', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'p', name: 'Pro', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'c', name: 'Con', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'b', name: 'Bookmark', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: '"', name: 'Quote', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: '0', name: 'Speech bubble 0', icon: '', type: 'untracked', nextStatusSymbol: '0' },
      { rawText: '1', name: 'Speech bubble 1', icon: '', type: 'untracked', nextStatusSymbol: '1' },
      { rawText: '2', name: 'Speech bubble 2', icon: '', type: 'untracked', nextStatusSymbol: '2' },
      { rawText: '3', name: 'Speech bubble 3', icon: '', type: 'untracked', nextStatusSymbol: '3' },
      { rawText: '4', name: 'Speech bubble 4', icon: '', type: 'untracked', nextStatusSymbol: '4' },
      { rawText: '5', name: 'Speech bubble 5', icon: '', type: 'untracked', nextStatusSymbol: '5' },
      { rawText: '6', name: 'Speech bubble 6', icon: '', type: 'untracked', nextStatusSymbol: '6' },
      { rawText: '7', name: 'Speech bubble 7', icon: '', type: 'untracked', nextStatusSymbol: '7' },
      { rawText: '8', name: 'Speech bubble 8', icon: '', type: 'untracked', nextStatusSymbol: '8' },
      { rawText: '9', name: 'Speech bubble 9', icon: '', type: 'untracked', nextStatusSymbol: '9' },
    ],
  },
  {
    name: 'Aura Theme',
    description: 'Aura theme alternate checkbox markers.',
    states: [
      { rawText: ' ', name: 'incomplete', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'x', name: 'complete / done', icon: '', type: 'done', nextStatusSymbol: ' ' },
      { rawText: '-', name: 'cancelled', icon: '', type: 'cancelled', nextStatusSymbol: ' ' },
      { rawText: '>', name: 'deferred', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: '/', name: 'in progress, or half-done', icon: '', type: 'in_progress', nextStatusSymbol: 'x' },
      { rawText: '!', name: 'Important', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: '?', name: 'question', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'R', name: 'review', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: '+', name: 'Inbox / task that should be processed later', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'b', name: 'bookmark', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'B', name: 'brainstorm', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'D', name: 'deferred or scheduled', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'I', name: 'Info', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'i', name: 'idea', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'N', name: 'note', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'Q', name: 'quote', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'W', name: 'win / success / reward', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'P', name: 'pro', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'C', name: 'con', icon: '', type: 'todo', nextStatusSymbol: 'x' },
    ],
  },
  {
    name: 'Border Theme',
    description: 'Border theme alternate checkbox markers.',
    states: [
      { rawText: ' ', name: 'To Do', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: '/', name: 'In Progress', icon: '', type: 'in_progress', nextStatusSymbol: 'x' },
      { rawText: 'x', name: 'Done', icon: '', type: 'done', nextStatusSymbol: ' ' },
      { rawText: '-', name: 'Cancelled', icon: '', type: 'cancelled', nextStatusSymbol: ' ' },
      { rawText: '>', name: 'Rescheduled', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: '<', name: 'Scheduled', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: '!', name: 'Important', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: '?', name: 'Question', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'i', name: 'Information', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'S', name: 'Amount', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: '*', name: 'Star', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'b', name: 'Bookmark', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: '"', name: 'Quote', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'n', name: 'Note', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'l', name: 'Location', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'I', name: 'Idea', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'p', name: 'Pro', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'c', name: 'Con', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'u', name: 'Up', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'd', name: 'Down', icon: '', type: 'todo', nextStatusSymbol: 'x' },
    ],
  },
  {
    name: 'Ebullientworks Theme',
    description: 'Ebullientworks theme alternate checkbox markers.',
    states: [
      { rawText: ' ', name: 'Unchecked', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'x', name: 'Checked', icon: '', type: 'done', nextStatusSymbol: ' ' },
      { rawText: '-', name: 'Cancelled', icon: '', type: 'cancelled', nextStatusSymbol: ' ' },
      { rawText: '/', name: 'In Progress', icon: '', type: 'in_progress', nextStatusSymbol: 'x' },
      { rawText: '>', name: 'Deferred', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: '!', name: 'Important', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: '?', name: 'Question', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'r', name: 'Review', icon: '', type: 'todo', nextStatusSymbol: 'x' },
    ],
  },
  {
    name: 'LYT Mode Theme',
    description: 'LYT Mode theme alternate checkbox markers.',
    states: [
      { rawText: ' ', name: 'Unchecked', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'x', name: 'Checked', icon: '', type: 'done', nextStatusSymbol: ' ' },
      { rawText: '>', name: 'Rescheduled', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: '<', name: 'Scheduled', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: '!', name: 'Important', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: '-', name: 'Cancelled', icon: '', type: 'cancelled', nextStatusSymbol: ' ' },
      { rawText: '/', name: 'In Progress', icon: '', type: 'in_progress', nextStatusSymbol: 'x' },
      { rawText: '?', name: 'Question', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: '*', name: 'Star', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'n', name: 'Note', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'l', name: 'Location', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'i', name: 'Information', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'I', name: 'Idea', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'S', name: 'Amount', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'p', name: 'Pro', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'c', name: 'Con', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'b', name: 'Bookmark', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'f', name: 'Fire', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'k', name: 'Key', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'w', name: 'Win', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'u', name: 'Up', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'd', name: 'Down', icon: '', type: 'todo', nextStatusSymbol: 'x' },
    ],
  },
  {
    name: 'Things Theme',
    description: 'Things theme alternate checkbox markers.',
    states: [
      { rawText: ' ', name: 'to-do', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: '/', name: 'incomplete', icon: '', type: 'in_progress', nextStatusSymbol: 'x' },
      { rawText: 'x', name: 'done', icon: '', type: 'done', nextStatusSymbol: ' ' },
      { rawText: '-', name: 'canceled', icon: '', type: 'cancelled', nextStatusSymbol: ' ' },
      { rawText: '>', name: 'forwarded', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: '<', name: 'scheduling', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: '?', name: 'question', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: '!', name: 'important', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: '*', name: 'star', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: '"', name: 'quote', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'l', name: 'location', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'b', name: 'bookmark', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'i', name: 'information', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'S', name: 'savings', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'I', name: 'idea', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'p', name: 'pros', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'c', name: 'cons', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'f', name: 'fire', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'k', name: 'key', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'w', name: 'win', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'u', name: 'up', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'd', name: 'down', icon: '', type: 'todo', nextStatusSymbol: 'x' },
    ],
  },
  {
    name: 'Minimal Theme',
    description: 'Minimal theme alternate checkbox markers.',
    states: [
      { rawText: ' ', name: 'to-do', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: '/', name: 'incomplete', icon: '', type: 'in_progress', nextStatusSymbol: 'x' },
      { rawText: 'x', name: 'done', icon: '', type: 'done', nextStatusSymbol: ' ' },
      { rawText: '-', name: 'canceled', icon: '', type: 'cancelled', nextStatusSymbol: ' ' },
      { rawText: '>', name: 'forwarded', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: '<', name: 'scheduling', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: '?', name: 'question', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: '!', name: 'important', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: '*', name: 'star', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: '"', name: 'quote', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'l', name: 'location', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'b', name: 'bookmark', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'i', name: 'information', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'S', name: 'savings', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'I', name: 'idea', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'p', name: 'pros', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'c', name: 'cons', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'f', name: 'fire', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'k', name: 'key', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'w', name: 'win', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'u', name: 'up', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'd', name: 'down', icon: '', type: 'todo', nextStatusSymbol: 'x' },
    ],
  },
  {
    name: 'ITS / SlRvb Theme',
    description: 'ITS theme and SlRvb Alternate Checkboxes markers.',
    states: [
      { rawText: ' ', name: 'Unchecked', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'x', name: 'Regular', icon: '', type: 'done', nextStatusSymbol: ' ' },
      { rawText: 'X', name: 'Checked', icon: '', type: 'done', nextStatusSymbol: ' ' },
      { rawText: '-', name: 'Dropped', icon: '', type: 'cancelled', nextStatusSymbol: ' ' },
      { rawText: '>', name: 'Forward', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: '<', name: 'Migrated', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'D', name: 'Date', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: '?', name: 'Question', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: '/', name: 'Half Done', icon: '', type: 'in_progress', nextStatusSymbol: 'x' },
      { rawText: '+', name: 'Add', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'R', name: 'Research', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: '!', name: 'Important', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'i', name: 'Idea', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'B', name: 'Brainstorm', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'P', name: 'Pro', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'C', name: 'Con', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'Q', name: 'Quote', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'N', name: 'Note', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'b', name: 'Bookmark', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'I', name: 'Information', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'p', name: 'Paraphrase', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'L', name: 'Location', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'E', name: 'Example', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'A', name: 'Answer', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'r', name: 'Reward', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'c', name: 'Choice', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'd', name: 'Doing', icon: '', type: 'in_progress', nextStatusSymbol: 'x' },
      { rawText: 'T', name: 'Time', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: '@', name: 'Character / Person', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 't', name: 'Talk', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'O', name: 'Outline / Plot', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: '~', name: 'Conflict', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'W', name: 'World', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'f', name: 'Clue / Find', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'F', name: 'Foreshadow', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 'H', name: 'Favorite / Health', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: '&', name: 'Symbolism', icon: '', type: 'todo', nextStatusSymbol: 'x' },
      { rawText: 's', name: 'Secret', icon: '', type: 'todo', nextStatusSymbol: 'x' },
    ],
  },
];

export const DEFAULT_DEFER_PRESETS: DeferPreset[] = [
  { label: '1 day', days: 1 },
  { label: '1 week', weeks: 1 },
  { label: '3 weeks', weeks: 3 },
  { label: '1 month', months: 1 },
];

export const DEFAULT_TABLE_VIEW_CONFIG: TableViewConfig = {
  savedFilters: [],
  customColumns: [],
  showHierarchy: true,
  visibleColumns: [],
};

export const DEFAULT_KANBAN_BOARDS: KanbanBoardConfig[] = [
  {
    id: 'default-status-board',
    name: 'Status Board',
    query: 'not done',
    groupBy: 'status',
    columns: [],
    background: '',
  },
];

export const DEFAULT_SETTINGS: TaskManagerSettings = {
  preferredLocale: 'en',
  onboardingVersionSeen: 0,
  autoCompleteParent: false,
  autoAdvanceParentToInProgress: false,
  autoAdvanceParentOnAllCancelled: false,
  customPriorities: [],
  futureOccurrenceCount: 3,
  trackRecurrenceCount: false,
  useSystemNotifications: false,
  taskNoteFolder: 'Tasks/',
  taskNoteFolders: '',
  taskNoteMarker: 'task: true',
  todoistApiKey: '',
  todoistProjectId: '',
  todoistSyncEnabled: false,
  todoistDryRun: false,
  todoistInboxPath: 'Todoist Inbox.md',
  enableBasesIntegration: false,
  basesAutoRefreshEnabled: false,
  basesRefreshDebounceMs: 500,
  nlpQueryEnabled: false,
  kanbanFileWritebackEnabled: false,
  dailyPlanHeading: 'Daily Plan',
  planningBoardEnabled: true,
  planningBoardSidebarEnabled: true,
  planningBoardMaxUndoStack: 10,
  planningBoardDragEnabled: true,
  pomodoroWorkMinutes: 25,
  pomodoroBreakMinutes: 5,
  pomodoroLongBreakMinutes: 15,
  pomodoroLongBreakAfter: 4,
  googleTasksEnabled: false,
  googleTasksOAuthClientId: '',
  googleTasksAccessToken: '',
  googleTasksRefreshToken: '',
  googleTasksTokenExpiresAt: '',
  googleTasksApiKey: '',
  googleTasksListId: '',
  googleTasksInboxPath: 'Google Tasks Inbox.md',
  googleCalendarEnabled: false,
  googleCalendarOAuthClientId: '',
  googleCalendarAccessToken: '',
  googleCalendarRefreshToken: '',
  googleCalendarTokenExpiresAt: '',
  googleCalendarId: 'primary',
  googleCalendarReminderMinutes: 10,
  googleCalendarUseDefaultReminders: false,
  googleCalendarDryRun: false,
  aiQueryEnabled: false,
  aiQueryApiKey: '',
  aiQueryAnthropicBrowserAccess: false,
  aiQueryModel: 'gpt-4o-mini',
  aiQueryProvider: 'openai',
  aiQueryLocalEndpoint: 'http://localhost:11434/v1/chat/completions',
  weeklyReviewInboxPath: '',
  weeklyReviewEnabled: false,
  dateTimeOnLifecycleDates: false,
  pomodoroLogActualTime: false,
  habitTrackingEnabled: false,
  gamificationEnabled: false,
  dailyCapacityMinutes: 480, // Default 8 hours = 480 minutes
  enableDslExpressions: false,
  logEntryTemplate: '',
  dailyStatsSummaryEnabled: false,
  dailyStatsSummaryTemplate: '> ✅ {{total}} tasks completed',
  mutationLogEnabled: false,
  mutationLogFile: '.mutation-log.jsonl',
  mutationLogMaxEntries: 10000,
  fileDefaultsEnabled: true,
  fileDefaultsPropertyPrefix: 'task_',
  workflowsEnabled: false,
  workflows: [],
  orgModeEnabled: false,
  syncConflictLogPath: 'Sync Conflicts.md',
  missedReminderLogEnabled: true,
  icalImportUrl: '',
  icalImportTargetPath: 'Calendar Import.md',
  icsExportPath: 'Task Feed.ics',
  caldavSyncEnabled: false,
  caldavServerUrl: '',
  caldavAllowPrivateNetwork: false,
  caldavUsername: '',
  caldavPassword: '',
  caldavCalendarPath: '/calendar.ics/',
  caldavVaultPath: 'CalDAV Sync.md',
  appleRemindersEnabled: false,
  appleRemindersListName: '',
  appleRemindersShortcutName: 'Export Reminders to Obsidian',
  appleRemindersInboxPath: 'Reminders Inbox.md',
  appleRemindersWebhookEnabled: false,
  appleRemindersWebhookSecret: '',
  msToDoEnabled: false,
  msToDoClientId: '',
  msToDoListId: '',
  msToDoToken: '',
  msToDoRefreshToken: '',
  msToDoTokenExpiresAt: '',
  msToDoInboxPath: 'MS To Do Inbox.md',
  syncConflictDirection: 'vault-first',
  // Sync health tracking
  syncRunHistory: [],
  syncLastSuccessTodoist: '',
  syncLastSuccessGoogleTasks: '',
  syncLastSuccessGoogleCalendar: '',
  syncLastSuccessAppleReminders: '',
  syncLastSuccessMsToDo: '',
  syncLastSuccessCalDAV: '',
  // Dry-run modes for experimental services
  googleTasksDryRun: false,
  appleRemindersDryRun: false,
  msToDoDryRun: false,
  datacoreEnabled: false,
  inlineProgressBarsEnabled: false,
  jsonExportPath: 'Tasks Export.json',
  yamlExportPath: 'Tasks Export.yaml',
  csvExportPath: 'Tasks Export.csv',
  followUpEmoji: '👀',
  enableFileEvents: true,
  enablePeriodicScan: true,
  scanIntervalMinutes: 3,
  completionLoggingEnabled: false,
  logSectionHeading: 'Log',
  includeCompletionTime: true,
  logTimeFormat: 'HH:mm',
  includeSourceLinkWhenNotDailyNote: true,
  globalFilter: '',
  globalQuery: '',
  removeGlobalFilterFromDescription: false,
  enableQueryDsl: true,
  taskFormat: 'emoji',
  taskCountLocation: 'bottom',
  queryCodeBlockName: 'task-list',
  tasksCodeBlockMode: 'when-upstream-absent',
  defaultSort: 'smart',
  autoSuggestInEditor: true,
  autoSuggestMinMatch: 0,
  autoSuggestMaxItems: 20,
  slashCommandsInEditor: true,
  atAssigneeInEditor: true,
  taskLineToolbarEnabled: true,
  provideAccessKeys: false,
  setCreatedDate: false,
  setDoneDate: true,
  setCancelledDate: true,
  recurrenceFutureOccurrences: 1,
  recurrenceInsertLocation: 'before',
  removeScheduledDateOnRecurrence: false,
  recurrenceOnCancelled: true,
  archiveFilePath: 'Archive.md',
  archiveHeading: 'Archived Tasks',
  dateOutputAsWikiLinks: false,
  dateFormat: 'plain',
  dateDisplayFormat: '',
  subtaskDateInheritance: false,
  collectFilePath: 'Completed.md',
  collectHeading: 'Collected Tasks',
  treeFilteredView: false,
  enableReminderNotifications: false,
  reminderCheckIntervalMinutes: 1,
  quickCaptureInboxPath: '',
  taskTemplates: [],
  enableMobileGestures: true,
  showActionNotifications: false,
  nlInlineConversionEnabled: true,
  nlTaskPrefix: '!!',
  kanbanRules: [],
  wipLimits: [],
  showWipWarning: true,
  useFilenameAsScheduledDate: false,
  filenameScheduledDateFormat: '',
  filenameScheduledDateFolders: '',
  supportedStates: DEFAULT_TASK_STATES,
  savedQueries: DEFAULT_SAVED_QUERIES,
  modalFields: DEFAULT_MODAL_FIELDS,
  deferPresets: DEFAULT_DEFER_PRESETS,
  // New settings added for gap items
  excludedFolders: [],
  autoGenerateTaskId: false,
  recurrenceSkipToFuture: false,
  postponePreferredField: 'auto',
  urgencyWeights: { due: 12.0, priority: 6.0, scheduled: 5.0, start: -3.0 },
  staleTaskThresholdDays: 30,
  overdueTaskThresholdDays: 0,
  whisperApiKey: '',
  icsOverlayUrls: [],
  icsOverlayRefreshMinutes: 30,
  statusBarNowNextEnabled: true,
  externalUriActionsEnabled: false,
  externalUriActionSecret: '',
  pinnedDockEnabled: false,
  reminderSnoozeEnabled: true,
  reminderSnoozePresets: [5, 15, 60, 1440],
  quietHoursEnabled: false,
  quietHoursStart: '22:00',
  quietHoursEnd: '08:00',
  taskFontSize: 'normal',
  taskDensity: 'comfortable',
  dashboardDensity: 'comfortable',
  priorityColorOverrides: {},
  statusColorOverrides: {},
  showPriorityPills: true,
  showStatusIcons: true,
  dashboardLayouts: {},
  activeDashboardId: 'default',
  dashboardTemplates: {},
  dashboardTheme: 'native',
  dashboardAutoFitHeights: true,
  dashboardScope: 'today',
  dashboardDailyGoal: 5,
  dashboardCapacityMinutes: 360,
  dashboardGoalTagPrefix: 'goal',
  dashboardAreaTagPrefix: 'area',
  customFieldDefinitions: [],
  kanbanBoards: DEFAULT_KANBAN_BOARDS,
  activeKanbanBoardId: 'default-status-board',
  tableViewConfig: DEFAULT_TABLE_VIEW_CONFIG,
  recurringHeatmapEnabled: true,
  settingsTabsEnabled: true,
};

/**
 * Re-export all normalisation functions from settings-normalizer.
 * Keeping types.ts as the single import surface means no other file
 * needs to change its import paths.
 */
import {
  configureSettingsNormalizer,
  normalizeTaskManagerSettings,
  normalizeCustomFieldDefinitions,
  normalizeCustomPriorities,
  normalizeTaskTemplates,
  normalizeModalFields,
  normalizeDeferPresets,
  normalizeSavedQueries,
  normalizeKanbanRules,
  normalizeWipLimits,
  mergeTaskStateCollection,
  normalizeTaskStates,
  defaultTaskStateIcon,
  resolvedTaskStateIcon,
  shouldOverrideTaskStateIcon,
} from './settings-normalizer';

configureSettingsNormalizer({
  applyAiProviderDefaults,
  defaultAiEndpointForProvider,
  DEFAULT_DEFER_PRESETS,
  DEFAULT_KANBAN_BOARDS,
  DEFAULT_MODAL_FIELDS,
  DEFAULT_SAVED_QUERIES,
  DEFAULT_SETTINGS,
  DEFAULT_TABLE_VIEW_CONFIG,
  DEFAULT_TASK_STATES,
});

export {
  normalizeTaskManagerSettings,
  normalizeCustomFieldDefinitions,
  normalizeCustomPriorities,
  normalizeTaskTemplates,
  normalizeModalFields,
  normalizeDeferPresets,
  normalizeSavedQueries,
  normalizeKanbanRules,
  normalizeWipLimits,
  mergeTaskStateCollection,
  normalizeTaskStates,
  defaultTaskStateIcon,
  resolvedTaskStateIcon,
  shouldOverrideTaskStateIcon,
};
