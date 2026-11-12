import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  DASHBOARD_WIDGET_REGISTRATION_ORDER,
  DASHBOARD_WIDGET_TYPE_ALIASES,
  resolveDashboardWidgetType,
} from '../src/dashboard-registry';
import {
  DASHBOARD_TEMPLATE_REVISION,
  dashboardWidgetsSignature,
  migrateDashboardLayout,
} from '../src/dashboard-model';
import {
  DASHBOARD_BUILTIN_TEMPLATES,
  createDashboardLayoutFromTemplate,
  dashboardIdFromName,
  exportDashboardCollection,
  exportDashboardLayout,
  parseDashboardImportPayload,
  uniqueDashboardId,
} from '../src/dashboard-persistence';

test('dashboard registry model preserves all renderer registrations in stable order', () => {
  const source = readFileSync('src/dashboard.ts', 'utf8');
  const runtimeOrder = Array.from(source.matchAll(/registry\.register\('([^']+)'/gu), (match) => match[1]);
  assert.equal(DASHBOARD_WIDGET_REGISTRATION_ORDER.length, 86);
  assert.equal(new Set(DASHBOARD_WIDGET_REGISTRATION_ORDER).size, 86);
  assert.deepEqual(runtimeOrder, DASHBOARD_WIDGET_REGISTRATION_ORDER);
});

test('dashboard registry preserves legacy aliases without admitting unknown types', () => {
  assert.equal(DASHBOARD_WIDGET_TYPE_ALIASES['daily-task'], 'daily-todos');
  assert.equal(resolveDashboardWidgetType('quick-actions'), 'quick-capture');
  assert.equal(resolveDashboardWidgetType('today'), 'today');
  assert.equal(resolveDashboardWidgetType('not-a-widget'), null);
});

test('dashboard persistence round trips layouts and collections through extracted codecs', () => {
  const now = Date.UTC(2026, 6, 12, 12);
  const layout = createDashboardLayoutFromTemplate('default', now);
  assert.equal(layout.templateRevision, DASHBOARD_TEMPLATE_REVISION);
  assert.equal(layout.templateSignature, dashboardWidgetsSignature(layout.widgets));

  const parsedLayout = parseDashboardImportPayload(exportDashboardLayout(layout), [], []);
  assert.deepEqual(parsedLayout.warnings, []);
  assert.equal(parsedLayout.layouts.length, 1);
  assert.deepEqual(parsedLayout.layouts[0]?.widgets, layout.widgets);

  const parsedCollection = parseDashboardImportPayload(
    exportDashboardCollection([layout]),
    [],
    [],
  );
  assert.deepEqual(parsedCollection.warnings, []);
  assert.deepEqual(parsedCollection.layouts[0]?.widgets, layout.widgets);
});

test('dashboard templates and deterministic identifiers retain their serialized contracts', () => {
  assert.deepEqual(
    DASHBOARD_BUILTIN_TEMPLATES.map((template) => template.id),
    ['default', 'focus', 'planning', 'review', 'analytics', 'project', 'team'],
  );
  assert.equal(dashboardIdFromName('  Project Alpha / Launch  '), 'project-alpha-launch');
  assert.equal(uniqueDashboardId('Project Alpha', ['project-alpha', 'project-alpha-2']), 'project-alpha-3');

  const migrated = migrateDashboardLayout({
    id: 'legacy',
    name: 'Legacy',
    widgets: [{ type: 'quick-actions' as never, title: 'Quick actions', size: 'small', collapsed: false }],
    createdAt: 1,
    updatedAt: 1,
  });
  assert.equal(migrated.widgets[0]?.type, 'quick-capture');
});
