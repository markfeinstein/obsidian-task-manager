import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS, defaultAiEndpointForProvider, normalizeTaskManagerSettings } from '../src/types';

test('normalizeTaskManagerSettings preserves nested table view config safely', () => {
  const savedFilters = [
    { name: 'Focus', search: 'alpha', statuses: ['todo'], priorities: ['high'], tags: ['work'], sortKey: 'priority', sortDirection: 'desc' as const, showHierarchy: true, visibleColumns: ['status', 'due'] },
    { name: 'focus', search: 'duplicate', statuses: [], priorities: [], tags: [], sortKey: 'due', sortDirection: 'asc' as const, showHierarchy: false, visibleColumns: [] },
    ...Array.from({ length: 13 }, (_value, index) => ({
      name: `Filter ${index + 1}`,
      search: `query ${index + 1}`,
      statuses: [],
      priorities: [],
      tags: [],
      sortKey: 'due',
      sortDirection: 'asc' as const,
      showHierarchy: false,
      visibleColumns: [],
    })),
  ];

  const settings = normalizeTaskManagerSettings({
    tableViewConfig: {
      ...DEFAULT_SETTINGS.tableViewConfig,
      savedFilters,
      customColumns: [
        { key: ' Client Name ', label: 'Client', type: 'text', color: '#00ff00', required: true },
        { key: 'client-name', label: 'Duplicate', type: 'number' },
      ],
      visibleColumns: ['status', ' status ', 'client-name'],
    },
  });

  assert.equal(settings.tableViewConfig.savedFilters.length, 12);
  assert.deepEqual(settings.tableViewConfig.savedFilters.map((filter) => filter.name).slice(0, 3), ['Focus', 'Filter 1', 'Filter 2']);
  assert.deepEqual(settings.tableViewConfig.customColumns, [
    { key: 'client-name', label: 'Client', type: 'text', color: '#00ff00', required: true },
  ]);
  assert.deepEqual(settings.tableViewConfig.visibleColumns, ['status', 'client-name']);
});

test('normalizeTaskManagerSettings migrates and removes the redundant legacy scripting gate', () => {
  const migrated = normalizeTaskManagerSettings({ enableScripting: true } as never);
  const explicit = normalizeTaskManagerSettings({ enableScripting: true, enableDslExpressions: false } as never);

  assert.equal(migrated.enableDslExpressions, true);
  assert.equal(explicit.enableDslExpressions, false);
  assert.equal('enableScripting' in migrated, false);
});

test('normalizeTaskManagerSettings requires an explicit boolean for private CalDAV trust', () => {
  assert.equal(normalizeTaskManagerSettings({}).caldavAllowPrivateNetwork, false);
  assert.equal(normalizeTaskManagerSettings({ caldavAllowPrivateNetwork: true }).caldavAllowPrivateNetwork, true);
  assert.equal(normalizeTaskManagerSettings({ caldavAllowPrivateNetwork: false }).caldavAllowPrivateNetwork, false);
  const malformed = { caldavAllowPrivateNetwork: 'yes' } as unknown as Parameters<typeof normalizeTaskManagerSettings>[0];
  assert.equal(normalizeTaskManagerSettings(malformed).caldavAllowPrivateNetwork, false);
});

test('normalizeTaskManagerSettings derives shared saved view presets from legacy table and kanban settings', () => {
  const settings = normalizeTaskManagerSettings({
    tableViewConfig: {
      ...DEFAULT_SETTINGS.tableViewConfig,
      savedFilters: [
        { name: 'Focus', search: 'alpha', statuses: [], priorities: [], tags: [], sortKey: 'due', sortDirection: 'asc', showHierarchy: true, visibleColumns: [] },
      ],
      customColumns: [],
      showHierarchy: true,
      visibleColumns: [],
    },
    kanbanBoards: [
      { id: 'board-1', name: 'Sprint', query: 'not done', groupBy: 'status', columns: [], background: '' },
    ],
  });

  assert.deepEqual(settings.savedViewPresets?.map((preset) => ({ id: preset.id, kind: preset.kind, view: preset.view, name: preset.name })), [
    { id: 'table-filter-1', kind: 'table-filter', view: 'table', name: 'Focus' },
    { id: 'board-1-preset', kind: 'kanban-board', view: 'kanban', name: 'Sprint' },
  ]);
});

test('normalizeTaskManagerSettings preserves explicit shared saved view presets', () => {
  const settings = normalizeTaskManagerSettings({
    savedViewPresets: [
      { id: '  custom-presets ', kind: 'kanban-board', view: 'kanban', name: ' Board ' },
      { id: 'duplicate', kind: 'table-filter', view: 'table', name: 'Board' },
    ],
  } as never);

  assert.equal(settings.savedViewPresets?.length, 2);
  assert.equal(settings.savedViewPresets?.[0].id, 'custom-presets');
  assert.equal(settings.savedViewPresets?.[0].name, 'Board');
});

