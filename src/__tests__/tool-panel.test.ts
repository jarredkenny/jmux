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
