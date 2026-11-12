import assert from 'node:assert/strict';
import test from 'node:test';
import {
  QUERY_RESULT_PAGE_SIZE,
  QUERY_RESULT_PAGE_SIZES,
  QUERY_RESULT_SAFETY_CEILING,
  QueryResultPagingSession,
} from '../src/query-result-paging';
import { parseTaskQuery } from '../src/task-query';

void test('query paging bounds visible rows and reaches every result', () => {
  const session = new QueryResultPagingSession();
  const values = Array.from({ length: QUERY_RESULT_SAFETY_CEILING }, (_value, index) => `task-${index}`);
  session.update(values);
  assert.equal(session.visible(values).length, QUERY_RESULT_PAGE_SIZE);
  assert.equal(session.pageCount, QUERY_RESULT_SAFETY_CEILING / QUERY_RESULT_PAGE_SIZE);
  while (session.next()) { /* visit every page */ }
  assert.deepEqual(session.visible(values), values.slice(-QUERY_RESULT_PAGE_SIZE));
  assert.equal(session.next(), false);
  while (session.previous()) { /* return to first page */ }
  assert.equal(session.previous(), false);
});

void test('query paging clamps after shrink and prunes stale key state', () => {
  const session = new QueryResultPagingSession();
  const keys = Array.from({ length: 250 }, (_value, index) => `task-${index}`);
  session.update(keys);
  session.next();
  session.next();
  session.selectedKeys.add('task-2');
  session.selectedKeys.add('task-249');
  session.focusedKey = 'task-249';
  session.update(keys.slice(0, 75));
  assert.equal(session.currentPage, 0);
  assert.deepEqual([...session.selectedKeys], ['task-2']);
  assert.equal(session.focusedKey, null);
});

void test('query parser rejects explicit result and group limits above the safety ceiling', () => {
  assert.throws(() => parseTaskQuery(`limit ${QUERY_RESULT_SAFETY_CEILING + 1}`), /cannot exceed/u);
  assert.throws(() => parseTaskQuery(`limit groups to ${QUERY_RESULT_SAFETY_CEILING + 1} tasks`), /cannot exceed/u);
  assert.equal(parseTaskQuery(`limit ${QUERY_RESULT_SAFETY_CEILING}`).limit, QUERY_RESULT_SAFETY_CEILING);
});

void test('query paging preserves the visible offset across reviewed page-size changes', () => {
  const session = new QueryResultPagingSession();
  const keys = Array.from({ length: 500 }, (_value, index) => `task-${index}`);
  session.update(keys);
  session.next();
  assert.equal(session.start, 100);
  assert.equal(session.setPageSize(50), true);
  assert.equal(session.start, 100);
  assert.equal(session.currentPageSize, QUERY_RESULT_PAGE_SIZES[0]);
  assert.equal(session.setPageSize(73), false);
});
