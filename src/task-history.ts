/**
 * Task History & Audit Trail: Track all changes to tasks
 * Stores activity as child bullets with 💬 prefix and maintains audit log
 */

// Task history doesn't need to import ParsedTask as it's a standalone module

export interface TaskAuditEntry {
  timestamp: Date;
  taskId: string;
  filePath?: string;
  action:
    | 'created' | 'updated' | 'completed' | 'commented' | 'deleted' | 'snoozed' | 'reopened'
    | 'status_change' | 'date_change' | 'priority_change'
    | 'sync_event' | 'postponement' | 'recurrence_spawn' | 'conflict';
  /** For status_change / date_change / priority_change — what changed. */
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  /** Legacy: individual changed fields (kept for backward compat). */
  changedFields: {
    [fieldName: string]: {
      oldValue: unknown;
      newValue: unknown;
    };
  };
  /** Who or what triggered the change. */
  source?: 'manual' | 'sync' | 'automation' | 'recurrence';
  author?: string;
  comment?: string;
  metadata?: Record<string, unknown>;
}

export interface TaskHistory {
  taskId: string;
  entries: TaskAuditEntry[];
  totalChanges: number;
  firstChange: Date;
  lastChange: Date;
}

/**
 * Task History Tracker - In-memory audit log
 */
export class TaskHistoryTracker {
  private history: Map<string, TaskAuditEntry[]> = new Map();
  private maxEntriesPerTask: number = 100;  // Configurable
  private persistedEntries: Set<string> = new Set();

  /**
   * Record a change to a task
   */
  recordChange(entry: TaskAuditEntry): void {
    const taskId = entry.taskId;

    let entries = this.history.get(taskId);
    if (!entries) {
      entries = [];
      this.history.set(taskId, entries);
    }

    entries.push(entry);

    // Keep only the most recent maxEntriesPerTask entries
    if (entries.length > this.maxEntriesPerTask) {
      entries.splice(0, entries.length - this.maxEntriesPerTask);
    }
  }

  /**
   * Get history for a specific task
   */
  getTaskHistory(taskId: string): TaskHistory | null {
    const entries = this.history.get(taskId);

    if (!entries || entries.length === 0) {
      return null;
    }

    return {
      taskId,
      entries,
      totalChanges: entries.length,
      firstChange: entries[0].timestamp,
      lastChange: entries[entries.length - 1].timestamp,
    };
  }

  /**
   * Get all changes for a task within a time range
   */
  getChangesInTimeRange(
    taskId: string,
    startDate: Date,
    endDate: Date
  ): TaskAuditEntry[] {
    const entries = this.history.get(taskId) || [];
    return entries.filter(
      (e) => e.timestamp >= startDate && e.timestamp <= endDate
    );
  }

  /**
   * Get all tasks modified on a specific date
   */
  getTasksModifiedOnDate(date: Date): string[] {
    const dayStart = new Date(date);
    dayStart.setHours(0, 0, 0, 0);

    const dayEnd = new Date(date);
    dayEnd.setHours(23, 59, 59, 999);

    const modifiedTasks = new Set<string>();

    for (const [taskId, entries] of this.history.entries()) {
      if (
        entries.some(
          (e) => e.timestamp >= dayStart && e.timestamp <= dayEnd
        )
      ) {
        modifiedTasks.add(taskId);
      }
    }

    return Array.from(modifiedTasks);
  }

  /**
   * Clear history for a task
   */
  clearTaskHistory(taskId: string): void {
    this.history.delete(taskId);
  }

  /**
   * Return all entries across all tasks, ordered by timestamp ascending.
   * Optionally filter by taskId and/or eventType.
   */
  filterEntries(
    options: { taskId?: string; eventType?: TaskAuditEntry['action'] } = {},
  ): TaskAuditEntry[] {
    const results: TaskAuditEntry[] = [];
    for (const [id, entries] of this.history.entries()) {
      if (options.taskId && id !== options.taskId) continue;
      for (const e of entries) {
        if (options.eventType && e.action !== options.eventType) continue;
        results.push(e);
      }
    }
    results.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    return results;
  }

