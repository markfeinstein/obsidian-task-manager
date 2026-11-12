/**
 * quick-capture-modal.ts
 *
 * QuickCaptureModal (simplified quick-add with description/due/priority) and
 * QuickAddTaskModal (NLP-powered natural-language input).
 * Extracted from main.ts.
 */

import { Modal, Notice, Setting } from 'obsidian';
import type { App } from 'obsidian';
import { FocusManager, FocusTrap } from '../keyboard-nav';
import type { TaskManagerSettings } from '../types';
import { resolveFlexibleDate, todayString } from '../date-utils';
import { formatParsedNLPAsTaskLine, parseNLPInput, type NLPLocale } from '../nlp-parser';
import { getLocale, t } from '../i18n';

let quickAddInputSequence = 0;

function priorityLabel(value: string): string {
  switch (value) {
    case 'lowest': return t('priority.lowest');
    case 'low': return t('priority.low');
    case 'medium': return t('priority.medium');
    case 'high': return t('priority.high');
    case 'highest': return t('priority.highest');
    case 'normal':
    default: return t('priority.normal');
  }
}

export class QuickCaptureModal extends Modal {
  private focusTrap: FocusTrap | null = null;
  private focusManager = new FocusManager();
  private submitting = false;
  private cancelButton?: HTMLButtonElement;
  private submitButton?: HTMLButtonElement;
  private submitStatus?: HTMLElement;
  private submitLabel = '';
  private openGeneration = 0;
  private initialFocusTimer: number | null = null;

  constructor(
    app: App,
    private readonly settings: TaskManagerSettings,
    private readonly onCapture: (taskLine: string) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.focusManager.captureCurrentFocus();
    const { contentEl } = this;
    contentEl.empty();
    const generation = ++this.openGeneration;
    this.modalEl.setAttribute('role', 'dialog');
    this.modalEl.setAttribute('aria-modal', 'true');
    this.modalEl.setAttribute('aria-label', t('modal.quickCapture.title'));
    contentEl.createEl('h2', { text: t('modal.quickCapture.title') });

    let description = '';
    let due = '';
    let resolvedDue: string | null = null;
    let dueInput: HTMLInputElement | null = null;
    let dueFeedback: HTMLElement | null = null;
    let descriptionInput: HTMLInputElement | undefined;
    let priority = 'normal';

    new Setting(contentEl).setName(t('modal.field.description')).addText((text) => {
      descriptionInput = text.inputEl;
      text.setPlaceholder(t('modal.field.descriptionPlaceholder')).onChange((v) => {
        description = v;
        if (v.trim()) descriptionInput?.removeAttribute('aria-invalid');
      });
      text.inputEl.style.width = '100%';
      this.initialFocusTimer = window.setTimeout(() => {
        this.initialFocusTimer = null;
        if (generation === this.openGeneration && !this.submitting) text.inputEl.focus();
      }, 50);
    });

    const dueFeedbackId = `task-manager-quick-capture-due-feedback-${quickAddInputSequence++}`;
    const updateDueFeedback = (announceError = false): boolean => {
      const value = due.trim();
      resolvedDue = value ? resolveFlexibleDate(value, todayString(), { onlyFuture: true }) : null;
      if (!dueInput || !dueFeedback) return !value || resolvedDue !== null;
      if (value && !resolvedDue) dueInput.setAttribute('aria-invalid', 'true');
      else dueInput.removeAttribute('aria-invalid');
      dueFeedback.hidden = !value;
      dueFeedback.setAttr('role', announceError && value && !resolvedDue ? 'alert' : 'status');
      dueFeedback.setText(value ? resolvedDue ? t('modal.quickCapture.dueResolved', { date: resolvedDue }) : t('modal.quickCapture.dueInvalid') : '');
      return !value || resolvedDue !== null;
    };
    new Setting(contentEl).setName(t('modal.quickCapture.dueDate')).addText((text) => {
      dueInput = text.inputEl;
      dueInput.setAttr('aria-describedby', dueFeedbackId);
      text.setPlaceholder(t('modal.quickCapture.dueDatePlaceholder')).onChange((value) => { due = value; updateDueFeedback(); });
    });
    dueFeedback = contentEl.createDiv({ cls: 'task-manager-quick-capture-due-feedback', attr: { id: dueFeedbackId, role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' } });
    dueFeedback.hidden = true;

    new Setting(contentEl).setName(t('modal.field.priority')).addDropdown((dd) => {
      for (const p of ['normal', 'lowest', 'low', 'medium', 'high', 'highest'] as const) dd.addOption(p, priorityLabel(p));
      dd.setValue('normal').onChange((v) => { priority = v; });
    });

    this.submitStatus = contentEl.createDiv({ cls: 'task-manager-quick-capture-status' });
    this.submitStatus.id = 'task-manager-quick-capture-status';
    this.submitStatus.setAttr('role', 'alert');
    this.submitStatus.setAttr('aria-live', 'assertive');
    this.submitStatus.hidden = true;
    descriptionInput?.setAttribute('aria-errormessage', this.submitStatus.id);
    this.submitLabel = t('modal.quickCapture.capture');

    const submit = async (): Promise<void> => {
      if (this.submitting) return;
      if (!description.trim()) {
        descriptionInput?.setAttribute('aria-invalid', 'true');
        if (this.submitStatus) { this.submitStatus.hidden = false; this.submitStatus.setText(t('modal.validation.descriptionRequired')); }
        descriptionInput?.focus();
        return;
      }
      if (!updateDueFeedback(true)) { dueInput?.focus(); return; }
      const today = todayString();
      const createdDate = this.settings.setCreatedDate ? ` ➕ ${today}` : '';
      const priorityEmoji = ({ lowest: ' ⏬', low: ' 🔽', medium: ' 🔼', high: ' ⏫', highest: ' 🔺', normal: '' } as Record<string, string>)[priority] ?? '';
      const duePart = resolvedDue ? ` 📅 ${resolvedDue}` : '';
      const globalFilter = this.settings.globalFilter ? ` ${this.settings.globalFilter}` : '';
      const line = `- [ ] ${description.trim()}${globalFilter}${createdDate}${priorityEmoji}${duePart}`;
      this.setSubmitting(true);
      try {
        await this.onCapture(line);
        if (generation !== this.openGeneration) { this.setSubmitting(false); return; }
        this.setSubmitting(false);
        this.close();
      } catch (error) {
        if (generation !== this.openGeneration) { this.setSubmitting(false); return; }
        this.setSubmitting(false);
        const message = error instanceof Error ? error.message : String(error);
        if (this.submitStatus) { this.submitStatus.hidden = false; this.submitStatus.setText(message); }
        this.submitButton?.focus();
        new Notice(message);
      }
    };

    new Setting(contentEl)
      .addButton((btn) => {
        btn.setButtonText(t('modal.btn.cancel')).onClick(() => this.close());
        this.cancelButton = btn.buttonEl;
      })
      .addButton((btn) => {
        btn.setCta().setButtonText(this.submitLabel).onClick(() => { void submit(); });
        this.submitButton = btn.buttonEl;
        this.submitButton.setAttribute('aria-describedby', this.submitStatus?.id ?? '');
      });

    contentEl.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void submit(); }
    });
    this.focusTrap = new FocusTrap(contentEl);
    this.setSubmitting(this.submitting);
  }

