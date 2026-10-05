/**
 * Label placement geometry: pure, no DOM, unit-tested.
 *
 * Chart annotations (poor extremes, failed auctions) anchor to a price and a
 * bar, so two of them can want the same handful of pixels. `placeLabel` keeps
 * a label's x span and slides it along y, away from its anchor, until it
 * clears every label already placed in this frame.
 */

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** Shared area. Edge-to-edge contact counts as clear, so labels may sit flush. */
export function overlaps(a: Rect, b: Rect): boolean {
  return a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
}

export interface Placement {
  y0: number;
  y1: number;
  /** false when the label left [minY, maxY]: the caller should drop it. */
  fits: boolean;
}

export interface PlaceOpts {
  /** blank pixels between stacked labels (default 2) */
  gap?: number;
  minY?: number;
  maxY?: number;
}

/**
 * Slide `want` along y, in direction `dir` (-1 up, 1 down), until it overlaps
 * none of `taken`. The shift is minimal: each pass moves just past the
 * furthest-in-`dir` edge among the labels currently in the way, and that edge
 * is a lower bound on where the label can legally land — so the result never
 * overshoots a gap it could have used, and never depends on the order of
 * `taken`.
 */
export function placeLabel(
  want: Rect,
  taken: readonly Rect[],
  dir: 1 | -1,
  opts: PlaceOpts = {},
): Placement {
  const gap = opts.gap ?? 2;
  const minY = opts.minY ?? -Infinity;
  const maxY = opts.maxY ?? Infinity;
  const h = want.y1 - want.y0;
  let y0 = want.y0;
  // Movement is monotonic in `dir`, so a blocker once cleared can never block
  // again: one pass per blocker is always enough to settle.
  for (let pass = 0; pass <= taken.length; pass++) {
    const cur: Rect = { x0: want.x0, x1: want.x1, y0, y1: y0 + h };
    let edge: number | null = null;
    for (const t of taken) {
      if (!overlaps(cur, t)) continue;
      if (dir === 1) edge = edge === null ? t.y1 : Math.max(edge, t.y1);
      else edge = edge === null ? t.y0 : Math.min(edge, t.y0);
    }
    if (edge === null) return { y0, y1: y0 + h, fits: y0 >= minY && y0 + h <= maxY };
    y0 = dir === 1 ? edge + gap : edge - gap - h;
  }
  return { y0, y1: y0 + h, fits: false };
}
