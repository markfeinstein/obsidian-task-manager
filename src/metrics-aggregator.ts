/**
 * Task Metrics Aggregation & Burndown Analysis
 *
 * Aggregates task effort (estimated time) and actual time logging
 * to calculate velocity, burndown charts, and sprint metrics.
 */

import type { MarkdownTask } from './task-model';
import { parseEffortMinutesForFilter } from './duration-utils';

export type TimeUnit = 'minutes' | 'hours' | 'days';

export interface TimeEstimate {
  value: number;
  unit: TimeUnit;
  total: number; // Total minutes
}

export interface TaskMetricsSnapshot {
  taskId: string;
  date: string;
  effort?: TimeEstimate;
  actual?: TimeEstimate;
  status: 'todo' | 'in_progress' | 'done' | 'cancelled';
}

export interface DailyMetrics {
  date: string;
  tasksCompleted: number;
  tasksStarted: number;
  estimatedMinutes: number;
  actualMinutes: number;
  velocity: number; // tasks completed per day
}

export interface SprintMetrics {
  startDate: string;
  endDate: string;
  totalTasks: number;
  completedTasks: number;
  totalEffortMinutes: number;
  actualMinutes: number;
  velocity: number; // tasks completed
  burndownChart: DailyMetrics[];
  remainingEffort: number;
}

export interface VelocityTrend {
  week: string;
  completedTasks: number;
  estimatedMinutes: number;
  actualMinutes: number;
  avgVelocity: number;
}

/**
 * Parse effort string like "1d", "2h 30m" or "45m" into TimeEstimate.
 * Day durations use the shared planning convention of 8 hours per day.
 */
export function parseEffort(effortStr: string | undefined): TimeEstimate | undefined {
  const total = parseEffortMinutesForFilter(effortStr);
  if (!Number.isFinite(total)) return undefined;

  const normalized = effortStr?.trim().toLowerCase() ?? '';
  const dayOnlyMatch = normalized.match(/^(\d+(?:\.\d+)?)\s*d(?:ays?)?$/u);
  if (dayOnlyMatch) {
    return { value: Number(dayOnlyMatch[1]), unit: 'days', total };
  }

  // Determine primary unit
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  let unit: TimeUnit = 'minutes';
  let value = total;
  if (total >= 8 * 60 && total % (8 * 60) === 0) {
    unit = 'days';
    value = total / (8 * 60);
  } else if (hours > 0 && minutes === 0) {
    unit = 'hours';
    value = hours;
  } else if (hours > 0) {
    unit = 'hours';
    value = total / 60;
  }

  return { value, unit, total };
}

/**
 * Format TimeEstimate back to string
 */
export function formatEffort(est: TimeEstimate): string {
  if (est.unit === 'days') return `${est.value}d`;

  const hours = Math.floor(est.total / 60);
  const minutes = est.total % 60;

  const parts: string[] = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);

  return parts.join(' ');
}

/**
 * Calculate daily burndown metrics from task snapshots
 */
export function calculateDailyMetrics(snapshots: TaskMetricsSnapshot[]): Map<string, DailyMetrics> {
  const dailyMap = new Map<string, DailyMetrics>();

  for (const snapshot of snapshots) {
    let daily = dailyMap.get(snapshot.date);
    if (!daily) {
      daily = {
        date: snapshot.date,
        tasksCompleted: 0,
        tasksStarted: 0,
        estimatedMinutes: 0,
        actualMinutes: 0,
        velocity: 0,
      };
      dailyMap.set(snapshot.date, daily);
    }

    if (snapshot.status === 'done') {
      daily.tasksCompleted += 1;
    }
    if (snapshot.status === 'in_progress') {
      daily.tasksStarted += 1;
    }

    if (snapshot.effort) {
      daily.estimatedMinutes += snapshot.effort.total;
    }
    if (snapshot.actual) {
      daily.actualMinutes += snapshot.actual.total;
    }
  }

  // Calculate daily velocity
  for (const daily of dailyMap.values()) {
    daily.velocity = daily.tasksCompleted > 0 ? daily.tasksCompleted : 0;
  }

  return dailyMap;
}

