import type { DashboardLayout, DashboardWidgetConfig, DashboardWidgetType } from './types';
import {
  DASHBOARD_GRID_COLUMNS,
  DASHBOARD_TEMPLATE_BASE_COLUMNS,
  clampGridPlacement,
  ensureGridPlacements,
  isValidGridPlacement,
  normalizeDashboardWidgetPresentation,
  normalizeDashboardWidgetSize,
  sizeFromLegacyPosition,
} from './dashboard-layout';

export { resolveDashboardWidgetType } from './dashboard-registry';
import { DASHBOARD_WIDGET_TYPE_ALIASES, resolveDashboardWidgetType } from './dashboard-registry';

/** Normalise a stored widget config into the size-based model, dropping legacy fields. */
export function migrateDashboardWidgetConfig(widget: Partial<DashboardWidgetConfig> & { type: DashboardWidgetType }): DashboardWidgetConfig {
  const size = widget.size ? normalizeDashboardWidgetSize(widget.size) : sizeFromLegacyPosition(widget.position);
  const customPresentation = widget.customConfig && typeof widget.customConfig === 'object'
    ? normalizeDashboardWidgetPresentation(widget.customConfig.presentation)
    : undefined;
  const presentation = normalizeDashboardWidgetPresentation(widget.presentation) ?? customPresentation;
  const storedTitle = typeof widget.title === 'string' ? widget.title.trim() : '';
  const oldDefaultTitle = (widget.type === 'quick-capture' && /^quick capture$/iu.test(storedTitle))
    || (widget.type === 'stats' && /^(today at a glance|planned work|today summary)$/iu.test(storedTitle))
    || (widget.type === 'today' && /^(today|current plan)$/iu.test(storedTitle))
    || (widget.type === 'focus-queue' && /^(focus queue|up next)$/iu.test(storedTitle));
  const title = oldDefaultTitle ? defaultWidgetTitle(widget.type) : storedTitle || defaultWidgetTitle(widget.type);
  const config: DashboardWidgetConfig = {
    type: widget.type,
    title,
    size,
    collapsed: Boolean(widget.collapsed),
  };
  if (presentation) config.presentation = presentation;
  if (isValidGridPlacement(widget.grid, DASHBOARD_GRID_COLUMNS)) config.grid = clampGridPlacement(widget.grid, DASHBOARD_GRID_COLUMNS);
  if (typeof widget.query === 'string') config.query = widget.query;
  if (typeof widget.showCompleted === 'boolean') config.showCompleted = widget.showCompleted;
  if (widget.customConfig && typeof widget.customConfig === 'object') config.customConfig = widget.customConfig;
  return config;
}

