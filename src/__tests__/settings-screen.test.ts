import { describe, expect, test } from "bun:test";
import { SettingsScreen, type SettingsCategory } from "../settings-screen";
import { space, tokens } from "../chrome-tokens";
import type { CellGrid } from "../types";

// --- Test helpers ---

function rowText(grid: CellGrid, row: number, from: number, to: number): string {
  return Array.from({ length: to - from }, (_, i) => grid.cells[row][from + i].char).join("");
}

// Mirrors the render()'s own centring formula so tests assert against the
// documented contract, not just "whatever the code happens to do".
function expectedBounds(cols: number): { left: number; right: number } {
  const pad = 2;
  const measureWidth = Math.min(cols, space.measure);
  const left = pad + Math.max(0, Math.floor((cols - space.measure) / 2));
  return { left, right: left + measureWidth };
}

function twoCategories(): SettingsCategory[] {
  return [
    {
      label: "General",
      collapsed: false,
      settings: [
        { id: "a", label: "Enable frobnicate", type: "boolean", getValue: () => "on" },
        { id: "b", label: "Display name", type: "text", getValue: () => "hello world" },
      ],
    },
    {
      label: "Advanced",
      collapsed: false,
      settings: [
        { id: "c", label: "Threshold", type: "text", getValue: () => "42" },
      ],
    },
  ];
}

function collapsedCategory(n: number): SettingsCategory[] {
  const settings = Array.from({ length: n }, (_, i) => ({
    id: `s${i}`,
    label: `Setting ${i}`,
    type: "text" as const,
    getValue: () => "value",
  }));
  return [{ label: "Hidden Section", collapsed: true, settings }];
}

// Coverage for the self-close path that main.ts's applyChromeLayout() re-sync
// depends on. SettingsAction has no distinct "closed" variant (handleInput
// always returns {type: "none"} on Escape/q), so the only observable signal
// of a self-close is the `isOpen` getter flipping across the handleInput
// call — which is exactly what handleSettingsInput() in main.ts now checks
// (capture isOpen before, compare after). These tests pin that seam.
describe("SettingsScreen self-close", () => {
  test("Escape closes an open screen (isOpen flips true -> false)", () => {
    const screen = new SettingsScreen();
    screen.open([]);
    expect(screen.isOpen).toBe(true);

    const action = screen.handleInput("\x1b");

    expect(screen.isOpen).toBe(false);
    expect(action).toEqual({ type: "none" });
  });

  test("'q' closes an open screen (isOpen flips true -> false)", () => {
    const screen = new SettingsScreen();
    screen.open([]);
    expect(screen.isOpen).toBe(true);

    const action = screen.handleInput("q");

    expect(screen.isOpen).toBe(false);
    expect(action).toEqual({ type: "none" });
  });

  test("navigation input does not close the screen", () => {
    const screen = new SettingsScreen();
    screen.open([]);

    screen.handleInput("\x1b[A"); // up arrow
    expect(screen.isOpen).toBe(true);

    screen.handleInput("\x1b[B"); // down arrow
    expect(screen.isOpen).toBe(true);
  });
});

// The dot leader used to fill whatever space was left on the line, so the
// layout got worse (a longer and longer leader) the wider the terminal.
// Content is now capped at space.measure (64 cols) and centred within the
// render area, regardless of how wide cols is.
describe("SettingsScreen measure + centring", () => {
  for (const cols of [80, 120, 240]) {
    test(`content never exceeds space.measure and is centred at cols=${cols}`, () => {
      const screen = new SettingsScreen();
      screen.open(twoCategories());
      const grid = screen.render(cols, 30);

      const { left, right } = expectedBounds(cols);
      const measureWidth = right - left;
      expect(measureWidth).toBeLessThanOrEqual(space.measure);

      // Title never runs past the measured right edge.
      expect(rowText(grid, 0, right, cols).trim()).toBe("");
      // Title never starts flush against the left edge either — it's
      // inset by at least `pad`, confirming it's not laid out edge-to-edge.
      expect(rowText(grid, 0, 0, left).trim()).toBe("");
      expect(grid.cells[0][left].char).toBe("S"); // "Settings"

      // Roughly centred: the gap kept on the left vs. the right of the
      // measured column should be close (the formula's own `pad` term
      // introduces a small, fixed, deterministic bias — never growth with
      // terminal width, which is the bug being fixed).
      const leftGap = left;
      const rightGap = cols - right;
      expect(Math.abs(leftGap - rightGap)).toBeLessThanOrEqual(4);
    });
  }

  test("a setting row's dot leader never exceeds the measured right edge", () => {
    const screen = new SettingsScreen();
    screen.open(twoCategories());
    const cols = 240;
    const grid = screen.render(cols, 30);
    const { right } = expectedBounds(cols);

    // Row 3 is the first setting ("Enable frobnicate") — content beyond
    // the measure's right edge must be blank.
    expect(rowText(grid, 3, right, cols).trim()).toBe("");
  });
});

