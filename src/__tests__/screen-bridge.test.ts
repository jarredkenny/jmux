import { describe, test, expect } from "bun:test";
import { ScreenBridge } from "../screen-bridge";
import { ColorMode } from "../types";

describe("ScreenBridge", () => {
  test("returns empty grid with spaces before any writes", () => {
    const bridge = new ScreenBridge(10, 5);
    const grid = bridge.getGrid();
    expect(grid.cols).toBe(10);
    expect(grid.rows).toBe(5);
    expect(grid.cells[0][0].char).toBe(" ");
  });

  test("captures plain text written to terminal", async () => {
    const bridge = new ScreenBridge(10, 3);
    await bridge.write("Hello");
    const grid = bridge.getGrid();
    expect(grid.cells[0][0].char).toBe("H");
    expect(grid.cells[0][1].char).toBe("e");
    expect(grid.cells[0][2].char).toBe("l");
    expect(grid.cells[0][3].char).toBe("l");
    expect(grid.cells[0][4].char).toBe("o");
    expect(grid.cells[0][5].char).toBe(" ");
  });

  test("captures bold SGR attribute", async () => {
    const bridge = new ScreenBridge(10, 3);
    await bridge.write("\x1b[1mBold\x1b[0m");
    const grid = bridge.getGrid();
    expect(grid.cells[0][0].char).toBe("B");
    expect(grid.cells[0][0].bold).toBe(true);
    expect(grid.cells[0][3].char).toBe("d");
    expect(grid.cells[0][3].bold).toBe(true);
  });

  test("captures foreground palette color", async () => {
    const bridge = new ScreenBridge(10, 3);
    // SGR 31 = red foreground (ANSI color 1)
    await bridge.write("\x1b[31mRed\x1b[0m");
    const grid = bridge.getGrid();
    expect(grid.cells[0][0].char).toBe("R");
    expect(grid.cells[0][0].fg).toBe(1);
    expect(grid.cells[0][0].fgMode).toBe(ColorMode.Palette);
  });

  test("reports cursor position", async () => {
    const bridge = new ScreenBridge(10, 3);
    await bridge.write("Hi");
    const cursor = bridge.getCursor();
    expect(cursor.x).toBe(2);
    expect(cursor.y).toBe(0);
  });

  test("handles resize", async () => {
    const bridge = new ScreenBridge(10, 3);
    bridge.resize(20, 5);
    const grid = bridge.getGrid();
    expect(grid.cols).toBe(20);
    expect(grid.rows).toBe(5);
  });
});
