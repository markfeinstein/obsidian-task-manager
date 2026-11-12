import type { ParsedTask } from './task-scanner';
import { ExplicitIdIndex } from './task-identity';

export type TaskIndexReadiness = 'cold' | 'hydrating' | 'ready' | 'degraded';

export interface TaskIndexSnapshot {
  readonly revision: number;
  readonly readiness: TaskIndexReadiness;
  readonly tasks: readonly ParsedTask[];
  readonly byFile: ReadonlyMap<string, readonly ParsedTask[]>;
  /** Exact, case-sensitive explicit-ID resolution. Duplicate IDs are ambiguous. */
  readonly explicitIds: ExplicitIdIndex<ParsedTask>;
}

export interface TaskIndexChange {
  readonly revision: number;
  readonly changedPaths: readonly string[];
  readonly removedPaths: readonly string[];
  readonly snapshot: TaskIndexSnapshot;
}

export type TaskIndexSubscriber = (change: TaskIndexChange) => void;

class RuntimeReadonlyMap<K, V> implements ReadonlyMap<K, V> {
  constructor(private readonly source: ReadonlyMap<K, V>) {}
  get size(): number { return this.source.size; }
  get(key: K): V | undefined { return this.source.get(key); }
  has(key: K): boolean { return this.source.has(key); }
  entries(): MapIterator<[K, V]> { return this.source.entries(); }
  keys(): MapIterator<K> { return this.source.keys(); }
  values(): MapIterator<V> { return this.source.values(); }
  forEach(callbackfn: (value: V, key: K, map: ReadonlyMap<K, V>) => void, thisArg?: unknown): void {
    for (const [key, value] of this.source) callbackfn.call(thisArg, value, key, this);
  }
  [Symbol.iterator](): MapIterator<[K, V]> { return this.entries(); }
}

/**
 * Lifecycle-owned in-memory task index. It publishes immutable snapshots and
 * centralizes per-file cache ownership so API and UI consumers do not maintain
 * independent vault scanners.
 */
export class TaskIndex {
  private byFile: ReadonlyMap<string, readonly ParsedTask[]> = new Map();
  private subscribers = new Set<TaskIndexSubscriber>();
  private flatTasks: readonly ParsedTask[] | null = Object.freeze([] as ParsedTask[]);
  private explicitIds = new ExplicitIdIndex<ParsedTask>([]);
  private revision = 0;
  private readiness: TaskIndexReadiness = 'cold';
  private readyPromise!: Promise<void>;
  private resolveReady!: () => void;

  constructor() {
    this.resetReadyPromise();
  }

  getSnapshot(): TaskIndexSnapshot {
    const revision = this.revision;
    const readiness = this.readiness;
    const byFile = this.byFile;
    const explicitIds = this.explicitIds;
    let materialized = byFile === this.byFile ? this.flatTasks : null;
    const publishCurrentMaterialization = (tasks: readonly ParsedTask[]): void => {
      if (this.byFile === byFile && this.flatTasks === null) this.flatTasks = tasks;
    };
    return Object.freeze({
      revision,
      readiness,
      get tasks(): readonly ParsedTask[] {
        materialized ??= Object.freeze([...byFile.values()].flat());
        publishCurrentMaterialization(materialized);
        return materialized;
      },
      byFile: new RuntimeReadonlyMap(byFile),
      explicitIds,
    });
  }

  getAllTasks(): ParsedTask[] {
    return [...this.materializeTasks()];
  }

  /** Shared immutable task array for trusted internal consumers. */
  getInternalTasks(): readonly ParsedTask[] {
    return this.materializeTasks();
  }

  getTasksForFile(path: string): ParsedTask[] {
    return [...(this.byFile.get(path) ?? [])];
  }

  resolveExplicitId(id: string): ReturnType<ExplicitIdIndex<ParsedTask>['resolve']> {
    return this.explicitIds.resolve(id);
  }

  /** Internal immutable resolver; avoids copying the by-file map on hot scan paths. */
  getExplicitIds(): ExplicitIdIndex<ParsedTask> {
    return this.explicitIds;
  }

