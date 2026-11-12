import { TFile, type App } from 'obsidian';
import { splitContentLines } from './task-model';
import { findJournalPathConflict, type StateStore, type TaskLifecycleTransferJournal, type TaskLifecycleTransferPhase } from './state-store';
import { ensureParentFolders, normalizeVaultRelativePath } from './vault-utils';
import { lifecycleTransferStateRepository } from './state-slice-repositories';
import { isValidIsoDate } from './date-utils';

export interface LifecycleTransferRequest {
  action: 'archive' | 'collect';
  /** Live source handle used for the initiating transaction; never persisted. */
  sourceFile?: TFile;
  sourcePath: string;
  sourceLine: number;
  sourceIdentity: string;
  sourceBlock: string;
  sourceReplacement: string;
  targetPath: string;
  targetHeading: string;
  recurrenceCommit?: { taskKey: string; incrementCount: boolean; seriesId: string; date: string };
}

export interface LifecycleTransferReconciliationResult {
  operationId: string;
  outcome: 'rolled-back' | 'completed' | 'pending';
  diagnostic?: string;
}

export class LifecycleTransferRecoveryError extends Error {
  constructor(message: string, readonly operationId: string, readonly phase: TaskLifecycleTransferPhase = 'reconciliation-required') {
    super(message);
    this.name = 'LifecycleTransferRecoveryError';
  }
}

type TargetEvidence = 'original' | 'marked' | 'unmarked' | 'ambiguous' | 'missing';
type SourceEvidence = 'present' | 'finalized' | 'ambiguous' | 'missing';

/** Restart-safe destination-first archive/collect transfer. */
export class TaskLifecycleTransferService {
  constructor(private readonly app: App, private readonly stateStore: StateStore, private readonly now = () => new Date()) {}

  async transfer(input: LifecycleTransferRequest): Promise<void> {
    await this.stateStore.whenLifecycleRecoveryReady();
    const request = validateTransferRequest(input);
    const source = this.fileAt(request.sourcePath)
      ?? (request.sourceFile?.path === request.sourcePath ? request.sourceFile : null);
    if (!source) throw new Error(`Lifecycle source ${request.sourcePath} is missing`);
    const sourceOriginal = await this.app.vault.read(source);
    const exactSourceBlock = exactBlockFromContent(sourceOriginal, request.sourceLine, request.sourceBlock);
    if (exactSourceBlock === null) throw new Error('Lifecycle source block changed before preparation');
    const sourceFinalization = replaceBlock(sourceOriginal, request.sourceLine, exactSourceBlock, request.sourceReplacement);
    if (!sourceFinalization.changed) throw new Error('Lifecycle source block changed before preparation');
    const target = this.fileAt(request.targetPath);
    const targetOriginal = target ? await this.app.vault.read(target) : '';
    const operationId = createOperationId();
    const marker = `<!-- task-manager-lifecycle:${operationId} -->`;
    const plan = targetPlan(targetOriginal, request.targetHeading, marker, exactSourceBlock);
    const journal: TaskLifecycleTransferJournal = {
      operationId, action: request.action, phase: 'prepared', sourcePath: request.sourcePath,
      sourceLine: request.sourceLine, sourceIdentity: request.sourceIdentity, sourceBlock: exactSourceBlock,
      sourceReplacement: request.sourceReplacement, targetPath: request.targetPath, targetHeading: request.targetHeading,
      targetInsertionOffset: plan.offset, targetOriginalHash: this.stateStore.hash(targetOriginal),
      sourceOriginalHash: this.stateStore.hash(sourceOriginal), sourceFinalizedHash: this.stateStore.hash(sourceFinalization.content), targetCreated: !target,
      marker, markerLine: plan.markerLine, insertionPrefix: plan.prefix, insertionSuffix: plan.suffix,
      ...(request.recurrenceCommit ? { recurrenceCommit: request.recurrenceCommit } : {}), createdAtIso: this.now().toISOString(),
    };
    await this.addJournal(journal);
    let phase: TaskLifecycleTransferPhase = 'prepared';
    try {
      await this.writeTarget(target, targetOriginal, journal);
      await this.setPhase(operationId, 'target-written');
      phase = 'target-written';
      const finalized = await this.finalizeSource(source, journal);
      if (!finalized) throw new Error('Source block changed before exact lifecycle finalization');
      await this.setPhase(operationId, 'source-finalized');
      phase = 'source-finalized';
      await this.commitEffects(journal);
      phase = 'effects-committed';
      await this.removeMarker(journal);
      await this.removeJournal(operationId);
    } catch (error) {
      const diagnostic = `Lifecycle transfer ${operationId} failed: ${errorMessage(error)}`;
      await this.retain(journal, diagnostic);
      throw new LifecycleTransferRecoveryError(diagnostic, operationId, phase);
    }
  }

