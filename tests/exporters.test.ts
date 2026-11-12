/**
 * Exporters Tests
 * Tests for JSON, YAML, and CSV export formats
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { ensureExportPathExtension, exportTasksAsJSON, exportTasksAsYAML, exportTasksAsCSV } from '../src/exporters';
import { TaskScanner } from '../src/task-scanner';

function scanner(): TaskScanner {
  return new TaskScanner({} as never);
}

test('exporters: ensureExportPathExtension preserves export file extensions', () => {
  assert.equal(ensureExportPathExtension('Reports/tasks', 'Tasks Export.json', 'json'), 'Reports/tasks.json');
  assert.equal(ensureExportPathExtension('Reports/tasks.JSON', 'Tasks Export.json', '.json'), 'Reports/tasks.JSON');
  assert.equal(ensureExportPathExtension('Daily.md', 'Tasks Export.csv', 'csv'), 'Daily.md.csv');
  assert.equal(ensureExportPathExtension('', 'Tasks Export.yaml', 'yaml'), 'Tasks Export.yaml');
});

// ── JSON Export ──────────────────────────────────

test('exporters: JSON export creates valid structure', () => {
  const s = scanner();
  const tasks = [
    s.parseTaskLine('- [ ] Task 1', 'Test.md', 1)!,
    s.parseTaskLine('- [x] Task 2 ✅ 2026-05-20', 'Test.md', 2)!,
  ];
  const json = exportTasksAsJSON(tasks);
  assert.ok(json);
  const parsed = JSON.parse(json);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 2);
});

test('exporters: JSON export includes all task fields', () => {
  const s = scanner();
  const task = s.parseTaskLine('- [ ] Task 📅 2026-06-15 🔺 ⏱️ 2h #urgent #work', 'Test.md', 1)!;
  const json = exportTasksAsJSON([task]);
  const parsed = JSON.parse(json);
  assert.equal(parsed[0].status, ' ');
  assert.ok(parsed[0].metadata.dates.due);
  assert.ok(parsed[0].metadata.priority);
  assert.ok(parsed[0].metadata.effort);
  assert.ok(Array.isArray(parsed[0].tags));
});

test('exporters: JSON export handles completed tasks', () => {
  const s = scanner();
  const task = s.parseTaskLine('- [x] Completed ✅ 2026-05-20', 'Test.md', 1)!;
  const json = exportTasksAsJSON([task]);
  const parsed = JSON.parse(json);
  assert.equal(parsed[0].status, 'x');
  assert.ok(parsed[0].metadata.dates.done);
});

test('exporters: JSON export includes metadata', () => {
  const s = scanner();
  const task = s.parseTaskLine('- [ ] Task 🆔 task-1 💵 100', 'Test.md', 1)!;
  const json = exportTasksAsJSON([task]);
  const parsed = JSON.parse(json);
  assert.ok(parsed[0].metadata.id);
  assert.ok(parsed[0].metadata.cost);
});

test('exporters: JSON and YAML preserve extended task metadata', () => {
  const task = scanner().parseTaskLine('- [ ] Task', 'Test.md', 1);
  assert.ok(task);
  Object.assign(task.metadata, {
    recurrenceRaw: 'every day until 2026-06-03 for 3 times', recurrenceCount: 1, recurrenceLimit: 3,
    recurrenceUntil: '2026-06-03', dependencyTypes: { blocker: 'FS' }, manualOrder: 4,
    parentId: 'parent', recurrenceSeriesId: 'series', assignee: '@a', reviewer: '@r', project: 'P', team: 'T',
    comments: ['note'], customFields: { client: 'Acme', score: 4 }, excludeFromSync: true,
  });

  const parsed = JSON.parse(exportTasksAsJSON([task]))[0];
  assert.equal(parsed.metadata.recurrenceUntil, '2026-06-03');
  assert.deepEqual(parsed.metadata.dependencyTypes, { blocker: 'FS' });
  assert.deepEqual(parsed.metadata.comments, ['note']);
  assert.deepEqual(parsed.metadata.customFields, { client: 'Acme', score: 4 });
  assert.equal(parsed.metadata.excludeFromSync, true);

  const yaml = exportTasksAsYAML([task]);
  assert.match(yaml, /metadata:\n\s+dates:/u);
  assert.match(yaml, /recurrenceUntil: "2026-06-03"/u);
  assert.match(yaml, /dependencyTypes:\n\s+blocker: "FS"/u);
  assert.match(yaml, /comments: \["note"\]/u);
  assert.match(yaml, /customFields:\n\s+client: "Acme"/u);
});

// ── YAML Export ──────────────────────────────────

test('exporters: YAML export creates valid format', () => {
  const s = scanner();
  const tasks = [
    s.parseTaskLine('- [ ] Task 1', 'Test.md', 1)!,
  ];
  const yaml = exportTasksAsYAML(tasks);
  assert.ok(yaml);
  assert.ok(yaml.includes('- status'));
  assert.ok(yaml.includes('description'));
});

test('exporters: YAML export includes task fields', () => {
  const s = scanner();
  const task = s.parseTaskLine('- [ ] Task 📅 2026-06-15 #urgent', 'Test.md', 1)!;
  const yaml = exportTasksAsYAML([task]);
  assert.ok(yaml.includes('Task'));
  assert.ok(yaml.includes('2026-06-15'));
  assert.ok(yaml.includes('urgent'));
});

test('exporters: YAML export handles multiple tasks', () => {
  const s = scanner();
  const tasks = [
    s.parseTaskLine('- [ ] Task 1', 'Test.md', 1)!,
    s.parseTaskLine('- [x] Task 2', 'Test.md', 2)!,
    s.parseTaskLine('- [ ] Task 3 #work', 'Test.md', 3)!,
  ];
  const yaml = exportTasksAsYAML(tasks);
  assert.ok(yaml.includes('Task 1'));
  assert.ok(yaml.includes('Task 2'));
  assert.ok(yaml.includes('Task 3'));
});

test('exporters: YAML export quotes date fields to prevent YAML 1.1 type coercion', () => {
  // YAML 1.1 parsers (PyYAML, js-yaml 3.x) auto-coerce bare YYYY-MM-DD to date objects.
  // All six date fields must be wrapped in double quotes.
  const s = scanner();
  const task = s.parseTaskLine('- [x] Task 📅 2026-06-15 ⏰ 2026-06-10 🛫 2026-06-01 ✅ 2026-06-20 ➕ 2026-05-01 ❌ 2026-06-30', 'Test.md', 1)!;
  const yaml = exportTasksAsYAML([task]);
  // Each date field must appear as a quoted scalar, e.g.: `  due: "2026-06-15"`
  assert.match(yaml, /  due: "2026-06-15"/u);
  assert.match(yaml, /  (?:done|cancelled|created|start|scheduled): "2026-/u);
});

test('exporters: YAML export preserves status', () => {
  const s = scanner();
  const task = s.parseTaskLine('- [/] In progress', 'Test.md', 1)!;
  const yaml = exportTasksAsYAML([task]);
  assert.ok(yaml.includes('/'));
});

test('exporters: YAML export quotes apostrophe status markers safely', () => {
  const s = scanner();
  const task = s.parseTaskLine("- ['] Quote status", 'Test.md', 1)!;
  const yaml = exportTasksAsYAML([task]);

  assert.match(yaml, /^- status: "'"$/mu);
  assert.doesNotMatch(yaml, /^- status: '''$/mu);
});

// ── CSV Export ──────────────────────────────────

test('exporters: CSV export creates valid format', () => {
  const s = scanner();
  const tasks = [
    s.parseTaskLine('- [ ] Task 1', 'Test.md', 1)!,
  ];
  const csv = exportTasksAsCSV(tasks);
  assert.ok(csv);
  const lines = csv.split('\n');
  assert.ok(lines[0].includes('status'));
  assert.ok(lines[1].includes('Task 1'));
});

test('exporters: CSV export includes headers', () => {
  const s = scanner();
  const tasks = [
    s.parseTaskLine('- [ ] Task', 'Test.md', 1)!,
  ];
  const csv = exportTasksAsCSV(tasks);
  const lines = csv.split('\n');
  const headers = lines[0];
  assert.ok(headers.includes('status'));
  assert.ok(headers.includes('description'));
  assert.ok(headers.includes('file'));
});

test('exporters: CSV export handles special characters', () => {
  const s = scanner();
  const task = s.parseTaskLine('- [ ] Task with "quotes" and, commas', 'Test.md', 1)!;
  const csv = exportTasksAsCSV([task]);
  // Should properly escape quotes
  assert.ok(csv.includes('quotes'));
  assert.ok(csv.includes('commas'));
});

test('exporters: CSV export neutralizes spreadsheet formulas', () => {
  const s = scanner();
  const task = s.parseTaskLine('- [ ] =HYPERLINK("https://example.test")', 'Test.md', 1)!;
  const csv = exportTasksAsCSV([task]);

  assert.ok(csv.includes('"\'=HYPERLINK(""https://example.test"")"'));
});

test('exporters: CSV export handles empty fields', () => {
  const s = scanner();
  const task = s.parseTaskLine('- [ ] Task', 'Test.md', 1)!;
  const csv = exportTasksAsCSV([task]);
  assert.ok(csv.includes(',,'));
});

test('exporters: CSV export includes multiple tasks', () => {
  const s = scanner();
  const tasks = [
    s.parseTaskLine('- [ ] Task 1', 'Test.md', 1)!,
    s.parseTaskLine('- [x] Task 2 ✅ 2026-05-20', 'Test.md', 2)!,
  ];
  const csv = exportTasksAsCSV(tasks);
  const lines = csv.split('\n');
  assert.ok(lines.length >= 3); // header + 2 tasks
});

test('exporters: CSV export preserves dates', () => {
  const s = scanner();
  const task = s.parseTaskLine('- [ ] Task 📅 2026-06-15 🚀 2026-06-10', 'Test.md', 1)!;
  const csv = exportTasksAsCSV([task]);
  assert.ok(csv.includes('2026-06-15'));
  assert.ok(csv.includes('2026-06-10'));
});

test('exporters: CSV export includes tags', () => {
  const s = scanner();
  const task = s.parseTaskLine('- [ ] Task #urgent #work', 'Test.md', 1)!;
  const csv = exportTasksAsCSV([task]);
  assert.ok(csv.includes('urgent'));
  assert.ok(csv.includes('work'));
});

// ── Format Edge Cases ──────────────────────────────────

test('exporters: JSON export handles empty task list', () => {
  const json = exportTasksAsJSON([]);
  const parsed = JSON.parse(json);
  assert.ok(Array.isArray(parsed));
  assert.equal(parsed.length, 0);
});

test('exporters: YAML export handles empty task list', () => {
  const yaml = exportTasksAsYAML([]);
  assert.ok(typeof yaml === 'string');
});

test('exporters: CSV export handles empty task list', () => {
  const csv = exportTasksAsCSV([]);
  assert.ok(typeof csv === 'string');
});

test('exporters: JSON export includes effort and actual time', () => {
  const s = scanner();
  const task = s.parseTaskLine('- [x] Task ⏱️ 2h 🕐 1.5h', 'Test.md', 1)!;
  const json = exportTasksAsJSON([task]);
  const parsed = JSON.parse(json);
  assert.ok(parsed[0].metadata.effort);
  assert.ok(parsed[0].metadata.actual);
});

test('exporters: CSV preserves file path', () => {
  const s = scanner();
  const task = s.parseTaskLine('- [ ] Task', 'Projects/Work.md', 1)!;
  const csv = exportTasksAsCSV([task]);
  assert.ok(csv.includes('Projects/Work.md'));
});

test('exporters: CSV preserves line number', () => {
  const s = scanner();
  const task = s.parseTaskLine('- [ ] Task', 'Test.md', 42)!;
  const csv = exportTasksAsCSV([task]);
  assert.ok(csv.includes('42'));
});

// ── ICS Export ───────────────────────────────────

import { exportToICS } from '../src/exporters';

test('exporters: ICS export produces valid VCALENDAR wrapper', async () => {
  const s = scanner();
  const tasks = [
    s.parseTaskLine('- [ ] Meeting 📅 2026-06-15', 'Test.md', 1)!,
    s.parseTaskLine('- [x] Done task ✅ 2026-06-01', 'Test.md', 2)!,
  ];
  const ics = await exportToICS(tasks);
  assert.ok(ics.startsWith('BEGIN:VCALENDAR'), 'must start with BEGIN:VCALENDAR');
  assert.ok(ics.includes('END:VCALENDAR'), 'must end with END:VCALENDAR');
  assert.ok(ics.includes('METHOD:PUBLISH'), 'must include METHOD:PUBLISH');
  assert.ok(ics.includes('BEGIN:VTODO'), 'must contain VTODO components');
  assert.ok(ics.includes('END:VTODO'), 'VTODO must be closed');
});

test('exporters: ICS export includes task summary and due date', async () => {
  const s = scanner();
  const task = s.parseTaskLine('- [ ] Buy groceries 📅 2026-07-04', 'Test.md', 1)!;
  const ics = await exportToICS([task]);
  assert.ok(ics.includes('SUMMARY:Buy groceries'), 'VTODO must contain SUMMARY with task text');
  assert.ok(ics.includes('20260704'), 'VTODO must contain due date in ICS format');
});

test('exporters: ICS export includes priority for high-priority tasks', async () => {
  const s = scanner();
  const task = s.parseTaskLine('- [ ] Urgent report ⏫ 📅 2026-07-01', 'Test.md', 1)!;
  const ics = await exportToICS([task]);
  assert.ok(ics.includes('PRIORITY:'), 'high-priority task must have PRIORITY property');
});

test('exporters: ICS export handles tasks without dates', async () => {
  const s = scanner();
  const task = s.parseTaskLine('- [ ] Undated task', 'Test.md', 1)!;
  const ics = await exportToICS([task]);
  assert.ok(ics.includes('BEGIN:VTODO'), 'undated tasks must still produce VTODO entries');
  assert.ok(ics.includes('SUMMARY:Undated task'), 'undated VTODO must include summary');
});

test('exporters: ICS export skips tasks excluded from sync', async () => {
  const s = scanner();
  const included = s.parseTaskLine('- [ ] Included task', 'Test.md', 1)!;
  const excluded = s.parseTaskLine('- [ ] Excluded task', 'Test.md', 2)!;
  excluded.metadata.excludeFromSync = true;
  const ics = await exportToICS([included, excluded]);
  assert.ok(ics.includes('SUMMARY:Included task'), 'included tasks must be exported');
  assert.ok(!ics.includes('SUMMARY:Excluded task'), 'excluded tasks must not be exported');
  assert.ok(!/\r?\n\r?\n/u.test(ics), 'ICS feed must not contain blank component lines');
});

test('exporters: ICS export with empty task list produces valid empty feed', async () => {
  const ics = await exportToICS([]);
  assert.ok(ics.startsWith('BEGIN:VCALENDAR'), 'empty feed must start with BEGIN:VCALENDAR');
  assert.ok(ics.includes('END:VCALENDAR'), 'empty feed must end with END:VCALENDAR');
  assert.ok(!ics.includes('BEGIN:VTODO'), 'empty feed must not contain VTODO entries');
});
