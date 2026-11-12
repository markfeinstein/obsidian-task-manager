import test from 'node:test';
import assert from 'node:assert/strict';
import { TodoistAdapter, todoistProjectionFromRemotePayload, todoistProjectionFromVaultTask } from '../src/todoist-sync';
import { parseMarkdownTaskLine } from '../src/task-model';
import { formatEditableTaskLine, parseEditableTaskLine } from '../src/modals/task-edit-helpers';

const adapter = new TodoistAdapter({ apiKey: 'synthetic', dryRun: true });
function payload(due: unknown) {
  return { id: 'current-id', content: 'Review', priority: 1, labels: [], due, added_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', completed_at: null };
}

test('Todoist current all-day and floating payloads accept nullable timezone without losing time', () => {
  for (const [date, expected] of [['2026-11-10', undefined], ['2026-11-10T14:30:00.000000', '14:30']] as const) {
    const remote = payload({ date, timezone: null, string: 'tomorrow', is_recurring: false });
    const imported = adapter.fromServicePayload(remote, 'Inbox.md');
    assert.equal(imported.metadata.dates.due, '2026-11-10');
    assert.equal(imported.metadata.dates.dueTime, expected);
    assert.equal(imported.metadata.dueTimezone, undefined);
    const rescanned = parseMarkdownTaskLine(imported.rawLine, 'Inbox.md', 1);
    assert.ok(rescanned);
    assert.deepEqual(todoistProjectionFromVaultTask(rescanned), todoistProjectionFromRemotePayload(remote));
  }
});

test('Todoist fixed instants retain named wall time and zone across scanning and task editing', () => {
  const remote = payload({ date: '2026-11-10T01:30:00.000000Z', timezone: 'America/New_York', string: 'tomorrow at 20:30', is_recurring: false });
  const imported = adapter.fromServicePayload(remote, 'Inbox.md');
  assert.equal(imported.metadata.dates.due, '2026-11-09');
  assert.equal(imported.metadata.dates.dueTime, '20:30');
  assert.equal(imported.metadata.dueTimezone, 'America/New_York');
  for (const format of ['emoji', 'dataview'] as const) {
    const edited = parseEditableTaskLine(imported.rawLine);
    edited.description = 'Edited';
    const rescanned = parseMarkdownTaskLine(formatEditableTaskLine(edited, format), 'Inbox.md', 1);
    assert.ok(rescanned);
    assert.equal(rescanned.metadata.dueTimezone, 'America/New_York');
    assert.equal(adapter.toServicePayload(rescanned).due_string, '2026-11-09 20:30 America/New_York');
  }
  const rescanned = parseMarkdownTaskLine(imported.rawLine, 'Inbox.md', 1);
  assert.ok(rescanned);
  assert.deepEqual(todoistProjectionFromVaultTask(rescanned), todoistProjectionFromRemotePayload(remote));
});

test('Todoist rejects unsafe or unknown timezone values and accurately declares field support', () => {
  for (const timezone of ['Invalid/Timezone', 'UTC] [id:: injected', 5]) {
    assert.throws(() => adapter.fromServicePayload(payload({ date: '2026-11-10T14:30:00Z', timezone }), 'Inbox.md'));
  }
  assert.equal(adapter.getCapabilities().fields.repeating, 'unsupported');
  assert.equal(adapter.getCapabilities().fields.subtask, 'unsupported');
});
