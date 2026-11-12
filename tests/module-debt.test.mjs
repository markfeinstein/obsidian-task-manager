import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { checkModuleDebt, moduleDebt } from '../scripts/check-module-debt.mjs';

test('module debt measures physical lines and static import declarations', () => {
  assert.deepEqual(moduleDebt("import x from 'x';\nconst value = 1;\n"), { lines: 2, imports: 1 });
});

test('hotspot and extracted-module budgets match the reviewed inventory', () => {
  const result = checkModuleDebt();
  assert.deepEqual(result.errors, []);
  const baseline = JSON.parse(readFileSync('quality/module-debt-baseline.json', 'utf8'));
  for (const [file, limits] of Object.entries(baseline.hotspots)) {
    assert.equal(result.measured[file].lines, limits.maxLines, `${file} line ceiling must be ratcheted to current evidence`);
    assert.equal(result.measured[file].imports, limits.maxImports, `${file} import ceiling must be ratcheted to current evidence`);
  }
  for (const [file, limits] of Object.entries(baseline.extractedModules)) {
    assert.ok(result.measured[file].lines <= limits.maxLines, file);
    assert.ok(result.measured[file].imports <= limits.maxImports, file);
  }
});
