import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = process.cwd();
const removedModules = [
  'ai-extractor.ts',
  'asana-sync.ts',
  'completion-recommendations.ts',
  'conflict-resolver.ts',
  'focus-mode.ts',
  'mcp-server.ts',
  'slack-notifier.ts',
  'sync-capabilities.ts',
  'teams-notifier.ts',
  'webhook-notifier.ts',
];

test('unsupported production-unreachable modules stay deleted', async () => {
  for (const moduleName of removedModules) {
    await assert.rejects(access(path.join(root, 'src', moduleName)), { code: 'ENOENT' }, moduleName);
  }

  const [types, normalizer, main, docs] = await Promise.all([
    readFile(path.join(root, 'src/types.ts'), 'utf8'),
    readFile(path.join(root, 'src/settings-normalizer.ts'), 'utf8'),
    readFile(path.join(root, 'src/main.ts'), 'utf8'),
    readFile(path.join(root, 'docs/MCP.md'), 'utf8'),
  ]);
  assert.doesNotMatch(types, /mcpServer(?:Enabled|Port|Token)/u);
  assert.doesNotMatch(normalizer, /mcpServer(?:Enabled|Port|Token)/u);
  assert.doesNotMatch(main, /from ['"].*(?:ai-extractor|asana-sync|mcp-server|slack-notifier|teams-notifier|webhook-notifier)['"]/u);
  assert.match(docs, /scripts\/mcp-companion\.mjs`? is the only repository-owned MCP server implementation/u);
});

test('runtime import graph has no cycles or reverse composition edges', async () => {
  const output = execFileSync(process.execPath, ['scripts/check-architecture.mjs'], { cwd: root, encoding: 'utf8' });
  assert.match(output, /Architecture boundary check passed/u);
  const [settings, normalizer] = await Promise.all([
    readFile(path.join(root, 'src/settings.ts'), 'utf8'),
    readFile(path.join(root, 'src/settings-normalizer.ts'), 'utf8'),
  ]);
  assert.doesNotMatch(settings, /from ['"]\.\/main['"]/u);
  assert.match(settings, /SettingsHost/u);
  assert.match(normalizer, /import type \{[\s\S]*\} from ['"]\.\/types['"]/u);
  assert.doesNotMatch(normalizer, /^import \{[^;]+\} from ['"]\.\/types['"]/mu);
});

test('architecture policy classifies every module exactly once with exact exceptions', async () => {
  const config = JSON.parse(await readFile(path.join(root, 'quality/architecture-layers.json'), 'utf8'));
  const exceptions = JSON.parse(await readFile(path.join(root, 'quality/architecture-exceptions.json'), 'utf8'));
  const listed = config.layers.flatMap((layer) => layer.files);
  const walk = async (directory) => (await import('node:fs/promises')).readdir(directory, { withFileTypes: true }).then(async (entries) => (await Promise.all(entries.map(async (entry) => {
    const absolute = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(absolute) : entry.name.endsWith('.ts') ? [path.relative(path.join(root, 'src'), absolute).replaceAll('\\', '/')] : [];
  }))).flat());
  const actual = await walk(path.join(root, 'src'));
  assert.deepEqual([...listed].sort(), actual.sort());
  assert.equal(new Set(listed).size, listed.length);
  assert.ok(config.layers.every((layer) => !('patterns' in layer)));
  assert.deepEqual(exceptions.exceptions, []);
  for (const file of ['google-calendar-setup-wizard.ts', 'google-tasks-oauth-modal.ts', 'microsoft-todo-oauth-modal.ts']) {
    const source = await readFile(path.join(root, 'src/modals', file), 'utf8');
    assert.doesNotMatch(source, /from ['"]\.\.\/main['"]/u);
  }
});

test('strict ISO date primitives stay dependency-free', async () => {
  const source = await readFile(path.join(root, 'src/iso-date.ts'), 'utf8');
  assert.doesNotMatch(source, /from ['"](?:obsidian|chrono-node|\.\/main|\.\/state-store|\.\/.*renderer)['"]/u);
  assert.doesNotMatch(source, /\bdocument\b|\bwindow\b/u);
});

test('dashboard stored-model boundaries stay independent from views and state', async () => {
  const sources = await Promise.all([
    'dashboard-model.ts',
    'dashboard-persistence.ts',
    'dashboard-registry.ts',
  ].map((name) => readFile(path.join(root, 'src', name), 'utf8')));
  for (const source of sources) {
    assert.doesNotMatch(source, /from ['"](?:obsidian|\.\/main|\.\/state-store|\.\/.*(?:renderer|view))['"]/u);
    assert.doesNotMatch(source, /\bdocument\b|\bwindow\b|\bHTMLElement\b/u);
  }
});

test('composition roots consume focused scan and dashboard layout boundaries', async () => {
  const [main, dashboard, editor] = await Promise.all([
    readFile(path.join(root, 'src/main.ts'), 'utf8'),
    readFile(path.join(root, 'src/dashboard.ts'), 'utf8'),
    readFile(path.join(root, 'src/modals/task-edit-modal.ts'), 'utf8'),
  ]);

  assert.match(main, /from ['"]\.\/scan-coordinator['"]/u);
  assert.match(main, /collectVaultScanWork\(/u);
  assert.match(dashboard, /from ['"]\.\/dashboard-layout['"]/u);
  assert.match(dashboard, /export \* from ['"]\.\/dashboard-layout['"]/u);
  assert.match(dashboard, /export \* from ['"]\.\/dashboard-model['"]/u);
  assert.match(dashboard, /export \* from ['"]\.\/dashboard-persistence['"]/u);
  assert.match(dashboard, /export \* from ['"]\.\/dashboard-registry['"]/u);
  assert.doesNotMatch(editor, /style\.cssText/u, 'static task-editor presentation belongs to styles.css');
  const assignedStyleProperties = Array.from(editor.matchAll(/\.style\.([A-Za-z]+)\s*=/gu), (match) => match[1]);
  assert.deepEqual(assignedStyleProperties, ['insetInlineStart', 'insetBlockStart'], 'only measured logical autocomplete geometry remains inline');
});
