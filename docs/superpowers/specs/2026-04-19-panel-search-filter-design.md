# Panel Search Filter

Add inline search/filter to the issues and MR panel, plus a manual refresh keybind.

## Scope

- Inline filter bar activated by `/` in the panel
- Local fuzzy filtering against identifier + title using existing `fuzzy.ts`
- Manual refresh via `r`
- Keybind reshuffling: `/` moves from sortBy cycling to filter, `S` takes over sortBy cycling, `r` changes from "mark MR ready" to refresh

## Filter UX

Press `/` while the panel is focused to enter filter mode. A filter bar appears at the top row of the list area showing `/ {query}`. The list area shrinks by one row to accommodate it.

As you type, the list filters in real-time. Arrow keys still navigate the filtered list. `Esc` clears the filter text and dismisses the bar.

**Filter mode captures all printable input.** Action keys (`o`, `n`, `l`, `s`, `c`, `C`, etc.) do not fire while filter mode is active — they are treated as filter characters. To act on an item, dismiss the filter with `Esc` first. This is the vim `/` model: you are in an input mode and must exit it before issuing commands.

The filter bar is transient — it only exists while you're actively filtering. There is no "locked filter" state.

**Filter clears on tab switch.** Switching panel tabs (`[` / `]`) clears the filter text and exits filter mode. Filtering is contextual to the current view.

## Data flow

Filtering happens between `transformIssues()` and `buildViewNodes()` in main.ts:

```
pollCoordinator.getGlobalIssues()
  → transformIssues()        // Issue[] → RenderableItem[]
  → filter by fuzzyMatch()   // NEW: when filterQuery is non-empty
  → buildViewNodes()         // RenderableItem[] → ViewNode[] (groupBy forced to "none")
  → renderView()             // ViewNode[] → CellGrid
```

The filter matches against `item.primary + " " + item.title` (e.g., `"LIN-123 Fix login bug"`). Items are sorted by fuzzy match score (best match first) when a filter is active, overriding the normal sort order.

**Active filter flattens groups.** When `filterQuery` is non-empty, `buildViewNodes` is called with `groupBy` overridden to `"none"`. This prevents group headers from breaking fuzzy-score ordering and keeps the filtered list clean — when you're searching, group structure is noise.

## State changes

### ViewState

Add `filterQuery: string` (default `""`).

### InputRouter

Add a `panelFilterActive: boolean` flag. When true, all input routes through filter-mode handling before anything else in the `panelTabsActive` block:

- **Printable characters** (data.length === 1, charCode >= 32): append to filter query via `onPanelFilterInput(char)`. This captures ALL printable input including letters that are normally action keys.
- **Backspace** (`\x7f`): remove last character via `onPanelFilterBackspace()`
- **Arrow Up/Down** (`\x1b[A` / `\x1b[B`): route to `onPanelSelectPrev/Next` (navigation works while filtering)
- **Esc** (`data === "\x1b"`): call `onPanelFilterClear()`, set `panelFilterActive = false`
- **Everything else**: consumed/ignored (does not pass through to action handlers or diff panel)

**Esc detection rule:** Bare Esc is detected as `data === "\x1b"` (the data string is exactly the single ESC byte). Escape sequences like `\x1b[A` arrive as multi-byte chunks and will not match this check. This is the same assumption the router already makes for every other escape sequence comparison — if chunk delivery ever splits sequences, all escape handling in the router breaks, not just this.

When `/` is pressed and `panelFilterActive` is false, set `panelFilterActive = true` and call `onPanelFilterStart()`.

When `[` or `]` (tab switch) is pressed while `panelFilterActive` is true, clear the filter and exit filter mode before switching tabs.

### InputRouter callbacks (new)

```typescript
onPanelFilterStart?: () => void;
onPanelFilterInput?: (char: string) => void;
onPanelFilterBackspace?: () => void;
onPanelFilterClear?: () => void;
onPanelRefresh?: () => void;
```

## Keybind changes

| Key | Before | After |
|-----|--------|-------|
| `/` | Cycle sortBy | Open filter mode |
| `S` | (unbound) | Cycle sortBy |
| `r` | Mark MR ready | Refresh issues/MRs |

## Refresh

`r` calls `pollCoordinator.pollGlobal()` to re-fetch issues and MRs immediately. This is a normal panel-level keybind — it does **not** work during filter mode (filter mode captures `r` as a filter character). Dismiss the filter first if you need to refresh.

## Render changes

### Filter bar

When `filterQuery` is non-empty, the first row of the list area renders:

```
/ query text here
```

Styled: `/` in green (same as `DETAIL_KEY`), query text in the default title color. Cursor logically sits at end of query text.

The list content starts from row 1 instead of row 0, and `listRows` decreases by 1.

### Empty results

When the filter matches zero items, render `"No matches"` centered in the list area with dim styling (`DIM_ATTRS`).

### Action bar

Row 1 (existing): item-specific actions (`[o] Open`, `[n] Start`, etc.).

Row 2 (currently unused): utility actions. Add `[/] Search  [r] Refresh` to both issue and MR action bars.

Remove `[r] Ready` from the MR action bar.

### Selection reset

When filter text changes (character added or removed), reset `selectedIndex` to 0 and `scrollOffset` to 0. Since active filtering flattens groups, index 0 is always the highest-scoring match.

## Files touched

| File | Change |
|------|--------|
| `src/panel-view-renderer.ts` | Add `filterQuery` to `ViewState`, render filter bar row in `renderView`, render empty state, update action bar to use both rows |
| `src/input-router.ts` | Add `panelFilterActive` flag and filter mode routing, new callbacks, rebind `/` → filter, add `S` → sortBy, add `r` → refresh, remove `r` from action key set, clear filter on tab switch |
| `src/main.ts` | Wire filter callbacks, apply fuzzy filter + score sort between transform and build, override groupBy when filtering, wire refresh to `pollCoordinator.pollGlobal()`, clear filter state on tab switch |
| `src/__tests__/input-router.test.ts` | Update tests for keybind changes, add filter mode tests including: printable capture, Esc dismiss (`\x1b` vs `\x1b[A`), arrow navigation during filter, action keys blocked during filter, tab switch clears filter |
