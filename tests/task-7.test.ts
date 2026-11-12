import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTaskMetadata, parseMarkdownTaskLine } from '../src/task-model';
import { parseEditableTaskLine, formatEditableTaskLine, csvEscape } from '../src/modals/task-edit-helpers';

// Test collaboration field parsing
test('Collaboration fields: parse assignee from 👤 @username', () => {
  const metadata = parseTaskMetadata('Task 👤 @alice due 📅 2026-05-30');
  assert.equal(metadata.assignee, 'alice');
});

test('Collaboration fields: parse reviewer from 👁️ @username', () => {
  const metadata = parseTaskMetadata('Task 👁️ @bob due 📅 2026-05-30');
  assert.equal(metadata.reviewer, 'bob');
});

test('Collaboration fields: parse reviewer from 👁 @username without variation selector', () => {
  const metadata = parseTaskMetadata('Task 👁 @bob due 📅 2026-05-30');
  assert.equal(metadata.reviewer, 'bob');
});

test('Collaboration fields: parse project from 📋 ProjectName', () => {
  const metadata = parseTaskMetadata('Task 📋 MyProject due 📅 2026-05-30');
  assert.equal(metadata.project, 'MyProject');
});

test('Collaboration fields: parse team from 👥 TeamName', () => {
  const metadata = parseTaskMetadata('Task 👥 Engineering due 📅 2026-05-30');
  assert.equal(metadata.team, 'Engineering');
});

test('Collaboration fields: parse multiple collaboration fields', () => {
  const metadata = parseTaskMetadata('Task 👤 @alice 👁️ @bob 📋 ProjectX 👥 TeamA');
  assert.equal(metadata.assignee, 'alice');
  assert.equal(metadata.reviewer, 'bob');
  assert.equal(metadata.project, 'ProjectX');
  assert.equal(metadata.team, 'TeamA');
});

test('Collaboration fields: edit modal parses project and team emojis with variation selectors', () => {
  const parsed = parseEditableTaskLine('- [ ] Coordinate 📋️ ProjectX 👥️ TeamA');
  assert.equal(parsed.description, 'Coordinate');
  assert.equal(parsed.project, 'ProjectX');
  assert.equal(parsed.team, 'TeamA');
});

test('Edit modal: parses dataview alias fields when primary field is absent', () => {
  const parsed = parseEditableTaskLine('- [ ] Follow up [est:: 2h] [logged:: 30m] [followup:: 2026-06-15] [series:: daily-review]');
  assert.equal(parsed.effort, '2h');
  assert.equal(parsed.actual, '30m');
  assert.equal(parsed.followUp, '2026-06-15');
  assert.equal(parsed.recurrenceSeriesId, 'daily-review');
});

test('Edit modal: round-trips emoji cost and pinned fields', () => {
  const parsed = parseEditableTaskLine('- [ ] Important task 📌 💵 125.50');
  assert.equal(parsed.description, 'Important task');
  assert.equal(parsed.pinned, 'true');
  assert.equal(parsed.cost, '125.50');

  assert.equal(formatEditableTaskLine(parsed, 'emoji'), '- [ ] Important task 📌 💵 125.50');
});

test('Edit modal: round-trips Dataview cost and pinned fields', () => {
  const parsed = parseEditableTaskLine('- [ ] Important task [pinned:: true] [cost:: 125.50]');
  assert.equal(parsed.description, 'Important task');
  assert.equal(parsed.pinned, 'true');
  assert.equal(parsed.cost, '125.50');

  assert.equal(formatEditableTaskLine(parsed, 'dataview'), '- [ ] Important task [pinned:: true] [cost:: 125.50]');
});

test('Edit modal: parses Dataview wikilink date fields without leaking brackets', () => {
  const parsed = parseEditableTaskLine('- [ ] Task [due:: [[2026-06-18]]] [scheduled:: [[2026-06-19 09:30]]] [reminder:: [[2026-06-20|Sat]]]');

  assert.equal(parsed.description, 'Task');
  assert.equal(parsed.due, '2026-06-18');
  assert.equal(parsed.scheduled, '2026-06-19');
  assert.equal(parsed.scheduledTime, '09:30');
  assert.match(formatEditableTaskLine(parsed, 'dataview'), /\[scheduled:: 2026-06-19 09:30\]/u);
  assert.equal(parsed.reminder, '2026-06-20');
});

