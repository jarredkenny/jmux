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

  test("every issue carries a stateType, so stage projection works in demo mode", async () => {
    // The seed data has no stateType of its own; the adapter stamps it from its
    // status table. Without it every demo issue projects to "active" — which
    // looks right until something keys off "done", as the sidebar's ghost rows
    // do, and a completed issue then shows as unstarted work that never clears.
    const issues = await adapter.getMyIssues();
    for (const issue of issues) {
      expect(issue.stateType).toBeDefined();
    }
    const done = issues.filter((i) => i.status === "Done");
    expect(done.length).toBeGreaterThan(0);
    for (const issue of done) expect(issue.stateType).toBe("completed");
    expect(issues.find((i) => i.status === "Todo")?.stateType).toBe("unstarted");
    expect(issues.find((i) => i.status === "In Progress")?.stateType).toBe("started");
  });

  test("the status table agrees with the workflow states it also feeds", async () => {
    // One table drives both, so a status classified one way for the picker and
    // another way for an issue would be a contradiction, not a difference.
    const states = await adapter.listWorkflowStates();
    const byName = new Map(states.map((s) => [s.name, s.type]));
    for (const issue of await adapter.getMyIssues()) {
      if (byName.has(issue.status)) expect(issue.stateType).toBe(byName.get(issue.status)!);
    }
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

  test("getAvailableStatuses offers every status an issue can be moved to", async () => {
    const statuses = await adapter.getAvailableStatuses("issue-1234");

    // The statuses demo issues actually sit in must all be offered, or the
    // status picker can't put an issue back where it came from.
    for (const inUse of ["Backlog", "Todo", "In Progress", "In Code Review", "Done"]) {
      expect(statuses).toContain(inUse);
    }

    // And the list is deliberately wider than what's in use. The workflow
    // screen's argument is that a real tracker carries statuses named for other
    // people's processes; a tracker offering only the tidy few has nothing to
    // collapse and makes the feature look like ceremony.
    expect(statuses.length).toBeGreaterThan(12);
    expect(statuses).toContain("Awaiting QA Sign-off");
    expect(statuses).toContain("Pending Release Approval");
  });

  test("every offered status is classified", async () => {
    const statuses = await adapter.getAvailableStatuses("issue-1234");
    const states = await adapter.listWorkflowStates();

    // An unclassified status falls through to "active", which reads as correct
    // until something keys off `done` — the sidebar's ghost rows do, and a
    // completed issue then shows as unstarted work forever.
    expect(states.map((s) => s.name).sort()).toEqual([...statuses].sort());
    expect(states.every((s) => typeof s.type === "string" && s.type.length > 0)).toBe(true);
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
