import test from 'node:test';
import assert from 'node:assert/strict';
import type { Command } from 'obsidian';
import { DEFAULT_SETTINGS, type TaskManagerSettings } from '../src/types';
import { setLocale } from '../src/i18n';
import { STATIC_COMMAND_DOCUMENTATION } from '../src/command-metadata';
import { addDocumentedCommand } from '../src/commands/documented-command';
import type { CommandHost } from '../src/commands/command-host';
import { registerCoreTaskCommands } from '../src/commands/register-core-task-commands';
import { registerExportCommands } from '../src/commands/register-export-commands';
import { registerSyncCommands } from '../src/commands/register-sync-commands';
import { registerWorkspaceCommands } from '../src/commands/register-workspace-commands';
import { registerAdvancedCommands } from '../src/commands/register-advanced-commands';
import { consumeTaskManagerSettingsTabRequest } from '../src/settings-navigation';

function capture(settings: TaskManagerSettings): Command[] {
  const commands: Command[] = [];
  const target = { settings, addCommand: (command: Command) => { commands.push(command); } };
  const host = new Proxy(target, {
    get(object, key) {
      if (key in object) return Reflect.get(object, key);
      return () => undefined;
    },
  }) as unknown as CommandHost;
  registerCoreTaskCommands(host);
  registerExportCommands(host);
  registerSyncCommands(host);
  registerWorkspaceCommands(host);
  registerAdvancedCommands(host);
  return commands;
}

function staticCommands(commands: readonly Command[]): Command[] {
  return commands.filter((command) => !command.id.startsWith('change-status-to-'));
}

test('runtime registration IDs and names exactly match declarative metadata', () => {
  setLocale('en');
  const allFeatures = {
    ...DEFAULT_SETTINGS,
    googleCalendarEnabled: true,
    aiQueryEnabled: true,
    weeklyReviewEnabled: true,
    appleRemindersEnabled: true,
    caldavSyncEnabled: true,
  };
  const registered = staticCommands(capture(allFeatures));
  assert.equal(registered.length, STATIC_COMMAND_DOCUMENTATION.length);
  assert.deepEqual(
    new Map(registered.map((command) => [command.id, command.name])),
    new Map(STATIC_COMMAND_DOCUMENTATION.map((entry) => [entry.id, entry.name])),
  );
  assert.equal(new Set(registered.map((command) => command.id)).size, registered.length);
});

test('core surface keeps one integration explorer while disabled provider commands stay palette-hidden', () => {
  const commands = staticCommands(capture({ ...DEFAULT_SETTINGS }));
  const byId = new Map(commands.map((command) => [command.id, command]));
  assert.ok(byId.has('explore-integrations'));
  for (const id of ['sync-todoist', 'sync-google-tasks', 'sync-google-calendar', 'ai-task-search', 'sync-apple-reminders', 'import-apple-reminders-json', 'sync-ms-todo', 'sync-caldav', 'start-weekly-review']) {
    assert.equal(byId.get(id)?.checkCallback?.(true), false, id);
  }
});

test('integration explorer requests the internal Sync settings tab', () => {
  const commands: Command[] = [];
  let opened = 0;
  let selected = '';
  const host = new Proxy({
    settings: { ...DEFAULT_SETTINGS },
    app: { setting: { open: () => { opened += 1; }, openTabById: (id: string) => { selected = id; } } },
    addCommand: (command: Command) => { commands.push(command); },
  }, { get: (target, key) => key in target ? Reflect.get(target, key) : () => undefined }) as unknown as CommandHost;
  registerSyncCommands(host);
  commands.find((command) => command.id === 'explore-integrations')?.callback?.();
  assert.equal(opened, 1);
  assert.equal(selected, 'task-manager');
  assert.equal(consumeTaskManagerSettingsTabRequest(), 'sync');
});

