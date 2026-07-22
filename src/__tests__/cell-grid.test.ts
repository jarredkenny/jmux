import { describe, test, expect } from "bun:test";
import { createGrid, writeString, writeCell, blit, DEFAULT_CELL } from "../cell-grid";
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

describe("writeCell", () => {
  test("writes a normal-width character and returns advance 1", () => {
    const grid = createGrid(5, 1);
    const advance = writeCell(grid, 0, 2, "x");
    expect(advance).toBe(1);
    expect(grid.cells[0][2].char).toBe("x");
    expect(grid.cells[0][2].width).toBe(1);
  });

  test("writes a wide glyph plus a width-0 continuation cell and returns advance 2", () => {
    const grid = createGrid(5, 1);
    const advance = writeCell(grid, 0, 1, "你");
    expect(advance).toBe(2);
    expect(grid.cells[0][1].char).toBe("你");
    expect(grid.cells[0][1].width).toBe(2);
    expect(grid.cells[0][2].char).toBe("");
    expect(grid.cells[0][2].width).toBe(0);
  });

  test("propagates bg/bgMode onto the continuation cell but not fg or other attrs", () => {
    const grid = createGrid(5, 1);
    writeCell(grid, 0, 1, "你", {
      fg: 3,
      fgMode: ColorMode.Palette,
      bg: 4,
      bgMode: ColorMode.RGB,
      bold: true,
    });
    expect(grid.cells[0][1].fg).toBe(3);
    expect(grid.cells[0][1].bold).toBe(true);
    // Continuation cell gets only the background, matching writeString.
    expect(grid.cells[0][2].bg).toBe(4);
    expect(grid.cells[0][2].bgMode).toBe(ColorMode.RGB);
    expect(grid.cells[0][2].fg).toBe(0); // untouched — DEFAULT_CELL fg
    expect(grid.cells[0][2].bold).toBe(false); // untouched
  });

  test("refuses a wide glyph that would overflow the row's last column", () => {
    const grid = createGrid(3, 1);
    const advance = writeCell(grid, 0, 2, "你"); // needs cols 2-3, but col 3 doesn't exist
    expect(advance).toBe(0);
    // Cell must be left completely unchanged — no half-write.
    expect(grid.cells[0][2].char).toBe(" ");
    expect(grid.cells[0][2].width).toBe(1);
  });

  test("no-ops out of bounds (row, negative col, col past edge)", () => {
    const grid = createGrid(3, 2);
    expect(writeCell(grid, 5, 0, "x")).toBe(0);
    expect(writeCell(grid, 0, -1, "x")).toBe(0);
    expect(writeCell(grid, 0, 3, "x")).toBe(0);
    // Grid untouched
    expect(grid.cells[0][0].char).toBe(" ");
  });
});

describe("blit", () => {
  function fillGrid(grid: ReturnType<typeof createGrid>, ch: string, attrs?: Parameters<typeof writeString>[4]) {
    for (let r = 0; r < grid.rows; r++) {
      for (let c = 0; c < grid.cols; c++) {
        grid.cells[r][c] = { ...grid.cells[r][c], char: ch, width: 1, ...(attrs ?? {}) };
      }
    }
  }

  test("copies a full-grid rectangle by default", () => {
    const src = createGrid(3, 2);
    fillGrid(src, "s");
    const dst = createGrid(5, 4);
    blit(dst, src, { destX: 1, destY: 1 });
    for (let r = 0; r < 2; r++) {
      for (let c = 0; c < 3; c++) {
        expect(dst.cells[1 + r][1 + c].char).toBe("s");
      }
    }
    // Untouched outside the copy rect
    expect(dst.cells[0][0].char).toBe(" ");
    expect(dst.cells[3][4].char).toBe(" ");
  });

  test("copies a specified sub-rectangle via srcX/srcY/w/h", () => {
    const src = createGrid(4, 4);
    for (let r = 0; r < 4; r++) {
      for (let c = 0; c < 4; c++) {
        src.cells[r][c] = { ...src.cells[r][c], char: `${r}${c}` };
      }
    }
    const dst = createGrid(4, 4);
    blit(dst, src, { destX: 0, destY: 0, srcX: 1, srcY: 1, w: 2, h: 2 });
    expect(dst.cells[0][0].char).toBe("11");
    expect(dst.cells[0][1].char).toBe("12");
    expect(dst.cells[1][0].char).toBe("21");
    expect(dst.cells[1][1].char).toBe("22");
  });

  test("clips silently when the destination rectangle runs off the right/bottom edge", () => {
    const src = createGrid(3, 3);
    fillGrid(src, "s");
    const dst = createGrid(4, 4);
    blit(dst, src, { destX: 2, destY: 2 }); // needs cols 2-4, rows 2-4 but dst is 4x4 (indices 0-3)
    expect(dst.cells[2][2].char).toBe("s");
    expect(dst.cells[2][3].char).toBe("s");
    expect(dst.cells[3][2].char).toBe("s");
    expect(dst.cells[3][3].char).toBe("s");
    // no throw, no out-of-range writes — grid stays 4x4
    expect(dst.cells.length).toBe(4);
    expect(dst.cells[0].length).toBe(4);
  });

  test("clips silently when destX/destY are negative (off the top-left edge)", () => {
    const src = createGrid(3, 3);
    fillGrid(src, "s");
    const dst = createGrid(4, 4);
    blit(dst, src, { destX: -1, destY: -1 });
    // Only the portion that lands in-bounds should be copied: src (1,1)-(2,2) -> dst (0,0)-(1,1)
    expect(dst.cells[0][0].char).toBe("s");
    expect(dst.cells[1][1].char).toBe("s");
  });

  test("a wide glyph at the copy edge becomes a space carrying the source's attributes", () => {
    const src = createGrid(4, 1);
    writeCell(src, 0, 1, "你", { fg: 7, bg: 9, bold: true });
    const dst = createGrid(4, 1);
    // Copy width 2 starting at srcX 0: cols 0,1 — col 1 is the head of a wide
    // glyph whose continuation (col 2) falls outside the copy rectangle.
    blit(dst, src, { destX: 0, destY: 0, srcX: 0, srcY: 0, w: 2, h: 1 });
    expect(dst.cells[0][1].char).toBe(" ");
    expect(dst.cells[0][1].width).toBe(1);
    expect(dst.cells[0][1].fg).toBe(7);
    expect(dst.cells[0][1].bg).toBe(9);
    expect(dst.cells[0][1].bold).toBe(true);
  });

  test("does not turn a wide glyph into a space when its continuation is inside the copy rectangle", () => {
    const src = createGrid(4, 1);
    writeCell(src, 0, 1, "你");
    const dst = createGrid(4, 1);
    blit(dst, src, { destX: 0, destY: 0, w: 4, h: 1 });
    expect(dst.cells[0][1].char).toBe("你");
    expect(dst.cells[0][1].width).toBe(2);
    expect(dst.cells[0][2].char).toBe("");
    expect(dst.cells[0][2].width).toBe(0);
  });

  test("clips when the source rectangle exceeds source grid bounds", () => {
    const src = createGrid(2, 2);
    fillGrid(src, "s");
    const dst = createGrid(5, 5);
    blit(dst, src, { destX: 0, destY: 0, w: 5, h: 5 }); // w/h exceed src's 2x2
    expect(dst.cells[0][0].char).toBe("s");
    expect(dst.cells[1][1].char).toBe("s");
    // Beyond source bounds — untouched
    expect(dst.cells[2][2].char).toBe(" ");
    expect(dst.cells[4][4].char).toBe(" ");
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
