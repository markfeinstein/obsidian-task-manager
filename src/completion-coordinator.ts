import type { TFile } from 'obsidian';
import type { LogWriter } from './log-writer';
import type { CompletionRecord, StateStore } from './state-store';
import type { ParsedTask } from './task-scanner';

export interface CompletionDailyNoteResolver {
  resolveToday(isActive?: () => boolean): Promise<{ path: string; file: TFile }>;
  isTodayDailyNote(path: string): boolean;
}

export interface CompletionBatchOptions {
  tasks: readonly ParsedTask[];
  existingRecords: readonly CompletionRecord[];
  inFlightKeys: Set<string>;
  shouldInclude: (task: ParsedTask) => boolean;
  isActive: () => boolean;
}

/** Materializes completion log entries once per scan wave; persistence remains owned by the scan commit. */
export class CompletionCoordinator {
  constructor(
    private readonly stateStore: StateStore,
    private readonly dailyNoteResolver: CompletionDailyNoteResolver,
    private readonly logWriter: LogWriter,
  ) {}

  async materialize(options: CompletionBatchOptions): Promise<CompletionRecord[]> {
    if (!options.isActive()) return [];
    const tasks = options.tasks.filter((task) =>
      options.shouldInclude(task) && !this.dailyNoteResolver.isTodayDailyNote(task.filePath));
    if (tasks.length === 0) return [];

    // Today is the single completion-log target. Resolve it once for the wave.
    let dailyNote: Awaited<ReturnType<CompletionDailyNoteResolver['resolveToday']>>;
    try {
      dailyNote = await this.dailyNoteResolver.resolveToday(options.isActive);
    } catch (error) {
      if (!options.isActive()) return [];
      throw error;
    }
    if (!options.isActive()) return [];

    const persistedKeys = new Set(options.existingRecords.map((record) =>
      this.stateStore.completionKey(record.taskKey, record.sourcePath, record.dailyNotePath)));
    const pending: Array<{ task: ParsedTask; key: string; completedAt: Date }> = [];
    for (const task of tasks) {
      const key = this.stateStore.completionKey(task.key, task.filePath, dailyNote.path);
      if (persistedKeys.has(key) || options.inFlightKeys.has(key)) continue;
      options.inFlightKeys.add(key);
      pending.push({ task, key, completedAt: new Date() });
    }
    if (pending.length === 0) return [];

    try {
      const logEntries = pending.map(({ task, key, completedAt }) => ({
        text: task.normalizedText,
        sourcePath: task.filePath,
        completedAt,
        completionId: this.stateStore.hash(key),
      }));
      const writer = this.logWriter as LogWriter & { appendBatchToDailyLog?: LogWriter['appendBatchToDailyLog'] };
      const lines = typeof writer.appendBatchToDailyLog === 'function'
        ? await writer.appendBatchToDailyLog(dailyNote.file, logEntries, options.isActive)
        : await Promise.all(logEntries.map((entry) => this.logWriter.appendToDailyLog(dailyNote.file, entry, options.isActive)));
      if (!options.isActive()) return [];
      return pending.map(({ task, completedAt }, index) => ({
        taskKey: task.key,
        sourcePath: task.filePath,
        dailyNotePath: dailyNote.path,
        completedAtIso: completedAt.toISOString(),
        logLineHash: this.stateStore.hash(lines[index] ?? ''),
      }));
    } finally {
      for (const { key } of pending) options.inFlightKeys.delete(key);
    }
  }
}
