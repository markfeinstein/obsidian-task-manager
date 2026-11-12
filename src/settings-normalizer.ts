/**
 * Settings normalisation functions.
 *
 * Extracted from types.ts to keep that file focused on declarations.
 * Everything in this module is re-exported from ./types so callers do not
 * need to change their import paths.
 */

import { isSafeLocalAiEndpoint } from './ai-endpoint-safety';
import { isLocaleSelectable } from './i18n';
import type { CustomFieldDefinition } from './custom-fields-sync';
import type {
  AiQueryProvider,
  CustomPriority,
  DeferPreset,
  KanbanAutomationRule,
  KanbanBoardConfig,
  KanbanBoardGroupBy,
  ModalFieldVisibility,
  ModalFieldVisibilityKey,
  SavedTaskQuery,
  SavedViewPreset,
  TableCustomColumn,
  TableCustomColumnType,
  TableSavedFilter,
  TableViewConfig,
  TaskManagerSettings,
  TaskQueryDefaultSort,
  TasksCodeBlockMode,
  TaskStateCollection,
  TaskStateDefinition,
  TaskStateType,
  TaskTemplate,
  UrgencyWeights,
  WipLimitConfig,
  WorkflowDefinition,
} from './types';

export interface SettingsNormalizerRuntime {
  applyAiProviderDefaults<T extends { aiQueryProvider: AiQueryProvider; aiQueryModel: string; aiQueryLocalEndpoint: string }>(settings: T, provider: AiQueryProvider): void;
  defaultAiEndpointForProvider(provider: AiQueryProvider): string;
  DEFAULT_DEFER_PRESETS: DeferPreset[];
  DEFAULT_KANBAN_BOARDS: KanbanBoardConfig[];
  DEFAULT_MODAL_FIELDS: ModalFieldVisibility;
  DEFAULT_SAVED_QUERIES: SavedTaskQuery[];
  DEFAULT_SETTINGS: TaskManagerSettings;
  DEFAULT_TABLE_VIEW_CONFIG: TableViewConfig;
  DEFAULT_TASK_STATES: TaskStateDefinition[];
}

let configuredRuntime: SettingsNormalizerRuntime | null = null;

export function configureSettingsNormalizer(runtime: SettingsNormalizerRuntime): void {
  configuredRuntime = runtime;
}

function runtime(): SettingsNormalizerRuntime {
  if (!configuredRuntime) throw new Error('Settings normalizer runtime was not configured through types.ts');
  return configuredRuntime;
}

// ── Private icon look-up tables (used only by normaliser functions) ────────────

const DEFAULT_TASK_STATE_DISPLAY_ICONS: Readonly<Record<TaskStateType, string>> = {
  todo: '☐',
  in_progress: '◫',
  on_hold: '⏸',
  blocked: '🚫',
  deferred: '▶️',
  done: '☑',
  cancelled: '☒',
  untracked: '?',
};

const DEFAULT_TASK_STATE_DISPLAY_ICONS_BY_RAW: Readonly<Record<string, string>> = {
  ' ': '☐',
  '/': '◫',
  '!': '🚫',
  '?': '⏳',
  '>': '▶️',
  x: '☑',
  '-': '☒',
};

const DEFAULT_TASK_STATE_CUSTOM_ICONS_BY_RAW: Readonly<Record<string, string>> = {
  '!': '🚫',
  '?': '⏳',
  '>': '▶️',
};

const LEGACY_DEFAULT_TASK_STATE_ICONS_BY_RAW: Readonly<Record<string, string>> = {
  ' ': '☐',
  '/': '◐',
  '!': '⏸',
  '?': '?',
  x: '✓',
  '-': '✕',
};

// ── Private type guards ────────────────────────────────────────────────────────

function isTaskStateType(value: unknown): value is TaskStateType {
  return value === 'todo' || value === 'in_progress' || value === 'on_hold' || value === 'blocked' || value === 'deferred' || value === 'done' || value === 'cancelled' || value === 'untracked';
}

function isValidTimeOfDay(value: unknown): value is string {
  return typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/u.test(value);
}

function isTaskQueryDefaultSort(value: unknown): value is TaskQueryDefaultSort {
  return value === 'smart' || value === 'urgency' || value === 'status' || value === 'due' || value === 'scheduled' || value === 'start' || value === 'done' || value === 'created' || value === 'cancelled' || value === 'happens' || value === 'priority' || value === 'path' || value === 'folder' || value === 'filename' || value === 'heading' || value === 'description' || value === 'recurring' || value === 'tag' || value === 'random';
}

function isTasksCodeBlockMode(value: unknown): value is TasksCodeBlockMode {
  return value === 'when-upstream-absent' || value === 'always' || value === 'never';
}

function isTaskPriority(value: unknown): value is 'highest' | 'high' | 'medium' | 'normal' | 'low' | 'lowest' {
  return value === 'highest' || value === 'high' || value === 'medium' || value === 'normal' || value === 'low' || value === 'lowest';
}

function isTableCustomColumnType(value: unknown): value is TableCustomColumnType {
  return value === 'text' || value === 'number' || value === 'date' || value === 'checkbox' || value === 'list';
}

function isKanbanBoardGroupBy(value: unknown): value is KanbanBoardGroupBy {
  return value === 'status' || value === 'priority' || value === 'tag' || value === 'project' || value === 'assignee' || value === 'custom';
}

// ── Normalisation helpers ──────────────────────────────────────────────────────

/**
 * Normalise a boolean setting — returns the validated value or the default.
 */
function normBool(val: unknown, def: boolean): boolean {
  return typeof val === 'boolean' ? val : def;
}

/**
 * Normalise a string setting.
 * @param requireNonEmpty When true, a non-empty trimmed value is also required.
 */
function normStr(val: unknown, def: string, requireNonEmpty = false): string {
  if (typeof val !== 'string') return def;
  const trimmed = val.trim();
  return requireNonEmpty && !trimmed ? def : trimmed;
}

function normSingleLine(val: unknown, def: string): string {
  const normalized = normStr(val, def, true);
  return /[\r\n]/u.test(normalized) ? def : normalized;
}

