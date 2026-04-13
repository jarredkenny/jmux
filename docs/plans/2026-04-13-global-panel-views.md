# Global Panel Views Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace session-scoped MR/Issues tabs with configurable global views showing everything the user owns, with grouping, sorting, detail panes, and task dispatch actions.

**Architecture:** `PanelView` definitions (config-driven) describe what to fetch and how to display it. A generic view renderer transforms data through a pipeline (select → transform → partition → group → sort → render). The `PollCoordinator` gains global caches (5-min poll) alongside existing per-session polling. `InfoPanel` migrates from hardcoded `"diff"|"mr"|"issues"` tabs to `"diff"` + dynamic view tabs. Old single-item renderers (`info-panel-mr.ts`, `info-panel-issues.ts`) are replaced by `panel-view-renderer.ts`.

**Tech Stack:** TypeScript, Bun runtime, existing CellGrid/writeString rendering, existing adapter pattern.

**Spec:** `docs/specs/2026-04-13-global-panel-views-design.md`

**Branch:** `feat/info-panel-adapters` (continues from existing adapter + session-links work)

**Key codebase context for agentic workers:**
- This is a Bun-based tmux TUI. Tests use `bun:test`. Run tests with `bun test`, typecheck with `bun run typecheck`.
- `writeString(grid, row, col, text, attrs)` returns `void` — track column manually with `col += text.length`.
- `ColorMode` is a `const enum`: `Default=0, Palette=1, RGB=2`. RGB colors are packed `(R<<16)|(G<<8)|B`.
- `CellAttrs` is `{ fg?, bg?, fgMode?, bgMode?, bold?, italic?, underline?, dim? }`.
- `createGrid(cols, rows)` creates a CellGrid. `cellWidth(codepoint)` returns character display width.
- The existing `SessionContext` has `mrs: Array<MergeRequest & { source: LinkSource }>` and `issues: Array<Issue & { source: LinkSource }>` (plural, with provenance — from the session-links feature already implemented on this branch).

---

### Task 1: Data Model Extensions

**Files:**
- Modify: `src/adapters/types.ts`
- Modify: `src/__tests__/adapters/types.test.ts`

- [ ] **Step 1: Add new fields to Issue interface**

In `src/adapters/types.ts`, extend the `Issue` interface (lines 17-25) with:

```typescript
export interface Issue {
  id: string;
  identifier: string;
  title: string;
  status: string;
  assignee: string | null;
  linkedMrUrls: string[];
  webUrl: string;
  team?: string;
  project?: string;
  priority?: number;   // 0=none, 1=urgent, 2=high, 3=medium, 4=low
  updatedAt?: number;  // epoch ms
}
```

- [ ] **Step 2: Add new fields to MergeRequest interface**

In `src/adapters/types.ts`, extend `MergeRequest` (lines 6-15) with:

```typescript
export interface MergeRequest {
  id: string;
  title: string;
  status: "draft" | "open" | "merged" | "closed";
  sourceBranch: string;
  targetBranch: string;
  pipeline: PipelineStatus | null;
  approvals: { required: number; current: number };
  webUrl: string;
  author?: string;
  reviewers?: string[];
  updatedAt?: number;  // epoch ms
}
```

- [ ] **Step 3: Add new adapter methods to interfaces**

Add to `CodeHostAdapter` (after `pollMergeRequestsByIds`):

```typescript
  getMyMergeRequests(): Promise<MergeRequest[]>;
  getMrsAwaitingMyReview(): Promise<MergeRequest[]>;
```

Add to `IssueTrackerAdapter` (after `searchIssues`):

```typescript
  getMyIssues(): Promise<Issue[]>;
```

- [ ] **Step 4: Update type tests**

Add to `src/__tests__/adapters/types.test.ts`:

```typescript
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
```

- [ ] **Step 5: Run tests and commit**

Run: `bun test src/__tests__/adapters/types.test.ts`
Expected: PASS

```bash
git add src/adapters/types.ts src/__tests__/adapters/types.test.ts
git commit -m "feat: extend Issue and MergeRequest with team, priority, author, reviewers fields"
```

---

### Task 2: PanelView Types, Defaults, and Config

**Files:**
- Create: `src/panel-view.ts`
- Test: `src/__tests__/panel-view.test.ts`
- Modify: `src/config.ts`

- [ ] **Step 1: Create panel-view.ts**

