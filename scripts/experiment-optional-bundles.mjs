import esbuild from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { normalizeGeneratedBundle } from './bundle-normalization.mjs';

const EXTERNALS = [
  'obsidian',
  'electron',
  '@codemirror/autocomplete',
  '@codemirror/state',
  '@codemirror/view',
  '@codemirror/language',
];

const candidate = 'src/modals/diagnostics-modal.ts';
const outputPath = 'quality/optional-bundle-experiment.json';

async function bundle(entryPoint) {
  const result = await esbuild.build({
    entryPoints: [entryPoint],
    bundle: true,
    format: 'cjs',
    target: 'es2020',
    platform: 'node',
    external: EXTERNALS,
    logLevel: 'silent',
    minify: true,
    metafile: true,
    write: false,
  });
  const javascript = result.outputFiles.find((file) => file.path.endsWith('.js')) ?? result.outputFiles[0];
  if (!javascript || !result.metafile) throw new Error(`Unable to analyze ${entryPoint}`);
  return {
    bytes: Buffer.byteLength(normalizeGeneratedBundle(javascript.text)),
    inputs: result.metafile.inputs,
  };
}

function sourceBytes(inputs, names) {
  let total = 0;
  for (const name of names) total += inputs[name]?.bytes ?? 0;
  return total;
}

const [main, secondary] = await Promise.all([
  bundle('src/main.ts'),
  bundle(candidate),
]);
const mainInputs = new Set(Object.keys(main.inputs));
const secondaryInputs = Object.keys(secondary.inputs);
const sharedInputs = secondaryInputs.filter((name) => mainInputs.has(name));
const candidateOnlyInputs = secondaryInputs.filter((name) => !mainInputs.has(name));

const report = {
  schemaVersion: 1,
  experiment: 'manual-secondary-commonjs',
  candidate,
  productionChanged: false,
  measurements: {
    currentMainBundleBytes: main.bytes,
    standaloneSecondaryBundleBytes: secondary.bytes,
    secondaryInputCount: secondaryInputs.length,
    inputsAlreadyPresentInMainCount: sharedInputs.length,
    inputsAlreadyPresentInMainSourceBytes: sourceBytes(secondary.inputs, sharedInputs),
    candidateOnlyInputCount: candidateOnlyInputs.length,
    candidateOnlySourceBytes: sourceBytes(secondary.inputs, candidateOnlyInputs),
  },
  releaseContract: {
    requiredFiles: ['main.js', 'manifest.json', 'versions.json', 'styles.css'],
    stylesRemainEager: true,
  },
  evidence: {
    relativeLoadInRealObsidian: false,
    offlineInstallRetainsSecondaryAssets: false,
    updateAndUninstallLifecycleVerified: false,
    communityPluginsOrBratVerified: false,
    desktopVerified: false,
    androidVerified: false,
    iosVerified: false,
    startupParseAndHeapImprovementVerified: false,
  },
  decision: {
    outcome: 'no-go',
    reason: 'The isolated CommonJS candidate duplicates sources already present in main.js, styles.css remains eager, and required real-host distribution/runtime evidence has not been supplied.',
    productionAction: 'Keep the supported four-file, single-CommonJS package and reduce it through source deletion and internal source-module boundaries.',
  },
};

if (process.argv.includes('--write')) {
  await mkdir(path.dirname(outputPath), { recursive: true });
  await writeFile(outputPath, `${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv.includes('--json')) {
  process.stdout.write(`${JSON.stringify(report)}\n`);
} else {
  process.stdout.write([
    `Candidate: ${candidate}`,
    `Current main bundle: ${report.measurements.currentMainBundleBytes} bytes`,
    `Standalone candidate: ${report.measurements.standaloneSecondaryBundleBytes} bytes`,
    `Candidate inputs already in main: ${sharedInputs.length}/${secondaryInputs.length}`,
    `Decision: ${report.decision.outcome.toUpperCase()} — ${report.decision.reason}`,
    process.argv.includes('--write') ? `Report: ${outputPath}` : 'Pass --write to save the JSON report.',
  ].join('\n') + '\n');
}
