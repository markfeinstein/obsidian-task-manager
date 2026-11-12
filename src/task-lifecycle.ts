import type { MarkdownTask } from './task-model';

export type TaskLifecycleAction = 'status' | 'archive' | 'collect' | 'delete' | 'move-to-end' | 'recurrence';
export type TaskLifecycleOutcome = 'completed' | 'destination-failed' | 'source-conflict' | 'blocked';

interface TaskLifecycleBase {
  task: MarkdownTask;
  action: TaskLifecycleAction;
  destinationPath?: string;
}

export type TaskLifecycleResult =
  | (TaskLifecycleBase & { outcome: 'completed' })
  | (TaskLifecycleBase & {
      outcome: Exclude<TaskLifecycleOutcome, 'completed'>;
      reason: string;
      recovery: string;
    });

export function completedTaskLifecycle(
  task: MarkdownTask,
  action: TaskLifecycleAction = 'status',
  destinationPath?: string,
): TaskLifecycleResult {
  return { outcome: 'completed', task, action, ...(destinationPath ? { destinationPath } : {}) };
}

export function incompleteTaskLifecycle(
  outcome: Exclude<TaskLifecycleOutcome, 'completed'>,
  task: MarkdownTask,
  action: TaskLifecycleAction,
  reason: string,
  recovery: string,
  destinationPath?: string,
): TaskLifecycleResult {
  return { outcome, task, action, reason, recovery, ...(destinationPath ? { destinationPath } : {}) };
}

export class TaskLifecycleError extends Error {
  constructor(public readonly result: Exclude<TaskLifecycleResult, { outcome: 'completed' }>) {
    super(`${result.reason} ${result.recovery}`.trim());
    this.name = 'TaskLifecycleError';
  }
}

export function unwrapTaskLifecycle(result: TaskLifecycleResult): MarkdownTask {
  if (result.outcome !== 'completed') throw new TaskLifecycleError(result);
  return result.task;
}
