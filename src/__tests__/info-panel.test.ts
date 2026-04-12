import { describe, test, expect } from "bun:test";
import { InfoPanel, type InfoTab } from "../info-panel";

describe("InfoPanel", () => {
  test("starts with diff tab only when no adapters configured", () => {
    const panel = new InfoPanel({ hasCodeHost: false, hasIssueTracker: false });
    expect(panel.tabs).toEqual(["diff"]);
    expect(panel.activeTab).toBe("diff");
  });

  test("shows MR tab when code host configured", () => {
    const panel = new InfoPanel({ hasCodeHost: true, hasIssueTracker: false });
    expect(panel.tabs).toEqual(["diff", "mr"]);
  });

  test("shows Issues tab when issue tracker configured", () => {
    const panel = new InfoPanel({ hasCodeHost: false, hasIssueTracker: true });
    expect(panel.tabs).toEqual(["diff", "issues"]);
  });

  test("shows all tabs when both adapters configured", () => {
    const panel = new InfoPanel({ hasCodeHost: true, hasIssueTracker: true });
    expect(panel.tabs).toEqual(["diff", "mr", "issues"]);
  });

  test("nextTab cycles forward", () => {
    const panel = new InfoPanel({ hasCodeHost: true, hasIssueTracker: true });
    expect(panel.activeTab).toBe("diff");
    panel.nextTab();
    expect(panel.activeTab).toBe("mr");
    panel.nextTab();
    expect(panel.activeTab).toBe("issues");
    panel.nextTab();
    expect(panel.activeTab).toBe("diff");
  });

  test("prevTab cycles backward", () => {
    const panel = new InfoPanel({ hasCodeHost: true, hasIssueTracker: true });
    panel.prevTab();
    expect(panel.activeTab).toBe("issues");
    panel.prevTab();
    expect(panel.activeTab).toBe("mr");
  });

  test("nextTab is no-op with single tab", () => {
    const panel = new InfoPanel({ hasCodeHost: false, hasIssueTracker: false });
    panel.nextTab();
    expect(panel.activeTab).toBe("diff");
  });

  test("setActiveTab works for valid tab", () => {
    const panel = new InfoPanel({ hasCodeHost: true, hasIssueTracker: true });
    panel.setActiveTab("mr");
    expect(panel.activeTab).toBe("mr");
  });

  test("setActiveTab ignores invalid tab", () => {
    const panel = new InfoPanel({ hasCodeHost: false, hasIssueTracker: false });
    panel.setActiveTab("mr");
    expect(panel.activeTab).toBe("diff");
  });

  test("getTabBarGrid renders tab labels", () => {
    const panel = new InfoPanel({ hasCodeHost: true, hasIssueTracker: true });
    const grid = panel.getTabBarGrid(40);
    expect(grid.cols).toBe(40);
    expect(grid.rows).toBe(1);
    const text = grid.cells[0].map((c) => c.char).join("");
    expect(text).toContain("Diff");
    expect(text).toContain("MR");
    expect(text).toContain("Issues");
  });

  test("hasMultipleTabs", () => {
    const single = new InfoPanel({ hasCodeHost: false, hasIssueTracker: false });
    expect(single.hasMultipleTabs).toBe(false);

    const multi = new InfoPanel({ hasCodeHost: true, hasIssueTracker: false });
    expect(multi.hasMultipleTabs).toBe(true);
  });

  test("updateConfig changes available tabs", () => {
    const panel = new InfoPanel({ hasCodeHost: false, hasIssueTracker: false });
    expect(panel.tabs).toEqual(["diff"]);
    panel.updateConfig({ hasCodeHost: true, hasIssueTracker: true });
    expect(panel.tabs).toEqual(["diff", "mr", "issues"]);
  });

  test("updateConfig resets active tab if current tab removed", () => {
    const panel = new InfoPanel({ hasCodeHost: true, hasIssueTracker: true });
    panel.setActiveTab("mr");
    panel.updateConfig({ hasCodeHost: false, hasIssueTracker: true });
    expect(panel.activeTab).toBe("diff");
  });
});
