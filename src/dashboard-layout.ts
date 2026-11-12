import { Platform } from 'obsidian';
import type {
  DashboardGridPlacement,
  DashboardWidgetConfig,
  DashboardWidgetPosition,
  DashboardWidgetPresentation,
  DashboardWidgetSize,
} from './types';

/**
 * Pure dashboard sizing and placement model. The live Dashboard view owns DOM,
 * persistence, and widget rendering; this module owns deterministic layout
 * calculations so migration and interaction tests do not instantiate the view.
 */
// ── Widget size model ───────────────────────────────────────────────────────

export const DASHBOARD_WIDGET_SIZES: DashboardWidgetSize[] = ['small', 'medium', 'large'];

export type DashboardTemplateTone = 'daily' | 'focus' | 'planning' | 'review' | 'analytics' | 'project' | 'team' | 'custom';

export function normalizeDashboardWidgetSize(value: unknown): DashboardWidgetSize {
  return value === 'small' || value === 'medium' || value === 'large' ? value : 'medium';
}

export function normalizeDashboardWidgetPresentation(value: unknown): DashboardWidgetPresentation | undefined {
  return value === 'hero' || value === 'kpi' || value === 'standard' ? value : undefined;
}

export function cycleDashboardWidgetSize(size: DashboardWidgetSize): DashboardWidgetSize {
  const index = DASHBOARD_WIDGET_SIZES.indexOf(size);
  return DASHBOARD_WIDGET_SIZES[(index + 1) % DASHBOARD_WIDGET_SIZES.length];
}

/** How many list rows a card of a given size should render before truncating. */
export function dashboardRowLimit(size: DashboardWidgetSize): number {
  return size === 'small' ? 4 : size === 'large' ? 12 : 7;
}

// ── Snap-grid model ─────────────────────────────────────────────────────────

/** Number of columns in the dashboard snap grid. Rows grow on demand. */
export const DASHBOARD_GRID_COLUMNS = 96;
/**
 * The default layout and built-in templates are authored on a coarse 12-column grid for
 * readability, then scaled up to the fine runtime grid. An 8× scale yields eighth-cell snap
 * increments so widgets resize in very small steps (both horizontally and vertically). Because the
 * fine grid packs many columns into the available width, the inter-widget gap is kept small (see
 * `--tm-dash-gap` in styles.css) — a larger gap would not leave room for the columns to render.
 */
export const DASHBOARD_TEMPLATE_BASE_COLUMNS = 12;
export const DASHBOARD_GRID_SCALE = DASHBOARD_GRID_COLUMNS / DASHBOARD_TEMPLATE_BASE_COLUMNS;
/**
 * At or below this content width (CSS px) the grid abandons proportional column scaling and stacks
 * every widget into a single full-width column with content-driven heights. Phones (where the
 * Obsidian pane is ~390–430px) always stack regardless of width; this threshold also catches narrow
 * desktop/tablet splits so a squeezed pane reads as a clean vertical feed instead of slivered cards.
 */
export const DASHBOARD_STACK_MAX_WIDTH = 540;
/**
 * Tablets have enough room for richer cards, but not enough for the authored three-column
 * dashboard rail layout in portrait / split-screen panes. Keep phones on the normal narrow-pane
 * threshold and let tablets use the stacked feed until a genuinely wide landscape pane is present.
 */
export const DASHBOARD_TABLET_STACK_MAX_WIDTH = 900;

/** Whether the dashboard should drop to a single stacked column for the given pane width. */
export function shouldStackDashboard(width: number): boolean {
  const measured = Number.isFinite(width) && width > 0;
  if (Platform?.isPhone) return true;
  if (Platform?.isTablet && measured && width <= DASHBOARD_TABLET_STACK_MAX_WIDTH) return true;
  return measured && width <= DASHBOARD_STACK_MAX_WIDTH;
}
/** Rows a collapsed card reserves — just enough to fit the header without leaving a tall gap. */
export const DASHBOARD_COLLAPSED_SPAN = 5;

export function dashboardEffectiveGridRowSpan(collapsed: boolean, expandedSpan: number): number {
  return collapsed ? DASHBOARD_COLLAPSED_SPAN : expandedSpan;
}
/**
 * Minimum widget footprint, in grid cells. Kept small (2 cells) so the fine grid allows precise
 * sizing — users can shrink a widget right down when they want to. Not tied to the grid scale on
 * purpose: a larger minimum would clamp away the precision the fine grid exists to provide.
 */
