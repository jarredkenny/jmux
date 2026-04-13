import { describe, test, expect } from "bun:test";
import type {
  MergeRequest,
  Issue,
  SessionContext,
  BranchContext,
  PipelineStatus,
  CodeHostAdapter,
  IssueTrackerAdapter,
  AdapterConfig,
  AdapterAuthState,
  LinkSource,
} from "../../adapters/types";

describe("adapter types", () => {
  test("MergeRequest shape", () => {
    const mr: MergeRequest = {
      id: "123",
      title: "Fix auth",
      status: "open",
      sourceBranch: "fix/auth",
      targetBranch: "main",
      pipeline: { state: "passed", webUrl: "https://example.com/pipeline/1" },
      approvals: { required: 2, current: 1 },
      webUrl: "https://example.com/mr/123",
    };
    expect(mr.status).toBe("open");
    expect(mr.pipeline!.state).toBe("passed");
  });

  test("MergeRequest with null pipeline", () => {
    const mr: MergeRequest = {
      id: "456",
      title: "WIP",
      status: "draft",
      sourceBranch: "wip",
      targetBranch: "main",
      pipeline: null,
      approvals: { required: 0, current: 0 },
      webUrl: "https://example.com/mr/456",
    };
    expect(mr.pipeline).toBeNull();
  });

  test("Issue shape", () => {
    const issue: Issue = {
      id: "issue-1",
      identifier: "ENG-1234",
      title: "Fix auth token refresh",
      status: "In Progress",
      assignee: "jarred",
      linkedMrUrls: ["https://example.com/mr/123"],
      webUrl: "https://example.com/issue/1",
    };
    expect(issue.identifier).toBe("ENG-1234");
    expect(issue.linkedMrUrls).toHaveLength(1);
  });

  test("SessionContext with multiple MRs and issues", () => {
    const ctx: SessionContext = {
      sessionName: "api",
      dir: "/tmp",
      branch: "main",
      remote: "https://gitlab.com/org/repo.git",
      mrs: [
        {
          id: "1", title: "Fix", status: "open", sourceBranch: "fix", targetBranch: "main",
          pipeline: null, approvals: { required: 0, current: 0 }, webUrl: "", source: "branch",
        },
      ],
      issues: [
        {
          id: "i1", identifier: "ENG-1", title: "Task", status: "In Progress",
          assignee: null, linkedMrUrls: [], webUrl: "", source: "manual",
        },
      ],
      resolvedAt: Date.now(),
    };
    expect(ctx.mrs).toHaveLength(1);
    expect(ctx.issues).toHaveLength(1);
    expect(ctx.mrs[0].source).toBe("branch");
    expect(ctx.issues[0].source).toBe("manual");
  });

  test("SessionContext with empty arrays", () => {
    const ctx: SessionContext = {
      sessionName: "scratch",
      dir: "/tmp",
      branch: null,
      remote: null,
      mrs: [],
      issues: [],
      resolvedAt: Date.now(),
    };
    expect(ctx.mrs).toHaveLength(0);
    expect(ctx.issues).toHaveLength(0);
  });

  test("LinkSource values", () => {
    const sources: import("../../adapters/types").LinkSource[] = ["manual", "branch", "mr-link", "transitive"];
    expect(sources).toHaveLength(4);
  });

  test("BranchContext shape", () => {
    const bc: BranchContext = {
      sessionName: "api-server",
      remote: "https://gitlab.com/org/repo.git",
      branch: "fix/auth",
    };
    expect(bc.sessionName).toBe("api-server");
  });

  test("AdapterConfig shape", () => {
    const cfg: AdapterConfig = {
      codeHost: { type: "gitlab" },
      issueTracker: { type: "linear" },
    };
    expect(cfg.codeHost!.type).toBe("gitlab");
  });

  test("AdapterConfig with no adapters", () => {
    const cfg: AdapterConfig = {};
    expect(cfg.codeHost).toBeUndefined();
    expect(cfg.issueTracker).toBeUndefined();
  });

  test("Issue with extended fields", () => {
    const issue: Issue = {
      id: "1", identifier: "ENG-1234", title: "Fix auth", status: "In Progress",
      assignee: "jarred", linkedMrUrls: [], webUrl: "",
      team: "Platform", project: "Auth Rewrite", priority: 1, updatedAt: Date.now(),
    };
    expect(issue.team).toBe("Platform");
    expect(issue.priority).toBe(1);
  });

  test("MergeRequest with extended fields", () => {
    const mr: MergeRequest = {
      id: "1", title: "Fix", status: "open", sourceBranch: "fix", targetBranch: "main",
      pipeline: null, approvals: { required: 0, current: 0 }, webUrl: "",
      author: "jarred", reviewers: ["alice"], updatedAt: Date.now(),
    };
    expect(mr.author).toBe("jarred");
    expect(mr.reviewers).toEqual(["alice"]);
  });
});
