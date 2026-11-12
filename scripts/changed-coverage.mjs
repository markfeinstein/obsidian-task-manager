#!/usr/bin/env node
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_VALUES = new Map(Array.from(BASE64, (character, index) => [character, index]));

function decodeVlq(segment, cursor) {
  let value = 0;
  let shift = 0;
  let digit;
  do {
    digit = BASE64_VALUES.get(segment[cursor.index]);
    if (digit === undefined) throw new Error('Invalid source-map VLQ digit');
    cursor.index += 1;
    value += (digit & 31) << shift;
    shift += 5;
  } while ((digit & 32) !== 0);
  const negative = (value & 1) === 1;
  value >>= 1;
  return negative ? -value : value;
}

export function decodeSourceMapMappings(map, mapPath) {
  const mappings = [];
  let sourceIndex = 0;
  let originalLine = 0;
  let originalColumn = 0;
  let _nameIndex = 0;
  const generatedLines = String(map.mappings ?? '').split(';');
  for (let generatedLine = 0; generatedLine < generatedLines.length; generatedLine += 1) {
    let generatedColumn = 0;
    for (const encoded of generatedLines[generatedLine].split(',').filter(Boolean)) {
      const cursor = { index: 0 };
      generatedColumn += decodeVlq(encoded, cursor);
      if (cursor.index >= encoded.length) continue;
      sourceIndex += decodeVlq(encoded, cursor);
      originalLine += decodeVlq(encoded, cursor);
      originalColumn += decodeVlq(encoded, cursor);
      if (cursor.index < encoded.length) _nameIndex += decodeVlq(encoded, cursor);
      const source = map.sources?.[sourceIndex];
      if (typeof source !== 'string') continue;
      mappings.push({
        generatedLine,
        generatedColumn,
        sourcePath: path.resolve(path.dirname(mapPath), source),
        originalLine: originalLine + 1,
        originalColumn,
      });
    }
  }
  return mappings;
}

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' });
}

function refExists(root, ref) {
  try {
    git(root, ['rev-parse', '--verify', '--quiet', ref]);
    return true;
  } catch {
    return false;
  }
}

function changedSourceLines(root, baseRef) {
  const sourcePattern = /^src\/.*\.ts$/u;
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard'])
    .split('\n').map((file) => file.trim()).filter((file) => sourcePattern.test(file));
  const dirty = git(root, ['diff', '--name-only', 'HEAD']).trim().length > 0 || untracked.length > 0;
  let diffSpec;
  if (baseRef && refExists(root, baseRef)) diffSpec = [`${baseRef}...HEAD`];
  else if (process.env.GITHUB_BASE_REF && refExists(root, `origin/${process.env.GITHUB_BASE_REF}`)) diffSpec = [`origin/${process.env.GITHUB_BASE_REF}...HEAD`];
  else if (dirty) diffSpec = ['HEAD'];
  else if (refExists(root, 'HEAD^')) diffSpec = ['HEAD^', 'HEAD'];
  else return new Map();

  const files = new Set([
    ...git(root, ['diff', '--name-only', '--diff-filter=ACMR', ...diffSpec]).split('\n'),
    ...untracked,
  ].map((file) => file.trim()).filter((file) => sourcePattern.test(file) && existsSync(path.join(root, file))));
  const untrackedSet = new Set(untracked);
  const changed = new Map();
  for (const file of files) {
    if (untrackedSet.has(file)) {
      const count = readFileSync(path.join(root, file), 'utf8').split('\n').length;
      changed.set(file, new Set(Array.from({ length: count }, (_, index) => index + 1)));
      continue;
    }
    const lines = new Set();
    const patch = git(root, ['diff', '--unified=0', ...diffSpec, '--', file]);
    for (const match of patch.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gmu)) {
      const start = Number(match[1]);
      const count = match[2] === undefined ? 1 : Number(match[2]);
      for (let line = start; line < start + count; line += 1) lines.add(line);
    }
    changed.set(file, lines);
  }
  return changed;
}

