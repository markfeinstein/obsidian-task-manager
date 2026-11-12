#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { computeSourceIdentity, sourceRevision } from './source-identity.mjs';

export function validateBenchmarkEvidence(evidence, { expectedRevision, expectedDigest }) {
  const errors = [];
  if (evidence.sourceRevision !== expectedRevision) errors.push(`benchmark sourceRevision ${String(evidence.sourceRevision)} does not match ${expectedRevision}`);
  if (evidence.sourceContentSha256 !== expectedDigest) errors.push(`benchmark sourceContentSha256 ${String(evidence.sourceContentSha256)} does not match ${expectedDigest}`);
  if (evidence.profile !== 'quick' && evidence.profile !== 'full') errors.push(`benchmark profile ${String(evidence.profile)} is not quick/full`);
  if (!evidence.metrics || typeof evidence.metrics !== 'object' || Object.keys(evidence.metrics).length === 0) errors.push('benchmark metrics are missing');
  return errors;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const file = process.argv[2] ?? path.join('benchmark-results', 'results.json');
  const evidence = JSON.parse(readFileSync(file, 'utf8'));
  const errors = validateBenchmarkEvidence(evidence, { expectedRevision: sourceRevision(), expectedDigest: computeSourceIdentity().sha256 });
  if (errors.length > 0) {
    console.error('Benchmark evidence validation failed:');
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log(`Benchmark evidence passed (${evidence.profile}, ${evidence.sourceRevision}, ${evidence.sourceContentSha256.slice(0, 12)}).`);
}
