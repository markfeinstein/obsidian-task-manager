import { App, Modal, Notice, TFile } from 'obsidian';
import type { ParsedTask } from './task-scanner';
import type { TaskManagerSettings } from './types';
import { FocusManager, FocusTrap } from './keyboard-nav';
import { t, type TranslationKey } from './i18n';
import { applyLocaleScope } from './locale-scope';

export interface AdvancedFindState {
  text: string;
  statuses: string[];
  priority: string;
  dueFrom: string;
  dueTo: string;
  tag: string;
  folder: string;
}

export const DEFAULT_ADVANCED_FIND_STATE: AdvancedFindState = {
  text: '',
  statuses: [],
  priority: '',
  dueFrom: '',
  dueTo: '',
  tag: '',
  folder: '',
};

type AdvancedFindStringKey = Exclude<keyof AdvancedFindState, 'statuses'>;
let advancedFindModalSequence = 0;

function includesCaseInsensitive(value: string, needle: string): boolean {
  return value.toLowerCase().includes(needle.toLowerCase());
}

function uniqueStatusTypes(settings: TaskManagerSettings): Array<{ value: string; label: string }> {
  const seen = new Set<string>();
  const result: Array<{ value: string; label: string }> = [];
  for (const state of settings.supportedStates) {
    if (state.type === 'untracked' || seen.has(state.type)) continue;
    seen.add(state.type);
    result.push({ value: state.type, label: state.name || state.type });
  }
  return result;
}

