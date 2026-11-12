import test from 'node:test';
import assert from 'node:assert/strict';
import { TFile } from 'obsidian';
import { DailyPlannerModal } from '../src/modals/daily-planner-modal';
import { DEFAULT_SETTINGS } from '../src/types';
import { todayString } from '../src/date-utils';

test('DailyPlannerModal moves newly scheduled backlog tasks into today plan state', async () => {
  const file = Object.assign(new TFile(), {
    path: 'Tasks.md',
    basename: 'Tasks',
    extension: 'md',
    name: 'Tasks.md',
  });
  let content = '- [ ] Review docs';
  const app = {
    vault: {
      getAbstractFileByPath(path: string) {
        return path === file.path ? file : null;
      },
      async process(_file: TFile, updater: (content: string) => string) {
        content = updater(content);
      },
    },
  } as any;

  const modal = new DailyPlannerModal(app, DEFAULT_SETTINGS, {} as any, {} as any);
  (modal as any).app = app;
  (modal as any).renderPhase = () => {};

  const task = {
    key: 'task-1',
    filePath: file.path,
    lineNumber: 1,
    normalizedText: 'Review docs',
    metadata: { dates: {} },
  } as any;

  (modal as any).backlogTasks = [task];
  (modal as any).todayTasks = [];

  await (modal as any).scheduleTaskToday(task);

  assert.equal((modal as any).backlogTasks.length, 0);
  assert.equal((modal as any).todayTasks.length, 1);
  assert.equal((modal as any).todayTasks[0].key, task.key);
  assert.equal((modal as any).todayTasks[0].metadata.dates.scheduled, todayString());
  assert.match(content, new RegExp(`⏳ ${todayString()}$`, 'u'));
});