/** Normalise a dashboard tag prefix (e.g. "goal"): strip a leading # and trailing separators. */
function normTagPrefix(val: unknown, def: string): string {
  if (typeof val !== 'string') return def;
  const cleaned = val.trim().replace(/^#+/u, '').replace(/[\s/-]+$/u, '').trim();
  return cleaned || def;
}

/**
 * Normalise an integer setting, clamping to [min, max] when provided.
 * Pass `posGuard: true` to reject zero/negative values (returns default instead).
 */
function normInt(val: unknown, def: number, opts: { min?: number; max?: number; posGuard?: boolean } = {}): number {
  if (typeof val !== 'number' || !Number.isFinite(val)) return def;
  if (opts.posGuard && val <= 0) return def;
  let v = Math.floor(val);
  if (opts.min !== undefined) v = Math.max(opts.min, v);
  if (opts.max !== undefined) v = Math.min(opts.max, v);
  return v;
}

// ── Icon helpers ───────────────────────────────────────────────────────────────

export function defaultTaskStateIcon(rawText: string, type: TaskStateType): string {
  return DEFAULT_TASK_STATE_DISPLAY_ICONS_BY_RAW[rawText]
    ?? DEFAULT_TASK_STATE_DISPLAY_ICONS[type]
    ?? `[${rawText}]`;
}

export function resolvedTaskStateIcon(state: TaskStateDefinition): string {
  return state.icon.trim() || defaultTaskStateIcon(state.rawText, state.type);
}

export function shouldOverrideTaskStateIcon(state: TaskStateDefinition): boolean {
  // Do not replace the standard unchecked Markdown checkbox globally. Obsidian
  // renders ordinary `[ ]` list items without a reliable Task Manager-specific
  // marker, so a custom Todo icon would appear on every unchecked checklist item
  // in notes such as the Task Manager Showcase "Start Here" list. Keep custom
  // Todo icons available for plugin UI labels, but only install document-wide
  // checkbox CSS for non-standard states and non-Todo checkbox markers.
  if (state.rawText === ' ') return false;
  return Boolean(state.icon.trim() || DEFAULT_TASK_STATE_CUSTOM_ICONS_BY_RAW[state.rawText]);
}

// ── State normalisation ────────────────────────────────────────────────────────

export function normalizeTaskStates(states: readonly Partial<TaskStateDefinition>[] | undefined): TaskStateDefinition[] {
  const seen = new Set<string>();
  const safeStates: readonly Partial<TaskStateDefinition>[] = Array.isArray(states) ? (states as readonly Partial<TaskStateDefinition>[]) : [];
  const normalized = safeStates
    .map((state) => {
      const rawText = typeof state.rawText === 'string' ? state.rawText : '';
      const type = isTaskStateType(state.type) ? state.type : 'untracked';
      const icon = typeof state.icon === 'string' ? state.icon.trim() : '';
      const nextStatusSymbol = typeof state.nextStatusSymbol === 'string' && state.nextStatusSymbol.length > 0 && !state.nextStatusSymbol.includes(']') && !/[\r\n]/u.test(state.nextStatusSymbol)
        ? state.nextStatusSymbol
        : undefined;
      const availableAsCommand = typeof state.availableAsCommand === 'boolean' ? state.availableAsCommand : true;
      return {
        rawText,
        name: typeof state.name === 'string' && state.name.trim() ? state.name.trim() : 'Unnamed',
        icon: LEGACY_DEFAULT_TASK_STATE_ICONS_BY_RAW[rawText] === icon ? '' : icon,
        type,
        availableAsCommand,
        ...(nextStatusSymbol !== undefined ? { nextStatusSymbol } : {}),
      };
    })
    .filter((state) => {
      if (state.rawText.length === 0 || state.rawText.includes(']') || /[\r\n]/u.test(state.rawText) || seen.has(state.rawText)) {
        return false;
      }
      seen.add(state.rawText);
      return true;
    });

  const hasTodo = normalized.some((state) => state.type === 'todo');
  const hasDone = normalized.some((state) => state.type === 'done');
  if (!(normalized.length > 0 && hasTodo && hasDone)) {
    return runtime().DEFAULT_TASK_STATES.map((state) => ({ ...state }));
  }

  if (!normalized.some((state) => state.type === 'deferred')) {
    const deferredDefault = runtime().DEFAULT_TASK_STATES.find((state) => state.type === 'deferred');
    if (deferredDefault) {
      const rawText = nextAvailableDefaultRawMarker(seen, [deferredDefault.rawText, 'd', 'D', '>', 'deferred']);
      normalized.push({ ...deferredDefault, rawText, availableAsCommand: deferredDefault.availableAsCommand ?? true });
    }
  }

  return normalized;
}

function nextAvailableDefaultRawMarker(used: ReadonlySet<string>, candidates: readonly string[]): string {
  for (const marker of candidates) {
    if (!used.has(marker)) {
      return marker;
    }
  }
  for (let index = 1; index < 100; index += 1) {
    const marker = `deferred${index}`;
    if (!used.has(marker)) {
      return marker;
    }
  }
  return `deferred${Date.now()}`;
}

export function mergeTaskStateCollection(
  states: readonly TaskStateDefinition[],
  collection: TaskStateCollection,
): TaskStateDefinition[] {
  const merged = states.map((state) => ({ ...state }));
  for (const collectionState of collection.states) {
    const existingIndex = merged.findIndex((state) => state.rawText === collectionState.rawText);
    if (existingIndex >= 0) {
      // Mirror upstream `bulkAddStatusCollection`: when a status already exists,
      // keep the existing configuration (including its availableAsCommand flag)
      // unless the collection explicitly overrides it.
      const overrides = { ...collectionState };
      merged[existingIndex] = { ...merged[existingIndex], ...overrides };
    } else {
      // Newly imported statuses default to availableAsCommand=false so they do
      // not flood the command palette (matches upstream Status.createFromImportedValue).
      const newEntry: TaskStateDefinition = {
        ...collectionState,
        availableAsCommand: collectionState.availableAsCommand ?? false,
      };
      merged.push(newEntry);
    }
  }
  return normalizeTaskStates(merged);
}

// ── Settings normalisation ─────────────────────────────────────────────────────

function normalizeColorOverrideMap(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object') return {};
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!key.trim() || typeof value !== 'string') continue;
    const color = value.trim();
    if (/^#[0-9a-fA-F]{6}$/u.test(color)) result[key.trim()] = color;
  }
  return result;
}

export function normalizeCustomFieldDefinitions(raw: unknown): CustomFieldDefinition[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const validTypes = new Set(['text', 'number', 'select', 'date', 'tags']);
  const validSyncModes = new Set(['none', 'read', 'write', 'bidirectional']);
  const result: CustomFieldDefinition[] = [];
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const key = typeof record.key === 'string' ? record.key.trim() : '';
    const normalizedKey = key.toLowerCase();
    // Keep keys identifier-safe so they are always accessible as task.customFields.<key>
    // in the safe query DSL. Hyphenated keys such as "energy-level" are dropped;
    // use snake_case instead (for example, "energy_level").
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || seen.has(normalizedKey)) continue;
    seen.add(normalizedKey);
    const type = typeof record.type === 'string' && validTypes.has(record.type) ? record.type as CustomFieldDefinition['type'] : 'text';
    const options = Array.isArray(record.options)
      ? Array.from(new Set(record.options.map(String).map((value) => value.trim()).filter(Boolean)))
      : [];
    const syncMode = typeof record.syncMode === 'string' && validSyncModes.has(record.syncMode)
      ? record.syncMode as CustomFieldDefinition['syncMode']
      : 'read';
    const definition: CustomFieldDefinition = {
      key,
      name: typeof record.name === 'string' && record.name.trim() ? record.name.trim() : key,
      type,
      syncMode,
      searchable: typeof record.searchable === 'boolean' ? record.searchable : true,
    };
    if (type === 'select' && options.length) definition.options = options;
    if (typeof record.frontmatterKey === 'string' && record.frontmatterKey.trim()) definition.frontmatterKey = record.frontmatterKey.trim();
    result.push(definition);
  }
  return result;
}

function normalizeUrgencyWeights(raw: unknown): UrgencyWeights {
  const defaults = runtime().DEFAULT_SETTINGS.urgencyWeights;
  if (!raw || typeof raw !== 'object') return { ...defaults };
  const w = raw as Record<string, unknown>;
  return {
    due: typeof w['due'] === 'number' && Number.isFinite(w['due']) ? w['due'] : defaults.due,
    priority: typeof w['priority'] === 'number' && Number.isFinite(w['priority']) ? w['priority'] : defaults.priority,
    scheduled: typeof w['scheduled'] === 'number' && Number.isFinite(w['scheduled']) ? w['scheduled'] : defaults.scheduled,
    start: typeof w['start'] === 'number' && Number.isFinite(w['start']) ? w['start'] : defaults.start,
  };
}

