/**
 * diagnostics-modal.ts
 *
 * Plugin status / health-check modal.  Extracted from main.ts.
 *
 * Uses DiagnosticsFacade instead of a direct TaskManagerPlugin reference,
 * breaking the circular dependency that would arise if this file imported
 * from main.ts.  TaskManagerPlugin satisfies DiagnosticsFacade structurally
 * (TypeScript structural typing) so no explicit `implements` declaration is
 * needed on the plugin class.
 */

import { Modal } from 'obsidian';
import type { App } from 'obsidian';
import type { TaskManagerSettings } from '../types';
import { t } from '../i18n';
import { confirmSettingsRemoval } from '../settings/confirm-removal';
import { SYNC_SERVICE_STATUS } from '../types';
import type { ParsedTask } from '../task-scanner';
import { todayString } from '../date-utils';
import { BUILD_SOURCE_SHA256, buildDisplayVersion } from '../build-info';

// ── DiagnosticsFacade ────────────────────────────────────────────────────────

/** Minimum surface of TaskManagerPlugin that DiagnosticsModal needs. */
export interface DiagnosticsFacade {
  manifest: { id: string; version: string; minAppVersion?: string };
  settings: TaskManagerSettings;
  apiV1: { getAllTasks: () => ParsedTask[] };
  getScanDiagnostics(): {
    lastScanStartedAt: string | null;
    lastScanDurationMs: number | null;
    lastScanFileCount: number | null;
    scanErrors: Array<{ file: string; message: string }>;
  };
  runFullScan(): Promise<void>;
  runHealthReport(): Promise<void>;
  saveSettings(): Promise<void>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

export function escapeTable(value: string): string {
  return value.replace(/\|/gu, '\\|').replace(/\r?\n/gu, ' ');
}

// ── DiagnosticsModal ─────────────────────────────────────────────────────────

export class DiagnosticsModal extends Modal {
  private selectedHistoryService = '';

  constructor(
    app: App,
    private readonly plugin: DiagnosticsFacade,
    private readonly settings: TaskManagerSettings,
  ) { super(app); }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('tm-diagnostics-modal');
    contentEl.createEl('h2', { text: '🔧 Plugin Status Dashboard' });

