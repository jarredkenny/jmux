import type { Cell, CellGrid } from "./types";
import { ColorMode } from "./types";

export const DEFAULT_CELL: Readonly<Cell> = {
  char: " ",
  width: 1,
  fg: 0,
  bg: 0,
  fgMode: ColorMode.Default,
  bgMode: ColorMode.Default,
  bold: false,
  italic: false,
  underline: false,
  dim: false,
  link: undefined,
};

export function createGrid(cols: number, rows: number): CellGrid {
  const cells: Cell[][] = [];
  for (let r = 0; r < rows; r++) {
    const row: Cell[] = [];
    for (let c = 0; c < cols; c++) {
      row.push({ ...DEFAULT_CELL });
    }
    cells.push(row);
  }
  return { cols, rows, cells };
}

export interface CellAttrs {
  fg?: number;
  bg?: number;
  fgMode?: ColorMode;
  bgMode?: ColorMode;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  dim?: boolean;
  link?: string;
}

export interface StyledSegment {
  text: string;
  attrs?: CellAttrs;
}
export type StyledLine = StyledSegment[];

// Display width of a string in terminal columns, summing cellWidth across codepoints.
// Use whenever you need to know how many columns a styled segment will consume so
// the next segment lands at the correct column.
export function textCols(text: string): number {
  let w = 0;
  for (const ch of text) {
    w += cellWidth(ch.codePointAt(0) ?? 0);
  }
  return w;
}

// Display width of a Unicode codepoint for grid layout purposes.
// Must agree with terminal rendering for correct column tracking.
// Used by both writeString (sidebar/modals) and charDisplayWidth (toolbar).
export function cellWidth(cp: number): number {
  if (cp < 0x1100) return 1;
  // CJK and wide character ranges
  if (
    (cp >= 0x1100 && cp <= 0x115F) ||   // Hangul Jamo
    (cp >= 0x2E80 && cp <= 0x303E) ||   // CJK Radicals, Kangxi, Ideographic
    (cp >= 0x3041 && cp <= 0x33BF) ||   // Hiragana, Katakana, Bopomofo, CJK compat
    (cp >= 0x3400 && cp <= 0x4DBF) ||   // CJK Extension A
    (cp >= 0x4E00 && cp <= 0xA4CF) ||   // CJK Unified + Yi
    (cp >= 0xAC00 && cp <= 0xD7AF) ||   // Hangul Syllables
    (cp >= 0xF900 && cp <= 0xFAFF) ||   // CJK Compatibility Ideographs
    (cp >= 0xFE30 && cp <= 0xFE6F) ||   // CJK Compatibility Forms
    (cp >= 0xFF01 && cp <= 0xFF60) ||   // Fullwidth Forms
    (cp >= 0xFFE0 && cp <= 0xFFE6) ||   // Fullwidth Signs
    (cp >= 0x1F000) ||                   // Emoji & supplementary symbols
    (cp >= 0x20000 && cp <= 0x2FFFF)     // CJK Extension B+
  ) {
    return 2;
  }
  return 1;
}

// Writes a single glyph at (row, col), handling the wide-character
// continuation-cell rule in one place: a width-2 glyph is followed by a
// width-0 continuation cell carrying the same background. This is the sole
// owner of that rule — no other code should hand-construct a
// `{ char: "", width: 0 }` continuation cell.
//
// Behaviour matches writeString's per-character handling exactly: out of
// bounds is a silent no-op, and a wide glyph that would overflow the row
// (i.e. its continuation cell falls off the grid) is refused rather than
// half-drawn. Returns the column advance (1 or 2), or 0 if nothing was
// written.
export function writeCell(
  grid: CellGrid,
  row: number,
  col: number,
  ch: string,
  attrs?: CellAttrs,
): number {
  if (row < 0 || row >= grid.rows) return 0;
  if (col < 0 || col >= grid.cols) return 0;
  const cp = ch.codePointAt(0) ?? 0;
  const w = cellWidth(cp);
  // Refuse a wide glyph that would overflow the grid — matches writeString.
  if (w === 2 && col + 1 >= grid.cols) return 0;

  const cell = grid.cells[row][col];
  cell.char = ch;
  cell.width = w;
  if (attrs) {
    if (attrs.fg !== undefined) cell.fg = attrs.fg;
    if (attrs.bg !== undefined) cell.bg = attrs.bg;
    if (attrs.fgMode !== undefined) cell.fgMode = attrs.fgMode;
    if (attrs.bgMode !== undefined) cell.bgMode = attrs.bgMode;
    if (attrs.bold !== undefined) cell.bold = attrs.bold;
    if (attrs.italic !== undefined) cell.italic = attrs.italic;
    if (attrs.underline !== undefined) cell.underline = attrs.underline;
    if (attrs.dim !== undefined) cell.dim = attrs.dim;
    if (attrs.link !== undefined) cell.link = attrs.link;
  }
  if (w === 2) {
    // Continuation cell — only background propagates, matching writeString.
    const cont = grid.cells[row][col + 1];
    cont.char = "";
    cont.width = 0;
    if (attrs) {
      if (attrs.bg !== undefined) cont.bg = attrs.bg;
      if (attrs.bgMode !== undefined) cont.bgMode = attrs.bgMode;
    }
  }
  return w;
}

