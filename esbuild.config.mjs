import esbuild from 'esbuild';
import process from 'process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { minify as terserMinify } from 'terser';
import { normalizeGeneratedBundle } from './scripts/bundle-normalization.mjs';
import { buildStyles } from './scripts/build-styles.mjs';
import { createPluginBuildOptions } from './scripts/build-config.mjs';
import { computeSourceIdentity } from './scripts/source-identity.mjs';

const watch = process.argv.includes('--watch');
const isProd = process.argv.includes('--prod');
const analyze = process.argv.includes('--analyze');

await buildStyles();
const sourceIdentity = computeSourceIdentity();

const context = await esbuild.context({
  ...createPluginBuildOptions({ production: isProd }),
  define: {
    __TASK_MANAGER_SOURCE_SHA256__: JSON.stringify(sourceIdentity.sha256),
    __TASK_MANAGER_SOURCE_SHORT__: JSON.stringify(sourceIdentity.short),
  },
  logLevel: 'info',
});

if (watch) {
  await context.watch();
} else {
  const result = await context.rebuild();
  const bundlePath = path.resolve('main.js');
  const generatedBundle = readFileSync(bundlePath, 'utf8');
  const normalizedBundle = normalizeGeneratedBundle(generatedBundle);
  if (isProd) {
    const minified = await terserMinify(normalizedBundle, { compress: { passes: 3, toplevel: true }, mangle: { toplevel: true }, format: { comments: false } });
    if (!minified.code) throw new Error('Terser did not produce a production bundle');
    writeFileSync(bundlePath, `${minified.code}\n`);
  } else if (normalizedBundle !== generatedBundle) {
    writeFileSync(bundlePath, normalizedBundle);
  }
  if (analyze && result.metafile) {
    const outputDir = path.resolve('benchmark-results');
    mkdirSync(outputDir, { recursive: true });
    writeFileSync(path.join(outputDir, 'bundle-metafile.json'), `${JSON.stringify(result.metafile, null, 2)}\n`);
    writeFileSync(path.join(outputDir, 'bundle-analysis.txt'), await esbuild.analyzeMetafile(result.metafile, { verbose: true }));
  }
  await context.dispose();
}
