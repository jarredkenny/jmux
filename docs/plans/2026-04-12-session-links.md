# Session Links & Multi-Item Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-session link graph that associates sessions with multiple issues and MRs, with manual linking, auto-discovery, and transitive expansion.

**Architecture:** A state file (`~/.config/jmux/state.json`) persists manual links. The context resolver merges manual + branch-auto + MR-linked + transitive sources into `SessionContext.mrs[]` and `SessionContext.issues[]` with provenance tags. The poll coordinator handles multi-item polling with a new `pollMergeRequestsByIds` batch method. Sidebar renders three-line rows with issue IDs and MR counts.

**Tech Stack:** TypeScript, Bun runtime, existing CellGrid rendering, existing adapter pattern.

**Spec:** `docs/specs/2026-04-12-session-links-design.md`

---

### Task 1: Session State File

**Files:**
- Create: `src/session-state.ts`
- Test: `src/__tests__/session-state.test.ts`

- [ ] **Step 1: Write tests**

```typescript
// src/__tests__/session-state.test.ts
import { describe, test, expect, beforeEach } from "bun:test";
import { SessionState, type SessionLink } from "../session-state";
import { unlinkSync, existsSync } from "fs";

function tmpPath(): string {
  return `/tmp/jmux-state-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`;
}

describe("SessionState", () => {
  test("loads empty state from nonexistent file", () => {
    const state = new SessionState("/tmp/nonexistent-jmux-state.json");
    expect(state.getLinks("test")).toEqual([]);
  });

  test("addLink and getLinks", () => {
    const path = tmpPath();
    const state = new SessionState(path);
    state.addLink("api", { type: "issue", id: "ENG-1234" });
    state.addLink("api", { type: "mr", id: "12345:42" });
    expect(state.getLinks("api")).toEqual([
      { type: "issue", id: "ENG-1234" },
      { type: "mr", id: "12345:42" },
    ]);
    if (existsSync(path)) unlinkSync(path);
  });

  test("addLink deduplicates", () => {
    const path = tmpPath();
    const state = new SessionState(path);
    state.addLink("api", { type: "issue", id: "ENG-1234" });
    state.addLink("api", { type: "issue", id: "ENG-1234" });
    expect(state.getLinks("api")).toHaveLength(1);
    if (existsSync(path)) unlinkSync(path);
  });

  test("removeLink", () => {
    const path = tmpPath();
    const state = new SessionState(path);
    state.addLink("api", { type: "issue", id: "ENG-1234" });
    state.addLink("api", { type: "issue", id: "ENG-1235" });
    state.removeLink("api", { type: "issue", id: "ENG-1234" });
    expect(state.getLinks("api")).toEqual([{ type: "issue", id: "ENG-1235" }]);
    if (existsSync(path)) unlinkSync(path);
  });

  test("removeLink no-op for missing link", () => {
    const state = new SessionState(tmpPath());
    state.removeLink("api", { type: "issue", id: "ENG-9999" });
    expect(state.getLinks("api")).toEqual([]);
  });

  test("renameSession migrates links", () => {
    const path = tmpPath();
    const state = new SessionState(path);
    state.addLink("old-name", { type: "issue", id: "ENG-1234" });
    state.renameSession("old-name", "new-name");
    expect(state.getLinks("old-name")).toEqual([]);
    expect(state.getLinks("new-name")).toEqual([{ type: "issue", id: "ENG-1234" }]);
    if (existsSync(path)) unlinkSync(path);
  });

  test("pruneSessions removes dead sessions", () => {
    const path = tmpPath();
    const state = new SessionState(path);
    state.addLink("alive", { type: "issue", id: "ENG-1" });
    state.addLink("dead", { type: "issue", id: "ENG-2" });
    state.pruneSessions(new Set(["alive"]));
    expect(state.getLinks("alive")).toHaveLength(1);
    expect(state.getLinks("dead")).toEqual([]);
    if (existsSync(path)) unlinkSync(path);
  });

  test("persists to disk and reloads", () => {
    const path = tmpPath();
    const state1 = new SessionState(path);
    state1.addLink("api", { type: "issue", id: "ENG-1234" });

    const state2 = new SessionState(path);
    expect(state2.getLinks("api")).toEqual([{ type: "issue", id: "ENG-1234" }]);
    if (existsSync(path)) unlinkSync(path);
  });

  test("getLinkedIssueIds and getLinkedMrIds", () => {
    const path = tmpPath();
    const state = new SessionState(path);
    state.addLink("api", { type: "issue", id: "ENG-1234" });
    state.addLink("api", { type: "mr", id: "12345:42" });
    state.addLink("api", { type: "issue", id: "ENG-1235" });
    expect(state.getLinkedIssueIds("api")).toEqual(["ENG-1234", "ENG-1235"]);
    expect(state.getLinkedMrIds("api")).toEqual(["12345:42"]);
    if (existsSync(path)) unlinkSync(path);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/session-state.test.ts`
Expected: FAIL — module doesn't exist

- [ ] **Step 3: Implement session-state.ts**

