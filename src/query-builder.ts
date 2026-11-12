/**
 * Interactive Query Builder UI for Task Manager
 * Visual query builder with checkboxes, dropdowns, and live code preview.
 * Generates task query DSL without requiring manual syntax knowledge.
 */

import { Modal, App } from 'obsidian';
import { t } from './i18n';
import { applyLocaleScope } from './locale-scope';

export interface QueryBuilderState {
  filters: QueryFilter[];
  sorts: QuerySort[];
  groups: QueryGroup[];
  viewMode: string;
  layout: string[];
  limit?: number;
}

export interface QueryFilter {
  type: string;
  config: Record<string, unknown>;
}

export interface QuerySort {
  field: string;
  reverse: boolean;
}

export interface QueryGroup {
  field: string;
  limit?: number;
}

export const QUERY_BUILDER_FILTER_TYPES = [
  'done',
  'not-done',
  'status',
  'priority',
  'tag',
  'path',
  'due-before',
  'due-after',
  'due-on',
  'has-due',
  'no-due',
  'description',
  'recurring',
] as const;

function stringValueOrDefault(value: unknown, fallback: string): string {
  return typeof value === 'string' && value.trim() ? value.trim() : fallback;
}

function positiveIntegerLimit(value: number | undefined): number | undefined {
  return value !== undefined && Number.isInteger(value) && value > 0 ? value : undefined;
}

function isValidRemovalIndex(index: number, length: number): boolean {
  return Number.isInteger(index) && index >= 0 && index < length;
}

export class QueryBuilder {
  private state: QueryBuilderState = {
    filters: [],
    sorts: [],
    groups: [],
    viewMode: 'list',
    layout: [],
  };

  constructor(private readonly app: App) {}

  /**
   * Get the current query builder state.
   */
  getState(): QueryBuilderState {
    return {
      filters: this.state.filters.map((filter) => ({
        type: filter.type,
        config: { ...filter.config },
      })),
      sorts: this.state.sorts.map((sort) => ({ ...sort })),
      groups: this.state.groups.map((group) => ({ ...group })),
      viewMode: this.state.viewMode,
      layout: [...this.state.layout],
      limit: this.state.limit,
    };
  }

  /**
   * Generate query DSL from current state.
   */
  generateQuery(): string {
    const parts: string[] = [];

    // Add filters
    for (const filter of this.state.filters) {
      parts.push(this.formatFilter(filter));
    }

    // Add sorts
    for (const sort of this.state.sorts) {
      parts.push(`sort by ${sort.field}${sort.reverse ? ' reverse' : ''}`);
    }

    // Add groups
    for (const group of this.state.groups) {
      parts.push(`group by ${group.field}${group.limit ? ` limit ${group.limit}` : ''}`);
    }

    // Add layout
    for (const layoutItem of this.state.layout) {
      parts.push(layoutItem);
    }

    // Add view
    if (this.state.viewMode && this.state.viewMode !== 'list') {
      parts.push(`view: ${this.state.viewMode}`);
    }

    // Add limit
    if (this.state.limit && this.state.limit > 0) {
      parts.push(`limit ${this.state.limit}`);
    }

    return parts.join('\n');
  }

  /**
   * Format a filter for query DSL.
   */
  formatFilter(filter: QueryFilter): string {
    switch (filter.type) {
      case 'done':
        return 'done';
      case 'not-done':
        return 'not done';
      case 'status': {
        const value = typeof filter.config.value === 'string' && filter.config.value.trim() ? filter.config.value.trim() : 'todo';
        return `status.type is ${value}`;
      }
      case 'priority':
        return `priority is ${stringValueOrDefault(filter.config.value, 'high')}`;
      case 'tag':
        return `tag includes #${stringValueOrDefault(filter.config.value, 'todo').replace(/^#/u, '')}`;
      case 'path':
        return `path includes ${stringValueOrDefault(filter.config.value, 'Tasks')}`;
      case 'due-before':
        return `due before ${stringValueOrDefault(filter.config.value, 'today')}`;
      case 'due-after':
        return `due after ${stringValueOrDefault(filter.config.value, 'today')}`;
      case 'due-on':
        return `due on ${stringValueOrDefault(filter.config.value, 'today')}`;
      case 'has-due':
        return 'has due date';
      case 'no-due':
        return 'no due date';
      case 'description':
        return `description includes ${stringValueOrDefault(filter.config.value, 'task')}`;
      case 'recurring':
        return 'is recurring';
      default:
        return `${filter.type}: ${filter.config.value as string}`;
    }
  }

