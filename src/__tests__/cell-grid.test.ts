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
