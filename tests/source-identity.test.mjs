import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { computeSourceIdentity, sourceIdentityInputs } from '../scripts/source-identity.mjs';

function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'task-manager-source-id-'));
  mkdirSync(path.join(root, 'src'));
  mkdirSync(path.join(root, 'styles'));
  writeFileSync(path.join(root, 'src', 'a.ts'), 'export const value = 1;\n');
  writeFileSync(path.join(root, 'styles', 'a.css'), '.x { color: red; }\n');
  writeFileSync(path.join(root, 'manifest.json'), '{"version":"1.0.0"}\n');
  return root;
}

test('source content identity is deterministic, ordered, and content-sensitive', (context) => {
  const root = fixture();
  context.after(() => rmSync(root, { recursive: true, force: true }));
  const first = computeSourceIdentity(root);
  const second = computeSourceIdentity(root);
  assert.deepEqual(first, second);
  assert.deepEqual(sourceIdentityInputs(root), ['manifest.json', 'src/a.ts', 'styles/a.css']);
  writeFileSync(path.join(root, 'src', 'a.ts'), 'export const value = 2;\n');
  assert.notEqual(computeSourceIdentity(root).sha256, first.sha256);
});

test('production bundle embeds the exact current full source identity', () => {
  const identity = computeSourceIdentity();
  assert.match(identity.sha256, /^[0-9a-f]{64}$/u);
  assert.ok(readFileSync('main.js', 'utf8').includes(identity.sha256));
});
