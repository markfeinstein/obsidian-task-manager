import type {
  DashboardGridPlacement,
  DashboardLayout,
  DashboardTemplate,
  DashboardWidgetConfig,
  DashboardWidgetSize,
  DashboardWidgetType,
} from './types';
import {
  DASHBOARD_GRID_COLUMNS,
  DASHBOARD_GRID_SCALE,
  ensureGridPlacements,
  normalizeDashboardWidgetPresentation,
  normalizeDashboardWidgetSize,
  type DashboardTemplateTone,
} from './dashboard-layout';
import {
  DASHBOARD_OVERDUE_FOLD_REVISION,
  DASHBOARD_SUMMARY_COMPACT_REVISION,
  DASHBOARD_TEMPLATE_REVISION,
  DASHBOARD_TODAY_FULL_CONSOLIDATION_REVISION,
  DASHBOARD_TODAY_MERGE_REVISION,
  dashboardWidgetsSignature,
  defaultWidgetTitle,
  migrateDashboardLayout,
  migrateDashboardWidgetConfig,
  resolveDashboardWidgetType,
} from './dashboard-model';

// ── Dashboard import/export, templates, and multi-dashboard helpers ─────────

export const DASHBOARD_EXPORT_VERSION = 1;
export const DASHBOARD_LAYOUT_EXPORT_KIND = 'task-manager-dashboard-layout';
export const DASHBOARD_TEMPLATE_EXPORT_KIND = 'task-manager-dashboard-template';
export const DASHBOARD_COLLECTION_EXPORT_KIND = 'task-manager-dashboard-collection';
export const DASHBOARD_NOTE_CODE_BLOCK = 'task-manager-dashboard';
export const DASHBOARD_WIDGET_CODE_BLOCK = 'task-manager-widget';

export type DashboardBuiltinTemplateId = 'default' | 'focus' | 'planning' | 'review' | 'analytics' | 'project' | 'team';

export interface DashboardBuiltinTemplate {
  id: DashboardBuiltinTemplateId;
  name: string;
  description: string;
  /** Lightweight visual/narrative tone used by picker previews and dashboard chrome. */
  tone: DashboardTemplateTone;
  /** The primary question this template should answer first. */
  primaryQuestion: string;
}

export const DASHBOARD_BUILTIN_TEMPLATES: DashboardBuiltinTemplate[] = [
  { id: 'default', tone: 'daily', name: 'Command center', primaryQuestion: 'What needs attention today?', description: 'A polished daily home base: quick capture, a scope-aware agenda, review queue counts, blockers, and recent progress.' },
  { id: 'focus', tone: 'focus', name: 'Focus flow', primaryQuestion: 'What should I do next?', description: 'A low-distraction execution layout that narrows attention to today’s highest-leverage work and a shutdown ritual.' },
  { id: 'planning', tone: 'planning', name: 'Planning studio', primaryQuestion: 'Can this day or week realistically fit?', description: 'A time-blocking and capacity planning cockpit for turning a messy backlog into a realistic day or week.' },
  { id: 'review', tone: 'review', name: 'Review ritual', primaryQuestion: 'What did I finish, learn, and carry forward?', description: 'A reflective weekly/daily review board for momentum, completions, habits, streaks, and lessons learned.' },
  { id: 'analytics', tone: 'analytics', name: 'Analytics lab', primaryQuestion: 'Is the system healthy?', description: 'A data-dense but balanced dashboard for velocity, flow, forecasts, cycle time, and estimation accuracy.' },
  { id: 'project', tone: 'project', name: 'Project control', primaryQuestion: 'Which project is most at risk?', description: 'A project manager’s overview: health, risk, goals, blockers, milestones, stale work, and delivery trend.' },
  { id: 'team', tone: 'team', name: 'Team handoff', primaryQuestion: 'Who or what needs a response?', description: 'A collaboration dashboard for follow-ups, waiting items, comments, assignees, reviews, sync health, and costs.' },
];

export function dashboardTemplateToneForId(id: string | undefined): DashboardTemplateTone {
  const builtin = DASHBOARD_BUILTIN_TEMPLATES.find((template) => template.id === id);
  return builtin?.tone ?? 'custom';
}

export interface DashboardImportResult {
  layouts: DashboardLayout[];
  templates: DashboardTemplate[];
  warnings: string[];
}

export interface DashboardExportEnvelope {
  kind: typeof DASHBOARD_LAYOUT_EXPORT_KIND | typeof DASHBOARD_TEMPLATE_EXPORT_KIND | typeof DASHBOARD_COLLECTION_EXPORT_KIND;
  version: typeof DASHBOARD_EXPORT_VERSION;
  exportedAt: string;
  layout?: DashboardLayout;
  template?: DashboardTemplate;
  layouts?: DashboardLayout[];
  templates?: DashboardTemplate[];
}

export function dashboardIdFromName(name: string, fallback = 'dashboard'): string {
  const base = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '');
  return base || fallback;
}

export function uniqueDashboardId(preferred: string, existing: Iterable<string>, fallback = 'dashboard'): string {
  const used = new Set(existing);
  const base = dashboardIdFromName(preferred, fallback);
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  return candidate;
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  try {
    return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
  } catch {
    return { ...value };
  }
}

