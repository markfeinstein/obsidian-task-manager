import test from 'node:test';
import assert from 'node:assert/strict';
import { validateBenchmarkEvidence } from '../scripts/check-benchmark-evidence.mjs';

const expected = { expectedRevision: 'abc123', expectedDigest: 'a'.repeat(64) };
const valid = { sourceRevision: expected.expectedRevision, sourceContentSha256: expected.expectedDigest, profile: 'quick', metrics: { scan: {} } };

test('benchmark evidence is bound to exact revision, source digest, and mode', () => {
  assert.deepEqual(validateBenchmarkEvidence(valid, expected), []);
  assert.ok(validateBenchmarkEvidence({ ...valid, sourceRevision: 'other' }, expected)[0].includes('sourceRevision'));
  assert.ok(validateBenchmarkEvidence({ ...valid, sourceContentSha256: 'b'.repeat(64) }, expected)[0].includes('sourceContentSha256'));
  assert.ok(validateBenchmarkEvidence({ ...valid, profile: 'unknown' }, expected)[0].includes('profile'));
});