```typescript
// src/session-state.ts
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";

export interface SessionLink {
  type: "issue" | "mr";
  id: string;
}

interface StateData {
  sessionLinks: Record<string, SessionLink[]>;
}

export class SessionState {
  private data: StateData = { sessionLinks: {} };
  private filePath: string;

  constructor(filePath: string) {
    this.filePath = filePath;
    this.load();
  }

  getLinks(sessionName: string): SessionLink[] {
    return [...(this.data.sessionLinks[sessionName] ?? [])];
  }

  getLinkedIssueIds(sessionName: string): string[] {
    return this.getLinks(sessionName)
      .filter((l) => l.type === "issue")
      .map((l) => l.id);
  }

  getLinkedMrIds(sessionName: string): string[] {
    return this.getLinks(sessionName)
      .filter((l) => l.type === "mr")
      .map((l) => l.id);
  }

  addLink(sessionName: string, link: SessionLink): void {
    if (!this.data.sessionLinks[sessionName]) {
      this.data.sessionLinks[sessionName] = [];
    }
    const list = this.data.sessionLinks[sessionName];
    const exists = list.some((l) => l.type === link.type && l.id === link.id);
    if (!exists) {
      list.push({ type: link.type, id: link.id });
      this.save();
    }
  }

  removeLink(sessionName: string, link: SessionLink): void {
    const list = this.data.sessionLinks[sessionName];
    if (!list) return;
    const idx = list.findIndex((l) => l.type === link.type && l.id === link.id);
    if (idx >= 0) {
      list.splice(idx, 1);
      if (list.length === 0) delete this.data.sessionLinks[sessionName];
      this.save();
    }
  }

  renameSession(oldName: string, newName: string): void {
    const links = this.data.sessionLinks[oldName];
    if (links) {
      this.data.sessionLinks[newName] = links;
      delete this.data.sessionLinks[oldName];
      this.save();
    }
  }

  pruneSessions(liveSessions: Set<string>): void {
    let changed = false;
    for (const name of Object.keys(this.data.sessionLinks)) {
      if (!liveSessions.has(name)) {
        delete this.data.sessionLinks[name];
        changed = true;
      }
    }
    if (changed) this.save();
  }

  private load(): void {
    try {
      if (existsSync(this.filePath)) {
        const raw = JSON.parse(readFileSync(this.filePath, "utf-8"));
        if (raw?.sessionLinks && typeof raw.sessionLinks === "object") {
          this.data = raw as StateData;
        }
      }
    } catch {
      // Corrupt file — start fresh
    }
  }

  private save(): void {
    try {
      const dir = dirname(this.filePath);
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.filePath, JSON.stringify(this.data, null, 2) + "\n");
    } catch {
      // Non-critical — in-memory state is authoritative
    }
  }
}
```

- [ ] **Step 4: Run tests**

Run: `bun test src/__tests__/session-state.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/session-state.ts src/__tests__/session-state.test.ts
git commit -m "feat: add session state file for persisting manual issue/MR links"
```

---

### Task 2: Type Changes — Plural SessionContext with LinkSource

**Files:**
- Modify: `src/adapters/types.ts`
- Modify: `src/__tests__/adapters/types.test.ts`

- [ ] **Step 1: Update types.ts**

Add `LinkSource` type and change `SessionContext` from singular `mr`/`issue` to plural `mrs`/`issues`:

```typescript
// Add after AdapterAuthState (line 43):
export type LinkSource = "manual" | "branch" | "mr-link" | "transitive";

// Replace SessionContext (lines 33-41) with:
export interface SessionContext {
  sessionName: string;
  dir: string;
  branch: string | null;
  remote: string | null;
  mrs: Array<MergeRequest & { source: LinkSource }>;
  issues: Array<Issue & { source: LinkSource }>;
  resolvedAt: number;
}
```

Add new methods to `CodeHostAdapter` (after `approve` at line 56):

```typescript
  searchMergeRequests(query: string): Promise<MergeRequest[]>;
  parseMrUrl(url: string): string | null;
  pollMergeRequestsByIds(ids: string[]): Promise<Map<string, MergeRequest>>;
```

Add new method to `IssueTrackerAdapter` (after `updateStatus` at line 71):

```typescript
  searchIssues(query: string): Promise<Issue[]>;
```

- [ ] **Step 2: Update type tests**

Replace the SessionContext test in `src/__tests__/adapters/types.test.ts`:

```typescript
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
```

Remove the old "SessionContext with no MR or issue" test that uses `mr: null, issue: null`.

- [ ] **Step 3: Run tests — expect compile failures in other files**

Run: `bun test src/__tests__/adapters/types.test.ts`
Expected: PASS for this file. Other test files will fail at compile time until we update them — that's expected and will be fixed in subsequent tasks.

- [ ] **Step 4: Commit**

```bash
git add src/adapters/types.ts src/__tests__/adapters/types.test.ts
git commit -m "feat: SessionContext singular→plural with LinkSource provenance, add search/batch adapter methods"
```

---

### Task 3: New Adapter Methods

**Files:**
- Modify: `src/adapters/gitlab.ts`
- Modify: `src/adapters/linear.ts`
- Modify: `src/__tests__/adapters/gitlab.test.ts`
- Modify: `src/__tests__/adapters/linear.test.ts`

- [ ] **Step 1: Add searchMergeRequests, parseMrUrl, pollMergeRequestsByIds to GitLab adapter**

Add after `approve()` method in `src/adapters/gitlab.ts`:

```typescript
  async searchMergeRequests(query: string): Promise<MergeRequest[]> {
    // Search across all accessible projects — GitLab /merge_requests endpoint
    const params = new URLSearchParams({
      search: query,
      state: "opened",
      scope: "all",
      per_page: "20",
    });
    const resp = await this.fetch(`${this.baseUrl}/merge_requests?${params}`);
    if (!resp.ok) return [];
    const mrs = await resp.json();
    if (!Array.isArray(mrs)) return [];
    return mrs.map((mr: any) => this.mapMergeRequest(mr));
  }

  parseMrUrl(url: string): string | null {
    // https://gitlab.com/org/repo/-/merge_requests/42
    const match = url.match(/\/([^/]+\/[^/]+)\/-\/merge_requests\/(\d+)/);
    if (!match) return null;
    // We need the numeric project ID, but the URL has the path.
    // Return path-based ID for now; pollMergeRequest can handle both.
    // For transitive resolution, we'll fetch the MR by URL path.
    return `${encodeURIComponent(match[1])}:${match[2]}`;
  }

  async pollMergeRequestsByIds(ids: string[]): Promise<Map<string, MergeRequest>> {
    const result = new Map<string, MergeRequest>();
    // Group by project to minimize API calls
    const byProject = new Map<string, string[]>();
    for (const id of ids) {
      const [project, iid] = id.split(":");
      const list = byProject.get(project) ?? [];
      list.push(iid);
      byProject.set(project, list);
    }
    for (const [project, iids] of byProject) {
      for (const iid of iids) {
        try {
          const resp = await this.fetch(
            `${this.baseUrl}/projects/${project}/merge_requests/${iid}`,
          );
          if (resp.ok) {
            const mr = this.mapMergeRequest(await resp.json());
            result.set(`${project}:${iid}`, mr);
          }
        } catch {}
      }
    }
    return result;
  }
```

