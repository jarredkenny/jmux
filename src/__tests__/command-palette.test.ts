import { describe, test, expect } from "bun:test";
import { fuzzyMatch, CommandPalette, type FuzzyResult } from "../command-palette";
import type { PaletteCommand } from "../types";

const testCommands: PaletteCommand[] = [
  { id: "split-h", label: "Split horizontal", category: "pane" },
  { id: "split-v", label: "Split vertical", category: "pane" },
  { id: "new-window", label: "New window", category: "window" },
  { id: "setting-width", label: "Sidebar width", category: "setting", sublist: [
    { id: "22", label: "22" },
    { id: "26", label: "26", current: true },
    { id: "30", label: "30" },
  ]},
];

describe("fuzzyMatch", () => {
  test("matches exact substring", () => {
    const result = fuzzyMatch("split", "Split horizontal");
    expect(result).not.toBeNull();
    expect(result!.indices).toEqual([0, 1, 2, 3, 4]);
  });

  test("matches characters in order across word boundaries", () => {
    const result = fuzzyMatch("nw", "New window");
    expect(result).not.toBeNull();
    expect(result!.indices).toEqual([0, 2]);
  });

  test("is case-insensitive", () => {
    const result = fuzzyMatch("SPLIT", "Split horizontal");
    expect(result).not.toBeNull();
  });

  test("returns null when characters are not in order", () => {
    const result = fuzzyMatch("zx", "Split horizontal");
    expect(result).toBeNull();
  });

  test("returns null for empty label", () => {
    const result = fuzzyMatch("a", "");
    expect(result).toBeNull();
  });

  test("matches everything for empty query", () => {
    const result = fuzzyMatch("", "Split horizontal");
    expect(result).not.toBeNull();
    expect(result!.indices).toEqual([]);
    expect(result!.score).toBe(0);
  });

  test("consecutive matches score higher than spread matches", () => {
    const consecutive = fuzzyMatch("sp", "Split horizontal");
    const spread = fuzzyMatch("sp", "Session: project");
    expect(consecutive).not.toBeNull();
    expect(spread).not.toBeNull();
    expect(consecutive!.score).toBeGreaterThan(spread!.score);
  });

  test("word boundary match scores higher", () => {
    const boundary = fuzzyMatch("sh", "Split horizontal");
    const mid = fuzzyMatch("sh", "pushed");
    expect(boundary).not.toBeNull();
    expect(mid).not.toBeNull();
    expect(boundary!.score).toBeGreaterThan(mid!.score);
  });
});

describe("CommandPalette", () => {
  test("starts closed", () => {
    const palette = new CommandPalette();
    expect(palette.isOpen()).toBe(false);
  });

  test("open/close lifecycle", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    expect(palette.isOpen()).toBe(true);
    palette.close();
    expect(palette.isOpen()).toBe(false);
  });

  test("typing filters results", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    palette.handleInput("s");
    palette.handleInput("p");
    const results = palette.getFilteredResults();
    expect(results.length).toBe(2);
    expect(results[0].command.id).toBe("split-h");
    expect(results[1].command.id).toBe("split-v");
  });

  test("backspace removes last character", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    palette.handleInput("s");
    palette.handleInput("p");
    palette.handleInput("\x7f"); // backspace
    const results = palette.getFilteredResults();
    // "s" matches Split horizontal, Split vertical, Sidebar width
    expect(results.length).toBe(3);
  });

  test("backspace is no-op when query empty", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    const action = palette.handleInput("\x7f");
    expect(action.type).toBe("consumed");
    expect(palette.isOpen()).toBe(true);
  });

  test("down arrow moves selection", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    expect(palette.getSelectedIndex()).toBe(0);
    palette.handleInput("\x1b[B"); // down
    expect(palette.getSelectedIndex()).toBe(1);
  });

  test("up arrow wraps to bottom", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    expect(palette.getSelectedIndex()).toBe(0);
    palette.handleInput("\x1b[A"); // up
    expect(palette.getSelectedIndex()).toBe(testCommands.length - 1);
  });

  test("enter on regular command returns result", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    const action = palette.handleInput("\r"); // enter
    expect(action.type).toBe("result");
    if (action.type === "result") {
      expect(action.value.commandId).toBe("split-h");
      expect(action.value.sublistOptionId).toBeUndefined();
    }
  });

  test("enter on command with sublist drills in", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    // Navigate to "Sidebar width" (index 3)
    palette.handleInput("\x1b[B");
    palette.handleInput("\x1b[B");
    palette.handleInput("\x1b[B");
    const action = palette.handleInput("\r");
    expect(action.type).toBe("consumed"); // drilled in, not executed
    expect(palette.isInSublist()).toBe(true);
  });

  test("enter in sublist returns result with sublistOptionId", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    // Navigate to "Sidebar width" and drill in
    palette.handleInput("\x1b[B");
    palette.handleInput("\x1b[B");
    palette.handleInput("\x1b[B");
    palette.handleInput("\r"); // drill in
    // Select "22" (first option, already selected)
    const action = palette.handleInput("\r");
    expect(action.type).toBe("result");
    if (action.type === "result") {
      expect(action.value.commandId).toBe("setting-width");
      expect(action.value.sublistOptionId).toBe("22");
    }
  });

  test("escape in sublist returns to main list", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    palette.handleInput("\x1b[B");
    palette.handleInput("\x1b[B");
    palette.handleInput("\x1b[B");
    palette.handleInput("\r"); // drill in
    expect(palette.isInSublist()).toBe(true);
    palette.handleInput("\x1b"); // escape
    expect(palette.isInSublist()).toBe(false);
    expect(palette.isOpen()).toBe(true);
  });

  test("escape at top level closes palette", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    const action = palette.handleInput("\x1b"); // escape
    expect(action.type).toBe("closed");
    expect(palette.isOpen()).toBe(false);
  });

  test("Ctrl-a then p closes palette", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    const action1 = palette.handleInput("\x01"); // Ctrl-a
    expect(action1.type).toBe("consumed"); // buffered
    const action2 = palette.handleInput("p");
    expect(action2.type).toBe("closed");
    expect(palette.isOpen()).toBe(false);
  });

  test("Ctrl-a then non-p discards both bytes", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    palette.handleInput("\x01"); // Ctrl-a
    const action = palette.handleInput("x"); // not p
    expect(action.type).toBe("consumed");
    expect(palette.isOpen()).toBe(true);
    expect(palette.getQuery()).toBe(""); // "x" was not appended
  });

  test("selection resets to 0 when query changes", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    palette.handleInput("\x1b[B"); // move to index 1
    palette.handleInput("\x1b[B"); // move to index 2
    palette.handleInput("n"); // type — resets selection
    expect(palette.getSelectedIndex()).toBe(0);
  });

  test("sublist filtering works", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    // Navigate to "Sidebar width" and drill in
    palette.handleInput("\x1b[B");
    palette.handleInput("\x1b[B");
    palette.handleInput("\x1b[B");
    palette.handleInput("\r"); // drill in
    palette.handleInput("3"); // type "3"
    const results = palette.getFilteredResults();
    expect(results.length).toBe(1);
    expect(results[0].command.id).toBe("30");
  });
});

