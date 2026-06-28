import { describe, test, expect } from "bun:test";
import {
  stripVisibleFor, layoutStrip, renderStrip, chipAtX, STRIP_ROWS,
} from "../../glass/strip";
import type { TabEntry, AgentState } from "../../glass/tabs";
import { ColorMode } from "../../types";

const palette: Record<AgentState, number> = { running: 2, waiting: 3, complete: 4 };
const tabs: TabEntry[] = [
  { id: "default", name: "Main" },
  { id: "backend", name: "Backend" },
];

describe("stripVisibleFor", () => {
  test("hidden with one tab, shown with two+", () => {
    expect(stripVisibleFor([{ id: "default", name: "Main" }])).toBe(false);
    expect(stripVisibleFor(tabs)).toBe(true);
  });
});

describe("layoutStrip / chipAtX", () => {
  test("chips are laid out left to right and hit-test by x", () => {
    const chips = layoutStrip({
      tabs, activeTabId: "default",
      summaryByTab: new Map([["backend", "waiting"]]),
      width: 80, palette,
    });
    expect(chips.length).toBe(2);
    expect(chips[0].tabId).toBe("default");
    expect(chips[0].x).toBe(0);
    // first chip covers its own columns, second starts after it
    expect(chipAtX(chips, chips[0].x)).toBe("default");
    expect(chipAtX(chips, chips[1].x)).toBe("backend");
    expect(chipAtX(chips, 9999)).toBeNull();
  });
});

describe("renderStrip", () => {
  test("renders one row containing both tab names", () => {
    const grid = renderStrip({
      tabs, activeTabId: "default",
      summaryByTab: new Map([["backend", "running"]]),
      width: 80, palette,
    });
    expect(grid.rows).toBe(STRIP_ROWS);
    const row = grid.cells[0].map((c) => c.char).join("");
    expect(row).toContain("Main");
    expect(row).toContain("Backend");
  });

  test("dot cell has fg=palette[summary] and fgMode=Palette", () => {
    const grid = renderStrip({
      tabs,
      activeTabId: "default",
      summaryByTab: new Map([["backend", "running"]]),
      width: 80,
      palette,
    });
    // Scan row 0 for the dot character and assert its color.
    const row = grid.cells[0];
    const dotCell = row.find((c) => c.char === "●");
    expect(dotCell).toBeDefined();
    expect(dotCell!.fg).toBe(palette.running);
    expect(dotCell!.fgMode).toBe(ColorMode.Palette);
  });

  test("dot lands on correct display column with a wide-character (CJK) name", () => {
    // "汉字" — two CJK characters each with display width 2 (4 cols total).
    const wideTabs: TabEntry[] = [
      { id: "wide", name: "汉字" },
      { id: "other", name: "X" },
    ];
    const grid = renderStrip({
      tabs: wideTabs,
      activeTabId: "wide",
      summaryByTab: new Map([["wide", "running"]]),
      width: 80,
      palette,
    });
    // The dot cell must be "●", not a wide-char continuation or wrong character.
    const row = grid.cells[0];
    const dotCell = row.find((c) => c.char === "●");
    expect(dotCell).toBeDefined();
    expect(dotCell!.fg).toBe(palette.running);
    expect(dotCell!.fgMode).toBe(ColorMode.Palette);
    // Verify there is no stray "●" appearing at the wrong offset:
    // chip text is ` 汉字 ● ` → display cols: 1 + 4 + 1 + 1 + 1 + 1 = 9
    // dot is at display col: chip.x(0) + textCols(" 汉字 ") = 0 + (1+4+1) = 6
    const dotIdx = row.findIndex((c) => c.char === "●");
    expect(dotIdx).toBe(6);
  });
});
