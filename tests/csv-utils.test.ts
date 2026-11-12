import test from 'node:test';
import assert from 'node:assert/strict';
import { encodeCsvCell } from '../src/csv-utils';
import { TaskQueryRenderer } from '../src/query-renderer';
import { TaskScanner } from '../src/task-scanner';

test('encodeCsvCell neutralizes spreadsheet formula prefixes', () => {
  assert.equal(encodeCsvCell('=1+1'), "'=1+1");
  assert.equal(encodeCsvCell('  +SUM(A1:A2)'), "'  +SUM(A1:A2)");
  assert.equal(encodeCsvCell('-10'), "'-10");
  assert.equal(encodeCsvCell('@cmd'), "'@cmd");
  assert.equal(encodeCsvCell('@cmd,now'), '"\'@cmd,now"');
});

test('query CSV export neutralizes formula-like task descriptions', () => {
  const scanner = new TaskScanner({} as never);
  const task = scanner.parseTaskLine('- [ ] =HYPERLINK("https://example.test")', 'Tasks.md', 1);
  assert.ok(task);
  const renderer = Object.create(TaskQueryRenderer.prototype) as { queryResultsToCsv(tasks: readonly typeof task[]): string };

  const csv = renderer.queryResultsToCsv([task]);

  assert.ok(csv.includes('"\'=HYPERLINK(""https://example.test"")"'));
});
