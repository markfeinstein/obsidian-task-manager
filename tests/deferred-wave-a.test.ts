import test from 'node:test';
import assert from 'node:assert/strict';
import { createPomodoroTimeSession, disposeDashboardWidget, formatPomodoroSeconds } from '../src/dashboard';
import { PlanningBoard, planPlanningBoardSchedule, planningBoardTargetForTab } from '../src/planning-board';
import { createDefaultWorkspace, generateWorkspaceMarkdown, isProjectWorkspaceMarkdown, parseWorkspaceMarkdown, refreshWorkspaceMarkdown } from '../src/project-workspace';
import { applyAiProviderDefaults, normalizeTaskManagerSettings } from '../src/types';
import type { ParsedTask } from '../src/task-scanner';

function task(overrides: Partial<ParsedTask> = {}): ParsedTask {
  return {
    key: 'Tasks.md:Do thing',
    filePath: 'Tasks.md',
    lineNumber: 1,
    rawLine: '- [ ] Do thing',
    linePrefix: '',
    indentation: '',
    listMarker: '-',
    checkbox: ' ',
    body: 'Do thing',
    normalizedText: 'Do thing',
    status: 'todo',
    tags: [],
    contexts: [],
    metadata: { dates: {}, invalidDates: {}, priority: 'normal', dependsOn: [] },
    ...overrides,
  } as ParsedTask;
}

test('deferred wave A: planning board target model schedules safe dates', () => {
  const weekTarget = planningBoardTargetForTab('week', '2026-05-28');
  assert.deepEqual(weekTarget, { tab: 'week', date: '2026-05-29', field: 'scheduled' });
  assert.equal(planningBoardTargetForTab('completed', '2026-05-28'), null);

  const planned = planPlanningBoardSchedule(task({ metadata: { dates: { due: '2026-06-01' }, invalidDates: {}, priority: 'normal', dependsOn: [] } }), weekTarget! , 123);
  assert.deepEqual(planned.updates, [{ field: 'scheduled', value: '2026-05-29' }]);
  assert.equal(planned.operation.toScheduled, '2026-05-29');
  assert.equal(planned.operation.toDue, '2026-06-01');
  assert.equal(planned.operation.timestamp, 123);
});

test('deferred wave A: planning board unschedule clears one date safely', () => {
  const target = planningBoardTargetForTab('unscheduled', '2026-05-28');
  const scheduledTask = task({ metadata: { dates: { scheduled: '2026-05-28', due: '2026-06-01' }, invalidDates: {}, priority: 'normal', dependsOn: [] } });
  const dueOnlyTask = task({ metadata: { dates: { due: '2026-06-01' }, invalidDates: {}, priority: 'normal', dependsOn: [] } });

  assert.deepEqual(planPlanningBoardSchedule(scheduledTask, target!).updates, [{ field: 'scheduled', value: null }]);
  assert.deepEqual(planPlanningBoardSchedule(dueOnlyTask, target!).updates, [{ field: 'due', value: null }]);
});

test('deferred wave A: local AI provider settings normalize provider-specific defaults', () => {
  const ollama = normalizeTaskManagerSettings({
    aiQueryEnabled: true,
    aiQueryProvider: 'ollama',
    aiQueryModel: 'gpt-4o-mini',
    aiQueryLocalEndpoint: ' http://localhost:11434/v1/chat/completions ',
  });
  assert.equal(ollama.aiQueryProvider, 'ollama');
  assert.equal(ollama.aiQueryModel, 'llama3.1');
  assert.equal(ollama.aiQueryLocalEndpoint, 'http://localhost:11434/v1/chat/completions');

  const lmStudio = normalizeTaskManagerSettings({
    aiQueryEnabled: true,
    aiQueryProvider: 'lm-studio',
    aiQueryModel: 'gpt-4o-mini',
    aiQueryLocalEndpoint: 'http://localhost:11434/v1/chat/completions',
  });
  assert.equal(lmStudio.aiQueryProvider, 'lm-studio');
  assert.equal(lmStudio.aiQueryModel, 'local-model');
  assert.equal(lmStudio.aiQueryLocalEndpoint, 'http://localhost:1234/v1/chat/completions');

  const custom = normalizeTaskManagerSettings({
    aiQueryProvider: 'ollama',
    aiQueryModel: 'mistral',
    aiQueryLocalEndpoint: 'http://127.0.0.1:9999/v1/chat/completions',
  });
  assert.equal(custom.aiQueryModel, 'mistral');
  assert.equal(custom.aiQueryLocalEndpoint, 'http://127.0.0.1:9999/v1/chat/completions');

  const unsafe = normalizeTaskManagerSettings({
    aiQueryProvider: 'ollama',
    aiQueryModel: 'mistral',
    aiQueryLocalEndpoint: 'https://evil.example/v1/chat/completions',
  });
  assert.equal(unsafe.aiQueryLocalEndpoint, 'http://localhost:11434/v1/chat/completions');
});

