import { describe, test, expect } from "bun:test";
import { clampTabSelection } from "../../glass/reload";
import type { TabEntry } from "../../glass/tabs";

const tabs: TabEntry[] = [{ id: "default", name: "Main" }, { id: "backend", name: "Backend" }];

describe("clampTabSelection", () => {
  test("keeps ids that still exist", () => {
    expect(clampTabSelection(tabs, "backend", "backend")).toEqual({
      activeTabId: "backend", lastActiveTabId: "backend",
    });
  });
  test("folds vanished ids to the default", () => {
    expect(clampTabSelection(tabs, "ghost", "gone")).toEqual({
      activeTabId: "default", lastActiveTabId: "default",
    });
  });
});
