import { Notice } from 'obsidian';
import type { ParsedTask } from './task-scanner';
import type { TaskQuery } from './task-query';
import type { TableViewConfig, TableSavedFilter, TaskManagerSettings } from './types';
import { getPriorityColorClass, getStatusColorClass } from './color-utils';
import { parseEffortMinutesForFilter } from './duration-utils';
import { renderRecurrenceHeatmap } from './recurrence-heatmap';
import { encodeCsvCell } from './csv-utils';
import { createTableEditorPopover } from './table-editor-popover';
import { t } from './i18n';

let tablePopupSequence = 0;

export function normalizeTableDateInput(value: string): string | null {
  const trimmed = value.trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(trimmed);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const candidate = new Date(Date.UTC(year, month - 1, day));
  return candidate.getUTCFullYear() === year && candidate.getUTCMonth() === month - 1 && candidate.getUTCDate() === day ? trimmed : null;
}

interface TableColumn {
  key: string;
  label: string;
  sortable?: boolean;
  render: (task: ParsedTask) => string;
}

interface TableGridPosition {
  rowKey: string;
  rowIndex: number;
  columnKey: string;
  columnIndex: number;
}

export interface TableBulkActionFailure {
  taskKey?: string;
  message: string;
}

export interface TableBulkActionResult {
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: number;
  failures?: TableBulkActionFailure[];
}

interface TableBulkRunState {
  running: boolean;
  operation: string;
  requestedCount: number;
  kind?: 'pending' | 'success' | 'error';
  message?: string;
  result?: TableBulkActionResult;
}

interface TableState {
  search: string;
  statuses: Set<string>;
  priorities: Set<string>;
  tags: Set<string>;
  sortKey: string;
  sortDirection: 'asc' | 'desc';
  showHierarchy: boolean;
  visibleColumns: Set<string>;
  selected: Set<string>;
  collapsed: Set<string>;
  activeSavedFilterName?: string;
  lastSelectionKey?: string;
  gridPosition: TableGridPosition;
  gridInteraction: boolean;
  restoreGridFocus: boolean;
  bulkRun: TableBulkRunState;
}

export interface TableRenderActions {
  onSaveSettings?: () => Promise<void>;
  onAddTag?: (task: ParsedTask, tag: string) => Promise<void>;
  onRemoveTag?: (task: ParsedTask, tag: string) => Promise<void>;
  onBulkComplete?: (tasks: ParsedTask[]) => Promise<TableBulkActionResult | void>;
  onBulkCancel?: (tasks: ParsedTask[]) => Promise<TableBulkActionResult | void>;
  onBulkPostpone?: (tasks: ParsedTask[]) => Promise<TableBulkActionResult | void>;
  onBulkReschedule?: (tasks: ParsedTask[], date: string) => Promise<TableBulkActionResult | void>;
  onBulkPriority?: (tasks: ParsedTask[], priority: string) => Promise<TableBulkActionResult | void>;
  onBulkSetCustomField?: (tasks: ParsedTask[], key: string, value: string) => Promise<TableBulkActionResult | void>;
  onBulkAddTag?: (tasks: ParsedTask[], tag: string) => Promise<TableBulkActionResult | void>;
  onBulkRemoveTag?: (tasks: ParsedTask[], tag: string) => Promise<TableBulkActionResult | void>;
  onOpenSource?: (task: ParsedTask) => void;
  onSetCustomField?: (task: ParsedTask, key: string, value: string) => Promise<void>;
  getRecurrenceHistoryDates?: (task: ParsedTask) => string[];
  onConfirmRemoval?: (label: string, onConfirm: () => Promise<void>) => void;
  onRerender?: () => void;
}

interface RowModel {
  task: ParsedTask;
  depth: number;
  hasChildren: boolean;
  context: boolean;
}

const tableStates = new WeakMap<HTMLElement, TableState>();
const GRID_CELL_SELECTOR = '[role="columnheader"], [role="gridcell"]';
const GRID_CONTROL_SELECTOR = 'button, input, select, textarea, a[href], [tabindex]';

function gridCellFor(target: EventTarget | null): HTMLElement | null {
  return target instanceof Element ? target.closest<HTMLElement>(GRID_CELL_SELECTOR) : null;
}

function gridRows(table: HTMLElement): HTMLElement[][] {
  return Array.from(table.querySelectorAll<HTMLElement>('tr[role="row"]'))
    .map((row) => Array.from(row.children).filter((child): child is HTMLElement => child instanceof HTMLElement && child.matches(GRID_CELL_SELECTOR)))
    .filter((cells) => cells.length > 0);
}

function gridCellControls(cell: HTMLElement): HTMLElement[] {
  return Array.from(cell.querySelectorAll<HTMLElement>(GRID_CONTROL_SELECTOR)).filter((control) => {
    if (control === cell || control.hidden || control.closest('[hidden]')) return false;
    return !(control instanceof HTMLButtonElement || control instanceof HTMLInputElement || control instanceof HTMLSelectElement || control instanceof HTMLTextAreaElement)
      || !control.disabled;
  });
}

function updateGridPosition(state: TableState, cell: HTMLElement): void {
  state.gridPosition = {
    rowKey: cell.dataset.gridRowKey === 'header' ? 'header' : cell.dataset.gridRowKey ?? 'header',
    rowIndex: Number.parseInt(cell.dataset.gridRowIndex ?? '0', 10) || 0,
    columnKey: cell.dataset.gridColumnKey ?? '',
    columnIndex: Number.parseInt(cell.dataset.gridColumnIndex ?? '0', 10) || 0,
  };
}

function resolvedGridCell(table: HTMLElement, state: TableState): HTMLElement | null {
  const rows = gridRows(table);
  if (rows.length === 0) return null;
  const exactRow = rows.find((cells) => cells[0]?.dataset.gridRowKey === state.gridPosition.rowKey);
  const rowIndex = exactRow ? rows.indexOf(exactRow) : Math.min(Math.max(0, state.gridPosition.rowIndex), rows.length - 1);
  const row = rows[rowIndex] ?? rows[0];
  const exactColumn = row.find((cell) => cell.dataset.gridColumnKey === state.gridPosition.columnKey);
  const columnIndex = exactColumn ? row.indexOf(exactColumn) : Math.min(Math.max(0, state.gridPosition.columnIndex), row.length - 1);
  return row[columnIndex] ?? row[0] ?? null;
}

function setGridNavigationCell(table: HTMLElement, state: TableState, cell: HTMLElement, focus = false): void {
  for (const candidate of Array.from(table.querySelectorAll<HTMLElement>(GRID_CELL_SELECTOR))) candidate.tabIndex = -1;
  for (const control of Array.from(table.querySelectorAll<HTMLElement>(GRID_CONTROL_SELECTOR))) {
    if (!control.matches(GRID_CELL_SELECTOR)) control.tabIndex = -1;
  }
  state.gridInteraction = false;
  cell.tabIndex = 0;
  updateGridPosition(state, cell);
  if (focus) cell.focus();
}

function enterGridCell(table: HTMLElement, state: TableState, cell: HTMLElement, preferred?: HTMLElement, focus = true): void {
  const controls = gridCellControls(cell);
  if (controls.length === 0) return;
  for (const candidate of Array.from(table.querySelectorAll<HTMLElement>(GRID_CELL_SELECTOR))) candidate.tabIndex = -1;
  for (const control of Array.from(table.querySelectorAll<HTMLElement>(GRID_CONTROL_SELECTOR))) {
    if (!control.matches(GRID_CELL_SELECTOR)) control.tabIndex = controls.includes(control) ? 0 : -1;
  }
  state.gridInteraction = true;
  updateGridPosition(state, cell);
  if (focus) (preferred && controls.includes(preferred) ? preferred : controls[0])?.focus();
}

function leaveGridCell(table: HTMLElement, state: TableState, cell: HTMLElement, focus: boolean): void {
  setGridNavigationCell(table, state, cell, focus);
}

function moveGridCell(table: HTMLElement, state: TableState, cell: HTMLElement, key: string, boundary: boolean): HTMLElement {
  const rows = gridRows(table);
  const rowIndex = Math.max(0, rows.findIndex((row) => row.includes(cell)));
  const row = rows[rowIndex] ?? [];
  const columnIndex = Math.max(0, row.indexOf(cell));
  let nextRow = rowIndex;
  let nextColumn = columnIndex;
  if (boundary && key === 'Home') { nextRow = 0; nextColumn = 0; }
  else if (boundary && key === 'End') { nextRow = rows.length - 1; nextColumn = Math.max(0, (rows[nextRow]?.length ?? 1) - 1); }
  else if (key === 'Home') nextColumn = 0;
  else if (key === 'End') nextColumn = Math.max(0, row.length - 1);
  else if (key === 'ArrowLeft') nextColumn = Math.max(0, columnIndex - 1);
  else if (key === 'ArrowRight') nextColumn = Math.min(Math.max(0, row.length - 1), columnIndex + 1);
  else if (key === 'ArrowUp') nextRow = Math.max(0, rowIndex - 1);
  else if (key === 'ArrowDown') nextRow = Math.min(rows.length - 1, rowIndex + 1);
  const targetRow = rows[nextRow] ?? row;
  nextColumn = Math.min(Math.max(0, nextColumn), Math.max(0, targetRow.length - 1));
  return targetRow[nextColumn] ?? cell;
}

