import { Modal, Notice, TFile, type App } from 'obsidian';
import type { ParsedTask, TaskScanner } from './task-scanner';
import { sourceLineIdentity, splitContentLines } from './task-model';
import { t } from './i18n';

export interface DashboardDeleteHunk {
  readonly startLine: number;
  readonly endLine: number;
  readonly removedText: string;
  readonly beforeAnchor: string;
  readonly afterAnchor: string;
  readonly contextHash: string;
}

export interface DashboardDeleteFilePlan {
  readonly file: TFile;
  readonly path: string;
  readonly beforeContent: string;
  readonly afterContent: string;
  readonly hunks: readonly DashboardDeleteHunk[];
}

export interface DashboardDeletePlan {
  readonly selectedCount: number;
  readonly fileCount: number;
  readonly descendantLineCount: number;
  readonly descendantTaskCount: number;
  readonly selectedTaskKeys: readonly string[];
  readonly files: readonly DashboardDeleteFilePlan[];
}

export interface DashboardDeleteTransaction extends DashboardDeletePlan {
  readonly committedAt: number;
}

export interface DashboardDeleteRecovery {
  readonly kind: 'delete' | 'undo';
  readonly paths: readonly string[];
}

interface RecoveryEntry {
  file: DashboardDeleteFilePlan;
  expected: string;
  replacement: string;
}

interface RecoveryState {
  kind: 'delete' | 'undo';
  transaction: DashboardDeleteTransaction;
  entries: RecoveryEntry[];
}

interface AppDeleteRecoveryStore {
  recoveryState: RecoveryState | null;
  busy: boolean;
}

const APP_DELETE_RECOVERY_STORES = new WeakMap<App, AppDeleteRecoveryStore>();

function appDeleteRecoveryStore(app: App): AppDeleteRecoveryStore {
  const existing = APP_DELETE_RECOVERY_STORES.get(app);
  if (existing) return existing;
  const created: AppDeleteRecoveryStore = { recoveryState: null, busy: false };
  APP_DELETE_RECOVERY_STORES.set(app, created);
  return created;
}

function hashText(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

function taskSelectionKey(task: ParsedTask): string {
  return `${task.filePath}:${task.lineNumber}:${task.key}`;
}

function findTaskLine(
  lines: ReadonlyArray<{ text: string; lineEnding: string }>,
  task: ParsedTask,
  scanner: TaskScanner,
): { index: number; parsed: ParsedTask } {
  const exactKey = task.key.split('\u0000', 1)[0] ?? task.key;
  const keyMatches: Array<{ index: number; parsed: ParsedTask }> = [];
  const sourceMatches: Array<{ index: number; parsed: ParsedTask }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    const parsed = scanner.parseTaskLine(line.text, task.filePath, index + 1, task.heading);
    if (!parsed) continue;
    if (parsed.key === exactKey) keyMatches.push({ index, parsed });
    if (sourceLineIdentity(line.text) === sourceLineIdentity(task.rawLine)) sourceMatches.push({ index, parsed });
  }
  const matches = keyMatches.length === 1
    ? keyMatches
    : keyMatches.length > 1
      ? keyMatches.filter((candidate) => sourceLineIdentity(lines[candidate.index]?.text ?? '') === sourceLineIdentity(task.rawLine))
      : sourceMatches;
  if (matches.length === 0) throw new Error(`Task at ${task.filePath}:${task.lineNumber} no longer exists. Refresh tasks and try again.`);
  if (matches.length > 1) throw new Error(`Task at ${task.filePath}:${task.lineNumber} is ambiguous. Refresh tasks and try again.`);
  return matches[0];
}

function lineOffsets(lines: ReadonlyArray<{ text: string; lineEnding: string }>): number[] {
  const offsets = [0];
  for (const line of lines) offsets.push((offsets[offsets.length - 1] ?? 0) + line.text.length + line.lineEnding.length);
  return offsets;
}

