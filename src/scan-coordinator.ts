import type { TFile } from 'obsidian';
import type { PersistedState } from './state-store';
import type { ParsedTask } from './task-scanner';
import { isIndexableTaskPath } from './task-path-policy';

export interface ScanFingerprintUpdate {
  path: string;
  /** Precomputed content hash avoids retaining every scanned source body until commit. */
  hash?: string;
  content?: string;
  stat?: { mtime?: number; size?: number };
}

export interface ScanError {
  file: string;
  message: string;
}

export interface VaultScanCollection {
  cancelled: boolean;
  filesToScan: TFile[];
  replacements: Map<string, ParsedTask[]>;
  fingerprintUpdates: ScanFingerprintUpdate[];
  errors: ScanError[];
  stalePaths: string[];
}

export interface ScanPathEvidence {
  epoch: number;
  mtime: number;
  size: number;
}

export interface ScanPathLookupEntry {
  path?: string;
  extension?: string;
  stat?: { mtime?: number; size?: number };
}

export interface PriorIndexPathState {
  existed: boolean;
  tasks: ParsedTask[];
}

export interface StaleIndexRollbackPlan {
  restore: Map<string, ParsedTask[]>;
  remove: string[];
}

export function statNumber(value: unknown): number {
  return Number.isFinite(value) ? Number(value) : 0;
}

export function isScanPathEvidenceCurrent(
  path: string,
  evidence: ScanPathEvidence,
  options: {
    excludedFolders: readonly string[];
    currentEpoch(path: string): number;
    lookup?(path: string): ScanPathLookupEntry | null | undefined;
  },
): boolean {
  if (!isIndexableTaskPath(path, undefined, options.excludedFolders)) return false;
  if (options.currentEpoch(path) !== evidence.epoch) return false;
  const current = options.lookup?.(path);
  if (current === undefined) return true;
  if (!current || current.path !== path || !['md', 'canvas'].includes(current.extension ?? '')) return false;
  return statNumber(current.stat?.mtime) === evidence.mtime && statNumber(current.stat?.size) === evidence.size;
}

export function currentScanReplacementsForEvidence(
  replacements: ReadonlyMap<string, ParsedTask[]>,
  evidence: ReadonlyMap<string, ScanPathEvidence>,
  isCurrent: (path: string, evidence: ScanPathEvidence) => boolean,
): { current: Map<string, ParsedTask[]>; stalePaths: string[] } {
  const current = new Map<string, ParsedTask[]>();
  const stalePaths: string[] = [];
  for (const [path, tasks] of replacements) {
    const captured = evidence.get(path);
    if (captured && isCurrent(path, captured)) current.set(path, tasks);
    else stalePaths.push(path);
  }
  return { current, stalePaths };
}

export function planStaleIndexRollback(
  accepted: Iterable<string>,
  current: ReadonlyMap<string, ParsedTask[]>,
  before: ReadonlyMap<string, PriorIndexPathState>,
  excludedFolders: readonly string[],
): StaleIndexRollbackPlan {
  const restore = new Map<string, ParsedTask[]>();
  const remove: string[] = [];
  for (const path of accepted) {
    if (current.has(path)) continue;
    const previous = before.get(path);
    if (previous?.existed && isIndexableTaskPath(path, undefined, excludedFolders)) restore.set(path, previous.tasks);
    else remove.push(path);
  }
  return { restore, remove };
}

export interface VaultScanCoordinatorOptions {
  files: readonly TFile[];
  force: boolean;
  state: PersistedState;
  readConcurrency: number;
  parseConcurrency: number;
  isActive: () => boolean;
  needsHydration: (path: string) => boolean;
  statMatches: (state: PersistedState, path: string, stat: TFile['stat']) => boolean;
  read: (file: TFile) => Promise<string>;
  contentChanged: (state: PersistedState, path: string, content: string) => boolean;
  hash: (content: string) => string;
  parse: (file: TFile, content: string) => Promise<ParsedTask[]>;
  /** Must validate immutable read evidence (path epoch/stat), not only object identity. */
  isCurrent: (file: TFile) => boolean;
}

