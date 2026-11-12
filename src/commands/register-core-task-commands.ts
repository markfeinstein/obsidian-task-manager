import { Notice } from 'obsidian';
import { openTaskAttributePicker } from '../task-attribute-picker';
import { formatTaskManagerQueryBlock, sampleTaskManagerQuery } from '../query-renderer';
import { QueryBuilderModal } from '../query-builder';
import { DASHBOARD_WIDGET_CODE_BLOCK } from '../dashboard';
import { t } from '../i18n';
import { MigrationWizardModal, performMigration } from '../migration-wizard';
import { SavedTaskQueryModal } from '../modals/simple-modals';
import { TaskEditModal } from '../modals/task-edit-modal';
import {
  editorCommandMenuPosition,
  formatEditableTaskLine,
  parseEditableTaskLine,
  resolveNlTaskDescription,
  rewriteSubmittedTaskLineForModal,
  rewriteTaskLineForStatusWithLifecycle,
  syntheticContextMenuEvent,
} from '../modals/task-edit-helpers';
import { cycleTaskCheckbox } from '../task-model';
import { durableCompletionDestinationAction } from '../task-scanner';
import { formatLocalDate } from '../date-utils';
import type { CommandHost } from './command-host';
import { addDocumentedCommand, addDocumentedDynamicCommand } from './documented-command';
import { commandSafeId, replaceEditorLineWithLines, showDurableLifecycleEditorNotice } from './command-helpers';

function todayDateString(): string { return formatLocalDate(new Date()); }

function toggleTargetCheckbox(line: string, settings: CommandHost['settings']): string {
  const parsed = parseEditableTaskLine(line);
  const doneState = settings.supportedStates.find((state) => state.type === 'done')?.rawText ?? 'x';
  const todoState = settings.supportedStates.find((state) => state.type === 'todo')?.rawText ?? ' ';
  const isDone = settings.supportedStates.find((state) => state.rawText === parsed.checkbox)?.type === 'done';
  return isDone ? todoState : doneState;
}

