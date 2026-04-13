import { describe, test, expect, beforeEach } from "bun:test";
import { DemoCodeHostAdapter } from "../../demo/mock-code-host";
import { DEMO_MRS, DEMO_REVIEW_MR_IDS } from "../../demo/seed-data";

describe("DemoCodeHostAdapter", () => {
  let adapter: DemoCodeHostAdapter;

  beforeEach(() => {
    adapter = new DemoCodeHostAdapter();
  });

  test("authState is ok from construction", () => {
    expect(adapter.type).toBe("demo");
    expect(adapter.authState).toBe("ok");
    expect(adapter.authHint).toBe("demo mode — no credentials needed");
  });

  test("getMyMergeRequests returns all MRs", async () => {
    const mrs = await adapter.getMyMergeRequests();
    expect(mrs).toHaveLength(DEMO_MRS.length);
    expect(mrs.map((m) => m.id).sort()).toEqual(DEMO_MRS.map((m) => m.id).sort());
  });

  test("getMergeRequest finds MR by branch", async () => {
    const mr = await adapter.getMergeRequest("git@gitlab.com:acme/platform.git", "feat/eng-1234-auth-refactor");
    expect(mr).not.toBeNull();
    expect(mr!.id).toBe("acme%2Fplatform:101");
    expect(mr!.sourceBranch).toBe("feat/eng-1234-auth-refactor");
  });

  test("getMergeRequest returns null for unknown branch", async () => {
    const mr = await adapter.getMergeRequest("git@gitlab.com:acme/platform.git", "feat/unknown-branch");
    expect(mr).toBeNull();
  });

  test("pollMergeRequest returns MR by id", async () => {
    const mr = await adapter.pollMergeRequest("acme%2Fplatform:101");
    expect(mr.id).toBe("acme%2Fplatform:101");
    expect(mr.title).toBe("Refactor auth middleware");
  });

  test("pollMergeRequest throws for unknown id", async () => {
    await expect(adapter.pollMergeRequest("acme%2Fplatform:9999")).rejects.toThrow();
  });

  test("approve increments approval count", async () => {
    const before = await adapter.pollMergeRequest("acme%2Fplatform:101");
    const beforeCount = before.approvals.current;
    await adapter.approve("acme%2Fplatform:101");
    const after = await adapter.pollMergeRequest("acme%2Fplatform:101");
    expect(after.approvals.current).toBe(beforeCount + 1);
  });

  test("markReady changes draft to open", async () => {
    const draft = await adapter.pollMergeRequest("acme%2Fplatform:103");
    expect(draft.status).toBe("draft");
    await adapter.markReady("acme%2Fplatform:103");
    const after = await adapter.pollMergeRequest("acme%2Fplatform:103");
    expect(after.status).toBe("open");
  });

  test("searchMergeRequests by title is case-insensitive", async () => {
    const results = await adapter.searchMergeRequests("AUTH");
    expect(results.length).toBeGreaterThan(0);
    expect(results.every((m) => m.title.toLowerCase().includes("auth") || m.sourceBranch.toLowerCase().includes("auth"))).toBe(true);
  });

  test("searchMergeRequests by sourceBranch", async () => {
    const results = await adapter.searchMergeRequests("cursor-pagination");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].sourceBranch).toContain("cursor-pagination");
  });

  test("searchMergeRequests returns empty for no match", async () => {
    const results = await adapter.searchMergeRequests("zzz-no-match-xyz");
    expect(results).toEqual([]);
  });

  test("getMrsAwaitingMyReview returns 2 MRs", async () => {
    const mrs = await adapter.getMrsAwaitingMyReview();
    expect(mrs).toHaveLength(DEMO_REVIEW_MR_IDS.size);
    expect(mrs).toHaveLength(2);
    expect(mrs.every((m) => DEMO_REVIEW_MR_IDS.has(m.id))).toBe(true);
  });

  test("pollAllMergeRequests returns map keyed by session name", async () => {
    const remotes = [
      { sessionName: "auth-session", remote: "git@gitlab.com:acme/platform.git", branch: "feat/eng-1234-auth-refactor" },
      { sessionName: "pagination-session", remote: "git@gitlab.com:acme/platform.git", branch: "feat/eng-1241-cursor-pagination" },
    ];
    const map = await adapter.pollAllMergeRequests(remotes);
    expect(map.has("auth-session")).toBe(true);
    expect(map.has("pagination-session")).toBe(true);
    expect(map.get("auth-session")!.id).toBe("acme%2Fplatform:101");
    expect(map.get("pagination-session")!.id).toBe("acme%2Fplatform:102");
  });

  test("pollAllMergeRequests omits sessions with no matching MR", async () => {
    const remotes = [
      { sessionName: "no-mr-session", remote: "git@gitlab.com:acme/platform.git", branch: "feat/no-such-branch" },
    ];
    const map = await adapter.pollAllMergeRequests(remotes);
    expect(map.has("no-mr-session")).toBe(false);
    expect(map.size).toBe(0);
  });

  test("pollMergeRequestsByIds returns map keyed by id", async () => {
    const ids = ["acme%2Fplatform:101", "acme%2Fdashboard:201"];
    const map = await adapter.pollMergeRequestsByIds(ids);
    expect(map.size).toBe(2);
    expect(map.get("acme%2Fplatform:101")!.title).toBe("Refactor auth middleware");
    expect(map.get("acme%2Fdashboard:201")!.title).toBe("Settings page redesign");
  });

  test("pollMergeRequestsByIds skips unknown ids", async () => {
    const ids = ["acme%2Fplatform:101", "acme%2Fplatform:9999"];
    const map = await adapter.pollMergeRequestsByIds(ids);
    expect(map.size).toBe(1);
    expect(map.has("acme%2Fplatform:101")).toBe(true);
  });

  test("parseMrUrl extracts project and id from GitLab URL", () => {
    const result = adapter.parseMrUrl("https://gitlab.com/acme/platform/-/merge_requests/101");
    expect(result).toBe("acme%2Fplatform:101");
  });

  test("parseMrUrl handles nested group paths", () => {
    const result = adapter.parseMrUrl("https://gitlab.com/acme/sub/platform/-/merge_requests/42");
    expect(result).toBe("acme%2Fsub%2Fplatform:42");
  });

  test("parseMrUrl returns null for non-MR URL", () => {
    expect(adapter.parseMrUrl("https://example.com/something")).toBeNull();
    expect(adapter.parseMrUrl("https://gitlab.com/acme/platform")).toBeNull();
    expect(adapter.parseMrUrl("not-a-url")).toBeNull();
  });

  test("query methods return copies not internal references", async () => {
    const mrs = await adapter.getMyMergeRequests();
    const mr = mrs.find((m) => m.id === "acme%2Fplatform:101")!;
    mr.title = "mutated";
    const mrs2 = await adapter.getMyMergeRequests();
    expect(mrs2.find((m) => m.id === "acme%2Fplatform:101")!.title).toBe("Refactor auth middleware");
  });

  test("mutations do not cross instances", async () => {
    const a = new DemoCodeHostAdapter();
    const b = new DemoCodeHostAdapter();
    await a.approve("acme%2Fplatform:101");
    const mrA = await a.pollMergeRequest("acme%2Fplatform:101");
    const mrB = await b.pollMergeRequest("acme%2Fplatform:101");
    expect(mrA.approvals.current).toBe(mrB.approvals.current + 1);
  });
});
