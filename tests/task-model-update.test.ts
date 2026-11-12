import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseMarkdownTaskLine,
  updateMarkdownTaskCheckboxInContent,
} from '../src/task-model';
import { DEFAULT_TASK_STATES } from '../src/types';

test('task model stale fallback updates the only matching rendered line', () => {
  const task = parseMarkdownTaskLine('- [ ] Duplicate task', 'Tasks.md', 3);
  assert.ok(task);

  const result = updateMarkdownTaskCheckboxInContent(
    '- [ ] Other task\n- [ ] Duplicate task\n',
    task,
    'x',
    DEFAULT_TASK_STATES,
    { allowStaleStatus: true },
  );

  assert.equal(result.content, '- [ ] Other task\n- [x] Duplicate task\n');
  assert.equal(result.updatedTask.lineNumber, 2);
});

test('task model stale fallback refuses ambiguous duplicate rendered lines', () => {
  const task = parseMarkdownTaskLine('- [ ] Duplicate task', 'Tasks.md', 3);
  assert.ok(task);

  assert.throws(
    () => updateMarkdownTaskCheckboxInContent(
      '- [ ] Duplicate task\n- [ ] Duplicate task\n',
      task,
      'x',
      DEFAULT_TASK_STATES,
      { allowStaleStatus: true },
    ),
    /matches multiple lines/u,
  );
});
