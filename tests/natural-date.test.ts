import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNaturalDateInstruction } from '../src/task-line-toolbar';

test('parses a complex multi-field instruction', () => {
  const r = parseNaturalDateInstruction('schedule for next week, start on wednesday @ noon, due friday 2:00pm');
  assert.ok(r.results.scheduled, 'scheduled set');
  assert.ok(r.results.start, 'start set');
  assert.ok(r.results.due, 'due set');
  assert.equal(r.results.start!.time, '12:00');
  assert.equal(r.results.due!.time, '14:00');
  assert.deepEqual(r.order, ['scheduled', 'start', 'due']);
});

test('field keyword variants', () => {
  const r = parseNaturalDateInstruction('starts tomorrow, deadline 2026-12-25 9am');
  assert.ok(r.results.start);
  assert.equal(r.results.due!.iso, '2026-12-25');
  assert.equal(r.results.due!.time, '09:00');
});

test('bare phrase defaults to due', () => {
  const r = parseNaturalDateInstruction('friday 5pm');
  assert.ok(r.results.due);
  assert.equal(r.results.due!.time, '17:00');
});

test('unparseable goes to unmatched', () => {
  const r = parseNaturalDateInstruction('due blorpt234');
  assert.equal(Object.keys(r.results).length, 0);
  assert.equal(r.unmatched.length, 1);
});

test('month-name and military time', () => {
  const r = parseNaturalDateInstruction('due jun 2 1530');
  assert.equal(r.results.due!.iso.slice(5), '06-02');
  assert.equal(r.results.due!.time, '15:30');
});

test('month-name parser accepts four-letter September abbreviation', () => {
  const r = parseNaturalDateInstruction('due Sept 2');
  assert.equal(r.results.due!.iso.slice(5), '09-02');
});
