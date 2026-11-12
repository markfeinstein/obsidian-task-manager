import { strict as assert } from 'node:assert';
import test from 'node:test';
import { buildRollups, captureTableGridFocus, renderBulkTagEditor, renderTable, type TableBulkActionResult, type TableRenderActions } from '../src/table-renderer.js';
import { createMockTask, FakeDOMElement } from './test-utils.js';
import { DEFAULT_TASK_STATES } from '../src/types.js';
import { parseMarkdownTaskLine } from '../src/task-model.js';
import type { ParsedTask } from '../src/task-scanner';
import type { TaskQuery } from '../src/task-query';
import type { TaskManagerSettings } from '../src/types';
import { installDomHarness } from './dom-harness';

function task(overrides: Partial<ParsedTask>): ParsedTask {
  const base = createMockTask();
  return createMockTask({
    ...overrides,
    metadata: {
      ...base.metadata,
      ...overrides.metadata,
      dates: {
        ...base.metadata.dates,
        ...overrides.metadata?.dates,
      },
    },
  });
}

function emptyQuery(): TaskQuery {
  return {
    filters: [],
    sort: [],
    groups: [],
    layout: { hidden: new Set(), shown: new Set() },
    explain: false,
    errors: [],
    instructions: [],
  };
}

function findElementsByTag(root: FakeDOMElement, tagName: string): FakeDOMElement[] {
  const results: FakeDOMElement[] = [];
  const visit = (node: FakeDOMElement): void => {
    if (node.tagName === tagName) results.push(node);
    for (const child of node.children) {
      if (child instanceof FakeDOMElement) visit(child);
    }
  };
  visit(root);
  return results;
}

const settings = { supportedStates: DEFAULT_TASK_STATES } as unknown as TaskManagerSettings;

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}

