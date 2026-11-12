#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const CONTROL_NAMES = new Set(['addToggle', 'addTextArea', 'addText', 'addDropdown', 'addSlider', 'addButton', 'addExtraButton', 'addColorPicker', 'addSearch']);
const ACTION_CONTROLS = new Set(['addButton', 'addExtraButton']);
const OVERRIDE_KEYS = new Set(['id', 'label', 'source', 'section', 'kind', 'provider', 'defaultValue', 'prerequisite', 'security', 'sideEffect', 'reload']);
const OVERRIDE_KINDS = new Set(['action', 'dynamic']);
const PROVIDERS = new Set(['Core/local', 'Todoist', 'Google Tasks', 'Google Calendar', 'Microsoft To Do', 'CalDAV', 'Apple Reminders']);

export const PROVIDER_FIELD_PREFIXES = Object.freeze([
  ['googleCalendar', 'Google Calendar'],
  ['googleTasks', 'Google Tasks'],
  ['googleOAuth', 'Google Tasks'],
  ['todoist', 'Todoist'],
  ['msToDo', 'Microsoft To Do'],
  ['caldav', 'CalDAV'],
  ['appleReminders', 'Apple Reminders'],
]);

function propertyName(node) {
  return node && (ts.isIdentifier(node) || ts.isStringLiteralLike(node)) ? node.text : undefined;
}

function primitiveValue(node, constants = new Map(), seen = new Set()) {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text === '' ? 'Empty' : node.text;
  if (ts.isNumericLiteral(node)) return node.text;
  if (node.kind === ts.SyntaxKind.TrueKeyword) return 'true';
  if (node.kind === ts.SyntaxKind.FalseKeyword) return 'false';
  if (ts.isPrefixUnaryExpression(node) && ts.isNumericLiteral(node.operand)) return `${node.operator === ts.SyntaxKind.MinusToken ? '-' : ''}${node.operand.text}`;
  if (ts.isArrayLiteralExpression(node)) return node.elements.length === 0 ? 'Empty list' : `${node.elements.length} built-in item(s)`;
  if (ts.isObjectLiteralExpression(node)) return node.properties.length === 0 ? 'Empty object' : 'Built-in object defaults';
  if (ts.isIdentifier(node)) {
    if (seen.has(node.text)) throw new Error(`Circular default constant: ${node.text}`);
    const initializer = constants.get(node.text);
    if (!initializer) return undefined;
    return primitiveValue(initializer, constants, new Set([...seen, node.text]));
  }
  return undefined;
}

export function parseDefaultSettings(source, fileName = 'types.ts') {
  const ast = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const constants = new Map();
  for (const statement of ast.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.initializer) constants.set(declaration.name.text, declaration.initializer);
    }
  }
  const defaults = new Map();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'DEFAULT_SETTINGS' && ts.isObjectLiteralExpression(node.initializer)) {
      for (const property of node.initializer.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const name = propertyName(property.name);
        const value = primitiveValue(property.initializer, constants);
        if (!name) continue;
        if (value === undefined) throw new Error(`DEFAULT_SETTINGS.${name} is not statically representable`);
        defaults.set(name, value);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  if (defaults.size === 0) throw new Error('DEFAULT_SETTINGS object was not found');
  return defaults;
}

export function parseEnglishTranslations(source, fileName = 'i18n.ts') {
  const ast = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const translations = new Map();
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'EN' && ts.isObjectLiteralExpression(node.initializer)) {
      for (const property of node.initializer.properties) {
        if (!ts.isPropertyAssignment(property) || !ts.isStringLiteralLike(property.initializer)) continue;
        const key = propertyName(property.name);
        if (key) translations.set(key, property.initializer.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  return translations;
}

function translatedLiteral(node, translations) {
  if (!node) return undefined;
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 't') {
    const key = node.arguments[0];
    if (key && ts.isStringLiteralLike(key)) return translations.get(key.text);
  }
  return undefined;
}

function humanize(value) {
  const humanized = value.replace(/^(?:render|add)/u, '').replace(/Tab$/u, '').replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/[-_]+/gu, ' ').trim().replace(/^./u, (letter) => letter.toUpperCase());
  return humanized || value.replace(/^./u, (letter) => letter.toUpperCase());
}

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/gu, '-').replace(/^-|-$/gu, '') || 'setting';
}

