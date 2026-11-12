export const QUERY_RESULT_PAGE_SIZE = 100;
export const QUERY_RESULT_PAGE_SIZES = Object.freeze([50, 100, 200] as const);
export const QUERY_RESULT_SAFETY_CEILING = 1000;

/** Stateful, key-based paging policy for one rendered query container. */
export class QueryResultPagingSession {
  private orderedKeys: readonly string[] = Object.freeze([]);
  private pageIndex = 0;
  private pageSize = QUERY_RESULT_PAGE_SIZE;
  readonly selectedKeys = new Set<string>();
  focusedKey: string | null = null;

  update(keys: readonly string[]): void {
    this.orderedKeys = Object.freeze([...keys]);
    const live = new Set(keys);
    for (const key of this.selectedKeys) if (!live.has(key)) this.selectedKeys.delete(key);
    if (this.focusedKey && !live.has(this.focusedKey)) this.focusedKey = null;
    this.pageIndex = Math.min(this.pageIndex, this.pageCount - 1);
  }

  get total(): number { return this.orderedKeys.length; }
  get currentPage(): number { return this.pageIndex; }
  get currentPageSize(): number { return this.pageSize; }
  get pageCount(): number { return Math.max(1, Math.ceil(this.total / this.pageSize)); }
  get start(): number { return this.total === 0 ? 0 : this.pageIndex * this.pageSize; }
  get end(): number { return Math.min(this.total, this.start + this.pageSize); }
  get canGoPrevious(): boolean { return this.pageIndex > 0; }
  get canGoNext(): boolean { return this.pageIndex < this.pageCount - 1; }

  previous(): boolean {
    if (!this.canGoPrevious) return false;
    this.pageIndex -= 1;
    return true;
  }

  next(): boolean {
    if (!this.canGoNext) return false;
    this.pageIndex += 1;
    return true;
  }

  setPageSize(size: number): boolean {
    if (!(QUERY_RESULT_PAGE_SIZES as readonly number[]).includes(size) || size === this.pageSize) return false;
    const previousStart = this.start;
    this.pageSize = size;
    this.pageIndex = Math.min(Math.floor(previousStart / size), this.pageCount - 1);
    return true;
  }

  visible<T>(items: readonly T[]): T[] {
    return items.slice(this.start, this.end);
  }
}

const sessions = new WeakMap<HTMLElement, QueryResultPagingSession>();

export function queryPagingSessionFor(container: HTMLElement): QueryResultPagingSession {
  let session = sessions.get(container);
  if (!session) {
    session = new QueryResultPagingSession();
    sessions.set(container, session);
  }
  return session;
}
