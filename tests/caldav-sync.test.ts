import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { TFile } from 'obsidian';
import { parseICSFile, generateVTODO, parseVTODO, formatCalendarICS, CalDAVClient, calendarEventToTaskLine, isPrivateCalDavServerUrl, isAllowedCalDavServerUrl, resetCalDavTransportGuardsForTests, tasksToICS, syncTasksToCalDAV, syncTasksFromCalDAV, syncTasksWithCalDAV, reconcileCalendarICS, CalDAVError } from '../src/caldav-sync';
import { TaskScanner } from '../src/task-scanner';

function scanner(): TaskScanner {
  return new TaskScanner({} as never);
}

function task(line: string) {
  const parsed = scanner().parseTaskLine(line, 'Test.md', 1);
  assert.ok(parsed, `Expected task line to parse: ${line}`);
  return parsed;
}

function fileForPath(path: string): TFile {
  return Object.assign(Object.create(TFile.prototype) as TFile, {
    path,
    name: path.split('/').pop() ?? path,
    extension: 'md',
    basename: path.replace(/\.md$/u, ''),
  });
}

function deferred<T>(): { promise: Promise<T>; resolve(value: T): void; reject(error: unknown): void } {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

type RequestUrlTestParams = {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal | null;
  throw?: boolean;
};
type RequestUrlTestResponse = { status: number; headers: Record<string, string>; text: string };
type RequestUrlTestFunction = (params: RequestUrlTestParams) => Promise<RequestUrlTestResponse>;
const obsidianRuntime = createRequire(__filename)('obsidian') as unknown as { requestUrl?: RequestUrlTestFunction };

function requestUrlResponse(status: number, text = '', headers: Record<string, string> = {}): RequestUrlTestResponse {
  return { status, text, headers };
}

function bridgeRequestUrlMockToFetch(): () => void {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const mock = obsidianRuntime.requestUrl;
    if (!mock) throw new Error('requestUrl test mock is not installed');
    assert.equal(init?.redirect, 'error');
    const response = await mock({
      url: String(url),
      method: init?.method,
      headers: init?.headers as Record<string, string> | undefined,
      body: typeof init?.body === 'string' ? init.body : undefined,
      signal: init?.signal,
      throw: false,
    });
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      headers: new Headers(response.headers),
      text: async () => response.text,
    } as Response;
  }) as typeof fetch;
  return () => { globalThis.fetch = originalFetch; };
}

test('caldav-sync: converts task to VTODO', () => {
  const vtodo = generateVTODO(task('- [ ] Task'));

  assert.ok(vtodo.includes('BEGIN:VTODO'));
  assert.ok(vtodo.includes('SUMMARY:Task'));
  assert.ok(vtodo.includes('UID:task-Test.md-L1'));
  assert.ok(vtodo.includes('END:VTODO'));
});

test('caldav-sync: includes due date in VTODO', () => {
  const vtodo = generateVTODO(task('- [ ] Task 📅 2026-06-15'));

  assert.ok(vtodo.includes('DUE'));
  assert.ok(vtodo.includes('20260615'));
});

test('caldav-sync: emits VALUE=DATE for date-only DUE/DTSTART (RFC 5545)', () => {
  const vtodo = generateVTODO(task('- [ ] Task 📅 2026-06-15 ⏳ 2026-06-14'));

  // Date-only values must declare VALUE=DATE; a bare DATE-TIME default like
  // `DUE:20260615` is an invalid DATE-TIME that strict CalDAV servers reject.
  assert.ok(vtodo.includes('DUE;VALUE=DATE:20260615'), vtodo);
  assert.ok(vtodo.includes('DTSTART;VALUE=DATE:20260614'), vtodo);
  assert.ok(!/(?:^|\r\n)DUE:20260615(?:\r\n|$)/u.test(vtodo), vtodo);

  // Round-trips back to the same date through the parser.
  const parsed = parseVTODO(vtodo);
  assert.equal(parsed?.metadata?.dates.due, '2026-06-15');
  assert.equal(parsed?.metadata?.dates.scheduled, '2026-06-14');
});

test('caldav-sync: includes task date times in VTODO', () => {
  const vtodo = generateVTODO(task('- [ ] Task 📅 2026-06-15 14:30 ⏳ 2026-06-14 09:05'));

  assert.ok(vtodo.includes('DUE:20260615T143000'));
  assert.ok(vtodo.includes('DTSTART:20260614T090500'));
});

test('caldav-sync: formats inline parsed date-times when exporting VTODO', () => {
  const parsed = parseVTODO([
    'BEGIN:VTODO',
    'UID:inline-time',
    'SUMMARY:Timed task',
    'DUE:20260615T143025Z',
    'END:VTODO',
  ].join('\n'));
  assert.ok(parsed);

  const vtodo = generateVTODO(parsed as ReturnType<typeof task>);

  assert.ok(vtodo.includes('DUE:20260615T143000'));
});

test('caldav-sync: includes status in VTODO', () => {
  const vtodo = generateVTODO(task('- [x] Completed'));

  assert.ok(vtodo.includes('STATUS:COMPLETED'));
  assert.ok(vtodo.includes('PERCENT-COMPLETE:100'));
});

test('caldav-sync: COMPLETED timestamp is a valid single-Z UTC datetime', () => {
  // Known completion dates use one UTC marker; unknown dates are not fabricated.
  assert.doesNotMatch(generateVTODO(task('- [x] Completed')), /^COMPLETED:/mu);
  const vtodo = generateVTODO(task('- [x] Completed ✅ 2026-11-09'));
  const completedLine = vtodo.split(/\r?\n/u).find((line) => line.startsWith('COMPLETED:'));
  assert.ok(completedLine, 'expected a COMPLETED property');
  assert.match(completedLine, /^COMPLETED:\d{8}T\d{6}Z$/u);
  assert.ok(!completedLine.includes('ZZ'), 'COMPLETED must not end with a doubled Z');
});

test('caldav-sync: includes priority in VTODO', () => {
  const vtodo = generateVTODO(task('- [ ] Urgent 🔺'));
  assert.match(vtodo, /PRIORITY:\d/);
});

test('caldav-sync: parses VTODO back to partial task', () => {
  const vtodo = generateVTODO(task('- [ ] Task 📅 2026-06-15'));
  const parsed = parseVTODO(vtodo);

  assert.ok(parsed);
  assert.equal(parsed.normalizedText, 'Task');
});

test('caldav-sync: metadata-only tasks export with a non-empty VTODO summary without importing fake text', () => {
  const original = task('- [ ] 📅 2026-06-15');
  assert.equal(original.normalizedText, '');

  const vtodo = generateVTODO(original);
  const parsed = parseVTODO(vtodo);
  const [event] = parseICSFile(formatCalendarICS([vtodo]));

  assert.ok(vtodo.includes('SUMMARY:Untitled task'), vtodo);
  assert.ok(vtodo.includes('X-OBSIDIAN-TASK-MANAGER-EMPTY-SUMMARY:TRUE'), vtodo);
  assert.ok(parsed);
  assert.equal(parsed.normalizedText, '');
  assert.equal(parsed.metadata?.dates.due, '2026-06-15');
  assert.equal(event.emptySummary, true);
  assert.equal(calendarEventToTaskLine(event), '- [ ] 📅 2026-06-15 🎯 medium [id:: task-Test-md-L1]');
});

test('caldav-sync: parses VTODO component markers case-insensitively', () => {
  const parsed = parseVTODO([
    'begin:vtodo',
    'uid:case-vtodo',
    'summary:Case-insensitive task',
    'due;value=date:20260615',
    'end:vtodo',
  ].join('\n'));

  assert.ok(parsed);
  assert.equal(parsed.normalizedText, 'Case-insensitive task');
  assert.equal(parsed.metadata?.dates.due, '2026-06-15');
});

test('caldav-sync: preserves due date in roundtrip', () => {
  const vtodo = generateVTODO(task('- [ ] Task 📅 2026-06-15'));
  const parsed = parseVTODO(vtodo);

  assert.equal(parsed?.metadata?.dates.due, '2026-06-15');
});

test('caldav-sync: truncates VTODO date-time seconds to task metadata precision', () => {
  const parsed = parseVTODO([
    'BEGIN:VTODO',
    'UID:timed-date',
    'SUMMARY:Timed task',
    'DUE:20260615T143025Z',
    'DTSTART:20260614T090500',
    'END:VTODO',
  ].join('\n'));

  assert.equal(parsed?.metadata?.dates.due, '2026-06-15 14:30');
  assert.equal(parsed?.metadata?.dates.scheduled, '2026-06-14 09:05');
});

