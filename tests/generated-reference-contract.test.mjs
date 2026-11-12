import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

function tableRows(markdown) {
  return markdown.split('\n').filter((line) => line.startsWith('| `settings.'));
}

test('generated settings reference exposes stable IDs and operational metadata', () => {
  const markdown = readFileSync('docs/SETTINGS_REFERENCE.md', 'utf8');
  const declaredCount = Number(markdown.match(/Setting count: \*\*(\d+)\*\*/u)?.[1]);
  assert.equal(Number.isSafeInteger(declaredCount), true);
  assert.match(markdown, /\| ID \| Setting \| Field \| Section \/ provider \| Type \/ range \| Default \| Prerequisite \| Persistence \/ security \| Side effect \| Reload \| Source \|/u);
  const rows = tableRows(markdown);
  assert.equal(rows.length, declaredCount);
  const ids = rows.map((row) => row.match(/^\| `([^`]+)`/u)?.[1]);
  assert.equal(ids.every(Boolean), true);
  assert.equal(new Set(ids).size, ids.length);
  assert.match(markdown, /`settings\.todoistApiKey`[^\n]+SecretStorage on supported Obsidian 1\.11\.4\+; saving active secrets is blocked when SecretStorage is unavailable/u);
  assert.match(markdown, /`settings\.enableDslExpressions`/u);
  assert.match(markdown, /`settings\.completionLoggingEnabled`[^\n]+`completionLoggingEnabled`[^\n]+\| false \|/u);
  assert.match(markdown, /`settings\.aiQueryProvider`[^\n]+`aiQueryProvider`[^\n]+\| openai \|/u);
  assert.match(markdown, /`settings\.aiQueryLocalEndpoint`[^\n]+`aiQueryLocalEndpoint`[^\n]+http:\/\/localhost:11434\/v1\/chat\/completions/u);
  assert.match(markdown, /`settings\.googleCalendarId`[^\n]+`googleCalendarId`[^\n]+Google Calendar/u);
  assert.match(markdown, /`settings\.appleRemindersShortcutName`[^\n]+Export Reminders to Obsidian/u);
  assert.doesNotMatch(markdown, /Allow scripting in queries/u);
});

test('generated command reference separates registration, invocation guards, and effects', () => {
  const markdown = readFileSync('docs/COMMANDS.md', 'utf8');
  assert.match(markdown, /\| Lane \| Command \| ID \| Palette availability \| Invocation context \| Runtime guards \| Effect \| Prerequisites \|/u);
  assert.match(markdown, /`explore-integrations`[^\n]+Always visible/iu);
  assert.match(markdown, /`sync-google-calendar`[^\n]+Visible when `googleCalendarEnabled` is enabled[^\n]+OAuth[^\n]+dry-run/iu);
  assert.match(markdown, /`sync-caldav`[^\n]+Visible when `caldavSyncEnabled` is enabled[^\n]+credentials[^\n]+dry-run/iu);
  assert.match(markdown, /`ai-task-search`[^\n]+Visible when `aiQueryEnabled` is enabled[^\n]+provider/iu);
  assert.match(markdown, /`export-bases-index`[^\n]+enableBasesIntegration/u);
  assert.match(markdown, /status-change[^\n]+change-status-to-\{configured-state\}/u);
  assert.match(markdown, /`import-ics`[^\n]+fail-closed/u);
  assert.doesNotMatch(markdown, /`import-kanban-board`|Import tasks from Kanban board file/u);
});
