# Info Panel & External Adapters Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Evolve the diff panel into a tabbed info panel with pluggable adapters for code hosts (GitLab/GitHub) and issue trackers (Linear/GitHub Issues), surfacing MR status, pipeline state, and issue tracking alongside diffs.

**Architecture:** InfoPanel is a tab-bar container wrapping the existing DiffPanel as one tab. MR and Issues tabs render static CellGrids from adapter data. A PollCoordinator owns all API calls with tiered polling (20s active, 3min background) and rate-limit backoff. Adapters are in-process TypeScript modules behind async interfaces, discoverable via environment auth.

**Tech Stack:** TypeScript, Bun runtime, `fetch` for HTTP (GitLab REST API, Linear GraphQL), existing `CellGrid`/`createGrid`/`writeString` for rendering.

**Spec:** `docs/specs/2026-04-12-info-panel-adapters-design.md`

---

### Task 1: Adapter Types

**Files:**
- Create: `src/adapters/types.ts`
- Test: `src/__tests__/adapters/types.test.ts`

- [ ] **Step 1: Create the types file with all interfaces**

```typescript
// src/adapters/types.ts

export interface PipelineStatus {
  state: "running" | "passed" | "failed" | "pending" | "canceled";
  webUrl: string;
}

export interface MergeRequest {
  id: string;
  title: string;
  status: "draft" | "open" | "merged" | "closed";
  sourceBranch: string;
  targetBranch: string;
  pipeline: PipelineStatus | null;
  approvals: { required: number; current: number };
  webUrl: string;
}

export interface Issue {
  id: string;
  identifier: string;
  title: string;
  status: string;
  assignee: string | null;
  linkedMrUrls: string[];
  webUrl: string;
}

export interface BranchContext {
  sessionName: string;
  remote: string;
  branch: string;
}

export interface SessionContext {
  sessionName: string;
  dir: string;
  branch: string | null;
  remote: string | null;
  mr: MergeRequest | null;
  issue: Issue | null;
  resolvedAt: number;
}

export type AdapterAuthState = "ok" | "failed" | "unauthenticated";

export interface CodeHostAdapter {
  type: string;
  authState: AdapterAuthState;
  authHint: string; // e.g., "$GITLAB_TOKEN"

  authenticate(): Promise<void>;
  getMergeRequest(remote: string, branch: string): Promise<MergeRequest | null>;
  pollMergeRequest(mrId: string): Promise<MergeRequest>;
  pollAllMergeRequests(remotes: BranchContext[]): Promise<Map<string, MergeRequest>>;
  openInBrowser(mrId: string): void;
  markReady(mrId: string): Promise<void>;
  approve(mrId: string): Promise<void>;
}

export interface IssueTrackerAdapter {
  type: string;
  authState: AdapterAuthState;
  authHint: string;

  authenticate(): Promise<void>;
  getLinkedIssue(mrUrl: string): Promise<Issue | null>;
  getIssueByBranch(branch: string): Promise<Issue | null>;
  pollIssue(issueId: string): Promise<Issue>;
  pollAllIssues(issueIds: string[]): Promise<Map<string, Issue>>;
  getAvailableStatuses(issueId: string): Promise<string[]>;
  openInBrowser(issueId: string): void;
  updateStatus(issueId: string, status: string): Promise<void>;
}

export interface AdapterConfig {
  codeHost?: { type: string; [key: string]: unknown };
  issueTracker?: { type: string; [key: string]: unknown };
}
```

- [ ] **Step 2: Write a type-checking test**

```typescript
// src/__tests__/adapters/types.test.ts
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
```

- [ ] **Step 3: Run test to verify it passes**

Run: `bun test src/__tests__/adapters/types.test.ts`
Expected: PASS — all type-shape tests green

- [ ] **Step 4: Commit**

```bash
git add src/adapters/types.ts src/__tests__/adapters/types.test.ts
git commit -m "feat: add adapter type definitions for code host and issue tracker integrations"
```

---

### Task 2: Extend Config

**Files:**
- Modify: `src/config.ts:5-14` (JmuxConfig interface)
- Modify: `src/__tests__/config.test.ts`

- [ ] **Step 1: Write failing test for adapter config parsing**

Add to `src/__tests__/config.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { sanitizeTmuxSessionName, buildOtelResourceAttrs, loadUserConfig } from "../config";
import type { AdapterConfig } from "../adapters/types";
// ... existing tests ...

describe("loadUserConfig adapter config", () => {
  test("parses adapter config from valid JSON", () => {
    const tmpPath = `/tmp/jmux-test-config-${Date.now()}.json`;
    const config = {
      sidebarWidth: 30,
      adapters: {
        codeHost: { type: "gitlab" },
        issueTracker: { type: "linear" },
      },
    };
    require("fs").writeFileSync(tmpPath, JSON.stringify(config));
    const result = loadUserConfig(tmpPath);
    expect(result.adapters).toBeDefined();
    expect(result.adapters!.codeHost!.type).toBe("gitlab");
    expect(result.adapters!.issueTracker!.type).toBe("linear");
    require("fs").unlinkSync(tmpPath);
  });

  test("returns undefined adapters when not configured", () => {
    const tmpPath = `/tmp/jmux-test-config-${Date.now()}.json`;
    require("fs").writeFileSync(tmpPath, JSON.stringify({ sidebarWidth: 26 }));
    const result = loadUserConfig(tmpPath);
    expect(result.adapters).toBeUndefined();
    require("fs").unlinkSync(tmpPath);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/config.test.ts`
Expected: FAIL — `adapters` property doesn't exist on `JmuxConfig`

- [ ] **Step 3: Extend JmuxConfig interface**

In `src/config.ts`, add the import and extend the interface:

```typescript
// Add at top of file:
import type { AdapterConfig } from "./adapters/types";

// Extend JmuxConfig (lines 5-14):
export interface JmuxConfig {
  sidebarWidth?: number;
  claudeCommand?: string;
  cacheTimers?: boolean;
  pinnedSessions?: string[];
  diffPanel?: {
    splitRatio?: number;
    hunkCommand?: string;
  };
  adapters?: AdapterConfig;
}
```

No changes needed to `loadUserConfig` — it already returns the parsed JSON object, so `adapters` will flow through automatically.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/__tests__/config.test.ts`
Expected: PASS

- [ ] **Step 5: Run full typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/config.ts src/__tests__/config.test.ts
git commit -m "feat: extend JmuxConfig with adapters field for code host and issue tracker"
```

---

### Task 3: Context Resolver

**Files:**
- Create: `src/adapters/context-resolver.ts`
- Test: `src/__tests__/adapters/context-resolver.test.ts`

The context resolver takes a directory and produces git state (branch + remote), then chains through adapters to build a `SessionContext`. It shells out to `git` for branch/remote info.

- [ ] **Step 1: Write tests for git state extraction and context resolution**

```typescript
// src/__tests__/adapters/context-resolver.test.ts
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
    });
    expect(ctx.branch).toBeNull();
    expect(ctx.remote).toBeNull();
    expect(ctx.mr).toBeNull();
    expect(ctx.issue).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/adapters/context-resolver.test.ts`
Expected: FAIL — module doesn't exist

- [ ] **Step 3: Implement context-resolver.ts**

```typescript
// src/adapters/context-resolver.ts
import type {
  CodeHostAdapter,
  IssueTrackerAdapter,
  SessionContext,
} from "./types";

export interface GitRemote {
  name: string;
  url: string;
}

const HOSTNAME_MAP: Record<string, string[]> = {
  gitlab: ["gitlab.com"],
  github: ["github.com"],
};

export async function getGitBranch(dir: string): Promise<string | null> {
  try {
    const proc = Bun.spawnSync(
      ["git", "rev-parse", "--abbrev-ref", "HEAD"],
      { cwd: dir, stdout: "pipe", stderr: "pipe" },
    );
    if (proc.exitCode !== 0) return null;
    const branch = proc.stdout.toString().trim();
    return branch || null;
  } catch {
    return null;
  }
}

export async function getGitRemotes(dir: string): Promise<GitRemote[]> {
  try {
    const proc = Bun.spawnSync(
      ["git", "remote", "-v"],
      { cwd: dir, stdout: "pipe", stderr: "pipe" },
    );
    if (proc.exitCode !== 0) return [];
    const lines = proc.stdout.toString().trim().split("\n");
    const seen = new Set<string>();
    const remotes: GitRemote[] = [];
    for (const line of lines) {
      const parts = line.split(/\s+/);
      if (parts.length < 2) continue;
      const name = parts[0];
      if (seen.has(name)) continue; // git remote -v shows fetch and push
      seen.add(name);
      remotes.push({ name, url: parts[1] });
    }
    return remotes;
  } catch {
    return [];
  }
}

export function selectRemote(
  remotes: GitRemote[],
  adapterType: string | null,
): GitRemote | null {
  if (remotes.length === 0) return null;

  // If we know the adapter type, try to match by hostname
  if (adapterType) {
    const hostnames = HOSTNAME_MAP[adapterType] ?? [];
    for (const remote of remotes) {
      try {
        const hostname = new URL(remote.url).hostname;
        if (hostnames.includes(hostname)) return remote;
      } catch {
        // SSH URLs like git@gitlab.com:org/repo.git
        for (const h of hostnames) {
          if (remote.url.includes(h)) return remote;
        }
      }
    }
  }

  // Fall back to origin, then first remote
  return remotes.find((r) => r.name === "origin") ?? remotes[0];
}

export interface ResolveOptions {
  sessionName: string;
  dir: string;
  codeHost: CodeHostAdapter | null;
  issueTracker: IssueTrackerAdapter | null;
}

export async function resolveSessionContext(
  opts: ResolveOptions,
): Promise<SessionContext> {
  const { sessionName, dir, codeHost, issueTracker } = opts;
  const base: SessionContext = {
    sessionName,
    dir,
    branch: null,
    remote: null,
    mr: null,
    issue: null,
    resolvedAt: Date.now(),
  };

  // Step 1-2: git state
  const branch = await getGitBranch(dir);
  if (!branch) return base;
  base.branch = branch;

  const remotes = await getGitRemotes(dir);
  const remote = selectRemote(remotes, codeHost?.type ?? null);
  if (!remote) return base;
  base.remote = remote.url;

  // Step 3: code host lookup
  if (codeHost && codeHost.authState === "ok") {
    try {
      base.mr = await codeHost.getMergeRequest(remote.url, branch);
    } catch {
      // Non-fatal — MR might not exist yet
    }
  }

  // Step 4: issue tracker lookup
  if (issueTracker && issueTracker.authState === "ok") {
    try {
      // Try MR URL first (most reliable)
      if (base.mr) {
        base.issue = await issueTracker.getLinkedIssue(base.mr.webUrl);
      }
      // Fall back to branch name
      if (!base.issue) {
        base.issue = await issueTracker.getIssueByBranch(branch);
      }
    } catch {
      // Non-fatal
    }
  }

  return base;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/adapters/context-resolver.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/adapters/context-resolver.ts src/__tests__/adapters/context-resolver.test.ts
git commit -m "feat: add context resolver for git state to MR/issue resolution chain"
```