export const DASHBOARD_MIN_W = 2;
export const DASHBOARD_MIN_H = 2;

/**
 * Maximum width, in CSS pixels, that a content-light side rail (left/right column) is allowed to
 * occupy before the auto-fit pass hands its slack to the primary (middle) column. The rails hold
 * compact widgets — KPI tiles, action buttons, short lists — that look marooned in a 25%-wide column
 * on a large monitor, whereas the middle column carries the long wrapping task lists that always want
 * more room. This is a comfort ceiling, not a hard width: on a narrow pane the rails are already
 * below it and nothing moves.
 *
 * Sized so the default Command center left rail (Quick actions + Summary) keeps enough width for its
 * widget titles and stat tiles to lay out on one line instead of collapsing into a sliver that wraps
 * every label and spills into an inner scrollbar. A previous 400px ceiling squeezed those cards on
 * wide monitors; 520px gives the capture/summary widgets room while still handing genuinely excess
 * width to the Agenda.
 */
export const DASHBOARD_RAIL_MAX_PX = 520;

/**
 * Minimum (comfort floor) width, in CSS pixels, for a content-bearing side rail. Complement to
 * {@link DASHBOARD_RAIL_MAX_PX}: where the ceiling stops a sparse rail from sprawling on a wide pane,
 * the floor stops the rail from collapsing into an unusable sliver (which crushed the Command center
 * capture/summary widget titles down to a single wrapped character). The auto-fit pass widens any
 * rail narrower than this by pulling tracks from the primary column, so the rail always lands in the
 * [floor, ceiling] band. Like the ceiling it is a render-time comfort rule, so it self-heals saved
 * layouts (including customized ones) without rewriting their stored grid.
 */
export const DASHBOARD_RAIL_MIN_PX = 320;

/** Default grid footprint (w × h, in cells) for each legacy size bucket. */
export function gridFootprintForSize(size: DashboardWidgetSize): { w: number; h: number } {
  const s = DASHBOARD_GRID_SCALE;
  if (size === 'small') return { w: 3 * s, h: 2 * s };
  if (size === 'large') return { w: 6 * s, h: 4 * s };
  return { w: 4 * s, h: 3 * s };
}

/** Derive a legacy size bucket from a grid footprint (keeps `config.size` meaningful). */
export function sizeFromGridFootprint(w: number, h: number): DashboardWidgetSize {
  const area = Math.max(1, w) * Math.max(1, h);
  const s = DASHBOARD_GRID_SCALE;
  if (w >= 6 * s || area >= 18 * s * s) return 'large';
  if (w >= 4 * s || area >= 8 * s * s) return 'medium';
  return 'small';
}

/** How many list rows to render for a widget, scaled by its grid height when available. */
export function dashboardWidgetRowLimit(config: DashboardWidgetConfig, autoFit?: boolean): number {
  const h = config.grid?.h;
  if (config.type === 'today') {
    // Agenda is the dashboard's primary work surface. Let it scale farther than ordinary list cards:
    // a large, content-rich Agenda should use the available page height instead of truncating early.
    if (!autoFit && typeof h === 'number' && Number.isFinite(h)) return Math.max(5, Math.min(48, Math.round((h / DASHBOARD_GRID_SCALE) * 3.2 - 3)));
    const size = normalizeDashboardWidgetSize(config.size);
    return size === 'large' ? 28 : size === 'medium' ? 18 : 10;
  }
  if (config.type === 'focus-queue') {
    // The do-next list is a primary working surface. Let it spend extra vertical space on rows before
    // truncating so a tall card actually shows more todos instead of a large blank body.
    if (!autoFit && typeof h === 'number' && Number.isFinite(h)) return Math.max(4, Math.min(24, Math.round((h / DASHBOARD_GRID_SCALE) * 3.2 - 3)));
    return normalizeDashboardWidgetSize(config.size) === 'large' ? 16 : dashboardRowLimit(normalizeDashboardWidgetSize(config.size));
  }
  // In auto-fit mode the card height is DERIVED from content, so the row cap must NOT depend on `h`
  // (that would be circular: height→cap→content→height). Fall back to the stable size-based cap so the
  // content rendered is a function of data + authored size only, then the card is measured + sized to it.
  if (!autoFit && typeof h === 'number' && Number.isFinite(h)) return Math.max(2, Math.min(20, Math.round((h / DASHBOARD_GRID_SCALE) * 2.5 - 2.7)));
  return dashboardRowLimit(normalizeDashboardWidgetSize(config.size));
}