```typescript
// src/panel-view.ts

export interface PanelViewFilter {
  scope: "assigned" | "authored" | "reviewing";
}

export type GroupByField = "team" | "project" | "status" | "priority" | "none";
export type SortByField = "priority" | "updated" | "created" | "status";

export interface PanelView {
  id: string;
  label: string;
  source: "issues" | "mrs";
  filter: PanelViewFilter;
  groupBy: GroupByField;
  subGroupBy: GroupByField;
  sortBy: SortByField;
  sortOrder: "asc" | "desc";
  sessionLinkedFirst: boolean;
}

const VALID_COMBOS: Array<{ source: string; scope: string }> = [
  { source: "issues", scope: "assigned" },
  { source: "mrs", scope: "authored" },
  { source: "mrs", scope: "reviewing" },
];

export const DEFAULT_VIEWS: PanelView[] = [
  {
    id: "my-issues",
    label: "Issues",
    source: "issues",
    filter: { scope: "assigned" },
    groupBy: "team",
    subGroupBy: "status",
    sortBy: "priority",
    sortOrder: "asc",
    sessionLinkedFirst: true,
  },
  {
    id: "my-mrs",
    label: "My MRs",
    source: "mrs",
    filter: { scope: "authored" },
    groupBy: "none",
    subGroupBy: "none",
    sortBy: "updated",
    sortOrder: "desc",
    sessionLinkedFirst: true,
  },
  {
    id: "review",
    label: "Review",
    source: "mrs",
    filter: { scope: "reviewing" },
    groupBy: "none",
    subGroupBy: "none",
    sortBy: "created",
    sortOrder: "asc",
    sessionLinkedFirst: false,
  },
];

export function parseViews(raw: unknown): PanelView[] {
  if (!Array.isArray(raw)) return DEFAULT_VIEWS;
  const views: PanelView[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;
    const { id, label, source, filter, groupBy, subGroupBy, sortBy, sortOrder, sessionLinkedFirst } = entry as any;
    if (typeof id !== "string" || !id) continue;
    if (typeof label !== "string" || !label) continue;
    if (source !== "issues" && source !== "mrs") continue;
    const scope = filter?.scope;
    if (!VALID_COMBOS.some((c) => c.source === source && c.scope === scope)) {
      process.stderr.write(`jmux: invalid panelView "${id}" — ${source}+${scope} is not a valid combination\n`);
      continue;
    }
    views.push({
      id,
      label,
      source,
      filter: { scope },
      groupBy: isGroupByField(groupBy) ? groupBy : "none",
      subGroupBy: isGroupByField(subGroupBy) ? subGroupBy : "none",
      sortBy: isSortByField(sortBy) ? sortBy : "priority",
      sortOrder: sortOrder === "desc" ? "desc" : "asc",
      sessionLinkedFirst: sessionLinkedFirst !== false,
    });
  }
  return views.length > 0 ? views : DEFAULT_VIEWS;
}

function isGroupByField(v: unknown): v is GroupByField {
  return v === "team" || v === "project" || v === "status" || v === "priority" || v === "none";
}

function isSortByField(v: unknown): v is SortByField {
  return v === "priority" || v === "updated" || v === "created" || v === "status";
}

const GROUP_BY_CYCLE: GroupByField[] = ["team", "project", "status", "priority", "none"];
const SORT_BY_CYCLE: SortByField[] = ["priority", "updated", "created", "status"];

export function cycleGroupBy(current: GroupByField): GroupByField {
  const idx = GROUP_BY_CYCLE.indexOf(current);
  return GROUP_BY_CYCLE[(idx + 1) % GROUP_BY_CYCLE.length];
}

export function cycleSortBy(current: SortByField): SortByField {
  const idx = SORT_BY_CYCLE.indexOf(current);
  return SORT_BY_CYCLE[(idx + 1) % SORT_BY_CYCLE.length];
}

export function toggleSortOrder(current: "asc" | "desc"): "asc" | "desc" {
  return current === "asc" ? "desc" : "asc";
}
```

- [ ] **Step 2: Add panelViews to JmuxConfig**

In `src/config.ts`, add to `JmuxConfig`:

```typescript
import type { PanelView } from "./panel-view";

export interface JmuxConfig {
  // ... existing fields ...
  panelViews?: PanelView[];
}
```

- [ ] **Step 3: Write tests**

```typescript
// src/__tests__/panel-view.test.ts
import { describe, test, expect } from "bun:test";
import { parseViews, DEFAULT_VIEWS, cycleGroupBy, cycleSortBy, toggleSortOrder } from "../panel-view";

describe("parseViews", () => {
  test("returns defaults for undefined input", () => {
    expect(parseViews(undefined)).toEqual(DEFAULT_VIEWS);
  });

  test("returns defaults for empty array", () => {
    expect(parseViews([])).toEqual(DEFAULT_VIEWS);
  });

  test("parses valid view", () => {
    const views = parseViews([{
      id: "test", label: "Test", source: "issues",
      filter: { scope: "assigned" }, sortBy: "priority", sortOrder: "asc",
    }]);
    expect(views).toHaveLength(1);
    expect(views[0].id).toBe("test");
    expect(views[0].groupBy).toBe("none");
    expect(views[0].sessionLinkedFirst).toBe(true);
  });

  test("rejects invalid source+scope combo", () => {
    const views = parseViews([{
      id: "bad", label: "Bad", source: "issues",
      filter: { scope: "reviewing" },
    }]);
    expect(views).toEqual(DEFAULT_VIEWS);
  });

  test("skips invalid entries but keeps valid ones", () => {
    const views = parseViews([
      { id: "good", label: "Good", source: "mrs", filter: { scope: "authored" }, sortBy: "updated", sortOrder: "desc" },
      { id: "", label: "", source: "bad" },
    ]);
    expect(views).toHaveLength(1);
    expect(views[0].id).toBe("good");
  });
});

describe("view cycling", () => {
  test("cycleGroupBy wraps around", () => {
    expect(cycleGroupBy("team")).toBe("project");
    expect(cycleGroupBy("none")).toBe("team");
  });

  test("cycleSortBy wraps around", () => {
    expect(cycleSortBy("priority")).toBe("updated");
    expect(cycleSortBy("status")).toBe("priority");
  });

  test("toggleSortOrder", () => {
    expect(toggleSortOrder("asc")).toBe("desc");
    expect(toggleSortOrder("desc")).toBe("asc");
  });
});
```

- [ ] **Step 4: Run tests and commit**

Run: `bun test src/__tests__/panel-view.test.ts`
Expected: PASS

```bash
git add src/panel-view.ts src/__tests__/panel-view.test.ts src/config.ts
git commit -m "feat: add PanelView types, config parsing, defaults, and view cycling"
```

---

### Task 3: New Adapter Methods

**Files:**
- Modify: `src/adapters/gitlab.ts`
- Modify: `src/adapters/linear.ts`
- Modify: `src/__tests__/adapters/gitlab.test.ts`
- Modify: `src/__tests__/adapters/linear.test.ts`

- [ ] **Step 1: Add getMyMergeRequests and getMrsAwaitingMyReview to GitLab**

Add after `pollMergeRequestsByIds` in `src/adapters/gitlab.ts`:

