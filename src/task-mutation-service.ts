import type { App, TFile } from 'obsidian';
import { rewriteEditableDateField, rewritePriorityField, type EditableTaskDateField, type ParsedTask, type TaskScanner } from './task-scanner';
import { checkboxForStatus, splitContentLines } from './task-model';
import { mutateRenderedTaskLinesInContent, resolveRenderedTaskLine, type TaskLineMutation, type TaskLineMutationResult } from './task-mutation-resolver';
import type { TaskStateDefinition, TaskStatus } from './types';
import { isManualOrderWritableTask, setOrderFieldOnLine } from './manual-order';
import { sanitizeUntrustedInlineFieldValue, sanitizeUntrustedTaskText } from './untrusted-task-text';
import { unwrapTaskLifecycle, type TaskLifecycleResult } from './task-lifecycle';

export type TaskCacheInvalidator = (path: string) => void;
export type TaskMutationRefresh = (path: string) => void;
export type TaskIdentityGuard = (task: ParsedTask) => void;

export interface TaskBatchMutationResult {
  changed: number;
  updatedTasks: ParsedTask[];
}

export interface TaskManualOrderUpdate {
  task: ParsedTask;
  order: number | null;
}

export interface TaskLineFieldUpdate {
  content?: string;
  dueDate?: string | null;
  priority?: string;
}

function addTag(line: string, tags: readonly string[], tag: string): string {
  const normalized = tag.startsWith('#') ? tag : `#${tag}`;
  const raw = normalized.slice(1).toLowerCase();
  if (tags.some((value) => (value.startsWith('#') ? value.slice(1) : value).toLowerCase() === raw)) return line;
  const blockLink = line.match(/(\s\^[\w-]+)\s*$/u);
  if (!blockLink) return `${line.replace(/\s*$/u, '')} ${normalized}`;
  return `${line.slice(0, line.length - blockLink[0].length)} ${normalized}${blockLink[0]}`;
}

export function rewriteSyncTaskTitle(line: string, previousTitle: string, nextTitle: string): string {
  if (!previousTitle || !nextTitle) throw new Error('Sync title mutation requires non-empty canonical titles');
  const safeTitle = sanitizeUntrustedTaskText(nextTitle);
  if (safeTitle !== nextTitle) {
    throw new Error('Inbound sync title cannot be represented safely and reversibly in Markdown');
  }
  const checkboxEnd = line.search(/\]\s+/u);
  const searchFrom = checkboxEnd < 0 ? 0 : checkboxEnd + 2;
  const first = line.indexOf(previousTitle, searchFrom);
  if (first < 0 || line.indexOf(previousTitle, first + previousTitle.length) >= 0) {
    throw new Error('Task changed while applying inbound title; no ambiguous replacement was made');
  }
  return `${line.slice(0, first)}${safeTitle}${line.slice(first + previousTitle.length)}`;
}

export function rewriteSyncInlineField(line: string, key: string, value: string): string {
  const safeValue = sanitizeUntrustedInlineFieldValue(value);
  if (safeValue !== value) {
    throw new Error('Inbound sync description cannot be represented safely and reversibly in Markdown');
  }
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pattern = new RegExp(String.raw`\s*[\[(]${escapedKey}::\s*(?:\[\[[\s\S]*?\]\]|[^\]\)\r\n])*[\])]`, 'iu');
  const replacement = safeValue ? ` [${key}:: ${safeValue}]` : '';
  return pattern.test(line)
    ? line.replace(pattern, replacement).replace(/\s{2,}/gu, ' ').trimEnd()
    : `${line.trimEnd()}${replacement}`;
}

export function rewriteActualTimeField(line: string, elapsedMinutes: number): string {
  if (!Number.isFinite(elapsedMinutes) || elapsedMinutes <= 0) return line;
  const actualPattern = /🕐\uFE0F?\s*(?:(\d+)h(?:\s*(\d+)m)?|(\d+)m)/u;
  const matches = [...line.matchAll(/🕐\uFE0F?\s*(?:(\d+)h(?:\s*(\d+)m)?|(\d+)m)/gu)];
  if (matches.length > 1) throw new Error('Cannot update actual time: task contains multiple actual-time fields');
  const match = matches[0];
  const existingMinutes = match ? Number(match[1] ?? 0) * 60 + Number(match[2] ?? match[3] ?? 0) : 0;
  const totalMinutes = existingMinutes + Math.floor(elapsedMinutes);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const replacement = hours > 0 ? `🕐 ${hours}h ${minutes}m` : `🕐 ${minutes}m`;
  if (match) return line.replace(actualPattern, replacement);
  const blockLink = line.match(/(\s\^[\w-]+)\s*$/u);
  return blockLink
    ? `${line.slice(0, line.length - blockLink[0].length).trimEnd()} ${replacement}${blockLink[0]}`
    : `${line.trimEnd()} ${replacement}`;
}

