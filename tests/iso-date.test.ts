import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addIsoDays,
  addIsoMonths,
  addIsoWeeks,
  addIsoYears,
  daysInIsoMonth,
  diffIsoDays,
  formatLocalDate,
  formatUtcDate,
  isValidIsoDate,
  isoDateToUtcDate,
  parseIsoDate,
} from '../src/iso-date';

test('iso-date validates exact calendar dates and leap-year rules', () => {
  assert.deepEqual(parseIsoDate('2024-02-29'), { year: 2024, month: 2, day: 29 });
  assert.equal(isValidIsoDate('2000-02-29'), true);
  assert.equal(isValidIsoDate('1900-02-29'), false);
  assert.equal(isValidIsoDate('2023-02-29'), false);
  assert.equal(isValidIsoDate('2026-13-01'), false);
  assert.equal(isValidIsoDate('2026-01-00'), false);
  assert.equal(isValidIsoDate('2026-01-01T00:00'), false);
  assert.equal(daysInIsoMonth(2024, 2), 29);
  assert.equal(daysInIsoMonth(1900, 2), 28);
});

test('iso-date day and week arithmetic crosses boundaries in both directions', () => {
  assert.equal(addIsoDays('2024-02-28', 1), '2024-02-29');
  assert.equal(addIsoDays('2024-02-29', 1), '2024-03-01');
  assert.equal(addIsoDays('2025-01-01', -1), '2024-12-31');
  assert.equal(addIsoWeeks('2024-12-25', 1), '2025-01-01');
  assert.equal(diffIsoDays('2024-02-28', '2024-03-01'), 2);
  assert.equal(diffIsoDays('2025-01-01', '2024-12-31'), -1);
});

test('iso-date month and year arithmetic clamps at month end', () => {
  assert.equal(addIsoMonths('2024-01-31', 1), '2024-02-29');
  assert.equal(addIsoMonths('2023-01-31', 1), '2023-02-28');
  assert.equal(addIsoMonths('2024-03-31', -1), '2024-02-29');
  assert.equal(addIsoYears('2024-02-29', 1), '2025-02-28');
  assert.equal(addIsoYears('2024-02-29', -4), '2020-02-29');
});

test('iso-date UTC and local formatters have explicit semantics', () => {
  const utc = isoDateToUtcDate('2026-07-12');
  assert.equal(formatUtcDate(utc), '2026-07-12');
  const local = new Date(2026, 6, 12, 12, 0, 0);
  assert.equal(formatLocalDate(local), '2026-07-12');
});