  /**
   * Add a filter to the query builder.
   */
  addFilter(type: string, config: Record<string, unknown>): void {
    this.state.filters.push({ type, config });
  }

  /**
   * Remove a filter by index.
   */
  removeFilter(index: number): void {
    if (!isValidRemovalIndex(index, this.state.filters.length)) return;
    this.state.filters.splice(index, 1);
  }

  /**
   * Add a sort to the query builder.
   */
  addSort(field: string, reverse = false): void {
    this.state.sorts.push({ field, reverse });
  }

  /**
   * Remove a sort by index.
   */
  removeSort(index: number): void {
    if (!isValidRemovalIndex(index, this.state.sorts.length)) return;
    this.state.sorts.splice(index, 1);
  }

  /**
   * Add a group to the query builder.
   */
  addGroup(field: string, limit?: number): void {
    this.state.groups.push({ field, limit: positiveIntegerLimit(limit) });
  }

  /**
   * Remove a group by index.
   */
  removeGroup(index: number): void {
    if (!isValidRemovalIndex(index, this.state.groups.length)) return;
    this.state.groups.splice(index, 1);
  }

  /**
   * Set the view mode.
   */
  setViewMode(mode: string): void {
    this.state.viewMode = mode;
  }

  /**
   * Add a layout directive.
   */
  addLayoutDirective(directive: string): void {
    if (!this.state.layout.includes(directive)) {
      this.state.layout.push(directive);
    }
  }

  /**
   * Remove a layout directive.
   */
  removeLayoutDirective(directive: string): void {
    this.state.layout = this.state.layout.filter((d) => d !== directive);
  }

  /**
   * Set the result limit.
   */
  setLimit(limit: number): void {
    this.state.limit = positiveIntegerLimit(limit);
  }

  /**
   * Clear all filters.
   */
  clearFilters(): void {
    this.state.filters = [];
  }

  /**
   * Clear all sorts.
   */
  clearSorts(): void {
    this.state.sorts = [];
  }

  /**
   * Reset to default state.
   */
  reset(): void {
    this.state = {
      filters: [],
      sorts: [],
      groups: [],
      viewMode: 'list',
      layout: [],
    };
  }
}

let queryBuilderModalSequence = 0;

export class QueryBuilderModal extends Modal {
  private readonly builder: QueryBuilder;
  private previewText = '';
  private previewCodeEl?: HTMLElement;
  private statusEl?: HTMLElement;
  private filterListEl?: HTMLElement;
  private sortListEl?: HTMLElement;
  private groupListEl?: HTMLElement;
  private filterAddControl?: HTMLElement;
  private sortAddControl?: HTMLElement;
  private groupAddControl?: HTMLElement;
  private onSubmit: (query: string) => void = () => {};
  private disposeLocaleScope?: () => void;
  private readonly controlPrefix = `task-manager-query-builder-${++queryBuilderModalSequence}`;

  constructor(app: App, onSubmit?: (query: string) => void) {
    super(app);
    this.builder = new QueryBuilder(app);
    if (onSubmit) this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('task-manager-query-builder');
    this.disposeLocaleScope?.();
    this.disposeLocaleScope = applyLocaleScope(contentEl);
    contentEl.createEl('h2', { text: t('queryBuilder.title') });
    this.renderFilterSection(contentEl);
    this.renderSortSection(contentEl);
    this.renderGroupSection(contentEl);
    this.renderViewModeSection(contentEl);
    this.renderLayoutSection(contentEl);
    this.renderLimitSection(contentEl);
    this.renderPreviewSection(contentEl);
    this.renderButtonSection(contentEl);
  }