```typescript
  async getMyMergeRequests(): Promise<MergeRequest[]> {
    const resp = await this.fetch(
      `${this.baseUrl}/merge_requests?scope=created_by_me&state=opened&per_page=100`,
    );
    if (!resp.ok) return [];
    const mrs = await resp.json();
    if (!Array.isArray(mrs)) return [];
    return mrs.map((mr: any) => this.mapMergeRequest(mr));
  }

  async getMrsAwaitingMyReview(): Promise<MergeRequest[]> {
    // Need current user's username for reviewer filter
    let username = "";
    try {
      const userResp = await this.fetch(`${this.baseUrl}/user`);
      if (userResp.ok) {
        const user = await userResp.json();
        username = user.username ?? "";
      }
    } catch {}
    if (!username) return [];
    const resp = await this.fetch(
      `${this.baseUrl}/merge_requests?reviewer_username=${encodeURIComponent(username)}&state=opened&per_page=100`,
    );
    if (!resp.ok) return [];
    const mrs = await resp.json();
    if (!Array.isArray(mrs)) return [];
    return mrs.map((mr: any) => this.mapMergeRequest(mr));
  }
```

Also extend `mapMergeRequest` to populate the new fields:

```typescript
  private mapMergeRequest(raw: any): MergeRequest {
    // ... existing code ...
    return {
      // ... existing fields ...
      author: raw.author?.username ?? raw.author?.name ?? undefined,
      reviewers: Array.isArray(raw.reviewers) ? raw.reviewers.map((r: any) => r.username ?? r.name) : undefined,
      updatedAt: raw.updated_at ? new Date(raw.updated_at).getTime() : undefined,
    };
  }
```

- [ ] **Step 2: Add getMyIssues to Linear**

Add after `searchIssues` in `src/adapters/linear.ts`:

```typescript
  async getMyIssues(): Promise<Issue[]> {
    if (this.authState !== "ok") return [];
    const query = `
      query {
        viewer {
          assignedIssues(first: 100, filter: { state: { type: { nin: ["completed", "canceled"] } } }) {
            nodes {
              id identifier title
              state { name }
              assignee { name }
              team { name }
              project { name }
              priority
              updatedAt
              attachments { nodes { url } }
              url
            }
          }
        }
      }
    `;
    const resp = await this.graphql(query, {});
    if (!resp?.data?.viewer?.assignedIssues?.nodes) return [];
    return resp.data.viewer.assignedIssues.nodes.map((n: any) => this.mapIssue(n));
  }
```

Extend `mapIssue` to populate new fields:

```typescript
  private mapIssue(raw: any): Issue {
    return {
      // ... existing fields ...
      team: raw.team?.name ?? undefined,
      project: raw.project?.name ?? undefined,
      priority: typeof raw.priority === "number" ? raw.priority : undefined,
      updatedAt: raw.updatedAt ? new Date(raw.updatedAt).getTime() : undefined,
    };
  }
```

- [ ] **Step 3: Add tests**

Add to GitLab tests:
```typescript
describe("getMyMergeRequests", () => {
  test("returns empty array when not authenticated", async () => {
    const adapter = new GitLabAdapter({ type: "gitlab" });
    const results = await adapter.getMyMergeRequests();
    expect(results).toEqual([]);
  });
});
```

Add to Linear tests:
```typescript
describe("getMyIssues", () => {
  test("returns empty array when not authenticated", async () => {
    const adapter = new LinearAdapter({ type: "linear" });
    const results = await adapter.getMyIssues();
    expect(results).toEqual([]);
  });
});
```

- [ ] **Step 4: Run tests and commit**

Run: `bun test src/__tests__/adapters/gitlab.test.ts src/__tests__/adapters/linear.test.ts`
Expected: PASS

```bash
git add src/adapters/gitlab.ts src/adapters/linear.ts src/__tests__/adapters/gitlab.test.ts src/__tests__/adapters/linear.test.ts
git commit -m "feat: add getMyIssues, getMyMergeRequests, getMrsAwaitingMyReview to adapters"
```

---

### Task 4: Global Polling

**Files:**
- Modify: `src/adapters/poll-coordinator.ts`
- Modify: `src/__tests__/adapters/poll-coordinator.test.ts`

- [ ] **Step 1: Add global caches and timer to PollCoordinator**

Add fields after existing private fields:

```typescript
  private globalIssues: Issue[] = [];
  private globalMrs: MergeRequest[] = [];
  private globalReviewMrs: MergeRequest[] = [];
  private globalTimer: ReturnType<typeof setInterval> | null = null;
```

Add constant:
```typescript
const GLOBAL_INTERVAL_MS = 300_000; // 5 minutes
```

Add public getters:
```typescript
  getGlobalIssues(): Issue[] { return this.globalIssues; }
  getGlobalMrs(): MergeRequest[] { return this.globalMrs; }
  getGlobalReviewMrs(): MergeRequest[] { return this.globalReviewMrs; }
```

- [ ] **Step 2: Add pollGlobal method**

```typescript
  async pollGlobal(): Promise<void> {
    const { codeHost, issueTracker } = this.opts;

    if (issueTracker && issueTracker.authState === "ok") {
      try {
        this.globalIssues = await issueTracker.getMyIssues();
      } catch {}
    }

    if (codeHost && codeHost.authState === "ok") {
      try {
        this.globalMrs = await codeHost.getMyMergeRequests();
      } catch {}
      try {
        this.globalReviewMrs = await codeHost.getMrsAwaitingMyReview();
      } catch {}
    }

    this.opts.onUpdate("__global__");
  }

  async refreshGlobalItem(type: "mr" | "issue", id: string): Promise<void> {
    const { codeHost, issueTracker } = this.opts;
    if (type === "mr" && codeHost && codeHost.authState === "ok") {
      try {
        const fresh = await codeHost.pollMergeRequest(id);
        const idx = this.globalMrs.findIndex((m) => m.id === id);
        if (idx >= 0) this.globalMrs[idx] = fresh;
        const ridx = this.globalReviewMrs.findIndex((m) => m.id === id);
        if (ridx >= 0) this.globalReviewMrs[ridx] = fresh;
      } catch {}
    }
    if (type === "issue" && issueTracker && issueTracker.authState === "ok") {
      try {
        const fresh = await issueTracker.pollIssue(id);
        const idx = this.globalIssues.findIndex((i) => i.id === id);
        if (idx >= 0) this.globalIssues[idx] = fresh;
      } catch {}
    }
    this.opts.onUpdate("__global__");
  }
```

