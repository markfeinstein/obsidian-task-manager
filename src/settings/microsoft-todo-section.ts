import { Setting } from 'obsidian';
import { t } from '../i18n';
import type { SettingsHost } from '../settings-contract';

/**
 * Render the Microsoft To Do sync settings section.
 * Extracted from TaskManagerSettingTab to keep settings.ts manageable.
 */
export function renderMicrosoftToDoSection(
  containerEl: HTMLElement,
  plugin: SettingsHost,
  display: () => void,
): void {
// ── Microsoft To Do Sync ──
containerEl.createEl('h3', { text: t('settings.microsoftTodo.microsoftToDoSyncExperimental') });
containerEl.createEl('p', {
  text: t('settings.microsoftTodo.importAndExportTasksViaTheMicrosoftGraphApiRequires'),
  cls: 'setting-item-description',
});
new Setting(containerEl)
  .setName(t('settings.microsoftTodo.enableMicrosoftToDoSync'))
  .setDesc(t('settings.microsoftTodo.activateMicrosoftToDoIntegrationUseTheSyncMicrosoftTo'))
  .addToggle((toggle) => toggle.setValue(plugin.settings.msToDoEnabled).onChange(async (value) => {
    if (value) {
      // Enabling experimental service - show confirmation modal
      plugin.showExperimentalSyncConfirmation(
        'Microsoft To Do',
        async () => {
          plugin.settings.msToDoEnabled = true;
          await plugin.saveSettings();
          plugin.showSyncTestConnection('Microsoft To Do', () => plugin.testMicrosoftTodoConnection());
          display();
        },
        () => {
          // Cancelled - revert the toggle
          display();
        },
      );
    } else {
      // Disabling is straightforward
      plugin.settings.msToDoEnabled = false;
      await plugin.saveSettings();
      display();
    }
  }));
new Setting(containerEl)
  .setName(t('settings.microsoftTodo.testConnection'))
  .setDesc(t('settings.microsoftTodo.verifyMicrosoftToDoConfiguration'))
  .addButton((btn) => btn.setButtonText(t('settings.microsoftTodo.test')).setCta().onClick(() => {
    plugin.showSyncTestConnection('Microsoft To Do', () => plugin.testMicrosoftTodoConnection());
  }));
if (plugin.settings.msToDoEnabled) {
  new Setting(containerEl)
    .setName(t('settings.microsoftTodo.azureClientId'))
    .setDesc(t('settings.microsoftTodo.azureAppRegistrationClientIdForMicrosoftGraphOauthTasks'))
    .addText((text) => {
      text.inputEl.type = 'password';
      text.setPlaceholder(t('settings.microsoftTodo.xxxxxxxxXxxxXxxxXxxxXxxxxxxxxxxx')).setValue(plugin.settings.msToDoClientId).onChange(async (value) => {
        plugin.settings.msToDoClientId = value.trim();
        await plugin.saveSettings();
      });
    });
  new Setting(containerEl)
    .setName(t('settings.microsoftTodo.microsoftToDoAccessToken'))
    .setDesc(t('settings.microsoftTodo.pasteAMicrosoftGraphOauthAccessTokenWithTasksReadwrite'))
    .addText((text) => {
      text.inputEl.type = 'password';
      text.setPlaceholder(t('settings.microsoftTodo.eyj')).setValue(plugin.settings.msToDoToken).onChange(async (value) => {
        plugin.settings.msToDoToken = value.trim();
        await plugin.saveSettings();
      });
    });
  new Setting(containerEl)
    .setName(t('settings.microsoftTodo.microsoftToDoRefreshToken'))
    .setDesc(t('settings.microsoftTodo.optionalMicrosoftOauthRefreshTokenWhenTheAccessTokenExpires'))
    .addText((text) => {
      text.inputEl.type = 'password';
      text.setPlaceholder(t('settings.microsoftTodo.0A')).setValue(plugin.settings.msToDoRefreshToken).onChange(async (value) => {
        plugin.settings.msToDoRefreshToken = value.trim();
        await plugin.saveSettings();
      });
    });
  new Setting(containerEl)
    .setName(t('settings.microsoftTodo.microsoftTokenExpiresAt'))
    .setDesc(t('settings.microsoftTodo.optionalIsoTimestampForMicrosoftGraphAccessTokenExpiryLeave'))
    .addText((text) => text.setPlaceholder(t('settings.microsoftTodo.20260528t200000000z')).setValue(plugin.settings.msToDoTokenExpiresAt).onChange(async (value) => {
      plugin.settings.msToDoTokenExpiresAt = value.trim();
      await plugin.saveSettings();
    }));
  new Setting(containerEl)
    .setName(t('settings.microsoftTodo.microsoftToDoListId'))
    .setDesc(t('settings.microsoftTodo.optionalLeaveBlankToResolveTheDefaultMicrosoftToDo'))
    .addText((text) => text.setPlaceholder(t('settings.microsoftTodo.defaultList')).setValue(plugin.settings.msToDoListId).onChange(async (value) => {
      plugin.settings.msToDoListId = value.trim();
      await plugin.saveSettings();
    }));
  new Setting(containerEl)
    .setName(t('settings.microsoftTodo.microsoftToDoInboxNote'))
    .setDesc(t('settings.microsoftTodo.vaultNoteWhereImportedMicrosoftToDoTasksAreWritten'))
    .addText((text) =>
      text.setPlaceholder(t('settings.microsoftTodo.msToDoInboxMd')).setValue(plugin.settings.msToDoInboxPath).onChange(async (value) => {
        plugin.settings.msToDoInboxPath = value.trim() || 'MS To Do Inbox.md';
        await plugin.saveSettings();
      }),
    );
  new Setting(containerEl)
    .setName(t('settings.googleTasks.dryRunMode'))
    .setDesc(t('settings.microsoftTodo.whenEnabledChangesAreLoggedButNotCommittedToMicrosoft'))
    .addToggle((toggle) => toggle.setValue(plugin.settings.msToDoDryRun).onChange(async (value) => {
      plugin.settings.msToDoDryRun = value;
      await plugin.saveSettings();
    }));
}

}