export async function planDashboardDailyDelete(
  app: App,
  scanner: TaskScanner,
  selectedTasks: readonly ParsedTask[],
): Promise<DashboardDeletePlan> {
  const distinct = new Map<string, ParsedTask>();
  for (const task of selectedTasks) distinct.set(taskSelectionKey(task), task);
  if (distinct.size === 0) throw new Error('No tasks are selected.');

  const grouped = new Map<string, ParsedTask[]>();
  for (const task of distinct.values()) {
    const tasks = grouped.get(task.filePath) ?? [];
    tasks.push(task);
    grouped.set(task.filePath, tasks);
  }

  const files: DashboardDeleteFilePlan[] = [];
  let descendantLineCount = 0;
  let descendantTaskCount = 0;
  for (const [path, tasks] of [...grouped].sort(([left], [right]) => left.localeCompare(right))) {
    const file = app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new Error(`Source file not found: ${path}. Refresh tasks and try again.`);
    const beforeContent = await app.vault.read(file);
    const lines = splitContentLines(beforeContent);
    const offsets = lineOffsets(lines);
    const selectedIndexes = new Set<number>();
    const ranges: Array<{ start: number; end: number }> = [];
    for (const task of tasks) {
      const located = findTaskLine(lines, task, scanner);
      if (selectedIndexes.has(located.index)) throw new Error(`Two selected tasks resolve to the same source line in ${path}. Refresh tasks and try again.`);
      selectedIndexes.add(located.index);
      const parentIndent = located.parsed.indentation.length + located.parsed.linePrefix.length;
      let end = located.index + 1;
      while (end < lines.length) {
        const childText = lines[end]?.text ?? '';
        const childIndent = childText.match(/^(?:\s*>\s*)*\s*/u)?.[0].length ?? 0;
        if (childIndent <= parentIndent) break;
        end += 1;
      }
      ranges.push({ start: located.index, end });
    }
    ranges.sort((left, right) => left.start - right.start || left.end - right.end);
    const merged: Array<{ start: number; end: number }> = [];
    for (const range of ranges) {
      const previous = merged[merged.length - 1];
      if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
      else merged.push({ ...range });
    }

    const hunks: DashboardDeleteHunk[] = merged.map((range) => {
      for (let index = range.start; index < range.end; index += 1) {
        if (selectedIndexes.has(index)) continue;
        descendantLineCount += 1;
        const line = lines[index];
        if (line && scanner.parseTaskLine(line.text, path, index + 1, '')) descendantTaskCount += 1;
      }
      const startOffset = offsets[range.start] ?? beforeContent.length;
      const endOffset = offsets[range.end] ?? beforeContent.length;
      const beforeStart = offsets[Math.max(0, range.start - 2)] ?? 0;
      const afterEnd = offsets[Math.min(lines.length, range.end + 2)] ?? beforeContent.length;
      const beforeAnchor = beforeContent.slice(beforeStart, startOffset);
      const afterAnchor = beforeContent.slice(endOffset, afterEnd);
      const removedText = beforeContent.slice(startOffset, endOffset);
      return Object.freeze({
        startLine: range.start + 1,
        endLine: range.end,
        removedText,
        beforeAnchor,
        afterAnchor,
        contextHash: hashText(`${beforeAnchor}\u0000${removedText}\u0000${afterAnchor}`),
      });
    });
    let afterContent = beforeContent;
    for (const hunk of [...hunks].reverse()) {
      const startOffset = offsets[hunk.startLine - 1] ?? beforeContent.length;
      const endOffset = offsets[hunk.endLine] ?? beforeContent.length;
      afterContent = `${afterContent.slice(0, startOffset)}${afterContent.slice(endOffset)}`;
    }
    files.push(Object.freeze({ file, path, beforeContent, afterContent, hunks: Object.freeze(hunks) }));
  }

  return Object.freeze({
    selectedCount: distinct.size,
    fileCount: files.length,
    descendantLineCount,
    descendantTaskCount,
    selectedTaskKeys: Object.freeze([...distinct.keys()]),
    files: Object.freeze(files),
  });
}

