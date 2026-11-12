import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { buildCycloneDxSbom } from '../scripts/generate-sbom.mjs';
import {
  REQUIRED_RELEASE_FILES,
  createReleaseDirectory,
  findOutdatedReleaseArtifacts,
  sha256File,
  validateBundleSize,
  validateBundleSource,
  validateInitialAssetBudgets,
  validateManifestSchema,
  validateRequiredReleaseFiles,
  validateStagedRelease,
  validateVersionConsistency,
} from '../scripts/package-helpers.mjs';

test('release output reservation is create-once and preserves existing evidence', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'task-manager-release-preserve-'));
  const output = path.join(root, 'release');
  createReleaseDirectory(output);
  assert.equal(statSync(output).isDirectory(), true);
  const sentinel = path.join(output, 'previous-source.zip');
  writeFileSync(sentinel, 'preserved archive');
  const original = sha256File(sentinel);
  assert.throws(() => createReleaseDirectory(output), /Refusing to replace existing release output/u);
  assert.equal(sha256File(sentinel), original);
  const source = readFileSync('scripts/package-release.mjs', 'utf8');
  assert.doesNotMatch(source, /rmSync/u);
  assert.match(source, /createReleaseDirectory\(releaseRoot\)/u);
});

test('release output reservation refuses a symlink without changing its target', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'task-manager-release-link-'));
  const target = path.join(root, 'retained'); mkdirSync(target);
  const sentinel = path.join(target, 'prior.zip'); writeFileSync(sentinel, 'retain');
  symlinkSync(target, path.join(root, 'release'), 'dir');
  assert.throws(() => createReleaseDirectory(path.join(root, 'release')), /Refusing to replace/u);
  assert.equal(readFileSync(sentinel, 'utf8'), 'retain');
});

test('release metadata accepts matching package, manifest, and versions entries', () => {
  assert.deepEqual(
    validateVersionConsistency({
      packageJson: { version: '1.2.3' },
      packageLockJson: { version: '1.2.3', packages: { '': { version: '1.2.3' } } },
      manifestJson: { version: '1.2.3', minAppVersion: '1.5.0' },
      versionsJson: { '1.2.3': '1.5.0' },
    }),
    [],
  );
});

test('release metadata reports version and min app mismatches', () => {
  assert.deepEqual(
    validateVersionConsistency({
      packageJson: { version: '1.2.4' },
      packageLockJson: { version: '1.2.3', packages: { '': { version: '1.2.2' } } },
      manifestJson: { version: '1.2.3', minAppVersion: '1.5.0' },
      versionsJson: { '1.2.3': '1.4.0' },
    }),
    [
      'package.json version (1.2.4) must match manifest.json version (1.2.3)',
      'package-lock.json version (1.2.3) must match package.json version (1.2.4)',
      'package-lock root package version (1.2.2) must match package.json version (1.2.4)',
      'versions.json must map 1.2.3 to manifest minAppVersion 1.5.0',
    ],
  );
});

test('release file validation reports missing package artifacts', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'task-manager-release-'));
  writeFileSync(path.join(rootDir, 'main.js'), '', 'utf8');

  assert.deepEqual(
    validateRequiredReleaseFiles(rootDir, ['main.js', 'manifest.json']),
    ['main.js must be tracked by git', 'manifest.json is missing'],
  );
  assert.deepEqual(REQUIRED_RELEASE_FILES, ['main.js', 'manifest.json', 'versions.json', 'styles.css']);
});

test('manifest schema accepts a valid mobile-compatible manifest', () => {
  assert.deepEqual(validateManifestSchema({
    id: 'task-manager',
    name: 'Task Manager',
    version: '1.2.3',
    minAppVersion: '1.5.0',
    description: 'Tasks',
    author: 'Maintainer',
    authorUrl: 'https://example.com',
    isDesktopOnly: false,
  }), []);
});

test('manifest schema reports malformed fields', () => {
  const errors = validateManifestSchema({
    id: 'Bad ID', version: 'one', minAppVersion: '1.5', isDesktopOnly: 'false', authorUrl: 'http://example.com',
  });
  assert.ok(errors.some((error) => error.includes('id must use lowercase')));
  assert.ok(errors.some((error) => error.includes('version must be a semantic version')));
  assert.ok(errors.some((error) => error.includes('isDesktopOnly must be boolean')));
  assert.ok(errors.some((error) => error.includes('authorUrl must use HTTPS')));
});

test('manifest schema rejects Community Plugins id rule violations', () => {
  const obsidianId = validateManifestSchema({
    id: 'obsidian-task-manager', name: 'Task Manager', version: '1.0.0', minAppVersion: '1.11.4', description: 'Tasks', author: 'Maintainer',
  });
  assert.ok(obsidianId.some((error) => error.includes('must not contain "obsidian"')));
  const pluginSuffix = validateManifestSchema({
    id: 'my-task-plugin', name: 'Task Manager', version: '1.0.0', minAppVersion: '1.11.4', description: 'Tasks', author: 'Maintainer',
  });
  assert.ok(pluginSuffix.some((error) => error.includes('must not end with "plugin"')));
});

