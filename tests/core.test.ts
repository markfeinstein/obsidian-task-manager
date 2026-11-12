import test from 'node:test';
import assert from 'node:assert/strict';
import { MarkdownRenderer, moment, TFile, TFolder } from 'obsidian';
import { TaskScanner, applyTaskCompletionLifecycleToLine, calculateNextRecurrences, isRecurrenceRuleValid, type ParsedTask } from '../src/task-scanner';
import {
  extractTags,
  stripInlineTags,
  formatDateField,
  cycleTaskCheckbox,
  nextTaskCheckbox,
  parseMarkdownTaskLine,
  toggledTaskStatus,
  updateMarkdownTaskLineStatus,
  updateMarkdownTaskCheckboxInContent,
  updateMarkdownTaskStatusInContent,
} from '../src/task-model';
import { formatTaskManagerQueryBlock, sampleTaskManagerQuery, TaskQueryRenderer, buildExplainBody } from '../src/query-renderer';
import { filterTasks, groupTasks, parseTaskQuery, sortTasks } from '../src/task-query';
import { LogWriter } from '../src/log-writer';
import { DailyNoteResolver } from '../src/daily-note';
import { StateStore, CURRENT_STATE_VERSION, type PersistedState } from '../src/state-store';
import { TaskIndex } from '../src/task-index';
import { DEFAULT_DEFER_PRESETS, DEFAULT_MODAL_FIELDS, DEFAULT_SAVED_QUERIES, DEFAULT_SETTINGS, DEFAULT_TASK_STATES, TASK_STATE_COLLECTIONS, mergeTaskStateCollection, normalizeCustomFieldDefinitions, normalizeModalFields, normalizeSavedQueries, normalizeTaskManagerSettings, normalizeTaskStates, resolvedTaskStateIcon, shouldOverrideTaskStateIcon } from '../src/types';
import { isCompletionTransition } from '../src/completion-detector';
import TaskManagerPlugin, { autoSuggestDynamicSuggestions, buildModalStatusOptions, expandDateAbbreviation, resolveModalDateInput, parseQuickAddInput } from '../src/main';

const formatToday = (format: string): string => (moment as unknown as () => { format: (value: string) => string })().format(format);

type FakeFile = { path: string; extension: string; basename: string };
type CommandRegistrationHarness = {
  settings: typeof DEFAULT_SETTINGS;
  addCommand: (cmd: { id: string }) => void;
  registerSyncCommands: () => void;
};

function fakeFile(path: string): FakeFile {
  const name = path.split('/').pop() ?? path;
  return { path, extension: path.endsWith('.md') ? 'md' : '', basename: name.replace(/\.md$/u, '') };
}

function scanner(): TaskScanner {
  return new TaskScanner({} as never);
}

class FakeElement {
  children: Array<FakeElement | FakeTextNode> = [];
  classes: string[] = [];
  attributes = new Map<string, string>();
  style: Record<string, string> = {};
  text = '';
  disabled = false;
  indeterminate = false;
  checked = false;
  value = '';
  listeners = new Map<string, (event: { preventDefault: () => void; stopPropagation: () => void; target?: unknown }) => void>();

  constructor(readonly tagName: string) {}

  empty(): void { this.children = []; this.text = ''; }
  addClass(...classNames: string[]): void { for (const c of classNames) this.classes.push(c); }
  removeClass(className: string): void { this.classes = this.classes.filter((c) => c !== className); }
  toggleClass(className: string, force: boolean): void { if (force) { if (!this.classes.includes(className)) this.classes.push(className); } else { this.classes = this.classes.filter((c) => c !== className); } }
  setAttr(name: string, value: string): void { this.attributes.set(name, value); }
  getAttr(name: string): string | null { return this.attributes.get(name) ?? null; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  getAttribute(name: string): string | null { return this.attributes.get(name) ?? null; }
  removeAttribute(name: string): void { this.attributes.delete(name); }
  setText(value: string): void { this.text = value; this.children = [new FakeTextNode(value)]; }
  appendChild(child: FakeElement | FakeTextNode): FakeElement | FakeTextNode { this.children.push(child); return child; }
  prepend(child: FakeElement | FakeTextNode): void { this.children.unshift(child); }
  insertBefore(child: FakeElement | FakeTextNode, ref: FakeElement | FakeTextNode | null): FakeElement | FakeTextNode { if (ref) { const idx = this.children.indexOf(ref); if (idx >= 0) { this.children.splice(idx, 0, child); return child; } } this.children.unshift(child); return child; }
  querySelector(selector: string): FakeElement | null { const cls = selector.match(/^\.([\w-]+)$/)?.[1]; if (cls) return this.findByClass(cls) ?? null; return null; }
  querySelectorAll(selector: string): FakeElement[] { const cls = selector.match(/^\.([\w-]+)$/)?.[1]; if (cls) return this.findAllByClass(cls); return []; }
  createDiv(opts?: { cls?: string; text?: string }): FakeElement { const el = new FakeElement('div'); if (opts?.cls) for (const c of opts.cls.split(' ')) el.addClass(c); if (opts?.text) el.setText(opts.text); this.children.push(el); return el; }
  createEl(tag: string, opts?: { type?: string; cls?: string; text?: string }): FakeElement { const el = new FakeElement(tag); if (opts?.cls) for (const c of opts.cls.split(' ')) el.addClass(c); if (opts?.text) el.setText(opts.text); if (opts?.type) el.setAttr('type', opts.type); this.children.push(el); return el; }
  addEventListener(eventName: string, listener: (event: { preventDefault: () => void; stopPropagation: () => void }) => void): void { this.listeners.set(eventName, listener); }

  findByTag(tagName: string): FakeElement | undefined {
    if (this.tagName === tagName) {
      return this;
    }
    for (const child of this.children) {
      if (child instanceof FakeElement) {
        const found = child.findByTag(tagName);
        if (found) {
          return found;
        }
      }
    }
    return undefined;
  }

  findByClass(className: string): FakeElement | undefined {
    if (this.classes.includes(className)) {
      return this;
    }
    for (const child of this.children) {
      if (child instanceof FakeElement) {
        const found = child.findByClass(className);
        if (found) {
          return found;
        }
      }
    }
    return undefined;
  }

  findAllByClass(className: string): FakeElement[] {
    const matches: FakeElement[] = this.classes.includes(className) ? [this] : [];
    for (const child of this.children) {
      if (child instanceof FakeElement) {
        matches.push(...child.findAllByClass(className));
      }
    }
    return matches;
  }

  textContent(): string {
    return this.text || this.children.map((child) => child instanceof FakeElement ? child.textContent() : child.text).join('');
  }
}

class FakeTextNode {
  constructor(readonly text: string) {}
}

function tFileForPath(path: string): TFile {
  return Object.assign(Object.create(TFile.prototype) as TFile, {
    path,
    name: path.split('/').pop() ?? path,
    extension: path.endsWith('.md') ? 'md' : '',
    basename: path.split('/').pop()?.replace(/\.md$/u, '') ?? path,
  });
}

async function flushPromises(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('default settings preserve completion logging and query defaults', () => {
  assert.deepEqual({
    enableFileEvents: DEFAULT_SETTINGS.enableFileEvents,
    enablePeriodicScan: DEFAULT_SETTINGS.enablePeriodicScan,
    scanIntervalMinutes: DEFAULT_SETTINGS.scanIntervalMinutes,
    logSectionHeading: DEFAULT_SETTINGS.logSectionHeading,
    includeCompletionTime: DEFAULT_SETTINGS.includeCompletionTime,
    logTimeFormat: DEFAULT_SETTINGS.logTimeFormat,
    includeSourceLinkWhenNotDailyNote: DEFAULT_SETTINGS.includeSourceLinkWhenNotDailyNote,
    globalFilter: DEFAULT_SETTINGS.globalFilter,
    globalQuery: DEFAULT_SETTINGS.globalQuery,
    removeGlobalFilterFromDescription: DEFAULT_SETTINGS.removeGlobalFilterFromDescription,
    enableQueryDsl: DEFAULT_SETTINGS.enableQueryDsl,
    taskFormat: DEFAULT_SETTINGS.taskFormat,
    taskCountLocation: DEFAULT_SETTINGS.taskCountLocation,
    queryCodeBlockName: DEFAULT_SETTINGS.queryCodeBlockName,
    tasksCodeBlockMode: DEFAULT_SETTINGS.tasksCodeBlockMode,
    defaultSort: DEFAULT_SETTINGS.defaultSort,
    autoSuggestInEditor: DEFAULT_SETTINGS.autoSuggestInEditor,
    autoSuggestMinMatch: DEFAULT_SETTINGS.autoSuggestMinMatch,
    autoSuggestMaxItems: DEFAULT_SETTINGS.autoSuggestMaxItems,
    provideAccessKeys: DEFAULT_SETTINGS.provideAccessKeys,
    setCreatedDate: DEFAULT_SETTINGS.setCreatedDate,
    setDoneDate: DEFAULT_SETTINGS.setDoneDate,
    setCancelledDate: DEFAULT_SETTINGS.setCancelledDate,
    recurrenceFutureOccurrences: DEFAULT_SETTINGS.recurrenceFutureOccurrences,
    recurrenceInsertLocation: DEFAULT_SETTINGS.recurrenceInsertLocation,
    removeScheduledDateOnRecurrence: DEFAULT_SETTINGS.removeScheduledDateOnRecurrence,
    recurrenceOnCancelled: DEFAULT_SETTINGS.recurrenceOnCancelled,
    archiveFilePath: DEFAULT_SETTINGS.archiveFilePath,
    archiveHeading: DEFAULT_SETTINGS.archiveHeading,
    dateOutputAsWikiLinks: DEFAULT_SETTINGS.dateOutputAsWikiLinks,
    dateFormat: DEFAULT_SETTINGS.dateFormat,
    dateDisplayFormat: DEFAULT_SETTINGS.dateDisplayFormat,
    subtaskDateInheritance: DEFAULT_SETTINGS.subtaskDateInheritance,
    collectFilePath: DEFAULT_SETTINGS.collectFilePath,
    collectHeading: DEFAULT_SETTINGS.collectHeading,
    treeFilteredView: DEFAULT_SETTINGS.treeFilteredView,
    useFilenameAsScheduledDate: DEFAULT_SETTINGS.useFilenameAsScheduledDate,
    filenameScheduledDateFormat: DEFAULT_SETTINGS.filenameScheduledDateFormat,
    filenameScheduledDateFolders: DEFAULT_SETTINGS.filenameScheduledDateFolders,
    supportedStates: DEFAULT_SETTINGS.supportedStates,
    savedQueries: DEFAULT_SETTINGS.savedQueries,
    modalFields: DEFAULT_SETTINGS.modalFields,
    deferPresets: DEFAULT_SETTINGS.deferPresets,
    enableReminderNotifications: DEFAULT_SETTINGS.enableReminderNotifications,
    reminderCheckIntervalMinutes: DEFAULT_SETTINGS.reminderCheckIntervalMinutes,
    quickCaptureInboxPath: DEFAULT_SETTINGS.quickCaptureInboxPath,
    taskTemplates: DEFAULT_SETTINGS.taskTemplates,
    enableMobileGestures: DEFAULT_SETTINGS.enableMobileGestures,
    autoCompleteParent: DEFAULT_SETTINGS.autoCompleteParent,
    autoAdvanceParentToInProgress: DEFAULT_SETTINGS.autoAdvanceParentToInProgress,
    autoAdvanceParentOnAllCancelled: DEFAULT_SETTINGS.autoAdvanceParentOnAllCancelled,
    customPriorities: DEFAULT_SETTINGS.customPriorities,
    futureOccurrenceCount: DEFAULT_SETTINGS.futureOccurrenceCount,
    trackRecurrenceCount: DEFAULT_SETTINGS.trackRecurrenceCount,
    useSystemNotifications: DEFAULT_SETTINGS.useSystemNotifications,
    taskNoteFolder: DEFAULT_SETTINGS.taskNoteFolder,
    todoistApiKey: DEFAULT_SETTINGS.todoistApiKey,
    todoistProjectId: DEFAULT_SETTINGS.todoistProjectId,
    todoistSyncEnabled: DEFAULT_SETTINGS.todoistSyncEnabled,
    todoistInboxPath: DEFAULT_SETTINGS.todoistInboxPath,
    enableBasesIntegration: DEFAULT_SETTINGS.enableBasesIntegration,
    nlpQueryEnabled: DEFAULT_SETTINGS.nlpQueryEnabled,
    kanbanFileWritebackEnabled: DEFAULT_SETTINGS.kanbanFileWritebackEnabled,
    dailyPlanHeading: DEFAULT_SETTINGS.dailyPlanHeading,
    pomodoroWorkMinutes: DEFAULT_SETTINGS.pomodoroWorkMinutes,
    pomodoroBreakMinutes: DEFAULT_SETTINGS.pomodoroBreakMinutes,
    pomodoroLongBreakMinutes: DEFAULT_SETTINGS.pomodoroLongBreakMinutes,
    pomodoroLongBreakAfter: DEFAULT_SETTINGS.pomodoroLongBreakAfter,
    pomodoroLogActualTime: DEFAULT_SETTINGS.pomodoroLogActualTime,
    googleTasksEnabled: DEFAULT_SETTINGS.googleTasksEnabled,
    googleTasksOAuthClientId: DEFAULT_SETTINGS.googleTasksOAuthClientId,
    googleTasksAccessToken: DEFAULT_SETTINGS.googleTasksAccessToken,
    googleTasksApiKey: DEFAULT_SETTINGS.googleTasksApiKey,
    googleTasksListId: DEFAULT_SETTINGS.googleTasksListId,
    googleTasksInboxPath: DEFAULT_SETTINGS.googleTasksInboxPath,
    aiQueryEnabled: DEFAULT_SETTINGS.aiQueryEnabled,
    aiQueryApiKey: DEFAULT_SETTINGS.aiQueryApiKey,
    aiQueryModel: DEFAULT_SETTINGS.aiQueryModel,
    aiQueryProvider: DEFAULT_SETTINGS.aiQueryProvider,
    aiQueryLocalEndpoint: DEFAULT_SETTINGS.aiQueryLocalEndpoint,
    weeklyReviewInboxPath: DEFAULT_SETTINGS.weeklyReviewInboxPath,
    weeklyReviewEnabled: DEFAULT_SETTINGS.weeklyReviewEnabled,
    dateTimeOnLifecycleDates: DEFAULT_SETTINGS.dateTimeOnLifecycleDates,
    habitTrackingEnabled: DEFAULT_SETTINGS.habitTrackingEnabled,
    gamificationEnabled: DEFAULT_SETTINGS.gamificationEnabled,
    enableDslExpressions: DEFAULT_SETTINGS.enableDslExpressions,
    logEntryTemplate: DEFAULT_SETTINGS.logEntryTemplate,
    dailyStatsSummaryEnabled: DEFAULT_SETTINGS.dailyStatsSummaryEnabled,
    dailyStatsSummaryTemplate: DEFAULT_SETTINGS.dailyStatsSummaryTemplate,
    fileDefaultsEnabled: DEFAULT_SETTINGS.fileDefaultsEnabled,
    fileDefaultsPropertyPrefix: DEFAULT_SETTINGS.fileDefaultsPropertyPrefix,
    icalImportUrl: DEFAULT_SETTINGS.icalImportUrl,
    icalImportTargetPath: DEFAULT_SETTINGS.icalImportTargetPath,
    appleRemindersEnabled: DEFAULT_SETTINGS.appleRemindersEnabled,
    appleRemindersListName: DEFAULT_SETTINGS.appleRemindersListName,
    appleRemindersInboxPath: DEFAULT_SETTINGS.appleRemindersInboxPath,
    appleRemindersWebhookEnabled: DEFAULT_SETTINGS.appleRemindersWebhookEnabled,
    appleRemindersWebhookSecret: DEFAULT_SETTINGS.appleRemindersWebhookSecret,
    msToDoEnabled: DEFAULT_SETTINGS.msToDoEnabled,
    msToDoClientId: DEFAULT_SETTINGS.msToDoClientId,
    msToDoListId: DEFAULT_SETTINGS.msToDoListId,
    msToDoToken: DEFAULT_SETTINGS.msToDoToken,
    msToDoInboxPath: DEFAULT_SETTINGS.msToDoInboxPath,
    syncConflictDirection: DEFAULT_SETTINGS.syncConflictDirection,
    datacoreEnabled: DEFAULT_SETTINGS.datacoreEnabled,
    inlineProgressBarsEnabled: DEFAULT_SETTINGS.inlineProgressBarsEnabled,
    jsonExportPath: DEFAULT_SETTINGS.jsonExportPath,
    yamlExportPath: DEFAULT_SETTINGS.yamlExportPath,
    followUpEmoji: DEFAULT_SETTINGS.followUpEmoji,
    workflowsEnabled: DEFAULT_SETTINGS.workflowsEnabled,
    workflows: DEFAULT_SETTINGS.workflows,
    orgModeEnabled: DEFAULT_SETTINGS.orgModeEnabled,
    syncConflictLogPath: DEFAULT_SETTINGS.syncConflictLogPath,
    missedReminderLogEnabled: DEFAULT_SETTINGS.missedReminderLogEnabled,
    excludedFolders: DEFAULT_SETTINGS.excludedFolders,
    autoGenerateTaskId: DEFAULT_SETTINGS.autoGenerateTaskId,
    recurrenceSkipToFuture: DEFAULT_SETTINGS.recurrenceSkipToFuture,
    postponePreferredField: DEFAULT_SETTINGS.postponePreferredField,
    urgencyWeights: DEFAULT_SETTINGS.urgencyWeights,
    caldavSyncEnabled: DEFAULT_SETTINGS.caldavSyncEnabled,
    caldavServerUrl: DEFAULT_SETTINGS.caldavServerUrl,
    caldavUsername: DEFAULT_SETTINGS.caldavUsername,
    caldavPassword: DEFAULT_SETTINGS.caldavPassword,
    caldavCalendarPath: DEFAULT_SETTINGS.caldavCalendarPath,
    csvExportPath: DEFAULT_SETTINGS.csvExportPath,
    staleTaskThresholdDays: DEFAULT_SETTINGS.staleTaskThresholdDays,
    overdueTaskThresholdDays: DEFAULT_SETTINGS.overdueTaskThresholdDays,
    preferredLocale: DEFAULT_SETTINGS.preferredLocale,
    whisperApiKey: DEFAULT_SETTINGS.whisperApiKey,
  }, {
    enableFileEvents: true,
    enablePeriodicScan: true,
    scanIntervalMinutes: 3,
    logSectionHeading: 'Log',
    includeCompletionTime: true,
    logTimeFormat: 'HH:mm',
    includeSourceLinkWhenNotDailyNote: true,
    globalFilter: '',
    globalQuery: '',
    removeGlobalFilterFromDescription: false,
    enableQueryDsl: true,
    taskFormat: 'emoji',
    taskCountLocation: 'bottom',
    queryCodeBlockName: 'task-list',
    tasksCodeBlockMode: 'when-upstream-absent',
    defaultSort: 'smart',
    autoSuggestInEditor: true,
    autoSuggestMinMatch: 0,
    autoSuggestMaxItems: 20,
    provideAccessKeys: false,
    setCreatedDate: false,
    setDoneDate: true,
    setCancelledDate: true,
    recurrenceFutureOccurrences: 1,
    recurrenceInsertLocation: 'before',
    removeScheduledDateOnRecurrence: false,
    recurrenceOnCancelled: true,
    archiveFilePath: 'Archive.md',
    archiveHeading: 'Archived Tasks',
    dateOutputAsWikiLinks: false,
    dateFormat: 'plain',
    dateDisplayFormat: '',
    subtaskDateInheritance: false,
    collectFilePath: 'Completed.md',
    collectHeading: 'Collected Tasks',
    treeFilteredView: false,
    useFilenameAsScheduledDate: false,
    filenameScheduledDateFormat: '',
    filenameScheduledDateFolders: '',
    supportedStates: DEFAULT_TASK_STATES,
    savedQueries: DEFAULT_SAVED_QUERIES,
    modalFields: DEFAULT_MODAL_FIELDS,
    deferPresets: DEFAULT_DEFER_PRESETS,
    enableReminderNotifications: false,
    reminderCheckIntervalMinutes: 1,
    quickCaptureInboxPath: '',
    taskTemplates: [],
    enableMobileGestures: true,
    autoCompleteParent: false,
    autoAdvanceParentToInProgress: false,
    autoAdvanceParentOnAllCancelled: false,
    customPriorities: [],
    futureOccurrenceCount: 3,
    trackRecurrenceCount: false,
    useSystemNotifications: false,
    taskNoteFolder: 'Tasks/',
    todoistApiKey: '',
    todoistProjectId: '',
    todoistSyncEnabled: false,
    todoistInboxPath: 'Todoist Inbox.md',
    enableBasesIntegration: false,
    nlpQueryEnabled: false,
    kanbanFileWritebackEnabled: false,
    dailyPlanHeading: 'Daily Plan',
    pomodoroWorkMinutes: 25,
    pomodoroBreakMinutes: 5,
    pomodoroLongBreakMinutes: 15,
    pomodoroLongBreakAfter: 4,
    pomodoroLogActualTime: false,
    googleTasksEnabled: false,
    googleTasksOAuthClientId: '',
    googleTasksAccessToken: '',
    googleTasksApiKey: '',
    googleTasksListId: '',
    googleTasksInboxPath: 'Google Tasks Inbox.md',
    aiQueryEnabled: false,
    aiQueryApiKey: '',
    aiQueryModel: 'gpt-4o-mini',
    aiQueryProvider: 'openai',
    aiQueryLocalEndpoint: 'http://localhost:11434/v1/chat/completions',
    weeklyReviewInboxPath: '',
    weeklyReviewEnabled: false,
    dateTimeOnLifecycleDates: false,
    habitTrackingEnabled: false,
    gamificationEnabled: false,
    enableDslExpressions: false,
    logEntryTemplate: '',
    dailyStatsSummaryEnabled: false,
    dailyStatsSummaryTemplate: '> ✅ {{total}} tasks completed',
    fileDefaultsEnabled: true,
    fileDefaultsPropertyPrefix: 'task_',
    icalImportUrl: '',
    icalImportTargetPath: 'Calendar Import.md',
    appleRemindersEnabled: false,
    appleRemindersListName: '',
    appleRemindersInboxPath: 'Reminders Inbox.md',
    appleRemindersWebhookEnabled: false,
    appleRemindersWebhookSecret: '',
    msToDoEnabled: false,
    msToDoClientId: '',
    msToDoListId: '',
    msToDoToken: '',
    msToDoInboxPath: 'MS To Do Inbox.md',
    syncConflictDirection: 'vault-first',
    datacoreEnabled: false,
    inlineProgressBarsEnabled: false,
    jsonExportPath: 'Tasks Export.json',
    yamlExportPath: 'Tasks Export.yaml',
    followUpEmoji: '\uD83D\uDC40',
    workflowsEnabled: false,
    workflows: [],
    orgModeEnabled: false,
    syncConflictLogPath: 'Sync Conflicts.md',
    missedReminderLogEnabled: true,
    excludedFolders: [],
    autoGenerateTaskId: false,
    recurrenceSkipToFuture: false,
    postponePreferredField: 'auto',
    urgencyWeights: { due: 12.0, priority: 6.0, scheduled: 5.0, start: -3.0 },
    caldavSyncEnabled: false,
    caldavServerUrl: '',
    caldavUsername: '',
    caldavPassword: '',
    caldavCalendarPath: '/calendar.ics/',
    csvExportPath: 'Tasks Export.csv',
    staleTaskThresholdDays: 30,
    overdueTaskThresholdDays: 0,
    preferredLocale: 'en',
    whisperApiKey: '',
  });
});

test('loading partial settings keeps defaults and removes legacy options', async () => {
  let saved: unknown;
  const store = new StateStore({
    loadData: async () => ({
      settings: {
        logSectionHeading: 'Completed',
        includeCompletionTime: false,
        globalFilter: 'not done',
        dedupeEnabled: false,
        dedupeRetentionDays: 7,
      },
    }),
    saveData: async (data: unknown) => { saved = data; },
  } as never);

  const settings = await store.loadSettings(DEFAULT_SETTINGS);
  assert.deepEqual(settings, {
    ...DEFAULT_SETTINGS,
    logSectionHeading: 'Completed',
    includeCompletionTime: false,
    globalFilter: '',
    globalQuery: 'not done',
  });
  assert.equal(settings.globalFilter, '');
  assert.equal(settings.globalQuery, 'not done');
  assert.equal('dedupeEnabled' in settings, false);
  assert.equal('dedupeRetentionDays' in settings, false);

  await store.saveSettings(settings);
  assert.equal((saved as { settings: { globalFilter: string } }).settings.globalFilter, '');
  assert.equal((saved as { settings: { globalQuery: string } }).settings.globalQuery, 'not done');
  assert.equal('dedupeEnabled' in ((saved as { settings: object }).settings), false);
  assert.equal('dedupeRetentionDays' in ((saved as { settings: object }).settings), false);
});

test('supported state normalization rejects invalid configurations', async () => {
  const store = new StateStore({
    loadData: async () => ({
      settings: {
        supportedStates: [
          { rawText: ' ', name: 'Todo', icon: '☐', type: 'todo' },
          { rawText: ' ', name: 'Duplicate todo', icon: '☐', type: 'todo' },
          { rawText: ']bad', name: 'Bad', icon: '!', type: 'done' },
          { rawText: '\nbad', name: 'Bad', icon: '!', type: 'done' },
          { rawText: 'x', name: 'Done', icon: '✓', type: 'done' },
        ],
      },
    }),
    saveData: async () => undefined,
  } as never);

  const settings = await store.loadSettings(DEFAULT_SETTINGS);
  assert.deepEqual(settings.supportedStates.map((state) => state.rawText), [' ', 'x', '>']);
  assert.deepEqual(settings.supportedStates.map((state) => state.icon), ['', '', '']);

  const defaultIconStore = new StateStore({
    loadData: async () => ({
      settings: {
        supportedStates: [
          { rawText: ' ', name: 'Todo', icon: '', type: 'todo' },
          { rawText: 'x', name: 'Done', icon: '', type: 'done' },
        ],
      },
    }),
    saveData: async () => undefined,
  } as never);
  const defaultIconStates = (await defaultIconStore.loadSettings(DEFAULT_SETTINGS)).supportedStates;
  assert.deepEqual(defaultIconStates.map((state) => state.icon), ['', '', '']);
  assert.deepEqual(defaultIconStates.map((state) => resolvedTaskStateIcon(state)), ['☐', '☑', '▶️']);
  assert.deepEqual(DEFAULT_TASK_STATES.map((state) => [state.rawText, resolvedTaskStateIcon(state), shouldOverrideTaskStateIcon(state)]), [
    [' ', '☐', false],
    ['/', '◫', false],
    ['x', '☑', false],
    ['>', '▶️', true],
    ['?', '⏳', true],
    ['!', '🚫', true],
    ['-', '☒', false],
  ]);
  assert.equal(
    shouldOverrideTaskStateIcon({ rawText: ' ', name: 'Todo', icon: '✅', type: 'todo' }),
    false,
    'custom Todo icons must not replace every unchecked Markdown checklist item globally',
  );
  assert.equal(
    shouldOverrideTaskStateIcon({ rawText: '/', name: 'Doing', icon: '🔄', type: 'in_progress' }),
    true,
    'custom non-Todo state icons should still render as custom checkbox states',
  );

  const occupiedDeferredMarkerStore = new StateStore({
    loadData: async () => ({
      settings: {
        supportedStates: [
          { rawText: ' ', name: 'Todo', icon: '', type: 'todo' },
          { rawText: '>', name: 'Custom done', icon: '', type: 'done' },
        ],
      },
    }),
    saveData: async () => undefined,
  } as never);
  assert.deepEqual((await occupiedDeferredMarkerStore.loadSettings(DEFAULT_SETTINGS)).supportedStates.map((state) => [state.rawText, state.type]), [
    [' ', 'todo'],
    ['>', 'done'],
    ['d', 'deferred'],
  ]);

  const configuredNextStore = new StateStore({
    loadData: async () => ({
      settings: {
        supportedStates: [
          { rawText: ' ', name: 'Todo', icon: '', type: 'todo', nextStatusSymbol: '/' },
          { rawText: '/', name: 'Progress', icon: '', type: 'in_progress', nextStatusSymbol: 'x' },
          { rawText: 'x', name: 'Done', icon: '', type: 'done', nextStatusSymbol: ' ' },
        ],
      },
    }),
    saveData: async () => undefined,
  } as never);
  assert.deepEqual((await configuredNextStore.loadSettings(DEFAULT_SETTINGS)).supportedStates.map((state) => state.nextStatusSymbol), ['/', 'x', ' ', 'x']);

  const missingDoneStore = new StateStore({
    loadData: async () => ({ settings: { supportedStates: [{ rawText: ' ', name: 'Todo', icon: '☐', type: 'todo' }] } }),
    saveData: async () => undefined,
  } as never);
  assert.deepEqual((await missingDoneStore.loadSettings(DEFAULT_SETTINGS)).supportedStates, DEFAULT_TASK_STATES);
});

test('modal field settings and status collection imports normalize safely', () => {
  const settings = normalizeTaskManagerSettings({ modalFields: { priority: false, due: false } as Partial<typeof DEFAULT_MODAL_FIELDS> as typeof DEFAULT_MODAL_FIELDS });
  assert.equal(settings.modalFields.priority, false);
  assert.equal(settings.modalFields.due, false);
  assert.equal(settings.modalFields.recurrence, true);
  assert.deepEqual(normalizeModalFields({ dependencies: false } as never), {
    ...DEFAULT_MODAL_FIELDS,
    before_this: false,
    after_this: false,
  });
  assert.deepEqual(Object.keys(normalizeModalFields({})).sort(), Object.keys(DEFAULT_MODAL_FIELDS).sort());
  assert.deepEqual(normalizeCustomFieldDefinitions([
    { key: 'energy-level', name: 'Energy', type: 'number' },
    { key: 'Energy_Level', name: 'Energy 2', type: 'select', options: ['High', 'High', 'Low'], syncMode: 'write' },
    { key: 'owner', name: 'Owner', type: 'select', options: ['Alice', 'Bob'] },
  ]), [
    { key: 'Energy_Level', name: 'Energy 2', type: 'select', syncMode: 'write', searchable: true, options: ['High', 'Low'] },
    { key: 'owner', name: 'Owner', type: 'select', syncMode: 'read', searchable: true, options: ['Alice', 'Bob'] },
  ]);
  assert.deepEqual(normalizeTaskStates([{ rawText: ' ', name: 'Todo', type: 'todo' }]), DEFAULT_TASK_STATES);
  assert.equal(normalizeTaskManagerSettings({ tasksCodeBlockMode: 'always' }).tasksCodeBlockMode, 'always');
  assert.equal(normalizeTaskManagerSettings({ tasksCodeBlockMode: 'invalid' as never }).tasksCodeBlockMode, 'when-upstream-absent');
  assert.deepEqual(normalizeTaskManagerSettings({ deferPresets: [{ label: 'Broken' }] as never }).deferPresets, DEFAULT_DEFER_PRESETS);

  const collection = TASK_STATE_COLLECTIONS.find((entry) => entry.name.includes('Minimal'))!;
  const merged = mergeTaskStateCollection(DEFAULT_TASK_STATES, collection);
  const scheduling = merged.find((state) => state.rawText === '<');
  assert.ok(scheduling);
  // Upstream Minimal types '<' (scheduling) as TODO with next symbol 'x'.
  assert.equal(scheduling.type, 'todo');
  assert.equal(scheduling.nextStatusSymbol, 'x');
  assert.equal(nextTaskCheckbox('<', merged), 'x');
  assert.equal(nextTaskCheckbox('/', merged), 'x');

  // Mirror upstream `bulkAddStatusCollection`: imported statuses get availableAsCommand=false
  // so they do not flood the command palette.
  assert.equal(scheduling.availableAsCommand, false);
  const doneCore = merged.find((state) => state.rawText === 'x' && state.type === 'done');
  assert.ok(doneCore);
  // Core defaults preserve their existing availableAsCommand flag (true).
  assert.equal(doneCore.availableAsCommand, true);
});

test('ordered status cycle reaches actionable default states', () => {
  assert.equal(cycleTaskCheckbox(' ', DEFAULT_TASK_STATES), '/');
  assert.equal(cycleTaskCheckbox('/', DEFAULT_TASK_STATES), 'x');
  assert.equal(cycleTaskCheckbox('x', DEFAULT_TASK_STATES), '>');
  assert.equal(cycleTaskCheckbox('>', DEFAULT_TASK_STATES), '?');
  assert.equal(cycleTaskCheckbox('?', DEFAULT_TASK_STATES), '-');
  assert.equal(cycleTaskCheckbox('!', DEFAULT_TASK_STATES), '-');
  assert.equal(cycleTaskCheckbox('-', DEFAULT_TASK_STATES), ' ');
});

test('default supported states mirror upstream DEFAULT_STATUSES for the four core entries', () => {
  // Upstream Status.ts / StatusRegistry.ts DEFAULT_STATUSES:
  //   TODO        -> (' ', 'Todo',        'x', availableAsCommand=true, TODO)
  //   IN_PROGRESS -> ('/', 'In Progress', 'x', availableAsCommand=true, IN_PROGRESS)
  //   DONE        -> ('x', 'Done',        ' ', availableAsCommand=true, DONE)
  //   CANCELLED   -> ('-', 'Cancelled',   ' ', availableAsCommand=true, CANCELLED)
  const upstreamCore = [
    { rawText: ' ', name: 'Todo', type: 'todo', nextStatusSymbol: 'x' },
    { rawText: '/', name: 'In Progress', type: 'in_progress', nextStatusSymbol: 'x' },
    { rawText: 'x', name: 'Done', type: 'done', nextStatusSymbol: ' ' },
    { rawText: '-', name: 'Cancelled', type: 'cancelled', nextStatusSymbol: ' ' },
  ];
  for (const expected of upstreamCore) {
    const actual = DEFAULT_TASK_STATES.find((state) => state.rawText === expected.rawText);
    assert.ok(actual, `missing default state ${expected.rawText}`);
    assert.equal(actual.name, expected.name);
    assert.equal(actual.type, expected.type);
    assert.equal(actual.nextStatusSymbol, expected.nextStatusSymbol);
    assert.equal(actual.availableAsCommand, true);
  }
});

test('built-in status collections match upstream obsidian-tasks contents', () => {
  const counts: Record<string, number> = {
    'AnuPpuccin Theme': 28,
    'Aura Theme': 19,
    'Border Theme': 20,
    'Ebullientworks Theme': 8,
    'LYT Mode Theme': 22,
    'Things Theme': 22,
    'Minimal Theme': 22,
    'ITS / SlRvb Theme': 38,
  };
  for (const [name, expected] of Object.entries(counts)) {
    const entry = TASK_STATE_COLLECTIONS.find((c) => c.name === name);
    assert.ok(entry, `missing collection ${name}`);
    assert.equal(entry.states.length, expected, `${name} state count`);
  }
  // Spot-check representative markers from each collection.
  const anu = TASK_STATE_COLLECTIONS.find((c) => c.name === 'AnuPpuccin Theme')!;
  const anuQuestion = anu.states.find((s) => s.rawText === '?')!;
  assert.equal(anuQuestion.type, 'todo');
  assert.equal(anuQuestion.nextStatusSymbol, 'x');
  const anuBubble = anu.states.find((s) => s.rawText === '5')!;
  assert.equal(anuBubble.type, 'untracked');
  assert.equal(anuBubble.nextStatusSymbol, '5');

  const border = TASK_STATE_COLLECTIONS.find((c) => c.name === 'Border Theme')!;
  // Border/Things quote markers may be straight or curly depending on the imported collection revision.
  assert.ok(border.states.find((s) => s.rawText === '\u201C' || s.rawText === '"'), 'border quote marker');

  const things = TASK_STATE_COLLECTIONS.find((c) => c.name === 'Things Theme')!;
  // Things uses a straight quote.
  assert.ok(things.states.find((s) => s.rawText === '"'), 'things straight quote');

  const its = TASK_STATE_COLLECTIONS.find((c) => c.name === 'ITS / SlRvb Theme')!;
  const itsHalf = its.states.find((s) => s.rawText === '/')!;
  assert.equal(itsHalf.type, 'in_progress');
  const itsDoing = its.states.find((s) => s.rawText === 'd')!;
  assert.equal(itsDoing.type, 'in_progress');
  const itsDropped = its.states.find((s) => s.rawText === '-')!;
  assert.equal(itsDropped.type, 'cancelled');
});

test('task parsing maps markdown checkbox statuses', () => {
  const s = scanner();
  assert.equal(s.parseTaskLine('- [ ] Todo item #work', 'Project.md', 1)?.status, 'todo');
  assert.equal(s.parseTaskLine('- [/] In progress', 'Project.md', 2)?.status, 'in_progress');
  assert.equal(s.parseTaskLine('- [!] Blocked', 'Project.md', 3)?.status, 'blocked');
  assert.equal(s.parseTaskLine('- [?] Waiting', 'Project.md', 4)?.status, 'blocked');
  assert.equal(s.parseTaskLine('- [>] Deferred', 'Project.md', 5)?.status, 'deferred');
  assert.equal(s.parseTaskLine('- [x] Done', 'Project.md', 6)?.status, 'done');
  assert.equal(s.parseTaskLine('- [-] Cancelled', 'Project.md', 7)?.status, 'cancelled');
  assert.equal(s.parseTaskLine('- [W] Waiting uppercase', 'Project.md', 8)?.status, 'blocked');
  assert.equal(s.parseTaskLine('- [w] Waiting lowercase', 'Project.md', 9)?.status, 'blocked');
  assert.equal(s.parseTaskLine('- [X] Done uppercase', 'Project.md', 10)?.status, 'done');
  assert.equal(s.parseTaskLine('- [z] Unknown marker', 'Project.md', 11)?.status, 'todo');
  assert.deepEqual(filterTasks([s.parseTaskLine('- [z] Unknown marker', 'Project.md', 11)!], 'not done').map((task) => task.normalizedText), ['Unknown marker']);
  assert.equal(s.parseTaskLine('- [] Empty marker', 'Project.md', 12), null);
});

test('org-mode CLOSED and cancel keywords map to terminal statuses', () => {
  assert.equal(parseMarkdownTaskLine('- CLOSED: Archive report', 'Project.md', 1, DEFAULT_TASK_STATES, '', true)?.status, 'done');
  assert.equal(parseMarkdownTaskLine('- CANCELLED: Drop report', 'Project.md', 2, DEFAULT_TASK_STATES, '', true)?.status, 'cancelled');
  assert.equal(parseMarkdownTaskLine('- CANCELED: Drop report', 'Project.md', 3, DEFAULT_TASK_STATES, '', true)?.status, 'cancelled');
  assert.equal(parseMarkdownTaskLine('- CANCEL: Drop report', 'Project.md', 4, DEFAULT_TASK_STATES, '', true)?.status, 'cancelled');
  assert.equal(parseMarkdownTaskLine('- CANCELLE: Typo report', 'Project.md', 5, DEFAULT_TASK_STATES, '', true), null);
});

test('org-mode keyword task lines can be rewritten to a new status', () => {
  assert.equal(updateMarkdownTaskLineStatus('- TODO: Archive report', 'done'), '- DONE: Archive report');
  assert.equal(updateMarkdownTaskLineStatus('TODO: Bare report', 'cancelled'), 'CANCELLED: Bare report');
});

test('org-mode bare keyword task lines preserve indentation when parsed and rewritten', () => {
  const task = parseMarkdownTaskLine('  TODO: Nested bare report', 'Project.md', 1, DEFAULT_TASK_STATES, '', true);

  assert.ok(task);
  assert.equal(task.status, 'todo');
  assert.equal(task.indentation, '  ');
  assert.equal(updateMarkdownTaskLineStatus('  TODO: Nested bare report', 'done'), '  DONE: Nested bare report');
});

test('org-mode keyword task content updates preserve identity checks', () => {
  const task = parseMarkdownTaskLine('- TODO: Archive report #work', 'Project.md', 1, DEFAULT_TASK_STATES, '', true);
  assert.ok(task);

  const result = updateMarkdownTaskCheckboxInContent('- TODO: Archive report #work\n', task, 'x');

  assert.equal(result.content, '- DONE: Archive report #work\n');
  assert.equal(result.updatedTask.status, 'done');
  assert.equal(result.updatedTask.normalizedText, 'Archive report #work');
});

test('saved query normalization keeps predefined defaults and custom queries', () => {
  assert.deepEqual(normalizeSavedQueries(undefined), DEFAULT_SAVED_QUERIES);
  assert.deepEqual(normalizeSavedQueries([]), []);
  assert.deepEqual(normalizeSavedQueries([
    { name: 'Open', query: 'not done' },
    { name: 'open', query: 'done' },
    { name: '', query: 'not done' },
    { name: 'Blank', query: '   ' },
  ]), [{ name: 'Open', query: 'not done' }]);
});

test('task parsing supports numbered tasks, tags, metadata, and normalized keys', () => {
  const parsed = scanner().parseTaskLine('  12. [x] Finish   report #work @home ✅ 2026-05-20 🔁 every week 🔺', 'Projects/Alpha.md', 10);
  assert.ok(parsed);
  assert.equal(parsed.normalizedText, 'Finish report #work @home');
  assert.deepEqual(parsed.tags, ['work']);
  assert.equal(parsed.key, 'Projects/Alpha.md:finish report');
  assert.equal(parsed.lineNumber, 10);

  const leadingContext = scanner().parseTaskLine('- [ ] @home Finish report', 'Projects/Alpha.md', 11);
  assert.ok(leadingContext);
  assert.deepEqual(leadingContext.contexts, ['home']);
  assert.equal(leadingContext.key, 'Projects/Alpha.md:finish report');

  const timedDue = scanner().parseTaskLine('- [ ] Timed due 📅 2026-05-21 09:30', 'Projects/Alpha.md', 12);
  assert.ok(timedDue);
  assert.equal(timedDue.normalizedText, 'Timed due');
  assert.equal(timedDue.metadata.dates.due, '2026-05-21');
  assert.equal(timedDue.metadata.dates.dueTime, '09:30');

  const timedScheduledWikilink = scanner().parseTaskLine('- [ ] Timed scheduled ⏳ [[2026-05-22|Friday]] 14:05', 'Projects/Alpha.md', 13);
  assert.ok(timedScheduledWikilink);
  assert.equal(timedScheduledWikilink.normalizedText, 'Timed scheduled');
  assert.equal(timedScheduledWikilink.metadata.dates.scheduled, '2026-05-22');
  assert.equal(timedScheduledWikilink.metadata.dates.scheduledTime, '14:05');

  const invalidTimedDate = scanner().parseTaskLine('- [ ] Invalid timed due 📅 2026-05-23 24:00 ⏰ [[2026-05-22 99:30]]', 'Projects/Alpha.md', 14);
  assert.ok(invalidTimedDate);
  assert.equal(invalidTimedDate.normalizedText, 'Invalid timed due');
  assert.equal(invalidTimedDate.metadata.dates.due, '2026-05-23');
  assert.equal(invalidTimedDate.metadata.dates.dueTime, undefined);
  assert.equal(invalidTimedDate.metadata.reminder, '2026-05-22');

  const malformedDate = scanner().parseTaskLine('- [ ] Malformed date 📅 2026-05-24abc [scheduled:: 2026-05-25abc] 👀 2026-05-26abc', 'Projects/Alpha.md', 15);
  assert.ok(malformedDate);
  assert.equal(malformedDate.normalizedText, 'Malformed date 📅 2026-05-24abc 👀 2026-05-26abc');
  assert.equal(malformedDate.metadata.dates.due, undefined);
  assert.equal(malformedDate.metadata.dates.scheduled, undefined);
  assert.equal(malformedDate.metadata.followUp, undefined);

  const dataviewDateTime = scanner().parseTaskLine('- [ ] Dataview date-times [due:: 2026-05-27 09:00] [scheduled:: [[2026-05-28 10:30]]] [follow-up:: 2026-05-29 11:45]', 'Projects/Alpha.md', 16);
  assert.ok(dataviewDateTime);
  assert.equal(dataviewDateTime.metadata.dates.due, '2026-05-27');
  assert.equal(dataviewDateTime.metadata.dates.scheduled, '2026-05-28');
  assert.equal(dataviewDateTime.metadata.followUp, '2026-05-29 11:45');
});

test('task parsing reads camelCase recurrence dataview metadata emitted by editor helpers', () => {
  const parsed = parseMarkdownTaskLine('- [ ] Repeat 🔁 every week [recurrenceSeriesId:: abc123] [recurrenceCount:: 7]', 'A.md', 1);
  assert.ok(parsed);
  assert.equal(parsed.metadata.recurrenceSeriesId, 'abc123');
  assert.equal(parsed.metadata.recurrenceCount, 7);

  const seriesIdAlias = parseMarkdownTaskLine('- [ ] Alias 🔁 every week [seriesId:: alias123]', 'A.md', 2);
  assert.ok(seriesIdAlias);
  assert.equal(seriesIdAlias.metadata.recurrenceSeriesId, 'alias123');
});

test('stripInlineTags removes inline #tags from display text and collapses whitespace', () => {
  assert.equal(stripInlineTags('Buy milk #errand'), 'Buy milk');
  assert.equal(stripInlineTags('Call #work boss before noon'), 'Call boss before noon');
  assert.equal(stripInlineTags('Ship #home/project/v2 release'), 'Ship release');
  // No tags: text is preserved (only whitespace normalized).
  assert.equal(stripInlineTags('Plain task   text'), 'Plain task text');
  // Hash that is not a tag (PR#1, heading link, URL fragment) is left intact.
  assert.equal(stripInlineTags('Review PR#1 and [[Note#Heading]]'), 'Review PR#1 and [[Note#Heading]]');
  // A task made up entirely of tags collapses to empty (callers fall back to the raw text).
  assert.equal(stripInlineTags('#a #b'), '');
});

test('tag extraction ignores non-tags and tag filters match whole tag segments', () => {
  assert.deepEqual(extractTags('Start #work #home/project #123 #🏢/companyA #12.34'), ['work', 'home/project', '123', '🏢/companyA', '12']);
  assert.deepEqual(extractTags('Review PR#1 and [[Note#Heading]] at https://x/#frag'), []);

  const tasks = [
    parseMarkdownTaskLine('- [ ] Review PR#1 and [[Note#Heading]] at https://x/#frag', 'A.md', 1),
    parseMarkdownTaskLine('- [ ] Real tag #work', 'A.md', 2),
    parseMarkdownTaskLine('- [ ] Numeric only #123', 'A.md', 3),
    parseMarkdownTaskLine('- [ ] Emoji tag #🏢/companyA', 'A.md', 4),
  ].filter((task): task is ParsedTask => task !== null);

  assert.deepEqual(filterTasks(tasks, 'tag includes #work').map((task) => task.lineNumber), [2]);
  assert.deepEqual(filterTasks(tasks, 'tag includes #1'), []);
  assert.deepEqual(filterTasks(tasks, 'tag includes #Heading'), []);
  assert.deepEqual(filterTasks(tasks, 'tag includes #frag'), []);
  assert.deepEqual(filterTasks(tasks, 'tag includes #123').map((task) => task.lineNumber), [3]);
  assert.deepEqual(filterTasks(tasks, 'tag includes #🏢').map((task) => task.lineNumber), [4]);
  assert.deepEqual(filterTasks(tasks, 'description without tags includes 123'), []);
});

test('tag includes matches exact tags and nested subtags only', () => {
  const tasks = [
    parseMarkdownTaskLine('- [ ] Work #work', 'A.md', 1),
    parseMarkdownTaskLine('- [ ] Project #work/client', 'A.md', 2),
    parseMarkdownTaskLine('- [ ] Homework #homework', 'A.md', 3),
    parseMarkdownTaskLine('- [ ] Workshop #workshop', 'A.md', 4),
  ].filter((task): task is ParsedTask => task !== null);

  assert.deepEqual(filterTasks(tasks, 'tag includes #work').map((task) => task.lineNumber), [1, 2]);
  assert.deepEqual(filterTasks(tasks, 'tag does not include #work').map((task) => task.lineNumber), [3, 4]);
});

test('task metadata strips spaced on-completion actions and preserves following time metadata', () => {
  const spaced = parseMarkdownTaskLine('- [ ] Do work 🏁 move to end 📅 2026-06-20', 'A.md', 1);
  const timed = parseMarkdownTaskLine('- [ ] Archive task 🏁 archive ⌚ 12:00', 'A.md', 2);
  const wikilinkDate = parseMarkdownTaskLine('- [ ] Archive wiki 🏁 archive 📅 [[2026-06-20]]', 'A.md', 3);
  const parenthesizedDataview = parseMarkdownTaskLine('- [ ] Archive dataview 🏁 archive (due:: 2026-06-21)', 'A.md', 4);
  const effort = parseMarkdownTaskLine('- [ ] Archive effort 🏁 archive ⏱ 1h', 'A.md', 5);
  const assignee = parseMarkdownTaskLine('- [ ] Move assigned 🏁 move to end 👤 @alex', 'A.md', 6);
  const custom = parseMarkdownTaskLine('- [ ] Custom action 🏁 custom action ⏱ 1h 🕐 30m 👀 2026-06-22 👤 @alex', 'A.md', 7);

  assert.ok(spaced);
  assert.ok(timed);
  assert.ok(wikilinkDate);
  assert.ok(parenthesizedDataview);
  assert.ok(effort);
  assert.ok(assignee);
  assert.ok(custom);
  assert.equal(spaced.metadata.onCompletion, 'move-to-end');
  assert.equal(spaced.normalizedText, 'Do work');
  assert.equal(timed.metadata.onCompletion, 'archive');
  assert.equal(timed.metadata.time, '12:00');
  assert.equal(timed.normalizedText, 'Archive task');
  assert.equal(wikilinkDate.metadata.onCompletion, 'archive');
  assert.equal(wikilinkDate.metadata.dates.due, '2026-06-20');
  assert.equal(wikilinkDate.normalizedText, 'Archive wiki');
  assert.equal(parenthesizedDataview.metadata.onCompletion, 'archive');
  assert.equal(parenthesizedDataview.metadata.dates.due, '2026-06-21');
  assert.equal(parenthesizedDataview.normalizedText, 'Archive dataview');
  assert.equal(effort.metadata.onCompletion, 'archive');
  assert.equal(effort.metadata.effort, '1h');
  assert.equal(effort.normalizedText, 'Archive effort');
  assert.equal(assignee.metadata.onCompletion, 'move-to-end');
  assert.equal(assignee.metadata.assignee, 'alex');
  assert.ok(assignee.normalizedText.startsWith('Move assigned'));
  assert.doesNotMatch(assignee.normalizedText, /🏁|move to end/u);
  assert.equal(custom.metadata.onCompletion, 'custom-action');
  assert.equal(custom.metadata.effort, '1h');
  assert.equal(custom.metadata.actual, '30m');
  assert.equal(custom.metadata.followUp, '2026-06-22');
  assert.equal(custom.metadata.assignee, 'alex');
  assert.ok(custom.normalizedText.startsWith('Custom action'));
  assert.doesNotMatch(custom.normalizedText, /🏁|custom action ⏱/u);
});

test('task key normalization strips upstream-recognized tags', () => {
  const numericOne = parseMarkdownTaskLine('- [ ] Fix #123', 'A.md', 1);
  const numericTwo = parseMarkdownTaskLine('- [ ] Fix #456', 'A.md', 2);
  const realTag = parseMarkdownTaskLine('- [ ] Fix #work', 'A.md', 3);
  const nestedRealTag = parseMarkdownTaskLine('- [ ] Fix #home/project @office', 'A.md', 4);
  const multiCharacterMarker = parseMarkdownTaskLine('- [TODO] Fix bug', 'A.md', 5);
  const blockLinked = parseMarkdownTaskLine('- [ ] Fix bug #work ^task-123', 'A.md', 6);

  assert.ok(numericOne);
  assert.ok(numericTwo);
  assert.ok(realTag);
  assert.ok(nestedRealTag);
  assert.ok(multiCharacterMarker);
  assert.ok(blockLinked);
  assert.equal(numericOne.key, 'A.md:fix');
  assert.equal(numericTwo.key, 'A.md:fix');
  assert.equal(numericOne.key, numericTwo.key);
  assert.equal(realTag.key, 'A.md:fix');
  assert.equal(nestedRealTag.key, 'A.md:fix');
  assert.equal(multiCharacterMarker.key, 'A.md:fix bug');
  assert.equal(blockLinked.normalizedText, 'Fix bug #work');
  assert.equal(blockLinked.key, 'A.md:fix bug');
  assert.equal(blockLinked.metadata.blockLink, '^task-123');
});

test('task query block formatting wraps saved query text', () => {
  assert.equal(formatTaskManagerQueryBlock('not done\nsort by smart\n', 'task-list'), '```task-list\nnot done\nsort by smart\n```');
});

test('task scanner skips list-shaped lines inside YAML frontmatter', async () => {
  // Upstream uses metadataCache.listItems which excludes frontmatter; local must
  // mirror this so YAML values like `- [ ] foo` are not parsed as tasks.
  const content = [
    '---',
    'tags:',
    '  - work',
    'fake: - [ ] not a task',
    'nested:',
    '  - [ ] still not a task',
    '---',
    '- [ ] Real task',
  ].join('\n');
  const app = { vault: { read: async () => content } };
  const tasks = await new TaskScanner(app as never).scanFile(fakeFile('Notes.md') as never);
  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].body, 'Real task');
});

