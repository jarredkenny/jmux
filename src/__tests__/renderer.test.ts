import { describe, test, expect } from "bun:test";
import { sgrForCell, compositeGrids, getModalPosition, BORDER_CHAR } from "../renderer";
import { createGrid, writeString } from "../cell-grid";
import { ColorMode } from "../types";
import type { Cell } from "../types";

describe("sgrForCell", () => {
  test("returns reset only for default cell", () => {
    const cell: Cell = {
      char: " ",
      width: 1, fg: 0, bg: 0,
      fgMode: ColorMode.Default, bgMode: ColorMode.Default,
      bold: false, italic: false, underline: false, dim: false,
    };
    expect(sgrForCell(cell)).toBe("\x1b[0m");
  });

  test("includes bold attribute", () => {
    const cell: Cell = {
      char: "x",
      width: 1, fg: 0, bg: 0,
      fgMode: ColorMode.Default, bgMode: ColorMode.Default,
      bold: true, italic: false, underline: false, dim: false,
    };
    expect(sgrForCell(cell)).toBe("\x1b[0;1m");
  });

  test("encodes standard ANSI foreground color 0-7", () => {
    const cell: Cell = {
      char: "x",
      width: 1, fg: 1, bg: 0,
      fgMode: ColorMode.Palette, bgMode: ColorMode.Default,
      bold: false, italic: false, underline: false, dim: false,
    };
    expect(sgrForCell(cell)).toBe("\x1b[0;31m");
  });

  test("encodes bright ANSI foreground color 8-15", () => {
    const cell: Cell = {
      char: "x",
      width: 1, fg: 9, bg: 0,
      fgMode: ColorMode.Palette, bgMode: ColorMode.Default,
      bold: false, italic: false, underline: false, dim: false,
    };
    expect(sgrForCell(cell)).toBe("\x1b[0;91m");
  });

  test("encodes 256-color foreground", () => {
    const cell: Cell = {
      char: "x",
      width: 1, fg: 200, bg: 0,
      fgMode: ColorMode.Palette, bgMode: ColorMode.Default,
      bold: false, italic: false, underline: false, dim: false,
    };
    expect(sgrForCell(cell)).toBe("\x1b[0;38;5;200m");
  });

  test("encodes RGB foreground", () => {
    const cell: Cell = {
      char: "x",
      width: 1, fg: 0xFF8800, bg: 0,
      fgMode: ColorMode.RGB, bgMode: ColorMode.Default,
      bold: false, italic: false, underline: false, dim: false,
    };
    expect(sgrForCell(cell)).toBe("\x1b[0;38;2;255;136;0m");
  });

  test("encodes background color", () => {
    const cell: Cell = {
      char: "x",
      width: 1, fg: 0, bg: 4,
      fgMode: ColorMode.Default, bgMode: ColorMode.Palette,
      bold: false, italic: false, underline: false, dim: false,
    };
    expect(sgrForCell(cell)).toBe("\x1b[0;44m");
  });

  test("encodes combined attributes and colors", () => {
    const cell: Cell = {
      char: "x",
      width: 1, fg: 2, bg: 0,
      fgMode: ColorMode.Palette, bgMode: ColorMode.Default,
      bold: true, italic: true, underline: false, dim: false,
    };
    expect(sgrForCell(cell)).toBe("\x1b[0;1;3;32m");
  });
});

describe("compositeGrids", () => {
  test("returns main grid only when no sidebar", () => {
    const main = createGrid(10, 3);
    writeString(main, 0, 0, "hello");
    const result = compositeGrids(main, null);
    expect(result.cols).toBe(10);
    expect(result.cells[0][0].char).toBe("h");
  });

  test("composites sidebar + border + main", () => {
    const sidebar = createGrid(4, 2);
    writeString(sidebar, 0, 0, "side");
    const main = createGrid(6, 2);
    writeString(main, 0, 0, "main!!");
    const result = compositeGrids(main, sidebar);
    // sidebar: 4 cols + border: 1 col + main: 6 cols = 11 cols
    expect(result.cols).toBe(11);
    expect(result.cells[0][0].char).toBe("s");
    expect(result.cells[0][3].char).toBe("e");
    expect(result.cells[0][4].char).toBe(BORDER_CHAR);
    expect(result.cells[0][5].char).toBe("m");
    expect(result.cells[0][10].char).toBe("!");
  });
});