export function cloneDashboardWidgetConfig(config: DashboardWidgetConfig): DashboardWidgetConfig {
  const cloned = migrateDashboardWidgetConfig(config);
  if (config.grid) cloned.grid = { ...config.grid };
  if (config.customConfig) cloned.customConfig = cloneRecord(config.customConfig);
  return cloned;
}

export function cloneDashboardLayout(
  layout: DashboardLayout,
  overrides: Partial<Pick<DashboardLayout, 'id' | 'name' | 'createdAt' | 'updatedAt'>> = {},
): DashboardLayout {
  const now = Date.now();
  const migrated = migrateDashboardLayout(layout);
  const widgets = migrated.widgets.map((widget) => cloneDashboardWidgetConfig(widget));
  ensureGridPlacements(widgets, DASHBOARD_GRID_COLUMNS);
  return {
    id: overrides.id ?? migrated.id,
    name: overrides.name ?? migrated.name,
    widgets,
    // Widgets are already at runtime resolution after migration; stamp the resolution so a later
    // migration never rescales them again.
    gridCols: DASHBOARD_GRID_COLUMNS,
    createdAt: overrides.createdAt ?? (typeof layout.createdAt === 'number' ? layout.createdAt : migrated.createdAt || now),
    updatedAt: overrides.updatedAt ?? (typeof layout.updatedAt === 'number' ? layout.updatedAt : migrated.updatedAt || now),
  };
}

function templateWidget(
  type: DashboardWidgetType,
  size: DashboardWidgetSize,
  grid: DashboardGridPlacement,
  overrides: Partial<DashboardWidgetConfig> = {},
): DashboardWidgetConfig {
  const s = DASHBOARD_GRID_SCALE;
  return {
    type,
    title: overrides.title ?? defaultWidgetTitle(type),
    size,
    // Authored on the coarse 12-column grid, scaled up to the fine runtime grid.
    grid: { x: grid.x * s, y: grid.y * s, w: grid.w * s, h: grid.h * s },
    collapsed: overrides.collapsed,
    query: overrides.query,
    showCompleted: overrides.showCompleted,
    presentation: overrides.presentation,
    customConfig: overrides.customConfig,
  };
}

// Like templateWidget, but the grid is already in fine runtime units (NOT scaled by ×8). Used for
// the left rail, where a card may need a height between the coarse multiples — e.g. a compact Summary
// card can sit between the legacy small and large footprints instead of baking in a vertical void.
function fineWidget(
  type: DashboardWidgetType,
  size: DashboardWidgetSize,
  grid: DashboardGridPlacement,
  overrides: Partial<DashboardWidgetConfig> = {},
): DashboardWidgetConfig {
  return {
    type,
    title: overrides.title ?? defaultWidgetTitle(type),
    size,
    grid: { x: grid.x, y: grid.y, w: grid.w, h: grid.h },
    collapsed: overrides.collapsed,
    query: overrides.query,
    showCompleted: overrides.showCompleted,
    presentation: overrides.presentation,
    customConfig: overrides.customConfig,
  };
}

function dashboardLayoutFromTemplateWidgets(id: string, name: string, widgets: DashboardWidgetConfig[], now: number): DashboardLayout {
  const clonedWidgets = widgets.map((widget) => cloneDashboardWidgetConfig(widget));
  ensureGridPlacements(clonedWidgets, DASHBOARD_GRID_COLUMNS);
  return {
    id,
    name,
    widgets: clonedWidgets,
    createdAt: now,
    updatedAt: now,
    gridCols: DASHBOARD_GRID_COLUMNS,
    templateId: id,
    templateRevision: DASHBOARD_TEMPLATE_REVISION,
    templateSignature: dashboardWidgetsSignature(clonedWidgets),
  };
}

export function createDefaultDashboardLayout(now: number = Date.now()): DashboardLayout {
  // Decision-led command center (authored on the 12-col base, scaled to the fine 96-col grid):
  //   - Left rail (~1/3 width): capture first, then a Today summary with completion + review queue
  //     counts. A third of the width keeps the capture form, summary ring, and stat tiles legible on
  //     wide monitors instead of collapsing into a sliver that wraps every label and inner-scrolls.
  //   - Center/right (~2/3 width): one wide Agenda card that starts with overdue and blocked work,
  //     then dated work, backlog, and recently completed tasks so the scoped page has one reading
  //     order.
  // Large queues render top-N + “review all” affordances, so the dashboard reads as a daily decision
  // surface rather than a full backlog inventory.
  return dashboardLayoutFromTemplateWidgets('default', 'Command center', [
    fineWidget('quick-capture', 'small', { x: 0, y: 0, w: 32, h: 16 }, { presentation: 'kpi' }),
    fineWidget('stats', 'large', { x: 0, y: 16, w: 32, h: 18 }, { title: 'Summary' }),
    templateWidget('today', 'large', { x: 4, y: 0, w: 8, h: 8 }, { title: 'Agenda', presentation: 'hero' }),
  ], now);
}

/**
 * Regenerate a dashboard from its source built-in template when the template has changed and the
 * user has NOT modified the layout. Customized dashboards (signature mismatch) are always left as-is.
 */