function setupTableGrid(table: HTMLElement, state: TableState): void {
  const active = resolvedGridCell(table, state);
  if (!active) return;
  setGridNavigationCell(table, state, active);

  table.addEventListener('keydown', (event: KeyboardEvent) => {
    const cell = gridCellFor(event.target);
    if (!cell || !table.contains(cell)) return;
    if (event.target !== cell) {
      if (!state.gridInteraction) return;
      if (event.key === 'Escape' || event.key === 'F2') {
        event.preventDefault();
        event.stopPropagation();
        leaveGridCell(table, state, cell, true);
        return;
      }
      if (event.key !== 'Tab') return;
      const controls = gridCellControls(cell);
      const index = controls.indexOf(event.target as HTMLElement);
      const next = event.shiftKey ? index - 1 : index + 1;
      if (next >= 0 && next < controls.length) {
        event.preventDefault();
        controls[next]?.focus();
      } else {
        leaveGridCell(table, state, cell, false);
      }
      return;
    }

    if ((event.key === 'Enter' && !event.isComposing) || event.key === 'F2') {
      const controls = gridCellControls(cell);
      if (controls.length > 0) {
        event.preventDefault();
        enterGridCell(table, state, cell);
      }
      return;
    }
    if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const target = moveGridCell(table, state, cell, event.key, (event.ctrlKey || event.metaKey) && (event.key === 'Home' || event.key === 'End'));
    setGridNavigationCell(table, state, target, true);
  });

  table.addEventListener('focusin', (event: FocusEvent) => {
    const cell = gridCellFor(event.target);
    if (!cell || !table.contains(cell)) return;
    updateGridPosition(state, cell);
    if (event.target === cell) {
      state.gridInteraction = false;
      return;
    }
    enterGridCell(table, state, cell, event.target as HTMLElement, false);
  });

  table.addEventListener('click', (event: MouseEvent) => {
    const cell = gridCellFor(event.target);
    if (!cell || !table.contains(cell)) return;
    if (event.target === cell) setGridNavigationCell(table, state, cell, true);
    else enterGridCell(table, state, cell, event.target as HTMLElement, false);
  });

  if (state.restoreGridFocus) {
    state.restoreGridFocus = false;
    setGridNavigationCell(table, state, active, true);
  }
}

/** Capture a Table grid focus coordinate before QueryRenderer replaces its DOM. */
export function captureTableGridFocus(el: HTMLElement): void {
  const state = tableStates.get(el);
  const table = el.querySelector<HTMLElement>('.task-manager-table[role="grid"]');
  if (!state || !table) return;
  const active = el.ownerDocument.activeElement;
  state.restoreGridFocus = active instanceof Element && table.contains(active);
  if (!state.restoreGridFocus) return;
  const cell = gridCellFor(active);
  if (cell) updateGridPosition(state, cell);
  state.gridInteraction = false;
}

function ensureTableConfig(settings: TaskManagerSettings): TableViewConfig {
  settings.tableViewConfig ??= { savedFilters: [], customColumns: [], showHierarchy: true, visibleColumns: [] };
  return settings.tableViewConfig;
}

export function renderTable(
  el: HTMLElement,
  tasks: ParsedTask[],
  query: TaskQuery,
  settings: TaskManagerSettings,
  onToggle: (task: ParsedTask) => Promise<void>,
  onEdit: (task: ParsedTask) => void,
  actions: TableRenderActions = {},
): void {
  el.addClass('task-manager-table-view');
  const state = getTableState(el, settings);
  if (settings.tableViewConfig?.visibleColumns?.length) {
    state.visibleColumns = new Set(settings.tableViewConfig.visibleColumns);
  }

  const allColumns = buildColumns(tasks, query, settings);
  const columns = allColumns.filter((column) => column.key === 'select' || column.key === 'task' || state.visibleColumns.has(column.key));
  const availableTags = Array.from(new Set(tasks.flatMap((task) => task.tags.map(normalizeTag)))).filter(Boolean).sort();
  const availableStatuses = Array.from(new Set(tasks.map((task) => task.status))).sort();
  const availablePriorities = Array.from(new Set(tasks.map((task) => task.metadata.priority ?? 'normal'))).sort();
  const rollups = buildRollups(tasks);
  const matched = tasks.filter((task) => matchesStateFilters(task, state));
  const rows = buildRows(tasks, matched, state, compareForState(state, rollups));
  const visibleTaskKeys = rows.map((row) => row.task.key);

  renderToolbar(el, tasks, rows.map((row) => row.task), allColumns, availableStatuses, availablePriorities, availableTags, state, settings, actions);
  renderActiveFilterChips(el, state, actions);
  renderSavedFilters(el, state, settings, actions);
  renderBulkBar(el, state, tasks, actions);
  renderTableElement(el, rows, columns, rollups, state, settings, onToggle, onEdit, actions, visibleTaskKeys);
}

function getTableState(el: HTMLElement, settings: TaskManagerSettings): TableState {
  const existing = tableStates.get(el);
  if (existing) return existing;
  const config = settings.tableViewConfig ?? { savedFilters: [], customColumns: [], showHierarchy: true, visibleColumns: [] };
  const state: TableState = {
    search: '',
    statuses: new Set(),
    priorities: new Set(),
    tags: new Set(),
    sortKey: 'due',
    sortDirection: 'asc',
    showHierarchy: config.showHierarchy,
    visibleColumns: new Set(config.visibleColumns.length > 0
      ? config.visibleColumns
      : ['status', 'task', 'tags', 'pinned', 'priority', 'due', 'scheduled', 'start', 'progress', 'effort', 'actual', 'file']),
    selected: new Set(),
    collapsed: new Set(),
    activeSavedFilterName: undefined,
    gridPosition: { rowKey: 'header', rowIndex: 0, columnKey: 'select', columnIndex: 0 },
    gridInteraction: false,
    restoreGridFocus: false,
    bulkRun: { running: false, operation: '', requestedCount: 0 },
  };
  tableStates.set(el, state);
  return state;
}

function buildColumns(tasks: ParsedTask[], query: TaskQuery, settings: TaskManagerSettings): TableColumn[] {
  const rollups = buildRollups(tasks);
  const base: TableColumn[] = [
    { key: 'select', label: '', render: () => '', sortable: false },
    { key: 'status', label: 'Status', render: (task: ParsedTask) => statusLabel(task, settings), sortable: true },
    { key: 'task', label: 'Task', render: (task: ParsedTask) => task.normalizedText, sortable: true },
    { key: 'tags', label: 'Tags', render: (task: ParsedTask) => task.tags.join(' '), sortable: true },
    { key: 'pinned', label: 'Pin', render: (task: ParsedTask) => task.metadata.pinned ? 'pinned' : '', sortable: true },
    { key: 'priority', label: 'Priority', render: (task: ParsedTask) => task.metadata.priority ?? 'normal', sortable: true },
    { key: 'due', label: 'Due', render: (task: ParsedTask) => task.metadata.dates.due ?? '', sortable: true },
    { key: 'scheduled', label: 'Scheduled', render: (task: ParsedTask) => task.metadata.dates.scheduled ?? '', sortable: true },
    { key: 'start', label: 'Start', render: (task: ParsedTask) => task.metadata.dates.start ?? '', sortable: true },
    { key: 'progress', label: 'Progress', render: (task: ParsedTask) => rollups.get(task.key)?.progressText ?? '', sortable: true },
    { key: 'effort', label: 'Effort', render: (task: ParsedTask) => rollups.get(task.key)?.effortText ?? task.metadata.effort ?? '', sortable: true },
    { key: 'actual', label: 'Actual', render: (task: ParsedTask) => rollups.get(task.key)?.actualText ?? task.metadata.actual ?? '', sortable: true },
    { key: 'cost', label: 'Cost', render: (task: ParsedTask) => formatCurrency(rollups.get(task.key)?.cost ?? task.metadata.cost), sortable: true },
    { key: 'depends-on', label: 'Depends on', render: (task: ParsedTask) => task.metadata.dependsOn.join(', '), sortable: true },
    { key: 'file', label: 'File', render: (task: ParsedTask) => task.filePath, sortable: true },
  ].filter((column) => column.key === 'select' || column.key === 'task' || !isHidden(query, column.key));

  const custom = (settings.tableViewConfig?.customColumns ?? []).map<TableColumn>((column) => ({
    key: `custom:${column.key}`,
    label: column.label,
    sortable: true,
    render: (task) => customFieldText(task, column.key),
  }));
  return [...base, ...custom];
}

