import test from 'node:test';
import assert from 'node:assert/strict';
import { CliHandler } from '../src/cli-handler';
import { TaskScanner } from '../src/task-scanner';
import { DEFAULT_SETTINGS, type TaskManagerSettings } from '../src/types';
import { MockApp } from './test-utils';

function scanner(): TaskScanner {
  return new TaskScanner({} as never);
}

function settings(patch: Partial<TaskManagerSettings> = {}): TaskManagerSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...patch,
  } as TaskManagerSettings;
}

test('cli-handler: supplies metadata-backed fileInfoProvider to query filters', async () => {
  const app = new MockApp() as never as MockApp;
  app.vault.files.set('Projects/Alpha.md', { content: '- [ ] Alpha', mtime: Date.now() });
  app.metadataCache.setFileCache('Projects/Alpha.md', {
    frontmatter: { area: 'work' },
    links: [{ link: 'Target' }],
  } as never);
  const parsed = scanner().parseTaskLine('- [ ] Alpha', 'Projects/Alpha.md', 1);
  assert.ok(parsed);
  const handler = new CliHandler(
    app as never,
    scanner(),
    () => settings({ enableQueryDsl: true, enableDslExpressions: true }),
    () => [parsed],
  );

  const byProperty = await handler.executeQuery('filter by function task.file.property("area") === "work"');
  const byOutlink = await handler.executeQuery('filter by function task.file.outlinks.includes("[[Target]]")');

  assert.equal(byProperty.success, true);
  assert.equal(byProperty.data?.count, 1);
  assert.equal(byOutlink.success, true);
  assert.equal(byOutlink.data?.count, 1);
});

test('cli-handler: supplies saved query presets to parser', async () => {
  const app = new MockApp() as never as MockApp;
  const openTask = scanner().parseTaskLine('- [ ] Open task', 'Tasks.md', 1);
  const doneTask = scanner().parseTaskLine('- [x] Done task', 'Tasks.md', 2);
  assert.ok(openTask);
  assert.ok(doneTask);
  const tasks = [openTask, doneTask];
  const handler = new CliHandler(
    app as never,
    scanner(),
    () => settings({ savedQueries: [{ name: 'OpenOnly', query: 'not done' }] }),
    () => tasks,
  );

  const result = await handler.executeQuery('preset OpenOnly');

  assert.equal(result.success, true);
  assert.deepEqual(result.data?.tasks.map((task) => task.normalizedText), ['Open task']);
});
