import { Modal, Setting, type App } from 'obsidian';
import { FocusTrap } from '../keyboard-nav';
import type { ModalFieldVisibilityKey } from '../types';
import { t } from '../i18n';

export type VisibleFieldsDraft = Record<ModalFieldVisibilityKey, boolean>;

const FIELD_LABELS: ReadonlyArray<readonly [ModalFieldVisibilityKey, string]> = [
  ['priority', 'Priority'], ['due', 'Due date'], ['scheduled', 'Scheduled date'],
  ['start', 'Start date'], ['created', 'Created date'], ['done', 'Done date'],
  ['cancelled', 'Cancelled date'], ['reminder', 'Reminder'], ['time', 'Time'],
  ['recurrence', 'Recurrence'], ['onCompletion', 'On completion'], ['id', 'Id'],
  ['before_this', 'Blocked by (depends on)'], ['after_this', 'Blocking (blocked by this)'],
  ['effort', 'Effort'], ['actual', 'Actual time'], ['followUp', 'Follow-up'],
  ['cost', 'Cost'], ['pinned', 'Pinned'],
];

let visibleFieldsModalSequence = 0;

export class VisibleFieldsModal extends Modal {
  private readonly draft: VisibleFieldsDraft;
  private focusTrap: FocusTrap | null = null;
  private keydownHandler: ((event: KeyboardEvent) => void) | null = null;
  private saving = false;
  private closed = false;

  constructor(
    app: App,
    current: VisibleFieldsDraft,
    private readonly onCommit: (next: VisibleFieldsDraft) => Promise<void> | void,
    private readonly onClosed: (committed: boolean) => void,
  ) {
    super(app);
    this.draft = { ...current };
  }

  onOpen(): void {
    this.closed = false;
    const id = `task-manager-visible-fields-${visibleFieldsModalSequence++}`;
    const descriptionId = `${id}-description`;
    this.modalEl.addClass('task-manager-visible-fields-modal');
    this.modalEl.setAttr('role', 'dialog');
    this.modalEl.setAttr('aria-modal', 'true');
    this.modalEl.setAttr('aria-labelledby', id);
    this.modalEl.setAttr('aria-describedby', descriptionId);
    this.titleEl.id = id;
    this.titleEl.setText(t('settings.label.modalFields'));
    this.contentEl.empty();
    const description = this.contentEl.createEl('p', { text: t('modal.visibleFields.description') });
    description.id = descriptionId;
    const fields = this.contentEl.createDiv('task-manager-visible-fields-list');
    let firstToggle: HTMLElement | null = null;
    for (const [key, label] of FIELD_LABELS) {
      new Setting(fields)
        .setName(label)
        .addToggle((toggle) => {
          toggle.toggleEl.setAttr('aria-label', label);
          toggle.setValue(this.draft[key]).onChange((value) => { this.draft[key] = value; });
          firstToggle ??= toggle.toggleEl;
        });
    }
    const error = this.contentEl.createDiv('task-manager-visible-fields-error');
    error.setAttr('role', 'alert');
    error.setAttr('aria-live', 'assertive');
    error.tabIndex = -1;
    const actions = this.contentEl.createDiv('task-manager-visible-fields-actions');
    const cancel = actions.createEl('button', { text: t('modal.btn.cancel'), type: 'button' });
    const done = actions.createEl('button', { text: t('dashboard.action.done'), type: 'button', cls: 'mod-cta' });
    cancel.addEventListener('click', () => this.close());
    done.addEventListener('click', () => {
      if (this.saving) return;
      this.saving = true;
      cancel.disabled = true;
      done.disabled = true;
      error.setText(t('modal.visibleFields.saving'));
      void Promise.resolve(this.onCommit({ ...this.draft })).then(() => {
        this.closeCommitted();
      }).catch((cause: unknown) => {
        this.saving = false;
        cancel.disabled = false;
        done.disabled = false;
        error.setText(`Could not save visible fields: ${cause instanceof Error ? cause.message : String(cause)}`);
        error.focus();
      });
    });
    this.keydownHandler = (event) => {
      if (event.key !== 'Escape' || this.saving) return;
      event.preventDefault();
      event.stopPropagation();
      this.close();
    };
    this.contentEl.addEventListener('keydown', this.keydownHandler);
    this.focusTrap = new FocusTrap(this.contentEl);
    window.setTimeout(() => firstToggle?.focus(), 0);
  }

  close(): void {
    const committed = Boolean((this as VisibleFieldsModal & { committed?: boolean }).committed);
    if (this.saving && !committed && !this.closed) return;
    super.close();
  }

  private closeCommitted(): void {
    (this as VisibleFieldsModal & { committed?: boolean }).committed = true;
    this.close();
  }

  onClose(): void {
    if (this.closed) return;
    this.closed = true;
    const committed = Boolean((this as VisibleFieldsModal & { committed?: boolean }).committed);
    if (this.keydownHandler) this.contentEl.removeEventListener('keydown', this.keydownHandler);
    this.keydownHandler = null;
    this.focusTrap?.destroy();
    this.focusTrap = null;
    this.contentEl.empty();
    this.onClosed(committed);
  }
}