/** Migrate (or repair) a stored layout: keep only known widget types and ensure valid sizes/order. */
export function migrateDashboardLayout(layout: DashboardLayout): DashboardLayout {
  const stored = Array.isArray(layout.widgets) ? layout.widgets : [];
  // Types already present under their own (non-aliased) identity, so an aliased widget that
  // collapses onto a survivor the layout already contains doesn't create a duplicate card.
  const nativeTypes = new Set<DashboardWidgetType>();
  for (const widget of stored) {
    if (widget && typeof widget.type === 'string' && !(widget.type in DASHBOARD_WIDGET_TYPE_ALIASES)) {
      const resolved = resolveDashboardWidgetType(widget.type);
      if (resolved) nativeTypes.add(resolved);
    }
  }
  const migratedWidgets: DashboardWidgetConfig[] = [];
  const aliasedSeen = new Set<DashboardWidgetType>();
  for (const widget of stored) {
    if (!widget || typeof widget.type !== 'string') continue;
    const resolved = resolveDashboardWidgetType(widget.type);
    if (!resolved) continue;
    if (widget.type in DASHBOARD_WIDGET_TYPE_ALIASES) {
      if (nativeTypes.has(resolved) || aliasedSeen.has(resolved)) continue;
      aliasedSeen.add(resolved);
      // Adopt the survivor's default title/identity — its content differs from the removed widget.
      migratedWidgets.push(migrateDashboardWidgetConfig({ ...widget, type: resolved, title: undefined }));
    } else {
      migratedWidgets.push(migrateDashboardWidgetConfig(widget));
    }
  }
  // Scale layouts authored at a coarser grid resolution (legacy 12-column data, or any older
  // resolution) up to the current fine runtime grid. `gridCols` records a layout's resolution so
  // this only ever runs once. A pristine template layout keeps its pristine status by re-deriving
  // its signature from the scaled widgets.
  const storedCols = typeof layout.gridCols === 'number' && layout.gridCols >= 1
    ? Math.round(layout.gridCols)
    : DASHBOARD_TEMPLATE_BASE_COLUMNS;
  const wasPristine = storedCols !== DASHBOARD_GRID_COLUMNS
    && typeof layout.templateSignature === 'string'
    && dashboardWidgetsSignature(migratedWidgets) === layout.templateSignature;
  if (storedCols !== DASHBOARD_GRID_COLUMNS) {
    const factor = DASHBOARD_GRID_COLUMNS / storedCols;
    for (const widget of migratedWidgets) {
      if (!widget.grid) continue;
      widget.grid = {
        x: Math.round(widget.grid.x * factor),
        y: Math.round(widget.grid.y * factor),
        w: Math.max(1, Math.round(widget.grid.w * factor)),
        h: Math.max(1, Math.round(widget.grid.h * factor)),
      };
    }
  }
  ensureGridPlacements(migratedWidgets, DASHBOARD_GRID_COLUMNS);
  const templateSignature = wasPristine
    ? dashboardWidgetsSignature(migratedWidgets)
    : (typeof layout.templateSignature === 'string' ? layout.templateSignature : undefined);
  return {
    id: layout.id || 'default',
    name: typeof layout.name === 'string' && layout.name.trim() ? layout.name : 'Dashboard',
    widgets: migratedWidgets,
    gridCols: DASHBOARD_GRID_COLUMNS,
    createdAt: typeof layout.createdAt === 'number' ? layout.createdAt : Date.now(),
    updatedAt: Date.now(),
    ...(typeof layout.templateId === 'string' ? { templateId: layout.templateId } : {}),
    ...(typeof layout.templateRevision === 'number' ? { templateRevision: layout.templateRevision } : {}),
    ...(typeof templateSignature === 'string' ? { templateSignature } : {}),
  };
}

export function defaultWidgetTitle(type: DashboardWidgetType): string {
  return ({
    today: 'Agenda',
    agenda: 'Agenda',
    upcoming: 'Upcoming',
    'saved-query': 'Custom query',
    stats: 'Summary',
    'calendar-mini': 'Calendar',
    'kanban-mini': 'Board',
    'overdue-risk': 'Overdue',
    'sync-health': 'Sync health',
    habits: 'Habits',
    pomodoro: 'Focus timer',
    'focus-queue': 'Next up',
    'blocked-waiting': 'Blocked / waiting',
    'inbox-triage': 'Inbox triage',
    eisenhower: 'Eisenhower matrix',
    'workload-project': 'Workload by project',
    'stale-tasks': 'Stale tasks',
    'recently-completed': 'Recently completed',
    'effort-forecast': 'Effort forecast',
    'review-queue': 'Review queues',
    dependencies: 'Dependencies',
    'follow-up': 'Follow-up',
    'priority-distribution': 'Priority distribution',
    'contexts-hotspots': 'Contexts / tags',
    'completion-heatmap': 'Completion heatmap',
    'sync-activity': 'Sync activity',
    'someday-maybe': 'Someday / maybe',
    'project-health': 'Project health',
    'quick-wins': 'Quick wins',
    'deep-work': 'Deep work',
    'energy-fit': 'Energy fit',
    'time-block-suggestions': 'Time block suggestions',
    'date-quality': 'Due date quality',
    'metadata-completeness': 'Metadata completeness',
    'reminder-queue': 'Reminder queue',
    'time-by-project': 'Time by project',
    'estimate-accuracy': 'Estimate accuracy',
    'task-churn': 'Task churn',
    'backlog-growth': 'Backlog growth',
    'file-hotspots': 'File hotspots',
    'orphaned-task-notes': 'Orphaned task notes',
    'waiting-by-person': 'Waiting by person',
    'cost-budget': 'Cost / budget',
    'risk-radar': 'Risk radar',
    'smart-suggestions': 'Smart suggestions',
    momentum: 'Momentum',
    throughput: 'Throughput',
    'productivity-score': 'Productivity score',
    'cycle-time': 'Cycle time',
    'time-heatmap': 'Productive hours',
    'quick-capture': 'Quick actions',
    'daily-goal': 'Daily goal',
    'daily-todos': 'Daily tasks',
    'weekly-review': 'Weekly review',
    'activity-timeline': 'Activity timeline',
    'quick-actions': 'Quick actions',
    'status-distribution': 'Status distribution',
    'assignee-workload': 'Assignee workload',
    'milestone-progress': 'Milestone progress',
    'deadline-strip': 'Deadline strip',
    'task-age-distribution': 'Task age distribution',
    'scope-burnup': 'Scope burn-up',
    'custom-field-breakdown': 'Custom field breakdown',
    'sync-conflicts': 'Sync conflicts',
    'time-in-status': 'Time in status',
    'recurrence-health': 'Recurrence health',
    'today-schedule': 'Today’s schedule',
    'capacity-planner': 'Capacity planner',
    burndown: 'Burndown',
    'completion-forecast': 'Completion forecast',
    'cumulative-flow': 'Cumulative flow',
    'estimate-variance': 'Estimate variance',
    'goals-progress': 'Goals & objectives',
    'areas-of-responsibility': 'Areas of responsibility',
    'next-action-project': 'Next action per project',
    'schedule-conflicts': 'Schedule conflicts',
    'pinned-tasks': 'Pinned / starred',
    'subtask-progress': 'Subtask progress',
    'daily-note': 'Daily note',
    'saved-views': 'Saved views',
    'recently-edited': 'Recently edited',
    'comments-feed': 'Comments',
    'needs-scheduling': 'Needs scheduling',
    'shutdown-ritual': 'Shutdown ritual',
    'on-this-day': 'On this day',
    'goal-streak-calendar': 'Goal streak',
    'tag-explorer': 'Tag explorer',
  } as Record<DashboardWidgetType, string>)[type] ?? 'Widget';
}

