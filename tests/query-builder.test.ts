import test from 'node:test';
import assert from 'node:assert/strict';
import type { App } from 'obsidian';
import { QUERY_BUILDER_FILTER_TYPES, QueryBuilder, QueryBuilderModal } from '../src/query-builder';
import { parseTaskQuery } from '../src/task-query';
import { QueryExplainer, QueryLinter } from '../src/query-polish';
import { installDomHarness } from './dom-harness';

test('QueryBuilder generates parseable query with filters, sort, view, and limit', () => {
  const builder = new QueryBuilder({} as any);
  builder.addFilter('not-done', {});
  builder.addFilter('due-before', { value: '2026-06-30' });
  builder.addSort('due');
  builder.setViewMode('table');
  builder.setLimit(10);
  const query = builder.generateQuery();
  const parsed = parseTaskQuery(query);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.viewMode, 'table');
  assert.equal(parsed.limit, 10);
});

test('QueryBuilder ignores non-integer limits that would generate unparseable DSL', () => {
  const builder = new QueryBuilder({} as any);
  builder.setLimit(2.5);
  builder.addGroup('status', 3.5);

  const query = builder.generateQuery();
  assert.equal(query, 'group by status');

  const parsed = parseTaskQuery(query);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.limit, undefined);
  assert.equal(parsed.groups[0]?.limit, undefined);
});

test('QueryBuilder getState snapshots cannot mutate builder internals', () => {
  const builder = new QueryBuilder({} as any);
  builder.addFilter('tag', { value: 'work' });
  builder.addSort('due');
  builder.addGroup('status', 2);
  builder.addLayoutDirective('show tree');
  builder.setLimit(5);

  const state = builder.getState();
  state.filters.push({ type: 'done', config: {} });
  state.filters[0].config.value = 'mutated';
  state.sorts[0].field = 'priority';
  state.groups[0].limit = 99;
  state.layout.push('hide task count');
  state.limit = 1;

  assert.equal(
    builder.generateQuery(),
    'tag includes #work\nsort by due\ngroup by status limit 2\nshow tree\nlimit 5',
  );
});

test('QueryBuilder ignores invalid removal indexes', () => {
  const builder = new QueryBuilder({} as any);
  builder.addFilter('tag', { value: 'work' });
  builder.addSort('due');
  builder.addGroup('status', 2);

  builder.removeFilter(-1);
  builder.removeSort(-1);
  builder.removeGroup(-1);
  assert.equal(builder.generateQuery(), 'tag includes #work\nsort by due\ngroup by status limit 2');

  builder.removeFilter(1.5);
  builder.removeSort(1.5);
  builder.removeGroup(1.5);
  builder.removeFilter(99);
  builder.removeSort(99);
  builder.removeGroup(99);
  assert.equal(builder.generateQuery(), 'tag includes #work\nsort by due\ngroup by status limit 2');
});

test('QueryBuilder tag filter generates parseable tag includes syntax', () => {
  const builder = new QueryBuilder({} as any);
  builder.addFilter('tag', { value: 'project' });
  const query = builder.generateQuery();
  // Must be "tag includes #project", not the broken "tag #project" form
  assert.ok(query.includes('tag includes #project'), `Expected 'tag includes #project' in query, got: ${query}`);
  // The generated query must parse without errors
  assert.doesNotThrow(() => parseTaskQuery(query), 'tag filter query must parse without throwing');
  const parsed = parseTaskQuery(query);
  assert.equal(parsed.errors.length, 0);
});

test('QueryBuilder tag filter with hash prefix strips leading hash', () => {
  const builder = new QueryBuilder({} as any);
  builder.addFilter('tag', { value: '#area' });
  const query = builder.generateQuery();
  // Leading # in value must be stripped (no double ##)
  assert.ok(query.includes('tag includes #area'), `Expected 'tag includes #area' in query, got: ${query}`);
  assert.doesNotThrow(() => parseTaskQuery(query));
});

test('QueryBuilder status filter generates parseable status.type is syntax', () => {
  const builder = new QueryBuilder({} as any);
  builder.addFilter('status', { value: 'todo' });
  const query = builder.generateQuery();
  assert.ok(query.includes('status.type is todo'), `Expected 'status.type is todo' in query, got: ${query}`);
  assert.doesNotThrow(() => parseTaskQuery(query), 'status filter query must parse without throwing');
  const parsed = parseTaskQuery(query);
  assert.equal(parsed.errors.length, 0);
});

test('QueryBuilder status filter defaults to todo when no value is configured', () => {
  const builder = new QueryBuilder({} as any);
  builder.addFilter('status', {});
  const query = builder.generateQuery();
  assert.ok(query.includes('status.type is todo'), `Expected missing status value to default to todo, got: ${query}`);
  const parsed = parseTaskQuery(query);
  assert.equal(parsed.errors.length, 0);
});

test('QueryBuilder value filters generate parseable defaults when no value is configured', () => {
  const filters = ['priority', 'tag', 'path', 'due-before', 'due-after', 'due-on', 'description'];
  for (const filter of filters) {
    const builder = new QueryBuilder({} as any);
    builder.addFilter(filter, {});
    const query = builder.generateQuery();
    assert.doesNotThrow(() => parseTaskQuery(query), `${filter} default query must parse: ${query}`);
    const parsed = parseTaskQuery(query);
    assert.equal(parsed.errors.length, 0, `${filter} default query must have no parse errors: ${query}`);
    assert.ok(!query.includes('undefined'), `${filter} default query must not include undefined: ${query}`);
  }
});

