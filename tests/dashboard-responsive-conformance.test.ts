import test from 'node:test';
import assert from 'node:assert/strict';
import { DASHBOARD_GRID_COLUMNS, responsiveColumnCount } from '../src/dashboard-layout';

test('responsive fine-grid tracks leave positive content width after spacious gutters', () => {
  // Real 900px desktop viewport: 817px grid, 96 tracks and 95 * 10px gaps overflowed by 133px.
  for (const width of [180, 260, 380, 520, 699, 700, 760, 817, 950, 999, 1000, 1200]) {
    const columns = responsiveColumnCount(width);
    for (const gap of [4, 8, 10]) assert.ok((columns - 1) * gap < width, `${columns} columns at ${width}px cannot fit ${gap}px gutters`);
  }
  assert.equal(responsiveColumnCount(817), DASHBOARD_GRID_COLUMNS / 2);
  assert.equal(responsiveColumnCount(1200), DASHBOARD_GRID_COLUMNS);
});