async function flushAsync(): Promise<void> {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test('table rollups use strict shared effort duration parsing', () => {
  const parent = task({
    key: 'parent',
    lineNumber: 1,
    normalizedText: 'Parent',
  });
  const decimalChild = task({
    key: 'decimal-child',
    lineNumber: 2,
    indentation: '  ',
    metadata: { ...createMockTask().metadata, effort: '1.5h' },
  });
  const bareMinutesChild = task({
    key: 'bare-minutes-child',
    lineNumber: 3,
    indentation: '  ',
    metadata: { ...createMockTask().metadata, effort: '45' },
  });
  const invalidChild = task({
    key: 'invalid-child',
    lineNumber: 4,
    indentation: '  ',
    metadata: { ...createMockTask().metadata, effort: '2horse' },
  });

  const rollups = buildRollups([parent, decimalChild, bareMinutesChild, invalidChild]);

  assert.equal(rollups.get('parent')?.effortText, '2h 15m');
});

test('table renderer exposes native sortable header buttons and aria-sort', () => {
  const root = new FakeDOMElement('div');
  renderTable(root as unknown as HTMLElement, [task({ key: 'sort-task' })], emptyQuery(), settings, async () => undefined, () => undefined);

  const sortButtons = root.querySelectorAll('.task-manager-table-sort-button');
  assert.ok(sortButtons.length > 0);
  assert.ok(sortButtons.every((button) => button.tagName === 'button' && button.getAttr('type') === 'button'));
  const sortedHeader = findElementsByTag(root, 'th').find((header) => header.getAttr('aria-sort') === 'ascending');
  assert.ok(sortedHeader, 'default due-date header should expose ascending sort state');
});

test('table renderer keeps canvas status controls read-only and removes row mutation shortcuts', () => {
  const root = new FakeDOMElement('div');
  const canvasTask = task({
    key: 'canvas-task',
    filePath: 'Board.canvas',
    normalizedText: 'Canvas task',
  });

  let toggled = 0;
  renderTable(
    root as unknown as HTMLElement,
    [canvasTask],
    emptyQuery(),
    settings,
    async () => { toggled += 1; },
    () => undefined,
  );

  const row = root.querySelectorAll('.task-manager-table-row')[0];
  const status = root.querySelectorAll('.task-manager-table-status')[0];
  assert.ok(row && status, 'table row and status control should exist');
  assert.equal(row.listeners.get('keydown'), undefined, 'rows must not retain Enter/Space mutation shortcuts');
  assert.equal(status.disabled, true);
  status.listeners.get('click')?.({ stopPropagation: () => undefined });
  assert.equal(toggled, 0);
});

test('table grid exposes complete roving navigation and interaction semantics', (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const root = harness.document.createElement('section');
  harness.document.body.appendChild(root);
  const first = task({ key: 'grid-a', normalizedText: 'Grid A', tags: ['alpha'], filePath: 'A.md' });
  const second = task({ key: 'grid-b', normalizedText: 'Grid B', tags: ['beta'], filePath: 'B.md' });
  const gridSettings = {
    supportedStates: DEFAULT_TASK_STATES,
    tableViewConfig: { savedFilters: [], customColumns: [], showHierarchy: false, visibleColumns: ['status', 'task', 'tags', 'file'] },
    recurringHeatmapEnabled: false,
  } as unknown as TaskManagerSettings;
  let toggled = 0;
  let edited = 0;
  let opened = 0;
  renderTable(root, [first, second], emptyQuery(), gridSettings, async () => { toggled += 1; }, () => { edited += 1; }, {
    onOpenSource: () => { opened += 1; },
  });

  const grid = root.querySelector<HTMLElement>('[role="grid"]');
  assert.ok(grid);
  assert.equal(grid.getAttribute('aria-rowcount'), '3');
  assert.equal(grid.getAttribute('aria-colcount'), '5');
  assert.equal(grid.getAttribute('aria-multiselectable'), 'true');
  assert.equal(grid.querySelectorAll('[role="columnheader"]').length, 5);
  assert.equal(grid.querySelectorAll('[role="row"]').length, 3);
  assert.equal(grid.querySelectorAll('[role="gridcell"]').length, 10);
  assert.ok(Array.from(grid.querySelectorAll<HTMLElement>('tbody tr')).every((row) => row.getAttribute('aria-selected') === 'false'));
  const sortableHeaders = Array.from(grid.querySelectorAll<HTMLElement>('[role="columnheader"][aria-sort]'));
  assert.equal(sortableHeaders.length, 4);
  assert.ok(sortableHeaders.every((header) => header.getAttribute('aria-sort') === 'none'));
  const cells = Array.from(grid.querySelectorAll<HTMLElement>('[role="columnheader"], [role="gridcell"]'));
  assert.equal(cells.filter((cell) => cell.tabIndex === 0).length, 1);
  assert.ok(Array.from(grid.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href]')).every((control) => control.tabIndex === -1));

  const active = (): HTMLElement => {
    const cell = grid.querySelector<HTMLElement>('[role="columnheader"][tabindex="0"], [role="gridcell"][tabindex="0"]');
    assert.ok(cell);
    return cell;
  };
  const press = (target: HTMLElement, key: string, options: KeyboardEventInit = {}): KeyboardEvent => {
    const event = new harness.window.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...options });
    target.dispatchEvent(event);
    return event;
  };

  active().focus();
  press(active(), 'ArrowRight');
  assert.equal(active().dataset.gridColumnKey, 'status');
  press(active(), 'ArrowDown');
  assert.equal(active().dataset.gridRowKey, 'grid-a');
  press(active(), 'End');
  assert.equal(active().dataset.gridColumnKey, 'file');
  press(active(), 'Home');
  assert.equal(active().dataset.gridColumnKey, 'select');
  press(active(), 'End', { ctrlKey: true });
  assert.equal(active().dataset.gridRowKey, 'grid-b');
  assert.equal(active().dataset.gridColumnKey, 'file');
  press(active(), 'Home', { metaKey: true });
  assert.equal(active().dataset.gridRowKey, 'header');
  assert.equal(active().dataset.gridColumnKey, 'select');
  press(active(), 'ArrowLeft');
  assert.equal(active().dataset.gridColumnKey, 'select', 'grid navigation must clamp instead of wrapping');

  press(active(), 'ArrowDown');
  press(active(), 'ArrowRight');
  press(active(), 'ArrowRight');
  press(active(), 'ArrowRight');
  const tagsCell = active();
  assert.equal(tagsCell.dataset.gridColumnKey, 'tags');
  assert.equal(tagsCell.hasAttribute('aria-label'), false, 'gridcell value must remain available to assistive technology');
  assert.match(tagsCell.textContent ?? '', /#alpha/u);
  press(tagsCell, 'F2');
  const tagControls = Array.from(tagsCell.querySelectorAll<HTMLElement>('button'));
  assert.equal(harness.document.activeElement, tagControls[0]);
  assert.ok(tagControls.length >= 2);
  press(tagControls[0], 'Tab');
  assert.equal(harness.document.activeElement, tagControls[1]);
  const lastTagControl = tagControls.at(-1);
  assert.ok(lastTagControl);
  const leaving = press(lastTagControl, 'Tab');
  assert.equal(leaving.defaultPrevented, false);
  assert.equal(tagsCell.tabIndex, 0);
  assert.ok(tagControls.every((control) => control.tabIndex === -1));
  press(tagsCell, 'Enter');
  assert.equal(harness.document.activeElement, tagControls[0]);
  press(tagControls[0], 'Escape');
  assert.equal(harness.document.activeElement, tagsCell);

  const statusCell = Array.from(grid.querySelectorAll<HTMLElement>('[role="gridcell"]')).find((cell) => cell.dataset.gridRowKey === 'grid-a' && cell.dataset.gridColumnKey === 'status');
  const statusButton = statusCell?.querySelector<HTMLButtonElement>('button');
  assert.ok(statusCell && statusButton);
  statusButton.focus();
  press(statusButton, 'Enter');
  press(statusButton, ' ');
  assert.equal(toggled, 0, 'nested key events must never invoke a row-level mutation');
  assert.equal(edited, 0);
  statusButton.click();
  assert.equal(toggled, 1, 'pointer activation must invoke the intended action exactly once');
  const sourceButton = Array.from(grid.querySelectorAll<HTMLElement>('[role="gridcell"]')).find((cell) => cell.dataset.gridRowKey === 'grid-a' && cell.dataset.gridColumnKey === 'file')?.querySelector<HTMLButtonElement>('button');
  sourceButton?.click();
  assert.equal(opened, 1);

  const selection = grid.querySelector<HTMLInputElement>('[role="gridcell"][data-grid-row-key="grid-a"][data-grid-column-key="select"] input');
  selection?.click();
  root.empty();
  renderTable(root, [first, second], emptyQuery(), gridSettings, async () => { toggled += 1; }, () => { edited += 1; });
  assert.equal(root.querySelector<HTMLElement>('tr[data-task-key="grid-a"]')?.getAttribute('aria-selected'), 'true');
});

test('table grid restores logical cell focus only when prior focus was inside the grid', (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const outside = harness.document.createElement('button');
  const root = harness.document.createElement('section');
  harness.document.body.append(outside, root);
  const first = task({ key: 'restore-a', normalizedText: 'Restore A', filePath: 'A.md' });
  const second = task({ key: 'restore-b', normalizedText: 'Restore B', filePath: 'B.md' });
  const gridSettings = {
    supportedStates: DEFAULT_TASK_STATES,
    tableViewConfig: { savedFilters: [], customColumns: [], showHierarchy: false, visibleColumns: ['status', 'task'] },
    recurringHeatmapEnabled: false,
  } as unknown as TaskManagerSettings;

  renderTable(root, [first, second], emptyQuery(), gridSettings, async () => undefined, () => undefined);
  const target = root.querySelector<HTMLElement>('[role="gridcell"][data-grid-row-key="restore-a"][data-grid-column-key="task"]');
  assert.ok(target);
  target.click();
  assert.equal(harness.document.activeElement, target);
  captureTableGridFocus(root);
  root.empty();
  renderTable(root, [second, first], emptyQuery(), gridSettings, async () => undefined, () => undefined);
  const restored = harness.document.activeElement as HTMLElement;
  assert.equal(restored.dataset.gridRowKey, 'restore-a');
  assert.equal(restored.dataset.gridColumnKey, 'task');
  assert.equal(restored.getAttribute('role'), 'gridcell');

  captureTableGridFocus(root);
  root.empty();
  renderTable(root, [second], emptyQuery(), gridSettings, async () => undefined, () => undefined);
  const clamped = harness.document.activeElement as HTMLElement;
  assert.equal(clamped.dataset.gridRowKey, 'restore-b');
  assert.equal(clamped.dataset.gridColumnKey, 'task');

  outside.focus();
  captureTableGridFocus(root);
  root.empty();
  renderTable(root, [second], emptyQuery(), gridSettings, async () => undefined, () => undefined);
  assert.equal(harness.document.activeElement, outside, 'pager/search/outside focus must not be stolen');
});

test('table popover cancels delayed initial focus when closed immediately', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const anchor = harness.document.createElement('button');
  harness.document.body.appendChild(anchor);
  anchor.focus();
  renderBulkTagEditor(anchor, [task({ key: 'focus-a', normalizedText: 'Focus A' })], [], { onAddTag: async () => undefined }, 'add');
  const panel = harness.document.body.querySelector<HTMLElement>('.task-manager-table-bulk-tag-editor');
  assert.ok(panel);
  panel.dispatchEvent(new harness.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(panel.isConnected, false);
  assert.equal(harness.document.activeElement, anchor);
});

test('table renderer shows custom columns and invokes custom-field editor callback', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const root = harness.document.createElement('div');
  harness.document.body.appendChild(root);
  const customTask = task({
    key: 'custom-task',
    normalizedText: 'Custom field task',
    metadata: {
      ...createMockTask().metadata,
      customFields: {
        client: { key: 'client', value: 'Acme', source: 'markdown' },
      },
    },
  });
  const tableSettings = {
    supportedStates: DEFAULT_TASK_STATES,
    tableViewConfig: {
      savedFilters: [],
      customColumns: [{ key: 'client', label: 'Client', type: 'text' as const }],
      showHierarchy: false,
      visibleColumns: ['status', 'task', 'custom:client'],
    },
    recurringHeatmapEnabled: false,
  } as unknown as TaskManagerSettings;
  let edited: { key: string; value: string } | null = null;
  renderTable(root, [customTask], emptyQuery(), tableSettings, async () => undefined, () => undefined, {
    onSetCustomField: async (_task, key, value) => { edited = { key, value }; },
  });
  const button = root.querySelector<HTMLButtonElement>('.task-manager-table-custom-field-btn');
  assert.ok(button, 'custom field button should render');
  assert.equal(button.textContent, 'Acme');
  assert.match(button.getAttribute('aria-label') ?? '', /Client.*Custom field task.*Acme/u);
  button.click();
  const panel = harness.document.body.querySelector<HTMLElement>('.task-manager-table-list-editor');
  const input = panel?.querySelector<HTMLInputElement>('input');
  const save = Array.from(panel?.querySelectorAll<HTMLButtonElement>('button') ?? []).find((candidate) => candidate.textContent === 'Save');
  assert.ok(panel && input && save);
  input.value = 'Globex';
  save.click();
  await Promise.resolve();
  assert.deepEqual(edited, { key: 'client', value: 'Globex' });
});

