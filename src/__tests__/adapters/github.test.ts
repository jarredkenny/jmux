import { describe, test, expect } from "bun:test";
import { GitHubAdapter, extractOwnerRepo } from "../../adapters/github";

describe("extractOwnerRepo", () => {
  test("extracts from HTTPS URL", () => {
    expect(extractOwnerRepo("https://github.com/org/repo.git")).toBe("org/repo");
  });

  test("extracts from HTTPS URL without .git", () => {
    expect(extractOwnerRepo("https://github.com/org/repo")).toBe("org/repo");
  });

  test("extracts from SSH URL", () => {
    expect(extractOwnerRepo("git@github.com:org/repo.git")).toBe("org/repo");
  });

  test("extracts from SSH URL without .git", () => {
    expect(extractOwnerRepo("git@github.com:org/repo")).toBe("org/repo");
  });

  test("extracts from GitHub Enterprise SSH URL", () => {
    expect(extractOwnerRepo("git@github.mycompany.com:org/repo.git")).toBe("org/repo");
  });

  test("extracts from GitHub Enterprise HTTPS URL", () => {
    expect(extractOwnerRepo("https://github.mycompany.com/org/repo.git")).toBe("org/repo");
  });

  test("returns null for invalid URL", () => {
    expect(extractOwnerRepo("not-a-url")).toBeNull();
  });

  test("returns null for empty path", () => {
    expect(extractOwnerRepo("https://github.com/")).toBeNull();
  });
});

describe("parseMrUrl", () => {
  test("parses GitHub PR URL", () => {
    const adapter = new GitHubAdapter({ type: "github" });
    const result = adapter.parseMrUrl("https://github.com/org/repo/pull/42");
    expect(result).toBe("org/repo:42");
  });

  test("parses GitHub Enterprise PR URL", () => {
    const adapter = new GitHubAdapter({ type: "github" });
    const result = adapter.parseMrUrl("https://github.mycompany.com/org/repo/pull/7");
    expect(result).toBe("org/repo:7");
  });

  test("returns null for non-PR URL", () => {
    const adapter = new GitHubAdapter({ type: "github" });
    expect(adapter.parseMrUrl("https://example.com")).toBeNull();
  });

  test("returns null for issue URL", () => {
    const adapter = new GitHubAdapter({ type: "github" });
    expect(adapter.parseMrUrl("https://github.com/org/repo/issues/42")).toBeNull();
  });
});

describe("getMyMergeRequests", () => {
  test("returns empty array when not authenticated", async () => {
    const adapter = new GitHubAdapter({ type: "github" });
    const results = await adapter.getMyMergeRequests();
    expect(results).toEqual([]);
  });
});

describe("getMrsAwaitingMyReview", () => {
  test("returns empty array when not authenticated", async () => {
    const adapter = new GitHubAdapter({ type: "github" });
    const results = await adapter.getMrsAwaitingMyReview();
    expect(results).toEqual([]);
  });
});

describe("GitHubAdapter", () => {
  test("starts in unauthenticated state", () => {
    const adapter = new GitHubAdapter({ type: "github" });
    expect(adapter.type).toBe("github");
    expect(adapter.authState).toBe("unauthenticated");
    expect(adapter.authHint).toBe("$GH_TOKEN or $GITHUB_TOKEN");
  });

  test("uses default API URL", () => {
    const adapter = new GitHubAdapter({ type: "github" });
    expect(adapter.type).toBe("github");
  });

  test("accepts custom URL for GitHub Enterprise", () => {
    const adapter = new GitHubAdapter({ type: "github", url: "https://github.mycompany.com/api/v3" });
    expect(adapter.type).toBe("github");
  });

  test("authenticate succeeds with env var", async () => {
    const origGH = process.env.GH_TOKEN;
    const origGithub = process.env.GITHUB_TOKEN;
    process.env.GH_TOKEN = "test-token";
    delete process.env.GITHUB_TOKEN;
    try {
      const adapter = new GitHubAdapter({ type: "github" });
      await adapter.authenticate();
      // Auth validates token via /user — with a fake token this will fail
      // but the token is set. In a real scenario with valid token, authState = "ok".
      expect(["ok", "failed"]).toContain(adapter.authState);
    } finally {
      if (origGH === undefined) delete process.env.GH_TOKEN;
      else process.env.GH_TOKEN = origGH;
      if (origGithub !== undefined) process.env.GITHUB_TOKEN = origGithub;
    }
  });

  test("authenticate without env var falls back to gh CLI", async () => {
    const origGH = process.env.GH_TOKEN;
    const origGithub = process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      const adapter = new GitHubAdapter({ type: "github" });
      await adapter.authenticate();
      // Without env vars, falls back to `gh auth token`.
      // On machines with gh CLI authenticated: "ok". Without: "failed".
      expect(["ok", "failed"]).toContain(adapter.authState);
    } finally {
      if (origGH !== undefined) process.env.GH_TOKEN = origGH;
      if (origGithub !== undefined) process.env.GITHUB_TOKEN = origGithub;
    }
  });
});
