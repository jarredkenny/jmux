# Session Sidebar Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign sidebar session rows from variable 2-3 lines to a fixed 2-line layout showing Linear ID and MR+pipeline inline, backed by a new `SessionView` type.

**Architecture:** New `src/session-view.ts` exports a `SessionView` interface and `buildSessionView` factory. The factory resolves which Linear issue and MR to display from the existing `SessionContext`. The sidebar's `renderSession` is rewritten to paint a `SessionView` instead of reaching into multiple state maps. Window count is removed. The third "link row" is eliminated.

**Tech Stack:** TypeScript, Bun test runner, xterm.js CellGrid rendering

---

### Task 1: Add `createdAt` to MergeRequest and map it in GitLab adapter

**Files:**
- Modify: `src/adapters/types.ts:6-18` (MergeRequest interface)
- Modify: `src/adapters/gitlab.ts:189-207` (mapMergeRequest)

- [ ] **Step 1: Add `createdAt` field to `MergeRequest` interface**

In `src/adapters/types.ts`, add `createdAt` next to `updatedAt`:

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
  createdAt?: number;  // epoch ms
  updatedAt?: number;  // epoch ms
}
```

- [ ] **Step 2: Map `created_at` in GitLab adapter**

In `src/adapters/gitlab.ts`, in the `mapMergeRequest` method, add the mapping alongside `updatedAt`:

```typescript
createdAt: raw.created_at ? new Date(raw.created_at).getTime() : undefined,
updatedAt: raw.updated_at ? new Date(raw.updated_at).getTime() : undefined,
```

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: PASS (new field is optional, no consumers break)

- [ ] **Step 4: Commit**

```bash
git add src/adapters/types.ts src/adapters/gitlab.ts
git commit -m "feat: add createdAt to MergeRequest, map from GitLab API"
```

---

### Task 2: Create `SessionView` interface and `buildSessionView` factory

**Files:**
- Create: `src/session-view.ts`
- Create: `src/__tests__/session-view.test.ts`

- [ ] **Step 1: Write tests for `buildSessionView`**

Create `src/__tests__/session-view.test.ts`:

```typescript
import { describe, test, expect } from "bun:test";
import { buildSessionView } from "../session-view";
import type { SessionInfo, CacheTimerState } from "../types";
import type { SessionContext, MergeRequest, LinkSource } from "../adapters/types";

function makeSession(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    id: "$0",
    name: "test-session",
    attached: false,
    activity: 0,
    attention: false,
    windowCount: 1,
    ...overrides,
  };
}

function makeMr(overrides: Partial<MergeRequest & { source: LinkSource }> = {}): MergeRequest & { source: LinkSource } {
  return {
    id: "proj:1",
    title: "Test MR",
    status: "open",
    sourceBranch: "feat",
    targetBranch: "main",
    pipeline: null,
    approvals: { required: 0, current: 0 },
    webUrl: "",
    source: "branch",
    ...overrides,
  };
}

function makeCtx(overrides: Partial<SessionContext> = {}): SessionContext {
  return {
    sessionName: "test-session",
    dir: "/tmp",
    branch: "main",
    remote: null,
    mrs: [],
    issues: [],
    resolvedAt: Date.now(),
    ...overrides,
  };
}

