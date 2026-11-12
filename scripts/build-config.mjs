import path from 'node:path';

export const PLUGIN_ENTRY_POINT = 'src/main.ts';
export const PLUGIN_OUTFILE = 'main.js';
export const HOST_EXTERNALS = Object.freeze([
  'obsidian',
  '@codemirror/autocomplete',
  '@codemirror/state',
  '@codemirror/view',
  '@codemirror/language',
]);

export function createPluginBuildOptions({ production = false, write = true, outfile = PLUGIN_OUTFILE } = {}) {
  return {
    absWorkingDir: process.cwd(),
    entryPoints: [PLUGIN_ENTRY_POINT],
    bundle: true,
    format: 'cjs',
    target: 'es2020',
    platform: 'node',
    external: [...HOST_EXTERNALS],
    logLevel: 'silent',
    sourcemap: production ? false : 'inline',
    minify: production,
    metafile: true,
    write,
    outfile: path.resolve(outfile),
  };
}