  /** Return all entries for all tasks ordered by timestamp descending (most recent first). */
  getAllEntries(limit = 100): TaskAuditEntry[] {
    const all: TaskAuditEntry[] = [];
    for (const entries of this.history.values()) {
      all.push(...entries);
    }
    all.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    return all.slice(0, limit);
  }

  /**
   * Get statistics about task modifications
   */
  getStatistics(): {
    totalTasksTracked: number;
    totalChanges: number;
    mostActiveTask: string | null;
    mostCommonAction: string;
  } {
    let totalChanges = 0;
    let mostActiveTask: string | null = null;
    let maxChangesForTask = 0;
    const actionCounts: Record<string, number> = {};

    for (const [taskId, entries] of this.history.entries()) {
      totalChanges += entries.length;

      if (entries.length > maxChangesForTask) {
        maxChangesForTask = entries.length;
        mostActiveTask = taskId;
      }

      entries.forEach((e) => {
        actionCounts[e.action] = (actionCounts[e.action] || 0) + 1;
      });
    }

    let mostCommonAction = '';
    let maxActionCount = 0;

    for (const [action, count] of Object.entries(actionCounts)) {
      if (count > maxActionCount) {
        maxActionCount = count;
        mostCommonAction = action;
      }
    }

    return {
      totalTasksTracked: this.history.size,
      totalChanges,
      mostActiveTask,
      mostCommonAction,
    };
  }
}

/**
 * Activity Feed Report - Generate markdown report of recent activity
 */
export function generateActivityReport(
  tracker: TaskHistoryTracker,
  taskId: string,
  limit: number = 50
): string {
  const history = tracker.getTaskHistory(taskId);

  if (!history) {
    return `# Activity Report for Task ${taskId}\n\nNo activity recorded.\n`;
  }

  let report = `# Activity Report for Task ${taskId}\n\n`;
  report += `**Total Changes:** ${history.totalChanges}\n`;
  report += `**First Change:** ${history.firstChange.toLocaleString()}\n`;
  report += `**Last Change:** ${history.lastChange.toLocaleString()}\n\n`;

  report += '## Recent Activity\n\n';

  const entries = limit <= 0 ? [] : history.entries.slice(-limit).reverse();

  entries.forEach((entry) => {
    const emoji = ({
      created: '✨',
      updated: '✏️',
      completed: '✓',
      commented: '💬',
      deleted: '🗑️',
      snoozed: '😴',
      reopened: '↩️',
      status_change: '🔄',
      date_change: '📅',
      priority_change: '⚡',
      sync_event: '🔁',
      postponement: '⏭️',
      recurrence_spawn: '🔃',
      conflict: '⚠️',
    } as Record<string, string>)[entry.action] ?? '•';

    report += `### ${emoji} ${entry.action.toUpperCase()}\n`;
    report += `**Time:** ${entry.timestamp.toLocaleString()}\n`;

    if (entry.author) {
      report += `**Author:** ${entry.author}\n`;
    }

    if (Object.keys(entry.changedFields).length > 0) {
      report += '\n**Changes:**\n';
      for (const [field, change] of Object.entries(entry.changedFields)) {
        report += `- **${field}:** \`${String(change.oldValue)}\` → \`${String(change.newValue)}\`\n`;
      }
    }

    if (entry.comment) {
      report += `\n**Comment:** ${entry.comment}\n`;
    }

    report += '\n---\n\n';
  });

  return report;
}

/**
 * Generate heatmap of task activity (GitHub-style)
 */
export interface ActivityHeatmap {
  dates: string[];  // ISO date strings
  activityCounts: number[];  // Activity count for each date
  maxActivity: number;
}

export function generateActivityHeatmap(
  tracker: TaskHistoryTracker,
  taskId: string,
  daysBack: number = 90
): ActivityHeatmap {
  const now = new Date();
  const dates: string[] = [];
  const activityCounts: number[] = [];
  let maxActivity = 0;

  for (let i = daysBack - 1; i >= 0; i--) {
    const date = new Date(now);
    date.setDate(date.getDate() - i);
    const isoDate = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    dates.push(isoDate);

    const count = tracker.getChangesInTimeRange(
      taskId,
      new Date(date.setHours(0, 0, 0, 0)),
      new Date(date.setHours(23, 59, 59, 999))
    ).length;

    activityCounts.push(count);
    maxActivity = Math.max(maxActivity, count);
  }

  return { dates, activityCounts, maxActivity };
}

