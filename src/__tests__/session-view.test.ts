import { describe, test, expect } from "bun:test";
import { buildSessionView, buildSessionRow3 } from "../session-view";
import type { SessionInfo, SessionOtelState, AgentState } from "../types";
import { makeSessionOtelState } from "../types";
import type { SessionContext, MergeRequest, LinkSource } from "../adapters/types";
import type { AgentStateRecord } from "../types";

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "$0",
    name: "test-session",
    attached: false,
    activity: 0,
    attention: false,
    windowCount: 1,
    ...overrides,
  };
}

function makeMr(overrides: Partial<MergeRequest & { source: LinkSource }> = {}): MergeRequest & { source: LinkSource } {
  return {
    id: "proj:1",
    title: "Test MR",
    status: "open",
    sourceBranch: "feat",
    targetBranch: "main",
    pipeline: null,
    approvals: { required: 0, current: 0 },
    webUrl: "",
    source: "branch",
    ...overrides,
  };
}

function makeCtx(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    sessionName: "test-session",
    dir: "/tmp",
    branch: "main",
    remote: null,
    mrs: [],
    issues: [],
    resolvedAt: Date.now(),
    ...overrides,
  };
}

describe("buildSessionView", () => {
  test("returns null fields when no context", () => {
    const view = buildSessionView(makeSession(), undefined, undefined, new Set());
    expect(view.sessionId).toBe("$0");
    expect(view.sessionName).toBe("test-session");
    expect(view.linearId).toBeNull();
    expect(view.branch).toBeNull();
    expect(view.mrId).toBeNull();
    expect(view.pipelineState).toBeNull();
    expect(view.timerText).toBeNull();
    expect(view.hasActivity).toBe(false);
    expect(view.hasAttention).toBe(false);
  });

  test("uses gitBranch from session", () => {
    const view = buildSessionView(
      makeSession({ gitBranch: "feat/cool" }),
      undefined,
      undefined,
      new Set(),
    );
    expect(view.branch).toBe("feat/cool");
  });

  test("populates linearId from first issue", () => {
    const ctx = makeCtx({
      issues: [
        { id: "i1", identifier: "ENG-1234", title: "T", status: "In Progress", assignee: null, linkedMrUrls: [], webUrl: "", source: "branch" as LinkSource },
        { id: "i2", identifier: "ENG-5678", title: "T", status: "Todo", assignee: null, linkedMrUrls: [], webUrl: "", source: "branch" as LinkSource },
      ],
    });
    const view = buildSessionView(makeSession(), ctx, undefined, new Set());
    expect(view.linearId).toBe("ENG-1234");
  });

  test("selects latest MR by createdAt", () => {
    const ctx = makeCtx({
      mrs: [
        makeMr({ id: "proj:10", createdAt: 1000 }),
        makeMr({ id: "proj:20", createdAt: 3000 }),
        makeMr({ id: "proj:15", createdAt: 2000 }),
      ],
    });
    const view = buildSessionView(makeSession(), ctx, undefined, new Set());
    expect(view.mrId).toBe("!20");
  });

  test("falls back to last MR in array when no createdAt", () => {
    const ctx = makeCtx({
      mrs: [
        makeMr({ id: "proj:10" }),
        makeMr({ id: "proj:20" }),
      ],
    });
    const view = buildSessionView(makeSession(), ctx, undefined, new Set());
    expect(view.mrId).toBe("!20");
  });

  test("extracts pipeline state from selected MR", () => {
    const ctx = makeCtx({
      mrs: [
        makeMr({ id: "proj:5", createdAt: 1000, pipeline: { state: "passed", webUrl: "" } }),
        makeMr({ id: "proj:10", createdAt: 2000, pipeline: { state: "failed", webUrl: "" } }),
      ],
    });
    const view = buildSessionView(makeSession(), ctx, undefined, new Set());
    expect(view.mrId).toBe("!10");
    expect(view.pipelineState).toBe("failed");
  });

  test("computes timer text and remaining", () => {
    const now = Date.now();
    const timer: SessionOtelState = { ...makeSessionOtelState(), lastRequestTime: now - 60_000, cacheWasHit: true };
    const view = buildSessionView(makeSession(), undefined, timer, new Set());
    expect(view.timerText).toBe("4:00");
    expect(view.timerRemaining).toBe(240);
  });

  test("timer falls back to elapsed when cache expired", () => {
    // Cache expired (400s > 300s TTL); no agentState → elapsed from lastRequestTime
    const timer: SessionOtelState = { ...makeSessionOtelState(), lastRequestTime: Date.now() - 400_000, cacheWasHit: true };
    const view = buildSessionView(makeSession(), undefined, timer, new Set());
    expect(view.timerText).toBe("6m");
    expect(view.timerRemaining).toBe(0);
  });

  test("timer is null when no timer state", () => {
    const view = buildSessionView(makeSession(), undefined, undefined, new Set());
    expect(view.timerText).toBeNull();
  });

  test("timer is null when state exists but lastRequestTime is 0", () => {
    const session = makeSession({ id: "$0", name: "main" });
    const state: SessionOtelState = {
      ...makeSessionOtelState(),
      permissionMode: "plan", // any non-api_request event would produce this state
    };
    const view = buildSessionView(session, undefined, state, new Set());
    expect(view.timerText).toBeNull();
    expect(view.timerRemaining).toBe(0);
  });

  test("sets hasActivity from activitySet", () => {
    const view = buildSessionView(makeSession(), undefined, undefined, new Set(["$0"]));
    expect(view.hasActivity).toBe(true);
  });

  test("sets hasAttention from session", () => {
    const view = buildSessionView(makeSession({ attention: true }), undefined, undefined, new Set());
    expect(view.hasAttention).toBe(true);
  });

  test("MR id extracts iid from compound id", () => {
    const ctx = makeCtx({
      mrs: [makeMr({ id: "my%2Fproject:42" })],
    });
    const view = buildSessionView(makeSession(), ctx, undefined, new Set());
    expect(view.mrId).toBe("!42");
  });
});

