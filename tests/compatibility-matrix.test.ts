import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { convertReminderPluginSyntax } from '../src/migration-wizard';
import { TaskScanner } from '../src/task-scanner';
import { DEFAULT_TASK_STATES } from '../src/types';
import type { ParsedTask } from '../src/task-scanner';
import type { TaskStateDefinition } from '../src/types';
import { FakeFile } from './test-utils';

const fixturesPath = join(process.cwd(), 'tests', 'fixtures');
const scanner = new TaskScanner({ vault: {} } as never);

const dataviewScanner = new TaskScanner(
  { vault: {} } as never,
  () => DEFAULT_TASK_STATES,
  () => '',
  () => ({
    orgModeEnabled: false,
    fileDefaultsEnabled: false,
    customFieldDefinitions: [
      { key: 'owner', name: 'Owner', type: 'text', searchable: true, syncMode: 'read' },
      { key: 'related', name: 'Related', type: 'text', searchable: true, syncMode: 'read' },
    ],
  }) as never,
);

function parse(line: string, lineNumber = 1): ParsedTask {
  const task = scanner.parseTaskLine(line, 'Fixture.md', lineNumber);
  assert.ok(task, `production parser rejected: ${line}`);
  return task;
}

async function scanFixture(folder: string, filename: string, states: readonly TaskStateDefinition[] = DEFAULT_TASK_STATES): Promise<ParsedTask[]> {
  const fixture = join(fixturesPath, folder, filename);
  assert.ok(existsSync(fixture), `fixture file missing: ${fixture}`);
  const content = readFileSync(fixture, 'utf8');
  const file = new FakeFile(`${folder}/${filename}`, filename);
  const productionScanner = new TaskScanner({ vault: { read: async () => content } } as never, () => states);
  return productionScanner.scanFile(file);
}

void test('Obsidian Tasks: production parser maps canonical date, priority, effort, id, and recurrence markers', () => {
  const task = parse('- [ ] Deploy 🛫 2026-06-05 ⏳ 2026-06-10 📅 2026-06-15 🔺 ⏱️ 2h 🆔 deploy 🔁 every week');
  assert.deepEqual(task.metadata.dates, { start: '2026-06-05', scheduled: '2026-06-10', due: '2026-06-15' });
  assert.equal(task.metadata.priority, 'highest');
  assert.equal(task.metadata.effort, '2h');
  assert.equal(task.metadata.id, 'deploy');
  assert.equal(task.metadata.recurrence, 'every week');
});

void test('Obsidian Tasks: fixture files are scanned through TaskScanner with semantic fields', async () => {
  const basic = await scanFixture('vault-tasks-plugin', 'basic-tasks.md');
  const advanced = await scanFixture('vault-tasks-plugin', 'advanced-tasks.md');
  assert.ok(basic.some((task) => task.metadata.dates.start === '2026-06-05'));
  assert.ok(basic.some((task) => task.metadata.dates.scheduled === '2026-06-10'));
  assert.ok(basic.some((task) => task.metadata.priority === 'lowest'));
  assert.ok(advanced.some((task) => task.metadata.recurrence === 'every weekday'));
  assert.ok(advanced.some((task) => task.metadata.recurrence === 'every 2 weeks'));
});

void test('Reminder syntax requires explicit conversion, then parses through production code', () => {
  const raw = parse('- [ ] Call client (@2026-06-01)');
  assert.equal(raw.metadata.reminder, undefined, 'Reminder-plugin markers are not silently interpreted');
  const dated = parse(convertReminderPluginSyntax('- [ ] Call client (@2026-06-01)'));
  const timed = parse(convertReminderPluginSyntax('- [ ] Morning standup (@2026-06-01 09:00)'));
  assert.equal(dated.metadata.reminder, '2026-06-01');
  assert.equal(timed.metadata.reminder, '2026-06-01 09:00');
});

void test('Reminder fixture lines convert explicitly before production parsing', () => {
  const content = readFileSync(join(fixturesPath, 'vault-reminder-plugin', 'reminder-basic.md'), 'utf8');
  const tasks = content.split(/\r?\n/u)
    .map((line, index) => scanner.parseTaskLine(convertReminderPluginSyntax(line), 'Reminder.md', index + 1))
    .filter((task): task is ParsedTask => task !== null);
  assert.ok(tasks.some((task) => task.metadata.reminder === '2026-06-01'));
  assert.ok(tasks.some((task) => task.metadata.reminder?.includes('09:00')));
});

void test('Kanban Markdown fixture yields task cards and headings through TaskScanner', async () => {
  const tasks = await scanFixture('vault-kanban-boards', 'board-simple.md');
  assert.ok(tasks.length > 0);
  assert.ok(tasks.some((task) => task.heading?.toLowerCase().includes('todo')));
  assert.ok(tasks.some((task) => task.status === 'done'));
});

void test('Dataview inline fields are parsed by the production task model', () => {
  const task = dataviewScanner.parseTaskLine('- [ ] Task [priority:: high] [effort:: 2h] [owner:: alice] [related:: [[database-schema]]]', 'Fixture.md', 1);
  assert.ok(task);
  assert.equal(task.metadata.priority, 'high');
  assert.equal(task.metadata.effort, '2h');
  assert.equal(task.metadata.customFields?.owner?.value, 'alice');
  assert.equal(task.metadata.customFields?.related?.value, '[[database-schema]]');
});

void test('Dataview fixture built-ins survive production scanning', async () => {
  const tasks = await scanFixture('vault-dataview-fields', 'dataview-basic.md');
  assert.ok(tasks.some((task) => task.metadata.effort));
  assert.ok(tasks.some((task) => task.metadata.priority !== 'normal'));
});

void test('Task Genius markers are preserved and mapped only through configured states', async () => {
  const configured: TaskStateDefinition[] = [
    ...DEFAULT_TASK_STATES,
    { rawText: '<', name: 'Waiting (Task Genius)', icon: '', type: 'blocked', nextStatusSymbol: 'x' },
    { rawText: '+', name: 'Added (Task Genius)', icon: '', type: 'todo', nextStatusSymbol: 'x' },
    { rawText: '~', name: 'Recurring (Task Genius)', icon: '', type: 'todo', nextStatusSymbol: 'x' },
  ];
  const tasks = await scanFixture('vault-task-genius', 'genius-basic.md', configured);
  assert.ok(tasks.some((task) => task.checkbox === '/' && task.status === 'in_progress'));
  assert.ok(tasks.some((task) => task.checkbox === '<'));
  assert.ok(tasks.some((task) => task.checkbox === '~'));
});

void test('mixed-format fixture coexists under one production scanner', async () => {
  const tasks = await scanFixture('vault-mixed-formats', 'mixed.md');
  assert.ok(tasks.length > 0);
  assert.ok(tasks.some((task) => task.metadata.dates.due));
  assert.ok(tasks.some((task) => task.rawLine.includes('(@2026') && task.metadata.reminder === undefined));
  assert.ok(tasks.some((task) => task.metadata.effort));
});

void test('all documented fixture directories remain present', () => {
  for (const fixture of [
    'vault-tasks-plugin/README.md',
    'vault-reminder-plugin/README.md',
    'vault-kanban-boards/README.md',
    'vault-dataview-fields/README.md',
    'vault-task-genius/README.md',
    'vault-mixed-formats/README.md',
    'vault-large/README.md',
  ]) {
    const fixturePath = join(fixturesPath, fixture);
    assert.ok(existsSync(fixturePath), `fixture file missing: ${fixturePath}`);
  }
});
