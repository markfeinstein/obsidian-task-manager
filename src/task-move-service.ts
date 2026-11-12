import { TFile, type App, type Editor } from 'obsidian';
import { parseMarkdownTaskLine } from './task-model';
import { findJournalPathConflict, type StateStore, type TaskMoveJournal, type TaskMoveJournalPhase } from './state-store';
import { moveStateRepository } from './state-slice-repositories';
import { ensureParentFolders, normalizeVaultRelativePath } from './vault-utils';

export interface TaskMoveRequest {
  editor: Editor;
  sourcePath: string;
  targetPath: string;
  sourceLine: number;
  targetHeading?: string;
  expectedTaskLine?: string;
}

export interface TaskMoveResult {
  operationId?: string;
  sourcePath: string;
  targetPath: string;
}

export interface TaskMoveReconciliationResult {
  operationId: string;
  outcome: 'rolled-back' | 'completed' | 'pending';
  diagnostic?: string;
}

export class TaskMoveConflictError extends Error {
  constructor(message: string, readonly operationId: string, readonly sourcePath: string, readonly targetPath: string) {
    super(message);
    this.name = 'TaskMoveConflictError';
  }
}

export class TaskMoveRecoveryError extends Error {
  constructor(message: string, readonly operationId: string, readonly sourcePath: string, readonly targetPath: string) {
    super(message);
    this.name = 'TaskMoveRecoveryError';
  }
}

interface ContentLine {
  text: string;
  start: number;
  end: number;
  contentEnd: number;
  ending: string;
}

interface ExtractedBlock {
  block: string;
  start: number;
  end: number;
  endLine: number;
}

interface TargetPlan {
  baseContent: string;
  insertionOffset: number;
  markerLine: string;
  insertionPrefix: string;
  insertionSuffix: string;
}

