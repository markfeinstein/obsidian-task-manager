/**
 * simple-modals.ts
 *
 * Small, self-contained modal classes extracted from main.ts.
 * None of these need a direct reference to TaskManagerPlugin.
 */

import { Modal, Notice, SuggestModal, TFile, Setting } from 'obsidian';
import type { App } from 'obsidian';
import type { SavedTaskQuery, TaskManagerSettings } from '../types';
import type { ParsedTask, TaskScanner } from '../task-scanner';
import { filterTasks, parseTaskQuery } from '../task-query';
import { scanScannableTasks } from './modal-utils';

// ── TaskNoteTargetFileSuggestModal ───────────────────────────────────────────

export class TaskNoteTargetFileSuggestModal extends SuggestModal<TFile> {
  private chosen = false;

  constructor(
    app: App,
    private readonly excludePath: string,
    private readonly onChoose: (file: TFile | null) => void,
  ) {
    super(app);
    this.setPlaceholder('Choose where to insert the inline task');
  }

  getSuggestions(query: string): TFile[] {
    const needle = query.trim().toLowerCase();
    return this.app.vault.getMarkdownFiles()
      .filter((file) => file.path !== this.excludePath)
      .filter((file) => !needle || file.path.toLowerCase().includes(needle) || file.basename.toLowerCase().includes(needle))
      .slice(0, 50);
  }

  renderSuggestion(file: TFile, el: HTMLElement): void {
    el.createEl('div', { text: file.basename });
    el.createEl('small', { text: file.path, cls: 'task-manager-suggestion-muted' });
  }

  onChooseSuggestion(file: TFile): void { this.chosen = true; this.onChoose(file); }
  onClose(): void { if (!this.chosen) this.onChoose(null); }
}

// ── SavedTaskQueryModal ──────────────────────────────────────────────────────

export class SavedTaskQueryModal extends SuggestModal<SavedTaskQuery> {
  constructor(
    app: App,
    private readonly queries: readonly SavedTaskQuery[],
    private readonly onChoose: (query: SavedTaskQuery) => void,
  ) {
    super(app);
    this.setPlaceholder('Choose a saved Task Manager query');
  }

  getSuggestions(query: string): SavedTaskQuery[] {
    const search = query.trim().toLowerCase();
    if (!search) return [...this.queries];
    return this.queries.filter((q) => q.name.toLowerCase().includes(search) || q.query.toLowerCase().includes(search));
  }

  renderSuggestion(query: SavedTaskQuery, el: HTMLElement): void {
    el.createEl('div', { text: query.name });
    el.createEl('small', { text: query.query.split(/\r?\n/u).join(' · ') });
  }

  onChooseSuggestion(query: SavedTaskQuery): void { this.onChoose(query); }
}

// ── TaskTemplateSuggestModal ─────────────────────────────────────────────────

export class TaskTemplateSuggestModal extends SuggestModal<import('../types').TaskTemplate> {
  constructor(
    app: App,
    private readonly templates: import('../types').TaskTemplate[],
    private readonly onSelect: (template: import('../types').TaskTemplate) => void,
  ) {
    super(app);
  }

  getSuggestions(query: string): import('../types').TaskTemplate[] {
    const q = query.toLowerCase();
    return this.templates.filter((t) => t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q));
  }

  renderSuggestion(template: import('../types').TaskTemplate, el: HTMLElement): void {
    el.createEl('div', { text: template.name, cls: 'task-template-name' });
    if (template.description) el.createEl('small', { text: template.description, cls: 'task-template-desc' });
  }

  onChooseSuggestion(template: import('../types').TaskTemplate): void { this.onSelect(template); }
}

// ── QuickFindTaskModal ───────────────────────────────────────────────────────

export class QuickFindTaskModal extends SuggestModal<ParsedTask> {
  private tasks: ParsedTask[] = [];

  constructor(
    app: App,
    private readonly scanner: TaskScanner,
    private readonly settings: TaskManagerSettings,
  ) {
    super(app);
    this.setPlaceholder('Search tasks…');
  }

