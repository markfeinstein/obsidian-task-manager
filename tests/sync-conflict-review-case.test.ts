import test from 'node:test';
import assert from 'node:assert/strict';
import { isReviewableService } from '../src/sync-conflict-review';

test('isReviewableService: matches case-insensitively', () => {
  assert.equal(isReviewableService('Todoist', ['todoist']), true);
  assert.equal(isReviewableService('todoist', ['Todoist']), true);
  assert.equal(isReviewableService('google-tasks', ['Google-Tasks']), true);
  assert.equal(isReviewableService('ms-todo', ['MS-TODO']), true);
});
