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
  test("centers palette horizontally accounting for border and shadow", () => {
    const pos = getPalettePosition(80, 24, 60, 6, 1);
    // totalW = 60 + 3 = 63, startCol = max(1, floor((80-63)/2) + 1) = max(1, 8+1) = 9
    expect(pos.startCol).toBe(9);
  });

  test("positions palette in upper third vertically", () => {
    const pos = getPalettePosition(80, 24, 60, 6, 1);
    // totalH = 6+3=9, startRow = 1 + max(2, floor((24-9)/3)+1) = 1 + max(2, 5+1) = 1+6 = 7
    expect(pos.startRow).toBe(7);
  });

  test("minimum startRow leaves room for top border", () => {
    const pos = getPalettePosition(80, 6, 60, 6, 1);
    // totalH=9, floor((6-9)/3)+1 = -1+1=0, max(2,0)=2, startRow = 1+2 = 3
    expect(pos.startRow).toBe(3);
  });
});

describe("compositeGrids with palette overlay", () => {
  test("palette is centered with box border, toolbar still visible", () => {
    const sidebar = createGrid(4, 14);
    const main = createGrid(20, 12);
    writeString(main, 0, 0, "main content here!!!");

    const toolbar = {
      buttons: [{ label: "＋", id: "new" }],
      mainCols: 20,
      tabs: [],
    };

    // Small palette: 10 cols wide, 2 rows tall (input + 1 result)
    const palette = createGrid(10, 2);
    writeString(palette, 0, 0, "▷ query   ");
    writeString(palette, 1, 0, " result   ");

    const result = compositeGrids(main, sidebar, toolbar, palette);
    expect(result.rows).toBe(13); // 12 main + 1 toolbar

    const pos = getPalettePosition(20, 12, 10, 2, 1);
    const gridCol = 4 + 1 + pos.startCol; // sidebar + border + startCol

    // Box border: ┌ at top-left
    expect(result.cells[pos.startRow - 1][gridCol - 1].char).toBe("┌");
    // Box border: ┐ at top-right
    expect(result.cells[pos.startRow - 1][gridCol + 10].char).toBe("┐");
    // Palette content inside border
    expect(result.cells[pos.startRow][gridCol].char).toBe("▷");
    // Box border: └ at bottom-left
    expect(result.cells[pos.startRow + 2][gridCol - 1].char).toBe("└");
    // Side border: │ on left
    expect(result.cells[pos.startRow][gridCol - 1].char).toBe("│");
  });

  test("main content is dimmed when palette is open", () => {
    const sidebar = createGrid(4, 14);
    const main = createGrid(20, 12);
    writeString(main, 0, 0, "visible row zero");

    const toolbar = {
      buttons: [],
      mainCols: 20,
      tabs: [],
    };

    const palette = createGrid(10, 2);
    writeString(palette, 0, 0, "palette   ");

    const result = compositeGrids(main, sidebar, toolbar, palette);
    // Main content at row 1 (below toolbar) should be dimmed
    expect(result.cells[1][5].dim).toBe(true); // "v" from "visible"
  });

  test("shadow appears on right and bottom edges", () => {
    const sidebar = createGrid(4, 20);
    const main = createGrid(30, 18);

    const toolbar = {
      buttons: [],
      mainCols: 30,
      tabs: [],
    };

    const palette = createGrid(10, 2);
    const result = compositeGrids(main, sidebar, toolbar, palette);

    const pos = getPalettePosition(30, 18, 10, 2, 1);
    const bRight = 4 + 1 + pos.startCol + 10; // sidebar + border + startCol + paletteWidth
    const bBottom = pos.startRow + 2; // startRow + paletteHeight

    // Shadow cell to the right of the border
    const shadowX = bRight + 1;
    if (shadowX < result.cols) {
      expect(result.cells[pos.startRow][shadowX].dim).toBe(true);
    }
    // Shadow cell below the border
    const shadowY = bBottom + 1;
    if (shadowY < result.rows) {
      expect(result.cells[shadowY][4 + 1 + pos.startCol].dim).toBe(true);
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