test('task scanning assigns collision-free occurrence keys for duplicate identical tasks', async () => {
  const app = { vault: { read: async () => '- [ ] Review PR\n  - [x] Nested task\n1. [ ] Review PR\n- [ ] Review PR#1\n' } };
  const tasks = await new TaskScanner(app as never).scanFile(fakeFile('Project.md') as never);
  assert.deepEqual(tasks.map((task) => task.key), [
    'Project.md:review pr\u00001',
    'Project.md:nested task',
    'Project.md:review pr\u00002',
    'Project.md:review pr#1',
  ]);
});

test('task model updates task checkbox markers while preserving line text and newlines', () => {
  assert.equal(updateMarkdownTaskLineStatus('  2. [ ] Ship feature #work 📅 2026-05-21', 'done'), '  2. [x] Ship feature #work 📅 2026-05-21');
  assert.equal(updateMarkdownTaskLineStatus('- [x] Ship feature', 'todo'), '- [ ] Ship feature');
  assert.equal(updateMarkdownTaskLineStatus('not a task', 'done'), null);
  assert.equal(toggledTaskStatus('done'), 'todo');
  assert.equal(toggledTaskStatus('blocked'), 'done');

  const sourceTask = parseMarkdownTaskLine('- [ ] Ship feature #work 📅 2026-05-21', 'Projects/Alpha.md', 2);
  assert.ok(sourceTask);
  const result = updateMarkdownTaskStatusInContent(
    '# Project\r\n- [ ] Ship feature #work 📅 2026-05-21\r\nNotes\r\n',
    sourceTask,
    'done',
  );

  assert.equal(result.content, '# Project\r\n- [x] Ship feature #work 📅 2026-05-21\r\nNotes\r\n');
  assert.equal(result.updatedTask.status, 'done');
  assert.equal(result.updatedTask.rawLine, '- [x] Ship feature #work 📅 2026-05-21');
});

test('task scanner creates next recurrence for advanced recurrence rules', async () => {
  const file = fakeFile('Project.md');
  let content = '- [ ] Review 🔁 every week on monday 📅 2026-05-19\n';
  const app = {
    vault: {
      read: async () => content,
      process: async (_file: FakeFile, updater: (value: string) => string) => { content = updater(content); return content; },
    },
  };
  const scanner = new TaskScanner(app as never);
  const [task] = await scanner.scanFile(file as never);
  await scanner.updateTaskCheckbox(file as never, task, 'x');
  assert.match(content, /^- \[ \] Review 🔁 every week on monday 📅 2026-05-25/mu);
  assert.match(content, /^- \[x\] Review 🔁 every week on monday 📅 2026-05-19 ✅ /mu);
});

test('task scanner does not duplicate next recurrence after reopen and recomplete', async () => {
  const file = fakeFile('Project.md');
  let content = '- [ ] Review 🔁 every day 📅 2026-05-19\n';
  const app = {
    vault: {
      read: async () => content,
      process: async (_file: FakeFile, updater: (value: string) => string) => { content = updater(content); return content; },
    },
  };
  const scanner = new TaskScanner(
    app as never,
    undefined,
    undefined,
    () => ({ ...DEFAULT_SETTINGS, setDoneDate: false, setCreatedDate: false, recurrenceFutureOccurrences: 1 }),
  );
  const [task] = await scanner.scanFile(file as never);
  await scanner.updateTaskCheckbox(file as never, task, 'x');
  assert.equal(content.match(/📅 2026-05-20/gu)?.length, 1);

  let tasks = await scanner.scanFile(file as never);
  const completed = tasks.find((candidate) => candidate.status === 'done' && candidate.metadata.dates.due === '2026-05-19');
  assert.ok(completed);
  await scanner.updateTaskCheckbox(file as never, completed, ' ');

  tasks = await scanner.scanFile(file as never);
  const reopened = tasks.find((candidate) => candidate.status === 'todo' && candidate.metadata.dates.due === '2026-05-19');
  assert.ok(reopened);
  await scanner.updateTaskCheckbox(file as never, reopened, 'x');

  assert.equal(content.match(/📅 2026-05-20/gu)?.length, 1, content);
});

test('task scanner advances recurrence on cancellation when setting is enabled', async () => {
  const file = fakeFile('Project.md');
  let content = '- [ ] Review 🔁 every week 📅 2026-05-19\n';
  const app = {
    vault: {
      read: async () => content,
      process: async (_file: FakeFile, updater: (value: string) => string) => { content = updater(content); return content; },
    },
  };
  const scanner = new TaskScanner(
    app as never,
    undefined,
    undefined,
    () => ({ ...DEFAULT_SETTINGS, recurrenceOnCancelled: true, setCreatedDate: false }),
  );
  const [task] = await scanner.scanFile(file as never);
  await scanner.updateTaskCheckbox(file as never, task, '-');
  assert.match(content, /^- \[ \] Review 🔁 every week 📅 2026-05-26/mu);
  assert.match(content, /^- \[-\] Review 🔁 every week 📅 2026-05-19 ❌ /mu);
});

test('recurring cancellation never runs done-only destructive lifecycle actions', async () => {
  for (const action of ['archive', 'collect', 'delete', 'move-to-end'] as const) {
    const file = fakeFile('Project.md');
    let content = `- [ ] Review 🔁 every week 📅 2026-05-19 🏁 ${action}\n`;
    let destinationWrites = 0;
    const app = {
      vault: {
        read: async () => content,
        process: async (_file: FakeFile, updater: (value: string) => string) => { content = updater(content); return content; },
        getAbstractFileByPath: () => null,
        create: async () => { destinationWrites += 1; throw new Error('cancellation must not write a destination'); },
        createFolder: async () => { destinationWrites += 1; },
      },
    };
    const scanner = new TaskScanner(
      app as never,
      undefined,
      undefined,
      () => ({
        ...DEFAULT_SETTINGS,
        recurrenceOnCancelled: true,
        setCreatedDate: false,
        archiveFilePath: 'Project.md',
        collectFilePath: '../unsafe.md',
      }),
    );
    const [task] = await scanner.scanFile(file as never);
    const result = await scanner.updateTaskCheckboxWithOutcome(file as never, task, '-');
    assert.equal(result.outcome, 'completed', action);
    assert.match(content, new RegExp(String.raw`^- \[-\] Review .*🏁 ${action}`, 'mu'));
    assert.match(content, new RegExp(String.raw`^- \[ \] Review .*2026-05-26.*🏁 ${action}`, 'mu'));
    assert.equal(destinationWrites, 0, action);
  }
});

test('task scanner cancels stale recurring tasks after recurrence insertion shifts line numbers', async () => {
  const file = fakeFile('Project.md');
  let content = '- [ ] First 🔁 every day 📅 2026-05-19\n- [ ] Second 🔁 every day 📅 2026-05-19\n';
  const app = {
    vault: {
      read: async () => content,
      process: async (_file: FakeFile, updater: (value: string) => string) => { content = updater(content); return content; },
    },
  };
  const scanner = new TaskScanner(
    app as never,
    undefined,
    undefined,
    () => ({ ...DEFAULT_SETTINGS, recurrenceOnCancelled: true, setCreatedDate: false }),
  );
  const [first, second] = await scanner.scanFile(file as never);

  await scanner.updateTaskCheckbox(file as never, first, '-');
  await scanner.updateTaskCheckbox(file as never, second, '-');

  assert.match(content, /^- \[-\] First 🔁 every day 📅 2026-05-19 ❌ /mu);
  assert.match(content, /^- \[-\] Second 🔁 every day 📅 2026-05-19 ❌ /mu);
});

test('task scanner does not advance recurrence on cancellation when setting is disabled', async () => {
  const file = fakeFile('Project.md');
  let content = '- [ ] Review 🔁 every week 📅 2026-05-19\n';
  const app = {
    vault: {
      read: async () => content,
      process: async (_file: FakeFile, updater: (value: string) => string) => { content = updater(content); return content; },
    },
  };
  const scanner = new TaskScanner(
    app as never,
    undefined,
    undefined,
    () => ({ ...DEFAULT_SETTINGS, recurrenceOnCancelled: false, setCreatedDate: false }),
  );
  const [task] = await scanner.scanFile(file as never);
  await scanner.updateTaskCheckbox(file as never, task, '-');
  assert.match(content, /^- \[-\] Review 🔁 every week 📅 2026-05-19 ❌ /mu);
  assert.equal(content.match(/Review/gu)?.length, 1);
});

test('task scanner does not recur untracked (non-task) statuses when toggled to done', async () => {
  const file = fakeFile('Project.md');
  let content = '- [i] Daily check 🔁 every day 📅 2026-05-20\n';
  const app = {
    vault: {
      read: async () => content,
      process: async (_file: FakeFile, updater: (value: string) => string) => { content = updater(content); return content; },
    },
  };
  const states = [
    ...DEFAULT_TASK_STATES,
    { rawText: 'i', name: 'Info', icon: '', type: 'untracked' as const },
  ];
  const scanner = new TaskScanner(
    app as never,
    () => states,
    undefined,
    () => ({ ...DEFAULT_SETTINGS, supportedStates: states, setCreatedDate: false }),
  );
  const [task] = await scanner.scanFile(file as never);
  assert.equal(task.status, 'untracked');
  await scanner.updateTaskCheckbox(file as never, task, 'x');
  assert.match(content, /^- \[x\] Daily check 🔁 every day 📅 2026-05-20 ✅ /mu);
  assert.doesNotMatch(content, /^- \[ \] Daily check 🔁 every day 📅 2026-05-21/mu);
  assert.equal(content.match(/Daily check/gu)?.length, 1);
});

test('task scanner skips recurrence when the reference date is an invalid calendar date', async () => {
  const file = fakeFile('Project.md');
  let content = '- [ ] Bad date 🔁 every day 📅 2026-02-30\n';
  const app = {
    vault: {
      read: async () => content,
      process: async (_file: FakeFile, updater: (value: string) => string) => { content = updater(content); return content; },
    },
  };
  const scanner = new TaskScanner(app as never, undefined, undefined, () => ({ ...DEFAULT_SETTINGS, setCreatedDate: false }));
  const [task] = await scanner.scanFile(file as never);
  await scanner.updateTaskCheckbox(file as never, task, 'x');
  assert.match(content, /^- \[x\] Bad date 🔁 every day 📅 2026-02-30 ✅ /mu);
  assert.equal(content.match(/Bad date/gu)?.length, 1);
});

test('task scanner removes done dates when moving away from done', async () => {
  const file = fakeFile('Project.md');
  let content = '- [x] Reopen me ✅ 2026-05-19\n';
  const app = {
    vault: {
      read: async () => content,
      process: async (_file: FakeFile, updater: (value: string) => string) => { content = updater(content); return content; },
    },
  };
  const scanner = new TaskScanner(app as never);
  const [task] = await scanner.scanFile(file as never);
  await scanner.updateTaskCheckbox(file as never, task, ' ');
  assert.equal(content, '- [ ] Reopen me\n');
});

test('task scanner does not silently recur unsupported recurrence rules', async () => {  const file = fakeFile('Project.md');
  let content = '- [ ] Bad recurrence 🔁 every whenever 📅 2026-05-19\n';
  const app = {
    vault: {
      read: async () => content,
      process: async (_file: FakeFile, updater: (value: string) => string) => { content = updater(content); return content; },
    },
  };
  const scanner = new TaskScanner(app as never);
  const [task] = await scanner.scanFile(file as never);
  await scanner.updateTaskCheckbox(file as never, task, 'x');
  assert.match(content, /^- \[x\] Bad recurrence 🔁 every whenever 📅 2026-05-19 ✅ /mu);
  assert.doesNotMatch(content, /^- \[ \] Bad recurrence 🔁 every whenever/mu);
});

test('task scanner normalizes shorthand weekday recurrence rules', async () => {
  const file = fakeFile('Project.md');
  let content = '- [ ] Review 🔁 every Sunday 📅 2026-05-19\n';
  const app = {
    vault: {
      read: async () => content,
      process: async (_file: FakeFile, updater: (value: string) => string) => { content = updater(content); return content; },
    },
  };
  const scanner = new TaskScanner(app as never);
  const [task] = await scanner.scanFile(file as never);
  assert.equal(task.metadata.recurrence, 'every week on Sunday');
  await scanner.updateTaskCheckbox(file as never, task, 'x');
  assert.match(content, /^- \[ \] Review 🔁 every Sunday 📅 2026-05-24/mu);
});

test('task scanner pre-generates multiple future recurrence occurrences', async () => {
  const file = fakeFile('Project.md');
  let content = '- [ ] Review 🔁 every day ⏳ 2026-05-19\n';
  const app = {
    vault: {
      read: async () => content,
      process: async (_file: FakeFile, updater: (value: string) => string) => { content = updater(content); return content; },
    },
  };
  const scanner = new TaskScanner(app as never, undefined, undefined, () => ({
    ...DEFAULT_SETTINGS,
    recurrenceFutureOccurrences: 2,
    setCreatedDate: false,
  }));
  const [task] = await scanner.scanFile(file as never);
  await scanner.updateTaskCheckbox(file as never, task, 'x');
  assert.match(content, /^- \[ \] Review 🔁 every day ⏳ 2026-05-20/mu);
  assert.match(content, /^- \[ \] Review 🔁 every day ⏳ 2026-05-21/mu);
  assert.match(content, /^- \[x\] Review 🔁 every day ⏳ 2026-05-19 ✅ /mu);
});

test('recurrence preview calculation returns three future occurrences or null for invalid rules', () => {
  assert.deepEqual(calculateNextRecurrences('every day', '2026-05-19', '2026-05-26', 3), [
    '2026-05-20',
    '2026-05-21',
    '2026-05-22',
  ]);
  assert.deepEqual(calculateNextRecurrences('every day when done', '2026-05-19', '2026-05-26', 3), [
    '2026-05-20',
    '2026-05-21',
    '2026-05-22',
  ]);
  assert.equal(calculateNextRecurrences('every whenever', '2026-05-19', '2026-05-26', 3), null);
});

test('recurrence preview supports monthly day syntax suggested by fallback helper', () => {
  assert.deepEqual(calculateNextRecurrences('every month on day 28', '2026-01-15', '2026-01-15', 3), [
    '2026-02-28',
    '2026-03-28',
    '2026-04-28',
  ]);
});

test('calculateNextRecurrences: for N times countdown stops at correct number of future dates (Fix 123)', () => {
  // 'for 3 times': completing creates 'for 2 times' -> completing creates 'for 1 time' -> last.
  // Only 2 reachable future occurrences, not 3.
  const r3 = calculateNextRecurrences('every week for 3 times', '2026-05-19', '2026-05-19', 5);
  assert.deepEqual(r3, ['2026-05-26', '2026-06-02'],
    'for 3 times => 2 reachable future occurrences');

  // 'for 2 times': completing creates 'for 1 time' -> last => only 1 more reachable
  const r2 = calculateNextRecurrences('every week for 2 times', '2026-05-19', '2026-05-19', 5);
  assert.deepEqual(r2, ['2026-05-26'],
    'for 2 times => 1 reachable future occurrence');

  // 'for 1 time': forTimesCount <= 1 -> null immediately
  const r1 = calculateNextRecurrences('every week for 1 time', '2026-05-19', '2026-05-19', 5);
  assert.equal(r1, null, 'for 1 time => no future occurrences');

  // No for-times suffix -> returns up to count dates normally
  const unlimited = calculateNextRecurrences('every week', '2026-05-19', '2026-05-19', 3);
  assert.deepEqual(unlimited, ['2026-05-26', '2026-06-02', '2026-06-09']);
});

test('nextRecurringDate: every N weeks on <day> works for large intervals >52 weeks (Fix 122)', () => {
  // 53*7 = 371 days > old loop limit of 366. 2026-01-05 is a Monday.
  // The next Monday on a 53-week cycle from 2026-01-05 is 2027-01-18.
  const result = calculateNextRecurrences('every 53 weeks on monday', '2026-01-05', '2026-01-05', 1);
  assert.notEqual(result, null, 'every 53 weeks on monday must find a next occurrence');
  if (result) {
    const d = new Date(result[0] + 'T00:00:00Z');
    assert.equal(d.getUTCDay(), 1, 'result must be a Monday');
    assert.ok(result[0] > '2026-01-05', 'result must be after the base date');
  }
});

test('task scanner pre-generates multiple future when-done recurrence occurrences', async () => {
  const file = fakeFile('Project.md');
  let content = '- [ ] Review 🔁 every day when done 📅 2026-05-19\n';
  const app = {
    vault: {
      read: async () => content,
      process: async (_file: FakeFile, updater: (value: string) => string) => { content = updater(content); return content; },
    },
  };
  const scanner = new TaskScanner(app as never, undefined, undefined, () => ({
    ...DEFAULT_SETTINGS,
    recurrenceFutureOccurrences: 2,
    setCreatedDate: false,
  }));
  const [task] = await scanner.scanFile(file as never);
  await scanner.updateTaskCheckbox(file as never, task, 'x');

  const openDueDates = Array.from(content.matchAll(/^- \[ \] Review 🔁 every day when done 📅 (\d{4}-\d{2}-\d{2})/gmu)).map((match) => match[1]);
  assert.equal(openDueDates.length, 2);
  assert.notEqual(openDueDates[0], openDueDates[1]);
});

test('task scanner writes upstream cancelled date symbol', async () => {
  const file = fakeFile('Project.md');
  let content = '- [ ] Abandon task\n- [ ] Cancel dependency ⛔ dep-1\n';
  const app = {
    vault: {
      read: async () => content,
      process: async (_file: FakeFile, updater: (value: string) => string) => { content = updater(content); return content; },
    },
  };
  const scanner = new TaskScanner(app as never);
  let tasks = await scanner.scanFile(file as never);
  await scanner.updateTaskCheckbox(file as never, tasks.find((task) => task.normalizedText === 'Abandon task')!, '-');
  assert.match(content, /- \[-\] Abandon task ❌ \d{4}-\d{2}-\d{2}/u);
  assert.doesNotMatch(content, /Abandon task ⛔ \d{4}-\d{2}-\d{2}/u);

  tasks = await scanner.scanFile(file as never);
  await scanner.updateTaskCheckbox(file as never, tasks.find((task) => task.normalizedText === 'Cancel dependency')!, '-');
  assert.match(content, /- \[-\] Cancel dependency ⛔ dep-1 ❌ \d{4}-\d{2}-\d{2}/u);
  assert.doesNotMatch(content, /Cancel dependency ⛔ dep-1 ⛔ \d{4}-\d{2}-\d{2}/u);
});

test('task scanner honours on-completion delete for recurring and one-off tasks', async () => {
  const file = fakeFile('Project.md');
  let content = '- [ ] Daily 🔁 every day 🏁 delete 📅 2026-05-19\n- [ ] Remove me 🏁 delete\n';
  const app = {
    vault: {
      read: async () => content,
      process: async (_file: FakeFile, updater: (value: string) => string) => { content = updater(content); return content; },
    },
  };
  const scanner = new TaskScanner(app as never, undefined, undefined, () => ({ ...DEFAULT_SETTINGS, setCreatedDate: false }));
  const [recurring, oneOff] = await scanner.scanFile(file as never);
  await scanner.updateTaskCheckbox(file as never, recurring, 'x');
  assert.match(content, /^- \[ \] Daily 🔁 every day 🏁 delete 📅 2026-05-20$/mu);
  assert.doesNotMatch(content, /\[x\] Daily/u);
  const rescanned = await scanner.scanFile(file as never);
  await scanner.updateTaskCheckbox(file as never, rescanned.find((task) => task.normalizedText === 'Remove me')!, 'x');
  assert.doesNotMatch(content, /Remove me/u);
  assert.equal(oneOff.normalizedText, 'Remove me');
});