export function dashboardDeleteConfirmationSummary(plan: DashboardDeletePlan): string {
  const selected = `${plan.selectedCount} selected task${plan.selectedCount === 1 ? '' : 's'}`;
  const notes = `${plan.fileCount} note${plan.fileCount === 1 ? '' : 's'}`;
  if (plan.descendantLineCount === 0) {
    return `Delete ${selected} across ${notes}? No indented descendant lines will be removed. You can undo this deletion during this Task Manager session.`;
  }
  const descendantTasks = plan.descendantTaskCount === 0
    ? 'None of the additional lines are tasks.'
    : `${plan.descendantTaskCount} of the additional lines ${plan.descendantTaskCount === 1 ? 'is a task' : 'are tasks'}.`;
  return `Delete ${selected} and ${plan.descendantLineCount} additional indented line${plan.descendantLineCount === 1 ? '' : 's'} across ${notes}? ${descendantTasks} You can undo this deletion during this Task Manager session.`;
}

async function readAll(app: App, files: readonly DashboardDeleteFilePlan[]): Promise<Map<string, string>> {
  const contents = new Map<string, string>();
  for (const file of files) contents.set(file.path, await app.vault.read(file.file));
  return contents;
}

async function compareAndSwap(app: App, file: DashboardDeleteFilePlan, expected: string, replacement: string): Promise<void> {
  await app.vault.process(file.file, (current) => {
    if (current !== expected) throw new Error(`Concurrent edit conflict in ${file.path}`);
    return replacement;
  });
}

function uniqueOccurrence(haystack: string, needle: string): number | null {
  if (needle === '') return haystack === '' ? 0 : null;
  const first = haystack.indexOf(needle);
  if (first < 0 || haystack.indexOf(needle, first + 1) >= 0) return null;
  return first;
}

function restoreHunks(current: string, file: DashboardDeleteFilePlan): string {
  const insertions: Array<{ offset: number; text: string }> = [];
  for (const hunk of file.hunks) {
    let offset: number | null = null;
    if (hunk.beforeAnchor && hunk.afterAnchor) {
      const boundary = `${hunk.beforeAnchor}${hunk.afterAnchor}`;
      const found = uniqueOccurrence(current, boundary);
      if (found !== null) offset = found + hunk.beforeAnchor.length;
    } else if (hunk.beforeAnchor) {
      const found = uniqueOccurrence(current, hunk.beforeAnchor);
      if (found !== null) offset = found + hunk.beforeAnchor.length;
    } else if (hunk.afterAnchor) {
      offset = uniqueOccurrence(current, hunk.afterAnchor);
    } else if (current === '') {
      offset = 0;
    }
    if (offset === null || current.slice(offset, offset + hunk.removedText.length) === hunk.removedText) {
      throw new Error(`Undo conflict in ${file.path}: the deletion anchors are missing or ambiguous`);
    }
    insertions.push({ offset, text: hunk.removedText });
  }
  insertions.sort((left, right) => right.offset - left.offset);
  for (let index = 1; index < insertions.length; index += 1) {
    if (insertions[index - 1]?.offset === insertions[index]?.offset) throw new Error(`Undo conflict in ${file.path}: deletion anchors overlap`);
  }
  let restored = current;
  for (const insertion of insertions) restored = `${restored.slice(0, insertion.offset)}${insertion.text}${restored.slice(insertion.offset)}`;
  return restored;
}

export class DashboardDailyDeleteSession {
  private readonly undoStack: DashboardDeleteTransaction[] = [];
  private readonly recoveryStore: AppDeleteRecoveryStore;

  constructor(private readonly app: App, private readonly limit = 10) {
    this.recoveryStore = appDeleteRecoveryStore(app);
  }

  get isBusy(): boolean { return this.recoveryStore.busy; }
  get undoable(): DashboardDeleteTransaction | null { return this.undoStack[this.undoStack.length - 1] ?? null; }
  get recovery(): DashboardDeleteRecovery | null {
    const recovery = this.recoveryStore.recoveryState;
    return recovery ? { kind: recovery.kind, paths: recovery.entries.map((entry) => entry.file.path) } : null;
  }

