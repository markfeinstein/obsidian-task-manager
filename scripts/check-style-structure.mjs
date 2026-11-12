#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const root = process.cwd();
const sourceDir = path.join(root, 'styles');
const baselinePath = path.join(root, 'quality', 'style-structure-baseline.json');
const files = readdirSync(sourceDir).filter((name) => name.endsWith('.css')).sort();
const selectors = new Map();
for (const file of files) {
  const css = readFileSync(path.join(sourceDir, file), 'utf8').replace(/\/\*[\s\S]*?\*\//gu, '');
  for (const match of css.matchAll(/([^{}]+)\{[^{}]*\}/gu)) {
    const selector = match[1].replace(/\s+/gu, ' ').trim();
    if (!selector || selector.startsWith('@')) continue;
    const byFile = selectors.get(selector) ?? {};
    byFile[file] = (byFile[file] ?? 0) + 1;
    selectors.set(selector, byFile);
  }
}
const selectorCounts = Object.fromEntries([...selectors.entries()].sort(([a], [b]) => a.localeCompare(b)));
const duplicateDeclarations = Object.values(selectorCounts).reduce((sum, byFile) => sum + Math.max(0, Object.values(byFile).reduce((n, count) => n + count, 0) - 1), 0);
const crossFileSelectors = Object.values(selectorCounts).filter((byFile) => Object.keys(byFile).length > 1).length;
const generated = { schemaVersion: 1, files, duplicateDeclarations, crossFileSelectors, selectorCounts };
if (process.argv.includes('--update')) {
  writeFileSync(baselinePath, `${JSON.stringify(generated, null, 2)}\n`);
  console.log(`Wrote style structure baseline: ${duplicateDeclarations} duplicate declarations, ${crossFileSelectors} cross-file selectors.`);
  process.exit(0);
}
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const errors = [];
if (duplicateDeclarations > baseline.duplicateDeclarations) errors.push(`duplicate declarations ${duplicateDeclarations} exceed ${baseline.duplicateDeclarations}`);
if (crossFileSelectors > baseline.crossFileSelectors) errors.push(`cross-file selectors ${crossFileSelectors} exceed ${baseline.crossFileSelectors}`);
for (const [selector, byFile] of Object.entries(selectorCounts)) {
  const total = Object.values(byFile).reduce((sum, count) => sum + count, 0);
  const previous = baseline.selectorCounts?.[selector];
  const previousTotal = previous ? Object.values(previous).reduce((sum, count) => sum + count, 0) : 0;
  if (total > 1 && total > previousTotal) errors.push(`selector duplication increased: ${selector} (${total} > ${previousTotal})`);
}
if (errors.length > 0) {
  console.error('Style structure regressions:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log(`Style structure passed: ${duplicateDeclarations}/${baseline.duplicateDeclarations} duplicates; ${crossFileSelectors}/${baseline.crossFileSelectors} cross-file selectors.`);