- [ ] **Step 3: Update start/stop to include global timer**

```typescript
  start(): void {
    this.startActivePolling();
    this.startBackgroundPolling();
    this.startGlobalPolling();
  }

  stop(): void {
    if (this.activeTimer) { clearInterval(this.activeTimer); this.activeTimer = null; }
    if (this.backgroundTimer) { clearInterval(this.backgroundTimer); this.backgroundTimer = null; }
    if (this.globalTimer) { clearInterval(this.globalTimer); this.globalTimer = null; }
  }

  private startGlobalPolling(): void {
    this.globalTimer = setInterval(() => {
      this.pollGlobal().catch(() => {});
    }, GLOBAL_INTERVAL_MS);
  }
```

- [ ] **Step 4: Update tests**

Add mock methods to the mock code host in tests:
```typescript
    getMyMergeRequests: mock(() => Promise.resolve([])),
    getMrsAwaitingMyReview: mock(() => Promise.resolve([])),
```

Add mock method to any mock issue tracker:
```typescript
    getMyIssues: mock(() => Promise.resolve([])),
```

Add test:
```typescript
  test("global polling lifecycle", () => {
    const coordinator = new PollCoordinator({
      codeHost: null,
      issueTracker: null,
      onUpdate: () => {},
      getSessionDir: () => "/tmp",
      sessionState: null,
    });
    coordinator.start();
    expect(coordinator.getGlobalIssues()).toEqual([]);
    expect(coordinator.getGlobalMrs()).toEqual([]);
    expect(coordinator.getGlobalReviewMrs()).toEqual([]);
    coordinator.stop();
  });
```

- [ ] **Step 5: Run tests and commit**

Run: `bun test src/__tests__/adapters/poll-coordinator.test.ts`
Expected: PASS

```bash
git add src/adapters/poll-coordinator.ts src/__tests__/adapters/poll-coordinator.test.ts
git commit -m "feat: add global polling with 5-minute cadence and action-triggered re-poll"
```

---

### Task 5: View Rendering Engine

**Files:**
- Create: `src/panel-view-renderer.ts`
- Test: `src/__tests__/panel-view-renderer.test.ts`

This is the core of the feature — the generic data pipeline and renderer.

- [ ] **Step 1: Create panel-view-renderer.ts with types and pipeline**

