# Global Panel Views

**Date:** 2026-04-13
**Status:** Draft
**Depends on:** `docs/specs/2026-04-12-info-panel-adapters-design.md` (implemented), `docs/specs/2026-04-12-session-links-design.md` (implemented)

## Summary

Replace the session-scoped MR and Issues tabs with configurable global views that show everything the user owns. Views are declarative config objects that define what to fetch, how to group/sort it, and what actions are available. Session-linked items float to the top. The panel becomes a task dispatch center — pick an issue, create a session, start working.

## Problem

The current panel is session-contextual: it shows the MR and issues linked to the active session's branch. This requires an MR to exist before anything surfaces, and gives no visibility into the user's full workload. To pick up a new task or check on other MRs, the user must leave jmux and open Linear/GitLab in a browser.

## Design

### View Definition Schema

A `PanelView` is a declarative configuration object. Views live in `~/.config/jmux/config.json` under `panelViews`.

```typescript
interface PanelView {
  id: string;
  label: string;
  source: "issues" | "mrs";
  filter: {
    scope: "assigned" | "authored" | "reviewing" | "all";
    state?: "open" | "merged" | "closed" | "all";
  };
  groupBy?: "team" | "project" | "status" | "priority" | "none";
  subGroupBy?: "team" | "project" | "status" | "priority" | "none";
  sortBy: "priority" | "updated" | "created" | "status";
  sortOrder: "asc" | "desc";
  sessionLinkedFirst: boolean;
}
```

Config example:

```json
{
  "panelViews": [
    {
      "id": "my-issues",
      "label": "Issues",
      "source": "issues",
      "filter": { "scope": "assigned" },
      "groupBy": "team",
      "subGroupBy": "status",
      "sortBy": "priority",
      "sortOrder": "asc",
      "sessionLinkedFirst": true
    },
    {
      "id": "my-mrs",
      "label": "My MRs",
      "source": "mrs",
      "filter": { "scope": "authored", "state": "open" },
      "sortBy": "updated",
      "sortOrder": "desc",
      "sessionLinkedFirst": true
    },
    {
      "id": "review",
      "label": "Review",
      "source": "mrs",
      "filter": { "scope": "reviewing", "state": "open" },
      "sortBy": "created",
      "sortOrder": "asc",
      "sessionLinkedFirst": false
    }
  ]
}
```

When `panelViews` is absent, these three defaults are used. The Diff tab is always present and not part of the view system — it's the hunk PTY. Tab bar: `Diff | Issues | My MRs | Review` (or whatever views are configured).

### Relationship to Existing Panel Tabs

The current `InfoPanel` manages tabs as `"diff" | "mr" | "issues"`. This changes to `"diff"` plus one tab per configured `PanelView`. The `InfoPanel` holds an ordered list of view IDs and delegates rendering to the view engine.

The existing `renderMrTab` and `renderIssuesTab` are replaced by a single generic `renderViewTab` that takes a `PanelView`, a dataset, and a view state (selection, collapse). The existing per-session `SessionContext.mrs` and `SessionContext.issues` remain for sidebar glyphs and session-linked item detection, but are no longer the panel's data source.

### Data Model Extensions

The `Issue` type gains fields for grouping and sorting:

```typescript
interface Issue {
  // existing fields
  id: string;
  identifier: string;
  title: string;
  status: string;
  assignee: string | null;
  linkedMrUrls: string[];
  webUrl: string;
  // new fields
  team?: string;
  project?: string;
  priority?: number;   // 0=none, 1=urgent, 2=high, 3=medium, 4=low
  updatedAt?: number;  // epoch ms
}
```

The `MergeRequest` type gains:

```typescript
interface MergeRequest {
  // existing fields
  // new fields
  author?: string;
  reviewers?: string[];
  updatedAt?: number;  // epoch ms
}
```

### New Adapter Methods

```typescript
// IssueTrackerAdapter
getMyIssues(): Promise<Issue[]>;

// CodeHostAdapter
getMyMergeRequests(): Promise<MergeRequest[]>;
getMrsAwaitingMyReview(): Promise<MergeRequest[]>;
```

**Linear `getMyIssues`:** Queries `viewer { assignedIssues }` with team, project, priority, state, updatedAt fields.

