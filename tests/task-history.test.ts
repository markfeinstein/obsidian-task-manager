import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TaskHistoryTracker,
  generateActivityReport,
  generateActivityHeatmap,
  generateAuditReport,
  formatActivityAsMarkdown,
  type TaskAuditEntry,
} from '../src/task-history';

// ── helpers ───────────────────────────────────────────────────────────────

function makeEntry(overrides: Partial<TaskAuditEntry> = {}): TaskAuditEntry {
  return {
    timestamp: new Date('2026-05-31T10:00:00Z'),
    taskId: 'Tasks.md:task-1',
    filePath: 'Tasks.md',
    action: 'status_change',
    before: { status: 'todo' },
    after: { status: 'done' },
    changedFields: { status: { oldValue: 'todo', newValue: 'done' } },
    source: 'manual',
    ...overrides,
  };
}

// ── recordChange / getTaskHistory ─────────────────────────────────────────

test('TaskHistoryTracker: recordChange stores an entry', () => {
  const tracker = new TaskHistoryTracker();
  tracker.recordChange(makeEntry());
  const history = tracker.getTaskHistory('Tasks.md:task-1');
  assert.ok(history !== null);
  assert.equal(history!.totalChanges, 1);
  assert.equal(history!.entries[0].action, 'status_change');
});

test('TaskHistoryTracker: getTaskHistory returns null for unknown task', () => {
  const tracker = new TaskHistoryTracker();
  assert.equal(tracker.getTaskHistory('unknown'), null);
});

test('TaskHistoryTracker: records all required event types', () => {
  const tracker = new TaskHistoryTracker();
  const types: TaskAuditEntry['action'][] = [
    'status_change', 'date_change', 'priority_change',
    'sync_event', 'postponement', 'recurrence_spawn', 'conflict',
  ];
  for (const action of types) {
    tracker.recordChange(makeEntry({ taskId: `task-${action}`, action }));
  }
  for (const action of types) {
    const h = tracker.getTaskHistory(`task-${action}`);
    assert.ok(h !== null, `history missing for action ${action}`);
    assert.equal(h!.entries[0].action, action);
  }
});

test('TaskHistoryTracker: before/after fields are stored correctly', () => {
  const tracker = new TaskHistoryTracker();
  tracker.recordChange(makeEntry({
    action: 'priority_change',
    before: { priority: 'normal' },
    after: { priority: 'high' },
    changedFields: {},
  }));
  const entry = tracker.getTaskHistory('Tasks.md:task-1')!.entries[0];
  assert.deepEqual(entry.before, { priority: 'normal' });
  assert.deepEqual(entry.after, { priority: 'high' });
});

test('TaskHistoryTracker: source field is stored', () => {
  const tracker = new TaskHistoryTracker();
  tracker.recordChange(makeEntry({ source: 'recurrence' }));
  const entry = tracker.getTaskHistory('Tasks.md:task-1')!.entries[0];
  assert.equal(entry.source, 'recurrence');
});

// ── filterEntries ─────────────────────────────────────────────────────────

test('TaskHistoryTracker.filterEntries: filters by taskId', () => {
  const tracker = new TaskHistoryTracker();
  tracker.recordChange(makeEntry({ taskId: 'task-A', action: 'status_change' }));
  tracker.recordChange(makeEntry({ taskId: 'task-B', action: 'date_change' }));
  const results = tracker.filterEntries({ taskId: 'task-A' });
  assert.equal(results.length, 1);
  assert.equal(results[0].taskId, 'task-A');
});

test('TaskHistoryTracker.filterEntries: filters by eventType', () => {
  const tracker = new TaskHistoryTracker();
  tracker.recordChange(makeEntry({ taskId: 'task-A', action: 'status_change' }));
  tracker.recordChange(makeEntry({ taskId: 'task-A', action: 'date_change' }));
  tracker.recordChange(makeEntry({ taskId: 'task-B', action: 'status_change' }));
  const results = tracker.filterEntries({ eventType: 'status_change' });
  assert.equal(results.length, 2);
  assert.ok(results.every((e) => e.action === 'status_change'));
});

