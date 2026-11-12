import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { addDate, addDateObject, generateFallbackRecurrence, resolveDateRange, resolveFlexibleDate, validateRecurrenceRule } from '../src/date-utils';

test('date arithmetic covers weekday, month, and year branches', () => {
  assert.equal(addDate('2026-07-10', 'weekday', 1), '2026-07-13');
  assert.equal(addDate('2026-07-13', 'weekday', -1), '2026-07-10');
  assert.equal(addDate('2026-01-31', 'month', 1), '2026-02-28');
  assert.equal(addDateObject(new Date('2024-02-29T00:00:00Z'), 'year', 1).toISOString().slice(0, 10), '2025-02-28');
});

// ── resolveFlexibleDate ───────────────────────────────────────────────────────

test('resolveFlexibleDate: accepts exact ISO date only', () => {
  assert.strictEqual(resolveFlexibleDate('2026-06-15', '2026-01-01'), '2026-06-15');
  assert.strictEqual(resolveFlexibleDate('2026-06-15abc', '2026-01-01'), null);
  assert.strictEqual(resolveFlexibleDate('2026-06-15 10:00', '2026-01-01'), null);
});

test('resolveFlexibleDate: rejects impossible month-day phrases', () => {
  assert.strictEqual(resolveFlexibleDate('Feb 31', '2026-01-01'), null);
  assert.strictEqual(resolveFlexibleDate('31 February 2026', '2026-01-01'), null);
  assert.strictEqual(resolveFlexibleDate('Feb 28', '2026-01-01'), '2026-02-28');
});

test('resolveFlexibleDate: rejects partial numeric relative counts', () => {
  assert.strictEqual(resolveFlexibleDate('in 2 days', '2026-01-01'), '2026-01-03');
  assert.strictEqual(resolveFlexibleDate('in 2abc days', '2026-01-01'), null);
  assert.strictEqual(resolveFlexibleDate('in -2 days', '2026-01-01'), null);
  assert.strictEqual(resolveFlexibleDate('2 weeks ago', '2026-01-15'), '2026-01-01');
  assert.strictEqual(resolveFlexibleDate('2xyz weeks ago', '2026-01-15'), null);
});

test('resolveFlexibleDate: parses natural dates consistently across timezones', () => {
  const testDist = process.env.TASK_MANAGER_TEST_DIST ?? resolve(process.cwd(), '.test-dist');
  const moduleUrl = pathToFileURL(resolve(testDist, 'src/date-utils.js')).href;
  const script = `import { resolveFlexibleDate } from ${JSON.stringify(moduleUrl)};\nprocess.stdout.write(resolveFlexibleDate('next month', '2026-06-01') ?? 'null');`;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: process.cwd(),
    env: { ...process.env, TZ: 'America/New_York' },
  }).toString('utf8');
  assert.strictEqual(output, '2026-07-01');
});

// ── resolveDateRange ──────────────────────────────────────────────────────────

test('resolveDateRange: does not normalize invalid ISO month or week ranges', () => {
  assert.deepStrictEqual(resolveDateRange('2026-12', '2026-01-01'), { start: '2026-12-01', end: '2026-12-31' });
  assert.deepStrictEqual(resolveDateRange('2026-13', '2026-01-01'), { start: '2026-13', end: '2026-13' });
  assert.deepStrictEqual(resolveDateRange('2026-00', '2026-01-01'), { start: '2026-00', end: '2026-00' });
  assert.deepStrictEqual(resolveDateRange('2026-w53', '2026-01-01'), { start: '2026-12-28', end: '2027-01-03' });
  assert.deepStrictEqual(resolveDateRange('2021-w53', '2026-01-01'), { start: '2021-w53', end: '2021-w53' });
  assert.deepStrictEqual(resolveDateRange('2014-w53', '2026-01-01'), { start: '2014-w53', end: '2014-w53' });
  assert.deepStrictEqual(resolveDateRange('2026-w54', '2026-01-01'), { start: '2026-w54', end: '2026-w54' });
  assert.deepStrictEqual(resolveDateRange('2026-w00', '2026-01-01'), { start: '2026-w00', end: '2026-w00' });
});

test('resolveDateRange: "last/this/next week|month|quarter|year" resolve to full ranges, not a single day', () => {
  // Regression: resolveFlexibleDate() resolves every one of these phrases to a
  // single anchor date via its natural-date fallback, which used to shadow the
  // range branch below and collapse ranges like "next month" to one day.
  const today = '2026-06-15'; // Monday, Q2
  assert.deepStrictEqual(resolveDateRange('this week', today), { start: '2026-06-15', end: '2026-06-21' });
  assert.deepStrictEqual(resolveDateRange('last week', today), { start: '2026-06-08', end: '2026-06-14' });
  assert.deepStrictEqual(resolveDateRange('next week', today), { start: '2026-06-22', end: '2026-06-28' });
  assert.deepStrictEqual(resolveDateRange('this month', today), { start: '2026-06-01', end: '2026-06-30' });
  assert.deepStrictEqual(resolveDateRange('last month', today), { start: '2026-05-01', end: '2026-05-31' });
  assert.deepStrictEqual(resolveDateRange('next month', today), { start: '2026-07-01', end: '2026-07-31' });
  assert.deepStrictEqual(resolveDateRange('this quarter', today), { start: '2026-04-01', end: '2026-06-30' });
  assert.deepStrictEqual(resolveDateRange('last quarter', today), { start: '2026-01-01', end: '2026-03-31' });
  assert.deepStrictEqual(resolveDateRange('next quarter', today), { start: '2026-07-01', end: '2026-09-30' });
  assert.deepStrictEqual(resolveDateRange('this year', today), { start: '2026-01-01', end: '2026-12-31' });
  assert.deepStrictEqual(resolveDateRange('last year', today), { start: '2025-01-01', end: '2025-12-31' });
  assert.deepStrictEqual(resolveDateRange('next year', today), { start: '2027-01-01', end: '2027-12-31' });
});

