import test from 'node:test';
import assert from 'node:assert/strict';
import { Platform } from 'obsidian';
import type {
  DashboardLayout,
  DashboardWidgetConfig,
} from '../src/types.js';
import { DEFAULT_SETTINGS } from '../src/types.js';
import {
  DASHBOARD_WIDGET_SIZES,
  DASHBOARD_GRID_COLUMNS,
  DASHBOARD_MIN_W,
  DASHBOARD_MIN_H,
  DASHBOARD_COLLAPSED_SPAN,
  dashboardEffectiveGridRowSpan,
  DASHBOARD_BUILTIN_TEMPLATES,
  DASHBOARD_LAYOUT_EXPORT_KIND,
  calculatePomodoroSessionTiming,
  clampGridPlacement,
  cloneDashboardLayout,
  cloneDashboardTemplateAsLayout,
  compactGridPlacements,
  redistributeEmptyCardWidths,
  redistributeRailWidthsToPrimary,
  createDashboardLayoutFromTemplate,
  createDashboardTemplateFromLayout,
  createDefaultDashboardLayout,
  createPomodoroTimeSession,
  cycleDashboardWidgetSize,
  dashboardDayDiff,
  dashboardGreeting,
  dashboardIdFromName,
  dashboardTaskDisplayText,
  stripDashboardInlineMarkdown,
  dashboardProjectName,
  dashboardWidgetAccentRole,
  formatDashboardCount,
  formatDashboardBadge,
  dashboardWeekOverWeekCount,
  formatDashboardDelta,
  dashboardQueryOptions,
  dashboardRelativeDate,
  dashboardRowLimit,
  dashboardScopeRange,
  dashboardWidgetRowLimit,
  dashboardWidgetPresentation,
  dashboardGamificationStats,
  dashboardGlanceStats,
  dashboardWeeklyThroughput,
  dashboardProductivityScore,
  dashboardCycleTimeStats,
  dashboardAgingWip,
  dashboardTimeOfDayMatrix,
  dashboardDailyGoalProgress,
  dashboardWeeklyReviewItems,
  dashboardHmToMinutes,
  dashboardFormatClock,
  dashboardTaskTimeRange,
  dashboardScheduleForDay,
  dashboardScheduleOverlaps,
  dashboardCapacitySeries,
  dashboardBurndownSeries,
  dashboardCompletionForecast,
  dashboardCumulativeFlow,
  dashboardEstimateVariance,
  dashboardGoalRows,
  dashboardAreaRows,
  dashboardSubtaskRows,
  dashboardOnThisDay,
  dashboardGoalStreakDays,
  dashboardShutdownItems,
  dashboardShortDate,
  dashboardFormatHour,
  DASHBOARD_WEEKDAY_LABELS,
  ensureGridPlacements,
  exportDashboardCollection,
  exportDashboardLayout,
  exportDashboardTemplate,
  filterDashboardActiveHabits,
  filterDashboardActiveTasks,
  filterDashboardAgendaTasks,
  dashboardAgendaRowBucket,
  dashboardAgendaBucketLabel,
  dashboardAgendaSectionModel,
  dashboardManualOrderTasks,
  dashboardDailyTodosModel,
  dashboardNextUpModel,
  dashboardTodayModel,
  dashboardReviewQueueGroups,
  dashboardReviewQueues,
  dashboardGroupTasksByNote,
  filterDashboardOverdueTasks,
  filterDashboardUpcomingTasks,
  filterDashboardRecentlyCompletedTasks,
  dashboardRowProject,
  dashboardRelationshipIndex,
  dashboardTaskRelations,
  dashboardUniqueTaskKeyMap,
  findFreeGridSlot,
  formatPomodoroSeconds,
  gridDropPushDirection,
  gridFootprintForSize,
  gridOverlapArea,
  gridPlacementsOverlap,
  isDashboardPathExcluded,
  migrateDashboardLayout,
  refreshPristineTemplateLayout,
  dropRedundantMomentumWidget,
  foldOverdueCardIntoAgenda,
  mergeNextUpAgendaIntoToday,
  consolidateDefaultRightRailIntoToday,
  compactDefaultSummaryWidget,
  DASHBOARD_OVERDUE_FOLD_REVISION,
  DASHBOARD_TODAY_MERGE_REVISION,
  DASHBOARD_TODAY_FULL_CONSOLIDATION_REVISION,
  DASHBOARD_SUMMARY_COMPACT_REVISION,
  dashboardWidgetsSignature,
  DASHBOARD_TEMPLATE_REVISION,
  migrateDashboardWidgetConfig,
  moveDashboardWidgetBefore,
  normalizeDashboardWidgetPresentation,
  normalizeDashboardWidgetSize,
  packGridDown,
  parseDashboardImportPayload,
  parseDashboardLayoutBlock,
  parseDashboardWidgetBlock,
  refreshDashboardWidgetForConfig,
  reorderDashboardWidgets,
  resizeEdgePushDirection,
  resolveDirectionalCollisions,
  resolveGridCollisions,
  responsiveColumnCount,
  shouldStackDashboard,
  DASHBOARD_STACK_MAX_WIDTH,
  DASHBOARD_TABLET_STACK_MAX_WIDTH,
  bestActionGridColumns,
  dashboardActionGridTemplate,
  dashboardRevisionShouldRefresh,
  scaleGridPlacements,
  sizeFromGridFootprint,
  sizeFromLegacyPosition,
  uniqueDashboardId,
} from '../src/dashboard.js';
import { taskIsHabit } from '../src/habit-tracker.js';
import type { ParsedTask } from '../src/task-scanner.js';

test('Dashboard index revisions ignore duplicate and stale refresh requests', () => {
  assert.equal(dashboardRevisionShouldRefresh(4, -1, 5), true);
  assert.equal(dashboardRevisionShouldRefresh(4, 5, 5), false);
  assert.equal(dashboardRevisionShouldRefresh(5, -1, 4), false);
  assert.equal(dashboardRevisionShouldRefresh(5, 6, 7), true);
});

test('Dashboard widget size model', async (t) => {
  await t.test('normalizes arbitrary values to a valid size', () => {
    assert.equal(normalizeDashboardWidgetSize('small'), 'small');
    assert.equal(normalizeDashboardWidgetSize('large'), 'large');
    assert.equal(normalizeDashboardWidgetSize('nonsense'), 'medium');
    assert.equal(normalizeDashboardWidgetSize(undefined), 'medium');
  });

  await t.test('cycles small → medium → large → small', () => {
    assert.equal(cycleDashboardWidgetSize('small'), 'medium');
    assert.equal(cycleDashboardWidgetSize('medium'), 'large');
    assert.equal(cycleDashboardWidgetSize('large'), 'small');
    assert.deepEqual(DASHBOARD_WIDGET_SIZES, ['small', 'medium', 'large']);
  });

  await t.test('normalizes presentation hints', () => {
    assert.equal(normalizeDashboardWidgetPresentation('hero'), 'hero');
    assert.equal(normalizeDashboardWidgetPresentation('kpi'), 'kpi');
    assert.equal(normalizeDashboardWidgetPresentation('standard'), 'standard');
    assert.equal(normalizeDashboardWidgetPresentation('loud'), undefined);
  });

  await t.test('scales the list row limit with size', () => {
    assert.ok(dashboardRowLimit('small') < dashboardRowLimit('medium'));
    assert.ok(dashboardRowLimit('medium') < dashboardRowLimit('large'));
  });

  await t.test('collapsed card span reserves enough rows and overrides expanded height', () => {
    assert.ok(DASHBOARD_COLLAPSED_SPAN >= 5, 'collapsed cards need enough grid rows for header min-height plus padding in compact density');
    assert.equal(dashboardEffectiveGridRowSpan(true, 24), DASHBOARD_COLLAPSED_SPAN, 'collapsed placement uses the reserved header span');
    assert.equal(dashboardEffectiveGridRowSpan(false, 24), 24, 'expanded placement keeps the widget height');
  });
});

