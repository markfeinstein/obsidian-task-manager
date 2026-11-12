#!/usr/bin/env node
import { createRequire } from 'node:module';
import process from 'node:process';
import os from 'node:os';
import { performance } from 'node:perf_hooks';

const [testDist, encodedOptions, rawSamples] = process.argv.slice(2);
if (!testDist || !encodedOptions) throw new Error('benchmark-worker requires testDist and base64url scenario options');
const options = JSON.parse(Buffer.from(encodedOptions, 'base64url').toString('utf8'));
const samples = Math.max(1, Number(rawSamples) || 5);
const require = createRequire(`${testDist}/benchmark-worker-loader.cjs`);
const { createScanScenarioRunner } = require('./tests/fixtures/vault-large/benchmark-harness.js');
const runner = createScanScenarioRunner(options);

await runner();
globalThis.gc?.();
const durations = [];
const heapPeaks = [];
const rssBaselineBytes = process.memoryUsage().rss;
let peakRssBytes = rssBaselineBytes;
let counters;
for (let index = 0; index < samples; index += 1) {
  globalThis.gc?.();
  const memoryProbe = index === 0;
  const heapStart = process.memoryUsage().heapUsed;
  let heapPeak = heapStart;
  const sampler = memoryProbe ? setInterval(() => {
    const memory = process.memoryUsage();
    heapPeak = Math.max(heapPeak, memory.heapUsed);
    peakRssBytes = Math.max(peakRssBytes, memory.rss);
  }, 1) : undefined;
  const start = performance.now();
  const result = await runner();
  durations.push(performance.now() - start);
  if (sampler) clearInterval(sampler);
  if (memoryProbe) {
    const memory = process.memoryUsage();
    heapPeak = Math.max(heapPeak, memory.heapUsed);
    peakRssBytes = Math.max(peakRssBytes, memory.rss);
    heapPeaks.push(Math.max(0, heapPeak - heapStart));
  }
  counters = result.counters;
}
const sorted = [...durations].sort((left, right) => left - right);
const output = {
  name: `orchestrated_${options.mode}_${options.fileCount}_files`,
  scenario: options,
  medianMs: sorted[Math.floor(sorted.length / 2)],
  p95Ms: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)],
  minMs: Math.min(...durations),
  maxMs: Math.max(...durations),
  peakHeapDeltaBytes: Math.max(...heapPeaks),
  rssBaselineBytes,
  peakRssBytes,
  rssDeltaBytes: Math.max(0, peakRssBytes - rssBaselineBytes),
  memoryIsolation: 'isolated-process',
  samples: durations,
  counters,
  runtime: { node: process.version, platform: process.platform, arch: process.arch, cpus: os.cpus().length },
};
process.stdout.write(`${JSON.stringify(output)}\n`);