**GitLab `getMyMergeRequests`:** `/merge_requests?scope=created_by_me&state=opened` with author, reviewers, updated_at fields.

**GitLab `getMrsAwaitingMyReview`:** `/merge_requests?reviewer_username=<me>&state=opened`.

### Global Polling

Global data is polled separately from per-session data.

- **Global poll interval:** 5 minutes (hardcoded)
- **First fetch:** immediately after adapter authentication
- **Per-session polling:** unchanged (20s active, 3min background) — keeps session-linked items fresh

The `PollCoordinator` gains:
- `globalIssues: Issue[]` — cached full list from `getMyIssues()`
- `globalMrs: MergeRequest[]` — cached full list from `getMyMergeRequests()`
- `globalReviewMrs: MergeRequest[]` — cached full list from `getMrsAwaitingMyReview()`
- `pollGlobal(): Promise<void>` — fetches all three, triggers render
- A separate `globalTimer` on the 5-minute interval

The panel reads from these global caches. Session-linked item detection compares global item IDs against the active session's `SessionContext.mrs[].id` and `SessionContext.issues[].id`.

### View Rendering Engine

A generic renderer takes a `PanelView` definition, a dataset, and view state, then produces a `CellGrid`.

**Data pipeline:**

1. **Select dataset** — based on `view.source` and `view.filter.scope`:
   - `issues` + `assigned` → `globalIssues`
   - `mrs` + `authored` → `globalMrs`
   - `mrs` + `reviewing` → `globalReviewMrs`

2. **Transform to RenderableItem** — normalize issues and MRs into a common shape:
   ```typescript
   interface RenderableItem {
     id: string;
     type: "issue" | "mr";
     primary: string;       // "ENG-1234" or "!482"
     title: string;
     status: string;
     meta: string;          // branch info for MR, assignee for issue
     group?: string;        // value of groupBy field
     subGroup?: string;     // value of subGroupBy field
     sessionLinked: boolean;
     priority?: number;
     updatedAt?: number;
   }
   ```

3. **Partition** — if `sessionLinkedFirst`, split into linked (top) and unlinked (bottom)

4. **Group** — by `groupBy`, then `subGroupBy` within each group

5. **Sort** — within each group by `sortBy`/`sortOrder`

6. **Render** — into CellGrid with group headers, items, selection cursor

**Item layout (single line, fits ~40 columns):**
```
│ ▸ ● ENG-1234 Fix auth token r…  P1 │
│   ○ ENG-1235 Add rate limiting   P3 │
```

- `▸` selection cursor (selected item only)
- `●` session-linked / `○` not linked (or space when no adapters)
- Identifier + title (truncated to fit)
- Priority badge right-aligned (`P1`–`P4`, dim for `P0`/none)

**Group headers:**
```
│ ▾ Platform (4)                      │
│   ▾ In Progress (2)                 │
│     ▸ ● ENG-1234 Fix auth t…    P1 │
│       ○ ENG-1235 Add rate l…    P3 │
│   ▸ Todo (2)                        │
```

- `▾` expanded / `▸` collapsed
- Group name + item count
- Subgroups indented one level
- Collapsed groups hide children, show count only

**Collapse state:** Ephemeral, not persisted. `Enter` on a group/subgroup header toggles.

### View Cycling Keybindings

When the panel is focused on a view tab (not Diff):

| Key | Action |
|-----|--------|
| `g` | Cycle `groupBy`: team → project → status → priority → none |
| `G` | Cycle `subGroupBy`: same options |
| `s` | Cycle `sortBy`: priority → updated → created → status |
| `S` | Toggle `sortOrder`: asc ↔ desc |
| `↑`/`↓` | Move selection (through items and group headers) |
| `Enter` | Toggle collapse on group header |

`g`, `G`, `s`, `S` write back to config via the existing `applySetting` pattern. The view's `id` identifies which entry in `panelViews` to update.

### Panel Actions

**On issue items:**

| Key | Action |
|-----|--------|
| `o` | Open in browser |
| `n` | Create new session for issue — pre-fills session name with issue identifier, opens new-session modal, auto-links issue after creation |
| `l` | Link to current session |
| `s` | Update status (ListModal picker) |

**On MR items:**

