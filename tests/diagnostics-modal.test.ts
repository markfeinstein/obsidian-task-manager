import test from 'node:test';
import assert from 'node:assert/strict';
import type { App } from 'obsidian';
import { BUILD_SOURCE_SHA256 } from '../src/build-info';
import { DiagnosticsModal, type DiagnosticsFacade } from '../src/modals/diagnostics-modal';
import { DEFAULT_SETTINGS } from '../src/types';
import { installDomHarness } from './dom-harness';

test('diagnostics exposes version plus source identity and renders health sections', (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const settings = structuredClone(DEFAULT_SETTINGS);
  settings.syncRunHistory = [
    { service: 'Todoist', startedAt: '2026-07-13T09:00:00.000Z', endedAt: '2026-07-13T09:01:00.000Z', outcome: 'success', details: 'one' },
    { service: 'CalDAV', startedAt: '2026-07-13T10:00:00.000Z', endedAt: '2026-07-13T10:01:00.000Z', outcome: 'failed', details: 'two' },
  ];
  const plugin: DiagnosticsFacade = {
    manifest: { id: 'task-manager', version: '1.0.0', minAppVersion: '1.8.0' },
    settings,
    apiV1: { getAllTasks: () => [] },
    getScanDiagnostics: () => ({ lastScanStartedAt: null, lastScanDurationMs: null, lastScanFileCount: null, scanErrors: [] }),
    runFullScan: async () => undefined,
    runHealthReport: async () => undefined,
    saveSettings: async () => undefined,
  };
  const modal = new DiagnosticsModal({} as App, plugin, plugin.settings);
  const content = harness.document.createElement('div');
  (modal as unknown as { contentEl: HTMLElement }).contentEl = content;
  modal.onOpen();
  assert.match(content.textContent ?? '', /1\.0\.0\+src\./u);
  assert.match(content.textContent ?? '', new RegExp(BUILD_SOURCE_SHA256, 'u'));
  assert.match(content.textContent ?? '', /Plugin ID/u);
  const chips = Array.from(content.querySelectorAll<HTMLButtonElement>('.tm-diag-history-chip'));
  assert.equal(chips.length, 3);
  assert.equal(chips[0]?.getAttribute('aria-pressed'), 'true');
  chips.find((button) => button.dataset.service === 'Todoist')?.click();
  assert.equal(content.querySelector<HTMLElement>('.tm-diag-history-item[data-service="CalDAV"]')?.hidden, true);
  assert.equal(chips.find((button) => button.dataset.service === 'Todoist')?.getAttribute('aria-pressed'), 'true');
  assert.match(content.querySelector<HTMLElement>('.tm-diag-history-filters + [role="status"]')?.textContent ?? '', /Showing 1 run for Todoist/u);
});