/**
 * Store activity as markdown child bullets
 * Format: 💬 [time] action: description
 */
export function formatActivityAsMarkdown(entry: TaskAuditEntry): string {
  const emoji = ({
    created: '✨',
    updated: '✏️',
    completed: '✓',
    commented: '💬',
    deleted: '🗑️',
    snoozed: '😴',
    reopened: '↩️',
    status_change: '🔄',
    date_change: '📅',
    priority_change: '⚡',
    sync_event: '🔁',
    postponement: '⏭️',
    recurrence_spawn: '🔃',
    conflict: '⚠️',
  } as Record<string, string>)[entry.action] ?? '•';

  const time = entry.timestamp.toLocaleTimeString();
  const date = entry.timestamp.toLocaleDateString();
  let line = `💬 ${emoji} [${date} ${time}] ${entry.action}`;

  if (entry.author) {
    line += ` (@${entry.author})`;
  }

  if (entry.comment) {
    line += `: ${entry.comment}`;
  } else if (Object.keys(entry.changedFields).length > 0) {
    const changes = Object.entries(entry.changedFields)
      .map(([field, change]) => `${field}: "${String(change.oldValue)}" → "${String(change.newValue)}"`)
      .join(', ');
    line += `: ${changes}`;
  }

  return line;
}

/**
 * Audit Report Generator - Statistical overview with a recent-events table.
 * Optionally filter by taskId and/or eventType.
 */
export function generateAuditReport(
  tracker: TaskHistoryTracker,
  options: { taskId?: string; eventType?: TaskAuditEntry['action']; limit?: number } = {},
): string {
  const stats = tracker.getStatistics();
  const limit = options.limit ?? 50;

  let report = '# Task Audit Report\n\n';
  report += `**Generated:** ${new Date().toLocaleString()}\n\n`;

  report += '## Statistics\n';
  report += `- **Total Tasks Tracked:** ${stats.totalTasksTracked}\n`;
  report += `- **Total Changes Recorded:** ${stats.totalChanges}\n`;
  report += `- **Most Active Task:** ${stats.mostActiveTask || 'None'}\n`;
  report += `- **Most Common Action:** ${stats.mostCommonAction}\n\n`;

  const entries = tracker.filterEntries({ taskId: options.taskId, eventType: options.eventType })
    .slice(-limit)
    .reverse(); // most recent first

  if (entries.length === 0) {
    report += '_No events recorded';
    if (options.taskId) report += ` for task \`${options.taskId}\``;
    if (options.eventType) report += ` with type \`${options.eventType}\``;
    report += '._\n';
    return report;
  }

  report += `## Recent Events (${entries.length})\n\n`;
  report += '| Time | Task | Event | Source | Detail |\n';
  report += '|------|------|-------|--------|--------|\n';

  for (const e of entries) {
    const time = escapeMarkdownTableCell(e.timestamp.toLocaleString());
    const task = escapeMarkdownTableCell(e.taskId);
    const event = escapeMarkdownTableCell(e.action);
    const source = escapeMarkdownTableCell(e.source ?? (e.author ? `manual (@${e.author})` : 'manual'));
    let detail = e.comment ?? '';
    if (!detail && Object.keys(e.changedFields).length > 0) {
      detail = Object.entries(e.changedFields)
        .map(([f, c]) => `${f}: \`${String(c.oldValue)}\` → \`${String(c.newValue)}\``)
        .join(', ');
    }
    if (!detail && e.before && e.after) {
      const fields = new Set([...Object.keys(e.before), ...Object.keys(e.after)]);
      detail = [...fields]
        .map((f) => `${f}: \`${String((e.before as Record<string, unknown>)[f])}\` → \`${String((e.after as Record<string, unknown>)[f])}\``)
        .join(', ');
    }
    report += `| ${time} | ${task} | ${event} | ${source} | ${escapeMarkdownTableCell(detail)} |\n`;
  }

  return report;
}

function escapeMarkdownTableCell(value: string): string {
  return value.replace(/\|/gu, '\\|');
}
