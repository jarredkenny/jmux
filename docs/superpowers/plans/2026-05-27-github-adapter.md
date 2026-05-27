# GitHub Adapter + Open-MR Hotkey Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `GitHubAdapter` conforming to `CodeHostAdapter` so the existing PollCoordinator + sidebar pipeline glyph work for GitHub repositories, plus a `Ctrl-a o` hotkey to open the focused session's MR in a browser.

**Architecture:** No new subsystems. One new adapter file mirroring `GitLabAdapter` shape (~300 lines). Three existing files touched: registry wires the new adapter, `session-view.ts` makes the MR-ID prefix host-aware, `input-router.ts` + `main.ts` add the soft-prefix `Ctrl-a o` intercept. Spec: `docs/specs/2026-05-20-pr-tracking-design.md`.

**Tech Stack:** TypeScript (strict), Bun 1.3.8+ runtime + test runner, `bun:test` (`describe`/`test`/`expect`/`mock`/`beforeEach`/`afterEach`). Network is `global.fetch` (Bun built-in). No external dependencies.

---

## File Structure

**New:**
- `src/adapters/github.ts` — `GitHubAdapter` class + exported pure helpers (`extractOwnerRepo`, `parseGithubMrUrl`, `deriveWebOrigin`, `derivePipelineState`, `buildPrWebUrl`).
- `src/__tests__/adapters/github.test.ts` — unit tests for adapter and helpers.

**Modified:**
- `src/adapters/registry.ts` — add `case "github"` to the codeHost switch.
- `src/__tests__/adapters/registry.test.ts` — add test for github branch.
- `src/session-view.ts` — replace hard-coded `!` prefix with host-aware `formatMrId`.
- `src/__tests__/session-view.test.ts` — add tests for the two prefix shapes.
- `src/input-router.ts` — add `Ctrl-a o` soft-prefix intercept and `onOpenSessionMr` callback to `InputRouterOptions`.
- `src/__tests__/input-router.test.ts` — add Ctrl-a o test.
- `src/main.ts` — wire `onOpenSessionMr` to a function that calls `openInBrowser` on the focused session's MR; update help-screen keybind list.
- `docs/getting-started.md` — keybind reference: add `Ctrl-a o`.
- `docs/configuration.md` — adapter config: add `github` example.

Each file has one responsibility. The pure helpers in `github.ts` are exported so tests can hit them directly without instantiating the adapter or mocking network — matching the pattern in `gitlab.ts` (`extractProjectPath` is exported).

---

## Conventions

**Test runner.** Bun's `bun:test`. Run a single file: `bun test src/__tests__/adapters/github.test.ts`. Run a single test: `bun test src/__tests__/adapters/github.test.ts -t "test name"`. Full suite: `bun test`. Type check: `bun run typecheck`.

**Fetch mocking pattern.** Tests that exercise network paths replace `global.fetch` in `beforeEach` and restore in `afterEach`. They assert against a recorded call log to verify URLs, methods, and the rate-budget constraint. Pattern used in every network test in this plan:

```ts
let fetchCalls: Array<{ url: string; init?: RequestInit }>;
let fetchResponder: (url: string, init?: RequestInit) => Promise<Response>;
const originalFetch = global.fetch;
beforeEach(() => {
  fetchCalls = [];
  fetchResponder = async () => new Response("{}", { status: 200 });
  global.fetch = ((url: any, init?: any) => {
    fetchCalls.push({ url: String(url), init });
    return fetchResponder(String(url), init);
  }) as typeof global.fetch;
});
afterEach(() => { global.fetch = originalFetch; });
```

**Commit cadence.** One commit per task, conventional-commit style. The repo uses footers like `Co-Authored-By: <person>`; the user has a global rule "Never commit or signoff as Claude" so do **not** add Claude co-author footers. No `--no-verify`.

**File header for `github.ts`.** Every task that adds code to this file extends the same file; the first task creates it with imports and the class skeleton. Subsequent tasks add methods inside the class body.

---

## Task 1: Pure helper — `deriveWebOrigin`

**Files:**
- Create: `src/adapters/github.ts`
- Create: `src/__tests__/adapters/github.test.ts`

- [ ] **Step 1: Write the failing test**

Create `src/__tests__/adapters/github.test.ts` with:

```ts
import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { deriveWebOrigin } from "../../adapters/github";

describe("deriveWebOrigin", () => {
  test("api.github.com -> github.com", () => {
    expect(deriveWebOrigin("https://api.github.com")).toBe("https://github.com");
  });

  test("enterprise host with /api/v3 path -> host origin", () => {
    expect(deriveWebOrigin("https://gh.acme.corp/api/v3")).toBe("https://gh.acme.corp");
  });

  test("trailing slash on /api/v3 -> still host origin", () => {
    expect(deriveWebOrigin("https://gh.acme.corp/api/v3/")).toBe("https://gh.acme.corp");
  });

  test("non-matching URL -> origin of input", () => {
    expect(deriveWebOrigin("https://weird.example.com/x/y")).toBe("https://weird.example.com");
  });

  test("malformed input -> empty string", () => {
    expect(deriveWebOrigin("not-a-url")).toBe("");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/adapters/github.test.ts`
Expected: FAIL — `Cannot find module '../../adapters/github'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/adapters/github.ts`:

```ts
/**
 * Derive the web origin (e.g. https://github.com) from a GitHub REST API URL
 * (e.g. https://api.github.com or https://gh.acme.corp/api/v3). Pure helper —
 * the only place that maps API host → web host. An explicit `webUrl` config
 * field on GitHubAdapter overrides this derivation.
 */
export function deriveWebOrigin(apiUrl: string): string {
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    return "";
  }
  if (url.hostname === "api.github.com") return "https://github.com";
  return `${url.protocol}//${url.host}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/adapters/github.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Type check**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/github.ts src/__tests__/adapters/github.test.ts
git commit -m "feat(github-adapter): add deriveWebOrigin pure helper"
```

---

## Task 2: Pure helper — `extractOwnerRepo`

**Files:**
- Modify: `src/adapters/github.ts`
- Modify: `src/__tests__/adapters/github.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `src/__tests__/adapters/github.test.ts`:

```ts
import { extractOwnerRepo } from "../../adapters/github";

describe("extractOwnerRepo", () => {
  test("https URL with .git suffix", () => {
    expect(extractOwnerRepo("https://github.com/acme/repo.git")).toEqual({ owner: "acme", repo: "repo" });
  });
  test("https URL without .git suffix", () => {
    expect(extractOwnerRepo("https://github.com/acme/repo")).toEqual({ owner: "acme", repo: "repo" });
  });
  test("ssh URL", () => {
    expect(extractOwnerRepo("git@github.com:acme/repo.git")).toEqual({ owner: "acme", repo: "repo" });
  });
  test("enterprise host https URL", () => {
    expect(extractOwnerRepo("https://gh.acme.corp/team/svc.git")).toEqual({ owner: "team", repo: "svc" });
  });
  test("malformed URL -> null", () => {
    expect(extractOwnerRepo("not-a-url")).toBeNull();
  });
  test("URL without repo path -> null", () => {
    expect(extractOwnerRepo("https://github.com/acme")).toBeNull();
  });
});
```

Merge the new `import` into the existing one at the top:

```ts
import { deriveWebOrigin, extractOwnerRepo } from "../../adapters/github";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/adapters/github.test.ts`
Expected: FAIL — `extractOwnerRepo` not exported.

- [ ] **Step 3: Add the implementation**

In `src/adapters/github.ts` (append):

```ts
export interface OwnerRepo {
  owner: string;
  repo: string;
}

/**
 * Parse a git remote URL into {owner, repo}. Handles both https
 * (https://host/owner/repo[.git]) and ssh (git@host:owner/repo[.git])
 * shapes. Returns null when the URL has no owner/repo segment.
 */
export function extractOwnerRepo(remoteUrl: string): OwnerRepo | null {
  const sshMatch = remoteUrl.match(/^git@[^:]+:([^/]+)\/([^/]+?)(?:\.git)?$/);
  if (sshMatch) return { owner: sshMatch[1], repo: sshMatch[2] };
  try {
    const url = new URL(remoteUrl);
    const parts = url.pathname.replace(/^\//, "").replace(/\.git$/, "").split("/");
    if (parts.length < 2 || !parts[0] || !parts[1]) return null;
    return { owner: parts[0], repo: parts[1] };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/adapters/github.test.ts`
