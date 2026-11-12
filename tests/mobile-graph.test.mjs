import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAndValidateMobileGraph, validateMobileMetafile } from '../scripts/check-mobile-graph.mjs';

function graph(importsByInput) {
  return {
    inputs: Object.fromEntries(Object.entries(importsByInput).map(([name, imports]) => [name, { bytes: 1, imports: imports.map((entry) => typeof entry === 'string' ? { path: entry, external: true } : entry) }])),
    outputs: {},
  };
}

for (const specifier of ['fs', 'node:fs/promises', 'crypto', 'electron']) {
  test(`mobile graph rejects ${specifier}`, () => {
    assert.ok(validateMobileMetafile(graph({ 'src/main.ts': [specifier] })).some((error) => error.includes(specifier)));
  });
}

test('mobile graph rejects a transitive builtin and arbitrary external', () => {
  const errors = validateMobileMetafile(graph({
    'src/main.ts': [{ path: 'node_modules/example/index.js', external: false }],
    'node_modules/example/index.js': ['node:path', 'unreviewed-host'],
  }));
  assert.ok(errors.some((error) => error.includes('node:path')));
  assert.ok(errors.some((error) => error.includes('unapproved external unreviewed-host')));
});

test('mobile graph allows only reviewed Obsidian and CodeMirror host externals', () => {
  const errors = validateMobileMetafile(graph({
    'src/main.ts': ['obsidian', '@codemirror/view', '@codemirror/state', '@codemirror/autocomplete', '@codemirror/language'],
  }));
  assert.deepEqual(errors, []);
});

test('the production entry dependency graph is mobile-safe', async () => {
  const { metafile, errors } = await buildAndValidateMobileGraph();
  assert.ok(Object.keys(metafile.inputs).some((input) => input.endsWith('src/main.ts')));
  assert.deepEqual(errors, []);
});
