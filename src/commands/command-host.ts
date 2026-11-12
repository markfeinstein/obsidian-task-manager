import type { App, Command, Editor, MarkdownFileInfo, MarkdownView, TFile } from 'obsidian';
import type { TaskManagerSettings } from '../types';
import type { ParsedTask, TaskScanner } from '../task-scanner';
import type { StateStore } from '../state-store';
import type { DailyNoteResolver } from '../daily-note';
import type { LogWriter } from '../log-writer';
import type { MutationLog } from '../mutation-log';
import type { EditableTaskLine } from '../modals/task-edit-helpers';
import type { DiagnosticsFacade } from '../modals/diagnostics-modal';

/**
 * The command layer's complete view of the plugin composition root.
 *
 * Keeping this contract separate from main.ts prevents command registration
 * modules from reaching back into the plugin class or importing the
 * composition root. Command callbacks still dispatch to the same bound plugin
 * operations as before.
 */
export interface CommandHost extends DiagnosticsFacade {
  addCommand(command: Command): void;
  readonly app: App;
  readonly settings: TaskManagerSettings;
  readonly scanner: TaskScanner;
  readonly apiV1: { getAllTasks(): ParsedTask[] };
  readonly dailyNoteResolver: DailyNoteResolver;
  readonly logWriter: LogWriter;
  readonly mutationLog: MutationLog;
  readonly stateStore: StateStore;

  addQueryFileDefaultsProperties(...args: unknown[]): unknown;
  appendDailyStatsSummary(...args: unknown[]): unknown;
  archiveCompletedTasksInFile(file: TFile): Promise<void>;
  computeCompletionStats(days: number): Promise<{ total: number; today: number; streak: number }>;
  convertFileTaskToInline(...args: unknown[]): unknown;
  convertReminderSyntaxInFile(file: TFile): Promise<void>;
  copyTasksJson(): Promise<void>;
  createProjectWorkspace(): unknown;
  currentEditableOccurrenceDate(task: EditableTaskLine): string | null;
  ensureEditableRecurrenceSeriesId(task: EditableTaskLine, filePath: string, lineNumber: number): string;
  exportBasesIndex(...args: unknown[]): unknown;
  exportTasksAsKanban(): Promise<void>;
  exportTasksCsv(): Promise<void>;
  exportTasksIcal(): Promise<void>;
  exportTasksJson(): Promise<void>;
  exportTasksYaml(): Promise<void>;
  firstDeferrableField(task: ParsedTask): 'due' | 'scheduled' | 'start' | null;
  generateBasesTaskViews(): Promise<void>;
  generateCompletionSummary(period: 'week' | 'month'): Promise<void>;
  generateTaskCommandCenter(): Promise<void>;
  generateTaskHealthReport(): Promise<void>;
  importAppleRemindersFromClipboard(): Promise<void>;
  importCanvasTasks(): Promise<void>;
  importIcsCalendar(): Promise<void>;
  nextEditableOccurrenceDate(rawLine: string, doneCheckbox: string): string | null;
  openDashboard(): Promise<void>;
  openGettingStarted(): void;
  openGoogleCalendarQuickCaptureModal(): void;
  openInlineDeferMenu(...args: unknown[]): unknown;
  openMoveTaskModal(taskLine: string, lineIndex: number, editor: Editor, sourcePath: string): void;
  openTaskPanel(): Promise<void>;
  openQueryEditorAtCursor(editor: Editor): void;
  openQuickAddModal(): void;
  openQuickCaptureModal(): void;
  openSyncConflictReport(): Promise<void>;
  openTemplateModal(): void;
  openVisualTaskView(...args: unknown[]): unknown;
  openVoiceCaptureModal(): void;
  projectNameForTask(task: ParsedTask): string;
  promoteTaskToNote(editor: Editor, view: MarkdownView | MarkdownFileInfo): Promise<void>;
  publishICSFeed(): Promise<void>;
  refreshCurrentProjectWorkspace(): Promise<void>;
  resetStateCache(): Promise<void>;
  rewriteEditorTaskLineForStatusWithLifecycle(line: string, checkbox: string, filePath: string, lineNumber: number): Promise<string[] | null>;
  saveActiveDashboardAsNote(): Promise<void>;
  saveSettings(): Promise<void>;
  scanFile(file: TFile): Promise<void>;
  scanVault(): Promise<void>;
  shouldFilterEditorRecurrenceExceptions(line: string, filePath: string): boolean;
  showStatusDiagnostics(): unknown;
  startWeeklyReview(): unknown;
  syncAppleReminders(): unknown;
  syncCalDAV(): Promise<void>;
  syncGoogleCalendar(): Promise<void>;
  syncGoogleTasks(): Promise<void>;
  syncMsToDo(): Promise<void>;
  syncTodoist(): Promise<void>;
}

/** Adapt the composition root once, without making command modules import it. */
export function commandHost(value: unknown): CommandHost {
  return value as CommandHost;
}
