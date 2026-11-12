import test from 'node:test';
import assert from 'node:assert/strict';
import { generateVTODO, reconcileCalendarICS, syncTasksWithCalDAV } from '../src/caldav-sync';
import { TaskScanner } from '../src/task-scanner';
import { reconcileVTODO } from '../src/ics-vtodo-reconciliation';

const scanner = new TaskScanner({} as never);
function task(title: string) {
  const value = scanner.parseTaskLine(`- [ ] ${title} [id:: durable]`, 'Tasks.md', 1);
  assert.ok(value);
  return value;
}
function calendar(vtodo: string) { return `BEGIN:VCALENDAR\r\nVERSION:2.0\r\n${vtodo}\r\nEND:VCALENDAR`; }

test('a permitted local-only update preserves remote notes, nested alarms, parameters, and extensions', () => {
  const extras = 'DESCRIPTION;LANGUAGE=en:Remote-only notes\r\nX-VENDOR-PROP:keep\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:Alarm text\r\nSUMMARY:Nested alarm summary\r\nTRIGGER:-PT15M\r\nEND:VALARM';
  const remote = generateVTODO(task('Original')).replace('END:VTODO', `${extras}\r\nEND:VTODO`);
  const result = reconcileCalendarICS(calendar(remote), [task('Local edit')]);
  assert.equal(result.changed, true);
  assert.ok(result.content.includes(extras));
  assert.ok(result.content.includes('SUMMARY:Local edit'));
  const repeated = reconcileCalendarICS(result.content, [task('Local edit')]);
  assert.equal(repeated.changed, false);
});

test('remote-only and dual changes are never overwritten in either direction', () => {
  const remote = generateVTODO(task('Original')).replace('SUMMARY:Original', 'SUMMARY:Remote edit');
  for (const direction of ['vault-first', 'service-first'] as const) {
    for (const local of [task('Original'), task('Different local edit')]) {
      assert.throws(() => reconcileCalendarICS(calendar(remote), [local], direction), /changed remotely/u);
    }
    assert.throws(() => reconcileCalendarICS(calendar('BEGIN:VTODO\r\nUID:durable\r\nSUMMARY:Unbased remote\r\nEND:VTODO'), [task('Local')], direction), /no verified baseline/u);
  }
});

test('malformed baselines, duplicate managed properties, and unbalanced alarm components fail closed', () => {
  const local = generateVTODO(task('Original'));
  assert.throws(() => reconcileVTODO(local.replace(/X-OBSIDIAN-TASK-MANAGER-BASELINE:[^\r\n]+(?:\r\n [^\r\n]+)*/u, 'X-OBSIDIAN-TASK-MANAGER-BASELINE:%broken'), local), /Malformed/u);
  assert.throws(() => reconcileVTODO(local.replace('END:VTODO', 'SUMMARY:Duplicate\r\nEND:VTODO'), local), /Duplicate/u);
  assert.throws(() => reconcileVTODO(local.replace('END:VTODO', 'BEGIN:VALARM\r\nEND:VTODO'), local), /Mismatched/u);
});

test('a remote divergence returns a conflict before network or vault mutation', async () => {
  const remote = calendar(generateVTODO(task('Original')).replace('SUMMARY:Original', 'SUMMARY:Remote edit'));
  let mutations = 0;
  const client = { get: async () => ({ status: 'success', resource: { content: remote, etag: '"e1"' } }), put: async () => { mutations += 1; } };
  const result = await syncTasksWithCalDAV({ vault: { process: () => { mutations += 1; } } } as never, client as never, [task('Local')], '/calendar.ics', 'Projection.md', 'vault-first');
  assert.equal(result.status, 'conflict');
  assert.equal(mutations, 0);
});