  async onOpen(): Promise<void> {
    void super.onOpen();
    this.tasks = await scanScannableTasks(this.app, this.settings, this.scanner);
  }

  getSuggestions(query: string): ParsedTask[] {
    const lower = query.toLowerCase();
    return this.tasks
      .filter((t) => !lower || t.normalizedText.toLowerCase().includes(lower) || t.filePath.toLowerCase().includes(lower) || t.tags.some((tag) => tag.toLowerCase().includes(lower)))
      .slice(0, 50);
  }

  renderSuggestion(task: ParsedTask, el: HTMLElement): void {
    const stateIcon = this.settings.supportedStates.find((s) => s.rawText === task.checkbox)?.icon || task.checkbox;
    el.createEl('div', { text: `${stateIcon} ${task.normalizedText}`, cls: 'quick-find-task-desc' });
    el.createEl('small', { text: `${task.filePath}:${task.lineNumber}`, cls: 'quick-find-task-path' });
  }

  onChooseSuggestion(task: ParsedTask): void {
    const file = this.app.vault.getAbstractFileByPath(task.filePath);
    if (file instanceof TFile) {
      void this.app.workspace.getLeaf(false).openFile(file, {
        active: true,
        eState: { line: Math.max(0, task.lineNumber - 1) },
      });
    }
  }
}

// ── ProjectWorkspaceCreateModal ──────────────────────────────────────────────

export class ProjectWorkspaceCreateModal extends Modal {
  constructor(
    app: App,
    private readonly onSubmit: (values: { name: string; folder: string }) => Promise<void>,
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('task-manager-modal');
    contentEl.createEl('h2', { text: 'Create Project Workspace' });
    contentEl.createEl('p', { text: 'Creates a safe workspace note with query/template references. It does not mutate project notes.' });

    new Setting(contentEl).setName('Project name').addText((text) => {
      text.setPlaceholder('New Project');
      text.inputEl.addClass('project-workspace-name-input');
    });
    new Setting(contentEl).setName('Folder').setDesc('Workspace note folder. Created if missing.').addText((text) => {
      text.setPlaceholder('Projects').setValue('Projects');
      text.inputEl.addClass('project-workspace-folder-input');
    });

    const buttons = contentEl.createDiv({ cls: 'modal-button-container' });
    const createBtn = buttons.createEl('button', { text: 'Create', cls: 'mod-cta' });
    const cancelBtn = buttons.createEl('button', { text: 'Cancel' });
    cancelBtn.addEventListener('click', () => this.close());
    createBtn.addEventListener('click', () => {
      const name = (contentEl.querySelector<HTMLInputElement>('.project-workspace-name-input'))?.value.trim() || 'New Project';
      const folder = (contentEl.querySelector<HTMLInputElement>('.project-workspace-folder-input'))?.value.trim() || 'Projects';
      createBtn.disabled = true;
      void (async () => {
        try {
          await this.onSubmit({ name, folder });
          this.close();
        } finally {
          createBtn.disabled = false;
        }
      })();
    });
  }

  onClose(): void { this.contentEl.empty(); }
}

// ── WorkingOnModal ───────────────────────────────────────────────────────────

