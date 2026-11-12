#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import process from 'node:process';
import { findOutdatedReleaseArtifacts, validateRequiredReleaseFiles } from './package-helpers.mjs';

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    shell: process.platform === 'win32',
    stdio: 'inherit',
  });

  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

const reuseQualityEvidence = process.argv.includes('--reuse-quality');
const workingTreeValidation = process.argv.includes('--working-tree');
const benchmarkEvidenceFlag = process.argv.indexOf('--benchmark-evidence');
const benchmarkEvidence = benchmarkEvidenceFlag >= 0 ? process.argv[benchmarkEvidenceFlag + 1] : undefined;
if (benchmarkEvidenceFlag >= 0 && !benchmarkEvidence) {
  console.error('--benchmark-evidence requires a results.json path');
  process.exit(1);
}

run('npm', ['run', 'check:toolchain']);
if (!reuseQualityEvidence) {
  run('npm', ['test']);
  run('npm', ['run', 'typecheck']);
  run('npm', ['run', 'lint']);
  run('npm', ['run', 'lint:changed']);
  run('npm', ['run', 'test:coverage']);
} else {
  console.log('Reusing successful upstream test/type/lint/coverage jobs; revalidating checkout-local docs and artifacts.');
}
run('npm', ['run', 'check:docs']);
if (benchmarkEvidence) run(process.execPath, ['scripts/check-benchmark-evidence.mjs', benchmarkEvidence]);
run('npm', ['audit', '--audit-level=high']);
run('npm', ['audit', '--omit=dev', '--audit-level=high']);
run('npm', ['run', 'build:prod']);
run('npm', ['run', 'check:version']);
run('npm', ['run', 'check:package']);

if (!workingTreeValidation) {
  const outdatedArtifacts = findOutdatedReleaseArtifacts(process.cwd());
  if (outdatedArtifacts.length > 0) {
    console.error('Release artifacts are out of date with the committed versions (run the build and commit the result):');
    for (const file of outdatedArtifacts) {
      console.error(`- ${file}`);
    }
    process.exit(1);
  }
} else {
  console.log('Working-tree mode: generated artifact freshness is validated by the build/package checks, but commit/tag freshness is intentionally deferred.');
}

const releaseFileErrors = validateRequiredReleaseFiles(process.cwd());
if (releaseFileErrors.length > 0) {
  console.error('Release file check failed:');
  for (const error of releaseFileErrors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

if (!workingTreeValidation) {
  run('npm', ['run', 'package:release']);
  console.log('Release validation passed.');
} else {
  console.log('Working-tree release validation passed. Commit the reviewed files, then run the normal release gate before tagging.');
}
