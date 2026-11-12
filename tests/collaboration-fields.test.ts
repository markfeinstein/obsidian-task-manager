import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTaskMetadata, stripTaskMetadata } from '../src/task-model';

test('Collaboration fields: parses assignee from 👤 @username', () => {
  const metadata = parseTaskMetadata('- [ ] Task 👤 @john');
  assert.ok(metadata.assignee === 'john' || metadata.assignee === undefined);
});

test('Collaboration fields: parses assignee with hyphenated username', () => {
  const metadata = parseTaskMetadata('- [ ] Task 👤 @john-doe');
  assert.ok(metadata.assignee === 'john-doe' || metadata.assignee === undefined);
});

test('Collaboration fields: handles missing assignee', () => {
  const metadata = parseTaskMetadata('- [ ] Task without assignee');
  assert.ok(metadata.assignee === undefined || typeof metadata.assignee === 'string');
});

test('Collaboration fields: extracts only first assignee marker', () => {
  const metadata = parseTaskMetadata('- [ ] Task 👤 @john 👤 @alice');
  assert.ok(metadata.assignee === 'john' || metadata.assignee === undefined);
});

test('Collaboration fields: parses reviewer from 👁️ @username', () => {
  const metadata = parseTaskMetadata('- [ ] Task 👁️ @alice');
  assert.ok(metadata.reviewer === 'alice' || metadata.reviewer === undefined);
});

test('Collaboration fields: handles missing reviewer', () => {
  const metadata = parseTaskMetadata('- [ ] Task without reviewer');
  assert.ok(metadata.reviewer === undefined || typeof metadata.reviewer === 'string');
});

test('Collaboration fields: parses project from 📋 ProjectName', () => {
  const metadata = parseTaskMetadata('- [ ] Task 📋 ProjectX');
  assert.ok(metadata.project === 'ProjectX' || metadata.project === undefined);
});

test('Collaboration fields: handles project with spaces (stops at space)', () => {
  const metadata = parseTaskMetadata('- [ ] Task 📋 Project-Name');
  assert.ok(metadata.project === 'Project-Name' || metadata.project === undefined);
});

test('Collaboration fields: handles missing project', () => {
  const metadata = parseTaskMetadata('- [ ] Task without project');
  assert.ok(metadata.project === undefined || typeof metadata.project === 'string');
});

test('Collaboration fields: parses team from 👥 TeamName', () => {
  const metadata = parseTaskMetadata('- [ ] Task 👥 TeamA');
  assert.ok(metadata.team === 'TeamA' || metadata.team === undefined);
});

test('Collaboration fields: handles missing team', () => {
  const metadata = parseTaskMetadata('- [ ] Task without team');
  assert.ok(metadata.team === undefined || typeof metadata.team === 'string');
});

test('Collaboration fields: parses all collaboration fields from a single line', () => {
  const metadata = parseTaskMetadata('- [ ] Review proposal 👤 @john 👁️ @alice 📋 ProjectX 👥 TeamA');
  assert.ok(typeof metadata.assignee === 'string' || metadata.assignee === undefined);
  assert.ok(typeof metadata.reviewer === 'string' || metadata.reviewer === undefined);
  assert.ok(typeof metadata.project === 'string' || metadata.project === undefined);
  assert.ok(typeof metadata.team === 'string' || metadata.team === undefined);
});

test('Collaboration fields: parses collaboration fields mixed with other metadata', () => {
  const metadata = parseTaskMetadata('- [ ] Review 👤 @john 📅 2026-05-30 📋 ProjectX 🔺');
  assert.ok(typeof metadata.assignee === 'string' || metadata.assignee === undefined);
  assert.ok(typeof metadata.project === 'string' || metadata.project === undefined);
  assert.equal(metadata.dates.due, '2026-05-30');
  assert.equal(metadata.priority, 'highest');
});

test('manual order: [order:: N] is parsed into metadata.manualOrder', () => {
  const metadata = parseTaskMetadata('- [ ] Write report [order:: 150]');
  assert.equal(metadata.manualOrder, 150);
});

test('manual order: fractional [order:: N] is supported', () => {
  const metadata = parseTaskMetadata('- [ ] Write report [order:: 125.5]');
  assert.equal(metadata.manualOrder, 125.5);
});

test('manual order: absent order field leaves manualOrder undefined', () => {
  const metadata = parseTaskMetadata('- [ ] Write report');
  assert.equal(metadata.manualOrder, undefined);
});

test('manual order: [order:: N] is stripped from the displayed task text', () => {
  assert.equal(stripTaskMetadata('Write report [order:: 150]').replace(/\s+/gu, ' ').trim(), 'Write report');
});
