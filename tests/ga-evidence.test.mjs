import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateGaEvidence, validateOwnerReleaseConfig } from '../scripts/check-ga-evidence.mjs';

const schema = JSON.parse(readFileSync('quality/ga-evidence-schema.json', 'utf8'));
const revision = 'a'.repeat(40);
const digest = 'b'.repeat(64);
const pluginId = 'task-manager';
const now = new Date('2026-07-12T12:00:00.000Z');
const ownerConfig = {
  schemaVersion: 1,
  repositoryUrl: 'https://code.owner.test/task-manager',
  homepageUrl: 'https://product.owner.test/task-manager',
  releaseBaseUrl: 'https://code.owner.test/task-manager/releases',
  supportUrl: 'https://support.owner.test/task-manager',
  communityPlugins: {
    status: 'listed', pluginId,
    upstreamCommitUrl: `https://code.owner.test/obsidian-releases/commit/${'c'.repeat(40)}/${pluginId}`,
  },
};
const initialOwnerConfig = structuredClone(ownerConfig);
initialOwnerConfig.communityPlugins = { status: 'unlisted', pluginId };
const submittedOwnerConfig = structuredClone(initialOwnerConfig);
submittedOwnerConfig.communityPlugins = {
  status: 'submitted', pluginId,
  submissionUrl: 'https://code.owner.test/obsidian-releases/pull/1234',
};
const packageJson = {
  repository: { url: ownerConfig.repositoryUrl }, homepage: ownerConfig.homepageUrl, bugs: { url: ownerConfig.supportUrl },
};

const record = (subjectVersion = 'real-device-1') => ({
  status: 'passed',
  observedAt: '2026-07-11T10:00:00.000Z',
  artifactUrl: 'https://evidence.owner.test/actions/runs/123456/artifacts/789',
  artifactSha256: 'd'.repeat(64),
  tester: { id: 'tester-one' },
  reviewer: { id: 'reviewer-two', approvedAt: '2026-07-11T11:00:00.000Z' },
  environment: { obsidianVersion: '1.8.10', pluginVersion: '1.0.0+src.abcdef123456', os: 'Real OS 1', subjectVersion },
  notes: 'Observed the named behavior on retained owner hardware with recorded steps and results.',
});

function completeFixture() {
  return {
    schemaVersion: 2,
    sourceRevision: revision,
    sourceContentSha256: digest,
    platforms: Object.fromEntries(schema.requiredPlatforms.map((name) => [name, record(name)])),
    installation: Object.fromEntries(schema.requiredInstallation.map((name) => [name, record(name)])),
    accessibility: Object.fromEntries(schema.requiredAccessibility.map((name) => [name, record(name)])),
    providers: Object.fromEntries(schema.requiredProviders.map((name) => [name, record(name)])),
    visualInteraction: Object.fromEntries(schema.requiredVisualInteraction.map((name) => [name, record(name)])),
  };
}

function validate(evidence = completeFixture(), config = ownerConfig) {
  return validateGaEvidence(evidence, {
    expectedRevision: revision, expectedDigest: digest, schema, ownerConfig: config,
    packageJson, pluginId, allowTestValues: true, now,
  });
}

test('GA evidence schema accepts complete digest-bound independently reviewed records', () => {
  assert.deepEqual(validate(), []);
});

test('GA evidence rejects missing digest, bad hash, mutable URL, stale/future time, and self approval', () => {
  const evidence = completeFixture();
  evidence.sourceContentSha256 = 'wrong';
  evidence.platforms.minimumAndroid.artifactSha256 = 'short';
  evidence.providers.caldav.artifactUrl = 'https://evidence.owner.test/releases/latest/result.json';
  evidence.accessibility.nvdaWindows.observedAt = '2026-01-01T00:00:00.000Z';
  evidence.platforms.currentIos.observedAt = '2026-07-13T00:00:00.000Z';
  evidence.providers.todoist.reviewer.id = 'tester-one';
  evidence.visualInteraction.rtl.environment.subjectVersion = 'JSDOM synthetic fixture';
  const errors = validate(evidence);
  for (const fragment of ['sourceContentSha256', 'artifactSha256', 'artifactUrl', 'older than', 'future', 'independent reviewer', 'real host']) {
    assert.ok(errors.some((error) => error.includes(fragment)), fragment);
  }
});

test('initial-submission owner config accepts unlisted and submitted registry states', () => {
  for (const config of [initialOwnerConfig, submittedOwnerConfig]) {
    assert.deepEqual(validateOwnerReleaseConfig(config, {
      packageJson, pluginId, releaseStage: 'initial-submission', allowTestValues: true,
    }), []);
  }
});

test('release stages reject registry evidence from the wrong lifecycle phase', () => {
  const initialErrors = validateOwnerReleaseConfig(ownerConfig, {
    packageJson, pluginId, releaseStage: 'initial-submission', allowTestValues: true,
  });
  assert.ok(initialErrors.some((error) => error.includes('unlisted or submitted')));

  const gaErrors = validateOwnerReleaseConfig(initialOwnerConfig, {
    packageJson, pluginId, releaseStage: 'ga', allowTestValues: true,
  });
  assert.ok(gaErrors.some((error) => error.includes('listed for a GA release')));
  assert.ok(gaErrors.some((error) => error.includes('immutable upstream')));

  const submittedWithoutUrl = structuredClone(submittedOwnerConfig);
  delete submittedWithoutUrl.communityPlugins.submissionUrl;
  const submittedErrors = validateOwnerReleaseConfig(submittedWithoutUrl, {
    packageJson, pluginId, releaseStage: 'initial-submission', allowTestValues: true,
  });
  assert.ok(submittedErrors.some((error) => error.includes('pull-request URL')));
});

test('owner release config rejects placeholders, metadata mismatch, and absent registry listing', () => {
  const config = structuredClone(ownerConfig);
  config.communityPlugins.status = 'submitted';
  config.communityPlugins.upstreamCommitUrl = 'https://example.invalid/latest';
  const errors = validateOwnerReleaseConfig(config, { packageJson: {}, pluginId, allowTestValues: false });
  assert.ok(errors.some((error) => error.includes('listed for a GA release')));
  assert.ok(errors.some((error) => error.includes('immutable upstream')));
  assert.ok(errors.some((error) => error.includes('package.repository')));
});

test('CI requires an explicit stage and separates initial submission from GA evidence', () => {
  const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
  const packageData = JSON.parse(readFileSync('package.json', 'utf8'));
  assert.equal(packageData.scripts['check:initial-release'], 'node scripts/check-ga-evidence.mjs --initial-submission');
  assert.equal(packageData.scripts['check:ga-evidence'], 'node scripts/check-ga-evidence.mjs');
  assert.match(workflow, /OBSIDIAN_RELEASE_STAGE: \$\{\{ vars\.OBSIDIAN_RELEASE_STAGE \}\}/u);
  assert.match(workflow, /initial-submission\|ga/u);
  assert.match(workflow, /vars\.OBSIDIAN_RELEASE_STAGE == 'initial-submission'[\s\S]*npm run check:initial-release/u);
  assert.match(workflow, /vars\.OBSIDIAN_RELEASE_STAGE == 'ga'[\s\S]*npm run check:ga-evidence/u);
  const initialStep = workflow.slice(
    workflow.indexOf('Require owner configuration before initial submission publication'),
    workflow.indexOf('Require owner and real-host evidence before public GA publication'),
  );
  assert.doesNotMatch(initialStep, /GA_EVIDENCE_JSON/u);
});
