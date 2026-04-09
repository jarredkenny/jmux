# Diff Panel Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Embed hunk as an interactive diff panel within jmux's chrome, using the existing ScreenBridge pattern to capture hunk's PTY output into a CellGrid and composite it alongside the sidebar, toolbar, and tmux main area.

**Architecture:** A new `DiffPanel` class owns the hunk subprocess lifecycle and a second ScreenBridge instance. The renderer's `compositeGrids()` gains a `diffPanel` parameter for split/full layout. InputRouter gains diff panel mouse regions, focus state, and prefix key swallowing. Main.ts wires the state machine (`off → split → full → off`), the `Ctrl-a g` hotkey, toolbar button, session-switch hook, and resize handling.

**Tech Stack:** TypeScript, Bun, bun-pty, @xterm/headless (ScreenBridge), hunkdiff (optional runtime dep)

**Spec:** `docs/superpowers/specs/2026-04-09-diff-panel-design.md`

---

## File Structure

| File | Role |
|------|------|
| `src/diff-panel.ts` | **New.** DiffPanel class — state machine, hunk subprocess, ScreenBridge #2, empty panel hint, resize. |
| `src/__tests__/diff-panel.test.ts` | **New.** Tests for state transitions, empty panel rendering, grid passthrough. |
| `src/renderer.ts` | Extend `compositeGrids()` with `diffPanel` param — split layout, full layout, divider, modal dimming. |
| `src/__tests__/renderer.test.ts` | New tests for compositeGrids with diff panel in split/full modes. |
| `src/input-router.ts` | Add diff panel mouse region, divider click, focus state, prefix swallowing, Ctrl-a Tab. |
| `src/__tests__/input-router.test.ts` | New tests for diff panel routing, focus toggle, prefix behavior. |
| `src/main.ts` | Wire DiffPanel — state cycling, hotkey, toolbar button, session hook, resize, palette commands, cleanup. |

---

### Task 1: DiffPanel Class — State Machine & Empty Panel

**Files:**
- Create: `src/diff-panel.ts`
- Create: `src/__tests__/diff-panel.test.ts`

- [ ] **Step 1: Write failing tests for DiffPanel state machine and empty panel**

```typescript
// src/__tests__/diff-panel.test.ts
import { describe, test, expect } from "bun:test";
import { DiffPanel, type DiffPanelState } from "../diff-panel";

describe("DiffPanel state machine", () => {
  test("starts in off state", () => {
    const panel = new DiffPanel();
    expect(panel.state).toBe("off");
  });

  test("cycle advances off → split → full → off", () => {
    const panel = new DiffPanel();
    panel.cycle();
    expect(panel.state).toBe("split");
    panel.cycle();
    expect(panel.state).toBe("full");
    panel.cycle();
    expect(panel.state).toBe("off");
  });

  test("setState jumps directly to a state", () => {
    const panel = new DiffPanel();
    panel.setState("full");
    expect(panel.state).toBe("full");
    panel.setState("split");
    expect(panel.state).toBe("split");
    panel.setState("off");
    expect(panel.state).toBe("off");
  });

  test("isActive returns false when off", () => {
    const panel = new DiffPanel();
    expect(panel.isActive()).toBe(false);
  });

  test("isActive returns true when split or full", () => {
    const panel = new DiffPanel();
    panel.setState("split");
    expect(panel.isActive()).toBe(true);
    panel.setState("full");
    expect(panel.isActive()).toBe(true);
  });

  test("calculates panel columns in split mode", () => {
    const panel = new DiffPanel();
    // 100 available cols, 0.4 ratio → 40 cols for diff panel
    expect(panel.calcPanelCols(100, 0.4)).toBe(40);
  });

  test("calculates panel columns with floor rounding", () => {
    const panel = new DiffPanel();
    // 99 available cols, 0.4 ratio → floor(39.6) = 39
    expect(panel.calcPanelCols(99, 0.4)).toBe(39);
  });

  test("clamps panel columns to minimum of 20", () => {
    const panel = new DiffPanel();
    // 30 available cols, 0.4 ratio → 12, clamped to 20
    expect(panel.calcPanelCols(30, 0.4)).toBe(20);
  });
});

describe("DiffPanel empty panel", () => {
  test("getEmptyGrid renders hint text", () => {
    const panel = new DiffPanel();
    const grid = panel.getEmptyGrid(40, 10);
    expect(grid.cols).toBe(40);
    expect(grid.rows).toBe(10);
    // Should contain hint text somewhere in the grid
    const allChars = grid.cells.flatMap(row => row.map(c => c.char)).join("");
    expect(allChars).toContain("Ctrl-a");
  });

  test("getEmptyGrid for not-found renders install hint", () => {
    const panel = new DiffPanel();
    const grid = panel.getNotFoundGrid(40, 10);
    expect(grid.cols).toBe(40);
    expect(grid.rows).toBe(10);
    const allChars = grid.cells.flatMap(row => row.map(c => c.char)).join("");
    expect(allChars).toContain("hunk");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/diff-panel.test.ts`
Expected: FAIL — module `../diff-panel` not found

- [ ] **Step 3: Implement DiffPanel class**