function calculateCompletedEstimatedEffortByDate(snapshots: TaskMetricsSnapshot[]): Map<string, number> {
  const firstDoneByTask = new Map<string, TaskMetricsSnapshot>();

  for (const snapshot of snapshots) {
    if (snapshot.status !== 'done' || !snapshot.effort) continue;
    const existing = firstDoneByTask.get(snapshot.taskId);
    if (!existing || snapshot.date < existing.date) {
      firstDoneByTask.set(snapshot.taskId, snapshot);
    }
  }

  const completedByDate = new Map<string, number>();
  for (const snapshot of firstDoneByTask.values()) {
    completedByDate.set(
      snapshot.date,
      (completedByDate.get(snapshot.date) ?? 0) + (snapshot.effort?.total ?? 0),
    );
  }

  return completedByDate;
}

/**
 * Calculate sprint metrics from snapshots within date range
 */
export function calculateSprintMetrics(
  snapshots: TaskMetricsSnapshot[],
  startDate: string,
  endDate: string,
): SprintMetrics {
  const filtered = snapshots.filter(
    (s) => s.date >= startDate && s.date <= endDate,
  );

  const daily = calculateDailyMetrics(filtered);
  const burndown = Array.from(daily.values()).sort((a, b) => a.date.localeCompare(b.date));

  // Snapshots can contain multiple records for the same task as it moves through
  // the sprint. Treat each task once for sprint-level totals; otherwise a task
  // with a todo snapshot and a later done snapshot inflates scope, task count,
  // actual time, and remaining effort.
  const latestByTask = new Map<string, TaskMetricsSnapshot>();
  const completedByTask = new Map<string, TaskMetricsSnapshot>();
  for (const snapshot of filtered) {
    const latest = latestByTask.get(snapshot.taskId);
    if (!latest || snapshot.date >= latest.date) {
      latestByTask.set(snapshot.taskId, snapshot);
    }

    if (snapshot.status === 'done') {
      const completed = completedByTask.get(snapshot.taskId);
      if (!completed || snapshot.date < completed.date) {
        completedByTask.set(snapshot.taskId, snapshot);
      }
    }
  }

  let totalEffort = 0;
  let actualMinutes = 0;
  for (const snapshot of latestByTask.values()) {
    if (snapshot.effort) totalEffort += snapshot.effort.total;
    if (snapshot.actual) actualMinutes += snapshot.actual.total;
  }

  let completedEffort = 0;
  for (const snapshot of completedByTask.values()) {
    if (snapshot.effort) completedEffort += snapshot.effort.total;
  }

  const completedCount = completedByTask.size;
  const remainingEffort = Math.max(0, totalEffort - completedEffort);

  return {
    startDate,
    endDate,
    totalTasks: latestByTask.size,
    completedTasks: completedCount,
    totalEffortMinutes: totalEffort,
    actualMinutes,
    velocity: completedCount / burndown.length || 0,
    burndownChart: burndown,
    remainingEffort,
  };
}

/**
 * Calculate weekly velocity trend
 */
export function calculateVelocityTrend(
  snapshots: TaskMetricsSnapshot[],
  weeks: number = 4,
): VelocityTrend[] {
  const now = new Date();
  // Anchor on local-date UTC midnight so formatDate (UTC accessors) returns the
  // correct local calendar day even in UTC± timezones.
  const todayUTC = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const trends: VelocityTrend[] = [];

  for (let w = weeks - 1; w >= 0; w -= 1) {
    const weekEnd = new Date(todayUTC.getTime() - w * 7 * 24 * 60 * 60 * 1000);
    const weekStart = new Date(weekEnd.getTime() - 6 * 24 * 60 * 60 * 1000);

    const startStr = formatDate(weekStart);
    const endStr = formatDate(weekEnd);

    const weekSnapshots = snapshots.filter(
      (s) => s.date >= startStr && s.date <= endStr && s.status === 'done',
    );

    const completedCount = weekSnapshots.length;
    let effortTotal = 0;
    let actualTotal = 0;

    for (const snap of weekSnapshots) {
      if (snap.effort) effortTotal += snap.effort.total;
      if (snap.actual) actualTotal += snap.actual.total;
    }

    trends.push({
      week: startStr,
      completedTasks: completedCount,
      estimatedMinutes: effortTotal,
      actualMinutes: actualTotal,
      avgVelocity: completedCount / 7,
    });
  }

  return trends;
}

/**
 * Predict completion date based on burndown rate
 */
