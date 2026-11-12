import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const read = (file) => readFileSync(file, 'utf8');
const sourceFiles = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
  const file = `${directory}/${entry.name}`;
  if (entry.isDirectory()) return sourceFiles(file);
  return entry.isFile() && file.endsWith('.ts') ? [file] : [];
});

void test('legal and ownership metadata are consistent', () => {
  const packageJson = JSON.parse(read('package.json'));
  const manifest = JSON.parse(read('manifest.json'));
  assert.equal(packageJson.license, 'MIT');
  assert.equal(packageJson.author, 'Mark Feinstein');
  assert.equal(manifest.author, 'Mark Feinstein');
  assert.equal(packageJson.repository, 'https://github.com/markfeinstein/obsidian-task-manager');
  assert.equal(packageJson.homepage, 'https://github.com/markfeinstein/obsidian-task-manager');
  assert.equal(packageJson.bugs, 'https://github.com/markfeinstein/obsidian-task-manager/issues');
  assert.match(read('LICENSE'), /^MIT License/mu);
});

void test('production sources avoid noisy console output and document-writing APIs', () => {
  const source = sourceFiles('src').map(read).join('\n');
  assert.doesNotMatch(source, /\bconsole\.(?:log|debug|info)\s*\(/u);
  assert.doesNotMatch(source, /\bdocument\.write\s*\(/u);
});

void test('sample vault release fixtures match root and keep network/reminders off', () => {
  const sampleRoot = 'sample-vault/.obsidian/plugins/task-manager';
  assert.equal(read(`${sampleRoot}/manifest.json`), read('manifest.json'));
  assert.equal(read(`${sampleRoot}/versions.json`), read('versions.json'));
  assert.equal(read(`${sampleRoot}/styles.css`), read('styles.css'));
  const data = JSON.parse(read(`${sampleRoot}/data.json`));
  assert.equal(data.settings.enableReminderNotifications, false);
  for (const key of ['todoistSyncEnabled', 'caldavSyncEnabled', 'googleTasksEnabled', 'googleCalendarEnabled', 'msToDoEnabled', 'appleRemindersEnabled', 'aiQueryEnabled']) {
    assert.equal(data.settings[key], false, `${key} must be disabled in the sample`);
  }
  assert.equal(/(?:token|password|apiKey)"\s*:\s*"[^"\s]+/iu.test(read(`${sampleRoot}/data.json`)), false);
});

void test('active docs do not claim unverified Community Plugins or third-party companion availability', () => {
  const readme = read('README.md');
  const install = read('docs/INSTALLATION.md');
  const mobile = read('docs/mobile.md');
  assert.match(readme, /pre-release/u);
  assert.match(install, /Install manually/u);
  assert.equal(/100% compatible/iu.test(mobile), false);
  assert.equal(/TaskForge companion app \(Recommended/iu.test(mobile), false);
});

void test('pre-publication identity transition is explicit and has no runtime CLI bridge', () => {
  const installation = read('docs/INSTALLATION.md');
  const cli = read('src/cli-handler.ts');
  const dashboard = read('src/dashboard.ts');
  assert.match(installation, /Pre-publication evaluator transition from `obsidian-task-manager`/u);
  assert.match(installation, /\.obsidian\/plugins\/obsidian-task-manager/u);
  assert.match(installation, /\.obsidian\/plugins\/task-manager/u);
  assert.match(installation, /copy the backed-up old `data\.json` as a whole/u);
  assert.match(installation, /both identities cannot load together/u);
  assert.match(installation, /`obsidian-task-manager:query` to `task-manager:query`/u);
  assert.match(cli, /'task-manager:query'/u);
  assert.doesNotMatch(cli, /'obsidian-task-manager:query'/u);
  assert.doesNotMatch(dashboard, /obsidian-task-manager:/u);
});

void test('MCP implementation version agrees across package, runtime, and docs', () => {
  const packageJson = JSON.parse(read('package.json'));
  const companion = read('scripts/mcp-companion.mjs');
  const documentation = read('docs/MCP.md');
  assert.ok(companion.includes(`const COMPANION_VERSION = '${packageJson.version}'`));
  assert.ok(documentation.includes(`Companion implementation version: \`${packageJson.version}\``));
});

test('privacy and maintainer release references exist in the documentation index', () => {
  const index = read('docs/INDEX.md');
  assert.ok(index.includes('PRIVACY.md'));
  assert.ok(index.includes('RELEASING.md'));
  const releasing = read('docs/RELEASING.md');
  assert.match(releasing, /OBSIDIAN_RELEASE_STAGE=initial-submission/u);
  assert.match(releasing, /OBSIDIAN_RELEASE_STAGE=ga/u);
  assert.match(releasing, /does not bypass source, test, packaging, checksum, version, benchmark, or attestation checks/u);
});
