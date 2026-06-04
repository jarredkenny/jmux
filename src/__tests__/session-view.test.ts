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

  test("MR id with '#' separator (GitHub) renders as '#N'", () => {
    const ctx = makeCtx({
      remote: "https://github.com/acme/repo.git",
      mrs: [makeMr({ id: "acme/repo#42" })],
    });
    const view = buildSessionView(makeSession(), ctx, undefined, new Set());
    expect(view.mrId).toBe("#42");
  });

  test("MR id with ':' separator (GitLab) still renders as '!N'", () => {
    const ctx = makeCtx({
      remote: "https://gitlab.com/acme/repo.git",
      mrs: [makeMr({ id: "acme%2Frepo:42" })],
    });
    const view = buildSessionView(makeSession(), ctx, undefined, new Set());
    expect(view.mrId).toBe("!42");
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

  test("formats context tokens as 112k", () => {
    const state = baseState();
    state.contextTokens = 112000;
    expect(buildSessionRow3(state, 26, null).text).toContain("112k");
  });

  test("rounds context tokens to the nearest k", () => {
    const state = baseState();
    state.contextTokens = 8400;
    expect(buildSessionRow3(state, 26, null).text).toContain("8k");
  });

  test("formats a million-plus context as 1.2M", () => {
    const state = baseState();
    state.contextTokens = 1_200_000;
    expect(buildSessionRow3(state, 26, null).text).toContain("1.2M");
  });

  test("non-promoted with no context → empty string", () => {
    expect(buildSessionRow3(baseState(), 26, null).text).toBe("");
    expect(buildSessionRow3(baseState(), 26, null).labelCol).toBe(-1);
  });

  test("never renders a dollar amount or tool name", () => {
    const state = baseState();
    state.contextTokens = 112000;
    const out = buildSessionRow3(state, 26, null).text;
    expect(out).not.toContain("$");
    expect(out).not.toContain("Edit");
    expect(out).not.toContain("idle");
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
  otel.contextTokens = 112000;
  Object.assign(otel, otelOverrides);
  return buildSessionRow3(otel, width, state).text;
}

describe("buildSessionRow3 — promoted session with state label", () => {
  test("wide width (26) — context + state, state on right", () => {
    const text = rowWithState("running", 26);
    expect(text).toContain("112k");
    expect(text.trimEnd().endsWith("RUNNING")).toBe(true);
  });

  test("narrow width — drop context, keep state on right", () => {
    // width 9 < 4 ("112k") + 2 (gap) + 7 ("WAITING") = 13, so the context figure drops.
    const text = rowWithState("waiting", 9);
    expect(text).not.toContain("112k");
    expect(text.trimEnd().endsWith("WAITING")).toBe(true);
  });

  test("zero width — degrades gracefully (state truncated, no throw)", () => {
    expect(() => rowWithState("running", 0)).not.toThrow();
  });

  test("million-range context — context + state both present", () => {
    const text = rowWithState("running", 26, { contextTokens: 1_200_000 });
    expect(text).toContain("1.2M");
    expect(text.trimEnd().endsWith("RUNNING")).toBe(true);
  });

  test("labelCol points at the state label position", () => {
    const otel = makeSessionOtelState();
    otel.contextTokens = 112000;
    const result = buildSessionRow3(otel, 26, "running");
    expect(result.labelCol).toBeGreaterThanOrEqual(0);
    expect(result.text.slice(result.labelCol)).toBe("RUNNING");
  });
});

describe("buildSessionRow3 — non-promoted session", () => {
  test("null state with context → context only, labelCol -1", () => {
    const otel = makeSessionOtelState();
    otel.contextTokens = 38000;
    const result = buildSessionRow3(otel, 26, null);
    expect(result.text).toContain("38k");
    expect(result.labelCol).toBe(-1);
  });

  test("null state with no data → empty string", () => {
    const result = buildSessionRow3(makeSessionOtelState(), 26, null);
    expect(result.text).toBe("");
    expect(result.labelCol).toBe(-1);
  });
});