export function predictCompletionDate(
  remainingEffort: number,
  velocityMinutesPerDay: number,
): string | null {
  if (velocityMinutesPerDay <= 0) return null;

  const daysRemaining = Math.ceil(remainingEffort / velocityMinutesPerDay);
  const now = new Date();
  // Anchor on local-date UTC midnight to keep formatDate (UTC accessors) aligned
  // with the local calendar day in all timezones.
  const todayUTC = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const completionDate = new Date(todayUTC.getTime() + daysRemaining * 24 * 60 * 60 * 1000);

  return formatDate(completionDate);
}

/**
 * Calculate effort distribution across task statuses
 */
export function effortDistribution(snapshots: TaskMetricsSnapshot[]): Record<string, number> {
  const distribution: Record<string, number> = {
    todo: 0,
    in_progress: 0,
    done: 0,
    cancelled: 0,
  };

  for (const snap of snapshots) {
    if (snap.effort) {
      distribution[snap.status] = (distribution[snap.status] ?? 0) + snap.effort.total;
    }
  }

  return distribution;
}

/**
 * Calculate time tracking accuracy (estimated vs. actual)
 */
export function estimateAccuracy(snapshots: TaskMetricsSnapshot[]): number {
  const doneTasks = snapshots.filter((s) => s.status === 'done');
  if (doneTasks.length === 0) return 1.0;

  let totalEstimated = 0;
  let totalActual = 0;

  for (const snap of doneTasks) {
    if (snap.effort) totalEstimated += snap.effort.total;
    if (snap.actual) totalActual += snap.actual.total;
  }

  if (totalEstimated === 0) return 1.0;
  return totalActual / totalEstimated;
}

/**
 * Identify tasks that exceeded effort estimates
 */
export function overestimatedTasks(snapshots: TaskMetricsSnapshot[]): TaskMetricsSnapshot[] {
  return snapshots.filter(
    (s) => s.effort && s.actual && s.actual.total > s.effort.total * 1.2,
  );
}

/**
 * Helper: format date to YYYY-MM-DD
 */
function formatDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Helper: parse ISO date string to Date (UTC midnight, DST-safe).
 * Throws for malformed or out-of-range dates instead of returning an invalid Date.
 */
export function parseDate(dateStr: string): Date {
  const match = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
  if (!match) {
    throw new Error(`Invalid ISO date: ${dateStr}`);
  }

  const year = Number.parseInt(match[1], 10);
  const month = Number.parseInt(match[2], 10);
  const day = Number.parseInt(match[3], 10);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    throw new Error(`Invalid ISO date: ${dateStr}`);
  }

  return parsed;
}

/**
 * Burndown data point: date and remaining effort
 */
export interface BurndownDataPoint {
  date: string;
  remaining: number; // Remaining effort in minutes
  completed: number; // Cumulative completed in minutes
  ideal: number; // Ideal burndown line
}

/**
 * Burnup data point: date and cumulative completed effort
 */
export interface BurnupDataPoint {
  date: string;
  completed: number; // Cumulative completed in minutes
  total: number; // Total effort in minutes
  scope: number; // Ideal scope line
}

/**
 * Generate burndown chart data from task snapshots
 * Shows remaining effort over time with ideal burndown line
 */
export function generateBurndownData(
  snapshots: TaskMetricsSnapshot[],
  startDate: string,
  endDate: string,
): BurndownDataPoint[] {
  // Build completed effort by completion day. Burndown scope is based on
  // estimates, so a completed task should reduce remaining effort even when no
  // actual time was logged.
  const completedEffortByDate = calculateCompletedEstimatedEffortByDate(snapshots);

  // Calculate total initial effort using the latest snapshot per task.
  // Summing all snapshots with date <= startDate would double-count tasks that
  // have multiple snapshots (e.g. one per day), inflating the initial total.
  const latestPreSprint = new Map<string, { date: string; total: number }>();
  for (const snap of snapshots) {
    if (!snap.effort || snap.date > startDate) continue;
    const existing = latestPreSprint.get(snap.taskId);
    if (!existing || snap.date > existing.date) {
      latestPreSprint.set(snap.taskId, { date: snap.date, total: snap.effort.total });
    }
  }
  let totalEffort = 0;
  for (const entry of latestPreSprint.values()) totalEffort += entry.total;

  // Generate data points
  const data: BurndownDataPoint[] = [];
  let cumulativeCompleted = 0;
  let remainingEffort = totalEffort;
  
  const startDt = parseDate(startDate);
  const endDt = parseDate(endDate);
  const numDays = Math.max(1, Math.ceil((endDt.getTime() - startDt.getTime()) / (1000 * 60 * 60 * 24)) + 1);
  const idealBurnPerDay = totalEffort / numDays;
  
  for (let i = 0; i < numDays; i++) {
    const currentDate = formatDate(new Date(startDt.getTime() + i * 24 * 60 * 60 * 1000));
    
    // Get completed estimated effort for this day
    const completedEffort = completedEffortByDate.get(currentDate) ?? 0;
    if (completedEffort > 0) {
      cumulativeCompleted += completedEffort;
      remainingEffort = Math.max(0, totalEffort - cumulativeCompleted);
    }
    
    const ideal = Math.max(0, totalEffort - idealBurnPerDay * (i + 1));
    
    data.push({
      date: currentDate,
      remaining: remainingEffort,
      completed: cumulativeCompleted,
      ideal,
    });
  }
  
  return data;
}