  async reconcilePendingTransfers(): Promise<LifecycleTransferReconciliationResult[]> {
    const state = await this.stateStore.loadState();
    const results: LifecycleTransferReconciliationResult[] = [];
    for (const journal of state.taskLifecycleTransferJournals ?? []) {
      try { results.push(await this.reconcile(journal)); }
      catch (error) {
        const diagnostic = `Lifecycle transfer ${journal.operationId} reconciliation failed: ${errorMessage(error)}`;
        await this.retain(journal, diagnostic);
        results.push({ operationId: journal.operationId, outcome: 'pending', diagnostic });
      }
    }
    return results;
  }

  private async reconcile(journal: TaskLifecycleTransferJournal): Promise<LifecycleTransferReconciliationResult> {
    const sourceFile = this.fileAt(journal.sourcePath);
    const targetFile = this.fileAt(journal.targetPath);
    const source = sourceFile ? await this.app.vault.read(sourceFile) : '';
    const target = targetFile ? await this.app.vault.read(targetFile) : '';
    const sourceState = sourceEvidence(source, Boolean(sourceFile), journal, (value) => this.stateStore.hash(value));
    const targetState = targetEvidence(target, Boolean(targetFile), journal, (value) => this.stateStore.hash(value));
    if (journal.phase === 'prepared' && sourceState === 'present' && targetState === 'original') {
      await this.removeJournal(journal.operationId); return { operationId: journal.operationId, outcome: 'rolled-back' };
    }
    if (sourceState === 'present' && targetState === 'marked') {
      await this.rollbackTarget(journal); await this.removeJournal(journal.operationId);
      return { operationId: journal.operationId, outcome: 'rolled-back' };
    }
    const phaseProvesFinalization = journal.phase === 'source-finalized' || journal.phase === 'effects-committed';
    if ((sourceState === 'finalized' || phaseProvesFinalization) && (targetState === 'marked' || targetState === 'unmarked')) {
      await this.commitEffects(journal);
      if (targetState === 'marked') await this.removeMarker(journal);
      await this.removeJournal(journal.operationId);
      return { operationId: journal.operationId, outcome: 'completed' };
    }
    const diagnostic = `Lifecycle transfer ${journal.operationId} has ambiguous evidence (source=${sourceState}, target=${targetState}, phase=${journal.phase})`;
    await this.retain(journal, diagnostic);
    return { operationId: journal.operationId, outcome: 'pending', diagnostic };
  }

  private async writeTarget(file: TFile | null, expected: string, journal: TaskLifecycleTransferJournal): Promise<void> {
    const insertion = markedInsertion(journal);
    const next = expected.slice(0, journal.targetInsertionOffset) + insertion + expected.slice(journal.targetInsertionOffset);
    if (file) {
      await this.app.vault.process(file, (current) => {
        if (current !== expected) throw new Error('Lifecycle destination changed before write');
        return next;
      });
    } else {
      await ensureParentFolders(this.app, journal.targetPath);
      if (this.app.vault.getAbstractFileByPath(journal.targetPath)) throw new Error('Lifecycle destination was created concurrently');
      await this.app.vault.create(journal.targetPath, next);
    }
  }