| Key | Action |
|-----|--------|
| `o` | Open in browser |
| `l` | Link to current session |
| `a` | Approve |
| `r` | Mark ready (undraft) |

**On group headers:**

| Key | Action |
|-----|--------|
| `Enter` | Toggle collapse |

**Create session from issue (`n`):**
1. Read issue identifier (e.g., `ENG-1234`)
2. Open `NewSessionModal` with name pre-filled as the sanitized identifier
3. After session creation, call `sessionState.addLink(sessionName, { type: "issue", id: issue.id })`
4. Switch to the new session

This reuses the existing modal — just pre-fills the name and attaches a post-creation hook.

### Navigation

The selection cursor moves through all visible items: group headers, subgroup headers, and leaf items. Collapsed groups are skipped (only the collapsed header is selectable). The cursor wraps at top and bottom.

Up/down arrow keys move one item. The panel scrolls to keep the cursor visible.

### Config Schema Extension

```json
{
  "panelViews": [
    {
      "id": "my-issues",
      "label": "Issues",
      "source": "issues",
      "filter": { "scope": "assigned" },
      "groupBy": "team",
      "subGroupBy": "status",
      "sortBy": "priority",
      "sortOrder": "asc",
      "sessionLinkedFirst": true
    }
  ]
}
```

Validation: `panelViews` must be an array of objects. Each must have `id` (unique string), `label` (non-empty string), `source` ("issues" or "mrs"), `filter.scope` (one of the valid scopes), `sortBy`, `sortOrder`. `groupBy`, `subGroupBy` default to `"none"`. `sessionLinkedFirst` defaults to `true`.

Invalid views are skipped with a stderr warning. If all views are invalid or `panelViews` is empty/missing, the three defaults are used.

## File Layout

### New Files

- `src/panel-view.ts` — `PanelView` type, default views, config parsing/validation, view cycling logic
- `src/panel-view-renderer.ts` — generic view renderer: data pipeline (transform → partition → group → sort → render), `RenderableItem`, group/subgroup headers, selection cursor, collapse state
- `src/__tests__/panel-view.test.ts`
- `src/__tests__/panel-view-renderer.test.ts`

### Modified Files

- `src/adapters/types.ts` — add `team`, `project`, `priority`, `updatedAt` to `Issue`; add `author`, `reviewers`, `updatedAt` to `MergeRequest`; add `getMyIssues`, `getMyMergeRequests`, `getMrsAwaitingMyReview` to adapter interfaces
- `src/adapters/gitlab.ts` — implement `getMyMergeRequests`, `getMrsAwaitingMyReview`, extend `mapMergeRequest` with new fields
- `src/adapters/linear.ts` — implement `getMyIssues`, extend `mapIssue` with new fields
- `src/adapters/poll-coordinator.ts` — add global caches, `pollGlobal`, global timer, expose cached lists
- `src/info-panel.ts` — tabs from `PanelView[]` instead of hardcoded, pass view config to renderer
- `src/info-panel-mr.ts` — remove (replaced by panel-view-renderer)
- `src/info-panel-issues.ts` — remove (replaced by panel-view-renderer)
- `src/input-router.ts` — add `g`, `G`, `s`, `S` key routing, `Enter` for collapse toggle, `n` and `l` action keys
- `src/config.ts` — add `panelViews` to `JmuxConfig`
- `src/main.ts` — load panel views from config, wire global polling, wire actions (`n` creates session, `l` links), pass global data to renderer

### Unchanged

`src/sidebar.ts` (three-line rows use per-session context, not global), `src/renderer.ts`, `src/diff-panel.ts`, `src/session-state.ts`, tmux communication layer, CLI.

## Testing Strategy

- **PanelView config:** Unit tests for parsing, validation, defaults, view cycling state transitions
- **View renderer:** Unit tests for the full pipeline — transform → partition → group → sort → render. Test with various combinations: no grouping, single group, nested groups, collapsed groups, session-linked partitioning, all sort orders
- **Adapter methods:** Unit tests with mocked HTTP responses for `getMyIssues`, `getMyMergeRequests`, `getMrsAwaitingMyReview`
- **Global polling:** Unit tests for `pollGlobal` lifecycle, timer management, cache updates
- **Navigation:** Unit tests for cursor movement through grouped lists with collapse

No integration tests hitting real APIs.