export function refreshPristineTemplateLayout(layout: DashboardLayout, now: number = Date.now()): DashboardLayout {
  const templateId = layout.templateId;
  if (!templateId || !DASHBOARD_BUILTIN_TEMPLATES.some((template) => template.id === templateId)) return layout;
  if (layout.templateRevision === DASHBOARD_TEMPLATE_REVISION) return layout;
  const pristine = typeof layout.templateSignature === 'string'
    && dashboardWidgetsSignature(layout.widgets) === layout.templateSignature;
  if (!pristine) return layout;
  const fresh = createDashboardLayoutFromTemplate(templateId, now);
  return { ...fresh, id: layout.id, name: layout.name, createdAt: layout.createdAt, updatedAt: now };
}

/**
 * Compatibility hook for dashboards saved during earlier template revisions.
 *
 * Momentum now owns gamification again, so a stored Momentum card is never redundant merely because a
 * Today summary card is also present. Keep the exported helper as a no-op so older call sites and
 * tests preserve user-added Momentum widgets instead of silently removing the only XP/achievement card.
 */
export function dropRedundantMomentumWidget(layout: DashboardLayout): DashboardLayout {
  return layout;
}

/**
 * One-time fold of the standalone Overdue card into the Agenda for default-template dashboards that
 * predate rev 19. The Agenda now groups Overdue → Today → Upcoming, so a separate Overdue card only
 * duplicated its rows. Pristine dashboards are regenerated wholesale by refreshPristineTemplateLayout;
 * this handles customized (non-pristine) default dashboards, which that helper deliberately leaves
 * alone. Idempotent: it stamps the fold revision so a deliberately re-added Overdue card on an
 * up-to-date dashboard is never stripped again.
 */
function dashboardLegacyFoldOverdueRelation(widget: DashboardWidgetConfig, agendaGrid: DashboardGridPlacement): 'above' | 'below' | null {
  if (widget.type !== 'overdue-risk'
    || widget.title !== defaultWidgetTitle('overdue-risk')
    || widget.query !== undefined
    || widget.showCompleted !== undefined
    || widget.customConfig !== undefined
    || !widget.grid
    || widget.grid.x !== agendaGrid.x
    || widget.grid.w !== agendaGrid.w) return null;
  if (widget.grid.y + widget.grid.h === agendaGrid.y) return 'above';
  if (widget.grid.y === agendaGrid.y + agendaGrid.h) return 'below';
  return null;
}

export function foldOverdueCardIntoAgenda(layout: DashboardLayout, now: number = Date.now()): DashboardLayout {
  if (layout.templateId !== 'default') return layout;
  if ((layout.templateRevision ?? 0) >= DASHBOARD_OVERDUE_FOLD_REVISION) return layout;
  const agendaIndex = layout.widgets.findIndex((widget) => widget.type === 'agenda' && widget.grid);
  const agendaGrid = agendaIndex >= 0 ? layout.widgets[agendaIndex].grid : undefined;
  let overdueRelation: 'above' | 'below' | null = null;
  const overdueIndex = agendaGrid
    ? layout.widgets.findIndex((widget) => {
      overdueRelation = dashboardLegacyFoldOverdueRelation(widget, agendaGrid);
      return overdueRelation !== null;
    })
    : -1;
  if (overdueIndex < 0) {
    // Nothing safely identifiable as the legacy folded card; close the gate so deliberate custom
    // Overdue cards are preserved and never reconsidered.
    return { ...layout, templateRevision: DASHBOARD_OVERDUE_FOLD_REVISION };
  }
  const overdue = layout.widgets[overdueIndex];
  const freedHeight = overdue.grid?.h ?? 0;
  const widgets = layout.widgets
    .filter((_, index) => index !== overdueIndex)
    .map((widget) => cloneDashboardWidgetConfig(widget));
  // Grow the Agenda only when removing the adjacent legacy card; moved or user-added Overdue cards
  // are preserved above, avoiding unrelated layout rewrites. Legacy defaults shipped with Overdue
  // both above and below Agenda across revisions, so absorb the gap from either side.
  if (freedHeight > 0) {
    const agenda = widgets.find((widget) => widget.type === 'agenda');
    if (agenda?.grid) {
      agenda.grid = overdueRelation === 'above'
        ? { ...agenda.grid, y: Math.max(0, agenda.grid.y - freedHeight), h: agenda.grid.h + freedHeight }
        : { ...agenda.grid, h: agenda.grid.h + freedHeight };
    }
  }
  ensureGridPlacements(widgets, layout.gridCols ?? DASHBOARD_GRID_COLUMNS);
  return { ...layout, widgets, templateRevision: DASHBOARD_OVERDUE_FOLD_REVISION, updatedAt: now };
}

function isLegacyDefaultNextUpWidget(widget: DashboardWidgetConfig): boolean {
  return widget.type === 'focus-queue'
    && widget.title === defaultWidgetTitle('focus-queue')
    && (widget.presentation === undefined || widget.presentation === 'hero')
    && widget.query === undefined
    && widget.showCompleted === undefined
    && widget.customConfig === undefined
    && Boolean(widget.grid);
}

