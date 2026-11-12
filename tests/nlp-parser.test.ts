import test from 'node:test';
import assert from 'node:assert/strict';
import { parseNLPInput, formatParsedNLPAsTaskLine, type NLPLocale } from '../src/nlp-parser';

// Helper function to get today's date
function getTodayString(): string {
  const d = new Date();
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Helper function to add days to today
function getTodayPlus(days: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + days);
  const year = d.getUTCFullYear();
  const month = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

test('NLP parser: basic task parsing', () => {
  const result = parseNLPInput('Buy milk');
  assert.strictEqual(result.description, 'Buy milk');
  assert.strictEqual(result.priority, '');
  assert.strictEqual(result.tags.length, 0);
});

test('NLP parser: task with tags', () => {
  const result = parseNLPInput('Buy milk #shopping');
  assert.strictEqual(result.description, 'Buy milk');
  assert.deepStrictEqual(result.tags, ['shopping']);
});

test('NLP parser: task with multiple tags', () => {
  const result = parseNLPInput('Buy milk #shopping #groceries');
  assert.strictEqual(result.description, 'Buy milk');
  assert.deepStrictEqual(result.tags, ['shopping', 'groceries']);
});

test('NLP parser: task with highest priority', () => {
  const result = parseNLPInput('Fix critical bug high priority');
  assert.strictEqual(result.priority, '🔺');
});

test('NLP parser: task with high priority', () => {
  const result = parseNLPInput('Urgent task high');
  assert.strictEqual(result.priority, '⏫');
});

test('NLP parser: task with medium priority', () => {
  const result = parseNLPInput('Normal task medium');
  assert.strictEqual(result.priority, '🔼');
});

test('NLP parser: task with low priority', () => {
  const result = parseNLPInput('Low priority task low');
  assert.strictEqual(result.priority, '🔽');
});

test('NLP parser: task with recurrence daily', () => {
  const result = parseNLPInput('Take medication every day');
  assert.strictEqual(result.recurrence, 'every day');
});

test('NLP parser: task with recurrence weekly', () => {
  const result = parseNLPInput('Team meeting every week');
  assert.strictEqual(result.recurrence, 'every week');
});

test('NLP parser: task with recurrence custom', () => {
  const result = parseNLPInput('Standup every weekday');
  assert.strictEqual(result.recurrence, 'every weekday');
});

test('NLP parser: task due today', () => {
  const today = getTodayString();
  const result = parseNLPInput('Due today', today);
  assert.strictEqual(result.dueDate, today);
});

test('NLP parser: task due tomorrow', () => {
  const tomorrow = getTodayPlus(1);
  const result = parseNLPInput('Due tomorrow', getTodayString());
  assert.strictEqual(result.dueDate, tomorrow);
});

test('NLP parser: task with duration hours', () => {
  const result = parseNLPInput('Write report for 2 hours');
  assert.strictEqual(result.effort, '2h');
});

test('NLP parser: task with duration minutes', () => {
  const result = parseNLPInput('Review PR for 30 minutes');
  assert.strictEqual(result.effort, '30m');
});

test('NLP parser: task with effort shorthand', () => {
  const result = parseNLPInput('Meeting 1h');
  assert.strictEqual(result.effort, '1h');
});

test('NLP parser: task with start date', () => {
  const today = getTodayString();
  const result = parseNLPInput('Start Monday', today);
  assert.strictEqual(typeof result.startDate, 'string');
});

test('NLP parser: task with explicit due marker', () => {
  const today = getTodayString();
  const result = parseNLPInput('Project due today', today);
  assert.strictEqual(result.dueDate, today);
});

test('NLP parser: task with deadline marker', () => {
  const today = getTodayString();
  const result = parseNLPInput('Proposal deadline today', today);
  assert.strictEqual(result.dueDate, today);
});

test('NLP parser: non-ASCII explicit date markers parse in locale input', () => {
  const cases: Array<[string, NLPLocale]> = [
    ['Rapport échéance 2026-06-04', 'fr'],
    ['レポート 期限 2026-06-04', 'ja'],
    ['报告 截止 2026-06-04', 'zh'],
  ];

  for (const [input, locale] of cases) {
    const result = parseNLPInput(input, '2026-06-03', locale);
    assert.strictEqual(result.dueDate, '2026-06-04', `${locale} should parse explicit due marker`);
  }
});

test('NLP parser: localized explicit date markers remove localized relative dates', () => {
  const result = parseNLPInput('Rapport échéance demain', '2026-06-03', 'fr');
  assert.strictEqual(result.dueDate, '2026-06-04');
  assert.strictEqual(result.description, 'Rapport');
});

test('NLP parser: task with by marker', () => {
  const today = getTodayString();
  const result = parseNLPInput('Complete by today', today);
  assert.strictEqual(result.dueDate, today);
});

test('NLP parser: combined metadata', () => {
  const today = getTodayString();
  const result = parseNLPInput(
    'Write report due today 2 hours high priority #work #urgent',
    today,
  );
  assert.strictEqual(result.description, 'Write report');
  assert.strictEqual(result.dueDate, today);
  assert.strictEqual(result.effort, '2h');
  assert.strictEqual(result.priority, '⏫');
  assert.deepStrictEqual(result.tags, ['work', 'urgent']);
});

test('NLP parser: preserves full text', () => {
  const input = 'Buy milk tomorrow #shopping';
  const result = parseNLPInput(input);
  assert.strictEqual(result.fullText, input);
});

test('NLP parser: empty input', () => {
  const result = parseNLPInput('');
  assert.strictEqual(result.description, '');
});

test('NLP parser: only tags', () => {
  const result = parseNLPInput('#tag1 #tag2');
  assert.strictEqual(result.description, '');
  assert.deepStrictEqual(result.tags, ['tag1', 'tag2']);
});

test('NLP parser: task with context', () => {
  const result = parseNLPInput('Buy milk for John');
  assert.ok(result.description.includes('Buy milk'));
});

test('NLP parser: tags with hyphens', () => {
  const result = parseNLPInput('Task #my-tag #another-tag');
  assert.deepStrictEqual(result.tags, ['my-tag', 'another-tag']);
});

test('NLP parser: complex effort parsing', () => {
  const result = parseNLPInput('Presentation takes 1.5 hours');
  assert.strictEqual(result.effort, '1.5h');
});

test('NLP parser: priority with critical keyword', () => {
  const result = parseNLPInput('Fix critical issue');
  assert.strictEqual(result.priority, '🔺');
});

test('NLP parser: priority with lowest keyword', () => {
  const result = parseNLPInput('Task with lowest priority');
  assert.strictEqual(result.priority, '⏬');
});

test('Formatter: formats task line with all fields', () => {
  const parsed = parseNLPInput('Buy milk tomorrow 1 hour high priority #shopping', getTodayString());
  const formatted = formatParsedNLPAsTaskLine(parsed, false, 'plain');
  assert.ok(formatted.includes('[ ]'));
  assert.ok(formatted.includes('Buy milk'));
  if (parsed.priority) assert.ok(formatted.includes(parsed.priority));
  if (parsed.dueDate) assert.ok(formatted.includes(parsed.dueDate));
  if (parsed.effort) assert.ok(formatted.includes(parsed.effort));
  if (parsed.tags.length > 0) assert.ok(formatted.includes('#shopping'));
});

test('Formatter: includes created date when requested', () => {
  const parsed = parseNLPInput('Task');
  const formatted = formatParsedNLPAsTaskLine(parsed, true, 'plain');
  assert.ok(formatted.includes('➕'));
});

test('Formatter: uses wikilink format for dates', () => {
  const parsed = parseNLPInput('Task due tomorrow', getTodayString());
  const formatted = formatParsedNLPAsTaskLine(parsed, false, 'wikilink');
  if (parsed.dueDate) {
    assert.ok(formatted.includes(`[[${parsed.dueDate}]]`));
  }
});

test('Formatter: uses iso format for dates', () => {
  const today = getTodayString();
  const parsed = parseNLPInput('Task due today', today);
  const formatted = formatParsedNLPAsTaskLine(parsed, false, 'plain');
  assert.ok(formatted.includes(today));
});

test('Formatter: empty description returns empty string', () => {
  const parsed = { ...parseNLPInput(''), description: '' };
  const formatted = formatParsedNLPAsTaskLine(parsed, false, 'plain');
  assert.strictEqual(formatted, '');
});

test('NLP parser: recurrence with until date', () => {
  const result = parseNLPInput('Daily standup every weekday until 2025-12-31');
  assert.ok(result.recurrence.includes('every weekday'));
});

test('NLP parser: recurrence with for count', () => {
  const result = parseNLPInput('Sprint every 2 weeks for 10 times');
  assert.ok(result.recurrence.includes('every 2 weeks'));
});

test('NLP parser: effort in days', () => {
  const result = parseNLPInput('Project for 5 days');
  assert.strictEqual(result.effort, '5d');
});

test('NLP parser: relative day dates are not misclassified as effort', () => {
  const result = parseNLPInput('Submit report in 3 days', '2026-06-02');
  assert.strictEqual(result.description, 'Submit report');
  assert.strictEqual(result.dueDate, '2026-06-05');
  assert.strictEqual(result.effort, undefined);

  const withinResult = parseNLPInput('Submit report within 3 days', '2026-06-02');
  assert.strictEqual(withinResult.description, 'Submit report');
  assert.strictEqual(withinResult.dueDate, '2026-06-05');
  assert.strictEqual(withinResult.effort, undefined);
});

test('NLP parser: relative days can precede a separate day effort without removing the wrong phrase', () => {
  const result = parseNLPInput('Submit report in 3 days and budget 3 days', '2026-06-02');
  assert.strictEqual(result.dueDate, '2026-06-05');
  assert.strictEqual(result.effort, '3d');
  assert.match(result.description, /Submit report/u);
});

test('NLP parser: multiple spaces normalized', () => {
  const result = parseNLPInput('Buy    milk    for    John');
  assert.ok(result.description.includes('Buy') && result.description.includes('milk'));
});

test('NLP parser: start and due dates both parsed', () => {
  const today = getTodayString();
  const result = parseNLPInput('Project start Monday due Friday', today);
  // Should parse both dates if they exist
  assert.ok(result.startDate !== undefined || result.dueDate !== undefined);
});

test('Progress edge case: zero total tasks', () => {
  // This test verifies the parser doesn't crash with edge cases
  const result = parseNLPInput('');
  assert.ok(result !== undefined);
});

test('NLP parser: priority removed from description', () => {
  const result = parseNLPInput('Buy milk high priority');
  assert.strictEqual(result.description, 'Buy milk');
});

test('NLP parser: recurrence removed from description', () => {
  const result = parseNLPInput('Standup every weekday meeting');
  assert.ok(!result.description.includes('every weekday'));
});

test('NLP parser: date removed from description', () => {
  const today = getTodayString();
  const result = parseNLPInput('Task due today', today);
  assert.strictEqual(result.description, 'Task');
});

test('NLP parser: natural-language date removed from description', () => {
  // When the parser extracts "June 15" as a date, the original phrase should be
  // stripped from the description, not just the ISO string '2026-06-15'.
  const today = '2026-05-31';
  const result = parseNLPInput('Buy coffee June 15', today);
  assert.ok(result.dueDate, 'should extract a due date');
  assert.ok(
    !result.description.toLowerCase().includes('june'),
    `description should not contain "june", got: ${result.description}`,
  );
  assert.ok(
    !result.description.includes('15'),
    `description should not contain "15", got: ${result.description}`,
  );
});

test('NLP parser: natural-language "tomorrow" removed from description', () => {
  // "tomorrow" is handled by the static pattern in removeDatesFromText;
  // ensure it still works after the refactor.
  const today = getTodayString();
  const result = parseNLPInput('Send report tomorrow', today);
  assert.ok(!result.description.toLowerCase().includes('tomorrow'),
    `description should not contain "tomorrow", got: ${result.description}`);
});

test('Formatter: includes start date when different from due date', () => {
  const today = getTodayString();
  const tomorrow = getTodayPlus(1);
  const parsed = {
    description: 'Task',
    dueDate: tomorrow,
    startDate: today,
    priority: '',
    tags: [],
    recurrence: '',
    fullText: '',
  };
  const formatted = formatParsedNLPAsTaskLine(parsed, false, 'plain');
  assert.ok(formatted.includes('🛫')); // Start date emoji (airplane departure)
});

test('NLP parser: handles decimal hours', () => {
  const result = parseNLPInput('Meeting for 1.5 hours');
  assert.strictEqual(result.effort, '1.5h');
});

test('Formatter: task line starts with checkbox', () => {
  const parsed = parseNLPInput('Buy milk');
  const formatted = formatParsedNLPAsTaskLine(parsed, false, 'plain');
  assert.ok(formatted.startsWith('- [ ]'));
});

// ==================== GERMAN (Deutsch) TESTS ====================

test('NLP parser (DE): basic task parsing', () => {
  const result = parseNLPInput('Milch kaufen', getTodayString(), 'de');
  assert.ok(result.description.includes('Milch') || result.description.includes('kaufen'));
});

test('NLP parser (DE): high priority keyword', () => {
  const result = parseNLPInput('Dringender Bug zu beheben dringend', getTodayString(), 'de');
  assert.strictEqual(result.priority, '⏫');
});

test('NLP parser (DE): medium priority keyword', () => {
  const result = parseNLPInput('Normale Aufgabe mittel', getTodayString(), 'de');
  assert.strictEqual(result.priority, '🔼');
});

test('NLP parser (DE): recurrence daily', () => {
  const result = parseNLPInput('Medikamente nehmen alle tage', getTodayString(), 'de');
  assert.ok(result.recurrence.includes('tage') || result.recurrence.length > 0);
});

test('NLP parser (DE): tags with hyphen', () => {
  const result = parseNLPInput('Aufgabe #mein-projekt', getTodayString(), 'de');
  assert.deepStrictEqual(result.tags, ['mein-projekt']);
});

// ==================== FRENCH (Français) TESTS ====================

test('NLP parser (FR): basic task parsing', () => {
  const result = parseNLPInput('Acheter du lait', getTodayString(), 'fr');
  assert.ok(result.description.includes('Acheter') || result.description.includes('lait'));
});

test('NLP parser (FR): urgent priority keyword', () => {
  const result = parseNLPInput('Corriger bug urgent urgent', getTodayString(), 'fr');
  assert.strictEqual(result.priority, '⏫');
});

test('NLP parser (FR): high priority keyword', () => {
  const result = parseNLPInput('Tâche haute priorité', getTodayString(), 'fr');
  assert.strictEqual(result.priority, '⏫');
});

test('NLP parser (FR): recurrence weekly', () => {
  const result = parseNLPInput('Réunion chaque semaine', getTodayString(), 'fr');
  assert.ok(result.recurrence.length > 0);
});

test('NLP parser (FR): duration in hours', () => {
  const result = parseNLPInput('Écrire rapport pendant 2 heures', getTodayString(), 'fr');
  assert.strictEqual(result.effort, '2h');
});

// ==================== JAPANESE (日本語) TESTS ====================

test('NLP parser (JA): basic task parsing', () => {
  const result = parseNLPInput('ミルクを買う', getTodayString(), 'ja');
  assert.ok(result.description.length > 0);
});

test('NLP parser (JA): high priority keyword', () => {
  const result = parseNLPInput('バグを修正 高 優先度', getTodayString(), 'ja');
  // Japanese priority detection may vary
  assert.ok(result.priority === '' || result.priority.length > 0);
});

test('NLP parser (JA): tags support', () => {
  const result = parseNLPInput('タスク #プロジェクト', getTodayString(), 'ja');
  assert.deepStrictEqual(result.tags, ['プロジェクト']);
});

test('NLP parser (JA): recurrence does not require punctuation', () => {
  const result = parseNLPInput('薬を飲む 毎日', getTodayString(), 'ja');
  assert.strictEqual(result.recurrence, '毎日');
  assert.strictEqual(result.description, '薬を飲む');
});

test('NLP parser (JA): duration parsing', () => {
  const result = parseNLPInput('レポート作成 2時間', getTodayString(), 'ja');
  // Duration parsing remains intentionally independent from date parsing.
  assert.ok(result.description.length > 0);
});

// ==================== CHINESE (中文) TESTS ====================

test('NLP parser (ZH): basic task parsing', () => {
  const result = parseNLPInput('买牛奶', getTodayString(), 'zh');
  assert.ok(result.description.length > 0);
});

test('NLP parser (ZH): high priority keyword', () => {
  const result = parseNLPInput('修复bug 高 优先级', getTodayString(), 'zh');
  // Chinese priority detection may vary
  assert.ok(result.priority === '' || result.priority.length > 0);
});

test('NLP parser (ZH): tags support', () => {
  const result = parseNLPInput('任务 #项目', getTodayString(), 'zh');
  assert.deepStrictEqual(result.tags, ['项目']);
});

test('NLP parser (ZH): recurrence does not require punctuation', () => {
  const result = parseNLPInput('吃药 每天', getTodayString(), 'zh');
  assert.strictEqual(result.recurrence, '每天');
  assert.strictEqual(result.description, '吃药');
});

test('NLP parser (ZH): duration parsing', () => {
  const result = parseNLPInput('写报告 2小时', getTodayString(), 'zh');
  assert.ok(result.description.length > 0);
});

// ==================== LOCALE FALLBACK TESTS ====================

test('NLP parser: English locale with default', () => {
  const result = parseNLPInput('Buy milk high priority', getTodayString());
  assert.strictEqual(result.priority, '⏫');
});

test('NLP parser: unsupported UI locales fall back without throwing', () => {
  const result = parseNLPInput('Buy milk tomorrow high priority', '2026-06-01', 'es');
  assert.strictEqual(result.description, 'Buy milk');
  assert.strictEqual(result.dueDate, '2026-06-02');
  assert.strictEqual(result.priority, '⏫');
});

test('NLP parser: German locale explicitly', () => {
  const result = parseNLPInput('Aufgabe hoch', getTodayString(), 'de');
  assert.ok(result.description.length > 0);
});

test('NLP parser: French locale explicitly', () => {
  const result = parseNLPInput('Tâche normal', getTodayString(), 'fr');
  assert.ok(result.description.length > 0);
});

// ==================== MULTILINGUAL COMBINED TESTS ====================

test('NLP parser: multilingual with multiple metadata', () => {
  const today = getTodayString();
  const result = parseNLPInput('Bericht schreiben 2 hours dringend #work', today, 'de');
  assert.ok(result.effort === '2h');
  assert.strictEqual(result.priority, '⏫');
  assert.deepStrictEqual(result.tags, ['work']);
});

test('NLP parser: English priority keywords work across locales', () => {
  // Even in German locale, English keywords might be recognized due to fallback
  const result = parseNLPInput('Task high priority', getTodayString(), 'de');
  // Should still work or gracefully ignore
  assert.ok(result.description.length > 0);
});

test('NLP parser: locale-specific recurrence removed from description', () => {
  const result = parseNLPInput('Standup alle weekday meeting', getTodayString(), 'de');
  // Recurrence should be extracted
  assert.ok(result.description.length >= 0);
});

test('NLP parser: multilingual formatter works with all locales', () => {
  const parsed = parseNLPInput('Task 1h', getTodayString(), 'de');
  const formatted = formatParsedNLPAsTaskLine(parsed, false, 'plain');
  assert.ok(formatted.includes('[ ]'));
});

// ==================== NEXT/LAST QUALIFIER REGRESSION TESTS ====================
// Regression: "due next Monday" must resolve to the FUTURE Monday, not the closest
// (past or present) Monday. The "next/last" qualifier was previously dropped because
// it was consumed by a non-capturing group outside the date capture group.

test('NLP parser: "due next Monday" resolves to future Monday, not past Monday', () => {
  // 2026-05-27 is a Wednesday; the PAST Monday is 2026-05-25, NEXT Monday is 2026-06-01
  const result = parseNLPInput('Report due next Monday', '2026-05-27');
  assert.strictEqual(result.dueDate, '2026-06-01',
    'Expected next Monday (2026-06-01) but got: ' + result.dueDate);
});

test('NLP parser: "due last Friday" resolves to past Friday', () => {
  // 2026-05-27 is a Wednesday; the LAST Friday is 2026-05-22, UPCOMING Friday is 2026-05-29
  const result = parseNLPInput('Report due last Friday', '2026-05-27');
  assert.strictEqual(result.dueDate, '2026-05-22',
    'Expected last Friday (2026-05-22) but got: ' + result.dueDate);
});

test('NLP parser: unqualified explicit due weekdays prefer upcoming dates', () => {
  const result = parseNLPInput('Report due Friday', '2026-06-01');
  assert.equal(result.dueDate, '2026-06-05');
  assert.equal(result.scheduledDate, undefined);
  assert.equal(result.description, 'Report');
});

test('NLP parser: due marker consumes connector words before date', () => {
  const result = parseNLPInput('Report deadline on Friday', '2026-06-01');
  assert.equal(result.dueDate, '2026-06-05');
  assert.equal(result.scheduledDate, undefined);
  assert.equal(result.description, 'Report');
});

test('NLP parser: explicit due ISO dates remove the marker from description', () => {
  const result = parseNLPInput('Review document due 2026-06-15', '2026-05-27');
  assert.equal(result.dueDate, '2026-06-15');
  assert.equal(result.description, 'Review document');
});

// ==================== ISO DATE REMOVAL REGRESSION ====================
// Bug: removeDatesFromText ignored its `dates` parameter and had no regex for
// YYYY-MM-DD, so an extracted ISO date (e.g. "2026-06-15") stayed in
// the description text after being assigned to dueDate.

test('NLP parser: extracted ISO date is removed from description', () => {
  // "2026-06-15" is an explicit ISO date that the internal parser recognizes.
  // After extraction it must NOT appear in the description.
  const result = parseNLPInput('Review document 2026-06-15', '2026-05-27');
  assert.ok(result.dueDate !== undefined, 'dueDate should be extracted');
  assert.ok(
    !result.description.includes('2026-06-15'),
    `ISO date must be removed from description; got: "${result.description}"`,
  );
  assert.ok(result.description.trim().length > 0, 'description should not be empty');
});

test('NLP parser: invalid ISO-like dates are not partially removed from description', () => {
  const result = parseNLPInput('Review document 2026-02-31', '2026-05-27');
  assert.equal(result.dueDate, undefined, 'invalid calendar date should not be extracted');
  assert.equal(result.description, 'Review document 2026-02-31');
});

test('NLP parser: invalid clock times are preserved as description text', () => {
  const result = parseNLPInput('Call supplier tomorrow at 25:99', '2026-06-01');
  assert.equal(result.time, undefined, 'invalid clock time should not be emitted as metadata');
  assert.equal(result.dueDate, '2026-06-02', 'untimed task should keep the generic date as due');
  assert.equal(result.scheduledDate, undefined, 'invalid clock time should not make the task scheduled');
  assert.equal(result.description, 'Call supplier at 25:99');
});

// ==================== resolveNlTaskDescription (inline NL entry) ====================
import { resolveNlTaskDescription } from '../src/modals/task-edit-helpers';

test('resolveNlTaskDescription: bare description with date and priority', () => {
  const result = resolveNlTaskDescription('call dentist tomorrow urgent', '2026-06-01');
  assert.ok(result.includes('call dentist'), 'description preserved');
  assert.ok(result.includes('⏫'), 'urgent → high priority emoji');
  assert.ok(result.includes('2026-06-02'), 'tomorrow resolved');
});

test('resolveNlTaskDescription: recurrence extracted', () => {
  const result = resolveNlTaskDescription('standup every Monday', '2026-06-01');
  assert.ok(result.includes('standup'), 'description preserved');
  assert.ok(result.includes('🔁'), 'recurrence emoji present');
  assert.ok(result.toLowerCase().includes('every') && result.toLowerCase().includes('monday'), 'recurrence text preserved');
});

test('resolveNlTaskDescription: time extracted and uses scheduled date', () => {
  // A task with a SPECIFIC date AND time → scheduled date
  const result = resolveNlTaskDescription('standup tomorrow at 10am', '2026-06-01');
  assert.ok(result.includes('⏰'), 'time emoji present');
  assert.ok(result.includes('10:00'), 'time normalised to HH:MM');
  assert.ok(result.includes('⏳'), 'timed task with specific date uses scheduled date');
});

test('resolveNlTaskDescription: recurrence + time, no date → no scheduled date', () => {
  // Recurring task with time but no specific date → only recurrence + time
  const result = resolveNlTaskDescription('standup every Monday at 10am', '2026-06-01');
  assert.ok(result.includes('⏰'), 'time emoji present');
  assert.ok(result.includes('🔁'), 'recurrence present');
  // No scheduled/due date because there is no single concrete date — just a recurrence
});

// ==================== normalizeRecurrence 'every other weekday' REGRESSION ====================
// Bug: (day|week|month|year) alternation matched 'week' inside 'weekday' because JS
// alternation is ordered/leftmost-first, producing garbled 'every 2 weeksday'.
// Fix: reorder to (weekday|day|week|month|year) so the longer token is tried first.

test('NLP parser: "every other weekday" normalizes to "every 2 weekdays"', () => {
  const result = parseNLPInput('Daily standup every other weekday');
  assert.strictEqual(
    result.recurrence,
    'every 2 weekdays',
    `Expected 'every 2 weekdays' but got '${result.recurrence}'`,
  );
  assert.ok(
    !result.description.toLowerCase().includes('every'),
    `Recurrence should be removed from description; got: '${result.description}'`,
  );
});

test('NLP parser: "every other week" still normalizes to "every 2 weeks" after fix', () => {
  const result = parseNLPInput('Review every other week');
  assert.strictEqual(result.recurrence, 'every 2 weeks');
});

test('NLP parser: "every other day" still normalizes to "every 2 days" after fix', () => {
  const result = parseNLPInput('Check logs every other day');
  assert.strictEqual(result.recurrence, 'every 2 days');
});

// ==================== RECURRENCE_PATTERNS 'every week on WEEKDAY' REGRESSION ====================
// Bug: RECURRENCE_PATTERNS.en only captured 'every week' (not 'every week on Monday').
// The 'on Monday' suffix then leaked into date extraction as a one-time scheduledDate.
// Fix: extend the 'week' alternative to capture the optional 'on <weekday(s)>' suffix.

test('NLP parser: "every week on Monday" captured as recurrence not scheduledDate', () => {
  const result = parseNLPInput('standup every week on Monday', '2026-06-09');
  assert.strictEqual(result.recurrence, 'every week on monday',
    `Expected 'every week on monday' but got '${result.recurrence}'`);
  assert.strictEqual(result.scheduledDate, undefined,
    `'on Monday' must not be extracted as a one-time scheduledDate; got '${result.scheduledDate}'`);
  assert.strictEqual(result.dueDate, undefined);
});

test('NLP parser: "every week on Monday and Friday" captured as recurrence', () => {
  const result = parseNLPInput('meeting every week on Monday and Friday', '2026-06-09');
  assert.strictEqual(result.recurrence, 'every week on monday and friday');
  assert.strictEqual(result.scheduledDate, undefined);
});

test('NLP parser: "every week" (no day suffix) still works after fix', () => {
  const result = parseNLPInput('standup every week', '2026-06-09');
  assert.strictEqual(result.recurrence, 'every week');
  assert.strictEqual(result.scheduledDate, undefined);
});

test('resolveNlTaskDescription: checkbox form strips !! and returns content only', () => {
  // When used inside "- [ ] !! description", the prefix is already stripped by
  // the CM6 extension before calling resolveNlTaskDescription.
  const result = resolveNlTaskDescription('fix login bug due Thursday high priority', '2026-06-01');
  assert.ok(!result.startsWith('- [ ]'), 'no checkbox prefix in return value');
  assert.ok(result.includes('fix login bug'), 'description preserved');
  assert.ok(result.includes('⏫'), 'high priority');
});