describe("CommandPalette rendering", () => {
  test("getHeight returns input row + result rows", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    // 1 input row + 4 results = 5
    expect(palette.getHeight()).toBe(5);
  });

  test("getHeight caps at MAX_VISIBLE_RESULTS + 1", () => {
    const manyCommands: PaletteCommand[] = [];
    for (let i = 0; i < 20; i++) {
      manyCommands.push({ id: `cmd-${i}`, label: `Command ${i}`, category: "other" });
    }
    const palette = new CommandPalette();
    palette.open(manyCommands);
    // 1 input + 16 visible = 17
    expect(palette.getHeight()).toBe(17);
  });

  test("getGrid returns grid with correct dimensions", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    const grid = palette.getGrid(60);
    expect(grid.cols).toBe(60);
    expect(grid.rows).toBe(palette.getHeight());
  });

  test("getGrid input row shows prompt and query", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    palette.handleInput("s");
    palette.handleInput("p");
    const grid = palette.getGrid(60);
    // Row 0: "▷ sp" — prompt at col 0, space at col 1, query starts at col 2
    expect(grid.cells[0][0].char).toBe("▷");
    expect(grid.cells[0][2].char).toBe("s");
    expect(grid.cells[0][3].char).toBe("p");
  });

  test("getGrid shows selected row indicator", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    const grid = palette.getGrid(60);
    // Row 1 (first result) should have "▸" at col 1
    expect(grid.cells[1][1].char).toBe("▸");
  });

  test("getGrid shows category tags right-aligned", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    const grid = palette.getGrid(60);
    // First result is "Split horizontal" category "pane"
    // "pane" is 4 chars, right-aligned with 1 col padding = col 60-4-1 = 55
    expect(grid.cells[1][55].char).toBe("p");
    expect(grid.cells[1][56].char).toBe("a");
    expect(grid.cells[1][57].char).toBe("n");
    expect(grid.cells[1][58].char).toBe("e");
  });

  test("getGrid sublist shows breadcrumb in input row", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    // Navigate to "Sidebar width" (index 3) and drill in
    palette.handleInput("\x1b[B");
    palette.handleInput("\x1b[B");
    palette.handleInput("\x1b[B");
    palette.handleInput("\r");
    const grid = palette.getGrid(60);
    // Input row should show "Sidebar width › "
    expect(grid.cells[0][0].char).toBe("S");
    expect(grid.cells[0][1].char).toBe("i");
  });

  test("getGrid shows no matches message", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    palette.handleInput("z");
    palette.handleInput("z");
    palette.handleInput("z");
    const grid = palette.getGrid(60);
    // Should show "No matches" in results area — height is input + 1 result row = 2
    expect(palette.getHeight()).toBe(2);
    // Row 1 should contain "No matches"
    const row1text = grid.cells[1].map(c => c.char).join("").trim();
    expect(row1text).toContain("No matches");
  });

  test("getCursorCol returns correct position", () => {
    const palette = new CommandPalette();
    palette.open(testCommands);
    expect(palette.getCursorCol()).toBe(2); // "▷ " = 2
    palette.handleInput("a");
    palette.handleInput("b");
    expect(palette.getCursorCol()).toBe(4); // "▷ ab" = 4
  });
});
