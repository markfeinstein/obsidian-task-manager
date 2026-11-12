import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { deployToVaults, FILES, PLUGIN_DIR, parseVaultList } from '../scripts/deploy.mjs';

test('deploy script parses configured vault lists', () => {
  assert.deepEqual(parseVaultList(`/tmp/A${path.delimiter} /tmp/B ${path.delimiter}`), ['/tmp/A', '/tmp/B']);
  assert.deepEqual(parseVaultList(''), []);
});

test('deploy script copies all release files including versions.json', () => {
  const sourceDir = mkdtempSync(path.join(tmpdir(), 'task-manager-deploy-src-'));
  const vaultRoot = mkdtempSync(path.join(tmpdir(), 'task-manager-deploy-vault-'));
  const vault = path.join(vaultRoot, 'Vault');
  mkdirSync(vault, { recursive: true });

  for (const file of FILES) {
    writeFileSync(path.join(sourceDir, file), `content:${file}`, 'utf8');
  }

  const deployed = deployToVaults({ sourceDir, vaults: [vault] });
  const pluginDir = path.join(vault, PLUGIN_DIR);

  assert.equal(deployed, 1);
  for (const file of FILES) {
    const filePath = path.join(pluginDir, file);
    assert.equal(existsSync(filePath), true, `${file} should be copied`);
    assert.equal(readFileSync(filePath, 'utf8'), `content:${file}`);
  }
});