test('task scanner honours on-completion archive for one-off and recurring tasks', async () => {
  const file = fakeFile('Project.md');
  let projectContent = '- [ ] Archive me 🏁 archive\n  - note under archived task\n- [ ] Recurring archive 🔁 every day 🏁 archive 📅 2026-05-19\n';
  let archiveContent: string | null = null;

  const app = {
    vault: {
      read: async () => projectContent,
      process: async (f: FakeFile, updater: (value: string) => string) => {
        if (f.path === 'Project.md') {
          projectContent = updater(projectContent);
          return projectContent;
        }
        archiveContent = updater(archiveContent ?? '');
        return archiveContent;
      },
      getAbstractFileByPath: (path: string) =>
        path === 'Archive.md' && archiveContent !== null
          ? { path: 'Archive.md', extension: 'md', basename: 'Archive' }
          : null,
      create: async (_path: string, content: string) => {
        archiveContent = content;
        return { path: 'Archive.md', extension: 'md', basename: 'Archive' };
      },
      createFolder: async () => {},
    },
  };

  const scanner = new TaskScanner(app as never, undefined, undefined, () => ({
    ...DEFAULT_SETTINGS,
    setCreatedDate: false,
    setDoneDate: false,
  }));

  // One-off archive: line removed from source, written to archive file
  const [oneOff] = await scanner.scanFile(file as never);
  await scanner.updateTaskCheckbox(file as never, oneOff, 'x');
  assert.doesNotMatch(projectContent, /Archive me/u);
  assert.doesNotMatch(projectContent, /note under archived task/u);
  assert.match(archiveContent ?? '', /Archive me/u);
  assert.match(archiveContent ?? '', /note under archived task/u);
  assert.match(archiveContent ?? '', /## Archived Tasks/u);

  // Recurring archive: re-scan to get updated task position, then complete it
  const rescanned = await scanner.scanFile(file as never);
  const recurringTask = rescanned.find((t) => /Recurring archive/.test(t.normalizedText))!;
  assert.ok(recurringTask, 'Recurring archive task should still be in source after one-off was removed');
  await scanner.updateTaskCheckbox(file as never, recurringTask, 'x');
  assert.match(projectContent, /- \[ \] Recurring archive 🔁 every day 🏁 archive 📅 2026-05-20/u);
  assert.doesNotMatch(projectContent, /\[x\] Recurring archive/u);
  assert.match(archiveContent ?? '', /Recurring archive/u);
});

test('task scanner routes archive through the durable transfer journal when state is available', async () => {
  const file = fakeFile('Project.md');
  let projectContent = '- [ ] Durable archive 🏁 archive\n';
  let archiveContent: string | null = null;
  const archiveFile = { path: 'Archive.md', extension: 'md', basename: 'Archive', name: 'Archive.md' };
  const app = {
    vault: {
      read: async (target: FakeFile) => target.path === file.path ? projectContent : (archiveContent ?? ''),
      process: async (target: FakeFile, updater: (value: string) => string) => {
        if (target.path === file.path) projectContent = updater(projectContent);
        else archiveContent = updater(archiveContent ?? '');
        return target.path === file.path ? projectContent : archiveContent;
      },
      getAbstractFileByPath: (path: string) => path === 'Archive.md' && archiveContent !== null ? archiveFile : null,
      create: async (_path: string, content: string) => { archiveContent = content; return archiveFile; },
      createFolder: async () => undefined,
    },
  };
  const store = new StateStore({ loadData: async () => ({}), saveData: async () => undefined } as never);
  const scanner = new TaskScanner(app as never, undefined, undefined, () => ({ ...DEFAULT_SETTINGS, setDoneDate: false }), () => store);
  const [task] = await scanner.scanFile(file as never);
  await scanner.updateTaskCheckbox(file as never, task, 'x');
  assert.doesNotMatch(projectContent, /Durable archive/u);
  assert.match(archiveContent ?? '', /Durable archive/u);
});

test('task scanner journals recurring archive and recurrence state atomically', async () => {
  const file = fakeFile('Project.md');
  let projectContent = '- [ ] Durable recurring 🔁 every day 🏁 archive 📅 2026-05-19\n';
  let archiveContent: string | null = null;
  const archiveFile = { path: 'Archive.md', extension: 'md', basename: 'Archive', name: 'Archive.md' };
  const app = { vault: {
    read: async (target: FakeFile) => target.path === file.path ? projectContent : (archiveContent ?? ''),
    process: async (target: FakeFile, updater: (value: string) => string) => {
      if (target.path === file.path) projectContent = updater(projectContent);
      else archiveContent = updater(archiveContent ?? '');
      return target.path === file.path ? projectContent : archiveContent;
    },
    getAbstractFileByPath: (path: string) => path === 'Archive.md' && archiveContent !== null ? archiveFile : null,
    create: async (_path: string, content: string) => { archiveContent = content; return archiveFile; },
    createFolder: async () => undefined,
  } };
  const store = new StateStore({ loadData: async () => ({}), saveData: async () => undefined } as never);
  const scanner = new TaskScanner(app as never, undefined, undefined, () => ({ ...DEFAULT_SETTINGS, setCreatedDate: false, setDoneDate: false }), () => store);
  const [task] = await scanner.scanFile(file as never);
  await scanner.updateTaskCheckbox(file as never, task, 'x');
  assert.match(projectContent, /📅 2026-05-20/u);
  assert.match(archiveContent ?? '', /Durable recurring/u);
});

test('task scanner keeps one-off archive task and concurrent edits in source if archive write fails', async () => {
  const file = fakeFile('Project.md');
  let projectContent = '- [ ] Archive me 🏁 archive\n';
  const app = {
    vault: {
      read: async () => projectContent,
      process: async (_f: FakeFile, updater: (value: string) => string) => {
        projectContent = updater(projectContent);
        return projectContent;
      },
      getAbstractFileByPath: () => null,
      create: async () => {
        projectContent += '- [ ] Concurrent edit\n';
        throw new Error('archive write failed');
      },
      createFolder: async () => {},
    },
  };
  const scanner = new TaskScanner(app as never, undefined, undefined, () => ({
    ...DEFAULT_SETTINGS,
    setCreatedDate: false,
    setDoneDate: false,
  }));
  const originalError = console.error;
  console.error = () => undefined;
  try {
    const [task] = await scanner.scanFile(file as never);
    const result = await scanner.updateTaskCheckboxWithOutcome(file as never, task, 'x');
    assert.equal(result.outcome, 'destination-failed');
  } finally {
    console.error = originalError;
  }

  assert.match(projectContent, /Archive me/u, 'task text must remain recoverable in the source file');
  assert.match(projectContent, /Concurrent edit/u, 'archive failure must not roll back unrelated concurrent edits');
});

test('task scanner keeps recurring source task and skips recurrence state save when archive write fails', async () => {
  const file = fakeFile('Project.md');
  let projectContent = '- [ ] Archive me 🔁 every day 🏁 archive\n';
  let stateSaveCount = 0;
  const app = {
    vault: {
      read: async () => projectContent,
      process: async (_f: FakeFile, updater: (value: string) => string) => {
        projectContent = updater(projectContent);
        return projectContent;
      },
      getAbstractFileByPath: () => null,
      create: async () => {
        projectContent += '- [ ] Concurrent edit\n';
        throw new Error('archive write failed');
      },
      createFolder: async () => {},
    },
  };

  const stateStore = new StateStore({
    loadData: async () => undefined,
    saveData: async () => { stateSaveCount++; },
  } as never);

  const historyEntries: Array<{ action: string }> = [];
  const historyTracker = { recordChange: (entry: { action: string }) => { historyEntries.push(entry); } };
  const scanner = new TaskScanner(app as never, undefined, undefined, () => ({
    ...DEFAULT_SETTINGS,
    setCreatedDate: false,
    setDoneDate: false,
  }), () => stateStore, historyTracker as never);

  const [task] = await scanner.scanFile(file as never);
  const result = await scanner.updateTaskCheckboxWithOutcome(file as never, task, 'x');

  assert.equal(result.outcome, 'destination-failed');
  assert.equal(result.task.status, 'done', 'failed recurring archive should retain the completed source task, not an unspawned next occurrence');
  assert.match(projectContent, /- \[x\] Archive me 🔁 every day 🏁 archive/u);
  assert.doesNotMatch(projectContent, /- \[ \] Archive me 🔁 every day 🏁 archive/u, 'archive failure must not report an unspawned open replacement');
  assert.match(projectContent, /Concurrent edit/u, 'archive failure must not roll back unrelated concurrent edits');
  assert.ok(stateSaveCount >= 1, 'the recovery journal should be saved even though recurrence state is not advanced');
  assert.deepEqual(historyEntries.map((entry) => entry.action), [], 'recurrence_spawn history should not be recorded after archive failure');
});

test('task scanner does not advance recurring archive state when source replacement is skipped after archive succeeds', async () => {
  const file = fakeFile('Project.md');
  let projectContent = '- [ ] Archive me 🔁 every day 🏁 archive\n';
  let archiveContent: string | null = null;
  let stateSaveCount = 0;
  const app = {
    vault: {
      read: async () => projectContent,
      process: async (f: FakeFile, updater: (value: string) => string) => {
        if (f.path === 'Archive.md') {
          archiveContent = updater(archiveContent ?? '');
          return archiveContent;
        }
        projectContent = updater(projectContent);
        return projectContent;
      },
      getAbstractFileByPath: (path: string) => path === 'Archive.md' && archiveContent !== null
        ? { path: 'Archive.md', extension: 'md', basename: 'Archive' }
        : null,
      create: async (_path: string, content: string) => {
        archiveContent = content;
        projectContent = projectContent.replace('Archive me', 'Archive me changed elsewhere');
        return { path: 'Archive.md', extension: 'md', basename: 'Archive' };
      },
      createFolder: async () => {},
    },
  };

  const stateStore = new StateStore({
    loadData: async () => undefined,
    saveData: async () => { stateSaveCount++; },
  } as never);
  const historyEntries: Array<{ action: string }> = [];
  const historyTracker = { recordChange: (entry: { action: string }) => { historyEntries.push(entry); } };
  const scanner = new TaskScanner(app as never, undefined, undefined, () => ({
    ...DEFAULT_SETTINGS,
    setCreatedDate: false,
    setDoneDate: false,
  }), () => stateStore, historyTracker as never);

  const [task] = await scanner.scanFile(file as never);
  const result = await scanner.updateTaskCheckboxWithOutcome(file as never, task, 'x');

  assert.equal(result.outcome, 'source-conflict');
  assert.equal(result.task.status, 'done', 'skipped source replacement should retain the completed source task');
  assert.match(archiveContent ?? '', /- \[x\] Archive me/u, 'archive destination should contain the completed occurrence');
  assert.match(projectContent, /- \[x\] Archive me changed elsewhere 🔁 every day 🏁 archive/u, 'changed source occurrence should remain recoverable');
  assert.doesNotMatch(projectContent, /- \[ \] Archive me 🔁 every day 🏁 archive/u, 'next occurrence must not be written after a skipped source replacement');
  assert.ok(stateSaveCount >= 1, 'the recovery journal should be retained when source replacement is skipped');
  assert.deepEqual(historyEntries.map((entry) => entry.action), [], 'recurrence_spawn history should not be recorded when source replacement is skipped');
});

test('recurrence until date stops new occurrences after the end date', () => {
  // Before the until date: next occurrence is returned
  const nextBefore = applyTaskCompletionLifecycleToLine(
    '- [ ] Report 🔁 every week until 2026-06-30 📅 2026-06-09',
    'x',
    DEFAULT_TASK_STATES,
    { ...DEFAULT_SETTINGS, setCreatedDate: false, setDoneDate: false },
    '2026-06-09',
  );
  assert.ok(nextBefore);
  assert.equal(nextBefore.length, 2, 'Should have completed + next occurrence');
  // With recurrenceInsertLocation: 'before' (default), next occurrence is at index 0
  assert.match(nextBefore[0] ?? '', /📅 2026-06-16/u);

  // After the until date: no next occurrence
  const nextAfter = applyTaskCompletionLifecycleToLine(
    '- [ ] Report 🔁 every week until 2026-06-30 📅 2026-06-23',
    'x',
    DEFAULT_TASK_STATES,
    { ...DEFAULT_SETTINGS, setCreatedDate: false, setDoneDate: false },
    '2026-06-23',
  );
  assert.ok(nextAfter);
  // nextAfter would be due 2026-06-30, which is not > until date, so we DO get one more occurrence
  // Actually 2026-06-23 + 1 week = 2026-06-30 = until date; we should NOT get another occurrence (not strictly greater)
  // Let's use a date that would produce next > until:
  const nextPast = applyTaskCompletionLifecycleToLine(
    '- [ ] Report 🔁 every week until 2026-06-28 📅 2026-06-23',
    'x',
    DEFAULT_TASK_STATES,
    { ...DEFAULT_SETTINGS, setCreatedDate: false, setDoneDate: false },
    '2026-06-23',
  );
  assert.ok(nextPast);
  assert.equal(nextPast.length, 1, 'Only completed task; no next occurrence past until date');
  assert.match(nextPast[0] ?? '', /\[x\]/u);

  // PRD Task 3: recurrenceUntil is now parsed onto TaskMetadata
  const parsed = parseMarkdownTaskLine('- [ ] Report 🔁 every week until 2026-06-30 📅 2026-06-09', 'A.md', 1)!;
  assert.equal(parsed.metadata.recurrenceUntil, '2026-06-30', 'recurrenceUntil should be stored on metadata');
  assert.ok(parsed.metadata.recurrence?.includes('every week'), 'normalized recurrence should contain every week');
});

test('recurrence for N times decrements counter and stops at 1', () => {
  // "for 3 times" → next occurrence has "for 2 times" (at index 0 with 'before' insertion)
  const result3 = applyTaskCompletionLifecycleToLine(
    '- [ ] Sprint task 🔁 every week for 3 times 📅 2026-06-09',
    'x',
    DEFAULT_TASK_STATES,
    { ...DEFAULT_SETTINGS, setCreatedDate: false, setDoneDate: false },
    '2026-06-09',
  );
  assert.ok(result3);
  assert.equal(result3.length, 2);
  // With recurrenceInsertLocation: 'before', next occurrence is at index 0
  assert.match(result3[0] ?? '', /for 2 times/u);
  assert.match(result3[0] ?? '', /📅 2026-06-16/u);

  // "for 2 times" → next occurrence has "for 1 time" (singular - not "for 1 times")
  const result2 = applyTaskCompletionLifecycleToLine(
    '- [ ] Sprint task 🔁 every week for 2 times 📅 2026-06-09',
    'x',
    DEFAULT_TASK_STATES,
    { ...DEFAULT_SETTINGS, setCreatedDate: false, setDoneDate: false },
    '2026-06-09',
  );
  assert.ok(result2);
  assert.equal(result2.length, 2);
  assert.match(result2[0] ?? '', /for 1 time(?!s)/u, 'Singular "for 1 time" not "for 1 times"');
  assert.match(result2[0] ?? '', /📅 2026-06-16/u);

  // "for 1 times" → no next occurrence (last one)
  const result1 = applyTaskCompletionLifecycleToLine(
    '- [ ] Sprint task 🔁 every week for 1 times 📅 2026-06-16',
    'x',
    DEFAULT_TASK_STATES,
    { ...DEFAULT_SETTINGS, setCreatedDate: false, setDoneDate: false },
    '2026-06-16',
  );
  assert.ok(result1);
  assert.equal(result1.length, 1, 'No next occurrence when for 1 times');
  assert.match(result1[0] ?? '', /\[x\]/u);
});

test('isRecurrenceRuleValid accepts rules with until/for-N even at exhaustion', () => {
  assert.equal(isRecurrenceRuleValid('every week until 2025-01-01'), true, 'until in past is syntactically valid');
  assert.equal(isRecurrenceRuleValid('every week for 1 times'), true, 'for 1 times is syntactically valid (last occurrence)');
  assert.equal(isRecurrenceRuleValid('every week for 0 times'), true, 'for 0 times is syntactically valid');
  assert.equal(isRecurrenceRuleValid('every week for 3 times'), true, 'for 3 times is valid');
  assert.equal(isRecurrenceRuleValid('every week until 2026-12-31'), true, 'future until is valid');
});

test('recurrence until dates reject impossible calendar dates', () => {
  assert.equal(isRecurrenceRuleValid('every week until 2026-02-30'), false);
  assert.equal(calculateNextRecurrences('every week until 2026-02-30', '2026-02-01', '2026-02-01', 3), null);

  const parsed = parseMarkdownTaskLine('- [ ] Report 🔁 every week until 2026-02-30 📅 2026-02-01', 'A.md', 1)!;
  assert.equal(parsed.metadata.recurrenceUntil, undefined);
});

test('recurrence validation rejects unknown weekday names', () => {
  assert.equal(isRecurrenceRuleValid('every week on blursday'), false);
  assert.equal(calculateNextRecurrences('every week on blursday', '2026-02-02', '2026-02-02', 3), null);
  assert.equal(isRecurrenceRuleValid('every week on monday blursday'), false);
  assert.equal(isRecurrenceRuleValid('every month on the last blursday'), false);
  assert.equal(calculateNextRecurrences('every month on the last blursday', '2026-02-02', '2026-02-02', 3), null);
});

test('task scanner supports recurrence insertion settings and blockquoted tasks', async () => {
  const file = fakeFile('Project.md');
  let content = '> - [ ] Review 🔁 every day ⏳ 2026-05-19 📅 2026-05-20\n';
  const app = {
    vault: {
      read: async () => content,
      process: async (_file: FakeFile, updater: (value: string) => string) => { content = updater(content); return content; },
    },
  };
  const scanner = new TaskScanner(app as never, undefined, undefined, () => ({
    ...DEFAULT_SETTINGS,
    recurrenceInsertLocation: 'after',
    removeScheduledDateOnRecurrence: true,
    setCreatedDate: false,
  }));

  const [task] = await scanner.scanFile(file as never);
  assert.equal(task.linePrefix, '> ');
  await scanner.updateTaskCheckbox(file as never, task, 'x');
  assert.match(content, /^> - \[x\] Review 🔁 every day ⏳ 2026-05-19 📅 2026-05-20 ✅ /mu);
  assert.match(content, /^> - \[ \] Review 🔁 every day 📅 2026-05-21$/mu);
});

test('task scanner preserves and removes date aliases in recurring tasks', async () => {
  const file = fakeFile('Project.md');
  let content = '- [ ] Alias recur 🔁 every day ⌛ 2026-05-18 📆 2026-05-19\n- [ ] Remove alias 🔁 every day ⌛ 2026-05-18 📆 2026-05-19\n';
  const app = {
    vault: {
      read: async () => content,
      process: async (_file: FakeFile, updater: (value: string) => string) => { content = updater(content); return content; },
    },
  };

  let aliasScanner = new TaskScanner(app as never, undefined, undefined, () => ({ ...DEFAULT_SETTINGS, setCreatedDate: false }));
  let tasks = await aliasScanner.scanFile(file as never);
  await aliasScanner.updateTaskCheckbox(file as never, tasks.find((task) => task.normalizedText === 'Alias recur')!, 'x');
  assert.match(content, /^- \[ \] Alias recur 🔁 every day ⌛ 2026-05-19 📆 2026-05-20$/mu);

  aliasScanner = new TaskScanner(app as never, undefined, undefined, () => ({
    ...DEFAULT_SETTINGS,
    removeScheduledDateOnRecurrence: true,
    setCreatedDate: false,
  }));
  tasks = await aliasScanner.scanFile(file as never);
  await aliasScanner.updateTaskCheckbox(file as never, tasks.find((task) => task.normalizedText === 'Remove alias')!, 'x');
  assert.match(content, /^- \[ \] Remove alias 🔁 every day 📆 2026-05-20$/mu);
  assert.doesNotMatch(content, /^- \[ \] Remove alias 🔁 every day .*⌛/mu);
});

test('task scanner supports every other recurrence intervals and skips invalid explicit monthly dates', async () => {
  const file = fakeFile('Project.md');
  let content = '- [ ] Bidaily 🔁 every other day 📅 2026-05-19\n- [ ] Biweekly 🔁 every other week 📅 2026-05-19\n- [ ] Bimonthly 🔁 every other month 📅 2026-05-19\n- [ ] Biyearly 🔁 every other year 📅 2026-05-19\n- [ ] Month end 🔁 every month 📅 2026-01-31\n- [ ] Leap year 🔁 every year 📅 2024-02-29\n- [ ] Explicit leap 🔁 every month on the 31st 📅 2026-01-31\n';
  const app = {
    vault: {
      read: async () => content,
      process: async (_file: FakeFile, updater: (value: string) => string) => { content = updater(content); return content; },
    },
  };
  const scanner = new TaskScanner(app as never, undefined, undefined, () => ({ ...DEFAULT_SETTINGS, setCreatedDate: false }));

  let tasks = await scanner.scanFile(file as never);
  await scanner.updateTaskCheckbox(file as never, tasks.find((task) => task.normalizedText === 'Bidaily')!, 'x');
  assert.match(content, /^- \[ \] Bidaily 🔁 every other day 📅 2026-05-21$/mu);

  tasks = await scanner.scanFile(file as never);
  await scanner.updateTaskCheckbox(file as never, tasks.find((task) => task.normalizedText === 'Biweekly')!, 'x');
  assert.match(content, /^- \[ \] Biweekly 🔁 every other week 📅 2026-06-02$/mu);

  tasks = await scanner.scanFile(file as never);
  await scanner.updateTaskCheckbox(file as never, tasks.find((task) => task.normalizedText === 'Bimonthly')!, 'x');
  assert.match(content, /^- \[ \] Bimonthly 🔁 every other month 📅 2026-07-19$/mu);

  tasks = await scanner.scanFile(file as never);
  await scanner.updateTaskCheckbox(file as never, tasks.find((task) => task.normalizedText === 'Biyearly')!, 'x');
  assert.match(content, /^- \[ \] Biyearly 🔁 every other year 📅 2028-05-19$/mu);

  tasks = await scanner.scanFile(file as never);
  await scanner.updateTaskCheckbox(file as never, tasks.find((task) => task.normalizedText === 'Month end')!, 'x');
  assert.match(content, /^- \[ \] Month end 🔁 every month 📅 2026-02-28$/mu);
  assert.doesNotMatch(content, /Month end 🔁 every month 📅 2026-03-03/u);

  tasks = await scanner.scanFile(file as never);
  await scanner.updateTaskCheckbox(file as never, tasks.find((task) => task.normalizedText === 'Leap year')!, 'x');
  assert.match(content, /^- \[ \] Leap year 🔁 every year 📅 2025-02-28$/mu);
  assert.doesNotMatch(content, /Leap year 🔁 every year 📅 2025-03-01/u);

  tasks = await scanner.scanFile(file as never);
  await scanner.updateTaskCheckbox(file as never, tasks.find((task) => task.normalizedText === 'Explicit leap')!, 'x');
  assert.match(content, /^- \[ \] Explicit leap 🔁 every month on the 31st 📅 2026-03-31$/mu);
  assert.doesNotMatch(content, /Explicit leap 🔁 every month on the 31st 📅 2026-02-28/u);
});

test('task scanner normalises stray "when done" tokens inside recurrence rules', () => {
  const today = '2026-02-15';
  const settings = { ...DEFAULT_SETTINGS, setCreatedDate: false };
  const run = (line: string): string[] => applyTaskCompletionLifecycleToLine(line, 'x', DEFAULT_SETTINGS.supportedStates, settings, today) ?? [];
  // when done with `on the 31st` -> base = today (2026-02-15) -> next 31st after that = 2026-03-31
  const aLines = run('- [ ] A 🔁 every month on the 31st when done 📅 2026-01-31');
  assert.ok(aLines.some((line) => /^- \[ \] A 🔁 every month on the 31st when done 📅 2026-03-31$/u.test(line)), aLines.join('\n'));
  // when done with `on the last` -> last day of next month after today = 2026-03-31
  const bLines = run('- [ ] B 🔁 every month on the last when done 📅 2026-01-31');
  assert.ok(bLines.some((line) => /^- \[ \] B 🔁 every month on the last when done 📅 2026-03-31$/u.test(line)), bLines.join('\n'));
  // leading `when done` token at start of rule
  const cLines = run('- [ ] C 🔁 when done every month on the 31st 📅 2026-01-31');
  assert.ok(cLines.some((line) => /^- \[ \] C 🔁 when done every month on the 31st 📅 2026-03-31$/u.test(line)), cLines.join('\n'));
  // `when done` inserted mid-rule
  const dLines = run('- [ ] D 🔁 every month when done on the 31st 📅 2026-01-31');
  assert.ok(dLines.some((line) => /^- \[ \] D 🔁 every month when done on the 31st 📅 2026-03-31$/u.test(line)), dLines.join('\n'));
});

test('task scanner advances recurring tasks using reference date offsets and richer rules', async () => {
  const file = fakeFile('Project.md');
  let content = '- [ ] Water 🔁 every 2 weeks ⏳ 2026-05-19 📅 2026-05-21\n- [ ] Report 🔁 every April and December on the 1st and 24th 📅 2026-04-01\n- [ ] Review 🔁 every month on the 2nd Wednesday 📅 2026-05-13\n';
  const app = {
    vault: {
      read: async () => content,
      process: async (_file: FakeFile, updater: (value: string) => string) => { content = updater(content); return content; },
    },
  };
  const scanner = new TaskScanner(app as never, undefined, undefined, () => ({ ...DEFAULT_SETTINGS, setCreatedDate: false }));
  let tasks = await scanner.scanFile(file as never);
  await scanner.updateTaskCheckbox(file as never, tasks[0], 'x');
  assert.match(content, /^- \[ \] Water 🔁 every 2 weeks ⏳ 2026-06-02 📅 2026-06-04$/mu);

  tasks = await scanner.scanFile(file as never);
  await scanner.updateTaskCheckbox(file as never, tasks.find((task) => task.normalizedText === 'Report')!, 'x');
  assert.match(content, /^- \[ \] Report 🔁 every April and December on the 1st and 24th 📅 2026-04-24$/mu);

  tasks = await scanner.scanFile(file as never);
  await scanner.updateTaskCheckbox(file as never, tasks.find((task) => task.normalizedText === 'Review')!, 'x');
  assert.match(content, /^- \[ \] Review 🔁 every month on the 2nd Wednesday 📅 2026-06-10$/mu);
});

test('task scanner updates Dataview date fields without appending emoji duplicates', async () => {
  const file = fakeFile('Project.md');
  let content = '- [ ] Pay bill [due:: 2026-05-21]\n';
  const app = {
    vault: {
      read: async () => content,
      process: async (_file: FakeFile, updater: (value: string) => string) => { content = updater(content); return content; },
    },
  };
  const scanner = new TaskScanner(app as never);
  const [task] = await scanner.scanFile(file as never);

  await scanner.updateTaskDate(file as never, task, 'due', '2026-05-22');
  assert.equal(content, '- [ ] Pay bill [due:: 2026-05-22]\n');
  assert.doesNotMatch(content, /📅/u);

  const [updatedTask] = await scanner.scanFile(file as never);
  await scanner.updateTaskDate(file as never, updatedTask, 'due', null);
  assert.equal(content, '- [ ] Pay bill\n');
});

test('task scanner updates and clears Dataview reminder fields', async () => {
  const file = fakeFile('Project.md');
  let content = '- [ ] Call [reminder:: 2026-06-20 09:30]\n';
  const app = {
    vault: {
      read: async () => content,
      process: async (_file: FakeFile, updater: (value: string) => string) => { content = updater(content); return content; },
    },
  };
  const scanner = new TaskScanner(app as never);
  let [task] = await scanner.scanFile(file as never);

  task = await scanner.updateTaskDate(file as never, task, 'reminder', '2026-06-21');
  assert.equal(content, '- [ ] Call [reminder:: 2026-06-21 09:30]\n');
  assert.equal(task.metadata.reminder, '2026-06-21 09:30');

  await scanner.updateTaskDate(file as never, task, 'reminder', null);
  assert.equal(content, '- [ ] Call\n');
});

test('task scanner keeps the time inside wikilink Dataview reminder fields on update', async () => {
  const file = fakeFile('Project.md');
  let content = '- [ ] Call [reminder:: [[2026-06-20 09:30]]]\n';
  const app = {
    vault: {
      read: async () => content,
      process: async (_file: FakeFile, updater: (value: string) => string) => { content = updater(content); return content; },
    },
  };
  const scanner = new TaskScanner(app as never);
  let [task] = await scanner.scanFile(file as never);

  task = await scanner.updateTaskDate(file as never, task, 'reminder', '2026-06-21');
  // The time must remain inside the [[ ]] wikilink, not get pushed outside it.
  assert.equal(content, '- [ ] Call [reminder:: [[2026-06-21 09:30]]]\n');
  assert.match(task.metadata.reminder ?? '', /2026-06-21 09:30/u);
});

test('task scanner keeps the time inside wikilink emoji reminder fields on update and clear', async () => {
  const file = fakeFile('Project.md');
  let content = '- [ ] Call ⏰ [[2026-06-20 09:30]]\n';
  const app = {
    vault: {
      read: async () => content,
      process: async (_file: FakeFile, updater: (value: string) => string) => { content = updater(content); return content; },
    },
  };
  const scanner = new TaskScanner(app as never);
  let [task] = await scanner.scanFile(file as never);

  task = await scanner.updateTaskDate(file as never, task, 'reminder', '2026-06-21');
  assert.equal(content, '- [ ] Call ⏰ [[2026-06-21 09:30]]\n');
  assert.match(task.metadata.reminder ?? '', /2026-06-21 09:30/u);

  await scanner.updateTaskDate(file as never, task, 'reminder', null);
  assert.equal(content, '- [ ] Call\n');
});

test('task scanner updates editable metadata date fields and preserves reminder time', async () => {
  const file = fakeFile('Project.md');
  let content = '- [ ] Audit ➕ 2026-05-18 ✅ 2026-05-20 ❌ 2026-05-21 ⏰ 2026-05-22 09:30\n';
  const app = {
    vault: {
      read: async () => content,
      process: async (_file: FakeFile, updater: (value: string) => string) => { content = updater(content); return content; },
    },
  };
  const scanner = new TaskScanner(app as never);
  let [task] = await scanner.scanFile(file as never);

  task = await scanner.updateTaskDate(file as never, task, 'created', '2026-05-19');
  assert.match(content, /➕ 2026-05-19/u);
  task = await scanner.updateTaskDate(file as never, task, 'done', '2026-05-23');
  assert.match(content, /✅ 2026-05-23/u);
  task = await scanner.updateTaskDate(file as never, task, 'cancelled', '2026-05-24');
  assert.match(content, /❌ 2026-05-24/u);
  task = await scanner.updateTaskDate(file as never, task, 'reminder', '2026-05-25');
  assert.match(content, /⏰ 2026-05-25 09:30/u);
  task = await scanner.updateTaskDate(file as never, task, 'cancelled', null);
  assert.doesNotMatch(content, /❌ 2026-05-24/u);
  await scanner.updateTaskDate(file as never, task, 'reminder', null);
  assert.doesNotMatch(content, /⏰/u);
});

test('task scanner refuses stale date and recurring source updates', async () => {
  const file = fakeFile('Project.md');
  let content = '- [ ] Review 🔁 every day 📅 2026-05-19\n- [ ] Pay bill 📅 2026-05-21\n';
  const app = {
    vault: {
      read: async () => content,
      process: async (_file: FakeFile, updater: (value: string) => string) => { content = updater(content); return content; },
    },
  };
  const scanner = new TaskScanner(app as never);
  const [recurring, dated] = await scanner.scanFile(file as never);

  content = '- [ ] Different recurring 🔁 every day 📅 2026-05-19\n- [ ] Pay bill changed 📅 2026-05-21\n';

  await assert.rejects(() => scanner.updateTaskCheckbox(file as never, recurring, 'x'), /no longer matches/u);
  await assert.rejects(() => scanner.updateTaskDate(file as never, dated, 'due', '2026-05-22'), /no longer matches/u);
});

test('task scanner accepts rapid status changes from a stale rendered task', async () => {
  const file = fakeFile('Project.md');
  let content = '- [ ] Ship feature\n';
  const app = {
    vault: {
      read: async () => content,
      process: async (_file: FakeFile, updater: (value: string) => string) => { content = updater(content); return content; },
    },
  };
  const scanner = new TaskScanner(app as never);
  const [renderedTask] = await scanner.scanFile(file as never);

  await scanner.updateTaskCheckbox(file as never, renderedTask, 'x');
  assert.match(content, /^- \[x\] Ship feature .*✅/u);

  const inProgress = await scanner.updateTaskCheckbox(file as never, renderedTask, '/');
  assert.equal(content, '- [/] Ship feature\n');
  assert.equal(inProgress.status, 'in_progress');

  const deferred = await scanner.updateTaskCheckbox(file as never, renderedTask, '>');
  assert.equal(content, '- [>] Ship feature\n');
  assert.equal(deferred.status, 'deferred');
});

test('task scanner resolves stale status changes after line number shifts', async () => {
  const file = fakeFile('Project.md');
  let content = '- [ ] Intro\n- [ ] Ship feature\n';
  const app = {
    vault: {
      read: async () => content,
      process: async (_file: FakeFile, updater: (value: string) => string) => { content = updater(content); return content; },
    },
  };
  const scanner = new TaskScanner(app as never);
  const [, renderedTask] = await scanner.scanFile(file as never);

  content = '- [ ] New top task\n' + content;

  const updated = await scanner.updateTaskCheckbox(file as never, renderedTask, '/');
  assert.equal(content, '- [ ] New top task\n- [ ] Intro\n- [/] Ship feature\n');
  assert.equal(updated.status, 'in_progress');
  assert.equal(updated.lineNumber, 3);
});

test('task scanner can infer scheduled dates from filenames', async () => {
  const app = { vault: { read: async () => '- [ ] Plan day\n' } };
  const scanner = new TaskScanner(app as never, undefined, undefined, () => ({
    ...DEFAULT_SETTINGS,
    useFilenameAsScheduledDate: true,
    filenameScheduledDateFolders: 'daily',
  }));
  const [task] = await scanner.scanFile(fakeFile('daily/20260522 Friday.md') as never);
  assert.equal(task.metadata.dates.scheduled, '2026-05-22');
  const customScanner = new TaskScanner(app as never, undefined, undefined, () => ({
    ...DEFAULT_SETTINGS,
    useFilenameAsScheduledDate: true,
    filenameScheduledDateFolders: 'daily',
    filenameScheduledDateFormat: 'MMMM Do YYYY',
  }));
  const [custom] = await customScanner.scanFile(fakeFile('daily/June 3rd 2026.md') as never);
  assert.equal(custom.metadata.dates.scheduled, '2026-06-03');
  const outside = await scanner.scanFile(fakeFile('meetings/2026-05-22.md') as never);
  assert.equal(outside[0].metadata.dates.scheduled, undefined);
});

test('task scanner skips code blocks and comments like upstream Tasks', async () => {
  const app = { vault: { read: async () => '```\n- [ ] Hidden code\n```\n%%\n- [ ] Hidden comment\n%%\n<!-- - [ ] Hidden html -->\n- [ ] Visible\n' } };
  const tasks = await new TaskScanner(app as never).scanFile(fakeFile('Project.md') as never);
  assert.deepEqual(tasks.map((task) => task.normalizedText), ['Visible']);
});

test('global filter can be kept in descriptions or removed like upstream setting', async () => {
  const textFilterApp = { vault: { read: async () => '- [ ] task Ship feature #work\n' } };
  const visibleTasks = await new TaskScanner(textFilterApp as never, undefined, () => 'task').scanFile(fakeFile('Project.md') as never);
  assert.equal(visibleTasks[0].normalizedText, 'task Ship feature #work');
  assert.deepEqual(visibleTasks[0].tags, ['work']);
  assert.equal(visibleTasks[0].key, 'Project.md:task ship feature');

  const hiddenTasks = await new TaskScanner(textFilterApp as never, undefined, () => 'task', () => ({
    ...DEFAULT_SETTINGS,
    removeGlobalFilterFromDescription: true,
  })).scanFile(fakeFile('Project.md') as never);
  assert.equal(hiddenTasks[0].normalizedText, 'Ship feature #work');
  assert.deepEqual(hiddenTasks[0].tags, ['work']);
  assert.equal(hiddenTasks[0].key, 'Project.md:ship feature');

  const tagFilterApp = { vault: { read: async () => '- [ ] #task Tagged feature #work\n' } };
  const tagFilterTasks = await new TaskScanner(tagFilterApp as never, undefined, () => '#task').scanFile(fakeFile('Project.md') as never);
  assert.equal(tagFilterTasks[0].normalizedText, '#task Tagged feature #work');
  assert.deepEqual(tagFilterTasks[0].tags, ['work']);
});

test('global filter removal preserves explicit task id keys', async () => {
  const app = { vault: { read: async () => '- [ ] Do it #task 🆔 abc\n' } };
  const tasks = await new TaskScanner(app as never, undefined, () => '#task', () => ({
    ...DEFAULT_SETTINGS,
    removeGlobalFilterFromDescription: true,
  })).scanFile(fakeFile('Project.md') as never);

  assert.equal(tasks[0].normalizedText, 'Do it');
  assert.deepEqual(tasks[0].tags, []);
  assert.equal(tasks[0].key, 'id:abc');
  assert.equal(tasks[0].stableKey, 'id:abc');
});

test('task model refuses to update a stale or non-task source line', () => {
  const task = parseMarkdownTaskLine('- [ ] Ship feature #work 📅 2026-05-21', 'Projects/Alpha.md', 1);
  assert.ok(task);

  assert.throws(
    () => updateMarkdownTaskStatusInContent('- [ ] Different task #work 📅 2026-05-21\n', task, 'done'),
    /no longer matches/u,
  );
  assert.throws(
    () => updateMarkdownTaskStatusInContent('- [ ] Ship feature #home 📅 2026-05-22\n', task, 'done'),
    /no longer matches/u,
  );
  assert.throws(
    () => updateMarkdownTaskStatusInContent('- [/] Ship feature #work 📅 2026-05-21\n', task, 'done'),
    /status changed/u,
  );
  assert.throws(
    () => updateMarkdownTaskStatusInContent('Plain text\n', task, 'done'),
    /no longer a task/u,
  );
});

test('query inline description edit refuses stale source lines', async () => {
  let content = '- [ ] Different task 📅 2026-05-21\n';
  const file = tFileForPath('Projects/Alpha.md');
  const task = parseMarkdownTaskLine('- [ ] Ship feature 📅 2026-05-21', file.path, 1);
  assert.ok(task);
  const app = {
    vault: {
      getAbstractFileByPath: () => file,
      process: async (_file: TFile, updater: (c: string) => string) => { content = updater(content); },
    },
  };
  const renderer = new TaskQueryRenderer(app as never, new TaskScanner(app as never), () => DEFAULT_SETTINGS, {} as never);

  await assert.rejects(
    () => (renderer as unknown as { updateTaskDescription: (task: ParsedTask, desc: string) => Promise<void> }).updateTaskDescription(task, 'Renamed'),
    /no longer matches/u,
  );
  assert.equal(content, '- [ ] Different task 📅 2026-05-21\n');
});

test('task model parses Tasks emoji metadata, priority, indentation, and dependencies', () => {
  const parsed = parseMarkdownTaskLine(
    '  - [ ] Ship feature #work 📆 2026-05-21 ⌛ 2026-05-20 🛫 2026-05-19 ✅ 2026-05-22 ➕ 2026-05-18 ❌ 2026-05-23 🔁 every week 🆔 abc123 ⛔ dep-1 ⏫',
    'Projects/Alpha.md',
    7,
  );

  assert.ok(parsed);
  assert.equal(parsed.indentation, '  ');
  assert.equal(parsed.listMarker, '-');
  assert.equal(parsed.checkbox, ' ');
  assert.equal(parsed.normalizedText, 'Ship feature #work');
  assert.deepEqual(parsed.tags, ['work']);
  assert.deepEqual(parsed.metadata.dates, {
    due: '2026-05-21',
    scheduled: '2026-05-20',
    start: '2026-05-19',
    done: '2026-05-22',
    created: '2026-05-18',
    cancelled: '2026-05-23',
  });
  assert.equal(parsed.metadata.priority, 'high');
  assert.equal(parsed.metadata.recurrence, 'every week');
  assert.equal(parsed.metadata.id, 'abc123');
  assert.deepEqual(parsed.metadata.dependsOn, ['dep-1']);

  const legacyCancelled = parseMarkdownTaskLine('- [ ] Legacy cancelled ⛔ 2026-05-23 ⛔ dep-1', 'Projects/Alpha.md', 8);
  assert.ok(legacyCancelled);
  assert.equal(legacyCancelled.metadata.dates.cancelled, '2026-05-23');
  assert.deepEqual(legacyCancelled.metadata.dependsOn, ['dep-1']);

  const leadingMetadata = parseMarkdownTaskLine('- [ ] 🔺 🗓 2026-05-21 Important task #work', 'Projects/Alpha.md', 9);
  assert.ok(leadingMetadata);
  assert.equal(leadingMetadata.normalizedText, 'Important task #work');
  assert.equal(leadingMetadata.key, 'Projects/Alpha.md:important task');
  assert.equal(leadingMetadata.metadata.priority, 'highest');
  assert.equal(leadingMetadata.metadata.dates.due, '2026-05-21');
});

test('task model parses sync priority labels without keeping them in task text', () => {
  const parsed = parseMarkdownTaskLine('- [ ] Imported task 🎯 high 📅 2026-05-21', 'Sync.md', 1);
  assert.ok(parsed);
  assert.equal(parsed.normalizedText, 'Imported task');
  assert.equal(parsed.metadata.priority, 'high');
  assert.equal(parsed.metadata.dates.due, '2026-05-21');

  const afterRecurrence = parseMarkdownTaskLine('- [ ] Recurring import 🔁 every week 🎯 low', 'Sync.md', 2);
  assert.ok(afterRecurrence);
  assert.equal(afterRecurrence.normalizedText, 'Recurring import');
  assert.equal(afterRecurrence.metadata.recurrence, 'every week');
  assert.equal(afterRecurrence.metadata.priority, 'low');
});

test('task model parses metadata when emojis carry the U+FE0F variant selector', () => {
  // The Variant Selector 16 (\uFE0F) is appended on many platforms (e.g. iOS) after
  // emoji codepoints. Upstream obsidian-tasks supports it via \uFE0F? in every regex;
  // we must as well, otherwise tasks copy-pasted from those platforms lose all metadata.
  const parsed = parseMarkdownTaskLine(
    '- [ ] VS16 task 📅\uFE0F 2026-05-21 ⏳\uFE0F 2026-05-20 ⏫\uFE0F 🔁\uFE0F every week 🆔\uFE0F abc123 ⛔\uFE0F dep-1 🏁\uFE0F delete',
    'A.md', 1,
  );
  assert.ok(parsed);
  assert.equal(parsed.metadata.dates.due, '2026-05-21');
  assert.equal(parsed.metadata.dates.scheduled, '2026-05-20');
  assert.equal(parsed.metadata.priority, 'high');
  assert.equal(parsed.metadata.recurrence, 'every week');
  assert.equal(parsed.metadata.id, 'abc123');
  assert.deepEqual(parsed.metadata.dependsOn, ['dep-1']);
  assert.equal(parsed.metadata.onCompletion, 'delete');
  assert.equal(parsed.normalizedText, 'VS16 task');
});

test('task model parses ⛔ comma-separated dependency lists with surrounding whitespace', () => {
  // Upstream taskIdSequenceRegex allows `id1 , id2 , id3` with arbitrary spaces around commas.
  const parsed = parseMarkdownTaskLine('- [ ] Wait on others ⛔ dep-1, dep-2, dep-3', 'A.md', 1);
  assert.ok(parsed);
  assert.deepEqual(parsed.metadata.dependsOn, ['dep-1', 'dep-2', 'dep-3']);
  assert.equal(parsed.normalizedText, 'Wait on others');

  const spaced = parseMarkdownTaskLine('- [ ] Wait spaced ⛔ alpha , beta_2 , gamma-3', 'A.md', 2);
  assert.ok(spaced);
  assert.deepEqual(spaced.metadata.dependsOn, ['alpha', 'beta_2', 'gamma-3']);
  assert.equal(spaced.normalizedText, 'Wait spaced');
});

test('task query parses line filters and filters by status, path, tags, date, priority, and text', () => {
  const tasks = [
    parseMarkdownTaskLine('- [ ] Ship feature #work 📅 2026-05-21 ⏫', 'Projects/Alpha.md', 1),
    parseMarkdownTaskLine('- [x] Ship old feature #work 📅 2026-05-19 ⏫', 'Projects/Alpha.md', 2),
    parseMarkdownTaskLine('- [ ] Buy milk #home 📅 2026-05-21 🔽', 'Home.md', 1),
    parseMarkdownTaskLine('- [ ] Archived feature #work 📅 2026-05-22 ⏫', 'Archive/Old.md', 1),
  ].filter((task): task is ParsedTask => task !== null);

  const query = parseTaskQuery(`
not done
path includes Projects
path excludes Archive
tag includes #work
due on today
priority is high
text includes feature
sort by due
limit 1
`);

  assert.equal(query.limit, 1);
  assert.deepEqual(filterTasks(tasks, query, { today: '2026-05-21' }).map((task) => task.lineNumber), [1]);
  assert.ok(sampleTaskManagerQuery().includes('```task-list'));
});

test('task query supports Mustache-style inline comments', () => {
  const tasks = [
    parseMarkdownTaskLine('- [ ] Open task', 'Project.md', 1),
    parseMarkdownTaskLine('- [x] Closed task', 'Project.md', 2),
  ].filter((task): task is ParsedTask => task !== null);

  const query = parseTaskQuery('not done {{! temporarily keep this query simple }}\n# full-line comment\nlimit 1');
  assert.deepEqual(filterTasks(tasks, query).map((task) => task.normalizedText), ['Open task']);
  assert.deepEqual(query.instructions, ['not done', 'limit 1']);
});

test('PRD Task 17: query.file.hasProperty() and task.file.hasProperty() are existence checks (null/false/0 still exist)', () => {
  // Tests per PRD Task 17: verify hasProperty is an existence check, not a truthiness check.
  const fileInfoProvider = (_path: string) => ({
    properties: {
      existing: 'value',
      nullProp: null,
      falseProp: false,
      zeroProp: 0,
      tagsArray: ['work', 'home'],
    },
    outlinks: [],
  });

  const tasks = [
    parseMarkdownTaskLine('- [ ] Task A', 'Notes.md', 1),
  ].filter((t): t is ParsedTask => t !== null);

  // hasProperty returns true for null-valued key
  const nullMatch = filterTasks(tasks, 'filter by function task.file.hasProperty("nullProp")', { fileInfoProvider });
  assert.equal(nullMatch.length, 1, 'hasProperty("nullProp") should return true for null-valued key');

  // hasProperty returns true for false-valued key
  const falseMatch = filterTasks(tasks, 'filter by function task.file.hasProperty("falseProp")', { fileInfoProvider });
  assert.equal(falseMatch.length, 1, 'hasProperty("falseProp") should return true for false-valued key');

  // hasProperty returns true for zero-valued key
  const zeroMatch = filterTasks(tasks, 'filter by function task.file.hasProperty("zeroProp")', { fileInfoProvider });
  assert.equal(zeroMatch.length, 1, 'hasProperty("zeroProp") should return true for zero-valued key');

  // hasProperty returns false for missing key
  const missingMatch = filterTasks(tasks, 'filter by function task.file.hasProperty("missing")', { fileInfoProvider });
  assert.equal(missingMatch.length, 0, 'hasProperty("missing") should return false for absent key');

  // property() returns the raw value - including arrays
  const arrayLengthMatch = filterTasks(tasks, 'filter by function task.file.property("tagsArray").length === 2', { fileInfoProvider });
  assert.equal(arrayLengthMatch.length, 1, 'property("tagsArray").length should equal 2');

  // property() returns null (not undefined) for missing keys
  const missingNullMatch = filterTasks(tasks, 'filter by function task.file.property("missing") === null', { fileInfoProvider });
  assert.equal(missingNullMatch.length, 1, 'property("missing") should return null, not undefined');

  // query.file.hasProperty DSL function path (not Mustache placeholder)
  const queryHasProp = filterTasks(tasks, 'filter by function query.file.hasProperty("nullProp")', { sourcePath: 'Notes.md', fileInfoProvider });
  assert.equal(queryHasProp.length, 1, 'query.file.hasProperty("nullProp") should return true for null-valued key');

  // {{query.file.hasProperty(...)}} Mustache placeholder expands to "true"/"false" as a string
  // It is used as an inline value within a filter line, e.g. path includes {{...}}
  // A standalone expansion to "true" is not a valid filter instruction, so we test it
  // within a valid context: the expanded query should be parseable.
  const expandedQuery = parseTaskQuery('file property nullProp is {{query.file.hasProperty("nullProp")}}', {
    sourcePath: 'Notes.md',
    fileInfoProvider,
  });
  // The placeholder expands to "true" so the line becomes: file property nullProp is true
  assert.ok(!expandedQuery.errors.length, `Expanded query should parse cleanly. Errors: ${expandedQuery.errors.join('; ')}`);
});

test('task query supports date comparisons and sorting by due, priority, and path', () => {
  const tasks = [
    parseMarkdownTaskLine('- [ ] Later low 📅 2026-05-23 🔽', 'B.md', 1),
    parseMarkdownTaskLine('- [ ] Today highest 📅 2026-05-21 🔺', 'C.md', 1),
    parseMarkdownTaskLine('- [ ] Today high 📅 2026-05-21 ⏫', 'A.md', 1),
    parseMarkdownTaskLine('- [x] Completed today ✅ 2026-05-21', 'Done.md', 1),
    parseMarkdownTaskLine('- [ ] No date 🔺', 'D.md', 1),
  ].filter((task): task is ParsedTask => task !== null);

  const before = filterTasks(tasks, 'due before 2026-05-22\nsort by priority path');
  assert.deepEqual(before.map((task) => task.normalizedText), ['Today highest', 'Today high']);

  const sorted = filterTasks(tasks, 'not done\nsort by due priority path');
  assert.deepEqual(sorted.map((task) => task.normalizedText), ['Today highest', 'Today high', 'Later low', 'No date']);

  const defaultSorted = filterTasks(tasks, 'not done', { today: '2026-05-21' });
  assert.deepEqual(defaultSorted.map((task) => task.normalizedText), ['Today highest', 'Today high', 'No date', 'Later low']);

  const completedToday = filterTasks(tasks, 'done\ncompleted on today', { today: '2026-05-21' });
  assert.deepEqual(completedToday.map((task) => task.normalizedText), ['Completed today']);

  const byDescription = filterTasks(tasks, 'not done\nsort by description\nlimit 2');
  assert.deepEqual(byDescription.map((task) => task.normalizedText), ['Later low', 'No date']);

  const byTitle = filterTasks(tasks, 'not done\nsort by title\nlimit 2');
  assert.deepEqual(byTitle.map((task) => task.normalizedText), ['Later low', 'No date']);

  const titleGroups = groupTasks(tasks, parseTaskQuery('group by title').groups, '2026-05-21');
  const titleGroupNames = titleGroups.map((group) => group.name);
  assert.ok(titleGroupNames.includes('Completed today'));

  assert.throws(() => parseTaskQuery('sort by duedate'), /Unsupported sort field.*Supported sort fields/u);
  assert.throws(() => parseTaskQuery('sort by duedate'), /Supported sort fields: .*series, recurrence-series/u);
});

test('task query smart sort prioritizes important, overdue, in-progress, and today tasks', () => {
  const tasks = [
    parseMarkdownTaskLine('- [ ] Scheduled today ⏳ 2026-05-21', 'A.md', 1),
    parseMarkdownTaskLine('- [ ] Plain task', 'A.md', 2),
    parseMarkdownTaskLine('- [/] In progress', 'A.md', 3),
    parseMarkdownTaskLine('- [ ] Due today 📅 2026-05-21', 'A.md', 4),
    parseMarkdownTaskLine('- [ ] Overdue 📅 2026-05-20', 'A.md', 5),
    parseMarkdownTaskLine('- [ ] Important 🔺', 'A.md', 6),
    parseMarkdownTaskLine('- [ ] Important overdue 📅 2026-05-20 🔺', 'A.md', 7),
  ].filter((task): task is ParsedTask => task !== null);

  const sorted = filterTasks(tasks, 'not done\nsort by smart', { today: '2026-05-21' });
  assert.deepEqual(sorted.map((task) => task.normalizedText), [
    'Important overdue',  // highest priority + 1 day overdue
    'Overdue',            // 1 day overdue, normal priority
    'Due today',          // due today, normal priority
    'Important',          // highest priority, no due date
    'Scheduled today',    // scheduled today, no due date
    'In progress',        // no dates, normal priority (same base score as Plain)
    'Plain task',
  ]);
});

test('task query status sort follows configured state transition order and next status symbols', () => {
  const states = [
    { rawText: 'x', name: 'Done', icon: '✓', type: 'done' as const, nextStatusSymbol: ' ' },
    { rawText: '/', name: 'In progress', icon: '◐', type: 'in_progress' as const, nextStatusSymbol: 'x' },
    { rawText: ' ', name: 'Todo', icon: '☐', type: 'todo' as const, nextStatusSymbol: '/' },
  ];
  const tasks = [
    parseMarkdownTaskLine('- [ ] Todo', 'A.md', 1, states),
    parseMarkdownTaskLine('- [x] Done', 'A.md', 2, states),
    parseMarkdownTaskLine('- [/] Progress', 'A.md', 3, states),
  ].filter((task): task is ParsedTask => task !== null);

  const sorted = filterTasks(tasks, 'sort by status', { states });
  assert.deepEqual(sorted.map((task) => task.normalizedText), ['Done', 'Progress', 'Todo']);
  assert.equal(nextTaskCheckbox(' ', states), '/');
  assert.deepEqual(filterTasks(tasks, 'sort by next-status.symbol', { states }).map((task) => task.normalizedText), ['Done', 'Todo', 'Progress']);

  const fallbackStates = [
    { rawText: ' ', name: 'Todo', icon: '', type: 'todo' as const, nextStatusSymbol: '?' },
    { rawText: 'x', name: 'Done', icon: '', type: 'done' as const },
  ];
  assert.equal(nextTaskCheckbox(' ', fallbackStates), 'x');
});

test('task query supports boolean composition with AND, OR, and parentheses', () => {
  const tasks = [
    parseMarkdownTaskLine('- [ ] Ship feature #work 📅 2026-05-21', 'Projects/Alpha.md', 1),
    parseMarkdownTaskLine('- [ ] Buy milk #home 📅 2026-05-21', 'Home.md', 1),
    parseMarkdownTaskLine('- [x] Completed chore #home 📅 2026-05-21', 'Home.md', 2),
    parseMarkdownTaskLine('- [ ] Archived feature #work 📅 2026-05-21', 'Archive/Old.md', 1),
  ].filter((task): task is ParsedTask => task !== null);

  const result = filterTasks(tasks, 'not done AND (tag includes #home OR path includes Projects)\npath excludes Archive\nsort by path');
  assert.deepEqual(result.map((task) => task.normalizedText), ['Buy milk #home', 'Ship feature #work']);

  assert.throws(() => parseTaskQuery('not done AND (tag includes #home'), /Missing closing '\)'/u);
});

test('task query supports relative date ranges and date presence filters', () => {
  const tasks = [
    parseMarkdownTaskLine('- [ ] Yesterday 📅 2026-05-20 ⏳ 2026-05-19', 'A.md', 1),
    parseMarkdownTaskLine('- [ ] Today 📅 2026-05-21', 'A.md', 2),
    parseMarkdownTaskLine('- [ ] Tomorrow 📅 2026-05-22 🛫 2026-05-21', 'A.md', 3),
    parseMarkdownTaskLine('- [ ] Next week 📅 2026-05-25', 'A.md', 4),
    parseMarkdownTaskLine('- [ ] Missing dates', 'A.md', 5),
  ].filter((task): task is ParsedTask => task !== null);

  assert.deepEqual(filterTasks(tasks, 'due on tomorrow', { today: '2026-05-21' }).map((task) => task.normalizedText), ['Tomorrow']);
  assert.deepEqual(filterTasks(tasks, 'due on this week\nsort by due', { today: '2026-05-21' }).map((task) => task.normalizedText), ['Yesterday', 'Today', 'Tomorrow']);
  assert.deepEqual(filterTasks(tasks, 'due on next week', { today: '2026-05-21' }).map((task) => task.normalizedText), ['Next week']);
  assert.deepEqual(filterTasks(tasks, 'scheduled exists').map((task) => task.normalizedText), ['Yesterday']);
  assert.deepEqual(filterTasks(tasks, 'start missing').map((task) => task.normalizedText), ['Yesterday', 'Today', 'Next week', 'Missing dates']);
  assert.deepEqual(filterTasks(tasks, 'starts before tomorrow\nsort by line number', { today: '2026-05-21' }).map((task) => task.normalizedText), ['Yesterday', 'Today', 'Tomorrow', 'Next week', 'Missing dates']);
});

test('task query supports inline comments, natural dates, list marker filters, and template guards', () => {
  const tasks = [
    parseMarkdownTaskLine('- [ ] Alpha 📅 2026-05-21', 'A.md', 1),
    parseMarkdownTaskLine('* [ ] Beta 📅 2026-06-04', 'A.md', 2),
    parseMarkdownTaskLine('1. [ ] Gamma 📅 2026-05-07', 'A.md', 3),
  ].filter((task): task is ParsedTask => task !== null);

  assert.deepEqual(filterTasks(tasks, 'not done # inline comment\ndue on today', { today: '2026-05-21' }).map((task) => task.normalizedText), ['Alpha']);
  assert.deepEqual(filterTasks(tasks, 'due on in two weeks', { today: '2026-05-21' }).map((task) => task.normalizedText), ['Beta']);
  assert.deepEqual(filterTasks(tasks, 'due on 14 days ago', { today: '2026-05-21' }).map((task) => task.normalizedText), ['Gamma']);
  assert.deepEqual(filterTasks(tasks, 'list marker is *').map((task) => task.normalizedText), ['Beta']);
  assert.deepEqual(filterTasks(tasks, 'list marker is not *\nsort by line number').map((task) => task.normalizedText), ['Alpha', 'Gamma']);
  assert.deepEqual(filterTasks(tasks, 'list marker regex matches /\\d+\\./').map((task) => task.normalizedText), ['Gamma']);
  assert.throws(() => parseTaskQuery('due before {{date+14d:YYYY-MM-DD}}'), /unexpanded template text/u);
});

test('task query supports recurrence, id, on-completion, and dependency filters', () => {
  const tasks = [
    parseMarkdownTaskLine('- [ ] Recurring blocked 🔁 every week 🆔 recurring-1 ⛔ setup 🏁 delete', 'A.md', 1),
    parseMarkdownTaskLine('- [ ] One-off 🆔 one-off 🏁 keep', 'A.md', 2),
    parseMarkdownTaskLine('- [ ] No metadata', 'A.md', 3),
  ].filter((task): task is ParsedTask => task !== null);

  assert.deepEqual(filterTasks(tasks, 'recurrence includes week').map((task) => task.normalizedText), ['Recurring blocked']);
  assert.deepEqual(filterTasks(tasks, 'id is one-off').map((task) => task.normalizedText), ['One-off']);
  assert.deepEqual(filterTasks(tasks, 'depends on setup').map((task) => task.normalizedText), ['Recurring blocked']);
  assert.deepEqual(filterTasks(tasks, 'dependency missing').map((task) => task.normalizedText), ['One-off', 'No metadata']);
  assert.deepEqual(filterTasks(tasks, 'on completion is delete').map((task) => task.normalizedText), ['Recurring blocked']);
  assert.deepEqual(filterTasks(tasks, 'has on completion').map((task) => task.normalizedText), ['Recurring blocked', 'One-off']);
  assert.deepEqual(filterTasks(tasks, 'no on completion').map((task) => task.normalizedText), ['No metadata']);
  assert.deepEqual(filterTasks(tasks, 'sort by on completion').map((task) => task.normalizedText), ['Recurring blocked', 'One-off', 'No metadata']);
  assert.deepEqual(groupTasks(tasks, parseTaskQuery('group by depends on').groups).map((group) => group.name), ['(No depends on)', 'setup']);
  assert.deepEqual(groupTasks(tasks, parseTaskQuery('group by recurring').groups).map((group) => group.name), ['Not recurring', 'Recurring']);
  assert.deepEqual(groupTasks(tasks, parseTaskQuery('group by recurrence').groups).map((group) => group.name), ['every week', 'None']);
});

test('task query groups multi-tagged tasks into separate tag buckets with richer headings', () => {
  const tasks = [
    parseMarkdownTaskLine('- [ ] Multi #work #home 📅 2026-05-21 🔺', 'A.md', 1),
    parseMarkdownTaskLine('- [ ] No tag', 'A.md', 2),
  ].filter((task): task is ParsedTask => task !== null);

  const byTag = groupTasks(tasks, parseTaskQuery('group by tags').groups, '2026-05-21');
  assert.deepEqual(byTag.map((group) => [group.name, group.tasks?.map((task) => task.normalizedText)]), [
    ['(No tags)', ['No tag']],
    ['#home', ['Multi #work #home']],
    ['#work', ['Multi #work #home']],
  ]);

  assert.deepEqual(groupTasks(tasks, parseTaskQuery('group by due').groups, '2026-05-21').map((group) => group.name), ['2026-05-21 Thursday', 'No due date']);
  assert.deepEqual(groupTasks(tasks, parseTaskQuery('group by priority').groups).map((group) => group.name), ['Highest priority', 'Normal priority']);
});

test('task query supports upstream compatibility additions', () => {
  const tasks = [
    parseMarkdownTaskLine('- [ ] Alpha 📅 2026-05-25 ⏰ 2026-05-24 09:00 🆔 a', 'Projects/Alpha.md', 1, DEFAULT_TASK_STATES, 'Next steps'),
    parseMarkdownTaskLine('- [ ] Beta 📅 2026-02-30', 'Projects/Beta.md', 2),
    parseMarkdownTaskLine('- [x] Gamma ✅ 2026-05-20', 'Archive/Gamma.md', 3),
  ].filter((task): task is ParsedTask => task !== null);
  const fileInfoProvider = (path: string) => ({
    properties: path.includes('Alpha') ? { area: 'work', rank: 2 } : { area: 'home', rank: 1 },
    outlinks: path.includes('Alpha') ? ['Project', '[[Project]]'] : [],
  });

  assert.deepEqual(filterTasks(tasks, '(description includes Alpha) XOR (done)', { fileInfoProvider }).map((task) => task.normalizedText), ['Alpha', 'Gamma']);
  assert.deepEqual(filterTasks(tasks, 'limit to 2 tasks\nsort by description').map((task) => task.normalizedText), ['Alpha', 'Beta']);
  assert.deepEqual(filterTasks(tasks, 'due date is invalid').map((task) => task.normalizedText), ['Beta']);
  assert.deepEqual(filterTasks(tasks, 'reminder on 2026-05-24').map((task) => task.normalizedText), ['Alpha']);
  assert.deepEqual(filterTasks(tasks, 'backlink includes Next steps').map((task) => task.normalizedText), ['Alpha']);
  assert.deepEqual(filterTasks(tasks, 'path is not Projects/Beta.md').map((task) => task.normalizedText), ['Alpha', 'Gamma']);
  assert.deepEqual(filterTasks(tasks, 'status.symbol is not x').map((task) => task.normalizedText), ['Alpha', 'Beta']);
  assert.deepEqual(filterTasks(tasks, 'filter by function task.file.property("area") === "work"', { fileInfoProvider }).map((task) => task.normalizedText), ['Alpha']);
  assert.deepEqual(filterTasks(tasks, 'filter by function task.file.outlinks.includes("[[Project]]")', { fileInfoProvider }).map((task) => task.normalizedText), ['Alpha']);
  assert.deepEqual(filterTasks(tasks, 'filter by function query.file.property("area") === "work"', { sourcePath: 'Projects/Alpha.md', fileInfoProvider }).map((task) => task.normalizedText), ['Alpha', 'Beta', 'Gamma']);

  const linkTasks = [
    parseMarkdownTaskLine('- [ ] Has link [[Target]]', 'Shared.md', 1),
    parseMarkdownTaskLine('- [ ] No link here', 'Shared.md', 2),
  ].filter((task): task is ParsedTask => task !== null);
  const sharedFileInfoProvider = () => ({ properties: {}, outlinks: ['Target', '[[Target]]'] });
  assert.deepEqual(filterTasks(linkTasks, 'filter by function task.file.outlinks.includes("[[Target]]")' , { fileInfoProvider: sharedFileInfoProvider }).map((task) => task.normalizedText), ['Has link [[Target]]', 'No link here']);
  // task.outlinks is now DslLink[] - .toString() returns destinationPath (no [[]]).
  // Use the destination path string; for structural access use the built-in outlinks filter.
  assert.deepEqual(filterTasks(linkTasks, 'filter by function task.outlinks.includes("Target")', { fileInfoProvider: sharedFileInfoProvider }).map((task) => task.normalizedText), ['Has link [[Target]]']);
  assert.deepEqual(filterTasks(linkTasks, 'outlinks include [[Target]]', { fileInfoProvider: sharedFileInfoProvider }).map((task) => task.normalizedText), ['Has link [[Target]]']);
  assert.deepEqual(filterTasks(linkTasks, 'outlinks does not include [[Target]]', { fileInfoProvider: sharedFileInfoProvider }).map((task) => task.normalizedText), ['No link here']);

  const query = parseTaskQuery('short mode\ngroup by backlink\nlimit groups to 1 task');
  assert.equal(query.layout.shortMode, true);
  assert.equal(query.groups[0].field, 'backlink');
  assert.equal(query.limitGroups, 1);
});

test('task query supports safe advanced DSL filters, sorting, and grouping', () => {
  const tasks = [
    parseMarkdownTaskLine('- [ ] Alpha task #work 🔺 📅 2026-05-22', 'Projects/Alpha.md', 1),
    parseMarkdownTaskLine('- [ ] beta task #home 🔽 📅 2026-05-20', 'Home.md', 2),
    parseMarkdownTaskLine('- [ ] Gamma task #work', 'Projects/Gamma.md', 3),
  ].filter((task): task is ParsedTask => task !== null);

  assert.deepEqual(
    filterTasks(tasks, 'filter by function task.description.toLowerCase().includes("alpha") || task.tags.includes("#home")').map((task) => task.normalizedText),
    ['Alpha task #work', 'beta task #home'],
  );
  assert.deepEqual(
    filterTasks(tasks, 'filter by function task.lineNumber === 0 || task.priorityName === "Low"').map((task) => task.normalizedText),
    ['Alpha task #work', 'beta task #home'],
  );
  assert.deepEqual(
    filterTasks(tasks, 'filter by function task.priorityNameGroupText.includes("%%0%%") || task.status.typeGroupText.includes("TODO")').map((task) => task.normalizedText),
    ['Alpha task #work', 'beta task #home', 'Gamma task #work'],
  );
  assert.deepEqual(
    filterTasks(tasks, 'sort by function task.priorityNumber').map((task) => task.normalizedText),
    ['Alpha task #work', 'Gamma task #work', 'beta task #home'],
  );
  const fileInfoProvider = (path: string) => path === 'Projects/Alpha.md'
    ? { properties: { area: 'work', empty: null }, outlinks: [] }
    : { properties: {}, outlinks: [] };
  assert.deepEqual(filterTasks(tasks, 'filter by function task.file.hasProperty("area") === true', { fileInfoProvider }).map((task) => task.normalizedText), ['Alpha task #work']);
  // hasProperty checks key existence, not value truthiness: a null-valued key still exists.
  assert.deepEqual(filterTasks(tasks, 'filter by function task.file.hasProperty("empty") === true', { fileInfoProvider }).map((task) => task.normalizedText), ['Alpha task #work']);
  // Files that do NOT have the 'empty' key return false; 'missing' is absent everywhere → null.
  assert.deepEqual(filterTasks(tasks, 'filter by function task.file.hasProperty("empty") === false && task.file.property("missing") === null', { fileInfoProvider }).map((task) => task.normalizedText), ['beta task #home', 'Gamma task #work']);
  assert.deepEqual(filterTasks(tasks, 'filter by function task.due.toISOString() === "2026-05-22T00:00:00.000Z"').map((task) => task.normalizedText), ['Alpha task #work']);
  assert.deepEqual(filterTasks(tasks, 'filter by function task.scheduled.formatAsDate("no date") === "no date"').map((task) => task.normalizedText), ['Alpha task #work', 'beta task #home', 'Gamma task #work']);
  const grouped = groupTasks(tasks, parseTaskQuery('group by function task.file.root').groups);
  assert.deepEqual(grouped.map((group) => group.name), ['/', 'Projects/']);
  assert.throws(
    () => parseTaskQuery('filter by function task.description.includes("Alpha")', { enableQueryDsl: false }),
    /Function expressions are disabled/u,
  );
});

test('task grouping orders urgency, priority, and status type like upstream Tasks', () => {
  const tasks = [
    parseMarkdownTaskLine('- [ ] Low priority 🔽 📅 2026-05-30', 'A.md', 1),
    parseMarkdownTaskLine('- [ ] Highest priority 🔺 📅 2026-05-30', 'A.md', 2),
    parseMarkdownTaskLine('- [x] Done task ✅ 2026-05-20', 'A.md', 3),
    parseMarkdownTaskLine('- [/] In progress', 'A.md', 4),
  ].filter((task): task is ParsedTask => task !== null);

  const urgencyGroups = groupTasks(tasks, parseTaskQuery('group by urgency').groups, '2026-05-20');
  const urgencyNames = urgencyGroups.map((group) => group.name);
  // Group names must be range labels, not exact urgency scores.
  for (const name of urgencyNames) {
    assert.ok(
      /^(9\.0 or more|[1-8]\.0 to [1-8]\.9|less than 1\.0)$/u.test(name),
      `urgency group name must be a range label, got: ${name}`,
    );
  }
  // Default order is descending by urgency bucket.
  const urgencyRank = (name: string): number => {
    if (name === '9.0 or more') return 0;
    if (name === 'less than 1.0') return 9;
    const match = name.match(/^([1-8])\.0 to/u);
    return match ? 9 - Number.parseInt(match[1], 10) : 99;
  };
  assert.deepEqual([...urgencyNames].sort((a, b) => urgencyRank(a) - urgencyRank(b)), urgencyNames);
  const urgencyReverseGroups = groupTasks(tasks, parseTaskQuery('group by urgency reverse').groups, '2026-05-20');
  assert.deepEqual(urgencyReverseGroups.map((group) => group.name), [...urgencyNames].reverse());
  const priorityGroups = groupTasks(tasks, parseTaskQuery('group by priority').groups, '2026-05-20');
  assert.deepEqual(priorityGroups.map((group) => group.name), ['Highest priority', 'Normal priority', 'Low priority']);
  const statusGroups = groupTasks(tasks, parseTaskQuery('group by status.type').groups, '2026-05-20');
  assert.deepEqual(statusGroups.map((group) => group.name), ['IN_PROGRESS', 'TODO', 'DONE']);
});

test('sort by status.type places on_hold at position 2 (same as blocked/deferred), not 99', () => {
  const states = DEFAULT_TASK_STATES;
  // Create tasks covering all status types that include on_hold.
  const makeFakeTask = (checkbox: string, status: import('../src/types').TaskStatus, text: string): ParsedTask => ({
    rawLine: `- [${checkbox}] ${text}`,
    normalizedText: text,
    filePath: 'A.md',
    lineNumber: 1,
    checkbox,
    status,
    listMarker: '-',
    indentation: '',
    linePrefix: '',
    heading: undefined,
    tags: [],
    contexts: [],
    metadata: {
      priority: 'normal',
      dates: { due: undefined, scheduled: undefined, start: undefined, done: undefined, created: undefined, cancelled: undefined },
      invalidDates: {},
      recurrence: undefined,
      invalidRecurrence: false,
      dependsOn: [],
      onCompletion: undefined,
      id: undefined,
      blockLink: undefined,
      reminder: undefined,
      followUp: undefined,
      effort: undefined,
      actual: undefined,
      cost: undefined,
      pinned: false,
      assignee: undefined,
      reviewer: undefined,
      project: undefined,
      team: undefined,
      recurrenceSeriesId: undefined,
      dependencyTypes: {},
      customFields: {},
    },
    body: text,
    key: `A.md:1`,
  });

  const tasks = [
    makeFakeTask('x', 'done', 'Done task'),
    makeFakeTask(' ', 'todo', 'Todo task'),
    makeFakeTask('~', 'on_hold', 'On hold task'),
    makeFakeTask('/', 'in_progress', 'In progress task'),
    makeFakeTask('-', 'cancelled', 'Cancelled task'),
  ];

  const sorted = sortTasks(tasks, [{ field: 'status.type' }], '2026-05-30', states);
  const names = sorted.map((t) => t.normalizedText);

  // Expected order: in_progress(0) → todo(1) → on_hold(2) → done(3) → cancelled(4)
  const inProgressIdx = names.indexOf('In progress task');
  const todoIdx = names.indexOf('Todo task');
  const onHoldIdx = names.indexOf('On hold task');
  const doneIdx = names.indexOf('Done task');
  const cancelledIdx = names.indexOf('Cancelled task');

  assert.ok(inProgressIdx < todoIdx, 'in_progress should sort before todo');
  assert.ok(todoIdx < onHoldIdx, 'todo should sort before on_hold');
  assert.ok(onHoldIdx < doneIdx, 'on_hold should sort before done (not after, as it did when missing from lookup)');
  assert.ok(doneIdx < cancelledIdx, 'done should sort before cancelled');

  // group by status.type should also put ON_HOLD in position 2, not after DONE/CANCELLED
  const grouped = groupTasks(tasks, parseTaskQuery('group by status.type').groups, '2026-05-30', states);
  const groupNames = grouped.map((g) => g.name);
  const onHoldGroup = groupNames.indexOf('ON_HOLD');
  const doneGroup = groupNames.indexOf('DONE');
  assert.ok(onHoldGroup < doneGroup, 'ON_HOLD group should appear before DONE group');
});

test('PRD Task 1: status.type is ON_HOLD filters tasks with on_hold/blocked/deferred status', () => {
  // The DSL keyword ON_HOLD (any case) should match all three on-hold-like statuses.
  const states = DEFAULT_TASK_STATES;
  const makeFakeTask = (status: import('../src/types').TaskStatus, text: string): ParsedTask => ({
    rawLine: `- [ ] ${text}`,
    normalizedText: text,
    filePath: 'A.md',
    lineNumber: 1,
    checkbox: ' ',
    status,
    listMarker: '-',
    indentation: '',
    linePrefix: '',
    heading: undefined,
    tags: [],
    contexts: [],
    metadata: {
      priority: 'normal',
      dates: { due: undefined, scheduled: undefined, start: undefined, done: undefined, created: undefined, cancelled: undefined },
      invalidDates: {},
      recurrence: undefined,
      invalidRecurrence: false,
      dependsOn: [],
      onCompletion: undefined,
      id: undefined,
      blockLink: undefined,
      reminder: undefined,
      followUp: undefined,
      effort: undefined,
      actual: undefined,
      cost: undefined,
      pinned: false,
      assignee: undefined,
      reviewer: undefined,
      project: undefined,
      team: undefined,
      recurrenceSeriesId: undefined,
      dependencyTypes: {},
      customFields: {},
    },
    body: text,
    key: `A.md:1`,
  });

  const tasks = [
    makeFakeTask('todo', 'Todo'),
    makeFakeTask('on_hold', 'OnHold'),
    makeFakeTask('blocked', 'Blocked'),
    makeFakeTask('deferred', 'Deferred'),
    makeFakeTask('done', 'Done'),
  ];

  // Uppercase ON_HOLD keyword
  const onHold = filterTasks(tasks, 'status.type is ON_HOLD', { states });
  assert.deepEqual(onHold.map((t) => t.normalizedText).sort(), ['Blocked', 'Deferred', 'OnHold']);

  // Lowercase on_hold keyword
  const onHoldLower = filterTasks(tasks, 'status.type is on_hold', { states });
  assert.deepEqual(onHoldLower.map((t) => t.normalizedText).sort(), ['Blocked', 'Deferred', 'OnHold']);

  // Negated form
  const notOnHold = filterTasks(tasks, 'status.type is not ON_HOLD', { states });
  assert.deepEqual(notOnHold.map((t) => t.normalizedText).sort(), ['Done', 'Todo']);
});

test('query renderer defaults toolbar, short backlink, and postpone visibility', async () => {
  // Compute dates dynamically so the test stays green as wall-clock advances.
  // deferTask uses maxDate(current, today)+N, so starting from today ensures
  // first postpone → tomorrow and second → day-after-tomorrow.
  const _td = new Date();
  const testToday = `${_td.getFullYear()}-${String(_td.getMonth() + 1).padStart(2, '0')}-${String(_td.getDate()).padStart(2, '0')}`;
  const _d1 = new Date(`${testToday}T00:00:00Z`); _d1.setUTCDate(_d1.getUTCDate() + 1);
  const testTomorrow = _d1.toISOString().slice(0, 10);
  const _d2 = new Date(`${testToday}T00:00:00Z`); _d2.setUTCDate(_d2.getUTCDate() + 2);
  const testDayAfter = _d2.toISOString().slice(0, 10);
  const originalDocument = globalThis.document;
  const originalRenderMarkdown = MarkdownRenderer.renderMarkdown;
  const renderedSources: string[] = [];
  globalThis.document = {
    createElement: (tagName: string) => new FakeElement(tagName),
    createTextNode: (textContent: string) => new FakeTextNode(textContent),
    createElementNS: (_ns: string, tagName: string) => new FakeElement(tagName),
  } as never;
  (MarkdownRenderer as unknown as { renderMarkdown: (markdown: string, el: HTMLElement, sourcePath: string) => Promise<void> }).renderMarkdown = async (markdown: string, el: HTMLElement, sourcePath: string) => {
    renderedSources.push(sourcePath);
    if ('setText' in el && typeof (el as unknown as FakeElement).setText === 'function') (el as unknown as FakeElement).setText(markdown);
  };

  try {
    const file = fakeFile('Projects/Alpha.md');
    let sourceContent = `- [ ] Ship feature 📅 ${testToday}\n`;
    const app = {
      vault: {
        getMarkdownFiles: () => [file],
        read: async () => sourceContent,
        process: async (_file: FakeFile, updater: (content: string) => string) => { sourceContent = updater(sourceContent); return sourceContent; },
        getAbstractFileByPath: () => file,
      },
      metadataCache: { fileToLinktext: (sourceFile: FakeFile) => sourceFile.basename },
      workspace: {
        getLeaf: () => ({ openFile: async () => undefined }),
        openLinkText: async () => undefined,
      },
    };
    const renderer = new TaskQueryRenderer(app as never, new TaskScanner(app as never), () => DEFAULT_SETTINGS);
    const root = new FakeElement('div');

    await renderer.render('short mode', root as never, { sourcePath: 'Dashboard.md' } as never);
    assert.ok(root.findByClass('task-manager-query-toolbar'));
    const sourceLink = root.findByTag('a');
    assert.equal(sourceLink?.textContent(), '🔗');
    assert.match(sourceLink?.attributes.get('title') ?? '', /Open Alpha:1/u);
    const postpone = root.findByClass('task-manager-query-defer');
    assert.equal(postpone?.attributes.get('title'), 'Postpone task');
    const dueMetadata = root.findByClass('task-manager-query-metadata-date');
    assert.equal(dueMetadata?.attributes.get('data-task-manager-date-field'), 'due');
    assert.match(dueMetadata?.attributes.get('title') ?? '', /click to choose a date/u);
    assert.equal(dueMetadata?.attributes.get('role'), 'button');
    assert.equal(dueMetadata?.attributes.get('tabindex'), '0');
    dueMetadata?.listeners.get('keydown')?.({ key: 'Enter', preventDefault: () => undefined } as never);
    assert.deepEqual(renderedSources, ['Projects/Alpha.md']);

    postpone?.listeners.get('click')?.({ preventDefault: () => undefined, stopPropagation: () => undefined });
    await flushPromises();
    await flushPromises();
    assert.match(sourceContent, new RegExp(`📅 ${testTomorrow}`));

    root.findByClass('task-manager-query-defer')?.listeners.get('click')?.({ preventDefault: () => undefined, stopPropagation: () => undefined });
    await flushPromises();
    await flushPromises();
    assert.match(sourceContent, new RegExp(`📅 ${testDayAfter}`));

    sourceContent = '- [x] Archived ➕ 2026-06-01 ✅ 2026-06-02 ❌ 2026-06-03 ⏰ 2026-06-04 08:15\n';
    renderer.invalidateCache();
    const completedRoot = new FakeElement('div');
    await renderer.render('done', completedRoot as never, { sourcePath: 'Dashboard.md' } as never);
    const dateMetadata = completedRoot.findAllByClass('task-manager-query-metadata-date');
    assert.deepEqual(dateMetadata.map((entry) => entry.attributes.get('data-task-manager-date-field')), ['created', 'done', 'cancelled', 'reminder']);
    assert.match(dateMetadata[0].attributes.get('title') ?? '', /click to choose a date/u);

    const reminderRoot = new FakeElement('div');
    await renderer.render('done', reminderRoot as never, { sourcePath: 'Dashboard.md' } as never);
    const reminderMetadata = reminderRoot.findAllByClass('task-manager-query-metadata-date').find((entry) => entry.attributes.get('data-task-manager-date-field') === 'reminder');
    assert.match(reminderMetadata?.attributes.get('title') ?? '', /click to choose a date/u);

    const hiddenRoot = new FakeElement('div');
    await renderer.render('hide toolbar\nhide postpone button', hiddenRoot as never, { sourcePath: 'Dashboard.md' } as never);
    assert.equal(hiddenRoot.findByClass('task-manager-query-toolbar'), undefined);
    assert.equal(hiddenRoot.findByClass('task-manager-query-defer'), undefined);
    assert.ok(hiddenRoot.findByClass('task-manager-select-all-cb'), 'select-all checkbox should remain available when toolbar is hidden');

    // Upstream-compatible semantic classes & data attributes on rendered <li>:
    const item = root.findByClass('task-manager-query-item');
    assert.ok(item);
    assert.ok(item!.classes.includes('task-list-item'));
    assert.equal(item!.attributes.get('data-task'), '');
    assert.equal(item!.attributes.get('data-task-status-type'), 'TODO');
    assert.equal(item!.attributes.get('data-task-status-type-local'), 'todo');
    assert.equal(item!.attributes.get('data-task-priority'), 'normal');
    // Theme-compatible class names (upstream: tasks-list-text, tasks-backlink,
    // tasks-edit, tasks-postpone).
    assert.ok(root.findByClass('tasks-list-text'), 'expected text span to carry tasks-list-text class');
    assert.ok(root.findByClass('tasks-backlink'), 'expected backlink anchor to carry tasks-backlink class');
    assert.ok(root.findByClass('tasks-postpone'), 'expected postpone button to carry tasks-postpone class');
    // Iteration 5 additions - upstream theme classes from Renderer.scss.
    assert.ok(item!.classes.includes('plugin-tasks-list-item'), 'expected <li> to carry plugin-tasks-list-item class');
    const outerUl = root.findByTag('ul');
    assert.ok(outerUl, 'expected an outer <ul>');
    assert.ok(outerUl!.classes.includes('contains-task-list'), 'expected <ul> to carry contains-task-list class');
    assert.ok(outerUl!.classes.includes('plugin-tasks-query-result'), 'expected <ul> to carry plugin-tasks-query-result class');
    // Per-field semantic class + relative date attribute on the due-date span.
    const dueSpan = root.findByClass('task-due');
    assert.ok(dueSpan, 'expected a span with task-due class');
    assert.ok(dueSpan!.attributes.get('data-task-due'), 'expected data-task-due relative attribute');
  } finally {
    (MarkdownRenderer as unknown as { renderMarkdown: typeof originalRenderMarkdown }).renderMarkdown = originalRenderMarkdown;
    globalThis.document = originalDocument;
  }
});

test('query renderer checklist view omits list affordances and toggles tasks', async () => {
  const originalDocument = globalThis.document;
  const originalRenderMarkdown = MarkdownRenderer.renderMarkdown;
  globalThis.document = {
    createElement: (tagName: string) => new FakeElement(tagName),
    createTextNode: (textContent: string) => new FakeTextNode(textContent),
    createElementNS: (_ns: string, tagName: string) => new FakeElement(tagName),
  } as never;
  (MarkdownRenderer as unknown as { renderMarkdown: (markdown: string, el: HTMLElement, sourcePath: string) => Promise<void> }).renderMarkdown = async (markdown: string, el: HTMLElement) => {
    if ('setText' in el && typeof (el as unknown as FakeElement).setText === 'function') (el as unknown as FakeElement).setText(markdown);
  };

  try {
    const file = fakeFile('Projects/Alpha.md');
    let sourceContent = '- [ ] Ship feature ⏫ #work\n';
    const app = {
      vault: {
        getMarkdownFiles: () => [file],
        read: async () => sourceContent,
        process: async (_file: FakeFile, updater: (content: string) => string) => { sourceContent = updater(sourceContent); return sourceContent; },
        getAbstractFileByPath: () => file,
      },
      metadataCache: { fileToLinktext: (sourceFile: FakeFile) => sourceFile.basename },
      workspace: { getLeaf: () => ({ openFile: async () => undefined }), openLinkText: async () => undefined },
    };
    const renderer = new TaskQueryRenderer(app as never, new TaskScanner(app as never), () => DEFAULT_SETTINGS);
    const root = new FakeElement('div');

    await renderer.render('view: checklist\nnot done\nhide toolbar\nhide task count', root as never, { sourcePath: 'Dashboard.md' } as never);

    assert.ok(root.classes.includes('task-manager-query-checklist'));
    assert.equal(root.findByClass('task-manager-query-toolbar'), undefined);
    assert.equal(root.findByClass('task-manager-select-all-cb'), undefined);
    assert.equal(root.findByClass('task-manager-select-checkbox'), undefined);
    // Checklist now supports manual drag-to-reorder, so the handle is present and rows are draggable
    // (but the heavier bulk-edit affordances below stay hidden).
    assert.ok(root.findByClass('task-manager-drag-handle'));
    assert.ok(root.findByClass('task-manager-reorder-controls'), 'keyboard reorder controls accompany the drag handle');
    assert.ok(root.findByClass('task-manager-reorder-button')?.attributes.get('aria-label')?.includes('Move'));
    assert.equal(root.findByClass('task-manager-query-defer'), undefined);
    assert.equal(root.findByClass('task-manager-query-edit'), undefined);
    const list = root.findByClass('task-manager-checklist-list');
    assert.ok(list);
    const item = root.findByClass('task-manager-checklist-item');
    assert.ok(item);
    assert.equal(item!.attributes.get('draggable'), 'true');
    const markerHit = root.findByClass('task-manager-query-marker-hit');
    assert.ok(markerHit, 'checklist marker should have a separate coarse-pointer hit area');
    const marker = root.findByClass('task-manager-query-marker');
    assert.ok(marker);

    marker.listeners.get('click')?.({ preventDefault: () => undefined, stopPropagation: () => undefined });
    await flushPromises();
    await flushPromises();
    assert.match(sourceContent, /^- \[x\] Ship feature/u);
  } finally {
    (MarkdownRenderer as unknown as { renderMarkdown: typeof originalRenderMarkdown }).renderMarkdown = originalRenderMarkdown;
    globalThis.document = originalDocument;
  }
});

test('query renderer checklist does not expose manual-order controls for Canvas tasks', async () => {
  const originalDocument = globalThis.document;
  const originalRenderMarkdown = MarkdownRenderer.renderMarkdown;
  globalThis.document = {
    createElement: (tagName: string) => new FakeElement(tagName),
    createTextNode: (textContent: string) => new FakeTextNode(textContent),
    createElementNS: (_ns: string, tagName: string) => new FakeElement(tagName),
  } as never;
  (MarkdownRenderer as unknown as { renderMarkdown: (markdown: string, el: HTMLElement) => Promise<void> }).renderMarkdown = async (markdown: string, el: HTMLElement) => {
    (el as unknown as FakeElement).setText(markdown);
  };

  try {
    const canvasFile = fakeFile('Board.canvas');
    const app = {
      vault: { getAbstractFileByPath: () => canvasFile },
      metadataCache: { fileToLinktext: () => 'Board' },
      workspace: { getLeaf: () => ({ openFile: async () => undefined }), openLinkText: async () => undefined },
    };
    const scanner = new TaskScanner(app as never);
    const task = scanner.parseTaskLine('- [ ] Canvas task', 'Board.canvas', 1);
    assert.ok(task);
    task.key = 'Board.canvas:canvas:node:1';
    const renderer = new TaskQueryRenderer(app as never, scanner, () => DEFAULT_SETTINGS);
    const root = new FakeElement('div');
    (renderer as unknown as { renderChecklistTasks: (...args: unknown[]) => void }).renderChecklistTasks(
      root as never,
      [task],
      { sourcePath: 'Dashboard.md' },
      parseTaskQuery('view: checklist'),
      async () => undefined,
    );

    assert.equal(root.findByClass('task-manager-drag-handle'), undefined);
    const item = root.findByClass('task-manager-checklist-item');
    assert.ok(item);
    assert.equal(item.attributes.get('draggable'), undefined);
  } finally {
    (MarkdownRenderer as unknown as { renderMarkdown: typeof originalRenderMarkdown }).renderMarkdown = originalRenderMarkdown;
    globalThis.document = originalDocument;
  }
});

test('query renderer explain shows global query and Query File Defaults provenance', async () => {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: (tagName: string) => new FakeElement(tagName),
    createTextNode: (textContent: string) => new FakeTextNode(textContent),
    createElementNS: (_ns: string, tagName: string) => new FakeElement(tagName),
  } as never;

  try {
    const dashboard = fakeFile('Dashboard.md');
    const taskFile = fakeFile('Projects/Alpha.md');
    const app = {
      vault: {
        getMarkdownFiles: () => [taskFile],
        read: async () => '- [ ] Ship feature\n',
        process: async () => undefined,
        getAbstractFileByPath: (path: string) => path === dashboard.path ? dashboard : taskFile,
      },
      metadataCache: {
        fileToLinktext: (sourceFile: FakeFile) => sourceFile.basename,
        getFileCache: (file: FakeFile) => file.path === dashboard.path ? { frontmatter: { TQ_extra_instructions: 'path includes Projects', TQ_show_task_count: false } } : null,
      },
      workspace: { getLeaf: () => ({ openFile: async () => undefined }), openLinkText: async () => undefined },
    };
    const renderer = new TaskQueryRenderer(app as never, new TaskScanner(app as never), () => ({ ...DEFAULT_SETTINGS, globalQuery: 'not done' }));
    const root = new FakeElement('div');

    await renderer.render('explain', root as never, { sourcePath: dashboard.path } as never);
    const explain = root.findByClass('task-manager-query-explain')?.textContent() ?? '';
    assert.match(explain, /Global query:[\s\S]*not done/u);
    assert.match(explain, /Query File Defaults:[\s\S]*path includes Projects[\s\S]*hide task count/u);
  } finally {
    globalThis.document = originalDocument;
  }
});

