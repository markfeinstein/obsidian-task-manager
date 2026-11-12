import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkdownTaskLine } from '../src/task-model';
import { TaskScanner, buildTaskNoteFrontmatter, serializeTaskNoteFrontmatter } from '../src/task-scanner';
import { scanFileAsTask } from '../src/task-scanner-ext';
import { filterTasks, parseTaskQuery } from '../src/task-query';
import { normalizeTaskManagerSettings } from '../src/types';
import type { CustomFieldDefinition } from '../src/custom-fields-sync';
import {
  mergeCustomFields,
  parseCustomFieldsFromFrontmatter,
  parseCustomFieldsFromMarkdown,
  validateCustomField,
} from '../src/custom-fields-sync';

const fieldDefs: CustomFieldDefinition[] = [
  { key: 'energy', name: 'Energy', type: 'select', options: ['low', 'medium', 'high'], syncMode: 'read', searchable: true },
  { key: 'score', name: 'Score', type: 'number', syncMode: 'read', searchable: true },
  { key: 'client', name: 'Client', type: 'text', frontmatterKey: 'customer', syncMode: 'read', searchable: true },
  { key: 'areas', name: 'Areas', type: 'tags', syncMode: 'read', searchable: true },
];

function fakeFile(path: string): any {
  const name = path.split('/').pop() ?? path;
  return { path, extension: 'md', basename: name.replace(/\.md$/u, ''), parent: { path: path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '', name: 'root' } };
}

function fakeApp(content: string, frontmatter: Record<string, unknown> = {}): any {
  return {
    vault: { read: async () => content },
    metadataCache: { getFileCache: () => ({ frontmatter }) },
  };
}

test('custom fields default to empty and normalize invalid definitions', () => {
  const settings = normalizeTaskManagerSettings({
    customFieldDefinitions: [
      { key: 'energy', name: '', type: 'select', options: ['high', 'high', 'low'], syncMode: 'bidirectional' },
      { key: 'bad key', name: 'Bad', type: 'text' },
      { key: 'energy-level', name: 'Hyphenated', type: 'text' },
      { key: 'energy', name: 'Duplicate', type: 'text' },
      { key: 'score', name: 'Score', type: 'number', syncMode: 'not-real' },
    ] as any,
  });

  assert.deepEqual(settings.customFieldDefinitions.map((field) => field.key), ['energy', 'score']);
  assert.equal(settings.customFieldDefinitions[0].name, 'energy');
  assert.deepEqual(settings.customFieldDefinitions[0].options, ['high', 'low']);
  assert.equal(settings.customFieldDefinitions[0].syncMode, 'bidirectional');
  assert.equal(settings.customFieldDefinitions[1].syncMode, 'read');
  assert.deepEqual(normalizeTaskManagerSettings({}).customFieldDefinitions, []);
});

test('parseMarkdownTaskLine attaches configured custom fields from Dataview inline fields', () => {
  const task = parseMarkdownTaskLine(
    '- [ ] Tune workout [energy:: high] [score:: 7] [areas:: #health, #work]',
    'Daily.md',
    1,
    undefined,
    undefined,
    false,
    fieldDefs,
  );

  assert.ok(task);
  assert.equal(task.metadata.customFields?.energy?.value, 'high');
  assert.equal(task.metadata.customFields?.energy?.source, 'markdown');
  assert.equal(task.metadata.customFields?.score?.value, 7);
  assert.deepEqual(task.metadata.customFields?.areas?.value, ['#health', '#work']);
});

test('custom fields with digits are stripped from normalized task text', () => {
  const defs: CustomFieldDefinition[] = [{ key: 'field1', name: 'Field 1', type: 'text', syncMode: 'read' }];
  const task = parseMarkdownTaskLine(
    '- [ ] Task with numbered field [field1:: alpha]',
    'Daily.md',
    1,
    undefined,
    undefined,
    false,
    defs,
  );

  assert.ok(task);
  assert.equal(task.metadata.customFields?.field1?.value, 'alpha');
  assert.equal(task.normalizedText, 'Task with numbered field');

  const recurring = parseMarkdownTaskLine(
    '- [ ] Recurring with numbered field 🔁 every day [field1:: alpha]',
    'Daily.md',
    2,
    undefined,
    undefined,
    false,
    defs,
  );

  assert.ok(recurring);
  assert.equal(recurring.metadata.recurrence, 'every day');
  assert.equal(recurring.metadata.customFields?.field1?.value, 'alpha');
});

test('custom Dataview fields preserve wikilink values', () => {
  const defs: CustomFieldDefinition[] = [{ key: 'related', name: 'Related', type: 'text', syncMode: 'read' }];
  const task = parseMarkdownTaskLine(
    '- [ ] Review schema [related:: [[database-schema]]]',
    'Daily.md',
    1,
    undefined,
    undefined,
    false,
    defs,
  );

  assert.ok(task);
  assert.equal(task.metadata.customFields?.related?.value, '[[database-schema]]');
  assert.equal(task.normalizedText, 'Review schema');
});