/** Journaled, destination-first task block moves. */
export class TaskMoveService {
  constructor(
    private readonly app: App,
    private readonly stateStore: StateStore,
    private readonly assertExplicitIdUnique: (id: string) => void = () => undefined,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async move(request: TaskMoveRequest): Promise<TaskMoveResult> {
    await this.stateStore.whenLifecycleRecoveryReady();
    const sourcePath = markdownPath(request.sourcePath, 'Source path');
    const targetPath = markdownPath(request.targetPath, 'Target path');
    this.assertPathIsFileOrMissing(sourcePath, 'source');
    this.assertPathIsFileOrMissing(targetPath, 'target');
    const sourceFile = this.fileAt(sourcePath);
    if (!sourceFile) throw new Error(`Source file ${sourcePath} does not exist`);
    this.assertNoFileFolderCollision(targetPath);

    const snapshot = request.editor.getValue();
    const extracted = extractTaskBlock(snapshot, request.sourceLine);
    const firstLine = linesOf(extracted.block)[0]?.text ?? '';
    if (request.expectedTaskLine !== undefined && firstLine !== request.expectedTaskLine) {
      throw new Error('Source task line changed before the move started');
    }
    const parsed = parseMarkdownTaskLine(firstLine, sourcePath, request.sourceLine + 1);
    if (!parsed) throw new Error(`Line ${request.sourceLine + 1} is not a Markdown task`);
    const explicitId = parsed.metadata.id?.trim();
    if (explicitId) this.assertExplicitIdUnique(explicitId);

    const heading = request.targetHeading?.trim() ?? '';
    if (sourcePath === targetPath) {
      const withoutBlock = snapshot.slice(0, extracted.start) + snapshot.slice(extracted.end);
      const moved = insertUnmarkedBlock(withoutBlock, extracted.block, heading);
      // One setValue call is the editor transaction: no intermediate duplicate or deletion is exposed.
      request.editor.setValue(moved);
      return { sourcePath, targetPath };
    }

    const persistedSource = await this.app.vault.read(sourceFile);
    if (persistedSource !== snapshot) {
      throw new Error('Source note has unsaved or concurrent changes; save it and retry the move');
    }
    return this.moveAcrossFiles(request.editor, snapshot, sourcePath, targetPath, request.sourceLine, extracted, heading);
  }

  async reconcilePendingMoves(): Promise<TaskMoveReconciliationResult[]> {
    const state = await this.stateStore.loadState();
    const results: TaskMoveReconciliationResult[] = [];
    for (const journal of state.taskMoveJournals ?? []) {
      try {
        results.push(await this.reconcileJournal(journal));
      } catch (error) {
        const diagnostic = await this.retainForRecoveryBestEffort(
          journal,
          `Move ${journal.operationId} reconciliation failed: ${errorMessage(error)}`,
        );
        results.push({ operationId: journal.operationId, outcome: 'pending', diagnostic });
      }
    }
    return results;
  }

  private async reconcileJournal(journal: TaskMoveJournal): Promise<TaskMoveReconciliationResult> {
    const sourceFile = this.fileAt(journal.sourcePath);
    const targetFile = this.fileAt(journal.targetPath);
    const source = sourceFile ? await this.app.vault.read(sourceFile) : '';
    const target = targetFile ? await this.app.vault.read(targetFile) : '';
    const hash = (value: string): string => this.stateStore.hash(value);
    const sourceEvidence = classifySourceWriteEvidence(source, Boolean(sourceFile), journal, hash);
    const targetEvidence = classifyTargetWriteEvidence(target, Boolean(targetFile), journal, hash);

    if ((sourceEvidence === 'original' || sourceEvidence === 'legacy-present') && targetEvidence === 'marked') {
      await this.rollbackTarget(journal);
      await this.removeJournal(journal.operationId);
      return { operationId: journal.operationId, outcome: 'rolled-back' };
    }
    if ((sourceEvidence === 'original' || sourceEvidence === 'legacy-present') && targetEvidence === 'original') {
      await this.removeJournal(journal.operationId);
      return { operationId: journal.operationId, outcome: 'rolled-back' };
    }
    if (sourceEvidence === 'finalized' && targetEvidence === 'marked') {
      await this.removeTargetMarker(journal);
      await this.removeJournal(journal.operationId);
      return { operationId: journal.operationId, outcome: 'completed' };
    }
    if (sourceEvidence === 'finalized' && targetEvidence === 'unmarked') {
      await this.removeJournal(journal.operationId);
      return { operationId: journal.operationId, outcome: 'completed' };
    }

    const diagnostic = await this.retainForRecoveryBestEffort(
      journal,
      `Move ${journal.operationId} has ambiguous evidence (source=${sourceEvidence}, target=${targetEvidence}, phase=${journal.phase})`,
    );
    return { operationId: journal.operationId, outcome: 'pending', diagnostic };
  }

  private async moveAcrossFiles(
    editor: Editor,
    sourceOriginal: string,
    sourcePath: string,
    targetPath: string,
    sourceLine: number,
    extracted: ExtractedBlock,
    targetHeading: string,
  ): Promise<TaskMoveResult> {
    const operationId = createOperationId();
    const marker = `<!-- task-manager-move:${operationId} -->`;
    const sourceFinalized = sourceOriginal.slice(0, extracted.start) + sourceOriginal.slice(extracted.end);
    const existingTarget = this.fileAt(targetPath);
    const originalTarget = existingTarget ? await this.app.vault.read(existingTarget) : '';
    const plan = planTargetInsertion(originalTarget, extracted.block, targetHeading, marker, !existingTarget);
    const journal: TaskMoveJournal = {
      operationId,
      sourcePath,
      targetPath,
      sourceLine,
      targetInsertionOffset: plan.insertionOffset,
      targetOriginalHash: this.stateStore.hash(plan.baseContent),
      sourceOriginalHash: this.stateStore.hash(sourceOriginal),
      sourceFinalizedHash: this.stateStore.hash(sourceFinalized),
      targetCreated: !existingTarget,
      block: extracted.block,
      marker,
      markerLine: plan.markerLine,
      insertionPrefix: plan.insertionPrefix,
      insertionSuffix: plan.insertionSuffix,
      targetHeading,
      phase: 'prepared',
      createdAtIso: this.now().toISOString(),
    };
    await this.addJournal(journal);

    try {
      await this.writeMarkedTarget(existingTarget, targetPath, originalTarget, plan, extracted.block);
      await this.setJournalPhase(operationId, 'target-written');
    } catch (error) {
      const targetState = await this.targetWriteEvidence(journal);
      if (targetState !== 'original') {
        const diagnostic = await this.retainForRecoveryBestEffort(journal, `Target write outcome is uncertain: ${errorMessage(error)}`);
        throw new TaskMoveRecoveryError(`Task move ${operationId} requires reconciliation after target write failure: ${diagnostic}`, operationId, sourcePath, targetPath);
      }
      await this.removeJournal(operationId);
      throw error;
    }

    const current = editor.getValue();
    if (current !== sourceOriginal) {
      try {
        await this.rollbackTarget(journal);
        await this.removeJournal(operationId);
      } catch (rollbackError) {
        const diagnostic = await this.retainForRecoveryBestEffort(journal, `Source conflict rollback failed: ${errorMessage(rollbackError)}`);
        throw new TaskMoveRecoveryError(`Task move ${operationId} requires reconciliation; source changed and target rollback failed: ${diagnostic}`, operationId, sourcePath, targetPath);
      }
      throw new TaskMoveConflictError('Source note changed before it could be finalized; target copy was rolled back', operationId, sourcePath, targetPath);
    }

    const sourceFile = this.fileAt(sourcePath);
    if (!sourceFile) {
      const diagnostic = await this.retainForRecoveryBestEffort(journal, `Source file ${sourcePath} disappeared before finalization`);
      throw new TaskMoveRecoveryError(`Task move ${operationId} requires reconciliation: ${diagnostic}`, operationId, sourcePath, targetPath);
    }
    try {
      await this.app.vault.process(sourceFile, (content) => {
        if (content !== sourceOriginal) throw new Error('Source note changed before the durable move write');
        return sourceFinalized;
      });
    } catch (error) {
      try {
        await this.rollbackTarget(journal);
        await this.removeJournal(operationId);
      } catch (rollbackError) {
        const diagnostic = await this.retainForRecoveryBestEffort(journal, `Source finalization failed (${errorMessage(error)}) and target rollback failed: ${errorMessage(rollbackError)}`);
        throw new TaskMoveRecoveryError(`Task move ${operationId} requires reconciliation: ${diagnostic}`, operationId, sourcePath, targetPath);
      }
      throw new TaskMoveConflictError(`Source note could not be finalized: ${errorMessage(error)}; target copy was rolled back`, operationId, sourcePath, targetPath);
    }

    try {
      await this.setJournalPhase(operationId, 'source-removed');
      const currentEditor = editor.getValue();
      if (currentEditor === sourceOriginal) {
        editor.replaceRange('', positionAtOffset(sourceOriginal, extracted.start), positionAtOffset(sourceOriginal, extracted.end));
      } else if (currentEditor !== sourceFinalized) {
        throw new Error('Source editor changed after the durable move write');
      }
      await this.removeTargetMarker(journal);
      await this.removeJournal(operationId);
    } catch (error) {
      const diagnostic = await this.retainForRecoveryBestEffort(journal, `Post-source cleanup failed after source removal: ${errorMessage(error)}`, 'source-removed');
      throw new TaskMoveRecoveryError(`Task move ${operationId} requires reconciliation after source removal: ${diagnostic}`, operationId, sourcePath, targetPath);
    }
    return { operationId, sourcePath, targetPath };
  }

  private async writeMarkedTarget(file: TFile | null, path: string, expected: string, plan: TargetPlan, block: string): Promise<void> {
    const insertion = `${plan.insertionPrefix}${plan.markerLine}${block}${plan.insertionSuffix}`;
    const next = plan.baseContent.slice(0, plan.insertionOffset) + insertion + plan.baseContent.slice(plan.insertionOffset);
    if (file) {
      await this.app.vault.process(file, (current) => {
        if (current !== expected) throw new Error('Target note changed before the move write');
        return next;
      });
      return;
    }
    await ensureParentFolders(this.app, path);
    const collision = this.app.vault.getAbstractFileByPath(path);
    if (collision) throw new Error(`Target path ${path} was created before the move write`);
    await this.app.vault.create(path, next);
  }

  private async rollbackTarget(journal: TaskMoveJournal): Promise<void> {
    const file = this.fileAt(journal.targetPath);
    if (!file) throw new Error(`Target file ${journal.targetPath} is missing`);
    await this.app.vault.process(file, (content) => removeMarkedInsertion(content, journal));
  }

  private async removeTargetMarker(journal: TaskMoveJournal): Promise<void> {
    const file = this.fileAt(journal.targetPath);
    if (!file) throw new Error(`Target file ${journal.targetPath} is missing`);
    await this.app.vault.process(file, (content) => {
      const markerIndexes = allIndexes(content, journal.marker);
      if (markerIndexes.length !== 1) throw new Error(`Expected one move marker, found ${markerIndexes.length}`);
      const index = markerIndexes[0];
      if (content.slice(index, index + journal.markerLine.length) !== journal.markerLine
        || content.slice(index + journal.markerLine.length, index + journal.markerLine.length + journal.block.length) !== journal.block) {
        throw new Error('Marker-associated target block no longer matches the move journal');
      }
      return content.slice(0, index) + content.slice(index + journal.markerLine.length);
    });
  }

  private async targetWriteEvidence(journal: TaskMoveJournal): Promise<TargetWriteEvidence> {
    const file = this.fileAt(journal.targetPath);
    if (!file) return journal.targetCreated ? 'original' : 'unknown';
    try {
      return classifyTargetWriteEvidence(await this.app.vault.read(file), true, journal, (value) => this.stateStore.hash(value));
    } catch {
      return 'unknown';
    }
  }

  private fileAt(path: string): TFile | null {
    const entry = this.app.vault.getAbstractFileByPath(path);
    return entry instanceof TFile ? entry : null;
  }

  private assertPathIsFileOrMissing(path: string, role: string): void {
    const entry = this.app.vault.getAbstractFileByPath(path);
    if (!entry) return;
    if (!(entry instanceof TFile)) throw new Error(`${role[0].toUpperCase()}${role.slice(1)} path ${path} is a folder`);
    if (entry.extension.toLowerCase() !== 'md') throw new Error(`${role[0].toUpperCase()}${role.slice(1)} path must be a Markdown file`);
  }

  private assertNoFileFolderCollision(path: string): void {
    const segments = path.split('/');
    let parent = '';
    for (const segment of segments.slice(0, -1)) {
      parent = parent ? `${parent}/${segment}` : segment;
      if (this.app.vault.getAbstractFileByPath(parent) instanceof TFile) {
        throw new Error(`Cannot use target path ${path}: ${parent} is a file, not a folder`);
      }
    }
  }

  private async addJournal(journal: TaskMoveJournal): Promise<void> {
    const committed = await this.stateStore.updateState((state) => {
      const conflict = findJournalPathConflict(state, journal.sourcePath, journal.targetPath, journal.operationId);
      if (conflict) throw new TaskMoveConflictError(`Move ${conflict.operationId} already fences ${conflict.sourcePath} or ${conflict.targetPath}`, conflict.operationId, journal.sourcePath, journal.targetPath);
      return { ...state, taskMoveJournals: [...(state.taskMoveJournals ?? []), journal] };
    });
    if (!(committed.taskMoveJournals ?? []).some((entry) => entry.operationId === journal.operationId)) {
      throw new Error('Task move journal was not durably persisted');
    }
  }

  private async setJournalPhase(operationId: string, phase: TaskMoveJournalPhase): Promise<void> {
    await moveStateRepository(this.stateStore).update((state) => ({
      taskMoveJournals: (state.taskMoveJournals ?? []).map((entry) => entry.operationId === operationId ? { ...entry, phase, diagnostic: undefined } : entry),
    }));
  }

  private async removeJournal(operationId: string): Promise<void> {
    await moveStateRepository(this.stateStore).update((state) => ({ taskMoveJournals: (state.taskMoveJournals ?? []).filter((entry) => entry.operationId !== operationId) }));
  }

  private async retainForRecoveryBestEffort(
    journal: TaskMoveJournal,
    diagnostic: string,
    phase: TaskMoveJournalPhase = 'reconciliation-required',
  ): Promise<string> {
    try {
      await this.retainForRecovery(journal, diagnostic, phase);
      return diagnostic;
    } catch (error) {
      const combined = `${diagnostic}; recovery state could not be saved: ${errorMessage(error)}`;
      console.error('Task Manager:', combined);
      return combined;
    }
  }

  private async retainForRecovery(journal: TaskMoveJournal, diagnostic: string, phase: TaskMoveJournalPhase = 'reconciliation-required'): Promise<void> {
    await moveStateRepository(this.stateStore).update((state) => {
      const current = state.taskMoveJournals ?? [];
      const existing = current.find((entry) => entry.operationId === journal.operationId);
      const retainedPhase = existing?.phase === 'source-removed' ? 'source-removed' : phase;
      const retained = { ...journal, ...existing, phase: retainedPhase, diagnostic };
      return {
        taskMoveJournals: existing
          ? current.map((entry) => entry.operationId === journal.operationId ? retained : entry)
          : [...current, retained],
      };
    });
  }
}

export function extractTaskBlock(content: string, sourceLine: number): ExtractedBlock {
  const lines = linesOf(content);
  const parent = lines[sourceLine];
  if (!parent) throw new Error(`Source task line ${sourceLine + 1} no longer exists`);
  if (!parseMarkdownTaskLine(parent.text, 'source.md', sourceLine + 1)) throw new Error(`Line ${sourceLine + 1} is not a Markdown task`);
  const parentIndent = taskIndent(parent.text);
  let endLine = sourceLine + 1;
  let pendingBlankStart = -1;
  for (let index = sourceLine + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.text.trim() === '') {
      if (pendingBlankStart < 0) pendingBlankStart = index;
      continue;
    }
    if (!belongsToTaskBlock(line.text, parentIndent)) break;
    endLine = index + 1;
    pendingBlankStart = -1;
  }
  // Blank lines count only when they separate associated descendants/continuations,
  // not when they merely separate the task from its next sibling.
  const end = lines[endLine - 1]?.end ?? parent.end;
  return { block: content.slice(parent.start, end), start: parent.start, end, endLine };
}

