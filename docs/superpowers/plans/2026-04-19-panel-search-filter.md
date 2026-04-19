# Panel Search Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add inline fuzzy-search filtering to the issues/MR panel, a manual refresh keybind, and relocate sort cycling.

**Architecture:** Filter state (`filterQuery`) lives in `ViewState`. `InputRouter` gains a `panelFilterActive` mode that captures all printable input. Fuzzy filtering runs client-side between `transformIssues()` and `buildViewNodes()` in main.ts's render path, with group flattening when a filter is active. The filter bar renders as the top row of the list area in `renderView()`.

**Tech Stack:** TypeScript, Bun test runner, existing `fuzzy.ts` module

**Spec:** `docs/superpowers/specs/2026-04-19-panel-search-filter-design.md`

---

### Task 1: Add `filterQuery` to `ViewState` and `filterItems` helper

**Files:**
- Modify: `src/panel-view-renderer.ts:30-39` (ViewState, createViewState)
- Modify: `src/panel-view-renderer.ts:1-6` (imports)

- [ ] **Step 1: Add `filterQuery` to `ViewState` interface and `createViewState`**

In `src/panel-view-renderer.ts`, update the `ViewState` interface and factory:

```typescript
export interface ViewState {
  selectedIndex: number;
  collapsedGroups: Set<string>;
  scrollOffset: number;
  detailScrollOffset: number;
  filterQuery: string | null;  // null = filter off, "" = bar open but empty, "abc" = filtering
}

export function createViewState(): ViewState {
  return { selectedIndex: 0, collapsedGroups: new Set(), scrollOffset: 0, detailScrollOffset: 0, filterQuery: null };
}
```

- [ ] **Step 2: Add `filterItems` export**

Add a new import at the top of `src/panel-view-renderer.ts`:

```typescript
import { fuzzyMatch } from "./fuzzy";
```

Then add this function after `transformMrs` (after line 80):

```typescript
export function filterItems(items: RenderableItem[], query: string | null): RenderableItem[] {
  if (!query) return items;
  const scored: { item: RenderableItem; score: number }[] = [];
  for (const item of items) {
    const haystack = `${item.primary} ${item.title}`;
    const result = fuzzyMatch(query, haystack);
    if (result) scored.push({ item, score: result.score });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.item);
}
```

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: PASS (no errors)

- [ ] **Step 4: Commit**

```bash
git add src/panel-view-renderer.ts
git commit -m "feat: add filterQuery to ViewState and filterItems helper"
```

---

### Task 2: Render the filter bar and empty state in `renderView`

**Files:**
- Modify: `src/panel-view-renderer.ts:194-254` (renderView)

- [ ] **Step 1: Update `renderView` to accept and render the filter bar**

In `src/panel-view-renderer.ts`, update `renderView`. The function signature stays the same — it reads `state.filterQuery`. Add the filter bar row and empty state logic:

