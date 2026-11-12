import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildAndValidateMobileGraph } from '../scripts/check-mobile-graph.mjs';
import { buildCycloneDxSbom, validateCycloneDxSbom, validateSbomStructure } from '../scripts/generate-sbom.mjs';

test('artifact SBOM contains host delivery components and excludes build/test tools', async () => {
  const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
  const packageLock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
  const { metafile, errors } = await buildAndValidateMobileGraph();
  assert.deepEqual(errors, []);
  const sbom = buildCycloneDxSbom(packageJson, packageLock, metafile);
  assert.deepEqual(validateSbomStructure(sbom), []);
  assert.deepEqual(await validateCycloneDxSbom(sbom), []);
  const names = new Set(sbom.components.map((component) => component.name));
  for (const host of ['obsidian', '@codemirror/autocomplete', '@codemirror/language', '@codemirror/state', '@codemirror/view']) assert.ok(names.has(host));
  for (const tool of ['typescript', 'esbuild', 'terser', 'jsdom', 'axe-core', '@cyclonedx/cyclonedx-library']) assert.equal(names.has(tool), false);
  assert.equal(names.has('chrono-node'), false);
  assert.equal(names.has('rrule'), false);
  assert.ok(sbom.components.every((component) => component.properties.some((property) => property.name === 'task-manager:delivery')));
});

test('SBOM structure rejects duplicate and orphan references', () => {
  const component = { type: 'library', name: 'x', version: '1', 'bom-ref': 'x' };
  const errors = validateSbomStructure({
    metadata: { component: { 'bom-ref': 'app' } },
    components: [component, component],
    dependencies: [{ ref: 'app', dependsOn: [] }],
  });
  assert.ok(errors.some((error) => error.includes('duplicate bom-ref')));
  assert.ok(errors.some((error) => error.includes('orphan component')));
});