function markdownPath(raw: string, field: string): string {
  const normalized = normalizeVaultRelativePath(raw, field);
  const leaf = normalized.split('/').pop() ?? normalized;
  if (/\.[^./]+$/u.test(leaf) && !/\.md$/iu.test(leaf)) {
    throw new Error(`${field} must identify a Markdown file`);
  }
  return /\.md$/iu.test(normalized) ? normalized : `${normalized}.md`;
}

function taskIndent(line: string): number {
  return indentationWidth(line.match(/^(?:[ \t]*>[ \t]*)*[ \t]*/u)?.[0] ?? '');
}

function belongsToTaskBlock(line: string, parentIndent: number): boolean {
  const indent = taskIndent(line);
  if (indent <= parentIndent) return false;
  // A top-level blockquote is a sibling construct, not automatic commentary for
  // an unquoted root task. Indented/nested blockquotes still belong to the block.
  const leadingWhitespace = indentationWidth(line.match(/^[ \t]*/u)?.[0] ?? '');
  return !(/^[ \t]*>/u.test(line) && parentIndent === 0 && leadingWhitespace === 0);
}

function indentationWidth(value: string): number {
  let width = 0;
  for (const char of value) width += char === '\t' ? 4 : 1;
  return width;
}

function linesOf(content: string): ContentLine[] {
  const result: ContentLine[] = [];
  const regex = /([^\r\n]*)(\r\n|\n|\r|$)/gu;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(content)) !== null) {
    if (match[0] === '' && regex.lastIndex === content.length) break;
    const start = match.index;
    const text = match[1];
    const ending = match[2];
    result.push({ text, ending, start, contentEnd: start + text.length, end: start + text.length + ending.length });
    if (!ending) break;
  }
  return result;
}