test('unconfigured Dataview fields are ignored as custom fields', () => {
  const task = parseMarkdownTaskLine('- [ ] Task [unknown:: value]', 'A.md', 1, undefined, undefined, false, fieldDefs);
  assert.ok(task);
  assert.equal(task.metadata.customFields?.unknown, undefined);
});

test('invalid custom number fields do not parse partial numeric prefixes', () => {
  const markdownFields = parseCustomFieldsFromMarkdown('- [ ] Task [score:: 12abc]', fieldDefs);
  const frontmatterFields = parseCustomFieldsFromFrontmatter({ score: '12abc' }, fieldDefs);

  assert.equal(markdownFields.score?.value, undefined);
  assert.equal(frontmatterFields.score?.value, undefined);
});

test('invalid custom date fields reject impossible ISO dates', () => {
  const defs: CustomFieldDefinition[] = [{ key: 'review', name: 'Review', type: 'date', syncMode: 'read' }];
  const markdownFields = parseCustomFieldsFromMarkdown('- [ ] Task [review:: 2025-02-29]', defs);
  const frontmatterFields = parseCustomFieldsFromFrontmatter({ review: '2025-04-31' }, defs);

  assert.equal(markdownFields.review?.value, undefined);
  assert.equal(frontmatterFields.review?.value, undefined);
  assert.equal(validateCustomField('2024-02-29', defs[0]), true);
  assert.equal(validateCustomField('2025-02-29', defs[0]), false);
});

test('custom select fields reject values outside configured options', () => {
  const defs: CustomFieldDefinition[] = [{ key: 'energy', name: 'Energy', type: 'select', options: ['low', 'medium', 'high'], syncMode: 'read' }];
  const markdownFields = parseCustomFieldsFromMarkdown('- [ ] Task [energy:: extreme]', defs);
  const frontmatterFields = parseCustomFieldsFromFrontmatter({ energy: 'extreme' }, defs);

  assert.equal(markdownFields.energy?.value, undefined);
  assert.equal(frontmatterFields.energy?.value, undefined);
  assert.equal(validateCustomField('medium', defs[0]), true);
  assert.equal(validateCustomField('extreme', defs[0]), false);
});

test('TaskScanner merges custom fields from file frontmatter according to read sync mode', async () => {
  const file = fakeFile('Projects/Alpha.md');
  const app = fakeApp('---\nenergy: high\nscore: 5\ncustomer: Acme\n---\n- [ ] Build feature [energy:: low] [score:: 1]', { energy: 'stale', score: 1, customer: 'Stale' });
  const scanner = new TaskScanner(
    app,
    undefined,
    undefined,
    () => ({
      ...normalizeTaskManagerSettings({ customFieldDefinitions: fieldDefs }),
      fileDefaultsEnabled: true,
      fileDefaultsPropertyPrefix: 'task_',
    }),
  );

  const tasks = await scanner.scanFile(file);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].metadata.customFields?.energy?.value, 'high');
  assert.equal(tasks[0].metadata.customFields?.energy?.source, 'frontmatter');
  assert.equal(tasks[0].metadata.customFields?.score?.value, 5);
  assert.equal(tasks[0].metadata.customFields?.client?.value, 'Acme');
});

test('frontmatter sync mode none preserves markdown custom field value', async () => {
  const defs: CustomFieldDefinition[] = [{ key: 'energy', name: 'Energy', type: 'text', syncMode: 'none' }];
  const file = fakeFile('Projects/Alpha.md');
  const app = fakeApp('- [ ] Build feature [energy:: low]', { energy: 'high' });
  const scanner = new TaskScanner(app, undefined, undefined, () => ({ ...normalizeTaskManagerSettings({ customFieldDefinitions: defs }), fileDefaultsEnabled: true }));
  const [task] = await scanner.scanFile(file);
  assert.equal(task.metadata.customFields?.energy?.value, 'low');
  assert.equal(task.metadata.customFields?.energy?.source, 'markdown');
});

test('scanFileAsTask parses configured custom fields from task-note frontmatter', () => {
  const file = fakeFile('Tasks/Call Bob.md');
  const app = fakeApp('', { task: true, description: 'Call Bob', energy: 'medium', score: '3', customer: 'Acme' });

  const task = scanFileAsTask(file, app, undefined, fieldDefs);

  assert.ok(task);
  assert.equal(task.metadata.customFields?.energy?.value, 'medium');
  assert.equal(task.metadata.customFields?.score?.value, 3);
  assert.equal(task.metadata.customFields?.client?.value, 'Acme');
});