```typescript
// src/diff-panel.ts
import type { CellGrid } from "./types";
import { ColorMode } from "./types";
import { createGrid, writeString, type CellAttrs } from "./cell-grid";

export type DiffPanelState = "off" | "split" | "full";

const HINT_FG: CellAttrs = { fg: 8, fgMode: ColorMode.Palette, dim: true };
const HINT_KEY: CellAttrs = { fg: 2, fgMode: ColorMode.Palette };

const MIN_PANEL_COLS = 20;

export class DiffPanel {
  private _state: DiffPanelState = "off";
  private _hunkExited = false;

  get state(): DiffPanelState {
    return this._state;
  }

  get hunkExited(): boolean {
    return this._hunkExited;
  }

  isActive(): boolean {
    return this._state !== "off";
  }

  cycle(): void {
    switch (this._state) {
      case "off":
        this._state = "split";
        break;
      case "split":
        this._state = "full";
        break;
      case "full":
        this._state = "off";
        break;
    }
    if (this._state === "off") {
      this._hunkExited = false;
    }
  }

  setState(state: DiffPanelState): void {
    this._state = state;
    if (state === "off") {
      this._hunkExited = false;
    }
  }

  setHunkExited(exited: boolean): void {
    this._hunkExited = exited;
  }

  calcPanelCols(availableCols: number, splitRatio: number): number {
    const raw = Math.floor(availableCols * splitRatio);
    return Math.max(MIN_PANEL_COLS, raw);
  }

  getEmptyGrid(cols: number, rows: number): CellGrid {
    const grid = createGrid(cols, rows);
    const centerRow = Math.floor(rows / 2);
    const line1 = "Press Ctrl-a g to close";
    const line2 = "Switch sessions to reload";
    const col1 = Math.max(0, Math.floor((cols - line1.length) / 2));
    const col2 = Math.max(0, Math.floor((cols - line2.length) / 2));

    // "Press " + "Ctrl-a g" + " to close"
    writeString(grid, centerRow - 1, col1, "Press ", HINT_FG);
    writeString(grid, centerRow - 1, col1 + 6, "Ctrl-a g", HINT_KEY);
    writeString(grid, centerRow - 1, col1 + 14, " to close", HINT_FG);
    writeString(grid, centerRow + 0, col2, line2, HINT_FG);
    return grid;
  }

  getNotFoundGrid(cols: number, rows: number): CellGrid {
    const grid = createGrid(cols, rows);
    const centerRow = Math.floor(rows / 2);
    const line1 = "hunk not found";
    const line2 = "npm i -g hunkdiff";
    const col1 = Math.max(0, Math.floor((cols - line1.length) / 2));
    const col2 = Math.max(0, Math.floor((cols - line2.length) / 2));

    writeString(grid, centerRow - 1, col1, line1, HINT_FG);
    writeString(grid, centerRow, col2, "Install: ", HINT_FG);
    writeString(grid, centerRow, col2 + 9, line2, HINT_KEY);
    return grid;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/diff-panel.test.ts`