function renderToolbar(
  el: HTMLElement,
  allTasks: ParsedTask[],
  visibleTasks: ParsedTask[],
  columns: TableColumn[],
  statuses: string[],
  priorities: string[],
  tags: string[],
  state: TableState,
  settings: TaskManagerSettings,
  actions: TableRenderActions,
): void {
  const toolbar = el.createDiv({ cls: 'task-manager-table-toolbar' });
  toolbar.createEl('span', { text: `${visibleTasks.length}/${allTasks.length}`, cls: 'task-manager-table-count' });
  const allVisibleSelected = visibleTasks.length > 0 && visibleTasks.every((task) => state.selected.has(task.key));
  const toggleVisibleBtn = toolbar.createEl('button', { text: allVisibleSelected ? 'Clear visible' : 'Select visible', cls: 'task-manager-table-toolbar-btn task-manager-table-toolbar-btn--selection' });
  toggleVisibleBtn.setAttr('type', 'button');
  toggleVisibleBtn.setAttr('title', 'Select or clear all visible rows');
  toggleVisibleBtn.addEventListener('click', () => {
    if (visibleTasks.length === 0) return;
    const allVisibleSelected = visibleTasks.every((task) => state.selected.has(task.key));
    if (allVisibleSelected) {
      for (const task of visibleTasks) state.selected.delete(task.key);
    } else {
      for (const task of visibleTasks) state.selected.add(task.key);
    }
    actions.onRerender?.();
  });

  const search = toolbar.createEl('input', { type: 'search', cls: 'task-manager-table-search', placeholder: 'Search table...' });
  search.setAttr('aria-label', 'Search table tasks');
  search.value = state.search;
  search.addEventListener('input', () => {
    state.search = search.value;
    state.activeSavedFilterName = undefined;
    actions.onRerender?.();
  });

  renderSelectFilter(toolbar, state, 'Status', statuses, state.statuses, actions);
  renderSelectFilter(toolbar, state, 'Priority', priorities, state.priorities, actions);
  renderSelectFilter(toolbar, state, 'Tag', tags, state.tags, actions, (tag) => `#${tag}`);

  const hierarchyBtn = toolbar.createEl('button', { text: state.showHierarchy ? 'Hierarchy: on' : 'Hierarchy: off', cls: `task-manager-table-toolbar-btn${state.showHierarchy ? ' is-active' : ''}` });
  hierarchyBtn.setAttr('type', 'button');
  hierarchyBtn.setAttr('title', state.showHierarchy ? 'Hierarchy: on' : 'Hierarchy: off');
  hierarchyBtn.addEventListener('click', () => {
    state.showHierarchy = !state.showHierarchy;
    state.activeSavedFilterName = undefined;
    ensureTableConfig(settings).showHierarchy = state.showHierarchy;
    void actions.onSaveSettings?.();
    actions.onRerender?.();
  });

  renderColumnsMenu(toolbar, columns, state, settings, actions);

  const saveBtn = toolbar.createEl('button', { text: '🔖 Save filter', cls: 'task-manager-table-toolbar-btn' });
  saveBtn.setAttr('type', 'button');
  saveBtn.setAttr('title', 'Save the current table filters');
  saveBtn.addEventListener('click', () => saveCurrentFilter(state, settings, actions));

  const exportBtn = toolbar.createEl('button', { text: 'Export', cls: 'task-manager-table-toolbar-btn' });
  exportBtn.setAttr('type', 'button');
  exportBtn.setAttr('aria-haspopup', 'menu');
  exportBtn.setAttr('aria-expanded', 'false');
  exportBtn.addEventListener('click', () => renderExportMenu(exportBtn, visibleTasks, columns));
}

function renderSelectFilter(
  toolbar: HTMLElement,
  state: TableState,
  label: string,
  values: string[],
  selected: Set<string>,
  actions: TableRenderActions,
  display: (value: string) => string = (value) => value,
): void {
  const select = toolbar.createEl('select', { cls: 'task-manager-table-filter-select' });
  select.setAttr('aria-label', `${label} filter`);
  select.createEl('option', { text: label, value: '' });
  for (const value of values) {
    select.createEl('option', { text: display(value), value });
  }
  select.addEventListener('change', () => {
    const value = select.value;
    if (!value) {
      selected.clear();
    } else if (selected.has(value)) {
      selected.delete(value);
    } else {
      selected.add(value);
    }
    select.value = '';
    state.activeSavedFilterName = undefined;
    actions.onRerender?.();
  });
}

function renderColumnsMenu(toolbar: HTMLElement, columns: TableColumn[], state: TableState, settings: TaskManagerSettings, actions: TableRenderActions): void {
  const wrap = toolbar.createDiv({ cls: 'task-manager-table-columns-wrap' });
  const button = wrap.createEl('button', { text: 'Columns', cls: 'task-manager-table-toolbar-btn' });
  button.setAttr('type', 'button');
  const panel = wrap.createDiv({ cls: 'task-manager-table-columns-menu' });
  panel.id = `task-manager-table-columns-${tablePopupSequence++}`;
  panel.setAttr('role', 'dialog');
  panel.setAttr('aria-label', 'Visible table columns');
  panel.style.display = 'none';
  button.setAttr('aria-haspopup', 'dialog');
  button.setAttr('aria-controls', panel.id);
  button.setAttr('aria-expanded', 'false');
  let outsideController: AbortController | null = null;
  const close = (restoreFocus: boolean): void => {
    panel.style.display = 'none';
    button.setAttr('aria-expanded', 'false');
    outsideController?.abort();
    outsideController = null;
    if (restoreFocus) button.focus();
  };
  const open = (): void => {
    panel.style.display = '';
    button.setAttr('aria-expanded', 'true');
    outsideController?.abort();
    const AbortControllerCtor = panel.ownerDocument.defaultView?.AbortController ?? AbortController;
    outsideController = new AbortControllerCtor();
    document.addEventListener('click', (event) => {
      if (!panel.isConnected) { outsideController?.abort(); return; }
      if (!panel.contains(event.target as Node) && event.target !== button) close(false);
    }, { capture: true, signal: outsideController.signal });
    window.setTimeout(() => panel.querySelector<HTMLInputElement>('input')?.focus(), 0);
  };
  button.addEventListener('click', () => panel.style.display === 'none' ? open() : close(false));
  panel.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    close(true);
  });
  for (const column of columns.filter((c) => c.key !== 'select' && c.key !== 'task')) {
    const label = panel.createEl('label', { cls: 'task-manager-table-column-toggle' });
    const checkbox = label.createEl('input', { type: 'checkbox' });
    checkbox.checked = state.visibleColumns.has(column.key);
    label.createEl('span', { text: column.label });
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) state.visibleColumns.add(column.key);
      else state.visibleColumns.delete(column.key);
      state.activeSavedFilterName = undefined;
      ensureTableConfig(settings).visibleColumns = Array.from(state.visibleColumns);
      void actions.onSaveSettings?.();
      close(false);
      actions.onRerender?.();
    });
  }
}

function renderActiveFilterChips(el: HTMLElement, state: TableState, actions: TableRenderActions): void {
  const hasActive = Boolean(state.search.trim() || state.statuses.size || state.priorities.size || state.tags.size);
  if (!hasActive) return;
  const bar = el.createDiv({ cls: 'task-manager-table-active-filters' });
  bar.createEl('span', { text: 'Active filters', cls: 'task-manager-table-active-filters__label' });
  const addChip = (label: string, onClear: () => void): void => {
    const chip = bar.createEl('button', { text: label, cls: 'task-manager-table-active-filter' });
    chip.setAttr('type', 'button');
    chip.addEventListener('click', () => {
      onClear();
      actions.onRerender?.();
    });
  };
  if (state.search.trim()) addChip(`Search: ${state.search.trim()}`, () => { state.search = ''; });
  for (const status of state.statuses) addChip(`Status: ${status}`, () => { state.statuses.delete(status); });
  for (const priority of state.priorities) addChip(`Priority: ${priority}`, () => { state.priorities.delete(priority); });
  for (const tag of state.tags) addChip(`#${tag}`, () => { state.tags.delete(tag); });
  const clear = bar.createEl('button', { text: 'Clear all', cls: 'task-manager-table-active-filter task-manager-table-active-filter--clear' });
  clear.setAttr('type', 'button');
  clear.addEventListener('click', () => {
    state.search = '';
    state.statuses.clear();
    state.priorities.clear();
    state.tags.clear();
    state.activeSavedFilterName = undefined;
    actions.onRerender?.();
  });
}

function renderSavedFilters(el: HTMLElement, state: TableState, settings: TaskManagerSettings, actions: TableRenderActions): void {
  const filters = settings.tableViewConfig?.savedFilters ?? [];
  const bar = el.createDiv({ cls: 'task-manager-table-saved-filters' });
  if (filters.length === 0) {
    bar.createEl('span', { text: 'No saved table filters', cls: 'task-manager-table-saved-empty' });
    return;
  }
  bar.createEl('span', { text: 'Saved:', cls: 'task-manager-table-saved-label' });
  for (const filter of filters) {
    const wrap = bar.createDiv({ cls: 'task-manager-table-saved-filter-wrap' });
    const pill = wrap.createEl('button', { text: filter.name, cls: `task-manager-table-saved-filter${state.activeSavedFilterName === filter.name ? ' is-active' : ''}` });
    pill.setAttr('type', 'button');
    pill.setAttr('title', `Load saved filter ${filter.name}`);
    pill.addEventListener('click', () => {
      applySavedFilter(state, filter);
      actions.onRerender?.();
    });
    const remove = wrap.createEl('button', { text: '✕', cls: 'task-manager-table-saved-delete' });
    remove.setAttr('type', 'button');
    remove.setAttr('aria-label', `Delete saved filter ${filter.name}`);
    remove.setAttr('title', `Delete saved filter ${filter.name}`);
    remove.addEventListener('click', () => {
      const removeFilter = async (): Promise<void> => {
        const config = ensureTableConfig(settings);
        config.savedFilters = config.savedFilters.filter((candidate) => candidate.name !== filter.name);
        await actions.onSaveSettings?.();
        actions.onRerender?.();
      };
      if (actions.onConfirmRemoval) actions.onConfirmRemoval(`saved filter “${filter.name}”`, removeFilter);
      else if (globalThis.confirm?.(`Delete saved filter “${filter.name}”?`) === true) void removeFilter();
    });
  }
}

function normalizedBulkResult(result: TableBulkActionResult | void, requestedCount: number): TableBulkActionResult {
  if (result) return result;
  return { attempted: requestedCount, succeeded: requestedCount, failed: 0, skipped: 0 };
}

function bulkResultMessage(operation: string, result: TableBulkActionResult): { kind: 'success' | 'error'; message: string } {
  if (result.failed > 0 || result.skipped > 0) {
    return {
      kind: 'error',
      message: t('table.bulkPartial', {
        operation,
        attempted: result.attempted,
        succeeded: result.succeeded,
        failed: result.failed,
        skipped: result.skipped,
      }),
    };
  }
  return { kind: 'success', message: t('table.bulkSuccess', { operation, count: result.succeeded }) };
}

