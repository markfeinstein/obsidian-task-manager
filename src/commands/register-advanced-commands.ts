import { Notice, type TFile } from 'obsidian';
import { DiagnosticsModal } from '../modals/diagnostics-modal';
import { PomodoroModal } from '../modals/pomodoro-modal';
import type { CommandHost } from './command-host';
import { addDocumentedCommand } from './documented-command';

export function registerAdvancedCommands(host: CommandHost): void {
  addDocumentedCommand(host, {
    id: 'start-pomodoro',
    name: 'Start Pomodoro for task at cursor',
    icon: 'timer',
    editorCallback: (editor, view) => {
      const file = (view as { file?: TFile }).file;
      if (!file) { new Notice('No active file'); return; }
      const cursor = editor.getCursor();
      const line = editor.getLine(cursor.line);
      const task = host.scanner.parseTaskLine(line, file.path, cursor.line + 1);
      if (!task) { new Notice('No task at cursor'); return; }
      new PomodoroModal(host.app, host.settings, task, host.scanner).open();
    },
  });

  addDocumentedCommand(host, {
    id: 'generate-task-command-center',
    name: 'Generate task command center dashboard',
    icon: 'layout-dashboard',
    callback: async () => { await host.generateTaskCommandCenter(); },
  });

  addDocumentedCommand(host, {
    id: 'generate-task-health-report',
    name: 'Generate task health and repair report',
    icon: 'stethoscope',
    callback: async () => { await host.generateTaskHealthReport(); },
  });

  addDocumentedCommand(host, {
    id: 'show-plugin-diagnostics',
    name: 'Show plugin diagnostics dashboard',
    icon: 'activity',
    callback: () => { new DiagnosticsModal(host.app, host, host.settings).open(); },
  });

  addDocumentedCommand(host, {
    id: 'generate-bases-task-views',
    name: 'Generate Obsidian Bases task views',
    icon: 'table',
    callback: async () => { await host.generateBasesTaskViews(); },
  });

  addDocumentedCommand(host, {
    id: 'import-canvas-tasks',
    name: 'Import tasks from Canvas cards',
    icon: 'git-pull-request',
    callback: async () => { await host.importCanvasTasks(); },
  });

  addDocumentedCommand(host, {
    id: 'archive-completed-tasks-current-file',
    name: 'Archive completed tasks in current file',
    icon: 'archive',
    editorCallback: async (_editor, view) => {
      const file = (view as { file?: TFile }).file;
      if (!file) { new Notice('No active file'); return; }
      await host.archiveCompletedTasksInFile(file);
    },
  });

  addDocumentedCommand(host, {
    id: 'convert-reminder-syntax-current-file',
    name: 'Convert Reminder plugin syntax in current file',
    icon: 'bell-ring',
    editorCallback: async (_editor, view) => {
      const file = (view as { file?: TFile }).file;
      if (!file) { new Notice('No active file'); return; }
      await host.convertReminderSyntaxInFile(file);
    },
  });
}
