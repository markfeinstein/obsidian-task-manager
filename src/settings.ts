import { App, Notice, PluginSettingTab, Setting, debounce, Modal, type Plugin } from 'obsidian';
import type { SettingsHost } from './settings-contract';
import { getAvailableLocales, getLocaleName, getTranslationCoverage, setLocale, t } from './i18n';
import {
  DEFAULT_DEFER_PRESETS,
  DEFAULT_SAVED_QUERIES,
  DEFAULT_TASK_STATES,
  normalizeDeferPresets,
  normalizeCustomPriorities,
  normalizeCustomFieldDefinitions,
  TASK_STATE_COLLECTIONS,
  defaultTaskStateIcon,
  mergeTaskStateCollection,
  normalizeSavedQueries,
  normalizeTaskStates,
  type CustomPriority,
  type DeferPreset,
  type ModalFieldVisibilityKey,
  type SavedTaskQuery,
  type SavedViewPreset,
  type TaskStateDefinition,
  type TaskStateType,
  type TaskManagerSettings,
  type TableCustomColumnType,
  type KanbanBoardGroupBy,
  type TaskTemplate,
} from './types';
import type { CustomFieldDefinition } from './custom-fields-sync';
import {
  renderAdvancedSection, renderAppleRemindersSection, renderCalDavSection, renderGoogleTasksSection,
  renderIntegrationSection, renderMicrosoftToDoSection, renderTodoistSection, renderVoiceAndAiSection,
  renderWorkflowSection, renderScanIntervalSetting, indexAndFilterSettings, renderSettingsSearch,
} from './settings/sections';
import { confirmSettingsRemoval } from './settings/confirm-removal';
import { applyLocaleScope } from './locale-scope';
import { consumeTaskManagerSettingsTabRequest } from './settings-navigation';

const STATE_TYPES: TaskStateType[] = ['todo', 'in_progress', 'on_hold', 'blocked', 'deferred', 'done', 'cancelled', 'untracked'];
let settingsTabSequence = 0;

const MODAL_FIELD_LABELS: Array<[ModalFieldVisibilityKey, string]> = [
  ['priority', 'Priority'],
  ['due', 'Due date'],
  ['scheduled', 'Scheduled date'],
  ['start', 'Start date'],
  ['created', 'Created date'],
  ['done', 'Done date'],
  ['cancelled', 'Cancelled date'],
  ['reminder', 'Reminder'],
  ['time', 'Time (⌚)'],
  ['recurrence', 'Recurrence'],
  ['onCompletion', 'On completion'],
  ['id', 'Id'],
  ['before_this', 'Blocked by (depends on)'],
  ['after_this', 'Blocking (blocked by this)'],
  ['effort', 'Effort estimate (⏱️)'],
  ['actual', 'Actual time logged (🕐)'],
  ['followUp', 'Follow-up date (👀)'],
];

export function hasPointerLeftElement(element: HTMLElement, event: DragEvent): boolean {
  const relatedTarget = event.relatedTarget;
  return !relatedTarget || !element.contains(relatedTarget as Node);
}

export class TaskManagerSettingTab extends PluginSettingTab {
  private taskStateDrafts: TaskStateDefinition[] | null = null;
  private savedQueryDrafts: SavedTaskQuery[] | null = null;
  private deferPresetDrafts: DeferPreset[] | null = null;
  private savedViewPresetDrafts: SavedViewPreset[] | null = null;
  private isLoggingSectionOpen = false;
  private isSupportedStatesSectionOpen = false;
  private isSavedQueriesSectionOpen = false;
  private isModalFieldsSectionOpen = false;
  private isDeferPresetsSectionOpen = false;
  private isGoogleAdvancedSectionOpen = false;
  private activeSettingsTab: 'general' | 'query' | 'views' | 'sync' | 'automation' | 'advanced' = 'general';
  private readonly settingsTabPanelId = `task-manager-settings-tab-panel-${settingsTabSequence++}`;
  private taskStateAnnouncement = '';
  private taskStateAnnouncementError = false;
  private pendingTaskStateFocusIndex: number | null = null;
  private settingsSearchQuery = '';
  private disposeLocaleScope?: () => void;

  private editTemplate(index: number): void {
    const existing = index >= 0 ? this.plugin.settings.taskTemplates[index] : undefined;
    const draft: TaskTemplate = {
      name: existing?.name ?? '',
      description: existing?.description ?? '',
      priority: existing?.priority ?? 'normal',
      recurrence: existing?.recurrence ?? '',
      tags: existing?.tags ?? '',
      onCompletion: existing?.onCompletion ?? '',
    };
    const modal = new Modal(this.app);
    modal.titleEl.setText(index >= 0 ? 'Edit template' : 'New template');
    const { contentEl } = modal;
    new Setting(contentEl).setName('Name').addText((t) => t.setValue(draft.name).onChange((v) => { draft.name = v; }));
    new Setting(contentEl).setName('Default description').addText((t) => t.setPlaceholder('Task description…').setValue(draft.description).onChange((v) => { draft.description = v; }));
    new Setting(contentEl).setName('Priority').addDropdown((d) => {
      for (const p of ['normal', 'lowest', 'low', 'medium', 'high', 'highest']) d.addOption(p, p);
      d.setValue(draft.priority).onChange((v) => { draft.priority = v; });
    });
    new Setting(contentEl).setName('Recurrence').addText((t) => t.setPlaceholder('every week').setValue(draft.recurrence).onChange((v) => { draft.recurrence = v; }));
    new Setting(contentEl).setName('Tags').addText((t) => t.setPlaceholder('#project #area').setValue(draft.tags).onChange((v) => { draft.tags = v; }));
    new Setting(contentEl).setName('On completion').addDropdown((d) => {
      d.addOption('', 'keep').addOption('delete', 'delete').addOption('archive', 'archive').addOption('collect', 'collect').addOption('move-to-end', 'move to end');
      d.setValue(draft.onCompletion).onChange((v) => { draft.onCompletion = v; });
    });
    new Setting(contentEl)
      .addButton((btn) => btn.setButtonText('Cancel').onClick(() => modal.close()))
      .addButton((btn) => btn.setCta().setButtonText('Save').onClick(async () => {
        if (!draft.name.trim()) { new Notice('Template name cannot be empty'); return; }
        if (index >= 0) {
          this.plugin.settings.taskTemplates[index] = draft;
        } else {
          this.plugin.settings.taskTemplates.push(draft);
        }
        await this.plugin.saveSettings();
        modal.close();
        this.display();
      }));
    modal.open();
  }

  constructor(app: App, private readonly plugin: SettingsHost) {
    super(app, plugin as unknown as Plugin);
  }

  display(): void {
    const requestedTab = consumeTaskManagerSettingsTabRequest();
    if (requestedTab) this.activeSettingsTab = requestedTab;
    const { containerEl } = this;
    this.taskStateDrafts ??= this.plugin.settings.supportedStates.map((state) => ({ ...state }));
    this.savedQueryDrafts ??= this.plugin.settings.savedQueries.map((query) => ({ ...query }));
    this.deferPresetDrafts ??= this.plugin.settings.deferPresets.map((preset) => ({ ...preset }));
    this.savedViewPresetDrafts ??= this.plugin.settings.savedViewPresets?.map((preset) => ({ ...preset })) ?? this.buildSavedViewPresetDraftsFromLegacy();
    containerEl.empty();
    containerEl.addClass('task-manager-settings');
    this.disposeLocaleScope?.();
    this.disposeLocaleScope = applyLocaleScope(containerEl);
    this.renderSettingsInfoCard(containerEl);
    renderSettingsSearch(containerEl, {
      value: this.settingsSearchQuery,
      inputId: `task-manager-settings-search-${this.settingsTabPanelId}`,
      onChange: (value) => { this.settingsSearchQuery = value; this.display(); },
      onClear: () => { this.settingsSearchQuery = ''; this.display(); },
    });
    const requestedAnchor = typeof window !== 'undefined' && window.location.hash.startsWith('#task-manager-setting-') ? decodeURIComponent(window.location.hash.slice(1)) : '';
    if (this.settingsSearchQuery.trim() || requestedAnchor || !this.plugin.settings.settingsTabsEnabled) {
      const allSections = containerEl.createDiv({ cls: 'task-manager-settings-search-results' });
      this.renderAllSettingsSections(allSections);
      indexAndFilterSettings(allSections, this.settingsSearchQuery, requestedAnchor);
      return;
    }

    this.renderSettingsTabs(containerEl);
    const panel = containerEl.createDiv({ cls: 'task-manager-settings-tab-panel' });
    panel.id = this.settingsTabPanelId;
    panel.setAttr('role', 'tabpanel');
    panel.setAttr('aria-labelledby', `${this.settingsTabPanelId}-tab-${this.activeSettingsTab}`);
    panel.tabIndex = -1;
    if (this.activeSettingsTab === 'general') {
      this.renderLanguageAndScanSection(panel);
      this.renderEditorFeaturesSection(panel);
      this.renderLoggingSection(panel);
      this.renderReminderSection(panel);
      this.renderCaptureSection(panel);
    } else if (this.activeSettingsTab === 'query') {
      this.renderFilterAndQuerySection(panel);
      this.renderQueryDisplaySection(panel);
      this.renderPrioritiesAndFieldsSection(panel);
      this.renderPresetsAndQueriesSection(panel);
      this.renderTableViewSection(panel);
    } else if (this.activeSettingsTab === 'views') {
      this.renderOutputSection(panel);
      this.renderPomodoroSection(panel);
      this.renderHabitsAndAppearanceSection(panel);
      this.renderViewPolishSection(panel);
      this.renderKanbanBoardsSection(panel);
      this.renderSavedViewPresetsSection(panel);
    } else if (this.activeSettingsTab === 'sync') {
      this.renderIntegrationSection(panel);
      this.renderCalDavSection(panel);
      this.renderTodoistSection(panel);
      this.renderGoogleSection(panel);
      this.renderAppleRemindersSection(panel);
      this.renderMicrosoftToDoSection(panel);
      this.renderSyncConflictSection(panel);
    } else if (this.activeSettingsTab === 'automation') {
      this.renderRecurrenceSection(panel);
      this.renderVoiceAndAiSection(panel);
      this.renderWorkflowSection(panel);
    } else {
      this.renderAdvancedSection(panel);
    }
    indexAndFilterSettings(panel, '', '');
  }

  private renderAllSettingsSections(containerEl: HTMLElement): void {
    this.renderLanguageAndScanSection(containerEl);
    this.renderFilterAndQuerySection(containerEl);
    this.renderEditorFeaturesSection(containerEl);
    this.renderRecurrenceSection(containerEl);
    this.renderQueryDisplaySection(containerEl);
    this.renderPrioritiesAndFieldsSection(containerEl);
    this.renderPresetsAndQueriesSection(containerEl);
    this.renderTableViewSection(containerEl);
    this.renderLoggingSection(containerEl);
    this.renderReminderSection(containerEl);
    this.renderCaptureSection(containerEl);
    this.renderOutputSection(containerEl);
    this.renderIntegrationSection(containerEl);
    this.renderPomodoroSection(containerEl);
    this.renderHabitsAndAppearanceSection(containerEl);
    this.renderViewPolishSection(containerEl);
    this.renderKanbanBoardsSection(containerEl);
    this.renderSavedViewPresetsSection(containerEl);
    this.renderCalDavSection(containerEl);
    this.renderTodoistSection(containerEl);
    this.renderGoogleSection(containerEl);
    this.renderAppleRemindersSection(containerEl);
    this.renderMicrosoftToDoSection(containerEl);
    this.renderSyncConflictSection(containerEl);
    this.renderVoiceAndAiSection(containerEl);
    this.renderWorkflowSection(containerEl);
    this.renderAdvancedSection(containerEl);
  }

  private renderSettingsInfoCard(containerEl: HTMLElement): void {
    const card = containerEl.createDiv({ cls: 'task-manager-settings-info-card' });
    const title = card.createDiv({ cls: 'task-manager-settings-info-title' });
    title.createSpan({ text: 'Task Manager' });
    title.createSpan({ text: `v${this.plugin.manifest.version}`, cls: 'task-manager-settings-info-version' });
    card.createDiv({ text: 'Markdown-native task management with query views, sync adapters, automation, and visual planning surfaces.', cls: 'task-manager-settings-info-desc' });
    const actions = card.createDiv({ cls: 'task-manager-settings-info-actions' });
    const tabs = actions.createEl('button', { text: this.plugin.settings.settingsTabsEnabled ? 'Use long settings page' : 'Use tabbed settings' });
    tabs.addEventListener('click', () => {
      this.plugin.settings.settingsTabsEnabled = !this.plugin.settings.settingsTabsEnabled;
      void this.plugin.saveSettings().then(() => this.display());
    });
  }

