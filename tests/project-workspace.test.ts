import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createDefaultWorkspace,
  generateWorkspaceMarkdown,
  generateWorkspaceViews,
  parseWorkspaceMarkdown,
  refreshWorkspaceMarkdown,
} from '../src/project-workspace';
import { filterTasks, parseTaskQuery } from '../src/task-query';
import type { ParsedTask } from '../src/task-scanner';
import { DEFAULT_SETTINGS } from '../src/types';
import { createMockTask, getTodayString } from './test-utils';

test('project workspace: duplicate query headings get unique view ids', () => {
  const workspace = parseWorkspaceMarkdown(`---
task-manager-workspace: true
name: Demo
---

## Queries

### Inbox

query: \`status: todo\`

### Inbox

query: \`status: done\`
`);

  assert.deepEqual(workspace.queries.map((query) => query.id), ['inbox', 'inbox-2']);

  const todoTask = { key: 'todo', checkbox: ' ', body: 'Open task' } as ParsedTask;
  const doneTask = { key: 'done', checkbox: 'x', body: 'Closed task' } as ParsedTask;
  const views = generateWorkspaceViews(workspace, [todoTask, doneTask], (query, tasks) =>
    query === 'status: todo' ? [tasks[0]] : [tasks[1]],
  );

  assert.equal(views.size, 2);
  assert.match(views.get('inbox') ?? '', /Open task/u);
  assert.match(views.get('inbox-2') ?? '', /Closed task/u);
});

test('project workspace: duplicate template headings get unique ids', () => {
  const workspace = parseWorkspaceMarkdown(`---
task-manager-workspace: true
name: Demo
---

## Templates

### Daily Standup

type: list

Some list template content

### Daily Standup

type: kanban

Some kanban template content
`);

  assert.deepEqual(workspace.templates.map((template) => template.id), ['daily-standup', 'daily-standup-2']);
});

test('project workspace: notes section content excludes the heading on parse', () => {
  const workspace = parseWorkspaceMarkdown(`---
task-manager-workspace: true
name: Demo
---

## Notes

Project kickoff notes...
Blockers and risks...
`);

  assert.equal(workspace.notes, 'Project kickoff notes...\nBlockers and risks...');
  assert.ok(!workspace.notes.includes('## Notes'));
  assert.equal(generateWorkspaceMarkdown(workspace).includes('## Notes\n\n## Notes'), false);
});