function enclosingStatement(node) {
  let current = node;
  while (current.parent && !ts.isExpressionStatement(current) && !ts.isVariableDeclaration(current) && !ts.isReturnStatement(current)) current = current.parent;
  return current;
}

function enclosingSection(node, sourceFile, sourcePath) {
  let current = node.parent;
  while (current) {
    if ((ts.isMethodDeclaration(current) || ts.isFunctionDeclaration(current)) && current.name) return humanize(current.name.getText(sourceFile));
    current = current.parent;
  }
  return humanize(path.basename(sourcePath, '.ts'));
}

function settingsField(node) {
  if (!ts.isPropertyAccessExpression(node)) return undefined;
  const segments = [];
  let current = node;
  while (ts.isPropertyAccessExpression(current)) {
    segments.unshift(current.name.text);
    current = current.expression;
  }
  const settingsIndex = segments.lastIndexOf('settings');
  return settingsIndex >= 0 ? segments[settingsIndex + 1] : undefined;
}

function fieldsIn(node) {
  const fields = new Set();
  const visit = (child) => {
    const field = settingsField(child);
    if (field) fields.add(field);
    ts.forEachChild(child, visit);
  };
  visit(node);
  return fields;
}

function assignmentFields(node) {
  const fields = new Set();
  const assignmentTokens = new Set([
    ts.SyntaxKind.EqualsToken, ts.SyntaxKind.PlusEqualsToken, ts.SyntaxKind.MinusEqualsToken,
    ts.SyntaxKind.AsteriskEqualsToken, ts.SyntaxKind.SlashEqualsToken,
  ]);
  const visit = (child) => {
    if (ts.isBinaryExpression(child) && assignmentTokens.has(child.operatorToken.kind)) {
      const field = settingsField(child.left);
      if (field) fields.add(field);
    }
    ts.forEachChild(child, visit);
  };
  visit(node);
  return fields;
}

function setValueFields(callback) {
  const fields = new Set();
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'setValue' && node.arguments[0]) {
      for (const field of fieldsIn(node.arguments[0])) fields.add(field);
    }
    ts.forEachChild(node, visit);
  };
  visit(callback);
  return fields;
}

function variableForRow(setNameCall) {
  const statement = enclosingStatement(setNameCall);
  if (ts.isVariableDeclaration(statement) && ts.isIdentifier(statement.name)) return statement.name.text;
  const receiver = setNameCall.expression.expression;
  return ts.isIdentifier(receiver) ? receiver.text : undefined;
}

function enclosingBlock(node) {
  let current = node.parent;
  while (current && !ts.isBlock(current) && !ts.isSourceFile(current)) current = current.parent;
  return current;
}

function referencesVariableAsReceiver(node, variable) {
  let found = false;
  const visit = (child) => {
    if (found) return;
    if (ts.isPropertyAccessExpression(child) && ts.isIdentifier(child.expression) && child.expression.text === variable) found = true;
    else ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}

function rowNodes(setNameCall) {
  const statement = enclosingStatement(setNameCall);
  const variable = variableForRow(setNameCall);
  if (!variable) return [statement];
  const block = enclosingBlock(statement);
  if (!block || ts.isSourceFile(block)) return [statement];
  return block.statements.filter((candidate) => candidate === statement || referencesVariableAsReceiver(candidate, variable));
}

function controlCalls(nodes) {
  const controls = [];
  for (const root of nodes) {
    const visit = (node) => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && CONTROL_NAMES.has(node.expression.name.text)) {
        controls.push({ name: node.expression.name.text, callback: node.arguments[0], node });
      }
      ts.forEachChild(node, visit);
    };
    visit(root);
  }
  return controls;
}

