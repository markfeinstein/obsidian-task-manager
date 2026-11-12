import { detectCompletionTasks, detectHabitCompletionTasks, isCompletionTransition, type TaskSnapshotEntry } from './completion-detector';
import { explicitTaskKey, isLegacyExplicitTaskKey, type ExplicitIdResolution } from './task-identity';
import type { ParsedTask } from './task-scanner';

export interface ScanStatusChange {
  task: ParsedTask;
  previousStatus: ParsedTask['status'];
}

export interface ScanSnapshotRemoval {
  key: string;
  expectedFilePath: string;
}

export interface ScanLifecyclePlan {
  currentEntries: TaskSnapshotEntry[];
  removals: ScanSnapshotRemoval[];
  completions: ParsedTask[];
  habitCompletions: ParsedTask[];
  statusChanges: ScanStatusChange[];
}

export interface ScanExplicitIdResolver {
  resolve(id: string): ExplicitIdResolution<ParsedTask>;
  conflicts(): ReadonlyMap<string, readonly ParsedTask[]>;
}

/** Resolve post-commit unique owners whose prior source path disappeared in this wave. */
export function canonicalExplicitTasksForAffectedOwners(options: {
  currentTasks: readonly ParsedTask[];
  affectedPaths: ReadonlySet<string>;
  previousSnapshot: ReadonlyMap<string, TaskSnapshotEntry>;
  explicitIds: ScanExplicitIdResolver;
  globalTasks: readonly ParsedTask[];
}): ParsedTask[] {
  const currentKeys = new Set(options.currentTasks.map((task) => task.key));
  const globalByKey = new Map(options.globalTasks.map((task) => [task.key, task] as const));
  const recovered = new Map<string, ParsedTask>();
  for (const entry of options.previousSnapshot.values()) {
    if (!options.affectedPaths.has(entry.filePath) || currentKeys.has(entry.key)) continue;
    const candidate = globalByKey.get(entry.key);
    const id = candidate?.metadata.id?.trim();
    const resolution = id ? options.explicitIds.resolve(id) : undefined;
    if (candidate && resolution?.kind === 'unique' && resolution.task === candidate) recovered.set(candidate.key, candidate);
  }
  return [...recovered.values()];
}

/**
 * Plan lifecycle transitions for a complete accepted scan wave. Explicit IDs
 * compare against the global prior snapshot, so a path move cannot hide a
 * completion or make file iteration order choose the surviving owner.
 */
export function planScanLifecycleReconciliation(options: {
  currentTasks: readonly ParsedTask[];
  /** Unique explicit-ID owners recovered from the post-commit global index after a split move wave. */
  canonicalExplicitTasks?: readonly ParsedTask[];
  affectedPaths: ReadonlySet<string>;
  previousSnapshot: ReadonlyMap<string, TaskSnapshotEntry>;
  explicitIds: ScanExplicitIdResolver;
  isHabit: (task: ParsedTask) => boolean;
}): ScanLifecyclePlan {
  const ambiguousIds = new Set(options.explicitIds.conflicts().keys());
  const waveSafeTasks = options.currentTasks.filter((task) => {
    const id = task.metadata.id?.trim();
    return !id || options.explicitIds.resolve(id).kind === 'unique';
  });
  const waveKeys = new Set(waveSafeTasks.map((task) => task.key));
  const recoveredSafeTasks = (options.canonicalExplicitTasks ?? []).filter((task) => {
    const id = task.metadata.id?.trim();
    const resolution = id ? options.explicitIds.resolve(id) : undefined;
    return Boolean(id && !waveKeys.has(task.key) && resolution?.kind === 'unique' && resolution.task === task);
  });
  const safeTasks = [...waveSafeTasks, ...recoveredSafeTasks];
  const anonymousByFile = new Map<string, ParsedTask[]>();
  const previousByFile = new Map<string, Map<string, TaskSnapshotEntry>>();
  for (const entry of options.previousSnapshot.values()) {
    const bucket = previousByFile.get(entry.filePath) ?? new Map<string, TaskSnapshotEntry>();
    bucket.set(entry.key, entry);
    previousByFile.set(entry.filePath, bucket);
  }
  for (const task of waveSafeTasks) {
    if (task.metadata.id?.trim()) continue;
    const bucket = anonymousByFile.get(task.filePath) ?? [];
    bucket.push(task);
    anonymousByFile.set(task.filePath, bucket);
  }

  const completions: ParsedTask[] = [];
  const habitCompletions: ParsedTask[] = [];
  for (const path of options.affectedPaths) {
    const tasks = anonymousByFile.get(path) ?? [];
    const previous = previousByFile.get(path) ?? new Map<string, TaskSnapshotEntry>();
    completions.push(...detectCompletionTasks(tasks, previous));
    habitCompletions.push(...detectHabitCompletionTasks(tasks, previous, options.isHabit));
  }

  const statusChanges: ScanStatusChange[] = [];
  for (const task of safeTasks) {
    const explicitId = task.metadata.id?.trim();
    const previous = explicitId
      ? options.previousSnapshot.get(task.key)
      : previousByFile.get(task.filePath)?.get(task.key);
    if (explicitId && isCompletionTransition(previous, task)) completions.push(task);
    if (explicitId && options.isHabit(task) && isCompletionTransition(previous, task)) habitCompletions.push(task);
    if (previous && previous.status !== task.status) statusChanges.push({ task, previousStatus: previous.status });
  }

  const currentKeys = new Set(safeTasks.map((task) => task.key));
  const removals: ScanSnapshotRemoval[] = [];
  for (const entry of options.previousSnapshot.values()) {
    if (!options.affectedPaths.has(entry.filePath) || currentKeys.has(entry.key)) continue;
    const ambiguous = [...ambiguousIds].some((id) => entry.key === explicitTaskKey(id) || isLegacyExplicitTaskKey(entry.key, id));
    if (!ambiguous) removals.push({ key: entry.key, expectedFilePath: entry.filePath });
  }

  return {
    currentEntries: safeTasks.map((task) => ({
      key: task.key,
      status: task.status,
      filePath: task.filePath,
      lineNumber: task.lineNumber,
      sourceKind: task.lineNumber === 0 ? 'file' : 'line',
    })),
    removals,
    completions: uniqueTasks(completions),
    habitCompletions: uniqueTasks(habitCompletions),
    statusChanges,
  };
}

function uniqueTasks(tasks: readonly ParsedTask[]): ParsedTask[] {
  const seen = new Set<string>();
  return tasks.filter((task) => {
    const key = `${task.filePath}\u0000${task.lineNumber}\u0000${task.key}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