function isLegacyDefaultAgendaWidget(widget: DashboardWidgetConfig): boolean {
  return widget.type === 'agenda'
    && widget.title === defaultWidgetTitle('agenda')
    && widget.presentation === undefined
    && widget.query === undefined
    && widget.showCompleted === undefined
    && widget.customConfig === undefined
    && Boolean(widget.grid);
}

/**
 * One-time merge of the default Command center's adjacent Next up + Agenda cards into the Today
 * widget. Customized dashboards are handled conservatively: only untouched default cards that are
 * still stacked in the old template relationship are merged, so deliberately separated / retitled
 * cards survive.
 */
export function mergeNextUpAgendaIntoToday(layout: DashboardLayout, now: number = Date.now()): DashboardLayout {
  if (layout.templateId !== 'default') return layout;
  if ((layout.templateRevision ?? 0) >= DASHBOARD_TODAY_MERGE_REVISION) return layout;
  const focusIndex = layout.widgets.findIndex(isLegacyDefaultNextUpWidget);
  if (focusIndex < 0) return { ...layout, templateRevision: DASHBOARD_TODAY_MERGE_REVISION };
  const focus = layout.widgets[focusIndex];
  const focusGrid = focus.grid;
  if (!focusGrid) return { ...layout, templateRevision: DASHBOARD_TODAY_MERGE_REVISION };
  const agendaIndex = layout.widgets.findIndex((widget) => {
    if (!isLegacyDefaultAgendaWidget(widget) || !widget.grid) return false;
    return widget.grid.x === focusGrid.x
      && widget.grid.w === focusGrid.w
      && widget.grid.y === focusGrid.y + focusGrid.h;
  });
  if (agendaIndex < 0) return { ...layout, templateRevision: DASHBOARD_TODAY_MERGE_REVISION };
  const agenda = layout.widgets[agendaIndex];
  const agendaGrid = agenda.grid;
  const widgets = layout.widgets
    .filter((_, index) => index !== agendaIndex)
    .map((widget) => {
      if (widget !== focus) return cloneDashboardWidgetConfig(widget);
      return fineWidget('today', 'large', {
        x: focusGrid.x,
        y: focusGrid.y,
        w: focusGrid.w,
        h: focusGrid.h + (agendaGrid?.h ?? 0),
      }, { title: defaultWidgetTitle('today'), presentation: focus.presentation === 'hero' ? 'hero' : undefined });
    });
  ensureGridPlacements(widgets, layout.gridCols ?? DASHBOARD_GRID_COLUMNS);
  return { ...layout, widgets, templateRevision: DASHBOARD_TODAY_MERGE_REVISION, updatedAt: now };
}

function isLegacyDefaultRightRailWidget(widget: DashboardWidgetConfig): boolean {
  const defaultishTitle = (widget.type === 'blocked-waiting' && widget.title === defaultWidgetTitle('blocked-waiting'))
    || (widget.type === 'review-queue' && widget.title === defaultWidgetTitle('review-queue'))
    || (widget.type === 'recently-completed' && (widget.title === 'Recently done' || widget.title === defaultWidgetTitle('recently-completed')));
  return defaultishTitle
    && widget.query === undefined
    && widget.showCompleted === undefined
    && widget.customConfig === undefined
    && Boolean(widget.grid);
}

/**
 * One-time consolidation of Command center's default right rail. Blocked and Recently done now live
 * inside Today, while review queue counts live in Today summary. Customized / relocated cards are
 * preserved unless they are still in the old right-rail relationship next to the Today card.
 */
export function consolidateDefaultRightRailIntoToday(layout: DashboardLayout, now: number = Date.now()): DashboardLayout {
  if (layout.templateId !== 'default') return layout;
  if ((layout.templateRevision ?? 0) >= DASHBOARD_TODAY_FULL_CONSOLIDATION_REVISION) return layout;
  const today = layout.widgets.find((widget) => widget.type === 'today' && widget.grid);
  const todayGrid = today?.grid;
  if (!today || !todayGrid) return { ...layout, templateRevision: DASHBOARD_TODAY_FULL_CONSOLIDATION_REVISION };
  const removed = layout.widgets.filter((widget) => {
    if (!isLegacyDefaultRightRailWidget(widget) || !widget.grid) return false;
    return widget.grid.x >= todayGrid.x + todayGrid.w && widget.grid.y >= todayGrid.y && widget.grid.y < todayGrid.y + todayGrid.h;
  });
  if (removed.length === 0) return { ...layout, templateRevision: DASHBOARD_TODAY_FULL_CONSOLIDATION_REVISION };
  const right = Math.max(todayGrid.x + todayGrid.w, ...removed.map((widget) => (widget.grid?.x ?? 0) + (widget.grid?.w ?? 0)));
  const bottom = Math.max(todayGrid.y + todayGrid.h, ...removed.map((widget) => (widget.grid?.y ?? 0) + (widget.grid?.h ?? 0)));
  const removeSet = new Set(removed);
  const widgets = layout.widgets
    .filter((widget) => !removeSet.has(widget))
    .map((widget) => {
      const cloned = cloneDashboardWidgetConfig(widget);
      if (widget === today && cloned.grid) cloned.grid = { ...cloned.grid, w: right - todayGrid.x, h: bottom - todayGrid.y };
      return cloned;
    });
  ensureGridPlacements(widgets, layout.gridCols ?? DASHBOARD_GRID_COLUMNS);
  return { ...layout, widgets, templateRevision: DASHBOARD_TODAY_FULL_CONSOLIDATION_REVISION, updatedAt: now };
}

