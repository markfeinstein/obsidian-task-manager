import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = process.cwd();

test('lint debt is keyed by path/rule instead of a fungible warning total', async () => {
  const [packageJson, baseline] = await Promise.all([
    readFile(`${root}/package.json`, 'utf8').then(JSON.parse),
    readFile(`${root}/quality/lint-warning-baseline.json`, 'utf8').then(JSON.parse),
  ]);

  for (const gate of ['check-architecture.mjs', 'check-lint-baseline.mjs', 'check-ui-literals.mjs', 'check-style-debt.mjs', 'check-style-structure.mjs']) assert.match(packageJson.scripts.lint, new RegExp(gate.replace('.', String.raw`\.`), 'u'));
  assert.doesNotMatch(packageJson.scripts.lint, /max-warnings/u);
  assert.equal(baseline.schemaVersion, 1);
  assert.equal(baseline.totalWarnings, 572);

  let summed = 0;
  const rules = new Set();
  for (const [file, counts] of Object.entries(baseline.entries)) {
    assert.match(file, /^(?:src|tests|scripts)\//u);
    for (const [rule, count] of Object.entries(counts)) {
      assert.equal(Number.isInteger(count) && count > 0, true);
      rules.add(rule);
      summed += count;
    }
  }
  assert.equal(summed, baseline.totalWarnings);
  assert.deepEqual([...rules].sort(), [
    '@typescript-eslint/no-explicit-any',
    '@typescript-eslint/no-non-null-assertion',
  ]);
});

test('style debt is keyed so remaining inline/important usage cannot grow fungibly', async () => {
  const baseline = JSON.parse(await readFile(`${root}/quality/style-debt-baseline.json`, 'utf8'));
  assert.equal(baseline.schemaVersion, 1);
  assert.equal(baseline.importantTotal, 43);
  assert.equal(baseline.inlineStaticTotal, 135);
  assert.equal(Object.keys(baseline.inlineByFile).length > 10, true);
  assert.match(baseline.policy, /Dynamic measured geometry is excluded/u);
});

test('direct user-facing literals have a non-fungible localization baseline', async () => {
  const baseline = JSON.parse(await readFile(`${root}/quality/ui-literal-baseline.json`, 'utf8'));
  assert.equal(baseline.schemaVersion, 1);
  assert.equal(baseline.totalLiterals, 1083);
  assert.equal(Object.keys(baseline.entries).length > 20, true);
  assert.match(baseline.policy, /use t\(\)/iu);
});