test('caldav-sync: parses VTODO date-times with timezone syntax at task precision', () => {
  const parsed = parseVTODO([
    'BEGIN:VTODO',
    'UID:timezone-date-times',
    'SUMMARY:Timezone task',
    'DUE;TZID=America/New_York:20260615T143025',
    'DTSTART:20260614T090500-0500',
    'END:VTODO',
  ].join('\n'));

  assert.equal(parsed?.metadata?.dates.due, '2026-06-15 14:30');
  assert.equal(parsed?.metadata?.dates.scheduled, '2026-06-14 09:05');
});

test('caldav-sync: ignores impossible VTODO dates', () => {
  const parsed = parseVTODO([
    'BEGIN:VTODO',
    'UID:bad-date',
    'SUMMARY:Impossible date',
    'DUE;VALUE=DATE:20260231',
    'DTSTART:20261301T120000Z',
    'DTEND:not-a-date',
    'END:VTODO',
  ].join('\n'));

  assert.ok(parsed);
  assert.equal(parsed.metadata?.dates.due, undefined);
  assert.equal(parsed.metadata?.dates.scheduled, undefined);
});

test('caldav-sync: ignores invalid VTODO priority values', () => {
  const parsed = parseVTODO([
    'BEGIN:VTODO',
    'UID:bad-priority',
    'SUMMARY:Invalid priority',
    'PRIORITY:1abc',
    'END:VTODO',
  ].join('\n'));

  assert.ok(parsed);
  assert.equal(parsed.metadata?.priority, 'normal');
});

test('caldav-sync: preserves status in roundtrip', () => {
  const vtodo = generateVTODO(task('- [x] Done'));
  const parsed = parseVTODO(vtodo);

  assert.equal(parsed?.status, 'done');
});

test('caldav-sync: parses VTODO status values case-insensitively', () => {
  const parsed = parseVTODO([
    'BEGIN:VTODO',
    'UID:lower-status',
    'SUMMARY:Lower status',
    'STATUS:completed',
    'END:VTODO',
  ].join('\n'));

  assert.equal(parsed?.status, 'done');
});

test('caldav-sync: preserves task ID across roundtrip', () => {
  const vtodo = generateVTODO(task('- [ ] Task 🆔 task-123'));
  const parsed = parseVTODO(vtodo);

  assert.equal(parsed?.metadata?.id, 'task-123');
});

test('caldav-sync: preserves tags and recurrence across roundtrip', () => {
  const original = task('- [ ] Standup #team 🔁 every week');
  const parsed = parseVTODO(generateVTODO(original));

  assert.deepEqual(parsed?.tags, ['team']);
  assert.equal(parsed?.metadata?.recurrence, original.metadata.recurrence);
});

test('caldav-sync: escapes and unescapes VTODO category values', () => {
  const vtodo = generateVTODO(task('- [ ] Categorized #work;personal #plain'));
  const parsed = parseVTODO(vtodo);

  assert.ok(vtodo.includes('CATEGORIES:work\\;personal,plain'));
  assert.deepEqual(parsed?.tags, ['work;personal', 'plain']);
});