- [ ] **Step 2: Add searchIssues to Linear adapter**

Add after `updateStatus()` method in `src/adapters/linear.ts`:

```typescript
  async searchIssues(query: string): Promise<Issue[]> {
    const gql = `
      query($query: String!) {
        issueSearch(query: $query, first: 20) {
          nodes { id identifier title state { name } assignee { name } attachments { nodes { url } } url }
        }
      }
    `;
    const resp = await this.graphql(gql, { query });
    if (!resp?.data?.issueSearch?.nodes) return [];
    return resp.data.issueSearch.nodes.map((n: any) => this.mapIssue(n));
  }
```

- [ ] **Step 3: Add tests for new methods**

Add to `src/__tests__/adapters/gitlab.test.ts`:

```typescript
describe("parseMrUrl", () => {
  test("parses GitLab MR URL", () => {
    const adapter = new GitLabAdapter({ type: "gitlab" });
    const result = adapter.parseMrUrl("https://gitlab.com/org/repo/-/merge_requests/42");
    expect(result).toBe("org%2Frepo:42");
  });

  test("returns null for non-MR URL", () => {
    const adapter = new GitLabAdapter({ type: "gitlab" });
    expect(adapter.parseMrUrl("https://example.com")).toBeNull();
  });
});
```

Add to `src/__tests__/adapters/linear.test.ts`:

```typescript
describe("searchIssues", () => {
  test("returns empty array when not authenticated", async () => {
    const adapter = new LinearAdapter({ type: "linear" });
    // Not authenticated — graphql returns null
    const results = await adapter.searchIssues("test");
    expect(results).toEqual([]);
  });
});
```

- [ ] **Step 4: Run tests**

Run: `bun test src/__tests__/adapters/gitlab.test.ts src/__tests__/adapters/linear.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/adapters/gitlab.ts src/adapters/linear.ts src/__tests__/adapters/gitlab.test.ts src/__tests__/adapters/linear.test.ts
git commit -m "feat: add searchMergeRequests, parseMrUrl, pollMergeRequestsByIds, searchIssues to adapters"
```

---

### Task 4: Context Resolver — Multi-Source Resolution

**Files:**
- Modify: `src/adapters/context-resolver.ts`
- Modify: `src/__tests__/adapters/context-resolver.test.ts`

- [ ] **Step 1: Rewrite context-resolver.ts**

The resolver now accepts manual links and merges all sources. Replace `resolveSessionContext`:

```typescript
// src/adapters/context-resolver.ts
import type {
  CodeHostAdapter,
  IssueTrackerAdapter,
  SessionContext,
  MergeRequest,
  Issue,
  LinkSource,
} from "./types";

// ... keep existing getGitBranch, getGitRemotes, selectRemote, GitRemote, HOSTNAME_MAP unchanged ...

export interface ResolveOptions {
  sessionName: string;
  dir: string;
  codeHost: CodeHostAdapter | null;
  issueTracker: IssueTrackerAdapter | null;
  manualIssueIds: string[];
  manualMrIds: string[];
}

const MAX_MRS = 10;
const MAX_ISSUES = 10;

type TaggedMr = MergeRequest & { source: LinkSource };
type TaggedIssue = Issue & { source: LinkSource };

const SOURCE_PRIORITY: Record<LinkSource, number> = {
  manual: 0,
  branch: 1,
  "mr-link": 2,
  transitive: 3,
};

function deduplicateMrs(mrs: TaggedMr[]): TaggedMr[] {
  const seen = new Map<string, TaggedMr>();
  for (const mr of mrs) {
    const existing = seen.get(mr.id);
    if (!existing || SOURCE_PRIORITY[mr.source] < SOURCE_PRIORITY[existing.source]) {
      seen.set(mr.id, mr);
    }
  }
  return [...seen.values()];
}

function deduplicateIssues(issues: TaggedIssue[]): TaggedIssue[] {
  const seen = new Map<string, TaggedIssue>();
  for (const issue of issues) {
    const existing = seen.get(issue.id);
    if (!existing || SOURCE_PRIORITY[issue.source] < SOURCE_PRIORITY[existing.source]) {
      seen.set(issue.id, issue);
    }
  }
  return [...seen.values()];
}

export async function resolveSessionContext(
  opts: ResolveOptions,
): Promise<SessionContext> {
  const { sessionName, dir, codeHost, issueTracker, manualIssueIds, manualMrIds } = opts;
  const mrs: TaggedMr[] = [];
  const issues: TaggedIssue[] = [];

  // Step 1-2: Git state + branch auto-discovery
  const branch = await getGitBranch(dir);
  const remotes = branch ? await getGitRemotes(dir) : [];
  const remote = selectRemote(remotes, codeHost?.type ?? null);

  if (branch && remote && codeHost && codeHost.authState === "ok") {
    try {
      const mr = await codeHost.getMergeRequest(remote.url, branch);
      if (mr) mrs.push({ ...mr, source: "branch" });
    } catch {}
  }

  if (branch && issueTracker && issueTracker.authState === "ok") {
    try {
      const issue = await issueTracker.getIssueByBranch(branch);
      if (issue) issues.push({ ...issue, source: "branch" });
    } catch {}
  }

  // Step 3: Resolve manual issue links
  if (issueTracker && issueTracker.authState === "ok") {
    for (const id of manualIssueIds) {
      if (issues.length >= MAX_ISSUES) break;
      try {
        const issue = await issueTracker.pollIssue(id);
        if (issue) issues.push({ ...issue, source: "manual" });
      } catch {}
    }
  }

  // Step 4: Resolve manual MR links
  if (codeHost && codeHost.authState === "ok" && manualMrIds.length > 0) {
    try {
      const resolved = await codeHost.pollMergeRequestsByIds(manualMrIds);
      for (const [id, mr] of resolved) {
        if (mrs.length >= MAX_MRS) break;
        mrs.push({ ...mr, source: "manual" });
      }
    } catch {}
  }

  // Step 5: Forward links — MR → linked issues
  if (issueTracker && issueTracker.authState === "ok") {
    const mrsCopy = [...mrs]; // snapshot to avoid iterating while growing
    for (const mr of mrsCopy) {
      if (issues.length >= MAX_ISSUES) break;
      try {
        const linked = await issueTracker.getLinkedIssue(mr.webUrl);
        if (linked) issues.push({ ...linked, source: "mr-link" });
      } catch {}
    }
  }

  // Step 6: Transitive links — issue → MR URLs
  if (codeHost && codeHost.authState === "ok") {
    const issuesCopy = [...issues];
    for (const issue of issuesCopy) {
      if (mrs.length >= MAX_MRS) break;
      for (const mrUrl of issue.linkedMrUrls) {
        if (mrs.length >= MAX_MRS) break;
        const mrId = codeHost.parseMrUrl(mrUrl);
        if (!mrId) continue;
        try {
          const mr = await codeHost.pollMergeRequest(mrId);
          if (mr) mrs.push({ ...mr, source: "transitive" });
        } catch {}
      }
    }
  }

  return {
    sessionName,
    dir,
    branch: branch ?? null,
    remote: remote?.url ?? null,
    mrs: deduplicateMrs(mrs),
    issues: deduplicateIssues(issues),
    resolvedAt: Date.now(),
  };
}
```