/** Clamp a placement so it sits inside the column range with a valid minimum span. */
export function clampGridPlacement(placement: DashboardGridPlacement, cols: number = DASHBOARD_GRID_COLUMNS): DashboardGridPlacement {
  const w = Math.max(DASHBOARD_MIN_W, Math.min(cols, Math.round(placement.w) || DASHBOARD_MIN_W));
  const h = Math.max(DASHBOARD_MIN_H, Math.round(placement.h) || DASHBOARD_MIN_H);
  const x = Math.max(0, Math.min(cols - w, Math.round(placement.x) || 0));
  const y = Math.max(0, Math.round(placement.y) || 0);
  return { x, y, w, h };
}

/** True when two placements share at least one cell. */
export function gridPlacementsOverlap(a: DashboardGridPlacement, b: DashboardGridPlacement): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

/** First-fit (top-to-bottom, left-to-right) free slot for a `w × h` footprint. */
export function findFreeGridSlot(
  occupied: readonly DashboardGridPlacement[],
  w: number,
  h: number,
  cols: number = DASHBOARD_GRID_COLUMNS,
): { x: number; y: number } {
  const width = Math.max(DASHBOARD_MIN_W, Math.min(cols, w));
  const height = Math.max(DASHBOARD_MIN_H, h);
  for (let y = 0; y < 1000; y += 1) {
    for (let x = 0; x <= cols - width; x += 1) {
      const candidate: DashboardGridPlacement = { x, y, w: width, h: height };
      if (!occupied.some((other) => gridPlacementsOverlap(candidate, other))) return { x, y };
    }
  }
  return { x: 0, y: 0 };
}

/**
 * Resolve overlaps after a move/resize without compacting upward (free placement).
 * The widget at `anchorIndex` keeps its position; any widget it collides with is
 * pushed straight down just far enough to clear, cascading to later widgets only.
 */
export function resolveGridCollisions(widgets: DashboardGridPlacement[], anchorIndex: number): void {
  if (anchorIndex < 0 || anchorIndex >= widgets.length) return;
  const order = widgets
    .map((placement, index) => ({ placement, index }))
    .filter((entry) => entry.index !== anchorIndex)
    .sort((a, b) => a.placement.y - b.placement.y || a.placement.x - b.placement.x)
    .map((entry) => entry.index);
  const placed: number[] = [anchorIndex];
  for (const index of order) {
    const placement = widgets[index];
    let guard = 0;
    while (placed.some((other) => gridPlacementsOverlap(placement, widgets[other])) && guard < 2000) {
      placement.y += 1;
      guard += 1;
    }
    placed.push(index);
  }
}

export type GridPushDirection = 'up' | 'down' | 'left' | 'right';

/** Number of cells two placements overlap (0 when they don't touch). */
export function gridOverlapArea(a: DashboardGridPlacement, b: DashboardGridPlacement): number {
  const ox = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const oy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return ox * oy;
}

function anyGridOverlap(placements: readonly DashboardGridPlacement[]): boolean {
  for (let i = 0; i < placements.length; i += 1) {
    for (let j = i + 1; j < placements.length; j += 1) {
      if (gridPlacementsOverlap(placements[i], placements[j])) return true;
    }
  }
  return false;
}

/**
 * Pick which way overlapped cards should slide to make room for the moved card,
 * based on where the moved card sits over the card it overlaps most. Dropping over
 * the top of a card pushes it down, the bottom pushes it up, left pushes right, etc.
 */
export function gridDropPushDirection(placements: readonly DashboardGridPlacement[], movedIndex: number): GridPushDirection {
  const moved = placements[movedIndex];
  if (!moved) return 'down';
  let primary = -1;
  let best = 0;
  for (let i = 0; i < placements.length; i += 1) {
    if (i === movedIndex) continue;
    const area = gridOverlapArea(moved, placements[i]);
    if (area > best) { best = area; primary = i; }
  }
  if (primary < 0) return 'down';
  const target = placements[primary];
  const dx = (moved.x + moved.w / 2) - (target.x + target.w / 2);
  const dy = (moved.y + moved.h / 2) - (target.y + target.h / 2);
  if (Math.abs(dy) >= Math.abs(dx)) return dy <= 0 ? 'down' : 'up';
  return dx <= 0 ? 'right' : 'left';
}

