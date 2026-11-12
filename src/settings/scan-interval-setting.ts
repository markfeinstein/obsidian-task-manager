import { Setting } from 'obsidian';
import { t } from '../i18n';
import type { SettingsHost } from '../settings-contract';

export function renderScanIntervalSetting(container: HTMLElement, plugin: SettingsHost): void {
  const setting = new Setting(container)
    .setName(t('settings.label.scanInterval'))
    .setDesc(t('settings.desc.scanInterval'));
  const error = setting.settingEl.createDiv({ cls: 'task-manager-setting-validation' });
  error.setAttr('role', 'alert');
  error.hidden = true;
  setting.addText((text) => {
    text.inputEl.type = 'number';
    text.inputEl.min = '1';
    text.inputEl.max = '1440';
    text.setValue(String(plugin.settings.scanIntervalMinutes)).onChange(async (raw) => {
      const value = Number(raw);
      const valid = Number.isSafeInteger(value) && value >= 1 && value <= 1440;
      text.inputEl.setAttr('aria-invalid', String(!valid));
      error.hidden = valid;
      error.setText(valid ? '' : t('settings.validation.scanInterval'));
      if (!valid) return;
      plugin.settings.scanIntervalMinutes = value;
      await plugin.saveSettings();
      plugin.refreshWatchers();
    });
  });
}