/**
 * Generate burnup chart data from task snapshots
 * Shows cumulative completed effort over time
 */
export function generateBurnupData(
  snapshots: TaskMetricsSnapshot[],
  startDate: string,
  endDate: string,
): BurnupDataPoint[] {
  // Build completed effort by completion day. Burnup scope is based on
  // estimates, so completed tasks without actual time still count as completed
  // scope.
  const completedEffortByDate = calculateCompletedEstimatedEffortByDate(snapshots);

  // Calculate total effort (scope) using the latest snapshot per task.
  // Summing all snapshots with date <= endDate would double-count tasks that
  // have multiple snapshots (e.g. one per day), inflating the scope line.
  const latestPreEnd = new Map<string, { date: string; total: number }>();
  for (const snap of snapshots) {
    if (!snap.effort || snap.date > endDate) continue;
    const existing = latestPreEnd.get(snap.taskId);
    if (!existing || snap.date > existing.date) {
      latestPreEnd.set(snap.taskId, { date: snap.date, total: snap.effort.total });
    }
  }
  let totalEffort = 0;
  for (const entry of latestPreEnd.values()) totalEffort += entry.total;

  // Generate data points
  const data: BurnupDataPoint[] = [];
  let cumulativeCompleted = 0;
  
  const startDt = parseDate(startDate);
  const endDt = parseDate(endDate);
  const numDays = Math.max(1, Math.ceil((endDt.getTime() - startDt.getTime()) / (1000 * 60 * 60 * 24)) + 1);
  const idealCompletionPerDay = totalEffort / numDays;
  
  for (let i = 0; i < numDays; i++) {
    const currentDate = formatDate(new Date(startDt.getTime() + i * 24 * 60 * 60 * 1000));
    
    // Get completed estimated effort for this day
    const completedEffort = completedEffortByDate.get(currentDate) ?? 0;
    if (completedEffort > 0) {
      cumulativeCompleted += completedEffort;
    }
    
    const ideal = idealCompletionPerDay * (i + 1);
    
    data.push({
      date: currentDate,
      completed: cumulativeCompleted,
      total: totalEffort,
      scope: ideal,
    });
  }
  
  return data;
}

/**
 * Generate velocity sparkline data (simple moving average of task completion)
 */
export interface VelocitySparkline {
  week: string;
  velocity: number; // Tasks completed this week
}

export function generateVelocitySparkline(
  snapshots: TaskMetricsSnapshot[],
  weeks: number = 4,
): VelocitySparkline[] {
  const now = new Date();
  // Anchor on local-date UTC midnight so formatDate (UTC accessors) returns the
  // correct local calendar day even in UTC± timezones.
  const todayUTC = new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()));
  const sparklines: VelocitySparkline[] = [];
  
  for (let w = weeks - 1; w >= 0; w -= 1) {
    const weekEnd = new Date(todayUTC.getTime() - w * 7 * 24 * 60 * 60 * 1000);
    const weekStart = new Date(weekEnd.getTime() - 6 * 24 * 60 * 60 * 1000);
    
    const startStr = formatDate(weekStart);
    const endStr = formatDate(weekEnd);
    
    const weekSnapshots = snapshots.filter(
      (s) => s.date >= startStr && s.date <= endStr && s.status === 'done',
    );
    
    sparklines.push({
      week: startStr,
      velocity: weekSnapshots.length,
    });
  }
  
  return sparklines;
}

