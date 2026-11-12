import { Modal, Setting, setIcon, type App } from 'obsidian';
import type { DashboardWidgetConfig } from './types';
import type { WidgetRenderer, WidgetShortcut } from './dashboard';
import { FocusManager, FocusTrap, setupSwipeHandler } from './keyboard-nav';
import { t } from './i18n';

export { setupSwipeHandler };

const GENERAL_SHORTCUTS = [
  { keys: 'Tab', description: 'Move focus between widgets' },
  { keys: 'Arrow keys', description: 'Move the focused widget (edit mode)' },
  { keys: 'Shift + Arrow keys', description: 'Resize the focused widget (edit mode)' },
];

export class WidgetInfoModal extends Modal {
  private readonly focusManager = new FocusManager();
  private focusTrap: FocusTrap | null = null;

  constructor(app: App, private readonly renderer: WidgetRenderer, private readonly config: DashboardWidgetConfig) { super(app); }

  onOpen(): void {
    this.focusManager.captureCurrentFocus();
    const titleId = `tm-dash-info-title-${Date.now()}`;
    this.modalEl.setAttr('role', 'dialog');
    this.modalEl.setAttr('aria-modal', 'true');
    this.modalEl.setAttr('aria-labelledby', titleId);
    this.contentEl.addClass('tm-dash-info-modal');
    const head = this.contentEl.createDiv('tm-dash-info-head');
    const iconEl = head.createDiv('tm-dash-info-icon');
    setIcon(iconEl, this.renderer.icon || 'info');
    const heading = head.createDiv('tm-dash-info-heading');
    heading.createEl('h2', { text: this.config.title || this.renderer.title, attr: { id: titleId } });
    if (this.config.title && this.config.title !== this.renderer.title) heading.createDiv({ cls: 'tm-dash-info-subtitle', text: this.renderer.title });
    const body = this.renderer.details || this.renderer.description;
    if (body) this.contentEl.createEl('p', { cls: 'tm-dash-info-desc', text: body });
    if (this.renderer.shortcuts?.length) {
      this.contentEl.createEl('h3', { cls: 'tm-dash-info-subhead', text: 'Widget shortcuts' });
      this.renderShortcuts(this.renderer.shortcuts);
    }
    this.contentEl.createEl('h3', { cls: 'tm-dash-info-subhead', text: 'Dashboard shortcuts' });
    this.renderShortcuts(GENERAL_SHORTCUTS);
    const close = this.contentEl.createEl('button', { text: t('modal.btn.close'), attr: { type: 'button' } });
    close.addEventListener('click', () => this.close());
    this.focusTrap = new FocusTrap(this.modalEl);
    this.focusTrap.refresh();
    close.focus();
  }

  private renderShortcuts(shortcuts: WidgetShortcut[]): void {
    const list = this.contentEl.createDiv('tm-dash-info-shortcuts');
    for (const shortcut of shortcuts) {
      const row = list.createDiv('tm-dash-info-shortcut');
      const keys = row.createDiv('tm-dash-info-keys');
      for (const key of shortcut.keys.split('+').map((part) => part.trim()).filter(Boolean)) keys.createEl('kbd', { cls: 'tm-dash-info-kbd', text: key });
      row.createDiv({ cls: 'tm-dash-info-shortcut-desc', text: shortcut.description });
    }
  }

  onClose(): void {
    this.focusTrap?.destroy();
    this.focusTrap = null;
    this.contentEl.empty();
    this.focusManager.restoreFocus();
  }
}

export class WidgetConfigModal extends Modal {
  private readonly focusManager = new FocusManager();
  private focusTrap: FocusTrap | null = null;

  constructor(app: App, private readonly config: DashboardWidgetConfig, private readonly onSave: () => void) { super(app); }

  onOpen(): void {
    this.focusManager.captureCurrentFocus();
    const titleId = `tm-dash-config-title-${Date.now()}`;
    this.modalEl.setAttr('role', 'dialog');
    this.modalEl.setAttr('aria-modal', 'true');
    this.modalEl.setAttr('aria-labelledby', titleId);
    this.contentEl.addClass('tm-dash-config-modal');
    this.contentEl.createEl('h2', { text: this.config.type === 'saved-query' ? 'Configure query widget' : 'Configure widget', attr: { id: titleId } });
    let title = this.config.title;
    new Setting(this.contentEl).setName('Title').setDesc('The heading shown on this card.').addText((text) => text.setPlaceholder('Widget title').setValue(this.config.title).onChange((value) => { title = value; }));
    let query = this.config.query ?? '';
    let customField = typeof this.config.customConfig?.field === 'string' ? this.config.customConfig.field : '';
    if (this.config.type === 'saved-query') {
      const querySetting = new Setting(this.contentEl).setName('Query').setDesc('Any Task Manager query — e.g. "not done\\nsort by due".');
      querySetting.settingEl.addClass('tm-dash-config-query');
      querySetting.addTextArea((area) => { area.setPlaceholder('not done\nsort by due').setValue(query).onChange((value) => { query = value; }); area.inputEl.rows = 6; area.inputEl.addClass('tm-dash-config-query-input'); });
    }
    if (this.config.type === 'custom-field-breakdown' || this.config.type === 'goals-progress') {
      const isGoals = this.config.type === 'goals-progress';
      new Setting(this.contentEl).setName(isGoals ? 'Goal field key' : 'Custom field key').setDesc(isGoals ? 'Custom field used to group goals (default “goal”). #goal/<name> tags are always included.' : 'Optional custom field key to group by. Leave blank to automatically use the most-populated custom field.').addText((text) => text.setPlaceholder(isGoals ? 'goal' : 'client').setValue(customField).onChange((value) => { customField = value; }));
    }
    const buttons = this.contentEl.createDiv('tm-dash-config-buttons');
    const save = buttons.createEl('button', { text: t('modal.btn.save'), cls: 'mod-cta' });
    save.addEventListener('click', () => {
      this.config.title = title.trim() || this.config.title;
      if (this.config.type === 'saved-query') this.config.query = query;
      if (this.config.type === 'custom-field-breakdown' || this.config.type === 'goals-progress') {
        const field = customField.trim();
        this.config.customConfig = field ? { ...(this.config.customConfig ?? {}), field } : { ...(this.config.customConfig ?? {}), field: undefined };
      }
      this.onSave();
      this.close();
    });
    buttons.createEl('button', { text: t('modal.btn.cancel') }).addEventListener('click', () => this.close());
    this.focusTrap = new FocusTrap(this.modalEl);
    this.focusTrap.refresh();
    this.contentEl.querySelector<HTMLInputElement>('input, textarea')?.focus();
  }

  onClose(): void {
    this.focusTrap?.destroy();
    this.focusTrap = null;
    this.contentEl.empty();
    this.focusManager.restoreFocus();
  }
}
