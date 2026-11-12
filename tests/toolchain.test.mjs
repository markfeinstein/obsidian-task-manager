import test from 'node:test';
import assert from 'node:assert/strict';
import { validateToolchain } from '../scripts/check-toolchain.mjs';

function fixture(overrides = {}) {
  return {
    nodeVersion: 'v22.20.0',
    npmVersion: '10.9.2',
    packageJson: { packageManager: 'npm@10.9.2', devDependencies: { esbuild: '0.25.12', typescript: '5.9.3' } },
    packageLock: { packages: { 'node_modules/esbuild': { version: '0.25.12' }, 'node_modules/typescript': { version: '5.9.3' } } },
    ...overrides,
  };
}

test('toolchain accepts the exact pinned release environment', () => {
  assert.deepEqual(validateToolchain(fixture()), []);
});

test('toolchain rejects unsupported Node and floating or wrong npm', () => {
  assert.ok(validateToolchain(fixture({ nodeVersion: 'v21.9.0' })).some((error) => error.includes('Node')));
  assert.ok(validateToolchain(fixture({ npmVersion: '11.0.0' })).some((error) => error.includes('does not match')));
  const value = fixture();
  value.packageJson.packageManager = 'npm@^10.9.2';
  assert.ok(validateToolchain(value).some((error) => error.includes('exact npm')));
});

test('toolchain rejects build/type declarations that differ from the lock', () => {
  const value = fixture();
  value.packageLock.packages['node_modules/esbuild'].version = '0.25.11';
  assert.ok(validateToolchain(value).some((error) => error.includes('esbuild lockfile')));
});