test('table renderer validates typed custom column input', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const root = harness.document.createElement('div');
  harness.document.body.appendChild(root);
  const customTask = task({ key: 'typed-custom-task', normalizedText: 'Typed custom field' });
  const tableSettings = {
    supportedStates: DEFAULT_TASK_STATES,
    tableViewConfig: {
      savedFilters: [],
      customColumns: [{ key: 'score', label: 'Score', type: 'number' as const, required: true }],
      showHierarchy: false,
      visibleColumns: ['status', 'task', 'custom:score'],
    },
    recurringHeatmapEnabled: false,
  } as unknown as TaskManagerSettings;
  let edited = false;
  renderTable(root, [customTask], emptyQuery(), tableSettings, async () => undefined, () => undefined, {
    onSetCustomField: async () => { edited = true; },
  });
  root.querySelector<HTMLButtonElement>('.task-manager-table-custom-field-btn')?.click();
  const panel = harness.document.body.querySelector<HTMLElement>('.task-manager-table-list-editor');
  const input = panel?.querySelector<HTMLInputElement>('input');
  const save = Array.from(panel?.querySelectorAll<HTMLButtonElement>('button') ?? []).find((candidate) => candidate.textContent === 'Save');
  assert.ok(panel && input && save);
  input.value = 'not-a-number';
  save.click();
  await Promise.resolve();
  assert.equal(edited, false);
  assert.equal(panel.isConnected, true);
  assert.match(panel.querySelector('[role="alert"]')?.textContent ?? '', /Invalid Score/u);
});