/** Sweep overlapping cards out of the anchor's way in `direction`; returns false when blocked by a grid edge. */
function pushGridSweep(placements: DashboardGridPlacement[], anchorIndex: number, direction: GridPushDirection, cols: number): boolean {
  const vertical = direction === 'up' || direction === 'down';
  const sign = direction === 'down' || direction === 'right' ? 1 : -1;
  const axisPos = (p: DashboardGridPlacement) => (vertical ? p.y : p.x);
  const order = placements
    .map((placement, index) => ({ placement, index }))
    .filter((entry) => entry.index !== anchorIndex)
    .sort((a, b) => (sign > 0 ? axisPos(a.placement) - axisPos(b.placement) : axisPos(b.placement) - axisPos(a.placement)))
    .map((entry) => entry.index);
  const placed: number[] = [anchorIndex];
  for (const index of order) {
    const placement = placements[index];
    let guard = 0;
    while (placed.some((other) => gridPlacementsOverlap(placement, placements[other]))) {
      const nextPos = (vertical ? placement.y : placement.x) + sign;
      if (sign < 0 && nextPos < 0) return false;
      if (sign > 0 && !vertical && nextPos + placement.w > cols) return false;
      if (vertical) placement.y = nextPos; else placement.x = nextPos;
      guard += 1;
      if (guard > 4000) return false;
    }
    placed.push(index);
  }
  return true;
}

/**
 * Resolve overlaps by sliding colliding cards in `direction`, keeping the anchor put.
 * Returns a new placement array. Falls back to a downward push when the requested
 * direction is blocked by a grid edge (so cards never end up overlapping).
 */
export function resolveDirectionalCollisions(
  base: readonly DashboardGridPlacement[],
  movedIndex: number,
  direction: GridPushDirection,
  cols: number = DASHBOARD_GRID_COLUMNS,
): DashboardGridPlacement[] {
  const primary = base.map((placement) => ({ ...placement }));
  if (pushGridSweep(primary, movedIndex, direction, cols) && !anyGridOverlap(primary)) return primary;
  const fallback = base.map((placement) => ({ ...placement }));
  pushGridSweep(fallback, movedIndex, 'down', cols);
  return fallback;
}

/** Map a resize edge/corner to the direction overlapped neighbours should slide. */
export function resizeEdgePushDirection(edge: string): GridPushDirection {
  if (edge.includes('s')) return 'down';
  if (edge.includes('n')) return 'up';
  if (edge.includes('e')) return 'right';
  if (edge.includes('w')) return 'left';
  return 'down';
}

/** Stack cards downward (reading order) so none overlap, keeping the top-left-most anchored. */
export function packGridDown(placements: DashboardGridPlacement[]): void {
  const order = placements
    .map((placement, index) => ({ placement, index }))
    .sort((a, b) => a.placement.y - b.placement.y || a.placement.x - b.placement.x)
    .map((entry) => entry.index);
  const placed: number[] = [];
  for (const index of order) {
    const placement = placements[index];
    let guard = 0;
    while (placed.some((other) => gridPlacementsOverlap(placement, placements[other])) && guard < 4000) {
      placement.y += 1;
      guard += 1;
    }
    placed.push(index);
  }
}

/**
 * Project placements stored in `fromCols` space into a narrower `toCols` grid for display,
 * scaling x/width proportionally and packing downward so nothing overlaps. The stored layout
 * is never mutated — this returns a fresh array used only for rendering on small panes.
 */
export function scaleGridPlacements(
  base: readonly DashboardGridPlacement[],
  fromCols: number,
  toCols: number,
): DashboardGridPlacement[] {
  if (toCols >= fromCols || toCols < 1) return base.map((placement) => ({ ...placement }));
  const ratio = toCols / fromCols;
  const scaled = base.map((placement) => {
    const w = Math.max(1, Math.min(toCols, Math.round(placement.w * ratio)));
    const x = Math.max(0, Math.min(toCols - w, Math.round(placement.x * ratio)));
    return { x, y: placement.y, w, h: placement.h };
  });
  packGridDown(scaled);
  return scaled;
}

function firstCompactSlot(
  occupied: readonly DashboardGridPlacement[],
  placement: DashboardGridPlacement,
  cols: number,
): DashboardGridPlacement {
  const w = Math.max(DASHBOARD_MIN_W, Math.min(cols, placement.w));
  const h = Math.max(DASHBOARD_MIN_H, placement.h);
  for (let y = 0; y < 1000; y += 1) {
    let bestX: number | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let x = 0; x <= cols - w; x += 1) {
      const candidate = { x, y, w, h };
      if (occupied.some((other) => gridPlacementsOverlap(candidate, other))) continue;
      const distance = Math.abs(x - placement.x);
      if (distance < bestDistance || (distance === bestDistance && (bestX === null || x < bestX))) {
        bestX = x;
        bestDistance = distance;
      }
    }
    if (bestX !== null) return { x: bestX, y, w, h };
  }
  return { x: 0, y: 0, w, h };
}

