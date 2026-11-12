import type { ParsedTask } from './task-scanner';

export interface TaskSnapshotEntry {
  key: string;
  status: ParsedTask['status'];
  filePath: string;
  lineNumber: number;
  sourceKind: 'line' | 'file';
}

export function isCompletionTransition(
  previous: Pick<TaskSnapshotEntry, 'status'> | undefined,
  current: Pick<ParsedTask, 'status'>,
): boolean {
  return Boolean(previous && previous.status !== 'done' && current.status === 'done');
}

/**
 * Remove occurrence suffixes while retaining an explicit-ID boundary. This is
 * the stable grouping key used to compare a newly scanned file with its prior
 * snapshot without coupling the scan orchestrator to completion heuristics.
 */
export function baseCompletionTaskKey(taskKey: string): string {
  const withoutOccurrence = taskKey.replace(/\u0000\d+$/u, '');
  const idMatch = withoutOccurrence.match(/^(.*):id:([^:]+)$/u);
  return idMatch ? `${idMatch[1]}:id:${idMatch[2]}` : withoutOccurrence;
}

function taskGroupKey(filePath: string, taskKey: string): string {
  return `${filePath}\u0000${baseCompletionTaskKey(taskKey)}`;
}

function currentTaskGroupCounts(tasks: readonly ParsedTask[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    const groupKey = taskGroupKey(task.filePath, task.key);
    counts.set(groupKey, (counts.get(groupKey) ?? 0) + 1);
  }
  return counts;
}

function legacyOccurrenceGroups(snapshot: ReadonlyMap<string, TaskSnapshotEntry>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of snapshot.values()) {
    if (!/#\d+$/u.test(entry.key)) continue;
    const legacyKey = `${entry.filePath}\u0000${entry.key.replace(/#\d+$/u, '')}`;
    counts.set(legacyKey, (counts.get(legacyKey) ?? 0) + 1);
  }
  return new Map(Array.from(counts.entries()).filter(([, count]) => count > 1));
}

function resolvePreviousTaskGroupKey(
  entry: TaskSnapshotEntry,
  currentGroupKeys: ReadonlySet<string>,
  currentGroupCounts: ReadonlyMap<string, number>,
  legacyGroups: ReadonlyMap<string, number>,
): string {
  const currentKey = taskGroupKey(entry.filePath, entry.key);
  const legacyKey = `${entry.filePath}\u0000${entry.key.replace(/#\d+$/u, '')}`;
  if ((legacyGroups.get(legacyKey) ?? 0) === (currentGroupCounts.get(legacyKey) ?? -1) && currentGroupKeys.has(legacyKey)) {
    return legacyKey;
  }
  return currentKey;
}

function detectLineMatchedCompletions(
  groupTasks: readonly ParsedTask[],
  previousSnapshot: ReadonlyMap<string, TaskSnapshotEntry>,
  currentFileTasks: readonly ParsedTask[],
): ParsedTask[] {
  const filePath = groupTasks[0]?.filePath;
  if (!filePath) return [];
  const previousFileEntries = Array.from(previousSnapshot.values()).filter((entry) => entry.filePath === filePath);
  if (previousFileEntries.length !== currentFileTasks.length) return [];
  const previousByLine = new Map(previousFileEntries.map((entry) => [entry.lineNumber, entry]));
  return groupTasks.filter((task) => isCompletionTransition(previousByLine.get(task.lineNumber), task));
}