function insertUnmarkedBlock(content: string, block: string, heading: string): string {
  const marker = '<!-- internal-task-move-position -->';
  const plan = planTargetInsertion(content, block, heading, marker, false);
  const prefix = plan.insertionPrefix;
  return plan.baseContent.slice(0, plan.insertionOffset) + prefix + block + plan.insertionSuffix + plan.baseContent.slice(plan.insertionOffset);
}

function planTargetInsertion(content: string, block: string, heading: string, marker: string, createHeading: boolean): TargetPlan {
  const lineEnding = preferredLineEnding(content, block);
  let baseContent = content;
  if (createHeading && heading) baseContent = `${heading}${lineEnding}`;
  const lines = linesOf(baseContent);
  const headingLine = heading ? lines.find((line) => line.text === heading) : undefined;
  const insertionOffset = headingLine ? headingLine.end : baseContent.length;
  const insertionPrefix = insertionOffset > 0 && !/[\r\n]$/u.test(baseContent.slice(0, insertionOffset)) ? lineEnding : '';
  const insertionSuffix = /(?:\r\n|\n|\r)$/u.test(block) ? '' : lineEnding;
  return { baseContent, insertionOffset, markerLine: `${marker}${lineEnding}`, insertionPrefix, insertionSuffix };
}

function preferredLineEnding(primary: string, fallback: string): string {
  const match = primary.match(/\r\n|\n|\r/u) ?? fallback.match(/\r\n|\n|\r/u);
  return match?.[0] ?? '\n';
}