```typescript
export function renderView(
  nodes: ViewNode[],
  cols: number,
  rows: number,
  state: ViewState,
): CellGrid {
  const grid = createGrid(cols, rows);
  const showDetail = rows >= MIN_ROWS_FOR_DETAIL;

  // Filter bar: null = off, "" = bar visible but empty, "abc" = filtering
  const filterBarActive = state.filterQuery !== null;
  const filterBarRows = filterBarActive ? 1 : 0;

  // Layout: [filter bar] | list | separator | detail content | action bar
  const actionBarStart = showDetail ? rows - ACTION_BAR_ROWS : rows;
  const minDetailRows = 4;
  const maxListRows = showDetail ? rows - minDetailRows - 1 - ACTION_BAR_ROWS - filterBarRows : rows - filterBarRows;
  const listRows = showDetail ? Math.min(maxListRows, Math.max(3, Math.floor((rows - ACTION_BAR_ROWS - 1 - filterBarRows) * 0.5))) : rows - filterBarRows;
  const listStartRow = filterBarRows;
  const sepRow = showDetail ? listStartRow + listRows : rows;
  const detailStart = sepRow + 1;
  const detailRows = showDetail ? actionBarStart - detailStart : 0;

  // Render filter bar
  if (filterBarActive) {
    writeString(grid, 0, 1, "/", DETAIL_KEY);
    if (state.filterQuery) {
      writeString(grid, 0, 3, state.filterQuery.slice(0, cols - 4), TITLE_ATTRS);
    }
  }

  // Render list
  if (nodes.length === 0 && filterBarActive) {
    // Empty state
    const msg = "No matches";
    const msgCol = Math.max(0, Math.floor((cols - msg.length) / 2));
    writeString(grid, listStartRow + Math.floor(listRows / 2), msgCol, msg, DIM_ATTRS);
  } else {
    let visibleIdx = 0;
    for (let i = 0; i < nodes.length && visibleIdx < listRows + state.scrollOffset; i++) {
      if (visibleIdx < state.scrollOffset) { visibleIdx++; continue; }
      const row = listStartRow + visibleIdx - state.scrollOffset;
      if (row >= listStartRow + listRows) break;
      const node = nodes[i];
      const isSelected = i === state.selectedIndex;

      if (node.kind === "group") {
        renderGroupHeader(grid, row, cols, node, isSelected);
      } else {
        renderItem(grid, row, cols, node.item, node.depth, isSelected);
      }
      visibleIdx++;
    }
  }

  // Render detail pane
  if (showDetail) {
    // Separator
    writeString(grid, sepRow, 0, "─".repeat(cols), SEPARATOR_ATTRS);

    // Detail content (scrollable)
    const selectedNode = nodes[state.selectedIndex];
    if (selectedNode?.kind === "item") {
      renderDetail(grid, detailStart, cols, detailRows, selectedNode.item, state.detailScrollOffset);
    } else if (selectedNode?.kind === "group") {
      writeString(grid, detailStart, 2, `${selectedNode.label} — ${selectedNode.count} items`, GROUP_ATTRS);
    }

    // Action bar — always at the bottom
    const actionSepRow = actionBarStart - 1;
    if (actionSepRow > detailStart) {
      writeString(grid, actionSepRow, 0, "─".repeat(cols), SEPARATOR_ATTRS);
    }
    const selectedItem = selectedNode?.kind === "item" ? selectedNode.item : null;
    renderActionBar(grid, actionBarStart, cols, selectedItem);
  }

  return grid;
}
```

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 3: Run existing tests to check for regressions**

Run: `bun test`
Expected: All existing tests pass (the new `filterQuery: null` default means existing behavior is unchanged)

- [ ] **Step 4: Commit**

```bash
git add src/panel-view-renderer.ts
git commit -m "feat: render filter bar and empty state in panel view"
```

---

### Task 3: Update the action bar

**Files:**
- Modify: `src/panel-view-renderer.ts:432-467` (renderActionBar)

- [ ] **Step 1: Add utility actions row and remove `[r] Ready`**

Replace the `renderActionBar` function in `src/panel-view-renderer.ts`:

```typescript
function renderActionBar(grid: CellGrid, startRow: number, cols: number, item: RenderableItem | null): void {
  const pad = 2;

  // Row 2: utility actions (always shown, even when no item selected)
  let utilCol = pad;
  utilCol = writeAction(grid, startRow + 1, utilCol, "[/]", " Search  ");
  utilCol = writeAction(grid, startRow + 1, utilCol, "[r]", " Refresh  ");

  if (!item) return;

  if (item.type === "issue") {
    const nLabel = item.issueSessionState === "session" ? "Switch"
      : item.issueSessionState === "worktree" ? "Resume"
      : "Start";
    let col = pad;
    col = writeAction(grid, startRow, col, "[o]", " Open  ");
    col = writeAction(grid, startRow, col, "[n]", ` ${nLabel}  `);
    col = writeAction(grid, startRow, col, "[l]", " Link  ");
    col = writeAction(grid, startRow, col, "[s]", " Status  ");
    col = writeAction(grid, startRow, col, "[c]", " Copy  ");
    col = writeAction(grid, startRow, col, "[C]", " Create  ");
  } else {
    let col = pad;
    col = writeAction(grid, startRow, col, "[o]", " Open  ");
    col = writeAction(grid, startRow, col, "[l]", " Link  ");
    col = writeAction(grid, startRow, col, "[a]", " Approve  ");
  }
}
```

