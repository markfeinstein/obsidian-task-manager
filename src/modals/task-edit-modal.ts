/** Task create/edit modal with one stable form and a class-owned draft. */
import { Modal, Notice, Setting, TFile, getAllTags, type App } from 'obsidian';
import type { ModalFieldVisibilityKey, TaskManagerSettings } from '../types';
import { todayString } from '../date-utils';
import { calculateNextRecurrences } from '../task-scanner';
import { generateRecurrenceSeriesId, getCommonRecurrencePatterns } from '../recurrence-series';
import { FocusManager, FocusTrap } from '../keyboard-nav';
import {
  buildModalStatusOptions,
  computeModalLifecycleDates,
  expandDateAbbreviation,
  formatEditableTaskLine,
  normalizeModalDate,
  parseEditableTaskLine,
  randomTaskId,
  resolveModalDateInput,
  type EditableTaskLine,
} from './task-edit-helpers';
import { DependencySuggestModal, DependentTaskSuggestModal } from './dependency-modals';
import { scannableMarkdownFiles } from './modal-utils';
import { getLocaleMetadata, t } from '../i18n';
import { resolveFloatingPosition } from '../floating-position';
import { applyLocaleScope } from '../locale-scope';
import { VisibleFieldsModal, type VisibleFieldsDraft } from './visible-fields-modal';
import { parseMarkdownTaskLine } from '../task-model';

let taskEditAutocompleteSequence = 0;
let taskEditFieldSequence = 0;

type DraftTextKey = Exclude<keyof EditableTaskLine, 'tags' | 'usesDataview'>;

interface OptionalFieldDefinition {
  key: DraftTextKey;
  settingKey?: ModalFieldVisibilityKey;
  label: string;
  accessKey?: string;
  placeholder?: string;
  date?: boolean;
}

const OPTIONAL_FIELDS: readonly OptionalFieldDefinition[] = [
  { key: 'due', settingKey: 'due', label: 'Due date', accessKey: 'd', date: true },
  { key: 'scheduled', settingKey: 'scheduled', label: 'Scheduled date', accessKey: 's', date: true },
  { key: 'start', settingKey: 'start', label: 'Start date', accessKey: 'a', date: true },
  { key: 'created', settingKey: 'created', label: 'Created date', accessKey: 'c', date: true },
  { key: 'done', settingKey: 'done', label: 'Done date', accessKey: 'x', date: true },
  { key: 'cancelled', settingKey: 'cancelled', label: 'Cancelled date', accessKey: '-', date: true },
  { key: 'time', settingKey: 'time', label: 'Time (⌚)', accessKey: 'k', placeholder: '09:00' },
  { key: 'reminder', settingKey: 'reminder', label: 'Reminder (⏰)', accessKey: 'm' },
  { key: 'effort', settingKey: 'effort', label: 'Effort (⏱️)', accessKey: 'e', placeholder: 'e.g. 2h 30m' },
  { key: 'actual', settingKey: 'actual', label: 'Actual (🕐)', accessKey: 'l', placeholder: 'e.g. 1h 45m' },
  { key: 'recurrence', settingKey: 'recurrence', label: 'Recurrence', accessKey: 'r', placeholder: "e.g. 'every week'" },
  { key: 'onCompletion', settingKey: 'onCompletion', label: 'On completion', accessKey: 'o' },
  { key: 'id', settingKey: 'id', label: 'Id', accessKey: 'i' },
  { key: 'dependsOn', settingKey: 'before_this', label: 'Before this (depends on)', accessKey: 'b' },
  { key: 'followUp', settingKey: 'followUp', label: 'Follow-up (👀)' },
  { key: 'cost', settingKey: 'cost', label: 'Cost (💵)' },
  { key: 'pinned', settingKey: 'pinned', label: 'Pinned (📌)' },
  { key: 'assignee', label: 'Assignee (👤)' },
  { key: 'reviewer', label: 'Reviewer (👁️)' },
  { key: 'project', label: 'Project (📋)' },
  { key: 'team', label: 'Team (👥)' },
];

export class TaskEditModal extends Modal {
  private showAllFields = false;
  private focusTrap: FocusTrap | null = null;
  private readonly focusManager = new FocusManager();
  private autocompleteCleanup: (() => void) | null = null;
  private disposeLocaleScope?: () => void;
  private draft: EditableTaskLine | null = null;
  private initialDraft: EditableTaskLine | null = null;
  private formEl: HTMLFormElement | null = null;
  private optionalFieldsEl: HTMLElement | null = null;
  private descriptionEl: HTMLTextAreaElement | null = null;
  private statusEl: HTMLSelectElement | null = null;
  private fieldsButton: HTMLButtonElement | null = null;
  private submitErrorEl: HTMLElement | null = null;
  private cancelButton: HTMLButtonElement | null = null;
  private submitButton: HTMLButtonElement | null = null;
  private childModal: VisibleFieldsModal | null = null;
  private fieldRefs = new Map<DraftTextKey, HTMLInputElement | HTMLSelectElement>();
  private onlyFutureDates = true;
  private submitting = false;
  private submitted = false;
  private cancelNotified = false;
  private closing = false;

