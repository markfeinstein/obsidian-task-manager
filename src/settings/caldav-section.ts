import { Setting } from 'obsidian';
import { t } from '../i18n';
import type { SettingsHost } from '../settings-contract';

/**
 * Render the CalDAV sync settings section.
 * Extracted from TaskManagerSettingTab to keep settings.ts manageable.
 */
export function renderCalDavSection(
  containerEl: HTMLElement,
  plugin: SettingsHost,
  display: () => void,
): void {
// ── CalDAV Sync ──
containerEl.createEl('h3', { text: t('settings.caldav.caldavSync') });
containerEl.createEl('p', {
  text: t('settings.caldav.configureCaldavCompatibleCalendarServerSettingsForTaskCalendarIntegration'),
  cls: 'setting-item-description',
});
new Setting(containerEl)
  .setName(t('settings.caldav.enableCaldavSync'))
  .setDesc(t('settings.caldav.activateCaldavIntegrationSettings'))
  .addToggle((toggle) =>
    toggle.setValue(plugin.settings.caldavSyncEnabled).onChange(async (value) => {
      plugin.settings.caldavSyncEnabled = value;
      await plugin.saveSettings();
      display();
    }),
  );
if (plugin.settings.caldavSyncEnabled) {
  new Setting(containerEl)
    .setName(t('settings.caldav.caldavServerUrl'))
    .setDesc(t('settings.desc.caldavServerUrlTrust'))
    .addText((text) =>
      text.setPlaceholder(t('settings.caldav.httpsCaldavExampleCom')).setValue(plugin.settings.caldavServerUrl).onChange(async (value) => {
        plugin.settings.caldavServerUrl = value.trim();
        await plugin.saveSettings();
      }),
    );
  new Setting(containerEl)
    .setName(t('settings.label.caldavEndpointTrust'))
    .setDesc(t('settings.desc.caldavEndpointTrust'))
    .addToggle((toggle) =>
      toggle.setValue(plugin.settings.caldavAllowPrivateNetwork).onChange(async (value) => {
        plugin.settings.caldavAllowPrivateNetwork = value;
        await plugin.saveSettings();
      }),
    );
  new Setting(containerEl)
    .setName(t('settings.caldav.caldavUsername'))
    .setDesc(t('settings.caldav.usernameForCaldavServerAuthentication'))
    .addText((text) =>
      text.setPlaceholder(t('settings.caldav.userExampleCom')).setValue(plugin.settings.caldavUsername).onChange(async (value) => {
        plugin.settings.caldavUsername = value.trim();
        await plugin.saveSettings();
      }),
    );
  new Setting(containerEl)
    .setName(t('settings.caldav.caldavPassword'))
    .setDesc(t('settings.caldav.passwordForCaldavServerAuthentication'))
    .addText((text) => {
      text.inputEl.type = 'password';
      text.setPlaceholder(t('settings.caldav.')).setValue(plugin.settings.caldavPassword).onChange(async (value) => {
        plugin.settings.caldavPassword = value.trim();
        await plugin.saveSettings();
      });
    });
  new Setting(containerEl)
    .setName(t('settings.caldav.calendarPath'))
    .setDesc(t('settings.caldav.calendarCollectionPathEndingInEGUserTasksAn'))
    .addText((text) =>
      text.setPlaceholder(t('settings.caldav.userTasks')).setValue(plugin.settings.caldavCalendarPath).onChange(async (value) => {
        plugin.settings.caldavCalendarPath = value.trim() || '/calendar.ics/';
        await plugin.saveSettings();
      }),
    );
  new Setting(containerEl)
    .setName(t('settings.caldav.vaultNotePath'))
    .setDesc(t('settings.caldav.noteWhereTasksPulledFromTheCaldavServerAreWritten'))
    .addText((text) =>
      text.setPlaceholder(t('settings.caldav.caldavSyncMd')).setValue(plugin.settings.caldavVaultPath).onChange(async (value) => {
        plugin.settings.caldavVaultPath = value.trim() || 'CalDAV Sync.md';
        await plugin.saveSettings();
      }),
    );
  new Setting(containerEl)
    .setName(t('settings.microsoftTodo.testConnection'))
    .setDesc(t('settings.caldav.verifyCaldavServerConnection'))
    .addButton((btn) => btn.setButtonText(t('settings.microsoftTodo.test')).setCta().onClick(() => {
      plugin.showSyncTestConnection('CalDAV', () => plugin.testCalDAVConnection());
    }));
}

}