export class WorkingOnModal extends Modal {
  constructor(
    app: App,
    private readonly settings: TaskManagerSettings,
    private readonly scanner: TaskScanner,
  ) { super(app); }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: '⚡ Working On' });
    contentEl.createEl('p', { text: 'Loading…', cls: 'task-manager-working-on-loading' });

    const allTasks = await scanScannableTasks(this.app, this.settings, this.scanner);
    const inProgress = allTasks.filter(
      (t) => t.status === 'in_progress' || this.settings.supportedStates.find((s) => s.rawText === t.checkbox && s.type === 'in_progress'),
    );

    contentEl.empty();
    contentEl.createEl('h2', { text: '⚡ Working On' });

    if (inProgress.length === 0) {
      contentEl.createEl('p', { text: 'No in-progress tasks found. Mark a task as [/] to track it here.' });
      return;
    }

    const list = contentEl.createEl('ul', { cls: 'task-manager-working-on-list' });
    for (const task of inProgress.slice(0, 20)) {
      const li = list.createEl('li', { cls: 'task-manager-working-on-item' });
      li.createEl('span', { text: task.normalizedText, cls: 'task-manager-working-on-text' });
      if (task.metadata.dates.due) li.createEl('small', { text: ` 📅 ${task.metadata.dates.due}`, cls: 'task-manager-working-on-due' });
      li.createEl('small', { text: ` — [[${task.filePath.replace(/\.md$/u, '')}]]`, cls: 'task-manager-working-on-src' });
    }
    if (inProgress.length > 20) contentEl.createEl('p', { text: `…and ${inProgress.length - 20} more in-progress tasks.` });
    contentEl.createEl('p', { text: 'Tip: Use the Pomodoro command to start a focus timer on any of these tasks.', cls: 'task-manager-working-on-tip' });
  }

  onClose(): void { this.contentEl.empty(); }
}

// ── SavedQueryPreviewModal ───────────────────────────────────────────────────

export class SavedQueryPreviewModal extends Modal {
  private resultEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly settings: TaskManagerSettings,
    private readonly scanner: TaskScanner,
  ) { super(app); }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h2', { text: '🔍 Run Saved Query' });

    const queries = this.settings.savedQueries;
    if (!queries.length) {
      contentEl.createEl('p', { text: 'No saved queries. Add some in Settings → Saved queries.' });
      return;
    }

    const selectRow = contentEl.createDiv({ cls: 'task-manager-sqp-select-row' });
    selectRow.createEl('label', { text: 'Query: ', cls: 'task-manager-sqp-label' });
    const sel = selectRow.createEl('select', { cls: 'task-manager-sqp-select' });
    for (const q of queries) sel.createEl('option', { text: q.name, value: q.name });

    const runBtn = selectRow.createEl('button', { text: 'Run', cls: 'mod-cta task-manager-sqp-run' });
    this.resultEl = contentEl.createDiv({ cls: 'task-manager-sqp-result' });

    const runQuery = async (): Promise<void> => {
      if (!this.resultEl) return;
      const chosen = queries.find((q) => q.name === sel.value);
      if (!chosen) return;

      try {
        this.resultEl.empty();
        this.resultEl.createEl('p', { text: 'Loading…' });

        const allTasks = await scanScannableTasks(this.app, this.settings, this.scanner);

        const query = parseTaskQuery(chosen.query, {
          states: this.settings.supportedStates,
          savedQueries: this.settings.savedQueries,
          globalFilter: this.settings.globalFilter,
          enableQueryDsl: this.settings.enableQueryDsl,
          enableDslExpressions: this.settings.enableDslExpressions,
          nlpQueryEnabled: this.settings.nlpQueryEnabled,
        });

        const filtered = filterTasks(allTasks, query, {
          states: this.settings.supportedStates,
          savedQueries: this.settings.savedQueries,
          nlpQueryEnabled: this.settings.nlpQueryEnabled,
        });

        this.resultEl.empty();
        this.resultEl.createEl('h3', { text: `${chosen.name} (${filtered.length} task${filtered.length === 1 ? '' : 's'})` });
        if (filtered.length === 0) { this.resultEl.createEl('p', { text: 'No tasks matched.' }); return; }

        const ul = this.resultEl.createEl('ul', { cls: 'task-manager-sqp-list' });
        for (const task of filtered.slice(0, 100)) {
          const li = ul.createEl('li', { cls: 'task-manager-sqp-item' });
          li.createEl('span', { text: task.normalizedText });
          if (task.metadata.dates.due) li.createEl('small', { text: ` 📅 ${task.metadata.dates.due}` });
          if (task.metadata.priority && task.metadata.priority !== 'normal') li.createEl('small', { text: ` · ${task.metadata.priority}` });
          li.createEl('small', { text: ` · [[${task.filePath.replace(/\.md$/u, '')}]]`, cls: 'task-manager-sqp-src' });
        }
        if (filtered.length > 100) this.resultEl.createEl('p', { text: `…and ${filtered.length - 100} more results.` });
      } catch (error) {
        this.resultEl.empty();
        this.resultEl.createEl('p', { text: `Error running saved query: ${String(error)}` });
      }
    };

    runBtn.addEventListener('click', () => { void runQuery(); });
    sel.addEventListener('change', () => { void runQuery(); });
    void runQuery();
  }

  onClose(): void { this.contentEl.empty(); }
}

