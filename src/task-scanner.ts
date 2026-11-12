import { TaskHistoryTracker } from './task-history';
import { moment, type App, type TFile } from 'obsidian';
import { DEFAULT_SETTINGS, DEFAULT_TASK_STATES, type TaskManagerSettings, type TaskStateDefinition, type TaskStatus } from './types';
import { mergeCustomFields, parseCustomFieldsFromFrontmatter } from './custom-fields-sync';
import { type StateStore, type PersistedState } from './state-store';
import {
  checkboxForStatus,
  normalizeRecurrenceRule,
  normalizeTaskText,
  normalizeTaskTextForKey,
  parseMarkdownTaskLine,
  taskKeyForBody,
  splitContentLines,
  statusFromCheckbox,
  sourceLineIdentity,
  stripTaskMetadata,
  updateMarkdownTaskCheckboxInContent,
  type MarkdownTask,
  type TaskDateField,
} from './task-model';
import { WORD_NUMBERS } from './date-utils';
import { formatLocalDate as formatIsoLocalDate, formatUtcDate as formatIsoUtcDate, isValidIsoDate } from './iso-date';
import { isTaskNoteFile as isTaskNoteFileExt, parseTaskNoteFrontmatter, rewriteTaskNoteFrontmatter, scanFileAsTask as scanTaskNoteFromContent } from './task-scanner-ext';
import { mutateRenderedTaskLinesInContent, resolveRenderedTaskLine } from './task-mutation-resolver';
import { ensureParentFolders, normalizeVaultRelativePath } from './vault-utils';
import { completedTaskLifecycle, incompleteTaskLifecycle, unwrapTaskLifecycle, type TaskLifecycleAction, type TaskLifecycleResult } from './task-lifecycle';
import { LifecycleTransferRecoveryError, TaskLifecycleTransferService } from './task-lifecycle-transfer-service';
import { commitRecurrenceOccurrence, recurrenceStateRepository } from './state-slice-repositories';

export type ParsedTask = MarkdownTask;
export type EditableTaskDateField = TaskDateField | 'reminder' | 'timeStart';

type DeferredArchiveLine = { action: 'archive' | 'collect'; sourceLine: string; sourceLineNumber: number; archiveText: string };
type DeferredRecurringArchiveLine = DeferredArchiveLine & { nextLineParts: Array<{ text: string; lineEnding: string }> };

class TaskLifecyclePreflightError extends Error {
  constructor(
    message: string,
    readonly action: TaskLifecycleAction,
    readonly destinationPath?: string,
  ) {
    super(message);
    this.name = 'TaskLifecyclePreflightError';
  }
}

type TaskScannerSettings = Pick<TaskManagerSettings,
  | 'setCreatedDate'
  | 'setDoneDate'
  | 'setCancelledDate'
  | 'recurrenceFutureOccurrences'
  | 'recurrenceInsertLocation'
  | 'removeScheduledDateOnRecurrence'
  | 'recurrenceOnCancelled'
  | 'useFilenameAsScheduledDate'
  | 'filenameScheduledDateFormat'
  | 'filenameScheduledDateFolders'
  | 'removeGlobalFilterFromDescription'
  | 'archiveFilePath'
  | 'archiveHeading'
  | 'dateFormat'
  | 'collectFilePath'
  | 'collectHeading'
  | 'autoCompleteParent'
  | 'autoAdvanceParentToInProgress'
  | 'autoAdvanceParentOnAllCancelled'
  | 'trackRecurrenceCount'
  | 'dateTimeOnLifecycleDates'
  | 'fileDefaultsEnabled'
  | 'fileDefaultsPropertyPrefix'
  | 'workflowsEnabled'
  | 'workflows'
  | 'orgModeEnabled'
  | 'recurrenceSkipToFuture'
  | 'customFieldDefinitions'
  | 'taskNoteFolders'
  | 'taskNoteMarker'
>;

const SCANNER_DEFAULT_SETTINGS: TaskScannerSettings = {
  setCreatedDate: DEFAULT_SETTINGS.setCreatedDate,
  setDoneDate: DEFAULT_SETTINGS.setDoneDate,
  setCancelledDate: DEFAULT_SETTINGS.setCancelledDate,
  recurrenceFutureOccurrences: DEFAULT_SETTINGS.recurrenceFutureOccurrences,
  recurrenceInsertLocation: DEFAULT_SETTINGS.recurrenceInsertLocation,
  removeScheduledDateOnRecurrence: DEFAULT_SETTINGS.removeScheduledDateOnRecurrence,
  recurrenceOnCancelled: DEFAULT_SETTINGS.recurrenceOnCancelled,
  useFilenameAsScheduledDate: DEFAULT_SETTINGS.useFilenameAsScheduledDate,
  filenameScheduledDateFormat: DEFAULT_SETTINGS.filenameScheduledDateFormat,
  filenameScheduledDateFolders: DEFAULT_SETTINGS.filenameScheduledDateFolders,
  removeGlobalFilterFromDescription: DEFAULT_SETTINGS.removeGlobalFilterFromDescription,
  archiveFilePath: DEFAULT_SETTINGS.archiveFilePath,
  archiveHeading: DEFAULT_SETTINGS.archiveHeading,
  dateFormat: DEFAULT_SETTINGS.dateFormat,
  collectFilePath: DEFAULT_SETTINGS.collectFilePath,
  collectHeading: DEFAULT_SETTINGS.collectHeading,
  autoCompleteParent: DEFAULT_SETTINGS.autoCompleteParent,
  autoAdvanceParentToInProgress: DEFAULT_SETTINGS.autoAdvanceParentToInProgress,
  autoAdvanceParentOnAllCancelled: DEFAULT_SETTINGS.autoAdvanceParentOnAllCancelled,
  trackRecurrenceCount: DEFAULT_SETTINGS.trackRecurrenceCount,
  dateTimeOnLifecycleDates: DEFAULT_SETTINGS.dateTimeOnLifecycleDates,
  fileDefaultsEnabled: DEFAULT_SETTINGS.fileDefaultsEnabled,
  fileDefaultsPropertyPrefix: DEFAULT_SETTINGS.fileDefaultsPropertyPrefix,
  workflowsEnabled: DEFAULT_SETTINGS.workflowsEnabled,
  workflows: DEFAULT_SETTINGS.workflows,
  orgModeEnabled: DEFAULT_SETTINGS.orgModeEnabled,
  recurrenceSkipToFuture: DEFAULT_SETTINGS.recurrenceSkipToFuture,
  customFieldDefinitions: DEFAULT_SETTINGS.customFieldDefinitions,
  taskNoteFolders: DEFAULT_SETTINGS.taskNoteFolders,
  taskNoteMarker: DEFAULT_SETTINGS.taskNoteMarker,
};

export class TaskScanner {
  /** Keys of tasks currently being auto-completed (prevents parent→child→parent cycles). */
  private readonly autoCompleteInFlight = new Set<string>();

  constructor(
    private readonly app: App,
    private readonly getTaskStates: () => readonly TaskStateDefinition[] = () => DEFAULT_TASK_STATES,
    private readonly getGlobalFilter: () => string = () => '',
    private readonly getSettings: () => TaskScannerSettings = () => SCANNER_DEFAULT_SETTINGS,
    private readonly getStateStore: () => StateStore | undefined = () => undefined,
    private readonly historyTracker?: TaskHistoryTracker,
  ) {}

  async scanFile(file: TFile): Promise<ParsedTask[]> {
    return this.scanFileContent(file, await this.app.vault.read(file));
  }

  scanFileContent(file: TFile, content: string): ParsedTask[] {
    const lines = content.split(/\r?\n/);
    const tasks: ParsedTask[] = [];
    let heading: string | undefined;

    let inCodeFence = false;
    let codeFenceMarker: '`' | '~' | null = null;
    let codeFenceLength = 0;
    let inPercentComment = false;
    let inHtmlComment = false;
    let inFrontmatter = false;
    for (let index = 0; index < lines.length; index++) {
      const rawLine = lines[index];
      const commentState = updateCommentAndCodeState(rawLine, {
        inCodeFence,
        codeFenceMarker,
        codeFenceLength,
        inPercentComment,
        inHtmlComment,
        inFrontmatter,
        lineIndex: index,
      });
      inCodeFence = commentState.inCodeFence;
      codeFenceMarker = commentState.codeFenceMarker;
      codeFenceLength = commentState.codeFenceLength;
      inPercentComment = commentState.inPercentComment;
      inHtmlComment = commentState.inHtmlComment;
      inFrontmatter = commentState.inFrontmatter;
      if (commentState.skipLine) {
        continue;
      }
      const headingMatch = rawLine.match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/u);
      if (headingMatch) {
        heading = normalizeTaskText(headingMatch[1]);
      }
      const parsed = this.parseTaskLine(rawLine, file.path, index + 1, heading);
      if (parsed) {
        // Collect 💬 child-bullet comments: indented lines immediately after this task
        // that match `  - 💬 <text>` or `  💬 <text>` (more-indented lines).
        const taskIndentLen = parsed.indentation.length + parsed.linePrefix.length;
        const comments: string[] = [];
        for (let ci = index + 1; ci < lines.length; ci++) {
          const childLine = lines[ci];
          if (!childLine || childLine.trim() === '') break; // comments must be contiguous with the task
          const childIndentLen = childLine.match(/^(?:\s*>\s*)*\s*/u)?.[0].length ?? 0;
          if (childIndentLen <= taskIndentLen) break; // back to same/lower indent — stop
          const commentMatch = childLine.match(/^\s*(?:[-*+]\s+)?\uD83D\uDCAC\s+(.+)$/u);
          if (!commentMatch) break;
          comments.push(commentMatch[1].trim());
        }
        const taskWithComments: ParsedTask = comments.length > 0
          ? { ...parsed, metadata: { ...parsed.metadata, comments } }
          : parsed;
        tasks.push(this.applyImpliedMetadata(taskWithComments));
      }
    }