function removeTag(line: string, tag: string): string {
  const raw = tag.startsWith('#') ? tag.slice(1) : tag;
  const escaped = raw.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  return line.replace(new RegExp(`(^|\\s)#${escaped}(?=\\s|$)`, 'giu'), (_match, prefix: string) => prefix).replace(/\s{2,}/gu, ' ').trimEnd();
}

export class TaskMutationService {
  constructor(
    private readonly app: App,
    private readonly scanner: TaskScanner,
    private readonly getSupportedStates: () => readonly TaskStateDefinition[],
    private readonly invalidateCache: TaskCacheInvalidator,
    private readonly refreshVisible?: TaskMutationRefresh,
    private readonly assertIdentitySafe?: TaskIdentityGuard,
  ) {}

  private assertTaskIdentity(task: ParsedTask): void {
    this.assertIdentitySafe?.(task);
  }

  private async updateLines(file: TFile, mutations: readonly TaskLineMutation[]): Promise<TaskBatchMutationResult> {
    for (const mutation of mutations) this.assertTaskIdentity(mutation.task);
    let mutationResult: TaskLineMutationResult = { content: '', changed: 0, updatedTasks: [] };
    await this.app.vault.process(file, (content) => {
      mutationResult = mutateRenderedTaskLinesInContent(
        content,
        mutations,
        (line, filePath, lineNumber, heading) => this.scanner.parseTaskLine(line, filePath, lineNumber, heading),
      );
      return mutationResult.changed > 0 ? mutationResult.content : content;
    });
    if (mutationResult.changed > 0) {
      this.invalidateCache(file.path);
      this.refreshVisible?.(file.path);
    }
    return { changed: mutationResult.changed, updatedTasks: mutationResult.updatedTasks };
  }

  async updateTaskCheckboxWithOutcome(file: TFile, task: ParsedTask, checkbox: string): Promise<TaskLifecycleResult> {
    this.assertTaskIdentity(task);
    const result = typeof this.scanner.updateTaskCheckboxWithOutcome === 'function'
      ? await this.scanner.updateTaskCheckboxWithOutcome(file, task, checkbox)
      : { outcome: 'completed' as const, action: 'status' as const, task: await this.scanner.updateTaskCheckbox(file, task, checkbox) };
    if (result.outcome !== 'blocked') {
      this.invalidateCache(file.path);
      this.refreshVisible?.(file.path);
    }
    return result;
  }

  async updateTaskCheckbox(file: TFile, task: ParsedTask, checkbox: string): Promise<ParsedTask> {
    return unwrapTaskLifecycle(await this.updateTaskCheckboxWithOutcome(file, task, checkbox));
  }

  async updateTaskStatus(file: TFile, task: ParsedTask, status: TaskStatus): Promise<ParsedTask> {
    return this.updateTaskCheckbox(file, task, checkboxForStatus(status, this.getSupportedStates()));
  }

  async updateTaskDate(file: TFile, task: ParsedTask, field: EditableTaskDateField, date: string | null): Promise<ParsedTask> {
    this.assertTaskIdentity(task);
    const updated = await this.scanner.updateTaskDate(file, task, field, date);
    this.invalidateCache(file.path);
    this.refreshVisible?.(file.path);
    return updated;
  }

  async updateTaskDates(file: TFile, tasks: readonly ParsedTask[], field: EditableTaskDateField, date: string | null): Promise<TaskBatchMutationResult> {
    for (const task of tasks) this.assertTaskIdentity(task);
    const result = await this.scanner.updateTaskDates(file, tasks, field, date);
    if (result.changed > 0) {
      this.invalidateCache(file.path);
      this.refreshVisible?.(file.path);
    }
    return result;
  }

  /** Replace only the reconciled title span, preserving tags, IDs, dates, custom fields, and children. */
  async updateTaskTitle(file: TFile, task: ParsedTask, previousTitle: string, nextTitle: string): Promise<ParsedTask> {
    const result = await this.updateLines(file, [{ task, rewrite: (line: string) => rewriteSyncTaskTitle(line, previousTitle, nextTitle) }]);
    if (!result.updatedTasks[0]) throw new Error('Inbound title mutation did not update the task');
    return result.updatedTasks[0];
  }