  private renderFilterSection(parent: HTMLElement): void {
    const section = parent.createEl('section', { cls: 'query-builder-section' });
    const heading = section.createEl('h3', { text: t('queryBuilder.filters') });
    heading.id = `${this.controlPrefix}-filters-heading`;
    const addRow = section.createDiv({ cls: 'query-builder-add-row' });
    const selectId = `${this.controlPrefix}-add-filter`;
    const label = addRow.createEl('label', { text: t('queryBuilder.addFilter') });
    label.setAttr('for', selectId);
    const select = addRow.createEl('select');
    select.setAttr('id', selectId);
    for (const type of QUERY_BUILDER_FILTER_TYPES) select.createEl('option', { text: type, value: type });
    this.filterAddControl = select;
    select.addEventListener('change', () => {
      this.builder.addFilter(select.value, {});
      const filters = this.builder.getState().filters;
      const addedFilter = filters.at(-1);
      if (!addedFilter) return;
      const clause = this.builder.formatFilter(addedFilter);
      this.renderFilterList();
      this.updatePreview(t('queryBuilder.status.added', { kind: t('queryBuilder.filters').toLowerCase(), clause }));
      this.focusRemoveButton(this.filterListEl, filters.length - 1, this.filterAddControl);
    });
    this.filterListEl = section.createEl('ul', { cls: 'query-builder-filter-list' });
    this.filterListEl.setAttr('aria-labelledby', heading.id);
    this.renderFilterList();
  }

  private renderFilterList(): void {
    const list = this.filterListEl;
    if (!list) return;
    list.empty();
    const filters = this.builder.getState().filters;
    filters.forEach((filter, index) => {
      const clause = this.builder.formatFilter(filter);
      const item = list.createEl('li', { cls: 'query-builder-clause' });
      item.createEl('span', { text: clause });
      const remove = item.createEl('button', { text: '✕', cls: 'query-builder-remove' });
      remove.setAttr('type', 'button');
      remove.setAttr('aria-label', t('queryBuilder.removeFilter', { clause }));
      remove.addEventListener('click', () => {
        this.builder.removeFilter(index);
        this.renderFilterList();
        this.updatePreview(t('queryBuilder.status.removed', { kind: t('queryBuilder.filters').toLowerCase(), clause }));
        this.focusRemoveButton(this.filterListEl, Math.min(index, filters.length - 2), this.filterAddControl);
      });
    });
  }

  private renderSortSection(parent: HTMLElement): void {
    const section = parent.createEl('section', { cls: 'query-builder-section' });
    const heading = section.createEl('h3', { text: t('queryBuilder.sort') });
    heading.id = `${this.controlPrefix}-sorts-heading`;
    const addRow = section.createDiv({ cls: 'query-builder-add-row' });
    const selectId = `${this.controlPrefix}-add-sort`;
    const label = addRow.createEl('label', { text: t('queryBuilder.addSort') });
    label.setAttr('for', selectId);
    const select = addRow.createEl('select');
    select.setAttr('id', selectId);
    for (const field of ['urgency', 'due', 'priority', 'status', 'created', 'description']) select.createEl('option', { text: field, value: field });
    this.sortAddControl = select;
    select.addEventListener('change', () => {
      this.builder.addSort(select.value);
      const sorts = this.builder.getState().sorts;
      const addedSort = sorts.at(-1);
      if (!addedSort) return;
      const clause = this.formatSortDisplay(addedSort);
      this.renderSortList();
      this.updatePreview(t('queryBuilder.status.added', { kind: t('queryBuilder.sort').toLowerCase(), clause }));
      this.focusRemoveButton(this.sortListEl, sorts.length - 1, this.sortAddControl);
    });
    this.sortListEl = section.createEl('ul', { cls: 'query-builder-sort-list' });
    this.sortListEl.setAttr('aria-labelledby', heading.id);
    this.renderSortList();
  }