test('table renderer shows list custom column values and preserves colors', () => {
  const root = new FakeDOMElement('div');
  const customTask = task({
    key: 'list-task',
    normalizedText: 'List field task',
    metadata: {
      ...createMockTask().metadata,
      customFields: {
        area: { key: 'area', value: 'Work', source: 'markdown' },
      },
    },
  });
  const tableSettings = {
    supportedStates: DEFAULT_TASK_STATES,
    tableViewConfig: {
      savedFilters: [],
      customColumns: [{ key: 'area', label: 'Area', type: 'list' as const, options: ['Home|#77aaff', 'Work|#ffaa77'], color: '#ffaa77' }],
      showHierarchy: false,
      visibleColumns: ['status', 'task', 'custom:area'],
    },
    recurringHeatmapEnabled: false,
  } as unknown as TaskManagerSettings;

  renderTable(root as unknown as HTMLElement, [customTask], emptyQuery(), tableSettings, async () => undefined, () => undefined);

  const button = root.querySelectorAll('.task-manager-table-custom-field-btn')[0];
  assert.ok(button, 'list custom field button should render');
  assert.equal(button.text, 'Work');
  assert.equal(button.classes.includes('task-manager-table-custom-list'), true);
});

test('table renderer saves plain list values without color metadata', async () => {
  const root = new FakeDOMElement('div');
  const body = new FakeDOMElement('body');
  const originalDocument = globalThis.document;
  const originalWindow = globalThis.window;
  globalThis.document = {
    body,
    createElement: (tagName: string) => new FakeDOMElement(tagName),
    querySelector: body.querySelector.bind(body),
    querySelectorAll: body.querySelectorAll.bind(body),
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as Document;
  globalThis.window = {
    setTimeout,
    clearTimeout,
  } as unknown as Window & typeof globalThis;

  try {
    const customTask = task({
      key: 'list-task-save',
      normalizedText: 'List field task',
      metadata: {
        ...createMockTask().metadata,
        customFields: {
          area: { key: 'area', value: 'Work', source: 'markdown' },
        },
      },
    });
    const tableSettings = {
      supportedStates: DEFAULT_TASK_STATES,
      tableViewConfig: {
        savedFilters: [],
        customColumns: [{ key: 'area', label: 'Area', type: 'list' as const, options: ['Home|#77aaff', 'Work|#ffaa77'], color: '#ffaa77' }],
        showHierarchy: false,
        visibleColumns: ['status', 'task', 'custom:area'],
      },
      recurringHeatmapEnabled: false,
    } as unknown as TaskManagerSettings;

    let savedValue: string | null = null;
    renderTable(root as unknown as HTMLElement, [customTask], emptyQuery(), tableSettings, async () => undefined, () => undefined, {
      onSetCustomField: async (_task, _key, value) => { savedValue = value; },
    });

    root.querySelectorAll('.task-manager-table-custom-field-btn')[0].listeners.get('click')?.();
    const editor = body.querySelector('.task-manager-table-list-editor') as FakeDOMElement | null;
    assert.ok(editor, 'list editor should open');
    const findButton = (node: FakeDOMElement): FakeDOMElement | undefined => {
      for (const child of node.children) {
        if (child instanceof FakeDOMElement) {
          if (child.tagName === 'button' && child.text === 'Save') return child;
          const nested = findButton(child);
          if (nested) return nested;
        }
      }
      return undefined;
    };
    const saveButton = findButton(editor);
    assert.ok(saveButton, 'save button should render');
    const click = saveButton?.listeners.get('click');
    assert.ok(click, 'save button should be clickable');
    await click?.();
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(savedValue, 'Work');
  } finally {
    globalThis.document = originalDocument;
    globalThis.window = originalWindow;
  }
});

test('table renderer can select all visible rows from the toolbar', () => {
  const root = new FakeDOMElement('div');
  const tasks = [
    task({ key: 'task-a', normalizedText: 'Task A' }),
    task({ key: 'task-b', normalizedText: 'Task B' }),
  ];

  renderTable(root as unknown as HTMLElement, tasks, emptyQuery(), settings, async () => undefined, () => undefined);

  const selectVisible = root.querySelectorAll('.task-manager-table-toolbar-btn--selection')[0];
  assert.ok(selectVisible, 'select-visible button should render');
  assert.equal(selectVisible.text, 'Select visible');
  selectVisible.listeners.get('click')?.();

  renderTable(root as unknown as HTMLElement, tasks, emptyQuery(), settings, async () => undefined, () => undefined);
  const bulkCount = root.querySelectorAll('.task-manager-bulk-count')[0];
  assert.ok(bulkCount, 'bulk actions should appear after selecting visible rows');
  assert.equal(bulkCount.text, '2 selected');

  const clearVisible = root.querySelectorAll('.task-manager-table-toolbar-btn--selection').find((button) => button.text === 'Clear visible');
  assert.ok(clearVisible, 'toolbar button should switch to Clear visible after selection');
});

test('table renderer sorts completed and cancelled rows after active rows', () => {
  const root = new FakeDOMElement('div');
  const tableSettings = {
    supportedStates: DEFAULT_TASK_STATES,
    tableViewConfig: {
      savedFilters: [],
      customColumns: [],
      showHierarchy: false,
      visibleColumns: ['status', 'task', 'due'],
    },
  } as unknown as TaskManagerSettings;
  const tasks = [
    task({ key: 'done', normalizedText: 'Done', status: 'done', metadata: { ...createMockTask().metadata, dates: { ...createMockTask().metadata.dates, due: '2026-06-01' } } }),
    task({ key: 'cancelled', normalizedText: 'Cancelled', status: 'cancelled', metadata: { ...createMockTask().metadata, dates: { ...createMockTask().metadata.dates, due: '2026-06-02' } } }),
    task({ key: 'active', normalizedText: 'Active', status: 'todo', metadata: { ...createMockTask().metadata, dates: { ...createMockTask().metadata.dates, due: '2026-06-10' } } }),
  ];

  renderTable(root as unknown as HTMLElement, tasks, emptyQuery(), tableSettings, async () => undefined, () => undefined);

  assert.deepEqual(root.querySelectorAll('.task-manager-table-row').map((row) => row.getAttr('data-task-key')), ['active', 'done', 'cancelled']);
});

test('table renderer shift-selects a range of rows', () => {
  const root = new FakeDOMElement('div');
  const tasks = [
    task({ key: 'task-a', normalizedText: 'Task A' }),
    task({ key: 'task-b', normalizedText: 'Task B' }),
    task({ key: 'task-c', normalizedText: 'Task C' }),
  ];

  renderTable(root as unknown as HTMLElement, tasks, emptyQuery(), settings, async () => undefined, () => undefined);

  const checkboxes = findElementsByTag(root, 'input').filter((input) => input.getAttr('aria-label')?.startsWith('Select '));
  assert.ok(checkboxes.length >= 3, 'row selection checkboxes should render');
  checkboxes[0].listeners.get('click')?.({ preventDefault: () => undefined, shiftKey: false });
  checkboxes[2].listeners.get('click')?.({ preventDefault: () => undefined, shiftKey: true });

  renderTable(root as unknown as HTMLElement, tasks, emptyQuery(), settings, async () => undefined, () => undefined);
  const bulkCount = root.querySelectorAll('.task-manager-bulk-count')[0];
  assert.ok(bulkCount, 'bulk actions should appear after shift-selecting rows');
  assert.equal(bulkCount.text, '3 selected');
});

test('table renderer opens bulk tag suggestions from the full rendered task set', () => {
  const body = new FakeDOMElement('body');
  const anchor = new FakeDOMElement('button');
  const selectedTasks = [
    task({ key: 'task-a', normalizedText: 'Task A', tags: ['project'] }),
    task({ key: 'task-b', normalizedText: 'Task B', tags: ['project'] }),
  ];
  const allTasks = [
    ...selectedTasks,
    task({ key: 'task-c', normalizedText: 'Task C', tags: ['focus', 'shared'] }),
  ];
  const originalDocument = globalThis.document;
  const added: Array<{ key: string; tag: string }> = [];
  globalThis.document = {
    createElement: (tagName: string) => new FakeDOMElement(tagName),
    createTextNode: (textContent: string) => ({ text: textContent } as never),
    body,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as never;

  try {
    renderBulkTagEditor(anchor as unknown as HTMLElement, selectedTasks, allTasks, {
      onAddTag: async (task, tag) => { added.push({ key: task.key, tag }); },
    }, 'add');

    const panel = body.children[0] as FakeDOMElement | undefined;
    assert.ok(panel, 'bulk tag picker should open');
    const suggestion = findElementsByTag(panel, 'button').find((btn) => btn.text === '#focus');
    assert.ok(suggestion, 'bulk tag picker should show suggestions from non-selected tasks');
    suggestion.listeners.get('click')?.();

    assert.deepEqual(added, [
      { key: 'task-a', tag: 'focus' },
      { key: 'task-b', tag: 'focus' },
    ]);
  } finally {
    globalThis.document = originalDocument;
  }
});

test('table renderer bulk custom field editor applies one field to selected tasks', () => {
  const root = new FakeDOMElement('div');
  const body = new FakeDOMElement('body');
  const tasks = [
    task({ key: 'task-a', normalizedText: 'Task A' }),
    task({ key: 'task-b', normalizedText: 'Task B' }),
  ];
  const originalDocument = globalThis.document;
  const originalPrompt = globalThis.prompt;
  const updates: Array<{ key: string; field: string; value: string }> = [];
  globalThis.document = {
    createElement: (tagName: string) => new FakeDOMElement(tagName),
    createTextNode: (textContent: string) => ({ text: textContent } as never),
    body,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as never;
  globalThis.prompt = (() => '') as typeof prompt;

  try {
    renderTable(root as unknown as HTMLElement, tasks, emptyQuery(), settings, async () => undefined, () => undefined, {
      onRerender: () => undefined,
    });

    const selectVisible = root.querySelectorAll('.task-manager-table-toolbar-btn--selection')[0];
    selectVisible.listeners.get('click')?.();
    renderTable(root as unknown as HTMLElement, tasks, emptyQuery(), settings, async () => undefined, () => undefined, {
      onBulkSetCustomField: async (selected, field, value) => {
        for (const task of selected) updates.push({ key: task.key, field, value });
      },
    });

    const bulkButton = findElementsByTag(root, 'button').find((btn) => btn.text === 'Custom field');
    assert.ok(bulkButton, 'bulk custom field button should render');
    bulkButton.listeners.get('click')?.();

    const panel = body.children[0] as FakeDOMElement | undefined;
    assert.ok(panel, 'bulk custom field editor should open');
    const inputs = findElementsByTag(panel, 'input');
    assert.equal(inputs.length >= 2, true, 'bulk custom field editor should expose field and value inputs');
    inputs[0].value = 'owner';
    const fieldKeydown = inputs[0].listeners.get('keydown');
    assert.ok(fieldKeydown, 'field input should handle keyboard shortcuts');
    fieldKeydown?.({ key: 'Enter', preventDefault: () => undefined, isComposing: false });
    assert.ok(body.children.includes(panel), 'pressing Enter in the field input should keep the editor open');
    inputs[1].value = 'Alice';
    const valueKeydown = inputs[1].listeners.get('keydown');
    assert.ok(valueKeydown, 'value input should handle keyboard shortcuts');
    valueKeydown?.({ key: 'Enter', preventDefault: () => undefined, isComposing: false });

    assert.deepEqual(updates, [
      { key: 'task-a', field: 'owner', value: 'Alice' },
      { key: 'task-b', field: 'owner', value: 'Alice' },
    ]);
  } finally {
    globalThis.document = originalDocument;
    globalThis.prompt = originalPrompt;
  }
});

test('table bulk editor is a named dialog that retains failures and restores focus', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const anchor = harness.document.createElement('button');
  harness.document.body.appendChild(anchor);
  renderBulkTagEditor(anchor, [task({ key: 'task-a', normalizedText: 'Task A' })], [], {
    onAddTag: async () => { throw new Error('tag update failed'); },
  }, 'add');
  const panel = harness.document.body.querySelector<HTMLElement>('.task-manager-table-bulk-tag-editor');
  const input = panel?.querySelector<HTMLInputElement>('input');
  const apply = Array.from(panel?.querySelectorAll<HTMLButtonElement>('button') ?? []).find((button) => button.textContent === 'Add');
  assert.ok(panel && input && apply);
  assert.equal(panel.getAttribute('role'), 'dialog');
  assert.ok(panel.getAttribute('aria-labelledby'));
  input.value = 'project';
  apply.click();
  await Promise.resolve();
  await Promise.resolve();
  assert.match(panel.querySelector('[role="alert"]')?.textContent ?? '', /tag update failed/u);
  assert.equal(panel.isConnected, true);
  panel.dispatchEvent(new harness.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(panel.isConnected, false);
  assert.equal(harness.document.activeElement, anchor);
});

test('table renderer bulk tag editor closes on Escape', () => {
  const body = new FakeDOMElement('body');
  const anchor = new FakeDOMElement('button');
  const selectedTasks = [task({ key: 'task-a', normalizedText: 'Task A', tags: ['project'] })];
  const allTasks = selectedTasks;
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: (tagName: string) => new FakeDOMElement(tagName),
    createTextNode: (textContent: string) => ({ text: textContent } as never),
    body,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as never;

  try {
    renderBulkTagEditor(anchor as unknown as HTMLElement, selectedTasks, allTasks, {}, 'add');
    const panel = body.children[0] as FakeDOMElement | undefined;
    assert.ok(panel, 'bulk tag editor should open');
    const input = findElementsByTag(panel, 'input')[0];
    const keydown = input.listeners.get('keydown');
    assert.ok(keydown, 'bulk tag input should support keyboard shortcuts');
    keydown?.({ key: 'Escape', preventDefault: () => undefined });
    assert.equal(body.children.length, 0, 'Escape should close the bulk tag editor');
  } finally {
    globalThis.document = originalDocument;
  }
});

test('table bulk reschedule and priority use popover editors', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const root = harness.document.createElement('section');
  harness.document.body.appendChild(root);
  const tasks = [task({ key: 'bulk-a', normalizedText: 'Bulk A' }), task({ key: 'bulk-b', normalizedText: 'Bulk B' })];
  const calls: Array<{ kind: string; value: string; count: number }> = [];
  const actions: TableRenderActions = {
    onBulkReschedule: async (selected, date) => { calls.push({ kind: 'date', value: date, count: selected.length }); },
    onBulkPriority: async (selected, priority) => { calls.push({ kind: 'priority', value: priority, count: selected.length }); },
    onRerender: () => { root.empty(); renderTable(root, tasks, emptyQuery(), settings, async () => undefined, () => undefined, actions); },
  };
  renderTable(root, tasks, emptyQuery(), settings, async () => undefined, () => undefined, actions);
  root.querySelector<HTMLButtonElement>('.task-manager-table-toolbar-btn--selection')?.click();
  root.empty();
  renderTable(root, tasks, emptyQuery(), settings, async () => undefined, () => undefined, actions);

  Array.from(root.querySelectorAll<HTMLButtonElement>('.task-manager-bulk-btn')).find((button) => button.textContent === 'Reschedule')?.click();
  let panel = harness.document.body.querySelector<HTMLElement>('.task-manager-table-list-editor');
  let input = panel?.querySelector<HTMLInputElement>('input');
  assert.ok(panel && input);
  input.value = '2026-07-15';
  Array.from(panel.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Apply')?.click();
  await flushAsync();

  Array.from(root.querySelectorAll<HTMLButtonElement>('.task-manager-bulk-btn')).find((button) => button.textContent === 'Priority')?.click();
  panel = harness.document.body.querySelector<HTMLElement>('.task-manager-table-list-editor');
  const select = panel?.querySelector<HTMLSelectElement>('select');
  assert.ok(panel && select);
  select.value = 'high';
  Array.from(panel.querySelectorAll<HTMLButtonElement>('button')).find((button) => button.textContent === 'Apply')?.click();
  await flushAsync();

  assert.deepEqual(calls, [
    { kind: 'date', value: '2026-07-15', count: 2 },
    { kind: 'priority', value: 'high', count: 2 },
  ]);
});

test('table bulk runner is single-flight, survives rerender, reports success, and retains selection', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const root = harness.document.createElement('section');
  harness.document.body.appendChild(root);
  const tasks = [task({ key: 'bulk-a', normalizedText: 'Bulk A' }), task({ key: 'bulk-b', normalizedText: 'Bulk B' })];
  const gate = deferred<{ attempted: number; succeeded: number; failed: number; skipped: number }>();
  let calls = 0;
  let rerenders = 0;
  const actions: Parameters<typeof renderTable>[6] = {
    onBulkComplete: async () => { calls += 1; return gate.promise; },
    onRerender: () => { rerenders += 1; root.empty(); renderTable(root, tasks, emptyQuery(), settings, async () => undefined, () => undefined, actions); },
  };
  renderTable(root, tasks, emptyQuery(), settings, async () => undefined, () => undefined, actions);
  root.querySelector<HTMLButtonElement>('.task-manager-table-toolbar-btn--selection')?.click();
  root.empty();
  renderTable(root, tasks, emptyQuery(), settings, async () => undefined, () => undefined, actions);
  rerenders = 0;

  const complete = Array.from(root.querySelectorAll<HTMLButtonElement>('.task-manager-bulk-btn')).find((button) => button.textContent === 'Complete');
  assert.ok(complete);
  complete.click();
  complete.click();
  assert.equal(calls, 1);
  assert.equal(root.querySelector('.task-manager-table-bulk-bar')?.getAttribute('aria-busy'), 'true');
  assert.ok(Array.from(root.querySelectorAll<HTMLButtonElement>('.task-manager-table-bulk-bar button')).every((button) => button.disabled));
  assert.match(root.querySelector('[role="status"]')?.textContent ?? '', /updating 2 selected tasks/iu);

  root.empty();
  renderTable(root, tasks, emptyQuery(), settings, async () => undefined, () => undefined, actions);
  assert.equal(root.querySelector('.task-manager-table-bulk-bar')?.getAttribute('aria-busy'), 'true');
  assert.ok(Array.from(root.querySelectorAll<HTMLButtonElement>('.task-manager-table-bulk-bar button')).every((button) => button.disabled));

  gate.resolve({ attempted: 2, succeeded: 2, failed: 0, skipped: 0 });
  await gate.promise;
  await flushAsync();
  assert.equal(rerenders, 1);
  assert.match(root.querySelector('[role="status"]')?.textContent ?? '', /2 tasks updated/iu);
  assert.equal(root.querySelector('.task-manager-bulk-count')?.textContent, '2 selected');
});

test('table bulk runner retains selection and reports structured partials and thrown failures', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const tasks = [task({ key: 'partial-a', normalizedText: 'Partial A' }), task({ key: 'partial-b', normalizedText: 'Partial B' })];
  const runCase = async (callback: () => Promise<TableBulkActionResult>): Promise<HTMLElement> => {
    const root = harness.document.createElement('section');
    harness.document.body.appendChild(root);
    const actions: TableRenderActions = {
      onBulkComplete: async () => callback(),
      onRerender: () => { root.empty(); renderTable(root, tasks, emptyQuery(), settings, async () => undefined, () => undefined, actions); },
    };
    renderTable(root, tasks, emptyQuery(), settings, async () => undefined, () => undefined, actions);
    root.querySelector<HTMLButtonElement>('.task-manager-table-toolbar-btn--selection')?.click();
    root.empty();
    renderTable(root, tasks, emptyQuery(), settings, async () => undefined, () => undefined, actions);
    Array.from(root.querySelectorAll<HTMLButtonElement>('.task-manager-bulk-btn')).find((button) => button.textContent === 'Complete')?.click();
    await flushAsync();
    return root;
  };

  const partial = await runCase(async () => ({ attempted: 2, succeeded: 1, failed: 1, skipped: 0, failures: [{ taskKey: 'partial-b', message: 'blocked' }] }));
  assert.match(partial.querySelector('[role="alert"]')?.textContent ?? '', /1 succeeded, 1 failed, 0 skipped/iu);
  assert.equal(partial.querySelector('.task-manager-bulk-count')?.textContent, '2 selected');

  const rejected = await runCase(async () => { throw new Error('disk unavailable'); });
  assert.match(rejected.querySelector('[role="alert"]')?.textContent ?? '', /disk unavailable/iu);
  assert.match(rejected.querySelector('[role="alert"]')?.textContent ?? '', /review before retrying/iu);
  assert.equal(rejected.querySelector('.task-manager-bulk-count')?.textContent, '2 selected');

  const thrown = await runCase(() => { throw new Error('synchronous failure'); });
  assert.match(thrown.querySelector('[role="alert"]')?.textContent ?? '', /synchronous failure/iu);
});

test('bulk custom field apply uses the common guard and remains open on partial result', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const root = harness.document.createElement('section');
  harness.document.body.appendChild(root);
  const tasks = [task({ key: 'field-a', normalizedText: 'Field A' }), task({ key: 'field-b', normalizedText: 'Field B' })];
  let calls = 0;
  const actions: Parameters<typeof renderTable>[6] = {
    onBulkSetCustomField: async () => { calls += 1; return { attempted: 2, succeeded: 1, failed: 1, skipped: 0 }; },
    onRerender: () => { root.empty(); renderTable(root, tasks, emptyQuery(), settings, async () => undefined, () => undefined, actions); },
  };
  renderTable(root, tasks, emptyQuery(), settings, async () => undefined, () => undefined, actions);
  root.querySelector<HTMLButtonElement>('.task-manager-table-toolbar-btn--selection')?.click();
  root.empty();
  renderTable(root, tasks, emptyQuery(), settings, async () => undefined, () => undefined, actions);
  Array.from(root.querySelectorAll<HTMLButtonElement>('.task-manager-bulk-btn')).find((button) => button.textContent === 'Custom field')?.click();
  const panel = harness.document.body.querySelector<HTMLElement>('.task-manager-table-bulk-field-editor');
  const inputs = Array.from(panel?.querySelectorAll<HTMLInputElement>('input') ?? []);
  const apply = Array.from(panel?.querySelectorAll<HTMLButtonElement>('button') ?? []).find((button) => button.textContent === 'Apply');
  assert.ok(panel && inputs.length >= 2 && apply);
  inputs[0].value = 'owner';
  inputs[1].value = 'Ada';
  apply.click();
  apply.click();
  await flushAsync();
  assert.equal(calls, 1);
  assert.equal(panel.isConnected, true);
  assert.match(panel.querySelector('[role="alert"]')?.textContent ?? '', /partial result/iu);
  assert.equal(root.querySelector('.task-manager-bulk-count')?.textContent, '2 selected');
  const replacement = Array.from(root.querySelectorAll<HTMLButtonElement>('.task-manager-bulk-btn')).find((button) => button.textContent === 'Custom field');
  assert.ok(replacement);
  panel.dispatchEvent(new harness.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  assert.equal(harness.document.activeElement, replacement);
});

test('bulk tag editors use the common structured-result guard', async (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const root = harness.document.createElement('section');
  harness.document.body.appendChild(root);
  const tasks = [task({ key: 'tag-a', normalizedText: 'Tag A' }), task({ key: 'tag-b', normalizedText: 'Tag B' })];
  let calls = 0;
  const actions: Parameters<typeof renderTable>[6] = {
    onBulkAddTag: async () => { calls += 1; return { attempted: 2, succeeded: 1, failed: 1, skipped: 0 }; },
    onRerender: () => { root.empty(); renderTable(root, tasks, emptyQuery(), settings, async () => undefined, () => undefined, actions); },
  };
  renderTable(root, tasks, emptyQuery(), settings, async () => undefined, () => undefined, actions);
  root.querySelector<HTMLButtonElement>('.task-manager-table-toolbar-btn--selection')?.click();
  root.empty();
  renderTable(root, tasks, emptyQuery(), settings, async () => undefined, () => undefined, actions);
  Array.from(root.querySelectorAll<HTMLButtonElement>('.task-manager-bulk-btn')).find((button) => button.textContent === 'Add tag')?.click();
  const panel = harness.document.body.querySelector<HTMLElement>('.task-manager-table-bulk-tag-editor');
  const input = panel?.querySelector<HTMLInputElement>('input');
  const apply = Array.from(panel?.querySelectorAll<HTMLButtonElement>('button') ?? []).find((button) => button.textContent === 'Add');
  assert.ok(panel && input && apply);
  input.value = 'focus';
  apply.click();
  await flushAsync();
  assert.equal(calls, 1);
  assert.equal(panel.isConnected, true);
  assert.match(panel.querySelector('[role="alert"]')?.textContent ?? '', /partial result/iu);
  assert.match(root.querySelector('[role="alert"]')?.textContent ?? '', /1 succeeded, 1 failed/iu);
  assert.equal(root.querySelector('.task-manager-bulk-count')?.textContent, '2 selected');
});

test('task metadata parses sync exclusion aliases', () => {
  const excluded = parseMarkdownTaskLine('- [ ] Local task [exclude_from_sync:: true]', 'Tasks.md', 1);
  const inverse = parseMarkdownTaskLine('- [ ] Local task [sync:: false]', 'Tasks.md', 2);
  const normal = parseMarkdownTaskLine('- [ ] Remote task [sync:: true]', 'Tasks.md', 3);

  assert.equal(excluded?.metadata.excludeFromSync, true);
  assert.equal(inverse?.metadata.excludeFromSync, true);
  assert.equal(normal?.metadata.excludeFromSync, false);
});
