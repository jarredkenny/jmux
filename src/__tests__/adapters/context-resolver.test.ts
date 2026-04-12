import { describe, test, expect, mock } from "bun:test";
import {
  getGitBranch,
  getGitRemotes,
  selectRemote,
  resolveSessionContext,
} from "../../adapters/context-resolver";
import type {
  CodeHostAdapter,
  IssueTrackerAdapter,
  MergeRequest,
  Issue,
  SessionContext,
} from "../../adapters/types";

describe("getGitBranch", () => {
  test("returns null for non-git directory", async () => {
    const branch = await getGitBranch("/tmp");
    expect(branch).toBeNull();
  });
});

describe("selectRemote", () => {
  test("returns origin when no hostname match", () => {
    const remotes = [
      { name: "origin", url: "https://github.com/user/repo.git" },
      { name: "upstream", url: "https://github.com/org/repo.git" },
    ];
    const result = selectRemote(remotes, null);
    expect(result).toEqual({ name: "origin", url: "https://github.com/user/repo.git" });
  });

  test("matches remote by hostname for gitlab", () => {
    const remotes = [
      { name: "origin", url: "https://github.com/user/fork.git" },
      { name: "upstream", url: "https://gitlab.com/org/repo.git" },
    ];
    const result = selectRemote(remotes, "gitlab");
    expect(result).toEqual({ name: "upstream", url: "https://gitlab.com/org/repo.git" });
  });

  test("matches remote by hostname for github", () => {
    const remotes = [
      { name: "origin", url: "https://github.com/user/repo.git" },
      { name: "work", url: "https://gitlab.com/org/repo.git" },
    ];
    const result = selectRemote(remotes, "github");
    expect(result).toEqual({ name: "origin", url: "https://github.com/user/repo.git" });
  });

  test("falls back to origin when hostname doesn't match any remote", () => {
    const remotes = [
      { name: "origin", url: "https://bitbucket.org/user/repo.git" },
      { name: "mirror", url: "https://bitbucket.org/org/repo.git" },
    ];
    const result = selectRemote(remotes, "gitlab");
    expect(result).toEqual({ name: "origin", url: "https://bitbucket.org/user/repo.git" });
  });

  test("returns first remote when no origin exists", () => {
    const remotes = [
      { name: "upstream", url: "https://github.com/org/repo.git" },
    ];
    const result = selectRemote(remotes, null);
    expect(result).toEqual({ name: "upstream", url: "https://github.com/org/repo.git" });
  });

  test("returns null for empty remotes list", () => {
    const result = selectRemote([], null);
    expect(result).toBeNull();
  });
});

describe("resolveSessionContext", () => {
  test("returns empty context for non-git directory", async () => {
    const ctx = await resolveSessionContext({
      sessionName: "scratch",
      dir: "/tmp",
      codeHost: null,
      issueTracker: null,
      manualIssueIds: [],
      manualMrIds: [],
    });
    expect(ctx.branch).toBeNull();
    expect(ctx.remote).toBeNull();
    expect(ctx.mrs).toEqual([]);
    expect(ctx.issues).toEqual([]);
  });
});