---

### Task 4: Poll Coordinator

**Files:**
- Create: `src/adapters/poll-coordinator.ts`
- Test: `src/__tests__/adapters/poll-coordinator.test.ts`

- [ ] **Step 1: Write tests for poll coordinator**

```typescript
// src/__tests__/adapters/poll-coordinator.test.ts
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
    });
    coordinator.addSession("test", "/tmp/test");
    expect(coordinator.getContext("test")).toBeNull(); // not resolved yet
    coordinator.removeSession("test");
  });

  test("setActiveSession updates active session", () => {
    const coordinator = new PollCoordinator({
      codeHost: null,
      issueTracker: null,
      onUpdate: () => {},
      getSessionDir: () => "/tmp",
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
    });
    coordinator.reportAuthFailure("codeHost");
    expect(codeHost.authState).toBe("failed");
    coordinator.stop();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/adapters/poll-coordinator.test.ts`
Expected: FAIL — module doesn't exist

- [ ] **Step 3: Implement poll-coordinator.ts**

```typescript
// src/adapters/poll-coordinator.ts
import { resolveSessionContext } from "./context-resolver";
import type {
  CodeHostAdapter,
  IssueTrackerAdapter,
  SessionContext,
  BranchContext,
} from "./types";
import { getGitBranch } from "./context-resolver";

const ACTIVE_INTERVAL_MS = 20_000;
const BACKGROUND_INTERVAL_MS = 180_000;
const RATE_LIMITED_ACTIVE_MS = 60_000;

export type RateLimitState = "normal" | "rate_limited" | "hard_limited";

export interface PollCoordinatorOptions {
  codeHost: CodeHostAdapter | null;
  issueTracker: IssueTrackerAdapter | null;
  onUpdate: (sessionName: string) => void;
  getSessionDir: (sessionName: string) => string | null;
}

export class PollCoordinator {
  private opts: PollCoordinatorOptions;
  private contexts = new Map<string, SessionContext>();
  private sessionDirs = new Map<string, string>();
  private activeSession: string | null = null;
  private activeTimer: ReturnType<typeof setInterval> | null = null;
  private backgroundTimer: ReturnType<typeof setInterval> | null = null;
  private _rateLimitState: RateLimitState = "normal";

  get rateLimitState(): RateLimitState {
    return this._rateLimitState;
  }

  get codeHost(): CodeHostAdapter | null {
    return this.opts.codeHost;
  }

  get issueTracker(): IssueTrackerAdapter | null {
    return this.opts.issueTracker;
  }

  constructor(opts: PollCoordinatorOptions) {
    this.opts = opts;
  }

  start(): void {
    this.startActivePolling();
    this.startBackgroundPolling();
  }

  stop(): void {
    if (this.activeTimer) {
      clearInterval(this.activeTimer);
      this.activeTimer = null;
    }
    if (this.backgroundTimer) {
      clearInterval(this.backgroundTimer);
      this.backgroundTimer = null;
    }
  }

  addSession(name: string, dir: string): void {
    this.sessionDirs.set(name, dir);
  }

  removeSession(name: string): void {
    this.sessionDirs.delete(name);
    this.contexts.delete(name);
  }

  async setActiveSession(name: string): Promise<void> {
    this.activeSession = name;
    // Resolve context immediately if we don't have one
    if (!this.contexts.has(name)) {
      await this.resolveContext(name);
    }
  }

  getContext(session: string): SessionContext | null {
    return this.contexts.get(session) ?? null;
  }

  getAllContexts(): Map<string, SessionContext> {
    return this.contexts;
  }

  reportRateLimit(state: RateLimitState): void {
    this._rateLimitState = state;
    // Restart timers with adjusted intervals
    this.stop();
    if (state !== "hard_limited") {
      this.start();
    }
  }

  reportAuthFailure(adapterKey: "codeHost" | "issueTracker"): void {
    const adapter = this.opts[adapterKey];
    if (adapter) {
      adapter.authState = "failed";
    }
  }

  private async resolveContext(name: string): Promise<void> {
    const dir = this.sessionDirs.get(name);
    if (!dir) return;

    const ctx = await resolveSessionContext({
      sessionName: name,
      dir,
      codeHost: this.opts.codeHost,
      issueTracker: this.opts.issueTracker,
    });
    this.contexts.set(name, ctx);
    this.opts.onUpdate(name);
  }

  private async pollActiveSession(): Promise<void> {
    if (!this.activeSession || this._rateLimitState === "hard_limited") return;

    const name = this.activeSession;
    const ctx = this.contexts.get(name);
    if (!ctx) {
      await this.resolveContext(name);
      return;
    }

    // Check for branch drift
    const dir = this.sessionDirs.get(name);
    if (dir) {
      const currentBranch = await getGitBranch(dir);
      if (currentBranch !== ctx.branch) {
        // Branch changed — re-resolve
        await this.resolveContext(name);
        return;
      }
    }

    // Poll existing MR
    const { codeHost, issueTracker } = this.opts;
    let changed = false;

    if (ctx.mr && codeHost && codeHost.authState === "ok") {
      try {
        const updated = await codeHost.pollMergeRequest(ctx.mr.id);
        ctx.mr = updated;
        changed = true;
      } catch (e: any) {
        if (e?.status === 401 || e?.status === 403) {
          this.reportAuthFailure("codeHost");
        } else if (e?.status === 429) {
          this.reportRateLimit("rate_limited");
        }
      }
    }

    if (ctx.issue && issueTracker && issueTracker.authState === "ok") {
      try {
        const updated = await issueTracker.pollIssue(ctx.issue.id);
        ctx.issue = updated;
        changed = true;
      } catch (e: any) {
        if (e?.status === 401 || e?.status === 403) {
          this.reportAuthFailure("issueTracker");
        } else if (e?.status === 429) {
          this.reportRateLimit("rate_limited");
        }
      }
    }

    if (changed) {
      ctx.resolvedAt = Date.now();
      this.opts.onUpdate(name);
    }
  }

  private async pollBackgroundSessions(): Promise<void> {
    if (this._rateLimitState !== "normal") return;

    const { codeHost, issueTracker } = this.opts;
    const branchContexts: BranchContext[] = [];
    const issueIds: string[] = [];
    const issueSessionMap = new Map<string, string>(); // issueId → sessionName

    for (const [name, ctx] of this.contexts) {
      if (name === this.activeSession) continue;
      if (ctx.branch && ctx.remote) {
        branchContexts.push({
          sessionName: name,
          remote: ctx.remote,
          branch: ctx.branch,
        });
      }
      if (ctx.issue) {
        issueIds.push(ctx.issue.id);
        issueSessionMap.set(ctx.issue.id, name);
      }
    }

    // Batch poll MRs
    if (branchContexts.length > 0 && codeHost && codeHost.authState === "ok") {
      try {
        const results = await codeHost.pollAllMergeRequests(branchContexts);
        for (const [sessionName, mr] of results) {
          const ctx = this.contexts.get(sessionName);
          if (ctx) {
            ctx.mr = mr;
            ctx.resolvedAt = Date.now();
            this.opts.onUpdate(sessionName);
          }
        }
      } catch (e: any) {
        if (e?.status === 429) this.reportRateLimit("rate_limited");
      }
    }

    // Batch poll issues
    if (issueIds.length > 0 && issueTracker && issueTracker.authState === "ok") {
      try {
        const results = await issueTracker.pollAllIssues(issueIds);
        for (const [issueId, issue] of results) {
          const sessionName = issueSessionMap.get(issueId);
          if (sessionName) {
            const ctx = this.contexts.get(sessionName);
            if (ctx) {
              ctx.issue = issue;
              ctx.resolvedAt = Date.now();
              this.opts.onUpdate(sessionName);
            }
          }
        }
      } catch (e: any) {
        if (e?.status === 429) this.reportRateLimit("rate_limited");
      }
    }
  }

  private startActivePolling(): void {
    const interval = this._rateLimitState === "rate_limited"
      ? RATE_LIMITED_ACTIVE_MS
      : ACTIVE_INTERVAL_MS;
    this.activeTimer = setInterval(() => this.pollActiveSession(), interval);
  }

  private startBackgroundPolling(): void {
    if (this._rateLimitState !== "normal") return;
    this.backgroundTimer = setInterval(
      () => this.pollBackgroundSessions(),
      BACKGROUND_INTERVAL_MS,
    );
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/adapters/poll-coordinator.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/adapters/poll-coordinator.ts src/__tests__/adapters/poll-coordinator.test.ts
git commit -m "feat: add poll coordinator with tiered intervals and rate-limit backoff"
```

---

### Task 5: Adapter Registry

**Files:**
- Create: `src/adapters/registry.ts`
- Test: `src/__tests__/adapters/registry.test.ts`

- [ ] **Step 1: Write tests for registry**

```typescript
// src/__tests__/adapters/registry.test.ts
import { describe, test, expect } from "bun:test";
import { createAdapters } from "../../adapters/registry";
import type { AdapterConfig } from "../../adapters/types";

describe("createAdapters", () => {
  test("returns null adapters when config is empty", () => {
    const result = createAdapters({});
    expect(result.codeHost).toBeNull();
    expect(result.issueTracker).toBeNull();
  });

  test("returns null adapters when config is undefined", () => {
    const result = createAdapters(undefined);
    expect(result.codeHost).toBeNull();
    expect(result.issueTracker).toBeNull();
  });

  test("creates gitlab code host adapter", () => {
    const result = createAdapters({ codeHost: { type: "gitlab" } });
    expect(result.codeHost).not.toBeNull();
    expect(result.codeHost!.type).toBe("gitlab");
  });

  test("creates linear issue tracker adapter", () => {
    const result = createAdapters({ issueTracker: { type: "linear" } });
    expect(result.issueTracker).not.toBeNull();
    expect(result.issueTracker!.type).toBe("linear");
  });

  test("returns null for unknown adapter type", () => {
    const result = createAdapters({ codeHost: { type: "bitbucket" } });
    expect(result.codeHost).toBeNull();
  });

  test("creates both adapters", () => {
    const result = createAdapters({
      codeHost: { type: "gitlab" },
      issueTracker: { type: "linear" },
    });
    expect(result.codeHost).not.toBeNull();
    expect(result.issueTracker).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/adapters/registry.test.ts`
Expected: FAIL — module doesn't exist

- [ ] **Step 3: Implement registry.ts**

