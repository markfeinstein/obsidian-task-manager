import test from 'node:test';
import assert from 'node:assert/strict';
import {
  generateRecurrenceSeriesId,
  isValidSeriesId,
  asSeriesId,
  applyScopeToEdit,
  getCommonRecurrencePatterns,
  predictNextOccurrences,
  formatOccurrencePreview,
  getOccurrenceIndex,
  advanceOccurrenceCounter,
  shouldGenerateNextOccurrence,
  type RecurrenceSeriesId,
} from '../src/recurrence-series';

test('RecurrenceSeries - generateRecurrenceSeriesId', () => {
  const id = generateRecurrenceSeriesId('test.md', 1, 'Do laundry');
  assert.match(id, /^[a-f0-9]{8}$/);
  assert.strictEqual(id.length, 8);
});

test('RecurrenceSeries - consistent ID generation', () => {
  const id1 = generateRecurrenceSeriesId('test.md', 1, 'Do laundry');
  const id2 = generateRecurrenceSeriesId('test.md', 1, 'Do laundry');
  assert.strictEqual(id1, id2);
});

test('RecurrenceSeries - different IDs for different inputs', () => {
  const id1 = generateRecurrenceSeriesId('test.md', 1, 'Do laundry');
  const id2 = generateRecurrenceSeriesId('test.md', 2, 'Do laundry');
  const id3 = generateRecurrenceSeriesId('test.md', 1, 'Clean kitchen');
  assert.notStrictEqual(id1, id2);
  assert.notStrictEqual(id1, id3);
});

test('RecurrenceSeries - isValidSeriesId valid', () => {
  assert.strictEqual(isValidSeriesId('a1b2c3d4'), true);
  assert.strictEqual(isValidSeriesId('00000000'), true);
  assert.strictEqual(isValidSeriesId('ffffffff'), true);
});

test('RecurrenceSeries - isValidSeriesId invalid', () => {
  assert.strictEqual(isValidSeriesId('g1b2c3d4'), false); // invalid hex
  assert.strictEqual(isValidSeriesId('a1b2c3d'), false); // too short
  assert.strictEqual(isValidSeriesId('a1b2c3d45'), false); // too long
  assert.strictEqual(isValidSeriesId('A1B2C3D4'), false); // uppercase
});

test('RecurrenceSeries - asSeriesId valid', () => {
  const id = asSeriesId('a1b2c3d4');
  assert.strictEqual(id, 'a1b2c3d4');
});

test('RecurrenceSeries - asSeriesId invalid', () => {
  assert.strictEqual(asSeriesId('invalid'), undefined);
  assert.strictEqual(asSeriesId('g1b2c3d4'), undefined);
});

test('RecurrenceSeries - applyScopeToEdit this-only', () => {
  const result = applyScopeToEdit('this-only', 'a1b2c3d4' as RecurrenceSeriesId, 2);
  assert.strictEqual(result.scope, 'this-only');
  assert.strictEqual(result.createNewSeries, false);
  assert(result.instructions.length > 0);
  assert(result.instructions[0].includes('Remove the recurrence rule'));
});

test('RecurrenceSeries - applyScopeToEdit this-and-future', () => {
  const result = applyScopeToEdit('this-and-future', 'a1b2c3d4' as RecurrenceSeriesId, 2);
  assert.strictEqual(result.scope, 'this-and-future');
  assert.strictEqual(result.createNewSeries, true);
  assert(result.instructions.length > 0);
});

test('RecurrenceSeries - applyScopeToEdit all-in-series', () => {
  const result = applyScopeToEdit('all-in-series', 'a1b2c3d4' as RecurrenceSeriesId, 2);
  assert.strictEqual(result.scope, 'all-in-series');
  assert.strictEqual(result.createNewSeries, false);
  assert(result.instructions[0].includes('All occurrences'));
});

test('RecurrenceSeries - applyScopeToEdit without series ID', () => {
  const result = applyScopeToEdit('this-only', undefined, 0);
  assert.strictEqual(result.scope, 'this-only');
  assert.strictEqual(result.createNewSeries, false);
});

test('RecurrenceSeries - getCommonRecurrencePatterns', () => {
  const patterns = getCommonRecurrencePatterns();
  assert(Array.isArray(patterns));
  assert(patterns.length > 0);
  assert(patterns.includes('every day'));
  assert(patterns.includes('every week'));
  assert(patterns.includes('every month'));
});