  private renderSettingsTabs(containerEl: HTMLElement): void {
    const tabs = containerEl.createDiv({ cls: 'task-manager-settings-tabs' });
    tabs.setAttr('role', 'tablist');
    tabs.setAttr('aria-label', 'Settings categories');
    const entries: Array<[typeof this.activeSettingsTab, string]> = [
      ['general', 'General'],
      ['query', 'Queries'],
      ['views', 'Views'],
      ['sync', 'Sync'],
      ['automation', 'Automation'],
      ['advanced', 'Advanced'],
    ];
    const buttons: HTMLButtonElement[] = [];
    for (const [id, label] of entries) {
      const selected = this.activeSettingsTab === id;
      const btn = tabs.createEl('button', { text: label, cls: `task-manager-settings-tab${selected ? ' is-active' : ''}` });
      btn.id = `${this.settingsTabPanelId}-tab-${id}`;
      btn.setAttr('role', 'tab');
      btn.setAttr('aria-controls', this.settingsTabPanelId);
      btn.setAttr('aria-selected', String(selected));
      btn.tabIndex = selected ? 0 : -1;
      btn.addEventListener('click', () => {
        this.activeSettingsTab = id;
        this.display();
        this.containerEl.querySelector<HTMLButtonElement>(`#${this.settingsTabPanelId}-tab-${id}`)?.focus();
      });
      buttons.push(btn);
    }
    tabs.addEventListener('keydown', (event: KeyboardEvent) => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
      if (current < 0) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.click();
    });
  }

  private renderTableViewSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Table view' });
    new Setting(containerEl)
      .setName('Show hierarchy by default')
      .setDesc('Render subtasks indented under parent rows in table view. Saved filters can override this state.')
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.tableViewConfig.showHierarchy).onChange(async (value) => {
        this.plugin.settings.tableViewConfig.showHierarchy = value;
        await this.plugin.saveSettings();
      }));
    new Setting(containerEl)
      .setName('Visible table columns')
      .setDesc('Comma-separated column keys. Leave blank for the default table column set.')
      .addText((text) => text
        .setPlaceholder('status, tags, priority, due, file')
        .setValue(this.plugin.settings.tableViewConfig.visibleColumns.join(', '))
        .onChange(async (value) => {
          this.plugin.settings.tableViewConfig.visibleColumns = value.split(',').map((entry) => entry.trim()).filter(Boolean);
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName('Custom table columns')
      .setDesc('Add custom columns as key:Label:type:options:color:required. Types: text, number, date, checkbox, list. List options may use value|#hex for per-value colors.')
      .addTextArea((text) => text
        .setPlaceholder('client:Client:text::#77aaff:false\narea:Area:list:Home|#77aaff,Work|#ffaa77::false')
        .setValue(this.plugin.settings.tableViewConfig.customColumns.map((column) => `${column.key}:${column.label}:${column.type}:${column.options?.join(',') ?? ''}:${column.color ?? ''}:${column.required ? 'true' : 'false'}`).join('\n'))
        .onChange(async (value) => {
          this.plugin.settings.tableViewConfig.customColumns = value.split(/\r?\n/u).map((line) => {
            const [key = '', label = key, type = 'text', options = '', color = '', required = 'false'] = line.split(':').map((part) => part.trim());
            const safeType: TableCustomColumnType = type === 'number' || type === 'date' || type === 'checkbox' || type === 'list' ? type : 'text';
            return {
              key,
              label,
              type: safeType,
              ...(options ? { options: options.split(',').map((entry) => entry.trim()).filter(Boolean) } : {}),
              ...(color && /^#[0-9a-f]{6}$/iu.test(color) ? { color } : {}),
              ...(required === 'true' ? { required: true } : {}),
            };
          }).filter((column) => column.key.length > 0);
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName('Saved table filters')
      .setDesc(`${this.plugin.settings.tableViewConfig.savedFilters.length} saved. Manage these from a rendered table toolbar.`);
  }

  private renderViewPolishSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'View polish' });
    new Setting(containerEl)
      .setName('Recurring task heatmaps')
      .setDesc('Show compact GitHub-style activity heatmaps on recurring tasks in rich list, table, and Kanban views.')
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.recurringHeatmapEnabled).onChange(async (value) => {
        this.plugin.settings.recurringHeatmapEnabled = value;
        await this.plugin.saveSettings();
      }));
    new Setting(containerEl)
      .setName('Tabbed settings layout')
      .setDesc('Group settings into tabs instead of rendering every section in one long page.')
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.settingsTabsEnabled).onChange(async (value) => {
        this.plugin.settings.settingsTabsEnabled = value;
        await this.plugin.saveSettings();
        this.display();
      }));
  }

  private googleCalendarStatusText(): string {
    if (!this.plugin.settings.googleCalendarEnabled) return 'Google Calendar: disabled';
    if (this.plugin.settings.googleCalendarAccessToken.trim()) {
      return this.plugin.settings.googleCalendarDryRun ? 'Google Calendar: ready, dry run on' : 'Google Calendar: ready';
    }
    if (this.plugin.settings.googleCalendarRefreshToken.trim()) return 'Google Calendar: refresh token saved';
    return 'Google Calendar: needs OAuth';
  }

  private renderGoogleSyncSummary(containerEl: HTMLElement): void {
    const card = containerEl.createDiv({ cls: 'task-manager-sync-card' });
    card.createEl('div', { text: 'Google sync', cls: 'task-manager-sync-card__title' });
    const pillRow = card.createDiv({ cls: 'task-manager-sync-pills' });
    pillRow.createEl('span', {
      text: this.plugin.settings.googleCalendarEnabled ? 'Enabled' : 'Disabled',
      cls: `task-manager-sync-pill ${this.plugin.settings.googleCalendarEnabled ? 'is-on' : 'is-off'}`,
    });
    pillRow.createEl('span', {
      text: this.plugin.settings.googleCalendarDryRun ? 'Dry run' : 'Live',
      cls: `task-manager-sync-pill ${this.plugin.settings.googleCalendarDryRun ? 'is-warn' : 'is-on'}`,
    });
    pillRow.createEl('span', {
      text: this.plugin.settings.syncLastSuccessGoogleCalendar ? `Last sync ${this.plugin.settings.syncLastSuccessGoogleCalendar}` : 'Never synced',
      cls: 'task-manager-sync-pill is-neutral',
    });
    card.createEl('div', { text: this.googleCalendarStatusText(), cls: 'task-manager-sync-card__desc' });

    const observability = containerEl.createDiv({ cls: 'task-manager-sync-card' });
    observability.createEl('div', { text: 'Sync observability', cls: 'task-manager-sync-card__title' });
    const latest = this.plugin.settings.syncRunHistory?.[0];
    observability.createEl('div', {
      text: latest
        ? `${latest.service} ${latest.outcome} at ${new Date(latest.endedAt).toLocaleString()} — ${latest.details}`
        : 'No sync runs recorded yet.',
      cls: 'task-manager-sync-card__desc',
    });
  }

  private renderKanbanBoardsSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Kanban boards' });
    new Setting(containerEl)
      .setName('Active board')
      .setDesc('Default board used by dedicated Kanban views and query Kanban selectors.')
      .addDropdown((dropdown) => {
        for (const board of this.plugin.settings.kanbanBoards) dropdown.addOption(board.id, board.name);
        dropdown.setValue(this.plugin.settings.activeKanbanBoardId || this.plugin.settings.kanbanBoards[0]?.id || '').onChange(async (value) => {
          this.plugin.settings.activeKanbanBoardId = value;
          await this.plugin.saveSettings();
        });
      });
    new Setting(containerEl)
      .setName('Board definitions')
      .setDesc('One board per line: id | name | groupBy | query | columns comma-list | background. groupBy: status, priority, tag, project, assignee, custom:field')
      .addTextArea((text) => text
        .setPlaceholder('default | Status Board | status | not done | |\nprojects | Projects | project | not done | | #101820')
        .setValue(this.plugin.settings.kanbanBoards.map((board) => `${board.id} | ${board.name} | ${board.groupBy}${board.customFieldKey ? `:${board.customFieldKey}` : ''} | ${board.query} | ${board.columns.join(', ')} | ${board.background}`).join('\n'))
        .onChange(async (value) => {
          this.plugin.settings.kanbanBoards = value.split(/\r?\n/u).map((line, index) => {
            const [id = `board-${index + 1}`, name = 'Board', groupRaw = 'status', query = 'not done', columns = '', background = ''] = line.split('|').map((part) => part.trim());
            const [groupByRaw, customFieldKey] = groupRaw.split(':').map((part) => part.trim());
            const groupBy: KanbanBoardGroupBy = groupByRaw === 'priority' || groupByRaw === 'tag' || groupByRaw === 'project' || groupByRaw === 'assignee' || groupByRaw === 'custom' ? groupByRaw : 'status';
            return {
              id: id || `board-${index + 1}`,
              name: name || id || `Board ${index + 1}`,
              groupBy,
              ...(customFieldKey ? { customFieldKey } : {}),
              query: query || 'not done',
              columns: columns.split(',').map((entry) => entry.trim()).filter(Boolean),
              background,
            };
          }).filter((board) => board.id);
          if (!this.plugin.settings.kanbanBoards.some((board) => board.id === this.plugin.settings.activeKanbanBoardId)) {
            this.plugin.settings.activeKanbanBoardId = this.plugin.settings.kanbanBoards[0]?.id ?? '';
          }
          await this.plugin.saveSettings();
        }));
  }

  private buildSavedViewPresetDraftsFromLegacy(): SavedViewPreset[] {
    return [
      ...this.plugin.settings.tableViewConfig.savedFilters.map((filter, index) => ({
        id: `table-filter-${index + 1}`,
        kind: 'table-filter' as const,
        view: 'table' as const,
        name: filter.name,
        payload: { ...filter },
      })),
      ...this.plugin.settings.kanbanBoards.map((board) => ({
        id: board.presetId ?? `${board.id}-preset`,
        kind: 'kanban-board' as const,
        view: 'kanban' as const,
        name: board.name,
        payload: { ...board },
      })),
    ];
  }

  private syncLegacyViewStateFromPresets(): void {
    const presets = this.savedViewPresetDrafts ?? [];
    this.plugin.settings.tableViewConfig.savedFilters = presets
      .filter((preset) => preset.kind === 'table-filter' && preset.payload && typeof preset.payload === 'object')
      .map((preset, index) => {
        const payload = preset.payload as Record<string, unknown>;
        return {
          name: typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : preset.name || `Filter ${index + 1}`,
          search: typeof payload.search === 'string' ? payload.search : '',
          statuses: Array.isArray(payload.statuses) ? payload.statuses.filter((entry): entry is string => typeof entry === 'string') : [],
          priorities: Array.isArray(payload.priorities) ? payload.priorities.filter((entry): entry is string => typeof entry === 'string') : [],
          tags: Array.isArray(payload.tags) ? payload.tags.filter((entry): entry is string => typeof entry === 'string') : [],
          sortKey: typeof payload.sortKey === 'string' ? payload.sortKey : 'due',
          sortDirection: payload.sortDirection === 'desc' ? 'desc' : 'asc',
          showHierarchy: payload.showHierarchy !== false,
          visibleColumns: Array.isArray(payload.visibleColumns) ? payload.visibleColumns.filter((entry): entry is string => typeof entry === 'string') : [],
        };
      });
    this.plugin.settings.kanbanBoards = presets
      .filter((preset) => preset.kind === 'kanban-board' && preset.payload && typeof preset.payload === 'object')
      .map((preset, index) => {
        const payload = preset.payload as Record<string, unknown>;
        const groupBy = payload.groupBy === 'priority' || payload.groupBy === 'tag' || payload.groupBy === 'project' || payload.groupBy === 'assignee' || payload.groupBy === 'custom' ? payload.groupBy : 'status';
        return {
          id: typeof payload.id === 'string' && payload.id.trim() ? payload.id.trim() : `board-${index + 1}`,
          name: typeof payload.name === 'string' && payload.name.trim() ? payload.name.trim() : preset.name || `Board ${index + 1}`,
          query: typeof payload.query === 'string' ? payload.query : 'not done',
          groupBy,
          ...(typeof payload.customFieldKey === 'string' && payload.customFieldKey.trim() ? { customFieldKey: payload.customFieldKey.trim() } : {}),
          columns: Array.isArray(payload.columns) ? payload.columns.filter((entry): entry is string => typeof entry === 'string') : [],
          background: typeof payload.background === 'string' ? payload.background : '',
          presetId: preset.id,
        };
      });
  }

  private async persistSavedViewPresetDrafts(): Promise<void> {
    this.plugin.settings.savedViewPresets = this.savedViewPresetDrafts?.map((preset) => ({ ...preset })) ?? [];
    this.syncLegacyViewStateFromPresets();
    await this.plugin.saveSettings();
  }

  private moveSavedViewPreset(index: number, direction: -1 | 1): void {
    const presets = this.savedViewPresetDrafts ?? [];
    const nextIndex = index + direction;
    if (index < 0 || nextIndex < 0 || index >= presets.length || nextIndex >= presets.length) return;
    const next = presets.slice();
    [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
    this.savedViewPresetDrafts = next;
  }

  private duplicateSavedViewPreset(index: number): void {
    const presets = this.savedViewPresetDrafts ?? [];
    const source = presets[index];
    if (!source) return;
    const suffix = ' copy';
    let candidateId = `${source.id}${suffix}`;
    let counter = 2;
    while (presets.some((preset) => preset.id === candidateId)) {
      candidateId = `${source.id}${suffix} ${counter}`;
      counter += 1;
    }
    const copy: SavedViewPreset = { ...source, id: candidateId, name: `${source.name}${suffix}`, payload: source.payload ? { ...source.payload } : undefined };
    this.savedViewPresetDrafts = [...presets.slice(0, index + 1), copy, ...presets.slice(index + 1)];
  }

  private updatePresetPayload(preset: SavedViewPreset, key: string, value: string | string[] | boolean): void {
    const payload = { ...(preset.payload ?? {}) };
    if (Array.isArray(value)) {
      if (value.length > 0) payload[key] = value;
      else delete payload[key];
    } else if (typeof value === 'boolean') {
      payload[key] = value;
    } else if (value.trim()) payload[key] = value.trim();
    else delete payload[key];
    preset.payload = payload;
  }

  private renderSavedViewPresetPayloadEditor(containerEl: HTMLElement, preset: SavedViewPreset, _index: number): void {
    const payloadWrap = containerEl.createDiv({ cls: 'task-manager-settings__preset-payload' });
    payloadWrap.createEl('div', { text: preset.kind === 'table-filter' ? 'Table filter fields' : 'Kanban board fields', cls: 'task-manager-settings__subheading' });
    if (preset.kind === 'table-filter') {
      const payload = preset.payload ?? {};
      new Setting(payloadWrap)
        .setName('Search')
        .setDesc('Text search used by the saved filter.')
        .addText((text) => text.setPlaceholder('Search').setValue(typeof payload.search === 'string' ? payload.search : '').onChange(async (value) => {
          this.updatePresetPayload(preset, 'search', value);
          await this.persistSavedViewPresetDrafts();
        }));
      new Setting(payloadWrap)
        .setName('Query root')
        .setDesc('Optional query fragment used as the saved filter root.')
        .addText((text) => text.setPlaceholder('Query').setValue(typeof payload.query === 'string' ? payload.query : '').onChange(async (value) => {
          this.updatePresetPayload(preset, 'query', value);
          await this.persistSavedViewPresetDrafts();
        }));
      new Setting(payloadWrap)
        .setName('Visible columns')
        .setDesc('Comma-separated list of visible columns.')
        .addText((text) => text.setPlaceholder('status, due, priority').setValue(Array.isArray(payload.visibleColumns) ? payload.visibleColumns.join(', ') : '').onChange(async (value) => {
          this.updatePresetPayload(preset, 'visibleColumns', value.split(',').map((entry) => entry.trim()).filter(Boolean));
          await this.persistSavedViewPresetDrafts();
        }));
      new Setting(payloadWrap)
        .setName('Show hierarchy')
        .setDesc('Toggle hierarchy mode in the saved filter.')
        .addToggle((toggle) => toggle.setValue(payload.showHierarchy !== false).onChange(async (value) => {
          this.updatePresetPayload(preset, 'showHierarchy', value);
          await this.persistSavedViewPresetDrafts();
        }));
    } else {
      const payload = preset.payload ?? {};
      new Setting(payloadWrap)
        .setName('Query')
        .setDesc('Query used to populate the board.')
        .addTextArea((text) => text.setPlaceholder('not done').setValue(typeof payload.query === 'string' ? payload.query : '').onChange(async (value) => {
          this.updatePresetPayload(preset, 'query', value);
          await this.persistSavedViewPresetDrafts();
        }));
      new Setting(payloadWrap)
        .setName('Group by')
        .setDesc('How tasks are grouped on the board.')
        .addDropdown((dropdown) => {
          for (const option of ['status', 'priority', 'tag', 'project', 'assignee', 'custom'] as const) dropdown.addOption(option, option);
          dropdown.setValue(typeof payload.groupBy === 'string' ? payload.groupBy : 'status').onChange(async (value) => {
            this.updatePresetPayload(preset, 'groupBy', value);
            await this.persistSavedViewPresetDrafts();
          });
        });
      new Setting(payloadWrap)
        .setName('Columns')
        .setDesc('Comma-separated columns for custom boards.')
        .addText((text) => text.setPlaceholder('Todo, Doing, Done').setValue(Array.isArray(payload.columns) ? payload.columns.join(', ') : '').onChange(async (value) => {
          this.updatePresetPayload(preset, 'columns', value.split(',').map((entry) => entry.trim()).filter(Boolean));
          await this.persistSavedViewPresetDrafts();
        }));
      new Setting(payloadWrap)
        .setName('Background')
        .setDesc('Optional board background color, token, or CSS value.')
        .addText((text) => text.setPlaceholder('#1f2937').setValue(typeof payload.background === 'string' ? payload.background : '').onChange(async (value) => {
          this.updatePresetPayload(preset, 'background', value);
          await this.persistSavedViewPresetDrafts();
        }));
      new Setting(payloadWrap)
        .setName('Custom field key')
        .setDesc('Optional custom field used by custom grouping.')
        .addText((text) => text.setPlaceholder('project').setValue(typeof payload.customFieldKey === 'string' ? payload.customFieldKey : '').onChange(async (value) => {
          this.updatePresetPayload(preset, 'customFieldKey', value);
          await this.persistSavedViewPresetDrafts();
        }));
    }
  }

  private renderSavedViewPresetsSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Saved view presets' });
    containerEl.createDiv({ text: 'Shared presets back both table filters and Kanban boards. Editing here keeps legacy surfaces in sync and is safe to use as the source of truth for new presets.', cls: 'task-manager-settings__note' });
    const presets = this.savedViewPresetDrafts ?? [];
    if (presets.length === 0) {
      new Setting(containerEl).setName('No presets yet').setDesc('Create a table filter or Kanban board to populate this shared preset list.');
      return;
    }
    presets.forEach((preset, index) => {
      const row = new Setting(containerEl).setClass('task-manager-settings__state-row');
      row.setName(preset.name).setDesc(`${preset.kind} · ${preset.id}`);
      row.addText((text) => text.setPlaceholder('Preset name').setValue(preset.name).onChange(async (value) => {
        preset.name = value.trim() || preset.name;
        await this.persistSavedViewPresetDrafts();
      }));
      row.addText((text) => text.setPlaceholder('Preset id').setValue(preset.id).onChange(async (value) => {
        const nextId = value.trim();
        if (!nextId || nextId === preset.id) return;
        preset.id = nextId;
        if (preset.kind === 'kanban-board' && preset.payload && typeof preset.payload === 'object') {
          preset.payload.id = nextId;
        }
        await this.persistSavedViewPresetDrafts();
      }));
      row.addButton((btn) => btn.setButtonText('Focus fields').onClick(() => {
        this.display();
        const anchor = containerEl.querySelectorAll('.task-manager-settings__preset-payload')[index] as HTMLElement | undefined;
        anchor?.scrollIntoView?.({ behavior: 'smooth', block: 'start' });
      }));
      row.addButton((btn) => btn.setButtonText('▲').setTooltip('Move preset up').onClick(async () => {
        this.moveSavedViewPreset(index, -1);
        await this.persistSavedViewPresetDrafts();
        this.display();
      }));
      row.addButton((btn) => btn.setButtonText('▼').setTooltip('Move preset down').onClick(async () => {
        this.moveSavedViewPreset(index, 1);
        await this.persistSavedViewPresetDrafts();
        this.display();
      }));
      row.addButton((btn) => btn.setButtonText('Duplicate').onClick(async () => {
        this.duplicateSavedViewPreset(index);
        await this.persistSavedViewPresetDrafts();
        this.display();
      }));
      row.addButton((btn) => btn.setButtonText('Delete').setWarning().setTooltip(`Remove ${preset.name}`).onClick(() => {
        confirmSettingsRemoval(this.app, `saved view “${preset.name}”`, async () => {
          this.savedViewPresetDrafts = presets.filter((candidate) => candidate.id !== preset.id);
          await this.persistSavedViewPresetDrafts();
          this.display();
        });
      }));
      this.renderSavedViewPresetPayloadEditor(containerEl, preset, index);
    });
    new Setting(containerEl)
      .setName('Rebuild presets from current legacy views')
      .setDesc('Refresh shared presets from the current table filter and Kanban board settings.')
      .addButton((btn) => btn.setButtonText('Rebuild').onClick(async () => {
        this.savedViewPresetDrafts = this.buildSavedViewPresetDraftsFromLegacy();
        await this.persistSavedViewPresetDrafts();
        this.display();
      }));
  }

  private renderLanguageAndScanSection(containerEl: HTMLElement): void {
    // Language selection
    new Setting(containerEl)
      .setName(t('settings.label.language'))
      .setDesc(t('settings.desc.language'))
      .addDropdown((dropdown) => {
        for (const locale of getAvailableLocales()) {
          const coverage = getTranslationCoverage(locale);
          dropdown.addOption(locale, `${getLocaleName(locale)}${coverage < 100 ? ` (${coverage}% catalogue coverage)` : ''}`);
        }
        dropdown
          .setValue(this.plugin.settings.preferredLocale)
          .onChange(async (value) => {
            setLocale(value);
            // Store preference in plugin settings if available
            if ('preferredLocale' in this.plugin.settings) {
              this.plugin.settings.preferredLocale = value as TaskManagerSettings['preferredLocale'];
              await this.plugin.saveSettings();
            }
            // Refresh the display
            this.display();
          });
      });

    new Setting(containerEl)
      .setName(t('settings.label.enableFileEvents'))
      .setDesc(t('settings.desc.enableFileEvents'))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableFileEvents).onChange(async (value) => {
          this.plugin.settings.enableFileEvents = value;
          await this.plugin.saveSettings();
          this.plugin.refreshWatchers();
        }),
      );

    new Setting(containerEl)
      .setName(t('settings.label.enablePeriodicScan'))
      .setDesc(t('settings.desc.enablePeriodicScan'))
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enablePeriodicScan).onChange(async (value) => {
          this.plugin.settings.enablePeriodicScan = value;
          await this.plugin.saveSettings();
          this.plugin.refreshWatchers();
          this.display();
        }),
      );

    if (this.plugin.settings.enablePeriodicScan) renderScanIntervalSetting(containerEl, this.plugin);

    new Setting(containerEl)
      .setName(t('settings.label.excludedFolders'))
      .setDesc(t('settings.desc.excludedFolders'))
      .addTextArea((text) => {
        text
          .setPlaceholder('Templates, Archive')
          .setValue((this.plugin.settings.excludedFolders ?? []).join(', '))
          .onChange(async (value) => {
            this.plugin.settings.excludedFolders = value
              .split(',')
              .map((entry) => entry.trim().replace(/^\/+|\/+$/gu, '').toLowerCase())
              .filter(Boolean);
            await this.plugin.saveSettings();
          });
        text.inputEl.rows = 2;
      });

  }

  private renderFilterAndQuerySection(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName('Global filter')
      .setDesc('Optional text that must be present for a checklist item to be treated as a task, such as #task. Matching is case-insensitive. When the global filter is a tag (starts with #), nested sub-tags of that tag (e.g. #task/work) are stripped from the task and cannot be used independently. Leave blank to track all checklist items.')
      .addText((text) =>
        text
          .setPlaceholder('#task')
          .setValue(this.plugin.settings.globalFilter)
          .onChange(
            debounce(
              async (value: string) => {
                this.plugin.settings.globalFilter = value.trim();
                await this.plugin.saveSettings();
                void this.plugin.refreshTaskConfiguration(true);
              },
              500,
            ),
          ),
      );

    if (this.plugin.settings.globalFilter) {
      new Setting(containerEl)
        .setName('Remove global filter from description')
        .setDesc('Hide the global filter text in rendered task descriptions and stable task keys. When off, tasks still require the global filter but descriptions keep it visible.')
        .addToggle((toggle) => toggle.setValue(this.plugin.settings.removeGlobalFilterFromDescription).onChange(async (value) => {
          this.plugin.settings.removeGlobalFilterFromDescription = value;
          await this.plugin.saveSettings();
          void this.plugin.refreshTaskConfiguration(true);
        }));
    }

    new Setting(containerEl)
      .setName('Global query')
      .setDesc('Optional Tasks query instructions prepended to every task query block. Use "ignore global query" inside a block to opt out.')
      .addTextArea((text) =>
        text
          .setPlaceholder('path does not include Templates')
          .setValue(this.plugin.settings.globalQuery)
          .onChange(async (value) => {
            this.plugin.settings.globalQuery = value.trim();
            await this.plugin.saveSettings();
            void this.plugin.refreshTaskConfiguration();
          }),
      );

    new Setting(containerEl)
      .setName('Enable advanced query DSL')
      .setDesc('Enable Task Manager’s safe expression DSL for filter/sort/group by function. This is not JavaScript and cannot execute arbitrary code.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableQueryDsl)
          .onChange(async (value) => {
            this.plugin.settings.enableQueryDsl = value;
            await this.plugin.saveSettings();
            void this.plugin.refreshTaskConfiguration();
          }),
      );

    new Setting(containerEl)
      .setName('Enable function expressions in queries')
      .setDesc('Allow filter/sort/group by function expressions. Disable to lock down shared vaults or restrict queries to built-in filters only.')
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.enableDslExpressions)
          .onChange(async (value) => {
            this.plugin.settings.enableDslExpressions = value;
            await this.plugin.saveSettings();
            void this.plugin.refreshTaskConfiguration();
          }),
      );

  }

  private renderEditorFeaturesSection(containerEl: HTMLElement): void {
    // ── Natural language inline entry ──────────────────────────────────────────
    containerEl.createEl('h4', { text: 'Natural language task entry' });
    new Setting(containerEl)
      .setName('Enable inline NL conversion')
      .setDesc('Type a task as plain English starting with the prefix below, then press Enter to auto-convert it to a formatted task.')
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.nlInlineConversionEnabled).onChange(async (value) => {
        this.plugin.settings.nlInlineConversionEnabled = value;
        await this.plugin.saveSettings();
        this.display();
      }));

    if (this.plugin.settings.nlInlineConversionEnabled) {
      new Setting(containerEl)
        .setName('NL task prefix')
        .setDesc('Lines that start with this prefix (followed by a space) are auto-converted on Enter. Default: !! — e.g. "!! call dentist Friday urgent" → "- [ ] call dentist ⏳ 2026-06-06 ⏫"')
        .addText((text) => text
          .setPlaceholder('!!')
          .setValue(this.plugin.settings.nlTaskPrefix ?? '!!')
          .onChange(async (value) => {
            this.plugin.settings.nlTaskPrefix = value.trim() || '!!';
            await this.plugin.saveSettings();
          }));
    }

    // ── Auto-suggest ───────────────────────────────────────────────────────────
    new Setting(containerEl)
      .setName('Enable auto-suggest')
      .setDesc('Show task metadata suggestions while editing task lines.')
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.autoSuggestInEditor).onChange(async (value) => {
        this.plugin.settings.autoSuggestInEditor = value;
        await this.plugin.saveSettings();
        this.display();
      }));

    if (this.plugin.settings.autoSuggestInEditor) {
      new Setting(containerEl)
        .setName('Auto-suggest minimum match length')
        .setDesc('Number of typed characters required before filtered suggestions appear. Use 0 to show generic suggestions immediately.')
        .addText((text) => text.setPlaceholder('0').setValue(String(this.plugin.settings.autoSuggestMinMatch)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          if (!Number.isNaN(parsed)) {
            this.plugin.settings.autoSuggestMinMatch = Math.max(0, Math.min(20, parsed));
            await this.plugin.saveSettings();
          }
        }));

      new Setting(containerEl)
        .setName('Auto-suggest maximum suggestions')
        .setDesc('Maximum suggestions shown in the editor suggestion popup.')
        .addText((text) => text.setPlaceholder('20').setValue(String(this.plugin.settings.autoSuggestMaxItems)).onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          if (!Number.isNaN(parsed) && parsed > 0) {
            this.plugin.settings.autoSuggestMaxItems = Math.max(1, Math.min(100, parsed));
            await this.plugin.saveSettings();
          }
        }));

      new Setting(containerEl)
        .setName('Task line attribute toolbar')
        .setDesc('Show faint 📅 ⏳ 🔼 🔁 👤 icons at the end of task lines on hover. Click an icon to add that attribute via a quick-pick menu — a more visual alternative to slash commands.')
        .addToggle((toggle) => toggle.setValue(this.plugin.settings.taskLineToolbarEnabled).onChange(async (value) => {
          this.plugin.settings.taskLineToolbarEnabled = value;
          await this.plugin.saveSettings();
        }));

      new Setting(containerEl)
        .setName('Enable / slash commands')
        .setDesc('Type / on a task line to get a categorised picker for due date, priority, recurrence, etc. without typing emojis.')
        .addToggle((toggle) => toggle.setValue(this.plugin.settings.slashCommandsInEditor).onChange(async (value) => {
          this.plugin.settings.slashCommandsInEditor = value;
          await this.plugin.saveSettings();
        }));

      new Setting(containerEl)
        .setName('Enable @ assignee trigger')
        .setDesc('Type @ on a task line to assign the task to someone. Inserts 👤 @name into the task.')
        .addToggle((toggle) => toggle.setValue(this.plugin.settings.atAssigneeInEditor).onChange(async (value) => {
          this.plugin.settings.atAssigneeInEditor = value;
          await this.plugin.saveSettings();
        }));
    }

    new Setting(containerEl)
      .setName('Provide access keys in dialogs')
      .setDesc('Add keyboard access keys to fields in the create/edit task dialog. Turn off if they conflict with system shortcuts or assistive technology.')
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.provideAccessKeys).onChange(async (value) => {
        this.plugin.settings.provideAccessKeys = value;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName('Task metadata format')
      .setDesc('Format used when Task Manager writes tasks from its modal. Existing emoji and Dataview fields are both parsed.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('emoji', 'Tasks emoji format')
          .addOption('dataview', 'Dataview inline fields')
          .setValue(this.plugin.settings.taskFormat)
          .onChange(async (value) => {
            this.plugin.settings.taskFormat = value === 'dataview' ? 'dataview' : 'emoji';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Set created date on new tasks')
      .setDesc('Add today’s created date when Task Manager creates a new task or a new recurrence.')
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.setCreatedDate).onChange(async (value) => {
        this.plugin.settings.setCreatedDate = value;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName('Set done date on completed tasks')
      .setDesc('Append a done date when Task Manager changes a task to a Done status.')
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.setDoneDate).onChange(async (value) => {
        this.plugin.settings.setDoneDate = value;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName('Set cancelled date on cancelled tasks')
      .setDesc('Append a cancelled date when Task Manager changes a task to a Cancelled status.')
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.setCancelledDate).onChange(async (value) => {
        this.plugin.settings.setCancelledDate = value;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName('Auto-generate task ID')
      .setDesc('Automatically assign a unique ID (\uD83C\uDD94) to every new task created through the Create/Edit modal. Required for dependencies and external integrations.')
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.autoGenerateTaskId ?? false).onChange(async (value) => {
        this.plugin.settings.autoGenerateTaskId = value;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName('Skip past occurrences on recurrence')
      .setDesc('When completing a recurring task whose next computed occurrence falls in the past, skip forward until the next date is in the future. Only applies to fixed-interval rules; \'when done\' rules are unaffected.')
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.recurrenceSkipToFuture ?? false).onChange(async (value) => {
        this.plugin.settings.recurrenceSkipToFuture = value;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName('Record time-of-day on lifecycle dates')
      .setDesc('When Task Manager writes a done, created, or cancelled date, also append the current HH:MM time (e.g. ✅ 2026-05-26 14:32). Matches upstream Tasks issue #3306.')
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.dateTimeOnLifecycleDates).onChange(async (value) => {
        this.plugin.settings.dateTimeOnLifecycleDates = value;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName('Auto-complete parent tasks')
      .setDesc('When all direct child tasks are done or cancelled, automatically mark the parent task done.')
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.autoCompleteParent).onChange(async (value) => {
        this.plugin.settings.autoCompleteParent = value;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName('Show inline subtask progress bars')
      .setDesc('Render a live progress indicator (e.g. 2/5 ✓) after parent task lines in the editor, showing how many subtasks are complete.')
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.inlineProgressBarsEnabled).onChange(async (value) => {
        this.plugin.settings.inlineProgressBarsEnabled = value;
        await this.plugin.saveSettings();
      }));

  }

  private renderRecurrenceSection(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName('Recurring future occurrences')
      .setDesc('How many future instances to pre-generate when completing a recurring task. Default 1 keeps the current completed task plus the next task available.')
      .addText((text) => text.setPlaceholder('1').setValue(String(this.plugin.settings.recurrenceFutureOccurrences)).onChange(async (value) => {
        const parsed = Number.parseInt(value, 10);
        if (!Number.isNaN(parsed) && parsed >= 0) {
          this.plugin.settings.recurrenceFutureOccurrences = Math.max(0, Math.min(24, parsed));
          await this.plugin.saveSettings();
        }
      }));

    new Setting(containerEl)
      .setName('Recurring task insertion location')
      .setDesc('Where to insert future recurring instances relative to the completed task.')
      .addDropdown((dropdown) => dropdown
        .addOption('before', 'Before completed task')
        .addOption('after', 'After completed task')
        .setValue(this.plugin.settings.recurrenceInsertLocation)
        .onChange(async (value) => {
          this.plugin.settings.recurrenceInsertLocation = value === 'after' ? 'after' : 'before';
          await this.plugin.saveSettings();
        }));

    new Setting(containerEl)
      .setName('Remove scheduled date on recurrence')
      .setDesc('When a recurring task also has a due or start date, remove the scheduled date from new occurrences.')
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.removeScheduledDateOnRecurrence).onChange(async (value) => {
        this.plugin.settings.removeScheduledDateOnRecurrence = value;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName('Advance recurrence when cancelling')
      .setDesc('When a recurring task is marked as cancelled, also create its next occurrence. Disable to only advance recurrence when a task is marked done.')
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.recurrenceOnCancelled).onChange(async (value) => {
        this.plugin.settings.recurrenceOnCancelled = value;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName('Track recurrence count')
      .setDesc('Persist a monotonic completion count for recurring tasks for analytics and recovery. The `for N times` limit works independently.')
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.trackRecurrenceCount).onChange(async (value) => {
        this.plugin.settings.trackRecurrenceCount = value;
        await this.plugin.saveSettings();
      }));

    new Setting(containerEl)
      .setName('Projected future occurrences')
      .setDesc('Max future occurrences to show when `shows future occurrences` appears in a query. Set to 0 to disable projections.')
      .addSlider((slider) =>
        slider
          .setLimits(0, 20, 1)
          .setValue(this.plugin.settings.futureOccurrenceCount)
          .setDynamicTooltip()
          .onChange(async (value) => {
            this.plugin.settings.futureOccurrenceCount = value;
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Use filename as Scheduled date for undated tasks')
      .setDesc('For queries, infer a scheduled date from filenames containing YYYY-MM-DD or YYYYMMDD when a task has no due, scheduled, or start date.')
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.useFilenameAsScheduledDate).onChange(async (value) => {
        this.plugin.settings.useFilenameAsScheduledDate = value;
        await this.plugin.saveSettings();
        void this.plugin.refreshTaskConfiguration();
        this.display();
      }));

    if (this.plugin.settings.useFilenameAsScheduledDate) {
      new Setting(containerEl)
        .setName('Additional filename date format')
        .setDesc('Optional exact filename format, supporting YYYY, MM, DD/dd, and YYYY-[W]ww for weekly notes.')
        .addText((text) => text.setPlaceholder('YYYY-[W]ww').setValue(this.plugin.settings.filenameScheduledDateFormat).onChange(async (value) => {
          this.plugin.settings.filenameScheduledDateFormat = value.trim();
          await this.plugin.saveSettings();
          void this.plugin.refreshTaskConfiguration();
        }));

      new Setting(containerEl)
        .setName('Folders with default Scheduled dates')
        .setDesc('Comma-separated folder list. Leave blank to apply to the whole vault.')
        .addText((text) => text.setPlaceholder('daily, weekly').setValue(this.plugin.settings.filenameScheduledDateFolders).onChange(async (value) => {
          this.plugin.settings.filenameScheduledDateFolders = value.trim();
          await this.plugin.saveSettings();
          void this.plugin.refreshTaskConfiguration();
        }));
    }

    new Setting(containerEl)
      .setName('Enable file-scoped task defaults')
      .setDesc('When enabled, YAML frontmatter properties prefixed with the configured prefix (e.g. task_due, task_priority) set default values for all tasks in that file.')
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.fileDefaultsEnabled).onChange(async (value) => {
        this.plugin.settings.fileDefaultsEnabled = value;
        await this.plugin.saveSettings();
        void this.plugin.refreshTaskConfiguration();
        this.display();
      }));

    if (this.plugin.settings.fileDefaultsEnabled) {
      new Setting(containerEl)
        .setName('File defaults property prefix')
        .setDesc('Frontmatter property prefix for file-scoped task defaults (e.g. task_ matches task_due, task_priority, task_tags).')
        .addText((text) => text.setPlaceholder('task_').setValue(this.plugin.settings.fileDefaultsPropertyPrefix).onChange(async (value) => {
          this.plugin.settings.fileDefaultsPropertyPrefix = value.trim() || 'task_';
          await this.plugin.saveSettings();
          void this.plugin.refreshTaskConfiguration();
        }));
    }

  }

  private renderQueryDisplaySection(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName('Task count location')
      .setDesc('Show query result counts at the top or bottom of results.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('top', 'Top')
          .addOption('bottom', 'Bottom')
          .setValue(this.plugin.settings.taskCountLocation)
          .onChange(async (value) => {
            this.plugin.settings.taskCountLocation = value === 'top' ? 'top' : 'bottom';
            await this.plugin.saveSettings();
            void this.plugin.refreshTaskConfiguration();
          }),
      );

    new Setting(containerEl)
      .setName('Query code block name')
      .setDesc('Preferred fenced code block language for Task Manager queries. Reload the plugin after changing this.')
      .addText((text) =>
        text
          .setPlaceholder('task-list')
          .setValue(this.plugin.settings.queryCodeBlockName)
          .onChange(async (value) => {
            this.plugin.settings.queryCodeBlockName = value.trim() || 'task-list';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Register upstream tasks code block')
      .setDesc('Controls whether Task Manager also renders ```tasks blocks. Reload the plugin after changing this. Use “Always” only if you want Task Manager to handle existing Tasks queries even when the upstream Tasks plugin is installed.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('when-upstream-absent', 'Only when upstream Tasks is absent')
          .addOption('always', 'Always')
          .addOption('never', 'Never')
          .setValue(this.plugin.settings.tasksCodeBlockMode)
          .onChange(async (value) => {
            this.plugin.settings.tasksCodeBlockMode = value === 'always' || value === 'never' ? value : 'when-upstream-absent';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName('Default task sort')
      .setDesc('Default ordering for Task Manager query results when a query does not choose its own sort.')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('smart', 'Smart / urgency')
          .addOption('urgency', 'Urgency')
          .addOption('status', 'Status')
          .addOption('due', 'Due date')
          .addOption('scheduled', 'Scheduled date')
          .addOption('start', 'Start date')
          .addOption('done', 'Done date')
          .addOption('created', 'Created date')
          .addOption('cancelled', 'Cancelled date')
          .addOption('happens', 'Happens date')
          .addOption('priority', 'Priority')
          .addOption('path', 'Source path')
          .addOption('folder', 'Folder')
          .addOption('filename', 'Filename')
          .addOption('heading', 'Heading')
          .addOption('description', 'Description')
          .addOption('recurring', 'Recurring')
          .addOption('tag', 'Tag')
          .addOption('random', 'Random')
          .setValue(this.plugin.settings.defaultSort)
          .onChange(async (value) => {
            this.plugin.settings.defaultSort = value as typeof this.plugin.settings.defaultSort;
            await this.plugin.saveSettings();
            void this.plugin.refreshTaskConfiguration();
          }),
      );

    const modalFieldsEl = this.renderCollapsibleSection(containerEl, 'Create/Edit modal fields', this.isModalFieldsSectionOpen, (isOpen) => {
      this.isModalFieldsSectionOpen = isOpen;
      this.display();
    });
    for (const [key, label] of MODAL_FIELD_LABELS) {
      new Setting(modalFieldsEl)
        .setName(label)
        .setDesc('Show this optional field in the Create/Edit task modal. Hidden fields keep existing values when editing tasks.')
        .addToggle((toggle) => toggle.setValue(this.plugin.settings.modalFields[key]).onChange(async (value) => {
          this.plugin.settings.modalFields = { ...this.plugin.settings.modalFields, [key]: value };
          await this.plugin.saveSettings();
        }));
    }

    const supportedStatesEl = this.renderCollapsibleSection(containerEl, 'Supported states', this.isSupportedStatesSectionOpen, (isOpen) => {
      this.isSupportedStatesSectionOpen = isOpen;
      this.display();
    });

    this.currentTaskStateDrafts().forEach((state, index) => this.renderStateRow(supportedStatesEl, state, index));
    const stateStatus = supportedStatesEl.createDiv({ cls: 'task-manager-settings__state-status', text: this.taskStateAnnouncement });
    stateStatus.setAttr('role', this.taskStateAnnouncementError ? 'alert' : 'status');
    stateStatus.setAttr('aria-live', this.taskStateAnnouncementError ? 'assertive' : 'polite');
    stateStatus.setAttr('aria-atomic', 'true');
    if (this.pendingTaskStateFocusIndex !== null) {
      const focusIndex = this.pendingTaskStateFocusIndex;
      this.pendingTaskStateFocusIndex = null;
      window.setTimeout(() => supportedStatesEl.querySelector<HTMLInputElement>(`[data-state-index="${focusIndex}"] .task-manager-settings__state-name-input`)?.focus(), 0);
    }

    new Setting(supportedStatesEl)
      .setName('Add state')
      .setDesc('Append a new checkbox state. Same-type rows act as aliases during transitions.')
      .addButton((button) =>
        button.setButtonText('Add').onClick(async () => {
          this.taskStateDrafts = [
            ...this.currentTaskStateDrafts(),
            { rawText: this.nextAvailableRawMarker(), name: 'New state', icon: '', type: 'todo' },
          ];
          await this.saveTaskStatesIfValid(true);
          this.display();
        }),
      )
      .addButton((button) =>
        button.setButtonText('Add unknown statuses').onClick(async () => {
          const added = await this.addUnknownTaskStates();
          new Notice(added > 0 ? `Task Manager imported ${added} unknown status${added === 1 ? '' : 'es'}` : 'Task Manager found no unknown statuses to import');
          if (added > 0) this.display();
        }),
      )
      .addButton((button) =>
        button.setButtonText('Restore defaults').onClick(async () => {
          this.taskStateDrafts = DEFAULT_TASK_STATES.map((state) => ({ ...state }));
          await this.saveTaskStatesIfValid(true);
          this.display();
        }),
      );

    for (const collection of TASK_STATE_COLLECTIONS) {
      new Setting(supportedStatesEl)
        .setName(`Import ${collection.name}`)
        .setDesc(collection.description)
        .addButton((button) => button.setButtonText('Merge').onClick(async () => {
          this.taskStateDrafts = mergeTaskStateCollection(this.currentTaskStateDrafts(), collection);
          await this.saveTaskStatesIfValid(true);
          this.display();
        }));
    }

  }

  private renderPrioritiesAndFieldsSection(containerEl: HTMLElement): void {
    // ── Custom Priority Scale ──
    containerEl.createEl('h3', { text: 'Custom priority scale' });
    containerEl.createEl('p', {
      text: 'Define a custom set of priority levels. When non-empty, these replace the built-in Highest/High/Medium/Normal/Low/Lowest levels. Higher value = more urgent.',
      cls: 'setting-item-description',
    });
    this.renderCustomPriorities(containerEl);
    new Setting(containerEl)
      .addButton((btn) =>
        btn.setButtonText('Add priority').onClick(async () => {
          const next: CustomPriority = { label: 'New priority', emoji: '🔷', value: 3 };
          this.plugin.settings.customPriorities = [...this.plugin.settings.customPriorities, next];
          await this.plugin.saveSettings();
          this.display();
        }),
      )
      .addButton((btn) =>
        btn.setButtonText('Clear all (use built-in)').setWarning().onClick(() => {
          confirmSettingsRemoval(this.app, 'all custom priorities', async () => {
            this.plugin.settings.customPriorities = [];
            await this.plugin.saveSettings();
            this.display();
          });
        }),
      );

    // ── Custom Fields ──
    containerEl.createEl('h3', { text: 'Custom fields' });
    containerEl.createEl('p', {
      text: 'Define extra task fields parsed from Dataview inline fields such as [energy:: high] and matching file frontmatter. Use filter by function task.customFields.energy === "high" in queries.',
      cls: 'setting-item-description',
    });
    this.renderCustomFieldDefinitions(containerEl);
    new Setting(containerEl)
      .addButton((btn) => btn.setButtonText('Add field').onClick(async () => {
        this.plugin.settings.customFieldDefinitions = [
          ...this.plugin.settings.customFieldDefinitions,
          { key: 'field', name: 'Field', type: 'text', syncMode: 'read', searchable: true },
        ];
        this.plugin.settings.customFieldDefinitions = normalizeCustomFieldDefinitions(this.plugin.settings.customFieldDefinitions);
        await this.plugin.saveSettings();
        this.display();
      }))
      .addButton((btn) => btn.setButtonText('Clear fields').setWarning().onClick(() => {
        confirmSettingsRemoval(this.app, 'all custom fields', async () => {
          this.plugin.settings.customFieldDefinitions = [];
          await this.plugin.saveSettings();
          this.display();
        });
      }));

    new Setting(containerEl)
      .setName('Postpone button target field')
      .setDesc('Which date field the postpone button (⏩) acts on. \'Auto\' picks due \u2192 scheduled \u2192 start (first populated field).')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('auto', 'Auto (due \u2192 scheduled \u2192 start)')
          .addOption('due', 'Due date only')
          .addOption('scheduled', 'Scheduled date only')
          .addOption('start', 'Start date only')
          .setValue(this.plugin.settings.postponePreferredField ?? 'auto')
          .onChange(async (value) => {
            this.plugin.settings.postponePreferredField = value as 'auto' | 'due' | 'scheduled' | 'start';
            await this.plugin.saveSettings();
          }),
      );

    containerEl.createEl('h3', { text: 'Urgency weights' });
    containerEl.createEl('p', { text: 'Coefficients used in the urgency score formula. Defaults match the upstream obsidian-tasks values.', cls: 'setting-item-description' });
    for (const [key, label, defaultVal] of [
      ['due', 'Due-date coefficient', 12],
      ['priority', 'Priority coefficient', 6],
      ['scheduled', 'Scheduled-date coefficient', 5],
      ['start', 'Start-date coefficient', -3],
    ] as Array<[keyof import('./types').UrgencyWeights, string, number]>) {
      new Setting(containerEl)
        .setName(label)
        .setDesc(`Multiplier applied to the ${key} component of the urgency score. Default: ${defaultVal}.`)
        .addText((text) =>
          text
            .setPlaceholder(String(defaultVal))
            .setValue(String(this.plugin.settings.urgencyWeights?.[key] ?? defaultVal))
            .onChange(async (value) => {
              const parsed = Number.parseFloat(value);
              if (!Number.isFinite(parsed)) return;
              this.plugin.settings.urgencyWeights = {
                ...(this.plugin.settings.urgencyWeights ?? { due: 12, priority: 6, scheduled: 5, start: -3 }),
                [key]: parsed,
              };
              await this.plugin.saveSettings();
            }),
        );
    }

  }

  private renderPresetsAndQueriesSection(containerEl: HTMLElement): void {
    const deferPresetsEl = this.renderCollapsibleSection(containerEl, 'Defer/postpone presets', this.isDeferPresetsSectionOpen, (isOpen) => {
      this.isDeferPresetsSectionOpen = isOpen;
      this.display();
    });

    this.currentDeferPresetDrafts().forEach((preset, index) => this.renderDeferPresetRow(deferPresetsEl, preset, index));

    new Setting(deferPresetsEl)
      .setName('Add preset')
      .setDesc('Append a new relative offset option to the defer/postpone menu.')
      .addButton((button) =>
        button.setButtonText('Add').onClick(async () => {
          this.deferPresetDrafts = [
            ...this.currentDeferPresetDrafts(),
            { label: 'New preset', days: 1 },
          ];
          await this.saveDeferPresetsIfValid();
          this.display();
        }),
      )
      .addButton((button) =>
        button.setButtonText('Restore defaults').onClick(async () => {
          this.deferPresetDrafts = DEFAULT_DEFER_PRESETS.map((preset) => ({ ...preset }));
          await this.saveDeferPresetsIfValid();
          this.display();
        }),
      );

    const savedQueriesEl = this.renderCollapsibleSection(containerEl, 'Saved queries', this.isSavedQueriesSectionOpen, (isOpen) => {
      this.isSavedQueriesSectionOpen = isOpen;
      this.display();
    });

    this.currentSavedQueryDrafts().forEach((query, index) => this.renderSavedQueryRow(savedQueriesEl, query, index));

    new Setting(savedQueriesEl)
      .setName('Add saved query')
      .setDesc('Create reusable query blocks that can be inserted from the command palette.')
      .addButton((button) =>
        button.setButtonText('Add').onClick(async () => {
          this.savedQueryDrafts = [
            ...this.currentSavedQueryDrafts(),
            { name: 'New query', query: 'not done\nsort by smart\nlimit 20' },
          ];
          await this.saveSavedQueriesIfValid();
          this.display();
        }),
      )
      .addButton((button) =>
        button.setButtonText('Restore predefined').onClick(async () => {
          this.savedQueryDrafts = DEFAULT_SAVED_QUERIES.map((query) => ({ ...query }));
          await this.saveSavedQueriesIfValid();
          this.display();
        }),
      );

  }

  private renderLoggingSection(containerEl: HTMLElement): void {

    const loggingEl = this.renderCollapsibleSection(containerEl, 'Logging', this.isLoggingSectionOpen, (isOpen) => {
      this.isLoggingSectionOpen = isOpen;
      this.display();
    });

    new Setting(loggingEl)
      .setName('Daily plan heading')
      .setDesc('Heading written to today\'s daily note when the daily planning assistant completes a session.')
      .addText((text) =>
        text.setPlaceholder('Daily Plan').setValue(this.plugin.settings.dailyPlanHeading).onChange(async (value) => {
          this.plugin.settings.dailyPlanHeading = value.trim() || 'Daily Plan';
          await this.plugin.saveSettings();
        }),
      );

    new Setting(loggingEl)
      .setName(t('settings.label.enableCompletionLogging'))
      .setDesc(t('settings.desc.enableCompletionLogging'))
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.completionLoggingEnabled).onChange(async (value) => {
        this.plugin.settings.completionLoggingEnabled = value;
        await this.plugin.saveSettings();
        this.display();
      }));

    if (!this.plugin.settings.completionLoggingEnabled) {
      loggingEl.createEl('p', {
        text: t('settings.desc.completionLoggingDisabled'),
        cls: 'setting-item-description',
      });
      return;
    }

    new Setting(loggingEl)
      .setName('Log section heading')
      .setDesc('Heading in the daily note where completed tasks will be appended.')
      .addText((text) =>
        text.setValue(this.plugin.settings.logSectionHeading).onChange(async (value) => {
          this.plugin.settings.logSectionHeading = value.trim() || 'Log';
          await this.plugin.saveSettings();
        }),
      );

    new Setting(loggingEl)
      .setName('Include completion time')
      .setDesc('Prefix each log entry with the local completion time, for example “14:32 - Finish report”.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.includeCompletionTime).onChange(async (value) => {
          this.plugin.settings.includeCompletionTime = value;
          await this.plugin.saveSettings();
          this.display();
        }),
      );

    new Setting(loggingEl)
      .setName('Log time format')
      .setDesc('Moment.js format used for log entry times, for example HH:mm or h:mm A.')
      .addText((text) =>
        text
          .setPlaceholder('HH:mm')
          .setValue(this.plugin.settings.logTimeFormat)
          .onChange(async (value) => {
            this.plugin.settings.logTimeFormat = value.trim() || 'HH:mm';
            await this.plugin.saveSettings();
          }),
      );

    new Setting(loggingEl)
      .setName('Include source note link')
      .setDesc('Add a source note link when the completed task is not in today\'s daily note.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.includeSourceLinkWhenNotDailyNote).onChange(async (value) => {
          this.plugin.settings.includeSourceLinkWhenNotDailyNote = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(loggingEl)
      .setName('Log entry template')
      .setDesc('Mustache-style template for completion log entries. Variables: {{time}}, {{date}}, {{task}}, {{file}}, {{tags}}, {{priority}}, {{status}}, {{duration}}. Use {{#time}}...{{/time}} for conditional blocks. Leave blank for the default format.')
      .addText((text) => {
        // eslint-disable-next-line prefer-const
        let input!: HTMLInputElement;
        let previewText: HTMLElement | null = null;

        // Define updatePreview before using it
        const updatePreview = () => {
          if (!previewText) return;
          const template = input.value.trim();
          if (!template) {
            previewText.setText('- 14:30 Complete project documentation | [[Project]]');
          } else {
            // Simple preview rendering
            const preview = template
              .replace(/\{\{time\}\}/g, '14:30')
              .replace(/\{\{date\}\}/g, '2026-05-27')
              .replace(/\{\{task\}\}/g, 'Complete project documentation')
              .replace(/\{\{file\}\}/g, '[[Project]]')
              .replace(/\{\{tags\}\}/g, '#project #documentation')
              .replace(/\{\{priority\}\}/g, '\u23eb')
              .replace(/\{\{status\}\}/g, 'completed')
              .replace(/\{\{duration\}\}/g, '2h 30m')
              .replace(/\{\{#time\}\}(.*?)\{\{\/time\}\}/gs, '$1')
              .replace(/\{\{#file\}\}(.*?)\{\{\/file\}\}/gs, '$1')
              .replace(/\{\{#duration\}\}(.*?)\{\{\/duration\}\}/gs, '$1');
            previewText.setText(preview);
          }
        };

        text
          .setPlaceholder('- {{time}} {{task}} {{#file}}| {{file}}{{/file}}')
          .setValue(this.plugin.settings.logEntryTemplate)
          .onChange(async (value) => {
            this.plugin.settings.logEntryTemplate = value;
            await this.plugin.saveSettings();
            updatePreview();
          });
        input = text.inputEl;
        input.style.width = '100%';
        input.style.minHeight = '60px';
        input.style.fontFamily = 'monospace';

        // Add preview below the input
        const previewContainer = input.parentElement?.createDiv({ cls: 'task-manager-template-preview-container' });
        if (previewContainer) {
          previewContainer.style.cssText = 'margin-top: 1em; padding: 1em; background: var(--background-secondary); border-radius: 4px; border: 1px solid var(--background-modifier-border)';
          const previewLabel = previewContainer.createEl('div', { text: 'Preview:' });
          previewLabel.style.cssText = 'font-weight: bold; margin-bottom: 0.5em; font-size: 0.9em;';
          previewText = previewContainer.createDiv({ cls: 'task-manager-template-preview-text' });
          previewText.style.cssText = 'font-family: monospace; font-size: 0.9em; word-break: break-word;';
          previewText.setText('- 14:30 Complete project documentation | [[Project]]');

          // Preset templates
          const presetsLabel = previewContainer.createEl('div', { text: 'Presets:' });
          presetsLabel.style.cssText = 'font-weight: bold; margin-top: 1em; margin-bottom: 0.5em; font-size: 0.9em;';
          const presetsContainer = previewContainer.createDiv();
          presetsContainer.style.cssText = 'display: flex; gap: 0.5em; flex-wrap: wrap;';

          const presets = [
            { name: 'Simple', template: '- {{task}}' },
            { name: 'With Time', template: '- {{time}} {{task}}' },
            { name: 'With Date', template: '- {{date}} {{time}} {{task}}' },
            { name: 'With Status', template: '- {{task}} ({{status}}) {{#duration}}[{{duration}}]{{/duration}}' },
          ];

          presets.forEach((preset) => {
            const btn = presetsContainer.createEl('button', { text: preset.name });
            btn.style.cssText = 'padding: 4px 8px; font-size: 0.85em; cursor: pointer; border: 1px solid var(--background-modifier-border); border-radius: 3px; background: var(--background-primary); color: var(--text-normal);';
            btn.addEventListener('click', () => {
              input.value = preset.template;
              input.dispatchEvent(new Event('change', { bubbles: true }));
              updatePreview();
            });
          });

          // Initial preview
          updatePreview();
        }
      });

    new Setting(loggingEl)
      .setName('Append daily statistics summary')
      .setDesc('Append a brief statistics line to today’s daily note after each task completion (e.g. ✅ 9 tasks completed today).')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.dailyStatsSummaryEnabled).onChange(async (value) => {
          this.plugin.settings.dailyStatsSummaryEnabled = value;
          await this.plugin.saveSettings();
          this.display();
        }),
      );

    if (this.plugin.settings.dailyStatsSummaryEnabled) {
      new Setting(loggingEl)
        .setName('Summary template')
        .setDesc('Template for the daily stats summary. Variable: {{total}} = total tasks completed today.')
        .addText((text) =>
          text
            .setPlaceholder('> ✅ {{total}} tasks completed')
            .setValue(this.plugin.settings.dailyStatsSummaryTemplate)
            .onChange(async (value) => {
              this.plugin.settings.dailyStatsSummaryTemplate = value.trim() || '> ✅ {{total}} tasks completed';
              await this.plugin.saveSettings();
            }),
        );
    }

    // Completion rollup commands are exposed via the command palette (no dedicated settings beyond this hint).
    containerEl.createEl('p', {
      text: 'Use the \'Generate weekly completion summary\' and \'Generate monthly completion summary\' commands to roll up log entries into a review note.',
      cls: 'setting-item-description',
    });


  }

  private renderReminderSection(containerEl: HTMLElement): void {
    // ── Reminder Notifications ──
    containerEl.createEl('h3', { text: 'Reminder notifications' });
    new Setting(containerEl)
      .setName('Enable reminder notifications')
      .setDesc('Fire an Obsidian notice when a task’s reminder time (⏰) arrives. Polls on the interval below.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableReminderNotifications).onChange(async (value) => {
          this.plugin.settings.enableReminderNotifications = value;
          await this.plugin.saveSettings();
          this.plugin.refreshWatchers();
          this.display();
        }),
      );
    if (this.plugin.settings.enableReminderNotifications) {
      new Setting(containerEl)
        .setName('Reminder check interval (minutes)')
        .setDesc('How often to poll for due reminders (1–60).')
        .addText((text) =>
          text.setPlaceholder('1').setValue(String(this.plugin.settings.reminderCheckIntervalMinutes)).onChange(async (value) => {
            const n = Number.parseInt(value, 10);
            if (!Number.isNaN(n) && n >= 1 && n <= 60) {
              this.plugin.settings.reminderCheckIntervalMinutes = n;
              await this.plugin.saveSettings();
              this.plugin.refreshWatchers();
            }
          }),
        );

      new Setting(containerEl)
        .setName('Use system notifications')
        .setDesc('Use OS-level browser notifications for reminders instead of Obsidian in-app notices. Requires notification permission.')
        .addToggle((toggle) =>
          toggle.setValue(this.plugin.settings.useSystemNotifications).onChange(async (value) => {
            this.plugin.settings.useSystemNotifications = value;
            await this.plugin.saveSettings();
            if (value) {
              const plugin = this.plugin as unknown as { requestSystemNotificationPermission?: () => Promise<void> };
              await plugin.requestSystemNotificationPermission?.();
            }
          }),
        );
    }

  }
  private renderCaptureSection(containerEl: HTMLElement): void {
    containerEl.createEl('h3', { text: 'Quick capture' });
    new Setting(containerEl)
      .setName('Inbox note path')
      .setDesc('Where to append tasks captured via the Quick capture command. Leave blank to use today’s daily note.')
      .addText((text) =>
        text.setPlaceholder('Inbox.md').setValue(this.plugin.settings.quickCaptureInboxPath).onChange(async (value) => {
          this.plugin.settings.quickCaptureInboxPath = value.trim();
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl).setName('Enable external URI actions').setDesc('Allow vault-targeted obsidian:// Task Manager links to create tasks or focus notes. Keep this off unless you use trusted automation.').addToggle((toggle) => toggle.setValue(this.plugin.settings.externalUriActionsEnabled).onChange(async (value) => { this.plugin.settings.externalUriActionsEnabled = value; await this.plugin.saveSettings(); })); new Setting(containerEl).setName('External URI shared secret').setDesc('Required by every enabled external URI action. Include it as the secret parameter and treat the URI as sensitive.').addText((text) => { text.inputEl.type = 'password'; text.setValue(this.plugin.settings.externalUriActionSecret).onChange(async (value) => { this.plugin.settings.externalUriActionSecret = value; await this.plugin.saveSettings(); }); });

    new Setting(containerEl)
      .setName('Task note folder')
      .setDesc('Folder where promoted task notes are created by the \'Promote task to note\' command.')
      .addText((text) =>
        text.setPlaceholder('Tasks/').setValue(this.plugin.settings.taskNoteFolder).onChange(async (value) => {
          this.plugin.settings.taskNoteFolder = value;
          await this.plugin.saveSettings();
        }),
      );

    // ── File-backed task notes
    new Setting(containerEl)
      .setName('Task note folders')
      .setDesc('Comma-separated folder paths where files should be treated as task-note files (e.g., "Tasks, Projects"). Files in these folders are scanned as single-task notes using frontmatter.')
      .addText((text) =>
        text.setPlaceholder('Tasks, Projects').setValue(this.plugin.settings.taskNoteFolders).onChange(async (value) => {
          this.plugin.settings.taskNoteFolders = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Task note frontmatter marker')
      .setDesc('YAML frontmatter field to identify task-note files (e.g., "task: true" or just "task"). Leave blank to disable frontmatter-based detection.')
      .addText((text) =>
        text.setPlaceholder('task: true').setValue(this.plugin.settings.taskNoteMarker).onChange(async (value) => {
          this.plugin.settings.taskNoteMarker = value;
          await this.plugin.saveSettings();
        }),
      );

    // ── Mobile gestures ──
    containerEl.createEl('h3', { text: 'Mobile gestures' });
    new Setting(containerEl)
      .setName('Enable swipe gestures')
      .setDesc('Swipe right on a task row to mark it done; swipe left to open the status menu.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.enableMobileGestures).onChange(async (value) => {
          this.plugin.settings.enableMobileGestures = value;
          await this.plugin.saveSettings();
        }),
      );

    // ── Notifications ──
    containerEl.createEl('h3', { text: 'Notifications' });
    new Setting(containerEl)
      .setName('Show task action notifications')
      .setDesc('Show brief confirmation toasts after actions like completing, cancelling, or bulk-editing tasks. Off by default since the result is already visible in the view. (Errors are always shown.)')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.showActionNotifications).onChange(async (value) => {
          this.plugin.settings.showActionNotifications = value;
          await this.plugin.saveSettings();
        }),
      );

    // ── Task Templates ──
    containerEl.createEl('h3', { text: 'Task templates' });
    containerEl.createEl('p', { text: 'Define reusable task skeletons that can be inserted via the \'Insert task from template\' command.', cls: 'setting-item-description' });
    const templates = this.plugin.settings.taskTemplates;
    for (let i = 0; i < templates.length; i++) {
      const tmpl = templates[i];
      const row = containerEl.createDiv({ cls: 'task-template-row' });
      new Setting(row)
        .setName(`Template: ${tmpl.name}`)
        .setDesc(`Desc: ${tmpl.description || '(none)'}  |  Priority: ${tmpl.priority || 'normal'}  |  Recurrence: ${tmpl.recurrence || '(none)'}`)
        .addButton((btn) => btn.setButtonText('Edit').onClick(() => {
          this.editTemplate(i);
        }))
        .addButton((btn) => btn.setButtonText('Delete').setWarning().setTooltip(`Remove ${tmpl.name}`).onClick(() => {
          confirmSettingsRemoval(this.app, `task template “${tmpl.name}”`, async () => {
            this.plugin.settings.taskTemplates.splice(i, 1);
            await this.plugin.saveSettings();
            this.display();
          });
        }));
    }
    new Setting(containerEl)
      .addButton((btn) => btn.setButtonText('Add template').onClick(() => { this.editTemplate(-1); }));

  }

  private renderOutputSection(containerEl: HTMLElement): void {
    // ── Date Output Format ──
    containerEl.createEl('h3', { text: 'Date output' });
    new Setting(containerEl)
      .setName('Write dates as wiki links')
      .setDesc('When Task Manager writes a date to a task line (e.g. done date), wrap it in [[…]] so it links to the matching daily note.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.dateOutputAsWikiLinks).onChange(async (value) => {
          this.plugin.settings.dateOutputAsWikiLinks = value;
          await this.plugin.saveSettings();
        }),
      );
    new Setting(containerEl)
      .setName('Date display format')
      .setDesc('Moment.js format used when rendering dates in query results (e.g. MMM D, DD/MM/YYYY). Leave blank for the default YYYY-MM-DD.')
      .addText((text) =>
        text
          .setPlaceholder('YYYY-MM-DD')
          .setValue(this.plugin.settings.dateDisplayFormat)
          .onChange(async (value) => {
            this.plugin.settings.dateDisplayFormat = value.trim();
            await this.plugin.saveSettings();
          }),
      );

    // ── On Completion: Archive ──
    containerEl.createEl('h3', { text: 'On-completion: archive' });
    containerEl.createEl('p', { text: 'When a task has 🏁 archive, it is appended to the note and heading below when marked done.', cls: 'setting-item-description' });
    new Setting(containerEl)
      .setName('Archive file path')
      .setDesc('Note to append archived tasks to (e.g. Archive.md). Created if absent.')
      .addText((text) =>
        text
          .setPlaceholder('Archive.md')
          .setValue(this.plugin.settings.archiveFilePath)
          .onChange(async (value) => {
            this.plugin.settings.archiveFilePath = value.trim() || 'Archive.md';
            await this.plugin.saveSettings();
          }),
      );
    new Setting(containerEl)
      .setName('Archive heading')
      .setDesc('Heading inside the archive file to append tasks under.')
      .addText((text) =>
        text
          .setPlaceholder('Archived Tasks')
          .setValue(this.plugin.settings.archiveHeading)
          .onChange(async (value) => {
            this.plugin.settings.archiveHeading = value.trim() || 'Archived Tasks';
            await this.plugin.saveSettings();
          }),
      );

    // ── On Completion: Collect ──
    containerEl.createEl('h3', { text: 'On-completion: collect' });
    containerEl.createEl('p', { text: 'When a task has 🏁 collect, it is appended to the note and heading below when marked done.', cls: 'setting-item-description' });
    new Setting(containerEl)
      .setName('Collect file path')
      .setDesc('Note to append collected tasks to (e.g. Completed.md). Created if absent.')
      .addText((text) =>
        text
          .setPlaceholder('Completed.md')
          .setValue(this.plugin.settings.collectFilePath)
          .onChange(async (value) => {
            this.plugin.settings.collectFilePath = value.trim() || 'Completed.md';
            await this.plugin.saveSettings();
          }),
      );
    new Setting(containerEl)
      .setName('Collect heading')
      .setDesc('Heading inside the collect file to append tasks under.')
      .addText((text) =>
        text
          .setPlaceholder('Collected Tasks')
          .setValue(this.plugin.settings.collectHeading)
          .onChange(async (value) => {
            this.plugin.settings.collectHeading = value.trim() || 'Collected Tasks';
            await this.plugin.saveSettings();
          }),
      );

  }

  private renderIntegrationSection(containerEl: HTMLElement): void {
    renderIntegrationSection(containerEl, this.plugin, () => this.display());
  }

  private renderGoogleSection(containerEl: HTMLElement): void {
    this.renderGoogleSyncSummary(containerEl);
    const actions = containerEl.createDiv({ cls: 'task-manager-sync-card__actions' });
    actions.createEl('button', { text: 'Setup wizard', cls: 'mod-cta task-manager-sync-card__button' }).addEventListener('click', () => {
      this.plugin.openGoogleCalendarSetupWizard();
    });
    actions.createEl('button', { text: 'Calendar quick add', cls: 'task-manager-sync-card__button' }).addEventListener('click', () => {
      this.plugin.openGoogleCalendarQuickCaptureModal();
    });
    actions.createEl('button', {
      text: this.isGoogleAdvancedSectionOpen ? 'Hide advanced' : 'Show advanced',
      cls: 'task-manager-sync-card__button',
      attr: { 'aria-expanded': String(this.isGoogleAdvancedSectionOpen), 'aria-controls': 'task-manager-google-advanced-settings' },
    }).addEventListener('click', () => {
      this.isGoogleAdvancedSectionOpen = !this.isGoogleAdvancedSectionOpen;
      this.display();
    });
    renderGoogleTasksSection(containerEl, this.plugin, () => this.display(), this.isGoogleAdvancedSectionOpen); if (!this.isGoogleAdvancedSectionOpen) return;
    const advanced = containerEl.createDiv({ attr: { id: 'task-manager-google-advanced-settings' } }); advanced.createEl('h3', { text: 'Google advanced' });
    new Setting(advanced)
      .setName('Advanced fields')
      .setDesc('OAuth and dry-run fields stay hidden unless you need them.')
      .addToggle((toggle) => toggle.setValue(this.isGoogleAdvancedSectionOpen).onChange((value) => {
        this.isGoogleAdvancedSectionOpen = value;
        this.display();
      }));
  }

  private renderPomodoroSection(containerEl: HTMLElement): void {
    // ── Pomodoro Timer ──
    containerEl.createEl('h3', { text: 'Pomodoro timer' });
    containerEl.createEl('p', { text: 'Configure Pomodoro work/break cycles for the focus timer. Use the 🍅 button on any task in a query result to start a Pomodoro session.', cls: 'setting-item-description' });
    new Setting(containerEl)
      .setName('Work interval (minutes)')
      .setDesc('Duration of each Pomodoro work block.')
      .addText((text) => text.setPlaceholder('25').setValue(String(this.plugin.settings.pomodoroWorkMinutes)).onChange(async (value) => {
        const n = Number.parseInt(value, 10);
        if (!Number.isNaN(n) && n >= 1 && n <= 120) { this.plugin.settings.pomodoroWorkMinutes = n; await this.plugin.saveSettings(); }
      }));
    new Setting(containerEl)
      .setName('Short break (minutes)')
      .setDesc('Duration of the short break after each work block.')
      .addText((text) => text.setPlaceholder('5').setValue(String(this.plugin.settings.pomodoroBreakMinutes)).onChange(async (value) => {
        const n = Number.parseInt(value, 10);
        if (!Number.isNaN(n) && n >= 1 && n <= 60) { this.plugin.settings.pomodoroBreakMinutes = n; await this.plugin.saveSettings(); }
      }));
    new Setting(containerEl)
      .setName('Long break (minutes)')
      .setDesc('Duration of the long break taken every N work blocks.')
      .addText((text) => text.setPlaceholder('15').setValue(String(this.plugin.settings.pomodoroLongBreakMinutes)).onChange(async (value) => {
        const n = Number.parseInt(value, 10);
        if (!Number.isNaN(n) && n >= 1 && n <= 120) { this.plugin.settings.pomodoroLongBreakMinutes = n; await this.plugin.saveSettings(); }
      }));
    new Setting(containerEl)
      .setName('Long break after N work blocks')
      .setDesc('Number of work blocks before taking a long break.')
      .addText((text) => text.setPlaceholder('4').setValue(String(this.plugin.settings.pomodoroLongBreakAfter)).onChange(async (value) => {
        const n = Number.parseInt(value, 10);
        if (!Number.isNaN(n) && n >= 1 && n <= 20) { this.plugin.settings.pomodoroLongBreakAfter = n; await this.plugin.saveSettings(); }
      }));
    new Setting(containerEl)
      .setName('Log actual time from Pomodoro')
      .setDesc("Completed Pomodoro work sessions automatically accumulate into the task's 🕐 actual time field.")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.pomodoroLogActualTime).onChange(async (value) => {
          this.plugin.settings.pomodoroLogActualTime = value;
          await this.plugin.saveSettings();
        }),
      );

  }

  private renderHabitsAndAppearanceSection(containerEl: HTMLElement): void {
    // ── Habit Tracking ──
    containerEl.createEl('h3', { text: 'Habit tracking' });
    containerEl.createEl('p', {
      text: 'Recurring tasks tagged #habit get a streak heatmap in the sidebar panel.',
      cls: 'setting-item-description',
    });
    new Setting(containerEl)
      .setName('Enable habit tracking')
      .setDesc('Shows a Habits tab in the task sidebar panel.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.habitTrackingEnabled).onChange(async (value) => {
          this.plugin.settings.habitTrackingEnabled = value;
          await this.plugin.saveSettings();
        }),
      );

    new Setting(containerEl)
      .setName('Show pinned task tab')
      .setDesc('Shows a 📌 Pinned tab in the task sidebar panel for active pinned tasks.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.pinnedDockEnabled).onChange(async (value) => {
          this.plugin.settings.pinnedDockEnabled = value;
          await this.plugin.saveSettings();
        }),
      );

    // ── Appearance ──
    containerEl.createEl('h3', { text: 'Appearance' });
    new Setting(containerEl)
      .setName('Task font size')
      .setDesc('Adjust task row text size in Task Manager views.')
      .addDropdown((dropdown) => dropdown
        .addOption('small', 'Small')
        .addOption('normal', 'Normal')
        .addOption('large', 'Large')
        .setValue(this.plugin.settings.taskFontSize)
        .onChange(async (value) => {
          this.plugin.settings.taskFontSize = value === 'small' || value === 'large' ? value : 'normal';
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName('Task row density')
      .setDesc('Adjust padding and line height in task query results.')
      .addDropdown((dropdown) => dropdown
        .addOption('compact', 'Compact')
        .addOption('comfortable', 'Comfortable')
        .addOption('spacious', 'Spacious')
        .setValue(this.plugin.settings.taskDensity)
        .onChange(async (value) => {
          this.plugin.settings.taskDensity = value === 'compact' || value === 'spacious' ? value : 'comfortable';
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName('Dashboard density')
      .setDesc('Control dashboard card spacing, headers, and touch targets.')
      .addDropdown((dropdown) => dropdown
        .addOption('compact', 'Compact')
        .addOption('comfortable', 'Comfortable')
        .addOption('spacious', 'Spacious')
        .setValue(this.plugin.settings.dashboardDensity)
        .onChange(async (value) => {
          this.plugin.settings.dashboardDensity = value === 'compact' || value === 'spacious' ? value : 'comfortable';
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName('Dashboard style')
      .setDesc('Visual treatment for the dashboard view. Native blends with your theme; Command center adds accents and data viz; Minimal is calm and typography-forward.')
      .addDropdown((dropdown) => dropdown
        .addOption('native', 'Clean native')
        .addOption('command-center', 'Command center')
        .addOption('minimal', 'Minimal / calm')
        .setValue(this.plugin.settings.dashboardTheme)
        .onChange(async (value) => {
          this.plugin.settings.dashboardTheme = value === 'command-center' || value === 'minimal' ? value : 'native';
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName('Auto-fit card heights')
      .setDesc('Size each dashboard card to its content and let columns compact automatically, so empty cards shrink and busy cards get the space. Turn off to set card heights manually by dragging.')
      .addToggle((toggle) => toggle
        .setValue(this.plugin.settings.dashboardAutoFitHeights)
        .onChange(async (value) => {
          this.plugin.settings.dashboardAutoFitHeights = value;
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName('Daily goal')
      .setDesc('Target number of tasks to complete per day, shown by the Daily goal dashboard widget.')
      .addText((text) => {
        text.inputEl.type = 'number';
        text.inputEl.min = '1';
        text.inputEl.max = '100';
        text
          .setValue(String(this.plugin.settings.dashboardDailyGoal))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            if (!Number.isFinite(parsed)) return;
            this.plugin.settings.dashboardDailyGoal = Math.max(1, Math.min(100, parsed));
            await this.plugin.saveSettings();
          });
      });
    new Setting(containerEl)
      .setName('Daily focus capacity (minutes)')
      .setDesc('Available focus minutes per day, used by the Capacity planner and Schedule conflicts dashboard widgets.')
      .addText((text) => {
        text.inputEl.type = 'number';
        text.inputEl.min = '30';
        text.inputEl.max = '1440';
        text
          .setValue(String(this.plugin.settings.dashboardCapacityMinutes))
          .onChange(async (value) => {
            const parsed = Number.parseInt(value, 10);
            if (!Number.isFinite(parsed)) return;
            this.plugin.settings.dashboardCapacityMinutes = Math.max(30, Math.min(1440, parsed));
            await this.plugin.saveSettings();
          });
      });
    new Setting(containerEl)
      .setName('Goal tag prefix')
      .setDesc('Tag prefix that defines a goal for the Goals & objectives widget. “goal” matches #goal/<name>.')
      .addText((text) => text
        .setPlaceholder('goal')
        .setValue(this.plugin.settings.dashboardGoalTagPrefix)
        .onChange(async (value) => {
          const cleaned = value.trim().replace(/^#+/u, '').replace(/[\s/-]+$/u, '').trim();
          this.plugin.settings.dashboardGoalTagPrefix = cleaned || 'goal';
          await this.plugin.saveSettings();
        }));
    new Setting(containerEl)
      .setName('Area tag prefix')
      .setDesc('Tag prefix that defines an area for the Areas of responsibility widget. “area” matches #area/<name>.')
      .addText((text) => text
        .setPlaceholder('area')
        .setValue(this.plugin.settings.dashboardAreaTagPrefix)
        .onChange(async (value) => {
          const cleaned = value.trim().replace(/^#+/u, '').replace(/[\s/-]+$/u, '').trim();
          this.plugin.settings.dashboardAreaTagPrefix = cleaned || 'area';
          await this.plugin.saveSettings();
        }));
    for (const priority of ['highest', 'high', 'medium', 'normal', 'low', 'lowest']) {
      const setting = new Setting(containerEl)
        .setName(`Priority color: ${priority}`)
        .setDesc('Optional hex color override for this priority.');
      const input = setting.controlEl.createEl('input', { type: 'color' });
      input.value = this.plugin.settings.priorityColorOverrides[priority] || '#888888';
      input.addEventListener('change', () => {
        this.plugin.settings.priorityColorOverrides = { ...this.plugin.settings.priorityColorOverrides, [priority]: input.value };
        void this.plugin.saveSettings();
      });
      setting.addExtraButton((btn) => btn.setIcon('reset').setTooltip('Clear override').onClick(async () => {
        const next = { ...this.plugin.settings.priorityColorOverrides };
        delete next[priority];
        this.plugin.settings.priorityColorOverrides = next;
        await this.plugin.saveSettings();
        this.display();
      }));
    }
    new Setting(containerEl)
      .setName('Show priority pills')
      .setDesc('Render priority values with colored pill backgrounds where supported.')
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.showPriorityPills).onChange(async (value) => {
        this.plugin.settings.showPriorityPills = value;
        await this.plugin.saveSettings();
      }));
    new Setting(containerEl)
      .setName('Show status icons')
      .setDesc('Show status icons in Task Manager query rows where supported.')
      .addToggle((toggle) => toggle.setValue(this.plugin.settings.showStatusIcons).onChange(async (value) => {
        this.plugin.settings.showStatusIcons = value;
        await this.plugin.saveSettings();
      }));

    // ── Gamification ──
    containerEl.createEl('h3', { text: 'Gamification' });
    containerEl.createEl('p', {
      text: 'Earn achievement badges and points for completing tasks and maintaining streaks.',
      cls: 'setting-item-description',
    });
    new Setting(containerEl)
      .setName('Enable gamification')
      .setDesc('Show achievement badges and total points in the Stats query view.')
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.gamificationEnabled).onChange(async (value) => {
          this.plugin.settings.gamificationEnabled = value;
          await this.plugin.saveSettings();
        }),
      );

    // ── Capacity Analytics ──
    containerEl.createEl('h3', { text: 'Capacity Analytics' });
    containerEl.createEl('p', {
      text: 'Track daily task capacity and generate weekly analytics reports. Weekly summary command: task manager: weekly summary.',
      cls: 'setting-item-description',
    });
    new Setting(containerEl)
      .setName('Daily capacity (minutes)')
      .setDesc('Set daily task capacity in minutes (e.g., 480 for 8 hours). 0 = disabled. Used for capacity warnings and weekly summary.')
      .addText((text) =>
        text.setPlaceholder('480').setValue(String(this.plugin.settings.dailyCapacityMinutes)).onChange(async (value) => {
          const num = Number.parseInt(value, 10);
          if (!Number.isNaN(num) && num >= 0) {
            this.plugin.settings.dailyCapacityMinutes = num;
            await this.plugin.saveSettings();
          }
        }),
      );

  }

  private renderCalDavSection(containerEl: HTMLElement): void {
    renderCalDavSection(containerEl, this.plugin, () => this.display());
  }

  private renderTodoistSection(containerEl: HTMLElement): void {
    renderTodoistSection(containerEl, this.plugin, () => this.display());
  }

  private renderGoogleTasksSection(containerEl: HTMLElement): void {
    renderGoogleTasksSection(containerEl, this.plugin, () => this.display());
  }

  private renderAppleRemindersSection(containerEl: HTMLElement): void {
    renderAppleRemindersSection(containerEl, this.plugin, () => this.display());
  }

  private renderMicrosoftToDoSection(containerEl: HTMLElement): void {
    renderMicrosoftToDoSection(containerEl, this.plugin, () => this.display());
  }

  private renderSyncConflictSection(containerEl: HTMLElement): void {
    // ── Sync Conflict Resolution ──
    containerEl.createEl('h3', { text: 'Sync conflict resolution' });
    new Setting(containerEl)
      .setName('Conflict direction')
      .setDesc('When a task is modified in both Obsidian and an external service between syncs, which version wins?')
      .addDropdown((dropdown) =>
        dropdown
          .addOption('vault-first', 'Vault wins (Obsidian overwrites external)')
          .addOption('service-first', 'Service wins (external overwrites vault)')
          .setValue(this.plugin.settings.syncConflictDirection)
          .onChange(async (value) => {
            this.plugin.settings.syncConflictDirection = value === 'service-first' ? 'service-first' : 'vault-first';
            await this.plugin.saveSettings();
          }),
      );

    // #6: Conflict report log path
    new Setting(containerEl)
      .setName('Conflict report note path')
      .setDesc('Vault path for the sync conflict report note. Conflicts detected during sync are appended here.')
      .addText((text) =>
        text
          .setPlaceholder('Sync Conflicts.md')
          .setValue(this.plugin.settings.syncConflictLogPath)
          .onChange(async (value) => {
            this.plugin.settings.syncConflictLogPath = value.trim() || 'Sync Conflicts.md';
            await this.plugin.saveSettings();
          }),
      );

  }

  private renderVoiceAndAiSection(containerEl: HTMLElement): void {
    renderVoiceAndAiSection(containerEl, this.plugin, () => this.display());
  }

  private renderWorkflowSection(containerEl: HTMLElement): void {
    renderWorkflowSection(containerEl, this.plugin, () => this.display());
  }

  private renderAdvancedSection(containerEl: HTMLElement): void {
    renderAdvancedSection(containerEl, this.plugin, () => this.display());
  }


  private async addUnknownTaskStates(): Promise<number> {
    const known = new Set(this.currentTaskStateDrafts().map((state) => state.rawText));
    const unknown = new Map<string, number>();
    const taskLinePattern = /^(?:\s*>\s*)*\s*(?:[-*+]|\d+[.)])\s+\[([^\]]+)\]\s+(.*)$/u;
    const excluded = this.plugin.settings.excludedFolders ?? [];
    const files = this.app.vault.getMarkdownFiles().filter((file) => {
      if (excluded.length === 0) return true;
      const lowerPath = file.path.toLowerCase();
      return !excluded.some((prefix) => lowerPath.startsWith(`${prefix}/`) || lowerPath === prefix);
    });
    for (const file of files) {
      const content = await this.app.vault.cachedRead(file);
      for (const line of content.split(/\r?\n/u)) {
        const match = line.match(taskLinePattern);
        if (!match) continue;
        const marker = match[1];
        const body = match[2];
        if (this.plugin.settings.globalFilter && !body.toLowerCase().includes(this.plugin.settings.globalFilter.toLowerCase())) continue;
        if (!known.has(marker)) unknown.set(marker, (unknown.get(marker) ?? 0) + 1);
      }
    }

    if (unknown.size === 0) return 0;
    const doneSymbol = this.currentTaskStateDrafts().find((state) => state.type === 'done')?.rawText ?? 'x';
    const imported = Array.from(unknown.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([marker, count]) => ({
        rawText: marker,
        name: `Unknown ${this.formatStateRawInput(marker)} (${count})`,
        icon: '',
        type: 'todo' as const,
        nextStatusSymbol: doneSymbol,
      }));
    this.taskStateDrafts = [...this.currentTaskStateDrafts(), ...imported];
    await this.saveTaskStatesIfValid(true);
    return imported.length;
  }

  private renderCollapsibleSection(
    containerEl: HTMLElement,
    title: string,
    isOpen: boolean,
    onToggle: (isOpen: boolean) => void,
  ): HTMLElement {
    const sectionEl = containerEl.createDiv({ cls: 'task-manager-settings__collapsible-section' });
    const headerEl = sectionEl.createDiv({ cls: 'task-manager-settings__section-header' });
    headerEl.setAttr('role', 'button');
    headerEl.setAttr('tabindex', '0');
    headerEl.setAttr('aria-expanded', String(isOpen));
    headerEl.addEventListener('click', () => onToggle(!isOpen));
    headerEl.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onToggle(!isOpen);
      }
    });
    headerEl.createSpan({
      cls: 'task-manager-settings__section-chevron',
      text: isOpen ? '▾' : '▸',
    });
    headerEl.createSpan({
      cls: 'task-manager-settings__section-title',
      text: title,
    });

    const contentEl = sectionEl.createDiv({ cls: 'task-manager-settings__section-content' });
    contentEl.toggleClass('task-manager-settings__section-content--collapsed', !isOpen);

    return contentEl;
  }

  private renderStateRow(containerEl: HTMLElement, state: TaskStateDefinition, index: number): void {
    const setting = new Setting(containerEl).setName(`${index + 1}. ${state.name}`);

    setting.settingEl.addClass('task-manager-settings__state-row');
    setting.settingEl.dataset.stateIndex = String(index);
    const labelControl = (control: HTMLInputElement | HTMLSelectElement, label: string, key: string): void => {
      const id = `task-manager-state-${index}-${key}`;
      control.id = id;
      const wrapper = setting.controlEl.createDiv({ cls: 'task-manager-settings__state-field' });
      setting.controlEl.insertBefore(wrapper, control);
      const labelEl = wrapper.createEl('label', { text: label, cls: 'task-manager-settings__state-field-label' });
      labelEl.htmlFor = id;
      wrapper.appendChild(control);
    };
    setting.settingEl.setAttr('draggable', 'true');
    setting.settingEl.addEventListener('dragstart', (event) => {
      setting.settingEl.addClass('task-manager-settings__state-row--dragging');
      event.dataTransfer?.setData('text/plain', String(index));
      event.dataTransfer?.setData('application/x-task-manager-state-index', String(index));
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
      }
    });
    setting.settingEl.addEventListener('dragend', () => {
      setting.settingEl.removeClass('task-manager-settings__state-row--dragging');
      setting.settingEl.removeClass('task-manager-settings__state-row--drop-target');
    });
    setting.settingEl.addEventListener('dragover', (event) => {
      event.preventDefault();
      setting.settingEl.addClass('task-manager-settings__state-row--drop-target');
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'move';
      }
    });
    setting.settingEl.addEventListener('dragleave', (event: DragEvent) => {
      if (!hasPointerLeftElement(setting.settingEl, event)) return;
      setting.settingEl.removeClass('task-manager-settings__state-row--drop-target');
    });
    setting.settingEl.addEventListener('drop', (event) => {
      event.preventDefault();
      setting.settingEl.removeClass('task-manager-settings__state-row--drop-target');
      const from = Number.parseInt(
        event.dataTransfer?.getData('application/x-task-manager-state-index') || event.dataTransfer?.getData('text/plain') || '',
        10,
      );
      if (!Number.isNaN(from) && from !== index) {
        const movedState = this.currentTaskStateDrafts()[from];
        this.moveState(from, index);
        this.pendingTaskStateFocusIndex = index;
        this.taskStateAnnouncement = t('settings.state.moved', { state: movedState?.name ?? '', position: index + 1 });
        void this.saveTaskStatesIfValid(false).then(() => this.display());
      }
    });

    setting.addText((text) => {
      text.inputEl.addClass('task-manager-settings__raw-input');
      text.inputEl.setAttribute('aria-label', `${state.name}: ${t('settings.state.marker')}`);
      text.inputEl.setAttribute('title', t('settings.state.marker'));
      labelControl(text.inputEl, t('settings.state.marker'), 'marker');
      text
        .setPlaceholder('- [ ]')
        .setValue(this.formatStateRawInput(state.rawText))
        .onChange(async (value) => this.updateState(index, { rawText: this.parseStateRawInput(value) }));
    });
    setting.addText((text) => {
      text.inputEl.addClass('task-manager-settings__state-name-input');
      text.inputEl.setAttribute('aria-label', `${state.name}: ${t('settings.state.name')}`);
      text.inputEl.setAttribute('title', t('settings.state.name'));
      labelControl(text.inputEl, t('settings.state.name'), 'name');
      text
        .setPlaceholder('Name')
        .setValue(state.name)
        .onChange(async (value) => this.updateState(index, { name: value }));
    });
    setting.addText((text) => {
      text.inputEl.addClass('task-manager-settings__icon-input');
      text.inputEl.setAttribute('aria-label', `${state.name}: ${t('settings.state.icon')}`);
      text.inputEl.setAttribute('title', t('settings.state.icon'));
      labelControl(text.inputEl, t('settings.state.icon'), 'icon');
      if (!state.icon.trim()) {
        text.inputEl.addClass('task-manager-settings__icon-input--default');
      }
      text
        .setPlaceholder(defaultTaskStateIcon(state.rawText, state.type))
        .setValue(state.icon)
        .onChange(async (value) => {
          text.inputEl.toggleClass('task-manager-settings__icon-input--default', !value.trim());
          await this.updateState(index, { icon: value });
        });
    });
    setting.addDropdown((dropdown) => {
      dropdown.selectEl.addClass('task-manager-settings__state-type-input');
      dropdown.selectEl.setAttribute('aria-label', `${state.name}: ${t('settings.state.type')}`);
      dropdown.selectEl.setAttribute('title', t('settings.state.type'));
      labelControl(dropdown.selectEl, t('settings.state.type'), 'type');
      for (const type of STATE_TYPES) {
        dropdown.addOption(type, this.formatStateType(type));
      }
      dropdown.setValue(state.type).onChange(async (value) => this.updateState(index, { type: value as TaskStateType }));
    });
    setting.addText((text) => {
      text.inputEl.addClass('task-manager-settings__next-status-input');
      text.inputEl.setAttribute('aria-label', `${state.name}: ${t('settings.state.nextMarker')}`);
      text.inputEl.setAttribute('title', t('settings.state.nextMarker'));
      labelControl(text.inputEl, t('settings.state.nextMarker'), 'next');
      text
        .setPlaceholder('Next, e.g. - [x]')
        .setValue(state.nextStatusSymbol !== undefined ? this.formatStateRawInput(state.nextStatusSymbol) : '')
        .onChange(async (value) => {
          const parsed = value.trim() ? this.parseStateRawInput(value) : undefined;
          await this.updateState(index, { nextStatusSymbol: parsed });
        });
    });
    setting.addButton((button) => {
      button.setIcon('arrow-up').setTooltip(`Move ${state.name} up`).setDisabled(index === 0).onClick(async () => {
        this.moveState(index, index - 1);
        this.pendingTaskStateFocusIndex = index - 1;
        this.taskStateAnnouncement = t('settings.state.moved', { state: state.name, position: index });
        await this.saveTaskStatesIfValid(false);
        this.display();
      });
    });
    setting.addButton((button) => {
      const lastIndex = this.currentTaskStateDrafts().length - 1;
      button.setIcon('arrow-down').setTooltip(`Move ${state.name} down`).setDisabled(index === lastIndex).onClick(async () => {
        this.moveState(index, index + 1);
        this.pendingTaskStateFocusIndex = index + 1;
        this.taskStateAnnouncement = t('settings.state.moved', { state: state.name, position: index + 2 });
        await this.saveTaskStatesIfValid(false);
        this.display();
      });
    });
    setting.addButton((button) => {
      button.buttonEl.addClass('task-manager-settings__remove-button');
      button.setButtonText('-').setTooltip(`Remove state ${state.name}`).onClick(() => {
        confirmSettingsRemoval(this.app, `state “${state.name}”`, async () => {
          this.taskStateDrafts = this.currentTaskStateDrafts().filter((_, stateIndex) => stateIndex !== index);
          await this.saveTaskStatesIfValid(true);
          this.display();
        });
      });
    });
  }

  private renderSavedQueryRow(containerEl: HTMLElement, query: SavedTaskQuery, index: number): void {
    const setting = new Setting(containerEl)
      .setName(`${index + 1}. Saved query`)
      .setDesc('Name and reusable Task Manager query text.');

    setting.settingEl.addClass('task-manager-settings__query-row');
    setting.addText((text) =>
      text
        .setPlaceholder('Name')
        .setValue(query.name)
        .onChange(async (value) => this.updateSavedQuery(index, { name: value })),
    );
    setting.addTextArea((text) => {
      text.inputEl.addClass('task-manager-settings__query-input');
      text
        .setPlaceholder('not done\nsort by smart\nlimit 20')
        .setValue(query.query)
        .onChange(async (value) => this.updateSavedQuery(index, { query: value }));
    });
    setting.addButton((button) =>
      button.setButtonText('-').setTooltip(`Remove saved query ${query.name}`).onClick(() => {
        confirmSettingsRemoval(this.app, `saved query “${query.name}”`, async () => {
          this.savedQueryDrafts = this.currentSavedQueryDrafts().filter((_, queryIndex) => queryIndex !== index);
          await this.saveSavedQueriesIfValid();
          this.display();
        });
      }),
    );
  }

  private renderCustomFieldDefinitions(containerEl: HTMLElement): void {
    const fields = this.plugin.settings.customFieldDefinitions;
    if (fields.length === 0) {
      containerEl.createEl('p', {
        text: 'No custom fields defined. Add one to parse matching [key:: value] inline fields and file frontmatter properties.',
        cls: 'setting-item-description',
      });
      return;
    }

    const saveField = async (index: number, patch: Partial<CustomFieldDefinition>): Promise<void> => {
      const next = [...this.plugin.settings.customFieldDefinitions];
      next[index] = { ...next[index], ...patch };
      this.plugin.settings.customFieldDefinitions = normalizeCustomFieldDefinitions(next);
      await this.plugin.saveSettings();
    };

    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      const row = new Setting(containerEl);
      row.settingEl.addClass('task-manager-settings__custom-field-row');
      row.addText((text) => {
        text.inputEl.title = 'Field key used in [key:: value] and task.customFields.key. Use letters, numbers, and underscores only; hyphenated keys are ignored.';
        text.setPlaceholder('key').setValue(field.key).onChange(async (value) => {
          await saveField(i, { key: value.trim() });
        });
      });
      row.addText((text) => {
        text.inputEl.title = 'Display name';
        text.setPlaceholder('Name').setValue(field.name).onChange(async (value) => {
          await saveField(i, { name: value });
        });
      });
      row.addDropdown((dropdown) => {
        dropdown
          .addOption('text', 'Text')
          .addOption('number', 'Number')
          .addOption('select', 'Select')
          .addOption('date', 'Date')
          .addOption('tags', 'Tags')
          .setValue(field.type)
          .onChange(async (value) => {
            await saveField(i, { type: value as CustomFieldDefinition['type'] });
            this.display();
          });
      });
      row.addText((text) => {
        text.inputEl.title = 'Select options, comma-separated';
        text.setPlaceholder('options').setValue((field.options ?? []).join(', ')).onChange(async (value) => {
          await saveField(i, { options: value.split(',').map((entry) => entry.trim()).filter(Boolean) });
        });
      });
      row.addText((text) => {
        text.inputEl.title = 'Optional frontmatter key override';
        text.setPlaceholder('frontmatter key').setValue(field.frontmatterKey ?? '').onChange(async (value) => {
          await saveField(i, { frontmatterKey: value.trim() || undefined });
        });
      });
      row.addDropdown((dropdown) => {
        dropdown
          .addOption('none', 'Markdown only')
          .addOption('read', 'Read frontmatter')
          .addOption('write', 'Write only')
          .addOption('bidirectional', 'Bidirectional')
          .setValue(field.syncMode ?? 'read')
          .onChange(async (value) => saveField(i, { syncMode: value as CustomFieldDefinition['syncMode'] }));
      });
      row.addButton((btn) => btn.setButtonText('-').setTooltip(`Remove custom field ${field.name || field.key}`).onClick(() => {
        confirmSettingsRemoval(this.app, `custom field “${field.name || field.key}”`, async () => {
          this.plugin.settings.customFieldDefinitions = this.plugin.settings.customFieldDefinitions.filter((_, idx) => idx !== i);
          await this.plugin.saveSettings();
          this.display();
        });
      }));
    }
  }

  private renderCustomPriorities(containerEl: HTMLElement): void {
    const priorities = this.plugin.settings.customPriorities;
    if (priorities.length === 0) {
      containerEl.createEl('p', {
        text: 'No custom priorities defined. Using built-in Highest/High/Medium/Normal/Low/Lowest levels.',
        cls: 'setting-item-description',
      });
      return;
    }
    for (let i = 0; i < priorities.length; i++) {
      const p = priorities[i];
      const row = new Setting(containerEl);
      row.settingEl.addClass('task-manager-settings__priority-row');
      row.addText((t) =>
        t.setPlaceholder('Label').setValue(p.label).onChange(async (v) => {
          this.plugin.settings.customPriorities[i] = { ...this.plugin.settings.customPriorities[i], label: v };
          this.plugin.settings.customPriorities = normalizeCustomPriorities(this.plugin.settings.customPriorities);
          await this.plugin.saveSettings();
        }),
      );
      row.addText((t) => {
        t.inputEl.addClass('task-manager-settings__icon-input');
        t.setPlaceholder('🔷').setValue(p.emoji).onChange(async (v) => {
          this.plugin.settings.customPriorities[i] = { ...this.plugin.settings.customPriorities[i], emoji: v.trim() };
          await this.plugin.saveSettings();
        });
      });
      row.addText((t) => {
        t.inputEl.addClass('task-manager-settings__defer-number-input');
        t.inputEl.title = 'Sort value (higher = more urgent)';
        t.setPlaceholder('value').setValue(String(p.value)).onChange(async (v) => {
          const trimmed = v.trim();
          if (!trimmed) return;
          const n = Number(trimmed);
          if (!Number.isFinite(n)) return;
          this.plugin.settings.customPriorities[i] = { ...this.plugin.settings.customPriorities[i], value: n };
          await this.plugin.saveSettings();
        });
      });
      row.addButton((btn) =>
        btn.setButtonText('-').setTooltip(`Remove priority ${p.label}`).onClick(() => {
          confirmSettingsRemoval(this.app, `priority “${p.label}”`, async () => {
            this.plugin.settings.customPriorities = this.plugin.settings.customPriorities.filter((_, idx) => idx !== i);
            await this.plugin.saveSettings();
            this.display();
          });
        }),
      );
    }
  }

  private renderDeferPresetRow(containerEl: HTMLElement, preset: DeferPreset, index: number): void {
    const setting = new Setting(containerEl);
    setting.settingEl.addClass('task-manager-settings__defer-preset-row');

    setting.addText((text) =>
      text
        .setPlaceholder('Label, e.g. 2 days')
        .setValue(preset.label)
        .onChange(async (value) => this.updateDeferPreset(index, { label: value })),
    );

    setting.addText((text) => {
      text.inputEl.addClass('task-manager-settings__defer-number-input');
      text
        .setPlaceholder('days')
        .setValue(preset.days !== undefined ? String(preset.days) : '')
        .onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          await this.updateDeferPreset(index, { days: !Number.isNaN(parsed) && parsed > 0 ? parsed : undefined });
        });
      text.inputEl.title = 'Days';
      text.inputEl.setAttr('aria-label', 'Days');
      return text;
    });

    setting.addText((text) => {
      text.inputEl.addClass('task-manager-settings__defer-number-input');
      text
        .setPlaceholder('weeks')
        .setValue(preset.weeks !== undefined ? String(preset.weeks) : '')
        .onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          await this.updateDeferPreset(index, { weeks: !Number.isNaN(parsed) && parsed > 0 ? parsed : undefined });
        });
      text.inputEl.title = 'Weeks';
      text.inputEl.setAttr('aria-label', 'Weeks');
      return text;
    });

    setting.addText((text) => {
      text.inputEl.addClass('task-manager-settings__defer-number-input');
      text
        .setPlaceholder('months')
        .setValue(preset.months !== undefined ? String(preset.months) : '')
        .onChange(async (value) => {
          const parsed = Number.parseInt(value, 10);
          await this.updateDeferPreset(index, { months: !Number.isNaN(parsed) && parsed > 0 ? parsed : undefined });
        });
      text.inputEl.title = 'Months';
      text.inputEl.setAttr('aria-label', 'Months');
      return text;
    });

    setting.addButton((button) => {
      button.buttonEl.addClass('task-manager-settings__remove-button');
      button.setButtonText('-').setTooltip(`Remove preset ${preset.label}`).onClick(() => {
        confirmSettingsRemoval(this.app, `defer preset “${preset.label}”`, async () => {
          this.deferPresetDrafts = this.currentDeferPresetDrafts().filter((_, i) => i !== index);
          await this.saveDeferPresetsIfValid();
          this.display();
        });
      });
    });
  }

  private async updateDeferPreset(index: number, patch: Partial<DeferPreset>): Promise<void> {
    const presets = this.currentDeferPresetDrafts();
    presets[index] = { ...presets[index], ...patch };
    this.deferPresetDrafts = presets;
    await this.saveDeferPresetsIfValid();
  }

  private currentDeferPresetDrafts(): DeferPreset[] {
    return (this.deferPresetDrafts ?? this.plugin.settings.deferPresets).map((preset) => ({ ...preset }));
  }

  private async saveDeferPresetsIfValid(): Promise<void> {
    const drafts = this.currentDeferPresetDrafts();
    this.plugin.settings.deferPresets = normalizeDeferPresets(drafts);
    await this.plugin.saveSettings();
  }

  private nextAvailableRawMarker(): string {
    const used = new Set(this.currentTaskStateDrafts().map((state) => state.rawText));
    for (const marker of ['*', '+', '~', '.', ':', ';']) {
      if (!used.has(marker)) {
        return marker;
      }
    }
    for (let index = 1; index < 100; index += 1) {
      const marker = `custom${index}`;
      if (!used.has(marker)) {
        return marker;
      }
    }
    return `custom${Date.now()}`;
  }

  private async updateState(index: number, patch: Partial<TaskStateDefinition>): Promise<void> {
    this.pendingTaskStateFocusIndex = null;
    const states = this.currentTaskStateDrafts();
    states[index] = { ...states[index], ...patch };
    this.taskStateDrafts = states;
    const saved = await this.saveTaskStatesIfValid('rawText' in patch || 'type' in patch);
    if ('rawText' in patch || 'type' in patch || !saved) this.display();
  }

  private moveState(from: number, to: number): void {
    const states = this.currentTaskStateDrafts();
    const [state] = states.splice(from, 1);
    states.splice(to, 0, state);
    this.taskStateDrafts = states;
  }

  private async updateSavedQuery(index: number, patch: Partial<SavedTaskQuery>): Promise<void> {
    const queries = this.currentSavedQueryDrafts();
    queries[index] = { ...queries[index], ...patch };
    this.savedQueryDrafts = queries;
    await this.saveSavedQueriesIfValid();
  }

  private currentTaskStateDrafts(): TaskStateDefinition[] {
    return (this.taskStateDrafts ?? this.plugin.settings.supportedStates).map((state) => ({ ...state }));
  }

  private currentSavedQueryDrafts(): SavedTaskQuery[] {
    return (this.savedQueryDrafts ?? this.plugin.settings.savedQueries).map((query) => ({ ...query }));
  }

  private async saveSavedQueriesIfValid(): Promise<void> {
    const drafts = this.currentSavedQueryDrafts();
    if (!this.areSavedQueriesValid(drafts)) {
      return;
    }
    this.plugin.settings.savedQueries = normalizeSavedQueries(drafts);
    await this.plugin.saveSettings();
  }

  private formatStateRawInput(rawText: string): string {
    return `- [${rawText}]`;
  }

  private parseStateRawInput(value: string): string {
    const trimmed = value.trim();
    const taskMatch = trimmed.match(/^(?:[-*+]|\d+[.)])\s+\[([^\]]*)\]$/u);
    if (taskMatch) {
      return taskMatch[1];
    }

    const checkboxMatch = trimmed.match(/^\[([^\]]*)\]$/u);
    if (checkboxMatch) {
      return checkboxMatch[1];
    }

    return value;
  }

  private async saveTaskStatesIfValid(rebaselineSnapshot: boolean): Promise<boolean> {
    const drafts = this.currentTaskStateDrafts();
    if (!this.areTaskStatesValid(drafts)) {
      this.taskStateAnnouncement = t('settings.state.invalid');
      this.taskStateAnnouncementError = true;
      return false;
    }
    this.plugin.settings.supportedStates = normalizeTaskStates(drafts);
    await this.plugin.saveSettings();
    await this.plugin.refreshTaskConfiguration(rebaselineSnapshot);
    if (this.pendingTaskStateFocusIndex === null) this.taskStateAnnouncement = t('settings.state.saved');
    this.taskStateAnnouncementError = false;
    return true;
  }

  private areTaskStatesValid(states: readonly TaskStateDefinition[]): boolean {
    const seen = new Set<string>();
    let hasTodo = false;
    let hasDone = false;
    for (const state of states) {
      if (!state.rawText || state.rawText.includes(']') || /[\r\n]/u.test(state.rawText) || seen.has(state.rawText)) {
        return false;
      }
      if (state.nextStatusSymbol !== undefined && (state.nextStatusSymbol.includes(']') || /[\r\n]/u.test(state.nextStatusSymbol))) {
        return false;
      }
      if (!state.name.trim()) {
        return false;
      }
      seen.add(state.rawText);
      hasTodo ||= state.type === 'todo';
      hasDone ||= state.type === 'done';
    }
    return states.length > 0 && hasTodo && hasDone;
  }

  private areSavedQueriesValid(queries: readonly SavedTaskQuery[]): boolean {
    const seen = new Set<string>();
    for (const query of queries) {
      const name = query.name.trim().toLowerCase();
      if (!name || !query.query.trim() || seen.has(name)) {
        return false;
      }
      seen.add(name);
    }
    return true;
  }

  private formatStateType(type: TaskStateType): string {
    switch (type) {
      case 'todo':
        return 'TODO';
      case 'in_progress':
        return 'In Progress';
      case 'on_hold':
        return 'On Hold';
      case 'blocked':
        return 'Blocked';
      case 'deferred':
        return 'Deferred';
      case 'done':
        return 'Done';
      case 'cancelled':
        return 'Cancelled';
      case 'untracked':
        return 'Untracked';
    }
  }
}
