import test from 'node:test';
import assert from 'node:assert/strict';
import { QueryExplainer, QueryLinter, parseNaturalLanguageQuery } from '../src/query-polish';

const linter = new QueryLinter();
const explainer = new QueryExplainer();

// ── QueryLinter — existing baseline ─────────────────────────────────────────

test('query polish: lints invalid equality operator and auto-fixes it', () => {
  const result = linter.lint('priority == high\nlimit 10');
  assert.ok(result.warnings.some((w) => w.code === 'INVALID_OPERATOR'));
  assert.equal(linter.fix('priority == high'), 'priority = high');
});

test('query polish: explains a valid query', () => {
  const explanation = explainer.explain('not done\nsort by due\nlimit 5');
  assert.match(explanation, /This query will:/);
  assert.match(explanation, /Limit/);
});

// ── QueryLinter — errors ─────────────────────────────────────────────────────

test('linter: empty query produces EMPTY_QUERY error', () => {
  const result = linter.lint('   ');
  assert.equal(result.isValid, false);
  assert.ok(result.errors.some((e) => e.code === 'EMPTY_QUERY'));
});

test('linter: missing sort field produces INCOMPLETE_SORT_BY error', () => {
  const result = linter.lint('sort by\nlimit 5');
  assert.equal(result.isValid, false);
  assert.ok(result.errors.some((e) => e.code === 'INCOMPLETE_SORT_BY'));
});

test('linter: missing group field produces INCOMPLETE_GROUP_BY error', () => {
  const result = linter.lint('group by\nlimit 5');
  assert.equal(result.isValid, false);
  assert.ok(result.errors.some((e) => e.code === 'INCOMPLETE_GROUP_BY'));
});

test('linter: unbalanced open parenthesis produces UNBALANCED_PARENS error', () => {
  const result = linter.lint('(status is done\nlimit 5');
  assert.equal(result.isValid, false);
  assert.ok(result.errors.some((e) => e.code === 'UNBALANCED_PARENS'));
});

test('linter: invalid ISO date (month 13) produces INVALID_DATE error', () => {
  const result = linter.lint('due before 2026-13-01\nlimit 5');
  assert.equal(result.isValid, false);
  assert.ok(result.errors.some((e) => e.code === 'INVALID_DATE'));
});

test('linter: invalid ISO date (day 32) produces INVALID_DATE error', () => {
  const result = linter.lint('due on 2026-06-32\nlimit 5');
  assert.equal(result.isValid, false);
  assert.ok(result.errors.some((e) => e.code === 'INVALID_DATE'));
});

test('linter: valid ISO date does not produce INVALID_DATE error', () => {
  const result = linter.lint('due on 2026-06-15\nlimit 5');
  assert.ok(!result.errors.some((e) => e.code === 'INVALID_DATE'));
});

test('linter: invalid ISO dates are checked for all date-prefix filters', () => {
  for (const field of ['scheduled', 'start', 'cancelled', 'canceled', 'reminder', 'happens', 'follow-up', 'follow up']) {
    const result = linter.lint(`${field} before 2026-02-31\nlimit 5`);
    assert.equal(result.isValid, false, `${field} should make query invalid`);
    assert.ok(result.errors.some((e) => e.code === 'INVALID_DATE'), `${field} should produce INVALID_DATE`);
  }
});

test('linter: missing priority value produces MISSING_FILTER_VALUE error', () => {
  const result = linter.lint('priority\nlimit 5');
  assert.equal(result.isValid, false);
  assert.ok(result.errors.some((e) => e.code === 'MISSING_FILTER_VALUE'));
});

// ── QueryLinter — warnings ────────────────────────────────────────────────────

test('linter: completely unknown keyword produces UNKNOWN_KEYWORD warning', () => {
  const result = linter.lint('xyzzy is high\nlimit 5');
  assert.ok(result.warnings.some((w) => w.code === 'UNKNOWN_KEYWORD'));
});