function isDefaultSummaryWidgetNeedingCompact(widget: DashboardWidgetConfig): boolean {
  const grid = widget.grid;
  if (!grid) return false;
  return widget.type === 'stats'
    && widget.title === defaultWidgetTitle('stats')
    && widget.size === 'large'
    && widget.presentation === undefined
    && widget.query === undefined
    && widget.showCompleted === undefined
    && widget.customConfig === undefined
    && grid.x === 0
    && grid.y === 16
    && grid.w === 32
    && (grid.h === 32 || grid.h === 24 || grid.h === 20 || grid.h === 16);
}

/**
 * One-time tightening of the default Command center Summary card. Rev 24 widened the left rail but
 * left Summary at a full large-card height; with the compact Summary renderer this created a large
 * blank block below the stat tiles whenever auto-fit was disabled or had not measured yet. Customized
 * or manually resized Summary widgets are preserved.
 */
export function compactDefaultSummaryWidget(layout: DashboardLayout, now: number = Date.now()): DashboardLayout {
  if (layout.templateId !== 'default') return layout;
  if ((layout.templateRevision ?? 0) >= DASHBOARD_SUMMARY_COMPACT_REVISION) return layout;
  const summaryIndex = layout.widgets.findIndex(isDefaultSummaryWidgetNeedingCompact);
  if (summaryIndex < 0) return { ...layout, templateRevision: DASHBOARD_SUMMARY_COMPACT_REVISION };
  const widgets = layout.widgets.map((widget, index) => {
    const cloned = cloneDashboardWidgetConfig(widget);
    if (index === summaryIndex && cloned.grid) cloned.grid = { ...cloned.grid, h: 18 };
    return cloned;
  });
  ensureGridPlacements(widgets, layout.gridCols ?? DASHBOARD_GRID_COLUMNS);
  return { ...layout, widgets, templateRevision: DASHBOARD_SUMMARY_COMPACT_REVISION, updatedAt: now };
}

