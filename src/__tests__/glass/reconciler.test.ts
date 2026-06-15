import { describe, test, expect } from "bun:test";
import { reconcilePins, planRestore } from "../../glass/reconciler";
import type {
  ReconcileInput,
  PinnedPaneRecord,
  PaneLocation,
} from "../../glass/types";

const HOLDING = "$glass";

function loc(sessionId: string, windowId: string): PaneLocation {
  return { sessionId, windowId };
}

function rec(paneId: string, over: Partial<PinnedPaneRecord> = {}): PinnedPaneRecord {
  return {
    paneId,
    homeSessionId: "$2",
    homeWindowId: "@5",
    homeLayout: "layoutstr",
    ...over,
  };
}

function input(over: Partial<ReconcileInput>): ReconcileInput {
  return {
    desired: new Set(),
    records: new Map(),
    live: new Map(),
    holdingSessionId: HOLDING,
    ...over,
  };
}

describe("reconcilePins", () => {
  test("desired + live + home + no record → checkout with home location", () => {
    const actions = reconcilePins(
      input({
        desired: new Set(["%1"]),
        live: new Map([["%1", loc("$2", "@5")]]),
      }),
    );
    expect(actions).toEqual([
      { type: "checkout", paneId: "%1", home: { sessionId: "$2", windowId: "@5" } },
    ]);
  });

  test("desired + already in holding → no action (steady state)", () => {
    const actions = reconcilePins(
      input({
        desired: new Set(["%1"]),
        records: new Map([["%1", rec("%1")]]),
        live: new Map([["%1", loc(HOLDING, "@99")]]),
      }),
    );
    expect(actions).toEqual([]);
  });

  test("crash between record and break: desired, record exists, pane still home → re-checkout", () => {
    const actions = reconcilePins(
      input({
        desired: new Set(["%1"]),
        records: new Map([["%1", rec("%1", { homeSessionId: "$2", homeWindowId: "@5" })]]),
        live: new Map([["%1", loc("$2", "@5")]]),
      }),
    );
    expect(actions).toEqual([
      { type: "checkout", paneId: "%1", home: { sessionId: "$2", windowId: "@5" } },
    ]);
  });

  test("checked out but no longer desired → restore home", () => {
    const r = rec("%1");
    const actions = reconcilePins(
      input({
        desired: new Set(),
        records: new Map([["%1", r]]),
        live: new Map([["%1", loc(HOLDING, "@99")]]),
      }),
    );
    expect(actions).toEqual([{ type: "restore", record: r }]);
  });

  test("desired pane no longer live (process exited) → discard its record", () => {
    const actions = reconcilePins(
      input({
        desired: new Set(["%1"]),
        records: new Map([["%1", rec("%1")]]),
        live: new Map(),
      }),
    );
    expect(actions).toEqual([{ type: "discardRecord", paneId: "%1" }]);
  });

  test("record for a no-longer-desired, no-longer-live pane → discard", () => {
    const actions = reconcilePins(
      input({
        records: new Map([["%1", rec("%1")]]),
        live: new Map(),
      }),
    );
    expect(actions).toEqual([{ type: "discardRecord", paneId: "%1" }]);
  });

  test("record for a no-longer-desired pane already back home → discard record", () => {
    const actions = reconcilePins(
      input({
        records: new Map([["%1", rec("%1")]]),
        live: new Map([["%1", loc("$2", "@5")]]),
      }),
    );
    expect(actions).toEqual([{ type: "discardRecord", paneId: "%1" }]);
  });

  test("holdingSessionId null: cannot check out yet, emits nothing for fresh pins", () => {
    const actions = reconcilePins(
      input({
        desired: new Set(["%1"]),
        live: new Map([["%1", loc("$2", "@5")]]),
        holdingSessionId: null,
      }),
    );
    expect(actions).toEqual([]);
  });
});

describe("planRestore", () => {
  const record = rec("%1", {
    homeSessionId: "$2",
    homeWindowId: "@5",
    homeLayout: "savedlayout",
  });

  test("home window alive → rejoin + layout", () => {
    const plan = planRestore(record, new Set(["@5", "@6"]), new Set(["$2"]));
    expect(plan).toEqual({ mode: "rejoinWindow", windowId: "@5", layout: "savedlayout" });
  });

  test("home window gone, session alive → new window in session", () => {
    const plan = planRestore(record, new Set(["@6"]), new Set(["$2"]));
    expect(plan).toEqual({ mode: "newWindowInSession", sessionId: "$2" });
  });

  test("home session gone → new session (never kill the process)", () => {
    const plan = planRestore(record, new Set(["@6"]), new Set(["$9"]));
    expect(plan).toEqual({ mode: "newSession" });
  });
});
