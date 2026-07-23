import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Renderer } from "../renderer";
import { createGrid } from "../cell-grid";
import { ColorMode } from "../types";
import type { Cell } from "../types";
import type { FrameLayout, Span } from "../frame-layout";

function makeCell(char: string, width: number = 1): Cell {
  return {
    char, width,
    fg: 0, bg: 0,
    fgMode: ColorMode.Default, bgMode: ColorMode.Default,
    bold: false, italic: false, underline: false, dim: false,
  };
}

// Hand-rolled FrameLayout fixtures — see the equivalent helper in
// renderer.test.ts for why these bypass computeFrameLayout's
// SIDEBAR_MIN_TERM_COLS gate (these grids are far smaller than a real
// terminal).
// toolbarRows is 0 in both fixtures, so pre-chrome semantics apply: no rule
// or footer rows, and the content band is the whole frame (contentRows ===
// ptyRows === termRows), matching computeFrameLayout with both chrome flags
// off.
function noSidebarLayout(mainCols: number, termRows: number): FrameLayout {
  return {
    termCols: mainCols, termRows, sidebar: null, borderCol: null,
    toolbarRows: 0, topRuleRow: null, contentTop: 0, contentRows: termRows,
    footerRuleRow: null, footerRow: null,
    chrome: { toolbar: false, topRule: false, footerRule: false, footer: false },
    ptyRows: termRows, mode: "single",
    main: { x: 0, w: mainCols }, divider: null, panel: null,
  };
}

function withSidebarLayout(sidebarCols: number, mainCols: number, termRows: number): FrameLayout {
  const sidebar: Span = { x: 0, w: sidebarCols };
  const mainX = sidebarCols + 1;
  return {
    termCols: sidebarCols + 1 + mainCols, termRows, sidebar, borderCol: sidebarCols,
    toolbarRows: 0, topRuleRow: null, contentTop: 0, contentRows: termRows,
    footerRuleRow: null, footerRow: null,
    chrome: { toolbar: false, topRule: false, footerRule: false, footer: false },
    ptyRows: termRows, mode: "single",
    main: { x: mainX, w: mainCols }, divider: null, panel: null,
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

    renderer.render(noSidebarLayout(5, 1), grid, { x: 0, y: 0 }, null);

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

    renderer.render(noSidebarLayout(4, 1), grid, { x: 0, y: 0 }, null);

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

    renderer.render(noSidebarLayout(3, 1), grid, { x: 0, y: 0 }, null);

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

    renderer.render(noSidebarLayout(3, 1), grid, { x: 0, y: 0 }, null);

    expect(captured).not.toContain("\x1b[1;3H");
    expect(captured).toContain("aéb");
  });
});

describe("Renderer.getLinkAt", () => {
  let renderer: Renderer;
  let originalWrite: typeof process.stdout.write;

  beforeEach(() => {
    renderer = new Renderer();
    originalWrite = process.stdout.write;
    process.stdout.write = (() => true) as typeof process.stdout.write;
  });
  afterEach(() => { process.stdout.write = originalWrite; });

  test("returns the link at the composited absolute coords a click maps to", () => {
    // A link in the main grid must be findable by getLinkAt at its ABSOLUTE
    // composited position (shifted right by sidebar.cols + 1 border). This is
    // the contract the input router relies on: getLinkAt(mouse.x-1, mouse.y-1).
    const main = createGrid(40, 3);
    const url = "https://example.com";
    const mainX = 2;
    for (let i = 0; i < url.length; i++) {
      main.cells[1][mainX + i] = { ...makeCell(url[i]), link: url };
    }
    const sidebar = createGrid(6, 3); // cols 0..5, border at col 6

    renderer.render(withSidebarLayout(6, 40, 3), main, { x: 0, y: 0 }, sidebar);

    const absX = sidebar.cols + 1 + mainX; // 6 + 1 + 2 = 9
    expect(renderer.getLinkAt(absX, 1)).toBe(url);
    expect(renderer.getLinkAt(absX + url.length - 1, 1)).toBe(url); // last char
    expect(renderer.getLinkAt(absX - 1, 1)).toBeUndefined(); // border/no-link
    expect(renderer.getLinkAt(absX, 0)).toBeUndefined(); // different row
  });

  test("returns undefined before any frame is rendered", () => {
    expect(renderer.getLinkAt(0, 0)).toBeUndefined();
  });
});