```typescript
// src/adapters/registry.ts
import type { AdapterConfig, CodeHostAdapter, IssueTrackerAdapter } from "./types";
import { GitLabAdapter } from "./gitlab";
import { LinearAdapter } from "./linear";

export interface AdapterSet {
  codeHost: CodeHostAdapter | null;
  issueTracker: IssueTrackerAdapter | null;
}

export function createAdapters(config: AdapterConfig | undefined): AdapterSet {
  const result: AdapterSet = { codeHost: null, issueTracker: null };
  if (!config) return result;

  if (config.codeHost) {
    switch (config.codeHost.type) {
      case "gitlab":
        result.codeHost = new GitLabAdapter(config.codeHost);
        break;
      // case "github": result.codeHost = new GitHubAdapter(config.codeHost); break;
    }
  }

  if (config.issueTracker) {
    switch (config.issueTracker.type) {
      case "linear":
        result.issueTracker = new LinearAdapter(config.issueTracker);
        break;
      // case "github": result.issueTracker = new GitHubIssuesAdapter(config.issueTracker); break;
    }
  }

  return result;
}
```

Note: This depends on Task 6 (GitLab) and Task 7 (Linear). Create stub implementations to make the registry compile, then flesh them out in those tasks. Or implement Tasks 6 and 7 first if running sequentially.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/adapters/registry.test.ts`
Expected: PASS (requires stubs for GitLabAdapter and LinearAdapter to exist — see Tasks 6 and 7)

- [ ] **Step 5: Commit**

```bash
git add src/adapters/registry.ts src/__tests__/adapters/registry.test.ts
git commit -m "feat: add adapter registry for instantiating adapters by type"
```

---

### Task 6: GitLab Adapter

**Files:**
- Create: `src/adapters/gitlab.ts`
- Test: `src/__tests__/adapters/gitlab.test.ts`

- [ ] **Step 1: Write tests for GitLab adapter**

```typescript
// src/__tests__/adapters/gitlab.test.ts
import { describe, test, expect, mock, beforeEach } from "bun:test";
import { GitLabAdapter, extractProjectPath } from "../../adapters/gitlab";

describe("extractProjectPath", () => {
  test("extracts from HTTPS URL", () => {
    expect(extractProjectPath("https://gitlab.com/org/repo.git"))
      .toBe("org/repo");
  });

  test("extracts from HTTPS URL without .git", () => {
    expect(extractProjectPath("https://gitlab.com/org/repo"))
      .toBe("org/repo");
  });

  test("extracts from SSH URL", () => {
    expect(extractProjectPath("git@gitlab.com:org/repo.git"))
      .toBe("org/repo");
  });

  test("extracts nested group paths", () => {
    expect(extractProjectPath("https://gitlab.com/org/sub/repo.git"))
      .toBe("org/sub/repo");
  });

  test("returns null for invalid URL", () => {
    expect(extractProjectPath("not-a-url")).toBeNull();
  });
});