test('project workspace: generated queries round-trip and refresh through the production parser', () => {
  const workspace = createDefaultWorkspace('Demo');
  const markdown = generateWorkspaceMarkdown(workspace);
  const parsedWorkspace = parseWorkspaceMarkdown(markdown);
  const expectedQueries = [
    '(status.type is TODO) OR (status.type is IN_PROGRESS)',
    '(status.type is TODO) AND (priority is highest)',
    'due this week',
  ];
  assert.deepEqual(parsedWorkspace.queries.map((query) => query.query), expectedQueries);

  const today = getTodayString();
  const todayDate = new Date(`${today}T00:00:00Z`);
  const monday = new Date(todayDate);
  monday.setUTCDate(todayDate.getUTCDate() - ((todayDate.getUTCDay() + 6) % 7));
  const inThisWeek = monday.toISOString().slice(0, 10);
  const outsideThisWeekDate = new Date(monday);
  outsideThisWeekDate.setUTCDate(monday.getUTCDate() + 7);
  const outsideThisWeek = outsideThisWeekDate.toISOString().slice(0, 10);

  const task = (
    key: string,
    body: string,
    checkbox: string,
    status: ParsedTask['status'],
    priority: ParsedTask['metadata']['priority'],
    due: string,
  ): ParsedTask => {
    const base = createMockTask();
    return createMockTask({
      key,
      body,
      normalizedText: body,
      checkbox,
      status,
      metadata: {
        ...base.metadata,
        priority,
        dates: { ...base.metadata.dates, due },
      },
    });
  };
  const tasks = [
    task('todo-high', 'Highest todo this week', ' ', 'todo', 'highest', inThisWeek),
    task('progress', 'In progress outside this week', '/', 'in_progress', 'normal', outsideThisWeek),
    task('done-week', 'Done this week', 'x', 'done', 'normal', inThisWeek),
    task('done-high', 'Highest done outside this week', 'x', 'done', 'highest', outsideThisWeek),
    task('todo-normal', 'Normal todo outside this week', ' ', 'todo', 'normal', outsideThisWeek),
  ];

  const matches = new Map<string, string[]>();
  const evaluateLikeRefresh = (queryText: string, candidates: ParsedTask[]): ParsedTask[] => {
    const parsed = parseTaskQuery(queryText, {
      today,
      savedQueries: DEFAULT_SETTINGS.savedQueries,
      enableDslExpressions: DEFAULT_SETTINGS.enableDslExpressions,
      nlpQueryEnabled: DEFAULT_SETTINGS.nlpQueryEnabled,
    });
    assert.deepEqual(parsed.errors, [], queryText);
    const filtered = filterTasks(candidates, parsed, {
      today,
      states: DEFAULT_SETTINGS.supportedStates,
      savedQueries: DEFAULT_SETTINGS.savedQueries,
      enableDslExpressions: DEFAULT_SETTINGS.enableDslExpressions,
      customPriorities: DEFAULT_SETTINGS.customPriorities,
      futureOccurrenceCount: DEFAULT_SETTINGS.futureOccurrenceCount,
      fileDefaultsEnabled: DEFAULT_SETTINGS.fileDefaultsEnabled,
      fileDefaultsPropertyPrefix: DEFAULT_SETTINGS.fileDefaultsPropertyPrefix,
      nlpQueryEnabled: DEFAULT_SETTINGS.nlpQueryEnabled,
    });
    matches.set(queryText, filtered.map((candidate) => candidate.key));
    return filtered;
  };

  for (const queryText of expectedQueries) {
    const parsed = parseTaskQuery(queryText, {
      today,
      savedQueries: DEFAULT_SETTINGS.savedQueries,
      enableDslExpressions: DEFAULT_SETTINGS.enableDslExpressions,
      nlpQueryEnabled: DEFAULT_SETTINGS.nlpQueryEnabled,
    });
    assert.deepEqual(parsed.errors, [], queryText);
  }
  const templateQueries = workspace.templates.flatMap((template) =>
    [...template.content.matchAll(/Generated from query:\s*(.*?)\s*-->/gu)].map((match) => match[1]),
  );
  assert.equal(templateQueries.length, 8);
  for (const queryText of templateQueries) {
    assert.doesNotThrow(() => {
      const parsed = parseTaskQuery(queryText, {
        today,
        savedQueries: DEFAULT_SETTINGS.savedQueries,
        enableDslExpressions: DEFAULT_SETTINGS.enableDslExpressions,
        nlpQueryEnabled: DEFAULT_SETTINGS.nlpQueryEnabled,
      });
      assert.deepEqual(parsed.errors, [], queryText);
    }, queryText);
  }

  const refreshed = refreshWorkspaceMarkdown(markdown, tasks, evaluateLikeRefresh, `${today}T12:00:00.000Z`);
  assert.equal(refreshed.viewCount, 3);
  assert.deepEqual([...(matches.get(expectedQueries[0]) ?? [])].sort(), ['progress', 'todo-high', 'todo-normal']);
  assert.deepEqual(matches.get(expectedQueries[1]), ['todo-high']);
  assert.deepEqual([...(matches.get(expectedQueries[2]) ?? [])].sort(), ['done-week', 'todo-high']);
  assert.equal(refreshed.markdown.match(/<!-- task-manager-generated-views:start -->/gu)?.length, 1);
  assert.equal(refreshed.markdown.match(/<!-- task-manager-generated-views:end -->/gu)?.length, 1);
  assert.match(refreshed.markdown, /Highest todo this week/u);
  assert.match(refreshed.markdown, /Done this week/u);

  const refreshedAgain = refreshWorkspaceMarkdown(refreshed.markdown, tasks, evaluateLikeRefresh, `${today}T13:00:00.000Z`);
  assert.equal(refreshedAgain.markdown.match(/<!-- task-manager-generated-views:start -->/gu)?.length, 1);
  assert.equal(refreshedAgain.markdown.match(/<!-- task-manager-generated-views:end -->/gu)?.length, 1);
});

