#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const EXPLICIT_INPUTS = [
  'esbuild.config.mjs',
  'manifest.json',
  'package.json',
  'package-lock.json',
  'scripts/build-config.mjs',
  'scripts/build-styles.mjs',
  'scripts/bundle-normalization.mjs',
  'scripts/source-identity.mjs',
  'styles.css',
  'tsconfig.json',
  'versions.json',
];

function walk(root, relativeDirectory, extension) {
  const directory = path.join(root, relativeDirectory);
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory).sort()) {
    const relative = path.posix.join(relativeDirectory, entry);
    const absolute = path.join(root, relative);
    if (statSync(absolute).isDirectory()) files.push(...walk(root, relative, extension));
    else if (relative.endsWith(extension)) files.push(relative);
  }
  return files;
}

export function sourceIdentityInputs(root = process.cwd()) {
  return [...new Set([
    ...EXPLICIT_INPUTS.filter((relative) => existsSync(path.join(root, relative))),
    ...walk(root, 'src', '.ts'),
    ...walk(root, 'styles', '.css'),
  ])].sort();
}

export function computeSourceIdentity(root = process.cwd()) {
  const files = sourceIdentityInputs(root);
  const hash = createHash('sha256');
  for (const relative of files) {
    const normalized = readFileSync(path.join(root, relative), 'utf8').replace(/\r\n?/gu, '\n');
    hash.update(relative.replaceAll('\\', '/')).update('\0').update(normalized).update('\0');
  }
  const sha256 = hash.digest('hex');
  return { sha256, short: sha256.slice(0, 12), files };
}

export function sourceRevision(root = process.cwd()) {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(); }
  catch { return 'unavailable'; }
}

export function gitDirtyPaths(root = process.cwd()) {
  try {
    return execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: root, encoding: 'utf8' })
      .split(/\r?\n/u).map((line) => line.trim()).filter(Boolean)
      .filter((line) => !/(?:^|\s)(?:release|benchmark-results|coverage|\.test-runs)\//u.test(line.slice(3)));
  } catch { return ['git-status-unavailable']; }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const identity = computeSourceIdentity();
  console.log(JSON.stringify({ ...identity, sourceRevision: sourceRevision(), dirty: gitDirtyPaths().length > 0 }, null, 2));
}