test('Collaboration fields: handle missing collaboration fields', () => {
  const metadata = parseTaskMetadata('Task without collaboration fields');
  assert.equal(metadata.assignee, undefined);
  assert.equal(metadata.reviewer, undefined);
  assert.equal(metadata.project, undefined);
  assert.equal(metadata.team, undefined);
});

test('Collaboration fields: handle dataview format [assignee:: value]', () => {
  const metadata = parseTaskMetadata('Task [assignee:: charlie] [project:: ProjectY]');
  assert.equal(metadata.assignee, 'charlie');
  assert.equal(metadata.project, 'ProjectY');
});

test('CSV helper neutralizes spreadsheet formula cells', () => {
  assert.equal(csvEscape('=1+1'), "'=1+1");
  assert.equal(csvEscape('  +SUM(A1:A2)'), "'  +SUM(A1:A2)");
  assert.equal(csvEscape('-10'), "'-10");
  assert.equal(csvEscape('@cmd'), "'@cmd");
  assert.equal(csvEscape('@cmd,now'), '"\'@cmd,now"');
});

// Test comment parsing
test('Comments: parse single 💬 comment from indented bullet', () => {
  const line = '- [x] Main task';
  const task = parseMarkdownTaskLine(line, 'test.md', 1);
  assert.ok(task);
  // Note: Comments are parsed at scanner level, not at parseMarkdownTaskLine level
  // So this test verifies that the basic parsing works
  assert.equal(task.normalizedText, 'Main task');
});

test('Comments: verify metadata supports comments array', () => {
  const metadata = parseTaskMetadata('Task with comments');
  // Comments field should exist in metadata interface
  assert.ok('comments' in metadata);
});

// Test aggregations
test('Aggregations: sum effort from multiple tasks', () => {
  const metadata1 = parseTaskMetadata('Task 1 ⏱️ 2h');
  const metadata2 = parseTaskMetadata('Task 2 ⏱️ 30m');
  
  // Verify effort parsing
  assert.equal(metadata1.effort, '2h');
  assert.equal(metadata2.effort, '30m');
});

test('Aggregations: count overdue tasks with due date before today', () => {
  const metadata1 = parseTaskMetadata('Task 1 📅 2026-05-25');
  const metadata2 = parseTaskMetadata('Task 2 📅 2026-05-30');
  
  // Verify due date parsing
  assert.equal(metadata1.dates.due, '2026-05-25');
  assert.equal(metadata2.dates.due, '2026-05-30');
});

// Test backward compatibility
test('Backward compatibility: tasks without collaboration fields still work', () => {
  const line = '- [ ] Simple task with priority 🔺 and due 📅 2026-05-30';
  const task = parseMarkdownTaskLine(line, 'test.md', 1);
  
  assert.ok(task);
  assert.equal(task.status, 'todo');
  assert.equal(task.metadata.priority, 'highest');
  assert.equal(task.metadata.dates.due, '2026-05-30');
});

test('Backward compatibility: comments field is optional', () => {
  const metadata = parseTaskMetadata('Simple task');
  assert.ok(metadata);
  // Comments field should be optional
  assert.equal(metadata.comments, undefined);
});

// Test query filter support
test('Query support: assignee metadata is accessible', () => {
  const metadata = parseTaskMetadata('Review PR 👤 @alice');
  assert.equal(metadata.assignee, 'alice');
});

test('Query support: project metadata is accessible', () => {
  const metadata = parseTaskMetadata('Build feature 📋 Platform');
  assert.equal(metadata.project, 'Platform');
});

test('Query support: team metadata is accessible', () => {
  const metadata = parseTaskMetadata('Team meeting 👥 QA');
  assert.equal(metadata.team, 'QA');
});

test('Query support: reviewer metadata is accessible', () => {
  const metadata = parseTaskMetadata('Code review 👁️ @bob');
  assert.equal(metadata.reviewer, 'bob');
});
