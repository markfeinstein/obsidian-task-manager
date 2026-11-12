import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDateField, parseMarkdownTaskLine } from '../src/task-model';

test('wikilink task dates parse and can be formatted back as wikilinks', () => {
  const line = '- [ ] Review launch plan 📅 [[2026-06-01]] ⏳ [[2026-05-28]] 🛫 [[2026-05-27]] ✅ [[2026-06-02]] ➕ [[2026-05-20]] ❌ [[2026-06-03]]';
  const parsed = parseMarkdownTaskLine(line, 'Projects/Launch.md', 1);

  assert.ok(parsed);
  assert.equal(parsed.metadata.dates.due, '2026-06-01');
  assert.equal(parsed.metadata.dates.scheduled, '2026-05-28');
  assert.equal(parsed.metadata.dates.start, '2026-05-27');
  assert.equal(parsed.metadata.dates.done, '2026-06-02');
  assert.equal(parsed.metadata.dates.created, '2026-05-20');
  assert.equal(parsed.metadata.dates.cancelled, '2026-06-03');

  assert.equal(formatDateField(parsed.metadata.dates.due!, 'wikilink'), '[[2026-06-01]]');
  assert.equal(formatDateField(parsed.metadata.dates.scheduled!, 'wikilink'), '[[2026-05-28]]');
});
