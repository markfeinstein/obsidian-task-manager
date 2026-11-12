import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DASHBOARD_GRID_COLUMNS,
  clampGridPlacement,
  compactGridPlacements,
  ensureGridPlacements,
  gridPlacementsOverlap,
  reorderDashboardWidgets,
  responsiveColumnCount,
} from '../src/dashboard-layout';
import type { DashboardWidgetConfig } from '../src/types';

test('dashboard layout service repairs placements without a live view', () => {
  const widgets: DashboardWidgetConfig[] = [
    { type: 'today', title: 'Today', size: 'medium', grid: { x: -5, y: 0, w: 20, h: 10 } },
    { type: 'stats', title: 'Summary', size: 'small', grid: { x: 0, y: 0, w: 20, h: 10 } },
  ];

  ensureGridPlacements(widgets);

  const firstGrid = widgets[0].grid;
  const secondGrid = widgets[1].grid;
  assert.ok(firstGrid);
  assert.ok(secondGrid);
  assert.equal(gridPlacementsOverlap(firstGrid, secondGrid), false);
  assert.deepEqual(clampGridPlacement({ x: -10, y: -2, w: 500, h: 0 }), {
    x: 0,
    y: 0,
    w: DASHBOARD_GRID_COLUMNS,
    h: 2,
  });
});

test('dashboard layout service keeps deterministic reading order and responsive bounds', () => {
  const compacted = compactGridPlacements([
    { x: 24, y: 20, w: 24, h: 8 },
    { x: 0, y: 0, w: 24, h: 8 },
  ]);

  assert.deepEqual(reorderDashboardWidgets(['a', 'b', 'c'], 2, 0), ['c', 'a', 'b']);
  assert.equal(compacted[1].y, 0);
  assert.ok(responsiveColumnCount(360) < DASHBOARD_GRID_COLUMNS);
});
