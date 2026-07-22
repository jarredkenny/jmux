import { describe, test, expect } from "bun:test";
import {
  createGrid, writeString, writeCell, blit, DEFAULT_CELL,
  truncateToCols, writeStyledLine, drawBox, textCols,
  type CellAttrs, type StyledSegment,
} from "../cell-grid";
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
  function fillGrid(grid: ReturnType<typeof createGrid>, ch: string, attrs?: CellAttrs) {
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
    // Fill with distinct per-cell content to detect offset bugs
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        src.cells[r][c] = { ...src.cells[r][c], char: `${r}${c}` };
      }
    }
    const dst = createGrid(4, 4);
    blit(dst, src, { destX: 2, destY: 2 }); // needs cols 2-4, rows 2-4 but dst is 4x4 (indices 0-3)
    // Verify correct source cells landed at destination
    expect(dst.cells[2][2].char).toBe("00");
    expect(dst.cells[2][3].char).toBe("01");
    expect(dst.cells[3][2].char).toBe("10");
    expect(dst.cells[3][3].char).toBe("11");
    // no throw, no out-of-range writes — grid stays 4x4
    expect(dst.cells.length).toBe(4);
    expect(dst.cells[0].length).toBe(4);
  });

  test("clips silently when destX/destY are negative (off the top-left edge)", () => {
    const src = createGrid(3, 3);
    // Fill with distinct per-cell content to detect offset bugs
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        src.cells[r][c] = { ...src.cells[r][c], char: `${r}${c}` };
      }
    }
    const dst = createGrid(4, 4);
    blit(dst, src, { destX: -1, destY: -1 });
    // Only the portion that lands in-bounds should be copied: src (1,1)-(2,2) -> dst (0,0)-(1,1)
    expect(dst.cells[0][0].char).toBe("11");
    expect(dst.cells[0][1].char).toBe("12");
    expect(dst.cells[1][0].char).toBe("21");
    expect(dst.cells[1][1].char).toBe("22");
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

  test("copies nothing when w is 0 and leaves destination untouched", () => {
    const src = createGrid(3, 3);
    fillGrid(src, "s");
    const dst = createGrid(3, 3);
    fillGrid(dst, "d");
    blit(dst, src, { destX: 0, destY: 0, w: 0, h: 3 });
    // All destination cells should remain "d" — nothing copied
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        expect(dst.cells[r][c].char).toBe("d");
      }
    }
  });

  test("copies nothing when h is 0 and leaves destination untouched", () => {
    const src = createGrid(3, 3);
    fillGrid(src, "s");
    const dst = createGrid(3, 3);
    fillGrid(dst, "d");
    blit(dst, src, { destX: 0, destY: 0, w: 3, h: 0 });
    // All destination cells should remain "d" — nothing copied
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        expect(dst.cells[r][c].char).toBe("d");
      }
    }
  });

  test("copies nothing when w is negative and leaves destination untouched", () => {
    const src = createGrid(3, 3);
    fillGrid(src, "s");
    const dst = createGrid(3, 3);
    fillGrid(dst, "d");
    blit(dst, src, { destX: 0, destY: 0, w: -1, h: 3 });
    // All destination cells should remain "d" — nothing copied
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        expect(dst.cells[r][c].char).toBe("d");
      }
    }
  });

  test("copies nothing when h is negative and leaves destination untouched", () => {
    const src = createGrid(3, 3);
    fillGrid(src, "s");
    const dst = createGrid(3, 3);
    fillGrid(dst, "d");
    blit(dst, src, { destX: 0, destY: 0, w: 3, h: -1 });
    // All destination cells should remain "d" — nothing copied
    for (let r = 0; r < 3; r++) {
      for (let c = 0; c < 3; c++) {
        expect(dst.cells[r][c].char).toBe("d");
      }
    }
  });
});

