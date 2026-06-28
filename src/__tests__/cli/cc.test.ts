import { describe, test, expect } from "bun:test";
import { buildTabSummaries } from "../../cli/cc";
import type { TabEntry } from "../../glass/tabs";

describe("buildTabSummaries", () => {
  const tabs: TabEntry[] = [
    { id: "default", name: "Main" },
    { id: "backend", name: "Backend" },
  ];

  test("counts live pinned panes per resolved tab (legacy + unknown fold to default)", () => {
    const pins = [
      { id: "%1", tab: "1" },        // legacy → default
      { id: "%2", tab: "backend" },  // backend
      { id: "%3", tab: "ghost" },    // unknown → default
      { id: "%4", tab: "backend" },  // backend
    ];
    expect(buildTabSummaries(tabs, pins)).toEqual([
      { id: "default", name: "Main", order: 0, count: 2 },
      { id: "backend", name: "Backend", order: 1, count: 2 },
    ]);
  });

  test("empty tabs report count 0", () => {
    expect(buildTabSummaries(tabs, [])).toEqual([
      { id: "default", name: "Main", order: 0, count: 0 },
      { id: "backend", name: "Backend", order: 1, count: 0 },
    ]);
  });
});