```typescript
// src/panel-view-renderer.ts
import type { CellGrid } from "./types";
import { ColorMode } from "./types";
import { createGrid, writeString, type CellAttrs } from "./cell-grid";
import type { PanelView } from "./panel-view";
import type { Issue, MergeRequest } from "./adapters/types";

export interface RenderableItem {
  id: string;
  type: "issue" | "mr";
  primary: string;
  title: string;
  status: string;
  meta: string;
  group: string;
  subGroup: string;
  sessionLinked: boolean;
  priority: number;
  updatedAt: number;
  raw: Issue | MergeRequest;
}

export type ViewNode =
  | { kind: "group"; label: string; count: number; collapsed: boolean; depth: number }
  | { kind: "item"; item: RenderableItem; depth: number };

export interface ViewState {
  selectedIndex: number;
  collapsedGroups: Set<string>;
  scrollOffset: number;
}

export function createViewState(): ViewState {
  return { selectedIndex: 0, collapsedGroups: new Set(), scrollOffset: 0 };
}

// --- Data Pipeline ---

export function transformIssues(issues: Issue[], linkedIds: Set<string>): RenderableItem[] {
  return issues.map((issue) => ({
    id: issue.id,
    type: "issue" as const,
    primary: issue.identifier,
    title: issue.title,
    status: issue.status,
    meta: issue.assignee ?? "",
    group: issue.team ?? "",
    subGroup: issue.status ?? "",
    sessionLinked: linkedIds.has(issue.id),
    priority: issue.priority ?? 0,
    updatedAt: issue.updatedAt ?? 0,
    raw: issue,
  }));
}

export function transformMrs(mrs: MergeRequest[], linkedIds: Set<string>): RenderableItem[] {
  return mrs.map((mr) => ({
    id: mr.id,
    type: "mr" as const,
    primary: `!${mr.id.split(":")[1] ?? mr.id}`,
    title: mr.title,
    status: mr.status,
    meta: `${mr.sourceBranch} → ${mr.targetBranch}`,
    group: "",
    subGroup: mr.status,
    sessionLinked: linkedIds.has(mr.id),
    priority: 0,
    updatedAt: mr.updatedAt ?? 0,
    raw: mr,
  }));
}

function getField(item: RenderableItem, field: string): string {
  switch (field) {
    case "team": return item.type === "issue" ? (item.raw as Issue).team ?? "" : "";
    case "project": return item.type === "issue" ? (item.raw as Issue).project ?? "" : "";
    case "status": return item.status;
    case "priority": return String(item.priority);
    default: return "";
  }
}

export function buildViewNodes(
  items: RenderableItem[],
  view: PanelView,
  collapsedGroups: Set<string>,
): ViewNode[] {
  // Partition: session-linked first
  let ordered = items;
  if (view.sessionLinkedFirst) {
    const linked = items.filter((i) => i.sessionLinked);
    const unlinked = items.filter((i) => !i.sessionLinked);
    ordered = [...linked, ...unlinked];
  }

  // Sort within partition
  ordered = sortItems(ordered, view.sortBy, view.sortOrder);

  if (view.groupBy === "none") {
    return ordered.map((item) => ({ kind: "item", item, depth: 0 }));
  }

  // Group
  const groups = new Map<string, RenderableItem[]>();
  for (const item of ordered) {
    const key = getField(item, view.groupBy);
    const list = groups.get(key) ?? [];
    list.push(item);
    groups.set(key, list);
  }

  const nodes: ViewNode[] = [];
  for (const [label, groupItems] of groups) {
    const groupKey = label;
    const collapsed = collapsedGroups.has(groupKey);
    nodes.push({ kind: "group", label: label || "(none)", count: groupItems.length, collapsed, depth: 0 });

    if (collapsed) continue;

    if (view.subGroupBy !== "none") {
      const subGroups = new Map<string, RenderableItem[]>();
      for (const item of groupItems) {
        const subKey = getField(item, view.subGroupBy);
        const list = subGroups.get(subKey) ?? [];
        list.push(item);
        subGroups.set(subKey, list);
      }
      for (const [subLabel, subItems] of subGroups) {
        const subKey = `${groupKey}:${subLabel}`;
        const subCollapsed = collapsedGroups.has(subKey);
        nodes.push({ kind: "group", label: subLabel || "(none)", count: subItems.length, collapsed: subCollapsed, depth: 1 });
        if (!subCollapsed) {
          for (const item of subItems) {
            nodes.push({ kind: "item", item, depth: 2 });
          }
        }
      }
    } else {
      for (const item of groupItems) {
        nodes.push({ kind: "item", item, depth: 1 });
      }
    }
  }

  return nodes;
}

function sortItems(items: RenderableItem[], sortBy: string, order: "asc" | "desc"): RenderableItem[] {
  const sorted = [...items].sort((a, b) => {
    let cmp = 0;
    switch (sortBy) {
      case "priority": cmp = (a.priority || 99) - (b.priority || 99); break;
      case "updated": cmp = b.updatedAt - a.updatedAt; break;
      case "created": cmp = a.updatedAt - b.updatedAt; break;
      case "status": cmp = a.status.localeCompare(b.status); break;
    }
    return order === "desc" ? -cmp : cmp;
  });
  return sorted;
}

// --- Rendering ---

const CURSOR_ATTRS: CellAttrs = { fg: (0xFB << 16) | (0xD4 << 8) | 0xB8, fgMode: ColorMode.RGB };
const LINKED_ATTRS: CellAttrs = { fg: 2, fgMode: ColorMode.Palette };
const UNLINKED_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
const TITLE_ATTRS: CellAttrs = { fg: (0xC9 << 16) | (0xD1 << 8) | 0xD9, fgMode: ColorMode.RGB };
const GROUP_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, bold: true };
const PRIORITY_ATTRS: Record<number, CellAttrs> = {
  1: { fg: 1, fgMode: ColorMode.Palette, bold: true },
  2: { fg: (0xFF << 16) | (0x8C << 8) | 0x00, fgMode: ColorMode.RGB },
  3: { fg: 3, fgMode: ColorMode.Palette },
  4: { fg: 8, fgMode: ColorMode.Palette, dim: true },
};
const DIM_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
const DETAIL_LABEL: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
const DETAIL_VALUE: CellAttrs = { fg: (0xC9 << 16) | (0xD1 << 8) | 0xD9, fgMode: ColorMode.RGB };
const DETAIL_KEY: CellAttrs = { fg: 2, fgMode: ColorMode.Palette };
const SEPARATOR_ATTRS: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };

const DETAIL_ROWS = 8;
const MIN_ROWS_FOR_DETAIL = 15;

export function renderView(
  nodes: ViewNode[],
  cols: number,
  rows: number,
  state: ViewState,
): CellGrid {
  const grid = createGrid(cols, rows);
  const showDetail = rows >= MIN_ROWS_FOR_DETAIL;
  const listRows = showDetail ? rows - DETAIL_ROWS - 1 : rows; // -1 for separator

  // Render list
  let visibleIdx = 0;
  for (let i = 0; i < nodes.length && visibleIdx < listRows + state.scrollOffset; i++) {
    if (visibleIdx < state.scrollOffset) { visibleIdx++; continue; }
    const row = visibleIdx - state.scrollOffset;
    if (row >= listRows) break;
    const node = nodes[i];
    const isSelected = i === state.selectedIndex;

    if (node.kind === "group") {
      renderGroupHeader(grid, row, cols, node, isSelected);
    } else {
      renderItem(grid, row, cols, node.item, node.depth, isSelected);
    }
    visibleIdx++;
  }

  // Render detail pane
  if (showDetail) {
    const sepRow = listRows;
    const sepChar = "─".repeat(cols);
    writeString(grid, sepRow, 0, sepChar, SEPARATOR_ATTRS);

    const selectedNode = nodes[state.selectedIndex];
    if (selectedNode?.kind === "item") {
      renderDetail(grid, sepRow + 1, cols, DETAIL_ROWS, selectedNode.item);
    } else if (selectedNode?.kind === "group") {
      const detailRow = sepRow + 1;
      writeString(grid, detailRow, 2, `${selectedNode.label} — ${selectedNode.count} items`, GROUP_ATTRS);
    }
  }

  return grid;
}

function renderGroupHeader(grid: CellGrid, row: number, cols: number, node: Extract<ViewNode, { kind: "group" }>, selected: boolean): void {
  const indent = node.depth * 2;
  let col = indent;
  if (selected) {
    writeString(grid, row, col, node.collapsed ? "▸" : "▾", CURSOR_ATTRS);
  } else {
    writeString(grid, row, col, node.collapsed ? "▸" : "▾", DIM_ATTRS);
  }
  col += 2;
  const label = `${node.label} (${node.count})`;
  writeString(grid, row, col, label, selected ? { ...GROUP_ATTRS, fg: (0xFB << 16) | (0xD4 << 8) | 0xB8, fgMode: ColorMode.RGB } : GROUP_ATTRS);
}

function renderItem(grid: CellGrid, row: number, cols: number, item: RenderableItem, depth: number, selected: boolean): void {
  const indent = depth * 2;
  let col = indent;

  // Cursor
  if (selected) {
    writeString(grid, row, col, "▸", CURSOR_ATTRS);
    col += 2;
  } else {
    col += 2;
  }

  // Linked indicator
  writeString(grid, row, col, item.sessionLinked ? "●" : "○", item.sessionLinked ? LINKED_ATTRS : UNLINKED_ATTRS);
  col += 2;

  // Priority badge (right-aligned)
  const priBadge = item.priority > 0 && item.priority <= 4 ? `P${item.priority}` : "";
  const priCol = priBadge ? cols - priBadge.length - 1 : cols;

  // Primary + title
  const maxTextLen = priCol - col - 1;
  let text = `${item.primary} ${item.title}`;
  if (text.length > maxTextLen) {
    text = text.slice(0, maxTextLen - 1) + "\u2026";
  }
  writeString(grid, row, col, text, selected ? { ...TITLE_ATTRS, bold: true } : TITLE_ATTRS);

  if (priBadge) {
    const priAttrs = PRIORITY_ATTRS[item.priority] ?? DIM_ATTRS;
    writeString(grid, row, priCol, priBadge, priAttrs);
  }
}

function renderDetail(grid: CellGrid, startRow: number, cols: number, maxRows: number, item: RenderableItem): void {
  const pad = 2;
  let row = startRow;

  if (item.type === "issue") {
    const issue = item.raw as Issue;
    writeString(grid, row, pad, `${issue.identifier} ${issue.title}`.slice(0, cols - pad * 2), { ...DETAIL_VALUE, bold: true });
    row++;
    let col = pad;
    writeString(grid, row, col, `Status: `, DETAIL_LABEL);
    col += 8;
    writeString(grid, row, col, issue.status, DETAIL_VALUE);
    if (issue.priority != null && issue.priority > 0) {
      col += issue.status.length + 3;
      writeString(grid, row, col, `Priority: P${issue.priority}`, DETAIL_LABEL);
    }
    row++;
    writeString(grid, row, pad, `Assignee: `, DETAIL_LABEL);
    writeString(grid, row, pad + 10, issue.assignee ?? "Unassigned", DETAIL_VALUE);
    row++;
    if (issue.team) {
      writeString(grid, row, pad, `Team: `, DETAIL_LABEL);
      writeString(grid, row, pad + 6, issue.team, DETAIL_VALUE);
      row++;
    }
    if (issue.linkedMrUrls.length > 0) {
      const mrList = issue.linkedMrUrls.map((u) => {
        const m = u.match(/merge_requests\/(\d+)/);
        return m ? `!${m[1]}` : "MR";
      }).join(", ");
      writeString(grid, row, pad, `MRs: `, DETAIL_LABEL);
      writeString(grid, row, pad + 5, mrList.slice(0, cols - pad * 2 - 5), DETAIL_VALUE);
      row++;
    }
    row++;
    writeString(grid, row, pad, "[o]", DETAIL_KEY);
    writeString(grid, row, pad + 3, " Open  ", DETAIL_LABEL);
    writeString(grid, row, pad + 10, "[n]", DETAIL_KEY);
    writeString(grid, row, pad + 13, " Session  ", DETAIL_LABEL);
    writeString(grid, row, pad + 23, "[l]", DETAIL_KEY);
    writeString(grid, row, pad + 26, " Link", DETAIL_LABEL);
    row++;
    writeString(grid, row, pad, "[s]", DETAIL_KEY);
    writeString(grid, row, pad + 3, " Status", DETAIL_LABEL);
  } else {
    const mr = item.raw as MergeRequest;
    writeString(grid, row, pad, `${item.primary} ${mr.title}`.slice(0, cols - pad * 2), { ...DETAIL_VALUE, bold: true });
    row++;
    let col = pad;
    const statusLabel = mr.status.charAt(0).toUpperCase() + mr.status.slice(1);
    writeString(grid, row, col, statusLabel, DETAIL_VALUE);
    col += statusLabel.length + 2;
    writeString(grid, row, col, `${mr.sourceBranch} → ${mr.targetBranch}`.slice(0, cols - col - pad), DETAIL_LABEL);
    row++;
    if (mr.pipeline) {
      const glyphs: Record<string, string> = { passed: "✓", running: "⟳", failed: "✗", pending: "○", canceled: "—" };
      writeString(grid, row, pad, `${glyphs[mr.pipeline.state] ?? "?"} Pipeline ${mr.pipeline.state}`, DETAIL_VALUE);
      row++;
    }
    writeString(grid, row, pad, `Approvals: ${mr.approvals.current}/${mr.approvals.required}`, DETAIL_VALUE);
    row++;
    if (mr.author) {
      writeString(grid, row, pad, `Author: `, DETAIL_LABEL);
      writeString(grid, row, pad + 8, mr.author, DETAIL_VALUE);
      row++;
    }
    row++;
    writeString(grid, row, pad, "[o]", DETAIL_KEY);
    writeString(grid, row, pad + 3, " Open  ", DETAIL_LABEL);
    writeString(grid, row, pad + 10, "[l]", DETAIL_KEY);
    writeString(grid, row, pad + 13, " Link  ", DETAIL_LABEL);
    writeString(grid, row, pad + 20, "[a]", DETAIL_KEY);
    writeString(grid, row, pad + 23, " Approve", DETAIL_LABEL);
    row++;
    if (mr.status === "draft") {
      writeString(grid, row, pad, "[r]", DETAIL_KEY);
      writeString(grid, row, pad + 3, " Ready", DETAIL_LABEL);
    }
  }
}
```