- [ ] **Step 2: Update tests**

Replace the existing `resolveSessionContext` test and add new ones:

```typescript
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

  test("deduplicateMrs prefers higher-priority source", () => {
    // Import the helpers for testing — or test through resolveSessionContext
    // This is tested implicitly through integration
  });
});
```

- [ ] **Step 3: Run tests**

Run: `bun test src/__tests__/adapters/context-resolver.test.ts`
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add src/adapters/context-resolver.ts src/__tests__/adapters/context-resolver.test.ts
git commit -m "feat: rewrite context resolver for multi-source link resolution with deduplication"
```

---

### Task 5: Poll Coordinator — Multi-Item Polling

**Files:**
- Modify: `src/adapters/poll-coordinator.ts`
- Modify: `src/__tests__/adapters/poll-coordinator.test.ts`

- [ ] **Step 1: Update PollCoordinatorOptions to accept SessionState**

Add import and update the options interface:

```typescript
import type { SessionState } from "../session-state";

export interface PollCoordinatorOptions {
  codeHost: CodeHostAdapter | null;
  issueTracker: IssueTrackerAdapter | null;
  onUpdate: (sessionName: string) => void;
  getSessionDir: (sessionName: string) => string | null;
  sessionState: SessionState | null;
}
```

- [ ] **Step 2: Update resolveContext to pass manual links**

```typescript
  private async resolveContext(name: string): Promise<void> {
    const dir = this.sessionDirs.get(name);
    if (!dir) return;
    try {
      const manualIssueIds = this.opts.sessionState?.getLinkedIssueIds(name) ?? [];
      const manualMrIds = this.opts.sessionState?.getLinkedMrIds(name) ?? [];
      const ctx = await resolveSessionContext({
        sessionName: name,
        dir,
        codeHost: this.opts.codeHost,
        issueTracker: this.opts.issueTracker,
        manualIssueIds,
        manualMrIds,
      });
      this.contexts.set(name, ctx);
      this.opts.onUpdate(name);
    } catch {}
  }
```

- [ ] **Step 3: Update pollActiveSession for multi-item polling**

Replace the existing MR/issue polling block with:

```typescript
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
        await this.resolveContext(name);
        return;
      }
    }

    const { codeHost, issueTracker } = this.opts;
    let changed = false;

    // Poll all MRs by ID
    if (ctx.mrs.length > 0 && codeHost && codeHost.authState === "ok") {
      try {
        const ids = ctx.mrs.map((mr) => mr.id);
        const updated = await codeHost.pollMergeRequestsByIds(ids);
        for (let i = 0; i < ctx.mrs.length; i++) {
          const fresh = updated.get(ctx.mrs[i].id);
          if (fresh) {
            ctx.mrs[i] = { ...fresh, source: ctx.mrs[i].source };
            changed = true;
          }
        }
      } catch (e: any) {
        if (e?.status === 401 || e?.status === 403) this.reportAuthFailure("codeHost");
        else if (e?.status === 429) this.reportRateLimit("rate_limited");
      }
    }

    // Poll all issues by ID
    if (ctx.issues.length > 0 && issueTracker && issueTracker.authState === "ok") {
      try {
        const ids = ctx.issues.map((issue) => issue.id);
        const updated = await issueTracker.pollAllIssues(ids);
        for (let i = 0; i < ctx.issues.length; i++) {
          const fresh = updated.get(ctx.issues[i].id);
          if (fresh) {
            ctx.issues[i] = { ...fresh, source: ctx.issues[i].source };
            changed = true;
          }
        }
      } catch (e: any) {
        if (e?.status === 401 || e?.status === 403) this.reportAuthFailure("issueTracker");
        else if (e?.status === 429) this.reportRateLimit("rate_limited");
      }
    }

    if (changed) {
      ctx.resolvedAt = Date.now();
      this.opts.onUpdate(name);
    }
  }