  private async finalizeSource(file: TFile, journal: TaskLifecycleTransferJournal): Promise<boolean> {
    let finalized = false;
    await this.app.vault.process(file, (content) => {
      if (journal.sourceOriginalHash && this.stateStore.hash(content) !== journal.sourceOriginalHash) return content;
      const result = replaceBlock(content, journal.sourceLine, journal.sourceBlock, journal.sourceReplacement);
      if (result.changed && journal.sourceFinalizedHash && this.stateStore.hash(result.content) !== journal.sourceFinalizedHash) return content;
      finalized = result.changed;
      return result.content;
    });
    return finalized;
  }

  private async commitEffects(journal: TaskLifecycleTransferJournal): Promise<void> {
    await this.stateStore.updateState((state) => {
      const current = (state.taskLifecycleTransferJournals ?? []).find((entry) => entry.operationId === journal.operationId);
      if (current?.phase === 'effects-committed') return state;
      let next = state;
      if (journal.recurrenceCommit) {
        if (journal.recurrenceCommit.incrementCount) next = this.stateStore.incrementRecurrenceCount(next, journal.recurrenceCommit.taskKey);
        next = this.stateStore.addRecurrenceOccurrence(next, {
          seriesId: journal.recurrenceCommit.seriesId, date: journal.recurrenceCommit.date, taskKey: journal.recurrenceCommit.taskKey,
        });
      }
      return {
        ...next,
        taskLifecycleTransferJournals: (next.taskLifecycleTransferJournals ?? []).map((entry) =>
          entry.operationId === journal.operationId ? { ...entry, phase: 'effects-committed' as const, diagnostic: undefined } : entry),
      };
    });
  }

  private async rollbackTarget(journal: TaskLifecycleTransferJournal): Promise<void> {
    const file = this.fileAt(journal.targetPath); if (!file) throw new Error('Lifecycle destination is missing');
    await this.app.vault.process(file, (content) => removeExactInsertion(content, journal));
  }

  private async removeMarker(journal: TaskLifecycleTransferJournal): Promise<void> {
    const file = this.fileAt(journal.targetPath); if (!file) throw new Error('Lifecycle destination is missing');
    await this.app.vault.process(file, (content) => {
      const index = locateExactMarker(content, journal);
      return content.slice(0, index) + content.slice(index + journal.markerLine.length);
    });
  }

  private fileAt(path: string): TFile | null {
    const value = this.app.vault.getAbstractFileByPath(path);
    return value instanceof TFile || (value && typeof value === 'object' && 'path' in value && 'extension' in value && value.path === path && value.extension === 'md')
      ? value as TFile
      : null;
  }
  private async addJournal(journal: TaskLifecycleTransferJournal): Promise<void> {
    const committed = await this.stateStore.updateState((state) => {
      const current = state.taskLifecycleTransferJournals ?? [];
      const pathConflict = findJournalPathConflict(state, journal.sourcePath, journal.targetPath, journal.operationId);
      const conflict = pathConflict ?? current.find((entry) => entry.sourceIdentity === journal.sourceIdentity);
      if (conflict) throw new LifecycleTransferRecoveryError(`Lifecycle transfer ${conflict.operationId} already fences this source or destination`, conflict.operationId);
      return { ...state, taskLifecycleTransferJournals: [...current, journal] };
    });
    const persisted = (committed.taskLifecycleTransferJournals ?? []).find((entry) => entry.operationId === journal.operationId);
    if (!persisted || persisted.marker !== journal.marker || persisted.sourceIdentity !== journal.sourceIdentity) {
      throw new Error('Lifecycle transfer journal was not durably persisted');
    }
  }
  private setPhase(operationId: string, phase: TaskLifecycleTransferPhase): Promise<unknown> {
    return lifecycleTransferStateRepository(this.stateStore).update((state) => ({
      taskLifecycleTransferJournals: (state.taskLifecycleTransferJournals ?? []).map((entry) => entry.operationId === operationId ? { ...entry, phase, diagnostic: undefined } : entry),
    }));
  }
  private removeJournal(operationId: string): Promise<unknown> {
    return lifecycleTransferStateRepository(this.stateStore).update((state) => ({
      taskLifecycleTransferJournals: (state.taskLifecycleTransferJournals ?? []).filter((entry) => entry.operationId !== operationId),
    }));
  }
  private retain(journal: TaskLifecycleTransferJournal, diagnostic: string): Promise<unknown> {
    return lifecycleTransferStateRepository(this.stateStore).update((state) => ({
      taskLifecycleTransferJournals: (state.taskLifecycleTransferJournals ?? []).some((entry) => entry.operationId === journal.operationId)
        ? (state.taskLifecycleTransferJournals ?? []).map((entry) => entry.operationId === journal.operationId
          ? { ...entry, phase: entry.phase === 'source-finalized' || entry.phase === 'effects-committed' ? entry.phase : 'reconciliation-required' as const, diagnostic }
          : entry)
        : [...(state.taskLifecycleTransferJournals ?? []), { ...journal, phase: journal.phase === 'source-finalized' || journal.phase === 'effects-committed' ? journal.phase : 'reconciliation-required' as const, diagnostic }],
    }));
  }
}

