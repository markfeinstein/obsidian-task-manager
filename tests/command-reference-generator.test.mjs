import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  commandIdsForSettings,
  generateCommandReference,
  loadCommandReference,
  parseCommandDocumentation,
  scanCommandSource,
  validateCommandContract,
} from '../scripts/generate-command-reference.mjs';

const row = (id, name, extra = '') => `{ id: '${id}', name: '${name}', lane: 'Core tasks', availability: { kind: 'always' }, context: 'Any Obsidian context', runtimeGuards: [], effect: 'read-only', prerequisites: [] ${extra} }`;

function fixtureMetadata(rows, families = "[{ family: 'status-change' }]") {
  return `const STATIC_COMMAND_DOCUMENTATION = [${rows.join(',')} ] as const; const DYNAMIC_COMMAND_FAMILIES = ${families} as const;`;
}

test('command reference consumes the complete declarative registration contract', () => {
  const { metadata, dynamicFamilies } = loadCommandReference();
  assert.equal(metadata.length, 81);
  assert.equal(new Set(metadata.map((entry) => entry.id)).size, metadata.length);
  assert.deepEqual(dynamicFamilies.map((entry) => entry.family), ['status-change']);
  assert.equal(generateCommandReference(), readFileSync('docs/COMMANDS.md', 'utf8'));
});

test('metadata parser and contract reject duplicates, stale records, and raw registration', () => {
  assert.throws(() => parseCommandDocumentation(fixtureMetadata([row('same', 'One'), row('same', 'Two')])), /Duplicate command documentation ID/u);
  const parsed = parseCommandDocumentation(fixtureMetadata([row('one', 'One')]));
  const raw = scanCommandSource("host.addCommand({ id: 'one', name: 'One', callback() {} });", 'fixture.ts');
  assert.throws(() => validateCommandContract(parsed.metadata, parsed.dynamicFamilies, raw), /Undocumented raw static command/u);
  const absent = scanCommandSource('', 'fixture.ts');
  assert.throws(() => validateCommandContract(parsed.metadata, parsed.dynamicFamilies, absent), /Stale command metadata/u);
});

test('fixtures distinguish feature absence, visible refusal, editor context, and dynamic families', () => {
  const source = `
    addDocumentedCommand(host, { id: 'gated', name: 'Gated', callback() {} });
    addDocumentedCommand(host, { id: 'refuses', name: 'Refuses', callback() {} });
    addDocumentedCommand(host, { id: 'editor', name: 'Editor', editorCallback() {} });
    addDocumentedDynamicCommand(host, 'status-change', { id: \`change-status-to-\${state}\`, name: 'Dynamic', editorCallback() {} });
  `;
  const metadataSource = fixtureMetadata([
    `{ id: 'gated', name: 'Gated', lane: 'Integrations', availability: { kind: 'feature-gated', setting: 'enabled' }, context: 'Any Obsidian context', runtimeGuards: [], effect: 'network-read', prerequisites: ['Enable it'] }`,
    `{ id: 'refuses', name: 'Refuses', lane: 'Integrations', availability: { kind: 'always' }, context: 'Any Obsidian context', runtimeGuards: ['Visible but refuses without credentials'], effect: 'network-read', prerequisites: ['Credentials'] }`,
    `{ id: 'editor', name: 'Editor', lane: 'Core tasks', availability: { kind: 'always' }, context: 'Active Markdown editor', runtimeGuards: ['Active task'], effect: 'vault-write', prerequisites: [] }`,
  ]);
  const parsed = parseCommandDocumentation(metadataSource);
  const scan = scanCommandSource(source, 'fixture.ts');
  validateCommandContract(parsed.metadata, parsed.dynamicFamilies, scan);
  assert.deepEqual(commandIdsForSettings(parsed.metadata, { enabled: false }), ['refuses', 'editor']);
  assert.deepEqual(commandIdsForSettings(parsed.metadata, { enabled: true }), ['gated', 'refuses', 'editor']);
  assert.match(parsed.metadata.find((entry) => entry.id === 'refuses').runtimeGuards[0], /refuses/u);
  assert.equal(parsed.metadata.find((entry) => entry.id === 'editor').context, 'Active Markdown editor');
  assert.deepEqual(scan.dynamicFamilies, ['status-change']);
});

test('critical guards are explicit rather than inferred from IDs', () => {
  const { metadata } = loadCommandReference();
  const byId = new Map(metadata.map((entry) => [entry.id, entry]));
  for (const [id, setting] of [
    ['sync-google-calendar', 'googleCalendarEnabled'],
    ['ai-task-search', 'aiQueryEnabled'],
    ['start-weekly-review', 'weeklyReviewEnabled'],
    ['sync-apple-reminders', 'appleRemindersEnabled'],
    ['import-apple-reminders-json', 'appleRemindersEnabled'],
    ['sync-caldav', 'caldavSyncEnabled'],
  ]) {
    assert.deepEqual(byId.get(id).availability, { kind: 'feature-gated', setting });
    assert.match(byId.get(id).runtimeGuards.join(' '), /Visible in the command palette only while/u);
  }
  assert.deepEqual(byId.get('explore-integrations').availability, { kind: 'always' });
  for (const id of ['generate-bases-task-views', 'export-bases-index']) assert.match(byId.get(id).runtimeGuards.join(' '), /enableBasesIntegration/u);
  for (const id of ['sync-todoist', 'sync-google-tasks', 'sync-google-calendar', 'sync-ms-todo', 'sync-caldav']) {
    assert.match(`${byId.get(id).runtimeGuards.join(' ')} ${byId.get(id).prerequisites.join(' ')}`, /(?:credential|OAuth|API token)/iu);
  }
});