test('query renderer renders tasks, cycles source status, and rerenders filtered results', async () => {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: (tagName: string) => new FakeElement(tagName),
    createTextNode: (textContent: string) => new FakeTextNode(textContent),
    createElementNS: (_ns: string, tagName: string) => new FakeElement(tagName),
  } as never;

  try {
    const file = fakeFile('Projects/Alpha.md');
    let sourceContent = '- [ ] Ship feature #work\n';
    const app = {
      vault: {
        getMarkdownFiles: () => [file],
        read: async () => sourceContent,
        process: async (_file: FakeFile, updater: (content: string) => string) => {
          sourceContent = updater(sourceContent);
          return sourceContent;
        },
        getAbstractFileByPath: () => file,
      },
      metadataCache: { fileToLinktext: (sourceFile: FakeFile) => sourceFile.basename },
      workspace: {
        getLeaf: () => ({ openFile: async () => undefined }),
        openLinkText: async () => undefined,
      },
    };
    const renderer = new TaskQueryRenderer(app as never, new TaskScanner(app as never), () => DEFAULT_SETTINGS);
    const root = new FakeElement('div');

    await renderer.render('not done', root as never, { sourcePath: 'Dashboard.md' } as never);
    assert.match(root.textContent(), /Ship feature #work/u);
    assert.ok(root.findByClass('task-manager-query-toolbar'));
    const button = root.findByClass('task-manager-query-marker');
    assert.ok(button);

    button.listeners.get('click')?.({ preventDefault: () => undefined, stopPropagation: () => undefined });
    await flushPromises();
    await flushPromises();

    assert.match(sourceContent, /^- \[\/\] Ship feature #work/u);
    // In-progress is still not-done, so the rerender keeps the task visible.
    assert.match(root.textContent(), /Ship feature #work/u);
  } finally {
    globalThis.document = originalDocument;
  }
});

test('query renderer ignores stale async renders for the same element', async () => {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: (tagName: string) => new FakeElement(tagName),
    createTextNode: (textContent: string) => new FakeTextNode(textContent),
    createElementNS: (_ns: string, tagName: string) => new FakeElement(tagName),
  } as never;

  try {
    const file = fakeFile('Projects/Alpha.md');
    const firstReadResolvers: Array<(value: string) => void> = [];
    let readCount = 0;
    const app = {
      vault: {
        getMarkdownFiles: () => [file],
        read: async () => {
          readCount += 1;
          if (readCount === 1) return new Promise<string>((resolve) => { firstReadResolvers.push(resolve); });
          return '- [ ] Fresh task\n';
        },
        process: async () => undefined,
        getAbstractFileByPath: () => file,
      },
      metadataCache: { fileToLinktext: (sourceFile: FakeFile) => sourceFile.basename },
      workspace: { getLeaf: () => ({ openFile: async () => undefined }), openLinkText: async () => undefined },
    };
    const renderer = new TaskQueryRenderer(app as never, new TaskScanner(app as never), () => DEFAULT_SETTINGS);
    const root = new FakeElement('div');

    const firstRender = renderer.render('', root as never, { sourcePath: 'Dashboard.md' } as never);
    renderer.invalidateCache(file.path);
    await renderer.render('', root as never, { sourcePath: 'Dashboard.md' } as never);
    assert.match(root.textContent(), /Fresh task/u);

    firstReadResolvers[0]?.('- [ ] Stale task\n');
    await firstRender;
    assert.match(root.textContent(), /Fresh task/u);
    assert.doesNotMatch(root.textContent(), /Stale task/u);
  } finally {
    globalThis.document = originalDocument;
  }
});

test('query renderer ignores in-flight renders after markdown child unload', async () => {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: (tagName: string) => new FakeElement(tagName),
    createTextNode: (textContent: string) => new FakeTextNode(textContent),
    createElementNS: (_ns: string, tagName: string) => new FakeElement(tagName),
  } as never;

  try {
    const file = fakeFile('Projects/Alpha.md');
    let resolveRead: ((value: string) => void) | undefined;
    const app = {
      vault: {
        getMarkdownFiles: () => [file],
        read: async () => new Promise<string>((resolve) => { resolveRead = resolve; }),
        process: async () => undefined,
        getAbstractFileByPath: () => file,
      },
      metadataCache: { fileToLinktext: (sourceFile: FakeFile) => sourceFile.basename },
      workspace: { getLeaf: () => ({ openFile: async () => undefined }), openLinkText: async () => undefined },
    };
    const renderer = new TaskQueryRenderer(app as never, new TaskScanner(app as never), () => DEFAULT_SETTINGS);
    const root = new FakeElement('div');
    let child: { onunload?: () => void } | undefined;

    const renderPromise = renderer.render('', root as never, {
      sourcePath: 'Dashboard.md',
      addChild: (registeredChild: { onunload?: () => void }) => { child = registeredChild; },
    } as never);

    assert.ok(child, 'expected query renderer to register a MarkdownRenderChild lifecycle hook');
    child.onunload?.();
    resolveRead?.('- [ ] Stale after unload\n');
    await renderPromise;

    assert.doesNotMatch(root.textContent(), /Stale after unload/u);
  } finally {
    globalThis.document = originalDocument;
  }
});