function validateTransferRequest(input: LifecycleTransferRequest): LifecycleTransferRequest {
  const sourcePath = normalizeVaultRelativePath(input.sourcePath, 'Lifecycle source path');
  const targetPath = normalizeVaultRelativePath(input.targetPath, 'Lifecycle target path');
  const targetHeading = input.targetHeading.trim();
  if (!sourcePath.toLowerCase().endsWith('.md') || !targetPath.toLowerCase().endsWith('.md') || sourcePath === targetPath) {
    throw new Error('Lifecycle transfer requires distinct Markdown source and destination paths');
  }
  if (!Number.isSafeInteger(input.sourceLine) || input.sourceLine < 1) throw new Error('Lifecycle source line is invalid');
  if (!input.sourceIdentity.trim() || !input.sourceBlock || /[\r\n]/u.test(targetHeading) || !targetHeading) {
    throw new Error('Lifecycle transfer identity, block, and single-line heading are required');
  }
  if (input.recurrenceCommit) {
    if (!input.recurrenceCommit.taskKey.trim() || !input.recurrenceCommit.seriesId.trim() || !isValidIsoDate(input.recurrenceCommit.date)) {
      throw new Error('Lifecycle recurrence commit is invalid');
    }
  }
  return { ...input, sourcePath, targetPath, sourceIdentity: input.sourceIdentity.trim(), targetHeading };
}