  constructor(
    app: App,
    private readonly settings: TaskManagerSettings,
    private readonly initialLine: string,
    private readonly onSubmit: (line: string) => void | Promise<void>,
    private readonly onCancel?: () => void,
    private readonly initialFields: Partial<EditableTaskLine> = {},
    private readonly sourcePath?: string,
    private readonly onSettingsChanged?: () => void | Promise<void>,
  ) { super(app); }

  private shouldShowField(settingKey: string, hasValue: boolean): boolean {
    return this.showAllFields || Boolean(this.settings.modalFields[settingKey as ModalFieldVisibilityKey]) || hasValue;
  }

  private addAutoRevealIndicator(element: HTMLElement, isAutoRevealed: boolean): void {
    if (!isAutoRevealed) return;
    const indicator = element.createEl('span', { cls: 'task-manager-auto-reveal-indicator' });
    indicator.setText(String.fromCodePoint(0x2728));
    indicator.title = 'Auto-revealed: field has a value';
  }

  onOpen(): void {
    this.closing = false;
    this.submitting = false;
    this.submitted = false;
    this.cancelNotified = false;
    this.focusManager.captureCurrentFocus();
    this.contentEl.empty();
    this.disposeLocaleScope?.();
    this.disposeLocaleScope = applyLocaleScope(this.contentEl);
    const title = t(this.initialLine ? 'modal.edit.title' : 'modal.create.title');
    this.modalEl.setAttr('role', 'dialog');
    this.modalEl.setAttr('aria-modal', 'true');
    this.modalEl.setAttr('aria-label', title);
    this.titleEl.setText(title);

    const defaults = this.sourcePath ? this.loadFileDefaults(this.sourcePath) : {};
    const parsed = { ...parseEditableTaskLine(this.initialLine), ...defaults, ...this.initialFields };
    if (!parsed.description) parsed.description = this.settings.globalFilter;
    if (!parsed.created && !this.initialLine && this.settings.setCreatedDate) parsed.created = todayString();
    this.draft = parsed;
    this.initialDraft = { ...parsed, tags: [...parsed.tags] };

    const form = this.contentEl.createEl('form', { cls: 'task-manager-task-edit-form' });
    this.formEl = form;
    form.addEventListener('submit', this.handleSubmit);
    form.addEventListener('keydown', this.handleFormKeydown);
    const prefix = `task-manager-task-edit-${taskEditFieldSequence++}`;

    const descriptionLabel = form.createEl('label', { text: t('modal.field.description') });
    descriptionLabel.htmlFor = `${prefix}-description`;
    const description = form.createEl('textarea');
    this.descriptionEl = description;
    description.id = `${prefix}-description`;
    description.dataset.fieldKey = 'description';
    description.addClass('task-manager-modal-description');
    description.value = parsed.description;
    description.placeholder = t('modal.field.descriptionPlaceholder');
    description.rows = 4;
    description.setAttr('role', 'combobox');
    description.setAttr('aria-autocomplete', 'list');
    description.setAttr('aria-expanded', 'false');
    this.applyAccessKey(description, 't');
    description.addEventListener('input', () => { if (this.draft) this.draft.description = description.value; this.updateAutocomplete(description); });
    const normalizeDescription = (): void => {
      description.value = description.value.replace(/[\r\n]+/gu, ' ').replace(/\s+/gu, ' ').trim();
      if (this.draft) this.draft.description = description.value;
    };
    description.addEventListener('paste', () => window.setTimeout(normalizeDescription, 0));
    description.addEventListener('drop', () => window.setTimeout(normalizeDescription, 0));
    description.addEventListener('keydown', (event) => this.handleAutocompleteKeydown(event, description));

    const statusLabel = form.createEl('label', { text: t('modal.field.status') });
    statusLabel.htmlFor = `${prefix}-status`;
    const status = form.createEl('select');
    this.statusEl = status;
    status.id = `${prefix}-status`;
    status.dataset.fieldKey = 'checkbox';
    status.addClass('task-manager-modal-status');
    this.applyAccessKey(status, 'u');
    for (const option of buildModalStatusOptions(this.settings.supportedStates, parsed.checkbox)) status.createEl('option', { text: option.text, value: option.value });
    status.value = parsed.checkbox;
    status.addEventListener('change', () => { if (this.draft) this.draft.checkbox = status.value; });

    new Setting(form)
      .setName('Show all fields')
      .setDesc('Temporarily display all available fields regardless of visibility settings.')
      .addToggle((toggle) => {
        toggle.toggleEl.dataset.fieldKey = 'show-all';
        toggle.toggleEl.setAttr('aria-label', t('settings.modal.showAll'));
        toggle.setValue(this.showAllFields).onChange((value) => {
          this.showAllFields = value;
          this.renderOptionalFields('show-all');
        });
      });

    this.optionalFieldsEl = form.createDiv('task-manager-optional-fields');
    this.renderOptionalFields('open');

    new Setting(form)
      .setName('Configure visible fields')
      .setDesc('Toggle which fields appear in this dialog.')
      .addButton((button) => {
        button.setButtonText('⚙ Fields');
        button.buttonEl.type = 'button';
        this.fieldsButton = button.buttonEl;
        button.onClick(() => this.openVisibleFieldsModal());
      });

    this.submitErrorEl = form.createDiv({ cls: 'task-manager-task-edit-error' });
    this.submitErrorEl.setAttr('role', 'alert');
    this.submitErrorEl.setAttr('aria-live', 'assertive');
    this.submitErrorEl.setAttr('aria-atomic', 'true');
    this.submitErrorEl.tabIndex = -1;
    this.submitErrorEl.hidden = true;

    new Setting(form)
      .addButton((button) => {
        button.setButtonText(t('modal.btn.cancel'));
        button.buttonEl.type = 'button';
        this.cancelButton = button.buttonEl;
        button.onClick(() => { this.notifyCancel(); this.close(); });
      })
      .addButton((button) => {
        button.setCta().setButtonText(t('modal.btn.apply'));
        button.buttonEl.type = 'submit';
        this.submitButton = button.buttonEl;
      });

    this.focusTrap = new FocusTrap(form);
    this.focusManager.focus(description);
  }

