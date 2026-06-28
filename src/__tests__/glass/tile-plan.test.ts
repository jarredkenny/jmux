import { describe, test, expect } from "bun:test";
import { planTiles, type TilePlanSpec } from "../../glass/tile-plan";

const specs = (pairs: [string, string][]): TilePlanSpec[] =>
  pairs.map(([paneId, tabId]) => ({ paneId, tabId }));

describe("planTiles", () => {
  test("spawns active-tab panes that are not yet warm", () => {
    const all = specs([["%1", "default"], ["%2", "default"], ["%3", "backend"]]);
    const plan = planTiles(all, "default", new Set());
    expect(plan.spawn.sort()).toEqual(["%1", "%2"]);
    expect(plan.render).toEqual(["%1", "%2"]); // all-order, active tab only
  });

  test("keeps warm tiles from other tabs (no teardown on tab leave)", () => {
    const all = specs([["%1", "default"], ["%3", "backend"]]);
    const plan = planTiles(all, "backend", new Set(["%1"])); // %1 warm from default
    expect(plan.teardown).toEqual([]);          // %1 stays warm
    expect(plan.spawn).toEqual(["%3"]);         // backend's tile spawns
    expect(plan.render).toEqual(["%3"]);        // only active tab renders
  });

  test("tears down panes that left membership entirely", () => {
    const all = specs([["%1", "default"]]);
    const plan = planTiles(all, "default", new Set(["%1", "%9"])); // %9 unpinned
    expect(plan.teardown).toEqual(["%9"]);
    expect(plan.spawn).toEqual([]); // %1 already warm
  });

  test("does not re-spawn an already-warm active tile", () => {
    const all = specs([["%1", "default"]]);
    const plan = planTiles(all, "default", new Set(["%1"]));
    expect(plan.spawn).toEqual([]);
    expect(plan.render).toEqual(["%1"]);
  });
});
