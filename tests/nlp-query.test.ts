/**
 * Tests for naturalLanguageToTaskQuery (src/nlp-query.ts)
 *
 * The function translates simple NL queries into task query DSL.
 * Key correctness rule: every priority keyword that parseNLPInput recognises
 * must also be recognised by the guard regex inside naturalLanguageToTaskQuery,
 * so the priority filter is never silently dropped.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { naturalLanguageToTaskQuery } from '../src/nlp-query';

const TODAY = '2026-06-09';

// ── Status filters ─────────────────────────────────────────────────────────

test('NL task query: "overdue" → not done + due before today', () => {
  const result = naturalLanguageToTaskQuery('overdue tasks', TODAY);
  assert.ok(result?.includes('not done'), `expected "not done" in: ${result}`);
  assert.ok(result?.includes(`due before ${TODAY}`), `expected due before today in: ${result}`);
});

test('NL task query: "completed" → done', () => {
  const result = naturalLanguageToTaskQuery('completed tasks', TODAY);
  assert.ok(result?.includes('done'), `expected "done" in: ${result}`);
  assert.ok(!result?.includes('not done'), `should not include "not done" in: ${result}`);
});

test('NL task query: "open" → not done', () => {
  const result = naturalLanguageToTaskQuery('open tasks', TODAY);
  assert.ok(result?.includes('not done'), `expected "not done" in: ${result}`);
});

test('NL task query: "pending tasks" → not done', () => {
  const result = naturalLanguageToTaskQuery('pending tasks', TODAY);
  assert.ok(result?.includes('not done'), `expected "not done" in: ${result}`);
});

// ── Due date filters ───────────────────────────────────────────────────────

test('NL task query: "tasks due today" → due on today', () => {
  // Note: bare "due today" starts with DSL keyword "due" and returns null (correct).
  // Use a non-DSL prefix so NL translation fires.
  const result = naturalLanguageToTaskQuery('tasks due today', TODAY);
  assert.ok(result?.includes(`due on ${TODAY}`), `expected "due on ${TODAY}" in: ${result}`);
});

test('NL task query: "tasks due tomorrow" → due on tomorrow', () => {
  const result = naturalLanguageToTaskQuery('tasks due tomorrow', TODAY);
  assert.ok(result?.includes('due on 2026-06-10'), `expected "due on 2026-06-10" in: ${result}`);
});

// ── Priority: keywords ALREADY in the old guard (regression) ──────────────

test('NL task query: "urgent tasks" → priority is high', () => {
  const result = naturalLanguageToTaskQuery('urgent tasks', TODAY);
  assert.ok(result?.includes('priority is high'), `expected "priority is high" in: ${result}`);
});

test('NL task query: "critical bug" → priority is highest', () => {
  const result = naturalLanguageToTaskQuery('critical bug', TODAY);
  assert.ok(result?.includes('priority is highest'), `expected "priority is highest" in: ${result}`);
});

test('NL task query: "high priority tasks" → priority is high', () => {
  const result = naturalLanguageToTaskQuery('high priority tasks', TODAY);
  assert.ok(result?.includes('priority is high'), `expected "priority is high" in: ${result}`);
});

test('NL task query: "medium priority" → priority is medium', () => {
  const result = naturalLanguageToTaskQuery('medium priority', TODAY);
  assert.ok(result?.includes('priority is medium'), `expected "priority is medium" in: ${result}`);
});

test('NL task query: "low priority tasks" → priority is low', () => {
  const result = naturalLanguageToTaskQuery('low priority tasks', TODAY);
  assert.ok(result?.includes('priority is low'), `expected "priority is low" in: ${result}`);
});

// ── Priority: keywords MISSING from the old guard (the bug) ───────────────
//
// These all parse to a non-empty priority emoji via parseNLPInput, but the old
// guard regex did not include them, so the priority filter was silently dropped
// and naturalLanguageToTaskQuery returned null.
//
// Note: inputs must NOT start with a known DSL keyword (status, priority,
// due, show, hide, …) or hasExplicitQuerySyntax returns null first.

test('NL task query: "asap" keyword emits priority filter (was silently dropped)', () => {
  const result = naturalLanguageToTaskQuery('asap tasks', TODAY);
  assert.ok(
    result !== null && result.includes('priority is high'),
    `"asap" should produce "priority is high"; got: ${String(result)}`,
  );
});

test('NL task query: "important" keyword emits priority filter (was silently dropped)', () => {
  const result = naturalLanguageToTaskQuery('important tasks', TODAY);
  assert.ok(
    result !== null && result.includes('priority is high'),
    `"important" should produce "priority is high"; got: ${String(result)}`,
  );
});

test('NL task query: "someday" keyword emits priority filter (was silently dropped)', () => {
  const result = naturalLanguageToTaskQuery('someday tasks', TODAY);
  assert.ok(
    result !== null && result.includes('priority is lowest'),
    `"someday" should produce "priority is lowest"; got: ${String(result)}`,
  );
});

test('NL task query: "maybe" keyword emits priority filter (was silently dropped)', () => {
  const result = naturalLanguageToTaskQuery('maybe tasks', TODAY);
  assert.ok(
    result !== null && result.includes('priority is lowest'),
    `"maybe" should produce "priority is lowest"; got: ${String(result)}`,
  );
});

test('NL task query: "p1" code emits priority filter', () => {
  const result = naturalLanguageToTaskQuery('p1 bugs', TODAY);
  assert.ok(
    result !== null && result.includes('priority is high'),
    `"p1" should produce "priority is high"; got: ${String(result)}`,
  );
});

test('NL task query: "p0" code emits highest priority filter', () => {
  const result = naturalLanguageToTaskQuery('p0 bugs', TODAY);
  assert.ok(
    result !== null && result.includes('priority is highest'),
    `"p0" should produce "priority is highest"; got: ${String(result)}`,
  );
});

// ── Tags ───────────────────────────────────────────────────────────────────

test('NL task query: hashtag → tag includes filter', () => {
  const result = naturalLanguageToTaskQuery('tasks #work', TODAY);
  assert.ok(result?.includes('tag includes work'), `expected "tag includes work" in: ${result}`);
});

// ── Guard: no false positives for excluded inputs ─────────────────────────

test('NL task query: explicit query syntax is passed through as null', () => {
  // Inputs that already look like DSL should return null
  assert.strictEqual(naturalLanguageToTaskQuery('not done\nlimit 5', TODAY), null);
  assert.strictEqual(naturalLanguageToTaskQuery('priority is high', TODAY), null);
});

test('NL task query: empty input returns null', () => {
  assert.strictEqual(naturalLanguageToTaskQuery('', TODAY), null);
});

test('NL task query: unrecognised input returns null', () => {
  assert.strictEqual(naturalLanguageToTaskQuery('xyzzy foo bar', TODAY), null);
});

// ── Combined filters ───────────────────────────────────────────────────────

test('NL task query: "urgent overdue tasks" combines status + priority', () => {
  const result = naturalLanguageToTaskQuery('urgent overdue tasks', TODAY);
  assert.ok(result?.includes('not done'), `expected "not done" in: ${result}`);
  assert.ok(result?.includes(`due before ${TODAY}`), `expected due before in: ${result}`);
  assert.ok(result?.includes('priority is high'), `expected priority filter in: ${result}`);
});

test('NL task query: "asap overdue tasks" combines priority and due-before (bug regression)', () => {
  // Prior to fix, "asap" was missing from the guard, so this returned just
  // ["not done", "due before today"] without the priority filter.
  const result = naturalLanguageToTaskQuery('asap overdue tasks', TODAY);
  assert.ok(result !== null, 'should return a non-null query');
  assert.ok(result!.includes('priority is high'), `expected priority filter in: ${result}`);
  assert.ok(result!.includes('not done'), `expected "not done" in: ${result}`);
});