function renderBulkFeedback(el: HTMLElement, state: TableState): void {
  el.querySelector('.task-manager-table-bulk-feedback')?.remove();
  if (!state.bulkRun.message) return;
  const feedback = el.createDiv({ cls: `task-manager-table-bulk-feedback is-${state.bulkRun.kind ?? 'pending'}` });
  feedback.setAttr('role', state.bulkRun.kind === 'error' ? 'alert' : 'status');
  feedback.setAttr('aria-live', state.bulkRun.kind === 'error' ? 'assertive' : 'polite');
  feedback.setAttr('aria-atomic', 'true');
  feedback.setText(state.bulkRun.message);
}

function updateBulkSurface(el: HTMLElement, state: TableState): void {
  const bar = el.querySelector<HTMLElement>('.task-manager-table-bulk-bar');
  if (bar) {
    bar.setAttr('aria-busy', String(state.bulkRun.running));
    for (const control of Array.from(bar.querySelectorAll<HTMLButtonElement>('button'))) control.disabled = state.bulkRun.running;
  }
  renderBulkFeedback(el, state);
}

async function runTableBulkAction(
  el: HTMLElement,
  state: TableState,
  actions: TableRenderActions,
  operation: string,
  requestedCount: number,
  run: () => Promise<TableBulkActionResult | void>,
): Promise<TableBulkActionResult> {
  if (state.bulkRun.running) return state.bulkRun.result ?? { attempted: requestedCount, succeeded: 0, failed: 0, skipped: requestedCount };
  state.bulkRun = {
    running: true,
    operation,
    requestedCount,
    kind: 'pending',
    message: t('table.bulkPending', { operation, count: requestedCount }),
  };
  updateBulkSurface(el, state);
  let result: TableBulkActionResult;
  try {
    result = normalizedBulkResult(await run(), requestedCount);
    const outcome = bulkResultMessage(operation, result);
    state.bulkRun = { running: false, operation, requestedCount, result, ...outcome };
  } catch (error) {
    result = {
      attempted: requestedCount,
      succeeded: 0,
      failed: requestedCount,
      skipped: 0,
      failures: [{ message: error instanceof Error ? error.message : String(error) }],
    };
    state.bulkRun = {
      running: false,
      operation,
      requestedCount,
      result,
      kind: 'error',
      message: t('table.bulkFailed', { operation, count: requestedCount, error: error instanceof Error ? error.message : String(error) }),
    };
  } finally {
    actions.onRerender?.();
  }
  return result;
}

function renderBulkRescheduleEditor(anchor: HTMLElement, run: (date: string) => void): void {
  const popover = createTableEditorPopover(anchor, { title: 'Reschedule selected tasks', description: 'Enter a due date in YYYY-MM-DD format.' });
  const input = popover.content.createEl('input', { type: 'date' });
  input.setAttr('aria-label', t('modal.quickCapture.dueDate'));
  const apply = popover.content.createEl('button', { text: t('table.apply'), type: 'button', cls: 'mod-cta' });
  apply.addEventListener('click', () => {
    const normalized = normalizeTableDateInput(input.value);
    if (!normalized) { popover.showError(new Error('Enter a valid date in YYYY-MM-DD format.')); return; }
    popover.close();
    run(normalized);
  });
  input.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); apply.click(); }
  });
  popover.focusInitial(input);
}

function renderBulkPriorityEditor(anchor: HTMLElement, run: (priority: string) => void): void {
  const popover = createTableEditorPopover(anchor, { title: 'Set selected task priority' });
  const select = popover.content.createEl('select');
  select.setAttr('aria-label', t('modal.field.priority'));
  for (const priority of ['highest', 'high', 'medium', 'normal', 'low', 'lowest']) select.createEl('option', { text: priority, value: priority });
  select.value = 'normal';
  const apply = popover.content.createEl('button', { text: t('table.apply'), type: 'button', cls: 'mod-cta' });
  apply.addEventListener('click', () => { popover.close(); run(select.value); });
  select.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); apply.click(); }
  });
  popover.focusInitial(select);
}

function renderBulkBar(el: HTMLElement, state: TableState, tasks: ParsedTask[], actions: TableRenderActions): void {
  const selectedTasks = tasks.filter((task) => state.selected.has(task.key));
  if (selectedTasks.length === 0) { renderBulkFeedback(el, state); return; }
  const bar = el.createDiv({ cls: 'task-manager-table-bulk-bar' });
  bar.setAttr('aria-busy', String(state.bulkRun.running));
  bar.createEl('span', { text: `${selectedTasks.length} selected`, cls: 'task-manager-bulk-count' });
  const addButton = (label: string, action: () => void): HTMLButtonElement => {
    const button = bar.createEl('button', { text: label, cls: 'task-manager-bulk-btn' });
    button.setAttr('type', 'button');
    button.disabled = state.bulkRun.running;
    button.addEventListener('click', action);
    return button;
  };
  const run = (operation: string, action: () => Promise<TableBulkActionResult | void>): void => {
    void runTableBulkAction(el, state, actions, operation, selectedTasks.length, action);
  };
  addButton('Complete', () => run('Complete', async () => actions.onBulkComplete?.(selectedTasks)));
  addButton('Cancel', () => run('Cancel', async () => actions.onBulkCancel?.(selectedTasks)));
  addButton('+1 day', () => run('Postpone', async () => actions.onBulkPostpone?.(selectedTasks)));
  const rescheduleBtn = addButton('Reschedule', () => renderBulkRescheduleEditor(rescheduleBtn, (date) => {
    run('Reschedule', async () => actions.onBulkReschedule?.(selectedTasks, date));
  }));
  const priorityBtn = addButton('Priority', () => renderBulkPriorityEditor(priorityBtn, (priority) => {
    run('Priority', async () => actions.onBulkPriority?.(selectedTasks, priority));
  }));
  const resolveBulkButton = (key: string): HTMLElement | null => el.querySelector<HTMLElement>(`[data-table-bulk-action="${key}"]`);
  const customFieldBtn = addButton('Custom field', () => renderBulkCustomFieldEditor(customFieldBtn, selectedTasks, actions, (key, value) => runTableBulkAction(
    el, state, actions, 'Custom field', selectedTasks.length, async () => actions.onBulkSetCustomField?.(selectedTasks, key, value),
  ), () => resolveBulkButton('custom-field')));
  customFieldBtn.dataset.tableBulkAction = 'custom-field';
  const addTagBtn = addButton('Add tag', () => renderBulkTagEditor(addTagBtn, selectedTasks, tasks, actions, 'add', (tag) => runTableBulkAction(
    el, state, actions, 'Add tag', selectedTasks.length, async () => actions.onBulkAddTag?.(selectedTasks, tag),
  ), () => resolveBulkButton('add-tag')));
  addTagBtn.dataset.tableBulkAction = 'add-tag';
  const removeTagBtn = addButton('Remove tag', () => renderBulkTagEditor(removeTagBtn, selectedTasks, tasks, actions, 'remove', (tag) => runTableBulkAction(
    el, state, actions, 'Remove tag', selectedTasks.length, async () => actions.onBulkRemoveTag?.(selectedTasks, tag),
  ), () => resolveBulkButton('remove-tag')));
  removeTagBtn.dataset.tableBulkAction = 'remove-tag';
  addButton('Clear', () => { state.selected.clear(); actions.onRerender?.(); });
  renderBulkFeedback(el, state);
}

