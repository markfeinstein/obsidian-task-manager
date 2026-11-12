#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const errors = [];

function walk(directory) {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const absolute = path.join(directory, entry.name);
    const relative = path.relative(root, absolute).replaceAll('\\', '/');
    if (entry.isDirectory()) {
      if (['.git', '.pi-subagents', '.test-dist', '.test-runs', 'coverage', 'node_modules', 'release'].includes(entry.name) || relative === 'docs/internal/archive') continue;
      files.push(...walk(absolute));
    } else if (entry.isFile() && entry.name.endsWith('.md')) files.push(absolute);
  }
  return files;
}

function slug(value) {
  return value
    .toLowerCase()
    .trim()
    .replace(/<[^>]+>/gu, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/[\s_]+/gu, '-')
    .replace(/-+/gu, '-');
}

function headings(markdown) {
  const values = new Set();
  for (const match of markdown.matchAll(/^#{1,6}\s+(.+)$/gmu)) values.add(slug(match[1]));
  for (const match of markdown.matchAll(/<a\s+(?:name|id)=["']([^"']+)["']/giu)) values.add(match[1].toLowerCase());
  return values;
}

const markdownFiles = walk(root);
const headingCache = new Map();
for (const file of markdownFiles) {
  const relative = path.relative(root, file).replaceAll('\\', '/');
  const markdown = readFileSync(file, 'utf8');
  const withoutCode = markdown.replace(/```[\s\S]*?```/gu, '');
  for (const match of withoutCode.matchAll(/!?(?:\[[^\]]*\])\(([^)]+)\)/gu)) {
    const raw = match[1].trim().replace(/^<|>$/gu, '');
    if (!raw || /^(?:https?:|mailto:|obsidian:|data:)/iu.test(raw)) continue;
    const [targetPart, anchorPart] = raw.split('#', 2);
    const decodedTarget = decodeURIComponent(targetPart || '');
    const target = decodedTarget ? path.resolve(path.dirname(file), decodedTarget) : file;
    if (!existsSync(target)) {
      errors.push(`${relative}: missing link target ${raw}`);
      continue;
    }
    if (anchorPart && statSync(target).isFile() && target.endsWith('.md')) {
      const targetMarkdown = readFileSync(target, 'utf8');
      const available = headingCache.get(target) ?? headings(targetMarkdown);
      headingCache.set(target, available);
      const requested = decodeURIComponent(anchorPart).toLowerCase();
      if (!available.has(requested) && !available.has(slug(requested))) errors.push(`${relative}: missing anchor #${anchorPart} in ${path.relative(root, target)}`);
    }
  }
}