test('caldav-sync: parses VEVENT blocks from ICS', () => {
  const events = parseICSFile([
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:event-1',
    'SUMMARY:Planning meeting',
    'DTSTART;VALUE=DATE:20260615',
    'DTEND;VALUE=DATE:20260616',
    'PRIORITY:3',
    'CATEGORIES:work,planning',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\n'));

  assert.equal(events.length, 1);
  assert.equal(events[0].uid, 'event-1');
  assert.equal(events[0].summary, 'Planning meeting');
  assert.equal(events[0].dtstart, '2026-06-15');
  assert.deepEqual(events[0].categories, ['work', 'planning']);
});

test('caldav-sync: sanitizes untrusted imported event fields before rendering tasks', () => {
  const events = parseICSFile([
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:event-1] [exclude_from_sync:: true] #todoist',
    'SUMMARY:Planning [exclude_from_sync:: true] #todoist 🔁 every day 📅 2099-01-01',
    'CATEGORIES:work,[id:: hijack]',
    'RRULE:FREQ=WEEKLY #todoist [id:: hijack] 🔁 every day',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\n'));

  assert.equal(events.length, 1);
  const line = calendarEventToTaskLine(events[0]);
  assert.equal(line.includes('\n'), false);
  assert.equal(line.includes('[exclude_from_sync:: true]'), false);
  assert.equal(line.includes('#todoist'), false);
  assert.equal(line.includes('[id:: hijack]'), false);
  assert.equal(line.includes('📅 2099-01-01'), false);

  const parsed = scanner().parseTaskLine(line, 'CalDAV.md', 1);
  assert.ok(parsed, `Expected sanitized line to parse: ${line}`);
  assert.equal(parsed.metadata.excludeFromSync, false);
  assert.deepEqual(parsed.tags, ['work']);
  assert.match(parsed.metadata.id ?? '', /^[A-Za-z0-9_-]+$/u);
  assert.notEqual(parsed.metadata.id, 'hijack');
});

test('caldav-sync: truncates VEVENT date-time seconds to task-line precision', () => {
  const events = parseICSFile([
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:event-1',
    'SUMMARY:Timed meeting',
    'DTSTART:20260615T143025Z',
    'DTEND:20260615T150500',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\n'));

  assert.equal(events.length, 1);
  assert.equal(events[0].dtstart, '2026-06-15 14:30');
  assert.equal(events[0].dtend, '2026-06-15 15:05');
  assert.ok(calendarEventToTaskLine(events[0]).includes('🛫 2026-06-15 14:30'));
});

test('caldav-sync: parses VEVENT date forms without timezone conversion', () => {
  const events = parseICSFile([
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:event-1',
    'SUMMARY:Date forms',
    'DTSTART;VALUE=DATE:20260615',
    'DTEND;TZID=Europe/London:20260616T100500',
    'DUE:20260617T183025Z',
    'END:VEVENT',
    'BEGIN:VEVENT',
    'UID:event-2',
    'SUMMARY:Offset date-time',
    'DTSTART:20260618T073025+0930',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\n'));

  assert.equal(events.length, 2);
  assert.equal(events[0].dtstart, '2026-06-15');
  assert.equal(events[0].dtend, '2026-06-16 10:05');
  assert.equal(events[0].due, '2026-06-17 18:30');
  assert.equal(events[1].dtstart, '2026-06-18 07:30');
});

test('caldav-sync: parses VEVENT and VTODO block markers case-insensitively', () => {
  const events = parseICSFile([
    'BEGIN:VCALENDAR',
    'begin:VEVENT',
    'uid:event-1',
    'summary:Planning meeting',
    'dtstart;value=date:20260615',
    'end:VEVENT',
    'begin:vtodo',
    'uid:todo-1',
    'summary:Follow up',
    'status:COMPLETED',
    'end:vtodo',
    'END:VCALENDAR',
  ].join('\n'));

  assert.equal(events.length, 2);
  assert.equal(events[0].uid, 'event-1');
  assert.equal(events[0].dtstart, '2026-06-15');
  assert.equal(events[1].uid, 'todo-1');
  assert.equal(events[1].status, 'COMPLETED');
});

test('caldav-sync: parses ICS properties with parameters', () => {
  const events = parseICSFile([
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID;VALUE=TEXT:event-1',
    'SUMMARY;LANGUAGE=en:Planning meeting',
    'DESCRIPTION;ALTREP="cid:notes":Discuss roadmap',
    'CATEGORIES;LANGUAGE=en:work,planning',
    'END:VEVENT',
    'BEGIN:VTODO',
    'UID;VALUE=TEXT:todo-1',
    'SUMMARY;LANGUAGE=en:Follow up',
    'STATUS;VALUE=TEXT:COMPLETED',
    'CATEGORIES;LANGUAGE=en:admin',
    'END:VTODO',
    'END:VCALENDAR',
  ].join('\n'));

  assert.equal(events.length, 2);
  assert.equal(events[0].uid, 'event-1');
  assert.equal(events[0].summary, 'Planning meeting');
  assert.equal(events[0].description, 'Discuss roadmap');
  assert.deepEqual(events[0].categories, ['work', 'planning']);
  assert.equal(events[1].uid, 'todo-1');
  assert.equal(events[1].summary, 'Follow up');
  assert.equal(events[1].status, 'COMPLETED');
  assert.deepEqual(events[1].categories, ['admin']);
});

test('caldav-sync: ignores impossible VEVENT dates', () => {
  const events = parseICSFile([
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:event-1',
    'SUMMARY:Planning meeting',
    'DTSTART;VALUE=DATE:20260231',
    'DTEND:20260615T246000Z',
    'DUE:not-a-date',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\n'));

  assert.equal(events.length, 1);
  assert.equal(events[0].dtstart, undefined);
  assert.equal(events[0].dtend, undefined);
  assert.equal(events[0].due, undefined);
});

test('caldav-sync: ignores invalid VEVENT priority values', () => {
  const events = parseICSFile([
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:event-1',
    'SUMMARY:Planning meeting',
    'PRIORITY:1abc',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\n'));

  assert.equal(events.length, 1);
  assert.equal(events[0].priority, undefined);
});

test('caldav-sync: formats VTODOs inside VCALENDAR', () => {
  const vcal = formatCalendarICS([generateVTODO(task('- [ ] Simple task'))]);

  assert.ok(vcal.startsWith('BEGIN:VCALENDAR'));
  assert.ok(vcal.includes('BEGIN:VTODO'));
  assert.ok(vcal.endsWith('END:VCALENDAR'));
});

test('caldav-sync: converts CalendarEvent to task line', () => {
  const line = calendarEventToTaskLine({
    uid: 'event-1',
    summary: 'Client call',
    due: '2026-06-15',
    priority: 1,
    categories: ['work', 'calls'],
  });

  assert.ok(line.startsWith('- [ ] Client call'));
  assert.ok(line.includes('📅 2026-06-15'));
  assert.ok(line.includes('#work'));
  assert.ok(line.includes('[id:: event-1]'));
});

test('caldav-sync: handles tasks without dates', () => {
  const vtodo = generateVTODO(task('- [ ] Simple task'));

  assert.ok(vtodo.includes('SUMMARY:Simple task'));
  assert.ok(!vtodo.includes('\r\nDUE:'));
});

test('caldav-sync: escapes and unescapes special characters in VTODO', () => {
  const original = 'Task with, commas; and \\slashes';
  const vtodo = generateVTODO(task(`- [ ] ${original}`));
  const parsed = parseVTODO(vtodo);

  assert.ok(vtodo.includes('SUMMARY:Task with\\, commas\\; and \\\\slashes'));
  assert.equal(parsed?.normalizedText, original);
});

test('caldav-sync: preserves literal backslash escape sequences in VTODO text', () => {
  const original = String.raw`Keep literal \n marker and \; separator`;
  const vtodo = generateVTODO(task(`- [ ] ${original}`));
  const parsed = parseVTODO(vtodo);

  assert.ok(vtodo.includes(String.raw`SUMMARY:Keep literal \\n marker and \\\; separator`));
  assert.equal(parsed?.normalizedText, original);
});

test('caldav-sync: folds long generated VTODO lines and parses them back', () => {
  const original = 'Long task title '.repeat(8).trim();
  const vtodo = generateVTODO(task(`- [ ] ${original}`));
  const summaryLines = vtodo.split('\r\n').filter((line) => line.startsWith('SUMMARY:') || line.startsWith(' '));
  const parsed = parseVTODO(vtodo);
  const vcal = formatCalendarICS([vtodo]);

  assert.ok(summaryLines.length > 1, `Expected folded SUMMARY line, got:\n${vtodo}`);
  for (const line of vcal.split('\r\n')) {
    assert.ok(Buffer.byteLength(line, 'utf8') <= 75, `ICS line exceeds 75 octets: ${line}`);
  }
  assert.equal(parsed?.normalizedText, original);
  assert.equal(parseICSFile(vcal)[0].summary, original);
});

test('caldav-sync: parseVTODO unfolds folded summary lines', () => {
  const parsed = parseVTODO([
    'BEGIN:VTODO',
    'UID:folded-1',
    'SUMMARY:Folded task with a long',
    ' continuation',
    'DUE;VALUE=DATE:20260615',
    'END:VTODO',
  ].join('\r\n'));

  assert.equal(parsed?.normalizedText, 'Folded task with a longcontinuation');
  assert.equal(parsed?.metadata?.dates.due, '2026-06-15');
});

test('caldav-sync: parseVTODO reads properties with parameters', () => {
  const parsed = parseVTODO([
    'BEGIN:VTODO',
    'UID;VALUE=TEXT:todo-1',
    'SUMMARY;LANGUAGE=en:Parameterized task',
    'DESCRIPTION;ALTREP="cid:notes":With notes',
    'PRIORITY;VALUE=INTEGER:3',
    'STATUS;VALUE=TEXT:IN-PROCESS',
    String.raw`CATEGORIES;LANGUAGE=en:Work\,Personal,Next`,
    'RRULE;VALUE=RECUR:FREQ=WEEKLY',
    'END:VTODO',
  ].join('\n'));

  assert.equal(parsed?.metadata?.id, 'todo-1');
  assert.equal(parsed?.normalizedText, 'Parameterized task — With notes');
  assert.equal(parsed?.metadata?.priority, 'highest');
  assert.equal(parsed?.status, 'in_progress');
  assert.deepEqual(parsed?.tags, ['work,personal', 'next']);
  assert.equal(parsed?.metadata?.recurrence, 'every week');
});

test('caldav-sync: invalid VTODO returns null', () => {
  assert.equal(parseVTODO('BEGIN:VEVENT\nSUMMARY:Not a task\nEND:VEVENT'), null);
});

test('caldav-sync: parseICSFile parses VTODO blocks (round-trip)', () => {
  const vtodo = generateVTODO(task('- [ ] Team standup 📅 2026-06-15'));
  const icsContent = formatCalendarICS([vtodo]);
  const events = parseICSFile(icsContent);

  assert.equal(events.length, 1);
  assert.equal(events[0].summary, 'Team standup');
  assert.equal(events[0].due, '2026-06-15');
});

test('caldav-sync: parseICSFile unescapes text fields for imported events', () => {
  const events = parseICSFile([
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:event\\,1',
    'SUMMARY:Task with\\, comma\\; semicolon and \\\\slash',
    'DESCRIPTION:Line one\\nLine two',
    'CATEGORIES:work\\,personal,planning\\;next',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\n'));

  assert.equal(events.length, 1);
  assert.equal(events[0].uid, 'event,1');
  assert.equal(events[0].summary, 'Task with, comma; semicolon and \\slash');
  assert.equal(events[0].description, 'Line one\nLine two');
  assert.deepEqual(events[0].categories, ['work,personal', 'planning;next']);
});

test('caldav-sync: parseICSFile maps VTODO STATUS:COMPLETED to checkbox', () => {
  const vtodo = generateVTODO(task('- [x] Done task'));
  const icsContent = formatCalendarICS([vtodo]);
  const events = parseICSFile(icsContent);

  assert.equal(events.length, 1);
  assert.equal(events[0].status, 'COMPLETED');
  const line = calendarEventToTaskLine(events[0]);
  assert.ok(line.startsWith('- [x]'), `Expected completed checkbox, got: ${line}`);
});

test('caldav-sync: round-trips the COMPLETED timestamp through parseICSFile/calendarEventToTaskLine', () => {
  const vtodo = generateVTODO(task('- [x] Done task ✅ 2026-06-10'));
  const icsContent = formatCalendarICS([vtodo]);
  const events = parseICSFile(icsContent);

  assert.equal(events.length, 1);
  assert.equal(events[0].completed, '2026-06-10', 'COMPLETED should be parsed back as a plain date');
  const line = calendarEventToTaskLine(events[0]);
  assert.ok(line.includes('✅ 2026-06-10'), `Expected the done date to survive import, got: ${line}`);
});

test('caldav-sync: parseICSFile ignores COMPLETED on non-completed VTODOs', () => {
  const events = parseICSFile([
    'BEGIN:VCALENDAR',
    'BEGIN:VTODO',
    'UID:no-complete',
    'SUMMARY:Not done',
    'STATUS:NEEDS-ACTION',
    'END:VTODO',
    'END:VCALENDAR',
  ].join('\n'));

  assert.equal(events.length, 1);
  assert.equal(events[0].completed, undefined);
  assert.equal(calendarEventToTaskLine(events[0]).includes('✅'), false);
});

test('caldav-sync: parseICSFile normalizes VTODO status values case-insensitively', () => {
  const events = parseICSFile([
    'BEGIN:VCALENDAR',
    'BEGIN:VTODO',
    'UID:lower-status',
    'SUMMARY:Lower status import',
    'STATUS:completed',
    'END:VTODO',
    'END:VCALENDAR',
  ].join('\n'));

  assert.equal(events.length, 1);
  assert.equal(events[0].status, 'COMPLETED');
  const line = calendarEventToTaskLine(events[0]);
  assert.ok(line.startsWith('- [x]'), `Expected completed checkbox, got: ${line}`);
});

test('caldav-sync: calendarEventToTaskLine preserves VTODO status markers', () => {
  assert.ok(calendarEventToTaskLine({ uid: 'todo-1', summary: 'Open', status: 'NEEDS-ACTION' }).startsWith('- [ ]'));
  assert.ok(calendarEventToTaskLine({ uid: 'todo-2', summary: 'Started', status: 'IN-PROCESS' }).startsWith('- [/]'));
  assert.ok(calendarEventToTaskLine({ uid: 'todo-3', summary: 'Done', status: 'COMPLETED' }).startsWith('- [x]'));
  assert.ok(calendarEventToTaskLine({ uid: 'todo-4', summary: 'Cancelled', status: 'CANCELLED' }).startsWith('- [-]'));
});

test('caldav-sync: calendarEventToTaskLine preserves zero-minute alarms', () => {
  const line = calendarEventToTaskLine({ uid: 'todo-5', summary: 'Reminder', alarm: 0 });
  assert.ok(line.includes('⏰ alarm-0m'), `Expected zero-minute alarm to be preserved, got: ${line}`);
});

test('caldav-sync: tasksToICS escapes summary text fields', () => {
  const ics = tasksToICS([{ summary: 'Task with, comma; semicolon \\ slash\nand newline' }]);
  const events = parseICSFile(ics);

  assert.match(ics, /SUMMARY:Task with\\, comma\\; semicolon \\\\ slash\\nand newline/u);
  assert.equal(events[0].summary, 'Task with, comma; semicolon \\ slash\nand newline');
});

test('caldav-sync: tasksToICS emits VEVENTs with UID and DTSTAMP', () => {
  const ics = tasksToICS([{ summary: 'Calendar item' }]);
  assert.match(ics, /^UID:task-Calendar-item-[A-Za-z0-9]{8}$/m);
  assert.match(ics, /^DTSTAMP:\d{8}T\d{6}Z$/m);
});

test('caldav-sync: tasksToICS writes date-only due dates as VALUE=DATE', () => {
  const ics = tasksToICS([{ summary: 'Calendar item', due: '2026-06-15' }]);
  assert.match(ics, /DUE;VALUE=DATE:20260615/u);
});

test('caldav-sync: parseICSFile parses VEVENT and VTODO blocks in same calendar', () => {
  const vtodo = generateVTODO(task('- [ ] Todo task'));
  const vevent = [
    'BEGIN:VEVENT',
    'UID:evt-1',
    'SUMMARY:Calendar event',
    'DTSTART;VALUE=DATE:20260615',
    'DTEND;VALUE=DATE:20260616',
    'END:VEVENT',
  ].join('\r\n');
  const combined = ['BEGIN:VCALENDAR', 'VERSION:2.0', vtodo, vevent, 'END:VCALENDAR'].join('\r\n');
  const events = parseICSFile(combined);

  assert.equal(events.length, 2);
  const titles = events.map((e) => e.summary).sort();
  assert.deepEqual(titles, ['Calendar event', 'Todo task']);
});

test('caldav-sync: syncTasksToCalDAV reads first and returns only reconciled VTODO count', async () => {
  const calls: string[] = [];
  const client = {
    get: async () => {
      calls.push('GET');
      return { status: 'success', resource: { content: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR', etag: '"v1"' } };
    },
    put: async (_path: string, _content: string, precondition: unknown) => {
      calls.push('PUT');
      assert.deepEqual(precondition, { kind: 'match', etag: '"v1"' });
      return { status: 'success', statusCode: 204 };
    },
  } as never;
  const exportTask = task('- [ ] Export me [id:: export-me]');
  const skippedTask = task('- [ ] Skip me');
  skippedTask.metadata.excludeFromSync = true;
  const count = await syncTasksToCalDAV(client, [exportTask, skippedTask], 'Calendar/Feed.ics');
  assert.equal(count, 1);
  assert.deepEqual(calls, ['GET', 'PUT']);
});

test('caldav-sync: syncTasksFromCalDAV replaces its managed section idempotently', async () => {
  const targetPath = 'CalDAV.md';
  const file = fileForPath(targetPath);
  let content = '# Notes\n- [ ] Existing\n';
  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => path === targetPath ? file : null,
      read: async () => content,
      modify: async (_file: TFile, next: string) => { content = next; },
      create: async (_path: string, next: string) => { content = next; return file; },
      process: async (_file: TFile, updater: (current: string) => string) => { content = updater(content); return content; },
    },
  } as never;
  const client = {
    get: async () => ({ status: 'success', resource: { content: [
      'BEGIN:VCALENDAR',
      'BEGIN:VTODO',
      'UID:event-1',
      'SUMMARY:Remote task',
      'END:VTODO',
      'END:VCALENDAR',
    ].join('\n'), etag: '"v1"' } }),
  } as never;

  await syncTasksFromCalDAV(app, client, '/calendar.ics', targetPath, 'vault-first');
  const once = content;
  await syncTasksFromCalDAV(app, client, '/calendar.ics', targetPath, 'vault-first');

  assert.equal(content, once);
  assert.equal(content.match(/^# Synced from CalDAV$/gum)?.length, 1);
  assert.equal(content.match(/Remote task/gum)?.length, 1);
  assert.ok(content.includes('# Notes\n- [ ] Existing'));
});

test('caldav-sync: syncTasksFromCalDAV preserves content under level-two headings after service-first syncs', async () => {
  const targetPath = 'CalDAV.md';
  const file = fileForPath(targetPath);
  let content = '## Notes\n- [ ] Existing\n';
  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => path === targetPath ? file : null,
      read: async () => content,
      modify: async (_file: TFile, next: string) => { content = next; },
      create: async (_path: string, next: string) => { content = next; return file; },
      process: async (_file: TFile, updater: (current: string) => string) => { content = updater(content); return content; },
    },
  } as never;
  const client = {
    get: async () => ({ status: 'success', resource: { content: [
      'BEGIN:VCALENDAR',
      'BEGIN:VTODO',
      'UID:event-1',
      'SUMMARY:Remote task',
      'END:VTODO',
      'END:VCALENDAR',
    ].join('\n'), etag: '"v1"' } }),
  } as never;

  await syncTasksFromCalDAV(app, client, '/calendar.ics', targetPath, 'service-first');
  await syncTasksFromCalDAV(app, client, '/calendar.ics', targetPath, 'service-first');

  assert.equal(content.match(/^# Synced from CalDAV$/gum)?.length, 1);
  assert.equal(content.match(/Remote task/gum)?.length, 1);
  assert.ok(content.includes('## Notes\n- [ ] Existing'));
});

test('caldav-sync: syncTasksFromCalDAV preserves concurrent edits while writing', async () => {
  const targetPath = 'CalDAV.md';
  const file = fileForPath(targetPath);
  let content = '# Notes\n- [ ] Existing\n';
  let simulatedConcurrentEdit = false;
  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => path === targetPath ? file : null,
      read: async () => {
        const stale = content;
        if (!simulatedConcurrentEdit) {
          simulatedConcurrentEdit = true;
          content += '- [ ] Concurrent edit\n';
        }
        return stale;
      },
      modify: async (_file: TFile, next: string) => { content = next; },
      create: async (_path: string, next: string) => { content = next; return file; },
      process: async (_file: TFile, updater: (current: string) => string) => {
        if (!simulatedConcurrentEdit) {
          simulatedConcurrentEdit = true;
          content += '- [ ] Concurrent edit\n';
        }
        content = updater(content);
        return content;
      },
    },
  } as never;
  const client = {
    get: async () => ({ status: 'success', resource: { content: [
      'BEGIN:VCALENDAR',
      'BEGIN:VTODO',
      'UID:event-1',
      'SUMMARY:Remote task',
      'END:VTODO',
      'END:VCALENDAR',
    ].join('\n'), etag: '"v1"' } }),
  } as never;

  await syncTasksFromCalDAV(app, client, '/calendar.ics', targetPath, 'vault-first');

  assert.ok(content.includes('- [ ] Existing'));
  assert.ok(content.includes('- [ ] Concurrent edit'));
  assert.ok(content.includes('Remote task'));
});

test('caldav-sync: parseICSFile preserves mixed component order', () => {
  const events = parseICSFile([
    'BEGIN:VCALENDAR',
    'BEGIN:VTODO',
    'UID:todo-1',
    'SUMMARY:First todo',
    'END:VTODO',
    'BEGIN:VEVENT',
    'UID:event-1',
    'SUMMARY:Second event',
    'END:VEVENT',
    'BEGIN:VTODO',
    'UID:todo-2',
    'SUMMARY:Third todo',
    'END:VTODO',
    'END:VCALENDAR',
  ].join('\n'));

  assert.deepEqual(events.map((event) => event.summary), ['First todo', 'Second event', 'Third todo']);
});

test('caldav-sync: parseICSFile requires component markers to occupy full lines', () => {
  const events = parseICSFile([
    'BEGIN:VCALENDAR',
    'BEGIN:VEVENT',
    'UID:event-1',
    'SUMMARY:Visible event',
    'DESCRIPTION:literal BEGIN:VTODO text must not start a component',
    'END:VEVENT',
    'SUMMARY:literal END:VEVENT text must not close outside a line marker',
    'END:VCALENDAR',
  ].join('\n'));

  assert.deepEqual(events.map((event) => event.summary), ['Visible event']);
});

test('caldav-sync: reconciliation rejects nested or mismatched component boundaries', () => {
  const nested = [
    'BEGIN:VCALENDAR',
    'BEGIN:VTODO',
    'UID:outer',
    'BEGIN:VEVENT',
    'UID:inner',
    'END:VEVENT',
    'END:VTODO',
    'END:VCALENDAR',
  ].join('\n');
  assert.throws(() => reconcileCalendarICS(nested, []), /nested component boundaries/u);

  const mismatched = [
    'BEGIN:VCALENDAR',
    'BEGIN:VTODO',
    'UID:bad',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\n');
  assert.throws(() => reconcileCalendarICS(mismatched, []), /mismatched component boundaries/u);
});

test('caldav-sync: reconciliation preserves remote-only content, updates shared UID, and adds local-only UID', () => {
  const remoteOnlyEvent = ['BEGIN:VEVENT', 'UID:event-only', 'SUMMARY:Remote meeting', 'X-REMOTE-PROP:keep-me', 'END:VEVENT'].join('\r\n');
  const remoteOnlyTodo = ['BEGIN:VTODO', 'UID:remote-only', 'SUMMARY:Remote-only task', 'X-REMOTE-PROP:keep-me-too', 'END:VTODO'].join('\r\n');
  const sharedTodo = generateVTODO(task('- [ ] Old shared title [id:: shared-uid]'));
  const remote = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'X-WR-CALNAME:Shared calendar', remoteOnlyEvent, remoteOnlyTodo, sharedTodo, 'END:VCALENDAR'].join('\r\n');

  const result = reconcileCalendarICS(remote, [
    task('- [x] Updated shared title [id:: shared-uid]'),
    task('- [ ] Local-only task [id:: local-only]'),
  ]);

  assert.equal(result.managedCount, 2);
  assert.equal(result.changed, true);
  assert.ok(result.content.includes('X-WR-CALNAME:Shared calendar'));
  assert.ok(result.content.includes(remoteOnlyEvent), 'remote-only VEVENT must remain byte-for-byte intact');
  assert.ok(result.content.includes(remoteOnlyTodo), 'remote-only VTODO must remain byte-for-byte intact');
  assert.ok(result.content.includes('UID:shared-uid'));
  assert.ok(result.content.includes('SUMMARY:Updated shared title'));
  assert.ok(!result.content.includes('SUMMARY:Old shared title'));
  assert.ok(result.content.includes('UID:local-only'));
  assert.ok(result.content.includes('SUMMARY:Local-only task'));
});

test('caldav-sync: service-first preserves the remote component for a matching UID', () => {
  const remoteComponent = ['BEGIN:VTODO', 'UID:shared-uid', 'SUMMARY:Remote title', 'X-REMOTE-PROP:keep', 'END:VTODO'].join('\r\n');
  const remote = ['BEGIN:VCALENDAR', 'VERSION:2.0', remoteComponent, 'END:VCALENDAR'].join('\r\n');

  assert.throws(() => reconcileCalendarICS(remote, [task('- [ ] Local title [id:: shared-uid]')], 'service-first'), /no verified baseline/u);
  assert.ok(remote.includes(remoteComponent));
});

test('caldav-sync: repeated vault-first reconciliation ignores DTSTAMP-only regeneration', () => {
  const initial = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR';
  const identified = task('- [ ] Stable task 📅 2026-06-15 [id:: stable-id]');

  const first = reconcileCalendarICS(initial, [identified], 'vault-first');
  assert.equal(first.changed, true);
  const second = reconcileCalendarICS(first.content, [identified], 'vault-first');

  assert.equal(second.changed, false);
  assert.equal(second.content, first.content, 'an unchanged matching task must preserve its prior component');
  assert.equal(second.content.match(/^UID:stable-id$/gum)?.length, 1);
});

test('caldav-sync: unchanged matching task performs no whole-calendar PUT', async () => {
  const identified = task('- [ ] Stable task 📅 2026-06-15 [id:: stable-id]');
  const seeded = reconcileCalendarICS('BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR', [identified]).content;
  let putCalled = false;
  let vaultContent = '';
  const client = {
    get: async () => ({ status: 'success', resource: { content: seeded, etag: '"v1"' } }),
    put: async () => { putCalled = true; return { status: 'success', statusCode: 204 }; },
  } as never;
  const app = { vault: {
    getAbstractFileByPath: () => fileForPath('CalDAV.md'),
    process: async (_file: TFile, updater: (current: string) => string) => { vaultContent = updater(vaultContent); },
  } } as never;

  const result = await syncTasksWithCalDAV(app, client, [identified], '/calendar.ics', 'CalDAV.md', 'vault-first');

  assert.equal(result.status, 'success');
  assert.ok(result.status === 'success' && result.remoteChanged === false);
  assert.equal(putCalled, false);
  assert.ok(vaultContent.includes('Stable task'));
});

test('caldav-sync: line shifts never create managed UIDs for tasks without explicit identity', () => {
  const remote = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR';
  const beforeShift = task('- [ ] Unidentified task');
  const afterShift = scanner().parseTaskLine('- [ ] Unidentified task', 'Test.md', 40);
  assert.ok(afterShift);

  const before = reconcileCalendarICS(remote, [beforeShift]);
  const after = reconcileCalendarICS(remote, [afterShift]);

  assert.equal(before.changed, false);
  assert.equal(after.changed, false);
  assert.equal(before.skippedCount, 1);
  assert.equal(after.skippedCount, 1);
  assert.equal(before.content, remote);
  assert.equal(after.content, remote);
  assert.ok(!before.content.includes('task-Test.md-L'));
  assert.ok(!after.content.includes('task-Test.md-L'));
});

test('caldav-sync: skipped unidentified tasks return a reviewable partial result', async () => {
  let putCalled = false;
  let vaultContent = '';
  const client = {
    get: async () => ({ status: 'success', resource: { content: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR', etag: '"v1"' } }),
    put: async () => { putCalled = true; return { status: 'success', statusCode: 204 }; },
  } as never;
  const app = { vault: {
    getAbstractFileByPath: () => fileForPath('CalDAV.md'),
    process: async (_file: TFile, updater: (current: string) => string) => { vaultContent = updater(vaultContent); },
  } } as never;

  const result = await syncTasksWithCalDAV(app, client, [task('- [ ] No explicit ID')], '/calendar.ics', 'CalDAV.md', 'vault-first');

  assert.deepEqual(result, { status: 'partial', uploaded: 0, skipped: 1, fetched: 0, reason: 'skipped' });
  assert.equal(putCalled, false);
  assert.ok(vaultContent.includes('# Synced from CalDAV'));
});

test('caldav-sync: explicit UID remains single and stable after a line shift', () => {
  const remote = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR';
  const beforeShift = task('- [ ] Identified task [id:: stable-id]');
  const afterShift = scanner().parseTaskLine('- [ ] Identified task [id:: stable-id]', 'Test.md', 40);
  assert.ok(afterShift);

  const first = reconcileCalendarICS(remote, [beforeShift]);
  const second = reconcileCalendarICS(first.content, [afterShift]);

  assert.equal(second.changed, false);
  assert.equal(second.content.match(/^UID:stable-id$/gum)?.length, 1);
  assert.ok(!second.content.includes('-L40'));
});

test('caldav-sync: managed import projection does not turn remote-only items into outbound managed tasks', async () => {
  const remote = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'BEGIN:VTODO', 'UID:remote-only', 'SUMMARY:Remote-only task', 'X-REMOTE-PROP:preserve', 'END:VTODO', 'END:VCALENDAR'].join('\n');
  const projected = scanner().parseTaskLine('- [ ] Remote-only task [id:: remote-only]', 'CalDAV.md', 2, 'Synced from CalDAV');
  assert.ok(projected);
  let putCalled = false;
  let vaultContent = '';
  const app = { vault: {
    getAbstractFileByPath: () => fileForPath('CalDAV.md'),
    process: async (_file: TFile, updater: (current: string) => string) => { vaultContent = updater(vaultContent); },
  } } as never;
  const client = {
    get: async () => ({ status: 'success', resource: { content: remote } }),
    put: async () => { putCalled = true; return { status: 'success', statusCode: 204 }; },
  } as never;

  const result = await syncTasksWithCalDAV(app, client, [projected], '/calendar.ics', 'CalDAV.md', 'vault-first');
  assert.equal(result.status, 'success');
  assert.ok(result.status === 'success' && result.uploaded === 0 && result.remoteChanged === false);
  assert.equal(putCalled, false);
  assert.ok(vaultContent.includes('Remote-only task'));
});

test('caldav-sync: changed ETag produces a typed conflict and does not update the vault', async () => {
  let vaultUpdated = false;
  const app = { vault: {
    getAbstractFileByPath: () => fileForPath('CalDAV.md'),
    process: async () => { vaultUpdated = true; },
  } } as never;
  const client = {
    get: async () => ({ status: 'success', resource: { content: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR', etag: '"read-version"' } }),
    put: async (_path: string, _content: string, precondition: unknown) => {
      assert.deepEqual(precondition, { kind: 'match', etag: '"read-version"' });
      return { status: 'conflict', statusCode: 412 };
    },
  } as never;

  const result = await syncTasksWithCalDAV(app, client, [task('- [ ] Local [id:: local]')], '/calendar.ics', 'CalDAV.md', 'vault-first');
  assert.deepEqual(result, { status: 'conflict', uploaded: 1, skipped: 0, fetched: 0, statusCode: 412 });
  assert.equal(vaultUpdated, false);
});

test('caldav-sync: missing server precondition fails safe before replacement', async () => {
  let putCalled = false;
  const client = {
    get: async () => ({ status: 'success', resource: { content: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR' } }),
    put: async () => { putCalled = true; return { status: 'success', statusCode: 204 }; },
  } as never;
  const result = await syncTasksWithCalDAV({} as never, client, [task('- [ ] Local [id:: local]')], '/calendar.ics', 'CalDAV.md', 'vault-first');
  assert.equal(result.status, 'failure');
  assert.ok(result.status === 'failure' && result.error instanceof CalDAVError);
  assert.ok(result.status === 'failure' && result.error.message.includes('refusing calendar replacement'));
  assert.equal(putCalled, false);
});

test('caldav-sync: failed read and failed write are typed failures, not zero-count success', async () => {
  const readFailure = new CalDAVError('HTTP 503', 'server', 'GET', 503);
  const failedRead = await syncTasksWithCalDAV(
    {} as never,
    { get: async () => { throw readFailure; } } as never,
    [task('- [ ] Local [id:: local]')],
    '/calendar.ics',
    'CalDAV.md',
    'vault-first',
  );
  assert.equal(failedRead.status, 'failure');
  assert.strictEqual(failedRead.status === 'failure' ? failedRead.error : undefined, readFailure);

  const writeFailure = new CalDAVError('HTTP 503', 'server', 'PUT', 503);
  const failedWrite = await syncTasksWithCalDAV(
    {} as never,
    {
      get: async () => ({ status: 'success', resource: { content: 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nEND:VCALENDAR', etag: '"v1"' } }),
      put: async () => { throw writeFailure; },
    } as never,
    [task('- [ ] Local [id:: local]')],
    '/calendar.ics',
    'CalDAV.md',
    'vault-first',
  );
  assert.equal(failedWrite.status, 'failure');
  assert.strictEqual(failedWrite.status === 'failure' ? failedWrite.error : undefined, writeFailure);
});

test('caldav-sync: transport GET 404 safely creates with If-None-Match', async () => {
  const originalRequestUrl = obsidianRuntime.requestUrl;
  const restoreFetch = bridgeRequestUrlMockToFetch();
  const calls: RequestUrlTestParams[] = [];
  obsidianRuntime.requestUrl = async (params) => {
    calls.push(params);
    assert.equal(params.throw, false);
    if (params.method === 'GET') return requestUrlResponse(404);
    assert.equal(params.method, 'PUT');
    assert.equal(params.headers?.['If-None-Match'], '*');
    return requestUrlResponse(201, '', { etag: '"created"' });
  };
  let vaultContent = '';
  const app = { vault: {
    getAbstractFileByPath: () => null,
    create: async (_path: string, content: string) => { vaultContent = content; return fileForPath('CalDAV.md'); },
    adapter: { mkdir: async () => undefined },
  } } as never;

  try {
    const client = new CalDAVClient('https://example.com', 'user', 'pass', undefined, true);
    const result = await syncTasksWithCalDAV(app, client, [task('- [ ] Create safely [id:: create-id]')], '/calendar.ics', 'CalDAV.md', 'vault-first');
    assert.equal(result.status, 'success');
    assert.ok(result.status === 'success' && result.uploaded === 1 && result.skipped === 0);
    assert.deepEqual(calls.map((call) => call.method), ['GET', 'PUT']);
    assert.ok(vaultContent.includes('[id:: create-id]'));
  } finally {
    restoreFetch();
    if (originalRequestUrl) obsidianRuntime.requestUrl = originalRequestUrl;
    else delete obsidianRuntime.requestUrl;
  }
});

test('caldav-sync: transport serializes underlying requests per origin', async () => {
  const originalRequestUrl = obsidianRuntime.requestUrl;
  const restoreFetch = bridgeRequestUrlMockToFetch();
  let releaseFirst: (() => void) | undefined;
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let calls = 0;
  obsidianRuntime.requestUrl = async () => {
    calls += 1;
    if (calls === 1) await firstGate;
    return requestUrlResponse(200, 'BEGIN:VCALENDAR\nEND:VCALENDAR');
  };
  try {
    const client = new CalDAVClient('https://example.com', 'user', 'pass', undefined, true);
    const first = client.get('/first.ics');
    const second = client.get('/second.ics');
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(calls, 1, 'a second request to the same origin must wait for the underlying first request');
    releaseFirst?.();
    await Promise.all([first, second]);
    assert.equal(calls, 2);
  } finally {
    releaseFirst?.();
    resetCalDavTransportGuardsForTests();
    restoreFetch();
    if (originalRequestUrl) obsidianRuntime.requestUrl = originalRequestUrl;
    else delete obsidianRuntime.requestUrl;
  }
});

test('caldav-sync: transport PUT 409 and 412 become typed conflicts', async () => {
  const originalRequestUrl = obsidianRuntime.requestUrl;
  const restoreFetch = bridgeRequestUrlMockToFetch();
  try {
    for (const statusCode of [409, 412] as const) {
      obsidianRuntime.requestUrl = async (params) => {
        assert.equal(params.throw, false);
        if (params.method === 'GET') return requestUrlResponse(404);
        assert.equal(params.headers?.['If-None-Match'], '*');
        return requestUrlResponse(statusCode);
      };
      const client = new CalDAVClient('https://example.com', 'user', 'pass', undefined, true);
      const result = await syncTasksWithCalDAV({} as never, client, [task('- [ ] Conflict [id:: conflict-id]')], '/calendar.ics', 'CalDAV.md', 'vault-first');
      assert.equal(result.status, 'conflict');
      assert.ok(result.status === 'conflict' && result.statusCode === statusCode);
    }
  } finally {
    restoreFetch();
    if (originalRequestUrl) obsidianRuntime.requestUrl = originalRequestUrl;
    else delete obsidianRuntime.requestUrl;
  }
});

test('caldav-sync: transport 401 and 5xx responses retain typed classification', async () => {
  const originalRequestUrl = obsidianRuntime.requestUrl;
  const restoreFetch = bridgeRequestUrlMockToFetch();
  try {
    for (const [statusCode, kind] of [[401, 'authentication'], [503, 'server']] as const) {
      obsidianRuntime.requestUrl = async (params) => {
        assert.equal(params.throw, false);
        return requestUrlResponse(statusCode);
      };
      const client = new CalDAVClient('https://example.com', 'user', 'pass', undefined, true);
      await assert.rejects(
        () => client.get('/calendar.ics'),
        (error: unknown) => error instanceof CalDAVError && error.kind === kind && error.statusCode === statusCode,
      );
    }
  } finally {
    restoreFetch();
    if (originalRequestUrl) obsidianRuntime.requestUrl = originalRequestUrl;
    else delete obsidianRuntime.requestUrl;
  }
});

test('caldav-sync: transport rejections are network failures without masking typed deadline errors', async () => {
  const originalRequestUrl = obsidianRuntime.requestUrl;
  const restoreFetch = bridgeRequestUrlMockToFetch();
  try {
    obsidianRuntime.requestUrl = async () => { throw new Error('socket closed'); };
    const client = new CalDAVClient('https://example.com', 'user', 'pass', undefined, true);
    await assert.rejects(
      () => client.get('/calendar.ics'),
      (error: unknown) => error instanceof CalDAVError && error.kind === 'network' && error.operation === 'GET',
    );

    const timeout = new CalDAVError('caller deadline', 'timeout', 'GET');
    obsidianRuntime.requestUrl = async () => { throw timeout; };
    await assert.rejects(() => client.get('/calendar.ics'), (error: unknown) => error === timeout);
  } finally {
    resetCalDavTransportGuardsForTests();
    restoreFetch();
    if (originalRequestUrl) obsidianRuntime.requestUrl = originalRequestUrl;
    else delete obsidianRuntime.requestUrl;
  }
});

test('caldav-sync: parent abort is prompt, aborts fetch, and does not trip the origin circuit', async () => {
  const originalFetch = globalThis.fetch;
  const entered = deferred<void>();
  const release = deferred<Response>();
  const parent = new AbortController();
  let transportSignal: AbortSignal | undefined;
  let calls = 0;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    transportSignal = init?.signal as AbortSignal | undefined;
    if (calls === 1) { entered.resolve(); return release.promise; }
    return new Response('BEGIN:VCALENDAR\nEND:VCALENDAR', { status: 200 });
  }) as typeof fetch;
  try {
    const first = new CalDAVClient('https://cancel.example.com', 'user', 'pass', undefined, true, parent.signal).get('/calendar.ics');
    await entered.promise;
    parent.abort();
    await assert.rejects(first, (error: unknown) => error instanceof CalDAVError && error.kind === 'cancelled');
    assert.equal(transportSignal?.aborted, true);
    release.resolve(new Response('BEGIN:VCALENDAR\nEND:VCALENDAR', { status: 200 }));
    await new CalDAVClient('https://cancel.example.com', 'user', 'pass', undefined, true).get('/calendar.ics');
    assert.equal(calls, 2, 'parent cancellation must not open the origin circuit');
  } finally {
    release.resolve(new Response('', { status: 200 }));
    resetCalDavTransportGuardsForTests();
    globalThis.fetch = originalFetch;
  }
});

test('caldav-sync: queued parent abort rejects promptly and never starts out of order', async () => {
  const originalFetch = globalThis.fetch;
  const firstEntered = deferred<void>();
  const firstRelease = deferred<Response>();
  const secondParent = new AbortController();
  let calls = 0;
  globalThis.fetch = (async () => {
    calls += 1;
    if (calls === 1) { firstEntered.resolve(); return firstRelease.promise; }
    return new Response('BEGIN:VCALENDAR\nEND:VCALENDAR', { status: 200 });
  }) as typeof fetch;
  try {
    const first = new CalDAVClient('https://queue-cancel.example.com', 'user', 'pass', undefined, true).get('/a.ics');
    await firstEntered.promise;
    const second = new CalDAVClient('https://queue-cancel.example.com', 'user', 'pass', undefined, true, secondParent.signal).get('/b.ics');
    secondParent.abort();
    await assert.rejects(second, (error: unknown) => error instanceof CalDAVError && error.kind === 'cancelled');
    assert.equal(calls, 1, 'queued cancelled request must not start before the active request settles');
    firstRelease.resolve(new Response('BEGIN:VCALENDAR\nEND:VCALENDAR', { status: 200 }));
    await first;
    await Promise.resolve();
    assert.equal(calls, 1, 'queued cancelled request must never start');
  } finally {
    firstRelease.resolve(new Response('', { status: 200 }));
    resetCalDavTransportGuardsForTests();
    globalThis.fetch = originalFetch;
  }
});

test('caldav-sync: stale run context blocks deferred GET and PUT from vault publication', async (t) => {
  await t.test('GET', async () => {
    const read = deferred<{ status: 'success'; resource: { content: string; etag: string } }>();
    let puts = 0;
    let vaultCalls = 0;
    let current = true;
    const client = { get: async () => read.promise, put: async () => { puts += 1; return { status: 'success', statusCode: 204 } as const; } };
    const run = syncTasksWithCalDAV({ vault: { getAbstractFileByPath: () => null, create: async () => { vaultCalls += 1; } } } as never, client as never, [task('- [ ] Local [id:: local]')], '/calendar.ics', 'Sync.md', 'vault-first', undefined, { isCurrent: () => current });
    current = false;
    read.resolve({ status: 'success', resource: { content: 'BEGIN:VCALENDAR\nEND:VCALENDAR', etag: '"v1"' } });
    assert.equal((await run).status, 'cancelled');
    assert.equal(puts, 0);
    assert.equal(vaultCalls, 0);
  });
  await t.test('PUT', async () => {
    const putEntered = deferred<void>();
    const putRelease = deferred<{ status: 'success'; statusCode: number }>();
    let vaultCalls = 0;
    let current = true;
    const client = {
      get: async () => ({ status: 'success', resource: { content: 'BEGIN:VCALENDAR\nEND:VCALENDAR', etag: '"v1"' } }),
      put: async () => { putEntered.resolve(); return putRelease.promise; },
    };
    const run = syncTasksWithCalDAV({ vault: { getAbstractFileByPath: () => null, create: async () => { vaultCalls += 1; } } } as never, client as never, [task('- [ ] Local [id:: local]')], '/calendar.ics', 'Sync.md', 'vault-first', undefined, { isCurrent: () => current });
    await putEntered.promise;
    current = false;
    putRelease.resolve({ status: 'success', statusCode: 204 });
    assert.equal((await run).status, 'cancelled');
    assert.equal(vaultCalls, 0);
  });
});

test('caldav-sync: CalDAVClient surfaces 401 and 503 with typed failure kinds', async () => {
  const originalFetch = globalThis.fetch;
  try {
    for (const [status, kind] of [[401, 'authentication'], [503, 'server']] as const) {
      globalThis.fetch = (async () => ({ ok: false, status, headers: new Headers(), text: async () => '' }) as Response) as typeof fetch;
      const client = new CalDAVClient('https://example.com', 'user', 'pass', undefined, true);
      await assert.rejects(
        () => client.get('/calendar.ics'),
        (error: unknown) => error instanceof CalDAVError && error.kind === kind && error.statusCode === status,
      );
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('caldav-sync: fetch fallback streams through the response bound and forbids redirects', async () => {
  const originalRequestUrl = obsidianRuntime.requestUrl;
  const originalFetch = globalThis.fetch;
  delete obsidianRuntime.requestUrl;
  let pulls = 0;
  try {
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      assert.equal(init?.redirect, 'error');
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          pulls += 1;
          controller.enqueue(new Uint8Array(1024 * 1024));
          if (pulls >= 10) controller.close();
        },
      });
      return new Response(body, { status: 200 });
    }) as typeof fetch;
    const client = new CalDAVClient('https://stream.example.com', 'user', 'pass', undefined, true);
    await assert.rejects(
      () => client.get('/large.ics'),
      (error: unknown) => error instanceof CalDAVError && error.kind === 'response-too-large',
    );
    assert.ok(pulls <= 7, `stream consumption should stop near the 5 MiB bound (pulled ${pulls} chunks)`);
  } finally {
    resetCalDavTransportGuardsForTests();
    globalThis.fetch = originalFetch;
    if (originalRequestUrl) obsidianRuntime.requestUrl = originalRequestUrl;
  }
});

test('caldav-sync: declared oversized responses trip a typed per-origin circuit', async () => {
  const originalRequestUrl = obsidianRuntime.requestUrl;
  const restoreFetch = bridgeRequestUrlMockToFetch();
  let transportSignal: AbortSignal | null | undefined;
  obsidianRuntime.requestUrl = async (params) => {
    transportSignal = params.signal;
    return requestUrlResponse(200, '', { 'content-length': String(6 * 1024 * 1024) });
  };
  try {
    const client = new CalDAVClient('https://oversized.example.com', 'user', 'pass', undefined, true);
    await assert.rejects(
      () => client.get('/large.ics'),
      (error: unknown) => error instanceof CalDAVError && error.kind === 'response-too-large',
    );
    assert.equal(transportSignal?.aborted, true, 'declared oversized responses must abort the active transport');
    await assert.rejects(
      () => client.get('/another.ics'),
      (error: unknown) => error instanceof CalDAVError && error.kind === 'circuit-open',
    );
  } finally {
    resetCalDavTransportGuardsForTests();
    restoreFetch();
    if (originalRequestUrl) obsidianRuntime.requestUrl = originalRequestUrl;
    else delete obsidianRuntime.requestUrl;
  }
});

test('caldav-sync: CalDAVClient requires HTTPS, clean URLs, and explicit endpoint trust', () => {
  assert.equal(isAllowedCalDavServerUrl('http://example.com/caldav'), false);
  assert.equal(isAllowedCalDavServerUrl('https://example.com/caldav?calendar=work'), false);
  assert.equal(isAllowedCalDavServerUrl('https://example.com/caldav?calendar=work', true), true);
  assert.equal(isAllowedCalDavServerUrl('https://user:pass@example.com/caldav'), false);
  assert.equal(isAllowedCalDavServerUrl('https://example.com/caldav#fragment'), false);
  assert.equal(isPrivateCalDavServerUrl('https://127.0.0.1/caldav'), true);
  assert.equal(isPrivateCalDavServerUrl('https://192.168.1.10/caldav'), true);
  assert.equal(isPrivateCalDavServerUrl('https://[::1]/caldav'), true);
  assert.equal(isPrivateCalDavServerUrl('https://[::ffff:127.0.0.1]/caldav'), true);
  assert.equal(isAllowedCalDavServerUrl('https://[::ffff:127.0.0.1]/caldav'), false);
  assert.equal(isPrivateCalDavServerUrl('https://calendar.example.com/caldav'), false);
  assert.equal(isAllowedCalDavServerUrl('https://127.0.0.1/caldav'), false);
  assert.equal(isAllowedCalDavServerUrl('https://127.0.0.1/caldav', true), true);
  assert.throws(() => new CalDAVClient('http://example.com', 'user', 'pass'), /must use HTTPS/u);
  assert.throws(() => new CalDAVClient('https://user:pass@example.com', 'user', 'pass'), /embedded credentials/u);
  assert.throws(() => new CalDAVClient('https://example.com/#fragment', 'user', 'pass'), /fragment/u);
  assert.throws(() => new CalDAVClient('https://example.com/caldav', 'user', 'pass'), /explicit trust/u);
  assert.throws(() => new CalDAVClient('https://localhost/caldav', 'user', 'pass'), /explicit trust/u);
  assert.doesNotThrow(() => new CalDAVClient('https://example.com/caldav', 'user', 'pass', undefined, true));
  assert.doesNotThrow(() => new CalDAVClient('https://localhost/caldav', 'user', 'pass', undefined, true));
});

test('caldav-sync: CalDAVClient getAuthHeader uses UTF-8-safe base64 for non-ASCII passwords', async () => {
  // btoa('user:\u5bc6\u7801') would throw InvalidCharacterError; the UTF-8+btoa path must not throw
  const originalFetch = globalThis.fetch;
  let capturedAuth = '';
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    capturedAuth = (init?.headers as Record<string, string>)?.['Authorization'] ?? '';
    return { ok: true, status: 200, text: async () => '' } as Response;
  }) as typeof fetch;

  try {
    const client = new CalDAVClient('https://example.com', 'user', '\u5bc6\u7801', undefined, true);
    await client.get('/calendar/task.ics');
    // Must not throw; must return a valid Basic auth header
    assert.ok(capturedAuth.startsWith('Basic '), `Expected Basic auth, got: ${capturedAuth}`);
    // Decode and verify round-trip using Node Buffer (UTF-8 decode)
    const decoded = Buffer.from(capturedAuth.slice(6), 'base64').toString('utf8');
    assert.equal(decoded, 'user:\u5bc6\u7801');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('caldav-sync: CalDAVClient constructs with real class API', async () => {
  const originalFetch = globalThis.fetch;
  const calls: Array<{ method?: string; url: string }> = [];
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), method: init?.method });
    return {
      ok: true,
      status: 200,
      text: async () => '<D:href>/calendar/task.ics</D:href>',
    } as Response;
  }) as typeof fetch;

  try {
    const client = new CalDAVClient('https://example.com', 'user', 'pass', undefined, true);
    const hrefs = await client.propfind('/calendar/');
    assert.deepEqual(hrefs, ['/calendar/task.ics']);
    assert.equal(calls[0].method, 'PROPFIND');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('caldav-sync: CalDAVClient accepts namespace variants in PROPFIND hrefs', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    text: async () => [
      '<d:multistatus xmlns:d="DAV:">',
      '  <d:response><d:href>/calendar/lowercase.ics</d:href></d:response>',
      '  <response xmlns="DAV:"><href>/calendar/default-namespace.ics</href></response>',
      '</d:multistatus>',
    ].join('\n'),
  }) as Response) as typeof fetch;

  try {
    const client = new CalDAVClient('https://example.com', 'user', 'pass', undefined, true);
    const hrefs = await client.propfind('/calendar/');
    assert.deepEqual(hrefs, ['/calendar/lowercase.ics', '/calendar/default-namespace.ics']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('caldav-sync: CalDAVClient decodes XML entities in PROPFIND hrefs', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    text: async () => '<D:href>/calendar/task.ics?sync-token=a&amp;page=2</D:href>',
  }) as Response) as typeof fetch;

  try {
    const client = new CalDAVClient('https://example.com', 'user', 'pass', undefined, true);
    const hrefs = await client.propfind('/calendar/');
    assert.deepEqual(hrefs, ['/calendar/task.ics?sync-token=a&page=2']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('caldav-sync: CalDAVClient decodes numeric XML entities in PROPFIND hrefs', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    status: 200,
    text: async () => '<D:href>/calendar/task.ics?sync-token=a&#38;page=2&#x26;cursor=3</D:href>',
  }) as Response) as typeof fetch;

  try {
    const client = new CalDAVClient('https://example.com', 'user', 'pass', undefined, true);
    const hrefs = await client.propfind('/calendar/');
    assert.deepEqual(hrefs, ['/calendar/task.ics?sync-token=a&page=2&cursor=3']);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('caldav-sync: CalDAVClient preserves href query strings in resource requests', async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return { ok: true, status: 200, text: async () => 'BEGIN:VCALENDAR\nEND:VCALENDAR' } as Response;
  }) as typeof fetch;

  try {
    const client = new CalDAVClient('https://example.com/dav/user/', 'user', 'pass', undefined, true);
    await client.get('/calendar/task.ics?sync-token=a&page=2');
    await client.put('/calendar/task.ics?sync-token=a&page=2', 'BEGIN:VCALENDAR\nEND:VCALENDAR', { kind: 'match', etag: '"v1"' });

    assert.deepEqual(calls, [
      'https://example.com/calendar/task.ics?sync-token=a&page=2',
      'https://example.com/calendar/task.ics?sync-token=a&page=2',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('caldav-sync: CalDAVClient resolves relative hrefs against calendar collection', async () => {
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return { ok: true, status: 200, text: async () => 'BEGIN:VCALENDAR\nEND:VCALENDAR' } as Response;
  }) as typeof fetch;

  try {
    const client = new CalDAVClient('https://example.com/dav/user/calendar/', 'user', 'pass', undefined, true);
    await client.get('task.ics?sync-token=a&page=2');

    assert.deepEqual(calls, [
      'https://example.com/dav/user/calendar/task.ics?sync-token=a&page=2',
    ]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('caldav-sync: CalDAVClient rejects cross-origin PROPFIND hrefs', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'PROPFIND') {
      return { ok: true, status: 200, text: async () => '<D:href>https://evil.example/task.ics</D:href>' } as Response;
    }
    return { ok: true, status: 200, text: async () => 'BEGIN:VCALENDAR\nEND:VCALENDAR' } as Response;
  }) as typeof fetch;

  try {
    const client = new CalDAVClient('https://example.com/dav/user/calendar/', 'user', 'pass', undefined, true);
    const [href] = await client.propfind('/dav/user/calendar/');

    await assert.rejects(() => client.get(href), /different origin/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('caldav-sync: CalDAVClient rejects credentialed or fragment resource hrefs before transport', async () => {
  const client = new CalDAVClient('https://example.com/dav/', 'user', 'pass', undefined, true);
  await assert.rejects(() => client.get('https://other:secret@example.com/task.ics'), /embedded credentials/u);
  await assert.rejects(() => client.get('/task.ics#fragment'), /fragment/u);
});

test('Pass 137: parseICSFile handles RFC 5545 line folding (long SUMMARY/DESCRIPTION)', () => {
  // RFC 5545 §3.1 fold: CRLF or LF + single space/tab continues the previous line.
  // A SUMMARY folded across two lines must be reassembled before parsing.
  // RFC 5545 compliant fold: producer keeps trailing space on line 1; fold
  // indicator (LWSP prefix) is the extra space at the start of line 2.
  // After unfolding (removing \n<SPACE>), the two parts concatenate correctly.
  const icsContent = [
    'BEGIN:VCALENDAR',
    'BEGIN:VTODO',
    'UID:fold-test-001',
    'SUMMARY:This is a very long task summary that needs to be folded ',
    ' because it exceeds the 75-octet line length limit',
    'DESCRIPTION:Short description',
    'STATUS:NEEDS-ACTION',
    'END:VTODO',
    'END:VCALENDAR',
  ].join('\n');

  const events = parseICSFile(icsContent);
  assert.equal(events.length, 1);
  assert.equal(
    events[0].summary,
    'This is a very long task summary that needs to be folded because it exceeds the 75-octet line length limit',
  );
  assert.equal(events[0].description, 'Short description');
});