describe("buildSessionRow3", () => {
  const baseState = () => makeSessionOtelState();

  test("formats cost as $1.23", () => {
    const state = baseState();
    state.costUsd = 1.234;
    const out = buildSessionRow3(state, 26, null);
    expect(out).toContain("$1.23");
  });

  test("formats tool with seconds duration", () => {
    const state = baseState();
    state.lastTool = { name: "Edit", durationMs: 1234, success: true, timestamp: Date.now() };
    const out = buildSessionRow3(state, 26, null);
    expect(out).toContain("Edit 1.2s");
  });

  test("formats tool with minute+second duration", () => {
    const state = baseState();
    state.lastTool = { name: "Bash", durationMs: 80_000, success: true, timestamp: Date.now() };
    const out = buildSessionRow3(state, 26, null);
    expect(out).toContain("Bash 1m20s");
  });

  test("formats idle as 3m idle", () => {
    const state = baseState();
    state.lastUserPromptTime = Date.now() - 3 * 60 * 1000;
    const out = buildSessionRow3(state, 26, null);
    expect(out).toContain("3m idle");
  });

  test("omits cost when zero", () => {
    const state = baseState();
    state.lastTool = { name: "Edit", durationMs: 100, success: true, timestamp: Date.now() };
    const out = buildSessionRow3(state, 26, null);
    expect(out).not.toContain("$");
  });

  test("omits last tool when null", () => {
    const state = baseState();
    state.costUsd = 1.0;
    const out = buildSessionRow3(state, 26, null);
    expect(out).not.toContain("Edit");
    expect(out).not.toContain("Bash");
  });

  test("omits idle when no user_prompt seen", () => {
    const state = baseState();
    state.costUsd = 1.0;
    const out = buildSessionRow3(state, 26, null);
    expect(out).not.toContain("idle");
  });

  test("on overflow drops idle first", () => {
    // Width 16 — too tight for cost + tool + idle, plenty for cost + tool
    const state = baseState();
    state.costUsd = 1.0;
    state.lastTool = { name: "Edit", durationMs: 1000, success: true, timestamp: Date.now() };
    state.lastUserPromptTime = Date.now() - 60_000;
    const out = buildSessionRow3(state, 16, null);
    expect(out).toContain("$1.00");
    expect(out).toContain("Edit");
    expect(out).not.toContain("idle");
  });

  test("on tighter overflow drops tool next, keeps cost", () => {
    const state = baseState();
    state.costUsd = 1.0;
    state.lastTool = { name: "Edit", durationMs: 1000, success: true, timestamp: Date.now() };
    state.lastUserPromptTime = Date.now() - 60_000;
    const out = buildSessionRow3(state, 8, null);
    expect(out).toContain("$1.00");
    expect(out).not.toContain("Edit");
    expect(out).not.toContain("idle");
  });

  test("returns empty string when no fields apply", () => {
    expect(buildSessionRow3(baseState(), 26, null)).toBe("");
  });
});

