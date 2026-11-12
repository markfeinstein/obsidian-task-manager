export interface FloatingRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type FloatingViewport = FloatingRect;

export interface FloatingPosition {
  inlineStart: number;
  blockStart: number;
  inlineSide: 'start' | 'end';
  blockSide: 'after' | 'before';
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), Math.max(minimum, maximum));
}

/** Position a floating box at logical inline-start/below, flipping and clamping on overflow. */
export function resolveFloatingPosition(
  anchor: FloatingRect,
  floating: Pick<FloatingRect, 'width' | 'height'>,
  viewport: FloatingViewport,
  direction: 'ltr' | 'rtl',
  gap = 4,
): FloatingPosition {
  const viewportRight = viewport.left + viewport.width;
  const viewportBottom = viewport.top + viewport.height;
  const startX = direction === 'ltr' ? anchor.left : anchor.left + anchor.width - floating.width;
  const endX = direction === 'ltr' ? anchor.left + anchor.width - floating.width : anchor.left;
  const fitsInline = (x: number): boolean => x >= viewport.left && x + floating.width <= viewportRight;
  const useEnd = !fitsInline(startX) && fitsInline(endX);
  const x = clamp(useEnd ? endX : startX, viewport.left, viewportRight - floating.width);

  const afterY = anchor.top + anchor.height + gap;
  const beforeY = anchor.top - floating.height - gap;
  const useBefore = afterY + floating.height > viewportBottom && beforeY >= viewport.top;
  const y = clamp(useBefore ? beforeY : afterY, viewport.top, viewportBottom - floating.height);

  return {
    inlineStart: Math.max(0, direction === 'ltr' ? x - viewport.left : viewportRight - (x + floating.width)),
    blockStart: y - viewport.top,
    inlineSide: useEnd ? 'end' : 'start',
    blockSide: useBefore ? 'before' : 'after',
  };
}