export function registerCoreTaskCommands(host: CommandHost): void {
  addDocumentedCommand(host, {
    id: 'set-task-attribute',
    name: 'Set task attribute',
    icon: 'list-plus',
    editorCallback: (editor) => {
      const view = (editor as unknown as { cm?: import('@codemirror/view').EditorView }).cm;
      if (!view) return;
      openTaskAttributePicker(host.app, view, () => host.settings);
    },
  });

  addDocumentedCommand(host, {
    id: 'scan-vault',
    name: 'Rescan vault now',
    icon: 'refresh-cw',
    callback: async () => {
      await host.scanVault();
    },
  });

  addDocumentedCommand(host, {
    id: 'scan-current-file',
    name: 'Rescan current file',
    icon: 'refresh-cw',
    checkCallback: (checking) => {
      const file = host.app.workspace.getActiveFile();
      if (!file || file.extension !== 'md') {
        return false;
      }
      if (!checking) {
        void host.scanFile(file).then(() => new Notice(`Task Manager scanned ${file.path}`));
      }
      return true;
    },
  });

  addDocumentedCommand(host, {
    id: 'reset-state-cache',
    name: 'Reset task snapshot and dedupe cache',
    icon: 'trash-2',
    callback: async () => {
      await host.resetStateCache();
      new Notice('Task Manager state cache reset');
    },
  });

  addDocumentedCommand(host, {
    id: 'show-status-diagnostics',
    name: 'Show task status diagnostics',
    icon: 'alert-circle',
    callback: async () => {
      await host.showStatusDiagnostics();
    },
  });

  addDocumentedCommand(host, {
    id: 'insert-query-template',
    name: 'Insert query template',
    icon: 'copy',
    editorCallback: (editor) => {
      editor.replaceSelection(sampleTaskManagerQuery(host.settings.queryCodeBlockName));
    },
  });

  addDocumentedCommand(host, {
    id: 'open-query-builder',
    name: 'Open visual query builder',
    icon: 'sliders-horizontal',
    editorCallback: (editor) => {
      new QueryBuilderModal(host.app, (query) => {
        editor.replaceSelection(formatTaskManagerQueryBlock(query, host.settings.queryCodeBlockName));
      }).open();
    },
  });

  addDocumentedCommand(host, {
    id: 'create-task',
    name: 'Create task',
    icon: 'plus',
    editorCallback: (editor) => {
      new TaskEditModal(host.app, host.settings, '', (line) => {
        const replacement = rewriteSubmittedTaskLineForModal(line, host.settings);
        if (!replacement) {
          throw new Error('Archive/collect completion requires a saved task. Save the note, then complete it from a query, dashboard, or reading view.');
        }
        editor.replaceSelection(replacement.join('\n'));
      }, undefined, {}, undefined, () => host.saveSettings()).open();
    },
  });

  addDocumentedCommand(host, {
    id: 'edit-task-at-cursor',
    name: 'Edit task at cursor',
    icon: 'pencil',
    editorCallback: (editor) => {
      const cursor = editor.getCursor();
      const currentLine = editor.getLine(cursor.line);
      new TaskEditModal(host.app, host.settings, currentLine, (line) => {
        const newLines = rewriteSubmittedTaskLineForModal(line, host.settings);
        if (!newLines) {
          throw new Error('Archive/collect completion requires a saved task. Save the note, then complete it from a query, dashboard, or reading view.');
        }
        replaceEditorLineWithLines(editor, cursor.line, newLines);
        // Cursor after modal (#25): place cursor at end of the last updated line.
        const lastLineIdx = cursor.line + newLines.length - 1;
        const lastLine = editor.getLine(lastLineIdx);
        editor.setCursor({ line: lastLineIdx, ch: lastLine?.length ?? 0 });
      }, undefined, {}, undefined, () => host.saveSettings()).open();
    },
  });

  addDocumentedCommand(host, {
    id: 'toggle-task-done',
    name: 'Toggle task done',
    icon: 'check-circle',
    editorCallback: (editor, view) => {
      const cursor = editor.getCursor();
      const currentLine = editor.getLine(cursor.line);
      const targetCheckbox = toggleTargetCheckbox(currentLine, host.settings);
      const filePath = view?.file?.path ?? host.app?.workspace?.getActiveFile?.()?.path ?? '';
      if (host.shouldFilterEditorRecurrenceExceptions(currentLine, filePath)) {
        void host.rewriteEditorTaskLineForStatusWithLifecycle(currentLine, targetCheckbox, filePath, cursor.line + 1).then((replacement) => {
          if (replacement) replaceEditorLineWithLines(editor, cursor.line, replacement);
          else if (durableCompletionDestinationAction(currentLine, targetCheckbox, host.settings.supportedStates, host.settings)) showDurableLifecycleEditorNotice();
        });
        return;
      }
      const replacement = rewriteTaskLineForStatusWithLifecycle(currentLine, targetCheckbox, host.settings);
      if (replacement) {
        replaceEditorLineWithLines(editor, cursor.line, replacement);
        return;
      }
      if (durableCompletionDestinationAction(currentLine, targetCheckbox, host.settings.supportedStates, host.settings)) {
        showDurableLifecycleEditorNotice();
        return;
      }
      // List item (- text) → convert to checklist item
      const listItemMatch = currentLine.match(/^(\s*(?:[-*+]|\d+[.)])\s+)(.*)$/u);
      if (listItemMatch) {
        editor.setLine(cursor.line, `${listItemMatch[1]}[ ] ${listItemMatch[2]}`);
        return;
      }
      // Plain text line → prepend as a checklist item
      const indentMatch = currentLine.match(/^(\s*)(.*)/u);
      if (indentMatch && indentMatch[2].trim()) {
        editor.setLine(cursor.line, `${indentMatch[1]}- [ ] ${indentMatch[2]}`);
        return;
      }
      // Blank/whitespace-only line → create a new empty task, preserving indent
      if (currentLine.trim() === '') {
        const indent = indentMatch ? indentMatch[1] : '';
        const newLine = `${indent}- [ ] `;
        editor.setLine(cursor.line, newLine);
        editor.setCursor({ line: cursor.line, ch: newLine.length });
        return;
      }
      new Notice('Cannot toggle status: line is not a task or does not match global filter');
    },
  });

  addDocumentedCommand(host, {
    id: 'cycle-task-status',
    name: 'Cycle task status',
    icon: 'rotate-cw',
    editorCallback: (editor, view) => {
      const cursor = editor.getCursor();
      const currentLine = editor.getLine(cursor.line);
      const parsed = parseEditableTaskLine(currentLine);
      const nextCheckbox = cycleTaskCheckbox(parsed.checkbox, host.settings.supportedStates);
      const filePath = view?.file?.path ?? host.app?.workspace?.getActiveFile?.()?.path ?? '';
      if (host.shouldFilterEditorRecurrenceExceptions(currentLine, filePath)) {
        void host.rewriteEditorTaskLineForStatusWithLifecycle(currentLine, nextCheckbox, filePath, cursor.line + 1).then((replacement) => {
          if (replacement) replaceEditorLineWithLines(editor, cursor.line, replacement);
          else new Notice('Cannot cycle status: line is not a task');
        });
        return;
      }
      const replacement = rewriteTaskLineForStatusWithLifecycle(currentLine, nextCheckbox, host.settings);
      if (replacement) {
        replaceEditorLineWithLines(editor, cursor.line, replacement);
        return;
      }
      new Notice('Cannot cycle status: line is not a task');
    },
  });

  addDocumentedCommand(host, {
    id: 'duplicate-task',
    name: 'Duplicate task at cursor',
    icon: 'copy',
    editorCallback: (editor) => {
      const cursor = editor.getCursor();
      const line = editor.getLine(cursor.line);
      const parsed = parseEditableTaskLine(line);
      if (!parsed.checkbox) {
        new Notice('Task Manager: cursor is not on a task line.');
        return;
      }
      // Reset completion/identity fields on the duplicate
      const todoSymbol = host.settings.supportedStates.find((s) => s.type === 'todo')?.rawText ?? ' ';
      const duplicate = formatEditableTaskLine(
        { ...parsed, checkbox: todoSymbol, done: '', cancelled: '', id: '' },
        host.settings.taskFormat,
      );
      // Preserve leading whitespace/list-marker from original line
      const indentMatch = line.match(/^(\s*(?:[-*+]|\d+[.)]))\s/u);
      const prefix = indentMatch ? indentMatch[1] + ' ' : '- ';
      const fullLine = prefix + duplicate.replace(/^(?:\s*(?:[-*+]|\d+[.)])\s+)/u, '');
      editor.replaceRange('\n' + fullLine, { line: cursor.line, ch: line.length });
      editor.setCursor({ line: cursor.line + 1, ch: fullLine.length });
    },
  });

  addDocumentedCommand(host, {
    id: 'copy-task-wikilink',
    name: 'Copy task as wikilink',
    icon: 'link',
    editorCallback: (editor) => {
      const cursor = editor.getCursor();
      const line = editor.getLine(cursor.line);
      const parsed = parseEditableTaskLine(line);
      if (!parsed.checkbox) {
        new Notice('Task Manager: cursor is not on a task line.');
        return;
      }
      const activeFile = host.app.workspace.getActiveFile();
      if (!activeFile) {
        new Notice('Task Manager: no active file.');
        return;
      }
      const filename = activeFile.basename;
      const slug = parsed.description
        .toLowerCase()
        .replace(/\s+/gu, '-')
        .replace(/[^a-z0-9-]/gu, '')
        .slice(0, 50);
      const wikilink = slug ? `[[${filename}#${slug}]]` : `[[${filename}]]`;
      void navigator.clipboard.writeText(wikilink).then(() => new Notice(`Copied: ${wikilink}`));
    },
  });

  addDocumentedCommand(host, {
    id: 'postpone-task',
    name: 'Postpone task',
    icon: 'forward',
    editorCallback: (editor, view) => {
      const file = view?.file;
      if (!file) {
        new Notice('No file in current view');
        return;
      }
      const cursor = editor.getCursor();
      const line = editor.getLine(cursor.line);

      // Parse the task to check if it's valid
      const taskLine = host.scanner.parseTaskLine(line, file.path, cursor.line + 1);
      if (!taskLine) {
        new Notice('No task at cursor');
        return;
      }

      const field = host.firstDeferrableField(taskLine);
      if (!field) {
        new Notice('Task has no due/scheduled/start date to postpone');
        return;
      }

      const syntheticEvent = syntheticContextMenuEvent(editorCommandMenuPosition(editor, cursor));
      host.openInlineDeferMenu(syntheticEvent, file, taskLine);
    },
  });

  for (const state of host.settings.supportedStates) {
    if (state.availableAsCommand === false) continue;
    addDocumentedDynamicCommand(host, 'status-change', {
      id: `change-status-to-${commandSafeId(state.rawText === ' ' ? 'space' : state.rawText)}`,
      name: `Change status to: [- [${state.rawText}] ] ${state.name}`,
      icon: 'circle-check',
      editorCallback: (editor, view) => {
        const cursor = editor.getCursor();
        const currentLine = editor.getLine(cursor.line);
        const filePath = view?.file?.path ?? host.app?.workspace?.getActiveFile?.()?.path ?? '';
        if (host.shouldFilterEditorRecurrenceExceptions(currentLine, filePath)) {
          void host.rewriteEditorTaskLineForStatusWithLifecycle(currentLine, state.rawText, filePath, cursor.line + 1).then((updated) => {
            if (!updated) {
              new Notice('Cannot set status: line is not a task or does not match global filter');
              return;
            }
            replaceEditorLineWithLines(editor, cursor.line, updated);
          });
          return;
        }
        const updated = rewriteTaskLineForStatusWithLifecycle(currentLine, state.rawText, host.settings);
        if (!updated) {
          new Notice('Cannot set status: line is not a task or does not match global filter');
          return;
        }
        replaceEditorLineWithLines(editor, cursor.line, updated);
      },
    });
  }

  addDocumentedCommand(host, {
    id: 'add-query-file-defaults-properties',
    name: 'Add all Query File Defaults properties',
    icon: 'settings',
    checkCallback: (checking) => {
      const file = host.app.workspace.getActiveFile();
      if (!file || file.extension !== 'md') return false;
      if (!checking) {
        void host.addQueryFileDefaultsProperties(file);
      }
      return true;
    },
  });

  addDocumentedCommand(host, {
    id: 'insert-saved-query',
    name: 'Insert saved task query',
    icon: 'list',
    editorCallback: (editor) => {
      const queries = host.settings.savedQueries;
      if (queries.length === 0) {
        new Notice('Task Manager has no saved queries');
        return;
      }
      if (queries.length === 1) {
        editor.replaceSelection(formatTaskManagerQueryBlock(queries[0].query, host.settings.queryCodeBlockName));
        return;
      }
      new SavedTaskQueryModal(host.app, queries, (query) => {
        editor.replaceSelection(formatTaskManagerQueryBlock(query.query, host.settings.queryCodeBlockName));
      }).open();
    },
  });

  addDocumentedCommand(host, {
    id: 'open-todays-daily-note',
    name: 'Open today’s daily note',
    icon: 'calendar',
    callback: async () => {
      const dailyNote = await host.dailyNoteResolver.resolveToday();
      await host.app.workspace.getLeaf(false).openFile(dailyNote.file);
    },
  });

  addDocumentedCommand(host, {
    id: 'log-test-entry',
    name: 'Log a test entry to today’s daily note',
    icon: 'edit-3',
    callback: async () => {
      const dailyNote = await host.dailyNoteResolver.resolveToday();
      await host.logWriter.appendToDailyLog(dailyNote.file, {
        text: 'Task Manager test entry',
        sourcePath: dailyNote.path,
        completedAt: new Date(),
      });
      new Notice('Task Manager test entry logged');
    },
  });

  addDocumentedCommand(host, {
    id: 'convert-line-to-task',
    name: 'Convert line to task',
    icon: 'check-square',
    editorCallback: (editor) => {
      const cursor = editor.getCursor();
      const line = editor.getLine(cursor.line);

      // Already a task — nothing to do
      if (/^(?:\s*>\s*)*\s*(?:[-*+]|\d+[.)])\s+\[/u.test(line)) {
        new Notice('Line is already a task');
        return;
      }

      let newLine: string;

      // List item: inject [ ] after the marker
      const listItemMatch = line.match(/^((?:\s*>\s*)*)(\s*)([-*+]|\d+[.)])(\s+)(.*)$/u);
      if (listItemMatch) {
        const [, prefix, indent, marker, space, text] = listItemMatch;
        const createdSuffix = text && host.settings.setCreatedDate ? ` ➕ ${todayDateString()}` : '';
        newLine = `${prefix}${indent}${marker}${space}[ ] ${text}${createdSuffix}`;
      } else {
        // Plain text: wrap as a task list item
        const indentMatch = line.match(/^((?:\s*>\s*)*)(\s*)(.*)/u);
        const prefix = indentMatch?.[1] ?? '';
        const indent = indentMatch?.[2] ?? '';
        const text = indentMatch?.[3]?.trim() ?? '';
        const createdSuffix = text && host.settings.setCreatedDate ? ` ➕ ${todayDateString()}` : '';
        newLine = `${prefix}${indent}- [ ] ${text}${createdSuffix}`;
      }

      editor.setLine(cursor.line, newLine);
    },
  });

  addDocumentedCommand(host, {
    id: 'convert-line-to-nl-task',
    name: 'Convert line to task (parse natural language)',
    icon: 'wand-2',
    editorCallback: (editor) => {
      const cursor = editor.getCursor();
      const line = editor.getLine(cursor.line);

      // Extract existing task prefix + description from task lines, or use the whole line
      let prefix = '';
      let indent = '';
      let text = '';

      const taskMatch = line.match(/^((?:\s*>\s*)*)(\s*)([-*+]|\d+[.)])\s+(?:\[[^\]]*\]\s+)?(.*)/u);
      if (taskMatch) {
        prefix = taskMatch[1];
        indent = taskMatch[2];
        text = taskMatch[4].trim();
      } else {
        const plainMatch = line.match(/^((?:\s*>\s*)*)(\s*)(.*)/u);
        prefix = plainMatch?.[1] ?? '';
        indent = plainMatch?.[2] ?? '';
        text = plainMatch?.[3]?.trim() ?? '';
      }

      if (!text) { new Notice('Task Manager: nothing to parse on this line'); return; }

      const expanded = resolveNlTaskDescription(text, todayDateString());
      const newLine = `${prefix}${indent}- [ ] ${expanded}`;
      editor.setLine(cursor.line, newLine);
      new Notice('Task Manager: parsed natural language task');
    },
  });

  addDocumentedCommand(host, {
    id: 'show-completion-stats',
    name: 'Show completion statistics',
    icon: 'bar-chart-2',
    callback: async () => {
      const stats = await host.computeCompletionStats(7);
      const streakText = stats.streak === 1 ? '1 day' : `${stats.streak} days`;
      const summary = [
        `Completions — last 7 days: ${stats.total}`,
        `Today: ${stats.today}`,
        `Streak: ${streakText}`,
      ].join('\n');
      new Notice(summary, 8000);
    },
  });

  addDocumentedCommand(host, {
    id: 'open-task-panel',
    name: 'Open Task Manager Sidebar',
    icon: 'layout-sidebar-right',
    callback: async () => { await host.openTaskPanel(); },
  });

  addDocumentedCommand(host, {
    id: 'open-getting-started',
    name: t('onboarding.command.open'),
    icon: 'sparkles',
    callback: () => { host.openGettingStarted(); },
  });

  addDocumentedCommand(host, {
    id: 'open-dashboard',
    name: 'Open dashboard',
    icon: 'layout-dashboard',
    callback: () => { void host.openDashboard(); },
  });

  addDocumentedCommand(host, {
    id: 'save-dashboard-as-note',
    name: 'Save active dashboard as note',
    icon: 'file-plus',
    callback: async () => { await host.saveActiveDashboardAsNote(); },
  });

  addDocumentedCommand(host, {
    id: 'insert-dashboard-widget-block',
    name: 'Insert task dashboard widget block',
    icon: 'panel-top',
    editorCallback: (editor) => {
      editor.replaceSelection(`\
\`\`\`${DASHBOARD_WIDGET_CODE_BLOCK}\ntype: agenda\ntitle: Agenda\nsize: large\n\`\`\`\n`);
    },
  });

  addDocumentedCommand(host, {
    id: 'insert-daily-todos-widget-block',
    name: 'Insert daily tasks widget block',
    icon: 'list-checks',
    editorCallback: (editor) => {
      editor.replaceSelection(`\
\`\`\`${DASHBOARD_WIDGET_CODE_BLOCK}\ntype: daily-todos\ntitle: Tasks\n\`\`\`\n`);
    },
  });

  addDocumentedCommand(host, {
    id: 'open-table-view',
    name: 'Open task table view',
    icon: 'table',
    callback: () => { void host.openVisualTaskView('table'); },
  });

  addDocumentedCommand(host, {
    id: 'open-kanban-view',
    name: 'Open task kanban view',
    icon: 'kanban',
    callback: () => { void host.openVisualTaskView('kanban'); },
  });

  addDocumentedCommand(host, {
    id: 'open-calendar-view',
    name: 'Open task calendar view',
    icon: 'calendar-days',
    callback: () => { void host.openVisualTaskView('calendar'); },
  });

  addDocumentedCommand(host, {
    id: 'quick-capture-task',
    name: 'Quick capture task',
    icon: 'zap',
    callback: () => { host.openQuickCaptureModal(); },
  });

  addDocumentedCommand(host, {
    id: 'quick-add-google-calendar-task',
    name: 'Quick add Google Calendar task',
    icon: 'calendar-plus',
    callback: () => { host.openGoogleCalendarQuickCaptureModal(); },
  });

  addDocumentedCommand(host, {
    id: 'open-migration-wizard',
    name: 'Copy vault tasks to task notes',
    icon: 'wand-2',
    callback: () => {
      new MigrationWizardModal(host.app, async (options) => {
        const tasks = host.apiV1.getAllTasks();
        return performMigration(host.app, tasks, options);
      }).open();
    },
  });

  addDocumentedCommand(host, {
    id: 'open-query-editor',
    name: 'Open task query editor',
    icon: 'list-filter',
    editorCallback: (editor) => { host.openQueryEditorAtCursor(editor); },
  });

  addDocumentedCommand(host, {
    id: 'voice-capture-task',
    name: 'Voice capture task (speech to task)',
    icon: 'mic',
    callback: () => { host.openVoiceCaptureModal(); },
  });

  addDocumentedCommand(host, {
    id: 'quick-add-task',
    name: 'Quick add task (natural language)',
    icon: 'pencil',
    callback: () => { host.openQuickAddModal(); },
  });

  addDocumentedCommand(host, {
    id: 'insert-task-from-template',
    name: 'Insert task from template',
    icon: 'file-text',
    callback: () => { host.openTemplateModal(); },
  });
}
