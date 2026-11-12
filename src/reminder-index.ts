import { sourceLineIdentity } from './task-model';
import type { ParsedTask } from './task-scanner';
import type { TaskIndex, TaskIndexChange } from './task-index';
import { isValidIsoDate } from './date-utils';

export interface IndexedReminder { key: string; task: ParsedTask; fireTime: string }

/** Opaque evidence for one leased due reminder. Only an exact current claim may be acknowledged or retried. */
export interface DueReminderClaim extends IndexedReminder { readonly version: number }

interface HeapNode { key: string; fireTime: string; version: number }

function normalizeReminderTime(value: string): string {
  return value.replace(/T(?=\d{1,2}:\d{2}$)/u, ' ').replace(/ (\d):(\d{2})$/u, ' 0$1:$2');
}

export function reminderIdentityKey(task: ParsedTask): string | null {
  const reminder = task.metadata.reminder && normalizeReminderTime(task.metadata.reminder);
  if (!reminder) return null;
  const id = task.metadata.id?.trim();
  return id
    ? `v2\0id\0${id}\0${reminder}`
    : `v2\0line\0${task.filePath}\0${sourceLineIdentity(task.rawLine)}\0${reminder}`;
}

/** Revision-fed reminder projection with duplicate-safe identities and a lazy-invalidated min-heap. */
export class ReminderIndex {
  private readonly entries = new Map<string, IndexedReminder & { version: number }>();
  private readonly keysByPath = new Map<string, Set<string>>();
  private readonly explicitIdsByPath = new Map<string, Set<string>>();
  private readonly heap: HeapNode[] = [];
  private readonly inFlight = new Map<string, HeapNode>();
  private version = 0;
  private readonly unsubscribe: () => void;

  constructor(private readonly taskIndex: TaskIndex) {
    if (taskIndex.getSnapshot().readiness !== 'ready') throw new Error('ReminderIndex requires a fully ready TaskIndex');
    this.unsubscribe = taskIndex.subscribe((change) => this.apply(change));
    this.rebuild(taskIndex.getSnapshot().tasks);
  }

  /** Lease each currently-due identity. A leased node is not consumed until ackDue(). */
  claimDue(now: string): readonly DueReminderClaim[] {
    const claims: DueReminderClaim[] = [];
    while (this.heap.length > 0 && this.heap[0].fireTime <= now) {
      const node = this.popHeap();
      const current = this.entries.get(node.key);
      if (!current || current.version !== node.version || current.fireTime !== node.fireTime) continue;
      if (this.inFlight.has(node.key)) continue;
      this.inFlight.set(node.key, node);
      claims.push(Object.freeze({ key: current.key, task: current.task, fireTime: current.fireTime, version: current.version }));
    }
    return claims;
  }

  /** Permanently consume exact claims after their state mutation has committed. */
  ackDue(claims: readonly DueReminderClaim[]): void {
    for (const claim of claims) {
      if (this.claimMatches(this.inFlight.get(claim.key), claim)) this.inFlight.delete(claim.key);
    }
  }

  /** Release exact claims after an aborted transaction, without resurrecting revised entries. */
  retryDue(claims: readonly DueReminderClaim[]): void {
    for (const claim of claims) {
      const inFlight = this.inFlight.get(claim.key);
      if (!this.claimMatches(inFlight, claim)) continue;
      this.inFlight.delete(claim.key);
      const current = this.entries.get(claim.key);
      if (current && current.version === claim.version && current.fireTime === claim.fireTime) {
        this.pushHeap({ key: claim.key, version: claim.version, fireTime: claim.fireTime });
      }
    }
  }

  resolve(key: string): IndexedReminder | undefined {
    const value = this.entries.get(key);
    return value ? { key: value.key, task: value.task, fireTime: value.fireTime } : undefined;
  }