function coverageRangesByUrl(rawCoverageDir) {
  const ranges = new Map();
  for (const entry of readdirSync(rawCoverageDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    let payload;
    try { payload = JSON.parse(readFileSync(path.join(rawCoverageDir, entry.name), 'utf8')); } catch { continue; }
    for (const script of payload.result ?? []) {
      if (typeof script.url !== 'string' || !script.url.startsWith('file:')) continue;
      const records = ranges.get(script.url) ?? [];
      for (const fn of script.functions ?? []) {
        for (const range of fn.ranges ?? []) {
          if (![range.startOffset, range.endOffset, range.count].every(Number.isFinite)) continue;
          records.push({ start: range.startOffset, end: range.endOffset, count: range.count });
        }
      }
      ranges.set(script.url, records);
    }
  }
  return ranges;
}

function offsetFor(content, lineStarts, line, column) {
  if (line < 0 || line >= lineStarts.length) return null;
  return Math.min(content.length, lineStarts[line] + column);
}

export function executableSourceLines(source, sourcePath) {
  const transpiled = ts.transpileModule(source, {
    fileName: sourcePath,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, sourceMap: true, inlineSources: false },
  });
  if (!transpiled.sourceMapText) return new Set();
  const map = JSON.parse(transpiled.sourceMapText);
  return new Set(decodeSourceMapMappings(map, `${sourcePath}.js.map`).map((mapping) => mapping.originalLine));
}

export function evaluatePerFileMinimum(executableChangedLines, coveredChangedLines, policy) {
  if (executableChangedLines === 0) return { percent: 100, passed: true, reasons: [] };
  const percent = Number(((coveredChangedLines / executableChangedLines) * 100).toFixed(2));
  const reasons = [];
  const minimumLines = Number(policy?.perFileMinimumCoveredExecutableLines ?? 0);
  const minimumPercent = Number(policy?.perFileMinimumPercent ?? 0);
  if (coveredChangedLines < minimumLines) reasons.push(`covered executable lines ${coveredChangedLines} below ${minimumLines}`);
  if (percent < minimumPercent) reasons.push(`coverage ${percent}% below ${minimumPercent}%`);
  return { percent, passed: reasons.length === 0, reasons };
}

function effectiveCovered(records, offset) {
  let shortest = Number.POSITIVE_INFINITY;
  let count = 0;
  for (const record of records) {
    if (offset < record.start || offset >= record.end) continue;
    const length = record.end - record.start;
    if (length < shortest) {
      shortest = length;
      count = record.count;
    } else if (length === shortest) {
      count = Math.max(count, record.count);
    }
  }
  return shortest < Number.POSITIVE_INFINITY && count > 0;
}

