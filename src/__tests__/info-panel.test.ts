import { describe, test, expect } from "bun:test";
import { InfoPanel, type InfoTab } from "../info-panel";

describe("InfoPanel", () => {
  test("starts with diff tab only when no adapters configured", () => {
    const panel = new InfoPanel({ viewIds: [], viewLabels: new Map() });
    expect(panel.tabs).toEqual(["diff"]);
    expect(panel.activeTab).toBe("diff");
  });

  test("shows MR tab when code host configured", () => {
    const panel = new InfoPanel({ viewIds: ["my-mrs"], viewLabels: new Map([["my-mrs", "My MRs"]]) });
    expect(panel.tabs).toEqual(["diff", "my-mrs"]);
  });

  test("shows Issues tab when issue tracker configured", () => {
    const panel = new InfoPanel({ viewIds: ["my-issues"], viewLabels: new Map([["my-issues", "Issues"]]) });
    expect(panel.tabs).toEqual(["diff", "my-issues"]);
  });

  test("shows all tabs when both adapters configured", () => {
    const panel = new InfoPanel({
      viewIds: ["my-issues", "my-mrs", "review"],
      viewLabels: new Map([["my-issues", "Issues"], ["my-mrs", "My MRs"], ["review", "Review"]]),
    });
    expect(panel.tabs).toEqual(["diff", "my-issues", "my-mrs", "review"]);
  });

  test("nextTab cycles forward", () => {
    const panel = new InfoPanel({
      viewIds: ["my-mrs", "my-issues"],
      viewLabels: new Map([["my-mrs", "My MRs"], ["my-issues", "Issues"]]),
    });
    expect(panel.activeTab).toBe("diff");
    panel.nextTab();
    expect(panel.activeTab).toBe("my-mrs");
    panel.nextTab();
    expect(panel.activeTab).toBe("my-issues");
    panel.nextTab();
    expect(panel.activeTab).toBe("diff");
  });

  test("prevTab cycles backward", () => {
    const panel = new InfoPanel({
      viewIds: ["my-mrs", "my-issues"],
      viewLabels: new Map([["my-mrs", "My MRs"], ["my-issues", "Issues"]]),
    });
    panel.prevTab();
    expect(panel.activeTab).toBe("my-issues");
    panel.prevTab();
    expect(panel.activeTab).toBe("my-mrs");
  });

  test("nextTab is no-op with single tab", () => {
    const panel = new InfoPanel({ viewIds: [], viewLabels: new Map() });
    panel.nextTab();
    expect(panel.activeTab).toBe("diff");
  });

  test("setActiveTab works for valid tab", () => {
    const panel = new InfoPanel({
      viewIds: ["my-mrs", "my-issues"],
      viewLabels: new Map([["my-mrs", "My MRs"], ["my-issues", "Issues"]]),
    });
    panel.setActiveTab("my-mrs");
    expect(panel.activeTab).toBe("my-mrs");
  });

  test("setActiveTab ignores invalid tab", () => {
    const panel = new InfoPanel({ viewIds: [], viewLabels: new Map() });
    panel.setActiveTab("my-mrs");
    expect(panel.activeTab).toBe("diff");
  });

  test("getTabBarGrid renders tab labels", () => {
    const panel = new InfoPanel({
      viewIds: ["my-mrs"],
      viewLabels: new Map([["my-mrs", "My MRs"]]),
    });
    const grid = panel.getTabBarGrid(40);
    expect(grid.cols).toBe(40);
    expect(grid.rows).toBe(1);
    const text = grid.cells[0].map((c) => c.char).join("");
    expect(text).toContain("Diff");
    expect(text).toContain("My MRs");
  });

  test("hasMultipleTabs", () => {
    const single = new InfoPanel({ viewIds: [], viewLabels: new Map() });
    expect(single.hasMultipleTabs).toBe(false);

    const multi = new InfoPanel({ viewIds: ["my-mrs"], viewLabels: new Map([["my-mrs", "My MRs"]]) });
    expect(multi.hasMultipleTabs).toBe(true);
  });

  test("updateConfig changes available tabs", () => {
    const panel = new InfoPanel({ viewIds: [], viewLabels: new Map() });
    expect(panel.tabs).toEqual(["diff"]);
    panel.updateConfig({
      viewIds: ["my-mrs", "my-issues"],
      viewLabels: new Map([["my-mrs", "My MRs"], ["my-issues", "Issues"]]),
    });
    expect(panel.tabs).toEqual(["diff", "my-mrs", "my-issues"]);
  });

  test("updateConfig resets active tab if current tab removed", () => {
    const panel = new InfoPanel({
      viewIds: ["my-mrs", "my-issues"],
      viewLabels: new Map([["my-mrs", "My MRs"], ["my-issues", "Issues"]]),
    });
    panel.setActiveTab("my-mrs");
    panel.updateConfig({
      viewIds: ["my-issues"],
      viewLabels: new Map([["my-issues", "Issues"]]),
    });
    expect(panel.activeTab).toBe("diff");
  });
});
