import assert from 'node:assert/strict';
import test from 'node:test';
import { formatIsoDisplayDate, formatIsoMonthDay, formatIsoWeekday } from '../src/display-date';

test('display dates use the requested locale without changing ISO storage values', () => {
  const iso = '2026-07-13';
  const expectedGerman = new Intl.DateTimeFormat('de', { month: 'long', day: 'numeric', timeZone: 'UTC' }).format(new Date('2026-07-13T00:00:00.000Z'));
  assert.equal(formatIsoDisplayDate(iso, { month: 'long', day: 'numeric' }, 'de'), expectedGerman);
  assert.notEqual(formatIsoMonthDay(iso, 'de'), 'Jul 13');
  assert.equal(formatIsoWeekday('not-a-date', 'de'), 'not-a-date');
});

test('display date test locales safely fall back to an English Intl locale', () => {
  assert.equal(formatIsoMonthDay('2026-07-13', 'pseudo'), formatIsoMonthDay('2026-07-13', 'en'));
  assert.equal(formatIsoMonthDay('2026-07-13', 'rtl-test'), formatIsoMonthDay('2026-07-13', 'en'));
});
