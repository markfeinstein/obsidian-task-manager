import test from 'node:test';
import assert from 'node:assert/strict';
import { QueryLinter } from '../src/query-polish';
import { TaskQueryRenderer } from '../src/query-renderer';
import { parseTaskQuery } from '../src/task-query';
import { TaskScanner, type ParsedTask } from '../src/task-scanner';
import { DEFAULT_SETTINGS } from '../src/types';
import { installDomHarness } from './dom-harness';

test('layout lint accepts supported show/hide grammar without masking invalid layouts', () => {
  const linter = new QueryLinter();
  for (const directive of [
    'show stats', 'hide stats', 'SHOW STATS', 'Hide Task Count',
    'show tree filtered', 'hide tags', 'show progress',
    'show future occurrences', 'shows future occurrences',
    'hide future occurrences', 'hides future occurrences',
  ]) {
    const source = `not done\n${directive}\nlimit 10`;
    assert.deepEqual(parseTaskQuery(source).errors, [], directive);
    const lint = linter.lint(source);
    assert.equal(lint.isValid, true, directive);
    assert.deepEqual(lint.warnings.filter((warning) => warning.code.startsWith('UNKNOWN_KEYWORD')), [], directive);
  }
  assert.ok(parseTaskQuery('show unsupported-layout').errors.length > 0);
});

test('standards DOM: plain lists mount before bulk controls are moved and render stats', async (context) => {
  const dom = installDomHarness();
  context.after(dom.cleanup);
  const app = {
    vault: { getMarkdownFiles: () => [], getAbstractFileByPath: () => null },
    metadataCache: { getFileCache: () => null, fileToLinktext: () => '' },
    workspace: { getLeaf: () => ({ openFile: async () => undefined }), openLinkText: async () => undefined },
  };
  const scanner = new TaskScanner(app as never);
  const tasks = ['- [ ] Overdue task 📅 2000-01-01', '- [ ] Undated task']
    .map((line, index) => scanner.parseTaskLine(line, 'Tasks.md', index + 1))
    .filter((task): task is ParsedTask => task !== null);
  assert.equal(tasks.length, 2);
  const renderer = new TaskQueryRenderer(app as never, scanner, () => DEFAULT_SETTINGS,
    undefined, undefined, undefined, undefined, undefined, undefined, undefined, async () => tasks);
  const root = dom.document.createElement('section');
  dom.document.body.appendChild(root);
  await renderer.render('not done\nsort by due\nshow stats\nlimit 10', root, { sourcePath: 'Query.md' } as never);
  assert.equal(root.querySelector('.task-manager-query-error'), null, root.textContent ?? '');
  assert.equal(root.querySelectorAll('.task-manager-query-item').length, 2);
  const bulk = root.querySelector<HTMLElement>('.task-manager-bulk-bar');
  const list = root.querySelector('.task-manager-query-list');
  assert.ok(bulk && list);
  assert.equal(bulk.nextElementSibling, list);
  assert.equal(root.querySelectorAll('.task-manager-query-stats-bar').length, 1);
  assert.match(root.querySelector('.task-manager-query-stats-chip--overdue')?.textContent ?? '', /1/u);
  const selection = root.querySelector<HTMLInputElement>('.task-manager-select-checkbox');
  assert.ok(selection);
  selection.checked = true;
  selection.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  assert.notEqual(bulk.style.display, 'none');
  assert.match(bulk.textContent ?? '', /1 selected/u);

  await renderer.render('not done\nhide stats\nlimit 10', root, { sourcePath: 'Query.md' } as never);
  assert.equal(root.querySelector('.task-manager-query-error'), null, root.textContent ?? '');
  assert.equal(root.querySelectorAll('.task-manager-query-item').length, 2);
  assert.equal(root.querySelector('.task-manager-query-stats-bar'), null);
});
