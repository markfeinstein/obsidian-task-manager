import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
for (const gallery of ['desktop-2026-11-10', 'desktop-final-2026-11-10']) {
const root = new URL(`../docs/screenshots/${gallery}/`, import.meta.url);
const manifest = JSON.parse(await readFile(new URL('capture-manifest.json', root), 'utf8'));

test(`${gallery}: retains all source-bound observations and acceptance boundaries`, () => {
  assert.equal(manifest.cases.length, 144);
  assert.equal(new Set(manifest.cases.map(c => c.id)).size, 144);
  assert.deepEqual(manifest.families.map(f => [f.family, f.cases, f.indexedTasks]), [['normal', 132, 62], ['empty', 6, 0], ['dense', 6, 182]]);
  assert.match(manifest.sourceContentIdentity, /^[a-f0-9]{64}$/);
  assert.match(manifest.runtimeSourceRevision, /^[a-f0-9]{40}$/);
  assert.equal(manifest.host.installer, '1.15.0');
  assert.deepEqual(Object.keys(manifest.pluginHashes).sort(), ['main.js', 'manifest.json', 'styles.css', 'versions.json']);
  for (const family of manifest.families) {
    assert.equal(family.status, 'passed'); assert.equal(family.runtimeExceptions, 0);
    assert.equal(family.ownedProcessStopped, true);
    assert.deepEqual(family.controllerHashes, manifest.families[0].controllerHashes);
  }
  for (const c of manifest.cases) {
    if (c.category === 'error') assert.equal(c.measured.expectedError, 1);
    else {
      assert.equal(c.measured.loading, 0); assert.deepEqual(c.measured.overlaps, []);
      assert.ok(c.measured.gridHorizontalOverflow <= 2);
    }
    assert.match(c.image.sha256, /^[a-f0-9]{64}$/);
  }
  const medium = manifest.cases.find(c => c.id === 'responsive-900-native-spacious-light');
  assert.equal(medium.measured.displayCols, 48);
  for (const c of manifest.cases.filter(c => c.category === 'focus-state')) {
    assert.ok(c.measured.cardOverflow.find(card => card.type === 'quick-capture').scroll <= 2);
  }
  for (const key of ['realMobileDevice', 'realTouchAcceptance', 'independentAcceptance', 'gaAccepted', 'liveProviders', 'osReminderDelivery']) assert.equal(manifest[key], false);
});

test(`${gallery}: selected PNGs retain the unretouched captured bytes`, async () => {
  assert.equal(manifest.assets.length, 28);
  for (const asset of manifest.assets) {
    assert.equal(asset.rawUnretouched, true);
    const bytes = await readFile(new URL(asset.file, root));
    assert.equal(hash(bytes), asset.sha256); assert.equal(bytes.length, asset.bytes);
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    assert.equal(bytes.readUInt32BE(16), asset.width); assert.equal(bytes.readUInt32BE(20), asset.height);
    assert.equal(manifest.cases.find(c => c.id === asset.id).image.sha256, asset.sha256);
  }
});

test(`${gallery}: capture animation retains genuine frames and exactly-once evidence`, async () => {
  const animation = manifest.animation;
  const bytes = await readFile(new URL(animation.file, root));
  assert.equal(hash(bytes), animation.sha256); assert.equal(bytes.length, animation.bytes);
  assert.equal(animation.timeline.length, 21); assert.equal(animation.frames, 21);
  assert.equal(animation.persistedOnce, true);
  for (let i = 0; i < animation.timeline.length; i++) {
    assert.match(animation.timeline[i].sha256, /^[a-f0-9]{64}$/);
    if (i) assert.ok(animation.timeline[i].startedMs > animation.timeline[i - 1].startedMs);
  }
  let animationControl;
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (bytes.toString('ascii', offset + 4, offset + 8) === 'acTL') animationControl = offset + 8;
    offset += length + 12;
  }
  assert.ok(animationControl); assert.equal(bytes.readUInt32BE(animationControl), 21);
  assert.equal(bytes.readUInt32BE(animationControl + 4), 0, 'explicit infinite playback loop');
});
}