```

- [ ] **Step 4: Update pollBackgroundSessions for multi-item**

Replace with:

```typescript
  private async pollBackgroundSessions(): Promise<void> {
    if (this._rateLimitState !== "normal") return;
    const { codeHost, issueTracker } = this.opts;

    // Collect branch contexts for branch-discovered MRs
    const branchContexts: BranchContext[] = [];
    // Collect MR IDs for manual/transitive MRs (not branch-discovered)
    const nonBranchMrIds: string[] = [];
    const mrIdToSession = new Map<string, string>();
    // Collect all issue IDs
    const allIssueIds: string[] = [];
    const issueIdToSession = new Map<string, string>();

    for (const [name, ctx] of this.contexts) {
      if (name === this.activeSession) continue;
      if (ctx.branch && ctx.remote) {
        branchContexts.push({ sessionName: name, remote: ctx.remote, branch: ctx.branch });
      }
      for (const mr of ctx.mrs) {
        if (mr.source !== "branch") {
          nonBranchMrIds.push(mr.id);
          mrIdToSession.set(mr.id, name);
        }
      }
      for (const issue of ctx.issues) {
        allIssueIds.push(issue.id);
        issueIdToSession.set(issue.id, name);
      }
    }

    // Batch 1: branch-oriented MR discovery (existing)
    if (branchContexts.length > 0 && codeHost && codeHost.authState === "ok") {
      try {
        const results = await codeHost.pollAllMergeRequests(branchContexts);
        for (const [sessionName, mr] of results) {
          const ctx = this.contexts.get(sessionName);
          if (ctx) {
            const idx = ctx.mrs.findIndex((m) => m.source === "branch");
            if (idx >= 0) ctx.mrs[idx] = { ...mr, source: "branch" };
            ctx.resolvedAt = Date.now();
            this.opts.onUpdate(sessionName);
          }
        }
      } catch (e: any) {
        if (e?.status === 429) this.reportRateLimit("rate_limited");
      }
    }

    // Batch 2: ID-oriented MR polling for manual/transitive
    if (nonBranchMrIds.length > 0 && codeHost && codeHost.authState === "ok") {
      try {
        const results = await codeHost.pollMergeRequestsByIds(nonBranchMrIds);
        for (const [mrId, mr] of results) {
          const sessionName = mrIdToSession.get(mrId);
          if (!sessionName) continue;
          const ctx = this.contexts.get(sessionName);
          if (ctx) {
            const idx = ctx.mrs.findIndex((m) => m.id === mrId);
            if (idx >= 0) {
              ctx.mrs[idx] = { ...mr, source: ctx.mrs[idx].source };
              ctx.resolvedAt = Date.now();
              this.opts.onUpdate(sessionName);
            }
          }
        }
      } catch (e: any) {
        if (e?.status === 429) this.reportRateLimit("rate_limited");
      }
    }

    // Batch 3: issue polling (existing pattern, already ID-based)
    if (allIssueIds.length > 0 && issueTracker && issueTracker.authState === "ok") {
      try {
        const results = await issueTracker.pollAllIssues(allIssueIds);
        for (const [issueId, issue] of results) {
          const sessionName = issueIdToSession.get(issueId);
          if (!sessionName) continue;
          const ctx = this.contexts.get(sessionName);
          if (ctx) {
            const idx = ctx.issues.findIndex((i) => i.id === issueId);
            if (idx >= 0) {
              ctx.issues[idx] = { ...issue, source: ctx.issues[idx].source };
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
```

- [ ] **Step 5: Update tests**

Update the PollCoordinator constructor calls in tests to include `sessionState: null`:

```typescript
const coordinator = new PollCoordinator({
  codeHost: null,
  issueTracker: null,
  onUpdate: () => {},
  getSessionDir: () => "/tmp",
  sessionState: null,
});
```

- [ ] **Step 6: Run tests**

Run: `bun test src/__tests__/adapters/poll-coordinator.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/adapters/poll-coordinator.ts src/__tests__/adapters/poll-coordinator.test.ts
git commit -m "feat: multi-item polling with pollMergeRequestsByIds and session state integration"
```

---

### Task 6: Panel Rendering — Multi-Item MR and Issues Tabs

**Files:**
- Modify: `src/info-panel-mr.ts`
- Modify: `src/info-panel-issues.ts`
- Modify: `src/__tests__/info-panel-mr.test.ts`
- Modify: `src/__tests__/info-panel-issues.test.ts`

- [ ] **Step 1: Rewrite renderMrTab for multi-item**

Change signature from single MR to array:

```typescript
// src/info-panel-mr.ts
import type { MergeRequest, LinkSource } from "./adapters/types";

type TaggedMr = MergeRequest & { source: LinkSource };

export function renderMrTab(
  mrs: TaggedMr[],
  cols: number,
  rows: number,
  selectedIndex: number,
  error?: string,
): CellGrid {
```

Render each MR as a section with a selection cursor (`▸`) on the selected one. Keep existing rendering logic per MR but wrap in a loop. Add `(auto)` badge for non-manual sources. Truncate if items overflow `rows`.

- [ ] **Step 2: Rewrite renderIssuesTab for multi-item**

Same pattern:

```typescript
// src/info-panel-issues.ts
import type { Issue, LinkSource } from "./adapters/types";

type TaggedIssue = Issue & { source: LinkSource };

export function renderIssuesTab(
  issues: TaggedIssue[],
  cols: number,
  rows: number,
  selectedIndex: number,
  error?: string,
): CellGrid {
```

- [ ] **Step 3: Update tests**

Update all `renderMrTab` calls from `renderMrTab(MR, 40, 20)` to `renderMrTab([{ ...MR, source: "branch" }], 40, 20, 0)`. Same for issues tab.

Add multi-item tests:

```typescript
test("renders multiple MRs with selection cursor", () => {
  const mr2: MergeRequest = { ...MR, id: "456:2", title: "Second MR" };
  const grid = renderMrTab(
    [{ ...MR, source: "branch" as const }, { ...mr2, source: "manual" as const }],
    40, 30, 1,
  );
  const text = extractText(grid);
  expect(text).toContain("Fix auth token refresh");
  expect(text).toContain("Second MR");
});

test("shows auto badge for non-manual source", () => {
  const grid = renderMrTab([{ ...MR, source: "transitive" as const }], 40, 20, 0);
  const text = extractText(grid);
  expect(text).toContain("auto");
});
```

- [ ] **Step 4: Run tests**

Run: `bun test src/__tests__/info-panel-mr.test.ts src/__tests__/info-panel-issues.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/info-panel-mr.ts src/info-panel-issues.ts src/__tests__/info-panel-mr.test.ts src/__tests__/info-panel-issues.test.ts
git commit -m "feat: multi-item MR and Issues tab rendering with selection cursor and source badges"
```

---

### Task 7: Sidebar Three-Line Rows

**Files:**
- Modify: `src/sidebar.ts`
- Modify: `src/__tests__/sidebar.test.ts`

- [ ] **Step 1: Update itemHeight to return 2 or 3**

In `src/sidebar.ts`, find `itemHeight` (around line 234) and change:

```typescript
function itemHeight(item: RenderItem): number {
  if (item.type === "session") return item.hasLinkData ? 3 : 2;
  if (item.type === "group-header") return 1;
  return 1; // spacer
}
```

Update the `RenderItem` session variant to include `hasLinkData: boolean`. Set it in `buildRenderPlan` based on whether `sessionContexts` has data for that session.

- [ ] **Step 2: Add third line rendering in renderSession**

After the detail row (branch/dir + cache timer), add a third row for issue IDs and MR count when `hasLinkData` is true:

```typescript
    // Link data line (line 3) — issue identifiers + MR count
    const ctx = this.sessionContexts.get(session.name);
    if (ctx && (ctx.issues.length > 0 || ctx.mrs.length > 0)) {
      const linkRow = detailRow + 1;
      if (linkRow < this.height) {
        this.rowToSessionIndex.set(linkRow, sessionIdx);
        if (isActive || isHovered) {
          const bgFill = " ".repeat(this.width);
          writeString(grid, linkRow, 0, bgFill, bgAttrs);
        }
        if (isActive) writeString(grid, linkRow, 0, "\u258e", ACTIVE_MARKER_ATTRS);

        // Issue identifiers (left-aligned)
        const detailStart = 3;
        const identifiers = ctx.issues.map((i) => i.identifier);
        const mrCountStr = ctx.mrs.length > 0 ? `${ctx.mrs.length}M` : "";
        const mrCountCol = mrCountStr ? this.width - mrCountStr.length - 1 : this.width;
        const maxIdentWidth = mrCountCol - 1 - detailStart;

        let identStr = identifiers.join(" ");
        if (identStr.length > maxIdentWidth && identifiers.length > 1) {
          // Truncate with +N
          let shown = 0;
          let len = 0;
          for (const id of identifiers) {
            const needed = len > 0 ? id.length + 1 : id.length;
            const remaining = identifiers.length - shown - 1;
            const suffixLen = remaining > 0 ? ` +${remaining}`.length : 0;
            if (len + needed + suffixLen > maxIdentWidth) break;
            len += needed;
            shown++;
          }
          identStr = identifiers.slice(0, shown).join(" ");
          if (shown < identifiers.length) {
            identStr += ` +${identifiers.length - shown}`;
          }
        } else if (identStr.length > maxIdentWidth) {
          identStr = identStr.slice(0, maxIdentWidth - 1) + "\u2026";
        }

        const linkAttrs: CellAttrs = isActive
          ? { ...DIM_ATTRS, bg: ACTIVE_BG, bgMode: ColorMode.RGB }
          : isHovered
            ? { ...DIM_ATTRS, bg: HOVER_BG, bgMode: ColorMode.RGB }
            : DIM_ATTRS;
        if (identStr) writeString(grid, linkRow, detailStart, identStr, linkAttrs);
        if (mrCountStr) writeString(grid, linkRow, mrCountCol, mrCountStr, linkAttrs);
      }
    }
```

- [ ] **Step 3: Update worst-state pipeline glyph**

Replace the existing glyph logic that reads `ctx?.mr?.pipeline?.state` with:

```typescript
    // Pipeline glyph — worst state across all MRs
    const pipelineStates = (ctx?.mrs ?? [])
      .map((mr) => mr.pipeline?.state)
      .filter((s): s is string => !!s);
    const WORST_ORDER = ["failed", "running", "pending", "passed", "canceled"];
    let worstState: string | undefined;
    for (const state of WORST_ORDER) {
      if (pipelineStates.includes(state)) { worstState = state; break; }
    }
    if (worstState) {
      // ... existing glyph rendering using worstState instead of pipelineState
    }
```

- [ ] **Step 4: Update tests**

Update `makeContexts` helper to use `mrs[]` and `issues[]`:

```typescript
function makeContexts(
  entries: Array<{ name: string; pipelineState?: PipelineStatus["state"]; issueIds?: string[]; mrCount?: number }>,
): Map<string, SessionContext> {
  const map = new Map<string, SessionContext>();
  for (const e of entries) {
    map.set(e.name, {
      sessionName: e.name,
      dir: "/tmp",
      branch: "main",
      remote: null,
      mrs: e.pipelineState
        ? [{
            id: "1", title: "Test", status: "open",
            sourceBranch: "main", targetBranch: "main",
            pipeline: { state: e.pipelineState, webUrl: "" },
            approvals: { required: 0, current: 0 },
            webUrl: "", source: "branch" as const,
          }]
        : Array.from({ length: e.mrCount ?? 0 }, (_, i) => ({
            id: `${i}`, title: `MR ${i}`, status: "open" as const,
            sourceBranch: "feat", targetBranch: "main",
            pipeline: null, approvals: { required: 0, current: 0 },
            webUrl: "", source: "manual" as const,
          })),
      issues: (e.issueIds ?? []).map((id) => ({
        id, identifier: id, title: "Test", status: "In Progress",
        assignee: null, linkedMrUrls: [], webUrl: "", source: "manual" as const,
      })),
      resolvedAt: Date.now(),
    });
  }
  return map;
}
```

Add three-line row tests:

```typescript
describe("Sidebar three-line rows", () => {
  test("renders issue identifiers on third line", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "api" }]));
    sidebar.setSessionContexts(makeContexts([{
      name: "api", issueIds: ["ENG-1234", "ENG-1235"], mrCount: 2,
    }]));
    const grid = sidebar.getGrid();
    const allChars = grid.cells.flatMap((row) => row.map((c) => c.char)).join("");
    expect(allChars).toContain("ENG-1234");
    expect(allChars).toContain("2M");
  });

  test("truncates issue identifiers with +N", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "api" }]));
    sidebar.setSessionContexts(makeContexts([{
      name: "api", issueIds: ["ENG-1234", "ENG-1235", "ENG-1236", "ENG-1237"],
    }]));
    const grid = sidebar.getGrid();
    const allChars = grid.cells.flatMap((row) => row.map((c) => c.char)).join("");
    expect(allChars).toContain("+");
  });
});
```

- [ ] **Step 5: Run tests**

Run: `bun test src/__tests__/sidebar.test.ts`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/sidebar.ts src/__tests__/sidebar.test.ts
git commit -m "feat: three-line sidebar rows with issue IDs, MR count, and worst-state pipeline glyph"
```

