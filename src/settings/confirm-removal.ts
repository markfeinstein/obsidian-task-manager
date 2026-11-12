import { Modal, Notice, type App } from 'obsidian';

/** Open a Cancel-first confirmation before permanently removing settings data. */
export function confirmSettingsRemoval(
  app: App,
  label: string,
  onConfirm: () => Promise<void>,
  options: { title?: string; description?: string; confirmLabel?: string } = {},
): void {
  const modal = new Modal(app);
  modal.titleEl.setText(options.title ?? `Remove ${label}?`);
  modal.contentEl.createEl('p', { text: options.description ?? `This will permanently remove ${label} from Task Manager settings.` });
  const actions = modal.contentEl.createDiv('task-manager-confirm-actions');
  const cancel = actions.createEl('button', { text: 'Cancel' });
  const remove = actions.createEl('button', { text: options.confirmLabel ?? 'Remove', cls: 'mod-warning' });
  cancel.addEventListener('click', () => modal.close());
  remove.addEventListener('click', () => {
    remove.disabled = true;
    void onConfirm()
      .then(() => modal.close())
      .catch((error: unknown) => {
        remove.disabled = false;
        new Notice(`Could not remove ${label}: ${error instanceof Error ? error.message : String(error)}`);
      });
  });
  modal.open();
  window.setTimeout(() => cancel.focus(), 0);
}