  clearUndoHistory(): void {
    this.undoStack.length = 0;
  }

  /** Unresolved App-scoped recovery is intentionally retained across owner teardown. */
  clear(): void {
    this.clearUndoHistory();
  }

  async commit(plan: DashboardDeletePlan): Promise<DashboardDeleteTransaction> {
    if (this.recoveryStore.busy) throw new Error('A dashboard delete operation is already running.');
    if (this.recoveryStore.recoveryState) throw new Error('Complete the pending delete recovery before deleting more tasks.');
    this.recoveryStore.busy = true;
    const files = [...plan.files];
    const written: DashboardDeleteFilePlan[] = [];
    try {
      const current = await readAll(this.app, files);
      for (const file of files) if (current.get(file.path) !== file.beforeContent) throw new Error(`Concurrent edit conflict in ${file.path}`);
      for (const file of files) {
        await compareAndSwap(this.app, file, file.beforeContent, file.afterContent);
        written.push(file);
      }
      const transaction: DashboardDeleteTransaction = Object.freeze({ ...plan, committedAt: Date.now() });
      this.undoStack.push(transaction);
      if (this.undoStack.length > this.limit) this.undoStack.splice(0, this.undoStack.length - this.limit);
      return transaction;
    } catch (error) {
      const failedCompensation: RecoveryEntry[] = [];
      for (const file of [...written].reverse()) {
        try { await compareAndSwap(this.app, file, file.afterContent, file.beforeContent); }
        catch { failedCompensation.push({ file, expected: file.afterContent, replacement: file.beforeContent }); }
      }
      if (failedCompensation.length > 0) {
        const transaction: DashboardDeleteTransaction = Object.freeze({ ...plan, committedAt: Date.now() });
        this.recoveryStore.recoveryState = { kind: 'delete', transaction, entries: failedCompensation };
        throw new Error(`Delete failed and recovery is required for: ${failedCompensation.map((entry) => entry.file.path).join(', ')}`);
      }
      throw error;
    } finally {
      this.recoveryStore.busy = false;
    }
  }

  async undo(): Promise<DashboardDeleteTransaction> {
    if (this.recoveryStore.busy) throw new Error('A dashboard delete operation is already running.');
    if (this.recoveryStore.recoveryState) throw new Error('Complete the pending recovery before undoing.');
    const transaction = this.undoable;
    if (!transaction) throw new Error('There is no dashboard deletion to undo.');
    this.recoveryStore.busy = true;
    const restores: Array<{ file: DashboardDeleteFilePlan; expected: string; restored: string }> = [];
    const written: Array<{ file: DashboardDeleteFilePlan; expected: string; restored: string }> = [];
    try {
      const current = await readAll(this.app, transaction.files);
      for (const file of transaction.files) {
        const content = current.get(file.path) ?? '';
        const restored = content === file.afterContent ? file.beforeContent : restoreHunks(content, file);
        restores.push({ file, expected: content, restored });
      }
      for (const restore of restores) {
        await compareAndSwap(this.app, restore.file, restore.expected, restore.restored);
        written.push({ file: restore.file, expected: restore.expected, restored: restore.restored });
      }
      this.undoStack.pop();
      return transaction;
    } catch (error) {
      const failedCompensation: RecoveryEntry[] = [];
      for (const entry of [...written].reverse()) {
        try { await compareAndSwap(this.app, entry.file, entry.restored, entry.expected); }
        catch { failedCompensation.push({ file: entry.file, expected: entry.restored, replacement: entry.expected }); }
      }
      if (failedCompensation.length > 0) {
        this.recoveryStore.recoveryState = { kind: 'undo', transaction, entries: failedCompensation };
        throw new Error(`Undo failed and recovery is required for: ${failedCompensation.map((entry) => entry.file.path).join(', ')}`);
      }
      throw error;
    } finally {
      this.recoveryStore.busy = false;
    }
  }