    // Apply defaults from the same immutable body that produced the tasks and
    // scan fingerprint. MetadataCache may still describe an older body here.
    const defaults = this.getSettings().fileDefaultsEnabled
      ? parseTaskNoteFrontmatter(content)
      : null;
    const finalTasks = defaults ? tasks.map((t) => this.applyFileDefaults(t, defaults, file)) : tasks;
    return this.assignDuplicateOccurrenceKeys(finalTasks);
  }

  /**
   * Scan a Canvas (.canvas) file for tasks embedded in text nodes.
   * Canvas JSON format: `{ nodes: Array<{ type: string, text?: string, id: string }> }`
   */
  async scanCanvasFile(file: TFile): Promise<ParsedTask[]> {
    return this.scanCanvasContent(file, await this.app.vault.read(file));
  }

  scanCanvasContent(file: TFile, raw: string): ParsedTask[] {
    const json = JSON.parse(raw) as { nodes?: Array<{ type?: string; text?: string; content?: string; id?: string }> };
    const nodes = Array.isArray(json?.nodes) ? json.nodes : [];
    const tasks: ParsedTask[] = [];
    let virtualLine = 1;
    for (const node of nodes) {
      const nodeText = typeof node.text === 'string'
        ? node.text
        : typeof node.content === 'string'
        ? node.content
        : null;
      if (node.type !== 'text' || nodeText === null) continue;
      const lines = nodeText.split(/\r?\n/u);
      for (const line of lines) {
        const parsed = this.parseTaskLine(line, file.path, virtualLine, node.id ? `Canvas card ${node.id}` : 'Canvas card');
        if (parsed) tasks.push(this.applyImpliedMetadata(parsed));
        virtualLine += 1;
      }
    }
    return this.assignDuplicateOccurrenceKeys(tasks);
  }

  parseTaskLine(rawLine: string, filePath: string, lineNumber: number, heading?: string): ParsedTask | null {
    const settings = this.getSettings();
    const orgMode = settings.orgModeEnabled;
    const parsed = parseMarkdownTaskLine(rawLine, filePath, lineNumber, this.getTaskStates(), heading, orgMode, settings.customFieldDefinitions);
    if (!parsed) {
      return null;
    }
    if (parsed.metadata.recurrence && !isRecurrenceRuleValid(parsed.metadata.recurrence)) {
      parsed.metadata.invalidRecurrence = true;
      warnInvalidRecurrenceOnce(parsed.metadata.recurrence, filePath, lineNumber);
    }
    const globalFilter = this.getGlobalFilter().trim();
    // Global filter text match is case-insensitive (matches upstream
    // obsidian-tasks behavior). Tag filters use parsed tag boundaries so
    // `#task` does not accidentally match `#tasking` or `foo#taskbar`; nested
    // sub-tags still satisfy the filter and are stripped below.
    if (globalFilter && !taskMatchesGlobalFilter(parsed, globalFilter)) {
      return null;
    }
    if (!globalFilter) return parsed;
    return this.getSettings().removeGlobalFilterFromDescription
      ? removeGlobalFilterFromTask(parsed, globalFilter)
      : removeGlobalFilterTagFromTask(parsed, globalFilter);
  }

  statusFromMarker(marker: string): ParsedTask['status'] {
    return statusFromCheckbox(marker, this.getTaskStates());
  }

  normalizeForKey(rawLine: string): string {
    return normalizeTaskTextForKey(rawLine);
  }

  async updateTaskStatus(file: TFile, task: ParsedTask, status: TaskStatus): Promise<ParsedTask> {
    return this.updateTaskCheckbox(file, task, checkboxForStatus(status, this.getTaskStates()));
  }

  /**
   * Complete a task without triggering recurrence — used by the recurrence context menu
   * "Skip this occurrence" action (#11).
   */
  async updateTaskCheckboxSkipRecurrence(file: TFile, task: ParsedTask, checkbox: string): Promise<ParsedTask> {
    return this.updateTaskRaw(file, task, checkbox);
  }

  /** Low-level checkbox update with lifecycle dates but no recurrence expansion. */
  private async updateTaskRaw(file: TFile, task: ParsedTask, checkbox: string): Promise<ParsedTask> {
    const today = currentLocalDateString();
    const settings = this.getSettings();
    const targetStatus = statusFromCheckbox(checkbox, this.getTaskStates());
    let updatedTask!: ParsedTask;
    await this.app.vault.process(file, (content) => {
      const { content: updated, updatedTask: newTask, previousTask } = updateMarkdownTaskCheckboxInContent(
        content,
        task,
        checkbox,
        this.getTaskStates(),
        { allowStaleStatus: true, allowLifecycleDateMismatch: true },
      );
      const completedLine = updated.split(/\r?\n/u)[newTask.lineNumber - 1] ?? newTask.rawLine;
      const withDates = applyAutomaticStatusDates(completedLine, previousTask.status, targetStatus, today, settings);
      // Re-parse the line after dates are applied so the returned task reflects the
      // stamped lifecycle date (✅ / ❌).  Without this, the file gets the date but
      // the returned ParsedTask is stale — it lacks the date until the file is re-scanned.
      updatedTask = this.parseTaskLine(withDates, task.filePath, newTask.lineNumber, task.heading) ?? newTask;
      const lines = splitContentLines(updated);
      if (lines[newTask.lineNumber - 1] !== undefined) lines[newTask.lineNumber - 1].text = withDates;
      return lines.map((part) => `${part.text}${part.lineEnding}`).join('');
    });
    return updatedTask;
  }

  async updateTaskCheckbox(file: TFile, task: ParsedTask, checkbox: string): Promise<ParsedTask> {
    return unwrapTaskLifecycle(await this.updateTaskCheckboxWithOutcome(file, task, checkbox));
  }

  async updateTaskCheckboxWithOutcome(file: TFile, task: ParsedTask, checkbox: string): Promise<TaskLifecycleResult> {
    const targetStatus = statusFromCheckbox(checkbox, this.getTaskStates());
    const settings = this.getSettings();
    if (this.isFileBackedTaskNote(file, task)) {
      return this.updateTaskNoteStatus(file, task, checkbox, targetStatus);
    }
    const requestedAction = targetStatus === 'done' ? task.metadata.onCompletion : undefined;
    const lifecycleAction: TaskLifecycleAction = requestedAction === 'archive' || requestedAction === 'collect'
      || requestedAction === 'delete' || requestedAction === 'move-to-end'
      ? requestedAction
      : hasUsableRecurrence(task, settings) && targetStatus === 'done' ? 'recurrence' : 'status';
    if ((targetStatus === 'done' || targetStatus === 'cancelled')
      && !task.metadata.id
      && !hasUsableRecurrence(task, settings)
      && /\u0000\d+$/u.test(task.key)) {
      return incompleteTaskLifecycle(
        'blocked',
        task,
        lifecycleAction,
        'Identical anonymous tasks do not have durable state identity.',
        'Add a unique task ID before completing or cancelling this task; no task content was changed.',
      );
    }
    let destinationPath: string | undefined;
    try {
      if (requestedAction === 'archive') destinationPath = this.archiveDestinationPath();
      if (requestedAction === 'collect') destinationPath = this.collectDestinationPath();
    } catch (error) {
      return incompleteTaskLifecycle(
        'blocked',
        task,
        lifecycleAction,
        error instanceof Error ? error.message : String(error),
        'Choose a valid vault-relative destination path and retry; no task content was changed.',
      );
    }
    if (destinationPath === normalizeVaultRelativePath(file.path, 'Task source path')) {
      return incompleteTaskLifecycle('blocked', task, lifecycleAction, 'Lifecycle destination equals the source file.', 'Choose a different archive/collect file and retry.', destinationPath);
    }
    const advancingForCancellation =
      targetStatus === 'cancelled'
      && task.status !== 'cancelled'
      && task.status !== 'untracked'
      && settings.recurrenceOnCancelled
      && hasUsableRecurrence(task, settings);
    if (
      targetStatus === 'done'
      && task.status !== 'done'
      && task.status !== 'untracked'
      && hasUsableRecurrence(task, settings)
    ) {
      return this.completeRecurringTask(file, task, checkbox, targetStatus, destinationPath);
    }
    if (advancingForCancellation) {
      return this.completeRecurringTask(file, task, checkbox, targetStatus, destinationPath);
    }

    let updatedTask: ParsedTask = task;
    let archivedLine: DeferredArchiveLine | null = null;
    let lifecycleFailure: { outcome: 'destination-failed' | 'source-conflict'; reason: string; recovery: string } | undefined;
    try {
      await this.app.vault.process(file, (content) => {
      const result = updateMarkdownTaskCheckboxInContent(
        content,
        task,
        checkbox,
        this.getTaskStates(),
        { allowStaleStatus: true, allowLifecycleDateMismatch: true },
      );
      const currentRequestedAction = targetStatus === 'done' ? result.previousTask.metadata.onCompletion : undefined;
      const recurrenceChanged = (targetStatus === 'done' || targetStatus === 'cancelled')
        && hasUsableRecurrence(result.previousTask, settings) !== hasUsableRecurrence(task, settings);
      if (currentRequestedAction !== requestedAction || recurrenceChanged) {
        const action: TaskLifecycleAction = currentRequestedAction === 'archive' || currentRequestedAction === 'collect'
          || currentRequestedAction === 'delete' || currentRequestedAction === 'move-to-end'
          ? currentRequestedAction
          : hasUsableRecurrence(result.previousTask, settings) ? 'recurrence' : 'status';
        throw new TaskLifecyclePreflightError('Task lifecycle metadata changed before the status update.', action);
      }
      const today = currentLocalDateString();
      let nextContent = result.content;
      const lines = splitContentLines(nextContent);
      const updatedLineNumber = result.updatedTask.lineNumber;
      const line = lines[updatedLineNumber - 1];
      if (!line) throw new Error(`Cannot update task: line ${updatedLineNumber} no longer exists`);
      line.text = applyAutomaticStatusDates(line.text, result.previousTask.status, targetStatus, today, this.getSettings());
      const currentTask = this.parseTaskLine(line.text, task.filePath, updatedLineNumber, task.heading);
      if (!currentTask) throw new Error(`Cannot update task: line ${updatedLineNumber} is no longer a task`);
      updatedTask = currentTask;
      const onCompletion = currentTask.metadata.onCompletion;
      if (targetStatus === 'done' && (onCompletion === 'delete' || onCompletion === 'archive' || onCompletion === 'collect' || onCompletion === 'move-to-end')) {
        if (onCompletion === 'archive' || onCompletion === 'collect') {
          // Archive/collect destination writes happen before source removal. If the
          // destination write fails, the completed task remains in the source file,
          // avoiding a remove-then-archive data-loss window.
          archivedLine = {
            action: onCompletion,
            sourceLine: line.text,
            sourceLineNumber: updatedLineNumber,
            archiveText: taskBlockToText(lines, updatedLineNumber - 1, currentTask),
          };
        } else if (onCompletion === 'move-to-end') {
          // Move the completed task block to the end of its current section atomically.
          moveTaskBlockToSectionEnd(lines, updatedLineNumber - 1, currentTask);
        } else {
          // #14: also remove child lines to avoid orphaned list items
          const parentIndent = currentTask.indentation.length + currentTask.linePrefix.length;
          let childEnd = updatedLineNumber; // 1-based; lines[updatedLineNumber-1] is parent
          while (childEnd < lines.length) {
            const childLineText = lines[childEnd]?.text ?? '';
            const childIndent = childLineText.match(/^(?:\s*>\s*)*\s*/u)?.[0].length ?? 0;
            if (childIndent <= parentIndent) break;
            childEnd++;
          }
          lines.splice(updatedLineNumber - 1, childEnd - (updatedLineNumber - 1));
        }
        updatedTask = currentTask;
      }
      nextContent = lines.map((part) => `${part.text}${part.lineEnding}`).join('');
      return nextContent;
      });
    } catch (error) {
      if (error instanceof TaskLifecyclePreflightError) {
        return incompleteTaskLifecycle('blocked', task, error.action, error.message, 'Refresh the task and retry; no task content was changed.', error.destinationPath);
      }
      throw error;
    }

    const pendingArchive = archivedLine as DeferredArchiveLine | null;
    let durableLifecycleFailed = false;
    let sourceFinalized = pendingArchive === null;
    if (pendingArchive !== null) {
      const sourceLine = pendingArchive.sourceLine;
      const sourceLineNumber = pendingArchive.sourceLineNumber;
      const archiveText = pendingArchive.archiveText;
      const stateStore = this.getStateStore?.();
      if (stateStore && destinationPath) {
        try {
          await new TaskLifecycleTransferService(this.app, stateStore).transfer({
            action: pendingArchive.action,
            sourceFile: file,
            sourcePath: file.path,
            sourceLine: sourceLineNumber,
            sourceIdentity: updatedTask.key,
            sourceBlock: archiveText,
            sourceReplacement: '',
            targetPath: destinationPath,
            targetHeading: pendingArchive.action === 'collect'
              ? (this.getSettings().collectHeading?.trim() || 'Collected Tasks')
              : (this.getSettings().archiveHeading.trim() || 'Archived Tasks'),
          });
          sourceFinalized = true;
        } catch (error) {
          durableLifecycleFailed = true;
          lifecycleFailure = {
            outcome: error instanceof LifecycleTransferRecoveryError && error.phase !== 'prepared' ? 'source-conflict' : 'destination-failed',
            reason: error instanceof Error ? error.message : String(error),
            recovery: 'The transfer journal was retained. Restart or run diagnostics to reconcile it before retrying.',
          };
        }
      } else {
      let archiveSucceeded = false;
      try {
        if (pendingArchive.action === 'collect') {
          await this.collectTaskLine(archiveText, destinationPath);
        } else {
          await this.archiveTaskLine(archiveText, destinationPath);
        }
        archiveSucceeded = true;
      } catch (archiveErr) {
        durableLifecycleFailed = true;
        lifecycleFailure = {
          outcome: 'destination-failed',
          reason: `Could not write the completed task to ${destinationPath ?? 'the configured destination'}: ${archiveErr instanceof Error ? archiveErr.message : String(archiveErr)}`,
          recovery: 'The completed source block was retained. Fix the destination and retry after checking for an existing copy.',
        };
        console.error('Task Manager: post-completion archive/collect failed. Source removal and dependent completion side effects were skipped to avoid losing the task.', archiveErr);
      }

      if (archiveSucceeded) {
        try {
          await this.app.vault.process(file, (content) => {
            const lines = splitContentLines(content);
            const line = lines[sourceLineNumber - 1];
            if (!line || line.text !== sourceLine) return content;
            const currentTask = this.parseTaskLine(line.text, task.filePath, sourceLineNumber, task.heading);
            if (!currentTask || taskBlockToText(lines, sourceLineNumber - 1, currentTask) !== archiveText) return content;
            const parentIndent = currentTask.indentation.length + currentTask.linePrefix.length;
            let childEnd = sourceLineNumber;
            while (childEnd < lines.length) {
              const childLineText = lines[childEnd]?.text ?? '';
              const childIndent = childLineText.match(/^(?:\s*>\s*)*\s*/u)?.[0].length ?? 0;
              if (childIndent <= parentIndent) break;
              childEnd++;
            }
            lines.splice(sourceLineNumber - 1, childEnd - (sourceLineNumber - 1));
            sourceFinalized = true;
            return lines.map((part) => `${part.text}${part.lineEnding}`).join('');
          });
          if (!sourceFinalized) {
            durableLifecycleFailed = true;
            lifecycleFailure = {
              outcome: 'source-conflict',
              reason: 'The destination copy was written, but the source task changed before exact removal.',
              recovery: 'Review both copies and remove the duplicate manually after preserving the newer source edit.',
            };
            console.error('Task Manager: archived/collected task source changed before exact removal. Dependent completion side effects were skipped.');
          }
        } catch (removeErr) {
          durableLifecycleFailed = true;
          lifecycleFailure = {
            outcome: 'source-conflict',
            reason: `The destination copy was written, but source removal failed: ${removeErr instanceof Error ? removeErr.message : String(removeErr)}`,
            recovery: 'Review both copies and remove the retained source manually when safe.',
          };
          console.error('Task Manager: archived/collected task but could not remove it from the source file. Dependent completion side effects were skipped.', removeErr);
        }
      }
      }
    }

    const safeUpdatedTask = updatedTask;

    // Feature: parent auto-complete — check parent status after any relevant transition
    const finalTargetStatus = statusFromCheckbox(checkbox, this.getTaskStates());
    if (
      !durableLifecycleFailed
      && (this.getSettings().autoCompleteParent || this.getSettings().autoAdvanceParentToInProgress || this.getSettings().autoAdvanceParentOnAllCancelled)
    ) {
      await this.maybeAutoCompleteParent(file, safeUpdatedTask);
    }

    // #5: Workflow automation — when a task is marked done, check for workflow trigger tags.
    // A failed archive/collect must not run workflows against the intentionally retained block.
    if (!durableLifecycleFailed && finalTargetStatus === 'done' && this.getSettings().workflowsEnabled) {
      await this.triggerWorkflowAutomation(file, safeUpdatedTask);
    }

    // History: record status change
    if (this.historyTracker && task.status !== safeUpdatedTask.status) {
      this.historyTracker.recordChange({
        timestamp: new Date(),
        taskId: safeUpdatedTask.key,
        filePath: safeUpdatedTask.filePath,
        action: 'status_change',
        before: { status: task.status },
        after: { status: safeUpdatedTask.status },
        changedFields: { status: { oldValue: task.status, newValue: safeUpdatedTask.status } },
        source: 'manual',
      });
    }

    if (lifecycleFailure) {
      return incompleteTaskLifecycle(lifecycleFailure.outcome, safeUpdatedTask, lifecycleAction, lifecycleFailure.reason, lifecycleFailure.recovery, destinationPath);
    }
    return completedTaskLifecycle(safeUpdatedTask, lifecycleAction, destinationPath);
  }

  async updateTaskDate(file: TFile, task: ParsedTask, field: EditableTaskDateField, date: string | null): Promise<ParsedTask> {
    if (this.isFileBackedTaskNote(file, task)) {
      const updated = await this.updateTaskNoteDate(file, task, field, date);
      this.recordDateChange(task, updated, field);
      return updated;
    }
    let updatedTaskResult: ParsedTask | null = null;
    await this.app.vault.process(file, (content) => {
      const lines = splitContentLines(content);
      const located = resolveRenderedTaskLine(
        lines,
        task,
        (line, filePath, lineNumber, heading) => this.parseTaskLine(line, filePath, lineNumber, heading),
      );
      const updatedLine = rewriteEditableDateField(located.line.text, field, date, located.currentTask, this.getSettings().dateFormat === 'wikilink');
      located.line.text = updatedLine;
      updatedTaskResult = this.parseTaskLine(updatedLine, task.filePath, located.lineIndex + 1, task.heading);
      return lines.map((part) => `${part.text}${part.lineEnding}`).join('');
    });
    if (!updatedTaskResult) throw new Error('Task date update did not return an updated task');

    const updatedTask: ParsedTask = updatedTaskResult;
    this.recordDateChange(task, updatedTask, field);
    return updatedTask;
  }

  async updateTaskDates(file: TFile, tasks: readonly ParsedTask[], field: EditableTaskDateField, date: string | null): Promise<{ changed: number; updatedTasks: ParsedTask[] }> {
    if (tasks.length === 0) return { changed: 0, updatedTasks: [] };
    if (tasks.some((task) => this.isFileBackedTaskNote(file, task))) {
      if (tasks.length !== 1) throw new Error(`Cannot batch-update multiple file-backed tasks in ${file.path}`);
      const updated = await this.updateTaskDate(file, tasks[0], field, date);
      const previous = field === 'reminder' ? tasks[0].metadata.reminder : field === 'timeStart' ? tasks[0].metadata.timeStart : tasks[0].metadata.dates[field];
      const next = field === 'reminder' ? updated.metadata.reminder : field === 'timeStart' ? updated.metadata.timeStart : updated.metadata.dates[field];
      return { changed: previous === next ? 0 : 1, updatedTasks: [updated] };
    }

    let changed = 0;
    let updatedTasks: ParsedTask[] = [];
    await this.app.vault.process(file, (content) => {
      const result = mutateRenderedTaskLinesInContent(
        content,
        tasks.map((task) => ({
          task,
          rewrite: (line: string, currentTask: ParsedTask) => rewriteEditableDateField(line, field, date, currentTask, this.getSettings().dateFormat === 'wikilink'),
        })),
        (line, filePath, lineNumber, heading) => this.parseTaskLine(line, filePath, lineNumber, heading),
      );
      changed = result.changed;
      updatedTasks = result.updatedTasks;
      return result.content;
    });
    tasks.forEach((task, index) => this.recordDateChange(task, updatedTasks[index], field));
    return { changed, updatedTasks };
  }

  private recordDateChange(task: ParsedTask, updatedTask: ParsedTask, field: EditableTaskDateField): void {
    if (!this.historyTracker) return;
    const oldValue = field === 'reminder' ? task.metadata.reminder : field === 'timeStart' ? task.metadata.timeStart : task.metadata.dates[field];
    const newValue = field === 'reminder' ? updatedTask.metadata.reminder : field === 'timeStart' ? updatedTask.metadata.timeStart : updatedTask.metadata.dates[field];
    if (oldValue === newValue) return;
    this.historyTracker.recordChange({
      timestamp: new Date(),
      taskId: updatedTask.key,
      filePath: updatedTask.filePath,
      action: 'date_change',
      before: { [field]: oldValue },
      after: { [field]: newValue },
      changedFields: { [field]: { oldValue, newValue } },
      source: 'manual',
    });
  }

  async updateTaskPriority(file: TFile, task: ParsedTask, priority: string): Promise<ParsedTask> {
    if (this.isFileBackedTaskNote(file, task)) {
      const updated = await this.updateTaskNotePriority(file, task, priority);
      this.recordPriorityChange(task, updated);
      return updated;
    }
    let updatedTaskResult: ParsedTask | null = null;
    await this.app.vault.process(file, (content) => {
      const lines = splitContentLines(content);
      const located = resolveRenderedTaskLine(
        lines,
        task,
        (line, filePath, lineNumber, heading) => this.parseTaskLine(line, filePath, lineNumber, heading),
      );
      located.line.text = rewritePriorityField(located.line.text, priority);
      updatedTaskResult = this.parseTaskLine(located.line.text, task.filePath, located.lineIndex + 1, task.heading);
      return lines.map((part) => `${part.text}${part.lineEnding}`).join('');
    });
    if (!updatedTaskResult) throw new Error('Task priority update did not return an updated task');

    const updatedTask: ParsedTask = updatedTaskResult;

    this.recordPriorityChange(task, updatedTask);
    return updatedTask;
  }

  private recordPriorityChange(task: ParsedTask, updatedTask: ParsedTask): void {
    if (!this.historyTracker || task.metadata.priority === updatedTask.metadata.priority) return;
    this.historyTracker.recordChange({
      timestamp: new Date(),
      taskId: updatedTask.key,
      filePath: updatedTask.filePath,
      action: 'priority_change',
      before: { priority: task.metadata.priority },
      after: { priority: updatedTask.metadata.priority },
      changedFields: { priority: { oldValue: task.metadata.priority, newValue: updatedTask.metadata.priority } },
      source: 'manual',
    });
  }

  private isFileBackedTaskNote(file: TFile, task: ParsedTask): boolean {
    if (task.lineNumber !== 0) return false;
    const settings = this.getSettings();
    return isTaskNoteFileExt(file, this.app, settings.taskNoteFolders, settings.taskNoteMarker);
  }

  private async updateTaskNoteStatus(file: TFile, task: ParsedTask, _checkbox: string, status: TaskStatus): Promise<TaskLifecycleResult> {
    const settings = this.getSettings();
    const today = currentLocalDateString();
    let beforeTask: ParsedTask | null = null;
    let committedTask: ParsedTask | null = null;
    let blockedByCurrentContent: { action: TaskLifecycleAction; reason: string; recovery: string } | undefined;

    await this.app.vault.process(file, (content) => {
      const current = this.currentTaskNoteFromContent(file, task, content);
      if (current.status !== task.status) {
        throw new Error('Cannot update task note: status changed; refresh and retry');
      }
      beforeTask = current;
      const transitionToTerminal = current.status !== status && (status === 'done' || status === 'cancelled');
      const currentAction = current.metadata.onCompletion;
      if (transitionToTerminal && status === 'done'
        && (currentAction === 'delete' || currentAction === 'archive' || currentAction === 'collect' || currentAction === 'move-to-end')) {
        blockedByCurrentContent = {
          action: currentAction,
          reason: `File-backed task notes do not support automatic ${currentAction} lifecycle actions.`,
          recovery: 'Change or remove the onCompletion frontmatter value, or move/archive the file explicitly; the task note was not changed.',
        };
        return content;
      }
      if (transitionToTerminal && (current.metadata.recurrence || current.metadata.recurrenceRaw)) {
        blockedByCurrentContent = {
          action: 'recurrence',
          reason: 'Recurring file-backed task notes cannot be completed automatically without a defined whole-file recurrence protocol.',
          recovery: 'Use a line-backed recurring task or remove recurrence before changing this task-note status; the task note was not changed.',
        };
        return content;
      }

      const updates: Record<string, unknown> = { status };
      if (current.status === 'done' && status !== 'done' && settings.setDoneDate) updates.done = null;
      if (current.status === 'cancelled' && status !== 'cancelled' && settings.setCancelledDate) updates.cancelled = null;
      if (status === 'done' && current.status !== 'done' && settings.setDoneDate) updates.done = today;
      if (status === 'cancelled' && current.status !== 'cancelled' && settings.setCancelledDate) updates.cancelled = today;

      const nextContent = rewriteTaskNoteFrontmatter(content, updates);
      committedTask = this.currentTaskNoteFromContent(file, current, nextContent);
      return nextContent;
    });

    const inspected = beforeTask as ParsedTask | null;
    const committed = committedTask as ParsedTask | null;
    if (!inspected) throw new Error('Task-note status update did not inspect current content');
    if (blockedByCurrentContent) {
      return incompleteTaskLifecycle('blocked', inspected, blockedByCurrentContent.action, blockedByCurrentContent.reason, blockedByCurrentContent.recovery);
    }
    if (!committed) throw new Error('Task-note status update did not return the committed task');

    // Parent indentation and line-insertion workflows have no safe meaning for a
    // synthetic line-0 task note. Status history is recorded from exact committed state.
    if (this.historyTracker && inspected.status !== committed.status) {
      this.historyTracker.recordChange({
        timestamp: new Date(),
        taskId: committed.key,
        filePath: committed.filePath,
        action: 'status_change',
        before: { status: inspected.status },
        after: { status: committed.status },
        changedFields: { status: { oldValue: inspected.status, newValue: committed.status } },
        source: 'manual',
      });
    }
    return completedTaskLifecycle(committed, 'status');
  }

  private async updateTaskNoteDate(file: TFile, task: ParsedTask, field: EditableTaskDateField, date: string | null): Promise<ParsedTask> {
    const expectedValue = this.taskNoteDateValue(task, field);
    const frontmatterKey = field === 'timeStart' ? 'time' : field;
    const { committed } = await this.processTaskNoteMutation(
      file,
      task,
      (current) => {
        if (this.taskNoteDateValue(current, field) !== expectedValue) {
          throw new Error(`Cannot update task note: ${field} changed; refresh and retry`);
        }
      },
      () => ({ [frontmatterKey]: date }),
    );
    return committed;
  }

  private async updateTaskNotePriority(file: TFile, task: ParsedTask, priority: string): Promise<ParsedTask> {
    const { committed } = await this.processTaskNoteMutation(
      file,
      task,
      (current) => {
        if (current.metadata.priority !== task.metadata.priority) {
          throw new Error('Cannot update task note: priority changed; refresh and retry');
        }
      },
      () => ({ priority }),
    );
    return committed;
  }

  private async processTaskNoteMutation(
    file: TFile,
    expected: ParsedTask,
    compare: (current: ParsedTask) => void,
    updates: (current: ParsedTask) => Record<string, unknown>,
  ): Promise<{ before: ParsedTask; committed: ParsedTask }> {
    let beforeTask: ParsedTask | null = null;
    let committedTask: ParsedTask | null = null;
    await this.app.vault.process(file, (content) => {
      const current = this.currentTaskNoteFromContent(file, expected, content);
      compare(current);
      const nextContent = rewriteTaskNoteFrontmatter(content, updates(current));
      const committed = this.currentTaskNoteFromContent(file, current, nextContent);
      beforeTask = current;
      committedTask = committed;
      return nextContent;
    });
    if (!beforeTask || !committedTask) throw new Error('Task-note mutation did not return committed state');
    return { before: beforeTask, committed: committedTask };
  }

  private currentTaskNoteFromContent(file: TFile, expected: ParsedTask, content: string): ParsedTask {
    const settings = this.getSettings();
    if (expected.lineNumber !== 0 || expected.filePath !== file.path) {
      throw new Error('Cannot update task note: source identity changed; refresh and retry');
    }
    if (!isTaskNoteFileExt(file, this.app, settings.taskNoteFolders, settings.taskNoteMarker, content)) {
      throw new Error('Cannot update task note: file is no longer a task note; refresh and retry');
    }
    const current = scanTaskNoteFromContent(file, this.app, this.getTaskStates(), settings.customFieldDefinitions, content);
    if (!current || current.lineNumber !== 0 || current.filePath !== expected.filePath) {
      throw new Error('Cannot update task note: current frontmatter is invalid; refresh and retry');
    }
    const expectedId = expected.metadata.id?.trim() || undefined;
    const currentId = current.metadata.id?.trim() || undefined;
    if (expectedId !== currentId) {
      throw new Error('Cannot update task note: logical identity changed; refresh and retry');
    }
    return current;
  }

  private taskNoteDateValue(task: ParsedTask, field: EditableTaskDateField): string | undefined {
    if (field === 'reminder') return task.metadata.reminder;
    if (field === 'timeStart') return task.metadata.time;
    return task.metadata.dates[field];
  }

  /**
   * After a task status changes, check if its parent task should be auto-advanced.
   * Rule 1 (autoCompleteParent): all children done/cancelled → parent done
   * Rule 2 (autoAdvanceParentToInProgress): any child in-progress/done → parent todo → in_progress
   * Rule 3 (autoAdvanceParentOnAllCancelled): all children cancelled → parent cancelled
   * Uses `autoCompleteInFlight` to guard against infinite recursion.
   */
  private async maybeAutoCompleteParent(file: TFile, changedTask: ParsedTask): Promise<void> {
    const settings = this.getSettings();
    if (!settings.autoCompleteParent && !settings.autoAdvanceParentToInProgress && !settings.autoAdvanceParentOnAllCancelled) return;
    if (this.autoCompleteInFlight.has(changedTask.key)) return;

    const content = await this.app.vault.read(file);
    const lines = splitContentLines(content);

    // Resolve the current task's effective indentation, including blockquote prefixes.
    const taskLineText = lines[changedTask.lineNumber - 1]?.text;
    if (!taskLineText) return;
    const currentIndent = taskLineDepth(taskLineText);

    // Walk upward to find the nearest task line with strictly less indentation
    let parentLineIndex = -1;
    let parentTask: ParsedTask | null = null;
    for (let i = changedTask.lineNumber - 2; i >= 0; i--) {
      const lineText = lines[i]?.text ?? '';
      const lineIndent = taskLineDepth(lineText);
      if (lineIndent < currentIndent) {
        const parsed = this.parseTaskLine(lineText, file.path, i + 1);
        if (parsed) {
          parentLineIndex = i;
          parentTask = parsed;
          break;
        }
      }
    }
    if (!parentTask || parentLineIndex < 0) return;
    // If parent is already done/cancelled, nothing to do unless we need to cancel it
    if (parentTask.status === 'done' || parentTask.status === 'cancelled') return;

    const parentIndent = taskLineDepth(lines[parentLineIndex]?.text ?? '');

    // Collect all direct-child task statuses at the same indentation as the changed task
    const childStatuses: Array<ParsedTask['status']> = [];
    for (let i = parentLineIndex + 1; i < lines.length; i++) {
      const lineText = lines[i]?.text ?? '';
      const lineIndent = taskLineDepth(lineText);
      // Stop when we hit a non-empty line at or above the parent's indentation
      if (lineIndent <= parentIndent && lineText.trim().length > 0) break;
      // Only consider tasks at the same depth as the changed task
      if (lineIndent !== currentIndent) continue;
      const sibling = this.parseTaskLine(lineText, file.path, i + 1);
      if (sibling) childStatuses.push(sibling.status);
    }

    if (childStatuses.length === 0) return;

    const allDoneOrCancelled = childStatuses.every((s) => s === 'done' || s === 'cancelled');
    const allCancelled = childStatuses.every((s) => s === 'cancelled');
    const anyInProgressOrDone = childStatuses.some((s) => s === 'in_progress' || s === 'done');

    let targetCheckbox: string | null = null;

    // Rule 1: all done/cancelled (but not all cancelled) → parent done
    if (settings.autoCompleteParent && allDoneOrCancelled && !allCancelled) {
      targetCheckbox = checkboxForStatus('done', this.getTaskStates());
    }
    // Rule 3: all cancelled → parent cancelled (evaluated after Rule 1 so it takes priority over Rule 1)
    if (settings.autoAdvanceParentOnAllCancelled && allCancelled) {
      targetCheckbox = checkboxForStatus('cancelled', this.getTaskStates());
    }
    // Rule 2: any child in-progress/done → parent todo → in_progress (only if not already advancing)
    if (!targetCheckbox && settings.autoAdvanceParentToInProgress && anyInProgressOrDone && parentTask.status === 'todo') {
      targetCheckbox = checkboxForStatus('in_progress', this.getTaskStates());
    }

    if (!targetCheckbox) return;

    // Guard using changedTask.key (not parentTask.key) so the cycle check blocks the
    // *same child task* from re-triggering, while still allowing the cascade to
    // propagate upward to grandparents.  Adding parentTask.key instead would cause
    // maybeAutoCompleteParent(parentTask) to see its own key in the set and abort,
    // silently preventing auto-complete from propagating beyond one level.
    this.autoCompleteInFlight.add(changedTask.key);
    try {
      await this.updateTaskCheckbox(file, parentTask, targetCheckbox);
    } finally {
      this.autoCompleteInFlight.delete(changedTask.key);
    }
  }

  private async completeRecurringTask(
    file: TFile,
    task: ParsedTask,
    doneCheckbox: string,
    completionStatus: TaskStatus = 'done',
    destinationPath?: string,
  ): Promise<TaskLifecycleResult> {
    let updatedTask: ParsedTask | null = null;
    let completedSourceTask: ParsedTask | null = null;
    let archivedLine: DeferredRecurringArchiveLine | null = null;
    let sourceLineNumberForSideEffects = task.lineNumber;
    let statusAlreadyInTargetCompletionStatus = false;
    const requestedAction = completionStatus === 'done' ? task.metadata.onCompletion : undefined;
    const lifecycleAction: TaskLifecycleAction = requestedAction === 'archive' || requestedAction === 'collect'
      || requestedAction === 'delete' || requestedAction === 'move-to-end' ? requestedAction : 'recurrence';
    let lifecycleFailure: { outcome: 'destination-failed' | 'source-conflict'; reason: string; recovery: string } | undefined;

    const stateStore = this.getStateStore?.();
    const recurrenceExceptionSeriesId = recurrenceSeriesIdForTask(task);
    let recurrenceExceptionState: PersistedState | null = null;
    if (stateStore) {
      recurrenceExceptionState = await stateStore.loadState();
    }
    // The inline `for N times` countdown is the sole generation stop authority.
    // Persisted counts are monotonic analytics/recovery evidence and must not be
    // compared with the already-decremented remaining count on the current task.
    // Commit the absolute count only after vault.process succeeds.
    const shouldIncrementRecurrenceCount = Boolean(
      stateStore
      && this.getSettings().trackRecurrenceCount
      && task.metadata.recurrenceLimit !== undefined,
    );

    try {
      await this.app.vault.process(file, (content) => {
      const validated = updateMarkdownTaskCheckboxInContent(
        content,
        task,
        doneCheckbox,
        this.getTaskStates(),
        { allowStaleStatus: true, allowLifecycleDateMismatch: true },
      );
      const currentTask = validated.previousTask;
      const currentRequestedAction = completionStatus === 'done' ? currentTask.metadata.onCompletion : undefined;
      const recurrenceChanged = currentTask.metadata.recurrenceRaw !== task.metadata.recurrenceRaw
        || currentTask.metadata.recurrence !== task.metadata.recurrence;
      if (currentRequestedAction !== requestedAction || recurrenceChanged) {
        const action: TaskLifecycleAction = currentRequestedAction === 'archive' || currentRequestedAction === 'collect'
          || currentRequestedAction === 'delete' || currentRequestedAction === 'move-to-end' ? currentRequestedAction : 'recurrence';
        throw new TaskLifecyclePreflightError('Task lifecycle metadata changed before the recurring status update.', action);
      }
      const sourceLineNumber = validated.updatedTask.lineNumber;
      sourceLineNumberForSideEffects = sourceLineNumber;
      const lines = splitContentLines(validated.content);
      const validatedLine = lines[sourceLineNumber - 1];
      if (!validatedLine) throw new Error(`Cannot update task: line ${sourceLineNumber} no longer exists`);

      const today = currentLocalDateString();
      const durableRecurrenceCount = this.getSettings().trackRecurrenceCount
        ? Math.max(currentTask.metadata.recurrenceCount ?? 0, stateStore && recurrenceExceptionState ? stateStore.getRecurrenceCount(recurrenceExceptionState, task.key) : 0) + 1
        : null;
      let completedLine = applyAutomaticStatusDates(validatedLine.text, currentTask.status, completionStatus, today, this.getSettings());
      if (durableRecurrenceCount !== null) completedLine = writeDurableRecurrenceCount(completedLine, durableRecurrenceCount);
      validatedLine.text = completedLine;
      completedSourceTask = this.parseTaskLine(completedLine, task.filePath, sourceLineNumber, task.heading);
      updatedTask = completedSourceTask;

      const futureCount = Math.max(0, Math.floor(this.getSettings().recurrenceFutureOccurrences));

      // Same-target replay is idempotent. Finite-series generation is otherwise
      // controlled only by the inline `for N times` countdown.
      statusAlreadyInTargetCompletionStatus = currentTask.status === completionStatus;
      const skipRecurrence = statusAlreadyInTargetCompletionStatus;

      let rawNextLines = skipRecurrence ? [] : buildNextRecurrenceLines(completedLine, currentTask, this.getTaskStates(), this.getSettings(), today, futureCount);
      if (durableRecurrenceCount !== null && rawNextLines.length > 0) {
        rawNextLines = rawNextLines.map((line) => writeDurableRecurrenceCount(line, durableRecurrenceCount));
      }
      const filteredNextLines = recurrenceExceptionSeriesId && stateStore && recurrenceExceptionState
        ? rawNextLines.filter((nextLine) => {
          const nextTask = this.parseTaskLine(nextLine, task.filePath, sourceLineNumber, task.heading);
          const occurrenceDate = recurrenceOccurrenceDate(nextTask);
          return !occurrenceDate || !stateStore.hasRecurrenceException(recurrenceExceptionState, recurrenceExceptionSeriesId, occurrenceDate, ['skipped', 'deleted']);
        })
        : rawNextLines;
      const nextLines = filterExistingRecurrenceLines(filteredNextLines, lines);
      const sourceLineEnding = validatedLine.lineEnding || '\n';
      const nextLineParts = nextLines.map((text) => ({ text, lineEnding: sourceLineEnding }));
      const onCompletion = completionStatus === 'done' ? currentTask.metadata.onCompletion : undefined;
      if (onCompletion === 'delete' || onCompletion === 'archive' || onCompletion === 'collect' || onCompletion === 'move-to-end') {
        if (onCompletion === 'archive' || onCompletion === 'collect') {
          // Defer source replacement/removal until after the archive/collect write
          // succeeds. A failed destination write leaves the completed source line
          // recoverable instead of removing it first.
          archivedLine = {
            action: onCompletion,
            sourceLine: completedLine,
            sourceLineNumber,
            archiveText: taskBlockToText(lines, sourceLineNumber - 1, currentTask),
            nextLineParts,
          };
          if (nextLines[0]) updatedTask = this.parseTaskLine(nextLines[0], task.filePath, sourceLineNumber, task.heading);
        } else if (onCompletion === 'move-to-end') {
          if (nextLineParts.length > 0) {
            // Replace current task with next occurrence, then append completed line at section end.
            lines.splice(sourceLineNumber - 1, 1, ...nextLineParts);
            if (nextLines[0]) updatedTask = this.parseTaskLine(nextLines[0], task.filePath, sourceLineNumber, task.heading);
            // Insert completed line at end of the section (reference position: after inserted next lines).
            const refIndex = sourceLineNumber - 1 + nextLineParts.length;
            insertAtSectionEnd(lines, { text: completedLine, lineEnding: sourceLineEnding }, refIndex);
          } else {
            // No next occurrence — just move completed task block to section end.
            moveTaskBlockToSectionEnd(lines, sourceLineNumber - 1, currentTask);
          }
        } else {
          if (nextLineParts.length === 0) {
            // Last occurrence (limit reached or invalid recurrence) — remove the task AND
            // its children to match updateTaskCheckbox's onCompletion behaviour, which
            // also strips child items to avoid orphaned list bullets.
            const parentIndent = currentTask.indentation.length + currentTask.linePrefix.length;
            let childEnd = sourceLineNumber; // 1-based; lines[sourceLineNumber-1] is the task
            while (childEnd < lines.length) {
              const childIndent = (lines[childEnd]?.text ?? '').match(/^(?:\s*>\s*)*\s*/u)?.[0].length ?? 0;
              if (childIndent <= parentIndent) break;
              childEnd++;
            }
            lines.splice(sourceLineNumber - 1, childEnd - (sourceLineNumber - 1));
          } else {
            lines.splice(sourceLineNumber - 1, 1, ...nextLineParts);
            if (nextLines[0]) updatedTask = this.parseTaskLine(nextLines[0], task.filePath, sourceLineNumber, task.heading);
          }
        }
      } else if (nextLines.length > 0) {
        const insertIndex = this.getSettings().recurrenceInsertLocation === 'after' ? sourceLineNumber : sourceLineNumber - 1;
        lines.splice(insertIndex, 0, ...nextLineParts);
      }
      return lines.map((part) => `${part.text}${part.lineEnding}`).join('');
      });
    } catch (error) {
      if (error instanceof TaskLifecyclePreflightError) {
        return incompleteTaskLifecycle('blocked', task, error.action, error.message, 'Refresh the task and retry; no task content was changed.', error.destinationPath);
      }
      throw error;
    }

    let archiveSideEffectsSucceeded = true;
    let recurrenceCommittedByTransfer = false;
    const pendingArchive = archivedLine as DeferredRecurringArchiveLine | null;
    if (pendingArchive !== null) {
      const sourceLine = pendingArchive.sourceLine;
      const archiveText = pendingArchive.archiveText;
      const nextLineParts = pendingArchive.nextLineParts;
      if (stateStore && destinationPath) {
        const children = archiveText.split('\n').slice(1);
        const replacement = [...nextLineParts.map((part) => part.text), ...children].join('\n');
        const occurrenceDate = task.metadata.dates.done ?? task.metadata.dates.due ?? task.metadata.dates.scheduled ?? task.metadata.dates.start ?? currentLocalDateString();
        try {
          await new TaskLifecycleTransferService(this.app, stateStore).transfer({
            action: pendingArchive.action,
            sourceFile: file,
            sourcePath: file.path,
            sourceLine: sourceLineNumberForSideEffects,
            sourceIdentity: task.key,
            sourceBlock: archiveText,
            sourceReplacement: replacement,
            targetPath: destinationPath,
            targetHeading: pendingArchive.action === 'collect'
              ? (this.getSettings().collectHeading?.trim() || 'Collected Tasks')
              : (this.getSettings().archiveHeading.trim() || 'Archived Tasks'),
            recurrenceCommit: {
              taskKey: task.key,
              incrementCount: shouldIncrementRecurrenceCount,
              seriesId: recurrenceExceptionSeriesId,
              date: occurrenceDate.slice(0, 10),
            },
          });
          recurrenceCommittedByTransfer = true;
        } catch (error) {
          archiveSideEffectsSucceeded = false;
          lifecycleFailure = {
            outcome: error instanceof LifecycleTransferRecoveryError && error.phase !== 'prepared' ? 'source-conflict' : 'destination-failed',
            reason: error instanceof Error ? error.message : String(error),
            recovery: 'The recurring transfer journal was retained. Restart or run diagnostics to reconcile it before retrying.',
          };
        }
      } else {
      try {
        if (pendingArchive.action === 'collect') {
          await this.collectTaskLine(archiveText, destinationPath);
        } else {
          await this.archiveTaskLine(archiveText, destinationPath);
        }
      } catch (archiveErr) {
        archiveSideEffectsSucceeded = false;
        lifecycleFailure = {
          outcome: 'destination-failed',
          reason: `Could not write the recurring occurrence to ${destinationPath ?? 'the configured destination'}: ${archiveErr instanceof Error ? archiveErr.message : String(archiveErr)}`,
          recovery: 'The completed source occurrence was retained and recurrence state was not advanced. Fix the destination and retry after checking for an existing copy.',
        };
        console.error('Task Manager: post-recurrence archive/collect failed. Source replacement/removal was skipped to avoid losing the task.', archiveErr);
      }

      if (archiveSideEffectsSucceeded) {
        try {
          let sourceUpdated = false;
          await this.app.vault.process(file, (content) => {
            const lines = splitContentLines(content);
            const line = lines[sourceLineNumberForSideEffects - 1];
            if (!line || line.text !== sourceLine) return content;
            const currentTask = this.parseTaskLine(line.text, task.filePath, sourceLineNumberForSideEffects, task.heading);
            if (!currentTask) return content;
            if (nextLineParts.length === 0) {
              if (taskBlockToText(lines, sourceLineNumberForSideEffects - 1, currentTask) !== archiveText) return content;
              const parentIndent = currentTask.indentation.length + currentTask.linePrefix.length;
              let childEnd = sourceLineNumberForSideEffects;
              while (childEnd < lines.length) {
                const childIndent = (lines[childEnd]?.text ?? '').match(/^(?:\s*>\s*)*\s*/u)?.[0].length ?? 0;
                if (childIndent <= parentIndent) break;
                childEnd++;
              }
              lines.splice(sourceLineNumberForSideEffects - 1, childEnd - (sourceLineNumberForSideEffects - 1));
            } else {
              lines.splice(sourceLineNumberForSideEffects - 1, 1, ...nextLineParts);
            }
            sourceUpdated = true;
            return lines.map((part) => `${part.text}${part.lineEnding}`).join('');
          });
          if (!sourceUpdated) {
            archiveSideEffectsSucceeded = false;
            lifecycleFailure = {
              outcome: 'source-conflict',
              reason: 'The recurring destination copy was written, but the source occurrence changed before exact replacement.',
              recovery: 'Review the retained source and destination copies, then reconcile the next occurrence manually.',
            };
          }
        } catch (removeErr) {
          archiveSideEffectsSucceeded = false;
          lifecycleFailure = {
            outcome: 'source-conflict',
            reason: `The recurring destination copy was written, but source replacement failed: ${removeErr instanceof Error ? removeErr.message : String(removeErr)}`,
            recovery: 'Review the retained source and destination copies, then reconcile the next occurrence manually.',
          };
          console.error('Task Manager: archived/collected recurring task but could not update the source occurrence.', removeErr);
        }
      }
      }
    }

    // vault.process and any archive/collect side effects/source updates succeeded — now safe to persist the incremented recurrence count.
    if (stateStore && !recurrenceCommittedByTransfer && archiveSideEffectsSucceeded && !statusAlreadyInTargetCompletionStatus
      && (shouldIncrementRecurrenceCount || task.metadata.recurrence || task.metadata.recurrenceRaw)) {
      const occurrenceDate = task.metadata.dates.done ?? task.metadata.dates.due ?? task.metadata.dates.scheduled ?? task.metadata.dates.start ?? currentLocalDateString();
      await recurrenceStateRepository(stateStore).update((current) => commitRecurrenceOccurrence(
        current,
        { seriesId: recurrenceExceptionSeriesId, date: occurrenceDate.slice(0, 10), taskKey: task.key },
        shouldIncrementRecurrenceCount ? task.key : undefined,
      ));
    }

    if (!archiveSideEffectsSucceeded && completedSourceTask) {
      updatedTask = completedSourceTask;
    }

    if (!updatedTask) {
      throw new Error('Recurring task update did not return an updated task');
    }

    // History: record recurrence spawn and status change after archive/collect side effects succeed.
    if (this.historyTracker && archiveSideEffectsSucceeded && !statusAlreadyInTargetCompletionStatus) {
      this.historyTracker.recordChange({
        timestamp: new Date(),
        taskId: task.key,
        filePath: task.filePath,
        action: 'recurrence_spawn',
        before: { status: task.status },
        after: { status: completionStatus },
        changedFields: { status: { oldValue: task.status, newValue: completionStatus } },
        source: 'recurrence',
      });
    }

    if (lifecycleFailure) {
      return incompleteTaskLifecycle(lifecycleFailure.outcome, updatedTask, lifecycleAction, lifecycleFailure.reason, lifecycleFailure.recovery, destinationPath);
    }
    return completedTaskLifecycle(updatedTask, lifecycleAction, destinationPath);
  }

  private archiveDestinationPath(): string {
    const rawPath = this.getSettings().archiveFilePath.trim() || 'Archive.md';
    return normalizeVaultRelativePath(rawPath.endsWith('.md') ? rawPath : `${rawPath}.md`, 'Archive file path');
  }

  private collectDestinationPath(): string {
    const rawPath = this.getSettings().collectFilePath?.trim() || 'Completed.md';
    return normalizeVaultRelativePath(rawPath.endsWith('.md') ? rawPath : `${rawPath}.md`, 'Collect file path');
  }

  private async archiveTaskLine(completedLine: string, archivePath = this.archiveDestinationPath()): Promise<void> {
    const heading = this.getSettings().archiveHeading.trim() || 'Archived Tasks';
    await ensureParentFolders(this.app, archivePath);
    const existingFile = this.app.vault.getAbstractFileByPath(archivePath);
    if (existingFile && isVaultTFile(existingFile)) {
      await this.app.vault.process(existingFile, (content) =>
        appendLineToSection(content, heading, completedLine),
      );
    } else {
      const content = `## ${heading}\n${completedLine}\n`;
      try {
        await this.app.vault.create(archivePath, content);
      } catch (error) {
        // File may have been created by a concurrent call; retry as append.
        const retryFile = this.app.vault.getAbstractFileByPath(archivePath);
        if (retryFile && isVaultTFile(retryFile)) {
          await this.app.vault.process(retryFile, (c) =>
            appendLineToSection(c, heading, completedLine),
          );
        } else {
          throw error;
        }
      }
    }
  }

  /** Append a completed task line to the configured collect file (🏁 collect action). */
  private async collectTaskLine(completedLine: string, collectPath = this.collectDestinationPath()): Promise<void> {
    const heading = this.getSettings().collectHeading?.trim() || 'Collected Tasks';
    await ensureParentFolders(this.app, collectPath);
    const existingFile = this.app.vault.getAbstractFileByPath(collectPath);
    if (existingFile && isVaultTFile(existingFile)) {
      await this.app.vault.process(existingFile, (content) =>
        appendLineToSection(content, heading, completedLine),
      );
    } else {
      const content = `## ${heading}\n${completedLine}\n`;
      try {
        await this.app.vault.create(collectPath, content);
      } catch (error) {
        const retryFile = this.app.vault.getAbstractFileByPath(collectPath);
        if (retryFile && isVaultTFile(retryFile)) {
          await this.app.vault.process(retryFile, (c) =>
            appendLineToSection(c, heading, completedLine),
          );
        } else {
          throw error;
        }
      }
    }
  }

  private applyImpliedMetadata(task: ParsedTask): ParsedTask {
    const settings = this.getSettings();
    if (!settings.useFilenameAsScheduledDate || task.metadata.dates.due || task.metadata.dates.scheduled || task.metadata.dates.start) {
      return task;
    }
    if (!isPathInFilenameDateFolders(task.filePath, settings.filenameScheduledDateFolders)) {
      return task;
    }
    const scheduled = filenameScheduledDate(task.filePath, settings.filenameScheduledDateFormat);
    return scheduled ? { ...task, metadata: { ...task.metadata, dates: { ...task.metadata.dates, scheduled } } } : task;
  }

  private assignDuplicateOccurrenceKeys(tasks: ParsedTask[]): ParsedTask[] {
    const totals = new Map<string, number>();
    for (const task of tasks) {
      totals.set(task.key, (totals.get(task.key) ?? 0) + 1);
    }

    const seen = new Map<string, number>();
    return tasks.map((task) => {
      if ((totals.get(task.key) ?? 0) <= 1) {
        return task;
      }

      const occurrence = (seen.get(task.key) ?? 0) + 1;
      seen.set(task.key, occurrence);
      return { ...task, key: `${task.key}\u0000${occurrence}` };
    });
  }

  // ── #1: File-scoped YAML frontmatter task defaults ────────────────────────────────────

  /**
   * Resolve template tokens in a string value, replacing {{token}} with corresponding values.
   * Supported tokens:
   *   {{date}} - Current date in YYYY-MM-DD format
   *   {{filename}} - Filename without extension
   *   {{folder}} - Parent folder name
   *   {{path}} - Full file path
   */
  private resolveFileDefaultTokens(value: string, file: TFile): string {
    let result = value;
    // {{date}}
    const today = currentLocalDateString();
    result = result.replace(/\{\{date\}\}/gu, today);
    // {{filename}} - basename without extension
    const filename = file.basename;
    result = result.replace(/\{\{filename\}\}/gu, filename);
    // {{folder}} - parent folder name
    const folder = file.parent?.name || 'root';
    result = result.replace(/\{\{folder\}\}/gu, folder);
    // {{path}} - full file path
    result = result.replace(/\{\{path\}\}/gu, file.path);
    return result;
  }

  /**
   * Apply YAML frontmatter defaults to a task that was parsed from `file`.
   * Only fields that are absent on the task (i.e. not explicitly written in the task line) are filled.
   * Prefix is configurable (default `task_`).
   *
   * Supported properties:
   *   task_due       — ISO date or relative date (`today`, `tomorrow`, `this friday`); supports template tokens
   *   task_scheduled — same as above for scheduled date
   *   task_priority  — `highest` | `high` | `medium` | `normal` | `low` | `lowest`
   *   task_tags      — string or array; merged into the task's tag list; supports template tokens
   *   task_context   — string or array; merged into the task's contexts list; supports template tokens
   *
   * Template tokens supported: {{date}}, {{filename}}, {{folder}}, {{path}}
   */
  private applyFileDefaults(task: ParsedTask, frontmatter: Record<string, unknown>, file: TFile): ParsedTask {
    const prefix = this.getSettings().fileDefaultsPropertyPrefix || 'task_';
    let changed = false;
    let dates = { ...task.metadata.dates };
    let priority = task.metadata.priority;
    let tags = [...task.tags];
    let contexts = [...task.contexts];
    let customFields = task.metadata.customFields;

    // Due date
    if (!dates.due) {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      const raw = String(frontmatter[`${prefix}due`] ?? '').trim();
      const resolved = raw ? resolveRelativeDateString(this.resolveFileDefaultTokens(raw, file)) : undefined;
      if (resolved) { dates = { ...dates, due: resolved }; changed = true; }
    }

    // Scheduled date
    if (!dates.scheduled) {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      const raw = String(frontmatter[`${prefix}scheduled`] ?? '').trim();
      const resolved = raw ? resolveRelativeDateString(this.resolveFileDefaultTokens(raw, file)) : undefined;
      if (resolved) { dates = { ...dates, scheduled: resolved }; changed = true; }
    }

    // Priority (only override if task has no explicit priority, i.e. it is 'normal')
    if (priority === 'normal') {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      const raw = String(frontmatter[`${prefix}priority`] ?? '').trim().toLowerCase();
      const p = (['highest', 'high', 'medium', 'normal', 'low', 'lowest'] as const).find((v) => v === raw);
      if (p && p !== 'normal') { priority = p; changed = true; }
    }

    // Tags
    const rawTags = frontmatter[`${prefix}tags`];
    if (rawTags) {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      const extras = (Array.isArray(rawTags) ? rawTags.map(String) : String(rawTags).split(/[,\s]+/u))
        .map((t) => this.resolveFileDefaultTokens(t.startsWith('#') ? t.slice(1) : t, file))
        .map((t) => t.startsWith('#') ? t.slice(1) : t)
        .filter(Boolean);
      const merged = Array.from(new Set([...tags, ...extras]));
      if (merged.length !== tags.length) { tags = merged; changed = true; }
    }

    // Custom fields
    const customFieldDefinitions = this.getSettings().customFieldDefinitions;
    if (customFieldDefinitions.length > 0) {
      const frontmatterFields = parseCustomFieldsFromFrontmatter(frontmatter, customFieldDefinitions);
      const mergedCustomFields = mergeCustomFields(customFields ?? {}, frontmatterFields, customFieldDefinitions);
      if (Object.keys(mergedCustomFields).length > 0 && mergedCustomFields !== customFields) {
        customFields = mergedCustomFields;
        changed = true;
      }
    }

    // Contexts
    const rawContexts = frontmatter[`${prefix}context`] ?? frontmatter[`${prefix}contexts`];
    if (rawContexts) {
      // eslint-disable-next-line @typescript-eslint/no-base-to-string
      const extras = (Array.isArray(rawContexts) ? rawContexts.map(String) : String(rawContexts).split(/[,\s]+/u))
        .map((t) => this.resolveFileDefaultTokens(t, file))
        .filter(Boolean);
      const merged = Array.from(new Set([...contexts, ...extras]));
      if (merged.length !== contexts.length) { contexts = merged; changed = true; }
    }

    if (!changed) return task;
    return { ...task, tags, contexts, metadata: { ...task.metadata, dates, priority, customFields } };
  }

  // ── #5: Workflow automation ───────────────────────────────────────────────

  /**
   * When a task is marked done, check whether any configured workflow's `triggerTag` appears
   * in the task's tag list.  If so, append the first workflow step as a new task on the line
   * immediately after the completed task.
   */
  private async triggerWorkflowAutomation(file: TFile, completedTask: ParsedTask): Promise<void> {
    const { workflowsEnabled, workflows } = this.getSettings();
    if (!workflowsEnabled || !workflows.length) return;

    const taskTags = completedTask.tags.map((t) => t.replace(/^#/u, '').toLowerCase());

    for (const workflow of workflows) {
      const trigger = workflow.triggerTag.replace(/^#/u, '').toLowerCase();
      if (!trigger || !taskTags.includes(trigger)) continue;
      if (!workflow.steps.length) continue;

      const step = workflow.steps[0];

      // Use a function replacement so that task text containing `$&`, `$'`, `$\`` etc.
      // is not interpreted as a special replacement pattern by String.prototype.replace.
      const desc = step.description.replace(/\{\{prev\}\}/gu, () => completedTask.normalizedText);

      const priorityEmoji: Record<string, string> = {
        highest: '\uD83D\uDD3A', high: '\u23EB', medium: '\uD83D\uDD3C', low: '\uD83D\uDD3D', lowest: '\u23EC',
      };
      const prioEmoji = step.priority ? (priorityEmoji[step.priority.toLowerCase()] ?? '') : '';

      const statusSymbol = step.status || ' ';
      const newLine = `${completedTask.indentation}${completedTask.listMarker} [${statusSymbol}] ${desc}${prioEmoji ? ` ${prioEmoji}` : ''} #${trigger}`;

      // Validate the produced line is a parseable task before writing it to the
      // vault.  If the completed task's normalizedText contains characters such as
      // `]` that could break the checkbox syntax, the parse will fail and we skip
      // the step to avoid writing malformed markdown.
      const probeTask = parseMarkdownTaskLine(newLine, file.path, completedTask.lineNumber + 1, this.getTaskStates());
      if (!probeTask) {
        console.warn('[task-manager] Workflow step produced an invalid task line; skipping insertion.', { workflow: workflow.name, newLine });
        return;
      }

      let identityFailure = '';
      await this.app.vault.process(file, (content) => {
        const lines = splitContentLines(content);
        try {
          const located = resolveRenderedTaskLine(lines, completedTask, (line, filePath, lineNumber, heading) => this.parseTaskLine(line, filePath, lineNumber, heading));
          const insertAt = located.lineIndex + 1;
          const eol = located.line.lineEnding || '\n';
          lines.splice(insertAt, 0, { text: newLine, lineEnding: eol });
          return lines.map((line) => `${line.text}${line.lineEnding}`).join('');
        } catch (error) {
          identityFailure = error instanceof Error ? error.message : String(error);
          return content;
        }
      });
      if (identityFailure) console.warn('[task-manager] Workflow insertion skipped because the completed task could not be resolved uniquely.', { workflow: workflow.name, reason: identityFailure });
      return;
    }
  }

  private stripTasksPluginMetadata(text: string): string {
    return stripTaskMetadata(text);
  }

  private normalizeTaskText(text: string): string {
    return normalizeTaskText(text);
  }
}

interface ScanSkipState {
  inCodeFence: boolean;
  codeFenceMarker: '`' | '~' | null;
  codeFenceLength: number;
  inPercentComment: boolean;
  inHtmlComment: boolean;
  inFrontmatter: boolean;
  lineIndex?: number;
  skipLine?: boolean;
}

function updateCommentAndCodeState(rawLine: string, state: ScanSkipState): ScanSkipState {
  const trimmed = rawLine.trim();
  const next = { ...state, skipLine: false };
  const fenceMatch = trimmed.match(/^(`{3,}|~{3,})/u)?.[1];
  // YAML frontmatter delimited by `---` lines at the very top of the file.
  // Mirrors upstream behaviour: the metadata cache's listItems do not include
  // frontmatter content, so we must not parse `- [ ]` patterns that appear
  // inside YAML values.
  if (next.inFrontmatter) {
    next.skipLine = true;
    if (trimmed === '---' || trimmed === '...') next.inFrontmatter = false;
    return next;
  }
  if (state.lineIndex === 0 && trimmed === '---') {
    next.skipLine = true;
    next.inFrontmatter = true;
    return next;
  }
  if (next.inCodeFence) {
    next.skipLine = true;
    if (
      fenceMatch
      && fenceMatch[0] === next.codeFenceMarker
      && fenceMatch.length >= next.codeFenceLength
    ) {
      next.inCodeFence = false;
      next.codeFenceMarker = null;
      next.codeFenceLength = 0;
    }
    return next;
  }
  if (fenceMatch) {
    next.skipLine = true;
    next.inCodeFence = true;
    next.codeFenceMarker = fenceMatch[0] as '`' | '~';
    next.codeFenceLength = fenceMatch.length;
    return next;
  }

  if (next.inPercentComment) {
    next.skipLine = true;
    if (trimmed.includes('%%')) next.inPercentComment = false;
    return next;
  }
  if (next.inHtmlComment) {
    next.skipLine = true;
    if (trimmed.includes('-->')) next.inHtmlComment = false;
    return next;
  }
  if (trimmed.startsWith('%%')) {
    next.skipLine = true;
    next.inPercentComment = !trimmed.slice(2).includes('%%');
    return next;
  }
  if (trimmed.startsWith('<!--')) {
    next.skipLine = true;
    next.inHtmlComment = !trimmed.includes('-->');
    return next;
  }
  return next;
}

function globalFilterTagName(globalFilter: string): string | null {
  const normalizedFilter = globalFilter.trim();
  if (!normalizedFilter.startsWith('#')) return null;
  const tag = normalizedFilter.slice(1).toLowerCase();
  return tag || null;
}

export function taskMatchesGlobalFilter(task: ParsedTask, globalFilter: string): boolean {
  const normalizedFilter = globalFilter.trim();
  if (!normalizedFilter) return true;
  const filterTag = globalFilterTagName(normalizedFilter);
  if (!filterTag) {
    return task.body.toLowerCase().includes(normalizedFilter.toLowerCase());
  }
  const subPrefix = `${filterTag}/`;
  return task.tags.some((tag) => {
    const lower = tag.toLowerCase();
    return lower === filterTag || lower.startsWith(subPrefix);
  });
}

function removeGlobalFilterText(text: string, globalFilter: string): string {
  const normalizedFilter = globalFilter.trim();
  const filterTag = globalFilterTagName(normalizedFilter);
  if (!filterTag) {
    const textPattern = new RegExp(String.raw`(?:^|\s)${escapeRegExp(normalizedFilter)}(?=\s|$)`, 'giu');
    return text.replace(textPattern, ' ');
  }
  const tagPattern = new RegExp(String.raw`(^|[\s([{])#${escapeRegExp(filterTag)}(?:\/[^\s#\])}>,.;:!?]*)?[,.;:!?]?(?=$|[\s)\]}])`, 'giu');
  return text.replace(tagPattern, (_match, prefix: string) => prefix || ' ');
}

function removeGlobalFilterFromTask(task: ParsedTask, globalFilter: string): ParsedTask {
  const normalizedFilter = globalFilter.trim();
  if (!normalizedFilter) return task;
  const strippedBody = removeGlobalFilterText(task.body, normalizedFilter);
  const key = taskKeyForBody(task.filePath, strippedBody, task.metadata);
  const normalizedText = normalizeTaskText(removeGlobalFilterText(task.normalizedText, normalizedFilter));
  return {
    ...task,
    normalizedText,
    tags: removeGlobalFilterTags(task.tags, normalizedFilter),
    key,
    stableKey: task.metadata.id ? key : task.stableKey,
  };
}

function removeGlobalFilterTagFromTask(task: ParsedTask, globalFilter: string): ParsedTask {
  const tags = removeGlobalFilterTags(task.tags, globalFilter.trim());
  return tags.length === task.tags.length ? task : { ...task, tags };
}

function removeGlobalFilterTags(tags: readonly string[], globalFilter: string): string[] {
  const filterTag = globalFilterTagName(globalFilter);
  if (!filterTag) return [...tags];
  // Upstream restriction: when the global filter is a tag, tasks may not use
  // that tag as a parent of nested tags. We strip the exact tag and any
  // sub-tags (e.g. "#task/foo") from the task's tag list so queries don't see
  // them as orthogonal tags.
  const subPrefix = `${filterTag}/`;
  return tags.filter((tag) => {
    const lower = tag.toLowerCase();
    return lower !== filterTag && !lower.startsWith(subPrefix);
  });
}

function rewriteCheckbox(rawLine: string, checkbox: string): string {
  return rawLine.replace(/^((?:\s*>\s*)*\s*(?:[-*+]|\d+[.)])\s+\[)[^\]]+(\]\s+)/u, `$1${checkbox}$2`);
}

/** Returns current local time as "HH:MM" for appending to lifecycle dates. */
function nowTimeString(): string {
  const now = new Date();
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
}

function applyAutomaticStatusDates(rawLine: string, previousStatus: TaskStatus, status: TaskStatus, today: string, settings: TaskScannerSettings): string {
  const wikiLinks = settings.dateFormat === 'wikilink';
  const withTime = settings.dateTimeOnLifecycleDates ? ` ${nowTimeString()}` : '';
  let line = rawLine;
  // Remove date stamps when leaving a tracked status (must happen before adding new dates
  // so that done→cancelled correctly removes the done date then adds the cancelled date).
  if (previousStatus === 'done' && status !== 'done' && settings.setDoneDate) line = removeDateField(line, 'done');
  if (previousStatus === 'cancelled' && status !== 'cancelled' && settings.setCancelledDate) line = removeDateField(line, 'cancelled');
  // Add date stamps when entering a tracked status.
  if (status === 'done' && previousStatus !== 'done' && settings.setDoneDate) line = ensureDateField(line, 'done', today, wikiLinks, withTime);
  if (status === 'cancelled' && previousStatus !== 'cancelled' && settings.setCancelledDate) line = ensureDateField(line, 'cancelled', today, wikiLinks, withTime);
  return line;
}

function ensureDateField(rawLine: string, field: 'done' | 'cancelled' | 'created', today: string, asWikiLinks = false, timeSuffix = ''): string {
  const fmtDate = (d: string) => asWikiLinks ? `[[${d}]]` : d;
  const symbol = ({ done: '✅', cancelled: '❌', created: '➕' } as const)[field];
  if (field === 'cancelled' && /(?:^|\s)⛔\uFE0F?\s*(?:\[\[)?\d{4}-\d{2}-\d{2}(?:\]\])?(?:[ T]\d{1,2}:\d{2})?/u.test(rawLine)) return rawLine;
  return new RegExp(String.raw`(?:^|\s)${escapeRegExp(symbol)}\s*(?:\[\[)?\d{4}-\d{2}-\d{2}(?:\]\])?`, 'u').test(rawLine) ? rawLine : `${rawLine} ${symbol} ${fmtDate(today)}${timeSuffix}`;
}

function removeDateField(rawLine: string, field: 'done' | 'cancelled'): string {
  const symbol = ({ done: '✅', cancelled: '❌' } as const)[field];
  const symbolPattern = field === 'cancelled' ? String.raw`(?:${escapeRegExp(symbol)}|⛔)` : escapeRegExp(symbol);
  // Match both plain (✅ YYYY-MM-DD) and wikilink (✅ [[YYYY-MM-DD]]) formats,
  // with optional Variant Selector 16 (\uFE0F) and optional HH:MM time suffix.
  // Cancelled dates also support the legacy ⛔ marker accepted by the parser.
  return rawLine
    .replace(new RegExp(String.raw`(?:^|\s)${symbolPattern}\uFE0F?\s*(?:\[\[\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?(?:\|[^\]]*)?\]\]|\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?)`, 'gu'), ' ')
    .replace(/\s{2,}/gu, ' ')
    .trimEnd();
}

function filterExistingRecurrenceLines(nextLines: readonly string[], existingLines: ReadonlyArray<{ text: string }>): string[] {
  const existingIdentities = new Set(existingLines.map((line) => sourceLineIdentity(line.text)));
  return nextLines.filter((nextLine) => {
    const identity = sourceLineIdentity(nextLine);
    if (existingIdentities.has(identity)) return false;
    existingIdentities.add(identity);
    return true;
  });
}

function buildNextRecurrenceLines(
  completedLine: string,
  task: ParsedTask,
  states: readonly TaskStateDefinition[],
  settings: TaskScannerSettings,
  today: string,
  futureCount: number,
): string[] {
  const lines: string[] = [];
  let previousTask = task;
  let previousLine = completedLine;
  for (let index = 0; index < futureCount; index += 1) {
    const nextLine = buildNextRecurrenceLine(previousLine, previousTask, states, settings, today, index === 0);
    if (!nextLine || lines.includes(nextLine)) break;
    lines.push(nextLine);
    const parsed = parseMarkdownTaskLine(nextLine, previousTask.filePath, previousTask.lineNumber - index - 1, states, previousTask.heading);
    if (!parsed) break;
    previousTask = parsed;
    previousLine = nextLine;
  }
  return lines;
}

function buildNextRecurrenceLine(completedLine: string, task: ParsedTask, states: readonly TaskStateDefinition[], settings: TaskScannerSettings, today: string, firstWhenDoneOccurrence = true): string | null {
  const recurrence = task.metadata.recurrence;
  if (!recurrence) return null;
  // Use recurrenceRaw (original text) wherever `for N times` or `until` need to be read,
  // because normalizeRecurrenceRule strips those suffixes from weekday shorthand rules.
  const recurrenceForLimitCheck = task.metadata.recurrenceRaw ?? recurrence;
  const datePriority: Array<'due' | 'scheduled' | 'start'> = settings.removeScheduledDateOnRecurrence ? ['due', 'start', 'scheduled'] : ['due', 'scheduled', 'start'];
  const referenceField = datePriority.find((field) => task.metadata.dates[field]);
  const referenceDate = referenceField ? task.metadata.dates[referenceField] : undefined;
  if (referenceDate && !isValidIsoDate(referenceDate)) return null;
  // Pass recurrenceRaw so nextRecurringDate can see `for N times`/`until` even for weekday rules.
  let nextReferenceDate = nextRecurringDate(referenceDate, recurrenceForLimitCheck, today, firstWhenDoneOccurrence);
  // Skip-to-future (#9): if the setting is on and the computed next date is in the past,
  // keep advancing until we get a future date (only for fixed-interval rules, not when-done).
  if (settings.recurrenceSkipToFuture && nextReferenceDate && nextReferenceDate < today && !/\bwhen\s+done\b/iu.test(recurrence)) {
    let safetyLimit = 0;
    while (nextReferenceDate && nextReferenceDate < today && safetyLimit < 1000) {
      nextReferenceDate = nextRecurringDate(nextReferenceDate, recurrenceForLimitCheck, today, false);
      safetyLimit += 1;
    }
  }
  if (referenceDate && !nextReferenceDate) return null;

  let line = rewriteCheckbox(completedLine, checkboxForStatus('todo', states));
  // Strip completion/cancellation tracking dates from the next occurrence — both emoji and dataview formats.
  // Handles plain (✅ YYYY-MM-DD) and wikilink (✅ [[YYYY-MM-DD]]) formats, with optional time suffix.
  line = line.replace(/\s+✅\uFE0F?\s*(?:\[\[)?\d{4}-\d{2}-\d{2}(?:\]\])?(?:[ T]\d{1,2}:\d{2})?/gu, '').replace(/\s+[❌⛔]\uFE0F?\s*(?:\[\[)?\d{4}-\d{2}-\d{2}(?:\]\])?(?:[ T]\d{1,2}:\d{2})?/gu, '');
  line = line.replace(/\s*[\[(](?:completion|done|cancelled|canceled)::\s*\d{4}-\d{2}-\d{2}\s*[\])]/giu, '');
  const wikiLinks = settings.dateFormat === 'wikilink';
  line = rewriteDateField(line, 'due', nextOffsetDate(task.metadata.dates.due, referenceDate, nextReferenceDate), wikiLinks);
  const removeScheduled = settings.removeScheduledDateOnRecurrence && Boolean(task.metadata.dates.due || task.metadata.dates.start);
  line = rewriteDateField(line, 'scheduled', removeScheduled ? null : nextOffsetDate(task.metadata.dates.scheduled, referenceDate, nextReferenceDate), wikiLinks);
  line = rewriteDateField(line, 'start', nextOffsetDate(task.metadata.dates.start, referenceDate, nextReferenceDate), wikiLinks);
  line = rewriteReminderField(line, task.metadata.reminder, nextOffsetDate(task.metadata.reminder?.slice(0, 10), referenceDate, nextReferenceDate));
  // Created date on next occurrence: set to today when setting enabled, otherwise drop any inherited created date.
  if (settings.setCreatedDate) {
    line = rewriteDateField(line, 'created', today, wikiLinks);
  } else {
    line = rewriteDateField(line, 'created', null);
  }
  // Strip id (🆔) and depends-on (⛔) metadata — both emoji and dataview formats. New occurrences cannot share ids/deps.
  // The dependency emoji form accepts comma-separated id lists with optional surrounding whitespace, matching the parser.
  line = line.replace(/\s+🆔\uFE0F?\s+[A-Za-z0-9_-]+(?::[A-Za-z0-9_-]+)?/gu, '');
  line = line.replace(/\s+⛔\uFE0F?\s+[A-Za-z0-9_-]+(?::(?:FS|SS|FF|SF)(?:[+-]?\d+[dwmy])?)?(?:\s*,\s*[A-Za-z0-9_-]+(?::(?:FS|SS|FF|SF)(?:[+-]?\d+[dwmy])?)?)*(?=\s|$)/giu, '');
  line = line.replace(/\s*[\[(](?:id|dependsOn|depends on|depends-on)::\s*[^\])]*[\])]/giu, '');
  // Decrement `for N times` counter in the recurrence rule of the next occurrence.
  // Use recurrenceRaw so the match succeeds for weekday rules (normalised form drops the suffix).
  const forTimesMatch = parseForTimesCount(recurrenceForLimitCheck);
  if (forTimesMatch) {
    if (forTimesMatch.count > 1) line = decrementForTimesCountInLine(line, forTimesMatch.rawCount, forTimesMatch.count);
  }
  return line;
}

