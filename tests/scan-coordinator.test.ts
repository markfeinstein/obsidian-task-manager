import test from 'node:test';
import assert from 'node:assert/strict';
import type { TFile } from 'obsidian';
import { collectVaultScanWork } from '../src/scan-coordinator';
import type { PersistedState } from '../src/state-store';
import type { ParsedTask } from '../src/task-scanner';

const state = { version: 2, snapshot: [], completions: [], recurrenceCounts: {} } as PersistedState;

function file(path: string, mtime = 1): TFile {
  return { path, stat: { mtime, ctime: mtime, size: path.length }, extension: 'md' } as TFile;
}

function parsedTask(source: TFile): ParsedTask {
  return { key: source.path, stableKey: source.path, filePath: source.path, lineNumber: 1, status: 'todo', metadata: { dates: {} } } as unknown as ParsedTask;
}

function baseOptions(files: TFile[]) {
  return {
    files,
    force: false,
    state,
    readConcurrency: 2,
    parseConcurrency: 1,
    isActive: () => true,
    needsHydration: () => false,
    statMatches: () => false,
    read: async (source: TFile) => source.path,
    contentChanged: () => true,
    hash: (content: string) => `hash:${content}`,
    parse: async (source: TFile) => [parsedTask(source)],
    isCurrent: () => true,
  };
}

test('scan coordinator skips stat-matched hydrated files without body reads', async () => {
  let reads = 0;
  const result = await collectVaultScanWork({
    ...baseOptions([file('A.md'), file('B.md')]),
    statMatches: () => true,
    read: async () => { reads += 1; return ''; },
  });

  assert.equal(result.cancelled, false);
  assert.equal(reads, 0);
  assert.deepEqual(result.filesToScan, []);
  assert.deepEqual(result.fingerprintUpdates, []);
});

test('scan coordinator bounds read/parse work and returns complete replacements', async () => {
  let activeReads = 0;
  let peakReads = 0;
  let activeParses = 0;
  let peakParses = 0;
  const files = ['A.md', 'B.md', 'C.md', 'D.md'].map((path) => file(path));
  const result = await collectVaultScanWork({
    ...baseOptions(files),
    read: async (source) => {
      activeReads += 1;
      peakReads = Math.max(peakReads, activeReads);
      await Promise.resolve();
      activeReads -= 1;
      return source.path;
    },
    parse: async (source) => {
      activeParses += 1;
      peakParses = Math.max(peakParses, activeParses);
      await Promise.resolve();
      activeParses -= 1;
      return [parsedTask(source)];
    },
  });

  assert.equal(peakReads <= 2, true);
  assert.equal(peakParses, 1);
  assert.deepEqual(result.filesToScan.map((source) => source.path), files.map((source) => source.path));
  assert.equal(result.replacements.size, files.length);
  assert.equal(result.fingerprintUpdates.length, files.length);
});

test('scan coordinator isolates read/parse failures and ignores stale file objects', async () => {
  const files = [file('read-fail.md'), file('parse-fail.md'), file('stale.md'), file('ok.md')];
  const result = await collectVaultScanWork({
    ...baseOptions(files),
    read: async (source) => {
      if (source.path === 'read-fail.md') throw new Error('read failed');
      return source.path;
    },
    parse: async (source) => {
      if (source.path === 'parse-fail.md') throw new Error('parse failed');
      return [parsedTask(source)];
    },
    isCurrent: (source) => source.path !== 'stale.md',
  });

  assert.deepEqual(result.errors.map((error) => error.file).sort(), ['parse-fail.md', 'read-fail.md']);
  assert.deepEqual(Array.from(result.replacements.keys()), ['ok.md']);
  assert.deepEqual(result.fingerprintUpdates.map((entry) => entry.path), ['ok.md']);
  assert.equal(result.fingerprintUpdates[0]?.content, undefined, 'successful waves retain only a precomputed hash, not the source body');
  assert.equal(result.fingerprintUpdates[0]?.hash, 'hash:ok.md');
  assert.deepEqual(result.stalePaths, ['stale.md']);
  assert.equal(result.fingerprintUpdates.some((entry) => entry.path === 'parse-fail.md'), false);
});

test('scan coordinator refreshes a fingerprint for unchanged content without parsing', async () => {
  let parses = 0;
  const result = await collectVaultScanWork({
    ...baseOptions([file('same.md')]),
    contentChanged: () => false,
    parse: async () => { parses += 1; return []; },
  });
  assert.equal(parses, 0);
  assert.deepEqual(result.fingerprintUpdates.map((entry) => entry.path), ['same.md']);
});

test('scan coordinator rejects stale unchanged-content fingerprint publication', async () => {
  const result = await collectVaultScanWork({
    ...baseOptions([file('stale-same.md')]),
    contentChanged: () => false,
    isCurrent: () => false,
  });
  assert.deepEqual(result.stalePaths, ['stale-same.md']);
  assert.deepEqual(result.fingerprintUpdates, []);
});

test('scan coordinator bounds invalid concurrency and returns an empty wave', async () => {
  const result = await collectVaultScanWork({
    ...baseOptions([]),
    readConcurrency: Number.NaN,
    parseConcurrency: 0,
  });
  assert.deepEqual(result, { cancelled: false, filesToScan: [], replacements: new Map(), fingerprintUpdates: [], errors: [], stalePaths: [] });
});

test('scan coordinator returns a cancelled wave before parse side effects', async () => {
  let active = true;
  let parses = 0;
  const result = await collectVaultScanWork({
    ...baseOptions([file('A.md')]),
    isActive: () => active,
    read: async () => { active = false; return 'body'; },
    parse: async () => { parses += 1; return []; },
  });

  assert.equal(result.cancelled, true);
  assert.equal(parses, 0);
  assert.equal(result.replacements.size, 0);
});
