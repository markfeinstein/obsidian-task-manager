#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const REQUIRED_FIELDS = ['id', 'name', 'lane', 'availability', 'context', 'runtimeGuards', 'effect', 'prerequisites'];
const LANES = new Set(['Core tasks', 'Queries', 'Views & planning', 'Integrations', 'Maintenance']);
const CONTEXTS = new Set(['Any Obsidian context', 'Active Markdown editor', 'Active Markdown file (checked at invocation)']);
const EFFECTS = new Set(['read-only', 'vault-write', 'deferred-vault-write', 'clipboard-write', 'network-read', 'network-write', 'local-uri', 'mixed']);

function unwrap(node) {
  let current = node;
  while (current && (ts.isAsExpression(current) || ts.isSatisfiesExpression(current) || ts.isParenthesizedExpression(current))) current = current.expression;
  return current;
}

function propertyName(node) {
  return node && (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) ? node.text : undefined;
}

function staticValue(node, file) {
  const value = unwrap(node);
  if (!value) return undefined;
  if (ts.isStringLiteralLike(value)) return value.text;
  if (value.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (value.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (ts.isArrayLiteralExpression(value)) return value.elements.map((entry) => staticValue(entry, file));
  if (ts.isObjectLiteralExpression(value)) {
    return Object.fromEntries(value.properties.map((property) => {
      if (!ts.isPropertyAssignment(property)) throw new Error(`Command metadata must use property assignments: ${property.getText(file)}`);
      return [propertyName(property.name), staticValue(property.initializer, file)];
    }));
  }
  throw new Error(`Command metadata must be static literals: ${value.getText(file)}`);
}

export function parseCommandDocumentation(source, fileName = 'command-metadata.ts') {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let metadata;
  let dynamicFamilies;
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (!ts.isIdentifier(declaration.name) || !declaration.initializer) continue;
      if (declaration.name.text === 'STATIC_COMMAND_DOCUMENTATION') metadata = staticValue(declaration.initializer, file);
      if (declaration.name.text === 'DYNAMIC_COMMAND_FAMILIES') dynamicFamilies = staticValue(declaration.initializer, file);
    }
  }
  if (!Array.isArray(metadata)) throw new Error('STATIC_COMMAND_DOCUMENTATION literal array was not found');
  if (!Array.isArray(dynamicFamilies) || dynamicFamilies.length === 0) throw new Error('DYNAMIC_COMMAND_FAMILIES literal array was not found');
  const ids = new Set();
  for (const [index, entry] of metadata.entries()) {
    for (const field of REQUIRED_FIELDS) if (!(field in entry)) throw new Error(`Command metadata row ${index} is missing ${field}`);
    if (ids.has(entry.id)) throw new Error(`Duplicate command documentation ID: ${entry.id}`);
    ids.add(entry.id);
    if (!LANES.has(entry.lane)) throw new Error(`Invalid command lane for ${entry.id}: ${entry.lane}`);
    if (!CONTEXTS.has(entry.context)) throw new Error(`Invalid invocation context for ${entry.id}: ${entry.context}`);
    if (!EFFECTS.has(entry.effect)) throw new Error(`Invalid effect for ${entry.id}: ${entry.effect}`);
    if (!entry.availability || !['always', 'feature-gated'].includes(entry.availability.kind)) throw new Error(`Invalid availability for ${entry.id}`);
    if (entry.availability.kind === 'feature-gated' && !entry.availability.setting) throw new Error(`Feature-gated command ${entry.id} is missing its setting`);
    if (!Array.isArray(entry.runtimeGuards) || !Array.isArray(entry.prerequisites)) throw new Error(`Command ${entry.id} guards/prerequisites must be arrays`);
  }
  return { metadata, dynamicFamilies };
}