function selectCompletedTasksToLog(
  groupTasks: readonly ParsedTask[],
  previousGroup: readonly TaskSnapshotEntry[],
  previousSnapshot: ReadonlyMap<string, TaskSnapshotEntry>,
  limit: number,
  groupExpanded: boolean,
): ParsedTask[] {
  const selected: ParsedTask[] = [];
  const currentByLine = [...groupTasks].sort((left, right) => left.lineNumber - right.lineNumber);
  const exactKeysAreStable = groupTasks.length === 1 && previousGroup.length === 1;

  for (const task of currentByLine) {
    const previous = previousSnapshot.get(task.key);
    if (task.status === 'done' && previous && previous.status !== 'done' && (exactKeysAreStable || (!groupExpanded && previous.lineNumber === task.lineNumber))) {
      selected.push(task);
      if (selected.length === limit) return selected;
    }
  }

  const previousByLine = [...previousGroup].sort((left, right) => left.lineNumber - right.lineNumber);
  for (let index = 0; index < currentByLine.length && selected.length < limit; index += 1) {
    const task = currentByLine[index];
    const previous = previousByLine[index];
    if (task.status === 'done' && previous?.status !== 'done' && !groupExpanded && previous.lineNumber === task.lineNumber && !selected.includes(task)) {
      selected.push(task);
    }
  }
  return selected;
}

/**
 * Compare all occurrences in one scanned file with its immutable prior
 * snapshot and return only newly completed occurrences. This pure seam handles
 * duplicate occurrence keys, legacy #N suffixes, recurrence expansion, and
 * line-stable fallback matching; callers own persistence and side effects.
 */
export function detectCompletionTasks(
  tasks: readonly ParsedTask[],
  previousSnapshot: ReadonlyMap<string, TaskSnapshotEntry>,
): ParsedTask[] {
  const currentGroupCounts = currentTaskGroupCounts(tasks);
  const currentGroupKeys = new Set(currentGroupCounts.keys());
  const legacyGroups = legacyOccurrenceGroups(previousSnapshot);
  const previousGroups = new Map<string, TaskSnapshotEntry[]>();
  for (const entry of previousSnapshot.values()) {
    const groupKey = resolvePreviousTaskGroupKey(entry, currentGroupKeys, currentGroupCounts, legacyGroups);
    const group = previousGroups.get(groupKey) ?? [];
    group.push(entry);
    previousGroups.set(groupKey, group);
  }

  const currentGroups = new Map<string, ParsedTask[]>();
  for (const task of tasks) {
    const groupKey = taskGroupKey(task.filePath, task.key);
    const group = currentGroups.get(groupKey) ?? [];
    group.push(task);
    currentGroups.set(groupKey, group);
  }

  const completed: ParsedTask[] = [];
  for (const [groupKey, groupTasks] of currentGroups) {
    const previousGroup = previousGroups.get(groupKey) ?? [];
    if (previousGroup.length === 0) {
      completed.push(...detectLineMatchedCompletions(groupTasks, previousSnapshot, tasks));
      continue;
    }

    const previousDoneCount = previousGroup.filter((entry) => entry.status === 'done').length;
    const previousNotDoneCount = previousGroup.length - previousDoneCount;
    const currentDoneCount = groupTasks.filter((task) => task.status === 'done').length;
    const currentNotDoneCount = groupTasks.length - currentDoneCount;
    const groupExpanded = groupTasks.length > previousGroup.length;
    const completionsToLog = groupExpanded
      ? Math.max(0, previousNotDoneCount - currentNotDoneCount)
      : Math.max(0, currentDoneCount - previousDoneCount);
    if (completionsToLog <= 0) continue;

    completed.push(...selectCompletedTasksToLog(
      groupTasks,
      previousGroup,
      previousSnapshot,
      completionsToLog,
      groupExpanded,
    ));
  }
  return completed;
}

/** Return newly completed habit tasks using file/line identity as a fallback. */
export function detectHabitCompletionTasks(
  tasks: readonly ParsedTask[],
  previousSnapshot: ReadonlyMap<string, TaskSnapshotEntry>,
  isHabit: (task: ParsedTask) => boolean,
): ParsedTask[] {
  const previousByFileAndLine = new Map<string, TaskSnapshotEntry>();
  for (const entry of previousSnapshot.values()) {
    previousByFileAndLine.set(`${entry.filePath}\u0000${entry.lineNumber}`, entry);
  }
  return tasks.filter((task) => isHabit(task)
    && isCompletionTransition(previousByFileAndLine.get(`${task.filePath}\u0000${task.lineNumber}`), task));
}