test('RecurrenceSeries - predictNextOccurrences daily', () => {
  // Use local-midnight constructor so getLocalDateStr reads May 28 regardless of timezone
  const occurrences = predictNextOccurrences('every day', new Date(2026, 4, 28));
  assert.strictEqual(occurrences.length, 5);
  assert.match(occurrences[0], /^\d{4}-\d{2}-\d{2}$/);
  assert.strictEqual(occurrences[0], '2026-05-29');
  assert.strictEqual(occurrences[1], '2026-05-30');
});

test('RecurrenceSeries - predictNextOccurrences weekly', () => {
  // Use local-midnight constructor so getLocalDateStr reads May 28 regardless of timezone
  const occurrences = predictNextOccurrences('every week', new Date(2026, 4, 28));
  assert.strictEqual(occurrences.length, 5);
  // Verify absolute first occurrence (pins correct start date, not just spacing)
  assert.strictEqual(occurrences[0], '2026-06-04');
  // Verify roughly 7 days apart
  for (let i = 1; i < occurrences.length; i += 1) {
    const d1 = new Date(occurrences[i - 1]);
    const d2 = new Date(occurrences[i]);
    const diff = (d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24);
    assert(Math.abs(diff - 7) < 0.1, `Expected ~7 days, got ${diff}`);
  }
});

test('RecurrenceSeries - predictNextOccurrences monthly', () => {
  // Use local-midnight constructor so getLocalDateStr reads May 28 regardless of timezone
  const occurrences = predictNextOccurrences('every month', new Date(2026, 4, 28));
  assert.strictEqual(occurrences.length, 5);
  assert.strictEqual(occurrences[0], '2026-06-28');
  assert.strictEqual(occurrences[1], '2026-07-28');
});

test('RecurrenceSeries - predictNextOccurrences monthly preserves end-of-month anchor after a short month', () => {
  // Regression: Jan 31 previously became Feb 28, Mar 28, Apr 28 ... because the clamped
  // February date replaced the original 31st anchor. Preview must recover the 31st when the
  // target month has it.
  const occurrences = predictNextOccurrences('every month', new Date(2026, 0, 31));
  assert.deepEqual(occurrences, [
    '2026-02-28',
    '2026-03-31',
    '2026-04-30',
    '2026-05-31',
    '2026-06-30',
  ]);
});

test('RecurrenceSeries - predictNextOccurrences matches capitalized rules', () => {
  const occurrences = predictNextOccurrences('Every Month', new Date(2026, 4, 28));
  assert.strictEqual(occurrences.length, 5);
  assert.strictEqual(occurrences[0], '2026-06-28');
  assert.strictEqual(occurrences[1], '2026-07-28');
});

test('RecurrenceSeries - predictNextOccurrences yearly', () => {
  // Use local-midnight constructor so getLocalDateStr reads May 28 regardless of timezone
  const occurrences = predictNextOccurrences('every year', new Date(2026, 4, 28));
  assert.strictEqual(occurrences.length, 5);
  assert.strictEqual(occurrences[0], '2027-05-28');
  assert.strictEqual(occurrences[1], '2028-05-28');
});

test('RecurrenceSeries - predictNextOccurrences yearly preserves leap-day anchor across non-leap years', () => {
  // Regression: 2024-02-29 previously became 2025-02-28, 2026-02-28, 2027-02-28, 2028-02-28.
  // The preview must keep Feb 29 as the series anchor so the leap day reappears in 2028.
  const occurrences = predictNextOccurrences('every year', new Date(2024, 1, 29));
  assert.deepEqual(occurrences, [
    '2025-02-28',
    '2026-02-28',
    '2027-02-28',
    '2028-02-29',
    '2029-02-28',
  ]);
});

test('RecurrenceSeries - predictNextOccurrences weekday (not misclassified as weekly)', () => {
  // new Date(2026, 4, 28) is Thursday — next weekdays: Fri 29, Mon Jun 1, Tue 2, Wed 3, Thu 4
  const occurrences = predictNextOccurrences('every weekday', new Date(2026, 4, 28));
  assert.strictEqual(occurrences.length, 5);
  assert.strictEqual(occurrences[0], '2026-05-29'); // Fri
  assert.strictEqual(occurrences[1], '2026-06-01'); // Mon (skip Sat/Sun)
  assert.strictEqual(occurrences[2], '2026-06-02'); // Tue
  assert.strictEqual(occurrences[3], '2026-06-03'); // Wed
  assert.strictEqual(occurrences[4], '2026-06-04'); // Thu
});