describe("buildSessionView", () => {
  test("returns null fields when no context", () => {
    const view = buildSessionView(makeSession(), undefined, undefined, new Set());
    expect(view.sessionId).toBe("$0");
    expect(view.sessionName).toBe("test-session");
    expect(view.linearId).toBeNull();
    expect(view.branch).toBeNull();
    expect(view.mrId).toBeNull();
    expect(view.pipelineState).toBeNull();
    expect(view.timerText).toBeNull();
    expect(view.hasActivity).toBe(false);
    expect(view.hasAttention).toBe(false);
  });

  test("uses gitBranch from session", () => {
    const view = buildSessionView(
      makeSession({ gitBranch: "feat/cool" }),
      undefined,
      undefined,
      new Set(),
    );
    expect(view.branch).toBe("feat/cool");
  });

  test("populates linearId from first issue", () => {
    const ctx = makeCtx({
      issues: [
        { id: "i1", identifier: "ENG-1234", title: "T", status: "In Progress", assignee: null, linkedMrUrls: [], webUrl: "", source: "branch" as LinkSource },
        { id: "i2", identifier: "ENG-5678", title: "T", status: "Todo", assignee: null, linkedMrUrls: [], webUrl: "", source: "branch" as LinkSource },
      ],
    });
    const view = buildSessionView(makeSession(), ctx, undefined, new Set());
    expect(view.linearId).toBe("ENG-1234");
  });

  test("selects latest MR by createdAt", () => {
    const ctx = makeCtx({
      mrs: [
        makeMr({ id: "proj:10", createdAt: 1000 }),
        makeMr({ id: "proj:20", createdAt: 3000 }),
        makeMr({ id: "proj:15", createdAt: 2000 }),
      ],
    });
    const view = buildSessionView(makeSession(), ctx, undefined, new Set());
    expect(view.mrId).toBe("!20");
  });

  test("falls back to last MR in array when no createdAt", () => {
    const ctx = makeCtx({
      mrs: [
        makeMr({ id: "proj:10" }),
        makeMr({ id: "proj:20" }),
      ],
    });
    const view = buildSessionView(makeSession(), ctx, undefined, new Set());
    expect(view.mrId).toBe("!20");
  });

  test("extracts pipeline state from selected MR", () => {
    const ctx = makeCtx({
      mrs: [
        makeMr({ id: "proj:5", createdAt: 1000, pipeline: { state: "passed", webUrl: "" } }),
        makeMr({ id: "proj:10", createdAt: 2000, pipeline: { state: "failed", webUrl: "" } }),
      ],
    });
    const view = buildSessionView(makeSession(), ctx, undefined, new Set());
    expect(view.mrId).toBe("!10");
    expect(view.pipelineState).toBe("failed");
  });

  test("computes timer text and remaining", () => {
    const now = Date.now();
    const timer: CacheTimerState = { lastRequestTime: now - 60_000, cacheWasHit: true };
    const view = buildSessionView(makeSession(), undefined, timer, new Set());
    expect(view.timerText).toBe("4:00");
    expect(view.timerRemaining).toBe(240);
  });

  test("timer shows 0:00 when expired", () => {
    const timer: CacheTimerState = { lastRequestTime: Date.now() - 400_000, cacheWasHit: true };
    const view = buildSessionView(makeSession(), undefined, timer, new Set());
    expect(view.timerText).toBe("0:00");
    expect(view.timerRemaining).toBe(0);
  });

  test("timer is null when no timer state", () => {
    const view = buildSessionView(makeSession(), undefined, undefined, new Set());
    expect(view.timerText).toBeNull();
  });

  test("sets hasActivity from activitySet", () => {
    const view = buildSessionView(makeSession(), undefined, undefined, new Set(["$0"]));
    expect(view.hasActivity).toBe(true);
  });

  test("sets hasAttention from session", () => {
    const view = buildSessionView(makeSession({ attention: true }), undefined, undefined, new Set());
    expect(view.hasAttention).toBe(true);
  });

  test("MR id extracts iid from compound id", () => {
    const ctx = makeCtx({
      mrs: [makeMr({ id: "my%2Fproject:42" })],
    });
    const view = buildSessionView(makeSession(), ctx, undefined, new Set());
    expect(view.mrId).toBe("!42");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/session-view.test.ts`
Expected: FAIL — `buildSessionView` does not exist yet

- [ ] **Step 3: Implement `SessionView` and `buildSessionView`**

Create `src/session-view.ts`:

```typescript
import type { SessionInfo, CacheTimerState } from "./types";
import type { SessionContext } from "./adapters/types";

const CACHE_TIMER_TTL = 300; // seconds

export interface SessionView {
  sessionId: string;
  sessionName: string;

  hasActivity: boolean;
  hasAttention: boolean;

  // Row 1, right-aligned
  linearId: string | null;

  // Row 2, left-aligned
  branch: string | null;

  // Row 2, center-right
  timerText: string | null;
  timerRemaining: number;

  // Row 2, right-aligned
  mrId: string | null;
  pipelineState: string | null;
}

function formatTimer(remaining: number): string {
  const minutes = Math.floor(remaining / 60);
  const seconds = remaining % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

/** Extract the MR iid (e.g. "42") from compound id "project:42" */
function extractMrIid(compoundId: string): string {
  const colonIdx = compoundId.lastIndexOf(":");
  return colonIdx >= 0 ? compoundId.slice(colonIdx + 1) : compoundId;
}

export function buildSessionView(
  session: SessionInfo,
  ctx: SessionContext | undefined,
  timerState: CacheTimerState | undefined,
  activitySet: Set<string>,
): SessionView {
  // Linear ID: first issue identifier
  const linearId = ctx?.issues[0]?.identifier ?? null;

  // MR: pick latest by createdAt, fall back to last in array
  let selectedMr = null;
  if (ctx && ctx.mrs.length > 0) {
    const withCreated = ctx.mrs.filter((mr) => mr.createdAt != null);
    if (withCreated.length > 0) {
      selectedMr = withCreated.reduce((latest, mr) =>
        (mr.createdAt! > latest.createdAt!) ? mr : latest
      );
    } else {
      selectedMr = ctx.mrs[ctx.mrs.length - 1];
    }
  }

  const mrId = selectedMr ? `!${extractMrIid(selectedMr.id)}` : null;
  const pipelineState = selectedMr?.pipeline?.state ?? null;

  // Timer
  let timerText: string | null = null;
  let timerRemaining = 0;
  if (timerState) {
    const elapsed = Math.floor((Date.now() - timerState.lastRequestTime) / 1000);
    timerRemaining = Math.max(0, CACHE_TIMER_TTL - elapsed);
    timerText = formatTimer(timerRemaining);
  }

  return {
    sessionId: session.id,
    sessionName: session.name,
    hasActivity: activitySet.has(session.id),
    hasAttention: session.attention,
    linearId,
    branch: session.gitBranch ?? null,
    timerText,
    timerRemaining,
    mrId,
    pipelineState,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/session-view.test.ts`
Expected: PASS — all tests green

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/session-view.ts src/__tests__/session-view.test.ts
git commit -m "feat: add SessionView type and buildSessionView factory"
```

---

### Task 3: Rewrite sidebar rendering to use `SessionView`

This is the core change. It rewrites `renderSession`, removes `hasLinkData`/`annotateLinkData`, simplifies `itemHeight`, and drops window count.

**Files:**
- Modify: `src/sidebar.ts`

- [ ] **Step 1: Remove `hasLinkData` from `RenderItem` and `annotateLinkData`**

In `src/sidebar.ts`, change the `RenderItem` union member for sessions:

```typescript
type RenderItem =
  | { type: "group-header"; label: string; collapsed: boolean; sessionCount: number }
  | { type: "session"; sessionIndex: number; grouped: boolean; groupLabel?: string }
  | { type: "spacer" };
```

Delete the `annotateLinkData()` method entirely (lines 283-291).

Remove all calls to `this.annotateLinkData()` — there are three:
- In `updateSessions()` (line 298)
- In `toggleGroup()` (line 315)
- In `setPinnedSessions()` (line 324)
- In `setSessionContexts()` (line 351)

- [ ] **Step 2: Simplify `itemHeight`**

Replace the `itemHeight` function:

```typescript
function itemHeight(item: RenderItem): number {
  if (item.type === "session") return 2;
  return 1; // group-header or spacer
}
```

- [ ] **Step 3: Remove `hasLinkData` from `buildRenderPlan`**

In `buildRenderPlan`, every place that creates a session item currently sets `hasLinkData: false`. Remove that field from all three locations:

```typescript
// Line 211 (pinned):
items.push({ type: "session", sessionIndex: idx, grouped: true, groupLabel: PINNED_GROUP_LABEL });

// Line 229 (grouped):
items.push({ type: "session", sessionIndex: idx, grouped: true, groupLabel: group.label });

// Line 237 (ungrouped):
items.push({ type: "session", sessionIndex: idx, grouped: false });
```

- [ ] **Step 4: Add `buildSessionView` import and rewrite `renderSession`**

Add import at top of `src/sidebar.ts`:

```typescript
import { buildSessionView, type SessionView } from "./session-view";
```

Replace the entire `renderSession` method (lines 552-779) with:

```typescript
  private renderSession(
    grid: CellGrid,
    nameRow: number,
    item: Extract<RenderItem, { type: "session" }>,
  ): void {
    const sessionIdx = item.sessionIndex;
    const session = this.sessions[sessionIdx];
    if (!session) return;

    const detailRow = nameRow + 1;
    const isActive = session.id === this.activeSessionId;
    const isHovered = !isActive && this.hoveredRow !== null &&
      (this.hoveredRow === nameRow || this.hoveredRow === detailRow);

    // Build the view
    const ctx = this.sessionContexts.get(session.name);
    const timerState = this.cacheTimersEnabled ? this.cacheTimers.get(session.id) ?? undefined : undefined;
    const view = buildSessionView(session, ctx, timerState, this.activitySet);

    // Map rows to session for click handling
    this.rowToSessionIndex.set(nameRow, sessionIdx);
    if (detailRow < this.height) {
      this.rowToSessionIndex.set(detailRow, sessionIdx);
    }

    // Paint background across both rows
    if (isActive || isHovered) {
      const bg = isActive ? ACTIVE_BG : HOVER_BG;
      const bgFill = " ".repeat(this.width);
      const bgAttrs: CellAttrs = { bg, bgMode: ColorMode.RGB };
      writeString(grid, nameRow, 0, bgFill, bgAttrs);
      if (detailRow < this.height) writeString(grid, detailRow, 0, bgFill, bgAttrs);
    }

    // Active marker (left edge bar)
    if (isActive) {
      writeString(grid, nameRow, 0, "\u258e", ACTIVE_MARKER_ATTRS);
      if (detailRow < this.height) writeString(grid, detailRow, 0, "\u258e", ACTIVE_MARKER_ATTRS);
    }

    // Indicator (col 1)
    if (view.hasAttention) {
      writeString(grid, nameRow, 1, "!", ATTENTION_ATTRS);
    } else if (view.hasActivity) {
      writeString(grid, nameRow, 1, "\u25CF", ACTIVITY_ATTRS);
    }

    const bgAttrs: CellAttrs = isActive
      ? { bg: ACTIVE_BG, bgMode: ColorMode.RGB }
      : isHovered
        ? { bg: HOVER_BG, bgMode: ColorMode.RGB }
        : {};

    // --- Row 1: session name (left) + linear ID (right) ---
    const nameStart = 3;
    const linearIdStr = view.linearId ?? "";
    const linearIdCol = linearIdStr ? this.width - linearIdStr.length - 1 : this.width;
    const nameMaxLen = (linearIdStr ? linearIdCol - 1 : this.width - 1) - nameStart;
    let displayName = view.sessionName;
    if (displayName.length > nameMaxLen) {
      displayName = displayName.slice(0, Math.max(0, nameMaxLen - 1)) + "\u2026";
    }

    const nameAttrs: CellAttrs = isActive
      ? { ...ACTIVE_NAME_ATTRS }
      : isHovered
        ? { ...HOVER_NAME_ATTRS }
        : { ...INACTIVE_NAME_ATTRS };
    writeString(grid, nameRow, nameStart, displayName, nameAttrs);

    if (linearIdStr) {
      const linkAttrs: CellAttrs = { ...DIM_ATTRS, ...bgAttrs };
      writeString(grid, nameRow, linearIdCol, linearIdStr, linkAttrs);
    }

    // --- Row 2: branch (left) + timer (center-right) + MR ID + pipeline glyph (right) ---
    if (detailRow >= this.height) return;

    const detailAttrs: CellAttrs = isActive
      ? ACTIVE_DETAIL_ATTRS
      : isHovered
        ? HOVER_DETAIL_ATTRS
        : DIM_ATTRS;

    // Compute right-side content and its column positions (right to left)
    let rightEdge = this.width - 1; // rightmost column available

    // Pipeline glyph (rightmost)
    let glyphStr: string | null = null;
    let glyphAttrs: CellAttrs | null = null;
    if (view.pipelineState) {
      glyphStr = PIPELINE_GLYPH_MAP[view.pipelineState] ?? null;
      glyphAttrs = PIPELINE_GLYPH_COLORS[view.pipelineState] ?? null;
    }
    if (glyphStr && glyphAttrs) {
      writeString(grid, detailRow, rightEdge, glyphStr, { ...glyphAttrs, ...bgAttrs });
      rightEdge -= 2; // glyph + 1 space before it
    }

    // MR ID (before glyph)
    if (view.mrId) {
      const mrCol = rightEdge - view.mrId.length + 1;
      if (mrCol > nameStart) {
        writeString(grid, detailRow, mrCol, view.mrId, { ...DIM_ATTRS, ...bgAttrs });
        rightEdge = mrCol - 2; // 1 space gap before MR ID
      }
    }

    // Timer (before MR ID)
    if (view.timerText) {
      const timerAttrs = cacheTimerAttrs(view.timerRemaining, isActive, isHovered);
      const timerCol = rightEdge - view.timerText.length + 1;
      if (timerCol > nameStart) {
        writeString(grid, detailRow, timerCol, view.timerText, timerAttrs);
        rightEdge = timerCol - 2;
      }
    }

    // Branch (left, truncates to fit)
    if (view.branch) {
      const detailStart = 3;
      const maxLen = rightEdge - detailStart + 1;
      if (maxLen > 0) {
        let branch = view.branch;
        if (branch.length > maxLen) {
          branch = branch.slice(0, Math.max(0, maxLen - 1)) + "\u2026";
        }
        writeString(grid, detailRow, detailStart, branch, detailAttrs);
      }
    }
  }
```

- [ ] **Step 5: Remove the now-unused `formatTimer` function from sidebar.ts**

The `formatTimer` function (lines 82-86 of sidebar.ts) is now in `session-view.ts`. Delete it from `sidebar.ts`. Keep `cacheTimerAttrs` — it's still used in the renderer for color decisions.

- [ ] **Step 6: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/sidebar.ts
git commit -m "feat: rewrite renderSession to use SessionView, drop window count and link row"
```

---

### Task 4: Update sidebar tests

The existing tests reference window count, three-line rows, and the old detail row layout. They need to be updated to match the new 2-row layout.

**Files:**
- Modify: `src/__tests__/sidebar.test.ts`

- [ ] **Step 1: Remove the window count test**

Delete the test `"shows window count"` (lines 219-237).

- [ ] **Step 2: Update the "ungrouped sessions show directory on detail line" test**

The new layout always shows branch on row 2, never directory. Update the test:

```typescript
  test("ungrouped sessions show branch on detail line", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(
      makeSessions([
        { name: "solo", directory: "~/mydir", gitBranch: "dev" },
      ]),
    );
    const grid = sidebar.getGrid();
    // Row 2: session name, Row 3: detail
    const detailRow = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[3][i].char,
    ).join("");
    expect(detailRow).toContain("dev");
  });
```

- [ ] **Step 3: Rewrite the "Sidebar three-line rows" describe block**

Replace the entire `describe("Sidebar three-line rows", ...)` block with tests for the new 2-row layout with inline Linear ID and MR info:

```typescript
describe("Sidebar inline link data", () => {
  test("renders linear ID on name row", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "api" }]));
    sidebar.setSessionContexts(makeContexts([{
      name: "api", issueIds: ["ENG-1234"],
    }]));
    const grid = sidebar.getGrid();
    const nameRow = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[2][i].char,
    ).join("");
    expect(nameRow).toContain("ENG-1234");
    expect(nameRow).toContain("api");
  });

  test("renders MR ID on detail row", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "api", gitBranch: "feat/x" }]));
    sidebar.setSessionContexts(makeContexts([{
      name: "api", pipelineState: "passed",
    }]));
    const grid = sidebar.getGrid();
    const detailRow = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[3][i].char,
    ).join("");
    expect(detailRow).toContain("!1");
    expect(detailRow).toContain("✓");
  });

  test("sessions always take 2 rows regardless of link data", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "api" }, { name: "other" }]));
    sidebar.setSessionContexts(makeContexts([{
      name: "api", issueIds: ["ENG-1234"], mrCount: 2,
    }]));
    const grid = sidebar.getGrid();
    // Row 2: api name, Row 3: api detail, Row 4: spacer, Row 5: other name
    const row5text = Array.from({ length: SIDEBAR_WIDTH }, (_, i) => grid.cells[5][i].char).join("");
    expect(row5text).toContain("other");
  });

  test("no link data shows clean 2-row session", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "api" }, { name: "other" }]));
    const grid = sidebar.getGrid();
    // Row 2: api name, Row 3: api detail, Row 4: spacer, Row 5: other name
    const row5text = Array.from({ length: SIDEBAR_WIDTH }, (_, i) => grid.cells[5][i].char).join("");
    expect(row5text).toContain("other");
  });
});
```

- [ ] **Step 4: Update `makeContexts` helper to include `createdAt` on MRs**

In the `makeContexts` helper, add `createdAt` to MR objects so `buildSessionView` can select the latest:

```typescript
function makeContexts(
  entries: Array<{ name: string; pipelineState?: PipelineStatus["state"]; issueIds?: string[]; mrCount?: number }>,
): Map<string, SessionContext> {
  const map = new Map<string, SessionContext>();
  for (const e of entries) {
    const mrs: Array<import("../adapters/types").MergeRequest & { source: import("../adapters/types").LinkSource }> = [];
    const now = Date.now();
    if (e.pipelineState) {
      mrs.push({
        id: "proj:1", title: "Test", status: "open",
        sourceBranch: "main", targetBranch: "main",
        pipeline: { state: e.pipelineState, webUrl: "" },
        approvals: { required: 0, current: 0 },
        webUrl: "", source: "branch",
        createdAt: now,
      });
    }
    for (let i = 0; i < (e.mrCount ?? 0); i++) {
      mrs.push({
        id: `proj:mr-${i}`, title: `MR ${i}`, status: "open",
        sourceBranch: "feat", targetBranch: "main",
        pipeline: null, approvals: { required: 0, current: 0 },
        webUrl: "", source: "manual",
        createdAt: now - (e.mrCount! - i) * 1000,
      });
    }
    map.set(e.name, {
      sessionName: e.name,
      dir: "/tmp",
      branch: "main",
      remote: null,
      mrs,
      issues: (e.issueIds ?? []).map((id) => ({
        id, identifier: id, title: "Test", status: "In Progress",
        assignee: null, linkedMrUrls: [], webUrl: "", source: "manual" as import("../adapters/types").LinkSource,
      })),
      resolvedAt: Date.now(),
    });
  }
  return map;
}
```

- [ ] **Step 5: Update pipeline glyph tests**

The pipeline glyph moved from the name row to the detail row. Update the `"Sidebar pipeline glyphs"` describe block. The tests that check `allChars` across the entire grid still work (they scan all cells), but the worst-state glyph logic changed — the view picks the *latest MR's* pipeline, not the worst across all MRs. Update the worst-state test:

```typescript
  test("pipeline glyph shows state of latest MR", () => {
    const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
    sidebar.updateSessions(makeSessions([{ name: "api" }]));
    const ctx = makeContexts([{ name: "api", pipelineState: "running" }]);
    const existing = ctx.get("api")!;
    // Add an older MR with failed pipeline
    existing.mrs.push({
      id: "proj:2", title: "Second", status: "open",
      sourceBranch: "feat", targetBranch: "main",
      pipeline: { state: "failed", webUrl: "" },
      approvals: { required: 0, current: 0 },
      webUrl: "", source: "manual",
      createdAt: Date.now() - 10000, // older
    });
    sidebar.setSessionContexts(ctx);
    const grid = sidebar.getGrid();
    const allChars = grid.cells.flatMap((row) => row.map((c) => c.char)).join("");
    // Latest MR (proj:1 with createdAt: now) has running pipeline
    expect(allChars).toContain("⟳");
  });
```

- [ ] **Step 6: Run all tests**

Run: `bun test`
Expected: PASS

- [ ] **Step 7: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add src/__tests__/sidebar.test.ts
git commit -m "test: update sidebar tests for 2-row layout with inline link data"
```