/** Bumped whenever a built-in template layout changes so that unmodified template dashboards refresh on load. */
// Rev 23: renamed the scope-aware work surface to Agenda.
// Rev 24: widened the Command center left rail to ~1/3 (Quick actions + Summary) so the capture form
//         and stat tiles stop collapsing into a sliver that wraps every label and inner-scrolls.
// Rev 25: shortened the default Summary card so its fixed-height fallback no longer leaves a large
//         empty block beneath the stat tiles.
// Rev 26: tightened Summary again and reduced its internal vertical rhythm for narrow split panes
//         (for example after opening Settings beside the dashboard).
// Rev 27: made Summary a true compact rail card so it ends right after the stat tiles.
// Rev 28: restored enough Summary tile height for labels to render without clipping.
export const DASHBOARD_TEMPLATE_REVISION = 28;

/** The template revision at which the standalone Overdue card was folded into the Agenda (rev 19). */
export const DASHBOARD_OVERDUE_FOLD_REVISION = 19;

/** The template revision at which Command center folded Next up + Agenda into Today (rev 20). */
export const DASHBOARD_TODAY_MERGE_REVISION = 20;

/** The template revision at which Command center folded its right rail into Today (rev 21). */
export const DASHBOARD_TODAY_FULL_CONSOLIDATION_REVISION = 21;

/** The template revision at which the default Summary card height was tightened (rev 28). */
export const DASHBOARD_SUMMARY_COMPACT_REVISION = 28;

/**
 * Stable structural signature of a widget set. Two layouts with the same signature are visually
 * identical, so we can tell whether the user has modified a template-provided layout.
 */
export function dashboardWidgetsSignature(widgets: readonly DashboardWidgetConfig[]): string {
  return widgets
    .map((widget) => {
      const grid = widget.grid ? `${widget.grid.x},${widget.grid.y},${widget.grid.w},${widget.grid.h}` : '-';
      return [
        widget.type,
        widget.size ?? '',
        widget.presentation ?? '',
        widget.title ?? '',
        grid,
        widget.collapsed ? '1' : '0',
        widget.query ?? '',
        widget.showCompleted === undefined ? '' : widget.showCompleted ? '1' : '0',
      ].join('|');
    })
    .join('\n');
}

