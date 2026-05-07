import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { PollCoordinator, type PollCoordinatorOptions } from "../../adapters/poll-coordinator";
import type {
  CodeHostAdapter,
  IssueTrackerAdapter,
  SessionContext,
  MergeRequest,
  AdapterAuthState,
} from "../../adapters/types";

function makeMockCodeHost(overrides: Partial<CodeHostAdapter> = {}): CodeHostAdapter {
  return {
    type: "gitlab",
    authState: "ok" as AdapterAuthState,
    authHint: "$GITLAB_TOKEN",
    authenticate: mock(() => Promise.resolve()),
    getMergeRequest: mock(() => Promise.resolve(null)),
    pollMergeRequest: mock(() => Promise.resolve({
      id: "1", title: "Test", status: "open" as const,
      sourceBranch: "feat", targetBranch: "main",
      pipeline: { state: "passed" as const, webUrl: "https://example.com/pipeline/1" },
      approvals: { required: 1, current: 0 },
      webUrl: "https://example.com/mr/1",
    })),
    pollAllMergeRequests: mock(() => Promise.resolve(new Map())),
    pollMergeRequestsByIds: mock(() => Promise.resolve(new Map())),
    searchMergeRequests: mock(() => Promise.resolve([])),
    getMyMergeRequests: mock(() => Promise.resolve([])),
    getMrsAwaitingMyReview: mock(() => Promise.resolve([])),
    parseMrUrl: mock(() => null),
    openInBrowser: mock(() => {}),
    markReady: mock(() => Promise.resolve()),
    approve: mock(() => Promise.resolve()),
    ...overrides,
  };
}

