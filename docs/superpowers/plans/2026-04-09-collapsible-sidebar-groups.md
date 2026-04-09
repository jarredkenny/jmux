# Collapsible Sidebar Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to collapse/expand group sections in the sidebar, hiding their sessions and showing a count badge.

**Architecture:** Add `collapsedGroups` state to `Sidebar`, filter collapsed sessions out of `buildRenderPlan()`, render chevrons on group headers, wire clicks and palette entries in `main.ts`.

**Tech Stack:** TypeScript, Bun test runner, no new dependencies.

---

## File Map

| File | Role |
|------|------|
| `src/sidebar.ts` | Core: collapsed state, render plan filtering, chevron rendering, group row mapping, hover on headers |
| `src/main.ts` | Integration: click handler, palette entries, palette action handler |
| `src/__tests__/sidebar.test.ts` | Tests for all sidebar changes |

---

### Task 1: Update `RenderItem` type and `buildRenderPlan()` to support collapse

**Files:**
- Modify: `src/sidebar.ts:102-163`
- Test: `src/__tests__/sidebar.test.ts`

The `group-header` variant of `RenderItem` needs `collapsed` and `sessionCount` fields. `buildRenderPlan()` needs a `collapsedGroups` parameter to skip sessions in collapsed groups.

- [ ] **Step 1: Write failing tests for collapsed render plan**

Add these tests to `src/__tests__/sidebar.test.ts`:

```ts
test("collapsed group hides its sessions from render", () => {
  const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
  sidebar.updateSessions(
    makeSessions([
      { name: "api", directory: "~/Code/work/api" },
      { name: "web", directory: "~/Code/work/web" },
      { name: "solo", directory: "~" },
    ]),
  );
  sidebar.toggleGroup("Code/work");
  const grid = sidebar.getGrid();
  // "api" and "web" should NOT appear anywhere in the grid
  let foundApi = false;
  let foundWeb = false;
  for (let r = 0; r < 30; r++) {
    const text = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[r][i].char,
    ).join("");
    if (text.includes("api")) foundApi = true;
    if (text.includes("web")) foundWeb = true;
  }
  expect(foundApi).toBe(false);
  expect(foundWeb).toBe(false);
  // But the group header should still be visible
  let foundHeader = false;
  for (let r = 0; r < 30; r++) {
    const text = Array.from(
      { length: SIDEBAR_WIDTH },
      (_, i) => grid.cells[r][i].char,
    ).join("");
    if (text.includes("Code/work")) foundHeader = true;
  }
  expect(foundHeader).toBe(true);
});

test("collapsed group excludes sessions from displayOrder", () => {
  const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
  sidebar.updateSessions(
    makeSessions([
      { name: "api", directory: "~/Code/work/api" },
      { name: "web", directory: "~/Code/work/web" },
      { name: "solo", directory: "~" },
    ]),
  );
  sidebar.toggleGroup("Code/work");
  const ids = sidebar.getDisplayOrderIds();
  // Only "solo" ($2) should be in display order
  expect(ids).toEqual(["$2"]);
});

test("toggleGroup expands a collapsed group", () => {
  const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
  sidebar.updateSessions(
    makeSessions([
      { name: "api", directory: "~/Code/work/api" },
      { name: "web", directory: "~/Code/work/web" },
    ]),
  );
  sidebar.toggleGroup("Code/work"); // collapse
  sidebar.toggleGroup("Code/work"); // expand
  const ids = sidebar.getDisplayOrderIds();
  expect(ids).toEqual(["$0", "$1"]);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/sidebar.test.ts -t "collapsed group|toggleGroup"`
Expected: FAIL — `toggleGroup` does not exist on `Sidebar`.

- [ ] **Step 3: Update `RenderItem` type**

In `src/sidebar.ts`, change the `RenderItem` type union at line 102:

```ts
type RenderItem =
  | { type: "group-header"; label: string; collapsed: boolean; sessionCount: number }
  | { type: "session"; sessionIndex: number; grouped: boolean; groupLabel?: string }
  | { type: "spacer" };
```

- [ ] **Step 4: Update `buildRenderPlan()` to accept collapsed set and filter**

Replace `buildRenderPlan` (lines 107-163) with:

```ts
function buildRenderPlan(sessions: SessionInfo[], collapsedGroups: Set<string>): {
  items: RenderItem[];
  displayOrder: number[];
} {
  const groupMap = new Map<string, number[]>();
  const ungrouped: number[] = [];

  for (let i = 0; i < sessions.length; i++) {
    const label = sessions[i].project ?? (() => {
      const dir = sessions[i].directory;
      return dir ? getGroupLabel(dir) : null;
    })();
    if (!label) {
      ungrouped.push(i);
      continue;
    }
    const existing = groupMap.get(label);
    if (existing) {
      existing.push(i);
    } else {
      groupMap.set(label, [i]);
    }
  }

  const sortedGroups: SessionGroup[] = [...groupMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, indices]) => ({
      label,
      sessionIndices: indices.sort((a, b) =>
        sessions[a].name.localeCompare(sessions[b].name),
      ),
    }));

  ungrouped.sort((a, b) => sessions[a].name.localeCompare(sessions[b].name));

  const items: RenderItem[] = [];
  const displayOrder: number[] = [];

  for (const group of sortedGroups) {
    const isCollapsed = collapsedGroups.has(group.label);
    items.push({
      type: "group-header",
      label: group.label,
      collapsed: isCollapsed,
      sessionCount: group.sessionIndices.length,
    });
    items.push({ type: "spacer" });
    if (!isCollapsed) {
      for (const idx of group.sessionIndices) {
        items.push({ type: "session", sessionIndex: idx, grouped: true, groupLabel: group.label });
        displayOrder.push(idx);
        items.push({ type: "spacer" });
      }
    }
  }

  for (const idx of ungrouped) {
    items.push({ type: "session", sessionIndex: idx, grouped: false });
    displayOrder.push(idx);
    items.push({ type: "spacer" });
  }

  return { items, displayOrder };
}
```

- [ ] **Step 5: Add `collapsedGroups` state and `toggleGroup()` to `Sidebar`**

In the `Sidebar` class, add the field alongside the other private fields (around line 184):

```ts
private collapsedGroups = new Set<string>();
```

Add `toggleGroup` method after `setActiveSession`:

```ts
toggleGroup(label: string): void {
  if (this.collapsedGroups.has(label)) {
    this.collapsedGroups.delete(label);
  } else {
    this.collapsedGroups.add(label);
  }
  const { items, displayOrder } = buildRenderPlan(this.sessions, this.collapsedGroups);
  this.items = items;
  this.displayOrder = displayOrder;
  this.clampScroll();
}
```

Update `updateSessions` to pass the collapsed set:

```ts
updateSessions(sessions: SessionInfo[]): void {
  this.sessions = sessions;
  const { items, displayOrder } = buildRenderPlan(sessions, this.collapsedGroups);
  this.items = items;
  this.displayOrder = displayOrder;
  this.clampScroll();
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test src/__tests__/sidebar.test.ts`
Expected: ALL PASS.

- [ ] **Step 7: Commit**

```bash
git add src/sidebar.ts src/__tests__/sidebar.test.ts
git commit -m "feat(sidebar): add collapse state and filtered render plan for groups"
```

---

### Task 2: Render chevrons and session count on group headers

**Files:**
- Modify: `src/sidebar.ts:334-339` (group-header rendering in `getGrid()`)
- Test: `src/__tests__/sidebar.test.ts`

- [ ] **Step 1: Write failing tests for chevron rendering**

Add to `src/__tests__/sidebar.test.ts`:

```ts
test("expanded group header shows down chevron", () => {
  const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
  sidebar.updateSessions(
    makeSessions([
      { name: "api", directory: "~/Code/work/api" },
      { name: "web", directory: "~/Code/work/web" },
    ]),
  );
  const grid = sidebar.getGrid();
  // Group header is at row 2, chevron at col 1
  expect(grid.cells[2][1].char).toBe("\u25be"); // ▾
});

test("collapsed group header shows right chevron and session count", () => {
  const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
  sidebar.updateSessions(
    makeSessions([
      { name: "api", directory: "~/Code/work/api" },
      { name: "web", directory: "~/Code/work/web" },
    ]),
  );
  sidebar.toggleGroup("Code/work");
  const grid = sidebar.getGrid();
  // Group header is at row 2
  expect(grid.cells[2][1].char).toBe("\u25b8"); // ▸
  const headerText = Array.from(
    { length: SIDEBAR_WIDTH },
    (_, i) => grid.cells[2][i].char,
  ).join("");
  expect(headerText).toContain("(2)");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/sidebar.test.ts -t "chevron|count"`
Expected: FAIL — group headers currently render label at col 1 with no chevron.

- [ ] **Step 3: Update group-header rendering in `getGrid()`**