export function filterAdvancedFindTasks<T extends ParsedTask>(tasks: readonly T[], state: AdvancedFindState): T[] {
  const text = state.text.trim();
  const tag = state.tag.trim().replace(/^#/u, '');
  const folder = state.folder.trim().replace(/^\/+|\/+$/gu, '');
  const statuses = new Set(state.statuses.filter(Boolean));
  const priority = state.priority.trim().toLowerCase();
  const dueFrom = state.dueFrom.trim();
  const dueTo = state.dueTo.trim();

  return tasks.filter((task) => {
    if (text && !includesCaseInsensitive(`${task.normalizedText} ${task.filePath}`, text)) return false;
    if (statuses.size > 0 && !statuses.has(task.status)) return false;
    if (priority && String(task.metadata.priority ?? '').toLowerCase() !== priority) return false;
    if (tag) {
      const hasTag = task.tags.some((t) => t.replace(/^#/u, '').toLowerCase() === tag.toLowerCase());
      if (!hasTag) return false;
    }
    if (folder) {
      const taskFolder = task.filePath.includes('/') ? task.filePath.slice(0, task.filePath.lastIndexOf('/')) : '';
      const taskFolderLower = taskFolder.toLowerCase();
      const folderLower = folder.toLowerCase();
      if (taskFolderLower !== folderLower && !taskFolderLower.startsWith(`${folderLower}/`)) return false;
    }
    const due = task.metadata.dates?.due ?? '';
    if (dueFrom && (!due || due < dueFrom)) return false;
    if (dueTo && (!due || due > dueTo)) return false;
    return true;
  });
}

export class AdvancedFindModal extends Modal {
  private state: AdvancedFindState = { ...DEFAULT_ADVANCED_FIND_STATE };
  private resultsEl!: HTMLElement;
  private countEl!: HTMLElement;
  private renderTimer: number | null = null;
  private focusTrap: FocusTrap | null = null;
  private focusManager = new FocusManager();
  private disposeLocaleScope?: () => void;
  private readonly controlIdPrefix = `task-manager-advanced-find-${++advancedFindModalSequence}`;

  constructor(
    app: App,
    private readonly getTasks: () => readonly ParsedTask[],
    private readonly getSettings: () => TaskManagerSettings,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('task-manager-advanced-find-modal');
    this.disposeLocaleScope?.();
    this.disposeLocaleScope = applyLocaleScope(contentEl);
    contentEl.setAttr('role', 'dialog');
    contentEl.setAttr('aria-modal', 'true');
    const title = contentEl.createEl('h2', { text: t('advancedFind.title') });
    title.id = 'task-manager-advanced-find-title';
    contentEl.setAttr('aria-labelledby', title.id);

    const layout = contentEl.createDiv({ cls: 'task-manager-advanced-find-layout' });
    const controls = layout.createDiv({ cls: 'task-manager-advanced-find-controls' });
    const results = layout.createDiv({ cls: 'task-manager-advanced-find-results' });

    this.addTextControl(controls, 'advancedFind.text', 'advancedFind.textPlaceholder', 'text');
    this.addStatusControls(controls);
    this.addSelectControl(controls, 'advancedFind.priority', 'priority', ['', 'highest', 'high', 'medium', 'normal', 'low', 'lowest']);
    this.addTextControl(controls, 'advancedFind.dueFrom', undefined, 'dueFrom', 'date');
    this.addTextControl(controls, 'advancedFind.dueTo', undefined, 'dueTo', 'date');
    this.addTextControl(controls, 'advancedFind.tag', 'advancedFind.tagPlaceholder', 'tag');
    this.addTextControl(controls, 'advancedFind.folder', 'advancedFind.folderPlaceholder', 'folder');

    this.countEl = results.createDiv({ cls: 'task-manager-advanced-find-count' });
    this.resultsEl = results.createEl('ul', { cls: 'task-manager-advanced-find-list' });
    this.resultsEl.setAttr('aria-label', t('advancedFind.resultsLabel'));
    this.renderResults();

    this.focusTrap = new FocusTrap(contentEl);
    const firstInput = contentEl.querySelector<HTMLElement>('input, select, textarea, button');
    if (firstInput) this.focusManager.focus(firstInput);
  }

  onClose(): void {
    if (this.renderTimer !== null) window.clearTimeout(this.renderTimer);
    this.renderTimer = null;
    this.focusTrap?.destroy();
    this.focusTrap = null;
    this.focusManager.restoreFocus();
    this.disposeLocaleScope?.();
    this.disposeLocaleScope = undefined;
    this.contentEl.empty();
  }

  private scheduleRender(): void {
    if (this.renderTimer !== null) window.clearTimeout(this.renderTimer);
    this.renderTimer = window.setTimeout(() => {
      this.renderTimer = null;
      this.renderResults();
    }, 150);
  }

  private addTextControl(parent: HTMLElement, labelKey: TranslationKey, placeholderKey: TranslationKey | undefined, key: AdvancedFindStringKey, type = 'text'): void {
    const row = parent.createDiv({ cls: 'task-manager-advanced-find-control' });
    const inputId = `${this.controlIdPrefix}-${key}`;
    const labelEl = row.createEl('label', { text: t(labelKey) });
    labelEl.setAttr('for', inputId);
    const input = row.createEl('input', { type, placeholder: placeholderKey ? t(placeholderKey) : undefined, cls: 'task-manager-advanced-find-input' });
    input.setAttr('id', inputId);
    input.value = this.state[key];
    input.addEventListener('input', () => {
      this.state[key] = input.value;
      this.scheduleRender();
    });
  }

  private addSelectControl(parent: HTMLElement, labelKey: TranslationKey, key: AdvancedFindStringKey, values: string[]): void {
    const row = parent.createDiv({ cls: 'task-manager-advanced-find-control' });
    const selectId = `${this.controlIdPrefix}-${key}`;
    const labelEl = row.createEl('label', { text: t(labelKey) });
    labelEl.setAttr('for', selectId);
    const select = row.createEl('select', { cls: 'task-manager-advanced-find-input' });
    select.setAttr('id', selectId);
    const priorityLabels: Record<string, TranslationKey> = { highest: 'priority.highest', high: 'priority.high', medium: 'priority.medium', normal: 'priority.normal', low: 'priority.low', lowest: 'priority.lowest' };
    for (const value of values) {
      select.createEl('option', { text: value ? t(priorityLabels[value] ?? 'advancedFind.any') : t('advancedFind.any'), value });
    }
    select.value = this.state[key];
    select.addEventListener('change', () => {
      this.state[key] = select.value;
      this.scheduleRender();
    });
  }

  private addStatusControls(parent: HTMLElement): void {
    const group = parent.createEl('fieldset', { cls: 'task-manager-advanced-find-statuses' });
    group.createEl('legend', { text: t('advancedFind.status'), cls: 'task-manager-advanced-find-label' });
    for (const status of uniqueStatusTypes(this.getSettings())) {
      const inputId = `${this.controlIdPrefix}-status-${status.value.replace(/[^a-z0-9_-]/giu, '-')}`;
      const label = group.createEl('label', { cls: 'task-manager-advanced-find-checkbox-label' });
      label.setAttr('for', inputId);
      const input = label.createEl('input', { type: 'checkbox' });
      input.setAttr('id', inputId);
      label.createSpan({ text: ` ${status.label}` });
      input.addEventListener('change', () => {
        const next = new Set(this.state.statuses);
        if (input.checked) next.add(status.value);
        else next.delete(status.value);
        this.state.statuses = [...next];
        this.scheduleRender();
      });
    }
  }

  private renderResults(): void {
    const tasks = filterAdvancedFindTasks(this.getTasks(), this.state);
    this.countEl.setText(t(tasks.length === 1 ? 'advancedFind.countSingular' : 'advancedFind.countPlural', { count: tasks.length }));
    this.resultsEl.empty();
    for (const task of tasks.slice(0, 100)) {
      const row = this.resultsEl.createEl('li', { cls: 'task-manager-advanced-find-row' });
      const source = `${task.filePath}:${task.lineNumber}`;
      const button = row.createEl('button', { cls: 'task-manager-advanced-find-result-button' });
      button.setAttr('type', 'button');
      button.setAttr('aria-label', `${task.normalizedText}. ${source}`);
      button.createEl('span', { text: task.normalizedText, cls: 'task-manager-advanced-find-task' });
      button.createEl('small', { text: source, cls: 'task-manager-advanced-find-source' });
      button.addEventListener('click', () => { void this.openTask(task); });
    }
    if (tasks.length > 100) {
      this.countEl.setText(`${this.countEl.textContent ?? ''} ${t('advancedFind.moreResults', { count: tasks.length })}`);
    }
  }

  private async openTask(task: ParsedTask): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(task.filePath);
    if (!(file instanceof TFile)) {
      new Notice(t('advancedFind.cannotOpen', { path: task.filePath }));
      return;
    }
    await this.app.workspace.getLeaf(false).openFile(file, {
      active: true,
      eState: { line: Math.max(0, task.lineNumber - 1) },
    });
    this.close();
  }
}
