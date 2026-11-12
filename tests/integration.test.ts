import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseMarkdownTaskLine } from '../src/task-model';
import { filterTasks, parseTaskQuery } from '../src/task-query';
import { QueryBuilder } from '../src/query-builder';
import { QueryLinter } from '../src/query-polish';
import { DEFAULT_SETTINGS } from '../src/types';

const fixturesPath = join(process.cwd(), 'tests', 'fixtures');

test('integration: mixed-format fixture contains expected task conventions', () => {
  const content = readFileSync(join(fixturesPath, 'vault-mixed-formats', 'mixed.md'), 'utf8');
  assert.match(content, /📅 2026-06-15/);
  assert.match(content, /\(@2026-06-16 09:00\)/);
  assert.match(content, /\[priority:: high\]/);
  assert.match(content, /\[\/\] In progress task/);
  assert.match(content, /^task: true/m);
});

test('integration: scanner-style parse and query filter round-trip', () => {
  const lines = readFileSync(join(fixturesPath, 'vault-mixed-formats', 'mixed.md'), 'utf8').split(/\r?\n/u);
  const tasks = lines
    .map((line, index) => parseMarkdownTaskLine(line, 'fixtures/vault-mixed-formats/mixed.md', index + 1, DEFAULT_SETTINGS.supportedStates, '', false, DEFAULT_SETTINGS.customFieldDefinitions))
    .filter((task): task is NonNullable<typeof task> => Boolean(task));
  assert.ok(tasks.length >= 5);
  const query = parseTaskQuery('not done');
  const filtered = filterTasks(tasks, query, { states: DEFAULT_SETTINGS.supportedStates });
  assert.ok(filtered.length >= 4);
  assert.equal(filtered.some((task) => task.status === 'done'), false);
});

test('integration: QueryBuilder output parses and filters', () => {
  const builder = new QueryBuilder({} as never);
  builder.addFilter('not-done', {});
  builder.addFilter('due-before', { value: '2026-06-30' });
  builder.addSort('priority');
  const queryText = builder.generateQuery();
  const parsed = parseTaskQuery(queryText);
  assert.equal(parsed.errors.length, 0);
  assert.match(queryText, /not done/);
  assert.match(queryText, /due before 2026-06-30/);
});

test('integration: QueryLinter flags a known-bad query and accepts a known-good query', () => {
  const linter = new QueryLinter();
  const good = linter.lint('not done\nsort by due');
  assert.equal(good.errors.length, 0);
  const bad = linter.lint('status == done');
  assert.ok(bad.warnings.length + bad.suggestions.length + bad.errors.length > 0);
});
