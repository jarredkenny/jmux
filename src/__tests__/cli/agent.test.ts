import { describe, test, expect } from "bun:test";
import {
  parseAgentStateLine,
  diffAgentStates,
  type WatchEntry,
} from "../../cli/agent";
import { US } from "../../tmux-fields";

function line(parts: string[]): string {
  return parts.join(US);
}

describe("parseAgentStateLine", () => {
  test("parses a complete running record with the agent pane", () => {
    const rec = parseAgentStateLine(
      line(["$1", "TRA-123", "running", "1781480000", "%12", "%99", "/repo/wt"]),
      1781480123,
    );
    expect(rec).toEqual({
      session: "TRA-123",
      sessionId: "$1",
      state: "running",
      since: 1781480000,
      ageSeconds: 123,
      agentPane: "%12",
      activePane: "%99",
      path: "/repo/wt",
    });
  });

  test("agentPane is null when the hook option is unset, falling back via activePane", () => {
    const rec = parseAgentStateLine(
      line(["$1", "TRA-123", "running", "1781480000", "", "%99", "/repo/wt"]),
      1781480000,
    );
    expect(rec?.agentPane).toBeNull();
    expect(rec?.activePane).toBe("%99");
  });

  test("maps an unset/empty state to null", () => {
    const rec = parseAgentStateLine(
      line(["$2", "shell", "", "", "", "%3", "/home"]),
      1781480123,
    );
    expect(rec?.state).toBeNull();
    expect(rec?.since).toBeNull();
    expect(rec?.ageSeconds).toBeNull();
  });

  test("rejects an unknown state value", () => {
    const rec = parseAgentStateLine(
      line(["$2", "s", "bogus", "1781480000", "%9", "%3", "/home"]),
      1781480000,
    );
    expect(rec?.state).toBeNull();
  });

  test("clamps negative age to zero (clock skew)", () => {
    const rec = parseAgentStateLine(
      line(["$1", "s", "waiting", "1781480100", "%9", "%1", "/p"]),
      1781480000,
    );
    expect(rec?.ageSeconds).toBe(0);
  });

  test("returns null when fields are missing", () => {
    expect(parseAgentStateLine("$1\x1fonly-two", 0)).toBeNull();
  });

  test("parses tmux 3.4 output where the separator is octal-escaped (issue #7)", () => {
    // tmux 3.4 emits the literal text `\037` in place of the raw 0x1F byte.
    const rec = parseAgentStateLine(
      ["$1", "TRA-123", "running", "1781480000", "%12", "%99", "/repo/wt"].join("\\037"),
      1781480123,
    );
    expect(rec).toEqual({
      session: "TRA-123",
      sessionId: "$1",
      state: "running",
      since: 1781480000,
      ageSeconds: 123,
      agentPane: "%12",
      activePane: "%99",
      path: "/repo/wt",
    });
  });
});

describe("diffAgentStates", () => {
  const entry = (
    session: string,
    state: WatchEntry["state"],
    since: number | null,
  ): WatchEntry => ({ session, state, since });

  test("emits a new session only when it has an agent state", () => {
    const prev = new Map<string, WatchEntry>();
    const next = new Map<string, WatchEntry>([
      ["$1", entry("TRA-1", "running", 100)],
      ["$2", entry("shell", null, null)],
    ]);
    const events = diffAgentStates(prev, next);
    expect(events).toEqual([
      { type: "agent_state_changed", session: "TRA-1", state: "running", since: 100 },
    ]);
  });

  test("emits on a state transition", () => {
    const prev = new Map([["$1", entry("TRA-1", "running", 100)]]);
    const next = new Map([["$1", entry("TRA-1", "waiting", 200)]]);
    expect(diffAgentStates(prev, next)).toEqual([
      { type: "agent_state_changed", session: "TRA-1", state: "waiting", since: 200 },
    ]);
  });

  test("emits when only `since` changes (a re-run with the same label)", () => {
    const prev = new Map([["$1", entry("TRA-1", "running", 100)]]);
    const next = new Map([["$1", entry("TRA-1", "running", 150)]]);
    expect(diffAgentStates(prev, next)).toHaveLength(1);
  });

  test("does not emit when nothing changed", () => {
    const prev = new Map([["$1", entry("TRA-1", "running", 100)]]);
    const next = new Map([["$1", entry("TRA-1", "running", 100)]]);
    expect(diffAgentStates(prev, next)).toEqual([]);
  });

  test("emits a terminal null event when a known agent session disappears", () => {
    const prev = new Map([["$1", entry("TRA-1", "complete", 100)]]);
    const next = new Map<string, WatchEntry>();
    expect(diffAgentStates(prev, next)).toEqual([
      { type: "agent_state_changed", session: "TRA-1", state: null, since: null },
    ]);
  });

  test("does not emit when an idle (null-state) session disappears", () => {
    const prev = new Map([["$1", entry("shell", null, null)]]);
    const next = new Map<string, WatchEntry>();
    expect(diffAgentStates(prev, next)).toEqual([]);
  });
});
