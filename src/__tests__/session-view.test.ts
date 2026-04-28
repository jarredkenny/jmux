import { describe, test, expect } from "bun:test";
import { buildSessionView, buildSessionRow3 } from "../session-view";
import type { SessionInfo, SessionOtelState } from "../types";
import { makeSessionOtelState } from "../types";
import type { SessionContext, MergeRequest, LinkSource } from "../adapters/types";

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

  test("timer shows 0:00 when expired", () => {
    const timer: SessionOtelState = { ...makeSessionOtelState(), lastRequestTime: Date.now() - 400_000, cacheWasHit: true };
    const view = buildSessionView(makeSession(), undefined, timer, new Set());
    expect(view.timerText).toBe("0:00");
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
    const out = buildSessionRow3(state, 26);
    expect(out).toContain("$1.23");
  });

  test("formats tool with seconds duration", () => {
    const state = baseState();
    state.lastTool = { name: "Edit", durationMs: 1234, success: true, timestamp: Date.now() };
    const out = buildSessionRow3(state, 26);
    expect(out).toContain("Edit 1.2s");
  });

  test("formats tool with minute+second duration", () => {
    const state = baseState();
    state.lastTool = { name: "Bash", durationMs: 80_000, success: true, timestamp: Date.now() };
    const out = buildSessionRow3(state, 26);
    expect(out).toContain("Bash 1m20s");
  });

  test("formats idle as 3m idle", () => {
    const state = baseState();
    state.lastUserPromptTime = Date.now() - 3 * 60 * 1000;
    const out = buildSessionRow3(state, 26);
    expect(out).toContain("3m idle");
  });

  test("omits cost when zero", () => {
    const state = baseState();
    state.lastTool = { name: "Edit", durationMs: 100, success: true, timestamp: Date.now() };
    const out = buildSessionRow3(state, 26);
    expect(out).not.toContain("$");
  });

  test("omits last tool when null", () => {
    const state = baseState();
    state.costUsd = 1.0;
    const out = buildSessionRow3(state, 26);
    expect(out).not.toContain("Edit");
    expect(out).not.toContain("Bash");
  });

  test("omits idle when no user_prompt seen", () => {
    const state = baseState();
    state.costUsd = 1.0;
    const out = buildSessionRow3(state, 26);
    expect(out).not.toContain("idle");
  });

  test("on overflow drops idle first", () => {
    // Width 16 — too tight for cost + tool + idle, plenty for cost + tool
    const state = baseState();
    state.costUsd = 1.0;
    state.lastTool = { name: "Edit", durationMs: 1000, success: true, timestamp: Date.now() };
    state.lastUserPromptTime = Date.now() - 60_000;
    const out = buildSessionRow3(state, 16);
    expect(out).toContain("$1.00");
    expect(out).toContain("Edit");
    expect(out).not.toContain("idle");
  });

  test("on tighter overflow drops tool next, keeps cost", () => {
    const state = baseState();
    state.costUsd = 1.0;
    state.lastTool = { name: "Edit", durationMs: 1000, success: true, timestamp: Date.now() };
    state.lastUserPromptTime = Date.now() - 60_000;
    const out = buildSessionRow3(state, 8);
    expect(out).toContain("$1.00");
    expect(out).not.toContain("Edit");
    expect(out).not.toContain("idle");
  });

  test("returns empty string when no fields apply", () => {
    expect(buildSessionRow3(baseState(), 26)).toBe("");
  });
});
