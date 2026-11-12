import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import type { App, PluginManifest } from 'obsidian';
import { hasPointerLeftElement, TaskManagerSettingTab } from '../src/settings';
import { renderCalDavSection } from '../src/settings/caldav-section';
import type { SettingsHost } from '../src/settings-contract';
import { DEFAULT_SETTINGS, type TaskManagerSettings } from '../src/types';
import { installDomHarness } from './dom-harness';

function fullSettings(): TaskManagerSettings {
  const settings = structuredClone(DEFAULT_SETTINGS) as TaskManagerSettings;
  const values = settings as unknown as Record<string, unknown>;
  for (const key of Object.keys(values)) if (key.endsWith('Enabled') && typeof values[key] === 'boolean') values[key] = true;
  values.settingsTabsEnabled = false;
  return settings;
}

test('settings drag leave helper distinguishes child transitions from real exits', (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const parent = harness.document.createElement('div');
  const child = harness.document.createElement('span');
  const outside = harness.document.createElement('span');
  parent.appendChild(child);
  assert.equal(hasPointerLeftElement(parent, { relatedTarget: null } as DragEvent), true);
  assert.equal(hasPointerLeftElement(parent, { relatedTarget: child } as unknown as DragEvent), false);
  assert.equal(hasPointerLeftElement(parent, { relatedTarget: outside } as unknown as DragEvent), true);
});