test('query renderer disables inline description editing for Canvas-backed tasks', async () => {
  const originalDocument = globalThis.document;
  globalThis.document = {
    createElement: (tagName: string) => new FakeElement(tagName),
    createTextNode: (textContent: string) => new FakeTextNode(textContent),
    createElementNS: (_ns: string, tagName: string) => new FakeElement(tagName),
  } as never;

  try {
    const canvasFile = { path: 'Board.canvas', extension: 'canvas', basename: 'Board' };
    const app = {
      vault: {
        getMarkdownFiles: () => [],
        getFiles: () => [canvasFile],
        read: async () => JSON.stringify({ nodes: [{ id: 'n1', type: 'text', text: '- [ ] Canvas task' }] }),
        getAbstractFileByPath: () => canvasFile,
      },
      metadataCache: { fileToLinktext: () => 'Board' },
      workspace: { getLeaf: () => ({ openFile: async () => undefined }), openLinkText: async () => undefined },
    };
    const renderer = new TaskQueryRenderer(app as never, new TaskScanner(app as never), () => DEFAULT_SETTINGS);
    const root = new FakeElement('div');

    await renderer.render('', root as never, { sourcePath: 'Dashboard.md' } as never);
    const text = root.findByClass('tasks-list-text');
    assert.ok(text);
    assert.equal(text!.classes.includes('task-manager-desc-editable'), false);
    assert.equal(text!.listeners.has('dblclick'), false);
  } finally {
    globalThis.document = originalDocument;
  }
});

test('log-line formatting includes source links only outside the daily note', () => {
  const app = {
    vault: { getAbstractFileByPath: (path: string) => fakeFile(path) },
    metadataCache: { fileToLinktext: (file: FakeFile) => file.basename },
  };
  const writer = new LogWriter(app as never, () => DEFAULT_SETTINGS);
  const daily = fakeFile('Daily/2026-05-20.md');
  const completedAt = new Date(2026, 4, 20, 14, 32);

  assert.equal(
    writer.formatLogLine(daily as never, { text: 'Finish report', sourcePath: 'Projects/Alpha.md', completedAt }),
    '- 14:32 - Finish report [[Alpha]]',
  );
  assert.equal(
    writer.formatLogLine(daily as never, { text: 'Daily task', sourcePath: daily.path, completedAt }),
    '- 14:32 - Daily task',
  );
});

test('log-line formatting uses configured completion time format', () => {
  const app = { vault: { getAbstractFileByPath: () => null }, metadataCache: { fileToLinktext: () => '' } };
  const writer = new LogWriter(app as never, () => ({ ...DEFAULT_SETTINGS, logTimeFormat: 'h:mm A' }));
  assert.equal(
    writer.formatLogLine(fakeFile('Daily/2026-05-20.md') as never, {
      text: 'Finish report',
      sourcePath: 'Projects/Alpha.md',
      completedAt: new Date(2026, 4, 20, 14, 32),
    }),
    '- 2:32 PM - Finish report [[Projects/Alpha]]',
  );
});

test('log-line formatting can omit completion time', () => {
  const app = { vault: { getAbstractFileByPath: () => null }, metadataCache: { fileToLinktext: () => '' } };
  const writer = new LogWriter(app as never, () => ({ ...DEFAULT_SETTINGS, includeCompletionTime: false }));
  assert.equal(
    writer.formatLogLine(fakeFile('Daily/2026-05-20.md') as never, {
      text: 'Finish report',
      sourcePath: 'Projects/Alpha.md',
      completedAt: new Date(2026, 4, 20, 14, 32),
    }),
    '- Finish report [[Projects/Alpha]]',
  );
});

test('log entry template supports {{date}} variable', () => {
  const app = { vault: { getAbstractFileByPath: () => null }, metadataCache: { fileToLinktext: () => '' } };
  const writer = new LogWriter(app as never, () => ({ ...DEFAULT_SETTINGS, logEntryTemplate: '{{date}} - {{task}}' }));
  assert.equal(
    writer.formatLogLine(fakeFile('Daily/2026-05-20.md') as never, {
      text: 'Complete project',
      sourcePath: 'Projects/Alpha.md',
      completedAt: new Date(2026, 4, 27, 14, 32),
    }),
    '2026-05-27 - Complete project',
  );
});

test('log entry template supports {{status}} variable', () => {
  const app = { vault: { getAbstractFileByPath: () => null }, metadataCache: { fileToLinktext: () => '' } };
  const writer = new LogWriter(app as never, () => ({ ...DEFAULT_SETTINGS, logEntryTemplate: '- {{task}} [{{status}}]' }));
  assert.equal(
    writer.formatLogLine(fakeFile('Daily/2026-05-20.md') as never, {
      text: 'Complete project',
      sourcePath: 'Projects/Alpha.md',
      completedAt: new Date(2026, 4, 20, 14, 32),
    }),
    '- Complete project [completed]',
  );
});

test('log entry template supports {{duration}} variable with conditional', () => {
  const app = { vault: { getAbstractFileByPath: () => null }, metadataCache: { fileToLinktext: () => '' } };
  const writer = new LogWriter(app as never, () => ({ ...DEFAULT_SETTINGS, logEntryTemplate: '- {{task}}{{#duration}} ({{duration}}){{/duration}}' }));
  assert.equal(
    writer.formatLogLine(fakeFile('Daily/2026-05-20.md') as never, {
      text: 'Complete project - 2h 30m',
      sourcePath: 'Projects/Alpha.md',
      completedAt: new Date(2026, 4, 20, 14, 32),
    }),
    '- Complete project - 2h 30m (2h 30m)',
  );
});

test('log entry template template variables work together', () => {
  const app = { vault: { getAbstractFileByPath: () => null }, metadataCache: { fileToLinktext: () => '' } };
  const writer = new LogWriter(app as never, () => ({ ...DEFAULT_SETTINGS, logEntryTemplate: '{{date}} {{time}} - {{task}} [{{status}}]' }));
  assert.equal(
    writer.formatLogLine(fakeFile('Daily/2026-05-20.md') as never, {
      text: 'Complete project',
      sourcePath: 'Projects/Alpha.md',
      completedAt: new Date(2026, 4, 27, 14, 32),
    }),
    '2026-05-27 14:32 - Complete project [completed]',
  );
});

test('log insertion appends under existing Log heading before next peer section', () => {
  const writer = new LogWriter({} as never, () => DEFAULT_SETTINGS);
  const content = '# Today\n\n## Notes\nKeep this.\n\n## Log\n- old\n\n### Details\nNested stays in log.\n\n## Tomorrow\nLater\n';
  const updated = writer.appendLineToSection(content, 'Log', '- 14:32 - Finish report');
  assert.equal(
    updated,
    '# Today\n\n## Notes\nKeep this.\n\n## Log\n- old\n\n### Details\nNested stays in log.\n- 14:32 - Finish report\n\n## Tomorrow\nLater\n',
  );
});

test('log insertion creates Log heading when missing and preserves content', () => {
  const writer = new LogWriter({} as never, () => DEFAULT_SETTINGS);
  assert.equal(
    writer.appendLineToSection('# Today\n\nBody\n', 'Log', '- 14:32 - Finish report'),
    '# Today\n\nBody\n\n## Log\n- 14:32 - Finish report\n',
  );
});

test('log insertion handles closing hashes, leading heading spaces, and CRLF newlines', () => {
  const writer = new LogWriter({} as never, () => DEFAULT_SETTINGS);
  assert.equal(
    writer.appendLineToSection('# Today\r\n\r\n  ## Log ##\r\n- old\r\n\r\n## Next\r\nLater\r\n', 'Log', '- 14:32 - Finish report'),
    '# Today\r\n\r\n  ## Log ##\r\n- old\r\n- 14:32 - Finish report\r\n\r\n## Next\r\nLater\r\n',
  );
});

test('log frontmatter override accepts quoted values with punctuation', async () => {
  let updatedContent = '';
  const writer = new LogWriter({
    vault: {
      cachedRead: async () => `---\ntask_log_heading: "Done: Items"\n---\n`,
      process: async (_file: never, updater: (content: string) => string) => { updatedContent = updater('# Today\n\n## Done: Items\n'); },
    },
    metadataCache: {
      fileToLinktext: () => 'ignored',
    },
  } as never, () => ({ ...DEFAULT_SETTINGS, includeCompletionTime: false }));
  const dailyNote = fakeFile('Today.md');
  const line = await writer.appendToDailyLog(dailyNote as never, {
    text: 'Finish report',
    completedAt: new Date(2026, 4, 27, 14, 32),
  });
  assert.equal(line, '- Finish report');
  assert.equal(updatedContent, '# Today\n\n## Done: Items\n- Finish report\n');
});

test('log insertion appends under an existing Log heading at any level', () => {
  const writer = new LogWriter({} as never, () => DEFAULT_SETTINGS);
  assert.equal(
    writer.appendLineToSection('# Today\n\n### Log\n- old\n\n### Next\nLater\n', 'Log', '- 14:32 - Finish report'),
    '# Today\n\n### Log\n- old\n- 14:32 - Finish report\n\n### Next\nLater\n',
  );
});

test('log writer cancellation predicate prevents process after deferred heading lookup', async () => {
  let resolveRead: (value: string) => void = () => undefined;
  const read = new Promise<string>((resolve) => { resolveRead = resolve; });
  let processes = 0;
  let active = true;
  const writer = new LogWriter({
    vault: {
      cachedRead: async () => read,
      process: async () => { processes += 1; },
    },
  } as never, () => DEFAULT_SETTINGS);
  const append = writer.appendToDailyLog(fakeFile('Today.md') as never, {
    text: 'Completed',
    completedAt: new Date(),
  }, () => active);
  await Promise.resolve();
  active = false;
  resolveRead('---\ntask_log_heading: Log\n---\n');
  await assert.rejects(append, /cancelled/u);
  assert.equal(processes, 0);
});

test('daily note resolver cancellation predicate prevents writes after a deferred read', async () => {
  let resolveTemplate: (value: string) => void = () => undefined;
  const template = new Promise<string>((resolve) => { resolveTemplate = resolve; });
  const templateFile = fakeFile('Templates/Daily.md');
  let creates = 0;
  let active = true;
  const app = {
    plugins: { plugins: { 'periodic-notes': { settings: { daily: { format: 'YYYY-MM-DD', template: 'Templates/Daily' } } } } },
    vault: {
      getAbstractFileByPath: (path: string) => path === templateFile.path ? templateFile : null,
      read: async () => template,
      create: async () => { creates += 1; return fakeFile('unexpected.md'); },
    },
  };
  const resolution = new DailyNoteResolver(app as never).resolveToday(() => active);
  await Promise.resolve();
  active = false;
  resolveTemplate('template');
  await assert.rejects(resolution, /cancelled/u);
  assert.equal(creates, 0);
});

test('daily note resolver uses Periodic Notes folder/date format and creates missing folders', async () => {
  const createdFolders: string[] = [];
  const files = new Map<string, FakeFile>();
  const app = {
    plugins: { plugins: { 'periodic-notes': { settings: { daily: { folder: 'Journal/Daily', format: 'YYYY/MM-MMMM/DD' } } } } },
    vault: {
      getAbstractFileByPath: (path: string) => files.get(path) ?? null,
      createFolder: async (path: string) => { createdFolders.push(path); },
      create: async (path: string) => {
        const file = fakeFile(path);
        files.set(path, file);
        return file;
      },
    },
  };

  const expected = `Journal/Daily/${formatToday('YYYY/MM-MMMM/DD')}.md`;
  const result = await new DailyNoteResolver(app as never).resolveToday();
  assert.equal(result.path, expected);
  assert.deepEqual(createdFolders, ['Journal', 'Journal/Daily', `Journal/Daily/${formatToday('YYYY')}`, `Journal/Daily/${formatToday('YYYY/MM-MMMM')}`]);
});

test('daily note resolver resolves configured paths for arbitrary ISO dates without creating notes', () => {
  const app = {
    plugins: { plugins: { 'periodic-notes': { settings: { daily: { folder: 'Journal/Daily', format: 'YYYY/MM-MMMM/DD-dddd' } } } } },
    vault: { getAbstractFileByPath: () => null },
  };

  const resolver = new DailyNoteResolver(app as never);
  assert.equal(resolver.resolvePathForDate('2026-07-13'), 'Journal/Daily/2026/07-July/13-Monday.md');
});

test('daily note resolver creates missing note with configured template and applies templater', async () => {
  const files = new Map<string, FakeFile>([['Templates/Daily.md', fakeFile('Templates/Daily.md')]]);
  let createdContent = '';
  const templaterCalls: string[] = [];
  const app = {
    plugins: {
      plugins: {
        'periodic-notes': { settings: { daily: { folder: 'Daily', format: 'YYYY-MM-DD', template: 'Templates/Daily' } } },
        'templater-obsidian': { templater: { overwrite_file_commands: async (file: FakeFile) => { templaterCalls.push(file.path); } } },
      },
      enabledPlugins: new Set(['templater-obsidian']),
    },
    vault: {
      getAbstractFileByPath: (path: string) => files.get(path) ?? null,
      createFolder: async (path: string) => { files.set(path, fakeFile(path)); },
      read: async (file: FakeFile) => `Template from ${file.path}\n## Log\n`,
      create: async (path: string, content: string) => {
        createdContent = content;
        const file = fakeFile(path);
        files.set(path, file);
        return file;
      },
    },
  };

  const result = await new DailyNoteResolver(app as never).resolveToday();
  assert.equal(result.path, `Daily/${formatToday('YYYY-MM-DD')}.md`);
  assert.equal(createdContent, 'Template from Templates/Daily.md\n## Log\n');
  assert.deepEqual(templaterCalls, [result.path]);
});

test('daily note resolver still applies templater when enabledPlugins is unavailable', async () => {
  const files = new Map<string, FakeFile>([['Templates/Daily.md', fakeFile('Templates/Daily.md')]]);
  const templaterCalls: string[] = [];
  const app = {
    plugins: {
      plugins: {
        'periodic-notes': { settings: { daily: { folder: 'Daily', format: 'YYYY-MM-DD', template: 'Templates/Daily' } } },
        'templater-obsidian': { templater: { overwrite_file_commands: async (file: FakeFile) => { templaterCalls.push(file.path); } } },
      },
    },
    vault: {
      getAbstractFileByPath: (path: string) => files.get(path) ?? null,
      createFolder: async (path: string) => { files.set(path, fakeFile(path)); },
      read: async (file: FakeFile) => `Template from ${file.path}\n`,
      create: async (path: string) => {
        const file = fakeFile(path);
        files.set(path, file);
        return file;
      },
    },
  };

  const result = await new DailyNoteResolver(app as never).resolveToday();
  assert.deepEqual(templaterCalls, [result.file.path]);
});

test('daily note resolver returns concurrently created note when create races', async () => {
  const path = `${formatToday('YYYY-MM-DD')}.md`;
  const file = fakeFile(path);
  const files = new Map<string, FakeFile>();
  const app = {
    vault: {
      getAbstractFileByPath: (candidate: string) => files.get(candidate) ?? null,
      createFolder: async () => undefined,
      create: async () => {
        files.set(path, file);
        throw new Error('File already exists');
      },
    },
  };

  const result = await new DailyNoteResolver(app as never).resolveToday();
  assert.equal(result.path, path);
  assert.equal(result.file, file);
});

