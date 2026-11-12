import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseMarkdownTaskLine } from '../src/task-model';
import { parseTaskQuery } from '../src/task-query';

function taskListBlocks(markdown: string): string[] {
  return Array.from(markdown.matchAll(/```task-list\n([\s\S]*?)\n```/gu), (match) => match[1].trim());
}

function markdownTaskExamples(markdown: string): string[] {
  return markdown.split(/\r?\n/u).filter((line) => /^- \[[ x!/?><-]\]\s/u.test(line));
}

for (const document of ['README.md', 'docs/tutorials/GETTING_STARTED.md']) {
  test(`${document} task/query examples execute through production parsers`, () => {
    const markdown = readFileSync(document, 'utf8');
    const taskLines = markdownTaskExamples(markdown);
    const queries = taskListBlocks(markdown);
    assert.equal(taskLines.length > 0, true, 'expected at least one task example');
    assert.equal(queries.length > 0, true, 'expected at least one task-list example');

    for (const [index, line] of taskLines.entries()) {
      assert.ok(parseMarkdownTaskLine(line, document, index + 1), line);
    }
    for (const querySource of queries) {
      const query = parseTaskQuery(querySource, { enableQueryDsl: true, enableDslExpressions: false });
      assert.deepEqual(query.errors, [], querySource);
    }
  });
}

test('Query language task-list examples and multi-sort syntax execute through production parsers', () => {
  const markdown = readFileSync('docs/tutorials/QUERY_LANGUAGE.md', 'utf8');
  const queries = taskListBlocks(markdown);
  assert.equal(queries.length > 0, true);
  for (const querySource of queries) {
    const query = parseTaskQuery(querySource, { enableQueryDsl: true, enableDslExpressions: true });
    assert.deepEqual(query.errors, [], querySource);
  }
  const multiSort = parseTaskQuery('sort by status due');
  assert.deepEqual(multiSort.sort.map((criterion) => [criterion.field, criterion.reverse]), [['status', false], ['due', false]]);
  const reversed = parseTaskQuery('sort by priority, due reverse');
  assert.deepEqual(reversed.sort.map((criterion) => [criterion.field, criterion.reverse]), [['priority', true], ['due', true]]);
  assert.doesNotMatch(markdown, /sort by .*then by|view:\s*[^\n]*\|/u);
});

test('Meta Bind featured example uses complete supported instructions, not JavaScript templating', () => {
  const markdown = readFileSync('docs/meta-bind.md', 'utf8');
  assert.doesNotMatch(markdown, /query\.file\.property\([^\n]+\)\s*\?/u);
  assert.match(markdown, /TQ_extra_instructions: "path includes Projects"/u);
  const query = parseTaskQuery('not done\nsort by smart\nlimit 30', {
    enableQueryDsl: true,
    enableDslExpressions: false,
  });
  assert.deepEqual(query.errors, []);
});