- [ ] **Step 2: Write tests**

```typescript
// src/__tests__/panel-view-renderer.test.ts
import { describe, test, expect } from "bun:test";
import {
  transformIssues,
  transformMrs,
  buildViewNodes,
  renderView,
  createViewState,
  type RenderableItem,
} from "../panel-view-renderer";
import type { PanelView } from "../panel-view";
import type { Issue, MergeRequest } from "../adapters/types";

const ISSUE: Issue = {
  id: "i1", identifier: "ENG-1234", title: "Fix auth", status: "In Progress",
  assignee: "jarred", linkedMrUrls: [], webUrl: "",
  team: "Platform", project: "Auth", priority: 1, updatedAt: 1000,
};

const ISSUE2: Issue = {
  id: "i2", identifier: "ENG-1235", title: "Add logging", status: "Todo",
  assignee: "alice", linkedMrUrls: [], webUrl: "",
  team: "Platform", project: "Infra", priority: 3, updatedAt: 2000,
};

const ISSUE3: Issue = {
  id: "i3", identifier: "ENG-1236", title: "Fix CSS", status: "In Progress",
  assignee: "jarred", linkedMrUrls: [], webUrl: "",
  team: "Frontend", priority: 2, updatedAt: 3000,
};

const VIEW: PanelView = {
  id: "test", label: "Test", source: "issues",
  filter: { scope: "assigned" },
  groupBy: "team", subGroupBy: "status",
  sortBy: "priority", sortOrder: "asc",
  sessionLinkedFirst: true,
};

function extractText(grid: { cells: Array<Array<{ char: string }>> }): string {
  return grid.cells.map((row) => row.map((c) => c.char).join("")).join("\n");
}

describe("transformIssues", () => {
  test("transforms issues with session-linked detection", () => {
    const items = transformIssues([ISSUE, ISSUE2], new Set(["i1"]));
    expect(items).toHaveLength(2);
    expect(items[0].sessionLinked).toBe(true);
    expect(items[1].sessionLinked).toBe(false);
    expect(items[0].primary).toBe("ENG-1234");
  });
});

describe("buildViewNodes", () => {
  test("groups by team with subgroup by status", () => {
    const items = transformIssues([ISSUE, ISSUE2, ISSUE3], new Set());
    const nodes = buildViewNodes(items, VIEW, new Set());
    const groupNodes = nodes.filter((n) => n.kind === "group");
    expect(groupNodes.length).toBeGreaterThanOrEqual(2); // Platform, Frontend
  });

  test("no grouping returns flat list", () => {
    const flatView: PanelView = { ...VIEW, groupBy: "none", subGroupBy: "none" };
    const items = transformIssues([ISSUE, ISSUE2], new Set());
    const nodes = buildViewNodes(items, flatView, new Set());
    expect(nodes.every((n) => n.kind === "item")).toBe(true);
  });

  test("collapsed group hides children", () => {
    const items = transformIssues([ISSUE, ISSUE2], new Set());
    const collapsed = new Set(["Platform"]);
    const nodes = buildViewNodes(items, VIEW, collapsed);
    const platformGroup = nodes.find((n) => n.kind === "group" && n.label === "Platform");
    expect(platformGroup).toBeDefined();
    // Items under Platform should not appear
    const platformItems = nodes.filter((n) => n.kind === "item" && (n.item.raw as Issue).team === "Platform");
    expect(platformItems).toHaveLength(0);
  });

  test("session-linked items sorted first", () => {
    const items = transformIssues([ISSUE, ISSUE2, ISSUE3], new Set(["i3"]));
    const flatView: PanelView = { ...VIEW, groupBy: "none", subGroupBy: "none" };
    const nodes = buildViewNodes(items, flatView, new Set());
    const firstItem = nodes.find((n) => n.kind === "item");
    expect(firstItem?.kind === "item" && firstItem.item.id).toBe("i3");
  });
});

describe("renderView", () => {
  test("renders items into grid", () => {
    const items = transformIssues([ISSUE], new Set());
    const nodes = buildViewNodes(items, { ...VIEW, groupBy: "none", subGroupBy: "none" }, new Set());
    const grid = renderView(nodes, 40, 20, createViewState());
    const text = extractText(grid);
    expect(text).toContain("ENG-1234");
  });

  test("renders detail pane when rows >= 15", () => {
    const items = transformIssues([ISSUE], new Set());
    const nodes = buildViewNodes(items, { ...VIEW, groupBy: "none", subGroupBy: "none" }, new Set());
    const grid = renderView(nodes, 40, 20, createViewState());
    const text = extractText(grid);
    expect(text).toContain("[o]");
    expect(text).toContain("[n]");
  });

  test("no detail pane when rows < 15", () => {
    const items = transformIssues([ISSUE], new Set());
    const nodes = buildViewNodes(items, { ...VIEW, groupBy: "none", subGroupBy: "none" }, new Set());
    const grid = renderView(nodes, 40, 10, createViewState());
    const text = extractText(grid);
    expect(text).toContain("ENG-1234");
    expect(text).not.toContain("[n]");
  });

  test("renders group headers", () => {
    const items = transformIssues([ISSUE, ISSUE3], new Set());
    const nodes = buildViewNodes(items, VIEW, new Set());
    const grid = renderView(nodes, 40, 30, createViewState());
    const text = extractText(grid);
    expect(text).toContain("Platform");
    expect(text).toContain("Frontend");
  });
});
```

