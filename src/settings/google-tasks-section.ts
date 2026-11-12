import { Setting } from 'obsidian';
import type { SettingsHost } from '../settings-contract';
import { t } from '../i18n';

function addSyncCard(containerEl: HTMLElement, title: string, desc: string): HTMLElement {
  const card = containerEl.createDiv({ cls: 'task-manager-sync-card' });
  card.createEl('div', { text: title, cls: 'task-manager-sync-card__title' });
  card.createEl('div', { text: desc, cls: 'task-manager-sync-card__desc' });
  return card;
}

export function renderGoogleTasksSection(
  containerEl: HTMLElement,
  plugin: SettingsHost,
  display: () => void,
  showAdvanced = false,
): void {
  const hero = addSyncCard(
    containerEl,
    'Google sync',
    'Keep tasks local first, then opt into Google Tasks or Google Calendar sync when you need it. Start with the lightweight path, then add OAuth only if you need writeback.',
  );
  hero.createEl('div', { text: plugin.settings.googleCalendarEnabled ? 'Calendar sync enabled' : 'Calendar sync disabled', cls: 'task-manager-sync-card__badge' });
  const heroActions = hero.createDiv({ cls: 'task-manager-sync-card__actions' });
  heroActions.createEl('button', {
    text: t('settings.googleTasks.openCalendarQuickAdd'),
    cls: 'mod-cta task-manager-sync-card__button',
  }).addEventListener('click', () => plugin.openGoogleCalendarQuickCaptureModal());
  heroActions.createEl('button', {
    text: t('settings.googleTasks.testGoogleCalendar'),
    cls: 'task-manager-sync-card__button',
  }).addEventListener('click', () => plugin.showSyncTestConnection('Google Calendar', () => plugin.testGoogleCalendarConnection()));

  containerEl.createEl('h3', { text: t('settings.googleTasks.googleTasksSync') });
  new Setting(containerEl)
    .setName(t('settings.googleTasks.enableGoogleTasksSync'))
    .setDesc(t('settings.googleTasks.importAndReconcileTasksWithGoogleTasks'))
    .addToggle((toggle) => toggle.setValue(plugin.settings.googleTasksEnabled).onChange(async (value) => {
      if (value) {
        plugin.showExperimentalSyncConfirmation(
          'Google Tasks',
          async () => {
            plugin.settings.googleTasksEnabled = true;
            await plugin.saveSettings();
            plugin.showSyncTestConnection('Google Tasks', () => plugin.testGoogleTasksConnection());
            display();
          },
          () => { display(); },
        );
      } else {
        plugin.settings.googleTasksEnabled = false;
        await plugin.saveSettings();
        display();
      }
    }));

  if (plugin.settings.googleTasksEnabled && showAdvanced) {
    new Setting(containerEl)
      .setName(t('settings.googleTasks.googleOauthClientId'))
      .setDesc(t('settings.googleTasks.usedForTokenRefreshAndManualOauthSetup'))
      .addText((text) => {
        text.inputEl.type = 'password';
        text.setPlaceholder(t('settings.googleTasks.clientIdAppsGoogleusercontentCom')).setValue(plugin.settings.googleTasksOAuthClientId).onChange(async (value) => {
          plugin.settings.googleTasksOAuthClientId = value.trim();
          await plugin.saveSettings();
        });
      });
    new Setting(containerEl)
      .setName(t('settings.googleTasks.googleTasksAccessToken'))
      .setDesc(t('settings.googleTasks.oauthBearerTokenWithGoogleTasksScope'))
      .addText((text) => {
        text.inputEl.type = 'password';
        text.setPlaceholder(t('settings.googleTasks.ya29')).setValue(plugin.settings.googleTasksAccessToken).onChange(async (value) => {
          plugin.settings.googleTasksAccessToken = value.trim();
          await plugin.saveSettings();
        });
      });
    new Setting(containerEl)
      .setName(t('settings.googleTasks.googleTasksRefreshToken'))
      .setDesc(t('settings.googleTasks.optionalOauthRefreshToken'))
      .addText((text) => {
        text.inputEl.type = 'password';
        text.setPlaceholder(t('settings.googleTasks.1')).setValue(plugin.settings.googleTasksRefreshToken).onChange(async (value) => {
          plugin.settings.googleTasksRefreshToken = value.trim();
          await plugin.saveSettings();
        });
      });
    new Setting(containerEl)
      .setName(t('settings.googleTasks.listId'))
      .setDesc(t('settings.googleTasks.listIdDesc'))
      .addText((text) => text.setPlaceholder(t('settings.googleTasks.listIdPlaceholder')).setValue(plugin.settings.googleTasksListId || '@default').onChange(async (value) => {
        plugin.settings.googleTasksListId = value.trim() || '@default';
        await plugin.saveSettings();
      }));
    new Setting(containerEl)
      .setName(t('settings.googleTasks.googleTasksInboxNote'))
      .setDesc(t('settings.googleTasks.vaultNoteWhereImportedGoogleTasksAreWritten'))
      .addText((text) => text.setPlaceholder(t('settings.googleTasks.googleTasksInboxMd')).setValue(plugin.settings.googleTasksInboxPath).onChange(async (value) => {
        plugin.settings.googleTasksInboxPath = value.trim() || 'Google Tasks Inbox.md';
        await plugin.saveSettings();
      }));
    new Setting(containerEl)
      .setName(t('settings.googleTasks.dryRunMode'))
      .setDesc(t('settings.googleTasks.countChangesWithoutWritingThemToGoogleTasks'))
      .addToggle((toggle) => toggle.setValue(plugin.settings.googleTasksDryRun).onChange(async (value) => {
        plugin.settings.googleTasksDryRun = value;
        await plugin.saveSettings();
      }));
  }

  const calendarCard = addSyncCard(
    containerEl,
    'Google Calendar sync',
    plugin.settings.googleCalendarEnabled
      ? (plugin.settings.googleCalendarDryRun ? 'Enabled, dry run on.' : 'Enabled and ready.')
      : 'Disabled until you complete setup.',
  );
  calendarCard.addClass('task-manager-sync-card--featured');
  const statusRow = calendarCard.createDiv({ cls: 'task-manager-sync-pills' });
  statusRow.createEl('span', { text: plugin.settings.googleCalendarEnabled ? t('settings.integration.enabledNotVerified') : t('settings.integration.disabled'), cls: `task-manager-sync-pill ${plugin.settings.googleCalendarEnabled ? 'is-warn' : 'is-off'}` });
  statusRow.createEl('span', { text: plugin.settings.googleCalendarDryRun ? 'Dry run' : 'Live', cls: `task-manager-sync-pill ${plugin.settings.googleCalendarDryRun ? 'is-warn' : 'is-on'}` });
  const calendarActions = calendarCard.createDiv({ cls: 'task-manager-sync-card__actions' });
  calendarActions.createEl('button', { text: t('settings.googleTasks.setupWizard'), cls: 'mod-cta task-manager-sync-card__button' }).addEventListener('click', () => plugin.openGoogleCalendarSetupWizard());
  calendarActions.createEl('button', { text: t('settings.googleTasks.quickAdd'), cls: 'task-manager-sync-card__button' }).addEventListener('click', () => plugin.openGoogleCalendarQuickCaptureModal());

  new Setting(containerEl)
    .setName(t('settings.googleTasks.enableGoogleCalendarSync'))
    .setDesc(t('settings.googleTasks.syncTasksTaggedGoogleCalendarIntoAllDayCalendarEvents'))
    .addToggle((toggle) => toggle.setValue(plugin.settings.googleCalendarEnabled).onChange(async (value) => {
      plugin.settings.googleCalendarEnabled = value;
      await plugin.saveSettings();
      display();
    }));

  if (plugin.settings.googleCalendarEnabled && showAdvanced) {
    new Setting(containerEl)
      .setName(t('settings.googleTasks.calendarId'))
      .setDesc(t('settings.googleTasks.calendarToWriteToDefaultsToPrimary'))
      .addText((text) => text.setPlaceholder(t('settings.googleTasks.primary')).setValue(plugin.settings.googleCalendarId).onChange(async (value) => {
        plugin.settings.googleCalendarId = value.trim() || 'primary';
        await plugin.saveSettings();
      }));
    new Setting(containerEl)
      .setName(t('settings.googleTasks.useDefaultReminders'))
      .setDesc(t('settings.googleTasks.letGoogleCalendarUseItsDefaultReminderBehavior'))
      .addToggle((toggle) => toggle.setValue(plugin.settings.googleCalendarUseDefaultReminders).onChange(async (value) => {
        plugin.settings.googleCalendarUseDefaultReminders = value;
        await plugin.saveSettings();
        display();
      }));
    if (!plugin.settings.googleCalendarUseDefaultReminders) {
      new Setting(containerEl)
        .setName(t('settings.googleTasks.reminderMinutes'))
        .setDesc(t('settings.googleTasks.minutesBeforeTheEventToFireThePopupReminder'))
        .addText((text) => text.setPlaceholder(t('settings.googleTasks.10')).setValue(String(plugin.settings.googleCalendarReminderMinutes)).onChange(async (value) => {
          const minutes = Number.parseInt(value, 10);
          if (Number.isFinite(minutes) && minutes >= 0) {
            plugin.settings.googleCalendarReminderMinutes = minutes;
            await plugin.saveSettings();
          }
        }));
    }
    new Setting(containerEl)
      .setName(t('settings.googleTasks.dryRunMode'))
      .setDesc(t('settings.googleTasks.countPlannedEventsWithoutWritingThemToGoogleCalendar'))
      .addToggle((toggle) => toggle.setValue(plugin.settings.googleCalendarDryRun).onChange(async (value) => {
        plugin.settings.googleCalendarDryRun = value;
        await plugin.saveSettings();
      }));
  }
}
