/**
 * Test for follow-up date+time parsing fix
 * Bug: followUp dates were not parsing time components, causing time to leak into description
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseEditableTaskLine, formatEditableTaskLine } from '../src/modals/task-edit-helpers';
import { parseMarkdownTaskLine } from '../src/task-model';

describe('Follow-up date+time parsing', () => {
  it('should parse follow-up with date and time', () => {
    const line = '- [ ] Task description 👀 2026-06-15 14:00';
    const parsed = parseEditableTaskLine(line);
    
    // Follow-up should include both date and time
    assert.equal(parsed.followUp, '2026-06-15 14:00');
    
    // Time should not leak into description
    assert.equal(parsed.description, 'Task description');
  });

  it('should parse spaced on-completion aliases without leaking into the description', () => {
    const parsed = parseEditableTaskLine('- [ ] Task description 🏁 move to end ⌚ 12:00 📅 2026-06-15');

    assert.equal(parsed.onCompletion, 'move-to-end');
    assert.equal(parsed.description, 'Task description');
    assert.equal(parsed.time, '12:00');
    assert.equal(parsed.due, '2026-06-15');
  });

  it('should parse on-completion before effort and collaboration metadata', () => {
    const parsed = parseEditableTaskLine('- [ ] Task description 🏁 archive ⏱ 1h 👤 @alex');
    const custom = parseEditableTaskLine('- [ ] Custom description 🏁 custom action ⏱ 1h 🕐 30m 👀 2026-06-22 👤 @alex');

    assert.equal(parsed.onCompletion, 'archive');
    assert.equal(parsed.description, 'Task description');
    assert.equal(parsed.effort, '1h');
    assert.equal(parsed.assignee, 'alex');
    assert.equal(custom.onCompletion, 'custom-action');
    assert.equal(custom.description, 'Custom description');
    assert.equal(custom.effort, '1h');
    assert.equal(custom.actual, '30m');
    assert.equal(custom.followUp, '2026-06-22');
    assert.equal(custom.assignee, 'alex');
  });

  it('should parse core follow-up metadata with date-times without leaking into normalized text', () => {
    const plain = parseMarkdownTaskLine('- [ ] Task description 👀 2026-06-15 14:00', 'Tasks.md', 1);
    const wikilink = parseMarkdownTaskLine('- [ ] Task description 👀 [[2026-06-15 14:00]]', 'Tasks.md', 2);
    const dataview = parseMarkdownTaskLine('- [ ] Task description [follow-up:: 2026-06-15 14:00]', 'Tasks.md', 3);
    const dataviewWikilink = parseMarkdownTaskLine('- [ ] Task description [follow-up:: [[2026-06-15 14:00]]]', 'Tasks.md', 4);

    assert.ok(plain);
    assert.ok(wikilink);
    assert.ok(dataview);
    assert.ok(dataviewWikilink);
    assert.equal(plain.metadata.followUp, '2026-06-15 14:00');
    assert.equal(plain.normalizedText, 'Task description');
    assert.equal(wikilink.metadata.followUp, '2026-06-15 14:00');
    assert.equal(wikilink.normalizedText, 'Task description');
    assert.equal(dataview.metadata.followUp, '2026-06-15 14:00');
    assert.equal(dataview.normalizedText, 'Task description');
    assert.equal(dataviewWikilink.metadata.followUp, '2026-06-15 14:00');
    assert.equal(dataviewWikilink.normalizedText, 'Task description');
  });

  it('should parse follow-up with date only', () => {
    const line = '- [ ] Task description 👀 2026-06-15';
    const parsed = parseEditableTaskLine(line);
    
    assert.equal(parsed.followUp, '2026-06-15');
    assert.equal(parsed.description, 'Task description');
  });

  it('should parse follow-up in wikilink format with time', () => {
    const line = '- [ ] Task description 👀 [[2026-06-15 14:00]]';
    const parsed = parseEditableTaskLine(line);
    
    assert.equal(parsed.followUp, '2026-06-15 14:00');
    assert.equal(parsed.description, 'Task description');
  });

  it('should parse follow-up in wikilink format with date only', () => {
    const line = '- [ ] Task description 👀 [[2026-06-15]]';
    const parsed = parseEditableTaskLine(line);
    
    assert.equal(parsed.followUp, '2026-06-15');
    assert.equal(parsed.description, 'Task description');
  });

  it('should round-trip follow-up with time through parse and format', () => {
    const line = '- [ ] Task description 👀 2026-06-15 14:00';
    const parsed = parseEditableTaskLine(line);
    const formatted = formatEditableTaskLine(parsed, 'emoji');
    
    // Verify the formatted line includes the time
    assert.match(formatted, /👀 2026-06-15 14:00/);
    assert.match(formatted, /Task description/);
  });

  it('should be consistent with reminder time parsing', () => {
    const reminderLine = '- [ ] Task with reminder ⏰ 2026-06-15 09:00';
    const followUpLine = '- [ ] Task with follow-up 👀 2026-06-15 09:00';
    
    const parsedReminder = parseEditableTaskLine(reminderLine);
    const parsedFollowUp = parseEditableTaskLine(followUpLine);
    
    // Both should include time component
    assert.equal(parsedReminder.reminder, '2026-06-15 09:00');
    assert.equal(parsedFollowUp.followUp, '2026-06-15 09:00');
    
    // Neither should have time leak into description
    assert.equal(parsedReminder.description, 'Task with reminder');
    assert.equal(parsedFollowUp.description, 'Task with follow-up');
  });
});
