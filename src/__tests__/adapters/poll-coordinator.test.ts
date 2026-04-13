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
});
