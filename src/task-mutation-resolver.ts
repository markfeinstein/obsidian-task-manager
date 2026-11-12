import type { ParsedTask } from './task-scanner';
import { sourceLineIdentity, splitContentLines } from './task-model';

export interface ContentLine {
  text: string;
  lineEnding: string;
}

export type TaskLineParser = (line: string, filePath: string, lineNumber: number, heading?: string) => ParsedTask | null;

export interface ResolvedTaskLine {
  lineIndex: number;
  line: ContentLine;
  currentTask: ParsedTask;
}

export interface TaskLineMutation {
  task: ParsedTask;
  rewrite: (line: string, currentTask: ParsedTask) => string;
}

export interface TaskLineMutationResult {
  content: string;
  changed: number;
  updatedTasks: ParsedTask[];
}

/**
 * Resolve a rendered task against current file content. The rendered location is
 * preferred, but a moved task may be recovered only when its status and stable
 * source-line identity identify exactly one current line.
 */
export function resolveRenderedTaskLine(
  lines: readonly ContentLine[],
  task: ParsedTask,
  parseLine: TaskLineParser,
): ResolvedTaskLine {
  if (!Number.isInteger(task.lineNumber) || task.lineNumber < 1) {
    throw new Error(`Cannot update task: invalid line number ${task.lineNumber}`);
  }

  const matches = (lineIndex: number): ResolvedTaskLine | null => {
    const line = lines[lineIndex];
    if (!line) return null;
    const currentTask = parseLine(line.text, task.filePath, lineIndex + 1, task.heading);
    if (!currentTask || currentTask.status !== task.status) return null;
    if (sourceLineIdentity(line.text) !== sourceLineIdentity(task.rawLine)) return null;
    return { lineIndex, line, currentTask };
  };

  const expected = matches(task.lineNumber - 1);
  if (expected) return expected;

  let unique: ResolvedTaskLine | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    const candidate = matches(index);
    if (!candidate) continue;
    if (unique) {
      throw new Error(`Cannot update task: rendered task matches multiple lines in ${task.filePath}; rescan before updating`);
    }
    unique = candidate;
  }
  if (!unique) {
    throw new Error(`Cannot update task: line ${task.lineNumber} no longer matches the rendered task`);
  }
  return unique;
}

/** Validate every target before rewriting any line, making a same-file batch atomic. */
export function mutateRenderedTaskLinesInContent(
  content: string,
  mutations: readonly TaskLineMutation[],
  parseLine: TaskLineParser,
): TaskLineMutationResult {
  const lines = splitContentLines(content);
  const resolved = mutations.map((mutation) => ({ mutation, located: resolveRenderedTaskLine(lines, mutation.task, parseLine) }));
  const occupied = new Set<number>();
  for (const { located } of resolved) {
    if (occupied.has(located.lineIndex)) {
      throw new Error(`Cannot update tasks: multiple rendered tasks resolve to line ${located.lineIndex + 1}`);
    }
    occupied.add(located.lineIndex);
  }

  let changed = 0;
  const updatedTasks: ParsedTask[] = [];
  for (const { mutation, located } of resolved) {
    const replacement = mutation.rewrite(located.line.text, located.currentTask);
    if (replacement !== located.line.text) {
      located.line.text = replacement;
      changed += 1;
    }
    const updated = parseLine(replacement, mutation.task.filePath, located.lineIndex + 1, mutation.task.heading);
    if (!updated) throw new Error(`Cannot update task: rewritten line ${located.lineIndex + 1} is invalid`);
    updatedTasks.push(updated);
  }

  return {
    content: lines.map((line) => `${line.text}${line.lineEnding}`).join(''),
    changed,
    updatedTasks,
  };
}
