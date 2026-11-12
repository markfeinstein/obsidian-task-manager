#!/usr/bin/env node
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const root = process.cwd();
const baselinePath = path.join(root, 'quality', 'style-debt-baseline.json');

function walk(directory) {
  const result = [];
  for (const name of readdirSync(directory)) {
    const absolute = path.join(directory, name);
    if (statSync(absolute).isDirectory()) result.push(...walk(absolute));
    else if (name.endsWith('.ts')) result.push(absolute);
  }
  return result;
}

function literalLike(node) {
  return ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node);
}

function inlineStyleDebt(file, source) {
  const ast = ts.createSourceFile(path.basename(file), source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const counts = new Map();
  const add = (key) => counts.set(key, (counts.get(key) ?? 0) + 1);
  const visit = (node) => {
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && literalLike(node.right)) {
      if (ts.isPropertyAccessExpression(node.left)
        && ts.isPropertyAccessExpression(node.left.expression)
        && node.left.expression.name.text === 'style') add(`style.${node.left.name.text}`);
      else if (ts.isPropertyAccessExpression(node.left) && node.left.name.text === 'cssText') add('cssText');
    }
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && node.expression.name.text === 'setAttribute'
      && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0]) && node.arguments[0].text === 'style'
      && node.arguments[1] && literalLike(node.arguments[1])) add('setAttribute:style');
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return Object.fromEntries([...counts.entries()].sort(([left], [right]) => left.localeCompare(right)));
}

const stylesRoot = path.join(root, 'styles');
const css = readdirSync(stylesRoot).filter((name) => name.endsWith('.css')).sort()
  .map((name) => readFileSync(path.join(stylesRoot, name), 'utf8')).join('');
const importantBySelector = {};
for (const match of css.matchAll(/([^{}]+)\{([^{}]*)\}/gu)) {
  const count = Array.from(match[2].matchAll(/!important/gu)).length;
  if (count === 0) continue;
  const selector = match[1].replace(/\/\*[\s\S]*?\*\//gu, '').replace(/\s+/gu, ' ').trim();
  if (!selector) continue;
  importantBySelector[selector] = (importantBySelector[selector] ?? 0) + count;
}
const inlineByFile = {};
for (const file of walk(path.join(root, 'src')).sort()) {
  const debt = inlineStyleDebt(file, readFileSync(file, 'utf8'));
  if (Object.keys(debt).length > 0) inlineByFile[path.relative(root, file).replaceAll('\\', '/')] = debt;
}
const importantTotal = Array.from(css.matchAll(/!important/gu)).length;
const inlineStaticTotal = Object.values(inlineByFile).reduce((sum, rules) => sum + Object.values(rules).reduce((inner, value) => inner + value, 0), 0);
const generated = {
  schemaVersion: 1,
  importantTotal,
  inlineStaticTotal,
  importantBySelector: Object.fromEntries(Object.entries(importantBySelector).sort(([left], [right]) => left.localeCompare(right))),
  inlineByFile,
  policy: 'Static component presentation belongs in ordered styles/*.css source partials compiled to the one shipped styles.css; new inline-static path/property debt or new/increased !important selector debt fails. Dynamic measured geometry is excluded.',
};

if (process.argv.includes('--update')) {
  writeFileSync(baselinePath, `${JSON.stringify(generated, null, 2)}\n`);
  console.log(`Wrote style debt baseline: ${importantTotal} !important uses and ${inlineStaticTotal} static inline assignments.`);
  process.exit(0);
}
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const regressions = [];
for (const [selector, count] of Object.entries(generated.importantBySelector)) {
  const maximum = baseline.importantBySelector?.[selector];
  if (typeof maximum !== 'number') regressions.push(`new !important selector: ${selector} (${count})`);
  else if (count > maximum) regressions.push(`!important ${selector}: ${count} exceeds ${maximum}`);
}
for (const [file, properties] of Object.entries(generated.inlineByFile)) {
  for (const [property, count] of Object.entries(properties)) {
    const maximum = baseline.inlineByFile?.[file]?.[property];
    if (typeof maximum !== 'number') regressions.push(`new static inline style: ${file} ${property} (${count})`);
    else if (count > maximum) regressions.push(`static inline ${file} ${property}: ${count} exceeds ${maximum}`);
  }
}
if (importantTotal > baseline.importantTotal) regressions.push(`!important total ${importantTotal} exceeds ${baseline.importantTotal}`);
if (inlineStaticTotal > baseline.inlineStaticTotal) regressions.push(`static inline total ${inlineStaticTotal} exceeds ${baseline.inlineStaticTotal}`);
if (importantTotal < baseline.importantTotal) regressions.push(`baseline must be lowered: !important total ${importantTotal} is below ${baseline.importantTotal}`);
if (inlineStaticTotal < baseline.inlineStaticTotal) regressions.push(`baseline must be lowered: static inline total ${inlineStaticTotal} is below ${baseline.inlineStaticTotal}`);
if (regressions.length > 0) {
  console.error('Style debt regressions:');
  for (const regression of regressions) console.error(`- ${regression}`);
  process.exit(1);
}
console.log(`Style debt baseline passed: ${importantTotal}/${baseline.importantTotal} !important; ${inlineStaticTotal}/${baseline.inlineStaticTotal} static inline assignments; baselines exactly match.`);