test('scanFileAsTask honors syncMode none and write for task-note frontmatter fields', () => {
  const defs: CustomFieldDefinition[] = [
    { key: 'energy', name: 'Energy', type: 'text', syncMode: 'none' },
    { key: 'score', name: 'Score', type: 'number', syncMode: 'write' },
    { key: 'client', name: 'Client', type: 'text', frontmatterKey: 'customer', syncMode: 'read' },
  ];
  const file = fakeFile('Tasks/Call Bob.md');
  const app = fakeApp('', { task: true, description: 'Call Bob', energy: 'medium', score: '3', customer: 'Acme' });

  const task = scanFileAsTask(file, app, undefined, defs);

  assert.ok(task);
  assert.equal(task.metadata.customFields?.energy, undefined);
  assert.equal(task.metadata.customFields?.score, undefined);
  assert.equal(task.metadata.customFields?.client?.value, 'Acme');
  assert.equal(task.metadata.customFields?.client?.source, 'frontmatter');
});

test('buildTaskNoteFrontmatter preserves write-synced custom fields for promoted task notes', () => {
  const defs: CustomFieldDefinition[] = [
    { key: 'energy', name: 'Energy', type: 'select', options: ['low', 'medium', 'high'], syncMode: 'write' },
    { key: 'score', name: 'Score', type: 'number', syncMode: 'bidirectional' },
    { key: 'client', name: 'Client', type: 'text', frontmatterKey: 'customer', syncMode: 'bidirectional' },
    { key: 'areas', name: 'Areas', type: 'tags', syncMode: 'write' },
    { key: 'private', name: 'Private', type: 'text', syncMode: 'none' },
  ];
  const task = parseMarkdownTaskLine(
    '- [ ] Prepare quote [energy:: high] [score:: 5] [client:: Acme] [areas:: #ops, #sales] [private:: keep local]',
    'Sales.md',
    1,
    undefined,
    undefined,
    false,
    defs,
  );

  assert.ok(task);

  const frontmatter = buildTaskNoteFrontmatter(task, 'task: true', 'Sales.md', undefined, defs);
  assert.equal(frontmatter.energy, 'high');
  assert.equal(frontmatter.score, 5);
  assert.equal(frontmatter.customer, 'Acme');
  assert.deepEqual(frontmatter.areas, ['#ops', '#sales']);
  assert.equal(frontmatter.private, undefined);

  const yaml = serializeTaskNoteFrontmatter(frontmatter);
  assert.match(yaml, /energy: high/u);
  assert.match(yaml, /score: 5/u);
  assert.match(yaml, /customer: Acme/u);
  assert.match(yaml, /areas: \["#ops", "#sales"\]/u);
});

test('filter by function can read flattened task.customFields values', () => {
  const high = parseMarkdownTaskLine('- [ ] High energy [energy:: high] [score:: 8]', 'A.md', 1, undefined, undefined, false, fieldDefs)!;
  const low = parseMarkdownTaskLine('- [ ] Low energy [energy:: low] [score:: 2]', 'A.md', 2, undefined, undefined, false, fieldDefs)!;
  const query = parseTaskQuery('filter by function task.customFields.energy === "high" && task.customFields.score > 5', { enableQueryDsl: true });

  const results = filterTasks([high, low], query, { enableQueryDsl: true });

  assert.deepEqual(results.map((task) => task.normalizedText), ['High energy']);
});

test('mergeCustomFields: null frontmatter value does not override valid markdown value (read mode)', () => {
  const defs: CustomFieldDefinition[] = [
    { key: 'client', name: 'Client', type: 'text', syncMode: 'read' },
    { key: 'score', name: 'Score', type: 'number', syncMode: 'bidirectional' },
  ];
  // Markdown has valid values; frontmatter has null for both (YAML `key:` without a value)
  const markdownFields = parseCustomFieldsFromMarkdown(
    '- [ ] Task [client:: Acme Corp] [score:: 7]',
    defs,
  );
  const frontmatterFields = parseCustomFieldsFromFrontmatter(
    { client: null, score: null },
    defs,
  );

  const merged = mergeCustomFields(markdownFields, frontmatterFields, defs);

  // Null frontmatter entries must NOT clobber valid markdown values
  assert.equal(merged.client?.value, 'Acme Corp', 'client value should be preserved from markdown');
  assert.equal(merged.client?.source, 'markdown');
  assert.equal(merged.score?.value, 7, 'score value should be preserved from markdown');
  assert.equal(merged.score?.source, 'markdown');
});

test('mergeCustomFields: defined frontmatter value still overrides markdown value (read mode)', () => {
  const defs: CustomFieldDefinition[] = [
    { key: 'client', name: 'Client', type: 'text', syncMode: 'read' },
  ];
  const markdownFields = parseCustomFieldsFromMarkdown('- [ ] Task [client:: Draft]', defs);
  const frontmatterFields = parseCustomFieldsFromFrontmatter({ client: 'Official' }, defs);

  const merged = mergeCustomFields(markdownFields, frontmatterFields, defs);

  // Non-null frontmatter value should still override markdown
  assert.equal(merged.client?.value, 'Official', 'frontmatter value should override markdown');
  assert.equal(merged.client?.source, 'frontmatter');
});
