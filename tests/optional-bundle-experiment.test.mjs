import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

test('optional CommonJS bundle experiment remains a measured no-go without real-host evidence', async () => {
  const { stdout } = await execFileAsync(process.execPath, ['scripts/experiment-optional-bundles.mjs', '--json'], {
    cwd: process.cwd(),
    maxBuffer: 10 * 1024 * 1024,
  });
  const report = JSON.parse(stdout);

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.productionChanged, false);
  assert.equal(report.measurements.currentMainBundleBytes > 0, true);
  assert.equal(report.measurements.standaloneSecondaryBundleBytes > 0, true);
  assert.equal(report.measurements.inputsAlreadyPresentInMainCount, report.measurements.secondaryInputCount);
  assert.equal(report.measurements.candidateOnlyInputCount, 0);
  assert.deepEqual(report.releaseContract.requiredFiles, ['main.js', 'manifest.json', 'versions.json', 'styles.css']);
  assert.equal(report.releaseContract.stylesRemainEager, true);
  assert.equal(Object.values(report.evidence).every((value) => value === false), true);
  assert.equal(report.decision.outcome, 'no-go');
});