  private readonly handleFormKeydown = (event: KeyboardEvent): void => {
    if (this.childModal || event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    const target = event.target as HTMLElement | null;
    if (target instanceof HTMLTextAreaElement || target instanceof HTMLButtonElement) return;
    event.preventDefault();
    this.formEl?.requestSubmit();
  };

  private setSubmitting(value: boolean): void {
    this.submitting = value;
    if (this.cancelButton) this.cancelButton.disabled = value;
    if (this.submitButton) this.submitButton.disabled = value;
    if (value) this.formEl?.setAttr('aria-busy', 'true');
    else this.formEl?.removeAttribute('aria-busy');
  }

  private clearSubmitError(): void {
    if (!this.submitErrorEl) return;
    this.submitErrorEl.hidden = true;
    this.submitErrorEl.setText('');
    for (const control of [this.descriptionEl, ...this.fieldRefs.values()]) {
      control?.removeAttribute('aria-invalid');
      control?.removeAttribute('aria-errormessage');
    }
  }

  private failValidation(control: HTMLElement | undefined, message: string): void {
    this.setSubmitting(false);
    if (this.submitErrorEl) {
      this.submitErrorEl.id ||= `task-manager-task-edit-error-${taskEditFieldSequence++}`;
      this.submitErrorEl.hidden = false;
      this.submitErrorEl.setText(message);
      control?.setAttr('aria-invalid', 'true');
      control?.setAttr('aria-errormessage', this.submitErrorEl.id);
    }
    control?.focus();
    new Notice(message);
  }

  private notifyCancel(): void {
    if (this.submitted || this.cancelNotified) return;
    this.cancelNotified = true;
    this.onCancel?.();
  }

  private async commitSubmission(line: string): Promise<void> {
    try {
      await this.onSubmit(line);
      if (this.closing) return;
      this.submitted = true;
      this.setSubmitting(false);
      this.close();
    } catch (error) {
      if (this.closing) return;
      this.setSubmitting(false);
      const message = `Task Manager: could not save task — ${error instanceof Error ? error.message : String(error)}`;
      if (this.submitErrorEl) {
        this.submitErrorEl.hidden = false;
        this.submitErrorEl.setText(message);
        this.submitErrorEl.focus();
      }
      new Notice(message);
    }
  }

  close(): void {
    if (!this.closing && (this.childModal || (this.submitting && !this.submitted))) return;
    super.close();
  }

  private readonly handleSubmit = (event: SubmitEvent): void => {
    event.preventDefault();
    if (event.currentTarget !== this.formEl || this.childModal || this.submitting || this.submitted || !this.draft || !this.initialDraft) return;
    this.clearSubmitError();
    this.setSubmitting(true);
    const draft = this.draft;
    if (this.descriptionEl) draft.description = this.descriptionEl.value;
    if (this.statusEl) draft.checkbox = this.statusEl.value;
    for (const [key, control] of this.fieldRefs) draft[key] = control.value;
    const description = draft.description.replace(/[\r\n]+/gu, ' ').replace(/\s+/gu, ' ').trim();
    if (!description) {
      this.failValidation(this.descriptionEl ?? undefined, 'Task Manager: task description cannot be empty.');
      return;
    }
    if (draft.recurrence.trim() && !draft.due.trim() && !draft.scheduled.trim() && !draft.start.trim()) {
      this.failValidation(this.fieldRefs.get('recurrence') ?? this.fieldRefs.get('due'), 'Task Manager: recurring tasks require a Due, Scheduled, or Start date.');
      return;
    }
    let id = draft.id.trim();
    if (!id && this.settings.autoGenerateTaskId) id = randomTaskId();
    if (id && !/^[A-Za-z0-9_-]+$/u.test(id)) {
      this.failValidation(this.fieldRefs.get('id'), 'Task Manager: task ID may contain only letters, numbers, hyphens, and underscores.');
      return;
    }
    const dependsOn = draft.dependsOn.trim();
    if (id && dependsOn.split(/\s*,\s*/u).filter(Boolean).includes(id)) {
      this.failValidation(this.fieldRefs.get('dependsOn'), 'Task Manager: a task cannot depend on itself.');
      return;
    }
    for (const field of ['due', 'scheduled', 'start', 'created', 'done', 'cancelled'] as const) {
      const value = draft[field].trim();
      const futureOnly = field === 'due' || field === 'scheduled' || field === 'start' ? this.onlyFutureDates : false;
      if (value && resolveModalDateInput(value, todayString(), futureOnly) === null) {
        this.failValidation(this.fieldRefs.get(field), `Task Manager: ${field} date is invalid.`);
        return;
      }
    }
    const normalizeDate = (value: string): string => normalizeModalDate(value, this.onlyFutureDates);
    const stateType = this.settings.supportedStates.find((state) => state.rawText === draft.checkbox)?.type ?? 'untracked';
    const previousState = this.settings.supportedStates.find((state) => state.rawText === this.initialDraft?.checkbox)?.type ?? 'untracked';
    const lifecycle = computeModalLifecycleDates(
      previousState,
      stateType,
      { done: this.initialDraft.done, cancelled: this.initialDraft.cancelled },
      { setDoneDate: this.settings.setDoneDate, setCancelledDate: this.settings.setCancelledDate },
      this.fieldRefs.has('done') ? normalizeDate(draft.done) : null,
      this.fieldRefs.has('cancelled') ? normalizeDate(draft.cancelled) : null,
    );
    let recurrenceSeriesId = draft.recurrenceSeriesId;
    if (draft.recurrence && !this.initialDraft.recurrence && !recurrenceSeriesId) recurrenceSeriesId = generateRecurrenceSeriesId(this.sourcePath || 'unknown', 0, description);
    const output: EditableTaskLine = {
      ...draft,
      description,
      id,
      dependsOn,
      due: normalizeDate(draft.due),
      scheduled: normalizeDate(draft.scheduled),
      start: normalizeDate(draft.start),
      created: normalizeDate(draft.created),
      done: lifecycle.done,
      cancelled: lifecycle.cancelled,
      assignee: draft.assignee.trim().replace(/^@/u, ''),
      reviewer: draft.reviewer.trim().replace(/^@/u, ''),
      recurrenceSeriesId,
    };
    if (output.recurrence.trim()) {
      const base = output.due || output.scheduled || output.start;
      if (!base || !calculateNextRecurrences(output.recurrence, base, todayString(), 1)) {
        this.failValidation(this.fieldRefs.get('recurrence'), 'Task Manager: recurrence rule is invalid.');
        return;
      }
    }
    const formatted = formatEditableTaskLine(output, this.settings.taskFormat);
    const parsed = parseMarkdownTaskLine(formatted, this.sourcePath || 'Task.md', 1, this.settings.supportedStates);
    if (!parsed || (id && parsed.metadata.id !== id) || Object.keys(parsed.metadata.invalidDates).length > 0) {
      this.failValidation(this.descriptionEl ?? undefined, 'Task Manager: formatted task could not be parsed safely.');
      return;
    }
    void this.commitSubmission(formatted);
  };

  private renderOptionalFields(_reason: 'open' | 'show-all' | 'visibility', preferredFocusKey?: string): void {
    if (!this.optionalFieldsEl || !this.draft) return;
    const active = document.activeElement as HTMLElement | null;
    const activeKey = preferredFocusKey ?? (active && this.optionalFieldsEl.contains(active) ? active.dataset.fieldKey : undefined);
    this.optionalFieldsEl.empty();
    this.fieldRefs.clear();
    const draft = this.draft;

    if (this.shouldShowField('priority', draft.priority !== 'normal')) {
      const setting = new Setting(this.optionalFieldsEl).setName(t('modal.field.priority'));
      let select!: HTMLSelectElement;
      setting.addDropdown((dropdown) => {
        select = dropdown.selectEl;
        for (const value of ['normal', 'lowest', 'low', 'medium', 'high', 'highest']) dropdown.addOption(value, value);
        dropdown.setValue(draft.priority).onChange((value) => { draft.priority = value; });
      });
      select.dataset.fieldKey = 'priority';
      select.setAttr('aria-label', t('modal.field.priority'));
      this.applyAccessKey(select, 'p');
      this.fieldRefs.set('priority', select);
      this.addAutoRevealIndicator(setting.settingEl, !this.settings.modalFields.priority && draft.priority !== 'normal');
    }

    new Setting(this.optionalFieldsEl)
      .setName(t('modal.field.onlyFutureDates'))
      .setDesc(t('modal.field.onlyFutureDatesDesc'))
      .addToggle((toggle) => {
        toggle.toggleEl.dataset.fieldKey = 'only-future-dates';
        toggle.toggleEl.setAttr('aria-label', t('modal.field.onlyFutureDates'));
        toggle.setValue(this.onlyFutureDates).onChange((value) => { this.onlyFutureDates = value; });
        this.applyAccessKey(toggle.toggleEl, 'f');
      });

    for (const definition of OPTIONAL_FIELDS) {
      const value = String(draft[definition.key] ?? '');
      const visible = definition.settingKey
        ? this.shouldShowField(definition.settingKey, Boolean(value))
        : Boolean(value);
      if (!visible) continue;
      const input = definition.date
        ? this.createDateInput(this.optionalFieldsEl, definition, value)
        : this.createTextInput(this.optionalFieldsEl, definition, value);
      this.fieldRefs.set(definition.key, input);
      if (definition.settingKey) this.addAutoRevealIndicator(input.parentElement?.parentElement ?? input.parentElement ?? this.optionalFieldsEl, !this.settings.modalFields[definition.settingKey] && Boolean(value));
    }
    this.renderRecurrenceHelpers();
    this.renderIdAndDependencyHelpers();
    this.focusTrap?.refresh();
    if (activeKey) {
      const next = this.optionalFieldsEl.querySelector<HTMLElement>(`[data-field-key="${activeKey}"]`);
      (next ?? this.fieldsButton)?.focus();
    }
  }

  private createTextInput(container: HTMLElement, definition: OptionalFieldDefinition, value: string): HTMLInputElement {
    const setting = new Setting(container).setName(definition.label);
    let input!: HTMLInputElement;
    setting.addText((text) => {
      input = text.inputEl;
      if (definition.placeholder) text.setPlaceholder(definition.placeholder);
      text.setValue(value);
    });
    input.dataset.fieldKey = definition.key;
    input.setAttr('aria-label', definition.label);
    this.applyAccessKey(input, definition.accessKey);
    const update = (): void => { if (this.draft) this.draft[definition.key] = input.value; };
    input.addEventListener('input', update);
    input.addEventListener('change', update);
    return input;
  }

  private createDateInput(container: HTMLElement, definition: OptionalFieldDefinition, value: string): HTMLInputElement {
    const setting = new Setting(container).setName(definition.label);
    let input!: HTMLInputElement;
    const updateDayHint = (hint: HTMLElement): void => {
      const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(input.value.trim());
      if (!match) { hint.setText(''); return; }
      const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
      hint.setText(Number.isNaN(date.getTime()) ? '' : ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][date.getUTCDay()] ?? '');
    };
    setting.addText((text) => { input = text.inputEl; text.setPlaceholder('YYYY-MM-DD, tomorrow, 10 days').setValue(value); });
    input.dataset.fieldKey = definition.key;
    input.setAttr('aria-label', definition.label);
    this.applyAccessKey(input, definition.accessKey);
    const picker = setting.controlEl.createEl('input', { type: 'date', cls: 'task-manager-modal-date-picker' });
    picker.setAttr('aria-label', `${definition.label} date picker`);
    if (/^\d{4}-\d{2}-\d{2}$/u.test(value)) picker.value = value;
    const hint = setting.controlEl.createSpan('task-manager-modal-day-hint');
    const update = (): void => {
      input.value = expandDateAbbreviation(input.value);
      if (this.draft) this.draft[definition.key] = input.value;
      if (/^\d{4}-\d{2}-\d{2}$/u.test(input.value)) picker.value = input.value;
      updateDayHint(hint);
    };
    input.addEventListener('input', update);
    input.addEventListener('change', update);
    input.addEventListener('blur', () => {
      const trimmed = input.value.trim();
      if (trimmed && !/^\d{4}-\d{2}-\d{2}$/u.test(trimmed)) {
        const resolved = resolveModalDateInput(trimmed, todayString(), this.onlyFutureDates);
        if (resolved) input.value = resolved;
      }
      update();
    });
    picker.addEventListener('change', () => { input.value = picker.value; update(); });
    updateDayHint(hint);
    return input;
  }