export function evaluateChangedCoverage({ root, testDist, rawCoverageDir, baseRef, policy }) {
  const changed = changedSourceLines(root, baseRef);
  const rangesByUrl = coverageRangesByUrl(rawCoverageDir);
  const perFile = {};
  let executable = 0;
  let covered = 0;

  const perFileMinimumPercent = Number(policy?.perFileMinimumPercent ?? 0);
  const perFileMinimumCoveredExecutableLines = Number(policy?.perFileMinimumCoveredExecutableLines ?? 0);
  for (const [relativeSource, changedLines] of changed) {
    const absoluteSource = path.join(root, relativeSource);
    const source = readFileSync(absoluteSource, 'utf8');
    const executableLines = executableSourceLines(source, absoluteSource);
    const changedExecutable = new Set([...changedLines].filter((line) => executableLines.has(line)));
    if (changedExecutable.size === 0) continue;
    const lineCoverage = new Map([...changedExecutable].map((line) => [line, false]));
    const relativeJs = relativeSource.replace(/\.ts$/u, '.js');
    const jsPath = path.join(testDist, relativeJs);
    const mapPath = `${jsPath}.map`;
    if (existsSync(jsPath) && existsSync(mapPath)) {
      const sourceMap = JSON.parse(readFileSync(mapPath, 'utf8'));
      const mappings = decodeSourceMapMappings(sourceMap, mapPath)
        .filter((mapping) => path.relative(root, mapping.sourcePath).replaceAll('\\', '/') === relativeSource && changedExecutable.has(mapping.originalLine));
      const content = readFileSync(jsPath, 'utf8');
      const lineStarts = [0];
      for (let index = 0; index < content.length; index += 1) if (content.charCodeAt(index) === 10) lineStarts.push(index + 1);
      const records = rangesByUrl.get(pathToFileURL(jsPath).href) ?? [];
      for (const mapping of mappings) {
        const offset = offsetFor(content, lineStarts, mapping.generatedLine, mapping.generatedColumn);
        if (offset === null) continue;
        lineCoverage.set(mapping.originalLine, (lineCoverage.get(mapping.originalLine) ?? false) || effectiveCovered(records, offset));
      }
    }
    const fileExecutable = lineCoverage.size;
    const fileCovered = [...lineCoverage.values()].filter(Boolean).length;
    const filePolicy = evaluatePerFileMinimum(fileExecutable, fileCovered, { perFileMinimumPercent, perFileMinimumCoveredExecutableLines });
    const filePercent = filePolicy.percent;
    const reasons = filePolicy.reasons;
    executable += fileExecutable;
    covered += fileCovered;
    perFile[relativeSource] = {
      executableChangedLines: fileExecutable,
      coveredChangedLines: fileCovered,
      percent: filePercent,
      passed: filePolicy.passed,
      reasons,
      uncoveredLines: [...lineCoverage.entries()].filter(([, value]) => !value).map(([line]) => line).sort((a, b) => a - b),
    };
  }

  const percent = executable === 0 ? 100 : Number(((covered / executable) * 100).toFixed(2));
  const minimumPercent = Number(policy?.minimumPercent ?? 0);
  const minimumCoveredLines = Number(policy?.minimumCoveredLines ?? 0);
  const applies = executable >= minimumCoveredLines;
  const failedFiles = Object.entries(perFile).filter(([, report]) => !report.passed).map(([file]) => file);
  return {
    schemaVersion: 2,
    baseRef: baseRef || null,
    executableChangedLines: executable,
    coveredChangedLines: covered,
    percent,
    minimumPercent,
    perFileMinimumPercent,
    perFileMinimumCoveredExecutableLines,
    applies,
    passed: (!applies || percent >= minimumPercent) && failedFiles.length === 0,
    failedFiles,
    files: perFile,
  };
}

async function cli() {
  const args = process.argv.slice(2);
  const valueAfter = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const root = path.resolve(valueAfter('--root') ?? process.cwd());
  const testDist = path.resolve(root, valueAfter('--test-dist') ?? '.test-dist');
  const rawCoverageDir = path.resolve(root, valueAfter('--coverage-dir') ?? 'coverage-v8');
  const output = path.resolve(root, valueAfter('--output') ?? 'coverage/changed-lines.json');
  const baseline = JSON.parse(readFileSync(path.join(root, 'quality', 'coverage-baseline.json'), 'utf8'));
  const report = evaluateChangedCoverage({
    root,
    testDist,
    rawCoverageDir,
    baseRef: valueAfter('--base-ref') ?? process.env.COVERAGE_BASE_REF,
    policy: baseline.changedLines,
  });
  writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`Changed-line coverage: ${report.coveredChangedLines}/${report.executableChangedLines} (${report.percent}%, aggregate minimum ${report.minimumPercent}%; per-file minimum ${report.perFileMinimumPercent}%).`);
  for (const file of report.failedFiles) console.error(`FAIL ${file}: ${report.files[file].reasons.join('; ')}; uncovered lines ${report.files[file].uncoveredLines.join(', ') || 'none'}`);
  if (!report.passed) process.exitCode = 1;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await cli();
