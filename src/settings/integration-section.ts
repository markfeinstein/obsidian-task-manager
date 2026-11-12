import { Setting } from 'obsidian';
import { t } from '../i18n';
import { DEFAULT_SETTINGS } from '../types';
import type { SettingsHost } from '../settings-contract';

/**
 * Render the Integration settings section.
 */
export function renderIntegrationSection(
  containerEl: HTMLElement,
  plugin: SettingsHost,
  display: () => void,
): void {
// ── Obsidian Bases Integration ──
containerEl.createEl('h3', { text: t('settings.integration.obsidianBasesIntegration') });
new Setting(containerEl)
  .setName(t('settings.integration.enableObsidianBasesIntegration'))
  .setDesc(t('settings.integration.exposesTaskDataToObsidianBasesQueriesRequiresObsidianWith'))
  .addToggle((toggle) =>
    toggle.setValue(plugin.settings.enableBasesIntegration).onChange(async (value) => {
      plugin.settings.enableBasesIntegration = value;
      await plugin.saveSettings();
      display();
    }),
  );
if (plugin.settings.enableBasesIntegration) {
  new Setting(containerEl)
    .setName(t('settings.integration.autoRefreshBasesExport'))
    .setDesc(t('settings.integration.regenerateTheTaskManagerBasesIndexAfterTaskCacheUpdates'))
    .addToggle((toggle) => toggle.setValue(plugin.settings.basesAutoRefreshEnabled).onChange(async (value) => {
      plugin.settings.basesAutoRefreshEnabled = value;
      await plugin.saveSettings();
    }));
  new Setting(containerEl)
    .setName(t('settings.integration.basesRefreshDebounce'))
    .setDesc(t('settings.integration.millisecondsToWaitBeforeRefreshingGeneratedBasesFilesAfterCache'))
    .addText((text) => text.setPlaceholder(t('settings.integration.500')).setValue(String(plugin.settings.basesRefreshDebounceMs)).onChange(async (value) => {
      const trimmed = value.trim();
      const parsed = trimmed === '' ? Number.NaN : Number(trimmed);
      plugin.settings.basesRefreshDebounceMs = Number.isFinite(parsed) && Number.isInteger(parsed)
        ? Math.max(100, Math.min(5000, parsed))
        : DEFAULT_SETTINGS.basesRefreshDebounceMs;
      await plugin.saveSettings();
    }));
}

new Setting(containerEl)
  .setName(t('settings.integration.enableDatacoreIntegration'))
  .setDesc(t('settings.integration.registerTaskDataWithDatacoreTheNextGenerationDataviewReplacement'))
  .addToggle((toggle) =>
    toggle.setValue(plugin.settings.datacoreEnabled).onChange(async (value) => {
      plugin.settings.datacoreEnabled = value;
      await plugin.saveSettings();
    }),
  );

// ── Query Behaviour ──
containerEl.createEl('h3', { text: t('settings.integration.queryBehaviour') });
new Setting(containerEl)
  .setName(t('settings.integration.inheritParentDatesToSubtasks'))
  .setDesc(t('settings.integration.whenFilteringByDateEGDueBeforeUndatedSubtasks'))
  .addToggle((toggle) =>
    toggle.setValue(plugin.settings.subtaskDateInheritance).onChange(async (value) => {
      plugin.settings.subtaskDateInheritance = value;
      await plugin.saveSettings();
    }),
  );
new Setting(containerEl)
  .setName(t('settings.integration.filterSubtasksInTreeView'))
  .setDesc(t('settings.integration.whenShowTreeIsActiveOnlyShowChildTasksThat'))
  .addToggle((toggle) =>
    toggle.setValue(plugin.settings.treeFilteredView).onChange(async (value) => {
      plugin.settings.treeFilteredView = value;
      await plugin.saveSettings();
    }),
  );
new Setting(containerEl)
  .setName(t('settings.integration.enableNlpQueryFallback'))
  .setDesc(t('settings.integration.whenEnabledPlainLanguageQueryTextLikeOverdueHighPriority'))
  .addToggle((toggle) => toggle.setValue(plugin.settings.nlpQueryEnabled).onChange(async (value) => {
    plugin.settings.nlpQueryEnabled = value;
    await plugin.saveSettings();
  }));
new Setting(containerEl)
  .setName(t('settings.integration.enableKanbanFileWriteback'))
  .setDesc(t('settings.integration.whenEnabledDraggingAKanbanCardBetweenStatusColumnsMay'))
  .addToggle((toggle) => toggle.setValue(plugin.settings.kanbanFileWritebackEnabled).onChange(async (value) => {
    plugin.settings.kanbanFileWritebackEnabled = value;
    await plugin.saveSettings();
  }));


// ── Export & Import ──
containerEl.createEl('h3', { text: t('settings.integration.exportImport') });
new Setting(containerEl)
  .setName(t('settings.integration.jsonExportPath'))
  .setDesc(t('settings.integration.filePathForTheExportTasksToJsonCommandOutput'))
  .addText((text) =>
    text
      .setPlaceholder(t('settings.integration.tasksExportJson'))
      .setValue(plugin.settings.jsonExportPath)
      .onChange(async (value) => {
        plugin.settings.jsonExportPath = value.trim() || 'Tasks Export.json';
        await plugin.saveSettings();
      }),
  );
new Setting(containerEl)
  .setName(t('settings.integration.yamlExportPath'))
  .setDesc(t('settings.integration.filePathForTheExportTasksToYamlCommandOutput'))
  .addText((text) =>
    text
      .setPlaceholder(t('settings.integration.tasksExportYaml'))
      .setValue(plugin.settings.yamlExportPath)
      .onChange(async (value) => {
        plugin.settings.yamlExportPath = value.trim() || 'Tasks Export.yaml';
        await plugin.saveSettings();
      }),
  );
new Setting(containerEl)
  .setName(t('settings.integration.remoteIcsImportUrlDisabled'))
  .setDesc(t('settings.integration.arbitraryRemoteIcsFetchingIsDisabledBecauseObsidianRequesturlCannot'))
  .addText((text) =>
    text
      .setPlaceholder(t('settings.integration.httpsCalendarExampleComBasicIcs'))
      .setValue(plugin.settings.icalImportUrl)
      .setDisabled(true)
      .onChange(async (value) => {
        plugin.settings.icalImportUrl = value.trim();
        await plugin.saveSettings();
      }),
  );
new Setting(containerEl)
  .setName(t('settings.integration.icsImportTargetNote'))
  .setDesc(t('settings.integration.noteWhereImportedCalendarEventsWillBeWrittenAsTasks'))
  .addText((text) =>
    text
      .setPlaceholder(t('settings.integration.calendarImportMd'))
      .setValue(plugin.settings.icalImportTargetPath)
      .onChange(async (value) => {
        plugin.settings.icalImportTargetPath = value.trim() || 'Calendar Import.md';
        await plugin.saveSettings();
      }),
  );
new Setting(containerEl)
  .setName(t('settings.integration.icsFeedExportPath'))
  .setDesc(t('settings.integration.vaultPathWhereThePublishedIcsCalendarFeedIsWritten'))
  .addText((text) =>
    text
      .setPlaceholder(t('settings.integration.taskFeedIcs'))
      .setValue(plugin.settings.icsExportPath)
      .onChange(async (value) => {
        const cleaned = value.trim();
        plugin.settings.icsExportPath = cleaned || 'Task Feed.ics';
        await plugin.saveSettings();
      }),
  );

}