  private renderRecurrenceHelpers(): void {
    const recurrence = this.fieldRefs.get('recurrence') as HTMLInputElement | undefined;
    if (!recurrence || !this.draft) return;
    const parent = recurrence.parentElement?.parentElement ?? recurrence.parentElement;
    if (!parent) return;
    const patterns = parent.createDiv('task-manager-recurrence-patterns');
    patterns.createDiv({ text: t('modal.recurrence.commonPatterns'), cls: 'task-manager-recurrence-patterns-label' });
    const buttons = patterns.createDiv('task-manager-pattern-buttons');
    for (const pattern of getCommonRecurrencePatterns()) {
      const button = buttons.createEl('button', { text: pattern, type: 'button', cls: 'task-manager-recurrence-pattern-button' });
      button.addEventListener('click', () => { recurrence.value = pattern; recurrence.dispatchEvent(new Event('input', { bubbles: true })); recurrence.focus(); });
    }
    const preview = parent.createDiv('task-manager-recurrence-preview');
    const updatePreview = (): void => {
      preview.empty();
      const rule = this.draft?.recurrence.trim() ?? '';
      if (!rule) { preview.createDiv({ text: t('modal.recurrence.noRecurrence') }); return; }
      const base = this.draft?.due || this.draft?.scheduled || this.draft?.start || todayString();
      const occurrences = calculateNextRecurrences(rule, base, todayString(), 3);
      if (!occurrences) { preview.createDiv({ text: t('modal.recurrence.invalidRule') }); return; }
      for (const occurrence of occurrences) {
        const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(occurrence);
        const date = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
        const weekday = date && !Number.isNaN(date.getTime()) ? date.toLocaleDateString(undefined, { weekday: 'long', timeZone: 'UTC' }) : '';
        preview.createDiv({ text: weekday ? `${occurrence} ${weekday}` : occurrence });
      }
    };
    recurrence.addEventListener('input', updatePreview);
    for (const key of ['due', 'scheduled', 'start'] as const) this.fieldRefs.get(key)?.addEventListener('input', updatePreview);
    updatePreview();
  }