    try {
      const manifest = this.plugin.manifest;
      const tasks = this.plugin.apiV1.getAllTasks();
      const today = todayString();

      // ── Version & identity ──────────────────────────────────────────────
      const versionSec = contentEl.createDiv({ cls: 'tm-diag-section' });
      versionSec.createEl('h3', { text: '📦 Plugin Info' });
      const vGrid = versionSec.createDiv({ cls: 'tm-diag-grid' });
      this.row(vGrid, t('diagnostics.buildIdentity'), buildDisplayVersion(manifest.version));
      this.row(vGrid, t('diagnostics.sourceDigest'), BUILD_SOURCE_SHA256);
      this.row(vGrid, 'Plugin ID', manifest.id);
      this.row(vGrid, 'Min Obsidian', manifest.minAppVersion ?? '—');

      // ── Scan statistics ─────────────────────────────────────────────────
      const scanSec = contentEl.createDiv({ cls: 'tm-diag-section' });
      scanSec.createEl('h3', { text: '🔍 Last Vault Scan' });
      const sGrid = scanSec.createDiv({ cls: 'tm-diag-grid' });
      const { lastScanStartedAt: lastScan, lastScanDurationMs: lastDur, lastScanFileCount: lastFiles } = this.plugin.getScanDiagnostics();
      this.row(sGrid, 'Last scan', lastScan ? new Date(lastScan).toLocaleString() : 'Not yet run this session');
      this.row(sGrid, 'Duration', lastDur !== null ? `${lastDur} ms` : '—');
      this.row(sGrid, 'Files scanned', lastFiles !== null ? String(lastFiles) : '—');
      this.row(sGrid, 'Total tasks loaded', String(tasks.length));

      // ── Memory estimate ─────────────────────────────────────────────────
      const memSec = contentEl.createDiv({ cls: 'tm-diag-section' });
      memSec.createEl('h3', { text: '💾 Memory' });
      const mGrid = memSec.createDiv({ cls: 'tm-diag-grid' });
      const roughBytes = JSON.stringify(tasks).length;
      this.row(mGrid, 'Estimated task cache', `~${(roughBytes / 1024).toFixed(1)} KB`);

      // ── Task counts by status ────────────────────────────────────────────
      const statusSec = contentEl.createDiv({ cls: 'tm-diag-section' });
      statusSec.createEl('h3', { text: '📊 Tasks by Status' });
      const statusCounts = new Map<string, number>();
      for (const t of tasks) statusCounts.set(t.status, (statusCounts.get(t.status) ?? 0) + 1);
      const stGrid = statusSec.createDiv({ cls: 'tm-diag-grid' });
      for (const [status, count] of [...statusCounts.entries()].sort((a, b) => b[1] - a[1])) {
        this.row(stGrid, status, String(count));
      }

      // ── Task counts by priority ──────────────────────────────────────────
      const priSec = contentEl.createDiv({ cls: 'tm-diag-section' });
      priSec.createEl('h3', { text: '🎯 Tasks by Priority (non-done)' });
      const priCounts = new Map<string, number>();
      const ORDER = ['highest', 'high', 'medium', 'normal', 'low', 'lowest'];
      for (const t of tasks.filter((t) => t.status !== 'done' && t.status !== 'cancelled')) {
        const p = t.metadata.priority || 'normal';
        priCounts.set(p, (priCounts.get(p) ?? 0) + 1);
      }
      const prGrid = priSec.createDiv({ cls: 'tm-diag-grid' });
      for (const p of ORDER) { if (priCounts.has(p)) this.row(prGrid, p, String(priCounts.get(p))); }
      if (priCounts.size === 0) priSec.createEl('p', { text: 'No active tasks.' });

      // ── Health indicators ────────────────────────────────────────────────
      const healthSec = contentEl.createDiv({ cls: 'tm-diag-section' });
      healthSec.createEl('h3', { text: '🏥 Health Indicators' });
      const hGrid = healthSec.createDiv({ cls: 'tm-diag-grid' });
      const overdue = tasks.filter((t) => {
        if (!t.metadata.dates.due || t.status === 'done' || t.status === 'cancelled') return false;
        return today > t.metadata.dates.due;
      });
      this.rowStatus(hGrid, 'Overdue tasks', String(overdue.length), overdue.length > 0 ? 'warn' : 'ok');
      const stale = tasks.filter((t) => {
        if (t.status !== 'in_progress' || !t.metadata.dates.start) return false;
        const days = Math.floor((Date.now() - new Date(t.metadata.dates.start).getTime()) / 86_400_000);
        return days > this.settings.staleTaskThresholdDays;
      });
      this.rowStatus(hGrid, `Stale in-progress (>${this.settings.staleTaskThresholdDays}d)`, String(stale.length), stale.length > 0 ? 'warn' : 'ok');
      const byId = new Map<string, number>();
      for (const t of tasks) { if (t.metadata.id) byId.set(t.metadata.id, (byId.get(t.metadata.id) ?? 0) + 1); }
      const dupCount = [...byId.values()].filter((c) => c > 1).length;
      this.rowStatus(hGrid, 'Duplicate task IDs', String(dupCount), dupCount > 0 ? 'error' : 'ok');
      const knownIds = new Set(byId.keys());
      const missingCount = tasks.flatMap((t) => t.metadata.dependsOn.filter((id) => !knownIds.has(id))).length;
      this.rowStatus(hGrid, 'Unresolved dep references', String(missingCount), missingCount > 0 ? 'warn' : 'ok');
      const invalidRec = tasks.filter((t) => t.metadata.invalidRecurrence).length;
      this.rowStatus(hGrid, 'Invalid recurrence rules', String(invalidRec), invalidRec > 0 ? 'warn' : 'ok');

      // ── Scan errors ──────────────────────────────────────────────────────
      const errs = this.plugin.getScanDiagnostics().scanErrors;
      const errSec = contentEl.createDiv({ cls: 'tm-diag-section' });
      errSec.createEl('h3', { text: '⚠️ Recent Scan Errors' });
      if (errs && errs.length > 0) {
        const errList = errSec.createEl('ul');
        for (const e of errs.slice(-20)) errList.createEl('li', { text: `${e.file}: ${e.message}` });
      } else {
        errSec.createEl('p', { text: '✅ No errors recorded.' });
      }

      // ── Sync status ──────────────────────────────────────────────────────
      const syncSec = contentEl.createDiv({ cls: 'tm-diag-section' });
      syncSec.createEl('h3', { text: '🔄 Sync Connections' });
      const syncItems: Array<[string, boolean, string]> = [
        ['CalDAV', this.settings.caldavSyncEnabled, this.settings.syncLastSuccessCalDAV],
        ['Todoist', this.settings.todoistSyncEnabled, this.settings.syncLastSuccessTodoist],
        ['Google Tasks', this.settings.googleTasksEnabled, this.settings.syncLastSuccessGoogleTasks],
        ['Google Calendar', this.settings.googleCalendarEnabled, this.settings.syncLastSuccessGoogleCalendar],
        ['Microsoft To Do', this.settings.msToDoEnabled, this.settings.syncLastSuccessMsToDo],
      ];
      const sGrid2 = syncSec.createDiv({ cls: 'tm-diag-grid' });
      for (const [name, enabled, lastSyncIso] of syncItems) {
        const status = SYNC_SERVICE_STATUS[name];
        const statusIcon = status === 'experimental' ? '⚠️' : '✅';
        const statusLabel = status === 'experimental' ? 'Experimental' : 'Stable';
        const enabledIcon = enabled ? '🟢' : '⚫';
        const lastSyncText = lastSyncIso ? ` — Last sync: ${new Date(lastSyncIso).toLocaleString()}` : ' — Never synced';
        this.row(sGrid2, name, `${enabledIcon} ${enabled ? 'Enabled' : 'Disabled'} — ${statusIcon} ${statusLabel}${lastSyncText}`);
      }

      const syncHistory = this.settings.syncRunHistory ?? [];
      const latestRun = syncHistory[0];
      const observabilityRow = syncSec.createDiv({ cls: 'tm-diag-row' });
      observabilityRow.createEl('span', { text: 'Latest run', cls: 'tm-diag-label' });
      observabilityRow.createEl('span', {
        text: latestRun ? `${latestRun.service} ${latestRun.outcome} — ${new Date(latestRun.endedAt).toLocaleString()} — ${latestRun.details}` : 'No sync run history recorded.',
        cls: 'tm-diag-value',
      });
      if (syncHistory.length > 0) {
        const controls = syncSec.createDiv({ cls: 'tm-diag-history-controls' });
        controls.createEl('h4', { text: 'Recent runs' });
        const clearBtn = controls.createEl('button', { text: 'Clear runs', cls: 'mod-warning' });
        clearBtn.addEventListener('click', () => {
          confirmSettingsRemoval(this.app, 'sync run history', async () => {
            this.settings.syncRunHistory = [];
            await this.plugin.saveSettings();
            this.onOpen();
          }, {
            title: 'Clear sync run history?',
            description: 'This permanently removes retained sync diagnostics and timing evidence.',
            confirmLabel: 'Clear history',
          });
        });
        const serviceCounts = new Map<string, number>();
        for (const run of syncHistory) serviceCounts.set(run.service, (serviceCounts.get(run.service) ?? 0) + 1);
        if (this.selectedHistoryService && !serviceCounts.has(this.selectedHistoryService)) this.selectedHistoryService = '';
        const serviceFilter = syncSec.createDiv({ cls: 'tm-diag-history-filters' });
        serviceFilter.setAttr('role', 'group');
        serviceFilter.setAttr('aria-label', t('diagnostics.syncRunsFilter'));
        const filterStatus = syncSec.createDiv({ cls: 'task-manager-sr-only' });
        filterStatus.setAttr('role', 'status');
        filterStatus.setAttr('aria-live', 'polite');
        const historyList = syncSec.createEl('ul', { cls: 'tm-diag-history-list' });
        historyList.setAttr('aria-label', t('diagnostics.syncRunsLabel'));
        for (const run of syncHistory.slice(0, 10)) {
          const item = historyList.createEl('li', { cls: `tm-diag-history-item tm-diag-history-${run.outcome}` });
          item.setAttr('data-service', run.service);
          const headline = `${run.service} · ${run.outcome} · ${new Date(run.endedAt).toLocaleString()}`;
          item.createEl('div', { text: headline, cls: 'tm-diag-history-headline' });
          item.createEl('div', { text: run.details, cls: 'tm-diag-history-details' });
        }
        const applyFilter = (service: string): void => {
          this.selectedHistoryService = service;
          const items = Array.from(historyList.querySelectorAll<HTMLElement>('.tm-diag-history-item'));
          let visible = 0;
          for (const item of items) {
            item.hidden = Boolean(service && item.getAttribute('data-service') !== service);
            if (!item.hidden) visible += 1;
          }
          for (const button of Array.from(serviceFilter.querySelectorAll<HTMLButtonElement>('button'))) {
            const active = (button.dataset.service ?? '') === service;
            button.setAttr('aria-pressed', String(active));
            button.toggleClass('is-active', active);
          }
          filterStatus.setText(`Showing ${visible} run${visible === 1 ? '' : 's'}${service ? ` for ${service}` : ''}.`);
        };
        const choices = [['', 'All services'], ...Array.from(serviceCounts, ([service, count]) => [service, `${service} (${count})`])] as Array<[string, string]>;
        for (const [service, label] of choices) {
          const chip = serviceFilter.createEl('button', { text: label, cls: 'tm-diag-history-chip' });
          chip.setAttr('type', 'button');
          chip.dataset.service = service;
          chip.addEventListener('click', () => applyFilter(service));
        }
        applyFilter(this.selectedHistoryService);
      }

      // ── Feature toggles ──────────────────────────────────────────────────
      const featSec = contentEl.createDiv({ cls: 'tm-diag-section' });
      featSec.createEl('h3', { text: '⚙️ Feature Toggles' });
      const features: Array<[string, boolean]> = [
        ['Query DSL', this.settings.enableQueryDsl],
        ['Reminder notifications', this.settings.enableReminderNotifications],
        [t('diagnostics.functionExpressions'), this.settings.enableQueryDsl && this.settings.enableDslExpressions],
        ['Periodic scan', this.settings.enablePeriodicScan],
        ['File events', this.settings.enableFileEvents],
      ];
      const fGrid = featSec.createDiv({ cls: 'tm-diag-grid' });
      for (const [name, enabled] of features) this.row(fGrid, name, enabled ? '✅ On' : '❌ Off');

      // ── Settings warnings ────────────────────────────────────────────────
      const warnSec = contentEl.createDiv({ cls: 'tm-diag-section' });
      warnSec.createEl('h3', { text: '🔔 Settings Warnings' });
      const warnings: string[] = [];
      if (!this.settings.enablePeriodicScan) warnings.push('⚠️ Periodic scan is disabled — tasks will only update on file change.');
      if (this.settings.staleTaskThresholdDays < 1) warnings.push('⚠️ Stale task threshold < 1 day.');
      if (!this.settings.enableFileEvents) warnings.push('⚠️ File events disabled — new tasks may not be detected until manual scan.');
      if (warnings.length === 0) warnSec.createEl('p', { text: '✅ No warnings.' });
      else for (const w of warnings) warnSec.createEl('p', { text: w });

      // ── Action buttons ───────────────────────────────────────────────────
      const btnRow = contentEl.createDiv({ cls: 'tm-diag-buttons' });
      const scanBtn = btnRow.createEl('button', { text: '🔄 Run Full Scan Now', cls: 'mod-cta' });
      scanBtn.addEventListener('click', () => { this.close(); void this.plugin.runFullScan(); });
      const reportBtn = btnRow.createEl('button', { text: '📋 Generate Health Report' });
      reportBtn.addEventListener('click', () => { this.close(); void this.plugin.runHealthReport(); });

    } catch (err) {
      contentEl.createEl('p', { text: `Error rendering diagnostics: ${String(err)}` });
    }
  }

  private row(parent: HTMLElement, label: string, value: string): void {
    const r = parent.createDiv({ cls: 'tm-diag-row' });
    r.createEl('span', { text: label, cls: 'tm-diag-label' });
    r.createEl('span', { text: value, cls: 'tm-diag-value' });
  }

  private rowStatus(parent: HTMLElement, label: string, value: string, level: 'ok' | 'warn' | 'error'): void {
    const r = parent.createDiv({ cls: 'tm-diag-row' });
    r.createEl('span', { text: label, cls: 'tm-diag-label' });
    const icon = level === 'ok' ? '✅' : level === 'warn' ? '⚠️' : '🔴';
    r.createEl('span', { text: `${icon} ${value}`, cls: `tm-diag-value tm-diag-${level}` });
  }

  onClose(): void { this.contentEl.empty(); }
}