  onClose(): void {
    if (this.initialFocusTimer !== null) window.clearTimeout(this.initialFocusTimer);
    this.initialFocusTimer = null;
    this.focusTrap?.destroy();
    this.focusTrap = null;
    this.openGeneration += 1;
    this.cancelButton = undefined;
    this.submitButton = undefined;
    this.submitStatus = undefined;
    this.focusManager.restoreFocus();
    this.contentEl.empty();
  }

  private setSubmitting(value: boolean): void {
    this.submitting = value;
    if (value && this.initialFocusTimer !== null) {
      window.clearTimeout(this.initialFocusTimer);
      this.initialFocusTimer = null;
    }
    if (value) this.contentEl.setAttr('aria-busy', 'true');
    else this.contentEl.removeAttribute('aria-busy');
    if (this.cancelButton) this.cancelButton.disabled = value;
    if (this.submitButton) {
      this.submitButton.disabled = value;
      this.submitButton.setText(value ? `${this.submitLabel}…` : this.submitLabel);
    }
    if (value && this.submitStatus) { this.submitStatus.hidden = true; this.submitStatus.setText(''); }
  }
}

export class GoogleCalendarQuickCaptureModal extends Modal {
  private static readonly quickExamples = [
    'tomorrow 3pm planning #team',
    'Friday 9am review #calendar',
    'next week follow-up',
  ];