test('RecurrenceSeries - predictNextOccurrences weekly on specific day (every week on Monday)', () => {
  // new Date(2026, 4, 28) is Thursday; the next Monday is 2026-06-01, then weekly
  // Bug regression: previously isWeekly matched "every week on Monday" (because
  // /every week(?!day)/ matches), causing all 5 occurrences to land on Thursdays.
  const occurrences = predictNextOccurrences('every week on Monday', new Date(2026, 4, 28));
  assert.strictEqual(occurrences.length, 5);
  assert.strictEqual(occurrences[0], '2026-06-01'); // first Monday after Thursday
  assert.strictEqual(occurrences[1], '2026-06-08');
  assert.strictEqual(occurrences[2], '2026-06-15');
  assert.strictEqual(occurrences[3], '2026-06-22');
  assert.strictEqual(occurrences[4], '2026-06-29');
  // All occurrences must be Mondays (UTC day === 1)
  for (const occ of occurrences) {
    assert.strictEqual(new Date(`${occ}T00:00:00Z`).getUTCDay(), 1, `${occ} should be a Monday`);
  }
});

test('RecurrenceSeries - predictNextOccurrences multi-day weekly (every Monday and Friday)', () => {
  // new Date(2026, 4, 28) is Thursday; next occurrences: Fri 29, Mon Jun 1, Fri 5, Mon 8, Fri 12
  // Bug regression: previously "every Monday and Friday" had no handler and fell through
  // to the 7-day fallback, producing wrong dates (all Thursdays, 7 days apart).
  const occurrences = predictNextOccurrences('every Monday and Friday', new Date(2026, 4, 28));
  assert.strictEqual(occurrences.length, 5);
  assert.strictEqual(occurrences[0], '2026-05-29'); // Fri
  assert.strictEqual(occurrences[1], '2026-06-01'); // Mon
  assert.strictEqual(occurrences[2], '2026-06-05'); // Fri
  assert.strictEqual(occurrences[3], '2026-06-08'); // Mon
  assert.strictEqual(occurrences[4], '2026-06-12'); // Fri
  // All occurrences must be Monday (1) or Friday (5)
  for (const occ of occurrences) {
    const day = new Date(`${occ}T00:00:00Z`).getUTCDay();
    assert.ok(day === 1 || day === 5, `${occ} should be Monday (1) or Friday (5), got ${day}`);
  }
});

test('RecurrenceSeries - predictNextOccurrences weekly on specific day when start date is already that day', () => {
  // Regression: "every week on Monday" starting on a Monday should include that Monday
  // as the first occurrence, not skip to the next Monday 7 days later.
  // new Date(2026, 5, 1) is Monday, June 1, 2026
  const occurrences = predictNextOccurrences('every week on Monday', new Date(2026, 5, 1));
  assert.strictEqual(occurrences.length, 5);
  assert.strictEqual(occurrences[0], '2026-06-01'); // THIS Monday (not next Monday)
  assert.strictEqual(occurrences[1], '2026-06-08');
  assert.strictEqual(occurrences[2], '2026-06-15');
  assert.strictEqual(occurrences[3], '2026-06-22');
  assert.strictEqual(occurrences[4], '2026-06-29');
  // All occurrences must be Mondays
  for (const occ of occurrences) {
    assert.strictEqual(new Date(`${occ}T00:00:00Z`).getUTCDay(), 1, `${occ} should be a Monday`);
  }
});

test('RecurrenceSeries - predictNextOccurrences multi-day when start date is one of the target days', () => {
  // Regression: "every Monday and Friday" starting on a Monday should include that Monday
  // as the first occurrence, not skip to Friday.
  // new Date(2026, 5, 1) is Monday, June 1, 2026
  const occurrences = predictNextOccurrences('every Monday and Friday', new Date(2026, 5, 1));
  assert.strictEqual(occurrences.length, 5);
  assert.strictEqual(occurrences[0], '2026-06-01'); // THIS Monday (not skipped to Friday)
  assert.strictEqual(occurrences[1], '2026-06-05'); // Friday
  assert.strictEqual(occurrences[2], '2026-06-08'); // Monday
  assert.strictEqual(occurrences[3], '2026-06-12'); // Friday
  assert.strictEqual(occurrences[4], '2026-06-15'); // Monday
  // All occurrences must be Monday (1) or Friday (5)
  for (const occ of occurrences) {
    const day = new Date(`${occ}T00:00:00Z`).getUTCDay();
    assert.ok(day === 1 || day === 5, `${occ} should be Monday or Friday, got ${day}`);
  }
});

test('RecurrenceSeries - predictNextOccurrences weekly on multiple specific days', () => {
  // This is the explicit weekly form produced/accepted by the recurrence parser. The preview
  // previously captured only the first word after "on", so Friday occurrences were omitted.
  const occurrences = predictNextOccurrences('every week on Monday and Friday', new Date(2026, 4, 28));
  assert.deepEqual(occurrences, [
    '2026-05-29',
    '2026-06-01',
    '2026-06-05',
    '2026-06-08',
    '2026-06-12',
  ]);
});

