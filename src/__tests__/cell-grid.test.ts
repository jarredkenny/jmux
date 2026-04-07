import { describe, test, expect } from "bun:test";
import { createGrid, writeString, DEFAULT_CELL } from "../cell-grid";
import { ColorMode } from "../types";

describe("createGrid", () => {
  test("creates grid with correct dimensions", () => {
    const grid = createGrid(10, 5);
    expect(grid.cols).toBe(10);
    expect(grid.rows).toBe(5);
    expect(grid.cells.length).toBe(5);
    expect(grid.cells[0].length).toBe(10);
  });

  test("fills cells with spaces and default attributes", () => {
    const grid = createGrid(3, 2);
    const cell = grid.cells[0][0];
    expect(cell.char).toBe(" ");
    expect(cell.fg).toBe(0);
    expect(cell.bg).toBe(0);
    expect(cell.fgMode).toBe(ColorMode.Default);
    expect(cell.bgMode).toBe(ColorMode.Default);
    expect(cell.bold).toBe(false);
  });
});

describe("writeString", () => {
  test("writes characters at specified position", () => {
    const grid = createGrid(10, 3);
    writeString(grid, 1, 2, "hello");
    expect(grid.cells[1][2].char).toBe("h");
    expect(grid.cells[1][3].char).toBe("e");
    expect(grid.cells[1][4].char).toBe("l");
    expect(grid.cells[1][5].char).toBe("l");
    expect(grid.cells[1][6].char).toBe("o");
  });

  test("applies attributes to written characters", () => {
    const grid = createGrid(10, 3);
    writeString(grid, 0, 0, "hi", {
      fg: 2,
      fgMode: ColorMode.Palette,
      bold: true,
    });
    expect(grid.cells[0][0].fg).toBe(2);
    expect(grid.cells[0][0].fgMode).toBe(ColorMode.Palette);
    expect(grid.cells[0][0].bold).toBe(true);
    expect(grid.cells[0][1].bold).toBe(true);
  });

  test("truncates at grid boundary", () => {
    const grid = createGrid(5, 1);
    writeString(grid, 0, 3, "hello");
    expect(grid.cells[0][3].char).toBe("h");
    expect(grid.cells[0][4].char).toBe("e");
    // "llo" truncated — no crash
  });

  test("ignores writes outside grid bounds", () => {
    const grid = createGrid(5, 3);
    writeString(grid, 5, 0, "hello"); // row 5 doesn't exist
    // no crash
  });
});

describe("writeString with wide and multi-codepoint characters", () => {
  test("writes emoji (supplementary Unicode) as a single cell, not two surrogates", () => {
    // 🎉 is U+1F389 — a supplementary character that is 2 UTF-16 code units.
    // writeString should place the full character in one cell, not split it
    // into two surrogate halves.
    const grid = createGrid(10, 1);
    writeString(grid, 0, 0, "a🎉b");

    // "a" at col 0
    expect(grid.cells[0][0].char).toBe("a");
    // 🎉 at col 1 — should be the full emoji, not a surrogate half
    expect(grid.cells[0][1].char).toBe("🎉");
    // 🎉 is 2-wide, so col 2 should be a continuation cell
    expect(grid.cells[0][2].width).toBe(0);
    // "b" should be at col 3 (after the 2-wide emoji)
    expect(grid.cells[0][3].char).toBe("b");
  });

  test("sets width=2 for wide characters and inserts continuation cells", () => {
    // CJK character 你 (U+4F60) is 2 terminal columns wide
    const grid = createGrid(10, 1);
    writeString(grid, 0, 0, "a你b");

    expect(grid.cells[0][0].char).toBe("a");
    expect(grid.cells[0][0].width).toBe(1);
    // 你 at col 1, width 2
    expect(grid.cells[0][1].char).toBe("你");
    expect(grid.cells[0][1].width).toBe(2);
    // col 2 is continuation
    expect(grid.cells[0][2].width).toBe(0);
    expect(grid.cells[0][2].char).toBe("");
    // "b" at col 3
    expect(grid.cells[0][3].char).toBe("b");
  });

  test("box-drawing characters remain width=1", () => {
    const grid = createGrid(5, 1);
    writeString(grid, 0, 0, "─│┌");

    expect(grid.cells[0][0].char).toBe("─");
    expect(grid.cells[0][0].width).toBe(1);
    expect(grid.cells[0][1].char).toBe("│");
    expect(grid.cells[0][1].width).toBe(1);
    expect(grid.cells[0][2].char).toBe("┌");
    expect(grid.cells[0][2].width).toBe(1);
  });

  test("truncates wide character that would overflow grid boundary", () => {
    // If a 2-wide character starts at the last column, it shouldn't
    // write a half-character — it should be omitted
    const grid = createGrid(3, 1);
    writeString(grid, 0, 0, "a你");

    expect(grid.cells[0][0].char).toBe("a");
    // 你 starts at col 1 but needs cols 1-2. Col 2 is the last col (index 2).
    // It should fit: col 1 = char, col 2 = continuation
    expect(grid.cells[0][1].char).toBe("你");
    expect(grid.cells[0][1].width).toBe(2);
    expect(grid.cells[0][2].width).toBe(0);
  });

  test("wide character at exact boundary is omitted", () => {
    // Grid is 2 cols wide. "a" takes col 0. 你 needs cols 1-2 but col 2 doesn't exist.
    const grid = createGrid(2, 1);
    writeString(grid, 0, 0, "a你");

    expect(grid.cells[0][0].char).toBe("a");
    // 你 can't fit — needs 2 cols but only 1 remains. Should be skipped.
    expect(grid.cells[0][1].char).toBe(" "); // default unchanged
  });
});

describe("DEFAULT_CELL", () => {
  test("is a space with default colors and no attributes", () => {
    expect(DEFAULT_CELL.char).toBe(" ");
    expect(DEFAULT_CELL.fgMode).toBe(ColorMode.Default);
    expect(DEFAULT_CELL.bgMode).toBe(ColorMode.Default);
    expect(DEFAULT_CELL.bold).toBe(false);
    expect(DEFAULT_CELL.italic).toBe(false);
    expect(DEFAULT_CELL.underline).toBe(false);
    expect(DEFAULT_CELL.dim).toBe(false);
  });
});
