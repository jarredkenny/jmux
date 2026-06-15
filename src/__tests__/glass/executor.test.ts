import { describe, test, expect } from "bun:test";
import { GlassExecutor } from "../../glass/executor";
import type { GlassRunner, RecordStore } from "../../glass/executor";
import type { PinnedPaneRecord, ReconcileAction } from "../../glass/types";

class FakeRunner implements GlassRunner {
  calls: string[][] = [];
  responses: ((args: string[]) => string[]) = () => [];
  run(args: string[]): { ok: boolean; lines: string[] } {
    this.calls.push(args);
    return { ok: true, lines: this.responses(args) };
  }
}

class FakeStore implements RecordStore {
  map = new Map<string, PinnedPaneRecord>();
  events: string[] = [];
  get(): PinnedPaneRecord[] { return [...this.map.values()]; }
  put(r: PinnedPaneRecord): void { this.map.set(r.paneId, r); this.events.push(`put:${r.paneId}`); }
  remove(id: string): void { this.map.delete(id); this.events.push(`remove:${id}`); }
}

describe("GlassExecutor", () => {
  test("checkout: persists the record BEFORE breaking the pane", () => {
    const runner = new FakeRunner();
    runner.responses = (args) =>
      args[0] === "display-message" ? ["thelayout"] :
      args[0] === "break-pane" ? ["@77"] : [];
    const store = new FakeStore();
    const ex = new GlassExecutor({
      runner, store,
      holdingSession: "__jmux_glass",
      holdingSessionId: "$glass",
    });

    const actions: ReconcileAction[] = [
      { type: "checkout", paneId: "%7", home: { sessionId: "$2", windowId: "@5" } },
    ];
    ex.apply(actions);

    expect(store.map.get("%7")).toEqual({
      paneId: "%7", homeSessionId: "$2", homeWindowId: "@5", homeLayout: "thelayout",
    });
    const putIdx = store.events.indexOf("put:%7");
    const breakIdx = runner.calls.findIndex((c) => c[0] === "break-pane");
    const layoutIdx = runner.calls.findIndex((c) => c[0] === "display-message");
    expect(putIdx).toBe(0);
    expect(layoutIdx).toBeLessThan(breakIdx);
  });

  test("restore: rejoins home then drops the record AFTER success", () => {
    const runner = new FakeRunner();
    runner.responses = (args) => {
      if (args[0] === "list-windows") return ["@5"];
      if (args[0] === "list-sessions") return ["$2"];
      if (args[0] === "display-message") return ["@88"];
      return [];
    };
    const store = new FakeStore();
    const rec: PinnedPaneRecord = {
      paneId: "%7", homeSessionId: "$2", homeWindowId: "@5", homeLayout: "L",
    };
    store.put(rec);
    store.events.length = 0;
    const ex = new GlassExecutor({ runner, store, holdingSession: "__jmux_glass", holdingSessionId: "$glass" });

    ex.apply([{ type: "restore", record: rec }]);

    const joinIdx = runner.calls.findIndex((c) => c[0] === "join-pane");
    const removeIdx = store.events.indexOf("remove:%7");
    expect(joinIdx).toBeGreaterThanOrEqual(0);
    expect(removeIdx).toBeGreaterThanOrEqual(0);
    expect(store.map.has("%7")).toBe(false);
  });

  test("discardRecord: removes the record, runs no tmux mutation", () => {
    const runner = new FakeRunner();
    const store = new FakeStore();
    store.put({ paneId: "%7", homeSessionId: "$2", homeWindowId: "@5", homeLayout: "L" });
    store.events.length = 0;
    const ex = new GlassExecutor({ runner, store, holdingSession: "__jmux_glass", holdingSessionId: "$glass" });

    ex.apply([{ type: "discardRecord", paneId: "%7" }]);

    expect(store.map.has("%7")).toBe(false);
    expect(runner.calls.filter((c) => c[0] !== "list-windows" && c[0] !== "list-sessions")).toEqual([]);
  });
});