test('Dashboard widget reordering', async (t) => {
  await t.test('reorders by index, clamping out-of-range targets', () => {
    assert.deepEqual(reorderDashboardWidgets(['a', 'b', 'c', 'd'], 0, 2), ['b', 'c', 'a', 'd']);
    assert.deepEqual(reorderDashboardWidgets(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b']);
    assert.deepEqual(reorderDashboardWidgets(['a', 'b', 'c'], 1, 99), ['a', 'c', 'b']);
    assert.deepEqual(reorderDashboardWidgets(['a', 'b', 'c'], 5, 0), ['a', 'b', 'c']);
  });

  await t.test('moves a widget immediately before a target (or to the end)', () => {
    assert.deepEqual(moveDashboardWidgetBefore(['a', 'b', 'c'], 'c', 'a'), ['c', 'a', 'b']);
    assert.deepEqual(moveDashboardWidgetBefore(['a', 'b', 'c'], 'a', 'c'), ['b', 'a', 'c']);
    assert.deepEqual(moveDashboardWidgetBefore(['a', 'b', 'c'], 'a', null), ['b', 'c', 'a']);
    assert.deepEqual(moveDashboardWidgetBefore(['a', 'b', 'c'], 'b', 'b'), ['a', 'c', 'b']);
  });
});

test('Dashboard layout migration', async (t) => {
  await t.test('derives a size bucket from a legacy absolute-grid position', () => {
    assert.equal(sizeFromLegacyPosition({ col: 0, row: 0, width: 1, height: 1 }), 'small');
    assert.equal(sizeFromLegacyPosition({ col: 0, row: 0, width: 2, height: 1 }), 'medium');
    assert.equal(sizeFromLegacyPosition({ col: 0, row: 0, width: 2, height: 2 }), 'large');
    assert.equal(sizeFromLegacyPosition({ col: 0, row: 0, width: 4, height: 2 }), 'large');
    assert.equal(sizeFromLegacyPosition(undefined), 'medium');
  });

  await t.test('migrates a legacy widget config (position → size), preserving content', () => {
    const legacy = {
      type: 'saved-query' as const,
      title: 'My Query',
      position: { col: 2, row: 1, width: 2, height: 2 },
      query: 'not done',
      presentation: 'hero' as const,
      customConfig: { limit: 10 },
    };
    const migrated = migrateDashboardWidgetConfig(legacy);
    assert.equal(migrated.size, 'large');
    assert.equal(migrated.query, 'not done');
    assert.equal(migrated.presentation, 'hero');
    assert.deepEqual(migrated.customConfig, { limit: 10 });
    assert.equal('position' in migrated, false, 'legacy position should be dropped');
  });

  await t.test('repairs a stored layout: drops unknown types and fills missing titles/sizes', () => {
    const stored = {
      id: 'default',
      name: '',
      widgets: [
        { type: 'agenda', position: { col: 0, row: 0, width: 2, height: 2 } },
        { type: 'bogus-widget', title: 'Nope' },
        { type: 'stats', size: 'small', title: 'Numbers' },
      ],
      createdAt: 123,
      updatedAt: 123,
    } as unknown as DashboardLayout;
    const migrated = migrateDashboardLayout(stored);
    assert.equal(migrated.name, 'Dashboard');
    assert.deepEqual(migrated.widgets.map((w) => w.type), ['agenda', 'stats']);
    assert.equal(migrated.widgets[0].size, 'large');
    assert.equal(migrated.widgets[0].title, 'Agenda');
    assert.equal(migrated.widgets[1].title, 'Numbers');
    assert.equal(migrated.createdAt, 123);
  });

  await t.test('fills in grid placements for widgets that lack them', () => {
    const stored = {
      id: 'default',
      name: 'Dashboard',
      widgets: [
        { type: 'agenda', size: 'large', title: 'Agenda' },
        { type: 'stats', size: 'small', title: 'Numbers' },
        { type: 'upcoming', size: 'medium', title: 'Upcoming' },
      ],
      createdAt: 1,
      updatedAt: 1,
    } as unknown as DashboardLayout;
    const migrated = migrateDashboardLayout(stored);
    for (const widget of migrated.widgets) {
      assert.ok(widget.grid, `${widget.type} has a grid placement`);
      assert.ok((widget.grid!.x ?? -1) >= 0 && widget.grid!.x + widget.grid!.w <= DASHBOARD_GRID_COLUMNS);
    }
    // No two placements may overlap.
    const placements = migrated.widgets.map((w) => w.grid!);
    for (let i = 0; i < placements.length; i += 1) {
      for (let j = i + 1; j < placements.length; j += 1) {
        assert.equal(gridPlacementsOverlap(placements[i], placements[j]), false, `widgets ${i} and ${j} overlap`);
      }
    }
  });

  await t.test('migrateDashboardLayout never returns overlapping placements', () => {
    const stored = {
      id: 'default',
      name: 'Dashboard',
      widgets: [
        { type: 'agenda', size: 'large', title: 'Agenda', grid: { x: 0, y: 0, w: 6, h: 4 } },
        { type: 'stats', size: 'small', title: 'Numbers', grid: { x: 2, y: 1, w: 4, h: 2 } }, // overlaps agenda
        { type: 'upcoming', size: 'medium', title: 'Upcoming', grid: { x: 1, y: 2, w: 5, h: 3 } }, // overlaps both
      ],
      createdAt: 1,
      updatedAt: 1,
    } as unknown as DashboardLayout;
    const migrated = migrateDashboardLayout(stored);
    const placements = migrated.widgets.map((w) => w.grid!);
    for (let i = 0; i < placements.length; i += 1) {
      for (let j = i + 1; j < placements.length; j += 1) {
        assert.equal(gridPlacementsOverlap(placements[i], placements[j]), false, `migrated widgets ${i}/${j} overlap`);
      }
    }
  });

  await t.test('aliases consolidated widget types onto their survivor', () => {
    const stored = {
      id: 'default',
      name: 'Dashboard',
      widgets: [
        { type: 'available-now', size: 'medium', title: 'Available now' },
        { type: 'recurring-forecast', size: 'medium', title: 'Recurring forecast' },
        { type: 'calendar-overload', size: 'medium' },
        { type: 'projects-without-next-action', size: 'medium' },
        { type: 'reviewers-needed', size: 'medium' },
        { type: 'habit-risk', size: 'medium' },
      ],
      createdAt: 1,
      updatedAt: 1,
    } as unknown as DashboardLayout;
    const migrated = migrateDashboardLayout(stored);
    assert.deepEqual(
      migrated.widgets.map((w) => w.type),
      ['focus-queue', 'recurrence-health', 'deadline-strip', 'project-health', 'follow-up', 'habits'],
    );
    // Aliased widgets adopt the survivor's default title (their content differs from the old card).
    assert.equal(migrated.widgets[0].title, 'Next up');
  });

  await t.test('does not duplicate a survivor the layout already contains when aliasing', () => {
    const stored = {
      id: 'default',
      name: 'Dashboard',
      widgets: [
        { type: 'focus-queue', size: 'medium', title: 'Focus queue' },
        { type: 'available-now', size: 'medium', title: 'Available now' }, // alias -> focus-queue (already present)
      ],
      createdAt: 1,
      updatedAt: 1,
    } as unknown as DashboardLayout;
    const migrated = migrateDashboardLayout(stored);
    assert.deepEqual(migrated.widgets.map((w) => w.type), ['focus-queue']);
  });

  await t.test('preserves an explicit, valid grid placement', () => {
    const migrated = migrateDashboardWidgetConfig({ type: 'stats', title: 'S', size: 'small', grid: { x: 4, y: 2, w: 3, h: 2 } } as DashboardWidgetConfig);
    assert.deepEqual(migrated.grid, { x: 4, y: 2, w: 3, h: 2 });
  });
});

test('Dashboard snap grid', async (t) => {
  await t.test('maps size buckets to footprints and back', () => {
    assert.deepEqual(gridFootprintForSize('small'), { w: 24, h: 16 });
    assert.deepEqual(gridFootprintForSize('medium'), { w: 32, h: 24 });
    assert.deepEqual(gridFootprintForSize('large'), { w: 48, h: 32 });
    assert.equal(sizeFromGridFootprint(24, 16), 'small');
    assert.equal(sizeFromGridFootprint(32, 24), 'medium');
    assert.equal(sizeFromGridFootprint(48, 32), 'large');
  });

  await t.test('clamps placements into the column range with valid minimums', () => {
    assert.deepEqual(clampGridPlacement({ x: -3, y: -2, w: 1, h: 1 }), { x: 0, y: 0, w: DASHBOARD_MIN_W, h: DASHBOARD_MIN_H });
    // A widget wider than the grid is clamped to the column count and pinned to x=0.
    assert.deepEqual(clampGridPlacement({ x: 5, y: 1, w: 99, h: 3 }), { x: 0, y: 1, w: DASHBOARD_GRID_COLUMNS, h: 3 });
    // x is pulled in so the widget stays inside the right edge.
    assert.deepEqual(clampGridPlacement({ x: 94, y: 0, w: 4, h: 2 }), { x: DASHBOARD_GRID_COLUMNS - 4, y: 0, w: 4, h: 2 });
  });

  await t.test('detects overlap only when cells are shared', () => {
    assert.equal(gridPlacementsOverlap({ x: 0, y: 0, w: 3, h: 2 }, { x: 3, y: 0, w: 3, h: 2 }), false, 'adjacent horizontally');
    assert.equal(gridPlacementsOverlap({ x: 0, y: 0, w: 3, h: 2 }, { x: 0, y: 2, w: 3, h: 2 }), false, 'adjacent vertically');
    assert.equal(gridPlacementsOverlap({ x: 0, y: 0, w: 3, h: 2 }, { x: 2, y: 1, w: 3, h: 2 }), true, 'overlapping corner');
  });

  await t.test('finds the first free slot top-to-bottom, left-to-right', () => {
    const occupied = [{ x: 0, y: 0, w: 6, h: 2 }];
    assert.deepEqual(findFreeGridSlot(occupied, 3, 2), { x: 6, y: 0 }, 'fills the rest of row 0');
    const full = [{ x: 0, y: 0, w: DASHBOARD_GRID_COLUMNS, h: 2 }];
    assert.deepEqual(findFreeGridSlot(full, 4, 2), { x: 0, y: 2 }, 'wraps to the next row');
  });

  await t.test('ensureGridPlacements packs widgets without overlap', () => {
    const widgets = [
      { type: 'agenda', size: 'large', title: 'A' },
      { type: 'stats', size: 'small', title: 'B' },
      { type: 'upcoming', size: 'medium', title: 'C' },
      { type: 'habits', size: 'medium', title: 'D' },
    ] as DashboardWidgetConfig[];
    ensureGridPlacements(widgets);
    const placements = widgets.map((w) => w.grid!);
    assert.ok(placements.every((p) => p && p.x + p.w <= DASHBOARD_GRID_COLUMNS));
    for (let i = 0; i < placements.length; i += 1) {
      for (let j = i + 1; j < placements.length; j += 1) {
        assert.equal(gridPlacementsOverlap(placements[i], placements[j]), false);
      }
    }
  });

  await t.test('ensureGridPlacements relocates valid-but-overlapping placements', () => {
    // Two widgets carry valid grids that overlap (e.g. from a hand-edited or pre-fix data.json).
    const widgets = [
      { type: 'agenda', size: 'large', title: 'A', grid: { x: 0, y: 0, w: 6, h: 4 } },
      { type: 'stats', size: 'small', title: 'B', grid: { x: 2, y: 1, w: 4, h: 2 } }, // overlaps A
      { type: 'upcoming', size: 'medium', title: 'C', grid: { x: 0, y: 5, w: 4, h: 3 } }, // clear, kept as-is
    ] as DashboardWidgetConfig[];
    ensureGridPlacements(widgets);
    const placements = widgets.map((w) => w.grid!);
    // The first, non-colliding placements are preserved exactly.
    assert.deepEqual(placements[0], { x: 0, y: 0, w: 6, h: 4 }, 'anchor placement preserved');
    assert.deepEqual(placements[2], { x: 0, y: 5, w: 4, h: 3 }, 'non-overlapping placement preserved');
    // The overlapping widget keeps its footprint but is relocated off the collision.
    assert.equal(placements[1].w, 4, 'relocated widget keeps width');
    assert.equal(placements[1].h, 2, 'relocated widget keeps height');
    for (let i = 0; i < placements.length; i += 1) {
      for (let j = i + 1; j < placements.length; j += 1) {
        assert.equal(gridPlacementsOverlap(placements[i], placements[j]), false, `widgets ${i}/${j} overlap`);
      }
    }
  });

  await t.test('resolveGridCollisions keeps the anchor put and pushes overlaps down', () => {
    // index 0 is the anchor (just moved); index 1 overlaps it and must move below.
    const placements = [
      { x: 0, y: 0, w: 6, h: 2 }, // anchor
      { x: 0, y: 0, w: 6, h: 2 }, // collides with anchor
      { x: 6, y: 0, w: 3, h: 2 }, // clear, must stay put (free placement keeps gaps)
    ];
    resolveGridCollisions(placements, 0);
    assert.deepEqual(placements[0], { x: 0, y: 0, w: 6, h: 2 }, 'anchor unchanged');
    assert.equal(placements[1].y >= 2, true, 'collider pushed below the anchor');
    assert.equal(gridPlacementsOverlap(placements[0], placements[1]), false);
    assert.deepEqual(placements[2], { x: 6, y: 0, w: 3, h: 2 }, 'non-colliding widget keeps its spot');
  });

  await t.test('compactGridPlacements fills vertical gaps while preserving rough columns', () => {
    const base = [
      { x: 0, y: 0, w: 4, h: 2 },
      { x: 4, y: 5, w: 4, h: 2 },
      { x: 8, y: 5, w: 4, h: 2 },
      { x: 0, y: 8, w: 6, h: 3 },
    ];
    const compacted = compactGridPlacements(base, 12);
    assert.deepEqual(compacted[0], { x: 0, y: 0, w: 4, h: 2 }, 'top widget stays anchored');
    assert.deepEqual(compacted[1], { x: 4, y: 0, w: 4, h: 2 }, 'middle-column widget moves up into row 0');
    assert.deepEqual(compacted[2], { x: 8, y: 0, w: 4, h: 2 }, 'right-column widget keeps its rough column');
    assert.deepEqual(compacted[3], { x: 0, y: 2, w: 6, h: 3 }, 'later widget fills the next available row');
    for (let i = 0; i < compacted.length; i += 1) {
      for (let j = i + 1; j < compacted.length; j += 1) {
        assert.equal(gridPlacementsOverlap(compacted[i], compacted[j]), false, `widgets ${i}/${j} should not overlap`);
      }
    }
  });

  await t.test('compactGridPlacements keeps reading order ahead of lower widgets', () => {
    const base = [
      { x: 6, y: 10, w: 6, h: 2 },
      { x: 0, y: 8, w: 6, h: 2 },
      { x: 6, y: 8, w: 6, h: 2 },
    ];
    const compacted = compactGridPlacements(base, 12);
    assert.deepEqual(compacted[1], { x: 0, y: 0, w: 6, h: 2 });
    assert.deepEqual(compacted[2], { x: 6, y: 0, w: 6, h: 2 });
    assert.deepEqual(compacted[0], { x: 6, y: 2, w: 6, h: 2 });
  });

  await t.test('row limit scales with grid height (fit-aware, reserves a +more slot), falling back to size bucket', () => {
    // h=16 -> authored 2 rows: ~3 fit, reserve one for "+more" => 2
    assert.equal(dashboardWidgetRowLimit({ type: 'agenda', size: 'small', title: 'A', grid: { x: 0, y: 0, w: 16, h: 16 } } as DashboardWidgetConfig), 2);
    // h=32 -> authored 4 rows: ~8 fit, reserve one => 7
    assert.equal(dashboardWidgetRowLimit({ type: 'agenda', size: 'small', title: 'A', grid: { x: 0, y: 0, w: 24, h: 32 } } as DashboardWidgetConfig), 7);
    assert.equal(dashboardWidgetRowLimit({ type: 'agenda', size: 'large', title: 'A' } as DashboardWidgetConfig), dashboardRowLimit('large'));
  });

  await t.test('focus queue row limit scales tall cards but keeps auto-fit fallback size-aware', () => {
    assert.equal(dashboardWidgetRowLimit({ type: 'focus-queue', size: 'large', title: 'Next up', grid: { x: 0, y: 0, w: 48, h: 40 } } as DashboardWidgetConfig), 13);
    assert.equal(dashboardWidgetRowLimit({ type: 'focus-queue', size: 'large', title: 'Next up', grid: { x: 0, y: 0, w: 48, h: 96 } } as DashboardWidgetConfig), 24, 'tall focus queue caps at 24 rows');
    assert.equal(dashboardWidgetRowLimit({ type: 'focus-queue', size: 'small', title: 'Next up', grid: { x: 0, y: 0, w: 16, h: 16 } } as DashboardWidgetConfig), 4, 'short focus queue keeps a useful minimum');
    assert.equal(dashboardWidgetRowLimit({ type: 'focus-queue', size: 'large', title: 'Next up' } as DashboardWidgetConfig, true), 16, 'large auto-fit focus queue gets the enhanced cap');
    assert.equal(dashboardWidgetRowLimit({ type: 'focus-queue', size: 'small', title: 'Next up' } as DashboardWidgetConfig, true), dashboardRowLimit('small'), 'small auto-fit focus queue uses the size fallback');
  });

  await t.test('scope-aware Agenda row limit supports section previews within available space', () => {
    assert.equal(dashboardWidgetRowLimit({ type: 'today', size: 'large', title: 'Agenda' } as DashboardWidgetConfig, true), 28, 'large auto-fit Agenda has enough budget for capped sections');
    assert.equal(dashboardWidgetRowLimit({ type: 'today', size: 'medium', title: 'Agenda' } as DashboardWidgetConfig, true), 18, 'medium auto-fit Agenda still has room for multiple sections');
    assert.equal(dashboardWidgetRowLimit({ type: 'today', size: 'large', title: 'Agenda', grid: { x: 0, y: 0, w: 72, h: 160 } } as DashboardWidgetConfig), 48, 'manually tall Agenda has a larger section budget');
  });
});

test('redistributeEmptyCardWidths', async (t) => {
  const opts = { minEmptyW: 2, step: 1, cols: 12 };

  await t.test('narrows an empty card and widens the rich neighbour on its right', () => {
    const placements = [
      { x: 3, y: 2, w: 3, h: 1 }, // empty agenda (short)
      { x: 6, y: 2, w: 3, h: 4 }, // rich next-actions (tall, to the right)
      { x: 3, y: 6, w: 6, h: 3 }, // focus-queue spanning below both
    ];
    const changed = redistributeEmptyCardWidths(placements, [true, false, false], opts);
    assert.equal(changed, true);
    assert.deepEqual(placements[0], { x: 3, y: 2, w: 2, h: 1 }, 'empty card shrinks');
    assert.deepEqual(placements[1], { x: 5, y: 2, w: 4, h: 4 }, 'neighbour grows left into the freed strip');
    assert.deepEqual(placements[2], { x: 3, y: 6, w: 6, h: 3 }, 'untouched card stays put');
    for (let i = 0; i < placements.length; i += 1) {
      for (let j = i + 1; j < placements.length; j += 1) {
        assert.equal(gridPlacementsOverlap(placements[i], placements[j]), false, `widgets ${i}/${j} must not overlap`);
      }
    }
  });

  await t.test('widens a rich neighbour sitting to the left of the empty card', () => {
    const placements = [
      { x: 0, y: 0, w: 3, h: 4 }, // rich neighbour (left)
      { x: 3, y: 0, w: 3, h: 1 }, // empty card (right)
    ];
    const changed = redistributeEmptyCardWidths(placements, [false, true], opts);
    assert.equal(changed, true);
    assert.deepEqual(placements[0], { x: 0, y: 0, w: 4, h: 4 }, 'left neighbour grows rightward');
    assert.deepEqual(placements[1], { x: 4, y: 0, w: 2, h: 1 }, 'empty card slides right and shrinks');
  });

  await t.test('skips a transfer that would collide with a third card', () => {
    const placements = [
      { x: 9, y: 2, w: 3, h: 1 }, // empty recently-done
      { x: 6, y: 2, w: 3, h: 4 }, // rich next-actions to its left
      { x: 9, y: 3, w: 3, h: 3 }, // triage directly below the empty card
    ];
    const snapshot = placements.map((p) => ({ ...p }));
    const changed = redistributeEmptyCardWidths(placements, [true, false, false], opts);
    assert.equal(changed, false, 'no transfer when the neighbour would overlap triage');
    assert.deepEqual(placements, snapshot, 'placements are left untouched');
  });

  await t.test('prefers a viable taller neighbour when a blocked one shares the other edge', () => {
    // Real-board shape: an empty Agenda has Today-at-a-glance on its left (boxed in by the Overdue
    // banner above) and the tall Next actions on its right. The transfer must go to Next actions.
    const placements = [
      { x: 0, y: 7, w: 24, h: 21 }, // stats / today-at-a-glance (left neighbour, shorter)
      { x: 24, y: 0, w: 48, h: 11 }, // overdue banner spanning above agenda + next-actions
      { x: 24, y: 11, w: 24, h: 15 }, // empty agenda (between stats and next-actions)
      { x: 48, y: 11, w: 24, h: 45 }, // next actions (right neighbour, tall)
    ];
    const empties = [false, true, true, false]; // overdue + agenda render empty states
    const changed = redistributeEmptyCardWidths(placements, empties, { minEmptyW: 16, step: 8, cols: 96 });
    assert.equal(changed, true);
    assert.deepEqual(placements[2], { x: 24, y: 11, w: 16, h: 15 }, 'agenda narrows from the right');
    assert.deepEqual(placements[3], { x: 40, y: 11, w: 32, h: 45 }, 'next actions grows left into the freed strip');
    assert.deepEqual(placements[0], { x: 0, y: 7, w: 24, h: 21 }, 'blocked left neighbour is untouched');
    for (let i = 0; i < placements.length; i += 1) {
      for (let j = i + 1; j < placements.length; j += 1) {
        assert.equal(gridPlacementsOverlap(placements[i], placements[j]), false, `widgets ${i}/${j} must not overlap`);
      }
    }
  });

  await t.test('ignores a tall neighbour from another rail that is not top-aligned', () => {
    // A full-width empty middle card abuts Today-at-a-glance in the left rail, but they do not share
    // a row top, so the empty card must NOT cede width across the rail boundary.
    const placements = [
      { x: 0, y: 7, w: 24, h: 21 }, // left-rail stats (shares the empty card's left edge, different y)
      { x: 24, y: 11, w: 48, h: 8 }, // full-width empty Agenda banner
      { x: 24, y: 19, w: 48, h: 40 }, // full-width Next actions stacked below it
    ];
    const snapshot = placements.map((p) => ({ ...p }));
    const changed = redistributeEmptyCardWidths(placements, [false, true, false], { minEmptyW: 16, step: 8, cols: 96 });
    assert.equal(changed, false, 'no cross-rail transfer for a non-top-aligned neighbour');
    assert.deepEqual(placements, snapshot, 'placements untouched');
  });

  await t.test('does nothing when the empty card has no qualifying neighbour', () => {
    const placements = [
      { x: 0, y: 0, w: 4, h: 2 }, // empty, but its only neighbour is shorter
      { x: 4, y: 0, w: 4, h: 1 },
    ];
    const snapshot = placements.map((p) => ({ ...p }));
    assert.equal(redistributeEmptyCardWidths(placements, [true, false], opts), false);
    assert.deepEqual(placements, snapshot);
  });

  await t.test('never shrinks an empty card below the minimum width', () => {
    const placements = [
      { x: 0, y: 0, w: 2, h: 1 }, // already at minEmptyW
      { x: 2, y: 0, w: 4, h: 3 },
    ];
    assert.equal(redistributeEmptyCardWidths(placements, [true, false], opts), false);
    assert.deepEqual(placements[0], { x: 0, y: 0, w: 2, h: 1 });
  });

  await t.test('aligns transfers to the coarse step on the fine runtime grid', () => {
    // Agenda (w24) beside Next actions (w24): a 1-coarse-column (8 fine) transfer.
    const placements = [
      { x: 24, y: 16, w: 24, h: 8 }, // empty agenda
      { x: 48, y: 16, w: 24, h: 40 }, // rich next-actions
    ];
    const changed = redistributeEmptyCardWidths(placements, [true, false], { minEmptyW: 16, step: 8, cols: 96 });
    assert.equal(changed, true);
    assert.deepEqual(placements[0], { x: 24, y: 16, w: 16, h: 8 }, 'agenda w24 -> w16 (3 -> 2 coarse cols)');
    assert.deepEqual(placements[1], { x: 40, y: 16, w: 32, h: 40 }, 'next-actions w24 -> w32 (3 -> 4 coarse cols)');
  });
});

test('redistributeRailWidthsToPrimary', async (t) => {
  // A clean three-column command-center band: left rail [0,24), middle [24,72), right rail [72,96).
  const band = () => [
    { x: 0, y: 0, w: 24, h: 8 }, // left rail (4 stacked cards share x/w)
    { x: 0, y: 8, w: 24, h: 20 },
    { x: 0, y: 28, w: 24, h: 16 },
    { x: 24, y: 0, w: 48, h: 11 }, // middle (primary) column
    { x: 24, y: 11, w: 48, h: 60 },
    { x: 72, y: 0, w: 24, h: 14 }, // right rail
    { x: 72, y: 14, w: 24, h: 30 },
  ];

  await t.test('caps both side rails and gives the freed width to the widest column', () => {
    const placements = band();
    const changed = redistributeRailWidthsToPrimary(placements, { maxSideW: 16, minSideW: 8, cols: 96 });
    assert.equal(changed, true);
    // Rails 24 -> 16, middle 48 -> 48 + 8 + 8 = 64, band stays contiguous and full-width.
    for (const i of [0, 1, 2]) assert.deepEqual({ x: placements[i].x, w: placements[i].w }, { x: 0, w: 16 }, 'left rail capped at 16');
    for (const i of [3, 4]) assert.deepEqual({ x: placements[i].x, w: placements[i].w }, { x: 16, w: 64 }, 'middle absorbs the slack');
    for (const i of [5, 6]) assert.deepEqual({ x: placements[i].x, w: placements[i].w }, { x: 80, w: 16 }, 'right rail capped and right-shifted');
    assert.equal(placements[6].x + placements[6].w, 96, 'still tiles the full width');
  });

  await t.test('preserves every card height and y (only x and w move)', () => {
    const before = band();
    const placements = band();
    redistributeRailWidthsToPrimary(placements, { maxSideW: 16, minSideW: 8, cols: 96 });
    placements.forEach((p, i) => {
      assert.equal(p.y, before[i].y, `card ${i} y unchanged`);
      assert.equal(p.h, before[i].h, `card ${i} h unchanged`);
    });
  });

  await t.test('is a no-op when the rails already fit under the ceiling', () => {
    const placements = band();
    const snapshot = placements.map((p) => ({ ...p }));
    const changed = redistributeRailWidthsToPrimary(placements, { maxSideW: 24, minSideW: 8, cols: 96 });
    assert.equal(changed, false, 'rails (w24) already within the 24-col cap');
    assert.deepEqual(placements, snapshot);
  });

  await t.test('never shrinks a rail below the minimum width', () => {
    const placements = band();
    redistributeRailWidthsToPrimary(placements, { maxSideW: 4, minSideW: 12, cols: 96 });
    for (const i of [0, 5]) assert.equal(placements[i].w, 12, 'rail clamped at the floor, not the ceiling');
    assert.equal(placements[3].w, 48 + 12 + 12, 'middle still absorbs only the actually-freed width');
  });

  await t.test('bails out when two columns tie for widest (ambiguous primary)', () => {
    const placements = [
      { x: 0, y: 0, w: 48, h: 10 },
      { x: 48, y: 0, w: 48, h: 10 },
    ];
    const snapshot = placements.map((p) => ({ ...p }));
    const changed = redistributeRailWidthsToPrimary(placements, { maxSideW: 16, minSideW: 8, cols: 96 });
    assert.equal(changed, false, 'no single widest column');
    assert.deepEqual(placements, snapshot);
  });

  await t.test('bails out when columns do not tile the full width (gap or overlap)', () => {
    const gapped = [
      { x: 0, y: 0, w: 24, h: 10 },
      { x: 30, y: 0, w: 48, h: 10 }, // leaves a [24,30) gap
      { x: 78, y: 0, w: 18, h: 10 },
    ];
    const snapshot = gapped.map((p) => ({ ...p }));
    assert.equal(redistributeRailWidthsToPrimary(gapped, { maxSideW: 16, minSideW: 8, cols: 96 }), false);
    assert.deepEqual(gapped, snapshot, 'gapped layout untouched');
  });

  await t.test('bails out on a ragged column (cards sharing an x with different widths)', () => {
    const ragged = [
      { x: 0, y: 0, w: 24, h: 10 }, // full-width-ish header over two narrower cards below
      { x: 0, y: 10, w: 12, h: 10 },
      { x: 12, y: 10, w: 12, h: 10 },
      { x: 24, y: 0, w: 72, h: 10 },
    ];
    const snapshot = ragged.map((p) => ({ ...p }));
    assert.equal(redistributeRailWidthsToPrimary(ragged, { maxSideW: 16, minSideW: 8, cols: 96 }), false);
    assert.deepEqual(ragged, snapshot, 'non-columnar layout untouched');
  });

  await t.test('widens a too-narrow rail up to the floor, shrinking the primary', () => {
    // Left rail [0,16) is below a 28-col comfort floor; the wide primary [16,96) cedes the slack.
    const placements = [
      { x: 0, y: 0, w: 16, h: 10 },
      { x: 0, y: 10, w: 16, h: 20 },
      { x: 16, y: 0, w: 80, h: 40 },
    ];
    const changed = redistributeRailWidthsToPrimary(placements, { maxSideW: 46, minSideW: 16, floorSideW: 28, cols: 96 });
    assert.equal(changed, true);
    for (const i of [0, 1]) assert.deepEqual({ x: placements[i].x, w: placements[i].w }, { x: 0, w: 28 }, 'rail widened to the floor');
    assert.deepEqual({ x: placements[2].x, w: placements[2].w }, { x: 28, w: 68 }, 'primary shrinks by the widened amount and stays contiguous');
    assert.equal(placements[2].x + placements[2].w, 96, 'still tiles the full width');
  });

  await t.test('floor never widens a rail past the ceiling', () => {
    const placements = [
      { x: 0, y: 0, w: 12, h: 10 },
      { x: 12, y: 0, w: 84, h: 20 },
    ];
    // floor (40) exceeds ceiling (24): the rail lands on the ceiling, not the floor.
    redistributeRailWidthsToPrimary(placements, { maxSideW: 24, minSideW: 8, floorSideW: 40, cols: 96 });
    assert.equal(placements[0].w, 24, 'rail capped at the ceiling even with a higher floor');
    assert.equal(placements[1].w, 72, 'primary shrinks only by the actual widening');
  });

  await t.test('abandons the widen when it would stop the primary being widest', () => {
    // Two rails want to grow to 40 each (80 total) but the primary is only 60 wide -> would invert.
    const placements = [
      { x: 0, y: 0, w: 18, h: 10 },
      { x: 18, y: 0, w: 60, h: 10 },
      { x: 78, y: 0, w: 18, h: 10 },
    ];
    const snapshot = placements.map((p) => ({ ...p }));
    // maxSideW 60 keeps shrink-only a no-op (rails already < 60), so the whole pass is a no-op.
    const changed = redistributeRailWidthsToPrimary(placements, { maxSideW: 60, minSideW: 8, floorSideW: 40, cols: 96 });
    assert.equal(changed, false, 'widen abandoned, shrink-only finds nothing to do');
    assert.deepEqual(placements, snapshot, 'layout untouched rather than inverted');
  });

  await t.test('with no floor, behaviour is unchanged (shrink-only)', () => {
    const placements = [
      { x: 0, y: 0, w: 12, h: 10 }, // narrow rail, but no floor supplied
      { x: 12, y: 0, w: 84, h: 20 },
    ];
    const snapshot = placements.map((p) => ({ ...p }));
    assert.equal(redistributeRailWidthsToPrimary(placements, { maxSideW: 46, minSideW: 8, cols: 96 }), false);
    assert.deepEqual(placements, snapshot, 'a narrow rail is left alone without a floor');
  });
});

test('Dashboard directional drop', async (t) => {
  await t.test('measures overlap area between placements', () => {
    assert.equal(gridOverlapArea({ x: 0, y: 0, w: 4, h: 2 }, { x: 2, y: 1, w: 4, h: 2 }), 2, '2x1 overlap');
    assert.equal(gridOverlapArea({ x: 0, y: 0, w: 3, h: 2 }, { x: 3, y: 0, w: 3, h: 2 }), 0, 'adjacent, no overlap');
  });

  await t.test('picks a push direction from where the moved card sits over its target', () => {
    // moved (index 0) covers the top of the target -> target should slide down
    assert.equal(gridDropPushDirection([{ x: 0, y: 0, w: 4, h: 2 }, { x: 0, y: 1, w: 4, h: 2 }], 0), 'down');
    // moved covers the bottom of the target -> slide up
    assert.equal(gridDropPushDirection([{ x: 0, y: 2, w: 4, h: 2 }, { x: 0, y: 1, w: 4, h: 2 }], 0), 'up');
    // moved covers the left of the target -> slide right
    assert.equal(gridDropPushDirection([{ x: 0, y: 0, w: 4, h: 3 }, { x: 2, y: 0, w: 4, h: 3 }], 0), 'right');
    // moved covers the right of the target -> slide left
    assert.equal(gridDropPushDirection([{ x: 4, y: 0, w: 4, h: 3 }, { x: 2, y: 0, w: 4, h: 3 }], 0), 'left');
    // no overlap -> default down
    assert.equal(gridDropPushDirection([{ x: 0, y: 0, w: 3, h: 2 }, { x: 6, y: 0, w: 3, h: 2 }], 0), 'down');
  });

  await t.test('shifts the overlapped card down when dropped on its top, leaving no overlap', () => {
    const base = [
      { x: 0, y: 0, w: 6, h: 2 }, // anchor (just dropped over the top of B)
      { x: 0, y: 0, w: 6, h: 2 }, // B - originally same spot
      { x: 6, y: 0, w: 6, h: 2 }, // C - clear, must stay put
    ];
    const resolved = resolveDirectionalCollisions(base, 0, 'down');
    assert.deepEqual(resolved[0], { x: 0, y: 0, w: 6, h: 2 }, 'anchor unchanged');
    assert.equal(resolved[1].y >= 2, true, 'B pushed below the anchor');
    assert.equal(gridPlacementsOverlap(resolved[0], resolved[1]), false);
    assert.deepEqual(resolved[2], { x: 6, y: 0, w: 6, h: 2 }, 'C untouched');
  });

  await t.test('shifts the overlapped card right when dropped on its left', () => {
    const base = [
      { x: 0, y: 0, w: 4, h: 3 }, // anchor
      { x: 0, y: 0, w: 4, h: 3 }, // B overlaps anchor
    ];
    const resolved = resolveDirectionalCollisions(base, 0, 'right');
    assert.equal(resolved[1].x >= 4, true, 'B pushed to the right');
    assert.equal(gridPlacementsOverlap(resolved[0], resolved[1]), false);
  });

  await t.test('falls back to a downward push when the requested direction hits a grid edge', () => {
    // Pushing B up is impossible (anchor sits at the top), so it must resolve downward instead.
    const base = [
      { x: 0, y: 0, w: 6, h: 2 }, // anchor pinned at the very top
      { x: 0, y: 0, w: 6, h: 2 }, // B overlaps it
    ];
    const resolved = resolveDirectionalCollisions(base, 0, 'up');
    assert.equal(gridPlacementsOverlap(resolved[0], resolved[1]), false, 'no overlap after fallback');
    assert.equal(resolved[1].y >= 2, true, 'B ended up below, not off the top edge');
    assert.equal(resolved[1].y >= 0, true);
  });

  await t.test('never leaves two cards overlapping for any direction', () => {
    const base = [
      { x: 2, y: 1, w: 6, h: 3 },
      { x: 0, y: 0, w: 6, h: 2 },
      { x: 4, y: 2, w: 5, h: 2 },
      { x: 1, y: 3, w: 4, h: 2 },
    ];
    for (const dir of ['up', 'down', 'left', 'right'] as const) {
      const resolved = resolveDirectionalCollisions(base, 0, dir);
      for (let i = 0; i < resolved.length; i += 1) {
        for (let j = i + 1; j < resolved.length; j += 1) {
          assert.equal(gridPlacementsOverlap(resolved[i], resolved[j]), false, `dir=${dir} pair ${i}/${j}`);
        }
        assert.equal(resolved[i].x >= 0 && resolved[i].x + resolved[i].w <= DASHBOARD_GRID_COLUMNS, true, `dir=${dir} card ${i} stays in columns`);
        assert.equal(resolved[i].y >= 0, true, `dir=${dir} card ${i} stays on the grid`);
      }
      assert.deepEqual(resolved[0], base[0], `dir=${dir} anchor stays put`);
    }
  });
});

test('Dashboard resize push direction', async (t) => {
  await t.test('maps edges/corners to a slide direction', () => {
    assert.equal(resizeEdgePushDirection('s'), 'down');
    assert.equal(resizeEdgePushDirection('n'), 'up');
    assert.equal(resizeEdgePushDirection('e'), 'right');
    assert.equal(resizeEdgePushDirection('w'), 'left');
    assert.equal(resizeEdgePushDirection('se'), 'down', 'corners prefer the vertical axis');
    assert.equal(resizeEdgePushDirection('ne'), 'up');
    assert.equal(resizeEdgePushDirection('nw'), 'up');
  });
});

test('Dashboard responsive columns', async (t) => {
  await t.test('drops to fewer columns (divisors of the full grid) as width shrinks', () => {
    assert.equal(responsiveColumnCount(1000), 96);
    assert.equal(responsiveColumnCount(900), 48);
    assert.equal(responsiveColumnCount(700), 48);
    assert.equal(responsiveColumnCount(600), 48);
    assert.equal(responsiveColumnCount(400), 32);
    assert.equal(responsiveColumnCount(300), 24);
    assert.equal(responsiveColumnCount(200), 16);
    assert.equal(responsiveColumnCount(120), 8);
    assert.equal(responsiveColumnCount(0), 96, 'non-positive width falls back to full grid');
  });

  await t.test('shouldStackDashboard collapses to a single column on narrow panes', () => {
    assert.equal(shouldStackDashboard(390), true, 'phone-width pane stacks');
    assert.equal(shouldStackDashboard(DASHBOARD_STACK_MAX_WIDTH), true, 'threshold width stacks');
    assert.equal(shouldStackDashboard(DASHBOARD_STACK_MAX_WIDTH + 1), false, 'just above threshold keeps the grid');
    assert.equal(shouldStackDashboard(900), false, 'wide desktop pane keeps the grid');
    assert.equal(shouldStackDashboard(0), false, 'unmeasured (0) width does not force a stack');
  });

  await t.test('shouldStackDashboard stacks tablet portrait and split panes', () => {
    const originalPhone = Platform.isPhone;
    const originalTablet = Platform.isTablet;
    try {
      Platform.isPhone = false;
      Platform.isTablet = true;
      assert.equal(shouldStackDashboard(768), true, 'tablet portrait stacks instead of forcing three rails');
      assert.equal(shouldStackDashboard(DASHBOARD_TABLET_STACK_MAX_WIDTH), true, 'tablet stack threshold stacks');
      assert.equal(shouldStackDashboard(DASHBOARD_TABLET_STACK_MAX_WIDTH + 1), false, 'wide tablet landscape keeps the grid');
    } finally {
      Platform.isPhone = originalPhone;
      Platform.isTablet = originalTablet;
    }
  });

  await t.test('bestActionGridColumns reflows buttons to fit the available box', () => {
    const n = 6;
    const gap = 8;
    // Short + wide box -> single tall-ish row (many columns).
    assert.equal(bestActionGridColumns(n, 720, 64, gap), 6);
    // Tall + narrow box -> a single column.
    assert.equal(bestActionGridColumns(n, 150, 560, gap), 1);
    // Roughly square box -> a balanced grid (2 or 3 columns).
    const square = bestActionGridColumns(n, 300, 300, gap);
    assert.ok(square === 2 || square === 3, `square box should balance, got ${square}`);
    // A clearly wide-but-not-extreme box favors more columns than a portrait one.
    assert.ok(
      bestActionGridColumns(n, 480, 160, gap) >= bestActionGridColumns(n, 160, 480, gap),
      'wider boxes use at least as many columns as taller boxes',
    );
    // Never exceeds the item count and is always at least 1.
    assert.equal(bestActionGridColumns(n, 5000, 40, gap) <= n, true);
    assert.equal(bestActionGridColumns(1, 400, 400, gap), 1);
    // No measurable box yet -> roughly square fallback.
    assert.equal(bestActionGridColumns(n, 0, 0, gap), 2);
  });

  await t.test('dashboardActionGridTemplate keeps icon-only actions compact on wide rows', () => {
    const actions = [{ label: 'Plan' }, { label: 'Rescan' }, {}];
    assert.equal(
      dashboardActionGridTemplate(actions, 3, 'row'),
      'minmax(0, 1fr) minmax(0, 1fr) minmax(2.25rem, max-content)',
    );
    assert.equal(dashboardActionGridTemplate(actions, 2, 'row'), 'repeat(2, minmax(0, 1fr))');
    assert.equal(dashboardActionGridTemplate(actions, 3, 'icononly'), 'repeat(3, minmax(0, 1fr))');
  });

  await t.test('packGridDown removes overlaps while keeping the top-left card anchored', () => {
    const placements = [
      { x: 0, y: 0, w: 2, h: 2 },
      { x: 1, y: 0, w: 2, h: 2 }, // overlaps the first
      { x: 0, y: 1, w: 2, h: 2 }, // overlaps both
    ];
    packGridDown(placements);
    assert.deepEqual(placements[0], { x: 0, y: 0, w: 2, h: 2 }, 'anchor unchanged');
    for (let i = 0; i < placements.length; i += 1) {
      for (let j = i + 1; j < placements.length; j += 1) {
        assert.equal(gridPlacementsOverlap(placements[i], placements[j]), false, `pair ${i}/${j}`);
      }
    }
  });

  await t.test('scaleGridPlacements projects a 12-col layout into fewer columns without overlap', () => {
    const base = [
      { x: 0, y: 0, w: 6, h: 2 },
      { x: 6, y: 0, w: 6, h: 2 },
      { x: 0, y: 2, w: 4, h: 2 },
    ];
    const scaled = scaleGridPlacements(base, 12, 4);
    for (const p of scaled) {
      assert.equal(p.w >= 1 && p.x >= 0 && p.x + p.w <= 4, true, `placement ${JSON.stringify(p)} fits in 4 columns`);
    }
    for (let i = 0; i < scaled.length; i += 1) {
      for (let j = i + 1; j < scaled.length; j += 1) {
        assert.equal(gridPlacementsOverlap(scaled[i], scaled[j]), false, `scaled pair ${i}/${j}`);
      }
    }
  });

  await t.test('scaleGridPlacements is a no-op (cloned) when target >= source columns', () => {
    const base = [{ x: 0, y: 0, w: 6, h: 2 }];
    const same = scaleGridPlacements(base, 12, 12);
    assert.deepEqual(same, base);
    assert.notEqual(same, base, 'returns a fresh array');
    assert.notEqual(same[0], base[0], 'returns fresh placement objects');
  });
});

test('Default dashboard layout', async (t) => {
  await t.test('seeds a curated, ordered, size-based layout', () => {
    const layout = createDefaultDashboardLayout(1000);
    assert.equal(layout.id, 'default');
    assert.equal(layout.createdAt, 1000);
    assert.equal(layout.updatedAt, 1000);
    assert.equal(layout.name, 'Command center');
    assert.deepEqual(layout.widgets.map((w) => w.type), ['quick-capture', 'stats', 'today']);
    assert.deepEqual(layout.widgets.map((w) => w.size), ['small', 'large', 'large']);
    assert.equal(layout.widgets[0].title, 'Quick actions');
    assert.equal(layout.widgets[2].title, 'Agenda');
    assert.deepEqual(layout.widgets[0].grid, { x: 0, y: 0, w: 32, h: 16 }, 'Quick actions is the first/top-left card');
    assert.deepEqual(layout.widgets[1].grid, { x: 0, y: 16, w: 32, h: 18 }, 'Summary stays compact enough to avoid bottom whitespace');
    assert.equal(dashboardWidgetPresentation(layout.widgets[1]), 'standard');
    assert.equal(dashboardWidgetPresentation(layout.widgets[2]), 'hero');
    for (const widget of layout.widgets) {
      assert.ok(DASHBOARD_WIDGET_SIZES.includes(widget.size), `${widget.type} has a valid size`);
      assert.ok(widget.title.length > 0, `${widget.type} has a title`);
      assert.ok(widget.grid, `${widget.type} has a grid placement`);
      assert.ok(widget.grid!.x >= 0 && widget.grid!.x + widget.grid!.w <= DASHBOARD_GRID_COLUMNS, `${widget.type} fits the columns`);
    }
    const placements = layout.widgets.map((w) => w.grid!);
    for (let i = 0; i < placements.length; i += 1) {
      for (let j = i + 1; j < placements.length; j += 1) {
        assert.equal(gridPlacementsOverlap(placements[i], placements[j]), false, `default widgets ${i}/${j} overlap`);
      }
    }
  });

  await t.test('renames old default titles to the clearer current labels', () => {
    const quick = migrateDashboardWidgetConfig({ type: 'quick-capture', title: 'Quick capture', size: 'small' });
    const stats = migrateDashboardWidgetConfig({ type: 'stats', title: 'Today at a glance', size: 'small' });
    const statsLegacy = migrateDashboardWidgetConfig({ type: 'stats', title: 'Today summary', size: 'small' });
    const today = migrateDashboardWidgetConfig({ type: 'today', title: 'Today', size: 'large' });
    const focus = migrateDashboardWidgetConfig({ type: 'focus-queue', title: 'Focus queue', size: 'medium' });
    assert.equal(quick.title, 'Quick actions');
    assert.equal(stats.title, 'Summary');
    assert.equal(statsLegacy.title, 'Summary');
    assert.equal(today.title, 'Agenda');
    assert.equal(focus.title, 'Next up');
  });

  await t.test('aliases removed quick-actions widgets to the combined quick-capture card', () => {
    const layout = createDefaultDashboardLayout(1000);
    const migrated = migrateDashboardLayout({
      ...layout,
      widgets: [
        { type: 'quick-actions', title: 'Old quick actions', size: 'small' } as DashboardWidgetConfig,
        ...layout.widgets,
      ],
    });
    assert.equal(migrated.widgets.filter((w) => w.type === 'quick-capture').length, 1);
    assert.equal(migrated.widgets.some((w) => w.type === 'quick-actions'), false);
  });

  await t.test('serializes and deserializes without losing the size model', () => {
    const layout = createDefaultDashboardLayout(42);
    const round = JSON.parse(JSON.stringify(layout)) as DashboardLayout;
    assert.equal(round.widgets.length, 3);
    assert.equal(round.widgets[0].size, 'small');
    assert.equal(round.widgets[0].type, 'quick-capture');
  });

  await t.test('stamps template origin so dashboards can be refreshed later', () => {
    const layout = createDefaultDashboardLayout(1000);
    assert.equal(layout.templateId, 'default');
    assert.equal(layout.templateRevision, DASHBOARD_TEMPLATE_REVISION);
    assert.equal(layout.templateSignature, dashboardWidgetsSignature(layout.widgets));
  });
});

test('Template dashboard refresh', async (t) => {
  await t.test('regenerates an unmodified template dashboard at an older revision', () => {
    const fresh = createDashboardLayoutFromTemplate('default', 1000);
    // Simulate a dashboard created from an older template revision that the user never modified.
    const stale: DashboardLayout = { ...fresh, id: 'my-home', name: 'My home', templateRevision: DASHBOARD_TEMPLATE_REVISION - 1 };
    const refreshed = refreshPristineTemplateLayout(stale, 2000);
    assert.notEqual(refreshed, stale);
    assert.equal(refreshed.templateRevision, DASHBOARD_TEMPLATE_REVISION);
    assert.equal(refreshed.id, 'my-home', 'preserves the dashboard id');
    assert.equal(refreshed.name, 'My home', 'preserves the dashboard name');
    assert.deepEqual(refreshed.widgets.map((w) => w.type), fresh.widgets.map((w) => w.type));
  });

  await t.test('leaves a user-modified template dashboard untouched', () => {
    const fresh = createDashboardLayoutFromTemplate('default', 1000);
    const modified: DashboardLayout = {
      ...fresh,
      id: 'my-home',
      templateRevision: DASHBOARD_TEMPLATE_REVISION - 1,
      widgets: fresh.widgets.slice(0, fresh.widgets.length - 1), // user removed a widget
    };
    const result = refreshPristineTemplateLayout(modified, 2000);
    assert.equal(result, modified, 'returns the same layout when the signature no longer matches');
    assert.equal(result.widgets.length, fresh.widgets.length - 1);
  });

  await t.test('folds Overdue into Agenda: a pristine pre-fold default drops the standalone Overdue card', () => {
    // Reconstruct a pristine Command center as it shipped before the fold (separate Overdue card).
    const legacyTypes = ['quick-capture', 'stats', 'focus-queue', 'overdue-risk', 'agenda', 'blocked-waiting', 'review-queue', 'recently-completed'];
    const legacyWidgets = legacyTypes.map((type, i) => ({
      type, title: type, size: 'medium', grid: { x: 0, y: i, w: 1, h: 1 },
    })) as DashboardWidgetConfig[];
    const legacy: DashboardLayout = {
      id: 'default', name: 'Command center', widgets: legacyWidgets,
      createdAt: 1, updatedAt: 1, gridCols: DASHBOARD_GRID_COLUMNS,
      templateId: 'default', templateRevision: DASHBOARD_TEMPLATE_REVISION - 1,
      // Pristine by construction: signature matches its own widgets, so the user has not customized it.
      templateSignature: dashboardWidgetsSignature(legacyWidgets),
    };
    const refreshed = refreshPristineTemplateLayout(legacy, 2000);
    assert.notEqual(refreshed, legacy, 'an unmodified older-revision default is regenerated');
    assert.equal(refreshed.widgets.some((w) => w.type === 'overdue-risk'), false, 'standalone Overdue card is removed');
    assert.ok(refreshed.widgets.some((w) => w.type === 'today'), 'Agenda replaces the separate Next up / Dated agenda cards');
    assert.equal(refreshed.id, 'default');
    assert.equal(refreshed.name, 'Command center');
  });

  await t.test('foldOverdueCardIntoAgenda strips the Overdue card from a customized (non-pristine) pre-fold default', () => {
    // Mirrors a real reflowed dashboard: agenda sits above a now-redundant overdue-risk card, and the
    // signature no longer matches its widgets, so refreshPristineTemplateLayout would skip it.
    const widgets = [
      { type: 'focus-queue', title: 'Next up', size: 'large', grid: { x: 24, y: 0, w: 48, h: 35 } },
      { type: 'agenda', title: 'Agenda', size: 'large', grid: { x: 24, y: 35, w: 48, h: 16 } },
      { type: 'overdue-risk', title: 'Overdue', size: 'medium', grid: { x: 24, y: 51, w: 48, h: 16 } },
    ] as DashboardWidgetConfig[];
    const layout: DashboardLayout = {
      id: 'default', name: 'Command center', widgets,
      createdAt: 1, updatedAt: 1, gridCols: DASHBOARD_GRID_COLUMNS,
      templateId: 'default', templateRevision: DASHBOARD_OVERDUE_FOLD_REVISION - 1,
      templateSignature: 'stale-signature-that-no-longer-matches',
    };
    const folded = foldOverdueCardIntoAgenda(layout, 5000);
    assert.notEqual(folded, layout, 'a customized pre-fold default is rewritten');
    assert.equal(folded.widgets.some((w) => w.type === 'overdue-risk'), false, 'standalone Overdue card removed');
    const agenda = folded.widgets.find((w) => w.type === 'agenda');
    assert.ok(agenda?.grid, 'agenda kept');
    assert.equal(agenda?.grid?.h, 32, 'Agenda grows by the freed height (16 + 16) so the column has no gap');
    assert.equal(folded.templateRevision, DASHBOARD_OVERDUE_FOLD_REVISION, 'gate stamped so the fold never re-runs');
    assert.equal(folded.updatedAt, 5000);
  });

  await t.test('foldOverdueCardIntoAgenda folds the legacy Overdue card from above Agenda', () => {
    const layout: DashboardLayout = {
      id: 'default', name: 'Command center',
      widgets: [
        { type: 'overdue-risk', title: 'Overdue', size: 'medium', grid: { x: 24, y: 0, w: 48, h: 16 } },
        { type: 'agenda', title: 'Agenda', size: 'large', grid: { x: 24, y: 16, w: 48, h: 16 } },
      ] as DashboardWidgetConfig[],
      createdAt: 1, updatedAt: 1, gridCols: DASHBOARD_GRID_COLUMNS,
      templateId: 'default', templateRevision: DASHBOARD_OVERDUE_FOLD_REVISION - 1,
    };
    const folded = foldOverdueCardIntoAgenda(layout, 5000);
    assert.equal(folded.widgets.some((w) => w.type === 'overdue-risk'), false, 'legacy above-Agenda Overdue card removed');
    assert.deepEqual(folded.widgets.find((w) => w.type === 'agenda')?.grid, { x: 24, y: 0, w: 48, h: 32 }, 'Agenda absorbs the removed card from above');
    assert.equal(folded.updatedAt, 5000);
  });

  await t.test('foldOverdueCardIntoAgenda preserves non-adjacent custom Overdue cards', () => {
    const layout: DashboardLayout = {
      id: 'default', name: 'Command center',
      widgets: [
        { type: 'overdue-risk', title: 'My Overdue Watch', size: 'medium', grid: { x: 0, y: 0, w: 24, h: 8 } },
        { type: 'agenda', title: 'Agenda', size: 'large', grid: { x: 24, y: 0, w: 48, h: 16 } },
        { type: 'recently-completed', title: 'Done', size: 'medium', grid: { x: 24, y: 16, w: 48, h: 16 } },
      ] as DashboardWidgetConfig[],
      createdAt: 1, updatedAt: 1, gridCols: DASHBOARD_GRID_COLUMNS,
      templateId: 'default', templateRevision: DASHBOARD_OVERDUE_FOLD_REVISION - 1,
    };
    const folded = foldOverdueCardIntoAgenda(layout, 5000);
    assert.notEqual(folded, layout, 'migration still stamps the revision gate');
    assert.equal(folded.widgets.some((w) => w.type === 'overdue-risk'), true, 'custom Overdue card is preserved');
    assert.equal(folded.widgets.find((w) => w.type === 'agenda')?.grid?.h, 16, 'Agenda is not grown by unrelated card height');
    assert.deepEqual(folded.widgets.find((w) => w.type === 'recently-completed')?.grid, { x: 24, y: 16, w: 48, h: 16 }, 'unrelated cards are not relocated');
    assert.equal(folded.templateRevision, DASHBOARD_OVERDUE_FOLD_REVISION);
    assert.equal(folded.updatedAt, 1, 'layout content was not rewritten');
  });

  await t.test('foldOverdueCardIntoAgenda preserves adjacent customized Overdue cards', () => {
    const layout: DashboardLayout = {
      id: 'default', name: 'Command center',
      widgets: [
        { type: 'agenda', title: 'Agenda', size: 'large', grid: { x: 24, y: 0, w: 48, h: 16 } },
        { type: 'overdue-risk', title: 'My Overdue Watch', size: 'medium', grid: { x: 24, y: 16, w: 48, h: 8 } },
      ] as DashboardWidgetConfig[],
      createdAt: 1, updatedAt: 1, gridCols: DASHBOARD_GRID_COLUMNS,
      templateId: 'default', templateRevision: DASHBOARD_OVERDUE_FOLD_REVISION - 1,
    };
    const folded = foldOverdueCardIntoAgenda(layout, 5000);
    assert.equal(folded.widgets.some((w) => w.type === 'overdue-risk'), true, 'renamed adjacent Overdue card is treated as user-customized');
    assert.equal(folded.widgets.find((w) => w.type === 'agenda')?.grid?.h, 16, 'Agenda is not grown by a custom adjacent Overdue card');
    assert.equal(folded.updatedAt, 1, 'layout content was not rewritten');
    assert.equal(folded.templateRevision, DASHBOARD_OVERDUE_FOLD_REVISION, 'revision gate is still stamped');
  });

  await t.test('foldOverdueCardIntoAgenda removes only the adjacent legacy Overdue card', () => {
    const layout: DashboardLayout = {
      id: 'default', name: 'Command center',
      widgets: [
        { type: 'agenda', title: 'Agenda', size: 'large', grid: { x: 24, y: 0, w: 48, h: 16 } },
        { type: 'overdue-risk', title: 'Overdue', size: 'medium', grid: { x: 24, y: 16, w: 48, h: 8 } },
        { type: 'overdue-risk', title: 'My Overdue Watch', size: 'medium', grid: { x: 0, y: 0, w: 24, h: 8 } },
      ] as DashboardWidgetConfig[],
      createdAt: 1, updatedAt: 1, gridCols: DASHBOARD_GRID_COLUMNS,
      templateId: 'default', templateRevision: DASHBOARD_OVERDUE_FOLD_REVISION - 1,
    };
    const folded = foldOverdueCardIntoAgenda(layout, 5000);
    assert.deepEqual(folded.widgets.filter((w) => w.type === 'overdue-risk').map((w) => w.title), ['My Overdue Watch']);
    assert.equal(folded.widgets.find((w) => w.type === 'agenda')?.grid?.h, 24, 'Agenda grows by the adjacent legacy card height only');
  });

  await t.test('foldOverdueCardIntoAgenda leaves an up-to-date dashboard alone (re-added Overdue cards survive)', () => {
    const layout: DashboardLayout = {
      id: 'default', name: 'Command center',
      widgets: [
        { type: 'agenda', title: 'Agenda', size: 'large', grid: { x: 24, y: 0, w: 48, h: 32 } },
        { type: 'overdue-risk', title: 'Overdue', size: 'medium', grid: { x: 24, y: 32, w: 48, h: 8 } },
      ] as DashboardWidgetConfig[],
      createdAt: 1, updatedAt: 1, gridCols: DASHBOARD_GRID_COLUMNS,
      templateId: 'default', templateRevision: DASHBOARD_OVERDUE_FOLD_REVISION,
    };
    assert.equal(foldOverdueCardIntoAgenda(layout), layout, 'already at the fold revision → untouched');
  });

  await t.test('foldOverdueCardIntoAgenda ignores non-default templates', () => {
    const layout: DashboardLayout = {
      id: 'x', name: 'Focus',
      widgets: [{ type: 'overdue-risk', title: 'Overdue', size: 'medium', grid: { x: 0, y: 0, w: 1, h: 1 } }] as DashboardWidgetConfig[],
      createdAt: 1, updatedAt: 1, templateId: 'focus', templateRevision: 0,
    };
    assert.equal(foldOverdueCardIntoAgenda(layout), layout);
  });

  await t.test('foldOverdueCardIntoAgenda closes the gate even when no Overdue card is present', () => {
    const layout: DashboardLayout = {
      id: 'default', name: 'Command center',
      widgets: [{ type: 'agenda', title: 'Agenda', size: 'large', grid: { x: 0, y: 0, w: 48, h: 32 } }] as DashboardWidgetConfig[],
      createdAt: 1, updatedAt: 1, templateId: 'default', templateRevision: 5,
    };
    const folded = foldOverdueCardIntoAgenda(layout);
    assert.equal(folded.templateRevision, DASHBOARD_OVERDUE_FOLD_REVISION, 'still stamps the fold revision');
    assert.equal(folded.widgets.length, 1);
  });

  await t.test('mergeNextUpAgendaIntoToday combines adjacent default cards in customized defaults', () => {
    const layout: DashboardLayout = {
      id: 'default', name: 'Command center',
      widgets: [
        { type: 'quick-capture', title: 'Quick actions', size: 'small', grid: { x: 0, y: 0, w: 24, h: 16 } },
        { type: 'focus-queue', title: 'Next up', size: 'large', presentation: 'hero', grid: { x: 24, y: 0, w: 48, h: 32 } },
        { type: 'agenda', title: 'Agenda', size: 'large', grid: { x: 24, y: 32, w: 48, h: 32 } },
      ] as DashboardWidgetConfig[],
      createdAt: 1, updatedAt: 1, gridCols: DASHBOARD_GRID_COLUMNS,
      templateId: 'default', templateRevision: DASHBOARD_OVERDUE_FOLD_REVISION,
      templateSignature: 'customized',
    };
    const merged = mergeNextUpAgendaIntoToday(layout, 5000);
    assert.notEqual(merged, layout);
    assert.deepEqual(merged.widgets.map((w) => w.type), ['quick-capture', 'today']);
    assert.deepEqual(merged.widgets.find((w) => w.type === 'today')?.grid, { x: 24, y: 0, w: 48, h: 64 });
    assert.equal(merged.widgets.find((w) => w.type === 'today')?.presentation, 'hero');
    assert.equal(merged.templateRevision, DASHBOARD_TODAY_MERGE_REVISION);
    assert.equal(merged.updatedAt, 5000);
  });

  await t.test('mergeNextUpAgendaIntoToday preserves deliberately separated cards', () => {
    const layout: DashboardLayout = {
      id: 'default', name: 'Command center',
      widgets: [
        { type: 'focus-queue', title: 'Next up', size: 'large', grid: { x: 24, y: 0, w: 48, h: 32 } },
        { type: 'agenda', title: 'My calendar lane', size: 'large', grid: { x: 24, y: 32, w: 48, h: 32 } },
      ] as DashboardWidgetConfig[],
      createdAt: 1, updatedAt: 1, gridCols: DASHBOARD_GRID_COLUMNS,
      templateId: 'default', templateRevision: DASHBOARD_OVERDUE_FOLD_REVISION,
    };
    const merged = mergeNextUpAgendaIntoToday(layout, 5000);
    assert.equal(merged.widgets.some((w) => w.type === 'today'), false);
    assert.deepEqual(merged.widgets.map((w) => w.type), ['focus-queue', 'agenda']);
    assert.equal(merged.templateRevision, DASHBOARD_TODAY_MERGE_REVISION);
    assert.equal(merged.updatedAt, 1, 'layout content was not rewritten');
  });

  await t.test('consolidateDefaultRightRailIntoToday folds default right-rail cards into Today', () => {
    const layout: DashboardLayout = {
      id: 'default', name: 'Command center',
      widgets: [
        { type: 'quick-capture', title: 'Quick actions', size: 'small', grid: { x: 0, y: 0, w: 24, h: 16 } },
        { type: 'today', title: 'Agenda', size: 'large', presentation: 'hero', grid: { x: 24, y: 0, w: 48, h: 64 } },
        { type: 'blocked-waiting', title: 'Blocked / waiting', size: 'medium', presentation: 'kpi', grid: { x: 72, y: 0, w: 24, h: 8 } },
        { type: 'review-queue', title: 'Review queues', size: 'large', grid: { x: 72, y: 8, w: 24, h: 40 } },
        { type: 'recently-completed', title: 'Recently done', size: 'medium', grid: { x: 72, y: 48, w: 24, h: 16 } },
      ] as DashboardWidgetConfig[],
      createdAt: 1, updatedAt: 1, gridCols: DASHBOARD_GRID_COLUMNS,
      templateId: 'default', templateRevision: DASHBOARD_TODAY_MERGE_REVISION,
    };
    const consolidated = consolidateDefaultRightRailIntoToday(layout, 5000);
    assert.deepEqual(consolidated.widgets.map((w) => w.type), ['quick-capture', 'today']);
    assert.deepEqual(consolidated.widgets.find((w) => w.type === 'today')?.grid, { x: 24, y: 0, w: 72, h: 64 });
    assert.equal(consolidated.templateRevision, DASHBOARD_TODAY_FULL_CONSOLIDATION_REVISION);
    assert.equal(consolidated.updatedAt, 5000);
  });

  await t.test('compactDefaultSummaryWidget tightens the legacy default Summary card', () => {
    const layout: DashboardLayout = {
      id: 'default', name: 'Command center',
      widgets: [
        { type: 'quick-capture', title: 'Quick actions', size: 'small', grid: { x: 0, y: 0, w: 32, h: 16 } },
        { type: 'stats', title: 'Summary', size: 'large', grid: { x: 0, y: 16, w: 32, h: 32 } },
        { type: 'today', title: 'Agenda', size: 'large', presentation: 'hero', grid: { x: 32, y: 0, w: 64, h: 64 } },
      ] as DashboardWidgetConfig[],
      createdAt: 1, updatedAt: 1, gridCols: DASHBOARD_GRID_COLUMNS,
      templateId: 'default', templateRevision: DASHBOARD_TODAY_FULL_CONSOLIDATION_REVISION,
      templateSignature: 'customized-layout',
    };
    const compacted = compactDefaultSummaryWidget(layout, 5000);
    assert.notEqual(compacted, layout);
    assert.deepEqual(compacted.widgets.find((w) => w.type === 'stats')?.grid, { x: 0, y: 16, w: 32, h: 18 });
    assert.equal(compacted.templateRevision, DASHBOARD_SUMMARY_COMPACT_REVISION);
    assert.equal(compacted.updatedAt, 5000);

    const manual = {
      ...layout,
      widgets: layout.widgets.map((widget) => widget.type === 'stats' && widget.grid
        ? { ...widget, grid: { ...widget.grid, h: 28 } }
        : widget),
    } as DashboardLayout;
    const preserved = compactDefaultSummaryWidget(manual, 6000);
    assert.equal(preserved.widgets.find((w) => w.type === 'stats')?.grid?.h, 28, 'manual Summary resize is preserved');
    assert.equal(preserved.templateRevision, DASHBOARD_SUMMARY_COMPACT_REVISION, 'gate is still stamped');
    assert.equal(preserved.updatedAt, 1, 'layout content was not rewritten');
  });

  await t.test('ignores custom dashboards with no template origin', () => {
    const layout: DashboardLayout = { id: 'custom', name: 'Custom', widgets: [], createdAt: 1, updatedAt: 1 };
    assert.equal(refreshPristineTemplateLayout(layout, 2), layout);
  });

  await t.test('does nothing when the dashboard is already at the current revision', () => {
    const fresh = createDashboardLayoutFromTemplate('focus', 1000);
    assert.equal(refreshPristineTemplateLayout(fresh, 2000), fresh);
  });

  await t.test('keeps Momentum even when stats is present because gamification lives in Momentum', () => {
    const base = createDashboardLayoutFromTemplate('default', 1000);
    const momentumWidget: DashboardWidgetConfig = { type: 'momentum', title: 'Momentum', size: 'large', collapsed: false, grid: { x: 0, y: 40, w: 12, h: 6 } };
    const withMomentum: DashboardLayout = {
      ...base,
      widgets: [...base.widgets, momentumWidget],
    };
    const deduped = dropRedundantMomentumWidget(withMomentum);
    assert.equal(deduped, withMomentum, 'returns the same layout untouched');
    assert.equal(deduped.widgets.some((w) => w.type === 'stats'), true, 'keeps the stats card');
    assert.equal(deduped.widgets.some((w) => w.type === 'momentum'), true, 'keeps the only XP/achievement card');
    assert.equal(deduped.widgets.length, base.widgets.length + 1);
  });

  await t.test('keeps Momentum when there is no stats card', () => {
    const review = createDashboardLayoutFromTemplate('review', 1000);
    assert.equal(review.widgets.some((w) => w.type === 'momentum'), true, 'review template uses momentum');
    assert.equal(review.widgets.some((w) => w.type === 'stats'), false);
    assert.equal(dropRedundantMomentumWidget(review), review, 'returns the same layout untouched');
  });
});

test('Dashboard collections, templates, import/export', async (t) => {
  function assertNoTemplateOverlaps(layout: DashboardLayout): void {
    const placements = layout.widgets.map((widget) => widget.grid!);
    for (let i = 0; i < placements.length; i += 1) {
      for (let j = i + 1; j < placements.length; j += 1) {
        assert.equal(gridPlacementsOverlap(placements[i], placements[j]), false, `${layout.id} widgets ${i}/${j} overlap`);
      }
    }
  }

  await t.test('creates stable, unique dashboard IDs from names', () => {
    assert.equal(dashboardIdFromName('Work Dashboard!'), 'work-dashboard');
    assert.equal(dashboardIdFromName('   ', 'fallback'), 'fallback');
    assert.equal(uniqueDashboardId('Work Dashboard', ['work-dashboard', 'work-dashboard-2']), 'work-dashboard-3');
  });

  await t.test('built-in templates produce valid non-overlapping layouts', () => {
    for (const template of DASHBOARD_BUILTIN_TEMPLATES) {
      const layout = createDashboardLayoutFromTemplate(template.id, 1234);
      assert.equal(layout.createdAt, 1234);
      assert.equal(layout.updatedAt, 1234);
      assert.ok(layout.widgets.length > 0, `${template.id} has widgets`);
      assert.ok(template.tone.length > 0, `${template.id} declares a visual tone`);
      assert.ok(template.primaryQuestion.length > 0, `${template.id} declares a primary dashboard question`);
      assert.equal(layout.widgets.filter((widget) => dashboardWidgetPresentation(widget) === 'hero').length, 1, `${template.id} has one hero widget`);
      assertNoTemplateOverlaps(layout);
    }
  });

  await t.test('clones dashboard layouts without sharing widget placement objects', () => {
    const source = createDefaultDashboardLayout(100);
    source.widgets[0].customConfig = { limit: 5 };
    const copy = cloneDashboardLayout(source, { id: 'copy', name: 'Copy', createdAt: 200, updatedAt: 200 });
    assert.equal(copy.id, 'copy');
    assert.equal(copy.name, 'Copy');
    assert.equal(copy.createdAt, 200);
    assert.equal(copy.widgets[0].type, source.widgets[0].type);
    assert.notEqual(copy.widgets[0], source.widgets[0]);
    assert.notEqual(copy.widgets[0].grid, source.widgets[0].grid);
    assert.deepEqual(copy.widgets[0].customConfig, { limit: 5 });
    copy.widgets[0].grid!.x = 5;
    assert.equal(source.widgets[0].grid!.x, 0);
  });

  await t.test('exports and imports a dashboard as a unique layout', () => {
    const source = createDefaultDashboardLayout(100);
    source.name = 'Ops Dashboard';
    const exported = exportDashboardLayout(source);
    assert.ok(exported.includes(DASHBOARD_LAYOUT_EXPORT_KIND));
    const result = parseDashboardImportPayload(exported, ['default'], []);
    assert.equal(result.layouts.length, 1);
    assert.equal(result.templates.length, 0);
    assert.equal(result.layouts[0].id, 'default-2');
    assert.equal(result.layouts[0].name, 'Ops Dashboard');
    assert.deepEqual(result.layouts[0].widgets.map((widget) => widget.type), source.widgets.map((widget) => widget.type));
  });

  await t.test('imports dashboard collections and templates with de-duplicated IDs', () => {
    const layout = createDashboardLayoutFromTemplate('focus', 5);
    const template = createDashboardTemplateFromLayout(layout, 'focus-template', 'Focus Template', 'Reusable focus setup', 10);
    const payload = exportDashboardCollection([layout], [template]);
    const result = parseDashboardImportPayload(payload, ['focus'], ['focus-template']);
    assert.equal(result.layouts.length, 1);
    assert.equal(result.templates.length, 1);
    assert.equal(result.layouts[0].id, 'focus-2');
    assert.equal(result.templates[0].id, 'focus-template-2');
    assert.equal(result.templates[0].description, 'Reusable focus setup');
    assertNoTemplateOverlaps(result.layouts[0]);
    assertNoTemplateOverlaps(result.templates[0].layout);
  });

  await t.test('round-trips a saved template into a new dashboard layout', () => {
    const template = createDashboardTemplateFromLayout(createDashboardLayoutFromTemplate('planning', 10), 'plan-template', 'Planning Template', 'Plan the week', 20);
    const parsed = parseDashboardImportPayload(exportDashboardTemplate(template), [], []);
    assert.equal(parsed.templates.length, 1);
    const layout = cloneDashboardTemplateAsLayout(parsed.templates[0], 'from-template', 'From template', 99);
    assert.equal(layout.id, 'from-template');
    assert.equal(layout.name, 'From template');
    assert.equal(layout.createdAt, 99);
    assert.deepEqual(layout.widgets.map((widget) => widget.type), template.layout.widgets.map((widget) => widget.type));
  });

  await t.test('parses note-backed dashboard code blocks from export envelopes', () => {
    const source = createDashboardLayoutFromTemplate('project', 50);
    const parsed = parseDashboardLayoutBlock(exportDashboardLayout(source), 99);
    assert.equal(parsed.id, 'project');
    assert.equal(parsed.name, 'Project control');
    assert.deepEqual(parsed.widgets.map((widget) => widget.type), source.widgets.map((widget) => widget.type));
    assertNoTemplateOverlaps(parsed);
  });

  await t.test('parses standalone widget blocks from shorthand and key-value syntax', () => {
    const shorthand = parseDashboardWidgetBlock('agenda');
    assert.equal(shorthand.type, 'agenda');
    assert.equal(shorthand.title, 'Agenda');
    assert.equal(shorthand.size, 'medium');

    const configured = parseDashboardWidgetBlock('type: saved-query\ntitle: Hot list\nsize: large\nquery: not done');
    assert.equal(configured.type, 'saved-query');
    assert.equal(configured.title, 'Hot list');
    assert.equal(configured.size, 'large');
    assert.equal(configured.query, 'not done');

    const daily = parseDashboardWidgetBlock('type: daily-todos\ndateProperty: date\nlimit: 25');
    assert.equal(daily.type, 'daily-todos');
    assert.equal(daily.title, 'Daily tasks');
    assert.equal(daily.size, 'large');
    assert.deepEqual(daily.customConfig, { dateProperty: 'date', limit: '25' });
  });
});

test('Dashboard date + scope helpers', async (t) => {
  await t.test('computes an exact calendar-day difference', () => {
    assert.equal(dashboardDayDiff('2026-05-01', '2026-05-08'), 7);
    assert.equal(dashboardDayDiff('2026-05-08', '2026-05-01'), -7);
    assert.equal(dashboardDayDiff('2026-05-01', '2026-05-01'), 0);
  });

  await t.test('produces scope windows anchored at today', () => {
    assert.deepEqual(dashboardScopeRange('today', '2026-05-10'), { start: '2026-05-10', end: '2026-05-10', label: 'Today' });
    assert.deepEqual(dashboardScopeRange('week', '2026-05-10'), { start: '2026-05-10', end: '2026-05-16', label: 'This week' });
    assert.deepEqual(dashboardScopeRange('month', '2026-05-10'), { start: '2026-05-10', end: '2026-06-08', label: 'This month' });
  });

  await t.test('labels relative dates with overdue / soon flags', () => {
    assert.deepEqual(dashboardRelativeDate('2026-05-07', '2026-05-10'), { label: '3d overdue', overdue: true, soon: false });
    assert.deepEqual(dashboardRelativeDate('2026-05-10', '2026-05-10'), { label: 'Today', overdue: false, soon: true });
    assert.deepEqual(dashboardRelativeDate('2026-05-11', '2026-05-10'), { label: 'Tomorrow', overdue: false, soon: true });
    const future = dashboardRelativeDate('2026-06-20', '2026-05-10');
    assert.equal(future.overdue, false);
    assert.equal(future.soon, false);
    assert.ok(future.label.length > 0);
  });

  await t.test('greets based on the hour of day', () => {
    assert.equal(dashboardGreeting(new Date(2026, 0, 1, 8, 0, 0)), 'Good morning');
    assert.equal(dashboardGreeting(new Date(2026, 0, 1, 14, 0, 0)), 'Good afternoon');
    assert.equal(dashboardGreeting(new Date(2026, 0, 1, 20, 0, 0)), 'Good evening');
  });
});

test('Dashboard task filters', async (t) => {
  await t.test('keeps only active tasks', () => {
    const tasks = [
      { key: 'a', status: 'todo', metadata: { dates: { due: '2026-05-29' } } },
      { key: 'b', status: 'done', metadata: { dates: { due: '2026-05-29' } } },
      { key: 'c', status: 'todo', metadata: { dates: { scheduled: '2026-06-10' } } },
      { key: 'd', status: 'cancelled', metadata: { dates: { due: '2026-05-30' } } },
      { key: 'f', status: 'untracked', metadata: { dates: { due: '2026-05-30' } } },
    ] as ParsedTask[];
    assert.deepEqual(filterDashboardActiveTasks(tasks).map((task) => task.key), ['a', 'c']);
  });

  await t.test('builds daily todos from carry-forward plus tasks closed on the note date', () => {
    const date = '2026-05-10';
    const tasks = [
      { key: 'due-past', status: 'todo', normalizedText: 'Due past', metadata: { priority: 'normal', dates: { due: '2026-04-30' }, dependsOn: [] } },
      { key: 'scheduled-today', status: 'in_progress', normalizedText: 'Scheduled today', metadata: { priority: 'normal', dates: { scheduled: date }, dependsOn: [] } },
      { key: 'scheduled-past-due-future', status: 'blocked', normalizedText: 'Scheduled past', metadata: { priority: 'normal', dates: { scheduled: '2026-05-01', due: '2026-05-20' }, dependsOn: [] } },
      { key: 'future', status: 'todo', normalizedText: 'Future', metadata: { priority: 'normal', dates: { due: '2026-05-20' }, dependsOn: [] } },
      { key: 'done-today', status: 'done', filePath: 'Done.md', lineNumber: 3, normalizedText: 'Done today', metadata: { priority: 'normal', dates: { done: date, due: '2026-04-01' }, dependsOn: [] } },
      { key: 'done-yesterday', status: 'done', filePath: 'Done.md', lineNumber: 2, normalizedText: 'Done yesterday', metadata: { priority: 'normal', dates: { done: '2026-05-09', due: '2026-04-01' }, dependsOn: [] } },
      { key: 'cancelled-today', status: 'cancelled', filePath: 'Done.md', lineNumber: 4, normalizedText: 'Cancelled today', metadata: { priority: 'normal', dates: { cancelled: date, scheduled: '2026-04-01' }, dependsOn: [] } },
      { key: 'cancelled-other', status: 'cancelled', filePath: 'Done.md', lineNumber: 5, normalizedText: 'Cancelled other', metadata: { priority: 'normal', dates: { cancelled: '2026-05-09', scheduled: '2026-04-01' }, dependsOn: [] } },
    ] as unknown as ParsedTask[];
    const model = dashboardDailyTodosModel(tasks, date);
    assert.deepEqual(model.carryForward.map((task) => task.key), ['due-past', 'scheduled-past-due-future', 'scheduled-today']);
    assert.deepEqual(model.completed.map((task) => task.key), ['done-today']);
    assert.deepEqual(model.cancelled.map((task) => task.key), ['cancelled-today']);
    assert.equal(model.badge, '5');
  });

  await t.test('filters upcoming within the next 7 days', () => {
    const tasks = [
      { key: 'a', status: 'todo', metadata: { dates: { due: '2026-05-29' } } },
      { key: 'c', status: 'todo', metadata: { dates: { scheduled: '2026-06-10' } } },
      { key: 'e', status: 'todo', metadata: { dates: { scheduled: '2026-05-01', due: '2026-05-30' } } },
    ] as ParsedTask[];
    assert.deepEqual(filterDashboardUpcomingTasks(tasks, '2026-05-28', 7).map((task) => task.key), ['a', 'e']);
  });

  await t.test('filters recently completed by dashboard scope without future done dates', () => {
    const tasks = [
      { key: 'future', status: 'done', metadata: { dates: { done: '2026-05-11' } } },
      { key: 'today', status: 'done', metadata: { dates: { done: '2026-05-10' } } },
      { key: 'week-boundary', status: 'done', metadata: { dates: { done: '2026-05-04' } } },
      { key: 'month-boundary', status: 'done', metadata: { dates: { done: '2026-05-01' } } },
      { key: 'old', status: 'done', metadata: { dates: { done: '2026-04-30' } } },
      { key: 'open', status: 'todo', metadata: { dates: { done: '2026-05-10' } } },
    ] as ParsedTask[];
    assert.deepEqual(filterDashboardRecentlyCompletedTasks(tasks, '2026-05-10', 'today').map((task) => task.key), ['today']);
    assert.deepEqual(filterDashboardRecentlyCompletedTasks(tasks, '2026-05-10', 'week').map((task) => task.key), ['today', 'week-boundary']);
    assert.deepEqual(filterDashboardRecentlyCompletedTasks(tasks, '2026-05-10', 'month').map((task) => task.key), ['today', 'week-boundary', 'month-boundary']);
  });

  await t.test('builds the agenda from overdue + scoped tasks, sorted by date', () => {
    const tasks = [
      { key: 'overdue', status: 'todo', metadata: { priority: 'normal', dates: { due: '2026-05-01' } } },
      { key: 'today', status: 'todo', metadata: { priority: 'normal', dates: { due: '2026-05-10' } } },
      { key: 'next-week', status: 'todo', metadata: { priority: 'normal', dates: { due: '2026-05-14' } } },
      { key: 'far', status: 'todo', metadata: { priority: 'normal', dates: { due: '2026-06-30' } } },
      { key: 'undated', status: 'todo', metadata: { priority: 'normal', dates: {} } },
    ] as ParsedTask[];
    assert.deepEqual(filterDashboardAgendaTasks(tasks, '2026-05-10', 'today').map((t2) => t2.key), ['overdue', 'today']);
    assert.deepEqual(filterDashboardAgendaTasks(tasks, '2026-05-10', 'week').map((t2) => t2.key), ['overdue', 'today', 'next-week']);
  });

  await t.test('sorts same-day agenda tasks by priority', () => {
    const tasks = [
      { key: 'low', status: 'todo', metadata: { priority: 'low', dates: { due: '2026-05-10' } } },
      { key: 'high', status: 'todo', metadata: { priority: 'high', dates: { due: '2026-05-10' } } },
      { key: 'normal', status: 'todo', metadata: { priority: 'normal', dates: { due: '2026-05-10' } } },
    ] as ParsedTask[];
    assert.deepEqual(filterDashboardAgendaTasks(tasks, '2026-05-10', 'today').map((t2) => t2.key), ['high', 'normal', 'low']);
  });

  await t.test('includes start-only (🛫) tasks whose start date is within scope', () => {
    const tasks = [
      { key: 'start-today', status: 'todo', metadata: { priority: 'normal', dates: { start: '2026-05-10' } } },
      { key: 'start-week', status: 'todo', metadata: { priority: 'normal', dates: { start: '2026-05-14' } } },
      { key: 'start-far', status: 'todo', metadata: { priority: 'normal', dates: { start: '2026-06-30' } } },
      { key: 'due-today', status: 'todo', metadata: { priority: 'normal', dates: { due: '2026-05-10' } } },
    ] as ParsedTask[];
    // Today scope: only the start date on/before today qualifies (alongside the due-today task).
    assert.deepEqual(filterDashboardAgendaTasks(tasks, '2026-05-10', 'today').map((t2) => t2.key), ['start-today', 'due-today']);
    // Week scope pulls in the start date later this week, but not the far-future one.
    assert.deepEqual(filterDashboardAgendaTasks(tasks, '2026-05-10', 'week').map((t2) => t2.key), ['start-today', 'due-today', 'start-week']);
  });

  await t.test('agenda sorts by the soonest of due/scheduled/start', () => {
    const tasks = [
      // Far due date but a start date today — should sort by the earlier start date.
      { key: 'starts-today', status: 'todo', metadata: { priority: 'normal', dates: { due: '2026-05-20', start: '2026-05-10' } } },
      { key: 'due-12th', status: 'todo', metadata: { priority: 'normal', dates: { due: '2026-05-12' } } },
    ] as ParsedTask[];
    assert.deepEqual(filterDashboardAgendaTasks(tasks, '2026-05-10', 'week').map((t2) => t2.key), ['starts-today', 'due-12th']);
  });

  await t.test('excludes cancelled / done / untracked from the overdue filter', () => {
    const tasks = [
      { key: 'a', status: 'todo', metadata: { dates: { due: '2026-05-01' } } },
      { key: 'b', status: 'done', metadata: { dates: { due: '2026-05-01' } } },
      { key: 'c', status: 'cancelled', metadata: { dates: { due: '2026-05-01' } } },
      { key: 'd', status: 'todo', metadata: { dates: { due: '2026-06-30' } } },
      { key: 'e', status: 'todo', metadata: { dates: {} } },
      { key: 'f', status: 'untracked', metadata: { dates: { due: '2026-05-01' } } },
    ] as ParsedTask[];
    assert.deepEqual(filterDashboardOverdueTasks(tasks, '2026-05-30').map((task) => task.key), ['a']);
  });

  await t.test('counts a past scheduled-only date as overdue (matches the row chip)', () => {
    const tasks = [
      // Due in the past → overdue (due wins).
      { key: 'due-past', status: 'todo', metadata: { dates: { due: '2026-05-01' } } },
      // Only a scheduled date, in the past → overdue: its chip reads "Nd overdue", so the Overdue
      // card must agree. dashboardTaskDate() = due ?? scheduled drives both.
      { key: 'sched-past', status: 'todo', metadata: { dates: { scheduled: '2026-05-01' } } },
      // Due in the future but scheduled in the past → NOT overdue: due wins, so the chip shows the
      // future due date and the card must not count it.
      { key: 'due-future-sched-past', status: 'todo', metadata: { dates: { due: '2026-06-30', scheduled: '2026-05-01' } } },
      // Scheduled in the future → not overdue.
      { key: 'sched-future', status: 'todo', metadata: { dates: { scheduled: '2026-06-30' } } },
    ] as ParsedTask[];
    assert.deepEqual(filterDashboardOverdueTasks(tasks, '2026-05-30').map((task) => task.key), ['due-past', 'sched-past']);
  });

  await t.test('agenda buckets a row by the same date its chip shows (overdue / today / upcoming)', () => {
    const today = '2026-05-30';
    const due_past = { key: 'a', status: 'todo', metadata: { dates: { due: '2026-05-01' } } } as ParsedTask;
    const sched_past = { key: 'b', status: 'todo', metadata: { dates: { scheduled: '2026-05-01' } } } as ParsedTask;
    const due_today = { key: 'c', status: 'todo', metadata: { dates: { due: today } } } as ParsedTask;
    const due_future = { key: 'd', status: 'todo', metadata: { dates: { due: '2026-06-30' } } } as ParsedTask;
    // Due-future-scheduled-past must NOT land in Overdue: the chip shows the future due date (due wins).
    const due_future_sched_past = { key: 'e', status: 'todo', metadata: { dates: { due: '2026-06-30', scheduled: '2026-05-01' } } } as ParsedTask;
    // Start-only with a past 🛫 start has no overdue chip → pinned to Today, never Overdue.
    const start_past = { key: 'f', status: 'todo', metadata: { dates: { start: '2026-05-01' } } } as ParsedTask;
    const start_future = { key: 'g', status: 'todo', metadata: { dates: { start: '2026-06-30' } } } as ParsedTask;

    assert.equal(dashboardAgendaRowBucket(due_past, today), 'overdue');
    assert.equal(dashboardAgendaRowBucket(sched_past, today), 'overdue');
    assert.equal(dashboardAgendaRowBucket(due_today, today), 'today');
    assert.equal(dashboardAgendaRowBucket(due_future, today), 'upcoming');
    assert.equal(dashboardAgendaRowBucket(due_future_sched_past, today), 'upcoming');
    assert.equal(dashboardAgendaRowBucket(start_past, today), 'today');
    assert.equal(dashboardAgendaRowBucket(start_future, today), 'upcoming');
    assert.equal(dashboardAgendaRowBucket({ key: 'h', status: 'todo', metadata: { dates: { start: today, due: '2026-06-30' } } } as ParsedTask, today), 'today', 'a task included because it starts today belongs under Today even with a future due date');
    assert.equal(dashboardAgendaRowBucket({ key: 'i', status: 'todo', metadata: { dates: { start: '2026-05-01', due: '2026-06-30' } } } as ParsedTask, today), 'today', 'a task that already became startable is pinned to Today rather than future due');

    assert.equal(dashboardAgendaBucketLabel('overdue', 'week'), 'Overdue');
    assert.equal(dashboardAgendaBucketLabel('today', 'week'), 'Today');
    assert.equal(dashboardAgendaBucketLabel('upcoming', 'today'), 'Upcoming');
    assert.equal(dashboardAgendaBucketLabel('upcoming', 'week'), 'This week');
    assert.equal(dashboardAgendaBucketLabel('upcoming', 'month'), 'This month');
  });

  await t.test('agenda manual ordering excludes Canvas-backed tasks', () => {
    const markdown = { key: 'Tasks.md:1', filePath: 'Tasks.md', metadata: { dates: {} } } as ParsedTask;
    const canvas = { key: 'Board.canvas:canvas:node:1', filePath: 'Board.canvas', metadata: { dates: {} } } as ParsedTask;
    assert.deepEqual(dashboardManualOrderTasks([markdown, canvas]).map((task) => task.key), ['Tasks.md:1']);
  });

  await t.test('agenda section model orders grouped buckets and can render manual order flat', () => {
    const today = '2026-05-30';
    const tasks = [
      { key: 'future', status: 'todo', metadata: { priority: 'normal', dates: { due: '2026-06-02' } } },
      { key: 'scheduled-overdue', status: 'todo', metadata: { priority: 'normal', dates: { scheduled: '2026-05-01' } } },
      { key: 'due-today', status: 'todo', metadata: { priority: 'normal', dates: { due: today } } },
      { key: 'start-today-due-future', status: 'todo', metadata: { priority: 'normal', dates: { start: today, due: '2026-06-30' } } },
    ] as ParsedTask[];

    const sections = dashboardAgendaSectionModel(tasks, today, 'week');
    assert.deepEqual(sections.map((section) => section.label), ['Overdue', 'Today', 'This week']);
    assert.deepEqual(sections.map((section) => section.count), [1, 2, 1]);
    assert.deepEqual(sections.map((section) => section.tasks.map((task) => task.key)), [['scheduled-overdue'], ['due-today', 'start-today-due-future'], ['future']]);

    const flat = dashboardAgendaSectionModel(tasks, today, 'week', false);
    assert.equal(flat.length, 1);
    assert.equal(flat[0].bucket, null);
    assert.equal(flat[0].count, 4);
  });

  await t.test('next up model keeps the hero but excludes agenda rows from the shortlist', () => {
    const today = '2026-05-30';
    const tasks = [
      { key: 'blocked', status: 'todo', metadata: { priority: 'highest', dates: {}, dependsOn: ['dep'] } },
      { key: 'dated-hero', status: 'todo', metadata: { priority: 'highest', dates: { due: today }, dependsOn: [] } },
      { key: 'undated-high', status: 'todo', metadata: { priority: 'high', dates: {}, dependsOn: [] } },
      { key: 'undated-normal', status: 'todo', metadata: { priority: 'normal', dates: {}, dependsOn: [] } },
      { key: 'done', status: 'done', metadata: { priority: 'highest', dates: {}, dependsOn: [] } },
    ] as ParsedTask[];

    const model = dashboardNextUpModel(tasks, today, 'today');
    assert.equal(model.hero?.key, 'dated-hero', 'hero is the best actionable task overall');
    assert.deepEqual(model.backlog.map((task) => task.key), ['undated-high', 'undated-normal'], 'dated agenda rows and blocked/done tasks are excluded from backlog');
    assert.deepEqual(model.shortlist.map((task) => task.key), ['undated-high', 'undated-normal']);
    assert.equal(model.badge, '2');
  });

  await t.test('today model sections overdue, blocked, today by time, tomorrow, backlog, and recently done', () => {
    const today = '2026-05-30';
    const tasks = [
      { key: 'overdue-old', status: 'todo', normalizedText: 'Old', metadata: { priority: 'normal', dates: { due: '2026-05-01' }, dependsOn: [] } },
      { key: 'overdue-new', status: 'todo', normalizedText: 'New', metadata: { priority: 'normal', dates: { scheduled: '2026-05-29' }, dependsOn: [] } },
      { key: 'today-late', status: 'todo', normalizedText: 'Late', metadata: { priority: 'highest', dates: { due: today }, timeStart: '15:00', dependsOn: [] } },
      { key: 'today-early', status: 'todo', normalizedText: 'Early', metadata: { priority: 'normal', dates: { due: today }, timeStart: '09:00', dependsOn: [] } },
      { key: 'tomorrow', status: 'todo', normalizedText: 'Tomorrow', metadata: { priority: 'normal', dates: { due: '2026-05-31' }, dependsOn: [] } },
      { key: 'future', status: 'todo', normalizedText: 'Future', metadata: { priority: 'normal', dates: { due: '2026-06-02' }, dependsOn: [] } },
      { key: 'undated-high', status: 'todo', normalizedText: 'Undated', metadata: { priority: 'high', dates: {}, dependsOn: [] } },
      { key: 'blocked-undated', status: 'todo', normalizedText: 'Blocked', metadata: { priority: 'highest', dates: {}, dependsOn: ['dep'] } },
      { key: 'blocked-overdue', status: 'todo', normalizedText: 'Blocked overdue', metadata: { priority: 'highest', dates: { due: '2026-05-28' }, dependsOn: ['dep'] } },
      { key: 'done-today', status: 'done', normalizedText: 'Done', metadata: { priority: 'normal', dates: { done: today }, dependsOn: [] } },
      { key: 'done-yesterday', status: 'done', normalizedText: 'Done yesterday', metadata: { priority: 'normal', dates: { done: '2026-05-29' }, dependsOn: [] } },
    ] as unknown as ParsedTask[];

    const model = dashboardTodayModel(tasks, today, 'today');
    assert.deepEqual(model.overdue.map((task) => task.key), ['overdue-old', 'blocked-overdue', 'overdue-new']);
    assert.deepEqual(model.blocked.map((task) => task.key), ['blocked-undated'], 'blocked non-overdue tasks get their own section');
    assert.deepEqual(model.today.map((task) => task.key), ['today-early', 'today-late'], 'same-day tasks sort by time before priority');
    assert.deepEqual(model.tomorrow.map((task) => task.key), ['tomorrow']);
    assert.deepEqual(model.backlog.map((task) => task.key), ['future', 'undated-high'], 'backlog is everything else actionable, excluding blocked work');
    assert.deepEqual(model.recentlyDone.map((task) => task.key), ['done-today']);
    assert.equal(model.badge, '3', 'badge leads with overdue count');
  });

  await t.test('review queue model classifies representative cleanup tasks', () => {
    const today = '2026-05-30';
    const tasks = [
      { key: 'inbox', status: 'todo', filePath: 'A.md', lineNumber: 2, tags: [], contexts: [], metadata: { priority: 'normal', dates: {}, dependsOn: [] } },
      { key: 'schedule', status: 'todo', filePath: 'A.md', lineNumber: 1, tags: ['work'], contexts: [], metadata: { priority: 'normal', dates: {}, dependsOn: [] } },
      { key: 'blocked', status: 'todo', filePath: 'A.md', lineNumber: 3, tags: ['work'], contexts: [], metadata: { priority: 'normal', dates: {}, dependsOn: ['dep'] } },
      { key: 'stale', status: 'todo', filePath: 'A.md', lineNumber: 4, tags: ['work'], contexts: [], metadata: { priority: 'normal', dates: { created: '2026-04-01' }, dependsOn: [] } },
      { key: 'done', status: 'done', filePath: 'A.md', lineNumber: 5, tags: [], contexts: [], metadata: { priority: 'normal', dates: {}, dependsOn: [] } },
      { key: 'cancelled', status: 'cancelled', filePath: 'A.md', lineNumber: 6, tags: ['work'], contexts: [], metadata: { priority: 'normal', dates: {}, dependsOn: [] } },
      { key: 'untracked', status: 'untracked', filePath: 'A.md', lineNumber: 7, tags: ['work'], contexts: [], metadata: { priority: 'normal', dates: {}, dependsOn: [] } },
    ] as unknown as ParsedTask[];

    const queues = dashboardReviewQueues(tasks, today);
    assert.deepEqual(Object.fromEntries(queues.map((queue) => [queue.key, queue.tasks.map((task) => task.key)])), {
      triage: ['inbox'],
      schedule: ['schedule', 'stale'],
      blocked: ['blocked'],
      stale: ['stale'],
    });
  });

  await t.test('review queue groups include every populated queue', () => {
    const queues = [
      { label: 'Triage', tasks: [1] },
      { label: 'Schedule', tasks: [2] },
      { label: 'Blocked', tasks: [3] },
      { label: 'Stale', tasks: [4] },
      { label: 'Clear', tasks: [] as number[] },
    ];
    assert.deepEqual(dashboardReviewQueueGroups(queues).map((queue) => queue.label), ['Triage', 'Schedule', 'Blocked', 'Stale']);
  });

  await t.test('groups backlog tasks by source note in first-seen order', () => {
    const tasks = [
      { key: 'a', filePath: 'Prep/Nvidia Loop.md' },
      { key: 'b', filePath: 'Prep/Netflix Loop.md' },
      { key: 'c', filePath: 'Prep/Nvidia Loop.md' },
      { key: 'd', filePath: 'Prep/Netflix Loop.md' },
      { key: 'e', filePath: 'inbox.md' },
    ] as ParsedTask[];
    const groups = dashboardGroupTasksByNote(tasks);
    assert.deepEqual(groups.map((group) => group.label), ['Nvidia Loop', 'Netflix Loop', 'inbox']);
    assert.deepEqual(groups.map((group) => group.filePath), ['Prep/Nvidia Loop.md', 'Prep/Netflix Loop.md', 'inbox.md']);
    assert.deepEqual(groups.map((group) => group.tasks.map((task) => task.key)), [['a', 'c'], ['b', 'd'], ['e']]);
  });

  await t.test('filters habits to active habits only', () => {
    const tasks = [
      { key: 'active-habit', status: 'todo', tags: ['habit'], filePath: 'Tasks.md', metadata: { dates: {}, recurrence: 'every day' } },
      { key: 'done-habit', status: 'done', tags: ['habit'], filePath: 'Tasks.md', metadata: { dates: {}, recurrence: 'every day' } },
      { key: 'cancelled-habit', status: 'cancelled', tags: ['habit'], filePath: 'Tasks.md', metadata: { dates: {}, recurrence: 'every day' } },
      { key: 'normal-task', status: 'todo', tags: [], filePath: 'Tasks.md', metadata: { dates: {} } },
    ] as ParsedTask[];
    assert.deepEqual(filterDashboardActiveHabits(tasks).map((task) => task.key), ['active-habit']);

    const habitByTag = { key: 'tag-habit', status: 'todo', tags: ['habit'], filePath: 'Tasks.md', metadata: { dates: {}, recurrence: 'every day' } } as ParsedTask;
    assert.equal(taskIsHabit(habitByTag), true, 'tag "habit" (no #) + recurrence should identify as habit');

    const wrongPrefixTask = { key: 'wrong-prefix', status: 'todo', tags: ['#habit'], filePath: 'Tasks.md', metadata: { dates: {}, recurrence: 'every day' } } as ParsedTask;
    assert.equal(taskIsHabit(wrongPrefixTask), false, 'tag "#habit" (with #) should NOT match — real parser stores tags without #');
  });

  await t.test('matches excluded folders case-insensitively and ignores trailing slashes', () => {
    assert.equal(isDashboardPathExcluded('Archive/Done.md', ['archive']), true);
    assert.equal(isDashboardPathExcluded('Archive/Done.md', ['Archive/']), true);
    assert.equal(isDashboardPathExcluded('Archive/Done.md', ['/Archive']), true);
    assert.equal(isDashboardPathExcluded('Archive-old/Done.md', ['Archive']), false);
  });
});

test('Dashboard saved-query options', async (t) => {
  await t.test('passes settings query flags through to the parser/filter options', () => {
    const options = dashboardQueryOptions({
      ...DEFAULT_SETTINGS,
      nlpQueryEnabled: true,
      enableQueryDsl: false,
      enableDslExpressions: false,
    });
    assert.equal(options.nlpQueryEnabled, true);
    assert.equal(options.enableQueryDsl, false);
    assert.equal(options.enableDslExpressions, false);
    assert.strictEqual(options.states, DEFAULT_SETTINGS.supportedStates);
  });
});

test('Dashboard widget refresh dispatch', async (t) => {
  await t.test('refreshes only the matching widget config', () => {
    const target: DashboardWidgetConfig = { type: 'saved-query', title: 'Query', size: 'medium', query: 'status:todo' };
    const other: DashboardWidgetConfig = { type: 'stats', title: 'Stats', size: 'small' };
    let targetRefreshes = 0;
    let otherRefreshes = 0;
    refreshDashboardWidgetForConfig([
      { config: other, renderBody: async () => { otherRefreshes += 1; } },
      { config: target, renderBody: async () => { targetRefreshes += 1; } },
    ], target);
    assert.equal(targetRefreshes, 1);
    assert.equal(otherRefreshes, 0);
  });
});

test('Dashboard pomodoro helpers', async (t) => {
  await t.test('formats remaining seconds as MM:SS', () => {
    assert.equal(formatPomodoroSeconds(0), '00:00');
    assert.equal(formatPomodoroSeconds(65), '01:05');
    assert.equal(formatPomodoroSeconds(-5), '00:00');
  });

  await t.test('does not count paused wall-clock time in sessions', () => {
    const timing = calculatePomodoroSessionTiming(0, 5 * 60_000, 20 * 60_000);
    assert.deepEqual(timing, { startedAtMs: 15 * 60_000, elapsedMs: 5 * 60_000 });
  });

  await t.test('builds a time-session record from a task', () => {
    const task = { key: 'k', filePath: 'a.md', lineNumber: 3, normalizedText: 'Write report', body: 'Write report' } as ParsedTask;
    const session = createPomodoroTimeSession(task, '2026-05-10T10:00:00.000Z', '2026-05-10T10:25:00.000Z', 25);
    assert.equal(session.taskKey, 'k');
    assert.equal(session.elapsedMinutes, 25);
    assert.equal(session.source, 'pomodoro');
  });
});

test('dashboardTaskDisplayText hides inline tags from the widget subject line', () => {
  const make = (normalizedText: string, body = normalizedText): ParsedTask => ({ key: 'k', filePath: 'a.md', lineNumber: 1, normalizedText, body } as ParsedTask);
  assert.equal(dashboardTaskDisplayText(make('Buy milk #errand')), 'Buy milk');
  assert.equal(dashboardTaskDisplayText(make('Email #work/clientA the invoice')), 'Email the invoice');
  assert.equal(dashboardTaskDisplayText(make('No tags here')), 'No tags here');
  // Falls back to the raw text when a task is made up entirely of tags (never renders blank).
  assert.equal(dashboardTaskDisplayText(make('#a #b')), '#a #b');
  // Uses body when normalizedText is empty.
  assert.equal(dashboardTaskDisplayText(make('', 'Plan trip #travel')), 'Plan trip');
});

test('dashboardTaskDisplayText reduces inline Markdown to readable text', () => {
  const make = (normalizedText: string): ParsedTask => ({ key: 'k', filePath: 'a.md', lineNumber: 1, normalizedText, body: normalizedText } as ParsedTask);
  assert.equal(dashboardTaskDisplayText(make('**Thu** — **DIAGNOSTIC MOCK** in [[Mock Log]]')), 'Thu — DIAGNOSTIC MOCK in Mock Log');
  assert.equal(dashboardTaskDisplayText(make('Define roles in the [[#Pipeline Board]]')), 'Define roles in the Pipeline Board');
  assert.equal(dashboardTaskDisplayText(make('Read [the docs](https://x.test) and `npm run build`')), 'Read the docs and npm run build');
  assert.equal(dashboardTaskDisplayText(make('Alias link [[2026-06-16-Tuesday|Tuesday]] note')), 'Alias link Tuesday note');
});

test('stripDashboardInlineMarkdown is a pure text reducer', () => {
  assert.equal(stripDashboardInlineMarkdown('plain text'), 'plain text');
  assert.equal(stripDashboardInlineMarkdown('a ~~b~~ ==c=='), 'a b c');
  // Date-like slashes and non-emphasis asterisks are untouched (no pairs).
  assert.equal(stripDashboardInlineMarkdown('due 6/1/2026'), 'due 6/1/2026');
});

test('dashboardTaskDisplayText strips dangling slash-command fragments', () => {
  const make = (normalizedText: string): ParsedTask => ({ key: 'k', filePath: 'a.md', lineNumber: 1, normalizedText, body: normalizedText } as ParsedTask);
  assert.equal(dashboardTaskDisplayText(make('test /schedule')), 'test');
  assert.equal(dashboardTaskDisplayText(make('test 6/1/2026 /due')), 'test 6/1/2026');
  assert.equal(dashboardTaskDisplayText(make('Organize garage the first sunday /w')), 'Organize garage the first sunday');
  // A real date written with slashes is preserved (not a leading-space slash token).
  assert.equal(dashboardTaskDisplayText(make('Ship 6/1 release')), 'Ship 6/1 release');
  // A genuinely empty task never renders blank.
  assert.equal(dashboardTaskDisplayText(make('')), 'Untitled task');
});

test('dashboardProjectName ignores numeric tags so a note is not fragmented into fake projects', () => {
  const make = (over: Partial<ParsedTask> & { tags?: string[] }): ParsedTask => ({
    key: 'k', filePath: 'Study/Staff Engineer Study Plan.md', lineNumber: 1, normalizedText: 'x', body: 'x',
    tags: [], metadata: { dates: {}, priority: 'normal', dependsOn: [] }, ...over,
  } as unknown as ParsedTask);
  // Numeric tags (#2/#3 used as step markers) are skipped; the note name groups them as one project.
  assert.equal(dashboardProjectName(make({ tags: ['2'] })), 'Staff Engineer Study Plan');
  assert.equal(dashboardProjectName(make({ tags: ['3'] })), 'Staff Engineer Study Plan');
  // A descriptive tag still wins over the note name.
  assert.equal(dashboardProjectName(make({ tags: ['2', 'interview-prep'] })), '#interview-prep');
  // An explicit project beats everything; a section heading beats the note name.
  assert.equal(dashboardProjectName(make({ tags: ['2'], metadata: { dates: {}, priority: 'normal', dependsOn: [], project: 'Job Search' } as unknown as ParsedTask['metadata'] })), 'Job Search');
  assert.equal(dashboardProjectName(make({ tags: ['2'], heading: 'Week 1' })), 'Week 1');
});

test('dashboardWidgetAccentRole maps widgets to a meaningful, consistent palette', () => {
  // One hue per job: schedule/focus/progress/triage/capture.
  assert.equal(dashboardWidgetAccentRole('agenda'), 'schedule');
  assert.equal(dashboardWidgetAccentRole('needs-scheduling'), 'schedule');
  assert.equal(dashboardWidgetAccentRole('today'), 'focus');
  assert.equal(dashboardWidgetAccentRole('focus-queue'), 'focus');
  assert.equal(dashboardWidgetAccentRole('next-action-project'), 'focus');
  assert.equal(dashboardWidgetAccentRole('stats'), 'progress');
  assert.equal(dashboardWidgetAccentRole('momentum'), 'progress');
  assert.equal(dashboardWidgetAccentRole('inbox-triage'), 'triage');
  assert.equal(dashboardWidgetAccentRole('review-queue'), 'triage');
  assert.equal(dashboardWidgetAccentRole('quick-capture'), 'capture');
  // Alert widgets keep their own red → green state styling, so they take no categorical accent.
  assert.equal(dashboardWidgetAccentRole('overdue-risk'), null);
  assert.equal(dashboardWidgetAccentRole('blocked-waiting'), null);
});

test('formatDashboardCount adds thousands separators to integer counts', () => {
  assert.equal(formatDashboardCount(0), '0');
  assert.equal(formatDashboardCount(7), '7');
  assert.equal(formatDashboardCount(999), '999');
  assert.equal(formatDashboardCount(1000), (1000).toLocaleString());
  assert.equal(formatDashboardCount(12345), (12345).toLocaleString());
  // Rounds non-integers and tolerates non-finite input.
  assert.equal(formatDashboardCount(4.6), '5');
  assert.equal(formatDashboardCount(Number.NaN), 'NaN');
});

test('formatDashboardBadge only formats pure-integer badges', () => {
  // Pure counts get separators...
  assert.equal(formatDashboardBadge('1234'), (1234).toLocaleString());
  assert.equal(formatDashboardBadge('42'), '42');
  // ...but badges carrying units/punctuation are passed through untouched.
  assert.equal(formatDashboardBadge('87%'), '87%');
  assert.equal(formatDashboardBadge('2h 30m'), '2h 30m');
  assert.equal(formatDashboardBadge('3d'), '3d');
  assert.equal(formatDashboardBadge('3 · 1'), '3 · 1');
});

test('dashboardWeekOverWeekCount splits dates into trailing 7 days vs the prior 7', () => {
  const today = '2026-06-15';
  const dates = [
    '2026-06-15', '2026-06-14', '2026-06-09', // current window (today-6..today)
    '2026-06-08', '2026-06-02',               // previous window (today-13..today-7)
    '2026-06-01',                              // older than both windows -> ignored
    '2026-06-16',                              // future -> ignored
  ];
  const wow = dashboardWeekOverWeekCount(dates, today);
  assert.equal(wow.current, 3);
  assert.equal(wow.previous, 2);
  assert.equal(wow.diff, 1);
});

test('formatDashboardDelta renders arrow + tone, flipping for higher-is-worse metrics', () => {
  assert.deepEqual(formatDashboardDelta(0), { text: 'Same as last week', tone: 'neutral' });
  // Higher is better (default): a positive diff is an up/good trend.
  assert.equal(formatDashboardDelta(3).tone, 'up');
  assert.equal(formatDashboardDelta(3).text, '\u25b2 3 vs last week');
  assert.equal(formatDashboardDelta(-2).tone, 'down');
  assert.equal(formatDashboardDelta(-2).text, '\u25bc 2 vs last week');
  // Higher is worse (e.g. overdue): a positive diff becomes a down/bad trend.
  assert.equal(formatDashboardDelta(3, false).tone, 'down');
  assert.equal(formatDashboardDelta(-2, false).tone, 'up');
});

test('Dashboard date/hour formatting helpers', async (t) => {
  await t.test('dashboardShortDate renders a compact Mon D label', () => {
    assert.equal(dashboardShortDate('2026-05-01'), 'May 1');
    assert.equal(dashboardShortDate('2026-12-25'), 'Dec 25');
    assert.equal(dashboardShortDate('not-a-date'), 'not-a-date');
  });

  await t.test('dashboardFormatHour renders compact 12-hour labels', () => {
    assert.equal(dashboardFormatHour(0), '12a');
    assert.equal(dashboardFormatHour(9), '9a');
    assert.equal(dashboardFormatHour(12), '12p');
    assert.equal(dashboardFormatHour(15), '3p');
    assert.equal(dashboardFormatHour(23), '11p');
  });
});

test('Dashboard glance stats', async (t) => {
  const today = '2026-05-10';
  const tasks = [
    { key: 'done-today-planned', status: 'done', metadata: { priority: 'normal', dates: { due: '2026-05-10', done: '2026-05-10' } } },
    { key: 'open-today', status: 'todo', metadata: { priority: 'normal', dates: { due: '2026-05-10' } } },
    { key: 'done-not-today', status: 'done', metadata: { priority: 'normal', dates: { due: '2026-05-20', done: '2026-05-10' } } },
    { key: 'week-task', status: 'todo', metadata: { priority: 'normal', dates: { scheduled: '2026-05-12' } } },
    { key: 'overdue', status: 'todo', metadata: { priority: 'normal', dates: { due: '2026-05-09' } } },
  ] as ParsedTask[];

  await t.test('scopes the completion ring to planned work in the selected window', () => {
    const day = dashboardGlanceStats(tasks, today, 'today');
    assert.equal(day.plannedDone, 1);
    assert.equal(day.plannedTotal, 2);
    assert.equal(day.rate, 50);
    assert.equal(day.completedInWindow, 2, 'ad-hoc/non-today completions are visible but do not change the planned-work ring');
    assert.equal(day.activeInWindow, 1);
    assert.equal(day.dueInWindow, 1);
    assert.equal(day.overdue, 1);
  });

  await t.test('uses the dashboard week/month picker as the scope window', () => {
    const week = dashboardGlanceStats(tasks, today, 'week');
    assert.equal(week.start, '2026-05-10');
    assert.equal(week.end, '2026-05-16');
    assert.equal(week.plannedDone, 1);
    assert.equal(week.plannedTotal, 3);
    assert.equal(week.rate, 33);
    assert.equal(week.dueLabel, 'Due this week');

    const month = dashboardGlanceStats(tasks, today, 'month');
    assert.equal(month.plannedDone, 2);
    assert.equal(month.plannedTotal, 4);
    assert.equal(month.rate, 50);
    assert.equal(month.windowAdverb, 'this month');
  });
});

test('Dashboard momentum (gamification) stats', async (t) => {
  const today = '2026-05-10';
  const tasks = [
    { key: 'a', status: 'done', metadata: { priority: 'high', dates: { done: '2026-05-10' } } },
    { key: 'b', status: 'done', metadata: { priority: 'normal', dates: { done: '2026-05-09' } } },
    { key: 'c', status: 'done', metadata: { priority: 'normal', dates: { done: '2026-05-08' } } },
    { key: 'd', status: 'todo', metadata: { priority: 'normal', dates: {} } },
  ] as ParsedTask[];

  await t.test('computes streak, counts, and XP from the task set', () => {
    const stats = dashboardGamificationStats(tasks, today);
    assert.equal(stats.totalCompleted, 3);
    assert.equal(stats.streakDays, 3);
    assert.equal(stats.completedToday, 1);
    assert.equal(stats.weeklyCompleted, 3);
    assert.equal(stats.highPriorityCompleted, 1);
    assert.equal(stats.currentXP, 35); // 3*10 + 1*5
    assert.equal(stats.currentLevel, 1);
  });

  await t.test('breaks the streak on a missing day', () => {
    const gapped = [
      { key: 'a', status: 'done', metadata: { priority: 'normal', dates: { done: '2026-05-10' } } },
      { key: 'b', status: 'done', metadata: { priority: 'normal', dates: { done: '2026-05-08' } } },
    ] as ParsedTask[];
    assert.equal(dashboardGamificationStats(gapped, today).streakDays, 1);
  });
});

test('Dashboard weekly throughput buckets', async (t) => {
  const today = '2026-05-10';
  const dates = ['2026-05-10', '2026-05-09', '2026-05-04', '2026-05-03', '2026-04-28'];

  await t.test('buckets completion dates into rolling 7-day windows', () => {
    const weeks = dashboardWeeklyThroughput(dates, today, 2);
    assert.equal(weeks.length, 2);
    // oldest-first: 04-27..05-03 then 05-04..05-10
    assert.equal(weeks[0].start, '2026-04-27');
    assert.equal(weeks[0].end, '2026-05-03');
    assert.equal(weeks[0].count, 2);
    assert.equal(weeks[1].count, 3);
    assert.equal(weeks[1].label, 'May 10');
  });
});

test('Dashboard productivity score', async (t) => {
  const today = '2026-05-10';
  const tasks = [
    { key: 'on-time', status: 'done', metadata: { priority: 'normal', dates: { done: '2026-05-09', due: '2026-05-10' } } },
    { key: 'late', status: 'done', metadata: { priority: 'normal', dates: { done: '2026-05-08', due: '2026-05-05' } } },
    { key: 'no-due', status: 'done', metadata: { priority: 'normal', dates: { done: '2026-05-01' } } },
    { key: 'overdue', status: 'todo', metadata: { priority: 'normal', dates: { due: '2026-05-01' } } },
    { key: 'future', status: 'todo', metadata: { priority: 'normal', dates: { due: '2026-05-20' } } },
  ] as ParsedTask[];

  await t.test('blends completion rate (70%) and on-time rate (30%)', () => {
    const score = dashboardProductivityScore(tasks, today);
    assert.equal(score.completed, 3);
    assert.equal(score.overdue, 1);
    assert.equal(score.completionRate, 75); // 3 / (3 + 1)
    assert.equal(score.dueCompleted, 2);
    assert.equal(score.onTime, 1);
    assert.equal(score.onTimeRate, 50);
    assert.equal(score.score, 68); // round(75*0.7 + 50*0.3)
  });
});

test('Dashboard cycle time and aging WIP', async (t) => {
  const today = '2026-05-10';

  await t.test('averages lead and cycle time over the window', () => {
    const tasks = [
      { key: 'a', status: 'done', metadata: { priority: 'normal', dates: { done: '2026-05-10', created: '2026-05-01', start: '2026-05-08' } } },
      { key: 'b', status: 'done', metadata: { priority: 'normal', dates: { done: '2026-05-09', created: '2026-05-04' } } },
      { key: 'old', status: 'done', metadata: { priority: 'normal', dates: { done: '2026-01-01', created: '2025-12-01' } } },
      { key: 'no-created', status: 'done', metadata: { priority: 'normal', dates: { done: '2026-05-07' } } },
    ] as ParsedTask[];
    const stats = dashboardCycleTimeStats(tasks, today);
    assert.equal(stats.sampleSize, 2);
    assert.equal(stats.leadAvg, 7);   // (9 + 5) / 2
    assert.equal(stats.cycleAvg, 3.5); // (2 + 5) / 2
  });

  await t.test('ranks active work by age, oldest first', () => {
    const tasks = [
      { key: 'old', status: 'todo', normalizedText: 'old', body: 'old', metadata: { priority: 'normal', dates: { created: '2026-04-10' } } },
      { key: 'mid', status: 'in_progress', normalizedText: 'mid', body: 'mid', metadata: { priority: 'normal', dates: { start: '2026-05-01' } } },
      { key: 'fresh', status: 'in_progress', normalizedText: 'fresh', body: 'fresh', metadata: { priority: 'normal', dates: {} } },
      { key: 'done', status: 'done', normalizedText: 'done', body: 'done', metadata: { priority: 'normal', dates: { done: '2026-05-09' } } },
    ] as ParsedTask[];
    const aging = dashboardAgingWip(tasks, today);
    assert.equal(aging.length, 3);
    assert.equal(aging[0].task.key, 'old');
    assert.equal(aging[0].ageDays, 30);
    assert.equal(aging[1].task.key, 'mid');
    assert.equal(aging[1].ageDays, 9);
    assert.equal(aging[2].task.key, 'fresh');
    assert.equal(aging[2].ageDays, 0);
  });
});

test('Dashboard time-of-day matrix', async (t) => {
  const today = '2026-05-10';

  await t.test('builds a 7x24 matrix and finds the busiest cell', () => {
    const timestamps = [
      '2026-05-04T09:00:00',
      '2026-05-04T09:30:00',
      '2026-05-05T14:00:00',
      '2020-01-01T10:00:00', // outside the 8-week window
    ];
    const result = dashboardTimeOfDayMatrix(timestamps, today, 8);
    assert.equal(result.matrix.length, 7);
    assert.equal(result.matrix[0].length, 24);
    assert.equal(result.total, 3);
    assert.ok(result.peak);
    assert.equal(result.peak?.count, 2);
    assert.equal(DASHBOARD_WEEKDAY_LABELS.length, 7);
  });

  await t.test('returns an empty matrix when there is no data', () => {
    const result = dashboardTimeOfDayMatrix([], today, 8);
    assert.equal(result.total, 0);
    assert.equal(result.peak, null);
  });
});

test('Dashboard daily goal progress', async (t) => {
  const today = '2026-05-10';
  const tasks = [
    { key: 'a', status: 'done', metadata: { priority: 'normal', dates: { done: '2026-05-10' } } },
    { key: 'b', status: 'done', metadata: { priority: 'normal', dates: { done: '2026-05-10' } } },
    { key: 'c', status: 'done', metadata: { priority: 'normal', dates: { done: '2026-05-09' } } },
    { key: 'd', status: 'todo', metadata: { priority: 'normal', dates: {} } },
  ] as ParsedTask[];

  await t.test('reports progress toward an unmet goal', () => {
    const progress = dashboardDailyGoalProgress(tasks, today, 3);
    assert.equal(progress.completed, 2);
    assert.equal(progress.goal, 3);
    assert.equal(progress.pct, 67);
    assert.equal(progress.remaining, 1);
    assert.equal(progress.met, false);
  });

  await t.test('marks a met goal and floors invalid goals to 1', () => {
    assert.equal(dashboardDailyGoalProgress(tasks, today, 2).met, true);
    assert.equal(dashboardDailyGoalProgress(tasks, today, 0).goal, 1);
  });
});

test('Dashboard weekly review items', async (t) => {
  const today = '2026-05-10';

  await t.test('returns the expected ordered checklist', () => {
    const items = dashboardWeeklyReviewItems([], today);
    assert.deepEqual(items.map((item) => item.key), ['inbox', 'overdue', 'blocked', 'next-action', 'stale', 'celebrate']);
    // With no tasks, every actionable step is cleared and celebrate is always done.
    for (const item of items) {
      if (item.key === 'celebrate') assert.equal(item.done, true);
      else assert.equal(item.done, item.count === 0);
    }
  });

  await t.test('flags outstanding review work from live signals', () => {
    const tasks = [
      { key: 'inbox', status: 'todo', filePath: 'inbox.md', tags: [], contexts: [], metadata: { priority: 'normal', dates: {}, dependsOn: [] } },
      { key: 'overdue', status: 'todo', filePath: 'overdue.md', tags: [], contexts: [], metadata: { priority: 'normal', dates: { due: '2026-05-01' }, dependsOn: [] } },
    ] as unknown as ParsedTask[];
    const items = dashboardWeeklyReviewItems(tasks, today);
    const byKey = Object.fromEntries(items.map((item) => [item.key, item]));
    assert.equal(byKey.inbox.count, 1);
    assert.equal(byKey.inbox.done, false);
    assert.equal(byKey.overdue.count, 1);
    assert.equal(byKey.overdue.done, false);
  });

  await t.test('does not classify context-tagged no-date tasks as raw inbox captures', () => {
    const tasks = [
      { key: 'call', status: 'todo', filePath: 'calls.md', tags: [], contexts: ['phone'], metadata: { priority: 'normal', dates: {}, dependsOn: [] } },
    ] as unknown as ParsedTask[];
    const byKey = Object.fromEntries(dashboardWeeklyReviewItems(tasks, today).map((item) => [item.key, item]));
    assert.equal(byKey.inbox.count, 0);
    assert.equal(byKey.inbox.done, true);
  });
});

test('Additional dashboard widget helpers', async (t) => {
  await t.test('parses and formats clock times', () => {
    assert.equal(dashboardHmToMinutes('09:30'), 570);
    assert.equal(dashboardHmToMinutes('0:00'), 0);
    assert.equal(dashboardHmToMinutes('24:00'), null);
    assert.equal(dashboardHmToMinutes('nope'), null);
    assert.equal(dashboardHmToMinutes(undefined), null);
    assert.equal(dashboardFormatClock(570), '9:30a');
    assert.equal(dashboardFormatClock(0), '12:00a');
    assert.equal(dashboardFormatClock(13 * 60 + 5), '1:05p');
  });

  await t.test('resolves a task time range from timeStart/timeEnd or raw time', () => {
    const a = { key: 'a', status: 'todo', metadata: { dates: {}, timeStart: '09:00', timeEnd: '10:30' } } as unknown as ParsedTask;
    assert.deepEqual(dashboardTaskTimeRange(a), { start: 540, end: 630 });
    const b = { key: 'b', status: 'todo', metadata: { dates: {}, time: '14:00-15:00' } } as unknown as ParsedTask;
    assert.deepEqual(dashboardTaskTimeRange(b), { start: 840, end: 900 });
    const c = { key: 'c', status: 'todo', metadata: { dates: {}, timeStart: '08:00' } } as unknown as ParsedTask;
    assert.deepEqual(dashboardTaskTimeRange(c), { start: 480, end: 510 });
    const d = { key: 'd', status: 'todo', metadata: { dates: {} } } as unknown as ParsedTask;
    assert.equal(dashboardTaskTimeRange(d), null);
  });

  await t.test('builds today schedule and detects overlaps', () => {
    const tasks = [
      { key: 'timed', status: 'todo', normalizedText: 'Standup', tags: [], contexts: [], metadata: { dates: { scheduled: '2026-06-14' }, timeStart: '09:00', timeEnd: '09:30' } },
      { key: 'untimed', status: 'todo', normalizedText: 'Email', tags: [], contexts: [], metadata: { dates: { due: '2026-06-14' } } },
      { key: 'other-day', status: 'todo', normalizedText: 'Later', tags: [], contexts: [], metadata: { dates: { due: '2026-06-20' } } },
      { key: 'done', status: 'done', normalizedText: 'Done', tags: [], contexts: [], metadata: { dates: { due: '2026-06-14' }, timeStart: '09:10' } },
    ] as unknown as ParsedTask[];
    const events = [
      { summary: 'Sync', date: '2026-06-14', startTime: '09:15', endTime: '09:45', uid: '1' },
      { summary: 'All hands', date: '2026-06-14', startTime: undefined, endTime: undefined, uid: '2' },
    ];
    const schedule = dashboardScheduleForDay(tasks, '2026-06-14', events);
    assert.deepEqual(schedule.timed.map((e) => e.label), ['Standup', 'Sync']);
    assert.deepEqual(schedule.untimed.map((task) => task.key), ['untimed']);
    assert.deepEqual(schedule.allDayEvents, ['All hands']);
    const overlaps = dashboardScheduleOverlaps(schedule.timed);
    assert.equal(overlaps.length, 1); // Standup 9:00-9:30 overlaps Sync 9:15-9:45
  });

  await t.test('computes capacity series with overdue rolled into today', () => {
    const tasks = [
      { key: 'today', status: 'todo', metadata: { dates: { due: '2026-06-14' }, effort: '2h' } },
      { key: 'overdue', status: 'todo', metadata: { dates: { due: '2026-06-10' }, effort: '1h' } },
      { key: 'tomorrow', status: 'todo', metadata: { dates: { scheduled: '2026-06-15' }, effort: '5h' } },
    ] as unknown as ParsedTask[];
    const series = dashboardCapacitySeries(tasks, '2026-06-14', 180, 2);
    assert.equal(series[0].committed, 180); // 2h today + 1h overdue
    assert.equal(series[0].over, false);
    assert.equal(series[1].committed, 300); // 5h tomorrow
    assert.equal(series[1].over, true);
  });

  await t.test('reconstructs a burndown series from created/done dates', () => {
    const tasks = [
      { key: 'a', status: 'done', metadata: { dates: { created: '2026-06-01', done: '2026-06-13' } } },
      { key: 'b', status: 'todo', metadata: { dates: { created: '2026-06-01' } } },
      { key: 'c', status: 'todo', metadata: { dates: { created: '2026-06-14' } } },
    ] as unknown as ParsedTask[];
    const series = dashboardBurndownSeries(tasks, '2026-06-14', 3);
    // days: 06-12, 06-13, 06-14
    assert.deepEqual(series.map((p) => p.remaining), [2, 1, 2]);
    assert.equal(series[series.length - 1].label, 'Today');
  });

  await t.test('forecasts completion from weekly velocity', () => {
    const tasks = [
      { key: 'open1', status: 'todo', metadata: { dates: {} } },
      { key: 'open2', status: 'todo', metadata: { dates: {} } },
      { key: 'd1', status: 'done', metadata: { dates: { done: '2026-06-13' } } },
      { key: 'd2', status: 'done', metadata: { dates: { done: '2026-06-12' } } },
    ] as unknown as ParsedTask[];
    const forecast = dashboardCompletionForecast(tasks, '2026-06-14');
    assert.equal(forecast.backlog, 2);
    assert.ok(forecast.perWeek > 0);
    assert.ok(forecast.weeksToClear && forecast.weeksToClear >= 1);
    assert.ok(forecast.etaIso && forecast.etaIso > '2026-06-14');

    const noVelocity = dashboardCompletionForecast([{ key: 'x', status: 'todo', metadata: { dates: {} } }] as unknown as ParsedTask[], '2026-06-14');
    assert.equal(noVelocity.weeksToClear, null);
    assert.equal(noVelocity.etaIso, null);
  });

  await t.test('builds a cumulative flow with monotonic totals', () => {
    const tasks = [
      { key: 'a', status: 'done', metadata: { dates: { created: '2026-05-01', done: '2026-06-10' } } },
      { key: 'b', status: 'todo', metadata: { dates: { created: '2026-05-20' } } },
      { key: 'c', status: 'todo', metadata: { dates: { created: '2026-06-14' } } },
    ] as unknown as ParsedTask[];
    const weeks = dashboardCumulativeFlow(tasks, '2026-06-14', [], 4);
    const created = weeks.map((w) => w.created);
    const done = weeks.map((w) => w.done);
    for (let i = 1; i < created.length; i += 1) assert.ok(created[i] >= created[i - 1]);
    for (let i = 1; i < done.length; i += 1) assert.ok(done[i] >= done[i - 1]);
    const last = weeks[weeks.length - 1];
    assert.equal(last.created, 3);
    assert.equal(last.done, 1);
    assert.equal(last.open, 2);
  });

  await t.test('summarizes estimate variance bias', () => {
    const tasks = [
      { key: 'over', status: 'done', normalizedText: 'Over', metadata: { dates: {}, effort: '1h', actual: '2h' } },
      { key: 'under', status: 'done', normalizedText: 'Under', metadata: { dates: {}, effort: '2h', actual: '1h' } },
      { key: 'no-actual', status: 'done', normalizedText: 'NoActual', metadata: { dates: {}, effort: '1h' } },
    ] as unknown as ParsedTask[];
    const variance = dashboardEstimateVariance(tasks);
    assert.equal(variance.sampleSize, 2);
    assert.equal(variance.overCount, 1);
    assert.equal(variance.underCount, 1);
    assert.equal(variance.estTotal, 180);
    assert.equal(variance.actualTotal, 180);
    assert.equal(variance.biasPct, 0);
    assert.equal(variance.worst.length, 2);
  });

  await t.test('rolls tasks up to goals via tags and field', () => {
    const tasks = [
      { key: 'g1', status: 'done', tags: ['goal/launch'], contexts: [], metadata: { dates: {} } },
      { key: 'g2', status: 'todo', tags: ['goal/launch'], contexts: [], metadata: { dates: { due: '2026-06-10' } } },
      { key: 'g3', status: 'todo', tags: [], contexts: [], metadata: { dates: {}, customFields: { goal: 'Health' } } },
    ] as unknown as ParsedTask[];
    const rows = dashboardGoalRows(tasks, '2026-06-14');
    const launch = rows.find((r) => r.label === 'launch');
    assert.ok(launch);
    assert.equal(launch.total, 2);
    assert.equal(launch.done, 1);
    assert.equal(launch.pct, 50);
    assert.equal(launch.overdue, true); // target 2026-06-10 < today and incomplete
    assert.ok(rows.find((r) => r.label === 'Health'));

    // configurable tag prefix: “objective” instead of the default “goal”
    const objTasks = [
      { key: 'o1', status: 'todo', tags: ['objective/q3'], contexts: [], metadata: { dates: {} } },
      { key: 'o2', status: 'done', tags: ['objective/q3'], contexts: [], metadata: { dates: {} } },
      { key: 'g', status: 'todo', tags: ['goal/ignored'], contexts: [], metadata: { dates: {} } },
    ] as unknown as ParsedTask[];
    const objRows = dashboardGoalRows(objTasks, '2026-06-14', 'goal', 'objective');
    assert.deepEqual(objRows.map((r) => r.label), ['q3']);
    assert.equal(objRows[0].total, 2);
  });

  await t.test('groups areas by area tag or top-level folder', () => {
    const tasks = [
      { key: 'a', status: 'todo', tags: ['area/work'], contexts: [], filePath: 'Notes/a.md', metadata: { dates: {} } },
      { key: 'b', status: 'todo', tags: [], contexts: [], filePath: 'Work/b.md', metadata: { dates: { due: '2026-06-01' } } },
      { key: 'c', status: 'done', tags: [], contexts: [], filePath: 'Work/c.md', metadata: { dates: {} } },
    ] as unknown as ParsedTask[];
    const rows = dashboardAreaRows(tasks, '2026-06-14');
    const work = rows.find((r) => r.label === 'work');
    const workFolder = rows.find((r) => r.label === 'Work');
    assert.ok(work && work.active === 1);
    assert.ok(workFolder && workFolder.active === 1 && workFolder.overdue === 1 && workFolder.total === 2);

    // configurable tag prefix: “domain” instead of the default “area”
    const domainTasks = [
      { key: 'd', status: 'todo', tags: ['domain/finance'], contexts: [], filePath: 'Notes/d.md', metadata: { dates: {} } },
    ] as unknown as ParsedTask[];
    const domainRows = dashboardAreaRows(domainTasks, '2026-06-14', 'domain');
    assert.ok(domainRows.find((r) => r.label === 'finance'));
  });

  await t.test('computes subtask progress from parentId links', () => {
    const tasks = [
      { key: 'p', status: 'todo', normalizedText: 'Parent', metadata: { dates: {}, id: 'P1' } },
      { key: 'c1', status: 'done', normalizedText: 'Child 1', metadata: { dates: {}, parentId: 'P1' } },
      { key: 'c2', status: 'todo', normalizedText: 'Child 2', metadata: { dates: {}, parentId: 'P1' } },
      { key: 'orphan', status: 'todo', normalizedText: 'Orphan child', metadata: { dates: {}, parentId: 'MISSING' } },
    ] as unknown as ParsedTask[];
    const rows = dashboardSubtaskRows(tasks);
    const parent = rows.find((r) => r.label === 'Parent');
    assert.ok(parent);
    assert.equal(parent.total, 2);
    assert.equal(parent.done, 1);
    assert.equal(parent.pct, 50);
    const orphanRow = rows.find((r) => r.label === 'MISSING');
    assert.ok(orphanRow && orphanRow.total === 1);
  });

  await t.test('finds completions on this day in prior years', () => {
    const tasks = [
      { key: 'past', status: 'done', normalizedText: 'Old win', metadata: { dates: { done: '2024-06-14' } } },
      { key: 'thisyear', status: 'done', normalizedText: 'New', metadata: { dates: { done: '2026-06-14' } } },
      { key: 'otherday', status: 'done', normalizedText: 'Other', metadata: { dates: { done: '2024-06-13' } } },
    ] as unknown as ParsedTask[];
    const rows = dashboardOnThisDay(tasks, '2026-06-14');
    assert.deepEqual(rows.map((task) => task.key), ['past']);
  });

  await t.test('flags goal-met days and supports streaks', () => {
    const tasks = [
      { key: 'a', status: 'done', metadata: { dates: { done: '2026-06-14' } } },
      { key: 'b', status: 'done', metadata: { dates: { done: '2026-06-14' } } },
      { key: 'c', status: 'done', metadata: { dates: { done: '2026-06-13' } } },
    ] as unknown as ParsedTask[];
    const days = dashboardGoalStreakDays(tasks, '2026-06-14', 2, 3);
    assert.equal(days.length, 3);
    assert.equal(days[days.length - 1].met, true); // 2 completed >= goal 2
    assert.equal(days[days.length - 2].met, false); // 1 completed < goal 2
  });

  await t.test('produces a daily shutdown checklist', () => {
    const tasks = [
      { key: 'overdue', status: 'todo', tags: [], contexts: [], metadata: { priority: 'normal', dates: { due: '2026-06-01' } } },
      { key: 'tomorrow', status: 'todo', tags: [], contexts: [], metadata: { priority: 'normal', dates: { scheduled: '2026-06-15' } } },
      { key: 'donetoday', status: 'done', tags: [], contexts: [], metadata: { priority: 'normal', dates: { done: '2026-06-14' } } },
    ] as unknown as ParsedTask[];
    const items = dashboardShutdownItems(tasks, '2026-06-14');
    const byKey = Object.fromEntries(items.map((item) => [item.key, item]));
    assert.equal(byKey.overdue.count, 1);
    assert.equal(byKey.overdue.done, false);
    assert.equal(byKey.tomorrow.done, true); // has a plan for tomorrow
    assert.equal(byKey.celebrate.count, 1);
  });
});

// ── Project chip resolution (dashboardRowProject) ────────────────────────────
test('dashboardRowProject prefers an explicit project field', () => {
  const task = { metadata: { project: 'Website', dates: {}, dependsOn: [] }, tags: ['work'], heading: 'Section' } as unknown as ParsedTask;
  assert.deepEqual(dashboardRowProject(task), { label: 'Website' });
});

test('dashboardRowProject falls back to the first descriptive tag (and exposes it for dedupe)', () => {
  const task = { metadata: { dates: {}, dependsOn: [] }, tags: ['2', 'platform'], heading: 'Section' } as unknown as ParsedTask;
  assert.deepEqual(dashboardRowProject(task), { label: '#platform', tag: 'platform' });
});

test('dashboardRowProject uses the heading when there is no project or descriptive tag', () => {
  const task = { metadata: { dates: {}, dependsOn: [] }, tags: ['3'], heading: 'Launch plan' } as unknown as ParsedTask;
  assert.deepEqual(dashboardRowProject(task), { label: 'Launch plan' });
});

test('dashboardRowProject returns undefined when only the note-name fallback applies', () => {
  const task = { metadata: { dates: {}, dependsOn: [] }, tags: [], filePath: 'Inbox.md' } as unknown as ParsedTask;
  assert.equal(dashboardRowProject(task), undefined);
});

// ── Relationship graph (dashboardRelationshipIndex / dashboardTaskRelations) ──
test('dashboardTaskRelations reports the active tasks a task unblocks', () => {
  const tasks = [
    { key: 'b', status: 'todo', metadata: { id: 'b', dependsOn: [], dates: {} }, tags: [] },
    { key: 'a', status: 'todo', metadata: { dependsOn: ['b'], dates: {} }, tags: [] },
    { key: 'c', status: 'in_progress', metadata: { dependsOn: ['b'], dates: {} }, tags: [] },
    { key: 'done', status: 'done', metadata: { dependsOn: ['b'], dates: {} }, tags: [] },
  ] as unknown as ParsedTask[];
  const index = dashboardRelationshipIndex(tasks);
  const rel = dashboardTaskRelations(tasks[0], index);
  assert.deepEqual(rel.unblocks.map((t) => t.key), ['a', 'c'], 'done dependents are excluded');
  assert.deepEqual(rel.waitingOn, []);
});

test('dashboardTaskRelations resolves a task\u2019s own blockers and ignores unknown ids', () => {
  const tasks = [
    { key: 'b', status: 'todo', metadata: { id: 'b', dependsOn: [], dates: {} }, tags: [] },
    { key: 'a', status: 'todo', metadata: { dependsOn: ['b', 'ghost'], dates: {} }, tags: [] },
  ] as unknown as ParsedTask[];
  const index = dashboardRelationshipIndex(tasks);
  const rel = dashboardTaskRelations(tasks[1], index);
  assert.deepEqual(rel.waitingOn.map((t) => t.key), ['b'], 'only resolvable blockers are listed');
  assert.deepEqual(rel.unblocks, []);
});

test('dashboardRelationshipIndex memoises per task-array reference', () => {
  const tasks = [{ key: 'b', status: 'todo', metadata: { id: 'b', dependsOn: [], dates: {} }, tags: [] }] as unknown as ParsedTask[];
  assert.equal(dashboardRelationshipIndex(tasks), dashboardRelationshipIndex(tasks));
});

test('dashboard historical key maps omit duplicate explicit IDs independent of task order', () => {
  const first = { key: 'id:duplicate', stableKey: 'id:duplicate', normalizedText: 'First', filePath: 'A.md', lineNumber: 1, status: 'todo', metadata: { id: 'duplicate', dependsOn: [], dates: {} }, tags: [] } as unknown as ParsedTask;
  const second = { key: 'id:duplicate', stableKey: 'id:duplicate', normalizedText: 'Second', filePath: 'B.md', lineNumber: 2, status: 'todo', metadata: { id: 'duplicate', dependsOn: [], dates: {} }, tags: [] } as unknown as ParsedTask;
  for (const tasks of [[first, second], [second, first]]) {
    assert.equal(dashboardUniqueTaskKeyMap(tasks).has('id:duplicate'), false);
  }
});

test('dashboard relationship maps omit ambiguous IDs independent of task order', () => {
  const duplicateA = { key: 'id:shared', filePath: 'A.md', lineNumber: 1, status: 'todo', metadata: { id: 'shared', dependsOn: [], dates: {} }, tags: [] } as unknown as ParsedTask;
  const duplicateB = { key: 'id:shared', filePath: 'B.md', lineNumber: 1, status: 'todo', metadata: { id: 'shared', dependsOn: [], dates: {} }, tags: [] } as unknown as ParsedTask;
  const dependent = { key: 'dependent', filePath: 'C.md', lineNumber: 1, status: 'todo', metadata: { dependsOn: ['shared'], dates: {} }, tags: [] } as unknown as ParsedTask;
  for (const tasks of [[duplicateA, duplicateB, dependent], [dependent, duplicateB, duplicateA]]) {
    const index = dashboardRelationshipIndex(tasks);
    assert.equal(index.byId.has('shared'), false);
    assert.equal(index.ambiguousIds.has('shared'), true);
    assert.equal(index.dependents.has('shared'), false);
    assert.deepEqual(dashboardTaskRelations(dependent, index).waitingOn, []);
  }
});