function removeMarkedInsertion(content: string, journal: TaskMoveJournal): string {
  const markerIndexes = allIndexes(content, journal.marker);
  if (markerIndexes.length !== 1) throw new Error(`Expected one move marker, found ${markerIndexes.length}`);
  const markerIndex = markerIndexes[0];
  const start = markerIndex - journal.insertionPrefix.length;
  const insertion = `${journal.insertionPrefix}${journal.markerLine}${journal.block}${journal.insertionSuffix}`;
  if (start < 0 || content.slice(start, start + insertion.length) !== insertion) {
    throw new Error('Marker-associated target insertion no longer matches the move journal');
  }
  return content.slice(0, start) + content.slice(start + insertion.length);
}

function markedInsertionEvidence(content: string, journal: TaskMoveJournal): 'present' | 'missing' | 'ambiguous' {
  const markerIndexes = allIndexes(content, journal.marker);
  if (markerIndexes.length === 0) return 'missing';
  if (markerIndexes.length > 1) return 'ambiguous';
  const markerIndex = markerIndexes[0];
  const start = markerIndex - journal.insertionPrefix.length;
  const insertion = `${journal.insertionPrefix}${journal.markerLine}${journal.block}${journal.insertionSuffix}`;
  return start >= 0 && content.slice(start, start + insertion.length) === insertion ? 'present' : 'ambiguous';
}

