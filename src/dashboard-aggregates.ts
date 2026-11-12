import type { MarkdownTask } from './task-model';

export interface DashboardAggregates<T extends MarkdownTask = MarkdownTask> {
  readonly tasks: readonly T[];
  readonly trackedTasks: readonly T[];
  readonly activeTasks: readonly T[];
  readonly byStatus: ReadonlyMap<T['status'], readonly T[]>;
  readonly byPriority: ReadonlyMap<string, readonly T[]>;
  readonly byTaskKey: ReadonlyMap<string, T>;
}

/** One revision-scoped pass shared by Dashboard cards. */
export function buildDashboardAggregates<T extends MarkdownTask>(tasks: readonly T[]): DashboardAggregates<T> {
  const trackedTasks: T[] = [];
  const activeTasks: T[] = [];
  const statuses = new Map<T['status'], T[]>();
  const priorities = new Map<string, T[]>();
  const byTaskKey = new Map<string, T>();
  for (const task of tasks) {
    if (task.status !== 'untracked') trackedTasks.push(task);
    if (task.status !== 'done' && task.status !== 'cancelled' && task.status !== 'untracked') activeTasks.push(task);
    const status = statuses.get(task.status) ?? [];
    status.push(task);
    statuses.set(task.status, status);
    const priorityKey = task.metadata.priority ?? 'normal';
    const priority = priorities.get(priorityKey) ?? [];
    priority.push(task);
    priorities.set(priorityKey, priority);
    if (!byTaskKey.has(task.key)) byTaskKey.set(task.key, task);
  }
  return Object.freeze({
    tasks,
    trackedTasks: Object.freeze(trackedTasks),
    activeTasks: Object.freeze(activeTasks),
    byStatus: new Map([...statuses].map(([key, values]) => [key, Object.freeze(values)])),
    byPriority: new Map([...priorities].map(([key, values]) => [key, Object.freeze(values)])),
    byTaskKey,
  });
}
