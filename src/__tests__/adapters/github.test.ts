import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  GitHubAdapter,
  extractOwnerRepo,
  derivePipelineState,
  parseMrId,
} from "../../adapters/github";

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

describe("parseMrId", () => {
  test("parses owner/repo#number", () => {
    expect(parseMrId("org/repo#42")).toEqual({ ownerRepo: "org/repo", number: "42" });
  });

  test("returns null on a GitLab-style ':' id", () => {
    expect(parseMrId("org%2Frepo:42")).toBeNull();
  });

  test("returns null on a non-numeric suffix", () => {
    expect(parseMrId("org/repo#abc")).toBeNull();
  });

  test("returns null on garbage", () => {
    expect(parseMrId("nope")).toBeNull();
  });
});

describe("parseMrUrl", () => {
  test("parses GitHub PR URL to owner/repo#number", () => {
    const adapter = new GitHubAdapter({ type: "github" });
    const result = adapter.parseMrUrl("https://github.com/org/repo/pull/42");
    expect(result).toBe("org/repo#42");
  });

  test("parses GitHub Enterprise PR URL", () => {
    const adapter = new GitHubAdapter({ type: "github" });
    const result = adapter.parseMrUrl("https://github.mycompany.com/org/repo/pull/7");
    expect(result).toBe("org/repo#7");
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

describe("derivePipelineState", () => {
  const cases: Array<[string, GhCheckRunInput[], ReturnType<typeof derivePipelineState>]> = [
    ["empty list -> null", [], null],
    ["all success -> passed", [
      { status: "completed", conclusion: "success" },
      { status: "completed", conclusion: "success" },
    ], "passed"],
    ["one failure -> failed", [
      { status: "completed", conclusion: "success" },
      { status: "completed", conclusion: "failure" },
    ], "failed"],
    ["one timed_out -> failed", [
      { status: "completed", conclusion: "timed_out" },
    ], "failed"],
    ["action_required -> failed", [
      { status: "completed", conclusion: "action_required" },
    ], "failed"],
    ["in_progress -> running", [
      { status: "completed", conclusion: "success" },
      { status: "in_progress", conclusion: null },
    ], "running"],
    ["queued -> running", [{ status: "queued", conclusion: null }], "running"],
    ["cancelled (no failure) -> canceled", [
      { status: "completed", conclusion: "success" },
      { status: "completed", conclusion: "cancelled" },
    ], "canceled"],
    ["neutral/skipped only -> passed", [
      { status: "completed", conclusion: "neutral" },
      { status: "completed", conclusion: "skipped" },
    ], "passed"],
  ];

  for (const [label, runs, expected] of cases) {
    test(label, () => {
      expect(derivePipelineState(runs)).toBe(expected);
    });
  }

  test("failure beats cancelled and in_progress", () => {
    expect(derivePipelineState([
      { status: "in_progress", conclusion: null },
      { status: "completed", conclusion: "cancelled" },
      { status: "completed", conclusion: "failure" },
    ])).toBe("failed");
  });
});

type GhCheckRunInput = { status: string; conclusion: string | null };

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

  test("authenticate succeeds with env var (no network I/O)", async () => {
    const origGH = process.env.GH_TOKEN;
    const origGithub = process.env.GITHUB_TOKEN;
    process.env.GH_TOKEN = "test-token";
    delete process.env.GITHUB_TOKEN;
    // Auth must NOT touch the network now — fail any fetch to prove it.
    const originalFetch = global.fetch;
    global.fetch = ((() => {
      throw new Error("authenticate() must not perform network I/O");
    }) as unknown) as typeof global.fetch;
    try {
      const adapter = new GitHubAdapter({ type: "github" });
      await adapter.authenticate();
      expect(adapter.authState).toBe("ok");
    } finally {
      global.fetch = originalFetch;
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

  test("gh-token fallback ignores stdout when exit code is non-zero", async () => {
    const origGH = process.env.GH_TOKEN;
    const origGithub = process.env.GITHUB_TOKEN;
    delete process.env.GH_TOKEN;
    delete process.env.GITHUB_TOKEN;
    const origSpawnSync = Bun.spawnSync;
    (Bun as any).spawnSync = () => ({
      exitCode: 1,
      // gh prints an error message to stdout/stderr on failure — must be ignored
      stdout: Buffer.from("gh: not logged in"),
      stderr: Buffer.from(""),
    });
    try {
      const adapter = new GitHubAdapter({ type: "github" });
      await adapter.authenticate();
      expect(adapter.authState).toBe("failed");
    } finally {
      (Bun as any).spawnSync = origSpawnSync;
      if (origGH !== undefined) process.env.GH_TOKEN = origGH;
      if (origGithub !== undefined) process.env.GITHUB_TOKEN = origGithub;
    }
  });
});

describe("GitHubAdapter.mapPullRequest id format", () => {
  let originalFetch: typeof global.fetch;
  beforeEach(() => {
    originalFetch = global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("mints id as owner/repo#number and renders pipeline from check-runs", async () => {
    const a = new GitHubAdapter({ type: "github" });
    (a as any).token = "t";
    a.authState = "ok";
    global.fetch = ((url: any) => {
      const u = String(url);
      if (u.endsWith("/repos/acme/repo/pulls/42")) {
        return Promise.resolve(new Response(JSON.stringify({
          number: 42,
          base: { repo: { full_name: "acme/repo" }, ref: "main" },
          head: { ref: "feat/x", sha: "sha-abc" },
          title: "Feat X", state: "open", draft: false, merged_at: null,
          requested_reviewers: [], user: { login: "u" },
          html_url: "https://github.com/acme/repo/pull/42",
        }), { status: 200 }));
      }
      if (u.includes("/commits/sha-abc/check-runs")) {
        return Promise.resolve(new Response(JSON.stringify({
          check_runs: [{ status: "completed", conclusion: "success" }],
        }), { status: 200 }));
      }
      if (u.includes("/reviews")) {
        return Promise.resolve(new Response("[]", { status: 200 }));
      }
      if (u.includes("/protection")) {
        return Promise.resolve(new Response("{}", { status: 404 }));
      }
      return Promise.resolve(new Response("?", { status: 404 }));
    }) as typeof global.fetch;
    const mr = await a.pollMergeRequest("acme/repo#42");
    expect(mr.id).toBe("acme/repo#42");
    expect(mr.pipeline?.state).toBe("passed");
  });
});

describe("GitHubAdapter search hydration", () => {
  let fetchCalls: Array<{ url: string }>;
  let fetchResponder: (url: string) => Promise<Response>;
  const originalFetch = global.fetch;
  beforeEach(() => {
    fetchCalls = [];
    fetchResponder = async () => new Response("{}", { status: 200 });
    global.fetch = ((u: any) => {
      fetchCalls.push({ url: String(u) });
      return fetchResponder(String(u));
    }) as typeof global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  const searchResponse = {
    items: [
      { pull_request: { url: "https://api.github.com/repos/acme/repo/pulls/10" } },
      { pull_request: { url: "https://api.github.com/repos/acme/repo/pulls/11" } },
    ],
  };
  const fakePr = (n: number) => JSON.stringify({
    number: n,
    base: { repo: { full_name: "acme/repo" }, ref: "main" },
    head: { ref: `b-${n}`, sha: `s-${n}` },
    title: `T${n}`, state: "open", draft: false, merged_at: null,
    requested_reviewers: [], user: { login: "u" },
    html_url: `https://github.com/acme/repo/pull/${n}`,
  });

  test("searchMergeRequests hydrates each PR via pull_request.url with branches populated", async () => {
    const a = new GitHubAdapter({ type: "github" });
    (a as any).token = "t"; a.authState = "ok";
    fetchResponder = async (url) => {
      if (url.includes("/search/issues")) return new Response(JSON.stringify(searchResponse), { status: 200 });
      if (url.endsWith("/pulls/10")) return new Response(fakePr(10), { status: 200 });
      if (url.endsWith("/pulls/11")) return new Response(fakePr(11), { status: 200 });
      if (url.includes("/check-runs")) return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
      if (url.includes("/reviews")) return new Response("[]", { status: 200 });
      return new Response("?", { status: 404 });
    };
    const result = await a.searchMergeRequests("auth");
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("acme/repo#10");
    // Branches come from the hydrated PR, not the (field-less) search item.
    expect(result[0].sourceBranch).toBe("b-10");
    expect(result[0].targetBranch).toBe("main");
    expect(fetchCalls[0].url).toContain("is%3Apr");
  });

  test("getMyMergeRequests resolves username lazily then queries author:<username>", async () => {
    const a = new GitHubAdapter({ type: "github" });
    (a as any).token = "t"; a.authState = "ok";
    fetchResponder = async (url) => {
      if (url.endsWith("/user")) return new Response(JSON.stringify({ login: "octo" }), { status: 200 });
      if (url.includes("/search/issues")) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      return new Response("?", { status: 404 });
    };
    await a.getMyMergeRequests();
    expect(fetchCalls.some((c) => c.url.endsWith("/user"))).toBe(true);
    const searchCall = fetchCalls.find((c) => c.url.includes("/search/issues"))!;
    expect(searchCall.url).toContain("author%3Aocto");
  });

  test("getMrsAwaitingMyReview uses user-review-requested (not bare review-requested)", async () => {
    const a = new GitHubAdapter({ type: "github" });
    (a as any).token = "t"; a.authState = "ok";
    fetchResponder = async (url) => {
      if (url.endsWith("/user")) return new Response(JSON.stringify({ login: "octo" }), { status: 200 });
      if (url.includes("/search/issues")) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      return new Response("?", { status: 404 });
    };
    await a.getMrsAwaitingMyReview();
    const searchCall = fetchCalls.find((c) => c.url.includes("/search/issues"))!;
    expect(searchCall.url).toContain("user-review-requested");
    // Guard against regression back to the broader, team-routed qualifier.
    expect(searchCall.url).not.toMatch(/[^-]review-requested/);
  });

  test("returns [] when not authenticated", async () => {
    const a = new GitHubAdapter({ type: "github" });
    expect(await a.getMyMergeRequests()).toEqual([]);
    expect(await a.getMrsAwaitingMyReview()).toEqual([]);
  });
});

describe("GitHubAdapter.fetchApprovals guards empty logins", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("a review with no user.login does not inflate the approver count", async () => {
    const a = new GitHubAdapter({ type: "github" });
    (a as any).token = "t"; a.authState = "ok";
    global.fetch = ((url: any) => {
      const u = String(url);
      if (u.includes("/reviews")) {
        return Promise.resolve(new Response(JSON.stringify([
          { state: "APPROVED", user: { login: "alice" } },
          { state: "APPROVED", user: null },        // ghost review — must be ignored
          { state: "APPROVED", user: { login: "" } }, // empty login — must be ignored
        ]), { status: 200 }));
      }
      if (u.includes("/protection")) {
        // 403 (no admin scope) must be handled cleanly and not flip authState.
        return Promise.resolve(new Response("forbidden", { status: 403 }));
      }
      return Promise.resolve(new Response("?", { status: 404 }));
    }) as typeof global.fetch;
    const approvals = await (a as any).fetchApprovals("acme/repo", 1, "main");
    expect(approvals.current).toBe(1);
    // Branch-protection 403 must not have flipped the adapter to failed.
    expect(a.authState).toBe("ok");
  });
});