test('linter: near-typo keyword produces UNKNOWN_KEYWORD_TYPO warning with suggestion', () => {
  // "pririty" is 1 edit away from "priority"
  const result = linter.lint('pririty is high\nlimit 5');
  const typoWarning = result.warnings.find((w) => w.code === 'UNKNOWN_KEYWORD_TYPO');
  assert.ok(typoWarning, 'should produce UNKNOWN_KEYWORD_TYPO');
  assert.ok(typoWarning!.suggestion?.includes('priority'));
});

test('linter: duplicate filter line produces REDUNDANT_FILTER warning', () => {
  const result = linter.lint('priority is high\npriority is high\nlimit 5');
  assert.ok(result.warnings.some((w) => w.code === 'REDUNDANT_FILTER'));
});

test('linter: unknown group field produces UNKNOWN_GROUP_FIELD warning', () => {
  const result = linter.lint('group by galaxy\nlimit 5');
  assert.ok(result.warnings.some((w) => w.code === 'UNKNOWN_GROUP_FIELD'));
});

test('linter: unknown sort field produces UNKNOWN_SORT_FIELD warning', () => {
  const result = linter.lint('sort by galaxy\nlimit 5');
  assert.ok(result.warnings.some((w) => w.code === 'UNKNOWN_SORT_FIELD'));
});

test('linter: == operator produces INVALID_OPERATOR warning', () => {
  const result = linter.lint('status == done\nlimit 5');
  assert.ok(result.warnings.some((w) => w.code === 'INVALID_OPERATOR'));
});

// ── QueryLinter — suggestions ─────────────────────────────────────────────────

test('linter: sort without limit and no date bound suggests adding limit (performance)', () => {
  const result = linter.lint('not done\nsort by priority');
  const perf = result.suggestions.find((s) => s.type === 'performance');
  assert.ok(perf, 'should suggest performance improvement');
  assert.match(perf!.message, /limit/i);
});

test('linter: query without any limit suggests adding one (completeness)', () => {
  const result = linter.lint('not done');
  const sugg = result.suggestions.find((s) => s.type === 'completeness');
  assert.ok(sugg);
});

test('linter: comments and blank lines are skipped without warnings', () => {
  const result = linter.lint('// This is a comment\n\nnot done\nlimit 10');
  assert.equal(result.isValid, true);
  assert.equal(result.errors.length, 0);
});

test('linter: valid known sort field produces no UNKNOWN_SORT_FIELD', () => {
  const result = linter.lint('sort by priority\nlimit 5');
  assert.ok(!result.warnings.some((w) => w.code === 'UNKNOWN_SORT_FIELD'));
});

test('linter: supported extended sort and group fields do not warn', () => {
  const result = linter.lint('sort by actual\ngroup by assignee\nlimit 5');
  assert.ok(!result.warnings.some((w) => w.code === 'UNKNOWN_SORT_FIELD'));
  assert.ok(!result.warnings.some((w) => w.code === 'UNKNOWN_GROUP_FIELD'));
});

test('linter: sort and group directives are case-insensitive', () => {
  const result = linter.lint('Sort by Priority\nGroup by Status\nlimit 5');
  assert.equal(result.isValid, true);
  assert.ok(!result.warnings.some((w) => w.code === 'UNKNOWN_SORT_FIELD'));
  assert.ok(!result.warnings.some((w) => w.code === 'UNKNOWN_GROUP_FIELD'));
});

test('linter: uppercase priority filter still reports missing values', () => {
  const result = linter.lint('Priority\nlimit 5');
  assert.equal(result.isValid, false);
  assert.ok(result.errors.some((e) => e.code === 'MISSING_FILTER_VALUE'));
});

test('linter: uppercase known sort and group fields are accepted', () => {
  const result = linter.lint('sort by Priority\ngroup by Status\nlimit 5');
  assert.equal(result.isValid, true);
  assert.ok(!result.warnings.some((w) => w.code === 'UNKNOWN_SORT_FIELD'));
  assert.ok(!result.warnings.some((w) => w.code === 'UNKNOWN_GROUP_FIELD'));
});