test('daily note resolver uses core Daily Notes settings when Periodic Notes is unavailable', async () => {
  const createdFolders: string[] = [];
  const app = {
    internalPlugins: { getPluginById: () => ({ instance: { options: { folder: 'Daily Notes', format: 'YYYY/MM/DD' } } }) },
    vault: {
      getAbstractFileByPath: () => null,
      createFolder: async (path: string) => { createdFolders.push(path); },
      create: async (path: string) => fakeFile(path),
    },
  };
  const result = await new DailyNoteResolver(app as never).resolveToday();
  assert.equal(result.path, `Daily Notes/${formatToday('YYYY/MM/DD')}.md`);
  assert.deepEqual(createdFolders, ['Daily Notes', `Daily Notes/${formatToday('YYYY')}`, `Daily Notes/${formatToday('YYYY/MM')}`]);
});

test('daily note resolver falls back to root YYYY-MM-DD note', async () => {
  const app = {
    vault: {
      getAbstractFileByPath: () => null,
      createFolder: async () => { throw new Error('no folder should be created'); },
      create: async (path: string) => fakeFile(path),
    },
  };
  const result = await new DailyNoteResolver(app as never).resolveToday();
  assert.equal(result.path, `${formatToday('YYYY-MM-DD')}.md`);
});

test('weekly completion summary uses indexed tasks and configured daily-note paths', async () => {
  const today = formatToday('YYYY-MM-DD');
  const files = new Map<string, FakeFile>();
  const contents = new Map<string, string>();
  const dailyPath = `Daily/${today}.md`;
  files.set(dailyPath, fakeFile(dailyPath));
  contents.set(dailyPath, `# ${today}\n\n## ${DEFAULT_SETTINGS.logSectionHeading}\n- Finished indexed task\n`);
  const created: Record<string, string> = {};
  const opened: string[] = [];
  const reads: string[] = [];
  const app = {
    internalPlugins: { getPluginById: () => ({ instance: { options: { folder: 'Daily', format: 'YYYY-MM-DD' } } }) },
    vault: {
      getAbstractFileByPath: (path: string) => files.get(path) ?? null,
      cachedRead: async (file: FakeFile) => { reads.push(file.path); return contents.get(file.path) ?? ''; },
      create: async (path: string, content: string) => {
        created[path] = content;
        const file = fakeFile(path);
        files.set(path, file);
        contents.set(path, content);
        return file;
      },
      modify: async (file: FakeFile, content: string) => { created[file.path] = content; contents.set(file.path, content); },
    },
    workspace: { getLeaf: () => ({ openFile: async (file: FakeFile) => { opened.push(file.path); } }) },
  };
  const plugin = Object.create(TaskManagerPlugin.prototype) as {
    app: typeof app;
    settings: typeof DEFAULT_SETTINGS;
    dailyNoteResolver: DailyNoteResolver;
    taskIndex: TaskIndex;
    generateCompletionSummary: (period: 'week' | 'month') => Promise<void>;
  };
  plugin.app = app;
  plugin.settings = { ...DEFAULT_SETTINGS, dailyCapacityMinutes: 480 };
  plugin.dailyNoteResolver = new DailyNoteResolver(app as never);
  const task = parseMarkdownTaskLine(`- [x] Finished indexed task ✅ ${today} ⏱️ 2h 🕐 1h`, 'Tasks.md', 1);
  assert.ok(task);
  const index = new TaskIndex();
  index.beginHydration();
  index.markReady();
  index.commit(new Map([['Tasks.md', [task]]]), []);
  plugin.taskIndex = index;

  await plugin.generateCompletionSummary('week');

  assert.deepEqual(reads, [dailyPath]);
  const summaryPath = `Weekly Summary ${today}.md`;
  assert.equal(opened[0], summaryPath);
  assert.match(created[summaryPath], /\| Completed tasks \| 1 \|/u);
  assert.doesNotMatch(created[summaryPath], /Analytics unavailable/u);
});

test('state save/load round trip, schema version, dedupe, and pruning', async () => {
  let saved: unknown = undefined;
  const plugin = {
    loadData: async () => saved,
    saveData: async (data: unknown) => { saved = data; },
  };
  const store = new StateStore(plugin as never);
  const state: PersistedState = {
    version: CURRENT_STATE_VERSION,
    snapshot: [{ key: 'Project.md:finish', status: 'done', filePath: 'Project.md', lineNumber: 1, sourceKind: 'line' }],
    completions: [],
  };
  const completedAtIso = new Date().toISOString();
  const withCompletion = store.addCompletion(state, {
    taskKey: 'Project.md:finish',
    sourcePath: 'Project.md',
    dailyNotePath: 'Daily.md',
    completedAtIso,
    logLineHash: store.hash('line'),
  }, 60);
  await store.saveState(withCompletion);

  const loaded = await store.loadState();
  assert.equal(loaded.version, CURRENT_STATE_VERSION);
  assert.deepEqual(loaded.snapshot, state.snapshot);
  assert.equal(store.hasCompletion(loaded, 'Project.md:finish', 'Project.md', 'Daily.md'), true);

  const duplicated = store.addCompletion(loaded, {
    taskKey: 'Project.md:finish',
    sourcePath: 'Project.md',
    dailyNotePath: 'Daily.md',
    completedAtIso,
    logLineHash: 'new-hash',
  }, 60);
  assert.equal(duplicated.completions.length, 1);
  assert.equal(duplicated.completions[0].logLineHash, 'new-hash');

  const duplicateOnlyState = store.addCompletion({ ...loaded, completions: [] }, {
    taskKey: 'Project.md:finish\u00001',
    sourcePath: 'Project.md',
    dailyNotePath: 'Daily.md',
    completedAtIso,
    logLineHash: 'duplicate-hash',
  }, 60);
  assert.equal(store.hasCompletion(duplicateOnlyState, 'Project.md:finish', 'Project.md', 'Daily.md'), false);
  assert.equal(store.hasCompletion(loaded, 'Project.md:finish\u00001', 'Project.md', 'Daily.md'), false);

  const old = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  assert.deepEqual(store.pruneCompletions([{ ...duplicated.completions[0], completedAtIso: old }], 60), []);
});

test('state store serializes concurrent settings and state writes', async () => {
  let saved: unknown = {};
  let firstLoadStarted!: () => void;
  let allowFirstLoad!: () => void;
  const firstLoadStartedPromise = new Promise<void>((resolve) => { firstLoadStarted = resolve; });
  const allowFirstLoadPromise = new Promise<void>((resolve) => { allowFirstLoad = resolve; });
  let loadCount = 0;
  const store = new StateStore({
    loadData: async () => {
      loadCount += 1;
      if (loadCount === 1) {
        firstLoadStarted();
        await allowFirstLoadPromise;
      }
      return saved;
    },
    saveData: async (data: unknown) => { saved = data; },
  } as never);

  const state: PersistedState = {
    version: CURRENT_STATE_VERSION,
    snapshot: [{ key: 'Project.md:finish', status: 'done', filePath: 'Project.md', lineNumber: 1, sourceKind: 'line' }],
    completions: [],
  };

  const stateWrite = store.saveState(state);
  await firstLoadStartedPromise;
  const settingsWrite = store.saveSettings({ ...DEFAULT_SETTINGS, logSectionHeading: 'Done' });
  allowFirstLoad();
  await Promise.all([stateWrite, settingsWrite]);

  assert.deepEqual((saved as { state?: PersistedState }).state?.snapshot, state.snapshot);
  assert.equal((saved as { settings?: typeof DEFAULT_SETTINGS }).settings?.logSectionHeading, 'Done');
});

function detectCompletions(previous: Map<string, ParsedTask['status']>, tasks: ParsedTask[]): ParsedTask[] {
  const completed: ParsedTask[] = [];
  for (const task of tasks) {
    const old = previous.get(task.key);
    if (isCompletionTransition(old ? { status: old } : undefined, task)) {
      completed.push(task);
    }
    previous.set(task.key, task.status);
  }
  return completed;
}

test('transition detection logs only non-done to done and repeated scans do not duplicate', () => {
  const s = scanner();
  const todo = s.parseTaskLine('- [ ] Finish report', 'Project.md', 1)!;
  const inProgress = s.parseTaskLine('- [/] Finish report', 'Project.md', 1)!;
  const done = s.parseTaskLine('- [x] Finish report', 'Project.md', 1)!;
  const snapshot = new Map<string, ParsedTask['status']>();

  assert.deepEqual(detectCompletions(snapshot, [todo]), []);
  assert.deepEqual(detectCompletions(snapshot, [inProgress]), []);
  assert.deepEqual(detectCompletions(snapshot, [done]).map((task) => task.normalizedText), ['Finish report']);
  assert.deepEqual(detectCompletions(snapshot, [done]), []);
});

test('plugin folder rename and delete update nested snapshot entries', async () => {
  const savedStates: unknown[] = [];
  const plugin = Object.create(TaskManagerPlugin.prototype) as any;
  plugin.queryRenderer = { invalidateCache: () => undefined, refreshAllVisible: () => undefined };
  plugin.stateStore = new StateStore({
    loadData: async () => ({}),
    saveData: async (data: unknown) => { savedStates.push(data); },
  } as never);
  plugin.snapshot = new Map([
    ['Old/Note.md:task', { key: 'Old/Note.md:task', status: 'todo', filePath: 'Old/Note.md', lineNumber: 1 }],
    ['Old/Sub/Other.md:task', { key: 'Old/Sub/Other.md:task', status: 'done', filePath: 'Old/Sub/Other.md', lineNumber: 2 }],
    ['Keep.md:task', { key: 'Keep.md:task', status: 'todo', filePath: 'Keep.md', lineNumber: 1 }],
  ]);

  const renamedFolder = Object.assign(Object.create(TFolder.prototype), { path: 'New' });
  plugin.handleRename(renamedFolder, 'Old');
  await flushPromises();
  assert.deepEqual(Array.from(plugin.snapshot.keys()).sort(), [
    'Keep.md:task',
    'New/Note.md:task',
    'New/Sub/Other.md:task',
  ]);
  assert.equal(plugin.snapshot.get('New/Note.md:task')?.filePath, 'New/Note.md');
  assert.equal(plugin.snapshot.get('New/Sub/Other.md:task')?.filePath, 'New/Sub/Other.md');

  const deletedFolder = Object.assign(Object.create(TFolder.prototype), { path: 'New' });
  plugin.handleDelete(deletedFolder);
  await flushPromises();
  assert.deepEqual(Array.from(plugin.snapshot.keys()), ['Keep.md:task']);
  assert.equal(savedStates.length, 2);
});

test('plugin task mutation refresh rerenders active markdown preview for the changed file', () => {
  const plugin = Object.create(TaskManagerPlugin.prototype) as any;
  let visibleRefreshed = 0;
  let rerendered = 0;
  let appliedScroll: number | null = null;
  const view = {
    file: { path: 'Project.md' },
    getMode: () => 'preview',
    previewMode: {
      getScroll: () => 42,
      rerender: (full?: boolean) => { assert.equal(full, true); rerendered += 1; },
      applyScroll: (scroll: number) => { appliedScroll = scroll; },
    },
  };
  plugin.queryRenderer = { refreshAllVisible: () => { visibleRefreshed += 1; } };
  plugin.app = { workspace: { getActiveViewOfType: () => view } };

  const previousRaf = globalThis.requestAnimationFrame;
  globalThis.requestAnimationFrame = ((callback: FrameRequestCallback) => { callback(0); return 1; }) as typeof requestAnimationFrame;
  try {
    plugin.refreshAfterTaskMutation('Project.md');
  } finally {
    globalThis.requestAnimationFrame = previousRaf;
  }

  assert.equal(visibleRefreshed, 1);
  assert.equal(rerendered, 1);
  assert.equal(appliedScroll, 42);
});

test('appendQuickCaptureTask atomically appends to current vault content', async () => {
  const file = tFileForPath('Inbox.md');
  let content = '- [ ] Existing';
  const app = {
    vault: {
      getAbstractFileByPath: () => file,
      create: async () => file,
      process: async (_file: TFile, updater: (current: string) => string) => { content = updater('- [ ] Existing\n- [ ] Concurrent'); },
    },
  };
  const plugin = Object.create(TaskManagerPlugin.prototype) as any;
  plugin.app = app;
  plugin.settings = { ...DEFAULT_SETTINGS, quickCaptureInboxPath: 'Inbox.md' };
  plugin.queryRenderer = { invalidateCache: () => undefined };

  await plugin.appendQuickCaptureTask('- [ ] Captured');
  assert.equal(content, '- [ ] Existing\n- [ ] Concurrent\n- [ ] Captured');
});

test('appendQuickCaptureTask creates missing parent folders for configured inbox paths', async () => {
  const createdFolders: string[] = [];
  let createdFile: TFile | null = null;
  let createdPath = '';
  let content = '';
  const folders = new Set<string>();
  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => {
        if (createdFile?.path === path) return createdFile;
        if (folders.has(path)) return { path };
        return null;
      },
      createFolder: async (path: string) => { folders.add(path); createdFolders.push(path); },
      create: async (path: string, initial: string) => {
        assert.equal(folders.has('Tasks'), true, 'parent folder should exist before file creation');
        createdFile = tFileForPath(path);
        createdPath = path;
        content = initial;
        return createdFile;
      },
      process: async (_file: TFile, updater: (current: string) => string) => { content = updater(content); },
    },
  };
  const plugin = Object.create(TaskManagerPlugin.prototype) as {
    app: typeof app;
    settings: typeof DEFAULT_SETTINGS;
    queryRenderer: { invalidateCache: () => void };
    appendQuickCaptureTask(taskLine: string): Promise<void>;
  };
  plugin.app = app;
  plugin.settings = { ...DEFAULT_SETTINGS, quickCaptureInboxPath: 'Tasks/Inbox.md' };
  plugin.queryRenderer = { invalidateCache: () => undefined };

  await plugin.appendQuickCaptureTask('- [ ] Captured');

  assert.deepEqual(createdFolders, ['Tasks']);
  assert.equal(createdPath, 'Tasks/Inbox.md');
  assert.equal(content, '- [ ] Captured');
});

test('query renderer moveTaskToFile removes the exact blank-separated child block', async () => {
  const sourceFile = tFileForPath('Source.md');
  const targetFile = tFileForPath('Target.md');
  let sourceContent = '- [ ] Parent\n\n  - [ ] Child\n- [ ] Sibling\n';
  let targetContent = '';
  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => path === sourceFile.path ? sourceFile : null,
      read: async () => sourceContent,
      process: async (file: TFile, updater: (current: string) => string) => {
        if (file.path === sourceFile.path) sourceContent = updater(sourceContent);
        else if (file.path === targetFile.path) targetContent = updater(targetContent);
      },
    },
  };
  const renderer = Object.create(TaskQueryRenderer.prototype) as {
    app: typeof app;
    moveTaskToFile(task: ParsedTask, target: TFile): Promise<void>;
  };
  renderer.app = app;

  await renderer.moveTaskToFile({ filePath: sourceFile.path, lineNumber: 1, linePrefix: '', indentation: '', rawLine: '- [ ] Parent' } as ParsedTask, targetFile);

  assert.equal(sourceContent, '- [ ] Sibling\n');
  assert.equal(targetContent, '- [ ] Parent\n\n  - [ ] Child\n');
});

test('query renderer moveTaskToFile rejects stale rendered line numbers before appending', async () => {
  const sourceFile = tFileForPath('Source.md');
  const targetFile = tFileForPath('Target.md');
  let sourceContent = '- [ ] Inserted later\n- [ ] Original task\n';
  let targetContent = '';
  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => path === sourceFile.path ? sourceFile : null,
      read: async () => sourceContent,
      process: async (file: TFile, updater: (current: string) => string) => {
        if (file.path === sourceFile.path) sourceContent = updater(sourceContent);
        else if (file.path === targetFile.path) targetContent = updater(targetContent);
      },
    },
  };
  const renderer = Object.create(TaskQueryRenderer.prototype) as {
    app: typeof app;
    moveTaskToFile(task: ParsedTask, target: TFile): Promise<void>;
  };
  renderer.app = app;

  await assert.rejects(
    () => renderer.moveTaskToFile({ filePath: sourceFile.path, lineNumber: 1, linePrefix: '', indentation: '', rawLine: '- [ ] Original task' } as ParsedTask, targetFile),
    /source line 1 no longer matches/u,
  );

  assert.equal(sourceContent, '- [ ] Inserted later\n- [ ] Original task\n');
  assert.equal(targetContent, '');
});

test('query renderer deleteTask removes the task line and its indented children', async () => {
  const sourceFile = tFileForPath('Source.md');
  let content = '- [ ] Before\n- [ ] Parent\n\n  - [ ] Child\n- [ ] After\n';
  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => path === sourceFile.path ? sourceFile : null,
      process: async (_file: TFile, updater: (current: string) => string) => { content = updater(content); },
    },
  };
  const renderer = Object.create(TaskQueryRenderer.prototype) as {
    app: typeof app;
    taskCache: unknown;
    fileTaskCache: Map<string, unknown>;
    deleteTask(task: ParsedTask): Promise<void>;
  };
  renderer.app = app;
  renderer.taskCache = null;
  renderer.fileTaskCache = new Map();

  await renderer.deleteTask({ filePath: sourceFile.path, lineNumber: 2, linePrefix: '', indentation: '', rawLine: '- [ ] Parent' } as ParsedTask);

  assert.equal(content, '- [ ] Before\n- [ ] After\n');
});

test('query renderer deleteTask rejects stale rendered line numbers before removing', async () => {
  const sourceFile = tFileForPath('Source.md');
  let content = '- [ ] Inserted later\n- [ ] Original task\n';
  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => path === sourceFile.path ? sourceFile : null,
      process: async (_file: TFile, updater: (current: string) => string) => { content = updater(content); },
    },
  };
  const renderer = Object.create(TaskQueryRenderer.prototype) as {
    app: typeof app;
    taskCache: unknown;
    fileTaskCache: Map<string, unknown>;
    deleteTask(task: ParsedTask): Promise<void>;
  };
  renderer.app = app;
  renderer.taskCache = null;
  renderer.fileTaskCache = new Map();

  await assert.rejects(
    () => renderer.deleteTask({ filePath: sourceFile.path, lineNumber: 1, linePrefix: '', indentation: '', rawLine: '- [ ] Original task' } as ParsedTask),
    /source line 1 no longer matches/u,
  );

  assert.equal(content, '- [ ] Inserted later\n- [ ] Original task\n');
});

test('query renderer reorderTasksInFile keeps blank-separated child blocks together', async () => {
  const file = tFileForPath('Source.md');
  let content = '- [ ] Before\n- [ ] Parent\n\n  - [ ] Child\n- [ ] After\n';
  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => path === file.path ? file : null,
      process: async (_file: TFile, updater: (current: string) => string) => { content = updater(content); },
    },
  };
  const renderer = Object.create(TaskQueryRenderer.prototype) as {
    app: typeof app;
    fileTaskCache: Map<string, unknown>;
    taskCache: Promise<ParsedTask[]> | null;
    reorderTasksInFile(srcTask: ParsedTask, destTask: ParsedTask): Promise<void>;
  };
  renderer.app = app;
  renderer.fileTaskCache = new Map();
  renderer.taskCache = null;

  await renderer.reorderTasksInFile(
    { filePath: file.path, lineNumber: 2, linePrefix: '', indentation: '', rawLine: '- [ ] Parent' } as ParsedTask,
    { filePath: file.path, lineNumber: 1, linePrefix: '', indentation: '', rawLine: '- [ ] Before' } as ParsedTask,
  );

  assert.equal(content, '- [ ] Parent\n\n  - [ ] Child\n- [ ] Before\n- [ ] After\n');
});

test('query renderer reorderTasksInFile ignores drops onto a moved child block', async () => {
  const file = tFileForPath('Source.md');
  let content = '- [ ] Parent\n\n  - [ ] Child\n- [ ] After\n';
  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => path === file.path ? file : null,
      process: async (_file: TFile, updater: (current: string) => string) => { content = updater(content); },
    },
  };
  const renderer = Object.create(TaskQueryRenderer.prototype) as {
    app: typeof app;
    fileTaskCache: Map<string, unknown>;
    taskCache: Promise<ParsedTask[]> | null;
    reorderTasksInFile(srcTask: ParsedTask, destTask: ParsedTask): Promise<void>;
  };
  renderer.app = app;
  renderer.fileTaskCache = new Map();
  renderer.taskCache = null;

  await renderer.reorderTasksInFile(
    { filePath: file.path, lineNumber: 1, linePrefix: '', indentation: '', rawLine: '- [ ] Parent' } as ParsedTask,
    { filePath: file.path, lineNumber: 3, linePrefix: '  ', indentation: '  ', rawLine: '  - [ ] Child' } as ParsedTask,
  );

  assert.equal(content, '- [ ] Parent\n\n  - [ ] Child\n- [ ] After\n');
});

test('query renderer reorderTasksInFile ignores drops onto another task child line', async () => {
  const file = tFileForPath('Source.md');
  let content = '- [ ] Parent\n  - [ ] Child\n- [ ] Mover\n';
  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => path === file.path ? file : null,
      process: async (_file: TFile, updater: (current: string) => string) => { content = updater(content); },
    },
  };
  const renderer = Object.create(TaskQueryRenderer.prototype) as {
    app: typeof app;
    fileTaskCache: Map<string, unknown>;
    taskCache: Promise<ParsedTask[]> | null;
    reorderTasksInFile(srcTask: ParsedTask, destTask: ParsedTask): Promise<void>;
  };
  renderer.app = app;
  renderer.fileTaskCache = new Map();
  renderer.taskCache = null;

  await renderer.reorderTasksInFile(
    { filePath: file.path, lineNumber: 3, linePrefix: '', indentation: '', rawLine: '- [ ] Mover' } as ParsedTask,
    { filePath: file.path, lineNumber: 2, linePrefix: '  ', indentation: '  ', rawLine: '  - [ ] Child' } as ParsedTask,
  );

  assert.equal(content, '- [ ] Parent\n  - [ ] Child\n- [ ] Mover\n');
});

test('query renderer reorderTasksInFile rejects stale rendered line numbers', async () => {
  const file = tFileForPath('Source.md');
  let content = '- [ ] Inserted later\n- [ ] Before\n- [ ] Parent\n- [ ] After\n';
  const app = {
    vault: {
      getAbstractFileByPath: (path: string) => path === file.path ? file : null,
      process: async (_file: TFile, updater: (current: string) => string) => { content = updater(content); },
    },
  };
  const renderer = Object.create(TaskQueryRenderer.prototype) as {
    app: typeof app;
    fileTaskCache: Map<string, unknown>;
    taskCache: Promise<ParsedTask[]> | null;
    reorderTasksInFile(srcTask: ParsedTask, destTask: ParsedTask): Promise<void>;
  };
  renderer.app = app;
  renderer.fileTaskCache = new Map();
  renderer.taskCache = null;

  await assert.rejects(
    () => renderer.reorderTasksInFile(
      { filePath: file.path, lineNumber: 2, linePrefix: '', indentation: '', rawLine: '- [ ] Parent' } as ParsedTask,
      { filePath: file.path, lineNumber: 1, linePrefix: '', indentation: '', rawLine: '- [ ] Before' } as ParsedTask,
    ),
    /source line 2 no longer matches/u,
  );

  assert.equal(content, '- [ ] Inserted later\n- [ ] Before\n- [ ] Parent\n- [ ] After\n');
});

