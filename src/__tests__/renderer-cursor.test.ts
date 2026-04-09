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

  test("repositions cursor after non-ASCII width-1 characters to prevent drift", () => {
    // Non-ASCII characters (including box-drawing) trigger repositioning
    // to prevent accumulated drift from ambiguous-width characters.
    // For box-drawing chars (universally width 1), the CUP is a no-op
    // that adds no visual artifact but prevents drift if a preceding
    // ambiguous char caused the terminal cursor to advance differently.
    const grid = createGrid(5, 1);
    grid.cells[0][0] = makeCell("a");
    grid.cells[0][1] = makeCell("│");  // U+2502, non-ASCII → reposition
    grid.cells[0][2] = makeCell("b");
    grid.cells[0][3] = makeCell("─");  // U+2500, non-ASCII → reposition
    grid.cells[0][4] = makeCell("c");

    renderer.render(grid, { x: 0, y: 0 }, null);

    // After "│" at col 2 → reposition to col 3; after "─" at col 4 → reposition to col 5
    expect(captured).toContain("\x1b[1;3H");
    expect(captured).toContain("\x1b[1;5H");
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

  test("repositions after ambiguous-width symbols like U+2699", () => {
    // Characters like ⚙ (U+2699) may be width-2 in some terminals
    // but width-1 in xterm.js. Repositioning after them prevents
    // drift that would corrupt tmux pane borders on the same line.
    const grid = createGrid(3, 1);
    grid.cells[0][0] = makeCell("a");
    grid.cells[0][1] = makeCell("⚙");  // U+2699, non-ASCII → reposition
    grid.cells[0][2] = makeCell("b");

    renderer.render(grid, { x: 0, y: 0 }, null);

    // After "⚙" at col 2 → reposition to col 3
    expect(captured).toContain("\x1b[1;3H");
  });

  test("repositions after non-ASCII width-1 characters like é", () => {
    // Even characters like é (U+00E9) that are universally width 1
    // trigger repositioning because they're non-ASCII.  The CUP is
    // a no-op for these (no drift to correct) but the overhead is
    // negligible and keeps the rule simple: non-ASCII → reposition.
    const grid = createGrid(3, 1);
    grid.cells[0][0] = makeCell("a");
    grid.cells[0][1] = makeCell("é");  // U+00E9, non-ASCII → reposition
    grid.cells[0][2] = makeCell("b");

    renderer.render(grid, { x: 0, y: 0 }, null);

    // After "é" at col 2 → reposition to col 3
    expect(captured).toContain("\x1b[1;3H");
  });
});
