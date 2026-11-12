import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import test from 'node:test';

const directory = new URL('../docs/screenshots/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('capture-manifest.json', directory), 'utf8'));
const sources = [manifest.source, ...manifest.historicalSources];
const sourcesByRevision = new Map(sources.map(source => [source.revision, source]));

// Captures are historical snapshots: their recorded source need not equal a later HEAD.
test('published screenshot PNGs match their provenance hashes, sizes, and dimensions', () => {
  assert.equal(manifest.schemaVersion, 2);
  assert.equal(sourcesByRevision.size, sources.length, 'source revisions must be unique');
  assert.ok(manifest.screenshots.length > 0);
  const names = manifest.screenshots.map(entry => entry.file).sort();
  assert.deepEqual(names, [...new Set(names)]);
  assert.deepEqual(readdirSync(directory).filter(name => name.endsWith('.png')).sort(), names);
  for (const entry of manifest.screenshots) {
    assert.match(entry.file, /^[a-z0-9-]+\.png$/u);
    const bytes = readFileSync(new URL(entry.file, directory));
    assert.equal(bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', entry.file);
    assert.equal(bytes.length, entry.bytes, entry.file);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, entry.file);
    assert.equal(bytes.readUInt32BE(16), entry.width, entry.file);
    assert.equal(bytes.readUInt32BE(20), entry.height, entry.file);
    const source = sourcesByRevision.get(entry.sourceRevision);
    assert.ok(source, 'each capture must reference a declared source snapshot');
    assert.equal(entry.sourceIdentity, source.contentIdentity);
    if (entry.focusEmulation !== undefined) assert.equal(typeof entry.focusEmulation, 'boolean');
    assert.equal(entry.taskCount, manifest.seed.taskCount);
    assert.ok(Number.isFinite(Date.parse(entry.capturedAt)));
    if (entry.cropSelector === null) {
      assert.equal(entry.width, entry.viewport.width * entry.viewport.devicePixelRatio);
      assert.equal(entry.height, entry.viewport.height * entry.viewport.devicePixelRatio);
    }
  }
});

test('desktop screenshot evidence retains synthetic-data, source, and non-mobile boundaries', () => {
  for (const source of sources) {
    assert.match(source.revision, /^[a-f0-9]{40}$/u);
    assert.match(source.contentIdentity, /^[a-f0-9]{64}$/u);
    for (const hash of Object.values(source.pluginArtifactSha256)) assert.match(hash, /^[a-f0-9]{64}$/u);
  }
  assert.equal(manifest.safety.syntheticDataOnly, true);
  assert.deepEqual(manifest.safety.enabledCommunityPlugins, ['task-manager']);
  for (const key of ['enableReminderNotifications', 'todoistSyncEnabled', 'caldavSyncEnabled', 'googleTasksEnabled', 'googleCalendarEnabled', 'msToDoEnabled', 'appleRemindersEnabled', 'appleRemindersWebhookEnabled', 'aiQueryEnabled']) {
    assert.equal(manifest.safety.settings[key], false, key);
  }
  assert.equal(manifest.capture.protocolMethod, 'Page.captureScreenshot');
  assert.equal(manifest.capture.mobileEmulation, false);
  assert.equal(manifest.evidenceScope.desktopCapture, true);
  for (const key of ['realMobileDevice', 'liveProviderAccounts', 'independentAccessibilityReview', 'fullVisualMatrix']) assert.equal(manifest.evidenceScope[key], false, key);
  assert.doesNotMatch(JSON.stringify(manifest), /(?:\/Users\/|\/home\/|[A-Za-z]:\\Users\\)/u);
});


test('recorded overdue summary measurements meet normal-text contrast in both desktop themes', () => {
  const evidence = manifest.runtimeChecks.overdueContrast;
  assert.ok(sources.some(source => source.contentIdentity === evidence.sourceIdentity));
  const pairs = [];
  const luminance = rgba => rgba.slice(0, 3).reduce((sum, value, index) => {
    const s = value / 255;
    const linear = s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    return sum + linear * [0.2126, 0.7152, 0.0722][index];
  }, 0);
  for (const measurement of evidence.checks) {
    pairs.push(measurement.file + ':' + measurement.theme);
    assert.equal(measurement.minimum, 4.5);
    assert.equal(measurement.passed, true);
    assert.equal(measurement.taskCount, manifest.seed.taskCount);
    for (const rgba of [measurement.foregroundRGBA, measurement.backgroundRGBA]) {
      assert.equal(rgba.length, 4);
      assert.ok(rgba.every(value => Number.isInteger(value) && value >= 0 && value <= 255));
      assert.equal(rgba[3], 255, 'opaque colors make this ratio directly reproducible');
    }
    const a = luminance(measurement.foregroundRGBA), b = luminance(measurement.backgroundRGBA);
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    assert.ok(ratio >= 4.5);
    assert.ok(Math.abs(ratio - measurement.contrastRatio) < 1e-9);
  }
  assert.deepEqual(pairs.sort(), ['Queries', 'Kanban', 'Table'].flatMap(name =>
    ['light', 'dark'].map(theme => 'Showcase/' + name + '.md:' + theme)).sort());
  if (evidence.footerRuntime.status === 'partial') {
    assert.ok(evidence.footerRuntime.reason);
    assert.ok(evidence.footerRuntime.nextCheck);
  }
});
