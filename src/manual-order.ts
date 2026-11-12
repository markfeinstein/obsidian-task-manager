/**
 * manual-order.ts
 *
 * Shared helpers for hand-arranged (drag-to-reorder) task lists. Manual position is persisted as a
 * Dataview inline field `[order:: N]` on the task line, so the ordering travels with the note across
 * devices and is visible in raw Markdown. The same primitives back the dashboard Agenda, the
 * `view: checklist` query view and the Daily Planning Assistant's "Today's plan" step.
 *
 * Design notes:
 *  - Order values are plain numbers and may be fractional, so a single drop usually rewrites just the
 *    moved task (midpoint between its new neighbours) instead of renumbering the whole list.
 *  - When neighbours have no order yet (e.g. the first drag in a view) the list is renumbered with a
 *    fixed gap so subsequent drags can keep using cheap midpoint writes.
 *  - A list is considered "manually arranged" when ANY visible task carries an order; clearing every
 *    order field reverts the view to its natural (date/priority) sort.
 */
import { TFile } from 'obsidian';
import type { App } from 'obsidian';
import type { ParsedTask, TaskScanner } from './task-scanner';
import type { TaskMutationService } from './task-mutation-service';
import { mutateRenderedTaskLinesInContent } from './task-mutation-resolver';

/** Gap between successive values when renumbering a whole list. */
export const MANUAL_ORDER_STEP = 100;

export function isManualOrderWritableTask(task: ParsedTask): boolean {
  return !task.filePath.endsWith('.canvas') && !task.key.startsWith(`${task.filePath}:canvas:`);
}

/** True when at least one task carries a manual `[order:: N]` position. */
export function hasManualOrder(tasks: readonly ParsedTask[]): boolean {
  return tasks.some((task) => task.metadata.manualOrder !== undefined);
}

/**
 * Comparator for hand-arranged lists: tasks with a manual order sort by it (ascending, then by the
 * natural fallback for ties); tasks without an order sink below the arranged ones, kept in fallback
 * order amongst themselves.
 */
export function compareManualOrder(
  a: ParsedTask,
  b: ParsedTask,
  fallback: (a: ParsedTask, b: ParsedTask) => number,
): number {
  const oa = a.metadata.manualOrder;
  const ob = b.metadata.manualOrder;
  if (oa !== undefined && ob !== undefined) return oa - ob || fallback(a, b);
  if (oa !== undefined) return -1;
  if (ob !== undefined) return 1;
  return fallback(a, b);
}

/** Return a copy of `tasks` sorted by manual order when present, else purely by `fallback`. */
export function sortTasksWithManualOrder(
  tasks: readonly ParsedTask[],
  fallback: (a: ParsedTask, b: ParsedTask) => number,
): ParsedTask[] {
  if (!hasManualOrder(tasks)) return [...tasks].sort(fallback);
  return [...tasks].sort((a, b) => compareManualOrder(a, b, fallback));
}

/** Move an item from index `from` so it lands just before whatever currently sits at index `to`. */
export function applyRowMove<T>(items: readonly T[], from: number, to: number): T[] {
  const copy = [...items];
  if (from < 0 || from >= copy.length || to < 0 || to >= copy.length || from === to) return copy;
  const [moved] = copy.splice(from, 1);
  const dest = from < to ? to - 1 : to;
  copy.splice(dest, 0, moved);
  return copy;
}

export interface ManualOrderWrite {
  key: string;
  /** New order value, or null to remove the field (revert to natural sort). */
  order: number | null;
}

/**
 * Compute the minimal set of `[order:: N]` writes for a drag move. `keysAfter` is the list of task
 * keys AFTER the move (see {@link applyRowMove}); `movedKey` is the task that was dragged. Returns a
 * single midpoint write in the common case, or a full renumber when neighbour orders are missing.
 */
export function planManualReorder(
  keysAfter: readonly string[],
  movedKey: string,
  orderOf: (key: string) => number | undefined,
): ManualOrderWrite[] {
  const d = keysAfter.indexOf(movedKey);
  if (d < 0) return [];
  if (keysAfter.length === 1) return [{ key: movedKey, order: MANUAL_ORDER_STEP }];

  const prevKey = d > 0 ? keysAfter[d - 1] : undefined;
  const nextKey = d < keysAfter.length - 1 ? keysAfter[d + 1] : undefined;
  const prev = prevKey ? orderOf(prevKey) : undefined;
  const next = nextKey ? orderOf(nextKey) : undefined;

  if (!prevKey && next !== undefined) return [{ key: movedKey, order: next - MANUAL_ORDER_STEP }];
  if (!nextKey && prev !== undefined) return [{ key: movedKey, order: prev + MANUAL_ORDER_STEP }];
  if (prev !== undefined && next !== undefined && next - prev > 1e-4) {
    return [{ key: movedKey, order: (prev + next) / 2 }];
  }

  // Neighbours lack usable orders (first drag in this view, or a degenerate gap) — renumber the
  // whole arrangement so future drags can use cheap midpoint writes.
  return keysAfter.map((key, index) => ({ key, order: (index + 1) * MANUAL_ORDER_STEP }));
}

