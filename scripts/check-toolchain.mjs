#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';

function cleanVersion(value) {
  return String(value ?? '').trim().replace(/^v/u, '');
}

export function validateToolchain({ nodeVersion, npmVersion, packageJson, packageLock }) {
  const errors = [];
  const nodeMajor = Number.parseInt(cleanVersion(nodeVersion).split('.')[0], 10);
  if (!Number.isInteger(nodeMajor) || nodeMajor < 22 || nodeMajor >= 25) errors.push(`Node ${nodeVersion} is outside supported >=22 <25`);
  const declaredNpm = /^npm@(\d+\.\d+\.\d+)$/u.exec(packageJson.packageManager ?? '')?.[1];
  if (!declaredNpm) errors.push('packageManager must pin an exact npm version');
  else if (cleanVersion(npmVersion) !== declaredNpm) errors.push(`npm ${npmVersion} does not match packageManager npm@${declaredNpm}`);
  for (const name of ['esbuild', 'typescript']) {
    const declared = packageJson.devDependencies?.[name];
    const locked = packageLock.packages?.[`node_modules/${name}`]?.version;
    if (!/^\d+\.\d+\.\d+(?:[-+].+)?$/u.test(declared ?? '')) errors.push(`${name} must be an exact devDependency`);
    if (!locked || locked !== declared) errors.push(`${name} lockfile version ${locked ?? 'missing'} does not match ${declared ?? 'missing'}`);
  }
  return errors;
}

export function currentToolchain(root = process.cwd()) {
  return {
    nodeVersion: process.version,
    npmVersion: execFileSync('npm', ['--version'], { cwd: root, encoding: 'utf8' }).trim(),
    packageJson: JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')),
    packageLock: JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8')),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const current = currentToolchain();
  const errors = validateToolchain(current);
  if (errors.length > 0) {
    console.error('Release toolchain validation failed:');
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log(`Toolchain passed (Node ${cleanVersion(current.nodeVersion)}, npm ${current.npmVersion}, esbuild ${current.packageJson.devDependencies.esbuild}, TypeScript ${current.packageJson.devDependencies.typescript}).`);
}
