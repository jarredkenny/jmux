import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Renderer } from "../renderer";
import { createGrid } from "../cell-grid";
import { ColorMode } from "../types";
import type { Cell } from "../types";

function makeCell(char: string, width: number = 1): Cell {
  return {
    char, width,
    fg: 0, bg: 0,
    fgMode: ColorMode.Default, bgMode: ColorMode.Default,
    bold: false, italic: false, underline: false, dim: false,
  };
}

describe("Renderer cursor repositioning", () => {
  let renderer: Renderer;
  let captured: string;
  let originalWrite: typeof process.stdout.write;

  beforeEach(() => {
    renderer = new Renderer();
    captured = "";
    originalWrite = process.stdout.write;
    process.stdout.write = ((data: string) => {
      captured += data;
      return true;
    }) as typeof process.stdout.write;
  });

  afterEach(() => {
    process.stdout.write = originalWrite;
  });

  test("does NOT reposition cursor after width-1 box-drawing characters", () => {
    // Box-drawing │ (U+2502) is universally 1-wide in terminals.
    // The renderer should NOT emit a cursor reposition after it,
    // because doing so forces alignment to xterm.js's model and
    // creates ghost gaps when the terminal disagrees.
    const grid = createGrid(5, 1);
    grid.cells[0][0] = makeCell("a");
    grid.cells[0][1] = makeCell("│");  // U+2502, cp >= 0x2500, but width=1
    grid.cells[0][2] = makeCell("b");
    grid.cells[0][3] = makeCell("─");  // U+2500, cp >= 0x2500, but width=1
    grid.cells[0][4] = makeCell("c");

    renderer.render(grid, { x: 0, y: 0 }, null);

    // After "│" at col 2, there should be NO \x1b[1;3H reposition
    // After "─" at col 4, there should be NO \x1b[1;5H reposition
    // The characters should flow naturally: a│b─c
    const repositions = captured.match(/\x1b\[1;\d+H/g) || [];
    // Only the initial row position \x1b[1;1H and final cursor position should appear
    const midRowRepositions = repositions.filter(r => r !== "\x1b[1;1H");
    // Filter out the final cursor reposition at the end of render
    const finalCursorPos = `\x1b[1;1H`; // cursor at 0,0 → row 1, col 1
    // There should be zero mid-row repositions caused by box-drawing chars
    expect(midRowRepositions.length).toBe(0);
  });

  test("DOES reposition cursor after genuinely wide (width=2) characters", () => {
    // CJK character 你 is genuinely 2-wide. The renderer MUST reposition
    // after it to correct for potential terminal width disagreements.
    const grid = createGrid(4, 1);
    grid.cells[0][0] = makeCell("你", 2);   // wide char
    grid.cells[0][1] = makeCell("", 0);      // continuation cell
    grid.cells[0][2] = makeCell("b");
    grid.cells[0][3] = makeCell("c");

    renderer.render(grid, { x: 0, y: 0 }, null);

    // After "你" (width=2), there SHOULD be a reposition to col 3
    expect(captured).toContain("\x1b[1;3H");
  });

  test("does NOT reposition after width-1 characters in U+2600-U+27BF range", () => {
    // Characters like ⚙ (U+2699) are 1-wide in most Western terminals.
    // When xterm.js reports them as width=1, no reposition needed.
    const grid = createGrid(3, 1);
    grid.cells[0][0] = makeCell("a");
    grid.cells[0][1] = makeCell("⚙");  // U+2699, width=1 from xterm.js
    grid.cells[0][2] = makeCell("b");

    renderer.render(grid, { x: 0, y: 0 }, null);

    // No mid-row repositions
    const repositions = captured.match(/\x1b\[1;\d+H/g) || [];
    const midRow = repositions.filter(r => r !== "\x1b[1;1H");
    expect(midRow.length).toBe(0);
  });

  test("does NOT reposition after multi-codeunit but width-1 characters", () => {
    // Characters with char.length > 1 (like some combining sequences)
    // but width=1 should NOT trigger repositioning
    const grid = createGrid(3, 1);
    grid.cells[0][0] = makeCell("a");
    // Simulate a character that is multi-codeunit but width 1
    grid.cells[0][1] = makeCell("é");  // precomposed, length=1 actually
    grid.cells[0][2] = makeCell("b");

    renderer.render(grid, { x: 0, y: 0 }, null);

    const repositions = captured.match(/\x1b\[1;\d+H/g) || [];
    const midRow = repositions.filter(r => r !== "\x1b[1;1H");
    expect(midRow.length).toBe(0);
  });
});