test('feature toggle changes update command visibility without re-registration', () => {
  const mappings = [
    ['googleCalendarEnabled', 'sync-google-calendar'], ['aiQueryEnabled', 'ai-task-search'],
    ['weeklyReviewEnabled', 'start-weekly-review'], ['appleRemindersEnabled', 'sync-apple-reminders'],
    ['caldavSyncEnabled', 'sync-caldav'],
  ] as const;
  const settings = { ...DEFAULT_SETTINGS };
  const commands = new Map(staticCommands(capture(settings)).map((command) => [command.id, command]));
  for (const [setting, id] of mappings) {
    settings[setting] = false;
    assert.equal(commands.get(id)?.checkCallback?.(true), false, id);
    settings[setting] = true;
    assert.equal(commands.get(id)?.checkCallback?.(true), true, id);
  }
});

test('workspace creation and refresh declare their vault-write effects', () => {
  const effects = new Map(STATIC_COMMAND_DOCUMENTATION.map((entry) => [entry.id, entry.effect]));
  assert.equal(effects.get('create-project-workspace'), 'vault-write');
  assert.equal(effects.get('refresh-project-workspace'), 'vault-write');
});

test('modal journeys that can later write declare deferred-vault-write effects', () => {
  const effects = new Map(STATIC_COMMAND_DOCUMENTATION.map((entry) => [entry.id, entry.effect]));
  assert.equal(effects.get('open-query-builder'), 'deferred-vault-write');
  assert.equal(effects.get('open-migration-wizard'), 'deferred-vault-write');
  assert.equal(effects.get('open-query-editor'), 'deferred-vault-write');
});

test('disabled feature-gated commands refuse without invoking provider or feature effects', () => {
  const commands: Command[] = [];
  const calls = new Map<string, number>();
  const count = (name: string) => { calls.set(name, (calls.get(name) ?? 0) + 1); };
  const host = new Proxy({
    settings: { ...DEFAULT_SETTINGS, googleCalendarEnabled: false, aiQueryEnabled: false, weeklyReviewEnabled: false, appleRemindersEnabled: false, caldavSyncEnabled: false },
    app: {},
    addCommand: (command: Command) => { commands.push(command); },
    syncGoogleCalendar: async () => { count('google'); },
    startWeeklyReview: async () => { count('weekly'); },
    syncAppleReminders: () => { count('apple-open'); },
    importAppleRemindersFromClipboard: async () => { count('apple-import'); },
    syncCalDAV: async () => { count('caldav'); },
  }, {
    get(target, key) {
      if (key in target) return Reflect.get(target, key);
      return () => { count(String(key)); };
    },
  }) as unknown as CommandHost;
  registerSyncCommands(host);
  const byId = new Map(commands.map((command) => [command.id, command]));
  for (const id of ['sync-google-calendar', 'ai-task-search', 'start-weekly-review', 'sync-apple-reminders', 'import-apple-reminders-json', 'sync-caldav']) {
    const command = byId.get(id);
    assert.ok(command, id);
    assert.equal(command.checkCallback?.(true), false);
    assert.equal(command.checkCallback?.(false), false);
  }
  assert.deepEqual([...calls.entries()], []);
});

test('withdrawn Kanban import command is absent from runtime registration and metadata', () => {
  const allFeatures = {
    ...DEFAULT_SETTINGS,
    googleCalendarEnabled: true,
    aiQueryEnabled: true,
    weeklyReviewEnabled: true,
    appleRemindersEnabled: true,
    caldavSyncEnabled: true,
  };
  assert.equal(staticCommands(capture(allFeatures)).some((command) => command.id === 'import-kanban-board'), false);
  assert.equal(STATIC_COMMAND_DOCUMENTATION.some((entry) => String(entry.id) === 'import-kanban-board'), false);
});

test('runtime wrapper rejects duplicate static registrations', () => {
  const host = { addCommand() {}, settings: DEFAULT_SETTINGS } as unknown as CommandHost;
  const documented = { id: 'scan-vault' as const, name: 'Rescan vault now', callback: () => undefined };
  addDocumentedCommand(host, documented);
  assert.throws(() => addDocumentedCommand(host, documented), /Duplicate static command registration/u);
});