  private renderSortList(): void {
    const list = this.sortListEl;
    if (!list) return;
    list.empty();
    const sorts = this.builder.getState().sorts;
    sorts.forEach((sort, index) => {
      const clause = this.formatSortDisplay(sort);
      const item = list.createEl('li', { cls: 'query-builder-clause' });
      item.createEl('span', { text: clause });
      const remove = item.createEl('button', { text: '✕', cls: 'query-builder-remove' });
      remove.setAttr('type', 'button');
      remove.setAttr('aria-label', t('queryBuilder.removeSort', { clause }));
      remove.addEventListener('click', () => {
        this.builder.removeSort(index);
        this.renderSortList();
        this.updatePreview(t('queryBuilder.status.removed', { kind: t('queryBuilder.sort').toLowerCase(), clause }));
        this.focusRemoveButton(this.sortListEl, Math.min(index, sorts.length - 2), this.sortAddControl);
      });
    });
  }

  private renderGroupSection(parent: HTMLElement): void {
    const section = parent.createEl('section', { cls: 'query-builder-section' });
    const heading = section.createEl('h3', { text: t('queryBuilder.group') });
    heading.id = `${this.controlPrefix}-groups-heading`;
    const addRow = section.createDiv({ cls: 'query-builder-add-row' });
    const selectId = `${this.controlPrefix}-add-group`;
    const label = addRow.createEl('label', { text: t('queryBuilder.addGroup') });
    label.setAttr('for', selectId);
    const select = addRow.createEl('select');
    select.setAttr('id', selectId);
    for (const field of ['status', 'due', 'priority', 'tags', 'scheduled']) select.createEl('option', { text: field, value: field });
    this.groupAddControl = select;
    select.addEventListener('change', () => {
      this.builder.addGroup(select.value);
      const groups = this.builder.getState().groups;
      const addedGroup = groups.at(-1);
      if (!addedGroup) return;
      const clause = this.formatGroupDisplay(addedGroup);
      this.renderGroupList();
      this.updatePreview(t('queryBuilder.status.added', { kind: t('queryBuilder.group').toLowerCase(), clause }));
      this.focusRemoveButton(this.groupListEl, groups.length - 1, this.groupAddControl);
    });
    this.groupListEl = section.createEl('ul', { cls: 'query-builder-group-list' });
    this.groupListEl.setAttr('aria-labelledby', heading.id);
    this.renderGroupList();
  }

  private renderGroupList(): void {
    const list = this.groupListEl;
    if (!list) return;
    list.empty();
    const groups = this.builder.getState().groups;
    groups.forEach((group, index) => {
      const clause = this.formatGroupDisplay(group);
      const item = list.createEl('li', { cls: 'query-builder-clause' });
      item.createEl('span', { text: clause });
      const remove = item.createEl('button', { text: '✕', cls: 'query-builder-remove' });
      remove.setAttr('type', 'button');
      remove.setAttr('aria-label', t('queryBuilder.removeGroup', { clause }));
      remove.addEventListener('click', () => {
        this.builder.removeGroup(index);
        this.renderGroupList();
        this.updatePreview(t('queryBuilder.status.removed', { kind: t('queryBuilder.group').toLowerCase(), clause }));
        this.focusRemoveButton(this.groupListEl, Math.min(index, groups.length - 2), this.groupAddControl);
      });
    });
  }

  private renderViewModeSection(parent: HTMLElement): void {
    const section = parent.createEl('section', { cls: 'query-builder-section' });
    section.createEl('h3', { text: t('queryBuilder.viewMode') });
    const row = section.createDiv({ cls: 'query-builder-control-row' });
    const selectId = `${this.controlPrefix}-view`;
    const label = row.createEl('label', { text: t('queryBuilder.view') });
    label.setAttr('for', selectId);
    const select = row.createEl('select');
    select.setAttr('id', selectId);
    for (const mode of ['list', 'checklist', 'table', 'kanban', 'calendar', 'gantt', 'stats', 'graph', 'eisenhower']) select.createEl('option', { text: mode, value: mode });
    select.value = this.builder.getState().viewMode;
    select.addEventListener('change', () => {
      this.builder.setViewMode(select.value);
      this.updatePreview();
    });
  }