type TargetWriteEvidence = 'marked' | 'unmarked' | 'original' | 'ambiguous' | 'unknown';

function classifyTargetWriteEvidence(
  content: string,
  fileExists: boolean,
  journal: TaskMoveJournal,
  hash: (value: string) => string,
): TargetWriteEvidence {
  if (!fileExists) return journal.targetCreated ? 'original' : 'unknown';
  if (hash(content) === journal.targetOriginalHash) return 'original';
  const marked = markedInsertionEvidence(content, journal);
  if (marked === 'present') return 'marked';
  if (marked === 'ambiguous') return 'ambiguous';
  const unmarked = unmarkedInsertionEvidence(content, journal);
  if (unmarked === 'present') return 'unmarked';
  return 'ambiguous';
}

function unmarkedInsertionEvidence(content: string, journal: TaskMoveJournal): 'present' | 'missing' | 'ambiguous' {
  const insertion = `${journal.insertionPrefix}${journal.block}${journal.insertionSuffix}`;
  const start = journal.targetInsertionOffset;
  if (content.slice(start, start + insertion.length) === insertion) return 'present';
  return content.includes(journal.block) ? 'ambiguous' : 'missing';
}

type SourceWriteEvidence = 'original' | 'finalized' | 'legacy-present' | 'ambiguous';

function classifySourceWriteEvidence(
  content: string,
  fileExists: boolean,
  journal: TaskMoveJournal,
  hash: (value: string) => string,
): SourceWriteEvidence {
  if (!fileExists) return 'ambiguous';
  const hasOriginalHash = Boolean(journal.sourceOriginalHash);
  const hasFinalizedHash = Boolean(journal.sourceFinalizedHash);
  if (hasOriginalHash || hasFinalizedHash) {
    if (!hasOriginalHash || !hasFinalizedHash) return 'ambiguous';
    const currentHash = hash(content);
    if (currentHash === journal.sourceOriginalHash) return 'original';
    if (currentHash === journal.sourceFinalizedHash) return 'finalized';
    return 'ambiguous';
  }

  // Legacy journals can prove only that the original source still exists, which
  // safely authorizes target rollback. Absence is never treated as completion:
  // old records lack the full finalized-source proof required for that decision.
  const line = linesOf(content)[journal.sourceLine];
  if (line && content.slice(line.start, line.start + journal.block.length) === journal.block) return 'legacy-present';
  if (allIndexes(content, journal.block).length > 0) return 'legacy-present';
  return 'ambiguous';
}

function allIndexes(content: string, needle: string): number[] {
  if (!needle) return [];
  const indexes: number[] = [];
  let from = 0;
  while (from <= content.length - needle.length) {
    const index = content.indexOf(needle, from);
    if (index < 0) break;
    indexes.push(index);
    from = index + Math.max(1, needle.length);
  }
  return indexes;
}

function positionAtOffset(content: string, offset: number): { line: number; ch: number } {
  const before = content.slice(0, offset);
  const parts = before.split(/\r\n|\n|\r/u);
  return { line: parts.length - 1, ch: parts[parts.length - 1]?.length ?? 0 };
}

function createOperationId(): string {
  const cryptoApi = globalThis.crypto as Crypto | undefined;
  if (cryptoApi?.randomUUID) return cryptoApi.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
