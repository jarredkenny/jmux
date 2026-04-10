import { describe, test, expect } from "bun:test";
import { ToolPanel } from "../tool-panel";

describe("ToolPanel state", () => {
  test("starts with diff tab active", () => {
    const panel = new ToolPanel();
    expect(panel.activeTab).toBe("diff");
  });

  test("switchTab changes active tab", () => {
    const panel = new ToolPanel();
    panel.switchTab("agent");
    expect(panel.activeTab).toBe("agent");
    panel.switchTab("diff");
    expect(panel.activeTab).toBe("diff");
  });

  test("nextTab cycles through tabs", () => {
    const panel = new ToolPanel();
    expect(panel.activeTab).toBe("diff");
    panel.nextTab();
    expect(panel.activeTab).toBe("agent");
    panel.nextTab();
    expect(panel.activeTab).toBe("diff");
  });
});

describe("ToolPanel tab bar", () => {
  test("renderTabBar produces a grid row", () => {
    const panel = new ToolPanel();
    const grid = panel.renderTabBar(40);
    expect(grid.cols).toBe(40);
    expect(grid.rows).toBe(1);
    const text = grid.cells[0].map(c => c.char).join("");
    expect(text).toContain("Diff");
    expect(text).toContain("Agent");
  });

  test("active tab is highlighted", () => {
    const panel = new ToolPanel();
    const grid1 = panel.renderTabBar(40);
    // Find the 'D' of 'Diff' — it should be bold (active)
    const diffDIdx = grid1.cells[0].findIndex(c => c.char === "D");
    expect(grid1.cells[0][diffDIdx].bold).toBe(true);

    panel.switchTab("agent");
    const grid2 = panel.renderTabBar(40);
    const agentAIdx = grid2.cells[0].findIndex(c => c.char === "A");
    expect(grid2.cells[0][agentAIdx].bold).toBe(true);
    // Diff should no longer be bold
    const diffDIdx2 = grid2.cells[0].findIndex(c => c.char === "D");
    expect(grid2.cells[0][diffDIdx2].bold).toBe(false);
  });
});