  async retryRecovery(): Promise<void> {
    if (this.recoveryStore.busy) throw new Error('A dashboard delete operation is already running.');
    const recovery = this.recoveryStore.recoveryState;
    if (!recovery) return;
    this.recoveryStore.busy = true;
    try {
      while (recovery.entries.length > 0) {
        const entry = recovery.entries[0];
        if (!entry) break;
        await compareAndSwap(this.app, entry.file, entry.expected, entry.replacement);
        recovery.entries.shift();
      }
      this.recoveryStore.recoveryState = null;
    } finally {
      this.recoveryStore.busy = false;
    }
  }
}

export class DashboardDailyBulkDeleteConfirmModal extends Modal {
  private inFlight = false;
  private committed = false;
  private keydownHandler: ((event: KeyboardEvent) => void) | null = null;

  constructor(
    app: App,
    private readonly plan: DashboardDeletePlan,
    private readonly invokingElement: HTMLElement | null,
    private readonly onConfirm: () => Promise<void>,
    private readonly focusCommittedResult: () => void = () => undefined,
  ) { super(app); }

  onOpen(): void {
    this.modalEl.addClass('tm-dashboard-delete-confirm-modal');
    this.modalEl.setAttr('role', 'dialog');
    this.modalEl.setAttr('aria-modal', 'true');
    const titleId = `tm-dashboard-delete-title-${Date.now()}`;
    const summaryId = `${titleId}-summary`;
    this.titleEl.id = titleId;
    this.titleEl.setText(t('dashboard.delete.confirmTitle'));
    this.modalEl.setAttr('aria-labelledby', titleId);
    this.modalEl.setAttr('aria-describedby', summaryId);
    this.contentEl.empty();
    const summary = this.contentEl.createEl('p', { cls: 'tm-dashboard-delete-summary', text: dashboardDeleteConfirmationSummary(this.plan) });
    summary.id = summaryId;
    const status = this.contentEl.createDiv('tm-dashboard-delete-status');
    status.setAttr('role', 'status');
    status.setAttr('aria-live', 'assertive');
    status.tabIndex = -1;
    const actions = this.contentEl.createDiv('tm-dashboard-delete-actions');
    const cancel = actions.createEl('button', { text: t('modal.btn.cancel'), type: 'button' });
    const confirm = actions.createEl('button', { text: t('dashboard.delete.confirmAction'), cls: 'mod-warning', type: 'button' });
    cancel.addEventListener('click', () => this.close());
    confirm.addEventListener('click', () => {
      if (this.inFlight) return;
      this.inFlight = true;
      cancel.disabled = true;
      confirm.disabled = true;
      status.setText(t('dashboard.delete.deleting'));
      void this.onConfirm().then(() => {
        this.committed = true;
        this.close();
      }).catch((error: unknown) => {
        this.inFlight = false;
        cancel.disabled = false;
        confirm.disabled = false;
        status.setText(`Delete failed: ${error instanceof Error ? error.message : String(error)}`);
        status.focus();
      });
    });
    this.keydownHandler = (event) => {
      if (event.key !== 'Escape' || this.inFlight) return;
      event.preventDefault();
      event.stopPropagation();
      this.close();
    };
    this.contentEl.addEventListener('keydown', this.keydownHandler);
    window.setTimeout(() => cancel.focus(), 0);
  }

  onClose(): void {
    if (this.keydownHandler) this.contentEl.removeEventListener('keydown', this.keydownHandler);
    this.keydownHandler = null;
    this.contentEl.empty();
    if (this.committed) {
      window.setTimeout(() => this.focusCommittedResult(), 0);
    } else if (this.invokingElement?.isConnected !== false) {
      this.invokingElement?.focus();
    }
  }
}

export function showDashboardDeletePlanningError(error: unknown): void {
  new Notice(`Task Manager: ${error instanceof Error ? error.message : String(error)}`);
}
