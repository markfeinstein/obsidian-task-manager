import { Setting } from 'obsidian';
import { DEFAULT_APPLE_REMINDERS_SHORTCUT_NAME } from '../apple-reminders-shortcut';
import { t } from '../i18n';
import type { SettingsHost } from '../settings-contract';

/**
 * Render the Apple Reminders sync settings section.
 * Extracted from TaskManagerSettingTab to keep settings.ts manageable.
 */
export function renderAppleRemindersSection(
  containerEl: HTMLElement,
  plugin: SettingsHost,
  display: () => void,
): void {
// ── Apple Reminders Sync ──
containerEl.createEl('h3', { text: 'Apple Reminders sync ⚠️ Experimental' });
containerEl.createEl('p', {
  text: 'Import Apple Reminders through an Apple Shortcut that copies the documented JSON payload, then run the clipboard import command. Native EventKit writeback and an HTTP/MCP import listener are not bundled.',
  cls: 'setting-item-description',
});
new Setting(containerEl)
  .setName('Enable Apple Reminders sync')
  .setDesc('Activate Apple Reminders integration.')
  .addToggle((toggle) => toggle.setValue(plugin.settings.appleRemindersEnabled).onChange(async (value) => {
    if (value) {
      // Enabling experimental service - show confirmation modal
      plugin.showExperimentalSyncConfirmation(
        'Apple Reminders',
        async () => {
          plugin.settings.appleRemindersEnabled = true;
          await plugin.saveSettings();
          // Show test connection after confirmation
          plugin.showSyncTestConnection('Apple Reminders', () => {
            if (plugin.settings.appleRemindersWebhookEnabled) {
              return Promise.resolve({ success: true, message: 'Apple Reminders clipboard JSON import is enabled' });
            }
            return Promise.resolve({ success: false, message: 'Enable clipboard JSON import to accept Shortcut payloads.' });
          });
          display();
        },
        () => {
          // Cancelled - revert the toggle
          display();
        },
      );
    } else {
      // Disabling the parent integration also disables the child webhook bridge
      // so local/MCP imports cannot continue writing unexpectedly.
      plugin.settings.appleRemindersEnabled = false;
      plugin.settings.appleRemindersWebhookEnabled = false;
      await plugin.saveSettings();
      display();
    }
  }));
new Setting(containerEl)
  .setName('Test Connection')
  .setDesc('Verify Apple Reminders integration')
  .addButton((btn) => btn.setButtonText('🔗 Test').setCta().onClick(() => {
    plugin.showSyncTestConnection('Apple Reminders', () => {
      if (!plugin.settings.appleRemindersEnabled) {
        return Promise.resolve({ success: false, message: 'Apple Reminders sync is not enabled' });
      }
      if (!plugin.settings.appleRemindersWebhookEnabled) {
        return Promise.resolve({ success: false, message: 'Enable clipboard JSON import to accept Shortcut payloads.' });
      }
      return Promise.resolve({ success: true, message: 'Apple Reminders clipboard JSON import is enabled' });
    });
  }));
if (plugin.settings.appleRemindersEnabled) {
  new Setting(containerEl)
    .setName('Reminders list name')
    .setDesc('Name of the Apple Reminders list to sync from. Leave blank to import from all lists.')
    .addText((text) =>
      text.setPlaceholder('Reminders').setValue(plugin.settings.appleRemindersListName).onChange(async (value) => {
        plugin.settings.appleRemindersListName = value.trim();
        await plugin.saveSettings();
      }),
    );
  new Setting(containerEl)
    .setName(t('settings.appleReminders.shortcutName'))
    .setDesc(t('settings.appleReminders.shortcutDescription'))
    .addText((text) =>
      text.setPlaceholder(t('settings.appleReminders.shortcutPlaceholder')).setValue(plugin.settings.appleRemindersShortcutName).onChange(async (value) => {
        const normalized = value.trim();
        plugin.settings.appleRemindersShortcutName = normalized && !/[\r\n]/u.test(normalized)
          ? normalized : DEFAULT_APPLE_REMINDERS_SHORTCUT_NAME;
        await plugin.saveSettings();
      }),
    );
  new Setting(containerEl)
    .setName('Reminders inbox note')
    .setDesc('Vault note where imported Apple Reminders are written as tasks.')
    .addText((text) =>
      text.setPlaceholder('Reminders Inbox.md').setValue(plugin.settings.appleRemindersInboxPath).onChange(async (value) => {
        plugin.settings.appleRemindersInboxPath = value.trim() || 'Reminders Inbox.md';
        await plugin.saveSettings();
      }),
    );
  new Setting(containerEl)
    .setName('Enable clipboard JSON import')
    .setDesc('Allow the explicit “Import Apple Reminders JSON from clipboard” command to validate and write Shortcut payloads. No HTTP/MCP listener is started. Off by default; see docs/apple-reminders-webhook.md.')
    .addToggle((toggle) => toggle.setValue(plugin.settings.appleRemindersWebhookEnabled).onChange(async (value) => {
      plugin.settings.appleRemindersWebhookEnabled = value;
      await plugin.saveSettings();
    }));
  new Setting(containerEl)
    .setName('Payload shared secret')
    .setDesc('Optional secret that clipboard payload JSON must include. This validates the producer but does not encrypt clipboard contents.')
    .addText((text) => {
      text.inputEl.type = 'password';
      text.setPlaceholder('optional shared secret').setValue(plugin.settings.appleRemindersWebhookSecret).onChange(async (value) => {
        plugin.settings.appleRemindersWebhookSecret = value.trim();
        await plugin.saveSettings();
      });
    });
  new Setting(containerEl)
    .setName('Dry-run mode')
    .setDesc('When enabled, clipboard payloads are validated but not written to the vault inbox. Use this before the first real import.')
    .addToggle((toggle) => toggle.setValue(plugin.settings.appleRemindersDryRun).onChange(async (value) => {
      plugin.settings.appleRemindersDryRun = value;
      await plugin.saveSettings();
    }));
}

}