test('TaskHistoryTracker.filterEntries: combined taskId + eventType filter', () => {
  const tracker = new TaskHistoryTracker();
  tracker.recordChange(makeEntry({ taskId: 'task-A', action: 'status_change' }));
  tracker.recordChange(makeEntry({ taskId: 'task-A', action: 'date_change' }));
  tracker.recordChange(makeEntry({ taskId: 'task-B', action: 'status_change' }));
  const results = tracker.filterEntries({ taskId: 'task-A', eventType: 'status_change' });
  assert.equal(results.length, 1);
  assert.equal(results[0].taskId, 'task-A');
  assert.equal(results[0].action, 'status_change');
});

test('TaskHistoryTracker.filterEntries: returns empty array when no match', () => {
  const tracker = new TaskHistoryTracker();
  tracker.recordChange(makeEntry({ action: 'status_change' }));
  const results = tracker.filterEntries({ eventType: 'conflict' });
  assert.equal(results.length, 0);
});

// ── getAllEntries ─────────────────────────────────────────────────────────

test('TaskHistoryTracker.getAllEntries: returns all entries across tasks, most recent first', () => {
  const tracker = new TaskHistoryTracker();
  const t1 = new Date('2026-05-31T08:00:00Z');
  const t2 = new Date('2026-05-31T09:00:00Z');
  tracker.recordChange(makeEntry({ taskId: 'A', timestamp: t1 }));
  tracker.recordChange(makeEntry({ taskId: 'B', timestamp: t2 }));
  const all = tracker.getAllEntries();
  assert.equal(all.length, 2);
  assert.ok(all[0].timestamp >= all[1].timestamp, 'sorted most recent first');
});

// ── generateAuditReport ───────────────────────────────────────────────────