function targetPlan(content: string, heading: string, marker: string, block: string): { offset: number; prefix: string; markerLine: string; suffix: string } {
  const eol = content.match(/\r\n|\n|\r/u)?.[0] ?? '\n';
  const headingText = `## ${heading}`;
  const normalizedHeading = heading.trim();
  const lines = splitContentLines(content);
  let offset = -1;
  let cursor = 0;
  for (const line of lines) {
    cursor += line.text.length + line.lineEnding.length;
    const match = line.text.match(/^(#{1,6})\s+(.+?)(?:\s+#+\s*)?$/u);
    if (match?.[2]?.trim() === normalizedHeading) { offset = cursor; break; }
  }
  const prefix = offset >= 0 ? (offset > 0 && !/[\r\n]$/u.test(content.slice(0, offset)) ? eol : '') : `${content && !/[\r\n]$/u.test(content) ? eol : ''}${headingText}${eol}`;
  if (offset < 0) offset = content.length;
  return { offset, prefix, markerLine: `${marker}${eol}`, suffix: /\n$/u.test(block) ? '' : eol };
}
function markedInsertion(j: TaskLifecycleTransferJournal): string { return `${j.insertionPrefix}${j.markerLine}${j.sourceBlock}${j.insertionSuffix}`; }
function unmarkedInsertion(j: TaskLifecycleTransferJournal): string { return `${j.insertionPrefix}${j.sourceBlock}${j.insertionSuffix}`; }
function locateExactMarkedInsertion(content: string, j: TaskLifecycleTransferJournal): number {
  const matches = allIndexes(content, markedInsertion(j));
  if (matches.length !== 1) throw new Error(`Expected one exact lifecycle insertion, found ${matches.length}`);
  return matches[0];
}
function locateExactMarker(content: string, j: TaskLifecycleTransferJournal): number {
  const matches = allIndexes(content, j.markerLine).filter((index) =>
    content.slice(index + j.markerLine.length, index + j.markerLine.length + j.sourceBlock.length) === j.sourceBlock);
  if (matches.length !== 1) throw new Error(`Expected one exact lifecycle marker, found ${matches.length}`);
  return matches[0];
}
function removeExactInsertion(content: string, j: TaskLifecycleTransferJournal): string {
  const value = markedInsertion(j);
  const at = locateExactMarkedInsertion(content, j);
  return content.slice(0, at) + content.slice(at + value.length);
}
function targetEvidence(content: string, exists: boolean, j: TaskLifecycleTransferJournal, hash: (value: string) => string): TargetEvidence {
  if (!exists) return j.targetCreated ? 'original' : 'missing';
  if (hash(content) === j.targetOriginalHash) return 'original';
  const marked = allIndexes(content, markedInsertion(j));
  if (marked.length === 1) return 'marked';
  if (marked.length > 1 || content.includes(j.marker)) return 'ambiguous';
  const unmarked = allIndexes(content, unmarkedInsertion(j));
  if (unmarked.length === 1) return 'unmarked';
  return unmarked.length > 1 || content.includes(j.sourceBlock) ? 'ambiguous' : 'missing';
}
function sourceEvidence(content: string, exists: boolean, j: TaskLifecycleTransferJournal, hash: (value: string) => string): SourceEvidence {
  if (!exists) return 'missing';
  const hasOriginalHash = Boolean(j.sourceOriginalHash);
  const hasFinalizedHash = Boolean(j.sourceFinalizedHash);
  if (hasOriginalHash || hasFinalizedHash) {
    if (!hasOriginalHash || !hasFinalizedHash) return 'ambiguous';
    if (hash(content) === j.sourceOriginalHash) return 'present';
    if (hash(content) === j.sourceFinalizedHash) return 'finalized';
    return 'ambiguous';
  }
  // Only legacy journals without either hash may use block/replacement evidence.
  if (blockAtLine(content, j.sourceLine, j.sourceBlock)) return 'present';
  if (j.sourceReplacement) {
    if (blockAtLine(content, j.sourceLine, j.sourceReplacement)) return 'finalized';
  }
  return content.includes(j.sourceBlock) || Boolean(j.sourceReplacement && content.includes(j.sourceReplacement)) ? 'ambiguous' : 'missing';
}
function blockLines(block: string): string[] { return block.split(/\r?\n/u); }
function blockAtLine(content: string, lineNumber: number, block: string): boolean { const lines = splitContentLines(content); const expected = blockLines(block); return expected.every((text, index) => lines[lineNumber - 1 + index]?.text === text); }
function exactBlockFromContent(content: string, lineNumber: number, expectedBlock: string): string | null { const lines = splitContentLines(content); const expected = blockLines(expectedBlock); if (!expected.every((text, index) => lines[lineNumber - 1 + index]?.text === text)) return null; return expected.map((_text, index) => { const line = lines[lineNumber - 1 + index]; return `${line?.text ?? ''}${index === expected.length - 1 ? '' : line?.lineEnding ?? '\n'}`; }).join(''); }
function replaceBlock(content: string, lineNumber: number, expectedBlock: string, replacementBlock: string): { content: string; changed: boolean } { const lines = splitContentLines(content); const expected = blockLines(expectedBlock); if (!expected.every((text, index) => lines[lineNumber - 1 + index]?.text === text)) return { content, changed: false }; const ending = lines[lineNumber - 1]?.lineEnding || '\n'; const replacement = replacementBlock ? blockLines(replacementBlock).map((text, index, all) => ({ text, lineEnding: index === all.length - 1 ? (lines[lineNumber - 1 + expected.length - 1]?.lineEnding ?? ending) : ending })) : []; lines.splice(lineNumber - 1, expected.length, ...replacement); return { content: lines.map((line) => `${line.text}${line.lineEnding}`).join(''), changed: true }; }
function allIndexes(content: string, needle: string): number[] { const result: number[] = []; let from = 0; while (from <= content.length - needle.length) { const at = content.indexOf(needle, from); if (at < 0) break; result.push(at); from = at + Math.max(1, needle.length); } return result; }
function createOperationId(): string { return globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
