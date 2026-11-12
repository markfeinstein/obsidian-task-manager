#!/usr/bin/env node
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import AdmZip from 'adm-zip';
import { buildCycloneDxSbom, validateCycloneDxSbom } from './generate-sbom.mjs';
import { buildAndValidateMobileGraph } from './check-mobile-graph.mjs';
import { computeSourceIdentity, gitDirtyPaths, sourceRevision } from './source-identity.mjs';
import { REQUIRED_RELEASE_FILES, createReleaseDirectory, sha256File, validateStagedRelease } from './package-helpers.mjs';
import { currentToolchain, validateToolchain } from './check-toolchain.mjs';

const root = process.cwd();
const toolchain = currentToolchain(root);
const toolchainErrors = validateToolchain(toolchain);
if (toolchainErrors.length > 0) throw new Error(`Release toolchain mismatch:\n${toolchainErrors.join('\n')}`);
const workingTreeMode = process.argv.includes('--working-tree');
const dirtyPaths = gitDirtyPaths(root);
if (dirtyPaths.length > 0 && !workingTreeMode) {
  console.error('Publishable packaging requires a clean Git worktree. Dirty paths:');
  for (const changed of dirtyPaths) console.error(`- ${changed}`);
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(path.join(root, 'manifest.json'), 'utf8'));
const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const packageLock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
const identity = computeSourceIdentity(root);
const releaseRoot = path.join(root, 'release');
const packageName = `${manifest.id}-${manifest.version}`;
const packageDir = path.join(releaseRoot, packageName);
const archiveName = `${packageName}+src.${identity.short}.zip`;
const archivePath = path.join(releaseRoot, archiveName);
const companionName = 'mcp-companion.mjs';
const companionPath = path.join(releaseRoot, companionName);

const bundle = readFileSync(path.join(root, 'main.js'), 'utf8');
if (!bundle.includes(identity.sha256)) throw new Error('main.js source identity is stale; run npm run build:prod before packaging');

createReleaseDirectory(releaseRoot);
mkdirSync(packageDir);
for (const file of REQUIRED_RELEASE_FILES) copyFileSync(path.join(root, file), path.join(packageDir, file));
copyFileSync(path.join(root, 'scripts', companionName), companionPath);

const errors = validateStagedRelease(packageDir);
if (errors.length > 0) {
  for (const error of errors) console.error(error);
  process.exit(1);
}
// Obsidian downloads these three files directly from the GitHub release assets
// (by name), so publish them as loose top-level files, not only inside the
// ZIP/subdirectory. The ZIP + subdir remain as supplementary provenance.
const INSTALL_ASSETS = ['manifest.json', 'main.js', 'styles.css'];
for (const file of INSTALL_ASSETS) copyFileSync(path.join(root, file), path.join(releaseRoot, file));
const archive = new AdmZip();
for (const file of REQUIRED_RELEASE_FILES) {
  archive.addFile(file, readFileSync(path.join(packageDir, file)));
  const entry = archive.getEntry(file);
  if (entry) entry.header.time = new Date(Date.UTC(1980, 0, 1));
}
archive.writeZip(archivePath);

const graph = await buildAndValidateMobileGraph();
if (graph.errors.length > 0) throw new Error(`Cannot package an unsafe mobile dependency graph:\n${graph.errors.join('\n')}`);
const sbom = buildCycloneDxSbom(packageJson, packageLock, graph.metafile);
const sbomErrors = await validateCycloneDxSbom(sbom);
if (sbomErrors.length > 0) throw new Error(`CycloneDX validation failed:\n${sbomErrors.join('\n')}`);
const sbomPath = path.join(releaseRoot, 'sbom.cdx.json');
writeFileSync(sbomPath, `${JSON.stringify(sbom, null, 2)}\n`);

const artifactHashes = Object.fromEntries([
  ...INSTALL_ASSETS.map((file) => [file, sha256File(path.join(releaseRoot, file))]),
  [archiveName, sha256File(archivePath)],
  [companionName, sha256File(companionPath)],
  ['sbom.cdx.json', sha256File(sbomPath)],
]);
const lockedVersion = (name) => packageLock.packages?.[`node_modules/${name}`]?.version ?? 'not-locked';
const releaseMetadata = {
  id: manifest.id,
  version: manifest.version,
  displayVersion: `${manifest.version}+src.${identity.short}`,
  sourceContentSha256: identity.sha256,
  sourceIdentityInputs: identity.files,
  sourceRevision: sourceRevision(root),
  dirty: dirtyPaths.length > 0,
  files: REQUIRED_RELEASE_FILES,
  installAssets: INSTALL_ASSETS,
  archive: archiveName,
  companionAssets: [companionName],
  toolchain: {
    node: process.version,
    npm: toolchain.npmVersion,
    esbuild: lockedVersion('esbuild'),
    typescript: lockedVersion('typescript'),
  },
  artifactSha256: artifactHashes,
};
const metadataPath = path.join(releaseRoot, 'release-metadata.json');
writeFileSync(metadataPath, `${JSON.stringify(releaseMetadata, null, 2)}\n`);

const checksumEntries = [
  ...Object.entries(artifactHashes),
  ['release-metadata.json', sha256File(metadataPath)],
];
writeFileSync(path.join(releaseRoot, 'SHA256SUMS'), `${checksumEntries.map(([file, digest]) => `${digest}  ${file}`).join('\n')}\n`);
console.log(`Packaged ${packageName} as ${archiveName} (${workingTreeMode ? 'working-tree' : 'clean'} mode).`);