function renderTableElement(
  el: HTMLElement,
  rows: RowModel[],
  columns: TableColumn[],
  rollups: Map<string, Rollup>,
  state: TableState,
  settings: TaskManagerSettings,
  onToggle: (task: ParsedTask) => Promise<void>,
  onEdit: (task: ParsedTask) => void,
  actions: TableRenderActions,
  visibleTaskKeys: string[],
): void {
  const gridId = `task-manager-table-grid-${tablePopupSequence++}`;
  const table = el.createEl('table', { cls: 'task-manager-table task-manager-table-rich' });
  table.id = gridId;
  table.setAttr('role', 'grid');
  table.setAttr('aria-label', `Task table (${rows.length} rows)`);
  table.setAttr('aria-multiselectable', 'true');
  table.setAttr('aria-rowcount', String(rows.length + (rows.length === 0 ? 2 : 1)));
  table.setAttr('aria-colcount', String(columns.length));
  const thead = table.createEl('thead');
  const headRow = thead.createEl('tr');
  headRow.setAttr('role', 'row');
  headRow.setAttr('aria-rowindex', '1');
  for (const [columnIndex, column] of columns.entries()) {
    const th = headRow.createEl('th', { cls: `task-manager-table-col-${cssKey(column.key)}` });
    const label = column.label || 'Select tasks';
    th.id = `${gridId}-column-${cssKey(column.key)}`;
    th.setAttr('scope', 'col');
    th.setAttr('role', 'columnheader');
    th.setAttr('aria-colindex', String(columnIndex + 1));
    th.setAttr('aria-label', label);
    th.dataset.gridRowKey = 'header';
    th.dataset.gridRowIndex = '0';
    th.dataset.gridColumnKey = column.key;
    th.dataset.gridColumnIndex = String(columnIndex);
    const sort = (): void => {
      if (state.sortKey === column.key) state.sortDirection = state.sortDirection === 'asc' ? 'desc' : 'asc';
      else { state.sortKey = column.key; state.sortDirection = 'asc'; }
      state.activeSavedFilterName = undefined;
      actions.onRerender?.();
    };
    if (column.sortable !== false) {
      th.addClass('task-manager-table-sortable');
      th.setAttr('aria-sort', state.sortKey === column.key ? (state.sortDirection === 'asc' ? 'ascending' : 'descending') : 'none');
      const button = th.createEl('button', { text: headerLabel(column, state), cls: 'task-manager-table-sort-button' });
      button.setAttr('type', 'button');
      button.setAttr('aria-label', `Sort by ${column.label}${state.sortKey === column.key ? `, currently ${state.sortDirection === 'asc' ? 'ascending' : 'descending'}` : ''}`);
      button.addEventListener('click', sort);
    } else if (column.label) {
      th.setText(headerLabel(column, state));
    }
  }
  const tbody = table.createEl('tbody');
  for (const [taskIndex, rowModel] of rows.entries()) {
    const { task, depth, hasChildren, context } = rowModel;
    const row = tbody.createEl('tr', { cls: `task-manager-table-row task-manager-table-row-${task.status}` });
    row.setAttr('role', 'row');
    row.setAttr('aria-rowindex', String(taskIndex + 2));
    row.setAttr('aria-selected', String(state.selected.has(task.key)));
    row.setAttr('data-task-key', task.key);
    if (context) row.addClass('task-manager-table-row-context');
    if (task.isProjected) row.addClass('is-projected');
    if (task.metadata.pinned) row.addClass('is-pinned');
    if (state.selected.has(task.key)) row.addClass('is-selected');
    for (const [columnIndex, column] of columns.entries()) {
      const cell = row.createEl('td', { cls: `task-manager-table-cell task-manager-table-col-${cssKey(column.key)}` });
      cell.setAttr('role', 'gridcell');
      cell.setAttr('aria-colindex', String(columnIndex + 1));
      cell.dataset.gridRowKey = task.key;
      cell.dataset.gridRowIndex = String(taskIndex + 1);
      cell.dataset.gridColumnKey = column.key;
      cell.dataset.gridColumnIndex = String(columnIndex);
      renderCell(cell, column, task, rows.map((rowEntry) => rowEntry.task), visibleTaskKeys, depth, hasChildren, rollups, state, settings, onToggle, onEdit, actions);
    }
  }
  if (rows.length === 0) {
    const row = tbody.createEl('tr');
    row.setAttr('role', 'row');
    row.setAttr('aria-rowindex', '2');
    const emptyText = t('table.noMatchingTasks');
    const cell = row.createEl('td', { text: emptyText, cls: 'task-manager-table-empty' });
    cell.setAttr('role', 'gridcell');
    cell.setAttr('aria-colindex', '1');
    cell.setAttr('aria-label', emptyText);
    cell.setAttr('colspan', String(Math.max(1, columns.length)));
    cell.dataset.gridRowKey = 'empty';
    cell.dataset.gridRowIndex = '1';
    cell.dataset.gridColumnKey = columns[0]?.key ?? 'select';
    cell.dataset.gridColumnIndex = '0';
  }
  setupTableGrid(table, state);
}

function renderCell(
  cell: HTMLElement,
  column: TableColumn,
  task: ParsedTask,
  allTasks: ParsedTask[],
  visibleTaskKeys: string[],
  depth: number,
  hasChildren: boolean,
  rollups: Map<string, Rollup>,
  state: TableState,
  settings: TaskManagerSettings,
  onToggle: (task: ParsedTask) => Promise<void>,
  onEdit: (task: ParsedTask) => void,
  actions: TableRenderActions,
): void {
  if (column.key === 'select') {
    const checkbox = cell.createEl('input', { type: 'checkbox' });
    checkbox.checked = state.selected.has(task.key);
    checkbox.setAttr('aria-label', `Select ${task.normalizedText}`);
    const toggleSelection = (shiftKey = false): void => {
      const nextChecked = !state.selected.has(task.key);
      if (shiftKey && state.lastSelectionKey && visibleTaskKeys.includes(state.lastSelectionKey)) {
        const start = visibleTaskKeys.indexOf(state.lastSelectionKey);
        const end = visibleTaskKeys.indexOf(task.key);
        if (start !== -1 && end !== -1) {
          const [rangeStart, rangeEnd] = start <= end ? [start, end] : [end, start];
          for (const key of visibleTaskKeys.slice(rangeStart, rangeEnd + 1)) {
            if (nextChecked) state.selected.add(key);
            else state.selected.delete(key);
          }
          state.lastSelectionKey = task.key;
          actions.onRerender?.();
          return;
        }
      }
      if (nextChecked) state.selected.add(task.key);
      else state.selected.delete(task.key);
      state.lastSelectionKey = task.key;
      actions.onRerender?.();
    };
    checkbox.addEventListener('click', (event: MouseEvent) => {
      event.preventDefault();
      toggleSelection(event.shiftKey);
    });
    checkbox.addEventListener('change', () => {
      checkbox.checked = state.selected.has(task.key);
    });
    return;
  }

  if (column.key === 'status') {
    const canvasReadOnly = task.filePath.endsWith('.canvas');
    const btn = cell.createEl('button', { text: column.render(task), cls: 'task-manager-table-status' });
    btn.setAttr('type', 'button');
    btn.setAttr('title', canvasReadOnly ? 'Canvas tasks are indexed read-only' : 'Cycle task status');
    btn.setAttr('aria-label', canvasReadOnly ? `${task.normalizedText}: Canvas task status is read-only` : `Cycle status for ${task.normalizedText}`);
    btn.disabled = canvasReadOnly;
    btn.addClass(getStatusColorClass(task.checkbox));
    btn.addEventListener('click', (event) => {
      event.stopPropagation();
      if (!canvasReadOnly) void onToggle(task);
    });
    return;
  }

  if (column.key === 'task') {
    const wrap = cell.createDiv({ cls: 'task-manager-table-task-wrap' });
    wrap.style.paddingLeft = `${Math.min(depth, 12) * 1.25}rem`;
    if (hasChildren) {
      const toggle = wrap.createEl('button', { text: state.collapsed.has(task.key) ? '>' : 'v', cls: 'task-manager-table-hierarchy-toggle' });
      toggle.setAttr('type', 'button');
      toggle.setAttr('title', state.collapsed.has(task.key) ? 'Expand subtasks' : 'Collapse subtasks');
      toggle.setAttr('aria-label', `${state.collapsed.has(task.key) ? 'Expand' : 'Collapse'} subtasks for ${task.normalizedText}`);
      toggle.setAttr('aria-expanded', String(!state.collapsed.has(task.key)));
      toggle.addEventListener('click', (event) => {
        event.stopPropagation();
        if (state.collapsed.has(task.key)) state.collapsed.delete(task.key);
        else state.collapsed.add(task.key);
        actions.onRerender?.();
      });
    } else {
      wrap.createEl('span', { text: '', cls: 'task-manager-table-hierarchy-spacer' });
    }
    const text = wrap.createEl('button', { text: task.normalizedText, cls: 'task-manager-table-task-title' });
    text.setAttr('type', 'button');
    text.setAttr('aria-label', `Edit ${task.normalizedText}`);
    text.addEventListener('click', () => onEdit(task));
    const rollup = rollups.get(task.key);
    if (rollup) wrap.createEl('span', { text: rollup.progressText, cls: 'task-manager-table-subtask-badge' });
    const heatmap = settings.recurringHeatmapEnabled ? renderRecurrenceHeatmap(task, allTasks, actions.getRecurrenceHistoryDates?.(task) ?? []) : null;
    if (heatmap) wrap.appendChild(heatmap);
    return;
  }

  if (column.key === 'tags') {
    renderTagCell(cell, task, actions);
    return;
  }

  if (column.key === 'priority') {
    cell.addClass(getPriorityColorClass(task.metadata.priority ?? 'normal'));
  }

  if (column.key === 'file') {
    const button = cell.createEl('button', { text: shortFileName(task.filePath), cls: 'task-manager-table-source-btn' });
    button.setAttr('type', 'button');
    button.setAttr('title', task.filePath);
    button.setAttr('aria-label', `Open source for ${task.normalizedText}: ${task.filePath}`);
    button.addEventListener('click', () => actions.onOpenSource?.(task));
    return;
  }

  if (column.key.startsWith('custom:')) {
    const key = column.key.slice('custom:'.length);
    const config = settings.tableViewConfig?.customColumns.find((candidate) => candidate.key === key);
    if (config?.color) cell.style.setProperty('--task-manager-custom-column-color', config.color);
    const button = cell.createEl('button', { text: customDisplayText(column.render(task), config?.type) || '+', cls: `task-manager-table-custom-field-btn task-manager-table-custom-${config?.type ?? 'text'}` });
    button.setAttr('type', 'button');
    button.setAttr('title', `Edit ${column.label}`);
    button.setAttr('aria-label', `Edit ${column.label} for ${task.normalizedText}. Current value: ${customDisplayText(column.render(task), config?.type) || 'empty'}`);
    button.addEventListener('click', () => {
      if (config?.type === 'list') {
        renderListEditor(button, column.label, column.render(task), parseListOptions(config?.options ?? []), (value) => {
          return Promise.resolve(actions.onSetCustomField?.(task, key, value));
        });
        return;
      }
      renderCustomFieldEditor(button, task, key, column.label, column.render(task), config, actions);
    });
    return;
  }

  cell.setText(column.render(task));
}

function renderTagCell(cell: HTMLElement, task: ParsedTask, actions: TableRenderActions): void {
  const tags = task.tags.map(normalizeTag).filter(Boolean);
  if (tags.length === 0) {
    const add = cell.createEl('button', { text: '+ tag', cls: 'task-manager-table-tag-empty' });
    add.setAttr('type', 'button');
    add.setAttr('aria-label', `Add tag to ${task.normalizedText}`);
    add.addEventListener('click', () => renderBulkTagEditor(add, [task], [task], actions, 'add'));
    return;
  }
  for (const tag of tags) {
    const pill = cell.createEl('button', { text: `#${tag}`, cls: 'task-manager-table-tag-pill' });
    pill.setAttr('type', 'button');
    pill.setAttr('title', `Tag #${tag}`);
    pill.setAttr('aria-label', `Edit tag #${tag} for ${task.normalizedText}`);
    pill.addEventListener('click', () => renderBulkTagEditor(pill, [task], [task], actions, 'remove'));
  }
  const add = cell.createEl('button', { text: '+', cls: 'task-manager-table-tag-add' });
  add.setAttr('type', 'button');
  add.setAttr('aria-label', `Add tag to ${task.normalizedText}`);
  add.addEventListener('click', () => renderBulkTagEditor(add, [task], [task], actions, 'add'));
}

