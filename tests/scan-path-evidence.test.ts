import test from 'node:test';
import assert from 'node:assert/strict';
import { currentScanReplacementsForEvidence, isScanPathEvidenceCurrent, planStaleIndexRollback, statNumber, type ScanPathEvidence } from '../src/scan-coordinator';
import type { ParsedTask } from '../src/task-scanner';

const evidence: ScanPathEvidence = { epoch: 2, mtime: 100, size: 20 };
const task = { key: 'Tasks.md:1', filePath: 'Tasks.md', lineNumber: 1 } as ParsedTask;

test('scan path evidence validates epoch, path policy, extension, and stat values', () => {
  assert.equal(statNumber(42), 42);
  assert.equal(statNumber(Number.NaN), 0);
  assert.equal(isScanPathEvidenceCurrent('Tasks.md', evidence, {
    excludedFolders: [],
    currentEpoch: () => 2,
    lookup: () => ({ path: 'Tasks.md', extension: 'md', stat: { mtime: 100, size: 20 } }),
  }), true);
  assert.equal(isScanPathEvidenceCurrent('Archive/Tasks.md', evidence, {
    excludedFolders: ['Archive'],
    currentEpoch: () => 2,
    lookup: () => ({ path: 'Archive/Tasks.md', extension: 'md', stat: { mtime: 100, size: 20 } }),
  }), false);
  assert.equal(isScanPathEvidenceCurrent('Tasks.md', evidence, {
    excludedFolders: [],
    currentEpoch: () => 1,
    lookup: () => ({ path: 'Tasks.md', extension: 'md', stat: { mtime: 100, size: 20 } }),
  }), false);
  assert.equal(isScanPathEvidenceCurrent('Tasks.md', evidence, {
    excludedFolders: [],
    currentEpoch: () => 2,
    lookup: () => ({ path: 'Tasks.md', extension: 'md', stat: { mtime: 101, size: 20 } }),
  }), false);
  assert.equal(isScanPathEvidenceCurrent('Tasks.canvas', evidence, {
    excludedFolders: [],
    currentEpoch: () => 2,
    lookup: () => ({ path: 'Tasks.canvas', extension: 'canvas', stat: { mtime: 100, size: 20 } }),
  }), true);
  assert.equal(isScanPathEvidenceCurrent('Tasks.txt', evidence, {
    excludedFolders: [],
    currentEpoch: () => 2,
    lookup: () => ({ path: 'Tasks.txt', extension: 'txt', stat: { mtime: 100, size: 20 } }),
  }), false);
});

test('current scan replacements separates accepted and stale paths', () => {
  const replacements = new Map<string, ParsedTask[]>([
    ['A.md', [task]],
    ['B.md', [task]],
    ['C.md', [task]],
  ]);
  const evidenceByPath = new Map<string, ScanPathEvidence>([
    ['A.md', evidence],
    ['B.md', { ...evidence, epoch: 3 }],
  ]);

  const result = currentScanReplacementsForEvidence(replacements, evidenceByPath, (_path, captured) => captured.epoch === 2);

  assert.deepEqual([...result.current.keys()], ['A.md']);
  assert.deepEqual(result.stalePaths, ['B.md', 'C.md']);
});

test('stale rollback plan restores prior index entries and removes unowned paths', () => {
  const before = new Map([
    ['A.md', { existed: true, tasks: [task] }],
    ['B.md', { existed: false, tasks: [] }],
    ['Ignored/Task.md', { existed: true, tasks: [task] }],
  ]);
  const current = new Map<string, ParsedTask[]>([['StillCurrent.md', [task]]]);

  const plan = planStaleIndexRollback(['A.md', 'B.md', 'Ignored/Task.md', 'StillCurrent.md'], current, before, ['Ignored']);

  assert.deepEqual([...plan.restore.keys()], ['A.md']);
  assert.deepEqual(plan.remove, ['B.md', 'Ignored/Task.md']);
});