function bindPersistedField(controls, label) {
  const candidates = new Set();
  const conflicts = [];
  for (const control of controls) {
    if (ACTION_CONTROLS.has(control.name) || !control.callback) continue;
    const reads = setValueFields(control.callback);
    const writes = assignmentFields(control.callback);
    const agreed = [...reads].filter((field) => writes.has(field));
    if (agreed.length === 1) candidates.add(agreed[0]);
    else if (agreed.length > 1) conflicts.push(`multiple read/write fields: ${agreed.join(', ')}`);
    else if (reads.size > 0 && writes.size > 0) conflicts.push(`reads ${[...reads].join(', ')} but writes ${[...writes].join(', ')}`);
  }
  if (conflicts.length > 0) throw new Error(`Conflicting field binding for “${label}”: ${conflicts.join('; ')}`);
  return { candidates, actionOnly: controls.length > 0 && controls.every((control) => ACTION_CONTROLS.has(control.name)) };
}

function controlMetadata(controls) {
  const names = [...new Set(controls.map((control) => control.name.replace(/^add/u, '')).filter((name) => name !== 'ExtraButton'))];
  const type = names.length === 0 ? 'Composite/dynamic'
    : names.length > 1 ? names.map((name) => ({ Toggle: 'Boolean', Text: 'Text', TextArea: 'Multiline text', Dropdown: 'Choice', Slider: 'Number', Button: 'Action', ColorPicker: 'Color', Search: 'Search' }[name] ?? name)).join(' + ')
      : ({ Toggle: 'Boolean', Text: 'Text', TextArea: 'Multiline text', Dropdown: 'Choice', Slider: 'Number', Button: 'Action', ColorPicker: 'Color', Search: 'Search' }[names[0]] ?? names[0]);
  let limit;
  for (const control of controls) {
    const visit = (node) => {
      if (limit || !ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression) || node.expression.name.text !== 'setLimits') {
        ts.forEachChild(node, visit);
        return;
      }
      limit = node.arguments.map((argument) => argument.getText()).join(', ');
    };
    visit(control.node);
  }
  const range = limit ? limit.replace(/^([^,]+), ([^,]+), (.+)$/u, '$1–$2 (step $3)')
    : type === 'Boolean' ? 'true / false' : type === 'Choice' ? 'Defined choices' : type === 'Action' ? 'N/A' : 'Validated by UI/normalizer';
  return { type, range };
}

function literalDescription(nodes, translations) {
  let description;
  for (const root of nodes) {
    const visit = (node) => {
      if (description) return;
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'setDesc') {
        description = translatedLiteral(node.arguments[0], translations);
      }
      ts.forEachChild(node, visit);
    };
    visit(root);
  }
  return description;
}

export function providerForField(field) {
  for (const [prefix, provider] of PROVIDER_FIELD_PREFIXES) if (field.startsWith(prefix)) return provider;
  return 'Core/local';
}

function defaultOperationalMetadata({ field, label, section, provider, kind, description }) {
  const action = kind === 'action';
  return {
    prerequisite: provider !== 'Core/local' && !/^enable/iu.test(field ?? '') ? `${provider} feature enabled/configured as applicable` : action ? 'Owning section/action prerequisites' : 'None declared',
    security: action ? 'Not persisted by this action row'
      : /(?:api.?key|access.?token|refresh.?token|password|secret)/iu.test(`${field ?? ''} ${label}`) ? 'SecretStorage on supported Obsidian 1.11.4+; saving active secrets is blocked when SecretStorage is unavailable'
        : 'Plugin data.json (non-secret setting)',
    sideEffect: action ? 'Runs the named action; review adjacent description/confirmation'
      : provider !== 'Core/local' ? 'Consumed by the provider on its next setup/sync action'
        : /query|filter|search/iu.test(section) ? 'Reconfigures query/filter behavior after save'
          : /appearance|style|display/iu.test(section) ? 'Applies on the next owning-surface refresh'
            : 'Consumed by the owning feature after save',
    reload: /reload|restart/iu.test(description ?? '') ? 'See UI description' : 'No explicit reload requirement',
  };
}