/**
 * Compact a dashboard layout by reading widgets top-to-bottom / left-to-right,
 * then moving each one into the earliest open slot while staying as close as
 * possible to its original column. This fills vertical gaps without scrambling
 * the user's rough ordering or left/right grouping.
 */
export function compactGridPlacements(
  base: readonly DashboardGridPlacement[],
  cols: number = DASHBOARD_GRID_COLUMNS,
): DashboardGridPlacement[] {
  const safeCols = Math.max(1, Math.min(DASHBOARD_GRID_COLUMNS, Math.round(cols) || DASHBOARD_GRID_COLUMNS));
  const placements = base.map((placement) => clampGridPlacement(placement, safeCols));
  const order = placements
    .map((placement, index) => ({ placement, index }))
    .sort((a, b) => a.placement.y - b.placement.y || a.placement.x - b.placement.x || a.index - b.index);
  const occupied: DashboardGridPlacement[] = [];
  const compacted = placements.map((placement) => ({ ...placement }));
  for (const { placement, index } of order) {
    const next = firstCompactSlot(occupied, placement, safeCols);
    compacted[index] = next;
    occupied.push(next);
  }
  return compacted;
}

/**
 * Width-aware compaction companion to the vertical gravity pass: when a card is rendering an empty
 * state it does not need its full authored width, so hand the slack to a content-rich card sitting
 * directly beside it (same row band). Only the shared boundary between the empty card and its
 * neighbour moves — the pair's combined footprint is preserved — and every trial is overlap-checked
 * against the rest of the board, so a transfer that would collide with a third card is skipped.
 * Mutates `placements` in place and returns whether anything changed.
 *
 * `empties[i]` marks the card at index i as showing an empty state. `minEmptyW` is the floor an empty
 * card may shrink to; `step` keeps transfers aligned to the coarse grid.
 */
export function redistributeEmptyCardWidths(
  placements: DashboardGridPlacement[],
  empties: readonly boolean[],
  opts: { minEmptyW: number; step: number; cols?: number },
): boolean {
  const cols = opts.cols ?? DASHBOARD_GRID_COLUMNS;
  const step = Math.max(1, Math.round(opts.step) || 1);
  const minEmptyW = Math.max(1, Math.round(opts.minEmptyW) || 1);
  const overlap = (a: DashboardGridPlacement, b: DashboardGridPlacement): boolean =>
    a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const vOverlap = (a: DashboardGridPlacement, b: DashboardGridPlacement): number =>
    Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  let changed = false;
  // Process the widest empty cards first so the largest pockets of slack are reclaimed deterministically.
  const emptyOrder = placements
    .map((_, i) => i)
    .filter((i) => empties[i])
    .sort((a, b) => placements[b].w - placements[a].w || a - b);
  for (const ei of emptyOrder) {
    const empty = placements[ei];
    if (empty.w <= minEmptyW) continue;
    // Find the best neighbour sharing a vertical edge with the empty card: not itself empty, at least
    // as tall (it is the card that earns the room), and overlapping the empty card's rows by >= half.
    // Rank every qualifying neighbour that shares a vertical edge with the empty card: not itself
    // empty, at least as tall (it is the card that earns the room), and covering >= half the empty
    // card's rows. Tallest (most content) first, then by how much of the empty card it covers.
    const candidates: number[] = [];
    for (let ni = 0; ni < placements.length; ni += 1) {
      if (ni === ei || empties[ni]) continue;
      const neighbour = placements[ni];
      const sharesLeftEdge = neighbour.x + neighbour.w === empty.x; // neighbour is immediately left
      const sharesRightEdge = empty.x + empty.w === neighbour.x; // neighbour is immediately right
      if (!sharesLeftEdge && !sharesRightEdge) continue;
      // Only treat top-aligned cards as row peers. Without this, a tall card from an adjacent layout
      // rail (e.g. Today-at-a-glance) that merely happens to abut a full-width empty card could be
      // chosen and grown sideways across the rail boundary.
      if (neighbour.y !== empty.y) continue;
      if (neighbour.h < empty.h) continue;
      if (vOverlap(empty, neighbour) < empty.h * 0.5) continue;
      candidates.push(ni);
    }
    candidates.sort((a, b) =>
      (placements[b].h - placements[a].h)
      || (vOverlap(empty, placements[b]) - vOverlap(empty, placements[a]))
      || (a - b));
    // Try candidates in priority order so a top pick that is boxed in (e.g. blocked by a banner above)
    // falls through to the next viable neighbour instead of abandoning the transfer.
    for (const bestIndex of candidates) {
      const neighbour = placements[bestIndex];
      const neighbourLeft = neighbour.x + neighbour.w === empty.x;
      const maxDelta = Math.floor((empty.w - minEmptyW) / step) * step;
      let applied = false;
      for (let delta = maxDelta; delta >= step; delta -= step) {
        const trialEmpty = { ...empty };
        const trialNeighbour = { ...neighbour };
        if (neighbourLeft) {
          // Neighbour on the left grows rightward; the empty card slides right and shrinks.
          trialNeighbour.w = neighbour.w + delta;
          trialEmpty.x = empty.x + delta;
          trialEmpty.w = empty.w - delta;
        } else {
          // Neighbour on the right grows leftward into the freed strip; the empty card just shrinks.
          trialEmpty.w = empty.w - delta;
          trialNeighbour.x = neighbour.x - delta;
          trialNeighbour.w = neighbour.w + delta;
        }
        if (trialEmpty.x < 0 || trialEmpty.x + trialEmpty.w > cols) continue;
        if (trialNeighbour.x < 0 || trialNeighbour.x + trialNeighbour.w > cols) continue;
        let collides = false;
        for (let k = 0; k < placements.length; k += 1) {
          if (k === ei || k === bestIndex) continue;
          if (overlap(trialEmpty, placements[k]) || overlap(trialNeighbour, placements[k])) { collides = true; break; }
        }
        if (collides) continue;
        empty.x = trialEmpty.x;
        empty.w = trialEmpty.w;
        neighbour.x = trialNeighbour.x;
        neighbour.w = trialNeighbour.w;
        changed = true;
        applied = true;
        break;
      }
      if (applied) break;
    }
  }
  return changed;
}

