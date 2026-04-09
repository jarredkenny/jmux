import { describe, test, expect } from "bun:test";
import { DiffPanel, type DiffPanelState } from "../diff-panel";

describe("DiffPanel state machine", () => {
  test("starts in off state", () => {
    const panel = new DiffPanel();
    expect(panel.state).toBe("off");
  });

  test("cycle advances off → split → full → off", () => {
    const panel = new DiffPanel();
    panel.cycle();
    expect(panel.state).toBe("split");
    panel.cycle();
    expect(panel.state).toBe("full");
    panel.cycle();
    expect(panel.state).toBe("off");
  });

  test("setState jumps directly to a state", () => {
    const panel = new DiffPanel();
    panel.setState("full");
    expect(panel.state).toBe("full");
    panel.setState("split");
    expect(panel.state).toBe("split");
    panel.setState("off");
    expect(panel.state).toBe("off");
  });

  test("isActive returns false when off", () => {
    const panel = new DiffPanel();
    expect(panel.isActive()).toBe(false);
  });

  test("isActive returns true when split or full", () => {
    const panel = new DiffPanel();
    panel.setState("split");
    expect(panel.isActive()).toBe(true);
    panel.setState("full");
    expect(panel.isActive()).toBe(true);
  });

  test("calculates panel columns in split mode", () => {
    const panel = new DiffPanel();
    expect(panel.calcPanelCols(100, 0.4)).toBe(40);
  });

  test("calculates panel columns with floor rounding", () => {
    const panel = new DiffPanel();
    expect(panel.calcPanelCols(99, 0.4)).toBe(39);
  });

  test("clamps panel columns to minimum of 20", () => {
    const panel = new DiffPanel();
    expect(panel.calcPanelCols(30, 0.4)).toBe(20);
  });
});

describe("DiffPanel empty panel", () => {
  test("getEmptyGrid renders hint text", () => {
    const panel = new DiffPanel();
    const grid = panel.getEmptyGrid(40, 10);
    expect(grid.cols).toBe(40);
    expect(grid.rows).toBe(10);
    const allChars = grid.cells.flatMap(row => row.map(c => c.char)).join("");
    expect(allChars).toContain("Ctrl-a");
  });

  test("getEmptyGrid for not-found renders install hint", () => {
    const panel = new DiffPanel();
    const grid = panel.getNotFoundGrid(40, 10);
    expect(grid.cols).toBe(40);
    expect(grid.rows).toBe(10);
    const allChars = grid.cells.flatMap(row => row.map(c => c.char)).join("");
    expect(allChars).toContain("hunk");
  });
});