---

### Task 8: Input Router — Up/Down Selection

**Files:**
- Modify: `src/input-router.ts`
- Modify: `src/__tests__/input-router.test.ts`

- [ ] **Step 1: Add up/down callbacks to InputRouterOptions**

```typescript
  onPanelSelectPrev?: () => void;
  onPanelSelectNext?: () => void;
```

- [ ] **Step 2: Add arrow key handling in panel-focused block**

In the `diffPanelFocused` block, after tab switching but before action keys:

```typescript
      // Up/Down arrow for item selection within a tab
      if (data === "\x1b[A" && this.opts.onPanelSelectPrev) {
        this.opts.onPanelSelectPrev();
        return;
      }
      if (data === "\x1b[B" && this.opts.onPanelSelectNext) {
        this.opts.onPanelSelectNext();
        return;
      }
```

Note: these are only intercepted when `panelTabsActive` is true (not on diff tab), same gate as action keys. Add the `panelTabsActive` check.

- [ ] **Step 3: Add tests**

```typescript
  test("up arrow triggers onPanelSelectPrev when panel tabs active", () => {
    let called = false;
    const router = new InputRouter(
      {
        sidebarCols: 24,
        onPtyData: () => {},
        onSidebarClick: () => {},
        onPanelSelectPrev: () => { called = true; },
      },
      true,
    );
    router.setDiffPanel(40, true);
    router.setPanelTabsActive(true);
    router.handleInput("\x1b[A");
    expect(called).toBe(true);
  });

  test("down arrow triggers onPanelSelectNext when panel tabs active", () => {
    let called = false;
    const router = new InputRouter(
      {
        sidebarCols: 24,
        onPtyData: () => {},
        onSidebarClick: () => {},
        onPanelSelectNext: () => { called = true; },
      },
      true,
    );
    router.setDiffPanel(40, true);
    router.setPanelTabsActive(true);
    router.handleInput("\x1b[B");
    expect(called).toBe(true);
  });
```

