import { describe, test, expect } from "bun:test";
import {
  transformIssues,
  transformMrs,
  buildViewNodes,
  renderView,
  createViewState,
} from "../panel-view-renderer";
import type { PanelView } from "../panel-view";
import type { Issue, MergeRequest } from "../adapters/types";

const ISSUE: Issue = {
  id: "i1", identifier: "ENG-1234", title: "Fix auth", status: "In Progress",
  assignee: "jarred", linkedMrUrls: [], webUrl: "",
  team: "Platform", project: "Auth", priority: 1, updatedAt: 1000,
};

const ISSUE2: Issue = {
  id: "i2", identifier: "ENG-1235", title: "Add logging", status: "Todo",
  assignee: "alice", linkedMrUrls: [], webUrl: "",
  team: "Platform", project: "Infra", priority: 3, updatedAt: 2000,
};

const ISSUE3: Issue = {
  id: "i3", identifier: "ENG-1236", title: "Fix CSS", status: "In Progress",
  assignee: "jarred", linkedMrUrls: [], webUrl: "",
  team: "Frontend", priority: 2, updatedAt: 3000,
};

const VIEW: PanelView = {
  id: "test", label: "Test", source: "issues",
  filter: { scope: "assigned" },
  groupBy: "team", subGroupBy: "status",
  sortBy: "priority", sortOrder: "asc",
  sessionLinkedFirst: true,
};

function extractText(grid: { cells: Array<Array<{ char: string }>> }): string {
  return grid.cells.map((row) => row.map((c) => c.char).join("")).join("\n");
}

describe("transformIssues", () => {
  test("transforms with session-linked detection", () => {
    const items = transformIssues([ISSUE, ISSUE2], new Set(["i1"]));
    expect(items).toHaveLength(2);
    expect(items[0].sessionLinked).toBe(true);
    expect(items[1].sessionLinked).toBe(false);
    expect(items[0].primary).toBe("ENG-1234");
  });
});

describe("buildViewNodes", () => {
  test("groups by team with subgroup by status", () => {
    const items = transformIssues([ISSUE, ISSUE2, ISSUE3], new Set());
    const nodes = buildViewNodes(items, VIEW, new Set());
    const groupNodes = nodes.filter((n) => n.kind === "group");
    expect(groupNodes.length).toBeGreaterThanOrEqual(2);
  });

  test("no grouping returns flat list", () => {
    const flatView: PanelView = { ...VIEW, groupBy: "none", subGroupBy: "none" };
    const items = transformIssues([ISSUE, ISSUE2], new Set());
    const nodes = buildViewNodes(items, flatView, new Set());
    expect(nodes.every((n) => n.kind === "item")).toBe(true);
  });

  test("collapsed group hides children", () => {
    const items = transformIssues([ISSUE, ISSUE2], new Set());
    const collapsed = new Set(["Platform"]);
    const nodes = buildViewNodes(items, VIEW, collapsed);
    const platformGroup = nodes.find((n) => n.kind === "group" && n.label === "Platform");
    expect(platformGroup).toBeDefined();
    const platformItems = nodes.filter((n) => n.kind === "item" && (n.item.raw as Issue).team === "Platform");
    expect(platformItems).toHaveLength(0);
  });

  test("session-linked items sorted first", () => {
    const items = transformIssues([ISSUE, ISSUE2, ISSUE3], new Set(["i3"]));
    const flatView: PanelView = { ...VIEW, groupBy: "none", subGroupBy: "none" };
    const nodes = buildViewNodes(items, flatView, new Set());
    const firstItem = nodes.find((n) => n.kind === "item");
    expect(firstItem?.kind === "item" && firstItem.item.id).toBe("i3");
  });
});

describe("renderView", () => {
  test("renders items into grid", () => {
    const items = transformIssues([ISSUE], new Set());
    const nodes = buildViewNodes(items, { ...VIEW, groupBy: "none", subGroupBy: "none" }, new Set());
    const grid = renderView(nodes, 40, 20, createViewState());
    const text = extractText(grid);
    expect(text).toContain("ENG-1234");
  });

  test("renders detail pane when rows >= 15", () => {
    const items = transformIssues([ISSUE], new Set());
    const nodes = buildViewNodes(items, { ...VIEW, groupBy: "none", subGroupBy: "none" }, new Set());
    const grid = renderView(nodes, 40, 20, createViewState());
    const text = extractText(grid);
    expect(text).toContain("[o]");
    expect(text).toContain("[n]");
  });

  test("no detail pane when rows < 15", () => {
    const items = transformIssues([ISSUE], new Set());
    const nodes = buildViewNodes(items, { ...VIEW, groupBy: "none", subGroupBy: "none" }, new Set());
    const grid = renderView(nodes, 40, 10, createViewState());
    const text = extractText(grid);
    expect(text).toContain("ENG-1234");
    expect(text).not.toContain("[n]");
  });

  test("renders group headers", () => {
    const items = transformIssues([ISSUE, ISSUE3], new Set());
    const nodes = buildViewNodes(items, VIEW, new Set());
    const grid = renderView(nodes, 40, 30, createViewState());
    const text = extractText(grid);
    expect(text).toContain("Platform");
    expect(text).toContain("Frontend");
  });
});
