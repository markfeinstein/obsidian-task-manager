import type { MarkdownTask } from './task-model';

/** Canonical, vault-wide identity for an explicit task ID. IDs are case-sensitive. */
export function explicitTaskKey(rawId: string): string {
  return `id:${rawId.trim()}`;
}

/** The path-coupled explicit-ID key emitted before state version 2. */
export function legacyExplicitTaskKey(filePath: string, rawId: string): string {
  return `${filePath}:id:${rawId.trim()}`;
}

/** Parse a pre-v2 path-coupled explicit-ID key for a particular exact ID. */
export function isLegacyExplicitTaskKey(key: string, rawId: string): boolean {
  const suffix = `:id:${rawId.trim()}`;
  return key.length > suffix.length && key.endsWith(suffix) && !key.startsWith('id:');
}

/** A location-only key for UI/DOM maps. It is never a durable task identity. */
export function taskLocationKey(task: Pick<MarkdownTask, 'filePath' | 'lineNumber'>): string {
  return `${task.filePath}\u0000${task.lineNumber}`;
}

export type ExplicitIdResolution<T> =
  | { kind: 'missing'; id: string; matches: readonly [] }
  | { kind: 'unique'; id: string; task: T; matches: readonly [T] }
  | { kind: 'ambiguous'; id: string; matches: readonly T[] };

/**
 * Deterministic zero/one/many explicit-ID index. Resolution never selects the
 * first duplicate. Match order is stable by location, independent of scan order.
 */
export class ExplicitIdIndex<T extends Pick<MarkdownTask, 'metadata' | 'filePath' | 'lineNumber'>> {
  private readonly buckets: Map<string, readonly T[]>;
  private readonly idsByPath: Map<string, readonly string[]>;

  constructor(
    tasks: readonly T[],
    prepared?: { buckets: Map<string, readonly T[]>; idsByPath: Map<string, readonly string[]> },
  ) {
    if (prepared) {
      this.buckets = prepared.buckets;
      this.idsByPath = prepared.idsByPath;
      return;
    }
    this.buckets = new Map();
    this.idsByPath = new Map();
    const mutable = new Map<string, T[]>();
    const pathIds = new Map<string, Set<string>>();
    for (const task of tasks) {
      const id = task.metadata.id?.trim();
      if (!id) continue;
      const bucket = mutable.get(id) ?? [];
      bucket.push(task);
      mutable.set(id, bucket);
      const ids = pathIds.get(task.filePath) ?? new Set<string>();
      ids.add(id);
      pathIds.set(task.filePath, ids);
    }
    for (const [id, bucket] of mutable) this.buckets.set(id, Object.freeze([...bucket].sort(compareTaskLocations)));
    for (const [path, ids] of pathIds) this.idsByPath.set(path, Object.freeze([...ids]));
  }

  withPathReplacement(path: string, tasks: readonly T[]): ExplicitIdIndex<T> {
    const buckets = new Map(this.buckets);
    const idsByPath = new Map(this.idsByPath);
    for (const id of this.idsByPath.get(path) ?? []) {
      const retained = (buckets.get(id) ?? []).filter((task) => task.filePath !== path);
      if (retained.length > 0) buckets.set(id, Object.freeze(retained));
      else buckets.delete(id);
    }
    const replacements = new Map<string, T[]>();
    for (const task of tasks) {
      const id = task.metadata.id?.trim();
      if (!id) continue;
      const bucket = replacements.get(id) ?? [];
      bucket.push(task);
      replacements.set(id, bucket);
    }
    for (const [id, additions] of replacements) {
      buckets.set(id, Object.freeze([...(buckets.get(id) ?? []), ...additions].sort(compareTaskLocations)));
    }
    if (replacements.size > 0) idsByPath.set(path, Object.freeze([...replacements.keys()]));
    else idsByPath.delete(path);
    return new ExplicitIdIndex([], { buckets, idsByPath });
  }

  resolve(rawId: string): ExplicitIdResolution<T> {
    const id = rawId.trim();
    const matches = this.buckets.get(id) ?? [];
    if (matches.length === 0) return { kind: 'missing', id, matches: [] };
    if (matches.length === 1) return { kind: 'unique', id, task: matches[0], matches: matches as readonly [T] };
    return { kind: 'ambiguous', id, matches };
  }

  unique(rawId: string): T | undefined {
    const resolution = this.resolve(rawId);
    return resolution.kind === 'unique' ? resolution.task : undefined;
  }

  conflicts(): ReadonlyMap<string, readonly T[]> {
    return new Map([...this.buckets].filter(([, matches]) => matches.length > 1));
  }

  ids(): readonly string[] {
    return Object.freeze([...this.buckets.keys()].sort());
  }
}

function compareTaskLocations(left: Pick<MarkdownTask, 'filePath' | 'lineNumber'>, right: Pick<MarkdownTask, 'filePath' | 'lineNumber'>): number {
  return String(left.filePath ?? '').localeCompare(String(right.filePath ?? '')) || Number(left.lineNumber ?? 0) - Number(right.lineNumber ?? 0);
}