/**
 * Variance analysis: tracks estimation accuracy per task
 */
export interface TaskVariance {
  taskId: string;
  taskTitle: string;
  effort: number; // Estimated effort in minutes
  actual: number; // Actual time in minutes
  variance: number; // |actual - effort| / effort * 100 (%)
  isOverestimate: boolean; // true if actual < effort
  absoluteDeviation: number; // |actual - effort| in minutes
}

export interface VarianceReport {
  period: {
    startDate: string;
    endDate: string;
  };
  summary: {
    totalTasks: number;
    averageVariance: number; // Average variance across all tasks (%)
    underestimatedCount: number; // Tasks where actual > effort
    overestimatedCount: number; // Tasks where actual < effort
    aggregateDeviation: number; // Total |actual - effort| / total effort (%)
  };
  topOverestimates: TaskVariance[]; // Top 5 tasks where actual << effort
  topUnderestimates: TaskVariance[]; // Top 5 tasks where actual >> effort
}

/**
 * Calculate variance report for a set of tasks (usually completed tasks in a period)
 */
export function calculateVarianceReport(
  tasks: MarkdownTask[],
  startDate?: string,
  endDate?: string,
): VarianceReport {
  const items: TaskVariance[] = [];
  
  for (const task of tasks) {
    // Skip tasks without both effort and actual estimates
    if (!task.metadata.effort || !task.metadata.actual) continue;
    
    const effort = parseEffortMinutesForFilter(task.metadata.effort);
    const actual = parseEffortMinutesForFilter(task.metadata.actual);
    
    if (!Number.isFinite(effort) || !Number.isFinite(actual) || effort === 0) continue;
    
    const absoluteDeviation = Math.abs(actual - effort);
    const variance = (absoluteDeviation / effort) * 100;
    
    items.push({
      taskId: task.key,
      taskTitle: task.body || task.normalizedText || '(untitled)',
      effort,
      actual,
      variance,
      isOverestimate: actual < effort,
      absoluteDeviation,
    });
  }
  
  // Calculate summary statistics
  const totalTasks = items.length;
  const averageVariance = totalTasks > 0
    ? items.reduce((sum, item) => sum + item.variance, 0) / totalTasks
    : 0;
  
  const underestimatedCount = items.filter((item) => item.actual > item.effort).length;
  const overestimatedCount = items.filter((item) => item.actual < item.effort).length;
  
  // Aggregate deviation: sum of absolute deviations / total effort
  const totalEffort = items.reduce((sum, item) => sum + item.effort, 0);
  const aggregateDeviation = totalEffort > 0
    ? (items.reduce((sum, item) => sum + item.absoluteDeviation, 0) / totalEffort) * 100
    : 0;
  
  // Get top 5 over/under estimates
  const topOverestimates = items
    .filter((item) => item.isOverestimate)
    .sort((a, b) => b.variance - a.variance)
    .slice(0, 5);
  
  const topUnderestimates = items
    .filter((item) => !item.isOverestimate)
    .sort((a, b) => b.variance - a.variance)
    .slice(0, 5);
  
  return {
    period: {
      startDate: startDate || formatDate(new Date()),
      endDate: endDate || formatDate(new Date()),
    },
    summary: {
      totalTasks,
      averageVariance,
      underestimatedCount,
      overestimatedCount,
      aggregateDeviation,
    },
    topOverestimates,
    topUnderestimates,
  };
}

// ── Capacity Analytics ─────────────────────────────────────────────────────

/**
 * Capacity utilization for a single day.
 */
export interface CapacityDay {
  date: string;
  /** Total effort scheduled/planned for this day (minutes). */
  plannedMinutes: number;
  /** Total actual time logged for this day (minutes). */
  actualMinutes: number;
  /** Daily capacity ceiling in minutes (from settings). */
  capacityMinutes: number;
  /** Utilization ratio: plannedMinutes / capacityMinutes (1.0 = 100%). */
  utilization: number;
  /** True when plannedMinutes exceeds capacityMinutes. */
  overCapacity: boolean;
}

/**
 * Aggregated capacity analytics for a date range.
 */