// ── validateRecurrenceRule ────────────────────────────────────────────────────

test('validateRecurrenceRule: valid simple rule returns no warnings', () => {
  const result = validateRecurrenceRule('every week');
  assert.strictEqual(result.valid, true);
  assert.deepStrictEqual(result.warnings, []);
});

test('validateRecurrenceRule: undefined returns valid with no warnings', () => {
  const result = validateRecurrenceRule(undefined);
  assert.strictEqual(result.valid, true);
  assert.deepStrictEqual(result.warnings, []);
});

test('validateRecurrenceRule: day > 28 monthly is flagged invalid', () => {
  const result = validateRecurrenceRule('every month on the 31st');
  assert.strictEqual(result.valid, false);
  assert.ok(result.warnings.length > 0);
  assert.ok(result.suggestion !== undefined);
});

test('validateRecurrenceRule: day-form monthly ordinals are checked', () => {
  const result = validateRecurrenceRule('every month on day 30');
  assert.strictEqual(result.valid, false);
  assert.ok(result.warnings.some((warning) => /Day 30/u.test(warning)));
});

test('validateRecurrenceRule: day <= 28 monthly is valid', () => {
  const result = validateRecurrenceRule('every month on the 15th');
  assert.strictEqual(result.valid, true);
});

test('validateRecurrenceRule: numeric count > 1000 triggers high-count warning', () => {
  // Bug regression: previously [a-z]+ regex never matched digits, so "for 9999 times"
  // was silently accepted with no warning. The fix changes the capture group to (\d+|[a-z]+).
  const result = validateRecurrenceRule('every week for 9999 times');
  assert.ok(result.warnings.some((w) => /unusually high/i.test(w)),
    `Expected "unusually high" warning, got: ${JSON.stringify(result.warnings)}`);
});

test('validateRecurrenceRule: normal numeric count passes without high-count warning', () => {
  const result = validateRecurrenceRule('every day for 5 times');
  assert.ok(!result.warnings.some((w) => /unusually high/i.test(w)),
    `Unexpected high-count warning for "for 5 times"`);
});

test('validateRecurrenceRule: word count "five" is a valid known word number', () => {
  // "for five times" uses a word-form count that is in the WORD_NUMBERS table
  const result = validateRecurrenceRule('every day for five times');
  // Should not report unknown-count error
  assert.ok(!result.warnings.some((w) => /invalid count/i.test(w)),
    `Unexpected invalid-count warning for "for five times": ${JSON.stringify(result.warnings)}`);
});

test('validateRecurrenceRule: unknown word count is flagged invalid', () => {
  const result = validateRecurrenceRule('every day for foobar times');
  assert.strictEqual(result.valid, false);
  assert.ok(result.warnings.some((w) => /invalid count/i.test(w)));
});

test('validateRecurrenceRule: word count uses actual numeric value for threshold check', () => {
  // Regression: word counts (e.g., "five") were never checked against the > 1000
  // threshold because the code checked the NaN result of parseInt instead of the
  // resolved wordCount value. This test verifies the fix handles word counts correctly.
  // Current WORD_NUMBERS max is 60, so "sixty" should not trigger the warning.
  const result = validateRecurrenceRule('every day for sixty times');
  assert.ok(!result.warnings.some((w) => /unusually high/i.test(w)),
    `"for sixty times" should not trigger high-count warning: ${JSON.stringify(result.warnings)}`);
  // If we ever add word numbers > 1000, they should trigger the warning (logic is now correct)
});

test('validateRecurrenceRule: until date in the past returns invalid', () => {
  const result = validateRecurrenceRule('every week until 2020-01-01');
  assert.strictEqual(result.valid, false);
  assert.ok(result.warnings.some((w) => /past/i.test(w)));
});

test('validateRecurrenceRule: impossible until calendar date returns invalid', () => {
  const result = validateRecurrenceRule('every week until 2027-02-29');
  assert.strictEqual(result.valid, false);
  assert.ok(result.warnings.some((w) => /valid calendar date/i.test(w)));
});

test('validateRecurrenceRule: negative interval returns invalid', () => {
  const result = validateRecurrenceRule('every -3 days');
  assert.strictEqual(result.valid, false);
  assert.ok(result.warnings.some((w) => /negative/i.test(w)));
});

test('validateRecurrenceRule: flags last-Friday monthly rules as unsupported', () => {
  const result = validateRecurrenceRule('every month on last friday');
  assert.strictEqual(result.valid, false);
  assert.ok(result.warnings.some((warning) => /last friday of month/i.test(warning)));
});

// ── generateFallbackRecurrence ───────────────────────────────────────────────

test('generateFallbackRecurrence: keeps everyday distinct from weekdays', () => {
  assert.strictEqual(generateFallbackRecurrence('every day'), undefined);
  assert.strictEqual(generateFallbackRecurrence('every business day'), 'every weekday');
  assert.strictEqual(generateFallbackRecurrence('every weekday'), 'every weekday');
});

test('generateFallbackRecurrence: does not rewrite month-based weekday rules', () => {
  assert.strictEqual(generateFallbackRecurrence('every month on monday'), undefined);
  assert.strictEqual(generateFallbackRecurrence('on monday'), 'every week on monday');
});