function renderCustomFieldEditor(
  anchor: HTMLElement,
  task: ParsedTask,
  key: string,
  label: string,
  current: string,
  config: { type?: string; options?: string[]; required?: boolean } | undefined,
  actions: TableRenderActions,
): void {
  const popover = createTableEditorPopover(anchor, { title: `Edit ${label}`, description: task.normalizedText });
  const input = popover.content.createEl('input', { type: config?.type === 'date' ? 'date' : config?.type === 'number' ? 'number' : 'text', cls: 'task-manager-table-list-editor-input' });
  input.value = current;
  input.setAttr('aria-label', `${label} for ${task.normalizedText}`);
  const apply = async (): Promise<void> => {
    const normalized = normalizeCustomInput(input.value, config);
    if (normalized === null) { popover.showError(`Invalid ${label} value.`); input.focus(); return; }
    popover.setBusy(true);
    try {
      await Promise.resolve(actions.onSetCustomField?.(task, key, normalized));
      popover.close();
    } catch (error) {
      popover.setBusy(false);
      popover.showError(error);
      input.focus();
    }
  };
  input.addEventListener('keydown', (event: KeyboardEvent) => { if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); void apply(); } });
  const buttons = popover.content.createDiv({ cls: 'task-manager-table-list-editor-actions' });
  buttons.createEl('button', { text: t('table.cancel') }).addEventListener('click', () => popover.close());
  buttons.createEl('button', { text: t('table.save') }).addEventListener('click', () => { void apply(); });
  popover.focusInitial(input);
}

export function renderBulkTagEditor(
  anchor: HTMLElement,
  selectedTasks: ParsedTask[],
  allTasks: ParsedTask[],
  actions: TableRenderActions,
  mode: 'add' | 'remove',
  submit?: (tag: string) => Promise<TableBulkActionResult>,
  resolveFocusTarget?: () => HTMLElement | null,
): void {
  const targetAction = mode === 'add' ? actions.onAddTag : actions.onRemoveTag;
  const title = t(mode === 'add' ? 'table.addTagTitle' : 'table.removeTagTitle');
  const description = t('table.selectedCount', { count: selectedTasks.length, action: title });
  const popover = createTableEditorPopover(anchor, { title, description, className: 'task-manager-table-bulk-tag-editor', resolveFocusTarget });
  const inputRow = popover.content.createDiv({ cls: 'task-manager-table-list-editor-input-row' });
  const input = inputRow.createEl('input', { type: 'text', cls: 'task-manager-table-list-editor-input' });
  input.setAttr('aria-label', t(mode === 'add' ? 'table.tagToAdd' : 'table.tagToRemove'));
  input.setAttr('placeholder', mode === 'add' ? 'project' : 'tag to remove');
  const applyBtn = inputRow.createEl('button', { text: t(mode === 'add' ? 'table.add' : 'table.remove'), cls: 'task-manager-table-list-editor-add-btn' });
  applyBtn.setAttr('type', 'button');
  const suggestionsWrap = popover.content.createDiv({ cls: 'task-manager-table-list-editor-suggestions' });
  const suggestions = Array.from(new Set(allTasks.flatMap((task) => task.tags.map(normalizeTag)))).filter(Boolean).sort((a, b) => a.localeCompare(b));
  const apply = async (rawValue?: string): Promise<void> => {
    const value = normalizeTag(rawValue ?? input.value);
    if (!value || (!submit && !targetAction)) return;
    popover.setBusy(true);
    try {
      const result = submit
        ? await submit(value)
        : (await Promise.all(selectedTasks.map((task) => Promise.resolve(targetAction?.(task, value)))), { attempted: selectedTasks.length, succeeded: selectedTasks.length, failed: 0, skipped: 0 });
      if (result.failed > 0 || result.skipped > 0) {
        popover.setBusy(false);
        popover.showError(bulkResultMessage(mode === 'add' ? 'Add tag' : 'Remove tag', result).message);
        input.focus();
        return;
      }
      popover.close();
    } catch (error) { popover.setBusy(false); popover.showError(error); input.focus(); }
  };
  if (suggestions.length === 0) suggestionsWrap.createEl('div', { text: t('table.noTagSuggestions'), cls: 'task-manager-table-list-editor-empty' });
  else {
    suggestionsWrap.createEl('div', { text: t('table.suggestions'), cls: 'task-manager-table-list-editor-subtitle' });
    const row = suggestionsWrap.createDiv({ cls: 'task-manager-table-list-editor-chip-row' });
    for (const suggestion of suggestions) {
      const chip = row.createEl('button', { text: `#${suggestion}`, cls: 'task-manager-table-list-editor-suggestion' });
      chip.setAttr('type', 'button');
      chip.addEventListener('click', () => { void apply(suggestion); });
    }
  }
  input.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); popover.close(); }
    else if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); void apply(); }
  });
  applyBtn.addEventListener('click', () => { void apply(); });
  const footer = popover.content.createDiv({ cls: 'task-manager-table-list-editor-actions' });
  footer.createEl('button', { text: t('table.cancel') }).addEventListener('click', () => popover.close());
  popover.focusInitial(input);
}

function renderBulkCustomFieldEditor(
  anchor: HTMLElement,
  selectedTasks: ParsedTask[],
  actions: TableRenderActions,
  submit?: (key: string, value: string) => Promise<TableBulkActionResult>,
  resolveFocusTarget?: () => HTMLElement | null,
): void {
  const popover = createTableEditorPopover(anchor, {
    title: t('table.customFieldTitle'),
    description: t('table.customFieldDescription', { count: selectedTasks.length }),
    className: 'task-manager-table-bulk-field-editor',
    resolveFocusTarget,
  });
  const keyRow = popover.content.createDiv({ cls: 'task-manager-table-list-editor-input-row' });
  const keyInput = keyRow.createEl('input', { type: 'text', cls: 'task-manager-table-list-editor-input' });
  keyInput.setAttr('aria-label', t('table.customFieldName'));
  keyInput.setAttr('placeholder', 'field name (for example: owner)');
  const valueRow = popover.content.createDiv({ cls: 'task-manager-table-list-editor-input-row' });
  const valueInput = valueRow.createEl('input', { type: 'text', cls: 'task-manager-table-list-editor-input' });
  valueInput.setAttr('aria-label', t('table.customFieldValue'));
  valueInput.setAttr('placeholder', 'field value (empty clears the field)');
  const applyBtn = popover.content.createEl('button', { text: t('table.apply'), cls: 'task-manager-table-list-editor-add-btn' });
  applyBtn.setAttr('type', 'button');
  const apply = async (): Promise<void> => {
    const key = keyInput.value.trim();
    if (!key) { popover.showError(t('table.fieldNameRequired')); keyInput.focus(); return; }
    popover.setBusy(true);
    try {
      const value = valueInput.value.trim();
      const result = submit
        ? await submit(key, value)
        : actions.onBulkSetCustomField
          ? normalizedBulkResult(await actions.onBulkSetCustomField(selectedTasks, key, value), selectedTasks.length)
          : (await Promise.all(selectedTasks.map((task) => Promise.resolve(actions.onSetCustomField?.(task, key, value)))), { attempted: selectedTasks.length, succeeded: selectedTasks.length, failed: 0, skipped: 0 });
      if (result.failed > 0 || result.skipped > 0) {
        popover.setBusy(false);
        popover.showError(bulkResultMessage('Custom field', result).message);
        keyInput.focus();
        return;
      }
      popover.close();
    } catch (error) { popover.setBusy(false); popover.showError(error); keyInput.focus(); }
  };
  keyInput.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); popover.close(); }
    else if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); valueInput.focus(); }
  });
  valueInput.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); popover.close(); }
    else if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); void apply(); }
  });
  applyBtn.addEventListener('click', () => { void apply(); });
  const footer = popover.content.createDiv({ cls: 'task-manager-table-list-editor-actions' });
  footer.createEl('button', { text: t('table.cancel') }).addEventListener('click', () => popover.close());
  popover.focusInitial(keyInput);
}

function saveCurrentFilter(state: TableState, settings: TaskManagerSettings, actions: TableRenderActions): void {
  const name = prompt('Saved filter name:');
  if (!name?.trim()) return;
  const filter: TableSavedFilter = {
    name: name.trim(),
    search: state.search,
    statuses: Array.from(state.statuses),
    priorities: Array.from(state.priorities),
    tags: Array.from(state.tags),
    sortKey: state.sortKey,
    sortDirection: state.sortDirection,
    showHierarchy: state.showHierarchy,
    visibleColumns: Array.from(state.visibleColumns),
  };
  const config = ensureTableConfig(settings);
  config.savedFilters = [filter, ...config.savedFilters.filter((candidate) => candidate.name.toLowerCase() !== filter.name.toLowerCase())].slice(0, 12);
  state.activeSavedFilterName = filter.name;
  void actions.onSaveSettings?.();
  actions.onRerender?.();
}

