import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { decodeSourceMapMappings, evaluatePerFileMinimum, executableSourceLines } from '../scripts/changed-coverage.mjs';

const coverageBaseline = JSON.parse(readFileSync(new URL('../quality/coverage-baseline.json', import.meta.url), 'utf8'));

test('changed-line coverage decodes TypeScript source-map positions', () => {
  const source = [
    'export function choose(value: boolean): number {',
    '  if (value) return 1;',
    '  return 2;',
    '}',
  ].join('\n');
  const output = ts.transpileModule(source, {
    fileName: 'sample.ts',
    compilerOptions: { module: ts.ModuleKind.CommonJS, sourceMap: true, target: ts.ScriptTarget.ES2020 },
  });
  const map = JSON.parse(output.sourceMapText);
  const decoded = decodeSourceMapMappings(map, path.resolve('/tmp/sample.js.map'));

  assert.equal(decoded.some((mapping) => mapping.sourcePath === '/tmp/sample.ts' && mapping.originalLine === 2), true);
  assert.equal(decoded.some((mapping) => mapping.sourcePath === '/tmp/sample.ts' && mapping.originalLine === 3), true);
});

test('per-file coverage prevents one tested file from subsidizing an uncovered file', () => {
  const policy = { perFileMinimumPercent: 80, perFileMinimumCoveredExecutableLines: 1 };
  assert.equal(evaluatePerFileMinimum(10, 10, policy).passed, true);
  const uncovered = evaluatePerFileMinimum(1, 0, policy);
  assert.equal(uncovered.passed, false);
  assert.ok(uncovered.reasons.some((reason) => reason.includes('covered executable lines')));
  assert.equal(evaluatePerFileMinimum(5, 4, policy).passed, true);
  assert.equal(evaluatePerFileMinimum(6, 4, policy).passed, false);
});

test('type-only and comment-only source does not create executable-line requirements', () => {
  const source = ['// documentation', 'export interface Shape { value: string }', 'export type Name = string;'].join('\n');
  assert.deepEqual([...executableSourceLines(source, '/tmp/type-only.ts')], []);
  assert.equal(evaluatePerFileMinimum(0, 0, { perFileMinimumPercent: 80, perFileMinimumCoveredExecutableLines: 1 }).passed, true);
});

test('coverage policy raises global floors and protects risk modules plus changed lines', () => {
  assert.equal(coverageBaseline.schemaVersion, 2);
  assert.deepEqual(coverageBaseline.global, { lines: 73, branches: 78, functions: 73 });
  assert.equal(coverageBaseline.changedLines.minimumPercent, 80);
  assert.equal(coverageBaseline.changedLines.perFileMinimumPercent, 80);
  assert.equal(coverageBaseline.changedLines.perFileMinimumCoveredExecutableLines, 1);
  assert.equal(Object.keys(coverageBaseline.moduleFloors).length >= 20, true);
  for (const name of [
    'completion-detector.js',
    'dashboard-layout.js',
    'main.js',
    'query-builder.js',
    'scan-coordinator.js',
    'settings.js',
    'sidebar-view.js',
    'state-store.js',
    'sync-reconciliation.js',
    'task-edit-modal.js',
    'task-index.js',
    'task-move-service.js',
    'task-query-service.js',
    'weekly-review-modal.js',
  ]) {
    const floor = coverageBaseline.moduleFloors[name];
    assert.ok(floor, name);
    assert.equal(typeof floor.lines, 'number');
    assert.equal(typeof floor.branches, 'number');
    assert.equal(typeof floor.functions, 'number');
  }
});
