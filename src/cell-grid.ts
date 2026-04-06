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
}

export function writeString(
  grid: CellGrid,
  row: number,
  col: number,
  text: string,
  attrs?: CellAttrs,
): void {
  if (row < 0 || row >= grid.rows) return;
  for (let i = 0; i < text.length; i++) {
    const c = col + i;
    if (c < 0 || c >= grid.cols) continue;
    const cell = grid.cells[row][c];
    cell.char = text[i];
    if (attrs) {
      if (attrs.fg !== undefined) cell.fg = attrs.fg;
      if (attrs.bg !== undefined) cell.bg = attrs.bg;
      if (attrs.fgMode !== undefined) cell.fgMode = attrs.fgMode;
      if (attrs.bgMode !== undefined) cell.bgMode = attrs.bgMode;
      if (attrs.bold !== undefined) cell.bold = attrs.bold;
      if (attrs.italic !== undefined) cell.italic = attrs.italic;
      if (attrs.underline !== undefined) cell.underline = attrs.underline;
      if (attrs.dim !== undefined) cell.dim = attrs.dim;
    }
  }
}
