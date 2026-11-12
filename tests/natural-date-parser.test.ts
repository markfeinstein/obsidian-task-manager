import test from 'node:test';
import assert from 'node:assert/strict';
import { findNaturalDates, parseNaturalDate } from '../src/natural-date-parser';
import { parseNLPInput } from '../src/nlp-parser';

test('natural dates validate leap days and reject impossible calendar dates', () => {
  assert.equal(parseNaturalDate('February 29 2028', '2026-01-01', 'en'), '2028-02-29');
  assert.equal(parseNaturalDate('February 29 2027', '2026-01-01', 'en'), null);
  assert.equal(parseNaturalDate('2028-02-29', '2026-01-01', 'en'), '2028-02-29');
  assert.equal(parseNaturalDate('2027-02-29', '2026-01-01', 'en'), null);
  assert.equal(parseNaturalDate('April 31', '2026-01-01', 'en'), null);
});

test('weekday qualifiers are deterministic at same-day and week boundaries', () => {
  const monday = '2026-06-01';
  assert.equal(parseNaturalDate('Monday', monday, 'en', true), monday);
  assert.equal(parseNaturalDate('next Monday', monday, 'en', true), '2026-06-08');
  assert.equal(parseNaturalDate('last Monday', monday, 'en', true), '2026-05-25');
  assert.equal(parseNaturalDate('this Sunday', monday, 'en', true), '2026-06-07');
  assert.equal(parseNaturalDate('next Monday', '2026-06-07', 'en', true), '2026-06-08');
});

test('localized relative days and basic weekdays retain local-calendar semantics', () => {
  const today = '2026-12-31';
  assert.equal(parseNaturalDate('morgen', today, 'de', true), '2027-01-01');
  assert.equal(parseNaturalDate('demain', today, 'fr', true), '2027-01-01');
  assert.equal(parseNaturalDate('明日', today, 'ja', true), '2027-01-01');
  assert.equal(parseNaturalDate('明天', today, 'zh', true), '2027-01-01');
  assert.equal(parseNaturalDate('nächsten Montag', '2026-06-03', 'de', true), '2026-06-08');
  assert.equal(parseNaturalDate('lundi prochain', '2026-06-03', 'fr', true), '2026-06-08');
  assert.equal(parseNaturalDate('来週月曜日', '2026-06-03', 'ja', true), '2026-06-08');
  assert.equal(parseNaturalDate('下周一', '2026-06-03', 'zh', true), '2026-06-08');
});

test('generic extraction preserves source order for date ranges', () => {
  assert.deepEqual(findNaturalDates('Project June 1 to June 5', '2026-05-01', 'en').map(({ date, text }) => ({ date, text })), [
    { date: '2026-06-01', text: 'June 1' },
    { date: '2026-06-05', text: 'June 5' },
  ]);
  const parsed = parseNLPInput('Project June 1 to June 5', '2026-05-01');
  assert.equal(parsed.startDate, '2026-06-01');
  assert.equal(parsed.dueDate, '2026-06-05');
  assert.equal(parsed.description, 'Project to');
});

test('ambiguous and invalid phrases fail closed without deleting task text', () => {
  for (const phrase of ['version 2/10', 'May improve docs', 'March 99', '2026-02-31', 'in -2 days', 'in 2abc days']) {
    assert.deepEqual(findNaturalDates(phrase, '2026-01-01', 'en'), [], phrase);
    const parsed = parseNLPInput(phrase, '2026-01-01');
    assert.equal(parsed.dueDate, undefined, phrase);
    assert.equal(parsed.description, phrase, phrase);
  }
});

test('localized explicit markers consume relative phrases without consuming surrounding text', () => {
  const cases = [
    ['Bericht fällig morgen', 'de', 'Bericht'],
    ['Rapport échéance demain', 'fr', 'Rapport'],
    ['レポート 期限 明日', 'ja', 'レポート'],
    ['报告 截止 明天', 'zh', '报告'],
  ] as const;
  for (const [input, locale, description] of cases) {
    const parsed = parseNLPInput(input, '2026-06-03', locale);
    assert.equal(parsed.dueDate, '2026-06-04', input);
    assert.equal(parsed.description, description, input);
  }
});