test('deferred wave A: provider switch helper replaces known defaults only', () => {
  const settings = normalizeTaskManagerSettings({});
  applyAiProviderDefaults(settings, 'lm-studio');
  assert.equal(settings.aiQueryProvider, 'lm-studio');
  assert.equal(settings.aiQueryModel, 'local-model');
  assert.equal(settings.aiQueryLocalEndpoint, 'http://localhost:1234/v1/chat/completions');

  settings.aiQueryModel = 'custom-local';
  settings.aiQueryLocalEndpoint = 'http://localhost:5555/v1/chat/completions';
  applyAiProviderDefaults(settings, 'ollama');
  assert.equal(settings.aiQueryModel, 'custom-local');
  assert.equal(settings.aiQueryLocalEndpoint, 'http://localhost:5555/v1/chat/completions');
});

test('deferred wave A: workspace refresh replaces generated views safely', () => {
  const markdown = `---\ntask-manager-workspace: true\nname: Demo\n---\n\n## Queries\n\n### Active\n\nquery: \`not done\`\n\n## Notes\n\nKeep this note.\n`;
  const tasks = [task({ key: 'a', body: 'Active task', normalizedText: 'Active task' })];
  const first = refreshWorkspaceMarkdown(markdown, tasks, (_query, inputTasks) => inputTasks, '2026-05-28T00:00:00.000Z');
  const second = refreshWorkspaceMarkdown(first.markdown, tasks, () => [], '2026-05-29T00:00:00.000Z');

  assert.equal(first.viewCount, 1);
  assert.match(first.markdown, /Keep this note/);
  assert.match(first.markdown, /Active task/);
  assert.equal((second.markdown.match(/task-manager-generated-views:start/gu) ?? []).length, 1);
  assert.match(second.markdown, /Generated: 2026-05-29T00:00:00.000Z/);
});

test('deferred wave A: workspace refresh leaves non-workspace notes unchanged', () => {
  const markdown = '# Meeting notes\n\n## Queries\n\nquery: `not done`\n';
  const refreshed = refreshWorkspaceMarkdown(markdown, [task()], (_query, inputTasks) => inputTasks, '2026-05-28T00:00:00.000Z');
  assert.equal(isProjectWorkspaceMarkdown(markdown), false);
  assert.equal(refreshed.markdown, markdown);
  assert.equal(refreshed.viewCount, 0);
});

test('deferred wave A: generated workspace markdown includes refresh safety marker', () => {
  const markdown = generateWorkspaceMarkdown(createDefaultWorkspace('Demo'));
  assert.match(markdown, /^task-manager-workspace: true$/mu);
  assert.equal(isProjectWorkspaceMarkdown(markdown), true);
});

test('deferred wave A: pomodoro widget sessions use TimeSessionRecord shape', () => {
  const session = createPomodoroTimeSession(task(), '2026-05-28T10:00:00.000Z', '2026-05-28T10:25:00.000Z', 25);
  assert.equal(session.source, 'pomodoro');
  assert.equal(session.elapsedMinutes, 25);
  assert.equal(session.taskText, 'Do thing');
  assert.equal(formatPomodoroSeconds(65), '01:05');
});

test('deferred wave A: pomodoro widget disposer clears registered timer once', () => {
  const originalWindow = globalThis.window;
  const startedDelays: number[] = [];
  const cleared: number[] = [];
  globalThis.window = {
    setInterval: (_callback: () => void, delay: number) => {
      startedDelays.push(delay);
      return 42;
    },
    clearInterval: (timerId: number) => { cleared.push(timerId); },
  } as never;

  try {
    const intervalId = window.setInterval(() => undefined, 1000);
    const widget: { dispose?: () => void } = {
      dispose: () => window.clearInterval(intervalId),
    };

    disposeDashboardWidget(widget);
    disposeDashboardWidget(widget);

    assert.deepEqual(startedDelays, [1000]);
    assert.deepEqual(cleared, [42]);
    assert.equal(widget.dispose, undefined);
  } finally {
    globalThis.window = originalWindow;
  }
});