test('settings tab renders every local and integration section with complete settings', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const app = {
    vault: { getMarkdownFiles: () => [], getAbstractFileByPath: () => null },
    workspace: { getLeavesOfType: () => [] },
    plugins: { getPlugin: () => null },
  } as unknown as App;
  const plugin: SettingsHost = {
    app,
    manifest: { id: 'task-manager', name: 'Task Manager', version: '1.0.0', minAppVersion: '1.0.0', description: '', author: '' } as PluginManifest,
    settings: fullSettings(),
    saveSettings: async () => undefined,
    refreshWatchers: () => undefined,
    refreshTaskConfiguration: async () => undefined,
    requestSystemNotificationPermission: async () => undefined,
    openGoogleCalendarQuickCaptureModal: () => undefined,
    openGoogleCalendarSetupWizard: () => undefined,
    showExperimentalSyncConfirmation: (_serviceName, onConfirm, onCancel) => { void onConfirm(); onCancel?.(); },
    showSyncTestConnection: () => undefined,
    testTodoistConnection: async () => ({ success: true, message: 'ok' }),
    testGoogleTasksConnection: async () => ({ success: true, message: 'ok' }),
    testGoogleCalendarConnection: async () => ({ success: true, message: 'ok' }),
    testMicrosoftTodoConnection: async () => ({ success: true, message: 'ok' }),
    testCalDAVConnection: async () => ({ success: true, message: 'ok' }),
  };
  const tab = new TaskManagerSettingTab(app, plugin);
  const root = harness.document.createElement('section');
  Object.assign(tab, { containerEl: root, isGoogleAdvancedSectionOpen: true });
  harness.document.body.append(root);
  tab.display();
  const settingRows = root.querySelectorAll('.setting-item').length;
  assert.ok(settingRows > 100, `all settings sections should create their controls (rendered ${settingRows})`);
  assert.ok(root.querySelectorAll('input, select, textarea, button').length > 100);
  assert.equal(root.getAttribute('lang'), 'en');
  const googleAdvanced = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((button) => /advanced/u.test(button.textContent ?? ''));
  assert.equal(googleAdvanced?.getAttribute('aria-expanded'), 'true');
  assert.equal(googleAdvanced?.getAttribute('aria-controls'), 'task-manager-google-advanced-settings');
  assert.ok(root.querySelector('#task-manager-google-advanced-settings'));
  const stateRow = root.querySelector<HTMLElement>('.task-manager-settings__state-row');
  const stateLabels = Array.from(stateRow?.querySelectorAll<HTMLLabelElement>('.task-manager-settings__state-field-label') ?? []);
  assert.deepEqual(stateLabels.map((label) => label.textContent), ['Checkbox marker', 'State name', 'State icon', 'State type', 'Next state marker']);
  assert.ok(stateLabels.every((label) => Boolean(label.htmlFor) && Boolean(root.querySelector(`#${label.htmlFor}`))));
  const stateControlSelector = '.task-manager-settings .setting-item-control .task-manager-settings__state-field :is(input, select)';
  assert.ok(readFileSync('styles/00-foundation.css', 'utf8').includes(`${stateControlSelector} {\n  max-width: none;\n  min-width: 0;\n  width: 100%;\n}`));
  assert.ok(stateLabels.every((label) => root.querySelector(`#${label.htmlFor}`)?.matches(stateControlSelector)), 'all five labeled state controls share the scoped grid sizing rule');
  assert.equal(root.querySelector('.task-manager-settings__state-status')?.getAttribute('aria-live'), 'polite');
  const controls = Array.from(root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea')) as Array<(HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement) & { _onChange?: (value: string | boolean) => void | Promise<void> }>;
  for (const control of controls) {
    if (!control._onChange) continue;
    try {
      if (control instanceof harness.window.HTMLInputElement && control.type === 'checkbox') {
        await control._onChange(true);
        await control._onChange(false);
      } else await control._onChange(control.value);
    } catch { /* live-host-only callbacks may reject in the settings smoke */ }
  }
  for (const button of Array.from(root.querySelectorAll<HTMLButtonElement>('button'))) {
    try { button.click(); } catch { /* action buttons may require a live host */ }
  }
  await new Promise((resolve) => setTimeout(resolve, 0));
  plugin.settings.settingsTabsEnabled = true;
  for (const activeSettingsTab of ['general', 'query', 'views', 'sync', 'automation', 'advanced'] as const) {
    Object.assign(tab, { activeSettingsTab });
    tab.display();
  }

  plugin.settings.settingsTabsEnabled = true;
  plugin.settings.enablePeriodicScan = true;
  Object.assign(tab, { activeSettingsTab: 'general' });
  tab.display();
  const search = root.querySelector<HTMLInputElement>('.task-manager-settings-search-input');
  assert.ok(search);
  search.value = 'scan interval';
  search.dispatchEvent(new harness.window.Event('input', { bubbles: true }));
  const visibleRows = Array.from(root.querySelectorAll<HTMLElement>('.setting-item')).filter((row) => !row.hidden);
  assert.equal(visibleRows.length, 1, `visible: ${visibleRows.map((row) => row.querySelector('.setting-item-name')?.textContent ?? row.textContent).join(' | ')}`);
  assert.match(visibleRows[0].textContent ?? '', /Scan interval/u);
  assert.match(visibleRows[0].id, /^task-manager-setting-/u);
  assert.match(root.querySelector('[role="status"]')?.textContent ?? '', /1 setting found/u);
  const interval = visibleRows[0].querySelector<HTMLInputElement>('input') as (HTMLInputElement & { _onChange?: (value: string) => Promise<void> });
  const previousInterval = plugin.settings.scanIntervalMinutes;
  await interval._onChange?.('0');
  assert.equal(plugin.settings.scanIntervalMinutes, previousInterval);
  assert.equal(interval.getAttribute('aria-invalid'), 'true');
  assert.match(visibleRows[0].querySelector('[role="alert"]')?.textContent ?? '', /1 to 1440/u);
  const anchorId = visibleRows[0].id;
  Object.assign(tab, { settingsSearchQuery: '' });
  harness.window.location.hash = `#${anchorId}`;
  tab.display();
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(harness.document.activeElement?.id, anchorId);
  harness.window.location.hash = '';

  plugin.settings.completionLoggingEnabled = false;
  const loggingRoot = harness.document.createElement('section');
  (tab as unknown as { renderLoggingSection(root: HTMLElement): void }).renderLoggingSection(loggingRoot);
  assert.match(loggingRoot.textContent ?? '', /Completion logging is off/iu);
  const loggingToggle = loggingRoot.querySelector<HTMLInputElement>('input[type="checkbox"]') as (HTMLInputElement & { _onChange?: (value: boolean) => Promise<void> });
  await loggingToggle?._onChange?.(true);
});

test('CalDAV settings connection button delegates to the lifecycle-owned facade', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  let delegated = false;
  let tested = false;
  const plugin = {
    settings: { ...fullSettings(), caldavSyncEnabled: true },
    saveSettings: async () => undefined,
    showSyncTestConnection: (serviceName: string, testFn: () => Promise<{ success: boolean; message: string }>) => {
      delegated = serviceName === 'CalDAV';
      void testFn();
    },
    testCalDAVConnection: async () => { tested = true; return { success: true, message: 'ok' }; },
  } as unknown as SettingsHost;
  const root = harness.document.createElement('section');
  renderCalDavSection(root, plugin, () => undefined);
  assert.match(root.textContent ?? '', /Trust CalDAV endpoint/iu);
  assert.match(root.textContent ?? '', /trusts the hostname, DNS resolution/iu);
  const button = Array.from(root.querySelectorAll<HTMLButtonElement>('button')).find((candidate) => candidate.textContent?.includes('Test'));
  assert.ok(button);
  button.click();
  await Promise.resolve();
  assert.equal(delegated, true);
  assert.equal(tested, true);
});
