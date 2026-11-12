import { Setting } from 'obsidian';
import { DEFAULT_SETTINGS } from '../types';
import type { SettingsHost } from '../settings-contract';

/**
 * Render the Advanced settings section.
 */
export function renderAdvancedSection(
  containerEl: HTMLElement,
  plugin: SettingsHost,
  display: () => void,
): void {
// ── Missed reminder log (#7) ──
containerEl.createEl('h3', { text: 'Missed reminder log' });
new Setting(containerEl)
  .setName('Log missed reminders to daily note')
  .setDesc(
    'When a reminder fires, also append an entry under a "## Missed Reminders" section in today\'s daily note. '
    + 'This records reminders detected after Obsidian runs again; it cannot execute while the mobile app is suspended or closed.',
  )
  .addToggle((toggle) =>
    toggle.setValue(plugin.settings.missedReminderLogEnabled).onChange(async (value) => {
      plugin.settings.missedReminderLogEnabled = value;
      await plugin.saveSettings();
    }),
  );

// ── MCP Companion ──
containerEl.createEl('h3', { text: 'MCP integration' });
containerEl.createEl('p', {
  text: 'The embedded Node.js HTTP server has been removed from the mobile-safe plugin build. MCP is provided as a separate desktop companion so the core plugin can remain available on phones and tablets. Existing embedded-server settings are retained only for migration compatibility and are not started by this plugin.',
  cls: 'setting-item-description',
});

// ─ Mutation Log ─────────────────────────────────────────────────────────
containerEl.createEl('h3', { text: 'Mutation Log (Automation Safety)' });
containerEl.createEl('p', {
  text: 'Record all task modifications from MCP, CLI, UI, and workflows for automation safety, auditing, and recovery.',
  cls: 'setting-item-description',
});
new Setting(containerEl)
  .setName('Enable mutation log')
  .setDesc('Append-only log of all task changes. Useful for auditing and recovery.')
  .addToggle((toggle) =>
    toggle.setValue(plugin.settings.mutationLogEnabled).onChange(async (value) => {
      plugin.settings.mutationLogEnabled = value;
      await plugin.saveSettings();
      display();
    }),
  );
if (plugin.settings.mutationLogEnabled) {
  new Setting(containerEl)
    .setName('Log file path')
    .setDesc('Path to the mutation log file (JSONL format, relative to vault root).')
    .addText((text) =>
      text
        .setPlaceholder('.mutation-log.jsonl')
        .setValue(plugin.settings.mutationLogFile)
        .onChange(async (value) => {
          plugin.settings.mutationLogFile = value.trim() || DEFAULT_SETTINGS.mutationLogFile;
          await plugin.saveSettings();
        }),
    );
  new Setting(containerEl)
    .setName('Max entries before rotation')
    .setDesc('Number of entries to keep in the active log before rotating to a backup file (default 10000).')
    .addSlider((slider) =>
      slider
        .setLimits(100, 100000, 1000)
        .setValue(plugin.settings.mutationLogMaxEntries)
        .setDynamicTooltip()
        .onChange(async (value) => {
          plugin.settings.mutationLogMaxEntries = value;
          await plugin.saveSettings();
        }),
    );
}

// ─ Planning Board ──────────────────────────────────────────────────────────
containerEl.createEl('h3', { text: 'Interactive Planning Board' });
containerEl.createEl('p', {
  text: 'Organize tasks by time-scoped tabs with drag-to-schedule, parent-child nesting, and estimate totals.',
  cls: 'setting-item-description',
});
new Setting(containerEl)
  .setName('Enable planning board')
  .setDesc('Show the interactive planning board view with Today/Week/Month/Completed/Unscheduled tabs.')
  .addToggle((toggle) =>
    toggle.setValue(plugin.settings.planningBoardEnabled).onChange(async (value) => {
      plugin.settings.planningBoardEnabled = value;
      await plugin.saveSettings();
      display();
    }),
  );
if (plugin.settings.planningBoardEnabled) {
  new Setting(containerEl)
    .setName('Show in sidebar')
    .setDesc('Display planning board as a tab in the sidebar views.')
    .addToggle((toggle) =>
      toggle.setValue(plugin.settings.planningBoardSidebarEnabled).onChange(async (value) => {
        plugin.settings.planningBoardSidebarEnabled = value;
        await plugin.saveSettings();
      }),
    );
  new Setting(containerEl)
    .setName('Enable drag-to-schedule')
    .setDesc('Allow dragging tasks between time slots to reschedule them.')
    .addToggle((toggle) =>
      toggle.setValue(plugin.settings.planningBoardDragEnabled).onChange(async (value) => {
        plugin.settings.planningBoardDragEnabled = value;
        await plugin.saveSettings();
      }),
    );
  new Setting(containerEl)
    .setName('Undo stack size')
    .setDesc('Number of drag operations to keep in the undo stack (1-100, default 10).')
    .addSlider((slider) =>
      slider
        .setLimits(1, 100, 1)
        .setValue(plugin.settings.planningBoardMaxUndoStack)
        .setDynamicTooltip()
        .onChange(async (value) => {
          plugin.settings.planningBoardMaxUndoStack = value;
          await plugin.saveSettings();
        }),
    );
}
}