export function createDashboardLayoutFromTemplate(templateId: string, now: number = Date.now()): DashboardLayout {
  if (templateId === 'default') return createDefaultDashboardLayout(now);
  if (templateId === 'focus') {
    return dashboardLayoutFromTemplateWidgets('focus', 'Focus flow', [
      templateWidget('focus-queue', 'large', { x: 0, y: 0, w: 6, h: 4 }, { presentation: 'hero' }),
      templateWidget('daily-goal', 'small', { x: 6, y: 0, w: 3, h: 2 }, { presentation: 'kpi' }),
      templateWidget('agenda', 'large', { x: 9, y: 0, w: 3, h: 4 }),
      templateWidget('pomodoro', 'small', { x: 6, y: 2, w: 3, h: 2 }, { presentation: 'kpi' }),
      templateWidget('pinned-tasks', 'medium', { x: 0, y: 4, w: 4, h: 3 }),
      templateWidget('quick-wins', 'medium', { x: 4, y: 4, w: 4, h: 3 }),
      templateWidget('deep-work', 'medium', { x: 8, y: 4, w: 4, h: 3 }),
      templateWidget('energy-fit', 'medium', { x: 0, y: 7, w: 4, h: 3 }),
      templateWidget('time-block-suggestions', 'large', { x: 4, y: 7, w: 5, h: 3 }),
      templateWidget('shutdown-ritual', 'medium', { x: 9, y: 7, w: 3, h: 3 }),
    ], now);
  }
  if (templateId === 'planning') {
    return dashboardLayoutFromTemplateWidgets('planning', 'Planning studio', [
      templateWidget('capacity-planner', 'large', { x: 0, y: 0, w: 4, h: 4 }, { presentation: 'hero' }),
      templateWidget('today-schedule', 'large', { x: 4, y: 0, w: 5, h: 4 }),
      templateWidget('schedule-conflicts', 'small', { x: 9, y: 0, w: 3, h: 2 }, { presentation: 'kpi' }),
      templateWidget('deadline-strip', 'small', { x: 9, y: 2, w: 3, h: 2 }, { presentation: 'kpi' }),
      templateWidget('time-block-suggestions', 'large', { x: 0, y: 4, w: 6, h: 3 }),
      templateWidget('upcoming', 'medium', { x: 6, y: 4, w: 3, h: 3 }),
      templateWidget('needs-scheduling', 'medium', { x: 9, y: 4, w: 3, h: 3 }),
      templateWidget('next-action-project', 'medium', { x: 0, y: 7, w: 6, h: 3 }),
    ], now);
  }
  if (templateId === 'review') {
    return dashboardLayoutFromTemplateWidgets('review', 'Review ritual', [
      templateWidget('momentum', 'large', { x: 0, y: 0, w: 5, h: 4 }, { presentation: 'hero' }),
      templateWidget('weekly-review', 'medium', { x: 5, y: 0, w: 4, h: 4 }),
      templateWidget('daily-goal', 'small', { x: 9, y: 0, w: 3, h: 2 }, { presentation: 'kpi' }),
      templateWidget('shutdown-ritual', 'small', { x: 9, y: 2, w: 3, h: 2 }, { presentation: 'kpi' }),
      templateWidget('recently-completed', 'medium', { x: 0, y: 4, w: 4, h: 3 }),
      templateWidget('activity-timeline', 'medium', { x: 4, y: 4, w: 4, h: 3 }),
      templateWidget('goal-streak-calendar', 'medium', { x: 8, y: 4, w: 4, h: 3 }),
      templateWidget('habits', 'large', { x: 0, y: 7, w: 6, h: 3 }),
      templateWidget('on-this-day', 'medium', { x: 6, y: 7, w: 3, h: 3 }),
    ], now);
  }
  if (templateId === 'analytics') {
    return dashboardLayoutFromTemplateWidgets('analytics', 'Analytics lab', [
      templateWidget('productivity-score', 'large', { x: 0, y: 0, w: 5, h: 4 }, { presentation: 'hero' }),
      templateWidget('throughput', 'small', { x: 5, y: 0, w: 2, h: 2 }, { presentation: 'kpi' }),
      templateWidget('cycle-time', 'small', { x: 7, y: 0, w: 2, h: 2 }, { presentation: 'kpi' }),
      templateWidget('completion-forecast', 'small', { x: 9, y: 0, w: 3, h: 2 }, { presentation: 'kpi' }),
      templateWidget('estimate-variance', 'medium', { x: 5, y: 2, w: 4, h: 2 }),
      templateWidget('task-churn', 'small', { x: 9, y: 2, w: 3, h: 2 }),
      templateWidget('burndown', 'medium', { x: 0, y: 4, w: 4, h: 3 }),
      templateWidget('cumulative-flow', 'medium', { x: 4, y: 4, w: 4, h: 3 }),
      templateWidget('time-by-project', 'medium', { x: 8, y: 4, w: 4, h: 3 }),
      templateWidget('estimate-accuracy', 'medium', { x: 0, y: 7, w: 4, h: 3 }),
      templateWidget('time-heatmap', 'large', { x: 4, y: 7, w: 4, h: 3 }),
      templateWidget('completion-heatmap', 'large', { x: 8, y: 7, w: 4, h: 3 }),
    ], now);
  }
  if (templateId === 'project') {
    return dashboardLayoutFromTemplateWidgets('project', 'Project control', [
      templateWidget('project-health', 'large', { x: 0, y: 0, w: 5, h: 4 }, { presentation: 'hero' }),
      templateWidget('risk-radar', 'large', { x: 5, y: 0, w: 4, h: 4 }),
      templateWidget('goals-progress', 'large', { x: 9, y: 0, w: 3, h: 4 }),
      templateWidget('next-action-project', 'medium', { x: 0, y: 4, w: 4, h: 3 }),
      templateWidget('workload-project', 'medium', { x: 4, y: 4, w: 4, h: 3 }),
      templateWidget('dependencies', 'medium', { x: 8, y: 4, w: 4, h: 3 }),
      templateWidget('milestone-progress', 'medium', { x: 0, y: 7, w: 4, h: 3 }),
      templateWidget('stale-tasks', 'medium', { x: 4, y: 7, w: 4, h: 3 }),
      templateWidget('burndown', 'medium', { x: 8, y: 7, w: 4, h: 3 }),
      templateWidget('needs-scheduling', 'medium', { x: 0, y: 10, w: 4, h: 3 }),
      templateWidget('deadline-strip', 'large', { x: 4, y: 10, w: 8, h: 3 }),
    ], now);
  }
  if (templateId === 'team') {
    return dashboardLayoutFromTemplateWidgets('team', 'Team handoff', [
      templateWidget('follow-up', 'large', { x: 0, y: 0, w: 5, h: 4 }, { presentation: 'hero' }),
      templateWidget('waiting-by-person', 'large', { x: 5, y: 0, w: 4, h: 4 }),
      templateWidget('comments-feed', 'large', { x: 9, y: 0, w: 3, h: 4 }),
      templateWidget('assignee-workload', 'medium', { x: 0, y: 4, w: 4, h: 3 }),
      templateWidget('review-queue', 'medium', { x: 4, y: 4, w: 4, h: 3 }),
      templateWidget('blocked-waiting', 'medium', { x: 8, y: 4, w: 4, h: 3 }),
      templateWidget('sync-health', 'medium', { x: 0, y: 7, w: 3, h: 3 }),
      templateWidget('sync-conflicts', 'medium', { x: 3, y: 7, w: 3, h: 3 }),
      templateWidget('sync-activity', 'medium', { x: 6, y: 7, w: 3, h: 3 }),
      templateWidget('cost-budget', 'medium', { x: 9, y: 7, w: 3, h: 3 }),
      templateWidget('quick-capture', 'small', { x: 0, y: 10, w: 3, h: 2 }, { title: 'Quick actions' }),
      templateWidget('recently-edited', 'medium', { x: 3, y: 10, w: 5, h: 3 }),
      templateWidget('inbox-triage', 'medium', { x: 8, y: 10, w: 4, h: 3 }),
    ], now);
  }
  return createDefaultDashboardLayout(now);
}