test('normalizeTaskManagerSettings preserves canonical sync timestamp over legacy typo', () => {
  const canonical = normalizeTaskManagerSettings({
    syncLastSuccessMsToDo: ' 2026-06-13T10:00:00Z ',
    syncLastSuccessMsToD: ' 2026-01-01T00:00:00Z ',
  } as Partial<typeof DEFAULT_SETTINGS> & Record<string, unknown>);
  const legacyOnly = normalizeTaskManagerSettings({
    syncLastSuccessMsToD: ' 2026-01-01T00:00:00Z ',
  } as Partial<typeof DEFAULT_SETTINGS> & Record<string, unknown>);

  assert.equal(canonical.syncLastSuccessMsToDo, '2026-06-13T10:00:00Z');
  assert.equal(legacyOnly.syncLastSuccessMsToDo, '2026-01-01T00:00:00Z');
});

test('normalizeTaskManagerSettings falls back from unsafe local AI endpoints', () => {
  const settings = normalizeTaskManagerSettings({
    aiQueryProvider: 'ollama',
    aiQueryLocalEndpoint: 'https://example.com/v1/chat/completions',
  });

  assert.equal(settings.aiQueryLocalEndpoint, defaultAiEndpointForProvider('ollama'));
});

test('normalizeTaskManagerSettings preserves sync run history in a bounded, sanitized form', () => {
  const settings = normalizeTaskManagerSettings({
    syncRunHistory: [
      { service: ' Google Tasks ', startedAt: ' 2026-06-13T10:00:00Z ', endedAt: ' 2026-06-13T10:05:00Z ', outcome: 'success', details: ' ok ', imported: 3 },
      { service: 'Bad', startedAt: 123, endedAt: null, outcome: 'unexpected', details: 4 },
      ...Array.from({ length: 25 }, (_value, index) => ({ service: `S${index}`, startedAt: 'a', endedAt: 'b', outcome: 'failed', details: `${index}` })),
    ],
  } as Partial<typeof DEFAULT_SETTINGS> & Record<string, unknown>);

  assert.equal(settings.syncRunHistory.length, 20);
  assert.deepEqual(settings.syncRunHistory[0], {
    service: 'Google Tasks',
    startedAt: '2026-06-13T10:00:00Z',
    endedAt: '2026-06-13T10:05:00Z',
    outcome: 'success',
    details: 'ok',
    imported: 3,
  });
  assert.equal(settings.syncRunHistory[1].outcome, 'success');
});

test('normalizeTaskManagerSettings rejects multiline archive and collect headings', () => {
  const settings = normalizeTaskManagerSettings({ archiveHeading: 'Archive\nInjected', collectHeading: 'Collect\rInjected' });
  assert.equal(settings.archiveHeading, DEFAULT_SETTINGS.archiveHeading);
  assert.equal(settings.collectHeading, DEFAULT_SETTINGS.collectHeading);
});

test('normalizeTaskManagerSettings keeps completion logging explicit and default-off', () => {
  assert.equal(normalizeTaskManagerSettings({}).completionLoggingEnabled, false);
  assert.equal(normalizeTaskManagerSettings({ completionLoggingEnabled: true }).completionLoggingEnabled, true);
  assert.equal(normalizeTaskManagerSettings({ completionLoggingEnabled: false }).completionLoggingEnabled, false);
  assert.equal(normalizeTaskManagerSettings({ completionLoggingEnabled: 'true' } as never).completionLoggingEnabled, false);
  assert.equal(normalizeTaskManagerSettings({ completionLoggingEnabled: 1 } as never).completionLoggingEnabled, false);
});

test('normalizeTaskManagerSettings defaults onboarding to unseen and accepts only non-negative integers', () => {
  assert.equal(normalizeTaskManagerSettings({}).onboardingVersionSeen, 0);
  assert.equal(normalizeTaskManagerSettings({ onboardingVersionSeen: 1 }).onboardingVersionSeen, 1);
  assert.equal(normalizeTaskManagerSettings({ onboardingVersionSeen: -1 }).onboardingVersionSeen, 0);
  assert.equal(normalizeTaskManagerSettings({ onboardingVersionSeen: 1.5 }).onboardingVersionSeen, 0);
  assert.equal(normalizeTaskManagerSettings({ onboardingVersionSeen: '1' } as never).onboardingVersionSeen, 0);
});