test('QueryBuilder exposes due-after in selectable filter types', () => {
  assert.ok(QUERY_BUILDER_FILTER_TYPES.includes('due-after'), 'due-after must be available from the modal filter dropdown');
});

test('QueryBuilder exposes and formats no-due filter', () => {
  assert.ok(QUERY_BUILDER_FILTER_TYPES.includes('no-due'), 'no-due must be available from the modal filter dropdown');

  const builder = new QueryBuilder({} as any);
  builder.addFilter('no-due', {});
  const query = builder.generateQuery();
  assert.equal(query, 'no due date');
  const parsed = parseTaskQuery(query);
  assert.equal(parsed.errors.length, 0);
});

test('QueryBuilder recurring filter generates parseable is recurring syntax', () => {
  const builder = new QueryBuilder({} as any);
  builder.addFilter('recurring', {});
  const query = builder.generateQuery();
  assert.ok(query.includes('is recurring'), `Expected 'is recurring' in query, got: ${query}`);
  assert.doesNotThrow(() => parseTaskQuery(query), 'recurring filter query must parse without throwing');
  const parsed = parseTaskQuery(query);
  assert.equal(parsed.errors.length, 0);
});

test('QueryBuilderModal updatePreview refreshes the rendered preview text', () => {
  const modal = new QueryBuilderModal({} as any);
  let renderedText = '';

  (modal as any).previewCodeEl = {
    setText(value: string) {
      renderedText = value;
    },
  };

  ((modal as any).builder as QueryBuilder).addFilter('not-done', {});
  (modal as any).updatePreview();

  assert.equal(renderedText, 'not done');
});

test('QueryBuilderModal preserves shell identity and restores deterministic focus for add/remove', (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const content = harness.document.createElement('div');
  harness.document.body.appendChild(content);
  const modal = new QueryBuilderModal({} as unknown as App);
  (modal as unknown as { contentEl: HTMLElement }).contentEl = content;
  modal.onOpen();

  const title = content.querySelector('h2');
  const preview = content.querySelector('.query-preview');
  const filterList = content.querySelector<HTMLElement>('.query-builder-filter-list');
  const status = content.querySelector<HTMLElement>('.query-builder-status');
  const addFilter = content.querySelector<HTMLSelectElement>('select');
  assert.ok(title && preview && filterList && status && addFilter);
  let announcements = 0;
  const observableStatus = status as HTMLElement & { setText(value: string): void };
  const setStatus = observableStatus.setText.bind(status);
  observableStatus.setText = (value: string) => { announcements += 1; setStatus(value); };
  const add = (type: string): void => {
    addFilter.value = type;
    addFilter.dispatchEvent(new harness.window.Event('change', { bubbles: true }));
  };

  add('tag');
  add('due-before');
  add('description');
  assert.equal(content.querySelector('h2'), title);
  assert.equal(content.querySelector('.query-preview'), preview);
  assert.equal(content.querySelector('.query-builder-filter-list'), filterList);
  let removes = Array.from(filterList.querySelectorAll<HTMLButtonElement>('.query-builder-remove'));
  assert.equal(harness.document.activeElement, removes[2]);
  assert.deepEqual(removes.map((button) => button.getAttribute('aria-label')), [
    'Remove filter: tag includes #todo',
    'Remove filter: due before today',
    'Remove filter: description includes task',
  ]);
  assert.equal(announcements, 3);

  removes[1].click();
  removes = Array.from(filterList.querySelectorAll<HTMLButtonElement>('.query-builder-remove'));
  assert.equal(harness.document.activeElement, removes[1], 'middle removal focuses the next clause');
  assert.equal(removes[1].getAttribute('aria-label'), 'Remove filter: description includes task');
  removes[1].click();
  removes = Array.from(filterList.querySelectorAll<HTMLButtonElement>('.query-builder-remove'));
  assert.equal(harness.document.activeElement, removes[0], 'last removal focuses the previous clause');
  removes[0].click();
  assert.equal(harness.document.activeElement, addFilter, 'empty-list removal returns focus to Add filter');
  assert.equal(announcements, 6);
  assert.equal(status.getAttribute('aria-live'), 'polite');
});

test('QueryBuilderModal labels sort and group removal controls by their clauses', (context) => {
  const harness = installDomHarness();
  context.after(harness.cleanup);
  const content = harness.document.createElement('div');
  harness.document.body.appendChild(content);
  const modal = new QueryBuilderModal({} as unknown as App);
  const internals = modal as unknown as { builder: QueryBuilder; contentEl: HTMLElement };
  internals.builder.addSort('due', true);
  internals.builder.addGroup('status', 2);
  internals.contentEl = content;
  modal.onOpen();
  assert.ok(content.querySelector('button[aria-label="Remove sort: due reverse"]'));
  assert.ok(content.querySelector('button[aria-label="Remove group: status limit 2"]'));
  for (const id of ['add-sort', 'add-group']) {
    const select = content.querySelector<HTMLSelectElement>(`select[id$="${id}"]`);
    assert.ok(select);
    select.dispatchEvent(new harness.window.Event('change', { bubbles: true }));
  }
  const addedRemoves = Array.from(content.querySelectorAll<HTMLButtonElement>('.query-builder-remove'));
  addedRemoves.at(-1)?.click();
  modal.onClose();
  assert.equal(content.children.length, 0);
});

test('QueryLinter and QueryExplainer cover generated query text', () => {
  const query = 'not done\nsort by due';
  const lint = new QueryLinter().lint(query);
  assert.equal(lint.errors.length, 0);
  const explanation = new QueryExplainer().explain(query);
  assert.ok(explanation.length > 0);
});