describe("truncateToCols", () => {
  test("returns text unchanged when it fits exactly", () => {
    expect(truncateToCols("hello", 5)).toBe("hello");
  });

  test("returns text unchanged when it is shorter than maxCols", () => {
    expect(truncateToCols("hi", 10)).toBe("hi");
  });

  test("truncates and appends an ellipsis when one column over", () => {
    const result = truncateToCols("hello!", 5);
    expect(result).toBe("hell…");
    expect(textCols(result)).toBe(5);
  });

  test("does not split a wide character at the truncation boundary", () => {
    // "ab你" is 1+1+2 = 4 cols wide. maxCols=3 leaves budget=2 after the
    // ellipsis; 你 (width 2) would overflow that budget, so it must be
    // dropped whole rather than rendered as a half-glyph.
    const result = truncateToCols("ab你", 3);
    expect(result).toBe("ab…");
    expect(textCols(result)).toBe(3);
  });

  test("drops a leading wide character entirely when there's no budget for it", () => {
    // "你b" is 2+1 = 3 cols. maxCols=2 leaves budget=1 for content, but 你
    // needs 2 — it must be skipped, leaving just the ellipsis.
    const result = truncateToCols("你b", 2);
    expect(result).toBe("…");
    expect(textCols(result)).toBe(1);
  });

  test("maxCols of 0 or negative returns empty string", () => {
    expect(truncateToCols("hello", 0)).toBe("");
    expect(truncateToCols("hello", -3)).toBe("");
  });

  test("maxCols of 1 with overflowing text returns just the ellipsis", () => {
    expect(truncateToCols("hello", 1)).toBe("…");
  });

  test("empty string input returns empty string regardless of maxCols", () => {
    expect(truncateToCols("", 5)).toBe("");
  });
});

describe("writeStyledLine", () => {
  test("writes multiple segments left-to-right with their own attrs", () => {
    const grid = createGrid(20, 1);
    const segments: StyledSegment[] = [
      { text: "AB", attrs: { fg: 1, fgMode: ColorMode.Palette } },
      { text: "cd", attrs: { fg: 2, fgMode: ColorMode.Palette } },
    ];
    const consumed = writeStyledLine(grid, 0, 2, segments);
    expect(consumed).toBe(4);
    expect(grid.cells[0][2].char).toBe("A");
    expect(grid.cells[0][2].fg).toBe(1);
    expect(grid.cells[0][3].char).toBe("B");
    expect(grid.cells[0][3].fg).toBe(1);
    expect(grid.cells[0][4].char).toBe("c");
    expect(grid.cells[0][4].fg).toBe(2);
    expect(grid.cells[0][5].char).toBe("d");
    expect(grid.cells[0][5].fg).toBe(2);
  });

  test("clips output at maxCols and returns the columns actually consumed", () => {
    const grid = createGrid(10, 1);
    const segments: StyledSegment[] = [{ text: "hello world", attrs: {} }];
    const consumed = writeStyledLine(grid, 0, 0, segments, 5);
    expect(consumed).toBe(5);
    expect(grid.cells[0][4].char).toBe("o");
    // Nothing beyond the clip should have been written.
    expect(grid.cells[0][5].char).toBe(" ");
  });

  test("refuses to split a wide character across the clip boundary", () => {
    // "a你" is 1 + 2 = 3 cols wide. Clipping to maxCols=2 leaves only 1 col
    // free for 你 (width 2) after "a" — it must not be half-written.
    const grid = createGrid(10, 1);
    const segments: StyledSegment[] = [{ text: "a你", attrs: {} }];
    const consumed = writeStyledLine(grid, 0, 0, segments, 2);
    expect(consumed).toBe(1);
    expect(grid.cells[0][0].char).toBe("a");
    // The wide glyph's column must remain untouched — no partial write.
    expect(grid.cells[0][1].char).toBe(" ");
  });

  test("goes through writeCell's continuation-cell rule for wide glyphs", () => {
    const grid = createGrid(10, 1);
    const segments: StyledSegment[] = [{ text: "你", attrs: { fg: 3, fgMode: ColorMode.Palette } }];
    const consumed = writeStyledLine(grid, 0, 1, segments);
    expect(consumed).toBe(2);
    expect(grid.cells[0][1].char).toBe("你");
    expect(grid.cells[0][1].width).toBe(2);
    expect(grid.cells[0][2].width).toBe(0);
    expect(grid.cells[0][2].char).toBe("");
  });

  test("returns 0 when the starting column is already out of bounds", () => {
    const grid = createGrid(5, 1);
    const consumed = writeStyledLine(grid, 0, 10, [{ text: "x", attrs: {} }]);
    expect(consumed).toBe(0);
  });

  test("a wide glyph in a non-final segment advances the next segment's start column by 2", () => {
    // Pins the drift class this whole task exists to prevent: a wide glyph
    // mid-line must push everything after it two columns, not one.
    const grid = createGrid(20, 1);
    const segments: StyledSegment[] = [
      { text: "a你", attrs: { fg: 1, fgMode: ColorMode.Palette } },
      { text: "bc", attrs: { fg: 2, fgMode: ColorMode.Palette } },
    ];
    const consumed = writeStyledLine(grid, 0, 0, segments);
    // "a"(1) + "你"(2) + "bc"(2) = 5 display columns.
    expect(consumed).toBe(5);
    expect(grid.cells[0][0].char).toBe("a");
    expect(grid.cells[0][1].char).toBe("你");
    expect(grid.cells[0][1].width).toBe(2);
    expect(grid.cells[0][2].char).toBe(""); // continuation cell
    expect(grid.cells[0][2].width).toBe(0);
    // Segment 2 must start at column 3, not column 2 — one past the wide
    // glyph's continuation cell.
    expect(grid.cells[0][3].char).toBe("b");
    expect(grid.cells[0][3].fg).toBe(2);
    expect(grid.cells[0][4].char).toBe("c");
    expect(grid.cells[0][4].fg).toBe(2);
  });
});

