#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync, spawnSync } from 'node:child_process';

const root = process.cwd();
const lintable = /^(?:[^/]+\.mjs|(?:src|scripts|tests)\/.*\.(?:ts|mjs))$/u;

function git(args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function refExists(ref) {
  try {
    git(['rev-parse', '--verify', '--quiet', ref]);
    return true;
  } catch {
    return false;
  }
}

const untracked = git(['ls-files', '--others', '--exclude-standard'])
  .split('\n').map((file) => file.trim()).filter(Boolean);
const dirtyLintFiles = [
  ...git(['diff', '--name-only', 'HEAD']).split('\n'),
  ...untracked,
].map((file) => file.trim()).filter((file) => lintable.test(file));
const dirty = dirtyLintFiles.length > 0;
let diffSpec;
const requestedBase = process.env.LINT_BASE_REF?.trim();
const usableRequestedBase = Boolean(requestedBase && !/^0{40}$/u.test(requestedBase) && refExists(requestedBase));
if (usableRequestedBase) diffSpec = [`${requestedBase}...HEAD`];
else if (process.env.GITHUB_BASE_REF && refExists(`origin/${process.env.GITHUB_BASE_REF}`)) diffSpec = [`origin/${process.env.GITHUB_BASE_REF}...HEAD`];
else if (dirty) diffSpec = ['HEAD'];
else if (refExists('HEAD^')) {
  if (requestedBase) console.warn(`Changed-line lint: unusable base ${requestedBase}; falling back to HEAD^.`);
  diffSpec = ['HEAD^', 'HEAD'];
} else {
  console.log('Changed-line lint: no usable prior revision; full lint still applies, skipping changed-line-only lint.');
  process.exit(0);
}

const untrackedSet = new Set(untracked.filter((file) => lintable.test(file)));
const files = [...new Set([
  ...git(['diff', '--name-only', '--diff-filter=ACMR', ...diffSpec]).split('\n'),
  ...untracked,
])]
  .map((file) => file.trim())
  .filter((file) => lintable.test(file) && existsSync(path.join(root, file)));
if (files.length === 0) {
  console.log('Changed-line lint: no changed TypeScript or module files.');
  process.exit(0);
}

const addedLines = new Map();
for (const file of files) {
  if (untrackedSet.has(file)) {
    const lineCount = readFileSync(path.join(root, file), 'utf8').split('\n').length;
    addedLines.set(file, [[1, lineCount]]);
    continue;
  }
  const patch = git(['diff', '--unified=0', ...diffSpec, '--', file]);
  const ranges = [];
  for (const match of patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gmu)) {
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (count > 0) ranges.push([start, start + count - 1]);
  }
  addedLines.set(file, ranges);
}

const eslint = path.join(root, 'node_modules', 'eslint', 'bin', 'eslint.js');
const result = spawnSync(process.execPath, [eslint, '--format', 'json', ...files], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 50 * 1024 * 1024,
});
if (result.error) throw result.error;
let reports;
try {
  reports = JSON.parse(result.stdout || '[]');
} catch {
  process.stderr.write(result.stderr ?? '');
  process.stdout.write(result.stdout ?? '');
  process.exit(result.status ?? 1);
}

const regressions = [];
for (const report of reports) {
  const relative = path.relative(root, report.filePath).replaceAll('\\', '/');
  const ranges = addedLines.get(relative) ?? [];
  for (const message of report.messages) {
    if (message.severity < 1 || !ranges.some(([start, end]) => message.line >= start && message.line <= end)) continue;
    regressions.push(`${relative}:${message.line}:${message.column} ${message.ruleId ?? 'eslint'} — ${message.message}`);
  }
}

if (regressions.length > 0) {
  console.error('Changed-line lint found new warnings/errors:');
  for (const regression of regressions) console.error(`- ${regression}`);
  process.exit(1);
}
console.log(`Changed-line lint passed for ${files.length} changed file${files.length === 1 ? '' : 's'}.`);