test('generateAuditReport: produces markdown table with events', () => {
  const tracker = new TaskHistoryTracker();
  tracker.recordChange(makeEntry({ action: 'status_change', comment: 'marked done' }));
  tracker.recordChange(makeEntry({ taskId: 'task-2', action: 'recurrence_spawn' }));
  const report = generateAuditReport(tracker);
  assert.match(report, /# Task Audit Report/u);
  assert.match(report, /\| Time \| Task \| Event \| Source \| Detail \|/u);
  assert.match(report, /status_change/u);
  assert.match(report, /recurrence_spawn/u);
});

test('generateAuditReport: filters by eventType when provided', () => {
  const tracker = new TaskHistoryTracker();
  tracker.recordChange(makeEntry({ action: 'status_change' }));
  tracker.recordChange(makeEntry({ taskId: 'task-2', action: 'conflict' }));
  const report = generateAuditReport(tracker, { eventType: 'conflict' });
  assert.match(report, /conflict/u);
  // The table rows should only contain 'conflict'; 'status_change' may still appear in Statistics.
  const tableSection = report.slice(report.indexOf('## Recent Events'));
  assert.ok(!tableSection.includes('status_change'), 'status_change should not be in the events table');
});

test('generateAuditReport: escapes pipes in all free-text table cells', () => {
  const tracker = new TaskHistoryTracker();
  tracker.recordChange(makeEntry({
    taskId: 'task|one',
    action: 'commented',
    author: 'ann|ops',
    source: undefined,
    comment: 'needs | review',
  }));
  const report = generateAuditReport(tracker);
  const row = report.split('\n').find((line) => line.includes('task\\|one')) ?? '';
  assert.ok(row.includes('task\\|one'));
  assert.ok(row.includes('manual (@ann\\|ops)'));
  assert.ok(row.includes('needs \\| review'));
});

test('generateAuditReport: empty message when no matching events', () => {
  const tracker = new TaskHistoryTracker();
  const report = generateAuditReport(tracker);
  assert.match(report, /_No events recorded/u);
});

// ── generateActivityReport ────────────────────────────────────────────────

test('generateActivityReport: returns "no activity" for unknown task', () => {
  const tracker = new TaskHistoryTracker();
  const report = generateActivityReport(tracker, 'unknown-task');
  assert.match(report, /No activity recorded/u);
});

test('generateActivityReport: includes task entries', () => {
  const tracker = new TaskHistoryTracker();
  tracker.recordChange(makeEntry({ action: 'status_change', comment: 'done' }));
  const report = generateActivityReport(tracker, 'Tasks.md:task-1');
  assert.match(report, /STATUS_CHANGE/u);
  assert.match(report, /done/u);
});

test('generateActivityReport: shows limited recent activity newest first', () => {
  const tracker = new TaskHistoryTracker();
  tracker.recordChange(makeEntry({
    timestamp: new Date('2026-05-31T08:00:00Z'),
    action: 'created',
    comment: 'oldest',
  }));
  tracker.recordChange(makeEntry({
    timestamp: new Date('2026-05-31T09:00:00Z'),
    action: 'updated',
    comment: 'middle',
  }));
  tracker.recordChange(makeEntry({
    timestamp: new Date('2026-05-31T10:00:00Z'),
    action: 'completed',
    comment: 'newest',
  }));

  const report = generateActivityReport(tracker, 'Tasks.md:task-1', 2);

  assert.ok(!report.includes('oldest'));
  assert.ok(report.indexOf('newest') < report.indexOf('middle'));
});

test('generateActivityReport: zero limit shows no recent activity entries', () => {
  const tracker = new TaskHistoryTracker();
  tracker.recordChange(makeEntry({ action: 'status_change', comment: 'done' }));

  const report = generateActivityReport(tracker, 'Tasks.md:task-1', 0);

  assert.match(report, /## Recent Activity/u);
  assert.ok(!report.includes('STATUS_CHANGE'));
  assert.ok(!report.includes('done'));
});

// ── generateActivityHeatmap ───────────────────────────────────────────────

test('generateActivityHeatmap: returns correct number of dates', () => {
  const tracker = new TaskHistoryTracker();
  const heatmap = generateActivityHeatmap(tracker, 'any', 30);
  assert.equal(heatmap.dates.length, 30);
  assert.equal(heatmap.activityCounts.length, 30);
  assert.equal(heatmap.maxActivity, 0);
});

test('generateActivityHeatmap: counts activity on correct date', () => {
  const tracker = new TaskHistoryTracker();
  const today = new Date();
  tracker.recordChange(makeEntry({ timestamp: today }));
  const heatmap = generateActivityHeatmap(tracker, 'Tasks.md:task-1', 7);
  assert.ok(heatmap.maxActivity >= 1);
  const total = heatmap.activityCounts.reduce((a, b) => a + b, 0);
  assert.equal(total, 1);
});

// ── formatActivityAsMarkdown ──────────────────────────────────────────────

test('formatActivityAsMarkdown: includes 💬 prefix and action', () => {
  const entry = makeEntry({ action: 'status_change', comment: 'finished it' });
  const line = formatActivityAsMarkdown(entry);
  assert.match(line, /^💬/u);
  assert.match(line, /status_change/u);
  assert.match(line, /finished it/u);
});

test('formatActivityAsMarkdown: renders changedFields when no comment', () => {
  const entry = makeEntry({
    action: 'priority_change',
    comment: undefined,
    changedFields: { priority: { oldValue: 'normal', newValue: 'high' } },
  });
  const line = formatActivityAsMarkdown(entry);
  assert.match(line, /priority/u);
  assert.match(line, /normal.*high/u);
});

// ── getStatistics ─────────────────────────────────────────────────────────

test('TaskHistoryTracker.getStatistics: empty tracker returns empty string for mostCommonAction', () => {
  const tracker = new TaskHistoryTracker();
  const stats = tracker.getStatistics();
  assert.equal(stats.totalTasksTracked, 0);
  assert.equal(stats.totalChanges, 0);
  assert.equal(stats.mostActiveTask, null);
  assert.equal(stats.mostCommonAction, '', 'mostCommonAction should be empty when no actions recorded');
});

test('TaskHistoryTracker.getStatistics: returns most common action correctly', () => {
  const tracker = new TaskHistoryTracker();
  tracker.recordChange(makeEntry({ taskId: 'A', action: 'status_change' }));
  tracker.recordChange(makeEntry({ taskId: 'B', action: 'status_change' }));
  tracker.recordChange(makeEntry({ taskId: 'C', action: 'date_change' }));
  const stats = tracker.getStatistics();
  assert.equal(stats.totalChanges, 3);
  assert.equal(stats.mostCommonAction, 'status_change');
});