describe("drawBox", () => {
  const border: CellAttrs = { fg: 2, fgMode: ColorMode.Palette };

  test("draws the four corners", () => {
    const grid = createGrid(10, 5);
    drawBox(grid, { x: 1, y: 1, w: 6, h: 3 }, { border });
    expect(grid.cells[1][1].char).toBe("┌"); // ┌
    expect(grid.cells[1][6].char).toBe("┐"); // ┐
    expect(grid.cells[3][1].char).toBe("└"); // └
    expect(grid.cells[3][6].char).toBe("┘"); // ┘
    for (const [r, c] of [[1, 1], [1, 6], [3, 1], [3, 6]]) {
      expect(grid.cells[r][c].fg).toBe(2);
      expect(grid.cells[r][c].fgMode).toBe(ColorMode.Palette);
    }
  });

  test("draws top/bottom edges with ─ and side edges with │", () => {
    const grid = createGrid(10, 5);
    drawBox(grid, { x: 1, y: 1, w: 6, h: 3 }, { border });
    expect(grid.cells[1][3].char).toBe("─"); // ─ top
    expect(grid.cells[3][3].char).toBe("─"); // ─ bottom
    expect(grid.cells[2][1].char).toBe("│"); // │ left
    expect(grid.cells[2][6].char).toBe("│"); // │ right
    // Interior is left untouched by drawBox.
    expect(grid.cells[2][3].char).toBe(" ");
  });

  test("resets stray attributes (dim/bold/link) left behind on the border ring", () => {
    const grid = createGrid(10, 5);
    // Simulate residual content (e.g. a dimmed, linked cell from an
    // underlying blit) at a coordinate the border ring will overwrite.
    grid.cells[1][3] = { ...DEFAULT_CELL, char: "x", dim: true, bold: true, link: "https://example.com" };
    drawBox(grid, { x: 1, y: 1, w: 6, h: 3 }, { border });
    expect(grid.cells[1][3].char).toBe("─");
    expect(grid.cells[1][3].dim).toBe(false);
    expect(grid.cells[1][3].bold).toBe(false);
    expect(grid.cells[1][3].link).toBeUndefined();
  });

  test("renders a label chip on the top border, wrapped in spaces", () => {
    const grid = createGrid(20, 5);
    drawBox(grid, { x: 0, y: 0, w: 16, h: 4 }, {
      border,
      label: "hi",
      labelAttrs: { fg: 9, fgMode: ColorMode.Palette, bold: true },
    });
    // ┌ ─ <space> h i <space> ─ ─ ... ┐  — label starts at col 3
    expect(grid.cells[0][2].char).toBe(" ");
    expect(grid.cells[0][3].char).toBe("h");
    expect(grid.cells[0][3].fg).toBe(9);
    expect(grid.cells[0][3].bold).toBe(true);
    expect(grid.cells[0][4].char).toBe("i");
    expect(grid.cells[0][5].char).toBe(" ");
  });

  test("truncates an overlong label to fit the box width", () => {
    const grid = createGrid(20, 5);
    drawBox(grid, { x: 0, y: 0, w: 8, h: 3 }, {
      border,
      label: "a very long label that cannot possibly fit",
    });
    // Row must not contain the untruncated label; the right corner must
    // still land at the box's own right edge (col 7).
    expect(grid.cells[0][7].char).toBe("┐"); // ┐ — box width respected
    const rowChars = grid.cells[0].map(c => c.char).join("");
    expect(rowChars).toContain("…"); // ellipsis present somewhere
  });

  test("no-ops when width or height is below 2", () => {
    const grid = createGrid(10, 5);
    drawBox(grid, { x: 1, y: 1, w: 1, h: 3 }, { border });
    expect(grid.cells[1][1].char).toBe(" ");
    drawBox(grid, { x: 1, y: 1, w: 6, h: 1 }, { border });
    expect(grid.cells[1][1].char).toBe(" ");
  });

  test("truncates a wide-character label without a stray trailing-space artifact (pinned)", () => {
    // Regression pin: the deleted drawBorderRow packed characters up to
    // maxLabelCols with no ellipsis column reserved, then replaced the last
    // packed char with "…" — placing the chip's trailing space at the
    // pre-truncation width and leaving a border-coloured hole for wide
    // labels. truncateToCols reserves the ellipsis column up front instead,
    // so "你好世界和平" truncated to 5 cols is "你好…", not "你…" + a gap.
    const grid = createGrid(20, 3);
    drawBox(grid, { x: 0, y: 0, w: 10, h: 3 }, {
      border,
      label: "你好世界和平",
    });
    expect(grid.cells[0][2].char).toBe(" ");
    expect(grid.cells[0][3].char).toBe("你");
    expect(grid.cells[0][3].width).toBe(2);
    expect(grid.cells[0][4].char).toBe("");
    expect(grid.cells[0][4].width).toBe(0);
    expect(grid.cells[0][5].char).toBe("好");
    expect(grid.cells[0][5].width).toBe(2);
    expect(grid.cells[0][6].char).toBe("");
    expect(grid.cells[0][6].width).toBe(0);
    expect(grid.cells[0][7].char).toBe("…");
    expect(grid.cells[0][8].char).toBe(" ");
    // The right corner still lands at the box's own right edge — no hole.
    expect(grid.cells[0][9].char).toBe("┐");
  });

  test("an explicitly-undefined border attr does not defeat the attribute reset", () => {
    // Regression pin for the undefined-key trap: `{ ...defaults, ...{ bold:
    // undefined } }` yields `{ bold: undefined }` in plain JS spreading,
    // which would silently reintroduce the stale-attribute bug the reset
    // exists to prevent. drawBox must filter undefined keys out first.
    const grid = createGrid(10, 5);
    grid.cells[1][3] = { ...DEFAULT_CELL, char: "x", bold: true, dim: true, link: "https://example.com" };
    drawBox(grid, { x: 1, y: 1, w: 6, h: 3 }, {
      border: { fg: 2, fgMode: ColorMode.Palette, bold: undefined },
    });
    expect(grid.cells[1][3].char).toBe("─");
    expect(grid.cells[1][3].bold).toBe(false);
    expect(grid.cells[1][3].dim).toBe(false);
    expect(grid.cells[1][3].link).toBeUndefined();
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