test('linter: collaboration fields do not produce UNKNOWN_KEYWORD warnings', () => {
  const result = linter.lint('assignee is Alice\nreviewer includes Bob\nlimit 5');
  assert.ok(!result.warnings.some((w) => w.code === 'UNKNOWN_KEYWORD' || w.code === 'UNKNOWN_KEYWORD_TYPO'));
});

test('linter: natural-language recurring output does not produce UNKNOWN_KEYWORD warnings', () => {
  const result = linter.lint('is recurring\nlimit 5');
  assert.ok(!result.warnings.some((w) => w.code === 'UNKNOWN_KEYWORD' || w.code === 'UNKNOWN_KEYWORD_TYPO'));
});

test('linter: follow-up date filters do not produce UNKNOWN_KEYWORD warnings', () => {
  for (const field of ['follow-up', 'follow up', 'followup']) {
    const result = linter.lint(`${field} before 2026-06-15\nlimit 5`);
    assert.ok(!result.warnings.some((w) => w.code === 'UNKNOWN_KEYWORD' || w.code === 'UNKNOWN_KEYWORD_TYPO'), `${field} should be a known filter`);
  }
});

test('linter: canceled alias does not produce UNKNOWN_KEYWORD warnings', () => {
  const result = linter.lint('canceled before 2026-06-15\nlimit 5');
  assert.ok(!result.warnings.some((w) => w.code === 'UNKNOWN_KEYWORD' || w.code === 'UNKNOWN_KEYWORD_TYPO'));
});

// ── QueryLinter — fix ─────────────────────────────────────────────────────────

test('linter.fix: corrects "due_date" typo to "due"', () => {
  assert.equal(linter.fix('due_date before today'), 'due before today');
});

test('linter.fix: adds missing "by" in "sort priority"', () => {
  assert.equal(linter.fix('sort priority'), 'sort by priority');
});

test('linter.fix: adds missing "by" in "group status"', () => {
  assert.equal(linter.fix('group status'), 'group by status');
});

test('linter.fix: adds missing "by" in "sort Priority" (capitalized)', () => {
  assert.equal(linter.fix('sort Priority'), 'sort by Priority');
});

test('linter.fix: adds missing "by" in "group STATUS" (uppercase)', () => {
  assert.equal(linter.fix('group STATUS'), 'group by STATUS');
});

// ── QueryExplainer ───────────────────────────────────────────────────────────

