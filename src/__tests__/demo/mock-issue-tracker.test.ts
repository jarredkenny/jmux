// src/__tests__/demo/mock-issue-tracker.test.ts
import { describe, test, expect, beforeEach } from "bun:test";
import { DemoIssueTrackerAdapter } from "../../demo/mock-issue-tracker";
import { DEMO_ISSUES, DEMO_TEAMS } from "../../demo/seed-data";

describe("DemoIssueTrackerAdapter", () => {
  let adapter: DemoIssueTrackerAdapter;

  beforeEach(() => {
    adapter = new DemoIssueTrackerAdapter();
  });

  test("authState is ok from construction", () => {
    expect(adapter.authState).toBe("ok");
    expect(adapter.type).toBe("demo");
    expect(adapter.authHint).toBe("demo mode — no credentials needed");
  });

  test("getMyIssues returns all issues", async () => {
    const issues = await adapter.getMyIssues();
    expect(issues).toHaveLength(DEMO_ISSUES.length);
    // should be copies, not same references
    const first = issues[0];
    const again = await adapter.getMyIssues();
    expect(again[0]).not.toBe(first);
    expect(again[0]).toEqual(first);
  });

  test("getIssueByBranch finds issue by branch", async () => {
    const issue = await adapter.getIssueByBranch("feat/eng-1234-auth-refactor");
    expect(issue).not.toBeNull();
    expect(issue!.id).toBe("issue-1234");
    expect(issue!.identifier).toBe("ENG-1234");
  });

  test("getIssueByBranch returns null for unknown branch", async () => {
    const issue = await adapter.getIssueByBranch("nonexistent-branch");
    expect(issue).toBeNull();
  });

  test("pollIssue returns issue by id", async () => {
    const issue = await adapter.pollIssue("issue-1241");
    expect(issue.identifier).toBe("ENG-1241");
    expect(issue.title).toBe("Cursor-based pagination for list endpoints");
  });

  test("pollIssue throws for unknown id", async () => {
    expect(adapter.pollIssue("nope")).rejects.toThrow();
  });

  test("updateStatus mutates in-memory state", async () => {
    await adapter.updateStatus("issue-1234", "Done");
    const issue = await adapter.pollIssue("issue-1234");
    expect(issue.status).toBe("Done");
    // also reflected in branch lookup
    const byBranch = await adapter.getIssueByBranch("feat/eng-1234-auth-refactor");
    expect(byBranch!.status).toBe("Done");
    // and in getMyIssues
    const all = await adapter.getMyIssues();
    const found = all.find((i) => i.id === "issue-1234");
    expect(found!.status).toBe("Done");
  });

  test("getAvailableStatuses returns 5 statuses", async () => {
    const statuses = await adapter.getAvailableStatuses("issue-1234");
    expect(statuses).toHaveLength(5);
    expect(statuses).toContain("Backlog");
    expect(statuses).toContain("Todo");
    expect(statuses).toContain("In Progress");
    expect(statuses).toContain("In Review");
    expect(statuses).toContain("Done");
  });

  test("searchIssues matches by title (case-insensitive)", async () => {
    const results = await adapter.searchIssues("auth");
    expect(results.length).toBeGreaterThan(0);
    for (const r of results) {
      const haystack = (r.title + " " + r.identifier).toLowerCase();
      expect(haystack).toContain("auth");
    }
  });

  test("searchIssues matches by identifier (case-insensitive)", async () => {
    const results = await adapter.searchIssues("eng-1248");
    expect(results).toHaveLength(1);
    expect(results[0].identifier).toBe("ENG-1248");
  });

  test("searchIssues returns empty array for no match", async () => {
    const results = await adapter.searchIssues("zzznomatch");
    expect(results).toHaveLength(0);
  });

  test("getLinkedIssue finds issue by MR URL", async () => {
    // ENG-1234 links to platform MR 101
    const url = "https://gitlab.com/acme/platform/-/merge_requests/101";
    const issue = await adapter.getLinkedIssue(url);
    expect(issue).not.toBeNull();
    expect(issue!.identifier).toBe("ENG-1234");
  });

  test("getLinkedIssue returns null for unlinked URL", async () => {
    const issue = await adapter.getLinkedIssue("https://example.com/mr/9999");
    expect(issue).toBeNull();
  });

  test("pollAllIssues returns map keyed by id", async () => {
    const ids = ["issue-1234", "issue-301", "issue-42"];
    const map = await adapter.pollAllIssues(ids);
    expect(map.size).toBe(3);
    expect(map.get("issue-1234")!.identifier).toBe("ENG-1234");
    expect(map.get("issue-301")!.identifier).toBe("DASH-301");
    expect(map.get("issue-42")!.identifier).toBe("OPS-42");
  });

  test("getTeams returns 3 teams", async () => {
    const teams = await adapter.getTeams();
    expect(teams).toHaveLength(DEMO_TEAMS.length);
    expect(teams).toEqual(DEMO_TEAMS);
  });
});
