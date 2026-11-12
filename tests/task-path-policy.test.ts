import test from 'node:test';
import assert from 'node:assert/strict';
import { isIndexableTaskPath } from '../src/task-path-policy';

test('task path policy is case-insensitive and segment-aware', () => {
  const excluded = ['/Archive/', 'Private'];
  assert.equal(isIndexableTaskPath('Archive.md', 'md', excluded), true);
  assert.equal(isIndexableTaskPath('Archive/Task.md', 'md', excluded), false);
  assert.equal(isIndexableTaskPath('archive/Nested.canvas', 'canvas', excluded), false);
  assert.equal(isIndexableTaskPath('PRIVATE/Task.md', 'md', excluded), false);
  assert.equal(isIndexableTaskPath('Archive2/Task.md', 'md', excluded), true);
  assert.equal(isIndexableTaskPath('Image.png', 'png', excluded), false);
});