function normalizeWorkflows(raw: unknown[]): WorkflowDefinition[] {
  return raw
    .filter((w): w is Record<string, unknown> => typeof w === 'object' && w !== null)
    .map((w, index) => {
      const name = typeof w['name'] === 'string' && w['name'].trim() ? w['name'].trim() : 'Unnamed';
      const triggerTag = typeof w['triggerTag'] === 'string' ? w['triggerTag'].replace(/^#/u, '').trim() : '';
      const steps = Array.isArray(w['steps'])
        ? (w['steps'] as unknown[]).filter((s): s is Record<string, unknown> => typeof s === 'object' && s !== null).map((s) => {
            const rawStatus = typeof s['status'] === 'string' ? s['status'].trim() : '';
            return {
              name: typeof s['name'] === 'string' && s['name'].trim() ? s['name'].trim() : 'Step',
              description: typeof s['description'] === 'string' ? s['description'] : '{{prev}}',
              status: rawStatus.length === 1 && rawStatus !== ']' ? rawStatus : ' ',
              priority: typeof s['priority'] === 'string' ? s['priority'] : '',
            };
          })
        : [];
      return {
        id: typeof w['id'] === 'string' && w['id'].trim() ? w['id'].trim() : stableWorkflowId(name, triggerTag, steps.length, index),
        name,
        triggerTag,
        steps,
      };
    })
    .filter((w) => w.triggerTag);
}

function stableWorkflowId(name: string, triggerTag: string, stepCount: number, index: number): string {
  const seed = `${index}\u0000${name}\u0000${triggerTag}\u0000${stepCount}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `wf-${(hash >>> 0).toString(36)}`;
}

function migrateLegacyGlobalFilter(globalFilter: unknown, globalQuery: unknown): { globalFilter: string; globalQuery: string } {
  const filter = typeof globalFilter === 'string' ? globalFilter.trim() : runtime().DEFAULT_SETTINGS.globalFilter;
  const query = typeof globalQuery === 'string' ? globalQuery.trim() : runtime().DEFAULT_SETTINGS.globalQuery;
  if (!query && looksLikeQueryInstruction(filter)) {
    return { globalFilter: '', globalQuery: filter };
  }
  return { globalFilter: filter, globalQuery: query };
}

function looksLikeQueryInstruction(value: string): boolean {
  return /\n/u.test(value)
    || /^(?:done|not done|is recurring|is not recurring|is blocked|is not blocked|is blocking|is not blocking|exclude sub-items)$/iu.test(value)
    || /^(?:sort|group|filter)\s+by\s+/iu.test(value)
    || /^(?:path|root|folder|filename|file name|heading|tag|tags|description|text|priority|status|due|scheduled|start|starts|completed|completion|created|cancelled|canceled|happens|recurrence|id|depends on)\s+/iu.test(value);
}

export function normalizeCustomPriorities(items: readonly Partial<CustomPriority>[]): CustomPriority[] {
  if (!Array.isArray(items)) return [];
  const safeItems = items as readonly Partial<CustomPriority>[];
  return safeItems
    .map((p) => ({
      label: typeof p.label === 'string' ? p.label.trim() : '',
      emoji: typeof p.emoji === 'string' ? p.emoji.trim() : '',
      value: typeof p.value === 'number' && Number.isFinite(p.value) ? p.value : 3,
    }))
    .filter((p) => p.label.length > 0);
}

export function normalizeTaskTemplates(templates: readonly Partial<TaskTemplate>[]): TaskTemplate[] {
  const safe = (Array.isArray(templates) ? templates : []) as readonly Partial<TaskTemplate>[];
  return safe
    .map((t) => {
      const priority = typeof t.priority === 'string' ? t.priority.trim() : '';
      return {
        name: typeof t.name === 'string' ? t.name.trim() : '',
        description: typeof t.description === 'string' ? t.description.trim() : '',
        priority: isTaskPriority(priority) ? priority : 'normal',
        recurrence: typeof t.recurrence === 'string' ? t.recurrence.trim() : '',
        tags: typeof t.tags === 'string' ? t.tags.trim() : '',
        onCompletion: typeof t.onCompletion === 'string' ? t.onCompletion.trim() : '',
      };
    })
    .filter((t) => t.name.length > 0);
}

export function normalizeModalFields(fields: Partial<ModalFieldVisibility> | undefined): ModalFieldVisibility {
  const source = fields && typeof fields === 'object' ? fields : {};
  // Migrate legacy 'dependencies' key to both new keys (backwards compatibility)
  const migrateSource = { ...source };
  if ('dependencies' in migrateSource && typeof (migrateSource as Record<string, unknown>).dependencies === 'boolean') {
    const legacyValue = (migrateSource as Record<string, unknown>).dependencies as boolean;
    if (!legacyValue) {
      migrateSource.before_this = false;
      migrateSource.after_this = false;
    }
  }
  const normalized: ModalFieldVisibility = { ...runtime().DEFAULT_MODAL_FIELDS };
  for (const key of Object.keys(runtime().DEFAULT_MODAL_FIELDS) as ModalFieldVisibilityKey[]) {
    normalized[key] = typeof migrateSource[key] === 'boolean' ? migrateSource[key] : runtime().DEFAULT_MODAL_FIELDS[key];
  }
  return normalized;
}

export function normalizeDeferPresets(presets: readonly Partial<DeferPreset>[] | undefined): DeferPreset[] {
  if (!Array.isArray(presets) || presets.length === 0) {
    return runtime().DEFAULT_DEFER_PRESETS.map((p) => ({ ...p }));
  }
  const safePresets = presets as readonly Partial<DeferPreset>[];
  const normalized = safePresets
    .map((p) => ({
      label: typeof p.label === 'string' ? p.label.trim() : '',
      ...(typeof p.days === 'number' && p.days > 0 ? { days: Math.floor(p.days) } : {}),
      ...(typeof p.weeks === 'number' && p.weeks > 0 ? { weeks: Math.floor(p.weeks) } : {}),
      ...(typeof p.months === 'number' && p.months > 0 ? { months: Math.floor(p.months) } : {}),
    }))
    .filter((p) => p.label.length > 0 && (p.days !== undefined || p.weeks !== undefined || p.months !== undefined));
  return normalized.length > 0 ? normalized : runtime().DEFAULT_DEFER_PRESETS.map((p) => ({ ...p }));
}

export function normalizeSavedQueries(queries: readonly Partial<SavedTaskQuery>[] | undefined): SavedTaskQuery[] {
  if (!Array.isArray(queries)) {
    return runtime().DEFAULT_SAVED_QUERIES.map((query) => ({ ...query }));
  }
  const seen = new Set<string>();
  const safeQueries = queries as readonly Partial<SavedTaskQuery>[];
  return safeQueries
    .map((query) => ({
      name: typeof query.name === 'string' ? query.name.trim() : '',
      query: typeof query.query === 'string' ? query.query.trim() : '',
    }))
    .filter((query) => {
      const normalizedName = query.name.toLowerCase();
      if (!query.name || !query.query || seen.has(normalizedName)) {
        return false;
      }
      seen.add(normalizedName);
      return true;
    });
}

export function normalizeKanbanRules(rules: readonly Partial<KanbanAutomationRule>[] | undefined): KanbanAutomationRule[] {
  if (!Array.isArray(rules)) {
    return [];
  }
  const safeRules = rules as readonly Partial<KanbanAutomationRule>[];
  return safeRules
    .map((rule) => ({
      id: typeof rule.id === 'string' && rule.id.trim() ? rule.id.trim() : `rule-${Math.random().toString(36).substr(2, 9)}`,
      enabled: typeof rule.enabled === 'boolean' ? rule.enabled : true,
      trigger: (rule.trigger && ['lane-enter', 'lane-exit', 'card-created', 'tag-added', 'priority-changed'].includes(rule.trigger)) ? rule.trigger : 'lane-enter',
      condition: (rule.condition && ['tag-match', 'priority-match', 'status-match', 'always'].includes(rule.condition)) ? rule.condition : 'always',
      conditionValue: rule.conditionValue,
      action: (rule.action && ['set-done-date', 'move-lane', 'set-priority', 'add-tag', 'remove-tag'].includes(rule.action)) ? rule.action : 'set-priority',
      actionValue: typeof rule.actionValue === 'string' ? rule.actionValue.trim() : undefined,
      description: typeof rule.description === 'string' ? rule.description.trim() : undefined,
    }))
    .filter((rule) => rule.trigger && rule.action);
}

export function normalizeWipLimits(limits: readonly Partial<WipLimitConfig>[] | undefined): WipLimitConfig[] {
  if (!Array.isArray(limits)) {
    return [];
  }
  const safeLimits = limits as readonly Partial<WipLimitConfig>[];
  return safeLimits
    .map((limit) => ({
      statusName: typeof limit.statusName === 'string' ? limit.statusName.trim() : '',
      hardLimit: typeof limit.hardLimit === 'number' && limit.hardLimit > 0 ? Math.floor(limit.hardLimit) : undefined,
      softLimit: typeof limit.softLimit === 'number' && limit.softLimit > 0 ? Math.floor(limit.softLimit) : undefined,
    }))
    .filter((limit) => limit.statusName.length > 0);
}

function normalizeStringArray(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((value): value is string => typeof value === 'string').map((value) => value.trim()).filter(Boolean))];
}

function normalizeSavedViewPresetId(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const normalized = value.trim().toLowerCase().replace(/[^a-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '');
  return normalized || fallback;
}

function normalizeTableCustomColumns(raw: unknown): TableCustomColumn[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map((entry) => {
      const key = typeof entry.key === 'string' ? entry.key.trim().toLowerCase().replace(/\s+/gu, '-') : '';
      const label = typeof entry.label === 'string' && entry.label.trim() ? entry.label.trim() : key;
      const type = isTableCustomColumnType(entry.type) ? entry.type : 'text';
      const options = normalizeStringArray(entry.options).slice(0, 50);
      const color = typeof entry.color === 'string' && /^#[0-9a-f]{6}$/iu.test(entry.color.trim()) ? entry.color.trim() : undefined;
      const required = normBool(entry.required, false);
      return { key, label, type, ...(options.length ? { options } : {}), ...(color ? { color } : {}), ...(required ? { required } : {}) };
    })
    .filter((entry) => {
      if (!entry.key || seen.has(entry.key)) return false;
      seen.add(entry.key);
      return true;
    });
}

function normalizeKanbanBoards(raw: unknown): KanbanBoardConfig[] {
  const input = Array.isArray(raw) ? raw : runtime().DEFAULT_KANBAN_BOARDS;
  const seen = new Set<string>();
  const boards = input
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map((entry, index): KanbanBoardConfig => {
      const idRaw = typeof entry.id === 'string' && entry.id.trim() ? entry.id.trim() : `board-${index + 1}`;
      const id = idRaw.toLowerCase().replace(/[^a-z0-9_-]+/gu, '-').replace(/^-+|-+$/gu, '') || `board-${index + 1}`;
      return {
        id,
        name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : 'Task Board',
        query: typeof entry.query === 'string' && entry.query.trim() ? entry.query.trim() : 'not done',
        groupBy: isKanbanBoardGroupBy(entry.groupBy) ? entry.groupBy : 'status',
        ...(typeof entry.customFieldKey === 'string' && entry.customFieldKey.trim() ? { customFieldKey: entry.customFieldKey.trim().toLowerCase() } : {}),
        columns: normalizeStringArray(entry.columns).slice(0, 24),
        background: typeof entry.background === 'string' ? entry.background.trim() : '',
      };
    })
    .filter((board) => {
      if (seen.has(board.id)) return false;
      seen.add(board.id);
      return true;
    })
    .slice(0, 24);
  return boards.length > 0 ? boards : runtime().DEFAULT_KANBAN_BOARDS.map((board) => ({ ...board }));
}

function normalizeTableSavedFilters(raw: unknown): TableSavedFilter[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map((entry) => {
      const name = typeof entry.name === 'string' ? entry.name.trim() : '';
      return {
        name,
        search: typeof entry.search === 'string' ? entry.search.trim() : '',
        statuses: normalizeStringArray(entry.statuses),
        priorities: normalizeStringArray(entry.priorities),
        tags: normalizeStringArray(entry.tags),
        sortKey: typeof entry.sortKey === 'string' && entry.sortKey.trim() ? entry.sortKey.trim() : 'due',
        sortDirection: entry.sortDirection === 'desc' ? 'desc' as const : 'asc' as const,
        showHierarchy: normBool(entry.showHierarchy, runtime().DEFAULT_TABLE_VIEW_CONFIG.showHierarchy),
        visibleColumns: normalizeStringArray(entry.visibleColumns),
      };
    })
    .filter((entry) => {
      const key = entry.name.toLowerCase();
      if (!entry.name || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, 12);
}

function normalizeSavedViewPresets(raw: unknown): SavedViewPreset[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  return raw
    .filter((entry): entry is Record<string, unknown> => typeof entry === 'object' && entry !== null)
    .map((entry, index) => {
      const kind = entry.kind === 'kanban-board' ? 'kanban-board' as const : 'table-filter' as const;
      const view = kind === 'kanban-board' ? 'kanban' as const : 'table' as const;
      return {
        id: normalizeSavedViewPresetId(entry.id, `${view}-preset-${index + 1}`),
        kind,
        view,
        name: typeof entry.name === 'string' && entry.name.trim() ? entry.name.trim() : 'Unnamed preset',
        payload: entry.payload && typeof entry.payload === 'object' ? { ...(entry.payload as Record<string, unknown>) } : undefined,
      };
    })
    .filter((entry) => {
      const key = `${entry.kind}:${entry.name.toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function normalizeTableViewConfig(raw: unknown): TableViewConfig {
  const source = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  return {
    savedFilters: normalizeTableSavedFilters(source.savedFilters),
    customColumns: normalizeTableCustomColumns(source.customColumns),
    showHierarchy: normBool(source.showHierarchy, runtime().DEFAULT_TABLE_VIEW_CONFIG.showHierarchy),
    visibleColumns: normalizeStringArray(source.visibleColumns),
  };
}

export function normalizeTaskManagerSettings(settings: Partial<TaskManagerSettings> | undefined): TaskManagerSettings {
  const rawSettings = settings && typeof settings === 'object' ? settings as Record<string, unknown> : {};
  const merged = { ...runtime().DEFAULT_SETTINGS, ...settings };
  const supportedStates = normalizeTaskStates(merged.supportedStates);
  const savedQueries = normalizeSavedQueries(merged.savedQueries);
  const migratedGlobal = migrateLegacyGlobalFilter(merged.globalFilter, merged.globalQuery);
  const modalFields = normalizeModalFields(merged.modalFields);
  const customFieldDefinitions = normalizeCustomFieldDefinitions(merged.customFieldDefinitions);
  const tableViewConfig = normalizeTableViewConfig(merged.tableViewConfig);
  const kanbanBoards = normalizeKanbanBoards(merged.kanbanBoards);
  const savedViewPresetsInput = merged.savedViewPresets ?? ((('savedViewPresets' in rawSettings) || ('tableViewConfig' in rawSettings) || ('kanbanBoards' in rawSettings))
    ? [
        ...tableViewConfig.savedFilters.map((filter, index) => ({ id: `table-filter-${index + 1}`, kind: 'table-filter' as const, view: 'table' as const, name: filter.name, payload: filter })),
        ...kanbanBoards.map((board) => ({ id: `${board.id}-preset`, kind: 'kanban-board' as const, view: 'kanban' as const, name: board.name, payload: board })),
      ]
    : undefined);
  const savedViewPresets = normalizeSavedViewPresets(savedViewPresetsInput);
  const D = runtime().DEFAULT_SETTINGS; // shorthand
  const normalized: TaskManagerSettings = {
    enableFileEvents:                normBool(merged.enableFileEvents, D.enableFileEvents),
    enablePeriodicScan:              normBool(merged.enablePeriodicScan, D.enablePeriodicScan),
    scanIntervalMinutes:             normInt(merged.scanIntervalMinutes, D.scanIntervalMinutes, { min: 1 }),
    completionLoggingEnabled:        normBool(merged.completionLoggingEnabled, false),
    logSectionHeading:               normStr(merged.logSectionHeading, D.logSectionHeading, true),
    includeCompletionTime:           normBool(merged.includeCompletionTime, D.includeCompletionTime),
    logTimeFormat:                   normStr(merged.logTimeFormat, D.logTimeFormat, true),
    includeSourceLinkWhenNotDailyNote: normBool(merged.includeSourceLinkWhenNotDailyNote, D.includeSourceLinkWhenNotDailyNote),
    globalFilter:                    migratedGlobal.globalFilter,
    globalQuery:                     migratedGlobal.globalQuery,
    removeGlobalFilterFromDescription: normBool(merged.removeGlobalFilterFromDescription, D.removeGlobalFilterFromDescription),
    enableQueryDsl:                  normBool(merged.enableQueryDsl, D.enableQueryDsl),
    taskFormat:                      (merged.taskFormat === 'dataview' || merged.taskFormat === 'emoji') ? merged.taskFormat : D.taskFormat,
    taskCountLocation:               (merged.taskCountLocation === 'top' || merged.taskCountLocation === 'bottom') ? merged.taskCountLocation : D.taskCountLocation,
    queryCodeBlockName:              normStr(merged.queryCodeBlockName, D.queryCodeBlockName, true),
    tasksCodeBlockMode:              isTasksCodeBlockMode(merged.tasksCodeBlockMode) ? merged.tasksCodeBlockMode : D.tasksCodeBlockMode,
    defaultSort:                     isTaskQueryDefaultSort(merged.defaultSort) ? merged.defaultSort : D.defaultSort,
    autoSuggestInEditor:             normBool(merged.autoSuggestInEditor, D.autoSuggestInEditor),
    autoSuggestMinMatch:             normInt(merged.autoSuggestMinMatch, D.autoSuggestMinMatch, { min: 0, max: 20 }),
    autoSuggestMaxItems:             normInt(merged.autoSuggestMaxItems, D.autoSuggestMaxItems, { min: 1, max: 100 }),
    slashCommandsInEditor:           normBool(merged.slashCommandsInEditor, D.slashCommandsInEditor),
    atAssigneeInEditor:              normBool(merged.atAssigneeInEditor, D.atAssigneeInEditor),
    taskLineToolbarEnabled:          normBool(merged.taskLineToolbarEnabled, D.taskLineToolbarEnabled),
    provideAccessKeys:               normBool(merged.provideAccessKeys, D.provideAccessKeys),
    setCreatedDate:                  normBool(merged.setCreatedDate, D.setCreatedDate),
    setDoneDate:                     normBool(merged.setDoneDate, D.setDoneDate),
    setCancelledDate:                normBool(merged.setCancelledDate, D.setCancelledDate),
    recurrenceFutureOccurrences:     normInt(merged.recurrenceFutureOccurrences, D.recurrenceFutureOccurrences, { min: 0, max: 24 }),
    recurrenceInsertLocation:        merged.recurrenceInsertLocation === 'after' ? 'after' : 'before',
    removeScheduledDateOnRecurrence: normBool(merged.removeScheduledDateOnRecurrence, D.removeScheduledDateOnRecurrence),
    recurrenceOnCancelled:           normBool(merged.recurrenceOnCancelled, D.recurrenceOnCancelled),
    dateOutputAsWikiLinks:           normBool(merged.dateOutputAsWikiLinks, D.dateOutputAsWikiLinks),
    // Normalize dateFormat: accept 'plain'|'wikilink'; fall back to dateOutputAsWikiLinks for legacy data.
    dateFormat: (merged.dateFormat === 'plain' || merged.dateFormat === 'wikilink')
      ? merged.dateFormat
      : (merged.dateOutputAsWikiLinks ? 'wikilink' : 'plain'),
    dateDisplayFormat:               normStr(merged.dateDisplayFormat, D.dateDisplayFormat),
    subtaskDateInheritance:          normBool(merged.subtaskDateInheritance, D.subtaskDateInheritance),
    collectFilePath:                 normStr(merged.collectFilePath, D.collectFilePath, true),
    collectHeading:                  normSingleLine(merged.collectHeading, D.collectHeading),
    treeFilteredView:                normBool(merged.treeFilteredView, D.treeFilteredView),
    archiveFilePath:                 normStr(merged.archiveFilePath, D.archiveFilePath, true),
    archiveHeading:                  normSingleLine(merged.archiveHeading, D.archiveHeading),
    enableReminderNotifications:     normBool(merged.enableReminderNotifications, D.enableReminderNotifications),
    reminderCheckIntervalMinutes:    normInt(merged.reminderCheckIntervalMinutes, D.reminderCheckIntervalMinutes, { min: 1, max: 60 }),
    quickCaptureInboxPath:           normStr(merged.quickCaptureInboxPath, D.quickCaptureInboxPath),
    taskTemplates:                   Array.isArray(merged.taskTemplates) ? normalizeTaskTemplates(merged.taskTemplates) : D.taskTemplates,
    enableMobileGestures:            normBool(merged.enableMobileGestures, D.enableMobileGestures),
    showActionNotifications:         normBool(merged.showActionNotifications, D.showActionNotifications),
    nlInlineConversionEnabled:       normBool(merged.nlInlineConversionEnabled, D.nlInlineConversionEnabled),
    nlTaskPrefix:                    normStr(merged.nlTaskPrefix, D.nlTaskPrefix),
    useFilenameAsScheduledDate:      normBool(merged.useFilenameAsScheduledDate, D.useFilenameAsScheduledDate),
    filenameScheduledDateFormat:     normStr(merged.filenameScheduledDateFormat, D.filenameScheduledDateFormat),
    filenameScheduledDateFolders:    normStr(merged.filenameScheduledDateFolders, D.filenameScheduledDateFolders),
    supportedStates,
    savedQueries,
    modalFields,
    deferPresets:                    normalizeDeferPresets(merged.deferPresets),
    autoCompleteParent:              normBool(merged.autoCompleteParent, D.autoCompleteParent),
    autoAdvanceParentToInProgress:   normBool(merged.autoAdvanceParentToInProgress, D.autoAdvanceParentToInProgress),
    autoAdvanceParentOnAllCancelled: normBool(merged.autoAdvanceParentOnAllCancelled, D.autoAdvanceParentOnAllCancelled),
    customPriorities:                Array.isArray(merged.customPriorities) ? normalizeCustomPriorities(merged.customPriorities) : D.customPriorities,
    futureOccurrenceCount:           normInt(merged.futureOccurrenceCount, D.futureOccurrenceCount, { min: 0, max: 20 }),
    trackRecurrenceCount:            normBool(merged.trackRecurrenceCount, D.trackRecurrenceCount),
    useSystemNotifications:          normBool(merged.useSystemNotifications, D.useSystemNotifications),
    taskNoteFolder:                  normStr(merged.taskNoteFolder, D.taskNoteFolder),
    taskNoteFolders:                 normStr(merged.taskNoteFolders, D.taskNoteFolders),
    taskNoteMarker:                  normStr(merged.taskNoteMarker, D.taskNoteMarker),
    todoistApiKey:                   normStr(merged.todoistApiKey, D.todoistApiKey),
    todoistProjectId:                normStr(merged.todoistProjectId, D.todoistProjectId),
    todoistSyncEnabled:              normBool(merged.todoistSyncEnabled, D.todoistSyncEnabled),
    todoistDryRun:                   normBool(merged.todoistDryRun, D.todoistDryRun),
    todoistInboxPath:                normStr(merged.todoistInboxPath, D.todoistInboxPath),
    enableBasesIntegration:          normBool(merged.enableBasesIntegration, D.enableBasesIntegration),
    basesAutoRefreshEnabled:         normBool(merged.basesAutoRefreshEnabled, D.basesAutoRefreshEnabled),
    basesRefreshDebounceMs:          normInt(merged.basesRefreshDebounceMs, D.basesRefreshDebounceMs, { min: 100, max: 5000 }),
    nlpQueryEnabled:                 normBool(merged.nlpQueryEnabled, D.nlpQueryEnabled),
    kanbanFileWritebackEnabled:      normBool(merged.kanbanFileWritebackEnabled, D.kanbanFileWritebackEnabled),
    dailyPlanHeading:                normStr(merged.dailyPlanHeading, D.dailyPlanHeading, true),
    planningBoardEnabled:            normBool(merged.planningBoardEnabled, D.planningBoardEnabled),
    planningBoardSidebarEnabled:     normBool(merged.planningBoardSidebarEnabled, D.planningBoardSidebarEnabled),
    planningBoardMaxUndoStack:       normInt(merged.planningBoardMaxUndoStack, D.planningBoardMaxUndoStack, { min: 1, max: 100 }),
    planningBoardDragEnabled:        normBool(merged.planningBoardDragEnabled, D.planningBoardDragEnabled),
    pomodoroWorkMinutes:             normInt(merged.pomodoroWorkMinutes, D.pomodoroWorkMinutes, { min: 1, max: 120 }),
    pomodoroBreakMinutes:            normInt(merged.pomodoroBreakMinutes, D.pomodoroBreakMinutes, { min: 1, max: 60 }),
    pomodoroLongBreakMinutes:        normInt(merged.pomodoroLongBreakMinutes, D.pomodoroLongBreakMinutes, { min: 1, max: 120 }),
    pomodoroLongBreakAfter:          normInt(merged.pomodoroLongBreakAfter, D.pomodoroLongBreakAfter, { min: 1, max: 20 }),
    googleTasksEnabled:              normBool(merged.googleTasksEnabled, D.googleTasksEnabled),
    googleTasksOAuthClientId:        normStr(merged.googleTasksOAuthClientId, D.googleTasksOAuthClientId),
    googleTasksAccessToken:          normStr(merged.googleTasksAccessToken, D.googleTasksAccessToken),
    googleTasksRefreshToken:         normStr(merged.googleTasksRefreshToken, D.googleTasksRefreshToken),
    googleTasksTokenExpiresAt:       normStr(merged.googleTasksTokenExpiresAt, D.googleTasksTokenExpiresAt),
    googleTasksApiKey:               normStr(merged.googleTasksApiKey, D.googleTasksApiKey),
    googleTasksListId:               normStr(merged.googleTasksListId, D.googleTasksListId),
    googleTasksInboxPath:            normStr(merged.googleTasksInboxPath, D.googleTasksInboxPath, true),
    googleCalendarEnabled:           normBool(merged.googleCalendarEnabled, D.googleCalendarEnabled),
    googleCalendarOAuthClientId:     normStr(merged.googleCalendarOAuthClientId, D.googleCalendarOAuthClientId),
    googleCalendarAccessToken:       normStr(merged.googleCalendarAccessToken, D.googleCalendarAccessToken),
    googleCalendarRefreshToken:      normStr(merged.googleCalendarRefreshToken, D.googleCalendarRefreshToken),
    googleCalendarTokenExpiresAt:    normStr(merged.googleCalendarTokenExpiresAt, D.googleCalendarTokenExpiresAt),
    googleCalendarId:                normStr(merged.googleCalendarId, D.googleCalendarId, true),
    googleCalendarReminderMinutes:   normInt(merged.googleCalendarReminderMinutes, D.googleCalendarReminderMinutes, { min: 0, max: 40320 }),
    googleCalendarUseDefaultReminders: normBool(merged.googleCalendarUseDefaultReminders, D.googleCalendarUseDefaultReminders),
    googleCalendarDryRun:            normBool(merged.googleCalendarDryRun, D.googleCalendarDryRun),
    aiQueryEnabled:                  normBool(merged.aiQueryEnabled, D.aiQueryEnabled),
    aiQueryApiKey:                   normStr(merged.aiQueryApiKey, D.aiQueryApiKey),
    aiQueryAnthropicBrowserAccess:   normBool(merged.aiQueryAnthropicBrowserAccess, D.aiQueryAnthropicBrowserAccess),
    aiQueryModel:                    normStr(merged.aiQueryModel, D.aiQueryModel, true),
    aiQueryProvider:                 (['openai', 'anthropic', 'ollama', 'lm-studio'] as const).includes(merged.aiQueryProvider) ? merged.aiQueryProvider : D.aiQueryProvider,
    aiQueryLocalEndpoint:            normStr(merged.aiQueryLocalEndpoint, D.aiQueryLocalEndpoint, true),
    preferredLocale:                 isLocaleSelectable(String(merged.preferredLocale ?? '')) ? merged.preferredLocale : D.preferredLocale,
    onboardingVersionSeen:           Number.isInteger(merged.onboardingVersionSeen)
      ? normInt(merged.onboardingVersionSeen, D.onboardingVersionSeen, { min: 0 }) : D.onboardingVersionSeen,
    weeklyReviewInboxPath:           normStr(merged.weeklyReviewInboxPath, D.weeklyReviewInboxPath),
    weeklyReviewEnabled:             normBool(merged.weeklyReviewEnabled, D.weeklyReviewEnabled),
    dateTimeOnLifecycleDates:        normBool(merged.dateTimeOnLifecycleDates, D.dateTimeOnLifecycleDates),
    pomodoroLogActualTime:           normBool(merged.pomodoroLogActualTime, D.pomodoroLogActualTime),
    habitTrackingEnabled:            normBool(merged.habitTrackingEnabled, D.habitTrackingEnabled),
    gamificationEnabled:             normBool(merged.gamificationEnabled, D.gamificationEnabled),
    dailyCapacityMinutes:            normInt(merged.dailyCapacityMinutes, D.dailyCapacityMinutes, { min: 0 }),
    // `enableScripting` was a redundant legacy gate. Preserve an explicitly
    // stored modern value; otherwise migrate the old toggle once and drop it.
    enableDslExpressions:            typeof rawSettings.enableDslExpressions === 'boolean'
      ? rawSettings.enableDslExpressions
      : normBool(rawSettings.enableScripting, D.enableDslExpressions),
    logEntryTemplate:                normStr(merged.logEntryTemplate, D.logEntryTemplate),
    dailyStatsSummaryEnabled:        normBool(merged.dailyStatsSummaryEnabled, D.dailyStatsSummaryEnabled),
    dailyStatsSummaryTemplate:       normStr(merged.dailyStatsSummaryTemplate, D.dailyStatsSummaryTemplate, true),
    mutationLogEnabled:              normBool(merged.mutationLogEnabled, D.mutationLogEnabled),
    mutationLogFile:                 normStr(merged.mutationLogFile, D.mutationLogFile, true),
    mutationLogMaxEntries:           (typeof merged.mutationLogMaxEntries === 'number' && Number.isFinite(merged.mutationLogMaxEntries) && merged.mutationLogMaxEntries >= 100) ? Math.floor(merged.mutationLogMaxEntries) : D.mutationLogMaxEntries,
    fileDefaultsEnabled:             normBool(merged.fileDefaultsEnabled, D.fileDefaultsEnabled),
    fileDefaultsPropertyPrefix:      normStr(merged.fileDefaultsPropertyPrefix, D.fileDefaultsPropertyPrefix, true),
    icalImportUrl:                   normStr(merged.icalImportUrl, D.icalImportUrl),
    icalImportTargetPath:            normStr(merged.icalImportTargetPath, D.icalImportTargetPath, true),
    icsExportPath:                   normStr(merged.icsExportPath, D.icsExportPath, true),
    caldavSyncEnabled:               normBool(merged.caldavSyncEnabled, D.caldavSyncEnabled),
    caldavServerUrl:                 normStr(merged.caldavServerUrl, D.caldavServerUrl),
    caldavAllowPrivateNetwork:       normBool(merged.caldavAllowPrivateNetwork, D.caldavAllowPrivateNetwork),
    caldavUsername:                  normStr(merged.caldavUsername, D.caldavUsername),
    caldavPassword:                  normStr(merged.caldavPassword, D.caldavPassword),
    caldavCalendarPath:              normStr(merged.caldavCalendarPath, D.caldavCalendarPath),
    caldavVaultPath:                 normStr(merged.caldavVaultPath, D.caldavVaultPath, true),
    appleRemindersEnabled:           normBool(merged.appleRemindersEnabled, D.appleRemindersEnabled),
    appleRemindersListName:          normStr(merged.appleRemindersListName, D.appleRemindersListName),
    appleRemindersShortcutName:      normSingleLine(merged.appleRemindersShortcutName, D.appleRemindersShortcutName),
    appleRemindersInboxPath:         normStr(merged.appleRemindersInboxPath, D.appleRemindersInboxPath, true),
    appleRemindersWebhookEnabled:    normBool(merged.appleRemindersWebhookEnabled, D.appleRemindersWebhookEnabled),
    appleRemindersWebhookSecret:     normStr(merged.appleRemindersWebhookSecret, D.appleRemindersWebhookSecret),
    msToDoEnabled:                   normBool(merged.msToDoEnabled, D.msToDoEnabled),
    msToDoClientId:                  normStr(merged.msToDoClientId, D.msToDoClientId),
    msToDoListId:                    normStr(merged.msToDoListId, D.msToDoListId),
    msToDoToken:                     normStr(merged.msToDoToken, D.msToDoToken),
    msToDoRefreshToken:              normStr(merged.msToDoRefreshToken, D.msToDoRefreshToken),
    msToDoTokenExpiresAt:            normStr(merged.msToDoTokenExpiresAt, D.msToDoTokenExpiresAt),
    msToDoInboxPath:                 normStr(merged.msToDoInboxPath, D.msToDoInboxPath, true),
    syncConflictDirection:           merged.syncConflictDirection === 'service-first' ? 'service-first' : 'vault-first',
    syncRunHistory:                  Array.isArray(merged.syncRunHistory) ? merged.syncRunHistory.slice(0, 20).map((entry) => ({
                                        service: typeof entry?.service === 'string' ? entry.service.trim() : 'unknown',
                                        startedAt: typeof entry?.startedAt === 'string' ? entry.startedAt.trim() : '',
                                        endedAt: typeof entry?.endedAt === 'string' ? entry.endedAt.trim() : '',
                                        outcome: entry?.outcome === 'dry-run' || entry?.outcome === 'failed' || entry?.outcome === 'partial' ? entry.outcome : 'success',
                                        details: typeof entry?.details === 'string' ? entry.details.trim() : '',
                                        ...(typeof entry?.created === 'number' ? { created: entry.created } : {}),
                                        ...(typeof entry?.updated === 'number' ? { updated: entry.updated } : {}),
                                        ...(typeof entry?.deleted === 'number' ? { deleted: entry.deleted } : {}),
                                        ...(typeof entry?.imported === 'number' ? { imported: entry.imported } : {}),
                                        ...(typeof entry?.conflicts === 'number' ? { conflicts: entry.conflicts } : {}),
                                        ...(typeof entry?.failed === 'number' ? { failed: entry.failed } : {}),
                                      })) : D.syncRunHistory,
    syncLastSuccessTodoist:          normStr(merged.syncLastSuccessTodoist, D.syncLastSuccessTodoist),
    syncLastSuccessGoogleTasks:      normStr(merged.syncLastSuccessGoogleTasks, D.syncLastSuccessGoogleTasks),
    syncLastSuccessGoogleCalendar:    normStr(merged.syncLastSuccessGoogleCalendar, D.syncLastSuccessGoogleCalendar),
    syncLastSuccessAppleReminders:   normStr(merged.syncLastSuccessAppleReminders, D.syncLastSuccessAppleReminders),
    syncLastSuccessMsToDo: typeof rawSettings.syncLastSuccessMsToDo === 'string' ? rawSettings.syncLastSuccessMsToDo.trim() : typeof rawSettings.syncLastSuccessMsToD === 'string' ? rawSettings.syncLastSuccessMsToD.trim() : D.syncLastSuccessMsToDo,
    syncLastSuccessCalDAV:           normStr(merged.syncLastSuccessCalDAV, D.syncLastSuccessCalDAV),
    googleTasksDryRun:               normBool(merged.googleTasksDryRun, D.googleTasksDryRun),
    appleRemindersDryRun:            normBool(merged.appleRemindersDryRun, D.appleRemindersDryRun),
    msToDoDryRun:                    normBool(merged.msToDoDryRun, D.msToDoDryRun),
    datacoreEnabled:                 normBool(merged.datacoreEnabled, D.datacoreEnabled),
    inlineProgressBarsEnabled:       normBool(merged.inlineProgressBarsEnabled, D.inlineProgressBarsEnabled),
    jsonExportPath:                  normStr(merged.jsonExportPath, D.jsonExportPath, true),
    yamlExportPath:                  normStr(merged.yamlExportPath, D.yamlExportPath, true),
    csvExportPath:                   normStr(merged.csvExportPath, D.csvExportPath, true),
    followUpEmoji:                   normStr(merged.followUpEmoji, D.followUpEmoji, true),
    workflowsEnabled:                normBool(merged.workflowsEnabled, D.workflowsEnabled),
    workflows:                       Array.isArray(merged.workflows) ? normalizeWorkflows(merged.workflows) : D.workflows,
    orgModeEnabled:                  normBool(merged.orgModeEnabled, D.orgModeEnabled),
    syncConflictLogPath:             normStr(merged.syncConflictLogPath, D.syncConflictLogPath, true),
    missedReminderLogEnabled:        normBool(merged.missedReminderLogEnabled, D.missedReminderLogEnabled),
    excludedFolders: Array.isArray(merged.excludedFolders)
      ? (merged.excludedFolders as unknown[]).filter((e): e is string => typeof e === 'string').map((e) => e.trim().replace(/^\/+|\/+$/gu, '').toLowerCase()).filter(Boolean)
      : D.excludedFolders,
    autoGenerateTaskId:              normBool(merged.autoGenerateTaskId, D.autoGenerateTaskId),
    recurrenceSkipToFuture:          normBool(merged.recurrenceSkipToFuture, D.recurrenceSkipToFuture),
    postponePreferredField:          (merged.postponePreferredField === 'due' || merged.postponePreferredField === 'scheduled' || merged.postponePreferredField === 'start') ? merged.postponePreferredField : 'auto',
    urgencyWeights:                  normalizeUrgencyWeights(merged.urgencyWeights),
    staleTaskThresholdDays:          normInt(merged.staleTaskThresholdDays, D.staleTaskThresholdDays, { posGuard: true }),
    overdueTaskThresholdDays:        normInt(merged.overdueTaskThresholdDays, D.overdueTaskThresholdDays, { min: 0 }),
    whisperApiKey:                   normStr(merged.whisperApiKey, D.whisperApiKey),
    icsOverlayUrls:                  Array.isArray(merged.icsOverlayUrls) ? (merged.icsOverlayUrls as unknown[]).filter((u): u is string => typeof u === 'string' && u.trim().length > 0).map((u) => (u).trim()) : D.icsOverlayUrls,
    icsOverlayRefreshMinutes:        normInt(merged.icsOverlayRefreshMinutes, D.icsOverlayRefreshMinutes, { min: 5, max: 1440 }),
    statusBarNowNextEnabled:         normBool(merged.statusBarNowNextEnabled, D.statusBarNowNextEnabled),
    externalUriActionsEnabled:       normBool(merged.externalUriActionsEnabled, D.externalUriActionsEnabled),
    externalUriActionSecret:         normStr(merged.externalUriActionSecret, D.externalUriActionSecret),
    pinnedDockEnabled:               normBool(merged.pinnedDockEnabled, D.pinnedDockEnabled),
    kanbanRules:                     Array.isArray(merged.kanbanRules) ? normalizeKanbanRules(merged.kanbanRules) : D.kanbanRules,
    wipLimits:                       Array.isArray(merged.wipLimits) ? normalizeWipLimits(merged.wipLimits) : D.wipLimits,
    showWipWarning:                  normBool(merged.showWipWarning, D.showWipWarning),
    reminderSnoozeEnabled:           normBool(merged.reminderSnoozeEnabled, D.reminderSnoozeEnabled),
    reminderSnoozePresets:           Array.isArray(merged.reminderSnoozePresets) && merged.reminderSnoozePresets.every((x: unknown) => typeof x === 'number' && x > 0) ? (merged.reminderSnoozePresets) : D.reminderSnoozePresets,
    quietHoursEnabled:               normBool(merged.quietHoursEnabled, D.quietHoursEnabled),
    quietHoursStart:                 isValidTimeOfDay(merged.quietHoursStart) ? merged.quietHoursStart : D.quietHoursStart,
    quietHoursEnd:                   isValidTimeOfDay(merged.quietHoursEnd) ? merged.quietHoursEnd : D.quietHoursEnd,
    taskFontSize:                    (merged.taskFontSize === 'small' || merged.taskFontSize === 'large') ? merged.taskFontSize : 'normal',
    taskDensity:                     (merged.taskDensity === 'compact' || merged.taskDensity === 'spacious') ? merged.taskDensity : 'comfortable',
    dashboardDensity:                (merged.dashboardDensity === 'compact' || merged.dashboardDensity === 'spacious') ? merged.dashboardDensity : (merged.taskDensity === 'compact' || merged.taskDensity === 'spacious' ? merged.taskDensity : 'comfortable'),
    dashboardTheme:                  (merged.dashboardTheme === 'command-center' || merged.dashboardTheme === 'minimal') ? merged.dashboardTheme : 'native',
    dashboardAutoFitHeights:         normBool(merged.dashboardAutoFitHeights, D.dashboardAutoFitHeights),
    dashboardScope:                  (merged.dashboardScope === 'week' || merged.dashboardScope === 'month') ? merged.dashboardScope : 'today',
    dashboardDailyGoal:              normInt(merged.dashboardDailyGoal, D.dashboardDailyGoal, { min: 1, max: 100 }),
    dashboardCapacityMinutes:        normInt(merged.dashboardCapacityMinutes, D.dashboardCapacityMinutes, { min: 30, max: 1440 }),
    dashboardGoalTagPrefix:          normTagPrefix(merged.dashboardGoalTagPrefix, D.dashboardGoalTagPrefix),
    dashboardAreaTagPrefix:          normTagPrefix(merged.dashboardAreaTagPrefix, D.dashboardAreaTagPrefix),
    priorityColorOverrides:          normalizeColorOverrideMap(merged.priorityColorOverrides),
    statusColorOverrides:            normalizeColorOverrideMap(merged.statusColorOverrides),
    showPriorityPills:               normBool(merged.showPriorityPills, D.showPriorityPills),
    showStatusIcons:                 normBool(merged.showStatusIcons, D.showStatusIcons),
    dashboardLayouts:                (typeof merged.dashboardLayouts === 'object' && merged.dashboardLayouts !== null) ? (merged.dashboardLayouts) : D.dashboardLayouts,
    activeDashboardId:               normStr(merged.activeDashboardId, D.activeDashboardId, true) || 'default',
    dashboardTemplates:              (typeof merged.dashboardTemplates === 'object' && merged.dashboardTemplates !== null) ? (merged.dashboardTemplates) : D.dashboardTemplates,
    customFieldDefinitions,
    ...(savedViewPresets.length > 0 ? { savedViewPresets } : {}),
    kanbanBoards,
    activeKanbanBoardId:             normStr(merged.activeKanbanBoardId, D.activeKanbanBoardId),
    tableViewConfig,
    recurringHeatmapEnabled:         normBool(merged.recurringHeatmapEnabled, D.recurringHeatmapEnabled),
    settingsTabsEnabled:             normBool(merged.settingsTabsEnabled, D.settingsTabsEnabled),
  };
  runtime().applyAiProviderDefaults(normalized, normalized.aiQueryProvider);
  if ((normalized.aiQueryProvider === 'ollama' || normalized.aiQueryProvider === 'lm-studio')
    && !isSafeLocalAiEndpoint(normalized.aiQueryLocalEndpoint)) {
    normalized.aiQueryLocalEndpoint = runtime().defaultAiEndpointForProvider(normalized.aiQueryProvider);
  }
  return normalized;
}