function applySavedFilter(state: TableState, filter: TableSavedFilter): void {
  state.search = filter.search;
  state.statuses = new Set(filter.statuses);
  state.priorities = new Set(filter.priorities);
  state.tags = new Set(filter.tags);
  state.sortKey = filter.sortKey;
  state.sortDirection = filter.sortDirection;
  state.showHierarchy = filter.showHierarchy;
  state.visibleColumns = new Set(filter.visibleColumns);
  state.activeSavedFilterName = filter.name;
}

function renderExportMenu(button: HTMLElement, tasks: ParsedTask[], columns: TableColumn[]): void {
  button.parentElement?.querySelector('.task-manager-table-export-menu')?.remove();
  const panel = button.parentElement?.createDiv({ cls: 'task-manager-table-export-menu' });
  if (!panel) return;
  panel.id = `task-manager-table-export-${tablePopupSequence++}`;
  panel.setAttr('role', 'menu');
  panel.setAttr('aria-label', 'Export format');
  button.setAttr('aria-controls', panel.id);
  button.setAttr('aria-expanded', 'true');
  const AbortControllerCtor = panel.ownerDocument.defaultView?.AbortController ?? AbortController;
  const controller = new AbortControllerCtor();
  const close = (restoreFocus: boolean): void => {
    controller.abort();
    panel.remove();
    button.setAttr('aria-expanded', 'false');
    button.removeAttribute('aria-controls');
    if (restoreFocus) button.focus();
  };
  const add = (label: string, format: 'markdown' | 'csv' | 'html' | 'pdf'): void => {
    const item = panel.createEl('button', { text: label });
    item.setAttr('type', 'button');
    item.setAttr('role', 'menuitem');
    item.addEventListener('click', () => {
      if (format === 'pdf') {
        openPrintPdf(tasks, columns);
      } else {
        const content = format === 'markdown' ? exportMarkdown(tasks, columns) : format === 'csv' ? exportCsv(tasks, columns) : exportHtml(tasks, columns);
        downloadText(`tasks-export.${format === 'markdown' ? 'md' : format}`, content, format === 'html' ? 'text/html' : 'text/plain');
      }
      close(true);
    });
  };
  add('Markdown', 'markdown');
  add('CSV', 'csv');
  add('HTML / Print', 'html');
  add('PDF', 'pdf');
  panel.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    close(true);
  });
  window.setTimeout(() => panel.querySelector<HTMLButtonElement>('button')?.focus(), 0);
  document.addEventListener('click', (event) => {
    if (!panel.isConnected) { controller.abort(); return; }
    if (!panel.contains(event.target as Node) && event.target !== button) close(false);
  }, { capture: true, signal: controller.signal });
}

function openPrintPdf(tasks: ParsedTask[], columns: TableColumn[]): void {
  const html = exportHtml(tasks, columns, true);
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  const win = window.open(url);
  if (!win) {
    URL.revokeObjectURL(url);
    downloadText('tasks-export.html', html, 'text/html');
    new Notice('Popup blocked. Saved printable HTML instead.');
    return;
  }
  win.onload = () => {
    URL.revokeObjectURL(url);
    win.focus();
    win.print();
  };
}

function customDisplayText(value: string, type: string | undefined): string {
  if (type === 'checkbox') return /^(true|yes|y|1|on)$/iu.test(value) ? 'Yes' : value ? 'No' : '';
  if (type === 'list') return value.split(',').map((entry) => entry.trim()).filter(Boolean).join(' · ');
  return value;
}

function renderListEditor(anchor: HTMLElement, label: string, current: string, options: Array<{ value: string; color?: string }>, onSave: (value: string) => Promise<void>): void {
  const popover = createTableEditorPopover(anchor, { title: label });
  const selected = new Set(current.split(',').map((entry) => entry.trim()).filter(Boolean));
  const selectedColors = new Map(options.map((option) => [option.value, option.color ?? ''] as const));
  const inputRow = popover.content.createDiv({ cls: 'task-manager-table-list-editor-input-row' });
  const input = inputRow.createEl('input', { type: 'text', cls: 'task-manager-table-list-editor-input' });
  input.setAttr('aria-label', t('table.addValue', { label }));
  input.setAttr('placeholder', 'Add value');
  const addBtn = inputRow.createEl('button', { text: t('table.add'), cls: 'task-manager-table-list-editor-add-btn' });
  addBtn.setAttr('type', 'button');
  const selectedWrap = popover.content.createDiv({ cls: 'task-manager-table-list-editor-selected' });
  const suggestionsWrap = popover.content.createDiv({ cls: 'task-manager-table-list-editor-suggestions' });
  const serialize = (): string => Array.from(selected).join(', ');
  const renderSelected = (): void => {
    selectedWrap.empty();
    if (selected.size === 0) { selectedWrap.createEl('div', { text: t('table.noValuesSelected'), cls: 'task-manager-table-list-editor-empty' }); return; }
    for (const value of selected) {
      const chip = selectedWrap.createDiv({ cls: 'task-manager-table-list-editor-chip' });
      const color = chip.createEl('input', { type: 'color', cls: 'task-manager-table-list-editor-color' });
      const currentColor = selectedColors.get(value)?.trim() || '#808080';
      color.value = currentColor;
      color.setAttr('aria-label', `${value} color`);
      chip.style.setProperty('--task-manager-custom-column-color', currentColor);
      color.addEventListener('input', () => { selectedColors.set(value, color.value); chip.style.setProperty('--task-manager-custom-column-color', color.value); });
      chip.createEl('span', { text: value, cls: 'task-manager-table-list-editor-chip-label' });
      const remove = chip.createEl('button', { text: '✕', cls: 'task-manager-table-list-editor-chip-remove' });
      remove.setAttr('type', 'button');
      remove.setAttr('aria-label', t('table.removeValue', { value }));
      remove.addEventListener('click', () => { selected.delete(value); renderSelected(); renderSuggestions(); });
    }
  };
  const renderSuggestions = (): void => {
    suggestionsWrap.empty();
    const available = options.filter((option) => !selected.has(option.value));
    if (available.length === 0) return;
    suggestionsWrap.createEl('div', { text: t('table.suggestions'), cls: 'task-manager-table-list-editor-subtitle' });
    const chips = suggestionsWrap.createDiv({ cls: 'task-manager-table-list-editor-chip-row' });
    for (const option of available) {
      const chip = chips.createEl('button', { text: option.value, cls: 'task-manager-table-list-editor-suggestion' });
      chip.setAttr('type', 'button');
      if (option.color) chip.style.setProperty('--task-manager-custom-column-color', option.color);
      chip.addEventListener('click', () => { selected.add(option.value); selectedColors.set(option.value, option.color ?? ''); renderSelected(); renderSuggestions(); });
    }
  };
  const addValue = (): void => {
    const value = input.value.trim();
    if (!value) return;
    selected.add(value);
    if (!selectedColors.has(value)) selectedColors.set(value, '');
    input.value = '';
    renderSelected();
    renderSuggestions();
    input.focus();
  };
  input.addEventListener('keydown', (event: KeyboardEvent) => {
    if (event.key === 'Escape') { event.preventDefault(); popover.close(); }
    else if (event.key === 'Enter' && !event.isComposing) { event.preventDefault(); addValue(); }
  });
  addBtn.addEventListener('click', addValue);
  renderSelected();
  renderSuggestions();
  const actions = popover.content.createDiv({ cls: 'task-manager-table-list-editor-actions' });
  actions.createEl('button', { text: t('table.cancel') }).addEventListener('click', () => popover.close());
  actions.createEl('button', { text: t('table.save') }).addEventListener('click', () => {
    popover.setBusy(true);
    void Promise.resolve(onSave(serialize())).then(() => popover.close(), (error) => { popover.setBusy(false); popover.showError(error); input.focus(); });
  });
  popover.focusInitial(input);
}

