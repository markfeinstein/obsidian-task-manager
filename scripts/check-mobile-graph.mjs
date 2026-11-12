#!/usr/bin/env node
import esbuild from 'esbuild';
import { builtinModules } from 'node:module';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { createPluginBuildOptions, HOST_EXTERNALS } from './build-config.mjs';

const BUILTINS = new Set(builtinModules.map((name) => name.replace(/^node:/u, '')));

function builtinName(specifier) {
  const normalized = specifier.replace(/^node:/u, '');
  const first = normalized.split('/')[0];
  return BUILTINS.has(normalized) || BUILTINS.has(first) ? normalized : null;
}

export function validateMobileMetafile(metafile, allowedExternals = HOST_EXTERNALS) {
  const allowed = new Set(allowedExternals);
  const errors = [];
  const inspect = (owner, imported) => {
    const specifier = imported.path ?? '';
    const builtin = builtinName(specifier);
    if (builtin) errors.push(`${owner} imports Node builtin ${specifier}`);
    if (specifier === 'electron' || specifier.startsWith('electron/')) errors.push(`${owner} imports Electron module ${specifier}`);
    const bare = specifier.length > 0 && !specifier.startsWith('.') && !specifier.startsWith('/') && !/^[A-Za-z]:[\\/]/u.test(specifier);
    if (imported.external && bare && !allowed.has(specifier) && !builtin && specifier !== 'electron') {
      errors.push(`${owner} leaves unapproved external ${specifier}`);
    }
  };
  for (const [input, record] of Object.entries(metafile.inputs ?? {})) {
    for (const imported of record.imports ?? []) inspect(input, imported);
  }
  for (const [output, record] of Object.entries(metafile.outputs ?? {})) {
    for (const imported of record.imports ?? []) inspect(output, imported);
  }
  return [...new Set(errors)].sort();
}

export async function buildAndValidateMobileGraph() {
  const result = await esbuild.build(createPluginBuildOptions({ production: true, write: false }));
  if (!result.metafile) throw new Error('Production build did not emit dependency metadata');
  const errors = validateMobileMetafile(result.metafile);
  return { metafile: result.metafile, errors };
}

async function main() {
  const { metafile, errors } = await buildAndValidateMobileGraph();
  if (errors.length > 0) {
    console.error('Mobile dependency graph validation failed:');
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }
  console.log(`Mobile dependency graph passed (${Object.keys(metafile.inputs).length} inputs; approved host externals only).`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) await main();
