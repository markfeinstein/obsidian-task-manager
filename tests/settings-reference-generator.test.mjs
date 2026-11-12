import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  generateSettingsInventory,
  parseSettingsSource,
  renderSettingsReference,
  validateOverrides,
} from '../scripts/generate-settings-reference.mjs';

function rowByLabel(rows, label) {
  const matches = rows.filter((row) => row.label === label);
  assert.equal(matches.length, 1, `expected one generated row named ${label}`);
  return matches[0];
}

test('settings reference binds high-risk rows to exact fields, defaults, and explicit providers', () => {
  const rows = generateSettingsInventory();
  assert.deepEqual(
    Object.fromEntries(['AI provider', 'Local AI endpoint', 'AI model'].map((label) => {
      const row = rowByLabel(rows, label);
      return [label, { field: row.field, defaultValue: row.defaultValue }];
    })),
    {
      'AI provider': { field: 'aiQueryProvider', defaultValue: 'openai' },
      'Local AI endpoint': { field: 'aiQueryLocalEndpoint', defaultValue: 'http://localhost:11434/v1/chat/completions' },
      'AI model': { field: 'aiQueryModel', defaultValue: 'gpt-4o-mini' },
    },
  );
  for (const [label, field, defaultValue] of [
    ['Calendar ID', 'googleCalendarId', 'primary'],
    ['Reminder minutes', 'googleCalendarReminderMinutes', '10'],
    ['Dry-run mode', 'googleCalendarDryRun', 'false'],
  ]) {
    const candidates = rows.filter((row) => row.label === label && row.field === field);
    assert.equal(candidates.length, 1, `${label} must bind ${field}`);
    assert.equal(candidates[0].provider, 'Google Calendar');
    assert.equal(candidates[0].defaultValue, defaultValue);
    assert.equal(candidates[0].source, 'src/settings/google-tasks-section.ts');
  }
  const shortcut = rowByLabel(rows, 'Shortcut name');
  assert.equal(shortcut.field, 'appleRemindersShortcutName');
  assert.equal(shortcut.defaultValue, 'Export Reminders to Obsidian');
  assert.equal(shortcut.provider, 'Apple Reminders');
});

test('generated settings markdown count and IDs equal the parsed source inventory', () => {
  const rows = generateSettingsInventory();
  const generated = renderSettingsReference(rows);
  const checkedIn = readFileSync('docs/SETTINGS_REFERENCE.md', 'utf8');
  assert.equal(checkedIn, generated);
  const ids = [...checkedIn.matchAll(/^\| `([^`]+)` \|/gmu)].map((match) => match[1]).filter((id) => id.startsWith('settings.'));
  assert.equal(ids.length, rows.length);
  assert.deepEqual(ids, rows.map((row) => row.id));
  assert.equal(new Set(ids).size, ids.length);
});

test('settings source parsing rejects ambiguous persisted rows without a reviewed override', () => {
  const source = `
    class Fixture {
      render(containerEl) {
        new Setting(containerEl).setName('Ambiguous')
          .addText((text) => text.setValue(this.plugin.settings.first).onChange((value) => { this.plugin.settings.first = value; }))
          .addText((text) => text.setValue(this.plugin.settings.second).onChange((value) => { this.plugin.settings.second = value; }));
      }
    }
  `;
  assert.throws(() => parseSettingsSource({
    source,
    sourcePath: 'src/settings/fixture.ts',
    defaults: new Map([['first', 'one'], ['second', 'two']]),
    translations: new Map(),
    overrides: new Map(),
  }), /Missing override.*multiple fields/u);
});

test('override validation rejects duplicate and unknown metadata', () => {
  const row = {
    id: 'settings.fixture.action', label: 'Action', source: 'src/settings/fixture.ts', section: 'Fixture', kind: 'action', provider: 'Core/local',
    defaultValue: 'N/A', prerequisite: 'None', security: 'Not persisted', sideEffect: 'Runs action', reload: 'No reload',
  };
  assert.throws(() => validateOverrides({ schemaVersion: 1, rows: [row, row] }), /Duplicate/u);
  assert.throws(() => validateOverrides({ schemaVersion: 1, rows: [{ ...row, mystery: 'no' }] }), /Unknown override key/u);
});