  private renderLayoutSection(parent: HTMLElement): void {
    const section = parent.createEl('section', { cls: 'query-builder-section' });
    section.createEl('h3', { text: t('queryBuilder.layout') });
    for (const option of ['show tree', 'hide due date', 'show urgency', 'show toolbar', 'hide edit button', 'hide task count']) {
      const label = section.createEl('label', { cls: 'query-builder-toggle' });
      const toggle = label.createEl('input', { type: 'checkbox' });
      label.createSpan({ text: option });
      toggle.addEventListener('change', () => {
        if (toggle.checked) this.builder.addLayoutDirective(option);
        else this.builder.removeLayoutDirective(option);
        this.updatePreview();
      });
    }
  }

  private renderLimitSection(parent: HTMLElement): void {
    const section = parent.createEl('section', { cls: 'query-builder-section' });
    section.createEl('h3', { text: t('queryBuilder.limit') });
    const row = section.createDiv({ cls: 'query-builder-control-row' });
    const inputId = `${this.controlPrefix}-limit`;
    const label = row.createEl('label', { text: t('queryBuilder.maxResults') });
    label.setAttr('for', inputId);
    const input = row.createEl('input', { type: 'text', placeholder: t('queryBuilder.limitPlaceholder') });
    input.setAttr('id', inputId);
    input.addEventListener('input', () => {
      const trimmed = input.value.trim();
      this.builder.setLimit(/^\d+$/u.test(trimmed) ? Number.parseInt(trimmed, 10) : 0);
      this.updatePreview();
    });
  }

  private renderPreviewSection(parent: HTMLElement): void {
    const section = parent.createEl('section', { cls: 'query-builder-section' });
    section.createEl('h3', { text: t('queryBuilder.preview') });
    const preview = section.createEl('pre', { cls: 'query-preview' });
    this.previewText = this.builder.generateQuery();
    this.previewCodeEl = preview.createEl('code', { text: this.previewText });
    this.statusEl = section.createDiv({ cls: 'query-builder-status task-manager-sr-only' });
    this.statusEl.setAttr('role', 'status');
    this.statusEl.setAttr('aria-live', 'polite');
    this.statusEl.setAttr('aria-atomic', 'true');
  }

  private renderButtonSection(parent: HTMLElement): void {
    const buttons = parent.createDiv({ cls: 'query-builder-buttons' });
    const insert = buttons.createEl('button', { text: t('queryBuilder.insert'), cls: 'mod-cta' });
    insert.setAttr('type', 'button');
    insert.addEventListener('click', () => {
      this.onSubmit(this.builder.generateQuery());
      this.close();
    });
    const cancel = buttons.createEl('button', { text: t('modal.btn.cancel') });
    cancel.setAttr('type', 'button');
    cancel.addEventListener('click', () => this.close());
  }

  private focusRemoveButton(list: HTMLElement | undefined, index: number, fallback: HTMLElement | undefined): void {
    const buttons = list ? Array.from(list.querySelectorAll<HTMLButtonElement>('.query-builder-remove')) : [];
    const target = index >= 0 ? buttons[index] : undefined;
    (target ?? fallback)?.focus();
  }

  private updatePreview(announcement = t('queryBuilder.status.updated')): void {
    this.previewText = this.builder.generateQuery();
    this.previewCodeEl?.setText(this.previewText);
    this.statusEl?.setText(announcement);
  }

  private formatSortDisplay(sort: QuerySort): string {
    return `${sort.field}${sort.reverse ? ' reverse' : ''}`;
  }

  private formatGroupDisplay(group: QueryGroup): string {
    return `${group.field}${group.limit ? ` limit ${group.limit}` : ''}`;
  }

  onClose(): void {
    this.previewCodeEl = undefined;
    this.statusEl = undefined;
    this.filterListEl = undefined;
    this.sortListEl = undefined;
    this.groupListEl = undefined;
    this.filterAddControl = undefined;
    this.sortAddControl = undefined;
    this.groupAddControl = undefined;
    this.disposeLocaleScope?.();
    this.disposeLocaleScope = undefined;
    this.contentEl.empty();
  }
}