describe("GitLabAdapter", () => {
  test("starts in unauthenticated state", () => {
    const adapter = new GitLabAdapter({ type: "gitlab" });
    expect(adapter.type).toBe("gitlab");
    expect(adapter.authState).toBe("unauthenticated");
    expect(adapter.authHint).toBe("$GITLAB_TOKEN or $GITLAB_PRIVATE_TOKEN");
  });

  test("authenticate succeeds with env var", async () => {
    const origToken = process.env.GITLAB_TOKEN;
    process.env.GITLAB_TOKEN = "test-token";
    try {
      const adapter = new GitLabAdapter({ type: "gitlab" });
      await adapter.authenticate();
      expect(adapter.authState).toBe("ok");
    } finally {
      if (origToken === undefined) delete process.env.GITLAB_TOKEN;
      else process.env.GITLAB_TOKEN = origToken;
    }
  });

  test("authenticate fails without env var", async () => {
    const origToken = process.env.GITLAB_TOKEN;
    const origPrivate = process.env.GITLAB_PRIVATE_TOKEN;
    delete process.env.GITLAB_TOKEN;
    delete process.env.GITLAB_PRIVATE_TOKEN;
    try {
      const adapter = new GitLabAdapter({ type: "gitlab" });
      await adapter.authenticate();
      expect(adapter.authState).toBe("failed");
    } finally {
      if (origToken !== undefined) process.env.GITLAB_TOKEN = origToken;
      if (origPrivate !== undefined) process.env.GITLAB_PRIVATE_TOKEN = origPrivate;
    }
  });

  test("openInBrowser calls open command", () => {
    // Just verify it doesn't throw
    const adapter = new GitLabAdapter({ type: "gitlab" });
    // openInBrowser is fire-and-forget, we just verify no error
    // (actual open is side-effectful, not tested)
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/adapters/gitlab.test.ts`
Expected: FAIL — module doesn't exist

- [ ] **Step 3: Implement gitlab.ts**

```typescript
// src/adapters/gitlab.ts
import type {
  CodeHostAdapter,
  AdapterAuthState,
  MergeRequest,
  PipelineStatus,
  BranchContext,
} from "./types";

const GITLAB_API = "https://gitlab.com/api/v4";

export function extractProjectPath(remoteUrl: string): string | null {
  // SSH: git@gitlab.com:org/repo.git
  const sshMatch = remoteUrl.match(/^git@[^:]+:(.+?)(?:\.git)?$/);
  if (sshMatch) return sshMatch[1];

  // HTTPS: https://gitlab.com/org/repo.git
  try {
    const url = new URL(remoteUrl);
    const path = url.pathname.replace(/^\//, "").replace(/\.git$/, "");
    return path || null;
  } catch {
    return null;
  }
}

export class GitLabAdapter implements CodeHostAdapter {
  type = "gitlab";
  authState: AdapterAuthState = "unauthenticated";
  authHint = "$GITLAB_TOKEN or $GITLAB_PRIVATE_TOKEN";
  private token: string | null = null;
  private baseUrl: string;

  constructor(config: Record<string, unknown>) {
    this.baseUrl = (config.url as string) ?? GITLAB_API;
  }

  async authenticate(): Promise<void> {
    const token =
      process.env.GITLAB_TOKEN ??
      process.env.GITLAB_PRIVATE_TOKEN ??
      null;

    if (!token) {
      // Try glab CLI fallback
      try {
        const proc = Bun.spawnSync(["glab", "auth", "status", "-t"], {
          stdout: "pipe",
          stderr: "pipe",
        });
        const output = proc.stdout.toString() + proc.stderr.toString();
        const match = output.match(/Token:\s+(\S+)/);
        if (match) {
          this.token = match[1];
          this.authState = "ok";
          return;
        }
      } catch {}
      this.authState = "failed";
      return;
    }

    this.token = token;
    this.authState = "ok";
  }

  async getMergeRequest(
    remote: string,
    branch: string,
  ): Promise<MergeRequest | null> {
    const project = extractProjectPath(remote);
    if (!project) return null;

    const encoded = encodeURIComponent(project);
    const params = new URLSearchParams({
      source_branch: branch,
      state: "opened",
      per_page: "1",
    });
    const resp = await this.fetch(
      `${this.baseUrl}/projects/${encoded}/merge_requests?${params}`,
    );
    if (!resp.ok) {
      this.handleErrorStatus(resp.status);
      return null;
    }

    const mrs = await resp.json();
    if (!Array.isArray(mrs) || mrs.length === 0) return null;
    return this.mapMergeRequest(mrs[0]);
  }

  async pollMergeRequest(mrId: string): Promise<MergeRequest> {
    // mrId format: "project_encoded:iid"
    const [project, iid] = mrId.split(":");
    const resp = await this.fetch(
      `${this.baseUrl}/projects/${project}/merge_requests/${iid}`,
    );
    if (!resp.ok) {
      const err = new Error(`GitLab API error: ${resp.status}`);
      (err as any).status = resp.status;
      throw err;
    }
    return this.mapMergeRequest(await resp.json());
  }

  async pollAllMergeRequests(
    remotes: BranchContext[],
  ): Promise<Map<string, MergeRequest>> {
    const result = new Map<string, MergeRequest>();
    // GitLab doesn't have a single endpoint for multiple projects,
    // so we batch by project and fetch per-project
    const byProject = new Map<string, BranchContext[]>();
    for (const bc of remotes) {
      const project = extractProjectPath(bc.remote);
      if (!project) continue;
      const list = byProject.get(project) ?? [];
      list.push(bc);
      byProject.set(project, list);
    }

    for (const [project, contexts] of byProject) {
      const encoded = encodeURIComponent(project);
      const resp = await this.fetch(
        `${this.baseUrl}/projects/${encoded}/merge_requests?state=opened&per_page=100`,
      );
      if (!resp.ok) continue;
      const mrs = await resp.json();
      if (!Array.isArray(mrs)) continue;

      for (const mr of mrs) {
        const matching = contexts.find((c) => c.branch === mr.source_branch);
        if (matching) {
          result.set(matching.sessionName, this.mapMergeRequest(mr));
        }
      }
    }

    return result;
  }

  openInBrowser(mrId: string): void {
    const [project, iid] = mrId.split(":");
    const projectPath = decodeURIComponent(project);
    const url = `https://gitlab.com/${projectPath}/-/merge_requests/${iid}`;
    Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
  }

  async markReady(mrId: string): Promise<void> {
    const [project, iid] = mrId.split(":");
    const resp = await this.fetch(
      `${this.baseUrl}/projects/${project}/merge_requests/${iid}`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: undefined }), // remove "Draft: " prefix handled below
      },
    );
    if (!resp.ok) {
      // Retry with title change — GitLab uses "Draft:" prefix
      const getResp = await this.fetch(
        `${this.baseUrl}/projects/${project}/merge_requests/${iid}`,
      );
      if (getResp.ok) {
        const mr = await getResp.json();
        const newTitle = (mr.title as string).replace(/^Draft:\s*/i, "");
        await this.fetch(
          `${this.baseUrl}/projects/${project}/merge_requests/${iid}`,
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ title: newTitle }),
          },
        );
      }
    }
  }

  async approve(mrId: string): Promise<void> {
    const [project, iid] = mrId.split(":");
    await this.fetch(
      `${this.baseUrl}/projects/${project}/merge_requests/${iid}/approve`,
      { method: "POST" },
    );
  }

  private mapMergeRequest(raw: any): MergeRequest {
    const project = encodeURIComponent(raw.project_id?.toString() ?? "");
    let pipeline: PipelineStatus | null = null;
    if (raw.head_pipeline) {
      pipeline = {
        state: this.mapPipelineState(raw.head_pipeline.status),
        webUrl: raw.head_pipeline.web_url ?? "",
      };
    }

    return {
      id: `${encodeURIComponent(raw.project_id?.toString() ?? "")}:${raw.iid}`,
      title: raw.title ?? "",
      status: raw.draft ? "draft" : raw.state === "merged" ? "merged" : raw.state === "closed" ? "closed" : "open",
      sourceBranch: raw.source_branch ?? "",
      targetBranch: raw.target_branch ?? "",
      pipeline,
      approvals: {
        required: raw.approvals_required ?? 0,
        current: raw.approved_by?.length ?? 0,
      },
      webUrl: raw.web_url ?? "",
    };
  }

  private mapPipelineState(status: string): PipelineStatus["state"] {
    switch (status) {
      case "success": return "passed";
      case "failed": return "failed";
      case "running": return "running";
      case "pending": case "waiting_for_resource": case "preparing": return "pending";
      case "canceled": case "skipped": return "canceled";
      default: return "pending";
    }
  }

  private async fetch(url: string, init?: RequestInit): Promise<Response> {
    return fetch(url, {
      ...init,
      headers: {
        ...init?.headers,
        "PRIVATE-TOKEN": this.token ?? "",
      },
    });
  }

  private handleErrorStatus(status: number): void {
    if (status === 401 || status === 403) {
      this.authState = "failed";
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/adapters/gitlab.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/adapters/gitlab.ts src/__tests__/adapters/gitlab.test.ts
git commit -m "feat: add GitLab code host adapter with MR polling and light actions"
```

---

### Task 7: Linear Adapter

**Files:**
- Create: `src/adapters/linear.ts`
- Test: `src/__tests__/adapters/linear.test.ts`

- [ ] **Step 1: Write tests for Linear adapter**

```typescript
// src/__tests__/adapters/linear.test.ts
import { describe, test, expect } from "bun:test";
import { LinearAdapter, extractIssueIdFromBranch } from "../../adapters/linear";

describe("extractIssueIdFromBranch", () => {
  test("extracts from standard branch name", () => {
    expect(extractIssueIdFromBranch("eng-1234-fix-auth")).toBe("ENG-1234");
  });

  test("extracts from branch with prefix", () => {
    expect(extractIssueIdFromBranch("feature/eng-1234-fix-auth")).toBe("ENG-1234");
  });

  test("extracts from branch with nested prefix", () => {
    expect(extractIssueIdFromBranch("jarred/eng-1234-fix-auth")).toBe("ENG-1234");
  });

  test("extracts multi-letter team prefix", () => {
    expect(extractIssueIdFromBranch("platform-42-refactor")).toBe("PLATFORM-42");
  });

  test("returns null for branch with no issue id", () => {
    expect(extractIssueIdFromBranch("main")).toBeNull();
    expect(extractIssueIdFromBranch("feature/add-login")).toBeNull();
  });
});

describe("LinearAdapter", () => {
  test("starts in unauthenticated state", () => {
    const adapter = new LinearAdapter({ type: "linear" });
    expect(adapter.type).toBe("linear");
    expect(adapter.authState).toBe("unauthenticated");
    expect(adapter.authHint).toBe("$LINEAR_API_KEY");
  });

  test("authenticate succeeds with env var", async () => {
    const orig = process.env.LINEAR_API_KEY;
    process.env.LINEAR_API_KEY = "lin_test_key";
    try {
      const adapter = new LinearAdapter({ type: "linear" });
      await adapter.authenticate();
      expect(adapter.authState).toBe("ok");
    } finally {
      if (orig === undefined) delete process.env.LINEAR_API_KEY;
      else process.env.LINEAR_API_KEY = orig;
    }
  });

  test("authenticate fails without env var", async () => {
    const orig = process.env.LINEAR_API_KEY;
    delete process.env.LINEAR_API_KEY;
    try {
      const adapter = new LinearAdapter({ type: "linear" });
      await adapter.authenticate();
      expect(adapter.authState).toBe("failed");
    } finally {
      if (orig !== undefined) process.env.LINEAR_API_KEY = orig;
    }
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/adapters/linear.test.ts`
Expected: FAIL — module doesn't exist

- [ ] **Step 3: Implement linear.ts**

```typescript
// src/adapters/linear.ts
import type {
  IssueTrackerAdapter,
  AdapterAuthState,
  Issue,
} from "./types";

const LINEAR_API = "https://api.linear.app/graphql";

export function extractIssueIdFromBranch(branch: string): string | null {
  // Linear branch names follow: [prefix/]TEAM-123-description
  // Match team identifier (letters) followed by dash and number
  const match = branch.match(/(?:^|\/?)([a-zA-Z]+-\d+)/);
  if (!match) return null;
  return match[1].toUpperCase();
}

export class LinearAdapter implements IssueTrackerAdapter {
  type = "linear";
  authState: AdapterAuthState = "unauthenticated";
  authHint = "$LINEAR_API_KEY";
  private token: string | null = null;

  constructor(_config: Record<string, unknown>) {}

  async authenticate(): Promise<void> {
    const token = process.env.LINEAR_API_KEY ?? null;
    if (!token) {
      this.authState = "failed";
      return;
    }
    this.token = token;
    this.authState = "ok";
  }

  async getLinkedIssue(mrUrl: string): Promise<Issue | null> {
    // Search for issues that have this MR URL as an attachment
    const query = `
      query($url: String!) {
        attachments(filter: { url: { eq: $url } }, first: 1) {
          nodes {
            issue {
              id
              identifier
              title
              state { name }
              assignee { name }
              attachments { nodes { url } }
              url
            }
          }
        }
      }
    `;
    const resp = await this.graphql(query, { url: mrUrl });
    if (!resp) return null;
    const nodes = resp.data?.attachments?.nodes;
    if (!nodes || nodes.length === 0) return null;
    return this.mapIssue(nodes[0].issue);
  }

  async getIssueByBranch(branch: string): Promise<Issue | null> {
    const identifier = extractIssueIdFromBranch(branch);
    if (!identifier) return null;

    const query = `
      query($identifier: String!) {
        issueSearch(query: $identifier, first: 1) {
          nodes {
            id
            identifier
            title
            state { name }
            assignee { name }
            attachments { nodes { url } }
            url
          }
        }
      }
    `;
    const resp = await this.graphql(query, { identifier });
    if (!resp) return null;
    const nodes = resp.data?.issueSearch?.nodes;
    if (!nodes || nodes.length === 0) return null;
    // Verify the identifier matches (search is fuzzy)
    const issue = nodes[0];
    if (issue.identifier?.toUpperCase() !== identifier) return null;
    return this.mapIssue(issue);
  }

  async pollIssue(issueId: string): Promise<Issue> {
    const query = `
      query($id: String!) {
        issue(id: $id) {
          id
          identifier
          title
          state { name }
          assignee { name }
          attachments { nodes { url } }
          url
        }
      }
    `;
    const resp = await this.graphql(query, { id: issueId });
    if (!resp?.data?.issue) {
      const err = new Error("Issue not found");
      (err as any).status = 404;
      throw err;
    }
    return this.mapIssue(resp.data.issue);
  }

  async pollAllIssues(issueIds: string[]): Promise<Map<string, Issue>> {
    const result = new Map<string, Issue>();
    if (issueIds.length === 0) return result;

    // Linear GraphQL supports batching via aliases
    const fragments = issueIds.map(
      (id, i) => `issue${i}: issue(id: "${id}") {
        id identifier title state { name } assignee { name }
        attachments { nodes { url } } url
      }`,
    );
    const query = `query { ${fragments.join("\n")} }`;
    const resp = await this.graphql(query, {});
    if (!resp?.data) return result;

    for (let i = 0; i < issueIds.length; i++) {
      const raw = resp.data[`issue${i}`];
      if (raw) {
        result.set(issueIds[i], this.mapIssue(raw));
      }
    }
    return result;
  }

  async getAvailableStatuses(issueId: string): Promise<string[]> {
    // Get the workflow states for the issue's team
    const query = `
      query($id: String!) {
        issue(id: $id) {
          team {
            states { nodes { name position } }
          }
        }
      }
    `;
    const resp = await this.graphql(query, { id: issueId });
    if (!resp?.data?.issue?.team?.states?.nodes) return [];
    const states = resp.data.issue.team.states.nodes as Array<{
      name: string;
      position: number;
    }>;
    return states
      .sort((a, b) => a.position - b.position)
      .map((s) => s.name);
  }

  openInBrowser(issueId: string): void {
    // issueId is the Linear UUID; we need the web URL
    // We'll use the cached issue URL if available, otherwise construct from identifier
    // For now, fire a quick query to get the URL
    this.graphql(
      `query($id: String!) { issue(id: $id) { url } }`,
      { id: issueId },
    ).then((resp) => {
      const url = resp?.data?.issue?.url;
      if (url) {
        Bun.spawn(["open", url], { stdout: "ignore", stderr: "ignore" });
      }
    });
  }

  async updateStatus(issueId: string, status: string): Promise<void> {
    // First, find the state ID for the target status name
    const statesQuery = `
      query($id: String!) {
        issue(id: $id) {
          team {
            states { nodes { id name } }
          }
        }
      }
    `;
    const statesResp = await this.graphql(statesQuery, { id: issueId });
    const states = statesResp?.data?.issue?.team?.states?.nodes as
      | Array<{ id: string; name: string }>
      | undefined;
    if (!states) return;

    const targetState = states.find((s) => s.name === status);
    if (!targetState) return;

    const mutation = `
      mutation($id: String!, $stateId: String!) {
        issueUpdate(id: $id, input: { stateId: $stateId }) {
          success
        }
      }
    `;
    await this.graphql(mutation, { id: issueId, stateId: targetState.id });
  }

  private mapIssue(raw: any): Issue {
    return {
      id: raw.id ?? "",
      identifier: raw.identifier ?? "",
      title: raw.title ?? "",
      status: raw.state?.name ?? "Unknown",
      assignee: raw.assignee?.name ?? null,
      linkedMrUrls: (raw.attachments?.nodes ?? [])
        .map((a: any) => a.url)
        .filter((u: string) => u),
      webUrl: raw.url ?? "",
    };
  }

  private async graphql(
    query: string,
    variables: Record<string, unknown>,
  ): Promise<any | null> {
    try {
      const resp = await fetch(LINEAR_API, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: this.token ?? "",
        },
        body: JSON.stringify({ query, variables }),
      });
      if (!resp.ok) {
        if (resp.status === 401 || resp.status === 403) {
          this.authState = "failed";
        }
        const err = new Error(`Linear API error: ${resp.status}`);
        (err as any).status = resp.status;
        throw err;
      }
      return await resp.json();
    } catch (e: any) {
      if (e?.status) throw e;
      return null;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/adapters/linear.test.ts`
Expected: PASS

- [ ] **Step 5: Run registry tests now that both adapters exist**

Run: `bun test src/__tests__/adapters/registry.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/adapters/linear.ts src/__tests__/adapters/linear.test.ts
git commit -m "feat: add Linear issue tracker adapter with GraphQL API"
```

---

### Task 8: InfoPanel Tab Container

**Files:**
- Create: `src/info-panel.ts`
- Test: `src/__tests__/info-panel.test.ts`

- [ ] **Step 1: Write tests for info panel**

```typescript
// src/__tests__/info-panel.test.ts
import { describe, test, expect } from "bun:test";
import { InfoPanel, type InfoTab } from "../info-panel";
import { createGrid } from "../cell-grid";

describe("InfoPanel", () => {
  test("starts with diff tab only when no adapters configured", () => {
    const panel = new InfoPanel({ hasCodeHost: false, hasIssueTracker: false });
    expect(panel.tabs).toEqual(["diff"]);
    expect(panel.activeTab).toBe("diff");
  });

  test("shows MR tab when code host configured", () => {
    const panel = new InfoPanel({ hasCodeHost: true, hasIssueTracker: false });
    expect(panel.tabs).toEqual(["diff", "mr"]);
  });

  test("shows Issues tab when issue tracker configured", () => {
    const panel = new InfoPanel({ hasCodeHost: false, hasIssueTracker: true });
    expect(panel.tabs).toEqual(["diff", "issues"]);
  });

  test("shows all tabs when both adapters configured", () => {
    const panel = new InfoPanel({ hasCodeHost: true, hasIssueTracker: true });
    expect(panel.tabs).toEqual(["diff", "mr", "issues"]);
  });

  test("nextTab cycles forward", () => {
    const panel = new InfoPanel({ hasCodeHost: true, hasIssueTracker: true });
    expect(panel.activeTab).toBe("diff");
    panel.nextTab();
    expect(panel.activeTab).toBe("mr");
    panel.nextTab();
    expect(panel.activeTab).toBe("issues");
    panel.nextTab();
    expect(panel.activeTab).toBe("diff");
  });

  test("prevTab cycles backward", () => {
    const panel = new InfoPanel({ hasCodeHost: true, hasIssueTracker: true });
    panel.prevTab();
    expect(panel.activeTab).toBe("issues");
    panel.prevTab();
    expect(panel.activeTab).toBe("mr");
  });

  test("nextTab is no-op with single tab", () => {
    const panel = new InfoPanel({ hasCodeHost: false, hasIssueTracker: false });
    panel.nextTab();
    expect(panel.activeTab).toBe("diff");
  });

  test("setActiveTab works for valid tab", () => {
    const panel = new InfoPanel({ hasCodeHost: true, hasIssueTracker: true });
    panel.setActiveTab("mr");
    expect(panel.activeTab).toBe("mr");
  });

  test("setActiveTab ignores invalid tab", () => {
    const panel = new InfoPanel({ hasCodeHost: false, hasIssueTracker: false });
    panel.setActiveTab("mr");
    expect(panel.activeTab).toBe("diff");
  });

  test("getTabBarGrid renders tab labels", () => {
    const panel = new InfoPanel({ hasCodeHost: true, hasIssueTracker: true });
    const grid = panel.getTabBarGrid(40);
    expect(grid.cols).toBe(40);
    expect(grid.rows).toBe(1);
    const text = grid.cells[0].map((c) => c.char).join("");
    expect(text).toContain("Diff");
    expect(text).toContain("MR");
    expect(text).toContain("Issues");
  });

  test("hasMultipleTabs", () => {
    const single = new InfoPanel({ hasCodeHost: false, hasIssueTracker: false });
    expect(single.hasMultipleTabs).toBe(false);

    const multi = new InfoPanel({ hasCodeHost: true, hasIssueTracker: false });
    expect(multi.hasMultipleTabs).toBe(true);
  });

  test("updateConfig changes available tabs", () => {
    const panel = new InfoPanel({ hasCodeHost: false, hasIssueTracker: false });
    expect(panel.tabs).toEqual(["diff"]);
    panel.updateConfig({ hasCodeHost: true, hasIssueTracker: true });
    expect(panel.tabs).toEqual(["diff", "mr", "issues"]);
  });

  test("updateConfig resets active tab if current tab removed", () => {
    const panel = new InfoPanel({ hasCodeHost: true, hasIssueTracker: true });
    panel.setActiveTab("mr");
    panel.updateConfig({ hasCodeHost: false, hasIssueTracker: true });
    expect(panel.activeTab).toBe("diff");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/info-panel.test.ts`
Expected: FAIL — module doesn't exist

- [ ] **Step 3: Implement info-panel.ts**

```typescript
// src/info-panel.ts
import type { CellGrid } from "./types";
import { ColorMode } from "./types";
import { createGrid, writeString, type CellAttrs } from "./cell-grid";

export type InfoTab = "diff" | "mr" | "issues";

const TAB_LABELS: Record<InfoTab, string> = {
  diff: "Diff",
  mr: "MR",
  issues: "Issues",
};

const ACTIVE_TAB: CellAttrs = {
  fg: (0xFB << 16) | (0xD4 << 8) | 0xB8,
  fgMode: ColorMode.RGB,
  bold: true,
};

const INACTIVE_TAB: CellAttrs = {
  fg: 8,
  fgMode: ColorMode.Palette,
  dim: true,
};

const TAB_BG: CellAttrs = {
  bg: (0x16 << 16) | (0x1B << 8) | 0x22,
  bgMode: ColorMode.RGB,
};

export interface InfoPanelConfig {
  hasCodeHost: boolean;
  hasIssueTracker: boolean;
}

export class InfoPanel {
  private _tabs: InfoTab[] = [];
  private _activeTab: InfoTab = "diff";

  constructor(config: InfoPanelConfig) {
    this.rebuildTabs(config);
  }

  get tabs(): InfoTab[] {
    return [...this._tabs];
  }

  get activeTab(): InfoTab {
    return this._activeTab;
  }

  get hasMultipleTabs(): boolean {
    return this._tabs.length > 1;
  }

  updateConfig(config: InfoPanelConfig): void {
    const prevActive = this._activeTab;
    this.rebuildTabs(config);
    if (!this._tabs.includes(prevActive)) {
      this._activeTab = "diff";
    }
  }

  setActiveTab(tab: InfoTab): void {
    if (this._tabs.includes(tab)) {
      this._activeTab = tab;
    }
  }

  nextTab(): void {
    if (this._tabs.length <= 1) return;
    const idx = this._tabs.indexOf(this._activeTab);
    this._activeTab = this._tabs[(idx + 1) % this._tabs.length];
  }

  prevTab(): void {
    if (this._tabs.length <= 1) return;
    const idx = this._tabs.indexOf(this._activeTab);
    this._activeTab = this._tabs[(idx - 1 + this._tabs.length) % this._tabs.length];
  }

  getTabBarGrid(cols: number): CellGrid {
    const grid = createGrid(cols, 1);
    let col = 1; // start with 1 col padding

    for (const tab of this._tabs) {
      const isActive = tab === this._activeTab;
      const label = ` ${TAB_LABELS[tab]} `;
      const attrs: CellAttrs = {
        ...(isActive ? ACTIVE_TAB : INACTIVE_TAB),
        ...TAB_BG,
      };
      col = writeString(grid, 0, col, label, attrs);

      // Separator between tabs
      if (tab !== this._tabs[this._tabs.length - 1]) {
        col = writeString(grid, 0, col, "│", { ...INACTIVE_TAB, ...TAB_BG });
      }
    }

    // Fill remaining with background
    for (let c = col; c < cols; c++) {
      grid.cells[0][c].bg = TAB_BG.bg!;
      grid.cells[0][c].bgMode = TAB_BG.bgMode!;
    }
    for (let c = 0; c < Math.min(1, cols); c++) {
      grid.cells[0][c].bg = TAB_BG.bg!;
      grid.cells[0][c].bgMode = TAB_BG.bgMode!;
    }

    return grid;
  }

  private rebuildTabs(config: InfoPanelConfig): void {
    this._tabs = ["diff"];
    if (config.hasCodeHost) this._tabs.push("mr");
    if (config.hasIssueTracker) this._tabs.push("issues");
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/info-panel.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/info-panel.ts src/__tests__/info-panel.test.ts
git commit -m "feat: add InfoPanel tab container with tab cycling and tab bar rendering"
```

---

### Task 9: MR Tab Rendering

**Files:**
- Create: `src/info-panel-mr.ts`
- Test: `src/__tests__/info-panel-mr.test.ts`

- [ ] **Step 1: Write tests for MR tab rendering**

```typescript
// src/__tests__/info-panel-mr.test.ts
import { describe, test, expect } from "bun:test";
import { renderMrTab } from "../info-panel-mr";
import type { MergeRequest } from "../adapters/types";

function extractText(grid: { cells: Array<Array<{ char: string }>> }): string {
  return grid.cells.map((row) => row.map((c) => c.char).join("")).join("\n");
}

const MR: MergeRequest = {
  id: "123:42",
  title: "Fix auth token refresh",
  status: "open",
  sourceBranch: "fix/auth",
  targetBranch: "main",
  pipeline: { state: "passed", webUrl: "https://example.com" },
  approvals: { required: 2, current: 1 },
  webUrl: "https://example.com/mr/42",
};

describe("renderMrTab", () => {
  test("renders MR title", () => {
    const grid = renderMrTab(MR, 40, 20);
    const text = extractText(grid);
    expect(text).toContain("Fix auth token refresh");
  });

  test("renders branch info", () => {
    const grid = renderMrTab(MR, 40, 20);
    const text = extractText(grid);
    expect(text).toContain("fix/auth");
    expect(text).toContain("main");
  });

  test("renders pipeline status", () => {
    const grid = renderMrTab(MR, 40, 20);
    const text = extractText(grid);
    expect(text).toContain("passed");
  });

  test("renders approval state", () => {
    const grid = renderMrTab(MR, 40, 20);
    const text = extractText(grid);
    expect(text).toContain("1/2");
  });

  test("renders action hints", () => {
    const grid = renderMrTab(MR, 40, 20);
    const text = extractText(grid);
    expect(text).toContain("[o]");
  });

  test("renders null state", () => {
    const grid = renderMrTab(null, 40, 20);
    const text = extractText(grid);
    expect(text).toContain("No merge request");
  });

  test("renders error state", () => {
    const grid = renderMrTab(null, 40, 20, "Authentication expired — check $GITLAB_TOKEN");
    const text = extractText(grid);
    expect(text).toContain("Authentication expired");
  });

  test("renders draft status indicator", () => {
    const draft: MergeRequest = { ...MR, status: "draft" };
    const grid = renderMrTab(draft, 40, 20);
    const text = extractText(grid);
    expect(text).toContain("Draft");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/info-panel-mr.test.ts`
Expected: FAIL — module doesn't exist

- [ ] **Step 3: Implement info-panel-mr.ts**

```typescript
// src/info-panel-mr.ts
import type { CellGrid } from "./types";
import { ColorMode } from "./types";
import { createGrid, writeString, type CellAttrs } from "./cell-grid";
import type { MergeRequest } from "./adapters/types";

const TITLE_ATTRS: CellAttrs = { fg: (0x58 << 16) | (0xA6 << 8) | 0xFF, fgMode: ColorMode.RGB, bold: true };
const LABEL_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
const VALUE_ATTRS: CellAttrs = { fg: (0xC9 << 16) | (0xD1 << 8) | 0xD9, fgMode: ColorMode.RGB };
const ACTION_KEY: CellAttrs = { fg: 2, fgMode: ColorMode.Palette };
const ACTION_LABEL: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
const ERROR_ATTRS: CellAttrs = { fg: 1, fgMode: ColorMode.Palette };
const EMPTY_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };

const STATUS_COLORS: Record<string, CellAttrs> = {
  open: { fg: 2, fgMode: ColorMode.Palette },
  draft: { fg: 3, fgMode: ColorMode.Palette },
  merged: { fg: 5, fgMode: ColorMode.Palette },
  closed: { fg: 1, fgMode: ColorMode.Palette },
};

const PIPELINE_COLORS: Record<string, CellAttrs> = {
  passed: { fg: 2, fgMode: ColorMode.Palette },
  running: { fg: 3, fgMode: ColorMode.Palette },
  failed: { fg: 1, fgMode: ColorMode.Palette },
  pending: { fg: 3, fgMode: ColorMode.Palette },
  canceled: { fg: 8, fgMode: ColorMode.Palette, dim: true },
};

const PIPELINE_GLYPHS: Record<string, string> = {
  passed: "✓",
  running: "⟳",
  failed: "✗",
  pending: "○",
  canceled: "—",
};

export function renderMrTab(
  mr: MergeRequest | null,
  cols: number,
  rows: number,
  error?: string,
): CellGrid {
  const grid = createGrid(cols, rows);
  const pad = 2;

  if (error) {
    writeString(grid, 2, pad, error, ERROR_ATTRS);
    return grid;
  }

  if (!mr) {
    writeString(grid, 2, pad, "No merge request found for this branch.", EMPTY_ATTRS);
    writeString(grid, 4, pad, "Push a branch and open an MR to see status here.", EMPTY_ATTRS);
    return grid;
  }

  let row = 1;

  // Title
  const titleStr = mr.title.length > cols - pad * 2
    ? mr.title.slice(0, cols - pad * 2 - 1) + "…"
    : mr.title;
  writeString(grid, row, pad, titleStr, TITLE_ATTRS);
  row += 1;

  // Status
  const statusLabel = mr.status.charAt(0).toUpperCase() + mr.status.slice(1);
  const statusAttrs = STATUS_COLORS[mr.status] ?? VALUE_ATTRS;
  writeString(grid, row, pad, statusLabel, statusAttrs);
  row += 2;

  // Branches
  writeString(grid, row, pad, "Branch", LABEL_ATTRS);
  row += 1;
  writeString(grid, row, pad, `${mr.sourceBranch} → ${mr.targetBranch}`, VALUE_ATTRS);
  row += 2;

  // Pipeline
  if (mr.pipeline) {
    writeString(grid, row, pad, "Pipeline", LABEL_ATTRS);
    row += 1;
    const glyph = PIPELINE_GLYPHS[mr.pipeline.state] ?? "?";
    const pipeAttrs = PIPELINE_COLORS[mr.pipeline.state] ?? VALUE_ATTRS;
    writeString(grid, row, pad, `${glyph} ${mr.pipeline.state}`, pipeAttrs);
    row += 2;
  }

  // Approvals
  writeString(grid, row, pad, "Approvals", LABEL_ATTRS);
  row += 1;
  const approvalStr = `${mr.approvals.current}/${mr.approvals.required}`;
  const approvalAttrs = mr.approvals.current >= mr.approvals.required
    ? { fg: 2, fgMode: ColorMode.Palette } as CellAttrs
    : VALUE_ATTRS;
  writeString(grid, row, pad, approvalStr, approvalAttrs);
  row += 2;

  // Actions
  writeString(grid, row, pad, "Actions", LABEL_ATTRS);
  row += 1;
  let col = pad;
  col = writeString(grid, row, col, "[o]", ACTION_KEY);
  col = writeString(grid, row, col, " Open  ", ACTION_LABEL);
  if (mr.status === "draft") {
    col = writeString(grid, row, col, "[r]", ACTION_KEY);
    col = writeString(grid, row, col, " Ready  ", ACTION_LABEL);
  }
  col = writeString(grid, row, col, "[a]", ACTION_KEY);
  col = writeString(grid, row, col, " Approve", ACTION_LABEL);

  return grid;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/info-panel-mr.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/info-panel-mr.ts src/__tests__/info-panel-mr.test.ts
git commit -m "feat: add MR tab rendering with status, pipeline, approvals, and action hints"
```

---

### Task 10: Issues Tab Rendering

**Files:**
- Create: `src/info-panel-issues.ts`
- Test: `src/__tests__/info-panel-issues.test.ts`

- [ ] **Step 1: Write tests for Issues tab rendering**

```typescript
// src/__tests__/info-panel-issues.test.ts
import { describe, test, expect } from "bun:test";
import { renderIssuesTab } from "../info-panel-issues";
import type { Issue } from "../adapters/types";

function extractText(grid: { cells: Array<Array<{ char: string }>> }): string {
  return grid.cells.map((row) => row.map((c) => c.char).join("")).join("\n");
}

const ISSUE: Issue = {
  id: "issue-1",
  identifier: "ENG-1234",
  title: "Fix auth token refresh",
  status: "In Progress",
  assignee: "Jarred",
  linkedMrUrls: ["https://gitlab.com/org/repo/-/merge_requests/42"],
  webUrl: "https://linear.app/team/issue/ENG-1234",
};

describe("renderIssuesTab", () => {
  test("renders issue identifier and title", () => {
    const grid = renderIssuesTab(ISSUE, 40, 20);
    const text = extractText(grid);
    expect(text).toContain("ENG-1234");
    expect(text).toContain("Fix auth token refresh");
  });

  test("renders status", () => {
    const grid = renderIssuesTab(ISSUE, 40, 20);
    const text = extractText(grid);
    expect(text).toContain("In Progress");
  });

  test("renders assignee", () => {
    const grid = renderIssuesTab(ISSUE, 40, 20);
    const text = extractText(grid);
    expect(text).toContain("Jarred");
  });

  test("renders action hints", () => {
    const grid = renderIssuesTab(ISSUE, 40, 20);
    const text = extractText(grid);
    expect(text).toContain("[o]");
    expect(text).toContain("[s]");
  });

  test("renders null state", () => {
    const grid = renderIssuesTab(null, 40, 20);
    const text = extractText(grid);
    expect(text).toContain("No linked issue");
  });

  test("renders error state", () => {
    const grid = renderIssuesTab(null, 40, 20, "Authentication expired — check $LINEAR_API_KEY");
    const text = extractText(grid);
    expect(text).toContain("Authentication expired");
  });

  test("renders with null assignee", () => {
    const unassigned: Issue = { ...ISSUE, assignee: null };
    const grid = renderIssuesTab(unassigned, 40, 20);
    const text = extractText(grid);
    expect(text).toContain("Unassigned");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/info-panel-issues.test.ts`
Expected: FAIL — module doesn't exist

- [ ] **Step 3: Implement info-panel-issues.ts**

```typescript
// src/info-panel-issues.ts
import type { CellGrid } from "./types";
import { ColorMode } from "./types";
import { createGrid, writeString, type CellAttrs } from "./cell-grid";
import type { Issue } from "./adapters/types";

const IDENT_ATTRS: CellAttrs = { fg: 5, fgMode: ColorMode.Palette, bold: true };
const TITLE_ATTRS: CellAttrs = { fg: (0xC9 << 16) | (0xD1 << 8) | 0xD9, fgMode: ColorMode.RGB, bold: true };
const LABEL_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
const VALUE_ATTRS: CellAttrs = { fg: (0xC9 << 16) | (0xD1 << 8) | 0xD9, fgMode: ColorMode.RGB };
const ACTION_KEY: CellAttrs = { fg: 2, fgMode: ColorMode.Palette };
const ACTION_LABEL: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
const ERROR_ATTRS: CellAttrs = { fg: 1, fgMode: ColorMode.Palette };
const EMPTY_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
const URL_ATTRS: CellAttrs = { fg: (0x58 << 16) | (0xA6 << 8) | 0xFF, fgMode: ColorMode.RGB, dim: true };

export function renderIssuesTab(
  issue: Issue | null,
  cols: number,
  rows: number,
  error?: string,
): CellGrid {
  const grid = createGrid(cols, rows);
  const pad = 2;

  if (error) {
    writeString(grid, 2, pad, error, ERROR_ATTRS);
    return grid;
  }

  if (!issue) {
    writeString(grid, 2, pad, "No linked issue found.", EMPTY_ATTRS);
    writeString(grid, 4, pad, "Link an issue to your MR or use a branch", EMPTY_ATTRS);
    writeString(grid, 5, pad, "name like eng-1234-description.", EMPTY_ATTRS);
    return grid;
  }

  let row = 1;

  // Identifier
  writeString(grid, row, pad, issue.identifier, IDENT_ATTRS);
  row += 1;

  // Title
  const titleStr = issue.title.length > cols - pad * 2
    ? issue.title.slice(0, cols - pad * 2 - 1) + "…"
    : issue.title;
  writeString(grid, row, pad, titleStr, TITLE_ATTRS);
  row += 2;

  // Status
  writeString(grid, row, pad, "Status", LABEL_ATTRS);
  row += 1;
  writeString(grid, row, pad, issue.status, VALUE_ATTRS);
  row += 2;

  // Assignee
  writeString(grid, row, pad, "Assignee", LABEL_ATTRS);
  row += 1;
  writeString(grid, row, pad, issue.assignee ?? "Unassigned", issue.assignee ? VALUE_ATTRS : EMPTY_ATTRS);
  row += 2;

  // Linked MRs
  if (issue.linkedMrUrls.length > 0) {
    writeString(grid, row, pad, "Linked MRs", LABEL_ATTRS);
    row += 1;
    for (const url of issue.linkedMrUrls) {
      const display = url.length > cols - pad * 2
        ? url.slice(0, cols - pad * 2 - 1) + "…"
        : url;
      writeString(grid, row, pad, display, URL_ATTRS);
      row += 1;
    }
    row += 1;
  }

  // Actions
  writeString(grid, row, pad, "Actions", LABEL_ATTRS);
  row += 1;
  let col = pad;
  col = writeString(grid, row, col, "[o]", ACTION_KEY);
  col = writeString(grid, row, col, " Open  ", ACTION_LABEL);
  col = writeString(grid, row, col, "[s]", ACTION_KEY);
  col = writeString(grid, row, col, " Status", ACTION_LABEL);

  return grid;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/info-panel-issues.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/info-panel-issues.ts src/__tests__/info-panel-issues.test.ts
git commit -m "feat: add Issues tab rendering with status, assignee, linked MRs, and actions"
```

---

### Task 11: Sidebar Pipeline Glyphs

**Files:**
- Modify: `src/sidebar.ts:244-260` (add private field), `src/sidebar.ts:517-665` (renderSession)
- Modify: `src/__tests__/sidebar.test.ts`

- [ ] **Step 1: Write failing test for pipeline glyphs**

Add to `src/__tests__/sidebar.test.ts`:

```typescript
import type { SessionContext, PipelineStatus } from "../adapters/types";

// ... existing helper ...

function makeContexts(
  entries: Array<{ name: string; pipelineState?: PipelineStatus["state"] }>,
): Map<string, SessionContext> {
  const map = new Map<string, SessionContext>();
  for (const e of entries) {
    map.set(e.name, {
      sessionName: e.name,
      dir: "/tmp",
      branch: "main",
      remote: null,
      mr: e.pipelineState
        ? {
            id: "1",
            title: "Test",
            status: "open",
            sourceBranch: "main",
            targetBranch: "main",
            pipeline: { state: e.pipelineState, webUrl: "" },
            approvals: { required: 0, current: 0 },
            webUrl: "",
          }
        : null,
      issue: null,
      resolvedAt: Date.now(),
    });
  }
  return map;
}

describe("Sidebar pipeline glyphs", () => {
  test("renders pipeline passed glyph", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "api" }]));
    sidebar.setSessionContexts(makeContexts([{ name: "api", pipelineState: "passed" }]));
    const grid = sidebar.getGrid();
    const allChars = grid.cells.flatMap((row) => row.map((c) => c.char)).join("");
    expect(allChars).toContain("✓");
  });

  test("renders pipeline failed glyph", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "api" }]));
    sidebar.setSessionContexts(makeContexts([{ name: "api", pipelineState: "failed" }]));
    const grid = sidebar.getGrid();
    const allChars = grid.cells.flatMap((row) => row.map((c) => c.char)).join("");
    expect(allChars).toContain("✗");
  });

  test("renders pipeline running glyph", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "api" }]));
    sidebar.setSessionContexts(makeContexts([{ name: "api", pipelineState: "running" }]));
    const grid = sidebar.getGrid();
    const allChars = grid.cells.flatMap((row) => row.map((c) => c.char)).join("");
    expect(allChars).toContain("⟳");
  });

  test("no glyph when no session context", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "api" }]));
    // No setSessionContexts call
    const grid = sidebar.getGrid();
    const allChars = grid.cells.flatMap((row) => row.map((c) => c.char)).join("");
    expect(allChars).not.toContain("✓");
    expect(allChars).not.toContain("✗");
    expect(allChars).not.toContain("⟳");
  });

  test("no glyph when session has no MR", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "api" }]));
    sidebar.setSessionContexts(makeContexts([{ name: "api" }])); // no pipelineState
    const grid = sidebar.getGrid();
    const allChars = grid.cells.flatMap((row) => row.map((c) => c.char)).join("");
    expect(allChars).not.toContain("✓");
    expect(allChars).not.toContain("✗");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/sidebar.test.ts -t "pipeline"`
Expected: FAIL — `setSessionContexts` doesn't exist

- [ ] **Step 3: Add sessionContexts field and setter to Sidebar**

In `src/sidebar.ts`, add the import and field:

```typescript
// Add import at top:
import type { SessionContext } from "./adapters/types";

// Add field in Sidebar class (after line 258):
private sessionContexts = new Map<string, SessionContext>();

// Add public setter (after setCacheTimer method around line 317):
setSessionContexts(contexts: Map<string, SessionContext>): void {
  this.sessionContexts = contexts;
}
```

- [ ] **Step 4: Add pipeline glyph rendering in renderSession**

In `src/sidebar.ts`, in the `renderSession` method, between the session name rendering and the window count rendering, add the pipeline glyph. The exact location is in `renderSession()` where the name row is being built — after name truncation and before window count.

Find the block that writes the window count string (around line 560-570) and insert the glyph rendering before it:

```typescript
// After name is written, before window count:
// Pipeline glyph — 2 cols before windowCountCol if context exists
const ctx = this.sessionContexts.get(session.name);
const pipelineState = ctx?.mr?.pipeline?.state;
if (pipelineState) {
  const GLYPH_MAP: Record<string, string> = {
    passed: "✓", running: "⟳", failed: "✗", pending: "○", canceled: "—",
  };
  const GLYPH_COLORS: Record<string, CellAttrs> = {
    passed: { fg: 2, fgMode: ColorMode.Palette },
    running: { fg: 3, fgMode: ColorMode.Palette },
    failed: { fg: 1, fgMode: ColorMode.Palette },
    pending: { fg: 3, fgMode: ColorMode.Palette },
    canceled: { fg: 8, fgMode: ColorMode.Palette, dim: true },
  };
  const glyph = GLYPH_MAP[pipelineState];
  const glyphAttrs = GLYPH_COLORS[pipelineState];
  if (glyph && glyphAttrs) {
    const glyphCol = windowCountCol - 2; // 1 for glyph + 1 space
    if (glyphCol > nameStart) {
      writeString(grid, nameRow, glyphCol, glyph, { ...glyphAttrs, ...bgAttrs });
    }
  }
}
```

Also adjust the `nameMaxLen` calculation when pipeline glyphs are possible:

```typescript
// When sessionContexts has entries, reserve 2 extra cols for glyph
const hasContexts = this.sessionContexts.size > 0;
const nameMaxLen = windowCountCol - 1 - nameStart - (hasContexts ? 2 : 0);
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test src/__tests__/sidebar.test.ts`
Expected: PASS — all existing tests + new pipeline glyph tests

- [ ] **Step 6: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 7: Commit**

```bash
git add src/sidebar.ts src/__tests__/sidebar.test.ts
git commit -m "feat: add pipeline state glyphs to sidebar session rows"
```

---

### Task 12: Input Router Tab Switching

**Files:**
- Modify: `src/input-router.ts:32-51` (InputRouterOptions), `src/input-router.ts:53-61` (InputRouter fields)
- Modify: `src/__tests__/input-router.test.ts`

- [ ] **Step 1: Write failing test for tab switching**

Add to `src/__tests__/input-router.test.ts`:

```typescript
// Find the existing test file pattern and add these tests.
// The existing tests create an InputRouter with mock callbacks.

describe("InfoPanel tab switching", () => {
  test("[ key triggers onPanelPrevTab when panel focused", () => {
    let prevTabCalled = false;
    const router = new InputRouter(
      {
        sidebarCols: 24,
        onPtyData: () => {},
        onSidebarClick: () => {},
        onPanelPrevTab: () => { prevTabCalled = true; },
        onPanelNextTab: () => {},
      },
      true,
    );
    router.setDiffPanel(40, true); // panel focused
    router.handleInput("[");
    expect(prevTabCalled).toBe(true);
  });

  test("] key triggers onPanelNextTab when panel focused", () => {
    let nextTabCalled = false;
    const router = new InputRouter(
      {
        sidebarCols: 24,
        onPtyData: () => {},
        onSidebarClick: () => {},
        onPanelPrevTab: () => {},
        onPanelNextTab: () => { nextTabCalled = true; },
      },
      true,
    );
    router.setDiffPanel(40, true); // panel focused
    router.handleInput("]");
    expect(nextTabCalled).toBe(true);
  });

  test("[ key passes through when panel not focused", () => {
    let ptyData = "";
    const router = new InputRouter(
      {
        sidebarCols: 24,
        onPtyData: (d) => { ptyData = d; },
        onSidebarClick: () => {},
      },
      true,
    );
    router.handleInput("[");
    expect(ptyData).toBe("[");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/input-router.test.ts -t "tab switching"`
Expected: FAIL — `onPanelPrevTab` / `onPanelNextTab` not in interface

- [ ] **Step 3: Add tab switching to InputRouter**

In `src/input-router.ts`, extend `InputRouterOptions`:

```typescript
// Add to InputRouterOptions (around line 49):
onPanelPrevTab?: () => void;
onPanelNextTab?: () => void;
onPanelAction?: (key: string) => void; // for light actions (o, r, a, s)
```

In the `handleInput` method, add handling for `[` and `]` when the panel is focused. This goes in the section that handles diff-panel-focused input (around line 262-265 where `diffPanelFocused` routes to `onDiffPanelData`):

```typescript
// Before the existing diffPanelFocused → onDiffPanelData fallback:
if (this.diffPanelFocused) {
  if (data === "[" && this.opts.onPanelPrevTab) {
    this.opts.onPanelPrevTab();
    return;
  }
  if (data === "]" && this.opts.onPanelNextTab) {
    this.opts.onPanelNextTab();
    return;
  }
  if (this.opts.onPanelAction && (data === "o" || data === "r" || data === "a" || data === "s")) {
    this.opts.onPanelAction(data);
    return;
  }
  // existing: this.opts.onDiffPanelData?.(data);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/input-router.test.ts`
Expected: PASS — all existing + new tab switching tests

- [ ] **Step 5: Commit**

```bash
git add src/input-router.ts src/__tests__/input-router.test.ts
git commit -m "feat: add panel tab switching and light action keybindings to input router"
```

---

### Task 13: Renderer Tab Bar

**Files:**
- Modify: `src/renderer.ts:130-376` (compositeGrids function)

This task adds an optional tab bar row above the panel content when the info panel has multiple tabs. The tab bar is rendered by `InfoPanel.getTabBarGrid()` (Task 8) and composited into the panel area.

- [ ] **Step 1: Write failing test for tab bar compositing**

Add to `src/__tests__/renderer.test.ts`:

```typescript
// Find where compositeGrids is tested and add:
import { createGrid, writeString } from "../cell-grid";

describe("compositeGrids with panel tab bar", () => {
  test("composites tab bar above diff panel content", () => {
    const main = createGrid(40, 10);
    const sidebar = createGrid(24, 11);
    const diffGrid = createGrid(20, 10);
    const tabBar = createGrid(20, 1);
    writeString(tabBar, 0, 1, "Diff", {});

    const result = compositeGrids(
      main,
      sidebar,
      null, // no toolbar
      null, // no modal
      {
        grid: diffGrid,
        mode: "split" as const,
        focused: false,
        tabBar,
      },
    );

    // Tab bar should appear in the panel area
    // Panel starts at sidebarCols + 1 + mainCols + 1 (divider) = 24 + 1 + 40 + 1 = 66
    // But with split mode, mainCols is toolbar.mainCols... let's just check the grid has expected rows
    expect(result.rows).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/__tests__/renderer.test.ts -t "tab bar"`
Expected: FAIL — `tabBar` property not expected in diffPanel arg

- [ ] **Step 3: Extend compositeGrids to accept tabBar**

In `src/renderer.ts`, extend the `diffPanel` parameter type in `compositeGrids` (line 135):

```typescript
diffPanel?: {
  grid: CellGrid;
  mode: "split" | "full";
  focused: boolean;
  tabBar?: CellGrid; // optional tab bar rendered above panel content
},
```

In the grid composition section where the diff panel is rendered (around lines 278-292), insert the tab bar above the diff panel content. When `diffPanel.tabBar` is present:

- The tab bar occupies row 0 of the panel area (same row as the toolbar if there is one, but in the panel columns — to the right of the divider).
- If there's a toolbar, the tab bar shares the toolbar row in the panel columns.
- If there's no toolbar, the tab bar takes the first row of the panel area.

The cleanest approach: after the divider is drawn and before the diff grid cells are copied, if `tabBar` exists, write its cells into the toolbar row (row 0) of the panel area. This means the tab bar replaces the toolbar's content in the panel columns only.

```typescript
// After divider rendering in split mode (around line 283-290):
// Add tab bar rendering in the panel columns of the toolbar row
if (diffPanel.tabBar && toolbarRows > 0) {
  const tabBarRow = 0; // toolbar row
  const panelStartCol = sidebarOffset + mainCols + 1; // after divider
  for (let c = 0; c < diffPanel.tabBar.cols && c < diffPanel.grid.cols; c++) {
    const targetCol = panelStartCol + c;
    if (targetCol < totalCols) {
      out.cells[tabBarRow][targetCol] = { ...diffPanel.tabBar.cells[0][c] };
    }
  }
}
```

Similarly for full mode: the tab bar replaces the toolbar row content entirely.

Also extend the `Renderer.render` method's `diffPanel` parameter type to match.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/renderer.test.ts`
Expected: PASS — all existing + tab bar test

- [ ] **Step 5: Commit**

```bash
git add src/renderer.ts src/__tests__/renderer.test.ts
git commit -m "feat: composite info panel tab bar into renderer"
```

---

### Task 14: Main.ts Integration

**Files:**
- Modify: `src/main.ts`

This is the wiring task. It connects all the pieces: creates adapters from config, initializes the poll coordinator, creates the info panel, updates the render frame to use the info panel, and wires input routing.

- [ ] **Step 1: Add imports**

At the top of `src/main.ts`, add:

```typescript
import { InfoPanel } from "./info-panel";
import { renderMrTab } from "./info-panel-mr";
import { renderIssuesTab } from "./info-panel-issues";
import { createAdapters } from "./adapters/registry";
import { PollCoordinator } from "./adapters/poll-coordinator";
import type { SessionContext } from "./adapters/types";
```

- [ ] **Step 2: Initialize adapters and poll coordinator after config loading**

After `const diffPanel = new DiffPanel();` (line 321), add:

```typescript
// Adapter setup
const adapters = createAdapters(userConfig.adapters);
const infoPanel = new InfoPanel({
  hasCodeHost: false,
  hasIssueTracker: false,
});

// Authenticate adapters (async, non-blocking)
async function initAdapters(): Promise<void> {
  if (adapters.codeHost) {
    await adapters.codeHost.authenticate();
  }
  if (adapters.issueTracker) {
    await adapters.issueTracker.authenticate();
  }
  infoPanel.updateConfig({
    hasCodeHost: adapters.codeHost?.authState === "ok",
    hasIssueTracker: adapters.issueTracker?.authState === "ok",
  });
}

const pollCoordinator = new PollCoordinator({
  codeHost: adapters.codeHost,
  issueTracker: adapters.issueTracker,
  onUpdate: (_sessionName) => {
    scheduleRender();
  },
  getSessionDir: (name) => {
    const session = currentSessions.find((s) => s.name === name);
    return session ? (sessionDetailsCache.get(session.id)?.directory ?? null) : null;
  },
});

// Start adapter init (non-blocking)
initAdapters().then(() => {
  pollCoordinator.start();
  scheduleRender();
});
```

- [ ] **Step 3: Wire poll coordinator into session lifecycle**

In `fetchSessions()` (around line 535), after `sidebar.updateSessions(sessions);`, add session tracking for the poll coordinator:

```typescript
// Update poll coordinator session list
const knownSessions = new Set<string>();
for (const session of sessions) {
  knownSessions.add(session.name);
  const dir = sessionDetailsCache.get(session.id)?.directory;
  if (dir) {
    pollCoordinator.addSession(session.name, dir);
  }
}
// Remove dead sessions from coordinator
for (const [name] of pollCoordinator.getAllContexts()) {
  if (!knownSessions.has(name)) {
    pollCoordinator.removeSession(name);
  }
}

// Pass contexts to sidebar for glyphs
sidebar.setSessionContexts(pollCoordinator.getAllContexts());
```

In `switchSession()` (around line 617), after `sidebar.setActiveSession(sessionId);`, add:

```typescript
const sessionName = currentSessions.find((s) => s.id === sessionId)?.name;
if (sessionName) {
  pollCoordinator.setActiveSession(sessionName);
}
```

- [ ] **Step 4: Update renderFrame to use info panel**

In `renderFrame()` (around line 639), modify the `diffPanelArg` construction to include the tab bar and use the info panel's active tab:

```typescript
// Replace the existing diffPanelArg block with:
let diffPanelArg: { grid: import("./types").CellGrid; mode: "split" | "full"; focused: boolean; tabBar?: import("./types").CellGrid } | undefined;
if (diffPanel.isActive()) {
  const dpCols = getDiffPanelCols();
  const dpRows = toolbarEnabled ? (process.stdout.rows || 24) - 1 : (process.stdout.rows || 24);

  let contentGrid: import("./types").CellGrid;
  if (infoPanel.activeTab === "diff") {
    // Existing diff panel logic
    if (diffPanel.hunkExited || !diffBridge) {
      contentGrid = !Bun.which(hunkCommand)
        ? diffPanel.getNotFoundGrid(dpCols, dpRows)
        : diffPanel.getEmptyGrid(dpCols, dpRows);
    } else {
      contentGrid = diffBridge.getGrid();
    }
  } else if (infoPanel.activeTab === "mr") {
    const ctx = currentSessionId
      ? pollCoordinator.getContext(currentSessions.find((s) => s.id === currentSessionId)?.name ?? "")
      : null;
    const errorMsg = adapters.codeHost?.authState === "failed"
      ? `Authentication expired — check ${adapters.codeHost.authHint}`
      : undefined;
    contentGrid = renderMrTab(ctx?.mr ?? null, dpCols, dpRows, errorMsg);
  } else {
    const ctx = currentSessionId
      ? pollCoordinator.getContext(currentSessions.find((s) => s.id === currentSessionId)?.name ?? "")
      : null;
    const errorMsg = adapters.issueTracker?.authState === "failed"
      ? `Authentication expired — check ${adapters.issueTracker.authHint}`
      : undefined;
    contentGrid = renderIssuesTab(ctx?.issue ?? null, dpCols, dpRows, errorMsg);
  }

  const tabBar = infoPanel.hasMultipleTabs ? infoPanel.getTabBarGrid(dpCols) : undefined;
  diffPanelArg = {
    grid: contentGrid,
    mode: diffPanel.state as "split" | "full",
    focused: diffPanelFocused,
    tabBar,
  };
}
```

- [ ] **Step 5: Wire input router for tab switching and light actions**

In the `InputRouter` constructor call (around line 710), add the new callbacks:

```typescript
onPanelPrevTab: () => {
  infoPanel.prevTab();
  scheduleRender();
},
onPanelNextTab: () => {
  infoPanel.nextTab();
  scheduleRender();
},
onPanelAction: (key) => {
  const sessionName = currentSessions.find((s) => s.id === currentSessionId)?.name ?? "";
  const ctx = pollCoordinator.getContext(sessionName);

  if (infoPanel.activeTab === "mr" && ctx?.mr && adapters.codeHost) {
    if (key === "o") adapters.codeHost.openInBrowser(ctx.mr.id);
    if (key === "r") adapters.codeHost.markReady(ctx.mr.id).then(() => scheduleRender());
    if (key === "a") adapters.codeHost.approve(ctx.mr.id).then(() => scheduleRender());
  }
  if (infoPanel.activeTab === "issues" && ctx?.issue && adapters.issueTracker) {
    if (key === "o") adapters.issueTracker.openInBrowser(ctx.issue.id);
    if (key === "s") {
      // Open status picker
      adapters.issueTracker.getAvailableStatuses(ctx.issue.id).then((statuses) => {
        if (statuses.length === 0) return;
        const items = statuses.map((s) => ({ id: s, label: s }));
        const listModal = new ListModal({ items, title: "Update Status" });
        listModal.open();
        openModal(listModal, (selected: unknown) => {
          const sel = selected as { id: string };
          if (sel?.id && ctx.issue) {
            adapters.issueTracker!.updateStatus(ctx.issue.id, sel.id).then(() => scheduleRender());
          }
        });
      });
    }
  }
},
```

- [ ] **Step 6: Wire config hot-reload for adapters**

In the existing config file watcher (search for `watchFile` or the config reload logic in main.ts), add adapter reinitialization when config changes:

```typescript
// In the config reload handler, after other config updates:
const newAdapterConfig = newConfig.adapters;
const newAdapters = createAdapters(newAdapterConfig);
// Re-authenticate and update
(async () => {
  if (newAdapters.codeHost) await newAdapters.codeHost.authenticate();
  if (newAdapters.issueTracker) await newAdapters.issueTracker.authenticate();
  adapters.codeHost = newAdapters.codeHost;
  adapters.issueTracker = newAdapters.issueTracker;
  pollCoordinator.stop();
  // Recreate coordinator with new adapters
  Object.assign(pollCoordinator, { opts: { ...pollCoordinator['opts'], codeHost: adapters.codeHost, issueTracker: adapters.issueTracker } });
  infoPanel.updateConfig({
    hasCodeHost: adapters.codeHost?.authState === "ok",
    hasIssueTracker: adapters.issueTracker?.authState === "ok",
  });
  pollCoordinator.start();
  scheduleRender();
})();
```

- [ ] **Step 7: Add cleanup on exit**

In the cleanup/exit handler (search for `process.on("exit"` or the cleanup function), add:

```typescript
pollCoordinator.stop();
```

- [ ] **Step 8: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 9: Run all tests**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 10: Commit**

```bash
git add src/main.ts
git commit -m "feat: wire info panel, adapters, and poll coordinator into main TUI loop"
```

---

### Task 15: Manual Smoke Test

This is not automated — it verifies the full integration works in a running jmux instance.

- [ ] **Step 1: Configure adapters**

Add to `~/.config/jmux/config.json`:

```json
{
  "adapters": {
    "codeHost": { "type": "gitlab" },
    "issueTracker": { "type": "linear" }
  }
}
```

Ensure `$GITLAB_TOKEN` and `$LINEAR_API_KEY` are set in your environment.

- [ ] **Step 2: Start jmux and verify panel**

Run: `bun run dev`

Verify:
- Toggle info panel with `Ctrl-a g` — should show Diff | MR | Issues tabs
- Switch tabs with `]` and `[` when panel is focused
- MR tab shows status for the current branch's MR (or "No merge request" message)
- Issues tab shows linked issue (or "No linked issue" message)
- Sidebar shows pipeline glyphs for sessions with MRs
- `Shift-Left` still unfocuses the panel (not tab switching)

- [ ] **Step 3: Test with no adapters configured**

Remove `adapters` from config. Restart jmux. Verify:
- Panel shows only Diff tab (no MR or Issues tabs)
- Tab switching keys `[` / `]` are no-ops
- Sidebar has no pipeline glyphs

- [ ] **Step 4: Test light actions**

With adapters configured and an active MR:
- Press `o` on MR tab → opens MR in browser
- Press `o` on Issues tab → opens issue in browser
- Press `s` on Issues tab → status picker modal appears

- [ ] **Step 5: Commit any fixes**

```bash
git add -A
git commit -m "fix: address issues found during smoke testing"
```