describe("getModalPosition", () => {
  test("centers modal horizontally over entire terminal", () => {
    const pos = getModalPosition(100, 30, 60, 6);
    // totalW = 63, startCol = max(2, floor((100-63)/2) + 1) = max(2, 18+1) = 19
    expect(pos.startCol).toBe(19);
  });

  test("positions modal in upper third vertically", () => {
    const pos = getModalPosition(100, 30, 60, 6);
    // totalH = 9, startRow = max(2, floor((30-9)/3)+1) = max(2, 7+1) = 8
    expect(pos.startRow).toBe(8);
  });

  test("minimum startRow and startCol leave room for border", () => {
    const pos = getModalPosition(20, 6, 18, 5);
    // Very tight — startCol = max(2, ...) = 2, startRow = max(2, ...) = 2
    expect(pos.startCol).toBeGreaterThanOrEqual(2);
    expect(pos.startRow).toBeGreaterThanOrEqual(2);
  });
});

describe("compositeGrids with palette overlay", () => {
  test("palette is centered with box border over entire terminal", () => {
    const sidebar = createGrid(6, 20);
    const main = createGrid(40, 18);

    const toolbar = {
      buttons: [],
      mainCols: 40,
      tabs: [],
    };

    // Palette: 14 cols wide, 2 rows tall
    const palette = createGrid(14, 2);
    writeString(palette, 0, 0, "▷ query       ");
    writeString(palette, 1, 0, " result       ");

    const result = compositeGrids(main, sidebar, toolbar, palette);
    // Total grid: sidebar(6) + border(1) + main(40) = 47 cols, 19 rows
    expect(result.cols).toBe(47);

    const pos = getModalPosition(47, 19, 14, 2);

    // Box border: ┌ at top-left
    expect(result.cells[pos.startRow - 1][pos.startCol - 1].char).toBe("┌");
    // Box border: ┐ at top-right
    expect(result.cells[pos.startRow - 1][pos.startCol + 14].char).toBe("┐");
    // Palette content inside border
    expect(result.cells[pos.startRow][pos.startCol].char).toBe("▷");
    // Box border: └ at bottom-left
    expect(result.cells[pos.startRow + 2][pos.startCol - 1].char).toBe("└");
    // Side border: │ on left
    expect(result.cells[pos.startRow][pos.startCol - 1].char).toBe("│");
  });

  test("main content is dimmed when palette is open", () => {
    const sidebar = createGrid(6, 14);
    const main = createGrid(30, 12);
    writeString(main, 0, 0, "visible row zero");

    const toolbar = {
      buttons: [],
      mainCols: 30,
      tabs: [],
    };

    const palette = createGrid(10, 2);

    const result = compositeGrids(main, sidebar, toolbar, palette);
    // Main content area starts at col 7 (sidebar 6 + border 1), should be dimmed
    expect(result.cells[1][7].dim).toBe(true);
  });

  test("shadow appears on right and bottom edges", () => {
    const sidebar = createGrid(6, 24);
    const main = createGrid(50, 22);

    const toolbar = {
      buttons: [],
      mainCols: 50,
      tabs: [],
    };

    const palette = createGrid(14, 2);
    const result = compositeGrids(main, sidebar, toolbar, palette);

    const pos = getModalPosition(57, 23, 14, 2); // totalCols=6+1+50=57, totalRows=22+1=23
    const bRight = pos.startCol + 14; // right border col
    const bBottom = pos.startRow + 2; // bottom border row

    // Shadow cell to the right of the border
    if (bRight + 1 < result.cols) {
      expect(result.cells[pos.startRow][bRight + 1].dim).toBe(true);
    }
    // Shadow cell below the border
    if (bBottom + 1 < result.rows) {
      expect(result.cells[bBottom + 1][pos.startCol].dim).toBe(true);
    }
  });

  test("palette null falls back to normal toolbar, no dimming", () => {
    const sidebar = createGrid(4, 3);
    const main = createGrid(10, 2);

    const toolbar = {
      buttons: [{ label: "＋", id: "new" }],
      mainCols: 10,
      tabs: [],
    };

    const result = compositeGrids(main, sidebar, toolbar, null);
    expect(result.rows).toBe(3);
    // No dimming when palette is null
    expect(result.cells[1][5].dim).toBe(false);
  });
});