  /** Convert a legacy path:line:reminder key when one current task is provable. */
  migrateLegacyKey(key: string): string | undefined {
    if (key.startsWith('v2\0')) {
      const normalized = normalizeReminderTime(key);
      return this.entries.has(normalized) ? normalized : undefined;
    }
    const match = key.match(/^(.*):(\d+):(\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?)$/u);
    if (!match) return undefined;
    const [, path, lineText, reminder] = match;
    const line = Number.parseInt(lineText, 10);
    const tasks = this.taskIndex.getTasksForFile(path).filter((task) => task.metadata.reminder !== undefined && normalizeReminderTime(task.metadata.reminder) === normalizeReminderTime(reminder) && task.status !== 'done' && task.status !== 'cancelled');
    const atLine = tasks.filter((task) => task.lineNumber === line);
    const candidates = atLine.length === 1 ? atLine : tasks.length === 1 ? tasks : [];
    return candidates.length === 1 ? reminderIdentityKey(candidates[0]) ?? undefined : undefined;
  }

  keyForStoredRecord(record: { reminderKey: string; taskFilePath: string; taskLineNumber: number; taskText: string; originalReminderTime?: string; reminderTime?: string }): string | undefined {
    const normalizedKey = normalizeReminderTime(record.reminderKey);
    if (normalizedKey.startsWith('v2\0') && this.entries.has(normalizedKey)) return normalizedKey;
    const reminder = record.originalReminderTime ?? record.reminderTime ?? record.reminderKey.match(/(\d{4}-\d{2}-\d{2}(?:[ T]\d{1,2}:\d{2})?)$/u)?.[1];
    if (!reminder) return undefined;
    const tasks = this.taskIndex.getTasksForFile(record.taskFilePath)
      .filter((task) => task.metadata.reminder !== undefined && normalizeReminderTime(task.metadata.reminder) === normalizeReminderTime(reminder) && task.status !== 'done' && task.status !== 'cancelled');
    const exact = tasks.filter((task) => task.lineNumber === record.taskLineNumber);
    if (exact.length === 1) return reminderIdentityKey(exact[0]) ?? undefined;
    const expectedIdentity = sourceLineIdentity(record.taskText);
    const relocated = tasks.filter((task) => sourceLineIdentity(task.rawLine) === expectedIdentity);
    if (relocated.length === 1) return reminderIdentityKey(relocated[0]) ?? undefined;
    return tasks.length === 1 ? reminderIdentityKey(tasks[0]) ?? undefined : undefined;
  }

  dispose(): void {
    this.unsubscribe();
    this.entries.clear();
    this.keysByPath.clear();
    this.explicitIdsByPath.clear();
    this.heap.length = 0;
    this.inFlight.clear();
  }

  private apply(change: TaskIndexChange): void {
    const affectedIds = new Set<string>();
    for (const path of [...change.changedPaths, ...change.removedPaths]) {
      for (const id of this.explicitIdsByPath.get(path) ?? []) affectedIds.add(id);
      this.removePath(path);
    }
    for (const path of change.changedPaths) {
      const tasks = change.snapshot.byFile.get(path) ?? [];
      const ids = new Set(tasks.map((task) => task.metadata.id?.trim()).filter((id): id is string => Boolean(id)));
      this.explicitIdsByPath.set(path, ids);
      for (const id of ids) affectedIds.add(id);
      this.addFallbackTasks(path, tasks);
    }
    for (const id of affectedIds) this.reconcileExplicitId(id, change.snapshot.explicitIds);
    if (this.heap.length > this.entries.size * 2 + 64) {
      const live = this.heap.filter((node) => this.entries.get(node.key)?.version === node.version && !this.inFlight.has(node.key));
      this.heap.length = 0;
      for (const node of live) this.pushHeap(node);
    }
  }

  private rebuild(tasks: readonly ParsedTask[]): void {
    this.entries.clear();
    this.keysByPath.clear();
    this.explicitIdsByPath.clear();
    this.heap.length = 0;
    this.inFlight.clear();
    const grouped = new Map<string, ParsedTask[]>();
    for (const task of tasks) {
      const values = grouped.get(task.filePath) ?? [];
      values.push(task);
      grouped.set(task.filePath, values);
    }
    for (const [path, values] of grouped) {
      const ids = new Set(values.map((task) => task.metadata.id?.trim()).filter((id): id is string => Boolean(id)));
      this.explicitIdsByPath.set(path, ids);
      this.addFallbackTasks(path, values);
    }
    const explicitIds = this.taskIndex.getSnapshot().explicitIds;
    for (const id of explicitIds.ids()) this.reconcileExplicitId(id, explicitIds);
  }

