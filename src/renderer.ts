import type { Cell, CellGrid, CursorPosition } from "./types";
import { ColorMode } from "./types";
import { createGrid, DEFAULT_CELL } from "./cell-grid";

export const BORDER_CHAR = "\u2502"; // │

export function sgrForCell(cell: Cell): string {
  const parts: string[] = ["0"]; // always reset first

  if (cell.bold) parts.push("1");
  if (cell.dim) parts.push("2");
  if (cell.italic) parts.push("3");
  if (cell.underline) parts.push("4");

  // Foreground
  if (cell.fgMode === ColorMode.Palette) {
    if (cell.fg < 8) {
      parts.push(`${30 + cell.fg}`);
    } else if (cell.fg < 16) {
      parts.push(`${90 + cell.fg - 8}`);
    } else {
      parts.push(`38;5;${cell.fg}`);
    }
  } else if (cell.fgMode === ColorMode.RGB) {
    const r = (cell.fg >> 16) & 0xff;
    const g = (cell.fg >> 8) & 0xff;
    const b = cell.fg & 0xff;
    parts.push(`38;2;${r};${g};${b}`);
  }

  // Background
  if (cell.bgMode === ColorMode.Palette) {
    if (cell.bg < 8) {
      parts.push(`${40 + cell.bg}`);
    } else if (cell.bg < 16) {
      parts.push(`${100 + cell.bg - 8}`);
    } else {
      parts.push(`48;5;${cell.bg}`);
    }
  } else if (cell.bgMode === ColorMode.RGB) {
    const r = (cell.bg >> 16) & 0xff;
    const g = (cell.bg >> 8) & 0xff;
    const b = cell.bg & 0xff;
    parts.push(`48;2;${r};${g};${b}`);
  }

  return `\x1b[${parts.join(";")}m`;
}

export function compositeGrids(
  main: CellGrid,
  sidebar: CellGrid | null,
): CellGrid {
  if (!sidebar) return main;

  const totalCols = sidebar.cols + 1 + main.cols;
  const rows = main.rows;
  const grid = createGrid(totalCols, rows);

  for (let y = 0; y < rows; y++) {
    // Copy sidebar cells
    for (let x = 0; x < sidebar.cols && x < sidebar.cells[y]?.length; x++) {
      grid.cells[y][x] = { ...sidebar.cells[y][x] };
    }
    // Border column
    const borderCol = sidebar.cols;
    grid.cells[y][borderCol] = {
      ...DEFAULT_CELL,
      char: BORDER_CHAR,
      dim: true,
    };
    // Copy main cells
    for (let x = 0; x < main.cols; x++) {
      grid.cells[y][borderCol + 1 + x] = { ...main.cells[y][x] };
    }
  }

  return grid;
}

function cellsEqual(a: Cell, b: Cell): boolean {
  return (
    a.fg === b.fg &&
    a.bg === b.bg &&
    a.fgMode === b.fgMode &&
    a.bgMode === b.bgMode &&
    a.bold === b.bold &&
    a.dim === b.dim &&
    a.italic === b.italic &&
    a.underline === b.underline
  );
}

export class Renderer {
  private prevAttrs: Cell | null = null;

  render(
    main: CellGrid,
    cursor: CursorPosition,
    sidebar: CellGrid | null,
  ): void {
    const grid = compositeGrids(main, sidebar);
    const cursorOffset = sidebar ? sidebar.cols + 1 : 0;
    const buf: string[] = [];

    for (let y = 0; y < grid.rows; y++) {
      // Move to start of row (1-indexed)
      buf.push(`\x1b[${y + 1};1H`);
      this.prevAttrs = null;

      for (let x = 0; x < grid.cols; x++) {
        const cell = grid.cells[y][x];

        // Emit SGR only when attributes change
        if (!this.prevAttrs || !cellsEqual(this.prevAttrs, cell)) {
          buf.push(sgrForCell(cell));
          this.prevAttrs = cell;
        }

        buf.push(cell.char);
      }
    }

    // Reset attributes, position cursor
    buf.push("\x1b[0m");
    buf.push(
      `\x1b[${cursor.y + 1};${cursor.x + cursorOffset + 1}H`,
    );

    process.stdout.write(buf.join(""));
  }
}