- [ ] **Step 3: Run tests and commit**

Run: `bun test src/__tests__/panel-view-renderer.test.ts`
Expected: PASS

```bash
git add src/panel-view-renderer.ts src/__tests__/panel-view-renderer.test.ts
git commit -m "feat: add view rendering engine with grouped lists, detail pane, and data pipeline"
```

---

### Task 6: InfoPanel Migration

**Files:**
- Modify: `src/info-panel.ts`
- Modify: `src/__tests__/info-panel.test.ts`

- [ ] **Step 1: Change InfoPanel from hardcoded tabs to PanelView-driven**

Replace `InfoTab` and the tab management to support dynamic view IDs:

```typescript
export type InfoTab = "diff" | string; // "diff" is special, others are view IDs

export interface InfoPanelConfig {
  viewIds: string[];  // ordered list of view IDs to show as tabs
  viewLabels: Map<string, string>;  // id → label for tab bar rendering
}
```

Update constructor, `rebuildTabs`, `updateConfig` to work with view IDs. The `"diff"` tab is always first. Other tabs come from the config's `viewIds`.

- [ ] **Step 2: Update tests**

Migrate tests from `{ hasCodeHost: true, hasIssueTracker: false }` to `{ viewIds: ["my-issues"], viewLabels: new Map([["my-issues", "Issues"]]) }`.