test('bundle size and package file-set validation reject release regressions', () => {
  const rootDir = mkdtempSync(path.join(tmpdir(), 'task-manager-package-'));
  writeFileSync(path.join(rootDir, 'main.js'), '1234', 'utf8');
  assert.deepEqual(validateBundleSize(rootDir, 3), ['main.js is 4 bytes, exceeding the 3-byte release limit']);
  assert.deepEqual(validateBundleSize(rootDir, 4), []);
  writeFileSync(path.join(rootDir, 'styles.css'), '12', 'utf8');
  assert.deepEqual(validateInitialAssetBudgets(rootDir, { mainJsBytes: 4, stylesCssBytes: 2, totalInitialBytes: 6 }), []);
  assert.deepEqual(validateInitialAssetBudgets(rootDir, { mainJsBytes: 3, stylesCssBytes: 1, totalInitialBytes: 5 }), [
    'main.js is 4 bytes, exceeding the 3-byte initial asset budget',
    'styles.css is 2 bytes, exceeding the 1-byte initial asset budget',
    'initial JS+CSS is 6 bytes, exceeding the 5-byte total budget',
  ]);
  assert.deepEqual(validateBundleSource('safe bundle'), []);
  assert.deepEqual(validateBundleSource('import("node:http")'), ['main.js contains desktop-only production dependency marker: node:http']);
  assert.deepEqual(validateBundleSource('/(?<=\\s)#tag/u'), ['main.js contains regex lookbehind incompatible with the supported older-mobile runtime: (?<=']);
  assert.deepEqual(validateBundleSource('/(?<!\\d)date/u'), ['main.js contains regex lookbehind incompatible with the supported older-mobile runtime: (?<!']);

  const packageDir = path.join(rootDir, 'package');
  mkdirSync(packageDir);
  for (const file of REQUIRED_RELEASE_FILES) writeFileSync(path.join(packageDir, file), file, 'utf8');
  assert.deepEqual(validateStagedRelease(packageDir), []);
  writeFileSync(path.join(packageDir, 'extra.txt'), '', 'utf8');
  assert.ok(validateStagedRelease(packageDir)[0].includes('must contain exactly'));
  assert.equal(sha256File(path.join(rootDir, 'main.js')), '03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4');
});

test('CycloneDX SBOM is deterministic and includes only graph contributors plus host externals', () => {
  const packageJson = { name: 'example', version: '1.2.3', devDependencies: { obsidian: '1.0.0' } };
  const packageLock = { packages: {
    '': { name: 'example', version: '1.2.3' },
    'node_modules/dep': { name: 'dep', version: '2.0.0', license: 'MIT' },
    'node_modules/dev-only': { name: 'dev-only', version: '3.0.0', dev: true },
  } };
  const metafile = { inputs: { 'node_modules/dep/index.js': { bytes: 100, imports: [] } }, outputs: { 'main.js': { inputs: { 'node_modules/dep/index.js': { bytesInOutput: 42 } }, imports: [] } } };
  const first = buildCycloneDxSbom(packageJson, packageLock, metafile);
  const second = buildCycloneDxSbom(packageJson, packageLock, metafile);
  assert.deepEqual(first, second);
  assert.equal(first.bomFormat, 'CycloneDX');
  const dep = first.components.find((component) => component.name === 'dep');
  assert.equal(dep?.purl, 'pkg:npm/dep@2.0.0');
  assert.deepEqual(dep?.licenses, [{ license: { id: 'MIT' } }]);
  assert.ok(dep?.properties.some((property) => property.name === 'task-manager:bytes-in-output' && property.value === '42'));
  assert.equal(first.components.some((component) => component.name === 'dev-only'), false);
  assert.ok(first.components.some((component) => component.name === 'obsidian'));
});

test('package release script exposes raw install assets in metadata and checksums', () => {
  const source = readFileSync('scripts/package-release.mjs', 'utf8');
  assert.match(source, /const INSTALL_ASSETS = \['manifest\.json', 'main\.js', 'styles\.css'\]/u);
  assert.match(source, /installAssets: INSTALL_ASSETS/u);
  assert.match(source, /\.\.\.INSTALL_ASSETS\.map/u);
  assert.match(source, /copyFileSync\(path\.join\(root, file\), path\.join\(releaseRoot, file\)\)/u);
});

test('findOutdatedReleaseArtifacts flags only the artifacts that differ from HEAD', () => {
  const required = ['main.js', 'manifest.json', 'versions.json', 'styles.css'];
  const result = findOutdatedReleaseArtifacts('/repo', required, () => ['main.js', 'styles.css']);
  assert.deepEqual(result, ['main.js', 'styles.css']);
});

test('findOutdatedReleaseArtifacts returns empty when artifacts match HEAD', () => {
  assert.deepEqual(findOutdatedReleaseArtifacts('/repo', ['main.js', 'manifest.json'], () => []), []);
});

test('findOutdatedReleaseArtifacts ignores unrelated changed files reported by git', () => {
  const result = findOutdatedReleaseArtifacts('/repo', ['main.js'], () => ['src/main.ts', 'README.md']);
  assert.deepEqual(result, []);
});