export function validateOverrides(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || value.schemaVersion !== 1 || !Array.isArray(value.rows)) {
    throw new Error('settings reference overrides must be { schemaVersion: 1, rows: [...] }');
  }
  const byId = new Map();
  for (const [index, row] of value.rows.entries()) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error(`Override row ${index} must be an object`);
    for (const key of Object.keys(row)) if (!OVERRIDE_KEYS.has(key)) throw new Error(`Unknown override key ${key} in row ${index}`);
    for (const key of OVERRIDE_KEYS) if (typeof row[key] !== 'string' || !row[key].trim()) throw new Error(`Override ${row.id ?? index} is missing string ${key}`);
    if (!OVERRIDE_KINDS.has(row.kind)) throw new Error(`Override ${row.id} has invalid kind ${row.kind}`);
    if (!PROVIDERS.has(row.provider)) throw new Error(`Override ${row.id} has invalid provider ${row.provider}`);
    if (byId.has(row.id)) throw new Error(`Duplicate settings reference override: ${row.id}`);
    byId.set(row.id, Object.freeze({ ...row }));
  }
  return byId;
}

export function parseSettingsSource({ source, sourcePath, defaults, translations, overrides, usedOverrides = new Set() }) {
  const sourceFile = ts.createSourceFile(path.basename(sourcePath), source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const rows = [];
  const visit = (node) => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'setName') {
      const label = translatedLiteral(node.arguments[0], translations);
      if (label) {
        const nodes = rowNodes(node);
        const section = enclosingSection(node, sourceFile, sourcePath);
        const controls = controlCalls(nodes);
        const binding = bindPersistedField(controls, label);
        const control = controlMetadata(controls);
        const overrideId = `settings.${slug(section)}.${slug(label)}`;
        const override = overrides.get(overrideId);
        if (binding.candidates.size === 1) {
          const field = [...binding.candidates][0];
          if (!defaults.has(field)) throw new Error(`Missing DEFAULT_SETTINGS.${field} for “${label}”`);
          rows.push({ label, field, idBase: `settings.${field}`, source: sourcePath, position: node.pos, section, provider: providerForField(field), type: control.type, range: control.range,
            defaultValue: defaults.get(field), kind: 'persisted', description: literalDescription(nodes, translations) });
        } else {
          if (!override) {
            const reason = binding.candidates.size > 1 ? `multiple fields ${[...binding.candidates].join(', ')}` : binding.actionOnly ? 'action row' : 'dynamic/unbound row';
            throw new Error(`Missing override for ${overrideId} (${sourcePath} :: ${section} :: ${label}; ${reason})`);
          }
          for (const key of ['label', 'source', 'section']) if (override[key] !== { label, source: sourcePath, section }[key]) throw new Error(`Stale override ${overrideId}: ${key} does not match source row`);
          if (binding.candidates.size > 0 && override.kind !== 'dynamic') throw new Error(`Override ${overrideId} covers multiple persisted fields and must be dynamic`);
          usedOverrides.add(overrideId);
          rows.push({ ...override, field: undefined, idBase: override.id, position: node.pos, type: control.type, range: control.range, description: literalDescription(nodes, translations) });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return rows;
}

export function finalizeSettingIds(rows) {
  const totals = new Map();
  for (const row of rows) totals.set(row.idBase, (totals.get(row.idBase) ?? 0) + 1);
  const ids = new Set();
  return rows.map((row) => {
    let id = (totals.get(row.idBase) ?? 0) > 1 ? `${row.idBase}.${slug(row.label)}` : row.idBase;
    if (ids.has(id)) id = `${id}.${slug(row.section)}`;
    if (ids.has(id)) throw new Error(`Settings reference ID collision: ${id}`);
    ids.add(id);
    return { ...row, id };
  });
}

export function generateSettingsInventory({ rootDir = process.cwd(), overrideData } = {}) {
  const translations = parseEnglishTranslations(readFileSync(path.join(rootDir, 'src', 'i18n.ts'), 'utf8'));
  const defaults = parseDefaultSettings(readFileSync(path.join(rootDir, 'src', 'types.ts'), 'utf8'));
  const overrides = validateOverrides(overrideData ?? JSON.parse(readFileSync(path.join(rootDir, 'quality', 'settings-reference-overrides.json'), 'utf8')));
  const files = [
    path.join(rootDir, 'src', 'settings.ts'),
    ...readdirSync(path.join(rootDir, 'src', 'settings')).filter((name) => name.endsWith('.ts')).sort().map((name) => path.join(rootDir, 'src', 'settings', name)),
    path.join(rootDir, 'src', 'modals', 'google-calendar-setup-wizard.ts'),
  ];
  const usedOverrides = new Set();
  const rows = files.flatMap((file) => parseSettingsSource({
    source: readFileSync(file, 'utf8'), sourcePath: path.relative(rootDir, file).replaceAll('\\', '/'), defaults, translations, overrides, usedOverrides,
  }));
  const stale = [...overrides.keys()].filter((id) => !usedOverrides.has(id));
  if (stale.length > 0) throw new Error(`Stale or unknown settings reference overrides: ${stale.join(', ')}`);
  rows.sort((left, right) => left.source.localeCompare(right.source) || left.position - right.position);
  return finalizeSettingIds(rows).map((row) => {
    if (row.field) return { ...row, ...defaultOperationalMetadata({ ...row, description: row.description }) };
    return row;
  });
}

const escapeCell = (value) => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');

export function renderSettingsReference(settings) {
  const lines = [
    '# Settings reference', '',
    "> **Generated contract inventory.** Run `npm run docs:settings` after changing `Setting.setName(...)` rows. Persisted rows are bound to the exact setting field read by `setValue(...)` and written by that control callback; defaults come from that field in `DEFAULT_SETTINGS`. Action and multi-field/dynamic rows require reviewed stable-ID overrides. Provider ownership is explicit by field prefix/override, never inferred from labels or file names.", '',
    `Setting count: **${settings.length}**. Secrets use Obsidian SecretStorage on supported Obsidian 1.11.4+ hosts. If SecretStorage is absent, the host is unsupported or incorrectly side-loaded and saving active credentials is blocked.`, '',
    '| ID | Setting | Field | Section / provider | Type / range | Default | Prerequisite | Persistence / security | Side effect | Reload | Source |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
    ...settings.map((setting) => `| \`${setting.id}\` | ${escapeCell(setting.label)} | ${setting.field ? `\`${setting.field}\`` : 'Reviewed dynamic/action row'} | ${escapeCell(setting.section)} / ${escapeCell(setting.provider)} | ${escapeCell(setting.type)}; ${escapeCell(setting.range)} | ${escapeCell(setting.defaultValue)} | ${escapeCell(setting.prerequisite)} | ${escapeCell(setting.security)} | ${escapeCell(setting.sideEffect)} | ${escapeCell(setting.reload)} | \`${setting.source}\` |`),
    '', 'Use [Settings guide](SETTINGS.md) for concepts and safety. Provider guides and [Privacy](PRIVACY.md) override generic row classifications when they describe a narrower behavior. Generated metadata is a review aid, not an instruction to enable advanced/network features.',
  ];
  return `${lines.join('\n')}\n`;
}

export function runSettingsReferenceCli({ rootDir = process.cwd(), check = process.argv.includes('--check') } = {}) {
  const settings = generateSettingsInventory({ rootDir });
  const output = renderSettingsReference(settings);
  const destination = path.join(rootDir, 'docs', 'SETTINGS_REFERENCE.md');
  if (check) {
    if (readFileSync(destination, 'utf8') !== output) throw new Error('docs/SETTINGS_REFERENCE.md is out of date; run npm run docs:settings.');
  } else {
    writeFileSync(destination, output);
    console.log(`Generated ${settings.length} settings in docs/SETTINGS_REFERENCE.md`);
  }
  return settings;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    runSettingsReferenceCli();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
