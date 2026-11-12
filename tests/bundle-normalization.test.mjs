import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeGeneratedBundle } from '../scripts/bundle-normalization.mjs';

test('generated bundle normalization removes only line-ending horizontal padding', () => {
  const source = 'const value = `kept  inside  \ntrailing   \n`;  \r\n// done\t\n';
  assert.equal(
    normalizeGeneratedBundle(source),
    'const value = `kept  inside\ntrailing\n`;\r\n// done\n',
  );
  assert.equal(normalizeGeneratedBundle(normalizeGeneratedBundle(source)), normalizeGeneratedBundle(source));
});