const dashboardRegistry = readFileSync(path.join(root, 'src', 'dashboard-registry.ts'), 'utf8');
const widgetBlock = dashboardRegistry.match(/DASHBOARD_WIDGET_REGISTRATION_ORDER[^=]*= \[([\s\S]*?)\];/u)?.[1] ?? '';
const widgetCount = [...widgetBlock.matchAll(/'[^']+'/gu)].length;
for (const [file, pattern] of [
  ['docs/DASHBOARD_WIDGETS.md', /every widget \(\*\*(\d+)\*\* in total\)/u],
]) {
  const value = Number(readFileSync(path.join(root, file), 'utf8').match(pattern)?.[1]);
  if (value !== widgetCount) errors.push(`${file}: dashboard count ${value || 'missing'} does not match source ${widgetCount}`);
}

const i18n = readFileSync(path.join(root, 'src', 'i18n.ts'), 'utf8');
const translationCatalogues = JSON.parse(readFileSync(path.join(root, 'translations', 'catalogues.json'), 'utf8'));
const translationDoc = readFileSync(path.join(root, 'docs', 'TRANSLATIONS.md'), 'utf8');
const localeRows = [['EN', 'English'], ['ZH', 'Simplified Chinese'], ['ES', 'Spanish'], ['DE', 'German'], ['PT_BR', 'Portuguese Brazil']];
const workbenchKey = { ZH: 'zh', ES: 'es', DE: 'de', PT_BR: 'pt-BR' };
const catalogueCounts = new Map(localeRows.map(([catalogue]) => {
  if (catalogue !== 'EN') return [catalogue, Object.keys(translationCatalogues[workbenchKey[catalogue]] ?? {}).length];
  const body = i18n.match(/const EN: Catalogue = \{([\s\S]*?)\n\};/u)?.[1] ?? '';
  return [catalogue, [...body.matchAll(/^\s*'[^']+':/gmu)].length];
}));
const englishCount = catalogueCounts.get('EN') ?? 0;
for (const [catalogue, label] of localeRows) {
  const count = catalogueCounts.get(catalogue) ?? 0;
  const row = translationDoc.match(new RegExp(`\\| ${label} [^\\n]*?\\| (\\d+) / ${englishCount} \\| (\\d+)%`, 'u'));
  const documented = Number(row?.[1]);
  const documentedCoverage = Number(row?.[2]);
  const expectedCoverage = englishCount === 0 ? 100 : Math.round((count / englishCount) * 100);
  if (documented !== count) errors.push(`docs/TRANSLATIONS.md: ${label} count ${documented || 'missing'} does not match source ${count}`);
  if (documentedCoverage !== expectedCoverage) errors.push(`docs/TRANSLATIONS.md: ${label} coverage ${documentedCoverage || 'missing'}% does not match source ${expectedCoverage}%`);
}
if (!/filter\(isLocaleCoreComplete\)/u.test(i18n)) errors.push('src/i18n.ts: locale picker must filter catalogues through the core-completeness contract');

const companion = readFileSync(path.join(root, 'scripts', 'mcp-companion.mjs'), 'utf8');
const mcpDoc = readFileSync(path.join(root, 'docs', 'MCP.md'), 'utf8');
const toolsBlock = companion.match(/const tools = \[([\s\S]*?)\n\];/u)?.[1] ?? '';
const companionTools = [...toolsBlock.matchAll(/\{ name: '([^']+)'/gu)].map((match) => match[1]);
for (const tool of companionTools) if (!mcpDoc.includes(`### \`${tool}\``)) errors.push(`docs/MCP.md: missing companion tool ${tool}`);
for (const heading of mcpDoc.matchAll(/^### `([^`]+)`$/gmu)) if (!companionTools.includes(heading[1])) errors.push(`docs/MCP.md: documents non-companion tool ${heading[1]}`);

const apiDoc = readFileSync(path.join(root, 'docs', 'API.md'), 'utf8');
if (/\bapiV1\./u.test(apiDoc)) errors.push('docs/API.md: examples must use the defined `api` variable, not an undefined `apiV1`');
const mainSource = readFileSync(path.join(root, 'src', 'main.ts'), 'utf8');
const apiInterface = mainSource.match(/export interface TaskManagerApiV1 \{([\s\S]*?)\n\}/u)?.[1] ?? '';
const apiMethods = [...apiInterface.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9]+):/gmu)].map((match) => match[1]);
for (const method of apiMethods) if (!new RegExp(`\\b${method}\\(`, 'u').test(apiDoc)) errors.push(`docs/API.md: missing TaskManagerApiV1 method ${method}`);
for (const prohibited of ['yourusername', 'example-vault/', 'task-manager-mcp-client"]']) {
  for (const file of markdownFiles) {
    const relative = path.relative(root, file).replaceAll('\\', '/');
    if (relative === 'REPOSITORY_REVIEW.md') continue;
    if (readFileSync(file, 'utf8').includes(prohibited)) errors.push(`${relative}: contains prohibited stale placeholder ${prohibited}`);
  }
}
for (const required of ['LICENSE', 'docs/PRIVACY.md', 'docs/INDEX.md']) {
  if (!existsSync(path.join(root, required))) errors.push(`missing required governance/documentation file: ${required}`);
}

const generated = spawnSync(process.execPath, ['scripts/generate-command-reference.mjs', '--check'], { cwd: root, encoding: 'utf8' });
if (generated.status !== 0) errors.push((generated.stderr || generated.stdout || 'generated command reference check failed').trim());
const generatedSettings = spawnSync(process.execPath, ['scripts/generate-settings-reference.mjs', '--check'], { cwd: root, encoding: 'utf8' });
if (generatedSettings.status !== 0) errors.push((generatedSettings.stderr || generatedSettings.stdout || 'generated settings reference check failed').trim());
if (errors.length > 0) {
  console.error('Documentation validation failed:');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log(`Documentation validation passed (${markdownFiles.length} active Markdown files, ${widgetCount} widgets, ${companionTools.length} companion tools).`);
