import { describe, test, expect } from "bun:test";
import { AgentStateTracker } from "../agent-state";

describe("AgentStateTracker.apply", () => {
  test("stores a valid (state, since) pair", () => {
    const t = new AgentStateTracker();
    t.apply("$1", "running", "1717000000");
    expect(t.getRecord("$1")).toEqual({
      state: "running",
      since: 1_717_000_000_000,
    });
    expect(t.getState("$1")).toBe("running");
  });

  test("clears the record when state is null or empty", () => {
    const t = new AgentStateTracker();
    t.apply("$1", "running", "1717000000");
    t.apply("$1", null, null);
    expect(t.getRecord("$1")).toBeNull();
    expect(t.getState("$1")).toBeNull();
  });

  test("treats empty-string raw values as cleared (tmux unset)", () => {
    const t = new AgentStateTracker();
    t.apply("$1", "running", "1717000000");
    t.apply("$1", "", "");
    expect(t.getRecord("$1")).toBeNull();
  });

  test("ignores invalid state strings", () => {
    const t = new AgentStateTracker();
    t.apply("$1", "running", "1717000000");
    t.apply("$1", "bogus", "1717000010");
    expect(t.getRecord("$1")?.state).toBe("running");
  });

  test("falls back to nowMs when since is missing or unparseable", () => {
    const t = new AgentStateTracker(() => 1_800_000_000_000);
    t.apply("$1", "running", null);
    expect(t.getRecord("$1")).toEqual({
      state: "running",
      since: 1_800_000_000_000,
    });
    t.apply("$2", "running", "not-a-number");
    expect(t.getRecord("$2")?.since).toBe(1_800_000_000_000);
  });

  test("getState returns null for unknown ids", () => {
    const t = new AgentStateTracker();
    expect(t.getState("$missing")).toBeNull();
    expect(t.getRecord("$missing")).toBeNull();
  });

  test("default clock uses Date.now() when no nowMs is injected", () => {
    const before = Date.now();
    const t = new AgentStateTracker();
    t.apply("$1", "running", null);
    const after = Date.now();
    const since = t.getRecord("$1")?.since ?? 0;
    expect(since).toBeGreaterThanOrEqual(before);
    expect(since).toBeLessThanOrEqual(after);
  });
});

describe("AgentStateTracker.onChange", () => {
  test("fires on real changes", () => {
    const t = new AgentStateTracker();
    const seen: string[] = [];
    t.onChange((id) => seen.push(id));

    t.apply("$1", "running", "1717000000");
    t.apply("$1", "waiting", "1717000010");
    expect(seen).toEqual(["$1", "$1"]);
  });

  test("does NOT fire on idempotent (same state, same since) re-apply", () => {
    const t = new AgentStateTracker();
    const seen: string[] = [];
    t.onChange((id) => seen.push(id));

    t.apply("$1", "running", "1717000000");
    t.apply("$1", "running", "1717000000");
    expect(seen).toEqual(["$1"]);
  });

  test("DOES fire when only since changes", () => {
    const t = new AgentStateTracker();
    const seen: string[] = [];
    t.onChange((id) => seen.push(id));

    t.apply("$1", "running", "1717000000");
    t.apply("$1", "running", "1717000050");
    expect(seen).toEqual(["$1", "$1"]);
  });

  test("fires on clear if there was a prior record", () => {
    const t = new AgentStateTracker();
    const seen: string[] = [];
    t.onChange((id) => seen.push(id));

    t.apply("$1", "running", "1717000000");
    t.apply("$1", null, null);
    expect(seen).toEqual(["$1", "$1"]);
  });

  test("does NOT fire on clear if there was no prior record", () => {
    const t = new AgentStateTracker();
    const seen: string[] = [];
    t.onChange((id) => seen.push(id));

    t.apply("$1", null, null);
    expect(seen).toEqual([]);
  });
});

describe("AgentStateTracker.pruneExcept", () => {
  test("removes records for ids not in the active set", () => {
    const t = new AgentStateTracker();
    t.apply("$1", "running", "1717000000");
    t.apply("$2", "waiting", "1717000010");
    t.apply("$3", "complete", "1717000020");

    t.pruneExcept(["$1", "$3"]);
    expect(t.getState("$1")).toBe("running");
    expect(t.getState("$2")).toBeNull();
    expect(t.getState("$3")).toBe("complete");
  });

  test("does NOT emit change events for pruned records", () => {
    const t = new AgentStateTracker();
    t.apply("$1", "running", "1717000000");
    t.apply("$2", "waiting", "1717000010");

    const seen: string[] = [];
    t.onChange((id) => seen.push(id));

    t.pruneExcept(["$1"]);
    expect(seen).toEqual([]);
  });
});

describe("AgentStateTracker.size", () => {
  test("reflects number of tracked records", () => {
    const t = new AgentStateTracker();
    expect(t.size).toBe(0);
    t.apply("$1", "running", "1717000000");
    expect(t.size).toBe(1);
    t.apply("$1", null, null);
    expect(t.size).toBe(0);
  });
});

import { coerceStaleAgentState } from "../agent-state";

const TEN_MIN_MS = 10 * 60 * 1000;

describe("coerceStaleAgentState", () => {
  test("returns null unchanged", () => {
    expect(
      coerceStaleAgentState(null, "2026-05-20T12:00:00Z", Date.parse("2026-05-20T12:05:00Z"), TEN_MIN_MS),
    ).toBeNull();
  });

  test("returns the input unchanged when within the threshold", () => {
    const stored = { state: "running" as const, since: "2026-05-20T11:59:00Z" };
    const out = coerceStaleAgentState(
      stored,
      "2026-05-20T12:00:00Z",
      Date.parse("2026-05-20T12:05:00Z"),
      TEN_MIN_MS,
    );
    expect(out).toEqual(stored);
  });

  test("coerces stale running to complete", () => {
    const stored = { state: "running" as const, since: "2026-05-20T10:00:00Z" };
    const out = coerceStaleAgentState(
      stored,
      "2026-05-20T10:00:00Z",
      Date.parse("2026-05-20T12:00:00Z"),
      TEN_MIN_MS,
    );
    expect(out).toEqual({
      state: "complete",
      since: "2026-05-20T10:00:00Z",
    });
  });

  test("coerces stale waiting to complete", () => {
    const stored = { state: "waiting" as const, since: "2026-05-20T10:00:00Z" };
    const out = coerceStaleAgentState(
      stored,
      "2026-05-20T10:00:00Z",
      Date.parse("2026-05-20T12:00:00Z"),
      TEN_MIN_MS,
    );
    expect(out?.state).toBe("complete");
  });

  test("leaves stale complete unchanged", () => {
    const stored = { state: "complete" as const, since: "2026-05-20T10:00:00Z" };
    const out = coerceStaleAgentState(
      stored,
      "2026-05-20T10:00:00Z",
      Date.parse("2026-05-20T12:00:00Z"),
      TEN_MIN_MS,
    );
    expect(out).toEqual(stored);
  });

  test("malformed capturedAt is treated as stale (safest)", () => {
    const stored = { state: "running" as const, since: "2026-05-20T10:00:00Z" };
    const out = coerceStaleAgentState(
      stored,
      "garbage",
      Date.parse("2026-05-20T12:00:00Z"),
      TEN_MIN_MS,
    );
    expect(out?.state).toBe("complete");
  });
});