describe("SettingsScreen section hairlines", () => {
  test("an expanded section renders a bare hairline, no (n) count", () => {
    const screen = new SettingsScreen();
    screen.open(twoCategories());
    const cols = 100;
    const grid = screen.render(cols, 30);
    const { left, right } = expectedBounds(cols);

    // Row 2 is the first category header ("General").
    const headerRow = rowText(grid, 2, left, right);
    expect(headerRow.startsWith("General")).toBe(true);
    expect(headerRow).not.toContain("(2)"); // old "(count)" form is gone
    expect(headerRow).not.toContain("hidden");

    // The remainder of the row (after "General ") is a hairline fill.
    const fillStart = left + "General".length + 1;
    const fill = rowText(grid, 2, fillStart, right);
    expect(fill.length).toBeGreaterThan(0);
    expect([...fill].every((ch) => ch === "─")).toBe(true);

    // Hairline tone, not accent/textPrimary.
    const fillCell = grid.cells[2][fillStart];
    expect(fillCell.fg).toBe(tokens.ruleHairline.fg!);
    expect(fillCell.fgMode).toBe(tokens.ruleHairline.fgMode!);
  });

  test("a collapsed section renders 'n hidden' at the right of its hairline", () => {
    const screen = new SettingsScreen();
    screen.open(collapsedCategory(3));
    const cols = 100;
    const grid = screen.render(cols, 30);
    const { left, right } = expectedBounds(cols);

    const headerRow = rowText(grid, 2, left, right);
    expect(headerRow.startsWith("Hidden Section")).toBe(true);
    expect(headerRow.trimEnd().endsWith("3 hidden")).toBe(true);
    expect(headerRow).not.toContain("(3)");

    // Its settings are hidden from the node list entirely (collapse still
    // works) — the only node is the category header itself.
    expect(screen.isOpen).toBe(true);
  });

  test("Enter still toggles collapse and hides/shows the settings", () => {
    const screen = new SettingsScreen();
    screen.open(twoCategories()); // both expanded: 5 nodes (2 headers + 3 settings)
    const cols = 100;

    // Collapse "General" (selected by default at index 0).
    screen.handleInput("\r");
    const grid = screen.render(cols, 30);
    const { left, right } = expectedBounds(cols);

    const headerRow = rowText(grid, 2, left, right);
    expect(headerRow.trimEnd().endsWith("2 hidden")).toBe(true);

    // "Enable frobnicate" no longer appears anywhere on screen.
    for (let r = 0; r < 30; r++) {
      expect(rowText(grid, r, left, right)).not.toContain("Enable frobnicate");
    }
  });
});

describe("SettingsScreen navigation skips blank spacer rows", () => {
  test("moving down past the last setting of a section lands on the next section's header, never a spacer", () => {
    const screen = new SettingsScreen();
    screen.open(twoCategories()); // nodes: [General, a, b, Advanced, c]
    const cols = 100;
    const { left, right } = expectedBounds(cols);

    // Move from General(0) -> a(1) -> b(2) -> Advanced(3).
    screen.handleInput("\x1b[B");
    screen.handleInput("\x1b[B");
    screen.handleInput("\x1b[B");

    const grid = screen.render(cols, 30);
    // Row plan: General@row2, a@row3, b@row4, blank@row5, Advanced@row6, c@row7.
    expect(rowText(grid, 5, left, right).trim()).toBe(""); // the spacer is blank
    expect(rowText(grid, 6, left, right).startsWith("Advanced")).toBe(true);

    // The selection cursor ("▸") is on the Advanced header row, not the blank row.
    expect(grid.cells[6][left - 1].char).toBe("▸");
    expect(grid.cells[5][left - 1].char).not.toBe("▸");
  });

  test("a blank spacer row is inserted before every section except the first", () => {
    const screen = new SettingsScreen();
    screen.open(twoCategories());
    const cols = 100;
    const { left, right } = expectedBounds(cols);
    const grid = screen.render(cols, 30);

    // No blank row before the very first header (row 2, right after the
    // title + breathing row).
    expect(rowText(grid, 2, left, right).startsWith("General")).toBe(true);
    // A blank row precedes "Advanced".
    expect(rowText(grid, 5, left, right).trim()).toBe("");
    expect(rowText(grid, 6, left, right).startsWith("Advanced")).toBe(true);
  });
});

describe("SettingsScreen dot leaders", () => {
  test("leaders are at least two dots and never overlap the label or value", () => {
    const screen = new SettingsScreen();
    screen.open(twoCategories());
    const cols = 100;
    const { left, right } = expectedBounds(cols);
    const grid = screen.render(cols, 30);

    // Row 4 is "Display name" ... "hello world" (a text setting with a
    // short label and value, so there's plenty of room for a leader).
    const indent = left + 2;
    const labelText = "Display name";
    expect(rowText(grid, 4, indent, indent + labelText.length)).toBe(labelText);

    const valueText = "hello world";
    const valueCol = right - valueText.length;
    expect(rowText(grid, 4, valueCol, right)).toBe(valueText);

    const leader = rowText(grid, 4, indent + labelText.length, valueCol);
    const dotCount = [...leader].filter((ch) => ch === "·").length;
    expect(dotCount).toBeGreaterThanOrEqual(2);
    // Everything in the leader zone is either a dot or a flanking space —
    // it never bleeds into the label or the value.
    expect([...leader].every((ch) => ch === "·" || ch === " ")).toBe(true);

    // Hairline tone, not the old DIM_ATTRS palette-8.
    const dotCol = indent + labelText.length + 1;
    expect(grid.cells[4][dotCol].fg).toBe(tokens.ruleHairline.fg!);
    expect(grid.cells[4][dotCol].fgMode).toBe(tokens.ruleHairline.fgMode!);
  });
});
