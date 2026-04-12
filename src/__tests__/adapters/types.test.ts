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

  test("SessionContext with no MR or issue", () => {
    const ctx: SessionContext = {
      sessionName: "scratch",
      dir: "/tmp",
      branch: null,
      remote: null,
      mr: null,
      issue: null,
      resolvedAt: Date.now(),
    };
    expect(ctx.mr).toBeNull();
    expect(ctx.issue).toBeNull();
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
});