Expected: PASS (11 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/github.ts src/__tests__/adapters/github.test.ts
git commit -m "feat(github-adapter): add extractOwnerRepo pure helper"
```

---

## Task 3: Pure helper — `parseGithubMrUrl`

**Files:**
- Modify: `src/adapters/github.ts`
- Modify: `src/__tests__/adapters/github.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `src/__tests__/adapters/github.test.ts`:

```ts
import { parseGithubMrUrl } from "../../adapters/github";

describe("parseGithubMrUrl", () => {
  test("github.com PR URL", () => {
    expect(parseGithubMrUrl("https://github.com/acme/repo/pull/42")).toBe("acme/repo#42");
  });
  test("enterprise host PR URL", () => {
    expect(parseGithubMrUrl("https://gh.acme.corp/team/svc/pull/7")).toBe("team/svc#7");
  });
  test("URL with trailing path -> still matches", () => {
    expect(parseGithubMrUrl("https://github.com/acme/repo/pull/42/files")).toBe("acme/repo#42");
  });
  test("issue URL -> null", () => {
    expect(parseGithubMrUrl("https://github.com/acme/repo/issues/3")).toBeNull();
  });
  test("non-github URL still matches /pull/N shape", () => {
    // The regex is path-shape based, mirroring GitLab adapter's host-agnostic
    // parseMrUrl. Enterprise/self-hosted GitHub instances all follow this shape.
    expect(parseGithubMrUrl("https://example.com/x/y/pull/1")).toBe("x/y#1");
  });
  test("garbage -> null", () => {
    expect(parseGithubMrUrl("nope")).toBeNull();
  });
});
```

Merge import:

```ts
import { deriveWebOrigin, extractOwnerRepo, parseGithubMrUrl } from "../../adapters/github";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/adapters/github.test.ts`
Expected: FAIL — `parseGithubMrUrl` not exported.

- [ ] **Step 3: Add the implementation**

Append to `src/adapters/github.ts`:

```ts
/**
 * Parse a GitHub PR URL into an MR id of shape "owner/repo#number".
 * Path-shape based so it matches github.com, GitHub Enterprise, and any
 * GitHub-style self-hosted host. Returns null for issue URLs or junk.
 */
export function parseGithubMrUrl(url: string): string | null {
  const match = url.match(/\/\/[^/]+\/([^/]+)\/([^/]+)\/pull\/(\d+)/);
  if (!match) return null;
  return `${match[1]}/${match[2]}#${match[3]}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/adapters/github.test.ts`
Expected: PASS (17 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/github.ts src/__tests__/adapters/github.test.ts
git commit -m "feat(github-adapter): add parseGithubMrUrl pure helper"
```

---

## Task 4: Pure helper — `derivePipelineState`

**Files:**
- Modify: `src/adapters/github.ts`
- Modify: `src/__tests__/adapters/github.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `src/__tests__/adapters/github.test.ts`:

```ts
import { derivePipelineState } from "../../adapters/github";

describe("derivePipelineState", () => {
  test("empty list -> null (no pipeline)", () => {
    expect(derivePipelineState([])).toBeNull();
  });
  test("any failure wins", () => {
    expect(derivePipelineState([
      { status: "completed", conclusion: "success" },
      { status: "completed", conclusion: "failure" },
    ])).toBe("failed");
  });
  test("timed_out -> failed", () => {
    expect(derivePipelineState([
      { status: "completed", conclusion: "timed_out" },
    ])).toBe("failed");
  });
  test("action_required -> failed", () => {
    expect(derivePipelineState([
      { status: "completed", conclusion: "action_required" },
    ])).toBe("failed");
  });
  test("cancelled with no failure -> canceled", () => {
    expect(derivePipelineState([
      { status: "completed", conclusion: "success" },
      { status: "completed", conclusion: "cancelled" },
    ])).toBe("canceled");
  });
  test("any in-progress -> running", () => {
    expect(derivePipelineState([
      { status: "completed", conclusion: "success" },
      { status: "in_progress", conclusion: null },
    ])).toBe("running");
  });
  test("queued/waiting/pending -> running", () => {
    expect(derivePipelineState([{ status: "queued", conclusion: null }])).toBe("running");
    expect(derivePipelineState([{ status: "waiting", conclusion: null }])).toBe("running");
    expect(derivePipelineState([{ status: "pending", conclusion: null }])).toBe("running");
  });
  test("all success/neutral/skipped -> passed", () => {
    expect(derivePipelineState([
      { status: "completed", conclusion: "success" },
      { status: "completed", conclusion: "neutral" },
      { status: "completed", conclusion: "skipped" },
    ])).toBe("passed");
  });
});
```

Merge import:

```ts
import {
  deriveWebOrigin,
  extractOwnerRepo,
  parseGithubMrUrl,
  derivePipelineState,
} from "../../adapters/github";
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/adapters/github.test.ts`
Expected: FAIL — `derivePipelineState` not exported.

- [ ] **Step 3: Add the implementation**

Append to `src/adapters/github.ts`:

```ts
import type { PipelineStatus } from "./types";

export interface GhCheckRun {
  status: string;       // queued | in_progress | completed | waiting | pending
  conclusion: string | null;  // success | failure | neutral | cancelled | timed_out | action_required | skipped | null
}

/**
 * Reduce a set of GitHub check-runs into a single PipelineStatus.state.
 * Precedence: any failure wins; cancelled (without failure) wins next;
 * any non-completed status -> running; all-success-with-neutral/skipped -> passed.
 * Empty list -> null (callers map to "no pipeline glyph").
 */
export function derivePipelineState(
  checkRuns: ReadonlyArray<GhCheckRun>,
): PipelineStatus["state"] | null {
  if (checkRuns.length === 0) return null;
  const FAIL_CONCLUSIONS = new Set(["failure", "timed_out", "action_required"]);
  const IN_PROGRESS_STATUSES = new Set(["queued", "in_progress", "waiting", "pending"]);
  let sawCancelled = false;
  let sawInProgress = false;
  for (const run of checkRuns) {
    if (run.conclusion && FAIL_CONCLUSIONS.has(run.conclusion)) return "failed";
    if (run.conclusion === "cancelled") sawCancelled = true;
    if (IN_PROGRESS_STATUSES.has(run.status)) sawInProgress = true;
  }
  if (sawCancelled) return "canceled";
  if (sawInProgress) return "running";
  return "passed";
}
```

(The `import type { PipelineStatus }` line goes at the top of the file. If the file already has imports, add it alongside them.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/adapters/github.test.ts`
Expected: PASS (26 tests total).

- [ ] **Step 5: Type check**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/github.ts src/__tests__/adapters/github.test.ts
git commit -m "feat(github-adapter): add derivePipelineState pure helper"
```

---

## Task 5: Pure helper — `buildPrWebUrl`

**Files:**
- Modify: `src/adapters/github.ts`
- Modify: `src/__tests__/adapters/github.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `src/__tests__/adapters/github.test.ts`:

```ts
import { buildPrWebUrl } from "../../adapters/github";

describe("buildPrWebUrl", () => {
  test("github.com origin", () => {
    expect(buildPrWebUrl("https://github.com", "acme/repo#42")).toBe(
      "https://github.com/acme/repo/pull/42",
    );
  });
  test("enterprise origin", () => {
    expect(buildPrWebUrl("https://gh.acme.corp", "team/svc#7")).toBe(
      "https://gh.acme.corp/team/svc/pull/7",
    );
  });
  test("malformed id -> empty string", () => {
    expect(buildPrWebUrl("https://github.com", "garbage")).toBe("");
  });
});
```

Merge import.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/adapters/github.test.ts`
Expected: FAIL — `buildPrWebUrl` not exported.

- [ ] **Step 3: Add the implementation**

Append to `src/adapters/github.ts`:

```ts
/**
 * Build the PR's web URL from the web origin + mrId. mrId shape is
 * "owner/repo#number" (see parseGithubMrUrl). Returns "" on malformed id.
 */
export function buildPrWebUrl(webOrigin: string, mrId: string): string {
  const match = mrId.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (!match) return "";
  return `${webOrigin}/${match[1]}/${match[2]}/pull/${match[3]}`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/adapters/github.test.ts`
Expected: PASS (29 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/github.ts src/__tests__/adapters/github.test.ts
git commit -m "feat(github-adapter): add buildPrWebUrl pure helper"
```

---

## Task 6: `GitHubAdapter` skeleton + `authenticate`

**Files:**
- Modify: `src/adapters/github.ts`
- Modify: `src/__tests__/adapters/github.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `src/__tests__/adapters/github.test.ts`:

```ts
import { GitHubAdapter } from "../../adapters/github";

describe("GitHubAdapter basics", () => {
  test("starts in unauthenticated state with expected metadata", () => {
    const a = new GitHubAdapter({ type: "github" });
    expect(a.type).toBe("github");
    expect(a.authState).toBe("unauthenticated");
    expect(a.authHint).toBe("$GITHUB_TOKEN or gh auth login");
  });

  test("authenticate succeeds with $GITHUB_TOKEN env", async () => {
    const orig = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "test-token";
    try {
      const a = new GitHubAdapter({ type: "github" });
      await a.authenticate();
      expect(a.authState).toBe("ok");
    } finally {
      if (orig === undefined) delete process.env.GITHUB_TOKEN;
      else process.env.GITHUB_TOKEN = orig;
    }
  });

  test("authenticate fails when env missing and no gh CLI token", async () => {
    const orig = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      const a = new GitHubAdapter({ type: "github" });
      // Inject a stub gh-token reader that returns null
      (a as any).readGhToken = async () => null;
      await a.authenticate();
      expect(a.authState).toBe("failed");
    } finally {
      if (orig !== undefined) process.env.GITHUB_TOKEN = orig;
    }
  });

  test("authenticate uses gh-token fallback", async () => {
    const orig = process.env.GITHUB_TOKEN;
    delete process.env.GITHUB_TOKEN;
    try {
      const a = new GitHubAdapter({ type: "github" });
      (a as any).readGhToken = async () => "gh-cli-token";
      await a.authenticate();
      expect(a.authState).toBe("ok");
    } finally {
      if (orig !== undefined) process.env.GITHUB_TOKEN = orig;
    }
  });
});
```

Merge import.

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/adapters/github.test.ts`
Expected: FAIL — `GitHubAdapter` not exported.

- [ ] **Step 3: Add the implementation**

Append to `src/adapters/github.ts`:

```ts
import {
  HttpError,
  type CodeHostAdapter,
  type AdapterAuthState,
  type MergeRequest,
  type BranchContext,
} from "./types";

const GITHUB_API = "https://api.github.com";

export class GitHubAdapter implements CodeHostAdapter {
  type = "github";
  authState: AdapterAuthState = "unauthenticated";
  authHint = "$GITHUB_TOKEN or gh auth login";

  protected token: string | null = null;
  protected baseUrl: string;
  protected webOrigin: string;

  constructor(config: Record<string, unknown>) {
    this.baseUrl = (config.url as string | undefined) ?? GITHUB_API;
    const explicitWeb = config.webUrl as string | undefined;
    this.webOrigin = explicitWeb ?? deriveWebOrigin(this.baseUrl);
  }

  async authenticate(): Promise<void> {
    const envToken = process.env.GITHUB_TOKEN ?? null;
    if (envToken) {
      this.token = envToken;
      this.authState = "ok";
      return;
    }
    const ghToken = await this.readGhToken();
    if (ghToken) {
      this.token = ghToken;
      this.authState = "ok";
      return;
    }
    this.authState = "failed";
  }

  // Extracted as a method so tests can stub it without spawning `gh`.
  protected async readGhToken(): Promise<string | null> {
    try {
      const proc = Bun.spawnSync(["gh", "auth", "token"], {
        stdout: "pipe",
        stderr: "pipe",
      });
      if (proc.exitCode !== 0) return null;
      const out = proc.stdout.toString().trim();
      return out || null;
    } catch {
      return null;
    }
  }

  // --- Remaining CodeHostAdapter methods will be added in subsequent tasks ---
  async getMergeRequest(_remote: string, _branch: string): Promise<MergeRequest | null> {
    throw new Error("not implemented");
  }
  async pollMergeRequest(_mrId: string): Promise<MergeRequest> {
    throw new Error("not implemented");
  }
  async pollAllMergeRequests(_remotes: BranchContext[]): Promise<Map<string, MergeRequest>> {
    throw new Error("not implemented");
  }
  openInBrowser(_mrId: string): void {
    throw new Error("not implemented");
  }
  async markReady(_mrId: string): Promise<void> {
    throw new Error("not implemented");
  }
  async approve(_mrId: string): Promise<void> {
    throw new Error("not implemented");
  }
  async searchMergeRequests(_query: string): Promise<MergeRequest[]> {
    throw new Error("not implemented");
  }
  parseMrUrl(url: string): string | null {
    return parseGithubMrUrl(url);
  }
  async pollMergeRequestsByIds(_ids: string[]): Promise<Map<string, MergeRequest>> {
    throw new Error("not implemented");
  }
  async getMyMergeRequests(): Promise<MergeRequest[]> {
    throw new Error("not implemented");
  }
  async getMrsAwaitingMyReview(): Promise<MergeRequest[]> {
    throw new Error("not implemented");
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/adapters/github.test.ts`
Expected: PASS (33 tests total).

- [ ] **Step 5: Type check**

Run: `bun run typecheck`
Expected: no errors. (If the not-implemented stubs trip strict-mode unused-arg warnings, the `_` prefix on the names already suppresses them — but if not, change `_mrId` to `mrId` and add a `void mrId;` line as needed. Don't widen the interface.)

- [ ] **Step 6: Commit**

```bash
git add src/adapters/github.ts src/__tests__/adapters/github.test.ts
git commit -m "feat(github-adapter): add class skeleton + authenticate"
```

---

## Task 7: `mapPullRequest` private helper (PR JSON → `MergeRequest`)

**Files:**
- Modify: `src/adapters/github.ts`
- Modify: `src/__tests__/adapters/github.test.ts`

The mapper is the contact surface between the GitHub schema and jmux's
`MergeRequest`. We expose it as a private method but call it from a
public `_mapForTest` wrapper to keep tests honest without altering
production surface.

- [ ] **Step 1: Add failing tests**

Append to `src/__tests__/adapters/github.test.ts`:

```ts
describe("GitHubAdapter.mapPullRequest", () => {
  test("maps a full open PR with no pipeline", () => {
    const a = new GitHubAdapter({ type: "github" });
    const raw = {
      number: 42,
      base: { repo: { full_name: "acme/repo" }, ref: "main" },
      head: { ref: "feat/x", sha: "abc123" },
      title: "Feat X",
      state: "open",
      draft: false,
      merged_at: null,
      requested_reviewers: [{ login: "alice" }, { login: "bob" }],
      user: { login: "carol" },
      created_at: "2026-05-01T12:00:00Z",
      updated_at: "2026-05-02T08:30:00Z",
      html_url: "https://github.com/acme/repo/pull/42",
    };
    const mr = (a as any).mapPullRequest(raw, null);
    expect(mr.id).toBe("acme/repo#42");
    expect(mr.title).toBe("Feat X");
    expect(mr.status).toBe("open");
    expect(mr.sourceBranch).toBe("feat/x");
    expect(mr.targetBranch).toBe("main");
    expect(mr.pipeline).toBeNull();
    expect(mr.approvals).toEqual({ required: 0, current: 0 });
    expect(mr.author).toBe("carol");
    expect(mr.reviewers).toEqual(["alice", "bob"]);
    expect(mr.webUrl).toBe("https://github.com/acme/repo/pull/42");
    expect(mr.createdAt).toBe(Date.parse("2026-05-01T12:00:00Z"));
    expect(mr.updatedAt).toBe(Date.parse("2026-05-02T08:30:00Z"));
  });

  test("draft PR -> status draft", () => {
    const a = new GitHubAdapter({ type: "github" });
    const raw = baseRaw({ draft: true, state: "open" });
    expect((a as any).mapPullRequest(raw, null).status).toBe("draft");
  });

  test("merged PR -> status merged", () => {
    const a = new GitHubAdapter({ type: "github" });
    const raw = baseRaw({ state: "closed", merged_at: "2026-05-02T00:00:00Z" });
    expect((a as any).mapPullRequest(raw, null).status).toBe("merged");
  });

  test("closed (unmerged) PR -> status closed", () => {
    const a = new GitHubAdapter({ type: "github" });
    const raw = baseRaw({ state: "closed", merged_at: null });
    expect((a as any).mapPullRequest(raw, null).status).toBe("closed");
  });

  test("pipeline param is set through to MergeRequest.pipeline", () => {
    const a = new GitHubAdapter({ type: "github" });
    const raw = baseRaw({});
    const mr = (a as any).mapPullRequest(raw, {
      state: "passed",
      webUrl: "https://github.com/acme/repo/pull/42/checks",
    });
    expect(mr.pipeline).toEqual({
      state: "passed",
      webUrl: "https://github.com/acme/repo/pull/42/checks",
    });
  });
});

function baseRaw(overrides: Record<string, unknown>) {
  return {
    number: 42,
    base: { repo: { full_name: "acme/repo" }, ref: "main" },
    head: { ref: "feat/x", sha: "abc123" },
    title: "T",
    state: "open",
    draft: false,
    merged_at: null,
    requested_reviewers: [],
    user: { login: "u" },
    html_url: "https://github.com/acme/repo/pull/42",
    ...overrides,
  };
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/adapters/github.test.ts`
Expected: FAIL — `mapPullRequest is not a function`.

- [ ] **Step 3: Add the implementation**

Add to `GitHubAdapter` class body in `src/adapters/github.ts`:

```ts
  protected mapPullRequest(raw: any, pipeline: PipelineStatus | null): MergeRequest {
    const fullName: string = raw.base?.repo?.full_name ?? "";
    const number: number = raw.number ?? 0;
    const id = `${fullName}#${number}`;
    const status: MergeRequest["status"] = raw.draft
      ? "draft"
      : raw.state === "closed"
        ? (raw.merged_at ? "merged" : "closed")
        : "open";
    const reviewers = Array.isArray(raw.requested_reviewers)
      ? raw.requested_reviewers.map((r: any) => r.login).filter((l: unknown): l is string => typeof l === "string")
      : undefined;
    return {
      id,
      title: raw.title ?? "",
      status,
      sourceBranch: raw.head?.ref ?? "",
      targetBranch: raw.base?.ref ?? "",
      pipeline,
      // GitHub doesn't expose a "required reviewers" count via the PR object;
      // map to zero by default. The Approvals model in jmux is GitLab-shaped;
      // GitHub's review workflow has a follow-up surface (reviews API) that we
      // don't query in v1. See spec out-of-scope #4.
      approvals: { required: 0, current: 0 },
      webUrl: raw.html_url ?? "",
      author: raw.user?.login ?? undefined,
      reviewers,
      createdAt: raw.created_at ? Date.parse(raw.created_at) : undefined,
      updatedAt: raw.updated_at ? Date.parse(raw.updated_at) : undefined,
    };
  }
```

You'll need `PipelineStatus` in the type import:

```ts
import {
  HttpError,
  type CodeHostAdapter,
  type AdapterAuthState,
  type MergeRequest,
  type BranchContext,
  type PipelineStatus,
} from "./types";
```

(Remove the duplicate `import type { PipelineStatus }` from Task 4 if it was added separately — consolidate into one.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/adapters/github.test.ts`
Expected: PASS (38 tests total).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/github.ts src/__tests__/adapters/github.test.ts
git commit -m "feat(github-adapter): map PR JSON to MergeRequest"
```

---

## Task 8: `openInBrowser` + `fetch` helper + error mapping

**Files:**
- Modify: `src/adapters/github.ts`
- Modify: `src/__tests__/adapters/github.test.ts`

- [ ] **Step 1: Add failing tests**

Append:

```ts
import { mock } from "bun:test";

describe("GitHubAdapter.openInBrowser", () => {
  test("spawns `open` with web URL composed from webOrigin + mrId", () => {
    const spawned: Array<{ argv: string[] }> = [];
    const origSpawn = Bun.spawn;
    (Bun as any).spawn = (argv: string[], _opts?: unknown) => {
      spawned.push({ argv });
      return { exited: Promise.resolve(0) } as any;
    };
    try {
      const a = new GitHubAdapter({ type: "github" });
      a.openInBrowser("acme/repo#42");
      expect(spawned).toHaveLength(1);
      expect(spawned[0].argv).toEqual(["open", "https://github.com/acme/repo/pull/42"]);
    } finally {
      (Bun as any).spawn = origSpawn;
    }
  });

  test("uses explicit webUrl override when configured", () => {
    const spawned: Array<{ argv: string[] }> = [];
    const origSpawn = Bun.spawn;
    (Bun as any).spawn = (argv: string[]) => {
      spawned.push({ argv });
      return { exited: Promise.resolve(0) } as any;
    };
    try {
      const a = new GitHubAdapter({
        type: "github",
        url: "https://gh.acme.corp/api/v3",
        webUrl: "https://gh.acme.corp",
      });
      a.openInBrowser("team/svc#7");
      expect(spawned[0].argv).toEqual(["open", "https://gh.acme.corp/team/svc/pull/7"]);
    } finally {
      (Bun as any).spawn = origSpawn;
    }
  });

  test("no-op on malformed id (does not spawn)", () => {
    const spawned: Array<{ argv: string[] }> = [];
    const origSpawn = Bun.spawn;
    (Bun as any).spawn = (argv: string[]) => {
      spawned.push({ argv });
      return { exited: Promise.resolve(0) } as any;
    };
    try {
      const a = new GitHubAdapter({ type: "github" });
      a.openInBrowser("garbage");
      expect(spawned).toHaveLength(0);
    } finally {
      (Bun as any).spawn = origSpawn;
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/adapters/github.test.ts`
Expected: FAIL — `openInBrowser` throws "not implemented".

- [ ] **Step 3: Add the implementation**

Replace the placeholder `openInBrowser` in `GitHubAdapter` with:

```ts
  openInBrowser(mrId: string): void {
    const url = buildPrWebUrl(this.webOrigin, mrId);
    if (!url) return;
    Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
  }
```

Also add a private `fetch` helper and `handleErrorStatus` (used by every network method in later tasks):

```ts
  protected async fetch(url: string, init?: RequestInit): Promise<Response> {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "jmux",
    };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    return fetch(url, {
      ...init,
      headers: { ...headers, ...((init?.headers as Record<string, string> | undefined) ?? {}) },
    });
  }

  protected handleErrorStatus(status: number): void {
    if (status === 401 || status === 403) this.authState = "failed";
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/adapters/github.test.ts`
Expected: PASS (41 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/github.ts src/__tests__/adapters/github.test.ts
git commit -m "feat(github-adapter): openInBrowser + fetch helper + auth-error mapping"
```

---

## Task 9: `pollMergeRequest` (single-PR refresh with pipeline)

**Files:**
- Modify: `src/adapters/github.ts`
- Modify: `src/__tests__/adapters/github.test.ts`

- [ ] **Step 1: Add failing tests**

Append (the fetch-mock pattern goes at the top of a new `describe`):

```ts
describe("GitHubAdapter.pollMergeRequest", () => {
  let fetchCalls: Array<{ url: string; init?: RequestInit }>;
  let fetchResponder: (url: string, init?: RequestInit) => Promise<Response>;
  const originalFetch = global.fetch;

  beforeEach(() => {
    fetchCalls = [];
    fetchResponder = async () => new Response("{}", { status: 200 });
    global.fetch = ((url: any, init?: any) => {
      fetchCalls.push({ url: String(url), init });
      return fetchResponder(String(url), init);
    }) as typeof global.fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });

  test("issues 1 PR fetch + 1 check-runs fetch, populates pipeline", async () => {
    const a = new GitHubAdapter({ type: "github" });
    (a as any).token = "t"; a.authState = "ok";

    fetchResponder = async (url) => {
      if (url.endsWith("/repos/acme/repo/pulls/42")) {
        return new Response(JSON.stringify({
          number: 42,
          base: { repo: { full_name: "acme/repo" }, ref: "main" },
          head: { ref: "feat/x", sha: "sha-abc" },
          title: "Feat X", state: "open", draft: false, merged_at: null,
          requested_reviewers: [], user: { login: "u" },
          html_url: "https://github.com/acme/repo/pull/42",
        }), { status: 200 });
      }
      if (url.endsWith("/repos/acme/repo/commits/sha-abc/check-runs")) {
        return new Response(JSON.stringify({
          check_runs: [{ status: "completed", conclusion: "success" }],
        }), { status: 200 });
      }
      return new Response("not found", { status: 404 });
    };

    const mr = await a.pollMergeRequest("acme/repo#42");
    expect(fetchCalls.map((c) => c.url)).toEqual([
      "https://api.github.com/repos/acme/repo/pulls/42",
      "https://api.github.com/repos/acme/repo/commits/sha-abc/check-runs",
    ]);
    expect(mr.id).toBe("acme/repo#42");
    expect(mr.pipeline).toEqual({
      state: "passed",
      webUrl: "https://github.com/acme/repo/pull/42/checks",
    });
  });

  test("throws HttpError on non-OK PR response", async () => {
    const a = new GitHubAdapter({ type: "github" });
    (a as any).token = "t"; a.authState = "ok";
    fetchResponder = async () => new Response("nope", { status: 404 });
    await expect(a.pollMergeRequest("acme/repo#42")).rejects.toThrow();
  });

  test("malformed id throws", async () => {
    const a = new GitHubAdapter({ type: "github" });
    await expect(a.pollMergeRequest("garbage")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/adapters/github.test.ts`
Expected: FAIL — `pollMergeRequest` throws "not implemented".

- [ ] **Step 3: Add the implementation**

Replace the placeholder `pollMergeRequest`:

```ts
  async pollMergeRequest(mrId: string): Promise<MergeRequest> {
    const parsed = parseMrId(mrId);
    if (!parsed) throw new HttpError(`Malformed GitHub MR id: ${mrId}`, 400);
    const { owner, repo, number } = parsed;
    const prResp = await this.fetch(`${this.baseUrl}/repos/${owner}/${repo}/pulls/${number}`);
    if (!prResp.ok) {
      this.handleErrorStatus(prResp.status);
      throw new HttpError(`GitHub API error: ${prResp.status}`, prResp.status);
    }
    const raw = await prResp.json();
    const pipeline = await this.fetchPipeline(owner, repo, raw.head?.sha ?? "", raw.html_url ?? "");
    return this.mapPullRequest(raw, pipeline);
  }

  protected async fetchPipeline(
    owner: string,
    repo: string,
    headSha: string,
    htmlUrl: string,
  ): Promise<PipelineStatus | null> {
    if (!headSha) return null;
    const resp = await this.fetch(
      `${this.baseUrl}/repos/${owner}/${repo}/commits/${headSha}/check-runs`,
    );
    if (!resp.ok) {
      this.handleErrorStatus(resp.status);
      return null;
    }
    const body = await resp.json();
    const state = derivePipelineState(Array.isArray(body.check_runs) ? body.check_runs : []);
    if (state === null) return null;
    return { state, webUrl: `${htmlUrl}/checks` };
  }
```

And add this pure helper at module scope (near the other helpers in `github.ts`):

```ts
/** Parse mrId "owner/repo#number" into parts. Null on malformed. */
export function parseMrId(mrId: string): { owner: string; repo: string; number: string } | null {
  const m = mrId.match(/^([^/]+)\/([^#]+)#(\d+)$/);
  if (!m) return null;
  return { owner: m[1], repo: m[2], number: m[3] };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/adapters/github.test.ts`
Expected: PASS (44 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/github.ts src/__tests__/adapters/github.test.ts
git commit -m "feat(github-adapter): pollMergeRequest with check-runs hydration"
```

---

## Task 10: `getMergeRequest(remote, branch)`

**Files:**
- Modify: `src/adapters/github.ts`
- Modify: `src/__tests__/adapters/github.test.ts`

- [ ] **Step 1: Add failing tests**

Append:

```ts
describe("GitHubAdapter.getMergeRequest", () => {
  let fetchCalls: Array<{ url: string; init?: RequestInit }>;
  let fetchResponder: (url: string, init?: RequestInit) => Promise<Response>;
  const originalFetch = global.fetch;
  beforeEach(() => {
    fetchCalls = [];
    fetchResponder = async () => new Response("[]", { status: 200 });
    global.fetch = ((u: any, i?: any) => {
      fetchCalls.push({ url: String(u), init: i });
      return fetchResponder(String(u), i);
    }) as typeof global.fetch;
  });
  afterEach(() => { global.fetch = originalFetch; });

  test("queries pulls?head and returns mapped first result with pipeline", async () => {
    const a = new GitHubAdapter({ type: "github" });
    (a as any).token = "t"; a.authState = "ok";
    fetchResponder = async (url) => {
      if (url.includes("/pulls?")) {
        return new Response(JSON.stringify([{
          number: 5,
          base: { repo: { full_name: "acme/repo" }, ref: "main" },
          head: { ref: "feat/x", sha: "sha-x" },
          title: "T", state: "open", draft: false, merged_at: null,
          requested_reviewers: [], user: { login: "u" },
          html_url: "https://github.com/acme/repo/pull/5",
        }]), { status: 200 });
      }
      if (url.endsWith("/check-runs")) {
        return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
      }
      return new Response("?", { status: 404 });
    };
    const mr = await a.getMergeRequest("https://github.com/acme/repo.git", "feat/x");
    expect(mr).not.toBeNull();
    expect(mr!.id).toBe("acme/repo#5");
    expect(mr!.pipeline).toBeNull();
    expect(fetchCalls[0].url).toBe(
      "https://api.github.com/repos/acme/repo/pulls?head=acme%3Afeat%2Fx&state=open&per_page=1",
    );
  });

  test("returns null when no PR matches", async () => {
    const a = new GitHubAdapter({ type: "github" });
    (a as any).token = "t"; a.authState = "ok";
    fetchResponder = async () => new Response("[]", { status: 200 });
    const mr = await a.getMergeRequest("https://github.com/acme/repo.git", "no-such");
    expect(mr).toBeNull();
  });

  test("returns null on bad remote", async () => {
    const a = new GitHubAdapter({ type: "github" });
    (a as any).token = "t"; a.authState = "ok";
    expect(await a.getMergeRequest("not-a-url", "x")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/adapters/github.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the implementation**

Replace placeholder `getMergeRequest`:

```ts
  async getMergeRequest(remote: string, branch: string): Promise<MergeRequest | null> {
    const or = extractOwnerRepo(remote);
    if (!or) return null;
    const params = new URLSearchParams({
      head: `${or.owner}:${branch}`,
      state: "open",
      per_page: "1",
    });
    const resp = await this.fetch(`${this.baseUrl}/repos/${or.owner}/${or.repo}/pulls?${params}`);
    if (!resp.ok) {
      this.handleErrorStatus(resp.status);
      return null;
    }
    const arr = await resp.json();
    if (!Array.isArray(arr) || arr.length === 0) return null;
    const raw = arr[0];
    const pipeline = await this.fetchPipeline(or.owner, or.repo, raw.head?.sha ?? "", raw.html_url ?? "");
    return this.mapPullRequest(raw, pipeline);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/adapters/github.test.ts`
Expected: PASS (47 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/github.ts src/__tests__/adapters/github.test.ts
git commit -m "feat(github-adapter): getMergeRequest by remote+branch"
```

---

## Task 11: `pollAllMergeRequests` — branch-matched hydration (rate-budget regression)

**Files:**
- Modify: `src/adapters/github.ts`
- Modify: `src/__tests__/adapters/github.test.ts`

This is the load-bearing test from the spec: 100-PR list response with 2
matched branches must produce exactly 1 + 2 calls, not 1 + 100.

- [ ] **Step 1: Add failing tests**

Append:

```ts
describe("GitHubAdapter.pollAllMergeRequests", () => {
  let fetchCalls: Array<{ url: string }>;
  let fetchResponder: (url: string) => Promise<Response>;
  const originalFetch = global.fetch;
  beforeEach(() => {
    fetchCalls = [];
    fetchResponder = async () => new Response("[]", { status: 200 });
    global.fetch = ((u: any) => {
      fetchCalls.push({ url: String(u) });
      return fetchResponder(String(u));
    }) as typeof global.fetch;
  });
  afterEach(() => { global.fetch = originalFetch; });

  test("matches by head.ref and returns mapped MRs per session", async () => {
    const a = new GitHubAdapter({ type: "github" });
    (a as any).token = "t"; a.authState = "ok";
    fetchResponder = async (url) => {
      if (url.includes("/pulls?")) {
        return new Response(JSON.stringify([
          { number: 1, base: { repo: { full_name: "acme/repo" }, ref: "main" }, head: { ref: "feat/a", sha: "s1" }, title: "A", state: "open", draft: false, merged_at: null, requested_reviewers: [], user: { login: "u" }, html_url: "https://github.com/acme/repo/pull/1" },
          { number: 2, base: { repo: { full_name: "acme/repo" }, ref: "main" }, head: { ref: "feat/b", sha: "s2" }, title: "B", state: "open", draft: false, merged_at: null, requested_reviewers: [], user: { login: "u" }, html_url: "https://github.com/acme/repo/pull/2" },
        ]), { status: 200 });
      }
      if (url.endsWith("/check-runs")) {
        return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
      }
      return new Response("?", { status: 404 });
    };
    const map = await a.pollAllMergeRequests([
      { sessionName: "s-a", remote: "https://github.com/acme/repo.git", branch: "feat/a" },
      { sessionName: "s-b", remote: "https://github.com/acme/repo.git", branch: "feat/b" },
    ]);
    expect(map.get("s-a")?.id).toBe("acme/repo#1");
    expect(map.get("s-b")?.id).toBe("acme/repo#2");
  });

  test("rate budget: 100 open PRs with 2 matches -> 1 list + 2 check-runs calls (NOT 101)", async () => {
    const a = new GitHubAdapter({ type: "github" });
    (a as any).token = "t"; a.authState = "ok";
    const prs = Array.from({ length: 100 }, (_, i) => ({
      number: i + 1,
      base: { repo: { full_name: "acme/repo" }, ref: "main" },
      head: { ref: `branch-${i + 1}`, sha: `sha-${i + 1}` },
      title: `T${i + 1}`, state: "open", draft: false, merged_at: null,
      requested_reviewers: [], user: { login: "u" },
      html_url: `https://github.com/acme/repo/pull/${i + 1}`,
    }));
    fetchResponder = async (url) => {
      if (url.includes("/pulls?")) {
        return new Response(JSON.stringify(prs), { status: 200 });
      }
      if (url.endsWith("/check-runs")) {
        return new Response(JSON.stringify({ check_runs: [] }), { status: 200 });
      }
      return new Response("?", { status: 404 });
    };
    await a.pollAllMergeRequests([
      { sessionName: "s-7", remote: "https://github.com/acme/repo.git", branch: "branch-7" },
      { sessionName: "s-9", remote: "https://github.com/acme/repo.git", branch: "branch-9" },
    ]);
    const listCalls = fetchCalls.filter((c) => c.url.includes("/pulls?"));
    const checkRunCalls = fetchCalls.filter((c) => c.url.endsWith("/check-runs"));
    expect(listCalls).toHaveLength(1);
    expect(checkRunCalls).toHaveLength(2);
  });

  test("groups remotes by owner/repo: one list per repo even with multiple sessions", async () => {
    const a = new GitHubAdapter({ type: "github" });
    (a as any).token = "t"; a.authState = "ok";
    fetchResponder = async (url) => {
      if (url.includes("/pulls?")) return new Response("[]", { status: 200 });
      return new Response("?", { status: 404 });
    };
    await a.pollAllMergeRequests([
      { sessionName: "s1", remote: "https://github.com/acme/repo.git", branch: "x" },
      { sessionName: "s2", remote: "https://github.com/acme/repo.git", branch: "y" },
    ]);
    expect(fetchCalls.filter((c) => c.url.includes("/pulls?"))).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/adapters/github.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the implementation**

Replace placeholder `pollAllMergeRequests`:

```ts
  async pollAllMergeRequests(remotes: BranchContext[]): Promise<Map<string, MergeRequest>> {
    const result = new Map<string, MergeRequest>();
    const byRepo = new Map<string, BranchContext[]>();
    for (const bc of remotes) {
      const or = extractOwnerRepo(bc.remote);
      if (!or) continue;
      const key = `${or.owner}/${or.repo}`;
      const list = byRepo.get(key) ?? [];
      list.push(bc);
      byRepo.set(key, list);
    }
    for (const [key, contexts] of byRepo) {
      const [owner, repo] = key.split("/");
      const resp = await this.fetch(
        `${this.baseUrl}/repos/${owner}/${repo}/pulls?state=open&per_page=100`,
      );
      if (!resp.ok) {
        this.handleErrorStatus(resp.status);
        continue;
      }
      const arr = await resp.json();
      if (!Array.isArray(arr)) continue;
      // Filter BEFORE hydrating pipeline state — this is the rate-budget
      // constraint enforced by the regression test in this file.
      const matches: Array<{ raw: any; ctx: BranchContext }> = [];
      for (const raw of arr) {
        const ctx = contexts.find((c) => c.branch === raw.head?.ref);
        if (ctx) matches.push({ raw, ctx });
      }
      for (const { raw, ctx } of matches) {
        const pipeline = await this.fetchPipeline(owner, repo, raw.head?.sha ?? "", raw.html_url ?? "");
        result.set(ctx.sessionName, this.mapPullRequest(raw, pipeline));
      }
    }
    return result;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/adapters/github.test.ts`
Expected: PASS (50 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/github.ts src/__tests__/adapters/github.test.ts
git commit -m "feat(github-adapter): pollAllMergeRequests with rate-budget regression test"
```

---

## Task 12: `pollMergeRequestsByIds`

**Files:**
- Modify: `src/adapters/github.ts`
- Modify: `src/__tests__/adapters/github.test.ts`

- [ ] **Step 1: Add failing tests**

Append:

```ts
describe("GitHubAdapter.pollMergeRequestsByIds", () => {
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
  afterEach(() => { global.fetch = originalFetch; });

  test("returns map keyed by mrId with pipeline hydration", async () => {
    const a = new GitHubAdapter({ type: "github" });
    (a as any).token = "t"; a.authState = "ok";
    fetchResponder = async (url) => {
      if (url.endsWith("/repos/acme/repo/pulls/1")) {
        return new Response(JSON.stringify({
          number: 1,
          base: { repo: { full_name: "acme/repo" }, ref: "main" },
          head: { ref: "x", sha: "s1" },
          title: "T", state: "open", draft: false, merged_at: null,
          requested_reviewers: [], user: { login: "u" },
          html_url: "https://github.com/acme/repo/pull/1",
        }), { status: 200 });
      }
      if (url.endsWith("/check-runs")) {
        return new Response(JSON.stringify({ check_runs: [{ status: "completed", conclusion: "success" }] }), { status: 200 });
      }
      return new Response("?", { status: 404 });
    };
    const map = await a.pollMergeRequestsByIds(["acme/repo#1"]);
    expect(map.get("acme/repo#1")?.pipeline?.state).toBe("passed");
  });

  test("skips entries whose PR fetch fails", async () => {
    const a = new GitHubAdapter({ type: "github" });
    (a as any).token = "t"; a.authState = "ok";
    fetchResponder = async () => new Response("nope", { status: 404 });
    const map = await a.pollMergeRequestsByIds(["acme/repo#99"]);
    expect(map.size).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/adapters/github.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the implementation**

Replace placeholder `pollMergeRequestsByIds`:

```ts
  async pollMergeRequestsByIds(ids: string[]): Promise<Map<string, MergeRequest>> {
    const result = new Map<string, MergeRequest>();
    for (const id of ids) {
      try {
        const mr = await this.pollMergeRequest(id);
        result.set(id, mr);
      } catch {
        // Mirrors GitLabAdapter's per-id resilience: one failed PR doesn't
        // poison the rest of the batch.
      }
    }
    return result;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/adapters/github.test.ts`
Expected: PASS (52 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/github.ts src/__tests__/adapters/github.test.ts
git commit -m "feat(github-adapter): pollMergeRequestsByIds"
```

---

## Task 13: `markReady` + `approve`

**Files:**
- Modify: `src/adapters/github.ts`
- Modify: `src/__tests__/adapters/github.test.ts`

- [ ] **Step 1: Add failing tests**

Append:

```ts
describe("GitHubAdapter.markReady / approve", () => {
  let fetchCalls: Array<{ url: string; method?: string; body?: string }>;
  const originalFetch = global.fetch;
  beforeEach(() => {
    fetchCalls = [];
    global.fetch = ((url: any, init?: any) => {
      fetchCalls.push({
        url: String(url),
        method: init?.method,
        body: typeof init?.body === "string" ? init.body : undefined,
      });
      return Promise.resolve(new Response("{}", { status: 200 }));
    }) as typeof global.fetch;
  });
  afterEach(() => { global.fetch = originalFetch; });

  test("markReady patches PR with draft:false", async () => {
    const a = new GitHubAdapter({ type: "github" });
    (a as any).token = "t"; a.authState = "ok";
    await a.markReady("acme/repo#42");
    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0].url).toBe("https://api.github.com/repos/acme/repo/pulls/42");
    expect(fetchCalls[0].method).toBe("PATCH");
    expect(JSON.parse(fetchCalls[0].body!)).toEqual({ draft: false });
  });

  test("approve posts an APPROVE review", async () => {
    const a = new GitHubAdapter({ type: "github" });
    (a as any).token = "t"; a.authState = "ok";
    await a.approve("acme/repo#42");
    expect(fetchCalls[0].url).toBe("https://api.github.com/repos/acme/repo/pulls/42/reviews");
    expect(fetchCalls[0].method).toBe("POST");
    expect(JSON.parse(fetchCalls[0].body!)).toEqual({ event: "APPROVE" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/adapters/github.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the implementation**

Replace `markReady` and `approve`:

```ts
  async markReady(mrId: string): Promise<void> {
    const p = parseMrId(mrId);
    if (!p) return;
    await this.fetch(
      `${this.baseUrl}/repos/${p.owner}/${p.repo}/pulls/${p.number}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draft: false }),
      },
    );
  }

  async approve(mrId: string): Promise<void> {
    const p = parseMrId(mrId);
    if (!p) return;
    await this.fetch(
      `${this.baseUrl}/repos/${p.owner}/${p.repo}/pulls/${p.number}/reviews`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ event: "APPROVE" }),
      },
    );
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/adapters/github.test.ts`
Expected: PASS (54 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/github.ts src/__tests__/adapters/github.test.ts
git commit -m "feat(github-adapter): markReady + approve"
```

---

## Task 14: Search hydration — `searchMergeRequests`, `getMyMergeRequests`, `getMrsAwaitingMyReview`

**Files:**
- Modify: `src/adapters/github.ts`
- Modify: `src/__tests__/adapters/github.test.ts`

The three search-backed methods share one hydration helper. Tests assert
the qualifier is correct (per GitHub docs, `user-review-requested:@me`
for direct review requests, not `review-requested:@me`).

- [ ] **Step 1: Add failing tests**

Append:

```ts
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
  afterEach(() => { global.fetch = originalFetch; });

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

  test("searchMergeRequests issues search then hydrates each PR (no pipeline)", async () => {
    const a = new GitHubAdapter({ type: "github" });
    (a as any).token = "t"; a.authState = "ok";
    fetchResponder = async (url) => {
      if (url.includes("/search/issues")) return new Response(JSON.stringify(searchResponse), { status: 200 });
      if (url.endsWith("/pulls/10")) return new Response(fakePr(10), { status: 200 });
      if (url.endsWith("/pulls/11")) return new Response(fakePr(11), { status: 200 });
      return new Response("?", { status: 404 });
    };
    const result = await a.searchMergeRequests("auth");
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("acme/repo#10");
    expect(result[0].pipeline).toBeNull(); // search hydration never sets pipeline
    expect(fetchCalls[0].url).toContain("type:pr");
    expect(fetchCalls[0].url).toContain("state:open");
    expect(fetchCalls[0].url).toContain("per_page=30");
  });

  test("getMyMergeRequests uses author:@me qualifier", async () => {
    const a = new GitHubAdapter({ type: "github" });
    (a as any).token = "t"; a.authState = "ok";
    fetchResponder = async (url) => {
      if (url.includes("/search/issues")) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      return new Response("?", { status: 404 });
    };
    await a.getMyMergeRequests();
    expect(fetchCalls[0].url).toContain("author%3A%40me");
  });

  test("getMrsAwaitingMyReview uses user-review-requested:@me (not review-requested:@me)", async () => {
    const a = new GitHubAdapter({ type: "github" });
    (a as any).token = "t"; a.authState = "ok";
    fetchResponder = async (url) => {
      if (url.includes("/search/issues")) return new Response(JSON.stringify({ items: [] }), { status: 200 });
      return new Response("?", { status: 404 });
    };
    await a.getMrsAwaitingMyReview();
    expect(fetchCalls[0].url).toContain("user-review-requested%3A%40me");
    // Negative assertion guards against future regressions back to the
    // weaker qualifier.
    expect(fetchCalls[0].url).not.toMatch(/[^-]review-requested%3A%40me/);
  });

  test("returns [] when not authenticated", async () => {
    const a = new GitHubAdapter({ type: "github" });
    expect(await a.getMyMergeRequests()).toEqual([]);
    expect(await a.getMrsAwaitingMyReview()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/adapters/github.test.ts`
Expected: FAIL.

- [ ] **Step 3: Add the implementation**

Replace `searchMergeRequests`, `getMyMergeRequests`, `getMrsAwaitingMyReview` and add a shared private helper:

```ts
  async searchMergeRequests(query: string): Promise<MergeRequest[]> {
    return this.searchAndHydrate(`${query} type:pr state:open`);
  }

  async getMyMergeRequests(): Promise<MergeRequest[]> {
    if (this.authState !== "ok") return [];
    return this.searchAndHydrate("author:@me type:pr state:open");
  }

  async getMrsAwaitingMyReview(): Promise<MergeRequest[]> {
    if (this.authState !== "ok") return [];
    // Per GitHub docs, `user-review-requested:@me` is the qualifier that
    // matches PRs where the user is *directly* requested. The shorter
    // `review-requested:@me` also matches PRs whose review request goes
    // to a team the user belongs to, which is broader than we want here.
    return this.searchAndHydrate("user-review-requested:@me type:pr state:open");
  }

  protected async searchAndHydrate(q: string): Promise<MergeRequest[]> {
    const params = new URLSearchParams({ q, per_page: "30" });
    const resp = await this.fetch(`${this.baseUrl}/search/issues?${params}`);
    if (!resp.ok) {
      this.handleErrorStatus(resp.status);
      return [];
    }
    const body = await resp.json();
    const items: any[] = Array.isArray(body?.items) ? body.items : [];
    // Each search-issue item carries `pull_request.url` pointing to the
    // full PR; hydrate in parallel. We deliberately skip pipeline state
    // here (see spec "Rate budget").
    const prResponses = await Promise.all(
      items
        .map((it) => it?.pull_request?.url)
        .filter((u): u is string => typeof u === "string")
        .map((u) => this.fetch(u)),
    );
    const mrs: MergeRequest[] = [];
    for (const r of prResponses) {
      if (!r.ok) continue;
      const raw = await r.json();
      mrs.push(this.mapPullRequest(raw, null));
    }
    return mrs;
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/adapters/github.test.ts`
Expected: PASS (58 tests).

- [ ] **Step 5: Commit**

```bash
git add src/adapters/github.ts src/__tests__/adapters/github.test.ts
git commit -m "feat(github-adapter): search hydration with correct review qualifier"
```

---

## Task 15: Register `github` in the adapter registry

**Files:**
- Modify: `src/adapters/registry.ts`
- Modify: `src/__tests__/adapters/registry.test.ts`

- [ ] **Step 1: Add failing test**

In `src/__tests__/adapters/registry.test.ts`, add (after the existing gitlab test):

```ts
  test("creates github code host adapter", () => {
    const result = createAdapters({ codeHost: { type: "github" } });
    expect(result.codeHost).not.toBeNull();
    expect(result.codeHost!.type).toBe("github");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/adapters/registry.test.ts`
Expected: FAIL — `codeHost` is null because no `case "github"`.

- [ ] **Step 3: Wire it up**

In `src/adapters/registry.ts`, add `GitHubAdapter` import and the case:

```ts
import { GitHubAdapter } from "./github";
```

In the `switch (config.codeHost.type)`:

```ts
      case "github":
        result.codeHost = new GitHubAdapter(config.codeHost);
        break;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/adapters/registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Type check + full suite**

Run: `bun run typecheck && bun test`
Expected: no errors, all tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/adapters/registry.ts src/__tests__/adapters/registry.test.ts
git commit -m "feat(adapters): register GitHubAdapter in the registry"
```

---

## Task 16: Host-aware MR ID prefix in `session-view.ts`

**Files:**
- Modify: `src/session-view.ts`
- Modify: `src/__tests__/session-view.test.ts`

- [ ] **Step 1: Add failing tests**

Find or add a `describe("buildSessionView mrId formatting", …)` block in `src/__tests__/session-view.test.ts`. Add two tests:

```ts
test("MR id with '#' separator (GitHub) renders as '#N'", () => {
  // Construct a minimal SessionInfo + SessionContext fixture
  const session: SessionInfo = { /* fill from existing test patterns in this file */ } as any;
  const ctx: SessionContext = {
    sessionName: session.name,
    dir: "/x",
    branch: "feat",
    remote: "https://github.com/acme/repo.git",
    mrs: [{
      id: "acme/repo#42",
      title: "T", status: "open", sourceBranch: "feat", targetBranch: "main",
      pipeline: null, approvals: { required: 0, current: 0 },
      webUrl: "https://github.com/acme/repo/pull/42",
      source: "branch",
    }],
    issues: [],
    resolvedAt: Date.now(),
  };
  const view = buildSessionView(session, ctx, undefined, new Set());
  expect(view.mrId).toBe("#42");
});

test("MR id with ':' separator (GitLab) still renders as '!N'", () => {
  const session: SessionInfo = { /* fill from existing test patterns */ } as any;
  const ctx: SessionContext = {
    sessionName: session.name,
    dir: "/x",
    branch: "feat",
    remote: "https://gitlab.com/acme/repo.git",
    mrs: [{
      id: "acme%2Frepo:42",
      title: "T", status: "open", sourceBranch: "feat", targetBranch: "main",
      pipeline: null, approvals: { required: 0, current: 0 },
      webUrl: "https://gitlab.com/acme/repo/-/merge_requests/42",
      source: "branch",
    }],
    issues: [],
    resolvedAt: Date.now(),
  };
  const view = buildSessionView(session, ctx, undefined, new Set());
  expect(view.mrId).toBe("!42");
});
```

(Match the imports and `SessionInfo` fixture shape already in use in `session-view.test.ts`. If the file does not yet import `SessionContext` or `buildSessionView`, mirror imports from the other tests in that file.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/session-view.test.ts -t "MR id with"`
Expected: FAIL — the GitHub case currently produces `!acme/repo#42` or similar via the `!${extractMrIid(...)}` path.

- [ ] **Step 3: Modify the implementation**

In `src/session-view.ts`, replace lines 62–65 (`extractMrIid`) and line 90 (where `mrId` is computed):

```ts
/**
 * Format a MergeRequest id into the per-host short label shown in the
 * sidebar. GitHub ids are "owner/repo#N" -> "#N". GitLab ids are
 * "<encoded_project>:<iid>" -> "!<iid>". Discrimination is by id shape
 * rather than adapter type, so this stays pure and out of the adapter
 * surface.
 */
function formatMrId(mr: MergeRequest): string {
  const hashIdx = mr.id.lastIndexOf("#");
  if (hashIdx >= 0) return `#${mr.id.slice(hashIdx + 1)}`;
  const colonIdx = mr.id.lastIndexOf(":");
  return colonIdx >= 0 ? `!${mr.id.slice(colonIdx + 1)}` : `!${mr.id}`;
}
```

And replace line 90:

```ts
  const mrId = selectedMr ? formatMrId(selectedMr) : null;
```

Add `MergeRequest` to the imports at the top of `session-view.ts` if not already present.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/session-view.test.ts`
Expected: PASS (existing tests + 2 new).

- [ ] **Step 5: Commit**

```bash
git add src/session-view.ts src/__tests__/session-view.test.ts
git commit -m "feat(sidebar): host-aware MR id prefix (# for GitHub, ! for GitLab)"
```

---

## Task 17: `Ctrl-a o` intercept in `input-router.ts`

**Files:**
- Modify: `src/input-router.ts`
- Modify: `src/__tests__/input-router.test.ts`

- [ ] **Step 1: Add failing tests**

In `src/__tests__/input-router.test.ts`, find the existing soft-prefix test block (around the tests for `Ctrl-a p` / `Ctrl-a n`) and add:

```ts
test("Ctrl-a o calls onOpenSessionMr and does not forward 'o' to PTY", () => {
  const ptyWrites: string[] = [];
  const calls = { open: 0 };
  const router = new InputRouter({
    sidebarCols: 26,
    onPtyData: (d) => ptyWrites.push(d),
    onSidebarClick: () => {},
    onOpenSessionMr: () => { calls.open++; },
    // ... other required no-op callbacks matching existing test fixtures
  } as any);
  router.handle("\x01");  // Ctrl-a
  router.handle("o");
  expect(calls.open).toBe(1);
  // The 'o' must not appear in PTY writes — Ctrl-a itself is forwarded,
  // but 'o' is consumed by the intercept.
  expect(ptyWrites).toEqual(["\x01"]);
});

test("plain 'o' (no preceding Ctrl-a) forwards to PTY normally", () => {
  const ptyWrites: string[] = [];
  const calls = { open: 0 };
  const router = new InputRouter({
    sidebarCols: 26,
    onPtyData: (d) => ptyWrites.push(d),
    onSidebarClick: () => {},
    onOpenSessionMr: () => { calls.open++; },
  } as any);
  router.handle("o");
  expect(calls.open).toBe(0);
  expect(ptyWrites).toEqual(["o"]);
});
```

(Match the InputRouter constructor option shape with the rest of the file. If existing tests use a helper to construct the router, follow that pattern.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/input-router.test.ts -t "Ctrl-a o"`
Expected: FAIL — `onOpenSessionMr` not in options.

- [ ] **Step 3: Modify the implementation**

In `src/input-router.ts`:

Add to `InputRouterOptions` (next to `onSettings`, `onSettingsScreen`):

```ts
  onOpenSessionMr?: () => void;  // Ctrl-a o — open focused session's MR in browser
```

In the soft-prefix intercept block (around line 159 where `data === "i"` is handled), add the new `o` branch:

```ts
        if (data === "o") {
          this.opts.onOpenSessionMr?.();
          return;
        }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/input-router.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/input-router.ts src/__tests__/input-router.test.ts
git commit -m "feat(input-router): Ctrl-a o soft-prefix intercept"
```

---

## Task 18: Wire `onOpenSessionMr` in `main.ts` + update help screen

**Files:**
- Modify: `src/main.ts`

This task has no unit test (it's wiring between modules already covered
by their own tests). Verify manually after.

- [ ] **Step 1: Add the open-MR function**

Pick a location near other small helpers in `main.ts` (e.g. near `switchByOffset`). Add:

```ts
function openFocusedSessionMr(): void {
  const sessionName = currentSessions.find((s) => s.id === currentSessionId)?.name;
  if (!sessionName) return;
  const ctx = pollCoordinator.getContext(sessionName);
  if (!ctx || ctx.mrs.length === 0 || !adapters.codeHost) {
    control.sendCommand(`display-message "No MR tracked for this session"`).catch(() => {});
    return;
  }
  // Same selection logic as session-view.ts: latest by createdAt, else last.
  const withCreated = ctx.mrs.filter((mr) => mr.createdAt != null);
  const selected = withCreated.length > 0
    ? withCreated.reduce((latest, mr) => (mr.createdAt! > latest.createdAt!) ? mr : latest)
    : ctx.mrs[ctx.mrs.length - 1];
  adapters.codeHost.openInBrowser(selected.id);
}
```

- [ ] **Step 2: Wire it into the InputRouter options**

Find the `new InputRouter({ … })` block (around line 1206) and add alongside `onSettings` / `onSettingsScreen`:

```ts
    onOpenSessionMr: () => openFocusedSessionMr(),
```

- [ ] **Step 3: Update the keybind help string**

Find the `Ctrl-a` lines in the help-screen block (around line 3653). Add a new entry next to the existing ones:

```ts
      [{ text: "Ctrl-a", attrs: g }, { text: " then ", attrs: n }, { text: "o", attrs: g }, { text: "          Open MR for this session", attrs: n }],
```

Find the usage banner block around line 84 (the `--help` text) and add the same line to whichever list is rendered there if applicable. Search for the existing `Ctrl-a i` mention to find sibling entries:

```bash
grep -n "Ctrl-a i" src/main.ts
```

- [ ] **Step 4: Type check + full suite**

Run: `bun run typecheck && bun test`
Expected: no errors, all tests pass.

- [ ] **Step 5: Manual smoke test (UI feature — type-checking does not verify behavior)**

Per the project's `CLAUDE.md` rule on UI changes: actually use the feature.

  1. Start jmux from source against a session whose branch has an MR:
     `bun run dev`
  2. In a session whose context has resolved an MR (either GitLab or
     GitHub once configured), press `Ctrl-a o`. The MR should open in
     your default browser.
  3. In a session that has no MR, press `Ctrl-a o`. tmux should flash
     the `"No MR tracked for this session"` message at the bottom.
  4. Confirm `Ctrl-a p`, `Ctrl-a n`, `Ctrl-a i` still work (regression
     check on the soft-prefix intercept).

If you cannot test it interactively here (no live MR), say so
explicitly when finishing the task rather than asserting success.

- [ ] **Step 6: Commit**

```bash
git add src/main.ts
git commit -m "feat(main): wire Ctrl-a o to open focused session's MR"
```

---

## Task 19: Docs — keybind reference and adapter config example

**Files:**
- Modify: `docs/getting-started.md`
- Modify: `docs/configuration.md`

- [ ] **Step 1: Update keybind reference**

In `docs/getting-started.md`, find the section listing `Ctrl-a` keybinds (search for `Ctrl-a p` / `Ctrl-a n`). Add a row for `Ctrl-a o`:

```
Ctrl-a o          Open the focused session's merge / pull request in your browser
```

If the existing format is a table, add a row using the same column alignment.

- [ ] **Step 2: Update configuration docs**

In `docs/configuration.md`, find the section that documents `codeHost`. After the GitLab example, add:

````markdown
### GitHub

```json
{
  "codeHost": { "type": "github" }
}
```

Authenticate via `$GITHUB_TOKEN` or `gh auth login`. For GitHub
Enterprise:

```json
{
  "codeHost": {
    "type": "github",
    "url": "https://gh.acme.corp/api/v3",
    "webUrl": "https://gh.acme.corp"
  }
}
```

`webUrl` is optional; jmux derives it from `url` automatically for the
standard Enterprise Server layout.
````

- [ ] **Step 3: Commit**

```bash
git add docs/getting-started.md docs/configuration.md
git commit -m "docs: document Ctrl-a o keybind and github codeHost config"
```

---

## Final verification

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: all tests pass.

- [ ] **Step 2: Run type check**

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 3: Verify clean working tree**

Run: `git status`
Expected: clean, no untracked files.

- [ ] **Step 4: Log of commits**

Run: `git log --oneline -20`
Expected: ~19 small commits, one per task.

---

## Self-Review

**Spec coverage** — Every spec section maps to at least one task:

| Spec section | Covered by |
|--------------|------------|
| GitHub adapter: authentication | Task 6 |
| GitHub adapter: configuration (`url`, `webUrl`) | Task 1 (deriveWebOrigin), Task 6 (constructor reads both) |
| GitHub adapter: HTTP layer (`fetch` helper, UA, auth errors) | Task 8 |
| Method table: `getMergeRequest` | Task 10 |
| Method table: `pollMergeRequest` | Task 9 |
| Method table: `pollAllMergeRequests` | Task 11 |
| Method table: `openInBrowser` | Task 8 |
| Method table: `markReady` | Task 13 |
| Method table: `approve` | Task 13 |
| Method table: `searchMergeRequests` (hydrated) | Task 14 |
| Method table: `parseMrUrl` | Task 3 (helper) + Task 6 (wired in skeleton) |
| Method table: `pollMergeRequestsByIds` | Task 12 |
| Method table: `getMyMergeRequests` (hydrated) | Task 14 |
| Method table: `getMrsAwaitingMyReview` (correct qualifier) | Task 14 (explicit assertion) |
| Search hydration | Task 14 |
| Pipeline state mapping (Checks API only) | Task 4 (derive) + Tasks 9, 10, 11 (fetchPipeline plumbing) |
| Rate budget constraint (no pipeline for unmatched PRs) | Task 11 (regression test) |
| MR ID format (`owner/repo#N`) | Tasks 7, 16 |
| Display: per-host MR ID prefix | Task 16 |
| Hotkey `Ctrl-a o` | Tasks 17, 18 |
| Documentation | Task 19 |
| Conflict check vs existing `o` panel binding | Documented in spec; no code change needed since soft-prefix path is independent of panel-view path |

**Placeholder scan** — None: every step shows the exact code or command. Manual smoke step at Task 18 is explicit about its own observability ("say so if you can't test").

**Type consistency** — `MergeRequest`, `PipelineStatus`, `BranchContext`, `CodeHostAdapter`, `AdapterAuthState`, `HttpError` are imported from `./types` in github.ts. `parseMrId`, `mapPullRequest`, `fetchPipeline`, `searchAndHydrate`, `readGhToken`, `handleErrorStatus`, `fetch` are defined where used. MR id shape `"owner/repo#number"` is consistent across `parseGithubMrUrl`, `parseMrId`, `mapPullRequest.id`, and `buildPrWebUrl`. `formatMrId` discriminates on `#` vs `:` consistently with how the two adapters mint ids.