test('explainer: produces Active Filters section for filter lines', () => {
  const out = explainer.explain('not done\npriority is high\nlimit 10');
  assert.match(out, /#### Active Filters/);
  assert.match(out, /`not done`/);
  assert.match(out, /`priority is high`/);
});

test('explainer: produces Sort Order section', () => {
  const out = explainer.explain('not done\nsort by due\nlimit 10');
  assert.match(out, /#### Sort Order/);
  assert.match(out, /`sort by due`/);
});

test('explainer: produces Grouping section', () => {
  const out = explainer.explain('not done\ngroup by status\nlimit 10');
  assert.match(out, /#### Grouping/);
  assert.match(out, /`group by status`/);
});

test('explainer: produces Layout Options section with Limit', () => {
  const out = explainer.explain('not done\nlimit 25');
  assert.match(out, /#### Layout Options/);
  assert.match(out, /Limit to 25 tasks/);
});

test('explainer: parses group limits without reporting NaN', () => {
  const out = explainer.explain('not done\ngroup by status\nlimit groups 3');
  assert.match(out, /`limit groups 3`/);
  assert.match(out, /Limit to 3 groups/);
  assert.match(out, /Up to 3 groups/);
  assert.doesNotMatch(out, /NaN/);
});

test('explainer: shows all-tasks fallback for empty query', () => {
  const out = explainer.explain('// just a comment');
  assert.match(out, /No directives found/);
});

test('explainer: Result summary mentions up-to-N when limit set', () => {
  const out = explainer.explain('not done\nlimit 7');
  assert.match(out, /Up to 7 tasks/);
});

test('explainer: Result summary mentions sorted when sort present', () => {
  const out = explainer.explain('not done\nsort by priority\nlimit 5');
  assert.match(out, /sorted/);
});

test('explainer: recognizes uppercase sort and group directives', () => {
  const out = explainer.explain('not done\nSort by Priority\nGroup by Status\nlimit 5');
  assert.match(out, /#### Sort Order/);
  assert.match(out, /`Sort by Priority`/);
  assert.match(out, /#### Grouping/);
  assert.match(out, /`Group by Status`/);
  assert.match(out, /grouped, sorted/);
});

// ── parseNaturalLanguageQuery ─────────────────────────────────────────────────

test('NL query: "due today" → "due on today"', () => {
  assert.equal(parseNaturalLanguageQuery('due today'), 'due on today');
});

test('NL query: "overdue" → "due before today"', () => {
  assert.equal(parseNaturalLanguageQuery('overdue'), 'due before today');
});

test('NL query: "high priority" → "priority is high"', () => {
  assert.equal(parseNaturalLanguageQuery('high priority'), 'priority is high');
});

test('NL query: "urgent" → "priority is urgent"', () => {
  assert.equal(parseNaturalLanguageQuery('urgent'), 'priority is urgent');
});

test('NL query: "low priority" → "priority is low"', () => {
  assert.equal(parseNaturalLanguageQuery('low priority'), 'priority is low');
});

test('NL query: "not done" → "status.type is not DONE"', () => {
  assert.equal(parseNaturalLanguageQuery('not done'), 'status.type is not DONE');
});

test('NL query: "incomplete" → "status.type is not DONE"', () => {
  assert.equal(parseNaturalLanguageQuery('incomplete'), 'status.type is not DONE');
});

test('NL query: "complete" → "status.type is DONE"', () => {
  assert.equal(parseNaturalLanguageQuery('complete'), 'status.type is DONE');
});

test('NL query: "due tomorrow" → "due on tomorrow"', () => {
  assert.equal(parseNaturalLanguageQuery('due tomorrow'), 'due on tomorrow');
});

test('NL query: "due next week" emits supported natural date syntax', () => {
  assert.equal(parseNaturalLanguageQuery('due next week'), 'due after today\ndue before next week');
});

test('NL query: "no due date" keeps parser-supported wording', () => {
  assert.equal(parseNaturalLanguageQuery('no due date'), 'no due date');
});

test('NL query: "tagged #work" → "tag includes #work"', () => {
  assert.equal(parseNaturalLanguageQuery('tagged #work'), 'tag includes #work');
});

test('NL query: "tagged work" (no hash) → "tag includes #work"', () => {
  assert.equal(parseNaturalLanguageQuery('tagged work'), 'tag includes #work');
});

test('NL query: "in project Engineering" → "project includes Engineering"', () => {
  assert.equal(parseNaturalLanguageQuery('in project Engineering'), 'project includes Engineering');
});

test('NL query: "project Engineering" → "project includes Engineering"', () => {
  assert.equal(parseNaturalLanguageQuery('project Engineering'), 'project includes Engineering');
});

test('NL query: "recurring" → "is recurring"', () => {
  assert.equal(parseNaturalLanguageQuery('recurring'), 'is recurring');
});

test('NL query: "on hold" → "status.type is ON_HOLD"', () => {
  assert.equal(parseNaturalLanguageQuery('on hold'), 'status.type is ON_HOLD');
});

test('NL query: "assigned to Alice" → "assignee is Alice"', () => {
  assert.equal(parseNaturalLanguageQuery('assigned to Alice'), 'assignee is Alice');
});

test('NL query: unrecognised phrase passes through unchanged', () => {
  assert.equal(parseNaturalLanguageQuery('priority is high'), 'priority is high');
});

test('NL query: leading/trailing whitespace is trimmed', () => {
  assert.equal(parseNaturalLanguageQuery('  due today  '), 'due on today');
});

test('NL query: case-insensitive matching', () => {
  assert.equal(parseNaturalLanguageQuery('DUE TODAY'), 'due on today');
  assert.equal(parseNaturalLanguageQuery('HIGH PRIORITY'), 'priority is high');
});