  getPaths(): string[] {
    return [...this.byFile.keys()];
  }

  hasFile(path: string): boolean {
    return this.byFile.has(path);
  }

  isReady(): boolean {
    return this.readiness === 'ready' || this.readiness === 'degraded';
  }

  whenReady(): Promise<void> {
    return this.readyPromise;
  }

  /**
   * Await first hydration, then require an exact healthy index for any operation
   * that can write local or remote state. Read-only UI may continue using the
   * degraded snapshot contract through whenReady().
   */
  async requireHealthySnapshot(): Promise<TaskIndexSnapshot> {
    await this.whenReady();
    const snapshot = this.getSnapshot();
    if (snapshot.readiness !== 'ready') {
      throw new Error('Task index is degraded; retry after a successful full scan');
    }
    return snapshot;
  }

  beginHydration(): void {
    if (this.readiness === 'cold') this.readiness = 'hydrating';
  }

  markReady(degraded = false): void {
    const wasReady = this.isReady();
    this.readiness = degraded ? 'degraded' : 'ready';
    if (!wasReady) this.resolveReady();
  }

  commit(
    replacements: ReadonlyMap<string, readonly ParsedTask[]>,
    removedPaths: readonly string[] = [],
  ): TaskIndexChange | null {
    const changed = new Set<string>();
    const removed = new Set<string>();
    let nextExplicitIds = this.explicitIds;
    const nextByFile = new Map(this.byFile);

    for (const prefix of removedPaths) {
      for (const path of [...nextByFile.keys()]) {
        if (path === prefix || path.startsWith(`${prefix}/`)) {
          nextByFile.delete(path);
          nextExplicitIds = nextExplicitIds.withPathReplacement(path, []);
          removed.add(path);
        }
      }
    }

    for (const [path, tasks] of replacements) {
      const previous = nextByFile.get(path);
      if (sameTaskArray(previous, tasks)) continue;
      const frozen = Object.freeze(tasks.map((task) => deepFrozenClone(task)));
      nextByFile.set(path, frozen);
      nextExplicitIds = nextExplicitIds.withPathReplacement(path, frozen);
      changed.add(path);
    }

    if (changed.size === 0 && removed.size === 0) return null;
    this.byFile = nextByFile;
    this.flatTasks = null;
    this.explicitIds = nextExplicitIds;
    this.revision += 1;
    const change: TaskIndexChange = Object.freeze({
      revision: this.revision,
      changedPaths: Object.freeze([...changed]),
      removedPaths: Object.freeze([...removed]),
      snapshot: this.getSnapshot(),
    });
    for (const subscriber of [...this.subscribers]) {
      try { subscriber(change); } catch { /* subscriber failures must not break publication */ }
    }
    return change;
  }

  removePath(path: string): TaskIndexChange | null {
    return this.commit(new Map(), [path]);
  }

  subscribe(subscriber: TaskIndexSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => { this.subscribers.delete(subscriber); };
  }

  dispose(): void {
    this.subscribers.clear();
    this.byFile = new Map();
    this.flatTasks = Object.freeze([] as ParsedTask[]);
    this.explicitIds = new ExplicitIdIndex<ParsedTask>([]);
    this.resolveReady();
    this.readiness = 'cold';
    this.resetReadyPromise();
  }

  private materializeTasks(): readonly ParsedTask[] {
    this.flatTasks ??= Object.freeze([...this.byFile.values()].flat());
    return this.flatTasks;
  }

  private resetReadyPromise(): void {
    this.readyPromise = new Promise<void>((resolve) => { this.resolveReady = resolve; });
  }
}

function sameTaskArray(left: readonly ParsedTask[] | undefined, right: readonly ParsedTask[]): boolean {
  if (!left || left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    if (canonicalJson(left[index]) !== canonicalJson(right[index])) return false;
  }
  return true;
}

function deepFrozenClone<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze((value as unknown[]).map((entry) => deepFrozenClone(entry))) as T;
  if (value && typeof value === 'object') {
    const clone: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) clone[key] = deepFrozenClone(entry);
    return Object.freeze(clone) as T;
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as Record<string, unknown>).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'undefined';
}