  private addFallbackTasks(path: string, tasks: readonly ParsedTask[]): void {
    const candidates = tasks.filter((task) => !task.metadata.id?.trim() && this.isSchedulable(task));
    const counts = new Map<string, number>();
    for (const task of candidates) {
      const key = reminderIdentityKey(task);
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const task of candidates) {
      const key = reminderIdentityKey(task);
      if (key && counts.get(key) === 1) this.addEntry(key, task);
    }
    if (!this.keysByPath.has(path)) this.keysByPath.set(path, new Set());
  }

  private reconcileExplicitId(id: string, explicitIds: ReturnType<TaskIndex['getSnapshot']>['explicitIds']): void {
    const prefix = `v2\0id\0${id}\0`;
    for (const key of [...this.entries.keys()]) if (key.startsWith(prefix)) this.removeEntry(key);
    const resolution = explicitIds.resolve(id);
    if (resolution.kind !== 'unique' || !this.isSchedulable(resolution.task)) return;
    const key = reminderIdentityKey(resolution.task);
    if (key) this.addEntry(key, resolution.task);
  }

  private isSchedulable(task: ParsedTask): boolean {
    if (task.status === 'done' || task.status === 'cancelled') return false;
    const match = task.metadata.reminder?.match(/^(\d{4}-\d{2}-\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/u);
    if (!match || !isValidIsoDate(match[1])) return false;
    if (match[2] === undefined) return true;
    const hour = Number.parseInt(match[2], 10);
    const minute = Number.parseInt(match[3], 10);
    return hour >= 0 && hour < 24 && minute >= 0 && minute < 60;
  }

  private addEntry(key: string, task: ParsedTask): void {
    const reminder = task.metadata.reminder;
    if (!reminder) return;
    this.removeEntry(key);
    const fireTime = reminder.length === 10 ? `${reminder} 09:00` : normalizeReminderTime(reminder);
    const version = ++this.version;
    this.entries.set(key, { key, task, fireTime, version });
    const pathKeys = this.keysByPath.get(task.filePath) ?? new Set<string>();
    pathKeys.add(key);
    this.keysByPath.set(task.filePath, pathKeys);
    this.pushHeap({ key, fireTime, version });
  }

  private removeEntry(key: string): void {
    const existing = this.entries.get(key);
    if (!existing) return;
    this.entries.delete(key);
    this.inFlight.delete(key);
    const keys = this.keysByPath.get(existing.task.filePath);
    keys?.delete(key);
    if (keys?.size === 0) this.keysByPath.delete(existing.task.filePath);
  }

  private removePath(path: string): void {
    for (const key of [...(this.keysByPath.get(path) ?? [])]) this.removeEntry(key);
    this.keysByPath.delete(path);
    this.explicitIdsByPath.delete(path);
  }

  private claimMatches(node: HeapNode | undefined, claim: DueReminderClaim): boolean {
    return Boolean(node && node.key === claim.key && node.version === claim.version && node.fireTime === claim.fireTime);
  }

  private pushHeap(node: HeapNode): void {
    this.heap.push(node);
    let index = this.heap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (compareNodes(this.heap[parent], this.heap[index]) <= 0) break;
      [this.heap[parent], this.heap[index]] = [this.heap[index], this.heap[parent]];
      index = parent;
    }
  }

  private popHeap(): HeapNode {
    const first = this.heap[0];
    const last = this.heap.pop();
    if (this.heap.length > 0 && last) {
      this.heap[0] = last;
      let index = 0;
      while (true) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < this.heap.length && compareNodes(this.heap[left], this.heap[smallest]) < 0) smallest = left;
        if (right < this.heap.length && compareNodes(this.heap[right], this.heap[smallest]) < 0) smallest = right;
        if (smallest === index) break;
        [this.heap[index], this.heap[smallest]] = [this.heap[smallest], this.heap[index]];
        index = smallest;
      }
    }
    return first;
  }
}

function compareNodes(left: HeapNode, right: HeapNode): number {
  return left.fireTime.localeCompare(right.fireTime) || left.key.localeCompare(right.key) || left.version - right.version;
}
