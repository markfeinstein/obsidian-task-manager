import {
  App,
  ItemView,
  type WorkspaceLeaf,
  Menu,
  Notice,
  Modal,
  Setting,
  debounce,
  setIcon,
  TFile,
  MarkdownRenderChild,
  type Component,
  type MarkdownPostProcessorContext,
} from 'obsidian';
import type {
  TaskManagerSettings,
  DashboardLayout,
  DashboardWidgetConfig,
  DashboardWidgetType,
  DashboardWidgetSize,
  DashboardWidgetPresentation,
  DashboardGridPlacement,
  DashboardScope,
  DashboardTemplate,
  TaskStateDefinition,
} from './types';
import { isTaskNoteFile, scanFileAsTask, type TaskScanner, type ParsedTask, type EditableTaskDateField } from './task-scanner';
import type { TaskQueryRenderer } from './query-renderer';
import type { TaskMutationService } from './task-mutation-service';
import type { CompletionRecord, PersistedState, StateStore, TimeSessionRecord } from './state-store';
import { parseTaskQuery, filterTasks, type TaskQueryOptions } from './task-query';
import { renderCalendar, type CalendarIcsEvent } from './calendar-renderer';
import { renderKanban } from './kanban-renderer';
import { HabitTracker, renderHabitTracker, taskIsHabit } from './habit-tracker';
import { checkboxForStatus, cycleTaskCheckbox, normalizeTaskText, stripInlineTags } from './task-model';
import { ExplicitIdIndex } from './task-identity';
import { formatLocalDate, isValidIsoDate, todayString } from './date-utils';
import { addIsoDays as addDays } from './iso-date';
import { parseEffortMinutesForFilter } from './duration-utils';
import { parseNLPInput } from './nlp-parser';
import { getLocale, t } from './i18n';
import {
  ACHIEVEMENTS,
  getCumulativeXpForLevel,
  getLevelFromXP,
  getUnlockedAchievements,
  getXpForLevel,
  type GamificationStats,
} from './gamification';
import { DailyNoteResolver } from './daily-note';
import { confirmSettingsRemoval } from './settings/confirm-removal';
import { runDashboardRenderQueue } from './dashboard-render-scheduler';
import { buildDashboardAggregates, type DashboardAggregates } from './dashboard-aggregates';
import { setupSwipeHandler, WidgetConfigModal, WidgetInfoModal } from './dashboard-widget-modals';
import {
  DashboardDailyBulkDeleteConfirmModal,
  DashboardDailyDeleteSession,
  planDashboardDailyDelete,
  showDashboardDeletePlanningError,
} from './dashboard-daily-delete';
import {
  applyManualOrderWrites,
  applyRowMove,
  attachManualDrag,
  hasManualOrder,
  isManualOrderWritableTask,
  planManualReorder,
  sortTasksWithManualOrder,
} from './manual-order';
import {
  DASHBOARD_COLLAPSED_SPAN,
  DASHBOARD_GRID_COLUMNS,
  DASHBOARD_GRID_SCALE,
  DASHBOARD_MIN_H,
  DASHBOARD_MIN_W,
  DASHBOARD_RAIL_MAX_PX,
  DASHBOARD_RAIL_MIN_PX,
  DASHBOARD_WIDGET_SIZES,
  bestActionGridColumns,
  clampGridPlacement,
  compactGridPlacements,
  dashboardActionGridTemplate,
  dashboardEffectiveGridRowSpan,
  dashboardWidgetRowLimit,
  ensureGridPlacements,
  findFreeGridSlot,
  gridDropPushDirection,
  gridFootprintForSize,
  normalizeDashboardWidgetPresentation,
  normalizeDashboardWidgetSize,
  redistributeEmptyCardWidths,
  redistributeRailWidthsToPrimary,
  resolveDirectionalCollisions,
  resolveGridCollisions,
  resizeEdgePushDirection,
  responsiveColumnCount,
  scaleGridPlacements,
  shouldStackDashboard,
  sizeFromGridFootprint,
  type DashboardTemplateTone,
} from './dashboard-layout';
export * from './dashboard-layout';
export * from './dashboard-registry';
export * from './dashboard-model';
export * from './dashboard-persistence';
import {
  defaultWidgetTitle,
  migrateDashboardLayout,
} from './dashboard-model';
import {
  DASHBOARD_BUILTIN_TEMPLATES,
  cloneDashboardLayout,
  cloneDashboardWidgetConfig,
  cloneDashboardTemplateAsLayout,
  compactDefaultSummaryWidget,
  consolidateDefaultRightRailIntoToday,
  createDashboardLayoutFromTemplate,
  createDefaultDashboardLayout,
  createDashboardTemplateFromLayout,
  dashboardTemplateToneForId,
  dropRedundantMomentumWidget,
  exportDashboardCollection,
  exportDashboardLayout,
  foldOverdueCardIntoAgenda,
  isRecord,
  mergeNextUpAgendaIntoToday,
  parseDashboardImportPayload,
  parseDashboardLayoutBlock,
  parseDashboardWidgetBlock,
  refreshPristineTemplateLayout,
  uniqueDashboardId,
} from './dashboard-persistence';

export const VIEW_TYPE_DASHBOARD = 'task-manager-dashboard';
let dashboardViewSequence = 0;

// Deterministic sizing and responsive layout live in dashboard-layout.ts.

const DASHBOARD_SCROLLABLE_WIDGET_TYPES: ReadonlySet<DashboardWidgetType> = new Set<DashboardWidgetType>([
  'calendar-mini',
  'eisenhower',
  'habits',
  'kanban-mini',
  'saved-views',
  'tag-explorer',
  'today-schedule',
]);

function dashboardWidgetArea(config: DashboardWidgetConfig): number {
  const footprint = config.grid ?? gridFootprintForSize(normalizeDashboardWidgetSize(config.size));
  return Math.max(1, footprint.w) * Math.max(1, footprint.h);
}

export function dashboardWidgetPresentation(config: DashboardWidgetConfig): DashboardWidgetPresentation {
  if (config.type === 'daily-todos') return 'standard';
  const explicit = normalizeDashboardWidgetPresentation(config.presentation);
  if (explicit) return explicit;
  const placement = config.grid;
  if (placement?.x === 0 && placement.y === 0 && dashboardWidgetArea(config) >= 12 * DASHBOARD_GRID_SCALE * DASHBOARD_GRID_SCALE) return 'hero';
  if (placement?.y === 0 && dashboardWidgetArea(config) <= 9 * DASHBOARD_GRID_SCALE * DASHBOARD_GRID_SCALE) return 'kpi';
  return 'standard';
}

function dashboardWidgetAllowsInnerScroll(config: DashboardWidgetConfig): boolean {
  return DASHBOARD_SCROLLABLE_WIDGET_TYPES.has(config.type);
}

function dashboardCardContentClass(type: DashboardWidgetType): string {
  if (['stats', 'productivity-score', 'daily-goal', 'completion-forecast', 'momentum'].includes(type)) return 'is-kpi-card';
  if (['burndown', 'cumulative-flow', 'scope-burnup', 'throughput', 'time-by-project', 'capacity-planner', 'productivity-score', 'completion-heatmap', 'time-heatmap'].includes(type)) return 'is-chart-card';
  if (['calendar-mini', 'kanban-mini', 'today-schedule', 'deadline-strip', 'eisenhower', 'habits'].includes(type)) return 'is-spatial-card';
  return 'is-list-card';
}

function dashboardCardRoleClass(type: DashboardWidgetType): string | null {
  if (['overdue-risk', 'risk-radar', 'schedule-conflicts', 'sync-conflicts', 'blocked-waiting', 'date-quality', 'stale-tasks', 'recurrence-health'].includes(type)) return 'tm-dash-card--alert';
  if (['quick-capture', 'quick-actions', 'daily-note', 'saved-views', 'tag-explorer'].includes(type)) return 'tm-dash-card--action';
  if (['burndown', 'cumulative-flow', 'scope-burnup', 'throughput', 'capacity-planner', 'completion-forecast'].includes(type)) return 'tm-dash-card--trend';
  return null;
}

/**
 * Per-widget accent hue, returned as a CSS colour variable that styles.css mixes into the card's
 * chrome (top bar, icon chip, badge, charts, hover glow). Gives each card a categorical colour so
 * the board reads as a vibrant, organised dashboard rather than a wall of identical panels.
 * Alert widgets return null so their red → green "all-clear" state styling owns the accent instead.
 */
/**
 * Semantic accent roles: the card's hue now encodes its *function* so the board reads as an
 * organised system rather than a random colour wall. One hue per job:
 *   schedule = blue (when), focus = purple (do now), progress = green (done / momentum / analytics),
 *   triage = amber (needs sorting), capture = cyan (input / tools). Alert cards are excluded — they
 *   keep their own red → green “all clear” styling (see dashboardCardRoleClass).
 */
const DASHBOARD_ACCENT_ROLE_TYPES: Record<string, readonly DashboardWidgetType[]> = {
  schedule: ['agenda', 'upcoming', 'today-schedule', 'daily-todos', 'calendar-mini', 'deadline-strip', 'time-block-suggestions', 'capacity-planner', 'needs-scheduling'],
  focus: ['today', 'focus-queue', 'next-action-project', 'eisenhower', 'pinned-tasks', 'quick-wins', 'deep-work', 'goals-progress', 'areas-of-responsibility'],
  progress: ['stats', 'momentum', 'daily-goal', 'pomodoro', 'recently-completed', 'weekly-review', 'shutdown-ritual', 'habits', 'subtask-progress', 'time-by-project', 'throughput', 'cycle-time', 'productivity-score', 'completion-heatmap', 'time-heatmap', 'completion-forecast', 'burndown', 'cumulative-flow', 'scope-burnup'],
  triage: ['inbox-triage', 'review-queue', 'follow-up'],
  capture: ['quick-capture', 'quick-actions', 'saved-views', 'tag-explorer', 'daily-note'],
};

const DASHBOARD_ACCENT_ROLE_COLOR: Record<string, string> = {
  schedule: 'var(--color-blue)',
  focus: 'var(--color-purple)',
  progress: 'var(--color-green)',
  triage: 'var(--color-yellow)',
  capture: 'var(--color-cyan)',
};

/** The semantic accent role for a widget type (schedule/focus/progress/triage/capture), or null. */
export function dashboardWidgetAccentRole(type: DashboardWidgetType): string | null {
  // Alert widgets own their red → green state styling, so they take no categorical accent.
  if (dashboardCardRoleClass(type) === 'tm-dash-card--alert') return null;
  for (const role of Object.keys(DASHBOARD_ACCENT_ROLE_TYPES)) {
    if (DASHBOARD_ACCENT_ROLE_TYPES[role].includes(type)) return role;
  }
  return null;
}

function dashboardWidgetAccentColor(type: DashboardWidgetType): string | null {
  const role = dashboardWidgetAccentRole(type);
  return role ? DASHBOARD_ACCENT_ROLE_COLOR[role] : null;
}

function applyDashboardCardVisualClasses(el: HTMLElement, config: DashboardWidgetConfig): void {
  const presentation = dashboardWidgetPresentation(config);
  el.toggleClass('tm-dash-card--hero', presentation === 'hero');
  el.toggleClass('tm-dash-card--kpi', presentation === 'kpi');
  el.toggleClass('tm-dash-card--summary', config.type === 'stats');
  el.toggleClass('tm-dash-card--daily-todos', config.type === 'daily-todos');
  el.toggleClass('is-scrollable', dashboardWidgetAllowsInnerScroll(config));
  el.addClass(dashboardCardContentClass(config.type));
  const roleClass = dashboardCardRoleClass(config.type);
  if (roleClass) el.addClass(roleClass);
  // Overdue is a recoverable, time-based *warning* (amber), not a hard error (red) — and it should
  // keep that warning identity rather than washing green when empty. The `--warn` modifier re-tints
  // the shared alert chrome to amber and opts out of the red→green all-clear flip (see styles.css).
  el.toggleClass('tm-dash-card--warn', config.type === 'overdue-risk');
  const accent = dashboardWidgetAccentColor(config.type);
  if (accent) el.style.setProperty('--tm-dash-accent', accent);
  else el.style.removeProperty('--tm-dash-accent');
}

// Deterministic grid placement lives in dashboard-layout.ts.


export function dashboardDayDiff(fromIso: string, toIso: string): number {
  return Math.round((Date.parse(`${toIso}T00:00:00Z`) - Date.parse(`${fromIso}T00:00:00Z`)) / 86_400_000);
}

export function dashboardScopeRange(scope: DashboardScope, today: string): { start: string; end: string; label: string } {
  if (scope === 'week') return { start: today, end: addDays(today, 6), label: 'This week' };
  if (scope === 'month') return { start: today, end: addDays(today, 29), label: 'This month' };
  return { start: today, end: today, label: 'Today' };
}

function normalizeDashboardDateValue(value: unknown): string | undefined {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return formatLocalDate(value);
  if (typeof value === 'number' && Number.isFinite(value)) value = String(Math.trunc(value));
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  const iso = /^(?:\[\[)?(\d{4}-\d{2}-\d{2})(?:[T\s].*)?(?:\]\])?$/u.exec(trimmed)?.[1]
    ?? /^(\d{4})(\d{2})(\d{2})$/u.exec(trimmed)?.slice(1).join('-');
  return iso && isValidIsoDate(iso) ? iso : undefined;
}

function frontmatterValue(frontmatter: Record<string, unknown> | undefined, key: string): unknown {
  if (!frontmatter) return undefined;
  if (Object.prototype.hasOwnProperty.call(frontmatter, key)) return frontmatter[key];
  const lower = key.toLowerCase();
  const match = Object.keys(frontmatter).find((candidate) => candidate.toLowerCase() === lower);
  return match ? frontmatter[match] : undefined;
}

function dashboardDailyTodosDate(config: DashboardWidgetConfig, context: WidgetRenderContext): string | undefined {
  const configured = config.customConfig?.date;
  if (typeof configured === 'string') {
    const keyword = configured.trim().toLowerCase();
    if (keyword === 'today') return context.today;
    if (keyword !== 'note' && keyword !== 'property' && keyword !== 'frontmatter') {
      const date = normalizeDashboardDateValue(configured);
      if (date) return date;
    }
  } else {
    const date = normalizeDashboardDateValue(configured);
    if (date) return date;
  }
  const configuredDateProperty = config.customConfig?.dateProperty;
  const dateProperty = typeof configuredDateProperty === 'string' && configuredDateProperty.trim()
    ? configuredDateProperty.trim()
    : 'date';
  return normalizeDashboardDateValue(frontmatterValue(context.noteFrontmatter, dateProperty)) ?? context.today;
}

const DASHBOARD_MONTH_ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Compact, timezone-stable "Mon D" label for an ISO date (YYYY-MM-DD). */
export function dashboardShortDate(iso: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(iso);
  if (!match) return iso;
  const month = DASHBOARD_MONTH_ABBR[Number(match[2]) - 1] ?? match[2];
  return `${month} ${Number(match[3])}`;
}

/** Format an hour-of-day (0-23) as a compact 12-hour label, e.g. "9a" / "3p". */
export function dashboardFormatHour(hour: number): string {
  const h = ((hour % 24) + 24) % 24;
  const period = h < 12 ? 'a' : 'p';
  const display = h % 12 === 0 ? 12 : h % 12;
  return `${display}${period}`;
}

export function dashboardGreeting(date: Date = new Date()): string {
  const hour = date.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

export function formatDashboardDate(date: Date = new Date()): string {
  try {
    return date.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  } catch {
    return date.toDateString();
  }
}

/** Human-friendly relative label for a task date, with overdue / soon flags for styling. */
export function dashboardRelativeDate(dateIso: string, today: string): { label: string; overdue: boolean; soon: boolean } {
  const diff = dashboardDayDiff(today, dateIso);
  if (diff < 0) return { label: `${-diff}d overdue`, overdue: true, soon: false };
  if (diff === 0) return { label: 'Today', overdue: false, soon: true };
  if (diff === 1) return { label: 'Tomorrow', overdue: false, soon: true };
  let label = dateIso.slice(5);
  try {
    const local = new Date(`${dateIso}T00:00:00`);
    label = diff < 7
      ? local.toLocaleDateString(undefined, { weekday: 'short' })
      : local.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  } catch {
    // keep ISO fallback
  }
  return { label, overdue: false, soon: false };
}

const DASHBOARD_PRIORITY_RANK: Record<string, number> = { highest: 0, high: 1, medium: 2, normal: 3, low: 4, lowest: 5 };

function dashboardTaskDate(task: ParsedTask): string | undefined {
  return task.metadata?.dates?.due ?? task.metadata?.dates?.scheduled;
}

function compareDashboardTasks(a: ParsedTask, b: ParsedTask): number {
  const da = dashboardTaskDate(a) ?? '9999-99-99';
  const db = dashboardTaskDate(b) ?? '9999-99-99';
  if (da !== db) return da < db ? -1 : 1;
  const ra = DASHBOARD_PRIORITY_RANK[a.metadata?.priority ?? 'normal'] ?? 3;
  const rb = DASHBOARD_PRIORITY_RANK[b.metadata?.priority ?? 'normal'] ?? 3;
  return ra - rb;
}

/**
 * Earliest scheduling-relevant date for the Agenda: due, scheduled, OR start (🛫). The Agenda
 * advertises all three, so a task that only carries a start date within the window should still
 * surface here. Agenda-scoped on purpose — dashboardTaskDate() (due ?? scheduled) is used widely
 * by other widgets and must keep its narrower meaning.
 */
function dashboardAgendaDate(task: ParsedTask): string | undefined {
  const dates = task.metadata?.dates ?? {};
  let earliest: string | undefined;
  for (const date of [dates.due, dates.scheduled, dates.start]) {
    if (date && (earliest === undefined || date < earliest)) earliest = date;
  }
  return earliest;
}

function compareDashboardAgendaTasks(a: ParsedTask, b: ParsedTask): number {
  const da = dashboardAgendaDate(a) ?? '9999-99-99';
  const db = dashboardAgendaDate(b) ?? '9999-99-99';
  if (da !== db) return da < db ? -1 : 1;
  const ra = DASHBOARD_PRIORITY_RANK[a.metadata?.priority ?? 'normal'] ?? 3;
  const rb = DASHBOARD_PRIORITY_RANK[b.metadata?.priority ?? 'normal'] ?? 3;
  return ra - rb;
}

type DashboardAgendaBucket = 'overdue' | 'today' | 'upcoming';

/**
 * The date an agenda row is grouped and sorted by. Due/scheduled dates still drive overdue grouping
 * and row chips, but an already-startable task with only a future chip belongs in Today because its
 * start date is why it appears in the active agenda scope. Start-only tasks likewise pin past starts
 * to Today rather than treating them as overdue.
 */
function dashboardAgendaRowDate(task: ParsedTask, today: string): string {
  const dates = task.metadata?.dates ?? {};
  const chip = dashboardTaskDate(task);
  if (dates.start && dates.start <= today && (!chip || chip > today)) return today;
  if (chip) return chip;
  if (!dates.start) return '9999-99-99';
  return dates.start < today ? today : dates.start;
}

export function dashboardAgendaRowBucket(task: ParsedTask, today: string): DashboardAgendaBucket {
  const date = dashboardAgendaRowDate(task, today);
  if (date < today) return 'overdue';
  if (date === today) return 'today';
  return 'upcoming';
}

export function dashboardAgendaBucketLabel(bucket: DashboardAgendaBucket, scope: DashboardScope): string {
  if (bucket === 'overdue') return 'Overdue';
  if (bucket === 'today') return 'Today';
  return scope === 'week' ? 'This week' : scope === 'month' ? 'This month' : 'Upcoming';
}

function dashboardAgendaBucketCounts(tasks: readonly ParsedTask[], today: string): Record<DashboardAgendaBucket, number> {
  const counts: Record<DashboardAgendaBucket, number> = { overdue: 0, today: 0, upcoming: 0 };
  for (const task of tasks) counts[dashboardAgendaRowBucket(task, today)] += 1;
  return counts;
}

export interface DashboardAgendaSection {
  bucket: DashboardAgendaBucket | null;
  label: string | null;
  count: number;
  tasks: ParsedTask[];
}

export function dashboardAgendaSections(orderedTasks: readonly ParsedTask[], today: string, scope: DashboardScope, grouped = true): DashboardAgendaSection[] {
  if (!orderedTasks.length) return [];
  if (!grouped) return [{ bucket: null, label: null, count: orderedTasks.length, tasks: [...orderedTasks] }];
  const counts = dashboardAgendaBucketCounts(orderedTasks, today);
  const sections: DashboardAgendaSection[] = [];
  for (const task of orderedTasks) {
    const bucket = dashboardAgendaRowBucket(task, today);
    let section = sections[sections.length - 1];
    if (!section || section.bucket !== bucket) {
      section = {
        bucket,
        label: dashboardAgendaBucketLabel(bucket, scope),
        count: counts[bucket],
        tasks: [],
      };
      sections.push(section);
    }
    section.tasks.push(task);
  }
  return sections;
}

export function dashboardAgendaSectionModel(tasks: readonly ParsedTask[], today: string, scope: DashboardScope, grouped = true): DashboardAgendaSection[] {
  const agenda = [...filterDashboardAgendaTasks([...tasks], today, scope)].sort(compareDashboardAgendaRows(today));
  return dashboardAgendaSections(agenda, today, scope, grouped);
}

export function dashboardReviewQueueGroups<T extends { tasks: readonly unknown[] }>(queues: readonly T[]): T[] {
  return queues.filter((queue) => queue.tasks.length > 0);
}

function compareDashboardAgendaRows(today: string): (a: ParsedTask, b: ParsedTask) => number {
  return (a, b) => {
    const da = dashboardAgendaRowDate(a, today);
    const db = dashboardAgendaRowDate(b, today);
    if (da !== db) return da < db ? -1 : 1;
    const ra = DASHBOARD_PRIORITY_RANK[a.metadata?.priority ?? 'normal'] ?? 3;
    const rb = DASHBOARD_PRIORITY_RANK[b.metadata?.priority ?? 'normal'] ?? 3;
    return ra - rb;
  };
}

// ── Task set filters (pure, unit-tested) ────────────────────────────────────

export function filterDashboardActiveTasks(tasks: ParsedTask[]): ParsedTask[] {
  return tasks.filter((task) => task.status !== 'done' && task.status !== 'cancelled' && task.status !== 'untracked');
}

export interface DashboardDailyTodosModel {
  date: string;
  carryForward: ParsedTask[];
  completed: ParsedTask[];
  cancelled: ParsedTask[];
  badge: string | null;
}

function dashboardDailyTodosTaskDate(task: ParsedTask): string | undefined {
  const dates = task.metadata?.dates ?? {};
  const candidates = [dates.due, dates.scheduled].filter((date): date is string => Boolean(date));
  return candidates.sort()[0];
}

function compareDashboardDailyTodosTasks(date: string): (a: ParsedTask, b: ParsedTask) => number {
  return (a, b) => {
    const da = dashboardDailyTodosTaskDate(a) ?? '9999-99-99';
    const db = dashboardDailyTodosTaskDate(b) ?? '9999-99-99';
    if (da !== db) return da < db ? -1 : 1;
    const overdueA = da < date ? 0 : 1;
    const overdueB = db < date ? 0 : 1;
    if (overdueA !== overdueB) return overdueA - overdueB;
    const statusRank: Record<string, number> = { todo: 0, in_progress: 1, done: 2, deferred: 3, waiting: 4, blocked: 4, on_hold: 4, cancelled: 5, untracked: 6 };
    const sa = statusRank[dashboardDailyTodoVisualState(a)] ?? statusRank[a.status] ?? 99;
    const sb = statusRank[dashboardDailyTodoVisualState(b)] ?? statusRank[b.status] ?? 99;
    if (sa !== sb) return sa - sb;
    const pa = DASHBOARD_PRIORITY_RANK[a.metadata?.priority ?? 'normal'] ?? 3;
    const pb = DASHBOARD_PRIORITY_RANK[b.metadata?.priority ?? 'normal'] ?? 3;
    if (pa !== pb) return pa - pb;
    return dashboardTaskDisplayText(a).localeCompare(dashboardTaskDisplayText(b));
  };
}

function compareDashboardClosedDailyTodos(a: ParsedTask, b: ParsedTask): number {
  return (a.filePath ?? '').localeCompare(b.filePath ?? '') || (a.lineNumber ?? 0) - (b.lineNumber ?? 0) || dashboardTaskDisplayText(a).localeCompare(dashboardTaskDisplayText(b));
}

export function dashboardDailyTodosModel(tasks: ParsedTask[], date: string): DashboardDailyTodosModel {
  const carryForward = filterDashboardActiveTasks(tasks)
    .filter((task) => {
      const { due, scheduled } = task.metadata?.dates ?? {};
      return Boolean((due && due <= date) || (scheduled && scheduled <= date));
    })
    .sort(compareDashboardDailyTodosTasks(date));
  const completed = tasks
    .filter((task) => task.status === 'done' && task.metadata?.dates?.done === date)
    .sort(compareDashboardClosedDailyTodos);
  const cancelled = tasks
    .filter((task) => task.status === 'cancelled' && task.metadata?.dates?.cancelled === date)
    .sort(compareDashboardClosedDailyTodos);
  const total = carryForward.length + completed.length + cancelled.length;
  return { date, carryForward, completed, cancelled, badge: total ? String(total) : null };
}

export function filterDashboardOverdueTasks(tasks: ParsedTask[], today: string): ParsedTask[] {
  return filterDashboardActiveTasks(tasks).filter((task) => {
    // Overdue uses the same date the row chip shows — dashboardTaskDate() = due ?? scheduled — so a
    // task whose chip reads "Nd overdue" is always counted here too. (Previously this checked the due
    // date only, so a task with just a past ⏳ scheduled date showed a red "overdue" chip yet never
    // appeared in the Overdue card/tile.) Due still wins when present, matching the chip's precedence.
    const date = dashboardTaskDate(task);
    return Boolean(date && date < today);
  });
}

export function filterDashboardUpcomingTasks(tasks: ParsedTask[], today: string, days = 7): ParsedTask[] {
  const end = addDays(today, days);
  return filterDashboardActiveTasks(tasks).filter((task) => {
    const { scheduled, due } = task.metadata.dates;
    return [scheduled, due].some((date) => Boolean(date && date >= today && date <= end));
  });
}

function dashboardRecentlyCompletedRange(today: string, scopeOrDays: DashboardScope | number): { start: string; end: string } {
  if (typeof scopeOrDays === 'number') return { start: addDays(today, -scopeOrDays), end: today };
  if (scopeOrDays === 'today') return { start: today, end: today };
  if (scopeOrDays === 'month') return { start: `${today.slice(0, 7)}-01`, end: today };
  // Week scope is a rolling seven-day completion window, inclusive of today.
  return { start: addDays(today, -6), end: today };
}

export function filterDashboardRecentlyCompletedTasks(tasks: ParsedTask[], today: string, scopeOrDays: DashboardScope | number = 'week'): ParsedTask[] {
  const { start, end } = dashboardRecentlyCompletedRange(today, scopeOrDays);
  return tasks
    .filter((task) => {
      const done = task.metadata.dates.done ?? '';
      return task.status === 'done' && done >= start && done <= end;
    })
    .sort((a, b) => (b.metadata.dates.done ?? '').localeCompare(a.metadata.dates.done ?? ''));
}

/** Tasks (overdue + within the active scope window) for the agenda widget, date-sorted. */
export function filterDashboardAgendaTasks(tasks: ParsedTask[], today: string, scope: DashboardScope): ParsedTask[] {
  const { end } = dashboardScopeRange(scope, today);
  return filterDashboardActiveTasks(tasks)
    .filter((task) => {
      const date = dashboardAgendaDate(task);
      return Boolean(date && date <= end);
    })
    .sort(compareDashboardAgendaTasks);
}

export function filterDashboardActiveHabits(tasks: ParsedTask[]): ParsedTask[] {
  return filterDashboardActiveTasks(tasks).filter(taskIsHabit);
}

export function isDashboardPathExcluded(path: string, excludedFolders: string[] = []): boolean {
  const lowerPath = path.toLowerCase();
  return excludedFolders.some((folder) => {
    const prefix = folder.trim().replace(/^\/+|\/+$/gu, '').toLowerCase();
    return Boolean(prefix && (lowerPath === prefix || lowerPath.startsWith(`${prefix}/`)));
  });
}

export function dashboardQueryOptions(settings: TaskManagerSettings): TaskQueryOptions {
  return {
    nlpQueryEnabled: settings.nlpQueryEnabled,
    states: settings.supportedStates,
    savedQueries: settings.savedQueries,
    globalFilter: settings.globalFilter,
    enableQueryDsl: settings.enableQueryDsl,
    enableDslExpressions: settings.enableDslExpressions,
  };
}

// ── Pomodoro helpers (pure, unit-tested) ────────────────────────────────────

export function formatPomodoroSeconds(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(safe / 60)).padStart(2, '0')}:${String(safe % 60).padStart(2, '0')}`;
}

export function createPomodoroTimeSession(
  task: ParsedTask,
  startedAtIso: string,
  endedAtIso: string,
  elapsedMinutes: number,
): TimeSessionRecord {
  return {
    taskKey: task.key,
    taskFilePath: task.filePath,
    taskLineNumber: task.lineNumber,
    taskText: task.normalizedText || task.body,
    startedAtIso,
    endedAtIso,
    elapsedMinutes: Math.max(1, Math.round(elapsedMinutes)),
    source: 'pomodoro',
  };
}

export function calculatePomodoroSessionTiming(startedAtMs: number, accumulatedMs: number, endedAtMs: number): { startedAtMs: number; elapsedMs: number } | null {
  const elapsedMs = Math.max(0, accumulatedMs) + (startedAtMs > 0 ? Math.max(0, endedAtMs - startedAtMs) : 0);
  if (elapsedMs <= 0) return null;
  return { startedAtMs: endedAtMs - elapsedMs, elapsedMs };
}

// ── Widget registry ─────────────────────────────────────────────────────────

export type WidgetDisposer = () => void;

type DashboardResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

interface DashboardGridMetrics {
  /** Grid content-box left/top in client coordinates. */
  left: number;
  top: number;
  /** Width of a single column cell (px), excluding gap. */
  cellW: number;
  /** Height of a single row cell (px), excluding gap. */
  cellH: number;
  /** Gap between cells (px). */
  gap: number;
  cols: number;
}

interface DashboardPointerDragState {
  card: DashboardCard;
  pointerId: number;
  startX: number;
  startY: number;
  /** Pointer offset from the card's top-left at grab time (px). */
  grabOffsetX: number;
  grabOffsetY: number;
  /** Pixel footprint of the card at grab time. */
  width: number;
  height: number;
  metrics: DashboardGridMetrics;
  active: boolean;
  placeholder: HTMLElement | null;
  targetX: number;
  targetY: number;
  /** Index of the dragged widget within `layout.widgets`. */
  draggedIndex: number;
  /** Snapshot of every widget's placement at grab time (drives a deterministic preview). */
  basePlacements: DashboardGridPlacement[];
  /** Latest resolved preview layout (committed on drop). */
  preview: DashboardGridPlacement[] | null;
  /** Signature of the applied preview, to skip redundant reflows. */
  previewKey: string;
}

interface DashboardResizeState {
  card: DashboardCard;
  edge: DashboardResizeEdge;
  pointerId: number;
  startX: number;
  startY: number;
  start: DashboardGridPlacement;
  metrics: DashboardGridMetrics;
  overlay: HTMLElement;
  current: DashboardGridPlacement;
  /** Index of the resized widget within `layout.widgets`. */
  index: number;
  /** Snapshot of every widget's placement at resize start. */
  basePlacements: DashboardGridPlacement[];
  /** Latest resolved preview layout. */
  preview: DashboardGridPlacement[] | null;
  /** Signature of the applied preview, to skip redundant reflows. */
  previewKey: string;
  /** Content-derived height for widgets whose vertical size is owned by their renderer. */
  contentFitH?: number;
}

/** Drag must move at least this many pixels before it is treated as a drag (vs. a click). */
const DASHBOARD_DRAG_THRESHOLD = 4;
const DASHBOARD_DAILY_RESORT_DELAY_MS = 3_000;

function scheduleDashboardDailyResort(bulk: DashboardDailyBulkContext): void {
  if (bulk.resortTimer !== null) window.clearTimeout(bulk.resortTimer);
  bulk.resortTimer = window.setTimeout(() => {
    bulk.resortTimer = null;
    bulk.resortRows();
  }, DASHBOARD_DAILY_RESORT_DELAY_MS);
}

export interface WidgetRenderContext {
  app: App;
  scanner: TaskScanner;
  settings: TaskManagerSettings;
  queryRenderer?: TaskQueryRenderer;
  taskMutations?: TaskMutationService;
  stateStore?: StateStore;
  state?: Readonly<PersistedState>;
  aggregates?: DashboardAggregates<ParsedTask>;
  /** Shared, already-scanned task set for this refresh — widgets must not rescan. */
  tasks: ParsedTask[];
  today: string;
  scope: DashboardScope;
  /** Markdown note path for embedded widgets, when rendered inside a note. */
  notePath?: string;
  /** Frontmatter for the containing Markdown note, when available to an embedded widget. */
  noteFrontmatter?: Record<string, unknown>;
  /** Request a local presentation/settings refresh. */
  requestRefresh: () => void;
  /** Request task-data refresh; production waits for the next TaskIndex revision. */
  requestTaskRefresh: () => void;
  openTask: (task: ParsedTask) => Promise<void>;
  toggleTask: (task: ParsedTask) => Promise<void>;
  /** Append a captured task (raw description) to the configured inbox / daily note. */
  createTask?: (text: string) => Promise<void>;
  /** Persist the current settings object (e.g. after a widget mutates a setting). */
  saveSettings?: () => void;
  /** Fetch (and cache) calendar overlay events for schedule-oriented widgets. */
  fetchIcsEvents?: () => Promise<CalendarIcsEvent[]>;
  /** Dashboard-owner-scoped transaction history for daily bulk delete and undo. */
  dailyDeleteSession?: DashboardDailyDeleteSession;
  /** Set the card-header count badge (null clears it). */
  setBadge: (text: string | null) => void;
  /** When true, card heights are derived from content — widgets use a stable size-based row cap. */
  autoFit?: boolean;
}

async function updateDashboardTaskCheckbox(file: TFile, task: ParsedTask, checkbox: string, context: WidgetRenderContext): Promise<ParsedTask> {
  const updated = context.taskMutations
    ? await context.taskMutations.updateTaskCheckbox(file, task, checkbox)
    : await context.scanner.updateTaskCheckbox(file, task, checkbox);
  if (!context.taskMutations) context.queryRenderer?.invalidateCache(task.filePath);
  return updated;
}

async function updateDashboardTaskDate(file: TFile, task: ParsedTask, field: EditableTaskDateField, date: string | null, context: WidgetRenderContext): Promise<ParsedTask> {
  const updated = context.taskMutations
    ? await context.taskMutations.updateTaskDate(file, task, field, date)
    : await context.scanner.updateTaskDate(file, task, field, date);
  if (!context.taskMutations) context.queryRenderer?.invalidateCache(task.filePath);
  return updated;
}

/** A keyboard shortcut documented in a widget's info popup. */
export interface WidgetShortcut {
  /** Human-readable key combo, e.g. "Enter" or "Shift + ↑". */
  keys: string;
  /** What the shortcut does. */
  description: string;
}

export interface WidgetRenderer {
  title: string;
  icon: string;
  description?: string;
  /** Optional longer explanation shown in the widget info popup (falls back to `description`). */
  details?: string;
  /** Optional widget-specific keyboard shortcuts shown in the widget info popup. */
  shortcuts?: WidgetShortcut[];
  defaultSize: DashboardWidgetSize;
  /** When true, the widget manages its own state and is skipped on background refreshes. */
  live?: boolean;
  render(
    container: HTMLElement,
    config: DashboardWidgetConfig,
    context: WidgetRenderContext,
  ): Promise<void | WidgetDisposer> | void | WidgetDisposer;
}

export class WidgetRegistry {
  private readonly renderers = new Map<DashboardWidgetType, WidgetRenderer>();

  register(type: DashboardWidgetType, renderer: WidgetRenderer): void {
    this.renderers.set(type, renderer);
  }

  getRenderer(type: DashboardWidgetType): WidgetRenderer | undefined {
    return this.renderers.get(type);
  }

  getAllTypes(): DashboardWidgetType[] {
    return Array.from(this.renderers.keys());
  }
}

// ── Shared rendering primitives ─────────────────────────────────────────────

function renderDashEmpty(container: HTMLElement, icon: string, message: string, hint?: string): void {
  const empty = container.createDiv('tm-dash-empty');
  if (icon === 'alert-circle') empty.dataset.autoCollapse = 'false';
  const iconEl = empty.createDiv('tm-dash-empty-icon');
  setIcon(iconEl, icon);
  empty.createDiv({ cls: 'tm-dash-empty-text', text: message });
  if (hint) empty.createDiv({ cls: 'tm-dash-empty-hint', text: hint });
}

/** Format an integer count for display: thousands separators so big vaults read cleanly (12,345). */
export function formatDashboardCount(value: number): string {
  if (!Number.isFinite(value)) return String(value);
  return Math.round(value).toLocaleString();
}

/**
 * Format a header badge. A badge that is purely digits is a count, so it gets thousands separators;
 * badges that already carry units/punctuation (`87%`, `2h 30m`, `3 · 1`) are passed through untouched.
 */
export function formatDashboardBadge(text: string): string {
  return /^\d+$/.test(text) ? Number(text).toLocaleString() : text;
}

export interface DashboardWowDelta { current: number; previous: number; diff: number }

/**
 * Week-over-week count derived purely from a list of ISO dates (e.g. completion dates) — no
 * historical snapshots required. `current` counts the trailing 7 days (today-6 … today);
 * `previous` counts the 7 days before that (today-13 … today-7).
 */
export function dashboardWeekOverWeekCount(dates: string[], today: string): DashboardWowDelta {
  const curStart = addDays(today, -6);
  const prevStart = addDays(today, -13);
  const prevEnd = addDays(today, -7);
  let current = 0;
  let previous = 0;
  for (const date of dates) {
    if (!date) continue;
    if (date >= curStart && date <= today) current += 1;
    else if (date >= prevStart && date <= prevEnd) previous += 1;
  }
  return { current, previous, diff: current - previous };
}

/** Render a week-over-week delta as a short label + trend tone. `higherIsBetter` flips good/bad. */
export function formatDashboardDelta(diff: number, higherIsBetter = true): { text: string; tone: 'up' | 'down' | 'neutral' } {
  if (diff === 0) return { text: 'Same as last week', tone: 'neutral' };
  const arrow = diff > 0 ? '▲' : '▼';
  const good = higherIsBetter ? diff > 0 : diff < 0;
  return { text: `${arrow} ${formatDashboardCount(Math.abs(diff))} vs last week`, tone: good ? 'up' : 'down' };
}

function renderDashboardInsight(container: HTMLElement, icon: string, text: string, tone: 'neutral' | 'good' | 'watch' | 'risk' = 'neutral'): HTMLElement {
  const insight = container.createDiv({ cls: `tm-dash-insight tm-dash-insight--${tone}` });
  const iconEl = insight.createSpan('tm-dash-insight-icon');
  setIcon(iconEl, icon);
  insight.createSpan({ cls: 'tm-dash-insight-text', text });
  return insight;
}

/** Compact, interactive task row shared across list widgets. */
/**
 * Roots of the editor slash-command vocabulary (see buildSlashSuggestions). A user can leave a
 * dangling fragment — "/due", "/sched", or a half-typed "/w" for "/when" — in a task line when the
 * autosuggest never fired (e.g. captured outside the editor). Strip those fragments from the
 * display subject so they don't read as garbage. Single-letter "w" (the start of "/when") is a
 * common half-type so it is included; genuinely ambiguous one-letter roots like "p" are not.
 */
const DASHBOARD_DANGLING_SLASH_COMMAND = /(^|\s)\/(?:due|sched(?:ule|uled)?|start|when|w|dates?|repeat|rec(?:urrence)?|priority|remind(?:er)?|done|complete|completion|nl|task)(?=\s|$)/giu;

/** Reduce inline Markdown (bold/italic/strike/highlight/code, wiki + md links) to readable text. */
export function stripDashboardInlineMarkdown(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/gu, '$1')                  // images ![alt](url) -> alt
    .replace(/\[([^\]]+)\]\([^)]*\)/gu, '$1')                   // links  [text](url) -> text
    .replace(/\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/gu, (_m, target: string, alias?: string) =>
      (alias ?? target).replace(/^[#^]/u, '').trim())          // wikilinks [[a|b]]/[[a]]/[[#h]] -> shown text
    .replace(/\*\*([^*]+)\*\*/gu, '$1')                         // **bold**
    .replace(/\*([^*]+)\*/gu, '$1')                             // *italic*
    .replace(/~~([^~]+)~~/gu, '$1')                             // ~~strike~~
    .replace(/==([^=]+)==/gu, '$1')                             // ==highlight==
    .replace(/`([^`]+)`/gu, '$1');                              // `code`
}

/**
 * Subject text shown for a task in widgets: the normalized body with inline #tags removed, inline
 * Markdown reduced to plain text, and dangling slash-command fragments stripped. Never returns a
 * blank string — a tag-only task keeps its tags, and a genuinely empty task reads "Untitled task".
 */
export function dashboardTaskDisplayText(task: ParsedTask): string {
  const base = task.normalizedText || task.body || '';
  const clean = (text: string): string =>
    normalizeTaskText(stripDashboardInlineMarkdown(text).replace(DASHBOARD_DANGLING_SLASH_COMMAND, '$1'));
  const subject = clean(stripInlineTags(base));
  if (subject) return subject;
  // stripInlineTags emptied the line (a task made up entirely of tags): fall back to the cleaned raw
  // text so the tags still show, then to the raw body, and finally to a placeholder for empty tasks.
  return clean(base) || base.trim() || 'Untitled task';
}

/** Render one related-task group ("Unblocks" / "Waiting on") inside the expansion panel. */
function renderDashRelGroup(panel: HTMLElement, label: string, icon: string, tasks: ParsedTask[], context: WidgetRenderContext): void {
  const group = panel.createDiv('tm-dash-rel-group');
  const head = group.createDiv('tm-dash-rel-group-head');
  setIcon(head.createSpan({ cls: 'tm-dash-rel-group-icon' }), icon);
  head.createSpan({ cls: 'tm-dash-rel-group-label', text: label });
  for (const task of tasks) {
    const done = task.status === 'done' || task.status === 'cancelled';
    const item = group.createDiv({ cls: `tm-dash-rel-item${done ? ' is-done' : ''}` });
    setIcon(item.createSpan({ cls: 'tm-dash-rel-item-icon' }), done ? 'check-circle-2' : 'circle');
    const link = item.createSpan({ cls: 'tm-dash-rel-link', text: dashboardTaskDisplayText(task) });
    link.setAttr('role', 'button');
    link.setAttr('tabindex', '0');
    link.setAttr('title', `Open: ${dashboardTaskDisplayText(task)}`);
    const open = (): void => { void context.openTask(task); };
    link.addEventListener('click', open);
    link.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); }
    });
  }
}

/**
 * Add dependency relationship chips to the meta row — “Unblocks N” when other active tasks depend on
 * this one (completing it frees them) and “Waiting on N” for its own blockers. Each chip toggles a
 * shared expansion panel, appended under the row, that lists the actual related tasks as openable
 * links so you can see exactly how the work connects.
 */
function renderDashTaskRelations(main: HTMLElement, meta: HTMLElement, relations: { unblocks: ParsedTask[]; waitingOn: ParsedTask[] }, context: WidgetRenderContext): void {
  if (!relations.unblocks.length && !relations.waitingOn.length) return;
  let panel: HTMLElement | null = null;
  let isOpen = false;
  const chips: HTMLElement[] = [];
  const setOpen = (open: boolean): void => {
    isOpen = open;
    if (open && !panel) {
      panel = main.createDiv('tm-dash-rel-panel');
      if (relations.unblocks.length) renderDashRelGroup(panel, `Unblocks ${relations.unblocks.length}`, 'zap', relations.unblocks, context);
      if (relations.waitingOn.length) renderDashRelGroup(panel, `Waiting on ${relations.waitingOn.length}`, 'clock', relations.waitingOn, context);
    }
    if (panel) panel.style.display = open ? '' : 'none';
    for (const chip of chips) {
      chip.setAttr('aria-expanded', String(open));
      if (open) chip.addClass('is-open'); else chip.removeClass('is-open');
    }
  };
  const toggle = (event: Event): void => { event.preventDefault(); event.stopPropagation(); setOpen(!isOpen); };
  const addChip = (variant: string, icon: string, label: string): void => {
    const chip = meta.createSpan({ cls: `tm-dash-chip tm-dash-rel ${variant}` });
    setIcon(chip.createSpan({ cls: 'tm-dash-rel-icon' }), icon);
    chip.createSpan({ text: label });
    setIcon(chip.createSpan({ cls: 'tm-dash-rel-caret' }), 'chevron-down');
    chip.setAttr('role', 'button');
    chip.setAttr('tabindex', '0');
    chip.setAttr('aria-expanded', 'false');
    chip.addEventListener('click', toggle);
    chip.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') toggle(event);
    });
    chips.push(chip);
  };
  if (relations.unblocks.length) addChip('is-unblocks', 'zap', `Unblocks ${relations.unblocks.length}`);
  if (relations.waitingOn.length) addChip('is-waiting', 'clock', `Waiting on ${relations.waitingOn.length}`);
}

interface DashboardTaskRowOptions {
  /** Suppress the source-note backlink chip (used when a group header already names the note). */
  hideSource?: boolean;
}

export interface DashboardNoteGroup {
  filePath: string;
  /** Note basename without the `.md` extension. */
  label: string;
  tasks: ParsedTask[];
}

/**
 * Cluster tasks by their source note, preserving the order in which each note (and each task within
 * it) first appears. Used to give the Backlog section per-note group headers so a long flat list of
 * captures stops repeating the same source breadcrumb on every row.
 */
export function dashboardGroupTasksByNote(tasks: readonly ParsedTask[]): DashboardNoteGroup[] {
  const groups: DashboardNoteGroup[] = [];
  const byPath = new Map<string, DashboardNoteGroup>();
  for (const task of tasks) {
    let group = byPath.get(task.filePath);
    if (!group) {
      const label = task.filePath.split('/').pop()?.replace(/\.md$/u, '') ?? task.filePath;
      group = { filePath: task.filePath, label, tasks: [] };
      byPath.set(task.filePath, group);
      groups.push(group);
    }
    group.tasks.push(task);
  }
  return groups;
}

function renderDashTaskRow(container: HTMLElement, task: ParsedTask, context: WidgetRenderContext, options: DashboardTaskRowOptions = {}): HTMLElement {
  const priority = task.metadata?.priority ?? 'normal';
  const statusType = task.status === 'done' ? 'done'
    : task.status === 'in_progress' ? 'in-progress'
      : task.status === 'cancelled' ? 'cancelled' : 'todo';
  const row = container.createDiv({ cls: `tm-dash-task tm-dash-task--p-${priority} tm-dash-task--s-${statusType}` });

  const checkboxHit = row.createEl('label', { cls: 'tm-dash-task-check-hit' });
  const checkbox = checkboxHit.createEl('input', { type: 'checkbox', cls: 'tm-dash-task-check' });
  checkbox.checked = task.status === 'done';
  checkbox.setAttr('aria-label', `${task.status === 'done' ? 'Reopen' : 'Advance status for'} ${task.normalizedText}`);
  checkbox.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    void context.toggleTask(task);
  });

  const main = row.createDiv('tm-dash-task-main');
  const label = dashboardTaskDisplayText(task);
  const text = main.createDiv({ cls: 'tm-dash-task-text', text: label });
  text.setAttr('role', 'button');
  text.setAttr('tabindex', '0');
  text.setAttr('title', label);
  const open = (): void => { void context.openTask(task); };
  text.addEventListener('click', open);
  text.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  });

  const meta = main.createDiv('tm-dash-task-meta');
  const project = dashboardRowProject(task);
  if (project) {
    const chip = meta.createSpan({ cls: 'tm-dash-chip tm-dash-task-project' });
    setIcon(chip.createSpan({ cls: 'tm-dash-task-project-icon' }), 'folder');
    chip.createSpan({ text: project.label });
    chip.setAttr('title', `Project: ${project.label}`);
  }
  const dateIso = dashboardTaskDate(task);
  if (dateIso) {
    const rel = dashboardRelativeDate(dateIso, context.today);
    meta.createSpan({
      cls: `tm-dash-chip tm-dash-chip--date${rel.overdue ? ' is-overdue' : rel.soon ? ' is-soon' : ''}`,
      text: rel.label,
    });
  } else if (task.metadata?.dates?.start) {
    // No due/scheduled date, but a start date (🛫) put this row on the Agenda — surface it as a neutral
    // “Start …” chip (never flagged overdue; a past start just means it became startable).
    const startRel = dashboardRelativeDate(task.metadata.dates.start, context.today);
    meta.createSpan({
      cls: 'tm-dash-chip tm-dash-chip--date is-start',
      text: `Start ${startRel.overdue ? task.metadata.dates.start.slice(5) : startRel.label}`,
    });
  }
  if (priority !== 'normal') {
    const flag = meta.createSpan({ cls: `tm-dash-task-flag is-p-${priority}` });
    setIcon(flag, 'flag');
    flag.setAttr('aria-label', `${priority} priority`);
  }
  // Relationship chips (clickable to expand the actual related tasks below the row).
  renderDashTaskRelations(main, meta, dashboardTaskRelations(task, dashboardRelationshipIndex(context.tasks)), context);
  // Inline #tags are stripped from the subject line for readability; surface them here as small
  // chips so the categorisation is still visible at a glance (cap to keep the meta row tidy). A tag
  // already shown as the project chip is suppressed to avoid a duplicate.
  const tagChips = task.tags.filter((tag) => tag !== project?.tag);
  for (const tag of tagChips.slice(0, 3)) {
    meta.createSpan({ cls: 'tm-dash-task-tag', text: `#${tag}` });
  }
  if (tagChips.length > 3) meta.createSpan({ cls: 'tm-dash-task-tag is-more', text: `+${tagChips.length - 3}` });
  const source = task.filePath.split('/').pop()?.replace(/\.md$/u, '') ?? task.filePath;
  // Avoid printing the same label twice: when the source-note name is identical to the project
  // chip (common when a project lives in a same-named note), the chip already conveys it, so the
  // backlink would just repeat it. The task text itself remains clickable to open the note.
  // `hideSource` is set when rows are rendered under a per-note group header that already names the
  // source, so repeating it on every row would be redundant.
  if (!options.hideSource && source !== project?.label) {
    const backlink = meta.createSpan({ cls: 'tm-dash-task-source', text: source });
    backlink.setAttr('role', 'button'); backlink.setAttr('tabindex', '0');
    backlink.setAttr('aria-label', `Open source note ${source}`);
    backlink.setAttr('title', task.filePath);
    backlink.addEventListener('click', open);
    backlink.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
  }
  return row;
}

/**
 * Render a compact week-over-week trend caption above a list card (e.g. "3 newly overdue · ▲ 1 vs
 * last week"). Derived purely from task dates — no historical snapshots. Returns true when a caption
 * was drawn so the caller can reserve one row from the list limit (preventing clipping). Skips
 * drawing when there is no date signal at all, to avoid a meaningless "Same as last week".
 */
function renderDashListTrend(container: HTMLElement, noun: string, wow: DashboardWowDelta, higherIsBetter: boolean): boolean {
  if (wow.current + wow.previous === 0) return false;
  const delta = formatDashboardDelta(wow.diff, higherIsBetter);
  const caption = container.createDiv({ cls: `tm-dash-card-trend is-${delta.tone}` });
  caption.createSpan({ cls: 'tm-dash-card-trend-value', text: `${formatDashboardCount(wow.current)} ${noun}` });
  caption.createSpan({ cls: 'tm-dash-card-trend-delta', text: delta.text });
  return true;
}

interface DashboardTaskListOptions {
  moreText?: string;
  moreAriaLabel?: string;
}

/**
 * True when a list is dominated by overdue rows (>= 80% of at least 3 visible rows). Used to calm the
 * otherwise-repeated red overdue chips: when everything is late, the colour is noise rather than a
 * signal, so we mute it and let the dates themselves do the talking.
 */
function dashboardListOverdueHeavy(tasks: ParsedTask[], today: string): boolean {
  if (tasks.length < 3) return false;
  let overdue = 0;
  for (const task of tasks) {
    const dateIso = dashboardTaskDate(task);
    if (dateIso && dashboardRelativeDate(dateIso, today).overdue) overdue += 1;
  }
  return overdue / tasks.length >= 0.8;
}

function renderDashTaskList(container: HTMLElement, tasks: ParsedTask[], context: WidgetRenderContext, limit: number, options: DashboardTaskListOptions = {}): void {
  const safeLimit = Math.max(0, limit);
  const list = container.createDiv('tm-dash-task-list');
  // When nearly every row in a list is overdue, the repeated red "Nd overdue" chips stop carrying
  // signal and just read as a wall of alarm. Flag the list so its overdue chips render in a calmer
  // tone (see styles.css); a lone overdue item in an otherwise-current list still pops.
  list.toggleClass('is-overdue-heavy', dashboardListOverdueHeavy(tasks.slice(0, safeLimit || tasks.length), context.today));
  for (const task of tasks.slice(0, safeLimit)) {
    renderDashTaskRow(list, task, context);
  }
  const hidden = tasks.length - safeLimit;
  renderDashMore(list, hidden, () => {
    for (const task of tasks.slice(safeLimit)) renderDashTaskRow(list, task, context);
  }, options.moreAriaLabel ?? `Show ${hidden} more task${hidden === 1 ? '' : 's'}`, options.moreText);
}

/**
 * Render the Backlog as per-note groups: a small header names each source note once, then its rows
 * follow without repeating the source backlink. Clustering by note replaces a wall of identical
 * "… — note name" breadcrumbs with a single readable heading. The overall row budget is shared across
 * groups, and revealing the overflow continues the same headers from where the preview stopped.
 */
function renderDashGroupedBacklog(container: HTMLElement, tasks: ParsedTask[], context: WidgetRenderContext, limit: number, options: DashboardTaskListOptions = {}): void {
  const safeLimit = Math.max(0, limit);
  const list = container.createDiv('tm-dash-task-list');
  const flat: Array<{ group: DashboardNoteGroup; task: ParsedTask }> = [];
  for (const group of dashboardGroupTasksByNote(tasks)) {
    for (const task of group.tasks) flat.push({ group, task });
  }
  let lastPath: string | null = null;
  const renderEntry = ({ group, task }: { group: DashboardNoteGroup; task: ParsedTask }): void => {
    if (task.filePath !== lastPath) {
      lastPath = task.filePath;
      const header = list.createDiv('tm-dash-group-label is-note');
      const open = (): void => { void context.openTask(task); };
      const name = header.createSpan({ cls: 'tm-dash-group-note', text: group.label });
      name.setAttr('role', 'button'); name.setAttr('tabindex', '0');
      name.setAttr('aria-label', `Open source note ${group.label}`);
      name.setAttr('title', group.filePath);
      name.addEventListener('click', open);
      name.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(); } });
      if (group.tasks.length > 1) header.createSpan({ cls: 'tm-dash-group-count', text: formatDashboardCount(group.tasks.length) });
    }
    renderDashTaskRow(list, task, context, { hideSource: true });
  };
  for (const entry of flat.slice(0, safeLimit)) renderEntry(entry);
  const hidden = flat.length - safeLimit;
  renderDashMore(list, hidden, () => {
    for (const entry of flat.slice(safeLimit)) renderEntry(entry);
  }, options.moreAriaLabel ?? `Show ${hidden} more task${hidden === 1 ? '' : 's'}`, options.moreText);
}

function renderDashNextUpHero(container: HTMLElement, task: ParsedTask, context: WidgetRenderContext): void {
  const hero = container.createDiv('tm-dash-next-up-hero');
  const eyebrow = hero.createDiv('tm-dash-next-up-eyebrow');
  setIcon(eyebrow.createSpan('tm-dash-next-up-eyebrow-icon'), 'sparkles');
  eyebrow.createSpan({ text: 'Recommended next action' });

  const main = hero.createDiv('tm-dash-next-up-main');
  const copy = main.createDiv('tm-dash-next-up-copy');
  const label = dashboardTaskDisplayText(task);
  const title = copy.createDiv({ cls: 'tm-dash-next-up-title', text: label });
  title.setAttr('role', 'button');
  title.setAttr('tabindex', '0');
  title.setAttr('title', label);
  const open = (): void => { void context.openTask(task); };
  title.addEventListener('click', open);
  title.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      open();
    }
  });

  const meta = copy.createDiv('tm-dash-next-up-meta');
  const project = dashboardRowProject(task);
  if (project) meta.createSpan({ cls: 'tm-dash-next-up-chip', text: project.label });
  const dateIso = dashboardTaskDate(task);
  if (dateIso) {
    const rel = dashboardRelativeDate(dateIso, context.today);
    meta.createSpan({ cls: `tm-dash-next-up-chip${rel.overdue ? ' is-overdue' : rel.soon ? ' is-soon' : ''}`, text: rel.label });
  }
  if (task.metadata.priority && task.metadata.priority !== 'normal') meta.createSpan({ cls: `tm-dash-next-up-chip is-p-${task.metadata.priority}`, text: `${task.metadata.priority} priority` });
  const source = task.filePath.split('/').pop()?.replace(/\.md$/u, '') ?? task.filePath;
  // Skip the source backlink when it duplicates the project chip (same-named note).
  if (source !== project?.label) {
    meta.createSpan({ cls: 'tm-dash-next-up-source', text: source }).setAttr('title', task.filePath);
  }

  const start = main.createEl('button', { cls: 'tm-dash-next-up-start mod-cta', text: 'Start' });
  start.setAttr('type', 'button');
  start.setAttr('aria-label', `Start ${label}`);
  start.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    open();
  });
}

/**
 * Render the Agenda widget with drag-to-reorder. The agenda normally sorts by date; once any visible
 * task carries a manual `[order:: N]` position the whole list switches to that hand-arranged order and
 * a “Date order” reset appears. Dropping a row persists a minimal set of order writes and refreshes.
 */
export function dashboardManualOrderTasks(tasks: readonly ParsedTask[]): ParsedTask[] {
  return tasks.filter(isManualOrderWritableTask);
}

function renderDashboardAgenda(container: HTMLElement, config: DashboardWidgetConfig, context: WidgetRenderContext): void {
  const agenda = sortTasksWithManualOrder(
    filterDashboardAgendaTasks(context.tasks, context.today, context.scope),
    compareDashboardAgendaRows(context.today),
  );
  context.setBadge(agenda.length ? String(agenda.length) : null);
  if (agenda.length === 0) {
    renderDashEmpty(container, 'check-circle', 'Nothing on the agenda — you’re all caught up.', 'Give a task a 📅 due or ⏳ scheduled date to plot it on the agenda.');
    return;
  }

  const reorderableAgenda = dashboardManualOrderTasks(agenda);
  const manual = hasManualOrder(reorderableAgenda);
  if (manual) {
    const bar = container.createDiv('tm-dash-manual-bar');
    const tag = bar.createSpan('tm-dash-manual-tag');
    setIcon(tag.createSpan('tm-dash-manual-tag-icon'), 'grip-vertical');
    tag.createSpan({ text: 'Manual order' });
    const reset = bar.createEl('button', { cls: 'tm-dash-manual-reset', text: 'Date order' });
    reset.setAttr('type', 'button');
    reset.setAttr('title', 'Clear the manual arrangement and sort by date again');
    reset.addEventListener('click', () => {
      void clearDashboardManualOrder(reorderableAgenda, context)
        .catch((error) => new Notice(`Task Manager: ${error instanceof Error ? error.message : String(error)}`));
    });
  }

  // Group headers (Overdue → Today → Upcoming) only make sense in date order — a hand-arranged agenda
  // is rendered flat so the manual sequence reads exactly as the user set it. Overdue is pinned at the
  // top here, which is why the dashboard no longer carries a separate Overdue card.
  const grouped = !manual;
  const counts = grouped ? dashboardAgendaBucketCounts(agenda, context.today) : null;
  let lastBucket: DashboardAgendaBucket | null = null;
  const limit = dashboardWidgetRowLimit(config, context.autoFit);
  const list = container.createDiv('tm-dash-task-list');
  const visible = agenda.slice(0, limit);
  list.toggleClass('is-overdue-heavy', dashboardListOverdueHeavy(visible, context.today));
  const emitHeader = (task: ParsedTask): void => {
    if (!grouped) return;
    const bucket = dashboardAgendaRowBucket(task, context.today);
    if (bucket === lastBucket) return;
    lastBucket = bucket;
    const header = list.createDiv({ cls: `tm-dash-group-label${bucket === 'overdue' ? ' is-overdue' : ''}` });
    header.createSpan({ text: dashboardAgendaBucketLabel(bucket, context.scope) });
    const count = counts?.[bucket] ?? 0;
    if (count > 0) header.createSpan({ cls: 'tm-dash-group-count', text: String(count) });
  };

  const rows: HTMLElement[] = [];
  const renderedTasks: ParsedTask[] = [];
  for (const task of visible) {
    emitHeader(task);
    const row = renderDashTaskRow(list, task, context);
    if (isManualOrderWritableTask(task)) {
      rows.push(decorateDraggableRow(row));
      renderedTasks.push(task);
    }
  }
  const renderedKeys = renderedTasks.map((task) => task.key);
  const hidden = agenda.length - limit;
  renderDashMore(list, hidden, () => {
    // Revealed overflow rows are not part of the wired drag set, so render them plain (no handle),
    // continuing the same group headers from where the visible rows left off.
    for (const task of agenda.slice(limit)) {
      emitHeader(task);
      renderDashTaskRow(list, task, context);
    }
  }, `Show ${hidden} more task${hidden === 1 ? '' : 's'}`);

  attachManualDrag(rows, (from, to) => {
    const movedKey = renderedKeys[from];
    const keysAfter = applyRowMove(renderedKeys, from, to);
    const orderByKey = new Map(reorderableAgenda.map((task) => [task.key, task.metadata.manualOrder] as const));
    const taskByKey = new Map(reorderableAgenda.map((task) => [task.key, task] as const));
    const writes = planManualReorder(keysAfter, movedKey, (key) => orderByKey.get(key));
    void applyManualOrderWrites(context.app, writes, taskByKey, context.taskMutations, context.scanner)
      .then(() => context.requestTaskRefresh())
      .catch((error) => new Notice(`Task Manager: ${error instanceof Error ? error.message : String(error)}`));
  });
}

function renderDashboardTodaySection(container: HTMLElement, label: string, count: number, modifier = '', collapsed = false): { section: HTMLElement; body: HTMLElement } {
  const section = container.createDiv({ cls: `tm-dash-today-section${modifier ? ` ${modifier}` : ''}` });
  const head = section.createDiv('tm-dash-today-section-head');
  head.createSpan({ cls: 'tm-dash-today-section-title', text: label });
  if (count > 0) head.createSpan({ cls: 'tm-dash-today-section-count', text: formatDashboardCount(count) });
  const body = section.createDiv('tm-dash-today-section-body');
  if (collapsed) {
    section.addClass('is-collapsed');
    const toggle = head.createEl('button', { cls: 'tm-dash-today-section-toggle', text: 'Show' });
    toggle.setAttr('type', 'button');
    toggle.setAttr('aria-expanded', 'false');
    toggle.addEventListener('click', () => {
      const open = section.hasClass('is-collapsed');
      section.toggleClass('is-collapsed', !open);
      toggle.setText(open ? 'Hide' : 'Show');
      toggle.setAttr('aria-expanded', open ? 'true' : 'false');
    });
  }
  return { section, body };
}

interface DashboardTodayRenderSection {
  label: string;
  tasks: ParsedTask[];
  modifier: string;
  moreText: string;
  moreAriaLabel: string;
  /** Preferred preview size before the section starts borrowing spare rows. */
  defaultLimit?: number;
  collapsed?: boolean;
  /** Render rows clustered under per-note group headers instead of a flat list. */
  grouped?: boolean;
}

function renderDashboardToday(container: HTMLElement, config: DashboardWidgetConfig, context: WidgetRenderContext): void {
  const model = dashboardTodayModel(context.tasks, context.today, context.scope);
  context.setBadge(model.badge);
  const sections: DashboardTodayRenderSection[] = [
    {
      label: 'Overdue',
      tasks: model.overdue,
      modifier: 'is-overdue',
      moreText: `Review all ${formatDashboardCount(model.overdue.length)} overdue`,
      moreAriaLabel: `Show all ${model.overdue.length} overdue tasks`,
    },
    {
      label: 'Blocked / waiting',
      tasks: model.blocked,
      modifier: 'is-blocked',
      moreText: `Review all ${formatDashboardCount(model.blocked.length)} blocked`,
      moreAriaLabel: `Show all ${model.blocked.length} blocked or waiting tasks`,
    },
    {
      label: 'Today',
      tasks: model.today,
      modifier: 'is-today',
      moreText: `Review all ${formatDashboardCount(model.today.length)} due today`,
      moreAriaLabel: `Show all ${model.today.length} tasks due today`,
    },
    {
      label: 'Tomorrow',
      tasks: model.tomorrow,
      modifier: 'is-tomorrow',
      moreText: `Review all ${formatDashboardCount(model.tomorrow.length)} due tomorrow`,
      moreAriaLabel: `Show all ${model.tomorrow.length} tasks due tomorrow`,
    },
    {
      label: 'Recently done',
      tasks: model.recentlyDone,
      modifier: 'is-recently-done',
      defaultLimit: 5,
      collapsed: true,
      moreText: `Review all ${formatDashboardCount(model.recentlyDone.length)} recently done`,
      moreAriaLabel: `Show all ${model.recentlyDone.length} recently completed tasks`,
    },
    {
      label: 'Backlog',
      tasks: model.backlog,
      modifier: 'is-backlog',
      defaultLimit: 10,
      grouped: true,
      moreText: `Review all ${formatDashboardCount(model.backlog.length)} backlog tasks`,
      moreAriaLabel: `Show all ${model.backlog.length} backlog tasks`,
    },
  ].filter((section) => section.tasks.length > 0);

  if (sections.length === 0) {
    renderDashEmpty(container, 'sun', 'Nothing needs attention today.', 'Capture a task, add a due date, or unblock waiting work to fill Today.');
    return;
  }

  let remainingRows = Math.max(4, dashboardWidgetRowLimit(config, context.autoFit));
  sections.forEach((entry, index) => {
    const laterOpenSections = sections.slice(index + 1).filter((section) => !section.collapsed).length;
    const reserveForLater = laterOpenSections;
    const sectionMax = entry.defaultLimit ?? entry.tasks.length;
    const available = index === sections.length - 1 ? remainingRows : remainingRows - reserveForLater;
    const limit = Math.max(1, Math.min(entry.tasks.length, sectionMax, available));
    if (!entry.collapsed) remainingRows = Math.max(0, remainingRows - Math.min(limit, entry.tasks.length));
    const { body } = renderDashboardTodaySection(container, entry.label, entry.tasks.length, entry.modifier, entry.collapsed);
    const render = entry.grouped ? renderDashGroupedBacklog : renderDashTaskList;
    render(body, entry.tasks, context, limit, {
      moreText: entry.moreText,
      moreAriaLabel: entry.moreAriaLabel,
    });
  });
}

function dashboardDailyTodosLimit(config: DashboardWidgetConfig): number {
  const raw = config.customConfig?.limit;
  const parsed = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) ? Math.max(0, Math.floor(parsed)) : 100;
}

function dashboardTaskStateLabel(task: ParsedTask, states: readonly TaskStateDefinition[]): string {
  const exact = states.find((state) => state.rawText === task.checkbox);
  const fallback = states.find((state) => state.type === task.status);
  return exact?.name ?? fallback?.name ?? task.status.replace(/_/gu, ' ');
}

function dashboardBooleanConfig(config: DashboardWidgetConfig, key: string, fallback: boolean): boolean {
  const value = config.customConfig?.[key];
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', 'yes', '1', 'on', 'show'].includes(normalized)) return true;
    if (['false', 'no', '0', 'off', 'hide'].includes(normalized)) return false;
  }
  return fallback;
}

function dashboardDailyTodosSource(task: ParsedTask): string {
  return task.filePath.split('/').pop()?.replace(/\.md$/u, '') ?? task.filePath;
}

interface DashboardDailyTodoDateMeta {
  label: string;
  tone: 'past' | 'today' | 'future' | 'closed';
}

function dashboardDailyTodoDateTone(date: string, today: string): DashboardDailyTodoDateMeta['tone'] {
  if (date < today) return 'past';
  if (date === today) return 'today';
  return 'future';
}

function dashboardDailyTodoDateMeta(task: ParsedTask, day: string, today: string): DashboardDailyTodoDateMeta | undefined {
  const dates = task.metadata?.dates ?? {};
  if (task.status === 'done' && dates.done === day) return { label: 'completed', tone: 'closed' };
  if (task.status === 'cancelled' && dates.cancelled === day) return { label: 'cancelled', tone: 'closed' };
  const due = dates.due && dates.due <= day ? dates.due : undefined;
  const scheduled = dates.scheduled && dates.scheduled <= day ? dates.scheduled : undefined;
  const field = due && (!scheduled || due <= scheduled) ? 'due' : scheduled ? 'scheduled' : undefined;
  const date = field === 'due' ? due : scheduled;
  if (!date) return undefined;
  const rel = dashboardRelativeDate(date, today);
  return { label: `${field} ${rel.label.toLowerCase()}`, tone: dashboardDailyTodoDateTone(date, today) };
}

type DashboardDailyTodoVisualState = 'todo' | 'in_progress' | 'done' | 'blocked' | 'waiting' | 'deferred' | 'cancelled' | 'untracked';

function dashboardDailyTodoVisualState(task: ParsedTask): DashboardDailyTodoVisualState {
  const marker = task.checkbox.trim();
  if (task.status === 'done' || marker === 'x' || marker === 'X') return 'done';
  if (task.status === 'cancelled' || marker === '-') return 'cancelled';
  if (task.status === 'in_progress' || marker === '/') return 'in_progress';
  if (marker === '?') return 'waiting';
  if (task.status === 'blocked' || marker === '!') return 'blocked';
  if (task.status === 'deferred' || marker === '>') return 'deferred';
  if (task.status === 'untracked') return 'untracked';
  return 'todo';
}

function dashboardDailyTodoCheckboxText(task: ParsedTask): string {
  switch (dashboardDailyTodoVisualState(task)) {
    case 'done': return '✅';
    case 'cancelled': return '❌';
    case 'in_progress': return '▶️';
    case 'waiting': return '⏳';
    case 'blocked': return '⛔';
    case 'deferred': return '↪️';
    default: return '';
  }
}

function dashboardDailyTodoDisplayText(task: ParsedTask): string {
  const source = task.normalizedText || task.body || dashboardTaskDisplayText(task);
  const cleaned = normalizeTaskText(stripDashboardInlineMarkdown(stripInlineTags(source))
    .replace(/\s+\[[^\]]+::[^\]]+\]/gu, ' ')
    .replace(/\s+🔁\s+[^📅⏳🛫✅❌➕⏰🔺⏫🔼🔽⏬🆔⛔👤👁📋👥#\[]+/gu, ' ')
    .replace(/\s+[📅⏳🛫✅❌➕]\s*\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?/gu, ' ')
    .replace(/\s+⏰\s*\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?/gu, ' ')
    .replace(/\s+(?:🔺|⏫|🔼|🔽|⏬)(?=\s|$)/gu, ' ')
    .replace(/\s+(?:🆔|⛔)\s+\S+/gu, ' ')
    .replace(/\s+(?:👤|👁️?|📋|👥)\s+[^📅⏳🛫✅❌➕⏰🔁🔺⏫🔼🔽⏬🆔⛔#\[]*/gu, ' ')
    .replace(/\s+@\s*$/gu, ' '));
  return cleaned || dashboardTaskDisplayText(task);
}

function renderDashboardDailyTodoMetaItem(meta: HTMLElement, text: string, cls = ''): HTMLElement {
  const item = meta.createSpan({ cls: `tm-daily-todo-meta-item${cls ? ` ${cls}` : ''}`, text });
  item.setAttr('aria-label', text);
  return item;
}

function renderDashboardDailyTodoMeta(meta: HTMLElement, task: ParsedTask, context: WidgetRenderContext, config: DashboardWidgetConfig, day: string, today: string): boolean {
  meta.empty();
  let hasMeta = false;
  if (dashboardBooleanConfig(config, 'showDate', true)) {
    const dateMeta = dashboardDailyTodoDateMeta(task, day, today);
    if (dateMeta) {
      renderDashboardDailyTodoMetaItem(meta, dateMeta.label, `tm-daily-todo-date is-${dateMeta.tone}`);
      hasMeta = true;
    }
  }
  if (dashboardBooleanConfig(config, 'showSource', true)) {
    const source = renderDashboardDailyTodoMetaItem(meta, dashboardDailyTodosSource(task), 'tm-daily-todo-source');
    source.setAttr('role', 'button');
    source.setAttr('tabindex', '0');
    source.setAttr('title', `Open ${task.filePath}`);
    const open = (): void => { void context.openTask(task); };
    source.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      open();
    });
    source.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        open();
      }
    });
    hasMeta = true;
  }
  if (dashboardBooleanConfig(config, 'showTags', false)) {
    for (const tag of task.tags.slice(0, 3)) {
      renderDashboardDailyTodoMetaItem(meta, `#${tag}`, 'tm-daily-todo-tag');
      hasMeta = true;
    }
  }
  return hasMeta;
}

function applyDashboardDailyTodoCheckboxState(row: HTMLElement, checkbox: HTMLElement, task: ParsedTask, states: readonly TaskStateDefinition[]): void {
  row.classList.remove('tm-daily-todo--todo', 'tm-daily-todo--in_progress', 'tm-daily-todo--blocked', 'tm-daily-todo--waiting', 'tm-daily-todo--deferred', 'tm-daily-todo--done', 'tm-daily-todo--cancelled', 'tm-daily-todo--untracked', 'is-updating');
  const visualState = dashboardDailyTodoVisualState(task);
  row.addClass(`tm-daily-todo--${visualState}`);
  checkbox.className = `tm-daily-todo-check tm-daily-todo-check--${visualState}`;
  checkbox.setText(dashboardDailyTodoCheckboxText(task));
  checkbox.setAttr('aria-checked', task.status === 'done' ? 'true' : 'false');
  checkbox.setAttr('aria-label', `${dashboardTaskStateLabel(task, states)} — advance task status`);
}

async function toggleDashboardDailyTodo(row: HTMLElement, checkbox: HTMLElement, meta: HTMLElement | null, task: ParsedTask, context: WidgetRenderContext, config: DashboardWidgetConfig, day: string, today: string): Promise<ParsedTask | null> {
  const file = context.app.vault.getAbstractFileByPath(task.filePath);
  if (!(file instanceof TFile)) {
    new Notice('Task Manager: source file not found.');
    return null;
  }
  row.addClass('is-updating');
  try {
    const updated = await updateDashboardTaskCheckbox(file, task, cycleTaskCheckbox(task.checkbox, context.settings.supportedStates), context);
    applyDashboardDailyTodoCheckboxState(row, checkbox, updated, context.settings.supportedStates);
    if (meta) {
      const hasMeta = renderDashboardDailyTodoMeta(meta, updated, context, config, day, today);
      if (!hasMeta) meta.remove();
    }
    return updated;
  } catch (error) {
    row.removeClass('is-updating');
    console.warn('Task Manager: dashboard daily todo update failed', error);
    new Notice(`Task Manager: could not update task — ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

type DashboardDailyBulkAction = 'done' | 'todo' | 'cancelled' | 'defer' | 'delete';

interface DashboardDailyBulkContext {
  selected: Set<string>;
  tasks: Map<string, ParsedTask>;
  rowKeys: string[];
  rows: Map<string, HTMLElement>;
  lastSelectedKey: string | null;
  resortTimer: number | null;
  updateBar: () => void;
  focusDeleteResult: () => void;
  resortRows: () => void;
}

function dashboardDailyBulkKey(task: ParsedTask): string {
  return `${task.filePath}:${task.lineNumber}:${task.key}`;
}

function renderDashboardDailyBulkBar(container: HTMLElement, context: WidgetRenderContext, bulk: DashboardDailyBulkContext): void {
  const bar = container.createDiv('tm-daily-todo-bulkbar');
  const count = bar.createSpan({ cls: 'tm-daily-todo-bulkbar-count', text: '0 selected' });
  const transactionStatus = bar.createSpan('tm-daily-todo-delete-status');
  transactionStatus.setAttr('role', 'status');
  transactionStatus.setAttr('aria-live', 'polite');
  transactionStatus.tabIndex = -1;
  const undo = bar.createEl('button', { text: t('dashboard.delete.undo'), type: 'button', cls: 'tm-daily-todo-undo' });
  const retryRecovery = bar.createEl('button', { text: t('dashboard.delete.retryRecovery'), type: 'button', cls: 'mod-warning tm-daily-todo-recovery' });
  const session = context.dailyDeleteSession ?? (context.dailyDeleteSession = new DashboardDailyDeleteSession(context.app));
  bulk.focusDeleteResult = () => {
    const currentUndo = container.querySelector<HTMLButtonElement>('.tm-daily-todo-undo');
    const currentStatus = container.querySelector<HTMLElement>('.tm-daily-todo-delete-status');
    const focusTarget = currentUndo && !currentUndo.hidden && !currentUndo.disabled
      ? currentUndo
      : currentStatus;
    focusTarget?.focus();
  };
  bulk.updateBar = () => {
    const selectedCount = bulk.selected.size;
    const transaction = session?.undoable;
    const recovery = session?.recovery;
    bar.toggleClass('is-visible', selectedCount > 0 || Boolean(transaction) || Boolean(recovery));
    count.setText(`${selectedCount} selected`);
    count.toggleAttribute('hidden', selectedCount === 0);
    undo.toggleAttribute('hidden', !transaction || Boolean(recovery));
    undo.disabled = Boolean(session?.isBusy);
    retryRecovery.toggleAttribute('hidden', !recovery);
    retryRecovery.disabled = Boolean(session?.isBusy);
    transactionStatus.setText(recovery
      ? `Recovery required for ${recovery.paths.join(', ')}. No successful deletion was reported.`
      : transaction
        ? `Deleted ${transaction.selectedCount} task${transaction.selectedCount === 1 ? '' : 's'} and ${transaction.descendantLineCount} descendant line${transaction.descendantLineCount === 1 ? '' : 's'}.`
        : '');
  };
  undo.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!session || session.isBusy) return;
    undo.disabled = true;
    void session.undo().then((transaction) => {
      for (const file of transaction.files) context.queryRenderer?.invalidateCache(file.path);
      transactionStatus.setText(`Restored ${transaction.selectedCount} task${transaction.selectedCount === 1 ? '' : 's'} and ${transaction.descendantLineCount} descendant line${transaction.descendantLineCount === 1 ? '' : 's'}.`);
      context.requestTaskRefresh();
      window.setTimeout(() => {
        const firstKey = transaction.selectedTaskKeys[0];
        const restoredRow = firstKey ? Array.from(document.querySelectorAll<HTMLElement>('.tm-daily-todo')).find((row) => row.dataset.taskKey === firstKey) : null;
        (restoredRow ?? transactionStatus).focus();
      }, 0);
      bulk.updateBar();
    }).catch((error: unknown) => {
      transactionStatus.setText(`Undo failed: ${error instanceof Error ? error.message : String(error)}`);
      transactionStatus.focus();
      bulk.updateBar();
    });
  });
  retryRecovery.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (!session || session.isBusy) return;
    void session.retryRecovery().then(() => {
      transactionStatus.setText(t('dashboard.delete.recoveryCompleted'));
      context.requestTaskRefresh();
      bulk.updateBar();
    }).catch((error: unknown) => {
      transactionStatus.setText(`Recovery failed: ${error instanceof Error ? error.message : String(error)}`);
      transactionStatus.focus();
      bulk.updateBar();
    });
  });
  const addAction = (label: string, action: DashboardDailyBulkAction): void => {
    const button = bar.createEl('button', { text: label });
    button.setAttr('type', 'button');
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      void applyDashboardDailyBulkAction(action, context, bulk, button);
    });
  };
  addAction('Done', 'done');
  addAction('Todo', 'todo');
  addAction('Cancel', 'cancelled');
  addAction('Defer +1d', 'defer');
  addAction('Delete', 'delete');
  const clear = bar.createEl('button', { text: 'Clear' });
  clear.setAttr('type', 'button');
  clear.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    bulk.selected.clear();
    bulk.lastSelectedKey = null;
    updateDashboardDailySelectionClasses(bulk);
    bulk.updateBar();
  });
  bulk.updateBar();
}

function selectDashboardDailyRow(bulk: DashboardDailyBulkContext, key: string, event: Pick<MouseEvent | KeyboardEvent, 'shiftKey' | 'metaKey' | 'ctrlKey'>): void {
  const toggleOnly = event.metaKey || event.ctrlKey;
  if (event.shiftKey && bulk.lastSelectedKey && bulk.rowKeys.includes(bulk.lastSelectedKey)) {
    const start = bulk.rowKeys.indexOf(bulk.lastSelectedKey);
    const end = bulk.rowKeys.indexOf(key);
    if (end >= 0) {
      if (!toggleOnly) bulk.selected.clear();
      const [from, to] = start <= end ? [start, end] : [end, start];
      for (const rangeKey of bulk.rowKeys.slice(from, to + 1)) bulk.selected.add(rangeKey);
    }
  } else if (toggleOnly) {
    if (bulk.selected.has(key)) bulk.selected.delete(key);
    else bulk.selected.add(key);
    bulk.lastSelectedKey = key;
  } else {
    bulk.selected.clear();
    bulk.selected.add(key);
    bulk.lastSelectedKey = key;
  }
  updateDashboardDailySelectionClasses(bulk);
  bulk.updateBar();
}

function updateDashboardDailySelectionClasses(bulk: DashboardDailyBulkContext): void {
  for (const [key, row] of bulk.rows) {
    const selected = bulk.selected.has(key);
    row.toggleClass('is-selected', selected);
    row.setAttr('aria-selected', selected ? 'true' : 'false');
    row.querySelector<HTMLElement>('.tm-daily-todo-select')?.setAttr('aria-pressed', selected ? 'true' : 'false');
  }
}

function openDashboardDailyBulkMenu(event: MouseEvent | null, key: string, context: WidgetRenderContext, bulk: DashboardDailyBulkContext, position?: { x: number; y: number }): void {
  event?.preventDefault();
  event?.stopPropagation();
  if (!bulk.selected.has(key)) {
    bulk.selected.clear();
    bulk.selected.add(key);
    bulk.lastSelectedKey = key;
    updateDashboardDailySelectionClasses(bulk);
    bulk.updateBar();
  }

  const count = bulk.selected.size || 1;
  const menu = new Menu();
  menu.addItem((item) => item.setTitle(`${count} selected`).setDisabled(true));
  menu.addSeparator();
  const invokingRow = bulk.rows.get(key) ?? null;
  const addAction = (label: string, action: DashboardDailyBulkAction): void => {
    menu.addItem((item) => item
      .setTitle(label)
      .onClick(() => { void applyDashboardDailyBulkAction(action, context, bulk, invokingRow); }));
  };
  addAction('Mark done', 'done');
  addAction('Mark todo', 'todo');
  addAction('Cancel', 'cancelled');
  addAction('Defer +1 day', 'defer');
  menu.addSeparator();
  addAction('Delete', 'delete');
  menu.addSeparator();
  menu.addItem((item) => item
    .setTitle('Clear selection')
    .onClick(() => {
      bulk.selected.clear();
      bulk.lastSelectedKey = null;
      updateDashboardDailySelectionClasses(bulk);
      bulk.updateBar();
    }));
  if (event) menu.showAtMouseEvent(event);
  else if (position) menu.showAtPosition(position);
}

function sortDashboardDailyRowsInPlace(bulk: DashboardDailyBulkContext, list: HTMLElement, date: string): void {
  if (!list.isConnected) return;
  const compare = compareDashboardDailyTodosTasks(date);
  const visibleKeys = bulk.rowKeys.filter((key) => bulk.rows.get(key)?.parentElement === list);
  visibleKeys.sort((leftKey, rightKey) => {
    const left = bulk.tasks.get(leftKey);
    const right = bulk.tasks.get(rightKey);
    if (!left || !right) return 0;
    return compare(left, right);
  });
  const more = list.querySelector<HTMLElement>(':scope > .tm-dash-more');
  for (const key of visibleKeys) {
    const row = bulk.rows.get(key);
    if (row) list.appendChild(row);
  }
  if (more) list.appendChild(more);
}

async function applyDashboardDailyBulkAction(action: DashboardDailyBulkAction, context: WidgetRenderContext, bulk: DashboardDailyBulkContext, invokingElement: HTMLElement | null = null): Promise<void> {
  const tasks = [...bulk.selected]
    .map((key) => bulk.tasks.get(key))
    .filter((task): task is ParsedTask => Boolean(task))
    .sort((a, b) => action === 'delete'
      ? a.filePath.localeCompare(b.filePath) || b.lineNumber - a.lineNumber
      : 0);
  if (tasks.length === 0) return;
  if (action === 'delete') {
    try {
      const plan = await planDashboardDailyDelete(context.app, context.scanner, tasks);
      const session = context.dailyDeleteSession ?? (context.dailyDeleteSession = new DashboardDailyDeleteSession(context.app));
      new DashboardDailyBulkDeleteConfirmModal(context.app, plan, invokingElement, async () => {
        try {
          await session.commit(plan);
        } catch (error) {
          bulk.updateBar();
          throw error;
        }
        for (const file of plan.files) context.queryRenderer?.invalidateCache(file.path);
        bulk.selected.clear();
        bulk.lastSelectedKey = null;
        updateDashboardDailySelectionClasses(bulk);
        bulk.updateBar();
        context.requestTaskRefresh();
        if (context.settings.showActionNotifications) new Notice(`Deleted ${plan.selectedCount} task${plan.selectedCount === 1 ? '' : 's'}. Undo is available in the daily tasks bar.`);
      }, () => bulk.focusDeleteResult()).open();
    } catch (error) {
      showDashboardDeletePlanningError(error);
    }
    return;
  }
  let updated = 0;
  let failed = 0;
  for (const task of tasks) {
    try {
      const file = context.app.vault.getAbstractFileByPath(task.filePath);
      if (!(file instanceof TFile)) throw new Error(`Source file not found: ${task.filePath}`);
      if (action === 'defer') {
        await deferDashboardDailyTask(file, task, context);
      } else {
        const checkbox = checkboxForStatus(action, context.settings.supportedStates);
        const changedTask = await updateDashboardTaskCheckbox(file, task, checkbox, context);
        const row = bulk.rows.get(dashboardDailyBulkKey(task));
        const statusIcon = row?.querySelector<HTMLElement>('.tm-daily-todo-check');
        if (row && statusIcon) applyDashboardDailyTodoCheckboxState(row, statusIcon, changedTask, context.settings.supportedStates);
        bulk.tasks.set(dashboardDailyBulkKey(task), changedTask);
      }
      context.queryRenderer?.invalidateCache(task.filePath);
      updated += 1;
    } catch (error) {
      failed += 1;
      console.warn('Task Manager: dashboard daily bulk action failed', action, task, error);
    }
  }
  bulk.selected.clear();
  bulk.lastSelectedKey = null;
  updateDashboardDailySelectionClasses(bulk);
  if (isDashboardDailyStatusBulkAction(action)) scheduleDashboardDailyResort(bulk);
  else context.requestTaskRefresh();
  if (updated > 0 && context.settings.showActionNotifications) new Notice(`${bulkDailyActionPastTense(action)} ${updated} task${updated === 1 ? '' : 's'}`);
  if (failed > 0) new Notice(`Failed to update ${failed} task${failed === 1 ? '' : 's'}`);
}

function isDashboardDailyStatusBulkAction(action: DashboardDailyBulkAction): action is 'done' | 'todo' | 'cancelled' {
  return action === 'done' || action === 'todo' || action === 'cancelled';
}

function bulkDailyActionPastTense(action: DashboardDailyBulkAction): string {
  switch (action) {
    case 'done': return 'Completed';
    case 'todo': return 'Reopened';
    case 'cancelled': return 'Cancelled';
    case 'defer': return 'Deferred';
    case 'delete': return 'Deleted';
  }
}

async function deferDashboardDailyTask(file: TFile, task: ParsedTask, context: WidgetRenderContext): Promise<void> {
  const dates = task.metadata.dates;
  const field = dates.due ? 'due' : dates.scheduled ? 'scheduled' : dates.start ? 'start' : 'due';
  const base = dates[field] ?? context.today;
  await updateDashboardTaskDate(file, task, field, addDays(base > context.today ? base : context.today, 1), context);
}

function renderDashboardDailyTodoRow(container: HTMLElement, task: ParsedTask, context: WidgetRenderContext, config: DashboardWidgetConfig, day: string, today: string, bulk?: DashboardDailyBulkContext): HTMLElement {
  let currentTask = task;
  const key = dashboardDailyBulkKey(task);
  const visualState = dashboardDailyTodoVisualState(task);
  const row = container.createEl('li', { cls: `tm-daily-todo tm-daily-todo--${visualState}` });
  if (bulk) {
    row.dataset.taskKey = key;
    bulk.tasks.set(key, task);
    bulk.rows.set(key, row);
    bulk.rowKeys.push(key);
    row.setAttr('aria-selected', bulk.selected.has(key) ? 'true' : 'false');
    row.toggleClass('is-selected', bulk.selected.has(key));
    row.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      selectDashboardDailyRow(bulk, key, event);
    });
    row.addEventListener('contextmenu', (event) => openDashboardDailyBulkMenu(event, key, context, bulk));
    if (context.settings.enableMobileGestures) {
      setupSwipeHandler(row, (direction) => {
        if (direction !== 'left') return;
        const rect = row.getBoundingClientRect();
        openDashboardDailyBulkMenu(null, key, context, bulk, { x: rect.right - 8, y: rect.top + 8 });
      });
    }
  }

  if (bulk) {
    const select = row.createEl('button', { cls: 'tm-daily-todo-select task-manager-sr-only', attr: { type: 'button', 'aria-label': `Select ${task.normalizedText}`, 'aria-pressed': bulk.selected.has(key) ? 'true' : 'false' } });
    select.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      selectDashboardDailyRow(bulk, key, event);
    });
  }
  const checkbox = row.createSpan({ cls: `tm-daily-todo-check tm-daily-todo-check--${visualState}`, text: dashboardDailyTodoCheckboxText(task) });
  checkbox.setAttr('role', 'checkbox');
  checkbox.setAttr('tabindex', '0');
  checkbox.setAttr('aria-checked', task.status === 'done' ? 'true' : 'false');
  checkbox.setAttr('aria-label', `${dashboardTaskStateLabel(task, context.settings.supportedStates)} — advance task status`);

  const content = row.createDiv('tm-daily-todo-content');
  content.createSpan({ cls: 'tm-daily-todo-title', text: dashboardDailyTodoDisplayText(task) });
  const meta = content.createDiv('tm-daily-todo-meta');
  const hasMeta = renderDashboardDailyTodoMeta(meta, task, context, config, day, today);
  if (!hasMeta) meta.remove();

  const toggle = (): void => {
    void toggleDashboardDailyTodo(row, checkbox, meta.isConnected ? meta : null, currentTask, context, config, day, today)
      .then((updated) => {
        if (!updated) return;
        currentTask = updated;
        if (bulk) {
          bulk.tasks.set(key, updated);
          scheduleDashboardDailyResort(bulk);
        }
      });
  };
  checkbox.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    toggle();
  });
  checkbox.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      toggle();
    }
  });

  return row;
}

function renderDashboardDailyTodos(container: HTMLElement, config: DashboardWidgetConfig, context: WidgetRenderContext): void {
  const date = dashboardDailyTodosDate(config, context);
  if (!date) {
    renderDashEmpty(container, 'calendar-x', 'Daily tasks need a date.', 'Add a date property to the note frontmatter or set date: YYYY-MM-DD in the widget block.');
    return;
  }
  const model = dashboardDailyTodosModel(context.tasks, date);
  context.setBadge(model.badge);
  container.addClass('tm-dash-daily-todos');
  if (dashboardBooleanConfig(config, 'showSummary', false)) {
    const summary = container.createDiv('tm-dash-daily-todos-summary');
    summary.createSpan({ cls: 'tm-dash-daily-todos-date', text: dashboardShortDate(date) });
    const parts: string[] = [];
    if (model.carryForward.length) parts.push(`${formatDashboardCount(model.carryForward.length)} due/scheduled`);
    if (model.completed.length) parts.push(`${formatDashboardCount(model.completed.length)} completed`);
    if (model.cancelled.length) parts.push(`${formatDashboardCount(model.cancelled.length)} cancelled`);
    summary.createSpan({ cls: 'tm-dash-daily-todos-summary-text', text: parts.join(' · ') || 'No matching tasks' });
  }

  const today = context.today;
  const tasks = [...model.carryForward, ...model.completed, ...model.cancelled].sort(compareDashboardDailyTodosTasks(date));
  const bulk: DashboardDailyBulkContext = {
    selected: new Set<string>(),
    tasks: new Map<string, ParsedTask>(),
    rowKeys: [],
    rows: new Map<string, HTMLElement>(),
    lastSelectedKey: null,
    resortTimer: null,
    updateBar: () => undefined,
    focusDeleteResult: () => undefined,
    resortRows: () => undefined,
  };
  renderDashboardDailyBulkBar(container, context, bulk);
  if (tasks.length === 0) {
    renderDashEmpty(container, 'calendar-check', `No tasks for ${dashboardShortDate(date)}.`, 'Due or schedule a task on this day, or complete/cancel a task on this day, to show it here.');
    return;
  }
  const list = container.createEl('ul', { cls: 'tm-daily-todo-list' });
  bulk.resortRows = () => sortDashboardDailyRowsInPlace(bulk, list, date);
  const limit = dashboardDailyTodosLimit(config);
  const safeLimit = Math.max(0, limit);
  for (const task of tasks.slice(0, safeLimit)) renderDashboardDailyTodoRow(list, task, context, config, date, today, bulk);
  const hidden = tasks.length - safeLimit;
  renderDashMore(list, hidden, () => {
    for (const task of tasks.slice(safeLimit)) renderDashboardDailyTodoRow(list, task, context, config, date, today, bulk);
  }, `Show ${hidden} more daily task${hidden === 1 ? '' : 's'}`);
}

function decorateDraggableRow(row: HTMLElement): HTMLElement {
  row.addClass('tm-dash-task--draggable');
  const handle = row.createDiv({ cls: 'tm-dash-drag-handle' });
  setIcon(handle, 'grip-vertical');
  handle.setAttr('aria-hidden', 'true');
  row.prepend(handle);
  return row;
}

/** Remove the `[order:: N]` field from every currently-arranged task, reverting to the natural sort. */
async function clearDashboardManualOrder(tasks: readonly ParsedTask[], context: WidgetRenderContext): Promise<void> {
  const taskByKey = new Map(tasks.map((task) => [task.key, task] as const));
  const writes = tasks
    .filter((task) => task.metadata.manualOrder !== undefined)
    .map((task) => ({ key: task.key, order: null }));
  await applyManualOrderWrites(context.app, writes, taskByKey, context.taskMutations, context.scanner);
  context.requestTaskRefresh();
}

/**
 * Append the shared clickable “+N more” affordance to a list. Activating it reveals the hidden rows
 * inline (via `renderRest`) instead of forcing the card to resize — the same control, label style and
 * behaviour every dashboard list uses, so they all match. No-op when nothing is hidden.
 */
function renderDashMore(list: HTMLElement, hiddenCount: number, renderRest: () => void, ariaLabel?: string, buttonText?: string): void {
  if (hiddenCount <= 0) return;
  const more = list.createEl('button', { cls: 'tm-dash-more', text: buttonText ?? `+${formatDashboardCount(hiddenCount)} more` });
  more.setAttr('type', 'button');
  more.setAttr('aria-label', ariaLabel ?? `Show ${hiddenCount} more`);
  more.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    more.remove();
    renderRest();
  });
}

function dashboardDateAdd(date: string, days: number): string {
  return addDays(date, days);
}

function dashboardDateOlderThan(dateIso: string | undefined, today: string, days: number): boolean {
  return Boolean(dateIso && dashboardDayDiff(dateIso, today) >= days);
}

function isDashboardBlockedTask(task: ParsedTask): boolean {
  return task.status === 'blocked' || task.status === 'deferred' || task.metadata.dependsOn.length > 0 || Boolean(task.metadata.followUp && task.metadata.followUp > todayString());
}

export function dashboardProjectName(task: ParsedTask): string {
  if (task.metadata.project?.trim()) return task.metadata.project.trim();
  // Purely-numeric tags (e.g. #2 / #3 used as ordering or step markers) are never meaningful
  // project names; treating them as projects fragments a single note into many one-task "projects"
  // (the broken "Next actions" numbering). Prefer the first descriptive tag, then the section
  // heading, then the note name, before falling back to the containing folder.
  const namedTag = task.tags.find((tag) => !/^\d+$/u.test(tag));
  if (namedTag) return `#${namedTag}`;
  if (task.heading?.trim()) return task.heading.trim();
  const fileName = task.filePath.split('/').pop()?.replace(/\.md$/u, '').trim();
  if (fileName) return fileName;
  const folder = task.filePath.includes('/') ? task.filePath.split('/').slice(0, -1).join('/') : '';
  return folder || 'No project';
}

/**
 * Project label for a row chip — only when it comes from an explicit project field, a descriptive
 * tag, or a section heading. The note-name / folder fallbacks are deliberately omitted because the
 * row already shows a source-note backlink, so a chip there would just duplicate it. When the label
 * is tag-derived we also return the bare tag so the caller can suppress the duplicate #tag chip.
 */
export function dashboardRowProject(task: ParsedTask): { label: string; tag?: string } | undefined {
  const explicit = task.metadata.project?.trim();
  if (explicit) return { label: explicit };
  const namedTag = task.tags.find((tag) => !/^\d+$/u.test(tag));
  if (namedTag) return { label: `#${namedTag}`, tag: namedTag };
  const heading = task.heading?.trim();
  if (heading) return { label: heading };
  return undefined;
}

export interface DashboardRelationshipIndex {
  /** Active tasks that depend on a given task id (i.e. the tasks it unblocks when completed). */
  dependents: Map<string, ParsedTask[]>;
  /** Unique-only task lookup by 🆔 id. Ambiguous IDs are intentionally absent. */
  byId: Map<string, ParsedTask>;
  /** IDs that have multiple current tasks and therefore cannot form safe edges. */
  ambiguousIds: ReadonlySet<string>;
}

// Memoised per shared task-set: every row in one refresh sees the same `context.tasks` array
// reference, so a WeakMap keyed by it builds the id graph once and auto-evicts after the refresh.
const dashboardRelationshipCache = new WeakMap<ParsedTask[], DashboardRelationshipIndex>();

export function dashboardUniqueTaskKeyMap(tasks: ParsedTask[]): Map<string, ParsedTask> {
  const explicitIds = new ExplicitIdIndex(tasks);
  const byKey = new Map<string, ParsedTask>();
  for (const task of tasks) {
    const id = task.metadata.id?.trim();
    if (id && explicitIds.unique(id) !== task) continue;
    byKey.set(task.key, task);
    if (task.stableKey) byKey.set(task.stableKey, task);
  }
  return byKey;
}

export function dashboardRelationshipIndex(tasks: ParsedTask[]): DashboardRelationshipIndex {
  const cached = dashboardRelationshipCache.get(tasks);
  if (cached) return cached;
  const explicitIds = new ExplicitIdIndex(tasks);
  const byId = new Map<string, ParsedTask>();
  for (const id of explicitIds.ids()) {
    const task = explicitIds.unique(id);
    if (task) byId.set(id, task);
  }
  const ambiguousIds = new Set(explicitIds.conflicts().keys());
  const dependents = new Map<string, ParsedTask[]>();
  for (const task of tasks) {
    if (task.status === 'done' || task.status === 'cancelled') continue;
    for (const dep of task.metadata.dependsOn) {
      const id = dep.trim();
      if (!id || !byId.has(id)) continue;
      const list = dependents.get(id);
      if (list) list.push(task); else dependents.set(id, [task]);
    }
  }
  const index: DashboardRelationshipIndex = { dependents, byId, ambiguousIds };
  dashboardRelationshipCache.set(tasks, index);
  return index;
}

/** Resolve a task's relationships: which active tasks it unblocks, and which tasks it waits on. */
export function dashboardTaskRelations(task: ParsedTask, index: DashboardRelationshipIndex): { unblocks: ParsedTask[]; waitingOn: ParsedTask[] } {
  const id = task.metadata.id?.trim();
  const unblocks = id ? (index.dependents.get(id) ?? []) : [];
  const waitingOn: ParsedTask[] = [];
  for (const dep of task.metadata.dependsOn) {
    const blocker = index.byId.get(dep.trim());
    if (blocker) waitingOn.push(blocker);
  }
  return { unblocks, waitingOn };
}

function dashboardTaskAgeDate(task: ParsedTask): string | undefined {
  return task.metadata.dates.created ?? task.metadata.dates.start ?? task.metadata.dates.scheduled ?? task.metadata.dates.due;
}

function dashboardEffortMinutes(task: ParsedTask): number {
  const minutes = parseEffortMinutesForFilter(task.metadata.effort);
  return Number.isFinite(minutes) ? minutes : 0;
}

function dashboardTaskIsInbox(task: ParsedTask): boolean {
  const active = task.status !== 'done' && task.status !== 'cancelled' && task.status !== 'untracked';
  if (!active) return false;
  const dates = task.metadata.dates;
  return !dates.due && !dates.scheduled && !dates.start && !task.metadata.project && (task.tags?.length ?? 0) === 0 && (task.contexts?.length ?? 0) === 0 && task.metadata.priority === 'normal';
}

function dashboardFocusTasks(tasks: ParsedTask[], today: string): ParsedTask[] {
  return filterDashboardActiveTasks(tasks)
    .filter((task) => !isDashboardBlockedTask(task))
    .sort(compareFocusTasks(today));
}

function filterDashboardNeedsSchedulingTasks(tasks: ParsedTask[], today: string): ParsedTask[] {
  return filterDashboardActiveTasks(tasks)
    .filter((task) => {
      const dates = task.metadata.dates;
      const hasDate = Boolean(dates.due || dates.scheduled || dates.start);
      return !hasDate && !isDashboardBlockedTask(task) && !dashboardTaskIsInbox(task) && !dashboardTaskIsSomeday(task, today);
    })
    .sort(compareFocusTasks(today));
}

export interface DashboardNextUpModel {
  hero: ParsedTask | null;
  backlog: ParsedTask[];
  shortlist: ParsedTask[];
  badge: string | null;
}

export function dashboardNextUpModel(tasks: ParsedTask[], today: string, scope: DashboardScope): DashboardNextUpModel {
  const focus = dashboardFocusTasks(tasks, today);
  const hero = focus[0] ?? null;
  if (!hero) return { hero: null, backlog: [], shortlist: [], badge: null };
  const agendaKeys = new Set(filterDashboardAgendaTasks(tasks, today, scope).map((task) => task.key));
  const backlog = focus.filter((task) => !agendaKeys.has(task.key));
  const shortlist = backlog.filter((task) => task.key !== hero.key);
  return { hero, backlog, shortlist, badge: backlog.length ? String(backlog.length) : null };
}

export interface DashboardTodayModel {
  /** Active dated work before today; shown first and visually highlighted. */
  overdue: ParsedTask[];
  /** Blocked/waiting work that is not already represented by the overdue section. */
  blocked: ParsedTask[];
  /** Active dated work due/scheduled today, sorted by due date/time. */
  today: ParsedTask[];
  /** Active dated work due/scheduled tomorrow. */
  tomorrow: ParsedTask[];
  /** Remaining unblocked active work after the dated sections. */
  backlog: ParsedTask[];
  /** Recently completed tasks, shown as a quiet tail section. */
  recentlyDone: ParsedTask[];
  /** Header badge, led by overdue count, then blocked, today's count, then backlog volume. */
  badge: string | null;
}

function compareDashboardTodayTasks(_today: string): (a: ParsedTask, b: ParsedTask) => number {
  return (a, b) => {
    const da = dashboardTaskDate(a) ?? '9999-99-99';
    const db = dashboardTaskDate(b) ?? '9999-99-99';
    if (da !== db) return da < db ? -1 : 1;
    const ta = dashboardTaskTimeRange(a)?.start ?? 9999;
    const tb = dashboardTaskTimeRange(b)?.start ?? 9999;
    if (ta !== tb) return ta - tb;
    const pa = DASHBOARD_PRIORITY_RANK[a.metadata?.priority ?? 'normal'] ?? 3;
    const pb = DASHBOARD_PRIORITY_RANK[b.metadata?.priority ?? 'normal'] ?? 3;
    if (pa !== pb) return pa - pb;
    return dashboardTaskDisplayText(a).localeCompare(dashboardTaskDisplayText(b));
  };
}

export function dashboardTodayModel(tasks: ParsedTask[], today: string, _scope: DashboardScope): DashboardTodayModel {
  const active = filterDashboardActiveTasks(tasks);
  const tomorrowDate = dashboardDateAdd(today, 1);
  const sortDated = compareDashboardTodayTasks(today);
  const overdue = active.filter((task) => {
    const date = dashboardTaskDate(task);
    return Boolean(date && date < today);
  }).sort(sortDated);
  const overdueKeys = new Set(overdue.map((task) => task.key));
  const blocked = active
    .filter((task) => !overdueKeys.has(task.key) && isDashboardBlockedTask(task))
    .sort(compareDashboardTasks);
  const blockedKeys = new Set(blocked.map((task) => task.key));
  const todayTasks = active
    .filter((task) => !overdueKeys.has(task.key) && !blockedKeys.has(task.key) && dashboardTaskDate(task) === today)
    .sort(sortDated);
  const tomorrow = active
    .filter((task) => !overdueKeys.has(task.key) && !blockedKeys.has(task.key) && dashboardTaskDate(task) === tomorrowDate)
    .sort(sortDated);
  const sectionKeys = new Set([...overdue, ...blocked, ...todayTasks, ...tomorrow].map((task) => task.key));
  const backlog = active
    .filter((task) => !sectionKeys.has(task.key) && !isDashboardBlockedTask(task))
    .sort(compareFocusTasks(today));
  const recentlyDone = filterDashboardRecentlyCompletedTasks(tasks, today, _scope);
  const badge = overdue.length
    ? String(overdue.length)
    : blocked.length
      ? String(blocked.length)
      : todayTasks.length
        ? String(todayTasks.length)
        : backlog.length
          ? String(backlog.length)
          : recentlyDone.length
            ? String(recentlyDone.length)
            : null;
  return { overdue, blocked, today: todayTasks, tomorrow, backlog, recentlyDone, badge };
}

export type DashboardReviewQueueKey = 'triage' | 'schedule' | 'blocked' | 'stale';

export interface DashboardReviewQueue {
  key: DashboardReviewQueueKey;
  label: string;
  hint: string;
  icon: string;
  tone: string;
  tasks: ParsedTask[];
}

export function dashboardReviewQueues(tasks: ParsedTask[], today: string): DashboardReviewQueue[] {
  const active = filterDashboardActiveTasks(tasks);
  return [
    {
      key: 'triage',
      label: 'Triage',
      hint: 'raw captures',
      icon: 'inbox',
      tone: 'watch',
      tasks: tasks.filter(dashboardTaskIsInbox).sort((a, b) => a.filePath.localeCompare(b.filePath) || a.lineNumber - b.lineNumber),
    },
    {
      key: 'schedule',
      label: 'Schedule',
      hint: 'need dates',
      icon: 'calendar-plus',
      tone: 'schedule',
      tasks: filterDashboardNeedsSchedulingTasks(tasks, today),
    },
    {
      key: 'blocked',
      label: 'Blocked',
      hint: 'waiting',
      icon: 'circle-slash',
      tone: 'risk',
      tasks: active.filter(isDashboardBlockedTask).sort(compareDashboardTasks),
    },
    {
      key: 'stale',
      label: 'Stale',
      hint: '30d+ old',
      icon: 'clock-3',
      tone: 'muted',
      tasks: active.filter((task) => dashboardDateOlderThan(dashboardTaskAgeDate(task), today, 30)).sort(compareDashboardTasks),
    },
  ];
}

function dashboardTaskImportance(task: ParsedTask): boolean {
  return task.metadata.pinned === true || ['highest', 'high'].includes(task.metadata.priority) || task.tags.some((tag) => /important|focus|critical|key/iu.test(tag));
}

function dashboardTaskUrgency(task: ParsedTask, today: string): boolean {
  const date = dashboardTaskDate(task);
  return Boolean(date && date <= dashboardDateAdd(today, 2));
}

function compareFocusTasks(today: string): (a: ParsedTask, b: ParsedTask) => number {
  return (a, b) => {
    const score = (task: ParsedTask): number => {
      const date = dashboardTaskDate(task);
      const diff = date ? dashboardDayDiff(today, date) : 99;
      const dateScore = diff < 0 ? 50 + Math.min(20, -diff) : diff <= 0 ? 45 : diff <= 2 ? 35 : diff <= 7 ? 20 : 0;
      const priorityScore = 30 - ((DASHBOARD_PRIORITY_RANK[task.metadata.priority ?? 'normal'] ?? 3) * 5);
      const pinnedScore = task.metadata.pinned ? 12 : 0;
      const inProgressScore = task.status === 'in_progress' ? 10 : 0;
      const effort = dashboardEffortMinutes(task);
      const quickWinScore = effort > 0 && effort <= 30 ? 4 : 0;
      return dateScore + priorityScore + pinnedScore + inProgressScore + quickWinScore;
    };
    const diff = score(b) - score(a);
    return diff !== 0 ? diff : compareDashboardTasks(a, b);
  };
}

type DashboardBarPalette = 'accent' | 'categorical' | 'status' | 'priority' | 'severity' | 'sequential';

interface DashboardBarRow {
  label: string;
  value: number;
  detail?: string;
  tone?: string;
  colorClass?: string;
  key?: string;
  status?: string;
  priority?: string;
}

function dashboardCategoryColorClass(index: number): string {
  return `is-cat-${(index % 8) + 1}`;
}

function dashboardStatusColorClass(status: string): string | undefined {
  return ({
    todo: 'is-status-todo',
    in_progress: 'is-status-in-progress',
    on_hold: 'is-status-on-hold',
    blocked: 'is-status-blocked',
    deferred: 'is-status-waiting',
    waiting: 'is-status-waiting',
    done: 'is-status-done',
    cancelled: 'is-status-cancelled',
  } as Record<string, string>)[status];
}

function dashboardPriorityColorClass(priority: string): string | undefined {
  return ({
    highest: 'is-priority-highest',
    high: 'is-priority-high',
    medium: 'is-priority-medium',
    normal: 'is-priority-normal',
    low: 'is-priority-low',
    lowest: 'is-priority-lowest',
  } as Record<string, string>)[priority.toLowerCase()];
}

function dashboardSeverityColorClass(row: DashboardBarRow): string {
  if (row.tone === 'is-overdue') return 'is-severity-high';
  if (row.tone === 'is-soon') return 'is-severity-medium';
  if (row.tone === 'is-ok') return 'is-severity-low';
  return 'is-severity-neutral';
}

function dashboardBarColorClass(row: DashboardBarRow, index: number, palette: DashboardBarPalette): string {
  if (row.colorClass) return row.colorClass;
  if (palette === 'categorical') return dashboardCategoryColorClass(index);
  if (palette === 'status') return dashboardStatusColorClass(row.status ?? row.key ?? row.label.toLowerCase().replace(/\s+/gu, '_')) ?? '';
  if (palette === 'priority') return dashboardPriorityColorClass(row.priority ?? row.key ?? row.label) ?? '';
  if (palette === 'severity') return dashboardSeverityColorClass(row);
  if (palette === 'sequential') return `is-sequential-${Math.min(4, Math.max(1, index + 1))}`;
  return '';
}

function renderDashboardBars(container: HTMLElement, rows: DashboardBarRow[], options: { palette?: DashboardBarPalette } = {}): void {
  const max = Math.max(1, ...rows.map((row) => row.value));
  const palette = options.palette ?? 'accent';
  const list = container.createDiv('tm-dash-bars');
  rows.forEach((row, index) => {
    const colorClass = dashboardBarColorClass(row, index, palette);
    const item = list.createDiv({ cls: `tm-dash-bar-row${row.tone ? ` ${row.tone}` : ''}` });
    const top = item.createDiv('tm-dash-bar-top');
    const label = top.createSpan('tm-dash-bar-label');
    if (colorClass) {
      const dot = label.createSpan({ cls: `tm-dash-cat-dot ${colorClass}` });
      dot.setAttr('aria-hidden', 'true');
    }
    label.createSpan({ text: row.label });
    top.createSpan({ cls: 'tm-dash-bar-value', text: row.detail ?? formatDashboardCount(row.value) });
    const track = item.createDiv('tm-dash-bar-track');
    const fill = track.createDiv('tm-dash-bar-fill');
    if (colorClass) for (const c of colorClass.split(' ')) if (c) fill.addClass(c);
    fill.style.width = `${Math.max(4, Math.round((row.value / max) * 100))}%`;
  });
}

function renderDashboardHero(container: HTMLElement, value: string, label: string, detail?: string, tone: 'up' | 'down' | 'neutral' = 'neutral'): HTMLElement {
  const hero = container.createDiv('tm-dash-hero');
  hero.createDiv({ cls: 'tm-dash-hero-value', text: value });
  hero.createDiv({ cls: 'tm-dash-hero-label', text: label });
  if (detail) hero.createDiv({ cls: `tm-dash-hero-trend${tone === 'neutral' ? '' : ` is-${tone}`}`, text: detail });
  return hero;
}

/**
 * Level badge + XP progress bar for the optional Momentum card.
 * The XP figure shows progress *within* the current level (e.g. “140 / 150 XP”) rather than the
 * cumulative total, which otherwise reads as broken sitting next to “10 XP to level N”.
 */
function renderDashboardMomentumLevel(container: HTMLElement, stats: GamificationStats): void {
  const levelRow = container.createDiv('tm-dash-momentum-level');
  const badge = levelRow.createDiv('tm-dash-momentum-badge');
  badge.createSpan({ cls: 'tm-dash-momentum-badge-num', text: String(stats.currentLevel) });
  badge.createSpan({ cls: 'tm-dash-momentum-badge-label', text: 'LVL' });
  const levelMeta = levelRow.createDiv('tm-dash-momentum-level-meta');
  const base = getCumulativeXpForLevel(stats.currentLevel);
  const next = getXpForLevel(stats.currentLevel + 1);
  const intoLevel = Math.max(0, stats.currentXP - base);
  const levelPct = next > 0 ? Math.min(100, Math.round((intoLevel / next) * 100)) : 100;
  levelMeta.createDiv({
    cls: 'tm-dash-momentum-xp',
    text: next > 0 ? `${formatDashboardCount(intoLevel)} / ${formatDashboardCount(next)} XP` : `${formatDashboardCount(stats.currentXP)} XP`,
  });
  const xpTrack = levelMeta.createDiv('tm-dash-momentum-xp-track');
  xpTrack.createDiv('tm-dash-momentum-xp-fill').style.width = `${levelPct}%`;
  levelMeta.createDiv({
    cls: 'tm-dash-momentum-xp-next',
    text: next > 0 ? `${formatDashboardCount(Math.max(0, next - intoLevel))} XP to level ${stats.currentLevel + 1}` : 'Max level',
  });
}

/** Unlocked + next-up achievement chips shared by the Momentum card and the unified hero. */
function renderDashboardMomentumAchievements(container: HTMLElement, stats: GamificationStats): void {
  const unlocked = getUnlockedAchievements(stats);
  const nextUp = ACHIEVEMENTS.filter((achievement) => !achievement.condition(stats)).slice(0, 2);
  const achRow = container.createDiv('tm-dash-momentum-achievements');
  achRow.createDiv({ cls: 'tm-dash-momentum-ach-title', text: `Achievements · ${unlocked.length}/${ACHIEVEMENTS.length}` });
  const chips = achRow.createDiv('tm-dash-momentum-ach-chips');
  for (const achievement of unlocked.slice(-3)) {
    const chip = chips.createSpan({ cls: 'tm-dash-momentum-ach is-unlocked', text: `${achievement.emoji} ${achievement.name}` });
    chip.setAttr('title', achievement.description);
  }
  for (const achievement of nextUp) {
    const chip = chips.createSpan({ cls: 'tm-dash-momentum-ach is-locked', text: `${achievement.emoji} ${achievement.name}` });
    chip.setAttr('title', `Locked · ${achievement.description}`);
  }
  if (unlocked.length === 0 && nextUp.length === 0) {
    achRow.createDiv({ cls: 'tm-dash-momentum-ach-empty', text: 'Complete tasks to unlock achievements.' });
  }
}

function renderDashboardSection(container: HTMLElement, title: string, tasks: ParsedTask[], context: WidgetRenderContext, limit: number): void {
  const section = container.createDiv('tm-dash-section');
  section.createDiv({ cls: 'tm-dash-section-title', text: title });
  if (tasks.length === 0) {
    section.createDiv({ cls: 'tm-dash-section-empty', text: 'None' });
    return;
  }
  renderDashTaskList(section, tasks, context, limit);
}

function topDashboardGroups<T extends string>(items: T[], limit: number): Array<{ label: T; value: number }> {
  const counts = new Map<T, number>();
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1);
  return Array.from(counts.entries())
    .map(([label, value]) => ({ label, value }))
    .sort((a, b) => b.value - a.value || String(a.label).localeCompare(String(b.label)))
    .slice(0, limit);
}

function formatDashboardMinutes(minutes: number): string {
  if (minutes <= 0) return '0m';
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return h > 0 ? `${h}h${m ? ` ${m}m` : ''}` : `${m}m`;
}

function dashboardRiskScore(task: ParsedTask, today: string, blockerCounts = new Map<string, number>()): number {
  const date = dashboardTaskDate(task);
  const overdue = date && date < today ? Math.min(30, Math.abs(dashboardDayDiff(today, date)) * 3 + 12) : 0;
  const priority = 24 - ((DASHBOARD_PRIORITY_RANK[task.metadata.priority ?? 'normal'] ?? 3) * 4);
  const blocked = isDashboardBlockedTask(task) ? 12 : 0;
  const stale = dashboardDateOlderThan(dashboardTaskAgeDate(task), today, 30) ? 10 : 0;
  const missing = !date ? 4 : 0;
  const dependents = task.metadata.id ? Math.min(18, (blockerCounts.get(task.metadata.id) ?? 0) * 6) : 0;
  return Math.max(0, overdue + priority + blocked + stale + missing + dependents + (task.metadata.pinned ? 8 : 0));
}

function dashboardBlockerCounts(tasks: ParsedTask[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const task of filterDashboardActiveTasks(tasks)) {
    for (const dep of task.metadata.dependsOn) counts.set(dep, (counts.get(dep) ?? 0) + 1);
  }
  return counts;
}

function dashboardTaskIsSomeday(task: ParsedTask, today: string): boolean {
  const date = dashboardTaskDate(task);
  return task.status === 'deferred'
    || task.metadata.priority === 'low'
    || task.metadata.priority === 'lowest'
    || task.tags.some((tag) => /someday|maybe|backlog|later/iu.test(tag))
    || Boolean(date && dashboardDayDiff(today, date) > 30);
}

function dashboardTaskAvailableNow(task: ParsedTask, today: string): boolean {
  if (!filterDashboardActiveTasks([task]).length || isDashboardBlockedTask(task)) return false;
  const { start, scheduled } = task.metadata.dates;
  if (start && start > today) return false;
  if (scheduled && scheduled > today) return false;
  return true;
}

function dashboardTaskEnergy(task: ParsedTask): 'Low' | 'Medium' | 'High' {
  const haystack = [...task.tags, ...task.contexts, task.normalizedText].join(' ').toLowerCase();
  if (/low[- ]?energy|admin|errand|routine|easy/iu.test(haystack)) return 'Low';
  if (/deep[- ]?work|creative|write|design|strategy|hard|high[- ]?energy/iu.test(haystack)) return 'High';
  const effort = dashboardEffortMinutes(task);
  if (effort > 0 && effort <= 30) return 'Low';
  if (effort >= 90 || ['highest', 'high'].includes(task.metadata.priority)) return 'High';
  return 'Medium';
}

function dashboardProjectSummaries(tasks: ParsedTask[], today: string): Map<string, { tasks: ParsedTask[]; active: ParsedTask[]; overdue: ParsedTask[]; blocked: ParsedTask[]; stale: ParsedTask[]; next: ParsedTask[] }> {
  const projects = new Map<string, { tasks: ParsedTask[]; active: ParsedTask[]; overdue: ParsedTask[]; blocked: ParsedTask[]; stale: ParsedTask[]; next: ParsedTask[] }>();
  for (const task of tasks) {
    const name = dashboardProjectName(task);
    const entry = projects.get(name) ?? { tasks: [], active: [], overdue: [], blocked: [], stale: [], next: [] };
    entry.tasks.push(task);
    if (filterDashboardActiveTasks([task]).length) {
      entry.active.push(task);
      const date = dashboardTaskDate(task);
      if (date && date < today) entry.overdue.push(task);
      if (isDashboardBlockedTask(task)) entry.blocked.push(task);
      if (dashboardDateOlderThan(dashboardTaskAgeDate(task), today, 30)) entry.stale.push(task);
      if (dashboardTaskAvailableNow(task, today)) entry.next.push(task);
    }
    projects.set(name, entry);
  }
  return projects;
}

function renderDashboardNotes(container: HTMLElement, rows: Array<{ icon: string; text: string; tone?: string }>): void {
  const list = container.createDiv('tm-dash-notes');
  for (const row of rows) {
    const item = list.createDiv({ cls: `tm-dash-note${row.tone ? ` ${row.tone}` : ''}` });
    const icon = item.createSpan('tm-dash-note-icon');
    setIcon(icon, row.icon);
    item.createSpan({ cls: 'tm-dash-note-text', text: row.text });
  }
}

function percent(numerator: number, denominator: number): number {
  return denominator > 0 ? Math.round((numerator / denominator) * 100) : 0;
}

// ── Analytics helpers (pure, exported for tests) ─────────────────────────────

/** ISO date (YYYY-MM-DD) on which a task was completed, if any. */
function dashboardDoneDate(task: ParsedTask): string | undefined {
  return task.status === 'done' ? task.metadata.dates.done : undefined;
}

/**
 * Gamification stats derived purely from the current task set (mirrors the
 * stats-view computation): XP from completed + high-priority tasks, level from
 * XP, and the current consecutive-day completion streak.
 */
export function dashboardGamificationStats(tasks: ParsedTask[], today: string): GamificationStats {
  const done = tasks.filter((task) => task.status === 'done');
  const highPriorityDone = done.filter((task) => task.metadata.priority === 'high' || task.metadata.priority === 'highest').length;
  const completedToday = done.filter((task) => dashboardDoneDate(task) === today).length;
  const weekStart = dashboardDateAdd(today, -6);
  const weeklyCompleted = done.filter((task) => {
    const date = dashboardDoneDate(task);
    return Boolean(date && date >= weekStart && date <= today);
  }).length;
  const doneDays = new Set(done.map((task) => dashboardDoneDate(task)).filter((date): date is string => Boolean(date)));
  let streakDays = 0;
  for (let i = 0; i < 366; i += 1) {
    if (doneDays.has(dashboardDateAdd(today, -i))) streakDays += 1;
    else break;
  }
  const totalXP = done.length * 10 + highPriorityDone * 5;
  return {
    totalCompleted: done.length,
    streakDays,
    streakDays7: streakDays >= 7 ? 1 : 0,
    streakDays30: streakDays >= 30 ? 1 : 0,
    streakDays100: streakDays >= 100 ? 1 : 0,
    highPriorityCompleted: highPriorityDone,
    completedToday,
    weeklyCompleted,
    currentXP: totalXP,
    currentLevel: getLevelFromXP(totalXP),
    totalXPEarned: totalXP,
  };
}

export interface DashboardGlanceStats {
  start: string;
  end: string;
  windowLabel: string;
  windowAdverb: string;
  dueLabel: string;
  plannedDone: number;
  plannedTotal: number;
  rate: number;
  completedInWindow: number;
  activeInWindow: number;
  dueInWindow: number;
  overdue: number;
}

function dashboardScopeAdverb(scope: DashboardScope): string {
  if (scope === 'week') return 'this week';
  if (scope === 'month') return 'this month';
  return 'today';
}

function dashboardScopeDueLabel(scope: DashboardScope): string {
  if (scope === 'week') return 'Due this week';
  if (scope === 'month') return 'Due this month';
  return 'Due today';
}

/**
 * Stats for the “Today summary” card, scoped by the dashboard Today / Week / Month picker.
 *
 * The completion percentage is intentionally based on planned work in the selected window: tasks
 * with a due, scheduled, or start date inside the scope. A task completed outside today should not
 * move today's ring unless that task was actually planned for today.
 */
export function dashboardGlanceStats(tasks: ParsedTask[], today: string, scope: DashboardScope): DashboardGlanceStats {
  const { start, end, label } = dashboardScopeRange(scope, today);
  const inWindow = (date: string | undefined): boolean => Boolean(date && date >= start && date <= end);
  const relevant = tasks.filter((task) => task.status !== 'cancelled' && task.status !== 'untracked');
  const planned = relevant.filter((task) => inWindow(dashboardAgendaDate(task)));
  const plannedDone = planned.filter((task) => task.status === 'done').length;
  const activeInWindow = planned.filter((task) => task.status !== 'done').length;
  const completedInWindow = relevant.filter((task) => task.status === 'done' && inWindow(dashboardDoneDate(task))).length;
  const dueInWindow = planned.filter((task) => task.status !== 'done' && inWindow(task.metadata?.dates?.due)).length;
  return {
    start,
    end,
    windowLabel: label,
    windowAdverb: dashboardScopeAdverb(scope),
    dueLabel: dashboardScopeDueLabel(scope),
    plannedDone,
    plannedTotal: planned.length,
    rate: percent(plannedDone, planned.length),
    completedInWindow,
    activeInWindow,
    dueInWindow,
    overdue: filterDashboardOverdueTasks(tasks, today).length,
  };
}

export interface DashboardThroughputWeek {
  start: string;
  end: string;
  label: string;
  count: number;
}

/**
 * Bucket completion dates into `weeks` rolling 7-day windows ending today.
 * Returns oldest-first so it can be drawn left-to-right.
 */
export function dashboardWeeklyThroughput(dates: readonly string[], today: string, weeks = 6): DashboardThroughputWeek[] {
  const buckets: DashboardThroughputWeek[] = [];
  for (let w = weeks - 1; w >= 0; w -= 1) {
    const end = dashboardDateAdd(today, -w * 7);
    const start = dashboardDateAdd(end, -6);
    const count = dates.filter((date) => date >= start && date <= end).length;
    buckets.push({ start, end, label: dashboardShortDate(end), count });
  }
  return buckets;
}

export interface DashboardProductivityScore {
  score: number;
  completionRate: number;
  onTimeRate: number;
  completed: number;
  overdue: number;
  onTime: number;
  dueCompleted: number;
}

/**
 * A blended productivity KPI over a trailing window: 70% completion rate
 * (done vs done + still-overdue) and 30% on-time rate (done on or before due).
 */
export function dashboardProductivityScore(tasks: ParsedTask[], today: string, windowDays = 30): DashboardProductivityScore {
  const windowStart = dashboardDateAdd(today, -(windowDays - 1));
  const completed = tasks.filter((task) => {
    const date = dashboardDoneDate(task);
    return Boolean(date && date >= windowStart && date <= today);
  });
  const overdue = filterDashboardOverdueTasks(tasks, today).length;
  const dueCompleted = completed.filter((task) => Boolean(task.metadata.dates.due));
  const onTime = dueCompleted.filter((task) => {
    const due = task.metadata.dates.due as string;
    const done = dashboardDoneDate(task) as string;
    return done <= due;
  }).length;
  const completionRate = completed.length + overdue > 0 ? percent(completed.length, completed.length + overdue) : 100;
  const onTimeRate = dueCompleted.length > 0 ? percent(onTime, dueCompleted.length) : completionRate;
  const score = Math.round(completionRate * 0.7 + onTimeRate * 0.3);
  return { score, completionRate, onTimeRate, completed: completed.length, overdue, onTime, dueCompleted: dueCompleted.length };
}

export interface DashboardCycleTimeStats {
  leadAvg: number;
  cycleAvg: number;
  sampleSize: number;
}

/**
 * Average lead time (created → done) and cycle time (start → done, falling back
 * to created) across tasks completed within the trailing window.
 */
export function dashboardCycleTimeStats(tasks: ParsedTask[], today: string, windowDays = 60): DashboardCycleTimeStats {
  const windowStart = dashboardDateAdd(today, -(windowDays - 1));
  let leadTotal = 0;
  let cycleTotal = 0;
  let sampleSize = 0;
  for (const task of tasks) {
    const done = dashboardDoneDate(task);
    if (!done || done < windowStart || done > today) continue;
    const created = task.metadata.dates.created;
    const started = task.metadata.dates.start ?? created;
    const leadFrom = created ?? started;
    const cycleFrom = started ?? created;
    if (!leadFrom || !cycleFrom) continue;
    leadTotal += Math.max(0, dashboardDayDiff(leadFrom, done));
    cycleTotal += Math.max(0, dashboardDayDiff(cycleFrom, done));
    sampleSize += 1;
  }
  return {
    leadAvg: sampleSize > 0 ? Math.round((leadTotal / sampleSize) * 10) / 10 : 0,
    cycleAvg: sampleSize > 0 ? Math.round((cycleTotal / sampleSize) * 10) / 10 : 0,
    sampleSize,
  };
}

/** Active tasks ranked by how long they have been in progress / open. */
export function dashboardAgingWip(tasks: ParsedTask[], today: string): Array<{ task: ParsedTask; ageDays: number }> {
  return filterDashboardActiveTasks(tasks)
    .map((task) => {
      const from = task.metadata.dates.start ?? task.metadata.dates.created ?? task.metadata.dates.scheduled;
      const ageDays = from ? Math.max(0, dashboardDayDiff(from, today)) : 0;
      const inProgress = task.status === 'in_progress';
      return { task, ageDays, inProgress };
    })
    .filter((entry) => entry.inProgress || entry.ageDays > 0)
    .sort((a, b) => b.ageDays - a.ageDays || (a.task.normalizedText || '').localeCompare(b.task.normalizedText || ''))
    .map(({ task, ageDays }) => ({ task, ageDays }));
}

export interface DashboardTimeOfDayMatrix {
  /** matrix[weekday][hour]; weekday 0 = Monday … 6 = Sunday. */
  matrix: number[][];
  peak: { weekday: number; hour: number; count: number } | null;
  total: number;
}

export const DASHBOARD_WEEKDAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;

/**
 * Build a 7×24 (weekday × hour, local time) completion matrix from ISO
 * timestamps within the trailing window, plus the busiest cell.
 */
export function dashboardTimeOfDayMatrix(timestamps: readonly string[], today: string, weeks = 8): DashboardTimeOfDayMatrix {
  const windowStart = dashboardDateAdd(today, -(weeks * 7 - 1));
  const matrix: number[][] = Array.from({ length: 7 }, () => new Array<number>(24).fill(0));
  let total = 0;
  let peak: { weekday: number; hour: number; count: number } | null = null;
  for (const iso of timestamps) {
    const ms = Date.parse(iso);
    if (Number.isNaN(ms)) continue;
    const date = new Date(ms);
    const dayIso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    if (dayIso < windowStart || dayIso > today) continue;
    const weekday = (date.getDay() + 6) % 7; // shift so Monday = 0
    const hour = date.getHours();
    matrix[weekday][hour] += 1;
    total += 1;
    const count = matrix[weekday][hour];
    if (!peak || count > peak.count) peak = { weekday, hour, count };
  }
  return { matrix, peak, total };
}

export interface DashboardDailyGoal {
  completed: number;
  goal: number;
  pct: number;
  remaining: number;
  met: boolean;
}

/** Progress toward the configured daily completion target. */
export function dashboardDailyGoalProgress(tasks: ParsedTask[], today: string, goal: number): DashboardDailyGoal {
  const safeGoal = Math.max(1, Math.round(goal) || 1);
  const completed = tasks.filter((task) => dashboardDoneDate(task) === today).length;
  return {
    completed,
    goal: safeGoal,
    pct: Math.min(100, percent(completed, safeGoal)),
    remaining: Math.max(0, safeGoal - completed),
    met: completed >= safeGoal,
  };
}

export interface DashboardReviewItem {
  key: string;
  icon: string;
  label: string;
  count: number;
  done: boolean;
}

/** GTD weekly-review checklist composed from existing dashboard signals. */
export function dashboardWeeklyReviewItems(tasks: ParsedTask[], today: string): DashboardReviewItem[] {
  const inbox = tasks.filter(dashboardTaskIsInbox).length;
  const overdue = filterDashboardOverdueTasks(tasks, today).length;
  const blocked = filterDashboardActiveTasks(tasks).filter(isDashboardBlockedTask).length;
  const projects = dashboardProjectSummaries(tasks, today);
  const noNext = Array.from(projects.values()).filter((p) => p.active.length > 0 && p.next.length === 0).length;
  const stale = filterDashboardActiveTasks(tasks).filter((task) => dashboardDateOlderThan(dashboardTaskAgeDate(task), today, 30)).length;
  const weekStart = dashboardDateAdd(today, -6);
  const completedThisWeek = tasks.filter((task) => {
    const date = dashboardDoneDate(task);
    return Boolean(date && date >= weekStart && date <= today);
  }).length;
  return [
    { key: 'inbox', icon: 'inbox', label: 'Empty the inbox', count: inbox, done: inbox === 0 },
    { key: 'overdue', icon: 'alert-triangle', label: 'Clear overdue tasks', count: overdue, done: overdue === 0 },
    { key: 'blocked', icon: 'circle-slash', label: 'Unblock waiting tasks', count: blocked, done: blocked === 0 },
    { key: 'next-action', icon: 'list-x', label: 'Give every project a next action', count: noNext, done: noNext === 0 },
    { key: 'stale', icon: 'clock-alert', label: 'Reassess stale tasks', count: stale, done: stale === 0 },
    { key: 'celebrate', icon: 'party-popper', label: 'Tasks completed this week', count: completedThisWeek, done: true },
  ];
}

type DashboardActivityEvent = { at: string; icon: string; text: string; tone?: string };

function dashboardStatusLabel(status: ParsedTask['status'], settings: TaskManagerSettings): string {
  const configured = settings.supportedStates.find((state) => state.type === status && state.name.trim());
  if (configured) return configured.name.trim();
  return status
    .replace(/_/gu, ' ')
    .replace(/\b\w/gu, (letter) => letter.toUpperCase());
}

function dashboardEventDateLabel(value: string): string {
  const day = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(day)) return value;
  const time = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/u.test(value) ? ` ${value.slice(11, 16)}` : '';
  return `${dashboardShortDate(day)}${time}`;
}

function dashboardTaskTitle(task: ParsedTask): string {
  const base = task.normalizedText || task.body;
  return stripInlineTags(base) || base || task.metadata.id || task.key;
}

function dashboardCommandCandidates(id: string): string[] {
  return id.includes(':') ? [id] : [`task-manager:${id}`, id];
}

function executeDashboardCommand(app: App, id: string): boolean {
  const commandApi = (app as { commands?: { executeCommandById?: (commandId: string) => boolean | void } }).commands;
  if (!commandApi?.executeCommandById) return false;
  for (const candidate of dashboardCommandCandidates(id)) {
    try {
      const result = commandApi.executeCommandById(candidate);
      if (result !== false) return true;
    } catch {
      // Try the next candidate. Obsidian command IDs are plugin-prefixed at runtime.
    }
  }
  return false;
}

interface DashboardQuickAction {
  label?: string;
  full: string;
  icon: string;
  command: string;
}

const DASHBOARD_QUICK_ACTIONS: DashboardQuickAction[] = [
  { label: 'Plan today', full: 'Open daily planning assistant', icon: 'calendar-range', command: 'open-daily-planner' },
  { label: 'Refresh', full: 'Rescan vault', icon: 'refresh-cw', command: 'scan-vault' },
  { label: 'Find', full: 'Quick find task', icon: 'search', command: 'quick-find-task' },
];

function renderDashboardQuickActions(container: HTMLElement, context: WidgetRenderContext, actions: readonly DashboardQuickAction[] = DASHBOARD_QUICK_ACTIONS): WidgetDisposer | undefined {
  const grid = container.createDiv('tm-dash-action-grid');
  for (const action of actions) {
    const button = grid.createEl('button', { cls: 'tm-dash-action-button' });
    button.toggleClass('is-icon-only', !action.label);
    button.setAttr('type', 'button');
    button.setAttr('aria-label', action.full);
    button.setAttr('title', action.full);
    const icon = button.createSpan('tm-dash-action-icon');
    setIcon(icon, action.icon);
    if (action.label) button.createSpan({ cls: 'tm-dash-action-label', text: action.label });
    button.addEventListener('click', () => {
      if (!executeDashboardCommand(context.app, action.command)) {
        new Notice(`Task Manager: command unavailable (${action.label ?? action.full}).`);
      }
    });
  }

  // Reflow the button grid to best fit the widget's current size: more columns when the card
  // is short/wide, fewer (taller) columns when it is tall/narrow. Buttons stay single-line
  // (icon + ellipsized label); only when a cell is too narrow for any readable label do we drop
  // to an icon-only button — so label text never wraps under the icon and gets clipped.
  const win = container.ownerDocument.defaultView;
  let gap = 8;
  const computed = win?.getComputedStyle(grid);
  const parsedGap = computed ? Number.parseFloat(computed.rowGap || computed.gap || '') : Number.NaN;
  if (Number.isFinite(parsedGap) && parsedGap >= 0) gap = parsedGap;
  let appliedCols = 0;
  let appliedMode = '';
  let appliedTemplate = '';
  const applyLayout = (width: number, height: number) => {
    const cols = bestActionGridColumns(actions.length, width, height, gap);
    const cellW = cols > 0 ? (width - gap * (cols - 1)) / cols : width;
    const mode = cellW > 0 && cellW < 84 ? 'icononly' : 'row';
    const template = dashboardActionGridTemplate(actions, cols, mode);
    if (cols !== appliedCols || template !== appliedTemplate) {
      grid.style.gridTemplateColumns = template;
      appliedCols = cols;
      appliedTemplate = template;
    }
    if (mode !== appliedMode) {
      grid.classList.toggle('is-icononly', mode === 'icononly');
      appliedMode = mode;
    }
  };
  const rect = grid.getBoundingClientRect();
  applyLayout(rect.width, rect.height);
  if (win && typeof win.ResizeObserver === 'function') {
    const observer = new win.ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (box) applyLayout(box.width, box.height);
      else {
        const r = grid.getBoundingClientRect();
        applyLayout(r.width, r.height);
      }
    });
    observer.observe(grid);
    return () => observer.disconnect();
  }
  return undefined;
}

function dashboardCustomFieldValueText(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (Array.isArray(value)) {
    const parts = value.map((entry) => dashboardCustomFieldValueText(entry)).filter((entry): entry is string => Boolean(entry));
    return parts.length ? parts.join(', ') : null;
  }
  if (typeof value === 'object') {
    const maybeFieldValue = value as { value?: unknown };
    if ('value' in maybeFieldValue) return dashboardCustomFieldValueText(maybeFieldValue.value);
    try {
      const json = JSON.stringify(value);
      return json && json !== '{}' ? json : null;
    } catch {
      return null;
    }
  }
  if (typeof value === 'string') {
    const text = value.trim();
    return text.length > 0 ? text : null;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  return null;
}

function dashboardRecurrenceCount(task: ParsedTask, counts: Record<string, number> | undefined): number {
  return task.metadata.recurrenceCount ?? counts?.[task.key] ?? (task.stableKey ? counts?.[task.stableKey] : undefined) ?? 0;
}

// ── Analytics helpers for additional widgets (pure, exported for tests) ──────

/** Parse 'HH:MM' into minutes-from-midnight; null when malformed. */
export function dashboardHmToMinutes(hm: string | undefined): number | null {
  if (!hm) return null;
  const match = /^(\d{1,2}):(\d{2})$/u.exec(hm.trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/** Format minutes-from-midnight as a compact 12-hour clock label, e.g. "9:30a". */
export function dashboardFormatClock(totalMinutes: number): string {
  const normalized = ((Math.round(totalMinutes) % 1440) + 1440) % 1440;
  const hour = Math.floor(normalized / 60);
  const minute = normalized % 60;
  const period = hour < 12 ? 'a' : 'p';
  const display = hour % 12 === 0 ? 12 : hour % 12;
  return `${display}:${String(minute).padStart(2, '0')}${period}`;
}

export interface DashboardTimeRange { start: number; end: number }

/** Resolve a task's timed range (minutes from midnight) from timeStart/timeEnd or a raw time field. */
export function dashboardTaskTimeRange(task: ParsedTask): DashboardTimeRange | null {
  const meta = task.metadata;
  let startHm = meta.timeStart;
  let endHm = meta.timeEnd;
  if (!startHm && typeof meta.time === 'string') {
    const match = /(\d{1,2}:\d{2})(?:\s*-\s*(\d{1,2}:\d{2}))?/u.exec(meta.time);
    if (match) { startHm = match[1]; endHm = endHm ?? match[2]; }
  }
  const start = dashboardHmToMinutes(startHm);
  if (start === null) return null;
  let end = dashboardHmToMinutes(endHm);
  if (end === null || end <= start) end = Math.min(1440, start + 30);
  return { start, end };
}

export interface DashboardScheduleEntry {
  kind: 'task' | 'event';
  start: number;
  end: number;
  label: string;
  task?: ParsedTask;
}

/** Build today's time-ordered schedule from timed tasks and calendar events, plus untimed/all-day items. */
export function dashboardScheduleForDay(
  tasks: ParsedTask[],
  today: string,
  events: CalendarIcsEvent[] = [],
): { timed: DashboardScheduleEntry[]; untimed: ParsedTask[]; allDayEvents: string[] } {
  const timed: DashboardScheduleEntry[] = [];
  const untimed: ParsedTask[] = [];
  for (const task of filterDashboardActiveTasks(tasks)) {
    const date = task.metadata.dates.scheduled ?? task.metadata.dates.due;
    if (date !== today) continue;
    const range = dashboardTaskTimeRange(task);
    if (range) timed.push({ kind: 'task', start: range.start, end: range.end, label: dashboardTaskTitle(task), task });
    else untimed.push(task);
  }
  const allDayEvents: string[] = [];
  for (const event of events) {
    if (event.date !== today) continue;
    const start = dashboardHmToMinutes(event.startTime);
    if (start === null) { allDayEvents.push(event.summary || 'Event'); continue; }
    let end = dashboardHmToMinutes(event.endTime);
    if (end === null || end <= start) end = Math.min(1440, start + 30);
    timed.push({ kind: 'event', start, end, label: event.summary || 'Event' });
  }
  timed.sort((a, b) => a.start - b.start || a.end - b.end);
  untimed.sort(compareDashboardTasks);
  return { timed, untimed, allDayEvents };
}

/** Pairs of schedule entries whose time ranges overlap. */
export function dashboardScheduleOverlaps(entries: DashboardScheduleEntry[]): Array<[DashboardScheduleEntry, DashboardScheduleEntry]> {
  const sorted = [...entries].sort((a, b) => a.start - b.start);
  const pairs: Array<[DashboardScheduleEntry, DashboardScheduleEntry]> = [];
  for (let i = 0; i < sorted.length; i += 1) {
    for (let j = i + 1; j < sorted.length; j += 1) {
      if (sorted[j].start >= sorted[i].end) break;
      pairs.push([sorted[i], sorted[j]]);
    }
  }
  return pairs;
}

export interface DashboardCapacityDay { date: string; label: string; committed: number; capacity: number; over: boolean }

/** Committed estimated effort per day vs. available capacity over the next `days` days. */
export function dashboardCapacitySeries(tasks: ParsedTask[], today: string, capacityMinutes: number, days = 7): DashboardCapacityDay[] {
  const capacity = Math.max(1, Math.round(capacityMinutes) || 1);
  const active = filterDashboardActiveTasks(tasks);
  const series: DashboardCapacityDay[] = [];
  for (let offset = 0; offset < days; offset += 1) {
    const date = addDays(today, offset);
    let committed = 0;
    for (const task of active) {
      const due = task.metadata.dates.scheduled ?? task.metadata.dates.due;
      if (!due) continue;
      const effective = offset === 0 && due < today ? today : due;
      if (effective !== date) continue;
      committed += dashboardEffortMinutes(task);
    }
    series.push({ date, label: offset === 0 ? 'Today' : dashboardShortDate(date), committed, capacity, over: committed > capacity });
  }
  return series;
}

export interface DashboardBurndownPoint { date: string; label: string; remaining: number }

/**
 * Approximate remaining open tasks for each of the trailing `days` days, reconstructed
 * from created/done/cancelled dates (no historical snapshots required).
 */
export function dashboardBurndownSeries(tasks: ParsedTask[], today: string, days = 14): DashboardBurndownPoint[] {
  const tracked = tasks.filter((task) => task.status !== 'untracked');
  const points: DashboardBurndownPoint[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = addDays(today, -offset);
    let remaining = 0;
    for (const task of tracked) {
      const created = task.metadata.dates.created;
      if (created && created > date) continue;
      const closed = task.status === 'done' ? task.metadata.dates.done
        : task.status === 'cancelled' ? task.metadata.dates.cancelled : undefined;
      if ((task.status === 'done' || task.status === 'cancelled') && !closed) continue;
      if (closed && closed <= date) continue;
      remaining += 1;
    }
    points.push({ date, label: date === today ? 'Today' : dashboardShortDate(date), remaining });
  }
  return points;
}

export interface DashboardCompletionForecast {
  backlog: number;
  perWeek: number;
  weeksToClear: number | null;
  etaIso: string | null;
}

/** Project when the active backlog clears, given recent weekly completion velocity. */
export function dashboardCompletionForecast(tasks: ParsedTask[], today: string, completionDates: string[] = []): DashboardCompletionForecast {
  const backlog = filterDashboardActiveTasks(tasks).length;
  const dates = tasks.map((task) => dashboardDoneDate(task)).filter((date): date is string => Boolean(date)).concat(completionDates);
  const weeks = dashboardWeeklyThroughput(dates, today, 6);
  const total = weeks.reduce((sum, week) => sum + week.count, 0);
  const perWeek = Math.round((total / Math.max(1, weeks.length)) * 10) / 10;
  if (perWeek <= 0) return { backlog, perWeek: 0, weeksToClear: null, etaIso: null };
  const weeksToClear = Math.ceil(backlog / perWeek);
  return { backlog, perWeek, weeksToClear, etaIso: addDays(today, weeksToClear * 7) };
}

export interface DashboardCumulativeFlowWeek { label: string; created: number; done: number; open: number }

/** Cumulative created vs. completed totals per week — the band between them is open WIP. */
export function dashboardCumulativeFlow(tasks: ParsedTask[], today: string, completionDates: string[] = [], weeks = 8): DashboardCumulativeFlowWeek[] {
  const createdDates = tasks.map((task) => task.metadata.dates.created).filter((date): date is string => Boolean(date));
  const doneDates = tasks.map((task) => dashboardDoneDate(task)).filter((date): date is string => Boolean(date)).concat(completionDates);
  const out: DashboardCumulativeFlowWeek[] = [];
  for (let w = weeks - 1; w >= 0; w -= 1) {
    const end = addDays(today, -w * 7);
    const created = createdDates.filter((date) => date <= end).length;
    const done = doneDates.filter((date) => date <= end).length;
    out.push({ label: dashboardShortDate(end), created, done, open: Math.max(0, created - done) });
  }
  return out;
}

export interface DashboardEstimateVariance {
  sampleSize: number;
  estTotal: number;
  actualTotal: number;
  overCount: number;
  underCount: number;
  biasPct: number;
  worst: Array<{ task: ParsedTask; est: number; actual: number; deltaPct: number }>;
}

/** Estimate-vs-actual bias and the worst-diverging completed tasks. */
export function dashboardEstimateVariance(tasks: ParsedTask[]): DashboardEstimateVariance {
  const rows: Array<{ task: ParsedTask; est: number; actual: number; deltaPct: number }> = [];
  let estTotal = 0;
  let actualTotal = 0;
  let overCount = 0;
  let underCount = 0;
  for (const task of tasks) {
    if (task.status !== 'done') continue;
    const est = dashboardEffortMinutes(task);
    const actual = parseEffortMinutesForFilter(task.metadata.actual);
    if (!(est > 0) || !Number.isFinite(actual) || actual <= 0) continue;
    estTotal += est;
    actualTotal += actual;
    if (actual > est) overCount += 1;
    else if (actual < est) underCount += 1;
    rows.push({ task, est, actual, deltaPct: Math.round(((actual - est) / est) * 100) });
  }
  const biasPct = estTotal > 0 ? Math.round(((actualTotal - estTotal) / estTotal) * 100) : 0;
  const worst = [...rows].sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct)).slice(0, 6);
  return { sampleSize: rows.length, estTotal, actualTotal, overCount, underCount, biasPct, worst };
}

export interface DashboardGoalRow { label: string; done: number; total: number; pct: number; targetIso?: string; overdue: boolean }

/** Build a case-insensitive matcher for a configurable tag prefix, e.g. "goal" → #goal/<name>. */
export function dashboardTagPrefixRegex(prefix: string): RegExp {
  const escaped = (prefix || '').trim().replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return new RegExp(`^${escaped || 'goal'}s?[/-](.+)$`, 'iu');
}

/** Roll task completion up to goals defined via `#goal/<name>` tags or a `[goal:: ...]` field. */
export function dashboardGoalRows(tasks: ParsedTask[], today: string, fieldKey = 'goal', tagPrefix = 'goal'): DashboardGoalRow[] {
  const tagRegex = dashboardTagPrefixRegex(tagPrefix);
  const groups = new Map<string, { done: number; total: number; target?: string }>();
  const add = (label: string, task: ParsedTask): void => {
    const clean = label.trim();
    if (!clean) return;
    const entry = groups.get(clean) ?? { done: 0, total: 0 };
    entry.total += 1;
    if (task.status === 'done') entry.done += 1;
    const due = task.metadata.dates.due;
    if (due && task.status !== 'done' && task.status !== 'cancelled' && (!entry.target || due < entry.target)) entry.target = due;
    groups.set(clean, entry);
  };
  for (const task of tasks) {
    if (task.status === 'untracked') continue;
    for (const tag of task.tags) {
      const match = tagRegex.exec(tag);
      if (match) add(match[1].replace(/[-_/]+/gu, ' '), task);
    }
    const field = task.metadata.customFields?.[fieldKey];
    const fieldText = field !== undefined ? dashboardCustomFieldValueText(field) : null;
    if (fieldText) for (const part of fieldText.split(',')) add(part, task);
  }
  return Array.from(groups.entries())
    .map(([label, entry]) => ({ label, done: entry.done, total: entry.total, pct: percent(entry.done, entry.total), targetIso: entry.target, overdue: Boolean(entry.target && entry.target < today && entry.done < entry.total) }))
    .sort((a, b) => a.pct - b.pct || a.label.localeCompare(b.label));
}

export interface DashboardAreaRow { label: string; active: number; overdue: number; total: number }

/** Group tasks by area of responsibility: an `#area/<name>` tag or the top-level folder. */
export function dashboardAreaRows(tasks: ParsedTask[], today: string, tagPrefix = 'area'): DashboardAreaRow[] {
  const tagRegex = dashboardTagPrefixRegex(tagPrefix);
  const groups = new Map<string, { active: number; overdue: number; total: number }>();
  const labelFor = (task: ParsedTask): string => {
    for (const tag of task.tags) {
      const match = tagRegex.exec(tag);
      if (match) return (match[1].split('/')[0] || tag).replace(/[-_]+/gu, ' ');
    }
    if (task.filePath.includes('/')) return task.filePath.split('/')[0];
    return 'Top level';
  };
  for (const task of tasks) {
    if (task.status === 'untracked') continue;
    const label = labelFor(task);
    const entry = groups.get(label) ?? { active: 0, overdue: 0, total: 0 };
    entry.total += 1;
    if (filterDashboardActiveTasks([task]).length) {
      entry.active += 1;
      const date = dashboardTaskDate(task);
      if (date && date < today) entry.overdue += 1;
    }
    groups.set(label, entry);
  }
  return Array.from(groups.entries())
    .map(([label, entry]) => ({ label, active: entry.active, overdue: entry.overdue, total: entry.total }))
    .filter((row) => row.total > 0)
    .sort((a, b) => b.active - a.active || a.label.localeCompare(b.label));
}

export interface DashboardSubtaskRow { label: string; done: number; total: number; pct: number; task?: ParsedTask }

/** Progress of parent tasks over their children, linked via task id / parentId. */
export function dashboardSubtaskRows(tasks: ParsedTask[]): DashboardSubtaskRow[] {
  const explicitIds = new ExplicitIdIndex(tasks);
  const byId = new Map<string, ParsedTask>();
  for (const id of explicitIds.ids()) {
    const task = explicitIds.unique(id);
    if (task) byId.set(id, task);
  }
  const childrenByParent = new Map<string, ParsedTask[]>();
  for (const task of tasks) {
    const parentId = task.metadata.parentId;
    if (!parentId) continue;
    const arr = childrenByParent.get(parentId) ?? [];
    arr.push(task);
    childrenByParent.set(parentId, arr);
  }
  const rows: DashboardSubtaskRow[] = [];
  for (const [parentId, children] of childrenByParent) {
    const parent = byId.get(parentId);
    const total = children.length;
    const done = children.filter((child) => child.status === 'done').length;
    rows.push({ label: parent ? dashboardTaskTitle(parent) : parentId, done, total, pct: percent(done, total), task: parent });
  }
  return rows.sort((a, b) => a.pct - b.pct || b.total - a.total || a.label.localeCompare(b.label));
}

/** Tasks completed on this calendar day (MM-DD) in a previous year. */
export function dashboardOnThisDay(tasks: ParsedTask[], today: string): ParsedTask[] {
  const monthDay = today.slice(5);
  const year = today.slice(0, 4);
  return tasks
    .filter((task) => {
      const done = dashboardDoneDate(task);
      return Boolean(done && done.slice(5) === monthDay && done.slice(0, 4) < year);
    })
    .sort((a, b) => (dashboardDoneDate(b) ?? '').localeCompare(dashboardDoneDate(a) ?? ''));
}

export interface DashboardGoalDay { date: string; completed: number; met: boolean }

/** Per-day completion counts over the trailing window, flagged against the daily goal. */
export function dashboardGoalStreakDays(tasks: ParsedTask[], today: string, goal: number, days = 70, completions: string[] = []): DashboardGoalDay[] {
  const safeGoal = Math.max(1, Math.round(goal) || 1);
  const counts = new Map<string, number>();
  for (const task of tasks) { const done = dashboardDoneDate(task); if (done) counts.set(done, (counts.get(done) ?? 0) + 1); }
  for (const iso of completions) { const day = iso.slice(0, 10); counts.set(day, (counts.get(day) ?? 0) + 1); }
  const out: DashboardGoalDay[] = [];
  for (let offset = days - 1; offset >= 0; offset -= 1) {
    const date = addDays(today, -offset);
    const completed = counts.get(date) ?? 0;
    out.push({ date, completed, met: completed >= safeGoal });
  }
  return out;
}

/** Daily "shutdown" checklist composed from live signals. */
export function dashboardShutdownItems(tasks: ParsedTask[], today: string): DashboardReviewItem[] {
  const tomorrow = addDays(today, 1);
  const inbox = tasks.filter(dashboardTaskIsInbox).length;
  const overdue = filterDashboardOverdueTasks(tasks, today).length;
  const completedToday = tasks.filter((task) => dashboardDoneDate(task) === today).length;
  const tomorrowPlanned = filterDashboardActiveTasks(tasks).filter((task) => (task.metadata.dates.scheduled ?? task.metadata.dates.due) === tomorrow).length;
  const urgentOpen = filterDashboardActiveTasks(tasks).filter((task) => ['highest', 'high'].includes(task.metadata.priority) && dashboardTaskUrgency(task, today)).length;
  return [
    { key: 'inbox', icon: 'inbox', label: 'Clear your inbox', count: inbox, done: inbox === 0 },
    { key: 'overdue', icon: 'alert-triangle', label: 'Reschedule overdue tasks', count: overdue, done: overdue === 0 },
    { key: 'urgent', icon: 'flag', label: 'Close out urgent priorities', count: urgentOpen, done: urgentOpen === 0 },
    { key: 'tomorrow', icon: 'sunrise', label: 'Plan tomorrow', count: tomorrowPlanned, done: tomorrowPlanned > 0 },
    { key: 'celebrate', icon: 'party-popper', label: 'Completed today', count: completedToday, done: true },
  ];
}

// ── Widget renderers ────────────────────────────────────────────────────────

export function buildWidgetRegistry(): WidgetRegistry {
  const registry = new WidgetRegistry();

  registry.register('activity-timeline', {
    title: 'Activity timeline',
    icon: 'activity',
    description: 'Recent task creations, completions, cancellations, and sync activity in one feed.',
    defaultSize: 'medium',
    render: async (container, config, context) => {
      const state = context.state ?? await context.stateStore?.loadState();
      const byKey = context.aggregates?.byTaskKey ?? dashboardUniqueTaskKeyMap(context.tasks);
      const cutoff = dashboardDateAdd(context.today, -60);
      const seen = new Set<string>();
      const events: DashboardActivityEvent[] = [];
      const addEvent = (at: string | undefined, icon: string, text: string, tone?: string): void => {
        if (!at) return;
        const day = at.slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/u.test(day) || day < cutoff || day > context.today) return;
        const key = `${at}\u0000${icon}\u0000${text}`;
        if (seen.has(key)) return;
        seen.add(key);
        events.push({ at, icon, text, tone });
      };
      for (const task of context.tasks) {
        const title = dashboardTaskTitle(task);
        addEvent(task.metadata.dates.created, 'plus-circle', `Created ${title}`);
        addEvent(dashboardDoneDate(task), 'check-circle', `Completed ${title}`);
        addEvent(task.status === 'cancelled' ? task.metadata.dates.cancelled : undefined, 'x-circle', `Cancelled ${title}`, 'is-overdue');
      }
      for (const completion of state?.completions ?? []) {
        const task = byKey.get(completion.taskKey);
        addEvent(completion.completedAtIso, 'check-circle', `Logged completion: ${task ? dashboardTaskTitle(task) : completion.sourcePath.split('/').pop() ?? 'task'}`);
      }
      for (const run of (context.settings.syncRunHistory ?? []).slice(0, 20)) {
        const tone = run.outcome === 'failed' || run.outcome === 'partial' ? 'is-overdue' : undefined;
        addEvent(run.endedAt, run.outcome === 'failed' ? 'alert-triangle' : 'refresh-cw', `${run.service} sync ${run.outcome}`, tone);
      }
      events.sort((a, b) => b.at.localeCompare(a.at));
      context.setBadge(events.length ? String(events.length) : null);
      if (events.length === 0) {
        renderDashEmpty(container, 'activity', 'No recent task or sync activity found.');
        return;
      }
      renderDashboardNotes(container, events.slice(0, dashboardWidgetRowLimit(config, context.autoFit)).map((event) => ({
        icon: event.icon,
        text: `${dashboardEventDateLabel(event.at)} · ${event.text}`,
        tone: event.tone,
      })));
    },
  });

  registry.register('status-distribution', {
    title: 'Status distribution',
    icon: 'workflow',
    description: 'Vault tasks grouped by configured workflow status.',
    defaultSize: 'small',
    render: (container, _config, context) => {
      const aggregate = context.aggregates ?? buildDashboardAggregates(context.tasks);
      const tracked = aggregate.trackedTasks;
      const active = aggregate.activeTasks.length;
      const counts = new Map<ParsedTask['status'], number>();
      for (const [status, tasks] of aggregate.byStatus) if (status !== 'untracked') counts.set(status, tasks.length);
      context.setBadge(active ? String(active) : null);
      if (tracked.length === 0) {
        renderDashEmpty(container, 'workflow', 'No tracked tasks found.');
        return;
      }
      const order = new Map<ParsedTask['status'], number>();
      for (const state of context.settings.supportedStates) if (!order.has(state.type)) order.set(state.type, order.size);
      const rows = Array.from(counts.entries())
        .map(([status, value]) => ({ status, label: dashboardStatusLabel(status, context.settings), value, colorClass: dashboardStatusColorClass(status) }))
        .sort((a, b) => (order.get(a.status) ?? 99) - (order.get(b.status) ?? 99));
      renderDashboardBars(container, rows, { palette: 'status' });
    },
  });

  registry.register('assignee-workload', {
    title: 'Assignee workload',
    icon: 'users-round',
    description: 'Active task load grouped by assignee, reviewer, team, or unassigned work.',
    defaultSize: 'medium',
    render: (container, _config, context) => {
      const groups = new Map<string, { count: number; overdue: number; effort: number }>();
      for (const task of (context.aggregates ?? buildDashboardAggregates(context.tasks)).activeTasks) {
        const label = task.metadata.assignee ? `@${task.metadata.assignee}` : task.metadata.reviewer ? `Reviewer: ${task.metadata.reviewer}` : task.metadata.team ? `Team: ${task.metadata.team}` : 'Unassigned';
        const entry = groups.get(label) ?? { count: 0, overdue: 0, effort: 0 };
        entry.count += 1;
        entry.effort += dashboardEffortMinutes(task);
        const date = dashboardTaskDate(task);
        if (date && date < context.today) entry.overdue += 1;
        groups.set(label, entry);
      }
      const rows = Array.from(groups.entries())
        .map(([label, entry]) => ({ label, value: entry.count, detail: `${entry.count} active${entry.effort ? ` · ${formatDashboardMinutes(entry.effort)}` : ''}${entry.overdue ? ` · ${entry.overdue} overdue` : ''}`, tone: entry.overdue ? 'is-overdue' : '' }))
        .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label))
        .slice(0, 10)
        .map((row, index) => ({ ...row, colorClass: `is-cat-${(index % 8) + 1}` }));
      context.setBadge(rows.length ? String(rows.length) : null);
      if (rows.length === 0) {
        renderDashEmpty(container, 'users-round', 'No active workload to group.');
        return;
      }
      renderDashboardBars(container, rows, { palette: 'categorical' });
    },
  });

  registry.register('milestone-progress', {
    title: 'Milestone progress',
    icon: 'milestone',
    description: 'Completion progress grouped by project, tag, folder, or task heading.',
    defaultSize: 'medium',
    render: (container, _config, context) => {
      const groups = new Map<string, { total: number; done: number; active: number; overdue: number }>();
      for (const task of (context.aggregates ?? buildDashboardAggregates(context.tasks)).trackedTasks) {
        const label = task.metadata.project?.trim() || task.heading?.trim() || (task.tags[0] ? `#${task.tags[0]}` : dashboardProjectName(task));
        const entry = groups.get(label) ?? { total: 0, done: 0, active: 0, overdue: 0 };
        entry.total += 1;
        if (task.status === 'done') entry.done += 1;
        if (task.status !== 'done' && task.status !== 'cancelled' && task.status !== 'untracked') {
          entry.active += 1;
          const date = dashboardTaskDate(task);
          if (date && date < context.today) entry.overdue += 1;
        }
        groups.set(label, entry);
      }
      const rows = Array.from(groups.entries())
        .filter(([, entry]) => entry.total > 1 || entry.active > 0)
        .map(([label, entry]) => ({ label, value: percent(entry.done, entry.total), detail: `${entry.done}/${entry.total} done · ${entry.active} open`, tone: entry.overdue ? 'is-overdue' : '' }))
        .sort((a, b) => a.value - b.value || a.label.localeCompare(b.label))
        .slice(0, 10);
      const atRisk = rows.filter((row) => row.tone === 'is-overdue').length;
      context.setBadge(atRisk ? String(atRisk) : rows.length ? String(rows.length) : null);
      if (rows.length === 0) {
        renderDashEmpty(container, 'milestone', 'No project or milestone groups found.');
        return;
      }
      renderDashboardBars(container, rows, { palette: 'categorical' });
    },
  });

  registry.register('deadline-strip', {
    title: 'Deadline strip',
    icon: 'calendar-range',
    description: 'A compact 14-day pressure strip showing task count and estimated effort by date.',
    defaultSize: 'medium',
    render: (container, _config, context) => {
      const days = new Map<string, { count: number; effort: number; tasks: ParsedTask[] }>();
      const end = dashboardDateAdd(context.today, 13);
      for (const task of (context.aggregates ?? buildDashboardAggregates(context.tasks)).activeTasks) {
        const date = dashboardTaskDate(task);
        if (!date || date < context.today || date > end) continue;
        const entry = days.get(date) ?? { count: 0, effort: 0, tasks: [] };
        entry.count += 1;
        entry.effort += dashboardEffortMinutes(task);
        entry.tasks.push(task);
        days.set(date, entry);
      }
      const total = Array.from(days.values()).reduce((sum, entry) => sum + entry.count, 0);
      context.setBadge(total ? String(total) : null);
      const strip = container.createDiv('tm-dash-deadline-strip');
      strip.setAttr('role', 'list');
      strip.setAttr('aria-label', t('dashboard.a11y.deadlineStrip'));
      for (let offset = 0; offset < 14; offset += 1) {
        const date = dashboardDateAdd(context.today, offset);
        const entry = days.get(date) ?? { count: 0, effort: 0, tasks: [] };
        const weekday = DASHBOARD_WEEKDAY_LABELS[(new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7];
        const level = entry.count === 0 ? 0 : entry.count >= 5 || entry.effort >= 240 ? 3 : entry.count >= 3 || entry.effort >= 120 ? 2 : 1;
        const label = `${date}: ${entry.count} task${entry.count === 1 ? '' : 's'}${entry.effort ? ` · ${formatDashboardMinutes(entry.effort)}` : ''}`;
        const cell = strip.createDiv({ cls: `tm-dash-deadline-day tm-dash-deadline-l${level}` });
        cell.setAttr('role', 'listitem');
        cell.setAttr('title', label);
        cell.setAttr('aria-label', label);
        cell.createDiv({ cls: 'tm-dash-deadline-weekday', text: offset === 0 ? 'Today' : weekday });
        cell.createDiv({ cls: 'tm-dash-deadline-date', text: dashboardShortDate(date).replace(/^\w+\s/u, '') });
        cell.createDiv({ cls: 'tm-dash-deadline-count', text: entry.count ? String(entry.count) : '–' });
      }
      if (total === 0) container.createDiv({ cls: 'tm-dash-section-empty', text: 'No dated work in the next 14 days.' });
    },
  });

  registry.register('task-age-distribution', {
    title: 'Task age distribution',
    icon: 'chart-no-axes-column-increasing',
    description: 'Open tasks bucketed by how long they have been in your system.',
    defaultSize: 'medium',
    render: (container, _config, context) => {
      const buckets = [
        { label: 'Fresh 0–7d', min: 0, max: 7, count: 0 },
        { label: 'Recent 8–14d', min: 8, max: 14, count: 0 },
        { label: 'Aging 15–30d', min: 15, max: 30, count: 0 },
        { label: 'Old 31–60d', min: 31, max: 60, count: 0 },
        { label: 'Ancient 61d+', min: 61, max: Number.POSITIVE_INFINITY, count: 0 },
        { label: 'No age date', min: -1, max: -1, count: 0 },
      ];
      for (const task of filterDashboardActiveTasks(context.tasks)) {
        const from = dashboardTaskAgeDate(task);
        if (!from) { buckets[buckets.length - 1].count += 1; continue; }
        const age = Math.max(0, dashboardDayDiff(from, context.today));
        const bucket = buckets.find((entry) => age >= entry.min && age <= entry.max) ?? buckets[buckets.length - 2];
        bucket.count += 1;
      }
      const rows = buckets.map((bucket) => ({ label: bucket.label, value: bucket.count, tone: bucket.min >= 31 ? 'is-overdue' : bucket.min >= 15 ? 'is-soon' : '' }));
      const stale = buckets.filter((bucket) => bucket.min >= 31).reduce((sum, bucket) => sum + bucket.count, 0);
      context.setBadge(stale ? String(stale) : null);
      renderDashboardBars(container, rows, { palette: 'severity' });
    },
  });

  registry.register('scope-burnup', {
    title: 'Scope burn-up',
    icon: 'trending-up-down',
    description: 'Created vs completed work over rolling weekly windows, highlighting scope growth.',
    defaultSize: 'medium',
    render: async (container, _config, context) => {
      const state = await context.stateStore?.loadState();
      const completionDates = context.tasks.map((task) => dashboardDoneDate(task)).filter((date): date is string => Boolean(date));
      for (const completion of state?.completions ?? []) completionDates.push(completion.completedAtIso.slice(0, 10));
      const rows = [] as Array<{ label: string; value: number; detail: string; tone?: string }>;
      let totalCreated = 0;
      let totalCompleted = 0;
      for (let w = 7; w >= 0; w -= 1) {
        const end = dashboardDateAdd(context.today, -w * 7);
        const start = dashboardDateAdd(end, -6);
        const created = context.tasks.filter((task) => {
          const createdDate = task.metadata.dates.created;
          return Boolean(createdDate && createdDate >= start && createdDate <= end);
        }).length;
        const completed = completionDates.filter((date) => date >= start && date <= end).length;
        totalCreated += created;
        totalCompleted += completed;
        rows.push({
          label: dashboardShortDate(end),
          value: Math.max(created, completed),
          detail: `+${created} · ✓${completed} · net ${created - completed >= 0 ? '+' : ''}${created - completed}`,
          tone: created > completed ? 'is-overdue' : completed > created ? 'is-soon' : '',
        });
      }
      const net = totalCreated - totalCompleted;
      context.setBadge(`${net >= 0 ? '+' : ''}${net}`);
      renderDashboardBars(container, rows, { palette: 'severity' });
    },
  });

  registry.register('custom-field-breakdown', {
    title: 'Custom field breakdown',
    icon: 'list-filter',
    description: 'Top values for a chosen custom task field, automatically selecting the most-used field by default.',
    defaultSize: 'medium',
    render: (container, config, context) => {
      const fieldCounts = new Map<string, Map<string, number>>();
      for (const task of filterDashboardActiveTasks(context.tasks)) {
        for (const [key, fieldValue] of Object.entries(task.metadata.customFields ?? {})) {
          const value = dashboardCustomFieldValueText(fieldValue);
          if (!value) continue;
          const field = key.toLowerCase();
          const values = fieldCounts.get(field) ?? new Map<string, number>();
          for (const part of value.split(',').map((entry) => entry.trim()).filter(Boolean)) values.set(part, (values.get(part) ?? 0) + 1);
          fieldCounts.set(field, values);
        }
      }
      const configured = typeof config.customConfig?.field === 'string' ? config.customConfig.field.trim().toLowerCase() : '';
      const field = configured && fieldCounts.has(configured)
        ? configured
        : Array.from(fieldCounts.entries()).sort((a, b) => Array.from(b[1].values()).reduce((s, v) => s + v, 0) - Array.from(a[1].values()).reduce((s, v) => s + v, 0))[0]?.[0];
      if (!field) {
        context.setBadge(null);
        renderDashEmpty(container, 'list-filter', 'No active tasks with custom fields found.');
        return;
      }
      const definition = context.settings.customFieldDefinitions.find((item) => item.key.toLowerCase() === field);
      const display = definition?.name || field;
      const rows = Array.from((fieldCounts.get(field) ?? new Map<string, number>()).entries())
        .map(([label, value]) => ({ label, value }))
        .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label))
        .slice(0, 10);
      context.setBadge(display);
      container.createDiv({ cls: 'tm-dash-section-title', text: display });
      renderDashboardBars(container, rows, { palette: 'categorical' });
    },
  });

  registry.register('sync-conflicts', {
    title: 'Sync conflicts',
    icon: 'git-pull-request-alert',
    description: 'Failed, conflicted, queued, and retryable external-sync operations that need attention.',
    defaultSize: 'medium',
    render: async (container, _config, context) => {
      const state = await context.stateStore?.loadState();
      const operations = state?.syncQueueState?.operations ?? [];
      const counts = {
        queued: operations.filter((op) => op.status === 'queued').length,
        executing: operations.filter((op) => op.status === 'executing').length,
        failed: operations.filter((op) => op.status === 'failed').length,
        conflict: operations.filter((op) => op.status === 'conflict').length,
      };
      const failedRuns = (context.settings.syncRunHistory ?? []).filter((run) => run.outcome === 'failed' || run.outcome === 'partial').slice(0, 5);
      const attention = counts.failed + counts.conflict + failedRuns.length;
      context.setBadge(attention ? String(attention) : null);
      if (operations.length === 0 && failedRuns.length === 0) {
        renderDashEmpty(container, 'shield-check', 'No retained sync conflicts or failed sync runs.');
        return;
      }
      renderDashboardBars(container, [
        { label: 'Conflicted operations', value: counts.conflict, tone: counts.conflict ? 'is-overdue' : '' },
        { label: 'Failed operations', value: counts.failed, tone: counts.failed ? 'is-overdue' : '' },
        { label: 'Queued operations', value: counts.queued },
        { label: 'Executing operations', value: counts.executing, tone: counts.executing ? 'is-soon' : '' },
      ], { palette: 'severity' });
      const problemOps = operations
        .filter((op) => op.status === 'failed' || op.status === 'conflict')
        .sort((a, b) => b.queuedAt - a.queuedAt)
        .slice(0, 5)
        .map((op) => ({ icon: op.status === 'conflict' ? 'git-pull-request-alert' : 'alert-triangle', text: `${op.service} ${op.type}: ${op.error ?? op.vaultTask.normalizedText ?? op.id}`, tone: 'is-overdue' }));
      const runRows = failedRuns.map((run) => ({ icon: 'refresh-cw', text: `${run.service} sync ${run.outcome}: ${run.details}`, tone: 'is-overdue' }));
      if (problemOps.length || runRows.length) renderDashboardNotes(container, [...problemOps, ...runRows].slice(0, 6));
    },
  });

  registry.register('time-in-status', {
    title: 'Time in status',
    icon: 'timer-reset',
    description: 'Approximate average and oldest age of active work in each current status.',
    defaultSize: 'medium',
    render: (container, _config, context) => {
      const groups = new Map<ParsedTask['status'], { count: number; totalAge: number; oldest: number }>();
      for (const task of filterDashboardActiveTasks(context.tasks)) {
        const from = task.metadata.dates.start ?? task.metadata.dates.created ?? task.metadata.dates.scheduled ?? task.metadata.dates.due;
        const age = from ? Math.max(0, dashboardDayDiff(from, context.today)) : 0;
        const entry = groups.get(task.status) ?? { count: 0, totalAge: 0, oldest: 0 };
        entry.count += 1;
        entry.totalAge += age;
        entry.oldest = Math.max(entry.oldest, age);
        groups.set(task.status, entry);
      }
      const order = new Map<ParsedTask['status'], number>();
      for (const state of context.settings.supportedStates) if (!order.has(state.type)) order.set(state.type, order.size);
      const rows = Array.from(groups.entries())
        .map(([status, entry]) => {
          const avg = Math.round((entry.totalAge / Math.max(1, entry.count)) * 10) / 10;
          return { status, label: dashboardStatusLabel(status, context.settings), value: avg, detail: `${avg}d avg · ${entry.count} tasks · oldest ${entry.oldest}d`, tone: entry.oldest >= 14 ? 'is-overdue' : entry.oldest >= 7 ? 'is-soon' : '' };
        })
        .sort((a, b) => (order.get(a.status) ?? 99) - (order.get(b.status) ?? 99));
      const stuck = rows.filter((row) => row.tone === 'is-overdue').length;
      context.setBadge(stuck ? String(stuck) : null);
      if (rows.length === 0) {
        renderDashEmpty(container, 'timer-reset', 'No active tasks to age by status.');
        return;
      }
      renderDashboardBars(container, rows, { palette: 'status' });
    },
  });

  registry.register('recurrence-health', {
    title: 'Recurrence health',
    icon: 'repeat-2',
    description: 'Recurring task exceptions, overdue series, and recurrence limits that may need cleanup.',
    defaultSize: 'medium',
    render: async (container, config, context) => {
      const state = await context.stateStore?.loadState();
      const activeRecurring = filterDashboardActiveTasks(context.tasks).filter((task) => Boolean(task.metadata.recurrence));
      const exceptions = Object.values(state?.recurrenceExceptions ?? {}).flat();
      const end = dashboardDateAdd(context.today, 14);
      const overdue = activeRecurring.filter((task) => {
        const date = dashboardTaskDate(task);
        return Boolean(date && date < context.today);
      });
      const dueSoon = activeRecurring.filter((task) => {
        const date = dashboardTaskDate(task);
        return !date || date <= end;
      }).sort(compareDashboardTasks);
      const nearLimit = activeRecurring.filter((task) => {
        const limit = task.metadata.recurrenceLimit;
        return typeof limit === 'number' && limit > 0 && dashboardRecurrenceCount(task, state?.recurrenceCounts) >= Math.max(0, limit - 1);
      });
      const attention = overdue.length + nearLimit.length + exceptions.length;
      context.setBadge(attention ? String(attention) : activeRecurring.length ? String(activeRecurring.length) : null);
      if (activeRecurring.length === 0 && exceptions.length === 0) {
        renderDashEmpty(container, 'repeat-2', 'No recurring tasks or recurrence exceptions found.');
        return;
      }
      renderDashboardNotes(container, [
        { icon: 'repeat-2', text: `${activeRecurring.length} active recurring task${activeRecurring.length === 1 ? '' : 's'}` },
        { icon: 'calendar-clock', text: `${dueSoon.length} due in the next 14 days or missing a date`, tone: dueSoon.length ? 'is-soon' : '' },
        { icon: 'alert-triangle', text: `${overdue.length} overdue recurring task${overdue.length === 1 ? '' : 's'}`, tone: overdue.length ? 'is-overdue' : '' },
        { icon: 'flag', text: `${nearLimit.length} series near recurrence limit`, tone: nearLimit.length ? 'is-overdue' : '' },
        { icon: 'calendar-x', text: `${exceptions.length} skipped/deleted/modified occurrence${exceptions.length === 1 ? '' : 's'}`, tone: exceptions.length ? 'is-overdue' : '' },
      ]);
      const problemTasks = Array.from(new Set([...overdue, ...nearLimit]));
      if (problemTasks.length) renderDashTaskList(container, problemTasks.sort(compareDashboardTasks), context, dashboardWidgetRowLimit(config, context.autoFit));
      else if (dueSoon.length) renderDashTaskList(container, dueSoon, context, Math.min(4, dashboardWidgetRowLimit(config, context.autoFit)));
    },
  });

  registry.register('momentum', {
    title: 'Momentum',
    icon: 'flame',
    description: 'Completion streak, level, XP progress, and unlocked achievements.',
    defaultSize: 'medium',
    render: (container, _config, context) => {
      const stats = dashboardGamificationStats(context.tasks, context.today);
      context.setBadge(stats.streakDays ? `${stats.streakDays}d` : null);
      const wrap = container.createDiv('tm-dash-momentum');

      renderDashboardMomentumLevel(wrap, stats);

      const tiles = wrap.createDiv('tm-dash-stat-tiles');
      const wow = dashboardWeekOverWeekCount(context.tasks.map((task) => dashboardDoneDate(task)).filter((date): date is string => Boolean(date)), context.today);
      const addTile = (label: string, value: string, modifier = '', delta?: { text: string; tone: 'up' | 'down' | 'neutral' }): void => {
        const tile = tiles.createDiv({ cls: `tm-dash-stat-tile${modifier ? ` ${modifier}` : ''}` });
        tile.createDiv({ cls: 'tm-dash-stat-value', text: value });
        tile.createDiv({ cls: 'tm-dash-stat-label', text: label });
        if (delta) tile.createDiv({ cls: `tm-dash-stat-delta is-${delta.tone}`, text: delta.text });
      };
      addTile('Streak', `${stats.streakDays}d`, stats.streakDays >= 3 ? 'is-good' : '');
      addTile('Today', formatDashboardCount(stats.completedToday));
      addTile('This week', formatDashboardCount(stats.weeklyCompleted), '', formatDashboardDelta(wow.diff, true));
      addTile('Lifetime', formatDashboardCount(stats.totalCompleted));

      renderDashboardMomentumAchievements(wrap, stats);
    },
  });

  registry.register('throughput', {
    title: 'Throughput',
    icon: 'bar-chart-3',
    description: 'Completed tasks per week over the recent past.',
    defaultSize: 'medium',
    render: async (container, _config, context) => {
      const dates = context.tasks
        .map((task) => dashboardDoneDate(task))
        .filter((date): date is string => Boolean(date));
      const state = await context.stateStore?.loadState();
      for (const completion of state?.completions ?? []) {
        const date = completion.completedAtIso.slice(0, 10);
        if (date) dates.push(date);
      }
      const weeks = dashboardWeeklyThroughput(dates, context.today, 6);
      const total = weeks.reduce((sum, week) => sum + week.count, 0);
      context.setBadge(total ? String(total) : null);
      if (total === 0) {
        renderDashEmpty(container, 'bar-chart-3', 'No completions recorded yet.');
        return;
      }
      const recent = weeks[weeks.length - 1]?.count ?? 0;
      const prior = weeks.length > 1 ? weeks[weeks.length - 2].count : 0;
      const avg = Math.round((total / weeks.length) * 10) / 10;
      const summary = container.createDiv('tm-dash-throughput-summary');
      summary.createSpan({ cls: 'tm-dash-throughput-avg', text: `${avg}/wk avg` });
      const trend = recent - prior;
      const trendEl = summary.createSpan({ cls: `tm-dash-throughput-trend ${trend >= 0 ? 'is-up' : 'is-down'}` });
      trendEl.setText(`${trend >= 0 ? '↑' : '↓'} ${Math.abs(trend)} vs last week`);
      renderDashboardBars(container, weeks.map((week) => ({ label: week.label, value: week.count, detail: String(week.count) })), { palette: 'accent' });
    },
  });

  registry.register('productivity-score', {
    title: 'Productivity score',
    icon: 'gauge',
    description: 'Blended completion-rate and on-time KPI for the last 30 days.',
    defaultSize: 'small',
    render: (container, _config, context) => {
      const result = dashboardProductivityScore(context.tasks, context.today);
      context.setBadge(null);
      const tone = result.score >= 80 ? 'is-good' : result.score >= 60 ? 'is-warn' : 'is-bad';
      const wrap = container.createDiv('tm-dash-stats tm-dash-stats--hero');
      renderDashboardHero(wrap, String(result.score), 'Score', `${result.completed} done · ${result.onTimeRate}% on time`, result.score >= 80 ? 'up' : result.score < 60 ? 'down' : 'neutral');
      const ringWrap = wrap.createDiv(`tm-dash-ring ${tone}`);
      ringWrap.style.setProperty('--tm-dash-ring-value', `${result.score}`);
      ringWrap.createDiv({ cls: 'tm-dash-ring-value', text: `${result.score}` });
      ringWrap.setAttr('aria-label', `Productivity score ${result.score} of 100`);
      const tiles = wrap.createDiv('tm-dash-stat-tiles');
      const addTile = (label: string, value: string, modifier = ''): void => {
        const tile = tiles.createDiv({ cls: `tm-dash-stat-tile${modifier ? ` ${modifier}` : ''}` });
        tile.createDiv({ cls: 'tm-dash-stat-value', text: value });
        tile.createDiv({ cls: 'tm-dash-stat-label', text: label });
      };
      addTile('Completion', `${result.completionRate}%`);
      addTile('On time', `${result.onTimeRate}%`);
      addTile('Done 30d', formatDashboardCount(result.completed));
      addTile('Overdue', formatDashboardCount(result.overdue), result.overdue ? 'is-overdue' : '');
    },
  });

  registry.register('cycle-time', {
    title: 'Cycle time',
    icon: 'hourglass',
    description: 'Average lead/cycle time and the oldest work in progress.',
    defaultSize: 'medium',
    render: (container, config, context) => {
      const stats = dashboardCycleTimeStats(context.tasks, context.today);
      const aging = dashboardAgingWip(context.tasks, context.today);
      context.setBadge(aging.length ? String(aging.length) : null);
      const summary = container.createDiv('tm-dash-cycle-summary');
      const addStat = (label: string, value: string): void => {
        const cell = summary.createDiv('tm-dash-cycle-stat');
        cell.createDiv({ cls: 'tm-dash-cycle-value', text: value });
        cell.createDiv({ cls: 'tm-dash-cycle-label', text: label });
      };
      addStat('Lead avg', stats.sampleSize ? `${stats.leadAvg}d` : '–');
      addStat('Cycle avg', stats.sampleSize ? `${stats.cycleAvg}d` : '–');
      addStat('Sample', String(stats.sampleSize));
      if (aging.length === 0) {
        renderDashEmpty(container, 'hourglass', 'No aging work in progress.');
        return;
      }
      const limit = dashboardWidgetRowLimit(config, context.autoFit);
      container.createDiv({ cls: 'tm-dash-cycle-aging-title', text: 'Oldest in progress' });
      renderDashboardBars(container, aging.slice(0, limit).map((entry) => ({
        label: dashboardTaskDisplayText(entry.task),
        value: entry.ageDays,
        detail: `${entry.ageDays}d`,
        tone: entry.ageDays >= 30 ? 'is-overdue' : entry.ageDays >= 14 ? 'is-soon' : '',
      })), { palette: 'severity' });
    },
  });

  registry.register('time-heatmap', {
    title: 'Productive hours',
    icon: 'clock',
    description: 'When you complete tasks, by weekday and hour of day.',
    defaultSize: 'large',
    render: async (container, _config, context) => {
      const state = await context.stateStore?.loadState();
      const timestamps = (state?.completions ?? []).map((completion: CompletionRecord) => completion.completedAtIso);
      const result = dashboardTimeOfDayMatrix(timestamps, context.today, 8);
      context.setBadge(result.total ? String(result.total) : null);
      if (result.total === 0) {
        renderDashEmpty(container, 'clock', 'No completion times recorded yet.', 'Complete tasks from the dashboard to build an hourly productivity map.');
        return;
      }
      if (result.peak) {
        const hourLabel = dashboardFormatHour(result.peak.hour);
        container.createDiv({ cls: 'tm-dash-timeheat-peak', text: `Peak: ${DASHBOARD_WEEKDAY_LABELS[result.peak.weekday]} · ${hourLabel}` });
      }
      const max = Math.max(1, ...result.matrix.flat());
      const gridWrap = container.createDiv('tm-dash-timeheat');
      for (let weekday = 0; weekday < 7; weekday += 1) {
        const rowEl = gridWrap.createDiv('tm-dash-timeheat-row');
        rowEl.createSpan({ cls: 'tm-dash-timeheat-daylabel', text: DASHBOARD_WEEKDAY_LABELS[weekday] });
        const cells = rowEl.createDiv('tm-dash-timeheat-cells');
        for (let hour = 0; hour < 24; hour += 1) {
          const value = result.matrix[weekday][hour];
          const level = value === 0 ? 0 : Math.ceil((value / max) * 4);
          const label = `${DASHBOARD_WEEKDAY_LABELS[weekday]} ${dashboardFormatHour(hour)}: ${value} completed`;
          const cell = cells.createDiv({ cls: `tm-dash-heatmap-cell tm-dash-heatmap-l${level}` });
          cell.setAttr('role', 'img');
          cell.setAttr('title', label);
          cell.setAttr('aria-label', label);
        }
      }
      renderDashboardInsight(container, 'palette', 'Darker cells indicate higher completion density by weekday and hour.', 'neutral');
      const axis = gridWrap.createDiv('tm-dash-timeheat-axis');
      axis.createSpan('tm-dash-timeheat-axis-spacer');
      const axisCells = axis.createDiv('tm-dash-timeheat-axis-cells');
      for (const hour of [0, 6, 12, 18]) {
        axisCells.createSpan({ cls: 'tm-dash-timeheat-axis-label', text: dashboardFormatHour(hour) });
      }
    },
  });

  registry.register('quick-capture', {
    title: 'Quick actions',
    icon: 'bolt',
    description: 'Add a task and run the most common dashboard actions without leaving the dashboard.',
    details: 'Type a task and capture it straight into your configured inbox or daily note, then use the compact action row to plan, rescan, or quick-find tasks. Captured tasks land with no planning metadata, so they show up in Inbox triage for you to schedule and organize later.',
    shortcuts: [{ keys: 'Enter', description: 'Capture the typed task' }],
    defaultSize: 'small',
    live: true,
    render: (container, _config, context) => {
      context.setBadge(null);
      const wrap = container.createDiv('tm-dash-capture');
      const form = wrap.createEl('form', { cls: 'tm-dash-capture-form' });
      const input = form.createEl('input', {
        cls: 'tm-dash-capture-input',
        attr: { type: 'text', placeholder: 'Add a task…', 'aria-label': 'Quick actions task capture' },
      });
      const submit = form.createEl('button', { cls: 'tm-dash-capture-submit mod-cta', text: 'Add' });
      submit.setAttr('type', 'submit');
      const actionDisposer = renderDashboardQuickActions(wrap, context);
      const preview = wrap.createDiv('tm-dash-capture-preview');
      preview.hide();
      const status = wrap.createDiv('tm-dash-capture-status');
      if (!context.createTask) {
        input.disabled = true;
        submit.disabled = true;
        status.setText('Task capture is unavailable.');
      }
      // Live “how will this be read?” preview: parse the typed text the same way capture does and show
      // the extracted dates / priority / recurrence / tags as chips, plus a warning for any leftover
      // slash-command fragment (e.g. a half-typed “/w”) so the leak is visible *before* it's saved.
      const PRIORITY_PREVIEW: Record<string, string> = { '\uD83D\uDD3A': '\uD83D\uDD3A Highest', '\u23EB': '\u23EB High', '\uD83D\uDD3C': '\uD83D\uDD3C Medium', '\uD83D\uDD3D': '\uD83D\uDD3D Low', '\u23EC': '\u23EC Lowest' };
      const LEFTOVER_SLASH = /(?:^|\s)(\/[\p{L}][\p{L}\d-]*)/gu;
      const renderPreview = (): void => {
        preview.empty();
        const text = input.value.trim();
        if (!text) { preview.hide(); return; }
        let parsed;
        try { parsed = parseNLPInput(text, context.today, getLocale()); } catch { preview.hide(); return; }
        const rawTitle = parsed.description.trim();
        const leftovers = Array.from(new Set(Array.from(rawTitle.matchAll(LEFTOVER_SLASH), (m) => m[1])));
        const cleanTitle = rawTitle.replace(LEFTOVER_SLASH, ' ').replace(/\s+/gu, ' ').trim();
        const titleRow = preview.createDiv('tm-dash-capture-preview-title');
        titleRow.createSpan({ cls: 'tm-dash-capture-preview-arrow', text: '\u2192' });
        titleRow.createSpan({ cls: 'tm-dash-capture-preview-text', text: cleanTitle || '(empty task)' });
        const chipRow = preview.createDiv('tm-dash-capture-chips');
        const addChip = (label: string, tone = ''): void => { chipRow.createSpan({ cls: `tm-dash-capture-chip${tone ? ` ${tone}` : ''}`, text: label }); };
        if (parsed.dueDate) addChip(`\uD83D\uDCC5 ${parsed.dueDate}`);
        if (parsed.scheduledDate) addChip(`\u23F3 ${parsed.scheduledDate}${parsed.time ? ` ${parsed.time}` : ''}`);
        if (parsed.startDate) addChip(`\uD83D\uDEEB ${parsed.startDate}`);
        if (parsed.time && !parsed.scheduledDate) addChip(`\u23F0 ${parsed.time}`);
        if (parsed.priority) addChip(PRIORITY_PREVIEW[parsed.priority] ?? 'Priority');
        if (parsed.recurrence) addChip(`\uD83D\uDD01 ${parsed.recurrence}`);
        if (parsed.effort) addChip(`\u23F1\uFE0F ${parsed.effort}`);
        for (const tag of parsed.tags) addChip(`#${tag}`);
        for (const token of leftovers) addChip(`\u26A0 ${token} not recognized`, 'is-warn');
        if (chipRow.childElementCount === 0) chipRow.remove();
        preview.show();
      };
      input.addEventListener('input', renderPreview);
      let statusTimer: number | null = null;
      const showStatus = (text: string): void => {
        status.setText(text);
        if (statusTimer !== null) window.clearTimeout(statusTimer);
        statusTimer = window.setTimeout(() => status.setText(''), 4000);
      };
      form.addEventListener('submit', (event) => {
        event.preventDefault();
        const text = input.value.trim();
        if (!text || !context.createTask) return;
        submit.disabled = true;
        void context.createTask(text)
          .then(() => {
            input.value = '';
            preview.empty();
            preview.hide();
            showStatus('Captured');
            context.requestTaskRefresh();
          })
          .catch(() => { showStatus('Could not capture task.'); })
          .finally(() => { submit.disabled = false; input.focus(); });
      });
      return () => {
        actionDisposer?.();
        if (statusTimer !== null) window.clearTimeout(statusTimer);
      };
    },
  });

  registry.register('daily-goal', {
    title: 'Daily goal',
    icon: 'target',
    description: 'Progress toward your daily task-completion target.',
    defaultSize: 'small',
    render: (container, _config, context) => {
      const goal = context.settings.dashboardDailyGoal ?? 5;
      const progress = dashboardDailyGoalProgress(context.tasks, context.today, goal);
      context.setBadge(`${progress.completed}/${progress.goal}`);
      const wrap = container.createDiv('tm-dash-stats tm-dash-stats--hero');
      renderDashboardHero(wrap, `${progress.completed}/${progress.goal}`, 'Daily goal', progress.met ? 'Goal reached' : `${progress.remaining} to go`, progress.met ? 'up' : 'neutral');
      const ringWrap = wrap.createDiv(`tm-dash-ring ${progress.met ? 'is-good' : ''}`);
      ringWrap.style.setProperty('--tm-dash-ring-value', `${progress.pct}`);
      ringWrap.createDiv({ cls: 'tm-dash-ring-value', text: `${progress.completed}/${progress.goal}` });
      ringWrap.setAttr('aria-label', `${progress.completed} of ${progress.goal} tasks completed today`);
      const side = wrap.createDiv('tm-dash-goal-side');
      side.createDiv({ cls: 'tm-dash-goal-headline', text: progress.met ? 'Goal reached' : `${progress.remaining} to go` });
      const stepper = side.createDiv('tm-dash-goal-stepper');
      const setGoal = (next: number): void => {
        context.settings.dashboardDailyGoal = Math.max(1, Math.min(100, next));
        context.saveSettings?.();
        context.requestRefresh();
      };
      const minus = stepper.createEl('button', { cls: 'tm-dash-goal-step', text: '−' });
      minus.setAttr('aria-label', 'Decrease daily goal');
      stepper.createSpan({ cls: 'tm-dash-goal-step-value', text: `Goal ${progress.goal}` });
      const plus = stepper.createEl('button', { cls: 'tm-dash-goal-step', text: '+' });
      plus.setAttr('aria-label', 'Increase daily goal');
      minus.addEventListener('click', () => setGoal(goal - 1));
      plus.addEventListener('click', () => setGoal(goal + 1));
    },
  });

  registry.register('weekly-review', {
    title: 'Weekly review',
    icon: 'clipboard-check',
    description: 'A GTD weekly-review checklist built from your live task signals.',
    defaultSize: 'medium',
    render: (container, _config, context) => {
      const items = dashboardWeeklyReviewItems(context.tasks, context.today);
      const actionable = items.filter((item) => item.key !== 'celebrate');
      const outstanding = actionable.filter((item) => !item.done).length;
      context.setBadge(outstanding ? String(outstanding) : null);
      const progressEl = container.createDiv('tm-dash-review-progress');
      const cleared = actionable.length - outstanding;
      progressEl.createSpan({ cls: 'tm-dash-review-progress-text', text: `${cleared}/${actionable.length} review steps clear` });
      const track = progressEl.createDiv('tm-dash-review-progress-track');
      track.createDiv('tm-dash-review-progress-fill').style.width = `${percent(cleared, actionable.length)}%`;
      const list = container.createDiv('tm-dash-review-list');
      for (const item of items) {
        const isCelebrate = item.key === 'celebrate';
        const tone = isCelebrate ? 'is-info' : item.done ? 'is-done' : item.count > 0 ? 'is-todo' : 'is-done';
        const rowEl = list.createDiv({ cls: `tm-dash-review-item ${tone}` });
        const icon = rowEl.createSpan('tm-dash-review-icon');
        setIcon(icon, isCelebrate ? item.icon : item.done ? 'check-circle' : 'circle');
        rowEl.createSpan({ cls: 'tm-dash-review-label', text: item.label });
        rowEl.createSpan({ cls: 'tm-dash-review-count', text: String(item.count) });
      }
    },
  });

  registry.register('smart-suggestions', {
    title: 'Smart suggestions',
    icon: 'sparkles',
    description: 'Actionable recommendations synthesized from dashboard signals.',
    defaultSize: 'medium',
    render: (container, _config, context) => {
      const active = filterDashboardActiveTasks(context.tasks);
      const overdue = filterDashboardOverdueTasks(context.tasks, context.today);
      const inbox = context.tasks.filter(dashboardTaskIsInbox);
      const blocked = active.filter(isDashboardBlockedTask);
      const quick = active.filter((task) => dashboardTaskAvailableNow(task, context.today) && dashboardEffortMinutes(task) > 0 && dashboardEffortMinutes(task) <= 30);
      const stale = active.filter((task) => dashboardDateOlderThan(dashboardTaskAgeDate(task), context.today, 30));
      const rows: Array<{ icon: string; text: string; tone?: string }> = [];
      if (overdue.length) rows.push({ icon: 'alert-triangle', text: `Review ${overdue.length} overdue task${overdue.length === 1 ? '' : 's'}.`, tone: 'is-overdue' });
      if (blocked.length) rows.push({ icon: 'circle-slash', text: `Unblock or follow up on ${blocked.length} waiting task${blocked.length === 1 ? '' : 's'}.` });
      if (inbox.length) rows.push({ icon: 'inbox', text: `Triage ${inbox.length} captured task${inbox.length === 1 ? '' : 's'} missing planning metadata.` });
      if (quick.length) rows.push({ icon: 'zap', text: `Clear ${quick.length} quick win${quick.length === 1 ? '' : 's'} under 30 minutes.` });
      if (stale.length) rows.push({ icon: 'clock-alert', text: `Reconsider ${stale.length} stale task${stale.length === 1 ? '' : 's'} older than 30 days.` });
      if (rows.length === 0) rows.push({ icon: 'check-circle', text: 'No urgent cleanup suggestions. Your task system looks healthy.' });
      context.setBadge(rows.length ? String(rows.length) : null);
      renderDashboardNotes(container, rows.slice(0, 8));
    },
  });

  registry.register('risk-radar', {
    title: 'Risk radar',
    icon: 'radar',
    description: 'Highest-risk tasks by overdue status, priority, blockers, staleness, and dependencies.',
    defaultSize: 'medium',
    render: (container, config, context) => {
      const blockers = dashboardBlockerCounts(context.tasks);
      const tasks = filterDashboardActiveTasks(context.tasks)
        .map((task) => ({ task, score: dashboardRiskScore(task, context.today, blockers) }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((entry) => entry.task);
      context.setBadge(tasks.length ? String(tasks.length) : null);
      if (!tasks.length) { renderDashEmpty(container, 'radar', 'No significant task risk detected.'); return; }
      renderDashTaskList(container, tasks, context, dashboardWidgetRowLimit(config, context.autoFit));
    },
  });

  registry.register('someday-maybe', {
    title: 'Someday / maybe',
    icon: 'archive',
    description: 'Parked, low-priority, backlog, or far-future tasks.',
    defaultSize: 'medium',
    render: (container, config, context) => {
      const tasks = filterDashboardActiveTasks(context.tasks).filter((task) => dashboardTaskIsSomeday(task, context.today)).sort(compareDashboardTasks);
      context.setBadge(tasks.length ? String(tasks.length) : null);
      if (!tasks.length) { renderDashEmpty(container, 'archive', 'No someday/maybe tasks found.', 'Park low-priority or far-future tasks (e.g. tag them #someday) to see them here.'); return; }
      renderDashTaskList(container, tasks, context, dashboardWidgetRowLimit(config, context.autoFit));
    },
  });

  registry.register('project-health', {
    title: 'Project health',
    icon: 'heart-pulse',
    description: 'Projects ranked by overdue, blocked, stale, and missing-next-action signals.',
    defaultSize: 'medium',
    render: (container, _config, context) => {
      const rows = Array.from(dashboardProjectSummaries(context.tasks, context.today).entries())
        .map(([label, p]) => ({ label, value: p.overdue.length * 4 + p.blocked.length * 3 + p.stale.length * 2 + (p.active.length > 0 && p.next.length === 0 ? 5 : 0), detail: `${p.active.length} active · ${p.overdue.length} overdue · ${p.blocked.length} blocked`, tone: p.overdue.length ? 'is-overdue' : p.blocked.length ? 'is-soon' : '' }))
        .filter((row) => row.value > 0)
        .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label))
        .slice(0, 8);
      context.setBadge(rows.length ? String(rows.length) : null);
      if (!rows.length) { renderDashEmpty(container, 'heart-pulse', 'No unhealthy projects detected.'); return; }
      renderDashboardBars(container, rows, { palette: 'severity' });
    },
  });

  registry.register('quick-wins', {
    title: 'Quick wins',
    icon: 'zap',
    description: 'Unblocked tasks estimated at 30 minutes or less.',
    defaultSize: 'medium',
    render: (container, config, context) => {
      const tasks = context.tasks.filter((task) => dashboardTaskAvailableNow(task, context.today) && dashboardEffortMinutes(task) > 0 && dashboardEffortMinutes(task) <= 30).sort(compareFocusTasks(context.today));
      context.setBadge(tasks.length ? String(tasks.length) : null);
      if (!tasks.length) { renderDashEmpty(container, 'zap', 'No quick wins with effort estimates.'); return; }
      renderDashTaskList(container, tasks, context, dashboardWidgetRowLimit(config, context.autoFit));
    },
  });

  registry.register('deep-work', {
    title: 'Deep work',
    icon: 'brain',
    description: 'Important unblocked tasks that likely need a longer focus block.',
    defaultSize: 'medium',
    render: (container, config, context) => {
      const tasks = context.tasks.filter((task) => dashboardTaskAvailableNow(task, context.today) && (dashboardEffortMinutes(task) >= 90 || dashboardTaskImportance(task))).sort(compareFocusTasks(context.today));
      context.setBadge(tasks.length ? String(tasks.length) : null);
      if (!tasks.length) { renderDashEmpty(container, 'brain', 'No deep-work tasks identified.'); return; }
      renderDashTaskList(container, tasks, context, dashboardWidgetRowLimit(config, context.autoFit));
    },
  });

  registry.register('energy-fit', {
    title: 'Energy fit',
    icon: 'battery-charging',
    description: 'Available tasks grouped by low, medium, and high energy fit.',
    defaultSize: 'large',
    render: (container, config, context) => {
      const tasks = context.tasks.filter((task) => dashboardTaskAvailableNow(task, context.today)).sort(compareFocusTasks(context.today));
      context.setBadge(tasks.length ? String(tasks.length) : null);
      const per = Math.max(2, Math.floor(dashboardWidgetRowLimit(config, context.autoFit) / 3));
      for (const energy of ['Low', 'Medium', 'High'] as const) renderDashboardSection(container, `${energy} energy`, tasks.filter((task) => dashboardTaskEnergy(task) === energy), context, per);
    },
  });

  registry.register('time-block-suggestions', {
    title: 'Time block suggestions',
    icon: 'calendar-clock',
    description: 'Simple suggestions for filling today with deep work, quick wins, and review.',
    defaultSize: 'medium',
    render: (container, _config, context) => {
      const available = context.tasks.filter((task) => dashboardTaskAvailableNow(task, context.today)).sort(compareFocusTasks(context.today));
      const deep = available.find((task) => dashboardEffortMinutes(task) >= 60 || dashboardTaskImportance(task));
      const quick = available.filter((task) => dashboardEffortMinutes(task) > 0 && dashboardEffortMinutes(task) <= 30).length;
      const follow = available.filter((task) => task.metadata.followUp || task.metadata.assignee || task.metadata.reviewer).length;
      const rows = [
        { icon: 'sunrise', text: deep ? `Morning focus: ${dashboardTaskDisplayText(deep)}` : 'Morning focus: choose one high-priority task.' },
        { icon: 'zap', text: quick ? `Short block: clear ${quick} quick win${quick === 1 ? '' : 's'}.` : 'Short block: no estimated quick wins available.' },
        { icon: 'eye', text: follow ? `Review block: follow up on ${follow} waiting item${follow === 1 ? '' : 's'}.` : 'Review block: no waiting follow-ups found.' },
      ];
      context.setBadge(String(rows.length));
      renderDashboardNotes(container, rows);
    },
  });

  registry.register('date-quality', {
    title: 'Due date quality',
    icon: 'calendar-warning',
    description: 'Tasks with missing, inconsistent, or low-quality date metadata.',
    defaultSize: 'medium',
    render: (container, config, context) => {
      const tasks = filterDashboardActiveTasks(context.tasks).filter((task) => {
        const d = task.metadata.dates;
        return (['highest', 'high'].includes(task.metadata.priority) && !dashboardTaskDate(task)) || Boolean(d.scheduled && d.due && d.scheduled > d.due) || Object.keys(task.metadata.invalidDates ?? {}).length > 0;
      }).sort(compareDashboardTasks);
      context.setBadge(tasks.length ? String(tasks.length) : null);
      if (!tasks.length) { renderDashEmpty(container, 'calendar-check', 'No date quality issues detected.'); return; }
      renderDashTaskList(container, tasks, context, dashboardWidgetRowLimit(config, context.autoFit));
    },
  });

  registry.register('metadata-completeness', {
    title: 'Metadata completeness',
    icon: 'list-checks',
    description: 'How much of your active task metadata is filled in.',
    defaultSize: 'small',
    render: (container, _config, context) => {
      const active = filterDashboardActiveTasks(context.tasks);
      const rows = [
        { label: 'Project', value: percent(active.filter((t) => Boolean(t.metadata.project)).length, active.length), detail: `${percent(active.filter((t) => Boolean(t.metadata.project)).length, active.length)}%` },
        { label: 'Date', value: percent(active.filter((t) => Boolean(dashboardTaskDate(t))).length, active.length), detail: `${percent(active.filter((t) => Boolean(dashboardTaskDate(t))).length, active.length)}%` },
        { label: 'Effort', value: percent(active.filter((t) => dashboardEffortMinutes(t) > 0).length, active.length), detail: `${percent(active.filter((t) => dashboardEffortMinutes(t) > 0).length, active.length)}%` },
        { label: 'Tags/context', value: percent(active.filter((t) => t.tags.length + t.contexts.length > 0).length, active.length), detail: `${percent(active.filter((t) => t.tags.length + t.contexts.length > 0).length, active.length)}%` },
      ];
      context.setBadge(active.length ? `${Math.round(rows.reduce((s, r) => s + r.value, 0) / rows.length)}%` : null);
      renderDashboardBars(container, rows, { palette: 'accent' });
    },
  });

  registry.register('reminder-queue', {
    title: 'Reminder queue',
    icon: 'bell-ring',
    description: 'Upcoming, snoozed, and missed reminders.',
    defaultSize: 'medium',
    render: async (container, _config, context) => {
      const state = await context.stateStore?.loadState();
      const upcoming = filterDashboardActiveTasks(context.tasks).filter((task) => Boolean(task.metadata.reminder)).sort((a, b) => (a.metadata.reminder ?? '').localeCompare(b.metadata.reminder ?? ''));
      const missed = state?.missedReminders?.filter((r) => !r.acknowledged) ?? [];
      const snoozed = state?.snoozedReminders ?? [];
      context.setBadge(String(upcoming.length + missed.length + snoozed.length));
      renderDashboardNotes(container, [
        { icon: 'bell', text: `${upcoming.length} active reminder${upcoming.length === 1 ? '' : 's'}` },
        { icon: 'alarm-snooze', text: `${snoozed.length} snoozed reminder${snoozed.length === 1 ? '' : 's'}` },
        { icon: 'bell-off', text: `${missed.length} missed reminder${missed.length === 1 ? '' : 's'}`, tone: missed.length ? 'is-overdue' : '' },
      ]);
    },
  });

  registry.register('time-by-project', {
    title: 'Time by project',
    icon: 'clock-3',
    description: 'Logged time this week grouped by project or file.',
    defaultSize: 'medium',
    render: async (container, _config, context) => {
      const state = await context.stateStore?.loadState();
      const since = dashboardDateAdd(context.today, -7);
      const byTask = dashboardUniqueTaskKeyMap(context.tasks);
      const totals = new Map<string, number>();
      for (const session of state?.timeSessionLog ?? []) {
        if (session.endedAtIso.slice(0, 10) < since) continue;
        const task = byTask.get(session.taskKey);
        const label = task ? dashboardProjectName(task) : session.taskFilePath.split('/')[0] || 'No project';
        totals.set(label, (totals.get(label) ?? 0) + session.elapsedMinutes);
      }
      const rows = Array.from(totals.entries()).map(([label, value]) => ({ label, value, detail: formatDashboardMinutes(value) })).sort((a, b) => b.value - a.value).slice(0, 8);
      context.setBadge(rows.length ? formatDashboardMinutes(rows.reduce((s, r) => s + r.value, 0)) : null);
      if (!rows.length) { renderDashEmpty(container, 'clock-3', 'No time sessions logged this week.'); return; }
      renderDashboardBars(container, rows, { palette: 'categorical' });
    },
  });

  registry.register('estimate-accuracy', {
    title: 'Estimate accuracy',
    icon: 'scale',
    description: 'Completed tasks with both estimated and actual time metadata.',
    defaultSize: 'medium',
    render: (container, _config, context) => {
      const rows = context.tasks.filter((task) => task.status === 'done' && dashboardEffortMinutes(task) > 0 && Number.isFinite(parseEffortMinutesForFilter(task.metadata.actual)))
        .map((task) => {
          const est = dashboardEffortMinutes(task);
          const actual = parseEffortMinutesForFilter(task.metadata.actual);
          return { label: dashboardTaskDisplayText(task), value: Math.round(Math.abs(actual - est)), detail: `${formatDashboardMinutes(actual)} / ${formatDashboardMinutes(est)}` };
        }).sort((a, b) => b.value - a.value).slice(0, 8);
      context.setBadge(rows.length ? String(rows.length) : null);
      if (!rows.length) { renderDashEmpty(container, 'gauge', 'No completed tasks with estimate and actual metadata.'); return; }
      renderDashboardBars(container, rows, { palette: 'severity' });
    },
  });

  registry.register('task-churn', {
    title: 'Task churn',
    icon: 'shuffle',
    description: 'Created vs completed task movement over the last week.',
    defaultSize: 'small',
    render: (container, _config, context) => {
      const since = dashboardDateAdd(context.today, -7);
      const created = context.tasks.filter((task) => (task.metadata.dates.created ?? '') >= since).length;
      const completed = context.tasks.filter((task) => (task.metadata.dates.done ?? '') >= since).length;
      const deferred = context.tasks.filter((task) => task.status === 'deferred').length;
      renderDashboardBars(container, [
        { label: 'Created', value: created, colorClass: 'is-cat-1' },
        { label: 'Completed', value: completed, status: 'done' },
        { label: 'Deferred now', value: deferred, status: 'deferred' },
        { label: 'Net change', value: Math.abs(created - completed), detail: `${created - completed >= 0 ? '+' : ''}${created - completed}`, tone: created > completed ? 'is-overdue' : 'is-soon' },
      ], { palette: 'status' });
      context.setBadge(`${created - completed >= 0 ? '+' : ''}${created - completed}`);
    },
  });

  registry.register('backlog-growth', {
    title: 'Backlog growth',
    icon: 'trending-up',
    description: 'Active backlog size plus recent created/completed trend.',
    defaultSize: 'small',
    render: (container, _config, context) => {
      const active = filterDashboardActiveTasks(context.tasks).length;
      const since = dashboardDateAdd(context.today, -30);
      const created = context.tasks.filter((task) => (task.metadata.dates.created ?? '') >= since).length;
      const completed = context.tasks.filter((task) => (task.metadata.dates.done ?? '') >= since).length;
      context.setBadge(String(active));
      renderDashboardBars(container, [
        { label: 'Active backlog', value: active, colorClass: 'is-status-in-progress' },
        { label: 'Created 30d', value: created, colorClass: 'is-cat-1' },
        { label: 'Completed 30d', value: completed, status: 'done' },
        { label: 'Net 30d', value: Math.abs(created - completed), detail: `${created - completed >= 0 ? '+' : ''}${created - completed}`, tone: created > completed ? 'is-overdue' : 'is-soon' },
      ], { palette: 'status' });
    },
  });

  registry.register('file-hotspots', {
    title: 'File hotspots',
    icon: 'file-warning',
    description: 'Notes/files with the largest number of active tasks.',
    defaultSize: 'medium',
    render: (container, _config, context) => {
      const active = filterDashboardActiveTasks(context.tasks);
      const rows = topDashboardGroups(active.map((task) => task.filePath), 10).map((row) => ({ label: row.label.split('/').pop() ?? row.label, value: row.value, detail: `${row.value} active` }));
      context.setBadge(rows.length ? String(rows.length) : null);
      if (!rows.length) { renderDashEmpty(container, 'file-warning', 'No active task hotspots.'); return; }
      renderDashboardBars(container, rows, { palette: 'categorical' });
    },
  });

  registry.register('orphaned-task-notes', {
    title: 'Orphaned task notes',
    icon: 'file-question',
    description: 'Task-note style tasks missing project/parent metadata.',
    defaultSize: 'medium',
    render: (container, config, context) => {
      const folders = (context.settings.taskNoteFolders ?? '').split(',').map((folder) => folder.trim().replace(/^\/+|\/+$/gu, '')).filter(Boolean);
      const tasks = context.tasks.filter((task) => folders.some((folder) => task.filePath.startsWith(`${folder}/`)) && !task.metadata.project && !task.metadata.parentId);
      context.setBadge(tasks.length ? String(tasks.length) : null);
      if (!tasks.length) { renderDashEmpty(container, 'file-question', 'No orphaned task notes detected.'); return; }
      renderDashTaskList(container, tasks, context, dashboardWidgetRowLimit(config, context.autoFit));
    },
  });

  registry.register('waiting-by-person', {
    title: 'Waiting by person',
    icon: 'users',
    description: 'Waiting/follow-up tasks grouped by assignee, reviewer, or team.',
    defaultSize: 'medium',
    render: (container, _config, context) => {
      const labels = filterDashboardActiveTasks(context.tasks).filter((task) => task.metadata.assignee || task.metadata.reviewer || task.metadata.team || task.metadata.followUp).map((task) => task.metadata.assignee ?? task.metadata.reviewer ?? task.metadata.team ?? 'Unassigned');
      const rows = topDashboardGroups(labels, 10).map((row, index) => ({ label: row.label, value: row.value, colorClass: `is-cat-${(index % 8) + 1}` }));
      context.setBadge(rows.length ? String(rows.length) : null);
      if (!rows.length) { renderDashEmpty(container, 'users', 'No person-based waiting items.'); return; }
      renderDashboardBars(container, rows, { palette: 'categorical' });
    },
  });

  registry.register('cost-budget', {
    title: 'Cost / budget',
    icon: 'badge-dollar-sign',
    description: 'Open task costs by project plus total active cost.',
    defaultSize: 'medium',
    render: (container, _config, context) => {
      const totals = new Map<string, number>();
      for (const task of filterDashboardActiveTasks(context.tasks)) {
        if (typeof task.metadata.cost !== 'number') continue;
        const label = dashboardProjectName(task);
        totals.set(label, (totals.get(label) ?? 0) + task.metadata.cost);
      }
      const rows = Array.from(totals.entries()).map(([label, value]) => ({ label, value, detail: `$${value.toFixed(2)}` })).sort((a, b) => b.value - a.value).slice(0, 8);
      context.setBadge(rows.length ? `$${rows.reduce((s, r) => s + r.value, 0).toFixed(0)}` : null);
      if (!rows.length) { renderDashEmpty(container, 'badge-dollar-sign', 'No active task costs found.'); return; }
      renderDashboardBars(container, rows, { palette: 'categorical' });
    },
  });

  registry.register('today', {
    title: 'Agenda',
    icon: 'sun',
    description: 'Overdue work first, then blocked work, dated tasks, recent completions, and backlog.',
    details: 'Agenda is a single reading-order list for the active dashboard scope: overdue tasks are highlighted at the top, blocked/waiting tasks follow, tasks due or scheduled today are sorted by date/time, tomorrow gets its own preview section, Recently done follows the selected scope and is collapsed by default, and the Backlog section holds the remaining unblocked active tasks. Use the standalone Next up widget if you still want an algorithmic recommended-action hero.',
    defaultSize: 'large',
    render: (container, config, context) => {
      renderDashboardToday(container, config, context);
    },
  });

  registry.register('daily-todos', {
    title: 'Daily tasks',
    icon: 'list-checks',
    description: 'Daily-note-friendly list using the note date property: due/scheduled carry-forward plus tasks closed that day.',
    details: 'Designed for embedded daily notes. It reads the containing note frontmatter date property (or dateProperty from the widget block), shows active tasks due on or before that date or scheduled on or before that date, and separately includes tasks completed or cancelled on that exact date. The embedded presentation is intentionally low-chrome so it blends into a daily note.',
    defaultSize: 'large',
    render: (container, config, context) => {
      renderDashboardDailyTodos(container, config, context);
    },
  });

  registry.register('focus-queue', {
    title: 'Next up',
    icon: 'crosshair',
    description: 'A recommended next action plus a short, ranked shortlist of undated work.',
    details: 'A single, flat “do-next” list across every project. It takes all active tasks, drops anything blocked or waiting, and ranks what’s left by due/overdue proximity, priority, pinned status, in-progress state, and quick-win effort. The hero row is the best thing to work on right now. Tasks already dated for the current scope live on the Agenda, so the shortlist below the hero is the undated next-action backlog — it never repeats an agenda row.',
    defaultSize: 'medium',
    render: (container, config, context) => {
      const model = dashboardNextUpModel(context.tasks, context.today, context.scope);
      if (!model.hero) {
        context.setBadge(null);
        renderDashEmpty(container, 'target', 'No clear next actions. Try triaging your inbox or unblocking tasks.', 'Add an active task — or unblock a waiting one — to fill the queue.');
        return;
      }
      context.setBadge(model.badge);
      renderDashNextUpHero(container, model.hero, context);
      if (model.shortlist.length === 0) return;
      container.createDiv({ cls: 'tm-dash-next-up-list-title', text: 'Shortlist' });
      const limit = Math.max(3, Math.min(6, dashboardWidgetRowLimit(config, context.autoFit) - 1));
      renderDashTaskList(container, model.shortlist, context, limit, {
        moreText: `Review all ${formatDashboardCount(model.backlog.length)} next actions`,
        moreAriaLabel: `Show all ${model.backlog.length} next actions`,
      });
    },
  });

  registry.register('blocked-waiting', {
    title: 'Blocked / waiting',
    icon: 'circle-slash',
    description: 'Tasks that are blocked, deferred, waiting, or dependency-bound.',
    defaultSize: 'medium',
    render: (container, config, context) => {
      const tasks = filterDashboardActiveTasks(context.tasks)
        .filter(isDashboardBlockedTask)
        .sort(compareDashboardTasks);
      context.setBadge(tasks.length ? String(tasks.length) : 'Clear');
      if (tasks.length === 0) {
        renderDashEmpty(container, 'unlock', 'No blocked or waiting tasks.', 'Dependencies, waiting status, or future follow-ups land here.');
        return;
      }
      renderDashTaskList(container, tasks, context, dashboardWidgetRowLimit(config, context.autoFit));
    },
  });

  registry.register('inbox-triage', {
    title: 'Inbox triage',
    icon: 'inbox',
    description: 'Raw captured tasks with no date, project, priority, tags, or context yet.',
    details: 'Your pile of raw, unorganized captures — active tasks with no due/scheduled/start date, no project, no tags or context, and default priority. Add any planning metadata and they drop out of triage. Tasks that are otherwise clarified but still have no date move to Needs scheduling instead.',
    defaultSize: 'medium',
    render: (container, config, context) => {
      const tasks = context.tasks.filter(dashboardTaskIsInbox).sort((a, b) => a.filePath.localeCompare(b.filePath) || a.lineNumber - b.lineNumber);
      context.setBadge(tasks.length ? String(tasks.length) : null);
      if (tasks.length === 0) {
        renderDashEmpty(container, 'inbox', 'Inbox is clear — every active task has planning metadata.', 'Only raw captures with no date, project, priority, tags, or context land here. Clarified no-date tasks go to Needs scheduling.');
        return;
      }
      // Capture trend: items added to the inbox this week vs last (by created date). A growing
      // uncaptured pile is a triage backlog, so higher is worse. Only drawn when created dates exist.
      const wow = dashboardWeekOverWeekCount(tasks.map((task) => task.metadata.dates.created).filter((date): date is string => Boolean(date)), context.today);
      const drew = renderDashListTrend(container, 'captured', wow, false);
      const limit = Math.max(3, Math.min(6, dashboardWidgetRowLimit(config, context.autoFit) - (drew ? 1 : 0)));
      renderDashTaskList(container, tasks, context, limit, {
        moreText: `Review all ${formatDashboardCount(tasks.length)} captures`,
        moreAriaLabel: `Show all ${tasks.length} inbox captures`,
      });
    },
  });

  registry.register('eisenhower', {
    title: 'Eisenhower matrix',
    icon: 'grid-2x2',
    description: 'Urgent/important quadrants for deciding what to do, schedule, delegate, or drop.',
    defaultSize: 'large',
    render: (container, config, context) => {
      const active = filterDashboardActiveTasks(context.tasks).sort(compareFocusTasks(context.today));
      context.setBadge(active.length ? String(active.length) : null);
      const quadrants = [
        { title: 'Do now', icon: 'flame', tasks: active.filter((task) => dashboardTaskUrgency(task, context.today) && dashboardTaskImportance(task)) },
        { title: 'Schedule', icon: 'calendar-plus', tasks: active.filter((task) => !dashboardTaskUrgency(task, context.today) && dashboardTaskImportance(task)) },
        { title: 'Delegate / waiting', icon: 'send', tasks: active.filter((task) => dashboardTaskUrgency(task, context.today) && !dashboardTaskImportance(task)) },
        { title: 'Someday / drop', icon: 'archive', tasks: active.filter((task) => !dashboardTaskUrgency(task, context.today) && !dashboardTaskImportance(task)) },
      ];
      const grid = container.createDiv('tm-dash-matrix');
      const perQuadrant = Math.max(2, Math.floor(dashboardWidgetRowLimit(config, context.autoFit) / 2));
      for (const quadrant of quadrants) {
        const cell = grid.createDiv('tm-dash-matrix-cell');
        const header = cell.createDiv('tm-dash-matrix-title');
        const icon = header.createSpan('tm-dash-matrix-icon');
        setIcon(icon, quadrant.icon);
        header.createSpan({ text: `${quadrant.title} (${quadrant.tasks.length})` });
        if (quadrant.tasks.length === 0) cell.createDiv({ cls: 'tm-dash-section-empty', text: 'None' });
        else renderDashTaskList(cell, quadrant.tasks, context, perQuadrant);
      }
    },
  });

  registry.register('workload-project', {
    title: 'Workload by project',
    icon: 'folder-kanban',
    description: 'Active task load and risk grouped by project, tag, or folder.',
    defaultSize: 'medium',
    render: (container, _config, context) => {
      const active = filterDashboardActiveTasks(context.tasks);
      const projects = new Map<string, { active: number; overdue: number; soon: number }>();
      for (const task of active) {
        const name = dashboardProjectName(task);
        const entry = projects.get(name) ?? { active: 0, overdue: 0, soon: 0 };
        entry.active += 1;
        const date = dashboardTaskDate(task);
        if (date && date < context.today) entry.overdue += 1;
        else if (date && date <= dashboardDateAdd(context.today, 7)) entry.soon += 1;
        projects.set(name, entry);
      }
      const rows = Array.from(projects.entries())
        .map(([label, entry]) => ({ label, value: entry.active, detail: `${entry.active} active · ${entry.overdue} overdue · ${entry.soon} soon`, tone: entry.overdue ? 'is-overdue' : entry.soon ? 'is-soon' : '' }))
        .sort((a, b) => b.value - a.value || a.label.localeCompare(b.label))
        .slice(0, 8)
        .map((row, index) => ({ ...row, colorClass: `is-cat-${(index % 8) + 1}` }));
      context.setBadge(rows.length ? String(rows.length) : null);
      if (rows.length === 0) {
        renderDashEmpty(container, 'folder-kanban', 'No active project workload.', 'Tag tasks with 📋 a project to track project workload and health.');
        return;
      }
      renderDashboardBars(container, rows, { palette: 'categorical' });
    },
  });

  registry.register('stale-tasks', {
    title: 'Stale tasks',
    icon: 'clock-alert',
    description: 'Active tasks that appear old, unscheduled, or deferred too long.',
    defaultSize: 'medium',
    render: (container, config, context) => {
      const tasks = filterDashboardActiveTasks(context.tasks)
        .filter((task) => dashboardDateOlderThan(dashboardTaskAgeDate(task), context.today, 30) || (!dashboardTaskDate(task) && dashboardDateOlderThan(task.metadata.dates.created, context.today, 14)))
        .sort((a, b) => (dashboardTaskAgeDate(a) ?? '9999-99-99').localeCompare(dashboardTaskAgeDate(b) ?? '9999-99-99'));
      context.setBadge(tasks.length ? String(tasks.length) : null);
      if (tasks.length === 0) {
        renderDashEmpty(container, 'badge-check', 'No stale tasks detected.');
        return;
      }
      renderDashTaskList(container, tasks, context, dashboardWidgetRowLimit(config, context.autoFit));
    },
  });

  registry.register('recently-completed', {
    title: 'Recently completed',
    icon: 'trophy',
    description: 'Recent wins from completed tasks and completion logs.',
    details: 'Recent follows the dashboard scope: Today shows tasks completed today, Week shows the trailing 7 days, and Month shows completions in the current calendar month. The list is newest first; completed tasks without a done date are not included because the dashboard cannot tell when they were finished.',
    defaultSize: 'medium',
    render: (container, config, context) => {
      const tasks = filterDashboardRecentlyCompletedTasks(context.tasks, context.today, context.scope);
      context.setBadge(tasks.length ? String(tasks.length) : null);
      if (tasks.length === 0) {
        renderDashEmpty(container, 'trophy', `No completed tasks with done dates in ${context.scope === 'today' ? 'Today' : context.scope === 'week' ? 'the last 7 days' : 'this month'}.`, 'Complete a task with a ✅ done date to see it celebrated here.');
        return;
      }
      renderDashTaskList(container, tasks, context, dashboardWidgetRowLimit(config, context.autoFit));
    },
  });

  registry.register('effort-forecast', {
    title: 'Effort forecast',
    icon: 'sigma',
    description: 'Estimated effort due today and this week, compared with recent logged time.',
    defaultSize: 'small',
    render: (container, _config, context) => {
      const active = filterDashboardActiveTasks(context.tasks);
      const dueToday = active.filter((task) => dashboardTaskDate(task) === context.today).reduce((sum, task) => sum + dashboardEffortMinutes(task), 0);
      const weekEnd = dashboardDateAdd(context.today, 7);
      const dueWeek = active.filter((task) => {
        const date = dashboardTaskDate(task);
        return Boolean(date && date >= context.today && date <= weekEnd);
      }).reduce((sum, task) => sum + dashboardEffortMinutes(task), 0);
      const estimated = active.reduce((sum, task) => sum + dashboardEffortMinutes(task), 0);
      const stats = container.createDiv('tm-dash-stat-tiles tm-dash-stat-tiles--wide');
      const add = (label: string, value: string): void => {
        const tile = stats.createDiv('tm-dash-stat-tile');
        tile.createDiv({ cls: 'tm-dash-stat-value', text: value });
        tile.createDiv({ cls: 'tm-dash-stat-label', text: label });
      };
      add('Today', formatDashboardMinutes(dueToday));
      add('7 days', formatDashboardMinutes(dueWeek));
      add('All active', formatDashboardMinutes(estimated));
      add('Estimated tasks', formatDashboardCount(active.filter((task) => dashboardEffortMinutes(task) > 0).length));
      context.setBadge(dueWeek ? formatDashboardMinutes(dueWeek) : null);
    },
  });

  registry.register('review-queue', {
    title: 'Review queues',
    icon: 'clipboard-list',
    description: 'Grouped cleanup queues for triage, scheduling, blockers, and stale tasks.',
    defaultSize: 'large',
    render: (container, config, context) => {
      const queues = dashboardReviewQueues(context.tasks, context.today);
      const total = queues.reduce((sum, queue) => sum + queue.tasks.length, 0);
      context.setBadge(total ? String(total) : 'Clear');

      const summary = container.createDiv('tm-dash-review-queue-summary');
      for (const queue of queues) {
        const tile = summary.createDiv({ cls: `tm-dash-review-queue-tile is-${queue.tone}${queue.tasks.length === 0 ? ' is-clear' : ''}` });
        setIcon(tile.createSpan('tm-dash-review-queue-icon'), queue.tasks.length === 0 ? 'check-circle-2' : queue.icon);
        const body = tile.createSpan('tm-dash-review-queue-body');
        body.createSpan({ cls: 'tm-dash-review-queue-value', text: formatDashboardCount(queue.tasks.length) });
        body.createSpan({ cls: 'tm-dash-review-queue-label', text: queue.label });
        tile.createSpan({ cls: 'tm-dash-review-queue-hint', text: queue.tasks.length ? queue.hint : 'clear' });
      }

      if (total === 0) {
        renderDashEmpty(container, 'badge-check', 'Review queues are clear.', 'Captured, unscheduled, blocked, and stale tasks will appear here.');
        return;
      }

      const groups = container.createDiv('tm-dash-review-queue-groups');
      const populated = dashboardReviewQueueGroups(queues);
      const perGroup = Math.max(1, Math.min(3, Math.floor(dashboardWidgetRowLimit(config, context.autoFit) / Math.max(1, populated.length))));
      for (const queue of populated) {
        const group = groups.createDiv('tm-dash-review-queue-group');
        const head = group.createDiv('tm-dash-review-queue-group-head');
        setIcon(head.createSpan('tm-dash-review-queue-group-icon'), queue.icon);
        head.createSpan({ cls: 'tm-dash-review-queue-group-title', text: queue.label });
        head.createSpan({ cls: 'tm-dash-review-queue-group-count', text: formatDashboardCount(queue.tasks.length) });
        renderDashTaskList(group, queue.tasks, context, perGroup, {
          moreText: `Review all ${formatDashboardCount(queue.tasks.length)} ${queue.label.toLowerCase()}`,
          moreAriaLabel: `Show all ${queue.tasks.length} ${queue.label.toLowerCase()} tasks`,
        });
      }
    },
  });

  registry.register('dependencies', {
    title: 'Dependencies',
    icon: 'git-branch',
    description: 'Tasks that block other tasks, plus unresolved dependency references.',
    defaultSize: 'medium',
    render: (container, config, context) => {
      const relationships = dashboardRelationshipIndex(context.tasks);
      const byId = relationships.byId;
      const blockedCounts = new Map<string, number>();
      let unresolved = 0;
      for (const task of filterDashboardActiveTasks(context.tasks)) {
        for (const dep of task.metadata.dependsOn) {
          if (byId.has(dep)) blockedCounts.set(dep, (blockedCounts.get(dep) ?? 0) + 1);
          else unresolved += 1;
        }
      }
      const blockers = Array.from(blockedCounts.entries())
        .map(([id, count]) => ({ task: byId.get(id), count }))
        .filter((entry): entry is { task: ParsedTask; count: number } => Boolean(entry.task))
        .sort((a, b) => b.count - a.count);
      context.setBadge(blockers.length + unresolved ? String(blockers.length + unresolved) : null);
      if (blockers.length === 0 && unresolved === 0) {
        renderDashEmpty(container, 'git-branch', 'No dependency bottlenecks detected.');
        return;
      }
      if (unresolved > 0) container.createDiv({ cls: 'tm-dash-warning', text: `${unresolved} unresolved dependency reference${unresolved === 1 ? '' : 's'}.` });
      renderDashTaskList(container, blockers.map((entry) => entry.task), context, dashboardWidgetRowLimit(config, context.autoFit));
    },
  });

  registry.register('follow-up', {
    title: 'Follow-up',
    icon: 'eye',
    description: 'Tasks with follow-up dates, waiting status, assignees, or reviewers.',
    defaultSize: 'medium',
    render: (container, config, context) => {
      const tasks = filterDashboardActiveTasks(context.tasks)
        .filter((task) => Boolean(task.metadata.followUp || task.metadata.assignee || task.metadata.reviewer || task.status === 'blocked'))
        .sort((a, b) => (a.metadata.followUp ?? '9999-99-99').localeCompare(b.metadata.followUp ?? '9999-99-99') || compareDashboardTasks(a, b));
      context.setBadge(tasks.length ? String(tasks.length) : null);
      if (tasks.length === 0) {
        renderDashEmpty(container, 'eye', 'No follow-ups or waiting handoffs.', 'Add a 👁️ reviewer or an @waiting context to track handoffs.');
        return;
      }
      renderDashTaskList(container, tasks, context, dashboardWidgetRowLimit(config, context.autoFit));
    },
  });

  registry.register('priority-distribution', {
    title: 'Priority distribution',
    icon: 'arrow-up-narrow-wide',
    description: 'Active tasks by priority, highlighting urgent concentration.',
    defaultSize: 'small',
    render: (container, _config, context) => {
      const active = filterDashboardActiveTasks(context.tasks);
      const priorities = ['highest', 'high', 'medium', 'normal', 'low', 'lowest'];
      const rows = priorities.map((priority) => ({ label: priority, priority, value: active.filter((task) => task.metadata.priority === priority).length }));
      context.setBadge(active.length ? String(active.length) : null);
      renderDashboardBars(container, rows, { palette: 'priority' });
    },
  });

  registry.register('contexts-hotspots', {
    title: 'Contexts / tags',
    icon: 'tags',
    description: 'Top contexts and tags across active tasks.',
    defaultSize: 'medium',
    render: (container, _config, context) => {
      const active = filterDashboardActiveTasks(context.tasks);
      const labels = active.flatMap((task) => [...task.contexts.map((ctx) => `@${ctx}`), ...task.tags.map((tag) => `#${tag}`)]);
      const rows = topDashboardGroups(labels, 10).map((row, index) => ({ label: row.label, value: row.value, colorClass: `is-cat-${(index % 8) + 1}` }));
      context.setBadge(rows.length ? String(rows.length) : null);
      if (rows.length === 0) {
        renderDashEmpty(container, 'tags', 'No tags or contexts found on active tasks.', 'Add #tags or @contexts to your tasks to map them here.');
        return;
      }
      renderDashboardBars(container, rows, { palette: 'categorical' });
    },
  });

  registry.register('completion-heatmap', {
    title: 'Completion heatmap',
    icon: 'grid-3x3',
    description: 'Task completions over the last five weeks.',
    defaultSize: 'medium',
    render: async (container, _config, context) => {
      const start = dashboardDateAdd(context.today, -34);
      const counts = new Map<string, number>();
      for (const task of context.tasks) {
        const done = task.metadata.dates.done;
        if (task.status === 'done' && done && done >= start && done <= context.today) counts.set(done, (counts.get(done) ?? 0) + 1);
      }
      const state = await context.stateStore?.loadState();
      for (const completion of state?.completions ?? []) {
        const date = completion.completedAtIso.slice(0, 10);
        if (date >= start && date <= context.today) counts.set(date, Math.max(counts.get(date) ?? 0, 1));
      }
      context.setBadge(String(Array.from(counts.values()).reduce((sum, value) => sum + value, 0)));
      const max = Math.max(1, ...counts.values());
      const grid = container.createDiv('tm-dash-heatmap');
      grid.setAttr('role', 'list');
      grid.setAttr('aria-label', t('dashboard.a11y.completionHeatmap'));
      for (let i = 0; i < 35; i += 1) {
        const date = dashboardDateAdd(start, i);
        const value = counts.get(date) ?? 0;
        const label = `${date}: ${value} completed`;
        const cell = grid.createDiv({ cls: `tm-dash-heatmap-cell tm-dash-heatmap-l${Math.ceil((value / max) * 4)}` });
        cell.setAttr('role', 'listitem');
        cell.setAttr('title', label);
        cell.setAttr('aria-label', label);
      }
      renderDashboardInsight(container, 'palette', 'Darker cells mean more completions; labels are available on hover and to assistive technology.', 'neutral');
    },
  });

  registry.register('sync-activity', {
    title: 'Sync activity',
    icon: 'history',
    description: 'Recent external sync runs, failures, and partial results.',
    defaultSize: 'medium',
    render: (container, _config, context) => {
      const runs = [...(context.settings.syncRunHistory ?? [])].slice(0, 8);
      context.setBadge(runs.length ? String(runs.length) : null);
      if (runs.length === 0) {
        renderDashEmpty(container, 'activity', 'No sync activity recorded yet.');
        return;
      }
      const list = container.createDiv('tm-dash-services');
      for (const run of runs) {
        const tone = run.outcome === 'failed' ? 'is-error' : run.outcome === 'partial' ? 'is-warn' : 'is-ok';
        const item = list.createDiv('tm-dash-service');
        item.createSpan({ cls: `tm-dash-dot ${tone}` });
        item.createSpan({ cls: 'tm-dash-service-name', text: run.service });
        item.createSpan({ cls: 'tm-dash-service-state', text: `${run.outcome} · ${run.endedAt.slice(5, 16).replace('T', ' ')}` });
      }
    },
  });

  registry.register('agenda', {
    title: 'Agenda',
    icon: 'calendar-check',
    description: 'Overdue, due, scheduled, or starting tasks for the selected scope — overdue pinned on top.',
    details: 'A date-driven view: every active task with a due, scheduled, or start (🛫) date that falls on or before the end of the current scope window (today, this week, etc.), sorted by the soonest of those dates. In date order it groups into Overdue, Today, and Upcoming, with overdue pinned at the top — this is where overdue tasks live, so there is no separate Overdue card. Start-only tasks show a muted “Start …” chip. Drag rows to arrange the agenda by hand — it switches to that manual order until you hit “Date order”. Tasks with no date never appear here — use Next up for those.',
    defaultSize: 'large',
    render: (container, config, context) => {
      renderDashboardAgenda(container, config, context);
    },
  });

  registry.register('upcoming', {
    title: 'Upcoming',
    icon: 'calendar-days',
    description: 'The next seven days, grouped by day.',
    defaultSize: 'medium',
    render: (container, config, context) => {
      const tasks = filterDashboardUpcomingTasks(context.tasks, context.today, 7)
        .filter((task) => (dashboardTaskDate(task) ?? '') > context.today)
        .sort(compareDashboardTasks);
      context.setBadge(tasks.length ? String(tasks.length) : null);
      if (tasks.length === 0) {
        renderDashEmpty(container, 'calendar-days', 'No tasks scheduled for the next 7 days.', 'Add a 📅 due or ⏳ scheduled date within the next week to a task.');
        return;
      }
      const groups = new Map<string, ParsedTask[]>();
      for (const task of tasks) {
        const date = dashboardTaskDate(task) ?? context.today;
        const bucket = groups.get(date) ?? [];
        bucket.push(task);
        groups.set(date, bucket);
      }
      const limit = dashboardWidgetRowLimit(config, context.autoFit);
      let shown = 0;
      const wrapper = container.createDiv('tm-dash-groups');
      for (const [date, bucket] of Array.from(groups.entries()).sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        if (shown >= limit) break;
        const rel = dashboardRelativeDate(date, context.today);
        wrapper.createDiv({ cls: 'tm-dash-group-label', text: rel.label });
        const remaining = bucket.slice(0, Math.max(1, limit - shown));
        renderDashTaskList(wrapper, remaining, context, remaining.length);
        shown += remaining.length;
      }
    },
  });

  registry.register('overdue-risk', {
    title: 'Overdue',
    icon: 'alert-triangle',
    description: 'Active tasks past their due date.',
    defaultSize: 'medium',
    render: (container, config, context) => {
      const overdue = filterDashboardOverdueTasks(context.tasks, context.today).sort(compareDashboardTasks);
      context.setBadge(overdue.length ? String(overdue.length) : 'Clear');
      if (overdue.length === 0) {
        renderDashEmpty(container, 'shield-check', 'No overdue tasks. Nicely done.');
        return;
      }
      // Aging trend: how much of the overdue pile became overdue this week vs the prior week
      // (grouped by each task's due date). Growing inflow is bad, so higher is worse.
      const wow = dashboardWeekOverWeekCount(overdue.map((task) => task.metadata.dates.due).filter((date): date is string => Boolean(date)), context.today);
      const drew = renderDashListTrend(container, 'newly overdue', wow, false);
      renderDashTaskList(container, overdue, context, Math.max(1, dashboardWidgetRowLimit(config, context.autoFit) - (drew ? 1 : 0)));
    },
  });

  registry.register('stats', {
    title: 'Summary',
    icon: 'pie-chart',
    description: 'Actionable counts and review queue totals for the selected Today / Week / Month scope.',
    details: 'A scoped daily status card: the ring shows done/planned work in the active Today / Week / Month window, while the tiles emphasize what matters operationally — agenda, due, overdue, and review queues such as triage, scheduling, blocked, and stale work. XP and level live only in the optional Momentum widget.',
    defaultSize: 'small',
    render: (container, _config, context) => {
      const glance = dashboardGlanceStats(context.tasks, context.today, context.scope);
      const agendaCount = filterDashboardAgendaTasks(context.tasks, context.today, context.scope).length;
      const queues = dashboardReviewQueues(context.tasks, context.today);
      context.setBadge(null);

      const wrap = container.createDiv('tm-dash-stats tm-dash-stats--hero tm-dash-today');
      // When nothing is planned (or done) in the window yet, a big bold "0" in an accent-coloured ring
      // reads as a failure state for what is really just an empty slate. Soften it to a muted dash.
      const planned = glance.plannedTotal > 0;
      const ringWrap = wrap.createDiv(`tm-dash-ring${!planned ? ' is-empty' : glance.rate >= 80 ? ' is-good' : ''}`);
      ringWrap.style.setProperty('--tm-dash-ring-value', `${planned ? glance.rate : 0}`);
      ringWrap.createDiv({ cls: 'tm-dash-ring-value', text: planned ? `${formatDashboardCount(glance.plannedDone)}/${formatDashboardCount(glance.plannedTotal)}` : '–' });
      ringWrap.setAttr('aria-label', planned
        ? `${formatDashboardCount(glance.plannedDone)} of ${formatDashboardCount(glance.plannedTotal)} planned ${glance.windowLabel.toLowerCase()} tasks complete`
        : `No planned ${glance.windowLabel.toLowerCase()} tasks yet`);

      const head = wrap.createDiv('tm-dash-hero');
      head.createDiv({ cls: 'tm-dash-hero-label', text: `${glance.windowLabel} at a glance` });
      const trend = head.createDiv('tm-dash-hero-trend');
      trend.createDiv({ cls: 'tm-dash-hero-trend-count', text: `${formatDashboardCount(glance.completedInWindow)} done ${glance.windowAdverb}` });
      const reviewTotal = queues.reduce((sum, queue) => sum + queue.tasks.length, 0);
      trend.createDiv({ cls: 'tm-dash-hero-trend-delta', text: `${formatDashboardCount(agendaCount)} agenda · ${formatDashboardCount(reviewTotal)} review` });

      const tiles = wrap.createDiv('tm-dash-stat-tiles');
      // Two rows: the primary row keeps the "act on it now" counts (Due, Blocked, Stale) while the
      // larger grooming queues (Triage, Schedule) get their own row so the operational counts stay
      // uncluttered and scannable.
      const primaryRow = tiles.createDiv('tm-dash-stat-row');
      const secondaryRow = tiles.createDiv('tm-dash-stat-row');
      const addTile = (row: HTMLElement, label: string, value: number | string, modifier = ''): void => {
        const tile = row.createDiv({ cls: `tm-dash-stat-tile${modifier ? ` ${modifier}` : ''}` });
        tile.createDiv({ cls: 'tm-dash-stat-value', text: typeof value === 'number' ? formatDashboardCount(value) : value });
        tile.createDiv({ cls: 'tm-dash-stat-label', text: label });
      };
      // Agenda and Overdue counts already headline the adjacent Agenda card (its badge, its OVERDUE
      // section, and this card's own hero line: "N agenda · M review"). Repeating them as tiles is pure
      // duplication, so the tiles focus on the review-queue reservoir that is unique to this card.
      // Zero-valued tiles are de-emphasised so the counts that matter actually stand out.
      const secondaryKeys = new Set<DashboardReviewQueueKey>(['triage', 'schedule']);
      addTile(primaryRow, 'Due', glance.dueInWindow, glance.dueInWindow ? 'is-soon' : 'is-zero');
      for (const queue of queues) {
        const row = secondaryKeys.has(queue.key) ? secondaryRow : primaryRow;
        addTile(row, queue.label, queue.tasks.length, queue.tasks.length ? `is-review-${queue.key}` : 'is-zero');
      }
      if (!secondaryRow.childElementCount) secondaryRow.remove();
    },
  });

  registry.register('habits', {
    title: 'Habits',
    icon: 'repeat',
    description: 'Recurring habit streaks.',
    defaultSize: 'medium',
    render: async (container, _config, context) => {
      const state = await context.stateStore?.loadState();
      const tracker = new HabitTracker(context.app, () => context.settings, () => state?.habitCompletions ?? {});
      const habits = filterDashboardActiveHabits(tracker.identifyHabits(context.tasks));
      context.setBadge(habits.length ? String(habits.length) : null);
      if (habits.length === 0) {
        renderDashEmpty(container, 'repeat', 'No habits yet.', 'Tag a recurring task with #habit to start tracking streaks.');
        return;
      }
      const history = await tracker.buildCompletionHistory(habits);
      const habitsEl = container.createDiv('tm-dash-habits');
      renderHabitTracker(habitsEl, habits, history, context.today, (habit) => {
        const file = context.app.vault.getAbstractFileByPath(habit.filePath);
        if (!(file instanceof TFile)) return;
        void updateDashboardTaskCheckbox(file, habit, checkboxForStatus('done', context.settings.supportedStates), context)
          .then(() => context.requestTaskRefresh());
      });
    },
  });

  registry.register('calendar-mini', {
    title: 'Calendar',
    icon: 'calendar',
    description: 'A compact month calendar of upcoming work.',
    defaultSize: 'large',
    render: (container, _config, context) => {
      const upcoming = filterDashboardUpcomingTasks(context.tasks, context.today, 35);
      context.setBadge(null);
      const calendarEl = container.createDiv('tm-dash-calendar');
      return renderCalendar(calendarEl, upcoming, parseTaskQuery('not done'), context.settings, async () => {}, () => {});
    },
  });

  registry.register('kanban-mini', {
    title: 'Board',
    icon: 'columns-3',
    description: 'A status board of active tasks.',
    defaultSize: 'large',
    render: (container, _config, context) => {
      const tasks = filterDashboardActiveTasks(context.tasks);
      context.setBadge(tasks.length ? String(tasks.length) : null);
      const boardEl = container.createDiv('tm-dash-kanban');
      const updateCheckbox = async (task: ParsedTask, checkbox: string): Promise<void> => {
        const file = context.app.vault.getAbstractFileByPath(task.filePath);
        if (!(file instanceof TFile)) {
          new Notice('Task Manager: source file not found for dashboard task.');
          return;
        }
        await updateDashboardTaskCheckbox(file, task, checkbox, context);
        context.requestTaskRefresh();
      };
      renderKanban(
        boardEl,
        tasks,
        parseTaskQuery('not done'),
        context.settings,
        async (task) => updateCheckbox(task, cycleTaskCheckbox(task.checkbox, context.settings.supportedStates)),
        () => {},
        updateCheckbox,
        undefined,
        { taskText: dashboardTaskDisplayText },
      );
    },
  });

  registry.register('saved-query', {
    title: 'Custom query',
    icon: 'filter',
    description: 'Render any Task Manager query as a list.',
    defaultSize: 'medium',
    render: (container, config, context) => {
      const query = config.query?.trim();
      if (!query) {
        renderDashEmpty(container, 'filter', 'No query yet.', 'Open the card menu → Configure to add a Task Manager query.');
        context.setBadge(null);
        return;
      }
      try {
        const options = dashboardQueryOptions(context.settings);
        const parsed = parseTaskQuery(query, options);
        const filtered = filterTasks(context.tasks, parsed, options);
        context.setBadge(filtered.length ? String(filtered.length) : null);
        if (filtered.length === 0) {
          renderDashEmpty(container, 'search-x', 'No tasks match this query.');
          return;
        }
        renderDashTaskList(container, filtered, context, dashboardWidgetRowLimit(config, context.autoFit));
      } catch {
        context.setBadge(null);
        renderDashEmpty(container, 'alert-circle', 'This query could not be parsed.');
      }
    },
  });

  registry.register('sync-health', {
    title: 'Sync health',
    icon: 'refresh-cw',
    description: 'Status of connected sync services.',
    defaultSize: 'small',
    render: (container, _config, context) => {
      const settings = context.settings;
      const services: Array<{ name: string; enabled: boolean }> = [
        { name: 'Todoist', enabled: settings.todoistSyncEnabled },
        { name: 'Microsoft To Do', enabled: settings.msToDoEnabled },
        { name: 'Google Tasks', enabled: settings.googleTasksEnabled },
        { name: 'Google Calendar', enabled: settings.googleCalendarEnabled },
        { name: 'CalDAV', enabled: settings.caldavSyncEnabled },
        { name: 'Apple Reminders', enabled: settings.appleRemindersEnabled },
      ];
      const enabled = services.filter((service) => service.enabled);
      context.setBadge(enabled.length ? String(enabled.length) : null);

      if (enabled.length === 0) {
        renderDashEmpty(container, 'plug', 'No sync services connected.');
        return;
      }
      const lastRunByService = new Map<string, string>();
      for (const run of settings.syncRunHistory ?? []) {
        if (!lastRunByService.has(run.service)) lastRunByService.set(run.service, run.outcome);
      }
      const list = container.createDiv('tm-dash-services');
      for (const service of enabled) {
        const outcome = lastRunByService.get(service.name);
        const tone = outcome === 'failed' ? 'is-error' : outcome === 'partial' ? 'is-warn' : 'is-ok';
        const item = list.createDiv('tm-dash-service');
        item.createSpan({ cls: `tm-dash-dot ${tone}` });
        item.createSpan({ cls: 'tm-dash-service-name', text: service.name });
        item.createSpan({ cls: 'tm-dash-service-state', text: outcome ? outcome : 'connected' });
      }
    },
  });

  registry.register('pomodoro', {
    title: 'Focus timer',
    icon: 'timer',
    description: 'A pomodoro timer that logs time sessions.',
    defaultSize: 'small',
    live: true,
    render: (container, _config, context) => {
      const workMinutes = context.settings.pomodoroWorkMinutes;
      const tasks = filterDashboardActiveTasks(context.tasks).slice(0, 25);
      context.setBadge(null);
      let selectedTask: ParsedTask | undefined = tasks.find((task) => task.status === 'in_progress') ?? tasks[0];
      let remainingSeconds = workMinutes * 60;
      let intervalId: number | null = null;
      let startedAtMs = 0;
      let accumulatedMs = 0;
      let isUnmounted = false;

      const wrapper = container.createDiv('tm-dash-pomodoro');
      const taskSelect = wrapper.createEl('select', { cls: 'tm-dash-pomodoro-select dropdown' });
      for (const task of tasks) {
        const option = taskSelect.createEl('option', { text: dashboardTaskDisplayText(task), value: task.key });
        if (selectedTask?.key === task.key) option.selected = true;
      }
      if (tasks.length === 0) {
        taskSelect.createEl('option', { text: 'No active tasks', value: '' });
        taskSelect.disabled = true;
      }
      const timeEl = wrapper.createDiv('tm-dash-pomodoro-time');
      const statusEl = wrapper.createDiv('tm-dash-pomodoro-status');
      const buttons = wrapper.createDiv('tm-dash-pomodoro-btns');
      const startBtn = buttons.createEl('button', { text: 'Start', cls: 'mod-cta' });
      const pauseBtn = buttons.createEl('button', { text: 'Pause' });
      const completeBtn = buttons.createEl('button', { text: 'Done' });
      pauseBtn.disabled = true;
      completeBtn.disabled = true;

      const renderTime = (): void => { timeEl.setText(formatPomodoroSeconds(remainingSeconds)); };
      const stopTimer = (): void => {
        if (intervalId !== null) {
          window.clearInterval(intervalId);
          intervalId = null;
        }
      };
      const recordSession = async (): Promise<void> => {
        const taskToRecord = selectedTask;
        const stateStore = context.stateStore;
        if (!taskToRecord || !stateStore) return;
        const endedAt = new Date();
        const timing = calculatePomodoroSessionTiming(startedAtMs, accumulatedMs, endedAt.getTime());
        if (!timing) return;
        const elapsedMinutes = Math.max(1, timing.elapsedMs / 60000);
        const session = createPomodoroTimeSession(taskToRecord, new Date(timing.startedAtMs).toISOString(), endedAt.toISOString(), elapsedMinutes);
        await stateStore.updateState((state) => stateStore.appendTimeSession(state, session));
        statusEl.setText(`Logged ${session.elapsedMinutes}m.`);
      };

      taskSelect.addEventListener('change', () => {
        selectedTask = tasks.find((task) => task.key === taskSelect.value);
      });
      startBtn.addEventListener('click', () => {
        if (!selectedTask) {
          statusEl.setText('Choose an active task first.');
          return;
        }
        startedAtMs = Date.now();
        startBtn.disabled = true;
        pauseBtn.disabled = false;
        completeBtn.disabled = false;
        statusEl.setText('Running…');
        intervalId = window.setInterval(() => {
          if (isUnmounted) {
            stopTimer();
            return;
          }
          remainingSeconds -= 1;
          renderTime();
          if (remainingSeconds <= 0) {
            stopTimer();
            void recordSession();
            accumulatedMs = 0;
            startBtn.disabled = false;
            pauseBtn.disabled = true;
            completeBtn.disabled = true;
            remainingSeconds = workMinutes * 60;
            renderTime();
          }
        }, 1000);
      });
      pauseBtn.addEventListener('click', () => {
        accumulatedMs += Date.now() - startedAtMs;
        startedAtMs = 0;
        stopTimer();
        startBtn.disabled = false;
        pauseBtn.disabled = true;
        statusEl.setText('Paused.');
      });
      completeBtn.addEventListener('click', () => {
        stopTimer();
        void recordSession();
        accumulatedMs = 0;
        startBtn.disabled = false;
        pauseBtn.disabled = true;
        completeBtn.disabled = true;
        remainingSeconds = workMinutes * 60;
        renderTime();
      });
      renderTime();
      return () => {
        isUnmounted = true;
        stopTimer();
      };
    },
  });

  // ── Tier 1: analytics engines surfaced as cards ───────────────────────────

  registry.register('today-schedule', {
    title: 'Today’s schedule',
    icon: 'calendar-clock',
    description: 'An hour-ordered timeline of today’s timed tasks and calendar events, with untimed work listed below.',
    defaultSize: 'large',
    render: async (container, config, context) => {
      let events: CalendarIcsEvent[] = [];
      try { events = (await context.fetchIcsEvents?.()) ?? []; } catch { events = []; }
      const { timed, untimed, allDayEvents } = dashboardScheduleForDay(context.tasks, context.today, events);
      const total = timed.length + untimed.length;
      context.setBadge(total ? String(total) : null);
      if (total === 0 && allDayEvents.length === 0) {
        renderDashEmpty(container, 'calendar-clock', 'Nothing scheduled for today. Add a time (⏰ 9:00) or a due/scheduled date.');
        return;
      }
      if (allDayEvents.length) {
        const allDay = container.createDiv('tm-dash-schedule-allday');
        for (const summary of allDayEvents.slice(0, 4)) {
          const chip = allDay.createSpan('tm-dash-schedule-allday-chip');
          setIcon(chip.createSpan('tm-dash-schedule-allday-icon'), 'calendar');
          chip.createSpan({ text: summary });
        }
      }
      if (timed.length) {
        const overlaps = new Set<DashboardScheduleEntry>();
        for (const [a, b] of dashboardScheduleOverlaps(timed)) { overlaps.add(a); overlaps.add(b); }
        const list = container.createDiv('tm-dash-schedule');
        for (const entry of timed) {
          const row = list.createDiv({ cls: `tm-dash-schedule-row tm-dash-schedule-row--${entry.kind}${overlaps.has(entry) ? ' is-conflict' : ''}` });
          const time = row.createDiv('tm-dash-schedule-time');
          time.createSpan({ cls: 'tm-dash-schedule-start', text: dashboardFormatClock(entry.start) });
          time.createSpan({ cls: 'tm-dash-schedule-end', text: dashboardFormatClock(entry.end) });
          const body = row.createDiv('tm-dash-schedule-body');
          setIcon(body.createSpan('tm-dash-schedule-icon'), entry.kind === 'event' ? 'calendar' : 'circle-dot');
          const label = body.createSpan({ cls: 'tm-dash-schedule-label', text: entry.label });
          label.setAttr('title', entry.label);
          const task = entry.task;
          if (task) {
            label.setAttr('role', 'button');
            label.setAttr('tabindex', '0');
            label.addEventListener('click', () => { void context.openTask(task); });
            label.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void context.openTask(task); } });
          }
        }
      }
      if (untimed.length) {
        renderDashboardSection(container, `Untimed today (${untimed.length})`, untimed, context, Math.max(3, dashboardWidgetRowLimit(config, context.autoFit) - timed.length));
      }
    },
  });

  registry.register('capacity-planner', {
    title: 'Capacity planner',
    icon: 'gauge',
    description: 'Committed estimated effort vs. your available focus capacity for each of the next 7 days.',
    defaultSize: 'medium',
    render: (container, _config, context) => {
      const capacity = context.settings.dashboardCapacityMinutes ?? 360;
      const series = dashboardCapacitySeries(context.tasks, context.today, capacity, 7);
      const overloaded = series.filter((day) => day.over).length;
      context.setBadge(overloaded ? `${overloaded} over` : null);
      if (series.every((day) => day.committed === 0)) {
        renderDashEmpty(container, 'gauge', 'No estimated effort scheduled.', 'Add ⏱️ estimates and due/scheduled dates to compare work against daily focus capacity.');
        return;
      }
      container.createDiv({ cls: 'tm-dash-section-title', text: `Capacity ${formatDashboardMinutes(capacity)}/day` });
      renderDashboardBars(container, series.map((day) => ({
        label: day.label,
        value: Math.round(percent(day.committed, day.capacity)),
        detail: `${formatDashboardMinutes(day.committed)} / ${formatDashboardMinutes(day.capacity)}`,
        tone: day.over ? 'is-overdue' : day.committed >= day.capacity * 0.8 ? 'is-soon' : '',
      })), { palette: 'severity' });
      renderDashboardInsight(container, overloaded ? 'alert-triangle' : 'badge-check', overloaded ? `${overloaded} day${overloaded === 1 ? '' : 's'} over capacity — reschedule or reduce scope.` : 'Within capacity for the next 7 days.', overloaded ? 'risk' : 'good');
    },
  });

  registry.register('burndown', {
    title: 'Burndown',
    icon: 'trending-down',
    description: 'Remaining open tasks over the last 14 days, reconstructed from created and completion dates.',
    defaultSize: 'medium',
    render: (container, _config, context) => {
      const series = dashboardBurndownSeries(context.tasks, context.today, 14);
      const current = series[series.length - 1]?.remaining ?? 0;
      const start = series[0]?.remaining ?? 0;
      const delta = current - start;
      context.setBadge(String(current));
      const summary = container.createDiv('tm-dash-throughput-summary');
      summary.createSpan({ cls: 'tm-dash-throughput-avg', text: `${current} open` });
      const trendEl = summary.createSpan({ cls: `tm-dash-throughput-trend ${delta <= 0 ? 'is-up' : 'is-down'}` });
      trendEl.setText(`${delta <= 0 ? '↓' : '↑'} ${Math.abs(delta)} in 14d`);
      renderDashboardInsight(container, delta <= 0 ? 'trending-down' : 'trending-up', delta <= 0 ? 'Down is good: open work is shrinking.' : 'Open work is growing: check scope and stale work.', delta <= 0 ? 'good' : 'risk');
      const max = Math.max(1, ...series.map((point) => point.remaining));
      const chart = container.createDiv(`tm-dash-sparkbars ${delta <= 0 ? 'is-good' : 'is-risk'}`);
      for (const point of series) {
        const col = chart.createDiv('tm-dash-sparkbar');
        col.setAttr('title', `${point.date}: ${point.remaining} open`);
        col.createDiv('tm-dash-sparkbar-fill').style.height = `${Math.max(4, Math.round((point.remaining / max) * 100))}%`;
      }
      const axis = container.createDiv('tm-dash-sparkbars-axis');
      axis.createSpan({ text: series[0]?.label ?? '' });
      axis.createSpan({ text: 'Today' });
    },
  });

  registry.register('completion-forecast', {
    title: 'Completion forecast',
    icon: 'calendar-check-2',
    description: 'Projected date the active backlog clears at your recent completion velocity.',
    defaultSize: 'small',
    render: async (container, _config, context) => {
      const state = await context.stateStore?.loadState();
      const completions = (state?.completions ?? []).map((completion) => completion.completedAtIso.slice(0, 10));
      const forecast = dashboardCompletionForecast(context.tasks, context.today, completions);
      context.setBadge(forecast.etaIso ? dashboardShortDate(forecast.etaIso) : null);
      const trend = forecast.weeksToClear == null ? 'No velocity yet' : `${forecast.weeksToClear} week${forecast.weeksToClear === 1 ? '' : 's'} left`;
      renderDashboardHero(container, forecast.etaIso ? dashboardShortDate(forecast.etaIso) : '—', 'Backlog ETA', trend, forecast.weeksToClear == null ? 'down' : 'neutral');
      const tiles = container.createDiv('tm-dash-stat-tiles tm-dash-stat-tiles--wide');
      const addTile = (label: string, value: string, modifier = ''): void => {
        const tile = tiles.createDiv({ cls: `tm-dash-stat-tile${modifier ? ` ${modifier}` : ''}` });
        tile.createDiv({ cls: 'tm-dash-stat-value', text: value });
        tile.createDiv({ cls: 'tm-dash-stat-label', text: label });
      };
      addTile('Backlog', formatDashboardCount(forecast.backlog));
      addTile('Velocity', `${forecast.perWeek}/wk`);
      addTile('Weeks left', forecast.weeksToClear != null ? String(forecast.weeksToClear) : '∞', forecast.weeksToClear == null ? 'is-overdue' : '');
      addTile('ETA', forecast.etaIso ? dashboardShortDate(forecast.etaIso) : '—');
      if (forecast.perWeek <= 0) container.createDiv({ cls: 'tm-dash-section-empty', text: 'No recent completions — finish a few tasks to forecast.' });
    },
  });

  registry.register('cumulative-flow', {
    title: 'Cumulative flow',
    icon: 'layers',
    description: 'Cumulative created vs. completed work each week; the gap is your open work-in-progress.',
    defaultSize: 'medium',
    render: async (container, _config, context) => {
      const state = await context.stateStore?.loadState();
      const completions = (state?.completions ?? []).map((completion) => completion.completedAtIso.slice(0, 10));
      const weeks = dashboardCumulativeFlow(context.tasks, context.today, completions, 8);
      const current = weeks[weeks.length - 1];
      context.setBadge(current ? String(current.open) : null);
      if (!current || current.created === 0) {
        renderDashEmpty(container, 'layers', 'Not enough dated history to chart flow yet.');
        return;
      }
      const max = Math.max(1, ...weeks.map((week) => week.created));
      const chart = container.createDiv('tm-dash-cfd');
      for (const week of weeks) {
        const col = chart.createDiv('tm-dash-cfd-col');
        col.setAttr('title', `${week.label}: ${week.created} created · ${week.done} done · ${week.open} open`);
        const stack = col.createDiv('tm-dash-cfd-stack');
        stack.createDiv('tm-dash-cfd-open').style.height = `${Math.round((week.open / max) * 100)}%`;
        stack.createDiv('tm-dash-cfd-done').style.height = `${Math.round((week.done / max) * 100)}%`;
      }
      const legend = container.createDiv('tm-dash-cfd-legend');
      legend.createSpan({ cls: 'tm-dash-cfd-legend-item is-done', text: `Done ${current.done}` });
      legend.createSpan({ cls: 'tm-dash-cfd-legend-item is-open', text: `Open WIP gap ${current.open}` });
      renderDashboardInsight(container, current.open > current.done ? 'layers-3' : 'badge-check', current.open > current.done ? 'Open gap is larger than completed work — watch WIP growth.' : 'Flow is balanced: completed work is keeping pace.', current.open > current.done ? 'watch' : 'good');
    },
  });

  registry.register('estimate-variance', {
    title: 'Estimate variance',
    icon: 'scale',
    description: 'Whether your time estimates run over or under, and the worst-diverging completed tasks.',
    defaultSize: 'medium',
    render: (container, config, context) => {
      const variance = dashboardEstimateVariance(context.tasks);
      if (variance.sampleSize === 0) {
        context.setBadge(null);
        renderDashEmpty(container, 'scale', 'No completed tasks with both estimate and actual time.');
        return;
      }
      context.setBadge(`${variance.biasPct >= 0 ? '+' : ''}${variance.biasPct}%`);
      const tiles = container.createDiv('tm-dash-stat-tiles tm-dash-stat-tiles--wide');
      const addTile = (label: string, value: string, modifier = ''): void => {
        const tile = tiles.createDiv({ cls: `tm-dash-stat-tile${modifier ? ` ${modifier}` : ''}` });
        tile.createDiv({ cls: 'tm-dash-stat-value', text: value });
        tile.createDiv({ cls: 'tm-dash-stat-label', text: label });
      };
      addTile('Bias', `${variance.biasPct >= 0 ? '+' : ''}${variance.biasPct}%`, variance.biasPct > 10 ? 'is-overdue' : variance.biasPct < -10 ? 'is-soon' : '');
      addTile('Over', formatDashboardCount(variance.overCount));
      addTile('Under', formatDashboardCount(variance.underCount));
      addTile('Samples', formatDashboardCount(variance.sampleSize));
      container.createDiv({ cls: 'tm-dash-section-title', text: variance.biasPct >= 0 ? 'Took longer than estimated' : 'Beat the estimate' });
      renderDashboardBars(container, variance.worst.slice(0, Math.max(3, dashboardWidgetRowLimit(config, context.autoFit))).map((row) => ({
        label: dashboardTaskTitle(row.task),
        value: Math.abs(row.deltaPct),
        detail: `${row.deltaPct >= 0 ? '+' : ''}${row.deltaPct}% · ${formatDashboardMinutes(row.actual)}/${formatDashboardMinutes(row.est)}`,
        tone: row.deltaPct > 0 ? 'is-overdue' : 'is-soon',
      })), { palette: 'severity' });
    },
  });

  // ── Tier 2: methodology completeness ──────────────────────────────────────

  registry.register('goals-progress', {
    title: 'Goals & objectives',
    icon: 'goal',
    description: 'Completion progress for goals defined via #goal/<name> tags or a [goal:: ...] field, with target dates.',
    defaultSize: 'medium',
    render: (container, config, context) => {
      const configured = typeof config.customConfig?.field === 'string' && config.customConfig.field.trim() ? config.customConfig.field.trim().toLowerCase() : 'goal';
      const rows = dashboardGoalRows(context.tasks, context.today, configured, context.settings.dashboardGoalTagPrefix ?? 'goal');
      const atRisk = rows.filter((row) => row.overdue).length;
      context.setBadge(rows.length ? (atRisk ? `${atRisk} at risk` : String(rows.length)) : null);
      if (!rows.length) {
        renderDashEmpty(container, 'goal', 'No goals found.', 'Tag tasks #goal/<name> or add a [goal:: ...] field.');
        return;
      }
      renderDashboardBars(container, rows.slice(0, Math.max(4, dashboardWidgetRowLimit(config, context.autoFit))).map((row) => ({
        label: row.label,
        value: row.pct,
        detail: `${row.done}/${row.total}${row.targetIso ? ` · ${dashboardShortDate(row.targetIso)}` : ''}`,
        tone: row.overdue ? 'is-overdue' : row.pct >= 100 ? 'is-soon' : '',
      })), { palette: 'categorical' });
    },
  });

  registry.register('areas-of-responsibility', {
    title: 'Areas of responsibility',
    icon: 'layout-grid',
    description: 'Active workload grouped by life/work area: an #area/<name> tag or the top-level folder.',
    defaultSize: 'medium',
    render: (container, _config, context) => {
      const rows = dashboardAreaRows(context.tasks, context.today, context.settings.dashboardAreaTagPrefix ?? 'area').filter((row) => row.active > 0).slice(0, 10);
      context.setBadge(rows.length ? String(rows.length) : null);
      if (!rows.length) {
        renderDashEmpty(container, 'layout-grid', 'No active areas to group.', 'Use #area/<name> tags or folders to create area rollups.');
        return;
      }
      renderDashboardBars(container, rows.map((row) => ({
        label: row.label,
        value: row.active,
        detail: `${row.active} active${row.overdue ? ` · ${row.overdue} overdue` : ''}`,
        tone: row.overdue ? 'is-overdue' : '',
      })), { palette: 'categorical' });
    },
  });

  registry.register('next-action-project', {
    title: 'Next action per project',
    icon: 'list-todo',
    description: 'The single best available next action for each active project — your GTD engagement list.',
    details: 'A GTD-style engagement list: one row per active project showing its single best available next step (not blocked, any start date passed), ranked the same way as Next up. Unlike the Agenda, dates aren’t required — even a project with nothing scheduled still surfaces its next move so no project stalls.',
    defaultSize: 'medium',
    render: (container, config, context) => {
      const summaries = dashboardProjectSummaries(context.tasks, context.today);
      const focusCompare = compareFocusTasks(context.today);
      const rows: Array<{ project: string; task: ParsedTask }> = [];
      for (const [label, summary] of summaries) {
        if (summary.active.length === 0) continue;
        const pool = summary.next.length ? summary.next : summary.active;
        const next = [...pool].sort(focusCompare)[0];
        if (next) rows.push({ project: label, task: next });
      }
      rows.sort((a, b) => focusCompare(a.task, b.task));
      context.setBadge(rows.length ? String(rows.length) : null);
      if (!rows.length) {
        renderDashEmpty(container, 'list-todo', 'No active projects with a next action.', 'Tag tasks with 📋 a project to surface one next action per project.');
        return;
      }
      const limit = Math.max(4, dashboardWidgetRowLimit(config, context.autoFit));
      const list = container.createDiv('tm-dash-nextaction-list');
      const renderProjectRow = ({ project, task }: { project: string; task: ParsedTask }) => {
        const block = list.createDiv('tm-dash-nextaction');
        block.createDiv({ cls: 'tm-dash-nextaction-project', text: project });
        renderDashTaskRow(block, task, context);
      };
      for (const row of rows.slice(0, limit)) renderProjectRow(row);
      renderDashMore(list, rows.length - limit, () => {
        for (const row of rows.slice(limit)) renderProjectRow(row);
      });
    },
  });

  registry.register('schedule-conflicts', {
    title: 'Schedule conflicts',
    icon: 'calendar-x',
    description: 'Overlapping timed items today plus upcoming days where committed effort exceeds capacity.',
    defaultSize: 'medium',
    render: async (container, _config, context) => {
      let events: CalendarIcsEvent[] = [];
      try { events = (await context.fetchIcsEvents?.()) ?? []; } catch { events = []; }
      const { timed } = dashboardScheduleForDay(context.tasks, context.today, events);
      const overlaps = dashboardScheduleOverlaps(timed);
      const capacity = context.settings.dashboardCapacityMinutes ?? 360;
      const overloaded = dashboardCapacitySeries(context.tasks, context.today, capacity, 7).filter((day) => day.over);
      context.setBadge(overlaps.length + overloaded.length ? String(overlaps.length + overloaded.length) : null);
      const rows: Array<{ icon: string; text: string; tone?: string }> = [];
      for (const [a, b] of overlaps.slice(0, 4)) rows.push({ icon: 'calendar-x', text: `${dashboardFormatClock(Math.max(a.start, b.start))}: “${a.label}” overlaps “${b.label}”`, tone: 'is-overdue' });
      for (const day of overloaded.slice(0, 4)) rows.push({ icon: 'gauge', text: `${day.label}: ${formatDashboardMinutes(day.committed)} committed vs ${formatDashboardMinutes(day.capacity)} capacity`, tone: 'is-soon' });
      if (!rows.length) rows.push({ icon: 'calendar-check', text: 'No schedule conflicts or overloaded days detected.' });
      renderDashboardNotes(container, rows);
    },
  });

  // ── Tier 3: content & navigation ──────────────────────────────────────────

  registry.register('pinned-tasks', {
    title: 'Pinned / starred',
    icon: 'pin',
    description: 'Tasks you have pinned with 📌 as a dedicated focus shortlist.',
    defaultSize: 'medium',
    render: (container, config, context) => {
      const tasks = filterDashboardActiveTasks(context.tasks).filter((task) => task.metadata.pinned === true).sort(compareFocusTasks(context.today));
      context.setBadge(tasks.length ? String(tasks.length) : null);
      if (!tasks.length) {
        renderDashEmpty(container, 'pin', 'No pinned tasks.', 'Add 📌 or [pinned:: true] to promote a task into this focus list.');
        return;
      }
      renderDashTaskList(container, tasks, context, dashboardWidgetRowLimit(config, context.autoFit));
    },
  });

  registry.register('subtask-progress', {
    title: 'Subtask progress',
    icon: 'list-tree',
    description: 'Parent tasks with a completion bar across their child tasks, linked by id / parentId.',
    defaultSize: 'medium',
    render: (container, config, context) => {
      const rows = dashboardSubtaskRows(context.tasks).filter((row) => row.total > 0);
      const incomplete = rows.filter((row) => row.pct < 100).length;
      context.setBadge(rows.length ? String(incomplete || rows.length) : null);
      if (!rows.length) {
        renderDashEmpty(container, 'list-tree', 'No parent/child task relationships found.');
        return;
      }
      renderDashboardBars(container, rows.slice(0, Math.max(4, dashboardWidgetRowLimit(config, context.autoFit))).map((row) => ({
        label: row.label,
        value: row.pct,
        detail: `${row.done}/${row.total}`,
        tone: row.pct >= 100 ? 'is-soon' : row.pct === 0 ? 'is-overdue' : '',
      })), { palette: 'severity' });
    },
  });

  registry.register('daily-note', {
    title: 'Daily note',
    icon: 'notebook-pen',
    description: 'Tasks in today’s daily note, with a shortcut to open it.',
    defaultSize: 'medium',
    render: (container, config, context) => {
      let tasks: ParsedTask[];
      try {
        const todayPath = new DailyNoteResolver(context.app).resolveTodayPath();
        tasks = context.tasks.filter((task) => task.filePath.replace(/^\/+/u, '') === todayPath);
        if (!tasks.length) tasks = context.tasks.filter((task) => (task.filePath.split('/').pop() ?? '').includes(context.today));
      } catch {
        tasks = context.tasks.filter((task) => (task.filePath.split('/').pop() ?? '').includes(context.today));
      }
      const active = filterDashboardActiveTasks(tasks);
      context.setBadge(active.length ? String(active.length) : null);
      const openBtn = container.createEl('button', { cls: 'tm-dash-action-button tm-dash-daily-open' });
      openBtn.setAttr('type', 'button');
      setIcon(openBtn.createSpan('tm-dash-action-icon'), 'calendar-check');
      openBtn.createSpan({ cls: 'tm-dash-action-label', text: 'Open today’s note' });
      openBtn.addEventListener('click', () => { if (!executeDashboardCommand(context.app, 'open-todays-daily-note')) new Notice('Task Manager: could not open today’s note.'); });
      if (!tasks.length) {
        renderDashEmpty(container, 'notebook-pen', 'No tasks in today’s daily note yet.');
        return;
      }
      renderDashTaskList(container, [...tasks].sort(compareDashboardTasks), context, dashboardWidgetRowLimit(config, context.autoFit));
    },
  });

  registry.register('saved-views', {
    title: 'Saved views',
    icon: 'bookmark',
    description: 'Launch any saved query and preview its matching tasks inline.',
    defaultSize: 'medium',
    render: (container, config, context) => {
      const saved = context.settings.savedQueries ?? [];
      context.setBadge(saved.length ? String(saved.length) : null);
      if (!saved.length) {
        renderDashEmpty(container, 'bookmark', 'No saved queries.', 'Add saved queries in Settings → Task Manager → Saved queries.');
        return;
      }
      const chips = container.createDiv('tm-dash-savedviews-chips');
      const results = container.createDiv('tm-dash-savedviews-results');
      const options = dashboardQueryOptions(context.settings);
      const run = (view: { name: string; query: string }): void => {
        results.empty();
        try {
          const parsed = parseTaskQuery(view.query, options);
          const matched = filterTasks(context.tasks, parsed, options);
          if (!matched.length) { renderDashEmpty(results, 'search-x', 'No tasks match this view.'); return; }
          renderDashTaskList(results, matched, context, dashboardWidgetRowLimit(config, context.autoFit));
        } catch {
          renderDashEmpty(results, 'alert-circle', 'This saved query could not be parsed.');
        }
      };
      const setActiveChip = (activeChip: HTMLElement): void => {
        chips.querySelectorAll<HTMLElement>('.tm-dash-savedview-chip').forEach((el) => {
          const active = el === activeChip;
          el.toggleClass('is-active', active);
          el.setAttr('aria-pressed', active ? 'true' : 'false');
        });
      };
      saved.forEach((view, index) => {
        const chip = chips.createEl('button', { cls: 'tm-dash-savedview-chip', text: view.name });
        chip.setAttr('type', 'button');
        chip.setAttr('aria-pressed', index === 0 ? 'true' : 'false');
        chip.addEventListener('click', () => {
          setActiveChip(chip);
          run(view);
        });
        if (index === 0) chip.addClass('is-active');
      });
      run(saved[0]);
    },
  });

  registry.register('recently-edited', {
    title: 'Recently edited',
    icon: 'file-clock',
    description: 'Active tasks in the notes you edited most recently — pick up where you left off.',
    defaultSize: 'medium',
    render: (container, config, context) => {
      const active = filterDashboardActiveTasks(context.tasks);
      const mtimeByPath = new Map<string, number>();
      for (const task of active) {
        if (mtimeByPath.has(task.filePath)) continue;
        const file = context.app.vault.getAbstractFileByPath(task.filePath);
        mtimeByPath.set(task.filePath, file instanceof TFile ? file.stat.mtime : 0);
      }
      const tasks = [...active]
        .filter((task) => (mtimeByPath.get(task.filePath) ?? 0) > 0)
        .sort((a, b) => (mtimeByPath.get(b.filePath) ?? 0) - (mtimeByPath.get(a.filePath) ?? 0));
      context.setBadge(tasks.length ? String(tasks.length) : null);
      if (!tasks.length) {
        renderDashEmpty(container, 'file-clock', 'No recently edited task notes.');
        return;
      }
      renderDashTaskList(container, tasks, context, dashboardWidgetRowLimit(config, context.autoFit));
    },
  });

  registry.register('comments-feed', {
    title: 'Comments',
    icon: 'message-square',
    description: 'Active tasks that carry 💬 comments or discussion that may need a reply.',
    defaultSize: 'medium',
    render: (container, config, context) => {
      const tasks = filterDashboardActiveTasks(context.tasks).filter((task) => (task.metadata.comments?.length ?? 0) > 0);
      const totalComments = tasks.reduce((sum, task) => sum + (task.metadata.comments?.length ?? 0), 0);
      context.setBadge(totalComments ? String(totalComments) : null);
      if (!tasks.length) {
        renderDashEmpty(container, 'message-square', 'No tasks with comments.', 'Add comment metadata to surface handoffs and discussion here.');
        return;
      }
      const limit = Math.max(3, dashboardWidgetRowLimit(config, context.autoFit));
      const list = container.createDiv('tm-dash-comments');
      for (const task of tasks.slice(0, limit)) {
        const block = list.createDiv('tm-dash-comment');
        renderDashTaskRow(block, task, context);
        const comments = task.metadata.comments;
        const last = comments && comments.length ? comments[comments.length - 1] : undefined;
        if (last) {
          const note = block.createDiv('tm-dash-comment-latest');
          setIcon(note.createSpan('tm-dash-comment-icon'), 'message-square');
          note.createSpan({ cls: 'tm-dash-comment-text', text: last });
        }
      }
      if (tasks.length > limit) list.createDiv({ cls: 'tm-dash-more', text: `+${tasks.length - limit} more` });
    },
  });

  registry.register('needs-scheduling', {
    title: 'Needs scheduling',
    icon: 'calendar-plus',
    description: 'Clarified, actionable tasks that have no date yet — give them a when.',
    defaultSize: 'medium',
    render: (container, config, context) => {
      const tasks = filterDashboardNeedsSchedulingTasks(context.tasks, context.today);
      context.setBadge(tasks.length ? String(tasks.length) : null);
      if (!tasks.length) {
        renderDashEmpty(container, 'calendar-check', 'Every actionable task has a date. Nice.');
        return;
      }
      renderDashTaskList(container, tasks, context, Math.max(3, Math.min(6, dashboardWidgetRowLimit(config, context.autoFit))), {
        moreText: `Review all ${formatDashboardCount(tasks.length)} unscheduled`,
        moreAriaLabel: `Show all ${tasks.length} tasks needing scheduling`,
      });
    },
  });

  // ── Tier 4: engagement & wellbeing ────────────────────────────────────────

  registry.register('shutdown-ritual', {
    title: 'Shutdown ritual',
    icon: 'moon',
    description: 'A short end-of-day checklist: clear inbox, reschedule overdue, and plan tomorrow.',
    defaultSize: 'medium',
    render: (container, _config, context) => {
      const items = dashboardShutdownItems(context.tasks, context.today);
      const actionable = items.filter((item) => item.key !== 'celebrate');
      const outstanding = actionable.filter((item) => !item.done).length;
      context.setBadge(outstanding ? String(outstanding) : null);
      const progressEl = container.createDiv('tm-dash-review-progress');
      const cleared = actionable.length - outstanding;
      progressEl.createSpan({ cls: 'tm-dash-review-progress-text', text: `${cleared}/${actionable.length} ready to shut down` });
      const track = progressEl.createDiv('tm-dash-review-progress-track');
      track.createDiv('tm-dash-review-progress-fill').style.width = `${percent(cleared, actionable.length)}%`;
      const list = container.createDiv('tm-dash-review-list');
      for (const item of items) {
        const isCelebrate = item.key === 'celebrate';
        const tone = isCelebrate ? 'is-info' : item.done ? 'is-done' : 'is-todo';
        const rowEl = list.createDiv({ cls: `tm-dash-review-item ${tone}` });
        setIcon(rowEl.createSpan('tm-dash-review-icon'), isCelebrate ? item.icon : item.done ? 'check-circle' : 'circle');
        rowEl.createSpan({ cls: 'tm-dash-review-label', text: item.label });
        rowEl.createSpan({ cls: 'tm-dash-review-count', text: String(item.count) });
      }
    },
  });

  registry.register('on-this-day', {
    title: 'On this day',
    icon: 'history',
    description: 'Tasks you completed on this calendar day in previous years.',
    defaultSize: 'medium',
    render: (container, config, context) => {
      const tasks = dashboardOnThisDay(context.tasks, context.today);
      context.setBadge(tasks.length ? String(tasks.length) : null);
      if (!tasks.length) {
        renderDashEmpty(container, 'history', 'Nothing recorded on this day in past years — yet.');
        return;
      }
      renderDashTaskList(container, tasks, context, dashboardWidgetRowLimit(config, context.autoFit));
    },
  });

  registry.register('goal-streak-calendar', {
    title: 'Goal streak',
    icon: 'calendar-heart',
    description: 'A calendar of days you hit your daily completion goal, with the current streak.',
    defaultSize: 'medium',
    render: async (container, _config, context) => {
      const goal = context.settings.dashboardDailyGoal ?? 5;
      const state = await context.stateStore?.loadState();
      const completions = (state?.completions ?? []).map((completion) => completion.completedAtIso.slice(0, 10));
      const days = dashboardGoalStreakDays(context.tasks, context.today, goal, 70, completions);
      let streak = 0;
      for (let i = days.length - 1; i >= 0; i -= 1) { if (days[i].met) streak += 1; else break; }
      const metCount = days.filter((day) => day.met).length;
      context.setBadge(streak ? `${streak}\u{1F525}` : null);
      container.createDiv({ cls: 'tm-dash-section-title', text: `${metCount}/${days.length} days hit goal · ${streak}-day streak` });
      const grid = container.createDiv('tm-dash-heatmap');
      grid.setAttr('role', 'list');
      grid.setAttr('aria-label', t('dashboard.a11y.goalStreak'));
      for (const day of days) {
        const level = day.completed === 0 ? 0 : day.met ? 4 : 2;
        const label = `${day.date}: ${day.completed} completed${day.met ? ' · goal met' : ''}`;
        const cell = grid.createDiv({ cls: `tm-dash-heatmap-cell tm-dash-heatmap-l${level}` });
        cell.setAttr('role', 'listitem');
        cell.setAttr('title', label);
        cell.setAttr('aria-label', label);
      }
      renderDashboardInsight(container, 'target', `Goal is ${goal} task${goal === 1 ? '' : 's'}/day; darkest cells met it.`, 'neutral');
    },
  });

  registry.register('tag-explorer', {
    title: 'Tag explorer',
    icon: 'tags',
    description: 'Browse your most-used tags and contexts; click one to preview its tasks.',
    defaultSize: 'medium',
    render: (container, config, context) => {
      const active = filterDashboardActiveTasks(context.tasks);
      const counts = new Map<string, number>();
      for (const task of active) {
        for (const tag of task.tags) counts.set(`#${tag}`, (counts.get(`#${tag}`) ?? 0) + 1);
        for (const ctx of task.contexts) counts.set(`@${ctx}`, (counts.get(`@${ctx}`) ?? 0) + 1);
      }
      const ranked = Array.from(counts.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 24);
      context.setBadge(ranked.length ? String(ranked.length) : null);
      if (!ranked.length) {
        renderDashEmpty(container, 'tags', 'No tags or contexts on active tasks.', 'Add #tags or @contexts to make this explorer useful.');
        return;
      }
      const cloud = container.createDiv('tm-dash-tagcloud');
      const results = container.createDiv('tm-dash-tagcloud-results');
      const show = (label: string): void => {
        results.empty();
        const sym = label[0];
        const value = label.slice(1);
        const matched = active.filter((task) => (sym === '#' ? task.tags.includes(value) : task.contexts.includes(value))).sort(compareFocusTasks(context.today));
        if (!matched.length) { renderDashEmpty(results, 'search-x', 'No active tasks for this tag.'); return; }
        renderDashTaskList(results, matched, context, dashboardWidgetRowLimit(config, context.autoFit));
      };
      const setActiveChip = (activeChip: HTMLElement): void => {
        cloud.querySelectorAll<HTMLElement>('.tm-dash-tag-chip').forEach((el) => {
          const active = el === activeChip;
          el.toggleClass('is-active', active);
          el.setAttr('aria-pressed', active ? 'true' : 'false');
        });
      };
      ranked.forEach(([label, count], index) => {
        const chip = cloud.createEl('button', { cls: 'tm-dash-tag-chip' });
        chip.setAttr('type', 'button');
        chip.setAttr('aria-pressed', index === 0 ? 'true' : 'false');
        chip.createSpan({ cls: 'tm-dash-tag-chip-label', text: label });
        chip.createSpan({ cls: 'tm-dash-tag-chip-count', text: String(count) });
        chip.addEventListener('click', () => {
          setActiveChip(chip);
          show(label);
        });
        if (index === 0) chip.addClass('is-active');
      });
      show(ranked[0][0]);
    },
  });

  return registry;
}

// ── Card + view ─────────────────────────────────────────────────────────────

interface DashboardCard {
  config: DashboardWidgetConfig;
  el: HTMLElement;
  bodyEl: HTMLElement;
  badgeEl: HTMLElement;
  collapseBtn?: HTMLElement;
  /** Display-only collapse applied after a widget renders a top-level empty state. */
  autoCollapsedEmpty?: boolean;
  /** Session-only escape hatch when the user expands an automatically collapsed empty card. */
  autoCollapseSuppressed?: boolean;
  dispose?: WidgetDisposer;
  renderGeneration?: number;
  renderBody(): Promise<void>;
}

interface DashboardTemplateOption {
  id: string;
  name: string;
  description: string;
  source: 'builtin' | 'custom';
  createLayout(id: string, name: string, now: number): DashboardLayout;
}

function dashboardCardIsCollapsed(card: Pick<DashboardCard, 'config' | 'autoCollapsedEmpty'>): boolean {
  return Boolean(card.config.collapsed || card.autoCollapsedEmpty);
}

function dashboardCardIsAlert(config: DashboardWidgetConfig): boolean {
  return dashboardCardRoleClass(config.type) === 'tm-dash-card--alert';
}

function dashboardBodyHasTopLevelEmptyState(bodyEl: HTMLElement): boolean {
  return Array.from(bodyEl.children).some((child) => child.classList.contains('tm-dash-empty') && (child as HTMLElement).dataset.autoCollapse !== 'false');
}

export function disposeDashboardWidget(card: Pick<DashboardCard, 'dispose'>): void {
  const dispose = card.dispose;
  card.dispose = undefined;
  if (dispose) {
    try {
      dispose();
    } catch {
      // Cleanup must never break refresh / close flows.
    }
  }
}

/** Kept for back-compat with callers/tests that refresh a single widget by config. */
export function refreshDashboardWidgetForConfig(
  cards: Iterable<{ config: DashboardWidgetConfig; refresh?: () => Promise<void>; renderBody?: () => Promise<void> }>,
  config: DashboardWidgetConfig,
): void {
  for (const card of cards) {
    if (card.config === config) {
      void (card.refresh?.() ?? card.renderBody?.());
      return;
    }
  }
}

export interface DashboardMarkdownRendererOptions {
  app: App;
  scanner: TaskScanner;
  getSettings: () => TaskManagerSettings;
  getRenderer?: () => TaskQueryRenderer;
  stateStore?: StateStore;
  taskMutations?: TaskMutationService;
  onCreateTask?: (text: string) => Promise<void>;
  saveSettings?: () => Promise<void> | void;
  fetchIcsEvents?: () => Promise<CalendarIcsEvent[]>;
  getIndexedTasks?: () => Promise<ParsedTask[]>;
}

interface DashboardMarkdownEmbedContext {
  sourcePath?: string;
  noteFrontmatter?: Record<string, unknown>;
}

/** Renders note-backed dashboards and standalone task widgets inside standard Markdown notes. */
export class DashboardMarkdownRenderer {
  private readonly registry = buildWidgetRegistry();
  private readonly disposers = new WeakMap<HTMLElement, Set<WidgetDisposer>>();
  private readonly generations = new WeakMap<HTMLElement, number>();
  private readonly lifecycleContainers = new WeakSet<HTMLElement>();
  private readonly dailyDeleteSession: DashboardDailyDeleteSession;

  constructor(private readonly options: DashboardMarkdownRendererOptions) {
    this.dailyDeleteSession = new DashboardDailyDeleteSession(options.app);
  }

  async renderDashboard(source: string, container: HTMLElement, context?: string | MarkdownPostProcessorContext): Promise<void> {
    const sourcePath = typeof context === 'string' ? context : context?.sourcePath;
    if (typeof context !== 'string' && context) this.registerLifecycle(container, context);
    const generation = this.beginContainerRender(container);
    try {
      const layout = parseDashboardLayoutBlock(source);
      await this.renderLayout(layout, container, { showHeader: true, singleWidget: false, sourcePath }, generation);
    } catch (error) {
      if (this.isCurrentGeneration(container, generation)) this.renderError(container, error);
    }
  }

  async renderWidget(source: string, container: HTMLElement, context?: string | MarkdownPostProcessorContext): Promise<void> {
    const sourcePath = typeof context === 'string' ? context : context?.sourcePath;
    if (typeof context !== 'string' && context) this.registerLifecycle(container, context);
    const generation = this.beginContainerRender(container);
    try {
      const config = parseDashboardWidgetBlock(source);
      if (config.type === 'daily-todos') {
        await this.renderDailyTodosWidget(config, container, sourcePath, generation);
        return;
      }
      const footprint = gridFootprintForSize(normalizeDashboardWidgetSize(config.size));
      if (!config.grid) config.grid = { x: 0, y: 0, w: DASHBOARD_GRID_COLUMNS, h: footprint.h };
      else config.grid = clampGridPlacement({ ...config.grid, x: 0, w: Math.max(config.grid.w, footprint.w) }, DASHBOARD_GRID_COLUMNS);
      const now = Date.now();
      await this.renderLayout({ id: 'embedded-widget', name: config.title, widgets: [config], createdAt: now, updatedAt: now }, container, { showHeader: false, singleWidget: true, sourcePath }, generation);
    } catch (error) {
      if (this.isCurrentGeneration(container, generation)) this.renderError(container, error);
    }
  }

  /** Dispose an embedded dashboard when its Markdown render child unloads. */
  dispose(container: HTMLElement): void {
    this.generations.set(container, (this.generations.get(container) ?? 0) + 1);
    this.disposeContainer(container);
  }

  private registerLifecycle(container: HTMLElement, context: MarkdownPostProcessorContext): void {
    if (this.lifecycleContainers.has(container)) return;
    const contextWithLifecycle = context as MarkdownPostProcessorContext & { addChild?: (child: Component) => void };
    if (typeof contextWithLifecycle.addChild !== 'function' || typeof MarkdownRenderChild !== 'function') return;
    this.lifecycleContainers.add(container);
    const child = new MarkdownRenderChild(container) as Component & { onunload?: () => void };
    const originalUnload = typeof child.onunload === 'function' ? child.onunload.bind(child) : undefined;
    child.onunload = () => {
      this.lifecycleContainers.delete(container);
      this.dispose(container);
      originalUnload?.();
    };
    contextWithLifecycle.addChild(child);
  }

  private beginContainerRender(container: HTMLElement): number {
    const generation = (this.generations.get(container) ?? 0) + 1;
    this.generations.set(container, generation);
    this.disposeContainer(container);
    return generation;
  }

  private isCurrentGeneration(container: HTMLElement, generation: number): boolean {
    return this.generations.get(container) === generation;
  }

  private renderError(container: HTMLElement, error: unknown): void {
    this.dispose(container);
    container.empty();
    const root = container.createDiv('tm-dash tm-dash-embedded tm-dash-embedded-error');
    this.applyAppearance(root);
    renderDashEmpty(root, 'alert-circle', error instanceof Error ? error.message : String(error));
  }

  private markDailyTodosHost(container: HTMLElement): void {
    container.addClass('tm-dash-daily-todos-host');
    container.parentElement?.addClass('tm-dash-daily-todos-host-wrap');
    container.closest<HTMLElement>('.cm-preview-code-block')?.addClass('tm-dash-daily-todos-host-wrap');
    container.closest<HTMLElement>('.cm-embed-block')?.addClass('tm-dash-daily-todos-host-wrap');
    container.closest<HTMLElement>('pre')?.addClass('tm-dash-daily-todos-host-wrap');
  }

  private async renderDailyTodosWidget(config: DashboardWidgetConfig, container: HTMLElement, sourcePath: string | undefined, generation: number): Promise<void> {
    container.empty();
    this.markDailyTodosHost(container);
    const tasks = await this.scanAllTasks();
    if (!this.isCurrentGeneration(container, generation)) return;
    const embedContext: DashboardMarkdownEmbedContext = {
      sourcePath,
      noteFrontmatter: this.noteFrontmatterForPath(sourcePath),
    };
    const refresh = (): void => {
      if (!this.isCurrentGeneration(container, generation)) return;
      const nextGeneration = this.beginContainerRender(container);
      void this.renderDailyTodosWidget(config, container, sourcePath, nextGeneration).catch((error: unknown) => {
        if (this.isCurrentGeneration(container, nextGeneration)) this.renderError(container, error);
      });
    };
    renderDashboardDailyTodos(container, config, this.createDailyTodosContext(tasks, refresh, embedContext));
  }

  private createDailyTodosContext(tasks: ParsedTask[], refresh: () => void, embedContext: DashboardMarkdownEmbedContext): WidgetRenderContext {
    const settings = this.options.getSettings();
    return {
      app: this.options.app,
      scanner: this.options.scanner,
      settings,
      queryRenderer: this.options.getRenderer?.(),
      taskMutations: this.options.taskMutations,
      stateStore: this.options.stateStore,
      aggregates: buildDashboardAggregates(tasks),
      tasks,
      today: todayString(),
      scope: settings.dashboardScope ?? 'today',
      notePath: embedContext.sourcePath,
      noteFrontmatter: embedContext.noteFrontmatter,
      requestRefresh: refresh,
      requestTaskRefresh: refresh,
      openTask: (task) => this.openTask(task),
      toggleTask: async (task) => { await this.toggleTask(task); refresh(); },
      createTask: this.options.onCreateTask,
      saveSettings: this.options.saveSettings ? () => { void this.options.saveSettings?.(); } : undefined,
      fetchIcsEvents: this.options.fetchIcsEvents,
      dailyDeleteSession: this.dailyDeleteSession,
      setBadge: () => {},
    };
  }

  private async renderLayout(layout: DashboardLayout, container: HTMLElement, opts: { showHeader: boolean; singleWidget: boolean; sourcePath?: string }, generation: number): Promise<void> {
    container.empty();
    const root = container.createDiv('tm-dash tm-dash-embedded');
    root.toggleClass('tm-dash-widget-embed', opts.singleWidget);
    this.applyAppearance(root);
    const widgets = layout.widgets.map((widget) => cloneDashboardWidgetConfig(widget));
    root.toggleClass('tm-dash-daily-todos-embed', opts.singleWidget && widgets.length === 1 && widgets[0]?.type === 'daily-todos');
    ensureGridPlacements(widgets, DASHBOARD_GRID_COLUMNS);
    const tasks = await this.scanAllTasks();
    if (!this.isCurrentGeneration(container, generation)) return;
    const refresh = (): void => {
      if (!this.isCurrentGeneration(container, generation)) return;
      const nextGeneration = this.beginContainerRender(container);
      void this.renderLayout(layout, container, opts, nextGeneration).catch((error: unknown) => {
        if (this.isCurrentGeneration(container, nextGeneration)) this.renderError(container, error);
      });
    };

    if (opts.showHeader) {
      const header = root.createDiv('tm-dash-embedded-header');
      const title = header.createDiv('tm-dash-embedded-title');
      setIcon(title.createSpan('tm-dash-embedded-title-icon'), 'layout-dashboard');
      title.createSpan({ text: layout.name || 'Dashboard' });
      header.createDiv({ cls: 'tm-dash-embedded-subtitle', text: 'Note-backed dashboard' });
    }

    const grid = root.createDiv('tm-dash-grid tm-dash-embedded-grid');
    if (opts.singleWidget && widgets.length === 1 && widgets[0]?.type === 'daily-todos') {
      grid.style.display = 'block';
      grid.style.minHeight = '0';
    }
    const width = container.clientWidth || root.clientWidth || 900;
    const cols = opts.singleWidget ? DASHBOARD_GRID_COLUMNS : responsiveColumnCount(width);
    grid.style.setProperty('--tm-dash-cols', String(cols));
    const stacked = !opts.singleWidget && shouldStackDashboard(width);
    grid.toggleClass('is-condensed', cols < DASHBOARD_GRID_COLUMNS);
    grid.toggleClass('is-stacked', stacked);
    const base = widgets.map((widget) => widget.grid ?? { x: 0, y: 0, ...gridFootprintForSize(normalizeDashboardWidgetSize(widget.size)) });
    const display = cols < DASHBOARD_GRID_COLUMNS ? scaleGridPlacements(base, DASHBOARD_GRID_COLUMNS, cols) : base;
    const embedContext: DashboardMarkdownEmbedContext = {
      sourcePath: opts.sourcePath,
      noteFrontmatter: this.noteFrontmatterForPath(opts.sourcePath),
    };

    widgets.forEach((config, index) => {
      const placement = display[index] ?? base[index];
      const card = this.createEmbeddedCard(grid, config, placement, tasks, refresh, container, embedContext, generation);
      void card.renderBody();
    });
  }

  private createEmbeddedCard(
    grid: HTMLElement,
    config: DashboardWidgetConfig,
    placement: DashboardGridPlacement,
    tasks: ParsedTask[],
    refresh: () => void,
    container: HTMLElement,
    embedContext: DashboardMarkdownEmbedContext,
    containerGeneration: number,
  ): DashboardCard {
    const renderer = this.registry.getRenderer(config.type);
    const el = grid.createDiv({ cls: `tm-dash-card tm-dash-embedded-card tm-dash-card--${normalizeDashboardWidgetSize(config.size)}` });
    el.style.order = config.type === 'quick-capture' ? '-1' : '';
    applyDashboardCardVisualClasses(el, config);
    el.toggleClass('is-collapsed', Boolean(config.collapsed));
    el.style.gridColumn = `${placement.x + 1} / span ${placement.w}`;
    el.style.gridRow = `${placement.y + 1} / span ${dashboardEffectiveGridRowSpan(Boolean(config.collapsed), placement.h)}`;
    if (config.type === 'daily-todos') {
      el.style.gridColumn = 'auto';
      el.style.gridRow = 'auto';
      el.style.minHeight = '0';
    }

    const header = el.createDiv('tm-dash-card-header');
    if (renderer?.icon) {
      const iconEl = header.createDiv('tm-dash-card-icon');
      setIcon(iconEl, renderer.icon);
    }
    header.createDiv({ cls: 'tm-dash-card-title', text: config.title });
    const badgeEl = header.createSpan('tm-dash-card-badge');
    badgeEl.hide();
    if (renderer) {
      const headerActions = header.createDiv('tm-dash-card-actions');
      const infoBtn = headerActions.createEl('button', { cls: 'tm-dash-icon-btn clickable-icon' });
      setIcon(infoBtn, 'info');
      infoBtn.setAttr('aria-label', 'About this widget');
      infoBtn.setAttr('title', 'About this widget');
      infoBtn.addEventListener('click', (event) => {
        event.stopPropagation();
        new WidgetInfoModal(this.options.app, renderer, config).open();
      });
    }
    const bodyEl = el.createDiv('tm-dash-card-body');
    let renderGeneration = 0;

    const card: DashboardCard = {
      config,
      el,
      bodyEl,
      badgeEl,
      renderBody: async () => {
        const currentRender = ++renderGeneration;
        disposeDashboardWidget(card);
        bodyEl.empty();
        badgeEl.setText('');
        badgeEl.hide();
        if (config.collapsed || !renderer) return;
        try {
          const disposer = await renderer.render(bodyEl, config, this.createContext(card, tasks, refresh, embedContext));
          if (!this.isCurrentGeneration(container, containerGeneration) || currentRender !== renderGeneration) {
            if (typeof disposer === 'function') {
              try { disposer(); } catch { /* stale renderer cleanup is best-effort */ }
            }
            return;
          }
          card.dispose = typeof disposer === 'function' ? this.registerDisposer(container, disposer) : undefined;
        } catch {
          if (!this.isCurrentGeneration(container, containerGeneration) || currentRender !== renderGeneration) return;
          bodyEl.empty();
          renderDashEmpty(bodyEl, 'alert-circle', 'This widget failed to render.');
        }
      },
    };
    return card;
  }

  private registerDisposer(container: HTMLElement, disposer: WidgetDisposer): WidgetDisposer {
    const existing = this.disposers.get(container) ?? new Set<WidgetDisposer>();
    let active = true;
    const trackedDispose = (): void => {
      if (!active) return;
      active = false;
      existing.delete(trackedDispose);
      if (existing.size === 0 && this.disposers.get(container) === existing) this.disposers.delete(container);
      disposer();
    };
    existing.add(trackedDispose);
    this.disposers.set(container, existing);
    return trackedDispose;
  }

  private disposeContainer(container: HTMLElement): void {
    const existing = this.disposers.get(container);
    if (!existing) return;
    this.disposers.delete(container);
    for (const dispose of existing) {
      try { dispose(); } catch { /* markdown cleanup should be best-effort */ }
    }
  }

  private noteFrontmatterForPath(sourcePath: string | undefined): Record<string, unknown> | undefined {
    if (!sourcePath) return undefined;
    const file = this.options.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) return undefined;
    const frontmatter = this.options.app.metadataCache.getFileCache(file)?.frontmatter;
    return isRecord(frontmatter) ? frontmatter : undefined;
  }

  private createContext(card: DashboardCard, tasks: ParsedTask[], refresh: () => void, embedContext: DashboardMarkdownEmbedContext): WidgetRenderContext {
    const settings = this.options.getSettings();
    return {
      app: this.options.app,
      scanner: this.options.scanner,
      settings,
      queryRenderer: this.options.getRenderer?.(),
      taskMutations: this.options.taskMutations,
      stateStore: this.options.stateStore,
      aggregates: buildDashboardAggregates(tasks),
      tasks,
      today: todayString(),
      scope: settings.dashboardScope ?? 'today',
      notePath: embedContext.sourcePath,
      noteFrontmatter: embedContext.noteFrontmatter,
      requestRefresh: refresh,
      requestTaskRefresh: refresh,
      openTask: (task) => this.openTask(task),
      toggleTask: async (task) => { await this.toggleTask(task); refresh(); },
      createTask: this.options.onCreateTask,
      saveSettings: this.options.saveSettings ? () => { void this.options.saveSettings?.(); } : undefined,
      fetchIcsEvents: this.options.fetchIcsEvents,
      dailyDeleteSession: this.dailyDeleteSession,
      setBadge: (text) => {
        if (text) {
          card.badgeEl.setText(formatDashboardBadge(text));
          card.badgeEl.show();
        } else {
          card.badgeEl.setText('');
          card.badgeEl.hide();
        }
      },
    };
  }

  private async scanAllTasks(): Promise<ParsedTask[]> {
    if (this.options.getIndexedTasks) return this.options.getIndexedTasks();
    const settings = this.options.getSettings();
    const excluded = settings.excludedFolders ?? [];
    const files = this.options.app.vault.getMarkdownFiles().filter((file: TFile) => excluded.length === 0 || !isDashboardPathExcluded(file.path, excluded));
    const tasks: ParsedTask[] = [];
    for (const file of files) {
      if (isTaskNoteFile(file, this.options.app, settings.taskNoteFolders, settings.taskNoteMarker)) {
        const fileTask = scanFileAsTask(file, this.options.app, settings.supportedStates, settings.customFieldDefinitions);
        if (fileTask) tasks.push(fileTask);
      } else {
        tasks.push(...await this.options.scanner.scanFile(file));
      }
    }
    return tasks;
  }

  private async openTask(task: ParsedTask): Promise<void> {
    const file = this.options.app.vault.getAbstractFileByPath(task.filePath);
    if (!(file instanceof TFile)) {
      new Notice('Task Manager: source file not found.');
      return;
    }
    await this.options.app.workspace.getLeaf(false).openFile(file, {
      active: true,
      eState: { line: Math.max(0, task.lineNumber - 1) },
    });
  }

  private async toggleTask(task: ParsedTask): Promise<void> {
    const file = this.options.app.vault.getAbstractFileByPath(task.filePath);
    if (!(file instanceof TFile)) {
      new Notice('Task Manager: source file not found.');
      return;
    }
    try {
      if (this.options.taskMutations) {
        await this.options.taskMutations.updateTaskCheckbox(file, task, cycleTaskCheckbox(task.checkbox, this.options.getSettings().supportedStates));
      } else {
        await this.options.scanner.updateTaskCheckbox(file, task, cycleTaskCheckbox(task.checkbox, this.options.getSettings().supportedStates));
        this.options.getRenderer?.()?.invalidateCache(task.filePath);
      }
    } catch (error) {
      console.warn('Task Manager: dashboard task update failed', error);
      new Notice(`Task Manager: could not update task — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private applyAppearance(root: HTMLElement): void {
    const settings = this.options.getSettings();
    root.addClass(`tm-dash-theme-${settings.dashboardTheme}`);
    root.addClass(`tm-dash-density-${settings.dashboardDensity}`);
  }
}

export function dashboardRevisionShouldRefresh(lastRendered: number, pending: number, requested: number): boolean {
  return requested > lastRendered && requested > pending;
}

export class DashboardView extends ItemView {
  private registry: WidgetRegistry;
  private layout: DashboardLayout | null = null;
  private cards: DashboardCard[] = [];
  private tasks: ParsedTask[] = [];
  private loaded = false;
  private activeScope: DashboardScope = 'today';
  private gridEl: HTMLElement | null = null;
  private pointerDrag: DashboardPointerDragState | null = null;
  private resizing: DashboardResizeState | null = null;
  private refreshToken = 0;
  private closed = false;
  private lastRenderedTaskRevision = -1;
  private pendingTaskRevision = -1;
  /** Columns currently rendered (drops below 12 on narrow panes). */
  private displayCols = DASHBOARD_GRID_COLUMNS;
  /** True while the responsive layout has collapsed to a single full-width stacked column (phones / very narrow panes). */
  private stacked = false;
  /**
   * Display-only width/x overrides produced by the auto-fit width pass (empty cards cede slack to a
   * rich neighbour). Kept OUT of `config.grid` so the authored width is preserved and the layout
   * self-heals: each auto-fit run recomputes overrides from the authored widths, so a card that
   * fills back up simply loses its override and returns to full width. Keyed by widget config.
   */
  private autoFitWidthOverrides = new Map<DashboardWidgetConfig, { x: number; w: number }>();
  private gridResizeObserver: ResizeObserver | null = null;
  /** Last observed grid width; used to detect a hidden->shown (0 -> positive) transition. */
  private lastGridWidth = 0;
  private liveRegion: HTMLElement | null = null;
  private editMode = false;
  private selectedWidgets = new Set<DashboardWidgetConfig>();
  private editToggleBtn: HTMLButtonElement | null = null;
  private editStatusEl: HTMLElement | null = null;
  private selectAllBtn: HTMLButtonElement | null = null;
  private bulkDeleteBtn: HTMLButtonElement | null = null;
  /** Set when an unmodified template dashboard was refreshed to a newer template revision on load. */
  private templatesRefreshed = false;
  /** Monotonic id source for per-card aria-labelledby references. */
  private cardLabelSeq = 0;
  private readonly gridId = `task-manager-dashboard-grid-${dashboardViewSequence++}`;
  private readonly dailyDeleteSession: DashboardDailyDeleteSession;
  private persistedState?: Readonly<PersistedState>;
  private aggregates = buildDashboardAggregates<ParsedTask>([]);

  constructor(
    leaf: WorkspaceLeaf,
    private readonly getSettings: () => TaskManagerSettings,
    private readonly scanner: TaskScanner,
    private readonly getRenderer?: () => TaskQueryRenderer,
    private readonly onSave: () => Promise<void> = async () => {},
    private readonly stateStore?: StateStore,
    private readonly onCreateTask?: (text: string) => Promise<void>,
    private readonly fetchIcsEvents?: () => Promise<CalendarIcsEvent[]>,
    private readonly taskMutations?: TaskMutationService,
    private readonly getIndexedTasks?: () => Promise<ParsedTask[]>,
    private readonly getTaskSnapshot?: () => Promise<{ revision: number; tasks: readonly ParsedTask[] }>,
  ) {
    super(leaf);
    this.registry = buildWidgetRegistry();
    this.dailyDeleteSession = new DashboardDailyDeleteSession(this.app);
  }

  getViewType(): string {
    return VIEW_TYPE_DASHBOARD;
  }

  getDisplayText(): string {
    return 'Task dashboard';
  }

  getIcon(): string {
    return 'layout-dashboard';
  }

  private ensureDashboardCollections(): { layouts: Record<string, DashboardLayout>; templates: Record<string, DashboardTemplate> } {
    const settings = this.getSettings();
    if (!settings.dashboardLayouts || typeof settings.dashboardLayouts !== 'object') settings.dashboardLayouts = {};
    if (!settings.dashboardTemplates || typeof settings.dashboardTemplates !== 'object') settings.dashboardTemplates = {};
    return { layouts: settings.dashboardLayouts, templates: settings.dashboardTemplates };
  }

  private ensureActiveDashboardLayout(): DashboardLayout {
    const settings = this.getSettings();
    const { layouts } = this.ensureDashboardCollections();
    let activeId = settings.activeDashboardId || 'default';
    if (!layouts[activeId]) {
      const firstId = Object.keys(layouts)[0];
      if (firstId) activeId = firstId;
      else {
        const created = createDefaultDashboardLayout();
        layouts[created.id] = created;
        activeId = created.id;
      }
    }
    // Migrate every stored dashboard and refresh the ones still pristine to their source template
    // so unmodified template dashboards pick up the latest built-in template design.
    for (const id of Object.keys(layouts)) {
      const migrated = migrateDashboardLayout({ ...layouts[id], id });
      const refreshed = refreshPristineTemplateLayout(migrated);
      if (refreshed !== migrated) this.templatesRefreshed = true;
      // Fold the standalone Overdue card into the Agenda for customized default dashboards that the
      // pristine refresh leaves untouched (runs after refresh so pristine layouts regenerate first).
      const folded = foldOverdueCardIntoAgenda(refreshed);
      if (folded !== refreshed) this.templatesRefreshed = true;
      const todayMerged = mergeNextUpAgendaIntoToday(folded);
      if (todayMerged !== folded) this.templatesRefreshed = true;
      const rightRailConsolidated = consolidateDefaultRightRailIntoToday(todayMerged);
      if (rightRailConsolidated !== todayMerged) this.templatesRefreshed = true;
      const compactedSummary = compactDefaultSummaryWidget(rightRailConsolidated);
      if (compactedSummary !== rightRailConsolidated) this.templatesRefreshed = true;
      layouts[id] = dropRedundantMomentumWidget(compactedSummary);
    }
    settings.activeDashboardId = activeId;
    return layouts[activeId];
  }

  private dashboardEntries(): DashboardLayout[] {
    const { layouts } = this.ensureDashboardCollections();
    return Object.keys(layouts).map((id) => layouts[id]).filter(Boolean);
  }

  private activeDashboardId(): string {
    return this.getSettings().activeDashboardId || this.layout?.id || 'default';
  }

  async onOpen(): Promise<void> {
    this.closed = false;
    const settings = this.getSettings();
    this.activeScope = settings.dashboardScope ?? 'today';
    this.layout = this.ensureActiveDashboardLayout();
    if (this.templatesRefreshed) {
      this.templatesRefreshed = false;
      void this.onSave();
    }

    this.renderShell();
    // Production task data is revision-owned by TaskIndex. Raw vault listeners
    // remain only for legacy/fallback construction without an index snapshot.
    if (!this.getTaskSnapshot) {
      this.registerEvent(this.app.vault.on('modify', () => this.scheduleAutoRefresh()));
      this.registerEvent(this.app.vault.on('create', () => this.scheduleAutoRefresh()));
      this.registerEvent(this.app.vault.on('delete', () => this.scheduleAutoRefresh()));
      this.registerEvent(this.app.vault.on('rename', () => this.scheduleAutoRefresh()));
    }
    // When this pane is re-shown (tab switched back, split revealed), re-measure auto-fit heights:
    // anything computed while it was hidden is unreliable and may have collapsed the cards.
    this.registerEvent(this.app.workspace.on('active-leaf-change', (leaf) => {
      if (leaf === this.leaf) this.onBecameVisible();
    }));
    await this.refreshData({ live: true });
  }

  requestIndexRefresh(revision?: number): void {
    if (this.closed) return;
    if (revision !== undefined) {
      if (!dashboardRevisionShouldRefresh(this.lastRenderedTaskRevision, this.pendingTaskRevision, revision)) return;
      this.pendingTaskRevision = revision;
    }
    this.requestIndexRefreshDebounced();
  }

  onClose(): Promise<void> {
    this.closed = true;
    this.refreshToken++;
    this.gridResizeObserver?.disconnect();
    this.gridResizeObserver = null;
    this.disposeAllCards();
    this.debouncedSave.cancel();
    this.scheduleAutoRefresh.cancel();
    this.requestRefresh.cancel();
    this.requestIndexRefreshDebounced.cancel();
    this.scheduleRefit.cancel();
    this.dailyDeleteSession.clearUndoHistory();
    const recovery = this.dailyDeleteSession.recovery;
    if (recovery) new Notice(t('dashboard.delete.recoveryRetained', { paths: recovery.paths.join(', ') }));
    return Promise.resolve();
  }

  // ── Scanning ──────────────────────────────────────────────────────────────

  private async scanAllTasks(): Promise<ParsedTask[]> {
    if (this.getIndexedTasks) return this.getIndexedTasks();
    const settings = this.getSettings();
    const excluded = settings.excludedFolders ?? [];
    const files = this.app.vault.getMarkdownFiles().filter((file: TFile) => excluded.length === 0 || !isDashboardPathExcluded(file.path, excluded));
    const tasks: ParsedTask[] = [];
    for (const file of files) {
      if (isTaskNoteFile(file, this.app, settings.taskNoteFolders, settings.taskNoteMarker)) {
        const fileTask = scanFileAsTask(file, this.app, settings.supportedStates, settings.customFieldDefinitions);
        if (fileTask) tasks.push(fileTask);
      } else {
        tasks.push(...await this.scanner.scanFile(file));
      }
    }
    return tasks;
  }

  // ── Shell ─────────────────────────────────────────────────────────────────

  private renderShell(): void {
    const root = this.contentEl;
    this.disposeAllCards();
    root.empty();
    root.addClass('tm-dash');
    root.toggleClass('is-editing', this.editMode);
    this.applyAppearance(root);

    const gridId = this.gridId || 'task-manager-dashboard-grid';
    const skipLink = root.createEl('a', { text: 'Skip to dashboard widgets', cls: 'task-manager-skip-to-content', href: `#${gridId}` });
    skipLink.setAttr('aria-label', 'Skip to dashboard widgets');
    this.renderHeader(root);
    this.gridEl = root.createDiv('tm-dash-grid');
    this.gridEl.id = gridId;
    this.gridEl.setAttr('role', 'tabpanel');
    this.gridEl.setAttr('aria-labelledby', `${gridId}-scope-${this.activeScope}`);
    this.gridEl.tabIndex = -1;
    this.gridEl.style.setProperty('--tm-dash-cols', String(this.displayCols));
    // Re-applied here (not just in applyResponsiveColumns) so a re-render keeps the condensed/stacked
    // state when the column count itself is unchanged — otherwise the new grid element would lose the
    // class and silently fall back to the proportional grid on phones.
    this.gridEl.toggleClass('is-condensed', this.displayCols < DASHBOARD_GRID_COLUMNS);
    this.gridEl.toggleClass('is-stacked', this.stacked);
    this.liveRegion = root.createDiv('tm-dash-live-region');
    this.liveRegion.addClass('task-manager-sr-only');
    this.liveRegion.setAttr('aria-live', 'polite');
    this.liveRegion.setAttr('role', 'status');
    this.observeGridWidth();

    this.cards = [];
    if (!this.layout || this.layout.widgets.length === 0) {
      this.renderEmptyDashboard(this.gridEl);
      return;
    }
    for (const config of this.layout.widgets) {
      this.cards.push(this.createCard(config));
    }
    this.renderPlacements();
  }

  /** Watch the grid width and drop to fewer columns on narrow panes (keeps stored layout intact). */
  private observeGridWidth(): void {
    this.gridResizeObserver?.disconnect();
    if (typeof ResizeObserver === 'undefined' || !this.gridEl) return;
    const grid = this.gridEl;
    this.applyResponsiveColumns(grid.clientWidth);
    this.gridResizeObserver = new ResizeObserver((entries) => {
      const width = entries[0]?.contentRect.width ?? grid.clientWidth;
      const wasHidden = this.lastGridWidth <= 0;
      const widthChanged = Math.abs(width - this.lastGridWidth) >= 1;
      this.lastGridWidth = width;
      this.applyResponsiveColumns(width);
      // Width going 0 -> positive means the pane was just revealed; re-measure heights that were
      // (wrongly) computed as ~0 while it was hidden.
      if (wasHidden && width > 0) this.onBecameVisible();
      // A width change *within* a responsive band still reflows width-sensitive content (e.g. the
      // Summary rail while a Settings window or split pane is being resized). Refit immediately here:
      // a debounced pass leaves the card at the raw grid width for a moment, then snaps it to the
      // comfort rail width, which reads as a glitchy second resize.
      else if (widthChanged && width > 0 && this.isAutoFit()) this.autoFitCompact();
    });
    this.gridResizeObserver.observe(grid);
  }

  private applyResponsiveColumns(width: number): void {
    const cols = responsiveColumnCount(width);
    const stacked = shouldStackDashboard(width);
    if (cols === this.displayCols && stacked === this.stacked) return;
    this.displayCols = cols;
    this.stacked = stacked;
    this.gridEl?.style.setProperty('--tm-dash-cols', String(cols));
    this.gridEl?.toggleClass('is-condensed', cols < DASHBOARD_GRID_COLUMNS);
    this.gridEl?.toggleClass('is-stacked', stacked);
    this.renderPlacements();
  }

  private applyAppearance(root: HTMLElement): void {
    const settings = this.getSettings();
    root.removeClass('tm-dash-theme-native', 'tm-dash-theme-command-center', 'tm-dash-theme-minimal');
    root.addClass(`tm-dash-theme-${settings.dashboardTheme}`);
    root.removeClass('tm-dash-density-compact', 'tm-dash-density-comfortable', 'tm-dash-density-spacious');
    root.addClass(`tm-dash-density-${settings.dashboardDensity}`);
    root.removeClass('tm-dash-tone-daily', 'tm-dash-tone-focus', 'tm-dash-tone-planning', 'tm-dash-tone-review', 'tm-dash-tone-analytics', 'tm-dash-tone-project', 'tm-dash-tone-team', 'tm-dash-tone-custom');
    root.addClass(`tm-dash-tone-${dashboardTemplateToneForId(this.layout?.id)}`);
    root.toggleClass('tm-dash-autofit', this.isAutoFit());
  }

  private renderHeader(root: HTMLElement): void {
    const header = root.createDiv('tm-dash-header');

    const heading = header.createDiv('tm-dash-heading');
    heading.createDiv({ cls: 'tm-dash-dashboard-title', text: this.layout?.name ?? t('dashboard.title') });
    heading.createDiv({ cls: 'tm-dash-greeting', text: dashboardGreeting() });
    heading.createDiv({ cls: 'tm-dash-date', text: formatDashboardDate() });

    const actions = header.createDiv('tm-dash-actions');
    this.renderDashboardSwitcher(actions);

    const scopeGroup = actions.createDiv('tm-dash-scope');
    scopeGroup.setAttr('role', 'tablist');
    scopeGroup.setAttr('aria-label', t('dashboard.rangeLabel'));
    const scopes: Array<{ value: DashboardScope; label: string }> = [
      { value: 'today', label: t('dashboard.scope.today') },
      { value: 'week', label: t('dashboard.scope.week') },
      { value: 'month', label: t('dashboard.scope.month') },
    ];
    const scopeButtons: HTMLButtonElement[] = [];
    for (const { value, label } of scopes) {
      const selected = this.activeScope === value;
      const button = scopeGroup.createEl('button', { cls: 'tm-dash-scope-btn', text: label });
      button.id = `${this.gridId || 'task-manager-dashboard-grid'}-scope-${value}`;
      button.setAttr('role', 'tab');
      button.setAttr('aria-controls', this.gridId || 'task-manager-dashboard-grid');
      button.dataset.scope = value;
      button.toggleClass('is-active', selected);
      button.setAttr('aria-selected', String(selected));
      button.tabIndex = selected ? 0 : -1;
      button.addEventListener('click', () => { void this.setScope(value); });
      scopeButtons.push(button);
    }
    scopeGroup.addEventListener('keydown', (event: KeyboardEvent) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const current = scopeButtons.indexOf(document.activeElement as HTMLButtonElement);
      if (current < 0) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? scopeButtons.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + scopeButtons.length) % scopeButtons.length;
      scopeButtons[next]?.focus();
      scopeButtons[next]?.click();
    });

    const refreshBtn = this.iconButton(actions, 'refresh-cw', t('dashboard.action.refresh'));
    refreshBtn.addEventListener('click', () => { void this.refreshData({ live: true }); });

    const editBtn = this.iconButton(actions, 'pencil', t('dashboard.action.edit'));
    editBtn.addClass('tm-dash-edit-toggle');
    editBtn.addEventListener('click', () => this.setEditMode(!this.editMode));
    this.editToggleBtn = editBtn;

    const editControls = actions.createDiv('tm-dash-edit-controls');
    const addBtn = editControls.createEl('button', { text: 'Add widget' });
    addBtn.addClass('tm-dash-add');
    addBtn.addEventListener('click', () => this.showAddWidgetMenu(addBtn));
    const cleanupBtn = editControls.createEl('button', { text: 'Clean up layout' });
    cleanupBtn.addEventListener('click', () => this.cleanUpLayout());
    this.editStatusEl = editControls.createSpan('tm-dash-edit-status');
    this.selectAllBtn = editControls.createEl('button', { text: 'Select all' });
    this.selectAllBtn.addEventListener('click', () => this.selectAllWidgets());
    this.bulkDeleteBtn = editControls.createEl('button', { text: 'Delete selected', cls: 'mod-warning' });
    this.bulkDeleteBtn.addEventListener('click', () => this.deleteSelectedWidgets());
    const doneBtn = editControls.createEl('button', { text: t('dashboard.action.done'), cls: 'mod-cta' });
    doneBtn.addEventListener('click', () => this.setEditMode(false));
    this.updateEditControls();
  }

  private iconButton(parent: HTMLElement, icon: string, label: string): HTMLButtonElement {
    const button = parent.createEl('button', { cls: 'tm-dash-icon-btn clickable-icon' });
    setIcon(button, icon);
    button.setAttr('aria-label', label);
    button.setAttr('title', label);
    return button;
  }

  private renderDashboardSwitcher(parent: HTMLElement): void {
    const entries = this.dashboardEntries();
    const activeId = this.activeDashboardId();
    const wrap = parent.createDiv('tm-dash-dashboard-switcher');
    const select = wrap.createEl('select', { cls: 'tm-dash-dashboard-select' });
    select.setAttr('aria-label', 'Active dashboard');
    for (const layout of entries) {
      select.createEl('option', { value: layout.id, text: layout.name || layout.id });
    }
    select.value = activeId;
    select.addEventListener('change', () => { this.switchDashboard(select.value); });
    const menuBtn = this.iconButton(wrap, 'more-vertical', 'Dashboard actions');
    menuBtn.addClass('tm-dash-dashboard-menu');
    menuBtn.addEventListener('click', () => this.showDashboardMenu(menuBtn));
  }

  private renderEmptyDashboard(grid: HTMLElement): void {
    const empty = grid.createDiv('tm-dash-empty-board');
    const iconEl = empty.createDiv('tm-dash-empty-icon');
    setIcon(iconEl, 'layout-dashboard');
    empty.createEl('h3', { text: 'Your dashboard is empty' });
    empty.createEl('p', { text: 'Add widgets to surface your agenda, overdue tasks, progress and more.' });
    const cta = empty.createEl('button', { cls: 'mod-cta', text: 'Add your first widget' });
    cta.addEventListener('click', () => this.showAddWidgetMenu(cta));
  }

  // ── Cards ─────────────────────────────────────────────────────────────────

  private createCard(config: DashboardWidgetConfig): DashboardCard {
    const grid = this.gridEl;
    if (!grid) throw new Error('Dashboard grid is not initialised');
    const renderer = this.registry.getRenderer(config.type);

    const el = grid.createDiv({ cls: `tm-dash-card tm-dash-card--${normalizeDashboardWidgetSize(config.size)}` });
    applyDashboardCardVisualClasses(el, config);
    el.toggleClass('is-collapsed', Boolean(config.collapsed));
    if (this.editMode) el.setAttr('tabindex', '0'); else el.removeAttribute('tabindex');
    el.setAttr('role', 'group'); if (this.editMode) el.setAttr('aria-description', t('dashboard.keyboardLayoutHint'));
    // Label the card by its visible title via aria-labelledby (not aria-label) so Obsidian doesn't
    // render a hover tooltip over the whole card. Move/resize key hints live in the info popup.
    this.applyCardPlacement(el, config);

    const header = el.createDiv('tm-dash-card-header');
    header.setAttr('title', 'Click to collapse or expand');

    const selector = header.createEl('input', { type: 'checkbox', cls: 'tm-dash-card-select' });
    selector.checked = this.selectedWidgets.has(config);
    selector.setAttr('aria-label', `Select ${config.title} widget`);
    selector.addEventListener('click', (event) => event.stopPropagation());
    selector.addEventListener('change', () => this.setWidgetSelected(config, selector.checked));
    el.toggleClass('is-selected', selector.checked);

    const grip = header.createDiv('tm-dash-card-grip');
    setIcon(grip, 'grip-vertical');

    if (renderer?.icon) {
      const iconEl = header.createDiv('tm-dash-card-icon');
      setIcon(iconEl, renderer.icon);
    }
    const titleEl = header.createDiv({ cls: 'tm-dash-card-title', text: config.title });
    const titleId = `${this.gridId || 'task-manager-dashboard'}-card-title-${this.cardLabelSeq++}`;
    titleEl.id = titleId;
    el.setAttr('aria-labelledby', titleId);
    const badgeEl = header.createSpan({ cls: 'tm-dash-card-badge' });
    badgeEl.hide();

    const headerActions = header.createDiv('tm-dash-card-actions');
    const infoBtn = this.iconButton(headerActions, 'info', 'About this widget');
    infoBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      if (renderer) new WidgetInfoModal(this.app, renderer, config).open();
    });
    const collapseBtn = this.iconButton(headerActions, config.collapsed ? 'chevron-down' : 'chevron-up', config.collapsed ? 'Expand widget' : 'Collapse widget');
    collapseBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      this.toggleCollapse(card);
    });
    const menuBtn = this.iconButton(headerActions, 'more-horizontal', 'Widget options');
    menuBtn.addEventListener('click', (event) => {
      event.stopPropagation();
      this.showCardMenu(menuBtn, card);
    });

    const bodyEl = el.createDiv('tm-dash-card-body');
    const bodyId = `${this.gridId || 'task-manager-dashboard'}-card-body-${this.cardLabelSeq++}`;
    bodyEl.id = bodyId;
    collapseBtn.setAttr('aria-controls', bodyId);
    collapseBtn.setAttr('aria-expanded', String(!config.collapsed));

    el.addEventListener('click', (event) => {
      if (!this.editMode) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('.tm-dash-card-select, .tm-dash-card-header')) return;
      event.preventDefault();
      event.stopPropagation();
      this.setWidgetSelected(config, !this.selectedWidgets.has(config));
    }, true);

    this.createResizeHandles(el);

    const card: DashboardCard = {
      config,
      el,
      bodyEl,
      badgeEl,
      collapseBtn,
      renderGeneration: 0,
      renderBody: async () => {
        const renderGeneration = (card.renderGeneration ?? 0) + 1;
        card.renderGeneration = renderGeneration;
        if (this.closed) return;
        disposeDashboardWidget(card);
        bodyEl.empty();
        const renderHost = bodyEl.createDiv({ cls: 'tm-dash-card-render-host' });
        badgeEl.setText('');
        badgeEl.hide();
        if (config.collapsed || !renderer) {
          this.applyCardCollapseState(card);
          return;
        }
        // Re-render auto-collapsed cards open so renderers that measure their container are not
        // handed a display:none body or header-only grid span; if they are still empty, the card
        // folds again below.
        const wasAutoCollapsed = Boolean(card.autoCollapsedEmpty);
        card.autoCollapsedEmpty = false;
        this.applyCardCollapseState(card);
        if (wasAutoCollapsed) this.renderPlacements();
        try {
          const context = this.createContext(card);
          const disposer = await renderer.render(renderHost, config, context);
          if (this.closed || renderGeneration !== card.renderGeneration) {
            renderHost.remove();
            if (typeof disposer === 'function') {
              try { disposer(); } catch { /* cleanup after close/stale render must be best-effort */ }
            }
            return;
          }
          card.dispose = typeof disposer === 'function' ? disposer : undefined;
          this.applyAutoEmptyCollapse(card, dashboardCardIsAlert(config) && dashboardBodyHasTopLevelEmptyState(renderHost));
          this.applyUnderfillState(card);
          this.wireBadgeReveal(card);
        } catch {
          if (this.closed || renderGeneration !== card.renderGeneration) return;
          card.autoCollapsedEmpty = false;
          card.el.removeClass('is-alert-clear');
          this.applyCardCollapseState(card);
          bodyEl.empty();
          renderDashEmpty(bodyEl, 'alert-circle', 'This widget failed to render.');
        }
      },
    };

    header.addEventListener('click', (event) => {
      if (this.editMode) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('.tm-dash-card-actions, .tm-dash-card-select, button, input, textarea, select, a')) return;
      event.preventDefault();
      event.stopPropagation();
      this.toggleCollapse(card);
    });

    this.wireCardDrag(card);
    this.wireCardResize(card);
    this.wireCardKeyboard(card);
    return card;
  }

  /**
   * Turn a card's count badge into a one-click “reveal the full list” control when the body shows a
   * truncated list (a “+N more” affordance exists). Clicking Triage's “92” or Focus's “106” then
   * expands the card to the full filtered list and scrolls it into view, instead of the count being
   * a dead label. No-op for badges with nothing hidden (streaks, scores, fully-shown lists).
   */
  private wireBadgeReveal(card: DashboardCard): void {
    const badge = card.badgeEl;
    const clearAffordance = (): void => {
      badge.removeClass('is-clickable');
      badge.removeAttribute('role');
      badge.removeAttribute('tabindex');
      badge.onclick = null;
      badge.onkeydown = null;
      badge.removeAttribute('title');
    };
    const more = card.bodyEl.querySelector<HTMLButtonElement>('.tm-dash-more');
    if (!more || !badge.textContent) { clearAffordance(); return; }
    badge.addClass('is-clickable');
    badge.setAttr('role', 'button');
    badge.setAttr('tabindex', '0');
    badge.setAttr('title', `Show all ${badge.textContent}`);
    const reveal = (): void => {
      if (dashboardCardIsCollapsed(card)) this.toggleCollapse(card);
      card.bodyEl.querySelector<HTMLButtonElement>('.tm-dash-more')?.click();
      card.el.scrollIntoView({ block: 'nearest' });
      clearAffordance();
    };
    badge.onclick = (event) => { event.preventDefault(); event.stopPropagation(); reveal(); };
    badge.onkeydown = (event) => {
      if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); event.stopPropagation(); reveal(); }
    };
  }

  private collapsedAlertCardIsClear(card: DashboardCard): boolean {
    if (!dashboardCardIsAlert(card.config)) return false;
    if (card.config.type === 'overdue-risk') {
      return filterDashboardOverdueTasks(this.tasks, todayString()).length === 0;
    }
    if (card.config.type === 'blocked-waiting') {
      return filterDashboardActiveTasks(this.tasks).filter(isDashboardBlockedTask).length === 0;
    }
    return false;
  }

  private applyCardCollapseState(card: DashboardCard): void {
    const collapsed = dashboardCardIsCollapsed(card);
    card.el.toggleClass('is-collapsed', collapsed);
    card.el.toggleClass('is-auto-collapsed-empty', Boolean(card.autoCollapsedEmpty));
    card.bodyEl.setAttr('aria-hidden', String(collapsed));
    if (collapsed && dashboardCardIsAlert(card.config)) {
      card.el.toggleClass('is-alert-clear', this.collapsedAlertCardIsClear(card));
    }
    if (card.collapseBtn) {
      setIcon(card.collapseBtn, collapsed ? 'chevron-down' : 'chevron-up');
      card.collapseBtn.setAttr('aria-label', collapsed ? 'Expand widget' : 'Collapse widget');
      card.collapseBtn.setAttr('title', collapsed ? 'Expand widget' : 'Collapse widget');
      card.collapseBtn.setAttr('aria-expanded', String(!collapsed));
    }
  }

  private applyAutoEmptyCollapse(card: DashboardCard, isEmpty: boolean): void {
    const wasCollapsed = dashboardCardIsCollapsed(card);
    card.el.toggleClass('is-alert-clear', dashboardCardIsAlert(card.config) && isEmpty);
    if (card.config.collapsed) {
      card.autoCollapsedEmpty = false;
      this.applyCardCollapseState(card);
      return;
    }
    if (!isEmpty) {
      card.autoCollapsedEmpty = false;
      card.autoCollapseSuppressed = false;
    } else if (!card.autoCollapseSuppressed) {
      card.autoCollapsedEmpty = true;
    }
    this.applyCardCollapseState(card);
    if (wasCollapsed !== dashboardCardIsCollapsed(card)) this.renderPlacements();
  }

  /**
   * Vertically center a list card's content when it severely under-fills its footprint, so a
   * low-population card (e.g. one blocked task) reads as a deliberate, balanced state instead of a
   * single row stuck at the top above a void. Scoped to task lists; full lists and self-centering
   * empty states are untouched. Measured after layout via rAF so clientHeight is reliable.
   */
  private applyUnderfillState(card: DashboardCard): void {
    const body = card.bodyEl;
    const win = body.ownerDocument?.defaultView ?? window;
    const raf = typeof win.requestAnimationFrame === 'function' ? win.requestAnimationFrame.bind(win) : (cb: FrameRequestCallback) => win.setTimeout(() => cb(0), 16);
    raf(() => {
      if (!body.isConnected) return;
      const hasList = Boolean(body.querySelector('.tm-dash-task-list')) && !body.querySelector('.tm-dash-empty');
      const underfilled = hasList && body.clientHeight > 0 && body.scrollHeight <= body.clientHeight * 0.6;
      body.toggleClass('is-underfilled', underfilled);
    });
  }

  private createContext(card: DashboardCard): WidgetRenderContext {
    const onCreateTask = this.onCreateTask;
    const fetchIcsEvents = this.fetchIcsEvents;
    return {
      app: this.app,
      scanner: this.scanner,
      settings: this.getSettings(),
      queryRenderer: this.getRenderer?.(),
      taskMutations: this.taskMutations,
      stateStore: this.stateStore,
      state: this.persistedState,
      aggregates: this.aggregates,
      tasks: this.tasks,
      today: todayString(),
      scope: this.activeScope,
      autoFit: this.isAutoFit(),
      requestRefresh: () => this.requestRefresh(),
      requestTaskRefresh: () => { if (!this.getTaskSnapshot) this.requestRefresh(); },
      openTask: (task) => this.openTask(task),
      toggleTask: (task) => this.toggleTask(task),
      createTask: onCreateTask ? (text) => onCreateTask(text) : undefined,
      saveSettings: () => { void this.onSave(); },
      fetchIcsEvents: fetchIcsEvents ? () => fetchIcsEvents() : undefined,
      dailyDeleteSession: this.dailyDeleteSession,
      setBadge: (text) => {
        if (text) {
          card.badgeEl.setText(formatDashboardBadge(text));
          card.badgeEl.show();
        } else {
          card.badgeEl.setText('');
          card.badgeEl.hide();
        }
      },
    };
  }

  private createResizeHandles(cardEl: HTMLElement): void {
    cardEl.createDiv('tm-dash-resize-overlay');
    const handles: Array<[DashboardResizeEdge, string, string]> = [
      ['n', 'resize-vertical', 'Resize from top edge'],
      ['s', 'resize-vertical', 'Resize from bottom edge'],
      ['e', 'resize-horizontal', 'Resize from right edge'],
      ['w', 'resize-horizontal', 'Resize from left edge'],
      ['ne', 'arrow-up-right', 'Resize from top-right corner'],
      ['nw', 'arrow-up-left', 'Resize from top-left corner'],
      ['se', 'arrow-down-right', 'Resize from bottom-right corner'],
      ['sw', 'arrow-down-left', 'Resize from bottom-left corner'],
    ];
    for (const [edge, icon, label] of handles) {
      const handle = cardEl.createDiv({ cls: `tm-dash-resize-handle tm-dash-resize-handle--${edge}` });
      handle.setAttr('role', 'presentation');
      handle.setAttr('title', label);
      handle.setAttr('aria-hidden', 'true');
      setIcon(handle, icon);
      handle.dataset.edge = edge;
    }
  }

  // ── Drag to move (pointer-based, grabbed from the card header) ──────────────

  private wireCardDrag(card: DashboardCard): void {
    const header = card.el.querySelector<HTMLElement>('.tm-dash-card-header');
    if (!header) return;
    header.addEventListener('pointerdown', (event: PointerEvent) => {
      if (event.button !== 0) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('.tm-dash-card-actions, .tm-dash-resize-handle, button, input, textarea, select, a')) return;
      if (!this.editMode || this.resizing || this.pointerDrag || !card.config.grid) return;
      if (this.displayCols !== DASHBOARD_GRID_COLUMNS || this.stacked) return;

      const rect = card.el.getBoundingClientRect();
      const widgets = this.layout?.widgets ?? [];
      const state: DashboardPointerDragState = {
        card,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        grabOffsetX: event.clientX - rect.left,
        grabOffsetY: event.clientY - rect.top,
        width: rect.width,
        height: rect.height,
        metrics: this.gridMetrics(),
        active: false,
        placeholder: null,
        targetX: card.config.grid.x,
        targetY: card.config.grid.y,
        draggedIndex: widgets.indexOf(card.config),
        basePlacements: widgets.map((widget) => ({ ...(widget.grid ?? { x: 0, y: 0, ...gridFootprintForSize(normalizeDashboardWidgetSize(widget.size)) }) })),
        preview: null,
        previewKey: '',
      };
      this.pointerDrag = state;
      header.setPointerCapture(event.pointerId);

      const onMove = (moveEvent: PointerEvent) => this.onCardDragMove(moveEvent);
      const onUp = (upEvent: PointerEvent) => {
        header.removeEventListener('pointermove', onMove);
        header.removeEventListener('pointerup', onUp);
        header.removeEventListener('pointercancel', onUp);
        try { header.releasePointerCapture(upEvent.pointerId); } catch { /* capture may already be gone */ }
        this.onCardDragEnd(upEvent);
      };
      header.addEventListener('pointermove', onMove);
      header.addEventListener('pointerup', onUp);
      header.addEventListener('pointercancel', onUp);
    });
  }

  private onCardDragMove(event: PointerEvent): void {
    const state = this.pointerDrag;
    if (!state || state.pointerId !== event.pointerId || !state.card.config.grid) return;
    const dx = event.clientX - state.startX;
    const dy = event.clientY - state.startY;
    if (!state.active) {
      if (Math.hypot(dx, dy) < DASHBOARD_DRAG_THRESHOLD) return;
      this.beginCardDrag(state);
    }

    const left = event.clientX - state.grabOffsetX;
    const top = event.clientY - state.grabOffsetY;
    state.card.el.style.left = `${left}px`;
    state.card.el.style.top = `${top}px`;

    const { w, h } = state.card.config.grid;
    const cell = this.cellFromPoint(state.metrics, left, top);
    state.targetX = Math.max(0, Math.min(state.metrics.cols - w, cell.col));
    state.targetY = Math.max(0, cell.row);
    if (state.placeholder) {
      state.placeholder.style.gridColumn = `${state.targetX + 1} / span ${w}`;
      state.placeholder.style.gridRow = `${state.targetY + 1} / span ${h}`;
    }
    this.previewDragLayout(state);
  }

  /** Recompute the resolved layout for the current target and reflow the other cards live. */
  private previewDragLayout(state: DashboardPointerDragState): void {
    if (!state.active || !this.layout || state.draggedIndex < 0 || !state.card.config.grid) return;
    const { w, h } = state.card.config.grid;
    const base = state.basePlacements.map((placement) => ({ ...placement }));
    base[state.draggedIndex] = { x: state.targetX, y: state.targetY, w, h };
    const direction = gridDropPushDirection(base, state.draggedIndex);
    const resolved = resolveDirectionalCollisions(base, state.draggedIndex, direction, state.metrics.cols);
    const key = resolved.map((p) => `${p.x},${p.y},${p.w},${p.h}`).join('|');
    if (key === state.previewKey) return;
    state.previewKey = key;
    state.preview = resolved;
    this.applyPreviewPlacements(resolved, state.draggedIndex);
  }

  /** Apply a preview layout to every non-dragged card, animating the shift with a FLIP transition. */
  private applyPreviewPlacements(resolved: readonly DashboardGridPlacement[], draggedIndex: number): void {
    if (!this.layout) return;
    const widgets = this.layout.widgets;
    const moving: Array<{ el: HTMLElement; first: DOMRect }> = [];
    widgets.forEach((config, index) => {
      if (index === draggedIndex) return;
      const card = this.cardForConfig(config);
      if (card) moving.push({ el: card.el, first: card.el.getBoundingClientRect() });
    });
    widgets.forEach((config, index) => {
      if (index === draggedIndex) return;
      const card = this.cardForConfig(config);
      const placement = resolved[index];
      if (!card || !placement) return;
      const rowSpan = dashboardCardIsCollapsed(card) ? DASHBOARD_COLLAPSED_SPAN : placement.h;
      card.el.style.gridColumn = `${placement.x + 1} / span ${placement.w}`;
      card.el.style.gridRow = `${placement.y + 1} / span ${rowSpan}`;
    });
    for (const item of moving) {
      const last = item.el.getBoundingClientRect();
      const dx = item.first.left - last.left;
      const dy = item.first.top - last.top;
      if (!dx && !dy) continue;
      item.el.style.transition = 'none';
      item.el.style.transform = `translate(${dx}px, ${dy}px)`;
      void item.el.offsetWidth; // force reflow so the next change animates
      item.el.style.transition = 'transform 140ms ease';
      item.el.style.transform = '';
    }
  }

  private cardForConfig(config: DashboardWidgetConfig): DashboardCard | undefined {
    return this.cards.find((card) => card.config === config);
  }

  private beginCardDrag(state: DashboardPointerDragState): void {
    state.active = true;
    const { card } = state;
    const grid = card.config.grid;
    card.el.addClass('is-dragging');
    card.el.style.width = `${state.width}px`;
    card.el.style.height = `${state.height}px`;
    card.el.style.position = 'fixed';
    card.el.style.margin = '0';
    card.el.style.zIndex = '50';
    card.el.style.pointerEvents = 'none';

    if (this.gridEl && grid) {
      const placeholder = this.gridEl.createDiv('tm-dash-card-placeholder');
      placeholder.setAttr('aria-hidden', 'true');
      placeholder.style.gridColumn = `${grid.x + 1} / span ${grid.w}`;
      placeholder.style.gridRow = `${grid.y + 1} / span ${grid.h}`;
      state.placeholder = placeholder;
    }
  }

  private onCardDragEnd(event: PointerEvent): void {
    const state = this.pointerDrag;
    this.pointerDrag = null;
    if (!state || state.pointerId !== event.pointerId) return;
    const { card } = state;
    card.el.removeClass('is-dragging');
    for (const prop of ['position', 'left', 'top', 'width', 'height', 'margin', 'zIndex', 'pointerEvents'] as const) {
      card.el.style[prop] = '';
    }
    state.placeholder?.remove();
    if (!state.active || !card.config.grid || !this.layout) {
      this.applyCardPlacement(card.el, card.config);
      return;
    }
    this.commitDrag(state);
  }

  /** Commit the previewed reflow: write every widget's resolved placement and persist. */
  private commitDrag(state: DashboardPointerDragState): void {
    if (!this.layout) return;
    const { w, h } = state.card.config.grid ?? { w: DASHBOARD_MIN_W, h: DASHBOARD_MIN_H };
    const base = state.basePlacements.map((placement) => ({ ...placement }));
    if (state.draggedIndex >= 0) base[state.draggedIndex] = { x: state.targetX, y: state.targetY, w, h };
    const direction = gridDropPushDirection(base, state.draggedIndex);
    const resolved = state.preview ?? resolveDirectionalCollisions(base, state.draggedIndex, direction, state.metrics.cols);
    this.layout.widgets.forEach((config, index) => {
      const placement = resolved[index];
      if (placement) config.grid = clampGridPlacement(placement, state.metrics.cols);
    });
    this.clearPreviewTransitions();
    this.commitLayoutChange();
  }

  private clearPreviewTransitions(): void {
    for (const card of this.cards) {
      card.el.style.transition = '';
      card.el.style.transform = '';
    }
  }

  // ── Keyboard move / resize (card frame focused) ────────────────────────────

  private wireCardKeyboard(card: DashboardCard): void {
    card.el.addEventListener('keydown', (event: KeyboardEvent) => {
      if (event.target !== card.el) return; // only when the card frame itself is focused
      if (!this.editMode) return;
      if (this.displayCols !== DASHBOARD_GRID_COLUMNS || this.stacked) return; // condensed / stacked view is read-only
      const delta = ({ ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] } as Record<string, [number, number]>)[event.key];
      if (!delta) return;
      event.preventDefault();
      if (event.shiftKey) this.keyboardResize(card, delta[0], delta[1]);
      else this.keyboardMove(card, delta[0], delta[1]);
    });
  }

  private keyboardMove(card: DashboardCard, dx: number, dy: number): void {
    if (!this.layout || !card.config.grid) return;
    const next = clampGridPlacement({ x: card.config.grid.x + dx, y: card.config.grid.y + dy, w: card.config.grid.w, h: card.config.grid.h });
    if (next.x === card.config.grid.x && next.y === card.config.grid.y) return;
    card.config.grid = next;
    this.resolveLayoutCollisions(card.config);
    this.commitLayoutChange();
    this.announce(`${card.config.title} moved to column ${next.x + 1}, row ${next.y + 1}.`);
  }

  private keyboardResize(card: DashboardCard, dw: number, dh: number): void {
    if (!this.layout || !card.config.grid) return;
    const grid = card.config.grid;
    const w = Math.max(DASHBOARD_MIN_W, Math.min(this.displayCols - grid.x, grid.w + dw));
    const h = Math.max(DASHBOARD_MIN_H, grid.h + dh);
    if (w === grid.w && h === grid.h) return;
    const next = clampGridPlacement({ x: grid.x, y: grid.y, w, h });
    card.config.grid = next;
    this.applyCardSizeClass(card, sizeFromGridFootprint(next.w, next.h));
    this.resolveLayoutCollisions(card.config);
    this.commitLayoutChange({ rerender: card });
    this.announce(`${card.config.title} resized to ${next.w} by ${next.h} cells.`);
  }

  // ── Resize (drag any edge or corner) ───────────────────────────────────────

  private wireCardResize(card: DashboardCard): void {
    const handles = Array.from(card.el.querySelectorAll<HTMLElement>('.tm-dash-resize-handle'));
    for (const handle of handles) {
      handle.addEventListener('pointerdown', (event: PointerEvent) => {
        event.preventDefault();
        event.stopPropagation();
        if (event.button !== 0) return;
        const edge = handle.dataset.edge as DashboardResizeEdge | undefined;
        if (!edge || !card.config.grid || !this.editMode || this.pointerDrag || this.resizing) return;
        if (this.displayCols !== DASHBOARD_GRID_COLUMNS || this.stacked) return;
        handle.setPointerCapture(event.pointerId);
        const overlay = this.ensureResizeOverlay(card.el);
        card.el.addClass('is-resizing');
        const widgets = this.layout?.widgets ?? [];
        const metrics = this.gridMetrics();
        const useWidthOverrides = this.isAutoFit() && this.displayCols === DASHBOARD_GRID_COLUMNS;
        const resizePlacement = (widget: DashboardWidgetConfig): DashboardGridPlacement => {
          const grid = widget.grid ?? { x: 0, y: 0, ...gridFootprintForSize(normalizeDashboardWidgetSize(widget.size)) };
          const override = useWidthOverrides ? this.autoFitWidthOverrides.get(widget) : undefined;
          return override ? { ...grid, x: override.x, w: override.w } : { ...grid };
        };
        const start = resizePlacement(card.config);
        // Once the user directly resizes in the displayed layout, treat the displayed widths as the
        // resize baseline. Otherwise a rail widened by the comfort pass appears to shrink on drag and
        // then snap back when auto-fit reapplies the override.
        if (useWidthOverrides) this.autoFitWidthOverrides.clear();
        const contentFitH = this.isAutoFit() && card.config.type === 'stats'
          ? this.measureCardContentRows(card, metrics.cellH, metrics.gap)
          : undefined;
        this.resizing = {
          card,
          edge,
          pointerId: event.pointerId,
          startX: event.clientX,
          startY: event.clientY,
          start,
          metrics,
          overlay,
          current: { ...start },
          index: widgets.indexOf(card.config),
          basePlacements: widgets.map(resizePlacement),
          preview: null,
          previewKey: '',
          contentFitH,
        };
        this.updateResizeOverlay(overlay, start.w, start.h);

        const onMove = (moveEvent: PointerEvent) => this.updateCardResize(moveEvent);
        const onUp = (upEvent: PointerEvent) => {
          handle.removeEventListener('pointermove', onMove);
          handle.removeEventListener('pointerup', onUp);
          handle.removeEventListener('pointercancel', onUp);
          try { handle.releasePointerCapture(upEvent.pointerId); } catch { /* capture may already be gone */ }
          this.finishCardResize(upEvent.pointerId);
        };
        handle.addEventListener('pointermove', onMove);
        handle.addEventListener('pointerup', onUp);
        handle.addEventListener('pointercancel', onUp);
      });
    }
  }

  private updateCardResize(event: PointerEvent): void {
    const state = this.resizing;
    if (!state || state.pointerId !== event.pointerId) return;
    const colUnit = state.metrics.cellW + state.metrics.gap;
    const rowUnit = state.metrics.cellH + state.metrics.gap;
    const dCol = colUnit > 0 ? Math.round((event.clientX - state.startX) / colUnit) : 0;
    const dRow = rowUnit > 0 ? Math.round((event.clientY - state.startY) / rowUnit) : 0;
    const { edge, metrics } = state;
    let { x, y, w, h } = state.start;
    const right = state.start.x + state.start.w;
    const bottom = state.start.y + state.start.h;
    if (edge.includes('e')) w = Math.max(DASHBOARD_MIN_W, Math.min(metrics.cols - x, state.start.w + dCol));
    if (edge.includes('w')) {
      x = Math.max(0, Math.min(right - DASHBOARD_MIN_W, state.start.x + dCol));
      w = right - x;
    }
    if (edge.includes('s')) h = Math.max(DASHBOARD_MIN_H, state.start.h + dRow);
    if (edge.includes('n')) {
      y = Math.max(0, Math.min(bottom - DASHBOARD_MIN_H, state.start.y + dRow));
      h = bottom - y;
    }
    if (state.card.config.type === 'stats' && colUnit > 0) {
      const minSummaryW = Math.min(metrics.cols, Math.max(DASHBOARD_MIN_W, Math.floor((DASHBOARD_RAIL_MIN_PX + metrics.gap) / colUnit)));
      if (w < minSummaryW) {
        w = Math.min(minSummaryW, metrics.cols - x);
        if (edge.includes('w')) {
          w = Math.min(minSummaryW, right);
          x = Math.max(0, right - w);
        }
      }
    }
    if (state.contentFitH !== undefined) {
      h = state.contentFitH;
      if (edge.includes('n')) y = Math.max(0, bottom - h);
    }
    const current = { x, y, w, h };
    state.current = current;
    state.card.config.grid = current;
    this.applyCardPlacement(state.card.el, state.card.config);
    this.updateResizeOverlay(state.overlay, w, h);
    this.previewResizeLayout(state);
  }

  /** Reflow neighbours live while resizing, pushing them away from the growing edge. */
  private previewResizeLayout(state: DashboardResizeState): void {
    if (!this.layout || state.index < 0) return;
    const base = state.basePlacements.map((placement) => ({ ...placement }));
    base[state.index] = { ...state.current };
    const direction = resizeEdgePushDirection(state.edge);
    const resolved = resolveDirectionalCollisions(base, state.index, direction, state.metrics.cols);
    const key = resolved.map((p) => `${p.x},${p.y},${p.w},${p.h}`).join('|');
    if (key === state.previewKey) return;
    state.previewKey = key;
    state.preview = resolved;
    this.applyPreviewPlacements(resolved, state.index);
  }

  private finishCardResize(pointerId: number): void {
    const state = this.resizing;
    if (!state || state.pointerId !== pointerId) return;
    this.resizing = null;
    state.overlay.removeClass('is-visible');
    state.card.el.removeClass('is-resizing');
    const rawPlacement = clampGridPlacement(state.current);
    // Auto-fit cards should not visibly land at the user's dragged height and then snap again after
    // the debounced content measurement runs. Summary is especially content-fixed: its stat tiles own
    // the height, so normalize the persisted resize to its natural content rows immediately on pointer
    // up. This keeps resize behaviour single-step while preserving horizontal resizing.
    const contentFitHeight = state.contentFitH ?? rawPlacement.h;
    const placement = contentFitHeight !== rawPlacement.h
      ? clampGridPlacement({
        ...rawPlacement,
        y: state.edge.includes('n') ? Math.max(0, rawPlacement.y + rawPlacement.h - contentFitHeight) : rawPlacement.y,
        h: contentFitHeight,
      })
      : rawPlacement;
    state.card.config.grid = placement;
    this.applyCardSizeClass(state.card, sizeFromGridFootprint(placement.w, placement.h));
    if (this.layout && state.index >= 0) {
      const base = state.basePlacements.map((p) => ({ ...p }));
      base[state.index] = placement;
      const direction = resizeEdgePushDirection(state.edge);
      const resolved = resolveDirectionalCollisions(base, state.index, direction, state.metrics.cols);
      this.layout.widgets.forEach((config, index) => {
        const next = resolved[index];
        if (next) config.grid = clampGridPlacement(next, state.metrics.cols);
      });
    } else {
      this.resolveLayoutCollisions(state.card.config);
    }
    this.clearPreviewTransitions();
    // Summary is content-sized and has no data-dependent rerender after a resize. Running the normal
    // post-resize auto-fit pass immediately reintroduces display-only rail width overrides, which made
    // the card visibly resize once and then snap a second time. Persist/render the resolved placement
    // directly for Summary; background refreshes can still refit later if data actually changes.
    this.commitLayoutChange({ rerender: state.card.config.type === 'stats' ? undefined : state.card, skipAutoFit: state.card.config.type === 'stats' });
  }

  // ── Grid geometry + placement ──────────────────────────────────────────────

  private gridMetrics(): DashboardGridMetrics {
    const fallback: DashboardGridMetrics = { left: 0, top: 0, cellW: 1, cellH: 1, gap: 0, cols: DASHBOARD_GRID_COLUMNS };
    const grid = this.gridEl;
    if (!grid) return fallback;
    const rect = grid.getBoundingClientRect();
    const styles = getComputedStyle(grid);
    const gap = parseFloat(styles.columnGap || styles.gap || '0') || 0;
    const padLeft = parseFloat(styles.paddingLeft) || 0;
    const padRight = parseFloat(styles.paddingRight) || 0;
    const padTop = parseFloat(styles.paddingTop) || 0;
    const cols = this.displayCols;
    const contentWidth = Math.max(0, rect.width - padLeft - padRight);
    const cellW = (contentWidth - gap * (cols - 1)) / cols;
    const rowH = parseFloat(styles.getPropertyValue('--tm-dash-row-h')) || 110;
    return { left: rect.left + padLeft, top: rect.top + padTop, cellW, cellH: rowH, gap, cols };
  }

  private cellFromPoint(metrics: DashboardGridMetrics, left: number, top: number): { col: number; row: number } {
    const colUnit = metrics.cellW + metrics.gap;
    const rowUnit = metrics.cellH + metrics.gap;
    const col = colUnit > 0 ? Math.round((left - metrics.left) / colUnit) : 0;
    const row = rowUnit > 0 ? Math.round((top - metrics.top) / rowUnit) : 0;
    return { col, row };
  }

  private applyCardPlacement(cardEl: HTMLElement, config: DashboardWidgetConfig): void {
    const grid = config.grid ?? { x: 0, y: 0, ...gridFootprintForSize(normalizeDashboardWidgetSize(config.size)) };
    const card = this.cardForConfig(config);
    const h = dashboardEffectiveGridRowSpan(Boolean(card ? dashboardCardIsCollapsed(card) : config.collapsed), grid.h);
    cardEl.style.gridColumn = `${grid.x + 1} / span ${grid.w}`;
    cardEl.style.gridRow = `${grid.y + 1} / span ${h}`;
    applyDashboardCardVisualClasses(cardEl, config);
  }

  private renderPlacements(): void {
    if (!this.layout) {
      for (const card of this.cards) this.applyCardPlacement(card.el, card.config);
      return;
    }
    const widgets = this.layout.widgets;
    const base = widgets.map((widget) => widget.grid ?? { x: 0, y: 0, ...gridFootprintForSize(normalizeDashboardWidgetSize(widget.size)) });
    const display = this.displayCols < DASHBOARD_GRID_COLUMNS
      ? scaleGridPlacements(base, DASHBOARD_GRID_COLUMNS, this.displayCols)
      : base;
    // Width overrides only make sense at full resolution and while auto-fit owns the layout.
    const useWidthOverrides = this.isAutoFit() && this.displayCols === DASHBOARD_GRID_COLUMNS;
    widgets.forEach((config, index) => {
      const card = this.cardForConfig(config);
      const placement = display[index];
      if (!card || !placement) return;
      card.el.style.transition = '';
      card.el.style.transform = '';
      card.el.style.order = config.type === 'quick-capture' ? '-1' : '';
      const override = useWidthOverrides ? this.autoFitWidthOverrides.get(config) : undefined;
      const x = override ? override.x : placement.x;
      const w = override ? override.w : placement.w;
      const rowSpan = dashboardEffectiveGridRowSpan(dashboardCardIsCollapsed(card), placement.h);
      card.el.style.gridColumn = `${x + 1} / span ${w}`;
      card.el.style.gridRow = `${placement.y + 1} / span ${rowSpan}`;
    });
  }

  // ── Auto-fit: derive each card's height from its content, then compact columns ──────

  /** Whether card heights should be derived from content (default on). */
  private isAutoFit(): boolean {
    return this.getSettings().dashboardAutoFitHeights !== false;
  }

  /** True only when the grid is actually laid out on screen (not behind a hidden tab / collapsed). */
  private isViewVisible(): boolean {
    const grid = this.gridEl;
    if (!grid) return false;
    if (grid.offsetParent === null) return false; // display:none on this element or an ancestor
    return grid.getBoundingClientRect().width > 0;
  }

  /**
   * Re-measure auto-fit heights once the pane is shown again. Heights measured while the tab was
   * hidden are unreliable (offsetHeight 0), so we recompute on the next frame after the grid has
   * real dimensions. Safe to call repeatedly; it no-ops unless auto-fit is on and the view is shown.
   */
  private onBecameVisible(): void {
    if (!this.isAutoFit() || this.cards.length === 0) return;
    const win = this.gridEl?.ownerDocument?.defaultView ?? window;
    const raf = typeof win.requestAnimationFrame === 'function'
      ? win.requestAnimationFrame.bind(win)
      : (cb: FrameRequestCallback) => win.setTimeout(() => cb(0), 16);
    raf(() => { if (this.isViewVisible()) this.autoFitCompact(); });
  }

  /**
   * Measure a card's natural content height (independent of the grid-forced height) and convert it
   * to a count of fine grid rows. The body is briefly forced to content-size so an under-filled card
   * reports its true (short) height instead of the stretched flex box.
   */
  private measureCardContentRows(card: DashboardCard, rowH: number, gap: number): number {
    if (dashboardCardIsCollapsed(card)) return dashboardEffectiveGridRowSpan(true, card.config.grid?.h ?? 0);
    const header = card.el.querySelector<HTMLElement>('.tm-dash-card-header');
    const headerH = header ? header.offsetHeight : 0;
    const body = card.bodyEl;
    const prevFlex = body.style.flex;
    const prevHeight = body.style.height;
    // Hug content instead of flex:1 stretching. During refits the body may inherit a stretched height,
    // so measure rendered descendant bounds rather than the body box.
    body.style.flex = '0 0 auto';
    body.style.height = 'auto';
    const bodyRect = body.getBoundingClientRect();
    const bodyStyle = getComputedStyle(body);
    const bodyPaddingBottom = parseFloat(bodyStyle.paddingBottom) || 0;
    // Render hosts use display:contents: their own zero-sized box cannot represent widget controls.
    const contentBottom = Array.from(body.querySelectorAll('*')).reduce((bottom, child) => {
      const childEl = child as HTMLElement;
      return Math.max(bottom, childEl.getBoundingClientRect().bottom - bodyRect.top);
    }, 0);
    const bodyNatural = contentBottom > 0 ? Math.ceil(contentBottom + bodyPaddingBottom) : body.offsetHeight;
    body.style.flex = prevFlex;
    body.style.height = prevHeight;
    const cs = getComputedStyle(card.el);
    const chrome = (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0)
      + (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    const naturalPx = headerH + bodyNatural + chrome + 3; // +3px so content isn't flush to the edge
    const rowUnit = rowH + gap;
    const rows = rowUnit > 0 ? Math.ceil((naturalPx + gap) / rowUnit) : DASHBOARD_MIN_H;
    // Clamp: keep a minimum presence; cap runaway (the content cap already bounds list length).
    return Math.max(5, Math.min(90, rows));
  }

  /**
   * Recompute every card's height from its rendered content, then gravity-compact each column so
   * freed space flows to the cards that need it. Preserves x / width / relative order; only h and y
   * change. Skipped during drag/resize and when the pane is in a condensed (responsive) column count.
   */
  private autoFitCompact(): void {
    if (!this.layout || !this.isAutoFit()) { return; }
    if (this.pointerDrag || this.resizing) { return; }
    if (this.displayCols !== DASHBOARD_GRID_COLUMNS || this.stacked) { return; }
    if (this.cards.length === 0) { return; }
    // Never measure while the pane is hidden (e.g. another tab is in front). Hidden cards report
    // offsetHeight 0, which would collapse every card to the row-minimum and persist that into
    // config.grid — the “dashboard looks broken after viewing another note” bug. We re-measure on
    // becoming visible again (see onBecameVisible).
    if (!this.isViewVisible()) { return; }
    try {
      const metrics = this.gridMetrics();
      const rowH = metrics.cellH;
      const gap = metrics.gap;
      const widgets = this.layout.widgets;
      const placements = widgets.map((config) => {
        const g = config.grid ?? { x: 0, y: 0, ...gridFootprintForSize(normalizeDashboardWidgetSize(config.size)) };
        return { x: g.x, y: g.y, w: g.w, h: g.h };
      });
      // Track which cards are rendering an empty state so the width pass can hand their slack away.
      const empties: boolean[] = widgets.map(() => false);
      widgets.forEach((config, index) => {
        // Scrollable widget types (calendars, boards) rely on a fixed inner viewport — keep their
        // authored height and let the body scroll rather than measuring (which would mis-size them).
        if (dashboardWidgetAllowsInnerScroll(config)) return;
        const card = this.cardForConfig(config);
        if (!card) return;
        try {
          // Auto-collapsed empty cards already make room vertically. Do not also feed them into
          // the display-only width redistribution pass, or toggling the fold arrow makes nearby
          // cards appear to change widths. Keep widths stable for session-expanded empty cards too.
          empties[index] = false;
          placements[index].h = this.measureCardContentRows(card, rowH, gap);
        } catch {
          // Per-card measurement is best-effort; skip a card that can't be measured.
        }
      });
      // Gravity compaction: process top-to-bottom (then left-to-right), dropping each card to sit just
      // below any already-placed card whose horizontal span overlaps it. Handles full-width spanners.
      // Empty all-clear alert strips are useful confirmation, but they should not interrupt the
      // primary reading flow in the center column; float them after populated work cards in the same
      // horizontal span so a collapsed Overdue card does not create a visual break before Agenda.
      const compactRank = (index: number): number => {
        const card = this.cardForConfig(widgets[index]);
        return card && card.config.type === 'overdue-risk' && dashboardCardIsCollapsed(card) && this.collapsedAlertCardIsClear(card) ? 1 : 0;
      };
      const order = placements.map((_, i) => i).sort((a, b) => (compactRank(a) - compactRank(b)) || (placements[a].y - placements[b].y) || (placements[a].x - placements[b].x));
      const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
      for (const i of order) {
        const p = placements[i];
        let y = 0;
        for (const q of placed) {
          if (p.x < q.x + q.w && q.x < p.x + p.w) y = Math.max(y, q.y + q.h);
        }
        p.y = y;
        placed.push(p);
      }
      // Snapshot the authored x/w (+ compacted y, measured h) BEFORE the width pass: these are what we
      // persist to config.grid, so the authored width survives and the layout self-heals when a card
      // refills. The width pass then mutates a copy to derive display-only overrides.
      const persisted = placements.map((p) => ({ ...p }));
      // Width pass: an empty card cedes horizontal slack to a content-rich card beside it (e.g. an
      // empty Agenda narrows so Next actions widens) without disturbing the rest of the board.
      redistributeEmptyCardWidths(placements, empties, { minEmptyW: 2 * DASHBOARD_GRID_SCALE, step: DASHBOARD_GRID_SCALE, cols: DASHBOARD_GRID_COLUMNS });
      // Column pass: cap content-light side rails at a comfort ceiling and hand the slack to the
      // widest (primary) column, so the middle list column — not the sparse rails — absorbs the room
      // a wide pane offers. Display-only, like the empty-card pass; no-op unless the board is a clean
      // set of edge-to-edge columns with one widest column.
      const colUnit = metrics.cellW + gap;
      if (colUnit > 0) {
        const maxSideW = Math.max(DASHBOARD_MIN_W, Math.floor((DASHBOARD_RAIL_MAX_PX + gap) / colUnit));
        const floorSideW = Math.max(DASHBOARD_MIN_W, Math.floor((DASHBOARD_RAIL_MIN_PX + gap) / colUnit));
        redistributeRailWidthsToPrimary(placements, {
          maxSideW,
          minSideW: DASHBOARD_MIN_W * DASHBOARD_GRID_SCALE,
          floorSideW,
          cols: DASHBOARD_GRID_COLUMNS,
        });
      }
      const prevOverrides = this.autoFitWidthOverrides;
      const nextOverrides = new Map<DashboardWidgetConfig, { x: number; w: number }>();
      let changed = false;
      widgets.forEach((config, index) => {
        const next = persisted[index];
        const prev = config.grid;
        if (!prev || prev.y !== next.y || prev.h !== next.h || prev.x !== next.x || prev.w !== next.w) changed = true;
        config.grid = { x: next.x, y: next.y, w: next.w, h: next.h };
        // Record a display-only override wherever the width pass moved the card off its authored span;
        // mark changed only when the *displayed* width actually differs from the previous render.
        const disp = placements[index];
        const prevOv = prevOverrides.get(config);
        if (disp.x !== next.x || disp.w !== next.w) {
          nextOverrides.set(config, { x: disp.x, w: disp.w });
          if (!prevOv || prevOv.x !== disp.x || prevOv.w !== disp.w) changed = true;
        } else if (prevOv) {
          changed = true; // override cleared (card refilled) — restore authored width
        }
      });
      this.autoFitWidthOverrides = nextOverrides;
      if (changed) this.renderPlacements();
    } catch {
      // Measurement is best-effort; never let it break the data refresh / card render.
    }
  }

  /** Announce a move/resize to assistive tech. */
  private announce(message: string): void {
    if (this.liveRegion) this.liveRegion.setText(message);
  }

  /** Resolve overlaps after a move/resize, keeping the anchored widget put (free placement). */
  private resolveLayoutCollisions(anchor: DashboardWidgetConfig): void {
    if (!this.layout) return;
    const widgets = this.layout.widgets;
    const placements = widgets.map((widget) => (widget.grid ??= { x: 0, y: 0, ...gridFootprintForSize(normalizeDashboardWidgetSize(widget.size)) }));
    resolveGridCollisions(placements, widgets.indexOf(anchor));
    widgets.forEach((widget, index) => { widget.grid = placements[index]; });
  }

  private commitLayoutChange(opts?: { rerender?: DashboardCard; skipAutoFit?: boolean }): void {
    this.renderPlacements();
    this.persist();
    if (opts?.skipAutoFit) return;
    const refit = () => { if (this.isAutoFit()) this.autoFitCompact(); };
    if (opts?.rerender) void opts.rerender.renderBody().then(refit);
    else refit();
  }

  private cleanUpLayout(): void {
    if (!this.layout || this.layout.widgets.length === 0) return;
    const base = this.layout.widgets.map((widget) => widget.grid ?? { x: 0, y: 0, ...gridFootprintForSize(normalizeDashboardWidgetSize(widget.size)) });
    const compacted = compactGridPlacements(base, DASHBOARD_GRID_COLUMNS);
    let changed = false;
    this.layout.widgets.forEach((widget, index) => {
      const next = compacted[index];
      if (!next) return;
      const current = widget.grid;
      if (!current || current.x !== next.x || current.y !== next.y || current.w !== next.w || current.h !== next.h) changed = true;
      widget.grid = next;
    });
    if (!changed) {
      new Notice('Task Manager: dashboard layout is already clean.');
      return;
    }
    this.commitLayoutChange();
    this.announce('Dashboard layout cleaned up.');
    new Notice('Task Manager: dashboard layout cleaned up.');
  }

  private setEditMode(enabled: boolean): void {
    this.editMode = enabled;
    this.contentEl.toggleClass('is-editing', enabled);
    if (!enabled) this.selectedWidgets.clear();
    for (const card of this.cards) {
      const selected = this.selectedWidgets.has(card.config); card.el.toggleClass('is-selected', selected);
      if (enabled) { card.el.setAttr('tabindex', '0'); card.el.setAttr('aria-description', t('dashboard.keyboardLayoutHint')); } else { card.el.removeAttribute('tabindex'); card.el.removeAttribute('aria-description'); }
      const checkbox = card.el.querySelector<HTMLInputElement>('.tm-dash-card-select');
      if (checkbox) checkbox.checked = selected;
    }
    this.updateEditControls();
    this.announce(enabled ? 'Dashboard edit mode enabled.' : 'Dashboard edit mode disabled.');
  }

  private setWidgetSelected(config: DashboardWidgetConfig, selected: boolean): void {
    if (selected) this.selectedWidgets.add(config);
    else this.selectedWidgets.delete(config);
    const card = this.cardForConfig(config);
    if (card) {
      card.el.toggleClass('is-selected', selected);
      const checkbox = card.el.querySelector<HTMLInputElement>('.tm-dash-card-select');
      if (checkbox) checkbox.checked = selected;
    }
    this.updateEditControls();
  }

  private selectAllWidgets(): void {
    if (!this.layout) return;
    const allSelected = this.layout.widgets.length > 0 && this.selectedWidgets.size >= this.layout.widgets.length;
    this.selectedWidgets.clear();
    if (!allSelected) {
      for (const widget of this.layout.widgets) this.selectedWidgets.add(widget);
    }
    for (const card of this.cards) {
      const selected = this.selectedWidgets.has(card.config);
      card.el.toggleClass('is-selected', selected);
      const checkbox = card.el.querySelector<HTMLInputElement>('.tm-dash-card-select');
      if (checkbox) checkbox.checked = selected;
    }
    this.updateEditControls();
  }

  private deleteSelectedWidgets(): void {
    if (!this.layout || this.selectedWidgets.size === 0) return;
    const selected = new Set(this.selectedWidgets);
    const count = selected.size;
    confirmSettingsRemoval(this.app, `${count} selected dashboard widget${count === 1 ? '' : 's'}`, () => {
      this.deleteSelectedWidgetsConfirmed(selected, count);
      return Promise.resolve();
    }, {
      title: `Delete ${count} widget${count === 1 ? '' : 's'}?`,
      description: 'This permanently removes the selected widgets from the current dashboard layout.',
      confirmLabel: 'Delete widgets',
    });
  }

  private deleteSelectedWidgetsConfirmed(selected: ReadonlySet<DashboardWidgetConfig>, count: number): void {
    if (!this.layout) return;
    for (const card of this.cards) {
      if (!selected.has(card.config)) continue;
      disposeDashboardWidget(card);
      card.el.remove();
    }
    this.cards = this.cards.filter((card) => !selected.has(card.config));
    this.layout.widgets = this.layout.widgets.filter((config) => !selected.has(config));
    this.selectedWidgets.clear();
    if (this.layout.widgets.length === 0) {
      this.setEditMode(false);
      if (this.gridEl) {
        this.gridEl.empty();
        this.renderEmptyDashboard(this.gridEl);
      }
    } else {
      this.renderPlacements();
      this.updateEditControls();
    }
    this.persist();
    new Notice(`Task Manager: deleted ${count} widget${count === 1 ? '' : 's'}.`);
  }

  private updateEditControls(): void {
    const count = this.selectedWidgets.size;
    const total = this.layout?.widgets.length ?? 0;
    if (this.editToggleBtn) {
      setIcon(this.editToggleBtn, this.editMode ? 'x' : 'pencil');
      this.editToggleBtn.setAttr('aria-label', this.editMode ? 'Exit widget edit mode' : 'Edit widgets');
      this.editToggleBtn.setAttr('title', this.editMode ? 'Exit widget edit mode' : 'Edit widgets');
    }
    if (this.editStatusEl) this.editStatusEl.setText(`${count} selected`);
    if (this.bulkDeleteBtn) this.bulkDeleteBtn.disabled = count === 0;
    if (this.selectAllBtn) this.selectAllBtn.setText(total > 0 && count >= total ? 'Clear selection' : 'Select all');
  }

  // ── Dashboard collection operations ────────────────────────────────────────

  private activateDashboard(layout: DashboardLayout): void {
    const settings = this.getSettings();
    const { layouts } = this.ensureDashboardCollections();
    layouts[layout.id] = layout;
    settings.activeDashboardId = layout.id;
    this.layout = layout;
    this.selectedWidgets.clear();
    this.editMode = false;
    this.renderShell();
    void this.refreshData({ live: true });
    this.debouncedSave();
  }

  private switchDashboard(id: string): void {
    const { layouts } = this.ensureDashboardCollections();
    if (!layouts[id] || id === this.activeDashboardId()) return;
    const migrated = migrateDashboardLayout({ ...layouts[id], id });
    this.activateDashboard(migrated);
    this.announce(`Switched to dashboard ${migrated.name}.`);
  }

  private dashboardTemplateOptions(): DashboardTemplateOption[] {
    const { templates } = this.ensureDashboardCollections();
    const builtins: DashboardTemplateOption[] = DASHBOARD_BUILTIN_TEMPLATES.map((template) => ({
      id: template.id,
      name: template.name,
      description: template.description,
      source: 'builtin' as const,
      // Spread (not clone) so the built-in template stamp (templateId/revision/signature) is kept,
      // enabling unmodified copies to refresh when the built-in template changes later.
      createLayout: (id, name, now) => ({ ...createDashboardLayoutFromTemplate(template.id, now), id, name, createdAt: now, updatedAt: now }),
    }));
    const custom: DashboardTemplateOption[] = Object.keys(templates).map((id) => {
      const template = templates[id];
      return {
        id,
        name: template.name || id,
        description: template.description || 'Saved dashboard template.',
        source: 'custom' as const,
        createLayout: (layoutId, name, now) => cloneDashboardTemplateAsLayout(template, layoutId, name, now),
      };
    });
    return [...builtins, ...custom];
  }

  private showDashboardMenu(anchor: HTMLElement): void {
    const menu = new Menu();
    menu.addItem((item) => item.setTitle('New blank dashboard').setIcon('plus').onClick(() => this.openNewDashboardModal()));
    menu.addItem((item) => item.setTitle('New from template').setIcon('layout-template').onClick(() => this.openTemplatePicker()));
    menu.addItem((item) => item.setTitle('Duplicate dashboard').setIcon('copy').onClick(() => this.openDuplicateDashboardModal()));
    menu.addItem((item) => item.setTitle('Rename dashboard').setIcon('pencil').onClick(() => this.openRenameDashboardModal()));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle('Save as template').setIcon('bookmark-plus').onClick(() => this.openSaveTemplateModal()));
    menu.addItem((item) => item.setTitle('Export dashboard').setIcon('download').onClick(() => this.exportActiveDashboard()));
    menu.addItem((item) => item.setTitle('Export all dashboards').setIcon('archive').onClick(() => this.exportAllDashboards()));
    menu.addItem((item) => item.setTitle('Import dashboard').setIcon('upload').onClick(() => this.openImportDashboardModal()));
    menu.addSeparator();
    menu.addItem((item) => item.setTitle('Delete dashboard').setIcon('trash-2').onClick(() => this.deleteActiveDashboard()));
    const rect = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: Math.floor(rect.left), y: Math.floor(rect.bottom) });
  }

  private openNewDashboardModal(): void {
    new DashboardNameModal(this.app, 'New dashboard', 'Dashboard name', 'Untitled dashboard', (name) => this.createBlankDashboard(name)).open();
  }

  private createBlankDashboard(name: string): void {
    const cleanName = name.trim() || 'Untitled dashboard';
    const { layouts } = this.ensureDashboardCollections();
    const id = uniqueDashboardId(cleanName, Object.keys(layouts));
    const now = Date.now();
    const layout: DashboardLayout = { id, name: cleanName, widgets: [], createdAt: now, updatedAt: now };
    this.activateDashboard(layout);
    new Notice(`Task Manager: created dashboard “${cleanName}”.`);
  }

  private openTemplatePicker(): void {
    new DashboardTemplatePickerModal(this.app, this.dashboardTemplateOptions(), (option) => this.createDashboardFromTemplate(option)).open();
  }

  private createDashboardFromTemplate(option: DashboardTemplateOption): void {
    const { layouts } = this.ensureDashboardCollections();
    const id = uniqueDashboardId(option.name, Object.keys(layouts));
    const now = Date.now();
    const layout = option.createLayout(id, option.name, now);
    this.activateDashboard(layout);
    new Notice(`Task Manager: created “${layout.name}” from ${option.source === 'builtin' ? 'built-in' : 'saved'} template.`);
  }

  private openDuplicateDashboardModal(): void {
    if (!this.layout) return;
    new DashboardNameModal(this.app, 'Duplicate dashboard', 'New dashboard name', `${this.layout.name} copy`, (name) => this.duplicateDashboard(name)).open();
  }

  private duplicateDashboard(name: string): void {
    if (!this.layout) return;
    const cleanName = name.trim() || `${this.layout.name} copy`;
    const { layouts } = this.ensureDashboardCollections();
    const now = Date.now();
    const id = uniqueDashboardId(cleanName, Object.keys(layouts));
    const layout = cloneDashboardLayout(this.layout, { id, name: cleanName, createdAt: now, updatedAt: now });
    this.activateDashboard(layout);
    new Notice(`Task Manager: duplicated dashboard as “${cleanName}”.`);
  }

  private openRenameDashboardModal(): void {
    if (!this.layout) return;
    new DashboardNameModal(this.app, 'Rename dashboard', 'Dashboard name', this.layout.name, (name) => this.renameActiveDashboard(name)).open();
  }

  private renameActiveDashboard(name: string): void {
    if (!this.layout) return;
    const cleanName = name.trim();
    if (!cleanName) {
      new Notice('Task Manager: dashboard name cannot be empty.');
      return;
    }
    this.layout.name = cleanName;
    this.persist();
    this.renderShell();
    void this.refreshData({ live: false });
  }

  private deleteActiveDashboard(): void {
    if (!this.layout) return;
    const { layouts } = this.ensureDashboardCollections();
    const ids = Object.keys(layouts);
    if (ids.length <= 1) {
      new Notice('Task Manager: cannot delete the last dashboard.');
      return;
    }
    const name = this.layout.name;
    const id = this.layout.id;
    confirmSettingsRemoval(this.app, `dashboard “${name}”`, async () => {
      delete layouts[id]; const nextId = Object.keys(layouts)[0]; if (!nextId) return;
      this.getSettings().activeDashboardId = nextId; this.activateDashboard(migrateDashboardLayout({ ...layouts[nextId], id: nextId })); new Notice('Task Manager: dashboard deleted.');
      this.persist(); await Promise.resolve();
    });
  }

  private openSaveTemplateModal(): void {
    if (!this.layout) return;
    new DashboardTemplateSaveModal(this.app, this.layout.name, (name, description) => this.saveActiveDashboardAsTemplate(name, description)).open();
  }

  private saveActiveDashboardAsTemplate(name: string, description: string): void {
    if (!this.layout) return;
    const cleanName = name.trim() || this.layout.name || 'Dashboard template';
    const { templates } = this.ensureDashboardCollections();
    const id = uniqueDashboardId(cleanName, Object.keys(templates), 'template');
    templates[id] = createDashboardTemplateFromLayout(this.layout, id, cleanName, description);
    this.debouncedSave();
    new Notice(`Task Manager: saved “${cleanName}” as a dashboard template.`);
  }

  private exportActiveDashboard(): void {
    if (!this.layout) return;
    new DashboardExportModal(this.app, `Export ${this.layout.name}`, exportDashboardLayout(this.layout)).open();
  }

  private exportAllDashboards(): void {
    const { layouts, templates } = this.ensureDashboardCollections();
    new DashboardExportModal(this.app, 'Export all dashboards', exportDashboardCollection(Object.values(layouts), Object.values(templates))).open();
  }

  private openImportDashboardModal(): void {
    new DashboardImportModal(this.app, (source) => this.importDashboardPayload(source)).open();
  }

  private importDashboardPayload(source: string): void {
    try {
      const { layouts, templates } = this.ensureDashboardCollections();
      const result = parseDashboardImportPayload(source, Object.keys(layouts), Object.keys(templates));
      for (const layout of result.layouts) layouts[layout.id] = layout;
      for (const template of result.templates) templates[template.id] = template;
      if (result.layouts.length > 0) {
        this.activateDashboard(result.layouts[0]);
      } else {
        this.debouncedSave();
      }
      const pieces = [
        result.layouts.length ? `${result.layouts.length} dashboard${result.layouts.length === 1 ? '' : 's'}` : '',
        result.templates.length ? `${result.templates.length} template${result.templates.length === 1 ? '' : 's'}` : '',
      ].filter(Boolean).join(' and ');
      new Notice(`Task Manager: imported ${pieces}.`);
      if (result.warnings.length > 0) new Notice(`Task Manager: ${result.warnings[0]}`);
    } catch (error) {
      new Notice(`Task Manager: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ── Card operations ─────────────────────────────────────────────────────────

  private ensureResizeOverlay(cardEl: HTMLElement): HTMLElement {
    return cardEl.querySelector<HTMLElement>('.tm-dash-resize-overlay') ?? cardEl.createDiv('tm-dash-resize-overlay');
  }

  private updateResizeOverlay(overlay: HTMLElement, w: number, h: number): void {
    overlay.setText(`${w} × ${h}`);
    overlay.addClass('is-visible');
  }

  /** Update only the size CSS class + stored bucket (does not move/resize the grid placement). */
  private applyCardSizeClass(card: DashboardCard, size: DashboardWidgetSize): void {
    card.config.size = size;
    card.el.removeClass('tm-dash-card--small', 'tm-dash-card--medium', 'tm-dash-card--large');
    card.el.addClass(`tm-dash-card--${size}`);
    applyDashboardCardVisualClasses(card.el, card.config);
  }

  /** Apply a size preset: set the footprint to the bucket default at the card's current origin. */
  private applyCardSize(card: DashboardCard, size: DashboardWidgetSize): void {
    this.applyCardSizeClass(card, size);
    if (!card.config.grid) return;
    const footprint = gridFootprintForSize(size);
    card.config.grid = clampGridPlacement({ x: card.config.grid.x, y: card.config.grid.y, w: footprint.w, h: footprint.h });
    this.resolveLayoutCollisions(card.config);
    applyDashboardCardVisualClasses(card.el, card.config);
  }

  private toggleCollapse(card: DashboardCard): void {
    if (card.autoCollapsedEmpty && !card.config.collapsed) {
      card.autoCollapsedEmpty = false;
      card.autoCollapseSuppressed = true;
      this.applyCardCollapseState(card);
      this.renderPlacements();
      if (this.isAutoFit()) this.autoFitCompact();
      return;
    }

    card.config.collapsed = !card.config.collapsed;
    card.autoCollapsedEmpty = false;
    card.autoCollapseSuppressed = !card.config.collapsed;
    this.applyCardCollapseState(card);
    this.applyCardPlacement(card.el, card.config);
    this.persist();
    if (card.config.collapsed) {
      disposeDashboardWidget(card);
      card.bodyEl.empty();
      if (this.isAutoFit()) this.autoFitCompact();
    } else {
      void card.renderBody().then(() => { if (this.isAutoFit()) this.autoFitCompact(); });
    }
  }

  private removeCard(card: DashboardCard): void {
    if (!this.layout) return;
    disposeDashboardWidget(card);
    card.el.remove();
    this.cards = this.cards.filter((entry) => entry !== card);
    this.layout.widgets = this.layout.widgets.filter((config) => config !== card.config);
    this.persist();
    if (this.layout.widgets.length === 0 && this.gridEl) this.renderEmptyDashboard(this.gridEl);
    else if (this.isAutoFit()) this.autoFitCompact();
  }

  private showCardMenu(anchor: HTMLElement, card: DashboardCard): void {
    const menu = new Menu();
    if (card.config.type === 'saved-query') {
      menu.addItem((item) => item.setTitle('Configure query').setIcon('settings').onClick(() => this.configureCard(card)));
    } else {
      menu.addItem((item) => item.setTitle('Rename').setIcon('pencil').onClick(() => this.configureCard(card)));
    }
    menu.addSeparator();
    for (const size of DASHBOARD_WIDGET_SIZES) {
      menu.addItem((item) => item
        .setTitle(`${size.charAt(0).toUpperCase()}${size.slice(1)}`)
        .setChecked(normalizeDashboardWidgetSize(card.config.size) === size)
        .onClick(() => {
          if (normalizeDashboardWidgetSize(card.config.size) === size) return;
          this.applyCardSize(card, size);
          this.commitLayoutChange({ rerender: card });
        }));
    }
    menu.addSeparator();
    menu.addItem((item) => item.setTitle('Remove widget').setIcon('trash-2').onClick(() => {
      confirmSettingsRemoval(this.app, `dashboard widget “${card.config.title}”`, async () => { this.removeCard(card); await Promise.resolve(); });
    }));
    const rect = anchor.getBoundingClientRect();
    menu.showAtPosition({ x: Math.floor(rect.left), y: Math.floor(rect.bottom) });
  }

  private configureCard(card: DashboardCard): void {
    new WidgetConfigModal(this.app, card.config, () => {
      const titleEl = card.el.querySelector('.tm-dash-card-title');
      if (titleEl) titleEl.textContent = card.config.title;
      this.persist();
      void card.renderBody().then(() => { if (this.isAutoFit()) this.autoFitCompact(); });
    }).open();
  }

  private showAddWidgetMenu(_anchor: HTMLElement): void {
    new WidgetPickerModal(this.app, this.registry, (type) => this.addWidget(type)).open();
  }

  private addWidget(type: DashboardWidgetType): void {
    if (!this.layout || !this.gridEl) return;
    const renderer = this.registry.getRenderer(type);
    if (!renderer) return;
    const wasEmpty = this.layout.widgets.length === 0;
    const footprint = gridFootprintForSize(normalizeDashboardWidgetSize(renderer.defaultSize));
    const occupied = this.layout.widgets.map((widget) => widget.grid).filter((grid): grid is DashboardGridPlacement => Boolean(grid));
    const slot = findFreeGridSlot(occupied, footprint.w, footprint.h, DASHBOARD_GRID_COLUMNS);
    const config: DashboardWidgetConfig = {
      type,
      title: renderer.title,
      size: renderer.defaultSize,
      collapsed: false,
      grid: { x: slot.x, y: slot.y, w: Math.min(DASHBOARD_GRID_COLUMNS, footprint.w), h: footprint.h },
    };
    this.layout.widgets.push(config);
    this.persist();
    if (wasEmpty) {
      this.gridEl.empty();
      this.cards = [];
    }
    const card = this.createCard(config);
    this.cards.push(card);
    void card.renderBody().then(() => { if (this.isAutoFit()) this.autoFitCompact(); });
    card.el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  // ── Scope + refresh ─────────────────────────────────────────────────────────

  private async setScope(scope: DashboardScope): Promise<void> {
    if (this.activeScope === scope) return;
    this.activeScope = scope;
    const settings = this.getSettings();
    settings.dashboardScope = scope;
    this.persist();
    this.gridEl?.setAttr('aria-labelledby', `${this.gridId || 'task-manager-dashboard-grid'}-scope-${scope}`);
    for (const button of Array.from(this.contentEl.querySelectorAll<HTMLButtonElement>('.tm-dash-scope-btn'))) {
      const isActive = button.dataset.scope === scope;
      button.toggleClass('is-active', isActive);
      button.setAttr('aria-selected', String(isActive));
      button.tabIndex = isActive ? 0 : -1;
    }
    await this.refreshData({ live: false });
  }

  private async refreshData(options: { live: boolean; revision?: number }): Promise<void> {
    if (this.closed) return;
    const token = ++this.refreshToken;
    if (!this.loaded && this.gridEl && this.cards.length > 0) this.showLoading();
    const snapshot = this.getTaskSnapshot ? await this.getTaskSnapshot() : undefined;
    const tasks = snapshot ? [...snapshot.tasks] : await this.scanAllTasks();
    const persistedState = await this.stateStore?.loadState();
    const renderedRevision = snapshot?.revision ?? options.revision;
    if (this.closed || token !== this.refreshToken) return; // a newer refresh superseded this one, or the view closed
    this.tasks = tasks;
    this.persistedState = persistedState;
    this.aggregates = buildDashboardAggregates(tasks);
    this.loaded = true;
    if (renderedRevision !== undefined) {
      this.lastRenderedTaskRevision = Math.max(this.lastRenderedTaskRevision, renderedRevision);
      if (this.pendingTaskRevision <= renderedRevision) this.pendingTaskRevision = -1;
    }
    const renderable = this.cards.filter((card) => options.live || !this.registry.getRenderer(card.config.type)?.live);
    await runDashboardRenderQueue(renderable, 4, async (card) => {
      await card.renderBody();
      if (this.closed || token !== this.refreshToken) disposeDashboardWidget(card);
    }, () => !this.closed && token === this.refreshToken);
    if (!this.closed && token === this.refreshToken) this.autoFitCompact();
  }

  private showLoading(): void {
    for (const card of this.cards) {
      if (card.config.collapsed) continue;
      card.bodyEl.empty();
      const loading = card.bodyEl.createDiv('tm-dash-loading');
      for (let i = 0; i < 3; i += 1) loading.createDiv('tm-dash-skeleton');
    }
  }

  private scheduleAutoRefresh = debounce(() => { void this.refreshData({ live: false }); }, 1500);
  private requestRefresh = debounce(() => { void this.refreshData({ live: false }); }, 400);
  private requestIndexRefreshDebounced = debounce(() => {
    const revision = this.pendingTaskRevision;
    if (revision < 0 || revision <= this.lastRenderedTaskRevision) {
      if (revision <= this.lastRenderedTaskRevision) this.pendingTaskRevision = -1;
      return;
    }
    void this.refreshData({ live: false, revision });
  }, 400);
  // Re-measure card heights after the pane settles at a new width (see the grid ResizeObserver).
  // Width-sensitive content (wrapping stat tiles, list rows) changes height without a band flip, so
  // a stale height would otherwise leave the card body inner-scrolling.
  private scheduleRefit = debounce(() => { if (!this.closed && this.isAutoFit()) this.autoFitCompact(); }, 150);

  // ── Task interactions ────────────────────────────────────────────────────────

  private async openTask(task: ParsedTask): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(task.filePath);
    if (!(file instanceof TFile)) {
      new Notice('Task Manager: source file not found.');
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(file, {
      active: true,
      eState: { line: Math.max(0, task.lineNumber - 1) },
    });
  }

  private async toggleTask(task: ParsedTask): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(task.filePath);
    if (!(file instanceof TFile)) {
      new Notice('Task Manager: source file not found.');
      return;
    }
    try {
      if (this.taskMutations) {
        await this.taskMutations.updateTaskCheckbox(file, task, cycleTaskCheckbox(task.checkbox, this.getSettings().supportedStates));
      } else {
        await this.scanner.updateTaskCheckbox(file, task, cycleTaskCheckbox(task.checkbox, this.getSettings().supportedStates));
        this.getRenderer?.()?.invalidateCache(task.filePath);
      }
      if (!this.getTaskSnapshot) this.requestRefresh();
    } catch (error) {
      console.warn('Task Manager: dashboard task update failed', error);
      new Notice(`Task Manager: could not update task — ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // ── Persistence ──────────────────────────────────────────────────────────────

  private persist(): void {
    if (!this.layout) return;
    this.layout.updatedAt = Date.now();
    const settings = this.getSettings();
    const { layouts } = this.ensureDashboardCollections();
    layouts[this.layout.id] = this.layout;
    settings.activeDashboardId = this.layout.id;
    this.debouncedSave();
  }

  private debouncedSave = debounce(() => { void this.onSave(); }, 500, true);

  private disposeAllCards(): void {
    for (const card of this.cards) disposeDashboardWidget(card);
  }
}

// ── Widget picker / configuration modals ────────────────────────────────────

type WidgetPickerGroupId = 'recommended' | 'plan' | 'decide' | 'monitor' | 'review' | 'collaborate' | 'integrations' | 'advanced';

const WIDGET_PICKER_GROUPS: Array<{ id: WidgetPickerGroupId; title: string; description: string; types: DashboardWidgetType[] }> = [
  {
    id: 'recommended',
    title: 'Recommended',
    description: 'High-signal widgets that make the dashboard immediately actionable.',
    types: ['quick-capture', 'today', 'daily-todos', 'smart-suggestions', 'risk-radar', 'focus-queue', 'activity-timeline', 'momentum', 'inbox-triage', 'blocked-waiting', 'today-schedule', 'pinned-tasks'],
  },
  {
    id: 'plan',
    title: 'Plan',
    description: 'Today, upcoming work, scheduling, and choosing the next thing to do.',
    types: ['today', 'daily-todos', 'agenda', 'upcoming', 'today-schedule', 'deadline-strip', 'calendar-mini', 'focus-queue', 'next-action-project', 'pinned-tasks', 'quick-wins', 'deep-work', 'daily-goal', 'daily-note', 'quick-capture', 'time-block-suggestions', 'capacity-planner', 'schedule-conflicts'],
  },
  {
    id: 'decide',
    title: 'Decide',
    description: 'Prioritization, triage, quality checks, and work classification.',
    types: ['eisenhower', 'inbox-triage', 'needs-scheduling', 'status-distribution', 'priority-distribution', 'custom-field-breakdown', 'date-quality', 'metadata-completeness', 'energy-fit', 'someday-maybe', 'saved-query', 'saved-views', 'tag-explorer'],
  },
  {
    id: 'monitor',
    title: 'Monitor',
    description: 'Project load, risk, dependencies, backlog, and stale work.',
    types: ['risk-radar', 'project-health', 'goals-progress', 'areas-of-responsibility', 'milestone-progress', 'assignee-workload', 'workload-project', 'stale-tasks', 'task-age-distribution', 'time-in-status', 'dependencies', 'subtask-progress', 'cycle-time', 'scope-burnup', 'burndown', 'cumulative-flow', 'completion-forecast', 'throughput', 'backlog-growth', 'task-churn', 'file-hotspots'],
  },
  {
    id: 'review',
    title: 'Review & reflect',
    description: 'Completions, habits, recurrence, effort, and weekly-review signals.',
    types: ['review-queue', 'weekly-review', 'shutdown-ritual', 'activity-timeline', 'recently-edited', 'recently-completed', 'on-this-day', 'completion-heatmap', 'momentum', 'goal-streak-calendar', 'productivity-score', 'time-heatmap', 'daily-goal', 'habits', 'recurrence-health', 'effort-forecast', 'time-by-project', 'estimate-accuracy', 'estimate-variance', 'pomodoro'],
  },
  {
    id: 'collaborate',
    title: 'Collaborate',
    description: 'People, reviewers, waiting items, handoffs, and shared costs.',
    types: ['follow-up', 'assignee-workload', 'waiting-by-person', 'comments-feed', 'cost-budget'],
  },
  {
    id: 'integrations',
    title: 'Integrations',
    description: 'External sync, reminders, task notes, and embedded visual surfaces.',
    types: ['sync-health', 'sync-activity', 'sync-conflicts', 'reminder-queue', 'orphaned-task-notes', 'kanban-mini'],
  },
];

function widgetPickerGroupFor(type: DashboardWidgetType): WidgetPickerGroupId {
  for (const group of WIDGET_PICKER_GROUPS) {
    if (group.types.includes(type)) return group.id;
  }
  return 'advanced';
}

class DashboardNameModal extends Modal {
  constructor(
    app: App,
    private readonly title: string,
    private readonly label: string,
    private readonly initialValue: string,
    private readonly onSubmit: (name: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('tm-dash-collection-modal');
    contentEl.createEl('h2', { text: this.title });
    let value = this.initialValue;
    new Setting(contentEl)
      .setName(this.label)
      .addText((text) => text.setValue(this.initialValue).onChange((next) => { value = next; }));
    const buttons = contentEl.createDiv('tm-dash-config-buttons');
    const save = buttons.createEl('button', { text: 'Save', cls: 'mod-cta' });
    save.addEventListener('click', () => {
      this.onSubmit(value);
      this.close();
    });
    const cancel = buttons.createEl('button', { text: 'Cancel' });
    cancel.addEventListener('click', () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class DashboardTemplateSaveModal extends Modal {
  constructor(
    app: App,
    private readonly initialName: string,
    private readonly onSubmit: (name: string, description: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('tm-dash-collection-modal');
    contentEl.createEl('h2', { text: 'Save dashboard as template' });
    let name = this.initialName;
    let description = '';
    new Setting(contentEl)
      .setName('Template name')
      .addText((text) => text.setValue(this.initialName).onChange((value) => { name = value; }));
    new Setting(contentEl)
      .setName('Description')
      .setDesc('Shown in the template picker.')
      .addTextArea((area) => {
        area.setPlaceholder('What this dashboard is useful for…').onChange((value) => { description = value; });
        area.inputEl.rows = 4;
      });
    const buttons = contentEl.createDiv('tm-dash-config-buttons');
    const save = buttons.createEl('button', { text: 'Save template', cls: 'mod-cta' });
    save.addEventListener('click', () => {
      this.onSubmit(name, description);
      this.close();
    });
    const cancel = buttons.createEl('button', { text: 'Cancel' });
    cancel.addEventListener('click', () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class DashboardTemplatePickerModal extends Modal {
  constructor(
    app: App,
    private readonly options: DashboardTemplateOption[],
    private readonly onPick: (option: DashboardTemplateOption) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.modalEl.addClass('tm-dash-template-picker-modal');
    contentEl.addClass('tm-dash-template-picker');
    contentEl.createEl('h2', { text: 'New dashboard from template' });
    contentEl.createDiv({ cls: 'tm-dash-widget-picker-subtitle', text: 'Start from a built-in workflow or one of your saved dashboard templates.' });
    const list = contentEl.createDiv('tm-dash-template-list');
    for (const option of this.options) {
      const tone = this.templateOptionTone(option);
      const row = list.createDiv(`tm-dash-template-option tm-dash-template-option--${tone}`);
      const info = row.createDiv('tm-dash-template-info');
      const heading = info.createDiv('tm-dash-template-heading');
      heading.createSpan('tm-dash-template-dot');
      heading.createDiv({ cls: 'tm-dash-template-name', text: option.name });
      const primaryQuestion = option.source === 'builtin'
        ? DASHBOARD_BUILTIN_TEMPLATES.find((template) => template.id === option.id)?.primaryQuestion
        : undefined;
      info.createDiv({ cls: 'tm-dash-template-meta', text: option.source === 'builtin' ? 'Built-in workflow' : 'Saved template' });
      if (primaryQuestion) info.createDiv({ cls: 'tm-dash-template-question', text: primaryQuestion });
      info.createDiv({ cls: 'tm-dash-template-desc', text: option.description });
      const button = row.createEl('button', { cls: 'tm-dash-template-use', text: 'Use template' });
      button.addClass('mod-cta');
      button.addEventListener('click', () => {
        this.onPick(option);
        this.close();
      });
    }
  }

  private templateOptionTone(option: DashboardTemplateOption): DashboardTemplateTone {
    return option.source === 'builtin' ? dashboardTemplateToneForId(option.id) : 'custom';
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class DashboardExportModal extends Modal {
  constructor(
    app: App,
    private readonly title: string,
    private readonly payload: string,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('tm-dash-export-modal');
    contentEl.createEl('h2', { text: this.title });
    contentEl.createDiv({ cls: 'tm-dash-widget-picker-subtitle', text: 'Copy this JSON to import the dashboard into another vault or keep it as a backup.' });
    new Setting(contentEl)
      .setName('Dashboard JSON')
      .addTextArea((area) => {
        area.setValue(this.payload);
        area.inputEl.rows = 18;
        area.inputEl.readOnly = true;
        area.inputEl.addClass('tm-dash-export-json');
      });
    const buttons = contentEl.createDiv('tm-dash-config-buttons');
    const copy = buttons.createEl('button', { text: 'Copy JSON', cls: 'mod-cta' });
    copy.addEventListener('click', () => { void this.copyPayload(); });
    const close = buttons.createEl('button', { text: 'Close' });
    close.addEventListener('click', () => this.close());
  }

  private async copyPayload(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.payload);
      new Notice('Task Manager: dashboard JSON copied to clipboard.');
    } catch {
      const textarea = this.contentEl.querySelector<HTMLTextAreaElement>('.tm-dash-export-json');
      textarea?.select();
      new Notice('Task Manager: select the JSON and copy it manually.');
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class DashboardImportModal extends Modal {
  constructor(
    app: App,
    private readonly onImport: (source: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.addClass('tm-dash-import-modal');
    contentEl.createEl('h2', { text: 'Import dashboard' });
    contentEl.createDiv({ cls: 'tm-dash-widget-picker-subtitle', text: 'Paste dashboard JSON exported from Task Manager. Imported dashboards are added as new dashboards.' });
    let source = '';
    new Setting(contentEl)
      .setName('Dashboard JSON')
      .addTextArea((area) => {
        area.setPlaceholder('{\n  "kind": "task-manager-dashboard-layout",\n  ...\n}');
        area.onChange((value) => { source = value; });
        area.inputEl.rows = 18;
        area.inputEl.addClass('tm-dash-import-json');
      });
    const buttons = contentEl.createDiv('tm-dash-config-buttons');
    const importBtn = buttons.createEl('button', { text: 'Import', cls: 'mod-cta' });
    importBtn.addEventListener('click', () => {
      if (!source.trim()) {
        new Notice('Task Manager: paste dashboard JSON first.');
        return;
      }
      this.onImport(source);
      this.close();
    });
    const cancel = buttons.createEl('button', { text: 'Cancel' });
    cancel.addEventListener('click', () => this.close());
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

class WidgetPickerModal extends Modal {
  private query = '';
  private resultsEl: HTMLElement | null = null;
  private previewEl: HTMLElement | null = null;
  private previewType: DashboardWidgetType | null = null;

  constructor(
    app: App,
    private readonly registry: WidgetRegistry,
    private readonly onPick: (type: DashboardWidgetType) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    this.modalEl.addClass('tm-dash-widget-picker-modal');
    contentEl.addClass('tm-dash-widget-picker');
    contentEl.createEl('h2', { text: 'Add dashboard widget' });
    contentEl.createDiv({ cls: 'tm-dash-widget-picker-subtitle', text: 'Search by name or description, or browse grouped widget types.' });

    const searchWrap = contentEl.createDiv('tm-dash-widget-picker-search');
    const searchIcon = searchWrap.createSpan('tm-dash-widget-picker-search-icon');
    setIcon(searchIcon, 'search');
    const search = searchWrap.createEl('input', {
      cls: 'tm-dash-widget-picker-input',
      attr: { type: 'search', placeholder: 'Search widgets…', 'aria-label': 'Search widgets' },
    });
    search.addEventListener('input', () => {
      this.query = search.value.trim().toLowerCase();
      this.renderResults();
    });
    search.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        const first = this.resultsEl?.querySelector<HTMLButtonElement>('.tm-dash-widget-option');
        if (first) {
          event.preventDefault();
          first.click();
        }
      }
    });

    const body = contentEl.createDiv('tm-dash-widget-picker-body');
    this.resultsEl = body.createDiv('tm-dash-widget-picker-results');
    this.previewEl = body.createDiv('tm-dash-widget-picker-preview');
    this.renderResults();
    const firstType = this.firstVisibleType();
    if (firstType) this.renderPreview(firstType);
    window.setTimeout(() => search.focus(), 0);
  }

  private renderResults(): void {
    const results = this.resultsEl;
    if (!results) return;
    results.empty();

    const rendered = new Set<DashboardWidgetType>();
    let shown = 0;
    for (const group of WIDGET_PICKER_GROUPS) {
      const entries = group.types
        .filter((type) => !rendered.has(type))
        .map((type) => ({ type, renderer: this.registry.getRenderer(type) }))
        .filter((entry): entry is { type: DashboardWidgetType; renderer: WidgetRenderer } => Boolean(entry.renderer))
        .filter(({ type, renderer }) => this.matches(type, renderer));
      if (entries.length === 0) continue;
      const section = results.createDiv('tm-dash-widget-group');
      section.createDiv({ cls: 'tm-dash-widget-group-title', text: group.title });
      section.createDiv({ cls: 'tm-dash-widget-group-desc', text: group.description });
      const list = section.createDiv('tm-dash-widget-list');
      for (const { type, renderer } of entries) {
        rendered.add(type);
        shown += 1;
        this.renderOption(list, type, renderer, group.id);
      }
    }

    const uncategorized = this.registry.getAllTypes()
      .filter((type) => !rendered.has(type) && widgetPickerGroupFor(type) === 'advanced')
      .map((type) => ({ type, renderer: this.registry.getRenderer(type) }))
      .filter((entry): entry is { type: DashboardWidgetType; renderer: WidgetRenderer } => Boolean(entry.renderer))
      .filter(({ type, renderer }) => this.matches(type, renderer));
    if (uncategorized.length > 0) {
      const section = results.createDiv('tm-dash-widget-group');
      section.createDiv({ cls: 'tm-dash-widget-group-title', text: 'Advanced' });
      section.createDiv({ cls: 'tm-dash-widget-group-desc', text: 'Other registered dashboard widgets.' });
      const list = section.createDiv('tm-dash-widget-list');
      for (const { type, renderer } of uncategorized) {
        shown += 1;
        this.renderOption(list, type, renderer, 'advanced');
      }
    }

    if (shown === 0) {
      const empty = results.createDiv('tm-dash-widget-picker-empty');
      const icon = empty.createDiv('tm-dash-empty-icon');
      setIcon(icon, 'search-x');
      empty.createDiv({ cls: 'tm-dash-empty-text', text: 'No widgets match your search.' });
      this.renderEmptyPreview();
      return;
    }
    const firstType = this.firstVisibleType();
    if (firstType && (!this.previewType || !this.matches(this.previewType, this.registry.getRenderer(this.previewType) as WidgetRenderer))) this.renderPreview(firstType);
  }

  private firstVisibleType(): DashboardWidgetType | null {
    return this.resultsEl?.querySelector<HTMLElement>('.tm-dash-widget-option')?.dataset.widgetType as DashboardWidgetType | undefined ?? null;
  }

  private matches(type: DashboardWidgetType, renderer: WidgetRenderer): boolean {
    if (!this.query) return true;
    const haystack = `${renderer.title} ${renderer.description ?? ''} ${type}`.toLowerCase();
    return haystack.includes(this.query);
  }

  private renderOption(parent: HTMLElement, type: DashboardWidgetType, renderer: WidgetRenderer, group: WidgetPickerGroupId): void {
    const button = parent.createEl('button', { cls: `tm-dash-widget-option tm-dash-widget-option--${group}` });
    button.setAttr('type', 'button');
    button.dataset.widgetType = type;
    const icon = button.createSpan('tm-dash-widget-option-icon');
    setIcon(icon, renderer.icon);
    const text = button.createSpan('tm-dash-widget-option-text');
    text.createSpan({ cls: 'tm-dash-widget-option-title', text: renderer.title });
    text.createSpan({ cls: 'tm-dash-widget-option-desc', text: renderer.description ?? defaultWidgetTitle(type) });
    button.createSpan({ cls: 'tm-dash-widget-option-size', text: renderer.defaultSize });
    const showPreview = () => this.renderPreview(type);
    button.addEventListener('mouseenter', showPreview);
    button.addEventListener('focus', showPreview);
    button.addEventListener('click', () => {
      this.onPick(type);
      this.close();
    });
  }

  private renderEmptyPreview(): void {
    const preview = this.previewEl;
    if (!preview) return;
    this.previewType = null;
    preview.empty();
    preview.createDiv({ cls: 'tm-dash-widget-preview-eyebrow', text: 'Preview' });
    renderDashEmpty(preview, 'search-x', 'No matching widget to preview.');
  }

  private renderPreview(type: DashboardWidgetType): void {
    const preview = this.previewEl;
    const renderer = this.registry.getRenderer(type);
    if (!preview || !renderer) return;
    this.previewType = type;
    preview.empty();
    const eyebrow = preview.createDiv({ cls: 'tm-dash-widget-preview-eyebrow' });
    const eyebrowIcon = eyebrow.createSpan('tm-dash-widget-preview-eyebrow-icon');
    setIcon(eyebrowIcon, 'eye');
    eyebrow.createSpan({ text: 'Preview' });
    eyebrow.createSpan({ cls: 'tm-dash-widget-preview-eyebrow-hint', text: 'Sample data' });
    const card = preview.createDiv({ cls: `tm-dash-widget-preview-card tm-dash-card tm-dash-card--${renderer.defaultSize}` });
    applyDashboardCardVisualClasses(card, {
      type,
      title: renderer.title,
      size: renderer.defaultSize,
      presentation: ['stats', 'productivity-score', 'daily-goal', 'completion-forecast', 'momentum'].includes(type) ? 'hero' : 'standard',
    });
    const header = card.createDiv('tm-dash-card-header');
    if (renderer.icon) {
      const icon = header.createDiv('tm-dash-card-icon');
      setIcon(icon, renderer.icon);
    }
    header.createDiv({ cls: 'tm-dash-card-title', text: renderer.title });
    const badge = header.createSpan({ cls: 'tm-dash-card-badge', text: this.previewBadge(type) });
    if (!badge.textContent) badge.hide();
    const body = card.createDiv('tm-dash-card-body');
    this.renderPreviewBody(body, type);
    preview.createDiv({ cls: 'tm-dash-widget-preview-desc', text: renderer.description ?? defaultWidgetTitle(type) });
  }

  private previewBadge(type: DashboardWidgetType): string {
    if (['stats', 'effort-forecast', 'metadata-completeness', 'backlog-growth', 'productivity-score', 'quick-capture', 'completion-forecast'].includes(type)) return '';
    if (['risk-radar', 'overdue-risk', 'blocked-waiting', 'review-queue', 'cycle-time', 'weekly-review'].includes(type)) return '7';
    if (['completion-heatmap', 'time-by-project', 'sync-activity', 'time-heatmap', 'throughput'].includes(type)) return '12';
    if (type === 'momentum') return '5d';
    if (type === 'daily-goal') return '3/5';
    return '4';
  }

  private renderPreviewBody(body: HTMLElement, type: DashboardWidgetType): void {
    if (type === 'status-distribution') {
      renderDashboardBars(body, [
        { label: 'Todo', value: 12, status: 'todo' },
        { label: 'In progress', value: 5, status: 'in_progress' },
        { label: 'On hold', value: 3, status: 'on_hold' },
        { label: 'Done', value: 18, status: 'done' },
        { label: 'Cancelled', value: 2, status: 'cancelled' },
      ], { palette: 'status' });
      return;
    }
    if (type === 'priority-distribution') {
      renderDashboardBars(body, [
        { label: 'Highest', value: 2, priority: 'highest' },
        { label: 'High', value: 5, priority: 'high' },
        { label: 'Medium', value: 8, priority: 'medium' },
        { label: 'Normal', value: 13, priority: 'normal' },
        { label: 'Low', value: 4, priority: 'low' },
      ], { palette: 'priority' });
      return;
    }
    if (type === 'capacity-planner') {
      renderDashboardBars(body, [
        { label: 'Today', value: 92, detail: '5h 30m / 6h', tone: 'is-soon' },
        { label: 'Tue', value: 118, detail: '7h / 6h', tone: 'is-overdue' },
        { label: 'Wed', value: 42, detail: '2h 30m / 6h' },
      ], { palette: 'severity' });
      return;
    }
    if (type === 'risk-radar' || type === 'overdue-risk') {
      const list = body.createDiv('tm-dash-preview-risk-list');
      for (const [score, label, detail, tone] of [['92', 'Launch checklist', 'Overdue · high · blocked', 'high'], ['68', 'Vendor contract', 'Due today · waiting', 'medium'], ['41', 'Roadmap note', 'Stale 12d', 'neutral']] as const) {
        const row = list.createDiv(`tm-dash-preview-risk tm-dash-preview-risk--${tone}`);
        row.createDiv({ cls: 'tm-dash-preview-risk-score', text: score });
        const text = row.createDiv('tm-dash-preview-risk-main');
        text.createDiv({ cls: 'tm-dash-preview-risk-title', text: label });
        text.createDiv({ cls: 'tm-dash-preview-risk-detail', text: detail });
      }
      return;
    }
    if (type === 'smart-suggestions') {
      const suggestions = body.createDiv('tm-dash-preview-suggestions');
      for (const [iconName, label, detail, tone] of [['alert-triangle', 'Reschedule 2 overdue tasks', 'Reduce today’s risk first', 'high'], ['timer', 'Protect a 90m focus block', 'Best fit before noon', 'medium'], ['sparkles', 'Batch 4 quick wins', 'Clears inbox pressure', 'neutral']] as const) {
        const row = suggestions.createDiv(`tm-dash-preview-suggestion tm-dash-preview-suggestion--${tone}`);
        const icon = row.createSpan('tm-dash-preview-suggestion-icon');
        setIcon(icon, iconName);
        const text = row.createSpan('tm-dash-preview-suggestion-main');
        text.createSpan({ cls: 'tm-dash-preview-suggestion-title', text: label });
        text.createSpan({ cls: 'tm-dash-preview-suggestion-detail', text: detail });
      }
      return;
    }
    if (['sync-health', 'sync-activity', 'sync-conflicts'].includes(type)) {
      const services = body.createDiv('tm-dash-services tm-dash-preview-services');
      for (const [service, state, cls] of type === 'sync-conflicts'
        ? [['Todoist', '2 retry', 'is-error'], ['Google Tasks', '1 queued', 'is-warn'], ['CalDAV', 'clean', 'is-ok']]
        : [['Todoist', 'Synced 3m ago', 'is-ok'], ['Google Tasks', 'Partial', 'is-warn'], ['CalDAV', 'Healthy', 'is-ok']] as const) {
        const row = services.createDiv('tm-dash-service');
        row.createSpan({ cls: `tm-dash-dot ${cls}` });
        row.createSpan({ cls: 'tm-dash-service-name', text: service });
        row.createSpan({ cls: 'tm-dash-service-state', text: state });
      }
      return;
    }
    if (type === 'saved-views' || type === 'tag-explorer') {
      const chips = body.createDiv(type === 'saved-views' ? 'tm-dash-savedviews-chips' : 'tm-dash-tagcloud');
      for (const [label, count] of type === 'saved-views' ? [['Today', '8'], ['Waiting', '3'], ['High', '5']] : [['#work', '14'], ['#goal/launch', '6'], ['@home', '4']] as const) {
        const chip = chips.createSpan({ cls: type === 'saved-views' ? 'tm-dash-savedview-chip' : 'tm-dash-tag-chip' });
        chip.createSpan({ text: label });
        chip.createSpan({ cls: 'tm-dash-tag-chip-count', text: count });
      }
      const list = body.createDiv('tm-dash-task-list');
      for (const label of ['Draft launch brief', 'Review blocked handoff']) {
        const row = list.createDiv('tm-dash-task');
        row.createEl('input', { type: 'checkbox', cls: 'tm-dash-task-check' });
        const main = row.createDiv('tm-dash-task-main');
        main.createDiv({ cls: 'tm-dash-task-text', text: label });
      }
      return;
    }
    if (type === 'comments-feed') {
      const comments = body.createDiv('tm-dash-comments');
      for (const [task, comment] of [['Launch copy', 'Alex: can we tighten the deadline?'], ['Budget review', 'Mina: waiting on revised quote'], ['Design pass', 'Sam: approved with one nit']] as const) {
        const item = comments.createDiv('tm-dash-comment');
        item.createDiv({ cls: 'tm-dash-task-text', text: task });
        const latest = item.createDiv('tm-dash-comment-latest');
        const icon = latest.createSpan('tm-dash-comment-icon');
        setIcon(icon, 'message-square');
        latest.createSpan({ cls: 'tm-dash-comment-text', text: comment });
      }
      return;
    }
    if (type === 'cost-budget') {
      renderDashboardBars(body, [
        { label: 'Launch', value: 840, detail: '$840', tone: 'is-soon' },
        { label: 'Ops', value: 520, detail: '$520' },
        { label: 'Admin', value: 180, detail: '$180' },
      ], { palette: 'severity' });
      return;
    }
    if (type === 'goals-progress' || type === 'areas-of-responsibility' || type === 'subtask-progress') {
      renderDashboardBars(body, [
        { label: type === 'areas-of-responsibility' ? 'Work' : 'Launch v2', value: 72, detail: '72% · Jul 1', tone: 'is-soon' },
        { label: type === 'areas-of-responsibility' ? 'Home' : 'Health', value: 48, detail: '48%' },
        { label: type === 'areas-of-responsibility' ? 'Admin' : 'Finance', value: 24, detail: '24% · overdue', tone: 'is-overdue' },
      ], { palette: 'severity' });
      return;
    }
    if (['project-health', 'sync-conflicts', 'time-in-status', 'task-age-distribution', 'scope-burnup', 'estimate-variance', 'cycle-time', 'metadata-completeness'].includes(type)) {
      renderDashboardBars(body, [
        { label: type === 'project-health' ? 'Launch risk' : 'High attention', value: 8, detail: 'Needs review', tone: 'is-overdue' },
        { label: type === 'metadata-completeness' ? 'Mostly complete' : 'Watch', value: 5, detail: 'Monitor', tone: 'is-soon' },
        { label: 'Healthy', value: 3, detail: 'OK' },
      ], { palette: 'severity' });
      return;
    }
    if (['backlog-growth', 'task-churn', 'throughput'].includes(type)) {
      renderDashboardBars(body, [
        { label: 'Created', value: 9, colorClass: 'is-cat-1' },
        { label: 'Completed', value: 7, status: 'done' },
        { label: 'Net', value: 2, detail: '+2', tone: 'is-soon' },
      ], { palette: 'status' });
      return;
    }
    if (['workload-project', 'milestone-progress', 'assignee-workload', 'contexts-hotspots', 'time-by-project', 'custom-field-breakdown', 'waiting-by-person'].includes(type)) {
      renderDashboardBars(body, [
        { label: type === 'waiting-by-person' ? 'Alex' : 'Project Alpha', value: 8, detail: '8 active' },
        { label: 'Personal', value: 5, detail: '5 active' },
        { label: 'Admin', value: 3, detail: '3 active' },
      ], { palette: 'categorical' });
      return;
    }
    if (type === 'eisenhower' || type === 'energy-fit') {
      const grid = body.createDiv('tm-dash-matrix');
      for (const label of type === 'eisenhower' ? ['Do now', 'Schedule', 'Delegate', 'Someday'] : ['Low', 'Medium', 'High', 'Review']) {
        const cell = grid.createDiv('tm-dash-matrix-cell');
        cell.createDiv({ cls: 'tm-dash-matrix-title', text: label });
        cell.createDiv({ cls: 'tm-dash-preview-line', text: 'Example task' });
      }
      return;
    }
    if (type === 'completion-heatmap' || type === 'goal-streak-calendar') {
      const grid = body.createDiv('tm-dash-heatmap');
      for (let i = 0; i < 35; i += 1) grid.createDiv({ cls: `tm-dash-heatmap-cell tm-dash-heatmap-l${i % 5}` });
      renderDashboardInsight(body, type === 'goal-streak-calendar' ? 'target' : 'palette', type === 'goal-streak-calendar' ? 'Darkest cells hit the daily goal.' : 'Darker cells mean more completions.', 'neutral');
      return;
    }
    if (type === 'time-heatmap') {
      const gridWrap = body.createDiv('tm-dash-timeheat');
      for (let weekday = 0; weekday < 7; weekday += 1) {
        const rowEl = gridWrap.createDiv('tm-dash-timeheat-row');
        rowEl.createSpan({ cls: 'tm-dash-timeheat-daylabel', text: DASHBOARD_WEEKDAY_LABELS[weekday] });
        const cells = rowEl.createDiv('tm-dash-timeheat-cells');
        for (let hour = 0; hour < 24; hour += 1) cells.createDiv({ cls: `tm-dash-heatmap-cell tm-dash-heatmap-l${(weekday + hour) % 5}` });
      }
      renderDashboardInsight(body, 'clock', 'Darker cells show peak completion windows.', 'neutral');
      return;
    }
    if (type === 'daily-todos') {
      const list = body.createDiv('tm-dash-task-list tm-dash-daily-todos-list');
      for (const [state, label, meta] of [['in-progress', 'Draft launch plan', 'Due'], ['todo', 'Review vendor notes', 'Scheduled'], ['done', 'Send update', 'Completed']] as const) {
        const row = list.createDiv(`tm-dash-task tm-dash-task--s-${state}`);
        const checkbox = row.createEl('input', { type: 'checkbox', cls: 'tm-dash-task-check' });
        checkbox.checked = state === 'done';
        const main = row.createDiv('tm-dash-task-main');
        main.createDiv({ cls: 'tm-dash-task-text', text: label });
        const rowMeta = main.createDiv('tm-dash-task-meta');
        rowMeta.createSpan({ cls: 'tm-dash-task-status', text: meta });
      }
      return;
    }
    if (type === 'today-schedule') {
      const schedule = body.createDiv('tm-dash-schedule tm-dash-preview-schedule');
      for (const [time, label, cls] of [['9:00a', 'Design review', 'tm-dash-schedule-row--event'], ['10:30a', 'Draft launch plan', 'tm-dash-schedule-row--task'], ['1:00p', 'Deep work block', 'tm-dash-schedule-row--task']]) {
        const row = schedule.createDiv({ cls: `tm-dash-schedule-row ${cls}` });
        const timeEl = row.createDiv('tm-dash-schedule-time');
        timeEl.createDiv({ cls: 'tm-dash-schedule-start', text: time });
        const rowBody = row.createDiv('tm-dash-schedule-body');
        rowBody.createDiv({ cls: 'tm-dash-schedule-label', text: label });
      }
      return;
    }
    if (type === 'calendar-mini') {
      const calendar = body.createDiv('tm-dash-preview-calendar');
      for (let i = 0; i < 35; i += 1) calendar.createSpan({ cls: i % 7 === 2 || i % 11 === 0 ? 'has-work' : '' });
      return;
    }
    if (type === 'kanban-mini') {
      const board = body.createDiv('tm-dash-preview-kanban');
      for (const [title, count] of [['Todo', 3], ['Doing', 2], ['Done', 1]] as const) {
        const col = board.createDiv('tm-dash-preview-kanban-col');
        col.createDiv({ cls: 'tm-dash-preview-kanban-title', text: title });
        for (let i = 0; i < count; i += 1) col.createDiv('tm-dash-preview-kanban-card');
      }
      return;
    }
    if (type === 'habits') {
      const habits = body.createDiv('tm-dash-preview-habits');
      for (const label of ['Write', 'Walk', 'Read']) {
        const row = habits.createDiv('tm-dash-preview-habit');
        row.createSpan({ text: label });
        const cells = row.createSpan('tm-dash-preview-habit-cells');
        for (let i = 0; i < 7; i += 1) cells.createSpan({ cls: i % 3 === 0 ? 'is-done' : '' });
      }
      return;
    }
    if (type === 'pomodoro') {
      const pomodoro = body.createDiv('tm-dash-preview-pomodoro');
      pomodoro.createDiv({ cls: 'tm-dash-pomodoro-time', text: '25:00' });
      pomodoro.createDiv({ cls: 'tm-dash-pomodoro-status', text: 'Ready for focus' });
      const buttons = pomodoro.createDiv('tm-dash-pomodoro-btns');
      buttons.createEl('button', { text: 'Start' });
      buttons.createEl('button', { text: 'Log' });
      return;
    }
    if (['burndown', 'scope-burnup', 'cumulative-flow'].includes(type)) {
      const chart = body.createDiv(type === 'cumulative-flow' ? 'tm-dash-cfd' : `tm-dash-sparkbars ${type === 'burndown' ? 'is-good' : 'is-watch'}`);
      for (let i = 0; i < 10; i += 1) {
        if (type === 'cumulative-flow') {
          const col = chart.createDiv('tm-dash-cfd-col');
          const stack = col.createDiv('tm-dash-cfd-stack');
          stack.createDiv('tm-dash-cfd-done').style.height = `${30 + i * 4}%`;
          stack.createDiv('tm-dash-cfd-open').style.height = `${50 - i * 2}%`;
        } else {
          const col = chart.createDiv('tm-dash-sparkbar');
          col.createDiv('tm-dash-sparkbar-fill').style.height = `${type === 'burndown' ? 90 - i * 6 : 30 + i * 5}%`;
        }
      }
      renderDashboardInsight(body, type === 'burndown' ? 'trending-down' : 'layers', type === 'burndown' ? 'Down is good: open work is shrinking.' : type === 'cumulative-flow' ? 'Gap shows open work-in-progress.' : 'Watch scope growth against completions.', type === 'burndown' ? 'good' : 'watch');
      return;
    }
    if (['smart-suggestions', 'time-block-suggestions', 'reminder-queue', 'weekly-review', 'activity-timeline', 'recurrence-health', 'schedule-conflicts', 'shutdown-ritual'].includes(type)) {
      renderDashboardNotes(body, [
        { icon: 'inbox', text: 'Empty the inbox.', tone: 'is-overdue' },
        { icon: 'zap', text: 'Clear 4 quick wins.' },
        { icon: 'check-circle', text: 'Give every project a next action.' },
      ]);
      return;
    }
    if (type === 'deadline-strip') {
      const strip = body.createDiv('tm-dash-deadline-strip');
      for (let i = 0; i < 14; i += 1) {
        const cell = strip.createDiv({ cls: `tm-dash-deadline-day tm-dash-deadline-l${i % 4}` });
        cell.createDiv({ cls: 'tm-dash-deadline-weekday', text: i === 0 ? 'Today' : DASHBOARD_WEEKDAY_LABELS[i % 7] });
        cell.createDiv({ cls: 'tm-dash-deadline-date', text: String(i + 1) });
        cell.createDiv({ cls: 'tm-dash-deadline-count', text: i % 4 ? String(i % 4) : '–' });
      }
      return;
    }
    if (type === 'quick-capture') {
      const wrap = body.createDiv('tm-dash-capture');
      const form = wrap.createDiv('tm-dash-capture-form');
      const input = form.createEl('input', { cls: 'tm-dash-capture-input', attr: { type: 'text', placeholder: 'Add a task…', disabled: 'true' } });
      input.value = 'Draft proposal tomorrow high';
      form.createDiv({ cls: 'tm-dash-capture-submit mod-cta', text: 'Add' });
      const grid = wrap.createDiv('tm-dash-action-grid');
      for (const action of DASHBOARD_QUICK_ACTIONS) {
        const button = grid.createEl('button', { cls: 'tm-dash-action-button' });
        button.toggleClass('is-icon-only', !action.label);
        const icon = button.createSpan('tm-dash-action-icon');
        setIcon(icon, action.icon);
        if (action.label) button.createSpan({ cls: 'tm-dash-action-label', text: action.label });
      }
      const captured = wrap.createDiv('tm-dash-capture-status');
      const capturedIcon = captured.createSpan('tm-dash-capture-status-icon');
      setIcon(capturedIcon, 'check');
      captured.createSpan({ text: 'Captured' });
      return;
    }
    if (type === 'momentum') {
      const wrap = body.createDiv('tm-dash-momentum');
      const levelRow = wrap.createDiv('tm-dash-momentum-level');
      const badge = levelRow.createDiv('tm-dash-momentum-badge');
      badge.createSpan({ cls: 'tm-dash-momentum-badge-num', text: '5' });
      badge.createSpan({ cls: 'tm-dash-momentum-badge-label', text: 'LVL' });
      const meta = levelRow.createDiv('tm-dash-momentum-level-meta');
      meta.createDiv({ cls: 'tm-dash-momentum-xp', text: '640 XP' });
      const track = meta.createDiv('tm-dash-momentum-xp-track');
      track.createDiv('tm-dash-momentum-xp-fill').style.width = '60%';
      const tiles = wrap.createDiv('tm-dash-stat-tiles');
      for (const [label, value] of [['Streak', '6d'], ['Today', '3'], ['This week', '17'], ['Lifetime', '142']]) {
        const tile = tiles.createDiv('tm-dash-stat-tile');
        tile.createDiv({ cls: 'tm-dash-stat-value', text: value });
        tile.createDiv({ cls: 'tm-dash-stat-label', text: label });
      }
      return;
    }
    if (type === 'stats' || type === 'productivity-score' || type === 'daily-goal' || type === 'completion-forecast') {
      const wrap = body.createDiv('tm-dash-stats tm-dash-stats--hero');
      if (type === 'productivity-score') renderDashboardHero(wrap, '86', 'Score', '54 done · 78% on time', 'up');
      else if (type === 'daily-goal') renderDashboardHero(wrap, '3/5', 'Daily goal', '2 to go', 'neutral');
      else if (type === 'completion-forecast') renderDashboardHero(wrap, 'Jul 12', 'Backlog ETA', '4 weeks left', 'neutral');
      else renderDashboardHero(wrap, '76%', 'Complete', '31 done · 18 active', 'up');
      const tiles = wrap.createDiv('tm-dash-stat-tiles');
      const sample = type === 'productivity-score'
        ? [['Completion', '86%'], ['On time', '78%']]
        : type === 'daily-goal'
          ? [['Done', '3'], ['Left', '2']]
          : type === 'completion-forecast'
            ? [['Backlog', '32'], ['Velocity', '9/wk']]
            : [['Due today', '5'], ['Overdue', '2']];
      for (const [label, value] of sample) {
        const tile = tiles.createDiv('tm-dash-stat-tile');
        tile.createDiv({ cls: 'tm-dash-stat-value', text: value });
        tile.createDiv({ cls: 'tm-dash-stat-label', text: label });
      }
      return;
    }
    const rows = ['Draft proposal', 'Follow up with Alex', 'Clean inbox'];
    const list = body.createDiv('tm-dash-task-list');
    rows.forEach((row, index) => {
      const task = list.createDiv('tm-dash-task');
      task.createEl('input', { type: 'checkbox', cls: 'tm-dash-task-check' });
      const main = task.createDiv('tm-dash-task-main');
      main.createDiv({ cls: 'tm-dash-task-text', text: row });
      const meta = main.createDiv('tm-dash-task-meta');
      meta.createSpan({ cls: `tm-dash-chip tm-dash-chip--date${index === 0 ? ' is-soon' : ''}`, text: index === 0 ? 'Today' : index === 1 ? 'High' : '15m' });
      if (index === 1) {
        const flag = meta.createSpan({ cls: 'tm-dash-task-flag is-p-high' });
        setIcon(flag, 'flag');
      }
    });
  }

  onClose(): void {
    this.contentEl.empty();
    this.resultsEl = null;
    this.previewEl = null;
  }
}
