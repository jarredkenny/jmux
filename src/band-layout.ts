// Geometry for laying out a row of "chips" (tabs, buttons) into a horizontal
// band, once, so both painting and hit-testing read from the same placement.
// This module is deliberately geometry-only: no styling, no `StyledSegment`
// construction, no chip-specific painting concerns (dot recoloring, "+N"
// overflow indicators, etc). Callers build their own `StyledSegment[]` from
// the `PlacedChip[]` this returns and paint via `writeStyledLine` (see
// `cell-grid.ts`); hit-testing goes through `chipAtCol`.

export interface PlacedChip {
  id: string;
  x: number;
  width: number;
}

export interface PackChipsOptions {
  /** The anchor column: left align packs starting here going right; right
   * align packs ending here (exclusive) going left. */
  start: number;
  /** The column placement must not cross. Left align: chips must satisfy
   * `x + width <= budget`. Right align: chips must satisfy `x >= budget`.
   * Pass `-Infinity` (right align) / `Infinity` (left align) for "never
   * overflow" when the caller has no real bound (matches call sites that
   * historically had no overflow guard at all). */
  budget: number;
  align: "left" | "right";
  /** Blank columns between adjacent chips. Default 0. */
  gap?: number;
  /** Additional separator width between adjacent chips, on top of `gap`.
   * Kept as a distinct knob from `gap` because callers reserve it for a
   * literal separator glyph (e.g. the toolbar's " │ ") rather than a bare
   * gap, even though the two are simply additive in the packing math. */
  sepWidth?: number;
}

/**
 * Places whole chips only — a chip that would only partially fit is dropped
 * entirely, never clipped. Packing is contiguous and stops at the first chip
 * that would overflow `budget`: this is whole-chip, in-order packing, not a
 * best-fit search that skips an overflowing chip to place a later, smaller
 * one out of order.
 *
 * `align: "left"` packs `items` in order starting at `start`, growing
 * rightward. `align: "right"` packs `items` starting from the *last* item,
 * anchoring it at `start` and growing leftward — this matches
 * `getToolbarButtonRanges`'s original right-to-left-with-unshift packing, so
 * the last item in `items` ends up closest to `start` and the first item
 * ends up furthest from it. The returned array is always in the same order
 * as `items` (a prefix for left align, a suffix for right align) regardless
 * of which end of the array packing started from.
 */
export function packChips(
  items: { id: string; width: number }[],
  opts: PackChipsOptions,
): PlacedChip[] {
  const gap = opts.gap ?? 0;
  const sepWidth = opts.sepWidth ?? 0;
  const step = gap + sepWidth;

  if (opts.align === "left") {
    const chips: PlacedChip[] = [];
    let x = opts.start;
    for (const item of items) {
      if (x + item.width > opts.budget) break;
      chips.push({ id: item.id, x, width: item.width });
      x += item.width + step;
    }
    return chips;
  }

  // align === "right": process from the last item backward, anchoring the
  // last item at `start`. Collect in processing order, then reverse so the
  // returned array matches `items`' original order.
  const placed: PlacedChip[] = [];
  let x = opts.start;
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    const nextX = x - item.width;
    if (nextX < opts.budget) break;
    placed.push({ id: item.id, x: nextX, width: item.width });
    x = nextX - step;
  }
  return placed.reverse();
}

/** Generalizes `chipAtX` (`glass/strip.ts`): returns the id of the chip
 * whose column range contains `col`, or null if no chip covers it (either
 * it's in a gap/separator, or outside every chip's range). */
export function chipAtCol(chips: PlacedChip[], col: number): string | null {
  for (const c of chips) {
    if (col >= c.x && col < c.x + c.width) return c.id;
  }
  return null;
}
