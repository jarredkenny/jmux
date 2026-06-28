import { describe, test, expect } from "bun:test";
import { parsePaneStateLines, PANE_STATE_FORMAT } from "../../glass/reflect";

describe("parsePaneStateLines", () => {
  test("splits pane id, pin value, session id, window id", () => {
    const { pinned, pins, live } = parsePaneStateLines([
      "%1\x1f1\x1f$2\x1f@5",          // legacy "1"
      "%2\x1f\x1f$2\x1f@6",            // unset
      "%3\x1fbackend\x1f$3\x1f@9",    // tab id
    ]);
    expect([...pinned].sort()).toEqual(["%1", "%3"]);
    expect(pins.get("%1")).toBe("1");
    expect(pins.get("%3")).toBe("backend");
    expect(pins.has("%2")).toBe(false);
    expect(live.get("%1")).toEqual({ sessionId: "$2", windowId: "@5" });
    expect(live.get("%3")).toEqual({ sessionId: "$3", windowId: "@9" });
  });

  test("any non-empty value counts as pinned and is stored verbatim", () => {
    const { pinned, pins } = parsePaneStateLines(["%7\x1freview\x1f$1\x1f@1"]);
    expect(pinned.has("%7")).toBe(true);
    expect(pins.get("%7")).toBe("review");
  });

  test("ignores blank lines", () => {
    const { live } = parsePaneStateLines(["", "%9\x1f1\x1f$1\x1f@1", ""]);
    expect(live.size).toBe(1);
  });

  test("PANE_STATE_FORMAT requests the four fields, US-separated", () => {
    expect(PANE_STATE_FORMAT).toBe("#{pane_id}\x1f#{@jmux-pinned}\x1f#{session_id}\x1f#{window_id}");
  });

  test("parses tmux 3.4 output where the separator is octal-escaped (issue #7)", () => {
    const { pinned, pins, live } = parsePaneStateLines([
      "%1\\037backend\\037$3\\037@9",
    ]);
    expect(pinned.has("%1")).toBe(true);
    expect(pins.get("%1")).toBe("backend");
    expect(live.get("%1")).toEqual({ sessionId: "$3", windowId: "@9" });
  });
});