/**
 * Column-level companion to {@link redistributeEmptyCardWidths}: keep content-light side rails from
 * stretching wider than they need on a roomy pane and give the slack to the single widest (primary)
 * column. Conceptually this turns a fixed `25% | 50% | 25%` band into `content | 1fr | content` —
 * the side rails are capped at `maxSideW` (only ever shrinking) and the primary column grows by the
 * freed width, so the row stays a contiguous, full-width set of columns.
 *
 * Deliberately conservative so it never disturbs hand-built or non-columnar layouts: it is a no-op
 * unless the cards group into columns that tile `[0, cols)` edge-to-edge with exactly one strictly
 * widest column. Every card in a column shares the column's x and width, so vertical stacking (and
 * the heights/y the gravity pass already computed) is preserved — only x and w change. Mutates
 * `placements` in place and returns whether anything changed.
 *
 * `maxSideW` / `minSideW` are in grid columns; the caller converts the pixel comfort ceiling using
 * the live cell width. When `floorSideW` is supplied, content rails narrower than the floor are
 * *widened* up to it (never past `maxSideW`) and the primary column gives up the difference — the
 * mirror image of the shrink case. The widen is abandoned (falling back to shrink-only) whenever it
 * would make the primary no longer the widest column, so the band can never invert.
 */
