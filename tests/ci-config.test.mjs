import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync('.github/workflows/ci.yml', 'utf8');
const dependabot = readFileSync('.github/dependabot.yml', 'utf8');
const packageJson = JSON.parse(readFileSync('package.json', 'utf8'));
const releaseCheck = readFileSync('scripts/check-release.mjs', 'utf8');

void test('CI pins actions and declares least-privilege operational controls', () => {
  assert.equal(/uses:\s+[^\s@]+@v\d+/u.test(workflow), false, 'actions must be pinned to immutable SHAs');
  assert.match(workflow, /^permissions:\n\s+contents: read/mu);
  assert.match(workflow, /^concurrency:/mu);
  assert.match(workflow, /cancel-in-progress: true/u);
  assert.match(workflow, /timeout-minutes:/u);
});

void test('CI covers platforms, timezones, accessibility, packaging, audits, and benchmarks', () => {
  assert.match(workflow, /os: \[windows-latest, macos-latest\]/u);
  assert.match(workflow, /tz: \[UTC, America\/New_York, Europe\/Berlin, Asia\/Kolkata\]/u);
  assert.match(workflow, /npm run test:coverage/u);
  assert.match(workflow, /COVERAGE_BASE_REF/u);
  assert.match(workflow, /npm run test:a11y/u);
  assert.match(workflow, /npm run check:release -- --reuse-quality/u);
  assert.match(workflow, /release\/mcp-companion\.mjs/u);
  assert.match(workflow, /npm audit --audit-level=high/u);
  assert.match(workflow, /npm run benchmark/u);
  assert.match(workflow, /needs: \[quality, platform-core, timezone-core, performance\]/u);
  assert.doesNotMatch(workflow, /!startsWith\(github\.ref, 'refs\/tags\/'\)/u);
  assert.match(workflow, /--benchmark-evidence benchmark-evidence\/results\.json/u);
  assert.match(workflow, /name: benchmark-\$\{\{ github\.sha \}\}/u);
  assert.match(workflow, /npm run check:docs/u);
  assert.equal((workflow.match(/npm install --global npm@10\.9\.2/gu) ?? []).length, 5);
  assert.equal((workflow.match(/node scripts\/check-toolchain\.mjs/gu) ?? []).length, 5);
  assert.ok(workflow.indexOf('npm install --global npm@10.9.2') < workflow.indexOf('npm ci'));
  assert.match(workflow, /github\.event\.created && 'HEAD\^'/u, 'created tag/ref pushes must not use the all-zero before SHA');
  assert.match(workflow, /tags: \['\[0-9\]\*\.\[0-9\]\*\.\[0-9\]\*'\]/u, 'tag trigger must be a glob that matches bare semver tags');
  assert.doesNotMatch(workflow, /tags: \['\[0-9\]\+\.\[0-9\]\+\.\[0-9\]\+\*'\]/u, 'GitHub tag filters are globs, not regexes');
  assert.match(workflow, /actions\/dependency-review-action@[0-9a-f]{40}/u);
});

void test('release reuse still validates checkout-local generated documentation', () => {
  assert.match(releaseCheck, /Reusing successful upstream test\/type\/lint\/coverage jobs; revalidating checkout-local docs/u);
  const conditionalEnd = releaseCheck.indexOf("run('npm', ['run', 'check:docs'])");
  assert.ok(conditionalEnd > releaseCheck.indexOf('} else {'));
  assert.equal((releaseCheck.match(/\['run', 'check:docs'\]/gu) ?? []).length, 1);
});

void test('release validation can bind benchmark evidence to the candidate', () => {
  assert.match(releaseCheck, /--benchmark-evidence/u);
  assert.match(releaseCheck, /check-benchmark-evidence\.mjs/u);
});

void test('tag publication downloads and publishes the exact attested validation artifact', () => {
  assert.match(workflow, /actions\/attest-build-provenance@[0-9a-f]{40}/u);
  for (const subject of ['release/main.js', 'release/manifest.json', 'release/styles.css', 'release/*.zip', 'release/SHA256SUMS']) assert.match(workflow, new RegExp(subject.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'), 'u'));
  assert.match(workflow, /actions\/download-artifact@[0-9a-f]{40}/u);
  assert.match(workflow, /source_revision.*GITHUB_SHA/su);
  assert.match(workflow, /sha256sum --check SHA256SUMS/u);
  const publishJob = workflow.slice(workflow.indexOf('\n  publish:'));
  assert.doesNotMatch(publishJob, /npm ci|build:prod|check:release/u);
});

void test('dependency automation batches compatible updates and isolates majors', () => {
  assert.match(dependabot, /package-ecosystem: npm/u);
  assert.match(dependabot, /codemirror:/u);
  assert.match(dependabot, /test-tooling:/u);
  assert.match(dependabot, /build-and-types:/u);
  assert.match(dependabot, /version-update:semver-major/u);
  assert.match(dependabot, /package-ecosystem: github-actions/u);
});

void test('package declares a bounded Node/npm toolchain and focused runner', () => {
  assert.equal(packageJson.engines.node, '>=22 <25');
  assert.equal(packageJson.engines.npm, '>=10 <12');
  assert.match(packageJson.packageManager, /^npm@\d+\.\d+\.\d+$/u);
  assert.equal(packageJson.scripts.test, 'node scripts/run-tests.mjs');
  for (const gate of ['check-architecture.mjs', 'check-lint-baseline.mjs', 'check-ui-literals.mjs', 'check-style-debt.mjs', 'check-style-structure.mjs']) {
    assert.match(packageJson.scripts.lint, new RegExp(gate.replace('.', String.raw`\.`), 'u'));
  }
});