  private renderIdAndDependencyHelpers(): void {
    const id = this.fieldRefs.get('id') as HTMLInputElement | undefined;
    const dependsOn = this.fieldRefs.get('dependsOn') as HTMLInputElement | undefined;
    if (id) {
      const warning = id.parentElement?.createDiv('task-manager-id-warning');
      const validate = (): void => {
        const invalid = Boolean(id.value.trim()) && !/^[A-Za-z0-9_-]+$/u.test(id.value.trim());
        if (warning) { warning.hidden = !invalid; warning.setText(invalid ? 'Id may only contain letters, numbers, hyphen (-) and underscore (_).' : ''); }
      };
      id.addEventListener('input', validate);
      validate();
    }
    if (!id && !dependsOn) return;
    const setting = new Setting(this.optionalFieldsEl as HTMLElement).setName('Dependency helpers');
    if (id) setting.addButton((button) => {
      button.setButtonText(t('modal.btn.generateId'));
      button.buttonEl.type = 'button';
      button.onClick(() => { id.value = id.value.trim() || randomTaskId(); id.dispatchEvent(new Event('input', { bubbles: true })); });
    });
    if (dependsOn) setting.addButton((button) => {
      button.setButtonText(t('modal.btn.addBefore'));
      button.buttonEl.type = 'button';
      button.onClick(() => new DependencySuggestModal(this.app, this.settings, (dependencyId) => {
        const values = dependsOn.value.split(/\s*,\s*/u).filter(Boolean);
        if (!values.includes(dependencyId)) values.push(dependencyId);
        dependsOn.value = values.join(',');
        dependsOn.dispatchEvent(new Event('input', { bubbles: true }));
      }, this.sourcePath).open());
    });
    if (id && this.settings.modalFields.after_this) setting.addButton((button) => {
      button.setButtonText(t('modal.btn.addAfter'));
      button.buttonEl.type = 'button';
      button.onClick(() => new DependentTaskSuggestModal(this.app, this.settings, () => {
        id.value = id.value.trim() || randomTaskId();
        id.dispatchEvent(new Event('input', { bubbles: true }));
        return id.value.trim();
      }, this.sourcePath).open());
    });
  }

