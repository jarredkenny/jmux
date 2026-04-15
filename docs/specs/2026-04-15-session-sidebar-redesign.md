# Session Sidebar Redesign

## Overview

Redesign the sidebar session rendering from a variable-height (2–3 row) layout to a fixed 2-row layout that surfaces Linear issue IDs and GitLab MR IDs directly, and introduces a `SessionView` type to separate data resolution from rendering.

## Layout

Every session renders as exactly 2 rows:

```
▎● session_name              ENG-1234
▎   branch_name     2:45   !123 ✓
```

**Row 1:** Session name (left, truncatable) + Linear issue identifier (right, fixed width).

**Row 2:** Git branch (left, truncatable) + cache timer (center-right, when active) + MR ID with pipeline glyph (right, fixed width).

**Fallback (no link data):**

```
▎● session_name
▎   branch_name
```

No third row. No window count.

## Removed

- **Window count** (`3w`) — dropped from the name row.
- **Third "link row"** — issue identifiers and MR count are promoted into rows 1 and 2. The `hasLinkData` field on render items is eliminated.

## MR Selection

When multiple MRs exist in a session's context, display the most recently **created** (not updated). Requires adding `createdAt` to the `MergeRequest` interface — the GitLab API provides `created_at`, it just isn't mapped through yet.

## Architecture

### New file: `src/session-view.ts`

#### `SessionView` interface

```typescript
interface SessionView {
  sessionId: string;
  sessionName: string;

  // Flags — drive the indicator column (col 1)
  hasActivity: boolean;
  hasAttention: boolean;

  // Row 1, right-aligned
  linearId: string | null;       // e.g. "ENG-1234"

  // Row 2, left-aligned
  branch: string | null;

  // Row 2, center-right (shown when cache timer is active)
  timerText: string | null;
  timerRemaining: number;        // seconds — drives timer color

  // Row 2, right-aligned
  mrId: string | null;           // e.g. "!123"
  pipelineState: string | null;  // "passed"|"running"|"failed"|"pending"|"canceled"
}
```

#### `buildSessionView` factory

```typescript
function buildSessionView(
  session: SessionInfo,
  ctx: SessionContext | undefined,
  timerState: CacheTimerState | undefined,
  activitySet: Set<string>,
): SessionView
```

Responsibilities:
- Picks the first issue identifier from `ctx.issues` (if any).
- Selects the latest MR by `createdAt` from `ctx.mrs`.
- Extracts pipeline state from that MR.
- Computes timer text and remaining seconds from `timerState`.
- Sets activity/attention from `activitySet` and `session.attention`.

What it does **not** do:
- Truncation (depends on sidebar width — renderer's job).
- Visual treatment for active/hover state (renderer's job).

### Changes to `src/sidebar.ts`

#### `renderSession`

Receives a pre-built `SessionView` instead of reaching into sidebar state maps. The method becomes a layout-and-paint function:

1. Determine active/hover visual state (backgrounds, marker colors).
2. Compute available columns for left-aligned items after reserving space for right-aligned items.
3. Truncate session name and branch with `…` as needed.
4. Write strings to grid.

#### `buildRenderPlan`

- Drop `hasLinkData` from session render items.

#### `itemHeight`

- Sessions always return 2 (no conditional third row).

#### Removed state

- `formatTimer` and `cacheTimerAttrs` can stay in `sidebar.ts` (they're rendering helpers) or be extracted. The timer **computation** (remaining seconds, text formatting) moves to `buildSessionView`.

### Changes to `src/adapters/types.ts`

Add `createdAt` to `MergeRequest`:

```typescript
interface MergeRequest {
  // ... existing fields ...
  createdAt?: number;   // epoch ms
  updatedAt?: number;
}
```

### Changes to GitLab adapter

Map `created_at` from the GitLab API response to `createdAt` on `MergeRequest`.

## Truncation Priority

Right-aligned items hold their width. Left-aligned items truncate with `…`.

**Row 1:** `ENG-1234` holds → `session_name` truncates.

**Row 2:** `!123 ✓` holds, then timer holds → `branch_name` truncates.

When the sidebar is very narrow, right-aligned items may also need to be dropped entirely (not truncated — either shown in full or omitted). Priority for dropping: timer first, then MR ID, then Linear ID.

## Data Flow

```
SessionInfo (tmux)  ──┐
SessionContext (poll) ─┤── buildSessionView() ──→ SessionView ──→ renderSession()
CacheTimerState ───────┤
activitySet ───────────┘
```

## Testing

`buildSessionView` is pure — takes data in, returns a struct. Test cases:
- Session with no context → null fields
- Session with issue + MR + pipeline → all fields populated
- Multiple MRs → picks latest by `createdAt`
- Timer active → `timerText` and `timerRemaining` set
- Timer expired or absent → null

Existing sidebar render tests need updating to reflect the 2-row layout and removal of window count / link row.

## Scope

This is a rendering + data-model change. No changes to:
- Polling (PollCoordinator)
- Context resolution (resolveSessionContext)
- Adapters (except adding `createdAt` mapping in GitLab)
- Input handling / click targets (row-to-session mapping still works, just no third row)
