import test from 'node:test';
import assert from 'node:assert/strict';
import { TFile, TFolder } from 'obsidian';
import type { App } from 'obsidian';
import { buildMigrationPlan, performMigration, migrateVaultFileSyntax, migrateVaultFiles } from '../src/migration-wizard';
import type { MarkdownTask } from '../src/task-model';

function task(overrides: Partial<MarkdownTask> = {}): MarkdownTask {
  return {
    key: 'task-key', filePath: 'Inbox.md', lineNumber: 1,
    rawLine: '- [ ] Test task', linePrefix: '', indentation: '', listMarker: '-', checkbox: ' ',
    body: 'Test task', normalizedText: 'Test task', status: 'todo', tags: [], contexts: [],
    metadata: { dates: {}, invalidDates: {}, priority: 'normal', dependsOn: [] },
    ...overrides,
  } as MarkdownTask;
}

class FakeMigrationVault {
  readonly files = new Map<string, string>();
  readonly folders = new Set<string>();
  readonly writes: string[] = [];
  readonly processCalls: string[] = [];
  readonly failWrites = new Set<string>();
  readonly raceCreates = new Map<string, string>();

  private file(path: string): TFile {
    return Object.assign(Object.create(TFile.prototype) as TFile, { path, name: path.split('/').pop() ?? path });
  }

  getAbstractFileByPath(path: string): TFile | TFolder | null {
    if (this.files.has(path)) return this.file(path);
    if (this.folders.has(path)) return Object.assign(Object.create(TFolder.prototype) as TFolder, { path });
    return null;
  }

  async cachedRead(file: TFile): Promise<string> {
    const content = this.files.get(file.path);
    if (content === undefined) throw new Error(`Missing file ${file.path}`);
    return content;
  }

  async create(path: string, content: string): Promise<TFile> {
    if (this.failWrites.has(path)) throw new Error(`Injected failure for ${path}`);
    const racedContent = this.raceCreates.get(path);
    if (racedContent !== undefined) {
      this.raceCreates.delete(path);
      this.files.set(path, racedContent);
      throw new Error(`Concurrent create at ${path}`);
    }
    if (this.files.has(path) || this.folders.has(path)) throw new Error(`Already exists: ${path}`);
    this.files.set(path, content);
    this.writes.push(path);
    return this.file(path);
  }

  async createFolder(path: string): Promise<TFolder> {
    if (this.files.has(path)) throw new Error(`File blocks folder ${path}`);
    this.folders.add(path);
    return Object.assign(Object.create(TFolder.prototype) as TFolder, { path });
  }

  async process(file: TFile, updater: (content: string) => string): Promise<string> {
    if (this.failWrites.has(file.path)) throw new Error(`Injected failure for ${file.path}`);
    const current = this.files.get(file.path);
    if (current === undefined) throw new Error(`Missing file ${file.path}`);
    this.processCalls.push(file.path);
    const updated = updater(current);
    this.files.set(file.path, updated);
    if (updated !== current) this.writes.push(file.path);
    return updated;
  }
}

function fakeApp(vault = new FakeMigrationVault()): { app: App; vault: FakeMigrationVault } {
  return { app: { vault } as unknown as App, vault };
}

const LOCAL_SOURCE = 'local-vault-tasks';
const liveOptions = {
  targetNamespace: 'Imports/Migrated', preserveMetadata: true,
  dryRun: false, conflictResolution: 'skip' as const,
};

test('performMigration dry-run reports planned writes and performs no vault changes', async () => {
  const { app, vault } = fakeApp();
  const report = await performMigration(app, [task()], { ...liveOptions, dryRun: true });
  assert.equal(report.successfulMigrations, 0);
  assert.equal(report.plannedMigrations, 1);
  assert.equal(report.details[0].status, 'planned');
  assert.equal(report.dryRunOutput?.totalOperations, 1);
  assert.match(report.dryRunOutput?.operations[0].preview ?? '', /Source vault task remains unchanged/u);
  assert.equal(vault.files.size, 0);
  assert.equal(vault.writes.length, 0);
});

