import { describe, test, expect } from "bun:test";
import { sgrForCell, compositeGrids, getPalettePosition, BORDER_CHAR } from "../renderer";
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

describe("getPalettePosition", () => {
  test("centers palette horizontally in main area", () => {
    const pos = getPalettePosition(80, 24, 60, 6, 1);
    expect(pos.startCol).toBe(10); // (80 - 60) / 2
  });

  test("positions palette in upper third vertically", () => {
    const pos = getPalettePosition(80, 24, 60, 6, 1);
    // startRow = 1 (toolbar) + max(1, floor((24 - 6) / 3)) = 1 + 6 = 7
    expect(pos.startRow).toBe(7);
  });

  test("minimum startRow is toolbarRows + 1", () => {
    // Very tall palette relative to main area
    const pos = getPalettePosition(80, 6, 60, 6, 1);
    // floor((6 - 6) / 3) = 0, max(1, 0) = 1, so startRow = 1 + 1 = 2
    expect(pos.startRow).toBe(2);
  });
});

describe("compositeGrids with palette overlay", () => {
  test("palette is centered over main content, toolbar still visible", () => {
    const sidebar = createGrid(4, 14);
    const main = createGrid(20, 12);
    writeString(main, 0, 0, "main content here!!!");

    const toolbar = {
      buttons: [{ label: "＋", id: "new" }],
      mainCols: 20,
      tabs: [],
    };

    // Small palette: 10 cols wide, 3 rows tall
    const palette = createGrid(10, 3);
    writeString(palette, 0, 0, "▷ query   ");
    writeString(palette, 1, 0, " result   ");
    writeString(palette, 2, 0, "──────────");

    const result = compositeGrids(main, sidebar, toolbar, palette);
    // Toolbar row should still be intact (not replaced)
    // The ＋ button should be rendered somewhere in row 0
    expect(result.rows).toBe(13); // 12 main + 1 toolbar

    // Palette is centered: startCol = (20 - 10) / 2 = 5
    // startRow = 1 + max(1, floor((12 - 3) / 3)) = 1 + 3 = 4
    // So palette row 0 is at grid row 4, starting at sidebar(4) + border(1) + 5 = col 10
    const pos = getPalettePosition(20, 12, 10, 3, 1);
    const gridCol = 4 + 1 + pos.startCol; // sidebar + border + startCol
    expect(result.cells[pos.startRow][gridCol].char).toBe("▷");
    expect(result.cells[pos.startRow + 1][gridCol + 1].char).toBe("r");
    expect(result.cells[pos.startRow + 2][gridCol].char).toBe("─");
  });

  test("main content visible outside palette area", () => {
    const sidebar = createGrid(4, 14);
    const main = createGrid(20, 12);
    writeString(main, 0, 0, "visible row zero");

    const toolbar = {
      buttons: [],
      mainCols: 20,
      tabs: [],
    };

    const palette = createGrid(10, 3);
    writeString(palette, 0, 0, "palette   ");

    const result = compositeGrids(main, sidebar, toolbar, palette);
    // Row 1 (main row 0) should have main content since palette starts lower
    expect(result.cells[1][5].char).toBe("v"); // "visible" at col 0 of main = col 5 of grid
  });

  test("palette null falls back to normal toolbar", () => {
    const sidebar = createGrid(4, 3);
    const main = createGrid(10, 2);

    const toolbar = {
      buttons: [{ label: "＋", id: "new" }],
      mainCols: 10,
      tabs: [],
    };

    const result = compositeGrids(main, sidebar, toolbar, null);
    expect(result.rows).toBe(3);
  });
});