export interface CapacityAnalytics {
  period: { startDate: string; endDate: string };
  dailyCapacityMinutes: number;
  days: CapacityDay[];
  summary: {
    /** Average daily utilization across all days with planned work. */
    avgUtilization: number;
    /** Number of days that exceeded capacity. */
    overCapacityDays: number;
    /** Total planned minutes in the period. */
    totalPlannedMinutes: number;
    /** Total actual minutes logged in the period. */
    totalActualMinutes: number;
    /** Velocity: average tasks completed per day. */
    avgDailyVelocity: number;
  };
  warnings: string[];
}

/**
 * Calculate capacity utilization analytics for a set of tasks over a date range.
 *
 * @param tasks - All tasks to consider (uses scheduled/due date as the planned day)
 * @param startDate - ISO date string (YYYY-MM-DD)
 * @param endDate - ISO date string (YYYY-MM-DD)
 * @param dailyCapacityMinutes - Per-day capacity ceiling from settings (0 = disabled)
 */
export function calculateCapacityAnalytics(
  tasks: MarkdownTask[],
  startDate: string,
  endDate: string,
  dailyCapacityMinutes: number,
): CapacityAnalytics {
  // Build a day-by-day map of planned & actual minutes
  const dayMap = new Map<string, { planned: number; actual: number; completedCount: number }>();

  // Enumerate all days in range
  const start = parseDate(startDate);
  const end = parseDate(endDate);
  const numDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / (1000 * 60 * 60 * 24)) + 1);
  for (let i = 0; i < numDays; i++) {
    const d = formatDate(new Date(start.getTime() + i * 24 * 60 * 60 * 1000));
    dayMap.set(d, { planned: 0, actual: 0, completedCount: 0 });
  }

  for (const task of tasks) {
    // Determine which day this task belongs to: prefer scheduled, then due, then done
    const day = task.metadata.dates?.scheduled
      ?? task.metadata.dates?.due
      ?? task.metadata.dates?.done?.slice(0, 10);
    if (!day || !dayMap.has(day)) continue;

    const entry = dayMap.get(day);
    if (!entry) continue;

    const effort = parseEffortMinutesForFilter(task.metadata.effort);
    if (Number.isFinite(effort)) entry.planned += effort;

    const actual = parseEffortMinutesForFilter(task.metadata.actual);
    if (Number.isFinite(actual)) entry.actual += actual;

    if (task.status === 'done' || task.status === 'cancelled') entry.completedCount += 1;
  }

  // Build CapacityDay array
  const days: CapacityDay[] = [];
  let totalPlanned = 0;
  let totalActual = 0;
  let overCapacityCount = 0;
  let totalCompletedTasks = 0;
  const daysWithWork: number[] = [];

  for (const [date, entry] of [...dayMap.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const utilization = dailyCapacityMinutes > 0 ? entry.planned / dailyCapacityMinutes : 0;
    const overCap = dailyCapacityMinutes > 0 && entry.planned > dailyCapacityMinutes;
    days.push({
      date,
      plannedMinutes: entry.planned,
      actualMinutes: entry.actual,
      capacityMinutes: dailyCapacityMinutes,
      utilization,
      overCapacity: overCap,
    });
    totalPlanned += entry.planned;
    totalActual += entry.actual;
    if (overCap) overCapacityCount += 1;
    totalCompletedTasks += entry.completedCount;
    if (entry.planned > 0) daysWithWork.push(utilization);
  }

  const avgUtilization = daysWithWork.length > 0
    ? daysWithWork.reduce((s, u) => s + u, 0) / daysWithWork.length
    : 0;
  const avgDailyVelocity = numDays > 0 ? totalCompletedTasks / numDays : 0;

  // Build warnings
  const warnings: string[] = [];
  if (dailyCapacityMinutes > 0 && overCapacityCount > 0) {
    warnings.push(`⚠️ ${overCapacityCount} day${overCapacityCount > 1 ? 's' : ''} exceed daily capacity (${Math.round(dailyCapacityMinutes / 60 * 10) / 10}h).`);
  }
  if (avgUtilization > 0.9 && dailyCapacityMinutes > 0) {
    warnings.push(`⚠️ Average utilization is ${Math.round(avgUtilization * 100)}% — consider reducing scheduled load.`);
  }
  if (avgDailyVelocity === 0 && numDays > 3) {
    warnings.push('ℹ️ No completed tasks found in this period.');
  }

  return {
    period: { startDate, endDate },
    dailyCapacityMinutes,
    days,
    summary: {
      avgUtilization,
      overCapacityDays: overCapacityCount,
      totalPlannedMinutes: totalPlanned,
      totalActualMinutes: totalActual,
      avgDailyVelocity,
    },
    warnings,
  };
}