test('performMigration creates durable files and parent folders while preserving source tasks', async () => {
  const { app, vault } = fakeApp();
  const source = task({ body: 'Keep me 📅 2026-07-20', rawLine: '  - [ ] Keep me 📅 2026-07-20 #work [owner:: Ada]' });
  const report = await performMigration(app, [source], liveOptions);
  assert.equal(report.successfulMigrations, 1);
  assert.equal(report.details[0].status, 'success');
  const target = report.details[0].targetLocation ?? '';
  assert.equal(vault.folders.has('Imports'), true);
  assert.equal(vault.folders.has('Imports/Migrated'), true);
  assert.match(vault.files.get(target) ?? '', /  - \[ \] Keep me 📅 2026-07-20 #work \[owner:: Ada\]/u);
  assert.deepEqual(report.details[0].affectedFields, ['complete original task line']);
  assert.equal(source.rawLine, '  - [ ] Keep me 📅 2026-07-20 #work [owner:: Ada]');
});

test('performMigration is idempotent on rerun', async () => {
  const { app, vault } = fakeApp();
  const first = await performMigration(app, [task()], liveOptions);
  const writesAfterFirstRun = vault.writes.length;
  const second = await performMigration(app, [task()], liveOptions);
  assert.equal(first.successfulMigrations, 1);
  assert.equal(second.successfulMigrations, 0);
  assert.equal(second.skippedTasks, 1);
  assert.match(second.details[0].reason ?? '', /Already copied/u);
  assert.equal(vault.writes.length, writesAfterFirstRun);
});

test('rescan-style rerun excludes generated task notes from source planning', async () => {
  const { app, vault } = fakeApp();
  const source = task();
  const first = await performMigration(app, [source], liveOptions);
  const target = first.details[0].targetLocation ?? '';
  const rescannedOutput = task({
    key: 'rescanned-output', filePath: target, lineNumber: 2,
    rawLine: '- [ ] Test task', body: 'Test task', normalizedText: 'Test task',
  });
  const second = await performMigration(app, [source, rescannedOutput], liveOptions);
  assert.equal(second.successfulMigrations, 0);
  assert.equal(second.skippedTasks, 2);
  assert.match(second.details[1].reason ?? '', /migration-owned/u);
  assert.equal(vault.files.size, 1);
});

test('migration marker excludes generated task notes even when target namespace changes', async () => {
  const { app, vault } = fakeApp();
  const first = await performMigration(app, [task()], liveOptions);
  const generatedPath = first.details[0].targetLocation ?? '';
  const rescannedOutput = task({ key: 'rescanned-output', filePath: generatedPath, lineNumber: 2 });
  const second = await performMigration(app, [rescannedOutput], {
    ...liveOptions, targetNamespace: 'Another/Namespace',
  });
  assert.equal(second.successfulMigrations, 0);
  assert.equal(second.skippedTasks, 1);
  assert.match(second.details[0].reason ?? '', /migration-owned/u);
  assert.equal([...vault.files.keys()].some((path) => path.startsWith('Another/Namespace/')), false);
});

test('performMigration applies status, priority, tag, and date filters', async () => {
  const { app } = fakeApp();
  const matching = task({
    key: 'match', tags: ['#work'],
    metadata: { dates: { due: '2026-07-20' }, invalidDates: {}, priority: 'high', dependsOn: [] },
  });
  const wrongStatus = task({ key: 'status', status: 'done', checkbox: 'x', tags: ['#work'], metadata: matching.metadata });
  const wrongPriority = task({ key: 'priority', tags: ['#work'] });
  const report = await performMigration(app, [matching, wrongStatus, wrongPriority], {
    ...liveOptions,
    filterBy: {
      status: ['todo'], priority: ['high'], tags: ['#work'],
      dateRange: { start: new Date('2026-07-01T00:00:00'), end: new Date('2026-07-31T23:59:59') },
    },
  });
  assert.equal(report.successfulMigrations, 1);
  assert.equal(report.skippedTasks, 2);
  assert.equal(report.details.filter((detail) => detail.status === 'success').length, 1);
});

test('stable identities prevent same-title filename collisions', async () => {
  const { app, vault } = fakeApp();
  const report = await performMigration(app, [task({ key: 'one' }), task({ key: 'two' })], liveOptions);
  assert.equal(report.successfulMigrations, 2);
  assert.equal(vault.files.size, 2);
  const paths = report.details.map((detail) => detail.targetLocation);
  assert.notEqual(paths[0], paths[1]);
});

test('duplicate explicit IDs conflict before writes even with overwrite selected', async () => {
  const { app, vault } = fakeApp();
  const duplicateMetadata = { dates: {}, invalidDates: {}, priority: 'normal' as const, dependsOn: [], id: 'duplicate-42' };
  const duplicates = [
    task({ key: 'one', filePath: 'One.md', metadata: duplicateMetadata }),
    task({ key: 'two', filePath: 'Two.md', metadata: duplicateMetadata }),
  ];
  const preview = await performMigration(app, duplicates, {
    ...liveOptions, dryRun: true, conflictResolution: 'overwrite',
  });
  assert.equal(preview.conflictedTasks, 2);
  assert.equal(preview.plannedMigrations, 0);
  assert.equal(preview.dryRunOutput?.potentialConflicts.length, 2);
  const live = await performMigration(app, duplicates, {
    ...liveOptions, conflictResolution: 'overwrite',
  });
  assert.equal(live.conflictedTasks, 2);
  assert.equal(live.successfulMigrations, 0);
  assert.equal(vault.writes.length, 0);
  assert.equal(vault.files.size, 0);
});

test('filename remains stable when a task with a stable identity is renamed', async () => {
  const before = task({ key: 'old-key', stableKey: 'stable-42', body: 'Old title', normalizedText: 'Old title' });
  const after = task({ key: 'new-key', stableKey: 'stable-42', body: 'New title', normalizedText: 'New title' });
  const first = await performMigration(fakeApp().app, [before], { ...liveOptions, dryRun: true });
  const second = await performMigration(fakeApp().app, [after], { ...liveOptions, dryRun: true });
  assert.equal(first.details[0].targetLocation, second.details[0].targetLocation);
});

test('full source identity marker supports an explicit overwrite without changing target', async () => {
  const { app, vault } = fakeApp();
  const metadata = { dates: {}, invalidDates: {}, priority: 'normal' as const, dependsOn: [], id: 'shared/id:42' };
  const original = task({ metadata, rawLine: '- [ ] Original #one', body: 'Original #one', normalizedText: 'Original' });
  const changed = task({ metadata, rawLine: '- [ ] Changed #two 📅 2026-08-01', body: 'Changed #two 📅 2026-08-01', normalizedText: 'Changed' });
  const first = await performMigration(app, [original], liveOptions);
  const target = first.details[0].targetLocation ?? '';
  const second = await performMigration(app, [changed], {
    ...liveOptions, conflictResolution: 'overwrite',
  });
  assert.equal(second.successfulMigrations, 1);
  assert.equal(second.details[0].targetLocation, target);
  const content = vault.files.get(target) ?? '';
  assert.match(content, /Changed #two 📅 2026-08-01/u);
  assert.doesNotMatch(content, /Original #one/u);
  assert.ok(content.includes(encodeURIComponent(`${LOCAL_SOURCE}:shared/id:42`)));
  assert.deepEqual(second.details[0].affectedFields, ['complete original task line']);
});

test('existing unrelated target is reported as a conflict without a write', async () => {
  const { app, vault } = fakeApp();
  const preview = await performMigration(app, [task()], { ...liveOptions, dryRun: true });
  const target = preview.details[0].targetLocation ?? '';
  vault.files.set(target, '# User content\n');
  const report = await performMigration(app, [task()], liveOptions);
  assert.equal(report.conflictedTasks, 1);
  assert.equal(report.successfulMigrations, 0);
  assert.equal(report.details[0].status, 'conflict');
  assert.equal(vault.files.get(target), '# User content\n');
});

test('merge collision strategy uses an idempotent vault process update', async () => {
  const { app, vault } = fakeApp();
  const preview = await performMigration(app, [task()], { ...liveOptions, dryRun: true });
  const target = preview.details[0].targetLocation ?? '';
  vault.files.set(target, '# Existing note\n');
  const merged = await performMigration(app, [task()], { ...liveOptions, conflictResolution: 'merge' });
  assert.equal(merged.successfulMigrations, 1);
  assert.match(vault.files.get(target) ?? '', /# Existing note[\s\S]*task-manager-migration/u);
  const rerun = await performMigration(app, [task()], { ...liveOptions, conflictResolution: 'merge' });
  assert.equal(rerun.successfulMigrations, 0);
  assert.equal(rerun.skippedTasks, 1);
  assert.equal((vault.files.get(target)?.match(/task-manager-migration/gu) ?? []).length, 1);
});

test('target-path folder collision is reported without processing or creating', async () => {
  const { app, vault } = fakeApp();
  const preview = await performMigration(app, [task()], { ...liveOptions, dryRun: true });
  const target = preview.details[0].targetLocation ?? '';
  vault.folders.add(target);
  const report = await performMigration(app, [task()], liveOptions);
  assert.equal(report.conflictedTasks, 1);
  assert.match(report.details[0].reason ?? '', /folder already exists/u);
  assert.equal(vault.processCalls.length, 0);
  assert.equal(vault.writes.length, 0);
});

test('concurrent identical create is recovered as an idempotent skip', async () => {
  const { app, vault } = fakeApp();
  const plan = await buildMigrationPlan(app, [task()], liveOptions);
  const operation = plan.operations[0];
  vault.raceCreates.set(operation.targetPath ?? '', operation.content);
  const report = await performMigration(app, [task()], liveOptions);
  assert.equal(report.successfulMigrations, 0);
  assert.equal(report.skippedTasks, 1);
  assert.match(report.details[0].reason ?? '', /Already migrated|Already copied/u);
  assert.deepEqual(vault.processCalls, [operation.targetPath]);
  assert.equal(vault.files.size, 1);
});

test('malformed target path fails every task without writing', async () => {
  const { app, vault } = fakeApp();
  const report = await performMigration(app, [task()], { ...liveOptions, targetNamespace: '../Outside' });
  assert.equal(report.failedMigrations, 1);
  assert.equal(report.details[0].status, 'failed');
  assert.match(report.warnings.join('\n'), /cannot contain/u);
  assert.equal(report.warnings.filter((warning) => warning.includes('Migration configuration error')).length, 1);
  assert.equal(vault.writes.length, 0);
});

test('reversed date filter is one configuration failure and performs no writes', async () => {
  const { app, vault } = fakeApp();
  const report = await performMigration(app, [task({ key: 'one' }), task({ key: 'two' })], {
    ...liveOptions,
    filterBy: { dateRange: { start: new Date('2026-08-01'), end: new Date('2026-07-01') } },
  });
  assert.equal(report.failedMigrations, 2);
  assert.equal(report.warnings.filter((warning) => warning.includes('Migration configuration error')).length, 1);
  assert.match(report.warnings.join('\n'), /start must not be after/u);
  assert.equal(vault.writes.length, 0);
});

test('invalid date filter is one configuration failure and performs no writes', async () => {
  const { app, vault } = fakeApp();
  const report = await performMigration(app, [task()], {
    ...liveOptions,
    filterBy: { dateRange: { start: new Date('invalid'), end: new Date('2026-07-01') } },
  });
  assert.equal(report.failedMigrations, 1);
  assert.equal(report.warnings.filter((warning) => warning.includes('Migration configuration error')).length, 1);
  assert.match(report.warnings.join('\n'), /invalid date/u);
  assert.equal(vault.writes.length, 0);
});

test('partial write failure reports accurate per-task outcomes and continues', async () => {
  const { app, vault } = fakeApp();
  const tasks = [task({ key: 'one', body: 'One', normalizedText: 'One' }), task({ key: 'two', body: 'Two', normalizedText: 'Two' })];
  const preview = await performMigration(app, tasks, { ...liveOptions, dryRun: true });
  vault.failWrites.add(preview.details[1].targetLocation ?? '');
  const report = await performMigration(app, tasks, liveOptions);
  assert.equal(report.totalTasks, 2);
  assert.equal(report.successfulMigrations, 1);
  assert.equal(report.failedMigrations, 1);
  assert.deepEqual(report.details.map((detail) => detail.status), ['success', 'failed']);
  assert.match(report.details[1].reason ?? '', /Write failed.*Injected failure/u);
  assert.equal(vault.files.size, 1);
});

// ── Reminder syntax migration ─────────────────────────────────────────────

test('migrateVaultFileSyntax reminder: dry-run does not change content', () => {
  const content = '- [ ] Pay bill (@2026-06-15)\n- [ ] Call doctor\n';
  const { content: out, migrations } = migrateVaultFileSyntax(content, 'reminder', 'Tasks.md', true);
  assert.equal(out, content, 'content unchanged in dry-run');
  assert.equal(migrations.length, 1);
  assert.equal(migrations[0].lineNumber, 1);
  assert.match(migrations[0].migrated, /⏰ 2026-06-15/u);
  assert.ok(migrations[0].changes.length > 0);
});

test('migrateVaultFileSyntax reminder: apply converts (@date) to ⏰ emoji', () => {
  const content = '- [ ] Pay bill (@2026-06-15)\n- [ ] Call doctor\n';
  const { content: out, migrations } = migrateVaultFileSyntax(content, 'reminder', 'Tasks.md', false);
  assert.match(out, /⏰ 2026-06-15/u);
  assert.ok(!out.includes('(@2026-06-15)'), 'original syntax removed');
  assert.equal(migrations.length, 1);
});

test('migrateVaultFileSyntax reminder: converts (@date time) to ⏰ date time', () => {
  const content = '- [ ] Meeting (@2026-07-01 09:30)\n';
  const { content: out } = migrateVaultFileSyntax(content, 'reminder', 'Tasks.md', false);
  assert.match(out, /⏰ 2026-07-01 09:30/u);
});

test('migrateVaultFileSyntax apply preserves CRLF line endings', () => {
  const content = '- [ ] Pay bill (@2026-06-15)\r\n- [ ] Call doctor\r\n';
  const { content: out, migrations } = migrateVaultFileSyntax(content, 'reminder', 'Tasks.md', false);
  assert.equal(migrations.length, 1);
  assert.equal(out, '- [ ] Pay bill ⏰ 2026-06-15\r\n- [ ] Call doctor\r\n');
  assert.ok(!out.includes('\n- [ ] Call doctor\n'), 'CRLF newlines should not be normalized to LF');
});

// ── Dataview syntax migration ─────────────────────────────────────────────

test('migrateVaultFileSyntax dataview: dry-run detects [due:: date] fields', () => {
  const content = '- [ ] Buy milk [due:: 2026-06-15]\n- [ ] Regular task\n';
  const { content: out, migrations } = migrateVaultFileSyntax(content, 'dataview', 'Tasks.md', true);
  assert.equal(out, content, 'unchanged in dry-run');
  assert.equal(migrations.length, 1);
  assert.match(migrations[0].migrated, /📅 2026-06-15/u);
});

test('migrateVaultFileSyntax dataview: apply converts date fields to emoji', () => {
  const lines = [
    '- [ ] Task A [due:: 2026-06-15]',
    '- [ ] Task B [scheduled:: 2026-06-10]',
    '- [ ] Task C [start:: 2026-06-01]',
    '- [ ] Task D [created:: 2026-05-01]',
    '- [ ] Task E [completion:: 2026-06-20]',
  ];
  const content = lines.join('\n');
  const { content: out } = migrateVaultFileSyntax(content, 'dataview', 'Tasks.md', false);
  assert.match(out, /📅 2026-06-15/u);
  assert.match(out, /⏳ 2026-06-10/u);
  assert.match(out, /🛫 2026-06-01/u);
  assert.match(out, /➕ 2026-05-01/u);
  assert.match(out, /✅ 2026-06-20/u);
});

test('migrateVaultFileSyntax dataview: apply converts [priority:: high] to ⏫', () => {
  const content = '- [ ] Urgent task [priority:: high]\n- [ ] Low task [priority:: low]\n';
  const { content: out } = migrateVaultFileSyntax(content, 'dataview', 'Tasks.md', false);
  assert.match(out, /⏫/u);
  assert.match(out, /🔽/u);
  assert.ok(!out.includes('[priority::'), 'dataview priority fields removed');
});

// ── Kanban board migration ────────────────────────────────────────────────

test('migrateVaultFileSyntax kanban: dry-run tags cards with column name', () => {
  const content = '## In Progress\n- [ ] Fix bug\n- [ ] Write tests\n## Done\n- [x] Merged PR\n';
  const { migrations } = migrateVaultFileSyntax(content, 'kanban', 'Board.md', true);
  assert.equal(migrations.length, 3);
  assert.match(migrations[0].migrated, /\[project:: In Progress\]/u);
  assert.match(migrations[2].migrated, /\[project:: Done\]/u);
});

test('migrateVaultFileSyntax kanban: apply adds [project:: ColumnName]', () => {
  const content = '## Todo\n- [ ] Task one\n## Doing\n- [ ] Task two\n';
  const { content: out } = migrateVaultFileSyntax(content, 'kanban', 'Board.md', false);
  assert.match(out, /\[project:: Todo\]/u);
  assert.match(out, /\[project:: Doing\]/u);
});

test('migrateVaultFileSyntax kanban: does not re-tag cards that already have [project::]', () => {
  const content = '## Todo\n- [ ] Task one [project:: Backlog]\n';
  const { migrations } = migrateVaultFileSyntax(content, 'kanban', 'Board.md', true);
  assert.equal(migrations.length, 0, 'already-tagged card should not be changed');
});

// ── Task Genius syntax migration ──────────────────────────────────────────

test('migrateVaultFileSyntax task-genius: converts +Project to [project:: Project]', () => {
  const content = '- [ ] Submit report +WorkProject\n- [ ] Buy groceries\n';
  const { content: out, migrations } = migrateVaultFileSyntax(content, 'task-genius', 'Tasks.md', false);
  assert.equal(out, '- [ ] Submit report [project:: WorkProject]\n- [ ] Buy groceries\n');
  assert.equal(migrations.length, 1);
});

test('migrateVaultFileSyntax task-genius: dry-run detects +tags without applying', () => {
  const content = '- [ ] Submit report +WorkProject\n';
  const { content: out, migrations } = migrateVaultFileSyntax(content, 'task-genius', 'Tasks.md', true);
  assert.equal(out, content, 'unchanged in dry-run');
  assert.equal(migrations.length, 1);
  assert.match(migrations[0].migrated, /\[project:: WorkProject\]/u);
});

// ── Custom checkboxes migration ───────────────────────────────────────────

test('migrateVaultFileSyntax custom-checkboxes: maps [>] to [/]', () => {
  const content = '- [>] Forwarded task\n- [ ] Normal task\n';
  const { content: out, migrations } = migrateVaultFileSyntax(content, 'custom-checkboxes', 'Tasks.md', false);
  assert.match(out, /- \[\/\] Forwarded task/u);
  assert.equal(migrations.length, 1);
});

test('migrateVaultFileSyntax custom-checkboxes: dry-run does not modify content', () => {
  const content = '- [>] Forwarded task\n';
  const { content: out, migrations } = migrateVaultFileSyntax(content, 'custom-checkboxes', 'Tasks.md', true);
  assert.equal(out, content);
  assert.equal(migrations.length, 1);
});

// ── Obsidian Tasks: dedup priority emojis ────────────────────────────────

test('migrateVaultFileSyntax obsidian-tasks: removes duplicate priority emojis', () => {
  const content = '- [ ] Task ⏫ ⏫ Do thing\n';
  const { content: out, migrations } = migrateVaultFileSyntax(content, 'obsidian-tasks', 'Tasks.md', false);
  // Only one ⏫ should remain
  const count = (out.match(/⏫/gu) ?? []).length;
  assert.equal(count, 1, 'exactly one priority emoji after dedup');
  assert.equal(migrations.length, 1);
});

test('migrateVaultFileSyntax obsidian-tasks: single priority emoji unchanged', () => {
  const content = '- [ ] Task ⏫ Do thing\n';
  const { migrations } = migrateVaultFileSyntax(content, 'obsidian-tasks', 'Tasks.md', true);
  assert.equal(migrations.length, 0, 'no changes when priority is not duplicated');
});

// ── migrateVaultFiles batch function ─────────────────────────────────────

test('migrateVaultFiles returns a MigrationReport with correct counts', () => {
  const files = [
    { path: 'a.md', content: '- [ ] Task (@2026-06-01)\n- [ ] No change\n' },
    { path: 'b.md', content: '- [ ] Another (@2026-07-01)\n' },
  ];
  const report = migrateVaultFiles(files, 'reminder', {
    preserveMetadata: true, dryRun: true, conflictResolution: 'skip',
  });
  assert.equal(report.sourceService, 'reminder');
  assert.equal(report.totalTasks, 2);
  assert.equal(report.successfulMigrations, 0);
  assert.equal(report.plannedMigrations, 2);
  assert.equal(report.failedMigrations, 0);
  assert.equal(report.details.length, 2);
  assert.equal(report.details.every((detail) => detail.status === 'planned'), true);
});

test('migrateVaultFiles dry-run does not alter file content', () => {
  const original = '- [ ] Task [due:: 2026-06-01]\n';
  const files = [{ path: 'tasks.md', content: original }];
  migrateVaultFiles(files, 'dataview', {
    preserveMetadata: true, dryRun: true, conflictResolution: 'skip',
  });
  // files[0].content should not be mutated
  assert.equal(files[0].content, original);
});