  private focusTrap: FocusTrap | null = null;
  private focusManager = new FocusManager();
  private submitting = false;
  private cancelButton?: HTMLButtonElement;
  private submitButton?: HTMLButtonElement;
  private submitStatus?: HTMLElement;
  private readonly submitLabel = 'Add task';
  private openGeneration = 0;

  constructor(
    app: App,
    private readonly settings: TaskManagerSettings,
    private readonly onCapture: (taskLine: string) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    this.focusManager.captureCurrentFocus();
    const { contentEl } = this;
    contentEl.empty();
    const generation = ++this.openGeneration;
    this.modalEl.setAttribute('role', 'dialog');
    this.modalEl.setAttribute('aria-modal', 'true');
    this.modalEl.setAttribute('aria-label', 'Quick add calendar task');

    contentEl.createEl('h2', { text: 'Calendar task quick add' });
    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: 'Create a local task that can later sync to Google Calendar. Keep the note short, then add the date and optional title.',
    });

    const state = { raw: '', title: '', date: '', time: '' };

    const datalist = contentEl.createEl('datalist');
    datalist.id = 'google-calendar-quick-add-examples';
    for (const example of GoogleCalendarQuickCaptureModal.quickExamples) {
      datalist.createEl('option', { value: example });
    }

    new Setting(contentEl).setName('Quick input (optional)').setDesc('Use one line like “tomorrow 3pm planning #team” or leave blank to fill the fields below.').addText((text) => {
      text.setPlaceholder('Tomorrow 3pm planning #team').onChange((value) => { state.raw = value; });
      text.inputEl.addClass('task-manager-quick-add-input');
      text.inputEl.setAttribute('list', 'google-calendar-quick-add-examples');
      text.inputEl.style.width = '100%';
      window.setTimeout(() => text.inputEl.focus(), 50);
    });

    const examples = contentEl.createDiv({ cls: 'task-manager-quick-add-examples' });
    for (const example of GoogleCalendarQuickCaptureModal.quickExamples) {
      examples.createEl('button', { text: example, cls: 'task-manager-quick-add-example' }).addEventListener('click', () => {
        state.raw = example;
        const input = contentEl.querySelector<HTMLInputElement>('.task-manager-quick-add-input');
        if (input) {
          input.value = example;
          input.focus();
        }
      });
    }

    new Setting(contentEl).setName('Task title').addText((text) => {
      text.setPlaceholder('Team planning').onChange((value) => { state.title = value; });
      text.inputEl.style.width = '100%';
    });

    new Setting(contentEl).setName('Date').addText((text) => {
      text.setPlaceholder('2026-06-11').onChange((value) => { state.date = value.trim(); });
    });

    new Setting(contentEl).setName('Time (optional)').addText((text) => {
      text.setPlaceholder('09:00').onChange((value) => { state.time = value.trim(); });
    });

    this.submitStatus = contentEl.createDiv({ cls: 'task-manager-google-calendar-capture-status' });
    this.submitStatus.id = 'task-manager-google-calendar-capture-status';
    this.submitStatus.setAttr('role', 'alert');
    this.submitStatus.setAttr('aria-live', 'assertive');
    this.submitStatus.hidden = true;

    const submit = async (): Promise<void> => {
      if (this.submitting) return;
      const line = state.raw.trim()
        ? this.parseQuickInput(state.raw)
        : this.buildStructuredLine(state);
      if (!line) {
        new Notice('Task title is required');
        return;
      }
      this.setSubmitting(true);
      try {
        await this.onCapture(line);
        if (generation !== this.openGeneration) { this.setSubmitting(false); return; }
        this.setSubmitting(false);
        this.close();
      } catch (error) {
        if (generation !== this.openGeneration) { this.setSubmitting(false); return; }
        this.setSubmitting(false);
        const message = error instanceof Error ? error.message : String(error);
        if (this.submitStatus) { this.submitStatus.hidden = false; this.submitStatus.setText(message); }
        this.submitButton?.focus();
        new Notice(message);
      }
    };

    new Setting(contentEl)
      .addButton((btn) => {
        btn.setButtonText('Cancel').onClick(() => this.close());
        this.cancelButton = btn.buttonEl;
      })
      .addButton((btn) => {
        btn.setCta().setButtonText(this.submitLabel).onClick(() => { void submit(); });
        this.submitButton = btn.buttonEl;
        this.submitButton.setAttribute('aria-describedby', this.submitStatus?.id ?? '');
      });

    contentEl.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        void submit();
      }
    });
    this.focusTrap = new FocusTrap(contentEl);
    this.setSubmitting(this.submitting);
  }

  onClose(): void {
    this.focusTrap?.destroy();
    this.focusTrap = null;
    this.openGeneration += 1;
    this.cancelButton = undefined;
    this.submitButton = undefined;
    this.submitStatus = undefined;
    this.focusManager.restoreFocus();
    this.contentEl.empty();
  }

  private setSubmitting(value: boolean): void {
    this.submitting = value;
    if (value) this.contentEl.setAttr('aria-busy', 'true');
    else this.contentEl.removeAttribute('aria-busy');
    if (this.cancelButton) this.cancelButton.disabled = value;
    if (this.submitButton) {
      this.submitButton.disabled = value;
      this.submitButton.setText(value ? `${this.submitLabel}…` : this.submitLabel);
    }
    if (value && this.submitStatus) { this.submitStatus.hidden = true; this.submitStatus.setText(''); }
  }

  private parseQuickInput(raw: string): string {
    const today = todayString();
    const locale = getLocale() as NLPLocale;
    const parsed = parseNLPInput(raw, today, locale);
    if (!parsed.description.trim()) return '';
    let line = formatParsedNLPAsTaskLine(parsed, this.settings.setCreatedDate, this.settings.dateOutputAsWikiLinks ? 'wikilink' : 'plain');
    if (!line) return '';
    if (!line.includes('#google-calendar')) line = `${line} #google-calendar`;
    return line;
  }

  private buildStructuredLine(state: { title: string; date: string; time: string }): string {
    if (!state.title.trim()) return '';
    const duePart = state.date ? ` 📅 ${state.date}${state.time ? ` ${state.time}` : ''}` : '';
    return `- [ ] ${state.title.trim()} #google-calendar${duePart}`;
  }
}