export function cloneDashboardTemplateAsLayout(template: DashboardTemplate, id: string, name: string, now: number = Date.now()): DashboardLayout {
  return cloneDashboardLayout(template.layout, { id, name, createdAt: now, updatedAt: now });
}

export function createDashboardTemplateFromLayout(layout: DashboardLayout, id: string, name: string, description: string, now: number = Date.now()): DashboardTemplate {
  return {
    id,
    name: name.trim() || layout.name || 'Dashboard template',
    description: description.trim(),
    layout: cloneDashboardLayout(layout, { id: `${id}-layout`, name: name.trim() || layout.name || 'Dashboard template', createdAt: now, updatedAt: now }),
    createdAt: now,
    updatedAt: now,
  };
}

export function exportDashboardLayout(layout: DashboardLayout): string {
  const payload: DashboardExportEnvelope = {
    kind: DASHBOARD_LAYOUT_EXPORT_KIND,
    version: DASHBOARD_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    layout: cloneDashboardLayout(layout),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function exportDashboardTemplate(template: DashboardTemplate): string {
  const payload: DashboardExportEnvelope = {
    kind: DASHBOARD_TEMPLATE_EXPORT_KIND,
    version: DASHBOARD_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    template: {
      ...template,
      layout: cloneDashboardLayout(template.layout),
    },
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function exportDashboardCollection(layouts: DashboardLayout[], templates: DashboardTemplate[] = []): string {
  const payload: DashboardExportEnvelope = {
    kind: DASHBOARD_COLLECTION_EXPORT_KIND,
    version: DASHBOARD_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    layouts: layouts.map((layout) => cloneDashboardLayout(layout)),
    templates: templates.map((template) => ({ ...template, layout: cloneDashboardLayout(template.layout) })),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isLayoutLike(value: unknown): value is Record<string, unknown> & { widgets: unknown[] } {
  return isRecord(value) && Array.isArray(value.widgets);
}

function importedTimestamp(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function importOneDashboardLayout(value: unknown, existing: Set<string>, warnings: string[]): DashboardLayout | null {
  if (!isLayoutLike(value)) {
    warnings.push('Skipped an entry that was not a dashboard layout.');
    return null;
  }
  const migrated = migrateDashboardLayout(value as unknown as DashboardLayout);
  const name = migrated.name.trim() || 'Imported dashboard';
  const preferredId = typeof value.id === 'string' && value.id.trim() ? value.id : name;
  const id = uniqueDashboardId(preferredId, existing, 'dashboard');
  existing.add(id);
  return cloneDashboardLayout(migrated, {
    id,
    name,
    createdAt: importedTimestamp(value.createdAt, Date.now()),
    updatedAt: Date.now(),
  });
}

function importOneDashboardTemplate(value: unknown, existing: Set<string>, warnings: string[]): DashboardTemplate | null {
  if (!isRecord(value) || !isLayoutLike(value.layout)) {
    warnings.push('Skipped an entry that was not a dashboard template.');
    return null;
  }
  const layout = migrateDashboardLayout(value.layout as unknown as DashboardLayout);
  const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim() : layout.name || 'Imported template';
  const preferredId = typeof value.id === 'string' && value.id.trim() ? value.id : name;
  const id = uniqueDashboardId(preferredId, existing, 'template');
  existing.add(id);
  const now = Date.now();
  return {
    id,
    name,
    description: typeof value.description === 'string' ? value.description : '',
    layout: cloneDashboardLayout(layout, { id: `${id}-layout`, name, createdAt: importedTimestamp(value.createdAt, now), updatedAt: now }),
    createdAt: importedTimestamp(value.createdAt, now),
    updatedAt: now,
  };
}

export function parseDashboardImportPayload(
  source: string,
  existingLayoutIds: Iterable<string> = [],
  existingTemplateIds: Iterable<string> = [],
): DashboardImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid dashboard JSON: ${error instanceof Error ? error.message : String(error)}`);
  }

  const layoutIds = new Set(existingLayoutIds);
  const templateIds = new Set(existingTemplateIds);
  const result: DashboardImportResult = { layouts: [], templates: [], warnings: [] };
  const addLayout = (value: unknown): void => {
    const layout = importOneDashboardLayout(value, layoutIds, result.warnings);
    if (layout) result.layouts.push(layout);
  };
  const addTemplate = (value: unknown): void => {
    const template = importOneDashboardTemplate(value, templateIds, result.warnings);
    if (template) result.templates.push(template);
  };

  if (Array.isArray(parsed)) {
    for (const entry of parsed) addLayout(entry);
  } else if (isLayoutLike(parsed)) {
    addLayout(parsed);
  } else if (isRecord(parsed)) {
    const kind = typeof parsed.kind === 'string' ? parsed.kind : '';
    if ((kind === DASHBOARD_LAYOUT_EXPORT_KIND || kind === 'task-manager-dashboard') && 'layout' in parsed) {
      addLayout(parsed.layout);
    } else if (kind === DASHBOARD_TEMPLATE_EXPORT_KIND && 'template' in parsed) {
      addTemplate(parsed.template);
    } else if (kind === DASHBOARD_COLLECTION_EXPORT_KIND || Array.isArray(parsed.layouts) || Array.isArray(parsed.dashboards)) {
      const layouts = Array.isArray(parsed.layouts) ? parsed.layouts : Array.isArray(parsed.dashboards) ? parsed.dashboards : [];
      const templates = Array.isArray(parsed.templates) ? parsed.templates : [];
      for (const layout of layouts) addLayout(layout);
      for (const template of templates) addTemplate(template);
    } else if ('template' in parsed) {
      addTemplate(parsed.template);
    } else if ('layout' in parsed) {
      addLayout(parsed.layout);
    } else {
      result.warnings.push('No dashboard layouts or templates found in the import payload.');
    }
  } else {
    result.warnings.push('No dashboard layouts or templates found in the import payload.');
  }

  if (result.layouts.length === 0 && result.templates.length === 0) {
    throw new Error(result.warnings[0] ?? 'No dashboard layouts or templates found.');
  }
  return result;
}

function parseDashboardJson(source: string): unknown {
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(`Invalid dashboard JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

/** Parse a note-backed dashboard code block into a layout, preserving the stored note identity. */
export function parseDashboardLayoutBlock(source: string, now: number = Date.now()): DashboardLayout {
  const trimmed = source.trim();
  if (!trimmed) return createDefaultDashboardLayout(now);
  const parsed = parseDashboardJson(trimmed);
  let candidate: unknown = parsed;
  if (isRecord(parsed)) {
    if (isLayoutLike(parsed.layout)) candidate = parsed.layout;
    else if (Array.isArray(parsed.layouts) && parsed.layouts.length > 0) candidate = parsed.layouts[0];
    else if (Array.isArray(parsed.dashboards) && parsed.dashboards.length > 0) candidate = parsed.dashboards[0];
  }
  if (!isLayoutLike(candidate)) throw new Error('Dashboard block must contain a dashboard layout or exported dashboard layout envelope.');
  return migrateDashboardLayout(candidate as unknown as DashboardLayout);
}

function parseLooseWidgetBlock(source: string): Record<string, unknown> {
  const trimmed = source.trim();
  if (!trimmed) return {};
  if (!trimmed.includes(':') && !trimmed.includes('{')) return { type: trimmed };
  const out: Record<string, unknown> = {};
  for (const rawLine of source.split(/\r?\n/u)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/u.exec(line);
    if (!match) continue;
    const key = match[1];
    const value = match[2].trim();
    if (value === 'true') out[key] = true;
    else if (value === 'false') out[key] = false;
    else out[key] = value;
  }
  return out;
}

/** Parse a `task-manager-widget` block. Supports JSON or simple `key: value` lines. */
export function parseDashboardWidgetBlock(source: string): DashboardWidgetConfig {
  const trimmed = source.trim();
  let parsed: unknown;
  if (trimmed.startsWith('{')) parsed = parseDashboardJson(trimmed);
  else parsed = parseLooseWidgetBlock(source);
  const record = isRecord(parsed) && isRecord(parsed.widget) ? parsed.widget : parsed;
  if (!isRecord(record)) throw new Error('Widget block must contain a widget object.');
  const type = resolveDashboardWidgetType(record.type);
  if (!type) throw new Error('Widget block must specify a known dashboard widget type.');
  const rawGrid = isRecord(record.grid) ? record.grid : undefined;
  const grid = rawGrid
    && typeof rawGrid.x === 'number'
    && typeof rawGrid.y === 'number'
    && typeof rawGrid.w === 'number'
    && typeof rawGrid.h === 'number'
    ? { x: rawGrid.x, y: rawGrid.y, w: rawGrid.w, h: rawGrid.h }
    : undefined;
  const customConfig: Record<string, unknown> = isRecord(record.customConfig) ? { ...record.customConfig } : {};
  const topLevelConfigKeys = new Set(['type', 'title', 'size', 'grid', 'query', 'showCompleted', 'presentation', 'customConfig', 'collapsed', 'position']);
  for (const [key, value] of Object.entries(record)) {
    if (!topLevelConfigKeys.has(key)) customConfig[key] = value;
  }
  const size = record.size === undefined && type === 'daily-todos' ? 'large' : normalizeDashboardWidgetSize(record.size);
  return migrateDashboardWidgetConfig({
    type,
    title: typeof record.title === 'string' ? record.title : defaultWidgetTitle(type),
    size,
    ...(grid ? { grid } : {}),
    ...(typeof record.query === 'string' ? { query: record.query } : {}),
    ...(typeof record.showCompleted === 'boolean' ? { showCompleted: record.showCompleted } : {}),
    ...(normalizeDashboardWidgetPresentation(record.presentation) ? { presentation: normalizeDashboardWidgetPresentation(record.presentation) } : {}),
    ...(Object.keys(customConfig).length > 0 ? { customConfig } : {}),
  });
}

// ── Date / scope helpers ────────────────────────────────────────────────────