function parseListOptions(options: string[]): Array<{ value: string; color?: string }> {
  return options.map((option) => {
    const [value, color] = option.split('|').map((entry) => entry.trim());
    return { value, ...(color && /^#[0-9a-f]{6}$/iu.test(color) ? { color } : {}) };
  }).filter((option) => option.value.length > 0);
}

function normalizeCustomInput(value: string, config: { type?: string; options?: string[]; required?: boolean } | undefined): string | null {
  const trimmed = value.trim();
  if (!trimmed) return config?.required ? null : '';
  if (config?.type === 'number' && !/^[-+]?\d+(?:\.\d+)?$/u.test(trimmed)) return null;
  if (config?.type === 'date' && !normalizeTableDateInput(trimmed)) return null;
  if (config?.type === 'checkbox') return /^(true|yes|y|1|on)$/iu.test(trimmed) ? 'true' : 'false';
  if (config?.options?.length && !config.options.includes(trimmed)) return null;
  return config?.type === 'list' ? trimmed.split(/,|\s+/u).map((entry) => entry.trim()).filter(Boolean).join(', ') : trimmed;
}

function exportMarkdown(tasks: ParsedTask[], columns: TableColumn[]): string {
  const exportColumns = columns.filter((column) => column.key !== 'select');
  const header = `| ${exportColumns.map((column) => column.label).join(' | ')} |`;
  const divider = `| ${exportColumns.map(() => '---').join(' | ')} |`;
  const rows = tasks.map((task) => `| ${exportColumns.map((column) => column.render(task).replace(/\|/gu, '\\|')).join(' | ')} |`);
  return [header, divider, ...rows].join('\n');
}

function exportCsv(tasks: ParsedTask[], columns: TableColumn[]): string {
  const exportColumns = columns.filter((column) => column.key !== 'select');
  return [exportColumns.map((column) => csvEscape(column.label)).join(','), ...tasks.map((task) => exportColumns.map((column) => csvEscape(column.render(task))).join(','))].join('\n');
}

function exportHtml(tasks: ParsedTask[], columns: TableColumn[], printable = false): string {
  const exportColumns = columns.filter((column) => column.key !== 'select');
  const esc = (value: string): string => value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;');
  const printStyles = printable ? '@page{margin:1cm}' : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Tasks Export</title><style>body{font-family:system-ui,sans-serif}table{border-collapse:collapse;width:100%}th,td{border:1px solid #ddd;padding:6px;text-align:left}${printStyles}</style></head><body><h1>Tasks Export</h1><table><thead><tr>${exportColumns.map((column) => `<th>${esc(column.label)}</th>`).join('')}</tr></thead><tbody>${tasks.map((task) => `<tr>${exportColumns.map((column) => `<td>${esc(column.render(task))}</td>`).join('')}</tr>`).join('')}</tbody></table></body></html>`;
}

function downloadText(filename: string, content: string, type: string): void {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
  new Notice(`Exported ${filename}`);
}

function buildRows(tasks: ParsedTask[], matched: ParsedTask[], state: TableState, compare: (a: ParsedTask, b: ParsedTask) => number): RowModel[] {
  if (!state.showHierarchy) return [...matched].sort(compare).map((task) => ({ task, depth: 0, hasChildren: false, context: false }));
  const tree = buildTree(tasks);
  const matchedKeys = new Set(matched.map((task) => task.key));
  const hasFilters = filtersActive(state);
  const rows: RowModel[] = [];
  const visit = (task: ParsedTask, depth: number, parentCollapsed: boolean): boolean => {
    const children = tree.children.get(task.key) ?? [];
    const sortedChildren = [...children].sort(compare);
    const childMatches = sortedChildren.map((child) => visit(child, depth + 1, parentCollapsed || (!hasFilters && state.collapsed.has(task.key))));
    const descendantMatches = childMatches.some(Boolean);
    const ownMatch = matchedKeys.has(task.key);
    const visible = ownMatch || descendantMatches || !hasFilters;
    if (visible && !parentCollapsed) {
      rows.push({ task, depth, hasChildren: children.length > 0, context: hasFilters && !ownMatch && descendantMatches });
    }
    return ownMatch || descendantMatches;
  };
  for (const root of [...tree.roots].sort(compare)) visit(root, 0, false);
  return rows;
}

function buildTree(tasks: ParsedTask[]): { roots: ParsedTask[]; children: Map<string, ParsedTask[]> } {
  const byFile = new Map<string, ParsedTask[]>();
  for (const task of tasks) {
    const list = byFile.get(task.filePath) ?? [];
    list.push(task);
    byFile.set(task.filePath, list);
  }
  const roots: ParsedTask[] = [];
  const children = new Map<string, ParsedTask[]>();
  for (const fileTasks of byFile.values()) {
    const stack: ParsedTask[] = [];
    for (const task of [...fileTasks].sort((a, b) => a.lineNumber - b.lineNumber)) {
      while (stack.length > 0 && stack[stack.length - 1].indentation.length >= task.indentation.length) stack.pop();
      const parent = stack[stack.length - 1];
      if (parent) {
        const list = children.get(parent.key) ?? [];
        list.push(task);
        children.set(parent.key, list);
      } else {
        roots.push(task);
      }
      stack.push(task);
    }
  }
  return { roots, children };
}

export function tableSortValue(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  return String(value);
}

export function compareTableSortValues(a: string | null, b: string | null, direction: 'asc' | 'desc'): number {
  if (a === null && b === null) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  const comparison = a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });
  return direction === 'asc' ? comparison : -comparison;
}

function compareForState(state: TableState, rollups: Map<string, Rollup>): (a: ParsedTask, b: ParsedTask) => number {
  return (a, b) => {
    const closedComparison = closedTaskSortBucket(a) - closedTaskSortBucket(b);
    if (closedComparison !== 0) return closedComparison;
    return compareTableSortValues(tableTaskSortValue(a, state.sortKey, rollups), tableTaskSortValue(b, state.sortKey, rollups), state.sortDirection);
  };
}

function closedTaskSortBucket(task: ParsedTask): number {
  return task.status === 'done' || task.status === 'cancelled' ? 1 : 0;
}

export function tableTaskSortValue(task: ParsedTask, key: string, rollups: Map<string, Rollup> = new Map()): string | null {
  if (key.startsWith('custom:')) return tableSortValue(customFieldText(task, key.slice('custom:'.length)));
  switch (key) {
    case 'status': return task.status;
    case 'task': return task.normalizedText;
    case 'tags': return tableSortValue(task.tags.join(' '));
    case 'pinned': return task.metadata.pinned ? '0' : '1';
    case 'priority': return String(priorityRank(task.metadata.priority ?? 'normal'));
    case 'due': return tableSortValue(task.metadata.dates.due);
    case 'scheduled': return tableSortValue(task.metadata.dates.scheduled);
    case 'start': return tableSortValue(task.metadata.dates.start);
    case 'progress': return tableSortValue(rollups.get(task.key)?.progressText);
    case 'effort': return task.metadata.effort ? tableSortValue(parseEffortMinutesForFilter(task.metadata.effort)) : null;
    case 'actual': return task.metadata.actual ? tableSortValue(parseEffortMinutesForFilter(task.metadata.actual)) : null;
    case 'cost': return tableSortValue(task.metadata.cost);
    case 'depends-on': return tableSortValue(task.metadata.dependsOn.join(','));
    case 'file': return task.filePath;
    default: return null;
  }
}

function matchesStateFilters(task: ParsedTask, state: TableState): boolean {
  const search = state.search.trim().toLowerCase();
  if (search) {
    const haystack = [task.normalizedText, task.filePath, task.status, task.metadata.priority, ...task.tags, ...Object.values(task.metadata.customFields ?? {}).map((field) => field?.value).flat().map(String)].filter(Boolean).join(' ').toLowerCase();
    if (!haystack.includes(search)) return false;
  }
  if (state.statuses.size > 0 && !state.statuses.has(task.status)) return false;
  if (state.priorities.size > 0 && !state.priorities.has(task.metadata.priority ?? 'normal')) return false;
  if (state.tags.size > 0) {
    const tags = new Set(task.tags.map(normalizeTag));
    for (const tag of state.tags) if (!tags.has(tag)) return false;
  }
  return true;
}

function filtersActive(state: TableState): boolean {
  return Boolean(state.search.trim() || state.statuses.size || state.priorities.size || state.tags.size);
}

function isHidden(query: TaskQuery, key: string): boolean {
  return query.layout.hidden.has(key)
    || query.layout.hidden.has(`${key} column`)
    || (key === 'depends-on' && query.layout.hidden.has('depends on'));
}

function statusLabel(task: ParsedTask, settings: TaskManagerSettings): string {
  const state = settings.supportedStates.find((s) => s.rawText === task.checkbox);
  return `${state?.icon || task.checkbox || ' '} ${state?.name ?? task.status}`.trim();
}

export interface Rollup { progressText: string; effortText: string; actualText: string; cost?: number; }

export function buildRollups(tasks: ParsedTask[]): Map<string, Rollup> {
  const byKey = new Map<string, Rollup>();
  const tree = buildTree(tasks);
  for (const task of tasks) {
    const directChildren = tree.children.get(task.key) ?? [];
    if (directChildren.length === 0) continue;
    const done = directChildren.filter((child) => child.status === 'done' || child.status === 'cancelled').length;
    const effort = sumMinutes(directChildren.map((child) => child.metadata.effort));
    const actual = sumMinutes(directChildren.map((child) => child.metadata.actual));
    const cost = sumNumbers(directChildren.map((child) => child.metadata.cost));
    byKey.set(task.key, {
      progressText: `${done}/${directChildren.length} (${Math.round((done / directChildren.length) * 100)}%)`,
      effortText: effort > 0 ? formatMinutes(effort) : '',
      actualText: actual > 0 ? formatMinutes(actual) : '',
      cost: cost > 0 ? cost : undefined,
    });
  }
  return byKey;
}

function sumMinutes(values: Array<string | undefined>): number {
  return values.reduce((sum, value) => sum + parseMinutes(value), 0);
}

function parseMinutes(value: string | undefined): number {
  const minutes = parseEffortMinutesForFilter(value);
  return Number.isFinite(minutes) ? minutes : 0;
}

function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h ? `${h}h` : ''}${h && m ? ' ' : ''}${m ? `${m}m` : ''}` || '0m';
}

function sumNumbers(values: Array<number | undefined>): number {
  return values.reduce<number>((sum, value) => sum + (value !== undefined && Number.isFinite(value) ? value : 0), 0);
}

function formatCurrency(value: number | undefined): string {
  return value === undefined || !Number.isFinite(value) ? '' : String(value);
}

function customFieldText(task: ParsedTask, key: string): string {
  const value = task.metadata.customFields?.[key.toLowerCase()]?.value;
  if (Array.isArray(value)) return value.join(', ');
  return value === undefined ? '' : String(value);
}

function normalizeTag(tag: string): string {
  return tag.replace(/^#/u, '').trim();
}

function priorityRank(priority: string): number {
  return ({ highest: 0, high: 1, medium: 2, normal: 3, low: 4, lowest: 5 } as Record<string, number>)[priority] ?? 3;
}

function headerLabel(column: TableColumn, state: TableState): string {
  if (state.sortKey !== column.key) return column.label;
  return `${column.label} ${state.sortDirection === 'asc' ? '▲' : '▼'}`;
}

function cssKey(key: string): string {
  return key.replace(/[^a-z0-9_-]/giu, '-');
}

function shortFileName(path: string): string {
  return path.split('/').pop()?.replace(/\.md$/u, '') ?? path;
}

function csvEscape(value: string): string {
  return encodeCsvCell(value);
}