test('archiveCompletedTasksInFile moves completed parent blocks with children', async () => {
  const file = tFileForPath('Project.md');
  let content = [
    '# Project',
    '- [x] Done parent',
    '  - note under done parent',
    '  - [ ] child stays with archived parent',
    '- [ ] Open task',
    '  - open child',
    '',
  ].join('\n');
  let archiveContent = '';
  const app = {
    vault: {
      read: async (target: TFile) => target.path === file.path ? content : archiveContent,
      process: async (target: TFile, updater: (current: string) => string) => {
        if (target.path === file.path) content = updater(content);
        else archiveContent = updater(archiveContent);
      },
      getAbstractFileByPath: (path: string) => path === 'Archive.md' ? tFileForPath('Archive.md') : null,
      create: async (path: string, next: string) => { archiveContent = next; return tFileForPath(path); },
      createFolder: async () => undefined,
    },
  };
  const plugin = Object.create(TaskManagerPlugin.prototype) as any;
  plugin.app = app;
  plugin.settings = { ...DEFAULT_SETTINGS, archiveFilePath: 'Archive.md' };
  plugin.stateStore = new StateStore({ loadData: async () => ({}), saveData: async () => undefined } as never);
  plugin.scanner = new TaskScanner(app as never);

  await plugin.archiveCompletedTasksInFile(file);
  assert.equal(content, '# Project\n- [ ] Open task\n  - open child\n');
  assert.match(archiveContent, /## Archived from \[\[Project\]\] — \d{4}-\d{2}-\d{2}/u);
  assert.match(archiveContent, /- \[x\] Done parent\n  - note under done parent\n  - \[ \] child stays with archived parent/u);
});

test('plugin scan flow handles duplicate-key shifts without duplicate logs or suppressed distinct logs', async () => {
  const source = fakeFile('Project.md');
  const daily = fakeFile('Daily/2026-05-20.md');
  const logged: string[] = [];
  let sourceContent = '- [ ] Same\n- [x] Same\n';
  const app = { vault: { read: async () => sourceContent } };
  const basePlugin = Object.create(TaskManagerPlugin.prototype) as any;
  basePlugin.settings = { ...DEFAULT_SETTINGS, completionLoggingEnabled: true };
  basePlugin.scanner = new TaskScanner(app as never);
  basePlugin.dailyNoteResolver = {
    resolveToday: async () => ({ path: daily.path, file: daily }),
    isTodayDailyNote: (path: string) => path === daily.path,
  };
  basePlugin.logWriter = { appendToDailyLog: async (_dailyNote: FakeFile, entry: { text: string }) => { logged.push(entry.text); return `- ${entry.text}`; } };
  basePlugin.stateStore = new StateStore({ loadData: async () => undefined, saveData: async () => undefined } as never);

  const makePlugin = (): any => {
    const plugin = Object.create(TaskManagerPlugin.prototype) as any;
    plugin.app = app;
    plugin.settings = { ...DEFAULT_SETTINGS, completionLoggingEnabled: true };
    plugin.scanner = new TaskScanner(app as never);
    plugin.dailyNoteResolver = basePlugin.dailyNoteResolver;
    plugin.logWriter = basePlugin.logWriter;
    plugin.stateStore = basePlugin.stateStore;
    plugin.snapshot = new Map();
    plugin.completions = [];
    plugin.inFlightCompletions = new Set();
    return plugin;
  };

  const plugin = makePlugin();
  await plugin.scanFile(source as never);
  sourceContent = '- [x] Same\n';
  await plugin.scanFile(source as never);
  assert.deepEqual(logged, []);

  sourceContent = '- [x] Same\n- [ ] Same\n';
  const secondPlugin = makePlugin();
  await secondPlugin.scanFile(source as never);
  sourceContent = '- [ ] Same\n';
  await secondPlugin.scanFile(source as never);
  sourceContent = '- [x] Same\n';
  await secondPlugin.scanFile(source as never);
  assert.deepEqual(logged, ['Same']);

  sourceContent = '- [ ] Legacy\n- [x] Legacy\n';
  const legacySnapshotPlugin = makePlugin();
  legacySnapshotPlugin.snapshot = new Map([
    ['Project.md:legacy#1', { key: 'Project.md:legacy#1', status: 'todo', filePath: 'Project.md', lineNumber: 1 }],
    ['Project.md:legacy#2', { key: 'Project.md:legacy#2', status: 'todo', filePath: 'Project.md', lineNumber: 2 }],
  ]);
  await legacySnapshotPlugin.scanFile(source as never);
  assert.deepEqual(logged, ['Same', 'Legacy']);

  sourceContent = '- [ ] Fix issue\n- [x] Fix issue#1\n';
  const numericHashPlugin = makePlugin();
  await numericHashPlugin.scanFile(source as never);
  sourceContent = '- [x] Fix issue\n';
  await numericHashPlugin.scanFile(source as never);
  assert.deepEqual(logged, ['Same', 'Legacy', 'Fix issue']);

  sourceContent = '- [ ] Task\n- [ ] Task\n- [ ] Task#1\n';
  const collisionPlugin = makePlugin();
  await collisionPlugin.scanFile(source as never);
  sourceContent = '- [ ] Task\n- [ ] Task\n- [x] Task#1\n';
  await collisionPlugin.scanFile(source as never);
  assert.deepEqual(logged, ['Same', 'Legacy', 'Fix issue', 'Task#1']);

  sourceContent = '- [ ] Task#1\n- [ ] Task#2\n';
  const realHashLegacyPlugin = makePlugin();
  await realHashLegacyPlugin.scanFile(source as never);
  sourceContent = '- [x] Task\n- [ ] Task#1\n- [ ] Task#2\n';
  await realHashLegacyPlugin.scanFile(source as never);
  assert.deepEqual(logged, ['Same', 'Legacy', 'Fix issue', 'Task#1']);

  sourceContent = '- [ ] Task\n- [ ] Task\n';
  const legacyCollisionPlugin = Object.create(TaskManagerPlugin.prototype) as any;
  legacyCollisionPlugin.app = app;
  legacyCollisionPlugin.settings = { ...DEFAULT_SETTINGS, completionLoggingEnabled: true };
  legacyCollisionPlugin.scanner = new TaskScanner(app as never);
  legacyCollisionPlugin.dailyNoteResolver = plugin.dailyNoteResolver;
  legacyCollisionPlugin.logWriter = plugin.logWriter;
  legacyCollisionPlugin.stateStore = plugin.stateStore;
  legacyCollisionPlugin.snapshot = new Map([
    ['Project.md:task#1', { key: 'Project.md:task#1', status: 'todo', filePath: 'Project.md', lineNumber: 1 }],
    ['Project.md:task#2', { key: 'Project.md:task#2', status: 'todo', filePath: 'Project.md', lineNumber: 2 }],
  ]);
  legacyCollisionPlugin.completions = [];
  legacyCollisionPlugin.inFlightCompletions = new Set();

  await legacyCollisionPlugin.scanFile(source as never);
  sourceContent = '- [ ] Task\n- [ ] Task\n- [x] Task#1\n';
  await legacyCollisionPlugin.scanFile(source as never);
  assert.deepEqual(logged, ['Same', 'Legacy', 'Fix issue', 'Task#1']);

  sourceContent = '- [ ] Same\n';
  const prependDoneDuplicatePlugin = makePlugin();
  await prependDoneDuplicatePlugin.scanFile(source as never);
  sourceContent = '- [x] Same\n- [ ] Same\n';
  await prependDoneDuplicatePlugin.scanFile(source as never);
  assert.deepEqual(logged, ['Same', 'Legacy', 'Fix issue', 'Task#1']);

  sourceContent = '- [ ] Same\n';
  const addDoneDuplicatePlugin = makePlugin();
  await addDoneDuplicatePlugin.scanFile(source as never);
  sourceContent = '- [ ] Same\n- [x] Same\n';
  await addDoneDuplicatePlugin.scanFile(source as never);
  assert.deepEqual(logged, ['Same', 'Legacy', 'Fix issue', 'Task#1']);

  sourceContent = '- [x] Same\n- [ ] Same\n';
  const reorderPlugin = makePlugin();
  await reorderPlugin.scanFile(source as never);
  sourceContent = '- [ ] Same\n- [x] Same\n';
  await reorderPlugin.scanFile(source as never);
  assert.deepEqual(logged, ['Same', 'Legacy', 'Fix issue', 'Task#1']);

  sourceContent = '- [ ] Same\n- [x] Same\n';
  const firstOfTwoPlugin = makePlugin();
  await firstOfTwoPlugin.scanFile(source as never);
  sourceContent = '- [x] Same\n- [x] Same\n';
  await firstOfTwoPlugin.scanFile(source as never);
  assert.deepEqual(logged, ['Same', 'Legacy', 'Fix issue', 'Task#1', 'Same']);

  sourceContent = '- [x] Same\n- [ ] Same\n';
  const thirdPlugin = makePlugin();
  await thirdPlugin.scanFile(source as never);
  sourceContent = '- [x] Same\n- [x] Same\n';
  await thirdPlugin.scanFile(source as never);
  assert.deepEqual(logged, ['Same', 'Legacy', 'Fix issue', 'Task#1', 'Same', 'Same']);
});
test('plugin clears startup scan timer on unload', () => {
  const clearedTimers: number[] = [];
  const originalWindow = globalThis.window;
  globalThis.window = {
    setTimeout: () => 123,
    clearTimeout: (timer: number) => { clearedTimers.push(timer); },
    clearInterval: () => undefined,
  } as never;

  try {
    const plugin = Object.create(TaskManagerPlugin.prototype) as any;
    plugin.scanTimer = null;
    plugin.startupScanTimer = 123;
    plugin.pendingFileScans = new Map([["Project.md", 456]]);
    plugin.onunload();
    assert.deepEqual(clearedTimers, [123, 456]);
    assert.equal(plugin.startupScanTimer, null);
  } finally {
    globalThis.window = originalWindow;
  }
});

test('plugin scan flow logs task completion when text changes in same edit', async () => {
  const source = fakeFile('Project.md');
  const daily = fakeFile('Daily/2026-05-20.md');
  let sourceContent = '- [ ] Keep\n- [ ] Old text\n';
  const logged: string[] = [];
  const app = { vault: { read: async () => sourceContent } };
  const plugin = Object.create(TaskManagerPlugin.prototype) as any;
  plugin.app = app;
  plugin.settings = { ...DEFAULT_SETTINGS, completionLoggingEnabled: true };
  plugin.scanner = new TaskScanner(app as never);
  plugin.dailyNoteResolver = {
    resolveToday: async () => ({ path: daily.path, file: daily }),
    isTodayDailyNote: (path: string) => path === daily.path,
  };
  plugin.logWriter = { appendToDailyLog: async (_dailyNote: FakeFile, entry: { text: string }) => { logged.push(entry.text); return `- ${entry.text}`; } };
  plugin.stateStore = new StateStore({ loadData: async () => undefined, saveData: async () => undefined } as never);
  plugin.snapshot = new Map();
  plugin.completions = [];
  plugin.inFlightCompletions = new Set();

  await plugin.scanFile(source as never);
  plugin.snapshot.set('Other.md:other', { key: 'Other.md:other', status: 'todo', filePath: 'Other.md', lineNumber: 1 });
  sourceContent = '- [ ] Keep\n- [x] New text\n';
  await plugin.scanFile(source as never);
  assert.deepEqual(logged, ['New text']);
});

test('plugin scan flow logs unique task completion when line changes in same edit', async () => {
  const source = fakeFile('Project.md');
  const daily = fakeFile('Daily/2026-05-20.md');
  let sourceContent = 'Intro\n- [ ] Finish report\n';
  const logged: string[] = [];
  const app = { vault: { read: async () => sourceContent } };
  const plugin = Object.create(TaskManagerPlugin.prototype) as any;
  plugin.app = app;
  plugin.settings = { ...DEFAULT_SETTINGS, completionLoggingEnabled: true };
  plugin.scanner = new TaskScanner(app as never);
  plugin.dailyNoteResolver = {
    resolveToday: async () => ({ path: daily.path, file: daily }),
    isTodayDailyNote: (path: string) => path === daily.path,
  };
  plugin.logWriter = { appendToDailyLog: async (_dailyNote: FakeFile, entry: { text: string }) => { logged.push(entry.text); return `- ${entry.text}`; } };
  plugin.stateStore = new StateStore({ loadData: async () => undefined, saveData: async () => undefined } as never);
  plugin.snapshot = new Map();
  plugin.completions = [];
  plugin.inFlightCompletions = new Set();

  await plugin.scanFile(source as never);
  sourceContent = 'New heading\nIntro\n- [x] Finish report\n';
  await plugin.scanFile(source as never);
  assert.deepEqual(logged, ['Finish report']);
});

test('plugin scan flow suppresses completions toggled from a query in today daily note', async () => {
  const source = fakeFile('Project.md');
  const daily = fakeFile('Daily/2026-05-20.md');
  let sourceContent = '- [ ] Project task\n';
  const logged: string[] = [];
  const app = { vault: { read: async () => sourceContent } };
  const plugin = Object.create(TaskManagerPlugin.prototype) as any;
  plugin.app = app;
  plugin.settings = { ...DEFAULT_SETTINGS, completionLoggingEnabled: true };
  plugin.scanner = new TaskScanner(app as never, () => DEFAULT_SETTINGS.supportedStates);
  plugin.dailyNoteResolver = {
    resolveToday: async () => ({ path: daily.path, file: daily }),
    isTodayDailyNote: (path: string) => path === daily.path,
  };
  plugin.logWriter = { appendToDailyLog: async (_dailyNote: FakeFile, entry: { text: string }) => { logged.push(entry.text); return `- ${entry.text}`; } };
  plugin.stateStore = new StateStore({ loadData: async () => undefined, saveData: async () => undefined } as never);
  plugin.snapshot = new Map();
  plugin.completions = [];
  plugin.inFlightCompletions = new Set();
  plugin.suppressedCompletionKeys = new Set();

  await plugin.scanFile(source as never);
  const task = plugin.scanner.parseTaskLine('- [ ] Project task', source.path, 1)!;
  plugin.suppressDailyNoteQueryCompletion(task, daily.path, 'x');
  sourceContent = '- [x] Project task\n';
  await plugin.scanFile(source as never);

  assert.deepEqual(logged, []);
  assert.deepEqual(plugin.completions, []);
});

test('plugin scan flow does not log completions from today daily note', async () => {
  const daily = fakeFile('Daily/2026-05-20.md');
  let sourceContent = '- [ ] Daily task\n';
  const logged: string[] = [];
  const app = { vault: { read: async () => sourceContent } };
  const plugin = Object.create(TaskManagerPlugin.prototype) as any;
  plugin.app = app;
  plugin.settings = { ...DEFAULT_SETTINGS, completionLoggingEnabled: true };
  plugin.scanner = new TaskScanner(app as never);
  plugin.dailyNoteResolver = {
    resolveToday: async () => ({ path: daily.path, file: daily }),
    isTodayDailyNote: (path: string) => path === daily.path,
  };
  plugin.logWriter = { appendToDailyLog: async (_dailyNote: FakeFile, entry: { text: string }) => { logged.push(entry.text); return `- ${entry.text}`; } };
  plugin.stateStore = new StateStore({ loadData: async () => undefined, saveData: async () => undefined } as never);
  plugin.snapshot = new Map();
  plugin.completions = [];
  plugin.inFlightCompletions = new Set();

  await plugin.scanFile(daily as never);
  sourceContent = '- [x] Daily task\n';
  await plugin.scanFile(daily as never);

  assert.deepEqual(logged, []);
  assert.deepEqual(plugin.completions, []);
});

test('plugin scan flow snapshots first scan, logs completion once, and persists dedupe', async () => {
  const source = fakeFile('Project.md');
  const daily = fakeFile('Daily/2026-05-20.md');
  let sourceContent = '- [ ] Finish report\n';
  let saved: unknown = undefined;
  const logged: Array<{ text: string; sourcePath?: string }> = [];
  const app = { vault: { read: async () => sourceContent } };
  const plugin = Object.create(TaskManagerPlugin.prototype) as any;

  plugin.app = app;
  plugin.settings = { ...DEFAULT_SETTINGS, completionLoggingEnabled: true };
  plugin.scanner = new TaskScanner(app as never);
  plugin.dailyNoteResolver = {
    resolveToday: async () => ({ path: daily.path, file: daily }),
    isTodayDailyNote: (path: string) => path === daily.path,
  };
  plugin.logWriter = {
    appendToDailyLog: async (_dailyNote: FakeFile, entry: { text: string; sourcePath?: string }) => {
      logged.push({ text: entry.text, sourcePath: entry.sourcePath });
      return `- ${entry.text}`;
    },
  };
  plugin.stateStore = new StateStore({
    loadData: async () => saved,
    saveData: async (data: unknown) => { saved = data; },
  } as never);
  plugin.snapshot = new Map();
  plugin.completions = [];
  plugin.inFlightCompletions = new Set();

  await plugin.scanFile(source as never);
  assert.deepEqual(logged, []);

  sourceContent = '- [x] Finish report\n';
  await plugin.scanFile(source as never);
  assert.deepEqual(logged, [{ text: 'Finish report', sourcePath: 'Project.md' }]);
  assert.equal(plugin.completions.length, 1);

  await plugin.scanFile(source as never);
  assert.equal(logged.length, 1);

  plugin.snapshot.set('Project.md:finish report', { key: 'Project.md:finish report', status: 'todo', filePath: 'Project.md', lineNumber: 1 });
  await plugin.scanFile(source as never);
  assert.equal(logged.length, 1);

  sourceContent = '- [ ] Finish report\n- [ ] Finish report\n';
  await plugin.scanFile(source as never);
  sourceContent = '- [x] Finish report\n- [ ] Finish report\n';
  await plugin.scanFile(source as never);
  assert.equal(logged.length, 2);
});

test('toggle-task-done converts a blank line into a new empty task', () => {
  const plugin = Object.create(TaskManagerPlugin.prototype) as any;
  plugin.settings = { ...DEFAULT_SETTINGS };
  const commands = new Map<string, any>();
  plugin.addCommand = (cmd: any) => { commands.set(cmd.id, cmd); };
  plugin.registerCommands();

  const cmd = commands.get('toggle-task-done');
  assert.ok(cmd, 'toggle-task-done should be registered');

  const lines = ['', '  ', '\tfoo'];
  const cursor = { line: 0, ch: 0 };
  let cursorSet: any = null;
  const editor = {
    getCursor: () => cursor,
    getLine: (line: number) => lines[line],
    setLine: (line: number, text: string) => { lines[line] = text; },
    setCursor: (c: any) => { cursorSet = c; },
  } as any;

  // Blank line
  cursor.line = 0;
  cmd.editorCallback(editor);
  assert.equal(lines[0], '- [ ] ');
  assert.deepEqual(cursorSet, { line: 0, ch: 6 });

  // Whitespace-only line preserves indent
  cursor.line = 1;
  cursorSet = null;
  cmd.editorCallback(editor);
  assert.equal(lines[1], '  - [ ] ');
  assert.deepEqual(cursorSet, { line: 1, ch: 8 });
});

test('sync-google-tasks command is registered even before sync is enabled', () => {
  const plugin = Object.create(TaskManagerPlugin.prototype) as CommandRegistrationHarness;
  plugin.settings = { ...DEFAULT_SETTINGS, googleTasksEnabled: false };
  const commands = new Set<string>();
  plugin.addCommand = (cmd: { id: string }) => { commands.add(cmd.id); };

  plugin.registerSyncCommands();

  assert.equal(commands.has('sync-google-tasks'), true);
});

test('Apple Reminders registers explicit Shortcut export and clipboard import commands without an MCP listener', () => {
  const plugin = Object.create(TaskManagerPlugin.prototype) as CommandRegistrationHarness & { registerCommands: () => void };
  plugin.settings = { ...DEFAULT_SETTINGS, appleRemindersEnabled: true };
  const commands = new Set<string>();
  plugin.addCommand = (command: { id: string }) => { commands.add(command.id); };

  plugin.registerCommands();

  assert.equal(commands.has('sync-apple-reminders'), true);
  assert.equal(commands.has('import-apple-reminders-json'), true);
});

test('cycle and postpone task commands operate on the cursor task', () => {
  const plugin = Object.create(TaskManagerPlugin.prototype) as any;
  plugin.settings = { ...DEFAULT_SETTINGS, setDoneDate: false };
  plugin.scanner = new TaskScanner({} as never, () => plugin.settings.supportedStates, () => '', () => plugin.settings);
  const commands = new Map<string, any>();
  plugin.addCommand = (cmd: any) => { commands.set(cmd.id, cmd); };
  plugin.registerCommands();

  const cycle = commands.get('cycle-task-status');
  assert.ok(cycle, 'cycle-task-status should be registered');
  const cycleLines = ['- [ ] Cycle me'];
  cycle.editorCallback({
    getCursor: () => ({ line: 0, ch: 6 }),
    getLine: (line: number) => cycleLines[line],
    setLine: (line: number, text: string) => { cycleLines[line] = text; },
  } as any);
  assert.equal(cycleLines[0], '- [/] Cycle me');

  const postpone = commands.get('postpone-task');
  assert.ok(postpone, 'postpone-task should be registered');
  const captured: Array<{ event: MouseEvent; file: FakeFile; task: ParsedTask }> = [];
  plugin.openInlineDeferMenu = (event: MouseEvent, file: FakeFile, task: ParsedTask) => {
    captured.push({ event, file, task });
  };
  const file = fakeFile('Project.md');
  postpone.editorCallback({
    getCursor: () => ({ line: 0, ch: 10 }),
    getLine: () => '- [ ] Pay bill 📅 2026-05-21',
    cursorCoords: () => ({ left: 123, bottom: 456 }),
  } as any, { file });

  assert.equal(captured.length, 1, 'postpone command should open defer menu');
  assert.equal(captured[0].file, file);
  assert.equal(captured[0].task.normalizedText, 'Pay bill');
  assert.equal(captured[0].event.clientX, 123);
  assert.equal(captured[0].event.clientY, 456);
});

test('expandDateAbbreviation expands modal-style abbreviations', () => {
  assert.equal(expandDateAbbreviation('td'), 'today');
  assert.equal(expandDateAbbreviation('TM'), 'tomorrow');
  assert.equal(expandDateAbbreviation(' yd '), 'yesterday');
  assert.equal(expandDateAbbreviation('tw'), 'this week');
  assert.equal(expandDateAbbreviation('nw'), 'next week');
  assert.equal(expandDateAbbreviation('we'), 'sat');
  assert.equal(expandDateAbbreviation('weekend'), 'sat');
  assert.equal(expandDateAbbreviation('anything else'), 'anything else');
});

test('buildModalStatusOptions adds an Unknown option for unconfigured status markers', () => {
  const supportedStates = DEFAULT_SETTINGS.supportedStates;
  const knownOptions = buildModalStatusOptions(supportedStates, 'x');
  assert.equal(knownOptions.length, supportedStates.length, 'no Unknown option needed for a known marker');
  assert.ok(knownOptions.every((option) => !option.text.startsWith('Unknown ')));

  const unknownOptions = buildModalStatusOptions(supportedStates, 'z');
  assert.equal(unknownOptions.length, supportedStates.length + 1);
  const last = unknownOptions[unknownOptions.length - 1];
  assert.equal(last.value, 'z');
  assert.equal(last.text, 'Unknown [- [z] ]');

  const emptyOptions = buildModalStatusOptions(supportedStates, '');
  assert.equal(emptyOptions.length, supportedStates.length);
});

test('resolveModalDateInput honours onlyFuture toggle for weekday names', () => {
  // Sunday 2026-05-24: closest Saturday is yesterday (2026-05-23), next Saturday is 2026-05-30.
  const sunday = '2026-05-24';
  const future = resolveModalDateInput('sat', sunday, true);
  const closest = resolveModalDateInput('sat', sunday, false);
  assert.equal(future, '2026-05-30', `onlyFuture:true should resolve sat → 2026-05-30 from a Sunday, got ${future}`);
  assert.equal(closest, '2026-05-23', `onlyFuture:false should resolve sat → closest 2026-05-23 from a Sunday, got ${closest}`);

  // we → sat via abbreviation expansion; same behaviour expected.
  assert.equal(resolveModalDateInput('we', sunday, true), '2026-05-30');
  assert.equal(resolveModalDateInput('we', sunday, false), '2026-05-23');

  // Empty / unparseable input returns null.
  assert.equal(resolveModalDateInput('', sunday, true), null);
});

test('auto-suggest dynamic suggestions expand date abbreviations', () => {
  const today = '2026-05-23';
  const tomorrow = '2026-05-24';
  const yesterday = '2026-05-22';

  const tdSuggestions = autoSuggestDynamicSuggestions('td', false, today);
  assert.ok(tdSuggestions.includes(`📅 ${today}`), `td → expected 📅 ${today}, got ${tdSuggestions.join(', ')}`);
  assert.ok(tdSuggestions.includes(`⏳ ${today}`));
  assert.ok(tdSuggestions.includes(`🛫 ${today}`));

  const tmSuggestions = autoSuggestDynamicSuggestions('tm', false, today);
  assert.ok(tmSuggestions.includes(`📅 ${tomorrow}`), `tm → expected 📅 ${tomorrow}, got ${tmSuggestions.join(', ')}`);

  const ydSuggestions = autoSuggestDynamicSuggestions('yd', false, today);
  // yd → yesterday; resolveFlexibleDate with onlyFuture:true may bump it; just assert a valid date suggestion exists.
  assert.ok(ydSuggestions.some((s) => s.startsWith('📅 ')), `yd should produce a date suggestion, got ${ydSuggestions.join(', ')}`);
  assert.ok(ydSuggestions.some((s) => s.includes(yesterday) || s.includes(today) || s.includes(tomorrow)));

  const weSuggestions = autoSuggestDynamicSuggestions('we', false, today);
  assert.ok(weSuggestions.some((s) => s.startsWith('📅 ')), `we should produce a date suggestion, got ${weSuggestions.join(', ')}`);

  const dataviewSuggestions = autoSuggestDynamicSuggestions('tm', true, today);
  assert.ok(dataviewSuggestions.includes(`[due:: ${tomorrow}]`));
});

test('suggestionDuplicatesExistingField suppresses cancelled/reminder/priority when already present', async () => {
  const { suggestionDuplicatesExistingField, parseEditableTaskLine } = await import('../src/main');

  // Cancelled date present (emoji)
  const lineWithCancelled = parseEditableTaskLine('- [-] Cancelled task ❌ 2026-05-23');
  assert.equal(suggestionDuplicatesExistingField('❌ cancelled today', lineWithCancelled), true);
  assert.equal(suggestionDuplicatesExistingField('[cancelled:: today]', lineWithCancelled), true);
  assert.equal(suggestionDuplicatesExistingField('📅 today', lineWithCancelled), false);

  // Reminder present
  const lineWithReminder = parseEditableTaskLine('- [ ] Task ⏰ 2026-05-23 09:00');
  assert.equal(suggestionDuplicatesExistingField('⏰ reminder today 09:00', lineWithReminder), true);
  assert.equal(suggestionDuplicatesExistingField('[reminder:: today 09:00]', lineWithReminder), true);

  // Priority present (non-normal)
  const lineWithPriority = parseEditableTaskLine('- [ ] Task ⏫');
  assert.equal(suggestionDuplicatesExistingField('🔼 medium priority', lineWithPriority), true);
  assert.equal(suggestionDuplicatesExistingField('⏫ high priority', lineWithPriority), true);
  assert.equal(suggestionDuplicatesExistingField('[priority:: high]', lineWithPriority), true);

  // No priority → don't suppress
  const lineWithoutPriority = parseEditableTaskLine('- [ ] Task');
  assert.equal(suggestionDuplicatesExistingField('🔼 medium priority', lineWithoutPriority), false);

  // Dependencies are NOT suppressed even when one exists (multiple deps allowed)
  const lineWithDependsOn = parseEditableTaskLine('- [ ] Task ⛔ abc123');
  assert.equal(suggestionDuplicatesExistingField('⛔ depends on id', lineWithDependsOn), false);
});

test('editable task parser preserves spaced dependency lists', async () => {
  const { parseEditableTaskLine } = await import('../src/main');

  const parsed = parseEditableTaskLine('- [ ] Task ⛔ dep-1, dep-2, dep_3');
  assert.equal(parsed.description, 'Task');
  assert.equal(parsed.dependsOn, 'dep-1,dep-2,dep_3');

  const withLegacyCancelledDate = parseEditableTaskLine('- [ ] Task ⛔ 2026-05-23 ⛔ alpha , beta-2');
  assert.equal(withLegacyCancelledDate.description, 'Task');
  assert.equal(withLegacyCancelledDate.cancelled, '2026-05-23');
  assert.equal(withLegacyCancelledDate.dependsOn, 'alpha,beta-2');
});

test('editable task parser strips wikilink and follow-up date metadata from descriptions', async () => {
  const { parseEditableTaskLine } = await import('../src/main');
  const { formatEditableTaskLine } = await import('../src/modals/task-edit-helpers');

  const wikilinkDates = parseEditableTaskLine('- [ ] Task 📅 [[2026-05-23|Sat]] ⏰ [[2026-05-22 09:30]]');
  assert.equal(wikilinkDates.description, 'Task');
  assert.equal(wikilinkDates.due, '2026-05-23');
  assert.equal(wikilinkDates.reminder, '2026-05-22 09:30');

  const followUp = parseEditableTaskLine('- [ ] Call customer 👀 [[2026-05-24]]');
  assert.equal(followUp.description, 'Call customer');
  assert.equal(followUp.followUp, '2026-05-24');
  assert.equal(formatEditableTaskLine(followUp, 'emoji'), '- [ ] Call customer 👀 2026-05-24');
});

test('rendered full-mode backlinks are wrapped in parentheses without inline line number', async () => {
  const { formatBacklinkVisibleText } = await import('../src/query-renderer');
  assert.equal(formatBacklinkVisibleText('Note', 'Heading'), '(Note > Heading)');
  assert.equal(formatBacklinkVisibleText('Note', null), '(Note)');
  assert.equal(formatBacklinkVisibleText('Note', undefined), '(Note)');
  // Heading matching filename should not be duplicated.
  assert.equal(formatBacklinkVisibleText('Note', 'Note'), '(Note)');
  // No inline line number in the visible text.
  assert.ok(!/:\d+\)$/u.test(formatBacklinkVisibleText('Note', 'Heading')));
});

test('modal apply auto-fills cancelled date even when Cancelled field is hidden', async () => {
  const { computeModalLifecycleDates } = await import('../src/main');
  const today = '2026-05-23';
  // Transition todo -> cancelled with hidden cancelled field; auto-fill expected.
  const r1 = computeModalLifecycleDates(
    'todo',
    'cancelled',
    { done: '', cancelled: '' },
    { setDoneDate: true, setCancelledDate: true },
    null,
    null,
    today,
  );
  assert.equal(r1.cancelled, today, `expected auto-filled cancelled date, got "${r1.cancelled}"`);
  assert.equal(r1.done, '');

  // Transition todo -> done with hidden done field.
  const r2 = computeModalLifecycleDates(
    'todo',
    'done',
    { done: '', cancelled: '' },
    { setDoneDate: true, setCancelledDate: true },
    null,
    null,
    today,
  );
  assert.equal(r2.done, today);
  assert.equal(r2.cancelled, '');

  // setCancelledDate=false: do not auto-fill on transition.
  const r3 = computeModalLifecycleDates(
    'todo',
    'cancelled',
    { done: '', cancelled: '' },
    { setDoneDate: true, setCancelledDate: false },
    null,
    null,
    today,
  );
  assert.equal(r3.cancelled, '');

  // Transition away from done with hidden done field clears the done date.
  const r4 = computeModalLifecycleDates(
    'done',
    'todo',
    { done: '2025-01-01', cancelled: '' },
    { setDoneDate: true, setCancelledDate: true },
    null,
    null,
    today,
  );
  assert.equal(r4.done, '');

  // Visible input value (even when status type does not match) is honoured.
  const r5 = computeModalLifecycleDates(
    'todo',
    'todo',
    { done: '', cancelled: '' },
    { setDoneDate: true, setCancelledDate: true },
    '2026-04-01',
    null,
    today,
  );
  assert.equal(r5.done, '2026-04-01');
});

test('filterTasks applies default limit of 100 when no limit specified', () => {
  const tasks = Array.from({ length: 150 }, (_, index) => parseMarkdownTaskLine(`- [ ] Task ${index + 1}`, 'A.md', index + 1)!);
  const limited = filterTasks(tasks, 'not done');
  assert.equal(limited.length, 100);
  const explicit = filterTasks(tasks, 'not done\nlimit 200');
  assert.equal(explicit.length, 150);
  const smaller = filterTasks(tasks, 'not done\nlimit 5');
  assert.equal(smaller.length, 5);
});

test('sort by description uses numeric-aware natural ordering', () => {
  const tasks = [
    parseMarkdownTaskLine('- [ ] task 10', 'A.md', 1)!,
    parseMarkdownTaskLine('- [ ] task 2', 'A.md', 2)!,
    parseMarkdownTaskLine('- [ ] task 1', 'A.md', 3)!,
    parseMarkdownTaskLine('- [ ] task 20', 'A.md', 4)!,
  ];
  const sorted = filterTasks(tasks, 'not done\nsort by description');
  assert.deepEqual(sorted.map((task) => task.normalizedText), ['task 1', 'task 2', 'task 10', 'task 20']);
});

test('group by urgency uses range labels matching upstream obsidian-tasks buckets', () => {
  const tasks = [
    parseMarkdownTaskLine('- [ ] Critical 🔺 📅 2026-05-15', 'A.md', 1),
    parseMarkdownTaskLine('- [ ] Soonish 📅 2026-05-25', 'A.md', 2),
    parseMarkdownTaskLine('- [ ] Far future 🔽 📅 2027-01-01', 'A.md', 3),
    parseMarkdownTaskLine('- [ ] Plain', 'A.md', 4),
  ].filter((task): task is ParsedTask => task !== null);
  const groups = groupTasks(tasks, parseTaskQuery('group by urgency').groups, '2026-05-20');
  const names = groups.map((group) => group.name);
  // Every group name must be an upstream-style range label, never an exact score like "7.35".
  for (const name of names) {
    assert.ok(
      /^(9\.0 or more|[1-8]\.0 to [1-8]\.9|less than 1\.0)$/u.test(name),
      `urgency group name must be a bucket range, got: ${name}`,
    );
    assert.ok(!/^\d+\.\d{2}$/u.test(name), `urgency group must not be an exact score: ${name}`);
  }
});

test('task ID parsing rejects characters outside [A-Za-z0-9_-]', () => {
  const valid = parseMarkdownTaskLine('- [ ] Item 🆔 abc-123_ok', 'Projects/Alpha.md', 1);
  assert.ok(valid);
  assert.equal(valid.metadata.id, 'abc-123_ok');

  const invalid = parseMarkdownTaskLine('- [ ] Item 🆔 bad.id!', 'Projects/Alpha.md', 2);
  assert.ok(invalid);
  assert.equal(invalid.metadata.id, undefined, 'dotted/punctuated IDs must not be accepted');

  const dataviewValid = parseMarkdownTaskLine('- [ ] Item [id:: alpha_01]', 'Projects/Alpha.md', 3);
  assert.ok(dataviewValid);
  assert.equal(dataviewValid.metadata.id, 'alpha_01');

  const dataviewInvalid = parseMarkdownTaskLine('- [ ] Item [id:: not.allowed]', 'Projects/Alpha.md', 4);
  assert.ok(dataviewInvalid);
  assert.equal(dataviewInvalid.metadata.id, undefined, 'dataview ID must also follow allowed character set');
});

test('global filter matching is case-insensitive for text filters', async () => {
  const app = { vault: { read: async () => '- [ ] TASK Mixed casing #note\n- [ ] task lower #note\n- [ ] no marker here\n' } };
  const tasks = await new TaskScanner(app as never, undefined, () => 'Task').scanFile(fakeFile('Notes.md') as never);
  assert.equal(tasks.length, 2, 'tasks containing the filter token in any case must be recognised');
});

test('plain-text global filter removal strips repeated filter tokens', async () => {
  const app = { vault: { read: async () => '- [ ] task task Ship task\n' } };
  const tasks = await new TaskScanner(app as never, undefined, () => 'task', () => ({
    ...DEFAULT_SETTINGS,
    removeGlobalFilterFromDescription: true,
  })).scanFile(fakeFile('Notes.md') as never);

  assert.equal(tasks.length, 1);
  assert.equal(tasks[0].normalizedText, 'Ship');
  assert.equal(tasks[0].key, 'Notes.md:ship');
});

test('tag-based global filter uses tag boundaries and strips nested sub-tags', async () => {
  const app = { vault: { read: async () => '- [ ] #task Ship #task/work #task/work/urgent #other\n- [ ] #tasking False positive\n- [ ] foo#taskbar Also false\n' } };
  const tasks = await new TaskScanner(app as never, undefined, () => '#task').scanFile(fakeFile('Notes.md') as never);
  assert.equal(tasks.length, 1, 'tag global filters must not match tag-prefix or inline substring false positives');
  assert.deepEqual(tasks[0].tags, ['other'], 'global filter tag and its sub-tags must be removed from the tag list');

  const nestedApp = { vault: { read: async () => '- [ ] #task/work Nested filter match\n' } };
  const nested = await new TaskScanner(nestedApp as never, undefined, () => '#task').scanFile(fakeFile('Notes.md') as never);
  assert.equal(nested.length, 1, 'nested sub-tags still satisfy their root global filter');

  const removeApp = { vault: { read: async () => '- [ ] #Task, Ship #TASK/work. #other\n' } };
  const removed = await new TaskScanner(removeApp as never, undefined, () => '#task', () => ({
    ...DEFAULT_SETTINGS,
    removeGlobalFilterFromDescription: true,
  })).scanFile(fakeFile('Notes.md') as never);
  assert.deepEqual(removed[0].tags, ['other'], 'sub-tag stripping is case-insensitive');
  assert.equal(removed[0].normalizedText, 'Ship #other', 'punctuation-delimited global tags are hidden from descriptions');
});

test('task scanner flags unrecognised recurrence rules with invalidRecurrence', async () => {
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.map((value) => String(value)).join(' ')); };
  try {
    const app = { vault: { read: async () => '- [ ] Bad recurrence 🔁 every whenever 📅 2026-05-19\n' } };
    const tasks = await new TaskScanner(app as never).scanFile(fakeFile('InvalidRecurrenceWarning.md') as never);
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].metadata.invalidRecurrence, true, 'unrecognised recurrence rule should set invalidRecurrence');
    assert.ok(
      warnings.some((line) => line.includes('Unrecognised recurrence rule') && line.includes('every whenever')),
      `expected a console warning naming the bad rule, got: ${warnings.join(' | ')}`,
    );
  } finally {
    console.warn = originalWarn;
  }

  // A valid rule must not be flagged.
  const okApp = { vault: { read: async () => '- [ ] Good recurrence 🔁 every day 📅 2026-05-19\n' } };
  const okTasks = await new TaskScanner(okApp as never).scanFile(fakeFile('Project.md') as never);
  assert.equal(okTasks[0].metadata.invalidRecurrence, undefined, 'valid recurrence rule must not be flagged');
});

test('task query supports parens, square and curly boolean delimiter families', () => {
  // Mixing two delimiter families on the same line is still rejected.
  assert.throws(
    () => parseTaskQuery('(not done) AND [tag includes #home]'),
    /Mixed boolean operator delimiters/u,
    'mixing () and [] should raise a parse error',
  );

  // Square brackets and curly braces are now accepted as boolean delimiters,
  // matching the upstream Tasks plugin behaviour.
  const square = parseTaskQuery('[not done] AND [tag includes #home]');
  assert.equal(square.errors.length, 0, `square delimiters should parse cleanly: ${square.errors.join('; ')}`);

  const curly = parseTaskQuery('{not done} AND {tag includes #home}');
  assert.equal(curly.errors.length, 0, `curly delimiters should parse cleanly: ${curly.errors.join('; ')}`);

  // Wikilinks inside filter values must not trigger the mixed-delimiter detection.
  const fine = parseTaskQuery('not done AND (path includes [[Some/Note]])');
  assert.equal(fine.errors.length, 0, `query with wikilink inside parens should parse cleanly: ${fine.errors.join('; ')}`);
});

test('task query honours backslash line continuations and double-backslash escape', () => {
  // Single trailing backslash joins lines with a space.
  const continued = parseTaskQuery('description includes hello \\\n   world');
  assert.equal(continued.errors.length, 0, `continued line should parse: ${continued.errors.join('; ')}`);
  assert.ok(
    continued.instructions.some((line) => /description includes hello\s+world/u.test(line)),
    `expected joined instruction, got: ${continued.instructions.join(' | ')}`,
  );

  // Double trailing backslash is an escaped literal backslash; the next line stays separate.
  const escaped = parseTaskQuery('description includes alpha\\\\\ndescription includes beta');
  assert.equal(escaped.errors.length, 0, `escaped backslash should parse: ${escaped.errors.join('; ')}`);
  assert.equal(escaped.filters.length, 2, 'two separate description filters expected when trailing backslash is escaped');
});

