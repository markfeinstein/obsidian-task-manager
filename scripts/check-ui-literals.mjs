#!/usr/bin/env node
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import ts from 'typescript';

const root = process.cwd();
const baselinePath = path.join(root, 'quality', 'ui-literal-baseline.json');
const directTextMethods = new Set([
  'setText', 'setTitle', 'setName', 'setDesc', 'setPlaceholder', 'setButtonText',
  'setTooltip', 'setHeading', 'setLabel', 'setMessage',
]);
const objectTextProperties = new Set(['text', 'title', 'placeholder', 'ariaLabel', 'label', 'description']);
const assignedTextProperties = new Set(['textContent', 'innerText', 'placeholder', 'title', 'ariaLabel']);
const accessibleAttributes = new Set(['aria-label', 'aria-description', 'title', 'placeholder']);

function sourceFiles(directory) {
  const files = [];
  for (const name of readdirSync(directory)) {
    const absolute = path.join(directory, name);
    const stat = statSync(absolute);
    if (stat.isDirectory()) files.push(...sourceFiles(absolute));
    else if (name.endsWith('.ts') && name !== 'i18n.ts') files.push(absolute);
  }
  return files;
}

function literalText(node) {
  if (ts.isStringLiteralLike(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function propertyName(node) {
  if (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) return node.text;
  return null;
}

function callName(expression) {
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isIdentifier(expression)) return expression.text;
  return null;
}

function add(records, context, text) {
  const normalized = text.replace(/\s+/gu, ' ').trim();
  if (!normalized) return;
  const key = `${context}\u0000${normalized}`;
  const current = records.get(key) ?? { context, text: normalized, count: 0 };
  current.count += 1;
  records.set(key, current);
}

export function collectUiLiterals(source, fileName = 'source.ts') {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const records = new Map();
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const name = callName(node.expression);
      if (name && directTextMethods.has(name)) {
        const text = node.arguments[0] ? literalText(node.arguments[0]) : null;
        if (text !== null) add(records, name, text);
      }
      if (name === 'setAttr') {
        const attribute = node.arguments[0] ? literalText(node.arguments[0]) : null;
        const text = node.arguments[1] ? literalText(node.arguments[1]) : null;
        if (attribute && accessibleAttributes.has(attribute) && text !== null) add(records, `setAttr:${attribute}`, text);
      }
      if (name === 'createEl' || name === 'createDiv' || name === 'createSpan') {
        for (const argument of node.arguments) {
          if (!ts.isObjectLiteralExpression(argument)) continue;
          for (const property of argument.properties) {
            if (!ts.isPropertyAssignment(property)) continue;
            const key = propertyName(property.name);
            const text = literalText(property.initializer);
            if (key && objectTextProperties.has(key) && text !== null) add(records, `${name}:${key}`, text);
          }
        }
      }
    } else if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Notice') {
      const text = node.arguments?.[0] ? literalText(node.arguments[0]) : null;
      if (text !== null) add(records, 'Notice', text);
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isPropertyAccessExpression(node.left)) {
      const name = node.left.name.text;
      const text = literalText(node.right);
      if (assignedTextProperties.has(name) && text !== null) add(records, `assign:${name}`, text);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...records.values()].sort((left, right) => left.context.localeCompare(right.context) || left.text.localeCompare(right.text));
}

const entries = {};
let total = 0;
for (const file of sourceFiles(path.join(root, 'src')).sort()) {
  const relative = path.relative(root, file).replaceAll('\\', '/');
  const literals = collectUiLiterals(readFileSync(file, 'utf8'), relative);
  if (literals.length === 0) continue;
  entries[relative] = literals;
  total += literals.reduce((sum, literal) => sum + literal.count, 0);
}
const generated = {
  schemaVersion: 1,
  totalLiterals: total,
  entries,
  policy: 'Heuristic inventory of direct user-facing string literals. New file/context/text tuples or count increases fail; use t() and update locale catalogues instead.',
};

if (process.argv.includes('--update')) {
  writeFileSync(baselinePath, `${JSON.stringify(generated, null, 2)}\n`);
  console.log(`Wrote ${total} direct UI literals to ${path.relative(root, baselinePath)}.`);
  process.exit(0);
}

let baseline;
try { baseline = JSON.parse(readFileSync(baselinePath, 'utf8')); } catch (error) {
  console.error(`Unable to read UI literal baseline: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
if (baseline?.schemaVersion !== 1 || !baseline.entries || typeof baseline.totalLiterals !== 'number') {
  console.error('UI literal baseline has an unsupported schema.');
  process.exit(1);
}

const baselineCounts = new Map();
for (const [file, literals] of Object.entries(baseline.entries)) {
  for (const literal of literals) baselineCounts.set(`${file}\u0000${literal.context}\u0000${literal.text}`, literal.count);
}
const regressions = [];
for (const [file, literals] of Object.entries(entries)) {
  for (const literal of literals) {
    const key = `${file}\u0000${literal.context}\u0000${literal.text}`;
    const maximum = baselineCounts.get(key);
    if (typeof maximum !== 'number') regressions.push(`${file} ${literal.context}: new literal ${JSON.stringify(literal.text)}`);
    else if (literal.count > maximum) regressions.push(`${file} ${literal.context}: ${JSON.stringify(literal.text)} count ${literal.count} exceeds ${maximum}`);
  }
}
if (total > baseline.totalLiterals) regressions.push(`total direct literals ${total} exceeds baseline ${baseline.totalLiterals}`);
if (total < baseline.totalLiterals) regressions.push(`baseline must be lowered: direct literals ${total} are below ${baseline.totalLiterals}`);
if (regressions.length > 0) {
  console.error('Direct user-facing literal regressions:');
  for (const regression of regressions) console.error(`- ${regression}`);
  console.error('Use an i18n key; update the baseline only after an explicit localization review.');
  process.exit(1);
}
console.log(`UI literal baseline passed: ${total}/${baseline.totalLiterals}; baseline exactly matches the reviewed literal inventory.`);