  private openVisibleFieldsModal(): void {
    if (this.childModal || !this.fieldsButton) return;
    const opener = this.fieldsButton;
    this.focusTrap?.destroy();
    this.focusTrap = null;
    this.modalEl.inert = true;
    this.modalEl.setAttr('inert', '');
    this.modalEl.setAttr('aria-hidden', 'true');
    const current: VisibleFieldsDraft = { ...this.settings.modalFields };
    this.childModal = new VisibleFieldsModal(this.app, current, async (next) => {
      const previous = { ...this.settings.modalFields };
      Object.assign(this.settings.modalFields, next);
      try {
        await this.onSettingsChanged?.();
        this.renderOptionalFields('visibility');
      } catch (error) {
        Object.assign(this.settings.modalFields, previous);
        throw error;
      }
    }, () => {
      this.childModal = null;
      this.restoreParentModalAccessibility();
      if (this.closing || !this.formEl?.isConnected) return;
      this.focusTrap = new FocusTrap(this.formEl);
      opener.focus();
    });
    this.childModal.open();
  }

  private restoreParentModalAccessibility(): void {
    this.modalEl.inert = false;
    this.modalEl.removeAttribute('inert');
    this.modalEl.removeAttribute('aria-hidden');
  }

  private updateAutocomplete(description: HTMLTextAreaElement): void {
    this.closeAutocomplete(description);
    const value = description.value;
    const cursor = description.selectionStart ?? value.length;
    const before = value.slice(0, cursor);
    const wikilink = before.match(/\[\[([^\]\[]*)$/u);
    const tag = !wikilink ? before.match(/#([\p{L}\p{N}_/-]*)$/u) : null;
    const trigger = wikilink ?? tag;
    if (!trigger) return;
    const isWikilink = Boolean(wikilink);
    const query = (trigger[1] ?? '').toLowerCase();
    let candidates: string[];
    if (isWikilink) {
      candidates = scannableMarkdownFiles(this.app, this.settings).map((file) => file.basename).filter((name) => !query || name.toLowerCase().includes(query)).sort().slice(0, 15);
    } else {
      const tags = new Set<string>();
      for (const file of scannableMarkdownFiles(this.app, this.settings)) {
        const cache = this.app.metadataCache.getFileCache(file);
        if (cache) for (const current of getAllTags(cache) ?? []) tags.add(current.startsWith('#') ? current.slice(1) : current);
      }
      candidates = [...tags].filter((current) => !query || current.toLowerCase().includes(query)).sort().slice(0, 15);
    }
    if (candidates.length === 0 || !this.formEl) return;
    const dropdown = this.formEl.createDiv('tm-ac-dropdown');
    dropdown.id = `tm-task-edit-autocomplete-${taskEditAutocompleteSequence++}`;
    dropdown.setAttr('role', 'listbox');
    dropdown.setAttr('aria-label', t(isWikilink ? 'modal.autocomplete.noteSuggestions' : 'modal.autocomplete.tagSuggestions'));
    description.setAttr('aria-expanded', 'true');
    description.setAttr('aria-controls', dropdown.id);
    candidates.forEach((candidate, index) => {
      const item = dropdown.createDiv({ cls: `tm-ac-item${index === 0 ? ' tm-ac-item--active' : ''}`, text: isWikilink ? `[[${candidate}]]` : `#${candidate}` });
      item.id = `${dropdown.id}-option-${index}`;
      item.setAttr('role', 'option');
      item.setAttr('aria-selected', String(index === 0));
      if (index === 0) description.setAttr('aria-activedescendant', item.id);
      item.addEventListener('mouseenter', () => {
        dropdown.querySelectorAll<HTMLElement>('.tm-ac-item--active').forEach((active) => { active.removeClass('tm-ac-item--active'); active.setAttr('aria-selected', 'false'); });
        item.addClass('tm-ac-item--active');
        item.setAttr('aria-selected', 'true');
        description.setAttr('aria-activedescendant', item.id);
      });
      item.addEventListener('click', () => {
        const insert = isWikilink ? `[[${candidate}]]` : `#${candidate}`;
        const start = cursor - (trigger[0]?.length ?? 0);
        description.value = `${value.slice(0, start)}${insert}${value.slice(cursor)}`;
        description.selectionStart = description.selectionEnd = start + insert.length;
        if (this.draft) this.draft.description = description.value;
        this.closeAutocomplete(description);
        description.focus();
      });
    });
    const rect = description.getBoundingClientRect();
    const measured = dropdown.getBoundingClientRect();
    const position = resolveFloatingPosition(
      { left: rect.left, top: rect.top, width: rect.width, height: rect.height },
      { width: Math.max(200, measured.width), height: Math.max(30, measured.height) },
      { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight },
      getLocaleMetadata().direction,
    );
    dropdown.style.insetInlineStart = `${Math.round(position.inlineStart)}px`;
    dropdown.style.insetBlockStart = `${Math.round(position.blockStart)}px`;
    const outside = (event: MouseEvent): void => { if (!dropdown.contains(event.target as Node)) this.closeAutocomplete(description); };
    document.addEventListener('click', outside, true);
    this.autocompleteCleanup = () => { document.removeEventListener('click', outside, true); dropdown.remove(); };
  }

  private handleAutocompleteKeydown(event: KeyboardEvent, description: HTMLTextAreaElement): void {
    const dropdown = this.formEl?.querySelector<HTMLElement>('.tm-ac-dropdown');
    if (!dropdown) return;
    if (event.key === 'Escape') { event.stopPropagation(); this.closeAutocomplete(description); return; }
    const items = Array.from(dropdown.querySelectorAll<HTMLElement>('.tm-ac-item'));
    const active = dropdown.querySelector<HTMLElement>('.tm-ac-item--active');
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const current = active ? items.indexOf(active) : -1;
      const next = event.key === 'ArrowDown' ? Math.min(current + 1, items.length - 1) : Math.max(current - 1, 0);
      active?.removeClass('tm-ac-item--active');
      active?.setAttr('aria-selected', 'false');
      items[next]?.addClass('tm-ac-item--active');
      items[next]?.setAttr('aria-selected', 'true');
      if (items[next]) description.setAttr('aria-activedescendant', items[next].id);
    } else if (event.key === 'Enter' && active) {
      event.preventDefault();
      active.click();
    }
  }

  private closeAutocomplete(description?: HTMLTextAreaElement): void {
    this.autocompleteCleanup?.();
    this.autocompleteCleanup = null;
    this.formEl?.querySelector('.tm-ac-dropdown')?.remove();
    description?.setAttr('aria-expanded', 'false');
    description?.removeAttribute('aria-controls');
    description?.removeAttribute('aria-activedescendant');
  }

  onClose(): void {
    this.closing = true;
    this.notifyCancel();
    this.restoreParentModalAccessibility();
    this.childModal?.close();
    this.childModal = null;
    this.closeAutocomplete(this.descriptionEl ?? undefined);
    if (this.formEl) {
      this.formEl.removeEventListener('submit', this.handleSubmit);
      this.formEl.removeEventListener('keydown', this.handleFormKeydown);
    }
    this.focusTrap?.destroy();
    this.focusTrap = null;
    this.focusManager.restoreFocus();
    this.disposeLocaleScope?.();
    this.disposeLocaleScope = undefined;
    this.formEl = null;
    this.optionalFieldsEl = null;
    this.descriptionEl = null;
    this.statusEl = null;
    this.fieldsButton = null;
    this.submitErrorEl = null;
    this.cancelButton = null;
    this.submitButton = null;
    this.draft = null;
    this.initialDraft = null;
    this.submitting = false;
    this.fieldRefs.clear();
    this.contentEl.empty();
  }

  private loadFileDefaults(sourcePath: string): Partial<EditableTaskLine> {
    if (!this.settings.fileDefaultsEnabled) return {};
    const file = this.app.vault.getAbstractFileByPath(sourcePath);
    if (!(file instanceof TFile)) return {};
    const frontmatter = this.app.metadataCache.getFileCache(file)?.frontmatter;
    if (!frontmatter) return {};
    const prefix = this.settings.fileDefaultsPropertyPrefix || 'task_';
    const resolveTokens = (raw: string): string => {
      const date = todayString();
      return raw.replace(/\{\{date\}\}/gu, date).replace(/\{\{filename\}\}/gu, file.basename).replace(/\{\{folder\}\}/gu, file.parent?.name || 'root').replace(/\{\{path\}\}/gu, file.path);
    };
    const result: Partial<EditableTaskLine> = {};
    const scalarText = (value: unknown): string | null => typeof value === 'string' || typeof value === 'number' ? `${value}` : null;
    const due = scalarText(frontmatter[`${prefix}due`]);
    const scheduled = scalarText(frontmatter[`${prefix}scheduled`]);
    const priority = scalarText(frontmatter[`${prefix}priority`]);
    const rawTags: unknown = frontmatter[`${prefix}tags`];
    if (due !== null) result.due = resolveTokens(due.trim());
    if (scheduled !== null) result.scheduled = resolveTokens(scheduled.trim());
    if (priority !== null) {
      const normalized = priority.trim().toLowerCase();
      if (['highest', 'high', 'medium', 'normal', 'low', 'lowest'].includes(normalized)) result.priority = normalized;
    }
    if (rawTags) {
      const tagInputs = Array.isArray(rawTags)
        ? rawTags.map(scalarText).filter((value): value is string => value !== null)
        : scalarText(rawTags)?.split(/[,\s]+/u) ?? [];
      const values = tagInputs.map((value) => resolveTokens(value.startsWith('#') ? value.slice(1) : value)).filter(Boolean);
      if (values.length > 0) result.tags = values;
    }
    return result;
  }

  private applyAccessKey(element: HTMLElement, accessKey?: string): void {
    if (this.settings.provideAccessKeys && accessKey) element.accessKey = accessKey;
  }
}