describe("PollCoordinator", () => {
  test("starts and stops cleanly", () => {
    const coordinator = new PollCoordinator({
      codeHost: null,
      issueTracker: null,
      onUpdate: () => {},
      getSessionDir: () => "/tmp",
      sessionState: null,
    });
    coordinator.start();
    coordinator.stop();
  });

  test("addSession and removeSession manage session list", () => {
    const coordinator = new PollCoordinator({
      codeHost: null,
      issueTracker: null,
      onUpdate: () => {},
      getSessionDir: () => "/tmp",
      sessionState: null,
    });
    coordinator.addSession("test", "/tmp/test");
    expect(coordinator.getContext("test")).toBeNull();
    coordinator.removeSession("test");
  });

  test("setActiveSession updates active session", () => {
    const coordinator = new PollCoordinator({
      codeHost: null,
      issueTracker: null,
      onUpdate: () => {},
      getSessionDir: () => "/tmp",
      sessionState: null,
    });
    coordinator.addSession("test", "/tmp/test");
    coordinator.setActiveSession("test");
    coordinator.stop();
  });

  test("getAllContexts returns all cached contexts", () => {
    const coordinator = new PollCoordinator({
      codeHost: null,
      issueTracker: null,
      onUpdate: () => {},
      getSessionDir: () => "/tmp",
      sessionState: null,
    });
    const contexts = coordinator.getAllContexts();
    expect(contexts.size).toBe(0);
    coordinator.stop();
  });

  test("handles rate limit state transitions", () => {
    const coordinator = new PollCoordinator({
      codeHost: null,
      issueTracker: null,
      onUpdate: () => {},
      getSessionDir: () => "/tmp",
      sessionState: null,
    });
    expect(coordinator.rateLimitState).toBe("normal");
    coordinator.reportRateLimit("rate_limited");
    expect(coordinator.rateLimitState).toBe("rate_limited");
    coordinator.reportRateLimit("hard_limited");
    expect(coordinator.rateLimitState).toBe("hard_limited");
    coordinator.reportRateLimit("normal");
    expect(coordinator.rateLimitState).toBe("normal");
    coordinator.stop();
  });

  test("handles auth failure", () => {
    const codeHost = makeMockCodeHost();
    const coordinator = new PollCoordinator({
      codeHost,
      issueTracker: null,
      onUpdate: () => {},
      getSessionDir: () => "/tmp",
      sessionState: null,
    });
    coordinator.reportAuthFailure("codeHost");
    expect(codeHost.authState).toBe("failed");
    coordinator.stop();
  });

  test("global polling lifecycle", () => {
    const coordinator = new PollCoordinator({
      codeHost: null, issueTracker: null,
      onUpdate: () => {}, getSessionDir: () => "/tmp", sessionState: null,
    });
    coordinator.start();
    expect(coordinator.getGlobalIssues()).toEqual([]);
    expect(coordinator.getGlobalMrs()).toEqual([]);
    expect(coordinator.getGlobalReviewMrs()).toEqual([]);
    coordinator.stop();
  });

  describe("optimistic link mutators", () => {
    function seededCoordinator(): { coord: PollCoordinator; updates: string[] } {
      const updates: string[] = [];
      const coord = new PollCoordinator({
        codeHost: null, issueTracker: null,
        onUpdate: (name) => { updates.push(name); },
        getSessionDir: () => "/tmp", sessionState: null,
      });
      const ctx: SessionContext = {
        sessionName: "s1", dir: "/tmp/s1", branch: "main", remote: null,
        mrs: [], issues: [], resolvedAt: 0,
      };
      coord.getAllContexts().set("s1", ctx);
      return { coord, updates };
    }

    test("addLinkedIssue inserts into context with manual source and notifies", () => {
      const { coord, updates } = seededCoordinator();
      const issue = {
        id: "i1", identifier: "ENG-1", title: "x", status: "Todo",
        assignee: null, linkedMrUrls: [], webUrl: "",
      };
      coord.addLinkedIssue("s1", issue);
      const ctx = coord.getContext("s1")!;
      expect(ctx.issues).toHaveLength(1);
      expect(ctx.issues[0].id).toBe("i1");
      expect(ctx.issues[0].source).toBe("manual");
      expect(updates).toContain("s1");
      coord.stop();
    });

    test("addLinkedIssue is idempotent for duplicate ids", () => {
      const { coord } = seededCoordinator();
      const issue = {
        id: "i1", identifier: "ENG-1", title: "x", status: "Todo",
        assignee: null, linkedMrUrls: [], webUrl: "",
      };
      coord.addLinkedIssue("s1", issue);
      coord.addLinkedIssue("s1", issue);
      expect(coord.getContext("s1")!.issues).toHaveLength(1);
      coord.stop();
    });

    test("removeLinkedIssue deletes by id and notifies", () => {
      const { coord, updates } = seededCoordinator();
      const issue = {
        id: "i1", identifier: "ENG-1", title: "x", status: "Todo",
        assignee: null, linkedMrUrls: [], webUrl: "",
      };
      coord.addLinkedIssue("s1", issue);
      updates.length = 0;
      coord.removeLinkedIssue("s1", "i1");
      expect(coord.getContext("s1")!.issues).toHaveLength(0);
      expect(updates).toContain("s1");
      coord.stop();
    });

    test("addLinkedMr inserts into context with manual source", () => {
      const { coord, updates } = seededCoordinator();
      const mr: MergeRequest = {
        id: "1", title: "x", status: "open", sourceBranch: "f", targetBranch: "main",
        pipeline: null, approvals: { required: 0, current: 0 }, webUrl: "",
      };
      coord.addLinkedMr("s1", mr);
      const ctx = coord.getContext("s1")!;
      expect(ctx.mrs).toHaveLength(1);
      expect(ctx.mrs[0].source).toBe("manual");
      expect(updates).toContain("s1");
      coord.stop();
    });

    test("removeLinkedMr deletes by id", () => {
      const { coord } = seededCoordinator();
      const mr: MergeRequest = {
        id: "1", title: "x", status: "open", sourceBranch: "f", targetBranch: "main",
        pipeline: null, approvals: { required: 0, current: 0 }, webUrl: "",
      };
      coord.addLinkedMr("s1", mr);
      coord.removeLinkedMr("s1", "1");
      expect(coord.getContext("s1")!.mrs).toHaveLength(0);
      coord.stop();
    });

    test("mutators no-op when context is not yet resolved", () => {
      const updates: string[] = [];
      const coord = new PollCoordinator({
        codeHost: null, issueTracker: null,
        onUpdate: (name) => { updates.push(name); },
        getSessionDir: () => "/tmp", sessionState: null,
      });
      const issue = {
        id: "i1", identifier: "ENG-1", title: "x", status: "Todo",
        assignee: null, linkedMrUrls: [], webUrl: "",
      };
      coord.addLinkedIssue("nonexistent", issue);
      coord.removeLinkedIssue("nonexistent", "i1");
      expect(updates).toEqual([]);
      coord.stop();
    });
  });
});