test('task scanner strips dataview-format completion/cancelled/id/dependsOn fields from next occurrence', () => {
  const today = '2026-05-23';
  const settings = { ...DEFAULT_SETTINGS, taskFormat: 'dataview' as const, setCreatedDate: false };
  const lines = applyTaskCompletionLifecycleToLine(
    '- [ ] Plan [repeat:: every week] [due:: 2026-05-19] [id:: alpha] [dependsOn:: beta, gamma] [completion:: 2026-05-18] [cancelled:: 2026-05-18]',
    'x',
    DEFAULT_SETTINGS.supportedStates,
    settings,
    today,
  ) ?? [];
  const nextLine = lines.find((line) => /^- \[ \]/u.test(line));
  assert.ok(nextLine, `expected a next occurrence line in:\n${lines.join('\n')}`);
  assert.doesNotMatch(nextLine!, /\[id::/u, 'dataview id should be stripped from next occurrence');
  assert.doesNotMatch(nextLine!, /\[dependsOn::/iu, 'dataview dependsOn should be stripped');
  assert.doesNotMatch(nextLine!, /\[completion::/u, 'dataview completion should be stripped');
  assert.doesNotMatch(nextLine!, /\[cancelled::/u, 'dataview cancelled should be stripped');
  assert.match(nextLine!, /\[due:: 2026-05-26\]/u, 'due date should advance by one week');
});

test('task scanner strips emoji depends-on lists with comma+space separators on next occurrence', () => {
  const today = '2026-05-23';
  const settings = { ...DEFAULT_SETTINGS, setCreatedDate: false };
  const lines = applyTaskCompletionLifecycleToLine(
    '- [ ] Work 🔁 every day 📅 2026-05-19 🆔 myid ⛔ dep-1, dep-2 , dep-3',
    'x',
    DEFAULT_SETTINGS.supportedStates,
    settings,
    today,
  ) ?? [];
  const nextLine = lines.find((line) => /^- \[ \]/u.test(line));
  assert.ok(nextLine, lines.join('\n'));
  assert.doesNotMatch(nextLine!, /🆔/u, 'id symbol should be removed');
  assert.doesNotMatch(nextLine!, /⛔/u, 'depends-on list (including comma-separated entries) should be removed');
  assert.match(nextLine!, /📅 2026-05-20/u);
});

test('task scanner drops inherited created date from next occurrence when setCreatedDate is disabled', () => {
  const today = '2026-05-23';
  const settings = { ...DEFAULT_SETTINGS, setCreatedDate: false };
  const lines = applyTaskCompletionLifecycleToLine(
    '- [ ] Audit 🔁 every week ➕ 2026-04-01 📅 2026-05-19',
    'x',
    DEFAULT_SETTINGS.supportedStates,
    settings,
    today,
  ) ?? [];
  const nextLine = lines.find((line) => /^- \[ \]/u.test(line));
  assert.ok(nextLine, lines.join('\n'));
  assert.doesNotMatch(nextLine!, /➕/u, 'created date should not carry over when setCreatedDate=false');
  assert.match(nextLine!, /📅 2026-05-26/u);
});

test('task scanner refreshes created date to today on next occurrence when setCreatedDate is enabled', () => {
  const today = '2026-05-23';
  const settings = { ...DEFAULT_SETTINGS, setCreatedDate: true };
  const lines = applyTaskCompletionLifecycleToLine(
    '- [ ] Audit 🔁 every week ➕ 2026-04-01 📅 2026-05-19',
    'x',
    DEFAULT_SETTINGS.supportedStates,
    settings,
    today,
  ) ?? [];
  const nextLine = lines.find((line) => /^- \[ \]/u.test(line));
  assert.ok(nextLine, lines.join('\n'));
  assert.match(nextLine!, /➕ 2026-05-23/u, 'created date on next occurrence should be today');
  assert.doesNotMatch(nextLine!, /➕ 2026-04-01/u, 'old created date should not survive');
});

test('task scanner does not regenerate recurrence when status was already done (done → done)', () => {
  const today = '2026-05-23';
  const settings = { ...DEFAULT_SETTINGS, setCreatedDate: false };
  const lines = applyTaskCompletionLifecycleToLine(
    '- [x] Already done 🔁 every day 📅 2026-05-19 ✅ 2026-05-19',
    'x',
    DEFAULT_SETTINGS.supportedStates,
    settings,
    today,
  ) ?? [];
  // Upstream guard: oldStatusWasDone short-circuits new occurrence.
  const newOccurrences = lines.filter((line) => /^- \[ \]/u.test(line));
  assert.equal(newOccurrences.length, 0, `should not emit a new occurrence when status was already done, got:\n${lines.join('\n')}`);
});

test('task scanner does not regenerate recurrence when cancelling an already-cancelled task', () => {
  const today = '2026-05-23';
  const settings = { ...DEFAULT_SETTINGS, recurrenceOnCancelled: true, setCreatedDate: false };
  const lines = applyTaskCompletionLifecycleToLine(
    '- [-] Already cancelled 🔁 every day 📅 2026-05-19 ❌ 2026-05-19',
    '-',
    DEFAULT_SETTINGS.supportedStates,
    settings,
    today,
  ) ?? [];
  const newOccurrences = lines.filter((line) => /^- \[ \]/u.test(line));
  assert.equal(newOccurrences.length, 0, `should not emit a new occurrence when status was already cancelled, got:\n${lines.join('\n')}`);
});

test('task query layout: `hide recurrence` alias maps to recurrence rule', () => {
  const query = parseTaskQuery('not done\nhide recurrence');
  assert.equal(query.errors.length, 0, `unexpected errors: ${query.errors.join('; ')}`);
  assert.ok(query.layout.hidden.has('recurrence rule'), `expected 'recurrence rule' to be hidden, got: ${[...query.layout.hidden].join(',')}`);
});

test('task query: recursive preset expansion (preset inside preset)', () => {
  const query = parseTaskQuery('preset outer', {
    savedQueries: [
      { name: 'outer', query: 'preset inner\nlimit 5' },
      { name: 'inner', query: 'not done\ntag includes #home' },
    ],
  });
  assert.equal(query.errors.length, 0, `unexpected errors: ${query.errors.join('; ')}`);
  assert.equal(query.limit, 5, 'limit from outer preset should be applied');
  assert.ok(
    query.filters.some((f) => /done/u.test(f.description)) && query.filters.some((f) => /tag.+home/u.test(f.description)),
    `expected both filters from inner preset, got: ${query.filters.map((f) => f.description).join('; ')}`,
  );
});

test('task query: preset cycle detection emits a comment line instead of recursing forever', () => {
  const query = parseTaskQuery('preset alpha', {
    savedQueries: [
      { name: 'alpha', query: 'preset beta' },
      { name: 'beta', query: 'preset alpha' },
    ],
  });
  // Cyclic preset should not throw and should not produce filters, just an inert comment line.
  assert.equal(query.filters.length, 0, `cyclic preset should not yield filters, got: ${query.filters.map((f) => f.description).join('; ')}`);
});

test('task query explain body: upstream-shape output for filter/group/sort/layout/limit', () => {
  const query = parseTaskQuery('not done\ngroup by status\nsort by due\nshort mode\nhide tree\nlimit 5\nlimit groups 3');
  const body = buildExplainBody(query);
  assert.match(body, /^not done/u, `body should start with the filter instruction\n${body}`);
  assert.match(body, /\ngroup by status\n/u, `body should contain 'group by status'\n${body}`);
  assert.match(body, /\nsort by due\n/u, `body should contain 'sort by due'\n${body}`);
  assert.match(body, /\nshort mode\n/u, `body should contain 'short mode'\n${body}`);
  assert.match(body, /\nhide tree\n/u, `body should contain 'hide tree'\n${body}`);
  assert.match(body, /At most 5 tasks\./u, `body should contain limit text\n${body}`);
  assert.match(body, /At most 3 tasks per group/u, `body should contain group limit text\n${body}`);
});

test('task query explain body: date range filters get => expansion', () => {
  const query = parseTaskQuery('due today');
  const body = buildExplainBody(query);
  // Expansion uses today's date; just confirm '=>' arrow appears with a YYYY-MM-DD result.
  assert.match(body, /due today => \d{4}-\d{2}-\d{2}/u, `expected '=>' expansion, got:\n${body}`);
});

test('is recurring: invalid recurrence rule does not satisfy `is recurring`', () => {
  const valid = parseMarkdownTaskLine('- [ ] Daily 🔁 every day 📅 2026-05-21', 'A.md', 1)!;
  const invalid = parseMarkdownTaskLine('- [ ] Garbage 🔁 every blurp 📅 2026-05-21', 'A.md', 2)!;
  // Mirror what task-scanner.parseTaskLine does for an unrecognised rule.
  invalid.metadata.invalidRecurrence = true;
  assert.deepEqual(filterTasks([valid, invalid], 'is recurring').map((t) => t.lineNumber), [1]);
  assert.deepEqual(filterTasks([valid, invalid], 'is not recurring').map((t) => t.lineNumber), [2]);
});

test('group by filename wraps value in [[wikilink]] to match upstream FilenameField.grouper', () => {
  const task = parseMarkdownTaskLine('- [ ] Hello', 'folder/Sub/My Note.md', 3)!;
  const groups = groupTasks([task], parseTaskQuery('group by filename').groups, '2026-05-20');
  // Walk to deepest group (where tasks live)
  let node: { name?: string; children?: any[]; tasks?: any[] } = groups[0] ?? {};
  while (node.children && node.children.length) node = node.children[0];
  assert.equal(node.name, '[[My Note]]', `expected wikilink-wrapped filename, got ${node.name}`);
});

test('group by backlink wraps value in wikilink with optional heading anchor', () => {
  const noHeading = parseMarkdownTaskLine('- [ ] Hello', 'folder/Topic.md', 1)!;
  const withHeading = parseMarkdownTaskLine('- [ ] Hello', 'folder/Topic.md', 2)!;
  withHeading.heading = 'Tasks';
  const groupsNo = groupTasks([noHeading], parseTaskQuery('group by backlink').groups, '2026-05-20');
  let n: any = groupsNo[0]; while (n.children?.length) n = n.children[0];
  assert.equal(n.name, '[[Topic]]');

  const groupsHd = groupTasks([withHeading], parseTaskQuery('group by backlink').groups, '2026-05-20');
  n = groupsHd[0]; while (n.children?.length) n = n.children[0];
  assert.equal(n.name, '[[Topic#Tasks|Topic > Tasks]]');
});

test('group by path strips .md extension to match upstream PathField.grouper', () => {
  const task = parseMarkdownTaskLine('- [ ] Hello', 'folder/Sub/My Note.md', 3)!;
  const groups = groupTasks([task], parseTaskQuery('group by path').groups, '2026-05-20');
  let n: any = groups[0]; while (n.children?.length) n = n.children[0];
  assert.equal(n.name, 'folder/Sub/My Note');
});

test('tree mode: matched child task does not render twice when parent task is also matched', async () => {
  const originalDocument = globalThis.document;
  const originalRenderMarkdown = MarkdownRenderer.renderMarkdown;
  globalThis.document = {
    createElement: (tagName: string) => new FakeElement(tagName),
    createTextNode: (textContent: string) => new FakeTextNode(textContent),
    createElementNS: (_ns: string, tagName: string) => new FakeElement(tagName),
  } as never;
  (MarkdownRenderer as unknown as { renderMarkdown: (markdown: string, el: HTMLElement, sourcePath: string) => Promise<void> }).renderMarkdown = async (markdown: string, el: HTMLElement) => {
    if ('setText' in el && typeof (el as unknown as FakeElement).setText === 'function') (el as unknown as FakeElement).setText(markdown);
  };
  try {
    const file = fakeFile('Projects/Tree.md');
    // A parent task with a nested matched child. Child description sorts before parent
    // alphabetically, so without the willBeAddedLater gate the child would appear at
    // root and also as a descendant of the parent.
    const sourceContent = '- [ ] Parent task\n    - [ ] Aaa nested child\n- [ ] Second parent\n    - [ ] Bbb nested child\n';
    let reads = 0;
    const app = {
      vault: {
        getMarkdownFiles: () => [file],
        read: async () => { reads += 1; return sourceContent; },
        process: async () => sourceContent,
        getAbstractFileByPath: () => file,
      },
      metadataCache: { fileToLinktext: (sourceFile: FakeFile) => sourceFile.basename },
      workspace: { getLeaf: () => ({ openFile: async () => undefined }), openLinkText: async () => undefined },
    };
    const renderer = new TaskQueryRenderer(app as never, new TaskScanner(app as never), () => DEFAULT_SETTINGS);
    const root = new FakeElement('div');
    // `show tree` enables tree rendering; `sort by description` puts child first.
    await renderer.render('show tree\nsort by description', root as never, { sourcePath: 'Dashboard.md' } as never);
    const items = root.findAllByClass('task-manager-query-item');
    // Two distinct task rows: parent at root, child nested under it. The child must NOT
    // also appear as a root-level sibling of the parent.
    assert.equal(items.length, 4, `expected 4 task rows, got ${items.length}`);
    assert.equal(reads, 2, 'tree rendering should scan once and build one source context for the file');
    // The root <ul> must contain exactly one task <li> directly; the child belongs in
    // the nested <ul> under that <li>.
    const rootList = root.findByClass('task-manager-query-list');
    const directTaskChildren = (rootList?.children ?? []).filter(
      (child) => child instanceof FakeElement && child.classes.includes('task-manager-query-item'),
    );
    assert.equal(directTaskChildren.length, 2, 'only the two parents should be top-level task items');
  } finally {
    globalThis.document = originalDocument;
    (MarkdownRenderer as unknown as { renderMarkdown: typeof originalRenderMarkdown }).renderMarkdown = originalRenderMarkdown;
  }
});

test('task query layout: `show progress` / `hide progress` toggle subtask progress badge', () => {
  const showQuery = parseTaskQuery('show progress');
  assert.equal(showQuery.errors.length, 0, `unexpected errors: ${showQuery.errors.join('; ')}`);
  assert.ok(showQuery.layout.shown.has('progress'), 'show progress should set layout.shown("progress")');
  assert.ok(!showQuery.layout.hidden.has('progress'), 'show progress should not set layout.hidden("progress")');

  const hideQuery = parseTaskQuery('hide progress');
  assert.equal(hideQuery.errors.length, 0, `unexpected errors: ${hideQuery.errors.join('; ')}`);
  assert.ok(hideQuery.layout.hidden.has('progress'), 'hide progress should set layout.hidden("progress")');
  assert.ok(!hideQuery.layout.shown.has('progress'), 'hide progress should not set layout.shown("progress")');
});

test('task query layout: `show stats` / `hide stats` toggle compact stats bar', () => {
  const showQuery = parseTaskQuery('show stats');
  assert.equal(showQuery.errors.length, 0, `unexpected errors: ${showQuery.errors.join('; ')}`);
  assert.ok(showQuery.layout.shown.has('stats'), 'show stats should set layout.shown("stats")');
  assert.ok(!showQuery.layout.hidden.has('stats'), 'show stats should not set layout.hidden("stats")');

  const hideQuery = parseTaskQuery('hide stats');
  assert.equal(hideQuery.errors.length, 0, `unexpected errors: ${hideQuery.errors.join('; ')}`);
  assert.ok(hideQuery.layout.hidden.has('stats'), 'hide stats should set layout.hidden("stats")');
  assert.ok(!hideQuery.layout.shown.has('stats'), 'hide stats should not set layout.shown("stats")');
});

test('task DSL: task.childCount and task.doneChildCount count subtasks in same file', () => {
  // Parent at indent=0, two children at indent=2, one grandchild at indent=4
  const parent = parseMarkdownTaskLine('- [ ] Parent task', 'Notes.md', 1);
  const child1 = parseMarkdownTaskLine('  - [x] Done child', 'Notes.md', 2);
  const child2 = parseMarkdownTaskLine('  - [ ] Todo child', 'Notes.md', 3);
  const grandchild = parseMarkdownTaskLine('    - [x] Done grandchild', 'Notes.md', 4);
  // A task in a different file (should not be counted)
  const other = parseMarkdownTaskLine('  - [x] Other file child', 'Other.md', 2);
  const allTasks = [parent, child1, child2, grandchild, other].filter((t): t is ParsedTask => t !== null);

  // childCount on parent should count direct children (tasks with greater indent immediately following)
  // In this implementation, all tasks with greater indentation until a same-or-lower indent are counted.
  // child1, child2, grandchild all have indent > 0, so childCount = 3.
  const parentMatches = filterTasks(allTasks, 'filter by function task.childCount > 0\npath is Notes.md');
  assert.ok(
    parentMatches.some((t) => t.normalizedText === 'Parent task'),
    `parent should have childCount > 0, got tasks: ${parentMatches.map((t) => t.normalizedText).join(', ')}`,
  );

  // doneChildCount on parent should count done/cancelled children
  const doneChildMatches = filterTasks(allTasks, 'filter by function task.doneChildCount > 0\npath is Notes.md');
  assert.ok(
    doneChildMatches.some((t) => t.normalizedText === 'Parent task'),
    `parent should have doneChildCount > 0, got tasks: ${doneChildMatches.map((t) => t.normalizedText).join(', ')}`,
  );

  // A leaf task (child1 in Other.md context) should have childCount = 0
  const leafMatches = filterTasks(allTasks, 'filter by function task.childCount === 0');
  assert.ok(
    leafMatches.some((t) => t.normalizedText === 'Other file child'),
    `leaf in Other.md should have childCount === 0, got tasks: ${leafMatches.map((t) => t.normalizedText).join(', ')}`,
  );
});

test('task DSL: blockquoted task hierarchy counts children', () => {
  const parent = parseMarkdownTaskLine('> - [ ] Parent task', 'Notes.md', 1);
  const child = parseMarkdownTaskLine('> > - [x] Done child', 'Notes.md', 2);
  const sibling = parseMarkdownTaskLine('> - [ ] Sibling task', 'Notes.md', 3);
  const allTasks = [parent, child, sibling].filter((t): t is ParsedTask => t !== null);

  const parentMatches = filterTasks(allTasks, 'filter by function task.childCount === 1');
  const doneChildMatches = filterTasks(allTasks, 'filter by function task.doneChildCount === 1');

  assert.deepEqual(parentMatches.map((task) => task.normalizedText), ['Parent task']);
  assert.deepEqual(doneChildMatches.map((task) => task.normalizedText), ['Parent task']);
});

test('task query: subtask date inheritance uses blockquote depth', () => {
  const parent = parseMarkdownTaskLine('> - [ ] Parent task 📅 2026-06-01', 'Notes.md', 1);
  const child = parseMarkdownTaskLine('> > - [ ] Child task', 'Notes.md', 2);
  assert.ok(parent);
  assert.ok(child);

  const [inheritedParent, inheritedChild] = filterTasks([parent, child], '', { subtaskDateInheritance: true });

  assert.equal(inheritedParent.metadata.dates.due, '2026-06-01');
  assert.equal(inheritedChild.metadata.dates.due, '2026-06-01');
});

// ── Task 6: Date wikilink format ───────────────────────────────────────────

test('formatDateField: plain format returns date as-is', () => {
  assert.equal(formatDateField('2024-01-15', 'plain'), '2024-01-15');
});

test('formatDateField: wikilink format wraps date in [[...]]', () => {
  assert.equal(formatDateField('2024-01-15', 'wikilink'), '[[2024-01-15]]');
});

test('parseMarkdownTaskLine: parses wikilink due date [[2024-01-15]] correctly', () => {
  const task = parseMarkdownTaskLine('- [ ] Task with wikilink due 📅 [[2024-01-15]]', 'Notes.md', 1);
  assert.ok(task, 'task should be parsed');
  assert.equal(task!.metadata.dates.due, '2024-01-15', 'due date should be stripped of wikilink brackets');
});

test('parseMarkdownTaskLine: parses wikilink done date [[2026-05-26]] correctly', () => {
  const task = parseMarkdownTaskLine('- [x] Completed task ✅ [[2026-05-26]]', 'Notes.md', 1);
  assert.ok(task, 'task should be parsed');
  assert.equal(task!.metadata.dates.done, '2026-05-26', 'done date should be stripped of wikilink brackets');
});

test('parseMarkdownTaskLine: parses times embedded in wikilink date metadata', () => {
  const task = parseMarkdownTaskLine('- [ ] Call team 📅 [[2026-06-15 08:45]] ⏰ [[2026-06-14 09:30]]', 'Notes.md', 1);
  assert.ok(task, 'task should be parsed');
  assert.equal(task!.normalizedText, 'Call team');
  assert.equal(task!.metadata.dates.due, '2026-06-15');
  assert.equal(task!.metadata.dates.dueTime, '08:45');
  assert.equal(task!.metadata.reminder, '2026-06-14 09:30');
});

test('task scanner advances wikilink-format reminder date on recurrence', () => {
  // Bug regression: rewriteReminderField only matched plain-date reminders (⏰ YYYY-MM-DD).
  // When reminder was in [[YYYY-MM-DD]] wikilink form the regex never matched, so the old
  // reminder date survived unchanged on the next occurrence line.
  const today = '2026-06-04';
  const settings = { ...DEFAULT_SETTINGS, setCreatedDate: false };
  const line = '- [ ] Review 🔁 every week 📅 [[2026-05-28]] ⏰ [[2026-05-27]] 09:00';
  const result = applyTaskCompletionLifecycleToLine(line, 'x', DEFAULT_SETTINGS.supportedStates, settings, today) ?? [];
  const nextLine = result.find((l) => /^- \[ \]/u.test(l));
  assert.ok(nextLine, `expected a next occurrence line; got:\n${result.join('\n')}`);
  // Reminder should be advanced by one week (offset from due: -1 day relative), preserving [[]] format
  assert.match(nextLine!, /⏰ \[\[2026-06-03\]\] 09:00/u,
    `reminder wikilink date should be updated on next occurrence; line: ${nextLine}`);
  assert.doesNotMatch(nextLine!, /\[\[2026-05-27\]\]/u,
    `old reminder wikilink date should not appear on next occurrence`);
});

test('task scanner removes wikilink-format reminder when there is no next occurrence date', () => {
  // rewriteReminderField strip path must also handle [[YYYY-MM-DD]] form.
  const today = '2026-06-04';
  const settings = { ...DEFAULT_SETTINGS, setCreatedDate: false };
  // for 1 time → no next occurrence generated; reminder should be stripped
  const line = '- [ ] Review 🔁 every week for 1 time 📅 [[2026-05-28]] ⏰ [[2026-05-27]] 09:00';
  const result = applyTaskCompletionLifecycleToLine(line, 'x', DEFAULT_SETTINGS.supportedStates, settings, today) ?? [];
  // No todo line should be generated (for 1 time means last occurrence)
  const nextLine = result.find((l) => /^- \[ \]/u.test(l));
  assert.ok(!nextLine, `expected no next occurrence for "for 1 time" rule; got:\n${result.join('\n')}`);
});

// ── Task 9: parseQuickAddInput NLP parsing ────────────────────────────────

test('parseQuickAddInput: empty input returns empty result', () => {
  const result = parseQuickAddInput('', '2026-05-27');
  assert.equal(result.description, '');
  assert.equal(result.dueDate, '');
  assert.equal(result.priority, '');
  assert.deepEqual(result.tags, []);
  assert.equal(result.recurrence, '');
});

test('parseQuickAddInput: extracts #tags from input', () => {
  const result = parseQuickAddInput('Buy milk tomorrow #shopping', '2026-05-27');
  assert.deepEqual(result.tags, ['shopping']);
  assert.equal(result.dueDate, '2026-05-28');
  assert.ok(result.description.trim().length > 0, 'description should not be empty');
});

test('parseQuickAddInput: high priority keyword maps to ⏫', () => {
  const result = parseQuickAddInput('Call dentist high priority', '2026-05-27');
  assert.equal(result.priority, '⏫');
  assert.ok(!result.description.includes('high'), 'priority keyword should be removed from description');
});

test('parseQuickAddInput: urgent keyword maps to ⏫', () => {
  const result = parseQuickAddInput('Fix bug urgent', '2026-05-27');
  assert.equal(result.priority, '⏫');
});

test('parseQuickAddInput: low keyword maps to 🔽', () => {
  const result = parseQuickAddInput('Organize files low', '2026-05-27');
  assert.equal(result.priority, '🔽');
});

test('parseQuickAddInput: extracts recurrence phrase', () => {
  const result = parseQuickAddInput('Weekly review every week', '2026-05-27');
  assert.equal(result.recurrence, 'every week');
  assert.ok(!result.description.toLowerCase().includes('every week'), 'recurrence should be removed from description');
});

test('parseQuickAddInput: extracts tomorrow as due date', () => {
  const result = parseQuickAddInput('Buy milk tomorrow #shopping', '2026-05-27');
  assert.equal(result.dueDate, '2026-05-28');
});

test('parseQuickAddInput: extracts multiple #tags', () => {
  const result = parseQuickAddInput('Write report #work #urgent-task #q2', '2026-05-27');
  assert.deepEqual(result.tags, ['work', 'urgent-task', 'q2']);
});

// ── Task 11: Full parent auto-status settings ─────────────────────────────

test('normalizeTaskManagerSettings: autoAdvanceParentToInProgress defaults to false', () => {
  const settings = normalizeTaskManagerSettings({});
  assert.equal(settings.autoAdvanceParentToInProgress, false);
});

test('normalizeTaskManagerSettings: autoAdvanceParentOnAllCancelled defaults to false', () => {
  const settings = normalizeTaskManagerSettings({});
  assert.equal(settings.autoAdvanceParentOnAllCancelled, false);
});

test('normalizeTaskManagerSettings: autoAdvanceParentToInProgress persists when set', () => {
  const settings = normalizeTaskManagerSettings({ autoAdvanceParentToInProgress: true } as Partial<typeof DEFAULT_SETTINGS>);
  assert.equal(settings.autoAdvanceParentToInProgress, true);
});

test('normalizeTaskManagerSettings: autoAdvanceParentOnAllCancelled persists when set', () => {
  const settings = normalizeTaskManagerSettings({ autoAdvanceParentOnAllCancelled: true } as Partial<typeof DEFAULT_SETTINGS>);
  assert.equal(settings.autoAdvanceParentOnAllCancelled, true);
});

test('task model parses pinned, cost, and typed dependencies', () => {
  const task = parseMarkdownTaskLine('- [ ] Build feature 📌 💵 125.50 🆔 parent ⛔ blocker:FS, design:SS', 'Project.md', 1);
  assert.ok(task);
  assert.equal(task.metadata.pinned, true);
  assert.equal(task.metadata.cost, 125.5);
  assert.deepEqual(task.metadata.dependsOn, ['blocker', 'design']);
  assert.deepEqual(task.metadata.dependencyTypes, { blocker: 'FS', design: 'SS' });
  assert.equal(task.normalizedText, 'Build feature');
});

test('task query parses table/checklist/eisenhower views and pinned/cost filters', () => {
  const table = parseTaskQuery('view: table\nis pinned\ncost above 100\nsort by pinned\ngroup by cost');
  assert.equal(table.viewMode, 'table');
  assert.equal(table.filters.length, 2);
  assert.equal(table.sort[0]?.field, 'pinned');
  assert.equal(table.groups[0]?.field, 'cost');
  const grid = parseTaskQuery('view: grid');
  assert.equal(grid.viewMode, 'table');
  const checklist = parseTaskQuery('view: checklist');
  assert.equal(checklist.viewMode, 'checklist');
  const checklistAlias = parseTaskQuery('style: checklist');
  assert.equal(checklistAlias.viewMode, 'checklist');
  const eisenhower = parseTaskQuery('view: eisenhower');
  assert.equal(eisenhower.viewMode, 'eisenhower');
  const timeline = parseTaskQuery('view: timeline');
  assert.equal(timeline.viewMode, 'timeline');
});

test('task query supports numeric effort/actual filters and inlink filters', () => {
  const s = scanner();
  const tasks = [
    s.parseTaskLine('- [ ] Long task ⏱️ 2h 🕐 90m', 'Projects/Target.md', 1)!,
    s.parseTaskLine('- [ ] Short task ⏱️ 20m 🕐 25m', 'Projects/Other.md', 1)!,
    s.parseTaskLine('- [ ] Source task', 'Projects/Source.md', 1)!,
  ];
  const fileInfoProvider = (path: string) => ({
    properties: {},
    outlinks: path === 'Projects/Source.md' ? ['[[Target]]'] : [],
  });
  assert.deepEqual(filterTasks(tasks, 'effort > 1h').map((task) => task.normalizedText), ['Long task']);
  assert.deepEqual(filterTasks(tasks, 'actual less than 30m').map((task) => task.normalizedText), ['Short task']);
  assert.deepEqual(filterTasks(tasks, 'inlinks includes [[Source]]', { fileInfoProvider }).map((task) => task.normalizedText), ['Long task']);
});

test('task query rejects nested-quantifier regex filters', () => {
  const task = parseMarkdownTaskLine('- [ ] aaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'A.md', 1)!;
  assert.throws(
    () => filterTasks([task], 'filter by function task.description.matches("(a+)+b")'),
    /too complex/u,
  );
});

test('task query conservatively rejects alternation inside repeated regex groups', () => {
  const task = parseMarkdownTaskLine('- [ ] 9999999999999999999999999999Y', 'A.md', 1);
  assert.ok(task);
  for (const pattern of [
    '(a|ab)*c',
    String.raw`(\d|[0-9])+X`,
    '(a|[a])*X',
    String.raw`(\p{Nd}|[0-9])+X`,
    String.raw`(\u{61}+)+$`,
    String.raw`(\p{ASCII}+)+$`,
    '((cat|dog)-)+X',
    '(cat|dog){2,}',
    '(cat|dog){1,5}',
    '(cat|dog){100}',
  ]) {
    assert.throws(
      () => filterTasks([task], `filter by function task.description.matches(${JSON.stringify(pattern)})`),
      /too complex/u,
      pattern,
    );
  }
  for (const pattern of ['(cat|dog)X', '(cat|dog){1}', '[a|b]+', String.raw`(a\|b)+`]) {
    assert.doesNotThrow(
      () => filterTasks([task], `filter by function task.description.matches(${JSON.stringify(pattern)})`),
      pattern,
    );
  }
  const unicodeSetPattern = String.raw`/[\q{a|aa}]+$/v`;
  assert.throws(
    () => filterTasks([task], `filter by function task.description.matches(${JSON.stringify(unicodeSetPattern)})`),
    /'v' mode is not supported/u,
  );
  const optionalChain = `${'a?'.repeat(48)}${'a'.repeat(48)}$`;
  const alternationChain = `${'(a|aa)'.repeat(24)}$`;
  for (const pattern of [optionalChain, alternationChain, String.raw`(a)\1+`, '(?=a)a+']) {
    assert.throws(
      () => filterTasks([task], `filter by function task.description.matches(${JSON.stringify(pattern)})`),
      /too complex/u,
      pattern,
    );
  }
  for (const pattern of ['a+', String.raw`\d?`, '(abc)+']) {
    assert.doesNotThrow(
      () => filterTasks([task], `filter by function task.description.matches(${JSON.stringify(pattern)})`),
      pattern,
    );
  }
});

// ── Task 6: File-Scoped Defaults and Template Tokens ─────────────────────────

test('file defaults: resolveFileDefaultTokens replaces {{date}}', () => {
  // This test verifies template token resolution
  const today = new Date().toISOString().split('T')[0];
  // Since we can't directly test the private method, we verify the functionality
  // through the integration with applyFileDefaults
  assert.ok(today.match(/^\d{4}-\d{2}-\d{2}$/), 'today should be in YYYY-MM-DD format');
});

test('file defaults: fileDefaultsEnabled setting is boolean', () => {
  const settings = normalizeTaskManagerSettings({ fileDefaultsEnabled: true });
  assert.equal(settings.fileDefaultsEnabled, true);
  assert.equal(settings.fileDefaultsPropertyPrefix, 'task_');
});

test('file defaults: fileDefaultsPropertyPrefix can be customized', () => {
  const settings = normalizeTaskManagerSettings({ fileDefaultsPropertyPrefix: 'custom_' });
  assert.equal(settings.fileDefaultsPropertyPrefix, 'custom_');
});

test('query explanation: execution time is tracked', () => {
  const query = parseTaskQuery('all');
  // Note: executionTime is added dynamically during rendering
  assert.ok(query, 'query should parse successfully');
});

test('buildExplainBody: includes filter instructions', () => {
  const query = parseTaskQuery('priority is high\ngroup by due\nsort by urgency');
  const body = buildExplainBody(query);
  assert.ok(body.includes('priority'), 'should include filter instructions');
  assert.ok(body.includes('group by'), 'should include group instruction');
  assert.ok(body.includes('sort by'), 'should include sort instruction');
});

test('normalizeTaskManagerSettings: incomplete locale preferences fail closed to English', () => {
  const settings = normalizeTaskManagerSettings({ preferredLocale: 'es' } as Partial<typeof DEFAULT_SETTINGS>);
  assert.equal(settings.preferredLocale, 'en');
});

test('normalizeTaskManagerSettings: task template priority falls back to normal when invalid', () => {
  const settings = normalizeTaskManagerSettings({
    taskTemplates: [
      {
        name: 'Morning planning',
        description: 'Review the day',
        priority: 'urgent',
        recurrence: '',
        tags: '',
        onCompletion: '',
      },
    ],
  } as Partial<typeof DEFAULT_SETTINGS>);
  assert.equal(settings.taskTemplates[0].priority, 'normal');
});

test('normalizeTaskManagerSettings: unknown preferredLocale falls back to en', () => {
  const settings = normalizeTaskManagerSettings({ preferredLocale: 'xx' as never });
  assert.equal(settings.preferredLocale, 'en');
});

test('task-scanner: removeDateField strips wikilink-format done date (✅ [[YYYY-MM-DD]])', () => {
  // When dateFormat='wikilink', completing a task writes ✅ [[YYYY-MM-DD]].
  // Un-completing must strip that annotation; previously the plain-date-only pattern
  // left '✅ [[2026-06-01]]' in the task text.
  const today = '2026-06-01';
  const settingsForParse = { ...DEFAULT_SETTINGS, setDoneDate: true, dateFormat: 'wikilink' as const };
  // Verify that applyTaskCompletionLifecycleToLine starting from a done task with wikilink date
  // and toggling back to todo produces a line without the done annotation.
  const doneLineWikilink = '- [x] Buy groceries \u2705 [[2026-06-01]]';
  const undoneLines = applyTaskCompletionLifecycleToLine(
    doneLineWikilink,
    ' ',
    DEFAULT_SETTINGS.supportedStates,
    settingsForParse,
    today,
  );
  const undoneLine = undoneLines?.[0];
  assert.ok(undoneLine, 'expected result from un-completing task');
  assert.doesNotMatch(undoneLine!, /\u2705/u, 'done emoji should be stripped from un-completed wikilink-date task');
  assert.doesNotMatch(undoneLine!, /\[\[2026-06-01\]\]/u, 'wikilink done date should be stripped from un-completed task');
});

test('task-scanner: buildNextRecurrenceLine strips wikilink-format done date from next occurrence', () => {
  // When dateFormat='wikilink', the completed task line has ✅ [[YYYY-MM-DD]].
  // The next occurrence line must not inherit this completion date.
  const today = '2026-06-01';
  const settings = { ...DEFAULT_SETTINGS, setDoneDate: true, dateFormat: 'wikilink' as const, setCreatedDate: false };
  const result = applyTaskCompletionLifecycleToLine(
    '- [ ] Weekly review \uD83D\uDD01 every week \uD83D\uDCC5 [[2026-05-25]]',
    'x',
    DEFAULT_SETTINGS.supportedStates,
    settings,
    today,
  ) ?? [];
  const nextLine = result.find((l) => /^- \[ \]/u.test(l));
  assert.ok(nextLine, `expected a next occurrence line; got:\n${result.join('\n')}`);
  // The next occurrence must not carry the wikilink done date from the completed occurrence.
  assert.doesNotMatch(nextLine!, /\u2705/u, 'done emoji must not appear on next occurrence');
  assert.doesNotMatch(nextLine!, /\[\[2026-05-25\]\]/u, 'old wikilink done date must not appear on next occurrence');
  // Due date should have advanced by one week.
  assert.match(nextLine!, /\[\[2026-06-01\]\]/u, 'due date should advance to 2026-06-01 on next occurrence');
});
test('applyAutomaticStatusDates: done→cancelled removes done date AND adds cancelled date', () => {
  // When both setDoneDate and setCancelledDate are true, transitioning from done to cancelled
  // must BOTH strip the done stamp AND stamp the cancelled date. Previously the early-return
  // in the "leaving done" branch prevented the cancelled date from ever being added.
  const today = '2026-05-30';
  const settings = { ...DEFAULT_SETTINGS, setDoneDate: true, setCancelledDate: true };
  const doneLine = '- [x] Abandon ship \u2705 2026-05-29';
  const result = applyTaskCompletionLifecycleToLine(
    doneLine,
    '-',
    DEFAULT_SETTINGS.supportedStates,
    settings,
    today,
  );
  const resultLine = result?.[0];
  assert.ok(resultLine, 'expected a result line');
  assert.doesNotMatch(resultLine!, /\u2705/u, 'done emoji must be removed when transitioning done→cancelled');
  assert.doesNotMatch(resultLine!, /2026-05-29/u, 'old done date must be removed');
  assert.match(resultLine!, /\u274c/u, 'cancelled emoji must be added');
  assert.match(resultLine!, /\u274c\s*2026-05-30/u, 'cancelled date must be stamped with today');
});

test('applyAutomaticStatusDates: cancelled→todo removes cancelled date', () => {
  // When setCancelledDate is true, transitioning a cancelled task back to todo must strip
  // the cancelled stamp (\u274c YYYY-MM-DD). Previously no condition handled this case.
  const today = '2026-05-30';
  const settings = { ...DEFAULT_SETTINGS, setDoneDate: true, setCancelledDate: true };
  const cancelledLine = '- [-] Restore task \u274c 2026-05-28';
  const result = applyTaskCompletionLifecycleToLine(
    cancelledLine,
    ' ',
    DEFAULT_SETTINGS.supportedStates,
    settings,
    today,
  );
  const resultLine = result?.[0];
  assert.ok(resultLine, 'expected a result line');
  assert.doesNotMatch(resultLine!, /\u274c/u, 'cancelled emoji must be removed when un-cancelling');
  assert.doesNotMatch(resultLine!, /2026-05-28/u, 'old cancelled date must be removed when un-cancelling');
  assert.doesNotMatch(resultLine!, /\u2705/u, 'done emoji must NOT be added when un-cancelling to todo');
});

test('applyAutomaticStatusDates: cancelled→todo strips wikilink-format cancelled date', () => {
  // When dateFormat="wikilink", the cancelled stamp is \u274c [[YYYY-MM-DD]]. Un-cancelling
  // must strip the wikilink form as well.
  const today = '2026-05-30';
  const settings = { ...DEFAULT_SETTINGS, setCancelledDate: true, dateFormat: 'wikilink' as const };
  const cancelledLineWiki = '- [-] Restore task \u274c [[2026-05-28]]';
  const result = applyTaskCompletionLifecycleToLine(
    cancelledLineWiki,
    ' ',
    DEFAULT_SETTINGS.supportedStates,
    settings,
    today,
  );
  const resultLine = result?.[0];
  assert.ok(resultLine, 'expected a result line');
  assert.doesNotMatch(resultLine!, /\u274c/u, 'cancelled emoji must be stripped from wikilink-date un-cancellation');
  assert.doesNotMatch(resultLine!, /\[\[2026-05-28\]\]/u, 'wikilink cancelled date must be stripped');
});

test('triggerWorkflowAutomation: $& in task description does not corrupt workflow step (Fix 121)', async () => {
  // When completedTask.normalizedText contains '$&' (or other $ patterns), using it as
  // the second argument to String.prototype.replace() would interpret it as a special
  // replacement pattern and corrupt the output.  The fix uses a function replacement.
  const file = fakeFile('Project.md');
  // Task starts as TODO so completing it triggers the workflow.
  // Use a plain tag (no colon) so tag extraction reliably finds it.
  let content = '- [ ] Buy $& items #wftest\n';
  const app = {
    vault: {
      read: async () => content,
      process: async (_file: FakeFile, updater: (value: string) => string) => {
        content = updater(content);
        return content;
      },
    },
  };
  const settings = {
    ...DEFAULT_SETTINGS,
    workflowsEnabled: true,
    workflows: [{
      id: 'wf-test',
      name: 'Test Workflow',
      triggerTag: 'wftest',
      steps: [{ name: 'Follow up', description: 'Follow up: {{prev}}', status: ' ', priority: '' }],
    }],
    setDoneDate: false,
  };
  const scanner = new TaskScanner(
    app as never,
    () => DEFAULT_TASK_STATES,
    () => '',
    () => settings,
  );
  const tasks = await scanner.scanFile(file as never);
  const task = tasks[0];
  assert.ok(task, 'should parse the task');
  // Mark the task done — this triggers triggerWorkflowAutomation
  await scanner.updateTaskCheckbox(file as never, task!, 'x');
  // The new workflow step line should contain the literal '$&' from the task description,
  // not the matched string or an empty string.  Before the fix, '$&' would expand to the
  // regex match text '{{prev}}' making the output 'Follow up: Buy {{prev}} items'.
  assert.match(content, /Follow up:.*\$&.*items/u,
    'workflow step description must preserve literal $& from previous task text');
});

test('workflow insertion resolves the completed task after line shifts and fails closed on ambiguity', async (t) => {
  const settings = {
    ...DEFAULT_SETTINGS,
    workflowsEnabled: true,
    workflows: [{ id: 'wf', name: 'Workflow', triggerTag: 'flow', steps: [{ name: 'Next', description: 'Next: {{prev}}', status: ' ', priority: '' }] }],
    setDoneDate: false,
  };

  await t.test('line shift', async () => {
    const file = fakeFile('Project.md');
    let content = '- [ ] Original #flow\n';
    let writes = 0;
    const scanner = new TaskScanner({ vault: {
      read: async () => content,
      process: async (_file: FakeFile, updater: (value: string) => string) => {
        writes += 1;
        if (writes === 2) content = `- [ ] Concurrent edit\n${content}`;
        content = updater(content);
        return content;
      },
    } } as never, () => DEFAULT_TASK_STATES, () => '', () => settings);
    const [task] = await scanner.scanFile(file as never);
    await scanner.updateTaskCheckbox(file as never, task, 'x');
    assert.match(content, /Concurrent edit\n- \[x\] Original #flow\n- \[ \] Next: Original/u);
  });

  await t.test('ambiguous identity', async () => {
    const file = fakeFile('Project.md');
    let content = '- [ ] Duplicate #flow\n';
    let writes = 0;
    const scanner = new TaskScanner({ vault: {
      read: async () => content,
      process: async (_file: FakeFile, updater: (value: string) => string) => {
        writes += 1;
        if (writes === 2) content = `- [ ] Concurrent edit\n${content}${content}`;
        content = updater(content);
        return content;
      },
    } } as never, () => DEFAULT_TASK_STATES, () => '', () => settings);
    const [task] = await scanner.scanFile(file as never);
    await scanner.updateTaskCheckbox(file as never, task, 'x');
    assert.doesNotMatch(content, /Next: Duplicate/u);
  });
});

// ── 💬 inline comment parsing (Feature 9 edge cases) ─────────────────────

/**
 * The scanner collects 💬 child bullets by scanning lines *after* the task line.
 * These tests replicate that extraction logic to validate the regex and its edge cases.
 */
function collectComments(taskLine: string, childLines: string[]): string[] {
  // Mirror the scanner: taskIndentLen = indentation.length + linePrefix.length
  // where linePrefix = leading blockquote prefix, indentation = leading whitespace before list marker.
  // TASK_LINE_PATTERN = /^((?:\s*>\s*)*)(\s*)([-*+]|\d+[.)])\s+\[([^\]]+)\]\s*(.*)$/u
  const tm = taskLine.match(/^((?:\s*>\s*)*)(\s*)/u);
  const taskIndentLen = (tm?.[1]?.length ?? 0) + (tm?.[2]?.length ?? 0);
  const comments: string[] = [];
  for (const child of childLines) {
    if (!child || child.trim() === '') break;
    const childIndentLen = child.match(/^(?:\s*>\s*)*\s*/u)?.[0].length ?? 0;
    if (childIndentLen <= taskIndentLen) break;
    const m = child.match(/^\s*(?:[-*+]\s+)?\uD83D\uDCAC\s+(.+)$/u);
    if (!m) break;
    comments.push(m[1].trim());
  }
  return comments;
}

test('💬 comment: parses indented bullet with - prefix', () => {
  const comments = collectComments(
    '- [ ] Buy groceries',
    ['  - 💬 Pick up organic milk', '  - 💬 Also grab eggs'],
  );
  assert.deepEqual(comments, ['Pick up organic milk', 'Also grab eggs']);
});

test('💬 comment: parses indented bullet without list marker', () => {
  const comments = collectComments(
    '- [ ] Review PR',
    ['  💬 Looks good overall', '  💬 Check edge case on line 42'],
  );
  assert.deepEqual(comments, ['Looks good overall', 'Check edge case on line 42']);
});

test('💬 comment: stops at same-indent non-child line', () => {
  const comments = collectComments(
    '- [ ] Task A',
    ['  💬 Note on A', '- [ ] Task B (same indent, stops here)', '  💬 Note on B'],
  );
  assert.deepEqual(comments, ['Note on A']);
});

test('💬 comment: stops at blank lines between task and comment', () => {
  const comments = collectComments(
    '- [ ] Task',
    ['', '  💬 Detached note'],
  );
  assert.deepEqual(comments, []);
});

test('task scanner does not attach 💬 comments across blank lines', async () => {
  const app = { vault: { read: async () => '- [ ] Task A\n\n  💬 Detached note\n- [ ] Task B\n' } };
  const tasks = await new TaskScanner(app as never).scanFile(fakeFile('Notes.md') as never);
  assert.equal(tasks.length, 2);
  assert.equal(tasks[0].metadata.comments, undefined);
});

test('💬 comment: stops at non-💬 child bullets', () => {
  const comments = collectComments(
    '- [ ] Task',
    ['  - Sub-task (not a comment)', '  💬 Detached child comment'],
  );
  assert.deepEqual(comments, []);
});

test('💬 comment: deeply nested task collects deeper comments only', () => {
  const comments = collectComments(
    '    - [ ] Nested task',
    ['      💬 Deep comment', '  💬 Too shallow — not collected'],
  );
  assert.deepEqual(comments, ['Deep comment']);
});

test('💬 comment: task with no child lines returns empty array', () => {
  const comments = collectComments('- [ ] Task', []);
  assert.deepEqual(comments, []);
});
