#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { validateBundleSize, validateBundleSource, validateInitialAssetBudgets, validateReleaseMetadata, validateRequiredReleaseFiles } from './package-helpers.mjs';
import { computeSourceIdentity } from './source-identity.mjs';
import { composeStyles } from './build-styles.mjs';

const root = process.cwd();
const assetBudgets = JSON.parse(readFileSync(path.join(root, 'quality', 'asset-budgets.json'), 'utf8'));
const errors = [
  ...validateRequiredReleaseFiles(root),
  ...validateReleaseMetadata(root),
  ...validateBundleSize(root),
  ...validateInitialAssetBudgets(root, assetBudgets),
];
const expectedStyles = await composeStyles(root);
const trackedStylesPath = path.join(root, 'styles.css');
if (existsSync(trackedStylesPath) && readFileSync(trackedStylesPath, 'utf8') !== expectedStyles.output) {
  errors.push('styles.css is out of date with ordered styles/*.css partials; run npm run build:styles');
}
const bundlePath = path.join(root, 'main.js');
if (existsSync(bundlePath)) {
  const bundle = readFileSync(bundlePath, 'utf8');
  errors.push(...validateBundleSource(bundle));
  const identity = computeSourceIdentity(root);
  if (!bundle.includes(identity.sha256)) errors.push(`main.js does not embed current source content identity ${identity.sha256}`);
}
if (errors.length > 0) {
  console.error('Package validation failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

for (const syntaxTarget of [bundlePath, path.join(root, 'scripts', 'mcp-companion.mjs')]) {
  const syntax = spawnSync(process.execPath, ['--check', syntaxTarget], { cwd: root, stdio: 'inherit' });
  if (syntax.status !== 0) process.exit(syntax.status ?? 1);
}
const mockRoot = mkdtempSync(path.join(tmpdir(), 'task-manager-package-'));
try {
  const mockNodeModules = path.join(mockRoot, 'node_modules');
  const obsidianMock = path.join(mockNodeModules, 'obsidian');
  mkdirSync(obsidianMock, { recursive: true });
  copyFileSync(path.join(root, 'tests', 'obsidian-mock.js'), path.join(obsidianMock, 'index.js'));
  const loadScript = `const plugin=require(${JSON.stringify(bundlePath)});if(typeof plugin.default!=="function"||typeof plugin.default.prototype.onload!=="function")throw new Error("bundle does not export an Obsidian plugin with onload");`;
  const load = spawnSync(process.execPath, ['-e', loadScript], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, NODE_PATH: mockNodeModules },
  });
  if (load.status !== 0) process.exitCode = load.status ?? 1;
  else console.log('Package validation passed (schema, size, syntax, mobile-safe externals, and load smoke).');
} finally {
  rmSync(mockRoot, { recursive: true, force: true });
}
