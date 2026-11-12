import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function parseVaultList(value = '') {
  return value.split(path.delimiter).map((entry) => entry.trim()).filter(Boolean);
}

// Vaults that have the plugin installed. Configure locally with:
// OBSIDIAN_TASK_MANAGER_VAULTS="/path/to/vaultA:/path/to/vaultB" npm run deploy
export const VAULTS = parseVaultList(process.env.OBSIDIAN_TASK_MANAGER_VAULTS ?? '');

export const PLUGIN_DIR = '.obsidian/plugins/task-manager';

// Keep the deploy file set aligned with the release artifact checklist.
export const FILES = ['main.js', 'styles.css', 'manifest.json', 'versions.json'];

export function deployToVaults({ sourceDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'), vaults = VAULTS, files = FILES } = {}) {
  let deployed = 0;
  for (const vault of vaults) {
    const dest = path.join(vault, PLUGIN_DIR);
    if (!existsSync(vault)) {
      console.warn(`skip (vault not found): ${vault}`);
      continue;
    }
    mkdirSync(dest, { recursive: true });
    for (const file of files) copyFileSync(path.join(sourceDir, file), path.join(dest, file));
    console.log(`deployed -> ${dest}`);
    deployed += 1;
  }
  return deployed;
}

const isDirectRun = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isDirectRun) {
  const cliVaults = process.argv.slice(2).map((entry) => entry.trim()).filter(Boolean);
  const deployed = deployToVaults({ vaults: cliVaults.length > 0 ? cliVaults : VAULTS });
  if (deployed === 0) {
    console.warn(`No vaults updated. Set OBSIDIAN_TASK_MANAGER_VAULTS or pass vault paths: npm run deploy -- /path/to/vault`);
  } else {
    console.log('\nDone. Reload Obsidian (Cmd+P -> "Reload app without saving") to apply.');
  }
}