/** Format an order value compactly: integers stay integers, fractions are capped to 3 decimals. */
function formatOrderValue(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 1000) / 1000);
}

const ORDER_FIELD_RE = /\s*\[order::\s*-?\d+(?:\.\d+)?\s*\]/giu;

/**
 * Set, replace or (value === null) remove the `[order:: N]` inline field on a single task line,
 * preserving a trailing block link (`^id`) at the very end of the line.
 */
export function setOrderFieldOnLine(line: string, value: number | null): string {
  const stripped = line.replace(ORDER_FIELD_RE, '');
  if (value === null) return stripped.replace(/[ \t]+$/u, '');

  const formatted = formatOrderValue(value);
  const blockLink = stripped.match(/(\s+\^[A-Za-z0-9-]+)[ \t]*$/u);
  if (blockLink) {
    const idx = stripped.lastIndexOf(blockLink[1]);
    return `${stripped.slice(0, idx).replace(/[ \t]+$/u, '')} [order:: ${formatted}]${stripped.slice(idx)}`;
  }
  return `${stripped.replace(/[ \t]+$/u, '')} [order:: ${formatted}]`;
}

/**
 * Apply order-field writes grouped by file. Every rendered task is revalidated in
 * the current file and uniquely relocated when preceding lines have moved.
 */
export async function applyManualOrderWrites(
  app: App,
  writes: readonly ManualOrderWrite[],
  taskByKey: ReadonlyMap<string, ParsedTask>,
  taskMutations?: TaskMutationService,
  scanner?: TaskScanner,
): Promise<void> {
  const byFile = new Map<string, ManualOrderWrite[]>();
  for (const write of writes) {
    const task = taskByKey.get(write.key);
    if (!task) continue;
    if (!isManualOrderWritableTask(task)) throw new Error('Canvas tasks are read-only for manual ordering.');
    const bucket = byFile.get(task.filePath) ?? [];
    bucket.push(write);
    byFile.set(task.filePath, bucket);
  }

  for (const [path, fileWrites] of byFile) {
    const file = app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) continue;
    const updates = fileWrites.flatMap((write) => {
      const task = taskByKey.get(write.key);
      return task ? [{ task, order: write.order }] : [];
    });
    if (taskMutations) {
      await taskMutations.updateTaskManualOrders(file, updates);
      continue;
    }
    if (!scanner) throw new Error('Task mutation service or identity-aware scanner is required for manual-order writes');
    await app.vault.process(file, (content: string) => mutateRenderedTaskLinesInContent(
      content,
      updates.map(({ task, order }) => ({ task, rewrite: (line: string) => setOrderFieldOnLine(line, order) })),
      (line, filePath, lineNumber, heading) => scanner.parseTaskLine(line, filePath, lineNumber, heading),
    ).content);
  }
}

/**
 * Wire native HTML drag-and-drop onto a set of sibling row elements. Calls `onDrop(from, to)` with
 * the original indices when a row is dropped onto another. Adds `tm-drag-source`/`tm-drag-over`
 * classes for styling. Returns nothing; listeners live for the lifetime of the elements.
 */
export function attachManualDrag(
  rows: readonly HTMLElement[],
  onDrop: (from: number, to: number) => void,
): void {
  let srcIdx: number | null = null;
  rows.forEach((row, index) => {
    row.setAttr('draggable', 'true');
    row.addEventListener('dragstart', (event: DragEvent) => {
      srcIdx = index;
      row.addClass('tm-drag-source');
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', String(index));
      }
    });
    row.addEventListener('dragend', () => {
      srcIdx = null;
      row.removeClass('tm-drag-source');
      for (const other of rows) other.removeClass('tm-drag-over');
    });
    row.addEventListener('dragover', (event: DragEvent) => {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
      if (srcIdx !== null && srcIdx !== index) row.addClass('tm-drag-over');
    });
    row.addEventListener('dragleave', (event: DragEvent) => {
      const related = event.relatedTarget as Node | null;
      if (related && row.contains(related)) return;
      row.removeClass('tm-drag-over');
    });
    row.addEventListener('drop', (event: DragEvent) => {
      event.preventDefault();
      row.removeClass('tm-drag-over');
      if (srcIdx === null || srcIdx === index) return;
      const from = srcIdx;
      srcIdx = null;
      onDrop(from, index);
    });
  });
}
