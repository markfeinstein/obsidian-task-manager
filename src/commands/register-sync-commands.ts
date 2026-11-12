import { Notice } from 'obsidian';
import { exportAndOpenTasksAsCanvas } from '../canvas-exporter';
import { AdvancedFindModal } from '../advanced-find-modal';
import { AiQueryModal } from '../modals/ai-query-modal';
import { DailyPlannerModal } from '../modals/daily-planner-modal';
import { QuickFindTaskModal, SavedQueryPreviewModal, WorkingOnModal } from '../modals/simple-modals';
import type { CommandHost } from './command-host';
import { addDocumentedCommand } from './documented-command';
import { requestTaskManagerSettingsTab } from '../settings-navigation';

interface AppWithSettings {
  setting?: { open?: () => void; openTabById?: (id: string) => void };
}

export function registerSyncCommands(host: CommandHost): void {
  addDocumentedCommand(host, {
    id: 'explore-integrations',
    name: 'Explore Task Manager integrations',
    icon: 'plug',
    callback: () => {
      requestTaskManagerSettingsTab('sync');
      const settings = (host.app as unknown as AppWithSettings).setting;
      settings?.open?.();
      settings?.openTabById?.('task-manager');
    },
  });

  addDocumentedCommand(host, {
    id: 'sync-todoist',
    name: 'Sync with Todoist',
    icon: 'refresh-cw',
    checkCallback: (checking) => {
      if (!host.settings.todoistSyncEnabled) return false;
      if (!checking) void host.syncTodoist();
      return true;
    },
  });

  addDocumentedCommand(host, {
    id: 'open-sync-conflict-report',
    name: 'Open sync conflict report',
    icon: 'list-restart',
    callback: async () => { await host.openSyncConflictReport(); },
  });

  // ── Feature 6: Daily planning assistant ──────────────────────────────────────────
  addDocumentedCommand(host, {
    id: 'open-daily-planner',
    name: 'Open daily planning assistant',
    icon: 'calendar-days',
    callback: () => { new DailyPlannerModal(host.app, host.settings, host.scanner, host.dailyNoteResolver).open(); },
  });

  addDocumentedCommand(host, {
    id: 'quick-find-task',
    name: 'Quick find task',
    icon: 'search',
    callback: () => { new QuickFindTaskModal(host.app, host.scanner, host.settings).open(); },
  });

  addDocumentedCommand(host, {
    id: 'advanced-find-task',
    name: 'Advanced find task',
    icon: 'search-check',
    callback: () => { new AdvancedFindModal(host.app, () => host.apiV1.getAllTasks(), () => host.settings).open(); },
  });

  addDocumentedCommand(host, {
    id: 'sync-google-tasks',
    name: 'Sync with Google Tasks',
    icon: 'refresh-cw',
    checkCallback: (checking) => {
      if (!host.settings.googleTasksEnabled) return false;
      if (!checking) void host.syncGoogleTasks();
      return true;
    },
  });

  addDocumentedCommand(host, {
    id: 'sync-google-calendar',
    name: 'Sync with Google Calendar',
    icon: 'calendar-sync',
    checkCallback: (checking) => {
      if (!host.settings.googleCalendarEnabled) return false;
      if (!checking) void host.syncGoogleCalendar();
      return true;
    },
  });

  addDocumentedCommand(host, {
    id: 'export-bases-index',
    name: 'Export task index for Obsidian Bases',
    icon: 'database',
    callback: async () => { await host.exportBasesIndex(); },
  });

  addDocumentedCommand(host, {
    id: 'ai-task-search',
    name: 'AI task search (natural language)',
    icon: 'sparkles',
    checkCallback: (checking) => {
      if (!host.settings.aiQueryEnabled) return false;
      if (!checking) new AiQueryModal(host.app, host.settings, host.scanner).open();
      return true;
    },
  });

  addDocumentedCommand(host, {
    id: 'start-weekly-review',
    name: 'Start weekly review',
    icon: 'calendar-check',
    checkCallback: (checking) => {
      if (!host.settings.weeklyReviewEnabled) return false;
      if (!checking) void host.startWeeklyReview();
      return true;
    },
  });

  // ── #9: Disabled ICS import explainer ───────────────────────────────────────────
  addDocumentedCommand(host, {
    id: 'import-ics',
    name: 'Explain disabled ICS import',
    icon: 'calendar',
    callback: async () => { await host.importIcsCalendar(); },
  });

  // ── #10: Apple Reminders / Microsoft To Do ──────────────────────────────────────
  addDocumentedCommand(host, {
    id: 'sync-apple-reminders',
    name: 'Open Apple Reminders export Shortcut',
    icon: 'bell',
    checkCallback: (checking) => {
      if (!host.settings.appleRemindersEnabled) return false;
      if (!checking) host.syncAppleReminders();
      return true;
    },
  });
  addDocumentedCommand(host, {
    id: 'import-apple-reminders-json',
    name: 'Import Apple Reminders JSON from clipboard',
    icon: 'clipboard-paste',
    checkCallback: (checking) => {
      if (!host.settings.appleRemindersEnabled) return false;
      if (!checking) void host.importAppleRemindersFromClipboard();
      return true;
    },
  });
  addDocumentedCommand(host, {
    id: 'sync-ms-todo',
    name: 'Sync Microsoft To Do',
    icon: 'check-square',
    checkCallback: (checking) => {
      if (!host.settings.msToDoEnabled) return false;
      if (!checking) void host.syncMsToDo();
      return true;
    },
  });

  addDocumentedCommand(host, {
    id: 'sync-caldav',
    name: 'Sync CalDAV',
    icon: 'calendar-sync',
    checkCallback: (checking) => {
      if (!host.settings.caldavSyncEnabled) return false;
      if (!checking) void host.syncCalDAV();
      return true;
    },
  });

  // ── #17: Daily stats summary ─────────────────────────────────────────────────────
  addDocumentedCommand(host, {
    id: 'append-daily-stats-summary',
    name: 'Append daily task statistics to log',
    icon: 'bar-chart',
    callback: async () => { await host.appendDailyStatsSummary(); },
  });

  // ── #8: Working On — show current in-progress task ────────────────────────────────
  addDocumentedCommand(host, {
    id: 'show-working-on',
    name: 'Show Working On task',
    icon: 'zap',
    callback: () => { new WorkingOnModal(host.app, host.settings, host.scanner).open(); },
  });

  // ── #12: Run saved query (live preview) ──────────────────────────────────────
  addDocumentedCommand(host, {
    id: 'run-saved-query-preview',
    name: 'Run saved query (live preview)',
    icon: 'search',
    callback: () => { new SavedQueryPreviewModal(host.app, host.settings, host.scanner).open(); },
  });

  // ── #22: JSON / YAML export ──────────────────────────────────────────────────────
  addDocumentedCommand(host, {
    id: 'export-tasks-json',
    name: 'Export all tasks to JSON',
    icon: 'download',
    callback: async () => { await host.exportTasksJson(); },
  });
  addDocumentedCommand(host, {
    id: 'export-tasks-yaml',
    name: 'Export all tasks to YAML',
    icon: 'download',
    callback: async () => { await host.exportTasksYaml(); },
  });

  addDocumentedCommand(host, {
    id: 'export-tasks-kanban',
    name: 'Export all tasks as Kanban board',
    icon: 'layout-kanban',
    callback: async () => { await host.exportTasksAsKanban(); },
  });

  addDocumentedCommand(host, {
    id: 'export-tasks-canvas',
    name: 'Export all tasks as Canvas',
    icon: 'layout-dashboard',
    callback: async () => {
      await exportAndOpenTasksAsCanvas(host.app, host.apiV1.getAllTasks(), 'Task Canvas.canvas', 'Task Manager');
      new Notice('Task Manager: exported tasks to Task Canvas.canvas');
    },
  });
}
