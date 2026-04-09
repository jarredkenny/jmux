# Collapsible Sidebar Groups

## Summary

Add the ability to collapse and expand group sections in jmux's sidebar. Collapsed groups hide their sessions and show a session count badge. Groups are toggled via mouse click on the header or command palette entries.

## State

`Sidebar` gains a `collapsedGroups: Set<string>` field keyed by group label string. This is transient in-memory state — it resets on restart and is not persisted to config.

### API additions on `Sidebar`

- `toggleGroup(label: string): void` — adds or removes the label from the collapsed set, then rebuilds the render plan.
- `getGroupByRow(row: number): string | null` — returns the group label if the given screen row maps to a group header, otherwise `null`.
- `getGroups(): { label: string; collapsed: boolean }[]` — returns all current group labels with their collapsed state, for command palette consumption.

## Render plan

`buildRenderPlan()` accepts the collapsed set as a parameter. Behavior per group:

- **Expanded (default):** unchanged from current behavior — emits `group-header`, then alternating `session`/`spacer` items.
- **Collapsed:** emits the `group-header` item (with `collapsed: true` and `sessionCount: number` fields added to the type) followed by a single spacer. Session and per-session spacer items are omitted.

The `RenderItem` union gains two fields on the `group-header` variant:

```ts
| { type: "group-header"; label: string; collapsed: boolean; sessionCount: number }
```

`displayOrder` excludes sessions in collapsed groups. This means Ctrl-Shift-Up/Down naturally skips them.

## Rendering

### Chevron indicator

Group headers render a directional chevron at column 1:

- `▾` (U+25BE) when expanded
- `▸` (U+25B8) when collapsed

The label starts at column 3 (chevron + space). When collapsed, a ` (N)` count suffix is appended after the label, styled with `DIM_ATTRS`.

Example:
```
▸ Code/work (3)
▾ Code/personal
    jmux         1w
    main
```

### Hover state

Group header rows participate in hover highlighting. When `hoveredRow` matches a group header's screen row, the header is rendered with `HOVER_BG` background to signal clickability.

### Row mapping

A new `rowToGroupLabel: Map<number, string>` is populated during `getGrid()` alongside the existing `rowToSessionIndex`. Group header rows are added to this map instead of the session map. `getGroupByRow()` reads from it.

## Click handling (main.ts)

`onSidebarClick` gains a group-header check before the existing session check:

```
1. Existing: check sidebar.isVersionRow(row) — if true, showVersionInfo (unchanged)
2. New: check sidebar.getGroupByRow(row) — if non-null, call sidebar.toggleGroup(label), scheduleRender(), return
3. Existing: check sidebar.getSessionByRow(row) — if non-null, switchSession (unchanged)
```

## Command palette (main.ts)

When groups exist, the palette includes dynamic entries:

- **"Collapse: \<label\>"** for each expanded group — calls `sidebar.toggleGroup(label)`
- **"Expand: \<label\>"** for each collapsed group — calls `sidebar.toggleGroup(label)`

These use `sidebar.getGroups()` to enumerate available groups and their state.

## Keyboard navigation

Ctrl-Shift-Up/Down continues to cycle through sessions only. Collapsed sessions are excluded from `displayOrder` and therefore skipped. No new keybinds are introduced.

## Active session in collapsed group

Collapsing a group that contains the active session is allowed. The tmux session continues running — it's only hidden from the sidebar list. `scrollToActive()` no-ops when the active session isn't in the visible render plan.

## Session refresh after collapse

When `updateSessions()` is called (sessions created/destroyed), `buildRenderPlan()` re-runs with the current `collapsedGroups` set. Stale labels (groups that no longer exist) remain in the set harmlessly. New sessions appearing under a collapsed group label are hidden until the user expands.

## Scroll behavior

`clampScroll()` already computes total rows from the items list. Since collapsed groups emit fewer items, the scroll range automatically shrinks. No special handling needed.

## Files changed

| File | Changes |
|------|---------|
| `src/sidebar.ts` | `collapsedGroups` set, `toggleGroup()`, `getGroupByRow()`, `getGroups()`, `rowToGroupLabel` map, pass collapsed set into `buildRenderPlan()`, updated `RenderItem` type, chevron + count rendering, hover on group headers |
| `src/main.ts` | Wire `getGroupByRow()` into `onSidebarClick` before session check, add palette entries via `getGroups()` |
| `src/__tests__/sidebar.test.ts` | Tests for: toggle state, collapsed render plan excludes sessions, displayOrder excludes collapsed sessions, group header click targeting, session count in collapsed header, hover on group header, scroll adjustment after collapse |
