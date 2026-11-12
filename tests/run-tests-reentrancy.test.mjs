import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import process from 'node:process';
import test from 'node:test';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const root = process.cwd();

function cleanRunnerEnv(overrides = {}) {
  const {
    TASK_MANAGER_TEST_DIST: _parentTestDist,
    TASK_MANAGER_TEST_RUN_INFO: _parentRunInfo,
    TASK_MANAGER_TEST_COVERAGE_DIR: _parentCoverageDir,
    NODE_V8_COVERAGE: _parentV8Coverage,
    ...env
  } = process.env;
  return { ...env, ...overrides };
}

function runScript(script, args = [], env = {}) {
  return execFileAsync(process.execPath, [script, ...args], {
    cwd: root,
    env: cleanRunnerEnv(env),
    maxBuffer: 100 * 1024 * 1024,
  });
}

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

void test('default selected test runs use distinct roots and clean them after concurrent execution', async () => {
  const sandbox = mkdtempSync(path.join(tmpdir(), 'task-manager-runner-test-'));
  try {
    const firstInfo = path.join(sandbox, 'first.json');
    const secondInfo = path.join(sandbox, 'second.json');
    const results = await Promise.allSettled([
      runScript('scripts/run-tests.mjs', ['tests/date-utils.test.ts'], { TASK_MANAGER_TEST_RUN_INFO: firstInfo }),
      runScript('scripts/run-tests.mjs', ['tests/obsidian-harness.test.ts'], { TASK_MANAGER_TEST_RUN_INFO: secondInfo }),
    ]);

    for (const [index, result] of results.entries()) {
      assert.equal(
        result.status,
        'fulfilled',
        `concurrent runner ${index + 1} failed: ${result.status === 'rejected' ? `${result.reason?.stdout ?? ''}${result.reason?.stderr ?? ''}` : ''}`,
      );
    }

    const first = readJson(firstInfo);
    const second = readJson(secondInfo);
    assert.notEqual(first.testDist, second.testDist, 'concurrent invocations must never share compiled output');
    for (const info of [first, second]) {
      assert.equal(info.ownsTestDist, true);
      assert.equal(info.cleaned, true);
      assert.equal(info.status, 0);
      assert.equal(path.dirname(path.resolve(info.testDist)), path.resolve(root, '.test-runs'));
      assert.equal(existsSync(info.testDist), false, `temporary output was not removed: ${info.testDist}`);
    }
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

void test('explicit output roots resolve project dependencies and remain available to their caller', async () => {
  const sandbox = mkdtempSync(path.join(tmpdir(), 'task-manager-explicit-test-'));
  try {
    const output = path.join(sandbox, 'compiled');
    const infoPath = path.join(sandbox, 'run.json');
    await runScript('scripts/run-tests.mjs', ['tests/date-utils.test.ts'], {
      TASK_MANAGER_TEST_DIST: output,
      TASK_MANAGER_TEST_RUN_INFO: infoPath,
    });
    const info = readJson(infoPath);
    assert.equal(info.testDist, output);
    assert.equal(info.ownsTestDist, false);
    assert.equal(info.cleaned, false);
    assert.equal(info.status, 0);
    assert.equal(existsSync(path.join(output, 'src', 'date-utils.js')), true);
    assert.equal(existsSync(path.join(output, 'node_modules', 'obsidian', 'index.js')), true);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

void test('default build-only output remains compatible at .test-dist', async () => {
  const output = path.join(root, '.test-dist');
  rmSync(output, { recursive: true, force: true });
  try {
    await runScript('scripts/run-tests.mjs', ['--build-only']);
    assert.equal(existsSync(path.join(output, 'src', 'main.js')), true);
    assert.equal(existsSync(path.join(output, 'node_modules', 'obsidian', 'index.js')), true);
  } finally {
    rmSync(output, { recursive: true, force: true });
  }
});

void test('coverage uses isolated scratch and publishes complete files to an explicit directory', async () => {
  const sandbox = mkdtempSync(path.join(tmpdir(), 'task-manager-coverage-test-'));
  try {
    const coverageDir = path.join(sandbox, 'coverage');
    const infoPath = path.join(sandbox, 'run.json');
    let failure;
    try {
      await runScript('scripts/run-tests.mjs', ['--coverage', 'tests/csv-utils.test.ts'], {
        TASK_MANAGER_TEST_COVERAGE_DIR: coverageDir,
        TASK_MANAGER_TEST_RUN_INFO: infoPath,
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure, 'a focused coverage run should fail the global threshold rather than bypass it');
    const report = readFileSync(path.join(coverageDir, 'test-coverage.txt'), 'utf8');
    const summary = readJson(path.join(coverageDir, 'summary.json'));
    const info = readJson(infoPath);
    assert.match(report, /end of coverage report/u);
    assert.ok(summary.thresholds?.global);
    assert.ok(summary.actual);
    assert.equal(info.coverageDir, coverageDir);
    assert.equal(info.cleaned, true);
    assert.equal(existsSync(info.testDist), false);
  } finally {
    rmSync(sandbox, { recursive: true, force: true });
  }
});

void test('package validation and benchmarks do not create or require the compatibility .test-dist', async () => {
  const compatibilityOutput = path.join(root, '.test-dist');
  rmSync(compatibilityOutput, { recursive: true, force: true });
  const packageResult = await runScript('scripts/check-package.mjs');
  assert.match(packageResult.stdout, /Package validation passed/u);
  assert.equal(existsSync(compatibilityOutput), false);

  const benchmarkEvidence = path.join(root, 'benchmark-results', 'results.json');
  const evidenceBefore = existsSync(benchmarkEvidence) ? readFileSync(benchmarkEvidence, 'utf8') : null;
  const benchmarkResult = await runScript('scripts/run-benchmarks.mjs', ['--structural-only']);
  assert.match(benchmarkResult.stdout, /PASS scan/u);
  assert.equal(existsSync(compatibilityOutput), false);
  assert.equal(existsSync(benchmarkEvidence) ? readFileSync(benchmarkEvidence, 'utf8') : null, evidenceBefore, 'structural test probes must not replace release benchmark evidence');
});
