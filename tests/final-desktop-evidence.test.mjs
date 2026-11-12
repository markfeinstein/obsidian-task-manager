import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
for (const [catalogue, gallery] of [['desktop-smoke-final-evidence-2026-11-10.json', 'desktop-2026-11-10'], ['desktop-rc-smoke-evidence-2026-11-10.json', 'desktop-final-2026-11-10']]) {
const evidence = JSON.parse(await readFile(new URL(`./fixtures/desktop-evidence/${catalogue}`, import.meta.url), 'utf8'));
const visual = JSON.parse(await readFile(new URL(`../docs/screenshots/${gallery}/capture-manifest.json`, import.meta.url), 'utf8'));

test(`${gallery}: both desktop journeys retain stages, safety and owned shutdown`, () => {
  assert.deepEqual(evidence.cases.map(c => c.version), ['1.11.4', '1.15.0']);
  for (const c of evidence.cases) {
    assert.equal(c.status, 'passed'); assert.equal(c.stages.length, 18);
    assert.ok(c.stages.every(stage => stage.status === 'passed'));
    assert.deepEqual(c.runtimeDiagnostics, []);
    assert.equal(c.syntheticOnly, true); assert.equal(c.independentReview, false);
    assert.equal(c.osReminderDelivery, false); assert.equal(c.liveProviders, false);
    assert.equal(c.ownedProcesses.length, 2); assert.ok(c.ownedProcesses.every(p => p.stopped));
    assert.match(c.reportSha256, /^[a-f0-9]{64}$/);
    assert.equal(c.stages.find(s => s.name.includes('actual plugin Settings')).result.rows, 35);
    assert.equal(c.stages.find(s => s.name.includes('generated Bases')).result.type, 'bases');
  }
  assert.equal(evidence.independentAcceptance, false); assert.equal(evidence.gaAccepted, false);
});

test(`${gallery}: smoke and visual matrix agree on tested runtime artifacts`, () => {
  assert.equal(evidence.sourceContentIdentity, visual.sourceContentIdentity);
  assert.deepEqual(evidence.pluginHashes, visual.pluginHashes);
  for (const c of evidence.cases) {
    assert.equal(c.sourceContentIdentity, evidence.sourceContentIdentity);
    assert.deepEqual(c.pluginHashes, evidence.pluginHashes);
  }
  for (const [name, hash] of Object.entries(evidence.controllerHashes)) assert.equal(hash, visual.families[0].controllerHashes[name]);
});
}
