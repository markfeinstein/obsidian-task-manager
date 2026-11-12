#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

export function moduleDebt(source) {
  const normalized = source.replace(/\r\n?/gu, '\n');
  const lines = normalized.endsWith('\n') ? normalized.slice(0, -1).split('\n').length : normalized.split('\n').length;
  const imports = (normalized.match(/^import\b/gmu) ?? []).length;
  return { lines, imports };
}

export function checkModuleDebt(root = process.cwd()) {
  const baseline = JSON.parse(readFileSync(path.join(root, 'quality/module-debt-baseline.json'), 'utf8'));
  const errors = [];
  const measured = {};
  for (const [file, limits] of Object.entries({ ...baseline.hotspots, ...baseline.extractedModules })) {
    const debt = moduleDebt(readFileSync(path.join(root, file), 'utf8'));
    measured[file] = debt;
    if (debt.lines > limits.maxLines) errors.push(`${file} lines ${debt.lines} exceed ${limits.maxLines}`);
    if (debt.imports > limits.maxImports) errors.push(`${file} imports ${debt.imports} exceed ${limits.maxImports}`);
  }
  return { errors, measured };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const result = checkModuleDebt();
  if (result.errors.length > 0) {
    console.error('Module debt check failed:');
    for (const error of result.errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log(`Module debt check passed (${Object.keys(result.measured).length} exact module budgets).`);
}
