import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function runWithBase(base) {
  return spawnSync(process.execPath, ['scripts/lint-changed.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, LINT_BASE_REF: base, GITHUB_BASE_REF: '' },
  });
}

for (const [name, base] of [
  ['all-zero created-ref sentinel', '0000000000000000000000000000000000000000'],
  ['nonexistent revision', 'refs/heads/definitely-does-not-exist'],
]) {
  void test(`changed-line lint falls back safely from ${name}`, () => {
    const result = runWithBase(base);
    const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    assert.doesNotMatch(output, /Invalid symmetric difference|bad revision|unknown revision/iu);
    assert.notEqual(result.status, 128, output);
  });
}