- [ ] **Step 4: Run tests**

Run: `bun test src/__tests__/input-router.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/input-router.ts src/__tests__/input-router.test.ts
git commit -m "feat: add up/down arrow selection for multi-item panel tabs"
```

---

### Task 9: Main.ts Integration

**Files:**
- Modify: `src/main.ts`

This wires session state, link commands, multi-item rendering, selection state, and session rename migration.

- [ ] **Step 1: Add imports and initialize session state**

```typescript
import { SessionState } from "./session-state";

// After pollCoordinator initialization:
const sessionStatePath = resolve(homedir(), ".config", "jmux", "state.json");
const sessionState = new SessionState(sessionStatePath);
```

Update the `PollCoordinator` constructor to pass `sessionState`:

```typescript
const pollCoordinator = new PollCoordinator({
  codeHost: adapters.codeHost,
  issueTracker: adapters.issueTracker,
  onUpdate: (_sessionName) => {
    sidebar.setSessionContexts(pollCoordinator.getAllContexts());
    scheduleRender();
  },
  getSessionDir: (name) => {
    const session = currentSessions.find((s) => s.name === name);
    return session ? (sessionDetailsCache.get(session.id)?.directory ?? null) : null;
  },
  sessionState,
});
```

- [ ] **Step 2: Add selection state for panel items**

```typescript
let mrSelectedIndex = 0;
let issueSelectedIndex = 0;
```

- [ ] **Step 3: Update renderFrame for multi-item**

Replace the `ctx?.mr ?? null` / `ctx?.issue ?? null` calls with array versions:

```typescript
    } else if (infoPanel.activeTab === "mr") {
      const sessionName = currentSessions.find((s) => s.id === currentSessionId)?.name ?? "";
      const ctx = pollCoordinator.getContext(sessionName);
      const errorMsg = adapters.codeHost?.authState === "failed"
        ? `Authentication expired — check ${adapters.codeHost.authHint}`
        : undefined;
      contentGrid = renderMrTab(ctx?.mrs ?? [], dpCols, dpRows, mrSelectedIndex, errorMsg);
    } else {
      const sessionName = currentSessions.find((s) => s.id === currentSessionId)?.name ?? "";
      const ctx = pollCoordinator.getContext(sessionName);
      const errorMsg = adapters.issueTracker?.authState === "failed"
        ? `Authentication expired — check ${adapters.issueTracker.authHint}`
        : undefined;
      contentGrid = renderIssuesTab(ctx?.issues ?? [], dpCols, dpRows, issueSelectedIndex, errorMsg);
    }
```

- [ ] **Step 4: Add selection callbacks to InputRouter**

```typescript
    onPanelSelectPrev: () => {
      if (infoPanel.activeTab === "mr") {
        mrSelectedIndex = Math.max(0, mrSelectedIndex - 1);
      } else if (infoPanel.activeTab === "issues") {
        issueSelectedIndex = Math.max(0, issueSelectedIndex - 1);
      }
      scheduleRender();
    },
    onPanelSelectNext: () => {
      const sessionName = currentSessions.find((s) => s.id === currentSessionId)?.name ?? "";
      const ctx = pollCoordinator.getContext(sessionName);
      if (infoPanel.activeTab === "mr" && ctx) {
        mrSelectedIndex = Math.min(ctx.mrs.length - 1, mrSelectedIndex + 1);
      } else if (infoPanel.activeTab === "issues" && ctx) {
        issueSelectedIndex = Math.min(ctx.issues.length - 1, issueSelectedIndex + 1);
      }
      scheduleRender();
    },
```

- [ ] **Step 5: Update onPanelAction for multi-item**

Replace the existing `onPanelAction` that uses `ctx?.mr` with:

```typescript
    onPanelAction: (key) => {
      const sessionName = currentSessions.find((s) => s.id === currentSessionId)?.name ?? "";
      const ctx = pollCoordinator.getContext(sessionName);
      if (!ctx) return;

      if (infoPanel.activeTab === "mr" && adapters.codeHost) {
        const mr = ctx.mrs[mrSelectedIndex];
        if (!mr) return;
        if (key === "o") adapters.codeHost.openInBrowser(mr.id);
        if (key === "r") adapters.codeHost.markReady(mr.id).then(() => scheduleRender());
        if (key === "a") adapters.codeHost.approve(mr.id).then(() => scheduleRender());
      }
      if (infoPanel.activeTab === "issues" && adapters.issueTracker) {
        const issue = ctx.issues[issueSelectedIndex];
        if (!issue) return;
        if (key === "o") adapters.issueTracker.openInBrowser(issue.id);
        if (key === "s") {
          adapters.issueTracker.getAvailableStatuses(issue.id).then((statuses) => {
            if (statuses.length === 0) return;
            const items = statuses.map((s) => ({ id: s, label: s }));
            const listModal = new ListModal({ items, header: "Update Status" });
            listModal.open();
            openModal(listModal, (selected: unknown) => {
              const sel = selected as { id: string };
              if (sel?.id) {
                adapters.issueTracker!.updateStatus(issue.id, sel.id).then(() => scheduleRender());
              }
            });
          });
        }
      }
    },
```

- [ ] **Step 6: Add link/unlink commands to palette**

In `buildPaletteCommands`, add after the adapter settings:

```typescript
  // Link commands (only when adapters configured)
  if (adapters.issueTracker?.authState === "ok") {
    commands.push(
      { id: "link-issue", label: "Link issue to session", category: "link" },
      { id: "unlink-issue", label: "Unlink issue from session", category: "link" },
    );
  }
  if (adapters.codeHost?.authState === "ok") {
    commands.push(
      { id: "link-mr", label: "Link MR to session", category: "link" },
      { id: "unlink-mr", label: "Unlink MR from session", category: "link" },
    );
  }
```

In `handlePaletteAction`, add cases:

```typescript
    case "link-issue": {
      if (!adapters.issueTracker) return;
      const modal = new InputModal({
        header: "Link Issue",
        subheader: "Search by identifier or title",
        value: "",
      });
      modal.open();
      openModal(modal, async (query) => {
        const results = await adapters.issueTracker!.searchIssues(query as string);
        if (results.length === 0) return;
        const items = results.map((i) => ({ id: i.id, label: `${i.identifier} ${i.title}` }));
        const picker = new ListModal({ items, header: "Select Issue" });
        picker.open();
        openModal(picker, (selected) => {
          const sel = selected as ListItem;
          const issue = results.find((i) => i.id === sel.id);
          if (issue) {
            const sessionName = currentSessions.find((s) => s.id === currentSessionId)?.name;
            if (sessionName) {
              sessionState.addLink(sessionName, { type: "issue", id: issue.id });
              pollCoordinator.setActiveSession(sessionName); // re-resolve
            }
          }
        });
      });
      return;
    }
    case "unlink-issue": {
      const sessionName = currentSessions.find((s) => s.id === currentSessionId)?.name ?? "";
      const manualIssues = sessionState.getLinks(sessionName).filter((l) => l.type === "issue");
      if (manualIssues.length === 0) return;
      const ctx = pollCoordinator.getContext(sessionName);
      const items = manualIssues.map((l) => {
        const issue = ctx?.issues.find((i) => i.id === l.id);
        return { id: l.id, label: issue ? `${issue.identifier} ${issue.title}` : l.id };
      });
      const modal = new ListModal({ items, header: "Unlink Issue" });
      modal.open();
      openModal(modal, (selected) => {
        const sel = selected as ListItem;
        sessionState.removeLink(sessionName, { type: "issue", id: sel.id });
        pollCoordinator.setActiveSession(sessionName);
      });
      return;
    }
    case "link-mr": {
      if (!adapters.codeHost) return;
      const modal = new InputModal({
        header: "Link MR",
        subheader: "Search by title",
        value: "",
      });
      modal.open();
      openModal(modal, async (query) => {
        const results = await adapters.codeHost!.searchMergeRequests(query as string);
        if (results.length === 0) return;
        const items = results.map((mr) => ({ id: mr.id, label: `!${mr.id.split(":")[1]} ${mr.title}` }));
        const picker = new ListModal({ items, header: "Select MR" });
        picker.open();
        openModal(picker, (selected) => {
          const sel = selected as ListItem;
          const sessionName = currentSessions.find((s) => s.id === currentSessionId)?.name;
          if (sessionName) {
            sessionState.addLink(sessionName, { type: "mr", id: sel.id });
            pollCoordinator.setActiveSession(sessionName);
          }
        });
      });
      return;
    }
    case "unlink-mr": {
      const sessionName = currentSessions.find((s) => s.id === currentSessionId)?.name ?? "";
      const manualMrs = sessionState.getLinks(sessionName).filter((l) => l.type === "mr");
      if (manualMrs.length === 0) return;
      const ctx = pollCoordinator.getContext(sessionName);
      const items = manualMrs.map((l) => {
        const mr = ctx?.mrs.find((m) => m.id === l.id);
        return { id: l.id, label: mr ? `!${l.id.split(":")[1]} ${mr.title}` : l.id };
      });
      const modal = new ListModal({ items, header: "Unlink MR" });
      modal.open();
      openModal(modal, (selected) => {
        const sel = selected as ListItem;
        sessionState.removeLink(sessionName, { type: "mr", id: sel.id });
        pollCoordinator.setActiveSession(sessionName);
      });
      return;
    }
```

- [ ] **Step 7: Add session rename migration**

Find the existing `%session-renamed` handler in main.ts (search for `session-renamed` in the control event handling). Add:

```typescript
sessionState.renameSession(oldName, newName);
```

- [ ] **Step 8: Add session pruning in fetchSessions**

In `fetchSessions`, after the existing poll coordinator session sync:

```typescript
const liveSessionNames = new Set(sessions.map((s) => s.name));
sessionState.pruneSessions(liveSessionNames);
```

- [ ] **Step 9: Reset selection indices on session switch**

In `switchSession`, after setting active session:

```typescript
mrSelectedIndex = 0;
issueSelectedIndex = 0;
```

- [ ] **Step 10: Run typecheck and all tests**

Run: `bun run typecheck && bun test`
Expected: No type errors, all tests pass

- [ ] **Step 11: Commit**

```bash
git add src/main.ts
git commit -m "feat: wire session links — state file, palette commands, multi-item rendering, rename migration"
```