test('planning-board: unscheduled tab excludes done and cancelled tasks', () => {
  const today = '2026-05-31';
  const board = new PlanningBoard({ settings: {} as any, todayDate: today });

  const baseTask = (overrides: Partial<ParsedTask> = {}): ParsedTask =>
    task({ metadata: { dates: {}, invalidDates: {}, priority: 'normal', dependsOn: [] }, ...overrides });

  const tasks: ParsedTask[] = [
    // Active task with no dates → should appear in unscheduled
    baseTask({ key: 'active-nodates', status: 'todo' }),
    // Active task with a past scheduled date → should appear in unscheduled
    baseTask({ key: 'active-past', status: 'todo', metadata: { dates: { scheduled: '2026-05-01' }, invalidDates: {}, priority: 'normal', dependsOn: [] } }),
    // Done task with no dates → must NOT appear in unscheduled (belongs in completed)
    baseTask({ key: 'done-nodates', status: 'done', checkbox: 'x' }),
    // Done task with past due date → must NOT appear in unscheduled
    baseTask({ key: 'done-past', status: 'done', checkbox: 'x', metadata: { dates: { due: '2026-05-01' }, invalidDates: {}, priority: 'normal', dependsOn: [] } }),
    // Cancelled task with no dates → must NOT appear in unscheduled
    baseTask({ key: 'cancelled-nodates', status: 'cancelled', checkbox: '-' }),
  ];

  const unscheduled = board.getTasksByTab('unscheduled', tasks);
  const keys = unscheduled.map((t) => t.key);

  assert.ok(keys.includes('active-nodates'), 'active task with no dates should be unscheduled');
  assert.ok(keys.includes('active-past'), 'active task with past scheduled should be unscheduled');
  assert.ok(!keys.includes('done-nodates'), 'done task (no dates) must not appear in unscheduled');
  assert.ok(!keys.includes('done-past'), 'done task (past due) must not appear in unscheduled');
  assert.ok(!keys.includes('cancelled-nodates'), 'cancelled task must not appear in unscheduled');
  assert.equal(unscheduled.length, 2);
});

test('parseWorkspaceMarkdown: frontmatter values containing colons are not truncated', () => {
  const markdown = [
    '---',
    'task-manager-workspace: true',
    'name: My Project: Phase 1',
    'description: A workspace for project: alpha build',
    'owner: user@example.com',
    '---',
    '',
    '## Notes',
    '',
    'Some notes here.',
  ].join('\n');

  const workspace = parseWorkspaceMarkdown(markdown);

  assert.equal(workspace.metadata.name, 'My Project: Phase 1',
    'name value after the first colon should not be truncated');
  assert.equal(workspace.metadata.description, 'A workspace for project: alpha build',
    'description value after the first colon should not be truncated');
  assert.equal(workspace.metadata.owner, 'user@example.com',
    'owner with @ should be preserved correctly');
});

test('parseWorkspaceMarkdown: CRLF workspaces keep metadata and query blocks', () => {
  const markdown = [
    '---',
    'task-manager-workspace: true',
    'name: Windows Workspace',
    'tags: project, workspace',
    '---',
    '',
    '## Queries',
    '',
    '### Active',
    '',
    'query: `not done`',
    '',
    '## Notes',
    '',
    'Keep this note.',
  ].join('\r\n');

  const workspace = parseWorkspaceMarkdown(markdown);
  const refreshed = refreshWorkspaceMarkdown(markdown, [task()], (_query, inputTasks) => inputTasks, '2026-05-28T00:00:00.000Z');

  assert.equal(isProjectWorkspaceMarkdown(markdown), true);
  assert.equal(workspace.metadata.name, 'Windows Workspace');
  assert.deepEqual(workspace.metadata.tags, ['project', 'workspace']);
  assert.equal(workspace.queries.length, 1);
  assert.equal(workspace.queries[0].name, 'Active');
  assert.equal(workspace.queries[0].query, 'not done');
  assert.equal(refreshed.viewCount, 1);
  assert.match(refreshed.markdown, /Do thing/);
});