export interface BlitOptions {
  destX: number;
  destY: number;
  srcX?: number;
  srcY?: number;
  w?: number;
  h?: number;
}

// Copies a clipped rectangle from `src` into `dst`. This is the sole owner
// of rectangle-copying: out-of-bounds destination/source cells are silently
// dropped (clipping is blit's responsibility), and a wide (width-2) source
// cell whose continuation would fall outside the copy rectangle is replaced
// with a space carrying the source cell's attributes — matching the
// tile-interior copy this was extracted from — rather than leaving an
// orphaned width-2 cell with no continuation.
export function blit(dst: CellGrid, src: CellGrid, opts: BlitOptions): void {
  const srcX = opts.srcX ?? 0;
  const srcY = opts.srcY ?? 0;
  const w = opts.w ?? Math.max(0, src.cols - srcX);
  const h = opts.h ?? Math.max(0, src.rows - srcY);

  for (let ry = 0; ry < h; ry++) {
    const sy = srcY + ry;
    if (sy < 0 || sy >= src.rows) continue;
    const dy = opts.destY + ry;
    if (dy < 0 || dy >= dst.rows) continue;

    for (let rx = 0; rx < w; rx++) {
      const sx = srcX + rx;
      if (sx < 0 || sx >= src.cols) continue;
      const dx = opts.destX + rx;
      if (dx < 0 || dx >= dst.cols) continue;

      const srcCell = src.cells[sy][sx];

      if (srcCell.width === 2 && rx + 1 >= w) {
        // Continuation would fall outside the copy rectangle — replace
        // with a space carrying the source's attributes.
        dst.cells[dy][dx] = { ...srcCell, char: " ", width: 1 };
        continue;
      }

      dst.cells[dy][dx] = { ...srcCell };
    }
  }
}

export function writeString(
  grid: CellGrid,
  row: number,
  col: number,
  text: string,
  attrs?: CellAttrs,
): void {
  if (row < 0 || row >= grid.rows) return;
  let c = col;
  for (const ch of text) {
    if (c >= grid.cols) break;
    if (c < 0) { c++; continue; }
    const cp = ch.codePointAt(0) ?? 0;
    const w = cellWidth(cp);
    // Skip wide chars that would overflow the grid
    if (w === 2 && c + 1 >= grid.cols) break;
    const cell = grid.cells[row][c];
    cell.char = ch;
    cell.width = w;
    if (attrs) {
      if (attrs.fg !== undefined) cell.fg = attrs.fg;
      if (attrs.bg !== undefined) cell.bg = attrs.bg;
      if (attrs.fgMode !== undefined) cell.fgMode = attrs.fgMode;
      if (attrs.bgMode !== undefined) cell.bgMode = attrs.bgMode;
      if (attrs.bold !== undefined) cell.bold = attrs.bold;
      if (attrs.italic !== undefined) cell.italic = attrs.italic;
      if (attrs.underline !== undefined) cell.underline = attrs.underline;
      if (attrs.dim !== undefined) cell.dim = attrs.dim;
      if (attrs.link !== undefined) cell.link = attrs.link;
    }
    if (w === 2) {
      // Insert continuation cell
      const cont = grid.cells[row][c + 1];
      cont.char = "";
      cont.width = 0;
      if (attrs) {
        if (attrs.bg !== undefined) cont.bg = attrs.bg;
        if (attrs.bgMode !== undefined) cont.bgMode = attrs.bgMode;
      }
    }
    c += w;
  }
}
