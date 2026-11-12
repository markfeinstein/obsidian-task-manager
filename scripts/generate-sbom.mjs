#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { Spec, Validation } from '@cyclonedx/cyclonedx-library';
import { HOST_EXTERNALS } from './build-config.mjs';
import { buildAndValidateMobileGraph } from './check-mobile-graph.mjs';

function purlName(name) {
  return encodeURIComponent(name).replace('%2F', '/');
}

function lockEntryForInput(input, packages) {
  const normalized = input.replaceAll('\\', '/');
  return Object.entries(packages)
    .filter(([packagePath, entry]) => packagePath.includes('node_modules/') && entry?.version
      && (normalized === packagePath || normalized.startsWith(`${packagePath}/`)))
    .sort(([left], [right]) => right.length - left.length)[0];
}

function packageName(packagePath, entry) {
  if (entry.name) return entry.name;
  const marker = 'node_modules/';
  const start = packagePath.lastIndexOf(marker) + marker.length;
  const segments = packagePath.slice(start).split('/');
  return segments[0]?.startsWith('@') ? `${segments[0]}/${segments[1]}` : segments[0];
}

function componentFor(name, version, { delivery, bytes = 0, license } = {}) {
  const purl = `pkg:npm/${purlName(name)}@${version}`;
  const component = {
    type: 'library',
    'bom-ref': purl,
    name,
    version,
    purl,
    scope: 'required',
    properties: [
      { name: 'task-manager:delivery', value: delivery },
      { name: 'task-manager:bytes-in-output', value: String(bytes) },
    ],
  };
  if (license) component.licenses = [{ license: { id: license } }];
  return component;
}

export function buildCycloneDxSbom(packageJson, packageLock, metafile = { inputs: {}, outputs: {} }) {
  const packages = packageLock.packages ?? {};
  const bundledBytes = new Map();
  for (const output of Object.values(metafile.outputs ?? {})) {
    for (const [input, contribution] of Object.entries(output.inputs ?? {})) {
      const matched = lockEntryForInput(input, packages);
      if (!matched) continue;
      const [packagePath, entry] = matched;
      const key = `${packagePath}\0${entry.version}`;
      bundledBytes.set(key, (bundledBytes.get(key) ?? 0) + (contribution.bytesInOutput ?? 0));
    }
  }

  const componentsByRef = new Map();
  for (const [key, bytes] of bundledBytes) {
    const [packagePath] = key.split('\0');
    const entry = packages[packagePath];
    const component = componentFor(packageName(packagePath, entry), entry.version, { delivery: 'bundled', bytes, license: entry.license });
    componentsByRef.set(component['bom-ref'], component);
  }
  for (const name of HOST_EXTERNALS) {
    const entry = packages[`node_modules/${name}`];
    const declared = packageJson.dependencies?.[name] ?? packageJson.devDependencies?.[name];
    const version = entry?.version ?? (typeof declared === 'string' ? declared.replace(/^[~^]/u, '') : 'host');
    const component = componentFor(name, version, { delivery: 'host-provided', bytes: 0, license: entry?.license });
    componentsByRef.set(component['bom-ref'], component);
  }
  const components = [...componentsByRef.values()].sort((left, right) => left.purl.localeCompare(right.purl));
  const appRef = `pkg:npm/${purlName(packageJson.name)}@${packageJson.version}`;
  const lockHash = createHash('sha256').update(JSON.stringify(packageLock)).digest('hex');
  const lockedVersion = (name) => packages[`node_modules/${name}`]?.version ?? 'not-locked';
  const dependencies = [
    { ref: appRef, dependsOn: components.map((component) => component['bom-ref']).sort() },
    ...components.map((component) => ({ ref: component['bom-ref'], dependsOn: [] })),
  ];
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    version: 1,
    metadata: {
      component: { type: 'application', 'bom-ref': appRef, name: packageJson.name, version: packageJson.version, purl: appRef },
      properties: [
        { name: 'task-manager:package-lock-sha256', value: lockHash },
        { name: 'task-manager:package-manager', value: packageJson.packageManager ?? 'unknown' },
        { name: 'task-manager:tool:esbuild', value: lockedVersion('esbuild') },
        { name: 'task-manager:tool:typescript', value: lockedVersion('typescript') },
      ],
    },
    components,
    dependencies,
  };
}

export function validateSbomStructure(sbom) {
  const errors = [];
  const components = sbom.components ?? [];
  const refs = new Set();
  for (const component of components) {
    if (!component['bom-ref']) errors.push(`component ${component.name ?? '<unknown>'} has no bom-ref`);
    else if (refs.has(component['bom-ref'])) errors.push(`duplicate bom-ref ${component['bom-ref']}`);
    else refs.add(component['bom-ref']);
  }
  const appRef = sbom.metadata?.component?.['bom-ref'];
  const dependencyRefs = new Set((sbom.dependencies ?? []).map((entry) => entry.ref));
  if (!dependencyRefs.has(appRef)) errors.push('application dependency node is missing');
  for (const ref of refs) if (!dependencyRefs.has(ref)) errors.push(`orphan component ${ref}`);
  for (const dependency of sbom.dependencies ?? []) {
    for (const target of dependency.dependsOn ?? []) if (!refs.has(target)) errors.push(`unknown dependency target ${target}`);
  }
  return errors;
}

export async function validateCycloneDxSbom(sbom) {
  const structural = validateSbomStructure(sbom);
  if (structural.length > 0) return structural;
  const validator = new Validation.JsonValidator(Spec.Version.v1dot5);
  const result = await validator.validate(JSON.stringify(sbom));
  return result === null ? [] : [typeof result === 'string' ? result : JSON.stringify(result)];
}

async function main() {
  const root = process.cwd();
  const packageJson = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
  const packageLock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8'));
  const { metafile, errors: graphErrors } = await buildAndValidateMobileGraph();
  if (graphErrors.length > 0) throw new Error(`Cannot generate SBOM from unsafe graph:\n${graphErrors.join('\n')}`);
  const sbom = buildCycloneDxSbom(packageJson, packageLock, metafile);
  const validationErrors = await validateCycloneDxSbom(sbom);
  if (validationErrors.length > 0) throw new Error(`CycloneDX validation failed:\n${validationErrors.join('\n')}`);
  const output = process.argv[2] ?? path.join(root, 'release', 'sbom.cdx.json');
  writeFileSync(output, `${JSON.stringify(sbom, null, 2)}\n`);
  console.log(`Generated ${output} (${sbom.components.length} shipped/host components).`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) await main();
