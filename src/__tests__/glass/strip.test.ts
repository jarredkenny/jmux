import { describe, test, expect } from "bun:test";
import {
  stripVisibleFor, layoutStrip, renderStrip, chipAtX, STRIP_ROWS,
} from "../../glass/strip";
import type { TabEntry, AgentState } from "../../glass/tabs";

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
});
