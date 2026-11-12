import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { buildStyles } from '../scripts/build-styles.mjs';

test('ordered CSS partials build one deterministic shipped stylesheet', async () => {
  const sources = readdirSync('styles').filter((name) => name.endsWith('.css')).sort();
  assert.deepEqual(sources, ['00-foundation.css', '40-diagnostics-planning.css', '80-dashboard.css']);
  const first = await buildStyles();
  const output = readFileSync('styles.css', 'utf8');
  const second = await buildStyles();
  assert.equal(readFileSync('styles.css', 'utf8'), output);
  assert.deepEqual(second.files, first.files);
  assert.ok(first.outputBytes < first.sourceBytes);
  assert.ok(first.outputBytes <= 275_000, `styles.css ${first.outputBytes} exceeds the reduction target`);
});
