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

  test("reports correct width for common Unicode characters", async () => {
    // These characters appear frequently in Claude Code / CLI output.
    // xterm.js must classify their widths correctly or the renderer
    // will create ghost gaps (for 2-wide misclass) or overlap (for 1-wide misclass).
    const bridge = new ScreenBridge(40, 1);

    // Write a line with various Unicode characters
    // en-dash, bullet, box-drawing, CJK, emoji
    await bridge.write("a–b•c│d你f🎉h");
    const grid = bridge.getGrid();

    // ASCII: always 1-wide
    expect(grid.cells[0][0].char).toBe("a");
    expect(grid.cells[0][0].width).toBe(1);

    // en-dash (U+2013): must be 1-wide
    expect(grid.cells[0][1].char).toBe("–");
    expect(grid.cells[0][1].width).toBe(1);

    // bullet (U+2022): must be 1-wide
    expect(grid.cells[0][3].char).toBe("•");
    expect(grid.cells[0][3].width).toBe(1);

    // box-drawing │ (U+2502): must be 1-wide
    expect(grid.cells[0][5].char).toBe("│");
    expect(grid.cells[0][5].width).toBe(1);

    // CJK 你 (U+4F60): must be 2-wide
    expect(grid.cells[0][7].char).toBe("你");
    expect(grid.cells[0][7].width).toBe(2);
    expect(grid.cells[0][8].width).toBe(0); // continuation

    // After 你 (2-wide), "f" is at col 9
    expect(grid.cells[0][9].char).toBe("f");

    // 🎉 (U+1F389): must be 2-wide
    expect(grid.cells[0][10].char).toBe("🎉");
    expect(grid.cells[0][10].width).toBe(2);
    expect(grid.cells[0][11].width).toBe(0); // continuation

    // "h" after the emoji
    expect(grid.cells[0][12].char).toBe("h");
  });

  test("handles resize", async () => {
    const bridge = new ScreenBridge(10, 3);
    bridge.resize(20, 5);
    const grid = bridge.getGrid();
    expect(grid.cols).toBe(20);
    expect(grid.rows).toBe(5);
  });
});