  /** Replace only contiguous 💬 child bullets. Other comments/metadata/children are retained. */
  async updateTaskComments(file: TFile, task: ParsedTask, comments: readonly string[]): Promise<void> {
    this.assertTaskIdentity(task);
    let changed = false;
    await this.app.vault.process(file, (content) => {
      const lines = splitContentLines(content);
      const parentIndex = task.lineNumber - 1;
      if (lines[parentIndex]?.text !== task.rawLine) throw new Error('Task changed while applying inbound comments');
      // Preserve every untouched line's own ending (do not normalize the whole
      // file); new comment lines inherit the parent line's ending, or the file's
      // dominant ending when the parent was the final unterminated line.
      const parentEnding = lines[parentIndex].lineEnding || (content.includes('\r\n') ? '\r\n' : '\n');
      let commentEnd = parentIndex + 1;
      const parentIndent = task.linePrefix.length + task.indentation.length;
      while (commentEnd < lines.length) {
        const candidate = lines[commentEnd]?.text ?? '';
        const childIndent = candidate.match(/^(?:\s*>\s*)*\s*/u)?.[0].length ?? 0;
        if (childIndent <= parentIndent || !/^\s*(?:[-*+]\s+)?💬\s+/u.test(candidate)) break;
        commentEnd += 1;
      }
      const indent = `${task.linePrefix}${task.indentation}  `;
      const replacementText = comments.map((comment) => `${indent}- 💬 ${comment}`);
      const existing = lines.slice(parentIndex + 1, commentEnd);
      if (existing.length === replacementText.length && existing.every((line, index) => line.text === replacementText[index])) return content;
      const replacement = replacementText.map((text) => ({ text, lineEnding: '' }));
      lines.splice(parentIndex + 1, commentEnd - parentIndex - 1, ...replacement);
      changed = true;
      return lines.map((line, index) => `${line.text}${index === lines.length - 1 ? line.lineEnding : (line.lineEnding || parentEnding)}`).join('');
    });
    if (changed) {
      this.invalidateCache(file.path);
      this.refreshVisible?.(file.path);
    }
  }

  /** Atomically rewrite one task line and its contiguous sync-managed comment bullets, then read back the persisted task. */
  async updateTaskBlockFromSync(
    file: TFile,
    task: ParsedTask,
    rewriteLine: (line: string, currentTask: ParsedTask) => string,
    comments?: readonly string[],
    shouldContinue: () => boolean = () => true,
  ): Promise<ParsedTask> {
    if (!shouldContinue()) throw new Error('Inbound sync mutation cancelled');
    this.assertTaskIdentity(task);
    if (comments !== undefined) {
      for (const comment of comments) {
        if (sanitizeUntrustedTaskText(comment) !== comment) {
          throw new Error('Inbound sync description cannot be represented safely and reversibly in Markdown');
        }
      }
    }
    let resolvedLineNumber = task.lineNumber;
    await this.app.vault.process(file, (content) => {
      if (!shouldContinue()) return content;
      const lines = splitContentLines(content);
      const located = resolveRenderedTaskLine(
        lines,
        task,
        (line, filePath, lineNumber, heading) => this.scanner.parseTaskLine(line, filePath, lineNumber, heading),
      );
      const updatedLine = rewriteLine(located.line.text, located.currentTask);
      const updatedTask = this.scanner.parseTaskLine(updatedLine, task.filePath, located.lineIndex + 1, task.heading);
      if (!updatedTask) throw new Error('Inbound sync rewrite did not produce a valid task line');
      located.line.text = updatedLine;
      resolvedLineNumber = located.lineIndex + 1;

      if (comments !== undefined) {
        const parentIndent = updatedTask.linePrefix.length + updatedTask.indentation.length;
        let commentEnd = located.lineIndex + 1;
        while (commentEnd < lines.length) {
          const candidate = lines[commentEnd]?.text ?? '';
          const childIndent = candidate.match(/^(?:\s*>\s*)*\s*/u)?.[0].length ?? 0;
          if (childIndent <= parentIndent || !/^\s*(?:[-*+]\s+)?💬\s+/u.test(candidate)) break;
          commentEnd += 1;
        }
        const lineEnding = located.line.lineEnding || '\n';
        const indent = `${updatedTask.linePrefix}${updatedTask.indentation}  `;
        const replacement = comments.map((comment) => ({ text: `${indent}- 💬 ${comment}`, lineEnding }));
        lines.splice(located.lineIndex + 1, commentEnd - located.lineIndex - 1, ...replacement);
      }
      return lines.map((line) => `${line.text}${line.lineEnding}`).join('');
    });

    if (!shouldContinue()) throw new Error('Inbound sync mutation cancelled');
    const persisted = await this.scanner.scanFile(file);
    if (!shouldContinue()) throw new Error('Inbound sync mutation cancelled');
    const exact = persisted.find((candidate) => candidate.key === task.key && candidate.lineNumber === resolvedLineNumber);
    const identityMatches = exact || !task.metadata.id
      ? []
      : persisted.filter((candidate) => candidate.filePath === task.filePath && candidate.metadata.id === task.metadata.id);
    if (!exact && identityMatches.length > 1) throw new Error('Inbound sync found ambiguous persisted task');
    const updated = exact ?? identityMatches[0];
    if (!updated) throw new Error('Inbound sync mutation could not verify the persisted task');
    this.invalidateCache(file.path);
    this.refreshVisible?.(file.path);
    return updated;
  }

