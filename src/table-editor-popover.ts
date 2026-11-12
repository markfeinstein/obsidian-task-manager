import { resolveFloatingPosition } from './floating-position';
import { FocusTrap } from './keyboard-nav';

let tableEditorPopoverSequence = 0;
let closeActiveTableEditor: (() => void) | null = null;

export interface TableEditorPopover {
  panel: HTMLDivElement;
  content: HTMLDivElement;
  status: HTMLDivElement;
  close(): void;
  focusInitial(control: HTMLElement): void;
  setBusy(busy: boolean): void;
  showError(error: unknown): void;
}

/** Accessible, viewport-aware owner for Table's body-level editors. */
export function createTableEditorPopover(
  anchor: HTMLElement,
  options: { title: string; description?: string; className?: string; resolveFocusTarget?: () => HTMLElement | null },
): TableEditorPopover {
  closeActiveTableEditor?.();
  const panel = document.body.createDiv({ cls: `task-manager-table-list-editor${options.className ? ` ${options.className}` : ''}` });
  const titleId = `task-manager-table-editor-title-${tableEditorPopoverSequence++}`;
  panel.setAttribute('role', 'dialog');
  panel.setAttribute('aria-modal', 'false');
  panel.setAttribute('aria-labelledby', titleId);
  const title = panel.createEl('div', { text: options.title, cls: 'task-manager-table-list-editor-title', attr: { id: titleId } });
  title.tabIndex = -1;
  if (options.description) panel.createEl('div', { text: options.description, cls: 'task-manager-table-list-editor-subtitle' });
  const content = panel.createDiv({ cls: 'task-manager-table-list-editor-content' });
  const status = panel.createDiv({ cls: 'task-manager-table-list-editor-status' });
  status.setAttr('role', 'alert');
  status.setAttr('aria-live', 'assertive');
  status.hidden = true;

  let closed = false;
  let initialFocusTimer: ReturnType<typeof setTimeout> | undefined;
  const focusTrap = new FocusTrap(panel);
  const ownerWindow = panel.ownerDocument?.defaultView ?? (typeof window === 'undefined' ? undefined : window);
  const position = (): void => {
    if (closed) return;
    const anchorRect = anchor.getBoundingClientRect();
    const panelRect = panel.getBoundingClientRect();
    const margin = 8;
    const viewport = { left: margin, top: margin, width: Math.max(0, (ownerWindow?.innerWidth ?? 1024) - margin * 2), height: Math.max(0, (ownerWindow?.innerHeight ?? 768) - margin * 2) };
    const direction = ownerWindow?.getComputedStyle?.(anchor).direction === 'rtl' ? 'rtl' : 'ltr';
    const placement = resolveFloatingPosition(anchorRect, { width: panelRect.width, height: panelRect.height }, viewport, direction);
    const left = direction === 'ltr'
      ? viewport.left + placement.inlineStart
      : viewport.left + viewport.width - placement.inlineStart - panelRect.width;
    panel.style.left = `${left}px`;
    panel.style.top = `${viewport.top + placement.blockStart}px`;
    panel.style.maxHeight = `${viewport.height}px`;
  };
  const close = (): void => {
    if (closed) return;
    closed = true;
    if (initialFocusTimer !== undefined) clearTimeout(initialFocusTimer);
    initialFocusTimer = undefined;
    document.removeEventListener('pointerdown', onOutside, true);
    ownerWindow?.removeEventListener?.('resize', position);
    ownerWindow?.removeEventListener?.('scroll', position, true);
    focusTrap.destroy();
    panel.remove();
    if (closeActiveTableEditor === close) closeActiveTableEditor = null;
    const focusTarget = anchor.isConnected ? anchor : options.resolveFocusTarget?.();
    if (focusTarget?.isConnected) focusTarget.focus();
  };
  const onOutside = (event: Event): void => {
    if (!panel.contains(event.target as Node) && event.target !== anchor) close();
  };
  panel.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
  });
  document.addEventListener('pointerdown', onOutside, true);
  ownerWindow?.addEventListener?.('resize', position);
  ownerWindow?.addEventListener?.('scroll', position, true);
  if (ownerWindow?.setTimeout) ownerWindow.setTimeout(() => position(), 0);
  else globalThis.setTimeout(position, 0);
  closeActiveTableEditor = close;

  return {
    panel,
    content,
    status,
    close,
    focusInitial: (control) => {
      if (initialFocusTimer !== undefined) clearTimeout(initialFocusTimer);
      focusTrap.refresh();
      initialFocusTimer = globalThis.setTimeout(() => {
        initialFocusTimer = undefined;
        if (!closed && closeActiveTableEditor === close && panel.isConnected && panel.contains(control)) control.focus();
      }, 0);
    },
    setBusy: (busy) => {
      panel.setAttr('aria-busy', String(busy));
      for (const control of Array.from(panel.querySelectorAll<HTMLInputElement | HTMLButtonElement | HTMLSelectElement>('input, button, select'))) control.disabled = busy;
    },
    showError: (error) => {
      status.hidden = false;
      status.setText(error instanceof Error ? error.message : String(error));
    },
  };
}
