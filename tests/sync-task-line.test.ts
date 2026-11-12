import test from 'node:test';
import assert from 'node:assert/strict';
import { taskLineAssignee, taskLineCompleted, taskLineDueDate, taskLinePriority, taskLineServiceId, taskLineTitle } from '../src/sync-task-line';

test('taskLineCompleted reads only the leading task checkbox', () => {
  assert.equal(taskLineCompleted('- [x] Completed task'), true);
  assert.equal(taskLineCompleted('- [X] Completed task with uppercase marker'), true);
  assert.equal(taskLineCompleted('  - [x] Indented completed task'), true);
  assert.equal(taskLineCompleted('* [x] Completed asterisk task'), true);
  assert.equal(taskLineCompleted('+ [x] Completed plus task'), true);
  assert.equal(taskLineCompleted('1. [x] Completed numbered task'), true);
  assert.equal(taskLineCompleted('2) [x] Completed numbered task'), true);
  assert.equal(taskLineCompleted('- [ ] Open task mentioning [x] in the title'), false);
  assert.equal(taskLineCompleted('- [ ] Open task with [X] uppercase marker in body'), false);
});

test('taskLineTitle strips supported leading task checkboxes before sync metadata', () => {
  assert.equal(taskLineTitle('  - [ ] Follow up with Alice 📅 2026-06-03', /\s+[📅🎯]/u), 'Follow up with Alice');
  assert.equal(taskLineTitle('* [ ] Asterisk task 📅 2026-06-03', /\s+[📅🎯]/u), 'Asterisk task');
  assert.equal(taskLineTitle('1. [ ] Numbered task 📅 2026-06-03', /\s+[📅🎯]/u), 'Numbered task');
  assert.equal(taskLineTitle('- [ ] Important task 🔺 [id:: legacy:1]', /\s+[📅🎯👤]/u), 'Important task');
});

test('taskLineTitle omits local sync annotations when no date separator is present', () => {
  assert.equal(taskLineTitle('- [ ] Follow up [/] [id:: ms-todo:m-note]', /\s+[📅🎯]/u), 'Follow up');
  assert.equal(taskLineTitle('- [ ] Review notes [sprint:: 42] [id:: legacy:a-note]', /\s+[📅🎯👤]/u), 'Review notes');
});

test('taskLineDueDate normalizes wikilink dates for external sync payloads', () => {
  assert.equal(taskLineDueDate('- [ ] Follow up 📅 2026-06-03'), '2026-06-03');
  assert.equal(taskLineDueDate('- [ ] Follow up 📆 2026-06-03'), '2026-06-03');
  assert.equal(taskLineDueDate('- [ ] Follow up 🗓 2026-06-03'), '2026-06-03');
  assert.equal(taskLineDueDate('- [ ] Follow up 📅️ 2026-06-03'), '2026-06-03');
  assert.equal(taskLineDueDate('- [ ] Follow up 📅 [[2026-06-03]]'), '2026-06-03');
  assert.equal(taskLineDueDate('- [ ] Follow up 📅 [[2026-06-03|Wed]]'), '2026-06-03');
  assert.equal(taskLineDueDate('- [ ] Follow up 📅️ [[2026-06-03|Wed]]'), '2026-06-03');
  assert.equal(taskLineDueDate('- [ ] Follow up 📅 tomorrow'), undefined);
});

test('taskLineDueDate ignores impossible ISO-shaped dates', () => {
  assert.equal(taskLineDueDate('- [ ] Follow up 📅 2026-02-31'), undefined);
  assert.equal(taskLineDueDate('- [ ] Follow up 📅 [[2026-13-01]]'), undefined);
});

test('taskLineDueDate ignores malformed dates with trailing text', () => {
  assert.equal(taskLineDueDate('- [ ] Follow up 📅 2026-06-03abc'), undefined);
  assert.equal(taskLineDueDate('- [ ] Follow up 📅 [[2026-06-03abc]]'), undefined);
});

test('taskLinePriority syncs supported priority labels and emoji markers', () => {
  assert.equal(taskLinePriority('- [ ] Follow up 🎯 high [id:: legacy:1]'), 'high');
  assert.equal(taskLinePriority('- [ ] Follow up 🎯 medium [id:: legacy:1]'), 'medium');
  assert.equal(taskLinePriority('- [ ] Follow up 🎯 low [id:: legacy:1]'), 'low');
  assert.equal(taskLinePriority('- [ ] Follow up ⏫ [id:: legacy:1]'), 'high');
  assert.equal(taskLinePriority('- [ ] Follow up 🔺 [id:: legacy:1]'), 'high');
  assert.equal(taskLinePriority('- [ ] Follow up 🔼 [id:: legacy:1]'), 'medium');
  assert.equal(taskLinePriority('- [ ] Follow up 🔽 [id:: legacy:1]'), 'low');
  assert.equal(taskLinePriority('- [ ] Follow up ⏬ [id:: legacy:1]'), 'low');
  assert.equal(taskLinePriority('- [ ] Follow up 🎯 highest [id:: legacy:1]'), undefined);
  assert.equal(taskLinePriority('- [ ] Follow up 🎯 lowest [id:: legacy:1]'), undefined);
});

test('taskLineAssignee stops before trailing task metadata', () => {
  assert.equal(taskLineAssignee('- [ ] Follow up 👤 Alice 🆔 task-1 🔁 every day'), 'Alice');
  assert.equal(taskLineAssignee('- [ ] Follow up 👤 Alice 🔁 every day 📅 2026-06-03'), 'Alice');
  assert.equal(taskLineAssignee('- [ ] Follow up 👤 Alice 🔺 [id:: legacy:1]'), 'Alice');
});

test('taskLineServiceId extracts provider-specific embedded task ids', () => {
  assert.equal(taskLineServiceId('- [ ] Follow up [id:: ms-todo:m-note]', 'ms-todo'), 'm-note');
  assert.equal(taskLineServiceId('- [ ] Review [id:: legacy:a-note]', 'legacy'), 'a-note');
  assert.equal(taskLineServiceId('- [ ] Review [id:: todoist:t-note]', 'legacy'), undefined);
});