export function redistributeRailWidthsToPrimary(
  placements: DashboardGridPlacement[],
  opts: { maxSideW: number; minSideW: number; cols?: number; floorSideW?: number },
): boolean {
  const cols = opts.cols ?? DASHBOARD_GRID_COLUMNS;
  const maxSideW = Math.max(1, Math.round(opts.maxSideW) || 1);
  const minSideW = Math.max(1, Math.round(opts.minSideW) || 1);
  const floorSideW = opts.floorSideW != null && Number.isFinite(opts.floorSideW)
    ? Math.max(1, Math.round(opts.floorSideW))
    : 0;
  if (placements.length < 2) return false;
  // Group cards into columns keyed by their exact horizontal span. Cards in one visual column must
  // share both x and width; a ragged column produces extra keys and trips the tiling gate below.
  const byColumn = new Map<string, { x: number; w: number; members: number[] }>();
  placements.forEach((p, i) => {
    const key = `${p.x}:${p.w}`;
    const col = byColumn.get(key);
    if (col) col.members.push(i);
    else byColumn.set(key, { x: p.x, w: p.w, members: [i] });
  });
  const columns = [...byColumn.values()].sort((a, b) => a.x - b.x);
  if (columns.length < 2) return false;
  // Gate: the columns must tile [0, cols) edge-to-edge with no gaps or overlaps.
  if (columns[0].x !== 0) return false;
  for (let i = 1; i < columns.length; i += 1) {
    if (columns[i].x !== columns[i - 1].x + columns[i - 1].w) return false;
  }
  const last = columns[columns.length - 1];
  if (last.x + last.w !== cols) return false;
  // The primary (flex) column is the single widest one; bail if two columns tie for widest.
  let primary = columns[0];
  let tie = false;
  for (const col of columns) {
    if (col === columns[0]) continue;
    if (col.w > primary.w) { primary = col; tie = false; }
    else if (col.w === primary.w) tie = true;
  }
  if (tie || primary.w <= 0) return false;
  // Resolve each non-primary column toward its target width. Without a floor this only ever shrinks
  // (cap at maxSideW); with a floor it may also widen a too-narrow rail up toward the floor.
  const resolveTarget = (w: number): number => {
    let target = Math.max(minSideW, Math.min(w, maxSideW));
    if (floorSideW > 0) target = Math.max(target, Math.min(floorSideW, maxSideW));
    return target;
  };
  let freed = 0;
  const targetW = new Map<{ x: number; w: number; members: number[] }, number>();
  for (const col of columns) {
    if (col === primary) continue;
    const target = resolveTarget(col.w);
    targetW.set(col, target);
    freed += col.w - target;
  }
  if (freed === 0) return false;
  // Net widening (freed < 0) shrinks the primary; guard so it stays the widest column. If it can't,
  // drop the floor and fall back to the shrink-only targets (which never enlarge a rail).
  const widestRail = Math.max(1, ...[...targetW.values()]);
  if (primary.w + freed < widestRail) {
    if (floorSideW <= 0) return false;
    freed = 0;
    for (const col of columns) {
      if (col === primary) continue;
      const target = Math.max(minSideW, Math.min(col.w, maxSideW));
      targetW.set(col, target);
      freed += col.w - target;
    }
    if (freed <= 0) return false;
  }
  targetW.set(primary, primary.w + freed);
  // Relayout columns left-to-right at their new widths, keeping the band contiguous and full-width.
  let changed = false;
  let x = 0;
  for (const col of columns) {
    const w = targetW.get(col) ?? col.w;
    for (const i of col.members) {
      if (placements[i].x !== x || placements[i].w !== w) changed = true;
      placements[i].x = x;
      placements[i].w = w;
    }
    x += w;
  }
  return changed;
}

/** Pick how many columns to render for a given grid content width (always a divisor of the full grid). */
export function responsiveColumnCount(width: number, maxCols: number = DASHBOARD_GRID_COLUMNS): number {
  if (!Number.isFinite(width) || width <= 0) return maxCols;
  const s = DASHBOARD_GRID_SCALE;
  let cols: number;
  // The 96-track grid must also fit 95 spacious (10px) gutters before any track content.
  if (width >= 1000) cols = 12 * s;
  else if (width >= 520) cols = 6 * s;
  else if (width >= 380) cols = 4 * s;
  else if (width >= 260) cols = 3 * s;
  else if (width >= 180) cols = 2 * s;
  else cols = 1 * s;
  return Math.min(cols, maxCols);
}

/**
 * Choose the column count that best fits `count` equally-sized buttons into a `width`×`height` box.
 * Tries every column count and prefers cells close to a comfortable button aspect ratio, lightly
 * penalizing wasted trailing cells and cells that fall below comfortable minimum dimensions so the
 * layout reflows naturally between “tall + narrow” (few columns) and “short + wide” (many columns).
 * Returns at least 1.
 */
export function bestActionGridColumns(count: number, width: number, height: number, gap: number): number {
  if (count <= 1) return Math.max(1, count);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    // No measurable box yet — fall back to a roughly square arrangement.
    return Math.max(1, Math.min(count, Math.round(Math.sqrt(count))));
  }
  const g = Number.isFinite(gap) && gap > 0 ? gap : 0;
  const idealAspect = 2.4; // buttons read best a bit wider than tall (icon + label)
  const minCellW = 120; // raised so buttons prefer fewer (taller) columns on medium widths
  const minCellH = 36;
  let bestCols = 1;
  let bestScore = Number.POSITIVE_INFINITY;
  for (let cols = 1; cols <= count; cols++) {
    const rows = Math.ceil(count / cols);
    const cellW = (width - g * (cols - 1)) / cols;
    const cellH = (height - g * (rows - 1)) / rows;
    if (cellW <= 0 || cellH <= 0) continue;
    const aspectScore = Math.abs(Math.log(cellW / cellH / idealAspect));
    const waste = (cols * rows - count) / count;
    const widthPenalty = cellW < minCellW ? (minCellW - cellW) / minCellW : 0;
    const heightPenalty = cellH < minCellH ? (minCellH - cellH) / minCellH : 0;
    const score = aspectScore + waste * 0.6 + widthPenalty * 2.2 + heightPenalty * 2.2;
    if (score < bestScore - 1e-9) {
      bestScore = score;
      bestCols = cols;
    }
  }
  return bestCols;
}

