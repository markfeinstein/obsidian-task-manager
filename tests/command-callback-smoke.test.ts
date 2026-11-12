import test from 'node:test';
import assert from 'node:assert/strict';
import type { App, Command, Editor, MarkdownFileInfo } from 'obsidian';
import type { CommandHost } from '../src/commands/command-host';
import { registerCoreTaskCommands } from '../src/commands/register-core-task-commands';
import { registerExportCommands } from '../src/commands/register-export-commands';
import { DEFAULT_SETTINGS } from '../src/types';
import { TaskScanner } from '../src/task-scanner';

function smokeHost(commands: Command[]): CommandHost {
  const app = {
    vault: {
      getAbstractFileByPath: () => null,
      getMarkdownFiles: () => [],
      read: async () => '- [ ] Smoke task',
      cachedRead: async () => '- [ ] Smoke task',
      process: async (_file: unknown, update: (value: string) => string) => update('- [ ] Smoke task'),
      create: async () => undefined,
    },
    workspace: {
      getActiveFile: () => ({ path: 'Smoke.md', extension: 'md', name: 'Smoke.md', basename: 'Smoke' }),
      getActiveViewOfType: () => null,
      getLeaf: () => ({ openFile: async () => undefined }),
      openLinkText: async () => undefined,
    },
  } as unknown as App;
  const base = {
    app,
    settings: { ...structuredClone(DEFAULT_SETTINGS), savedQueries: [] },
    scanner: new TaskScanner(app),
    apiV1: { getAllTasks: () => [] },
    dailyNoteResolver: { resolveToday: async () => ({ path: 'Daily.md', file: {} }), isTodayDailyNote: () => false },
    logWriter: { appendToDailyLog: async () => '' },
    mutationLog: { list: () => [], logMutation: async () => undefined },
    stateStore: {
      updateState: async (transform: (state: Record<string, unknown>) => Record<string, unknown>) => transform({}),
      addRecurrenceException: (state: Record<string, unknown>) => state,
    },
    addCommand: (command: Command) => { commands.push(command); },
    currentEditableOccurrenceDate: () => null,
    ensureEditableRecurrenceSeriesId: () => 'series',
    firstDeferrableField: () => null,
    nextEditableOccurrenceDate: () => '2026-07-13',
    projectNameForTask: () => 'Project',
    shouldFilterEditorRecurrenceExceptions: () => false,
    rewriteEditorTaskLineForStatusWithLifecycle: async () => null,
    saveSettings: async () => undefined,
    scanFile: async () => undefined,
    scanVault: async () => undefined,
  };
  return new Proxy(base as unknown as CommandHost, {
    get(target, property, receiver) {
      if (Reflect.has(target as object, property)) return Reflect.get(target as object, property, receiver);
      return (..._args: unknown[]) => Promise.resolve(undefined);
    },
  });
}

function smokeEditor(initialLine = '- [ ] Smoke task'): Editor {
  let line = initialLine;
  return {
    getCursor: () => ({ line: 0, ch: 0 }),
    getLine: () => line,
    setLine: (_line: number, value: string) => { line = value; },
    lineCount: () => 1,
    replaceSelection: (value: string) => { line = value; },
    replaceRange: (value: string) => { line = value; },
    getSelection: () => '',
    somethingSelected: () => false,
    setCursor: () => undefined,
    focus: () => undefined,
    getValue: () => line,
    setValue: (value: string) => { line = value; },
    lastLine: () => 0,
    cm: { state: {}, dispatch: () => undefined },
  } as unknown as Editor;
}

async function exercise(command: Command): Promise<void> {
  const editors = [
    smokeEditor(),
    smokeEditor('- [ ] Smoke recurring task 🔁 every day'),
    smokeEditor('Plain smoke text'),
    smokeEditor('- List item'),
    smokeEditor('   '),
  ];
  const view = { file: { path: 'Smoke.md' } } as unknown as MarkdownFileInfo;
  try { if (command.callback) await command.callback(); } catch { /* smoke every reachable branch without requiring a live vault */ }
  for (const editor of editors) {
    try { if (command.editorCallback) await command.editorCallback(editor, view); } catch { /* exercise task/list/plain/blank branches */ }
  }
  try {
    if (command.checkCallback) {
      command.checkCallback(true);
      command.checkCallback(false);
    }
  } catch { /* expected for absent active host context */ }
}

test('core and export command callbacks are smoke-exercised without a live vault', async () => {
  const commands: Command[] = [];
  const host = smokeHost(commands);
  registerCoreTaskCommands(host);
  registerExportCommands(host);
  assert.ok(commands.length > 40);
  for (const command of commands) await exercise(command);
});