- [ ] **Step 3: Run tests and commit**

Run: `bun test src/__tests__/info-panel.test.ts`
Expected: PASS

```bash
git add src/info-panel.ts src/__tests__/info-panel.test.ts
git commit -m "feat: migrate InfoPanel from hardcoded tabs to PanelView-driven dynamic tabs"
```

---

### Task 7: Input Router — View Cycling and New Actions

**Files:**
- Modify: `src/input-router.ts`
- Modify: `src/__tests__/input-router.test.ts`

- [ ] **Step 1: Add new callbacks to InputRouterOptions**

```typescript
  onPanelCycleGroupBy?: () => void;
  onPanelCycleSubGroupBy?: () => void;
  onPanelCycleSortBy?: () => void;
  onPanelToggleSortOrder?: () => void;
  onPanelToggleCollapse?: () => void;
  onPanelCreateSession?: () => void;  // 'n' key
  onPanelLinkToSession?: () => void;  // 'l' key
```

- [ ] **Step 2: Add key handling in panel-focused block**

In the `panelTabsActive` section, add before existing action keys:

```typescript
      if (data === "g" && this.opts.onPanelCycleGroupBy) { this.opts.onPanelCycleGroupBy(); return; }
      if (data === "G" && this.opts.onPanelCycleSubGroupBy) { this.opts.onPanelCycleSubGroupBy(); return; }
      if (data === "/" && this.opts.onPanelCycleSortBy) { this.opts.onPanelCycleSortBy(); return; }
      if (data === "?" && this.opts.onPanelToggleSortOrder) { this.opts.onPanelToggleSortOrder(); return; }
      if (data === "\r" && this.opts.onPanelToggleCollapse) { this.opts.onPanelToggleCollapse(); return; }
      if (data === "n" && this.opts.onPanelCreateSession) { this.opts.onPanelCreateSession(); return; }
      if (data === "l" && this.opts.onPanelLinkToSession) { this.opts.onPanelLinkToSession(); return; }
```

Also add `n` and `l` to the existing action key check so they're intercepted alongside `o`, `r`, `a`, `s`.

- [ ] **Step 3: Add tests and commit**

```bash
git add src/input-router.ts src/__tests__/input-router.test.ts
git commit -m "feat: add view cycling, collapse toggle, and session actions to input router"
```

---

### Task 8: Main.ts Integration

**Files:**
- Modify: `src/main.ts`
- Remove: `src/info-panel-mr.ts`, `src/info-panel-issues.ts`

- [ ] **Step 1: Import new modules, initialize views**

```typescript
import { parseViews, cycleGroupBy, cycleSortBy, toggleSortOrder, type PanelView } from "./panel-view";
import { transformIssues, transformMrs, buildViewNodes, renderView, createViewState, type ViewState } from "./panel-view-renderer";
```

Load views from config:
```typescript
const panelViews = parseViews(userConfig.panelViews);
const viewStates = new Map<string, ViewState>();
for (const view of panelViews) {
  viewStates.set(view.id, createViewState());
}
```

- [ ] **Step 2: Update InfoPanel initialization**

Replace `new InfoPanel({ hasCodeHost, hasIssueTracker })` with view-driven config, filtering by adapter auth state.

- [ ] **Step 3: Update renderFrame**

Replace the `renderMrTab`/`renderIssuesTab` calls with:
- Look up the active view by ID from `panelViews`
- Select dataset from `pollCoordinator.getGlobalIssues()` / `getGlobalMrs()` / `getGlobalReviewMrs()`
- Transform, build nodes, render via `renderView`

- [ ] **Step 4: Wire view cycling callbacks**

```typescript
onPanelCycleGroupBy: () => {
  const view = getActiveView();
  if (!view) return;
  view.groupBy = cycleGroupBy(view.groupBy);
  applyViewSetting(view);
  scheduleRender();
},
// ... similar for subGroupBy, sortBy, sortOrder
```

With debounced `applyViewSetting` that writes back to config.

- [ ] **Step 5: Wire collapse toggle**

```typescript
onPanelToggleCollapse: () => {
  const view = getActiveView();
  if (!view) return;
  const state = viewStates.get(view.id);
  if (!state) return;
  const nodes = getCurrentNodes();
  const selected = nodes[state.selectedIndex];
  if (selected?.kind === "group") {
    const key = selected.label; // or composite key for subgroups
    if (state.collapsedGroups.has(key)) state.collapsedGroups.delete(key);
    else state.collapsedGroups.add(key);
    scheduleRender();
  }
},
```

- [ ] **Step 6: Wire create session from issue**

```typescript
onPanelCreateSession: () => {
  const view = getActiveView();
  if (!view || view.source !== "issues") return;
  const state = viewStates.get(view.id);
  const nodes = getCurrentNodes();
  const selected = nodes[state?.selectedIndex ?? 0];
  if (selected?.kind !== "item" || selected.item.type !== "issue") return;
  const issue = selected.item.raw as Issue;
  const name = sanitizeTmuxSessionName(issue.identifier.toLowerCase());
  // Open new-session modal with pre-filled name, auto-link on creation
  // ... (reuse existing NewSessionModal flow with pre-filled name)
},
```

- [ ] **Step 7: Wire action-triggered re-poll**

After approve/status-update/mark-ready actions, call `pollCoordinator.refreshGlobalItem()`.

- [ ] **Step 8: Trigger initial global poll after adapter auth**

In `initAdapters().then(...)`, add:
```typescript
pollCoordinator.pollGlobal();
```

- [ ] **Step 9: Remove old renderers**

Delete `src/info-panel-mr.ts` and `src/info-panel-issues.ts`. Remove their imports from main.ts. Remove their test files or keep them as dead code cleanup.

- [ ] **Step 10: Run typecheck and all tests**

Run: `bun run typecheck && bun test`
Expected: Clean

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat: wire global panel views — configurable tabs, global polling, detail pane, task dispatch"
```