  async updateTaskActualTime(file: TFile, task: ParsedTask, elapsedMinutes: number): Promise<ParsedTask> {
    const result = await this.updateLines(file, [{ task, rewrite: (line) => rewriteActualTimeField(line, elapsedMinutes) }]);
    if (!result.updatedTasks[0]) throw new Error('Actual-time mutation did not update the task');
    return result.updatedTasks[0];
  }

  async updateTaskPriority(file: TFile, task: ParsedTask, priority: string): Promise<ParsedTask> {
    this.assertTaskIdentity(task);
    const updated = await this.scanner.updateTaskPriority(file, task, priority);
    this.invalidateCache(file.path);
    this.refreshVisible?.(file.path);
    return updated;
  }

  async updateTaskCustomFields(file: TFile, tasks: readonly ParsedTask[], key: string, value: string): Promise<TaskBatchMutationResult> {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
    const fieldPattern = new RegExp(String.raw`\s*[\[(]${escapedKey}::\s*(?:\[\[[\s\S]*?\]\]|[^\]\)\r\n])*[\])]`, 'iu');
    const replacement = value ? ` [${key}:: ${value}]` : '';
    return this.updateLines(file, tasks.map((task) => ({
      task,
      rewrite: (line: string) => fieldPattern.test(line)
        ? line.replace(fieldPattern, replacement).replace(/\s{2,}/gu, ' ').trimEnd()
        : `${line.trimEnd()}${replacement}`,
    })));
  }

  async updateTaskCustomField(file: TFile, task: ParsedTask, key: string, value: string): Promise<ParsedTask> {
    const result = await this.updateTaskCustomFields(file, [task], key, value);
    return result.updatedTasks[0];
  }

  async updateTaskTags(file: TFile, tasks: readonly ParsedTask[], tag: string, action: 'add' | 'remove'): Promise<TaskBatchMutationResult> {
    return this.updateLines(file, tasks.map((task) => ({
      task,
      rewrite: (line: string, currentTask: ParsedTask) => action === 'add'
        ? addTag(line, currentTask.tags, tag)
        : removeTag(line, tag),
    })));
  }

  async replaceTaskTag(file: TFile, task: ParsedTask, previousTag: string | undefined, nextTag: string | undefined): Promise<ParsedTask> {
    const previous = previousTag?.replace(/^#/u, '');
    const next = nextTag?.replace(/^#/u, '');
    const result = await this.updateLines(file, [{
      task,
      rewrite: (line: string, currentTask: ParsedTask) => {
        const withoutPrevious = previous ? removeTag(line, previous) : line;
        const retainedTags = currentTask.tags.filter((tag) => tag.replace(/^#/u, '').toLowerCase() !== previous?.toLowerCase());
        return next ? addTag(withoutPrevious, retainedTags, next) : withoutPrevious;
      },
    }]);
    return result.updatedTasks[0];
  }

  async updateTaskManualOrders(file: TFile, updates: readonly TaskManualOrderUpdate[]): Promise<TaskBatchMutationResult> {
    if (updates.some(({ task }) => !isManualOrderWritableTask(task))) throw new Error('Canvas tasks are read-only for manual ordering.');
    return this.updateLines(file, updates.map(({ task, order }) => ({ task, rewrite: (line: string) => setOrderFieldOnLine(line, order) })));
  }

  async updateTaskLineFields(file: TFile, task: ParsedTask, fields: TaskLineFieldUpdate): Promise<ParsedTask> {
    const result = await this.updateLines(file, [{
      task,
      rewrite: (line: string, currentTask: ParsedTask) => {
        let updatedLine = line;
        let parsed = currentTask;
        if (fields.content !== undefined) {
          updatedLine = `${currentTask.linePrefix}${currentTask.indentation}${currentTask.listMarker} [${currentTask.checkbox}] ${fields.content}`;
          parsed = this.scanner.parseTaskLine(updatedLine, task.filePath, currentTask.lineNumber, task.heading) ?? currentTask;
        }
        if (fields.dueDate !== undefined) {
          updatedLine = rewriteEditableDateField(updatedLine, 'due', fields.dueDate, parsed, false);
          parsed = this.scanner.parseTaskLine(updatedLine, task.filePath, currentTask.lineNumber, task.heading) ?? parsed;
        }
        if (fields.priority !== undefined) updatedLine = rewritePriorityField(updatedLine, fields.priority);
        return updatedLine;
      },
    }]);
    return result.updatedTasks[0];
  }

  async replaceTaskLine(file: TFile, task: ParsedTask, newContent: string): Promise<TaskBatchMutationResult> {
    return this.updateLines(file, [{ task, rewrite: () => newContent }]);
  }
}
