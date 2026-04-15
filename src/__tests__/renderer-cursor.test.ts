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

  test("does NOT reposition cursor after width-1 non-ASCII characters", () => {
    // Width-1 non-ASCII characters (box-drawing, bullets, arrows, Latin
    // Extended) are emitted without CUP sequences so the terminal sees
    // contiguous text runs.  This is critical for URL detection — terminal
    // emulators match URLs across contiguous output, and CUPs after every
    // non-ASCII char broke that matching.
    const grid = createGrid(5, 1);
    grid.cells[0][0] = makeCell("a");
    grid.cells[0][1] = makeCell("│");  // U+2502, width 1 → no reposition
    grid.cells[0][2] = makeCell("b");
    grid.cells[0][3] = makeCell("─");  // U+2500, width 1 → no reposition
    grid.cells[0][4] = makeCell("c");

    renderer.render(grid, { x: 0, y: 0 }, null);

    // No CUP sequences between characters — all emitted contiguously
    expect(captured).not.toContain("\x1b[1;3H");
    expect(captured).not.toContain("\x1b[1;5H");
    expect(captured).toContain("a│b─c");
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

  test("does NOT reposition after width-1 symbols like U+2699", () => {
    // Characters like ⚙ (U+2699) are width 1 in xterm.js and most
    // terminals.  While some terminals may render them wider, the
    // cost of repositioning (breaking URL detection) outweighs the
    // benefit of correcting rare width disagreements.
    const grid = createGrid(3, 1);
    grid.cells[0][0] = makeCell("a");
    grid.cells[0][1] = makeCell("⚙");  // U+2699, width 1 → no reposition
    grid.cells[0][2] = makeCell("b");

    renderer.render(grid, { x: 0, y: 0 }, null);

    expect(captured).not.toContain("\x1b[1;3H");
    expect(captured).toContain("a⚙b");
  });

  test("does NOT reposition after Latin Extended characters like é", () => {
    // Characters like é (U+00E9) are universally width 1 in every
    // terminal.  No repositioning needed.
    const grid = createGrid(3, 1);
    grid.cells[0][0] = makeCell("a");
    grid.cells[0][1] = makeCell("é");  // U+00E9, width 1 → no reposition
    grid.cells[0][2] = makeCell("b");

    renderer.render(grid, { x: 0, y: 0 }, null);

    expect(captured).not.toContain("\x1b[1;3H");
    expect(captured).toContain("aéb");
  });
});
