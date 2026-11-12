import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { configurations, templates, prepareVisual, validateVisual } from '../scripts/obsidian-desktop-visual.mjs';

async function fixture(context, family) {
  const root = await fs.mkdtemp(path.join(await fs.realpath(os.tmpdir()), 'task-manager-visual-test-'));
  context.after(() => fs.rm(root, { recursive: true }));
  const app = path.join(root, 'Obsidian.app');
  await fs.mkdir(path.join(app, 'Contents/MacOS'), { recursive: true });
  await fs.writeFile(path.join(app, 'Contents/MacOS/Obsidian'), 'Non-executable unit fixture. Never launch.');
  const prepared = await prepareVisual({ app, version: '1.15.0', parent: root, family });
  return { file: prepared.session, session: await validateVisual(prepared.session, true) };
}

test('desktop visual matrix declares seven templates and the six required configurations', () => {
  assert.equal(templates.length, 7);
  assert.equal(configurations.length, 6);
  assert.equal(new Set(configurations.map(c => c.id)).size, 6);
  assert.deepEqual(configurations.filter(c => c.theme === 'native').map(c => [c.density, c.appearance]), [
    ['compact', 'light'], ['comfortable', 'light'], ['spacious', 'light'], ['comfortable', 'dark'],
  ]);
});
for (const family of ['normal', 'empty', 'dense']) test(`visual ${family} fixtures are fresh pinned synthetic notes with independent backups`, async context => {
  const { session } = await fixture(context, family);
  assert.equal(session.purpose, 'visual');
  assert.equal(session.visual.expectedTasks, family === 'normal' ? 62 : family === 'dense' ? 182 : 0);
  for (const name of Object.keys(session.visual.noteHashes)) assert.deepEqual(
    await fs.readFile(path.join(session.vault, name)), await fs.readFile(path.join(session.folder, 'visual-initial-notes', name)));
  const data = JSON.parse(await fs.readFile(path.join(session.vault, '.obsidian/plugins/task-manager/data.json'), 'utf8'));
  assert.equal(data.settings.aiQueryEnabled, false);
  assert.equal(data.settings.enableReminderNotifications, false);
  assert.match(await fs.readFile(path.join(session.vault, 'Visual Error.md'), 'utf8'), /this is not JSON/u);
});

test('visual runtime validation refuses changed nested notes and nonvisual sessions', async context => {
  const { file, session } = await fixture(context, 'normal');
  await fs.appendFile(path.join(session.vault, 'Projects/Website Redesign.md'), 'Unexpected change\n');
  await assert.rejects(validateVisual(file, true), /Visual initial note changed/u);
  session.purpose = 'other'; await fs.writeFile(file, JSON.stringify(session));
  await assert.rejects(validateVisual(file), /generated visual session/u);
  await assert.rejects(prepareVisual({ family: 'unknown' }), /fixture family/u);
});