/**
 * Generate a weekly summary markdown report for a set of tasks.
 *
 * @param tasks - Tasks completed (or all tasks) in the period
 * @param startDate - ISO date string (YYYY-MM-DD)
 * @param endDate - ISO date string (YYYY-MM-DD)
 * @param dailyCapacityMinutes - From plugin settings (0 = disabled)
 */
export function generateWeeklySummaryMarkdown(
  tasks: MarkdownTask[],
  startDate: string,
  endDate: string,
  dailyCapacityMinutes: number,
): string {
  const completed = tasks.filter(
    (t) => (t.status === 'done' || t.status === 'cancelled') && t.metadata.dates?.done
      && t.metadata.dates.done.slice(0, 10) >= startDate
      && t.metadata.dates.done.slice(0, 10) <= endDate,
  );

  const totalEffortMins = completed.reduce((sum, t) => {
    const e = parseEffortMinutesForFilter(t.metadata.effort);
    return sum + (Number.isFinite(e) ? e : 0);
  }, 0);

  const totalActualMins = completed.reduce((sum, t) => {
    const a = parseEffortMinutesForFilter(t.metadata.actual);
    return sum + (Number.isFinite(a) ? a : 0);
  }, 0);

  const numDays = Math.max(1, Math.round((parseDate(endDate).getTime() - parseDate(startDate).getTime()) / (1000 * 60 * 60 * 24)) + 1);
  const velocity = completed.length / numDays;

  const capacityAnalytics = dailyCapacityMinutes > 0
    ? calculateCapacityAnalytics(tasks, startDate, endDate, dailyCapacityMinutes)
    : null;

  const formatMins = (mins: number): string => {
    if (mins === 0) return '0m';
    const h = Math.floor(mins / 60);
    const m = Math.round(mins % 60);
    return h > 0 ? (m > 0 ? `${h}h ${m}m` : `${h}h`) : `${m}m`;
  };

  const lines: string[] = [
    `## Weekly Summary: ${startDate} – ${endDate}`,
    '',
    `| Metric | Value |`,
    `|--------|-------|`,
    `| Period | ${startDate} – ${endDate} |`,
    `| Completed tasks | ${completed.length} |`,
    `| Velocity | ${velocity.toFixed(2)} tasks/day |`,
    `| Total effort estimated | ${formatMins(totalEffortMins)} |`,
    `| Total actual time logged | ${formatMins(totalActualMins)} |`,
  ];

  if (totalEffortMins > 0) {
    const accuracy = totalActualMins > 0
      ? Math.round((totalActualMins / totalEffortMins) * 100)
      : null;
    if (accuracy !== null) {
      lines.push(`| Estimation accuracy | ${accuracy}% |`);
    }
  }

  if (capacityAnalytics) {
    lines.push(`| Avg utilization | ${Math.round(capacityAnalytics.summary.avgUtilization * 100)}% |`);
    lines.push(`| Over-capacity days | ${capacityAnalytics.summary.overCapacityDays} |`);
  }

  lines.push('');

  if (capacityAnalytics?.warnings.length) {
    lines.push('### Capacity Warnings');
    lines.push('');
    for (const w of capacityAnalytics.warnings) lines.push(`- ${w}`);
    lines.push('');
  }

  lines.push('### Completed Tasks');
  lines.push('');
  for (const t of completed) {
    const effortStr = t.metadata.effort ? ` ⏱️ ${t.metadata.effort}` : '';
    const actualStr = t.metadata.actual ? ` 🕐 ${t.metadata.actual}` : '';
    lines.push(`- ${t.body || t.normalizedText}${effortStr}${actualStr}`);
  }

  return lines.join('\n');
}

/**
 * Parse effort/duration string into minutes. Handles various formats:
 * - "2h" or "2 hours" -> 120
 * - "30m" or "30 minutes" -> 30
 * - "2h 30m" -> 150
 * - "2.5h" -> 150
 * - "150" (bare number assumed to be minutes) -> 150
 * Returns Infinity if the string cannot be parsed.
 */
// Re-export for backwards compatibility
export { parseEffortMinutesForFilter } from './duration-utils';