describe("buildSessionView — agent state", () => {
  test("populates agentState and agentStateSince when record passed", () => {
    const since = Date.now() - 5_000;
    const view = buildSessionView(
      makeSession(),
      undefined,
      undefined,
      new Set(),
      { state: "running", since },
    );
    expect(view.agentState).toBe("running");
    expect(view.agentStateSince).toBe(since);
  });

  test("agentState is null when no record passed", () => {
    const view = buildSessionView(makeSession(), undefined, undefined, new Set());
    expect(view.agentState).toBeNull();
    expect(view.agentStateSince).toBeNull();
  });

  test("explicit null record is equivalent to no record", () => {
    const view = buildSessionView(
      makeSession(),
      undefined,
      undefined,
      new Set(),
      null,
    );
    expect(view.agentState).toBeNull();
    expect(view.agentStateSince).toBeNull();
  });
});

describe("buildSessionView — row-1 timer fallback", () => {
  test("cache countdown wins over agentState elapsed when cache is alive", () => {
    const otel = makeSessionOtelState();
    otel.lastRequestTime = Date.now() - 60_000;  // 240s remaining on 300s cache
    const view = buildSessionView(
      makeSession(),
      undefined,
      otel,
      new Set(),
      { state: "running", since: Date.now() - 8_000 },
    );
    // Cache TTL is 5 minutes (300s); 60s elapsed → ~240s remaining → "4:00"-ish
    expect(view.timerText).toMatch(/^[0-9]:[0-5][0-9]$/);
    expect(view.timerRemaining).toBeGreaterThan(0);
  });

  test("promoted session, cache expired → elapsed from agentStateSince", () => {
    const otel = makeSessionOtelState();
    otel.lastRequestTime = Date.now() - 10 * 60 * 1000;  // cache expired
    otel.lastUserPromptTime = Date.now() - 10 * 60 * 1000;
    const since = Date.now() - 90_000;  // 1m30s ago
    const view = buildSessionView(
      makeSession(),
      undefined,
      otel,
      new Set(),
      { state: "waiting", since },
    );
    expect(view.timerText).toBe("1m");
    expect(view.timerRemaining).toBe(0);
  });

  test("non-promoted session with OTEL data → elapsed from latest OTEL event", () => {
    const otel = makeSessionOtelState();
    otel.lastRequestTime = Date.now() - 10 * 60 * 1000;
    otel.lastUserPromptTime = Date.now() - 45_000;
    const view = buildSessionView(makeSession(), undefined, otel, new Set());
    expect(view.timerText).toBe("45s");
  });

  test("non-promoted session with no OTEL data → blank timer", () => {
    const view = buildSessionView(makeSession(), undefined, undefined, new Set());
    expect(view.timerText).toBeNull();
  });

  test("promoted COMPLETE state with no cache shows agentStateSince elapsed", () => {
    const view = buildSessionView(
      makeSession(),
      undefined,
      undefined,
      new Set(),
      { state: "complete", since: Date.now() - 30_000 },
    );
    expect(view.timerText).toBe("30s");
  });
});

function rowWithState(
  state: AgentState,
  width: number,
  otelOverrides: Partial<SessionOtelState> = {},
): string {
  const otel = makeSessionOtelState();
  otel.costUsd = 0.42;
  otel.lastTool = { name: "Edit", durationMs: 2_100, success: true, timestamp: Date.now() };
  Object.assign(otel, otelOverrides);
  return buildSessionRow3(otel, width, state);
}

describe("buildSessionRow3 — promoted session with state label", () => {
  test("wide width (26) — cost + tool + state, state on right", () => {
    const text = rowWithState("running", 26);
    expect(text).toContain("$0.42");
    expect(text).toContain("Edit 2.1s");
    expect(text.trimEnd().endsWith("RUNNING")).toBe(true);
  });

  test("narrower width (18) — drop tool, keep cost + state", () => {
    const text = rowWithState("waiting", 18);
    expect(text).toContain("$0.42");
    expect(text).not.toContain("Edit 2.1s");
    expect(text.trimEnd().endsWith("WAITING")).toBe(true);
  });

  test("very narrow (10) — drop cost, state stays", () => {
    const text = rowWithState("complete", 10);
    expect(text).not.toContain("$0.42");
    expect(text).not.toContain("Edit 2.1s");
    expect(text.trimEnd().endsWith("COMPLETE")).toBe(true);
  });

  test("zero width — degrades gracefully (state truncated, no throw)", () => {
    expect(() => rowWithState("running", 0)).not.toThrow();
  });
});

describe("buildSessionRow3 — non-promoted session preserves existing behavior", () => {
  test("null state → today's cost/tool/idle layout", () => {
    const otel = makeSessionOtelState();
    otel.costUsd = 0.42;
    otel.lastUserPromptTime = Date.now() - 60_000;
    const text = buildSessionRow3(otel, 26, null);
    expect(text).toContain("$0.42");
    expect(text).toMatch(/idle/);
  });

  test("null state with no data → empty string", () => {
    const otel = makeSessionOtelState();
    const text = buildSessionRow3(otel, 26, null);
    expect(text).toBe("");
  });
});
