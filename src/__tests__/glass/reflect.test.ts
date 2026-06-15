import { describe, test, expect } from "bun:test";
import { parsePaneStateLines, PANE_STATE_FORMAT } from "../../glass/reflect";

describe("parsePaneStateLines", () => {
  test("splits pane id, pinned flag, session id, window id", () => {
    const { pinned, live } = parsePaneStateLines([
      "%1\x1f1\x1f$2\x1f@5",
      "%2\x1f\x1f$2\x1f@6",
      "%3\x1f1\x1f$glass\x1f@9",
    ]);
    expect([...pinned].sort()).toEqual(["%1", "%3"]);
    expect(live.get("%1")).toEqual({ sessionId: "$2", windowId: "@5" });
    expect(live.get("%3")).toEqual({ sessionId: "$glass", windowId: "@9" });
  });

  test("ignores blank lines", () => {
    const { live } = parsePaneStateLines(["", "%9\x1f1\x1f$1\x1f@1", ""]);
    expect(live.size).toBe(1);
  });

  test("PANE_STATE_FORMAT requests the four fields, US-separated", () => {
    expect(PANE_STATE_FORMAT).toBe("#{pane_id}\x1f#{@jmux-pinned}\x1f#{session_id}\x1f#{window_id}");
  });
});
