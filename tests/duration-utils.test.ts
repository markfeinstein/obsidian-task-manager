import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEffortMinutesForFilter } from '../src/duration-utils';

test('parseEffortMinutesForFilter returns Infinity for empty/undefined strings', () => {
  assert.equal(parseEffortMinutesForFilter(''), Infinity);
  assert.equal(parseEffortMinutesForFilter('   '), Infinity);
  assert.equal(parseEffortMinutesForFilter(undefined), Infinity);
});

test('parseEffortMinutesForFilter parses bare numbers as minutes', () => {
  assert.equal(parseEffortMinutesForFilter('30'), 30);
  assert.equal(parseEffortMinutesForFilter('120'), 120);
  assert.equal(parseEffortMinutesForFilter('0'), 0);
  assert.equal(parseEffortMinutesForFilter('1.5'), 1.5);
});

test('parseEffortMinutesForFilter parses day units (1 day = 8 hours)', () => {
  assert.equal(parseEffortMinutesForFilter('1d'), 480); // 8 * 60
  assert.equal(parseEffortMinutesForFilter('2d'), 960); // 2 * 8 * 60
  assert.equal(parseEffortMinutesForFilter('0.5d'), 240); // 0.5 * 8 * 60
  assert.equal(parseEffortMinutesForFilter('1day'), 480);
  assert.equal(parseEffortMinutesForFilter('2days'), 960);
});

test('parseEffortMinutesForFilter parses hour units', () => {
  assert.equal(parseEffortMinutesForFilter('1h'), 60);
  assert.equal(parseEffortMinutesForFilter('2h'), 120);
  assert.equal(parseEffortMinutesForFilter('1.5h'), 90);
  assert.equal(parseEffortMinutesForFilter('1hour'), 60);
  assert.equal(parseEffortMinutesForFilter('2hours'), 120);
});

test('parseEffortMinutesForFilter parses minute units', () => {
  assert.equal(parseEffortMinutesForFilter('30m'), 30);
  assert.equal(parseEffortMinutesForFilter('45m'), 45);
  assert.equal(parseEffortMinutesForFilter('30min'), 30);
  assert.equal(parseEffortMinutesForFilter('45mins'), 45);
  assert.equal(parseEffortMinutesForFilter('30minute'), 30);
  assert.equal(parseEffortMinutesForFilter('45minutes'), 45);
});

test('parseEffortMinutesForFilter parses combined duration formats', () => {
  assert.equal(parseEffortMinutesForFilter('1d 2h 30m'), 630); // 480 + 120 + 30
  assert.equal(parseEffortMinutesForFilter('2h 30m'), 150); // 120 + 30
  assert.equal(parseEffortMinutesForFilter('1d 30m'), 510); // 480 + 30
  assert.equal(parseEffortMinutesForFilter('1d 2h'), 600); // 480 + 120
});

test('parseEffortMinutesForFilter handles extra whitespace', () => {
  assert.equal(parseEffortMinutesForFilter('  1d  2h  30m  '), 630);
  assert.equal(parseEffortMinutesForFilter('2h  30m'), 150);
  assert.equal(parseEffortMinutesForFilter('  30  '), 30);
});

test('parseEffortMinutesForFilter is case-insensitive', () => {
  assert.equal(parseEffortMinutesForFilter('1D 2H 30M'), 630);
  assert.equal(parseEffortMinutesForFilter('2HOURS'), 120);
  assert.equal(parseEffortMinutesForFilter('30MINUTES'), 30);
});

test('parseEffortMinutesForFilter handles zero values', () => {
  assert.equal(parseEffortMinutesForFilter('0d 0h 0m'), 0);
  assert.equal(parseEffortMinutesForFilter('0h'), 0);
  assert.equal(parseEffortMinutesForFilter('0m'), 0);
  assert.equal(parseEffortMinutesForFilter('0d'), 0);
});

test('parseEffortMinutesForFilter returns Infinity for invalid formats', () => {
  assert.equal(parseEffortMinutesForFilter('abc'), Infinity);
  assert.equal(parseEffortMinutesForFilter('d'), Infinity);
  assert.equal(parseEffortMinutesForFilter('h'), Infinity);
  assert.equal(parseEffortMinutesForFilter('m'), Infinity);
  assert.equal(parseEffortMinutesForFilter('1x'), Infinity);
  assert.equal(parseEffortMinutesForFilter('1d 2x'), Infinity);
  assert.equal(parseEffortMinutesForFilter('foo bar'), Infinity);
});

test('parseEffortMinutesForFilter handles decimal precision', () => {
  assert.equal(parseEffortMinutesForFilter('0.25h'), 15); // 15 minutes
  assert.equal(parseEffortMinutesForFilter('0.5d'), 240); // 4 hours
  assert.equal(parseEffortMinutesForFilter('1.75h'), 105); // 1 hour 45 minutes
});

test('parseEffortMinutesForFilter handles partial duration components', () => {
  // Test that we can have any combination of d/h/m
  assert.equal(parseEffortMinutesForFilter('1d'), 480);
  assert.equal(parseEffortMinutesForFilter('2h'), 120);
  assert.equal(parseEffortMinutesForFilter('30m'), 30);
  assert.equal(parseEffortMinutesForFilter('1d 30m'), 510);
  assert.equal(parseEffortMinutesForFilter('2h 30m'), 150);
});

test('parseEffortMinutesForFilter rejects negative values', () => {
  // Negative values don't match the regex pattern, so they should return Infinity
  assert.equal(parseEffortMinutesForFilter('-1d'), Infinity);
  assert.equal(parseEffortMinutesForFilter('-30'), Infinity);
  assert.equal(parseEffortMinutesForFilter('-2h'), Infinity);
});

test('parseEffortMinutesForFilter rejects multiple bare numbers', () => {
  assert.equal(parseEffortMinutesForFilter('30 45'), Infinity);
  assert.equal(parseEffortMinutesForFilter('1 2 3'), Infinity);
});
