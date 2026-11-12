import { Notice } from 'obsidian';
import { formatLocalDate } from '../date-utils';
import { formatEditableTaskLine, parseEditableTaskLine } from '../modals/task-edit-helpers';
import type { CommandHost } from './command-host';
import { addDocumentedCommand } from './documented-command';
import { replaceEditorLineWithLines } from './command-helpers';

function todayDateString(): string { return formatLocalDate(new Date()); }

export function registerExportCommands(host: CommandHost): void {
  addDocumentedCommand(host, {
    id: 'export-tasks-csv',
    name: 'Export all tasks to CSV',
    icon: 'download',
    callback: async () => { await host.exportTasksCsv(); },
  });

  addDocumentedCommand(host, {
    id: 'copy-tasks-json',
    name: 'Copy all tasks as JSON',
    icon: 'clipboard',
    callback: async () => { await host.copyTasksJson(); },
  });

  addDocumentedCommand(host, {
    id: 'move-task-to-file',
    name: 'Move task at cursor to another note',
    icon: 'arrow-right-circle',
    editorCallback: (editor, view) => {
      const cursor = editor.getCursor();
      const currentLine = editor.getLine(cursor.line);
      const sourcePath = (view as { file?: { path?: string } }).file?.path ?? '';
      host.openMoveTaskModal(currentLine, cursor.line, editor, sourcePath);
    },
  });

  addDocumentedCommand(host, {
    id: 'generate-weekly-summary',
    name: 'Generate weekly completion summary',
    icon: 'calendar',
    callback: async () => { await host.generateCompletionSummary('week'); },
  });

  addDocumentedCommand(host, {
    id: 'generate-monthly-summary',
    name: 'Generate monthly completion summary',
    icon: 'calendar',
    callback: async () => { await host.generateCompletionSummary('month'); },
  });

  // ── Recurrence Series Management ───────────────────────────────────────────────
  addDocumentedCommand(host, {
    id: 'skip-task-occurrence',
    name: 'Skip this recurrence (advance counter)',
    icon: 'skip-forward',
    editorCallback: async (editor, view) => {
      const cursor = editor.getCursor();
      const currentLine = editor.getLine(cursor.line);
      const parsed = parseEditableTaskLine(currentLine);
      if (!parsed.checkbox || !parsed.recurrence) {
        new Notice('Task Manager: cursor is not on a recurring task.');
        return;
      }
      const sourcePath = (view as { file?: { path?: string } }).file?.path ?? host.app.workspace.getActiveFile()?.path ?? 'editor';
      const seriesId = host.ensureEditableRecurrenceSeriesId(parsed, sourcePath, cursor.line + 1);
      const occurrenceDate = host.currentEditableOccurrenceDate(parsed) ?? todayDateString();
      await host.stateStore.updateState((state) => host.stateStore.addRecurrenceException(state, {
        seriesId,
        date: occurrenceDate,
        reason: 'skipped',
        note: `Skipped from ${sourcePath}:${cursor.line + 1}`,
      }));
      // Advance the recurrence counter without marking done
      const { advanceOccurrenceCounter } = await import('../recurrence-series');
      const newCount = advanceOccurrenceCounter(parsed.recurrenceCount ? Number.parseInt(parsed.recurrenceCount, 10) : 0);
      parsed.recurrenceCount = String(newCount);
      const updated = formatEditableTaskLine(parsed, host.settings.taskFormat);
      replaceEditorLineWithLines(editor, cursor.line, [updated]);
      new Notice(`Skipped occurrence on ${occurrenceDate} (counter: ${newCount})`);
    },
  });

  addDocumentedCommand(host, {
    id: 'complete-without-next',
    name: 'Complete recurring task without generating next',
    icon: 'check-square',
    editorCallback: async (editor, view) => {
      const cursor = editor.getCursor();
      const currentLine = editor.getLine(cursor.line);
      const parsed = parseEditableTaskLine(currentLine);
      if (!parsed.checkbox || !parsed.recurrence) {
        new Notice('Task Manager: cursor is not on a recurring task.');
        return;
      }
      const sourcePath = (view as { file?: { path?: string } }).file?.path ?? host.app.workspace.getActiveFile()?.path ?? 'editor';
      const seriesId = host.ensureEditableRecurrenceSeriesId(parsed, sourcePath, cursor.line + 1);
      const doneSymbol = host.settings.supportedStates.find((s) => s.type === 'done')?.rawText ?? 'x';
      const nextOccurrence = host.nextEditableOccurrenceDate(currentLine, doneSymbol);
      if (nextOccurrence) {
        await host.stateStore.updateState((state) => host.stateStore.addRecurrenceException(state, {
          seriesId,
          date: nextOccurrence,
          reason: 'deleted',
          note: `Suppressed by complete-without-next at ${sourcePath}:${cursor.line + 1}`,
        }));
      }
      parsed.checkbox = doneSymbol;
      parsed.done = todayDateString();
      const updated = formatEditableTaskLine(parsed, host.settings.taskFormat);
      replaceEditorLineWithLines(editor, cursor.line, [updated]);
      void host.mutationLog.logMutation({
        source: 'ui',
        action: 'complete',
        taskKey: `${sourcePath}:${cursor.line + 1}`,
        before: { line: currentLine },
        after: { line: updated, suppressedNextOccurrence: nextOccurrence ?? null, seriesId },
        description: nextOccurrence
          ? `Marked recurring task done and suppressed next occurrence ${nextOccurrence}.`
          : 'Marked recurring task done; no next occurrence could be projected.',
      });
      new Notice(nextOccurrence
        ? `Task marked done. Next occurrence ${nextOccurrence} suppressed.`
        : 'Task marked done. No next occurrence could be projected to suppress.');
    },
  });

  // ── Feature 1: iCal export ─────────────────────────────────────────────────────
  addDocumentedCommand(host, {
    id: 'export-tasks-ical',
    name: 'Export all tasks as iCal (.ics)',
    icon: 'calendar',
    callback: async () => { await host.exportTasksIcal(); },
  });

  // ── Feature 2: Promote task to note ──────────────────────────────────────────
  addDocumentedCommand(host, {
    id: 'promote-task-to-note',
    name: 'Promote task at cursor to note',
    icon: 'file-plus',
    editorCallback: (editor, view) => { void host.promoteTaskToNote(editor, view); },
  });

  // Convert file-backed task to inline
  addDocumentedCommand(host, {
    id: 'convert-file-to-inline',
    name: 'Convert file-backed task to inline task',
    icon: 'file-minus',
    callback: async () => { await host.convertFileTaskToInline(); },
  });

  // ── Feature 5: Todoist sync ─────────────────────────────────────────────────────────
}
