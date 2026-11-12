#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const baselinePath = path.join(root, 'quality', 'lint-warning-baseline.json');
const eslintPath = path.join(root, 'node_modules', 'eslint', 'bin', 'eslint.js');
const patterns = ['src', 'scripts', '*.mjs', 'tests/**/*.mjs', 'tests/**/*.ts'];

const result = spawnSync(process.execPath, [eslintPath, '--format', 'json', ...patterns], {
  cwd: root,
  encoding: 'utf8',
  maxBuffer: 100 * 1024 * 1024,
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

const errors = [];
const counts = new Map();
for (const report of reports) {
  const relative = path.relative(root, report.filePath).replaceAll('\\', '/');
  for (const message of report.messages) {
    const rule = message.ruleId ?? 'eslint/unclassified';
    if (message.severity >= 2) {
      errors.push(`${relative}:${message.line}:${message.column} ${rule} — ${message.message}`);
      continue;
    }
    if (message.severity !== 1) continue;
    const byRule = counts.get(relative) ?? new Map();
    byRule.set(rule, (byRule.get(rule) ?? 0) + 1);
    counts.set(relative, byRule);
  }
}

if (errors.length > 0) {
  console.error('Lint errors:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

const entries = {};
let total = 0;
for (const file of [...counts.keys()].sort()) {
  entries[file] = {};
  for (const [rule, count] of [...counts.get(file).entries()].sort(([left], [right]) => left.localeCompare(right))) {
    entries[file][rule] = count;
    total += count;
  }
}
const generated = {
  schemaVersion: 1,
  totalWarnings: total,
  entries,
  policy: 'Counts are maximums keyed by file and rule. New paths/rules or count increases fail; decreases are ratchet opportunities.',
};

if (process.argv.includes('--update')) {
  writeFileSync(baselinePath, `${JSON.stringify(generated, null, 2)}\n`);
  console.log(`Wrote ${total} path/rule-keyed lint warnings to ${path.relative(root, baselinePath)}.`);
  process.exit(0);
}

let baseline;
try {
  baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
} catch (error) {
  console.error(`Unable to read lint warning baseline: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
if (baseline?.schemaVersion !== 1 || !baseline.entries || typeof baseline.totalWarnings !== 'number') {
  console.error('Lint warning baseline has an unsupported schema.');
  process.exit(1);
}

const regressions = [];
const reductions = [];
for (const [file, rules] of Object.entries(entries)) {
  for (const [rule, count] of Object.entries(rules)) {
    const maximum = baseline.entries?.[file]?.[rule];
    if (typeof maximum !== 'number') regressions.push(`${file} ${rule}: new warning category (${count})`);
    else if (count > maximum) regressions.push(`${file} ${rule}: ${count} exceeds baseline ${maximum}`);
  }
}
for (const [file, rules] of Object.entries(baseline.entries)) {
  for (const [rule, maximum] of Object.entries(rules)) {
    const count = entries?.[file]?.[rule] ?? 0;
    if (count < maximum) reductions.push(`${file} ${rule}: ${count} < ${maximum}`);
  }
}
if (total > baseline.totalWarnings) regressions.push(`total warnings: ${total} exceeds baseline ${baseline.totalWarnings}`);

if (reductions.length > 0) regressions.push(`baseline must be lowered for ${reductions.length} reduced path/rule entr${reductions.length === 1 ? 'y' : 'ies'}`);
if (regressions.length > 0) {
  console.error('Lint warning baseline regressions:');
  for (const regression of regressions) console.error(`- ${regression}`);
  console.error('Fix the warning; use --update only after an explicit baseline review.');
  process.exit(1);
}

console.log(`Lint baseline passed: ${total}/${baseline.totalWarnings} warnings across ${Object.keys(entries).length} files; baseline exactly matches the reviewed path/rule inventory.`);
