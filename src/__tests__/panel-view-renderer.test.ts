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

  test("groups are sorted alphabetically, not by item insertion order", () => {
    // Item-level sort is by priority asc → ISSUE (Platform, prio 1) is first,
    // ISSUE3 (Frontend, prio 2) second. Without explicit group sort the
    // groups would appear as [Platform, Frontend]; with it they're [Frontend, Platform].
    const items = transformIssues([ISSUE, ISSUE3, ISSUE2], new Set());
    const nodes = buildViewNodes(items, VIEW, new Set());
    const groupLabels = nodes.filter((n) => n.kind === "group" && n.depth === 0).map((n) => (n as any).label);
    expect(groupLabels).toEqual(["Frontend", "Platform"]);
  });

  test("subgroup order is stable when an item changes status", () => {
    // Two Platform issues: one Todo (unstarted), one In Progress (started).
    // The lower-priority issue is initially Todo so the In Progress subgroup
    // is encountered first under priority-asc sort.
    const before: Issue[] = [
      { ...ISSUE, id: "p1", priority: 1, status: "In Progress", stateType: "started", team: "Platform" },
      { ...ISSUE, id: "p2", priority: 2, status: "Todo", stateType: "unstarted", team: "Platform" },
    ];
    const beforeNodes = buildViewNodes(transformIssues(before, new Set()), VIEW, new Set());
    const beforeSubs = beforeNodes.filter((n) => n.kind === "group" && n.depth === 1).map((n) => (n as any).label);

    // After: change p1 from In Progress → Todo. p1 is now the higher-priority
    // Todo, so under Map-insertion-order subgroups would be [Todo, In Progress].
    // With deterministic ordering they remain in workflow order regardless.
    const after: Issue[] = [
      { ...ISSUE, id: "p1", priority: 1, status: "Todo", stateType: "unstarted", team: "Platform" },
      { ...ISSUE, id: "p2", priority: 2, status: "Todo", stateType: "unstarted", team: "Platform" },
    ];
    const afterNodes = buildViewNodes(transformIssues(after, new Set()), VIEW, new Set());
    const afterSubs = afterNodes.filter((n) => n.kind === "group" && n.depth === 1).map((n) => (n as any).label);

    expect(beforeSubs).toEqual(["Todo", "In Progress"]);
    expect(afterSubs).toEqual(["Todo"]);
    // unstarted < started in workflow order, so Todo is always before In Progress
    // when both are present, regardless of which item moved.
    const mixed: Issue[] = [
      { ...ISSUE, id: "p1", priority: 1, status: "In Progress", stateType: "started", team: "Platform" },
      { ...ISSUE, id: "p2", priority: 2, status: "Todo", stateType: "unstarted", team: "Platform" },
      { ...ISSUE, id: "p3", priority: 3, status: "In Progress", stateType: "started", team: "Platform" },
    ];
    const mixedNodes = buildViewNodes(transformIssues(mixed, new Set()), VIEW, new Set());
    const mixedSubs = mixedNodes.filter((n) => n.kind === "group" && n.depth === 1).map((n) => (n as any).label);
    expect(mixedSubs).toEqual(["Todo", "In Progress"]);
  });

  test("priority groups order: 1=Urgent..4=Low, 0=None last", () => {
    const issues: Issue[] = [
      { ...ISSUE, id: "a", priority: 0, team: "T" },
      { ...ISSUE, id: "b", priority: 4, team: "T" },
      { ...ISSUE, id: "c", priority: 1, team: "T" },
      { ...ISSUE, id: "d", priority: 3, team: "T" },
    ];
    const view: PanelView = { ...VIEW, groupBy: "priority", subGroupBy: "none" };
    const nodes = buildViewNodes(transformIssues(issues, new Set()), view, new Set());
    const labels = nodes.filter((n) => n.kind === "group").map((n) => (n as any).label);
    expect(labels).toEqual(["1", "3", "4", "0"]);
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