Expected: All 9 tests PASS

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/diff-panel.ts src/__tests__/diff-panel.test.ts
git commit -m "feat: add DiffPanel class with state machine and empty panel rendering"
```

---

### Task 2: Renderer — compositeGrids with Diff Panel

**Files:**
- Modify: `src/renderer.ts:130-333` (compositeGrids function)
- Modify: `src/renderer.ts:348-414` (Renderer.render method)
- Modify: `src/__tests__/renderer.test.ts`

- [ ] **Step 1: Write failing tests for split mode composition**

Add to `src/__tests__/renderer.test.ts`:

```typescript
describe("compositeGrids with diff panel", () => {
  test("split mode: sidebar + main + divider + diff panel", () => {
    const sidebar = createGrid(4, 3);
    writeString(sidebar, 0, 0, "side");
    const main = createGrid(20, 3);
    writeString(main, 0, 0, "main content here...");
    const diffGrid = createGrid(10, 3);
    writeString(diffGrid, 0, 0, "diff stuff");

    const toolbar = { buttons: [], mainCols: 20, tabs: [] };
    const result = compositeGrids(main, sidebar, toolbar, null, {
      grid: diffGrid,
      mode: "split",
      focused: false,
    });

    // sidebar(4) + border(1) + main(20) + divider(1) + diff(10) = 36
    expect(result.cols).toBe(36);

    // Divider column at position 25 (4+1+20)
    expect(result.cells[1][25].char).toBe("│");
    // Divider should be dim when diff panel is not focused
    expect(result.cells[1][25].fg).toBe(8);
    expect(result.cells[1][25].fgMode).toBe(ColorMode.Palette);

    // Diff content starts at col 26
    expect(result.cells[1][26].char).toBe("d");
  });

  test("split mode: divider is bright when diff panel is focused", () => {
    const sidebar = createGrid(4, 3);
    const main = createGrid(20, 3);
    const diffGrid = createGrid(10, 3);

    const toolbar = { buttons: [], mainCols: 20, tabs: [] };
    const result = compositeGrids(main, sidebar, toolbar, null, {
      grid: diffGrid,
      mode: "split",
      focused: true,
    });

    // Divider at col 25 should be bright blue (#58a6ff)
    const dividerCol = 4 + 1 + 20;
    const focusColor = (0x58 << 16) | (0xa6 << 8) | 0xff;
    expect(result.cells[1][dividerCol].fg).toBe(focusColor);
    expect(result.cells[1][dividerCol].fgMode).toBe(ColorMode.RGB);
  });

  test("full mode: sidebar + diff panel only, no main", () => {
    const sidebar = createGrid(4, 3);
    const main = createGrid(20, 3);
    writeString(main, 0, 0, "should not appear");
    const diffGrid = createGrid(30, 3);
    writeString(diffGrid, 0, 0, "full diff view here");

    const toolbar = { buttons: [], mainCols: 30, tabs: [] };
    const result = compositeGrids(main, sidebar, toolbar, null, {
      grid: diffGrid,
      mode: "full",
      focused: true,
    });

    // sidebar(4) + border(1) + diff(30) = 35
    expect(result.cols).toBe(35);

    // Diff content starts right after sidebar border at col 5
    expect(result.cells[1][5].char).toBe("f");
    // Main content should NOT appear
    const row1Chars = result.cells[1].map(c => c.char).join("");
    expect(row1Chars).not.toContain("should");
  });

  test("split mode: modal dimming covers both main and diff panel", () => {
    const sidebar = createGrid(4, 10);
    const main = createGrid(20, 8);
    const diffGrid = createGrid(10, 8);
    const modal = createGrid(6, 2);

    const toolbar = { buttons: [], mainCols: 20, tabs: [] };
    const result = compositeGrids(main, sidebar, toolbar, modal, {
      grid: diffGrid,
      mode: "split",
      focused: false,
    });

    // Main area cell should be dimmed
    expect(result.cells[2][6].dim).toBe(true);
    // Diff panel cell should be dimmed
    expect(result.cells[2][30].dim).toBe(true);
    // Sidebar should NOT be dimmed
    expect(result.cells[2][0].dim).toBe(false);
  });

  test("toolbar row extends across divider and diff panel in split mode", () => {
    const sidebar = createGrid(4, 4);
    const main = createGrid(20, 3);
    const diffGrid = createGrid(10, 3);

    const toolbar = { buttons: [], mainCols: 20, tabs: [] };
    const result = compositeGrids(main, sidebar, toolbar, null, {
      grid: diffGrid,
      mode: "split",
      focused: false,
    });

    // Row 0 (toolbar) should span full width: 36 cols
    // The divider column on the toolbar row should still be a space (toolbar bg)
    expect(result.cols).toBe(36);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/renderer.test.ts`
Expected: FAIL — compositeGrids doesn't accept 5th argument

- [ ] **Step 3: Implement compositeGrids diff panel support**

In `src/renderer.ts`, update the `compositeGrids` function signature and body. The key changes:

1. Add `diffPanel` parameter to the signature.
2. When `diffPanel` is present in split mode: increase `totalCols` by `1 (divider) + diffPanel.grid.cols`, render the divider column, copy diff grid cells.
3. When `diffPanel` is present in full mode: replace main grid with diff grid (don't copy main cells).
4. Extend modal dimming to cover the diff panel area.
5. Extend the toolbar row across divider + diff panel columns.

```typescript
// Updated signature at line 130:
export function compositeGrids(
  main: CellGrid,
  sidebar: CellGrid | null,
  toolbar?: ToolbarConfig | null,
  modalOverlay?: CellGrid | null,
  diffPanel?: {
    grid: CellGrid;
    mode: "split" | "full";
    focused: boolean;
  },
): CellGrid {
  if (!sidebar) return main;

  const isSplit = diffPanel?.mode === "split";
  const isFull = diffPanel?.mode === "full";
  const diffCols = diffPanel ? diffPanel.grid.cols : 0;
  const dividerCols = isSplit ? 1 : 0;
  const contentCols = isFull ? diffCols : (toolbar ? toolbar.mainCols : main.cols);
  const totalCols = sidebar.cols + 1 + contentCols + dividerCols + (isSplit ? diffCols : 0);
  const toolbarRows = toolbar ? 1 : 0;
  const totalRows = (isFull ? diffPanel!.grid.rows : main.rows) + toolbarRows;
  const mainCols = isFull ? 0 : (toolbar ? toolbar.mainCols : main.cols);
  const grid = createGrid(totalCols, totalRows);

  // Divider color
  const dimDivider = 8; // palette color 8 (gray)
  const focusDivider = (0x58 << 16) | (0xa6 << 8) | 0xff; // #58a6ff

  for (let y = 0; y < totalRows; y++) {
    // Copy sidebar cells
    for (let x = 0; x < sidebar.cols && x < sidebar.cells[y]?.length; x++) {
      grid.cells[y][x] = { ...sidebar.cells[y][x] };
    }
    // Sidebar border column
    const borderCol = sidebar.cols;
    grid.cells[y][borderCol] = {
      ...DEFAULT_CELL,
      char: BORDER_CHAR,
      fg: 8,
      fgMode: ColorMode.Palette,
    };

    if (toolbar && y === 0) {
      // Toolbar row — render tabs and buttons as before (existing code)
      // ... (keep existing toolbar rendering code unchanged)

      // After existing toolbar rendering, extend toolbar background
      // across divider + diff panel columns if in split mode
      if (isSplit) {
        const dividerX = borderCol + 1 + mainCols;
        // Fill divider + diff area with toolbar background (spaces)
        for (let x = dividerX; x < totalCols; x++) {
          // Only fill if not already written by button rendering
          if (grid.cells[0][x].char === " " && grid.cells[0][x].bgMode === ColorMode.Default) {
            // Leave as default — toolbar bg is default
          }
        }
      }
    } else if (isFull) {
      // Full mode: copy diff panel cells directly after sidebar border
      const diffY = toolbar ? y - 1 : y;
      if (diffY >= 0 && diffY < diffPanel!.grid.rows) {
        for (let x = 0; x < diffPanel!.grid.cols; x++) {
          grid.cells[y][borderCol + 1 + x] = { ...diffPanel!.grid.cells[diffY][x] };
        }
      }
    } else {
      // Normal or split: copy main content
      const mainY = toolbar ? y - 1 : y;
      if (mainY >= 0 && mainY < main.rows) {
        for (let x = 0; x < main.cols && x < mainCols; x++) {
          grid.cells[y][borderCol + 1 + x] = { ...main.cells[mainY][x] };
        }
      }

      // Split mode: render divider + diff panel
      if (isSplit && diffPanel) {
        const dividerX = borderCol + 1 + mainCols;
        // Divider column
        grid.cells[y][dividerX] = {
          ...DEFAULT_CELL,
          char: BORDER_CHAR,
          fg: diffPanel.focused ? focusDivider : dimDivider,
          fgMode: diffPanel.focused ? ColorMode.RGB : ColorMode.Palette,
        };
        // Diff panel cells
        const diffY = toolbar ? y - 1 : y;
        if (diffY >= 0 && diffY < diffPanel.grid.rows) {
          for (let x = 0; x < diffPanel.grid.cols; x++) {
            grid.cells[y][dividerX + 1 + x] = { ...diffPanel.grid.cells[diffY][x] };
          }
        }
      }
    }
  }

  // Modal overlay (existing code — but update dimming to include diff panel)
  if (modalOverlay) {
    const pos = getModalPosition(totalCols, totalRows, modalOverlay.cols, modalOverlay.rows);

    // Dim all content cells behind the modal (main area + diff panel, not sidebar)
    const mainStart = sidebar.cols + 1;
    for (let y = 0; y < totalRows; y++) {
      for (let x = mainStart; x < totalCols; x++) {
        grid.cells[y][x].dim = true;
      }
    }

    // ... (keep all existing modal border/shadow rendering code unchanged)
  }

  return grid;
}
```

Also update `Renderer.render()` to accept and pass the diffPanel parameter:

```typescript
// At line 351, update render signature:
render(
  main: CellGrid,
  cursor: CursorPosition,
  sidebar: CellGrid | null,
  toolbar?: ToolbarConfig | null,
  modalOverlay?: CellGrid | null,
  modalCursor?: { row: number; col: number } | null,
  diffPanel?: {
    grid: CellGrid;
    mode: "split" | "full";
    focused: boolean;
  },
): void {
  const grid = compositeGrids(main, sidebar, toolbar, modalOverlay, diffPanel);
  // ... rest of render stays the same
```

For cursor positioning when diff panel is focused, add after the existing modal cursor block:

```typescript
if (modalCursor != null) {
  buf.push(`\x1b[${modalCursor.row + 1};${modalCursor.col + 1}H`);
} else if (diffPanel?.focused) {
  // Hide cursor in diff panel (hunk manages its own)
  buf.push("\x1b[?25l");
} else {
  buf.push(
    `\x1b[${cursor.y + cursorRowOffset + 1};${cursor.x + cursorOffset + 1}H`,
  );
}
```

**Important:** The existing toolbar rendering code (lines 158-243) stays intact. The only structural change is the surrounding logic for computing `totalCols`, `mainCols`, the split/full branching in the content loop, and the divider column. Re-read the existing code carefully and integrate — don't rewrite from scratch.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/renderer.test.ts`
Expected: All tests PASS (both old and new)

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/renderer.ts src/__tests__/renderer.test.ts
git commit -m "feat: extend compositeGrids with diff panel support (split/full modes)"
```

---

### Task 3: InputRouter — Diff Panel Routing

**Files:**
- Modify: `src/input-router.ts`
- Modify: `src/__tests__/input-router.test.ts`

- [ ] **Step 1: Write failing tests for diff panel input routing**

Add to `src/__tests__/input-router.test.ts`:

```typescript
describe("diff panel routing", () => {
  test("mouse click in diff panel region calls onDiffPanelClick", () => {
    let clicked = false;
    let clickCol = -1;
    let clickRow = -1;
    const router = new InputRouter(
      {
        sidebarCols: 4,
        onPtyData: () => {},
        onSidebarClick: () => {},
        onDiffPanelClick: (col, row) => { clicked = true; clickCol = col; clickRow = row; },
      },
      true,
    );
    router.setDiffPanel(10, false); // 10 cols, not focused
    // Total layout: sidebar(4) + border(1) + main(?) + divider(1) + diff(10)
    // For this test, mainCols would be derived from totalCols.
    // We need to set mainCols explicitly:
    router.setMainCols(20);
    // Diff panel starts at col 4+1+20+1+1 = 27 (1-indexed mouse coords)
    // Click at x=28 (1-indexed), y=3 → diff panel col 1, row 2
    router.handleInput("\x1b[<0;28;3M");
    expect(clicked).toBe(true);
  });

  test("divider click toggles focus", () => {
    let focusToggled = false;
    const router = new InputRouter(
      {
        sidebarCols: 4,
        onPtyData: () => {},
        onSidebarClick: () => {},
        onDiffPanelFocusToggle: () => { focusToggled = true; },
      },
      true,
    );
    router.setDiffPanel(10, false);
    router.setMainCols(20);
    // Divider is at col 4+1+20+1 = 26 (1-indexed)
    router.handleInput("\x1b[<0;26;3M");
    expect(focusToggled).toBe(true);
  });

  test("keyboard routes to onDiffPanelData when diff panel is focused", () => {
    let diffData = "";
    let ptyData = "";
    const router = new InputRouter(
      {
        sidebarCols: 4,
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
        onDiffPanelData: (d) => { diffData += d; },
      },
      true,
    );
    router.setDiffPanel(10, true); // focused
    router.handleInput("jk");
    expect(diffData).toBe("jk");
    expect(ptyData).toBe("");
  });

  test("keyboard routes to PTY when diff panel exists but is not focused", () => {
    let diffData = "";
    let ptyData = "";
    const router = new InputRouter(
      {
        sidebarCols: 4,
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
        onDiffPanelData: (d) => { diffData += d; },
      },
      true,
    );
    router.setDiffPanel(10, false); // not focused
    router.handleInput("jk");
    expect(ptyData).toBe("jk");
    expect(diffData).toBe("");
  });

  test("Ctrl-a Tab toggles diff panel focus", () => {
    let focusToggled = false;
    const router = new InputRouter(
      {
        sidebarCols: 4,
        onPtyData: () => {},
        onSidebarClick: () => {},
        onDiffPanelFocusToggle: () => { focusToggled = true; },
      },
      true,
    );
    router.setDiffPanel(10, false);
    // Ctrl-a sets prefix
    router.handleInput("\x01");
    // Tab after prefix toggles focus
    router.handleInput("\t");
    expect(focusToggled).toBe(true);
  });

  test("prefix key swallowed when diff panel is focused and key is unrecognized", () => {
    let ptyData = "";
    let diffData = "";
    const router = new InputRouter(
      {
        sidebarCols: 4,
        onPtyData: (d) => { ptyData += d; },
        onSidebarClick: () => {},
        onDiffPanelData: (d) => { diffData += d; },
      },
      true,
    );
    router.setDiffPanel(10, true); // focused
    // Ctrl-a when hunk focused: not forwarded to either PTY
    router.handleInput("\x01");
    expect(ptyData).toBe("");
    expect(diffData).toBe("");
    // Unrecognized post-prefix key: swallowed
    router.handleInput("x");
    expect(ptyData).toBe("");
    expect(diffData).toBe("");
  });

  test("Ctrl-a g still intercepted when diff panel is focused", () => {
    let toggleCalled = false;
    const router = new InputRouter(
      {
        sidebarCols: 4,
        onPtyData: () => {},
        onSidebarClick: () => {},
        onDiffPanelData: () => {},
        onDiffToggle: () => { toggleCalled = true; },
      },
      true,
    );
    router.setDiffPanel(10, true);
    router.handleInput("\x01");
    router.handleInput("g");
    expect(toggleCalled).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test src/__tests__/input-router.test.ts`
Expected: FAIL — new options/methods don't exist yet

- [ ] **Step 3: Implement InputRouter diff panel support**

Update `src/input-router.ts`:

```typescript
export interface InputRouterOptions {
  sidebarCols: number;
  onPtyData: (data: string) => void;
  onSidebarClick: (row: number) => void;
  onSidebarScroll?: (delta: number) => void;
  onToolbarClick?: (col: number) => void;
  onHover?: (target: { area: "sidebar"; row: number } | { area: "toolbar"; col: number } | null) => void;
  onModalInput?: (data: string) => void;
  onModalToggle?: () => void;
  onNewSession?: () => void;
  onSettings?: () => void;
  onSessionPrev?: () => void;
  onSessionNext?: () => void;
  // Diff panel additions
  onDiffPanelClick?: (col: number, row: number) => void;
  onDiffPanelScroll?: (delta: number) => void;
  onDiffPanelData?: (data: string) => void;
  onDiffPanelFocusToggle?: () => void;
  onDiffToggle?: () => void;
}
```

Add state fields to the InputRouter class:

```typescript
private diffPanelCols = 0;
private diffPanelFocused = false;
private mainCols = 0;
```

Add setter methods:

```typescript
setDiffPanel(cols: number, focused: boolean): void {
  this.diffPanelCols = cols;
  this.diffPanelFocused = focused;
}

setMainCols(cols: number): void {
  this.mainCols = cols;
}
```

Update `handleInput()`:

1. After Ctrl-Shift arrow checks (unchanged), in the prefix handling block:
   - Add `"g"` to intercept list → calls `onDiffToggle`
   - Add `"\t"` (Tab) to intercept list → calls `onDiffPanelFocusToggle` (only when diff panel active)
   - When diff panel is focused and `\x01` is received: set `prefixSeen = true` but do NOT forward to PTY
   - When diff panel is focused and post-prefix key is unrecognized: swallow (return, don't forward)

2. In the mouse routing section, before the main area fallthrough:
   - Check if click is in the divider column (`x === sidebarCols + 1 + mainCols + 1` in 1-indexed)
   - Check if click is in the diff panel region (`x > totalCols - diffPanelCols` in 1-indexed)

3. In the keyboard fallthrough (bottom of handleInput):
   - If `diffPanelFocused` and `diffPanelCols > 0`: route to `onDiffPanelData` instead of `onPtyData`

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test src/__tests__/input-router.test.ts`
Expected: All tests PASS (both old and new)

- [ ] **Step 5: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 6: Commit**

```bash
git add src/input-router.ts src/__tests__/input-router.test.ts
git commit -m "feat: add diff panel mouse/keyboard routing to InputRouter"
```

---

### Task 4: Main.ts — Wiring the Diff Panel

**Files:**
- Modify: `src/main.ts`

This is the integration task. No new unit tests — the DiffPanel, renderer, and InputRouter are already tested. This task wires them together in main.ts.

- [ ] **Step 1: Add imports and state variables**

At the top of main.ts (after existing imports around line 10):

```typescript
import { DiffPanel } from "./diff-panel";
```

After the config loading section (around line 164, after `cacheTimersEnabled`):

```typescript
const diffPanelSplitRatio = (userConfig.diffPanel as any)?.splitRatio ?? 0.4;
const hunkCommand = (userConfig.diffPanel as any)?.hunkCommand ?? "hunk";
```

After the core component instantiation (around line 308, after `const control = new TmuxControl()`):

```typescript
const diffPanel = new DiffPanel();
let diffBridge: ScreenBridge | null = null;
let diffPty: import("bun-pty").Terminal | null = null;
let diffPanelFocused = false;
```

- [ ] **Step 2: Add diff panel lifecycle functions**

After the `switchByOffset` function (around line 355):

```typescript
function getDiffPanelCols(): number {
  if (!diffPanel.isActive()) return 0;
  if (diffPanel.state === "full") return mainCols;
  // Split mode
  const available = sidebarShown ? (process.stdout.columns || 80) - sidebarTotal() : (process.stdout.columns || 80);
  return diffPanel.calcPanelCols(available, diffPanelSplitRatio);
}

async function getSessionCwd(): Promise<string | null> {
  if (!currentSessionId) return null;
  try {
    const lines = await control.sendCommand(
      `display-message -t '${currentSessionId}' -p '#{pane_current_path}'`,
    );
    return (lines[0] || "").trim() || null;
  } catch {
    return null;
  }
}

function killDiffProcess(): void {
  if (diffPty) {
    try { diffPty.kill(); } catch {}
    diffPty = null;
  }
  if (diffBridge) {
    diffBridge = null;
  }
  diffPanel.setHunkExited(false);
}

async function spawnHunk(cols: number, rows: number): Promise<void> {
  killDiffProcess();

  const hunkPath = Bun.which(hunkCommand);
  if (!hunkPath) {
    diffPanel.setHunkExited(true);
    scheduleRender();
    return;
  }

  const cwd = await getSessionCwd();
  if (!cwd) {
    diffPanel.setHunkExited(true);
    scheduleRender();
    return;
  }

  const { Terminal } = await import("bun-pty");
  diffBridge = new ScreenBridge(cols, rows);
  diffPty = new Terminal(hunkPath, ["diff"], {
    name: "xterm-256color",
    cols,
    rows,
    env: { ...process.env, TERM: "xterm-256color" },
    cwd,
  });

  diffPty.onData((data: string) => {
    if (!diffBridge) return;
    diffBridge.write(data).then(() => {
      scheduleRender();
    });
  });

  diffPty.onExit(() => {
    diffPanel.setHunkExited(true);
    diffPty = null;
    scheduleRender();
  });
}

function resizeDiffPanel(): void {
  if (!diffPanel.isActive()) return;
  const cols = getDiffPanelCols();
  const rows = toolbarEnabled ? (process.stdout.rows || 24) - 1 : (process.stdout.rows || 24);
  if (diffPty) {
    try { diffPty.resize(cols, rows); } catch {}
  }
  if (diffBridge) {
    diffBridge.resize(cols, rows);
  }
}

async function toggleDiffPanel(): Promise<void> {
  const prevState = diffPanel.state;
  diffPanel.cycle();
  const newState = diffPanel.state;

  if (newState === "off") {
    // Closing from any state
    killDiffProcess();
    diffPanelFocused = false;
    // Resize tmux back to full width
    const fullMainCols = sidebarShown ? (process.stdout.columns || 80) - sidebarTotal() : (process.stdout.columns || 80);
    const ptyR = toolbarEnabled ? (process.stdout.rows || 24) - 1 : (process.stdout.rows || 24);
    mainCols = fullMainCols;
    pty.resize(mainCols, ptyR);
    bridge.resize(mainCols, ptyR);
    inputRouter.setDiffPanel(0, false);
    inputRouter.setMainCols(mainCols);
  } else if (newState === "split" && prevState === "off") {
    // Opening into split
    const panelCols = getDiffPanelCols();
    const fullCols = sidebarShown ? (process.stdout.columns || 80) - sidebarTotal() : (process.stdout.columns || 80);
    mainCols = fullCols - panelCols - 1; // -1 for divider
    const ptyR = toolbarEnabled ? (process.stdout.rows || 24) - 1 : (process.stdout.rows || 24);
    pty.resize(mainCols, ptyR);
    bridge.resize(mainCols, ptyR);
    inputRouter.setDiffPanel(panelCols, diffPanelFocused);
    inputRouter.setMainCols(mainCols);
    await spawnHunk(panelCols, ptyR);
  } else if (newState === "full" && prevState === "split") {
    // Split → full: resize tmux back to full width (invisible reflow)
    const fullMainCols = sidebarShown ? (process.stdout.columns || 80) - sidebarTotal() : (process.stdout.columns || 80);
    const ptyR = toolbarEnabled ? (process.stdout.rows || 24) - 1 : (process.stdout.rows || 24);
    mainCols = fullMainCols;
    pty.resize(mainCols, ptyR);
    bridge.resize(mainCols, ptyR);
    // Resize hunk to full width
    if (diffPty) {
      try { diffPty.resize(fullMainCols, ptyR); } catch {}
    }
    if (diffBridge) {
      diffBridge.resize(fullMainCols, ptyR);
    }
    diffPanelFocused = true;
    inputRouter.setDiffPanel(fullMainCols, true);
    inputRouter.setMainCols(0);
  }

  scheduleRender();
}
```

- [ ] **Step 3: Add Ctrl-a g intercept to InputRouter options**

In the InputRouter constructor call (around line 519), add to the options:

```typescript
onDiffToggle: () => toggleDiffPanel(),
onDiffPanelData: (data) => {
  if (diffPty) {
    diffPty.write(data);
  }
},
onDiffPanelClick: (col, row) => {
  if (diffPty) {
    // Forward translated mouse event to hunk PTY
    const button = 0;
    diffPty.write(`\x1b[<${button};${col};${row}M`);
  }
},
onDiffPanelScroll: (delta) => {
  if (diffPty) {
    const button = delta > 0 ? 65 : 64;
    diffPty.write(`\x1b[<${button};1;1M`);
  }
},
onDiffPanelFocusToggle: () => {
  if (!diffPanel.isActive() || diffPanel.state === "full") return;
  diffPanelFocused = !diffPanelFocused;
  inputRouter.setDiffPanel(getDiffPanelCols(), diffPanelFocused);
  scheduleRender();
},
```

- [ ] **Step 4: Update renderFrame to pass diffPanel to renderer**

Update `renderFrame()` (around line 462):

```typescript
function renderFrame(): void {
  if (writesPending > 0) return;
  const grid = bridge.getGrid();
  const cursor = bridge.getCursor();
  const tb = toolbarEnabled ? makeToolbar() : null;
  let modalGrid: import("./types").CellGrid | null = null;
  let modalCursorPos: { row: number; col: number } | null = null;
  if (activeModal?.isOpen()) {
    const termCols = process.stdout.columns || 80;
    const termRows = process.stdout.rows || 24;
    const modalWidth = activeModal.preferredWidth(termCols);
    modalGrid = activeModal.getGrid(modalWidth);
    const pos = getModalPosition(termCols, termRows, modalWidth, modalGrid.rows);
    const cursorPos = activeModal.getCursorPosition();
    if (cursorPos) {
      modalCursorPos = { row: pos.startRow + cursorPos.row, col: pos.startCol + cursorPos.col };
    }
  }

  // Build diff panel grid
  let diffPanelArg: { grid: import("./types").CellGrid; mode: "split" | "full"; focused: boolean } | undefined;
  if (diffPanel.isActive()) {
    const cols = getDiffPanelCols();
    const rows = toolbarEnabled ? (process.stdout.rows || 24) - 1 : (process.stdout.rows || 24);
    if (diffPanel.hunkExited || !diffBridge) {
      // Show empty panel or not-found message
      const emptyGrid = !Bun.which(hunkCommand)
        ? diffPanel.getNotFoundGrid(cols, rows)
        : diffPanel.getEmptyGrid(cols, rows);
      diffPanelArg = { grid: emptyGrid, mode: diffPanel.state as "split" | "full", focused: diffPanelFocused };
    } else {
      diffPanelArg = { grid: diffBridge.getGrid(), mode: diffPanel.state as "split" | "full", focused: diffPanelFocused };
    }
  }

  renderer.render(
    grid, cursor,
    sidebarShown ? sidebar.getGrid() : null,
    tb,
    modalGrid,
    modalCursorPos,
    diffPanelArg,
  );
}
```

- [ ] **Step 5: Update toolbar button**

In `makeToolbar()` (around line 274), add a diff button:

```typescript
function makeToolbar(): ToolbarConfig {
  const diffActive = diffPanel.isActive();
  const diffFg = diffActive
    ? (0xF0 << 16) | (0x88 << 8) | 0x3E  // #F0883E (orange, highlighted)
    : undefined; // default dim
  return {
    buttons: [
      { label: "＋", id: "new-window" },
      { label: "⏸", id: "split-v" },
      { label: "⏏", id: "split-h" },
      { label: "◈", id: "diff", fg: diffFg, fgMode: diffActive ? 2 : undefined },
      { label: "◈", id: "claude", fg: (0xE8 << 16) | (0xA0 << 8) | 0xB4, fgMode: 2 },
      { label: "⚙", id: "settings" },
    ],
    mainCols,
    hoveredButton: hoveredToolbarButton,
    tabs: currentWindows,
    hoveredTabId,
  };
}
```

Add `"diff"` case in `handleToolbarAction()` (around line 1149):

```typescript
case "diff":
  await toggleDiffPanel();
  return;
```

- [ ] **Step 6: Update SIGWINCH handler**

Update the SIGWINCH handler (around line 1247) to handle diff panel resize:

```typescript
process.on("SIGWINCH", () => {
  if (activeModal) {
    closeModal();
  }
  const newCols = process.stdout.columns || 80;
  const newRows = process.stdout.rows || 24;
  const newSidebarVisible = newCols >= 80;
  const newPtyRows = toolbarEnabled ? newRows - 1 : newRows;

  sidebarShown = newSidebarVisible;
  inputRouter.setSidebarVisible(newSidebarVisible);

  if (diffPanel.isActive() && diffPanel.state === "split") {
    const available = newSidebarVisible ? newCols - sidebarTotal() : newCols;
    const panelCols = diffPanel.calcPanelCols(available, diffPanelSplitRatio);
    mainCols = available - panelCols - 1;
    pty.resize(mainCols, newPtyRows);
    bridge.resize(mainCols, newPtyRows);
    if (diffPty) { try { diffPty.resize(panelCols, newPtyRows); } catch {} }
    if (diffBridge) { diffBridge.resize(panelCols, newPtyRows); }
    inputRouter.setDiffPanel(panelCols, diffPanelFocused);
    inputRouter.setMainCols(mainCols);
  } else if (diffPanel.isActive() && diffPanel.state === "full") {
    const fullCols = newSidebarVisible ? newCols - sidebarTotal() : newCols;
    mainCols = fullCols;
    pty.resize(mainCols, newPtyRows);
    bridge.resize(mainCols, newPtyRows);
    if (diffPty) { try { diffPty.resize(fullCols, newPtyRows); } catch {} }
    if (diffBridge) { diffBridge.resize(fullCols, newPtyRows); }
    inputRouter.setDiffPanel(fullCols, true);
    inputRouter.setMainCols(0);
  } else {
    const newMainCols = newSidebarVisible ? newCols - sidebarTotal() : newCols;
    mainCols = newMainCols;
    pty.resize(newMainCols, newPtyRows);
    bridge.resize(newMainCols, newPtyRows);
  }

  sidebar.resize(sidebarWidth, newRows);
  renderFrame();
});
```

- [ ] **Step 7: Hook into session switching**

In the `client-session-changed` event handler (around line 1411), add diff panel reload:

```typescript
case "client-session-changed":
  resolveClientName().then(async () => {
    sidebar.setActiveSession(currentSessionId ?? "");
    if (startupComplete) {
      await syncControlClient();
      fetchWindows();
      // Reload diff panel for new session
      if (diffPanel.isActive() && !diffPanel.hunkExited) {
        const cols = getDiffPanelCols();
        const rows = toolbarEnabled ? (process.stdout.rows || 24) - 1 : (process.stdout.rows || 24);
        await spawnHunk(cols, rows);
      }
    }
    renderFrame();
  });
  break;
```

- [ ] **Step 8: Update cleanup function**

In `cleanup()` (around line 1655):

```typescript
function cleanup(): void {
  killDiffProcess();
  otelReceiver.stop();
  // ... rest stays the same
```

- [ ] **Step 9: Update help text**

In the HELP string (around line 57), add the diff keybinding:

```
  Ctrl-a g                 Toggle diff panel
  Ctrl-a Tab               Switch focus (tmux ↔ diff)
```

- [ ] **Step 10: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 11: Run all tests**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 12: Commit**

```bash
git add src/main.ts
git commit -m "feat: wire diff panel into main — hotkey, toolbar, session switch, resize"
```

---

### Task 5: Command Palette — Diff Panel Commands

**Files:**
- Modify: `src/main.ts` (buildPaletteCommands and handlePaletteAction)

- [ ] **Step 1: Add palette commands**

In `buildPaletteCommands()` (around line 751, after the existing static commands):

```typescript
// Diff panel commands
commands.push(
  { id: "diff-toggle", label: "Toggle diff panel", category: "diff" },
  { id: "diff-split", label: "Diff: split view", category: "diff" },
  { id: "diff-full", label: "Diff: full screen", category: "diff" },
);
```

- [ ] **Step 2: Add palette action handlers**

In `handlePaletteAction()` (around line 1143, before the closing `}`):

```typescript
case "diff-toggle":
  await toggleDiffPanel();
  return;
case "diff-split":
  if (diffPanel.state !== "split") {
    if (diffPanel.state === "full") {
      // full → off → split
      diffPanel.setState("off");
      killDiffProcess();
    }
    diffPanel.setState("split");
    const panelCols = getDiffPanelCols();
    const fullCols = sidebarShown ? (process.stdout.columns || 80) - sidebarTotal() : (process.stdout.columns || 80);
    mainCols = fullCols - panelCols - 1;
    const ptyR = toolbarEnabled ? (process.stdout.rows || 24) - 1 : (process.stdout.rows || 24);
    pty.resize(mainCols, ptyR);
    bridge.resize(mainCols, ptyR);
    inputRouter.setDiffPanel(panelCols, diffPanelFocused);
    inputRouter.setMainCols(mainCols);
    await spawnHunk(panelCols, ptyR);
  }
  scheduleRender();
  return;
case "diff-full":
  if (diffPanel.state !== "full") {
    const wasSplit = diffPanel.state === "split";
    if (diffPanel.state === "off") {
      // Need to spawn hunk first
      diffPanel.setState("full");
      const fullCols = sidebarShown ? (process.stdout.columns || 80) - sidebarTotal() : (process.stdout.columns || 80);
      const ptyR = toolbarEnabled ? (process.stdout.rows || 24) - 1 : (process.stdout.rows || 24);
      diffPanelFocused = true;
      inputRouter.setDiffPanel(fullCols, true);
      inputRouter.setMainCols(0);
      await spawnHunk(fullCols, ptyR);
    } else {
      // split → full
      diffPanel.setState("full");
      const fullCols = sidebarShown ? (process.stdout.columns || 80) - sidebarTotal() : (process.stdout.columns || 80);
      const ptyR = toolbarEnabled ? (process.stdout.rows || 24) - 1 : (process.stdout.rows || 24);
      mainCols = fullCols;
      pty.resize(mainCols, ptyR);
      bridge.resize(mainCols, ptyR);
      if (diffPty) { try { diffPty.resize(fullCols, ptyR); } catch {} }
      if (diffBridge) { diffBridge.resize(fullCols, ptyR); }
      diffPanelFocused = true;
      inputRouter.setDiffPanel(fullCols, true);
      inputRouter.setMainCols(0);
    }
  }
  scheduleRender();
  return;
```

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 4: Run all tests**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/main.ts
git commit -m "feat: add diff panel commands to command palette"
```

---

### Task 6: Config File Watcher — Hot-Apply Diff Panel Settings

**Files:**
- Modify: `src/main.ts` (config watcher section)

- [ ] **Step 1: Add diff panel config hot-apply**

In the config file watcher (around line 1271, inside the `watch` callback), after the existing `cacheTimersEnabled` check:

```typescript
const newDiffRatio = (updated.diffPanel as any)?.splitRatio ?? 0.4;
const newHunkCmd = (updated.diffPanel as any)?.hunkCommand ?? "hunk";
// Note: hunkCommand changes take effect on next panel open.
// splitRatio changes take effect on next resize/toggle.
```

This is intentionally minimal — ratio changes apply naturally on the next SIGWINCH or toggle. No hot-resize needed.

- [ ] **Step 2: Run all tests**

Run: `bun test`
Expected: All tests pass

- [ ] **Step 3: Run typecheck**

Run: `bun run typecheck`
Expected: No errors

- [ ] **Step 4: Commit**

```bash
git add src/main.ts
git commit -m "feat: support hot-reload of diff panel config settings"
```

---

### Task 7: Manual Smoke Test

This is a manual verification step — no automated tests.

- [ ] **Step 1: Install hunk if not already installed**

Run: `npm i -g hunkdiff`

- [ ] **Step 2: Start jmux from source**

Run: `bun run dev`

- [ ] **Step 3: Verify Ctrl-a g cycles through states**

1. Press `Ctrl-a g` — diff panel should appear on the right in split mode
2. Press `Ctrl-a g` — should expand to full screen (sidebar stays)
3. Press `Ctrl-a g` — should close, back to normal layout

- [ ] **Step 4: Verify focus switching**

1. Open diff panel (`Ctrl-a g`)
2. Click in the diff panel — should get focus (bright divider)
3. Press `j`/`k` — should scroll in hunk
4. Click in tmux area — focus returns to tmux
5. Press `Ctrl-a Tab` — focus toggles back to diff
6. Click the divider — focus toggles

- [ ] **Step 5: Verify session switching reloads diff**

1. Open diff panel
2. Switch sessions with `Ctrl-Shift-Down`
3. Diff panel should show the new session's working tree changes

- [ ] **Step 6: Verify toolbar button works**

1. Click the `◈` diff button in the toolbar
2. Should cycle through off → split → full → off

- [ ] **Step 7: Verify command palette commands**

1. Open palette (`Ctrl-a p`)
2. Type "diff" — should see three commands
3. Select "Diff: full screen" — should jump directly to full mode

- [ ] **Step 8: Verify terminal resize**

1. Open diff panel in split mode
2. Resize the terminal window
3. Both panels should reflow correctly

- [ ] **Step 9: Verify hunk not installed message**

1. Temporarily rename hunk binary or test with `hunkCommand: "nonexistent"` in config
2. Toggle diff panel — should show "hunk not found" message

- [ ] **Step 10: Commit any fixes found during smoke testing**