function boundedConcurrency(value: number): number {
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : 1;
}

/**
 * Read, fingerprint, and parse one full-vault scan wave. Fingerprints are
 * emitted only for successful/current work, so a transient parser failure or
 * superseded read remains retryable on the next ordinary scan.
 */
export async function collectVaultScanWork(options: VaultScanCoordinatorOptions): Promise<VaultScanCollection> {
  const filesToScan: TFile[] = [];
  const replacements = new Map<string, ParsedTask[]>();
  const fingerprintUpdates: ScanFingerprintUpdate[] = [];
  const errors: ScanError[] = [];
  const stalePaths = new Set<string>();
  const readConcurrency = boundedConcurrency(options.readConcurrency);
  const parseConcurrency = boundedConcurrency(options.parseConcurrency);
  const result = (cancelled: boolean): VaultScanCollection => ({
    cancelled,
    filesToScan,
    replacements,
    fingerprintUpdates,
    errors,
    stalePaths: [...stalePaths],
  });

  for (let index = 0; index < options.files.length; index += readConcurrency) {
    const batch = options.files.slice(index, index + readConcurrency);
    const decisions = await Promise.all(batch.map(async (file) => {
      const needsHydration = options.needsHydration(file.path);
      if (!options.force && !needsHydration && options.statMatches(options.state, file.path, file.stat)) {
        return { file, scan: false as const, content: undefined, fingerprint: false };
      }
      try {
        const content = await options.read(file);
        const contentChanged = options.contentChanged(options.state, file.path, content);
        const scan = options.force || needsHydration || contentChanged;
        return { file, scan, content, fingerprint: !scan };
      } catch (error) {
        errors.push({ file: file.path, message: error instanceof Error ? error.message : String(error) });
        return { file, scan: false as const, content: undefined, fingerprint: false };
      }
    }));
    if (!options.isActive()) return result(true);

    // A read whose content was unchanged is successful without parsing. It may
    // refresh stat evidence, but only while its captured path evidence is current.
    for (const decision of decisions) {
      if (!decision.fingerprint || decision.content === undefined) continue;
      if (!options.isCurrent(decision.file)) { stalePaths.add(decision.file.path); continue; }
      fingerprintUpdates.push({ path: decision.file.path, hash: options.hash(decision.content), stat: { mtime: decision.file.stat.mtime, size: decision.file.stat.size } });
    }

    const candidates = decisions.filter((decision): decision is { file: TFile; scan: true; content: string; fingerprint: false } => decision.scan && decision.content !== undefined);
    filesToScan.push(...candidates.map((candidate) => candidate.file));
    for (let candidateIndex = 0; candidateIndex < candidates.length; candidateIndex += parseConcurrency) {
      if (!options.isActive()) return result(true);
      const candidateBatch = candidates.slice(candidateIndex, candidateIndex + parseConcurrency);
      const results = await Promise.allSettled(candidateBatch.map((candidate) => options.parse(candidate.file, candidate.content)));
      if (!options.isActive()) return result(true);

      for (let resultIndex = 0; resultIndex < results.length; resultIndex += 1) {
        const parseResult = results[resultIndex];
        const candidate = candidateBatch[resultIndex];
        if (!candidate) continue;
        if (!options.isCurrent(candidate.file)) { stalePaths.add(candidate.file.path); continue; }
        if (parseResult?.status === 'fulfilled') {
          replacements.set(candidate.file.path, Array.isArray(parseResult.value) ? parseResult.value : []);
          fingerprintUpdates.push({ path: candidate.file.path, hash: options.hash(candidate.content), stat: { mtime: candidate.file.stat.mtime, size: candidate.file.stat.size } });
        } else {
          errors.push({ file: candidate.file.path, message: String(parseResult?.reason ?? 'Scan failed') });
        }
      }
    }
  }

  return result(false);
}