test('RecurrenceSeries - predictNextOccurrences bi-weekly (every 2 weeks)', () => {
  // Use local-midnight constructor so getLocalDateStr reads May 28 regardless of timezone
  // isBiWeekly branch: adds 14 days on each iteration
  const occurrences = predictNextOccurrences('every 2 weeks', new Date(2026, 4, 28));
  assert.strictEqual(occurrences.length, 5);
  assert.strictEqual(occurrences[0], '2026-06-11');
  assert.strictEqual(occurrences[1], '2026-06-25');
  assert.strictEqual(occurrences[2], '2026-07-09');
  assert.strictEqual(occurrences[3], '2026-07-23');
  assert.strictEqual(occurrences[4], '2026-08-06');
  // All gaps must be exactly 14 days
  for (let i = 1; i < occurrences.length; i += 1) {
    const diff = (new Date(occurrences[i]).getTime() - new Date(occurrences[i - 1]).getTime()) / (1000 * 60 * 60 * 24);
    assert.strictEqual(diff, 14, `Expected 14-day gap, got ${diff}`);
  }
});

test('RecurrenceSeries - predictNextOccurrences quarterly (every 3 months)', () => {
  // Use local-midnight constructor so getLocalDateStr reads May 28 regardless of timezone
  // isQuarterly branch: adds 3 calendar months per iteration, clamping to last day of month
  const occurrences = predictNextOccurrences('every 3 months', new Date(2026, 4, 28));
  assert.strictEqual(occurrences.length, 5);
  assert.strictEqual(occurrences[0], '2026-08-28'); // May → Aug
  assert.strictEqual(occurrences[1], '2026-11-28'); // Aug → Nov
  assert.strictEqual(occurrences[2], '2027-02-28'); // Nov → Feb (clamped: Feb 2027 has 28 days)
  assert.strictEqual(occurrences[3], '2027-05-28'); // Feb → May
  assert.strictEqual(occurrences[4], '2027-08-28'); // May → Aug
});

test('RecurrenceSeries - predictNextOccurrences unknown pattern', () => {
  // Use local-midnight constructor so getLocalDateStr reads May 28 regardless of timezone
  const occurrences = predictNextOccurrences('unknown pattern', new Date(2026, 4, 28));
  assert.strictEqual(occurrences.length, 5);
  // Should fallback to weekly
  assert.strictEqual(occurrences[0], '2026-06-04');
});

test('RecurrenceSeries - formatOccurrencePreview', () => {
  const occurrences = ['2026-05-28', '2026-06-04', '2026-06-11'];
  const preview = formatOccurrencePreview(occurrences);
  assert(preview.includes('May'));
  assert(preview.includes('Jun'));
  assert(preview.includes(','));
});

test('RecurrenceSeries - formatOccurrencePreview empty', () => {
  const preview = formatOccurrencePreview([]);
  assert.strictEqual(preview, '');
});

test('RecurrenceSeries - getOccurrenceIndex', () => {
  assert.strictEqual(getOccurrenceIndex(undefined), 0);
  assert.strictEqual(getOccurrenceIndex(0), 0);
  assert.strictEqual(getOccurrenceIndex(1), 1);
  assert.strictEqual(getOccurrenceIndex(5), 5);
});

test('RecurrenceSeries - advanceOccurrenceCounter', () => {
  assert.strictEqual(advanceOccurrenceCounter(undefined), 1);
  assert.strictEqual(advanceOccurrenceCounter(0), 1);
  assert.strictEqual(advanceOccurrenceCounter(1), 2);
  assert.strictEqual(advanceOccurrenceCounter(10), 11);
});

test('RecurrenceSeries - shouldGenerateNextOccurrence no limit', () => {
  assert.strictEqual(shouldGenerateNextOccurrence(0, undefined), true);
  assert.strictEqual(shouldGenerateNextOccurrence(100, undefined), true);
});

test('RecurrenceSeries - shouldGenerateNextOccurrence with limit', () => {
  assert.strictEqual(shouldGenerateNextOccurrence(0, 3), true);
  assert.strictEqual(shouldGenerateNextOccurrence(1, 3), true);
  assert.strictEqual(shouldGenerateNextOccurrence(2, 3), true);
  assert.strictEqual(shouldGenerateNextOccurrence(3, 3), false);
  assert.strictEqual(shouldGenerateNextOccurrence(10, 3), false);
});

test('RecurrenceSeries - shouldGenerateNextOccurrence zero limit', () => {
  assert.strictEqual(shouldGenerateNextOccurrence(0, 0), false);
});