// ── QuickAddTaskModal ────────────────────────────────────────────────────────

export class QuickAddTaskModal extends Modal {
  private input!: HTMLInputElement;
  private previewEl!: HTMLElement;
  private previewTimer: number | null = null;
  private focusTrap: FocusTrap | null = null;
  private focusManager = new FocusManager();

  constructor(
    app: App,
    private readonly settings: TaskManagerSettings,
    private readonly onAdd: (taskLine: string) => void,
  ) {
    super(app);
  }

  onOpen(): void {
    this.focusManager.captureCurrentFocus();
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('task-manager-quick-add-modal');
    this.modalEl.setAttribute('role', 'dialog');
    this.modalEl.setAttribute('aria-modal', 'true');
    this.modalEl.setAttribute('aria-label', t('modal.quickAdd.title'));
    contentEl.createEl('h3', { text: t('modal.quickAdd.title') });
    contentEl.createEl('p', {
      cls: 'setting-item-description',
      text: t('modal.quickAdd.description'),
    });

    const inputId = `task-manager-quick-add-${quickAddInputSequence++}`;
    const inputLabel = contentEl.createEl('label', { text: t('modal.field.description') });
    inputLabel.htmlFor = inputId;
    this.input = contentEl.createEl('input');
    this.input.id = inputId;
    this.input.type = 'text';
    this.input.placeholder = t('modal.quickAdd.placeholder');
    this.input.addClass('task-manager-quick-add-input');
    this.input.style.width = '100%';
    this.input.style.marginBottom = '8px';

    const previewHeading = contentEl.createEl('h4', { text: t('modal.quickAdd.previewHeading'), cls: 'task-manager-quick-add-preview-heading' });
    previewHeading.id = `${inputId}-preview-heading`;
    this.previewEl = contentEl.createEl('div', { cls: 'task-manager-quick-add-preview' });
    this.previewEl.setAttr('role', 'region');
    this.previewEl.setAttr('aria-labelledby', previewHeading.id);
    this.previewEl.setAttr('aria-live', 'polite');
    this.previewEl.setAttr('aria-atomic', 'true');
    this.previewEl.style.fontFamily = 'var(--font-monospace)';
    this.previewEl.style.fontSize = '0.85em';
    this.previewEl.style.opacity = '0.7';
    this.previewEl.style.marginBottom = '12px';
    this.previewEl.setText(t('modal.quickAdd.previewPlaceholder'));

    const examples = contentEl.createDiv({ cls: 'task-manager-quick-add-examples' });
    for (const example of ['tomorrow review PR', 'next week plan sprint', 'Friday 9am standup']) {
      examples.createEl('button', { text: example, cls: 'task-manager-quick-add-example' }).addEventListener('click', () => {
        this.input.value = example;
        this.updatePreview(example);
        this.input.focus();
      });
    }

    this.input.addEventListener('input', () => {
      if (this.previewTimer !== null) window.clearTimeout(this.previewTimer);
      this.previewTimer = window.setTimeout(() => {
        this.previewTimer = null;
        this.updatePreview(this.input.value);
      }, 120);
    });

    const btnRow = contentEl.createDiv({ cls: 'task-manager-quick-add-buttons' });
    btnRow.style.display = 'flex';
    btnRow.style.gap = '8px';
    btnRow.style.justifyContent = 'flex-end';

    const cancelBtn = btnRow.createEl('button', { text: t('modal.btn.cancel') });
    cancelBtn.addEventListener('click', () => this.close());

    const addBtn = btnRow.createEl('button', { text: t('modal.quickAdd.submit'), cls: 'mod-cta' });
    addBtn.addEventListener('click', () => this.submit());

    this.input.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); this.submit(); }
    });

    this.focusTrap = new FocusTrap(contentEl);
    window.setTimeout(() => this.input.focus(), 50);
  }

  onClose(): void {
    if (this.previewTimer !== null) window.clearTimeout(this.previewTimer);
    this.previewTimer = null;
    this.focusTrap?.destroy();
    this.focusTrap = null;
    this.focusManager.restoreFocus();
    this.contentEl.empty();
  }

  private submit(): void {
    const line = this.parseToTaskLine(this.input.value) || this.quickCalendarFallback(this.input.value);
    if (!line) { new Notice(t('modal.validation.descriptionEmpty')); return; }
    this.onAdd(line);
    this.close();
  }

  private updatePreview(raw: string): void {
    if (!raw.trim()) { this.previewEl.setText(t('modal.quickAdd.previewPlaceholder')); return; }
    const today = todayString();
    const locale = getLocale() as NLPLocale;
    const parsed = parseNLPInput(raw, today, locale);
    if (!parsed.description.trim()) { this.previewEl.setText(t('modal.quickAdd.previewPlaceholder')); return; }
    const line = formatParsedNLPAsTaskLine(parsed, this.settings.setCreatedDate, this.settings.dateFormat);
    if (!line) { this.previewEl.setText(t('modal.quickAdd.previewPlaceholder')); return; }

    this.previewEl.empty();
    // Main task line
    const lineEl = this.previewEl.createEl('div');
    lineEl.setText(line);
    // Parsed field hints
    const hints: string[] = [];
    if (parsed.dueDate)       hints.push(`${t('modal.field.dueDate')} → ${parsed.dueDate}`);
    if (parsed.scheduledDate) hints.push(`${t('modal.field.scheduledDate')} → ${parsed.scheduledDate}`);
    if (parsed.startDate)     hints.push(`${t('modal.field.startDate')} → ${parsed.startDate}`);
    if (parsed.time)          hints.push(`${t('modal.field.time')} → ${parsed.time}`);
    if (parsed.recurrence)    hints.push(`${t('modal.field.recurrence')} → ${parsed.recurrence}`);
    if (parsed.priority)      hints.push(`${t('modal.field.priority')} → ${priorityLabel(parsed.priority)}`);
    if (parsed.effort)        hints.push(`${t('modal.field.effort')} → ${parsed.effort}`);
    if (parsed.tags.length)   hints.push(`${t('modal.field.tags')} → ${parsed.tags.map((tag) => `#${tag}`).join(' ')}`);
    if (hints.length > 0) {
      const hintEl = this.previewEl.createEl('div');
      hintEl.style.fontSize = '0.8em';
      hintEl.style.opacity = '0.5';
      hintEl.style.marginTop = '2px';
      hintEl.setText(hints.join('  ·  '));
    }
  }

  private parseToTaskLine(raw: string): string {
    if (!raw.trim()) return '';
    const today = todayString();
    const locale = getLocale() as NLPLocale;
    const parsed = parseNLPInput(raw, today, locale);
    if (!parsed.description.trim()) return '';
    return formatParsedNLPAsTaskLine(parsed, this.settings.setCreatedDate, this.settings.dateFormat);
  }

  private quickCalendarFallback(raw: string): string {
    const text = raw.trim();
    if (!text) return '';
    if (/[📅⌚]/u.test(text) || /\b(today|tomorrow|next week|next month)\b/iu.test(text)) {
      return `- [ ] ${text} #google-calendar`;
    }
    return `- [ ] ${text}`;
  }
}