export function dashboardActionGridTemplate(actions: readonly { label?: string }[], columns: number, mode: 'row' | 'icononly'): string {
  const cols = Math.max(1, Math.round(columns) || 1);
  const hasCompactAction = actions.some((action) => !action.label);
  if (mode === 'row' && hasCompactAction && cols >= actions.length) {
    return actions.map((action) => action.label ? 'minmax(0, 1fr)' : 'minmax(2.25rem, max-content)').join(' ');
  }
  return `repeat(${cols}, minmax(0, 1fr))`;
}

/** Fill in missing/invalid placements and relocate any valid-but-overlapping ones (in array order). */
export function ensureGridPlacements(widgets: DashboardWidgetConfig[], cols: number = DASHBOARD_GRID_COLUMNS): void {
  const occupied: DashboardGridPlacement[] = [];
  for (const widget of widgets) {
    if (isValidGridPlacement(widget.grid, cols)) {
      const clamped = clampGridPlacement(widget.grid, cols);
      // Keep an explicit placement only when it doesn't collide with an already-placed widget.
      // Otherwise relocate it (keeping its footprint) so migrated/hand-edited layouts can never
      // surface two valid-but-overlapping cards stacked on top of each other.
      if (!occupied.some((other) => gridPlacementsOverlap(clamped, other))) {
        widget.grid = clamped;
        occupied.push(widget.grid);
        continue;
      }
      const slot = findFreeGridSlot(occupied, clamped.w, clamped.h, cols);
      widget.grid = { x: slot.x, y: slot.y, w: clamped.w, h: clamped.h };
      occupied.push(widget.grid);
      continue;
    }
    const footprint = gridFootprintForSize(normalizeDashboardWidgetSize(widget.size));
    const slot = findFreeGridSlot(occupied, footprint.w, footprint.h, cols);
    widget.grid = { x: slot.x, y: slot.y, w: Math.min(cols, footprint.w), h: footprint.h };
    occupied.push(widget.grid);
  }
}

export function isValidGridPlacement(grid: DashboardGridPlacement | undefined, cols: number): grid is DashboardGridPlacement {
  if (!grid) return false;
  const values = [grid.x, grid.y, grid.w, grid.h];
  if (values.some((value) => typeof value !== 'number' || !Number.isFinite(value))) return false;
  return grid.w >= 1 && grid.h >= 1 && grid.x >= 0 && grid.y >= 0 && grid.x + grid.w <= cols;
}

/** Index-based reorder used for keyboard / programmatic moves. */
export function reorderDashboardWidgets<T>(widgets: readonly T[], from: number, to: number): T[] {
  const next = [...widgets];
  if (from < 0 || from >= next.length) return next;
  const [moved] = next.splice(from, 1);
  const clamped = Math.max(0, Math.min(to, next.length));
  next.splice(clamped, 0, moved);
  return next;
}

/** Move `dragged` so it sits immediately before `target` (or to the end when target is null). */
export function moveDashboardWidgetBefore<T>(widgets: readonly T[], dragged: T, target: T | null): T[] {
  const without = widgets.filter((widget) => widget !== dragged);
  if (!target || target === dragged) {
    without.push(dragged);
    return without;
  }
  const index = without.indexOf(target);
  without.splice(index < 0 ? without.length : index, 0, dragged);
  return without;
}

/** Derive a size bucket from a legacy absolute-grid position so old layouts can be migrated. */
export function sizeFromLegacyPosition(position?: DashboardWidgetPosition): DashboardWidgetSize {
  if (!position) return 'medium';
  const width = Math.max(1, position.width || 1);
  const height = Math.max(1, position.height || 1);
  const area = width * height;
  if (width >= 3 || area >= 4) return 'large';
  if (width >= 2 || area >= 2) return 'medium';
  return 'small';
}