Replace the `group-header` branch in `getGrid()` (around line 334):

```ts
if (item.type === "group-header") {
  const chevron = item.collapsed ? "\u25b8" : "\u25be"; // ▸ or ▾
  writeString(grid, screenRow, 1, chevron, GROUP_HEADER_ATTRS);
  const labelStart = 3;
  let label = item.label;
  const countSuffix = item.collapsed ? ` (${item.sessionCount})` : "";
  const maxLabelLen = this.width - labelStart - countSuffix.length - 1;
  if (label.length > maxLabelLen) {
    label = label.slice(0, maxLabelLen - 1) + "\u2026";
  }
  writeString(grid, screenRow, labelStart, label, GROUP_HEADER_ATTRS);
  if (countSuffix) {
    writeString(grid, screenRow, labelStart + label.length, countSuffix, DIM_ATTRS);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/sidebar.test.ts`
Expected: ALL PASS. The existing "groups sessions sharing a parent directory" test expects `headerRow` to contain "Code/work" — it still will, just at col 3 instead of col 1.

- [ ] **Step 5: Commit**

```bash
git add src/sidebar.ts src/__tests__/sidebar.test.ts
git commit -m "feat(sidebar): render chevrons and session count on group headers"
```

---

### Task 3: Group header click handling and hover

**Files:**
- Modify: `src/sidebar.ts` (add `rowToGroupLabel` map, `getGroupByRow()`, hover on headers)
- Modify: `src/main.ts:486-493` (`onSidebarClick`)
- Test: `src/__tests__/sidebar.test.ts`

- [ ] **Step 1: Write failing tests for click targeting and hover**

Add to `src/__tests__/sidebar.test.ts`:

```ts
test("getGroupByRow returns group label for header rows", () => {
  const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
  sidebar.updateSessions(
    makeSessions([
      { name: "api", directory: "~/Code/work/api" },
      { name: "web", directory: "~/Code/work/web" },
    ]),
  );
  sidebar.getGrid(); // populate row maps
  // Row 2 is the group header
  expect(sidebar.getGroupByRow(2)).toBe("Code/work");
  // Row 4 is a session, not a group header
  expect(sidebar.getGroupByRow(4)).toBeNull();
});

test("group header row shows hover highlight", () => {
  const sidebar = new Sidebar(SIDEBAR_WIDTH, 30);
  sidebar.updateSessions(
    makeSessions([
      { name: "api", directory: "~/Code/work/api" },
      { name: "web", directory: "~/Code/work/web" },
    ]),
  );
  sidebar.setHoveredRow(2); // group header row
  const grid = sidebar.getGrid();
  // The header row should have HOVER_BG applied
  // Check that the background of a cell in the header row is non-zero (has bg set)
  expect(grid.cells[2][0].bg).not.toBe(0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/sidebar.test.ts -t "getGroupByRow|hover highlight"`
Expected: FAIL — `getGroupByRow` does not exist.

- [ ] **Step 3: Add `rowToGroupLabel` map and `getGroupByRow()` to `Sidebar`**

Add private field alongside `rowToSessionIndex`:

```ts
private rowToGroupLabel = new Map<number, string>();
```

Add public method after `getSessionByRow`:

```ts
getGroupByRow(row: number): string | null {
  return this.rowToGroupLabel.get(row) ?? null;
}
```

In `getGrid()`, clear the map alongside `rowToSessionIndex`:

```ts
this.rowToGroupLabel.clear();
```

In the `group-header` rendering branch, after the existing rendering code, add:

```ts
this.rowToGroupLabel.set(screenRow, item.label);
```

- [ ] **Step 4: Add hover highlighting for group headers**

In the `group-header` rendering branch of `getGrid()`, before the chevron rendering, add a hover check:

```ts
if (item.type === "group-header") {
  const isHovered = this.hoveredRow === screenRow;
  if (isHovered) {
    const bgFill = " ".repeat(this.width);
    writeString(grid, screenRow, 0, bgFill, { bg: HOVER_BG, bgMode: ColorMode.RGB });
  }
  const headerAttrs: CellAttrs = isHovered
    ? { ...GROUP_HEADER_ATTRS, bg: HOVER_BG, bgMode: ColorMode.RGB }
    : GROUP_HEADER_ATTRS;
  const countAttrs: CellAttrs = isHovered
    ? { ...DIM_ATTRS, bg: HOVER_BG, bgMode: ColorMode.RGB }
    : DIM_ATTRS;
  const chevron = item.collapsed ? "\u25b8" : "\u25be";
  writeString(grid, screenRow, 1, chevron, headerAttrs);
  const labelStart = 3;
  let label = item.label;
  const countSuffix = item.collapsed ? ` (${item.sessionCount})` : "";
  const maxLabelLen = this.width - labelStart - countSuffix.length - 1;
  if (label.length > maxLabelLen) {
    label = label.slice(0, maxLabelLen - 1) + "\u2026";
  }
  writeString(grid, screenRow, labelStart, label, headerAttrs);
  if (countSuffix) {
    writeString(grid, screenRow, labelStart + label.length, countSuffix, countAttrs);
  }
  this.rowToGroupLabel.set(screenRow, item.label);
}
```

Note: this replaces the rendering code from Task 2 Step 3 — the hover logic wraps the same chevron/label/count rendering.

- [ ] **Step 5: Run sidebar tests to verify they pass**

Run: `bun test src/__tests__/sidebar.test.ts`
Expected: ALL PASS.

- [ ] **Step 6: Wire click handler in `main.ts`**

In `src/main.ts`, update `onSidebarClick` (around line 486):

```ts
onSidebarClick: (row) => {
  if (sidebar.isVersionRow(row)) {
    showVersionInfo();
    return;
  }
  const groupLabel = sidebar.getGroupByRow(row);
  if (groupLabel) {
    sidebar.toggleGroup(groupLabel);
    scheduleRender();
    return;
  }
  const session = sidebar.getSessionByRow(row);
  if (session) switchSession(session.id);
},
```

- [ ] **Step 7: Run full test suite**

Run: `bun test`
Expected: ALL PASS.

- [ ] **Step 8: Commit**

```bash
git add src/sidebar.ts src/main.ts src/__tests__/sidebar.test.ts
git commit -m "feat(sidebar): add group header click-to-collapse and hover state"
```

---

### Task 4: Command palette entries for collapse/expand

**Files:**
- Modify: `src/sidebar.ts` (add `getGroups()`)
- Modify: `src/main.ts:654-723` (`buildPaletteCommands`), `src/main.ts:852-867` (`handlePaletteAction`)

- [ ] **Step 1: Add `getGroups()` method to `Sidebar`**

Add after `getGroupByRow`:

```ts
getGroups(): { label: string; collapsed: boolean }[] {
  const groups: { label: string; collapsed: boolean }[] = [];
  const seen = new Set<string>();
  for (const item of this.items) {
    if (item.type === "group-header" && !seen.has(item.label)) {
      seen.add(item.label);
      groups.push({ label: item.label, collapsed: item.collapsed });
    }
  }
  return groups;
}
```

- [ ] **Step 2: Add palette commands in `buildPaletteCommands()` in `main.ts`**

After the dynamic "switch to session" block (around line 671), add:

```ts
// Dynamic: collapse/expand groups
for (const group of sidebar.getGroups()) {
  commands.push({
    id: `toggle-group:${group.label}`,
    label: group.collapsed ? `Expand: ${group.label}` : `Collapse: ${group.label}`,
    category: "session",
  });
}
```

- [ ] **Step 3: Handle the palette action in `handlePaletteAction()`**

After the `switch-window:` block (around line 867), add:

```ts
// Dynamic: toggle sidebar group
if (commandId.startsWith("toggle-group:")) {
  const label = commandId.slice("toggle-group:".length);
  sidebar.toggleGroup(label);
  scheduleRender();
  return;
}
```

- [ ] **Step 4: Run full test suite and typecheck**

Run: `bun test && bun run typecheck`
Expected: ALL PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/sidebar.ts src/main.ts
git commit -m "feat(sidebar): add command palette entries for collapse/expand groups"
```

---

### Task 5: Verify and clean up

**Files:**
- All modified files

- [ ] **Step 1: Run full test suite**

Run: `bun test`
Expected: ALL PASS.

- [ ] **Step 2: Run typecheck**

Run: `bun run typecheck`
Expected: No errors.

- [ ] **Step 3: Review for any dead code or inconsistencies**

Check that:
- The old `group-header` rendering code (without hover) from Task 2 was fully replaced by Task 3's version
- No unused imports were introduced
- The `getSubdirectory` function (line 88) is still unused — it was unused before this change and remains so. Don't touch it.

- [ ] **Step 4: Final commit if any cleanup was needed**

Only if changes were made in step 3.
