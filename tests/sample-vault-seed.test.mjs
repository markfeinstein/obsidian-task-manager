import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { seedSampleVault } from '../scripts/seed-sample-vault.mjs';

test('sample vault seeding shifts fixed visual dates without modifying tracked fixtures', (context) => {
  const temporary = mkdtempSync(path.join(tmpdir(), 'task-manager-sample-seed-'));
  context.after(() => rmSync(temporary, { recursive: true, force: true }));
  const tracked = readFileSync('sample-vault/Dashboard Visual QA Seed.md', 'utf8');
  const output = path.join(temporary, 'vault');
  const result = seedSampleVault({ source: 'sample-vault', output, date: '2026-07-13' });
  const generated = readFileSync(path.join(output, 'Dashboard Visual QA Seed.md'), 'utf8');
  assert.equal(result.dayDelta, 48);
  assert.match(generated, /Overdue launch task[^\n]*2026-07-07/u);
  assert.equal(readFileSync('sample-vault/Dashboard Visual QA Seed.md', 'utf8'), tracked);
  assert.match(readFileSync(path.join(output, 'Daily', '2026-07-13.md'), 'utf8'), /# 2026-07-13/u);
});

test('sample vault seeding rejects in-place or nested output', () => {
  assert.throws(() => seedSampleVault({ source: 'sample-vault', output: 'sample-vault/generated', date: '2026-07-13' }), /outside/u);
});
