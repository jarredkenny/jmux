# Panel Search Filter

Add inline search/filter to the issues and MR panel, plus a manual refresh keybind.

## Scope

- Inline filter bar activated by `/` in the panel
- Local fuzzy filtering against identifier + title using existing `fuzzy.ts`
- Manual refresh via `r`
- Keybind reshuffling: `/` moves from sortBy cycling to filter, `S` takes over sortBy cycling, `r` changes from "mark MR ready" to refresh

## Filter UX

Press `/` while the panel is focused to enter filter mode. A filter bar appears at the top row of the list area showing `/ {query}`. The list area shrinks by one row to accommodate it.

As you type, the list filters in real-time. Arrow keys still navigate the filtered list. `Esc` clears the filter text and dismisses the bar. `Enter` performs the normal action on the selected item (toggle group collapse, etc.) — it does not dismiss the filter bar.

The filter bar is transient — it only exists while you're actively filtering. There is no "locked filter" state.

## Data flow

Filtering happens between `transformIssues()` and `buildViewNodes()` in main.ts:

```
pollCoordinator.getGlobalIssues()
  → transformIssues()        // Issue[] → RenderableItem[]
  → filter by fuzzyMatch()   // NEW: when filterQuery is non-empty
  → buildViewNodes()         // RenderableItem[] → ViewNode[]
  → renderView()             // ViewNode[] → CellGrid
```

The filter matches against `item.primary + " " + item.title` (e.g., `"LIN-123 Fix login bug"`). Items are sorted by fuzzy match score (best match first) when a filter is active, overriding the normal sort order.

`buildViewNodes` and `renderView` are unchanged in signature. The only renderer change is `renderView` rendering the filter bar in the top row of the list when `filterQuery` is non-empty.

## State changes

### ViewState

Add `filterQuery: string` (default `""`).

### InputRouter

Add a `panelFilterActive: boolean` flag. When true:

- Printable characters (length 1, charCode >= 32): append to filter query via new `onPanelFilterInput(char)` callback
- Backspace (`\x7f`): remove last character via `onPanelFilterBackspace()` callback
- Arrow Up/Down: still route to `onPanelSelectPrev/Next` (navigation works while filtering)
- `Esc` (`\x1b` alone, not a sequence): call `onPanelFilterClear()`, set `panelFilterActive = false`
- `r`: routes to refresh (works in filter mode)
- All other keys (action keys like `o`, `n`, `l`, `s`, `c`, `C`, `Enter`): pass through to their normal handlers as-is — filter mode doesn't block actions

When `/` is pressed and `panelFilterActive` is false, set `panelFilterActive = true` and call `onPanelFilterStart()`.

### InputRouter callbacks (new)

```typescript
onPanelFilterStart?: () => void;
onPanelFilterInput?: (char: string) => void;
onPanelFilterBackspace?: () => void;
onPanelFilterClear?: () => void;
```

## Keybind changes

| Key | Before | After |
|-----|--------|-------|
| `/` | Cycle sortBy | Open filter mode |
| `S` | (unbound) | Cycle sortBy |
| `r` | Mark MR ready | Refresh issues/MRs |

## Refresh

`r` triggers `pollCoordinator.refreshAll()` (or equivalent) to re-fetch issues and MRs immediately. Works regardless of whether filter mode is active.

## Render changes

### Filter bar

When `filterQuery` is non-empty, the first row of the list area renders:

```
/ query text here
```

Styled: `/` in green (same as `DETAIL_KEY`), query text in the default title color. Cursor logically sits at end of query text.

The list content starts from row 1 instead of row 0, and `listRows` decreases by 1.

### Action bar

Add `[/] Search` and `[r] Refresh` to both issue and MR action bars.

Remove `[r] Ready` from the MR action bar.

### Selection reset

When filter text changes, reset `selectedIndex` to 0 and `scrollOffset` to 0 so the selection doesn't point at a now-invisible item.

## Files touched

| File | Change |
|------|--------|
| `src/panel-view-renderer.ts` | Add `filterQuery` to `ViewState`, render filter bar row in `renderView`, update action bar |
| `src/input-router.ts` | Add filter mode routing, new callbacks, rebind `/` → filter, add `S` → sortBy, `r` → refresh |
| `src/main.ts` | Wire filter callbacks, apply fuzzy filter between transform and build, wire refresh callback |
| `src/__tests__/input-router.test.ts` | Update tests for keybind changes, add filter mode tests |
