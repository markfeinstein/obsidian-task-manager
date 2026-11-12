/**
 * Metrics Aggregator Tests
 * Tests for burndown, variance, velocity, and effort calculations
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEffort, formatEffort, parseDate, calculateDailyMetrics, calculateSprintMetrics, generateBurndownData, generateBurnupData, calculateVelocityTrend, calculateVarianceReport } from '../src/metrics-aggregator';
import { TaskScanner } from '../src/task-scanner';

function scanner(): TaskScanner {
  return new TaskScanner({} as never);
}

// ── Effort Parsing ──────────────────────────────────

test('metrics: parses hours effort', () => {
  const effort = parseEffort('2h');
  assert.ok(effort);
  assert.equal(effort!.total, 120);
});

test('metrics: parses minutes effort', () => {
  const effort = parseEffort('30m');
  assert.ok(effort);
  assert.equal(effort!.total, 30);
});

test('metrics: parses combined effort', () => {
  const effort = parseEffort('2h 30m');
  assert.ok(effort);
  assert.equal(effort!.total, 150);
});

test('metrics: parses day effort', () => {
  const effort = parseEffort('1d');
  assert.ok(effort);
  assert.equal(effort!.unit, 'days');
  assert.equal(effort!.value, 1);
  assert.equal(effort!.total, 480);
});

test('metrics: parses decimal day effort as days', () => {
  const effort = parseEffort('1.5d');
  assert.ok(effort);
  assert.equal(effort!.unit, 'days');
  assert.equal(effort!.value, 1.5);
  assert.equal(effort!.total, 720);
});

test('metrics: handles effort with spaces', () => {
  const effort = parseEffort('2 hours 30 minutes');
  assert.ok(effort);
  assert.equal(effort!.total, 150);
});

test('metrics: returns undefined for empty effort', () => {
  const effort = parseEffort('');
  assert.equal(effort, undefined);
});

test('metrics: returns undefined for invalid effort', () => {
  const effort = parseEffort('xyz');
  assert.equal(effort, undefined);
});

test('metrics: rejects partial duration tokens', () => {
  assert.equal(parseEffort('2horse'), undefined);
  assert.equal(parseEffort('30minsabc'), undefined);
  assert.equal(parseEffort('1.5hxyz'), undefined);
});

// ── Effort Formatting ──────────────────────────────────

test('metrics: formats hours', () => {
  const effort = parseEffort('2h');
  assert.ok(effort);
  const formatted = formatEffort(effort);
  assert.ok(formatted.includes('2'));
  assert.ok(formatted.includes('h'));
});

test('metrics: formats minutes', () => {
  const effort = parseEffort('30m');
  assert.ok(effort);
  const formatted = formatEffort(effort);
  assert.ok(formatted.includes('30'));
  assert.ok(formatted.includes('m'));
});

test('metrics: formats combined', () => {
  const effort = parseEffort('2h 30m');
  assert.ok(effort);
  const formatted = formatEffort(effort);
  assert.ok(formatted.includes('h'));
  assert.ok(formatted.includes('m'));
});

test('metrics: formats day effort without converting back to hours', () => {
  const effort = parseEffort('1.5d');
  assert.ok(effort);
  assert.equal(formatEffort(effort), '1.5d');
});

// ── Daily Metrics Calculation ──────────────────────────────

test('metrics: aggregates daily snapshots by date', () => {
  const snapshots: import('../src/metrics-aggregator').TaskMetricsSnapshot[] = [
    { taskId: 'task-1', date: '2026-05-20', effort: parseEffort('1h'), actual: parseEffort('45m'), status: 'done' },
    { taskId: 'task-2', date: '2026-05-20', effort: parseEffort('30m'), actual: parseEffort('15m'), status: 'in_progress' },
    { taskId: 'task-3', date: '2026-05-21', effort: parseEffort('2h'), status: 'todo' },
  ];

  const daily = calculateDailyMetrics(snapshots);

  assert.equal(daily.get('2026-05-20')?.tasksCompleted, 1);
  assert.equal(daily.get('2026-05-20')?.tasksStarted, 1);
  assert.equal(daily.get('2026-05-20')?.estimatedMinutes, 90);
  assert.equal(daily.get('2026-05-20')?.actualMinutes, 60);
  assert.equal(daily.get('2026-05-20')?.velocity, 1);
  assert.equal(daily.get('2026-05-21')?.estimatedMinutes, 120);
});

// ── Burndown Calculation ──────────────────────────────

test('metrics: generates burndown data for date range', () => {
  const snapshots: import('../src/metrics-aggregator').TaskMetricsSnapshot[] = [
    {
      taskId: 'task-1',
      date: '2026-05-20',
      effort: parseEffort('5h'),
      status: 'todo',
    },
    {
      taskId: 'task-1',
      date: '2026-05-21',
      effort: parseEffort('5h'),
      status: 'done',
    },
  ];
  
  const burndown = generateBurndownData(snapshots, '2026-05-20', '2026-05-21');
  assert.ok(Array.isArray(burndown));
  assert.ok(burndown.length > 0);
});

test('metrics: handles empty snapshot list', () => {
  const burndown = generateBurndownData([], '2026-05-20', '2026-05-21');
  assert.ok(Array.isArray(burndown));
});

// ── Velocity Calculation ──────────────────────────────────

test('metrics: calculates velocity trend', () => {
  const snapshots: import('../src/metrics-aggregator').TaskMetricsSnapshot[] = [
    {
      taskId: 'task-1',
      date: '2026-05-20',
      effort: parseEffort('2h'),
      status: 'done',
    },
    {
      taskId: 'task-2',
      date: '2026-05-21',
      effort: parseEffort('1h'),
      status: 'done',
    },
  ];
  
  const velocity = calculateVelocityTrend(snapshots, 2);
  assert.ok(Array.isArray(velocity));
});

// ── Variance Calculation ──────────────────────────────────

test('metrics: detects overestimated tasks', () => {
  const s = scanner();
  const tasks = [
    s.parseTaskLine('- [x] Task ⏱️ 10h 🕐 2h ✅ 2026-05-20', 'Test.md', 1)!,
  ];
  
  const report = calculateVarianceReport(tasks, '2026-05-20', '2026-05-20');
  assert.ok(report);
  assert.ok(report.summary.totalTasks > 0);
  assert.ok(report.summary.averageVariance > 0);
});

test('metrics: detects underestimated tasks', () => {
  const s = scanner();
  const tasks = [
    s.parseTaskLine('- [x] Task ⏱️ 1h 🕐 5h ✅ 2026-05-20', 'Test.md', 1)!,
  ];
  
  const report = calculateVarianceReport(tasks, '2026-05-20', '2026-05-20');
  assert.ok(report);
  assert.ok(report.topUnderestimates.length > 0);
});

test('metrics: ranks variance by magnitude', () => {
  const s = scanner();
  const tasks = [
    s.parseTaskLine('- [x] Task 1 ⏱️ 100h 🕐 10h ✅ 2026-05-20', 'Test.md', 1)!,  // 90% overestimate
    s.parseTaskLine('- [x] Task 2 ⏱️ 100h 🕐 50h ✅ 2026-05-20', 'Test.md', 2)!,  // 50% overestimate
  ];
  
  const report = calculateVarianceReport(tasks, '2026-05-20', '2026-05-20');
  assert.ok(report.summary.totalTasks >= 2);
  assert.ok(report.topOverestimates.length >= 2);
  assert.ok(report.topOverestimates[0].variance >= report.topOverestimates[1].variance);
});;

test('metrics: handles tasks without effort', () => {
  const s = scanner();
  const tasks = [
    s.parseTaskLine('- [x] Task without effort ✅ 2026-05-20', 'Test.md', 1)!,
  ];
  
  const report = calculateVarianceReport(tasks, '2026-05-20', '2026-05-20');
  assert.ok(report);
  assert.equal(report.summary.totalTasks, 0);
});

test('metrics: calculates percent variance', () => {
  const s = scanner();
  const tasks = [
    s.parseTaskLine('- [x] Task ⏱️ 10m 🕐 5m ✅ 2026-05-20', 'Test.md', 1)!,  // 50% overestimate
  ];
  
  const report = calculateVarianceReport(tasks, '2026-05-20', '2026-05-20');
  assert.ok(report);
  assert.ok(report.topOverestimates[0].variance >= 50);
});

// ── Edge Cases ──────────────────────────────────

test('metrics: handles very large efforts', () => {
  const effort = parseEffort('100h');
  assert.ok(effort);
  assert.equal(effort!.total, 6000);
});

test('metrics: rejects malformed ISO dates', () => {
  assert.throws(() => parseDate(''), /Invalid ISO date/u);
  assert.throws(() => parseDate('2026-2-01'), /Invalid ISO date/u);
  assert.throws(() => parseDate('2026-02-31'), /Invalid ISO date/u);
});

test('metrics: handles decimal hours', () => {
  const effort = parseEffort('2.5h');
  assert.ok(effort);
  assert.equal(effort!.total, 150);
});

test('metrics: normalizes effort strings', () => {
  const effort1 = parseEffort('2H');
  const effort2 = parseEffort('2h');
  assert.ok(effort1);
  assert.ok(effort2);
  assert.equal(effort1!.total, effort2!.total);
});

test('metrics: sprint metrics treat per-task snapshots as one task and completed effort as burned down', () => {
  const snapshots: import('../src/metrics-aggregator').TaskMetricsSnapshot[] = [
    { taskId: 'task-1', date: '2026-05-20', effort: parseEffort('5h'), status: 'todo' },
    { taskId: 'task-1', date: '2026-05-21', effort: parseEffort('5h'), status: 'done' },
    { taskId: 'task-2', date: '2026-05-20', effort: parseEffort('1h'), status: 'todo' },
  ];

  const sprint = calculateSprintMetrics(snapshots, '2026-05-20', '2026-05-21');

  assert.equal(sprint.totalTasks, 2, 'task-1 should not be counted once per snapshot');
  assert.equal(sprint.completedTasks, 1);
  assert.equal(sprint.totalEffortMinutes, 360, 'scope should use one latest estimate per task');
  assert.equal(sprint.remainingEffort, 60, 'completed estimated effort should reduce remaining effort even without actual time logged');
});

test('metrics: burndown totalEffort does not double-count tasks with multiple pre-sprint snapshots', () => {
  // task-1 appears in two snapshots dated before/on the sprint start (2026-05-20).
  // Before the fix, both were summed → totalEffort = 600 min (10h). After the fix
  // only the LATEST snapshot per task is used → totalEffort = 300 min (5h).
  const snapshots: import('../src/metrics-aggregator').TaskMetricsSnapshot[] = [
    { taskId: 'task-1', date: '2026-05-18', effort: parseEffort('5h'), status: 'todo' },
    { taskId: 'task-1', date: '2026-05-20', effort: parseEffort('5h'), status: 'todo' },
  ];
  const burndown = generateBurndownData(snapshots, '2026-05-20', '2026-05-21');
  // On day 0 (May 20) there is no actual work logged, so remaining == totalEffort.
  assert.equal(burndown[0].remaining, 300, 'remaining should be 300 min (5h), not 600 (double-counted)');
});

test('metrics: burnup totalEffort does not double-count tasks with multiple snapshots', () => {
  const snapshots: import('../src/metrics-aggregator').TaskMetricsSnapshot[] = [
    { taskId: 'task-A', date: '2026-05-19', effort: parseEffort('3h'), status: 'todo' },
    { taskId: 'task-A', date: '2026-05-20', effort: parseEffort('3h'), status: 'todo' },
    { taskId: 'task-A', date: '2026-05-21', effort: parseEffort('3h'), status: 'done' },
  ];
  const burnup = generateBurnupData(snapshots, '2026-05-20', '2026-05-21');
  // total scope = 3h = 180 min (latest snapshot for task-A is May 21, 3h)
  assert.equal(burnup[0].total, 180, 'scope should be 180 min (3h), not 540 (triple-counted)');
});

test('metrics: burndown and burnup count completed estimated effort without actual time', () => {
  const snapshots: import('../src/metrics-aggregator').TaskMetricsSnapshot[] = [
    { taskId: 'task-1', date: '2026-05-20', effort: parseEffort('2h'), status: 'todo' },
    { taskId: 'task-1', date: '2026-05-21', effort: parseEffort('2h'), status: 'done' },
  ];

  const burndown = generateBurndownData(snapshots, '2026-05-20', '2026-05-21');
  assert.equal(burndown[0].remaining, 120);
  assert.equal(burndown[1].completed, 120);
  assert.equal(burndown[1].remaining, 0);

  const burnup = generateBurnupData(snapshots, '2026-05-20', '2026-05-21');
  assert.equal(burnup[0].completed, 0);
  assert.equal(burnup[1].completed, 120);
});

test('metrics: variance report with zero actual time', () => {
  const s = scanner();
  const tasks = [
    s.parseTaskLine('- [x] Task ⏱️ 2h 🕐 0m ✅ 2026-05-20', 'Test.md', 1)!,
  ];
  
  const report = calculateVarianceReport(tasks, '2026-05-20', '2026-05-20');
  assert.ok(report);
  assert.ok(report.topOverestimates.length > 0);
});