function recurrenceSeriesIdForTask(task: ParsedTask): string {
  return task.metadata.recurrenceSeriesId || task.metadata.id || task.key;
}

function recurrenceOccurrenceDate(task: ParsedTask | null): string | null {
  if (!task) return null;
  return task.metadata.dates.due ?? task.metadata.dates.scheduled ?? task.metadata.dates.start ?? null;
}

function nextOffsetDate(current: string | undefined, referenceDate: string | undefined, nextReferenceDate: string | null): string | null {
  if (!current || !referenceDate || !nextReferenceDate) return null;
  return addDate(nextReferenceDate, 'day', diffDateDays(parseDate(referenceDate), parseDate(current)));
}

function rewriteReminderField(rawLine: string, current: string | undefined, nextDate: string | null): string {
  const dataviewPattern = /(\s*[\[(]reminder::\s*)(?:\[\[)?\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?(?:\]\])?(\s*[\])])/iu;
  const time = current?.match(/(?:^|[ T])(\d{1,2}:\d{2})(?:\]\])?$/u)?.[1];

  if (dataviewPattern.test(rawLine)) {
    if (!nextDate) return rawLine.replace(dataviewPattern, '');
    const isWikiLink = /[\[(]reminder::\s*\[\[/iu.test(rawLine);
    // Keep the time inside the wikilink brackets so the rewritten value matches
    // the original [[date time]] shape the dataview pattern captured.
    const dateWithTime = `${nextDate}${time ? ` ${time}` : ''}`;
    const fmtDate = isWikiLink ? `[[${dateWithTime}]]` : dateWithTime;
    return rawLine.replace(dataviewPattern, `$1${fmtDate}$2`);
  }

  // Match plain (⏰ YYYY-MM-DD), plain with time, wikilink date, and wikilink
  // date+time forms. The full token is consumed so rewrites do not leave stale
  // closing brackets behind for ⏰ [[YYYY-MM-DD HH:MM]].
  const emojiPattern = /(\s+⏰\uFE0F?\s*)(?:\[\[\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?\]\]|\d{4}-\d{2}-\d{2})(?:[ T]\d{1,2}:\d{2})?/u;
  if (!current) return nextDate ? `${rawLine.trimEnd()} ⏰ ${nextDate}` : rawLine;
  if (!nextDate) return rawLine.replace(emojiPattern, '');
  // Preserve wikilink wrapping and whether the time originally lived inside
  // the wikilink (⏰ [[date time]]) or outside it (⏰ [[date]] time).
  const isWikiLink = /⏰\uFE0F?\s*\[\[/u.test(rawLine);
  const isWikiLinkWithTimeInside = /⏰\uFE0F?\s*\[\[\d{4}-\d{2}-\d{2}[ T]\d{1,2}:\d{2}\]\]/u.test(rawLine);
  const fmtDate = isWikiLink ? `[[${nextDate}${isWikiLinkWithTimeInside && time ? ` ${time}` : ''}]]` : nextDate;
  return rawLine.replace(
    emojiPattern,
    `$1${fmtDate}${!isWikiLinkWithTimeInside && time ? ` ${time}` : ''}`,
  );
}

export function rewriteEditableDateField(rawLine: string, field: EditableTaskDateField, date: string | null, task?: ParsedTask, asWikiLinks = false): string {
  if (field === 'reminder') return rewriteReminderField(rawLine, task?.metadata.reminder, date);
  if (field === 'timeStart') return rewriteTimeStartField(rawLine, task?.metadata.timeStart, task?.metadata.timeEnd, date);
  return rewriteDateField(rawLine, field, date, asWikiLinks);
}

function rewriteTimeStartField(rawLine: string, currentStart: string | undefined, currentEnd: string | undefined, nextTime: string | null): string {
  const timePattern = /\s+(?:⏰|⌚)\uFE0F?\s*\d{1,2}:\d{2}(?:\s*-\s*\d{1,2}:\d{2})?/u;
  const dataviewPattern = /(\s*[\[(]time::\s*)\d{1,2}:\d{2}(?:\s*-\s*\d{1,2}:\d{2})?(\s*[\])])/iu;
  if (!nextTime) {
    if (dataviewPattern.test(rawLine)) return rawLine.replace(dataviewPattern, '');
    return rawLine.replace(timePattern, '');
  }

  const currentStartMinutes = parseClockMinutes(currentStart);
  const currentEndMinutes = parseClockMinutes(currentEnd);
  const nextStartMinutes = parseClockMinutes(nextTime);
  let end = '';
  if (currentStartMinutes !== null && currentEndMinutes !== null && nextStartMinutes !== null) {
    const duration = currentEndMinutes - currentStartMinutes;
    const nextEndMinutes = nextStartMinutes + duration;
    if (duration > 0 && nextEndMinutes < 24 * 60) {
      end = `-${formatClockMinutes(nextEndMinutes)}`;
    }
  }

  const replacementValue = `${nextTime}${end}`;
  if (dataviewPattern.test(rawLine)) return rawLine.replace(dataviewPattern, `$1${replacementValue}$2`);
  if (timePattern.test(rawLine)) return rawLine.replace(timePattern, ` ⏰ ${replacementValue}`);
  return `${rawLine.trimEnd()} ⏰ ${replacementValue}`;
}

function parseClockMinutes(value: string | undefined): number | null {
  const match = value?.match(/^(\d{1,2}):(\d{2})$/u);
  if (!match) return null;
  const hour = Number.parseInt(match[1], 10);
  const minute = Number.parseInt(match[2], 10);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || hour < 0 || hour >= 24 || minute < 0 || minute >= 60) return null;
  return hour * 60 + minute;
}

function formatClockMinutes(totalMinutes: number): string {
  const hour = Math.floor(totalMinutes / 60);
  const minute = totalMinutes % 60;
  return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

function rewriteDateField(rawLine: string, field: TaskDateField, date: string | null, asWikiLinks = false): string {
  // Time-component fields have no emoji symbols — nothing to rewrite at this level.
  if (field === 'dueTime' || field === 'scheduledTime' || field === 'startTime') return rawLine;

  type CoreDateField = 'due' | 'scheduled' | 'start' | 'created' | 'done' | 'cancelled';
  const coreField = field;

  const dataviewKeys: Record<CoreDateField, string[]> = {
    due: ['due'],
    scheduled: ['scheduled'],
    start: ['start'],
    created: ['created'],
    done: ['completion', 'done'],
    cancelled: ['cancelled', 'canceled'],
  };
  for (const key of dataviewKeys[coreField]) {
    const dataviewPattern = new RegExp(String.raw`(\s*[\[(]${key}::\s*)(?:\[\[\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?(?:\|[^\]]*)?\]\]|\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?)(\s*[\])])`, 'iu');
    if (dataviewPattern.test(rawLine)) {
      return date ? rawLine.replace(dataviewPattern, `$1${date}$2`) : rawLine.replace(dataviewPattern, '');
    }
  }

  const fmtDate = (d: string) => asWikiLinks ? `[[${d}]]` : d;
  const symbols = ({
    due: ['\uD83D\uDCC5', '\uD83D\uDCC6', '\uD83D\uDDD3'],
    scheduled: ['\u23F3', '\u231B'],
    start: ['\uD83D\uDEEB'],
    created: ['\u2795'],
    done: ['\u2705'],
    cancelled: ['\u274C', '\u26D4'],
  } as const)[coreField];
  if (!symbols) return rawLine;
  const symbolPattern = symbols.map((symbol) => escapeRegExp(symbol)).join('|');
  const canonicalSymbol = symbols[0];
  // Match both plain YYYY-MM-DD and [[YYYY-MM-DD]] wiki-link wrapped dates
  const pattern = new RegExp(String.raw`\s+(${symbolPattern})\uFE0F?\s*(?:\[\[\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?(?:\|[^\]]*)?\]\]|\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?)`, 'gu');
  if (pattern.test(rawLine)) {
    return date ? rawLine.replace(pattern, (_match, existingSymbol: string) => ` ${field === 'cancelled' && existingSymbol === '⛔' ? '❌' : existingSymbol} ${fmtDate(date)}`) : rawLine.replace(pattern, '');
  }
  return date ? `${rawLine} ${canonicalSymbol} ${fmtDate(date)}` : rawLine;
}

export function durableCompletionDestinationAction(
  rawLine: string,
  checkbox: string,
  states: readonly TaskStateDefinition[],
  _settings: TaskScannerSettings,
): 'archive' | 'collect' | null {
  const task = parseMarkdownTaskLine(rawLine, '', 1, states);
  if (!task || (task.metadata.onCompletion !== 'archive' && task.metadata.onCompletion !== 'collect')) return null;
  const targetStatus = statusFromCheckbox(checkbox, states);
  return targetStatus === 'done' ? task.metadata.onCompletion : null;
}

export function applyTaskCompletionLifecycleToLine(
  rawLine: string,
  checkbox: string,
  states: readonly TaskStateDefinition[],
  settings: TaskScannerSettings,
  today = currentLocalDateString(),
  shouldIncludeNextLine?: (nextLine: string) => boolean,
): string[] | null {
  const task = parseMarkdownTaskLine(rawLine, '', 1, states);
  if (!task) return null;
  const targetStatus = statusFromCheckbox(checkbox, states);
  if (durableCompletionDestinationAction(rawLine, checkbox, states, settings)) return null;
  let completedLine = rewriteCheckbox(rawLine, checkbox);
  completedLine = applyAutomaticStatusDates(completedLine, task.status, targetStatus, today, settings);
  const completedTask = parseMarkdownTaskLine(completedLine, '', 1, states);
  if (!completedTask) return null;
  // Mirror upstream Task.handleNewStatus guard: don't generate a new occurrence when the
  // task was already in the same completion status (e.g. done→done, cancelled→cancelled),
  // otherwise repeated change-status-to-done invocations would emit duplicate recurrences.
  const oldStatusAlreadyCompleting =
    (targetStatus === 'done' && task.status === 'done')
    || (targetStatus === 'cancelled' && task.status === 'cancelled');
  if (
    !oldStatusAlreadyCompleting
    && (targetStatus === 'done' || (targetStatus === 'cancelled' && settings.recurrenceOnCancelled))
    && completedTask.status !== 'untracked'
    && hasUsableRecurrence(completedTask, settings)
  ) {
    const durableCount = settings.trackRecurrenceCount ? (completedTask.metadata.recurrenceCount ?? 0) + 1 : null;
    if (durableCount !== null) completedLine = writeDurableRecurrenceCount(completedLine, durableCount);
    const futureCount = Math.max(0, Math.floor(settings.recurrenceFutureOccurrences));
    const countedTask = parseMarkdownTaskLine(completedLine, '', 1, states) ?? completedTask;
    const recurrenceSourceTask = { ...countedTask, metadata: { ...countedTask.metadata, recurrence: normalizeRecurrenceRule(countedTask.metadata.recurrence) } };
    let rawNextLines = buildNextRecurrenceLines(completedLine, recurrenceSourceTask, states, settings, today, futureCount);
    if (durableCount !== null) rawNextLines = rawNextLines.map((line) => writeDurableRecurrenceCount(line, durableCount));
    const nextLines = shouldIncludeNextLine ? rawNextLines.filter(shouldIncludeNextLine) : rawNextLines;
    if (targetStatus === 'done' && completedTask.metadata.onCompletion === 'delete') return nextLines;
    return settings.recurrenceInsertLocation === 'after' ? [completedLine, ...nextLines] : [...nextLines, completedLine];
  }
  if (targetStatus === 'done' && completedTask.metadata.onCompletion === 'delete') return [];
  // move-to-end: keep the completed line in the result (actual reposition is a vault side-effect)
  return [completedLine];
}

/**
 * Moves the task line at `lineIndex` and its indented child lines to the end of
 * its section within `lines`.
 * The section is defined as the content between the nearest heading above
 * the task and the next heading of the same or higher level (or EOF).
 * Operates in-place on the `lines` array.
 */
function taskBlockEndIndex(
  lines: Array<{ text: string; lineEnding: string }>,
  lineIndex: number,
  task: Pick<ParsedTask, 'indentation' | 'linePrefix'>,
): number {
  const parentIndent = task.indentation.length + task.linePrefix.length;
  let blockEnd = lineIndex + 1;
  while (blockEnd < lines.length) {
    const childIndent = (lines[blockEnd]?.text ?? '').match(/^(?:\s*>\s*)*\s*/u)?.[0].length ?? 0;
    if (childIndent <= parentIndent) break;
    blockEnd += 1;
  }
  return blockEnd;
}

function taskBlockToText(
  lines: Array<{ text: string; lineEnding: string }>,
  lineIndex: number,
  task: Pick<ParsedTask, 'indentation' | 'linePrefix'>,
): string {
  return lines.slice(lineIndex, taskBlockEndIndex(lines, lineIndex, task)).map((part) => part.text).join('\n');
}

function moveTaskBlockToSectionEnd(
  lines: Array<{ text: string; lineEnding: string }>,
  lineIndex: number,
  task: Pick<ParsedTask, 'indentation' | 'linePrefix'>,
): void {
  if (lineIndex < 0 || lineIndex >= lines.length) return;
  const blockEnd = taskBlockEndIndex(lines, lineIndex, task);
  const movedBlock = lines.slice(lineIndex, blockEnd);
  if (movedBlock.length === 0) return;

  // Find the heading level that opens this section.
  let sectionHeadingLevel = 0;
  for (let i = lineIndex - 1; i >= 0; i--) {
    const hm = lines[i]?.text.match(/^(#{1,6})\s/u);
    if (hm) {
      sectionHeadingLevel = hm[1].length;
      break;
    }
  }

  // Find where the section ends.
  let sectionEnd = lines.length;
  if (sectionHeadingLevel > 0) {
    for (let i = lineIndex + 1; i < lines.length; i++) {
      const hm = lines[i]?.text.match(/^(#{1,6})\s/u);
      if (hm && hm[1].length <= sectionHeadingLevel) {
        sectionEnd = i;
        break;
      }
    }
  }

  // Remove from current position.
  lines.splice(lineIndex, movedBlock.length);
  // Adjust sectionEnd because we removed lines before it.
  if (sectionEnd > lineIndex) sectionEnd -= movedBlock.length;

  // Trim trailing blank lines from the insertion point so we don't accumulate gaps.
  let insertAt = sectionEnd;
  while (insertAt > 0 && lines[insertAt - 1]?.text.trim() === '') insertAt -= 1;

  lines.splice(insertAt, 0, ...movedBlock);
}

/**
 * Inserts `entry` at the end of the section that contains `refIndex`.
 * Used by the recurring + move-to-end path where the original task line
 * has already been replaced by the next occurrence.
 */
function insertAtSectionEnd(
  lines: Array<{ text: string; lineEnding: string }>,
  entry: { text: string; lineEnding: string },
  refIndex: number,
): void {
  let sectionHeadingLevel = 0;
  for (let i = refIndex - 1; i >= 0; i--) {
    const hm = lines[i]?.text.match(/^(#{1,6})\s/u);
    if (hm) {
      sectionHeadingLevel = hm[1].length;
      break;
    }
  }

  let sectionEnd = lines.length;
  if (sectionHeadingLevel > 0) {
    for (let i = refIndex; i < lines.length; i++) {
      const hm = lines[i]?.text.match(/^(#{1,6})\s/u);
      if (hm && hm[1].length <= sectionHeadingLevel) {
        sectionEnd = i;
        break;
      }
    }
  }

  let insertAt = sectionEnd;
  while (insertAt > 0 && lines[insertAt - 1]?.text.trim() === '') insertAt -= 1;
  lines.splice(insertAt, 0, entry);
}

const loggedInvalidRecurrences = new Set<string>();
function warnInvalidRecurrenceOnce(rule: string, filePath: string, lineNumber: number): void {
  const key = `${rule}::${filePath}:${lineNumber}`;
  if (loggedInvalidRecurrences.has(key)) return;
  loggedInvalidRecurrences.add(key);
  console.warn(`[task-manager] Unrecognised recurrence rule "${rule}" at ${filePath}:${lineNumber}. Task will not recur.`);
}

export function isRecurrenceRuleValid(rule: string | undefined): boolean {
  if (!rule) return false;
  const untilMatch = rule.match(/\buntil\s+(\d{4}-\d{2}-\d{2})\b/iu);
  if (untilMatch && !isValidIsoDate(untilMatch[1])) return false;

  // Strip end conditions before the validity probe so that rules like
  // "every week for 1 times" (last occurrence, count exhausted) and
  // "every week until 2025-01-01" (past end date) are still treated as
  // syntactically valid recurring rules.
  const strippedForValidation = ((normalizeRecurrenceRule(rule) ?? rule)
    .toLowerCase()
    .replace(/\s*\buntil\s+\d{4}-\d{2}-\d{2}\b/giu, '')
    .replace(/\s*\bfor\s+\d+\s+times?\b/giu, '')
    .replace(/\s+/gu, ' ')
    .trim()
  );
  return nextRecurringDate('2026-01-01', strippedForValidation, '2026-01-01', false) !== null;
}

export function calculateNextRecurrences(recurrence: string | undefined, baseDate: string | undefined, today: string, count: number = 3): string[] | null {
  if (!recurrence || !baseDate) {
    return null;
  }
  if (!isRecurrenceRuleValid(recurrence)) {
    return null;
  }

  const occurrences: string[] = [];
  let current = baseDate;
  // Simulate the real `for N times` countdown so the preview shows the correct
  // number of reachable future dates.  Without this, `every week for 3 times`
  // would always pass `forTimesCount = 3 > 1` and return 3 dates even though
  // only 2 actual completions are possible (the 3rd task is the last, completing
  // it yields nothing).
  let currentRecurrence = recurrence;

  for (let i = 0; i < count; i++) {
    const next = nextRecurringDate(current, currentRecurrence, today, false);
    if (!next) break;
    occurrences.push(next);
    current = next;
    // Decrement `for N times` counter for the next iteration.
    const forTimesMatch = parseForTimesCount(currentRecurrence);
    if (forTimesMatch) {
      const newCount = forTimesMatch.count - 1;
      const newSuffix = newCount === 1 ? 'time' : 'times';
      currentRecurrence = currentRecurrence.replace(/\bfor\s+(\d+|[a-z]+)\s+times?\b/iu, `for ${newCount} ${newSuffix}`);
    }
  }

  return occurrences.length > 0 ? occurrences : null;
}

export function calculateFirstRecurrenceDateForCompletedLine(
  rawLine: string,
  checkbox: string,
  states: readonly TaskStateDefinition[],
  settings: TaskScannerSettings,
  today = currentLocalDateString(),
): string | null {
  const task = parseMarkdownTaskLine(rawLine, '', 1, states);
  if (!task) return null;
  const targetStatus = statusFromCheckbox(checkbox, states);
  let completedLine = rewriteCheckbox(rawLine, checkbox);
  completedLine = applyAutomaticStatusDates(completedLine, task.status, targetStatus, today, settings);
  const completedTask = parseMarkdownTaskLine(completedLine, '', 1, states);
  if (!completedTask || !hasUsableRecurrence(completedTask, settings)) return null;
  const recurrenceSourceTask = { ...completedTask, metadata: { ...completedTask.metadata, recurrence: normalizeRecurrenceRule(completedTask.metadata.recurrence) } };
  const nextLine = buildNextRecurrenceLine(completedLine, recurrenceSourceTask, states, settings, today, true);
  if (!nextLine) return null;
  return recurrenceOccurrenceDate(parseMarkdownTaskLine(nextLine, '', 1, states));
}

function nextRecurringDate(current: string | undefined, recurrence: string, today: string, useWhenDoneBase = true): string | null {
  if (!current) return null;

  // Extract end conditions from the ORIGINAL recurrence text (before normalisation).
  // normalizeRecurrenceRule converts weekday shorthands like "every monday for 3 times" to
  // "every week on monday", silently dropping the `for N times` and `until` suffixes.
  // Reading from the raw string before normalisation preserves those constraints.
  const rawLower = recurrence.toLowerCase().replace(/\s+/gu, ' ').trim();
  const untilMatch = rawLower.match(/\buntil\s+(\d{4}-\d{2}-\d{2})\b/u);
  if (untilMatch && !isValidIsoDate(untilMatch[1])) return null;
  const untilDate = untilMatch?.[1];
  const forTimesCount = parseForTimesCount(rawLower)?.count;
  // "for N times" where N <= 1 means this was the last occurrence — don't create another.
  if (forTimesCount !== undefined && forTimesCount <= 1) return null;

  const normalized = (normalizeRecurrenceRule(recurrence) ?? recurrence).toLowerCase().replace(/\s+/gu, ' ').trim();

  // Strip end conditions so the frequency-only rule can be parsed.
  const frequencyRule = normalized
    .replace(/\s*\buntil\s+\d{4}-\d{2}-\d{2}\b/giu, '')
    .replace(/\s*\bfor\s+(?:\d+|[a-z]+)\s+times?\b/giu, '')
    .replace(/\s+/gu, ' ')
    .trim();

  const nextDate = nextRecurringDateCore(current, frequencyRule, today, useWhenDoneBase);

  // Apply `until` end-date check
  if (nextDate && untilDate && nextDate > untilDate) return null;
  return nextDate;
}

/**
 * Computes the next recurrence date based purely on frequency.
 * End conditions (`until`, `for N times`) must be stripped before calling.
 */
function nextRecurringDateCore(current: string, recurrence: string, today: string, useWhenDoneBase = true): string | null {
  const rawRule = recurrence; // Already normalized and lowercased by caller
  const whenDone = /\bwhen\s+done\b/u.test(rawRule);
  const rule = rawRule.replace(/\bwhen\s+done\b/giu, '').replace(/\s+/gu, ' ').trim();
  const base = parseDate(whenDone && useWhenDoneBase ? today : current);

  const shorthandWeekday = rule.match(/^every\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/iu);
  if (shorthandWeekday) {
    const suffix = whenDone ? ' when done' : '';
    return nextRecurringDate(current, `every week on ${shorthandWeekday[1]}${suffix}`, today, useWhenDoneBase);
  }

  const yearlySpecific = rule.match(/every\s+([a-z,\s]+?)\s+on\s+the\s+(.+)$/iu);
  if (yearlySpecific) {
    const months = yearlySpecific[1].split(/(?:,|\s+and\s+|\s+)/u).map((entry) => entry.trim()).filter(Boolean).map(monthNumber).filter((month) => month > 0);
    if (months.length > 0) {
      const days = parseMonthDays(yearlySpecific[2]);
      const next = nextYearlyCompositeDate(base, months, days);
      if (next) return next;
    }
  }

  const weeklyDay = rule.match(/every\s+(?:(\d+)\s+)?weeks?\s+on\s+([a-z, ]+)/iu);
  if (weeklyDay) {
    const interval = weeklyDay[1] ? Number.parseInt(weeklyDay[1], 10) : 1;
    const days = parseWeekdays(weeklyDay[2]);
    if (days.length === 0) return null;
    const start = addDateObject(base, 'day', 1);
    // Loop limit must cover at least one full interval: `every N weeks` can require up to
    // N*7 days before the next candidate aligns with the correct weekday AND week-multiple.
    // A hard cap of 3660 (~10 years) prevents runaway loops from malformed intervals.
    const weeklyLoopLimit = Math.min(interval * 7 + 6, 3660);
    for (let offset = 0; offset <= weeklyLoopLimit; offset += 1) {
      const candidate = addDateObject(start, 'day', offset);
      if (days.includes(candidate.getUTCDay()) && Math.floor(diffDateDays(base, candidate) / 7) % interval === 0) {
        return formatIsoUtcDate(candidate);
      }
    }
  }

  const monthlyRelativeWeekday = rule.match(/every\s+(?:(\d+)\s+)?months?\s+on\s+the\s+(?:(\d+)(?:st|nd|rd|th)?\s+)?last\s+([a-z]+)/iu);
  if (monthlyRelativeWeekday) {
    return nextMonthlyRelativeWeekdayDate(base, monthlyRelativeWeekday[1] ? Number.parseInt(monthlyRelativeWeekday[1], 10) : 1, -Number.parseInt(monthlyRelativeWeekday[2] ?? '1', 10), monthlyRelativeWeekday[3]);
  }

  const monthlyNthWeekday = rule.match(/every\s+(?:(\d+)\s+)?months?\s+on\s+the\s+(\d+)(?:st|nd|rd|th)?\s+([a-z]+)/iu);
  if (monthlyNthWeekday) {
    return nextMonthlyRelativeWeekdayDate(base, monthlyNthWeekday[1] ? Number.parseInt(monthlyNthWeekday[1], 10) : 1, Number.parseInt(monthlyNthWeekday[2], 10), monthlyNthWeekday[3]);
  }

  const monthlyLast = rule.match(/every\s+(?:(\d+)\s+)?months?\s+on\s+the\s+last(?:\s+([a-z]+))?/iu);
  if (monthlyLast) {
    return nextMonthlyDate(base, monthlyLast[1] ? Number.parseInt(monthlyLast[1], 10) : 1, 'last', monthlyLast[2]);
  }

  const monthlyOrdinal = rule.match(/every\s+(?:(\d+)\s+)?months?\s+on\s+(?:the\s+)?(?:day\s+)?(\d{1,2})(?:st|nd|rd|th)?/iu);
  if (monthlyOrdinal) {
    return nextMonthlyDate(base, monthlyOrdinal[1] ? Number.parseInt(monthlyOrdinal[1], 10) : 1, Number.parseInt(monthlyOrdinal[2], 10));
  }

  const countMatch = rule.match(/every\s+(\d+|other)\s+(day|week|month|year)s?/iu);
  const simpleMatch = rule.match(/every\s+(day|weekday|weekend|week|month|year)/iu);
  if (!countMatch && !simpleMatch) return null;
  const count = countMatch ? (countMatch[1].toLowerCase() === 'other' ? 2 : Number.parseInt(countMatch[1], 10)) : 1;
  const unit = countMatch?.[2]?.toLowerCase() ?? simpleMatch?.[1]?.toLowerCase() ?? 'day';
  let result = addDate(formatIsoUtcDate(base), unit === 'weekday' || unit === 'weekend' ? 'day' : unit, count);
  if (unit === 'weekday') {
    while ([0, 6].includes(parseDate(result).getUTCDay())) result = addDate(result, 'day', 1);
  } else if (unit === 'weekend') {
    while (![0, 6].includes(parseDate(result).getUTCDay())) result = addDate(result, 'day', 1);
  }
  return result;
}

/**
 * Decrements the `for N times` counter embedded in a task line's recurrence field.
 * Replaces the first occurrence of `for <fromCount> time(s)` with `for <fromCount-1> time(s)`.
 * Uses singular "time" when the new count is 1 to avoid grammatically incorrect "for 1 times".
 */
function decrementForTimesCountInLine(rawLine: string, rawCount: string, fromCount: number): string {
  const pattern = new RegExp(String.raw`(\bfor\s+)${escapeRegExp(rawCount)}(\s+times?\b)`, 'giu');
  const newCount = fromCount - 1;
  const newSuffix = newCount === 1 ? ' time' : ' times';
  return rawLine.replace(pattern, `$1${newCount}${newSuffix}`);
}

function parseForTimesCount(recurrence: string): { rawCount: string; count: number } | null {
  const match = recurrence.match(/\bfor\s+(\d+|[a-z]+)\s+times?\b/iu);
  if (!match) return null;
  const rawCount = match[1];
  const numericCount = Number.parseInt(rawCount, 10);
  const count = Number.isNaN(numericCount) ? WORD_NUMBERS[rawCount.toLowerCase()] : numericCount;
  return count === undefined ? null : { rawCount, count };
}

function addDate(value: string, unit: string, count: number): string {
  return formatIsoUtcDate(addDateObject(parseDate(value), unit, count));
}

function addDateObject(date: Date, unit: string, count: number): Date {
  const result = new Date(date.getTime());
  if (unit === 'day') result.setUTCDate(result.getUTCDate() + count);
  if (unit === 'week') result.setUTCDate(result.getUTCDate() + count * 7);
  if (unit === 'month') return addMonthsClamped(date, count);
  if (unit === 'year') return addMonthsClamped(date, count * 12);
  return result;
}

function addMonthsClamped(date: Date, count: number): Date {
  const target = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + count, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(date.getUTCDate(), lastDay));
  return target;
}

function nextMonthlyDate(base: Date, interval: number, day: number | 'last', weekdayName?: string): string | null {
  const weekday = weekdayName ? weekdayNumber(weekdayName) : undefined;
  if (weekdayName && weekday === -1) return null;

  for (let months = interval; months <= interval * 36; months += interval) {
    const target = addDateObject(new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1)), 'month', months);
    const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0));
    if (day !== 'last' && day > last.getUTCDate()) continue;
    let candidate = day === 'last'
      ? last
      : new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth(), day));
    if (weekday !== undefined) {
      candidate = new Date(last.getTime());
      while (candidate.getUTCDay() !== weekday) candidate.setUTCDate(candidate.getUTCDate() - 1);
    }
    if (candidate > base) return formatIsoUtcDate(candidate);
  }
  return formatIsoUtcDate(addDateObject(base, 'month', interval));
}

function nextYearlyCompositeDate(base: Date, months: readonly number[], days: readonly (number | 'last')[]): string | null {
  const candidates: Date[] = [];
  for (let year = base.getUTCFullYear(); year <= base.getUTCFullYear() + 10; year += 1) {
    for (const month of months) {
      if (month < 1) continue;
      const last = new Date(Date.UTC(year, month, 0));
      for (const day of days) {
        const candidateDay = day === 'last' ? last.getUTCDate() : day;
        if (candidateDay > last.getUTCDate()) continue;
        const candidate = new Date(Date.UTC(year, month - 1, candidateDay));
        if (candidate > base) candidates.push(candidate);
      }
    }
    if (candidates.length > 0) break;
  }
  candidates.sort((left, right) => left.getTime() - right.getTime());
  return candidates[0] ? formatIsoUtcDate(candidates[0]) : null;
}

function parseMonthDays(value: string): Array<number | 'last'> {
  const normalized = value.toLowerCase().replace(/\bon\b/gu, ' ');
  if (/\blast\b/u.test(normalized)) return ['last'];
  const days = Array.from(normalized.matchAll(/(\d{1,2})(?:st|nd|rd|th)?/gu)).map((match) => Number.parseInt(match[1], 10)).filter((day) => day >= 1 && day <= 31);
  return days.length ? days : [1];
}

function nextMonthlyRelativeWeekdayDate(base: Date, interval: number, ordinal: number, weekdayName: string): string | null {
  const weekday = weekdayNumber(weekdayName);
  if (weekday < 0) return null;
  for (let months = interval; months <= interval * 36; months += interval) {
    const monthStart = addDateObject(new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth(), 1)), 'month', months);
    const last = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth() + 1, 0));
    let candidate: Date;
    if (ordinal < 0) {
      candidate = new Date(last.getTime());
      while (candidate.getUTCDay() !== weekday) candidate.setUTCDate(candidate.getUTCDate() - 1);
      for (let count = 1; count < Math.abs(ordinal); count += 1) candidate.setUTCDate(candidate.getUTCDate() - 7);
    } else {
      candidate = new Date(Date.UTC(monthStart.getUTCFullYear(), monthStart.getUTCMonth(), 1));
      while (candidate.getUTCDay() !== weekday) candidate.setUTCDate(candidate.getUTCDate() + 1);
      candidate.setUTCDate(candidate.getUTCDate() + (ordinal - 1) * 7);
      if (candidate.getUTCMonth() !== monthStart.getUTCMonth()) continue;
    }
    if (candidate > base) return formatIsoUtcDate(candidate);
  }
  return formatIsoUtcDate(addDateObject(base, 'month', interval));
}

function parseWeekdays(value: string): number[] {
  const days = value.split(/(?:,|\s+and\s+|\s+)/u).map((entry) => entry.trim()).filter(Boolean).map(weekdayNumber);
  return days.some((day) => day < 0) ? [] : days;
}

function weekdayNumber(value: string): number {
  return ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].findIndex((day) => day.startsWith(value.toLowerCase()));
}

function monthNumber(value: string): number {
  const index = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'].findIndex((month) => month.startsWith(value.toLowerCase()));
  return index === -1 ? -1 : index + 1;
}

function diffDateDays(left: Date, right: Date): number {
  return Math.floor((Date.UTC(right.getUTCFullYear(), right.getUTCMonth(), right.getUTCDate()) - Date.UTC(left.getUTCFullYear(), left.getUTCMonth(), left.getUTCDate())) / 86_400_000);
}

function parseDate(value: string): Date {
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

function hasUsableRecurrence(task: ParsedTask, settings: TaskScannerSettings): boolean {
  if (!task.metadata.recurrence) return false;
  const datePriority: Array<'due' | 'scheduled' | 'start'> = settings.removeScheduledDateOnRecurrence
    ? ['due', 'start', 'scheduled']
    : ['due', 'scheduled', 'start'];
  const referenceDate = datePriority.map((field) => task.metadata.dates[field]).find((date) => date !== undefined);
  if (referenceDate !== undefined && !isValidIsoDate(referenceDate)) return false;
  return true;
}

function currentLocalDateString(): string {
  return formatIsoLocalDate(new Date());
}

/**
 * Resolve a relative date string (from frontmatter) to an ISO `YYYY-MM-DD` string.
 * Accepts: ISO dates directly, `today`, `tomorrow`, `yesterday`,
 * and `this/next <weekday>` patterns via moment.js.
 * Returns undefined when the input cannot be recognised.
 */
function resolveRelativeDateString(value: string): string | undefined {
  const v = value.trim().toLowerCase();
  if (/^\d{4}-\d{2}-\d{2}$/u.test(v)) return isValidIsoDate(v) ? v : undefined; // already ISO
  // Use Obsidian's bundled moment via the global — avoids the TypeScript call-signature limitation
  // on the `moment` namespace export from the obsidian module.
  const m = (window as unknown as { moment: (d?: unknown) => { format: (f: string) => string; clone: () => { add: (n: number, u: string) => { format: (f: string) => string; isSameOrBefore: (other: unknown, gran: string) => boolean }; subtract: (n: number, u: string) => { format: (f: string) => string }; day: (d: number) => { format: (f: string) => string; isSameOrBefore: (other: unknown, gran: string) => boolean; add: (n: number, u: string) => { format: (f: string) => string } }; format: (f: string) => string } } }).moment;
  const today = m();
  if (v === 'today') return today.format('YYYY-MM-DD');
  if (v === 'tomorrow') return today.clone().add(1, 'day').format('YYYY-MM-DD');
  if (v === 'yesterday') return today.clone().subtract(1, 'day').format('YYYY-MM-DD');
  // `this friday`, `next monday`, etc.
  const weekdayMatch = v.match(/^(this|next)\s+(monday|tuesday|wednesday|thursday|friday|saturday|sunday)$/u);
  if (weekdayMatch) {
    const weekdays = ['sunday','monday','tuesday','wednesday','thursday','friday','saturday'];
    const targetDay = weekdays.indexOf(weekdayMatch[2] ?? '');
    if (targetDay < 0) return undefined;
    const d = today.clone().day(targetDay);
    if (weekdayMatch[1] === 'next' || d.isSameOrBefore(today, 'day')) d.add(1, 'week');
    return d.format('YYYY-MM-DD');
  }
  // `N days`, `N weeks`, `N months` offset — use moment for consistency with the rest of the function
  const offsetMatch = v.match(/^(\d+)\s+(day|week|month)s?(?:\s+from\s+now)?$/u);
  if (offsetMatch) {
    const n = Number(offsetMatch[1]);
    const unit = (offsetMatch[2] as 'day' | 'week' | 'month') === 'week' ? 'week' : (offsetMatch[2] as 'day' | 'month');
    return today.clone().add(n, unit === 'week' ? 'weeks' : `${unit}s`).format('YYYY-MM-DD');
  }
  return undefined;
}

function isPathInFilenameDateFolders(path: string, folderList: string): boolean {
  const folders = folderList.split(',').map((folder) => folder.trim().replace(/^\/+|\/+$/gu, '')).filter(Boolean);
  if (folders.length === 0) return true;
  return folders.some((folder) => path === folder || path.startsWith(`${folder}/`));
}

function filenameScheduledDate(path: string, additionalFormat: string): string | null {
  const filename = (path.split('/').pop() ?? path).replace(/\.md$/iu, '');
  const dashed = filename.match(/\b(\d{4})-(\d{2})-(\d{2})\b/u);
  if (dashed) return validIsoDateParts(dashed[1], dashed[2], dashed[3]);
  const compact = filename.match(/\b(\d{4})(\d{2})(\d{2})\b/u);
  if (compact) return validIsoDateParts(compact[1], compact[2], compact[3]);
  if (additionalFormat) {
    const exact = parseAdditionalFilenameDate(filename, additionalFormat);
    if (exact) return exact;
  }
  return null;
}

function validIsoDateParts(yearText: string, monthText: string, dayText: string): string | null {
  const year = Number.parseInt(yearText, 10);
  const month = Number.parseInt(monthText, 10);
  const day = Number.parseInt(dayText, 10);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return `${yearText}-${monthText}-${dayText}`;
}

function parseAdditionalFilenameDate(filename: string, format: string): string | null {
  const weekly = parseAdditionalWeeklyFilenameDate(filename, format);
  if (weekly) return weekly;
  const parseMoment = moment as unknown as (input: string, format: string, strict: boolean) => { isValid?: () => boolean; format?: (format: string) => string };
  const parsed = parseMoment(filename, format, true);
  if (typeof parsed.isValid === 'function' && parsed.isValid() && typeof parsed.format === 'function') return parsed.format('YYYY-MM-DD');
  const common = parseCommonMomentFilenameDate(filename, format);
  if (common) return common;
  const escaped = escapeRegExp(format)
    .replace(/YYYY/gu, '(?<year>\\d{4})')
    .replace(/MM/gu, '(?<month>\\d{2})')
    .replace(/DD|dd/gu, '(?<day>\\d{2})')
    .replace(/\\\[W\\\]/gu, 'W')
    .replace(/ww/gu, '(?<week>\\d{2})');
  const match = filename.match(new RegExp(`^${escaped}$`, 'u'));
  const groups = match?.groups;
  if (!groups?.year) return null;
  if (groups.week) return isoWeekStart(Number.parseInt(groups.year, 10), Number.parseInt(groups.week, 10));
  if (groups.month && groups.day) return validIsoDateParts(groups.year, groups.month, groups.day);
  return null;
}

function parseCommonMomentFilenameDate(filename: string, format: string): string | null {
  const monthNames = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
  const monthPattern = '(?<month>January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)';
  const dayPattern = '(?<day>\\d{1,2})(?:st|nd|rd|th)?';
  const yearPattern = '(?<year>\\d{4})';
  const patterns: Record<string, RegExp> = {
    'MMM D YYYY': new RegExp(`^${monthPattern} ${dayPattern} ${yearPattern}$`, 'iu'),
    'MMMM Do YYYY': new RegExp(`^${monthPattern} ${dayPattern} ${yearPattern}$`, 'iu'),
    'MMMM D YYYY': new RegExp(`^${monthPattern} ${dayPattern} ${yearPattern}$`, 'iu'),
    'dddd, MMMM Do YYYY': new RegExp(`^[A-Za-z]+, ${monthPattern} ${dayPattern} ${yearPattern}$`, 'iu'),
    'dddd, MMMM D YYYY': new RegExp(`^[A-Za-z]+, ${monthPattern} ${dayPattern} ${yearPattern}$`, 'iu'),
  };
  const match = patterns[format]?.exec(filename);
  const groups = match?.groups;
  if (!groups) return null;
  const month = monthNames.findIndex((name) => name.startsWith(groups.month.toLowerCase().replace(/^sept$/u, 'sep')));
  if (month < 0) return null;
  const date = new Date(Date.UTC(Number.parseInt(groups.year, 10), month, Number.parseInt(groups.day, 10)));
  const formatted = formatIsoUtcDate(date);
  return date.getUTCMonth() === month ? formatted : null;
}

function parseAdditionalWeeklyFilenameDate(filename: string, format: string): string | null {
  if (!format.includes('[W]') && !format.includes('ww')) return null;
  const escaped = escapeRegExp(format)
    .replace(/YYYY/gu, '(?<year>\\d{4})')
    .replace(/\\\[W\\\]/gu, 'W')
    .replace(/ww/gu, '(?<week>\\d{2})');
  const match = filename.match(new RegExp(`^${escaped}$`, 'u'));
  const groups = match?.groups;
  return groups?.year && groups.week ? isoWeekStart(Number.parseInt(groups.year, 10), Number.parseInt(groups.week, 10)) : null;
}

function isoWeekStart(year: number, week: number): string | null {
  if (week < 1 || week > 53) return null;
  const fourthJanuary = new Date(Date.UTC(year, 0, 4));
  const monday = addDateObject(fourthJanuary, 'day', -((fourthJanuary.getUTCDay() + 6) % 7));
  const start = formatIsoUtcDate(addDateObject(monday, 'day', (week - 1) * 7));
  if (week === 53 && start >= `${year + 1}-01-01`) return null;
  return start;
}

export function rewritePriorityField(rawLine: string, priority: string): string {
  const result = rawLine
    .replace(/\s+[\u{1F53A}\u{23EB}\u{1F53C}\u{1F53D}\u{23EC}]/gsu, '')
    .replace(/\s*[\[(]priority::\s*[^\])]+[\])]/giu, '');
  if (priority === 'normal') return result;
  const isDataview = /[\[(][A-Za-z][A-Za-z _-]*::/u.test(rawLine);
  if (isDataview) return `${result} [priority:: ${priority}]`;
  const symbol = ({ highest: '\u{1F53A}', high: '\u{23EB}', medium: '\u{1F53C}', low: '\u{1F53D}', lowest: '\u{23EC}' } as Record<string, string>)[priority];
  return symbol ? `${result} ${symbol}` : result;
}

function taskLineDepth(line: string): number {
  const parsed = line.match(/^((?:\s*>\s*)*)(\s*)/u);
  return (parsed?.[1]?.length ?? 0) + (parsed?.[2]?.length ?? 0);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** Type guard for TFile — works with the real Obsidian TFile and test mocks alike. */
function isVaultTFile(file: unknown): file is TFile {
  return Boolean(file && typeof file === 'object' && 'path' in file && 'extension' in file && 'basename' in file);
}

/**
 * Appends `line` under the `## heading` section in `content`.
 * If the section does not exist, creates it at the end of the file.
 */
function writeDurableRecurrenceCount(line: string, count: number): string {
  const field = `[recurrenceCount:: ${Math.max(0, Math.floor(count))}]`;
  if (/\[recurrenceCount::\s*\d+\]/iu.test(line)) return line.replace(/\[recurrenceCount::\s*\d+\]/iu, field);
  const blockLink = line.match(/(\s\^[\w-]+)\s*$/u);
  return blockLink
    ? `${line.slice(0, line.length - blockLink[0].length).trimEnd()} ${field}${blockLink[0]}`
    : `${line.trimEnd()} ${field}`;
}

function appendLineToSection(content: string, heading: string, line: string): string {
  const eol = content.includes('\r\n') ? '\r\n' : '\n';
  const normalized = content.replace(/\r\n/gu, '\n');
  const trimmedHeading = heading.trim() || 'Archived Tasks';

  let targetLevel: number | null = null;
  let insertOffset = normalized.length;
  let offset = 0;
  for (const match of normalized.matchAll(/.*(?:\n|$)/gu)) {
    if (!match[0]) break;
    const lineText = match[0].endsWith('\n') ? match[0].slice(0, -1) : match[0];
    const headingMatch = lineText.match(/^(#{1,6})\s+(.+?)(?:\s+#+\s*)?$/u);
    if (headingMatch) {
      const level = headingMatch[1].length;
      const text = headingMatch[2].trim();
      if (targetLevel !== null && level <= targetLevel) {
        insertOffset = offset;
        break;
      }
      if (targetLevel === null && text === trimmedHeading) {
        targetLevel = level;
      }
    }
    offset += match[0].length;
  }

  let updated: string;
  if (targetLevel === null) {
    const trimmed = normalized.replace(/\s*$/u, '');
    updated = trimmed ? `${trimmed}\n\n## ${trimmedHeading}\n${line}\n` : `## ${trimmedHeading}\n${line}\n`;
  } else {
    const before = normalized.slice(0, insertOffset).replace(/\s*$/u, '');
    const after = normalized.slice(insertOffset).replace(/^\s*/u, '');
    updated = after ? `${before}\n${line}\n\n${after}` : `${before}\n${line}\n`;
  }
  return eol === '\r\n' ? updated.replace(/\n/gu, '\r\n') : updated;
}

// Re-export file-backed task note functions
export { isTaskNoteFile, scanFileAsTask, scanFileWithTaskNotes, buildTaskNoteFrontmatter, serializeTaskNoteFrontmatter } from './task-scanner-ext';