// ── ExperimentalSyncConfirmationModal ────────────────────────────────────────

export class ExperimentalSyncConfirmationModal extends Modal {
  constructor(
    app: App,
    private readonly serviceName: string,
    private readonly onConfirm: () => Promise<void>,
    private readonly onCancel?: () => void,
  ) { super(app); }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('tm-exp-sync-modal');
    contentEl.createEl('h2', { text: '⚠️ Experimental Sync Service' });
    contentEl.createEl('p', { text: `You are about to enable ${this.serviceName} sync, which is marked as experimental.` });
    const warningList = contentEl.createEl('ul');
    warningList.createEl('li', { text: 'This feature may have bugs or data loss risks' });
    warningList.createEl('li', { text: 'Always backup your vault before enabling' });
    warningList.createEl('li', { text: 'Test with a small subset of tasks first' });
    warningList.createEl('li', { text: 'Check the sync health dashboard in plugin diagnostics' });
    contentEl.createEl('p', { text: '✅ To enable this service, click "I Understand & Continue" below.' });

    const btnRow = contentEl.createDiv({ cls: 'tm-exp-sync-buttons' });
    const cancelBtn = btnRow.createEl('button', { text: 'Cancel', cls: 'mod-warning' });
    cancelBtn.addEventListener('click', () => { this.onCancel?.(); this.close(); });
    const confirmBtn = btnRow.createEl('button', { text: '✅ I Understand & Continue', cls: 'mod-cta' });
    confirmBtn.addEventListener('click', () => {
      void (async () => {
        try { await this.onConfirm(); this.close(); }
        catch (err) { new Notice(`Error enabling ${this.serviceName}: ${String(err)}`); }
      })();
    });
  }

  onClose(): void { this.contentEl.empty(); }
}

// ── SyncTestConnectionModal ──────────────────────────────────────────────────

export class SyncTestConnectionModal extends Modal {
  private statusEl: HTMLElement | null = null;

  constructor(
    app: App,
    private readonly serviceName: string,
    private readonly testFn: () => Promise<{ success: boolean; message: string }>,
  ) { super(app); }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('tm-sync-test-modal');
    contentEl.createEl('h2', { text: `🔗 Test ${this.serviceName} Connection` });
    this.statusEl = contentEl.createDiv({ cls: 'tm-sync-test-status' });
    this.statusEl.createEl('p', { text: 'Testing connection...' });
    const btnRow = contentEl.createDiv({ cls: 'tm-sync-test-buttons' });
    const closeBtn = btnRow.createEl('button', { text: 'Close', cls: 'mod-cta' });
    closeBtn.addEventListener('click', () => this.close());
    void this.runTest();
  }

  private async runTest(): Promise<void> {
    if (!this.statusEl) return;
    try {
      const result = await this.testFn();
      this.statusEl.empty();
      const icon = result.success ? '✅' : '❌';
      const cls = result.success ? 'tm-sync-test-success' : 'tm-sync-test-error';
      this.statusEl.createEl('p', { text: `${icon} ${result.message}`, cls });
    } catch (err) {
      this.statusEl.empty();
      this.statusEl.createEl('p', { text: `❌ Test failed: ${String(err)}`, cls: 'tm-sync-test-error' });
    }
  }

  onClose(): void { this.contentEl.empty(); }
}