Extract the `writeAction` helper to module scope (move it out of `renderActionBar`), since it's now called from module scope:

```typescript
function writeAction(grid: CellGrid, row: number, col: number, key: string, label: string): number {
  writeString(grid, row, col, key, DETAIL_KEY);
  col += key.length;
  writeString(grid, row, col, label, DETAIL_LABEL);
  col += label.length;
  return col;
}
```

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add src/panel-view-renderer.ts
git commit -m "feat: add search/refresh to action bar, remove mark-ready"
```

---

### Task 4: InputRouter — add filter mode and rebind keys

**Files:**
- Modify: `src/input-router.ts:34-71` (InputRouterOptions)
- Modify: `src/input-router.ts:73-86` (InputRouter class fields)
- Modify: `src/input-router.ts:309-344` (panel keyboard handling block)

- [ ] **Step 1: Add new callbacks to `InputRouterOptions`**

In `src/input-router.ts`, add these to the `InputRouterOptions` interface after the `onPanelLinkToSession` line (line 70):

```typescript
  onPanelFilterStart?: () => void;
  onPanelFilterInput?: (char: string) => void;
  onPanelFilterBackspace?: () => void;
  onPanelFilterClear?: () => void;
  onPanelRefresh?: () => void;
```

- [ ] **Step 2: Add `panelFilterActive` flag and setter**

In the `InputRouter` class, add a new field after `panelTabsActive` (line 82):

```typescript
  private panelFilterActive = false;
```

Add a setter method after `setPanelTabsActive` (after line 103):

```typescript
  setPanelFilterActive(active: boolean): void {
    this.panelFilterActive = active;
  }
