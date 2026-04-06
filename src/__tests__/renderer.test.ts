import { describe, test, expect } from "bun:test";
import { sgrForCell, compositeGrids, BORDER_CHAR } from "../renderer";
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

describe("compositeGrids with palette overlay", () => {
  test("palette replaces toolbar row", () => {
    const sidebar = createGrid(4, 4);
    const main = createGrid(10, 3);
    writeString(main, 0, 0, "main line1");

    const toolbar = {
      buttons: [],
      mainCols: 10,
      tabs: [],
    };

    // Palette grid: 2 rows (input + border), 10 cols
    const palette = createGrid(10, 2);
    writeString(palette, 0, 0, "▷ query");
    writeString(palette, 1, 0, "──────────");

    const result = compositeGrids(main, sidebar, toolbar, palette);
    // Row 0: sidebar + border + palette row 0
    expect(result.cells[0][5].char).toBe("▷");
  });

  test("palette overlays main content rows", () => {
    const sidebar = createGrid(4, 5);
    const main = createGrid(10, 4);
    writeString(main, 0, 0, "visible");
    writeString(main, 1, 0, "covered");

    const toolbar = {
      buttons: [],
      mainCols: 10,
      tabs: [],
    };

    // 3-row palette: input + 1 result + border
    const palette = createGrid(10, 3);
    writeString(palette, 0, 0, "▷ input");
    writeString(palette, 1, 0, " result");
    writeString(palette, 2, 0, "──────────");

    const result = compositeGrids(main, sidebar, toolbar, palette);
    // Row 0 (toolbar) → palette row 0
    expect(result.cells[0][5].char).toBe("▷");
    // Row 1 (main row 0) → palette row 1 (overlaid)
    expect(result.cells[1][6].char).toBe("r");
    // Row 2 (main row 1) → palette row 2 (border)
    expect(result.cells[2][5].char).toBe("─");
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