export function parseEnglishTranslations(source, fileName = 'i18n.ts') {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const translations = new Map();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'EN' && ts.isObjectLiteralExpression(node.initializer)) {
      for (const property of node.initializer.properties) {
        if (ts.isPropertyAssignment(property) && ts.isStringLiteralLike(property.initializer)) translations.set(propertyName(property.name), property.initializer.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return translations;
}

function commandObjectValue(object, key, file, translations) {
  const property = object.properties.find((candidate) => ts.isPropertyAssignment(candidate) && propertyName(candidate.name) === key);
  if (!property || !ts.isPropertyAssignment(property)) return undefined;
  if (ts.isStringLiteralLike(property.initializer)) return property.initializer.text;
  if (key === 'name' && ts.isCallExpression(property.initializer) && ts.isIdentifier(property.initializer.expression)
    && property.initializer.expression.text === 't' && ts.isStringLiteralLike(property.initializer.arguments[0])) {
    return translations.get(property.initializer.arguments[0].text);
  }
  return undefined;
}

export function scanCommandSource(source, sourcePath, translations = new Map()) {
  const file = ts.createSourceFile(path.basename(sourcePath), source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const staticCommands = [];
  const dynamicFamilies = [];
  const rawRegistrations = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'addCommand') {
        rawRegistrations.push({ source: sourcePath, line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1 });
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === 'addDocumentedCommand') {
        const object = node.arguments[1];
        if (!object || !ts.isObjectLiteralExpression(object)) throw new Error(`${sourcePath}: addDocumentedCommand requires an inline command object`);
        const id = commandObjectValue(object, 'id', file, translations);
        const name = commandObjectValue(object, 'name', file, translations);
        if (!id || !name) throw new Error(`${sourcePath}: documented static commands require a literal ID and literal/localized English name`);
        staticCommands.push({ id, name, source: sourcePath, position: node.pos });
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === 'addDocumentedDynamicCommand') {
        const family = node.arguments[1];
        if (!family || !ts.isStringLiteralLike(family)) throw new Error(`${sourcePath}: dynamic command family must be a literal`);
        dynamicFamilies.push(family.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  return { staticCommands, dynamicFamilies, rawRegistrations };
}

export function validateCommandContract(metadata, documentedFamilies, scan) {
  if (scan.rawRegistrations.length > 0) {
    const raw = scan.rawRegistrations.map((entry) => `${entry.source}:${entry.line}`).join(', ');
    throw new Error(`Undocumented raw static command registration(s): ${raw}`);
  }
  const byId = new Map(metadata.map((entry) => [entry.id, entry]));
  const registered = new Set();
  for (const command of scan.staticCommands) {
    if (registered.has(command.id)) throw new Error(`Duplicate static command registration: ${command.id}`);
    registered.add(command.id);
    const documentation = byId.get(command.id);
    if (!documentation) throw new Error(`Static command ${command.id} is registered without declarative metadata`);
    if (documentation.name !== command.name) throw new Error(`Command name mismatch for ${command.id}: metadata “${documentation.name}”, registration “${command.name}”`);
  }
  for (const entry of metadata) if (!registered.has(entry.id)) throw new Error(`Stale command metadata without a static registration: ${entry.id}`);
  const familyNames = new Set(documentedFamilies.map((entry) => entry.family));
  for (const family of scan.dynamicFamilies) if (!familyNames.has(family)) throw new Error(`Undocumented dynamic command family registration: ${family}`);
  for (const family of familyNames) if (!scan.dynamicFamilies.includes(family)) throw new Error(`Stale dynamic command family metadata: ${family}`);
  return { staticIds: [...registered], dynamicFamilies: [...new Set(scan.dynamicFamilies)] };
}

export function commandIdsForSettings(metadata, settings) {
  return metadata.filter((entry) => entry.availability.kind === 'always' || settings[entry.availability.setting] === true).map((entry) => entry.id);
}

export function loadCommandReference(root = process.cwd()) {
  const metadataSource = readFileSync(path.join(root, 'src', 'command-metadata.ts'), 'utf8');
  const { metadata, dynamicFamilies } = parseCommandDocumentation(metadataSource);
  const translations = parseEnglishTranslations(readFileSync(path.join(root, 'src', 'i18n.ts'), 'utf8'));
  const commandDir = path.join(root, 'src', 'commands');
  const files = [
    'src/main.ts',
    ...readdirSync(commandDir).filter((name) => /^register-.*\.ts$/u.test(name)).sort().map((name) => `src/commands/${name}`),
  ];
  const scan = { staticCommands: [], dynamicFamilies: [], rawRegistrations: [] };
  for (const sourcePath of files) {
    const result = scanCommandSource(readFileSync(path.join(root, sourcePath), 'utf8'), sourcePath, translations);
    scan.staticCommands.push(...result.staticCommands);
    scan.dynamicFamilies.push(...result.dynamicFamilies);
    scan.rawRegistrations.push(...result.rawRegistrations);
  }
  validateCommandContract(metadata, dynamicFamilies, scan);
  const position = new Map(scan.staticCommands.map((entry, index) => [entry.id, index]));
  return { metadata: [...metadata].sort((left, right) => position.get(left.id) - position.get(right.id)), dynamicFamilies };
}

const escapeCell = (value) => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
const listCell = (values) => values.length > 0 ? values.join('; ') : 'None';

export function renderCommandReference(metadata, dynamicFamilies) {
  const lines = [
    '# Command reference',
    '',
    '> **Generated file.** Run `npm run docs:commands` after changing command registration or `src/command-metadata.ts`. Palette availability, invocation guards, and effects come only from the typed declarative contract.',
    '',
    `Static command count: **${metadata.length}**. Dynamic commands are documented as families and are not included in that count.`,
    '',
    '| Lane | Command | ID | Palette availability | Invocation context | Runtime guards | Effect | Prerequisites |',
    '|---|---|---|---|---|---|---|---|',
    ...metadata.map((command) => {
      const availability = command.availability.kind === 'always' ? 'Always visible' : `Visible when \`${command.availability.setting}\` is enabled`;
      return `| ${command.lane} | ${escapeCell(command.name)} | \`${command.id}\` | ${availability} | ${command.context} | ${escapeCell(listCell(command.runtimeGuards))} | \`${command.effect}\` | ${escapeCell(listCell(command.prerequisites))} |`;
    }),
    '',
    '## Effect legend',
    '',
    '- `read-only`: no action reachable from the command journey mutates local or remote state.',
    '- `vault-write`: invocation can write local vault/plugin state without a later confirmation step.',
    '- `deferred-vault-write`: invocation opens a non-mutating modal or preview, but a later explicit action in that journey can write local vault/plugin state.',
    '- `network-read` / `network-write`: the journey can contact a configured remote service; write-capable flows may also update local reconciliation state.',
    '- `clipboard-write`, `local-uri`, and `mixed`: the journey can leave Obsidian through the named surface or combine effect types.',
    '',
    '## Dynamic command families',
    '',
    '| Family | ID pattern | Name pattern | Registration | Context | Runtime guards | Effect | Prerequisites |',
    '|---|---|---|---|---|---|---|---|',
    ...dynamicFamilies.map((family) => `| ${family.family} | \`${family.idPattern}\` | ${escapeCell(family.namePattern)} | ${family.availability} | ${family.context} | ${escapeCell(listCell(family.runtimeGuards))} | \`${family.effect}\` | ${escapeCell(listCell(family.prerequisites))} |`),
    '',
    'Commands with `vault-write`, `deferred-vault-write`, `network-write`, `mixed`, `clipboard-write`, or `local-uri` effects can change local/remote state or leave Obsidian during their full journey. Back up first and review confirmation/provider dry-run/configuration. See [Settings](SETTINGS.md), [Privacy](PRIVACY.md), and [Troubleshooting](TROUBLESHOOTING.md).',
  ];
  return `${lines.join('\n')}\n`;
}

export function generateCommandReference(root = process.cwd()) {
  const { metadata, dynamicFamilies } = loadCommandReference(root);
  return renderCommandReference(metadata, dynamicFamilies);
}

async function main() {
  const root = process.cwd();
  const output = generateCommandReference(root);
  const destination = path.join(root, 'docs', 'COMMANDS.md');
  if (process.argv.includes('--check')) {
    const current = readFileSync(destination, 'utf8');
    if (current !== output) {
      console.error('docs/COMMANDS.md is out of date; run npm run docs:commands.');
      process.exitCode = 1;
    }
  } else {
    writeFileSync(destination, output);
    console.log(`Generated ${loadCommandReference(root).metadata.length} static commands in docs/COMMANDS.md`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
