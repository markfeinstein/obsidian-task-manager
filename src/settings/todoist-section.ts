import { Setting } from 'obsidian';
import type { SettingsHost } from '../settings-contract';

/**
 * Render the Todoist sync settings section.
 * Extracted from TaskManagerSettingTab to keep settings.ts manageable.
 */
export function renderTodoistSection(
  containerEl: HTMLElement,
  plugin: SettingsHost,
  display: () => void,
): void {
// ── Todoist Sync ──
containerEl.createEl('h3', { text: 'Todoist sync' });
containerEl.createEl('p', {
  text: 'Optional two-way sync with Todoist. Tasks tagged #todoist are pushed to the configured project; imported tasks land in the inbox file.',
  cls: 'setting-item-description',
});
new Setting(containerEl)
  .setName('Enable Todoist sync')
  .setDesc('Activate the Todoist integration. Use the \'Sync with Todoist\' command to run a sync.')
  .addToggle((toggle) =>
    toggle.setValue(plugin.settings.todoistSyncEnabled).onChange(async (value) => {
      plugin.settings.todoistSyncEnabled = value;
      await plugin.saveSettings();
      display();
    }),
  );
new Setting(containerEl)
  .setName('Test Connection')
  .setDesc('Verify Todoist API configuration')
  .addButton((btn) => btn.setButtonText('🔗 Test').setCta().onClick(() => {
    plugin.showSyncTestConnection('Todoist', () => plugin.testTodoistConnection());
  }));
if (plugin.settings.todoistSyncEnabled) {
  new Setting(containerEl)
    .setName('Todoist API key')
    .setDesc('Your Todoist personal API token (found in Todoist Settings → Integrations → Developer).')
    .addText((text) => {
      text.inputEl.type = 'password';
      text
        .setPlaceholder('xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx')
        .setValue(plugin.settings.todoistApiKey)
        .onChange(async (value) => {
          plugin.settings.todoistApiKey = value.trim();
          await plugin.saveSettings();
        });
    });
  new Setting(containerEl)
    .setName('Todoist project ID')
    .setDesc('Project ID to push #todoist-tagged vault tasks into. Leave blank to use the Todoist inbox.')
    .addText((text) =>
      text.setPlaceholder('2345678901').setValue(plugin.settings.todoistProjectId).onChange(async (value) => {
        plugin.settings.todoistProjectId = value.trim();
        await plugin.saveSettings();
      }),
    );
  new Setting(containerEl)
    .setName('Todoist inbox note path')
    .setDesc('Vault note where imported Todoist tasks are written.')
    .addText((text) =>
      text.setPlaceholder('Todoist Inbox.md').setValue(plugin.settings.todoistInboxPath).onChange(async (value) => {
        plugin.settings.todoistInboxPath = value.trim() || 'Todoist Inbox.md';
        await plugin.saveSettings();
      }),
    );
  new Setting(containerEl)
    .setName('Todoist dry run')
    .setDesc('Preview v2 Todoist sync operations without writing to Todoist or importing remote tasks.')
    .addToggle((toggle) => toggle.setValue(plugin.settings.todoistDryRun).onChange(async (value) => {
      plugin.settings.todoistDryRun = value;
      await plugin.saveSettings();
    }));
}

}