```

- [ ] **Step 3: Rewrite the panel keyboard handling block**

Replace the block from line 309 (`if (this.diffPanelFocused && this.diffPanelCols > 0) {`) through line 343 (`return;`) with the updated logic. The key changes are:

1. Tab switching (`[` / `]`) clears filter mode before switching
2. When `panelFilterActive` is true, a new block runs before all other panel keybinds, capturing printable input, backspace, arrows, and Esc
3. `/` opens filter mode instead of cycling sortBy
4. `S` cycles sortBy
5. `r` triggers refresh
6. `r` is removed from the `onPanelAction` key set

```typescript
    // When diff panel is focused, intercept tab-switching and action keys before
    // forwarding to the diff panel's underlying process
    if (this.diffPanelFocused && this.diffPanelCols > 0) {
      // Tab switching — clear filter mode first
      if (data === "[" && this.opts.onPanelPrevTab) {
        if (this.panelFilterActive) { this.panelFilterActive = false; this.opts.onPanelFilterClear?.(); }
        this.opts.onPanelPrevTab();
        return;
      }
      if (data === "]" && this.opts.onPanelNextTab) {
        if (this.panelFilterActive) { this.panelFilterActive = false; this.opts.onPanelFilterClear?.(); }
        this.opts.onPanelNextTab();
        return;
      }

      // Filter mode — captures all input when active
      if (this.panelTabsActive && this.panelFilterActive) {
        // Arrow navigation still works during filter
        if (data === "\x1b[A" && this.opts.onPanelSelectPrev) { this.opts.onPanelSelectPrev(); return; }
        if (data === "\x1b[B" && this.opts.onPanelSelectNext) { this.opts.onPanelSelectNext(); return; }
        // Esc clears filter and exits filter mode
        if (data === "\x1b") { this.panelFilterActive = false; this.opts.onPanelFilterClear?.(); return; }
        // Backspace removes last char
        if (data === "\x7f") { this.opts.onPanelFilterBackspace?.(); return; }
        // Printable chars append to filter query
        if (data.length === 1 && data.charCodeAt(0) >= 32) { this.opts.onPanelFilterInput?.(data); return; }
        // Everything else consumed
        return;
      }

      // Up/Down arrow for item selection within a tab (only on MR/Issues tabs)
      if (this.panelTabsActive) {
        if (data === "\x1b[A" && this.opts.onPanelSelectPrev) {
          this.opts.onPanelSelectPrev();
          return;
        }
        if (data === "\x1b[B" && this.opts.onPanelSelectNext) {
          this.opts.onPanelSelectNext();
          return;
        }
      }
      if (this.panelTabsActive) {
        if (data === "g" && this.opts.onPanelCycleGroupBy) { this.opts.onPanelCycleGroupBy(); return; }
        if (data === "G" && this.opts.onPanelCycleSubGroupBy) { this.opts.onPanelCycleSubGroupBy(); return; }
        if (data === "/" && this.opts.onPanelFilterStart) { this.panelFilterActive = true; this.opts.onPanelFilterStart(); return; }
        if (data === "S" && this.opts.onPanelCycleSortBy) { this.opts.onPanelCycleSortBy(); return; }
        if (data === "?" && this.opts.onPanelToggleSortOrder) { this.opts.onPanelToggleSortOrder(); return; }
        if (data === "r" && this.opts.onPanelRefresh) { this.opts.onPanelRefresh(); return; }
        if (data === "\r" && this.opts.onPanelToggleCollapse) { this.opts.onPanelToggleCollapse(); return; }
        if (data === "n" && this.opts.onPanelCreateSession) { this.opts.onPanelCreateSession(); return; }
        if (data === "l" && this.opts.onPanelLinkToSession) { this.opts.onPanelLinkToSession(); return; }
      }
      if (this.panelTabsActive && this.opts.onPanelAction && (data === "o" || data === "a" || data === "s" || data === "c" || data === "C")) {
        this.opts.onPanelAction(data);
        return;
      }
      this.opts.onDiffPanelData?.(data);
      return;
    }
```

Note: `"r"` is removed from the `onPanelAction` condition on the last `if` line.

- [ ] **Step 4: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/input-router.ts
git commit -m "feat: add filter mode and rebind keys in InputRouter"
```

---

### Task 5: Update InputRouter tests

**Files:**
- Modify: `src/__tests__/input-router.test.ts`

- [ ] **Step 1: Update the existing `/` key test**

The test at line 608-618 (`"/ key triggers onPanelCycleSortBy when tabs active"`) now tests the wrong behavior. Update it:

```typescript
  test("/ key triggers onPanelFilterStart when tabs active", () => {
    let called = false;
    const router = new InputRouter({
      sidebarCols: 24, onPtyData: () => {}, onSidebarClick: () => {},
      onPanelFilterStart: () => { called = true; },
    }, true);
    router.setDiffPanel(40, true);
    router.setPanelTabsActive(true);
    router.handleInput("/");
    expect(called).toBe(true);
  });
```

- [ ] **Step 2: Add `S` key test for sortBy**

Add after the updated `/` test:

```typescript
  test("S key triggers onPanelCycleSortBy when tabs active", () => {
    let called = false;
    const router = new InputRouter({
      sidebarCols: 24, onPtyData: () => {}, onSidebarClick: () => {},
      onPanelCycleSortBy: () => { called = true; },
    }, true);
    router.setDiffPanel(40, true);
    router.setPanelTabsActive(true);
    router.handleInput("S");
    expect(called).toBe(true);
  });
```

- [ ] **Step 3: Add `r` key test for refresh**

```typescript
  test("r key triggers onPanelRefresh when tabs active", () => {
    let called = false;
    const router = new InputRouter({
      sidebarCols: 24, onPtyData: () => {}, onSidebarClick: () => {},
      onPanelRefresh: () => { called = true; },
    }, true);
    router.setDiffPanel(40, true);
    router.setPanelTabsActive(true);
    router.handleInput("r");
    expect(called).toBe(true);
  });
```

- [ ] **Step 4: Add filter mode tests**

Add a new `describe("panel filter mode")` block:

```typescript
describe("panel filter mode", () => {
  function makeFilterRouter(overrides: Partial<InputRouterOptions> = {}) {
    const calls: string[] = [];
    const opts: InputRouterOptions = {
      sidebarCols: 24,
      onPtyData: () => { calls.push("pty"); },
      onSidebarClick: () => {},
      onDiffPanelData: (d) => { calls.push(`diff:${d}`); },
      onPanelFilterStart: () => { calls.push("filterStart"); },
      onPanelFilterInput: (c) => { calls.push(`filterInput:${c}`); },
      onPanelFilterBackspace: () => { calls.push("filterBackspace"); },
      onPanelFilterClear: () => { calls.push("filterClear"); },
      onPanelSelectPrev: () => { calls.push("selectPrev"); },
      onPanelSelectNext: () => { calls.push("selectNext"); },
      onPanelAction: (k) => { calls.push(`action:${k}`); },
      onPanelRefresh: () => { calls.push("refresh"); },
      onPanelCycleSortBy: () => { calls.push("cycleSortBy"); },
      ...overrides,
    };
    const router = new InputRouter(opts, true);
    router.setDiffPanel(40, true);
    router.setPanelTabsActive(true);
    return { router, calls };
  }

  test("printable chars append to filter when filter mode is active", () => {
    const { router, calls } = makeFilterRouter();
    router.handleInput("/"); // enter filter mode
    calls.length = 0;
    router.handleInput("a");
    router.handleInput("b");
    router.handleInput("1");
    expect(calls).toEqual(["filterInput:a", "filterInput:b", "filterInput:1"]);
  });

  test("action keys are captured as filter input, not dispatched as actions", () => {
    const { router, calls } = makeFilterRouter();
    router.handleInput("/");
    calls.length = 0;
    router.handleInput("o"); // normally opens in browser
    router.handleInput("s"); // normally changes status
    router.handleInput("n"); // normally creates session
    expect(calls).toEqual(["filterInput:o", "filterInput:s", "filterInput:n"]);
  });

  test("backspace calls onPanelFilterBackspace in filter mode", () => {
    const { router, calls } = makeFilterRouter();
    router.handleInput("/");
    calls.length = 0;
    router.handleInput("\x7f");
    expect(calls).toEqual(["filterBackspace"]);
  });

  test("bare Esc clears filter and exits filter mode", () => {
    const { router, calls } = makeFilterRouter();
    router.handleInput("/");
    calls.length = 0;
    router.handleInput("\x1b");
    expect(calls).toEqual(["filterClear"]);
    // After Esc, normal keys should go to action handlers, not filter
    calls.length = 0;
    router.handleInput("o");
    expect(calls).toEqual(["action:o"]);
  });

  test("escape sequences (arrow keys) are not treated as bare Esc", () => {
    const { router, calls } = makeFilterRouter();
    router.handleInput("/");
    calls.length = 0;
    router.handleInput("\x1b[A"); // Up arrow — should navigate, not clear
    router.handleInput("\x1b[B"); // Down arrow
    expect(calls).toEqual(["selectPrev", "selectNext"]);
  });

  test("arrow keys navigate the filtered list", () => {
    const { router, calls } = makeFilterRouter();
    router.handleInput("/");
    router.handleInput("a"); // type something
    calls.length = 0;
    router.handleInput("\x1b[A");
    router.handleInput("\x1b[B");
    expect(calls).toEqual(["selectPrev", "selectNext"]);
  });

  test("tab switch clears filter mode", () => {
    const prevTabCalls: string[] = [];
    const { router, calls } = makeFilterRouter({
      onPanelPrevTab: () => { prevTabCalls.push("prevTab"); },
    });
    router.handleInput("/");
    calls.length = 0;
    router.handleInput("[");
    expect(calls).toContain("filterClear");
    expect(prevTabCalls).toEqual(["prevTab"]);
    // After tab switch, should be out of filter mode
    calls.length = 0;
    router.handleInput("o");
    expect(calls).toEqual(["action:o"]);
  });

  test("unrecognized keys are consumed in filter mode, not forwarded", () => {
    const { router, calls } = makeFilterRouter();
    router.handleInput("/");
    calls.length = 0;
    router.handleInput("\x1b[1;2C"); // Shift+Right — not handled in filter mode
    expect(calls).toEqual([]); // consumed, not forwarded
  });

  test("r key is captured as filter input when filter active, not refresh", () => {
    const { router, calls } = makeFilterRouter();
    router.handleInput("/");
    calls.length = 0;
    router.handleInput("r");
    expect(calls).toEqual(["filterInput:r"]);
  });

  test("r key triggers refresh when filter is not active", () => {
    const { router, calls } = makeFilterRouter();
    router.handleInput("r");
    expect(calls).toEqual(["refresh"]);
  });
});
```

- [ ] **Step 5: Run tests**

Run: `bun test src/__tests__/input-router.test.ts`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/__tests__/input-router.test.ts
git commit -m "test: add filter mode and keybind tests for InputRouter"
```

---

### Task 6: Wire filter and refresh callbacks in main.ts

**Files:**
- Modify: `src/main.ts:838-848` (render path — add filtering)
- Modify: `src/main.ts:1085-1094` (tab switch handlers — clear filter)
- Modify: `src/main.ts:1151-1157` (sort cycling — kept, wired to `S`)
- Modify: `src/main.ts:1428-1458` (onPanelAction — remove `r` handler)
- Add new callback handlers after the existing panel handlers

- [ ] **Step 1: Add filter callbacks to the InputRouter options object**

In `main.ts`, find the InputRouter options object (where `onPanelLinkToSession` is defined, around line 1070+). Add the new filter and refresh callbacks after `onPanelLinkToSession`:

```typescript
    onPanelFilterStart: () => {
      const viewState = viewStates.get(infoPanel.activeTab);
      if (viewState) {
        viewState.filterQuery = "";  // "" = bar open, no text yet
        scheduleRender();
      }
    },
    onPanelFilterInput: (char) => {
      const viewState = viewStates.get(infoPanel.activeTab);
      if (viewState) {
        viewState.filterQuery = (viewState.filterQuery ?? "") + char;
        viewState.selectedIndex = 0;
        viewState.scrollOffset = 0;
        viewState.detailScrollOffset = 0;
        scheduleRender();
      }
    },
    onPanelFilterBackspace: () => {
      const viewState = viewStates.get(infoPanel.activeTab);
      if (viewState && viewState.filterQuery && viewState.filterQuery.length > 0) {
        viewState.filterQuery = viewState.filterQuery.slice(0, -1);
        viewState.selectedIndex = 0;
        viewState.scrollOffset = 0;
        viewState.detailScrollOffset = 0;
        scheduleRender();
      }
    },
    onPanelFilterClear: () => {
      const viewState = viewStates.get(infoPanel.activeTab);
      if (viewState) {
        viewState.filterQuery = null;
        viewState.selectedIndex = 0;
        viewState.scrollOffset = 0;
        viewState.detailScrollOffset = 0;
        scheduleRender();
      }
    },
    onPanelRefresh: () => {
      pollCoordinator.pollGlobal();
      scheduleRender();
    },
```

- [ ] **Step 2: Update tab switch handlers to clear filter**

In the `onPanelPrevTab` handler (line 1085-1088), add filter clearing:

```typescript
    onPanelPrevTab: () => {
      const viewState = viewStates.get(infoPanel.activeTab);
      if (viewState) viewState.filterQuery = null;
      infoPanel.prevTab();
      inputRouter.setPanelTabsActive(infoPanel.activeTab !== "diff");
      scheduleRender();
    },
    onPanelNextTab: () => {
      const viewState = viewStates.get(infoPanel.activeTab);
      if (viewState) viewState.filterQuery = null;
      infoPanel.nextTab();
      inputRouter.setPanelTabsActive(infoPanel.activeTab !== "diff");
      scheduleRender();
    },
```

- [ ] **Step 3: Add fuzzy filtering to the render path**

In `main.ts`, find the render path where `buildViewNodes` is called (around line 847). Add filtering between `rawItems` construction and `buildViewNodes`:

```typescript
        // Apply fuzzy filter when active
        if (viewState.filterQuery) {
          rawItems = filterItems(rawItems, viewState.filterQuery);
        }

        // When filtering, flatten groups so fuzzy-score order is preserved
        const effectiveView = viewState.filterQuery
          ? { ...view, groupBy: "none" as const }
          : view;
        const nodes = buildViewNodes(rawItems, effectiveView, viewState.collapsedGroups);
        contentGrid = renderView(nodes, dpCols, dpRows, viewState);
```

Add `filterItems` to the import from `./panel-view-renderer` (find the existing import line and add it):

```typescript
import { transformIssues, transformMrs, buildViewNodes, renderView, createViewState, filterItems } from "./panel-view-renderer";
```

- [ ] **Step 4: Remove `r` from `onPanelAction` handler**

In the `onPanelAction` handler (around line 1453-1457), remove the `key === "r"` line:

Change:
```typescript
        if (key === "o") adapters.codeHost.openInBrowser(mr.id);
        if (key === "r") adapters.codeHost.markReady(mr.id).then(() => { pollCoordinator.refreshGlobalItem("mr", mr.id); scheduleRender(); });
        if (key === "a") adapters.codeHost.approve(mr.id).then(() => { pollCoordinator.refreshGlobalItem("mr", mr.id); scheduleRender(); });
```

To:
```typescript
        if (key === "o") adapters.codeHost.openInBrowser(mr.id);
        if (key === "a") adapters.codeHost.approve(mr.id).then(() => { pollCoordinator.refreshGlobalItem("mr", mr.id); scheduleRender(); });
```

- [ ] **Step 5: Apply the same filter logic to other `buildViewNodes` call sites**

There are multiple places in `main.ts` where `buildViewNodes` is called (search for all occurrences). Each one that resolves items and builds nodes for selection must also apply the filter so that `selectedIndex` refers to the correct item in the filtered list. The affected handlers are:

- `onPanelSelectNext` (~line 1124)
- `onPanelToggleCollapse` (~line 1179)
- `onPanelCreateSession` (~line 1194)
- `onPanelLinkToSession` (~line 1334+)
- `onPanelAction` (~line 1449)

For each of these, after the `rawItems` assignment, add:

```typescript
        if (viewState.filterQuery) rawItems = filterItems(rawItems, viewState.filterQuery);
```

And change the `buildViewNodes` call from:
```typescript
        const nodes = buildViewNodes(rawItems, view, viewState.collapsedGroups);
```
To:
```typescript
        const effectiveView = viewState.filterQuery ? { ...view, groupBy: "none" as const } : view;
        const nodes = buildViewNodes(rawItems, effectiveView, viewState.collapsedGroups);
```

This ensures that when you navigate to item index 3 in a filtered list and press `n` (create session), the handler resolves the same item at index 3.

- [ ] **Step 6: Run typecheck**

Run: `bun run typecheck`
Expected: PASS

- [ ] **Step 7: Run all tests**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 8: Commit**

```bash
git add src/main.ts src/panel-view-renderer.ts
git commit -m "feat: wire filter/refresh callbacks and apply fuzzy filtering in render path"
```

---

### Task 7: Manual smoke test

**Files:** None (testing only)

- [ ] **Step 1: Run the app and verify filter mode**

Run: `bun run dev`

1. Open the info panel (Ctrl-a g)
2. Navigate to an issues or MR tab
3. Press `/` — verify the filter bar appears at the top of the list
4. Type a few characters — verify the list filters in real-time and groups flatten
5. Use arrow keys — verify navigation works within the filtered list
6. Press `Esc` — verify the filter bar disappears and the full list returns
7. Press `r` — verify the issues/MRs refresh (watch for network activity or list update)
8. Press `S` — verify sort cycling works
9. Press `/`, type something, then press `[` — verify filter clears and tab switches
10. Press `/`, type a query with no matches — verify "No matches" appears
11. Verify the action bar shows `[/] Search  [r] Refresh` on the second row

- [ ] **Step 2: Verify action keys don't fire during filter mode**

1. Press `/` to enter filter mode
2. Press `o` — verify it types "o" into the filter, doesn't open browser
3. Press `s` — verify it types "s", doesn't open status modal
4. Press `Esc` to exit, then press `o` — verify it now opens in browser normally
